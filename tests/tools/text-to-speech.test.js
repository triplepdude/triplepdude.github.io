const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Headless Chromium has no voices (speak() fails with synthesis-failed), so the
// page is driven against a fake speechSynthesis that records every utterance and
// fires start, word boundary, end and error events. `#voices=X` in the address
// picks a voice list modelled on a real browser (the page ignores the hash):
// A Chrome on Windows, B Chrome on Linux (Google voices only), C Safari (every
// voice "default", novelty voices first), D Android (en_US codes), F none.
// With __tts.manual the test fires each event itself. Expected sentence splits
// are worked out by hand from the rules in the page's guide; the online-voice
// piece lengths from its 140-characters-at-1x rule (70 at 0.5x, 280 at 2x).
function fakeSpeech() {
  const P = new URLSearchParams(location.hash.slice(1));
  if (P.get('nosynth')) {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    window.SpeechSynthesisUtterance = undefined;
    return;
  }
  if (P.get('real')) return;
  if (P.get('nohl')) {
    window.Highlight = undefined;
    try { Object.defineProperty(CSS, 'highlights', { value: undefined, configurable: true }); } catch (e) { /* Highlight is gone, which is enough */ }
  }
  const V = (name, lang, local, extra) => Object.assign({ name, lang, localService: local, default: false, voiceURI: name }, extra || {});
  const SETS = {
    A: [V('Microsoft David - English (United States)', 'en-US', true, { default: true }), V('Microsoft Hazel - English (Great Britain)', 'en-GB', true, { noLength: true }),
      V('Microsoft Zira - English (United States)', 'en-US', true), V('Microsoft Hortense - French (France)', 'fr-FR', true), V('Kyoko', 'ja-JP', true),
      V('Google US English', 'en-US', false, { quiet: true }), V('Google UK English Female', 'en-GB', false, { quiet: true }), V('Google UK English Male', 'en-GB', false, { quiet: true }),
      V('Google Deutsch', 'de-DE', false, { quiet: true }), V('Google français', 'fr-FR', false, { quiet: true }), V('Google 日本語', 'ja-JP', false, { quiet: true }),
      V('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false)],
    B: [V('Google US English', 'en-US', false, { quiet: true }), V('Google UK English Female', 'en-GB', false, { quiet: true })],
    C: ['Albert', 'Bad News', 'Bubbles', 'Samantha', 'Zarvox'].map(n => V(n, 'en-US', true, { default: true, voiceURI: 'com.apple.voice.' + n }))
      .concat([V('Daniel', 'en-GB', true, { default: true }), V('Thomas', 'fr-FR', true, { default: true })]),
    D: [V('English United States', 'en_US', true), V('English United Kingdom', 'en_gb', true), V('English (Firefox)', 'eng-US-f000', true), V('Deutsch Deutschland', 'de_DE', true), V('Mystery voice', '', true)],
    F: [],
  };
  const set = SETS[P.get('voices') || 'A'];
  let list = P.get('late') ? [] : set;
  const T = window.__tts = { log: [], calls: [], events: [], manual: false, msPerChar: 3, cancelEnd: false, failNext: null, dropNext: 0, stallNext: false, queue: [], current: null, timers: [] };
  const synth = new EventTarget();
  if (P.get('late')) setTimeout(() => { list = set; synth.dispatchEvent(new Event('voiceschanged')); }, +P.get('late'));
  synth.getVoices = () => list.slice();
  Object.defineProperty(synth, 'speaking', { get: () => !!T.current });
  Object.defineProperty(synth, 'pending', { get: () => T.queue.length > 0 });
  Object.defineProperty(synth, 'paused', { get: () => false });
  function fire(u, type, extra) {
    if (!u) return;
    const e = new Event(type);
    Object.assign(e, { charIndex: 0, charLength: 0, name: '', elapsedTime: 0, utterance: u }, extra || {});
    T.events.push(type);
    if (typeof u['on' + type] === 'function') u['on' + type](e);
  }
  const later = (fn, ms) => T.timers.push(setTimeout(fn, ms));
  function next() {
    if (T.current) return;
    const u = T.queue.shift();
    if (!u) return;
    T.current = u;
    if (T.failNext) {
      const code = T.failNext;
      T.failNext = null;
      later(() => { if (T.current !== u) return; T.current = null; fire(u, 'error', { error: code }); next(); }, 5);
      return;
    }
    if (T.manual) return;
    const stall = T.stallNext, ms = T.msPerChar / (u.rate || 1);
    T.stallNext = false;
    later(() => { if (T.current === u) fire(u, 'start'); }, 5);
    if (stall) return;
    if (!(u.voice && u.voice.quiet)) {
      const re = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu;
      let m;
      while ((m = re.exec(u.text))) {
        const i = m.index, len = m[0].length;
        later(() => { if (T.current === u) fire(u, 'boundary', { name: 'word', charIndex: i, charLength: u.voice && u.voice.noLength ? 0 : len }); }, 6 + i * ms);
      }
    }
    later(() => { if (T.current !== u) return; T.current = null; fire(u, 'end'); next(); }, 10 + u.text.length * ms);
  }
  synth.speak = function (u) {
    T.calls.push('speak');
    T.log.push({ text: u.text, voice: u.voice ? u.voice.name : null, lang: u.lang, rate: u.rate, pitch: u.pitch, volume: u.volume });
    if (T.dropNext > 0) { T.dropNext--; return; }
    T.queue.push(u);
    next();
  };
  synth.cancel = function () {
    T.calls.push('cancel');
    T.timers.forEach(clearTimeout);
    T.timers = [];
    const cur = T.current, q = T.queue.splice(0);
    T.current = null;
    if (cur) {
      if (T.cancelEnd) fire(cur, 'end');
      else setTimeout(() => fire(cur, 'error', { error: 'interrupted' }), 0);
    }
    q.forEach(u => setTimeout(() => fire(u, 'error', { error: 'canceled' }), 0));
  };
  synth.pause = () => T.calls.push('pause');
  synth.resume = () => T.calls.push('resume');
  // Manual control of the utterance being spoken.
  T.start = () => fire(T.current, 'start');
  T.word = (i, len = 0) => fire(T.current, 'boundary', { name: 'word', charIndex: i, charLength: len });
  T.end = () => { const u = T.current; T.current = null; fire(u, 'end'); next(); };
  T.error = code => { const u = T.current; T.current = null; fire(u, 'error', { error: code }); next(); };
  T.say = () => (T.current ? T.current.text : null);
  class FakeUtterance extends EventTarget {
    constructor(text) {
      super();
      Object.assign(this, { text: text == null ? '' : String(text), lang: '', voice: null, volume: 1, rate: 1, pitch: 1 });
      this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = this.onmark = null;
    }
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
}

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  await page.addInitScript(fakeSpeech);
  await open();
  const browser = page.context().browser();
  const text = s => page.locator(s).textContent();
  const tts = fn => page.evaluate(fn);
  const state = () => text('#tts-state');
  const saying = () => tts(() => __tts.say());
  const lastLog = () => tts(() => __tts.log[__tts.log.length - 1]);
  const hl = name => page.evaluate(n => { const h = CSS.highlights.get(n); const r = h && [...h][0]; return r ? r.toString() : null; }, name);
  const voiceRows = () => page.$$eval('#tts-vlist .tts-group', gs => gs.filter(g => !g.hidden).map(g => [g.querySelector('.tts-glabel').textContent,
    [...g.querySelectorAll('.tts-voice:not([hidden])')].map(l => l.textContent)]));
  const checked = () => page.$eval('#tts-vlist input:checked', i => i.closest('label').querySelector('.tts-vname').textContent);
  const pick = name => page.locator('#tts-vlist label', { hasText: name }).first().locator('input').check();
  const manual = () => tts(() => { __tts.manual = true; __tts.log.length = 0; __tts.calls.length = 0; });
  // Every piece the page sends for this text, in manual mode.
  const pieces = async (t, setup) => {
    await page.fill('#tts-text', t);
    await manual();
    if (setup) await setup();
    await page.click('#tts-play');
    const out = [];
    for (let i = 0; i < 400; i++) {
      const s = await saying();
      if (s == null) break;
      out.push(s);
      await tts(() => { __tts.start(); __tts.end(); });
    }
    assert.equal(await state(), 'Finished reading.');
    return out;
  };

  // ---- Start: a voice on this device in the visitor's language, the list grouped by language ----
  assert.equal(await page.inputValue('#tts-text'), 'Paste or type your own text here, then press Play to hear it read aloud. You can follow along as each sentence is highlighted. Choose a voice below and set the speed, pitch and volume to suit you.');
  assert.equal(await text('#tts-count'), '196 characters');
  assert.deepEqual(await voiceRows(), [
    ['English (United States)', ['Microsoft David - English (United States)', 'Microsoft Zira - English (United States)', 'Google US EnglishOnline', 'Microsoft Aria Online (Natural) - English (United States)Online']],
    ['English (United Kingdom)', ['Microsoft Hazel - English (Great Britain)', 'Google UK English FemaleOnline', 'Google UK English MaleOnline']],
    ['French (France)', ['Microsoft Hortense - French (France)', 'Google françaisOnline']],
    ['German (Germany)', ['Google DeutschOnline']],
    ['Japanese (Japan)', ['Kyoko', 'Google 日本語Online']],
  ]);
  assert.equal(await checked(), 'Microsoft David - English (United States)');
  assert.equal(await text('#tts-chosen'), 'Selected: Microsoft David - English (United States) · English (United States) · on this device');
  assert.equal(await text('#tts-vcount'), '12 voices in 4 languages, 7 of them online');
  assert.equal(await text('#tts-online'), '');
  assert.equal(await page.isVisible('#tts-novoice'), false);
  assert.equal(await text('#tts-play'), 'Play');
  for (const b of ['#tts-stop', '#tts-prev', '#tts-next']) assert.equal(await page.getAttribute(b, 'aria-disabled'), 'true', b);
  assert.equal(await page.getAttribute('#tts-prev', 'aria-label'), 'Previous sentence');
  // Emoji count once: "a👍b" is 3 characters, not 4 UTF-16 units.
  await page.fill('#tts-text', 'a\u{1F44D}b');
  assert.equal(await text('#tts-count'), '3 characters');

  // ---- Reading the sample: one sentence per utterance, in the chosen voice and settings ----
  await page.fill('#tts-text', 'Paste or type your own text here, then press Play to hear it read aloud. You can follow along as each sentence is highlighted. Choose a voice below and set the speed, pitch and volume to suit you.');
  await page.click('#tts-play');
  assert.equal(await state(), 'Reading with Microsoft David - English (United States).');
  assert.equal(await text('#tts-play'), 'Pause');
  assert.equal(await page.isVisible('#tts-view'), true);
  assert.equal(await page.isVisible('#tts-text'), false);
  assert.equal(await page.getAttribute('#tts-stop', 'aria-disabled'), 'false');
  await page.waitForFunction(() => document.querySelector('#tts-state').textContent === 'Finished reading.', null, { timeout: 8000 });
  let log = await tts(() => __tts.log);
  assert.deepEqual(log.map(l => l.text), ['Paste or type your own text here, then press Play to hear it read aloud.', 'You can follow along as each sentence is highlighted.', 'Choose a voice below and set the speed, pitch and volume to suit you.']);
  assert.ok(log.every(l => l.voice === 'Microsoft David - English (United States)' && l.lang === 'en-US' && l.rate === 1 && l.pitch === 1 && l.volume === 1), JSON.stringify(log[0]));
  assert.equal(await page.isVisible('#tts-view'), false);
  assert.equal(await page.isVisible('#tts-text'), true);
  assert.equal(await text('#tts-play'), 'Play');
  assert.equal(await text('#tts-prog'), '');

  // ---- Highlighting, progress, pause and resume, previous and next (events fired by hand) ----
  await page.fill('#tts-text', 'Hello world. Second sentence here.');
  await manual();
  await page.click('#tts-play');
  assert.equal(await saying(), 'Hello world.');
  assert.equal(await text('#tts-prog'), 'Sentence 1 of 2');
  assert.equal(await hl('tts-sentence'), 'Hello world.');
  await tts(() => { __tts.start(); __tts.word(0, 5); });
  assert.equal(await hl('tts-word'), 'Hello');
  // No charLength (Safari, some engines): the word is found from its start.
  await tts(() => __tts.word(6));
  assert.equal(await hl('tts-word'), 'world');
  await tts(() => __tts.end());
  assert.equal(await saying(), 'Second sentence here.');
  assert.equal(await text('#tts-prog'), 'Sentence 2 of 2');
  assert.equal(await hl('tts-sentence'), 'Second sentence here.');
  assert.equal(await hl('tts-word'), '', 'no word is lit until the voice reports one');
  assert.equal(await page.$eval('#tts-bar-fill', e => e.style.width), `${(13 / 34 * 100).toFixed(2)}%`);
  await tts(() => { __tts.start(); __tts.word(7, 8); });
  assert.equal(await hl('tts-word'), 'sentence');
  // Pause stops the voice; Resume reads on from the word it stopped at.
  await page.click('#tts-play');
  assert.equal(await state(), 'Paused.');
  assert.equal(await text('#tts-play'), 'Resume');
  assert.equal(await saying(), null);
  assert.deepEqual(await tts(() => __tts.calls.slice(-1)), ['cancel']);
  assert.equal(await hl('tts-word'), 'sentence', 'the paused word stays lit');
  await page.click('#tts-play');
  assert.equal(await saying(), 'sentence here.');
  assert.equal(await state(), 'Reading with Microsoft David - English (United States).');
  // Next on the last sentence does nothing; Previous restarts the sentence, then goes back one.
  await tts(() => { __tts.start(); __tts.word(0, 8); __tts.word(9, 4); });
  await page.click('#tts-next');
  assert.equal(await saying(), 'sentence here.');
  await page.click('#tts-prev');
  assert.equal(await saying(), 'Second sentence here.');
  await page.click('#tts-prev');
  assert.equal(await saying(), 'Hello world.');
  assert.equal(await text('#tts-prog'), 'Sentence 1 of 2');
  await page.click('#tts-next');
  assert.equal(await saying(), 'Second sentence here.');
  // While paused, Previous and Next move the highlight without speaking.
  await page.click('#tts-play');
  await page.click('#tts-prev');
  assert.equal(await saying(), null);
  assert.equal(await hl('tts-sentence'), 'Hello world.');
  assert.equal(await state(), 'Paused.');
  await page.click('#tts-play');
  assert.equal(await saying(), 'Hello world.');
  // A cancel that fires "end" at once (as Chrome does) must not skip a sentence.
  await tts(() => { __tts.cancelEnd = true; __tts.log.length = 0; });
  await page.click('#tts-next');
  assert.deepEqual(await tts(() => __tts.log.map(l => l.text)), ['Second sentence here.']);
  await tts(() => { __tts.cancelEnd = false; });
  // Stop goes back to the text box.
  await page.click('#tts-stop');
  assert.equal(await state(), 'Stopped.');
  assert.equal(await saying(), null);
  assert.equal(await page.isVisible('#tts-text'), true);
  assert.equal(await page.getAttribute('#tts-stop', 'aria-disabled'), 'true');
  assert.equal(await page.evaluate(() => CSS.highlights.has('tts-word')), false);

  // ---- Clicking a word reads on from it ----
  await page.fill('#tts-text', 'Alpha beta gamma. Delta epsilon zeta.');
  await manual();
  await page.click('#tts-play');
  await tts(() => __tts.start());
  const at = await page.evaluate(w => {
    const t = document.querySelector('#tts-view').firstChild, i = t.data.indexOf(w), r = new Range();
    r.setStart(t, i + 3); r.setEnd(t, i + 4);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, 'epsilon');
  await page.mouse.click(at.x, at.y);
  assert.equal(await saying(), 'epsilon zeta.');
  assert.equal(await text('#tts-prog'), 'Sentence 2 of 2');
  await page.click('#tts-stop');

  // ---- Sentences: the rules in the guide ----
  assert.deepEqual(await pieces('Mr. Smith met Dr. J. R. Jones at 10 a.m. on Monday. They talked.'), ['Mr. Smith met Dr. J. R. Jones at 10 a.m. on Monday.', 'They talked.']);
  assert.deepEqual(await pieces('It costs 3.5 million. Visit example.com today! Really?'), ['It costs 3.5 million.', 'Visit example.com today!', 'Really?']);
  assert.deepEqual(await pieces('Wait... what? Yes!'), ['Wait... what?', 'Yes!']);
  assert.deepEqual(await pieces('See No. 5 and fig. 3 for details. Did he agree? No. She refused.'), ['See No. 5 and fig. 3 for details.', 'Did he agree?', 'No.', 'She refused.']);
  assert.deepEqual(await pieces('"Quoted." Next sentence. The U.S. Army left.'), ['"Quoted."', 'Next sentence.', 'The U.S. Army left.']);
  assert.deepEqual(await pieces('Heading\nFirst line of text\ncarries on here.\n\n1. First item\n2. Second item'), ['Heading', 'First line of text\ncarries on here.', '1. First item', '2. Second item']);
  assert.deepEqual(await pieces('今日は晴れです。明日は雨でしょう。'), ['今日は晴れです。', '明日は雨でしょう。']);
  assert.deepEqual(await pieces('Hello.\n\n***\n\n— — —\n\nWorld \u{1F44D}. Thanks!'), ['Hello.', 'World \u{1F44D}.', 'Thanks!']);
  // A long sentence goes in pieces of at most 300 characters, cut at the last space before the limit.
  let got = await pieces('word '.repeat(100).trim() + '.');
  assert.deepEqual(got, [Array(60).fill('word').join(' '), Array(40).fill('word').join(' ') + '.']);
  // With no space at all the cut never splits an emoji (surrogate pair) or an accent from its letter.
  got = await pieces('a' + '\u{1F600}'.repeat(400));
  assert.deepEqual(got.map(p => [...p].length), [150, 150, 101]);
  assert.ok(got.every(p => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p)), 'a piece holds half an emoji');
  got = await pieces('x' + 'e\u0301'.repeat(200));
  assert.ok(got.length === 2 && got.every(p => !/^\p{M}/u.test(p)) && got.join('') === 'x' + 'e\u0301'.repeat(200), JSON.stringify(got.map(p => p.length)));
  // The selected part only.
  got = await pieces('One two three. Four five six.', () => page.evaluate(() => document.querySelector('#tts-text').setSelectionRange(4, 19)));
  assert.deepEqual(got, ['two three.', 'Four']);
  // The status said what was read.
  await page.fill('#tts-text', 'One two three. Four five six.');
  await page.evaluate(() => document.querySelector('#tts-text').setSelectionRange(4, 19));
  await page.click('#tts-play');
  assert.equal(await state(), 'Reading the selected text with Microsoft David - English (United States).');
  await page.click('#tts-stop');

  // ---- An online voice: a notice, and short pieces split at commas ----
  const clause = 'the quick brown fox jumps over the lazy dog';
  const long = Array(9).fill(clause).join(', ') + '.';
  const join = (a, b, end) => Array(b - a).fill(clause).join(', ') + end;
  await pick('Google UK English Female');
  assert.equal(await text('#tts-online'), 'Online voice: your browser sends the text to Google to be spoken. Choose a voice without the Online label to keep it on this device.');
  assert.equal(await text('#tts-chosen'), 'Selected: Google UK English Female · English (United Kingdom) · online (Google)');
  assert.equal(await page.getAttribute('#tts-play', 'aria-describedby'), 'tts-online');
  got = await pieces(long);
  assert.deepEqual(got, [join(0, 3, ','), join(3, 6, ','), join(6, 9, '.')]);
  assert.ok((await tts(() => __tts.log)).every(l => l.voice === 'Google UK English Female' && l.lang === 'en-GB'));
  // At 0.5x a piece is at most 70 characters (one clause), at 2x 280.
  const setRange = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setRange('#tts-rate', '0.5');
  got = await pieces(long);
  assert.deepEqual(got, Array(8).fill(clause + ',').concat([clause + '.']));
  await setRange('#tts-rate', '2');
  got = await pieces(long);
  assert.deepEqual(got, [join(0, 6, ','), join(6, 9, '.')]);
  assert.ok((await tts(() => __tts.log)).every(l => l.rate === 2));
  // All pieces of one sentence count as one sentence.
  await page.fill('#tts-text', long);
  await manual();
  await page.click('#tts-play');
  await tts(() => { __tts.start(); __tts.end(); });
  assert.equal(await text('#tts-prog'), 'Sentence 1 of 1');
  await page.click('#tts-stop');
  await setRange('#tts-rate', '1');
  // A voice on this device takes up to 300 characters at any speed.
  await pick('Microsoft Hazel');
  assert.equal(await text('#tts-online'), '');
  got = await pieces(long);
  assert.deepEqual(got, [join(0, 6, ','), join(6, 9, '.')]);

  // ---- Settings: shown, used, applied at once while reading, and reset ----
  await setRange('#tts-rate', '1.5');
  await setRange('#tts-pitch', '0.5');
  await setRange('#tts-vol', '40');
  assert.deepEqual([await text('#tts-rate-out'), await text('#tts-pitch-out'), await text('#tts-vol-out')], ['1.5×', '0.5', '40%']);
  assert.equal(await page.getAttribute('#tts-rate', 'aria-valuetext'), '1.5×');
  await page.fill('#tts-text', 'One two three four. Five six.');
  await manual();
  await page.click('#tts-play');
  assert.deepEqual(await lastLog(), { text: 'One two three four.', voice: 'Microsoft Hazel - English (Great Britain)', lang: 'en-GB', rate: 1.5, pitch: 0.5, volume: 0.4 });
  // Hazel reports no word lengths; the page finds the word itself.
  await tts(() => { __tts.start(); __tts.word(8); });
  assert.equal(await hl('tts-word'), 'three');
  await setRange('#tts-rate', '0.8');
  await page.waitForFunction(() => __tts.log.length === 2);
  assert.deepEqual(await lastLog(), { text: 'three four.', voice: 'Microsoft Hazel - English (Great Britain)', lang: 'en-GB', rate: 0.8, pitch: 0.5, volume: 0.4 });
  // A new voice while reading also takes over from the current word.
  await tts(() => { __tts.start(); __tts.word(6, 4); });
  await pick('Microsoft Zira');
  await page.waitForFunction(() => __tts.log.length === 3);
  assert.deepEqual(await lastLog(), { text: 'four.', voice: 'Microsoft Zira - English (United States)', lang: 'en-US', rate: 0.8, pitch: 0.5, volume: 0.4 });
  await page.click('#tts-stop');
  await page.click('#tts-reset');
  assert.deepEqual([await text('#tts-rate-out'), await text('#tts-pitch-out'), await text('#tts-vol-out')], ['1.0×', '1.0', '100%']);
  assert.deepEqual(await page.$$eval('input[type=range]', r => r.map(e => e.value)), ['1', '1', '100']);

  // ---- Finding a voice ----
  const find = async q => { await page.fill('#tts-find', q); await page.waitForTimeout(260); return voiceRows(); };
  assert.deepEqual(await find('british'), [['English (United Kingdom)', ['Microsoft Hazel - English (Great Britain)', 'Google UK English FemaleOnline', 'Google UK English MaleOnline']]]);
  assert.equal(await text('#tts-vcount'), '3 of 12 voices match.');
  assert.deepEqual(await find('francais'), [['French (France)', ['Microsoft Hortense - French (France)', 'Google françaisOnline']]]);
  assert.deepEqual(await find('Deutsch online'), [['German (Germany)', ['Google DeutschOnline']]]);
  assert.equal(await text('#tts-vcount'), '1 of 12 voices matches.');
  assert.deepEqual(await find('ja-jp'), [['Japanese (Japan)', ['Kyoko', 'Google 日本語Online']]]);
  assert.deepEqual(await find('zzz'), []);
  assert.equal(await text('#tts-vcount'), 'No voice matches your search. Try a language name, such as Spanish.');
  // The selection is kept while the filter hides it.
  assert.equal(await text('#tts-chosen'), 'Selected: Microsoft Zira - English (United States) · English (United States) · on this device');
  assert.equal((await find('')).reduce((n, g) => n + g[1].length, 0), 12);
  assert.equal(await text('#tts-vcount'), '12 voices in 4 languages, 7 of them online');
  // A megabyte pasted into the search box is cut to 100 characters and does not freeze the page.
  await page.evaluate(v => navigator.clipboard.writeText(v), 'x'.repeat(1 << 20));
  await page.focus('#tts-find');
  let t0 = Date.now();
  await page.keyboard.press('Control+V');
  assert.equal((await page.inputValue('#tts-find')).length, 100);
  await page.waitForFunction(() => /^No voice matches/.test(document.querySelector('#tts-vcount').textContent));
  assert.ok(Date.now() - t0 < 2000, `search paste took ${Date.now() - t0} ms`);
  await page.fill('#tts-find', '');
  // The count is announced once, after typing stops, not on every key.
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__vc = 0;
    new MutationObserver(() => window.__vc++).observe(document.querySelector('#tts-vcount'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#tts-find').pressSequentially('british', { delay: 30 });
  await page.waitForFunction(() => document.querySelector('#tts-vcount').textContent === '3 of 12 voices match.');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__vc), 1);
  await page.fill('#tts-find', '');
  await page.waitForFunction(() => document.querySelector('#tts-vcount').textContent === '12 voices in 4 languages, 7 of them online');

  // ---- Keyboard: from the box to Play, Space to pause, arrows to change voice ----
  await page.fill('#tts-text', 'Keyboard test one. Keyboard test two.');
  await manual();
  await page.focus('#tts-text');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tts-clear');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tts-play');
  await page.keyboard.press('Enter');
  assert.equal(await saying(), 'Keyboard test one.');
  await page.keyboard.press('Space');
  assert.equal(await state(), 'Paused.');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.equal(await state(), 'Stopped.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tts-stop');
  await page.focus('#tts-vlist input:checked');
  await page.keyboard.press('ArrowDown');
  assert.equal(await checked(), 'Google US English');
  assert.match(await text('#tts-online'), /^Online voice: your browser sends the text to Google/);
  await page.keyboard.press('ArrowUp');
  assert.equal(await checked(), 'Microsoft Zira - English (United States)');
  assert.equal(await text('#tts-online'), '');
  const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(focusRing, 'solid');

  // ---- Errors ----
  // Nothing to read: the box is marked and points at the message.
  await page.click('#tts-clear');
  assert.equal(await text('#tts-count'), '0 characters');
  await page.click('#tts-play');
  assert.equal(await text('#tts-text-err'), 'There is nothing to read yet. Type or paste some text into the box.');
  assert.equal(await page.getAttribute('#tts-text', 'aria-invalid'), 'true');
  assert.match(await page.getAttribute('#tts-text', 'aria-describedby'), /\btts-text-err\b/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tts-text');
  await page.keyboard.type('... !!! ???');
  assert.equal(await page.getAttribute('#tts-text', 'aria-invalid'), null);
  assert.equal(await page.isVisible('#tts-text-err'), false);
  await page.click('#tts-play');
  assert.equal(await text('#tts-text-err'), 'This text has no words a voice could read, only spaces and punctuation.');
  assert.equal(await page.getAttribute('#tts-text', 'aria-invalid'), 'true');
  assert.equal(await saying(), null);
  // More than 1,000,000 characters, pasted: the count, a message, nothing read; a selected part can be.
  const big = 'The quick brown fox jumps over the lazy dog. '.repeat(22223);
  await page.evaluate(v => navigator.clipboard.writeText(v), big);
  await page.focus('#tts-text');
  await page.keyboard.press('Control+A');
  t0 = Date.now();
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => document.querySelector('#tts-count').textContent === '1,000,035 characters');
  assert.ok(Date.now() - t0 < 3000, `a 1 MB paste took ${Date.now() - t0} ms`);
  assert.equal(await text('#tts-text-err'), 'This text has 1,000,035 characters, more than the 1,000,000 this page reads at a time. Select a part of it and press Play, or shorten it.');
  assert.equal(await page.getAttribute('#tts-text', 'aria-invalid'), 'true');
  await manual();
  await page.click('#tts-play');
  assert.equal(await saying(), null);
  assert.equal(await state(), 'Stopped.');
  await page.evaluate(() => document.querySelector('#tts-text').setSelectionRange(0, 90));
  await page.click('#tts-play');
  assert.equal(await saying(), 'The quick brown fox jumps over the lazy dog.');
  assert.equal(await text('#tts-prog'), 'Sentence 1 of 2');
  assert.equal(await page.getAttribute('#tts-text', 'aria-invalid'), null);
  await page.click('#tts-stop');
  // Just under the limit: 900,000 characters start reading within a second or two.
  await page.evaluate(v => { const ta = document.querySelector('#tts-text'); ta.value = v; ta.dispatchEvent(new Event('input')); }, big.slice(0, 900000));
  await page.waitForFunction(() => document.querySelector('#tts-count').textContent === '900,000 characters');
  t0 = Date.now();
  await page.click('#tts-play');
  assert.equal(await saying(), 'The quick brown fox jumps over the lazy dog.');
  assert.ok(Date.now() - t0 < 2500, `900,000 characters took ${Date.now() - t0} ms to start`);
  assert.equal(await text('#tts-prog'), 'Sentence 1 of 20,000');
  await page.click('#tts-next');
  assert.equal(await text('#tts-prog'), 'Sentence 2 of 20,000');
  await page.click('#tts-stop');
  // Speech errors keep the place and say what to do.
  await page.fill('#tts-text', 'First sentence. Second sentence.');
  await manual();
  await page.click('#tts-play');
  await tts(() => { __tts.start(); __tts.end(); });
  await tts(() => __tts.error('network'));
  assert.equal(await text('#tts-error'), 'The online voice could not reach its server. Check your connection, or choose a voice without the Online label, then press Resume.');
  assert.equal(await state(), 'Paused.');
  assert.equal(await text('#tts-play'), 'Resume');
  await page.click('#tts-play');
  assert.equal(await text('#tts-error'), '');
  assert.equal(await saying(), 'Second sentence.');
  await tts(() => __tts.error('not-allowed'));
  assert.equal(await text('#tts-error'), 'The browser did not let the page speak. Press Resume to try again.');
  await page.click('#tts-play');
  await tts(() => __tts.error('something-new'));
  assert.equal(await text('#tts-error'), 'The voice stopped with an error (something-new). Choose another voice and press Resume.');
  await page.click('#tts-play');
  await tts(() => __tts.error('interrupted'));
  assert.equal(await state(), 'Paused: something else interrupted the speech.');
  assert.equal(await text('#tts-error'), '');
  await page.click('#tts-stop');
  // An utterance the engine drops silently is asked for once more.
  await tts(() => { __tts.manual = false; __tts.log.length = 0; __tts.dropNext = 1; });
  await page.fill('#tts-text', 'Dropped once.');
  await page.click('#tts-play');
  await page.waitForFunction(() => document.querySelector('#tts-state').textContent === 'Finished reading.', null, { timeout: 6000 });
  assert.deepEqual(await tts(() => __tts.log.map(l => l.text)), ['Dropped once.', 'Dropped once.']);

  // ---- Opening and dropping text files ----
  const openFile = async name => {
    await page.evaluate(() => { document.querySelector('#tts-file-ok').textContent = ''; document.querySelector('#tts-file-err').textContent = ''; });
    await page.setInputFiles('#tts-file', path.join(fixtures, name));
    await page.waitForFunction(() => document.querySelector('#tts-file-ok').textContent || document.querySelector('#tts-file-err').textContent);
  };
  await openFile('notepad-utf8-bom.txt');
  assert.equal(await page.inputValue('#tts-text'), 'Hello from Notepad.\nSecond line, café.\n');
  assert.equal(await text('#tts-file-ok'), 'Opened notepad-utf8-bom.txt: 39 characters.');
  await openFile('powershell-utf16.txt');
  assert.equal(await page.inputValue('#tts-text'), 'Grüße aus PowerShell. \u{1F44B}\n');
  await openFile('utf16-be.txt');
  assert.equal(await page.inputValue('#tts-text'), 'Big-endian text.');
  await openFile('legacy-1252.txt');
  assert.equal(await page.inputValue('#tts-text'), 'Café naïve – 5 €');
  assert.equal(await text('#tts-file-ok'), 'Opened legacy-1252.txt: 16 characters. It was not valid UTF-8, so it was read as Windows-1252 text.');
  // A UTF-8 byte order mark in front of Windows-1252 text is not read as "ï»¿".
  await openFile('bom-then-1252.txt');
  assert.equal(await page.inputValue('#tts-text'), 'Crème brûlée');
  await openFile('looks-like-pdf.txt');
  assert.equal(await page.inputValue('#tts-text'), '%PDF-1.4 is the version line of the oldest file in my notes.\n');
  for (const [name, msg] of [['report.pdf', 'report.pdf is a PDF. Copy the text from your PDF viewer and paste it here.'],
    ['letter.docx', 'letter.docx is a Word document or another compressed file. Copy its text and paste it here, or save it as plain text (.txt).'],
    ['picture.png', 'picture.png does not look like a text file. Open a plain text (.txt) file.'],
    ['blank.txt', 'blank.txt is empty.']]) {
    await openFile(name);
    assert.equal(await text('#tts-file-err'), msg);
    assert.equal(await page.inputValue('#tts-text'), '%PDF-1.4 is the version line of the oldest file in my notes.\n', `${name} left the text alone`);
  }
  assert.equal(await page.getAttribute('#tts-open', 'aria-describedby'), 'tts-file-err');
  await page.setInputFiles('#tts-file', { name: 'huge.txt', mimeType: 'text/plain', buffer: Buffer.alloc(4100000, 'a') });
  await page.waitForFunction(() => /huge\.txt/.test(document.querySelector('#tts-file-err').textContent));
  assert.equal(await text('#tts-file-err'), 'huge.txt is 3.9 MB, more than the 1,000,000 characters this page reads at a time.');
  await page.setInputFiles('#tts-file', { name: 'long.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1500000, 'b') });
  await page.waitForFunction(() => /long\.txt/.test(document.querySelector('#tts-file-err').textContent));
  assert.equal(await text('#tts-file-err'), 'long.txt has 1,500,000 characters, more than the 1,000,000 this page reads at a time.');
  // A file dropped on the box opens, without its byte order mark.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['\uFEFFDropped text, with a BOM.'], 'drop.txt', { type: 'text/plain' }));
    const box = document.querySelector('#tts-text');
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#tts-file-ok').textContent === 'Opened drop.txt: 25 characters.');
  assert.equal(await page.inputValue('#tts-text'), 'Dropped text, with a BOM.');
  // Opening a file while reading stops the reading first.
  await manual();
  await page.click('#tts-play');
  assert.equal(await saying(), 'Dropped text, with a BOM.');
  await page.setInputFiles('#tts-file', path.join(fixtures, 'utf16-be.txt'));
  await page.waitForFunction(() => document.querySelector('#tts-file-ok').textContent === 'Opened utf16-be.txt: 16 characters.');
  assert.equal(await state(), 'Stopped.');
  assert.equal(await page.isVisible('#tts-text'), true);

  // ---- The state line is a live region written once per change, not per sentence ----
  await tts(() => { __tts.manual = false; });
  await page.fill('#tts-text', 'One. Two. Three. Four.');
  await page.evaluate(() => {
    window.__sc = [];
    new MutationObserver(() => window.__sc.push(document.querySelector('#tts-state').textContent)).observe(document.querySelector('#tts-state'), { childList: true, characterData: true, subtree: true });
  });
  await page.click('#tts-play');
  await page.waitForFunction(() => document.querySelector('#tts-state').textContent === 'Finished reading.', null, { timeout: 6000 });
  assert.deepEqual(await page.evaluate(() => window.__sc), ['Reading with Microsoft Zira - English (United States).', 'Finished reading.']);

  // ---- Leaving the page stops the voice; coming back with Back counts again ----
  await manual();
  await page.click('#tts-play');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await saying(), null);
  assert.equal(await text('#tts-play'), 'Play');
  assert.equal(await page.isVisible('#tts-text'), true);
  await page.evaluate(() => { document.querySelector('#tts-text').value = 'Restored by the browser.'; document.querySelector('#tts-rate').value = '1.7'; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await text('#tts-count'), '24 characters');
  assert.equal(await text('#tts-rate-out'), '1.7×');

  // ---- An online voice that goes quiet: after 20 seconds the page says so ----
  await page.evaluate(() => { document.querySelector('#tts-rate').value = '1'; document.querySelector('#tts-rate').dispatchEvent(new Event('input')); });
  await pick('Google US English');
  await tts(() => { __tts.manual = false; __tts.stallNext = true; });
  await page.fill('#tts-text', 'This online voice will go quiet.');
  await page.click('#tts-play');
  assert.equal(await text('#tts-stall'), '');
  await page.waitForFunction(() => document.querySelector('#tts-stall').textContent, null, { timeout: 25000 });
  assert.equal(await text('#tts-stall'), 'Nothing has been heard for 20 seconds. Online voices sometimes stop without warning: press Next to carry on, or Stop and choose a voice without the Online label.');
  await page.click('#tts-stop');
  assert.equal(await text('#tts-stall'), '');
  await pick('Microsoft David');

  // ---- A text in a script the voice does not read: a hint naming voices that do ----
  await page.fill('#tts-text', '日本語のテキストです。');
  await manual();
  await page.click('#tts-play');
  assert.equal(await text('#tts-script'), 'This text is mostly in Japanese, which Microsoft David - English (United States) may skip or read badly. Voices for it: Kyoko, Google 日本語 (online).');
  await pick('Kyoko');
  assert.equal(await text('#tts-script'), '');
  await page.click('#tts-stop');
  await page.fill('#tts-text', 'Привет, как дела?');
  await page.click('#tts-play');
  assert.equal(await text('#tts-script'), 'This text is mostly in Cyrillic script, which Kyoko may skip or read badly. This browser has no voice for it.');
  await page.click('#tts-stop');
  assert.equal(await text('#tts-script'), '');
  await page.fill('#tts-text', 'Plain English text, with one word of 日本語.');
  await page.click('#tts-play');
  assert.equal(await text('#tts-script'), 'This text is mostly in the Latin alphabet, which Kyoko may skip or read badly. Voices for it: Microsoft David - English (United States), Microsoft Zira - English (United States), Microsoft Hazel - English (Great Britain).');
  await page.click('#tts-stop');
  await pick('Microsoft David');

  // ---- What the page says about itself ----
  const faq = async q => page.locator('.faq details', { hasText: q }).locator('.faq-answer').textContent();
  assert.match(await faq('Is my text uploaded or saved anywhere?'), /The one exception is a voice marked Online, for which your browser itself sends the text to Google or Microsoft/);
  const guide = (await page.locator('.prose').textContent()).replace(/\s+/g, ' ');
  assert.match(guide, /up to 1,000,000 characters at a time/);
  assert.match(guide, /The page starts with a voice on your device and shows a notice whenever an online voice is chosen\./);
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/image-to-text/', '/speaker-test/']);
  for (const href of links) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), `${href} is linked from the guide but is not a tool page`);
  }

  // ---- Other browsers' voice lists ----
  const other = async (hash, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
    const p = await ctx.newPage();
    const outside = [];
    await p.route('**/*', r => { if (!r.request().url().startsWith(base) && !/^(data|blob):/.test(r.request().url())) { outside.push(r.request().url()); return r.abort(); } return r.continue(); });
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.addInitScript(fakeSpeech);
    await p.goto(url + hash);
    return { ctx, p, errors, outside };
  };
  // British English browser: Hazel first, and her group first.
  let o = await other('#voices=A', { locale: 'en-GB' });
  assert.equal(await o.p.$eval('#tts-vlist input:checked', i => i.closest('label').textContent), 'Microsoft Hazel - English (Great Britain)');
  assert.deepEqual(await o.p.$$eval('.tts-glabel', h => h.map(e => e.textContent)), ['English (United Kingdom)', 'English (United States)', 'French (France)', 'German (Germany)', 'Japanese (Japan)']);
  await o.ctx.close();
  // German browser, but the only German voice is online: the page starts with a voice on this device.
  o = await other('#voices=A', { locale: 'de-DE' });
  assert.equal(await o.p.$eval('#tts-vlist input:checked', i => i.closest('label').textContent), 'Microsoft David - English (United States)');
  assert.equal(await o.p.textContent('#tts-online'), '');
  assert.equal(await o.p.$eval('.tts-glabel', h => h.textContent), 'German (Germany)');
  await o.ctx.close();
  // Only online voices (Chrome on Linux): one is chosen, and the notice says there is no local one.
  o = await other('#voices=B');
  assert.equal(await o.p.$eval('#tts-vlist input:checked', i => i.closest('label').textContent), 'Google US EnglishOnline');
  assert.equal(await o.p.textContent('#tts-online'), 'Online voice: your browser sends the text to Google to be spoken. This browser offers no voice that runs on this device.');
  await o.ctx.close();
  // Safari calls every voice the default: Samantha, not Albert or Bad News.
  o = await other('#voices=C');
  assert.equal(await o.p.$eval('#tts-vlist input:checked', i => i.closest('label').textContent), 'Samantha');
  await o.ctx.close();
  // Android's en_US and Firefox's eng-US-f000 are grouped as English (United States); a voice with no language goes last.
  o = await other('#voices=D');
  assert.deepEqual(await o.p.$$eval('.tts-group', gs => gs.map(g => [g.querySelector('.tts-glabel').textContent, g.querySelectorAll('.tts-voice').length])),
    [['English (United States)', 2], ['English (United Kingdom)', 1], ['German (Germany)', 1], ['Other', 1]]);
  await o.p.click('#tts-play');
  await o.p.waitForFunction(() => __tts.log.length > 0);
  assert.equal(await o.p.evaluate(() => __tts.log[0].lang), 'en-US');
  await o.ctx.close();
  // Voices that arrive late (Chrome) fill the list without a "no voices" message.
  o = await other('#voices=A&late=600');
  assert.equal(await o.p.isVisible('#tts-vpick'), false);
  await o.p.waitForFunction(() => document.querySelectorAll('#tts-vlist .tts-voice').length === 12);
  assert.equal(await o.p.$eval('#tts-vlist input:checked', i => i.closest('label').textContent), 'Microsoft David - English (United States)');
  await o.p.waitForTimeout(3300);
  assert.equal(await o.p.textContent('#tts-novoice'), '');
  await o.ctx.close();
  // No voices at all: the page says so after a few seconds; Play tries the browser's own voice.
  o = await other('#voices=F');
  await o.p.waitForFunction(() => document.querySelector('#tts-novoice').textContent, null, { timeout: 5000 });
  assert.match(await o.p.textContent('#tts-novoice'), /^Your browser lists no voices, so the page cannot tell which voice it will use or whether that voice is online\./);
  assert.equal(await o.p.isVisible('#tts-vpick'), false);
  await o.p.click('#tts-play');
  assert.equal(await o.p.textContent('#tts-state'), 'Reading with the browser’s own voice.');
  await o.p.waitForFunction(() => __tts.log.length > 0);
  assert.equal(await o.p.evaluate(() => __tts.log[0].voice), null);
  await o.p.click('#tts-stop');
  await o.ctx.close();
  // The real headless engine: no voices, and speaking fails; the page explains and keeps the text.
  o = await other('#real=1');
  await o.p.waitForFunction(() => document.querySelector('#tts-novoice').textContent, null, { timeout: 5000 });
  await o.p.click('#tts-play');
  await o.p.waitForFunction(() => document.querySelector('#tts-error').textContent, null, { timeout: 8000 });
  assert.equal(await o.p.textContent('#tts-error'), 'The browser could not speak: it has no working voice. Add a voice in your system’s speech settings and restart the browser.');
  assert.equal(await o.p.textContent('#tts-state'), 'Paused.');
  assert.deepEqual(o.errors, []);
  await o.ctx.close();
  // No Web Speech API at all.
  o = await other('#nosynth=1');
  assert.match(await o.p.textContent('#tts-novoice'), /^This browser cannot read text aloud: it has no speech synthesis/);
  await o.p.click('#tts-play');
  assert.match(await o.p.textContent('#tts-error'), /^This browser cannot read text aloud/);
  assert.deepEqual(o.errors, []);
  await o.ctx.close();
  // Without the CSS Highlight API (older Safari and Firefox) the word is a <mark>.
  o = await other('#nohl=1');
  await o.p.fill('#tts-text', 'Hello world. Again.');
  await o.p.evaluate(() => { __tts.manual = true; });
  await o.p.click('#tts-play');
  await o.p.evaluate(() => { __tts.start(); __tts.word(6, 5); });
  assert.equal(await o.p.textContent('#tts-view .tts-cur'), 'Hello world.');
  assert.equal(await o.p.textContent('#tts-view mark'), 'world');
  assert.equal(await o.p.textContent('#tts-view'), 'Hello world. Again.');
  await o.p.evaluate(() => __tts.end());
  assert.equal(await o.p.textContent('#tts-view .tts-cur'), 'Again.');
  assert.equal(await o.p.locator('#tts-view mark').count(), 0);
  await o.p.click('#tts-stop');
  assert.deepEqual(o.errors, []);
  await o.ctx.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', e => perr.push(e.message));
  await pp.route('**/*', r => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await pp.addInitScript(fakeSpeech);
  await pp.goto(url);
  for (const id of ['#tts-play', '#tts-stop', '#tts-prev', '#tts-next', '#tts-open', '#tts-clear', '#tts-reset']) {
    const b = await pp.locator(id).boundingBox();
    assert.ok(b.height >= 44, `${id} is ${b.height}px tall`);
  }
  const row = await pp.locator('#tts-vlist label').nth(1).boundingBox();
  assert.ok(row.height >= 44, `voice rows are ${row.height}px tall`);
  for (const id of ['#tts-text', '#tts-find']) assert.ok(parseFloat(await pp.$eval(id, e => getComputedStyle(e).fontSize)) >= 16, `${id} text under 16px`);
  await pp.locator('#tts-vlist label', { hasText: 'Kyoko' }).tap();
  assert.equal(await pp.$eval('#tts-vlist input:checked', i => i.closest('label').textContent), 'Kyoko');
  await pp.fill('#tts-text', 'こんにちは。元気ですか。');
  await pp.evaluate(() => { __tts.manual = true; });
  await pp.tap('#tts-play');
  assert.equal(await pp.evaluate(() => __tts.say()), 'こんにちは。');
  // Japanese has no spaces: the word is found with the voice's language rules.
  await pp.evaluate(() => { __tts.start(); __tts.end(); __tts.start(); __tts.word(0); });
  assert.equal(await pp.evaluate(() => [...CSS.highlights.get('tts-word')][0].toString()), '元気');
  await pp.tap('#tts-play');
  assert.equal(await pp.textContent('#tts-state'), 'Paused.');
  for (const width of [320, 340, 390, 540]) {
    await pp.setViewportSize({ width, height: 800 });
    assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `sideways scroll at ${width}px`);
    // No button label is cut off or wrapped onto a second line.
    const bad = await pp.$$eval('.tts .btn', bs => bs.filter(b => b.getClientRects().length).filter(b => {
      const r = document.createRange();
      r.selectNodeContents(b);
      const lines = new Set([...r.getClientRects()].map(x => Math.round(x.top))).size;
      return lines > 1 || b.scrollWidth > b.clientWidth + 1;
    }).map(b => b.id));
    assert.deepEqual(bad, [], `buttons cut off at ${width}px`);
    const fits = await pp.$eval('#tts-find', el => {
      const cs = getComputedStyle(el), c = document.createElement('canvas').getContext('2d');
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return c.measureText(el.placeholder).width <= el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });
    assert.ok(fits, `the search placeholder is cut off at ${width}px`);
  }
  await pp.tap('#tts-stop');
  assert.deepEqual(perr, []);
  await phone.close();
};
module.exports.fakeSpeech = fakeSpeech;
