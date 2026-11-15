const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Deterministic draws come from tests/fixtures/random-number-generator/reference.py, which
// applies the documented sampling method to fixed 32-bit words in Python (expected.json is
// its output). The same words are fed to the page in place of crypto.getRandomValues, so the
// page has to produce the same numbers. Everything else is checked against the real generator.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const byName = Object.fromEntries(expected.map(c => [c.name, c]));

  // Queued words are handed out first; Math.random must never be touched.
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

  const text = sel => page.textContent(sel);
  const attr = (sel, name) => page.getAttribute(sel, name);
  const out = () => text('#rn-out');
  const list = async () => (await out()).split(', ');
  const calls = () => page.evaluate(() => window.__calls);
  const hash = () => page.evaluate(() => location.hash);
  const status = want => page.waitForFunction(w => document.querySelector('#rn-status').textContent === w, want, { timeout: 3000 });
  // Queue the words and press Generate in one step, so no other draw can use them first.
  const drawWith = words => page.evaluate(w => { window.__queue = w.slice(); document.querySelector('#rn-generate').click(); }, words);
  const setUp = async (min, max, count, unique = false, places = 0) => {
    await page.fill('#rn-min', min);
    await page.fill('#rn-max', max);
    await page.fill('#rn-count', String(count));
    await page.setChecked('#rn-unique', unique);
    await page.selectOption('#rn-type', places ? 'dec' : 'int');
    if (places) await page.selectOption('#rn-places', String(places));
  };
  const inRange = (values, lo, hi) => values.every(v => /^-?\d+$/.test(v) && BigInt(v) >= BigInt(lo) && BigInt(v) <= BigInt(hi));

  // ---- The page opens with one number from 1 to 100 and says nothing yet. ----
  assert.match(await out(), /^\d{1,3}$/);
  assert.ok(inRange([await out()], 1, 100));
  assert.equal(await text('#rn-out-label'), 'Your random number');
  assert.equal(await text('#rn-info'), '1 whole number from 1 to 100. 100 possible values.');
  assert.equal(await text('#rn-status'), '');
  assert.equal(await hash(), '');
  assert.equal(await page.isVisible('#rn-places-field'), false);
  assert.equal(await page.isVisible('#rn-coin-note'), false);

  // ---- The Python reference: same words in, same numbers out. ----
  for (const c of expected) {
    if (c.name === 'coin') continue;
    await setUp(c.min, c.max, c.count, c.unique, c.places);
    await page.selectOption('#rn-order', 'drawn');
    await drawWith(c.words);
    assert.equal(await out(), c.numbers.join(', '), c.name);
    assert.equal(await page.evaluate(() => window.__queue.length), 0, `${c.name}: every word was used`);
    if (c.count > 1) assert.ok((await text('#rn-info')).endsWith(` Sum: ${c.sum}.`), `${c.name}: ${await text('#rn-info')}`);
    // Sorting shows the same draw in another order and takes no new random numbers.
    const before = await calls();
    await page.selectOption('#rn-order', 'asc');
    assert.equal(await out(), c.ascending.join(', '), c.name);
    await page.selectOption('#rn-order', 'desc');
    assert.equal(await out(), [...c.ascending].reverse().join(', '), c.name);
    await page.selectOption('#rn-order', 'drawn');
    assert.equal(await out(), c.numbers.join(', '), c.name);
    assert.equal(await calls(), before, `${c.name}: sorting did not draw again`);
  }
  // By hand, for 1 to 100 (seven bits per try): 127 and 100 are thrown away, 99 is 100, 0 is 1.
  assert.deepEqual(byName.rejections.numbers, ['100', '1']);
  assert.deepEqual(byName['both ends'].numbers, ['0.00', '1.00']);
  // A decimal minimum or maximum is honoured by whole numbers too: 1.5 to 10.2 is 2 to 10.
  await setUp('1.5', '10.2', 500);
  assert.ok(inRange(await list(), 2, 10));
  assert.equal(new Set(await list()).size, 9);
  assert.match(await text('#rn-info'), /^500 whole numbers from 2 to 10, repeats allowed\. 9 possible values\. Sum: \d+\.$/);

  // ---- The real generator: every value comes up about equally often. ----
  // 10,000 rolls of a dice: each face is expected 1,667 times with a standard deviation of 37.
  await setUp('1', '6', 10000);
  await page.click('#rn-generate');
  let rolls = await list();
  assert.equal(rolls.length, 10000);
  assert.equal(await text('#rn-out-label'), 'Your 10,000 random numbers');
  for (const face of ['1', '2', '3', '4', '5', '6']) {
    const n = rolls.filter(r => r === face).length;
    assert.ok(n > 1467 && n < 1867, `${face} came up ${n} times in 10,000 rolls`);
  }
  assert.equal(rolls.reduce((s, r) => s + Number(r), 0), Number((await text('#rn-info')).match(/Sum: (\d+)\./)[1]));
  // A range that is not a power of two (1 to 3): 3,333 each, standard deviation 47.
  await setUp('1', '3', 10000);
  await page.click('#rn-generate');
  rolls = await list();
  for (const v of ['1', '2', '3']) {
    const n = rolls.filter(r => r === v).length;
    assert.ok(n > 3083 && n < 3583, `${v} came up ${n} times in 10,000 draws`);
  }
  // Two draws in a row differ (the chance that 20 numbers from 1 to 1,000,000 repeat is nil).
  await setUp('1', '1000000', 20);
  await page.click('#rn-generate');
  const first = await out();
  await page.click('#rn-generate');
  assert.notEqual(await out(), first);
  await status('20 numbers generated.');

  // ---- No repeats. ----
  await setUp('1', '49', 49, true);
  await page.click('#rn-generate');
  let nums = await list();
  assert.deepEqual([...nums].sort((a, b) => a - b), Array.from({ length: 49 }, (_, i) => String(i + 1)));
  assert.equal(await text('#rn-info'), '49 different whole numbers from 1 to 49: every number once, in random order. Sum: 1225.');
  // 1,000 different numbers out of 10^30 possible ones, and exact above 2^53.
  await setUp('1', '1e30', 1000, true);
  await page.click('#rn-generate');
  nums = await list();
  assert.equal(new Set(nums).size, 1000);
  assert.ok(inRange(nums, 1, '1' + '0'.repeat(30)));
  assert.ok(nums.filter(n => n.length >= 28).length > 900, 'numbers are spread over the whole range');
  assert.ok(nums.some(n => BigInt(n) % 2n === 1n) && nums.some(n => BigInt(n) % 2n === 0n), 'the last digits are not rounded away');
  // A number too long to read at a glance is cut short in this line (never in the result).
  assert.match(await text('#rn-info'), /^1,000 different whole numbers from 1 to 100000000000…00000000 \(31 digits\)\. About 1\.00 × 10³⁰ possible values\. Sum: \d+\.$/);
  // More numbers than the range holds cannot be drawn without repeats.
  await setUp('1', '6', 10, true);
  await page.click('#rn-generate');
  assert.equal(await text('#rn-msg'), 'Only 6 different numbers are possible in this range, so 10 cannot be drawn without repeats. Ask for fewer, widen the range or untick “No repeats”.');
  assert.equal(await attr('#rn-count', 'aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'rn-count');
  await status('Only 6 different numbers are possible in this range, so 10 cannot be drawn without repeats. Ask for fewer, widen the range or untick “No repeats”.');
  // The list that was there stays until a new one can be drawn.
  assert.equal((await list()).length, 1000);
  await page.uncheck('#rn-unique');
  assert.equal(await text('#rn-msg'), '');
  assert.equal(await attr('#rn-count', 'aria-invalid'), null);
  assert.ok(inRange(await list(), 1, 6));
  assert.equal((await list()).length, 10);

  // ---- Errors. Each box points at the message. ----
  for (const id of ['rn-min', 'rn-max', 'rn-count', 'rn-unique']) assert.equal(await attr('#' + id, 'aria-describedby'), 'rn-msg');
  assert.equal(await page.$eval('#rn-msg', e => e.classList.contains('msg') && e.classList.contains('error')), true);
  const refuses = async (min, max, count, field, message, places = 0) => {
    await setUp(min, max, count, false, places);
    const shown = await out();
    await page.click('#rn-generate');
    assert.equal(await text('#rn-msg'), message);
    for (const id of ['rn-min', 'rn-max', 'rn-count']) assert.equal(await attr('#' + id, 'aria-invalid'), id === field ? 'true' : null, `${id} for ${message}`);
    assert.equal(await page.evaluate(() => document.activeElement.id), field);
    assert.equal(await out(), shown, 'the last result stays');
    assert.deepEqual([await page.inputValue('#rn-min'), await page.inputValue('#rn-max'), await page.inputValue('#rn-count')], [min, max, String(count)]);
  };
  await setUp('1', '100', 1);
  await refuses('abc', '100', 1, 'rn-min', 'The minimum must be a number, such as 1 or -50.');
  await refuses('1', '1 2', 1, 'rn-max', 'The maximum must be a number, such as 100.');
  await refuses('', '100', 1, 'rn-min', 'Enter the minimum, such as 1 or -50.');
  await refuses('1', '', 1, 'rn-max', 'Enter the maximum, such as 100.');
  await refuses('10', '5', 1, 'rn-max', 'The maximum is less than the minimum. Swap them or change one.');
  await refuses('1.2', '1.8', 1, 'rn-max', 'There is no whole number between 1.2 and 1.8. Widen the range or switch to decimals.');
  await refuses('0.001', '0.002', 1, 'rn-max', 'There is no number with 2 decimal places between 0.001 and 0.002. Use more decimal places or a wider range.', 2);
  for (const bad of ['0', '10001', '2.5', '-3', 'x', '1e9']) await refuses('1', '100', bad, 'rn-count', 'How many must be a whole number from 1 to 10,000.');
  await refuses('1', '100', '', 'rn-count', 'Enter how many numbers you want, from 1 to 10,000.');
  await refuses('1', '9'.repeat(1001), 1, 'rn-max', 'The maximum is too long. Use at most 1,000 digits before the decimal point and 20 after it.');
  await refuses('0.' + '1'.repeat(21), '5', 1, 'rn-min', 'The minimum is too long. Use at most 1,000 digits before the decimal point and 20 after it.');
  await refuses('1', '9'.repeat(1000), 10000, 'rn-count', 'That is more than a million characters of numbers. Ask for fewer numbers or use a shorter range.');
  // A thousand digits is allowed, and the number that comes out is exact.
  await setUp('1' + '0'.repeat(999), '9'.repeat(1000), 1);
  await page.click('#rn-generate');
  assert.equal(await text('#rn-msg'), '');
  assert.match(await out(), /^[1-9]\d{999}$/);
  // A new mistake is not flagged in the middle of typing, only once typing pauses;
  // putting it right clears the message at once and draws again.
  await setUp('1', '100', 1);
  assert.equal(await text('#rn-msg'), '');
  assert.equal(await page.evaluate(() => {
    const el = document.querySelector('#rn-max');
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#rn-msg').textContent + '|' + el.getAttribute('aria-invalid');
  }), '|null');
  await page.waitForFunction(() => /less than the minimum/.test(document.querySelector('#rn-msg').textContent), null, { timeout: 3000 });
  assert.equal(await attr('#rn-max', 'aria-invalid'), 'true');
  // The message is read out when it appears.
  await status('The maximum is less than the minimum. Swap them or change one.');
  await page.fill('#rn-max', '5');
  assert.equal(await text('#rn-msg'), '');
  assert.equal(await attr('#rn-max', 'aria-invalid'), null);
  await page.waitForFunction(() => /from 1 to 5\./.test(document.querySelector('#rn-info').textContent), null, { timeout: 3000 });
  assert.ok(inRange([await out()], 1, 5));
  // While a range is typed every pause draws again, but only the last result is read out.
  await page.waitForFunction(() => /^Your random number: [1-5]$/.test(document.querySelector('#rn-status').textContent), null, { timeout: 3000 });
  await page.evaluate(() => {
    window.__said = [];
    window.__drawn = new Set();
    new MutationObserver(() => { const t = document.querySelector('#rn-status').textContent; if (t) window.__said.push(t); })
      .observe(document.querySelector('#rn-status'), { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => window.__drawn.add(document.querySelector('#rn-info').textContent))
      .observe(document.querySelector('#rn-info'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#rn-max', '');
  await page.locator('#rn-max').pressSequentially('777', { delay: 600 });
  await page.waitForFunction(() => window.__said.length > 0, null, { timeout: 4000 });
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => [...window.__drawn].map(t => t.match(/to (\d+)\./)[1])), ['7', '77', '777']);
  const said = await page.evaluate(() => window.__said);
  assert.equal(said.length, 1, said.join(' / '));
  assert.equal(said[0], `Your random number: ${await out()}`);
  assert.equal(await text('#rn-msg'), '');
  // Numbers as people write them: thousands separators and a Unicode minus sign.
  await setUp('−1,000', '-999', 40);
  await page.click('#rn-generate');
  assert.ok(inRange(await list(), -1000, -999));
  assert.equal(new Set(await list()).size, 2);
  // Full-width and Arabic-Indic digits are read as the numbers they are (1 and 3).
  await setUp('１', '٣', 60);
  await page.click('#rn-generate');
  assert.equal(await text('#rn-msg'), '');
  assert.ok(inRange(await list(), 1, 3));
  assert.equal(new Set(await list()).size, 3);

  // ---- Decimals: every value has the chosen number of places, and both ends are possible. ----
  await setUp('0', '1', 2000, false, 2);
  assert.equal(await page.isVisible('#rn-places-field'), true);
  await page.click('#rn-generate');
  nums = await list();
  assert.ok(nums.every(n => /^(0\.\d\d|1\.00)$/.test(n)), 'two places, from 0.00 to 1.00');
  assert.ok(new Set(nums).size > 95, `${new Set(nums).size} of the 101 values came up in 2,000 draws`);
  assert.match(await text('#rn-info'), /^2,000 numbers with 2 decimal places from 0\.00 to 1\.00, repeats allowed\. 101 possible values\. Sum: \d+\.\d\d\.$/);
  await setUp('-0.5', '0.5', 300, true, 20);
  await page.click('#rn-generate');
  nums = await list();
  assert.ok(nums.every(n => /^-?0\.\d{20}$/.test(n)), 'twenty places');
  assert.equal(new Set(nums).size, 300);
  assert.ok(nums.some(n => n.startsWith('-')) && nums.some(n => !n.startsWith('-')));
  await setUp('5', '5', 1, false, 1);
  await page.click('#rn-generate');
  assert.equal(await out(), '5.0');
  assert.equal(await text('#rn-info'), '1 number with 1 decimal place from 5.0 to 5.0. 1 possible value.');
  await page.selectOption('#rn-type', 'int');
  assert.equal(await page.isVisible('#rn-places-field'), false);

  // ---- Presets. ----
  const fields = async () => [await page.inputValue('#rn-min'), await page.inputValue('#rn-max'), await page.inputValue('#rn-count'), await page.isChecked('#rn-unique'), await page.inputValue('#rn-order')];
  await page.click('[data-preset="ten"]');
  assert.deepEqual(await fields(), ['1', '10', '1', false, 'drawn']);
  assert.ok(inRange([await out()], 1, 10));
  assert.equal(await hash(), '#max=10');
  await page.click('[data-preset="hundred"]');
  assert.deepEqual(await fields(), ['1', '100', '1', false, 'drawn']);
  assert.equal(await hash(), '');
  await page.click('[data-preset="dice"]');
  assert.deepEqual(await fields(), ['1', '6', '1', false, 'drawn']);
  assert.ok(inRange([await out()], 1, 6));
  await status(`Your random number: ${await out()}`);
  // Two dice: pressing the preset again rolls again and keeps "How many".
  await page.fill('#rn-count', '2');
  await page.click('[data-preset="dice"]');
  assert.equal(await page.inputValue('#rn-count'), '2');
  nums = await list();
  assert.equal(nums.length, 2);
  assert.equal(await text('#rn-info'), `2 whole numbers from 1 to 6, repeats allowed. 6 possible values. Sum: ${Number(nums[0]) + Number(nums[1])}.`);
  // Lottery: six different numbers from 1 to 49, lowest first, and the odds.
  await page.click('[data-preset="lottery"]');
  assert.deepEqual(await fields(), ['1', '49', '6', true, 'asc']);
  nums = (await list()).map(Number);
  assert.equal(nums.length, 6);
  assert.ok(nums.every((n, i) => n >= 1 && n <= 49 && (i === 0 || n > nums[i - 1])), nums.join());
  // C(49, 6) = 13,983,816 (math.comb in the reference script's check).
  assert.equal(await text('#rn-info'), `6 different whole numbers from 1 to 49. 49 possible values and 13,983,816 possible combinations. Sum: ${nums.reduce((a, b) => a + b)}.`);
  assert.equal(await hash(), '#max=49&n=6&unique=1&order=asc');
  await drawWith(byName.lottery.words);
  assert.equal(await out(), byName.lottery.ascending.join(', '));
  // Coin flip: the reference's 1 is Heads and 2 is Tails.
  await page.click('[data-preset="coin"]');
  assert.match(await out(), /^(Heads|Tails)$/);
  assert.equal(await text('#rn-out-label'), 'Your coin flip');
  assert.equal(await text('#rn-info'), '1 coin flip.');
  assert.equal(await page.isVisible('#rn-coin-note'), true);
  assert.equal(await hash(), '#max=2&coin=1');
  await page.fill('#rn-count', '6');
  await drawWith(byName.coin.words);
  assert.equal(await out(), byName.coin.numbers.map(n => (n === '1' ? 'Heads' : 'Tails')).join(', '));
  assert.equal(await out(), 'Heads, Tails, Heads, Tails, Tails, Heads');
  assert.equal(await text('#rn-info'), '6 coin flips: 3 heads, 3 tails.');
  assert.equal(await text('#rn-out-label'), 'Your 6 coin flips');
  await status('Your 6 coin flips: Heads, Tails, Heads, Tails, Tails, Heads');
  // Emptying a box on the way to a new number keeps the coin; a different range ends it.
  await page.fill('#rn-count', '');
  await page.fill('#rn-count', '3');
  await page.click('#rn-generate');
  assert.match(await out(), /^(Heads|Tails), (Heads|Tails), (Heads|Tails)$/);
  await page.fill('#rn-max', '3');
  await page.click('#rn-generate');
  assert.ok(inRange(await list(), 1, 3));
  assert.equal(await page.isVisible('#rn-coin-note'), false);
  assert.equal(await hash(), '#max=3&n=3');

  // ---- List styles, copy and CSV. ----
  await setUp('1', '100', 20);
  await drawWith(byName['one to a hundred'].words);
  const twenty = byName['one to a hundred'].numbers;
  await page.selectOption('#rn-sep', 'line');
  assert.equal(await out(), twenty.join('\n'));
  await page.selectOption('#rn-sep', 'space');
  assert.equal(await out(), twenty.join(' '));
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  await page.click('#rn-copy');
  await page.waitForFunction(() => document.querySelector('#rn-copy').textContent === 'Copied!');
  assert.equal(await clip(), twenty.join(' '));
  await page.selectOption('#rn-sep', 'comma');
  await page.selectOption('#rn-order', 'desc');
  await page.click('#rn-copy');
  await page.waitForFunction(async want => (await navigator.clipboard.readText()) === want, [...byName['one to a hundred'].ascending].reverse().join(', '));
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rn-csv')]);
  assert.equal(dl.suggestedFilename(), 'random-numbers.csv');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), ['number', ...[...byName['one to a hundred'].ascending].reverse()].join('\r\n') + '\r\n');
  await page.selectOption('#rn-order', 'drawn');
  await page.click('[data-preset="coin"]');
  await page.fill('#rn-count', '6');
  await drawWith(byName.coin.words);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rn-csv')]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), 'flip\r\nHeads\r\nTails\r\nHeads\r\nTails\r\nTails\r\nHeads\r\n');

  // ---- Settings live in the address: a reload or a shared link brings them back. ----
  await setUp('-10', '10', 5, true, 3);
  await page.selectOption('#rn-order', 'asc');
  await page.selectOption('#rn-sep', 'line');
  await page.click('#rn-generate');
  assert.equal(await hash(), '#min=-10&max=10&n=5&unique=1&type=dec&dp=3&order=asc&sep=line');
  await page.reload({ waitUntil: 'load' });
  assert.deepEqual(await fields(), ['-10', '10', '5', true, 'asc']);
  assert.deepEqual([await page.inputValue('#rn-type'), await page.inputValue('#rn-places'), await page.inputValue('#rn-sep')], ['dec', '3', 'line']);
  assert.equal(await page.isVisible('#rn-places-field'), true);
  nums = (await out()).split('\n');
  assert.equal(nums.length, 5);
  assert.ok(nums.every((n, i) => /^-?\d{1,2}\.\d{3}$/.test(n) && Math.abs(Number(n)) <= 10 && (i === 0 || Number(n) > Number(nums[i - 1]))), nums.join());
  assert.equal(await text('#rn-status'), '', 'nothing is announced while the page opens');
  // The numbers themselves are never in the address.
  assert.ok(!nums.some(n => page.url().includes(n)));
  // What was typed is kept even when it is not a number yet.
  await page.fill('#rn-max', 'ten');
  await page.waitForFunction(() => location.hash.includes('max=ten'));
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.inputValue('#rn-max'), 'ten');
  assert.equal(await text('#rn-msg'), 'The maximum must be a number, such as 100.');
  assert.equal(await attr('#rn-max', 'aria-invalid'), 'true');
  // Opened like that there is nothing to show or copy yet, and the page says so.
  assert.equal(await out(), 'No numbers yet: see the message below.');
  assert.equal(await text('#rn-status'), '');
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));
  await page.click('#rn-copy');
  await page.waitForFunction(() => document.querySelector('#rn-copy').textContent === 'Nothing to copy yet');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'untouched');
  await page.fill('#rn-max', '10');
  await page.click('#rn-generate');
  assert.ok((await out()).split('\n').every(n => /^-?\d{1,2}\.\d{3}$/.test(n) && Math.abs(Number(n)) <= 10), await out());
  assert.equal(await page.$eval('#rn-out', e => e.classList.contains('rn-none')), false);
  // Following a link to other settings on the open page applies exactly that set-up:
  // what the link leaves out (here the minimum, the type and the order) is back at its default.
  await page.goto(url + '#max=6&n=3&unique=1&coin=1&sep=space', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#rn-out').textContent.split(' ').length === 3);
  assert.deepEqual(await fields(), ['1', '6', '3', true, 'drawn']);
  assert.deepEqual([await page.inputValue('#rn-type'), await page.inputValue('#rn-sep')], ['int', 'space']);
  nums = (await out()).split(' ');
  assert.equal(new Set(nums).size, 3);
  assert.ok(inRange(nums, 1, 6), 'coin=1 means nothing outside 1 to 2');
  assert.equal(await hash(), '#max=6&n=3&unique=1&sep=space');
  // The same link opened in a new tab.
  await page.goto('about:blank');
  await page.goto(url + '#max=6&n=3&unique=1&sep=space', { waitUntil: 'load' });
  nums = (await out()).split(' ');
  assert.equal(new Set(nums).size, 3);
  assert.ok(inRange(nums, 1, 6));
  assert.equal(await text('#rn-status'), '');
  // Rubbish in a link is ignored piece by piece.
  await page.goto('about:blank');
  await page.goto(url + '#type=%3Cb%3E&order=sideways&dp=99&n=2&min=%E0%A4%A&unique=yes', { waitUntil: 'load' });
  assert.deepEqual([await page.inputValue('#rn-type'), await page.inputValue('#rn-order'), await page.inputValue('#rn-places'), await page.inputValue('#rn-count'), await page.inputValue('#rn-min')], ['int', 'drawn', '2', '2', '1']);
  assert.equal(await page.isChecked('#rn-unique'), false);
  assert.equal((await list()).length, 2);
  // Changing the address by hand applies the new settings, and clearing it the defaults.
  await page.evaluate(() => { location.hash = 'min=7&max=7&n=1'; });
  await page.waitForFunction(() => document.querySelector('#rn-out').textContent === '7');
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForFunction(() => document.querySelector('#rn-info').textContent === '1 whole number from 1 to 100. 100 possible values.');
  assert.deepEqual(await fields(), ['1', '100', '1', false, 'drawn']);
  // A link to a heading of the guide is not a set-up: it is kept in the address, the
  // page opens at that heading, and the boxes keep their defaults.
  await page.goto('about:blank');
  await page.goto(url + '#lists-without-repeats', { waitUntil: 'load' });
  assert.equal(await hash(), '#lists-without-repeats');
  assert.deepEqual(await fields(), ['1', '100', '1', false, 'drawn']);
  assert.ok(inRange([await out()], 1, 100));
  await page.waitForFunction(() => Math.abs(document.getElementById('lists-without-repeats').getBoundingClientRect().top) < 40);
  // Jumping to a heading later changes no setting and draws nothing new...
  await page.click('[data-preset="dice"]');
  assert.equal(await hash(), '#max=6');
  const shownBeforeJump = await out(), callsBeforeJump = await calls();
  await page.evaluate(() => { location.hash = 'is-it-really-random'; });
  await page.waitForFunction(() => Math.abs(document.getElementById('is-it-really-random').getBoundingClientRect().top) < 40);
  assert.equal(await hash(), '#is-it-really-random');
  assert.deepEqual(await fields(), ['1', '6', '1', false, 'drawn']);
  assert.deepEqual([await out(), await calls()], [shownBeforeJump, callsBeforeJump]);
  // ...and the next change of a setting puts the set-up back in the address.
  await page.check('#rn-unique');
  assert.equal(await hash(), '#max=6&unique=1');

  // ---- Keyboard: Generate is the first stop; Enter on it draws again. Then type a
  // range, press Enter in a box, and Tab on to the other controls. ----
  await page.goto(url, { waitUntil: 'load' });
  const tabs = async n => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => document.activeElement.id || document.activeElement.getAttribute('data-preset')));
    }
    return seen;
  };
  await page.focus('#rn-generate');
  const drawsBefore = await calls();
  await page.keyboard.press('Enter');
  assert.equal(await calls(), drawsBefore + 1);
  await status(`Your random number: ${await out()}`);
  assert.deepEqual(await tabs(3), ['rn-copy', 'rn-csv', 'rn-min']);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('50');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'rn-max');
  await page.keyboard.type('59');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /from 50 to 59\./.test(document.querySelector('#rn-info').textContent));
  assert.ok(inRange([await out()], 50, 59));
  await status(`Your random number: ${await out()}`);
  assert.equal(await attr('#rn-status', 'role'), 'status');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'rn-max');
  assert.deepEqual(await tabs(3), ['rn-count', 'rn-unique', 'ten']);
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; });
  assert.equal(ring, 'solid 2px');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#rn-max'), '10');
  // Space ticks "No repeats" and draws at once.
  await page.fill('#rn-count', '10');
  await page.focus('#rn-unique');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => /every number once/.test(document.querySelector('#rn-info').textContent));
  assert.deepEqual((await list()).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The result box is not itself a live region; one hidden status line is.
  assert.equal(await attr('#rn-out', 'aria-live'), null);
  assert.equal(await page.locator('[role="status"]').count() >= 1, true);
  // A list that scrolls inside its box can be reached and scrolled from the keyboard.
  assert.equal(await attr('#rn-out', 'tabindex'), null);
  await setUp('1', '1000000', 2000);
  await page.click('#rn-generate');
  assert.equal(await attr('#rn-out', 'tabindex'), '0');
  assert.ok(await page.$eval('#rn-out', e => e.scrollHeight > e.clientHeight && e.clientHeight <= 342));
  assert.equal(await page.$eval('#rn-out', e => e.getAttribute('role') + ' ' + document.getElementById(e.getAttribute('aria-labelledby')).textContent), 'group Your 2,000 random numbers');

  assert.equal(await page.evaluate(() => window.__mathRandom), undefined, 'Math.random was never called');

  // ---- A phone with a touch screen. ----
  const phone = await page.context().browser().newContext({ ...devices['iPhone 13'] });
  const p = await phone.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(url, { waitUntil: 'load' });
  assert.equal(await p.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  // The first number is on the first screen, under the Generate button.
  const box = await p.locator('#rn-out').boundingBox();
  assert.ok(box.y + box.height <= 664, `the result ends at ${box.y + box.height}px`);
  await p.tap('#rn-max');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('3');
  await p.tap('#rn-generate');
  await p.waitForFunction(() => /from 1 to 3\./.test(document.querySelector('#rn-info').textContent));
  assert.match(await p.textContent('#rn-out'), /^[123]$/);
  // A preset further down the page brings the result back into view.
  await p.locator('[data-preset="lottery"]').scrollIntoViewIfNeeded();
  await p.evaluate(() => window.scrollBy(0, 300));
  await p.tap('[data-preset="lottery"]');
  await p.waitForFunction(() => document.querySelector('#rn-out').textContent.split(', ').length === 6);
  await p.waitForFunction(() => { const r = document.querySelector('#rn-out').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  await p.tap('#rn-unique');
  assert.equal(await p.isChecked('#rn-unique'), false);
  // Controls are at least 44 px tall and text boxes at least 16 px, so iOS does not zoom in.
  const sizes = await p.$$eval('.rn input[type="text"], .rn select, .rn button, .rn .check', els => els.filter(e => e.getClientRects().length).map(e => ({ id: e.id || e.textContent.trim(), h: e.getBoundingClientRect().height, font: parseFloat(getComputedStyle(e).fontSize), tag: e.tagName })));
  assert.equal(sizes.length, 15);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.tag === 'INPUT' || s.tag === 'SELECT') assert.ok(s.font >= 16, `${s.id} has ${s.font}px text`);
  }
  // A 1,000-digit number and a long message wrap at 320 px instead of widening the page.
  await p.setViewportSize({ width: 320, height: 568 });
  await p.fill('#rn-min', '1' + '0'.repeat(999));
  await p.fill('#rn-max', '9'.repeat(1000));
  await p.fill('#rn-count', '3');
  await p.tap('#rn-generate');
  await p.waitForFunction(() => document.querySelector('#rn-out').textContent.length > 3000);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'no sideways scroll with long numbers');
  await p.check('#rn-unique');
  await p.fill('#rn-min', '1');
  await p.fill('#rn-max', '2');
  await p.tap('#rn-generate');
  assert.match(await p.textContent('#rn-msg'), /^Only 2 different numbers are possible/);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'no sideways scroll with an error');
  assert.deepEqual(errors, []);
  await phone.close();
};
