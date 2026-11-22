const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Lengths read from the boxes and from addresses such as #1h30m, and the end
// times, come from tests/fixtures/online-timer/expected.py (exact fractions,
// digits of every script through Python's unicodedata), not from this page.
// The page runs on Playwright's test clock; the audio clock runs in real time,
// so the alarm's scheduling is checked against AudioContext.currentTime.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const T0 = Date.parse('2026-03-14T12:00:00Z');
  const iso = ms => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  await page.addInitScript(() => {
    // Every oscillator start and stop, with the audio clock at the call.
    window.__osc = [];
    const start = AudioScheduledSourceNode.prototype.start, stop = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.start = function (when = 0, ...rest) {
      if (this instanceof OscillatorNode) {
        this.__rec = { f: Math.round(this.frequency.value * 100) / 100, type: this.type, when, now: this.context.currentTime, stops: [] };
        window.__osc.push(this.__rec);
      }
      return start.call(this, when, ...rest);
    };
    AudioScheduledSourceNode.prototype.stop = function (when = 0) {
      if (this.__rec) this.__rec.stops.push({ when, now: this.context.currentTime });
      return stop.call(this, when);
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest instanceof AudioDestinationNode) window.__master = this;
      return connect.call(this, dest, ...rest);
    };
    // Notifications as a desktop browser shows them; __throws makes the
    // constructor fail as it does in Chrome on Android.
    window.__notes = [];
    window.__perm = 'default';
    window.__answer = 'granted';
    window.__throws = false;
    function N(title, opts) {
      if (window.__throws) throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
      window.__notes.push([title, opts && opts.body]);
      this.close = () => {};
    }
    Object.defineProperty(N, 'permission', { get: () => window.__perm });
    N.requestPermission = () => { window.__perm = window.__answer; return Promise.resolve(window.__answer); };
    window.Notification = N;
  });
  await page.clock.install({ time: T0 });
  await open();
  await page.clock.pauseAt(T0 + 5000);

  const text = s => page.locator(s).textContent();
  const hash = () => page.evaluate(() => location.hash);
  const status = () => text('#ot-status');
  const fieldsOf = n => Promise.all(['h', 'm', 's'].map(u => page.inputValue(`#ot-${n}-${u}`)));
  const invalidOf = n => Promise.all(['h', 'm', 's'].map(u => page.getAttribute(`#ot-${n}-${u}`, 'aria-invalid')));
  const timeOf = n => text(`#ot-${n} .ot-time`);
  const metaOf = n => text(`#ot-${n} .ot-meta`);
  const metaTime = n => page.getAttribute(`#ot-${n} .ot-meta time`, 'datetime');
  const goText = n => text(`#ot-${n} .ot-go`);
  const shown = s => page.isVisible(s);
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const reopen = async h => { await page.goto('about:blank'); await page.goto(url + h); };
  const oscCount = () => page.evaluate(() => window.__osc.length);
  const oscFrom = n => page.evaluate(n => window.__osc.slice(n), n);
  const wallNow = () => page.evaluate(() => Date.now());
  const setBoxes = async (n, [h, m, s]) => {
    await page.fill(`#ot-${n}-h`, h);
    await page.fill(`#ot-${n}-m`, m);
    await page.fill(`#ot-${n}-s`, s);
  };
  // Where the action buttons and what follows them sit on the page.
  const places = n => page.$$eval(`#ot-${n} .ot-actions .btn, .ot-more, .ot-settings`, els => els.filter(e => e.getClientRects().length).map(e => {
    const r = e.getBoundingClientRect();
    return [e.className, Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width)];
  }));
  // Once nothing is due to sound, the audio is suspended. The check runs on
  // the page's test clock and reads the audio clock, which runs in real time.
  const ctxState = () => page.evaluate(() => window.__master ? window.__master.context.state : 'none');
  const untilSuspended = async () => {
    for (let i = 0; i < 60 && await ctxState() !== 'suspended'; i++) { await page.clock.runFor(600); await page.waitForTimeout(20); }
    return ctxState();
  };
  const untilRunning = () => page.waitForFunction(() => window.__master && window.__master.context.state === 'running');
  const baseTitle = await page.title();

  // ---- Fresh page: one 5-minute timer, ready, and the address untouched. ----
  assert.equal(await page.locator('.ot-card').count(), 1);
  assert.deepEqual(await fieldsOf(1), ['00', '05', '00']);
  assert.equal(await goText(1), 'Start');
  assert.equal(await shown('#ot-1 .ot-presets'), true);
  assert.equal(await shown('#ot-1 .ot-run'), false);
  assert.equal(await shown('#ot-1 .ot-remove'), false);
  assert.equal(await page.getAttribute('#ot-1', 'aria-label'), 'Timer 1');
  assert.equal(await hash(), '');
  assert.equal(await page.title(), baseTitle);
  assert.equal(await text('#ot-sound-note'), '');
  assert.equal(await page.$eval('.ot-keys', el => getComputedStyle(el).display), 'block', 'the key hint shows with a mouse and keyboard');

  // ---- What the boxes accept: decimal points or commas, digits of any
  // script; raised digits, tabs, thousands separators and signs refused. ----
  for (const [boxes, r] of X.boxes) {
    const what = JSON.stringify(boxes);
    await setBoxes(1, boxes);
    const inv = await invalidOf(1), err = await text('#ot-1-err');
    if (r[0] === 'ok') {
      assert.deepEqual(inv, [null, null, null], what);
      assert.equal(err, '', what);
      assert.equal(await hash(), r[3], what);
    } else if (r[1] === 'max') {
      assert.equal(err, 'The longest timer is 99 hours 59 minutes 59 seconds.', what);
      assert.deepEqual(inv, ['true', 'true', 'true'], what);
    } else {
      const u = 'hms'[r[1]];
      assert.ok(err.startsWith(['Hours', 'Minutes', 'Seconds'][r[1]] + ': '), `${what}: ${err}`);
      assert.equal(inv[r[1]], 'true', what);
      assert.equal(await page.getAttribute(`#ot-1-${u}`, 'aria-describedby'), 'ot-1-err', what);
    }
  }
  await setBoxes(1, ['', '1e3', '']);
  assert.equal(await text('#ot-1-err'), 'Minutes: use a number such as 5 or 1.5, with no spaces or thousands separators.');
  // 1,500 is 1.5 to some readers and 1500 to others, so it is not guessed.
  await setBoxes(1, ['', '', '1,500']);
  assert.equal(await text('#ot-1-err'), 'Seconds: “1,500” could mean 1.5 or 1500, so type one of those.');
  await setBoxes(1, ['', '1.000', '']);
  assert.equal(await text('#ot-1-err'), 'Minutes: “1.000” could mean 1 or 1000, so type one of those.');
  // A megabyte pasted into a box is refused at once.
  let t0 = Date.now();
  await page.fill('#ot-1-m', '7'.repeat(1000000));
  assert.equal(await text('#ot-1-err'), 'Minutes: that is too long for a number.');
  assert.ok(Date.now() - t0 < 3000, 'a megabyte paste is refused quickly');
  // Zero cannot start; the message points at all three boxes.
  await setBoxes(1, ['0', '0', '0']);
  assert.equal(await text('#ot-1-err'), '');
  await page.click('#ot-1 .ot-go');
  assert.equal(await text('#ot-1-err'), 'Set a time longer than zero.');
  assert.deepEqual(await invalidOf(1), ['true', 'true', 'true']);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ot-1-h');
  // 90 minutes starts as 1:30:00, and Reset shows it that way.
  await setBoxes(1, ['', '90', '']);
  await page.click('#ot-1 .ot-go');
  assert.equal(await timeOf(1), '1:30:00');
  await page.click('#ot-1 .ot-reset');
  assert.deepEqual(await fieldsOf(1), X.fieldsAfter90);

  // ---- A 3-second timer: scheduled ahead on the audio clock, then rings. ----
  await setBoxes(1, ['0', '0', '3']);
  const n0 = await oscCount();
  await page.click('#ot-1 .ot-go');
  assert.equal(await goText(1), 'Pause');
  const placesRunning = await places(1);
  assert.equal(await timeOf(1), '00:03');
  assert.equal(await metaTime(1), X.end3);
  assert.match(await metaOf(1), /^Ends at /);
  assert.equal(await hash(), '#3s!r' + X.end3ms);
  assert.equal(await page.title(), '0:03 · ' + baseTitle);
  assert.equal(await status(), 'Timer 1 started: 3 seconds.');
  await page.waitForFunction(n => window.__osc.length > n, n0);
  const pre = await oscFrom(n0);
  assert.equal(pre[0].f, 880);
  assert.ok(Math.abs(pre[0].when - pre[0].now - 3) < 0.03, `the alarm was scheduled ${pre[0].when - pre[0].now} s ahead`);
  await page.clock.runFor(1000);
  assert.equal(await timeOf(1), '00:02');
  assert.equal(await page.title(), '0:02 · ' + baseTitle);
  const n1 = await oscCount();
  // The end check fires 1 ms after the end, so run a frame past it.
  await page.clock.runFor(2020);
  assert.equal(await timeOf(1), '00:00');
  assert.equal(await text('#ot-alert'), 'Time’s up: Timer 1.');
  assert.ok(await page.$eval('#ot-1', el => el.classList.contains('is-done') && el.classList.contains('is-ringing')));
  // The main button stops the alarm, so no button appears or moves.
  assert.equal(await goText(1), 'Stop alarm');
  assert.deepEqual(await places(1), placesRunning);
  assert.equal(await page.title(), 'Time’s up! · ' + baseTitle);
  assert.equal(await metaTime(1), X.end3);
  assert.match(await metaOf(1), /^Time’s up at .+ · 0:00 ago$/);
  assert.equal(await hash(), '#3s!d' + X.end3ms);
  // The test clock jumped 3 s while the audio clock moved on a fraction of
  // that, as after a sleeping laptop wakes: the alarm scheduled for later is
  // cancelled before it plays, and one rings now.
  const early = (await oscFrom(n0)).slice(0, n1 - n0);
  assert.ok(early.length > 0 && early.every(r => r.stops.length && r.stops[r.stops.length - 1].when <= r.when), 'the early alarm is cancelled');
  const ring = await oscFrom(n1);
  assert.ok(ring.length > 0 && Math.abs(ring[0].when - ring[0].now) < 0.1, 'the alarm rings at once');
  // Pressed from the keyboard, the focus stays on it; pressed again
  // straight after (a double click), it does not restart the timer.
  await page.focus('#ot-1 .ot-go');
  await page.keyboard.press('Enter');
  assert.equal(await goText(1), 'Restart');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'btn ot-go');
  assert.equal(await status(), 'Alarm stopped.');
  assert.equal(await text('#ot-alert'), '');
  assert.ok((await oscFrom(n1)).every(r => r.stops.length >= 2 && r.stops[r.stops.length - 1].when - r.stops[r.stops.length - 1].now < 0.1), 'Stop alarm stops every scheduled sound');
  await page.keyboard.press('Enter');
  assert.equal(await goText(1), 'Restart', 'a second press straight after does not restart');
  assert.equal(await page.title(), 'Time’s up · ' + baseTitle);
  // Nothing counts down or rings: the audio is suspended once the alarm has
  // faded, with no note asking for a click.
  await page.clock.runFor(700);
  assert.equal(await untilSuspended(), 'suspended');
  assert.equal(await text('#ot-sound-note'), '');
  // 0.7 s on, a press restarts the timer, and the audio runs again.
  await blur();
  await page.keyboard.press('Space');
  assert.equal(await status(), 'Timer 1 restarted: 3 seconds.');
  await untilRunning();
  // R never wipes a countdown, not even with the focus on Pause; it resets
  // a paused timer.
  await page.focus('#ot-1 .ot-go');
  await page.keyboard.press('r');
  assert.equal(await status(), 'Timer 1 is running. Pause it before you reset it with R.');
  assert.equal(await goText(1), 'Pause');
  await blur();
  await page.keyboard.press('r');
  assert.equal(await goText(1), 'Pause');
  await page.keyboard.press('Space');
  await page.keyboard.press('r');
  assert.equal(await status(), 'Timer 1 reset to 3 seconds.');
  assert.deepEqual(await fieldsOf(1), ['00', '00', '03']);
  // Pause pressed in the very millisecond the time runs out ends the timer:
  // a paused timer with nothing left could not be read back from the address.
  await page.keyboard.press('Space');
  await page.clock.runFor(3000);
  assert.equal(await goText(1), 'Pause');
  await page.keyboard.press('Space');
  assert.equal(await goText(1), 'Stop alarm');
  assert.match(await hash(), /^#3s!d\d{13}$/);
  await page.keyboard.press('Escape');
  assert.equal(await goText(1), 'Restart');
  await page.keyboard.press('r');

  // +1 min moves the alarm scheduled ahead at once, not at the next check.
  const k0 = await oscCount();
  await page.click('#ot-1 .ot-go');
  await page.waitForFunction(k => window.__osc.length > k, k0);
  const k1 = await oscCount();
  await page.click('#ot-1 .ot-plus');
  assert.ok(k1 > k0 && (await oscFrom(k0)).slice(0, k1 - k0).every(r => r.stops.length > 1 && r.stops[r.stops.length - 1].when <= r.when), 'the alarm at the old end is cancelled');
  const moved = await oscFrom(k1);
  assert.ok(moved.length && Math.abs(moved[0].when - moved[0].now - 63) < 0.05, `the alarm is ${moved.length && moved[0].when - moved[0].now} s ahead`);
  // Reset hides itself and +1 min: the focus moves to the main button
  // rather than being dropped to the page.
  await page.focus('#ot-1 .ot-reset');
  await page.keyboard.press('Enter');
  assert.equal(await goText(1), 'Start');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'btn ot-go');

  // ---- Preset, pause, resume, +1 min. ----
  await page.click('#ot-1 [data-min="10"]');
  assert.equal(await status(), 'Timer 1 started: 10 minutes.');
  assert.equal(await timeOf(1), '10:00');
  await page.clock.fastForward(60000);
  assert.equal(await timeOf(1), '09:00');
  assert.equal(await ctxState(), 'running', 'the audio runs while a timer counts down, its alarm scheduled ahead');
  await blur();
  await page.keyboard.press('Space');
  assert.equal(await status(), 'Timer 1 paused with 9 minutes left.');
  assert.equal(await goText(1), 'Resume');
  assert.equal(await metaOf(1), 'Paused');
  assert.equal(await hash(), '#10m!p540000');
  assert.equal(await page.title(), '9:00 paused · ' + baseTitle);
  await page.clock.fastForward(300000);
  assert.equal(await timeOf(1), '09:00');
  assert.equal(await untilSuspended(), 'suspended', 'but not while it is paused');
  assert.equal(await text('#ot-sound-note'), '');
  await page.click('#ot-1 .ot-go');
  assert.equal(await status(), 'Timer 1 resumed with 9 minutes left.');
  await untilRunning();
  await page.clock.fastForward(60000);
  assert.equal(await timeOf(1), '08:00');
  await page.click('#ot-1 .ot-plus');
  assert.equal(await timeOf(1), '09:00');
  assert.equal(await status(), 'Added 1 minute to Timer 1: 9 minutes left.');
  let w = await wallNow();
  assert.equal(await hash(), '#10m!r' + (w + 540000));
  assert.equal(await metaTime(1), iso(w + 540000));

  // ---- A reload keeps it running; a click lets it make sound again. ----
  await page.reload();
  assert.equal(await timeOf(1), '09:00');
  assert.equal(await goText(1), 'Pause');
  assert.equal(await text('#ot-sound-note'), 'Click or tap anywhere on this page so the alarm can sound.');
  await page.click('h1');
  await page.waitForFunction(() => document.querySelector('#ot-sound-note').textContent === '' && window.__osc.length > 0);
  const pre2 = await oscFrom(0);
  assert.ok(Math.abs(pre2[0].when - pre2[0].now - 540) < 0.05, `scheduled ${pre2[0].when - pre2[0].now} s ahead`);

  // ---- The device sleeps for 20 minutes: the timer ended 11 minutes ago,
  // so it shows when it ended and does not ring late. ----
  const endWall = Number((await hash()).match(/!r(\d+)/)[1]);
  const n4 = await oscCount();
  w = await wallNow();
  await page.clock.setSystemTime(w + 20 * 60000);
  await page.clock.runFor(100);
  assert.equal(await goText(1), 'Restart');
  assert.equal(await page.$eval('#ot-1', el => el.classList.contains('is-ringing')), false);
  assert.equal(await metaTime(1), iso(endWall));
  assert.match(await status(), /^Timer 1 ended at .+\.$/);
  assert.equal(await text('#ot-alert'), '');
  assert.equal((await oscFrom(n4)).filter(r => Math.abs(r.when - r.now) < 1).length, 0, 'no late ringing');
  assert.equal(await hash(), '#10m!d' + endWall);

  // ---- Two timers; keys act on the one used last. ----
  await blur();
  await page.keyboard.press('r');
  assert.equal(await goText(1), 'Start');
  await page.click('#ot-1 [data-min="1"]');
  await page.click('#ot-add');
  assert.equal(await status(), 'Timer 2 added.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ot-2-m');
  assert.equal(await shown('#ot-1 .ot-remove'), true);
  await page.fill('#ot-2-name', 'Eggs');
  assert.equal(await page.getAttribute('#ot-2', 'aria-label'), 'Eggs');
  assert.equal(await page.$eval('#ot-2 .ot-remove', b => b.textContent), 'Remove Eggs');
  await setBoxes(2, ['0', '0', '5']);
  await page.press('#ot-2-s', 'Enter');
  assert.equal(await status(), 'Eggs started: 5 seconds.');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'btn ot-go', 'the focus moves to Pause when the boxes hide');
  // The name stays out of the tab title, which a shared screen shows.
  assert.equal(await page.title(), '0:05 · ' + baseTitle);
  await page.clock.runFor(5020);
  assert.equal(await text('#ot-alert'), 'Time’s up: Eggs.');
  assert.equal(await page.title(), 'Time’s up! · ' + baseTitle);
  assert.equal(await timeOf(1), '00:55');
  assert.match(await hash(), /^#1m!r\d{13},5s!d\d{13}~Eggs$/);
  await page.keyboard.press('Escape');
  assert.equal(await goText(2), 'Restart');
  assert.equal(await page.title(), '0:55 · ' + baseTitle);
  await blur();
  await page.keyboard.press('r');
  assert.equal(await goText(2), 'Start');
  assert.equal(await goText(1), 'Pause');
  await page.click('#ot-2 .ot-remove');
  assert.equal(await page.locator('.ot-card').count(), 1);
  assert.equal(await status(), 'Eggs removed.');
  assert.match(await hash(), /^#1m!r\d{13}$/);
  // Keys do nothing while typing in a box.
  await page.focus('#ot-1-name');
  await page.keyboard.press('Space');
  assert.equal(await goText(1), 'Pause');
  assert.equal(await page.inputValue('#ot-1-name'), ' ');
  await page.fill('#ot-1-name', '');

  // ---- Notifications. ----
  await page.click('#ot-notify');
  await page.waitForFunction(() => window.__notes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__notes[0]), ['Notifications are on', 'You will get one when a timer ends.']);
  assert.equal(await page.getAttribute('#ot-notify', 'aria-invalid'), null);
  // None while the page is in front of you, where the alarm and the page show it.
  await page.evaluate(() => { document.hasFocus = () => true; });
  await page.click('#ot-1 .ot-reset'); // R leaves a running timer alone
  await setBoxes(1, ['0', '0', '1']);
  await page.click('#ot-1 .ot-go');
  await page.clock.runFor(1020);
  assert.equal(await text('#ot-alert'), 'Time’s up: Timer 1.');
  assert.equal(await page.evaluate(() => window.__notes.length), 1, 'no notification while the page has the focus');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.hasFocus = () => false; });
  await blur();
  await page.keyboard.press('r');
  await setBoxes(1, ['0', '0', '2']);
  await page.click('#ot-1 .ot-go');
  await page.clock.runFor(2020);
  const note = await page.evaluate(() => window.__notes[1]);
  assert.equal(note[0], 'Time’s up: Timer 1');
  assert.match(note[1], /^2 seconds timer, ended at .+\.$/);
  await page.keyboard.press('Escape');
  // Chrome on Android: the constructor throws.
  await page.click('#ot-notify');
  await page.evaluate(() => { window.__throws = true; });
  await page.click('#ot-notify');
  await page.waitForFunction(() => !document.querySelector('#ot-notify').checked);
  assert.match(await text('#ot-notify-msg'), /does not let web pages show notifications/);
  assert.equal(await page.getAttribute('#ot-notify', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#ot-notify', 'aria-describedby'), 'ot-notify-msg');
  // Refused.
  await page.evaluate(() => { window.__throws = false; window.__perm = 'default'; window.__answer = 'denied'; });
  await page.click('#ot-notify');
  await page.waitForFunction(() => !document.querySelector('#ot-notify').checked && /blocked/.test(document.querySelector('#ot-notify-msg').textContent));
  assert.equal(await page.getAttribute('#ot-notify', 'aria-invalid'), 'true');

  // ---- Sounds, volume and how long the alarm rings. ----
  const sounds = [['beeps', 'Beeps', [1760], 'triangle'], ['chime', 'Chime', [1046.5, 1318.51, 2093, 2637.02], 'sine'],
    ['clock', 'Alarm clock', [2349.32], 'triangle'], ['soft', 'Soft', [523.25, 659.26, 783.99], 'sine'],
    ['bell', 'Bell', [880, 2428.8, 4752, 7858.4], 'sine']];
  // Nothing counts down or rings: the audio is suspended, and a test sound
  // resumes it, still at once.
  assert.equal(await untilSuspended(), 'suspended');
  for (const [key, label, freqs, type] of sounds) {
    await page.selectOption('#ot-sound', key);
    const k = await oscCount();
    await page.click('#ot-test');
    const got = await oscFrom(k);
    assert.deepEqual([...new Set(got.map(r => r.f))].sort((a, b) => a - b), freqs, key);
    assert.ok(got.every(r => r.type === type && r.when >= r.now), key);
    assert.ok(got[0].when - got[0].now < 0.1, `${key} plays at once`);
    assert.equal(await status(), `Playing the ${label} sound.`);
    if (key === 'beeps') assert.deepEqual(got.map(r => Math.round((r.when - got[0].when) * 100) / 100), [0, 0.12, 0.24, 0.36]);
  }
  await untilRunning();
  await page.focus('#ot-vol');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#ot-vol-out'), '50%');
  assert.equal(await page.getAttribute('#ot-vol', 'aria-valuetext'), '50%');
  await page.waitForFunction(() => Math.abs(window.__master.gain.value - 0.25) < 0.005);
  // Beeps for 5 seconds: 5 rounds of 4 beeps, then it stops by itself.
  await page.selectOption('#ot-sound', 'beeps');
  await page.selectOption('#ot-ring', '5');
  await blur();
  await page.keyboard.press('r');
  await setBoxes(1, ['0', '0', '1']);
  // Counted from before the start: the alarm scheduled ahead, or the one
  // started at the end if the audio clock was too far ahead (not cancelled
  // either way).
  const k5 = await oscCount();
  await page.click('#ot-1 .ot-go');
  await page.clock.runFor(1020);
  const five = (await oscFrom(k5)).filter(r => r.stops.length === 1);
  assert.equal(five.length, 20);
  assert.equal(await goText(1), 'Stop alarm');
  await page.waitForTimeout(4800);
  await page.clock.runFor(20);
  assert.equal(await goText(1), 'Restart', 'a 5-second alarm stops by itself');
  // The audio is suspended only once the last beep has died away.
  const lastBeep = Math.max(...five.map(r => r.stops[0].when));
  assert.equal(await untilSuspended(), 'suspended');
  assert.ok(await page.evaluate(() => window.__master.context.currentTime) >= lastBeep, 'no beep is cut short');
  // Until stopped: rings are scheduled a minute ahead and go on.
  await page.selectOption('#ot-ring', '0');
  await page.clock.runFor(700);
  await blur();
  const kU = await oscCount();
  await page.keyboard.press('Space');
  await untilRunning();
  await page.clock.runFor(1020);
  const until = (await oscFrom(kU)).filter(r => r.stops.length === 1);
  assert.ok(until[until.length - 1].when - until[0].when >= 60, 'a minute of ringing is scheduled');
  await page.keyboard.press('Escape');
  assert.equal(await goText(1), 'Restart');
  await page.selectOption('#ot-ring', '30');

  // ---- Full screen. ----
  await page.click('#ot-1 .ot-full');
  await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'ot-1');
  assert.equal(await text('#ot-1 .ot-full'), 'Exit full screen');
  assert.equal(await page.$eval('#ot-add', el => !!el.closest('[inert]')), true);
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.$eval('#ot-add', el => !!el.closest('[inert]')), false);

  // ---- Addresses. ----
  for (const [h, f, canon] of X.hashes) {
    await reopen(h);
    assert.deepEqual(await fieldsOf(1), f, h);
    assert.equal(await text('#ot-msg'), '', h);
    assert.equal(await hash(), canon, h);
  }
  for (const h of X.bad) {
    await reopen(h);
    assert.match(await text('#ot-msg'), /^Part of the page address could not be read as a timer: “.+”\.$/, h);
    assert.deepEqual(await fieldsOf(1), ['00', '05', '00'], h);
    assert.equal(await hash(), h, 'an address that could not be read is left as it was typed');
  }
  // A link to a heading of the guide is a link, not a broken timer.
  await reopen('#how-to-set-a-timer');
  assert.equal(await text('#ot-msg'), '');
  assert.deepEqual(await fieldsOf(1), ['00', '05', '00']);
  assert.equal(await hash(), '#how-to-set-a-timer');
  // An end time far back is shown with its date, never as a bare weekday.
  w = await wallNow();
  await reopen(`#10m!d${w - 10 * 86400000}`);
  assert.equal(await metaTime(1), iso(w - 10 * 86400000));
  assert.match(await metaOf(1), /^Time’s up at .*\b4\b.*Mar|^Time’s up at .*Mar.*\b4\b/);
  // An end in the future is refused for a timer that has ended, unless it is
  // less than a minute off (a clock a little fast): then it ended just now.
  // Ends in 1970 and in the year 33658 are among the addresses refused above.
  w = await wallNow();
  await reopen(`#10m!d${w + 30000}`);
  assert.equal(await text('#ot-msg'), '');
  assert.equal(await goText(1), 'Restart');
  assert.ok(Number((await hash()).slice(6)) <= await wallNow(), await hash());
  await reopen(`#10m!d${w + 3600000}`);
  assert.match(await text('#ot-msg'), /^Part of the page address could not be read as a timer/);
  await reopen('#10m,3m~P%C3%A2tes%20%F0%9F%8D%9D');
  assert.equal(await page.locator('.ot-card').count(), 2);
  assert.equal(await page.inputValue('#ot-2-name'), 'Pâtes 🍝');
  assert.equal(await page.getAttribute('#ot-2', 'aria-label'), 'Pâtes 🍝');
  // Names are cut to 40 characters, never inside an emoji.
  await reopen('#3m~' + 'a'.repeat(39) + '%F0%9F%8D%9D');
  assert.equal(await page.inputValue('#ot-1-name'), 'a'.repeat(39));
  await page.fill('#ot-1-name', 'x'.repeat(1000000));
  assert.equal(await hash(), '#3m~' + 'x'.repeat(40));
  await reopen('#' + Array(11).fill('1m').join(','));
  assert.equal(await page.locator('.ot-card').count(), 10);
  assert.match(await text('#ot-msg'), /^Only the first 10 timers/);
  assert.equal(await page.getAttribute('#ot-add', 'aria-disabled'), 'true');
  // Dimmed by colour, not opacity, which would fade its focus ring too.
  await page.focus('#ot-add');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const dim = await page.$eval('#ot-add', el => {
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const cs = getComputedStyle(el);
    return { focus: el.matches(':focus-visible'), op, ring: cs.outlineStyle + ' ' + cs.outlineColor, color: cs.color };
  });
  assert.ok(dim.focus && dim.op === 1 && /^solid rgb\(\d+, \d+, \d+\)$/.test(dim.ring), JSON.stringify(dim));
  assert.match(dim.color, / \/ 0\.5\)$/, 'the label is dimmed');
  // A contrast theme replaces those colours; the button is then greyed with its GrayText.
  await page.emulateMedia({ forcedColors: 'active' });
  const [fullInk, addInk] = await page.$$eval('#ot-1 .ot-full, #ot-add', els => els.map(e => getComputedStyle(e).color)); // page order
  assert.notEqual(addInk, fullInk, 'Add a timer still looks unavailable in a contrast theme');
  await page.emulateMedia({ forcedColors: 'none' });
  await page.click('#ot-add', { force: true });
  assert.match(await text('#ot-msg'), /10 timers is the most/);
  await reopen('#' + '1m,'.repeat(1500));
  assert.match(await text('#ot-msg'), /longer than 4,000 characters/);
  assert.equal(await page.locator('.ot-card').count(), 1);
  t0 = Date.now();
  await reopen('#' + '1m,'.repeat(400000));
  assert.match(await text('#ot-msg'), /longer than 4,000 characters/);
  assert.ok(Date.now() - t0 < 5000);
  // A message quoting the address never cuts an emoji in half.
  await reopen('#' + 'a'.repeat(39) + '%F0%9F%8D%9Db');
  const quoted = await text('#ot-msg');
  assert.ok(quoted.includes('“' + 'a'.repeat(39) + '…”'), quoted);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(quoted));
  // Paused, running and finished timers; one ending beyond 99:59:59 is refused.
  w = await wallNow();
  await reopen(`#10m!p90000,10m!r${w + 120000},10m!r${w - 1000},10m!d${w - 60000},10m!r${w + 400 * 3600000}`);
  assert.equal(await page.locator('.ot-card').count(), 4);
  assert.equal(await timeOf(1), '01:30');
  assert.equal(await goText(1), 'Resume');
  assert.equal(await timeOf(2), '02:00');
  assert.equal(await goText(2), 'Pause');
  assert.equal(await goText(3), 'Restart');
  assert.equal(await metaTime(3), iso(w - 1000));
  assert.equal(await metaTime(4), iso(w - 60000));
  assert.equal(await page.locator('.ot-card.is-ringing').count(), 0, 'nothing rings for timers that ended while the page was closed');
  assert.match(await text('#ot-msg'), /could not be read as a timer/);
  // A link to another timer adds it while timers are counting...
  await page.evaluate(() => { location.hash = '#3m~Tea'; });
  await page.waitForFunction(() => document.querySelectorAll('.ot-card').length === 5);
  assert.equal(await page.inputValue('#ot-5-name'), 'Tea');
  assert.equal(await goText(2), 'Pause');
  // ...and replaces the timers when none has started.
  await reopen('#10m');
  await page.evaluate(() => { location.hash = '#3m'; });
  await page.waitForFunction(() => document.querySelector('#ot-2-m') && document.querySelector('#ot-2-m').value === '03');
  assert.equal(await page.locator('.ot-card').count(), 1);
  // Back and Forward after following a link while a timer counts do not
  // copy the timers again, and neither does the same link followed twice.
  await reopen('#10m');
  await page.click('#ot-1 .ot-go');
  await page.evaluate(() => { location.hash = '#3m~Tea'; });
  await page.waitForFunction(() => document.querySelectorAll('.ot-card').length === 2);
  await page.click('#ot-1 .ot-go'); // paused since the address before was written
  await page.goBack();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.ot-card').count(), 2, 'Back');
  assert.equal(await goText(1), 'Resume');
  assert.match(await hash(), /^#10m!p\d+,3m~Tea$/, 'Back brings the address up to date');
  await page.goForward();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.ot-card').count(), 2, 'Forward');
  await page.click('#ot-1 .ot-go');
  await page.evaluate(() => { location.hash = '#3m~Tea'; });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.ot-card').count(), 2, 'the same link again');
  assert.match(await hash(), /^#10m!r\d{13},3m~Tea$/);
  await page.evaluate(() => { location.hash = '#3m~Tea,4m'; });
  await page.waitForFunction(() => document.querySelectorAll('.ot-card').length === 3);
  await reopen('#10m');
  await page.evaluate(() => { location.hash = '#3m'; });
  await page.waitForFunction(() => document.querySelector('#ot-2-m') && document.querySelector('#ot-2-m').value === '03');
  // Boxes the browser fills back in after Back are read again on pageshow.
  await page.evaluate(() => {
    document.querySelector('#ot-2-m').value = '7';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await hash(), '#7m');

  const browser = page.context().browser();
  // ---- A decimal-comma locale reads the boxes the same way. ----
  const de = await browser.newContext({ locale: 'de-DE' });
  const dp = await de.newPage();
  await dp.goto(url);
  for (const v of ['1,5', '1.5']) {
    await dp.fill('#ot-1-h', v);
    await dp.fill('#ot-1-m', '0');
    assert.equal(await dp.evaluate(() => location.hash), '#1h30m', v);
  }
  await de.close();

  // ---- No Fullscreen API (iPhone): the timer fills the window; Esc leaves. ----
  const ip = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const p2 = await ip.newPage();
  await p2.addInitScript(() => { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; });
  await p2.goto(url + '#1h30m');
  await p2.tap('#ot-1 .ot-full');
  const r = await p2.$eval('#ot-1', el => el.getBoundingClientRect().toJSON());
  assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, 390, 844]);
  assert.equal(await p2.evaluate(() => document.fullscreenElement), null);
  assert.equal(await p2.$eval('#ot-add', el => !!el.closest('[inert]')), true);
  await p2.keyboard.press('Escape');
  assert.equal(await p2.$eval('#ot-1', el => el.classList.contains('is-full')), false);
  assert.equal(await p2.$eval('#ot-add', el => !!el.closest('[inert]')), false);
  await ip.close();

  // ---- A phone with a touch screen. ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  const outside = [];
  await pp.route('**/*', route => { if (!route.request().url().startsWith(base)) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
  await pp.goto(url);
  for (const sel of ['#ot-1 [data-min="1"]', '#ot-1 [data-min="60"]', '#ot-1 .ot-go', '#ot-1 .ot-full', '#ot-add', '#ot-test', '#ot-1-m']) {
    const b = await pp.locator(sel).boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${sel} is ${b.width}x${b.height}`);
  }
  await pp.tap('#ot-1 [data-min="1"]');
  assert.match(await pp.textContent('#ot-1 .ot-time'), /^0[01]:[0-5]\d$/);
  assert.equal(await pp.textContent('#ot-1 .ot-go'), 'Pause');
  assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on the phone');
  assert.deepEqual(outside, []);
  // Two quick taps on +1 min add two minutes, not a double-tap zoom (iPhone).
  assert.equal(await pp.$eval('#ot-1 .ot-plus', el => getComputedStyle(el).touchAction), 'manipulation');
  // The key hint is for keyboards; a touch screen does not show it.
  assert.equal(await pp.$eval('.ot-keys', el => getComputedStyle(el).display), 'none');
  // When the alarm starts, no button appears or moves under a finger and
  // nothing shifts (412 px wide: two buttons a row).
  await pp.goto('about:blank');
  await pp.goto(url + '#1s');
  await pp.tap('#ot-1 .ot-go');
  await pp.evaluate(() => {
    window.__shift = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: 'layout-shift' });
  });
  const spots = () => pp.$$eval('#ot-1 .ot-actions .btn, .ot-more, .ot-settings', els => els.filter(e => e.getClientRects().length).map(e => {
    const r = e.getBoundingClientRect();
    return [e.className, Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width)];
  }));
  const spotsRunning = await spots();
  await pp.waitForSelector('#ot-1.is-ringing', { timeout: 5000 });
  assert.equal(await pp.textContent('#ot-1 .ot-go'), 'Stop alarm');
  assert.deepEqual(await spots(), spotsRunning);
  assert.equal(await pp.evaluate(() => window.__shift), 0, 'no layout shift when the alarm starts');
  // No label breaks over two lines, down to 320 px and with several timers.
  const twoLines = () => pp.$$eval('#ot-list .btn', bs => bs.filter(b => b.getClientRects().length).map(b => {
    const r = document.createRange(); r.selectNodeContents(b.firstChild);
    return [b.textContent, new Set([...r.getClientRects()].map(x => Math.round(x.top))).size, b.scrollWidth > b.clientWidth];
  }).filter(x => x[1] > 1 || x[2]));
  for (const width of [320, 360, 390]) {
    await pp.setViewportSize({ width, height: 700 });
    for (const h of ['#10m', '#10m~Eggs,3m~Tea', '#1s~Eggs,3m~Tea']) {
      // A fresh load: going to an address that differs only after the #
      // would add these timers to the ones on the page.
      await pp.goto('about:blank');
      await pp.goto(url + h);
      if (h.startsWith('#1s')) { await pp.tap('#ot-1 .ot-go'); await pp.waitForSelector('#ot-1.is-ringing', { timeout: 5000 }); }
      assert.deepEqual(await twoLines(), [], `${width} px, ${h}`);
      assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll at ${width} px, ${h}`);
    }
  }
  await pp.goto('about:blank');
  await pp.goto(url + '#10m');
  await pp.evaluate(() => { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; });
  await pp.tap('#ot-1 .ot-full');
  assert.deepEqual(await twoLines(), [], 'full screen at 390 px');
  await phone.close();
};
