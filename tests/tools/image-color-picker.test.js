const fs = require('fs');
const path = require('path');

// Expected codes, averages and palettes come from tests/fixtures/image-color-picker/make_fixtures.py
// (exact fractions rounded half up; the Display P3 conversion from littleCMS), never from this page.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const text = (sel, pg = page) => pg.textContent(sel);
  const MIME = { png: 'image/png', jpg: 'image/jpeg' };
  async function load(name, pg = page) {
    await pg.setInputFiles('#icp-file', { name, mimeType: MIME[name.split('.').pop()], buffer: fs.readFileSync(path.join(fixtures, name)) });
    await pg.waitForFunction(n => document.querySelector('#icp-name').textContent === n, name);
    await pg.waitForFunction(() => !/Working out/.test(document.querySelector('#icp-pal-note').textContent));
  }
  // The screen position of the centre of image pixel (x, y) in a w x h image.
  async function spot(x, y, w, h, pg = page) {
    await pg.locator('#icp-canvas').scrollIntoViewIfNeeded();
    const r = await pg.locator('#icp-canvas').boundingBox();
    return { x: r.x + (x + 0.5) * r.width / w, y: r.y + (y + 0.5) * r.height / h };
  }
  async function clickPixel(x, y, w, h) {
    const p = await spot(x, y, w, h);
    await page.mouse.click(p.x, p.y);
  }
  const readout = async (pg = page) => ({
    hex: await text('#icp-hex', pg), rgbText: await text('#icp-rgb', pg), hsl: await text('#icp-hsl', pg),
    hsb: await text('#icp-hsb', pg), cmyk: await text('#icp-cmyk', pg),
  });
  const want = e => ({ hex: e.hex, rgbText: e.rgbText, hsl: e.hsl, hsb: e.hsb, cmyk: e.cmyk });
  const chips = () => page.$$eval('#icp-history .icp-chip', els => els.map(e => e.textContent));
  const pal = () => page.$$eval('#icp-palette .icp-pal', els => els.map(e => [e.querySelector('b').textContent, e.lastChild.textContent]));
  const clip = () => page.evaluate(() => navigator.clipboard.readText());

  await open();

  // ---------- The sample picture: the sun's colour is shown and a palette is ready ----------
  assert.equal(await text('#icp-big'), '#FFD166');
  assert.equal(await text('#icp-where'), 'x 640, y 300');
  await page.waitForFunction(() => document.querySelectorAll('#icp-palette .icp-pal').length === 6);
  assert.deepEqual(await chips(), [], 'the sample does not fill the history');
  assert.equal(await page.isVisible('#icp-hist-empty'), true);
  // Back and forward: the palette matches the number of colours the select shows, even when the
  // browser puts back the select's value after the page's script ran.
  await page.selectOption('#icp-count', '8');
  assert.equal((await pal()).length, 8);
  await page.goto('about:blank');
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll('#icp-palette .icp-pal').length > 0);
  await page.waitForTimeout(200);
  assert.equal((await pal()).length, Number(await page.inputValue('#icp-count')));
  await page.selectOption('#icp-count', '6');

  // ---------- Every format, for twelve colours, against exact fractions ----------
  await load('swatches.png');
  assert.match(await text('#icp-info'), /^120 × 10 px, PNG\./);
  for (let i = 0; i < exp.swatches.length; i++) {
    await clickPixel(i * 10 + 5, 5, 120, 10);
    assert.deepEqual(await readout(), want(exp.swatches[i]), `swatch ${i} ${exp.swatches[i].hex}`);
    assert.equal(await text('#icp-where'), `x ${i * 10 + 5}, y 5`);
  }
  assert.equal(await text('#icp-live'), `${exp.swatches[11].hex} picked at x 115, y 5.`);
  // History: newest first, no repeat when the same colour is picked twice in a row.
  const hexes = exp.swatches.map(s => s.hex).reverse();
  assert.deepEqual(await chips(), hexes);
  await clickPixel(116, 6, 120, 10);
  assert.equal((await chips()).length, 12);
  await page.click('#icp-hist-copy');
  assert.equal(await clip(), hexes.join(', '));
  await page.locator('#icp-history .icp-chip').nth(2).click();
  assert.equal(await text('#icp-big'), hexes[2]);
  assert.equal(await text('#icp-where'), 'From your picked colours');
  assert.equal((await chips()).length, 12, 'showing a picked colour does not add it again');
  // Each Copy button copies its own value.
  for (const k of ['HEX', 'RGB', 'HSL', 'HSB', 'CMYK']) {
    await page.click(`button[aria-label="Copy ${k}"]`);
    assert.equal(await clip(), await text('#icp-' + k.toLowerCase()), k);
  }

  // ---------- Keyboard: arrows move one pixel (ten with Shift), Enter and Space pick ----------
  await clickPixel(115, 5, 120, 10);
  await page.focus('#icp-canvas');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await page.isVisible('#icp-loupe'), true, 'the magnifier follows the keys');
  assert.equal(await text('#icp-loupe-hex'), '#336699');
  await page.keyboard.press('Enter');
  assert.equal(await text('#icp-hex'), '#336699');
  assert.equal(await text('#icp-live'), '#336699 picked at x 105, y 5.');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Space');
  assert.equal(await text('#icp-hex'), '#C86432');
  for (let i = 0; i < 15; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await text('#icp-where'), 'x 0, y 4', 'stops at the edge');
  assert.equal(await text('#icp-hex'), '#000000');
  // After a pause the position and colour under the keyboard cursor are announced.
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#icp-live').textContent === 'x 1, y 4: #000000');

  // ---------- The magnifier under the mouse shows the real pixels ----------
  // x 29 is the last red pixel: the centre cell is red, the next one grey, the first (x 24) red.
  const p = await spot(29, 5, 120, 10);
  await page.mouse.move(p.x, p.y);
  assert.equal(await page.isVisible('#icp-loupe'), true);
  assert.equal(await text('#icp-loupe-hex'), '#FF0000');
  const lc = await page.evaluate(() => {
    const c = document.querySelector('#icp-loupe-cv'), g = c.getContext('2d'), cell = i => Math.floor((i + 0.5) * c.width / 11);
    return [5, 6, 0].map(i => Array.from(g.getImageData(cell(i), cell(5), 1, 1).data));
  });
  assert.deepEqual(lc, [[255, 0, 0, 255], [127, 127, 127, 255], [255, 0, 0, 255]], 'magnifier cells');
  await page.mouse.move(5, 5);
  assert.equal(await page.isVisible('#icp-loupe'), false, 'hidden when the mouse leaves');

  // ---------- Averages: 3 x 3 and 5 x 5, clipped at the edges ----------
  await load('checker.png');
  for (const key of Object.keys(exp.checker)) {
    const [x, y, n] = key.split(',').map(Number);
    await page.selectOption('#icp-size', String(n));
    await clickPixel(x, y, 20, 20);
    assert.deepEqual(await readout(), want(exp.checker[key]), `average ${key}`);
    if (n > 1) assert.equal(await text('#icp-where'), `x ${x}, y ${y}, ${n} × ${n} average`);
  }
  // Changing the sample size updates the colour already picked.
  await page.selectOption('#icp-size', '1');
  await clickPixel(5, 5, 20, 20);
  assert.equal(await text('#icp-hex'), '#000000');
  await page.selectOption('#icp-size', '3');
  assert.equal(await text('#icp-hex'), exp.checker['5,5,3'].hex);
  await page.selectOption('#icp-size', '1');

  // ---------- Palette: exact colours and shares of a flat image ----------
  await load('blocks.png');
  assert.deepEqual(await pal(), exp.blocks);
  assert.equal(await text('#icp-pal-note'), 'This image has only 4 distinct colours.');
  assert.equal(await page.isVisible('#icp-mode-field'), false, 'no profile, no choice of values');
  await page.click('#icp-pal-copy');
  assert.equal(await clip(), exp.blocks.map(b => b[0]).join(', '));
  await page.locator('#icp-palette .icp-pal').nth(1).click();
  assert.equal(await text('#icp-big'), '#F0C800');
  assert.equal(await text('#icp-where'), 'From the palette');
  assert.equal((await chips())[0], '#F0C800');
  // Fewer colours than the image has: close shades are merged into their group's average.
  await load('merge.png');
  await page.selectOption('#icp-count', '5');
  assert.deepEqual(await pal(), exp.merge);
  assert.equal(await text('#icp-pal-note'), '');
  await page.selectOption('#icp-count', '10');
  assert.equal((await pal()).length, 7);
  assert.equal(await text('#icp-pal-note'), 'This image has only 7 distinct colours.');
  await page.selectOption('#icp-count', '6');

  // ---------- Transparency: opacity in the codes, weighted averages, left out of the palette ----------
  await load('alpha.png');
  await clickPixel(5, 5, 20, 10);
  assert.deepEqual(await readout(), want(exp.alpha));
  await clickPixel(15, 5, 20, 10);
  assert.deepEqual(await readout(), want(exp.transparent));
  for (const key of Object.keys(exp.alpha_avg)) {
    const [x, y, n] = key.split(',').map(Number);
    await page.selectOption('#icp-size', String(n));
    await clickPixel(x, y, 20, 10);
    assert.deepEqual(await readout(), want(exp.alpha_avg[key]), `alpha average ${key}`);
  }
  await page.selectOption('#icp-size', '1');
  assert.deepEqual(await pal(), [['#FF0000', '100%']]);
  assert.equal(await text('#icp-pal-note'), 'This image has only 1 colour.');
  await load('clear.png');
  assert.deepEqual(await pal(), []);
  assert.equal(await text('#icp-pal-note'), 'No palette: every pixel of this image is more than half transparent.');
  assert.equal(await page.isDisabled('#icp-pal-copy'), true);

  // ---------- A file that is not an image leaves the current one in place ----------
  await page.setInputFiles('#icp-file', { name: 'oops.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') });
  await page.waitForFunction(() => document.querySelector('#icp-error').textContent.length > 0);
  assert.match(await text('#icp-error'), /^“oops\.png” could not be opened\./);
  assert.equal(await text('#icp-name'), 'clear.png');

  // ---------- An embedded colour profile: converted values, or the numbers stored in the file ----------
  await load('p3.png');
  assert.equal(await page.textContent('#icp-error'), '', 'a good file clears the error');
  assert.match(await text('#icp-info'), /^30 × 20 px, PNG, Display P3 \(test\) profile\./);
  assert.equal(await page.isVisible('#icp-mode-field'), true);
  for (let i = 0; i < 3; i++) {
    await clickPixel(i * 10 + 5, 5, 30, 20);
    const rgb = (await text('#icp-rgb')).match(/\d+/g).map(Number), e = exp.p3.converted[i];
    assert.ok(rgb.every((v, k) => Math.abs(v - e[k]) <= 2), `converted ${rgb} near littleCMS ${e}`);
  }
  await clickPixel(5, 5, 30, 20);
  assert.notEqual(await text('#icp-hex'), exp.p3.stored[0].hex);
  await page.selectOption('#icp-mode', 'raw');
  await page.waitForFunction(h => document.querySelector('#icp-hex').textContent === h, exp.p3.stored[0].hex);
  assert.deepEqual(await readout(), want(exp.p3.stored[0]));
  assert.match(await text('#icp-profile'), /numbers stored in the file/);
  assert.deepEqual((await pal()).map(x => x[0]).sort(), exp.p3.stored.map(s => s.hex).sort());
  await clickPixel(15, 5, 30, 20);
  assert.deepEqual(await readout(), want(exp.p3.stored[1]));
  await page.selectOption('#icp-mode', 'srgb');
  await page.waitForFunction(h => document.querySelector('#icp-hex').textContent !== h, exp.p3.stored[1].hex);
  assert.match(await text('#icp-profile'), /converted to sRGB/);

  // ---------- Dropping or pasting an image anywhere on the page opens it ----------
  const b64 = fs.readFileSync(path.join(fixtures, 'blocks.png')).toString('base64');
  const handled = await page.evaluate(async data => {
    const file = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('h1').dispatchEvent(over);
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('h1').dispatchEvent(drop);
    return [over.defaultPrevented, drop.defaultPrevented];
  }, b64);
  assert.deepEqual(handled, [true, true]);
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'dropped.png');
  await page.evaluate(async data => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'pasted.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'pasted.png');

  // ---------- Too large for the browser to hold: a copy of at most 16 megapixels is read ----------
  await page.evaluate(() => {
    window.realDecode = TTImage.decode;
    TTImage.decode = () => Promise.reject(Object.assign(new Error('The image is too large.'), { code: 'TOO_BIG' }));
  });
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 5000; c.height = 4000;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 2500, 4000);
    g.fillStyle = '#0000ff'; g.fillRect(2500, 0, 2500, 4000);
    const dt = new DataTransfer();
    dt.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'huge.png', { type: 'image/png' }));
    document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'huge.png', null, { timeout: 30000 });
  // sqrt(16 / 20) of each side, rounded down: 4472 x 3577.
  assert.equal(await text('#icp-info'), 'Read at 4472 × 3577 px, scaled down from 5000 × 4000 because the full image is too large for this browser; positions are in the smaller copy.');
  await clickPixel(1000, 1700, 4472, 3577);
  assert.equal(await text('#icp-hex'), '#FF0000');
  await clickPixel(3500, 1700, 4472, 3577);
  assert.equal(await text('#icp-hex'), '#0000FF');
  await page.evaluate(() => { TTImage.decode = window.realDecode; });

  // ---------- Pick from screen, where the browser has an eyedropper ----------
  const ctx = page.context(), p2 = await ctx.newPage();
  await p2.addInitScript(() => { window.EyeDropper = class { open() { return Promise.resolve({ sRGBHex: '#123456' }); } }; });
  await p2.goto(url);
  await p2.click('#icp-screen');
  await p2.waitForFunction(() => document.querySelector('#icp-big').textContent === '#123456');
  assert.equal(await text('#icp-where', p2), 'From your screen');
  assert.equal(await text('#icp-live', p2), '#123456 picked from the screen.');
  await p2.close();
  const p3 = await ctx.newPage();
  await p3.addInitScript(() => { delete window.EyeDropper; });
  await p3.goto(url);
  assert.equal(await p3.isVisible('#icp-screen'), false, 'no button without an eyedropper');
  await p3.close();

  // ---------- A phone: tap to pick, drag with the magnifier above the finger ----------
  const { devices } = require('playwright');
  const ph = await ctx.browser().newContext({ ...devices['Pixel 7'] });
  const pp = await ph.newPage();
  const errs = [];
  pp.on('pageerror', e => errs.push(e.message));
  await pp.goto(url);
  await load('swatches.png', pp);
  const t = await spot(35, 5, 120, 10, pp);
  await pp.touchscreen.tap(t.x, t.y);
  assert.equal(await text('#icp-hex', pp), '#7F7F7F');
  // Touch down on one block, slide to another and lift: the colour under the finger at the end is picked.
  const seen = await pp.evaluate(() => {
    const c = document.querySelector('#icp-canvas'), r = c.getBoundingClientRect(), y = r.top + r.height / 2;
    const at = x => ({ pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + (x + 0.5) * r.width / 120, clientY: y, button: 0, buttons: 1 });
    c.dispatchEvent(new PointerEvent('pointerdown', at(45)));
    c.dispatchEvent(new PointerEvent('pointermove', at(65)));
    const l = document.querySelector('#icp-loupe'), lr = l.getBoundingClientRect();
    const out = { shown: !l.hidden, above: lr.bottom < y, hex: document.querySelector('#icp-loupe-hex').textContent };
    c.dispatchEvent(new PointerEvent('pointerup', Object.assign(at(65), { buttons: 0 })));
    out.after = !l.hidden;
    return out;
  });
  assert.deepEqual(seen, { shown: true, above: true, hex: exp.swatches[6].hex, after: false });
  assert.equal(await text('#icp-hex', pp), exp.swatches[6].hex);
  const small = await pp.$$eval('#icp-choose, .icp-values .btn, #icp-size, #icp-count, #icp-pal-copy, .icp-chip', els => els.filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.className));
  assert.deepEqual(small, []);
  assert.deepEqual(errs, []);
  await ph.close();
};
