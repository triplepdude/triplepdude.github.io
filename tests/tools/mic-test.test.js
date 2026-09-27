const fs = require('fs');

// Uses Chromium's fake microphone ("Fake Default Audio Input", a full-scale
// beep) and, for the known-answer check, a synthetic sine wave of amplitude
// 0.5: peak = 20*log10(0.5) = -6.02 dBFS, RMS = 20*log10(0.5/sqrt(2)) = -9.03 dBFS.
module.exports = async ({ page, open, assert }) => {
  await open();
  const text = s => page.locator(s).textContent();
  const waitText = (sel, re, timeout = 6000) => page.waitForFunction(
    ([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout });

  assert.equal(await page.isEnabled('#mict-start'), true);
  assert.equal(await page.isDisabled('#mict-stop'), true);
  assert.equal(await page.isDisabled('#mict-rec'), true);
  assert.equal(await text('#mict-error'), '');
  assert.equal(await page.isVisible('#mict-audio'), false);
  assert.equal(await page.isVisible('#mict-dl'), false);

  // The meter fill uses the level table's bands on its -60..0 dBFS scale: amber
  // (quiet) below -25 dBFS = 58.333%, green (good) to -6 dBFS = 90%, red above.
  const grad = await page.$eval('#mict-meter', m => getComputedStyle(m).backgroundImage);
  const stops = [...grad.matchAll(/(rgb\([^)]*\)) ([\d.]+)%/g)].map(m => [m[1], Number(m[2])]);
  const colourAt = pct => stops.find(([, p]) => p >= pct)[0];
  const [amber, green, red] = [colourAt(1), colourAt(59), colourAt(91)];
  assert.equal(new Set([amber, green, red]).size, 3, grad);
  assert.equal(colourAt(58), amber, grad);
  assert.equal(colourAt(89), green, grad);
  assert.equal(await page.$eval('.mict-gt', t => t.nextElementSibling.textContent.replace(/\s+/g, ' ')),
    'The fill colour follows the same bands: amber while the peak is below −25 dBFS, green from −25 to −6 dBFS, and red above.');

  // Record every getUserMedia call and stream so we can check constraints and release.
  await page.evaluate(() => {
    const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
    window.__gum = { calls: [], streams: [] };
    md.getUserMedia = async c => {
      window.__gum.calls.push(JSON.parse(JSON.stringify(c)));
      const s = await orig(c);
      window.__gum.streams.push(s);
      return s;
    };
  });

  assert.match(await text('#mict-rec-status'), /^Start the microphone/);
  // Started from the keyboard: Start disables itself, so focus moves on to Stop
  // instead of falling back to <body> (WCAG 2.4.3).
  await page.focus('#mict-start');
  await page.keyboard.press('Enter');
  await waitText('#mict-rate', /kHz/);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'mict-stop');
  assert.match(await text('#mict-rec-status'), /^Ready\. Press Record/);
  assert.equal(await page.isDisabled('#mict-start'), true);
  assert.equal(await page.isEnabled('#mict-stop'), true);
  assert.equal(await page.isEnabled('#mict-rec'), true);
  const c0 = await page.evaluate(() => window.__gum.calls[0].audio);
  assert.equal(c0.echoCancellation, true);
  assert.equal(c0.noiseSuppression, true);
  assert.equal(c0.autoGainControl, true);

  // Device list is filled with the fake devices and the live one is selected.
  const opts = await page.locator('#mict-device option').allTextContents();
  assert.ok(opts.includes('Fake Default Audio Input'), opts.join('|'));
  assert.ok(opts.includes('Fake Audio Input 1'), opts.join('|'));
  const live = await page.evaluate(() => {
    const t = window.__gum.streams[0].getAudioTracks()[0];
    return { label: t.label, ch: t.getSettings().channelCount };
  });
  assert.equal(await page.$eval('#mict-device', s => s.options[s.selectedIndex].text), live.label);
  assert.match(await text('#mict-settings'), new RegExp(live.label));
  assert.equal(await text('#mict-ch'), String(live.ch));

  // The fake mic beeps near full scale: verdict, peak hold, meter move.
  await waitText('#mict-status', /microphone is working/);
  await page.waitForFunction(() => parseFloat(document.getElementById('mict-hold').textContent) > -20, null, { timeout: 5000 });
  assert.ok(Number(await page.getAttribute('#mict-meter', 'aria-valuenow')) >= -60);
  // Regression: the analyser ran at the output rate (44.1 kHz) on a 48 kHz mic and the
  // resampled full-scale beep read +0.4 dBFS. It now runs at the track's rate, so the
  // beep (samples at +/-1.0) reads exactly 0.0 and nothing ever goes above 0.
  const trackRate = await page.evaluate(() => window.__gum.streams[0].getAudioTracks()[0].getSettings().sampleRate);
  assert.match(await text('#mict-settings'), new RegExp('Analysis sample rate' + trackRate.toLocaleString('en-US') + ' Hz'));
  await waitText('#mict-hold', /^0\.0$/);
  for (let i = 0; i < 10; i++) {
    for (const id of ['#mict-peak', '#mict-hold', '#mict-rms']) {
      const v = await text(id);
      assert.ok(!(parseFloat(v) > 0) && v !== '-0.0', `${id} reads ${v}`);
    }
    await page.waitForTimeout(80);
  }

  // Hear-yourself toggle wires up without errors.
  await page.check('#mict-monitor');
  await page.uncheck('#mict-monitor');

  // Switching echo cancellation off restarts with the new constraint and frees the old stream.
  await page.uncheck('#mict-ec');
  await page.waitForFunction(() => window.__gum.calls.length === 2 && window.__gum.streams.length === 2);
  assert.equal(await page.evaluate(() => window.__gum.calls[1].audio.echoCancellation), false);
  assert.equal(await page.evaluate(() => window.__gum.streams[0].getTracks().every(t => t.readyState === 'ended')), true);
  await waitText('#mict-settings', /Echo cancellationOff/);

  // Picking another microphone asks for exactly that device.
  const id1 = await page.$eval('#mict-device', s => Array.from(s.options).find(o => o.text === 'Fake Audio Input 1').value);
  await page.selectOption('#mict-device', id1);
  await page.waitForFunction(() => window.__gum.calls.length === 3);
  assert.deepEqual(await page.evaluate(() => window.__gum.calls[2].audio.deviceId), { exact: id1 });
  await waitText('#mict-settings', /Fake Audio Input 1/);

  // "Turn all three off" reopens the mic once with every filter off.
  const nRaw = await page.evaluate(() => window.__gum.calls.length);
  await page.click('#mict-raw');
  await page.waitForFunction(n => window.__gum.calls.length === n + 1 && window.__gum.streams.length === n + 1, nRaw);
  assert.deepEqual(await page.evaluate(n => { const a = window.__gum.calls[n].audio; return [a.echoCancellation, a.noiseSuppression, a.autoGainControl]; }, nRaw), [false, false, false]);
  assert.deepEqual(await page.$$eval('#mict-ec, #mict-ns, #mict-agc', els => els.map(e => e.checked)), [false, false, false]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mict-raw');
  await waitText('#mict-settings', /Noise suppressionOff/);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(n => window.__gum.calls.length, nRaw), nRaw + 1, 'exactly one restart');
  await page.check('#mict-ns');
  await waitText('#mict-settings', /Noise suppressionOn/);
  await page.check('#mict-agc');
  await waitText('#mict-settings', /Auto gain controlOn/);
  await page.waitForTimeout(300);

  // Record a 5-second clip, check playback length and the downloaded WebM file.
  assert.match(await text('#mict-rec'), /Record 5 s clip/);
  // Regression: the live status was rewritten every frame with the elapsed time,
  // flooding screen readers. The counter is now in a separate, non-live element.
  await page.evaluate(() => {
    window.__live = [];
    const el = document.getElementById('mict-rec-status');
    new MutationObserver(() => window.__live.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.click('#mict-rec');
  assert.match(await text('#mict-rec'), /Stop recording/);
  await waitText('#mict-rec-status', /^Recording a 5-second clip/);
  await waitText('#mict-rec-time', /^[1-4]\.\d s of 5 s$/);
  assert.equal(await page.getAttribute('#mict-rec-time', 'aria-live'), null);
  await waitText('#mict-rec-status', /Recorded a [45]\.\d s clip/, 10000);
  assert.equal(await page.isVisible('#mict-rec-time'), false);
  const liveMsgs = await page.evaluate(() => window.__live);
  assert.ok(liveMsgs.length <= 4, `live status changed ${liveMsgs.length} times: ${liveMsgs.join(' | ')}`);
  const dur = await (await page.waitForFunction(() => {
    const a = document.getElementById('mict-audio');
    return Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
  }, null, { timeout: 8000 })).jsonValue();
  assert.ok(dur > 4.3 && dur < 5.8, `clip duration ${dur}`);
  assert.equal(await page.isVisible('#mict-audio'), true);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mict-dl')]);
  assert.match(dl.suggestedFilename(), /^mic-test-\d{8}-\d{6}\.webm$/);
  const bytes = fs.readFileSync(await dl.path());
  assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'EBML magic');
  assert.ok(bytes.includes(Buffer.from('webm')), 'webm DocType');
  assert.ok(bytes.includes(Buffer.from('A_OPUS')), 'Opus codec id');
  assert.ok(bytes.length > 2000, `size ${bytes.length}`);

  // Stop releases every track, and keyboard focus goes back to Start.
  await page.focus('#mict-stop');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'mict-start');
  assert.equal(await page.evaluate(() => window.__gum.streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.isEnabled('#mict-start'), true);
  assert.equal(await page.isDisabled('#mict-stop'), true);
  assert.equal(await page.isDisabled('#mict-rec'), true);
  assert.match(await text('#mict-status'), /released/);

  // Regression: a filter changed while the browser is still opening the mic was ignored,
  // so the checkbox and the live stream disagreed. It is now applied once the mic opens.
  await page.evaluate(() => {
    const md = navigator.mediaDevices, gum = md.getUserMedia;
    md.getUserMedia = c => new Promise(r => setTimeout(r, 600)).then(() => gum(c));
  });
  const n0 = await page.evaluate(() => window.__gum.calls.length);
  await page.click('#mict-start');
  await page.uncheck('#mict-ns');
  await page.waitForFunction(n => window.__gum.calls.length === n + 2 && window.__gum.streams.length === n + 2, n0, { timeout: 8000 });
  await waitText('#mict-settings', /Noise suppressionOff/);
  const pend = await page.evaluate(n => ({
    first: window.__gum.calls[n].audio.noiseSuppression,
    second: window.__gum.calls[n + 1].audio.noiseSuppression,
    oldEnded: window.__gum.streams[n].getTracks().every(t => t.readyState === 'ended'),
  }), n0);
  assert.deepEqual(pend, { first: true, second: false, oldEnded: true });
  assert.equal(await page.isEnabled('#mict-stop'), true);

  // Leaving the page releases the mic and resets the buttons (for back/forward cache restores).
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.evaluate(() => window.__gum.streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.isEnabled('#mict-start'), true);
  assert.equal(await page.isDisabled('#mict-stop'), true);
  assert.equal(await page.isDisabled('#mict-rec'), true);
  await page.check('#mict-ns');

  // Known answer: a 1 kHz sine at amplitude 0.5.
  const useSine = amp => page.evaluate(a => {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 1000;
    const g = ac.createGain();
    g.gain.value = a;
    const dest = ac.createMediaStreamDestination();
    osc.connect(g).connect(dest);
    osc.start();
    navigator.mediaDevices.getUserMedia = async () => new MediaStream(dest.stream.getAudioTracks().map(t => t.clone()));
  }, amp);
  await useSine(0.5);
  await page.click('#mict-start');
  await page.waitForTimeout(1200);
  const peak = parseFloat(await text('#mict-hold'));
  const rms = parseFloat(await text('#mict-rms'));
  const expPeak = 20 * Math.log10(0.5), expRms = 20 * Math.log10(0.5 / Math.SQRT2);
  assert.ok(Math.abs(peak - expPeak) < 0.3, `peak ${peak} vs ${expPeak}`);
  assert.ok(Math.abs(rms - expRms) < 0.3, `rms ${rms} vs ${expRms}`);
  assert.equal(await text('#mict-clip'), 'None');
  assert.match(await text('#mict-status'), /working/);
  // The WAV download holds the raw samples: parse it independently and check
  // the header, the length, and the sine's amplitude (0.5 of full scale:
  // peak 16384, RMS 0.5/sqrt(2) = 0.354) and frequency (1000 Hz by zero crossings).
  const rate = Number((await text('#mict-settings')).match(/Analysis sample rate([\d,]+) Hz/)[1].replace(/,/g, ''));
  await page.click('#mict-rec');
  await waitText('#mict-rec-status', /Recorded a [45]\.\d s clip/, 10000);
  await page.waitForSelector('#mict-dl-wav', { state: 'visible' });
  assert.match(await text('#mict-dl-wav'), /^Download WAV \(uncompressed, [\d,]+ KB\)$/);
  const [wdl] = await Promise.all([page.waitForEvent('download'), page.click('#mict-dl-wav')]);
  assert.match(wdl.suggestedFilename(), /^mic-test-\d{8}-\d{6}\.wav$/);
  const wav = fs.readFileSync(await wdl.path());
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('latin1', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1, 'PCM');
  const ch = wav.readUInt16LE(22), sr = wav.readUInt32LE(24);
  assert.ok(ch === 1 || ch === 2, `channels ${ch}`);
  assert.equal(sr, rate);
  assert.equal(wav.readUInt32LE(28), sr * ch * 2, 'byte rate');
  assert.equal(wav.readUInt16LE(32), ch * 2, 'block align');
  assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
  assert.equal(wav.toString('latin1', 36, 40), 'data');
  const dataLen = wav.readUInt32LE(40);
  assert.equal(dataLen, wav.length - 44);
  const frames = dataLen / (2 * ch);
  assert.ok(frames / sr > 4.3 && frames / sr <= 5, `WAV length ${frames / sr} s`);
  const samples = [];
  for (let i = 0; i < frames; i++) samples.push(wav.readInt16LE(44 + i * ch * 2) / 32768);
  const mid = samples.slice(Math.floor(sr * 0.5), Math.floor(sr * 3.5)); // skip the edges
  const wPeak = mid.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const wRms = Math.sqrt(mid.reduce((a, x) => a + x * x, 0) / mid.length);
  let crossings = 0;
  for (let i = 1; i < mid.length; i++) if (mid[i - 1] < 0 && mid[i] >= 0) crossings++;
  assert.ok(Math.abs(wPeak - 0.5) < 0.01, `WAV peak ${wPeak}`);
  assert.ok(Math.abs(wRms - 0.5 / Math.SQRT2) < 0.01, `WAV RMS ${wRms}`);
  assert.ok(Math.abs(crossings / 3 - 1000) < 5, `WAV frequency ${crossings / 3} Hz`);
  await page.click('#mict-stop');

  // Digital silence triggers a specific warning after a few seconds.
  await useSine(0);
  await page.click('#mict-start');
  await waitText('#mict-error', /pure silence/, 7000);
  assert.equal(await text('#mict-hold'), '-∞');
  await page.click('#mict-stop');

  // Clear messages for each getUserMedia failure.
  const cases = [
    ['NotAllowedError', 'Permission denied', /^Permission denied/],
    ['NotAllowedError', 'Permission denied by system', /operating system is blocking/],
    ['NotFoundError', 'Requested device not found', /^No microphone found/],
    ['NotReadableError', 'Could not start audio source', /in use by another app/],
    ['OverconstrainedError', '', /no longer available/],
  ];
  for (const [name, message, re] of cases) {
    await page.evaluate(([n, m]) => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException(m, n)); }, [name, message]);
    await page.click('#mict-start');
    await waitText('#mict-error', re);
    assert.equal(await page.isDisabled('#mict-stop'), true);
    assert.equal(await page.isEnabled('#mict-start'), true);
  }

  // Insecure context: explained on click and on load, and Start is disabled.
  await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }));
  await page.click('#mict-start');
  assert.match(await text('#mict-error'), /secure connection/);
  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }));
  await page.reload();
  assert.match(await text('#mict-error'), /secure connection/);
  assert.equal(await page.isDisabled('#mict-start'), true);
};
