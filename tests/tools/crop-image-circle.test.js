const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Independent PNG decoder (ISO/IEC 15948): 8-bit RGB or RGBA, non-interlaced, all five filters.
function decodePng(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let o = 8, ihdr = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  assert.equal(ihdr.depth, 8);
  assert.equal(ihdr.interlace, 0);
  assert.ok(ihdr.type === 6 || ihdr.type === 2, `colour type ${ihdr.type}`);
  const bpp = ihdr.type === 6 ? 4 : 3, stride = ihdr.w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(ihdr.h * stride);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y ? out[(y - 1) * stride + i - bpp] : 0;
      let p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f];
      out[y * stride + i] = (line[i] + pred) & 255;
    }
  }
  return {
    w: ihdr.w, h: ihdr.h,
    px(x, y) { const k = y * stride + x * bpp; return bpp === 4 ? [...out.subarray(k, k + 4)] : [...out.subarray(k, k + 3), 255]; },
  };
}

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  const near = (p, rgba, tol = 6) => rgba.every((v, k) => Math.abs(p[k] - v) <= tol);
  const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255];
  async function download() {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#circ-download')]);
    const png = decodePng(fs.readFileSync(await dl.path()), assert);
    png.name = dl.suggestedFilename();
    return png;
  }
  const setRange = (sel, v) => page.$eval(sel, (el, val) => { el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  function checkCorners(png, rgba) {
    const n = png.w - 1;
    for (const [x, y] of [[0, 0], [n, 0], [0, n], [n, n]]) assert.deepEqual(png.px(x, y), rgba, `corner ${x},${y}`);
  }

  // ---------- Sample picture on load, default 512 px ----------
  assert.equal(await page.inputValue('#circ-size'), '512');
  let png = await download();
  assert.equal(png.name, 'sample-circle-512.png');
  assert.deepEqual([png.w, png.h], [512, 512]);
  checkCorners(png, [0, 0, 0, 0]);
  assert.equal(png.px(256, 256)[3], 255, 'opaque centre');
  // Just inside the rim is opaque, just outside is transparent (radius 256 around 256,256).
  assert.equal(png.px(256, 3)[3], 255);
  assert.equal(png.px(256 + 184, 256 - 184)[3], 0, 'outside the circle on the diagonal');
  assert.match(await page.textContent('#circ-status'), /Saved sample-circle-512\.png/);

  // ---------- Own image: 400x200 with red | green | blue thirds ----------
  await page.setInputFiles('#circ-file', path.join(fixtures, 'stripes.png'));
  await page.waitForFunction(() => /stripes\.png/.test(document.querySelector('#circ-drop-title').textContent));
  await page.selectOption('#circ-size', '256');
  png = await download();
  assert.equal(png.name, 'stripes-circle-256.png');
  assert.deepEqual([png.w, png.h], [256, 256]);
  checkCorners(png, [0, 0, 0, 0]);
  // At 100% the 200 px height spans the circle, so the crop shows image x 100..300.
  // Output x maps to image x = 100 + x * 200 / 256: x=20 -> 115.6 (red), 128 -> 200 (green), 236 -> 284 (blue).
  assert.ok(near(png.px(128, 128), GREEN), `centre ${png.px(128, 128)}`);
  assert.ok(near(png.px(20, 128), RED), `left ${png.px(20, 128)}`);
  assert.ok(near(png.px(236, 128), BLUE), `right ${png.px(236, 128)}`);

  // ---------- Zoom 200%: image x 150..250, all green ----------
  await setRange('#circ-zoom', 200);
  await page.waitForFunction(() => document.querySelector('#circ-zoom-out').textContent === '200%');
  png = await download();
  assert.ok(near(png.px(20, 128), GREEN), `zoomed left ${png.px(20, 128)}`);
  assert.ok(near(png.px(236, 128), GREEN));
  await page.click('#circ-reset');
  assert.equal(await page.inputValue('#circ-zoom'), '100');

  // ---------- Drag right: clamped once the image's left edge meets the circle ----------
  const ed = page.locator('#circ-editor');
  await ed.scrollIntoViewIfNeeded();
  const box = await ed.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  png = await download();
  // Crop now shows image x 0..200: centre -> 100 (red), x=236 -> 184 (green).
  assert.ok(near(png.px(128, 128), RED), `dragged centre ${png.px(128, 128)}`);
  assert.ok(near(png.px(236, 128), GREEN), `dragged right ${png.px(236, 128)}`);
  checkCorners(png, [0, 0, 0, 0]);

  // Keyboard: ArrowLeft moves the image back by 1% of the diameter per press.
  await ed.focus();
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowLeft');
  png = await download();
  // Offset 0.25 diameters (one diameter = 200 image px): centre -> image x 200 - 50 = 150 (green).
  assert.ok(near(png.px(128, 128), GREEN), `after arrows ${png.px(128, 128)}`);
  await ed.focus(); // the download click moved focus to the button
  await page.keyboard.press('NumpadAdd');
  assert.equal(await page.inputValue('#circ-zoom'), '110');
  await page.keyboard.press('Minus');
  assert.equal(await page.inputValue('#circ-zoom'), '100');
  await page.keyboard.press('Equal');
  assert.equal(await page.inputValue('#circ-zoom'), '110');
  await page.keyboard.press('0');
  assert.equal(await page.inputValue('#circ-zoom'), '100');

  // ---------- Rotate 90° clockwise: the left (red) third ends up on top ----------
  await page.click('#circ-rotate');
  png = await download();
  // Rotated image is 200x400; the crop shows rotated y 100..300.
  assert.ok(near(png.px(128, 20), RED), `top ${png.px(128, 20)}`);
  assert.ok(near(png.px(128, 128), GREEN));
  assert.ok(near(png.px(128, 236), BLUE), `bottom ${png.px(128, 236)}`);
  assert.ok(near(png.px(20, 128), GREEN), 'bands are horizontal now');
  await page.click('#circ-rotate');
  await page.click('#circ-rotate');
  await page.click('#circ-rotate');

  // ---------- Border ----------
  await page.fill('#circ-border', '10');
  await page.fill('#circ-border-color', '#ffff00');
  png = await download();
  assert.deepEqual(png.px(128, 4), [255, 255, 0, 255], 'ring (radius 118-128) is yellow');
  assert.ok(near(png.px(128, 14), GREEN), `inside the ring ${png.px(128, 14)}`);
  checkCorners(png, [0, 0, 0, 0]);
  await page.fill('#circ-border', '0');

  // ---------- Background colour with the image zoomed out ----------
  assert.equal(await page.isDisabled('#circ-bg-color'), true);
  await page.selectOption('#circ-bg', 'inside');
  assert.equal(await page.isDisabled('#circ-bg-color'), false);
  await page.fill('#circ-bg-color', '#123456');
  const minZoom = Number(await page.getAttribute('#circ-zoom', 'min'));
  assert.equal(minZoom, 25, 'minimum zoom is half of "whole image fits"');
  await setRange('#circ-zoom', minZoom);
  png = await download();
  // At 25% the image spans 0.5 x 0.25 diameters around the centre.
  assert.deepEqual(png.px(128, 30), [0x12, 0x34, 0x56, 255], 'uncovered inside -> background');
  assert.ok(near(png.px(128, 128), GREEN));
  checkCorners(png, [0, 0, 0, 0]);
  await page.selectOption('#circ-bg', 'all');
  png = await download();
  checkCorners(png, [0x12, 0x34, 0x56, 255]);
  assert.match(await page.textContent('#circ-out-info'), /square/);
  await page.selectOption('#circ-bg', 'none');
  await page.click('#circ-reset');

  // ---------- Large output from a small source warns about enlarging ----------
  await page.selectOption('#circ-size', '1024');
  await page.waitForFunction(() => /enlarged/.test(document.querySelector('#circ-out-hint').textContent));
  assert.match(await page.textContent('#circ-out-hint'), /about 200 px of your image/);
  png = await download();
  assert.deepEqual([png.w, png.h], [1024, 1024]);
  assert.equal(png.px(0, 0)[3], 0);
  assert.equal(png.px(512, 512)[3], 255);

  // ---------- Copy to clipboard ----------
  await page.selectOption('#circ-size', '128');
  await page.click('#circ-copy');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#circ-status').textContent) || document.querySelector('#circ-error').textContent);
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType('image/png');
    const bmp = await createImageBitmap(blob);
    return [bmp.width, bmp.height];
  });
  assert.deepEqual(clip, [128, 128]);

  // ---------- Bad file ----------
  await page.setInputFiles('#circ-file', { name: 'oops.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') });
  await page.waitForFunction(() => document.querySelector('#circ-error').textContent.length > 0);
  assert.match(await page.textContent('#circ-error'), /could not be opened as an image/);
  png = await download(); // the previous image is still there
  assert.equal(png.name, 'stripes-circle-128.png');
};
