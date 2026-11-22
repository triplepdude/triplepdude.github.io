// Known answers come from the zxcvbn-ts project's own test suite
// (packages/libraries/main/test/helper/passwordTests.ts and main.spec.ts in
// github.com/zxcvbn-ts/zxcvbn), which documents the exact guesses, score,
// feedback and crack times the library returns with the common + English
// dictionaries. Every vector was also re-checked in Node against the npm packages
// (@zxcvbn-ts/core 4.2.0, language-common 4.1.3, language-en 4.1.1), independently of
// the vendored browser builds. The character-set entropy is recomputed with Math.log2.

const VECTORS = [
  // password, guesses, score, warning (or null), patterns in order
  ['1q2w3e4r5t', '364', 0, 'This is a commonly used password.', ['dictionary']],
  ['P@ssw0rd123!', '150096', 1, 'This is similar to a commonly used password.', ['dictionary', 'bruteforce']],
  ['12/12/1990', '52561', 1, 'Dates are easy to guess.', ['date']],
  ['qwer', '1297', 1, 'Straight rows of keys on your keyboard are easy to guess.', ['spatial']],
  ['abcabcabcabc', '53', 0, 'Repeated character patterns like "abcabcabc" are easy to guess.', ['repeat']],
  ['zyxwvuts', '65', 0, 'Common character sequences like "abc" are easy to guess.', ['sequence']],
  ['drowssap', '5', 0, 'This is similar to a commonly used password.', ['dictionary']],
  ['2010abc', '15000', 1, 'Recent years are easy to guess.', ['regex', 'sequence']],
  ['monkeymonkey', '3', 0, null, ['wordSequence']],
  ['buy by beer', '1301200000', 3, null, ['bruteforce', 'repeat', 'bruteforce']],
  ['CorrectHorseBatteryStaple', '43178346496000', 4, null, ['dictionary', 'dictionary', 'dictionary', 'dictionary']],
  ['dgo9dsghasdoghi8/!&IT%§(ihsdhf8o7o', '6e+32', 4, null, ['bruteforce', 'dictionary', 'dictionary', 'bruteforce']],
];
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

module.exports = async ({ page, open, assert, base }) => {
  const requests = [];
  page.on('request', r => { if (/zxcvbn/.test(r.url())) requests.push(r.url()); });
  await open();
  const text = sel => page.textContent(sel);

  // Nothing heavy is loaded until the password box is used.
  await page.waitForTimeout(300);
  assert.equal(requests.length, 0, 'word lists are lazy-loaded');
  assert.equal(await page.isVisible('#pw-result'), false);
  assert.equal(await page.getAttribute('#pw-input', 'type'), 'password');
  assert.equal(await page.getAttribute('.pw-more a', 'href'), '/passphrase-generator/');

  const check = async (pw, guesses) => {
    await page.fill('#pw-input', pw);
    const ok = await page.waitForFunction(g => {
      const el = document.querySelector('#pw-guesses');
      return el && !document.querySelector('#pw-result').hidden && el.getAttribute('data-guesses') === g;
    }, guesses, { timeout: 15000 }).then(() => true, () => false);
    assert.ok(ok, `${pw}: expected ${guesses} guesses, page shows ${await page.getAttribute('#pw-guesses', 'data-guesses')}`);
  };

  // If the word lists fail to load, the page says so, and the next keystroke tries again.
  const broken = route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("damaged file");' });
  await page.route('**/zxcvbn-ts-core.min.js', broken);
  await page.fill('#pw-input', 'abc');
  await page.waitForFunction(() => /could not be loaded/.test(document.querySelector('#pw-error').textContent), null, { timeout: 10000 });
  assert.equal(await page.isVisible('#pw-result'), false);
  await page.unroute('**/zxcvbn-ts-core.min.js', broken);
  requests.length = 0;
  await check('abcd', '17');
  assert.equal(await text('#pw-error'), '');

  await page.focus('#pw-input');
  for (const [pw, guesses, score, warning, patterns] of VECTORS) {
    await check(pw, guesses);
    assert.equal(await text('#pw-verdict'), LABELS[score], `${pw} verdict`);
    assert.equal(await text('#pw-score'), `Score ${score} of 4`);
    assert.equal(await page.getAttribute('#pw-meter', 'data-score'), String(score));
    const warn = await page.locator('#pw-feedback .pw-warn').allTextContents();
    assert.deepEqual(warn, warning ? [warning] : [], `${pw} warning`);
    assert.deepEqual(await page.$$eval('#pw-parts tbody tr', trs => trs.map(t => t.getAttribute('data-pattern'))), patterns, `${pw} patterns`);
  }
  assert.equal(new Set(requests).size, 3, requests.join(' '));

  // Crack times for "1q2w3e4r5t" (364 guesses), as listed upstream.
  await check('1q2w3e4r5t', '364');
  const times = await page.$$eval('#pw-times tbody tr', trs => trs.map(t => [t.getAttribute('data-key'), t.lastElementChild.textContent]));
  assert.deepEqual(times, [
    ['onlineThrottlingXPerHour', '4 hours'],
    ['onlineNoThrottlingXPerSecond', '36 seconds'],
    ['offlineSlowHashingXPerSecond', 'less than a second'],
    ['offlineFastHashingXPerSecond', 'less than a second'],
  ]);
  assert.deepEqual(await page.locator('#pw-feedback li').allTextContents(), ['Add more words that are less common.']);
  assert.equal(await text('#pw-guesses'), '364');

  // Hidden password: the matched parts are masked too; Show reveals them.
  await check('P@ssw0rd123!', '150096');
  const masked = await page.locator('#pw-parts .pw-token [aria-hidden="true"]').allTextContents();
  assert.deepEqual(masked, ['•••••••••••', '•']);
  // Screen readers hear a count, not a row of bullets (aria-label on a plain span is ignored).
  assert.deepEqual(await page.locator('#pw-parts .pw-token .visually-hidden').allTextContents(), ['11 hidden characters', '1 hidden character']);
  assert.ok(!(await text('#pw-parts')).includes('"password123"'), 'matched word hidden');
  assert.match(await text('#pw-parts-note'), /Press Show/);
  await page.click('#pw-toggle');
  assert.equal(await page.getAttribute('#pw-input', 'type'), 'text');
  assert.equal(await page.getAttribute('#pw-toggle', 'aria-label'), 'Hide password');
  assert.deepEqual(await page.locator('#pw-parts .pw-token').allTextContents(), ['P@ssw0rd123', '!']);
  assert.match(await text('#pw-parts'), /Common password "password123" \(@ → a, 0 → o\), number 796 on the list, with l33t swaps, with capitals/);
  // Pattern-based bits = log2(guesses); character-set entropy = length × log2(26+26+10+32).
  assert.equal(await text('#pw-bits'), `${Math.log2(150096).toFixed(1)} bits`);
  assert.equal(await text('#pw-entropy'), `${(12 * Math.log2(94)).toFixed(1)} bits`);
  assert.equal(await text('#pw-length'), '12');
  assert.deepEqual(await page.$$eval('#pw-sets li.on', l => l.map(e => e.getAttribute('data-set'))), ['lower', 'upper', 'digit', 'symbol']);
  await page.click('#pw-toggle');
  assert.equal(await page.getAttribute('#pw-input', 'type'), 'password');

  // Big numbers are shown in scientific notation.
  await check('CorrectHorseBatteryStaple', '43178346496000');
  assert.equal(await text('#pw-guesses'), '4.3 × 1013');
  assert.equal(await text('#pw-length'), '25');
  assert.match(await text('#pw-feedback'), /No common patterns found/);
  await page.click('#pw-toggle');
  assert.match(await text('#pw-parts'), /Word list: Chinese zodiac "horse"/);
  await page.click('#pw-toggle');
  // A space and a non-ASCII letter extend the pool: 26 + 1 + 100.
  await page.fill('#pw-input', 'crème brûlée');
  await page.waitForFunction(() => document.querySelector('#pw-length').textContent === '12');
  assert.equal(await text('#pw-entropy'), `${(12 * Math.log2(127)).toFixed(1)} bits`);
  assert.deepEqual(await page.$$eval('#pw-sets li.on', l => l.map(e => e.getAttribute('data-set'))), ['lower', 'space', 'other']);

  // Personal words (upstream main.spec.ts: "test" with userInputs ["test", 12] needs 2 guesses).
  await page.click('.pw-personal summary');
  await page.fill('#pw-user', 'test, 12');
  await check('test', '2');
  assert.equal(await page.locator('#pw-feedback .pw-warn').textContent(), 'There should not be any personal or page related data.');
  assert.equal(await page.$eval('#pw-times tbody tr', tr => tr.lastElementChild.textContent), '1 minute');
  await page.fill('#pw-user', '');
  await page.waitForFunction(() => document.querySelector('#pw-guesses').getAttribute('data-guesses') === '116');

  // A long random password takes a moment to analyse: the page says it is checking and
  // dims the previous result until the new one is ready.
  let seed = 7;
  const random = Array.from({ length: 256 }, () => String.fromCharCode(33 + ((seed = (seed * 48271) % 2147483647) % 94))).join('');
  await page.fill('#pw-input', random);
  const sawBusy = await page.waitForFunction(() => !document.querySelector('#pw-busy').hidden && document.querySelector('#pw-result').getAttribute('aria-busy') === 'true', null, { timeout: 5000 }).then(() => true, () => false);
  await page.waitForFunction(() => document.querySelector('#pw-length').textContent === '256', null, { timeout: 30000 });
  assert.ok(sawBusy, 'Checking… shown during a slow check');
  assert.equal(await page.isHidden('#pw-busy'), true);
  assert.equal(await page.getAttribute('#pw-result', 'aria-busy'), null);
  assert.equal(await text('#pw-verdict'), 'Very strong');

  // Only the first 256 characters are analysed; the page says so.
  await check('x'.repeat(300), '3073');
  assert.equal(await page.isVisible('#pw-truncated'), true);
  assert.equal(await text('#pw-length'), '300');

  // Example buttons fill the box and reveal it.
  await page.click('[data-example="12/12/1990"]');
  await page.waitForFunction(() => document.querySelector('#pw-guesses').getAttribute('data-guesses') === '52561');
  assert.equal(await page.inputValue('#pw-input'), '12/12/1990');
  assert.equal(await page.getAttribute('#pw-input', 'type'), 'text');
  assert.match(await text('#pw-parts'), /Date.*1990-12-12/);

  // One short spoken summary after typing pauses.
  await page.fill('#pw-input', '');
  assert.equal(await page.isVisible('#pw-result'), false);
  await page.evaluate(() => {
    window.__live = [];
    const s = document.querySelector('#pw-status');
    new MutationObserver(() => { if (s.textContent) window.__live.push(s.textContent); }).observe(s, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#pw-input').pressSequentially('qwer', { delay: 30 });
  await page.waitForFunction(() => window.__live.length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => window.__live), ['Weak, score 1 of 4. About 1,297 guesses. Straight rows of keys on your keyboard are easy to guess.']);
  assert.equal(await page.getAttribute('#pw-result', 'aria-live'), null);

  // Clear empties the box and keeps focus there.
  await page.click('#pw-clear');
  assert.equal(await page.inputValue('#pw-input'), '');
  assert.equal(await page.isVisible('#pw-result'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pw-input');

  // A check that fails hides the previous result, so it is not mistaken for this password's,
  // and the next password is checked by a fresh worker. The core is stubbed: its check takes
  // 800 ms for "slow…" passwords, then throws for "…boom", and gives 7 guesses plus 100 for
  // each personal word.
  const time = { display: 'stub time', seconds: 1 };
  const stub = `self.zxcvbnts = self.zxcvbnts || {};
    self.zxcvbnts.core = { ZxcvbnFactory: function () { this.check = function (p, u) {
      if (/^slow/.test(p)) for (var end = Date.now() + 800; Date.now() < end;);
      if (/boom$/.test(p)) throw new Error('analysis failed');
      var g = 7 + 100 * (u ? u.length : 0);
      return { score: 0, guesses: g, guessesLog10: Math.log10(g), feedback: { warning: '', suggestions: [] }, sequence: [],
        crackTimes: { onlineThrottlingXPerHour: ${JSON.stringify(time)}, onlineNoThrottlingXPerSecond: ${JSON.stringify(time)},
          offlineSlowHashingXPerSecond: ${JSON.stringify(time)}, offlineFastHashingXPerSecond: ${JSON.stringify(time)} } };
    }; } };`;
  await page.route('**/zxcvbn-ts-core.min.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await open();
  await check('fine', '7');
  await page.fill('#pw-input', 'boom');
  await page.waitForFunction(() => /could not be checked/.test(document.querySelector('#pw-error').textContent), null, { timeout: 10000 });
  assert.equal(await page.isVisible('#pw-result'), false, 'stale result hidden after a failed check');
  assert.equal(await page.isVisible('#pw-intro'), true);
  await check('fine again', '7');
  assert.equal(await text('#pw-error'), '');
  // Regression: a check that ended after Clear was remembered as if shown, so the same
  // password typed again showed nothing until one more character was added.
  const resultShown = () => page.waitForFunction(() => !document.querySelector('#pw-result').hidden, null, { timeout: 5000 }).then(() => true, () => false);
  await page.fill('#pw-input', 'slow one');
  await page.click('#pw-clear');
  await page.waitForTimeout(1500);
  assert.equal(await page.isVisible('#pw-result'), false);
  await page.fill('#pw-input', 'slow one');
  assert.ok(await resultShown(), 'the same password typed again after Clear is checked again');
  assert.equal(await text('#pw-length'), '8');
  // Cleared and typed again while the check runs: its result is shown.
  await page.fill('#pw-input', 'slow two');
  await page.click('#pw-clear');
  await page.fill('#pw-input', 'slow two');
  assert.ok(await resultShown(), 'typed again during the check');
  assert.equal(await text('#pw-length'), '8');
  // "Checking…" appears 300 ms into a check and goes when it ends. This runs act() and waits
  // until the check it starts has done both; a MutationObserver records the indicator, so even
  // a short appearance is not missed. If it never shows (a starved machine can run the result
  // before the 300 ms timer), the wait ends after 5 s instead, when the 800 ms check is over.
  const throughCheck = async act => {
    await page.evaluate(() => {
      const busy = document.querySelector('#pw-busy');
      if (window.__busyObserver) window.__busyObserver.disconnect();
      window.__busySeen = false;
      window.__busyObserver = new MutationObserver(() => { if (!busy.hidden) window.__busySeen = true; });
      window.__busyObserver.observe(busy, { attributes: true, attributeFilter: ['hidden'] });
    });
    await act();
    await page.waitForFunction(() => window.__busySeen && document.querySelector('#pw-busy').hidden, null, { timeout: 5000 }).catch(() => {});
  };
  // Regression: a personal word typed and deleted during a check got that check's result
  // (107 guesses) drawn under a box that no longer held the word.
  await page.click('.pw-personal summary');
  await throughCheck(async () => {
    await page.fill('#pw-user', 'a');
    await page.fill('#pw-user', '');
  });
  assert.equal(await page.getAttribute('#pw-guesses', 'data-guesses'), '7', 'result for the words in the box');
  assert.equal(await page.getAttribute('#pw-result', 'aria-busy'), null);
  await page.fill('#pw-user', 'a');
  await page.waitForFunction(() => document.querySelector('#pw-guesses').getAttribute('data-guesses') === '107', null, { timeout: 5000 });
  // Regression: a check that failed after the box had gone back to the password on screen
  // hid that password's result and showed the error meant for the other one.
  await throughCheck(async () => {
    await page.fill('#pw-input', 'slow boom');
    await page.fill('#pw-input', 'slow two');
  });
  assert.equal(await page.isVisible('#pw-result'), true, 'a failed check of another password keeps the result');
  assert.equal(await page.getAttribute('#pw-guesses', 'data-guesses'), '107');
  assert.equal(await text('#pw-error'), '');
  // One that failed after Clear showed its error under the empty box. (The failure restarted
  // the worker, so a check comes first to load a new one.)
  await page.fill('#pw-input', 'fine');
  await page.waitForFunction(() => !document.querySelector('#pw-result').hidden && document.querySelector('#pw-length').textContent === '4', null, { timeout: 10000 });
  await page.fill('#pw-input', 'slow boom');
  await page.click('#pw-clear');
  await page.waitForTimeout(1500);
  assert.equal(await text('#pw-error'), '', 'no error for a password that was cleared');
  assert.equal(await page.isVisible('#pw-intro'), true);
  // The password itself still gets the error.
  await page.fill('#pw-input', 'slow boom');
  await page.waitForFunction(() => /could not be checked/.test(document.querySelector('#pw-error').textContent), null, { timeout: 10000 });
  assert.equal(await page.isVisible('#pw-result'), false);

  // ----- The question people type: "how secure is my password" -----
  {
    // It is the title of the leading results for this need and was nowhere on the page.
    const questions = await page.$$eval('.faq summary', els => els.map(e => e.textContent.trim()));
    assert.equal(questions.length, 5);
    assert.ok(questions.includes('How secure is my password?'), `FAQ questions: ${questions.join(' | ')}`);
    const answer = (await page.locator('.faq details', { hasText: 'How secure is my password?' }).locator('.faq-answer').textContent()).replace(/\s+/g, ' ').trim();
    // The answer names scores 3 and 4 with the verdicts the page shows for them (checked
    // for every vector above), and says what a score cannot tell.
    assert.ok(answer.includes(`A score of 3 (${LABELS[3]}) or 4 (${LABELS[4]}) means it is hard to guess`), answer);
    assert.match(answer, /must also be used on one site only and must never have leaked, which a score cannot tell you\.$/);
    // The guide's tips link to the password generator and the passphrase generator, and
    // not to the random number generator, whose own guide sends people who need a
    // password to the passphrase generator.
    const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
    assert.deepEqual(links, ['/password-generator/', '/passphrase-generator/']);
    // Homepage search (index.html): every typed word must be a substring of the tool's
    // title, description and keywords.
    const home = await (await page.request.get(base + '/')).text();
    const hay = ((home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/password-strength-checker\/"/) || [])[1] || '').replace(/&amp;/g, '&');
    assert.ok(hay, 'the homepage lists the password strength checker');
    for (const q of ['how secure is my password', 'how strong is my password', 'secure', 'password tester', 'password meter', 'password strength meter', 'zxcvbn', 'entropy']) {
      assert.ok(q.split(' ').every(w => hay.includes(w)), `the homepage search finds nothing for "${q}"`);
    }
  }
};
