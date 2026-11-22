const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { devices } = require('playwright');

// Independent PNG decoder (ISO/IEC 15948): 8-bit RGB or RGBA, non-interlaced, all five filters.
function decodePng(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let o = 8, ihdr = null, phys = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    if (type === 'pHYs') phys = { x: data.readUInt32BE(0), y: data.readUInt32BE(4), unit: data[8] };
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
  return {
    w: ihdr.w, h: ihdr.h, phys,
    px(x, y) { const k = y * stride + x * bpp; return bpp === 4 ? [...out.subarray(k, k + 4)] : [...out.subarray(k, k + 3), 255]; },
  };
}

// The colour grid.png has at x, y (see tests/fixtures/crop-image/make_fixtures.py).
const gridAt = (x, y) => (x < 20 && y < 20 ? null : [x % 256, y % 256, 60 + 100 * Math.floor(x / 256), 255]);

// Entries of a ZIP file (stored or deflated), read from its central directory.
function unzip(buf) {
  let e = buf.length - 22;
  while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

// The modified time of each ZIP entry from its central directory record (MS-DOS format: local
// time in 2-second steps), as [year, month, day, hours, minutes, seconds].
function zipDates(buf) {
  let e = buf.length - 22;
  while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  let p = buf.readUInt32LE(e + 16);
  const dates = {};
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n; i++) {
    const time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14), nameLen = buf.readUInt16LE(p + 28);
    dates[buf.toString('utf8', p + 46, p + 46 + nameLen)] = [(date >> 9) + 1980, (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2];
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return dates;
}

// JPEG segments: the first luminance DQT table, and the EXIF IFD0 tags (number -> value or offset).
function jpegInfo(buf) {
  const info = { luma: null, exif: null };
  let i = 2;
  while (i < buf.length && buf[i] === 0xff) {
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m === 0xda) break;
    if (m === 0xdb && !info.luma) {
      let p = i + 4;
      while (p < i + 2 + len) {
        const pq = buf[p] >> 4, tq = buf[p] & 15, size = pq ? 128 : 64;
        if (tq === 0) { info.luma = [...buf.subarray(p + 1, p + 1 + size)]; break; }
        p += 1 + size;
      }
    }
    if (m === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10, le = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = o => (le ? buf.readUInt16LE(t + o) : buf.readUInt16BE(t + o)), u32 = o => (le ? buf.readUInt32LE(t + o) : buf.readUInt32BE(t + o));
      const ifd = u32(4), count = u16(ifd), tags = {};
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12, tag = u16(e), type = u16(e + 2), n = u32(e + 4);
        if (type === 2) tags[tag] = buf.toString('latin1', n > 4 ? t + u32(e + 8) : t + e + 8, (n > 4 ? t + u32(e + 8) : t + e + 8) + n - 1);
        else if (type === 5) tags[tag] = [u32(u32(e + 8)), u32(u32(e + 8) + 4)]; // a rational: numerator, denominator
        else tags[tag] = type === 3 ? u16(e + 8) : u32(e + 8);
      }
      info.exif = tags;
    }
    i += 2 + len;
  }
  return info;
}

module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await open();
  const near = (p, q, tol = 6) => q.every((v, k) => Math.abs(p[k] - v) <= tol);
  const fields = () => page.evaluate(() => ['x', 'y', 'w', 'h'].map(k => document.querySelector('#crp-' + k).value).join(','));
  const info = () => page.textContent('#crp-info');
  const type = async (sel, value) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  async function download(sel = '#crp-download') {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    const buf = fs.readFileSync(await dl.path());
    return { name: dl.suggestedFilename(), buf };
  }
  async function png(sel) { const d = await download(sel); const p = decodePng(d.buf, assert); p.name = d.name; return p; }
  // Pixels of any image file as the browser decodes it.
  const pixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
    const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height }), g = c.getContext('2d');
    g.drawImage(bm, 0, 0);
    return { w: bm.width, h: bm.height, px: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) };
  }, [buf.toString('base64'), pts]);
  const openFile = async (names, title) => {
    await page.setInputFiles('#crp-file', [].concat(names).map(n => path.join(fixtures, n)));
    await page.waitForFunction(t => document.querySelector('#crp-drop-title').textContent.startsWith(t), title || [].concat(names)[0]);
  };
  function checkGrid(p, box, map, label) {
    // map(i, j) -> source x, y of output pixel i, j
    let bad = 0, first = '';
    for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) {
      const [sx, sy] = map(i, j), want = gridAt(sx, sy), got = p.px(i, j);
      const ok = want ? got.every((v, k) => v === want[k]) : got[3] === 0;
      if (!ok && !bad++) first = `${i},${j} -> ${sx},${sy}: got ${got}, want ${want || 'transparent'}`;
    }
    assert.equal(bad, 0, `${label}: ${bad} wrong pixels, first ${first}`);
  }

  // ---------- The sample: a box at 80% of the picture ----------
  assert.equal(await fields(), '120,80,960,640');
  assert.equal(await info(), 'Crop 960 × 640 px (3:2) at 120, 80. Saves as a 960 × 640 px PNG.');
  let p = await png();
  assert.equal(p.name, 'sample-cropped.png');
  assert.deepEqual([p.w, p.h], [960, 640]);
  assert.match(await page.textContent('#crp-status'), /^Saved sample-cropped\.png: 960 × 640 px, [\d.]+ KB\.$/);

  // ---------- Exact pixels: a typed box on grid.png ----------
  await openFile('grid.png');
  assert.equal(await fields(), '30,20,240,160');
  assert.match(await page.textContent('#crp-drop-hint'), /^300 × 200 px PNG\./);
  await type('#crp-w', '101');
  await type('#crp-h', '55');
  await type('#crp-x', '7');
  await type('#crp-y', '3');
  assert.equal(await fields(), '7,3,101,55');
  p = await png();
  assert.equal(p.name, 'grid-cropped.png');
  assert.deepEqual([p.w, p.h], [101, 55]);
  checkGrid(p, null, (i, j) => [7 + i, 3 + j], 'typed crop');

  // ---------- Field errors and number formats ----------
  const errOf = async sel => page.evaluate(s => {
    const el = document.querySelector(s), ids = (el.getAttribute('aria-describedby') || '').split(/\s+/);
    const msg = ids.map(id => document.getElementById(id)).find(m => m && m.classList.contains('error'));
    return { invalid: el.getAttribute('aria-invalid'), msg: msg ? msg.textContent : null };
  }, sel);
  await type('#crp-w', '301');
  assert.deepEqual(await errOf('#crp-w'), { invalid: 'true', msg: 'The width can be at most 300 px, the width of the picture.' });
  assert.equal(await fields(), '7,3,301,55', 'the box is unchanged while the field is wrong');
  await type('#crp-w', '0,050');
  assert.deepEqual(await errOf('#crp-w'), { invalid: 'true', msg: 'Enter the width as a whole number of pixels, 1 or more.' }, '"0,050" is not 50: a group of thousands never starts with 0');
  await type('#crp-w', '12.5');
  assert.equal((await errOf('#crp-w')).msg, 'Enter the width as a whole number of pixels, 1 or more.');
  await type('#crp-w', '5²');
  assert.equal((await errOf('#crp-w')).invalid, 'true', 'a raised 2 is not a digit');
  await type('#crp-w', '');
  assert.equal((await errOf('#crp-w')).invalid, 'true');
  // A megabyte pasted into a field, with a long run of spaces inside (which once made a pattern
  // slow), is refused at once. Budgets are main-thread CPU time, not wall time.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const big = '1' + ' '.repeat(1 << 20) + '0 px';
  for (const sel of ['#crp-dpi', '#crp-custom', '#crp-x']) {
    const t0 = await threadMs();
    await type(sel, big);
    const ms = (await threadMs()) - t0;
    assert.equal((await errOf(sel)).invalid, 'true', `${sel}: a megabyte is refused`);
    assert.ok(ms < 1500, `${sel}: a megabyte took ${Math.round(ms)} ms of CPU`);
  }
  await type('#crp-dpi', '');
  await type('#crp-custom', '');
  assert.deepEqual(await errOf('#crp-dpi'), { invalid: null, msg: '' });
  assert.deepEqual(await errOf('#crp-custom'), { invalid: null, msg: '' });
  // Saving with a wrong field focuses it.
  await page.click('#crp-download');
  assert.equal(await page.textContent('#crp-error'), 'Correct the highlighted field first.');
  assert.ok(await page.evaluate(() => ['crp-x', 'crp-w'].includes(document.activeElement.id)));
  await type('#crp-x', '7');
  await type('#crp-w', '1,0');
  assert.equal((await errOf('#crp-w')).invalid, 'true', '1,0 is neither 10 nor 1');
  await type('#crp-w', '1 0');
  assert.equal((await errOf('#crp-w')).invalid, 'true');
  await type('#crp-w', '٢٠٠'); // Arabic-Indic digits
  assert.deepEqual(await errOf('#crp-w'), { invalid: null, msg: '' });
  assert.equal(await fields(), '7,3,٢٠٠,55', 'the field keeps what was typed while it is being edited');
  await page.$eval('#crp-w', el => el.dispatchEvent(new Event('change', { bubbles: true })));
  assert.equal(await fields(), '7,3,200,55', 'leaving the field writes the number back in plain digits');
  await type('#crp-w', '1.000');
  assert.equal((await errOf('#crp-w')).msg, 'The width can be at most 300 px, the width of the picture.', '1.000 is a thousand');
  await type('#crp-w', '250');
  assert.equal(await fields(), '7,3,250,55');
  await type('#crp-x', '60');
  assert.equal((await errOf('#crp-x')).msg, 'X can be at most 50: the picture is 300 px wide and the box 250.');
  // Moving the box writes its real X over the wrong one, and the message goes with it, so saving
  // is not refused over a field that shows a right value.
  await page.focus('#crp-editor');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await fields(), '6,3,250,55');
  assert.deepEqual(await errOf('#crp-x'), { invalid: null, msg: '' }, 'the X message goes once the box is moved');
  await type('#crp-x', '60');
  assert.equal((await errOf('#crp-x')).invalid, 'true');
  await type('#crp-x', '50');
  assert.deepEqual(await errOf('#crp-x'), { invalid: null, msg: '' });
  await page.click('#crp-error'); // the error stays until the next action
  await type('#crp-w', '300');
  assert.equal(await fields(), '0,3,300,55', 'a wider box slides left to fit');
  p = await png();
  assert.equal(await page.textContent('#crp-error'), '');
  checkGrid(p, null, (i, j) => [i, 3 + j], 'full-width strip with the transparent corner');

  // ---------- Aspect ratios ----------
  await page.selectOption('#crp-ratio', '1:1');
  assert.equal(await fields(), '50,0,200,200', 'largest square, centred on the old box');
  await page.selectOption('#crp-ratio', '4:5');
  assert.equal(await fields(), '70,0,160,200');
  await page.click('#crp-swap');
  assert.equal(await fields(), '50,20,200,160', 'swapped to 5:4 with the same area (32,000 px)');
  assert.match(await info(), /\(5:4\)/);
  await type('#crp-w', '250');
  assert.equal(await fields(), '50,0,250,200', 'the height follows at 5:4 and the box moves up to fit');
  await type('#crp-h', '201');
  assert.equal((await errOf('#crp-h')).msg, 'The height can be at most 200 px, the height of the picture.');
  await type('#crp-w', '251');
  assert.equal((await errOf('#crp-w')).msg, 'At 5:4 the width can be at most 250 px, because the picture is 200 px tall.');
  await type('#crp-w', '100');
  assert.equal(await fields(), '50,0,100,80', 'the top-left corner stays');
  await page.selectOption('#crp-ratio', 'custom');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'crp-custom');
  await type('#crp-custom', 'abc');
  assert.deepEqual(await errOf('#crp-custom'), { invalid: 'true', msg: 'Enter the ratio as width:height, such as 21:9 or 1.91:1.' });
  await type('#crp-custom', '3,5:1');
  assert.deepEqual(await errOf('#crp-custom'), { invalid: null, msg: '' });
  assert.equal(await fields(), '0,0,300,86', 'a decimal comma: 3.5:1, as wide as the picture, centred near the old box');
  await type('#crp-custom', '1.91:1');
  assert.equal(await fields(), '0,0,300,157');
  assert.match(await info(), /\(1\.91:1\)/);
  await page.selectOption('#crp-ratio', 'original');
  assert.equal(await fields(), '0,0,300,200');
  await page.selectOption('#crp-ratio', 'free');
  assert.equal(await page.isHidden('#crp-custom-field'), true);

  // ---------- Dragging: a handle, the box, and a new box ----------
  await type('#crp-w', '150'); await type('#crp-h', '100'); await type('#crp-x', '75'); await type('#crp-y', '50');
  const ed = page.locator('#crp-editor');
  await ed.scrollIntoViewIfNeeded();
  const geo = await page.evaluate(() => {
    const e = document.querySelector('#crp-editor'), r = e.getBoundingClientRect();
    return { x: r.left + e.clientLeft, y: r.top + e.clientTop, w: e.clientWidth, h: e.clientHeight };
  });
  const s = Math.min((geo.w - 28) / 300, (geo.h - 28) / 200);
  const at = (x, y) => [geo.x + geo.w / 2 + (x - 150) * s, geo.y + geo.h / 2 + (y - 100) * s];
  async function dragFrom(a, b) {
    await page.mouse.move(...a); await page.mouse.down();
    await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 3 });
    await page.mouse.move(...b, { steps: 3 }); await page.mouse.up();
  }
  await page.evaluate(() => {
    window.__live = 0;
    new MutationObserver(m => { window.__live += m.length; }).observe(document.querySelector('#crp-info'), { childList: true, characterData: true, subtree: true });
  });
  await dragFrom(at(225, 150), at(275, 180)); // south-east corner
  assert.equal(await fields(), '75,50,200,130');
  assert.equal(await page.evaluate(() => window.__live), 1, 'the live summary is written once, when the drag ends');
  await dragFrom(at(150, 100), at(120, 90)); // move
  assert.equal(await fields(), '45,40,200,130');
  await dragFrom(at(45, 100), at(-10, 100)); // west edge, past the picture
  assert.equal(await fields(), '0,40,245,130', 'the edge stops at the picture');
  await dragFrom(at(290, 10), at(260, 30)); // outside: a new box
  assert.equal(await fields(), '260,10,30,20');
  await page.selectOption('#crp-ratio', '1:1');
  await dragFrom(at(20, 20), at(60, 40)); // a new square box
  assert.equal(await fields(), '20,20,40,40');
  await page.selectOption('#crp-ratio', 'free');

  // ---------- Keyboard ----------
  await ed.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await fields(), '21,30,40,40');
  const prevented = await page.$eval('#crp-editor', el => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, true, 'Alt+Left resizes instead of going Back');
  await page.keyboard.press('Alt+ArrowDown');
  assert.equal(await fields(), '21,30,39,41');
  const passed = await page.$eval('#crp-editor', el => {
    const e = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return !e.defaultPrevented;
  });
  assert.equal(passed, true, 'Ctrl+0 is left to the browser');
  assert.match(await page.textContent('#crp-zoom-val'), /^Fit \(\d+%\)$/);
  await page.keyboard.press('Equal');
  assert.doesNotMatch(await page.textContent('#crp-zoom-val'), /Fit/);
  await page.keyboard.press('0');
  assert.match(await page.textContent('#crp-zoom-val'), /^Fit/);
  // The keyboard alone: Tab from the editor reaches the zoom buttons, and Enter presses them.
  await type('#crp-x', '10'); await type('#crp-y', '20'); await type('#crp-w', '30'); await type('#crp-h', '40');

  // ---------- Turning and mirroring ----------
  await page.click('#crp-rotate');
  // Turned clockwise the picture is 200 x 300; the box (10,20 30x40) turns with it.
  assert.equal(await fields(), '140,10,40,30');
  p = await png();
  assert.deepEqual([p.w, p.h], [40, 30]);
  // Clockwise: turned (x, y) shows source (y, 200 - 1 - x).
  checkGrid(p, null, (i, j) => [10 + j, 199 - (140 + i)], 'turned');
  await page.click('#crp-flip-h');
  assert.equal(await fields(), '20,10,40,30');
  p = await png();
  checkGrid(p, null, (i, j) => [10 + j, 20 + i], 'turned and mirrored');
  await page.click('#crp-flip-v');
  await page.click('#crp-rotate');
  // flip-h, flip-v and a turn: back to a plain half turn plus a turn = three quarter turns of the original, mirrored twice
  const m = await page.evaluate(() => document.querySelector('#crp-info').textContent);
  assert.match(m, /^Crop \d+ × \d+ px/);
  // Both mirrors make a half turn, so with the two turns so far the picture is upright again;
  // two more turns make a half turn.
  assert.match(await info(), / at \d+, \d+\./);
  await page.click('#crp-rotate'); await page.click('#crp-rotate');
  await type('#crp-x', '0'); await type('#crp-y', '0'); await type('#crp-w', '300'); await type('#crp-h', '200');
  p = await png();
  checkGrid(p, null, (i, j) => [299 - i, 199 - j], 'half turn');
  await page.click('#crp-rotate'); await page.click('#crp-rotate');
  p = await png();
  checkGrid(p, null, (i, j) => [i, j], 'back upright');
  // A turn belongs to the pictures it was made for: the next picture opened starts upright.
  await page.click('#crp-rotate');
  await openFile('small.png');
  assert.equal(await fields(), '15,10,120,80', 'small.png (150 × 100) is shown as it is, not turned');
  await openFile('grid.png');

  // ---------- Output size, DPI and format ----------
  await type('#crp-w', '200'); await type('#crp-h', '100'); await type('#crp-x', '30'); await type('#crp-y', '40');
  assert.equal(await fields(), '30,40,200,100');
  await page.selectOption('#crp-size', 'set');
  assert.equal(await page.inputValue('#crp-ow'), '200');
  assert.equal(await page.inputValue('#crp-oh'), '100');
  await type('#crp-ow', '100');
  assert.equal(await page.inputValue('#crp-oh'), '50');
  await type('#crp-dpi', '0');
  assert.deepEqual(await errOf('#crp-dpi'), { invalid: 'true', msg: 'Enter the DPI as a whole number from 1 to 65,535, such as 300, or leave it empty.' });
  await type('#crp-dpi', '300');
  p = await png();
  assert.deepEqual([p.w, p.h], [100, 50]);
  assert.deepEqual(p.phys, { x: 11811, y: 11811, unit: 1 }, '300 dpi is 11,811 pixels per metre');
  // Halved: each output pixel averages a 2 x 2 block, so R and G sit half a step past the block start.
  const c = p.px(10, 10);
  assert.ok(near(c, [30 + 20 + 0.5, 40 + 20 + 0.5, 60, 255], 2), `halved pixel ${c}`);
  await type('#crp-ow', '400');
  // The summary follows after a short pause in typing.
  await page.waitForFunction(() => /enlarged and may look soft/.test(document.querySelector('#crp-out-hint').textContent));
  assert.equal(await page.textContent('#crp-out-hint'), 'The crop covers 200 × 100 px of your picture, so it is enlarged and may look soft.');
  assert.equal(await info(), 'Crop 200 × 100 px (2:1) at 30, 40. Saves as a 400 × 200 px PNG.');
  await type('#crp-ow', '20000');
  assert.equal((await errOf('#crp-ow')).msg, 'The output can be at most 16,384 pixels a side and 100 megapixels.');
  await page.selectOption('#crp-size', 'crop');
  assert.deepEqual(await errOf('#crp-ow'), { invalid: null, msg: '' });
  await type('#crp-dpi', '');
  await type('#crp-x', '0'); await type('#crp-y', '0');
  await page.selectOption('#crp-format', 'jpeg');
  assert.equal(await page.textContent('#crp-download'), 'Download JPG');
  assert.equal(await page.isVisible('#crp-q-field'), true);
  let d = await download();
  assert.equal(d.name, 'grid-cropped.jpg');
  let px = await pixels(d.buf, [[5, 5], [100, 50]]);
  assert.ok(near(px.px[0], [255, 255, 255, 255], 3), `transparent corner turns white in a JPG: ${px.px[0]}`);
  assert.ok(near(px.px[1], [100, 50, 60, 255], 12), `JPG colour ${px.px[1]}`);
  await page.selectOption('#crp-format', 'webp');
  d = await download();
  assert.equal(d.name, 'grid-cropped.webp');
  assert.equal(d.buf.toString('latin1', 8, 12), 'WEBP');
  // A WebP has no DPI field (and grid.png no camera details to hold one): the page says so.
  await type('#crp-dpi', '300');
  await page.waitForFunction(() => /WebP files have no DPI setting, so the DPI is not saved\./.test(document.querySelector('#crp-out-hint').textContent), null, { timeout: 5000 });
  await type('#crp-dpi', '');
  await page.selectOption('#crp-format', 'same');

  // ---------- A JPEG photo: upright, same quality, no GPS ----------
  await openFile('photo.jpg');
  assert.match(await page.textContent('#crp-drop-hint'), /^80 × 120 px JPG/);
  assert.match(await page.textContent('#crp-note'), /rotation tag was applied/);
  await type('#crp-x', '0'); await type('#crp-y', '0'); await type('#crp-w', '80'); await type('#crp-h', '120');
  assert.equal(await page.textContent('#crp-q-out'), '77 (as the original)');
  assert.equal(await page.isVisible('#crp-exif'), true);
  d = await download();
  assert.equal(d.name, 'photo-cropped.jpg');
  let ji = jpegInfo(d.buf);
  assert.deepEqual(ji.luma, expected.q77_luma_dqt, 'saved at the quality of the original (77)');
  assert.equal(ji.exif[0x010f], 'TestCam', 'camera make kept');
  assert.equal(ji.exif[0x0112] || 1, 1, 'orientation reset, the pixels are upright');
  assert.equal(ji.exif[0x8825], undefined, 'no GPS block');
  const up = expected.photo_upright;
  px = await pixels(d.buf, [[20, 30], [60, 30], [20, 90], [60, 90]]);
  assert.deepEqual([px.w, px.h], up.size);
  ['top_left', 'top_right', 'bottom_left', 'bottom_right'].forEach((k, i) => assert.ok(near(px.px[i], up[k].concat(255), 10), `${k}: ${px.px[i]} vs ${up[k]}`));
  await page.uncheck('#crp-exif');
  d = await download();
  assert.equal(jpegInfo(d.buf).exif, null, 'no EXIF at all once unticked');
  await page.check('#crp-exif');
  // The quality slider, once moved, applies.
  await page.$eval('#crp-quality', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.textContent('#crp-q-out'), '50');
  d = await download();
  assert.notDeepEqual(jpegInfo(d.buf).luma, expected.q77_luma_dqt);
  assert.equal(jpegInfo(d.buf).luma[0], 16, 'quality 50 is the plain IJG table');

  // ---------- An animated GIF keeps its first frame and stays a GIF ----------
  await openFile('anim.gif');
  assert.match(await page.textContent('#crp-note'), /animated: only its first frame/);
  d = await download();
  assert.equal(d.name, 'anim-cropped.gif');
  assert.equal(d.buf.toString('latin1', 0, 6), 'GIF89a');
  px = await pixels(d.buf, [[5, 5]]);
  assert.deepEqual(px.px[0], [255, 0, 0, 255]);
  assert.deepEqual([px.w, px.h], [32, 24]);

  // ---------- SVG stays a vector ----------
  await openFile('logo.svg');
  assert.match(await page.textContent('#crp-drop-hint'), /^200 × 100 px SVG/);
  await type('#crp-x', '20'); await type('#crp-y', '10'); await type('#crp-w', '100'); await type('#crp-h', '80');
  assert.equal(await page.textContent('#crp-download'), 'Download SVG');
  d = await download();
  assert.equal(d.name, 'logo-cropped.svg');
  const svg = d.buf.toString('utf8');
  assert.match(svg, /^<svg [^>]*viewBox="20 10 100 80"/);
  assert.match(svg, /width="100" height="80"/);
  assert.match(svg, /<circle cx="25" cy="25" r="10" fill="#00ff00"\/>/, 'the drawing itself is untouched');
  // Drawn: output (i, j) is image pixel (20 + i, 10 + j). In image pixels the red half is x < 100,
  // the blue half x >= 100, and the green disc has its centre at 50, 50 and a radius of 20.
  const rendered = await page.evaluate(async text => {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: 100, height: 80 }), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return [[5, 5], [30, 40], [85, 40], [60, 40]].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, svg);
  assert.deepEqual(rendered[0], [255, 0, 0, 255], 'red left half');
  assert.deepEqual(rendered[1], [0, 255, 0, 255], 'disc centre at image 50, 50');
  assert.deepEqual(rendered[2], [0, 0, 255, 255], 'blue right half');
  assert.deepEqual(rendered[3], [255, 0, 0, 255], 'red, 30 px right of the disc centre');
  await page.selectOption('#crp-format', 'png');
  await page.selectOption('#crp-size', 'set');
  await type('#crp-ow', '400');
  assert.equal(await page.inputValue('#crp-oh'), '320');
  assert.doesNotMatch(await page.textContent('#crp-out-hint'), /enlarged/, 'an SVG is drawn at any size');
  p = await png();
  assert.deepEqual([p.w, p.h], [400, 320]);
  // At 4x the disc centre is at 120, 160 and its radius is 80 output pixels.
  assert.deepEqual(p.px(120, 160), [0, 255, 0, 255], 'disc centre, drawn sharp at 4x');
  assert.deepEqual(p.px(120, 160 - 76), [0, 255, 0, 255], 'inside the disc, 4 px from its edge');
  assert.deepEqual(p.px(120, 160 - 84), [255, 0, 0, 255], 'outside the disc, 4 px from its edge');
  await page.selectOption('#crp-size', 'crop');
  await page.selectOption('#crp-format', 'same');

  // ---------- Batch: the same relative crop for each picture, in one ZIP ----------
  await openFile(['grid.png', 'small.png'], 'grid.png and 1 more');
  assert.equal(await page.isVisible('#crp-zip'), true);
  assert.match(await page.textContent('#crp-batch-text'), /^The box is applied to all 2 images/);
  await type('#crp-x', '60'); await type('#crp-y', '40'); await type('#crp-w', '120'); await type('#crp-h', '80');
  d = await download('#crp-zip');
  assert.equal(d.name, 'cropped-images.zip');
  const zip = unzip(d.buf);
  assert.deepEqual(Object.keys(zip).sort(), ['grid-cropped.png', 'small-cropped.png']);
  checkGrid(decodePng(zip['grid-cropped.png'], assert), null, (i, j) => [60 + i, 40 + j], 'zip: first');
  const sp = decodePng(zip['small-cropped.png'], assert);
  assert.deepEqual([sp.w, sp.h], [60, 40], 'half the size at the same relative place');
  checkGrid(sp, null, (i, j) => [30 + i, 20 + j], 'zip: second');
  assert.match(await page.textContent('#crp-status'), /^Saved cropped-images\.zip: 2 images/);

  // ---------- Copy puts a PNG of the crop on the clipboard ----------
  await page.click('#crp-copy');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#crp-status').textContent) || document.querySelector('#crp-error').textContent);
  assert.equal(await page.textContent('#crp-status'), 'Copied a 120 × 80 px PNG. Paste it into any app that takes pictures.');
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const bm = await createImageBitmap(await items[0].getType('image/png'));
    const c = Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height }), g = c.getContext('2d');
    g.drawImage(bm, 0, 0);
    return { size: [bm.width, bm.height], px: Array.from(g.getImageData(0, 0, 1, 1).data) };
  });
  assert.deepEqual(clip, { size: [120, 80], px: gridAt(60, 40) });

  // ---------- ZIP entries: dates, names, and settings changed while it is made ----------
  // Dropped Files carry a set modified time (setInputFiles cannot set one).
  const taken = new Date(2021, 2, 4, 5, 6, 8).getTime(), longName = 'a'.repeat(119) + '😀😀.png';
  await page.evaluate(list => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), c => c.charCodeAt(0))], f.name, { type: f.type, lastModified: f.time }));
    document.querySelector('#crp-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [['grid.png', 'grid.png', 'image/png'], ['photo.jpg', 'photo.jpg', 'image/jpeg'], ['small.png', longName, 'image/png']]
    .map(([file, name, type]) => ({ name, type, time: taken, b64: fs.readFileSync(path.join(fixtures, file)).toString('base64') })));
  await page.waitForFunction(() => document.querySelector('#crp-drop-title').textContent === 'grid.png and 2 more');
  // grid.png has no EXIF, but the JPG after it has: the choice is offered for the batch.
  assert.equal(await page.isVisible('#crp-exif'), true, 'the EXIF box shows for a batch whose first picture has none');
  const age = t => Math.abs(Date.now() - new Date(t[0], t[1] - 1, t[2], t[3], t[4], t[5]).getTime());
  d = await download('#crp-zip');
  let dates = zipDates(d.buf);
  assert.deepEqual(Object.keys(dates), ['grid-cropped.png', 'photo-cropped.jpg', 'a'.repeat(119) + '😀-cropped.png'], 'a long name is cut between characters, not inside the emoji');
  assert.deepEqual(dates['photo-cropped.jpg'], [2021, 3, 4, 5, 6, 8], 'the JPG keeps its EXIF, so its entry keeps the file’s date');
  assert.ok(age(dates['grid-cropped.png']) < 120e3, `a picture without EXIF is dated now: ${dates['grid-cropped.png']}`);
  await page.uncheck('#crp-exif');
  dates = zipDates((await download('#crp-zip')).buf);
  assert.ok(age(dates['photo-cropped.jpg']) < 120e3, `without its EXIF the JPG is dated now: ${dates['photo-cropped.jpg']}`);
  await page.check('#crp-exif');
  // Turning the picture while the ZIP is made would mix two crops in it: it stops instead.
  // The second picture's decoding waits until the turn is made.
  await page.evaluate(() => {
    const real = TTImage.decode;
    window.zipGate = new Promise(r => { window.openZipGate = r; });
    TTImage.decode = async function () { await window.zipGate; TTImage.decode = real; return real.apply(this, arguments); };
  });
  let zipSaves = 0;
  const onZipSave = () => zipSaves++;
  page.on('download', onZipSave);
  await page.click('#crp-zip');
  await page.waitForFunction(() => document.querySelector('#crp-status').textContent === 'Cropping image 2 of 3…');
  await page.click('#crp-rotate');
  await page.evaluate(() => window.openZipGate());
  await page.waitForFunction(() => document.querySelector('#crp-error').textContent || /^Saved/.test(document.querySelector('#crp-status').textContent));
  page.off('download', onZipSave);
  assert.equal(await page.textContent('#crp-error'), 'The settings changed while the ZIP file was being made, so it was not saved. Choose Download all (ZIP) again.');
  assert.equal(zipSaves, 0, 'no ZIP is saved');
  for (let i = 0; i < 3; i++) await page.click('#crp-rotate');

  // ---------- Files that cannot be cropped ----------
  await page.setInputFiles('#crp-file', { name: 'oops.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') });
  await page.waitForFunction(() => document.querySelector('#crp-error').textContent.length > 0);
  assert.match(await page.textContent('#crp-error'), /not a supported image/);
  await page.setInputFiles('#crp-file', { name: 'IMG_0001.CR2', mimeType: 'image/x-canon-cr2', buffer: Buffer.from('II*\0 fake raw') });
  await page.waitForFunction(() => /RAW/.test(document.querySelector('#crp-error').textContent));
  assert.equal(await page.textContent('#crp-error'), 'IMG_0001.CR2 is a camera RAW file, which is not supported. Export it as a JPG or TIFF from your photo app first.');
  assert.match(await page.textContent('#crp-drop-title'), /^grid\.png/, 'the pictures already open stay');
  assert.equal(await page.getAttribute('#crp-file', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#crp-file', 'aria-describedby'), 'crp-error');

  // ---------- Files the decoder warns about ----------
  // A PNG damaged half way (from the image converter's fixtures) and a Display P3 JPG.
  const otherFile = (dir, n, type) => ({ name: n, mimeType: type, buffer: fs.readFileSync(path.join(fixtures, '..', dir, n)) });
  await page.setInputFiles('#crp-file', otherFile('image-converter', 'damaged.png', 'image/png'));
  await page.waitForFunction(() => /^damaged\.png/.test(document.querySelector('#crp-drop-title').textContent));
  assert.match(await page.textContent('#crp-note'), /The file seems to be damaged, so part of the picture may be blank\./);
  await page.setInputFiles('#crp-file', otherFile('jpg-to-png', 'p3.jpg', 'image/jpeg'));
  await page.waitForFunction(() => /^p3\.jpg/.test(document.querySelector('#crp-drop-title').textContent));
  assert.match(await page.textContent('#crp-note'), /Colours were converted to sRGB from the picture’s wide-gamut profile\./);

  // ---------- A print size on a portrait photo turns with it, also when chosen before it was opened ----------
  const outSize = async () => [await page.inputValue('#crp-ow'), await page.inputValue('#crp-oh'), await page.inputValue('#crp-dpi')];
  await page.selectOption('#crp-preset', 'print-4x6');
  assert.deepEqual(await outSize(), ['1800', '1200', '300'], 'the square p3.jpg gets the landscape print');
  await openFile('photo.jpg');
  assert.equal(await page.getAttribute('#crp-file', 'aria-invalid'), null);
  assert.equal(await page.inputValue('#crp-preset'), 'print-4x6');
  assert.deepEqual(await outSize(), ['1200', '1800', '300'], 'the print turns for the portrait photo opened next');
  assert.equal(await fields(), '0,0,80,120', 'the largest 2:3 box');
  assert.equal(await info(), 'Crop 80 × 120 px (2:3) at 0, 0. Saves as a 1200 × 1800 px JPG.');
  d = await download();
  px = await pixels(d.buf, [[300, 450]]);
  assert.deepEqual([px.w, px.h], [1200, 1800]);
  assert.ok(near(px.px[0], expected.photo_upright.top_left.concat(255), 12), `scaled crop keeps the colours: ${px.px[0]}`);
  // pHYs/JFIF: 300 dpi in the JFIF header (units 1 = dots per inch)
  const jfif = d.buf.indexOf(Buffer.from('JFIF\0'));
  assert.ok(jfif > 0 && d.buf[jfif + 7] === 1 && d.buf.readUInt16BE(jfif + 8) === 300 && d.buf.readUInt16BE(jfif + 10) === 300, '300 dpi recorded');
  // The camera details kept say 300 dpi too: photo.jpg's EXIF says 72, which some programs read first.
  const res = jpegInfo(d.buf).exif;
  assert.deepEqual([res[0x011a], res[0x011b], res[0x0128]], [[300, 1], [300, 1], 2], 'the EXIF resolution follows the DPI');
  // Instagram's tallest post: 3:4, 1080 x 1440.
  await page.selectOption('#crp-preset', 'ig-tall');
  assert.deepEqual([await page.inputValue('#crp-ratio'), await page.inputValue('#crp-custom'), ...(await outSize()).slice(0, 2)], ['custom', '3:4', '1080', '1440']);
  assert.equal(await fields(), '0,7,80,107', 'the largest 3:4 box');

  // ---------- The keyboard alone ----------
  await page.selectOption('#crp-preset', 'none');
  await page.selectOption('#crp-size', 'crop');
  await type('#crp-dpi', '');
  await page.focus('#crp-editor');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'crp-zoom-in', 'Tab goes from the picture to the zoom buttons');
  await page.keyboard.press('Enter');
  assert.doesNotMatch(await page.textContent('#crp-zoom-val'), /Fit/);
  await page.focus('#crp-download');
  const [kd] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(kd.suggestedFilename(), 'photo-cropped.jpg');
  // A double click saves one file.
  let saves = 0;
  const onSave = () => saves++;
  page.on('download', onSave);
  await page.dblclick('#crp-download');
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('#crp-status').textContent));
  await page.waitForTimeout(1000);
  page.off('download', onSave);
  assert.equal(saves, 1, 'a double click downloads once');

  // ---------- Back to the page: menus the browser restores after the script ran are read again ----------
  await page.evaluate(() => {
    document.querySelector('#crp-ratio').value = '1:1';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const sq = (await fields()).split(',').map(Number);
  assert.equal(sq[2], sq[3], `pageshow applies the restored 1:1 ratio: ${sq}`);
  assert.match(await info(), /\(1:1\)/);
  // A page the back-forward cache kept whole keeps the box the user made: it has the ratio already.
  await type('#crp-w', '20'); await type('#crp-x', '3'); await type('#crp-y', '4');
  assert.equal(await fields(), '3,4,20,20');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await fields(), '3,4,20,20', 'Back does not make the box as large as it can be');

  // ---------- A phone: drag a handle with a finger, pinch to zoom ----------
  const ctx = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.waitForFunction(() => document.querySelector('#crp-x').value === '120');
  await phone.locator('#crp-editor').scrollIntoViewIfNeeded();
  const pc = await ctx.newCDPSession(phone);
  const g = await phone.evaluate(() => {
    const e = document.querySelector('#crp-editor'), r = e.getBoundingClientRect();
    return { x: r.left + e.clientLeft, y: r.top + e.clientTop, w: e.clientWidth, h: e.clientHeight };
  });
  const sc = Math.min((g.w - 28) / 1200, (g.h - 28) / 800);
  const P = (x, y) => ({ x: g.x + g.w / 2 + (x - 600) * sc, y: g.y + g.h / 2 + (y - 400) * sc });
  const touch = (type, pts) => pc.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q.x, y: q.y, id: i })) });
  const from = P(1080, 720), to = P(980, 620);
  await touch('touchStart', [from]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6 }]);
  await touch('touchEnd', []);
  const pf = (await phone.evaluate(() => ['x', 'y', 'w', 'h'].map(k => document.querySelector('#crp-' + k).value))).map(Number);
  assert.deepEqual(pf.slice(0, 2), [120, 80], 'the opposite corner stays');
  assert.ok(Math.abs(pf[2] - 860) <= 8 && Math.abs(pf[3] - 540) <= 8, `the south-east handle followed the finger: ${pf}`);
  const mid = P(600, 400);
  await touch('touchStart', [{ x: mid.x - 20, y: mid.y }, { x: mid.x + 20, y: mid.y }]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: mid.x - 20 - 12 * i, y: mid.y }, { x: mid.x + 20 + 12 * i, y: mid.y }]);
  await touch('touchEnd', []);
  assert.doesNotMatch(await phone.textContent('#crp-zoom-val'), /Fit/, 'a pinch zooms in');
  const after = (await phone.evaluate(() => ['x', 'y', 'w', 'h'].map(k => document.querySelector('#crp-' + k).value))).map(Number);
  assert.deepEqual(after, pf, 'a pinch does not move the box');
  const small = await phone.$$eval('.crp-bar .btn', l => Math.min(...l.map(b => b.getBoundingClientRect().height)));
  assert.ok(small >= 44, `buttons are at least 44 px tall on a touch screen: ${small}`);
  // No menu cuts off the option it shows, at any phone or tablet width: each menu is at least as
  // wide as a copy of it holding only that option, at its natural width. With a JPG open, the
  // format menu says "Original format (JPG)" beside the quality slider.
  await phone.setInputFiles('#crp-file', path.join(fixtures, 'photo.jpg'));
  await phone.waitForFunction(() => document.querySelector('#crp-drop-title').textContent === 'photo.jpg');
  await phone.selectOption('#crp-size', 'set');
  const cut = [];
  for (let w = 320; w <= 760; w += 8) {
    await phone.setViewportSize({ width: w, height: 800 });
    cut.push(...await phone.evaluate(w => {
      const out = [];
      for (const s of document.querySelectorAll('.tool-card select')) {
        if (!s.offsetParent) continue;
        for (const o of s.options) {
          if (o.disabled) continue;
          const c = s.cloneNode(false);
          c.removeAttribute('id');
          c.appendChild(o.cloneNode(true));
          c.style.cssText = 'width: auto !important; position: absolute; visibility: hidden';
          s.parentNode.appendChild(c);
          const need = c.getBoundingClientRect().width, have = s.getBoundingClientRect().width;
          c.remove();
          if (need > have + 0.5) out.push(`${w} px: ${s.id} "${o.textContent}" (${Math.round(have)} of ${Math.round(need)} px)`);
        }
      }
      return out;
    }, w));
  }
  assert.deepEqual(cut, [], 'menus that cut off their text');
  await ctx.close();

  // ---------- A picture larger than the browser's canvas (here 1.2 megapixels, as an older iPhone has 16.7) ----------
  // It is cropped from the largest copy that fits, and the summary gives the size actually saved.
  const lctx = await page.context().browser().newContext({ acceptDownloads: true });
  await lctx.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    // Like Safari: a 2D canvas over the limit draws nothing and reads back transparent.
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type !== '2d' || this.width * this.height <= 1.2e6) return real.call(this, type, options);
      return real.call(Object.assign(document.createElement('canvas'), { width: 1, height: 1 }), type, options);
    };
  });
  const lp = await lctx.newPage();
  await lp.goto(url);
  await lp.setInputFiles('#crp-file', path.join(fixtures, 'big.png'));
  await lp.waitForFunction(() => document.querySelector('#crp-drop-title').textContent === 'big.png', null, { timeout: 60000 });
  assert.equal(await lp.textContent('#crp-note'), 'This picture (1,600 × 1,000 px) is larger than this browser can edit at full size, so it is cropped from a 1,264 × 790 px copy.');
  assert.equal(await lp.textContent('#crp-info'), 'Crop 1280 × 800 px (8:5) at 160, 100. Saves as a 1011 × 632 px PNG.', 'the size of the copy’s crop, not of the full picture');
  assert.equal(await lp.textContent('#crp-out-hint'), 'Saved from a 1264 × 790 px copy, the largest this browser can hold.', 'nothing is enlarged');
  const [bdl] = await Promise.all([lp.waitForEvent('download'), lp.click('#crp-download')]);
  const bp = decodePng(fs.readFileSync(await bdl.path()), assert);
  assert.deepEqual([bp.w, bp.h], [1011, 632]);
  // The quadrants of big.png meet at 800, 500: here at (800 - 160) * 0.79 = 506 and (500 - 100) * 0.79 = 316.
  assert.deepEqual([bp.px(250, 150), bp.px(760, 150), bp.px(250, 480), bp.px(760, 480)], [[230, 30, 30, 255], [30, 200, 40, 255], [30, 60, 220, 255], [240, 220, 20, 255]]);
  assert.match(await lp.textContent('#crp-status'), /^Saved big-cropped\.png: 1011 × 632 px, [\d.]+ KB\. It was made from a smaller copy/);
  await lctx.close();
};
