const fs = require('fs');
const path = require('path');

// Expected codes, averages and palettes come from tests/fixtures/image-color-picker/make_fixtures.py
// (exact fractions rounded half up; the Display P3 conversion from littleCMS), never from this page.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const text = (sel, pg = page) => pg.textContent(sel);
  const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic' };
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
  // The palette is worked out in a worker; until it is ready the list is marked aria-busy.
  const palReady = (pg = page) => pg.waitForFunction(() => !document.querySelector('#icp-palette').hasAttribute('aria-busy'));
  const pal = async (pg = page) => {
    await palReady(pg);
    return pg.$$eval('#icp-palette .icp-pal', els => els.map(e => [e.querySelector('b').textContent, e.lastChild.textContent]));
  };
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const rgbOf = async () => (await text('#icp-rgb')).match(/\d+/g).slice(0, 3).map(Number);
  const close = (a, b, tol) => a.every((v, k) => Math.abs(v - b[k]) <= tol);

  // Added before the page's own script, so this listener runs first: once the flag is set and the
  // event is over, the page has handled pageshow too.
  await page.addInitScript(() => addEventListener('pageshow', () => { window.__pageshown = true; }));
  await open();
  // Screen readers pass the arrow keys through to the picture only in an application region.
  assert.equal(await page.getAttribute('#icp-canvas', 'role'), 'application');

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
  await page.waitForFunction(() => window.__pageshown && document.querySelectorAll('#icp-palette .icp-pal').length > 0);
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
  // Clear empties the history and says so.
  await page.click('#icp-hist-clear');
  assert.deepEqual(await chips(), []);
  assert.equal(await text('#icp-live'), 'Picked colours cleared.');
  assert.equal(await page.isVisible('#icp-hist-empty'), true);
  assert.equal(await page.isDisabled('#icp-hist-copy'), true);

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
  // k-means moves colours between the groups the cut made (a second implementation gives the answer).
  await load('kmeans.png');
  await page.selectOption('#icp-count', '5');
  assert.deepEqual(await pal(), exp.kmeans);
  await page.selectOption('#icp-count', '6');
  // Shares are rounded half up: 2 of 3 pixels is 67%.
  await load('thirds.png');
  assert.deepEqual(await pal(), exp.thirds);

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
  // Opacity that 2 decimals cannot give back exactly is shown with 3; pixels under half opacity
  // (127 of 255) are left out of the palette.
  await load('edges.png');
  for (let i = 0; i < 3; i++) {
    await clickPixel(i * 10 + 5, 5, 30, 10);
    assert.deepEqual(await readout(), want(exp.edges[i]), `opacity ${exp.edges[i].rgb[3]}`);
  }
  assert.deepEqual(await pal(), exp.edges_palette);
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

  // ---------- Profiles in JPEG and WebP files, an ICC v4 name, and EXIF orientation ----------
  // An sRGB profile is named, but there is nothing to convert, so no choice of values is offered.
  await load('srgb-v4.png');
  assert.match(await text('#icp-info'), /^40 × 20 px, PNG, sRGB built-in profile\./);
  assert.equal(await page.isVisible('#icp-mode-field'), false);
  // Stored turned with EXIF orientation 6: the stored numbers are read at their upright positions.
  await load('p3-o6.jpg');
  assert.match(await text('#icp-info'), /^40 × 20 px, JPG, Display P3 \(test\) profile\./);
  await page.selectOption('#icp-mode', 'raw');
  await page.waitForFunction(() => /numbers stored/.test(document.querySelector('#icp-profile').textContent));
  for (const [x, y, i] of [[1, 1, 2], [10, 10, 0], [30, 10, 1]]) {
    await clickPixel(x, y, 40, 20);
    assert.ok(close(await rgbOf(), exp.upright.stored[i].rgb, 3), `stored ${await rgbOf()} at ${x},${y}`);
  }
  // Orientation 3 cannot be checked for the raw copy, so the page refuses and says so.
  await load('p3-o3.jpg');
  await page.selectOption('#icp-mode', 'raw');
  await page.waitForFunction(() => /cannot be read for this file/.test(document.querySelector('#icp-profile').textContent));
  assert.equal(await page.inputValue('#icp-mode'), 'srgb');
  await clickPixel(30, 10, 40, 20);
  assert.ok(close(await rgbOf(), exp.p3.converted[1], 3), `converted ${await rgbOf()}`);
  await load('p3.webp');
  assert.match(await text('#icp-info'), /^40 × 20 px, WebP, Display P3 \(test\) profile\./);
  await page.selectOption('#icp-mode', 'raw');
  await page.waitForFunction(() => /numbers stored/.test(document.querySelector('#icp-profile').textContent));
  await clickPixel(30, 10, 40, 20);
  assert.deepEqual(await readout(), want(exp.upright.stored[1]));

  // ---------- Files the decoder warns about: the line under the name says what that means ----------
  // cut.jpg ends 40% into its scan data, so its lower part is blank; pq.avif is an HDR AVIF the browser
  // maps to standard range; hdr-pq.heic an HDR HEIC that libheif decodes without tone mapping.
  const AGAIN = ' Drop or paste another image to replace it.';
  await load('cut.jpg');
  assert.equal(await text('#icp-info'), '120 × 90 px, JPG. The file seems to be cut off, so part of the picture may be blank.' + AGAIN);
  // The line under the name is not read out, so the note is announced with the image.
  assert.equal(await text('#icp-live'), 'Opened cut.jpg, 120 by 90 pixels. The file seems to be cut off, so part of the picture may be blank.');
  await load('pq.avif');
  assert.equal(await text('#icp-info'), '128 × 16 px, AVIF. This is an HDR image. The colours are read from the standard-range copy the browser made of it, so they can differ from what an HDR screen shows.' + AGAIN);
  await load('hdr-pq.heic');
  assert.equal(await text('#icp-info'), '240 × 160 px, HEIC. This is an HDR photo. The colours are read from a standard-range copy made without tone mapping, so they can differ from what an HDR screen shows.' + AGAIN);
  await load('p3.webp');
  assert.equal(await text('#icp-info'), '40 × 20 px, WebP, Display P3 (test) profile.' + AGAIN, 'no note for a file the decoder has no warning about');
  assert.equal(await text('#icp-live'), 'Opened p3.webp, 40 by 20 pixels.');

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
  assert.doesNotMatch(await text('#icp-info'), /Only the first/);
  await page.evaluate(async data => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'pasted.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'pasted.png');
  // Several files at once: the first is opened, and the page says that the others were not.
  const several = (names, how) => page.evaluate(async ([data, names, how]) => {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(n.endsWith('.png') ? new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], n, { type: 'image/png' }) : new File(['class list'], n, { type: 'text/plain' }));
    if (how === 'paste') document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    else document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [b64, names, how]);
  await several(['first.png', 'second.png', 'third.png'], 'drop');
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'first.png');
  assert.match(await text('#icp-info'), /^\d+ × \d+ px, PNG\. Only the first of the 3 files was opened\. Drop or paste another image to replace it\.$/);
  assert.match(await text('#icp-live'), /^Opened first\.png, \d+ by \d+ pixels\. Only the first of the 3 files was opened\.$/);
  await several(['one.png', 'two.png'], 'paste');
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'one.png');
  assert.match(await text('#icp-info'), /Only the first of the 2 files was opened\./);
  // When the first is not an image, the error says the others were not tried.
  await several(['names.txt', 'photo.png'], 'drop');
  await page.waitForFunction(() => document.querySelector('#icp-error').textContent.length > 0);
  assert.match(await text('#icp-error'), /^“names\.txt” could not be opened\. .+ Only the first of the 2 files was tried\.$/);
  assert.equal(await text('#icp-name'), 'one.png');

  // ---------- Too large for the browser to hold: a copy of at most 16 megapixels is read ----------
  // A phone browser that cannot read back more than about 16.7 megapixels from a canvas.
  await page.evaluate(() => {
    const real = CanvasRenderingContext2D.prototype.getImageData;
    window.realGetImageData = real;
    CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
      if (w * h > 16.8e6) throw new DOMException('Out of memory', 'RangeError');
      return real.apply(this, arguments);
    };
  });
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 5000; c.height = 4000;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 2500, 4000);
    g.fillStyle = '#0000ff'; g.fillRect(2500, 0, 2500, 4000);
    g.fillStyle = '#00ff00'; g.fillRect(0, 3000, 2500, 1000);
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
  await clickPixel(1000, 3200, 4472, 3577);
  assert.equal(await text('#icp-hex'), '#00FF00', 'the scaled copy is upright');
  await page.evaluate(() => { CanvasRenderingContext2D.prototype.getImageData = window.realGetImageData; });
  // Over this page's own limit of 40 megapixels (8000 x 5300 is 42.4), a copy is read even where the
  // browser could hold more, and the page says why: sqrt(16 / 42.4) of each side, rounded down.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 8000; c.height = 5300;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 4000, 5300);
    g.fillStyle = '#0000ff'; g.fillRect(4000, 0, 4000, 5300);
    const dt = new DataTransfer();
    dt.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'camera.png', { type: 'image/png' }));
    c.width = c.height = 0;
    document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'camera.png', null, { timeout: 60000 });
  assert.equal(await text('#icp-info'), 'Read at 4914 × 3255 px, scaled down from 8000 × 5300, as images over 40 megapixels are read at a smaller size; positions are in the smaller copy.');
  await clickPixel(4000, 100, 4914, 3255);
  assert.equal(await text('#icp-hex'), '#0000FF');

  // ---------- A photo-like image, with a different colour in almost every pixel ----------
  // 262,144 pixels of noise: the palette must not freeze the page (it once took 17 seconds).
  const t0 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d'), im = g.createImageData(512, 512);
    let s = 7;
    for (let i = 0; i < im.data.length; i += 4) {
      for (let k = 0; k < 3; k++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; im.data[i + k] = s >>> 24; }
      im.data[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    const dt = new DataTransfer();
    dt.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'noise.png', { type: 'image/png' }));
    const t = performance.now();
    document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return t;
  });
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'noise.png' && !/Working out/.test(document.querySelector('#icp-pal-note').textContent), null, { timeout: 60000 });
  const took = await page.evaluate(t => performance.now() - t, t0);
  assert.ok(took < 3000, `opening and the palette took ${Math.round(took)} ms`);
  const shares = (await pal()).map(x => parseInt(x[1], 10));
  assert.equal(shares.length, 6);
  assert.ok(Math.abs(shares.reduce((x, y) => x + y, 0) - 100) <= 3, `shares ${shares}`);

  // ---------- A 12-megapixel phone photo does not freeze the page ----------
  // Its pixels are read and its palette worked out in a worker. Budgeted in main-thread CPU time
  // (Chrome's ThreadTime), not wall time, which a busy machine stretches: about 95 ms here, against
  // 200 to 240 ms when the page did all of it itself (tasks of 0.8 and 1.1 s at a mid-range phone's speed).
  await page.evaluate(async () => {
    const W = 4000, H = 3000, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d'), sky = g.createLinearGradient(0, 0, W, H);
    sky.addColorStop(0, '#2b4a6f'); sky.addColorStop(0.5, '#c98b6b'); sky.addColorStop(1, '#3f6b3a');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    const im = g.getImageData(0, 0, W, H), d = im.data;
    let s = 1;
    for (let i = 0; i < d.length; i += 4) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const n = (s >>> 28) - 8; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(im, 0, 0);
    window.__photo = new File([await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))], 'photo.jpg', { type: 'image/jpeg' });
    c.width = c.height = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const cpu0 = await threadMs();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__photo);
    document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#icp-name').textContent === 'photo.jpg' && !document.querySelector('#icp-palette').hasAttribute('aria-busy'), null, { timeout: 60000 });
  const cpu = (await threadMs()) - cpu0;
  await cdp.detach();
  assert.match(await text('#icp-info'), /^4000 × 3000 px, JPG[,.]/);
  assert.equal((await pal()).length, 6);
  assert.ok(cpu < 150, `opening a 12 MP photo took ${Math.round(cpu)} ms of main-thread CPU`);
  await page.evaluate(() => { delete window.__photo; });

  // ---------- Pick from screen, where the browser has an eyedropper ----------
  const ctx = page.context(), p2 = await ctx.newPage();
  await p2.addInitScript(() => { window.EyeDropper = class { open() { return Promise.resolve({ sRGBHex: '#123456' }); } }; });
  await p2.goto(url);
  await p2.click('#icp-screen');
  await p2.waitForFunction(() => document.querySelector('#icp-big').textContent === '#123456');
  assert.equal(await text('#icp-where', p2), 'From your screen');
  assert.equal(await text('#icp-live', p2), '#123456 picked from the screen.');
  // Some versions give the colour as rgba() rather than hex.
  await p2.evaluate(() => { window.EyeDropper.prototype.open = () => Promise.resolve({ sRGBHex: 'rgba(171, 205, 239, 1)' }); });
  await p2.click('#icp-screen');
  await p2.waitForFunction(() => document.querySelector('#icp-big').textContent === '#ABCDEF');
  await p2.close();
  const p3 = await ctx.newPage();
  await p3.addInitScript(() => { delete window.EyeDropper; });
  await p3.goto(url);
  assert.equal(await p3.isVisible('#icp-screen'), false, 'no button without an eyedropper');
  await p3.close();

  // ---------- Without a worker the page does the same work itself ----------
  const p4 = await ctx.newPage();
  await p4.addInitScript(() => { delete window.Worker; });
  await p4.goto(url);
  await load('blocks.png', p4);
  assert.deepEqual(await pal(p4), exp.blocks);
  await load('merge.png', p4);
  await p4.selectOption('#icp-count', '5');
  assert.deepEqual(await pal(p4), exp.merge);
  await p4.close();
  // Copy palette pressed before the worker has answered copies the palette for what is chosen now.
  const p5 = await ctx.newPage();
  await p5.addInitScript(() => {
    const Real = window.Worker;
    window.Worker = class extends Real {
      postMessage(m, t) {
        if (m && m.cmd === 'palette' && window.__slow) setTimeout(() => super.postMessage(m, t), 3000);
        else super.postMessage(m, t);
      }
    };
  });
  await p5.goto(url);
  await load('merge.png', p5);
  assert.equal((await pal(p5)).length, 6);
  await p5.evaluate(() => { window.__slow = true; });
  // The palette of the picture before is still on screen while the new one is worked out, and is not picked from.
  await p5.setInputFiles('#icp-file', { name: 'blocks.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(fixtures, 'blocks.png')) });
  await p5.waitForFunction(() => document.querySelector('#icp-name').textContent === 'blocks.png');
  const before = await text('#icp-hex', p5);
  await p5.locator('#icp-palette .icp-pal').first().click();
  assert.equal(await text('#icp-hex', p5), before, 'a colour of the previous picture is not picked');
  await p5.evaluate(() => { window.__slow = false; });
  await load('merge.png', p5);
  await p5.evaluate(() => { window.__slow = true; });
  await p5.selectOption('#icp-count', '5');
  assert.equal(await p5.getAttribute('#icp-palette', 'aria-busy'), 'true', 'the old palette is marked as out of date');
  await p5.click('#icp-pal-copy');
  assert.equal(await p5.evaluate(() => navigator.clipboard.readText()), exp.merge.map(m => m[0]).join(', '));
  assert.deepEqual(await pal(p5), exp.merge);
  await p5.close();

  // ---------- Nothing moves while the page starts (layout shift) ----------
  // The canvas is served at the sample picture's size and the screen picker is shown as the page is
  // read, so neither the drawn sample nor the button moves what is below them.
  for (const [width, eye] of [[412, true], [412, false], [800, true]]) {
    const sc = await ctx.browser().newContext({ viewport: { width, height: 860 } });
    await sc.addInitScript(eye => {
      if (!eye) delete window.EyeDropper;
      else if (!('EyeDropper' in window)) window.EyeDropper = class { open() { return Promise.reject(new Error('closed')); } };
      window.__shift = 0;
      new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: 'layout-shift', buffered: true });
    }, eye);
    const sp = await sc.newPage();
    await sp.goto(url, { waitUntil: 'load' });
    await sp.waitForFunction(() => document.querySelectorAll('#icp-palette .icp-pal').length === 6 && !document.querySelector('#icp-palette').hasAttribute('aria-busy'));
    const shift = await sp.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__shift)))));
    assert.equal(await sp.isVisible('#icp-screen'), eye);
    assert.ok(shift < 0.01, `layout shift ${shift.toFixed(4)} at ${width} px ${eye ? 'with' : 'without'} an eyedropper`);
    await sc.close();
  }

  // ---------- A phone: a tap picks, touch and hold aims with the magnifier, a swipe scrolls ----------
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
  // Real touches, scrolled by the browser itself, on a portrait picture of four bands that fills
  // most of the screen (346 × 519 px here).
  const BANDS = ['#C03030', '#30A040', '#3050C0', '#D0B020'];
  await pp.evaluate(async bands => {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 900;
    const g = c.getContext('2d');
    bands.forEach((b, i) => { g.fillStyle = b; g.fillRect(0, i * 225, 600, 225); });
    const dt = new DataTransfer();
    dt.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'portrait.png', { type: 'image/png' }));
    document.querySelector('h1').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, BANDS);
  await pp.waitForFunction(() => document.querySelector('#icp-name').textContent === 'portrait.png');
  const tc = await ph.newCDPSession(pp);
  const touch = (type, x, y) => tc.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const slide = async (x, from, to) => { for (let i = 1; i <= 8; i++) { await touch('touchMove', x, from + (to - from) * i / 8); await pp.waitForTimeout(16); } };
  const now = () => pp.evaluate(() => {
    const r = document.querySelector('#icp-canvas').getBoundingClientRect(), l = document.querySelector('#icp-loupe');
    return { top: r.top, x: r.left + r.width / 2, h: r.height, y: scrollY, picks: document.querySelectorAll('#icp-history li').length, loupe: !l.hidden,
      loupeBottom: l.getBoundingClientRect().bottom, loupeHex: document.querySelector('#icp-loupe-hex').textContent, hex: document.querySelector('#icp-hex').textContent };
  });
  // Until the page has stopped moving (a swipe can carry on as a fling), then with the picture in the middle.
  const still = () => pp.evaluate(() => new Promise(done => { let last = scrollY, n = 0; (function f() { if (scrollY !== last) { last = scrollY; n = 0; } else if (++n >= 6) return done(); requestAnimationFrame(f); })(); }));
  const centre = async () => { await still(); await pp.evaluate(() => document.querySelector('#icp-canvas').scrollIntoView({ block: 'center', behavior: 'instant' })); await still(); };
  // A swipe up on the picture scrolls the page and picks nothing.
  await centre();
  let s = await now();
  await touch('touchStart', s.x, s.top + s.h * 0.8);
  await slide(s.x, s.top + s.h * 0.8, s.top + s.h * 0.8 - 200);
  await touch('touchEnd');
  await still();
  let e = await now();
  assert.ok(e.y > s.y + 100, `a swipe on the picture scrolls the page (scrollY ${s.y} -> ${e.y})`);
  assert.equal(e.picks, s.picks, 'a swipe picks no colour');
  assert.equal(e.loupe, false);
  // Touch and hold on the first band until the magnifier comes up, slide to the third and lift.
  await centre();
  s = await now();
  const y0 = s.top + s.h * 0.125, y1 = s.top + s.h * 0.625;
  await touch('touchStart', s.x, y0);
  await pp.waitForFunction(() => !document.querySelector('#icp-loupe').hidden, null, { timeout: 3000 });
  assert.equal((await now()).loupeHex, BANDS[0]);
  await slide(s.x, y0, y1);
  e = await now();
  assert.equal(e.y, s.y, 'the page stays still while the finger moves the magnifier');
  assert.equal(e.loupeHex, BANDS[2]);
  assert.ok(e.loupeBottom < y1, 'the magnifier is above the finger');
  await touch('touchEnd');
  e = await now();
  assert.deepEqual([e.hex, e.picks, e.loupe], [BANDS[2], s.picks + 1, false], 'lifting picks the colour under the finger');
  await tc.detach();
  const small = await pp.$$eval('#icp-choose, .icp-values .btn, #icp-size, #icp-count, #icp-pal-copy, .icp-chip', els => els.filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.className));
  assert.deepEqual(small, []);
  assert.deepEqual(errs, []);
  await ph.close();
};
