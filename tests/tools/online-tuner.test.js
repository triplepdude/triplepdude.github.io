// getUserMedia is stubbed with a silent stream, and where the page brings that
// stream into its audio context (createMediaStreamSource) it gets an
// OscillatorNode made in that same context instead, so the tuner hears exact,
// known frequencies. (A tone from a second context, passed over as a stream, is
// resampled on the way as the two contexts' clocks drift apart; on a busy
// machine that bent its pitch by up to 9 cents for a moment.) Expected values
// were computed in python3 with f = A4 * 2 ** ((midi - 69) / 12) and
// cents = 1200 * log2(f / target):
//   E2 82.4069, A2 110, D3 146.8324, G3 195.9977, E4 329.6276, B0 30.8677,
//   E6 1318.5102, E3 164.8138, B-flat 4 466.1638; with A4 = 442: E2 82.7815.
//   329.63 Hz is E4 +0.01 cents; 440 Hz against A4 = 432 is +31.77 cents;
//   D3 - 20 cents = 145.1459 Hz; A4 + 15 cents = 443.8289 Hz; A4 - 30 cents = 432.4411 Hz.
const fs = require('fs');
const path = require('path');

module.exports = async ({ page, open, assert, base }) => {
  await page.addInitScript(() => {
    window.__gum = [];
    window.__oscs = [];
    // The page's own audio context (not the one that fakes the microphone,
    // marked __gen): its sound sources with when they end, and every suspend
    // with the latest end scheduled before it.
    window.__srcs = new Set();
    window.__sleeps = [];
    const ours = c => !c.__gen;
    const sStart = AudioScheduledSourceNode.prototype.start, sStop = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.start = function () {
      if (ours(this.context)) { window.__ctx = this.context; this.__end = Infinity; window.__srcs.add(this); }
      return sStart.apply(this, arguments);
    };
    AudioScheduledSourceNode.prototype.stop = function (when) {
      this.__end = arguments.length && when > this.context.currentTime ? when : this.context.currentTime;
      return sStop.apply(this, arguments);
    };
    const analyser = BaseAudioContext.prototype.createAnalyser;
    BaseAudioContext.prototype.createAnalyser = function () { if (ours(this)) window.__ctx = this; return analyser.apply(this, arguments); };
    const suspend = AudioContext.prototype.suspend;
    AudioContext.prototype.suspend = function () {
      if (ours(this)) window.__sleeps.push({ at: this.currentTime, lastEnd: Math.max(0, ...[...window.__srcs].map(x => x.__end)) });
      return suspend.apply(this, arguments);
    };
    const create = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () { const o = create.call(this); window.__oscs.push(o); return o; };
    window.__gumFail = null;
    navigator.mediaDevices.getUserMedia = async c => {
      window.__gum.push(JSON.parse(JSON.stringify(c)));
      if (window.__gumFail) throw new DOMException(window.__gumFail[1], window.__gumFail[0]);
      // A real audio track, so that the page stopping it can be checked; it stays silent.
      const ac = new AudioContext();
      ac.__gen = true;
      const stream = ac.createMediaStreamDestination().stream;
      stream.__fake = true;
      return stream;
    };
    const streamSource = AudioContext.prototype.createMediaStreamSource;
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      if (!stream || !stream.__fake) return streamSource.apply(this, arguments);
      const ac = this, out = new GainNode(ac, { gain: 1 });
      const osc = new OscillatorNode(ac, { type: 'sine', frequency: 440 });
      const g = new GainNode(ac, { gain: 0.3 });
      osc.connect(g).connect(out);
      // White noise (fixed seed) that can be mixed in.
      const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = nb.getChannelData(0);
      // xorshift32: a full-period generator. (A 32-bit LCG computed with JS
      // doubles loses precision and repeats after a few thousand samples,
      // which is periodic and not a fair noise test.)
      let seed = 0x9E3779B9;
      for (let i = 0; i < d.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; d[i] = (seed >>> 0) / 2147483648 - 1; }
      const noise = new AudioBufferSourceNode(ac, { buffer: nb, loop: true }), ng = new GainNode(ac, { gain: 0 });
      noise.connect(ng).connect(out);
      // Started past the hook above: these are the microphone, not sounds of the page's own.
      sStart.call(osc);
      sStart.call(noise);
      if (window.__gen) { sStop.call(window.__gen.osc); sStop.call(window.__gen.noise); }
      window.__gen = { ac, osc, g, ng, noise, out, stream };
      return out;
    };
  });
  await open();

  const text = s => page.locator(s).textContent();
  const num = s => text(s).then(t => parseFloat(t.replace('−', '-')));
  const setTone = (f, type = 'sine', gain = 0.3) => page.evaluate(([f, type, gain]) => {
    const g = window.__gen;
    g.osc.type = type;
    g.osc.frequency.value = f;
    g.g.gain.value = gain;
  }, [f, type, gain]);
  // Waits until the display shows the note and the offset is within tol cents.
  const expectNote = async (name, oct, cents, tol = 2, timeout = 6000) => {
    try {
      await page.waitForFunction(([n, o, c, t]) => {
        const off = parseFloat(document.getElementById('otn-off').textContent.replace('−', '-'));
        return document.getElementById('otn-note-name').textContent === n &&
          document.getElementById('otn-note-oct').textContent === String(o) && Math.abs(off - c) <= t;
      }, [name, oct, cents, tol], { timeout });
    } catch (e) {
      const got = await page.evaluate(() => ['otn-note-name', 'otn-note-oct', 'otn-off', 'otn-freq', 'otn-verdict'].map(id => document.getElementById(id).textContent).join(' | '));
      throw new Error(`expected ${name}${oct} ${cents}±${tol} cents, got ${got}`);
    }
    // Stays there (the needle is smoothed, not jittering between readings).
    await page.waitForTimeout(250);
    const off = await num('#otn-off');
    assert.ok(Math.abs(off - cents) <= tol, `${name}${oct}: offset ${off}, expected ${cents}`);
  };
  const freq = async (expected, tolHz) => {
    const f = await num('#otn-freq');
    assert.ok(Math.abs(f - expected) <= tolHz, `frequency ${f}, expected ${expected}`);
  };

  // ---- Initial state: guitar standard tuning ----
  assert.equal(await page.inputValue('#otn-inst'), 'guitar');
  assert.deepEqual(await page.locator('#otn-strings button').allTextContents(), ['Auto', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'].map((s, i) => i ? s + ' ✓' : s));
  assert.deepEqual(await page.$$eval('#otn-strings button', bs => bs.map(b => b.getAttribute('aria-pressed'))), ['true', 'false', 'false', 'false', 'false', 'false', 'false']);
  assert.equal(await page.$$eval('#otn-strings .otn-tick', t => t.filter(e => !e.hidden).length), 0);
  assert.equal(await text('#otn-toggle'), 'Start tuner');
  assert.match(await text('#otn-verdict'), /Press Start tuner/);
  assert.equal(await text('#otn-play'), 'Play E2 (82.41 Hz)');
  assert.equal(await text('#otn-error'), '');

  // ---- Reference tone follows the note and the A4 calibration ----
  await page.click('#otn-play');
  assert.equal(await page.getAttribute('#otn-play', 'aria-pressed'), 'true');
  assert.equal(await text('#otn-play'), 'Stop E2 (82.41 Hz)');
  const refHz = () => page.evaluate(() => window.__oscs[window.__oscs.length - 1].frequency.value);
  assert.ok(Math.abs(await refHz() - 82.4069) < 0.01, `ref ${await refHz()}`);
  await page.click('#otn-a4-up');
  await page.click('#otn-a4-up');
  assert.equal(await page.inputValue('#otn-a4'), '442');
  assert.equal(await text('#otn-play'), 'Stop E2 (82.78 Hz)');
  await page.waitForFunction(() => Math.abs(window.__oscs[window.__oscs.length - 1].frequency.value - 82.7815) < 0.01);
  await page.selectOption('#otn-ref-oct', '5');
  await page.selectOption('#otn-ref-note', '9');
  assert.equal(await text('#otn-play'), 'Stop A5 (884.00 Hz)');
  await page.waitForFunction(() => Math.abs(window.__oscs[window.__oscs.length - 1].frequency.value - 884) < 0.05);
  await page.click('#otn-play');
  assert.equal(await page.getAttribute('#otn-play', 'aria-pressed'), 'false');
  assert.equal(await text('#otn-play'), 'Play A5 (884.00 Hz)');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'otn-play');
  // A running audio context renders silence for as long as the page is
  // open: a moment after the tone stops (after its fade-out) the page
  // suspends it, and the next tone starts it again.
  const asleep = () => page.waitForFunction(() => window.__ctx.state === 'suspended', null, { timeout: 6000 });
  await asleep();
  await page.click('#otn-play');
  await page.waitForFunction(() => window.__ctx.state === 'running' && document.getElementById('otn-play').getAttribute('aria-pressed') === 'true');
  await page.click('#otn-play');
  assert.equal(await text('#otn-play'), 'Play A5 (884.00 Hz)');
  await asleep();
  await page.click('#otn-a4-down');
  await page.click('#otn-a4-down');
  assert.equal(await page.inputValue('#otn-a4'), '440');

  // Out-of-range calibration: a polite message after a pause, and 440 stays in use.
  await page.fill('#otn-a4', '460');
  await page.waitForFunction(() => /430 to 450 Hz\. Still using A4 = 440 Hz/.test(document.getElementById('otn-a4-msg').textContent));
  assert.equal(await page.getAttribute('#otn-a4-msg', 'role'), null);
  // The field points at the message and is marked invalid for as long as it shows.
  assert.equal(await page.getAttribute('#otn-a4', 'aria-describedby'), 'otn-a4-msg');
  assert.equal(await page.getAttribute('#otn-a4', 'aria-invalid'), 'true');
  assert.equal(await text('#otn-play'), 'Play A5 (880.00 Hz)');
  await page.fill('#otn-a4', '440');
  assert.equal(await text('#otn-a4-msg'), '');
  assert.equal(await page.getAttribute('#otn-a4', 'aria-invalid'), null);
  // The typed calibration is used as shown (449.99 used to be rounded to 450):
  // A5 = 2 * 449.99 = 899.98 Hz.
  await page.fill('#otn-a4', '449.99');
  assert.equal(await text('#otn-play'), 'Play A5 (899.98 Hz)');
  await page.fill('#otn-a4', '440');

  // ---- Microphone starts with the speech filters off ----
  await page.focus('#otn-toggle');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__gen && document.getElementById('otn-toggle').textContent === 'Stop tuner');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'otn-toggle');
  assert.deepEqual(await page.evaluate(() => window.__gum[0].audio), { echoCancellation: false, noiseSuppression: false, autoGainControl: false });

  // ---- Chromatic mode: known frequencies ----
  await page.selectOption('#otn-inst', 'chromatic');
  assert.equal(await page.isVisible('#otn-strings-wrap'), false);
  await setTone(110);
  await expectNote('A', 2, 0);
  await freq(110, 0.1);
  assert.equal(await text('#otn-verdict'), 'In tune');
  assert.equal(await page.$eval('#otn-gauge', g => g.classList.contains('is-good')), true);
  await page.waitForFunction(() => document.getElementById('otn-status').textContent === 'A2, in tune', null, { timeout: 4000 });
  assert.match(await text('#otn-level'), /^−(9|1\d)$/); // 0.3 amplitude sine: 20*log10(0.3/sqrt(2)) = -13.5 dBFS
  // Dropouts: a browser that falls behind with the microphone's sound plays
  // silence until it catches up, so 10 ms of silence is inserted into the note.
  // Read through, that pulled A2 up to 13 cents flat for as long as the gap
  // stayed in the 85 ms analysis window; such windows now give no reading.
  // The note comes from a looped one-second buffer here (110 Hz fits it a whole
  // number of times), which can stop and carry on from where it stopped.
  const aroundGaps = await page.evaluate(async () => {
    const { ac, out, g } = window.__gen;
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin(2 * Math.PI * 110 * i / ac.sampleRate);
    let src = new AudioBufferSourceNode(ac, { buffer: buf, loop: true }), at = ac.currentTime + 0.02;
    src.connect(out);
    src.start(at);
    g.gain.setValueAtTime(0, at);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(900); // the switch from the oscillator is itself a jump
    const seen = [];
    for (let k = 0; k < 6; k++) {
      const t = ac.currentTime + 0.03, offset = (t - at) % 1, next = new AudioBufferSourceNode(ac, { buffer: buf, loop: true });
      src.stop(t);
      next.connect(out);
      next.start(t + 0.01, offset);
      src = next; at = t + 0.01 - offset;
      const t0 = performance.now();
      while (performance.now() - t0 < 500) { seen.push(document.getElementById('otn-off').textContent); await wait(20); }
    }
    src.stop();
    g.gain.setValueAtTime(0.3, ac.currentTime);
    return seen;
  });
  assert.ok(aroundGaps.every(o => o === '0'), `offsets shown around six 10 ms dropouts: ${[...new Set(aroundGaps)].join(' ')}`);

  await setTone(329.63);
  await expectNote('E', 4, 0);
  await freq(329.63, 0.1);

  await setTone(443.8289);
  await expectNote('A', 4, 15);
  assert.equal(await text('#otn-verdict'), 'Sharp: tune down');
  const rot = await page.$eval('#otn-needle', g => parseFloat(/rotate\(([-\d.]+)/.exec(g.getAttribute('transform'))[1]));
  assert.ok(Math.abs(rot - 18) < 2.5, `needle at ${rot} degrees for +15 cents`);

  await setTone(432.4411);
  await expectNote('A', 4, -30);
  assert.equal(await text('#otn-verdict'), 'Flat: tune up');

  // Low B of a 5-string bass and a high E6.
  await setTone(30.8677);
  await expectNote('B', 0, 0, 3);
  await setTone(1318.5102);
  await expectNote('E', 6, 0);

  // A sawtooth is full of harmonics: still E2, not an octave up.
  await setTone(82.4069, 'sawtooth');
  await expectNote('E', 2, 0);
  await setTone(82.4069, 'square');
  await expectNote('E', 2, 0);

  // Calibration A4 = 432: a 440 Hz tone is A4 +31.77 cents.
  await page.fill('#otn-a4', '432');
  await setTone(440);
  await expectNote('A', 4, 32, 2);
  await page.fill('#otn-a4', '440');
  await expectNote('A', 4, 0);

  // Note names: flats and solfège.
  await setTone(466.1638);
  await expectNote('A♯', 4, 0);
  await page.selectOption('#otn-names', 'flat');
  await expectNote('B♭', 4, 0);
  await page.selectOption('#otn-names', 'solfege');
  await expectNote('La♯', 4, 0);
  await page.selectOption('#otn-names', 'sharp');

  // ---- Guitar: nearest string, tune up/down, check marks ----
  await page.selectOption('#otn-inst', 'guitar');
  await setTone(145.1459);
  await expectNote('D', 3, -20);
  assert.equal(await text('#otn-verdict'), 'Flat: tune up to D3');
  assert.equal(await page.$eval('#otn-strings button[data-midi="50"]', b => b.classList.contains('otn-cur')), true);
  assert.match(await text('#otn-target-label'), /^Target \(D3\)$/);

  await setTone(195.9977);
  await expectNote('G', 3, 0);
  assert.equal(await text('#otn-verdict'), 'G3 is in tune');
  await page.waitForFunction(() => !document.querySelector('#otn-strings button[data-midi="55"] .otn-tick').hidden, null, { timeout: 4000 });
  assert.equal(await page.getByRole('button', { name: 'G3, tuned', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'D3', exact: true }).count(), 1);
  assert.equal(await page.$eval('#otn-strings button[data-midi="50"] .otn-tick', t => t.hidden), true);

  // The 12th-fret harmonic of the low E (E3) is matched to the E2 string.
  await setTone(164.8138);
  await expectNote('E', 2, 0);
  assert.equal(await text('#otn-heard'), 'Heard E3, one octave above the E2 string.');
  await freq(164.81, 0.1);

  // Locking a string: A2 is the target even while G2 plays; the reference follows.
  await page.click('#otn-strings button[data-midi="45"]');
  assert.equal(await page.getAttribute('#otn-strings button[data-midi="45"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#otn-strings button[data-midi="auto"]', 'aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.midi), '45');
  assert.equal(await text('#otn-play'), 'Play A2 (110.00 Hz)');
  await setTone(97.9989);
  await expectNote('A', 2, -200);
  assert.equal(await text('#otn-heard'), 'Heard G2, 2 semitones below A2.');
  assert.equal(await text('#otn-verdict'), 'Flat: tune up to A2');
  const pegged = await page.$eval('#otn-needle', g => g.getAttribute('transform'));
  assert.equal(pegged, 'rotate(-60.00 160 180)');
  await page.click('#otn-strings button[data-midi="auto"]');
  assert.equal(await page.getAttribute('#otn-strings button[data-midi="45"]', 'aria-pressed'), 'false');

  // Bass (5-string): the low B string.
  await page.selectOption('#otn-inst', 'bass-5');
  assert.deepEqual(await page.$$eval('#otn-strings button > span:first-child', s => s.map(e => e.textContent)), ['Auto', 'B0', 'E1', 'A1', 'D2', 'G2']);
  assert.equal(await text('#otn-play'), 'Play B0 (30.87 Hz)');
  await setTone(30.8677, 'sawtooth');
  await expectNote('B', 0, 0, 3);
  assert.equal(await text('#otn-verdict'), 'B0 is in tune');

  // Ukulele is re-entrant (G4 C4 E4 A4); E-flat tuning is spelled with flats.
  await page.selectOption('#otn-inst', 'ukulele');
  assert.deepEqual(await page.$$eval('#otn-strings button > span:first-child', s => s.map(e => e.textContent)), ['Auto', 'G4', 'C4', 'E4', 'A4']);
  await page.selectOption('#otn-inst', 'guitar-eb');
  assert.deepEqual(await page.$$eval('#otn-strings button > span:first-child', s => s.map(e => e.textContent)), ['Auto', 'E♭2', 'A♭2', 'D♭3', 'G♭3', 'B♭3', 'E♭4']);
  // Solfège in a flat tuning is spelled with flats too (it used to show Re♯ for E-flat).
  await page.selectOption('#otn-names', 'solfege');
  assert.deepEqual(await page.$$eval('#otn-strings button > span:first-child', s => s.map(e => e.textContent)), ['Auto', 'Mi♭2', 'La♭2', 'Re♭3', 'Sol♭3', 'Si♭3', 'Mi♭4']);
  await page.selectOption('#otn-names', 'sharp');
  await page.selectOption('#otn-inst', 'violin');
  assert.deepEqual(await page.$$eval('#otn-strings button > span:first-child', s => s.map(e => e.textContent)), ['Auto', 'G3', 'D4', 'A4', 'E5']);

  // Silence: the reading is held briefly, then the tuner goes back to listening.
  await setTone(440, 'sine', 0);
  await page.waitForFunction(() => /^Listening/.test(document.getElementById('otn-verdict').textContent), null, { timeout: 5000 });
  assert.equal(await text('#otn-note-name'), '–');
  assert.equal(await text('#otn-freq'), '–');

  // Noise alone is not a note; a tone 10 dB above the noise still reads correctly.
  // (sine 0.3 amplitude: RMS 0.212; uniform noise 0.12 amplitude: RMS 0.069.)
  await page.selectOption('#otn-inst', 'chromatic');
  await page.evaluate(() => { window.__gen.ng.gain.value = 0.3; });
  await page.waitForTimeout(2500);
  assert.match(await text('#otn-verdict'), /^Listening/);
  assert.equal(await text('#otn-note-name'), '–');
  await page.evaluate(() => { window.__gen.ng.gain.value = 0.12; });
  await setTone(110, 'sine', 0.3);
  await expectNote('A', 2, 0, 3);
  await page.evaluate(() => { window.__gen.ng.gain.value = 0; });

  // ---- Stop releases the microphone ----
  await page.click('#otn-toggle');
  assert.equal(await text('#otn-toggle'), 'Start tuner');
  assert.equal(await page.evaluate(() => window.__gen.stream.getTracks().every(t => t.readyState === 'ended')), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'otn-toggle');
  assert.match(await text('#otn-verdict'), /Press Start tuner/);
  // With the microphone off and no tone, the audio context is suspended too.
  await asleep();
  const sleeps = await page.evaluate(() => window.__sleeps);
  assert.ok(sleeps.length >= 3, `the sound was switched off ${sleeps.length} times`);
  for (const z of sleeps) assert.ok(z.at >= z.lastEnd, `the sound was switched off at ${z.at.toFixed(3)} s, before a tone ending at ${z.lastEnd} s`);

  // ---- Permission errors ----
  const cases = [
    ['NotAllowedError', 'Permission denied', /^Permission denied/],
    ['NotFoundError', 'Requested device not found', /^No microphone found/],
    ['NotReadableError', 'Could not start audio source', /in use by another app/],
  ];
  for (const [name, message, re] of cases) {
    await page.evaluate(v => { window.__gumFail = v; }, [name, message]);
    await page.click('#otn-toggle');
    await page.waitForFunction(src => new RegExp(src).test(document.getElementById('otn-error').textContent), re.source);
    assert.equal(await text('#otn-toggle'), 'Start tuner');
  }
  await page.evaluate(() => { window.__gumFail = null; });
  await page.click('#otn-toggle');
  await page.waitForFunction(() => document.getElementById('otn-toggle').textContent === 'Stop tuner' && document.getElementById('otn-error').textContent === '');

  // Leaving the page releases the microphone.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.evaluate(() => window.__gen.stream.getTracks().every(t => t.readyState === 'ended')), true);
  assert.equal(await text('#otn-toggle'), 'Start tuner');

  // ---- What the page says about itself ----
  // Every instrument in the menu has a row in the guide's "Standard tunings"
  // table, with the strings and frequencies the tuner itself uses at A4 = 440
  // (read from the reference tone button after choosing each string).
  const ROWS = {
    guitar: 'Guitar', bass: 'Bass, double bass', 'double-bass': 'Bass, double bass', ukulele: 'Ukulele', violin: 'Violin',
    viola: 'Viola', cello: 'Cello', mandolin: 'Mandolin', banjo: 'Banjo, open G',
  };
  const table = await page.$$eval('.prose table', ts => {
    const t = ts.find(x => x.rows[0].cells[0].textContent.trim() === 'Instrument');
    return [...t.rows].slice(1).map(r => [...r.cells].map(c => c.textContent.trim()));
  });
  assert.deepEqual(table.map(r => r[0]).sort(), [...new Set(Object.values(ROWS))].sort());
  await page.fill('#otn-a4', '440');
  await page.selectOption('#otn-names', 'sharp');
  const groups = await page.$$eval('#otn-inst optgroup', gs => gs.map(g => g.label));
  assert.deepEqual(groups, ['Guitar', 'Bass', 'Ukulele', 'Orchestral strings', 'Other'], 'a new instrument group needs a row in the guide table');
  const stringBtns = '#otn-strings button[data-midi]:not([data-midi="auto"])';
  for (const [id, label] of Object.entries(ROWS)) {
    await page.selectOption('#otn-inst', id);
    const strings = [];
    for (let i = 0, n = await page.locator(stringBtns).count(); i < n; i++) {
      await page.locator(stringBtns).nth(i).click();
      const m = (await text('#otn-play')).match(/^Play (\S+) \(([\d.]+) Hz\)$/);
      strings.push(m[1] + ' ' + m[2]);
    }
    const row = table.find(r => r[0] === label);
    assert.equal(row[1].replace(/, in pairs$/, ''), strings.join(', ') + ' Hz', `the ${label} row against the ${id} tuning`);
  }
  // The description names only instruments the menu has.
  const desc = await page.getAttribute('meta[name="description"]', 'content');
  const options = (await page.locator('#otn-inst option').allTextContents()).join(' ').toLowerCase();
  const menu = options + ' ' + groups.join(' ').toLowerCase();
  for (const name of ['guitar', 'bass', 'ukulele', 'violin', 'cello', 'mandolin', 'banjo']) {
    assert.ok(desc.includes(name), `the description does not name the ${name}`);
    assert.ok(menu.includes(name), `the description names the ${name}, which the menu does not have`);
  }
  // Homepage search (index.html): every typed word must be a substring of the
  // tool's title, description and keywords.
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/online-tuner\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the tuner');
  for (const q of ['cello', 'viola', 'mandolin', 'banjo', 'double bass', 'ukulele tuner', 'pitch detector', 'drop d', 'reference tone']) {
    assert.ok(q.split(' ').every(w => hay.includes(w)), `the homepage search finds nothing for "${q}"`);
  }
  // A tone at any frequency and a microphone check are other pages; every
  // internal link in the guide and FAQ is a page of this site.
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.ok(links.includes('/tone-generator/') && links.includes('/mic-test/'), `guide and FAQ links: ${links}`);
  // The tuning steps end by sending a player who is now in tune to the metronome.
  assert.deepEqual(links, ['/metronome/', '/tone-generator/', '/mic-test/']);
  const guide = (await page.locator('.prose').textContent()).replace(/\s+/g, ' ');
  assert.match(guide, /especially with a floating tremolo\. Once every string is in tune, the metronome keeps a steady beat for practice\. How the pitch is measured/);
  for (const href of links) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), `${href} is linked from the page but is not a tool page`);
  }
};
