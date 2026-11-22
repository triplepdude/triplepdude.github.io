const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected scores and ranks come from tests/fixtures/cps-test/expected.py,
// which divides with exact fractions and rounds half up, independently of
// the page. Timings use real clicks, so the tests that need a whole second
// or more wait for it.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await open();
  const text = sel => page.locator(sel).textContent();
  const checkedVal = name => page.$eval(`input[name="${name}"]:checked`, el => el.value);
  const hash = () => page.evaluate(() => location.hash);
  const rows = () => page.$$eval('#cps-hist tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent)));
  const finished = n => page.waitForFunction(k => !document.querySelector('#cps-hist .cps-empty') &&
    document.querySelectorAll('#cps-hist tr').length === k && !document.getElementById('cps-result').hidden, n, { timeout: 25000 });
  const ready = () => page.waitForFunction(() => /go again\.$/.test(document.getElementById('cps-pad-sub').textContent));
  async function clicks(n, button = 'left') {
    const b = await page.locator('#cps-pad').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < n; i++) { await page.mouse.down({ button }); await page.mouse.up({ button }); }
  }
  const result = async () => ({ cps: await text('#cps-score'), rank: await text('#cps-rank') });
  // A burst of presses made inside the page: real clicks from the test
  // runner can take more than a second on a busy machine.
  const burst = (n, button = 0) => page.evaluate(([k, b]) => {
    const pad = document.getElementById('cps-pad');
    for (let i = 0; i < k; i++) {
      pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: b, buttons: b === 2 ? 2 : 1, pointerType: 'mouse', isPrimary: true }));
      pad.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: b, buttons: 0, pointerType: 'mouse', isPrimary: true }));
    }
  }, [n, button]);

  // ---- Defaults: 5 seconds, left click, nothing running ----
  assert.equal(await checkedVal('cps-len'), '5');
  assert.equal(await checkedVal('cps-mode'), 'left');
  assert.equal(await text('#cps-time'), '5.0 s');
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-pad-main'), 'Click or tap here to start');
  assert.equal(await page.locator('#cps-result').isVisible(), false);
  assert.equal(await text('#cps-hist'), 'No tests yet.');
  assert.equal(await hash(), '');
  // The timer does not run before the first click.
  await page.waitForTimeout(400);
  assert.equal(await text('#cps-time'), '5.0 s');

  // ---- Keyboard: arrow keys pick the length, and the address follows ----
  await page.focus('input[name="cps-len"][value="5"]');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await checkedVal('cps-len'), '1');
  assert.equal(await hash(), '#1s');
  assert.equal(await text('#cps-time'), '1.0 s');

  // ---- A 1-second test: 12 clicks is 12.00 CPS ----
  const t0 = Date.now();
  await burst(12);
  assert.equal(await text('#cps-count'), '12');
  await finished(1);
  const took = Date.now() - t0;
  // The second started with the first click, not when the page loaded.
  assert.ok(took >= 1000 && took < 4000, `the 1-second test ended ${took} ms after the first click`);
  assert.deepEqual(await result(), expected['12/1']);
  assert.match(await text('#cps-detail'), /^12 clicks in 1 second \(left click\)\. Shortest gap between clicks: \d+ ms\.$/);
  assert.equal(await text('#cps-best'), 'First 1-second left click test this session.');
  assert.deepEqual(await rows(), [['1', '1 s', 'Left click or tap', '12', '12.00']]);
  assert.equal(await text('#cps-sr'), 'Test 1: 12 clicks in 1 second, 12.00 per second. Rank: very fast.');
  assert.equal(await page.locator('#cps-bars-wrap').isVisible(), false); // no per-second chart for 1 second
  // Clicks just after the end neither count nor start a new test.
  await clicks(3);
  assert.equal(await text('#cps-count'), '12');
  assert.equal(await text('#cps-pad-main'), 'Time’s up!');
  await ready();
  assert.equal(await text('#cps-pad-main'), '12.00 CPS');
  assert.equal((await rows()).length, 1);

  // ---- Best of the session: a lower score keeps the best, a higher one replaces it ----
  await burst(8);
  await finished(2);
  assert.deepEqual(await result(), expected['8/1']);
  assert.equal(await text('#cps-best'), 'Best 1-second left click score this session: 12.00 CPS.');
  await ready();
  await burst(14);
  await finished(3);
  assert.deepEqual(await result(), expected['14/1']);
  assert.equal(await text('#cps-best'), 'Best 1-second left click score this session: 14.00 CPS. New best!');
  assert.equal(await text('#cps-sr'), 'Test 3: 14 clicks in 1 second, 14.00 per second. Rank: extreme. New best for this length.');
  assert.deepEqual((await rows()).map(r => r[4]), ['14.00', '8.00', '12.00']); // newest first
  await page.click('#cps-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
    '14.00 CPS (Extreme): 14 clicks in 1 second (left click). Best this session: 14.00 CPS.');
  await ready();

  // ---- 5 seconds, with clicks in two different seconds: 37 / 5 = 7.40 ----
  await page.check('input[name="cps-len"][value="5"]');
  assert.equal(await hash(), '');
  const t1 = Date.now();
  await burst(20);
  while (Date.now() - t1 < 1250) await page.waitForTimeout(20);
  await burst(17);
  assert.ok(Date.now() - t1 < 1950, 'the second burst of clicks fell inside the second second');
  await finished(4);
  assert.deepEqual(await result(), expected['37/5']);
  assert.equal(await page.locator('#cps-bars i').count(), 5);
  assert.equal(await text('#cps-bars-note'), 'Clicks in each second: most 20 (second 1), fewest 0 (second 3).');
  const heights = await page.$$eval('#cps-bars i', els => els.map(e => e.style.height));
  assert.deepEqual(heights, ['100%', '85%', '0%', '0%', '0%']);

  // ---- Keys do not count in click mode ----
  await ready();
  await page.focus('#cps-pad');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  assert.equal(await text('#cps-pad-sub'), 'Key presses are not counted in click mode. Choose Space bar to test the keyboard.');
  assert.equal(await text('#cps-sr'), 'Key presses are not counted in click mode. Choose Space bar under Count to test the keyboard.');
  assert.equal((await rows()).length, 4);

  // ---- Space bar mode, 15 seconds, from the keyboard: 7 presses is 0.47 ----
  await page.check('input[name="cps-len"][value="15"]');
  await page.focus('input[name="cps-mode"][value="left"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await checkedVal('cps-mode'), 'space');
  assert.equal(await hash(), '#15s-space');
  assert.equal(await text('#cps-pad-main'), 'Press Space here to start');
  assert.equal(await text('#cps-count-label'), 'Presses');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cps-pad');
  await clicks(2); // clicks are not presses
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-pad-sub'), 'Now press Space. Clicks are not counted in Space bar mode.');
  const y0 = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Space');
  assert.equal(await text('#cps-count'), '1');
  assert.equal(await text('#cps-sr'), 'Test 5 started: 15 seconds.');
  await page.keyboard.down('Space');
  await page.keyboard.down('Space'); // auto-repeat while held: not a new press
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  assert.equal(await text('#cps-count'), '2');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Space');
  await page.keyboard.press('Enter'); // only Space counts
  assert.equal(await text('#cps-count'), '7');
  assert.equal(await page.evaluate(() => window.scrollY), y0, 'Space must not scroll the page');
  await finished(5);
  assert.deepEqual(await result(), expected['7/15']);
  assert.match(await text('#cps-detail'), /^7 presses in 15 seconds \(space bar\)\. Shortest gap between presses: \d+ ms\.$/);
  assert.deepEqual((await rows())[0], ['5', '15 s', 'Space bar', '7', '0.47']);

  // ---- Right click: left clicks are ignored and the menu stays shut ----
  await page.check('input[name="cps-len"][value="1"]');
  await page.check('input[name="cps-mode"][value="right"]');
  assert.equal(await hash(), '#1s-right');
  assert.equal(await text('#cps-pad-main'), 'Right-click here to start');
  await page.evaluate(() => { window.__menus = []; document.addEventListener('contextmenu', e => window.__menus.push(e.defaultPrevented)); });
  await clicks(2);
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-pad-main'), 'Right-click here to start');
  await clicks(6, 'right');
  await finished(6);
  assert.deepEqual(await result(), expected['6/1']);
  const menus = await page.evaluate(() => window.__menus);
  assert.ok(menus.length >= 1 && menus.every(Boolean), `context menus not blocked: ${JSON.stringify(menus)}`);
  assert.equal(await text('#cps-best'), 'First 1-second right click test this session.');

  // ---- Changing the length or Restart stops a test that is running ----
  await ready();
  await clicks(3, 'right');
  assert.equal(await text('#cps-count'), '3');
  await page.check('input[name="cps-len"][value="10"]');
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-pad-main'), 'Right-click here to start');
  assert.equal(await text('#cps-sr'), 'Test stopped.');
  await page.waitForTimeout(300);
  assert.equal(await text('#cps-time'), '10.0 s');
  await clicks(2, 'right');
  assert.equal(await text('#cps-sr'), 'Test 7 started: 10 seconds.');
  await page.click('#cps-restart');
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-sr'), 'Test stopped.');
  await page.waitForTimeout(1200);
  assert.equal((await rows()).length, 6);
  assert.equal(await text('#cps-time'), '10.0 s');

  // ---- The address: a valid set-up is opened, anything else gives the defaults ----
  await page.goto(url + '#60s-right');
  assert.equal(await checkedVal('cps-len'), '60');
  assert.equal(await checkedVal('cps-mode'), 'right');
  assert.equal(await text('#cps-time'), '60.0 s');
  for (const junk of ['#7s', '#5s-left', '#10S', '#' + 'x'.repeat(200000), '#' + '1'.repeat(5000) + 's']) {
    await page.goto(url + junk);
    await page.reload();
    assert.equal(await checkedVal('cps-len'), '5', junk.slice(0, 20));
    assert.equal(await checkedVal('cps-mode'), 'left', junk.slice(0, 20));
  }
  await page.goto(url + '#100s-space');
  await page.reload();
  assert.equal(await checkedVal('cps-len'), '100');
  assert.equal(await checkedVal('cps-mode'), 'space');
  assert.equal(await text('#cps-time'), '100.0 s');

  // ---- Back from another page: nothing left running, choices match the address ----
  await page.check('input[name="cps-len"][value="10"]');
  await page.check('input[name="cps-mode"][value="right"]');
  await clicks(2, 'right');
  assert.equal(await text('#cps-count'), '2');
  await page.goto(base + '/');
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('cps-pad-main').textContent === 'Right-click here to start');
  assert.equal(await checkedVal('cps-len'), '10');
  assert.equal(await checkedVal('cps-mode'), 'right');
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-time'), '10.0 s');
  // Headless Chromium reloads rather than using its back-forward cache, so the
  // cache's pageshow is sent by hand: a test frozen half way must stop, and
  // choices the browser restored after the script ran must be shown.
  await clicks(2, 'right');
  assert.equal(await text('#cps-count'), '2');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await text('#cps-count'), '0');
  assert.equal(await text('#cps-pad-main'), 'Right-click here to start');
  await page.waitForTimeout(300);
  assert.equal(await text('#cps-time'), '10.0 s');
  await page.goto(url);
  await page.reload();
  await page.evaluate(() => {
    document.querySelector('input[name="cps-len"][value="30"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  assert.equal(await text('#cps-time'), '30.0 s');
  assert.equal(await hash(), '#30s');

  // ---- Clear session ----
  await page.goto(url + '#1s');
  await page.reload();
  await clicks(2);
  await finished(1);
  assert.deepEqual(await result(), expected['2/1']);
  await page.click('#cps-clear');
  assert.equal(await text('#cps-hist'), 'No tests yet.');
  assert.equal(await page.locator('#cps-result').isVisible(), false);
  assert.equal(await text('#cps-sr'), 'Session cleared.');

  // ---- Holding the button down on the running box changes only its edge ----
  // Shading the whole box on each press made fast clicking flash a large
  // area 6 to 12 times a second in light mode: a general flash under WCAG
  // 2.3.1 is a change of 0.10 or more in relative luminance where the darker
  // state is below 0.80.
  const luminance = css => {
    const v = css.match(/-?\d*\.?\d+/g).map(Number).slice(0, 3).map(c => (css.startsWith('color(') ? c : c / 255));
    const lin = v.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const padLook = () => page.$eval('#cps-pad', el => {
    const s = getComputedStyle(el);
    return { running: el.classList.contains('is-running'), bg: s.backgroundColor, shadow: s.boxShadow, filter: s.filter, opacity: s.opacity };
  });
  await page.goto(url + '#5s');
  await page.reload();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator('#cps-pad').scrollIntoViewIfNeeded();
    const pb5 = await page.locator('#cps-pad').boundingBox();
    await page.mouse.move(pb5.x + pb5.width / 2, pb5.y + pb5.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down();
    const down = await padLook();
    await page.mouse.up();
    const up = await padLook();
    assert.ok(down.running && up.running, `${scheme}: the test is not running`);
    const [l1, l2] = [luminance(down.bg), luminance(up.bg)];
    assert.ok(Math.abs(l1 - l2) < 0.1 || Math.min(l1, l2) >= 0.8,
      `${scheme}: pressing the box changes its background from ${up.bg} to ${down.bg} (luminance ${l2.toFixed(3)} to ${l1.toFixed(3)}), a flash on every click`);
    assert.equal(down.filter, up.filter, `${scheme}: a filter on press`);
    assert.equal(down.opacity, up.opacity, `${scheme}: a change of opacity on press`);
    assert.notEqual(down.shadow, up.shadow, `${scheme}: no feedback while the button is down`);
    await page.click('#cps-restart');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await text('#cps-hist'), 'No tests yet.');

  // ---- A phone: taps count, two fingers count twice, targets are big enough ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(url + '#1s');
  const cdp = await phone.newCDPSession(p);
  // A finger that lands on the box to scroll the page is no click: the
  // browser sends pointercancel once the touch has become a scroll.
  const stillY = () => p.waitForFunction(() => new Promise(r => {
    const y = scrollY;
    requestAnimationFrame(() => requestAnimationFrame(() => r(scrollY === y)));
  }));
  const swipe = async () => {
    const box = await p.locator('#cps-pad').boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height * 0.7;
    const y0 = await p.evaluate(() => scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i / 3, y: y - i * 36 }] });
      await p.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await stillY();
    const moved = (await p.evaluate(() => scrollY)) - y0;
    await p.evaluate(() => window.scrollTo(0, 0));
    await stillY();
    return moved;
  };
  const padState = () => p.evaluate(() => ['#cps-pad-main', '#cps-pad-sub', '#cps-time', '#cps-count', '#cps-rate', '#cps-hist']
    .map(s => document.querySelector(s).textContent));
  const fresh = await padState();
  assert.ok(await swipe() > 100, 'the swipe did not scroll the page');
  assert.deepEqual(await padState(), fresh, 'a swipe that started on the box started a test');
  await p.waitForTimeout(1100); // longer than the test
  assert.deepEqual(await padState(), fresh, 'a swipe that started on the box recorded a test');
  const pb = await p.locator('#cps-pad').boundingBox();
  const cx = pb.x + pb.width / 2, cy = pb.y + pb.height / 2;
  for (let i = 0; i < 5; i++) await p.touchscreen.tap(cx, cy);
  await p.waitForFunction(() => !document.getElementById('cps-result').hidden, null, { timeout: 5000 });
  assert.equal(await p.textContent('#cps-score'), expected['5/1'].cps);
  assert.equal(await p.textContent('#cps-rank'), expected['5/1'].rank);
  await p.waitForFunction(() => /go again\.$/.test(document.getElementById('cps-pad-sub').textContent));
  // After a test, a swipe leaves its score and the ready state as they were.
  const done = await padState();
  assert.deepEqual(done.slice(0, 5), ['5.00 CPS', 'Click or tap to go again.', '1.0 s', '5', '5.00']);
  assert.ok(await swipe() > 100, 'the second swipe did not scroll the page');
  assert.deepEqual(await padState(), done, 'a swipe after a test changed the box');
  assert.equal(await p.textContent('#cps-score'), expected['5/1'].cps);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await p.textContent('#cps-count'), '2');
  // Right click mode cannot be done with taps, and says so instead of ignoring them.
  await p.check('input[name="cps-mode"][value="right"]');
  await p.touchscreen.tap(cx, cy);
  assert.equal(await p.textContent('#cps-count'), '0');
  assert.equal(await p.textContent('#cps-pad-sub'), 'Taps are not counted in Right click mode. Choose Left click or tap, or use a mouse.');
  assert.equal(await p.evaluate(() => location.hash), '#1s-right');
  const sizes = await p.evaluate(() => ({
    chips: Math.min(...Array.from(document.querySelectorAll('.cps-chip span')).map(s => s.getBoundingClientRect().height)),
    restart: document.getElementById('cps-restart').getBoundingClientRect().height,
    copy: document.getElementById('cps-copy').getBoundingClientRect().height,
    pad: document.getElementById('cps-pad').getBoundingClientRect().height,
    touch: getComputedStyle(document.getElementById('cps-pad')).touchAction,
    overflow: document.documentElement.scrollWidth - innerWidth
  }));
  assert.ok(sizes.chips >= 44 && sizes.restart >= 44 && sizes.copy >= 44 && sizes.pad >= 200, JSON.stringify(sizes));
  assert.equal(sizes.touch, 'manipulation'); // no double-tap zoom while tapping fast
  assert.ok(sizes.overflow <= 1, `sideways scroll on a phone: ${sizes.overflow}px`);
  assert.deepEqual(errors, []);
  await phone.close();

  // ---- Long tests on a fake clock, on a 320 px screen ----
  // Playwright's clock fakes performance.now(), timers, frames and the time
  // stamps of events made in the page, so presses land at exact times and
  // 160 seconds of tests take none.
  const slow = await page.context().browser().newContext({ viewport: { width: 320, height: 700 } });
  const f = await slow.newPage();
  const ferrors = [];
  f.on('pageerror', e => ferrors.push(e.message));
  f.on('console', m => { if (m.type() === 'error') ferrors.push(m.text()); });
  await f.clock.install();
  await f.goto(url + '#100s');
  await f.clock.pauseAt(Date.now() + 1000);
  const fire = (init = {}, type = 'pointerdown') => f.evaluate(([i, ty]) => {
    const e = new PointerEvent(ty, { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, ...i });
    document.getElementById('cps-pad').dispatchEvent(e);
    return e.timeStamp;
  }, [init, type]);
  const fcount = () => f.textContent('#cps-count');
  // 100 seconds: 3 clicks in second 1 (gaps of 300 and 150 ms), 1 at 1.6 s
  // (second 2, not 3), 1 in second 51, 1 in second 100, one exactly at the
  // end, and one made 5 ms before the end but delivered after it.
  const s0 = await fire();
  await f.clock.runFor(300); await fire();
  await f.clock.runFor(150); await fire();
  await f.clock.runFor(1150); await fire();
  await f.clock.runFor(48400); await fire();
  await f.clock.runFor(49700); await fire();
  assert.equal(await fcount(), '6');
  await f.clock.runFor(295);
  // (The fake clock gives an event its time stamp when it is first read, so it is read now.)
  const late = await f.evaluate(() => { window.__late = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true }); return window.__late.timeStamp; });
  assert.equal(Math.round(late - s0), 99995);
  await f.clock.runFor(5);
  assert.equal(Math.round(await fire() - s0), 100000);
  assert.equal(await fcount(), '6', 'a click at the very end must not count');
  await f.evaluate(() => document.getElementById('cps-pad').dispatchEvent(window.__late));
  assert.equal(await fcount(), '7', 'a click made before the end must count even if it arrives late');
  await f.clock.runFor(100);
  assert.equal(await f.textContent('#cps-score'), expected['7/100'].cps);
  assert.equal(await f.textContent('#cps-rank'), expected['7/100'].rank);
  assert.equal(await f.textContent('#cps-detail'), '7 clicks in 100 seconds (left click). Shortest gap between clicks: 150 ms.');
  assert.equal(await f.textContent('#cps-bars-note'), 'Clicks in each second: most 3 (second 1), fewest 0 (second 3).');
  const bars = await f.$$eval('#cps-bars i', els => els.map(e => e.style.height));
  assert.equal(bars.length, 100);
  assert.deepEqual([bars[0], bars[1], bars[50], bars[99]], ['100%', '33%', '33%', '67%']);
  assert.equal(bars.filter(h => h !== '0%').length, 4);
  // All 100 bars fit inside the result box on a 320 px screen.
  const fit = await f.evaluate(() => {
    const box = document.getElementById('cps-bars').getBoundingClientRect();
    const all = Array.from(document.querySelectorAll('#cps-bars i')).map(i => i.getBoundingClientRect());
    return { over: Math.round(all[all.length - 1].right - box.right), thinnest: Math.min(...all.map(r => r.width)), first: all[0].left - box.left };
  });
  assert.ok(fit.over <= 0 && fit.first >= 0 && fit.thinnest >= 1, `the 100-second chart does not fit: ${JSON.stringify(fit)}`);
  // 60 seconds of right clicks: a right button pressed while the left one is
  // held counts (it arrives as pointermove); left presses do not.
  await f.evaluate(() => {
    document.querySelector('input[name="cps-len"][value="60"]').click();
    document.querySelector('input[name="cps-mode"][value="right"]').click();
  });
  assert.equal(await f.evaluate(() => location.hash), '#60s-right');
  await fire({ button: 2, buttons: 2 });
  await f.clock.runFor(40);
  await fire({ button: 0, buttons: 1 });
  await f.clock.runFor(40);
  await fire({ button: 2, buttons: 3 }, 'pointermove');
  await fire({ button: -1, buttons: 3 }, 'pointermove');
  await fire({ button: 0, buttons: 3 }, 'pointermove');
  await fire({ button: 2, buttons: 1 }, 'pointermove');
  assert.equal(await fcount(), '2');
  await f.clock.runFor(60100);
  assert.equal(await f.textContent('#cps-score'), expected['2/60'].cps);
  assert.equal(await f.textContent('#cps-detail'), '2 clicks in 60 seconds (right click). Shortest gap between clicks: 80 ms. The Guinness World Record for one minute is 760 clicks.');
  assert.equal(await f.textContent('#cps-bars-note'), 'Clicks in each second: most 2 (second 1), fewest 0 (second 2).');
  assert.deepEqual(await f.$$eval('#cps-hist tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent))),
    [['2', '60 s', 'Right click', '2', '0.03'], ['1', '100 s', 'Left click or tap', '7', '0.07']]);
  // The session table fits its box at 320 px, so the CPS column is not hidden.
  const table = await f.evaluate(() => { const t = document.querySelector('.cps-hist'); return [t.scrollWidth, t.parentElement.clientWidth]; });
  assert.ok(table[0] <= table[1], `the session table is wider than its box at 320 px: ${table}`);

  // ---- Touches that the browser turns into a scroll or a zoom are taken off again ----
  await f.evaluate(() => {
    document.querySelector('input[name="cps-len"][value="5"]').click();
    document.querySelector('input[name="cps-mode"][value="left"]').click();
  });
  const touch = (type, id) => fire({ pointerType: 'touch', pointerId: id, isPrimary: false, buttons: type === 'pointerdown' ? 1 : 0 }, type);
  const fview = () => f.evaluate(() => ['#cps-pad-main', '#cps-pad-sub', '#cps-time', '#cps-count', '#cps-rate', '#cps-hist']
    .map(s => document.querySelector(s).textContent));
  const ready5 = await fview();
  assert.equal(ready5[0], 'Click or tap here to start');
  // The only touch of a test scrolls: no test, the box is as it was.
  await touch('pointerdown', 11);
  assert.equal(await fcount(), '1');
  await f.clock.runFor(40);
  await touch('pointercancel', 11);
  assert.deepEqual(await fview(), ready5);
  await f.clock.runFor(6000);
  assert.deepEqual(await fview(), ready5, 'a test started by a scroll was recorded');
  // A touch in the middle of a test scrolls: the other touches still count.
  // A finger still on the box at the end holds the result back until it
  // lifts (counted) or scrolls (not counted).
  await touch('pointerdown', 12); await touch('pointerup', 12);
  await f.clock.runFor(100); await touch('pointerdown', 13);
  await f.clock.runFor(50); await touch('pointerdown', 14); await touch('pointerup', 14);
  assert.equal(await fcount(), '3');
  await f.clock.runFor(50); await touch('pointercancel', 13);
  assert.equal(await fcount(), '2');
  await f.clock.runFor(4780); await touch('pointerdown', 15);
  assert.equal(await fcount(), '3');
  await f.clock.runFor(200);
  assert.equal(await f.textContent('#cps-pad-main'), 'Time’s up!');
  assert.equal(await f.$$eval('#cps-hist tr', trs => trs.length), 2, 'the result did not wait for the finger on the box');
  await touch('pointerup', 15);
  await f.clock.runFor(30);
  assert.equal(await f.textContent('#cps-score'), expected['3/5'].cps);
  assert.equal(await f.textContent('#cps-detail'), '3 clicks in 5 seconds (left click). Shortest gap between clicks: 150 ms.');
  await f.clock.runFor(1200);
  // The first touch of a test scrolls after another touch: the clock runs
  // from that other touch. A finger that stays on past the end and then
  // scrolls is not counted either.
  await touch('pointerdown', 21);
  await f.clock.runFor(200); await touch('pointerdown', 22); await touch('pointerup', 22);
  await f.clock.runFor(100); await touch('pointercancel', 21);
  assert.equal(await fcount(), '1');
  await f.clock.runFor(4780); // 5.08 s after the first touch, 4.88 s after the second
  assert.equal(await f.textContent('#cps-pad-main'), '1', 'the clock did not restart from the touch that is left');
  await touch('pointerdown', 23);
  await f.clock.runFor(200);
  assert.equal(await f.textContent('#cps-pad-main'), 'Time’s up!');
  await touch('pointercancel', 23);
  await f.clock.runFor(30);
  assert.equal(await f.textContent('#cps-score'), expected['1/5'].cps);
  assert.equal(await f.textContent('#cps-detail'), '1 click in 5 seconds (left click).');
  await f.clock.runFor(1200);
  // A finger left on the box does not hold the result back for long, and counts.
  await touch('pointerdown', 31); await touch('pointerup', 31);
  await f.clock.runFor(4990); await touch('pointerdown', 32);
  await f.clock.runFor(600);
  assert.equal(await f.textContent('#cps-detail'), '2 clicks in 5 seconds (left click). Shortest gap between clicks: 4990 ms.');
  await touch('pointercancel', 32);
  assert.equal(await f.textContent('#cps-detail'), '2 clicks in 5 seconds (left click). Shortest gap between clicks: 4990 ms.');
  assert.deepEqual((await f.$$eval('#cps-hist tr', trs => trs.map(tr => tr.cells[3].textContent))), ['2', '1', '3', '2', '7']);
  assert.deepEqual(ferrors, []);
  await slow.close();

  // ---- Homepage search finds the page under the words people use ----
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/cps-test\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the CPS test');
  for (const q of ['cps', 'click speed', 'clicks per second', 'spacebar', 'right click', 'butterfly', 'jitter', 'mouse', 'double click', 'kohi']) {
    assert.ok(q.split(' ').every(w => hay.includes(w)), `the homepage search finds nothing for "${q}"`);
  }
};
