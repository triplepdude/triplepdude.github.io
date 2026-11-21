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

module.exports = async ({ page, open, assert, fixtures, url }) => {
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
  // The zoom slider is logarithmic: its value is 100 * log2(zoom), announced as a percentage.
  const setZoom = pct => setRange('#circ-zoom', Math.round(100 * Math.log2(pct / 100)));
  const zoomText = () => page.getAttribute('#circ-zoom', 'aria-valuetext');
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
  assert.equal(await zoomText(), '100%');
  assert.equal(await page.inputValue('#circ-zoom'), '0', '100% sits at log2(1) = 0');
  await setZoom(200);
  assert.equal(await page.inputValue('#circ-zoom'), '100');
  assert.equal(await zoomText(), '200%');
  assert.equal(await page.textContent('#circ-zoom-out'), '200%');
  png = await download();
  assert.ok(near(png.px(20, 128), GREEN), `zoomed left ${png.px(20, 128)}`);
  assert.ok(near(png.px(236, 128), GREEN));
  await page.click('#circ-reset');
  assert.equal(await zoomText(), '100%');

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
  assert.equal(await zoomText(), '110%');
  await page.keyboard.press('Minus');
  assert.equal(await zoomText(), '100%');
  await page.keyboard.press('Equal');
  assert.equal(await zoomText(), '110%');
  await page.keyboard.press('0');
  assert.equal(await zoomText(), '100%');

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
  assert.equal(minZoom, -200, 'minimum zoom is half of "whole image fits": log2(0.25) = -2');
  await setRange('#circ-zoom', minZoom);
  assert.equal(await zoomText(), '25%');
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
  assert.match(await page.textContent('#circ-error'), /not a supported image/);
  png = await download(); // the previous image is still there
  assert.equal(png.name, 'stripes-circle-128.png');
  // 128 px from a 200 px crop is drawn from a pre-shrunk copy (in the worker): same geometry.
  checkCorners(png, [0, 0, 0, 0]);
  assert.ok(near(png.px(64, 64), GREEN), `128 centre ${png.px(64, 64)}`);
  assert.ok(near(png.px(10, 64), RED), `128 left ${png.px(10, 64)}`);  // image x = 100 + 10 * 200 / 128 = 115.6
  assert.ok(near(png.px(118, 64), BLUE), `128 right ${png.px(118, 64)}`); // image x = 284.4

  // ---------- EXIF orientation: a sideways-stored phone photo comes out upright ----------
  // rot6.jpg stores 300x200 pixels with a red 60x40 block at the stored top-left and EXIF
  // Orientation 6, so it displays as 200x300 with the block at x 160-199, y 0-59.
  await page.setInputFiles('#circ-file', path.join(fixtures, 'rot6.jpg'));
  await page.waitForFunction(() => /rot6\.jpg/.test(document.querySelector('#circ-drop-title').textContent));
  assert.match(await page.textContent('#circ-drop-hint'), /^200 × 300 px/);
  await setRange('#circ-zoom', await page.getAttribute('#circ-zoom', 'min'));
  assert.equal(await zoomText(), '33%');
  png = await download();
  // Zoom 1/3: the 200 px width spans 1/3 of the 128 px circle, so 1 image px = 0.2133 output px and
  // the image covers x 42.7-85.3, y 32-96. The red block lands at x 76.8-85.1, y 32-44.6.
  assert.ok(near(png.px(81, 38), RED, 20), `top-right of the upright photo is red: ${png.px(81, 38)}`);
  assert.ok(near(png.px(50, 38), [40, 90, 200, 255], 20), `top-left is blue: ${png.px(50, 38)}`);
  assert.ok(near(png.px(55, 90), [40, 90, 200, 255], 20), `bottom is blue: ${png.px(55, 90)}`);
  assert.equal(png.px(20, 64)[3], 0, 'inside the circle but beside the photo: transparent');

  // ---------- Rounded square and square ----------
  await page.setInputFiles('#circ-file', path.join(fixtures, 'stripes.png'));
  await page.waitForFunction(() => /stripes\.png/.test(document.querySelector('#circ-drop-title').textContent));
  await page.selectOption('#circ-size', '256');
  assert.equal(await page.isVisible('#circ-radius'), false);
  await page.selectOption('#circ-shape', 'rounded');
  assert.equal(await page.isVisible('#circ-radius'), true);
  assert.equal(await page.inputValue('#circ-radius'), '20');
  png = await download();
  assert.equal(png.name, 'stripes-rounded-256.png');
  // Corner radius 20% of 256 = 51.2 px, arc centred at (51.2, 51.2): (10, 10) lies outside it,
  // (20, 20) inside; the middle of each edge is fully covered.
  checkCorners(png, [0, 0, 0, 0]);
  assert.equal(png.px(10, 10)[3], 0, 'outside the rounded corner');
  assert.ok(near(png.px(20, 20), RED), `inside the rounded corner ${png.px(20, 20)}`);
  assert.ok(near(png.px(1, 128), RED) && near(png.px(254, 128), BLUE) && near(png.px(128, 1), GREEN), 'edges reach the sides');
  await page.waitForFunction(() => document.querySelector('#circ-out-info').textContent === '256 × 256 px PNG, rounded square with transparent corners');
  await page.fill('#circ-radius', '50');
  png = await download();
  assert.equal(png.px(20, 20)[3], 0, '50% makes a circle');
  await page.fill('#circ-radius', '20');
  await page.fill('#circ-border', '8');
  await page.fill('#circ-border-color', '#ffff00');
  png = await download();
  assert.deepEqual(png.px(128, 3), [255, 255, 0, 255], 'the border follows the edge');
  // The 8 px border's centre line is inset 4 px with radius 47.2 about (51.2, 51.2): (18, 18) is
  // 47 px from that centre, in the middle of the band.
  assert.deepEqual(png.px(18, 18), [255, 255, 0, 255], 'and the rounded corner');
  assert.ok(near(png.px(128, 12), GREEN), `inside the border ${png.px(128, 12)}`);
  await page.fill('#circ-border', '0');
  await page.selectOption('#circ-shape', 'square');
  png = await download();
  assert.equal(png.name, 'stripes-square-256.png');
  assert.ok(near(png.px(0, 0), RED) && near(png.px(255, 255), BLUE), 'a square crop fills the corners');
  await page.waitForFunction(() => document.querySelector('#circ-out-info').textContent === '256 × 256 px PNG, square');
  await page.selectOption('#circ-shape', 'circle');

  // ---------- WebP keeps transparency; JPG fills the corners ----------
  await page.selectOption('#circ-format', 'webp');
  assert.equal(await page.textContent('#circ-download'), 'Download WebP');
  let [dlw] = await Promise.all([page.waitForEvent('download'), page.click('#circ-download')]);
  assert.equal(dlw.suggestedFilename(), 'stripes-circle-256.webp');
  let buf = fs.readFileSync(await dlw.path());
  assert.equal(buf.toString('latin1', 0, 4) + buf.toString('latin1', 8, 12), 'RIFFWEBP');
  const decodeB = b => page.evaluate(async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, corner: Array.from(g.getImageData(0, 0, 1, 1).data), centre: Array.from(g.getImageData(128, 128, 1, 1).data) };
  }, b.toString('base64'));
  let dec = await decodeB(buf);
  assert.equal(dec.w, 256);
  assert.equal(dec.corner[3], 0, 'WebP corner transparent');
  assert.ok(near(dec.centre, GREEN, 12), `WebP centre ${dec.centre}`);
  assert.equal(await page.isDisabled('#circ-bg option[value="none"]'), false);
  await page.selectOption('#circ-format', 'jpeg');
  assert.equal(await page.inputValue('#circ-bg'), 'all', 'JPG switches to a solid background');
  assert.equal(await page.inputValue('#circ-bg-color'), '#123456', 'the colour picked earlier is kept');
  assert.equal(await page.isDisabled('#circ-bg option[value="none"]'), true);
  await page.waitForFunction(() => /JPG has no transparency/.test(document.querySelector('#circ-out-hint').textContent));
  [dlw] = await Promise.all([page.waitForEvent('download'), page.click('#circ-download')]);
  assert.equal(dlw.suggestedFilename(), 'stripes-circle-256.jpg');
  buf = fs.readFileSync(await dlw.path());
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xff, 0xd8, 0xff]);
  dec = await decodeB(buf);
  assert.ok(near(dec.corner, [0x12, 0x34, 0x56, 255], 6), `JPG corner filled ${dec.corner}`);
  assert.ok(near(dec.centre, GREEN, 16), `JPG centre ${dec.centre}`);
  // Copy image is always a PNG.
  await page.click('#circ-copy');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#circ-status').textContent));
  assert.deepEqual(await page.evaluate(async () => (await navigator.clipboard.read())[0].types), ['image/png']);
  await page.selectOption('#circ-format', 'png');
  await page.selectOption('#circ-bg', 'none');
  assert.equal(await page.textContent('#circ-download'), 'Download PNG');

  // ---------- HEIC and TIFF, which the browser cannot open, go through the shared decoder ----------
  // gps.heic: 96 x 64 in quadrants red, green / blue, yellow. At 100% the 64 px height spans the
  // circle, so the crop shows x 16-80: output (40, 40) -> image (36, 20) red, (88, 40) -> (60, 20)
  // green, (40, 88) -> (36, 44) blue, (88, 88) -> (60, 44) yellow.
  await page.selectOption('#circ-size', '128');
  await page.setInputFiles('#circ-file', path.join(fixtures, 'gps.heic'));
  await page.waitForFunction(() => /gps\.heic/.test(document.querySelector('#circ-drop-title').textContent), null, { timeout: 20000 });
  assert.match(await page.textContent('#circ-drop-hint'), /^96 × 64 px/);
  png = await download();
  assert.equal(png.name, 'gps-circle-128.png');
  assert.ok(near(png.px(40, 40), [230, 30, 30, 255], 30) && near(png.px(88, 40), [30, 200, 60, 255], 30) &&
    near(png.px(40, 88), [40, 90, 210, 255], 30) && near(png.px(88, 88), [240, 220, 40, 255], 30), 'HEIC quadrants');
  checkCorners(png, [0, 0, 0, 0]);
  // tiled-o8.tif: stored 48 x 32 with Orientation 8, upright 32 x 48 with a red block at x 0-9,
  // y 32-47 and transparency at y 0-7. At 100% the crop shows y 8-40: output (30, 100) -> image
  // (7.5, 33) red, (100, 20) -> (25, 13) blue.
  await page.setInputFiles('#circ-file', path.join(fixtures, 'tiled-o8.tif'));
  await page.waitForFunction(() => /tiled-o8\.tif/.test(document.querySelector('#circ-drop-title').textContent), null, { timeout: 20000 });
  assert.match(await page.textContent('#circ-drop-hint'), /^32 × 48 px/, 'upright');
  png = await download();
  assert.ok(near(png.px(30, 100), [230, 30, 30, 255], 20), `TIFF red block ${png.px(30, 100)}`);
  assert.ok(near(png.px(100, 20), [40, 90, 210, 255], 20), `TIFF blue ${png.px(100, 20)}`);

  // ---------- Keyboard: browser shortcuts pass through; no chatter while dragging ----------
  const passed = await page.$eval('#circ-editor', ed => {
    const e = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true });
    ed.dispatchEvent(e);
    return !e.defaultPrevented;
  });
  assert.equal(passed, true, 'Ctrl+0 (browser zoom reset) is not taken over');
  assert.equal(await page.getAttribute('#circ-zoom-out', 'aria-hidden'), 'true', 'the zoom value is announced once, by the slider');
  await page.evaluate(() => {
    window.__liveChanges = 0;
    new MutationObserver(m => { window.__liveChanges += m.length; }).observe(document.querySelector('#circ-out-info'), { childList: true, characterData: true, subtree: true });
  });
  const eb = await ed.boundingBox();
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width / 2 + 40, eb.y + eb.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__liveChanges), 0, 'the polite live region is not rewritten on every frame');

  // ---------- No OffscreenCanvas: the page draws the PNG itself ----------
  const p2 = await page.context().newPage();
  const p2errors = [];
  p2.on('pageerror', e => p2errors.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') p2errors.push(m.text()); });
  await p2.addInitScript(() => { delete window.OffscreenCanvas; });
  await p2.goto(url);
  await p2.setInputFiles('#circ-file', path.join(fixtures, 'stripes.png'));
  await p2.waitForFunction(() => /stripes\.png/.test(document.querySelector('#circ-drop-title').textContent));
  await p2.selectOption('#circ-size', '128');
  const [dl2] = await Promise.all([p2.waitForEvent('download'), p2.click('#circ-download')]);
  png = decodePng(fs.readFileSync(await dl2.path()), assert);
  assert.deepEqual([png.w, png.h], [128, 128]);
  checkCorners(png, [0, 0, 0, 0]);
  assert.ok(near(png.px(64, 64), GREEN) && near(png.px(10, 64), RED) && near(png.px(118, 64), BLUE), 'same crop without the worker');
  // JPG on the page, with the untouched default: the corners are white.
  await p2.selectOption('#circ-format', 'jpeg');
  assert.equal(await p2.inputValue('#circ-bg-color'), '#ffffff');
  const [dl2j] = await Promise.all([p2.waitForEvent('download'), p2.click('#circ-download')]);
  assert.equal(dl2j.suggestedFilename(), 'stripes-circle-128.jpg');
  const jc = await p2.evaluate(async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(0, 0, 1, 1).data);
  }, fs.readFileSync(await dl2j.path()).toString('base64'));
  assert.ok(near(jc, [255, 255, 255, 255], 4), `white corner ${jc}`);
  assert.deepEqual(p2errors, []);
  await p2.close();

  // ---------- Startup on a 3x phone: one editor paint at 2x, redrawn only on a real resize ----------
  const ctx3 = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const p3 = await ctx3.newPage();
  await p3.addInitScript(() => {
    window.__paints = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...a) {
      if (this.canvas.id === 'circ-editor') window.__paints++;
      return clear.apply(this, a);
    };
  });
  await p3.goto(url);
  await p3.waitForFunction(() => window.__paints > 0);
  await p3.waitForTimeout(600);
  const at3 = await p3.evaluate(() => {
    const e = document.querySelector('#circ-editor');
    return { paints: window.__paints, w: e.width, css: e.getBoundingClientRect().width, dpr: devicePixelRatio };
  });
  assert.equal(at3.dpr, 3);
  assert.equal(at3.paints, 1, 'the sample is painted once at startup, not again by the ResizeObserver');
  assert.equal(at3.w, Math.round(at3.css * 2), `backing store capped at 2x: ${JSON.stringify(at3)}`);
  await p3.setViewportSize({ width: 340, height: 844 });
  await p3.waitForFunction(() => { const e = document.querySelector('#circ-editor'); return e.width === Math.round(e.getBoundingClientRect().width * 2); });
  assert.ok(await p3.evaluate(() => window.__paints) >= 2, 'a real resize still redraws');
  await ctx3.close();

  // ---------- SVG is drawn big enough for the largest output, not at its nominal 300 x 150 ----------
  // viewBox 100 x 50: red with a blue disc of radius 20 at (50, 25). Drawn at 4096 x 2048, so at 100%
  // the 2048 px height spans the circle and a 2048 px output needs no enlarging.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#ff0000"/><circle cx="50" cy="25" r="20" fill="#0000ff"/></svg>';
  await page.setInputFiles('#circ-file', { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await page.waitForFunction(() => /logo\.svg/.test(document.querySelector('#circ-drop-title').textContent));
  assert.match(await page.textContent('#circ-drop-hint'), /^SVG, drawn at 4096 × 2048 px/);
  await page.selectOption('#circ-shape', 'circle');
  await page.selectOption('#circ-size', '2048');
  assert.doesNotMatch(await page.textContent('#circ-out-hint'), /enlarged/);
  png = await download();
  assert.equal(png.name, 'logo-circle-2048.png');
  // Output x/y map to viewBox units as 25 + x * 50 / 2048: (1024, 1024) is the disc's centre,
  // (1024, 60) lies 23.5 units above it, outside the disc, on red.
  assert.deepEqual(png.px(1024, 1024), BLUE);
  assert.deepEqual(png.px(1024, 60), RED);
  // The disc's edge is sharp (vector-drawn), not a blurred 300 x 150 enlargement: 1 unit = 41 px, and
  // at 1 unit inside and outside the edge the colours are pure.
  assert.deepEqual(png.px(1024, 1024 - 19 * 40.96 | 0), BLUE);
  assert.deepEqual(png.px(1024, 1024 - 21 * 40.96 | 0), RED);
  // A broken SVG gets a readable error and the previous image stays.
  await page.setInputFiles('#circ-file', { name: 'broken.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>') });
  await page.waitForFunction(() => document.querySelector('#circ-error').textContent.length > 0);
  assert.match(await page.textContent('#circ-error'), /SVG/);
  assert.match(await page.textContent('#circ-drop-title'), /logo\.svg/);

  // ---------- A file dropped anywhere on the page opens, instead of replacing the page ----------
  const dropped = await page.evaluate(async b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }));
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('h1').dispatchEvent(over);
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('h1').dispatchEvent(ev);
    return { over: over.defaultPrevented, drop: ev.defaultPrevented };
  }, fs.readFileSync(path.join(fixtures, 'stripes.png')).toString('base64'));
  assert.deepEqual(dropped, { over: true, drop: true });
  await page.waitForFunction(() => /dropped\.png/.test(document.querySelector('#circ-drop-title').textContent));
  assert.match(await page.textContent('#circ-drop-hint'), /^400 × 200 px/);
};
