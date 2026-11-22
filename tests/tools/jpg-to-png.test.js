// JPG to PNG: the image converter set up for this pair. Fixtures:
//   rotated.jpg  copy of image-converter's: stored 120x80 with a (220,30,30) band
//                along the top and (235,235,235) elsewhere; EXIF Orientation 6,
//                Make TestCam, GPS position -> shown 80x120 with the band on the right
//   photo.jpg    scikit-image's "astronaut" sample (NASA, public domain) at
//                200x200, saved by Pillow as JPG at quality 90
//   cut.jpg      a 120x90 JPG (Pillow, quality 90: top half (40,90,200), bottom half
//                (230,180,40)) that stops 40% of the way into its image data
//   motion.jpg   the same JPG complete, followed by an MP4 (ftyp and mdat boxes), as
//                a motion photo stores its clip after the end-of-image marker
//   padded.jpg   the same JPG complete, followed by 6000 zero bytes
//   early.jpg    the same JPG stopped 12 bytes into its image data: Chrome draws none of it
//   p3.jpg       64x64 JPG (Pillow) tagged with tests/fixtures/image-to-pdf/p3.icc (Display P3):
//                left half stored as (200,100,50), right half (0,255,1). In sRGB that is about
//                (215,93,31), and the P3 green lies outside sRGB, so it clips to (0,255,0)
//   meta.jpg     copy of remove-exif-data's gps-rotated.jpg: EXIF with Make Canon, Artist and
//                Copyright "Jane Example", BodySerialNumber 012345678901, OffsetTimeOriginal
//                +02:00 and a GPS position, plus XMP, IPTC, a comment and an sRGB profile
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
// TIFF/EXIF reader: IFD0 tags, and the EXIF and GPS IFDs if linked.
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
  return { ifd0, exif: ifd0[0x8769] ? ifd(ifd0[0x8769]) : {}, gps: ifd0[0x8825] ? ifd(ifd0[0x8825]) : null };
}

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  await open();
  assert.equal(await page.textContent('h1'), 'JPG to PNG Converter for JPEG Photos');

  // ---------- Set up for JPG to PNG as served, and nothing moves as the script starts ----------
  const NOTE = 'PNG is lossless: the decoded pixels are saved without further loss, and photos make large files. Converting cannot restore detail that the JPG compression has already removed.';
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
  for (const h of ['/image-converter/', '/png-to-jpg/', '/resize-image/']) assert.ok(links.includes(h), `guide links to ${h}`);
  // The FAQ answers what the guide does not: how to convert with the apps built into Windows and macOS.
  assert.deepEqual(await page.$$eval('.faq summary', s => s.map(e => e.textContent.trim())), [
    'Does converting JPG to PNG improve image quality?',
    'How do I convert JPG to PNG on Windows or a Mac without a website?',
    'My JPG has a white background. Will the PNG be transparent?',
    'Is a .jpeg file different from a .jpg file?']);
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

  // ---------- A cut-off JPG is reported; data after the end-of-image marker is not a cut ----------
  // (Browsers draw a cut-off JPG with its lower part blank and no error.)
  await page.click('#imc-clear');
  await page.selectOption('#imc-resize', 'none');
  await page.setInputFiles('#imc-file', ['cut.jpg', 'motion.jpg', 'padded.jpg', 'early.jpg'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '3 of 4 converted, 1 failed.', null, { timeout: 30000 });
  // Cut before anything could be drawn: refused, not saved as a blank PNG.
  assert.equal(await rowText(3), 'early.jpg 635 B The JPG file is incomplete: it ends early, and this browser could not draw any of the picture. Download or copy it again. ×');
  assert.match(await rowText(0), /^cut\.png JPG 120×90, 1\.0 KB → PNG 120×90, .*The file seems to be cut off, so part of the picture may be blank\./);
  near(decodePng((await download(0)).data).at(60, 10), [40, 90, 200, 255], 8, 'cut.jpg: the part before the cut');
  for (const i of [1, 2]) {
    assert.match(await rowText(i), /^(motion|padded)\.png JPG 120×90, [\d.]+ KB → PNG 120×90, /);
    assert.doesNotMatch(await rowText(i), /cut off/, 'data after the end-of-image marker is not a cut');
    png = decodePng((await download(i)).data);
    near(png.at(60, 10), [40, 90, 200, 255], 8, 'top half');
    near(png.at(60, 80), [230, 180, 40, 255], 8, 'bottom half');
  }

  // ---------- What the page promises matches what happens to colour profiles and EXIF ----------
  const guide = (await page.textContent('.prose')).replace(/\s+/g, ' ');
  const desc = await page.getAttribute('meta[name="description"]', 'content');
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', ['p3.jpg', 'meta.jpg'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 30000 });
  // A Display P3 JPG (as iPhones save them) comes out in sRGB with no profile, so vivid colours
  // are toned down: the page must not promise an exact copy of the pixels, and says what happens.
  png = decodePng((await download(0)).data);
  assert.ok(!png.chunks.includes('iCCP') && !png.chunks.includes('sRGB'), 'no colour profile in the PNG: ' + png.chunks);
  near(png.at(10, 32), [215, 93, 31, 255], 4, 'P3 (200,100,50) converted to sRGB');
  near(png.at(50, 32), [0, 255, 0, 255], 2, 'P3 green clipped to the sRGB gamut');
  assert.doesNotMatch(desc, /exact|identical|perfect/i, 'the description promises exact pixels: ' + desc);
  assert.match(guide, /A JPG with a wide colour profile, such as the Display P3 of iPhone photos, is converted to sRGB, which tones down colours more vivid than sRGB can show\./);
  const faq = (await page.textContent('.faq')).replace(/\s+/g, ' ');
  assert.doesNotMatch(faq + guide, /perfect copy|looks identical|copied exactly/, 'a claim of an exact copy is left');
  // Keep, without location removes only the GPS block: the photographer's name, the copyright
  // notice, the camera serial number and the time zone stay, as the guide says.
  png = decodePng((await download(1)).data);
  const t = exifTags(png.exif);
  assert.equal(t.gps, null, 'no GPS block');
  assert.deepEqual([t.ifd0[0x010F], t.ifd0[0x013B], t.ifd0[0x8298]], ['Canon', 'Jane Example', '(c) Jane Example']);
  assert.deepEqual([t.exif[0xA431], t.exif[0x9011]], ['012345678901', '+02:00']);
  assert.match(guide, /Choose Keep, without location to copy the EXIF data without the GPS position: camera and lens, exposure, date and time zone, and the photographer[’']s name, copyright notice and camera serial number if the photo has them\./);
  // XMP, IPTC and the comment are never copied, and the PNG carries no colour profile.
  assert.deepEqual(png.chunks.filter(c => !['IHDR', 'eXIf', 'IDAT', 'IEND'].includes(c)), [], 'only the EXIF is carried over');
};
