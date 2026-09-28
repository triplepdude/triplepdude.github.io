const fs = require('fs');
const { execFileSync } = require('child_process');

// Every test sound is rendered with an OfflineAudioContext and played as an
// AudioBuffer; the test captures each played buffer and measures per-channel
// energy, L/R correlation and zero-crossing frequency. Known answers (python3):
// a log sweep from 20 Hz to 20 kHz is at 20 * 1000 ** x after fraction x of its
// time: 39.91 Hz at 10%, 632.46 Hz at 50%, 10023.7 Hz at 90%; 20-200 Hz is at
// 63.25 Hz halfway. The centre test sends 1/sqrt(2) = 0.7071 of the signal to
// each channel. The downloadable track is 1 + 3 * 3.05 + 9 + 5 + 5 + 21 = 50.15 s.
module.exports = async ({ page, open, assert, url }) => {
  await page.addInitScript(() => {
    window.__played = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      if (!(this.context instanceof OfflineAudioContext)) window.__played.push(this.buffer);
      return start.apply(this, a);
    };
    const win = (b, from, to) => [Math.max(0, Math.round(from * b.sampleRate)), Math.min(b.length, Math.round(to * b.sampleRate))];
    window.__stats = (from, to, idx = window.__played.length - 1) => {
      const b = window.__played[idx], [i0, i1] = win(b, from, to), rms = [];
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        let s = 0;
        for (let i = i0; i < i1; i++) s += d[i] * d[i];
        rms.push(Math.sqrt(s / (i1 - i0)));
      }
      const L = b.getChannelData(0), R = b.getChannelData(Math.min(1, b.numberOfChannels - 1));
      let lr = 0, ll = 0, rr = 0;
      for (let i = i0; i < i1; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
      return { rms, corr: lr / Math.sqrt(ll * rr || 1), channels: b.numberOfChannels, dur: b.length / b.sampleRate };
    };
    // Frequency from rising zero crossings (interpolated) around time t.
    window.__freq = (c, t, w = 0.05, idx = window.__played.length - 1) => {
      const b = window.__played[idx], d = b.getChannelData(c), [i0, i1] = win(b, t - w, t + w), xs = [];
      for (let i = i0 + 1; i < i1; i++) if (d[i - 1] < 0 && d[i] >= 0) xs.push(i - 1 + d[i - 1] / (d[i - 1] - d[i]));
      return (xs.length - 1) / ((xs[xs.length - 1] - xs[0]) / b.sampleRate);
    };
    // Smoothness: RMS of the sample-to-sample difference over the RMS (small for bass-only sound).
    window.__rough = (c, from, to, idx = window.__played.length - 1) => {
      const b = window.__played[idx], d = b.getChannelData(c), [i0, i1] = win(b, from, to);
      let s = 0, e = 0;
      for (let i = i0 + 1; i < i1; i++) { s += (d[i] - d[i - 1]) ** 2; e += d[i] * d[i]; }
      return Math.sqrt(s / e);
    };
    // Live output tap: what actually reaches the speakers, per channel.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      const r = connect.call(this, dest, ...rest);
      if (dest instanceof AudioDestinationNode && !(this.context instanceof OfflineAudioContext)) {
        const ctx = this.context;
        if (!ctx.__tap) {
          const up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
          const sp = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
          const L = new AnalyserNode(ctx, { fftSize: 4096 }), R = new AnalyserNode(ctx, { fftSize: 4096 });
          connect.call(up, sp); connect.call(sp, L, 0); connect.call(sp, R, 1);
          ctx.__tap = { up, L, R };
          window.__tap = ctx.__tap;
        }
        connect.call(this, ctx.__tap.up);
      }
      return r;
    };
    window.__live = () => {
      const t = window.__tap, a = new Float32Array(4096), b = new Float32Array(4096);
      t.L.getFloatTimeDomainData(a); t.R.getFloatTimeDomainData(b);
      const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
      return [rms(a), rms(b)];
    };
    // Pretend the output is a 5.1 or 7.1 device (?surround=6 or 8).
    const n = +new URLSearchParams(location.search).get('surround');
    if (n) {
      window.__destCount = [];
      Object.defineProperty(AudioDestinationNode.prototype, 'maxChannelCount', { configurable: true, get() { return n; } });
      Object.defineProperty(AudioDestinationNode.prototype, 'channelCount', { configurable: true, get() { return this.__cc || 2; }, set(v) { window.__destCount.push(v); this.__cc = v; } });
    }
  });
  await open();

  const text = s => page.locator(s).textContent();
  const pressed = s => page.getAttribute(s, 'aria-pressed');
  const stats = (a, b) => page.evaluate(([a, b]) => window.__stats(a, b), [a, b]);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  let count = 0;
  const playTest = async (sel, label) => {
    await page.click(sel);
    count++;
    await page.waitForFunction(n => window.__played.length === n, count, { timeout: 8000 }).catch(async e => {
      throw new Error(`expected ${count} played buffers, got ${await page.evaluate(() => window.__played.length)}; now: ${await text('#spk-now')}; error: ${await text('#spk-error')}`);
    });
    await page.waitForFunction(t => document.getElementById('spk-now').textContent === 'Playing ' + t + '.', label);
    assert.equal(await pressed(sel), 'true');
  };

  // ---- Initial state ----
  assert.equal(await text('#spk-now'), 'Nothing playing. Start with your device volume low.');
  assert.equal(await text('#spk-vol-out'), '50%');
  assert.deepEqual(await page.$$eval('#spk-legend tr td:first-child', t => t.map(e => e.textContent)), ['0:01', '0:04', '0:07', '0:10', '0:19', '0:24', '0:29']);
  assert.equal(await page.getAttribute('#spk-mark', 'aria-disabled'), 'true');
  // Marking with no sweep playing adds nothing (Playwright's click() waits for
  // aria-disabled to clear, so the button is activated from the keyboard).
  await page.focus('#spk-mark');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#spk-marks li').count(), 0);
  assert.equal(await page.isVisible('#spk-sur'), false);

  // ---- Left, right, centre ----
  await playTest('[data-test="left"]', 'left channel');
  let s = await stats(0, 3);
  assert.equal(s.channels, 2);
  near(s.dur, 2.11, 0.02, 'left test length');
  assert.ok(s.rms[0] > 0.05, `left RMS ${s.rms[0]}`);
  assert.equal(s.rms[1], 0, 'right channel is silent');
  const leftRms = s.rms[0];
  await page.waitForFunction(() => document.getElementById('spk-icon-l').classList.contains('is-on'));
  assert.equal(await page.$eval('#spk-icon-r', e => e.classList.contains('is-on')), false);
  // What reaches the speakers: left only (the first burst runs 0.01-0.51 s).
  await page.waitForTimeout(250);
  let live = await page.evaluate(() => window.__live());
  assert.ok(live[0] > 0.01 && live[1] === 0, `live output ${live}`);

  await playTest('[data-test="right"]', 'right channel');
  assert.equal(await pressed('[data-test="left"]'), 'false');
  s = await stats(0, 3);
  assert.equal(s.rms[0], 0, 'left channel is silent');
  near(s.rms[1], leftRms, 1e-6, 'right RMS');

  await playTest('[data-test="centre"]', 'centre (both channels)');
  s = await stats(0, 3);
  near(s.rms[0], leftRms * Math.SQRT1_2, 1e-4, 'centre left RMS');
  near(s.rms[1], leftRms * Math.SQRT1_2, 1e-4, 'centre right RMS');
  assert.ok(s.corr > 0.99999, `centre correlation ${s.corr}`);

  // Pressing the playing test again stops it.
  await page.click('[data-test="centre"]');
  assert.equal(await pressed('[data-test="centre"]'), 'false');
  assert.equal(await text('#spk-now'), 'Stopped.');

  // Beeps are 1 kHz; the chime also routes correctly.
  await page.selectOption('#spk-sound', 'beep');
  await playTest('[data-test="left"]', 'left channel');
  near(await page.evaluate(() => window.__freq(0, 0.14, 0.1)), 1000, 1, 'beep frequency');
  assert.equal((await stats(0, 3)).rms[1], 0);
  // Switching the sound while Left plays restarts Left with the chime (523.25 Hz first note).
  await page.selectOption('#spk-sound', 'chime');
  count++;
  await page.waitForFunction(n => window.__played.length === n, count);
  assert.equal(await pressed('[data-test="left"]'), 'true');
  near(await page.evaluate(() => window.__freq(0, 0.12, 0.08)), 523.25, 1, 'chime first note');
  await playTest('[data-test="right"]', 'right channel');
  s = await stats(0, 3);
  assert.ok(s.rms[1] > 0.02 && s.rms[0] === 0, `chime right ${s.rms}`);
  // It finishes by itself.
  await page.waitForFunction(() => document.getElementById('spk-now').textContent === 'Finished: right channel.', null, { timeout: 6000 });
  assert.equal(await pressed('[data-test="right"]'), 'false');
  assert.equal(await page.$eval('#spk-icon-r', e => e.classList.contains('is-on')), false);
  await page.selectOption('#spk-sound', 'noise');

  // Left, then right.
  await playTest('[data-test="alternate"]', 'left, then right');
  s = await stats(0, 2.2);
  assert.ok(s.rms[0] > 0.05 && s.rms[1] === 0, `first half ${s.rms}`);
  s = await stats(2.5, 4.7);
  assert.ok(s.rms[0] === 0 && s.rms[1] > 0.05, `second half ${s.rms}`);

  // ---- Pan sweep: left, right at 4 s, left again; equal power in between ----
  await playTest('[data-test="pan"]', 'pan sweep, left to right and back');
  s = await stats(0.06, 0.4);
  assert.ok(s.rms[1] / s.rms[0] < 0.1, `start ${s.rms}`);
  s = await stats(3.8, 4.2);
  assert.ok(s.rms[0] / s.rms[1] < 0.1, `middle ${s.rms}`);
  for (const t of [2, 6]) {
    s = await stats(t - 0.15, t + 0.15);
    near(s.rms[0] / s.rms[1], 1, 0.12, `balance at ${t} s`);
  }
  s = await stats(7.6, 7.95);
  assert.ok(s.rms[1] / s.rms[0] < 0.1, `end ${s.rms}`);

  // ---- Phase ----
  await playTest('[data-test="inphase"]', 'in phase');
  s = await stats(0.1, 3.9);
  assert.ok(s.corr > 0.99999, `in phase correlation ${s.corr}`);
  await playTest('[data-test="outphase"]', 'out of phase');
  s = await stats(0.1, 3.9);
  assert.ok(s.corr < -0.99999, `out of phase correlation ${s.corr}`);
  near(s.rms[0], s.rms[1], 1e-6, 'equal level in both channels');

  // ---- Frequency sweep ----
  await page.selectOption('#spk-stime', '10');
  await page.selectOption('#spk-sch', 'left');
  await playTest('[data-test="sweep"]', 'frequency sweep');
  assert.equal((await stats(0, 10.1)).rms[1], 0, 'left-only sweep');
  near(await page.evaluate(() => window.__freq(0, 0.01 + 1, 0.1)), 39.91, 0.8, 'sweep at 10%');
  near(await page.evaluate(() => window.__freq(0, 0.01 + 5)), 632.46, 6, 'sweep at 50%');
  near(await page.evaluate(() => window.__freq(0, 0.01 + 9, 0.01)), 10023.7, 150, 'sweep at 90%');
  assert.equal(await page.getAttribute('#spk-mark', 'aria-disabled'), 'false');
  await page.waitForTimeout(800);
  await page.click('#spk-mark');
  const mark = await text('#spk-marks li');
  assert.match(mark, /^\d+ Hz$/);
  assert.ok(+mark.split(' ')[0] >= 20 && +mark.split(' ')[0] < 120, `marked ${mark}`);
  assert.match(await text('#spk-freq'), /^\d+(\.\d+)? k?Hz$/);
  // Regression: the Mark button was disabled when the sweep ended, which threw
  // keyboard focus back to the top of the page. It now keeps focus.
  await page.focus('#spk-mark');
  await page.click('#spk-stop');
  assert.equal(await pressed('[data-test="sweep"]'), 'false');
  assert.equal(await page.getAttribute('#spk-mark', 'aria-disabled'), 'true');
  assert.equal(await text('#spk-now'), 'Stopped.');
  await page.focus('#spk-mark');
  await page.selectOption('#spk-stime', '10');
  await page.evaluate(() => document.querySelector('[data-test="sweep"]').click());
  count++;
  await page.waitForFunction(n => window.__played.length === n, count);
  await page.focus('#spk-mark');
  await page.evaluate(() => document.getElementById('spk-stop').click());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'spk-mark');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#spk-marks li').count(), 0, 'no mark after the sweep stopped');

  await page.selectOption('#spk-range', '20-200');
  await page.selectOption('#spk-sch', 'both');
  await playTest('[data-test="sweep"]', 'frequency sweep');
  assert.equal(await text('#spk-marks'), '', 'marks cleared for a new sweep');
  near(await page.evaluate(() => window.__freq(1, 5.01, 0.1)), 63.25, 0.7, 'bass sweep at 50%');
  s = await stats(0.1, 9.9);
  near(s.rms[0], s.rms[1], 1e-6, 'both channels');
  // Changing the range while the sweep plays restarts it with the new range.
  await page.selectOption('#spk-range', '20000-20');
  count++;
  await page.waitForFunction(n => window.__played.length === n, count);
  assert.equal(await pressed('[data-test="sweep"]'), 'true');
  near(await page.evaluate(() => window.__freq(0, 1.01, 0.01)), 10023.7, 150, 'downward sweep at 10%');
  near(await page.evaluate(() => window.__freq(0, 5.01)), 632.46, 6, 'downward sweep at 50%');
  await page.click('#spk-stop');

  // ---- Volume ----
  await page.$eval('#spk-vol', v => { v.value = '0'; v.dispatchEvent(new Event('input', { bubbles: true })); });
  await playTest('[data-test="left"]', 'left channel');
  await page.waitForTimeout(300);
  live = await page.evaluate(() => window.__live());
  assert.ok(live[0] < 1e-4, `muted output ${live}`);
  await page.$eval('#spk-vol', v => { v.value = '80'; v.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await text('#spk-vol-warn'), /^Careful: high volume/);
  await page.$eval('#spk-vol', v => { v.value = '50'; v.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#spk-vol-warn'), '');
  await page.click('#spk-stop');

  // A stereo output: no surround buttons, and the page says why (set once, not
  // re-written, so the polite live region is not re-announced on every sound).
  assert.match(await text('#spk-sur-note'), /^Your output reports [12] channels?, so there are no surround speakers/);
  const noteMutations = await page.evaluate(async () => {
    let n = 0;
    new MutationObserver(m => { n += m.length; }).observe(document.getElementById('spk-sur-note'), { childList: true, characterData: true, subtree: true });
    document.querySelector('[data-test="right"]').click();
    await new Promise(r => setTimeout(r, 300));
    return n;
  });
  count++;
  assert.equal(noteMutations, 0);
  await page.waitForFunction(n => window.__played.length === n, count);
  await page.click('#spk-stop');
  assert.equal(await page.isVisible('#spk-sur'), false);
  assert.equal(await page.isVisible('#spk-detect-row'), false);

  // ---- Test track download ----
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#spk-dl')]);
  assert.equal(dl.suggestedFilename(), 'speaker-test-track-48khz.wav');
  const buf = fs.readFileSync(await dl.path());
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
  assert.equal(buf.toString('latin1', 8, 16), 'WAVEfmt ');
  assert.deepEqual([buf.readUInt16LE(20), buf.readUInt16LE(22), buf.readUInt32LE(24), buf.readUInt32LE(28), buf.readUInt16LE(32), buf.readUInt16LE(34)], [1, 2, 48000, 192000, 4, 16]);
  assert.equal(buf.toString('latin1', 36, 40), 'data');
  const frames = buf.readUInt32LE(40) / 4;
  assert.equal(frames, Math.round(50.15 * 48000));
  assert.equal(buf.length, 44 + frames * 4);
  assert.equal(buf.readUInt32LE(4), buf.length - 8);
  const L = new Float64Array(frames), R = new Float64Array(frames);
  for (let i = 0; i < frames; i++) { L[i] = buf.readInt16LE(44 + i * 4) / 32768; R[i] = buf.readInt16LE(46 + i * 4) / 32768; }
  const seg = (a, b) => {
    let l = 0, r = 0, lr = 0;
    const i0 = Math.round(a * 48000), i1 = Math.round(b * 48000);
    for (let i = i0; i < i1; i++) { l += L[i] ** 2; r += R[i] ** 2; lr += L[i] * R[i]; }
    return { l: Math.sqrt(l / (i1 - i0)), r: Math.sqrt(r / (i1 - i0)), corr: lr / Math.sqrt(l * r || 1) };
  };
  let g = seg(0, 0.99);
  assert.ok(g.l === 0 && g.r === 0, 'silence before the first test');
  g = seg(1, 3.06);
  assert.ok(g.l > 0.05 && g.r === 0, `track: left ${JSON.stringify(g)}`);
  g = seg(3.1, 4.0);
  assert.ok(g.l === 0 && g.r === 0, 'gap');
  g = seg(4.05, 6.11);
  assert.ok(g.l === 0 && g.r > 0.05, `track: right ${JSON.stringify(g)}`);
  g = seg(7.1, 9.16);
  assert.ok(g.corr > 0.9999 && Math.abs(g.l - g.r) < 1e-4, `track: centre ${JSON.stringify(g)}`);
  g = seg(10.2, 10.5);
  assert.ok(g.r / g.l < 0.1, `track: pan starts left ${JSON.stringify(g)}`);
  g = seg(14.0, 14.3);
  assert.ok(g.l / g.r < 0.1, `track: pan reaches right ${JSON.stringify(g)}`);
  g = seg(19.3, 23.0);
  assert.ok(g.corr > 0.9999, `track: in phase ${JSON.stringify(g)}`);
  g = seg(24.3, 28.0);
  assert.ok(g.corr < -0.9999, `track: out of phase ${JSON.stringify(g)}`);
  const xs = [];
  for (let i = Math.round(39.06 * 48000); i < Math.round(39.26 * 48000); i++) if (L[i - 1] < 0 && L[i] >= 0) xs.push(i - 1 + L[i - 1] / (L[i - 1] - L[i]));
  near((xs.length - 1) / ((xs[xs.length - 1] - xs[0]) / 48000), 632.46, 8, 'track: sweep halfway');
  let py = null;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); py = 'python3'; } catch (e) { /* no python */ }
  if (py) {
    const info = execFileSync(py, ['-c', 'import sys,wave;w=wave.open(sys.argv[1]);print(w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes())', await dl.path()]).toString().trim();
    assert.equal(info, `2 2 48000 ${frames}`);
  }

  // Leaving the page stops the sound.
  await playTest('[data-test="pan"]', 'pan sweep, left to right and back');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await pressed('[data-test="pan"]'), 'false');

  // ---- Surround: a 5.1 output ----
  await page.goto(url + '?surround=6');
  count = 0;
  await page.click('#spk-detect');
  assert.match(await text('#spk-sur-note'), /reports 6 channels\. The buttons follow the standard 5\.1 channel order\./);
  assert.deepEqual(await page.locator('#spk-sur button').allTextContents(),
    ['1 Front left', '2 Front right', '3 Centre', '4 LFE (subwoofer)', '5 Surround left', '6 Surround right']);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '1 Front left');
  const surround = async (i, name) => {
    await page.click(`#spk-sur button[data-ch="${i}"]`);
    count++;
    await page.waitForFunction(n => window.__played.length === n, count);
    await page.waitForFunction(t => document.getElementById('spk-now').textContent === 'Playing ' + t + '.', `${name} (channel ${i + 1} of 6)`);
    const st = await stats(0, 3);
    assert.equal(st.channels, 6);
    st.rms.forEach((v, c) => assert.ok(c === i ? v > 0.01 : v === 0, `channel ${c + 1} RMS ${v} while testing ${name}`));
  };
  await surround(2, 'Centre');
  assert.deepEqual(await page.evaluate(() => window.__destCount), [6]);
  assert.equal(await page.evaluate(() => { const c = window.__tap; return document.querySelector('#spk-sur button[data-ch="2"]').getAttribute('aria-pressed'); }), 'true');
  await surround(4, 'Surround left');
  // The LFE channel carries only bass (low-passed at 120 Hz): very smooth sample to sample.
  await surround(3, 'LFE (subwoofer)');
  const rough = await page.evaluate(() => window.__rough(3, 0.05, 0.5));
  assert.ok(rough < 0.05, `LFE is not bass-only: roughness ${rough}`);
  const roughFull = await page.evaluate(() => window.__rough(4, 0.05, 0.5, window.__played.length - 2));
  assert.ok(roughFull > 0.2, `full-range noise roughness ${roughFull}`);
  // A stereo test afterwards puts the output back to two channels.
  await page.click('[data-test="left"]');
  await page.waitForFunction(() => window.__destCount.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__destCount), [6, 2]);
  await page.click('#spk-stop');

  // ---- 7.1 ----
  await page.goto(url + '?surround=8');
  await page.click('[data-test="centre"]');
  await page.waitForFunction(() => !document.getElementById('spk-sur').hidden, null, { timeout: 5000 }).catch(async () => {
    throw new Error('7.1: ' + JSON.stringify(await page.evaluate(() => [location.href, document.getElementById('spk-sur-note').textContent, document.getElementById('spk-error').textContent, document.getElementById('spk-now').textContent])));
  });
  assert.deepEqual(await page.locator('#spk-sur button').allTextContents(),
    ['1 Front left', '2 Front right', '3 Centre', '4 LFE (subwoofer)', '5 Back left', '6 Back right', '7 Side left', '8 Side right']);
  await page.click('#spk-stop');
};
