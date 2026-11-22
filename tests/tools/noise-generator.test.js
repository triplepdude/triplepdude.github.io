const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected values come from tests/fixtures/noise-generator/expected.py (numpy
// and scipy, from the definitions: BS.1770 K-weighting, Kellet's pink filter,
// ISO 226 contours, zoneinfo for the UK clock changes), never from this page.
// The sound itself is captured at the speakers and analysed here: RMS,
// K-weighted loudness (LUFS) and octave-band spectra with a Hann-windowed FFT.

// ---------- Signal analysis ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}
function biquad(x, b, a) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const meanSq = (x, from = 0) => { let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i]; return s / (x.length - from); };
const dB = p => 10 * Math.log10(p);
// Blocks of [L, R] Float32Arrays at rate sr -> RMS per channel, LUFS, octave bands.
function analyse(blocks, sr, kw, centres) {
  let msL = 0, msR = 0, kL = 0, kR = 0;
  const bandP = centres.map(() => 0);
  const n = blocks[0][0].length, win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  for (const [L, R] of blocks) {
    msL += meanSq(L); msR += meanSq(R);
    // 4096 samples let the K filters settle before they are measured.
    kL += meanSq(biquad(biquad(L, kw[0][0], kw[0][1]), kw[1][0], kw[1][1]), 4096);
    kR += meanSq(biquad(biquad(R, kw[0][0], kw[0][1]), kw[1][0], kw[1][1]), 4096);
    for (const x of [L, R]) {
      const re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = x[i] * win[i];
      fft(re, im);
      centres.forEach((fc, j) => {
        const lo = Math.ceil(fc / Math.SQRT2 * n / sr), hi = Math.ceil(fc * Math.SQRT2 * n / sr);
        let s = 0;
        for (let k = lo; k < hi; k++) s += re[k] * re[k] + im[k] * im[k];
        bandP[j] += s / (hi - lo);
      });
    }
  }
  const nb = blocks.length, ref = bandP[centres.indexOf(1000)];
  return {
    rmsL: dB(msL / nb), rmsR: dB(msR / nb),
    lufs: -0.691 + dB(kL / nb + kR / nb),
    bands: bandP.map(p => dB(p / ref)),
  };
}
// Short-term loudness through one block [L, R]: K-weighted power in windows of
// win seconds (half overlapping, after 4096 samples for the filters to
// settle), as dB from the block's median window.
function swing([L, R], sr, kw, win) {
  const k = x => biquad(biquad(x, kw[0][0], kw[0][1]), kw[1][0], kw[1][1]);
  const a = k(L), b = k(R), n = Math.round(win * sr), out = [];
  for (let i = 4096; i + n <= a.length; i += n >> 1) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += a[j] * a[j] + b[j] * b[j];
    out.push(dB(s / n));
  }
  const med = out.slice().sort((p, q) => p - q)[out.length >> 1];
  return { min: Math.min(...out) - med, max: Math.max(...out) - med };
}
function highpass(fc, sr) { // Audio EQ Cookbook, Q 0.7071: [b, a]
  const w = 2 * Math.PI * fc / sr, c = Math.cos(w), al = Math.sin(w) / Math.SQRT2, a0 = 1 + al;
  return [[(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], [1, -2 * c / a0, (1 - al) / a0]];
}
function slope(levels, freqs) { // least-squares dB per octave
  const x = freqs.map(Math.log2), mx = x.reduce((a, b) => a + b) / x.length, my = levels.reduce((a, b) => a + b) / levels.length;
  let sxy = 0, sxx = 0;
  x.forEach((v, i) => { sxy += (v - mx) * (levels[i] - my); sxx += (v - mx) ** 2; });
  return sxy / sxx;
}
function correlation(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}
function parseWav(buf) {
  const s = (o, n) => buf.toString('latin1', o, o + n);
  if (s(0, 4) !== 'RIFF' || s(8, 4) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  const out = { riff: buf.readUInt32LE(4) };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = s(o, 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') { out.format = buf.readUInt16LE(o + 8); out.channels = buf.readUInt16LE(o + 10); out.rate = buf.readUInt32LE(o + 12); out.bits = buf.readUInt16LE(o + 22); }
    else if (id === 'data') { out.data = buf.subarray(o + 8, o + 8 + size); }
    o += 8 + size + (size % 2);
  }
  return out;
}

// ---------- Hooks installed before the page's own script ----------
function hooks() {
  const log = window.__log = { contexts: [], worklets: 0, sources: [], buffers: [], wake: 0, posts: [], clip: 0, edges: [], handlers: {}, positions: [], session: [] };
  const P = BaseAudioContext.prototype;
  const remember = ctx => { if (!log.contexts.includes(ctx)) log.contexts.push(ctx); };
  const createGain = P.createGain;
  P.createGain = function () { remember(this); return createGain.call(this); };
  const createBufferSource = P.createBufferSource;
  P.createBufferSource = function () { const s = createBufferSource.call(this); log.sources.push(s); return s; };
  const createBuffer = P.createBuffer;
  P.createBuffer = function (ch, len, rate) { log.buffers.push(len / rate); return createBuffer.call(this, ch, len, rate); };
  if (window.AudioWorkletNode) {
    const AWN = window.AudioWorkletNode;
    window.AudioWorkletNode = function (ctx, name, opts) { log.worklets++; log.workletOptions = JSON.parse(JSON.stringify(opts || {})); return new AWN(ctx, name, opts); };
    window.AudioWorkletNode.prototype = AWN.prototype;
  }
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (m, ...rest) { log.posts.push(JSON.parse(JSON.stringify(m))); return post.call(this, m, ...rest); };
  // Every automation call is kept on its AudioParam.
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) {
    const f = AudioParam.prototype[m];
    if (!f) continue;
    // [method, ...numeric arguments, the context's currentTime when it was called]
    AudioParam.prototype[m] = function (...args) { const c = log.contexts[0]; (this.__calls || (this.__calls = [])).push([m, ...args.map(a => (typeof a === 'number' ? a : null)), c ? c.currentTime : null]); return f.apply(this, args); };
  }
  // Connections are recorded; whatever reaches the speakers is also fed to
  // two analysers (left and right) for the test to read.
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = connect.call(this, dest, ...rest);
    if (dest instanceof AudioNode) log.edges.push([this, dest]);
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      if (!ctx.__tap) {
        const up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        const sp = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
        const L = new AnalyserNode(ctx, { fftSize: 32768 }), R = new AnalyserNode(ctx, { fftSize: 32768 });
        connect.call(up, sp); connect.call(sp, L, 0); connect.call(sp, R, 1);
        ctx.__tap = { up, L, R, ctx };
        window.__tap = ctx.__tap;
      }
      connect.call(this, ctx.__tap.up);
    }
    return r;
  };
  window.__grab = () => {
    const t = window.__tap, a = new Float32Array(32768), b = new Float32Array(32768);
    t.L.getFloatTimeDomainData(a); t.R.getFloatTimeDomainData(b);
    const enc = x => { const u = new Uint8Array(x.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    return { L: enc(a), R: enc(b), now: t.ctx.currentTime, sr: t.ctx.sampleRate };
  };
  // The graph from the speakers backwards: volume, sleep-timer fader, play envelope.
  window.__chain = () => {
    const into = n => log.edges.filter(e => e[1] === n && !(e[0] instanceof AnalyserNode)).map(e => e[0]);
    const ctx = log.contexts[0];
    const vol = into(ctx.destination).find(n => n instanceof GainNode && n !== ctx.__tap.up);
    const fader = into(vol)[0], env = into(fader)[0];
    return { vol, fader, env };
  };
  window.__calls = which => { const c = window.__chain()[which]; return (c.gain.__calls || []).slice(); };
  if (navigator.wakeLock) navigator.wakeLock.request = function () { log.wake++; return Promise.reject(new DOMException('blocked by the test', 'NotAllowedError')); };
  if (window.MediaSession) {
    const sah = MediaSession.prototype.setActionHandler;
    MediaSession.prototype.setActionHandler = function (a, f) { log.handlers[a] = f; return sah.call(this, a, f); };
    const sps = MediaSession.prototype.setPositionState;
    MediaSession.prototype.setPositionState = function (s) { log.positions.push(s ? { duration: String(s.duration) } : null); return sps.call(this, s); };
  }
  // Safari's audio session, which Chromium does not have.
  const session = { t: 'auto' };
  Object.defineProperty(session, 'type', { get() { return this.t; }, set(v) { this.t = v; log.session.push(v); } });
  Object.defineProperty(Navigator.prototype, 'audioSession', { configurable: true, get() { return session; } });
  if (navigator.clipboard) {
    const wt = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = t => { log.clip++; return wt(t); };
  }
}

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await page.addInitScript(hooks);
  await open();

  const text = s => page.locator(s).textContent();
  const attr = (s, a) => page.getAttribute(s, a);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed ? a.toFixed(2) : a}, expected ${b} ± ${tol}`);
  const waitText = (sel, re, timeout = 5000) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout });
  const playing = () => waitText('#ng-live', /^Playing$/);
  const contexts = () => page.evaluate(() => window.__log.contexts.length);
  const blur = () => page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  const setRange = (sel, v) => page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const announced = want => page.waitForFunction(w => ((document.querySelector('body > .visually-hidden[role="status"]') || {}).textContent || '') === w, want, { timeout: 3000 })
    .then(() => want, async () => page.evaluate(() => (document.querySelector('body > .visually-hidden[role="status"]') || {}).textContent || ''));
  // Non-overlapping blocks of 32,768 samples from the speakers.
  async function capture(n) {
    const blocks = [];
    let g;
    for (let i = 0; i < n; i++) {
      if (i) await page.waitForFunction(t => window.__tap.ctx.currentTime >= t + 0.75, g.now, { timeout: 10000 });
      g = await page.evaluate(() => window.__grab());
      const f = b64 => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
      blocks.push([f(g.L), f(g.R)]);
    }
    return { blocks, sr: g.sr };
  }
  let R = null; // expected values for the page's sample rate
  async function measure(n = 6) {
    const c = await capture(n);
    R = X.rates[String(c.sr)];
    assert.ok(R, `no expected values for a ${c.sr} Hz audio context (expected.py covers 44,100 and 48,000 Hz)`);
    return Object.assign(analyse(c.blocks, c.sr, R.kweight, X.centres), { blocks: c.blocks });
  }
  // Waits until a colour or tone change has cross-faded and settled.
  // (0.4 s cross-fade, then a whole 0.74 s block of the new sound).
  const settle = () => page.waitForTimeout(1300);

  // ---- Defaults: nothing plays and no audio engine starts until Play ----
  assert.equal(await text('#ng-big'), 'White noise');
  assert.equal(await page.isChecked('input[name="ng-colour"][value="white"]'), true);
  assert.equal(await page.inputValue('#ng-tone'), '0');
  assert.equal(await attr('#ng-tone', 'aria-valuetext'), 'Neutral');
  assert.equal(await page.inputValue('#ng-vol'), '20');
  assert.equal(await attr('#ng-vol', 'aria-valuetext'), '20%');
  assert.equal(await page.inputValue('#ng-timer'), '0');
  assert.equal(await text('#ng-play'), 'Play');
  assert.equal(await page.isVisible('#ng-live'), false);
  assert.equal(await contexts(), 0, 'an AudioContext was created before Play');
  assert.equal(await attr('#ng-keep', 'src'), null);

  // The graph's text gives the expected spectrum at 100 Hz and 10 kHz
  // (scipy: the filters' responses re 1 kHz; before Play the page uses 48 kHz).
  const sign = v => { const r = Math.round(v); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + ' dB'; };
  const label = (c, pts, tone = 'neutral') => `Expected spectrum of ${c} noise, tone ${tone}: ${sign(pts[0])} at 100 Hz, 0 dB at 1 kHz and ${sign(pts[1])} at 10 kHz.`;
  for (const c of ['white', 'pink', 'brown', 'green', 'grey', 'blue', 'violet']) {
    await page.click(`label.ng-col:has(input[value="${c}"])`);
    await page.waitForFunction(l => document.getElementById('ng-canvas').getAttribute('aria-label') === l, label(c, X.rates['48000'].points_100_10k[c]), { timeout: 3000 })
      .catch(async () => assert.fail(`canvas label for ${c}: ${await attr('#ng-canvas', 'aria-label')}`));
  }
  assert.equal(await text('#ng-sub'), 'Rises 6 dB per octave: a thin, high hiss.');
  await page.click('label.ng-col:has(input[value="white"])');

  // ---- Links: the colour and tone, never the volume, never autoplay ----
  // Each one a fresh load (the query string differs); hash-only changes are tested below.
  let load = 0;
  for (const [hash, colour, tone] of [['#pink&tone=-4', 'pink', '-4'], ['#tone=3&red', 'brown', '3'], ['#GRAY', 'grey', '0'], ['#violet&vol=100&tone=12', 'violet', '12']]) {
    await page.goto(`${url}?n=${++load}${hash}`);
    assert.equal(await page.isChecked(`input[name="ng-colour"][value="${colour}"]`), true, `${hash} selects ${colour}`);
    assert.equal(await page.inputValue('#ng-tone'), tone, `${hash} sets the tone`);
    assert.equal(await page.inputValue('#ng-vol'), '20', `${hash} leaves the volume at 20%`);
    assert.equal(await text('#ng-play'), 'Play');
    assert.equal(await contexts(), 0, `${hash} started the audio engine`);
    // The graph's text names the tone as the slider does ("dB", not "db").
    const tv = +tone, toneWords = tv ? `${Math.abs(tv)} dB ${tv < 0 ? 'darker' : 'brighter'}` : 'neutral';
    await page.waitForFunction(w => document.getElementById('ng-canvas').getAttribute('aria-label').includes(w), `, tone ${toneWords}: `, { timeout: 3000 })
      .catch(async () => assert.fail(`graph label for ${hash}: ${await attr('#ng-canvas', 'aria-label')}`));
  }
  assert.equal(await attr('#ng-tone', 'aria-valuetext'), '12 dB brighter');
  // Junk, words that are properties of every object, bad escapes and a
  // megabyte of hash: defaults, no errors.
  for (const hash of ['#constructor', '#__proto__&tone=toString', '#%E0%A4%A', '#tone=99', '#' + 'x'.repeat(1 << 20)]) {
    await page.goto(`${url}?n=${++load}${hash}`);
    assert.equal(await page.isChecked('input[name="ng-colour"][value="white"]'), true, `defaults for ${hash.slice(0, 30)}`);
    assert.equal(await page.inputValue('#ng-tone'), '0');
    assert.equal(await text('#ng-big'), 'White noise');
  }
  await page.goto(url);
  // A hash typed into the address bar (or a link on the page) applies at once.
  await page.evaluate(() => { location.hash = '#green&tone=-2'; });
  await page.waitForFunction(() => document.querySelector('input[value="green"]').checked);
  assert.equal(await page.inputValue('#ng-tone'), '-2');
  // A link without a tone means tone 0; junk leaves everything as it is.
  await page.evaluate(() => { location.hash = '#junk'; });
  await page.waitForTimeout(100);
  assert.equal(await page.inputValue('#ng-tone'), '-2');
  await page.evaluate(() => { location.hash = '#gray'; });
  await page.waitForFunction(() => document.querySelector('input[value="grey"]').checked);
  assert.equal(await page.inputValue('#ng-tone'), '0');
  assert.equal(await attr('#ng-tone', 'aria-valuetext'), 'Neutral');
  assert.equal(await contexts(), 0);
  // The address follows the controls (after a short pause), and Copy link copies it.
  await page.click('label.ng-col:has(input[value="blue"])');
  await setRange('#ng-tone', 3);
  await page.waitForFunction(() => location.hash === '#blue&tone=3', null, { timeout: 3000 });
  await setRange('#ng-tone', 0);
  await page.waitForFunction(() => location.hash === '#blue', null, { timeout: 3000 });
  await setRange('#ng-tone', 3);
  await page.dblclick('#ng-link');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${url}#blue&tone=3`);
  assert.equal(await page.evaluate(() => window.__log.clip), 1, 'a double click copied twice');
  await page.goto(url);

  // ---- Play: worklet, fade-in, 20% volume, lock-screen plumbing ----
  await page.click('#ng-play');
  await playing();
  const lg = await page.evaluate(() => ({
    worklets: window.__log.worklets, sources: window.__log.sources.length, opts: window.__log.workletOptions,
    session: window.__log.session.slice(), wake: window.__log.wake, handlers: Object.keys(window.__log.handlers).sort(),
    positions: window.__log.positions.slice(), state: window.__log.contexts[0].state,
    ms: { title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title, art: navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork[0].src, state: navigator.mediaSession.playbackState },
    keep: (k => ({ paused: k.paused, loop: k.loop, muted: k.muted, volume: k.volume, src: k.src, controls: k.controls, shown: k.getClientRects().length }))(document.getElementById('ng-keep')),
  }));
  assert.equal(lg.state, 'running');
  assert.equal(lg.worklets, 1, 'the noise comes from an AudioWorklet');
  assert.equal(lg.sources, 0, 'no buffer is played (or looped) when the worklet runs');
  assert.deepEqual(lg.opts.outputChannelCount, [2]);
  assert.equal(lg.opts.processorOptions.colour, 'white');
  near(lg.opts.processorOptions.gain / X.rates[String(await page.evaluate(() => window.__log.contexts[0].sampleRate))].colours.white.gain, 1, 0.005, 'white: gain given to the engine (ratio)');
  assert.equal(lg.opts.processorOptions.seed.length, 4);
  assert.deepEqual(lg.session, ['playback'], 'Safari audio session while playing');
  assert.equal(lg.wake, 0, 'no wake lock');
  assert.deepEqual(lg.handlers, ['nexttrack', 'pause', 'play', 'previoustrack', 'stop']);
  assert.deepEqual(lg.positions.slice(-1), [{ duration: 'Infinity' }]);
  assert.deepEqual(lg.ms, { title: 'White noise', art: base + '/assets/apple-touch-icon.png', state: 'playing' });
  assert.equal(lg.keep.paused, false, 'the keep-alive element plays');
  assert.equal(lg.keep.loop && !lg.keep.muted && lg.keep.volume === 1 && !lg.keep.controls && lg.keep.shown === 0, true, `keep-alive: ${JSON.stringify(lg.keep)}`);
  assert.equal(await text('#ng-play'), 'Stop');
  assert.equal(await announced('Playing white noise'), 'Playing white noise');
  // The keep-alive: an 8 s, 8 kHz, 16-bit mono WAV Blob of +-1 LSB noise
  // (longer than Chrome for Android's 5 s limit for lock-screen controls).
  const keep = await page.evaluate(async () => {
    const b = await (await fetch(document.getElementById('ng-keep').src)).blob();
    return { type: b.type, bytes: Array.from(new Uint8Array(await b.arrayBuffer())) };
  });
  assert.equal(keep.type, 'audio/wav');
  const wav = parseWav(Buffer.from(keep.bytes));
  const K = X.keepalive;
  assert.deepEqual([wav.format, wav.channels, wav.rate, wav.bits, wav.data.length / 2, keep.bytes.length, wav.riff], [1, K.channels, K.rate, K.bits, K.frames, K.bytes, K.bytes - 8]);
  const vals = new Set();
  for (let i = 0; i < wav.data.length; i += 2) vals.add(wav.data.readInt16LE(i));
  assert.deepEqual([...vals].sort(), [-1, 0, 1], 'near-silent but not digital silence');
  // The fade-in: the envelope is anchored, then ramps to full over 2 s.
  const env = await page.evaluate(() => window.__calls('env'));
  const ramp = env.findIndex(c => c[0] === 'linearRampToValueAtTime' && c[1] === 1);
  assert.ok(ramp >= 2 && env[ramp - 2][0] === 'cancelScheduledValues' && env[ramp - 1][0] === 'setValueAtTime' && env[ramp - 1][2] === env[ramp - 2][1], `fade-in calls: ${JSON.stringify(env)}`);
  near(env[ramp][2] - env[ramp - 1][2], 2, 0.001, 'fade-in length (s)');
  assert.equal(env[ramp - 1][1], 0, 'the fade-in starts from silence');
  await page.waitForFunction(() => window.__tap.ctx.currentTime > 0, null);
  await page.waitForTimeout(2300);

  // ---- Levels: 20% start, then every colour at the same loudness ----
  let m = await measure(3);
  near(m.rmsL, R.colours.white.rms_db + 20 * Math.log10(0.2), 0.35, 'white at 20%: left RMS (dBFS)');
  near(m.rmsR, R.colours.white.rms_db + 20 * Math.log10(0.2), 0.35, 'white at 20%: right RMS (dBFS)');
  // The channels are independent streams, so stereo noise sounds wide.
  assert.ok(Math.abs(correlation(m.blocks[0][0], m.blocks[0][1])) < 0.05, 'left and right are the same noise');
  await setRange('#ng-vol', 100);
  assert.equal(await text('#ng-vol-out'), '100%');
  await page.waitForTimeout(300);
  const lufs = {};
  for (const [key, c] of [['1', 'white'], ['2', 'pink'], ['3', 'brown'], ['4', 'green'], ['5', 'grey'], ['6', 'blue'], ['7', 'violet']]) {
    await blur();
    await page.keyboard.press(key);
    assert.equal(await page.isChecked(`input[name="ng-colour"][value="${c}"]`), true, `key ${key}`);
    await settle();
    m = await measure(6);
    const e = R.colours[c];
    lufs[c] = m.lufs;
    // The level the page asks its engine for, against expected.py's (0.5%).
    const sent = await page.evaluate(() => window.__log.posts[window.__log.posts.length - 1]);
    if (c !== 'white') { assert.equal(sent.colour, c); near(sent.gain / e.gain, 1, 0.005, `${c}: gain sent to the engine (ratio)`); }
    near(m.lufs, e.lufs, 0.5, `${c}: loudness (LUFS)`);
    near(m.rmsL, e.rms_db, 0.6, `${c}: left RMS (dBFS)`);
    near(m.rmsR, e.rms_db, 0.6, `${c}: right RMS (dBFS)`);
    const bands = X.slope_bands.map(f => m.bands[X.centres.indexOf(f)]);
    const def = { white: 0, pink: -3, brown: -6, blue: 3, violet: 6 }[c];
    if (def !== undefined) {
      near(slope(bands, X.slope_bands), def, 0.4, `${c}: slope 125 Hz to 8 kHz (dB per octave)`);
      near(slope(bands, X.slope_bands), e.slope_125_8k, 0.3, `${c}: slope against the filter's own response`);
    }
    // Green has no standard: the page's definition (pink through a 500 Hz band-pass).
    if (c === 'green') X.centres.forEach((f, i) => near(m.bands[i], e.bands_rel_1k[i], 1, `green: ${f} Hz band re 1 kHz`));
    // Grey: the ISO 226 40-phon target itself, capped at +20 dB.
    if (c === 'grey') X.centres.forEach((f, i) => near(m.bands[i], X.grey_target_bands_rel_1k[i], 2, `grey: ${f} Hz band re 1 kHz against ISO 226`));
  }
  const spread = Math.max(...Object.values(lufs)) - Math.min(...Object.values(lufs));
  assert.ok(spread <= 0.6, `colours differ in loudness by ${spread.toFixed(2)} LU: ${JSON.stringify(lufs)}`);
  // Brown, the quietest for its power, sets the level: white is turned down
  // about 7.7 dB, not brown boosted (which would clip).
  near(R.colours.brown.rms_db - R.colours.white.rms_db, 7.7, 0.1, 'expected.py: white turned down against brown');
  assert.ok(Object.values(R.colours).every(e => e.rms_db <= -17.99), 'no colour louder than -18 dBFS RMS');

  // ---- Tone: darker or brighter at the same loudness, capped for brown ----
  for (const [key, c, t, valuetext] of [['1', 'white', -12, '12 dB darker'], ['3', 'brown', -12, '12 dB darker'], ['2', 'pink', 12, '12 dB brighter']]) {
    await blur();
    await page.keyboard.press(key);
    await setRange('#ng-tone', t);
    assert.equal(await attr('#ng-tone', 'aria-valuetext'), valuetext);
    await settle();
    m = await measure(6);
    const e = R.tones[`${c}${t > 0 ? '+' : ''}${t}`];
    near(m.lufs, e.lufs, 0.5, `${c} tone ${t}: loudness`);
    near(m.rmsL, e.rms_db, 0.6, `${c} tone ${t}: RMS`);
    X.centres.forEach((f, i) => { if (f >= 125) near(m.bands[i], e.bands_rel_1k[i], 1, `${c} tone ${t}: ${f} Hz band`); });
    const post = await page.evaluate(() => window.__log.posts[window.__log.posts.length - 1]);
    assert.deepEqual([post.colour, post.tone], [c, t]);
    near(post.gain / e.gain, 1, 0.005, `${c} tone ${t}: gain sent to the engine (ratio)`);
  }
  near(R.tones['brown-12'].lufs - R.colours.brown.lufs, -0.5, 0.1, 'expected.py: darker brown is capped, not boosted');
  await setRange('#ng-tone', 0);

  // ---- Tone jumps and colour changes hold the loudness: no swell, no dip ----
  // One block (0.7 s) from the speakers, ending secs (audio clock) after the
  // change fn() makes reaches the sound engine, so a busy page cannot shift it.
  const around = async (fn, secs) => {
    const n = await page.evaluate(() => window.__log.posts.length);
    await fn();
    const t0 = await (await page.waitForFunction(k => window.__log.posts.length > k && window.__tap.ctx.currentTime, n, { timeout: 5000 })).jsonValue();
    await page.waitForFunction(t => window.__tap.ctx.currentTime >= t, t0 + secs, { timeout: 10000 });
    const c = await capture(1);
    return { block: c.blocks[0], kw: X.rates[String(c.sr)].kweight, sr: c.sr };
  };
  // Home and End (or a click on the slider's track) jump the tone by 24 dB:
  // the level follows the tone as it glides, so every 20 ms stays within
  // 2 dB (violet used to swell by 8 dB, white by 4).
  for (const [key, c, from, press, to] of [['7', 'violet', 12, 'Home', '-12'], ['1', 'white', -12, 'End', '12']]) {
    await blur();
    await page.keyboard.press(key);
    await setRange('#ng-tone', from);
    await settle();
    await page.focus('#ng-tone');
    const a = await around(() => page.keyboard.press(press), 0.3);
    assert.equal(await page.inputValue('#ng-tone'), to);
    const s = swing(a.block, a.sr, a.kw, 0.02);
    assert.ok(s.max < 2 && s.min > -2, `${c}, tone ${from} to ${to}: the loudness swings from ${s.min.toFixed(1)} to +${s.max.toFixed(1)} dB (20 ms windows)`);
  }
  // A colour change cross-fades at a constant power (the colours are
  // independent and equally loud), so it does not dip half-way (pink and
  // grey dipped by 1 dB, white and brown by 2.5).
  await setRange('#ng-tone', 0);
  await blur();
  await page.keyboard.press('2');
  await settle();
  const dips = [];
  for (const key of ['5', '2', '5', '2']) {
    const a = await around(() => page.keyboard.press(key), 0.5);
    dips.push(swing(a.block, a.sr, a.kw, 0.05).min);
    await page.waitForTimeout(700);
  }
  const dip = dips.reduce((p, q) => p + q) / dips.length;
  assert.ok(dip > -0.55, `pink and grey cross-fades dip by ${dip.toFixed(2)} dB (mean of ${dips.map(d => d.toFixed(2)).join(', ')}; 50 ms windows)`);
  // The cross-fade takes 0.4 s rather than switching at once (which clicks):
  // from brown to violet the treble above 4 kHz builds up over it.
  await page.keyboard.press('3');
  await settle();
  {
    // Treble power in 10 ms windows; the full level from a later block.
    const treble = a => {
      const hp = highpass(4000, a.sr), y = biquad(biquad(a.block[0], hp[0], hp[1]), hp[0], hp[1]), n = Math.round(0.01 * a.sr), p = [];
      for (let i = 4096; i + n <= y.length; i += n) p.push(meanSq(y.subarray(i, i + n)));
      return p;
    };
    const p = treble(await around(() => page.keyboard.press('7'), 0.3));
    await page.waitForFunction(t => window.__tap.ctx.currentTime >= t, await page.evaluate(() => window.__tap.ctx.currentTime) + 0.9, { timeout: 10000 });
    const c = await capture(1), later = treble({ block: c.blocks[0], sr: c.sr }).sort((u, v) => u - v), full = later[later.length >> 1];
    // (Up to 60% of the full level: steady violet hardly ever dips that low in 10 ms.)
    const rising = p.filter(v => v > 0.1 * full && v < 0.6 * full).length;
    assert.ok(rising >= 8, `brown to violet: the treble rose from 10% to 60% of its full level in ${rising * 10} ms (a 400 ms cross-fade takes about 200 ms)`);
  }
  await page.keyboard.press('2');
  await settle();
  assert.equal(await text('#ng-big'), 'Pink noise');

  // ---- Volume ramps are anchored too ----
  const vol = await page.evaluate(() => window.__calls('vol'));
  const vr = vol.filter(c => c[0] === 'linearRampToValueAtTime');
  assert.equal(vr[vr.length - 1][1], 1, 'volume 100% is a gain of 1');
  // A volume change glides over 50 ms, so dragging the slider does not crackle.
  const vi = vol.lastIndexOf(vr[vr.length - 1]);
  near(vol[vi][2] - vol[vi - 1][2], 0.05, 0.001, 'volume ramp length (s)');

  // ---- Sleep timer (minutes), booked on the audio clock ----
  await page.selectOption('#ng-timer', '15');
  const tz = await page.evaluate(() => { const o = Intl.DateTimeFormat().resolvedOptions(); return { locale: o.locale, timeZone: o.timeZone, now: Date.now() }; });
  const at15 = new Intl.DateTimeFormat(tz.locale, { timeStyle: 'short', timeZone: tz.timeZone }).format(new Date(tz.now + 15 * 60000));
  // Computed here from the page's clock, locale and time zone (either side of a minute boundary).
  const fmt15 = ms => new Intl.DateTimeFormat(tz.locale, { timeStyle: 'short', timeZone: tz.timeZone }).format(new Date(ms)).replace(/\s/g, ' ');
  const info = (await text('#ng-tinfo')).replace(/\s/g, ' ');
  const okInfo = [tz.now - 1500, tz.now, tz.now + 1500].some(n => [fmt15(n + 15 * 60000), fmt15(n + 15 * 60000) + ' tomorrow'].some(s => info === `Stops at ${s} (in 15 min), after fading out over the last 2 minutes.`));
  assert.ok(okInfo, `timer text: ${info} (now ${at15})`);
  let fd = await page.evaluate(() => window.__calls('fader'));
  const ex = fd.map(c => c[0]).lastIndexOf('exponentialRampToValueAtTime');
  assert.ok(ex > 0, `no fade booked: ${JSON.stringify(fd)}`);
  const end = fd[ex][2], hold = fd[ex - 1];
  assert.deepEqual([hold[0], hold[1]], ['setValueAtTime', 1], 'full level until the fade starts');
  near(end - hold[2], 120, 0.001, 'fade length (s)');
  assert.deepEqual([fd[ex][1], fd[ex + 1][0], fd[ex + 1][1], fd[ex + 1][2]], [1e-4, 'setValueAtTime', 0, end]);
  const cx = await page.evaluate(() => window.__tap.ctx.currentTime);
  near(end - cx, 900, 3, 'the fade ends 15 minutes from now on the audio clock');
  // Turning the timer off ramps the fader back up, again from an anchor.
  await page.selectOption('#ng-timer', '0');
  assert.equal(await text('#ng-tinfo'), '');
  fd = await page.evaluate(() => window.__calls('fader'));
  assert.deepEqual(fd.slice(-3).map(c => c[0]), ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']);
  assert.equal(fd[fd.length - 1][1], 1);
  // Every ramp on the envelope, fader and volume is booked right after
  // cancelScheduledValues(now) and setValueAtTime(v, now), at the time of
  // booking: Firefox otherwise jumps, and the spec starts an unanchored ramp
  // from an older event.
  for (const which of ['env', 'fader', 'vol']) {
    const calls = await page.evaluate(w => window.__calls(w), which);
    calls.forEach((c, i) => {
      if (!/Ramp/.test(c[0])) return;
      let j = i - 1;
      while (j >= 0 && calls[j][0] !== 'cancelScheduledValues') j--;
      const at = c[c.length - 1];
      assert.ok(j >= 0 && calls[j + 1][0] === 'setValueAtTime' && calls[j + 1][2] === calls[j][1] && calls[j][1] >= at - 0.05, `${which}: unanchored ramp at call ${i}: ${JSON.stringify(calls.slice(Math.max(0, i - 3), i + 1))}`);
      for (let k = j + 2; k < i; k++) assert.notEqual(calls[k][0], 'setTargetAtTime');
    });
  }

  // ---- Clock time: an empty or half-typed time is an error, after a pause ----
  await page.selectOption('#ng-timer', 'clock');
  assert.equal(await page.isVisible('#ng-at'), true);
  await page.fill('#ng-at', '');
  assert.equal(await text('#ng-at-msg'), '', 'no message on the first keystroke');
  await waitText('#ng-at-msg', /^Enter the time to stop at, or choose another timer setting\.$/);
  assert.equal(await attr('#ng-at', 'aria-invalid'), 'true');
  assert.equal(await attr('#ng-at', 'aria-describedby'), 'ng-at-msg');
  // A megabyte pasted into the field is refused by the browser, quickly.
  await page.$eval('#ng-at', el => { el.value = '0'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await page.inputValue('#ng-at'), '');
  await page.fill('#ng-at', '23:59');
  assert.equal(await text('#ng-at-msg'), '');
  assert.equal(await attr('#ng-at', 'aria-invalid'), null);
  await page.selectOption('#ng-timer', '0');

  // ---- Lock-screen buttons ----
  assert.equal(await text('#ng-big'), 'Pink noise');
  await page.evaluate(() => window.__log.handlers.nexttrack());
  assert.equal(await text('#ng-big'), 'Brown noise');
  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata.title), 'Brown noise');
  await page.evaluate(() => window.__log.handlers.previoustrack());
  await page.evaluate(() => window.__log.handlers.previoustrack());
  assert.equal(await text('#ng-big'), 'White noise');
  await page.evaluate(() => window.__log.handlers.pause());
  assert.equal(await text('#ng-play'), 'Play');
  assert.deepEqual(await page.evaluate(() => [document.getElementById('ng-keep').paused, navigator.mediaSession.playbackState, window.__log.session.slice(-1)[0]]), [true, 'paused', 'auto']);
  await page.waitForFunction(() => window.__log.contexts[0].state === 'suspended', null, { timeout: 3000 });
  await page.evaluate(() => window.__log.handlers.play());
  await playing();
  assert.equal(await page.evaluate(() => window.__log.worklets), 1, 'the worklet is reused');

  // ---- Interruptions ----
  // A suspension the page did not ask for (a call, an alarm) is resumed.
  await page.evaluate(() => window.__log.contexts[0].suspend());
  await page.waitForFunction(() => window.__log.contexts[0].state === 'running' && document.getElementById('ng-live').textContent === 'Playing', null, { timeout: 5000 });
  await page.waitForTimeout(1400);
  assert.equal(await text('#ng-msg'), '', 'a resume that worked leaves no message');
  // When the browser will not resume (resume() never settles, as in WebKit
  // bug 281566), Resume appears and works once the browser allows it.
  await page.evaluate(() => { const c = window.__log.contexts[0]; window.__resume = c.resume; c.resume = () => new Promise(() => {}); c.suspend(); });
  await waitText('#ng-play', /^Resume$/);
  assert.match(await text('#ng-msg'), /^The sound was interrupted, for example by a call or an alarm\./);
  assert.equal(await text('#ng-live'), 'Paused');
  await page.evaluate(() => { const c = window.__log.contexts[0]; c.resume = window.__resume; });
  await page.click('#ng-play');
  await playing();
  assert.equal(await text('#ng-msg'), '');
  // The device pausing the keep-alive (headphones out, another app) silences the noise.
  await page.evaluate(() => document.getElementById('ng-keep').pause());
  await waitText('#ng-play', /^Resume$/);
  assert.match(await text('#ng-msg'), /^Paused by your device/);
  m = await measure(1);
  assert.ok(m.rmsL < -80, `noise still audible after the device paused it: ${m.rmsL.toFixed(1)} dBFS`);
  // ...and comes back when the device resumes the keep-alive.
  await page.evaluate(() => document.getElementById('ng-keep').play());
  await playing();
  await page.waitForTimeout(2000); // a 1 s fade-in, then a whole block
  m = await measure(1);
  near(m.rmsL, R.colours.white.rms_db, 1, 'white back after the interruption');
  // A call on an iPhone stops the audio context and pauses the keep-alive too:
  // when the context comes back by itself, the keep-alive plays again (or the
  // lock screen would lose its controls).
  await page.evaluate(() => { const c = window.__log.contexts[0]; c.resume = () => new Promise(() => {}); c.suspend(); });
  await page.waitForFunction(() => document.getElementById('ng-live').textContent !== 'Playing');
  await page.evaluate(() => new Promise(done => { const k = document.getElementById('ng-keep'); k.addEventListener('pause', done, { once: true }); k.pause(); }));
  await page.evaluate(() => { const c = window.__log.contexts[0]; c.resume = window.__resume; return c.resume(); });
  await playing();
  assert.equal(await page.evaluate(() => document.getElementById('ng-keep').paused), false, 'the keep-alive stayed paused after the context came back');
  assert.equal(await text('#ng-play'), 'Stop');

  // ---- Keyboard ----
  await blur();
  await page.keyboard.press('ArrowRight');
  assert.equal(await text('#ng-big'), 'Pink noise');
  assert.equal(await announced('Pink noise'), 'Pink noise');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#ng-big'), 'White noise');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#ng-big'), 'Violet noise', 'wraps around');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.inputValue('#ng-vol'), '95');
  assert.equal(await announced('Volume 95%'), 'Volume 95%');
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
  assert.equal(await page.inputValue('#ng-vol'), '0', 'the volume stops at 0');
  await page.keyboard.press('ArrowUp');
  assert.equal(await attr('#ng-vol', 'aria-valuetext'), '5%');
  await page.keyboard.press(' ');
  assert.equal(await text('#ng-play'), 'Play');
  assert.equal(await announced('Stopped'), 'Stopped');
  await page.keyboard.press(' ');
  await playing();
  // Clicking a colour or a slider focuses it: Space still plays and stops
  // there, and the digits still pick a colour, with Shift too (as French
  // keyboards type them).
  await page.click('label.ng-col:has(input[value="violet"])');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'violet');
  await page.keyboard.press(' ');
  assert.equal(await text('#ng-play'), 'Play', 'Space on a focused colour did not stop the noise');
  await page.focus('#ng-tone');
  await page.keyboard.press(' ');
  await playing();
  assert.equal(await page.inputValue('#ng-tone'), '0');
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '4', code: 'Digit4', shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(await text('#ng-big'), 'Green noise', 'a digit typed with Shift did not pick a colour');
  await page.keyboard.press('7');
  assert.equal(await text('#ng-big'), 'Violet noise');
  // Space held down stops once, without flicking on and off as it repeats.
  await blur();
  await page.keyboard.down(' ');
  await page.keyboard.down(' ');
  await page.keyboard.up(' ');
  assert.equal(await text('#ng-play'), 'Play', 'a repeating Space toggled the sound again');
  await page.keyboard.press(' ');
  await playing();
  // Arrows on the sleep-timer list choose a timer, not the volume.
  const volBefore = await page.inputValue('#ng-vol');
  await page.focus('#ng-timer');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual([await page.inputValue('#ng-timer'), await page.inputValue('#ng-vol')], ['15', volBefore]);
  await page.selectOption('#ng-timer', '0');
  // Digits do not change the colour while typing a time.
  await page.selectOption('#ng-timer', 'clock');
  await page.focus('#ng-at');
  await page.keyboard.type('0630');
  assert.equal(await text('#ng-big'), 'Violet noise');
  assert.match(await page.inputValue('#ng-at'), /^(06|18):30$/, 'the digits went into the field (AM or PM as it was)');
  await page.selectOption('#ng-timer', '0');
  // Keys pressed on a link in the guide, or with the tool scrolled away, are
  // not the tool's.
  await page.focus('.prose a[href="/speaker-test/"]');
  await page.keyboard.press('3');
  await page.keyboard.press('ArrowRight');
  assert.equal(await text('#ng-big'), 'Violet noise', 'a key pressed on a link in the guide changed the colour');
  await blur();
  await page.evaluate(() => document.querySelector('.faq').scrollIntoView({ behavior: 'instant' }));
  assert.ok(await page.evaluate(() => document.querySelector('.ng').getBoundingClientRect().bottom < 0), 'the tool is scrolled away');
  await page.keyboard.press('3');
  assert.equal(await text('#ng-big'), 'Violet noise', 'a key changed the colour while the tool was scrolled away');
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  // Play comes first, right under the colour's name, so it is on a phone's
  // first screen. Tab reaches it with a visible focus ring, and Enter presses it.
  assert.ok(await page.evaluate(() => document.querySelector('#ng-play').compareDocumentPosition(document.querySelector('input[name="ng-colour"]')) & Node.DOCUMENT_POSITION_FOLLOWING), 'Play comes before the colours');
  await page.focus('#ng-night');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ng-play');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
  await page.keyboard.press('Enter');
  assert.equal(await text('#ng-play'), 'Play');
  // A double click starts once and keeps playing.
  await page.dblclick('#ng-play');
  await playing();
  await page.waitForTimeout(300);
  assert.equal(await text('#ng-play'), 'Stop');

  // ---- Night screen ----
  await page.click('#ng-night');
  assert.equal(await page.evaluate(() => document.getElementById('ng-nightdlg').open), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ng-wake');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ng-nightdlg')).backgroundColor), 'rgb(0, 0, 0)');
  await page.click('#ng-wake');
  assert.equal(await page.evaluate(() => document.getElementById('ng-nightdlg').open), true, 'one tap in the dark does not wake the page');
  await page.click('#ng-wake');
  assert.equal(await page.evaluate(() => document.getElementById('ng-nightdlg').open), false);
  await page.click('#ng-night');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('ng-nightdlg').open), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ng-night', 'focus returns to the button');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.getElementById('ng-nightdlg').open), false, 'Enter returns at once');
  assert.equal(await text('#ng-play'), 'Stop', 'the noise played on');

  // ---- The graph draws the measured spectrum while playing ----
  await page.locator('#ng-canvas').scrollIntoViewIfNeeded();
  const pixels = () => page.$eval('#ng-canvas', c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 1000000007; return h; });
  const p1 = await pixels();
  await page.waitForTimeout(400);
  assert.notEqual(await pixels(), p1, 'the measured curve does not update');

  // ---- Main-thread time while playing (CPU time, not wall time) ----
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const cpu = async () => (await cdp.send('Performance.getMetrics')).metrics.find(x => x.name === 'TaskDuration').value;
  const c0 = await cpu();
  const t0 = await page.evaluate(() => window.__tap.ctx.currentTime);
  await page.waitForFunction(t => window.__tap.ctx.currentTime >= t + 3, t0, { timeout: 15000 });
  const used = await cpu() - c0;
  assert.ok(used < 0.6, `main thread busy for ${used.toFixed(2)} s of CPU in 3 s of playing`);

  // ---- Leaving the page stops the sound and gives the phone's audio back ----
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await text('#ng-play'), 'Play');
  assert.deepEqual(await page.evaluate(() => [document.getElementById('ng-keep').paused, window.__log.session.slice(-1)[0], navigator.mediaSession.playbackState]), [true, 'auto', 'paused']);
  await page.click('#ng-play');
  await playing();

  // ---- Stop ----
  await page.click('#ng-play');
  assert.equal(await text('#ng-play'), 'Play');
  // Stop fades out over 0.25 s (from an anchor), never cuts off with a click.
  const envStop = await page.evaluate(() => window.__calls('env')).then(c => c.slice(-2));
  assert.deepEqual([envStop[0][0], envStop[1][0], envStop[1][1]], ['setValueAtTime', 'linearRampToValueAtTime', 0], `stop: ${JSON.stringify(envStop)}`);
  near(envStop[1][2] - envStop[0][2], 0.25, 0.001, 'stop fade-out length (s)');
  await page.waitForFunction(() => window.__log.contexts[0].state === 'suspended', null, { timeout: 3000 });
  assert.deepEqual(await page.evaluate(() => [document.getElementById('ng-keep').paused, window.__log.session.slice(-1)[0], window.__log.wake, window.__log.contexts.length]), [true, 'auto', 0, 1]);

  // ---- Back to the page: the shown values match the controls ----
  await setRange('#ng-vol', 60);
  await page.goto(base + '/');
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('ng-big'));
  assert.equal(await text('#ng-vol-out'), (await page.inputValue('#ng-vol')) + '%');
  assert.equal(await text('#ng-play'), 'Play');

  const browser = page.context().browser();
  const extraProblems = [];
  async function extraPage(options, init) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const p = await ctx.newPage();
    p.on('pageerror', e => extraProblems.push(`page error: ${e.message}`));
    p.on('console', msg => { if (msg.type() === 'error') extraProblems.push(`console error: ${msg.text()}`); });
    await p.route('**/*', r => (r.request().url().startsWith(base) || /^(data|blob):/.test(r.request().url()) ? r.continue() : (extraProblems.push('external request ' + r.request().url()), r.abort())));
    await p.addInitScript(hooks);
    if (init) await p.addInitScript(init);
    return { ctx, p };
  }

  // ---- Sleep timer at a clock time, across the UK clock changes ----
  {
    const { ctx, p } = await extraPage({ timezoneId: 'Europe/London', locale: 'en-GB' });
    await p.clock.install({ time: new Date(X.clock_cases[0].now_utc) });
    await p.goto(url);
    await p.selectOption('#ng-timer', 'clock');
    const dur = mins => { const h = Math.floor(mins / 60), mm = mins % 60; return (h ? h + ' h' : '') + (h && mm ? ' ' : '') + (mm ? mm + ' min' : ''); };
    for (const c of X.clock_cases) {
      await p.clock.setSystemTime(new Date(c.now_utc));
      await p.fill('#ng-at', c.at);
      const want = `Stops at ${c.end_local}${c.tomorrow ? ' tomorrow' : ''} (${dur(c.minutes)} from now) once you press Play.`;
      assert.equal((await p.locator('#ng-tinfo').textContent()).replace(/\s/g, ' '), want, c.label);
    }
    // Play the night of the spring change: 22:10 GMT to 06:30 BST is 7 h 20 min.
    const c0 = X.clock_cases[0];
    await p.clock.setSystemTime(new Date(c0.now_utc));
    await p.fill('#ng-at', c0.at);
    await p.click('#ng-play');
    await p.waitForFunction(() => document.getElementById('ng-live').textContent === 'Playing');
    assert.equal(await p.locator('#ng-tinfo').textContent(), `Stops at 06:30 tomorrow (in ${dur(c0.minutes)}), after fading out over the last 2 minutes.`);
    const f = await p.evaluate(() => window.__calls('fader'));
    const k = f.map(x => x[0]).lastIndexOf('exponentialRampToValueAtTime');
    near(f[k][2] - await p.evaluate(() => window.__tap.ctx.currentTime), c0.minutes * 60, 3, 'fade end on the audio clock (s)');
    // When the time comes, playback stops and the lock screen shows it paused.
    await p.clock.fastForward(c0.minutes * 60000 + 2000);
    await p.waitForFunction(() => document.getElementById('ng-play').textContent === 'Play', null, { timeout: 5000 });
    assert.equal(await p.locator('#ng-tinfo').textContent(), 'Stopped by the sleep timer at 06:30.');
    assert.deepEqual(await p.evaluate(() => [document.getElementById('ng-keep').paused, navigator.mediaSession.playbackState]), [true, 'paused']);
    await ctx.close();
  }

  // ---- Resume after an interruption keeps the sleep timer; a timer chosen meanwhile applies ----
  {
    const { ctx, p } = await extraPage({ timezoneId: 'Europe/London', locale: 'en-GB' });
    await p.clock.install({ time: new Date('2026-06-01T21:00:00Z') }); // 22:00 BST
    await p.goto(url);
    const info = async () => (await p.locator('#ng-tinfo').textContent()).replace(/\s/g, ' ');
    const playingP = () => p.waitForFunction(() => document.getElementById('ng-live').textContent === 'Playing');
    // The device pauses the keep-alive (headphones out, another app), so Resume appears.
    const interruptP = async () => {
      await p.evaluate(() => document.getElementById('ng-keep').pause());
      await p.clock.runFor(1500);
      assert.equal(await p.locator('#ng-play').textContent(), 'Resume');
    };
    const resumeP = async () => { await p.click('#ng-play'); await playingP(); };
    // The last fade booked on the sleep-timer fader: the value it is anchored at,
    // the call after the anchor, and how far ahead (audio clock) it ends.
    const fade = () => p.evaluate(() => {
      const f = window.__calls('fader'), k = f.map(x => x[0]).lastIndexOf('exponentialRampToValueAtTime');
      let j = k;
      while (j >= 0 && f[j][0] !== 'cancelScheduledValues') j--;
      return { anchor: f[j + 1][1], next: [f[j + 2][0], f[j + 2][1]], left: f[k][2] - window.__tap.ctx.currentTime };
    });
    await p.selectOption('#ng-timer', '30');
    await p.click('#ng-play');
    await playingP();
    assert.equal(await info(), 'Stops at 22:30 (in 30 min), after fading out over the last 2 minutes.');
    await p.clock.fastForward(10 * 60000);
    await interruptP();
    await resumeP();
    assert.equal(await info(), 'Stops at 22:30 (in 20 min), after fading out over the last 2 minutes.', 'Resume restarted the sleep timer');
    let f = await fade();
    near(f.left, 20 * 60, 5, 'fade end after Resume (s ahead on the audio clock)');
    // Interrupted inside the last 2 minutes: the fade carries on from where it
    // should be (about 1 minute left of a 2-minute fade from 1 to 1e-4: 0.01).
    await p.clock.fastForward(19 * 60000);
    await interruptP();
    await resumeP();
    f = await fade();
    assert.ok(f.left > 50 && f.left < 62, `fade end after a late Resume: ${f.left.toFixed(1)} s`);
    near(Math.log10(f.anchor), -4 * (1 - f.left / 120), 0.15, 'fade level after a Resume in the last 2 minutes (log10 of the gain)');
    // A timer chosen while the sound is interrupted applies at once, and Off
    // cancels the old one.
    await interruptP();
    await p.selectOption('#ng-timer', '15');
    assert.match(await info(), /^Stops at \d\d:\d\d \(in 15 min\), after fading out/, 'a timer chosen while interrupted');
    await resumeP();
    assert.match(await info(), /\(in 15 min\)/);
    near((await fade()).left, 15 * 60, 5, 'fade end of the timer chosen while interrupted (s)');
    await interruptP();
    await p.selectOption('#ng-timer', '0');
    assert.equal(await info(), '');
    await p.clock.fastForward(16 * 60000);
    assert.equal(await p.locator('#ng-play').textContent(), 'Resume', 'a timer turned off while interrupted still stopped the sound');
    await resumeP();
    assert.equal(await info(), '');
    // A clock time less than 2 minutes away fades out over the time left, from full level.
    await p.selectOption('#ng-timer', 'clock');
    const soon = await p.evaluate(() => { const d = new Date(Date.now() + 90000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); });
    await p.fill('#ng-at', soon);
    f = await fade();
    assert.ok(f.left > 25 && f.left < 95, `fade end for ${soon}: ${f.left.toFixed(1)} s`);
    assert.deepEqual(f.next, ['linearRampToValueAtTime', 1], `a timer ending within 2 minutes starts its fade at full level: ${JSON.stringify(f)}`);
    await p.clock.fastForward(100000);
    await p.waitForFunction(() => document.getElementById('ng-play').textContent === 'Play', null, { timeout: 5000 });
    assert.equal(await info(), `Stopped by the sleep timer at ${soon}.`);
    await ctx.close();
  }
  {
    // A 12-hour clock where the visitor's locale uses one.
    const { ctx, p } = await extraPage({ timezoneId: 'America/New_York', locale: 'en-US' });
    await p.clock.install({ time: new Date('2026-11-21T03:00:00Z') }); // 22:00 EST
    await p.goto(url);
    await p.selectOption('#ng-timer', 'clock');
    await p.fill('#ng-at', '06:30');
    assert.equal((await p.locator('#ng-tinfo').textContent()).replace(/\s/g, ' '), 'Stops at 6:30 AM tomorrow (8 h 30 min from now) once you press Play.');
    await ctx.close();
  }

  // ---- After the sleep timer's fade, the stop stays silent ----
  // A clock time 9 s ahead fades out over the time left, down to silence on
  // the audio clock; the stop that follows must not bring the level back up
  // as it fades out (it swelled to 18 dB below the noise for 0.25 s).
  {
    const { ctx, p } = await extraPage({ timezoneId: 'Europe/London', locale: 'en-GB' });
    await p.clock.install({ time: new Date('2026-06-01T21:59:51Z') }); // 22:59:51 BST
    await p.goto(url);
    await setRangeOn(p, '#ng-vol', 100);
    await p.selectOption('#ng-timer', 'clock');
    await p.fill('#ng-at', '23:00');
    await p.clock.setSystemTime(new Date('2026-06-01T21:59:51Z')); // however long loading took
    await p.click('#ng-play');
    await p.waitForFunction(() => document.getElementById('ng-live').textContent === 'Playing');
    await p.waitForFunction(() => document.getElementById('ng-play').textContent === 'Play', null, { timeout: 20000 });
    assert.equal(await p.locator('#ng-tinfo').textContent(), 'Stopped by the sleep timer at 23:00.');
    // The context is suspended 0.35 s after the stop, so the speakers' last
    // 0.7 s hold the end of the fade and the whole stop.
    await p.waitForFunction(() => window.__log.contexts[0].state === 'suspended', null, { timeout: 5000 });
    const g = await p.evaluate(() => window.__grab());
    let peak = 0;
    for (const b64 of [g.L, g.R]) {
      const b = Buffer.from(b64, 'base64'), x = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
      for (const v of x) peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(dB(peak * peak) < -80, `after the sleep timer's fade the noise came back, peaking at ${dB(peak * peak).toFixed(1)} dBFS`);
    await ctx.close();
  }

  // ---- Without AudioWorklet: 5 s buffers, one at a time, never looped ----
  {
    const { ctx, p } = await extraPage({}, () => {
      delete window.AudioWorkletNode;
      Object.defineProperty(BaseAudioContext.prototype, 'audioWorklet', { get() { return undefined; } });
    });
    await p.goto(url + '#pink');
    await p.click('#ng-play');
    await p.waitForFunction(() => document.getElementById('ng-live').textContent === 'Playing');
    await setRangeOn(p, '#ng-vol', 100);
    await p.waitForTimeout(2300);
    const grab = async n => {
      const blocks = [];
      let g;
      for (let i = 0; i < n; i++) {
        if (i) await p.waitForFunction(t => window.__tap.ctx.currentTime >= t + 0.75, g.now, { timeout: 10000 });
        g = await p.evaluate(() => window.__grab());
        const fl = b64 => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
        blocks.push([fl(g.L), fl(g.R)]);
      }
      return analyse(blocks, g.sr, X.rates[String(g.sr)].kweight, X.centres);
    };
    let a = await grab(5);
    const Rf = X.rates[String(await p.evaluate(() => window.__tap.ctx.sampleRate))];
    near(slope(X.slope_bands.map(f => a.bands[X.centres.indexOf(f)]), X.slope_bands), -3, 0.4, 'buffers: pink slope');
    near(a.lufs, Rf.colours.pink.lufs, 0.5, 'buffers: pink loudness');
    await p.keyboard.press('3');
    await p.waitForTimeout(1300);
    a = await grab(5);
    near(slope(X.slope_bands.map(f => a.bands[X.centres.indexOf(f)]), X.slope_bands), -6, 0.4, 'buffers: brown slope after a change');
    near(a.lufs, Rf.colours.brown.lufs, 0.5, 'buffers: brown loudness');
    const fb = await p.evaluate(() => ({ worklets: window.__log.worklets, lengths: window.__log.buffers.filter(s => s > 1), loops: window.__log.sources.filter(s => s.loop).length, sources: window.__log.sources.length }));
    assert.equal(fb.worklets, 0);
    assert.equal(fb.loops, 0, 'a buffer was looped');
    assert.ok(fb.lengths.every(s => Math.abs(s - 5) < 0.01), `buffer lengths: ${fb.lengths}`);
    assert.ok(fb.sources >= 4 && fb.sources <= 10, `buffers made so far: ${fb.sources} (queue of up to 12 s, plus the change)`);
    await p.click('#ng-play');
    await p.waitForFunction(() => window.__log.contexts[0].state === 'suspended', null, { timeout: 3000 });
    await ctx.close();
  }

  // ---- A phone with a touch screen ----
  {
    const { ctx, p } = await extraPage({ ...devices['Pixel 7'] });
    await p.goto(url);
    // Play is on the first screen, without scrolling.
    const playBottom = await p.evaluate(() => document.getElementById('ng-play').getBoundingClientRect().bottom);
    assert.ok(playBottom <= await p.evaluate(() => innerHeight), `Play ends ${playBottom} px down, below the first screen`);
    await p.tap('label.ng-col:has(input[value="brown"])');
    assert.equal(await p.isChecked('input[value="brown"]'), true);
    await p.tap('#ng-play');
    await p.waitForFunction(() => document.getElementById('ng-live').textContent === 'Playing');
    const sizes = await p.evaluate(() => [...document.querySelectorAll('.ng-col, #ng-play, #ng-night, #ng-link, #ng-tone, #ng-vol, #ng-timer')].map(e => [e.id || e.className, Math.round(e.getBoundingClientRect().height)]));
    for (const [what, h] of sizes) assert.ok(h >= 44, `${what} is ${h} px tall on a phone`);
    assert.equal(await p.isVisible('.ng-keys'), false, 'no keyboard help on a touch screen');
    await p.tap('#ng-night');
    await p.tap('#ng-wake');
    await p.tap('#ng-wake');
    assert.equal(await p.evaluate(() => document.getElementById('ng-nightdlg').open), false);
    await p.tap('#ng-play');
    assert.equal(await p.locator('#ng-play').textContent(), 'Play');
    // Text in selects and buttons fits at common phone widths.
    await p.selectOption('#ng-timer', '90');
    for (const w of [320, 340, 375, 412, 480, 540]) {
      await p.setViewportSize({ width: w, height: 800 });
      const cut = await p.evaluate(() => {
        // A select clips its text without scrolling, so its chosen option is measured.
        const g = document.createElement('canvas').getContext('2d');
        const sel = [...document.querySelectorAll('.ng select')].filter(e => e.getClientRects().length).filter(e => {
          const cs = getComputedStyle(e);
          g.font = cs.font;
          return g.measureText(e.options[e.selectedIndex].text).width > e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
        });
        const rest = [...document.querySelectorAll('.ng button, .ng-col')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1);
        return sel.concat(rest).map(e => e.id || e.textContent.trim());
      });
      assert.deepEqual(cut, [], `text cut off at ${w} px`);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `sideways scroll at ${w} px`);
    }
    await ctx.close();
  }
  // ---- A browser without Web Audio, and one that will not start it ----
  {
    const { ctx, p } = await extraPage({}, () => { delete window.AudioContext; delete window.webkitAudioContext; });
    await p.goto(url);
    await p.click('#ng-play');
    assert.equal(await p.locator('#ng-msg').textContent(), 'This browser cannot play sound: it has no Web Audio support.');
    assert.equal(await p.locator('#ng-play').textContent(), 'Play');
    assert.equal(await p.evaluate(() => document.getElementById('ng-keep').paused), true);
    await ctx.close();
  }
  {
    const { ctx, p } = await extraPage({}, () => {
      const AC = window.AudioContext;
      window.AudioContext = class extends AC {
        constructor(o) { super(o); this.suspend(); }
        resume() { return Promise.reject(new DOMException('Not allowed by the test', 'NotAllowedError')); }
      };
    });
    await p.goto(url);
    await p.click('#ng-play');
    await p.waitForFunction(() => document.getElementById('ng-play').textContent === 'Resume', null, { timeout: 5000 });
    assert.equal(await p.locator('#ng-msg').textContent(), 'The browser did not start the sound. Press Resume to try again.');
    assert.deepEqual(await p.evaluate(() => [document.getElementById('ng-keep').paused, window.__log.session.slice(-1)[0]]), [true, 'auto'], 'nothing holds the phone\'s audio while nothing plays');
    await p.click('#ng-play');
    await p.waitForTimeout(300);
    assert.equal(await p.locator('#ng-play').textContent(), 'Resume', 'a refused Resume leaves Resume on screen');
    await ctx.close();
  }
  assert.deepEqual(extraProblems, [], extraProblems.join(' | '));

  // The homepage search finds the page by the words people search for.
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/noise-generator\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the noise generator');
  for (const q of ['white noise', 'brown noise', 'pink noise', 'green noise', 'sleep', 'babies', 'noise generator', 'violet']) {
    assert.ok(q.split(' ').every(w => hay.includes(w)), `the homepage search finds nothing for "${q}"`);
  }

  // ---- What the page says about itself ----
  const faq = await page.$$eval('.faq details', ds => ds.map(d => ({ q: d.querySelector('summary').textContent.trim(), a: d.querySelector('.faq-answer').textContent.trim() })));
  assert.equal(faq.length, 5);
  assert.match(faq[0].a, /rated it very low\. In a 2026 laboratory study of 25 adults, pink noise at 50 dBA cut REM sleep by about 19 minutes/);
  assert.match(faq[4].q, /uploaded/);
  for (const f of faq) assert.match(f.a, /[.)]$/, `FAQ answer cut short: ${f.q}`);
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.ok(['/speaker-test/', '/sleep-calculator/', '/tone-generator/'].every(l => links.includes(l)), `links: ${links}`);
  for (const href of links) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), `${href} is linked but is not a tool page`);
  }
  // The guide's colour table lists every colour the tool plays.
  const rows = await page.$$eval('.prose table tr td:first-child', tds => tds.map(t => t.textContent.trim()));
  for (const c of ['White', 'Pink', 'Brown', 'Green', 'Grey', 'Blue', 'Violet']) assert.ok(rows.includes(c), `guide table row for ${c}`);
};

async function setRangeOn(p, sel, v) {
  await p.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
}
