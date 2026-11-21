const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Expected pixels, sizes and JPEG tables come from tests/fixtures/flip-image/make_fixtures.py
// (numpy flips and turns, Python's math module, libjpeg's quality scaling), never from this page.

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
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][f]) & 255;
    }
  }
  const px = (x, y) => { const k = y * stride + x * bpp; return bpp === 4 ? [...out.subarray(k, k + 4)] : [...out.subarray(k, k + 3), 255]; };
  const rgba = () => { const r = []; for (let y = 0; y < ihdr.h; y++) for (let x = 0; x < ihdr.w; x++) r.push(...px(x, y)); return r; };
  return { w: ihdr.w, h: ihdr.h, px, rgba };
}

// Pixel size from the file bytes (JPEG SOF, GIF screen descriptor, PNG IHDR).
function dims(b) {
  if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length;) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  throw new Error('unknown format ' + b.subarray(0, 8).toString('hex'));
}

// The first luminance quantisation table of a JPEG (ITU T.81 B.2.4.1), in stored (zigzag) order.
function dqt0(b) {
  for (let i = 2; i < b.length;) {
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m === 0xdb) {
      for (let p = i + 4; p < i + 2 + len;) {
        const wide = b[p] >> 4, id = b[p] & 15, n = wide ? 128 : 64;
        if (id === 0) return [...Array(64)].map((_, k) => (wide ? b.readUInt16BE(p + 1 + 2 * k) : b[p + 1 + k]));
        p += 1 + n;
      }
    }
    if (m === 0xda) break;
    i += 2 + len;
  }
  return null;
}

// Reads a ZIP from its central directory (APPNOTE 4.3.12), checking every CRC-32.
function readZip(buf, assert) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const n = buf.readUInt16LE(eocd + 10), out = [];
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize), data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data), crc, `CRC of ${name}`);
    out.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const fx = n => path.join(fixtures, n);
  const text = sel => page.textContent(sel);
  const near = (p, rgba, tol = 8) => rgba.every((v, k) => Math.abs(p[k] - v) <= tol);
  const BTN = { h: '#fl-flip-h', v: '#fl-flip-v', r: '#fl-rot-r', l: '#fl-rot-l', 180: '#fl-rot-180' };
  async function save(sel = '#fl-download', pg = page) {
    const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  }
  async function load(names, pg = page) {
    const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff' };
    const asFile = n => (typeof n === 'string' ? { name: n, mimeType: MIME[n.split('.').pop()], buffer: fs.readFileSync(fx(n)) } : n);
    await pg.setInputFiles('#fl-file', names.map(asFile));
    await pg.waitForFunction(() => !/^Opening/.test(document.querySelector('#fl-status').textContent) && document.querySelector('#fl-fname').textContent, null, { timeout: 30000 });
  }
  const angle = async v => { await page.fill('#fl-angle', v); };
  const state = () => text('#fl-state');

  await open();

  // ---------- The sample picture until an image is opened ----------
  assert.equal(await state(), 'Not flipped or rotated · 900 × 600 px');
  assert.equal(await text('#fl-before-size'), '· 900 × 600 px');
  let f = await save();
  assert.equal(f.name, 'sample-copy.png');
  assert.deepEqual(dims(f.buf), [900, 600]);
  await page.click('#fl-rot-r');
  assert.equal(await state(), 'Rotated 90° clockwise · 600 × 900 px');
  assert.equal(await page.inputValue('#fl-angle'), '90');
  await page.click('#fl-reset');

  // ---------- Every flip and quarter turn, pixel for pixel, against numpy ----------
  await load(['grid.png']);
  assert.match(await text('#fl-forig'), /^7 × 5 px, \d+ B, PNG$/);
  for (const seq of Object.keys(exp.grid)) {
    await page.click('#fl-reset');
    for (const op of seq === '180' ? ['180'] : seq.split('')) await page.click(BTN[op]);
    f = await save();
    const png = decodePng(f.buf, assert), e = exp.grid[seq];
    assert.deepEqual([png.w, png.h], [e.w, e.h], `size after ${seq}`);
    assert.deepEqual(png.rgba(), e.rgba, `pixels after ${seq}`);
  }
  // Names and descriptions of the combined transforms.
  await page.click('#fl-reset');
  await page.click('#fl-rot-r');
  await page.click('#fl-flip-h');
  assert.equal(await state(), 'Flipped horizontally, then rotated 90° anticlockwise · 5 × 7 px');
  assert.equal(await page.inputValue('#fl-angle'), '-90');
  assert.equal((await save()).name, 'grid-flipped-horizontal-rotated-270.png');
  await page.click('#fl-reset');
  await page.click('#fl-flip-h');
  await page.click('#fl-flip-v');
  assert.equal(await state(), 'Rotated 180° · 7 × 5 px', 'both flips are a half turn');
  await page.click('#fl-flip-h');
  assert.equal(await state(), 'Flipped vertically · 7 × 5 px');
  assert.equal((await save()).name, 'grid-flipped-vertical.png');
  // Copy image puts the result itself on the clipboard: the grid turned clockwise, pixel for pixel.
  await page.click('#fl-reset');
  await page.click('#fl-rot-r');
  await page.click('#fl-copy');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#fl-status').textContent) || document.querySelector('#fl-error').textContent);
  const copied = await page.evaluate(async () => {
    const items = await navigator.clipboard.read(), bmp = await createImageBitmap(await items[0].getType('image/png'));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return [bmp.width, bmp.height, Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data)];
  });
  assert.deepEqual(copied, [exp.grid.r.w, exp.grid.r.h, exp.grid.r.rgba], 'the copied PNG is the turned grid');

  // ---------- Keyboard: buttons with Enter and Space, the angle with the arrow keys ----------
  await page.click('#fl-reset');
  await page.focus('#fl-flip-h');
  await page.keyboard.press('Enter');
  assert.equal(await state(), 'Flipped horizontally · 7 × 5 px');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fl-flip-v');
  await page.keyboard.press('Space');
  assert.equal(await state(), 'Rotated 180° · 7 × 5 px');
  await page.click('#fl-reset');
  await page.focus('#fl-angle');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.inputValue('#fl-angle'), '1');
  await page.keyboard.press('Shift+ArrowUp');
  assert.equal(await page.inputValue('#fl-angle'), '11');
  assert.match(await state(), /^Rotated 11° clockwise/);
  // Screen readers hear the state once typing pauses, not at every keystroke.
  assert.equal(await page.getAttribute('#fl-state', 'role'), null);
  await page.evaluate(() => {
    window.liveChanges = 0;
    new MutationObserver(() => window.liveChanges++).observe(document.querySelector('#fl-live'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#fl-angle', '');
  await page.keyboard.type('12.5', { delay: 40 });
  await page.waitForFunction(() => /^Rotated 12\.5° clockwise · /.test(document.querySelector('#fl-live').textContent));
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.liveChanges), 1, 'one announcement for one typed angle');
  await page.click('#fl-reset');

  // ---------- Any angle: sizes from the formulas, corners transparent, filled or cropped ----------
  await page.click('#fl-clear');
  await load(['scene.png']);
  assert.equal(await page.isVisible('#fl-corner-row'), false, 'no corner options for a quarter turn');
  await angle('10');
  assert.equal(await page.isVisible('#fl-corner-row'), true);
  const [ew, eh] = exp.sizes['10'].expand;
  assert.equal(await state(), `Rotated 10° clockwise · ${ew} × ${eh} px`);
  assert.equal(await page.inputValue('#fl-fine'), '10');
  let png = decodePng((f = await save()).buf, assert);
  assert.equal(f.name, 'scene-rotated-10.png');
  assert.deepEqual([png.w, png.h], [ew, eh]);
  assert.equal(png.px(0, 0)[3], 0, 'transparent corner');
  assert.equal(png.px(ew - 1, eh - 1)[3], 0, 'transparent corner');
  assert.ok(near(png.px(Math.floor(ew / 2), Math.floor(eh / 2)), [255, 255, 255, 255]), 'the white centre stays in the middle');
  // Flip vertical acts on the turned picture as it is shown: the result is that picture upside down.
  const turned = png;
  await page.click('#fl-flip-v');
  assert.equal(await state(), `Flipped horizontally, then rotated 170° clockwise · ${ew} × ${eh} px`);
  assert.equal(await page.inputValue('#fl-angle'), '170');
  png = decodePng((f = await save()).buf, assert);
  assert.equal(f.name, 'scene-flipped-horizontal-rotated-170.png');
  // Resampling can round the soft edge differently, so a few pixels may be a little off.
  let off = 0, n = 0;
  for (let y = 0; y < eh; y += 3) for (let x = 0; x < ew; x += 3, n++) {
    const p = png.px(x, eh - 1 - y), o = turned.px(x, y);
    if (p.some((v, k) => Math.abs(v - o[k]) > 12)) off++;
  }
  assert.ok(off <= n / 500, `flip vertical after 10°: ${off} of ${n} pixels differ from the upside-down picture`);
  await page.click('#fl-flip-v');
  assert.equal(await state(), `Rotated 10° clockwise · ${ew} × ${eh} px`);
  await page.selectOption('#fl-bg', '#000000');
  png = decodePng((await save()).buf, assert);
  assert.deepEqual(png.px(0, 0), [0, 0, 0, 255], 'black corner');
  // A colour of your own, from the colour input.
  await page.$eval('#fl-bg-color', el => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.inputValue('#fl-bg'), 'custom');
  png = decodePng((await save()).buf, assert);
  assert.deepEqual(png.px(0, 0), [255, 0, 0, 255], 'custom red corner');
  await page.selectOption('#fl-bg', '#000000');
  for (const d of ['10', '30', '100', '135']) {
    await angle(d);
    await page.selectOption('#fl-corners', 'crop');
    assert.equal(await page.isVisible('#fl-bg-field'), false, 'no corner colour when cropping');
    const [cw, ch] = exp.sizes[d].crop;
    assert.match(await state(), new RegExp(` · ${cw} × ${ch} px$`), `crop size at ${d}°`);
    png = decodePng((await save()).buf, assert);
    assert.deepEqual([png.w, png.h], [cw, ch]);
    for (const [x, y] of [[0, 0], [cw - 1, 0], [0, ch - 1], [cw - 1, ch - 1]]) assert.equal(png.px(x, y)[3], 255, `crop corner ${x},${y} at ${d}° is filled`);
    await page.selectOption('#fl-corners', 'expand');
    assert.match(await state(), new RegExp(` · ${exp.sizes[d].expand.join(' × ')} px$`), `expanded size at ${d}°`);
  }
  // Turned 10°, the crop's top-left corner lies in the red quadrant and its bottom-right in the yellow one.
  await angle('10');
  await page.selectOption('#fl-corners', 'crop');
  png = decodePng((await save()).buf, assert);
  assert.ok(near(png.px(2, 2), [220, 40, 40, 255]), `red top left ${png.px(2, 2)}`);
  assert.ok(near(png.px(png.w - 3, png.h - 3), [240, 200, 0, 255]), `yellow bottom right ${png.px(png.w - 3, png.h - 3)}`);
  // Turned exactly 45° either way, the crop keeps the picture's own shape: typed, at the slider's
  // left end, or after a flip; 135° either way keeps the turned shape.
  for (const d of ['-45', '315', '-135', '45', '135']) {
    await angle(d);
    assert.match(await state(), new RegExp(` · ${exp.sizes[d].crop.join(' × ')} px$`), `crop size at ${d}°`);
  }
  for (const d of ['-45', '315']) {
    await angle(d);
    assert.equal(await page.inputValue('#fl-fine'), '-45', `the slider is at its anticlockwise end for ${d}°`);
  }
  await page.click('#fl-reset');
  await page.$eval('#fl-fine', el => { el.value = '-45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await state(), `Rotated 45° anticlockwise · ${exp.sizes['-45'].crop.join(' × ')} px`);
  await page.$eval('#fl-fine', el => { el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#fl-flip-h');
  assert.equal(await state(), `Flipped horizontally, then rotated 45° anticlockwise · ${exp.sizes['-45'].crop.join(' × ')} px`);
  await page.click('#fl-flip-h');
  await page.selectOption('#fl-corners', 'expand');
  // A Unicode minus, a decimal comma and a degree sign are all read.
  await angle('−2,5°');
  assert.equal(await state(), `Rotated 2.5° anticlockwise · ${exp.sizes['-2.5'].expand.join(' × ')} px`);
  assert.equal(await page.inputValue('#fl-fine'), '-2.5');
  assert.equal(await page.getAttribute('#fl-fine', 'aria-valuetext'), '2.5° anticlockwise');
  // A turn anticlockwise is named by the same turn clockwise; "deg" is read like a degree sign.
  await angle('-90');
  assert.equal((await save()).name, 'scene-rotated-270.png');
  await angle('90deg');
  assert.equal(await state(), 'Rotated 90° clockwise · 300 × 400 px');
  // The straighten slider adds a fine angle to the quarter turns.
  await page.click('#fl-reset');
  await page.click('#fl-rot-r');
  await page.$eval('#fl-fine', el => { el.value = '-3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.inputValue('#fl-angle'), '87');
  assert.match(await state(), /^Rotated 87° clockwise/);
  assert.equal(await text('#fl-fine-out'), '−3°');
  // JPEG has no transparency: transparent corners become white, and the page says so.
  await angle('10');
  await page.selectOption('#fl-bg', 'transparent');
  await page.selectOption('#fl-format', 'jpeg');
  assert.match(await text('#fl-note'), /JPG cannot store transparency, so transparent areas become white/);
  // The After preview shows the white corners the JPEG will have, not transparent ones.
  const corner = () => page.waitForTimeout(150).then(() => page.$eval('#fl-after', c => Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data)));
  assert.deepEqual(await corner(), [255, 255, 255, 255], 'white corner in the JPEG preview');
  f = await save();
  assert.equal(f.name, 'scene-rotated-10.jpg');
  assert.deepEqual(dims(f.buf), exp.sizes['10'].expand);
  await page.selectOption('#fl-format', 'webp');
  f = await save();
  assert.equal(f.buf.subarray(0, 4).toString('latin1') + f.buf.subarray(8, 12).toString('latin1'), 'RIFFWEBP');
  assert.equal(f.name, 'scene-rotated-10.webp');
  await page.selectOption('#fl-format', 'png');
  assert.equal(await page.isVisible('#fl-q-field'), false, 'no quality for PNG');
  assert.equal((await corner())[3], 0, 'transparent corner in the PNG preview');
  await page.selectOption('#fl-format', 'same');

  // ---------- Angle errors: shown, linked to the field, and nothing is saved meanwhile ----------
  const before = await state();
  for (const [bad, msg] of [['abc', /not an angle/], ['400', /from −360 to 360/], ['5²', /not an angle/], ['1e2', /not an angle/], ['9'.repeat(1000000), /not an angle/], ['1.2.3', /not an angle/]]) {
    const t0 = Date.now();
    await angle(bad);
    assert.ok(Date.now() - t0 < 3000, 'long input is refused quickly');
    assert.match(await text('#fl-angle-error'), msg, bad.slice(0, 20));
    assert.equal(await page.getAttribute('#fl-angle', 'aria-invalid'), 'true');
    assert.match(await page.getAttribute('#fl-angle', 'aria-describedby'), /\bfl-angle-error\b/);
    assert.equal(await state(), before, 'a bad angle leaves the last good one');
  }
  let saved = false;
  const onDl = () => { saved = true; };
  page.on('download', onDl);
  await page.click('#fl-download');
  await page.waitForTimeout(600);
  page.off('download', onDl);
  assert.equal(saved, false, 'Download does nothing while the angle is wrong');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fl-angle');
  // A megabyte pasted from the clipboard is cut to the field's length and refused.
  await page.fill('#fl-angle', '');
  await page.evaluate(() => navigator.clipboard.writeText('7'.repeat(1 << 20)));
  await page.focus('#fl-angle');
  await page.keyboard.press('Control+V');
  assert.ok((await page.inputValue('#fl-angle')).length <= 16);
  assert.match(await text('#fl-angle-error'), /not an angle/);
  await angle('90');
  assert.equal(await text('#fl-angle-error'), '');
  assert.equal(await page.getAttribute('#fl-angle', 'aria-invalid'), 'false');
  assert.equal(await page.getAttribute('#fl-angle', 'aria-describedby'), 'fl-angle-hint');
  assert.match(await state(), /^Rotated 90° clockwise · 300 × 400 px$/);
  // An empty field means no turn, and is put back to 0 when left.
  await angle('');
  assert.match(await state(), /^Not flipped or rotated/);
  await page.click('#fl-reset');

  // ---------- JPEG: saved at its own quality, read from its tables ----------
  await page.click('#fl-clear');
  await load(['photo.jpg']);
  assert.match(await text('#fl-forig'), /JPG, quality about 75$/);
  assert.equal(await page.isVisible('#fl-match-row'), true);
  await page.click('#fl-flip-h');
  assert.match(await text('#fl-note'), /Saved at quality 75, the setting this JPEG was saved with/);
  f = await save();
  assert.equal(f.name, 'photo-flipped-horizontal.jpg');
  assert.deepEqual(dqt0(f.buf), exp.photo_dqt, 'same quantisation table as the original');
  await page.uncheck('#fl-match');
  await page.$eval('#fl-quality', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#fl-q-out'), '50');
  f = await save();
  assert.deepEqual(dqt0(f.buf), exp.ijg['50'], 'quality 50 table');
  await page.$eval('#fl-quality', el => { el.value = '92'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  f = await save();
  assert.deepEqual(dqt0(f.buf), exp.ijg['92']);
  await page.check('#fl-match');

  // ---------- EXIF orientation is applied first ----------
  await page.click('#fl-clear');
  await load(['rot6.jpg']);
  assert.match(await text('#fl-forig'), /^200 × 300 px.*EXIF orientation tag \(6: turned 90° clockwise\) was applied first/);
  assert.equal(await text('#fl-before-size'), '· 200 × 300 px');
  await page.click('#fl-reset');
  await page.click('#fl-flip-h');
  await page.selectOption('#fl-format', 'png');
  png = decodePng((f = await save()).buf, assert);
  assert.equal(f.name, 'rot6-flipped-horizontal.png');
  assert.deepEqual([png.w, png.h], [200, 300]);
  // Upright, the red block is at the top right (x 160-199, y 0-59); mirrored, at the top left.
  assert.ok(near(png.px(10, 10), [255, 0, 0, 255], 24), `red top left ${png.px(10, 10)}`);
  assert.ok(near(png.px(190, 10), [40, 90, 200, 255], 24), `blue top right ${png.px(190, 10)}`);
  assert.ok(near(png.px(10, 80), [40, 90, 200, 255], 24), `blue below the block ${png.px(10, 80)}`);
  await page.selectOption('#fl-format', 'same');

  // ---------- A batch, a file that is not an image, and the ZIP ----------
  await page.click('#fl-clear');
  assert.equal(await page.isVisible('#fl-drop'), true);
  assert.match(await state(), / · 900 × 600 px$/, 'back to the sample');
  await load(['grid.png', 'photo.jpg', 'anim.gif', 'logo.svg', 'quadrants.heic', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') }]);
  assert.match(await text('#fl-error'), /“notes\.png” could not be opened/);
  assert.equal(await page.locator('#fl-list .fl-row').count(), 5);
  assert.equal(await page.isVisible('#fl-zip'), true);
  await page.click('#fl-reset');
  await page.click('#fl-rot-r');
  assert.equal(await page.locator('#fl-list .fl-row-info').nth(4).textContent(), '240\u00a0×\u00a0160 HEIC → 160\u00a0×\u00a0240 JPG');
  assert.match(await page.locator('#fl-list .fl-thumb img').first().getAttribute('style'), /rotate\(90deg\)/);
  // The GIF's note, shown when it is previewed.
  await page.locator('#fl-list .fl-pick').nth(2).click();
  assert.match(await text('#fl-note'), /Only the first frame of the animation is kept/);
  assert.match(await text('#fl-forig'), /image 3 of 5/);
  assert.equal(await page.$eval('#fl-format option[value="same"]', o => o.textContent), 'Original format (GIF)');
  await page.locator('#fl-list .fl-pick').nth(4).click();
  assert.equal(await page.$eval('#fl-format option[value="same"]', o => o.textContent), 'Original (saved as JPG)', 'HEIC cannot be written');
  assert.equal(await page.getAttribute('#fl-list .fl-row:nth-child(5) .fl-pick', 'aria-pressed'), 'true');
  f = await save('#fl-zip');
  assert.equal(f.name, 'rotated-images.zip');
  assert.match(await text('#fl-status'), /Saved rotated-images\.zip: 5 images/);
  const entries = readZip(f.buf, assert);
  assert.deepEqual(entries.map(e => e.name), ['grid-rotated-90.png', 'photo-rotated-90.jpg', 'anim-rotated-90.gif', 'logo-rotated-90.png', 'quadrants-rotated-90.jpg']);
  assert.deepEqual(entries.map(e => dims(e.data)), [[5, 7], [48, 64], [10, 20], [60, 120], [160, 240]]);
  assert.deepEqual(decodePng(entries[0].data, assert).rgba(), exp.grid.r.rgba, 'the PNG in the ZIP is the exact turn');
  // Turned clockwise, the SVG's red left half is on top.
  const logo = decodePng(entries[3].data, assert);
  assert.ok(near(logo.px(30, 10), [255, 0, 0, 255]) && near(logo.px(30, 110), [0, 0, 255, 255]), 'SVG turned clockwise');
  // One row's own Download button.
  f = await save('#fl-list .fl-row:nth-child(5) .fl-dl');
  assert.equal(f.name, 'quadrants-rotated-90.jpg');
  const q = await page.evaluate(async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return [[10, 10], [150, 10], [10, 230], [150, 230]].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, f.buf.toString('base64'));
  // Turned clockwise: bottom-left (blue) comes to the top left, top-left (red) to the top right.
  assert.ok(near(q[0], [40, 60, 200, 255], 16) && near(q[1], [220, 40, 40, 255], 16) && near(q[2], [240, 240, 240, 255], 16) && near(q[3], [40, 180, 60, 255], 16), JSON.stringify(q));
  // Removing a row moves the focus to the next remove button.
  await page.click('#fl-list .fl-row:nth-child(1) .fl-x');
  assert.equal(await page.locator('#fl-list .fl-row').count(), 4);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove photo.jpg');
  // A flip after the turn: the thumbnails are mirrored before they are turned, and the ZIP says flipped.
  await page.click('#fl-flip-h');
  assert.match(await page.locator('#fl-list .fl-thumb img').first().getAttribute('style'), /rotate\(-90deg\) scaleX\(-1\)/);
  f = await save('#fl-zip');
  assert.equal(f.name, 'flipped-images.zip');
  assert.deepEqual(readZip(f.buf, assert).map(e => e.name), ['photo', 'anim', 'logo', 'quadrants'].map((n, i) => `${n}-flipped-horizontal-rotated-270.${['jpg', 'gif', 'png', 'jpg'][i]}`));

  // ---------- Copy image puts a PNG of the result on the clipboard ----------
  await page.locator('#fl-list .fl-pick').first().click();
  await page.click('#fl-copy');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#fl-status').textContent) || document.querySelector('#fl-error').textContent);
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read(), bmp = await createImageBitmap(await items[0].getType('image/png'));
    return [items[0].types, bmp.width, bmp.height];
  });
  assert.deepEqual(clip, [['image/png'], 48, 64]);

  // ---------- A TIFF with two pages: only the first is used, and the page says so ----------
  await page.click('#fl-clear');
  await page.click('#fl-reset');
  await load(['pages.tif']);
  assert.match(await text('#fl-note'), /Only the first of its 2 pages is used/);
  assert.equal(await page.$eval('#fl-format option[value="same"]', o => o.textContent), 'Original format (TIFF)');
  f = await save();
  assert.equal(f.name, 'pages-copy.tif');
  assert.ok(['II*\u0000', 'MM\u0000*'].includes(f.buf.subarray(0, 4).toString('latin1')), 'a TIFF file');

  // ---------- Back and forward keep the angle, the slider and the result in step ----------
  // The browser may put back the Straighten slider when the page is loaded again; whatever it
  // shows must be what the state line and the angle field say.
  await page.click('#fl-clear');
  await angle('30');
  await page.$eval('#fl-fine', el => { el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await state(), /^Rotated 12° clockwise/);
  await page.goto('about:blank');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#fl-state').textContent.length > 0);
  await page.waitForTimeout(200);
  const a = await page.inputValue('#fl-angle'), s = await state(), fine = await page.inputValue('#fl-fine');
  const deg = /^Not flipped/.test(s) ? '0' : (/^Rotated ([\d.]+)° clockwise/.exec(s) || [])[1];
  assert.ok(deg, `state ${s}`);
  assert.deepEqual([a, fine, await text('#fl-fine-out')], [deg, deg, deg === '0' ? '0°' : `+${deg}°`], `field ${a}, slider ${fine}, state ${s}`);

  // ---------- A decimal comma in a German browser ----------
  const de = await page.context().browser().newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const pd = await de.newPage();
  await pd.goto(url);
  const s12 = exp.sample_12_5.join(' × ');
  await pd.fill('#fl-angle', '12,5');
  assert.equal(await pd.textContent('#fl-state'), `Rotated 12.5° clockwise · ${s12} px`);
  await pd.fill('#fl-angle', '-12.5');
  assert.equal(await pd.textContent('#fl-state'), `Rotated 12.5° anticlockwise · ${s12} px`);
  await de.close();

  // ---------- A phone: touch the buttons, and they are big enough for a finger ----------
  const { devices } = require('playwright');
  const ph = await page.context().browser().newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const pp = await ph.newPage();
  const errs = [];
  pp.on('pageerror', e => errs.push(e.message));
  await pp.goto(url);
  await load(['grid.png'], pp);
  await pp.tap('#fl-flip-v');
  assert.equal(await pp.textContent('#fl-state'), 'Flipped vertically · 7 × 5 px');
  const [dlp] = await Promise.all([pp.waitForEvent('download'), pp.tap('#fl-download')]);
  assert.deepEqual(decodePng(fs.readFileSync(await dlp.path()), assert).rgba(), exp.grid.v.rgba);
  // Two images, so the list of names (each a button that previews it) is shown too.
  await load(['grid.png', 'photo.jpg'], pp);
  const small = await pp.$$eval('.fl-ops .btn, #fl-download, #fl-copy, #fl-zip, #fl-angle, #fl-fine, #fl-format, .fl-pick, .fl-row .btn', els => els.filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.className));
  assert.deepEqual(small, []);
  assert.deepEqual(errs, []);
  await ph.close();
};
