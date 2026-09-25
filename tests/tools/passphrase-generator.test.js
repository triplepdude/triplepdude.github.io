const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIST_FILE = path.join(__dirname, '..', '..', 'assets', 'data', 'passphrase-generator', 'eff-large-wordlist.txt');

module.exports = async ({ page, open, assert }) => {
  // The word list must be the EFF long list unchanged: 7,776 words in dice order.
  // SHA-256 of the words-only file, computed from eff.org's eff_large_wordlist.txt
  // (sha256 addd3553...b903e) with the dice column removed.
  const listText = fs.readFileSync(LIST_FILE, 'utf8');
  assert.equal(crypto.createHash('sha256').update(listText).digest('hex'), '6d557f0693958fb5e650b68b5bee585eb82cf4da32965505c789e924743bc522');
  const list = listText.trim().split('\n');
  assert.equal(list.length, 7776);
  const inList = new Set(list);
  // The how-to says no word is the start of another, so "no separator" loses nothing.
  const sorted = [...list].sort();
  for (let i = 1; i < sorted.length; i++) assert.ok(!sorted[i].startsWith(sorted[i - 1]), `${sorted[i - 1]} is a prefix of ${sorted[i]}`);

  // Instrument randomness before any page script runs: queued values are fed
  // to crypto.getRandomValues first, and Math.random must never be used.
  await page.addInitScript(() => {
    const real = crypto.getRandomValues.bind(crypto);
    window.__queue = [];
    window.__calls = 0;
    crypto.getRandomValues = arr => {
      window.__calls++;
      real(arr);
      for (let i = 0; i < arr.length && window.__queue.length; i++) arr[i] = window.__queue.shift();
      return arr;
    };
    Math.random = () => { window.__mathRandom = true; return 0.5; };
  });
  await open();
  await page.waitForSelector('#pp-list .pp-item');

  const phrases = () => page.$$eval('#pp-list .pp-text', els => els.map(e => e.textContent));
  const setRange = v => page.$eval('#pp-words', (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  const text = sel => page.textContent(sel);

  // Defaults: 5 passphrases of 6 words from the list, hyphen-separated.
  let got = await phrases();
  assert.equal(got.length, 5);
  for (const p of got) {
    // Split on the separator spans so hyphenated words such as "t-shirt" stay whole.
    assert.equal(p.split('-').length >= 6, true);
  }
  const partsOf = () => page.$$eval('#pp-list .pp-text', els => els.map(e => Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent)));
  for (const parts of await partsOf()) {
    assert.equal(parts.length, 6);
    for (const w of parts) assert.ok(inList.has(w), `${w} is in the EFF list`);
  }
  assert.equal(await page.textContent('#pp-words-out'), '6');

  // Entropy: log2(7776) = 12.925 bits per word; times at 1e11 guesses/s
  // (average = 2^(bits-1) / rate), computed independently in Python.
  assert.equal(await text('#pp-bits'), '77.5 bits');
  assert.equal(await text('#pp-strength'), 'Strong');
  assert.equal(await text('#pp-time'), 'about 35 thousand years');
  assert.equal(await text('#pp-space'), '2.2 × 10²³');
  const vectors = [
    [3, '38.8 bits', 'Weak', 'about 2.4 seconds'],
    [4, '51.7 bits', 'Fair', 'about 5.1 hours'],
    [5, '64.6 bits', 'Good', 'about 4.5 years'],
    [7, '90.5 bits', 'Strong', 'about 270 million years'],
    [8, '103.4 bits', 'Very strong', 'about 2.1 trillion years'],
    [12, '155.1 bits', 'Very strong', 'about 7.7 × 10²⁷ years'],
  ];
  for (const [n, bits, label, time] of vectors) {
    await setRange(n);
    assert.equal(await text('#pp-bits'), bits, `${n} words`);
    assert.equal(await text('#pp-strength'), label, `${n} words`);
    assert.equal(await text('#pp-time'), time, `${n} words`);
    for (const parts of await partsOf()) assert.equal(parts.length, n);
  }
  // A slower attacker: 3 words at 1,000 guesses a second is about 7.4 years.
  await setRange(3);
  await page.selectOption('#pp-rate', '1e3');
  assert.equal(await text('#pp-time'), 'about 7.4 years');
  await page.selectOption('#pp-rate', '1e11');

  // Rejection sampling: with 3 words and no extras, each word takes one 32-bit draw.
  // limit = floor(2^32 / 7776) * 7776 = 4294964736; draws at or above it are discarded.
  await page.selectOption('#pp-count', '1');
  await page.evaluate(() => { window.__queue.push(0xFFFFFFFF, 0, 7775, 4294964736, 4294964735); });
  await page.click('#pp-generate');
  assert.equal((await phrases())[0], 'abacus-zoom-zoom');
  await page.evaluate(() => { window.__queue.push(7776 + 1295, 1296, 7776 * 3 + 2); });
  await page.click('#pp-generate');
  assert.equal((await phrases())[0], 'copilot-coping-abdominal');
  assert.equal(await page.evaluate(() => window.__queue.length), 0);

  // Separators and capitalisation (space separator makes words easy to split).
  await setRange(6);
  await page.selectOption('#pp-sep', ' ');
  await page.selectOption('#pp-case', 'title');
  for (const p of await phrases()) {
    const ws = p.split(' ');
    assert.equal(ws.length, 6);
    for (const w of ws) { assert.match(w, /^[A-Z][a-z-]*$/); assert.ok(inList.has(w.toLowerCase())); }
  }
  await page.selectOption('#pp-case', 'upper');
  assert.match((await phrases())[0], /^[A-Z-]+( [A-Z-]+){5}$/);
  await page.selectOption('#pp-case', 'one');
  assert.equal(await text('#pp-bits'), (6 * Math.log2(7776) + Math.log2(6)).toFixed(1) + ' bits');
  const oneCap = (await phrases())[0].split(' ');
  assert.equal(oneCap.filter(w => w === w.toUpperCase()).length, 1);
  await page.selectOption('#pp-sep', '');
  assert.equal((await phrases())[0].includes(' '), false);
  await page.selectOption('#pp-sep', 'custom');
  assert.equal(await page.isVisible('#pp-custom'), true);
  await page.fill('#pp-custom', '::');
  assert.equal((await phrases())[0].split('::').length, 6);

  // Digit and symbol: exactly one of each; entropy 6*12.925 + log2 6 + 2*log2 10 = 86.8 bits.
  await page.selectOption('#pp-sep', '-');
  await page.check('#pp-digit');
  await page.check('#pp-symbol');
  assert.equal(await text('#pp-bits'), '86.8 bits');
  await page.selectOption('#pp-count', '20');
  for (const p of await phrases()) {
    assert.equal((p.match(/[0-9]/g) || []).length, 1, p);
    assert.equal((p.match(/[!#$%&*+=?@]/g) || []).length, 1, p);
  }
  await page.uncheck('#pp-digit');
  await page.uncheck('#pp-symbol');
  await page.selectOption('#pp-case', 'lower');

  // Uniformity sanity check over 12,000 draws: chi-square on the first and last
  // dice digit (6 buckets each, 5 degrees of freedom; 36 is p < 1e-6).
  await setRange(12);
  await page.selectOption('#pp-count', '50');
  const index = new Map(list.map((w, i) => [w, i]));
  const first = new Array(6).fill(0), last = new Array(6).fill(0);
  const seen = new Set();
  let total = 0;
  for (let round = 0; round < 20; round++) {
    await page.click('#pp-generate');
    for (const parts of await partsOf()) {
      assert.equal(parts.length, 12);
      for (const w of parts) {
        const i = index.get(w);
        assert.ok(i !== undefined, `${w} is in the EFF list`);
        first[Math.floor(i / 1296)]++;
        last[i % 6]++;
        seen.add(w);
        total++;
      }
    }
  }
  assert.equal(total, 12000);
  const chi = counts => counts.reduce((s, c) => s + (c - total / 6) ** 2 / (total / 6), 0);
  assert.ok(chi(first) < 36, `first-die chi-square ${chi(first)}`);
  assert.ok(chi(last) < 36, `last-die chi-square ${chi(last)}`);
  // 12,000 draws from 7,776 words: about 6,080 distinct words expected.
  assert.ok(seen.size > 5600 && seen.size < 6500, `distinct words ${seen.size}`);
  assert.equal(await page.evaluate(() => window.__mathRandom), undefined, 'Math.random is never used');
  assert.ok(await page.evaluate(() => window.__calls) >= 12000);

  // Copy buttons put the exact passphrase on the clipboard.
  await page.selectOption('#pp-count', '5');
  await setRange(4);
  const shown = await phrases();
  await page.click('#pp-list .pp-item:nth-child(2) button');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shown[1]);
  await page.click('#pp-copy-all');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shown.join('\n'));
  assert.match(await page.textContent('#pp-list .pp-item:first-child .pp-len'), new RegExp(`^${shown[0].length} chars$`));

  // Dice lookup: 11111 is the first word, 66666 the last, 16666/21111 straddle a block.
  await page.fill('#pp-dice', '11111 66666 16666 21111');
  assert.equal(await text('#pp-dice-out'), 'abacus zoom copilot coping');
  await page.fill('#pp-dice', '12345 1234 70000');
  assert.match(await text('#pp-dice-error'), /five dice, each 1 to 6\. Check: 1234, 70000/);
  assert.equal(await text('#pp-dice-out'), '');
  // A long bad paste is shortened in the message and never widens a phone-sized page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.fill('#pp-dice', '1'.repeat(300) + ' 7 8 9 0 77 88');
  assert.match(await text('#pp-dice-error'), /Check: 111111111111…, 7, 8, 9, 0 and 2 more$/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'no horizontal scroll');
  await page.fill('#pp-dice', '');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Character counts are in code points, so an emoji separator counts once.
  await page.selectOption('#pp-sep', 'custom');
  await page.fill('#pp-custom', '🙂');
  const emo = (await phrases())[0];
  assert.equal(emo.split('🙂').length, 4);
  assert.equal(await page.textContent('#pp-list .pp-item:first-child .pp-len'), `${Array.from(emo).length} chars`);
  await page.selectOption('#pp-sep', '-');

  // Screen readers: the list and the stats are redrawn on every slider step, so they
  // are not live regions; one short summary is announced once the slider settles.
  for (const sel of ['#pp-list', '.pp-stats']) assert.equal(await page.getAttribute(sel, 'aria-live'), null, `${sel} is not live`);
  await page.evaluate(() => {
    window.__live = [];
    new MutationObserver(ms => ms.forEach(m => {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const r = n && n.closest('[aria-live]:not([aria-live="off"]), [role=status], [role=alert]');
      if (r && r.textContent) window.__live.push(r.id + ':' + r.textContent);
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  // 10 words: 129.2 bits; 2^128.2 / 1e11 / year = 1.28e20 and / 1e3 = 1.28e28 (Python).
  await setRange(6);
  await page.focus('#pp-words');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#pp-status').textContent !== '');
  await page.waitForTimeout(700);
  let live = await page.evaluate(() => window.__live);
  assert.deepEqual(live,
    ['pp-status:5 new passphrases: 10 words, 129.2 bits, very strong, average time to crack about 1.3 × 10²⁰ years.'], JSON.stringify(live));
  await page.evaluate(() => { window.__live = []; });
  await page.selectOption('#pp-rate', '1e3');
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => window.__live),
    ['pp-status:At 1,000 guesses a second: 10 words, 129.2 bits, very strong, average time to crack about 1.3 × 10²⁸ years.']);
  await page.selectOption('#pp-rate', '1e11');
  await setRange(6);

  // No layout shift while the word list loads: five placeholder rows the size of real
  // ones hold the space, and the attacker assumption is in the page from the start.
  // Measured with the list held back for a second, at desktop and phone sizes.
  for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [360, 640]]) {
    await page.setViewportSize({ width, height });
    let release;
    const held = new Promise(r => { release = r; });
    await page.route('**/eff-large-wordlist.txt', async route => { await held; await route.continue(); });
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__cls += e.value; }))
        .observe({ type: 'layout-shift', buffered: true });
    });
    await open();
    assert.equal(await page.$$eval('#pp-list .pp-placeholder', els => els.length), 5);
    assert.equal(await page.textContent('#pp-list .pp-placeholder .pp-text'), 'Loading the word list…');
    assert.match(await text('#pp-assumption'), /^Assumes the attacker .* 100 billion guesses a second\./);
    const before = await page.$eval('.pp-section', el => el.getBoundingClientRect().top);
    await page.waitForTimeout(1000);
    release();
    await page.waitForSelector('#pp-list .pp-item:not(.pp-placeholder)');
    await page.waitForTimeout(300);
    const cls = await page.evaluate(() => window.__cls);
    assert.ok(cls < 0.05, `CLS ${cls} at ${width}x${height}`);
    const after = await page.$eval('.pp-section', el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) <= 30, `options moved ${after - before}px at ${width}x${height}`);
    await page.unroute('**/eff-large-wordlist.txt');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Nothing is stored.
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
};
