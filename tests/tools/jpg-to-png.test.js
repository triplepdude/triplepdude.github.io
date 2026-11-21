// JPG to PNG: the image converter set up for this pair. Fixtures:
//   rotated.jpg  copy of image-converter's: stored 120x80 with a (220,30,30) band
//                along the top and (235,235,235) elsewhere; EXIF Orientation 6,
//                Make TestCam, GPS position -> shown 80x120 with the band on the right
//   photo.jpg    scikit-image's "astronaut" sample (NASA, public domain) at
//                200x200, saved by Pillow as JPG at quality 90
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG reader for what browsers write: 8-bit RGB or RGBA, not interlaced.
function decodePng(b) {
  if (b.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  let o = 8, w, h, depth, type, interlace, exif = null;
  const idat = [], chunks = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    chunks.push(t);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    if (t === 'IDAT') idat.push(d);
    if (t === 'eXIf') exif = d;
    o += 12 + len;
  }
  const ch = { 2: 3, 6: 4 }[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`unexpected PNG layout ${depth}/${type}/${interlace}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0, up = y ? px[(y - 1) * stride + x] : 0, c = y && x >= ch ? px[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const at = (x, y) => { const i = y * stride + x * ch; return ch === 4 ? [...px.subarray(i, i + 4)] : [...px.subarray(i, i + 3), 255]; };
  return { w, h, type, chunks, exif, at };
}
// TIFF/EXIF reader: IFD0 tags, and the GPS IFD if linked.
function exifTags(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const r16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), r32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = off => {
    const out = {};
    for (let k = 0, n = r16(off); k < n; k++) {
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

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  await open();
  assert.equal(await page.textContent('h1'), 'JPG to PNG Converter for JPEG Photos');

  // ---------- Set up for JPG to PNG as served, and nothing moves as the script starts ----------
  const NOTE = 'PNG is lossless: every pixel is kept exactly, and photos make large files. Converting cannot restore detail that the JPG compression has already removed.';
  const HINT = 'JPG or JPEG photos, as many as you like. Nothing is uploaded.';
  const START = ['png', '90', '90%', '#ffffff', 'strip', 'true,false,true,false,true,true', NOTE, HINT];
  const load = await page.evaluate(async () => {
    const state = doc => {
      const q = s => doc.querySelector(s);
      return [q('#imc-format').value, q('#imc-quality').value, q('#imc-quality-out').textContent, q('#imc-bg').value, q('#imc-meta').value,
        ['#imc-quality-field', '#imc-resize-field', '#imc-bg-field', '#imc-meta-field', '#imc-sizes', '#imc-resize-val'].map(s => q(s).hidden).join(),
        q('#imc-note').textContent, q('#imc-drop .hint').textContent];
    };
    const live = state(document);
    const html = await (await fetch(location.href)).text();
    await Promise.all(['webp', 'avif'].map(f => TTImage.canEncode(f, { wasm: true })));
    await new Promise(r => setTimeout(r, 50));
    return { html, served: state(new DOMParser().parseFromString(html, 'text/html')), live, settled: state(document) };
  });
  assert.doesNotMatch(load.html, /\{%|\{\{|include\.|imc_[a-z]|animated_note/, 'Liquid or include notes in the page');
  assert.deepEqual(load.served, START);
  assert.deepEqual(load.live, START, 'the script changed the controls as it started');
  assert.deepEqual(load.settled, START, 'the encoder checks changed the controls');

  // ---------- The guide links to the hub and to PNG to JPG, all real tool pages ----------
  const links = await page.$$eval('.prose a', as => as.map(a => a.getAttribute('href')));
  for (const h of ['/image-converter/', '/png-to-jpg/']) assert.ok(links.includes(h), `guide links to ${h}`);
  for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `guide link ${h} is not a tool page`);

  const rows = page.locator('.imc-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

  // ---------- Convert: a rotated phone photo with EXIF, and a plain photo ----------
  await page.setInputFiles('#imc-file', ['rotated.jpg', 'photo.jpg'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 2 images to PNG.');
  assert.match(await rowText(0), /^rotated\.png JPG 80×120, 1\.3 KB → PNG 80×120, [\d.]+ K?B \(\d+% (larger|smaller)\) Rotated upright using the photo’s orientation tag\./);
  const grow = (await rowText(1)).match(/^photo\.png JPG 200×200, 16 KB → PNG 200×200, (\d+) KB \((\d+)% larger\)/);
  assert.ok(grow, 'the growth is shown: ' + await rowText(1));
  assert.ok(+grow[2] >= 200, `a photo should grow several times as PNG, got ${grow[2]}% larger`);

  // rotated.png: upright, the band on the right, no EXIF by default.
  let f = await download(0);
  assert.equal(f.name, 'rotated.png');
  let png = decodePng(f.data);
  assert.deepEqual([png.w, png.h, png.exif], [80, 120, null]);
  near(png.at(75, 60), [220, 30, 30, 255], 14, 'band on the right');
  near(png.at(10, 60), [235, 235, 235, 255], 8, 'background');
  near(png.at(40, 2), [235, 235, 235, 255], 8, 'top is not the band');

  // photo.png: exactly the pixels the browser decodes from the JPG, all opaque.
  png = decodePng((await download(1)).data);
  const ref = await page.evaluate(async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(0, 0, c.width, c.height).data);
  }, fs.readFileSync(fx('photo.jpg')).toString('base64'));
  let worst = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) png.at(x, y).forEach((v, i) => { worst = Math.max(worst, Math.abs(v - ref[(y * 200 + x) * 4 + i])); });
  assert.equal(worst, 0, 'PNG pixels differ from the decoded JPG');
  assert.deepEqual(png.at(0, 0)[3], 255);

  // ---------- Keep the camera details without the location: an eXIf chunk ----------
  await page.evaluate(() => {
    window.__saw = false;
    const el = document.querySelector('#imc-summary');
    window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
    window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.selectOption('#imc-meta', 'nogps');
  await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  assert.match(await rowText(0), /EXIF kept without location\./);
  assert.match(await rowText(1), /The original had no EXIF data to keep\./);
  png = decodePng((await download(0)).data);
  assert.ok(png.exif && png.chunks.indexOf('eXIf') < png.chunks.indexOf('IDAT'), 'eXIf chunk before the image data');
  const tags = exifTags(png.exif);
  assert.equal(tags.ifd0[0x010F], 'TestCam');
  assert.equal(tags.gps, null, 'no GPS block');
  assert.ok(!tags.ifd0[0x0112] || tags.ifd0[0x0112] === 1, 'orientation reset, since the pixels are upright');
  assert.deepEqual([png.w, png.h], [80, 120]);

  // ---------- Narrow phones: the size menu's longest choice is never cut off ----------
  await page.selectOption('#imc-resize', 'max');
  await page.waitForFunction(() => /^2 of 2 converted\.$/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  for (const width of [320, 340, 360, 390, 414]) {
    await page.setViewportSize({ width, height: 800 });
    const fit = await page.evaluate(() => {
      const el = document.querySelector('#imc-resize'), cs = getComputedStyle(el), c = document.createElement('canvas').getContext('2d');
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const box = document.querySelector('#imc-resize-val');
      return { need: c.measureText(el.options[el.selectedIndex].text).width, room: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), boxFits: box.scrollWidth <= box.clientWidth };
    });
    assert.ok(fit.need <= fit.room + 0.5 && fit.boxFits, `at ${width}px "Longest side (px)" needs ${fit.need.toFixed(1)}px, has ${fit.room.toFixed(1)}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
};
