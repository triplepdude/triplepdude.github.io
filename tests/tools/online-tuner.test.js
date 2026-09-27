// getUserMedia is stubbed with a stream from an OscillatorNode in a second
// AudioContext, so the tuner hears exact, known frequencies. Expected values
// were computed in python3 with f = A4 * 2 ** ((midi - 69) / 12) and
// cents = 1200 * log2(f / target):
//   E2 82.4069, A2 110, D3 146.8324, G3 195.9977, E4 329.6276, B0 30.8677,
//   E6 1318.5102, E3 164.8138, B-flat 4 466.1638; with A4 = 442: E2 82.7815.
//   329.63 Hz is E4 +0.01 cents; 440 Hz against A4 = 432 is +31.77 cents;
//   D3 - 20 cents = 145.1459 Hz; A4 + 15 cents = 443.8289 Hz; A4 - 30 cents = 432.4411 Hz.
module.exports = async ({ page, open, assert }) => {
  await page.addInitScript(() => {
    window.__gum = [];
    window.__oscs = [];
    const create = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () { const o = create.call(this); window.__oscs.push(o); return o; };
    window.__gumFail = null;
    navigator.mediaDevices.getUserMedia = async c => {
      window.__gum.push(JSON.parse(JSON.stringify(c)));
      if (window.__gumFail) throw new DOMException(window.__gumFail[1], window.__gumFail[0]);
      const ac = new AudioContext();
      const osc = new OscillatorNode(ac, { type: 'sine', frequency: 440 });
      const g = new GainNode(ac, { gain: 0.3 });
      const dest = ac.createMediaStreamDestination();
      osc.connect(g).connect(dest);
      osc.start();
      // White noise (fixed seed) that can be mixed in.
      const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = nb.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = seed / 2147483648 - 1; }
      const noise = new AudioBufferSourceNode(ac, { buffer: nb, loop: true }), ng = new GainNode(ac, { gain: 0 });
      noise.connect(ng).connect(dest);
      noise.start();
      window.__gen = { ac, osc, g, ng, stream: dest.stream };
      return dest.stream;
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
  await page.click('#otn-a4-down');
  await page.click('#otn-a4-down');
  assert.equal(await page.inputValue('#otn-a4'), '440');

  // Out-of-range calibration: a polite message after a pause, and 440 stays in use.
  await page.fill('#otn-a4', '460');
  await page.waitForFunction(() => /430 to 450 Hz\. Still using A4 = 440 Hz/.test(document.getElementById('otn-a4-msg').textContent));
  assert.equal(await page.getAttribute('#otn-a4-msg', 'role'), null);
  assert.equal(await text('#otn-play'), 'Play A5 (880.00 Hz)');
  await page.fill('#otn-a4', '440');
  assert.equal(await text('#otn-a4-msg'), '');

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
};
