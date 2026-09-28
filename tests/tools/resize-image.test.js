const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Reads the pixel size and container type straight from the file bytes.
function imageInfo(b) {
  if (b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    assert_(b.subarray(12, 16).toString('latin1') === 'IHDR', 'PNG IHDR first');
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
        return { type: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { type: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.subarray(4, 12).toString('latin1') === 'ftypavif') {
    // HEIF image spatial extents ('ispe'): version/flags, then width and height (ISO/IEC 23008-12).
    const at = b.indexOf('ispe', 0, 'latin1');
    assert_(at > 0, 'AVIF ispe box');
    return { type: 'avif', width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
  }
  if (b[0] === 0x42 && b[1] === 0x4d) {
    // BITMAPINFOHEADER: width at 18, height at 22 (positive: rows stored bottom-up), bits per pixel at 28.
    return { type: 'bmp', width: b.readInt32LE(18), height: b.readInt32LE(22), bpp: b.readUInt16LE(28), offset: b.readUInt32LE(10) };
  }
  if (b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
    // ICONDIR, then one 16-byte ICONDIRENTRY per image (0 means 256).
    const n = b.readUInt16LE(4), entries = [];
    for (let i = 0; i < n; i++) {
      const e = 6 + 16 * i, size = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
      entries.push({ width: b[e] || 256, height: b[e + 1] || 256, bpp: b.readUInt16LE(e + 6), data: b.subarray(off, off + size) });
    }
    return { type: 'ico', width: entries[entries.length - 1].width, height: entries[entries.length - 1].height, entries };
  }
  if (b.subarray(0, 6).toString('latin1') === 'GIF89a' || b.subarray(0, 6).toString('latin1') === 'GIF87a') {
    // Logical screen descriptor (GIF89a spec, section 18).
    return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.subarray(0, 4).toString('hex') === '49492a00' || b.subarray(0, 4).toString('hex') === '4d4d002a') {
    // TIFF 6.0: first IFD, tags 256 (ImageWidth) and 257 (ImageLength), SHORT or LONG.
    const le = b[0] === 0x49, u16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), u32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
    const ifd = u32(4), n = u16(ifd), tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i, type = u16(e + 2);
      tags[u16(e)] = type === 3 ? u16(e + 8) : u32(e + 8);
    }
    return { type: 'tiff', width: tags[256], height: tags[257], compression: tags[259] };
  }
  throw new Error('unknown image format: ' + b.subarray(0, 16).toString('hex'));
}

// Reads a ZIP from its central directory (APPNOTE 4.3.12), checking every entry's CRC-32 and size.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert_(eocd >= 0, 'ZIP end of central directory');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    assert_(buf.readUInt32LE(p) === 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert_(buf.readUInt32LE(local) === 0x04034b50, 'local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert_(data.length === usize && zlib.crc32(data) === crc, `${name}: size and CRC-32`);
    out.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
function assert_(ok, msg) { if (!ok) throw new Error(msg); }

module.exports = async ({ page, open, assert, fixtures, url }) => {
  await open();
  const fx = f => path.join(fixtures, f);
  const text = s => page.textContent(s);
  // Waits until the debounced render has produced a result of the given size.
  const waitDims = async dims => {
    await page.waitForFunction(d => document.querySelector('#ri-dims').textContent === d && !document.querySelector('#ri-download').disabled, dims);
  };
  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ri-download')]);
    const buf = fs.readFileSync(await dl.path());
    return { name: dl.suggestedFilename(), buf, info: imageInfo(buf) };
  };
  // Decodes a file with the browser's own decoder and returns RGBA at the given points.
  const pixels = (buf, points) => page.evaluate(async ([b64, pts]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  }, [buf.toString('base64'), points]);
  // The same through TTImage, for formats the browser cannot decode itself (TIFF).
  const ttPixels = (buf, points) => page.evaluate(async ([b64, pts]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const res = await TTImage.decode(new Blob([bytes]));
    const ctx = res.canvas.getContext('2d', { willReadFrequently: true });
    const out = pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
    TTImage.release(res);
    return out;
  }, [buf.toString('base64'), points]);
  const close = (actual, expected, tol, msg) =>
    expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) <= tol, `${msg}: got [${actual}] expected ~[${expected}]`));

  assert.equal(await page.isDisabled('#ri-download'), true);
  assert.equal(await page.isVisible('#ri-placeholder'), true);

  // Not an image: friendly error, nothing loaded.
  await page.setInputFiles('#ri-file', fx('notes.txt'));
  await page.waitForFunction(() => document.querySelector('#ri-error').textContent.includes('notes.txt'));
  assert.equal(await page.isDisabled('#ri-download'), true);

  // 400x300 PNG, chosen with the button. Loading shows the original size and fills the fields, and
  // keyboard focus moves to "Choose another image" instead of being lost with the hidden drop zone.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ri-choose')]);
  await chooser.setFiles(fx('scene.png'));
  await waitDims('400 × 300');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'ri-another');
  assert.equal(await text('#ri-error'), '');
  assert.equal(await page.inputValue('#ri-w'), '400');
  assert.equal(await page.inputValue('#ri-h'), '300');
  assert.match(await text('#ri-forig'), /400 × 300 px/);
  assert.match(await page.locator('#ri-format option[value="same"]').textContent(), /PNG/);

  // Width with a locked aspect ratio; PNG out.
  await page.fill('#ri-w', '200');
  assert.equal(await page.inputValue('#ri-h'), '150');
  await waitDims('200 × 150');
  let out = await download();
  assert.equal(out.name, 'scene-200x150.png');
  assert.deepEqual([out.info.type, out.info.width, out.info.height], ['png', 200, 150]);

  // Height drives width when edited.
  await page.fill('#ri-h', '60');
  assert.equal(await page.inputValue('#ri-w'), '80');
  await waitDims('80 × 60');

  // Percentage mode, JPEG out.
  await page.check('input[name="ri-by"][value="pct"]');
  await page.fill('#ri-pct', '25');
  await page.selectOption('#ri-format', 'image/jpeg');
  await waitDims('100 × 75');
  assert.equal(await page.isVisible('#ri-q-field'), true, 'quality shown for JPEG');
  out = await download();
  assert.equal(out.name, 'scene-100x75.jpg');
  assert.deepEqual([out.info.type, out.info.width, out.info.height], ['jpeg', 100, 75]);
  const lowQ = out.buf.length;
  await page.fill('#ri-quality', '20');
  await page.waitForFunction(() => document.querySelector('#ri-fmt').textContent === 'JPEG at quality 20');
  out = await download();
  assert.ok(out.buf.length < lowQ, 'lower quality gives a smaller JPEG');
  await page.click('[data-pct="50"]');
  assert.equal(await page.inputValue('#ri-pct'), '50');
  await waitDims('200 × 150');

  // WebP.
  await page.selectOption('#ri-format', 'image/webp');
  await page.waitForFunction(() => /WebP/.test(document.querySelector('#ri-fmt').textContent));
  out = await download();
  assert.deepEqual([out.info.type, out.info.width, out.info.height], ['webp', 200, 150]);
  assert.equal(out.name, 'scene-200x150.webp');

  // Preset 1080x1080: unlocks the ratio and crops the centre of the 4:3 image.
  await page.selectOption('#ri-format', 'image/png');
  await page.selectOption('#ri-preset', 'ig-square');
  assert.equal(await page.isChecked('input[name="ri-by"][value="px"]'), true);
  assert.equal(await page.isChecked('#ri-lock'), false);
  assert.equal(await page.isHidden('#ri-q-field'), true, 'no quality slider for PNG');
  await waitDims('1080 × 1080');
  assert.match(await text('#ri-note'), /enlarges/);
  out = await download();
  assert.deepEqual([out.info.width, out.info.height], [1080, 1080]);
  let px = await pixels(out.buf, [[0, 540], [1079, 540]]);
  close(px[0], [32, 128, 128, 255], 4, 'left edge of centre crop starts at x=50');
  close(px[1], [223, 128, 128, 255], 4, 'right edge of centre crop ends at x=350');

  // Fit inside with a black background: 1080x810 image, 135 px bands.
  await page.selectOption('#ri-fit', 'pad');
  assert.equal(await page.isVisible('#ri-bg-field'), true);
  await page.selectOption('#ri-bg', '#000000');
  await page.waitForTimeout(400);
  out = await download();
  px = await pixels(out.buf, [[540, 60], [540, 1020], [540, 540], [540, 140]]);
  assert.deepEqual(px[0], [0, 0, 0, 255], 'top band');
  assert.deepEqual(px[1], [0, 0, 0, 255], 'bottom band');
  close(px[2], [128, 128, 128, 255], 4, 'centre of the fitted image');
  close(px[3], [128, 1, 128, 255], 4, 'first image row');

  // Stretch.
  await page.selectOption('#ri-fit', 'stretch');
  await page.fill('#ri-w', '100');
  await page.fill('#ri-h', '100');
  assert.equal(await page.inputValue('#ri-preset'), 'custom');
  await waitDims('100 × 100');
  out = await download();
  assert.deepEqual([out.info.width, out.info.height], [100, 100]);

  // Error paths.
  await page.fill('#ri-w', '0');
  await page.waitForFunction(() => /at least 1 pixel/.test(document.querySelector('#ri-error').textContent));
  assert.equal(await page.isDisabled('#ri-download'), true);
  await page.fill('#ri-w', '20000');
  await page.waitForFunction(() => /16,384/.test(document.querySelector('#ri-error').textContent));
  await page.fill('#ri-w', '100');
  await waitDims('100 × 100');
  assert.equal(await text('#ri-error'), '');

  // High-quality downscaling: 1 px black/white columns must average to grey, not alias.
  await page.check('#ri-lock');
  await page.setInputFiles('#ri-file', fx('stripes.png'));
  await page.check('input[name="ri-by"][value="pct"]');
  await page.fill('#ri-pct', '25');
  await waitDims('100 × 100');
  out = await download();
  const grid = [];
  for (let y = 5; y < 100; y += 10) for (let x = 0; x < 100; x += 3) grid.push([x, y]);
  px = await pixels(out.buf, grid);
  for (const p of px) assert.ok(p[0] >= 100 && p[0] <= 155, `stripes average to grey, got ${p[0]}`);

  // EXIF orientation 6: stored 80x40, shown upright as 40x80.
  await page.fill('#ri-pct', '100');
  await page.setInputFiles('#ri-file', fx('rot6.jpg'));
  await waitDims('40 × 80');
  out = await download();
  assert.deepEqual([out.info.width, out.info.height], [40, 80]);
  px = await pixels(out.buf, [[10, 10], [30, 10], [10, 70], [30, 70]]);
  close(px[0], [30, 60, 220, 255], 20, 'top-left is the stored bottom-left (blue)');
  close(px[1], [220, 30, 30, 255], 20, 'top-right is the stored top-left (red)');
  close(px[2], [240, 220, 30, 255], 20, 'bottom-left is the stored bottom-right (yellow)');
  close(px[3], [30, 180, 60, 255], 20, 'bottom-right is the stored top-right (green)');

  // Transparency: kept in PNG, flattened on white for JPEG.
  await page.setInputFiles('#ri-file', fx('alpha.png'));
  await waitDims('100 × 100');
  out = await download();
  px = await pixels(out.buf, [[5, 5], [50, 50]]);
  assert.equal(px[0][3], 0, 'PNG keeps transparency');
  assert.deepEqual(px[1], [255, 0, 0, 255]);
  await page.selectOption('#ri-format', 'image/jpeg');
  await page.waitForFunction(() => /JPEG/.test(document.querySelector('#ri-fmt').textContent));
  // JPEG has no transparency, so the Background choice shows and fills it (black is still chosen from above).
  assert.equal(await page.isVisible('#ri-bg-field'), true, 'background shown for a transparent image saved as JPEG');
  out = await download();
  assert.equal(out.info.type, 'jpeg');
  close((await pixels(out.buf, [[5, 5]]))[0], [0, 0, 0, 255], 3, 'transparent becomes the chosen black');
  await page.selectOption('#ri-bg', '#ffffff');
  await page.waitForTimeout(400);
  out = await download();
  px = await pixels(out.buf, [[5, 5]]);
  close(px[0], [255, 255, 255, 255], 3, 'transparent becomes white in JPEG');

  // A width-only preset keeps the aspect ratio.
  await page.selectOption('#ri-preset', 'email');
  assert.equal(await page.isChecked('#ri-lock'), true);
  await waitDims('800 × 800');

  // Fit inside with a transparent background but JPEG output: the bands are white and a note says why.
  await page.selectOption('#ri-preset', 'ig-portrait');
  await page.selectOption('#ri-fit', 'pad');
  await page.selectOption('#ri-bg', 'transparent');
  await waitDims('1080 × 1350');
  await page.waitForFunction(() => /JPEG cannot store transparency/.test(document.querySelector('#ri-note').textContent));
  out = await download();
  assert.equal(out.info.type, 'jpeg');
  // 100x100 fitted into 1080x1350 is 1080x1080 with 135 px bands above and below.
  close((await pixels(out.buf, [[540, 20]]))[0], [255, 255, 255, 255], 3, 'band is white in the JPEG');
  await page.selectOption('#ri-format', 'image/png');
  await page.waitForFunction(() => /PNG/.test(document.querySelector('#ri-fmt').textContent) && !/JPEG cannot/.test(document.querySelector('#ri-note').textContent));
  out = await download();
  assert.equal((await pixels(out.buf, [[540, 20]]))[0][3], 0, 'band stays transparent in the PNG');

  // Stretching 1600x400 to 100x400 shrinks only the width, 16 times. Each side is halved on its own
  // (800, 400 and 200 wide) and the final step does the last 2x; the old loop needed both sides to
  // halve and so made one 16x jump. 1 px stripes must average to grey.
  const wide = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 400;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 1600, 400); x.fillStyle = '#000';
    for (let i = 0; i < 1600; i += 2) x.fillRect(i, 0, 1, 400);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.selectOption('#ri-preset', 'custom');
  // Adding to a list keeps the size already set; a fresh list starts from the image's own size.
  await page.click('#ri-clear');
  await page.setInputFiles('#ri-file', { name: 'wide.png', mimeType: 'image/png', buffer: wide });
  await waitDims('1600 × 400');
  await page.uncheck('#ri-lock');
  await page.selectOption('#ri-fit', 'stretch');
  await page.waitForTimeout(300);
  await page.fill('#ri-w', '100');
  assert.equal(await page.inputValue('#ri-h'), '400', 'unlocked: the height stays');
  await waitDims('100 × 400');
  out = await download();
  assert.deepEqual([out.info.width, out.info.height], [100, 400]);
  const row = [];
  for (let x = 0; x < 100; x += 7) row.push([x, 200]);
  for (const p of await pixels(out.buf, row)) assert.ok(p[0] >= 110 && p[0] <= 145, `stretched stripes average to grey, got ${p[0]}`);
  // The halving steps themselves, recorded by wrapping drawImage. Normally they run in a worker, so this
  // uses a browser without OffscreenCanvas, where the same code runs on the page (the fallback path).
  {
    const ctx2 = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await ctx2.addInitScript(() => { delete window.OffscreenCanvas; });
    const p2 = await ctx2.newPage();
    await p2.goto(url);
    await p2.setInputFiles('#ri-file', { name: 'wide.png', mimeType: 'image/png', buffer: wide });
    await p2.waitForFunction(() => document.querySelector('#ri-dims').textContent === '1600 × 400');
    await p2.uncheck('#ri-lock');
    await p2.selectOption('#ri-fit', 'stretch');
    await p2.waitForTimeout(300);
    await p2.evaluate(() => {
      window.__draws = [];
      const orig = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        window.__draws.push(this.canvas.width + 'x' + this.canvas.height);
        return orig.apply(this, args);
      };
    });
    await p2.fill('#ri-w', '100');
    await p2.waitForFunction(() => document.querySelector('#ri-dims').textContent === '100 × 400' && !document.querySelector('#ri-download').disabled);
    const draws = (await p2.evaluate(() => window.__draws)).join(' ');
    assert.ok(draws.includes('800x400 400x400 200x400 100x400'), `each side halved on its own: ${draws}`);
    const [dl2] = await Promise.all([p2.waitForEvent('download'), p2.click('#ri-download')]);
    const buf2 = fs.readFileSync(await dl2.path());
    assert.deepEqual([imageInfo(buf2).width, imageInfo(buf2).height], [100, 400], 'the no-worker fallback works');
    await ctx2.close();
  }

  // A GIF stays a GIF under "Original format" (TTImage writes GIF; the old page wrongly said it could not).
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  await page.selectOption('#ri-format', 'same');
  await page.check('#ri-lock');
  await page.click('#ri-clear');
  await page.setInputFiles('#ri-file', { name: 'dot.gif', mimeType: 'image/gif', buffer: gif });
  await waitDims('1 × 1');
  assert.equal(await page.locator('#ri-format option[value="same"]').textContent(), 'Original (GIF)');
  out = await download();
  assert.equal(out.name, 'dot-1x1.gif');
  assert.deepEqual([out.info.type, out.info.width, out.info.height], ['gif', 1, 1]);

  // ---------- Crop position, pad colour, fit inside, never enlarge ----------
  // Band images made here: three 100 px bands, red, green and blue, side by side or stacked.
  const bands = (w, h, dir) => page.evaluate(async ([w, h, dir]) => {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    ['#ff0000', '#00ff00', '#0000ff'].forEach((col, i) => {
      x.fillStyle = col;
      if (dir === 'x') x.fillRect(i * w / 3, 0, w / 3, h); else x.fillRect(0, i * h / 3, w, h / 3);
    });
    const b = await c.convertToBlob({ type: 'image/png' });
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, [w, h, dir]).then(a => Buffer.from(a));
  const settle = () => page.waitForTimeout(450);
  await page.click('#ri-clear');
  assert.equal(await page.isVisible('#ri-drop'), true, 'Remove all brings the drop zone back');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ri-choose', 'focus moves to Choose images');
  await page.selectOption('#ri-format', 'image/png');
  await page.selectOption('#ri-preset', 'custom');
  await page.check('input[name="ri-by"][value="px"]');
  await page.setInputFiles('#ri-file', { name: 'wide-bands.png', mimeType: 'image/png', buffer: await bands(300, 100, 'x') });
  await waitDims('300 × 100');
  await page.uncheck('#ri-lock');
  await page.selectOption('#ri-fit', 'crop');
  assert.equal(await page.isVisible('#ri-grav'), true, 'position grid for Crop');
  await page.fill('#ri-w', '100');
  await page.fill('#ri-h', '100');
  await waitDims('100 × 100');
  // Covering 100 x 100 needs no scaling (100 / 100 = 1), so the crop is exactly one band.
  for (const [pos, colour] of [['Left', [255, 0, 0]], ['Centre', [0, 255, 0]], ['Right', [0, 0, 255]]]) {
    await page.check(`input[name="ri-grav"][aria-label="${pos}"]`);
    await settle();
    out = await download();
    for (const p of await pixels(out.buf, [[2, 50], [97, 50]])) assert.deepEqual(p, [...colour, 255], `crop ${pos}`);
  }
  await page.setInputFiles('#ri-file', { name: 'tall-bands.png', mimeType: 'image/png', buffer: await bands(100, 300, 'y') });
  await waitDims('100 × 100');
  for (const [pos, colour] of [['Top', [255, 0, 0]], ['Bottom', [0, 0, 255]]]) {
    await page.check(`input[name="ri-grav"][aria-label="${pos}"]`);
    await settle();
    out = await download();
    for (const p of await pixels(out.buf, [[50, 2], [50, 97]])) assert.deepEqual(p, [...colour, 255], `crop ${pos}`);
  }
  // Pad the 100 x 300 image into 300 x 300 with a custom colour, placed on the left or right.
  await page.selectOption('#ri-fit', 'pad');
  await page.fill('#ri-w', '300');
  await page.fill('#ri-h', '300');
  await page.fill('#ri-bg-color', '#336699');
  assert.equal(await page.inputValue('#ri-bg'), 'custom', 'picking a colour selects Custom colour');
  assert.equal(await page.isVisible('#ri-bg-color'), true);
  await page.check('input[name="ri-grav"][aria-label="Left"]');
  await settle();
  out = await download();
  let px4 = await pixels(out.buf, [[50, 50], [50, 250], [150, 150], [290, 10]]);
  assert.deepEqual(px4, [[255, 0, 0, 255], [0, 0, 255, 255], [51, 102, 153, 255], [51, 102, 153, 255]], 'image on the left, custom colour elsewhere');
  await page.check('input[name="ri-grav"][aria-label="Right"]');
  await settle();
  out = await download();
  px4 = await pixels(out.buf, [[10, 150], [250, 50], [250, 150]]);
  assert.deepEqual(px4, [[51, 102, 153, 255], [255, 0, 0, 255], [0, 255, 0, 255]], 'image on the right');
  // Fit inside a 150 x 150 box: the 1:3 image becomes 50 x 150, no bands, no position.
  await page.selectOption('#ri-fit', 'fit');
  assert.equal(await page.isHidden('#ri-grav'), true, 'no position for Fit inside');
  await page.fill('#ri-w', '150');
  await page.fill('#ri-h', '150');
  await waitDims('50 × 150');
  // Never enlarge: fitting into 600 x 600 would make 200 x 600; with the box ticked it stays 100 x 300.
  await page.fill('#ri-w', '600');
  await page.fill('#ri-h', '600');
  await waitDims('200 × 600');
  await page.check('#ri-noup');
  await waitDims('100 × 300');
  assert.doesNotMatch(await text('#ri-note'), /enlarges/);
  await page.check('input[name="ri-by"][value="pct"]');
  await page.fill('#ri-pct', '250');
  await settle();
  await waitDims('100 × 300');
  await page.fill('#ri-pct', '50');
  await waitDims('50 × 150');
  // Never enlarge with Crop (bug: the 100 x 300 image was blown up to 600 x 600): the frame shrinks,
  // keeping its square shape, to fit inside the image, 100 x 100, the centre (green) band.
  await page.check('input[name="ri-by"][value="px"]');
  await page.selectOption('#ri-fit', 'crop');
  await page.check('input[name="ri-grav"][aria-label="Centre"]');
  await page.fill('#ri-w', '600');
  await page.fill('#ri-h', '600');
  await waitDims('100 × 100');
  out = await download();
  assert.deepEqual([out.name, out.info.width, out.info.height], ['tall-bands-100x100.png', 100, 100]);
  assert.deepEqual(await pixels(out.buf, [[50, 2], [50, 97]]), [[0, 255, 0, 255], [0, 255, 0, 255]], 'unscaled centre crop');
  assert.doesNotMatch(await text('#ri-note'), /enlarges/);
  // A wide 600 x 200 frame on the 100 x 300 image: k = min(100/600, 300/200) gives 100 x 33.
  await page.fill('#ri-h', '200');
  await waitDims('100 × 33');
  // Stretch clamps each side to the original: 600 x 200 becomes 100 x 200.
  await page.selectOption('#ri-fit', 'stretch');
  await waitDims('100 × 200');
  await page.uncheck('#ri-noup');
  await waitDims('600 × 200');

  // ---------- BMP, ICO and AVIF output ----------
  await page.check('input[name="ri-by"][value="px"]');
  await page.check('#ri-lock');
  await page.fill('#ri-w', '30');
  await page.selectOption('#ri-format', 'image/bmp');
  await waitDims('30 × 90');
  assert.equal(await page.isHidden('#ri-q-field'), true, 'no quality for BMP');
  out = await download();
  assert.equal(out.name, 'tall-bands-30x90.bmp');
  assert.deepEqual([out.info.type, out.info.width, out.info.height, out.info.bpp], ['bmp', 30, 90, 24]);
  // 24-bit rows are padded to 4 bytes (92 for 30 px) and stored bottom-up, as B, G, R.
  const bmpAt = (x, y) => { const o = out.info.offset + (90 - 1 - y) * 92 + x * 3; return [out.buf[o + 2], out.buf[o + 1], out.buf[o]]; };
  assert.deepEqual([bmpAt(15, 10), bmpAt(15, 45), bmpAt(15, 80)], [[255, 0, 0], [0, 255, 0], [0, 0, 255]], 'BMP pixels');
  await page.selectOption('#ri-format', 'image/x-icon');
  await page.uncheck('#ri-lock');
  await page.selectOption('#ri-fit', 'crop');
  await page.check('input[name="ri-grav"][aria-label="Centre"]');
  await page.fill('#ri-w', '64');
  await page.fill('#ri-h', '64');
  await waitDims('64 × 64');
  assert.equal(await page.isVisible('#ri-ico-field'), true);
  assert.equal(await page.isHidden('#ri-max-field'), true, 'no size limit for icons');
  out = await download();
  assert.equal(out.name, 'tall-bands-64x64.ico');
  assert.deepEqual(out.info.entries.map(e => [e.width, e.height, e.bpp]), [[16, 16, 32], [32, 32, 32], [48, 48, 32], [64, 64, 32]]);
  for (const e of out.info.entries) {
    assert.equal(e.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'each icon is a PNG');
    assert.deepEqual((await pixels(e.data, [[e.width >> 1, e.width >> 1]]))[0], [0, 255, 0, 255], 'centre crop is green');
  }
  await page.uncheck('#ri-ico-multi');
  await settle();
  out = await download();
  assert.equal(out.info.entries.length, 1, 'just the 64 px icon');
  // Icons are square: 64 x 32 is centred on a transparent 64 x 64 icon, and the page says so rather than
  // naming and showing it as 64 x 32 (bug).
  await page.fill('#ri-h', '32');
  await page.selectOption('#ri-fit', 'stretch');
  await page.waitForFunction(() => /Icons are square/.test(document.querySelector('#ri-note').textContent));
  await waitDims('64 × 64');
  assert.match(await text('#ri-note'), /Icons are square, so the 64 × 32 image is centred on a transparent 64 × 64 icon/);
  out = await download();
  assert.equal(out.name, 'tall-bands-64x64.ico');
  assert.deepEqual(out.info.entries.map(e => [e.width, e.height]), [[64, 64]]);
  assert.deepEqual(await pixels(out.info.entries[0].data, [[32, 4], [32, 32]]), [[0, 0, 0, 0], [0, 255, 0, 255]], 'transparent band above the image');
  await page.selectOption('#ri-fit', 'crop');
  await page.fill('#ri-w', '300');
  await page.fill('#ri-h', '300');
  await page.waitForFunction(() => /at most 256 × 256/.test(document.querySelector('#ri-error').textContent));
  assert.equal(await page.isDisabled('#ri-download'), true);
  // AVIF: the browser's own encoder, or the bundled WebAssembly one where it has none (as in Chromium).
  const avifOk = await page.evaluate(() => TTImage.canEncode('avif', { wasm: true }));
  const avifOpt = page.locator('#ri-format option[value="image/avif"]');
  if (avifOk) {
    await page.selectOption('#ri-format', 'image/avif');
    await page.waitForFunction(() => /^AVIF at quality \d+$/.test(document.querySelector('#ri-fmt').textContent), null, { timeout: 60000 });
    out = await download();
    assert.equal(out.name, 'tall-bands-300x300.avif');
    assert.deepEqual([out.info.type, out.info.width, out.info.height], ['avif', 300, 300]);
    assert.equal(out.buf.subarray(4, 12).toString('latin1'), 'ftypavif');
    // The centre crop of the 100 x 300 bands, enlarged 3x, is the green band.
    const g = (await pixels(out.buf, [[150, 150]]))[0];
    [0, 255, 0].forEach((v, i) => assert.ok(Math.abs(g[i] - v) <= 16, `AVIF centre is green: ${g}`));
  } else {
    assert.equal(await avifOpt.isDisabled(), true, 'AVIF cannot be chosen where the browser cannot save it');
    assert.match(await avifOpt.textContent(), /this browser cannot save it/);
  }

  // ---------- Target file size in KB ----------
  // Random noise compresses badly: this 800 x 600 JPEG is about 390 KB at quality 90 and 160 KB at 40.
  const noise = Buffer.from(await page.evaluate(async () => {
    const c = new OffscreenCanvas(800, 600), x = c.getContext('2d'), img = x.createImageData(800, 600);
    let seed = 3;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      img.data[i] = seed >>> 24; img.data[i + 1] = (seed >>> 16) & 255; img.data[i + 2] = (i >> 8) & 255; img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const b = await c.convertToBlob({ type: 'image/png' });
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.click('#ri-clear');
  await page.setInputFiles('#ri-file', { name: 'noise.png', mimeType: 'image/png', buffer: noise });
  await page.check('#ri-lock');
  await page.selectOption('#ri-format', 'image/jpeg');
  await page.fill('#ri-quality', '90');
  await waitDims('800 × 600');
  await page.fill('#ri-maxkb', '250');
  await page.waitForFunction(() => /Quality lowered to \d+ to fit in 250 KB/.test(document.querySelector('#ri-note').textContent), null, { timeout: 30000 });
  out = await download();
  assert.deepEqual([out.info.width, out.info.height], [800, 600], 'dimensions kept');
  assert.ok(out.buf.length <= 250000, `under 250,000 bytes: ${out.buf.length}`);
  const q = Number(/quality (\d+)/.exec(await text('#ri-fmt'))[1]);
  assert.ok(q >= 40 && q < 90, `quality ${q}`);
  // Independent check of the search with the browser's own encoder: quality q fits and q + 1 does not.
  const sizesAt = await page.evaluate(async ([bytes, qs]) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0);
    const out = [];
    for (const qq of qs) out.push((await c.convertToBlob({ type: 'image/jpeg', quality: qq / 100 })).size);
    return out;
  }, [[...noise], [q, q + 1]]);
  assert.ok(sizesAt[0] <= 250000 && sizesAt[1] > 250000, `quality ${q} is the highest that fits: ${sizesAt}`);
  assert.equal(sizesAt[0], out.buf.length, 'same bytes as the browser encoder at that quality');
  // 5 KB is out of reach at quality 40, so the size shrinks too, keeping the 4:3 shape.
  await page.fill('#ri-maxkb', '5');
  await page.waitForFunction(() => /Reduced to \d+ × \d+ at quality \d+ to fit in 5 KB/.test(document.querySelector('#ri-note').textContent), null, { timeout: 30000 });
  out = await download();
  assert.ok(out.buf.length <= 5000, `under 5,000 bytes: ${out.buf.length}`);
  assert.ok(out.info.width < 800 && Math.abs(out.info.width / out.info.height - 4 / 3) < 0.02, `shape kept: ${out.info.width} x ${out.info.height}`);
  assert.equal(await text('#ri-dims'), out.info.width + ' × ' + out.info.height);
  // PNG is lossless: only the size can shrink.
  await page.selectOption('#ri-format', 'image/png');
  await page.fill('#ri-maxkb', '200');
  await page.waitForFunction(() => /Reduced to \d+ × \d+ to fit in 200 KB/.test(document.querySelector('#ri-note').textContent), null, { timeout: 30000 });
  out = await download();
  assert.ok(out.info.type === 'png' && out.buf.length <= 200000 && out.info.width < 800, `PNG ${out.info.width} px, ${out.buf.length} bytes`);
  // An exact size keeps its pixels: 1 KB cannot hold an 800 x 600 JPEG, so it says so.
  await page.selectOption('#ri-format', 'image/jpeg');
  await page.uncheck('#ri-lock');
  await page.selectOption('#ri-fit', 'stretch');
  await page.fill('#ri-w', '800');
  await page.fill('#ri-h', '600');
  await page.fill('#ri-maxkb', '1');
  await page.waitForFunction(() => /over the 1 KB limit/.test(document.querySelector('#ri-error').textContent), null, { timeout: 30000 });
  assert.equal(await page.isDisabled('#ri-download'), true);
  await page.fill('#ri-maxkb', '');
  await page.check('#ri-lock');
  await waitDims('800 × 600');

  // ---------- Batch: HEIC, TIFF, BMP, GIF and AVIF in, one ZIP out ----------
  // quadrants.heic 240x160: (220,40,40) (40,180,60) / (40,60,200) (240,240,240); two-pages.tif 60x40, left
  // (200,30,30), right (30,30,200), 2 pages; flag.bmp 32x16 top (250,200,0), bottom (0,90,160);
  // anim.gif 20x10, 2 frames, red then blue; flat.avif 64x32 (40,120,200).
  await page.click('#ri-clear');
  await page.selectOption('#ri-format', 'same');
  await page.check('input[name="ri-by"][value="px"]');
  await page.fill('#ri-w', '120');
  await page.setInputFiles('#ri-file', ['quadrants.heic', 'two-pages.tif', 'flag.bmp', 'anim.gif', 'flat.avif', 'notes.txt'].map(fx));
  await page.waitForFunction(() => document.querySelectorAll('#ri-list .ri-row').length === 5 && !document.querySelector('#ri-download').disabled, null, { timeout: 30000 });
  assert.match(await text('#ri-error'), /“notes\.txt” could not be opened/);
  assert.equal(await page.isVisible('#ri-zip'), true);
  assert.match(await text('#ri-forig'), /240 × 160 px.*HEIC · image 1 of 5/);
  await page.fill('#ri-w', '120');
  await waitDims('120 × 80');
  assert.equal(await page.locator('#ri-format option[value="same"]').textContent(), 'JPEG (HEIC cannot be saved here)');
  assert.deepEqual(await page.locator('#ri-list .ri-row-info').allTextContents().then(a => a.map(t => t.replace(/, [\d.]+ K?B$/, ''))),
    ['240 × 160 → 120 × 80 JPEG', '60 × 40 → 120 × 80 TIFF', '32 × 16 → 120 × 60 BMP', '20 × 10 → 120 × 60 GIF', '64 × 32 → 120 × 60 ' + (avifOk ? 'AVIF' : 'JPEG')]);
  // Preview another image from the list.
  await page.locator('#ri-list .ri-pick').nth(1).click();
  await page.waitForFunction(() => /60 × 40 px/.test(document.querySelector('#ri-forig').textContent));
  await page.waitForFunction(() => /Only the first of its 2 pages is used/.test(document.querySelector('#ri-note').textContent));
  await waitDims('120 × 80');
  assert.equal(await page.locator('#ri-list .ri-pick').nth(1).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#ri-format option[value="same"]').textContent(), 'Original (TIFF)');
  // One row's own download.
  const [single] = await Promise.all([page.waitForEvent('download'), page.locator('#ri-list .ri-dl').nth(3).click()]);
  assert.equal(single.suggestedFilename(), 'anim-120x60.gif');
  assert.deepEqual((await pixels(fs.readFileSync(await single.path()), [[60, 30]]))[0], [255, 0, 0, 255], 'first GIF frame');
  // Everything as a ZIP. Focus comes back to the button afterwards.
  await page.focus('#ri-zip');
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(zdl.suggestedFilename(), 'resized-images.zip');
  const entries = readZip(fs.readFileSync(await zdl.path()));
  assert.deepEqual(entries.map(e => e.name), ['quadrants-120x80.jpg', 'two-pages-120x80.tif', 'flag-120x60.bmp', 'anim-120x60.gif', 'flat-120x60.' + (avifOk ? 'avif' : 'jpg')]);
  const [eq, et, eb, eg] = entries.map(e => e.data);
  assert.deepEqual([imageInfo(eq).type, imageInfo(eq).width, imageInfo(eq).height], ['jpeg', 120, 80]);
  const quad = await pixels(eq, [[30, 20], [90, 20], [30, 60], [90, 60]]);
  [[220, 40, 40], [40, 180, 60], [40, 60, 200], [240, 240, 240]].forEach((c, i) => c.forEach((v, j) => assert.ok(Math.abs(quad[i][j] - v) <= 14, `HEIC quadrant ${i}: ${quad[i]}`)));
  assert.deepEqual([imageInfo(et).type, imageInfo(et).width, imageInfo(et).height, imageInfo(et).compression], ['tiff', 120, 80, 5], 'TIFF stays TIFF, LZW');
  assert.deepEqual(await ttPixels(et, [[20, 40], [100, 40]]), [[200, 30, 30, 255], [30, 30, 200, 255]], 'TIFF first page');
  assert.deepEqual([imageInfo(eg).type, imageInfo(eg).width, imageInfo(eg).height], ['gif', 120, 60], 'GIF stays GIF');
  assert.deepEqual([imageInfo(eb).type, imageInfo(eb).width, imageInfo(eb).height], ['bmp', 120, 60]);
  assert.deepEqual(await pixels(eb, [[60, 10], [60, 50]]), [[250, 200, 0, 255], [0, 90, 160, 255]], 'BMP stays BMP');
  assert.deepEqual(await pixels(eg, [[5, 5]]), [[255, 0, 0, 255]]);
  assert.match(await text('#ri-progress'), /Saved resized-images\.zip: 5 images/);
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ri-zip');
  assert.match(await page.locator('#ri-list .ri-row-info').first().textContent(), /→ 120 × 80 JPEG, [\d.]+ KB/, 'rows show the saved size');
  // Phone width with the list showing.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'no horizontal scroll at 390 px');
  await page.setViewportSize({ width: 1280, height: 900 });
  // Remove a row; focus stays in the list.
  await page.locator('#ri-list .ri-x').nth(1).click();
  assert.equal(await page.locator('#ri-list .ri-row').count(), 4);
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label') || ''), /^Remove flag\.bmp/);

  // ---------- SVG is drawn at the new size ----------
  // A viewBox-only SVG (100 x 50, red left half, blue right half) resized to 1000 px wide: a raster
  // upscale would blur the join over several pixels; drawn as vectors it is sharp.
  await page.click('#ri-clear');
  await page.selectOption('#ri-format', 'image/png');
  const halves = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="50" height="50" fill="#ff0000"/><rect x="50" width="50" height="50" fill="#0000ff"/></svg>');
  await page.setInputFiles('#ri-file', { name: 'halves.svg', mimeType: 'image/svg+xml', buffer: halves });
  await waitDims('100 × 50');
  await page.fill('#ri-w', '1000');
  await waitDims('1000 × 500');
  assert.match(await text('#ri-note'), /stays sharp/);
  out = await download();
  assert.deepEqual(await pixels(out.buf, [[498, 250], [501, 250]]), [[255, 0, 0, 255], [0, 0, 255, 255]], 'sharp edge between the halves');

  // A UTF-16 SVG (byte order mark) is read in its own encoding, not as UTF-8 (which failed to parse).
  const utf16 = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="#00ff00"/></svg>', 'utf16le').swap16())]);
  await page.setInputFiles('#ri-file', { name: 'utf16.svg', mimeType: 'image/svg+xml', buffer: utf16 });
  await page.waitForFunction(() => document.querySelectorAll('#ri-list .ri-row').length === 2 || document.querySelector('#ri-error').textContent);
  assert.equal(await text('#ri-error'), '', 'UTF-16BE SVG opens');
  assert.match(await page.locator('#ri-list .ri-row-info').nth(1).textContent(), /^30 × 20 →/);
  await page.locator('#ri-list .ri-x').nth(1).click();
  await waitDims('1000 × 500');

  // ---------- Download straight after a change saves the new size ----------
  // The preview waits 150 ms after typing; before the fix a click inside that pause saved the previous
  // result (here 1000 x 500) under the old name.
  await page.fill('#ri-w', '240');
  out = await download();
  assert.equal(out.name, 'halves-240x120.png');
  assert.deepEqual([out.info.width, out.info.height], [240, 120]);
  // An invalid size typed just before the click gives the error, not a stale file.
  await page.fill('#ri-w', '0');
  let saved = false;
  page.once('download', () => { saved = true; });
  await page.click('#ri-download', { force: true, noWaitAfter: true }).catch(() => {});
  await page.waitForFunction(() => /at least 1 pixel/.test(document.querySelector('#ri-error').textContent));
  await page.waitForTimeout(300);
  assert.equal(saved, false, 'no download for an invalid size');
};
