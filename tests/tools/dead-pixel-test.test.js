// The Fullscreen and Wake Lock APIs are stubbed (headless Chromium has no real
// full screen to enter). With ?nofs the Fullscreen API is removed entirely, as on
// an iPhone, to exercise the fill-the-window fallback.
module.exports = async ({ page, open, assert, url }) => {
  await page.addInitScript(() => {
    window.__fs = [];
    window.__wake = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request(type) {
        window.__wake.push('request:' + type);
        const l = new EventTarget();
        l.release = () => { window.__wake.push('release'); return Promise.resolve(); };
        return Promise.resolve(l);
      },
    } });
    if (location.search.includes('nofs')) {
      delete Element.prototype.requestFullscreen;
      delete Element.prototype.webkitRequestFullscreen;
      return;
    }
    let el = null;
    const fire = () => setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 10);
    Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => el });
    Element.prototype.requestFullscreen = function (opts) { window.__fs.push(['request', this.id, opts && opts.navigationUI]); el = this; fire(); return Promise.resolve(); };
    Document.prototype.exitFullscreen = function () { window.__fs.push(['exit']); el = null; fire(); return Promise.resolve(); };
  });
  await open();

  const text = s => page.locator(s).textContent();
  const bg = () => page.$eval('#dpt-pattern', e => getComputedStyle(e).backgroundColor);
  const bgImage = () => page.$eval('#dpt-pattern', e => getComputedStyle(e).backgroundImage);
  const active = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  const has = cls => page.$eval('#dpt-stage', (e, c) => e.classList.contains(c), cls);
  const name = () => text('#dpt-name');

  // 13 patterns, starting on black.
  const names = await page.$$eval('.dpt-sw', els => els.map(e => e.textContent));
  assert.deepEqual(names, ['Black', 'White', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Grey 50%', 'Dark grey 5%', 'Grey gradient', 'Colour gradients', 'Checkerboard']);
  assert.equal(await name(), 'Black');
  assert.equal(await text('#dpt-count'), '1 of 13');
  assert.equal(await bg(), 'rgb(0, 0, 0)');
  assert.match(await text('#dpt-tip'), /hot pixel/);
  assert.equal(await page.getAttribute('.dpt-sw:nth-child(1)', 'aria-pressed'), 'true');
  assert.equal(await has('is-active'), false);

  // Page buttons step through the colours and keep focus.
  await page.click('#dpt-next');
  assert.equal(await name(), 'White');
  assert.equal(await bg(), 'rgb(255, 255, 255)');
  assert.equal(await active(), 'dpt-next');
  await page.click('#dpt-prev');
  assert.equal(await name(), 'Black');
  await page.click('#dpt-prev');
  assert.equal(await name(), 'Checkerboard', 'wraps around backwards');

  // Every solid colour has the exact sRGB value.
  const solids = { Red: 'rgb(255, 0, 0)', Green: 'rgb(0, 255, 0)', Blue: 'rgb(0, 0, 255)', Cyan: 'rgb(0, 255, 255)',
    Magenta: 'rgb(255, 0, 255)', Yellow: 'rgb(255, 255, 0)', 'Grey 50%': 'rgb(128, 128, 128)', 'Dark grey 5%': 'rgb(13, 13, 13)' };
  for (const [n, rgb] of Object.entries(solids)) {
    await page.click(`.dpt-sw:text-is("${n}")`);
    assert.equal(await name(), n);
    assert.equal(await bg(), rgb, n);
    assert.equal(await bgImage(), 'none', n);
    assert.equal(await page.getAttribute(`.dpt-sw:text-is("${n}")`, 'aria-pressed'), 'true');
  }
  await page.click('.dpt-sw:text-is("Grey gradient")');
  assert.match(await bgImage(), /^linear-gradient\(to right, rgb\(0, 0, 0\), rgb\(255, 255, 255\)\)$/);
  await page.click('.dpt-sw:text-is("Colour gradients")');
  assert.equal((await bgImage()).match(/linear-gradient/g).length, 4);

  // Keyboard on the focused preview: arrows move, Home and End jump.
  await page.focus('#dpt-stage');
  await page.waitForTimeout(700); // let the smooth scroll to the focused stage finish
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await name(), 'Grey gradient');
  await page.keyboard.press('Home');
  assert.equal(await name(), 'Black');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  assert.equal(await name(), 'White');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.scrollY), scrolled, 'keys on the preview do not scroll the page');
  await page.keyboard.press('End');
  assert.equal(await name(), 'Checkerboard');
  assert.equal(await page.isVisible('#dpt-canvas'), true);
  assert.equal(await text('#dpt-live'), 'Checkerboard, 13 of 13');

  // The checkerboard is pure black and white with square cells of equal size.
  const board = await page.$eval('#dpt-canvas', c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const px = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]].join(','); };
    const runs = (n, get) => { const out = []; let len = 1; for (let i = 1; i < n; i++) { if (get(i) === get(i - 1)) len++; else { out.push(len); len = 1; } } out.push(len); return out; };
    const y = c.height >> 1, x = c.width >> 1;
    const colours = new Set();
    for (let i = 0; i < c.width; i++) colours.add(px(i, y));
    for (let j = 0; j < c.height; j++) colours.add(px(x, j));
    return { w: c.width, h: c.height, cssW: c.clientWidth, row: runs(c.width, i => px(i, y)), col: runs(c.height, j => px(x, j)), colours: [...colours] };
  });
  assert.deepEqual(board.colours.sort(), ['0,0,0', '255,255,255']);
  assert.equal(board.w, board.cssW, 'canvas is drawn at device resolution (DPR 1)');
  const inner = [...board.row.slice(1, -1), ...board.col.slice(1, -1)];
  assert.ok(inner.length >= 8, `enough cells: ${inner}`);
  assert.equal(new Set(inner).size, 1, `square, equal cells: ${inner}`);
  assert.ok(Math.abs(board.h / inner[0] - 6) < 1.01, 'about six rows of squares');

  // ---- Full screen (stubbed API) ----
  await page.selectOption('#dpt-interval', '1');
  await page.click('.dpt-sw:text-is("Black")');
  await page.click('#dpt-start');
  await page.waitForFunction(() => document.getElementById('dpt-stage').classList.contains('is-active'));
  assert.deepEqual(await page.evaluate(() => window.__fs), [['request', 'dpt-stage', 'hide']]);
  assert.equal(await active(), 'dpt-stage');
  assert.equal(await page.getAttribute('#dpt-stage', 'role'), 'application');
  assert.match(await page.getAttribute('#dpt-stage', 'aria-label'), /^Full-screen test: Black, 1 of 13\./);
  assert.equal(await has('show-bar'), true);
  await page.waitForSelector('#dpt-bar-exit', { state: 'visible', timeout: 1000 });
  await page.waitForFunction(() => window.__wake.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__wake), ['request:screen']);

  // Space, arrows, Page Down and Backspace in full screen.
  const seq = [['Space', 'White'], ['ArrowRight', 'Red'], ['ArrowDown', 'Green'], ['ArrowLeft', 'Red'], ['PageDown', 'Green'],
    ['Backspace', 'Red'], ['ArrowUp', 'White'], ['Enter', 'Red']];
  for (const [key, expect] of seq) {
    await page.keyboard.press(key);
    assert.equal(await name(), expect, key);
  }
  assert.equal(await bg(), 'rgb(255, 0, 0)');

  // Clicking the right two thirds goes forward, the left third back.
  const box = await page.locator('#dpt-stage').boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.3);
  assert.equal(await name(), 'Green');
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.3);
  assert.equal(await name(), 'Red');
  // The bar's own buttons work without also triggering the stage click.
  await page.click('#dpt-bar-next');
  assert.equal(await name(), 'Green');
  assert.match(await text('#dpt-bar-text'), /^Green 4\/13$/);

  // The controls fade and the pointer hides after two idle seconds.
  await page.waitForFunction(() => document.getElementById('dpt-stage').classList.contains('is-idle'), null, { timeout: 4000 });
  assert.equal(await has('show-bar'), false);
  assert.equal(await page.$eval('#dpt-stage', e => getComputedStyle(e).cursor), 'none');
  await page.waitForSelector('#dpt-bar-exit', { state: 'hidden', timeout: 1000 }); // fades out over 0.2 s
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.move(box.x + 80, box.y + 90);
  assert.equal(await has('is-idle'), false);
  assert.equal(await has('show-bar'), true);

  // A toggles auto-cycle; at 1 s it advances about once a second.
  await page.keyboard.press('a');
  assert.equal(await page.isChecked('#dpt-auto'), true);
  assert.match(await text('#dpt-bar-text'), /, auto$/);
  const before = await page.evaluate(() => Number(document.getElementById('dpt-count').textContent.split(' ')[0]));
  await page.waitForTimeout(2300);
  const after = await page.evaluate(() => Number(document.getElementById('dpt-count').textContent.split(' ')[0]));
  const moved = (after - before + 13) % 13;
  assert.ok(moved >= 2 && moved <= 3, `auto-cycle moved ${moved}`);
  await page.keyboard.press('A');
  assert.equal(await page.isChecked('#dpt-auto'), false);
  const stopped = await name();
  await page.waitForTimeout(1300);
  assert.equal(await name(), stopped, 'auto-cycle stopped');

  // Escape exits full screen and gives focus back to the start button.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('dpt-stage').classList.contains('is-active'));
  assert.deepEqual((await page.evaluate(() => window.__fs)).map(c => c[0]), ['request', 'exit']);
  assert.equal(await active(), 'dpt-start');
  assert.equal(await page.getAttribute('#dpt-stage', 'role'), 'group');
  assert.deepEqual(await page.evaluate(() => window.__wake), ['request:screen', 'release']);
  // The browser leaving full screen by itself (e.g. its own Esc handling) also ends the test.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('dpt-stage').classList.contains('is-active'));
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.getElementById('dpt-stage').classList.contains('is-active'));
  // Clicking the preview starts full screen too; the Exit button leaves it.
  await page.click('#dpt-stage');
  await page.waitForFunction(() => document.getElementById('dpt-stage').classList.contains('is-active'));
  await page.click('#dpt-bar-exit');
  await page.waitForFunction(() => !document.getElementById('dpt-stage').classList.contains('is-active'));
  assert.equal(await text('#dpt-msg'), '');

  // ---- No Fullscreen API: the stage fills the window instead ----
  await page.goto(url + '?nofs');
  await page.click('#dpt-next');
  await page.click('#dpt-start');
  assert.equal(await has('is-pseudo'), true);
  assert.equal(await active(), 'dpt-stage');
  assert.match(await text('#dpt-msg'), /fills the browser window/);
  // The note is also shown on the covering stage, where it can be seen.
  await page.waitForSelector('#dpt-note', { state: 'visible', timeout: 1000 });
  assert.match(await text('#dpt-note'), /fills the browser window/);
  const vp = page.viewportSize();
  const pb = await page.locator('#dpt-stage').boundingBox();
  assert.deepEqual([pb.x, pb.y, pb.width, pb.height], [0, 0, vp.width, vp.height]);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden');
  assert.equal(await name(), 'White');
  await page.keyboard.press('ArrowRight');
  assert.equal(await name(), 'Red');
  await page.keyboard.press('Escape');
  assert.equal(await has('is-pseudo'), false);
  assert.equal(await has('is-active'), false);
  assert.equal(await active(), 'dpt-start');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'visible');
  // F toggles it from the focused preview.
  await page.focus('#dpt-stage');
  await page.keyboard.press('f');
  assert.equal(await has('is-pseudo'), true);
  await page.keyboard.press('f');
  assert.equal(await has('is-pseudo'), false);
};
