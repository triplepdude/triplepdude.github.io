// Image converter: a mixed batch of inputs, every output writer, metadata,
// resizing, ZIP, removing, pasting and dropping. Expected colours and sizes
// come from how the fixtures were made with Pillow (see the fixture list):
//   alpha.png      64x48, left half (200,30,60), right half transparent,
//                  top-right quarter (20,100,220) at alpha 128
//   rotated.jpg    stored 120x80 with a (220,30,30) band along the top and
//                  (235,235,235) elsewhere; EXIF Orientation 6, Make TestCam,
//                  GPS 48°51'29" N  -> shown 80x120 with the band on the right
//   anim.gif       40x30, frame 1 red, frame 2 blue
//   green.bmp      50x30, left (10,200,30), right (250,250,250)
//   icon.ico       16/32/48 px orange circle on transparent
//   orient8.tif    LZW TIFF stored 60x40 with Orientation 8 -> 40x60
//   small.heic     64x48 quadrants; gradient.avif 200x150; alpha.webp = alpha.png
//   broken.png     the first 60 bytes of a PNG; notes.txt is text
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function u16be(b, o) { return b.readUInt16BE(o); }

// Minimal JPEG reader: size from SOF, EXIF block from APP1.
function jpegInfo(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('not a JPEG');
  let i = 2, info = { exif: null };
  while (i < b.length) {
    if (b[i] !== 0xFF) throw new Error('bad marker at ' + i);
    const m = b[i + 1];
    if (m === 0xD9 || m === 0xDA) break;
    const len = u16be(b, i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { info.h = u16be(b, i + 5); info.w = u16be(b, i + 7); }
    if (m === 0xE1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') info.exif = b.subarray(i + 10, i + 2 + len);
    i += 2 + len;
  }
  return info;
}
// Minimal TIFF/EXIF reader: IFD0 tags, and the GPS IFD if linked.
function exifTags(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const r16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), r32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = off => {
    const out = {}, n = r16(off);
    for (let k = 0; k < n; k++) {
      const p = off + 2 + k * 12, tag = r16(p), type = r16(p + 2), count = r32(p + 4);
      if (type === 3) out[tag] = r16(p + 8);
      else if (type === 4) out[tag] = r32(p + 8);
      else if (type === 2) out[tag] = t.toString('latin1', count > 4 ? r32(p + 8) : p + 8, (count > 4 ? r32(p + 8) : p + 8) + count - 1);
      else out[tag] = true;
    }
    return out;
  };
  const ifd0 = ifd(r32(4));
  return { ifd0, gps: ifd0[0x8825] ? ifd(ifd0[0x8825]) : null };
}
function pngInfo(b) {
  assert8(b.subarray(0, 8), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}
function assert8(a, b) { if (!b.every((v, i) => a[i] === v)) throw new Error('bad signature'); }
function readZip(b) {
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no end of central directory');
  const count = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    if (b.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header');
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const raw = b.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== usize) throw new Error('size mismatch in ' + name);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error('CRC mismatch in ' + name);
    out.push({ name, data, method, flags: b.readUInt16LE(p + 8) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// TIFF LZW decoder written from TIFF 6.0 section 13 (MSB-first codes, 9 to 12
// bits, the width grows one code early), independent of the page's encoder.
function tiffLzw(src) {
  const out = [];
  let pos = 0, width = 9, table, prev = null;
  const reset = () => { table = []; for (let i = 0; i < 258; i++) table.push(i < 256 ? [i] : null); width = 9; prev = null; };
  const read = () => { let v = 0; for (let k = 0; k < width; k++, pos++) v = (v << 1) | ((src[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
  reset();
  while (pos + width <= src.length * 8) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); continue; }
    const entry = code < table.length ? table[code] : code === table.length && prev ? prev.concat([prev[0]]) : null;
    if (!entry) throw new Error('bad LZW code ' + code);
    out.push(...entry);
    if (prev) table.push(prev.concat([entry[0]]));
    prev = entry;
    if (table.length + 1 >= (1 << width) && width < 12) width++;
  }
  return Uint8Array.from(out);
}
// Baseline TIFF reader for what the converter writes: one IFD, LZW or none,
// horizontal predictor, contiguous 8-bit samples. Returns tags and RGBA pixels.
function readTiff(b) {
  if (b.toString('latin1', 0, 4) !== 'II*\0') throw new Error('not a little-endian TIFF');
  const ifd = b.readUInt32LE(4), n = b.readUInt16LE(ifd), tags = {};
  const SZ = { 3: 2, 4: 4, 5: 8 };
  for (let k = 0; k < n; k++) {
    const p = ifd + 2 + 12 * k, tag = b.readUInt16LE(p), type = b.readUInt16LE(p + 2), count = b.readUInt32LE(p + 4);
    const at = SZ[type] * count > 4 ? b.readUInt32LE(p + 8) : p + 8;
    tags[tag] = Array.from({ length: count }, (_, j) => type === 3 ? b.readUInt16LE(at + 2 * j) : type === 4 ? b.readUInt32LE(at + 4 * j) : b.readUInt32LE(at + 8 * j) / b.readUInt32LE(at + 8 * j + 4));
  }
  const w = tags[256][0], h = tags[257][0], spp = tags[277][0], rps = tags[278][0], row = w * spp;
  const px = Buffer.alloc(w * h * 4);
  tags[273].forEach((off, s) => {
    let raw = b.subarray(off, off + tags[279][s]);
    if (tags[259][0] === 5) raw = tiffLzw(raw);
    for (let y = 0; y < Math.min(rps, h - s * rps); y++) {
      const r = Uint8Array.from(raw.subarray(y * row, (y + 1) * row));
      if (tags[317] && tags[317][0] === 2) for (let i = spp; i < row; i++) r[i] = (r[i] + r[i - spp]) & 255;
      for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) px[4 * ((s * rps + y) * w + x) + c] = c < spp ? r[x * spp + c] : 255;
    }
  });
  return { tags, w, h, px: (x, y) => [...px.subarray(4 * (y * w + x), 4 * (y * w + x) + 4)] };
}

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await open();

  const summary = () => page.textContent('#imc-summary');
  const rows = page.locator('.imc-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  // Run an action that changes settings and wait until the list is converted again.
  const rerun = async action => {
    await page.evaluate(() => {
      window.__saw = false;
      const el = document.querySelector('#imc-summary');
      if (window.__mo) window.__mo.disconnect();
      window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
      window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    await action();
    await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  };
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  // Decode bytes with the browser's own decoder and read pixels.
  const pixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, [buf.toString('base64'), pts]);
  const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

  // AVIF output is offered: Chromium's canvas cannot encode AVIF, so the page
  // uses the WebAssembly encoder, which is not downloaded until it is needed.
  await page.waitForFunction(() => document.querySelector('#imc-format option[value="avif"]').textContent === 'AVIF');
  assert.equal(await page.locator('#imc-format option[value="avif"]').isDisabled(), false);
  assert.equal(requests.filter(u => /avif_enc/.test(u)).length, 0, 'AVIF encoder loads lazily');
  // Other tools ask canEncode('avif') without { wasm: true }: that still means the canvas itself.
  const nativeAvif = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const b = await new Promise(r => c.toBlob(r, 'image/avif'));
    return !!b && b.type === 'image/avif';
  });
  assert.equal(await page.evaluate(() => TTImage.canEncode('avif')), nativeAvif);
  assert.equal(await page.evaluate(() => TTImage.canEncode('avif', { wasm: true })), true);
  assert.deepEqual(await page.evaluate(() => Promise.all(['tiff', 'gif', 'image/tiff'].map(f => TTImage.canEncode(f)))), [true, true, true]);
  assert.equal(await summary(), 'No images added yet.');
  assert.equal(requests.filter(u => /libheif|UTIF|pako/.test(u)).length, 0, 'decoders must load lazily');

  // ---------- A mixed batch to JPG (the default) ----------
  const inputs = ['alpha.png', 'rotated.jpg', 'anim.gif', 'green.bmp', 'icon.ico', 'orient8.tif', 'alpha.webp', 'gradient.avif', 'small.heic', 'broken.png', 'notes.txt'];
  await page.setInputFiles('#imc-file', inputs.map(fx));
  await page.waitForFunction(() => /^9 of 11 converted, 2 failed\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 30000 });
  assert.ok(requests.some(u => /libheif\.wasm$/.test(u)) && requests.some(u => /UTIF\.min\.js$/.test(u)), 'HEIC and TIFF decoders load once needed');

  assert.match(await rowText(0), /alpha\.jpg PNG 64×48, .* → JPG 64×48, .*Transparent areas were filled with white\./);
  assert.match(await rowText(1), /JPG 80×120, .* → JPG 80×120, .*Rotated upright/);
  assert.match(await rowText(2), /GIF 40×30.*only the first frame was converted/);
  assert.match(await rowText(3), /BMP 50×30/);
  assert.match(await rowText(4), /ICO 48×48/);
  assert.match(await rowText(5), /TIFF 40×60/);
  assert.match(await rowText(6), /WebP 64×48/);
  assert.match(await rowText(7), /AVIF 200×150/);
  assert.match(await rowText(8), /HEIC 64×48/);
  assert.match(await rowText(9), /broken\.png .*The PNG file is incomplete/);
  assert.match(await rowText(10), /notes\.txt .*not a supported image/);
  assert.equal(await rows.nth(9).locator('[data-act="dl"]').isHidden(), true);
  await page.waitForFunction(() => /Converted 9 images to JPG\. 2 could not be converted\./.test(document.querySelector('#imc-status').textContent));

  // rotated.jpg: upright 80x120, red band on the right, EXIF removed by default.
  let f = await download(1);
  assert.equal(f.name, 'rotated.jpg');
  let j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.exif], [80, 120, null]);
  let px = await pixels(f.data, [[75, 60], [10, 60]]);
  near(px[0], [220, 30, 30, 255], 14, 'band on the right');
  near(px[1], [235, 235, 235, 255], 8, 'background');

  // alpha.png to JPG: transparent area white, half-transparent blue blended with white.
  f = await download(0);
  px = await pixels(f.data, [[10, 40], [50, 40], [50, 10]]);
  near(px[0], [200, 30, 60, 255], 10, 'opaque red');
  near(px[1], [255, 255, 255, 255], 6, 'transparent -> white');
  near(px[2], [137, 177, 237, 255], 10, 'alpha 128 blue over white');

  // TIFF orientation 8 (rotate 90° counter-clockwise): the stored top band ends up on the left.
  f = await download(5);
  px = await pixels(f.data, [[3, 30], [36, 30]]);
  near(px[0], [20, 40, 200, 255], 14, 'TIFF band on the left');
  near(px[1], [240, 240, 240, 255], 8, 'TIFF background');
  // GIF: the first (red) frame.
  px = await pixels((await download(2)).data, [[20, 15]]);
  near(px[0], [255, 0, 0, 255], 8, 'first GIF frame');

  // ---------- Metadata ----------
  await rerun(() => page.selectOption('#imc-meta', 'keep'));
  j = jpegInfo((await download(1)).data);
  let ex = exifTags(j.exif);
  assert.equal(ex.ifd0[0x0112], 1, 'orientation reset to 1');
  assert.equal(ex.ifd0[0x010F], 'TestCam');
  assert.equal(ex.gps && ex.gps[1], 'N', 'GPS kept');
  assert.match(await rowText(1), /EXIF kept, including any location/);
  await rerun(() => page.selectOption('#imc-meta', 'nogps'));
  ex = exifTags(jpegInfo((await download(1)).data).exif);
  assert.equal(ex.ifd0[0x010F], 'TestCam');
  assert.equal(ex.gps, null, 'GPS removed');
  assert.equal(ex.ifd0[0x0112], 1);
  await rerun(() => page.selectOption('#imc-meta', 'strip'));
  assert.equal(jpegInfo((await download(1)).data).exif, null);

  // ---------- Background colour ----------
  await rerun(() => page.locator('#imc-bg').evaluate(el => { el.value = '#00ff00'; el.dispatchEvent(new Event('change')); }));
  px = await pixels((await download(0)).data, [[50, 40]]);
  near(px[0], [0, 255, 0, 255], 8, 'transparent -> chosen green');
  await rerun(() => page.locator('#imc-bg').evaluate(el => { el.value = '#ffffff'; el.dispatchEvent(new Event('change')); }));

  // ---------- Quality changes the size ----------
  const size = async i => (await download(i)).data.length;
  await rerun(() => page.locator('#imc-quality').evaluate(el => { el.value = '20'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }));
  const low = await size(7);
  await rerun(() => page.locator('#imc-quality').evaluate(el => { el.value = '98'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }));
  assert.ok(await size(7) > low * 1.5, 'higher quality, bigger file');
  assert.equal(await page.textContent('#imc-quality-out'), '98%');

  // ---------- Resize: longest side 50 px ----------
  await rerun(() => page.selectOption('#imc-resize', 'max'));
  assert.equal(await page.inputValue('#imc-resize-val'), '1920');
  await rerun(() => page.fill('#imc-resize-val', '50'));
  j = jpegInfo((await download(1)).data);
  assert.deepEqual([j.w, j.h], [33, 50]);
  j = jpegInfo((await download(2)).data);
  assert.deepEqual([j.w, j.h], [40, 30], 'smaller images are not enlarged');
  await rerun(() => page.selectOption('#imc-resize', 'percent'));
  await rerun(() => page.fill('#imc-resize-val', '200'));
  j = jpegInfo((await download(3)).data);
  assert.deepEqual([j.w, j.h], [100, 60]);
  assert.match(await rowText(3), /Enlarged beyond the original size/);
  await rerun(() => page.selectOption('#imc-resize', 'none'));

  // ---------- PNG output and the ZIP ----------
  await rerun(() => page.selectOption('#imc-format', 'png'));
  assert.equal(await page.locator('#imc-quality-field').isHidden(), true);
  assert.equal(await page.locator('#imc-bg-field').isHidden(), true);
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#imc-zip')]);
  assert.equal(zdl.suggestedFilename(), 'converted-images-png.zip');
  const entries = readZip(fs.readFileSync(await zdl.path()));
  assert.deepEqual(entries.map(e => e.name), ['alpha.png', 'rotated.png', 'anim.png', 'green.png', 'icon.png', 'orient8.png', 'alpha (2).png', 'gradient.png', 'small.png']);
  entries.forEach(e => { assert.equal(e.flags & 0x800, 0x800, 'UTF-8 flag'); pngInfo(e.data); });
  const alphaPng = pngInfo(entries[0].data);
  assert.deepEqual([alphaPng.w, alphaPng.h, alphaPng.colorType], [64, 48, 6]);
  px = await pixels(entries[0].data, [[50, 40], [50, 10], [10, 10]]);
  assert.equal(px[0][3], 0, 'PNG keeps transparency');
  near(px[1], [20, 100, 220, 128], 3, 'PNG keeps partial transparency');
  near(px[2], [200, 30, 60, 255], 1, 'PNG is lossless');
  px = await pixels(entries[8].data, [[16, 12], [48, 12], [16, 36], [48, 36]]);
  near(px[0], [220, 40, 40, 255], 12, 'HEIC quadrant 1');
  near(px[1], [40, 180, 60, 255], 12, 'HEIC quadrant 2');
  near(px[2], [40, 60, 200, 255], 12, 'HEIC quadrant 3');
  near(px[3], [240, 240, 240, 255], 12, 'HEIC quadrant 4');

  // ---------- BMP: 24-bit, bottom-up rows ----------
  await rerun(() => page.selectOption('#imc-format', 'bmp'));
  f = await download(3);
  assert.equal(f.name, 'green.bmp');
  const b = f.data;
  assert.equal(b.toString('latin1', 0, 2), 'BM');
  assert.equal(b.readUInt32LE(2), b.length);
  assert.deepEqual([b.readInt32LE(18), b.readInt32LE(22), b.readUInt16LE(28), b.readUInt32LE(30)], [50, 30, 24, 0]);
  const rowSize = Math.ceil(50 * 3 / 4) * 4, top = b.readUInt32LE(10) + 29 * rowSize; // first image row is stored last
  assert.deepEqual([...b.subarray(top, top + 3)], [30, 200, 10], 'top-left pixel, BGR');
  assert.deepEqual([...b.subarray(top + 49 * 3, top + 50 * 3)], [250, 250, 250], 'top-right pixel');

  // ---------- TIFF: LZW with the horizontal predictor, alpha when needed ----------
  await rerun(() => page.selectOption('#imc-format', 'tiff'));
  assert.equal(await page.locator('#imc-quality-field').isHidden(), true);
  f = await download(0);
  assert.equal(f.name, 'alpha.tif');
  let tif = readTiff(f.data);
  assert.deepEqual([tif.w, tif.h, tif.tags[259][0], tif.tags[277][0], tif.tags[317][0], tif.tags[338][0], tif.tags[282][0]], [64, 48, 5, 4, 2, 2, 72]);
  near(tif.px(10, 40), [200, 30, 60, 255], 0, 'TIFF is lossless');
  assert.equal(tif.px(50, 40)[3], 0, 'TIFF transparent pixel');
  near(tif.px(50, 10), [20, 100, 220, 128], 1, 'TIFF unassociated alpha');
  tif = readTiff((await download(3)).data);
  assert.deepEqual([tif.w, tif.h, tif.tags[277][0], tif.tags[338]], [50, 30, 3, undefined], 'opaque image: RGB, no alpha');
  near(tif.px(0, 0), [10, 200, 30, 255], 0, 'TIFF top-left');
  near(tif.px(49, 29), [250, 250, 250, 255], 0, 'TIFF bottom-right');

  // ---------- GIF: exact colours when there are 256 or fewer, on/off transparency ----------
  await rerun(() => page.selectOption('#imc-format', 'gif'));
  assert.match(await page.textContent('#imc-note'), /at most 256 colours/);
  f = await download(0);
  assert.equal(f.name, 'alpha.gif');
  assert.equal(f.data.toString('latin1', 0, 6), 'GIF89a');
  assert.deepEqual([f.data.readUInt16LE(6), f.data.readUInt16LE(8)], [64, 48]);
  px = await pixels(f.data, [[10, 40], [50, 40], [50, 10]]);
  near(px[0], [200, 30, 60, 255], 0, 'GIF keeps few colours exactly');
  assert.equal(px[1][3], 0, 'GIF transparent pixel');
  near(px[2], [20, 100, 220, 255], 1, 'half-opaque pixel becomes opaque (canvas alpha rounding: 1)');
  px = await pixels((await download(3)).data, [[5, 5], [45, 5]]);
  near(px[0], [10, 200, 30, 255], 0, 'GIF green');
  near(px[1], [250, 250, 250, 255], 0, 'GIF white');

  // ---------- ICO: several PNG-coded sizes ----------
  await rerun(() => page.selectOption('#imc-format', 'ico'));
  assert.equal(await page.locator('#imc-sizes').isVisible(), true);
  await rerun(() => page.locator('#imc-sizes input[value="24"]').check());
  f = await download(0);
  assert.equal(f.name, 'alpha.ico');
  const ico = f.data;
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 5]);
  const sizes = [];
  for (let k = 0; k < 5; k++) {
    const p = 6 + 16 * k, w = ico[p] || 256, len = ico.readUInt32LE(p + 8), off = ico.readUInt32LE(p + 12);
    const png = pngInfo(ico.subarray(off, off + len));
    assert.deepEqual([png.w, png.h], [w, w]);
    assert.equal(ico.readUInt16LE(p + 6), 32);
    sizes.push(w);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 256]);
  assert.match(await rowText(0), /Centred on a transparent square/);
  // The 48 px icon: 64x48 fitted to 48x36, centred vertically, transparent bands above and below.
  const e48 = 6 + 16 * 3, png48 = ico.subarray(ico.readUInt32LE(e48 + 12), ico.readUInt32LE(e48 + 12) + ico.readUInt32LE(e48 + 8));
  px = await pixels(png48, [[5, 2], [5, 24], [40, 45]]);
  assert.equal(px[0][3], 0, 'padding above');
  near(px[1], [200, 30, 60, 255], 12, 'icon content');
  assert.equal(px[2][3], 0, 'padding below');

  // ---------- WebP ----------
  await rerun(() => page.selectOption('#imc-format', 'webp'));
  f = await download(6);
  assert.equal(f.name, 'alpha.webp');
  assert.equal(f.data.toString('latin1', 0, 4) + f.data.toString('latin1', 8, 12), 'RIFFWEBP');
  px = await pixels(f.data, [[50, 40], [10, 10]]);
  assert.equal(px[0][3], 0, 'WebP keeps transparency');
  near(px[1], [200, 30, 60, 255], 12, 'WebP colour');

  // ---------- AVIF (libavif in WebAssembly), checked with the browser's own AV1 decoder ----------
  await rerun(() => page.selectOption('#imc-format', 'avif'));
  assert.ok(requests.some(u => /\/assets\/vendor\/avif\/avif_enc\.wasm$/.test(u)), 'AVIF encoder loaded when chosen');
  assert.match(await page.textContent('#imc-note'), /libavif/);
  f = await download(0);
  assert.equal(f.name, 'alpha.avif');
  assert.equal(f.data.toString('latin1', 4, 12), 'ftypavif', 'AVIF brand');
  const ispe = f.data.indexOf('ispe');
  assert.deepEqual([f.data.readUInt32BE(ispe + 8), f.data.readUInt32BE(ispe + 12)], [64, 48], 'ispe size');
  px = await pixels(f.data, [[10, 40], [50, 40], [50, 10]]);
  near(px[0], [200, 30, 60, 255], 12, 'AVIF colour');
  assert.equal(px[1][3], 0, 'AVIF keeps transparency');
  near(px[1 + 1], [20, 100, 220, 128], 14, 'AVIF partial transparency');
  px = await pixels((await download(1)).data, [[75, 60], [10, 60]]);
  near(px[0], [220, 30, 30, 255], 14, 'AVIF rotated band on the right');
  near(px[1], [235, 235, 235, 255], 8, 'AVIF background');
  await rerun(() => page.selectOption('#imc-format', 'webp'));

  // ---------- Remove, paste, drop, clear ----------
  await rows.nth(10).locator('[data-act="rm"]').click();
  assert.equal(await rows.count(), 10);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove broken.png');
  await page.evaluate(async () => {
    const bytes = await (await fetch(document.querySelector('#imc-list img').src)).arrayBuffer();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    const dt2 = new DataTransfer();
    dt2.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    document.querySelector('#imc-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => /^11 of 12 converted, 1 failed\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 15000 });
  assert.match(await rowText(10), /pasted\.webp PNG/);
  assert.match(await rowText(11), /dropped\.webp PNG/);
  await page.click('#imc-clear');
  assert.equal(await rows.count(), 0);
  assert.equal(await summary(), 'No images added yet.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'imc-choose');

  // ---------- Hostile and unusual files ----------
  //   comments.txt   27 XML comments then <html>: the SVG sniffer once backtracked
  //                  exponentially on this and froze the page for 18 s
  //   cycle.tif      4x4 red TIFF whose page chain points back to itself (crashed the tab)
  //   count.tif      4x4 green TIFF with a tag claiming 2^31 values (hung the worker)
  //   trailing.png   60x40 valid PNG, left (10,120,200) right (240,200,40), bytes after IEND
  //   cut-big.png    160x120 PNG with one big IDAT, cut at 60%; top 20 rows (200,40,90)
  //   exif-loop.jpg  EXIF Orientation 6, Make LoopCam, IFD0 linking to itself as IFD1
  //   foreign.svg    100x50 (0,170,0) rect plus HTML in a <foreignObject>
  await page.selectOption('#imc-format', 'jpeg');
  await page.selectOption('#imc-meta', 'keep');
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(e.duration))).observe({ type: 'longtask' });
  });
  const t0 = Date.now();
  await page.setInputFiles('#imc-file', ['comments.txt', 'cycle.tif', 'count.tif', 'trailing.png', 'cut-big.png', 'exif-loop.jpg', 'foreign.svg'].map(fx));
  await page.waitForFunction(() => /^6 of 7 converted, 1 failed\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 30000 });
  assert.ok(Date.now() - t0 < 10000, `hostile batch took ${Date.now() - t0} ms`);
  const longH = await page.evaluate(() => window.__long);
  assert.ok(longH.every(d => d < 200), `main thread blocked: ${longH.map(Math.round)} ms`);
  assert.match(await rowText(0), /comments\.txt .*not a supported image/);
  assert.match(await rowText(1), /cycle\.jpg TIFF 4×4/);
  assert.match(await rowText(2), /count\.jpg TIFF 4×4/);
  assert.match(await rowText(3), /trailing\.jpg PNG 60×40/);
  assert.doesNotMatch(await rowText(3), /cut off/, 'bytes after IEND are not a truncated file');
  assert.match(await rowText(4), /cut-big\.jpg PNG 160×120.*cut off/);
  assert.match(await rowText(6), /foreign\.jpg SVG 100×50.*foreignObject/);
  near((await pixels((await download(1)).data, [[2, 2]]))[0], [255, 0, 0, 255], 8, 'cyclic TIFF decoded');
  near((await pixels((await download(2)).data, [[2, 2]]))[0], [0, 255, 0, 255], 8, 'TIFF with a bad tag decoded');
  px = await pixels((await download(3)).data, [[10, 20], [50, 20]]);
  near(px[0], [10, 120, 200, 255], 10, 'trailing.png left');
  near(px[1], [240, 200, 40, 255], 10, 'trailing.png right');
  near((await pixels((await download(4)).data, [[80, 10]]))[0], [200, 40, 90, 255], 10, 'rows before the cut');
  f = await download(5);
  j = jpegInfo(f.data);
  ex = exifTags(j.exif);
  assert.deepEqual([j.w, j.h, ex.ifd0[0x0112], ex.ifd0[0x010F]], [40, 60, 1, 'LoopCam'], 'EXIF kept although IFD1 points at IFD0');
  near((await pixels((await download(6)).data, [[50, 40]]))[0], [0, 170, 0, 255], 6, 'SVG drawn without its HTML');

  // An SVG is drawn again at the icon size: a sharp edge at 256 px, not a 24 px picture enlarged.
  await page.click('#imc-clear');
  await page.selectOption('#imc-format', 'ico');
  await page.setInputFiles('#imc-file', fx('half.svg'));
  await page.waitForFunction(() => /^1 of 1 converted\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 15000 });
  assert.match(await rowText(0), /rendered at the largest icon size/);
  const vi = (await download(0)).data, n = vi.readUInt16LE(4), e256 = 6 + 16 * (n - 1);
  assert.equal(vi[e256], 0, 'last entry is the 256 px icon');
  px = await pixels(vi.subarray(vi.readUInt32LE(e256 + 12), vi.readUInt32LE(e256 + 12) + vi.readUInt32LE(e256 + 8)), [[126, 128], [127, 128], [129, 128]]);
  near(px[0], [224, 0, 0, 255], 2, 'inside the edge');
  near(px[1], [224, 0, 0, 255], 2, 'last column of the red half');
  assert.equal(px[2][3], 0, 'first column past the edge is transparent');

  // A setting changed while files are still decoding: each file is decoded
  // once, not once per setting (the second decode used to leak the first).
  await page.click('#imc-clear');
  await page.selectOption('#imc-format', 'jpeg');
  await page.evaluate(() => {
    const orig = TTImage.decode;
    window.__decodes = 0;
    TTImage.decode = async function () {
      window.__decodes++;
      const r = await orig.apply(this, arguments);
      await new Promise(res => setTimeout(res, 700));
      return r;
    };
  });
  await page.setInputFiles('#imc-file', [fx('alpha.png'), fx('green.bmp')]);
  await page.waitForTimeout(100);
  await page.selectOption('#imc-format', 'png');
  await page.waitForFunction(() => /^2 of 2 converted\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__decodes), 2, 'decoded once each');
  assert.deepEqual([(await download(0)).name, (await download(1)).name], ['alpha.png', 'green.png']);

  // Deflate-compressed RGBA TIFF (alpha-deflate.tif = alpha.png as a TIFF): PNG keeps its alpha.
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', fx('alpha-deflate.tif'));
  await page.waitForFunction(() => /^1 of 1 converted\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 15000 });
  assert.match(await rowText(0), /alpha-deflate\.png TIFF 64×48/);
  px = await pixels((await download(0)).data, [[10, 10], [50, 10], [50, 40]]);
  near(px[0], [200, 30, 60, 255], 1, 'TIFF opaque red');
  near(px[1], [20, 100, 220, 128], 3, 'TIFF half-transparent blue');
  assert.equal(px[2][3], 0, 'TIFF transparent quarter');

  // A browser that cannot encode WebP (Safari): the option is disabled and explained.
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { return toBlob.call(this, cb, type === 'image/webp' ? 'image/png' : type, q); };
  });
  await open();
  await page.waitForFunction(() => document.querySelector('#imc-format option[value="webp"]').disabled);
  assert.equal(await page.textContent('#imc-format option[value="webp"]'), 'WebP (this browser cannot save it)');
};
