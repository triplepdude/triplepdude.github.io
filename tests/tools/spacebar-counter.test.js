const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected numbers come from tests/fixtures/spacebar-counter/expected.py,
// which works them out from the press times on its own. The timed tests run
// on Playwright's fake clock, so every press lands at its exact millisecond.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const ex = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const browser = page.context().browser();
  const text = (sel, p = page) => p.locator(sel).textContent();
  const checkedVal = (p = page) => p.$eval('input[name="sb-len"]:checked', el => el.value);
  const hash = (p = page) => p.evaluate(() => location.hash);
  const count = (p = page) => text('#sb-count', p);
  const blur = (p = page) => p.evaluate(() => document.activeElement && document.activeElement.blur());
  // Whether the page cancelled the last Space keydown (it must not for a
  // link, a button or the FAQ, which use Space themselves).
  const watchSpace = (p = page) => p.evaluate(() => {
    window.__spaceCancelled = null;
    window.addEventListener('keydown', e => { if (e.code === 'Space') window.__spaceCancelled = e.defaultPrevented; });
  });

  // ---- Defaults: no time limit, nothing counted yet ----
  await open();
  assert.equal(await checkedVal(), '0');
  assert.equal(await hash(), '');
  assert.equal(await text('#sb-time'), '0.0 s');
  assert.equal(await text('#sb-time-label'), 'Time');
  assert.equal(await count(), '0');
  assert.equal(await text('#sb-pad-sub'), 'Press Space or tap this key to begin counting');
  assert.equal(await page.locator('#sb-copy').isVisible(), false);
  assert.equal(await page.locator('#sb-result').isVisible(), false);
  assert.equal(await text('#sb-delay'), '–');
  await page.waitForTimeout(1100);
  assert.equal(await text('#sb-time'), '0.0 s', 'the clock waits for the first press');

  // ---- Space with nothing focused counts and does not scroll the page ----
  await page.evaluate(() => window.scrollTo(0, 300));
  await blur();
  await watchSpace();
  const y0 = await page.evaluate(() => window.scrollY);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Space');
  assert.equal(await count(), '3');
  assert.equal(await text('#sb-pad-count'), '3');
  assert.equal(await page.evaluate(() => window.__spaceCancelled), true);
  assert.equal(await page.evaluate(() => window.scrollY), y0, 'Space must not scroll the page');
  assert.equal(await text('#sb-sr'), 'Counting started.');
  assert.equal(await page.locator('#sb-copy').isVisible(), true);
  // Holding the bar down is one press.
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  assert.equal(await count(), '4');
  assert.equal(await text('#sb-ignored'), '2');
  // The clock runs from the first press.
  await page.waitForTimeout(1200);
  assert.ok(/^1\.\d s$/.test(await text('#sb-time')), `time after 1.2 s: ${await text('#sb-time')}`);

  // ---- Space on a button presses the button; on a link or the FAQ it is left alone ----
  await page.focus('#sb-reset');
  await page.keyboard.press('Space');
  assert.equal(await count(), '0');
  assert.equal(await text('#sb-sr'), 'Counter reset to 0.');
  assert.equal(await page.locator('#sb-copy').isVisible(), false);
  await page.focus('.prose a[href="/keyboard-tester/"]');
  await page.keyboard.press('Space');
  assert.equal(await count(), '0');
  assert.equal(await page.evaluate(() => window.__spaceCancelled), false);
  await page.focus('.faq summary');
  await page.keyboard.press('Space');
  assert.equal(await count(), '0');
  assert.equal(await page.evaluate(() => document.querySelector('.faq details').open), true, 'Space opened the FAQ item');

  // ---- Arrow keys choose the length; Space on the chosen one counts ----
  await page.focus('input[name="sb-len"][value="0"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await checkedVal(), '5');
  assert.equal(await hash(), '#5s');
  assert.equal(await text('#sb-time'), '5.0 s');
  assert.equal(await text('#sb-time-label'), 'Time left');
  assert.equal(await text('#sb-pad-sub'), 'Press Space or tap this key to begin the 5-second test');
  await page.keyboard.press('Space');
  assert.equal(await count(), '1');
  assert.equal(await text('#sb-sr'), 'Counting for 5 seconds.');
  assert.equal(await checkedVal(), '5');
  // Changing the length stops the test.
  await page.keyboard.press('ArrowRight');
  assert.equal(await checkedVal(), '10');
  assert.equal(await count(), '0');
  assert.equal(await text('#sb-time'), '10.0 s');
  assert.equal(await text('#sb-sr'), 'Counting stopped.');
  await page.waitForTimeout(400);
  assert.equal(await text('#sb-time'), '10.0 s');
  // Tab from the choices goes to the counter, which then takes Space.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sb-pad');
  await page.keyboard.press('Enter');
  assert.equal(await count(), '0', 'Enter is not a press');

  // ---- A mouse click is not a press, and the counter says why ----
  await page.click('#sb-pad');
  assert.equal(await count(), '0');
  assert.equal(await text('#sb-pad-sub'), 'Mouse clicks are not counted here: press Space, or tap this key on a touchscreen');
  assert.equal(await text('#sb-sr'), 'Mouse clicks are not counted here. Press Space, or tap this key on a touchscreen. The CPS test counts mouse clicks.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sb-pad');
  await page.keyboard.press('Space');
  assert.equal(await count(), '1', 'after a click, Space counts');
  await page.click('#sb-reset');

  // ---- The address ----
  await page.goto(url + '#60s');
  await page.reload();
  assert.equal(await checkedVal(), '60');
  assert.equal(await text('#sb-time'), '60.0 s');
  for (const junk of ['#7s', '#10', '#10S', '#0s', '#' + 'x'.repeat(200000), '#' + '1'.repeat(5000) + 's']) {
    await page.goto(url + junk);
    await page.reload();
    assert.equal(await checkedVal(), '0', junk.slice(0, 20));
    assert.equal(await text('#sb-time'), '0.0 s', junk.slice(0, 20));
  }

  // ---- Back and Forward: nothing left running, restored choices shown ----
  await page.goto(url + '#30s');
  await page.reload();
  await blur();
  await page.keyboard.press('Space');
  assert.equal(await count(), '1');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await count(), '0');
  await page.waitForTimeout(300);
  assert.equal(await text('#sb-time'), '30.0 s');
  await page.goto(url);
  await page.reload();
  await page.evaluate(() => {
    document.querySelector('input[name="sb-len"][value="5"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  assert.equal(await text('#sb-time'), '5.0 s');
  assert.equal(await hash(), '#5s');

  // ---- Timed tests on a fake clock ----
  const fakeCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await fakeCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const f = await fakeCtx.newPage();
  const ferrors = [];
  f.on('pageerror', e => ferrors.push(e.message));
  f.on('console', m => { if (m.type() === 'error') ferrors.push(m.text()); });
  await f.clock.install();
  await f.goto(url + '#10s');
  await f.clock.pauseAt(Date.now() + 1000);
  await blur(f);
  let at = 0;
  const T = ex.ten;
  for (const [t, op] of T.steps) {
    if (t > at) { await f.clock.runFor(t - at); at = t; }
    if (op === 'down' || op === 'repeat') await f.keyboard.down('Space');
    else if (op === 'up') await f.keyboard.up('Space');
    // A press made now (5 ms before the end) that reaches the page later.
    else if (op === 'make') await f.evaluate(() => { window.__late = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }); return window.__late.timeStamp; });
    else await f.evaluate(() => document.body.dispatchEvent(window.__late));
    if (t === 4500 && op === 'repeat') {
      assert.equal(await text('#sb-pad-sub', f), 'Space is held down: its repeats are not counted');
      assert.equal(await count(f), '18');
    }
    if (t === 6940) assert.ok(/^3\.[01] s$/.test(await text('#sb-time', f)), `time left at 6.94 s: ${await text('#sb-time', f)}`);
    if (t === 10000) assert.equal(await text('#sb-pad-sub', f), 'Time is up', 'a press at the very end closes the test');
  }
  await f.clock.runFor(200);
  const result = async () => ({
    score: await text('#sb-score', f), count: await count(f), best: await text('#sb-best', f),
    doubles: await text('#sb-doubles', f), ignored: await text('#sb-ignored', f)
  });
  const want = x => ({ score: x.score, count: x.count, best: x.best, doubles: x.doubles, ignored: x.ignored });
  assert.deepEqual(await result(), want(T));
  assert.equal(await text('#sb-rate', f), T.score);
  assert.equal(await text('#sb-detail', f), T.detail);
  assert.deepEqual(await f.$$eval('#sb-bars i', els => els.map(e => e.style.height)), T.heights);
  assert.equal(await text('#sb-bars-note', f), T.barsNote);
  assert.equal(await text('#sb-session', f), T.session);
  assert.equal(await text('#sb-sr', f), T.spoken);
  assert.equal(await text('#sb-delay', f), T.repeat.delay);
  assert.equal(await text('#sb-reprate', f), T.repeat.rate);
  assert.equal(await text('#sb-rep-note', f), T.repeat.note);
  await f.click('#sb-copy');
  assert.equal(await f.evaluate(() => navigator.clipboard.readText()), T.copy + '\n' + url);
  // Presses straight after the end neither count nor start a new test.
  await blur(f);
  await f.keyboard.press('Space');
  assert.equal(await count(f), T.count);
  await f.clock.runFor(1000);
  assert.equal(await text('#sb-pad-sub', f), 'Press Space or tap for another test');
  assert.equal(await text('#sb-time', f), '10.0 s');

  // The same length again, slower: the first result stays the session's best.
  const A = ex.again;
  at = 0;
  for (const t of A.presses) {
    if (t > at) { await f.clock.runFor(t - at); at = t; }
    await f.keyboard.down('Space'); await f.clock.runFor(30); at += 30; await f.keyboard.up('Space');
  }
  await f.clock.runFor(10500);
  assert.deepEqual(await result(), want(A));
  assert.equal(await text('#sb-session', f), A.session);
  assert.equal(await text('#sb-detail', f), A.detail);
  assert.equal(await text('#sb-delay', f), T.repeat.delay, 'the repeat measurement stays');

  // No time limit: the average runs from the first press until now.
  await f.check('input[name="sb-len"][value="0"]');
  assert.equal(await hash(f), '');
  await blur(f);
  const F = ex.free;
  at = 0;
  for (const t of F.presses) {
    if (t > at) { await f.clock.runFor(t - at); at = t; }
    await f.keyboard.down('Space'); await f.clock.runFor(20); at += 20; await f.keyboard.up('Space');
  }
  await f.clock.runFor(F.at - at);
  assert.equal(await count(f), F.count);
  assert.equal(await text('#sb-best', f), F.best);
  await f.click('#sb-copy');
  assert.equal(await f.evaluate(() => navigator.clipboard.readText()), F.copy + '\n' + url);
  await f.clock.runFor(5000);
  assert.ok(/^1[01]\.\d s$/.test(await text('#sb-time', f)), `the clock keeps running: ${await text('#sb-time', f)}`);
  await f.click('#sb-reset');
  assert.equal(await count(f), '0');
  assert.equal(await text('#sb-time', f), '0.0 s');

  // Taps on a touch screen: two fingers 10 ms apart are two presses, not chatter.
  await f.check('input[name="sb-len"][value="5"]');
  const tap = (type = 'touch') => f.evaluate(pt => {
    document.getElementById('sb-pad').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: pt, isPrimary: true, button: 0, buttons: 1 }));
  }, type);
  const P = ex.taps;
  at = 0;
  for (const t of P.taps) {
    if (t > at) { await f.clock.runFor(t - at); at = t; }
    await tap();
    if (t === 0) await tap('mouse'); // a mouse button during the test does nothing
  }
  await f.clock.runFor(5300);
  assert.deepEqual(await result(), want(P));
  assert.equal(await text('#sb-detail', f), P.detail);
  assert.equal(await text('#sb-session', f), P.session);

  // 60 seconds on a 320 px screen: every second's bar fits.
  await f.setViewportSize({ width: 320, height: 700 });
  await f.check('input[name="sb-len"][value="60"]');
  await blur(f);
  const S = ex.sixty;
  at = 0;
  for (const t of S.presses) {
    if (t > at) { await f.clock.runFor(t - at); at = t; }
    await f.keyboard.press('Space');
  }
  await f.clock.runFor(1000);
  assert.deepEqual(await result(), want(S));
  assert.equal(await text('#sb-bars-note', f), S.barsNote);
  const fit = await f.evaluate(() => {
    const box = document.getElementById('sb-bars').getBoundingClientRect();
    const all = Array.from(document.querySelectorAll('#sb-bars i')).map(i => i.getBoundingClientRect());
    return { n: all.length, over: Math.round(all[all.length - 1].right - box.right), thinnest: Math.min(...all.map(r => r.width)), first: all[0].left - box.left };
  });
  assert.ok(fit.n === 60 && fit.over <= 0 && fit.first >= 0 && fit.thinnest >= 1, `the 60-second chart does not fit: ${JSON.stringify(fit)}`);
  assert.ok(await f.evaluate(() => document.documentElement.scrollWidth <= 321), 'no sideways scroll at 320 px');
  assert.deepEqual(ferrors, []);
  await fakeCtx.close();

  // ---- A phone: taps count, two fingers count twice, targets are big enough ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  const perrors = [];
  p.on('pageerror', e => perrors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') perrors.push(m.text()); });
  await p.goto(url);
  const pb = await p.locator('#sb-pad').boundingBox();
  const cx = pb.x + pb.width / 2, cy = pb.y + pb.height / 2;
  for (let i = 0; i < 4; i++) await p.touchscreen.tap(cx, cy);
  assert.equal(await count(p), '4');
  const cdp = await phone.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await count(p), '6');
  assert.equal(await text('#sb-doubles', p), '0');
  const sizes = await p.evaluate(() => ({
    chips: Math.min(...Array.from(document.querySelectorAll('.sb-chip span')).map(s => s.getBoundingClientRect().height)),
    reset: document.getElementById('sb-reset').getBoundingClientRect().height,
    copy: document.getElementById('sb-copy').getBoundingClientRect().height,
    pad: document.getElementById('sb-pad').getBoundingClientRect().height,
    touch: getComputedStyle(document.getElementById('sb-pad')).touchAction,
    overflow: document.documentElement.scrollWidth - innerWidth
  }));
  assert.ok(sizes.chips >= 44 && sizes.reset >= 44 && sizes.copy >= 44 && sizes.pad >= 200, JSON.stringify(sizes));
  assert.equal(sizes.touch, 'manipulation');
  assert.ok(sizes.overflow <= 1, `sideways scroll on a phone: ${sizes.overflow}px`);
  assert.deepEqual(perrors, []);
  await phone.close();

  // ---- Homepage search finds the page under the words people use ----
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/spacebar-counter\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the spacebar counter');
  for (const q of ['spacebar counter', 'space bar', 'spacebar test', 'spacebar speed', 'key repeat']) {
    assert.ok(q.split(' ').every(x => hay.includes(x)), `the homepage search finds nothing for "${q}"`);
  }

  // Leave a finished 5-second test on screen for the runner's phone-width checks.
  await page.clock.install();
  await page.goto(url + '#5s');
  await page.reload();
  await page.clock.pauseAt(Date.now() + 1000);
  await blur();
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Space'); await page.clock.runFor(10); }
  await page.clock.runFor(6000);
  assert.equal(await text('#sb-score'), '1.20');
  assert.equal(await text('#sb-doubles'), '5');
};
