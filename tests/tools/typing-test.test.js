const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Scores for the book passages come from tests/fixtures/typing-test/expected.py,
// which replays the same keystrokes with its own implementation of the rules
// in the guide. Those scenarios run on Playwright's fake clock, so every key
// lands at an exact time and a 5-minute test takes no real time.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const vendor = path.join(__dirname, '..', '..', 'assets', 'vendor', 'common-words');
  const wordLines = fs.readFileSync(path.join(vendor, 'words.txt'), 'utf8').split('\n').filter(Boolean);
  const list = new Set(wordLines);
  const browser = page.context().browser();

  const text = (sel, p = page) => p.locator(sel).textContent();
  const checkedVal = (name, p = page) => p.$eval(`input[name="${name}"]:checked`, el => el.value);
  const hash = (p = page) => p.evaluate(() => location.hash);
  const words = (p = page) => p.$$eval('#tt-text .tt-w', els => els.map(e => e.textContent));
  const value = (p = page) => p.inputValue('#tt-input');
  const ready = (p = page) => p.waitForFunction(() => document.getElementById('tt-box').classList.contains('is-ready') &&
    document.querySelectorAll('#tt-text .tt-w').length > 50, null, { timeout: 10000 });
  const active = (p = page) => p.evaluate(() => document.activeElement && document.activeElement.id);
  const rows = (sel, p = page) => p.$$eval(sel + ' tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent)));
  // Where the caret is: "word:letter:the letter it stands before" ('' after the last letter).
  const caret = (p = page) => p.evaluate(() => {
    const c = document.querySelectorAll('#tt-text .tt-car');
    if (c.length !== 1) return c.length + ' carets';
    const w = c[0].closest('.tt-w');
    return Array.from(document.querySelectorAll('#tt-text .tt-w')).indexOf(w) + ':' + Array.from(w.children).indexOf(c[0]) + ':' + c[0].textContent;
  });
  // Whether the caret's line is inside the three lines shown.
  const caretInView = (p = page) => p.evaluate(() => {
    const t = document.getElementById('tt-text').getBoundingClientRect();
    const c = document.querySelector('#tt-text .tt-car').getBoundingClientRect();
    return c.top >= t.top - 1 && c.bottom <= t.bottom + 1;
  });
  // The screen reader message, without the no-break space that marks a repeat.
  const sr = (p = page) => text('#tt-sr', p).then(t => t.replace(/\u00a0$/, ''));
  const BULK_NOTE = 'Text added in one go, such as a paste from a phone keyboard, is not counted: type it yourself.';
  const PASTE_NOTE = 'Pasting is turned off in the typing test: type the text yourself.';

  // ---- The common words: the most frequent words in English books ----
  // tests/fixtures/typing-test/build_words.py makes words.txt from orgtre's list
  // of the Google Books Ngram Corpus: the first 1,000 words, in frequency order,
  // less capitalised words (but I) and American spellings.
  assert.equal(wordLines.length, 979);
  assert.equal(list.size, 979, 'no word is in the list twice');
  assert.equal(wordLines.slice(0, 20).join(' '), 'the of and to a in that is for I it was as not with he on you be his');
  assert.deepEqual(wordLines.filter(x => !/^(?:[a-z]+|I)$/.test(x)), [], 'lower-case words and I only');
  const american = ['toward', 'program', 'percent', 'center', 'organization', 'behavior', 'color', 'labor', 'favor', 'honor',
    'gray', 'defense', 'theater', 'realize', 'recognize', 'analyze', 'license', 'judgment'];
  assert.deepEqual(american.filter(x => list.has(x)), [], 'no American spellings');
  assert.ok(list.has('towards'), 'the British spelling of toward is there');
  const meanLength = wordLines.reduce((a, x) => a + x.length, 0) / wordLines.length;
  assert.ok(meanLength > 5.5 && meanLength < 5.7, `mean word length ${meanLength.toFixed(2)}: keep it near 5.6 so scores stay comparable`);
  const readme = await (await page.request.get(base + '/assets/vendor/common-words/README.txt')).text();
  for (const s of ['Google Books Ngram Corpus, list compiled by orgtre', 'CC BY 3.0', 'f7f63aa08f0bb2f7f654cddff3a7ced4968b27887b2c0e7cd4b4d108221e197d',
    'tests/fixtures/typing-test/build_words.py', '979 words']) {
    assert.ok(readme.includes(s), `the word list's README gives ${s}`);
  }
  assert.match(await (await page.request.get(base + '/assets/vendor/common-words/LICENSE.txt')).text(), /^Creative Commons Legal Code\s+Attribution 3\.0 Unported/);

  // ---- Defaults: 1 minute of common words from the vendored list ----
  await open();
  await ready();
  assert.ok((await text('.lede')).startsWith('Take a 30-second to 5-minute typing test'), 'the description names every length offered');
  assert.equal(await checkedVal('tt-len'), '60');
  assert.equal(await checkedVal('tt-mode'), 'words');
  assert.equal(await hash(), '');
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await text('#tt-acc'), '–');
  assert.equal(await page.locator('#tt-book-field').isVisible(), false);
  assert.equal(await text('#tt-source'), 'Random words from 979 of the 1,000 most common words in English books (Google Books Ngram Corpus, list compiled by orgtre, CC BY 3.0).');
  // The guide says what the list is and links it and its licence; the old list is gone.
  assert.match(await text('.prose'), /Common words are drawn at random from 979 of the 1,000 most frequent words\s+in English books of the 2010s, as counted in the Google Books Ngram Corpus/);
  assert.equal(await page.locator('.prose a[href="https://github.com/orgtre/google-books-ngram-frequency"]').textContent(), 'list by orgtre');
  assert.equal(await page.locator('.prose a[href="https://creativecommons.org/licenses/by/3.0/"]').textContent(), 'CC BY 3.0');
  assert.ok(!(await page.content()).includes('random-words'), 'the page does not use the random-words list');
  assert.equal(await text('#tt-prompt'), 'Click or tap here, then start typing');
  assert.equal(await text('#tt-hist'), 'No tests yet.');
  assert.equal(await page.locator('#tt-result').isVisible(), false);
  let w = await words();
  assert.ok(w.length >= 100, `only ${w.length} words ready`);
  assert.ok(w.every(x => list.has(x)), 'every word comes from the word list');
  assert.ok(w.every((x, i) => i === 0 || x !== w[i - 1]), 'no word follows itself');
  // The clock waits for the first key.
  await page.waitForTimeout(1100);
  assert.equal(await text('#tt-time'), '1:00');

  // ---- Keyboard only: Tab reaches the text box, typing starts the test ----
  await page.focus('input[name="tt-mode"][value="words"]');
  await page.keyboard.press('Tab'); // the hidden book list is skipped
  assert.equal(await active(), 'tt-input');
  await page.keyboard.type(w[0] + ' ' + w[1]);
  assert.equal(await sr(), 'Test 1 started: 1 minute.');
  assert.equal(await page.locator('#tt-text .tt-w').nth(0).locator('.tt-ok').count(), w[0].length);
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-ok').count(), w[1].length);
  assert.equal(await page.locator('#tt-text .tt-w .tt-bad, #tt-text .tt-w .tt-extra').count(), 0);
  assert.equal(await text('#tt-acc'), '100.0%');
  assert.equal(await caret(), `1:${w[1].length}:`, 'the caret follows the last letter typed');
  // The caret cannot be moved back: a click in the text, arrow keys and Home
  // do nothing, typing goes on at the end.
  const tb = await page.locator('#tt-box').boundingBox();
  await page.mouse.click(tb.x + 20, tb.y + tb.height / 2);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Home');
  await page.keyboard.type('#');
  assert.equal(await value(), w[0] + ' ' + w[1] + '#');
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-extra').textContent(), '#');
  assert.equal(await caret(), `1:${w[1].length + 1}:`);
  const keysSoFar = (w[0] + ' ' + w[1]).length + 1;
  const tenths = Math.floor((2000 * (keysSoFar - 1) + keysSoFar) / (2 * keysSoFar));
  assert.equal(await text('#tt-acc'), `${Math.floor(tenths / 10)}.${tenths % 10}%`);
  // Backspace into the previous word, then a space before the word ends.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.equal(await value(), w[0] + ' ' + w[1].slice(0, -2));
  assert.equal(await caret(), `1:${w[1].length - 2}:${w[1][w[1].length - 2]}`, 'the caret stands before the next letter');
  await page.keyboard.type(' ');
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-miss').count(), 2, 'the two letters skipped are marked');
  assert.equal(await caret(), `2:0:${w[2][0]}`);
  // Two wrong letters in the next word, then Backspace back into this one:
  // the next word is shown as not typed again.
  await page.keyboard.type('##');
  assert.equal(await page.locator('#tt-text .tt-w').nth(2).locator('.tt-bad').count(), 2);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  assert.equal(await page.locator('#tt-text .tt-w').nth(2).locator('.tt-l').count(), 0, 'the word after the caret is plain again');
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-miss').count(), 0, 'a word being typed has no skipped letters');
  assert.equal(await caret(), `1:${w[1].length - 2}:${w[1][w[1].length - 2]}`);
  await page.keyboard.type(' ');
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-miss').count(), 2);
  // Esc throws the test away and deals new words.
  await page.keyboard.press('Escape');
  assert.equal(await value(), '');
  assert.equal(await sr(), 'Test stopped. A new test is ready.');
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await text('#tt-acc'), '–');
  assert.equal(await active(), 'tt-input');
  const w2 = await words();
  assert.notDeepEqual(w2.slice(0, 12), w.slice(0, 12), 'Esc gives new words');
  assert.equal(await text('#tt-hist'), 'No tests yet.');
  // Tab then Enter restarts too.
  await page.keyboard.type(w2[0]);
  await page.keyboard.press('Tab');
  assert.equal(await active(), 'tt-restart');
  await page.keyboard.press('Enter');
  assert.equal(await active(), 'tt-input');
  assert.equal(await value(), '');
  assert.equal(await sr(), 'Test stopped. A new test is ready.');
  // Esc twice before typing: new words each time, and the second message,
  // the same as the first, still changes so that it is read out again.
  await page.keyboard.press('Escape');
  const said = await page.locator('#tt-sr').textContent();
  assert.equal(said, 'A new test is ready.');
  w = await words();
  await page.keyboard.press('Escape');
  assert.equal(await sr(), 'A new test is ready.');
  assert.notEqual(await page.locator('#tt-sr').textContent(), said, 'a repeated message must change to be read out');
  assert.notDeepEqual((await words()).slice(0, 12), w.slice(0, 12), 'Esc before typing deals new words');
  w = await words();

  // ---- A letter pressed with nothing focused goes into the box ----
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press(w[0][0]);
  assert.equal(await active(), 'tt-input');
  assert.equal(await value(), w[0][0]);
  assert.equal(await sr(), 'Test 1 started: 1 minute.');
  // Esc starts again when nothing has the focus too, and from the tool's buttons.
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape');
  assert.equal(await value(), '');
  assert.equal(await sr(), 'Test stopped. A new test is ready.');
  assert.equal(await active(), 'tt-input');
  w = await words();
  await page.keyboard.type(w[0]);
  await page.focus('#tt-clear');
  await page.keyboard.press('Escape');
  assert.equal(await value(), '');
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await active(), 'tt-input');

  // ---- Paste is refused, even a megabyte of it ----
  // beforeinput cancels it. The paste event itself is not cancelled: that
  // would mark the field as one that blocks pasting (Lighthouse Best Practices).
  await page.evaluate(() => {
    window.__paste = null;
    document.getElementById('tt-input').addEventListener('paste', e => { window.__paste = e; });
  });
  await page.evaluate(() => navigator.clipboard.writeText('paste '.repeat(175000)));
  await page.focus('#tt-input');
  const tp = Date.now();
  await page.keyboard.press('Control+V');
  assert.ok(Date.now() - tp < 3000, 'a megabyte paste is refused at once');
  assert.equal(await value(), '');
  assert.equal(await text('#tt-note'), 'Pasting is turned off in the typing test: type the text yourself.');
  assert.equal(await page.evaluate(() => window.__paste === null ? 'no paste event' : window.__paste.defaultPrevented), false, 'the paste event is not cancelled');
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await page.evaluate(() => document.querySelector('#tt-box').classList.contains('is-ready')), true);

  // ---- A megabyte added in one go some other way is refused at once ----
  const flood = await page.evaluate(() => {
    const i = document.getElementById('tt-input');
    const t0 = performance.now();
    i.value = 'flood word '.repeat(100000);
    i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return { ms: performance.now() - t0, len: i.value.length };
  });
  assert.ok(flood.ms < 3000, `refusing a megabyte took ${Math.round(flood.ms)} ms`);
  assert.equal(flood.len, 0);
  assert.equal(await text('#tt-note'), BULK_NOTE);
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await text('#tt-error'), '');

  // ---- Past 20,000 characters (only a script gets there) the rest is cut, and the box says why ----
  const grow = await page.evaluate(() => {
    const i = document.getElementById('tt-input');
    const t0 = performance.now();
    for (let k = 0; k < 220; k++) {
      i.value += 'flood word '.repeat(9);
      i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
    return { ms: performance.now() - t0, len: i.value.length };
  });
  assert.ok(grow.ms < 8000, `typing 20,000 characters took ${Math.round(grow.ms)} ms`);
  assert.equal(grow.len, 20000);
  assert.equal(await text('#tt-error'), 'Only the first 20,000 characters can be typed in one test; the rest was cut off.');
  assert.equal(await page.getAttribute('#tt-input', 'aria-invalid'), 'true');
  assert.deepEqual((await page.getAttribute('#tt-input', 'aria-describedby')).split(' ').sort(), ['tt-error', 'tt-hint']);
  // 'flood word ' 1,818 times and 'fl': 3,637 words typed, and 60 more ready.
  assert.ok((await page.locator('#tt-text .tt-w').count()) >= 3637 + 60, 'enough words were added for the flood');
  // One word of 19,999 letters, as a key held down for minutes types: each key
  // stays quick because only 20 extra letters are drawn, and an emoji at the
  // limit is not cut in half.
  await page.click('#tt-restart');
  const held = await page.evaluate(() => {
    const i = document.getElementById('tt-input');
    for (let k = 0; k < 202; k++) {
      i.value += 'a'.repeat(99);
      i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
    const t0 = performance.now();
    for (let k = 0; k < 30; k++) {
      i.value = i.value.slice(0, -1);
      i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      i.value += 'a';
      i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
    const ms = (performance.now() - t0) / 60;
    i.value += 'a';
    i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    i.value += '\u{1F600}tail';
    i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const word = document.querySelector('#tt-text .tt-w');
    return {
      ms, spans: word.querySelectorAll('.tt-l').length, text: word.textContent,
      last: word.lastElementChild.className, before: word.lastElementChild.previousElementSibling.textContent
    };
  });
  assert.ok(held.ms < 25, `a key in a 20,000-letter word took ${held.ms.toFixed(1)} ms`);
  // The word's own letters, 20 extra ones, an ellipsis and the caret.
  assert.ok(held.text.endsWith('a'.repeat(20) + '…'), held.text);
  assert.equal(held.spans, held.text.length + 1);
  assert.equal(held.before, '…');
  assert.equal(held.last, 'tt-l tt-car');
  assert.equal(await value(), 'a'.repeat(19999));
  assert.equal(await text('#tt-error'), 'Only the first 20,000 characters can be typed in one test; the rest was cut off.');
  await page.click('#tt-restart');
  assert.equal(await text('#tt-error'), '');
  assert.equal(await page.getAttribute('#tt-input', 'aria-invalid'), null);
  assert.equal(await page.getAttribute('#tt-input', 'aria-describedby'), 'tt-hint');
  assert.equal(await text('#tt-note'), '');
  assert.equal(await value(), '');

  // ---- The address: choices are kept in it, junk gives the defaults ----
  await page.check('input[name="tt-len"][value="120"]');
  assert.equal(await hash(), '#2m');
  assert.equal(await text('#tt-time'), '2:00');
  await page.check('input[name="tt-mode"][value="book"]');
  await ready();
  assert.equal(await hash(), '#2m-pride-and-prejudice');
  assert.equal(await page.locator('#tt-book-field').isVisible(), true);
  assert.equal((await words()).slice(0, 8).join(' '), 'It is a truth universally acknowledged, that a');
  await page.selectOption('#tt-book', 'moby-dick');
  await ready();
  assert.equal(await hash(), '#2m-moby-dick');
  assert.equal(await text('#tt-source'), 'From Moby-Dick by Herman Melville (1851), chapter 1, Loomings. Standard Ebooks edition, public domain.');
  assert.equal((await words()).slice(0, 3).join(' '), 'Call me Ishmael.');
  await page.goto(url + '#30s-sherlock-holmes');
  await page.reload();
  await ready();
  assert.equal(await checkedVal('tt-len'), '30');
  assert.equal(await checkedVal('tt-mode'), 'book');
  assert.equal(await page.inputValue('#tt-book'), 'sherlock-holmes');
  assert.equal(await text('#tt-time'), '0:30');
  for (const junk of ['#7m', '#1m-unknown', '#2M', '#1m-', '#' + 'x'.repeat(200000), '#5m-' + 'alice'.repeat(10)]) {
    await page.goto(url + junk);
    await page.reload();
    await ready();
    assert.equal(await checkedVal('tt-len'), '60', junk.slice(0, 20));
    assert.equal(await checkedVal('tt-mode'), 'words', junk.slice(0, 20));
  }

  // ---- Changing a choice during a test stops it ----
  await page.goto(url + '#3m');
  await page.reload();
  await ready();
  w = await words();
  await page.focus('#tt-input');
  await page.keyboard.type(w[0] + ' ');
  assert.equal(await sr(), 'Test 1 started: 3 minutes.');
  await page.check('input[name="tt-len"][value="300"]');
  assert.equal(await sr(), 'Test stopped.');
  assert.equal(await value(), '');
  assert.equal(await text('#tt-time'), '5:00');
  assert.equal(await hash(), '#5m');

  // ---- Back and Forward: no test left half done, restored choices shown ----
  w = await words();
  await page.focus('#tt-input');
  await page.keyboard.type(w[0].slice(0, 2));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await value(), '');
  assert.equal(await text('#tt-time'), '5:00');
  await page.waitForTimeout(1100);
  assert.equal(await text('#tt-time'), '5:00', 'the old test is not still running');
  await page.goto(url);
  await page.reload();
  await ready();
  await page.evaluate(() => {
    document.querySelector('input[name="tt-len"][value="180"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  assert.equal(await text('#tt-time'), '3:00');
  assert.equal(await hash(), '#3m');

  // ---- Scored tests on a fake clock ----
  const fakeCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await fakeCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const f = await fakeCtx.newPage();
  const ferrors = [];
  f.on('pageerror', e => ferrors.push(e.message));
  f.on('console', m => { if (m.type() === 'error') ferrors.push(m.text()); });
  await f.clock.install();
  const ex = expected.gatsby;
  await f.goto(url + ex.hash);
  await f.clock.pauseAt(Date.now() + 1000);
  await ready(f);
  assert.equal(await text('#tt-source', f), 'From The Great Gatsby by F. Scott Fitzgerald (1925), chapter 1. Standard Ebooks edition, public domain.');
  assert.equal(await text('#tt-time', f), '0:30');
  await f.focus('#tt-input');
  async function replay(actions, checks = {}) {
    let n = 0;
    for (const a of actions) {
      if (a[0] === 'type') {
        for (const ch of a[1]) { await f.keyboard.type(ch); await f.clock.runFor(a[2]); }
      } else if (a[0] === 'back') {
        for (let i = 0; i < a[1]; i++) { await f.keyboard.press('Backspace'); await f.clock.runFor(a[2]); }
      } else if (a[0] === 'insert') {
        await f.keyboard.insertText(a[1]);
        if (await f.evaluate(() => !document.getElementById('tt-input').readOnly)) await f.clock.runFor(a[2]);
      } else {
        await f.clock.runFor(a[1]);
      }
      if (checks[n]) await checks[n]();
      n++;
    }
  }
  await replay(ex.actions, {
    // A leading space neither shows nor starts the clock.
    0: async () => {
      assert.equal(await value(f), '');
      assert.equal(await text('#tt-time', f), '0:30');
      assert.equal(await sr(f), '');
    },
    // Time left is rounded up: 29.02 s left, 0.98 s after the first key, reads 0:30.
    1: async () => assert.equal(await text('#tt-time', f), '0:30'),
    // "yp": the wrong key shows the letter that was wanted, in red.
    2: async () => {
      assert.equal(await f.locator('#tt-text .tt-w').nth(2).locator('.tt-bad').textContent(), 'o');
      assert.equal(await sr(f), 'Test 1 started: 30 seconds.');
    },
    3: async () => assert.equal(await f.locator('#tt-text .tt-w').nth(2).locator('.tt-bad').count(), 0),
    // Two spaces in a row move on one word; curly quotes count as straight ones.
    4: async () => {
      assert.ok((await value(f)).includes('gave me som'), 'the second space was dropped');
      const iv = f.locator('#tt-text .tt-w').nth(14);
      assert.equal(await iv.locator('.tt-ok').count(), 4, "I’ve typed with a curly apostrophe is right");
    },
  });
  assert.equal(await value(f), ex.value);
  const leftBefore = await text('#tt-time', f);
  assert.ok(/^0:0[5-9]$/.test(leftBefore), `time left before the end: ${leftBefore}`);
  await f.clock.runFor(8000);
  await f.waitForFunction(() => !document.getElementById('tt-result').hidden);
  const scores = async () => ({
    wpm: await text('#tt-r-wpm', f), raw: await text('#tt-r-raw', f), acc: await text('#tt-r-acc', f),
    con: await text('#tt-r-con', f), errorWords: await text('#tt-r-errs', f)
  });
  assert.deepEqual(await scores(), { wpm: ex.wpm, raw: ex.raw, acc: ex.acc, con: ex.con, errorWords: ex.errorWords });
  assert.equal(await text('#tt-wpm', f), ex.wpm);
  assert.equal(await text('#tt-acc', f), ex.acc);
  assert.equal(await text('#tt-time', f), ex.timeLeft);
  assert.equal(await text('#tt-r-detail', f), ex.detail);
  assert.deepEqual(await rows('#tt-errs', f), ex.wrong);
  assert.deepEqual(await f.$$eval('#tt-bars i', els => els.map(e => e.style.height)), ex.heights);
  assert.equal(await text('#tt-bars-note', f), ex.barsNote);
  assert.equal(await sr(f), ex.spoken);
  assert.deepEqual(await rows('#tt-hist', f), [['1', '30 s', 'The Great Gatsby', ex.wpm, ex.acc]]);
  assert.equal(await f.locator('#tt-text .tt-car').count(), 0, 'no caret once the test is over');
  // Keys after the end change nothing. On a computer the field keeps the focus
  // (Esc, or Tab and Enter, start a new test), so Space must not scroll the page.
  await f.evaluate(() => { window.__keys = []; window.addEventListener('keydown', e => window.__keys.push(e)); });
  await f.keyboard.type('ke');
  await f.keyboard.press('Space');
  await f.keyboard.press('Shift+Space');
  assert.equal(await value(f), ex.value);
  assert.equal(await f.evaluate(() => document.getElementById('tt-input').readOnly), true);
  assert.equal(await active(f), 'tt-input');
  const afterEnd = await f.evaluate(() => window.__keys.map(e => e.key + ' ' + e.defaultPrevented));
  assert.deepEqual(afterEnd, ['k true', 'e true', '  true', 'Shift false', '  true'], 'keys seen: ' + JSON.stringify(afterEnd));
  assert.equal(await f.evaluate(() => scrollY), 0);
  await f.click('#tt-copy');
  assert.equal(await f.evaluate(() => navigator.clipboard.readText()), ex.copy.concat(url + ex.hash).join('\n'));

  // The whole passage from Alice in 82 seconds ends the 5-minute test there.
  const ax = expected.alice;
  await f.goto(url + ax.hash);
  await ready(f);
  assert.equal(await text('#tt-time', f), '5:00');
  assert.equal(await value(f), '');
  await f.focus('#tt-input');
  await replay(ax.actions);
  await f.waitForFunction(() => !document.getElementById('tt-result').hidden);
  assert.equal(await value(f), ax.value);
  assert.deepEqual(await scores(), { wpm: ax.wpm, raw: ax.raw, acc: ax.acc, con: ax.con, errorWords: ax.errorWords });
  assert.equal(await text('#tt-time', f), ax.timeLeft);
  assert.equal(await text('#tt-r-detail', f), ax.detail);
  assert.equal(await text('#tt-bars-note', f), ax.barsNote);
  assert.deepEqual(await f.$$eval('#tt-bars i', els => els.map(e => e.style.height)), ax.heights);
  assert.equal(await sr(f), ax.spoken);
  assert.equal(await f.locator('#tt-errs-wrap').isVisible(), false);
  assert.deepEqual((await rows('#tt-hist', f)).map(r => r.join('|')), ['2|5 min|Alice in Wonderland|' + ax.wpm + '|' + ax.acc, '1|30 s|The Great Gatsby|' + ex.wpm + '|' + ex.acc]);
  await f.click('#tt-copy');
  assert.equal(await f.evaluate(() => navigator.clipboard.readText()), ax.copy.concat(url + ax.hash).join('\n'));

  // Common words, 1 minute: 20 words typed right, one a second. WPM counts
  // each word and its space; consistency counts the 40 idle seconds too.
  await f.goto(url + '#1m');
  await ready(f);
  assert.equal(await checkedVal('tt-mode', f), 'words');
  const cw = await words(f);
  await f.focus('#tt-input');
  const perSecond = [];
  for (let i = 0; i < 20; i++) {
    await f.keyboard.insertText(cw[i] + ' ');
    perSecond.push(cw[i].length + 1);
    await f.clock.runFor(1000);
  }
  await f.clock.runFor(41000);
  await f.waitForFunction(() => !document.getElementById('tt-result').hidden);
  const chars = perSecond.reduce((a, b) => a + b, 0);
  const bins = perSecond.concat(new Array(40).fill(0));
  const mean = chars / 60;
  const sd = Math.sqrt(bins.reduce((a, b) => a + (b - mean) * (b - mean), 0) / 60);
  assert.deepEqual(await scores(), {
    wpm: String(Math.floor((2 * chars + 5) / 10)), raw: String(Math.floor((2 * chars + 5) / 10)),
    acc: '100.0%', con: Math.max(0, Math.round(100 * (1 - sd / mean))) + '%', errorWords: '0'
  });
  assert.equal(await text('#tt-r-detail', f), `You typed ${chars} characters in 1 minute, ${chars} of them in correct words. ${chars} keys typed a character and 0 of them were wrong. No errors left in the text.`);
  assert.equal((await rows('#tt-hist', f))[0].slice(0, 3).join('|'), '3|1 min|Common words');
  await f.click('#tt-copy');
  assert.ok((await f.evaluate(() => navigator.clipboard.readText())).endsWith('\nNo errors left in the text\n' + url), 'the 1-minute common-words link has no hash');

  // 30 seconds of common words: one word right, then 52 wrong. Live WPM
  // counts the right one only; the table lists the first 50, and a long
  // typed word is cut without splitting an emoji.
  await f.goto(url + '#30s');
  await ready(f);
  const lw = await words(f);
  await f.focus('#tt-input');
  await f.keyboard.insertText(lw[0] + ' ');
  await f.keyboard.insertText('x'.repeat(39) + '\u{1F600}yyyy ');
  for (let i = 0; i < 51; i++) await f.keyboard.insertText('# ');
  await f.clock.runFor(4000);
  const live = Number(await text('#tt-wpm', f)), good = lw[0].length + 1;
  // 4 s after the start the live figures were last brought up to date 3.5 to 4 s in.
  assert.ok(live >= Math.round(good * 12000 / 4000) && live <= Math.round(good * 12000 / 3480), `live WPM ${live} for ${good} characters in correct words`);
  await f.clock.runFor(27000);
  await f.waitForFunction(() => !document.getElementById('tt-result').hidden);
  assert.equal(await text('#tt-r-errs', f), '52');
  const errRows = await rows('#tt-errs', f);
  assert.equal(errRows.length, 50);
  assert.deepEqual(errRows[0], ['2', lw[1], 'x'.repeat(39) + '\u{1F600}…']);
  assert.deepEqual(errRows[49], ['51', lw[50], '#']);
  assert.equal(await text('#tt-errs-more', f), 'The first 50 of 52 words with errors are shown.');
  await f.click('#tt-copy');
  const copied = (await f.evaluate(() => navigator.clipboard.readText())).split('\n');
  assert.equal(copied[0], 'Typing test (30 seconds, common words): ' + await text('#tt-r-wpm', f) + ' WPM');
  assert.equal(copied[2], 'Words with errors: ' + 'x'.repeat(39) + '\u{1F600}… (' + lw[1] + '), ' + lw.slice(2, 11).map(x => '# (' + x + ')').join(', ') + ' and 42 more');
  assert.equal(copied[3], url + '#30s');
  // Clear session empties the table and the result.
  await f.click('#tt-clear');
  assert.equal(await text('#tt-hist', f), 'No tests yet.');
  assert.equal(await f.locator('#tt-result').isVisible(), false);
  assert.equal(await sr(f), 'Session cleared.');
  assert.deepEqual(ferrors, []);
  await fakeCtx.close();

  // ---- The word list cannot be loaded: say so, and Restart tries again ----
  const offCtx = await browser.newContext();
  const o = await offCtx.newPage();
  await o.route('**/common-words/words.txt', r => r.abort());
  await o.goto(url);
  await o.waitForFunction(() => document.getElementById('tt-error').textContent !== '');
  assert.equal(await text('#tt-error', o), 'The word list could not be loaded. Check your connection, then press Restart to try again.');
  assert.equal(await text('#tt-prompt', o), 'The text could not be loaded.');
  assert.equal(await o.locator('#tt-input').isDisabled(), true);
  await o.unroute('**/common-words/words.txt');
  await o.click('#tt-restart');
  await ready(o);
  assert.equal(await text('#tt-error', o), '');
  assert.equal(await o.locator('#tt-input').isDisabled(), false);
  // The page keeps I and lower-case words, and drops anything else (here with
  // a byte order mark and Windows line ends): only I, the and of are dealt.
  const o2 = await offCtx.newPage();
  await o2.route('**/common-words/words.txt', r => r.fulfill({ contentType: 'text/plain', body: '\uFEFF' + "I\r\nthe\r\nEngland\r\ndon't\r\n\r\nof\r\nHello\r\ni2\r\n".repeat(60) }));
  await o2.goto(url);
  await ready(o2);
  const dealt = await words(o2);
  assert.deepEqual(Array.from(new Set(dealt)).sort(), ['I', 'of', 'the']);
  await o2.focus('#tt-input');
  await o2.keyboard.type(dealt.slice(0, 3).join(' '));
  assert.equal(await o2.locator('#tt-text .tt-bad, #tt-text .tt-extra').count(), 0, 'I typed with a capital is right');
  await offCtx.close();

  // ---- A phone: a tap opens the box, inserted words count ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  const perrors = [];
  p.on('pageerror', e => perrors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') perrors.push(m.text()); });
  await p.goto(url + '#30s-alice');
  await ready(p);
  const box = await p.locator('#tt-box').boundingBox();
  await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await active(p), 'tt-input');
  await p.keyboard.insertText('Alice was ');
  assert.equal(await sr(p), 'Test 1 started: 30 seconds.');
  assert.equal(await p.locator('#tt-text .tt-w').nth(1).locator('.tt-ok').count(), 3);
  // A whole word and its space at once, as a word suggestion inserts it.
  await p.keyboard.insertText('beginning ');
  assert.equal(await p.locator('#tt-text .tt-w .tt-bad').count(), 0);
  // The rest of the passage in one go, as a keyboard's clipboard button puts
  // it in (no paste event): refused, so the test is not over in no time.
  const rest = (await words(p)).slice(3).join(' ');
  await p.keyboard.insertText(rest);
  assert.equal(await value(p), 'Alice was beginning ');
  assert.equal(await text('#tt-note', p), BULK_NOTE);
  assert.equal(await p.locator('#tt-result').isVisible(), false);
  await p.keyboard.insertText('to ');
  assert.equal(await value(p), 'Alice was beginning to ');
  const sizes = await p.evaluate(() => ({
    chips: Math.min(...Array.from(document.querySelectorAll('.tt-chip span')).map(s => s.getBoundingClientRect().height)),
    restart: document.getElementById('tt-restart').getBoundingClientRect().height,
    select: document.getElementById('tt-book').getBoundingClientRect().height,
    inputFont: parseFloat(getComputedStyle(document.getElementById('tt-input')).fontSize),
    selectFont: parseFloat(getComputedStyle(document.getElementById('tt-book')).fontSize),
    lines: Math.round(document.getElementById('tt-text').clientHeight / parseFloat(getComputedStyle(document.getElementById('tt-text')).lineHeight)),
    overflow: document.documentElement.scrollWidth - innerWidth
  }));
  assert.ok(sizes.chips >= 44 && sizes.restart >= 44 && sizes.select >= 44, JSON.stringify(sizes));
  assert.ok(sizes.inputFont >= 16 && sizes.selectFont >= 16, JSON.stringify(sizes));
  assert.equal(sizes.lines, 3);
  assert.ok(sizes.overflow <= 1, `sideways scroll on a phone: ${sizes.overflow}px`);
  // Every book's name fits its list box at 320 px.
  await p.setViewportSize({ width: 320, height: 640 });
  // So do the live figures, each on one line, 100.0% included.
  assert.equal(await text('#tt-acc', p), '100.0%');
  const cramped = await p.evaluate(() => Array.from(document.querySelectorAll('.tt-live .stat b')).filter(b => {
    const box = b.parentElement, cs = getComputedStyle(box);
    const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return b.scrollWidth > room + 0.5 || b.getBoundingClientRect().height > parseFloat(getComputedStyle(b).fontSize) * 1.6;
  }).map(b => b.id + ' ' + b.textContent));
  assert.deepEqual(cramped, []);
  const cutNames = await p.evaluate(() => {
    const sel = document.getElementById('tt-book');
    const cs = getComputedStyle(sel);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 24;
    return Array.from(sel.options).filter(o => ctx.measureText(o.textContent).width > room).map(o => o.textContent);
  });
  assert.deepEqual(cutNames, []);
  assert.deepEqual(perrors, []);
  await phone.close();

  // ---- A phone: when a test ends the on-screen keyboard closes and the result comes into view ----
  const touch = await browser.newContext({ ...devices['Pixel 7'] });
  const t7 = await touch.newPage();
  const terrors = [];
  t7.on('pageerror', e => terrors.push(e.message));
  t7.on('console', m => { if (m.type() === 'error') terrors.push(m.text()); });
  await t7.clock.install();
  await t7.goto(url + '#30s');
  await t7.clock.pauseAt(Date.now() + 1000);
  await ready(t7);
  const tw = await words(t7);
  await t7.locator('#tt-box').tap();
  assert.equal(await active(t7), 'tt-input');
  for (let i = 0; i < 6; i++) { await t7.keyboard.insertText(tw[i] + ' '); await t7.clock.runFor(1000); }
  // To 0.1 s past the end, so that most of the quiet second after it is left.
  await t7.clock.runFor(24100);
  await t7.waitForFunction(() => !document.getElementById('tt-result').hidden);
  // The field has let go of the focus, which closes the keyboard, and the
  // result's heading has it; the result scrolls into view (smoothly: wait).
  assert.equal(await active(t7), 'tt-r-h');
  assert.equal(await text('#tt-r-h', t7), 'Your result');
  const scoreShown = () => t7.evaluate(() => { const r = document.getElementById('tt-r-wpm').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  for (const t0 = Date.now(); !(await scoreShown()) && Date.now() - t0 < 5000;) await t7.waitForTimeout(50);
  assert.equal(await scoreShown(), true, 'the score is on screen');
  // For a second, keys and taps from fingers still typing do nothing...
  await t7.evaluate(() => { window.__keys = []; window.addEventListener('keydown', e => window.__keys.push(e), true); });
  await t7.keyboard.press('Space');
  await t7.locator('#tt-clear').click();
  const lateKeys = await t7.evaluate(() => window.__keys.map(e => e.key + ' ' + e.defaultPrevented + ' ' + (e.target.id || e.target.nodeName) + ' ' + Math.round(performance.now())));
  assert.deepEqual(lateKeys.map(k => k.split(' ').slice(0, 3).join(' ')), ['  true'], 'keys seen: ' + JSON.stringify(lateKeys));
  assert.equal((await rows('#tt-hist', t7)).length, 1, 'a stray tap did not clear the session');
  assert.equal(await t7.locator('#tt-result').isVisible(), true);
  // ...and then they work again.
  await t7.clock.runFor(1000);
  await t7.locator('#tt-clear').click();
  assert.equal(await text('#tt-hist', t7), 'No tests yet.');
  assert.deepEqual(terrors, []);
  await touch.close();

  // ---- The line being typed stays in view, also when the box gets narrower ----
  const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const r = await wide.newPage();
  await r.goto(url + '#2m-moby-dick');
  await ready(r);
  const mw = await words(r);
  await r.focus('#tt-input');
  for (const x of mw.slice(0, 40)) await r.keyboard.insertText(x + ' ');
  assert.equal(await caretInView(r), true, 'the caret is in view after 40 words');
  assert.ok(await r.evaluate(() => document.getElementById('tt-text').scrollTop > 0), 'the text has moved up');
  await r.setViewportSize({ width: 360, height: 800 });
  await r.waitForTimeout(400);
  assert.equal(await caretInView(r), true, 'the caret is in view after the box got narrower');
  await r.setViewportSize({ width: 1280, height: 800 });
  await r.waitForTimeout(400);
  assert.equal(await caretInView(r), true, 'the caret is in view after the box got wider');
  await wide.close();

  // ---- Homepage search finds the page under the words people use ----
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/typing-test\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the typing test');
  for (const q of ['typing test', 'typing speed', 'wpm', 'words per minute', 'accuracy', 'typing practice', 'keyboard speed test',
    '30 second typing test', '2 minute typing test', '3 minute typing test']) {
    assert.ok(q.split(' ').every(x => hay.includes(x)), `the homepage search finds nothing for "${q}"`);
  }

  // Leave a finished test, with words in error, on screen for the runner's
  // phone-width checks.
  await page.clock.install();
  await page.goto(url + '#30s-the-great-gatsby');
  await page.reload();
  await page.clock.pauseAt(Date.now() + 1000);
  await ready();
  await page.focus('#tt-input');
  await page.keyboard.insertText('In my youngerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr and mroe vulnerable ');
  await page.clock.runFor(31000);
  await page.waitForFunction(() => !document.getElementById('tt-result').hidden);
  assert.equal(await text('#tt-r-errs'), '2');
};
