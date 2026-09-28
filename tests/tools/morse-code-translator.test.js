// The character table below was typed from ITU-R M.1677-1 (10/2009), Part I,
// section 1.1, and the timing expectations use the PARIS standard (a unit is
// 1200/WPM ms) and the ARRL Farnsworth formula, independent of the page.
const fs = require('fs');

const ITU = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', 'É': '..-..', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-',
  L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--',
  X: '-..-', Y: '-.--', Z: '--..',
  1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', 0: '-----',
  '.': '.-.-.-', ',': '--..--', ':': '---...', '?': '..--..', "'": '.----.', '-': '-....-', '/': '-..-.', '(': '-.--.',
  ')': '-.--.-', '"': '.-..-.', '=': '-...-', '+': '.-.-.', '×': '-..-', '@': '.--.-.',
};

function readWav(file) {
  const b = fs.readFileSync(file);
  return {
    riff: b.toString('ascii', 0, 4), wave: b.toString('ascii', 8, 12), fmt: b.toString('ascii', 12, 16),
    format: b.readUInt16LE(20), channels: b.readUInt16LE(22), rate: b.readUInt32LE(24), bits: b.readUInt16LE(34),
    data: b.toString('ascii', 36, 40), dataLen: b.readUInt32LE(40),
    samples: new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length)),
  };
}
const rms = (s, a, b) => { let t = 0; for (let i = a; i < b; i++) t += s[i] * s[i]; return Math.sqrt(t / (b - a)); };

module.exports = async ({ page, open, assert }) => {
  await open();
  const val = sel => page.inputValue(sel);
  // The page shows dashes as U+2011 (a non-breaking hyphen) so codes never wrap
  // in the middle; copying gives plain hyphens (checked below).
  const morse = async () => {
    const v = await val('#mc-morse');
    assert.ok(!/-/.test(v) || !/\u2011/.test(v), 'generated Morse uses one dash character');
    return v.replace(/\u2011/g, '-');
  };
  const text = sel => page.locator(sel).textContent();

  // Default: SOS as three letters, 20 WPM timing.
  assert.equal(await val('#mc-text'), 'SOS');
  assert.equal(await morse(), '... --- ...');
  assert.match(await text('#mc-timing'), /^Dot 60 ms · dash 180 ms · letter gap 180 ms · word gap 420 ms · length 1\.6 s$/);

  // Every ITU character, one per word, encodes to the standard code.
  const chars = Object.keys(ITU);
  await page.fill('#mc-text', chars.join(' '));
  assert.equal(await morse(), chars.map(c => ITU[c]).join(' / '));
  assert.equal(await text('#mc-msg'), '');
  // ...and decodes back (× shares its code with X).
  await page.fill('#mc-morse', chars.map(c => ITU[c]).join(' / '));
  assert.equal(await val('#mc-text'), chars.map(c => (c === '×' ? 'X' : c)).join(' '));

  // Sentences, lower case, prosigns, % as 0/0, accents, ß, typographic quotes.
  await page.fill('#mc-text', 'Hello, world!');
  assert.equal(await morse(), '.... . .-.. .-.. --- --..-- / .-- --- .-. .-.. -.. -.-.--');
  // ITU-R M.1677-1 3.3.2: "For 2%, transmit 2-0/0, and not 20/0"; the page
  // used to send 50% as 500/0. A % on its own is just 0/0.
  await page.fill('#mc-text', '<SOS> <AR> 50%');
  assert.equal(await morse(), '...---... / .-.-. / ..... ----- -....- ----- -..-. -----');
  await page.fill('#mc-text', '50 %');
  assert.equal(await morse(), '..... ----- / ----- -..-. -----');
  // 4.3 and 3.3.2: fractions are joined by a hyphen too ("4-1/2-0/00" for 4½‰),
  // and 3.5.1: minutes and seconds are one and two apostrophes.
  await page.fill('#mc-text', '4½‰ 1′15″');
  assert.equal(await morse(), '....- -....- .---- -..-. ..--- -....- ----- -..-. ----- ----- / .---- .----. .---- ..... .----. .----.');
  assert.equal(await text('#mc-msg'), '');
  // Letters without their own code: ẞ like ß, ligatures and superscripts
  // decomposed, Æ and Ø as Ä and Ö (non-ITU) or AE and O.
  await page.fill('#mc-text', 'ẞ Œ Ĳ x² Æ Ø');
  assert.equal(await morse(), '... ... / --- . / .. .--- / -..- ..--- / .-.- / ---.');
  await page.uncheck('#mc-ext');
  assert.equal(await morse(), '... ... / --- . / .. .--- / -..- ..--- / .- . / ---');
  await page.check('#mc-ext');
  await page.fill('#mc-text', 'Straße “ok” – café');
  assert.equal(await morse(), '... - .-. .- ... ... . / .-..-. --- -.- .-..-. / -....- / -.-. .- ..-. ..-..');
  await page.fill('#mc-text', 'señor ô');
  assert.equal(await morse(), '... . --.-- --- .-. / ---');
  await page.uncheck('#mc-ext');
  assert.equal(await morse(), '... . -. --- .-. / ---');
  await page.fill('#mc-text', 'hi! 😀');
  assert.equal(await morse(), '.... ..');
  assert.match(await text('#mc-msg'), /No Morse code for “!”, “😀”/);
  await page.check('#mc-ext');
  assert.equal(await morse(), '.... .. -.-.--');
  assert.match(await text('#mc-msg'), /No Morse code for “😀”, so it was left out\./);
  // Line breaks are kept.
  await page.fill('#mc-text', 'a b\nc');
  assert.equal(await morse(), '.- / -...\n-.-.');

  // Morse to text: lenient input, prosigns, unknown codes, stray letters.
  await page.fill('#mc-morse', '...---...  .- .-.. .-.. | ·−  • —   ........ ...-.- .-... -.-.-');
  assert.equal(await val('#mc-text'), '<SOS> ALL A ET <HH><SK>&<KA>');
  await page.fill('#mc-morse', '.... .. / .-.-.-.- x');
  assert.equal(await val('#mc-text'), 'HI #');
  assert.match(await text('#mc-msg'), /not a Morse character, shown as #: \.-\.-\.-\.-\./);
  assert.match(await text('#mc-msg'), /“x” was ignored/);
  assert.equal(await page.getAttribute('#mc-msg', 'role'), 'status');
  // Regression: switching the non-ITU signs off while the Morse was typed by
  // hand re-encoded the text and deleted the codes it could no longer write.
  await page.fill('#mc-morse', '-.-.-- .-');
  assert.equal(await val('#mc-text'), '!A');
  await page.uncheck('#mc-ext');
  assert.equal(await morse(), '-.-.-- .-');
  assert.equal(await val('#mc-text'), '#A');
  await page.check('#mc-ext');
  assert.equal(await val('#mc-text'), '!A');
  await page.fill('#mc-morse', '');
  assert.equal(await val('#mc-text'), '');
  assert.equal(await text('#mc-msg'), '');

  // Separators and symbols.
  await page.fill('#mc-text', 'SOS SOS');
  await page.selectOption('#mc-wsep', 'pipe');
  assert.equal(await morse(), '... --- ... | ... --- ...');
  await page.selectOption('#mc-wsep', 'spaces');
  assert.equal(await morse(), '... --- ...   ... --- ...');
  await page.selectOption('#mc-lsep', 'slash');
  await page.selectOption('#mc-wsep', 'dslash');
  assert.equal(await morse(), '.../---/... // .../---/...');
  await page.fill('#mc-morse', '.../---/...//.-/-...');
  assert.equal(await val('#mc-text'), 'SOS AB');
  // Regression: a clashing choice used to show an error and leave the Morse
  // stale; now the other separator moves out of the way.
  await page.fill('#mc-text', 'SOS SOS');
  await page.selectOption('#mc-wsep', 'slash');
  assert.equal(await val('#mc-lsep'), 'space');
  assert.equal(await morse(), '... --- ... / ... --- ...');
  await page.selectOption('#mc-lsep', 'slash');
  assert.equal(await val('#mc-wsep'), 'dslash');
  assert.equal(await morse(), '.../---/... // .../---/...');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(e => /Words are now separated by Double slash/.test(e.textContent)));
  await page.selectOption('#mc-wsep', 'pipe');
  await page.selectOption('#mc-lsep', 'pipe');
  assert.equal(await val('#mc-wsep'), 'slash');
  assert.equal(await morse(), '...|---|... / ...|---|...');
  assert.equal(await text('#mc-msg'), '');
  await page.selectOption('#mc-lsep', 'space');
  await page.selectOption('#mc-sym', 'under');
  await page.fill('#mc-text', 'SOS');
  assert.equal(await morse(), '··· ___ ···');
  await page.selectOption('#mc-sym', 'bullet');
  assert.equal(await morse(), '••• ▬▬▬ •••');
  await page.fill('#mc-morse', '··· −−− ··· / ·−');
  assert.equal(await val('#mc-text'), 'SOS A');
  await page.selectOption('#mc-sym', 'ascii');

  // Generated dashes don't allow a line break inside a code; copies are plain ASCII.
  await page.fill('#mc-text', '<SOS> ' + 'PARIS '.repeat(12));
  assert.ok((await val('#mc-morse')).includes('...\u2011\u2011\u2011...'));
  await page.click('#mc-copy-morse');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, await morse());
  assert.ok(copied.startsWith('...---... / .--. .- .-. .. ...'));
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.focus('#mc-morse');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), copied);

  // Timing: PARIS at 20 WPM, and Farnsworth 20/10 (ARRL: ta = (60c - 37.2s)/(sc)).
  await page.fill('#mc-text', 'PARIS PARIS');
  const c = 20, s = 10, u = 1.2 / c, ta = (60 * c - 37.2 * s) / (s * c);
  assert.equal(await text('#mc-timing'), `Dot ${Math.round(u * 1000)} ms · dash ${Math.round(3 * u * 1000)} ms · letter gap 180 ms · word gap 420 ms · length ${Math.round(93 * u * 10) / 10} s`);
  const wav = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mc-wav')]);
    assert.equal(dl.suggestedFilename(), 'morse-paris-paris.wav');
    return readWav(await dl.path());
  };
  let w = await wav();
  assert.deepEqual([w.riff, w.wave, w.fmt, w.data, w.format, w.channels, w.rate, w.bits], ['RIFF', 'WAVE', 'fmt ', 'data', 1, 1, 22050, 16]);
  // 0.1 s of silence, 93 units (PARIS = 50 with its word gap, the last one 43), 0.1 s of silence.
  assert.equal(w.samples.length, Math.round((0.2 + 93 * u) * 22050));
  assert.equal(w.dataLen, w.samples.length * 2);
  const at = t => Math.round((0.1 + t) * 22050);
  assert.equal(rms(w.samples, 0, at(0) - 1), 0, 'lead-in is silent');
  assert.ok(rms(w.samples, at(0.005), at(u - 0.005)) > 5000, 'first dot sounds');
  assert.equal(rms(w.samples, at(u) + 1, at(2 * u) - 1), 0, 'gap inside P is silent');
  assert.ok(rms(w.samples, at(2 * u + 0.005), at(5 * u - 0.005)) > 5000, 'first dash sounds');
  assert.equal(rms(w.samples, at(11 * u) + 1, at(14 * u) - 1), 0, 'letter gap after P is silent');
  assert.ok(rms(w.samples, at(14 * u + 0.005), at(15 * u - 0.005)) > 5000, 'A starts after 3 units');
  assert.equal(rms(w.samples, at(43 * u) + 1, at(50 * u) - 1), 0, 'word gap is silent');
  assert.ok(rms(w.samples, at(50 * u + 0.005), at(51 * u - 0.005)) > 5000, 'second word starts after 7 units');
  // The tone is 600 Hz: count zero crossings over the first dash (3 units = 180 ms).
  let zc = 0;
  for (let i = at(2 * u + 0.01); i < at(5 * u - 0.01); i++) if ((w.samples[i - 1] < 0) !== (w.samples[i] < 0)) zc++;
  assert.ok(Math.abs(zc / 2 / (3 * u - 0.02) - 600) < 15, `tone frequency ${zc / 2 / (3 * u - 0.02)}`);

  await page.fill('#mc-fwpm', String(s));
  const lg = 3 * ta / 19, wg = 7 * ta / 19;
  assert.equal(Math.round(lg * 1000), 654);
  assert.equal(Math.round(wg * 1000), 1525);
  assert.match(await text('#mc-timing'), /letter gap 654 ms · word gap 1,525 ms/);
  w = await wav();
  const content = 2 * (31 * u + 4 * lg) + wg; // "PARIS " is exactly 6 s at 10 WPM overall
  assert.ok(Math.abs(31 * u + 4 * lg + wg - 6) < 1e-9);
  assert.equal(w.samples.length, Math.round((0.2 + content) * 22050));
  assert.equal(rms(w.samples, at(11 * u) + 1, at(11 * u + lg) - 1), 0, 'stretched letter gap is silent');
  assert.ok(rms(w.samples, at(11 * u + lg + 0.005), at(12 * u + lg - 0.005)) > 5000, 'A starts after the Farnsworth gap');

  // The Farnsworth speed follows the character speed while they are equal.
  await page.fill('#mc-fwpm', '20');
  await page.fill('#mc-wpm', '25');
  assert.equal(await val('#mc-fwpm'), '25');
  assert.match(await text('#mc-timing'), /^Dot 48 ms/);
  await page.fill('#mc-wpm', '99');
  assert.match(await text('#mc-set-msg'), /Character speed must be 5 to 60 WPM/);
  assert.equal(await page.isDisabled('#mc-wav'), true);
  await page.fill('#mc-wpm', '20');
  await page.fill('#mc-fwpm', '20');
  assert.equal(await text('#mc-set-msg'), '');
  // Regression: the timing line changes with every letter typed, and was an
  // aria-live region, so screen readers read it out on each keystroke. Now a
  // speed change is announced once, after a pause.
  assert.equal(await page.getAttribute('#mc-timing', 'aria-live'), null);
  assert.equal(await page.locator('#mc-timing').evaluate(e => !!e.closest('[aria-live],[role="status"],[role="alert"]')), false);
  await page.fill('#mc-wpm', '24');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(e => e.textContent === 'Dot 50 ms, letter gap 150 ms, word gap 350 ms'));
  await page.fill('#mc-wpm', '20');

  // Playback with Web Audio: the button toggles, the light flashes, it ends by itself.
  await page.fill('#mc-text', 'EE');
  await page.evaluate(() => {
    window.__mcOn = 0;
    new MutationObserver(() => { if (document.querySelector('#mc-light').classList.contains('mc-on')) window.__mcOn++; })
      .observe(document.querySelector('#mc-light'), { attributes: true, attributeFilter: ['class'] });
  });
  await page.click('#mc-play');
  assert.equal(await text('#mc-play'), 'Stop');
  await page.waitForFunction(() => document.querySelector('#mc-play').textContent === 'Play', null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => window.__mcOn) >= 1, 'the light flashed');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mc-play');
  // Regression: Flash a light was read only when playback started.
  await page.fill('#mc-text', 'EEEE');
  await page.fill('#mc-wpm', '5');
  await page.uncheck('#mc-flash');
  await page.evaluate(() => { window.__mcOn = 0; });
  await page.click('#mc-play');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__mcOn), 0, 'no flashing while unticked');
  await page.check('#mc-flash');
  await page.waitForFunction(() => window.__mcOn > 0, null, { timeout: 3000 });
  await page.click('#mc-play');
  await page.fill('#mc-wpm', '20');
  // Stop in the middle of a long message.
  await page.fill('#mc-wpm', '5');
  await page.click('#mc-play');
  await page.waitForTimeout(300);
  await page.click('#mc-play');
  assert.equal(await text('#mc-play'), 'Play');
  assert.equal(await page.locator('#mc-light.mc-on').count(), 0);

  // Chart: every ITU cell shows the standard code and plays it.
  const cells = await page.$$eval('#mc-charts .mc-cell', els => els.map(e => [e.querySelector('.mc-ch').firstChild.textContent, e.querySelector('.mc-code').textContent]));
  for (const [ch, code] of Object.entries(ITU)) {
    assert.ok(cells.some(([a, b]) => a === ch && b === code), `chart shows ${ch} ${code}`);
  }
  assert.ok(cells.some(([a, b]) => a === '!*' && b === '-.-.--'), 'non-ITU signs are marked');
  assert.ok(cells.some(([a, b]) => a === '<SOS>' && b === '...---...'));
  await page.fill('#mc-wpm', '60');
  await page.click('#mc-charts .mc-cell >> nth=0');
  assert.equal(await text('#mc-play'), 'Stop');
  await page.waitForFunction(() => document.querySelector('#mc-play').textContent === 'Play', null, { timeout: 5000 });

  await page.click('#mc-clear');
  assert.equal(await val('#mc-text'), '');
  assert.equal(await morse(), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mc-text');

  // Reduced motion: the light starts switched off.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  assert.equal(await page.isChecked('#mc-flash'), false);
  assert.equal(await page.isVisible('#mc-motion'), true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
};
