const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Scores for the book passages come from tests/fixtures/typing-test/expected.py,
// which replays the same keystrokes with its own implementation of the rules
// in the guide. Those scenarios run on Playwright's fake clock, so every key
// lands at an exact time and a 5-minute test takes no real time.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const wordFile = path.join(__dirname, '..', '..', 'assets', 'vendor', 'random-words', 'words.txt');
  const list = new Set(fs.readFileSync(wordFile, 'utf8').split('\n').filter(Boolean));
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

  // ---- Defaults: 1 minute of common words from the vendored list ----
  await open();
  await ready();
  assert.equal(await checkedVal('tt-len'), '60');
  assert.equal(await checkedVal('tt-mode'), 'words');
  assert.equal(await hash(), '');
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await text('#tt-acc'), '–');
  assert.equal(await page.locator('#tt-book-field').isVisible(), false);
  assert.equal(await text('#tt-source'), 'Random words from a list of 1,952 common English words, in lower case.');
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
  assert.equal(await text('#tt-sr'), 'Test 1 started: 1 minute.');
  assert.equal(await page.locator('#tt-text .tt-w').nth(0).locator('.tt-ok').count(), w[0].length);
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-ok').count(), w[1].length);
  assert.equal(await page.locator('#tt-text .tt-w .tt-bad, #tt-text .tt-w .tt-extra').count(), 0);
  assert.equal(await text('#tt-acc'), '100.0%');
  // The caret cannot be moved back: arrow keys and Home do nothing, typing goes on at the end.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Home');
  await page.keyboard.type('#');
  assert.equal(await value(), w[0] + ' ' + w[1] + '#');
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-extra').textContent(), '#');
  const keysSoFar = (w[0] + ' ' + w[1]).length + 1;
  const tenths = Math.floor((2000 * (keysSoFar - 1) + keysSoFar) / (2 * keysSoFar));
  assert.equal(await text('#tt-acc'), `${Math.floor(tenths / 10)}.${tenths % 10}%`);
  // Backspace into the previous word, then a space before the word ends.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.equal(await value(), w[0] + ' ' + w[1].slice(0, -2));
  await page.keyboard.type(' ');
  assert.equal(await page.locator('#tt-text .tt-w').nth(1).locator('.tt-miss').count(), 2, 'the two letters skipped are marked');
  // Esc throws the test away and deals new words.
  await page.keyboard.press('Escape');
  assert.equal(await value(), '');
  assert.equal(await text('#tt-sr'), 'Test stopped. A new test is ready.');
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
  assert.equal(await text('#tt-sr'), 'Test stopped. A new test is ready.');
  w = await words();

  // ---- A letter pressed with nothing focused goes into the box ----
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press(w[0][0]);
  assert.equal(await active(), 'tt-input');
  assert.equal(await value(), w[0][0]);
  await page.keyboard.press('Escape');

  // ---- Paste is refused, even a megabyte of it ----
  await page.evaluate(() => navigator.clipboard.writeText('paste '.repeat(175000)));
  await page.focus('#tt-input');
  const tp = Date.now();
  await page.keyboard.press('Control+V');
  assert.ok(Date.now() - tp < 3000, 'a megabyte paste is refused at once');
  assert.equal(await value(), '');
  assert.equal(await text('#tt-note'), 'Pasting is turned off in the typing test: type the text yourself.');
  assert.equal(await text('#tt-time'), '1:00');
  assert.equal(await page.evaluate(() => document.querySelector('#tt-box').classList.contains('is-ready')), true);

  // ---- A flood of text inserted some other way is cut, and the box says why ----
  const flood = await page.evaluate(() => {
    const i = document.getElementById('tt-input');
    const t0 = performance.now();
    i.value = 'flood word '.repeat(100000);
    i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return { ms: performance.now() - t0, len: i.value.length };
  });
  assert.ok(flood.ms < 3000, `cutting a megabyte took ${Math.round(flood.ms)} ms`);
  assert.equal(flood.len, 20000);
  assert.equal(await text('#tt-error'), 'Only the first 20,000 characters can be typed in one test; the rest was cut off.');
  assert.equal(await page.getAttribute('#tt-input', 'aria-invalid'), 'true');
  assert.deepEqual((await page.getAttribute('#tt-input', 'aria-describedby')).split(' ').sort(), ['tt-error', 'tt-hint']);
  // 'flood word ' 1,818 times and 'fl': 3,637 words typed, and 60 more ready.
  assert.ok((await page.locator('#tt-text .tt-w').count()) >= 3637 + 60, 'enough words were added for the flood');
  // An emoji at the limit is not cut in half.
  await page.evaluate(() => {
    const i = document.getElementById('tt-input');
    i.value = 'a'.repeat(19999) + '\u{1F600}tail';
    i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  assert.equal(await value(), 'a'.repeat(19999));
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
  assert.equal(await text('#tt-sr'), 'Test 1 started: 3 minutes.');
  await page.check('input[name="tt-len"][value="300"]');
  assert.equal(await text('#tt-sr'), 'Test stopped.');
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
      assert.equal(await text('#tt-sr', f), '');
    },
    // "yp": the wrong key shows the letter that was wanted, in red.
    2: async () => {
      assert.equal(await f.locator('#tt-text .tt-w').nth(2).locator('.tt-bad').textContent(), 'o');
      assert.equal(await text('#tt-sr', f), 'Test 1 started: 30 seconds.');
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
  assert.equal(await text('#tt-sr', f), ex.spoken);
  assert.deepEqual(await rows('#tt-hist', f), [['1', '30 s', 'The Great Gatsby', ex.wpm, ex.acc]]);
  // Keys after the end change nothing.
  await f.keyboard.type('ke');
  assert.equal(await value(f), ex.value);
  assert.equal(await f.evaluate(() => document.getElementById('tt-input').readOnly), true);
  await f.click('#tt-copy');
  assert.equal(await f.evaluate(() => navigator.clipboard.readText()), ex.copy.concat(url).join('\n'));

  // The whole chapter of Alice in 81 seconds ends the 5-minute test there.
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
  assert.equal(await text('#tt-sr', f), ax.spoken);
  assert.equal(await f.locator('#tt-errs-wrap').isVisible(), false);
  assert.deepEqual((await rows('#tt-hist', f)).map(r => r.join('|')), ['2|5 min|Alice in Wonderland|' + ax.wpm + '|' + ax.acc, '1|30 s|The Great Gatsby|' + ex.wpm + '|' + ex.acc]);
  await f.click('#tt-copy');
  assert.equal(await f.evaluate(() => navigator.clipboard.readText()), ax.copy.concat(url).join('\n'));

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
  // Clear session empties the table and the result.
  await f.click('#tt-clear');
  assert.equal(await text('#tt-hist', f), 'No tests yet.');
  assert.equal(await f.locator('#tt-result').isVisible(), false);
  assert.equal(await text('#tt-sr', f), 'Session cleared.');
  assert.deepEqual(ferrors, []);
  await fakeCtx.close();

  // ---- The word list cannot be loaded: say so, and Restart tries again ----
  const offCtx = await browser.newContext();
  const o = await offCtx.newPage();
  await o.route('**/random-words/words.txt', r => r.abort());
  await o.goto(url);
  await o.waitForFunction(() => document.getElementById('tt-error').textContent !== '');
  assert.equal(await text('#tt-error', o), 'The word list could not be loaded. Check your connection, then press Restart to try again.');
  assert.equal(await text('#tt-prompt', o), 'The text could not be loaded.');
  assert.equal(await o.locator('#tt-input').isDisabled(), true);
  await o.unroute('**/random-words/words.txt');
  await o.click('#tt-restart');
  await ready(o);
  assert.equal(await text('#tt-error', o), '');
  assert.equal(await o.locator('#tt-input').isDisabled(), false);
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
  assert.equal(await text('#tt-sr', p), 'Test 1 started: 30 seconds.');
  assert.equal(await p.locator('#tt-text .tt-w').nth(1).locator('.tt-ok').count(), 3);
  // A whole word and its space at once, as a word suggestion inserts it.
  await p.keyboard.insertText('beginning ');
  assert.equal(await p.locator('#tt-text .tt-w .tt-bad').count(), 0);
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

  // ---- Homepage search finds the page under the words people use ----
  const home = await (await page.request.get(base + '/')).text();
  const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/typing-test\/"/) || [])[1] || '').replace(/&amp;/g, '&');
  assert.ok(hay, 'the homepage lists the typing test');
  for (const q of ['typing test', 'typing speed', 'wpm', 'words per minute', 'accuracy']) {
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
