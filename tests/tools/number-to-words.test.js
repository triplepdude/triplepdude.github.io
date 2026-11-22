const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected words come from tests/fixtures/number-to-words/expected.py (the num2words
// library: British English with commas, and American English as the same words without
// "and" and commas), and the cheque wordings from the guides quoted next to each check.
// Nothing is read back from the page.
module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await open();
  const text = (sel, on = page) => on.locator(sel).textContent();
  const out = (id, on = page) => text(`#nw-o-${id}`, on);
  const fill = (v, on = page) => on.fill('#nw-input', v);
  const set = async (opts, on = page) => {
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'commas') await on.setChecked('#nw-commas', v);
      else await on.selectOption(`#nw-${k}`, v);
    }
  };
  const results = (on = page) => on.$$eval('.nw-item', lis => Object.fromEntries(lis.map(li => [li.querySelector('.nw-copy').dataset.row,
    { text: li.querySelector('.nw-out').textContent, note: li.querySelector('.nw-note').textContent, disabled: li.querySelector('.nw-copy').disabled }])));
  const settles = (sel, expected, on = page) => on.waitForFunction(([s, t]) => document.querySelector(s).textContent === t, [sel, expected], { timeout: 10000 })
    .catch(async () => assert.equal(await on.locator(sel).textContent(), expected));
  const copied = async (id, click = () => page.click(`#nw-c-${id}`), on = page) => {
    await on.evaluate(() => navigator.clipboard.writeText('(nothing copied yet)'));
    await click();
    await on.waitForFunction(async () => (await navigator.clipboard.readText()) !== '(nothing copied yet)', null, { timeout: 5000 }).catch(() => {});
    return on.evaluate(() => navigator.clipboard.readText());
  };
  const grouped = n => BigInt(n).toLocaleString('en-US');
  const us = s => s.replace(/,/g, '').replace(/ and /g, ' ');

  // ---- Defaults in an American English browser: the example, nothing announced on load ----
  assert.equal(await page.inputValue('#nw-input'), '1234.56');
  for (const [id, v] of Object.entries({ style: 'us', scale: 'short', mark: '.', dec: 'point', cur: 'usd', case: 'lower' })) {
    assert.equal(await page.inputValue(`#nw-${id}`), v, id);
  }
  assert.equal(await text('#nw-read'), 'Read as 1,234.56.');
  let r = await results();
  assert.equal(r.words.text, 'one thousand two hundred thirty-four point five six');
  assert.equal(r.ordinal.text, 'Only whole numbers have an ordinal.');
  assert.equal(r.ordinal.disabled, true);
  assert.equal(r.money.text, 'one thousand two hundred thirty-four dollars and fifty-six cents');
  assert.equal(r.cheque.text, 'one thousand two hundred thirty-four and 56/100');
  assert.equal(r.cheque.note, 'Most US checks print the word Dollars at the end of this line. Draw a line through any space you leave.');
  await page.waitForTimeout(900);
  assert.equal(await text('#nw-status'), '');
  assert.equal(await text('#nw-error'), '');
  assert.equal(await page.getAttribute('#nw-input', 'aria-invalid'), null);

  // ---- Whole numbers up to 66 digits against num2words, American and British ----
  for (const c of data.cardinal) {
    await fill(c.n);
    assert.equal(await out('words'), c.us, `American ${c.n}`);
  }
  await set({ style: 'uk', commas: true });
  for (const c of data.cardinal) {
    await fill(c.n);
    assert.equal(await out('words'), c.uk, `British ${c.n}`);
  }
  await set({ commas: false });
  await fill('2026');
  assert.equal(await out('words'), 'two thousand and twenty-six');
  await fill('105');
  assert.equal(await out('words'), 'one hundred and five');

  // ---- Ordinals, in words and in figures ----
  for (const o of data.ordinal) {
    await fill(o.n);
    assert.equal(await out('ordinal'), o.uk.replace(/,/g, ''), `British ordinal ${o.n}`);
    assert.equal(await out('ordinal-figures'), grouped(o.n) + o.num.slice(o.n.length), `ordinal figures ${o.n}`);
  }
  await set({ style: 'us' });
  for (const o of data.ordinal) {
    await fill(o.n);
    assert.equal(await out('ordinal'), o.us, `American ordinal ${o.n}`);
  }
  await fill('-3');
  assert.equal(await out('ordinal'), 'Negative numbers have no ordinal.');
  await fill('7.00');
  assert.equal(await out('ordinal'), 'seventh');

  // ---- The Indian system: num2words (en_IN) up to 999 crore, and lakh crore by hand ----
  await set({ scale: 'indian', style: 'uk', commas: true });
  for (const c of data.indian) {
    await fill(c.n);
    assert.equal(await out('words'), c.uk, `Indian ${c.n}`);
  }
  await set({ commas: false, style: 'us' });
  for (const c of data.indian) {
    await fill(c.n);
    assert.equal(await out('words'), us(c.uk), `Indian, American style ${c.n}`);
  }
  for (const [n, w] of [['1000000000000', 'one lakh crore'], ['1250000000000', 'one lakh twenty-five thousand crore'], ['100000000000000', 'one crore crore']]) {
    await fill(n);
    assert.equal(await out('words'), w, n);
  }
  await fill('1234567');
  assert.equal(await text('#nw-read'), 'Read as 12,34,567.');
  assert.deepEqual(await page.$$eval('#nw-places tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent))),
    [['12', 'lakh', 'twelve lakh'], ['34', 'thousand', 'thirty-four thousand'], ['567', 'units', 'five hundred sixty-seven']]);

  // ---- The long scale: a billion is a million million ----
  await set({ scale: 'long' });
  for (const [n, w] of [['1000000000', 'one thousand million'], ['1500000000', 'one thousand five hundred million'], ['1000000000000', 'one billion'],
    ['2000000000000000', 'two thousand billion'], ['1' + '0'.repeat(60), 'one decillion'], ['1000000000005001', 'one thousand billion five thousand one']]) {
    await fill(n);
    assert.equal(await out('words'), w, n);
  }
  await set({ style: 'uk' });
  await fill('1005000000');
  assert.equal(await out('words'), 'one thousand and five million');
  await fill('1000000000001');
  assert.equal(await out('words'), 'one billion and one');
  await set({ scale: 'short', style: 'us' });
  await fill('1234567');
  assert.equal(await text('#nw-read'), 'Read as 1,234,567.');
  assert.deepEqual(await page.$$eval('#nw-places tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent))),
    [['1', 'million', 'one million'], ['234', 'thousand', 'two hundred thirty-four thousand'], ['567', 'units', 'five hundred sixty-seven']]);
  await fill('999');
  assert.equal(await page.isVisible('#nw-places-wrap'), false);
  // From four digits on, the table shows the groups.
  await fill('1234');
  assert.deepEqual(await page.$$eval('#nw-places tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent))),
    [['1', 'thousand', 'one thousand'], ['234', 'units', 'two hundred thirty-four']]);
  assert.equal(await page.isVisible('#nw-places-wrap'), true);

  // ---- Decimals: point, fraction words and figures over a power of ten ----
  const decimals = {
    point: [['3.14', 'three point one four'], ['0.5', 'zero point five'], ['2.50', 'two point five zero'], ['-0.75', 'minus zero point seven five']],
    fraction: [['3.14', 'three and fourteen hundredths'], ['0.001', 'one thousandth'], ['0.25', 'twenty-five hundredths'], ['1.5', 'one and five tenths'],
      ['0.0000003', 'three ten-millionths'], ['0.00005', 'five hundred-thousandths'], ['7.000001', 'seven and one millionth'], ['5.00', 'five'], ['0.' + '0'.repeat(64) + '1', 'one hundred-vigintillionth'], ['-2.1', 'minus two and one tenth']],
    over: [['3.14', 'three and 14/100'], ['0.5', '5/10'], ['12.05', 'twelve and 05/100']],
  };
  for (const [mode, cases] of Object.entries(decimals)) {
    await set({ dec: mode });
    for (const [n, w] of cases) {
      await fill(n);
      assert.equal(await out('words'), w, `${mode} ${n}`);
    }
  }
  await set({ scale: 'long', dec: 'fraction' });
  for (const [n, w] of [['0.000000001', 'one thousand-millionth'], ['0.001', 'one thousandth'], ['0.0001', 'one ten-thousandth'], ['0.00003', 'three hundred-thousandths'],
    ['0.000001', 'one millionth'], ['0.0000001', 'one ten-millionth'], ['0.' + '0'.repeat(11) + '7', 'seven billionths'], ['0.' + '0'.repeat(14) + '1', 'one thousand-billionth'],
    ['0.' + '0'.repeat(64) + '1', 'one hundred-thousand-decillionth']]) {
    await fill(n);
    assert.equal(await out('words'), w, `long scale ${n}`);
  }
  await set({ scale: 'short', dec: 'point' });
  // Scientific notation is exact too.
  for (const [n, w] of [['1e21', 'one sextillion'], ['1.5e6', 'one million five hundred thousand'], ['2.5e-3', 'zero point zero zero two five'], ['-4E2', 'minus four hundred']]) {
    await fill(n);
    assert.equal(await out('words'), w, n);
  }

  // ---- Money and cheques: the wordings of the bank and consumer guides ----
  // Huntington: $130.45 is "one hundred thirty and 45/100"; Chase: $105.50 is "one hundred
  // five dollars and fifty cents"; whole dollars take "and 00/100".
  await fill('130.45');
  assert.equal(await out('cheque'), 'one hundred thirty and 45/100');
  await fill('105.50');
  assert.equal(await out('money'), 'one hundred five dollars and fifty cents');
  await fill('500');
  assert.equal(await out('cheque'), 'five hundred and 00/100');
  await fill('0.07');
  r = await results();
  assert.deepEqual([r.money.text, r.cheque.text], ['seven cents', 'zero and 07/100']);
  await fill('1');
  assert.equal(await out('money'), 'one dollar');
  // money.co.uk: £56.23 is "Fifty-six pounds and twenty-three pence only".
  await set({ cur: 'gbp', style: 'uk', case: 'sentence' });
  await fill('£56.23');
  assert.equal(await out('cheque'), 'Fifty-six pounds and twenty-three pence only');
  await fill('1,234.56');
  assert.equal(await out('cheque'), 'One thousand two hundred and thirty-four pounds and fifty-six pence only');
  assert.equal(await out('money'), 'One thousand two hundred and thirty-four pounds and fifty-six pence');
  await fill('0.01');
  assert.deepEqual([await out('money'), await out('cheque')], ['One penny', 'One penny only']);
  await fill('2.02');
  assert.equal(await out('money'), 'Two pounds and two pence');
  // Paytm: ₹1,00,000 is "Rupees One Lakh Only", and ₹2,00,000 "Rupees Two Lakh Only".
  await set({ cur: 'inr', scale: 'indian', case: 'title' });
  await fill('₹1,00,000');
  assert.equal(await out('cheque'), 'Rupees One Lakh Only');
  await fill('Rs. 2,00,000/-');
  assert.equal(await out('cheque'), 'Rupees Two Lakh Only');
  await fill('1,25,000.50');
  assert.equal(await out('cheque'), 'Rupees One Lakh Twenty-Five Thousand and Fifty Paise Only');
  await fill('1.01');
  assert.equal(await out('money'), 'One Rupee and One Paisa');
  await fill('0.50');
  assert.equal(await out('cheque'), 'Fifty Paise Only');
  await set({ cur: 'eur', scale: 'short', case: 'upper', style: 'us' });
  await fill('2.50');
  r = await results();
  assert.equal(r.money.text, 'TWO EUROS AND FIFTY CENTS');
  assert.equal(r.cheque.text, 'Cheque wording is given for dollars, pounds and rupees. For euros, copy the money line.');
  assert.equal(r.cheque.disabled, true);
  await set({ cur: 'usd', case: 'lower' });
  await fill('1.005');
  r = await results();
  assert.equal(r.money.text, 'Money has at most two decimal places, so round 1.005 first.');
  assert.equal(r.money.disabled, true);
  assert.equal(r.words.text, 'one point zero zero five');
  await fill('2.500');
  assert.equal(await out('money'), 'two dollars and fifty cents');
  await fill('-5');
  r = await results();
  assert.deepEqual([r.words.text, r.money.text, r.cheque.text], ['minus five', 'minus five dollars', 'A cheque cannot be written for a negative amount.']);
  await fill('-0');
  assert.equal(await out('words'), 'zero');
  // A currency sign or code typed with the number chooses the currency.
  for (const [n, cur, money] of [['£5', 'gbp', 'five pounds'], ['5 EUR', 'eur', 'five euros'], ['Rs. 2,00,000/-', 'inr', 'two hundred thousand rupees'],
    ['500/-', 'inr', 'five hundred rupees'], ['-$1.50', 'usd', 'minus one dollar and fifty cents'], ['¥5', 'usd', 'five dollars']]) {
    await fill(n);
    assert.equal(await page.inputValue('#nw-cur'), cur, n);
    assert.equal(await out('money'), money, n);
  }
  // A choice made after typing stands until the number is typed again.
  await fill('£5');
  await set({ cur: 'eur' });
  assert.equal(await out('money'), 'five euros');
  await set({ cur: 'usd' });

  // ---- Letter case and commas ----
  await fill('1234567');
  for (const [mode, w] of [['lower', 'one million two hundred thirty-four thousand five hundred sixty-seven'], ['sentence', 'One million two hundred thirty-four thousand five hundred sixty-seven'],
    ['title', 'One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven'], ['upper', 'ONE MILLION TWO HUNDRED THIRTY-FOUR THOUSAND FIVE HUNDRED SIXTY-SEVEN']]) {
    await set({ case: mode });
    assert.equal(await out('words'), w, mode);
  }
  // In sentence case only the whole number starts with a capital, not each group in the table.
  await set({ case: 'sentence' });
  assert.deepEqual(await page.$$eval('#nw-places td.nw-w', tds => tds.map(td => td.textContent)), ['one million', 'two hundred thirty-four thousand', 'five hundred sixty-seven']);
  await set({ case: 'title' });
  assert.deepEqual(await page.$$eval('#nw-places td.nw-w', tds => tds.map(td => td.textContent)), ['One Million', 'Two Hundred Thirty-Four Thousand', 'Five Hundred Sixty-Seven']);
  await set({ case: 'title', style: 'uk', commas: true });
  await fill('1001.5');
  assert.equal(await out('cheque'), 'One Thousand and One and 50/100');
  assert.equal(await out('money'), 'One Thousand and One Dollars and Fifty Cents');
  await set({ case: 'lower', style: 'us', commas: false });

  // ---- How the number is read: grouping marks, signs, symbols, other digits ----
  const reads = [['1 234 567', 'Read as 1,234,567.'], ['12,34,567', 'Read as 1,234,567.'], ['1_000_000', 'Read as 1,000,000.'], ["1'234'567.89", 'Read as 1,234,567.89.'],
    ['$1,234.56', 'Read as 1,234.56.'], ['1,234.56 USD', 'Read as 1,234.56.'], ['−5', 'Read as −5.'], ['+5', 'Read as 5.'], ['١٬٢٣٤٫٥٦', 'Read as 1,234.56.'],
    ['１２３', 'Read as 123.'], ['１２３，４５６．７', 'Read as 123,456.7.'], ['－５', 'Read as −5.'], ['–5', 'Read as −5.'], ['$–1.5', 'Read as −1.5.'],
    ['007', 'Read as 7.'], ['.5', 'Read as 0.5.'], ['5.', 'Read as 5.'],
    ['1,234', 'Read as 1,234. The comma groups thousands. If it is your decimal mark, choose Comma (1.234,5).'],
    ['1.234', 'Read as 1.234. The dot is read as the decimal mark. If it groups thousands, choose Comma (1.234,5).']];
  for (const [n, read] of reads) {
    await fill(n);
    assert.equal(await text('#nw-read'), read, n);
    assert.equal(await text('#nw-error'), '', n);
  }

  // ---- Errors: a message tied to the box, and no results ----
  const comma = ' If the comma is your decimal mark, choose Comma (1.234,5) under Decimal mark.';
  const errors = [
    ['1,5', 'A comma can only stand between groups of three digits, as in 1,234,567.' + comma],
    ['0,500', 'A number with grouped digits cannot start with 0.' + comma],
    ['1.234.567', 'A number has one decimal point, and this one has more. If dots group the thousands here, choose Comma (1.234,5) under Decimal mark.'],
    ['1 2', 'A space can only stand between groups of three digits, as in 1 234 567. Type one number.'],
    ['1,234 567', 'Use one kind of mark between groups of digits, not two.'],
    ['5²', '“²” is not one of the digits 0 to 9.'],
    ['1\t2', 'Type one number: a tab or line break separates two numbers here.'],
    ['twenty', 'Type the number in figures, such as 1234.56. This page turns figures into words.'],
    ['--5', 'This number has two signs. Type one minus sign at most.'],
    ['–−5', 'This number has two signs. Type one minus sign at most.'],
    ['5–10', '“–” is not part of a number.'],
    ['$', 'There are no digits in this number.'],
    ['5 %', '“%” is not part of a number.'],
    ['1' + '0'.repeat(66), 'This number has 67 digits before the decimal mark. Words go up to 66 digits (999 vigintillion and so on).'],
    ['1e66', 'This number has 67 digits before the decimal mark. Words go up to 66 digits (999 vigintillion and so on).'],
    ['0.' + '1'.repeat(66), 'This number has 66 digits after the decimal mark. Words go up to 65.'],
  ];
  for (const [n, msg] of errors) {
    await fill(n);
    assert.equal(await text('#nw-error'), msg, n);
    assert.equal(await page.getAttribute('#nw-input', 'aria-invalid'), 'true', n);
    r = await results();
    assert.equal(r.words.text, 'Correct the number above to see it in words.', n);
    assert.ok(Object.values(r).every(x => x.disabled), `${n}: copy buttons disabled`);
  }
  assert.deepEqual((await page.getAttribute('#nw-input', 'aria-describedby')).split(' '), ['nw-read', 'nw-error']);
  await fill('9'.repeat(66));
  assert.equal(await text('#nw-error'), '');
  assert.equal(await page.getAttribute('#nw-input', 'aria-invalid'), null);
  assert.ok((await out('words')).startsWith('nine hundred ninety-nine vigintillion nine hundred ninety-nine novemdecillion'));
  // A megabyte paste is refused at once, before any pattern reads it.
  const t0 = Date.now();
  await page.$eval('#nw-input', el => { el.value = '1'.repeat(1048576); el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#nw-error'), 'This is 1,048,576 characters long. A number here has up to 66 digits before the decimal mark and 65 after it.');
  assert.ok(Date.now() - t0 < 1500, `a megabyte paste took ${Date.now() - t0} ms`);
  await settles('#nw-status', 'This is 1,048,576 characters long. A number here has up to 66 digits before the decimal mark and 65 after it.');
  await fill('');
  r = await results();
  assert.equal(r.words.text, 'Type a number in figures, such as 1234.56.');
  assert.equal(await text('#nw-error'), '');

  // ---- One spoken summary after typing pauses ----
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__nwChanges = 0;
    new MutationObserver(() => window.__nwChanges++).observe(document.querySelector('#nw-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#nw-input').pressSequentially('1001', { delay: 40 });
  await settles('#nw-status', '1,001 in words: one thousand one.');
  assert.equal(await page.evaluate(() => window.__nwChanges), 1);
  await set({ cur: 'gbp' });
  await settles('#nw-status', 'Money: one thousand one pounds.');
  await set({ cur: 'usd' });
  await settles('#nw-status', 'Money: one thousand one dollars.');
  await set({ case: 'upper' });
  await settles('#nw-status', '1,001 in words: ONE THOUSAND ONE.');
  await set({ case: 'lower' });

  // ---- Copy: the exact text of each result, a confirmation, and never an old result ----
  await fill('21');
  assert.equal(await copied('words'), 'twenty-one');
  assert.equal(await text('#nw-c-words'), 'Copied');
  assert.equal(await page.getByRole('button', { name: 'Copied In words', exact: true }).count(), 1);
  await settles('#nw-status', 'In words copied to the clipboard.');
  assert.equal(await copied('ordinal'), 'twenty-first');
  assert.equal(await copied('ordinal-figures'), '21st');
  assert.equal(await copied('cheque'), 'twenty-one and 00/100');
  // A value that arrives without an input event (autofill, the browser putting it back)
  // is read before copying.
  await page.$eval('#nw-input', el => { el.value = '42'; });
  assert.equal(await copied('money'), 'forty-two dollars');
  assert.equal(await out('words'), 'forty-two');

  // ---- Keyboard: the box, the copy buttons right under it, then the options ----
  await page.focus('#nw-input');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nw-c-words');
  assert.notEqual(await page.$eval('#nw-c-words', el => getComputedStyle(el).outlineStyle), 'none');
  assert.equal(await copied('words', () => page.keyboard.press('Enter')), 'forty-two');
  for (const id of ['nw-c-ordinal', 'nw-c-ordinal-figures', 'nw-c-money', 'nw-c-cheque', 'nw-style', 'nw-scale', 'nw-mark', 'nw-dec', 'nw-cur', 'nw-case', 'nw-commas']) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), id);
  }
  // A result that does not apply is skipped: no ordinal for 4.5.
  await fill('4.5');
  await page.focus('#nw-c-words');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nw-c-money');
  await fill('42');
  await page.focus('#nw-style');
  await page.keyboard.press('ArrowDown');
  await page.focus('#nw-input');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('115');
  assert.equal(await out('words'), 'one hundred and fifteen');
  await page.waitForFunction(() => document.querySelector('#nw-c-words').textContent === 'Copy', null, { timeout: 3000 });
  for (const name of ['Copy In words', 'Copy Ordinal', 'Copy Ordinal in figures', 'Copy Money', 'Copy Cheque (check)']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, name);
  }
  for (const name of ['Number in figures', 'English', 'Big numbers', 'Decimal mark', 'Decimals as', 'Currency', 'Letters', 'Commas between groups']) {
    assert.equal(await page.getByLabel(name, { exact: true }).count(), 1, name);
  }

  // ---- Back from another page, and values put back after the script has run ----
  await set({ style: 'uk' });
  await fill('1001');
  await page.goto(`${base}/about/`, { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'load' });
  const restored = { n: await page.inputValue('#nw-input'), uk: (await page.inputValue('#nw-style')) === 'uk' };
  const expectBack = { '1001': restored.uk ? 'one thousand and one' : 'one thousand one', '1234.56': restored.uk ? 'one thousand two hundred and thirty-four point five six' : 'one thousand two hundred thirty-four point five six' };
  assert.ok(restored.n in expectBack, `restored "${restored.n}"`);
  assert.equal(await out('words'), expectBack[restored.n]);
  await page.evaluate(() => {
    document.querySelector('#nw-input').value = '12';
    document.querySelector('#nw-style').value = 'us';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  r = await results();
  assert.deepEqual([r.words.text, r.ordinal.text], ['twelve', 'twelfth']);

  // ---- The guide links to tools of this site, and the FAQ ends with privacy ----
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/invoice-generator/', '/binary-translator/', '/roman-numerals-converter/']);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), href);
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.match(faqs[faqs.length - 1], /sent anywhere/);
  assert.ok(faqs.includes('How do I convert numbers to words in Excel?'), faqs.join(' | '));
  assert.match((await page.locator('.faq details', { hasText: 'in Excel?' }).locator('.faq-answer').textContent()).replace(/\s+/g, ' '),
    /no built-in function .*SpellNumber macro.*=SpellNumber\(A1\).*macro-enabled \.xlsm file.*Excel for the web cannot run it/);
  // Homepage search (index.html) matches every typed word against title, description and keywords.
  const home = await (await page.request.get(base + '/')).text();
  const hay = (home.match(/<li data-search="([^"]*)">\s*<a[^>]*href="\/number-to-words\/"/) || [])[1] || '';
  assert.ok(hay, 'the homepage lists the page');
  for (const q of ['number to words', 'amount in words in rupees', 'lakh crore converter', 'dollars in words', 'indian number system', 'cheque amount', 'check amount in words', 'ordinal']) {
    assert.ok(q.split(' ').every(w => hay.includes(w)), `the homepage search finds nothing for "${q}"`);
  }

  // ---- Every option at once: random numbers against the rules in expected.py ----
  for (const c of data.combos) {
    const got = await page.evaluate(c => {
      for (const [k, v] of Object.entries({ ...c.opts, mark: '.' })) {
        if (k === 'commas') document.querySelector('#nw-commas').checked = v;
        else document.querySelector('#nw-' + k).value = v;
      }
      const el = document.querySelector('#nw-input');
      el.value = c.n;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return Object.fromEntries([...document.querySelectorAll('.nw-item')].map(li => [li.querySelector('.nw-copy').dataset.row,
        li.querySelector('.nw-copy').disabled ? null : li.querySelector('.nw-out').textContent]));
    }, c);
    for (const id of ['words', 'ordinal', 'money', 'cheque']) assert.equal(got[id], c.expected[id] ?? null, `${c.n} ${JSON.stringify(c.opts)}: ${id}`);
  }

  // ---- Browsers set to German, British and Indian English ----
  const browser = page.context().browser();
  const de = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const dp = await de.newPage();
  await dp.goto(url, { waitUntil: 'load' });
  assert.equal(await dp.inputValue('#nw-mark'), ',');
  assert.equal(await dp.inputValue('#nw-cur'), 'eur');
  assert.equal(await dp.inputValue('#nw-input'), '1234,56');
  assert.equal(await text('#nw-read', dp), 'Read as 1.234,56.');
  assert.equal(await out('words', dp), 'one thousand two hundred thirty-four point five six');
  const point = ' If the dot is your decimal mark, choose Point (1,234.5) under Decimal mark.';
  for (const [n, w, read] of [['1.234', 'one thousand two hundred thirty-four', 'Read as 1.234. The dot groups thousands. If it is your decimal mark, choose Point (1,234.5).'],
    ['1,5', 'one point five', 'Read as 1,5.'], ['0,500', 'zero point five zero zero', 'Read as 0,500.'], ['1.234,5', 'one thousand two hundred thirty-four point five', 'Read as 1.234,5.'],
    ['1.234.567', 'one million two hundred thirty-four thousand five hundred sixty-seven', 'Read as 1.234.567.']]) {
    await fill(n, dp);
    assert.equal(await out('words', dp), w, `de ${n}`);
    assert.equal(await text('#nw-read', dp), read, `de ${n}`);
  }
  for (const [n, msg] of [['1.5', 'A dot can only stand between groups of three digits, as in 1.234.567.' + point],
    ['1,234.56', 'Only digits can follow the decimal comma.' + point], ['1,2,3', 'A number has one decimal comma, and this one has more. If commas group the thousands here, choose Point (1,234.5) under Decimal mark.']]) {
    await fill(n, dp);
    assert.equal(await text('#nw-error', dp), msg, `de ${n}`);
  }
  await de.close();
  const gb = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const gp = await gb.newPage();
  await gp.goto(url, { waitUntil: 'load' });
  assert.deepEqual([await gp.inputValue('#nw-style'), await gp.inputValue('#nw-cur'), await gp.inputValue('#nw-mark')], ['uk', 'gbp', '.']);
  assert.equal(await out('money', gp), 'one thousand two hundred and thirty-four pounds and fifty-six pence');
  await gb.close();
  const india = await browser.newContext({ locale: 'en-IN', viewport: { width: 1280, height: 900 } });
  const ip = await india.newPage();
  await ip.goto(url, { waitUntil: 'load' });
  assert.deepEqual([await ip.inputValue('#nw-style'), await ip.inputValue('#nw-scale'), await ip.inputValue('#nw-cur')], ['uk', 'indian', 'inr']);
  await fill('1234567', ip);
  assert.equal(await out('words', ip), 'twelve lakh thirty-four thousand five hundred and sixty-seven');
  assert.equal(await out('cheque', ip), 'rupees twelve lakh thirty-four thousand five hundred and sixty-seven only');
  await india.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  await phone.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const p = await phone.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('#nw-input');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('99');
  assert.equal(await copied('words', () => p.tap('#nw-c-words'), p), 'ninety-nine');
  const sizes = await p.$$eval('.nw button, .nw input, .nw select, .nw .check', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id || e.textContent.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize),
    field: (e.tagName === 'INPUT' && e.type === 'text') || e.tagName === 'SELECT',
  })));
  assert.equal(sizes.length, 14);
  for (const s of sizes) {
    if (s.id !== 'nw-commas') assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px text`);
  }
  // No choice is cut off in its select box, and nothing leaves the card, at any width.
  await p.fill('#nw-input', '9'.repeat(66) + '.' + '9'.repeat(65));
  for (const width of [320, 340, 360, 390, 412, 480, 540, 640, 768, 1024]) {
    await p.setViewportSize({ width, height: 800 });
    const clipped = await p.$$eval('.nw select', els => els.flatMap(sel => {
      const cs = getComputedStyle(sel), ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 24;
      return [...sel.options].filter(o => ctx.measureText(o.text).width > room).map(o => `${sel.id}: ${o.text}`);
    }));
    assert.deepEqual(clipped, [], `choices cut off at ${width}px`);
    const cut = await p.$$eval('.nw button, .nw label, .nw-name, .nw-out, .nw-note, .nw-read, .nw-h', els => els.filter(e => e.offsetParent).filter(e => {
      const r = e.getBoundingClientRect(), card = e.closest('.tool-card').getBoundingClientRect();
      return e.scrollWidth > e.clientWidth + 1 || r.right > card.right + 0.5 || r.left < card.left - 0.5;
    }).map(e => e.id || e.textContent.trim().slice(0, 30)));
    assert.deepEqual(cut, [], `cut off at ${width}px`);
    assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `sideways scroll at ${width}px`);
  }
  await phone.close();
};
