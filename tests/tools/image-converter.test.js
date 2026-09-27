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

  // AVIF output is offered exactly when this browser can encode it.
  const avif = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const b = await new Promise(r => c.toBlob(r, 'image/avif'));
    return !!b && b.type === 'image/avif';
  });
  assert.equal(await page.locator('#imc-format option[value="avif"]').isDisabled(), !avif);
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
};
