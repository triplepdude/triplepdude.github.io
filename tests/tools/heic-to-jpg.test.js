// HEIC to JPG. The fixtures were made with pillow-heif (libheif + x265), and the
// expected colours are the values they were encoded with:
//   quadrants.heic    240x160: (220,40,40) (40,180,60) / (40,60,200) (240,240,240)
//   portrait-gps.heic stored 300x200 with a (230,30,30) band along the top, grey
//                     (200,200,200) elsewhere, an irot box (display 200x300, band on
//                     the right) and EXIF: Orientation 6, Make TestCam, Model
//                     "Model X1", DateTimeOriginal 2024:05:06 07:08:09, GPS 51°30' N 0°7'30" W
//   burst.heic        three images; the primary (second) is 200x100 (30,170,60)
//   display-p3.heic   Display P3 ICC profile; P3 (230,50,40) and (128,128,128). Little CMS
//                     (Pillow ImageCms, relative colorimetric) gives sRGB (251,0,16) and (128,128,128)
//   alpha.heic        120x80, left half transparent, right half (30,90,200)
//   grid.heic         200x150 in 64 px tiles: R 0..255 left to right, G 90, B 255..0 top to
//                     bottom, a (250,250,20) block in the bottom-right 10x10 corner
//   photo-12mp.heic   4032x3024 in 512 px tiles, like an iPhone photo: a (240,200,40) disc
//                     around (2000,1500), a (20,20,20) block from (3800,2800), EXIF Make Apple
//   truncated.heic    the first 60% of quadrants.heic; notes.heic is a text file
//   hdr-pq.heic       quadrants.heic with the nclx transfer characteristics set to 16 (PQ)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function jpegInfo(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('not a JPEG');
  let i = 2;
  const info = { exif: null };
  while (i < b.length) {
    if (b[i] !== 0xFF) throw new Error('bad marker at ' + i);
    const m = b[i + 1];
    if (m === 0xD9 || m === 0xDA) break;
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { info.h = b.readUInt16BE(i + 5); info.w = b.readUInt16BE(i + 7); }
    if (m === 0xE1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') info.exif = b.subarray(i + 10, i + 2 + len);
    i += 2 + len;
  }
  return info;
}
function exifTags(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const r16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), r32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (r16(2) !== 42) throw new Error('not TIFF');
  const ifd = off => {
    const out = {}, n = r16(off);
    for (let k = 0; k < n; k++) {
      const p = off + 2 + k * 12, tag = r16(p), type = r16(p + 2), count = r32(p + 4);
      const at = count * ([0, 1, 1, 2, 4, 8][type] || 1) > 4 ? r32(p + 8) : p + 8;
      if (type === 3) out[tag] = r16(p + 8);
      else if (type === 4) out[tag] = r32(p + 8);
      else if (type === 2) out[tag] = t.toString('latin1', at, at + count - 1);
      else if (type === 5) out[tag] = Array.from({ length: count }, (_, j) => r32(at + 8 * j) / r32(at + 8 * j + 4));
      else out[tag] = true;
    }
    return out;
  };
  const ifd0 = ifd(r32(4));
  return { ifd0, exif: ifd0[0x8769] ? ifd(ifd0[0x8769]) : {}, gps: ifd0[0x8825] ? ifd(ifd0[0x8825]) : null };
}
function pngChunks(b) {
  const out = {};
  for (let o = 8; o + 8 <= b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
    out[type] = b.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  return out;
}
function riffChunks(b) {
  const out = {};
  for (let o = 12; o + 8 <= b.length;) {
    const type = b.toString('latin1', o, o + 4), len = b.readUInt32LE(o + 4);
    out[type] = b.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  return out;
}
function readZip(b) {
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  const out = [];
  let p = b.readUInt32LE(e + 16);
  for (let k = 0; k < b.readUInt16LE(e + 10); k++) {
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), off = b.readUInt32LE(p + 42), name = b.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const data = method === 8 ? zlib.inflateRawSync(b.subarray(start, start + csize)) : b.subarray(start, start + csize);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error('CRC mismatch in ' + name);
    out.push({ name, data });
    p += 46 + nlen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return out;
}

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await open();
  const rows = page.locator('.h2j-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  const rerun = async action => {
    await page.evaluate(() => {
      window.__saw = false;
      const el = document.querySelector('#h2j-summary');
      if (window.__mo) window.__mo.disconnect();
      window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
      window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    await action();
    await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#h2j-summary').textContent), null, { timeout: 30000 });
  };
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  const pixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, [buf.toString('base64'), pts]);
  const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

  assert.match(await page.getAttribute('#h2j-file', 'accept'), /\.heic.*\.heif/);
  assert.equal(await page.textContent('#h2j-summary'), 'No photos added yet.');
  assert.match(await page.textContent('#h2j-note'), /GPS location is removed/);
  // The 1.4 MB decoder is only fetched once a HEIC file is added.
  assert.equal(requests.filter(u => /libheif/.test(u)).length, 0);

  // Watch for main-thread long tasks while a 12-megapixel tiled photo converts.
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(e.duration))).observe({ type: 'longtask' });
  });
  const inputs = ['quadrants.heic', 'portrait-gps.heic', 'burst.heic', 'display-p3.heic', 'alpha.heic', 'grid.heic', 'photo-12mp.heic', 'truncated.heic', 'notes.heic'];
  await page.setInputFiles('#h2j-file', inputs.map(fx));
  await page.waitForFunction(() => /^7 of 9 converted, 2 failed\.$/.test(document.querySelector('#h2j-summary').textContent), null, { timeout: 60000 });
  assert.ok(requests.some(u => /\/assets\/vendor\/libheif\/libheif\.wasm$/.test(u)), 'decoder loaded');
  assert.ok(requests.some(u => /\/assets\/vendor\/libheif\/libheif\.js$/.test(u)), 'decoder glue loaded');
  const long = await page.evaluate(() => window.__long);
  assert.ok(long.every(d => d < 150), `main thread blocked: ${long.map(Math.round)} ms`);
  await page.waitForFunction(() => document.querySelector('#h2j-status').textContent === 'Converted 7 photos to JPG. 2 could not be converted.');

  assert.match(await rowText(0), /quadrants\.jpg 240 × 160 px · 1\.3 KB → JPG/);
  assert.match(await rowText(1), /portrait-gps\.jpg 200 × 300 px/);
  assert.match(await rowText(2), /burst\.jpg 200 × 100 px .*This file holds 3 images; the primary image was converted\./);
  assert.match(await rowText(3), /Colours converted from Display P3/);
  assert.match(await rowText(4), /Transparent areas were filled with white/);
  assert.match(await rowText(5), /grid\.jpg 200 × 150 px/);
  assert.match(await rowText(6), /photo-12mp\.jpg 4032 × 3024 px/);
  assert.match(await rowText(7), /truncated\.heic .*The HEIC file is incomplete/);
  assert.match(await rowText(8), /notes\.heic .*not a HEIC photo or another image/);
  assert.equal(await rows.nth(7).locator('[data-act="dl"]').isHidden(), true);

  let f = await download(0);
  assert.equal(f.name, 'quadrants.jpg');
  let j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.exif], [240, 160, null], 'size, and no EXIF by default');
  let px = await pixels(f.data, [[60, 40], [180, 40], [60, 120], [180, 120]]);
  near(px[0], [220, 40, 40, 255], 12, 'top-left');
  near(px[1], [40, 180, 60, 255], 12, 'top-right');
  near(px[2], [40, 60, 200, 255], 12, 'bottom-left');
  near(px[3], [240, 240, 240, 255], 12, 'bottom-right');

  // Rotation from the irot box: the stored top band is now on the right.
  f = await download(1);
  j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.exif], [200, 300, null]);
  px = await pixels(f.data, [[190, 150], [60, 150], [100, 20]]);
  near(px[0], [230, 30, 30, 255], 14, 'band on the right');
  near(px[1], [200, 200, 200, 255], 8, 'grey');
  near(px[2], [200, 200, 200, 255], 8, 'grey at the top');

  px = await pixels((await download(2)).data, [[100, 50]]);
  near(px[0], [30, 170, 60, 255], 10, 'primary image of three');
  px = await pixels((await download(3)).data, [[32, 32], [96, 32]]);
  near(px[0], [251, 0, 16, 255], 6, 'P3 red in sRGB');
  near(px[1], [128, 128, 128, 255], 4, 'P3 grey');
  px = await pixels((await download(4)).data, [[20, 40], [100, 40]]);
  near(px[0], [255, 255, 255, 255], 4, 'transparent -> white');
  near(px[1], [30, 90, 200, 255], 12, 'opaque half');
  px = await pixels((await download(5)).data, [[195, 145], [1, 1], [198, 1]]);
  near(px[0], [250, 250, 20, 255], 16, 'grid corner block');
  near(px[1], [1, 90, 253, 255], 16, 'grid top-left');
  near(px[2], [254, 90, 253, 255], 16, 'grid top-right');
  f = await download(6);
  j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h], [4032, 3024]);
  px = await pixels(f.data, [[2000, 1500], [3950, 2950], [10, 10]]);
  near(px[0], [240, 200, 40, 255], 14, '12 MP disc');
  near(px[1], [20, 20, 20, 255], 14, '12 MP corner block');
  near(px[2], [59, 90, 199, 255], 14, '12 MP corner');

  // ---------- Metadata ----------
  await rerun(() => page.selectOption('#h2j-meta', 'keep'));
  assert.match(await page.textContent('#h2j-note'), /including the GPS location/);
  j = jpegInfo((await download(1)).data);
  let ex = exifTags(j.exif);
  assert.equal(ex.ifd0[0x0112], 1, 'orientation written as normal');
  assert.equal(ex.ifd0[0x010F], 'TestCam');
  assert.equal(ex.ifd0[0x0110], 'Model X1');
  assert.equal(ex.exif[0x9003], '2024:05:06 07:08:09');
  assert.equal(ex.gps[1], 'N');
  assert.equal(ex.gps[3], 'W');
  assert.deepEqual(ex.gps[2], [51, 30, 0]);
  assert.match(await rowText(1), /EXIF kept, including any location/);
  assert.match(await rowText(0), /The photo had no EXIF data to keep/);
  assert.equal(exifTags(jpegInfo((await download(6)).data).exif).ifd0[0x010F], 'Apple');

  await rerun(() => page.selectOption('#h2j-meta', 'nogps'));
  ex = exifTags(jpegInfo((await download(1)).data).exif);
  assert.equal(ex.gps, null, 'no GPS');
  assert.equal(ex.ifd0[0x010F], 'TestCam');
  assert.equal(ex.exif[0x9003], '2024:05:06 07:08:09');
  assert.equal(ex.ifd0[0x0112], 1);

  // PNG keeps EXIF in an eXIf chunk, and transparency.
  await rerun(() => page.selectOption('#h2j-format', 'png'));
  assert.equal(await page.locator('#h2j-quality-field').isHidden(), true);
  f = await download(1);
  assert.equal(f.name, 'portrait-gps.png');
  const chunks = pngChunks(f.data);
  assert.equal(f.data.readUInt32BE(16), 200);
  ex = exifTags(chunks.eXIf);
  assert.deepEqual([ex.ifd0[0x0112], ex.ifd0[0x010F], ex.gps], [1, 'TestCam', null]);
  px = await pixels((await download(4)).data, [[20, 40], [100, 40]]);
  assert.equal(px[0][3], 0, 'PNG keeps transparency');
  near(px[1], [30, 90, 200, 255], 12, 'PNG opaque half');

  // WebP: EXIF chunk with the VP8X flag.
  await rerun(() => page.selectOption('#h2j-format', 'webp'));
  f = await download(1);
  assert.equal(f.name, 'portrait-gps.webp');
  const riff = riffChunks(f.data);
  assert.ok(riff.VP8X && (riff.VP8X[0] & 0x08), 'VP8X EXIF flag');
  ex = exifTags(riff.EXIF);
  assert.deepEqual([ex.ifd0[0x0112], ex.ifd0[0x010F], ex.gps], [1, 'TestCam', null]);

  // ---------- Quality and size ----------
  await rerun(() => page.selectOption('#h2j-format', 'jpeg'));
  await rerun(() => page.selectOption('#h2j-meta', 'strip'));
  await rerun(() => page.locator('#h2j-quality').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }));
  const low = (await download(5)).data.length;
  await rerun(() => page.locator('#h2j-quality').evaluate(el => { el.value = '95'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }));
  assert.ok((await download(5)).data.length > low * 1.3, 'quality raises the size');
  await rerun(() => page.selectOption('#h2j-resize', 'max'));
  await rerun(() => page.fill('#h2j-resize-val', '100'));
  j = jpegInfo((await download(1)).data);
  assert.deepEqual([j.w, j.h], [67, 100]);
  j = jpegInfo((await download(6)).data);
  assert.deepEqual([j.w, j.h], [100, 75]);
  assert.match(await rowText(6), /photo-12mp\.jpg 100 × 75 px/);
  await rerun(() => page.selectOption('#h2j-resize', 'none'));

  // ---------- ZIP ----------
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#h2j-zip')]);
  assert.equal(zdl.suggestedFilename(), 'heic-to-jpg.zip');
  const entries = readZip(fs.readFileSync(await zdl.path()));
  assert.deepEqual(entries.map(e => e.name), ['quadrants.jpg', 'portrait-gps.jpg', 'burst.jpg', 'display-p3.jpg', 'alpha.jpg', 'grid.jpg', 'photo-12mp.jpg']);
  entries.forEach(e => assert.equal(e.data.readUInt16BE(0), 0xFFD8));
  assert.deepEqual([jpegInfo(entries[6].data).w, jpegInfo(entries[6].data).h], [4032, 3024]);

  // ---------- Remove and clear ----------
  await rows.nth(8).locator('[data-act="rm"]').click();
  assert.equal(await rows.count(), 8);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove truncated.heic');
  await page.click('#h2j-clear');
  assert.equal(await rows.count(), 0);
  assert.equal(await page.textContent('#h2j-summary'), 'No photos added yet.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h2j-choose');

  // A file added after clearing converts with the decoder already loaded.
  const before = requests.filter(u => /libheif\.wasm$/.test(u)).length;
  await page.setInputFiles('#h2j-file', [fx('quadrants.heic')]);
  await page.waitForFunction(() => /^1 of 1 converted\.$/.test(document.querySelector('#h2j-summary').textContent), null, { timeout: 15000 });
  assert.ok(requests.filter(u => /libheif\.wasm$/.test(u)).length <= before + 1);

  // hdr-pq.heic is quadrants.heic with its nclx transfer set to 16 (PQ, HDR):
  // converted as before, with a note that no tone mapping was done.
  await page.setInputFiles('#h2j-file', [fx('hdr-pq.heic')]);
  await page.waitForFunction(() => /^2 of 2 converted\.$/.test(document.querySelector('#h2j-summary').textContent), null, { timeout: 15000 });
  assert.match(await rowText(1), /hdr-pq\.jpg 240 × 160 px .*This is an HDR photo/);
  assert.doesNotMatch(await rowText(0), /HDR/);

  // A setting changed while photos are still decoding: each photo is decoded
  // once, not once per setting (the second decode used to leak the first).
  await page.click('#h2j-clear');
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
  await page.setInputFiles('#h2j-file', [fx('quadrants.heic'), fx('burst.heic')]);
  await page.waitForTimeout(100);
  await page.selectOption('#h2j-format', 'png');
  await page.waitForFunction(() => /^2 of 2 converted\.$/.test(document.querySelector('#h2j-summary').textContent), null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__decodes), 2, 'decoded once each');
  assert.deepEqual([(await download(0)).name, (await download(1)).name], ['quadrants.png', 'burst.png']);

  // A browser that cannot encode WebP (Safari): the option is disabled and explained.
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { return toBlob.call(this, cb, type === 'image/webp' ? 'image/png' : type, q); };
  });
  await open();
  await page.waitForFunction(() => document.querySelector('#h2j-format option[value="webp"]').disabled);
  assert.equal(await page.textContent('#h2j-format option[value="webp"]'), 'WebP (this browser cannot save it)');
};
