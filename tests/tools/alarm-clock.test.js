const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// How typed times are read and when alarms ring (time zones, the hour the
// clocks skip or repeat) come from tests/fixtures/alarm-clock/expected.py
// (zoneinfo and unicodedata), not from this page. The page runs on
// Playwright's test clock; the audio clock runs in real time, so the alarm's
// scheduling is checked against AudioContext.currentTime.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  // New York in November is UTC-5 all month: est(2026, 11, 23, 7, 0) is 07:00 there.
  const est = (y, mo, d, h, m) => Date.UTC(y, mo - 1, d, h + 5, m);
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const H12 = hhmm => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

  // Every sound started, browser features the page asks for, and what it
  // does with them; the wake lock, battery, vibration and iPhone audio
  // session are stand-ins, as headless Chromium has none of them.
  const INIT = () => {
    window.__osc = [];
    // AudioBufferSourceNode has a start() of its own.
    const wrap = (proto, start) => { proto.start = function (when = 0, ...rest) { return record.call(this, start, when, rest); }; };
    const record = function (start, when, rest) {
      const osc = this instanceof OscillatorNode, buf = this instanceof AudioBufferSourceNode && this.buffer && this.buffer.length > 1;
      if (osc || buf) {
        this.__rec = { kind: osc ? 'osc' : 'buf', f: osc ? Math.round(this.frequency.value * 100) / 100 : 0, type: osc ? this.type : '', when, now: this.context.currentTime, wall: Date.now(), stops: [] };
        if (buf) {
          const d = this.buffer.getChannelData(0);
          let peak = 0;
          for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
          Object.assign(this.__rec, { loop: this.loop, dur: this.buffer.duration, ch: this.buffer.numberOfChannels, peak });
        }
        window.__osc.push(this.__rec);
      }
      return start.call(this, when, ...rest);
    };
    wrap(AudioScheduledSourceNode.prototype, AudioScheduledSourceNode.prototype.start);
    if (Object.prototype.hasOwnProperty.call(AudioBufferSourceNode.prototype, 'start')) wrap(AudioBufferSourceNode.prototype, AudioBufferSourceNode.prototype.start);
    const stop = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.stop = function (when = 0) {
      if (this.__rec) this.__rec.stops.push({ when, now: this.context.currentTime });
      return stop.call(this, when);
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest instanceof AudioDestinationNode) window.__master = this;
      return connect.call(this, dest, ...rest);
    };
    window.__ramps = [];
    const setV = AudioParam.prototype.setValueAtTime, expR = AudioParam.prototype.exponentialRampToValueAtTime;
    AudioParam.prototype.setValueAtTime = function (v, t) { if (v === 0.05) window.__ramps.push(['from', v, t]); return setV.call(this, v, t); };
    AudioParam.prototype.exponentialRampToValueAtTime = function (v, t) { window.__ramps.push(['to', v, t]); return expR.call(this, v, t); };
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
    window.__wake = { requests: 0, held: 0, refuse: false };
    const lock = { request(type) {
      window.__wake.requests++;
      if (window.__wake.refuse) return Promise.reject(new DOMException('Battery low', 'NotAllowedError'));
      const s = new EventTarget();
      s.type = type;
      s.released = false;
      s.release = () => { if (!s.released) { s.released = true; window.__wake.held--; s.dispatchEvent(new Event('release')); } return Promise.resolve(); };
      window.__wake.held++;
      return Promise.resolve(s);
    } };
    Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => lock, configurable: true });
    window.__battery = Object.assign(new EventTarget(), { charging: true });
    Navigator.prototype.getBattery = () => Promise.resolve(window.__battery);
    window.__vibes = [];
    Navigator.prototype.vibrate = function (p) { window.__vibes.push(p); return true; };
    window.__session = [];
    const session = { t: 'auto', get type() { return this.t; }, set type(v) { window.__session.push(v); this.t = v; } };
    Object.defineProperty(Navigator.prototype, 'audioSession', { get: () => session, configurable: true });
  };
  const watch = (p, problems) => {
    p.on('pageerror', e => problems.push(`page error: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  };

  // ---- The main page runs in New York time, on the test clock. ----
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const cpuMs = async action => { const t0 = await threadMs(); await action(); return (await threadMs()) - t0; };
  await page.addInitScript(INIT);
  const R0 = X.rings[0];   // Sunday 22 November 2026, 22:47:30 in New York
  const T0 = R0.now;
  // Every "Leave site?" question is answered Leave, and noted.
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.type()); d.accept().catch(() => {}); });
  await page.clock.install({ time: T0 - 3000 });
  await open();
  await page.clock.pauseAt(T0 + 100);
  assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/New_York');

  const text = s => page.locator(s).textContent();
  const hash = () => page.evaluate(() => location.hash);
  const status = () => text('#ac-status');
  const alertText = () => text('#ac-alert');
  const meta = n => text(`#ac-${n}-meta`);
  const metaTime = n => page.getAttribute(`#ac-${n}-meta time`, 'datetime');
  const goText = n => text(`#ac-${n} .ac-go-text`);
  const goName = n => page.$eval(`#ac-${n} .ac-go`, b => b.textContent);
  const shown = s => page.isVisible(s);
  const wall = () => page.evaluate(() => Date.now());
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const reopen = async h => { await page.goto('about:blank'); await page.goto(url + h); };
  const oscCount = () => page.evaluate(() => window.__osc.length);
  const oscFrom = n => page.evaluate(n => window.__osc.slice(n), n);
  const ready = () => page.$$eval('#ac-ready li', lis => lis.map(li => [li.className, li.textContent.slice(1)]));
  const guarded = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  const isRinging = () => page.$eval('#ac-face', f => f.classList.contains('is-ringing'));
  const baseTitle = await page.title();
  // "in 8 h 12 min": minutes rounded up, as the guide's example reads.
  const fmtLeft = ms => { const mins = Math.ceil(ms / 60000); return [mins >= 60 ? `${Math.floor(mins / 60)} h` : '', mins % 60 ? `${mins % 60} min` : ''].filter(Boolean).join(' '); };

  // ---- Fresh page: one alarm at 7:00, off; the address untouched. ----
  assert.equal(await page.locator('.ac-card').count(), 1);
  assert.equal(await page.inputValue('#ac-1-time'), '7:00 AM');
  assert.equal(await meta(1), 'Off');
  assert.equal(await goText(1), 'Set alarm');
  assert.equal(await goName(1), 'Set alarm for 7:00 AM');
  assert.equal(await shown('#ac-1 .ac-remove'), false);
  assert.equal(await text('#ac-next'), 'No alarm set');
  assert.equal(await text('#ac-now'), '10:47:30 PM');
  assert.match(await text('#ac-date'), /Sunday, November 22, 2026/);
  assert.equal(await page.isChecked('#ac-h12'), true, 'en-US uses the 12-hour clock');
  assert.deepEqual(await page.$$eval('#ac-quick a', as => as.map(a => [a.textContent, a.getAttribute('href')])),
    [['6:00 AM', '#6:00'], ['6:30 AM', '#6:30'], ['7:00 AM', '#7:00'], ['7:30 AM', '#7:30'], ['8:00 AM', '#8:00'], ['8:30 AM', '#8:30']]);
  assert.equal(await hash(), '');
  assert.equal(await page.title(), baseTitle);
  assert.equal(await text('#ac-sound-note'), '');
  assert.equal(await guarded(), false, 'no leave-page warning without an alarm');
  assert.equal(await page.evaluate(() => window.__wake.requests), 0);

  // ---- How typed times are read. ----
  await page.fill('#ac-1-time', '6:00');
  assert.equal(await hash(), '#6:00!o', 'the address follows the time typed');
  for (const [typed, want] of X.times) {
    await page.fill('#ac-1-time', typed);
    const err = await text('#ac-1-err'), inv = await page.getAttribute('#ac-1-time', 'aria-invalid');
    if (Array.isArray(want)) {
      assert.equal(err, '', JSON.stringify(typed));
      assert.equal(inv, null, JSON.stringify(typed));
      assert.equal(await hash(), `#${want[0]}:${String(want[1]).padStart(2, '0')}!o`, JSON.stringify(typed));
    } else if (typed === '') {
      // An empty box is not an error until the alarm is set.
      assert.equal(err, '');
      assert.equal(inv, null);
    } else {
      assert.equal(err, want, JSON.stringify(typed));
      assert.equal(inv, 'true', JSON.stringify(typed));
      assert.equal(await page.getAttribute('#ac-1-time', 'aria-describedby'), 'ac-1-err');
    }
  }
  // Setting with an empty box shows the problem and keeps the focus there.
  await page.fill('#ac-1-time', '');
  await page.click('#ac-1 .ac-go');
  assert.equal(await text('#ac-1-err'), 'Type the time for the alarm, such as 7:30.');
  assert.equal(await page.getAttribute('#ac-1-time', 'aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ac-1-time');
  assert.equal(await goText(1), 'Set alarm');
  // A megabyte pasted into the box is refused at once.
  let cpu = await cpuMs(() => page.$eval('#ac-1-time', el => { el.value = '7'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); }));
  assert.equal(await text('#ac-1-err'), 'That is too long for a time.');
  assert.ok(cpu < 1000, `a megabyte paste took ${cpu} ms of CPU`);
  // Leaving the box writes a good time out in full.
  await page.fill('#ac-1-time', '730p');
  await blur();
  assert.equal(await page.inputValue('#ac-1-time'), '7:30 PM');

  // ---- Set 7:00 from the keyboard: Enter in the box. ----
  await page.fill('#ac-1-time', '7');
  await page.press('#ac-1-time', 'Enter');
  assert.equal(await page.inputValue('#ac-1-time'), '7:00 AM');
  assert.equal(await status(), 'Alarm set for 7:00 AM tomorrow (Monday), in 8 hours 13 minutes.');
  assert.equal(await meta(1), `Rings at 7:00 AM tomorrow (Monday), in ${R0.left}`);
  assert.equal(await metaTime(1), iso(R0.at));
  assert.equal(await hash(), `#7:00!a${R0.at}`);
  assert.equal(await page.title(), `7:00 AM in ${R0.left} · ${baseTitle}`);
  assert.equal(await text('#ac-next'), `Next alarm 7:00 AM tomorrow (Monday), in ${R0.left}`);
  assert.equal(await goText(1), 'Turn off');
  assert.equal(await goName(1), 'Turn off the 7:00 AM alarm');
  assert.equal(await guarded(), true, 'the leave-page warning is on while an alarm is set');
  await page.waitForFunction(() => window.__wake.held === 1 && /Sound is on/.test(document.querySelector('#ac-ready').textContent));
  const r1 = await ready();
  assert.deepEqual(r1.map(r => r[0]), ['is-ok', 'is-ok', 'is-info', 'is-ok', 'is-info']);
  assert.equal(r1[0][1], 'Sound is on. Press Test sound to check the volume.');
  assert.equal(r1[1][1], 'The screen stays on while an alarm is set.');
  assert.equal(r1[3][1], 'The charger is plugged in.');
  // The minutes to go count down; under a minute, the seconds.
  await page.clock.runFor(30000);
  assert.equal(await meta(1), 'Rings at 7:00 AM tomorrow (Monday), in 8 h 12 min');

  // ---- In the last minutes the ring is scheduled ahead on the audio clock. ----
  // A jump of the test clock is like a computer that slept or a background
  // tab that ran late; the check once a second notices within a second.
  const AT = R0.at;
  // A sound card the browser suspended meanwhile is asked to resume in time.
  await page.evaluate(() => window.__master.context.suspend());
  await page.waitForFunction(() => /^Click or tap anywhere/.test(document.querySelector('#ac-sound-note').textContent));
  await page.clock.setSystemTime(AT - 100000);
  const n0 = await oscCount();
  await page.clock.runFor(1100);
  await page.waitForFunction(n => window.__master.context.state === 'running' && window.__osc.length > n, n0);
  assert.equal(await text('#ac-sound-note'), '');
  assert.equal(await meta(1), 'Rings at 7:00 AM today, in 2 min');
  let pre = await oscFrom(n0);
  const lead = r => r.when - r.now - (AT - r.wall) / 1000;
  assert.ok(pre.length > 0 && pre[0].f === 880, 'the Bell is scheduled');
  assert.ok(Math.abs(lead(pre[0])) < 0.05 && AT - pre[0].wall > 98000, `scheduled ${pre[0].when - pre[0].now} s ahead, ${(AT - pre[0].wall) / 1000} s before the alarm`);
  // Three seconds before: re-timed, then the alarm rings from what was scheduled.
  await page.clock.setSystemTime(AT - 3000);
  const n1 = await oscCount();
  await page.clock.runFor(1100);
  pre = await oscFrom(n1);
  assert.ok(pre.length > 0 && Math.abs(lead(pre[0])) < 0.05, `re-timed to ${pre.length && pre[0].when - pre[0].now} s ahead`);
  assert.ok((await oscFrom(n0)).slice(0, n1 - n0).every(r => r.stops.length > 1), 'the ring scheduled earlier is cancelled');
  assert.equal(await meta(1), 'Rings at 7:00 AM today, in 2 s');
  await page.waitForTimeout(Math.ceil((pre[0].when - pre[0].now) * 1000) + 300);
  const n2 = await oscCount();
  await page.clock.runFor(2100);
  assert.equal(await alertText(), 'Alarm: 7:00 AM.');
  assert.equal(await oscCount(), n2, 'no second sound starts: the one scheduled ahead rings');
  assert.equal(await isRinging(), true);
  const rect = await page.$eval('#ac-face', el => el.getBoundingClientRect().toJSON());
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [0, 0, 1280, 900]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ac-snooze');
  assert.equal(await page.$eval('#ac-add', el => !!el.closest('[inert]')), true);
  assert.equal(await text('#ac-ring-what'), 'Alarm 7:00 AM');
  assert.equal(await text('#ac-snooze'), 'Snooze 9 min');
  assert.equal(await meta(1), 'Ringing since 7:00 AM');
  assert.equal(await hash(), `#7:00!r${AT}`);
  assert.equal(await page.title(), `Alarm! 7:00 AM · ${baseTitle}`);
  assert.deepEqual(await page.evaluate(() => window.__session), ['playback']);
  const vibes = await page.evaluate(() => window.__vibes);
  assert.ok(vibes.length === 1 && vibes[0].length === 60, 'vibrates while it rings');

  // ---- S snoozes for 9 minutes; everything scheduled stops. ----
  await page.keyboard.press('s');
  let w = await wall();
  assert.equal(await status(), 'Snoozed until 7:09 AM, in 9 minutes.');
  assert.equal(await isRinging(), false);
  assert.equal(await hash(), `#7:00!s${w + 540000}`);
  assert.equal(await meta(1), 'Snoozed until 7:09 AM, in 9 min');
  assert.equal(await page.title(), `Snoozed to 7:09 AM · ${baseTitle}`);
  assert.equal(await text('#ac-next'), 'Snoozed until 7:09 AM, in 9 min');
  assert.ok((await oscFrom(n1)).every(r => r.stops.length >= 2 && r.stops[r.stops.length - 1].when - r.stops[r.stops.length - 1].now < 0.1), 'Snooze stops every scheduled sound');
  assert.deepEqual(await page.evaluate(() => window.__session), ['playback', 'auto']);
  assert.deepEqual((await page.evaluate(() => window.__vibes)).slice(-1), [0]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ac-1-time', 'the focus goes back to where it was');
  assert.equal(await page.$eval('#ac-add', el => !!el.closest('[inert]')), false);
  // The snooze ends: it rings again; Esc stops it and the alarm is off.
  await page.clock.runFor(540100);
  assert.equal(await alertText(), 'Alarm: 7:00 AM.');
  assert.equal(await meta(1), 'Ringing since 7:09 AM');
  await page.keyboard.press('Escape');
  assert.equal(await status(), 'Alarm stopped.');
  assert.equal(await isRinging(), false);
  assert.equal(await meta(1), 'Rang at 7:09 AM today. Off until you set it again.');
  assert.equal(await hash(), '#7:00!o');
  assert.equal(await goText(1), 'Set alarm');
  assert.equal(await guarded(), false);
  assert.equal(await page.title(), baseTitle);
  await page.waitForFunction(() => window.__wake.held === 0);

  // ---- A double click on Set alarm sets it once, not on and off again. ----
  await page.dblclick('#ac-1 .ac-go');
  assert.equal(await goText(1), 'Turn off');
  w = await wall();
  const next7 = est(2026, 11, 24, 7, 0);
  assert.equal(await hash(), `#7:00!a${next7}`);
  assert.equal(await meta(1), `Rings at 7:00 AM tomorrow (Tuesday), in ${fmtLeft(next7 - w)}`);

  // ---- The computer sleeps through the alarm: missed, not rung late. ----
  await page.clock.setSystemTime(next7 + 30 * 60000);
  const n3 = await oscCount();
  await page.clock.runFor(1100);
  assert.equal(await alertText(), 'Missed: the 7:00 AM alarm could not ring, as the page was paused or the computer asleep at that time.');
  assert.equal(await meta(1), 'Missed at 7:00 AM today: the page was paused or the computer asleep, so it could not ring.');
  assert.equal(await page.$eval('#ac-1-meta', el => el.classList.contains('is-missed')), true);
  assert.equal(await isRinging(), false);
  assert.equal(await oscCount(), n3, 'no late ringing');
  assert.equal(await hash(), `#7:00!m${next7}`);
  assert.equal(await page.title(), `Missed alarm · ${baseTitle}`);
  assert.equal(await text('#ac-next'), 'Missed alarm at 7:00 AM');

  // ---- One that nobody stops rings for 10 minutes, then stops. ----
  await page.click('#ac-1 .ac-go');
  const next7b = est(2026, 11, 25, 7, 0);
  assert.equal(await hash(), `#7:00!a${next7b}`);
  await page.clock.setSystemTime(next7b - 1000);
  await page.clock.runFor(1100);
  assert.equal(await isRinging(), true);
  await page.clock.runFor(599000);
  assert.equal(await isRinging(), true, 'still ringing after 9 min 59 s');
  await page.clock.runFor(1000);
  assert.equal(await isRinging(), false);
  assert.equal(await status(), 'The 7:00 AM alarm rang for 10 minutes and stopped.');
  assert.equal(await meta(1), 'Rang for 10 minutes from 7:00 AM and stopped. Off until you set it again.');
  assert.equal(await hash(), '#7:00!o');

  // ---- More alarms, labels, quick alarms. ----
  await page.click('#ac-add');
  assert.equal(await status(), 'Alarm 2 added.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ac-2-time');
  assert.equal(await shown('#ac-1 .ac-remove'), true);
  assert.equal(await page.$eval('#ac-1 .ac-remove', b => b.textContent), 'Remove the 7:00 AM alarm');
  await page.keyboard.type('6:45');
  await page.fill('#ac-2-label', 'Gym 🏋️');
  assert.equal(await page.getAttribute('#ac-2', 'aria-label'), 'Gym 🏋️');
  await page.press('#ac-2-time', 'Enter');
  w = await wall();
  const g645 = est(2026, 11, 26, 6, 45);
  assert.match(await status(), /^Gym 🏋️ alarm set for 6:45 AM tomorrow \(Thursday\), in \d+ hours? \d+ minutes?\.$/);
  assert.equal(await hash(), `#7:00!o,6:45!a${g645}~Gym%20%F0%9F%8F%8B%EF%B8%8F`);
  assert.match(await text('#ac-next'), /^Next alarm 6:45 AM tomorrow \(Thursday\) · Gym 🏋️, in \d+ h \d+ min$/);
  // A quick alarm sets the free alarm (no label, off) without a new history entry.
  const histLen = await page.evaluate(() => history.length);
  await page.click('#ac-quick a[href="#6:30"]');
  assert.equal(await page.inputValue('#ac-1-time'), '6:30 AM');
  assert.match(await status(), /^Alarm set for 6:30 AM tomorrow \(Thursday\), in /);
  assert.equal(await hash(), `#6:30!a${est(2026, 11, 26, 6, 30)},6:45!a${g645}~Gym%20%F0%9F%8F%8B%EF%B8%8F`);
  assert.equal(await page.evaluate(() => history.length), histLen);
  assert.match(await text('#ac-next'), /^Next alarm 6:30 AM tomorrow/);
  // A label of a megabyte is cut to 40 characters, never inside an emoji.
  await page.$eval('#ac-2-label', el => { el.value = 'x'.repeat(39) + '🍝' + 'y'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await hash(), `#6:30!a${est(2026, 11, 26, 6, 30)},6:45!a${g645}~${'x'.repeat(39)}`);
  await page.fill('#ac-2-label', 'Gym');
  // Turning one off, then the 12-hour and 24-hour clocks.
  await page.click('#ac-2 .ac-go');
  assert.equal(await status(), 'The 6:45 AM alarm is off.');
  await page.check('#ac-h24');
  assert.equal(await page.inputValue('#ac-1-time'), '06:30');
  assert.equal(await page.inputValue('#ac-2-time'), '06:45');
  assert.match(await text('#ac-now'), /^\d\d:\d\d:\d\d$/);
  assert.deepEqual(await page.$$eval('#ac-quick a', as => as.map(a => a.textContent)), ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30']);
  assert.match(await meta(1), /^Rings at 06:30 tomorrow \(Thursday\), in /);
  assert.match(await hash(), /,clock=24$/);
  await page.check('#ac-h12');
  assert.doesNotMatch(await hash(), /clock=/);
  // Remove the Gym alarm; the focus moves to the alarm left.
  await page.click('#ac-2 .ac-remove');
  assert.equal(await status(), 'The 6:45 AM alarm was removed.');
  assert.equal(await page.locator('.ac-card').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'btn ac-go');

  // ---- Keys: N night mode (dim, moving each minute), F full screen. ----
  await blur();
  await page.keyboard.press('n');
  await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'ac-face');
  assert.equal(await page.$eval('#ac-face', f => f.classList.contains('is-night') && f.classList.contains('is-full')), true);
  assert.equal(await text('#ac-night'), 'Exit night mode');
  assert.equal(await shown('#ac-full'), false);
  assert.equal(await status(), 'Night mode on.');
  const shift1 = await page.$eval('#ac-face-in', el => el.style.transform);
  await page.clock.runFor(60000);
  const shift2 = await page.$eval('#ac-face-in', el => el.style.transform);
  assert.ok(/^translate\(-?\d+px, -?\d+px\)$/.test(shift1) && shift1 !== shift2, `${shift1} then ${shift2}`);
  await page.keyboard.press('n');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.$eval('#ac-face', f => f.className), 'ac-face');
  assert.equal(await page.$eval('#ac-face-in', el => el.style.transform), '');
  await page.keyboard.press('f');
  await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'ac-face');
  assert.equal(await text('#ac-full'), 'Exit full screen');
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.fullscreenElement);
  // Keys do nothing while typing in a box.
  await page.focus('#ac-1-label');
  await page.keyboard.press('n');
  assert.equal(await page.inputValue('#ac-1-label'), 'n');
  assert.equal(await page.$eval('#ac-face', f => f.className), 'ac-face');
  await page.fill('#ac-1-label', '');

  // ---- Sounds, volume, fade-in and snooze length. ----
  const sounds = [['beeps', 'Beeps', [1760], 'triangle'], ['chime', 'Chime', [1046.5, 1318.51, 2093, 2637.02], 'sine'],
    ['clock', 'Alarm clock', [2349.32], 'triangle'], ['soft', 'Soft', [523.25, 659.26, 783.99], 'sine'],
    ['bell', 'Bell', [880, 2428.8, 4752, 7858.4], 'sine']];
  for (const [key, label, freqs, type] of sounds) {
    await page.selectOption('#ac-sound', key);
    const k = await oscCount();
    await page.click('#ac-test');
    const got = await oscFrom(k);
    assert.deepEqual([...new Set(got.map(r => r.f))].sort((a, b) => a - b), freqs, key);
    assert.ok(got.every(r => r.type === type && r.when >= r.now), key);
    assert.ok(got[0].when - got[0].now < 0.1, `${key} plays at once`);
    assert.equal(await status(), `Playing the ${label} sound.`);
    assert.equal(await hash(), key === 'bell' ? `#6:30!a${est(2026, 11, 26, 6, 30)}` : `#6:30!a${est(2026, 11, 26, 6, 30)},sound=${key}`);
  }
  await page.focus('#ac-vol');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#ac-vol-out'), '50%');
  assert.equal(await page.getAttribute('#ac-vol', 'aria-valuetext'), '50%');
  await page.waitForFunction(() => Math.abs(window.__master.gain.value - 0.25) < 0.005);
  await page.selectOption('#ac-fade', '30');
  await page.selectOption('#ac-snooze-len', '5');
  assert.equal(await text('#ac-snooze'), 'Snooze 5 min');
  assert.equal(await hash(), `#6:30!a${est(2026, 11, 26, 6, 30)},vol=50,fade=30,snooze=5`);
  // The ring scheduled ahead rises from 5% to full volume over 30 seconds.
  await page.evaluate(() => { window.__ramps = []; });
  const A630 = est(2026, 11, 26, 6, 30);
  await page.clock.setSystemTime(A630 - 60000);
  const n4 = await oscCount();
  await page.clock.runFor(1100);
  const ramps = await page.evaluate(() => window.__ramps);
  const first = (await oscFrom(n4))[0];
  assert.ok(ramps.length === 2 && ramps[0][0] === 'from' && ramps[1][0] === 'to' && ramps[1][1] === 1, JSON.stringify(ramps));
  assert.ok(Math.abs(ramps[0][2] - first.when) < 1e-6 && Math.abs(ramps[1][2] - ramps[0][2] - 30) < 1e-6, 'from the ring start, over 30 s');
  // A 5-minute snooze, by the big button (a click on the focused button).
  await page.clock.runFor(60000);
  assert.equal(await isRinging(), true);
  await page.click('#ac-snooze');
  w = await wall();
  assert.equal(await status(), 'Snoozed until 6:35 AM, in 5 minutes.');
  assert.equal(await hash(), `#6:30!s${w + 300000},vol=50,fade=30,snooze=5`);
  // The second click of a double click cannot land on what the view hid...
  await page.$eval('#ac-1 .ac-go', b => b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })));
  assert.equal(await goText(1), 'Turn off', 'a second click straight after Snooze does nothing');
  // ...but a click of its own does.
  await page.click('#ac-1 .ac-go');
  assert.equal(await goText(1), 'Set alarm');
  await page.selectOption('#ac-fade', '0');
  await page.selectOption('#ac-snooze-len', '9');
  await page.focus('#ac-vol');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await hash(), '#6:30!o');

  // ---- Your own sound: a WAV file, the first 2 minutes in a loop, in mono. ----
  const wav = (seconds, left, right, rate = 8000) => {
    const n = Math.round(seconds * rate), bytes = n * 4, b = Buffer.alloc(44 + bytes);
    b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
    for (let i = 0; i < n; i++) {
      b.writeInt16LE(Math.round(left(i / rate) * 32767), 44 + i * 4);
      b.writeInt16LE(Math.round(right(i / rate) * 32767), 46 + i * 4);
    }
    return b;
  };
  // Left a 440 Hz sine at half scale, right silent: mono is a quarter scale.
  await page.setInputFiles('#ac-file', { name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(130, t => 0.5 * Math.sin(2 * Math.PI * 440 * t), () => 0) });
  await page.waitForFunction(() => /is the alarm sound/.test(document.querySelector('#ac-file-note').textContent));
  assert.equal(await text('#ac-file-note'), '“tone.wav” is the alarm sound; its first 2 minutes play in a loop. It is not kept after a reload.');
  assert.equal(await page.inputValue('#ac-sound'), 'file');
  assert.match(await hash(), /,sound=file$/);
  const k5 = await oscCount();
  await page.click('#ac-test');
  const clipRec = (await oscFrom(k5)).find(r => r.kind === 'buf');
  assert.ok(clipRec && clipRec.loop && clipRec.ch === 1, JSON.stringify(clipRec));
  assert.ok(Math.abs(clipRec.dur - 120) < 0.01, `kept ${clipRec.dur} s`);
  assert.ok(Math.abs(clipRec.peak - 0.25) < 0.01, `mono peak ${clipRec.peak}`);
  assert.ok(clipRec.stops.length === 1 && Math.abs(clipRec.stops[0].when - clipRec.when - 4) < 0.01, 'the test plays 4 s');
  assert.equal(await status(), 'Playing your file sound.');
  // A file that is not sound, a silent one and one over 10 MB are refused;
  // the sound in use stays.
  await page.setInputFiles('#ac-file', { name: 'notes.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('OTTO, not a sound at all\n'.repeat(40)) });
  await page.waitForFunction(() => document.querySelector('#ac-file-err').textContent !== '');
  assert.equal(await text('#ac-file-err'), '“notes.mp3” could not be played in this browser. MP3 and WAV files work in every browser.');
  assert.equal(await page.getAttribute('#ac-file', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#ac-file', 'aria-describedby'), 'ac-file-err');
  assert.equal(await page.inputValue('#ac-sound'), 'file');
  await page.setInputFiles('#ac-file', { name: 'quiet.wav', mimeType: 'audio/wav', buffer: wav(2, () => 0, () => 0) });
  await page.waitForFunction(() => /silent/.test(document.querySelector('#ac-file-err').textContent));
  assert.equal(await text('#ac-file-err'), '“quiet.wav” is silent.');
  await page.setInputFiles('#ac-file', { name: 'long.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  assert.equal(await text('#ac-file-err'), '“long.wav” is 10.1 MB, more than the 10 MB this page can open. Choose a shorter song, or an MP3 rather than a WAV.');
  await page.setInputFiles('#ac-file', { name: 'short.wav', mimeType: 'audio/wav', buffer: wav(3, t => 0.3 * Math.sin(2 * Math.PI * 660 * t), t => 0.3 * Math.sin(2 * Math.PI * 660 * t)) });
  await page.waitForFunction(() => /short\.wav” is the alarm sound/.test(document.querySelector('#ac-file-note').textContent));
  assert.equal(await text('#ac-file-err'), '');
  assert.equal(await page.getAttribute('#ac-file', 'aria-invalid'), null);
  assert.equal(await text('#ac-file-note'), '“short.wav” is the alarm sound. It is not kept after a reload.');
  // After a reload the file is gone: Bell rings, and the page says so.
  await page.reload();
  assert.equal(await page.inputValue('#ac-sound'), 'bell');
  assert.equal(await text('#ac-file-err'), 'Your own sound file is not kept when the page reloads or reopens, as nothing is saved, so the alarm rings with Bell. Choose the file again to use it.');
  assert.match(await hash(), /,sound=file$/, 'still said after another reload');
  await page.selectOption('#ac-sound', 'chime');
  assert.equal(await text('#ac-file-err'), '');
  assert.match(await hash(), /,sound=chime$/);
  await page.selectOption('#ac-sound', 'bell');

  // ---- Notifications, and the ready check. ----
  await page.click('#ac-notify');
  await page.waitForFunction(() => window.__notes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__notes[0]), ['Notifications are on', 'You will get one when an alarm rings.']);
  assert.equal((await ready())[2][1], 'A notification shows when an alarm rings in a background tab.');
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.click('#ac-1 .ac-go');
  const A630b = est(2026, 11, 27, 6, 30);
  assert.equal(await hash(), `#6:30!a${A630b}`);
  await page.clock.setSystemTime(A630b - 500);
  await page.clock.runFor(1600);
  assert.deepEqual(await page.evaluate(() => window.__notes[1]), ['Alarm: 6:30 AM', 'Ringing since 6:30 AM. Open the page to snooze or stop it.']);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.hasFocus = () => true; });
  // Chrome on Android: the constructor throws.
  await page.click('#ac-notify');
  await page.evaluate(() => { window.__throws = true; });
  await page.click('#ac-notify');
  await page.waitForFunction(() => !document.querySelector('#ac-notify').checked);
  assert.match(await text('#ac-notify-msg'), /does not let web pages show notifications/);
  assert.equal(await page.getAttribute('#ac-notify', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#ac-notify', 'aria-describedby'), 'ac-notify-msg');
  await page.evaluate(() => { window.__throws = false; window.__perm = 'default'; window.__answer = 'denied'; });
  await page.click('#ac-notify');
  await page.waitForFunction(() => /blocked/.test(document.querySelector('#ac-notify-msg').textContent));
  assert.equal(await page.isChecked('#ac-notify'), false);
  // On battery, and a wake lock the browser refuses.
  await page.evaluate(() => { window.__battery.charging = false; window.__battery.dispatchEvent(new Event('chargingchange')); });
  assert.equal((await ready())[3].join('|'), 'is-warn|Running on battery: plug in the charger, so the battery does not run out before the alarm.');
  await page.evaluate(() => { window.__wake.refuse = true; });
  await page.click('#ac-1 .ac-go');
  await page.waitForFunction(() => /did not let/.test(document.querySelector('#ac-ready').textContent));
  assert.equal((await ready())[1].join('|'), 'is-warn|The browser did not let this page keep the screen on (it may be saving power), so set the computer not to sleep.');
  await page.uncheck('#ac-wake');
  assert.equal((await ready())[1][0], 'is-warn');
  assert.match((await ready())[1][1], /^The screen may turn off/);
  await page.check('#ac-wake');
  await page.evaluate(() => { window.__wake.refuse = false; window.__battery.charging = true; window.__battery.dispatchEvent(new Event('chargingchange')); });
  await page.click('#ac-1 .ac-go');

  // ---- Addresses: bookmarks, the states the page writes, and junk. ----
  await page.clock.setSystemTime(T0);
  const now0 = T0;
  const A7 = est(2026, 11, 23, 7, 0);
  const cases = [
    ['#7:30pm', `#19:30!a${est(2026, 11, 23, 19, 30)}`, 'Rings at 7:30 PM tomorrow (Monday), in 20 h 43 min'],
    ['#730', `#7:30!a${est(2026, 11, 23, 7, 30)}`, 'Rings at 7:30 AM tomorrow (Monday), in 8 h 43 min'],
    [`#7:00!a${now0 - 13 * 3600000}`, `#7:00!a${A7}`, `Rings at 7:00 AM tomorrow (Monday), in ${R0.left}`],
    [`#7:00!a${now0 - 30 * 60000}`, `#7:00!m${now0 - 30 * 60000}`, 'Missed at 10:17 PM today: the page was paused or the computer asleep, so it could not ring.'],
    [`#7:00!a${now0 - 30000}`, `#7:00!r${now0 - 30000}`, 'Ringing since 10:47 PM'],
    [`#7:00!s${now0 + 300000}`, `#7:00!s${now0 + 300000}`, 'Snoozed until 10:52 PM, in 5 min'],
    [`#7:00!s${now0 - 2 * 3600000}`, `#7:00!m${now0 - 2 * 3600000}`, 'Missed at 8:47 PM today: the page was paused or the computer asleep, so it could not ring.'],
    [`#7:00!r${now0 - 300000}`, `#7:00!r${now0 - 300000}`, 'Ringing since 10:42 PM'],
    [`#7:00!r${now0 - 660000}`, '#7:00!o', 'Rang at 10:36 PM today. Off until you set it again.'],
    [`#7:00!m${now0 - 3600000}`, `#7:00!m${now0 - 3600000}`, 'Missed at 9:47 PM today: the page was paused or the computer asleep, so it could not ring.'],
    [`#7:00!m${now0 - 13 * 3600000}`, `#7:00!a${A7}`, `Rings at 7:00 AM tomorrow (Monday), in ${R0.left}`],
    ['#7:00!o', '#7:00!o', 'Off'],
    ['#0:00', `#0:00!a${est(2026, 11, 23, 0, 0)}`, 'Rings at 12:00 AM tomorrow (Monday), in 1 h 13 min'],
  ];
  for (const [h, canon, m] of cases) {
    await reopen(h);
    assert.equal(await text('#ac-msg'), '', h);
    assert.equal(await hash(), canon, h);
    assert.equal(await meta(1), m, h);
    if (canon.includes('!r')) {
      assert.equal(await isRinging(), true, h);
      // Started without a click, which this test browser allows.
      await page.waitForFunction(() => document.querySelector('#ac-sound-note').textContent === '');
    }
  }
  await reopen('#6:30~Gym,7:15');
  assert.equal(await page.locator('.ac-card').count(), 2);
  assert.equal(await page.inputValue('#ac-1-label'), 'Gym');
  assert.equal(await hash(), `#6:30!a${est(2026, 11, 23, 6, 30)}~Gym,7:15!a${est(2026, 11, 23, 7, 15)}`);
  assert.match(await text('#ac-sound-note'), /^Click or tap anywhere|^$/);
  // Settings in the address.
  await reopen('#7:00,sound=chime,vol=50,fade=30,snooze=5,clock=24');
  assert.equal(await page.inputValue('#ac-sound'), 'chime');
  assert.equal(await page.inputValue('#ac-vol'), '50');
  assert.equal(await text('#ac-vol-out'), '50%');
  assert.equal(await page.inputValue('#ac-fade'), '30');
  assert.equal(await page.inputValue('#ac-snooze-len'), '5');
  assert.equal(await text('#ac-snooze'), 'Snooze 5 min');
  assert.equal(await page.isChecked('#ac-h24'), true);
  assert.equal(await page.inputValue('#ac-1-time'), '07:00');
  assert.equal(await hash(), `#7:00!a${A7},sound=chime,vol=50,fade=30,snooze=5,clock=24`);
  // What cannot be read is named, and the address stays as it was typed.
  const bad = ['#7:00,sound=constructor', '#__proto__', '#constructor', '#7:61', '#7:00!x5', `#7:00!a${now0 + 30 * 3600000}`, `#7:00!m${now0 + 60000}`, '#7:00,vol=57', '#7:00,clock=13', '#%E0%A4%A', '#7:00!a12!s5'];
  for (const h of bad) {
    await reopen(h);
    assert.match(await text('#ac-msg'), /^Part of the page address could not be read as an alarm: “.+”\.$/, h);
    assert.equal(await hash(), h, 'an address that could not be read is left as it was typed');
  }
  // ...until the visitor changes something.
  await page.click('#ac-1 .ac-go');
  assert.doesNotMatch(await hash(), /x5|!a12!s5|sound=constructor|__proto__/);
  // A link to a heading of the guide is a link, not a broken alarm.
  await reopen('#how-to-set-an-alarm');
  assert.equal(await text('#ac-msg'), '');
  assert.equal(await hash(), '#how-to-set-an-alarm');
  assert.equal(await page.inputValue('#ac-1-time'), '7:00 AM');
  // Labels are cut to 40 characters, never inside an emoji, and so are quotes.
  await reopen('#7:00~' + 'a'.repeat(39) + '%F0%9F%8D%9D');
  assert.equal(await page.inputValue('#ac-1-label'), 'a'.repeat(39));
  await reopen('#' + 'a'.repeat(39) + '%F0%9F%8D%9Db');
  const quoted = await text('#ac-msg');
  assert.ok(quoted.includes('“' + 'a'.repeat(39) + '…”'), quoted);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(quoted));
  await reopen('#' + Array(11).fill('7:00!o').join(','));
  assert.equal(await page.locator('.ac-card').count(), 10);
  assert.match(await text('#ac-msg'), /^Only the first 10 alarms/);
  assert.equal(await page.getAttribute('#ac-add', 'aria-disabled'), 'true');
  await page.click('#ac-add', { force: true });
  assert.equal(await text('#ac-msg'), '10 alarms is the most this page keeps. Remove one to add another.');
  await reopen('#' + '7:00!o,'.repeat(600));
  assert.match(await text('#ac-msg'), /longer than 4,000 characters/);
  assert.equal(await page.locator('.ac-card').count(), 1);
  await reopen('#7:00!o');
  cpu = await cpuMs(async () => {
    await page.evaluate(() => { location.hash = '#' + '7:00,'.repeat(200000); });
    await page.waitForFunction(() => /longer than 4,000 characters/.test(document.querySelector('#ac-msg').textContent));
  });
  assert.ok(cpu < 1000, `a megabyte address took ${cpu} ms of CPU`);
  // A link to another alarm while one is set adds it.
  await reopen('#7:00');
  await page.evaluate(() => { location.hash = '#8:00~Tea'; });
  await page.waitForFunction(() => document.querySelectorAll('.ac-card').length === 2);
  assert.equal(await page.inputValue('#ac-2-label'), 'Tea');
  assert.match(await hash(), /^#7:00!a\d+,8:00!a\d+~Tea$/);
  // Boxes the browser fills back in after Back are read again on pageshow.
  await page.evaluate(() => {
    document.querySelector('#ac-1-time').value = '6:15';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.match(await hash(), /^#6:15!a\d+,8:00!a\d+~Tea$/);
  // The leave-page warning shows when you navigate away from a set alarm
  // (browsers ask only after a click on the page).
  await page.click('h1');
  const nd = dialogs.length;
  await page.goto('about:blank');
  assert.deepEqual(dialogs.slice(nd), ['beforeunload']);

  const browser = page.context().browser();
  const problems = [];

  // ---- Time zones: the hour the clocks skip or repeat. ----
  const byZone = {};
  for (const r of X.rings) (byZone[r.tz] = byZone[r.tz] || []).push(r);
  for (const [tz, rs] of Object.entries(byZone)) {
    const ctx = await browser.newContext({ timezoneId: tz, locale: 'en-US' });
    const p = await ctx.newPage();
    watch(p, problems);
    await p.addInitScript(INIT);
    await p.clock.install({ time: rs[0].now - 1000 });
    await p.clock.pauseAt(rs[0].now);
    for (const r of rs) {
      await p.clock.setSystemTime(r.now);
      await p.goto('about:blank');
      await p.goto(`${url}#${r.h}:${String(r.m).padStart(2, '0')}`);
      const what = `${tz} ${r.nowIso} ${r.h}:${r.m}`;
      assert.equal(await p.evaluate(() => location.hash), `#${r.h}:${String(r.m).padStart(2, '0')}!a${r.at}`, what);
      const m = await p.textContent('#ac-1-meta');
      assert.ok(m.startsWith(`Rings at ${H12(r.local)} `) && m.includes(`, in ${r.left}`), `${what}: ${m}`);
      if (r.gap) assert.ok(m.endsWith(`, when the clocks go forward, so the alarm rings at ${H12(r.local)}.`) && m.includes(`${H12(`${r.h}:${r.m}`)} does not exist on `), `${what}: ${m}`);
      else if (r.twice) assert.ok(m.endsWith(` as the clocks go back; the alarm rings the ${r.second ? 'second' : 'first'} time.`), `${what}: ${m}`);
      else assert.ok(!/clocks go/.test(m), `${what}: ${m}`);
    }
    await ctx.close();
  }

  // ---- A decimal-comma language: a 24-hour clock, and 7,30 refused. ----
  const de = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const dp = await de.newPage();
  watch(dp, problems);
  await dp.goto(url);
  assert.equal(await dp.isChecked('#ac-h24'), true);
  assert.equal(await dp.inputValue('#ac-1-time'), '07:00');
  await dp.fill('#ac-1-time', '7,30');
  assert.equal(await dp.textContent('#ac-1-err'), 'Type a time such as 7:30, 7:30 pm or 1930.');
  await dp.fill('#ac-1-time', '7.30');
  assert.equal(await dp.evaluate(() => location.hash), '#7:30!o');
  await de.close();

  // ---- A phone with a touch screen. ----
  const phone = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'America/New_York' });
  const pp = await phone.newPage();
  watch(pp, problems);
  await pp.addInitScript(INIT);
  pp.on('dialog', d => d.accept().catch(() => {}));
  await pp.clock.install({ time: T0 - 1000 });
  await pp.clock.pauseAt(T0);
  await pp.route('**/*', route => { if (!route.request().url().startsWith(base)) { problems.push('outside request ' + route.request().url()); return route.abort(); } return route.continue(); });
  await pp.goto(url);
  for (const sel of ['#ac-1 .ac-go', '#ac-add', '#ac-test', '#ac-1-time', '#ac-1-label', '#ac-full', '#ac-night', '#ac-quick a', '.ac-fmt .check', '#ac-file']) {
    const b = await pp.locator(sel).first().boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${sel} is ${b.width}x${b.height}`);
  }
  assert.ok(await pp.$eval('#ac-1-time', el => parseFloat(getComputedStyle(el).fontSize) >= 16));
  await pp.tap('#ac-quick a[href="#7:30"]');
  assert.equal(await pp.textContent('#ac-1 .ac-go-text'), 'Turn off');
  // No label breaks over two lines or is cut off, down to 320 px, ringing too.
  const twoLines = () => pp.$$eval('#ac .btn, #ac select', bs => bs.filter(b => b.getClientRects().length).map(b => {
    if (b.tagName === 'SELECT') {
      // The longest choice must fit beside the arrow.
      const cs = getComputedStyle(b), c = document.createElement('canvas').getContext('2d');
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const widest = Math.max(...[...b.options].filter(o => !o.hidden).map(o => c.measureText(o.text).width));
      return [b.id, 1, widest > b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16];
    }
    // The visible words only: text for screen readers sits in a 1 px box.
    const tops = new Set(), walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (t.parentElement.closest('.visually-hidden')) continue;
      const r = document.createRange(); r.selectNodeContents(t);
      for (const x of r.getClientRects()) if (x.width > 0) tops.add(Math.round(x.top));
    }
    return [b.textContent, tops.size, b.scrollWidth > b.clientWidth];
  }).filter(x => x[1] > 1 || x[2]));
  const long = Array.from({ length: 10 }, (_, i) => `${i + 5}:${i % 2 ? '45' : '15'}~${encodeURIComponent('Ein sehr langer Name für diesen Wecker ' + i)}`).join(',');
  for (const width of [320, 340, 360, 390, 412, 480, 540]) {
    await pp.setViewportSize({ width, height: 740 });
    for (const h of ['', '#' + long, `#7:00!a${T0 - 10000}`]) {
      await pp.goto('about:blank');
      await pp.goto(url + h);
      const tl = await twoLines();
      assert.deepEqual(tl, [], `${width} px, ${h.slice(0, 20)}: ${JSON.stringify(tl)}`);
      assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll at ${width} px, ${h.slice(0, 20)}`);
    }
    // The ringing view fills the screen, with big buttons.
    const sz = await pp.$eval('#ac-snooze', b => b.getBoundingClientRect().height);
    assert.ok(sz >= 64, `Snooze is ${sz} px tall`);
    await pp.tap('#ac-snooze');
    await pp.tap('#ac-night');
    assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `night mode at ${width} px`);
    assert.deepEqual(await twoLines(), [], `night mode at ${width} px`);
    await pp.tap('#ac-night');
    await pp.waitForFunction(() => !document.fullscreenElement);
  }
  await phone.close();
  assert.deepEqual(problems, []);

  // ---- Leave the page with alarms set and one ringing, for the checks that follow. ----
  await page.goto(url + `#7:00!a${T0 - 20000},6:30~Gym,8:15~${encodeURIComponent('Bus to work 🚌')}`);
  assert.equal(await isRinging(), true);
};
