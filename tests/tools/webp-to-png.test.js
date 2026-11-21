// WebP to PNG: the image converter set up for this pair. Fixtures:
//   alpha.webp  lossless 64x48 (copy of image-converter's): left half (200,30,60),
//               right half transparent, top-right quarter (20,100,220) at alpha 128
//   anim.webp   40x30 animation, frame 1 red, frame 2 blue
//   photo.webp  scikit-image's "astronaut" sample (NASA, public domain) at
//               200x200, saved by Pillow as lossy WebP at quality 80
//   rotated.webp    lossless (Pillow), stored 120x80: a (220,30,30) band along the
//                   top 20 rows, (235,235,235) elsewhere; EXIF Orientation 6, Make
//                   TestCam, a GPS position -> shown 80x120 with the band on the right.
//                   Chunks VP8X, VP8L (odd length, so a padding byte), EXIF
//   late-exif.webp  40x30 lossless animation (Pillow) with an sRGB profile: chunks
//                   VP8X, ICCP, ANIM, ANMF, ANMF, then EXIF (Make LateCam, a GPS position)
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

module.exports = async ({ page, open, assert, fixtures, base }) => {
  const fx = f => path.join(fixtures, f);
  await open();
  assert.equal(await page.textContent('h1'), 'WebP to PNG Converter, Transparency Kept');

  // ---------- Set up for WebP to PNG as served, and nothing moves as the script starts ----------
  const NOTE = 'PNG is lossless: every pixel is kept exactly, and photos make large files. Transparent areas stay transparent, soft edges included. For a photo without transparency, JPG makes a far smaller file.';
  const HINT = 'WebP images, still or animated, as many as you like. Nothing is uploaded.';
  const START = ['png', '90', '90%', '#ffffff', 'strip', 'true,false,true,false,true,true', NOTE, HINT];
  const controls = () => page.evaluate(async () => {
    const state = doc => {
      const q = s => doc.querySelector(s);
      return [q('#imc-format').value, q('#imc-quality').value, q('#imc-quality-out').textContent, q('#imc-bg').value, q('#imc-meta').value,
        ['#imc-quality-field', '#imc-resize-field', '#imc-bg-field', '#imc-meta-field', '#imc-sizes', '#imc-resize-val'].map(s => q(s).hidden).join(),
        q('#imc-note').textContent, q('#imc-drop .hint').textContent];
    };
    const live = state(document);
    const html = await (await fetch(location.href)).text();
    // The converter's own encoder checks share these cached tests, so its handlers have run once they settle.
    await Promise.all(['webp', 'avif'].map(f => TTImage.canEncode(f, { wasm: true })));
    await new Promise(r => setTimeout(r, 50));
    return { html, served: state(new DOMParser().parseFromString(html, 'text/html')), live, settled: state(document) };
  });
  const load = await controls();
  assert.doesNotMatch(load.html, /\{%|\{\{|include\.|imc_[a-z]|animated_note/, 'Liquid or include notes in the page');
  assert.deepEqual(load.served, START);
  assert.deepEqual(load.live, START, 'the script changed the controls as it started');
  assert.deepEqual(load.settled, START, 'the encoder checks changed the controls');

  // ---------- The guide links to the hub and to WebP to JPG, and every link is a tool page ----------
  // (A run builds only the tools it tests, so the targets are checked in the repository.)
  const links = await page.$$eval('.prose a', as => as.map(a => a.getAttribute('href')));
  assert.ok(links.includes('/image-converter/'), 'guide links to the image converter');
  assert.ok(links.includes('/webp-to-jpg/'), 'guide links to WebP to JPG');
  for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `guide link ${h} is not a tool page`);
  assert.match(await page.textContent('.prose'), /magick animation\.webp -coalesce frame-%03d\.png/);

  // ---------- Convert: transparency, the first frame of an animation, a lossy photo ----------
  const rows = page.locator('.imc-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  await page.setInputFiles('#imc-file', ['alpha.webp', 'anim.webp', 'photo.webp'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '3 of 3 converted.', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 3 images to PNG.');

  assert.match(await rowText(0), /^alpha\.png WebP 64×48, 74 B → PNG 64×48, [\d.]+ K?B \(\d+% larger\)/);
  assert.doesNotMatch(await rowText(0), /filled with|Animated/);
  assert.match(await rowText(1), /^anim\.png WebP 40×30, .* → PNG 40×30, .*Animated image: only the first frame was converted\. To keep every frame, keep the WebP, or open it in GIMP, which loads the frames as layers\./);
  const grow = (await rowText(2)).match(/^photo\.png WebP 200×200, 9\.1 KB → PNG 200×200, ([\d.]+) KB \((\d+)% larger\)/);
  assert.ok(grow, await rowText(2));
  assert.ok(+grow[2] >= 500, `a lossy WebP photo should grow several times as PNG, got ${grow[2]}% larger`);

  // alpha.png: RGBA, every pixel as in the WebP, the half-transparent quarter included.
  let f = await download(0);
  assert.equal(f.name, 'alpha.png');
  let png = decodePng(f.data);
  assert.deepEqual([png.w, png.h, png.type], [64, 48, 6]);
  assert.ok(!png.chunks.includes('eXIf'), 'no EXIF by default');
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 64; x++) {
      const p = png.at(x, y);
      if (x < 32) assert.deepEqual(p, [200, 30, 60, 255], `opaque pixel ${x},${y}`);
      else if (y < 24) {
        assert.equal(p[3], 128, `alpha at ${x},${y}`);
        [20, 100, 220].forEach((v, i) => assert.ok(Math.abs(p[i] - v) <= 2, `half-transparent colour at ${x},${y}: ${p}`));
      } else assert.equal(p[3], 0, `transparent pixel ${x},${y}`);
    }
  }
  // anim.png: the red first frame.
  f = await download(1);
  png = decodePng(f.data);
  assert.deepEqual([png.w, png.h, png.at(20, 15), png.at(0, 0)], [40, 30, [255, 0, 0, 255], [255, 0, 0, 255]]);
  // photo.png: exactly the pixels the browser decodes from the WebP.
  f = await download(2);
  png = decodePng(f.data);
  const ref = await page.evaluate(async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(0, 0, c.width, c.height).data);
  }, fs.readFileSync(fx('photo.webp')).toString('base64'));
  let worst = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) png.at(x, y).forEach((v, i) => { worst = Math.max(worst, Math.abs(v - ref[(y * 200 + x) * 4 + i])); });
  assert.equal(worst, 0, 'PNG pixels differ from the decoded WebP');

  // ---------- EXIF in a WebP: the orientation is applied, and it is kept without the location ----------
  // (The EXIF chunk of a WebP used to be missed: its length was read from the wrong place.)
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', ['rotated.webp', 'late-exif.webp'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 30000 });
  assert.match(await rowText(0), /^rotated\.png WebP 80×120, 240 B → PNG 80×120, .* Rotated upright using the photo’s orientation tag\./);
  png = decodePng((await download(0)).data);
  assert.deepEqual([png.w, png.h, png.exif], [80, 120, null]);
  assert.deepEqual([png.at(75, 60), png.at(60, 119), png.at(10, 60), png.at(40, 2)], [[220, 30, 30, 255], [220, 30, 30, 255], [235, 235, 235, 255], [235, 235, 235, 255]], 'band down the right-hand side');
  await page.evaluate(() => {
    window.__saw = false;
    const el = document.querySelector('#imc-summary');
    window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
    window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.selectOption('#imc-meta', 'nogps');
  await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  for (const [i, name, make, size] of [[0, 'rotated', 'TestCam', [80, 120]], [1, 'late-exif', 'LateCam', [40, 30]]]) {
    assert.match(await rowText(i), /EXIF kept without location\./, name);
    png = decodePng((await download(i)).data);
    assert.ok(png.exif && png.chunks.indexOf('eXIf') < png.chunks.indexOf('IDAT'), `${name}: eXIf chunk before the image data`);
    const tags = exifTags(png.exif);
    assert.deepEqual([png.w, png.h, tags.ifd0[0x010F], tags.gps], [...size, make, null], `${name}: camera kept, GPS removed`);
    assert.ok(!tags.ifd0[0x0112] || tags.ifd0[0x0112] === 1, `${name}: orientation reset, since the pixels are upright`);
  }
  await page.selectOption('#imc-meta', 'strip');

  // ---------- The page's note belongs to PNG only ----------
  await page.selectOption('#imc-format', 'jpeg');
  assert.equal(await page.textContent('#imc-note'), '');
  assert.equal(await page.isVisible('#imc-bg-field'), true);
  await page.selectOption('#imc-format', 'png');
  assert.equal(await page.textContent('#imc-note'), NOTE);

  // ---------- Back button: the controls match whatever the browser restores ----------
  await page.selectOption('#imc-format', 'jpeg');
  await page.selectOption('#imc-resize', 'width');
  await page.fill('#imc-resize-val', '1.920');
  await page.waitForFunction(() => /Read as 1920 pixels\./.test(document.querySelector('#imc-note').textContent));
  await page.goto(base + '/');
  await page.goBack();
  await page.waitForFunction(() => window.TTImage && document.querySelector('#imc-format'));
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    return { f: q('#imc-format').value, mode: q('#imc-resize').value, text: q('#imc-resize-val').value, boxHidden: q('#imc-resize-val').hidden, note: q('#imc-note').textContent, bg: q('#imc-bg-field').hidden, q: q('#imc-quality-field').hidden };
  });
  const want = [back.f === 'png' ? NOTE : '', back.mode === 'width' && back.text === '1.920' ? 'Read as 1920 pixels.' : ''].filter(Boolean).join(' ');
  assert.ok(['png', 'jpeg'].includes(back.f) && ['none', 'width'].includes(back.mode), JSON.stringify(back));
  assert.deepEqual(back, { f: back.f, mode: back.mode, text: back.text, boxHidden: back.mode === 'none', note: want, bg: back.f === 'png', q: back.f === 'png' });

  // Some browsers restore the fields only after the script has run, without
  // change events: the page matches them again when pageshow fires.
  const restored = async (f, mode) => page.evaluate(([f, mode]) => {
    const q = s => document.querySelector(s);
    q('#imc-format').value = f;
    q('#imc-resize').value = mode;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    return [q('#imc-note').textContent, q('#imc-bg-field').hidden, q('#imc-quality-field').hidden, q('#imc-resize-val').hidden];
  }, [f, mode]);
  assert.deepEqual(await restored('png', 'none'), [NOTE, true, true, true]);
  assert.deepEqual(await restored('jpeg', 'none'), ['', false, false, true]);
  assert.deepEqual(await restored('png', 'none'), [NOTE, true, true, true]);
};
