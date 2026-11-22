const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// How the length boxes read numbers, and an unattended run of sessions with
// the CSV file and copied text it should give, come from
// tests/fixtures/pomodoro-timer/expected.py, not from this page. The page
// runs on Playwright's test clock, in London time; the audio clock runs in
// real time, so sounds scheduled ahead are checked against the test clock's
// time when they were scheduled.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const RUN = X.run;
  const T0 = RUN.start - 2 * 3600000;   // 07:00 in London, Sunday 22 November 2026
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sp = s => s.replace(/ /g, ' ');

  const INIT = () => {
    window.__osc = [];
    const record = function (start, when, rest) {
      const osc = this instanceof OscillatorNode, buf = this instanceof AudioBufferSourceNode && this.buffer && this.buffer.length > 1;
      if (osc || buf) {
        this.__rec = { kind: osc ? 'osc' : 'buf', f: osc ? Math.round(this.frequency.value * 100) / 100 : 0, type: osc ? this.type : '', when, now: this.context.currentTime, wall: Date.now(), stops: [] };
        if (buf) Object.assign(this.__rec, { loop: this.loop, dur: this.buffer.duration });
        window.__osc.push(this.__rec);
      }
      return start.call(this, when, ...rest);
    };
    // AudioBufferSourceNode has a start() of its own.
    for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
      if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
      const start = proto.start;
      proto.start = function (when = 0, ...rest) { return record.call(this, start, when, rest); };
    }
    const stop = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.stop = function (when = 0) {
      if (this.__rec) this.__rec.stops.push({ when, now: this.context.currentTime });
      return stop.call(this, when);
    };
    window.__resumes = 0;
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () { window.__resumes++; return resume.call(this); };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest instanceof AudioDestinationNode) window.__master = this;
      return connect.call(this, dest, ...rest);
    };
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
    window.__wake = { held: 0 };
    const lock = { request(type) {
      const s = new EventTarget();
      s.type = type;
      s.release = () => { window.__wake.held--; s.dispatchEvent(new Event('release')); return Promise.resolve(); };
      window.__wake.held++;
      return Promise.resolve(s);
    } };
    Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => lock, configurable: true });
  };
  const watch = (p, problems) => {
    p.on('pageerror', e => problems.push(`page error: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/London' });
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const cpuMs = async action => { const t0 = await threadMs(); await action(); return (await threadMs()) - t0; };
  await page.addInitScript(INIT);
  await page.clock.install({ time: T0 - 3000 });
  await open();
  await page.clock.pauseAt(T0);

  const text = async s => sp(await page.locator(s).textContent());
  const hash = () => page.evaluate(() => location.hash);
  const status = () => text('#pt-status');
  const alertText = () => text('#pt-alert');
  const shown = s => page.isVisible(s);
  const wall = () => page.evaluate(() => Date.now());
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const reopen = async h => { await page.goto('about:blank'); await page.goto(url + h); };
  const oscCount = () => page.evaluate(() => window.__osc.length);
  const oscFrom = n => page.evaluate(n => window.__osc.slice(n), n);
  // The page ignores keys while the timer is scrolled out of sight (Space
  // then scrolls the page), so the timer is brought into view first.
  const press = async key => {
    await blur();
    await page.$eval('#pt-card', el => { const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'instant' }); });
    await page.keyboard.press(key);
  };
  const logRows = () => page.$$eval('#pt-log-body tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent.replace(/ /g, ' '))));
  const dots = () => page.getAttribute('#pt-dots', 'aria-label');
  const pressed = () => page.$$eval('#pt-modes [aria-pressed="true"]', bs => bs.map(b => b.textContent));
  // A sound scheduled ahead: how far it is from where it should be, given
  // the test clock's time when it was scheduled and the end it is for.
  const off = (r, endWall) => r.when - r.now - (endWall - r.wall) / 1000;
  const baseTitle = await page.title();
  const ENC = encodeURIComponent('Essay ✍️');

  // ---- Fresh page: Focus 1 of 4, 25 minutes, nothing started. ----
  assert.equal(await text('#pt-time'), '25:00');
  assert.equal(await text('#pt-meta'), 'Focus 1 of 4 · 25 minutes');
  assert.equal(await dots(), '0 of 4 focus sessions done in this set');
  assert.equal(await page.locator('.pt-dot').count(), 4);
  assert.deepEqual(await pressed(), ['Focus']);
  assert.equal(await text('#pt-go'), 'Start');
  assert.equal(await page.getAttribute('#pt-reset', 'aria-disabled'), 'true');
  assert.equal(await page.getAttribute('#pt-plus', 'aria-disabled'), 'true');
  assert.equal(await shown('#pt-pip'), true, 'Chromium offers the mini timer');
  assert.equal(await page.getAttribute('[data-preset="25-5"]', 'aria-pressed'), 'true');
  assert.deepEqual(await Promise.all(['focus', 'short', 'long', 'every'].map(k => page.inputValue('#pt-' + k))), ['25', '5', '15', '4']);
  assert.equal(await page.isChecked('#pt-auto-break'), false, 'nothing starts by itself unless asked');
  assert.equal(await page.isChecked('#pt-auto-focus'), false);
  assert.equal(await page.isChecked('#pt-tick'), false);
  assert.equal(await shown('#pt-log-wrap'), false);
  assert.equal(await hash(), '');
  assert.equal(await page.title(), baseTitle);

  // ---- What the length boxes accept: whole numbers in any script. ----
  for (const [typed, want] of X.numbers) {
    await page.fill('#pt-focus', typed);
    const err = await text('#pt-len-err'), inv = await page.getAttribute('#pt-focus', 'aria-invalid');
    if (typeof want === 'number') {
      assert.equal(err, '', JSON.stringify(typed));
      assert.equal(inv, null, JSON.stringify(typed));
      assert.equal(await hash(), want === 25 ? '' : `#${want}-5-15-4`, JSON.stringify(typed));
      assert.equal(await text('#pt-time'), want >= 60 ? `${Math.floor(want / 60)}:${String(want % 60).padStart(2, '0')}:00` : `${String(want).padStart(2, '0')}:00`, JSON.stringify(typed));
    } else {
      assert.equal(err, 'Focus: ' + want, JSON.stringify(typed));
      assert.equal(inv, 'true', JSON.stringify(typed));
      assert.equal(await page.getAttribute('#pt-focus', 'aria-describedby'), 'pt-len-err');
    }
  }
  for (const [typed, want] of X.every) {
    await page.fill('#pt-focus', '25');
    await page.fill('#pt-every', typed);
    if (typeof want === 'number') {
      assert.equal(await hash(), want === 4 ? '' : `#25-5-15-${want}`, typed);
      assert.equal(await page.locator('.pt-dot').count(), want);
    } else assert.equal(await text('#pt-len-err'), 'Long break after: ' + want, typed);
  }
  await page.fill('#pt-every', '4');
  // Empty is only wrong when starting; the focus goes to the box.
  await page.fill('#pt-short', '');
  assert.equal(await text('#pt-len-err'), '');
  await page.click('#pt-go');
  assert.equal(await text('#pt-len-err'), 'Short break: type a number.');
  assert.equal(await page.getAttribute('#pt-short', 'aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pt-short');
  assert.equal(await text('#pt-go'), 'Start');
  await page.fill('#pt-short', '5');
  assert.equal(await text('#pt-len-err'), '');
  // A megabyte pasted into a box is refused at once.
  let cpu = await cpuMs(() => page.$eval('#pt-long', el => { el.value = '7'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); }));
  assert.equal(await text('#pt-len-err'), 'Long break: too long for a number.');
  assert.ok(cpu < 1000, `a megabyte paste took ${cpu} ms of CPU`);
  await page.fill('#pt-long', '15');
  assert.equal(await hash(), '');
  // ...and into the label, which keeps its first 60 characters, never half an emoji.
  cpu = await cpuMs(() => page.$eval('#pt-label', el => { el.value = 'x'.repeat(59) + '🍝' + 'y'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); }));
  assert.ok(cpu < 1000, `a megabyte label took ${cpu} ms of CPU`);
  assert.equal(await hash(), `#f1~${'x'.repeat(59)}`);
  await page.fill('#pt-label', '');
  assert.equal(await hash(), '');

  // ---- Start: the end sound is scheduled ahead on the audio clock. ----
  let n0 = await oscCount();
  await page.click('#pt-go');
  const E1 = T0 + 1500000;
  assert.equal(await status(), 'Focus 1 started: 25 minutes.');
  assert.equal(await text('#pt-go'), 'Pause');
  assert.equal(await text('#pt-meta'), 'Focus 1 of 4 · ends at 7:25 AM');
  assert.equal(await page.getAttribute('#pt-meta time', 'datetime'), iso(E1));
  assert.equal(await hash(), `#f1!r${E1}`);
  assert.equal(await page.title(), `25:00 Focus · ${baseTitle}`);
  assert.equal(await page.getAttribute('#pt-reset', 'aria-disabled'), 'false');
  assert.equal(await text('#pt-sound-note'), '');
  await page.waitForFunction(() => window.__wake.held === 1);
  let pre = await oscFrom(n0);
  assert.ok(pre.length > 0 && pre[0].f === 880 && Math.abs(off(pre[0], E1)) < 0.05, `the Bell at the end, ${pre.length && off(pre[0], E1)} s off`);
  assert.ok(pre.every(r => r.f !== 1318.51), 'no break sound: the break does not start by itself');
  await page.clock.runFor(1000);
  assert.equal(await text('#pt-time'), '24:59');
  assert.equal(await page.title(), `24:59 Focus · ${baseTitle}`);
  await page.fill('#pt-label', 'Essay ✍️');
  assert.equal(await hash(), `#f1!r${E1}~${ENC}`);

  // ---- Pause and resume from the keyboard; +1 min moves the end. ----
  await press('Space');
  assert.equal(await status(), 'Focus 1 paused with 24 minutes 59 seconds left.');
  assert.equal(await text('#pt-meta'), 'Focus 1 of 4 · paused');
  assert.equal(await hash(), `#f1!p1499000~${ENC}`);
  assert.equal(await page.title(), `24:59 paused · ${baseTitle}`);
  assert.ok((await oscFrom(n0)).every(r => r.stops.length > 1), 'pausing cancels the sound scheduled ahead');
  // While paused, a sound card the browser suspended waits for the next
  // click or key, and the page asks for one.
  await page.evaluate(() => window.__master.context.suspend());
  await page.waitForFunction(() => document.querySelector('#pt-sound-note').textContent === 'Click or tap anywhere on this page so the timer can sound.');
  await page.clock.runFor(60000);
  assert.equal(await text('#pt-time'), '24:59');
  assert.equal(await page.evaluate(() => window.__master.context.state), 'suspended');
  await press('Space');
  assert.equal(await status(), 'Focus 1 resumed with 24 minutes 59 seconds left.');
  await page.waitForFunction(() => window.__master.context.state === 'running' && document.querySelector('#pt-sound-note').textContent === '');
  let w = await wall();
  n0 = await oscCount();
  await page.click('#pt-plus');
  assert.equal(await status(), 'Added 1 minute: 25 minutes 59 seconds left.');
  assert.equal(await text('#pt-time'), '25:59');
  const E1b = w + 1499000 + 60000;
  assert.equal(await hash(), `#f1!r${E1b}~${ENC}`);
  pre = await oscFrom(n0);
  assert.ok(pre.length > 0 && Math.abs(off(pre[0], E1b)) < 0.05, 'the sound moves with the end');
  // While a session runs, a sound card the browser suspended is asked to
  // resume straight away (the note may show for a moment).
  const resumes = await page.evaluate(() => window.__resumes);
  await page.evaluate(() => window.__master.context.suspend());
  await page.clock.runFor(5100);
  await page.waitForFunction(r => window.__master.context.state === 'running' && window.__resumes > r && document.querySelector('#pt-sound-note').textContent === '', resumes);

  // ---- The session ends: it rings, counts, and the short break is next.
  // Long stretches jump the test clock, firing what falls due once, as a
  // frame by frame run of 26 minutes would take minutes of real time. ----
  await page.clock.fastForward(1559000 + 20 - 5100);
  assert.equal(await alertText(), 'Focus 1 done. Next: short break.');
  assert.equal(await dots(), '1 of 4 focus sessions done in this set');
  assert.equal(await page.locator('.pt-dot.is-done').count(), 1);
  assert.equal(await text('#pt-meta'), 'Short break · 5 minutes');
  assert.equal(await text('#pt-last'), 'Focus 1 ended at 7:27 AM.');
  assert.deepEqual(await pressed(), ['Short break']);
  assert.equal(await text('#pt-go'), 'Stop alarm', 'while it rings, the main button stops it');
  assert.equal(await page.title(), `Time for a break · ${baseTitle}`);
  assert.equal(await hash(), `#s1~${ENC}`);
  assert.deepEqual(await logRows(), [['1', 'Focus 1', 'Essay ✍️', '7:00 AM', '7:27 AM', '26', 'Completed']]);
  await page.keyboard.press('Escape');
  assert.equal(await status(), 'Alarm stopped.');
  assert.equal(await text('#pt-go'), 'Start');
  assert.equal(await page.title(), baseTitle);
  // The break, with its own end sound.
  n0 = await oscCount();
  await press('Space');
  assert.equal(await status(), 'Short break started: 5 minutes.');
  pre = await oscFrom(n0);
  assert.ok(pre.length > 0 && pre[0].f === 1318.51, 'the Chime ends a break');
  await page.clock.fastForward(300020);
  assert.equal(await alertText(), 'Short break over. Next: focus 2.');
  assert.equal(await page.title(), `Break over · ${baseTitle}`);
  assert.equal(await text('#pt-meta'), 'Focus 2 of 4 · 25 minutes');
  assert.equal(await hash(), `#f2~${ENC}`);
  await page.keyboard.press('Escape');

  // ---- Skip does not count; Reset starts again; the tabs; a new set. ----
  await press('Space');
  await page.clock.fastForward(60000);
  await press('s');
  assert.equal(await status(), 'Skipped focus 2. Next: short break.');
  assert.equal(await text('#pt-last'), 'Skipped focus 2.');
  assert.equal(await dots(), '1 of 4 focus sessions done in this set');
  assert.equal(await hash(), `#s1~${ENC}`);
  await press('Space');
  await page.clock.fastForward(30000);
  await press('r');
  assert.equal(await status(), 'Short break reset to 5 minutes.');
  assert.equal(await text('#pt-last'), 'The short break was reset.');
  assert.equal(await text('#pt-time'), '05:00');
  const rows1 = await logRows();
  assert.deepEqual(rows1.map(r => [r[0], r[1], r[5], r[6]]), [['1', 'Focus 1', '26', 'Completed'], ['2', 'Short break', '5', 'Completed'], ['3', 'Focus 2', '1', 'Skipped'], ['4', 'Short break', '0.5', 'Reset']]);
  await page.click('#pt-modes [data-phase="long"]');
  assert.equal(await status(), 'Long break, 15 minutes. Press Start when you are ready.');
  assert.deepEqual(await pressed(), ['Long break']);
  assert.equal(await text('#pt-last'), 'The short break was reset.', 'a tab chosen before starting leaves no note');
  assert.equal(await hash(), `#l1~${ENC}`);
  await page.click('#pt-newset');
  assert.equal(await status(), 'New set: focus 1 of 4.');
  assert.equal(await dots(), '0 of 4 focus sessions done in this set');
  assert.equal(await hash(), `#f1~${ENC}`);
  // A double click on Start starts it once; no button moves under the
  // second click.
  const before = await page.$$eval('.pt-actions .btn', bs => bs.map(b => b.getBoundingClientRect().x));
  await page.evaluate(() => { window.__clicks = []; document.addEventListener('click', e => window.__clicks.push(e.target.id + e.detail), true); });
  await page.dblclick('#pt-go');
  assert.equal(await text('#pt-go'), 'Pause');
  assert.deepEqual(await page.evaluate(() => window.__clicks), ['pt-go1', 'pt-go2']);
  assert.deepEqual(await page.$$eval('.pt-actions .btn', bs => bs.map(b => b.getBoundingClientRect().x)), before);
  await press('r');
  // Reset and +1 min do nothing before a session starts.
  await page.click('#pt-plus', { force: true });
  await page.click('#pt-reset', { force: true });
  assert.equal(await text('#pt-time'), '25:00');

  // ---- Presets, sounds and ticking. ----
  await page.click('[data-preset="52-17"]');
  assert.equal(await status(), 'Focus 52 minutes, short breaks 17 minutes.');
  assert.deepEqual([await page.inputValue('#pt-focus'), await page.inputValue('#pt-short')], ['52', '17']);
  assert.equal(await page.getAttribute('[data-preset="52-17"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('[data-preset="25-5"]', 'aria-pressed'), 'false');
  assert.equal(await text('#pt-time'), '52:00');
  assert.equal(await hash(), `#52-17-15-4,f1~${ENC}`);
  await page.click('[data-preset="25-5"]');
  const sounds = [['beeps', 'Beeps', [1760]], ['chime', 'Chime', [1046.5, 1318.51, 2093, 2637.02]], ['clock', 'Alarm clock', [2349.32]],
    ['soft', 'Soft', [523.25, 659.26, 783.99]], ['bell', 'Bell', [880, 2428.8, 4752, 7858.4]]];
  for (const [key, label, freqs] of sounds) {
    await page.selectOption('#pt-snd-focus', key);
    await page.selectOption('#pt-snd-break', key);
    for (const [btn, which] of [['#pt-test-focus', 'focus'], ['#pt-test-break', 'a break']]) {
      const k = await oscCount();
      await page.click(btn);
      const got = await oscFrom(k);
      assert.deepEqual([...new Set(got.map(r => r.f))].sort((a, b) => a - b), freqs, key);
      assert.ok(got[0].when - got[0].now < 0.1, `${key} plays at once`);
      assert.equal(await status(), `Playing the ${label} sound, for the end of ${which}.`);
    }
  }
  await page.selectOption('#pt-snd-focus', 'beeps');
  await page.selectOption('#pt-snd-break', 'soft');
  await page.selectOption('#pt-ring', '0');
  await page.focus('#pt-vol');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#pt-vol-out'), '50%');
  await page.waitForFunction(() => Math.abs(window.__master.gain.value - 0.25) < 0.005);
  assert.equal(await hash(), `#f1~${ENC},sound=beeps-soft,vol=50,ring=0`);
  await page.selectOption('#pt-snd-focus', 'bell');
  await page.selectOption('#pt-snd-break', 'chime');
  await page.selectOption('#pt-ring', '5');
  await page.focus('#pt-vol');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await hash(), `#f1~${ENC}`);
  // Ticking: one second of sound looped, each click on a whole second
  // before the end, so it falls as the digits change.
  await page.check('#pt-tick');
  assert.equal(await hash(), `#f1~${ENC},tick`);
  await page.clock.runFor(400);
  n0 = await oscCount();
  await page.click('#pt-go');
  w = await wall();
  const tickRec = (await oscFrom(n0)).find(r => r.kind === 'buf');
  assert.ok(tickRec && tickRec.loop && Math.abs(tickRec.dur - 1) < 1e-6, JSON.stringify(tickRec));
  const endAudio = tickRec.now + (w + 1500000 - tickRec.wall) / 1000;
  assert.ok(Math.abs(tickRec.stops[0].when - (endAudio - 0.05)) < 0.02, 'the clicks stop just before the end sound');
  // Ticking turned on 1.5 s into the session still clicks on the whole
  // seconds before the end, as the digits change.
  await page.clock.runFor(1500);
  await page.uncheck('#pt-tick');
  assert.ok((await oscFrom(n0)).find(r => r.kind === 'buf').stops.length > 1, 'unticking stops the clicks');
  const n6 = await oscCount();
  await page.check('#pt-tick');
  const tick2 = (await oscFrom(n6)).find(r => r.kind === 'buf');
  const beats = tick2.now + (w + 1500000 - tick2.wall) / 1000 - tick2.when;
  assert.ok(Math.abs(beats - Math.round(beats)) < 0.02 && beats > 1497.9 && beats < 1498.6, `the first click is ${beats} s before the end`);
  await press('Space');
  assert.ok((await oscFrom(n6)).find(r => r.kind === 'buf').stops.length > 1, 'pausing stops the ticking');
  await press('r');
  await page.uncheck('#pt-tick');

  // ---- An unattended run: everything starts by itself, each session at
  // the moment the one before ended. ----
  await page.click('#pt-clear');
  assert.equal(await shown('#pt-log-wrap'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pt-log-empty');
  await page.fill('#pt-focus', '1');
  await page.fill('#pt-short', '1');
  await page.fill('#pt-long', '2');
  await page.fill('#pt-every', '2');
  await page.check('#pt-auto-break');
  await page.check('#pt-auto-focus');
  await page.fill('#pt-label', RUN.label);
  await page.clock.setSystemTime(RUN.start);
  n0 = await oscCount();
  await page.click('#pt-go');
  pre = await oscFrom(n0);
  const first = pre.find(r => r.f === 880), next = pre.find(r => r.f === 1318.51);
  assert.ok(first && Math.abs(off(first, RUN.start + 60000)) < 0.05, 'this session’s end');
  assert.ok(next && Math.abs(off(next, RUN.start + 120000)) < 0.05, 'the end of the break that follows by itself');
  // Each jump lands just after an end, so each session hands on in time.
  for (const s of RUN.sessions) await page.clock.fastForward(s.end + 5 - await wall());
  await page.clock.fastForward(RUN.upto - await wall());
  const LBL = encodeURIComponent(RUN.label);
  assert.equal(await hash(), `#1-1-2-2,f2!r${RUN.running.end}~${LBL},auto=bf`);
  assert.equal(await dots(), '1 of 2 focus sessions done in this set');
  assert.equal((await logRows()).length, RUN.sessions.length);
  const dl = page.waitForEvent('download');
  await page.click('#pt-csv');
  const file = await dl;
  assert.equal(file.suggestedFilename(), 'focus-sessions.csv');
  assert.equal(fs.readFileSync(await file.path(), 'utf8'), RUN.csv);
  assert.equal(await status(), `Downloaded ${RUN.sessions.length} sessions.`);
  await page.click('#pt-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), RUN.copied);
  // A background tab that runs its code 50 s late still hands on at the end.
  await page.clock.fastForward(RUN.running.end - (await wall()) + 50000);
  assert.equal(await hash(), `#1-1-2-2,l2!r${RUN.running.end + 120000}~${LBL},auto=bf`);
  assert.equal(sp((await logRows()).pop()[4]), sp(await page.evaluate(e => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(e)), RUN.running.end)));
  // The computer sleeps through the end: no ring and nothing starts after it.
  const n5 = await oscCount();
  await page.clock.setSystemTime(RUN.running.end + 20 * 60000);
  await page.clock.runFor(1100);
  assert.equal(await text('#pt-last'), 'The long break ended at 9:10 AM, while the page was paused or asleep, so it did not ring.');
  assert.equal(await status(), 'Long break ended at 9:10 AM, while the page was paused or asleep.');
  assert.equal(await text('#pt-go'), 'Start');
  assert.equal(await dots(), '0 of 2 focus sessions done in this set');
  assert.equal(await hash(), `#1-1-2-2,f1~${LBL},auto=bf`);
  assert.equal((await oscFrom(n5)).filter(r => Math.abs(r.when - r.now) < 1).length, 0, 'no late ring');
  await page.uncheck('#pt-auto-break');
  await page.uncheck('#pt-auto-focus');
  await page.fill('#pt-label', '');

  // ---- A background tab the browser held back: the ring scheduled ahead
  // started on time on the audio clock, so the session rang, and the page
  // says so however late its own check comes. ----
  await page.fill('#pt-label', '-1 draft');
  n0 = await oscCount();
  await page.click('#pt-go');
  const endH = (await wall()) + 60000;
  await page.clock.fastForward(57000);
  const live = (await oscFrom(n0)).filter(r => r.f === 880 && r.stops.length === 1);
  assert.ok(live.length > 0 && Math.abs(off(live[0], endH)) < 0.05, `re-timed just before the end, ${live.length && off(live[0], endH)} s off`);
  await page.waitForTimeout(Math.ceil((live[0].when - live[0].now) * 1000) + 300);
  await page.clock.fastForward(64000);
  assert.equal(await alertText(), 'Focus 1 done. Next: short break.');
  assert.match(sp(await text('#pt-last')), /^Focus 1 ended at \d{1,2}:\d\d [AP]M\.$/);
  assert.equal(await page.$eval('#pt-last', el => el.classList.contains('is-missed')), false);
  await page.keyboard.press('Escape');
  // A label that a spreadsheet would take for a formula (- + = @) is copied
  // as text.
  await page.click('#pt-copy');
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).split('\n').pop().split('\t')[2], "'-1 draft");
  await page.fill('#pt-label', '');
  await page.click('#pt-newset');
  // Skip while the alarm rings stops it too.
  await page.click('#pt-go');
  await page.clock.fastForward(60020);
  assert.equal(await text('#pt-go'), 'Stop alarm');
  await press('s');
  assert.equal(await status(), 'Skipped short break. Next: focus 2.');
  assert.equal(await text('#pt-go'), 'Start');
  assert.equal(await page.title(), baseTitle);
  await page.click('#pt-newset');

  // ---- Notifications, while the page is in the background. ----
  await page.click('#pt-notify');
  await page.waitForFunction(() => window.__notes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__notes[0]), ['Notifications are on', 'You will get one when a session ends.']);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.click('#pt-go');
  await page.clock.fastForward(60020);
  assert.deepEqual(await page.evaluate(() => window.__notes[1]), ['Focus 1 done', 'Next: short break.']);
  await page.evaluate(() => { document.hasFocus = () => true; });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__throws = true; });
  await page.click('#pt-notify');
  await page.click('#pt-notify');
  await page.waitForFunction(() => !document.querySelector('#pt-notify').checked);
  assert.match(await text('#pt-notify-msg'), /does not let web pages show notifications/);
  assert.equal(await page.getAttribute('#pt-notify', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#pt-notify', 'aria-describedby'), 'pt-notify-msg');

  // ---- Full screen, and the mini timer in a window of its own. ----
  await press('f');
  await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'pt-card');
  assert.equal(await page.$eval('.pt-settings', el => !!el.closest('[inert]')), true);
  await press('f');
  await page.waitForFunction(() => !document.fullscreenElement);
  const popup = page.context().waitForEvent('page');
  await page.dblclick('#pt-pip');
  const pip = await popup;
  await pip.waitForSelector('.pt-pip-time');
  await page.waitForTimeout(300);
  assert.equal(page.context().pages().filter(p => !p.isClosed()).length, 2, 'a double click opens one mini timer');
  assert.equal(await text('#pt-msg'), '');
  assert.equal(await status(), 'Mini timer open.');
  assert.equal(await text('#pt-pip'), 'Close mini timer');
  assert.equal(await pip.textContent('.pt-pip-phase'), 'Short break');
  assert.equal(await pip.textContent('.pt-pip-time'), '01:00');
  assert.equal(await pip.evaluate(() => getComputedStyle(document.querySelector('.btn')).minHeight), '44px', 'the page’s styles are copied in');
  await pip.click('.pt-pip-btns .btn');
  assert.equal(await text('#pt-go'), 'Pause');
  await page.clock.runFor(2100);
  // The small window redraws on its own frames.
  await pip.waitForFunction(() => document.querySelector('.pt-pip-time').textContent === '00:58', null, { timeout: 3000 });
  assert.equal(await pip.textContent('.pt-pip-btns .btn'), 'Pause');
  await pip.click('.pt-pip-btns .btn.secondary');
  assert.equal(await text('#pt-meta'), 'Focus 2 of 2 · 1 minute');
  await page.click('#pt-pip');
  await page.waitForFunction(() => document.querySelector('#pt-pip').textContent === 'Mini timer');
  assert.equal(await status(), 'Mini timer closed.');

  // ---- Addresses. ----
  await page.clock.setSystemTime(T0);
  await reopen('#50-10-15-4,f2!p600000~Draft,auto=b,tick,sound=chime-beeps,vol=50,ring=0');
  assert.equal(await text('#pt-msg'), '');
  assert.deepEqual(await Promise.all(['focus', 'short', 'long', 'every'].map(k => page.inputValue('#pt-' + k))), ['50', '10', '15', '4']);
  assert.equal(await text('#pt-time'), '10:00');
  assert.equal(await text('#pt-go'), 'Resume');
  assert.equal(await text('#pt-meta'), 'Focus 2 of 4 · paused');
  assert.equal(await dots(), '1 of 4 focus sessions done in this set');
  assert.equal(await page.inputValue('#pt-label'), 'Draft');
  assert.deepEqual(await Promise.all(['#pt-auto-break', '#pt-auto-focus', '#pt-tick'].map(s => page.isChecked(s))), [true, false, true]);
  assert.deepEqual([await page.inputValue('#pt-snd-focus'), await page.inputValue('#pt-snd-break'), await page.inputValue('#pt-ring'), await page.inputValue('#pt-vol')], ['chime', 'beeps', '0', '50']);
  assert.equal(await hash(), '#50-10-15-4,f2!p600000~Draft,auto=b,tick,sound=chime-beeps,vol=50,ring=0');
  await reopen(`#f1!r${T0 + 300000}`);
  assert.equal(await text('#pt-time'), '05:00');
  assert.equal(await text('#pt-go'), 'Pause');
  assert.equal(await page.$eval('#pt-bar', el => el.style.width), '80%');
  // Ended moments before the page opened: it counts, and the break that
  // starts by itself started at that end (no ring: no sound before a click).
  await reopen(`#f1!r${T0 - 30000},auto=b`);
  assert.equal(await alertText(), 'Focus 1 done. Short break started.');
  assert.equal(await hash(), `#s1!r${T0 - 30000 + 300000},auto=b`);
  assert.equal(await text('#pt-go'), 'Pause');
  assert.equal(await dots(), '1 of 4 focus sessions done in this set');
  assert.equal(await text('#pt-time'), '04:30');
  // Ended long before: shown, not rung, and nothing starts.
  await reopen(`#f1!r${T0 - 600000},auto=b`);
  assert.equal(await text('#pt-last'), 'Focus 1 ended at 6:50 AM, while the page was paused or asleep, so it did not ring.');
  assert.equal(await hash(), '#s1,auto=b');
  assert.equal(await text('#pt-go'), 'Start');
  // An old bookmark of a running session opens ready to start.
  await reopen(`#f1!r${T0 - 13 * 3600000}`);
  assert.equal(await text('#pt-last'), '');
  assert.equal(await hash(), '');
  await reopen('#s3');
  assert.equal(await dots(), '3 of 4 focus sessions done in this set');
  assert.equal(await text('#pt-meta'), 'Short break · 5 minutes');
  await reopen('#l4');
  assert.equal(await text('#pt-meta'), 'Long break · 15 minutes');
  const bad = ['#f9', '#25-5-15-0', '#241-5-15-4', '#f1!x5', '#sound=constructor-bell', '#vol=33', '#ring=7', '#__proto__', '#auto=x', '#%E0%A4%A', `#f1!r${T0 + 25 * 3600000}`, '#25-5-15-4,25-5-15-4'];
  for (const h of bad) {
    await reopen(h);
    assert.match(await text('#pt-msg'), /^Part of the page address could not be read: “.+”\.$/, h);
    assert.equal(await hash(), h, 'an address that could not be read is left as it was typed');
  }
  await page.click('#pt-go');
  assert.doesNotMatch(await hash(), /x5|constructor|__proto__/);
  await reopen('#how-to-use-the-focus-timer');
  assert.equal(await text('#pt-msg'), '');
  assert.equal(await hash(), '#how-to-use-the-focus-timer');
  await reopen('#f1~' + 'a'.repeat(59) + '%F0%9F%8D%9D');
  assert.equal(await page.inputValue('#pt-label'), 'a'.repeat(59));
  await reopen('#' + 'a'.repeat(39) + '%F0%9F%8D%9Db');
  const quoted = await text('#pt-msg');
  assert.ok(quoted.includes('“' + 'a'.repeat(39) + '…”'), quoted);
  await reopen('#' + 'tick,'.repeat(500));
  assert.match(await text('#pt-msg'), /longer than 2,000 characters/);
  await reopen('');
  cpu = await cpuMs(async () => {
    await page.evaluate(() => { location.hash = '#' + 'tick,'.repeat(200000); });
    await page.waitForFunction(() => /longer than 2,000/.test(document.querySelector('#pt-msg').textContent));
  });
  assert.ok(cpu < 1000, `a megabyte address took ${cpu} ms of CPU`);
  // Boxes the browser fills back in after Back are read again on pageshow.
  await reopen('');
  await page.evaluate(() => {
    document.querySelector('#pt-focus').value = '30';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await hash(), '#30-5-15-4');
  assert.equal(await text('#pt-time'), '30:00');

  const browser = page.context().browser();
  const problems = [];

  // ---- A decimal-comma language: the same whole numbers, and minutes
  // copied with a decimal comma (the CSV file keeps the point). ----
  const de = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  await de.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const dp = await de.newPage();
  watch(dp, problems);
  await dp.addInitScript(INIT);
  await dp.clock.install({ time: T0 - 1000 });
  await dp.goto(url);
  await dp.clock.pauseAt(T0);
  await dp.fill('#pt-focus', '1,5');
  assert.equal(await dp.textContent('#pt-len-err'), 'Focus: use a whole number, such as 25.');
  await dp.fill('#pt-focus', '1');
  await dp.click('#pt-go');
  await dp.clock.fastForward(30000);
  await dp.click('#pt-reset');
  await dp.click('#pt-copy');
  const copiedDe = await dp.evaluate(() => navigator.clipboard.readText());
  assert.ok(copiedDe.split('\n')[1].endsWith('\t0,5\tReset'), copiedDe);
  const dlDe = dp.waitForEvent('download');
  await dp.click('#pt-csv');
  assert.ok(fs.readFileSync(await (await dlDe).path(), 'utf8').includes(',0.5,Reset\r\n'));
  await de.close();

  // ---- A phone with a touch screen. ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  watch(pp, problems);
  await pp.route('**/*', route => { if (!route.request().url().startsWith(base)) { problems.push('outside request ' + route.request().url()); return route.abort(); } return route.continue(); });
  await pp.goto(url);
  for (const sel of ['#pt-go', '#pt-skip', '#pt-full', '#pt-newset', '#pt-modes .btn', '.pt-presets .btn', '#pt-focus', '#pt-label', '#pt-test-focus', '.checks .check']) {
    const b = await pp.locator(sel).first().boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${sel} is ${b.width}x${b.height}`);
  }
  await pp.tap('#pt-go');
  assert.equal(await pp.textContent('#pt-go'), 'Pause');
  const twoLines = () => pp.$$eval('#pt .btn, #pt select', bs => bs.filter(b => b.getClientRects().length).map(b => {
    if (b.tagName === 'SELECT') {
      const cs = getComputedStyle(b), c = document.createElement('canvas').getContext('2d');
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const widest = Math.max(...[...b.options].map(o => c.measureText(o.text).width));
      return [b.id, 1, widest > b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16];
    }
    const tops = new Set(), walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (t.parentElement.closest('.visually-hidden')) continue;
      const r = document.createRange(); r.selectNodeContents(t);
      for (const x of r.getClientRects()) if (x.width > 0) tops.add(Math.round(x.top));
    }
    return [b.textContent, tops.size, b.scrollWidth > b.clientWidth];
  }).filter(x => x[1] > 1 || x[2]));
  for (const width of [320, 340, 360, 390, 412, 480, 540]) {
    await pp.setViewportSize({ width, height: 740 });
    for (const h of ['', `#240-240-240-12,s11!p14399000~${'Ein sehr langer Name für diese Aufgabe'.repeat(2)}`]) {
      await pp.goto('about:blank');
      await pp.goto(url + h);
      const tl = await twoLines();
      assert.deepEqual(tl, [], `${width} px, ${h.slice(0, 20)}: ${JSON.stringify(tl)}`);
      assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll at ${width} px, ${h.slice(0, 20)}`);
    }
    await pp.tap('#pt-full');
    assert.deepEqual(await twoLines(), [], `full screen at ${width} px`);
    assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `full screen at ${width} px`);
    await pp.tap('#pt-full');
    await pp.waitForFunction(() => !document.fullscreenElement);
  }
  // A phone on its side: full screen still shows the main button without
  // scrolling.
  for (const [w, h] of [[915, 412], [844, 390], [667, 320]]) {
    await pp.setViewportSize({ width: w, height: h });
    await pp.goto('about:blank');
    await pp.goto(url);
    await pp.tap('#pt-go');
    await pp.tap('#pt-full');
    const r = await pp.$eval('#pt-go', el => el.getBoundingClientRect().toJSON());
    const t = await pp.$eval('#pt-time', el => el.getBoundingClientRect().toJSON());
    assert.ok(r.top >= 0 && r.bottom <= h && t.top >= 0, `${w}x${h}: time at ${t.top}, the main button at ${r.top} to ${r.bottom}`);
    assert.deepEqual(await twoLines(), [], `full screen at ${w}x${h}`);
    await pp.tap('#pt-full');
    await pp.waitForFunction(() => !document.fullscreenElement);
  }
  await phone.close();
  assert.deepEqual(problems, []);

  // ---- Leave the page running a session, with a log, for the checks that follow. ----
  await reopen('#50-10-15-4,f1~' + encodeURIComponent('A long task name that has to wrap on a phone screen'));
  await page.click('#pt-go');
  await page.clock.runFor(5000);
  await press('s');
  await press('Space');
};
