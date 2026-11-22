const fs = require('fs');
const path = require('path');

// Known answers come from tests/fixtures/password-generator/expected.py, which counts the
// passwords each setting allows by dynamic programming and by inclusion-exclusion (both
// checked against brute force) and rounds times the way the page does.
const LOWER = 'abcdefghijklmnopqrstuvwxyz', UPPER = LOWER.toUpperCase(), DIGITS = '0123456789';
const RATE_KEY = { '1e3': '1000', '1e4': '10000', '1e11': '1e+11', '1e14': '1e+14' };

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const C = exp.cases, SYMBOLS = exp.symbols;
  assert.equal(SYMBOLS, '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
  const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

  // Randomness is instrumented before any page script runs: queued values are fed to
  // crypto.getRandomValues first, and Math.random must never be used. Console output
  // is kept to prove no password is ever written there.
  const consoleLines = [];
  page.on('console', m => consoleLines.push(m.text()));
  await page.addInitScript(() => {
    const real = crypto.getRandomValues.bind(crypto);
    window.__queue = [];
    crypto.getRandomValues = arr => {
      real(arr);
      for (let i = 0; i < arr.length && window.__queue.length; i++) arr[i] = window.__queue.shift();
      return arr;
    };
    Math.random = () => { window.__mathRandom = true; return 0.5; };
  });
  await open();

  const pws = () => page.$$eval('#pg-list .pg-text:not(.pg-empty)', els => els.map(e => e.textContent));
  const text = sel => page.textContent(sel);
  const setRange = v => page.$eval('#pg-len-range', (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  const typeLen = async v => { await page.fill('#pg-len', v); };
  const kindsOf = p => ({ l: /[a-z]/.test(p), u: /[A-Z]/.test(p), d: /[0-9]/.test(p), s: /[^A-Za-z0-9]/.test(p) });
  const expectStats = async (name, rate = '1e11') => {
    const c = C[name];
    assert.equal(await text('#pg-bits'), c.bits, `${name} bits`);
    assert.equal(await text('#pg-strength'), c.strength, `${name} strength`);
    assert.equal(await text('#pg-space'), c.space, `${name} possible`);
    assert.equal(await text('#pg-time'), c.times[RATE_KEY[rate]], `${name} time at ${rate}`);
  };
  const fieldError = id => page.evaluate(id => {
    const f = document.getElementById(id), box = document.getElementById(id.replace(/^pg-(lower|upper|digits|symbols)$/, 'pg-kinds') + '-error');
    return { text: box.textContent, invalid: f.getAttribute('aria-invalid'), linked: (f.getAttribute('aria-describedby') || '').split(/\s+/).includes(box.id) };
  }, id);
  const noError = async () => assert.deepEqual(await page.$$eval('.pg .msg.error', els => els.map(e => e.textContent).filter(Boolean)), []);

  // ---- On load: one 16-character password with every kind, 104.6 bits ----
  let got = await pws();
  assert.equal(got.length, 1);
  assert.equal(got[0].length, 16);
  for (const ch of got[0]) assert.ok(ALL.includes(ch), `${ch} is printable ASCII`);
  assert.deepEqual(kindsOf(got[0]), { l: true, u: true, d: true, s: true });
  await expectStats('all-16');
  assert.equal(await page.evaluate(() => location.hash), '', 'defaults leave the address clean');
  assert.equal(await page.isEnabled('#pg-copy'), true);
  assert.equal(await page.isVisible('#pg-download'), false, 'Download appears only for several passwords');
  // Digits and symbols are tinted: their spans hold exactly the digits and the symbols.
  const tint = await page.evaluate(() => ({
    d: [...document.querySelectorAll('#pg-list .pg-d')].map(e => e.textContent).join(''),
    s: [...document.querySelectorAll('#pg-list .pg-s')].map(e => e.textContent).join(''),
    colours: [...new Set([...document.querySelectorAll('#pg-list .pg-d, #pg-list .pg-s')].map(e => getComputedStyle(e).color))].length,
  }));
  assert.equal(tint.d, got[0].replace(/[^0-9]/g, ''));
  assert.equal(tint.s, got[0].replace(/[A-Za-z0-9]/g, ''));
  assert.equal(tint.colours, 2, 'digits and symbols have their own colours');
  assert.ok(!(await page.title()).includes(got[0]));

  // ---- Lengths: slider, entropy, strength, time, and every kind in every password ----
  for (const L of [4, 8, 12, 15, 20, 32, 63, 64, 128]) {
    await setRange(L);
    await expectStats(`all-${L}`);
    assert.equal(await page.inputValue('#pg-len'), String(L));
    const p = (await pws())[0];
    assert.equal(p.length, L);
    assert.deepEqual(kindsOf(p), { l: true, u: true, d: true, s: true }, `every kind at length ${L}`);
  }
  assert.match(await text('#pg-len-hint'), /Over 63 is too long for a WPA2 Wi-Fi password\./);
  for (const rate of ['1e3', '1e4', '1e14']) {
    await page.selectOption('#pg-rate', rate);
    await expectStats('all-128', rate);
  }
  await page.selectOption('#pg-rate', '1e11');
  await setRange(12);
  for (const rate of ['1e3', '1e4', '1e11', '1e14']) {
    await page.selectOption('#pg-rate', rate);
    await expectStats('all-12', rate);
  }
  assert.match(await text('#pg-assumption'), /makes 100 trillion guesses a second/);
  await page.selectOption('#pg-rate', '1e11');
  assert.doesNotMatch(await text('#pg-len-hint'), /Wi-Fi/);

  // ---- The number box: typed, full-width digits, arrows, and its errors ----
  await typeLen('20');
  assert.equal(await page.inputValue('#pg-len-range'), '20');
  await expectStats('all-20');
  await typeLen('１２');
  await expectStats('all-12');
  assert.equal((await pws())[0].length, 12);
  await page.press('#pg-len', 'ArrowUp');
  assert.equal(await page.inputValue('#pg-len'), '13');
  await page.press('#pg-len', 'ArrowDown');
  await page.press('#pg-len', 'ArrowDown');
  assert.equal(await page.inputValue('#pg-len'), '11');
  await typeLen('abc');
  // The password goes at once, the message follows a pause in typing.
  assert.deepEqual(await pws(), []);
  assert.equal(await page.isDisabled('#pg-copy'), true);
  assert.equal(await text('#pg-bits'), '–');
  await page.waitForFunction(() => document.getElementById('pg-len-error').textContent !== '');
  assert.deepEqual(await fieldError('pg-len'), { text: 'Type the length as a whole number from 4 to 128.', invalid: 'true', linked: true });
  await typeLen('3');
  await page.press('#pg-len', 'Enter');
  assert.deepEqual(await fieldError('pg-len'), { text: 'The length must be from 4 to 128.', invalid: 'true', linked: true });
  await typeLen('129');
  await page.press('#pg-len', 'Tab');
  assert.equal((await fieldError('pg-len')).text, 'The length must be from 4 to 128.');
  await typeLen('16');
  await noError();
  assert.equal(await page.getAttribute('#pg-len', 'aria-invalid'), null);
  await expectStats('all-16');

  // ---- Presets ----
  for (const [label, L] of [['8 characters', 8], ['32 characters', 32], ['16 characters', 16]]) {
    await page.click(`#pg-presets button[aria-label="${label}"]`);
    assert.equal((await pws())[0].length, L);
    await expectStats(`all-${L}`);
  }
  await page.click('#pg-presets button:has-text("Wi-Fi")');
  await expectStats('wifi-20');
  assert.equal(await page.isChecked('#pg-symbols'), false);
  assert.equal(await page.isChecked('#pg-alike'), true);
  await page.selectOption('#pg-count', '100');
  for (const p of await pws()) {
    assert.match(p, /^[a-km-np-zA-HJ-NP-Z2-9]{20}$/, 'Wi-Fi: letters and digits without look-alikes');
    assert.deepEqual(kindsOf(p), { l: true, u: true, d: true, s: false });
  }
  await page.selectOption('#pg-count', '1');
  await page.check('#pg-symbols');
  await page.uncheck('#pg-alike');
  await page.click('#pg-presets button[aria-label="16 characters"]');
  await expectStats('all-16');

  // ---- Start with a letter, look-alikes, symbol sets, exclusions (100 at a time) ----
  await page.selectOption('#pg-count', '100');
  await page.check('#pg-first');
  await expectStats('first-letter-16');
  for (const p of await pws()) assert.match(p, /^[A-Za-z]/);
  await setRange(4);
  await expectStats('first-letter-4');
  await setRange(16);
  await page.uncheck('#pg-first');

  await page.check('#pg-alike');
  await expectStats('no-lookalikes-16');
  await setRange(128);
  for (const p of await pws()) assert.doesNotMatch(p, /[0Oo1lI|]/);
  await setRange(16);
  await page.uncheck('#pg-alike');

  await page.selectOption('#pg-sym', 'common');
  await expectStats('common-16');
  for (const p of await pws()) assert.match(p, /^[A-Za-z0-9!@#$%^&*]{16}$/);
  await page.selectOption('#pg-sym', 'own');
  assert.equal(await page.isVisible('#pg-own'), true);
  // An empty list is an error once typing pauses (or at once on leaving the box).
  assert.deepEqual(await pws(), []);
  await page.focus('#pg-own');
  await page.press('#pg-own', 'Tab');
  assert.deepEqual(await fieldError('pg-own'), { text: 'Type the symbols to use, or untick Symbols.', invalid: 'true', linked: true });
  await page.fill('#pg-own', '!!a1€ -😀');
  assert.equal(await text('#pg-own-hint'), 'Using 2 symbols: !-. Ignored: a 1 € 😀.');
  await noError();
  await expectStats('own-16');
  for (const p of await pws()) { assert.match(p, /^[A-Za-z0-9!-]{16}$/); assert.ok(kindsOf(p).s); }
  await page.fill('#pg-own', 'abc 123');
  await page.press('#pg-own', 'Tab');
  assert.deepEqual(await fieldError('pg-own'), { text: 'None of these can be used. Type ASCII symbols such as - _ . !', invalid: 'true', linked: true });
  await page.fill('#pg-own', '|');
  await page.check('#pg-alike');
  assert.deepEqual(await fieldError('pg-own'), { text: 'Your symbols are all look-alikes. Add others, or untick Avoid look-alikes.', invalid: 'true', linked: true });
  await page.uncheck('#pg-alike');
  await page.selectOption('#pg-sym', 'all');
  await noError();

  await page.fill('#pg-ex', 'abc');
  await expectStats('exclude-abc-16');
  for (const p of await pws()) assert.doesNotMatch(p, /[abc]/);
  await page.fill('#pg-ex', '0123456789');
  await page.press('#pg-ex', 'Tab');
  assert.deepEqual(await fieldError('pg-ex'), { text: 'Every digit is excluded. Allow at least one, or untick Digits.', invalid: 'true', linked: true });
  // The row where the password would be says why there is none.
  assert.equal(await text('#pg-list .pg-empty'), 'Every digit is excluded. Allow at least one, or untick Digits.');
  assert.equal(await page.isDisabled('#pg-copy'), true);
  assert.equal(await page.isDisabled('#pg-download'), true);
  await page.uncheck('#pg-digits');
  await noError();
  for (const p of await pws()) assert.doesNotMatch(p, /[0-9]/);
  await page.check('#pg-digits');
  await page.fill('#pg-ex', '');

  for (const id of ['pg-upper', 'pg-digits', 'pg-symbols']) await page.uncheck(`#${id}`);
  await expectStats('lower-16');
  await page.uncheck('#pg-lower');
  for (const id of ['pg-lower', 'pg-upper', 'pg-digits', 'pg-symbols']) {
    assert.deepEqual(await fieldError(id), { text: 'Tick at least one kind of character.', invalid: 'true', linked: true });
  }
  assert.deepEqual(await pws(), []);
  await page.check('#pg-digits');
  await page.check('#pg-first');
  assert.deepEqual(await fieldError('pg-first'), { text: 'Start with a letter needs Lowercase or Capitals.', invalid: 'true', linked: true });
  await page.uncheck('#pg-first');
  await page.check('#pg-lower');
  await page.check('#pg-upper');
  await setRange(12);
  await expectStats('letters-digits-12');
  await page.check('#pg-symbols');
  await setRange(16);
  await page.selectOption('#pg-count', '1');
  await noError();

  // ---- Exact draws: rejection sampling, and a missing kind redraws the whole password ----
  // 94 characters: values at or above floor(2^32 / 94) * 94 = 4294967254 are thrown away.
  await setRange(4);
  await page.evaluate(() => window.__queue.push(4294967254, 4294967253, 0, 26, 52));
  await page.click('#pg-new');
  assert.deepEqual(await pws(), ['~aA0']);
  // "aaaa" has no capital, digit or symbol: all four characters are drawn again.
  await page.evaluate(() => window.__queue.push(0, 0, 0, 0, 0, 26, 52, 62));
  await page.click('#pg-new');
  assert.deepEqual(await pws(), ['aA0!']);
  assert.equal(await page.evaluate(() => window.__queue.length), 0);
  // With a letter first, the first draw is from the 52 letters (limit 4294967248).
  await page.check('#pg-first');
  await page.evaluate(() => window.__queue.push(4294967248, 27, 0, 52, 62));
  await page.click('#pg-new');
  assert.deepEqual(await pws(), ['Ba0!']);
  await page.uncheck('#pg-first');

  // ---- Uniform characters: chi-square over 51,200 draws (93 degrees of freedom, p < 1e-6 at 172.7) ----
  await setRange(128);
  await page.selectOption('#pg-count', '100');
  const counts = new Map([...ALL].map(ch => [ch, 0]));
  let total = 0;
  for (let round = 0; round < 4; round++) {
    await page.click('#pg-new');
    for (const p of await pws()) { for (const ch of p) { counts.set(ch, counts.get(ch) + 1); total++; } }
  }
  assert.equal(total, 51200);
  assert.equal(counts.size, 94, 'only the 94 printable ASCII characters other than space');
  const e = total / 94, chi = [...counts.values()].reduce((s, c) => s + (c - e) ** 2 / e, 0);
  assert.ok(chi < 172.7, `chi-square ${chi}`);
  assert.equal(await page.evaluate(() => window.__mathRandom), undefined, 'Math.random is never used');

  // 100 passwords of 128 characters in little main-thread time.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const t0 = await threadMs();
  await page.click('#pg-new');
  const spent = (await threadMs()) - t0;
  assert.ok(spent < 400, `100 x 128 characters took ${spent} ms of main-thread time`);

  // ---- Copy, Copy all and Download ----
  await page.selectOption('#pg-count', '5');
  await setRange(16);
  const five = await pws();
  assert.equal(five.length, 5);
  assert.equal(await text('#pg-copy'), 'Copy all');
  assert.equal(await text('#pg-new'), 'New passwords');
  await page.click('#pg-list li:nth-child(3) button');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), five[2]);
  assert.equal(await page.getAttribute('#pg-list li:nth-child(3) button', 'aria-label'), 'Copy password 3');
  await page.click('#pg-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), five.join('\n'));
  let downloads = 0;
  page.on('download', () => downloads++);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.dblclick('#pg-download')]);
  assert.equal(dl.suggestedFilename(), 'passwords.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), five.join('\n') + '\n');
  await page.waitForTimeout(600);
  assert.equal(downloads, 1, 'a double click saves one file');
  assert.deepEqual(await pws(), five, 'saving does not draw new passwords');

  // ---- Keyboard: N and C only while focus is in the tool and not in a text box ----
  await page.selectOption('#pg-count', '1');
  await page.focus('#pg-lower');
  let before = (await pws())[0];
  await page.keyboard.press('n');
  let after = (await pws())[0];
  assert.notEqual(after, before, 'N makes a new password');
  assert.equal(await page.isChecked('#pg-lower'), true);
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), after, 'C copies it');
  await page.focus('#pg-ex');
  await page.keyboard.press('c');
  assert.equal(await page.inputValue('#pg-ex'), 'c', 'in a text box C is just typed');
  await page.fill('#pg-ex', '');
  before = (await pws())[0];
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('n');
  assert.equal((await pws())[0], before, 'outside the tool N does nothing');
  // Clicking the password puts focus in the tool, so C copies it.
  await page.click('#pg-list .pg-text');
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), before);
  // The main flow with Tab and Enter.
  await page.focus('#pg-new');
  await page.keyboard.press('Enter');
  after = (await pws())[0];
  assert.notEqual(after, before);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pg-copy');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), after);

  // ---- Screen reader summaries ----
  const status = () => page.waitForFunction(() => document.getElementById('pg-status').textContent).then(h => h.jsonValue());
  await page.click('#pg-new');
  assert.equal(await status(), 'New password: 16 characters, 104.6 bits, very strong, average time to crack about 4.8 trillion years.');
  await page.selectOption('#pg-rate', '1e3');
  await page.waitForFunction(() => /^At 1,000 guesses/.test(document.getElementById('pg-status').textContent));
  assert.equal(await text('#pg-status'), 'At 1,000 guesses a second: 16 characters, 104.6 bits, very strong, average time to crack about 4.8 × 10²⁰ years.');
  await page.selectOption('#pg-rate', '1e11');
  await page.selectOption('#pg-count', '5');
  await page.waitForFunction(() => /^5 new passwords/.test(document.getElementById('pg-status').textContent));
  assert.equal(await text('#pg-status'), '5 new passwords: 16 characters each, 104.6 bits, very strong, average time to crack about 4.8 trillion years.');
  await page.selectOption('#pg-count', '1');

  // ---- PIN mode ----
  await setRange(20);
  await page.check('input[name="pg-type"][value="pin"]');
  assert.equal(await page.inputValue('#pg-len'), '6');
  assert.equal(await status(), 'New PIN: 6 digits, 19.9 bits, weak, average time to crack less than a second.');
  assert.equal(await page.isVisible('#pg-password-options'), false);
  assert.match((await pws())[0], /^[0-9]{6}$/);
  assert.equal(await text('#pg-new'), 'New PIN');
  assert.equal(await text('#pg-space-label'), 'Possible PINs');
  for (const rate of ['1e3', '1e4', '1e11']) {
    await page.selectOption('#pg-rate', rate);
    await expectStats('pin-6', rate);
  }
  await page.selectOption('#pg-rate', '1e11');
  assert.match(await text('#pg-len-hint'), /safe only where wrong tries are limited/);
  for (const [label, name] of [['4 digits', 'pin-4'], ['8 digits', 'pin-8']]) {
    await page.click(`#pg-presets button[aria-label="${label}"]`);
    await expectStats(name);
  }
  await setRange(128);
  await expectStats('pin-128');
  await setRange(6);
  // 10 digits: values at or above 4294967290 are thrown away.
  await page.evaluate(() => window.__queue.push(9, 10, 4294967295, 4294967289, 0, 5, 7));
  await page.click('#pg-new');
  assert.deepEqual(await pws(), ['909057']);
  await page.fill('#pg-ex', '0123456789');
  await page.press('#pg-ex', 'Enter');
  assert.deepEqual(await fieldError('pg-ex'), { text: 'Every digit is excluded, so no PIN can be made.', invalid: 'true', linked: true });
  await page.fill('#pg-ex', '');
  await page.check('input[name="pg-type"][value="password"]');
  assert.equal(await page.inputValue('#pg-len'), '20', 'the password length comes back');
  assert.equal((await pws())[0].length, 20);

  // ---- Options in the address, never the password ----
  await setRange(24);
  await page.selectOption('#pg-sym', 'common');
  await page.check('#pg-first');
  await page.fill('#pg-ex', 'xyz&');
  await page.selectOption('#pg-count', '5');
  await page.selectOption('#pg-rate', '1e14');
  const hash = await page.evaluate(() => location.hash);
  assert.equal(hash, '#length=24&symbols=common&letter-first=yes&exclude=xyz%26&count=5&speed=1e14');
  for (const p of await pws()) assert.ok(!hash.includes(p) && !(await page.title()).includes(p));
  // A fresh load of that address (not just a change of the part after #) restores the options.
  await page.goto('about:blank');
  await page.goto(url + hash);
  assert.equal(await page.inputValue('#pg-len'), '24');
  assert.equal(await page.inputValue('#pg-sym'), 'common');
  assert.equal(await page.isChecked('#pg-first'), true);
  assert.equal(await page.inputValue('#pg-ex'), 'xyz&');
  assert.equal(await page.inputValue('#pg-rate'), '1e14');
  got = await pws();
  assert.equal(got.length, 5);
  for (const p of got) assert.match(p, /^[A-Za-w][A-Za-w0-9!@#$%^*]{23}$/);
  // Editing the address on the open page applies it too.
  await page.goto(url + '#type=pin&length=8');
  assert.match((await pws())[0], /^[0-9]{8}$/);
  // Values that are wrong, or keys such as __proto__, fall back to the defaults.
  await page.goto(url + '#length=999&use=zzz&symbols=constructor&count=__proto__&speed=toString&type=hasOwnProperty');
  await expectStats('all-16');
  assert.equal((await pws()).length, 1);
  await page.goto(url + '#own=' + 'x'.repeat(2000));
  await expectStats('all-16');
  await page.goto(url + '#symbols=own&own=' + encodeURIComponent('!-a1'));
  assert.equal(await page.inputValue('#pg-own'), '!-');
  await expectStats('own-16');

  // ---- Fields put back by the browser after the script ran (Back button) ----
  await page.goto(url);
  await page.$eval('#pg-len', el => { el.value = '20'; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal((await pws())[0].length, 20);
  await expectStats('all-20');

  // ---- A megabyte in every text box is cut before any pattern runs ----
  const big = 'x'.repeat(1 << 20);
  const t1 = await threadMs();
  for (const id of ['#pg-len', '#pg-ex']) {
    await page.$eval(id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, big);
  }
  await page.selectOption('#pg-sym', 'own');
  await page.$eval('#pg-own', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, '!'.repeat(199) + '😀' + big);
  assert.equal(await page.$eval('#pg-len', el => el.value.length), 4);
  assert.equal(await page.$eval('#pg-ex', el => el.value.length), 200);
  assert.equal(await page.$eval('#pg-own', el => el.value), '!'.repeat(199), 'the emoji is not cut in half');
  await page.$eval('#pg-own', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, '!'.repeat(198) + '😀' + big);
  assert.equal(await page.$eval('#pg-own', el => el.value), '!'.repeat(198) + '😀');
  assert.ok((await threadMs()) - t1 < 3000, 'a megabyte in each box is handled quickly');
  await page.goto(url);

  // ---- No password ever reaches the console ----
  for (const line of consoleLines) for (const p of await pws()) assert.ok(!line.includes(p));

  // ---- Guide links point at tools of this site ----
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/passphrase-generator/', '/password-strength-checker/', '/wifi-qr-code-generator/']);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), href);
  assert.match(await text('.faq'), /never a password, go into the page address/);

  // ---- Without crypto.getRandomValues nothing is made ----
  const browser = page.context().browser();
  const bare = await browser.newContext();
  const p3 = await bare.newPage();
  await p3.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'getRandomValues', { value: undefined }); });
  await p3.goto(url);
  assert.match(await p3.textContent('#pg-rng-error'), /no secure random number generator/);
  assert.equal(await p3.$$eval('#pg-list .pg-text:not(.pg-empty)', els => els.length), 0);
  assert.equal(await p3.isDisabled('#pg-copy'), true);
  await bare.close();

  // ---- A phone with a touch screen, in German (decimal comma) ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'de-DE' });
  await phone.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const p2 = await phone.newPage();
  const errors = [];
  p2.on('pageerror', e => errors.push(e.message));
  await p2.goto(url);
  assert.equal(await p2.evaluate(() => (1.5).toLocaleString()), '1,5');
  await p2.tap('#pg-new');
  const shown = (await p2.$$eval('#pg-list .pg-text', els => els.map(e => e.textContent)))[0];
  await p2.tap('#pg-copy');
  assert.equal(await p2.evaluate(() => navigator.clipboard.readText()), shown);
  await p2.fill('#pg-len', '1,6');
  await p2.press('#pg-len', 'Enter');
  assert.equal(await p2.textContent('#pg-len-error'), 'Type the length as a whole number from 4 to 128.');
  await p2.fill('#pg-len', '16');
  assert.ok((await p2.$eval('#pg-new', el => el.getBoundingClientRect().height)) >= 44);
  assert.ok((await p2.$eval('#pg-presets button', el => el.getBoundingClientRect().height)) >= 44);
  // 100 passwords of 128 characters wrap inside their rows; nothing is cut off at common widths.
  await p2.selectOption('#pg-count', '100');
  await p2.$eval('#pg-len-range', el => { el.value = '128'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p2.setViewportSize({ width, height: 800 });
    const cut = await p2.$$eval('.pg button, .pg .check', l => l.filter(e => e.getClientRects().length && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)).map(e => e.textContent.trim()));
    assert.deepEqual(cut, [], `nothing cut off at ${width}px`);
    // A select box shows the chosen option's text: every option must fit beside the arrow.
    const tight = await p2.$$eval('.pg select', l => {
      const ctx = document.createElement('canvas').getContext('2d');
      return l.flatMap(sel => {
        const cs = getComputedStyle(sel);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = sel.clientWidth - parseFloat(cs.paddingLeft) - 24;
        return [...sel.options].filter(o => ctx.measureText(o.text).width > room).map(o => o.text);
      });
    });
    assert.deepEqual(tight, [], `every option fits its select box at ${width}px`);
    assert.ok(await p2.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px`);
    assert.ok(await p2.$$eval('#pg-list .pg-text', l => l.every(e => e.scrollWidth <= e.clientWidth + 1)), `passwords wrap at ${width}px`);
  }
  assert.deepEqual(errors, []);
  await phone.close();
};
