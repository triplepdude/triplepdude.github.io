const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Reaction times are checked against timestamps this test records itself:
// when the box's class turns to is-go (a MutationObserver) and the time
// stamp of the key press (a listener of its own). Averages and medians are
// recomputed here from the times shown, and percentiles come from
// tests/fixtures/reaction-time-test/percentiles.py, which reads Human
// Benchmark's chart with exact fractions.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const pct = JSON.parse(fs.readFileSync(path.join(fixtures, 'percentiles.json'), 'utf8'));
  await open();
  const text = sel => page.locator(sel).textContent();
  const pad = () => page.getAttribute('#rt-pad', 'class');
  const stats = async () => [await text('#rt-round'), await text('#rt-avg'), await text('#rt-med'), await text('#rt-best'), await text('#rt-false')];
  const rows = () => page.$$eval('#rt-hist tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent)));
  const msOf = s => Number(/^(\d+) ms/.exec(s)[1]);

  // ---- Before anything happens ----
  assert.equal(await text('#rt-main'), 'Click to start');
  assert.equal(await text('#rt-sub'), 'When the box turns green, click as fast as you can.');
  assert.deepEqual(await stats(), ['0 / 5', '–', '–', '–', '0']);
  assert.equal(await page.locator('#rt-result').isVisible(), false);
  assert.equal(await page.locator('#rt-try-beep').isVisible(), false);
  assert.equal(await text('#rt-hist'), 'No sets finished yet.');
  await page.waitForFunction(() => /^Your browser is drawing about \d+ frames a second, one every \d+\.\d ms\./.test(document.getElementById('rt-fps').textContent));

  // A frame loop of this test's own: rAF callbacks in one frame share its
  // timestamp, and this loop's callback runs before the page's (it was
  // registered first), so each class change is logged with the start of the
  // frame that made it, the moment the page's clock must start from.
  await page.evaluate(() => {
    const el = document.getElementById('rt-pad');
    window.__log = [];
    window.__keys = [];
    window.__lastFrame = 0;
    const loop = ts => { window.__lastFrame = ts; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new MutationObserver(() => window.__log.push({ cls: el.className, t: performance.now(), frame: window.__lastFrame })).observe(el, { attributes: true, attributeFilter: ['class'] });
    for (const type of ['keydown', 'pointerdown']) window.addEventListener(type, e => window.__keys.push({ type, t: e.timeStamp }), true);
  });
  const lastGo = () => page.evaluate(() => window.__log.filter(x => x.cls.includes('is-go')).pop());
  const lastKey = (type = 'keydown') => page.evaluate(ty => window.__keys.filter(k => k.type === ty).pop().t, type);
  // One visual round from the keyboard: start, wait for green, then press
  // `after` ms later. The time shown must be the press's time stamp minus the
  // start of the frame that drew the green, rounded to the millisecond.
  async function visualRound(after) {
    await page.keyboard.press('Space');
    const startT = await lastKey();
    await page.waitForSelector('#rt-pad.is-go', { timeout: 8000 });
    const go = await lastGo();
    // The wait before the green is random, from 2 to 5 seconds (plus any
    // delay of a busy test machine).
    assert.ok(go.frame - startT >= 1990 && go.t - startT <= 6000, `the green came ${Math.round(go.t - startT)} ms after the start`);
    await page.waitForFunction(g => performance.now() >= g, go.t + after, { polling: 4 });
    await page.keyboard.press('Space');
    const expected = Math.round((await lastKey()) - go.frame);
    const chips = await page.$$eval('#rt-rounds li', els => els.map(e => e.textContent));
    const shown = msOf(chips[chips.length - 1].split(': ')[1]);
    assert.equal(shown, expected, `shown ${shown} ms, measured from the frame ${expected} ms`);
    return shown;
  }

  // ---- Keyboard: Tab to the box, Space to start and to react ----
  await page.focus('input[name="rt-cue"][value="visual"]');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'rt-pad');
  const times = [];
  const y0 = await page.evaluate(() => window.scrollY);
  times.push(await visualRound(250));
  assert.equal(await page.evaluate(() => window.scrollY), y0, 'Space must not scroll the page');
  assert.ok(times[0] >= 250);
  assert.equal(await text('#rt-main'), times[0] + ' ms');
  assert.equal(await text('#rt-sub'), 'Click for round 2 of 5.');
  assert.equal(await text('#rt-sr'), `Round 1: ${times[0]} milliseconds.`);
  assert.deepEqual(await stats(), ['1 / 5', times[0] + ' ms', times[0] + ' ms', times[0] + ' ms', '0']);

  // ---- A press before the green is a false start ----
  // Holding Space starts the round once; the key's auto-repeat is not a press.
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  assert.match(await pad(), /is-wait/);
  assert.equal(await text('#rt-false'), '0');
  assert.equal(await text('#rt-main'), 'Wait for green…');
  assert.equal(await text('#rt-sub'), 'Round 2 of 5.');
  assert.equal(await text('#rt-sr'), 'Round 2 of 5. Wait for green.');
  await page.keyboard.press('Space');
  assert.equal(await text('#rt-main'), 'Too soon!');
  assert.equal(await text('#rt-sub'), 'You pressed before the green. Click to try this round again.');
  assert.match(await pad(), /is-soon/);
  assert.equal(await text('#rt-sr'), 'Too soon, false start 1. You pressed before the green.');
  assert.deepEqual(await stats(), ['1 / 5', times[0] + ' ms', times[0] + ' ms', times[0] + ' ms', '1']);

  // ---- Exact times: a key press made in the page a set time after the green ----
  // The page's clock starts at the frame that draws the green, so a frame
  // loop of this test's own knows that time; the press is made by spinning
  // until a set fraction of a millisecond past the target: 0.2 ms must be
  // rounded down and 0.6 ms up.
  await page.evaluate(() => {
    const el = document.getElementById('rt-pad');
    window.__respondAt = null;
    new MutationObserver(() => {
      if (window.__respondAt === null || !el.classList.contains('is-go')) return;
      const target = window.__lastFrame + window.__respondAt;
      window.__respondAt = null;
      // On a busy machine this can run, or the press be made, after the
      // target: then nothing is sent, and the round is abandoned and tried again.
      if (performance.now() > target - 0.05) { window.__missed = true; return; }
      while (performance.now() < target) { /* wait */ }
      const press = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
      if (press.timeStamp - target > 0.25) { window.__missed = true; return; }
      el.dispatchEvent(press);
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  async function exactRound(value, frac = 0.2) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const done = (await page.$$('#rt-rounds li')).length, soon = Number(await text('#rt-false'));
      await page.evaluate(v => { window.__respondAt = v; window.__missed = false; }, value + frac);
      await page.keyboard.press('Space');
      await page.waitForFunction(([n, f]) => window.__missed || document.querySelectorAll('#rt-rounds li').length > n ||
        Number(document.getElementById('rt-false').textContent) > f, [done, soon], { timeout: 7000 });
      if (!(await page.evaluate(() => window.__missed))) return;
      // Hiding the page pauses the round without counting it.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.hidden;
      });
      assert.equal(await text('#rt-main'), 'Paused');
    }
    throw new Error(`could not press exactly ${value + frac} ms after the green: the machine is too busy`);
  }

  // ---- A press less than 100 ms after the green is a guess ----
  await exactRound(99);
  assert.equal(await text('#rt-main'), 'Too soon!');
  assert.equal(await text('#rt-sub'), 'That was less than 100 ms after the green, which counts as a guess. Click to try this round again.');
  assert.equal(await text('#rt-false'), '2');
  assert.equal(await text('#rt-round'), '1 / 5');

  // ---- Rounding: two rounds that average x.5 with x even show x + 1 (half up) ----
  const half = 2 * Math.round((times[0] + 250) / 4);
  times.push(2 * half + 1 - times[0]);
  await exactRound(times[1]);
  assert.equal(await text('#rt-main'), times[1] + ' ms');
  assert.deepEqual(await stats(), ['2 / 5', (half + 1) + ' ms', (half + 1) + ' ms', Math.min(...times) + ' ms', '2']);
  // 100 ms exactly is not a guess.
  times.push(100);
  await exactRound(100);
  assert.equal(await text('#rt-main'), '100 ms');
  times.push(421);
  await exactRound(420, 0.6);
  assert.equal(await text('#rt-main'), '421 ms', '420.6 ms must be rounded to 421');
  // The last time makes the total end in 3 or 8, so the average is x.6 and rounds up.
  const sum4 = times.reduce((a, b) => a + b, 0);
  times.push(300 + ((3 - (sum4 + 300) % 5) + 5) % 5);
  await exactRound(times[4]);
  const sorted = times.slice().sort((a, b) => a - b);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / 5), med = sorted[2];
  assert.equal(times.reduce((a, b) => a + b, 0) % 5, 3);
  assert.equal(await text('#rt-main'), avg + ' ms average');
  assert.equal(await text('#rt-sub'), 'Click to start a new set.');
  assert.deepEqual(await stats(), ['5 / 5', avg + ' ms', med + ' ms', '100 ms', '2']);
  assert.deepEqual(await page.$$eval('#rt-rounds li', els => els.map(e => e.textContent)), times.map((t, i) => `${i + 1}: ${t} ms`));
  assert.equal(await text('#rt-res-avg'), String(avg));
  const faster = pct.text[String(avg)];
  assert.equal(await text('#rt-compare'), `Faster than ${faster} of the 70,940 scores in Human Benchmark’s results chart.`);
  assert.equal(await text('#rt-detail'), `Median ${med} ms, best ${sorted[0]} ms, slowest ${sorted[4]} ms. 2 false starts. Signal: box turns green.`);
  assert.equal(await text('#rt-session-best'), '');
  assert.deepEqual(await rows(), [['1', String(avg), String(med), '100', '2']]);
  assert.equal(await text('#rt-sr'), `Set 1 done. Average ${avg} milliseconds, median ${med}. Faster than ${faster} of Human Benchmark scores.`);
  await page.click('#rt-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
    `Reaction time test (box turns green): ${times.join(', ')} ms. Average ${avg} ms, median ${med} ms, best ${sorted[0]} ms. False starts: 2. Faster than ${faster} of Human Benchmark scores.`);

  // ---- Beep: the box does not change, the clock starts at the beep ----
  await page.check('input[name="rt-cue"][value="sound"]');
  assert.equal(await page.locator('#rt-try-beep').isVisible(), true);
  assert.equal(await text('#rt-sub'), 'When you hear the beep, click as fast as you can. The box does not change colour.');
  await page.evaluate(() => {
    window.__beeps = [];
    const proto = AudioScheduledSourceNode.prototype, start = proto.start, stop = proto.stop;
    proto.start = function (when) {
      const ctx = this.context;
      const out = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      window.__beeps.push({ when, ctxNow: ctx.currentTime, perfNow: performance.now(), lat: (ctx.outputLatency || 0) + (ctx.baseLatency || 0),
        out: out && { contextTime: out.contextTime, performanceTime: out.performanceTime }, stops: [] });
      if (window.__pressOnBeep) {
        window.__pressOnBeep = false;
        setTimeout(() => document.getElementById('rt-pad').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })), 0);
      }
      return start.apply(this, arguments);
    };
    proto.stop = function () {
      const b = window.__beeps[window.__beeps.length - 1];
      if (b) b.stops.push(arguments.length ? arguments[0] : 'now');
      return stop.apply(this, arguments);
    };
  });
  await page.click('#rt-try-beep');
  await page.waitForFunction(() => window.__beeps.length === 1);
  // Pressed after the beep was scheduled but before it played: a false start, and the beep is cut off.
  await page.evaluate(() => { window.__pressOnBeep = true; });
  await page.focus('#rt-pad');
  await page.keyboard.press('Space');
  assert.equal(await text('#rt-main'), 'Listen for the beep…');
  assert.equal(await pad(), 'rt-pad is-listen');
  await page.waitForFunction(() => document.getElementById('rt-main').textContent === 'Too soon!', null, { timeout: 7000 });
  assert.equal(await text('#rt-sub'), 'You pressed before the beep. Click to try this round again.');
  assert.ok((await page.evaluate(() => window.__beeps[1].stops)).includes('now'), 'the beep was not cancelled');
  // A real round: press 220 ms after the beep reaches the speaker.
  const logBeep = await page.evaluate(() => window.__log.length);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__beeps.length === 3, null, { timeout: 7000 });
  const b = await page.evaluate(() => window.__beeps[2]);
  const beepAt = b.perfNow + (b.when - b.ctxNow) * 1000 + b.lat * 1000;
  await page.waitForFunction(t => performance.now() >= t, beepAt + 220, { polling: 4 });
  await page.keyboard.press('Space');
  const pressed = await lastKey();
  const heard = pressed - beepAt;
  const shownBeep = msOf(await text('#rt-main'));
  assert.ok(Math.abs(shownBeep - heard) <= 50, `beep round: shown ${shownBeep} ms, measured ${heard.toFixed(1)} ms`);
  // Exactly: from when the browser's output time stamp says the beep reaches the speaker.
  const o = b.out;
  const spoke = o && o.contextTime > 0 && o.performanceTime > 0 ? o.performanceTime + (b.when - o.contextTime) * 1000 : beepAt;
  assert.ok(Math.abs(shownBeep - (pressed - spoke)) <= 1, `beep round: shown ${shownBeep} ms, from the output time stamp ${(pressed - spoke).toFixed(1)} ms`);
  const classes = await page.evaluate(n => window.__log.slice(n).map(x => x.cls), logBeep);
  assert.ok(classes.every(c => c === 'rt-pad is-listen' || c === 'rt-pad'), `the box changed in beep mode: ${classes.join(', ')}`);
  assert.deepEqual(await stats(), ['1 / 5', shownBeep + ' ms', shownBeep + ' ms', shownBeep + ' ms', '1']);
  // Playing the test beep during a round pauses the round: that beep is not
  // the signal, so a press after it must not count as a false start.
  await page.keyboard.press('Space');
  assert.equal(await text('#rt-main'), 'Listen for the beep…');
  await page.click('#rt-try-beep');
  assert.equal(await text('#rt-main'), 'Paused');
  assert.equal(await text('#rt-sub'), 'You played the test beep. This round was not counted. Click to carry on.');
  await page.focus('#rt-pad');
  await page.keyboard.press('Space');
  assert.equal(await text('#rt-main'), 'Listen for the beep…');
  assert.deepEqual(await stats(), ['1 / 5', shownBeep + ' ms', shownBeep + ' ms', shownBeep + ' ms', '1']);
  // Changing the signal in the middle of a set starts the set again.
  await page.check('input[name="rt-cue"][value="visual"]');
  assert.deepEqual(await stats(), ['0 / 5', '–', '–', '–', '0']);
  assert.equal(await text('#rt-sr'), 'Set restarted with the new signal.');
  assert.equal(await page.locator('#rt-try-beep').isVisible(), false);

  // ---- A hidden page or one restored from the cache pauses the round ----
  await page.focus('#rt-pad');
  await page.keyboard.press('Space');
  assert.match(await pad(), /is-wait/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  assert.equal(await text('#rt-main'), 'Paused');
  assert.equal(await text('#rt-sub'), 'The page was hidden. This round was not counted. Click to carry on.');
  assert.deepEqual(await stats(), ['0 / 5', '–', '–', '–', '0']);
  await page.keyboard.press('Space');
  assert.match(await pad(), /is-wait/);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await text('#rt-sub'), 'The page was reopened. This round was not counted. Click to carry on.');
  await page.click('#rt-restart');
  assert.equal(await text('#rt-main'), 'Click to start');
  assert.equal(await text('#rt-sr'), 'Set restarted.');
  // A signal the browser restored after the script ran is shown and used.
  await page.evaluate(() => {
    document.querySelector('input[name="rt-cue"][value="sound"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  assert.equal(await text('#rt-sub'), 'When you hear the beep, click as fast as you can. The box does not change colour.');
  assert.equal(await page.locator('#rt-try-beep').isVisible(), true);
  await page.focus('#rt-pad');
  await page.keyboard.press('Space');
  assert.equal(await pad(), 'rt-pad is-listen');
  await page.click('#rt-restart');

  // ---- Clear session ----
  await page.click('#rt-clear');
  assert.equal(await text('#rt-hist'), 'No sets finished yet.');
  assert.equal(await page.locator('#rt-result').isVisible(), false);
  assert.equal(await text('#rt-sr'), 'Session cleared.');

  // ---- Exact times on a fake clock, on a 320 px screen ----
  // Playwright's clock fakes performance.now(), timers, frames and the time
  // stamps of events made in the page, so the wait and the reaction are
  // exact to the millisecond: the shortest and longest wait, 99 and 100 ms
  // on the dot, and both ends of the percentile scale.
  const fake = await page.context().browser().newContext({ viewport: { width: 320, height: 700 } });
  const f = await fake.newPage();
  const ferrors = [];
  f.on('pageerror', e => ferrors.push(e.message));
  f.on('console', m => { if (m.type() === 'error') ferrors.push(m.text()); });
  await f.clock.install();
  await f.goto(url);
  await f.clock.pauseAt(Date.now() + 1000);
  await f.evaluate(() => {
    const el = document.getElementById('rt-pad');
    window.__go = [];
    new MutationObserver(() => { if (el.classList.contains('is-go')) window.__go.push(performance.now()); }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  const fkey = () => f.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    document.getElementById('rt-pad').dispatchEvent(e);
    return e.timeStamp;
  });
  const ftext = sel => f.textContent(sel);
  // Start a round with Math.random() returning `r`, run the clock to the
  // frame that turns the box green, press `after` ms later, and return how
  // long the wait was.
  async function fround(after, r) {
    await f.evaluate(v => { Math.random = () => v; }, r);
    const n = await f.evaluate(() => window.__go.length);
    const start = await fkey();
    await f.clock.runFor(Math.floor(2000 + r * 3000) - 5); // just before the wait the page should pick
    for (let i = 0; i < 40 && await f.evaluate(k => window.__go.length === k, n); i++) await f.clock.runFor(1);
    const go = await f.evaluate(() => window.__go[window.__go.length - 1]);
    const at = await f.evaluate(() => performance.now());
    assert.ok(go - start >= 2000 && at - go <= 1, `the green came ${Math.round(go - start)} ms after the start, wanted ${Math.floor(2000 + r * 3000)} ms`);
    await f.clock.runFor(go + after - at);
    assert.equal(Math.round((await fkey()) - go), after);
    return go - start;
  }
  // Set 1: the shortest wait is 2 seconds; 99 ms is a guess, 100 ms is not.
  let wait = await fround(99, 0);
  assert.ok(wait >= 2000 && wait < 2020, `the shortest wait was ${wait} ms`);
  assert.equal(await ftext('#rt-main'), 'Too soon!');
  assert.equal(await ftext('#rt-sub'), 'That was less than 100 ms after the green, which counts as a guess. Click to try this round again.');
  await fround(100, 0);
  assert.equal(await ftext('#rt-main'), '100 ms');
  for (const t of [120, 140, 160, 180]) await fround(t, 0);
  assert.deepEqual([await ftext('#rt-round'), await ftext('#rt-avg'), await ftext('#rt-med'), await ftext('#rt-best'), await ftext('#rt-false')],
    ['5 / 5', '140 ms', '140 ms', '100 ms', '1']);
  assert.equal(await ftext('#rt-compare'), `Faster than ${pct.text['140']} of the 70,940 scores in Human Benchmark’s results chart.`);
  assert.equal(await ftext('#rt-detail'), 'Median 140 ms, best 100 ms, slowest 180 ms. 1 false start. Signal: box turns green.');
  // Set 2: the longest wait is 5 seconds; a slow average is at the other end of the scale.
  wait = await fround(600, 0.9999999);
  assert.ok(wait >= 4999 && wait < 5020, `the longest wait was ${wait} ms`);
  for (const t of [600, 700, 800, 1200]) await fround(t, 0.5);
  assert.equal(await ftext('#rt-main'), '780 ms average');
  assert.equal(await ftext('#rt-compare'), `Faster than ${pct.text['780']} of the 70,940 scores in Human Benchmark’s results chart.`);
  assert.equal(await ftext('#rt-detail'), 'Median 700 ms, best 600 ms, slowest 1200 ms. 0 false starts. Signal: box turns green.');
  assert.equal(await ftext('#rt-session-best'), 'Best average this session: 140 ms.');
  assert.equal(await ftext('#rt-sr'), `Set 2 done. Average 780 milliseconds, median 700. Faster than ${pct.text['780']} of Human Benchmark scores.`);
  assert.deepEqual(await f.$$eval('#rt-hist tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent))),
    [['2', '780', '700', '600', '0'], ['1', '140', '140', '100', '1']]);
  // The session table fits its box at 320 px, so no column is hidden.
  const table = await f.evaluate(() => { const t = document.querySelector('.rt-hist'); return [t.scrollWidth, t.parentElement.clientWidth]; });
  assert.ok(table[0] <= table[1], `the session table is wider than its box at 320 px: ${table}`);
  // A screen reader activates the box with a click that has no press before
  // it (detail 0): that click starts a round and is timed as the response.
  const atClick = () => f.evaluate(() => { document.getElementById('rt-pad').click(); });
  await f.clock.runFor(1000);
  await f.evaluate(() => { Math.random = () => 0; });
  await atClick();
  assert.equal(await ftext('#rt-main'), 'Wait for green…');
  assert.equal(await ftext('#rt-round'), '0 / 5');
  await f.clock.runFor(1995);
  for (let i = 0; i < 40 && !/is-go/.test(await f.getAttribute('#rt-pad', 'class')); i++) await f.clock.runFor(1);
  const goAt = await f.evaluate(() => window.__go[window.__go.length - 1]);
  await f.clock.runFor(goAt + 300 - await f.evaluate(() => performance.now()));
  await atClick();
  assert.equal(await ftext('#rt-main'), '300 ms');
  // A press and the click that follows it (mouse, tap or a screen reader
  // that sends both) are one response, not two.
  await f.evaluate(() => {
    const el = document.getElementById('rt-pad');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    el.click();
  });
  assert.equal(await ftext('#rt-main'), 'Wait for green…');
  assert.equal(await ftext('#rt-false'), '0');
  assert.equal(await ftext('#rt-round'), '1 / 5');
  assert.deepEqual(ferrors, []);
  await fake.close();

  // ---- A phone without Web Audio: taps work, the beep reports an error ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  await phone.addInitScript(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; });
  const p = await phone.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(url);
  const box = await p.locator('#rt-pad').boundingBox();
  const tap = () => p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await tap();
  assert.match(await p.getAttribute('#rt-pad', 'class'), /is-wait/);
  await tap();
  assert.equal(await p.textContent('#rt-main'), 'Too soon!');
  await tap();
  await p.waitForSelector('#rt-pad.is-go', { timeout: 7000 });
  await p.waitForTimeout(200);
  await tap();
  assert.ok(msOf(await p.textContent('#rt-main')) >= 200, await p.textContent('#rt-main'));
  assert.equal(await p.textContent('#rt-round'), '1 / 5');
  assert.equal(await p.textContent('#rt-false'), '1');
  await p.check('input[name="rt-cue"][value="sound"]');
  await tap();
  assert.equal(await p.textContent('#rt-error'), 'The beep could not be played: this browser has not allowed sound yet. Click the box again, or choose Box turns green.');
  assert.equal(await p.getAttribute('#rt-pad', 'aria-describedby'), 'rt-error');
  assert.equal(await p.textContent('#rt-main'), 'No sound');
  await p.check('input[name="rt-cue"][value="visual"]');
  assert.equal(await p.textContent('#rt-error'), '');
  assert.equal(await p.getAttribute('#rt-pad', 'aria-describedby'), null);
  const sizes = await p.evaluate(() => ({
    chips: Math.min(...Array.from(document.querySelectorAll('.rt-chip span')).map(s => s.getBoundingClientRect().height)),
    restart: document.getElementById('rt-restart').getBoundingClientRect().height,
    pad: document.getElementById('rt-pad').getBoundingClientRect().height,
    touch: getComputedStyle(document.getElementById('rt-pad')).touchAction,
    overflow: document.documentElement.scrollWidth - innerWidth
  }));
  assert.ok(sizes.chips >= 44 && sizes.restart >= 44 && sizes.pad >= 200, JSON.stringify(sizes));
  assert.equal(sizes.touch, 'manipulation');
  assert.ok(sizes.overflow <= 1, `sideways scroll on a phone: ${sizes.overflow}px`);
  assert.deepEqual(errors, []);
  await phone.close();

  // ---- The guide's percentile table matches the chart ----
  const guide = await page.$$eval('.prose table', ts => {
    const t = ts.find(x => /Faster than/.test(x.textContent));
    return Array.from(t.querySelectorAll('tbody tr')).map(tr => Array.from(tr.cells).map(td => td.textContent));
  });
  assert.deepEqual(guide, Object.entries(pct.guide).map(([ms, s]) => [ms + ' ms', s.replace('about ', '')]));

  // ---- Homepage search finds the page under the words people use ----
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/reaction-time-test\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the reaction time test');
  for (const q of ['reaction time', 'reaction test', 'reflex', 'reaction speed', 'reaction time by age', 'average reaction time']) {
    assert.ok(q.split(' ').every(w => hay.includes(w)), `the homepage search finds nothing for "${q}"`);
  }
};
