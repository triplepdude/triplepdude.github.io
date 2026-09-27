// SVG to PNG. Expected sizes follow the SVG/CSS sizing rules (96 px per inch,
// 16 px per em, viewBox when width/height are missing or percentages, 300x150
// otherwise); expected colours are the fills written in the fixtures.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function png(b) {
  if (b.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  const chunks = {};
  for (let o = 8; o + 8 <= b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
    chunks[type] = b.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), chunks };
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
  const svg = f => fs.readFileSync(fx(f), 'utf8');
  await open();

  const out = () => page.textContent('#s2p-out');
  // Wait until the preview shows the expected output line.
  const expectOut = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('#s2p-out').textContent), re.source, { timeout: 10000 });
  const setCode = async text => { await page.fill('#s2p-code', text); };
  const download = async (sel = '#s2p-download') => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
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
  const notes = () => page.$$eval('#s2p-notes li', l => l.map(x => x.textContent).join(' | '));

  // ---------- The example on load: 280 x 120 at 2x, transparent corners ----------
  await expectOut(/^Output: 560 × 240 px PNG, /);
  assert.equal(await page.textContent('#s2p-intr'), 'Intrinsic size: 280 × 120 px, from the width and height.');
  assert.equal(await page.isVisible('#s2p-preview'), true);
  assert.equal(await page.isHidden('#s2p-batch'), true);
  assert.equal(await page.getAttribute('[data-scale="2"]', 'aria-pressed'), 'true');
  let f = await download();
  assert.equal(f.name, 'example.png');
  let p = png(f.data);
  assert.deepEqual([p.w, p.h], [560, 240]);
  let px = await pixels(f.data, [[2, 2], [124, 76], [300, 230], [124, 120]]);
  assert.equal(px[0][3], 0, 'rounded corner is transparent');
  near(px[1], [255, 255, 255, 255], 2, 'white circle');
  near(px[3], [31, 111, 74, 255], 2, 'check mark stroke');
  assert.equal(px[2][3], 255, 'inside the card');

  // ---------- viewBox only, scale presets, width, height, both ----------
  await setCode(svg('viewbox-only.svg'));
  await expectOut(/^Output: 48 × 48 px PNG/);
  assert.equal(await page.textContent('#s2p-intr'), 'Intrinsic size: 24 × 24 px, from the viewBox.');
  assert.equal(await page.textContent('#s2p-code-name'), 'drawing.svg');
  await page.click('[data-scale="4"]');
  await expectOut(/^Output: 96 × 96 px PNG/);
  f = await download();
  assert.equal(f.name, 'drawing.png');
  assert.deepEqual([png(f.data).w, png(f.data).h], [96, 96]);
  px = await pixels(f.data, [[10, 48], [86, 48]]);
  near(px[0], [224, 32, 32, 255], 2, 'left half');
  near(px[1], [32, 64, 224, 255], 2, 'right half');

  await page.selectOption('#s2p-mode', 'width');
  await page.fill('#s2p-w', '200');
  await expectOut(/^Output: 200 × 200 px PNG/);
  assert.equal(await page.isHidden('#s2p-h'), true);
  assert.equal(await page.isHidden('#s2p-presets'), true);
  await page.selectOption('#s2p-mode', 'height');
  await page.fill('#s2p-h', '50');
  await expectOut(/^Output: 50 × 50 px PNG/);
  await page.selectOption('#s2p-mode', 'both');
  await page.fill('#s2p-w', '100');
  await page.fill('#s2p-h', '50');
  await expectOut(/^Output: 100 × 50 px PNG/);
  px = await pixels((await download()).data, [[10, 25], [40, 25], [60, 25], [90, 25]]);
  assert.equal(px[0][3], 0, 'drawing is centred: empty on the left');
  near(px[1], [224, 32, 32, 255], 2, 'red half');
  near(px[2], [32, 64, 224, 255], 2, 'blue half');
  assert.equal(px[3][3], 0, 'empty on the right');
  await page.fill('#s2p-w', '0');
  await page.waitForFunction(() => /at least 1 pixel/.test(document.querySelector('#s2p-error').textContent));
  assert.equal(await page.isDisabled('#s2p-download'), true);
  assert.equal(await page.getAttribute('#s2p-error', 'role'), null, 'typing errors are not assertive');

  // ---------- Units and DPI ----------
  await page.selectOption('#s2p-mode', 'dpi');
  await setCode(svg('units-in.svg'));
  await expectOut(/^Output: 600 × 300 px PNG/);
  assert.equal(await page.textContent('#s2p-intr'), 'Intrinsic size: 192 × 96 px, from the width and height.');
  p = png((await download()).data);
  assert.deepEqual([p.w, p.h], [600, 300]);
  assert.deepEqual([p.chunks.pHYs.readUInt32BE(0), p.chunks.pHYs.readUInt32BE(4), p.chunks.pHYs[8]], [11811, 11811, 1], '300 dpi = 11811 px/m');
  await page.selectOption('#s2p-format', 'jpeg');
  await expectOut(/^Output: 600 × 300 px JPG/);
  assert.equal(await page.textContent('#s2p-download'), 'Download JPG');
  assert.equal(await page.isVisible('#s2p-quality-field'), true);
  assert.equal(await page.isDisabled('#s2p-transparent'), true);
  f = await download();
  assert.equal(f.name, 'drawing.jpg');
  assert.equal(f.data.toString('latin1', 6, 11), 'JFIF\0');
  assert.deepEqual([f.data[13], f.data.readUInt16BE(14), f.data.readUInt16BE(16)], [1, 300, 300], 'JFIF density in dots per inch');
  px = await pixels(f.data, [[500, 150], [100, 150]]);
  near(px[0], [255, 255, 255, 255], 4, 'JPG background is white');
  near(px[1], [0, 0, 0, 255], 6, 'black square');
  await page.selectOption('#s2p-format', 'png');
  await page.selectOption('#s2p-mode', 'scale');
  await page.click('[data-scale="1"]');

  // ---------- Background colour ----------
  await setCode(svg('transparent.svg'));
  await expectOut(/^Output: 100 × 100 px PNG/);
  px = await pixels((await download()).data, [[2, 2], [50, 50]]);
  assert.equal(px[0][3], 0);
  near(px[1], [16, 160, 80, 255], 2, 'circle');
  // Same size, so wait for a new preview instead of a new output line.
  const src0 = await page.getAttribute('#s2p-preview', 'src');
  await page.uncheck('#s2p-transparent');
  assert.equal(await page.isEnabled('#s2p-bg'), true);
  await page.locator('#s2p-bg').evaluate(el => { el.value = '#ff0000'; el.dispatchEvent(new Event('change')); });
  await page.waitForFunction(s => { const i = document.querySelector('#s2p-preview'); return i.getAttribute('src') !== s && !i.hidden; }, src0);
  await page.waitForTimeout(400);
  px = await pixels((await download()).data, [[2, 2], [50, 50]]);
  near(px[0], [255, 0, 0, 255], 1, 'filled background');
  near(px[1], [16, 160, 80, 255], 2, 'circle over it');
  await page.check('#s2p-transparent');

  // ---------- Sizing rules and notes ----------
  await setCode(svg('percent.svg'));
  await expectOut(/^Output: 50 × 25 px PNG/);
  assert.match(await notes(), /Width is 100%, a percentage/);
  await setCode(svg('em.svg'));
  await expectOut(/^Output: 160 × 80 px PNG/);
  assert.match(await notes(), /default 16 px font size/);
  await setCode(svg('no-size.svg'));
  await expectOut(/^Output: 300 × 150 px PNG/);
  assert.match(await page.textContent('#s2p-intr'), /from the browser default/);
  await setCode(svg('no-xmlns.svg'));
  await expectOut(/^Output: 40 × 20 px PNG/);
  assert.match(await notes(), /Added the missing xmlns/);
  assert.match(await notes(), /HTML entities/);
  px = await pixels((await download()).data, [[5, 10]]);
  near(px[0], [0, 170, 0, 255], 2, 'no-xmlns SVG renders');
  // External files are listed, never fetched (the runner fails any request to another host).
  await setCode(svg('external.svg'));
  await expectOut(/^Output: 120 × 60 px PNG/);
  assert.match(await notes(), /refers to 3 external files by URL/);
  px = await pixels((await download()).data, [[30, 20], [60, 55]]);
  assert.equal(px[0][3], 0, 'linked image left out: ' + px[0]);
  near(px[1], [170, 0, 0, 255], 2, 'own shapes drawn');
  // Scripts never run.
  await setCode(svg('script.svg'));
  await expectOut(/^Output: 50 × 50 px PNG/);
  assert.match(await notes(), /Scripts and event handlers in the SVG are ignored/);
  assert.equal(await page.evaluate(() => window.__svgPwned), undefined);
  assert.notEqual(await page.title(), 'pwned');
  // Invalid code.
  await setCode(svg('broken.svg'));
  await page.waitForFunction(() => /not valid SVG/.test(document.querySelector('#s2p-error').textContent));
  assert.match(await page.textContent('#s2p-error'), /Opening and ending tag mismatch/);
  assert.equal(await page.isDisabled('#s2p-download'), true);
  assert.equal(await page.isHidden('#s2p-preview'), true);
  await setCode('');
  await expectOut(/^Paste SVG code or open a file/);
  assert.equal(await page.textContent('#s2p-error'), '');
  // Too large.
  await setCode(svg('gradient.svg'));
  await page.fill('#s2p-scale', '64');
  await page.waitForFunction(() => /larger than browsers can draw/.test(document.querySelector('#s2p-error').textContent));
  await page.click('[data-scale="2"]');
  await expectOut(/^Output: 400 × 200 px PNG/);
  px = await pixels((await download()).data, [[2, 100], [200, 100], [397, 100]]);
  near(px[0], [254, 0, 1, 255], 4, 'gradient start');
  near(px[1], [128, 0, 127, 255], 4, 'gradient middle');
  near(px[2], [1, 0, 254, 255], 4, 'gradient end');

  // ---------- Copy to the clipboard ----------
  await page.click('#s2p-copy');
  await page.waitForFunction(() => document.querySelector('#s2p-copy').textContent === 'Copied!');
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType('image/png');
    const b = await createImageBitmap(blob);
    return [b.width, b.height];
  });
  assert.deepEqual(clip, [400, 200]);

  // ---------- Several files, the ZIP ----------
  const gz = zlib.gzipSync(Buffer.from(svg('viewbox-only.svg')));
  const pngFile = fs.readFileSync(path.join(fixtures, '..', 'image-converter', 'alpha.png'));
  const buf = (name, type = 'image/svg+xml') => ({ name, mimeType: type, buffer: fs.readFileSync(fx(name)) });
  await page.setInputFiles('#s2p-file', [
    buf('text.svg'), buf('transparent.svg'),
    { name: 'icon.svgz', mimeType: 'image/svg+xml', buffer: gz },
    { name: 'photo.svg', mimeType: 'image/svg+xml', buffer: pngFile }
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#s2p-list .s2p-item').length === 5 && !/Converting/.test(document.querySelector('#s2p-list').textContent), null, { timeout: 10000 });
  const names = await page.$$eval('#s2p-list .s2p-name', l => l.map(x => x.textContent));
  assert.deepEqual(names, ['drawing.svg', 'text.svg', 'transparent.svg', 'icon.svgz', 'photo.svg'], 'the edited drawing stays, files are added');
  assert.equal(await page.isVisible('#s2p-batch'), true);
  assert.equal(await page.textContent('#s2p-code-name'), 'text.svg');
  assert.equal(await page.inputValue('#s2p-code'), svg('text.svg'));
  await expectOut(/^Output: 480 × 120 px PNG/);
  const rowMeta = await page.$$eval('#s2p-list .s2p-meta', l => l.map(x => x.textContent));
  assert.match(rowMeta[3], /^24 × 24 → 48 × 48 px/);
  assert.match(rowMeta[4], /This is a PNG image, not an SVG/);
  assert.match(await page.textContent('#s2p-summary'), /5 SVG files, 1 with problems/);
  // Select another file: its code is shown for editing.
  await page.click('#s2p-list .s2p-item:nth-child(3) .s2p-name');
  assert.equal(await page.textContent('#s2p-code-name'), 'transparent.svg');
  assert.equal(await page.getAttribute('#s2p-list .s2p-item:nth-child(3) .s2p-name', 'aria-current'), 'true');
  await expectOut(/^Output: 200 × 200 px PNG/);
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#s2p-zip')]);
  assert.equal(zdl.suggestedFilename(), 'svg-to-png.zip');
  const entries = readZip(fs.readFileSync(await zdl.path()));
  assert.deepEqual(entries.map(e => e.name), ['drawing.png', 'text.png', 'transparent.png', 'icon.png']);
  assert.deepEqual(entries.map(e => [png(e.data).w, png(e.data).h]), [[400, 200], [480, 120], [200, 200], [48, 48]]);
  // A file that failed to load: its error shows, and typing new code replaces it.
  await page.click('#s2p-list .s2p-item:nth-child(5) .s2p-name');
  assert.match(await page.textContent('#s2p-error'), /This is a PNG image, not an SVG/);
  assert.equal(await page.isDisabled('#s2p-download'), true);
  await setCode(svg('viewbox-only.svg'));
  await expectOut(/^Output: 48 × 48 px PNG/);
  assert.equal(await page.textContent('#s2p-error'), '');
  assert.match(await page.textContent('#s2p-summary'), /^5 SVG files\. /);
  // Copy a JPG result: the clipboard gets a PNG of it.
  await page.selectOption('#s2p-format', 'jpeg');
  await expectOut(/^Output: 48 × 48 px JPG/);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.click('#s2p-copy');
  await page.waitForFunction(() => document.querySelector('#s2p-copy').textContent === 'Copied!');
  const clip2 = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const b = await createImageBitmap(await items[0].getType('image/png'));
    const c = document.createElement('canvas');
    c.width = b.width; c.height = b.height;
    c.getContext('2d').drawImage(b, 0, 0);
    return [b.width, b.height, Array.from(c.getContext('2d').getImageData(40, 24, 1, 1).data)];
  });
  assert.deepEqual(clip2.slice(0, 2), [48, 48]);
  near(clip2[2], [32, 64, 224, 255], 12, 'copied JPG pixels');
  await page.selectOption('#s2p-format', 'png');
  await expectOut(/^Output: 48 × 48 px PNG/);

  // Remove one, then clear all.
  await page.click('#s2p-list .s2p-item:nth-child(5) [data-act="rm"]');
  assert.equal(await page.$$eval('#s2p-list .s2p-item', l => l.length), 4);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove icon.svgz');
  await page.click('#s2p-clear');
  assert.equal(await page.isHidden('#s2p-batch'), true);
  assert.equal(await page.inputValue('#s2p-code'), '');
  await expectOut(/^Paste SVG code or open a file/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 's2p-code');
};
