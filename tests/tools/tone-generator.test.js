const fs = require('fs');
const { execFileSync } = require('child_process');

// Known answers (python3): slider position = round(10000 * ln(f) / ln(22000)):
// 440 Hz -> 6088, 1000 Hz -> 6909; position 5000 -> 22000 ** 0.5 = 148.32 Hz.
// 1000 Hz is B5 +21.3 cents; 882.2 Hz / 2 ** (1/12) = 832.686 Hz; 343 / 440 = 0.7795 m.
// A sine at amplitude 0.2 has RMS 0.1414 (0.5: 0.3536). 5 s of 16-bit mono at
// 44.1 kHz is 441,000 data bytes (441,044 with the header).
// Fourier series: square harmonics 1, 1/3, 1/5 (odd only); sawtooth 1, 1/2, 1/3;
// triangle 1, 1/9, 1/25 (odd only).

// Walks the RIFF chunks instead of assuming fixed offsets.
function parseWav(buf) {
  const s = (o, n) => buf.toString('latin1', o, o + n);
  if (s(0, 4) !== 'RIFF' || s(8, 4) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  const riffSize = buf.readUInt32LE(4);
  const out = { riffSize, chunks: [] };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = s(o, 4), size = buf.readUInt32LE(o + 4);
    out.chunks.push(id);
    if (id === 'fmt ') {
      out.fmtSize = size;
      out.format = buf.readUInt16LE(o + 8);
      out.channels = buf.readUInt16LE(o + 10);
      out.rate = buf.readUInt32LE(o + 12);
      out.byteRate = buf.readUInt32LE(o + 16);
      out.align = buf.readUInt16LE(o + 20);
      out.bits = buf.readUInt16LE(o + 22);
      if (size >= 18) out.cbSize = buf.readUInt16LE(o + 24);
    } else if (id === 'fact') out.factFrames = buf.readUInt32LE(o + 8);
    else if (id === 'data') { out.dataOffset = o + 8; out.dataSize = size; }
    o += 8 + size + (size % 2);
  }
  out.end = o;
  const bps = out.bits / 8, frames = out.dataSize / (bps * out.channels);
  out.frames = frames;
  out.ch = Array.from({ length: out.channels }, () => new Float64Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < out.channels; c++) {
      const p = out.dataOffset + (i * out.channels + c) * bps;
      let v;
      if (out.format === 3) v = buf.readFloatLE(p);
      else if (bps === 2) v = buf.readInt16LE(p) / 32768;
      else v = buf.readIntLE(p, 3) / 8388608;
      out.ch[c][i] = v;
    }
  }
  return out;
}
// Single-bin DFT magnitude (amplitude of the component at f Hz).
function amp(x, f, rate) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) { const a = 2 * Math.PI * f * i / rate; re += x[i] * Math.cos(a); im -= x[i] * Math.sin(a); }
  return 2 * Math.hypot(re, im) / x.length;
}
function crossings(x, from = 0, to = x.length) {
  const t = [];
  for (let i = Math.max(1, from); i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) t.push(i - 1 + x[i - 1] / (x[i - 1] - x[i])); // rising, interpolated
  }
  return t;
}
// Frequency around time t (s) from the rising zero crossings in a window.
function freqAt(x, rate, t, win = 0.02) {
  const c = crossings(x, Math.round((t - win) * rate), Math.round((t + win) * rate));
  return (c.length - 1) / ((c[c.length - 1] - c[0]) / rate);
}
const peak = x => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

module.exports = async ({ page, open, assert }) => {
  await page.addInitScript(() => {
    window.__oscs = [];
    const create = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () { const o = create.call(this); window.__oscs.push(o); return o; };
    // Every connection to the speakers is also fed to a stereo splitter with
    // an analyser per channel, up-mixed the way the destination would.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      const r = connect.call(this, dest, ...rest);
      if (dest instanceof AudioDestinationNode) {
        const ctx = this.context;
        if (!ctx.__tap) {
          const up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
          const sp = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
          const L = new AnalyserNode(ctx, { fftSize: 8192 }), R = new AnalyserNode(ctx, { fftSize: 8192 });
          connect.call(up, sp); connect.call(sp, L, 0); connect.call(sp, R, 1);
          ctx.__tap = { up, L, R, rate: ctx.sampleRate };
          window.__tap = ctx.__tap;
        }
        connect.call(this, ctx.__tap.up);
      }
      return r;
    };
    window.__levels = () => {
      const t = window.__tap, a = new Float32Array(8192), b = new Float32Array(8192);
      t.L.getFloatTimeDomainData(a); t.R.getFloatTimeDomainData(b);
      const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
      let zc = 0;
      for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) zc++;
      return { L: rms(a), R: rms(b), fL: zc / (a.length / t.rate) };
    };
  });
  await open();

  const text = s => page.locator(s).textContent();
  const val = s => page.inputValue(s);
  const lastOsc = () => page.evaluate(() => { const o = window.__oscs[window.__oscs.length - 1]; return { type: o.type, f: o.frequency.value }; });
  const levels = () => page.evaluate(() => window.__levels());
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const waitText = (sel, re) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source]);
  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#tg-dl')]);
    return { name: dl.suggestedFilename(), path: await dl.path(), buf: fs.readFileSync(await dl.path()) };
  };

  // ---- Defaults ----
  assert.equal(await val('#tg-freq'), '440');
  assert.equal(await val('#tg-slider'), '6088');
  assert.equal(await text('#tg-big'), '440 Hz');
  assert.equal(await text('#tg-sub'), 'A4, in tune (0 cents)');
  assert.equal(await text('#tg-note'), 'A4');
  assert.equal(await text('#tg-period'), '2.273 ms');
  assert.equal(await text('#tg-wl'), '78.0 cm');
  assert.equal(await text('#tg-vol-out'), '20% (−14.0 dBFS)');
  assert.equal(await text('#tg-vol-warn'), '');
  assert.equal(await text('#tg-size'), '5 s, mono, 441,044 bytes (431 KB).');
  assert.equal(await page.getAttribute('#tg-play', 'aria-pressed'), 'false');
  assert.equal(await page.isVisible('#tg-sweep'), false);

  // ---- Frequency input, log slider, steps ----
  await page.fill('#tg-freq', '1000');
  assert.equal(await val('#tg-slider'), '6909');
  assert.equal(await text('#tg-sub'), 'B5, +21 cents');
  assert.equal(await text('#tg-note'), 'B5 +21¢');
  assert.equal(await page.getAttribute('#tg-slider', 'aria-valuetext'), '1,000 Hz');
  await page.$eval('#tg-slider', s => { s.value = '5000'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await val('#tg-freq'), '148.3');
  assert.equal(await text('#tg-big'), '148.3 Hz');
  await page.$eval('#tg-slider', s => { s.value = '10000'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await val('#tg-freq'), '22000');
  assert.equal(await text('#tg-wl'), '15.6 mm');
  assert.equal(await text('#tg-period'), '45.45 µs');
  await page.$eval('#tg-slider', s => { s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await val('#tg-freq'), '1');
  assert.equal(await text('#tg-sub'), 'Below the lowest musical note (C0, 16.35 Hz)');
  assert.equal(await text('#tg-period'), '1.000 s');
  assert.equal(await text('#tg-wl'), '343 m');

  // Out of range: a polite note after a pause, and the last valid frequency is kept.
  await page.fill('#tg-freq', '148.3');
  await page.fill('#tg-freq', '0');
  await page.waitForFunction(() => /1 to 22,000 Hz\. The tone stays at 148\.3 Hz/.test(document.getElementById('tg-freq-msg').textContent));
  assert.equal(await page.getAttribute('#tg-freq-msg', 'role'), null);
  await page.fill('#tg-freq', '30000');
  assert.equal(await text('#tg-big'), '148.3 Hz');
  await page.fill('#tg-freq', '440');
  assert.equal(await text('#tg-freq-msg'), '');

  await page.click('#tg-plus');
  assert.equal(await val('#tg-freq'), '441');
  await page.selectOption('#tg-step', '0.1');
  assert.equal(await text('#tg-plus'), '+0.1 Hz');
  await page.click('#tg-plus');
  assert.equal(await val('#tg-freq'), '441.1');
  await page.click('[data-step="oct+"]');
  assert.equal(await val('#tg-freq'), '882.2');
  await page.click('[data-step="semi-"]');
  assert.equal(await val('#tg-freq'), '832.69');
  await page.click('[data-step="oct-"]');
  assert.equal(await val('#tg-freq'), '416.35');

  // ---- Keyboard shortcuts ----
  await page.click('.tg-presets [data-f="440"]');
  assert.equal(await val('#tg-freq'), '440');
  await page.keyboard.press('ArrowUp');
  assert.equal(await val('#tg-freq'), '440.1');
  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await val('#tg-freq'), '220.05');
  await page.keyboard.press('2');
  assert.equal(await page.isChecked('input[name="tg-wave"][value="square"]'), true);
  await page.keyboard.press('l');
  assert.equal(await page.isChecked('input[name="tg-ch"][value="left"]'), true);
  await page.keyboard.press('b');
  assert.equal(await page.isChecked('input[name="tg-ch"][value="both"]'), true);
  // Typing in a field is never a shortcut.
  await page.focus('#tg-dur');
  await page.keyboard.press('3');
  assert.match(await val('#tg-dur'), /3/);
  await page.fill('#tg-dur', '5');
  assert.equal(await page.isChecked('input[name="tg-wave"][value="square"]'), true);
  // Space with nothing focused plays and stops.
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('tg-play').getAttribute('aria-pressed') === 'true');
  const o1 = await lastOsc();
  assert.equal(o1.type, 'square');
  near(o1.f, 220.05, 0.001, 'oscillator frequency (float32)');
  assert.equal(await page.isVisible('#tg-live'), true);
  await page.keyboard.press('Space');
  assert.equal(await page.getAttribute('#tg-play', 'aria-pressed'), 'false');
  assert.equal(await page.isVisible('#tg-live'), false);
  // Scrolled away from the tool, arrow keys scroll the page again.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.keyboard.press('ArrowUp');
  assert.equal(await val('#tg-freq'), '220.05');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  // ---- Live output: channel routing, volume, retuning ----
  await page.keyboard.press('1');
  await page.fill('#tg-freq', '1000');
  await page.click('#tg-play');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tg-play');
  await page.waitForTimeout(400);
  let lv = await levels();
  near(lv.L, 0.1414, 0.012, 'left RMS, both channels');
  near(lv.R, 0.1414, 0.012, 'right RMS, both channels');
  near(lv.fL, 1000, 20, 'measured frequency');
  await page.check('input[name="tg-ch"][value="left"]');
  await page.waitForTimeout(300);
  lv = await levels();
  near(lv.L, 0.1414, 0.012, 'left RMS, left only');
  assert.ok(lv.R < 0.002, `right channel should be silent, RMS ${lv.R}`);
  await page.check('input[name="tg-ch"][value="right"]');
  await page.waitForTimeout(300);
  lv = await levels();
  assert.ok(lv.L < 0.002, `left channel should be silent, RMS ${lv.L}`);
  near(lv.R, 0.1414, 0.012, 'right RMS, right only');
  await page.check('input[name="tg-ch"][value="both"]');
  await page.$eval('#tg-vol', s => { s.value = '50'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#tg-vol-out'), '50% (−6.0 dBFS)');
  assert.equal(await text('#tg-vol-warn'), '');
  await page.waitForTimeout(300);
  lv = await levels();
  near(lv.L, 0.3536, 0.02, 'RMS at 50%');
  await page.$eval('#tg-vol', s => { s.value = '60'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await text('#tg-vol-warn'), /^Careful: that is loud/);
  await page.$eval('#tg-vol', s => { s.value = '20'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#tg-vol-warn'), '');
  await page.fill('#tg-freq', '2000');
  await page.waitForTimeout(400);
  near((await lastOsc()).f, 2000, 0.5, 'retuned oscillator');
  near((await levels()).fL, 2000, 30, 'measured frequency after retuning');
  await page.click('#tg-play');
  await page.waitForTimeout(300);
  lv = await levels();
  assert.ok(lv.L < 0.001 && lv.R < 0.001, `silent after stop: ${JSON.stringify(lv)}`);

  // ---- Default WAV: 440 Hz sine, mono, 16-bit, 44.1 kHz, 5 s ----
  await page.fill('#tg-freq', '440');
  let dl = await download();
  assert.equal(dl.name, 'tone-440hz-sine-5s.wav');
  let w = parseWav(dl.buf);
  assert.deepEqual(w.chunks, ['fmt ', 'data']);
  assert.deepEqual([w.format, w.channels, w.rate, w.byteRate, w.align, w.bits, w.fmtSize], [1, 1, 44100, 88200, 2, 16, 16]);
  assert.equal(w.dataSize, 441000);
  assert.equal(dl.buf.length, 441044);
  assert.equal(w.riffSize, dl.buf.length - 8);
  assert.equal(w.end, dl.buf.length);
  assert.equal(crossings(w.ch[0]).length, 2200);
  near(freqAt(w.ch[0], 44100, 2.5, 2), 440, 0.01, 'WAV frequency');
  near(peak(w.ch[0]), 0.2, 0.001, 'WAV peak');
  assert.equal(w.ch[0][0], 0);
  assert.ok(Math.abs(w.ch[0][w.frames - 1]) < 0.001, 'faded out');
  // A standard reader accepts it (python3's wave module), when python3 is available.
  let py = null;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); py = 'python3'; } catch (e) { /* no python */ }
  if (py) {
    const info = execFileSync(py, ['-c', 'import sys,wave;w=wave.open(sys.argv[1]);print(w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes())', dl.path]).toString().trim();
    assert.equal(info, '1 2 44100 220500');
  }

  // Without the fade the first sample is still 0 (sine phase) and the last is not faded.
  await page.uncheck('#tg-fade');
  await page.fill('#tg-dur', '0.5');
  w = parseWav((await download()).buf);
  near(Math.abs(w.ch[0][w.frames - 1]), Math.abs(0.2 * Math.sin(2 * Math.PI * 440 * (w.frames - 1) / 44100)), 1e-4, 'unfaded last sample');
  await page.check('#tg-fade');
  // Fixed peak levels, independent of the volume slider: 0 dBFS, and -18 dBFS = 10 ** (-18 / 20) = 0.12589.
  await page.selectOption('#tg-level', '0');
  w = parseWav((await download()).buf);
  near(peak(w.ch[0]), 1, 0.001, '0 dBFS peak');
  await page.selectOption('#tg-level', '-18');
  w = parseWav((await download()).buf);
  near(peak(w.ch[0]), 0.12589, 0.0002, '-18 dBFS peak');
  await page.selectOption('#tg-level', 'vol');

  // ---- 24-bit, left only, 1 kHz square at 48 kHz: odd harmonics only, no aliasing ----
  await page.check('input[name="tg-wave"][value="square"]');
  await page.check('input[name="tg-ch"][value="left"]');
  await page.fill('#tg-freq', '1000');
  await page.selectOption('#tg-rate', '48000');
  await page.selectOption('#tg-bits', '24');
  await page.fill('#tg-dur', '1');
  dl = await download();
  assert.equal(dl.name, 'tone-1000hz-square-left-1s.wav');
  w = parseWav(dl.buf);
  assert.deepEqual([w.format, w.channels, w.rate, w.byteRate, w.align, w.bits], [1, 2, 48000, 288000, 6, 24]);
  assert.equal(w.frames, 48000);
  assert.equal(peak(w.ch[1]), 0, 'right channel silent');
  let x = w.ch[0].subarray(4800, 43200); // 0.8 s, away from the fades
  let h = [1, 2, 3, 5, 7].map(k => amp(x, 1000 * k, 48000));
  near(h[2] / h[0], 1 / 3, 0.003, 'square h3/h1');
  near(h[3] / h[0], 1 / 5, 0.003, 'square h5/h1');
  assert.ok(h[1] / h[0] < 1e-3, `square even harmonic ${h[1] / h[0]}`);
  near(peak(w.ch[0]), 0.2, 0.002, 'square peak (peak-normalised)');
  // Aliasing: energy outside the 23 harmonics below 24 kHz is tiny.
  let total = x.reduce((s, v) => s + v * v, 0) / x.length, harm = 0;
  for (let k = 1; k * 1000 < 24000; k++) harm += amp(x, 1000 * k, 48000) ** 2 / 2;
  assert.ok(10 * Math.log10(Math.max(1e-20, total - harm) / harm) < -60, `aliasing ${10 * Math.log10((total - harm) / harm)} dB`);

  // ---- 32-bit float, right only, 3 kHz sawtooth at 96 kHz ----
  await page.check('input[name="tg-wave"][value="sawtooth"]');
  await page.check('input[name="tg-ch"][value="right"]');
  await page.fill('#tg-freq', '3000');
  await page.selectOption('#tg-rate', '96000');
  await page.selectOption('#tg-bits', '32');
  await page.fill('#tg-dur', '0.25');
  dl = await download();
  w = parseWav(dl.buf);
  assert.deepEqual(w.chunks, ['fmt ', 'fact', 'data']);
  assert.deepEqual([w.format, w.channels, w.rate, w.byteRate, w.align, w.bits, w.fmtSize, w.cbSize, w.factFrames], [3, 2, 96000, 768000, 8, 32, 18, 0, 24000]);
  assert.equal(dl.buf.length, 58 + 24000 * 8);
  assert.equal(peak(w.ch[0]), 0, 'left channel silent');
  x = w.ch[1].subarray(2400, 21600);
  h = [1, 2, 3].map(k => amp(x, 3000 * k, 96000));
  near(h[1] / h[0], 1 / 2, 0.005, 'sawtooth h2/h1');
  near(h[2] / h[0], 1 / 3, 0.005, 'sawtooth h3/h1');

  // ---- Triangle, mono 16-bit, and a 24-bit file with an odd data size (pad byte) ----
  await page.check('input[name="tg-wave"][value="triangle"]');
  await page.check('input[name="tg-ch"][value="both"]');
  await page.fill('#tg-freq', '500');
  await page.selectOption('#tg-rate', '44100');
  await page.selectOption('#tg-bits', '16');
  await page.fill('#tg-dur', '1');
  w = parseWav((await download()).buf);
  x = w.ch[0].subarray(4410, 39690);
  h = [1, 2, 3, 5].map(k => amp(x, 500 * k, 44100));
  near(h[2] / h[0], 1 / 9, 0.002, 'triangle h3/h1');
  near(h[3] / h[0], 1 / 25, 0.002, 'triangle h5/h1');
  assert.ok(h[1] / h[0] < 1e-3, 'triangle even harmonic');

  await page.selectOption('#tg-bits', '24');
  await page.fill('#tg-dur', '0.10002'); // round(0.10002 * 44100) = 4411 frames
  dl = await download();
  w = parseWav(dl.buf);
  assert.equal(w.frames, 4411);
  assert.equal(w.dataSize, 13233);
  assert.equal(dl.buf.length, 44 + 13233 + 1);
  assert.equal(w.riffSize, dl.buf.length - 8);
  assert.equal(w.end, dl.buf.length);
  if (py) {
    const info = execFileSync(py, ['-c', 'import sys,wave;w=wave.open(sys.argv[1]);print(w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes())', dl.path]).toString().trim();
    assert.equal(info, '1 3 44100 4411');
  }
  await page.selectOption('#tg-bits', '16');

  // Bad length.
  await page.fill('#tg-dur', '0');
  await page.click('#tg-dl');
  assert.equal(await text('#tg-dl-msg'), 'Enter a length from 0.1 to 300 seconds.');
  await page.fill('#tg-dur', '5');

  // ---- Sweep ----
  await page.check('input[name="tg-mode"][value="sweep"]');
  assert.equal(await page.isVisible('#tg-steady'), false);
  assert.equal(await page.isVisible('#tg-sweep'), true);
  assert.equal(await page.isVisible('#tg-dur-field'), false);
  assert.equal(await text('#tg-big'), '20 → 20,000 Hz');
  assert.equal(await text('#tg-sub'), 'Logarithmic sweep over 10 s');
  await page.check('input[name="tg-wave"][value="sine"]');
  await page.fill('#tg-f1', '100');
  await page.fill('#tg-f2', '1000');
  await page.fill('#tg-sdur', '1');
  assert.equal(await text('#tg-size'), '1 s, mono, 88,244 bytes (86 KB).');
  // Plays once, shows the live frequency, and stops by itself.
  await page.click('#tg-play');
  await page.waitForFunction(() => { const f = parseFloat(document.getElementById('tg-big').textContent.replace(/,/g, '')); return f > 100 && f < 1000; }, null, { timeout: 3000 });
  assert.match(await text('#tg-sub'), /^Sweeping 100 Hz → 1,000 Hz, logarithmic$/);
  await page.waitForFunction(() => document.getElementById('tg-play').getAttribute('aria-pressed') === 'false', null, { timeout: 4000 });
  assert.equal(await text('#tg-big'), '100 → 1,000 Hz');

  dl = await download();
  assert.equal(dl.name, 'sweep-100hz-1000hz-log-1s.wav');
  w = parseWav(dl.buf);
  for (const t of [0.25, 0.5, 0.75]) near(freqAt(w.ch[0], 44100, t), 100 * 10 ** t, 100 * 10 ** t * 0.01, `log sweep at ${t} s`);
  await page.selectOption('#tg-scale', 'lin');
  w = parseWav((await download()).buf);
  for (const t of [0.25, 0.5, 0.75]) near(freqAt(w.ch[0], 44100, t), 100 + 900 * t, (100 + 900 * t) * 0.01, `linear sweep at ${t} s`);
  await page.selectOption('#tg-scale', 'log');
  await page.selectOption('#tg-repeat', 'updown');
  dl = await download();
  assert.equal(dl.name, 'sweep-100hz-1000hz-log-updown-2s.wav');
  w = parseWav(dl.buf);
  assert.equal(w.frames, 88200);
  near(freqAt(w.ch[0], 44100, 1.5), 316.23, 3.2, 'down leg at 1.5 s');
  near(freqAt(w.ch[0], 44100, 1.0, 0.01), 1000, 15, 'top of the sweep');
  // A repeating sweep keeps playing past its sweep time.
  await page.click('#tg-play');
  await page.waitForTimeout(1500);
  assert.equal(await page.getAttribute('#tg-play', 'aria-pressed'), 'true');
  // While a sweep plays, the stats follow the live frequency.
  assert.notEqual(await text('#tg-period'), '–');
  // Regression: retyping the end frequency used to stop the sweep and leave an
  // assertive error behind. A half-typed value keeps the old sweep playing, the
  // polite note waits for a pause, and a valid value restarts the sweep.
  const oscCount = await page.evaluate(() => window.__oscs.length);
  await page.fill('#tg-f2', '');
  assert.equal(await page.getAttribute('#tg-play', 'aria-pressed'), 'true');
  assert.equal(await text('#tg-error'), '');
  assert.equal(await text('#tg-mode-msg'), '', 'no message on the first keystroke');
  await waitText('#tg-mode-msg', /^Sweep frequencies must be from 1 to 22,000 Hz\.$/);
  await page.type('#tg-f2', '2000');
  assert.equal(await text('#tg-mode-msg'), '');
  assert.equal(await page.getAttribute('#tg-play', 'aria-pressed'), 'true');
  assert.ok(await page.evaluate(n => window.__oscs.length > n, oscCount), 'the sweep restarted with the new range');
  assert.equal(await page.evaluate(() => window.__oscs[window.__oscs.length - 1].frequency.value > 0), true);
  await page.click('#tg-play');
  // Idle sweep: no single frequency to describe.
  assert.deepEqual([await text('#tg-note'), await text('#tg-period'), await text('#tg-wl')], ['–', '–', '–']);
  await page.fill('#tg-f2', '99999');
  await waitText('#tg-mode-msg', /^Sweep frequencies must be from 1 to 22,000 Hz\.$/);
  await page.click('#tg-play');
  assert.equal(await text('#tg-error'), 'Sweep frequencies must be from 1 to 22,000 Hz.');
  assert.equal(await page.getAttribute('#tg-play', 'aria-pressed'), 'false');
  await page.fill('#tg-f2', '1000');
  assert.equal(await text('#tg-mode-msg'), '');
  // The Play error clears once the settings are valid again.
  assert.equal(await text('#tg-error'), '');

  // ---- Binaural beats ----
  await page.check('input[name="tg-mode"][value="binaural"]');
  assert.equal(await page.isVisible('#tg-steady'), true);
  assert.equal(await text('#tg-freq-label'), 'Left-ear frequency (Hz)');
  assert.equal(await page.$eval('#tg-wave-set', f => f.disabled), true);
  await page.fill('#tg-freq', '200');
  assert.equal(await text('#tg-big'), '200 Hz + 210 Hz');
  assert.equal(await text('#tg-sub'), 'Left 200 Hz, right 210 Hz: a 10 Hz binaural beat');
  const n0 = await page.evaluate(() => window.__oscs.length);
  await page.click('#tg-play');
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(n => window.__oscs.slice(n).map(o => [o.type, Math.round(o.frequency.value * 1000) / 1000]), n0), [['sine', 200], ['sine', 210]]);
  lv = await levels();
  near(lv.L, 0.1414, 0.012, 'binaural left RMS');
  near(lv.R, 0.1414, 0.012, 'binaural right RMS');
  await page.click('#tg-play');
  await page.fill('#tg-dur', '2');
  dl = await download();
  assert.equal(dl.name, 'binaural-200hz-beat-10hz-2s.wav');
  w = parseWav(dl.buf);
  assert.equal(w.channels, 2);
  assert.equal(crossings(w.ch[0]).length, 400);
  assert.equal(crossings(w.ch[1]).length, 420);
  await page.fill('#tg-beat', '60');
  await waitText('#tg-mode-msg', /^The beat frequency must be from 0\.1 to 50 Hz\.$/);
  await page.fill('#tg-beat', '10');
  assert.equal(await text('#tg-mode-msg'), '');
  await page.fill('#tg-freq', '1000');
  assert.equal(await text('#tg-mode-msg'), '');
  // The hint matches its own text: above 1,000 Hz (it used to wait until 1,500 Hz).
  await page.fill('#tg-freq', '1200');
  await waitText('#tg-mode-msg', /hard to hear above about 1,000 Hz/);

  // ---- A long file does not freeze the page ----
  await page.check('input[name="tg-mode"][value="tone"]');
  await page.check('input[name="tg-wave"][value="square"]');
  await page.check('input[name="tg-ch"][value="left"]');
  await page.selectOption('#tg-rate', '48000');
  await page.fill('#tg-dur', '60');
  assert.equal(await text('#tg-size'), '60 s, stereo, 11,520,044 bytes (11.0 MB).');
  // Regression: the size did not follow a channel change (mono <-> stereo).
  await page.check('input[name="tg-ch"][value="both"]');
  assert.equal(await text('#tg-size'), '60 s, mono, 5,760,044 bytes (5.5 MB).');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('r');
  assert.equal(await text('#tg-size'), '60 s, stereo, 11,520,044 bytes (11.0 MB).');
  await page.check('input[name="tg-ch"][value="left"]');
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' });
  });
  dl = await download();
  assert.equal(dl.buf.length, 11520044);
  const long = await page.evaluate(() => window.__long);
  assert.ok(long.every(d => d < 200), `long tasks while generating: ${long.join(', ')} ms`);

  // ---- Share link restores the settings but never the volume ----
  await page.fill('#tg-freq', '1234.5');
  await page.click('#tg-link');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /\/tone-generator\/\?mode=tone&f=1234\.5&wave=square&ch=left$/);
  await page.goto(link + '&vol=100');
  assert.equal(await val('#tg-freq'), '1234.5');
  assert.equal(await page.isChecked('input[name="tg-wave"][value="square"]'), true);
  assert.equal(await page.isChecked('input[name="tg-ch"][value="left"]'), true);
  assert.equal(await val('#tg-vol'), '20');
  await page.goto(link.replace(/\?.*/, '?mode=sweep&from=50&to=5000&time=4&scale=lin&play=repeat'));
  assert.equal(await page.isChecked('input[name="tg-mode"][value="sweep"]'), true);
  assert.equal(await text('#tg-big'), '50 → 5,000 Hz');
  assert.equal(await text('#tg-sub'), 'Linear sweep over 4 s, repeating');

  // Hostile or malformed links: values are compared, never put into a CSS
  // selector (a quote used to throw and stop the page from initialising).
  const base = link.replace(/\?.*/, '');
  for (const q of ['?mode=x%22%5D&ch=%22%5D&wave=%22%5D', '?mode=sweep&from=abc&to=1e3&time=0x10', '?f=1e400&beat=Infinity', '?f=-5']) {
    await page.goto(base + q);
    assert.equal(await text('#tg-size') !== '' || q.includes('sweep'), true, `initialised for ${q}`);
    assert.equal(await page.isChecked('input[name="tg-ch"][value="both"]'), true);
  }
  await page.goto(base + '?mode=x%22%5D&ch=%22%5D');
  assert.equal(await text('#tg-big'), '440 Hz');
  assert.equal(await text('#tg-size'), '5 s, mono, 441,044 bytes (431 KB).');
  await page.goto(base + '?mode=sweep&from=abc&to=1e3&time=0x10');
  assert.equal(await val('#tg-f1'), '20', 'invalid start ignored');
  assert.equal(await val('#tg-f2'), '20000', 'exponent notation ignored');
  assert.equal(await val('#tg-sdur'), '10', 'hex ignored');
  assert.equal(await text('#tg-big'), '20 → 20,000 Hz');

  // A failure while building the file (such as running out of memory) is
  // reported and the button recovers, instead of staying on "Generating".
  await page.goto(base);
  await page.fill('#tg-dur', '0.2');
  await page.evaluate(() => { window.__Blob = window.Blob; window.Blob = function () { throw new RangeError('Array buffer allocation failed'); }; });
  await page.click('#tg-dl');
  await waitText('#tg-dl-msg', /^Could not create the WAV file \(Array buffer allocation failed\)\. Try a shorter length/);
  assert.equal(await text('#tg-dl'), 'Download WAV');
  await page.evaluate(() => { window.Blob = window.__Blob; });
  dl = await download();
  assert.equal(parseWav(dl.buf).frames, 8820);
};
