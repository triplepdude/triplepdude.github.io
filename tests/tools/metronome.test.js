const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Known answers come from tests/fixtures/metronome/expected.py (exact fractions
// for click times, the published tempo ranges, numpy's least-squares fit for tap
// tempo), never from the page's own code. Every click the page books is
// recorded (AudioBufferSourceNode.start), with its level read from the
// buffer's peak (0.9 accented beat 1, 0.62 beat, 0.38 quiet click, 0.24 quieter
// click for a sixteenth note in compound time); the sound
// that reaches the speakers is recorded too, by an AudioWorklet tapped onto
// whatever the page connects to the destination.
function hooks() {
  window.__clicks = [];
  window.__wake = [];
  const peakOf = b => { const d = b.getChannelData(0); let p = 0; for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i])); return p; };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, ...rest) {
    window.__ctx = this.context;
    const pk = peakOf(this.buffer);
    this.__rec = { when, level: pk > 0.8 ? 'A' : pk > 0.5 ? 'B' : pk > 0.3 ? 's' : 'f', peak: pk, len: this.buffer.length, booked: this.context.currentTime, cancelled: false };
    window.__clicks.push(this.__rec);
    return start.call(this, when, ...rest);
  };
  // A click stopped or disconnected before its start time never sounds.
  const stop = AudioScheduledSourceNode.prototype.stop;
  AudioScheduledSourceNode.prototype.stop = function (...a) {
    if (this.__rec && this.context.currentTime < this.__rec.when) this.__rec.cancelled = true;
    return stop.apply(this, a);
  };
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...a) {
    if (this.__rec && this.context.currentTime < this.__rec.when) this.__rec.cancelled = true;
    return disconnect.apply(this, a);
  };
  window.__rec = [];
  const src = `class R extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.f0 = 0; }
    flush() { if (this.n) { this.port.postMessage({ f0: this.f0, d: this.buf.slice(0, this.n) }); this.buf = new Float32Array(4096); this.n = 0; } }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (this.n && currentFrame !== this.f0 + this.n) this.flush();
      if (this.n === 0) this.f0 = currentFrame;
      if (ch) this.buf.set(ch, this.n);
      this.n += 128;
      if (this.n >= 4096) this.flush();
      return true;
    }
  }
  registerProcessor('rec', R);`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = connect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode && !this.context.__recSetup) {
      const ctx = this.context, node = this;
      ctx.__recSetup = true;
      ctx.audioWorklet.addModule(url).then(() => {
        const rec = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        const mute = new GainNode(ctx, { gain: 0 });
        connect.call(node, rec); connect.call(rec, mute); connect.call(mute, ctx.destination);
        rec.port.onmessage = e => window.__rec.push(e.data);
        window.__recReady = true;
      });
    }
    return r;
  };
  // Onsets (first sample above 1e-4 after 10 ms of silence) and the peak after each, between two context times.
  window.__heard = (from, to) => {
    const sr = window.__ctx.sampleRate, out = [];
    const chunks = window.__rec.filter(c => c.f0 + c.d.length > from * sr && c.f0 < to * sr);
    let quiet = 0, last = -1;
    for (const c of chunks) {
      if (c.f0 !== last) quiet = 0;
      for (let i = 0; i < c.d.length; i++) {
        const a = Math.abs(c.d[i]), f = c.f0 + i;
        if (a > 1e-4 && quiet >= sr * 0.01 && f >= from * sr && f < to * sr) out.push({ frame: f, peak: 0 });
        if (out.length && f - out[out.length - 1].frame < sr * 0.02) out[out.length - 1].peak = Math.max(out[out.length - 1].peak, a);
        quiet = a < 1e-5 ? quiet + 1 : 0;
      }
      last = c.f0 + c.d.length;
    }
    let max = 0;
    for (const c of chunks) for (let i = 0; i < c.d.length; i++) if (c.f0 + i >= from * sr && c.f0 + i < to * sr) max = Math.max(max, Math.abs(c.d[i]));
    return { sr, onsets: out, max, covered: chunks.length ? [chunks[0].f0 / sr, (chunks[chunks.length - 1].f0 + chunks[chunks.length - 1].d.length) / sr] : null };
  };
  // A stand-in Screen Wake Lock and Audio Session, to see what the page asks for.
  // As in a browser, a lock ends by itself when the page is hidden (window.__lockLost).
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => {
    window.__wake.push('request');
    const lock = new EventTarget();
    lock.release = () => { window.__wake.push('release'); window.__lock = null; return Promise.resolve(); };
    window.__lock = lock;
    return Promise.resolve(lock);
  } } });
  window.__lockLost = () => { const l = window.__lock; window.__lock = null; if (l) l.dispatchEvent(new Event('release')); };
  // Workers the page starts, and the messages they send it.
  window.__workers = [];
  const W = window.Worker;
  window.Worker = function (...a) { const w = new W(...a); window.__workers.push(w); w.__ticks = 0; w.addEventListener('message', () => w.__ticks++); return w; };
  window.Worker.prototype = W.prototype;
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { type: 'auto' } });
}

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await page.addInitScript(hooks);
  await open();

  const text = s => page.locator(s).textContent();
  const val = s => page.inputValue(s);
  const attr = (s, a) => page.getAttribute(s, a);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const now = () => page.evaluate(() => window.__ctx.currentTime);
  const clear = () => page.evaluate(() => { window.__clicks = []; });
  const played = () => page.evaluate(() => window.__clicks.filter(c => !c.cancelled).map(c => ({ when: c.when, level: c.level, len: c.len })).sort((a, b) => a.when - b.when));
  const waitClicks = (n, timeout = 15000) => page.waitForFunction(n => window.__clicks.filter(c => !c.cancelled).length >= n, n, { timeout });
  const playing = async () => (await text('#mt-start')) === 'Stop';
  const startPlay = async () => { if (!(await playing())) await page.click('#mt-start'); await page.waitForFunction(() => document.querySelector('#mt-start').textContent === 'Stop'); };
  const stopPlay = async () => { if (await playing()) await page.click('#mt-start'); };
  const setBpm = async v => { await page.fill('#mt-bpm', String(v)); await page.press('#mt-bpm', 'Enter'); };
  const settings = async ({ bpm, time, sub, accent = true, sound = 'click' }) => {
    if (time) await page.selectOption('#mt-time', time);
    if (sub) await page.selectOption('#mt-sub', String(sub));
    if (bpm != null) await setBpm(bpm);
    await page.setChecked('#mt-accent', accent);
    await page.selectOption('#mt-sound', sound);
  };
  const setHidden = h => page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    if (h) window.__lockLost();
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  const optionTexts = s => page.$$eval(s + ' option', o => o.map(x => x.textContent));

  // ---- Initial state ----
  assert.equal(await text('#mt-big'), '120');
  assert.equal(await text('#mt-mark'), 'Allegro');
  assert.equal(await text('#mt-unit'), 'Beat = quarter note');
  assert.equal(await val('#mt-slider'), '120');
  assert.equal(await attr('#mt-slider', 'aria-valuetext'), '120 BPM, Allegro');
  assert.deepEqual(await page.$$eval('#mt-dots li', l => l.map(x => x.className + ':' + x.textContent)), ['l0:1', 'l1:2', 'l1:3', 'l1:4']);
  assert.equal(await text('#mt-start'), 'Start');
  assert.equal(await text('#mt-vol-out'), '70%');
  assert.equal(await text('#mt-status'), '');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.locator('#mt-marks tr[aria-current="true"] button').getAttribute('data-bpm'), '144');
  assert.deepEqual(await optionTexts('#mt-sub'), ['Beats only', 'Eighth notes (2)', 'Triplets (3)', 'Sixteenth notes (4)']);
  // On a fresh page 6/8 comes with its eighth notes; 4/4 goes back to beats only.
  await page.selectOption('#mt-time', '6-8');
  assert.equal(await val('#mt-sub'), '3');
  assert.equal(await page.$eval('#mt-sub', s => s.options[s.selectedIndex].text), 'Eighth notes (3)');
  await page.selectOption('#mt-time', '4-4');
  assert.equal(await val('#mt-sub'), '1');
  // Accessible names start with the visible text.
  assert.equal(await page.getByRole('button', { name: '−1 BPM', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '+1 BPM', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Andante, 92 BPM', exact: true }).count(), 1);
  assert.equal(await page.getByRole('table', { name: 'Tempo markings' }).count(), 1);

  // ---- 120 BPM in 4/4: booked times and levels, then the sound itself ----
  await clear();
  await page.click('#mt-start');
  assert.equal(await text('#mt-start'), 'Stop');
  assert.equal(await text('#mt-status'), 'Playing: 120 BPM, 4/4');
  await page.waitForFunction(() => window.__recReady, null, { timeout: 5000 });
  await waitClicks(9);
  let list = await played();
  const first = (await page.evaluate(() => window.__clicks[0]));
  near(first.when - first.booked, 0.06, 0.03, 'first click after Start (s)');
  X.scenarios.default.clicks.forEach(([dt, lv], i) => {
    near(list[i].when - list[0].when, dt, 1e-9, `120 BPM click ${i + 1}`);
    assert.equal(list[i].level, lv, `120 BPM click ${i + 1} level`);
  });
  // The recorded output: each click starts on its booked sample (the first
  // sample of every click is 0, so the first non-zero one is 1 sample later).
  await page.waitForFunction(t => window.__ctx.currentTime > t + 0.3, list[8].when);
  let heard = await page.evaluate(([a, b]) => window.__heard(a, b), [list[1].when - 0.05, list[8].when + 0.1]);
  const sr = heard.sr;
  const inRec = list.slice(1, 9).filter(c => c.when >= heard.covered[0] + 0.02);
  assert.ok(inRec.length >= 6, `recorded ${inRec.length} clicks`);
  const onsetOf = c => heard.onsets.find(o => Math.abs(o.frame - c.when * sr) < sr * 0.01);
  inRec.forEach(c => {
    assert.ok(onsetOf(c), `no sound for the click at ${c.when.toFixed(3)} s`);
    near(onsetOf(c).frame - c.when * sr, 1, 1, `onset of the click at ${c.when.toFixed(3)} s, in samples`);
  });
  assert.ok(heard.onsets.every(o => list.some(c => Math.abs(o.frame - c.when * sr) < sr * 0.01)), 'a sound that was not a booked click');
  // Volume 70% is a gain of 0.49: the accented click peaks at 0.441, the others at 0.62 x 0.49.
  near(onsetOf(inRec.find(c => c.level === 'A')).peak, X.volume['70'], 0.002, 'accented click peak at 70%');
  near(onsetOf(inRec.find(c => c.level === 'B')).peak, 0.62 * 0.49, 0.002, 'beat click peak at 70%');

  // The lights follow the beats in order; the pendulum swings to both sides.
  const seen = await page.evaluate(async () => {
    const out = [], ang = [];
    const t = performance.now();
    while (performance.now() - t < 2300) {
      const on = document.querySelector('#mt-dots li.on');
      const v = on ? on.textContent : '-';
      if (out[out.length - 1] !== v) out.push(v);
      ang.push(parseFloat(document.querySelector('#mt-arm').getAttribute('transform').slice(7)));
      await new Promise(r => setTimeout(r, 25));
    }
    return { seq: out.join(''), min: Math.min(...ang), max: Math.max(...ang), count: document.querySelector('#mt-count').textContent };
  });
  const lit = seen.seq.replace(/^-/, '');
  assert.ok(lit.length >= 4 && !lit.includes('-') && [...lit].every((d, i) => i === 0 || +d === +lit[i - 1] % 4 + 1), `beat lights in order: ${seen.seq}`);
  assert.ok(seen.min < -15 && seen.max > 15 && seen.min >= -24 && seen.max <= 24, `pendulum ${seen.min} to ${seen.max}`);
  assert.match(seen.count, /^Bar \d+ · 0:0\d$/);
  // The status is written once on start, never on each beat.
  await page.evaluate(() => {
    window.__statusChanges = 0;
    new MutationObserver(() => window.__statusChanges++).observe(document.querySelector('#mt-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.__statusChanges), 0);
  // Reduced motion: the pendulum stays upright, the lights still move.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('#mt-arm').getAttribute('transform') === 'rotate(0.00 60 128)', null, { timeout: 2000 });
  const still = await page.evaluate(async () => {
    const tr = new Set(), lit = new Set();
    for (let i = 0; i < 40; i++) {
      tr.add(document.querySelector('#mt-arm').getAttribute('transform'));
      const on = document.querySelector('#mt-dots li.on');
      lit.add(on ? on.textContent : '-');
      await new Promise(r => setTimeout(r, 30));
    }
    return { tr: [...tr], lit: lit.size };
  });
  assert.deepEqual(still.tr, ['rotate(0.00 60 128)']);
  assert.ok(still.lit >= 2, 'beat lights change under reduced motion');
  await page.emulateMedia({ reducedMotion: null });
  // Volume 0 is silent; the clicks are still booked.
  await page.fill('#mt-vol', '0');
  assert.equal(await text('#mt-vol-out'), '0%');
  const t0v = await now();
  await page.waitForTimeout(900);
  heard = await page.evaluate(([a, b]) => window.__heard(a, b), [t0v + 0.3, t0v + 0.85]);
  assert.ok(heard.max < 1e-4, `output at volume 0 peaks at ${heard.max}`);
  await page.fill('#mt-vol', '100');
  // Wake lock and media playback were asked for while playing.
  assert.deepEqual(await page.evaluate(() => window.__wake), ['request']);
  assert.equal(await page.evaluate(() => navigator.audioSession.type), 'playback');
  // Stop: clicks not yet started are cancelled, and the output falls silent.
  const tStop = await page.evaluate(() => { document.querySelector('#mt-start').click(); return window.__ctx.currentTime; });
  assert.equal(await text('#mt-start'), 'Start');
  assert.equal(await text('#mt-status'), 'Stopped');
  assert.deepEqual(await page.evaluate(() => window.__wake), ['request', 'release']);
  assert.equal(await page.evaluate(() => navigator.audioSession.type), 'auto');
  list = await played();
  assert.ok(list.every(c => c.when <= tStop + 0.005), 'no click sounds after Stop');
  await page.waitForTimeout(600);
  heard = await page.evaluate(([a, b]) => window.__heard(a, b), [tStop + 0.1, tStop + 0.5]);
  assert.ok(heard.max < 1e-3, `output after Stop peaks at ${heard.max}`);
  assert.equal(await page.locator('#mt-dots li.on').count(), 0);
  assert.equal(await text('#mt-count'), '');
  await page.waitForFunction(() => window.__ctx.state === 'suspended', null, { timeout: 2000 });
  await page.fill('#mt-vol', '70');

  // ---- Time signatures, subdivisions and accents (times relative to the first click) ----
  for (const [name, hidden] of [['sixeight2', true], ['sixeight6', true], ['sixeight6sub', false], ['sixeight2six', true], ['triplets', false], ['twelve16', true], ['seven', true], ['one', false], ['noaccent', false], ['decimal', true]]) {
    const sc = X.scenarios[name];
    await settings(sc);
    await clear();
    if (hidden) await setHidden(true);
    await startPlay();
    await waitClicks(sc.clicks.length);
    const got = (await played()).slice(0, sc.clicks.length);
    await stopPlay();
    if (hidden) await setHidden(false);
    sc.clicks.forEach(([dt, lv], i) => {
      near(got[i].when - got[0].when, dt, 1e-6, `${name}: click ${i + 1} time`);
      assert.equal(got[i].level, lv, `${name}: click ${i + 1} level`);
    });
  }
  // What the page shows for each time signature.
  await settings({ bpm: 60, time: '6-8', sub: 3 });
  assert.equal(await text('#mt-unit'), 'Beat = dotted quarter note, 180 eighth notes a minute');
  assert.deepEqual(await optionTexts('#mt-sub'), ['Beats only', 'Eighth notes (3)', 'Sixteenth notes (6)']);
  assert.deepEqual(await page.$$eval('#mt-dots li', l => l.map(x => x.className)), ['l0', 'l1']);
  await page.selectOption('#mt-time', '6-8-6');
  await setBpm(180);
  assert.equal(await text('#mt-unit'), 'Beat = eighth note, 60 dotted quarters a minute');
  assert.deepEqual(await optionTexts('#mt-sub'), ['Beats only', 'Sixteenth notes (2)']);
  assert.deepEqual(await page.$$eval('#mt-dots li', l => l.map(x => x.className)), ['l0', 'l2', 'l2', 'l1', 'l2', 'l2']);
  await page.uncheck('#mt-accent');
  assert.equal(await page.$eval('#mt-dots li', l => l.className), 'l1');
  await page.check('#mt-accent');
  // Each kind of beat remembers its own subdivision.
  await page.selectOption('#mt-time', '4-4');
  await page.selectOption('#mt-sub', '4');
  await page.selectOption('#mt-time', '12-8');
  assert.equal(await val('#mt-sub'), '3', '12/8 starts with eighth notes');
  await page.selectOption('#mt-sub', '6');
  await page.selectOption('#mt-time', '3-4');
  assert.equal(await val('#mt-sub'), '4');
  await page.selectOption('#mt-time', '9-8');
  assert.equal(await val('#mt-sub'), '6');
  await page.selectOption('#mt-time', '4-4');
  await page.selectOption('#mt-sub', '1');

  // ---- A tempo change while playing keeps the phase of the beat ----
  await settings({ bpm: 60, time: '4-4', sub: 1 });
  await clear();
  await startPlay();
  // Late in the second beat, when the third click is already booked.
  await page.waitForFunction(() => {
    const c = window.__clicks.filter(c => !c.cancelled);
    return c.length >= 3 && window.__ctx.currentTime > c[1].when + 0.78;
  }, null, { timeout: 8000, polling: 10 });
  const ch = await page.evaluate(() => {
    const el = document.querySelector('#mt-bpm');
    el.value = '120';
    const before = window.__ctx.currentTime;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, after: window.__ctx.currentTime };
  });
  await waitClicks(6);
  let all = await page.evaluate(() => window.__clicks.map(c => ({ when: c.when, level: c.level, cancelled: c.cancelled })));
  list = all.filter(c => !c.cancelled).sort((a, b) => a.when - b.when);
  const lastBefore = list.filter(c => c.when <= ch.before).pop();
  const phase = (ch.before - lastBefore.when) / 1.0;
  assert.ok(phase > 0.7 && phase < 0.95, `changed at phase ${phase}`);
  const after = list.filter(c => c.when > ch.before);
  near(after[0].when, ch.before + (1 - phase) * 0.5, 0.008, 'first click at the new tempo');
  near(after[1].when - after[0].when, 0.5, 1e-9, 'interval at the new tempo');
  near(after[2].when - after[1].when, 0.5, 1e-9, 'interval at the new tempo');
  assert.deepEqual(after.slice(0, 3).map(c => c.level), ['B', 'B', 'A'], 'the bar carries on');
  // The click booked at the old tempo was cancelled.
  assert.ok(all.some(c => c.cancelled && Math.abs(c.when - (lastBefore.when + 1)) < 1e-6), 'old third click cancelled');
  await stopPlay();

  // ---- A subdivision change starts on the new grid; a time signature change starts a bar ----
  await settings({ bpm: 120, time: '4-4', sub: 1 });
  await clear();
  await startPlay();
  await page.waitForFunction(() => {
    const c = window.__clicks.filter(c => !c.cancelled);
    return c.length >= 2 && window.__ctx.currentTime > c[1].when + 0.15;
  }, null, { timeout: 8000, polling: 10 });
  const chSub = await page.evaluate(() => {
    const el = document.querySelector('#mt-sub');
    el.value = '2';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__ctx.currentTime;
  });
  await page.waitForFunction(t => window.__clicks.filter(c => !c.cancelled && c.when > t).length >= 5, chSub);
  list = await played();
  const beat2 = list[1].when;
  let next = list.filter(c => c.when > chSub);
  near(next[0].when, beat2 + 0.25, 1e-9, 'first eighth note');
  assert.deepEqual(next.slice(0, 5).map(c => [Math.round((c.when - beat2) * 1000), c.level]), [[250, 's'], [500, 'B'], [750, 's'], [1000, 'B'], [1250, 's']]);
  // 3/4 from the next beat: it is beat 1 of a new bar.
  const chTime = await page.evaluate(() => {
    const el = document.querySelector('#mt-time');
    el.value = '3-4';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__ctx.currentTime;
  });
  await page.waitForFunction(t => window.__clicks.filter(c => !c.cancelled && c.when > t).length >= 8, chTime);
  next = (await played()).filter(c => c.when > chTime);
  const beats = next.filter(c => c.level !== 's').slice(0, 4).map(c => c.level);
  assert.deepEqual(beats, ['A', 'B', 'B', 'A'], 'beats after the change to 3/4');
  const gaps = next.slice(1, 8).map((c, i) => Math.round((c.when - next[i].when) * 1000));
  assert.deepEqual(gaps, [250, 250, 250, 250, 250, 250, 250]);
  await page.waitForFunction(t => window.__ctx.currentTime > t + 0.1 && document.querySelector('#mt-count').textContent.startsWith('Bar 2'), next.find(c => c.level === 'A').when, { timeout: 5000 });
  await stopPlay();
  await page.selectOption('#mt-time', '4-4');
  await page.selectOption('#mt-sub', '1');

  // ---- Background tab: 2 seconds are queued, so a stalled page loses nothing ----
  await setBpm(120);
  await clear();
  await page.evaluate(() => { window.__wake = []; });
  await startPlay();
  await waitClicks(2);
  await setHidden(true);
  const ahead = await page.evaluate(() => Math.max(...window.__clicks.filter(c => !c.cancelled).map(c => c.when)) - window.__ctx.currentTime);
  // Every click due in the next 2 seconds is booked: the next one is due 2 s from now or later.
  assert.ok(ahead > 1.4 && ahead + 0.5 >= 1.97, `queued up to ${ahead.toFixed(2)} s ahead in a hidden tab`);
  // The page's timers stop for 1.5 s, as in a throttled background tab.
  const stall = await page.evaluate(() => { const a = window.__ctx.currentTime, t = performance.now(); while (performance.now() - t < 1500); return [a, window.__ctx.currentTime]; });
  await page.waitForTimeout(400);
  list = (await played()).filter(c => c.when <= stall[1] + 0.3);
  assert.ok(list.filter(c => c.when > stall[0] && c.when < stall[1]).length >= 2, 'clicks during the stall');
  list.slice(1).forEach((c, i) => near(c.when - list[i].when, 0.5, 1e-9, `interval ${i + 1} across the stall`));
  // The browser ended the screen lock while the page was hidden; back in view, the page asks again.
  await setHidden(false);
  await page.waitForFunction(() => window.__wake.length >= 2, null, { timeout: 2000 }).catch(() => {});
  assert.deepEqual(await page.evaluate(() => window.__wake), ['request', 'request'], 'the screen lock is asked for again back in view');
  assert.equal(await page.evaluate(() => window.__workers.length), 1, 'one timer worker');
  assert.ok(await page.evaluate(() => window.__workers[0].__ticks > 20), 'the worker ticks while playing');
  await stopPlay();
  // In view only 0.25 s is queued: after a long stall the missed clicks are
  // skipped and the beat carries on in time, instead of a burst of late clicks.
  await setBpm(240);
  await clear();
  await startPlay();
  await waitClicks(3);
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 800); });
  await page.waitForTimeout(700);
  list = await played();
  const late = await page.evaluate(() => window.__clicks.filter(c => !c.cancelled && c.when < c.booked - 0.003).map(c => c.booked - c.when));
  assert.deepEqual(late, [], 'clicks booked after their time (they would sound late, in a burst)');
  await stopPlay();
  const grid = list.map(c => (c.when - list[0].when) / 0.25);
  assert.ok(grid.every(g => Math.abs(g - Math.round(g)) < 1e-6), `clicks off the beat grid: ${grid}`);
  const steps = grid.slice(1).map((g, i) => Math.round(g - grid[i]));
  assert.ok(steps.every(s => s >= 1), 'no two clicks closer than a beat');
  assert.ok(steps.some(s => s >= 2), `no click was skipped during the stall: ${steps}`);

  // ---- Sounds: each has its own buffers; a change applies from the next click ----
  const lens = {};
  for (const sound of ['click', 'wood', 'beep', 'cowbell']) {
    await settings({ bpm: 240, time: '4-4', sub: 2, sound });
    await clear();
    await startPlay();
    await waitClicks(5);
    const got = (await played()).slice(0, 5);
    await stopPlay();
    assert.deepEqual(got.map(c => c.level), ['A', 's', 'B', 's', 'B'], sound);
    lens[sound] = got.map(c => c.len);
  }
  const secs = s => lens[s].map(n => Math.round(n / sr * 1000));
  assert.deepEqual(secs('click'), [30, 30, 30, 30, 30]);
  assert.deepEqual(secs('wood'), [140, 140, 140, 140, 140]);
  assert.deepEqual(secs('beep'), [60, 60, 60, 60, 60]);
  assert.deepEqual(secs('cowbell'), [480, 220, 400, 220, 400]);
  await settings({ bpm: 240, time: '4-4', sub: 1, sound: 'click' });
  await clear();
  await startPlay();
  await waitClicks(2);
  const chSound = await page.evaluate(() => { const el = document.querySelector('#mt-sound'); el.value = 'beep'; el.dispatchEvent(new Event('change', { bubbles: true })); return window.__ctx.currentTime; });
  await page.waitForFunction(t => window.__clicks.filter(c => !c.cancelled && c.when > t).length >= 3, chSound);
  all = await page.evaluate(() => window.__clicks.map(c => ({ when: c.when, len: c.len, cancelled: c.cancelled })));
  assert.ok(all.filter(c => !c.cancelled && c.when > chSound + 0.005).every(c => c.len === Math.round(0.06 * sr)), 'beeps after the change');
  list = all.filter(c => !c.cancelled).sort((a, b) => a.when - b.when);
  list.slice(1).forEach((c, i) => near(c.when - list[i].when, 0.25, 1e-9, `interval ${i + 1} across the sound change`));
  await stopPlay();
  // At 300 BPM in sixteenth notes a cowbell rings on through several clicks;
  // summed, the sounds would pass full scale (1.0) at 100% volume and clip. What
  // reaches the speakers stays within it, and the accented clicks keep their peak.
  await settings({ bpm: 300, time: '4-4', sub: 4, sound: 'cowbell' });
  await page.fill('#mt-vol', '100');
  await clear();
  await startPlay();
  await waitClicks(2);
  const tLoud = (await played())[1].when;
  // The recorder sends 4096 frames at a time, so wait well past the end of the range.
  await page.waitForFunction(t => window.__ctx.currentTime > t + 1.4, tLoud, { timeout: 5000 });
  heard = await page.evaluate(([a, b]) => window.__heard(a, b), [tLoud, tLoud + 1.2]);
  await stopPlay();
  assert.ok(heard.covered && heard.covered[0] <= tLoud && heard.covered[1] >= tLoud + 1.2, `recorded ${heard.covered}`);
  assert.ok(heard.max >= X.volume['100'] - 0.002 && heard.max <= 1, `cowbell at 300 BPM in sixteenths at 100%: output peaks at ${heard.max}`);
  await page.fill('#mt-vol', '70');
  await settings({ bpm: 120, time: '4-4', sub: 1, sound: 'click' });

  // ---- Tap tempo (event times set exactly; a pause over 3 s starts again) ----
  const tapSeries = (times, origin) => page.evaluate(([times, origin]) => {
    const b = document.querySelector('#mt-tap');
    for (const t of times) {
      const e = new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' });
      Object.defineProperty(e, 'timeStamp', { value: origin + t });
      b.dispatchEvent(e);
    }
    return [document.querySelector('#mt-bpm').value, document.querySelector('#mt-tapinfo').textContent];
  }, [times, origin]);
  let origin = await page.evaluate(() => performance.now() + 1e6);
  for (const name of ['even500', 'even400', 'uneven', 'two', 'restart']) {
    const [times, bpm] = X.taps[name];
    origin += 1e5;
    const [got, info] = await tapSeries(times, origin);
    assert.equal(got, String(bpm), `tap tempo ${name}`);
    const n = name === 'restart' ? 5 : times.length;
    assert.equal(info, `${bpm} BPM from ${n} taps.`);
  }
  origin += 1e5;
  assert.deepEqual(await tapSeries(X.taps.fast[0], origin), ['300', 'Your taps were faster than 300 BPM, so the tempo is 300 BPM.']);
  await page.waitForFunction(() => document.querySelector('#mt-status').textContent === 'Tap tempo: 300 BPM');
  origin += 1e5;
  assert.deepEqual(await tapSeries([0, 3200], origin), ['300', 'Keep tapping on each beat…']);
  // A held T key repeats: only the press is a tap.
  origin += 1e5;
  assert.equal(await page.evaluate(origin => {
    document.activeElement.blur();
    [[0, false], [500, true], [1000, true]].forEach(([t, repeat]) => {
      const e = new KeyboardEvent('keydown', { key: 't', repeat, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'timeStamp', { value: origin + t });
      document.body.dispatchEvent(e);
    });
    return document.querySelector('#mt-tapinfo').textContent;
  }, origin), 'Keep tapping on each beat…', 'a held T key tapped more than once');
  // Real presses: T four times about 500 ms apart, the mouse twice, Enter
  // twice. The presses' own event times are recorded, and the tempo must be
  // 60000 / the least-squares slope of exactly those times (one tap per press).
  const lsqBpm = ts => {
    const n = ts.length, m = ts.reduce((a, b) => a + b) / n, mi = (n - 1) / 2;
    let num = 0, den = 0;
    ts.forEach((t, i) => { num += (i - mi) * (t - m); den += (i - mi) * (i - mi); });
    return Math.round(60000 / (num / den));
  };
  await page.evaluate(() => {
    const b = document.querySelector('#mt-tap');
    document.addEventListener('keydown', e => { if (e.key === 't' && !e.repeat && e.target === document.body) window.__taps.push(e.timeStamp); }, true);
    b.addEventListener('pointerdown', e => window.__taps.push(e.timeStamp), true);
    b.addEventListener('click', e => { if (e.detail === 0) window.__taps.push(e.timeStamp); }, true);
  });
  const presses = async (n, gap, press) => {
    await page.waitForTimeout(3100);
    await page.evaluate(() => { window.__taps = []; });
    for (let i = 0; i < n; i++) { await press(); if (i < n - 1) await page.waitForTimeout(gap); }
    const ts = await page.evaluate(() => window.__taps);
    assert.equal(ts.length, n, 'one event per press');
    assert.equal(await val('#mt-bpm'), String(lsqBpm(ts)), `tempo from ${n} presses`);
    assert.equal(await text('#mt-tapinfo'), `${lsqBpm(ts)} BPM from ${n} taps.`);
    near(lsqBpm(ts), 60000 / gap, 60000 / gap * 0.2, 'presses about as far apart as asked');
  };
  await setBpm(60);
  await page.evaluate(() => document.activeElement.blur());
  await presses(4, 500, () => page.keyboard.press('t'));
  await presses(2, 600, () => page.click('#mt-tap'));
  await page.focus('#mt-tap');
  await presses(2, 400, () => page.keyboard.press('Enter'));

  // ---- Typing a tempo ----
  const typed = async (s, expect) => {
    await page.fill('#mt-bpm', s);
    await page.press('#mt-bpm', 'Enter');
    if (typeof expect === 'number') {
      assert.equal(await text('#mt-big'), String(expect), `"${s}"`);
      assert.equal(await val('#mt-bpm'), String(expect), `"${s}" tidied`);
      assert.equal(await attr('#mt-bpm', 'aria-invalid'), null, `"${s}" valid`);
      assert.equal(await text('#mt-bpm-msg'), '');
    } else {
      assert.equal(await attr('#mt-bpm', 'aria-invalid'), 'true', `"${s}" invalid`);
      assert.match(await text('#mt-bpm-msg'), expect, `"${s}" message`);
    }
  };
  await setBpm(120);
  await typed('92,5', 92.5);
  assert.equal(await text('#mt-mark'), 'Andante');
  assert.equal(await val('#mt-slider'), '93');
  assert.equal(await attr('#mt-slider', 'aria-valuetext'), '92.5 BPM, Andante');
  await typed('  120 bpm ', 120);
  await typed('\u0661\u0664\u0660', 140);
  await typed('\uFF11\uFF12\uFF10', 120);
  // Full-width point, comma and BPM, as an East Asian keyboard types them.
  await typed('\uFF19\uFF12\uFF0E\uFF15', 92.5);
  await typed('\uFF19\uFF12\uFF0C\uFF15', 92.5);
  await typed('\uFF11\uFF12\uFF10\uFF22\uFF30\uFF2D', 120);
  await typed('96.25', 96.3);
  const junk = /^Enter a tempo from 20 to 300 BPM, such as 120 or 92\.5\. It stays at 96\.3 BPM\.$/;
  for (const s of ['5\u00B2', '1e2', '0x78', '120\t4', '12 0', '-120', '+120', '120.', '.5', 'abc', '1,2,0', '\u0661\u066C\u0662\u0660', '\uFF15\u00B2', '\uFF0D\uFF11\uFF12\uFF10', '\uFF11\uFF45\uFF12']) await typed(s, junk);
  await typed('', junk);
  // Another setting refills an emptied field with the tempo that plays, and its message goes.
  await page.selectOption('#mt-time', '3-4');
  assert.equal(await val('#mt-bpm'), '96.3');
  assert.equal(await attr('#mt-bpm', 'aria-invalid'), null, 'refilled field still marked invalid');
  assert.equal(await text('#mt-bpm-msg'), '');
  await page.selectOption('#mt-time', '4-4');
  await typed('19.9', /^The slowest tempo is 20 BPM\. It stays at 96\.3 BPM\.$/);
  await typed('300.1', /^The fastest tempo is 300 BPM\. It stays at 96\.3 BPM\.$/);
  assert.equal(await text('#mt-big'), '96.3');
  // The field points at its message, which is an error message.
  assert.deepEqual((await attr('#mt-bpm', 'aria-describedby')).split(' ').sort(), ['mt-bpm-hint', 'mt-bpm-msg']);
  assert.equal(await page.$eval('#mt-bpm-msg', e => e.className), 'msg error');
  // A half-typed value is reported only after a pause; a valid one applies after 0.3 s.
  await page.fill('#mt-bpm', '2');
  await page.waitForTimeout(400);
  assert.equal(await text('#mt-bpm-msg'), '');
  await page.waitForFunction(() => document.querySelector('#mt-bpm-msg').textContent.startsWith('The slowest'));
  await page.locator('#mt-bpm').pressSequentially('05', { delay: 60 });
  await page.waitForFunction(() => document.querySelector('#mt-big').textContent === '205');
  assert.equal(await attr('#mt-bpm', 'aria-invalid'), null);
  // Start uses what is in the field even before the 0.3 s pause.
  await clear();
  await page.evaluate(() => {
    const el = document.querySelector('#mt-bpm');
    el.value = '88';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#mt-start').click();
  });
  await waitClicks(2);
  list = await played();
  near(list[1].when - list[0].when, 60 / 88, 1e-9, 'Start with a just-typed tempo');
  await stopPlay();
  // A megabyte pasted into the field: refused at once, no freeze.
  const big = await page.evaluate(() => {
    const el = document.querySelector('#mt-bpm');
    el.value = '1'.repeat(1 << 20);
    const t = performance.now();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return performance.now() - t;
  });
  assert.ok(big < 50, `1 MB input took ${big} ms`);
  assert.match(await text('#mt-bpm-msg'), /^That is too long for a tempo/);
  await page.fill('#mt-bpm', '');
  await page.focus('#mt-bpm');
  await page.keyboard.insertText('9'.repeat(1 << 20));
  assert.equal((await val('#mt-bpm')).length, 16, 'maxlength cuts a paste');
  await page.press('#mt-bpm', 'Enter');
  assert.match(await text('#mt-bpm-msg'), /^The fastest tempo/);
  await typed('100', 100);

  // ---- Keyboard ----
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#mt-start').textContent === 'Stop');
  await page.keyboard.press('Space');
  assert.equal(await text('#mt-start'), 'Start');
  // A held Space bar starts once; its repeats do not stop it again.
  await page.keyboard.down(' ');
  for (let i = 0; i < 3; i++) await page.keyboard.down(' ');
  await page.keyboard.up(' ');
  await page.waitForTimeout(300);
  assert.equal(await text('#mt-start'), 'Stop', 'a held Space bar toggled more than once');
  await page.keyboard.press('Space');
  assert.equal(await text('#mt-start'), 'Start');
  // On a Cyrillic or Greek layout the T key types another letter; its place still taps.
  assert.equal(await page.evaluate(() => {
    const o = performance.now() + 5e6;
    [0, 500, 1000].forEach(t => {
      const e = new KeyboardEvent('keydown', { key: '\u0435', code: 'KeyT', bubbles: true, cancelable: true });
      Object.defineProperty(e, 'timeStamp', { value: o + t });
      document.body.dispatchEvent(e);
    });
    return document.querySelector('#mt-tapinfo').textContent;
  }), '120 BPM from 3 taps.');
  // On a Latin layout only the letter counts: the key in T's place on a Dvorak keyboard types y.
  assert.equal(await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'y', code: 'KeyT', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'timeStamp', { value: performance.now() + 5e6 + 1500 });
    document.body.dispatchEvent(e);
    return document.querySelector('#mt-tapinfo').textContent;
  }), '120 BPM from 3 taps.');
  await typed('100', 100);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowUp');
  assert.equal(await text('#mt-big'), '101');
  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await text('#mt-big'), '91');
  await page.waitForFunction(() => document.querySelector('#mt-status').textContent === '91 BPM, Andante');
  // In the field, arrows step the tempo and letters or Space are just typing.
  await page.focus('#mt-bpm');
  await page.keyboard.press('ArrowUp');
  assert.equal(await val('#mt-bpm'), '92');
  await page.keyboard.press('Shift+ArrowUp');
  assert.equal(await val('#mt-bpm'), '102');
  const infoBefore = await text('#mt-tapinfo');
  await page.keyboard.press('t');
  await page.keyboard.press('Space');
  assert.equal(await val('#mt-bpm'), '102t ');
  assert.equal(await text('#mt-tapinfo'), infoBefore);
  assert.equal(await text('#mt-start'), 'Start');
  await typed('102', 102);
  // Space on a focused button presses that button.
  await page.focus('#mt-plus');
  await page.keyboard.press('Space');
  assert.equal(await text('#mt-big'), '103');
  assert.equal(await text('#mt-start'), 'Start');
  // Arrows on the tempo slider move it by 1.
  await page.focus('#mt-slider');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#mt-big'), '102');
  // Limits.
  await typed('300', 300);
  await page.click('#mt-plus');
  assert.equal(await text('#mt-big'), '300');
  await page.waitForFunction(() => document.querySelector('#mt-status').textContent === '300 BPM is the fastest tempo');
  await typed('20', 20);
  await page.click('#mt-minus');
  assert.equal(await text('#mt-big'), '20');
  // Scrolled away from the tool, the arrow keys scroll the page again.
  await page.evaluate(() => { document.activeElement.blur(); window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); });
  await page.keyboard.press('ArrowUp');
  assert.equal(await text('#mt-big'), '20');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  // ---- Tempo markings ----
  for (const [bpm, name] of X.markings) {
    await setBpm(bpm);
    assert.equal(await text('#mt-mark'), name, `marking at ${bpm} BPM`);
    assert.equal(await page.locator('#mt-marks tr[aria-current="true"] button').evaluate(b => b.firstChild.textContent), name);
  }
  await page.getByRole('button', { name: 'Andante, 92 BPM' }).click();
  assert.equal(await text('#mt-big'), '92');
  assert.equal(await text('#mt-mark'), 'Andante');
  await page.waitForFunction(() => document.querySelector('#mt-status').textContent === '92 BPM, Andante');
  // Each marking sets a tempo inside its own range.
  for (const b of await page.$$('#mt-marks button')) {
    await b.click();
    assert.equal(await text('#mt-mark'), await b.evaluate(x => x.firstChild.textContent));
  }

  // ---- Settings in the page address ----
  await settings({ bpm: 92.5, time: '6-8', sub: 6, accent: false, sound: 'wood' });
  await page.fill('#mt-vol', '30');
  await page.waitForFunction(() => location.hash === '#bpm=92.5&time=6-8&sub=6&sound=wood&accent=0', null, { timeout: 3000 });
  await page.reload();
  assert.equal(await val('#mt-bpm'), '92.5');
  assert.equal(await val('#mt-time'), '6-8');
  assert.equal(await val('#mt-sub'), '6');
  assert.equal(await val('#mt-sound'), 'wood');
  assert.equal(await page.isChecked('#mt-accent'), false);
  assert.equal(await val('#mt-vol'), '70', 'the volume is never kept');
  assert.equal(await text('#mt-unit'), 'Beat = dotted quarter note, 277.5 eighth notes a minute');
  // Edited in the address bar: applied at once.
  await page.evaluate(() => { location.hash = '#bpm=200&time=3-4'; });
  await page.waitForFunction(() => document.querySelector('#mt-big').textContent === '200');
  assert.equal(await val('#mt-time'), '3-4');
  assert.equal(await page.$$eval('#mt-dots li', l => l.length), 3);
  // Hostile, malformed or overlong addresses are ignored.
  for (const h of ['#bpm=abc&time=__proto__&sub=5&sound=%22%3E&accent=2', '#bpm=1e2&time=constructor', '#bpm=60&x=' + 'a'.repeat(300), '#bpm=400', '#bpm=59.95']) {
    await page.goto('about:blank');
    await page.goto(url + h);
    assert.equal(await text('#mt-big'), '120', h);
    assert.equal(await val('#mt-time'), '4-4', h);
    assert.equal(await val('#mt-sub'), '1', h);
    assert.equal(await val('#mt-sound'), 'click', h);
    assert.equal(await page.isChecked('#mt-accent'), true, h);
  }
  await page.goto('about:blank');
  await page.goto(url + '#how-to-use-the-metronome');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => location.hash), '#how-to-use-the-metronome');
  await setBpm(130);
  await page.waitForFunction(() => location.hash.startsWith('#bpm=130&'), null, { timeout: 3000 });
  // Back to the defaults: the address loses its settings.
  await page.goto(url + '#bpm=96&sound=beep');
  assert.equal(await text('#mt-big'), '96');
  await settings({ bpm: 120, time: '4-4', sub: 1 });
  await page.waitForFunction(() => location.hash === '', null, { timeout: 3000 });

  // ---- Back button: what the fields show is what plays ----
  await setBpm(150);
  await page.waitForFunction(() => location.hash.startsWith('#bpm=150'));
  await page.fill('#mt-bpm', '15x');
  await page.goto(base + '/about/');
  await page.goBack();
  await page.waitForFunction(() => {
    const f = document.querySelector('#mt-bpm');
    return document.querySelector('#mt-big').textContent === '150' && (f.value === '150' || document.querySelector('#mt-bpm-msg').textContent !== '');
  });
  const back = await page.evaluate(() => ({ field: document.querySelector('#mt-bpm').value, msg: document.querySelector('#mt-bpm-msg').textContent, inv: document.querySelector('#mt-bpm').getAttribute('aria-invalid') }));
  if (back.field === '150') assert.equal(back.inv, null);
  else { assert.equal(back.field, '15x'); assert.equal(back.inv, 'true'); assert.match(back.msg, /It stays at 150 BPM/); }
  // Some browsers restore the fields after the script has run, without events: pageshow reads them again.
  await page.evaluate(() => {
    document.querySelector('#mt-bpm').value = '15x';
    document.querySelector('#mt-time').value = '3-4';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  assert.equal(await page.$$eval('#mt-dots li', l => l.length), 3, 'restored time signature shown');
  assert.equal(await attr('#mt-bpm', 'aria-invalid'), 'true', 'restored half-typed tempo reported');
  assert.match(await text('#mt-bpm-msg'), /It stays at 150 BPM/);
  await page.fill('#mt-bpm', '150');
  await page.press('#mt-bpm', 'Enter');
  await page.selectOption('#mt-time', '4-4');
  await clear();
  await page.click('#mt-start');
  await waitClicks(2);
  list = await played();
  near(list[1].when - list[0].when, 0.4, 1e-9, '150 BPM after Back');
  await stopPlay();

  // ---- The browser pauses the sound: the page says so ----
  await page.click('#mt-start');
  await waitClicks(1);
  await page.evaluate(() => window.__ctx.suspend());
  await page.waitForFunction(() => document.querySelector('#mt-error').textContent !== '');
  assert.equal(await text('#mt-error'), 'The browser paused the sound. Press Start to play again.');
  assert.equal(await text('#mt-start'), 'Start');
  await page.click('#mt-start');
  await page.waitForFunction(() => document.querySelector('#mt-start').textContent === 'Stop');
  assert.equal(await text('#mt-error'), '');
  await stopPlay();
  assert.equal(await attr('#mt-error', 'role'), 'alert');

  // ---- Other browsers: no Web Audio; a decimal-comma locale ----
  const browser = page.context().browser();
  const ctxNo = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctxNo.newPage();
  const errors = [];
  p2.on('pageerror', e => errors.push(e.message));
  await p2.addInitScript(() => { delete window.AudioContext; delete window.webkitAudioContext; });
  await p2.goto(url);
  await p2.click('#mt-start');
  assert.equal(await p2.textContent('#mt-error'), 'This browser cannot play sound (it has no Web Audio support).');
  assert.equal(await p2.textContent('#mt-start'), 'Start');
  assert.deepEqual(errors, []);
  await ctxNo.close();
  // The page's own timers stopped, as in a throttled background tab: the worker's timer keeps booking clicks.
  const ctxSlow = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p4 = await ctxSlow.newPage();
  await p4.addInitScript(hooks);
  await p4.addInitScript(() => { window.setInterval = () => 0; });
  await p4.goto(url);
  await p4.click('#mt-start');
  await p4.waitForTimeout(2000);
  const span = await p4.evaluate(() => { const w = window.__clicks.filter(c => !c.cancelled).map(c => c.when); return [w.length, Math.max(...w) - Math.min(...w)]; });
  assert.ok(span[0] >= 4 && span[1] >= 1.4, `with the page's timers stopped: ${span[0]} clicks over ${span[1]} s`);
  await ctxSlow.close();
  const ctxDe = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' });
  const p3 = await ctxDe.newPage();
  await p3.goto(url);
  for (const [s, shown] of [['92,5', '92.5'], ['92.5', '92.5'], ['1.000', null], ['100,25', '100.3']]) {
    await p3.fill('#mt-bpm', s);
    await p3.press('#mt-bpm', 'Enter');
    if (shown) assert.equal(await p3.textContent('#mt-big'), shown, `de-DE "${s}"`);
    else assert.equal(await p3.getAttribute('#mt-bpm', 'aria-invalid'), 'true', `de-DE "${s}" is 1 BPM, too slow`);
  }
  await ctxDe.close();

  // ---- Long sounds at fast tempos: the summed output never passes full scale ----
  // The page's own engine, rendered offline: its AudioContext is an
  // OfflineAudioContext, and with the tab hidden and its timers stopped it books
  // 2 s of clicks on Start and on each change, and nothing else. Every sound,
  // time signature and subdivision the page offers plays for 1.6 s at 100%
  // volume; each new setting goes into the address while the rendering is
  // paused. The known answer is the same clicks rendered again and summed, with
  // nothing changed but this: when a click starts while others still ring, and
  // their loudest from then on (from a sample earlier, as a start between two
  // samples is interpolated) plus its own peak pass 1.0, they fade out over the
  // 3 ms before it.
  const SR = 48000, SEG = 1.6;
  const pairs = (await page.evaluate(() => {
    const time = document.querySelector('#mt-time'), sub = document.querySelector('#mt-sub'), out = [], was = time.value;
    [...time.options].forEach((o, ti) => {
      time.value = o.value;
      time.dispatchEvent(new Event('change'));
      [...sub.options].forEach((s, si) => out.push({ time: o.value, sub: +s.value, si, ti }));
    });
    time.value = was;
    time.dispatchEvent(new Event('change'));
    return out;
  })).sort((a, b) => a.si - b.si || a.ti - b.ti);
  // In this order every new setting also changes the time signature, so each part starts a bar.
  assert.equal(pairs.length, 7 * 4 + 3 * 3 + 2, 'time signatures and subdivisions');
  assert.ok(pairs.every((p, i) => !i || p.time !== pairs[i - 1].time));
  const offline = ({ SR, LEN }) => {
    window.__clicks = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, ...rest) {
      this.__rec = { when, buf: this.buffer, cancelled: false, cutAt: 0 };
      window.__clicks.push(this.__rec);
      return start.call(this, when, ...rest);
    };
    for (const [proto, name] of [[AudioScheduledSourceNode.prototype, 'stop'], [AudioNode.prototype, 'disconnect']]) {
      const f = proto[name];
      proto[name] = function (...a) { if (this.__rec && this.context.currentTime < this.__rec.when) this.__rec.cancelled = true; return f.apply(this, a); };
    }
    const Off = window.OfflineAudioContext;
    window.AudioContext = function () {
      const c = new Off(1, LEN, SR);
      Object.defineProperty(c, 'state', { get: () => 'running' });
      c.resume = c.suspend = () => Promise.resolve();
      window.__off = c;
      return c;
    };
    delete window.webkitAudioContext;
    delete window.Worker;
    window.setInterval = () => 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  };
  const renderOffline = async (bpm, sound) => {
    const ctxOff = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const po = await ctxOff.newPage();
    const errs = [];
    po.on('pageerror', e => errs.push(e.message));
    await po.addInitScript(offline, { SR, LEN: Math.round(pairs.length * SEG * SR) });
    await po.goto(`${url}#bpm=${bpm}&time=${pairs[0].time}&sub=${pairs[0].sub}&sound=${sound}&accent=1`);
    await po.fill('#mt-vol', '100');
    await po.click('#mt-start');
    const r = await po.evaluate(async ({ pairs, SEG, SR, bpm, sound }) => {
      const off = window.__off, P = OfflineAudioContext.prototype, wrong = [];
      pairs.forEach((p, i) => {
        if (i) P.suspend.call(off, i * SEG).then(() => {
          history.replaceState(null, '', `#bpm=${bpm}&time=${p.time}&sub=${p.sub}&sound=${sound}&accent=1`);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
          const got = ['#mt-bpm', '#mt-time', '#mt-sub', '#mt-sound'].map(s => document.querySelector(s).value).join(' ');
          if (got !== `${bpm} ${p.time} ${p.sub} ${sound}`) wrong.push(got);
          P.resume.call(off);
        });
      });
      const out = (await off.startRendering()).getChannelData(0);
      const clicks = window.__clicks.filter(c => !c.cancelled).sort((a, b) => a.when - b.when);
      const rests = new Map(), rest = b => {
        if (!rests.has(b)) {
          const d = b.getChannelData(0), r = new Float32Array(d.length);
          for (let i = d.length - 1, m = 0; i >= 0; i--) r[i] = m = Math.max(m, Math.abs(d[i]));
          rests.set(b, r);
        }
        return rests.get(b);
      };
      let cuts = 0;
      clicks.forEach((k, j) => {
        const ringing = [];
        let sum = rest(k.buf)[0];
        for (let i = 0; i < j; i++) {
          const c = clicks[i], at = Math.floor((k.when - c.when) * SR) - 1;
          if (!c.cutAt && at < c.buf.length) { sum += rest(c.buf)[Math.max(0, at)]; ringing.push(c); }
        }
        if (sum > 1) ringing.forEach(c => { c.cutAt = k.when; cuts++; });
      });
      // Channel 0: the known answer; channel 1: the same clicks with nothing cut.
      // Sources are added 2 s ahead, as one waiting to start costs time on every block.
      const ref = new OfflineAudioContext(2, out.length, SR), mix = ref.createChannelMerger(2);
      mix.connect(ref.destination);
      let n = 0;
      const add = until => {
        for (; n < clicks.length && clicks[n].when < until; n++) {
          const c = clicks[n], g = ref.createGain(), a = ref.createBufferSource(), b = ref.createBufferSource();
          a.buffer = b.buffer = c.buf;
          a.connect(g).connect(mix, 0, 0);
          b.connect(mix, 0, 1);
          if (c.cutAt) { g.gain.setValueAtTime(1, c.cutAt - 0.003); g.gain.linearRampToValueAtTime(0, c.cutAt); }
          a.start(c.when);
          b.start(c.when);
        }
      };
      add(2);
      for (let t = 1; t < out.length / SR - 0.01; t++) ref.suspend(t).then(() => { add(t + 2); ref.resume(); });
      const known = await ref.startRendering(), exp = known.getChannelData(0), plain = known.getChannelData(1);
      let diff = 0, at = 0;
      for (let f = 0; f < out.length; f++) { const x = Math.abs(out[f] - exp[f]); if (x > diff) { diff = x; at = f; } }
      const peaks = pairs.map((p, i) => {
        let m = 0, u = 0;
        for (let f = Math.round(i * SEG * SR), e = Math.round((i + 1) * SEG * SR); f < e; f++) { m = Math.max(m, Math.abs(out[f])); u = Math.max(u, Math.abs(plain[f])); }
        return { setting: `${p.time} ${p.sub}`, peak: m, uncut: u };
      });
      return { wrong, clicks: clicks.length, cuts, diff, at: at / SR, peaks };
    }, { pairs, SEG, SR, bpm, sound });
    await ctxOff.close();
    assert.deepEqual(errs, [], `${sound} at ${bpm} BPM: page errors`);
    assert.deepEqual(r.wrong, [], `${sound} at ${bpm} BPM: settings not applied`);
    assert.ok(r.clicks >= pairs.length * SEG * bpm / 60, `${sound} at ${bpm} BPM: ${r.clicks} clicks`);
    assert.ok(r.diff <= 1e-6, `${sound} at ${bpm} BPM: output differs from the known answer by ${r.diff} at ${r.at.toFixed(4)} s`);
    const top = r.peaks.reduce((a, b) => (b.peak > a.peak ? b : a));
    assert.ok(top.peak <= 1, `${sound} at ${bpm} BPM, ${top.setting}: output peaks at ${top.peak}`);
    return r;
  };
  const uncut = {};
  for (const sound of await page.$$eval('#mt-sound option', o => o.map(x => x.value))) {
    // At 120 BPM nothing is cut: the output is the clicks' plain sum.
    const slow = await renderOffline(120, sound);
    assert.equal(slow.cuts, 0, `${sound} at 120 BPM: ${slow.cuts} sounds cut`);
    const fast = await renderOffline(300, sound);
    uncut[sound] = Math.max(...fast.peaks.map(p => p.uncut));
  }
  // Summed with nothing cut, beep and cowbell would pass full scale at 300 BPM.
  assert.ok(uncut.beep > 1.05 && uncut.cowbell > 1.1, `uncut peaks at 300 BPM: ${JSON.stringify(uncut)}`);

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const ph = await phone.newPage();
  await ph.addInitScript(hooks);
  await ph.goto(url);
  await ph.tap('#mt-start');
  await ph.waitForFunction(() => document.querySelector('#mt-start').textContent === 'Stop');
  await ph.waitForFunction(() => window.__clicks.length >= 2);
  // The touches' own times (a tap from the test takes longer than 500 ms): the
  // tempo is 60000 / the least-squares slope of those times.
  await ph.evaluate(() => { window.__touches = []; document.querySelector('#mt-tap').addEventListener('pointerdown', e => window.__touches.push([e.pointerType, e.timeStamp])); });
  for (let i = 0; i < 4; i++) { await ph.tap('#mt-tap'); if (i < 3) await ph.waitForTimeout(500); }
  const touches = await ph.evaluate(() => window.__touches);
  assert.deepEqual(touches.map(t => t[0]), ['touch', 'touch', 'touch', 'touch']);
  assert.equal(await ph.inputValue('#mt-bpm'), String(lsqBpm(touches.map(t => t[1]))), 'tempo tapped on a touch screen');
  near(lsqBpm(touches.map(t => t[1])), 120, 25, 'touch taps about 500 ms apart');
  await ph.tap('#mt-start');
  assert.equal(await ph.textContent('#mt-start'), 'Start');
  // Every control is at least 44 px tall, and no text is cut off in a select or button, from 320 to 540 px.
  const small = await ph.$$eval('.mt button, .mt select, .mt input[type="text"], .mt input[type="range"], .mt .check', els => els.filter(e => e.getClientRects().length && e.getBoundingClientRect().height < 44).map(e => e.id || e.textContent.trim()));
  assert.deepEqual(small, [], 'controls under 44 px on a touch screen');
  for (const width of [320, 340, 360, 375, 390, 414, 480, 540]) {
    await ph.setViewportSize({ width, height: 800 });
    await ph.fill('#mt-bpm', '299.5');
    await ph.press('#mt-bpm', 'Enter');
    const cut = await ph.evaluate(() => {
      const out = [], c = document.createElement('canvas').getContext('2d');
      for (const s of document.querySelectorAll('.mt select')) {
        const cs = getComputedStyle(s);
        c.font = cs.font;
        const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 18;
        for (const o of s.options) if (c.measureText(o.text).width > room) out.push(s.id + ': ' + o.text);
      }
      for (const b of document.querySelectorAll('.mt button, .mt-num, .mt-mark, .mt-unit')) if (b.scrollWidth > b.clientWidth + 1) out.push(b.id || b.className);
      return out;
    });
    assert.deepEqual(cut, [], `cut off at ${width} px`);
    assert.ok(await ph.evaluate(w => document.documentElement.scrollWidth <= w, width), `sideways scroll at ${width} px`);
  }
  await phone.close();

  // ---- What the page says about itself ----
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.ok(links.includes('/online-tuner/') && links.includes('/tone-generator/'), `guide links: ${links}`);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), `${href} is not a tool page`);
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/metronome\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the metronome');
  for (const q of ['metronome', 'tap tempo', 'bpm', '6/8', 'allegro', 'subdivisions']) assert.ok(q.split(' ').every(w => hay.includes(w)), `homepage search finds nothing for "${q}"`);
  // The guide's numbers are the table's numbers.
  const guide = await page.textContent('.prose');
  assert.match(guide, /Andante is 76 to\s+108 BPM and\s+Allegro 120 to 168/);
  assert.match(guide, /last 12 taps/);
  assert.match(guide, /0\.25 seconds ahead while the page is in view and 2\s+seconds ahead in a background tab/);
  // Left on screen for the runner's phone-width checks: an error and the longest bar.
  await page.goto(url);
  await page.selectOption('#mt-time', '7-4');
  await typed('abc', /^Enter a tempo/);
};
