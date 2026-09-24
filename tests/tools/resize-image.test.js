const fs = require('fs');
const path = require('path');

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
  throw new Error('unknown image format: ' + b.subarray(0, 16).toString('hex'));
}
function assert_(ok, msg) { if (!ok) throw new Error(msg); }

module.exports = async ({ page, open, assert, fixtures }) => {
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
  const close = (actual, expected, tol, msg) =>
    expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) <= tol, `${msg}: got [${actual}] expected ~[${expected}]`));

  assert.equal(await page.isDisabled('#ri-download'), true);
  assert.equal(await page.isVisible('#ri-placeholder'), true);

  // Not an image: friendly error, nothing loaded.
  await page.setInputFiles('#ri-file', fx('notes.txt'));
  await page.waitForFunction(() => document.querySelector('#ri-error').textContent.includes('notes.txt'));
  assert.equal(await page.isDisabled('#ri-download'), true);

  // 400x300 PNG. Loading shows the original size and fills the fields.
  await page.setInputFiles('#ri-file', fx('scene.png'));
  await waitDims('400 × 300');
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
  await page.waitForFunction(() => document.querySelector('#ri-fmt').textContent === 'JPEG 20');
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
  out = await download();
  assert.equal(out.info.type, 'jpeg');
  px = await pixels(out.buf, [[5, 5]]);
  close(px[0], [255, 255, 255, 255], 3, 'transparent becomes white in JPEG');

  // A width-only preset keeps the aspect ratio.
  await page.selectOption('#ri-preset', 'email');
  assert.equal(await page.isChecked('#ri-lock'), true);
  await waitDims('800 × 800');
};
