// Expected totals were computed with Python's decimal module (ROUND_HALF_UP,
// quantized to the currency's minor unit), not with the page. Currency strings
// are compared with Node's own Intl.NumberFormat.
const fs = require('fs');
const zlib = require('zlib');

// A grey PNG of w x h pixels; a 7,000 x 7,000 one (49 megapixels) is only about 50 KB.
function bigPng(w, h) {
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const row = Buffer.alloc(w + 1, 0x80); row[0] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * (w + 1));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// A 2x2 red PNG, used as a logo.
const LOGO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAAB3+AgN4ht6aAAAAAElFTkSuQmCC', 'base64');

module.exports = async ({ page, open, assert }) => {
  // Fixed "today" and a print() that only records what would be printed.
  await page.clock.install({ time: new Date('2026-09-24T10:00:00') });
  await page.addInitScript(() => {
    window.__prints = [];
    window.print = () => {
      const root = document.querySelector('.iv-print-root');
      window.__prints.push({ title: document.title, text: root ? root.textContent : '' });
    };
  });
  await open();
  const text = sel => page.textContent(sel);
  const minor = sel => page.getAttribute(sel, 'data-minor');
  const nf = (loc, cur, n) => new Intl.NumberFormat(loc, { style: 'currency', currency: cur }).format(n);
  const row = n => `#iv-items .iv-item:nth-child(${n})`;
  const fillItem = async (n, desc, qty, rate) => {
    await page.fill(`${row(n)} .iv-desc`, desc);
    await page.fill(`${row(n)} .iv-qty`, qty);
    await page.fill(`${row(n)} .iv-rate`, rate);
  };
  const lineMinors = () => page.$$eval('#iv-sheet .iv-tbl tbody tr', trs => trs.map(t => t.getAttribute('data-minor')));
  const totals = () => page.$$eval('#iv-sheet .iv-tot tr', trs => trs.map(t => [t.getAttribute('data-row'), t.getAttribute('data-minor')]));

  // ----- Defaults -----
  await page.waitForTimeout(1200);
  assert.equal(await text('#iv-status'), '', 'nothing is announced on load');
  assert.equal(await page.inputValue('#iv-number'), 'INV-0001');
  assert.equal(await page.inputValue('#iv-date'), '2026-09-24');
  assert.equal(await page.inputValue('#iv-terms'), '30');
  assert.equal(await page.inputValue('#iv-due'), '2026-10-24');
  await page.selectOption('#iv-currency', 'USD');
  await page.selectOption('#iv-locale', 'en-US');
  assert.equal(await text('#iv-p-issued'), 'Sep 24, 2026');
  assert.equal(await text('#iv-p-due'), 'Oct 24, 2026');
  assert.equal(await text('#iv-p-terms'), 'Net 30');
  assert.equal(await page.locator('#iv-sheet .iv-ph').count() > 0, true, 'placeholders in the empty preview');
  await page.selectOption('#iv-terms', '0');
  assert.equal(await page.inputValue('#iv-due'), '2026-09-24');
  await page.selectOption('#iv-terms', '14');
  assert.equal(await page.inputValue('#iv-due'), '2026-10-08');
  await page.fill('#iv-date', '2026-12-25');
  assert.equal(await page.inputValue('#iv-due'), '2027-01-08', 'due date follows the issue date');
  await page.fill('#iv-due', '2027-01-31');
  assert.equal(await page.inputValue('#iv-terms'), 'custom', 'editing the due date makes it custom');
  await page.fill('#iv-due', '2026-12-01');
  await page.click('#iv-pdf');
  assert.match(await text('#iv-error'), /due date is before the issue date/);
  assert.equal(await page.getAttribute('#iv-due', 'aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'iv-due', 'Download PDF focuses the problem');
  assert.equal(await page.evaluate(() => window.__prints.length), 0, 'nothing printed with an error');
  await page.fill('#iv-date', '2026-09-24');
  await page.selectOption('#iv-terms', '30');
  assert.equal(await page.inputValue('#iv-due'), '2026-10-24');

  // ----- Parties -----
  await page.fill('#iv-from-name', 'Studio Ōkami 株式会社');
  await page.fill('#iv-from-address', '1-2-3 Shibuya\nTokyo 150-0002\nJapan');
  await page.fill('#iv-from-tax', 'T1234567890123');
  await page.fill('#iv-to-name', 'شركة الاختبار');
  await page.fill('#iv-to-address', 'Dubai\nUnited Arab Emirates');
  const sheetText = await text('#iv-sheet');
  assert.ok(sheetText.includes('Studio Ōkami 株式会社') && sheetText.includes('شركة الاختبار') && sheetText.includes('Tax ID: T1234567890123'), sheetText);
  assert.equal(await page.getAttribute('#iv-sheet .iv-toname', 'dir'), 'auto');

  // ----- Items, discount, shipping, taxes (USD, 2 decimals) -----
  await fillItem(1, 'Design', '3', '19.99');
  await page.click('#iv-add-item');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Description, item 2');
  await fillItem(2, 'Hosting', '1.5', '33.33');       // 49.995 -> 50.00
  await page.press(`${row(2)} .iv-rate`, 'Enter');       // Enter in the last row adds one
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Description, item 3');
  await fillItem(3, 'Tiny part', '1', '1.005');         // 1.005 -> 1.01 (a float gives 1.00)
  assert.deepEqual(await lineMinors(), ['5997', '5000', '101']);
  assert.equal(await text(`${row(1)} .iv-amt`), 'Amount: $59.97');
  assert.equal(await text(`${row(3)} .iv-amt-v`), '$1.01');
  await page.fill('#iv-disc-value', '10');
  await page.fill('#iv-shipping', '5');
  await page.check('#iv-ship-tax');
  await page.click('#iv-add-tax');
  await page.fill('#iv-taxes .iv-tax:nth-child(1) .iv-tax-name', 'Sales tax');
  await page.fill('#iv-taxes .iv-tax:nth-child(1) .iv-tax-rate', '8.875');
  await page.click('#iv-add-tax');
  await page.fill('#iv-taxes .iv-tax:nth-child(2) .iv-tax-name', 'City');
  await page.fill('#iv-taxes .iv-tax:nth-child(2) .iv-tax-rate', '0.5');
  await page.fill('#iv-paid', '50');
  // Python: subtotal 110.98, discount 11.10, base 104.88, taxes 9.31 and 0.52, total 114.71, due 64.71.
  assert.deepEqual(await totals(), [
    ['subtotal', '11098'], ['discount', '-1110'], ['shipping', '500'], ['tax-0', '931'], ['tax-1', '52'],
    ['total', '11471'], ['paid', '-5000'], ['balance', '6471'],
  ]);
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="discount"] th'), 'Discount (10%)');
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="tax-0"] th'), 'Sales tax (8.875%)');
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="balance"] td'), '$64.71');
  assert.equal(await text('#iv-p-balance-top'), '$64.71');
  assert.equal(await text('#iv-sum tr[data-row="total"] td'), '$114.71');
  // Shipping untaxed: base 99.88, taxes 8.86 and 0.50, total 114.24.
  await page.uncheck('#iv-ship-tax');
  assert.equal(await minor('#iv-sheet .iv-tot tr[data-row="tax-0"]'), '886');
  assert.equal(await minor('#iv-sheet .iv-tot tr[data-row="total"]'), '11424');
  await page.check('#iv-ship-tax');
  // A fixed-amount discount.
  await page.selectOption('#iv-disc-type', 'amount');
  assert.equal(await minor('#iv-sheet .iv-tot tr[data-row="discount"]'), '-1000');
  await page.selectOption('#iv-disc-type', 'percent');

  // ----- Input rules -----
  await page.fill(`${row(1)} .iv-qty`, '1,234.5');
  await page.waitForFunction(() => /Item 1: quantity must be a number/.test(document.querySelector('#iv-error').textContent));
  assert.equal(await page.getAttribute(`${row(1)} .iv-qty`, 'aria-invalid'), 'true');
  await page.fill(`${row(1)} .iv-qty`, '12,5');           // a decimal comma is fine: 12.5 x 19.99 = 249.875
  assert.equal((await lineMinors())[0], '24988');
  assert.equal(await text('#iv-error'), '');
  assert.equal(await page.getAttribute(`${row(1)} .iv-qty`, 'aria-invalid'), null);
  await page.fill(`${row(1)} .iv-qty`, '3');
  await page.fill('#iv-shipping', '5.001');
  await page.waitForFunction(() => /Shipping can have at most 2 decimal places \(USD has 2\)/.test(document.querySelector('#iv-error').textContent));
  await page.fill('#iv-shipping', '5');
  await page.fill('#iv-disc-value', '120');
  await page.waitForFunction(() => /cannot be more than 100%/.test(document.querySelector('#iv-error').textContent));
  await page.fill('#iv-disc-value', '10');
  // A credit line rounds half away from zero: -1 x 0.005 = -0.01.
  await page.click('#iv-add-item');
  await fillItem(4, 'Credit', '-1', '0.005');
  assert.equal((await lineMinors())[3], '-1');
  // Digits from other scripts count: full-width 12 (a Japanese keyboard) x Arabic-Indic 3.5
  // with the Arabic decimal separator = 42.00.
  await fillItem(4, 'Credit', '１２', '٣٫٥');
  assert.equal((await lineMinors())[3], '4200');
  assert.equal(await text(`${row(4)} .iv-amt-v`), '$42.00');
  await page.click(`${row(4)} .iv-x`);
  assert.equal(await page.locator('#iv-items .iv-item').count(), 3);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove item 3');
  assert.equal(await minor('#iv-sheet .iv-tot tr[data-row="total"]'), '11471');

  // ----- Logo -----
  await page.setInputFiles('#iv-logo-file', { name: 'logo.png', mimeType: 'image/png', buffer: LOGO });
  await page.waitForSelector('#iv-sheet .iv-brand img');
  assert.match(await page.getAttribute('#iv-sheet .iv-brand img', 'src'), /^data:image\/png;base64,/);
  await page.setInputFiles('#iv-logo-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  assert.match(await text('#iv-error'), /"notes.txt" is not a PNG, JPG, WebP, GIF or SVG image/);
  // Regression: a small file that expands to a huge bitmap is refused before it is drawn
  // (a 20,000 px square PNG used to block the page for over 2 seconds).
  const bomb = bigPng(7000, 7000);
  await page.setInputFiles('#iv-logo-file', { name: 'huge.png', mimeType: 'image/png', buffer: bomb });
  await page.waitForFunction(() => /too large/.test(document.querySelector('#iv-error').textContent));
  assert.equal(await text('#iv-error'), '"huge.png" is too large (7,000 × 7,000 pixels). Use an image under 40 megapixels.');
  assert.equal(await page.getAttribute('#iv-sheet .iv-brand img', 'src'), 'data:image/png;base64,' + LOGO.toString('base64'), 'the earlier logo stays');

  // ----- Save the invoice file -----
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#iv-save')]);
  assert.equal(dl.suggestedFilename(), 'invoice-inv-0001.json');
  const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(saved.format, 'triplep-invoice');
  assert.equal(saved.version, 1);
  assert.equal(saved.currency, 'USD');
  assert.equal(saved.locale, 'en-US');
  assert.equal(saved.from.name, 'Studio Ōkami 株式会社');
  assert.equal(saved.billTo.name, 'شركة الاختبار');
  assert.deepEqual(saved.items, [
    { description: 'Design', quantity: '3', rate: '19.99' },
    { description: 'Hosting', quantity: '1.5', rate: '33.33' },
    { description: 'Tiny part', quantity: '1', rate: '1.005' },
  ]);
  assert.deepEqual(saved.taxes, [{ name: 'Sales tax', rate: '8.875' }, { name: 'City', rate: '0.5' }]);
  assert.deepEqual(saved.shipping, { amount: '5', taxable: true });
  assert.match(saved.logo, /^data:image\/png;base64,/);
  assert.deepEqual(saved.totals, {
    currency: 'USD', minorUnitDigits: 2, subtotal: '110.98', discount: '11.10', shipping: '5.00',
    taxes: [{ name: 'Sales tax', amount: '9.31' }, { name: 'City', amount: '0.52' }],
    total: '114.71', amountPaid: '50.00', balanceDue: '64.71',
  });
  assert.match(await text('#iv-ok'), /Saved invoice-inv-0001\.json/);

  // ----- PDF: print shows only the invoice, with a useful file name -----
  await page.click('#iv-pdf');
  const prints = await page.evaluate(() => window.__prints);
  assert.equal(prints.length, 1);
  assert.equal(prints[0].title, 'Invoice INV-0001 شركة الاختبار');
  assert.ok(prints[0].text.includes('$64.71') && prints[0].text.includes('株式会社'), prints[0].text);
  await page.waitForTimeout(1100);
  assert.doesNotMatch(await page.title(), /INV-0001/, 'the page title comes back');
  await page.click('#iv-add-item');
  await page.fill('#iv-title', '');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.isVisible('h1'), false);
  assert.equal(await page.locator('.iv-print-root .iv-tbl tbody tr:visible').count(), 3, 'a blank row is not printed');
  assert.equal(await page.textContent('.iv-print-root .iv-title'), 'Invoice', 'an empty title falls back to Invoice');
  assert.equal(await page.isVisible('.iv-print-root .iv-sheet'), true);
  assert.equal(await page.isVisible('#iv-from-name'), false);
  // Back to no emulation: page.pdf() then renders with print CSS, as a browser's Save as PDF does.
  await page.emulateMedia({ media: null });
  assert.equal(await page.isVisible('h1'), true);
  await page.click(`${row(4)} .iv-x`);
  await page.fill('#iv-title', 'Invoice');
  // Chromium's print engine makes a real PDF with embedded, selectable text.
  const pdf = await page.pdf({ format: 'A4' });
  const raw = pdf.toString('latin1');
  assert.ok(raw.startsWith('%PDF-'), 'PDF header');
  assert.equal((raw.match(/\/Type\s*\/Page\b/g) || []).length, 1, 'one page');
  assert.ok(/\/ToUnicode/.test(raw) && /\/FontFile2|\/FontFile3/.test(raw), 'text is embedded as real, selectable text');
  // A long invoice flows onto a second page.
  for (let i = 4; i <= 40; i++) {
    await page.click('#iv-add-item');
    await fillItem(i, 'Line ' + i, '1', '1');
  }
  const pdf2 = await page.pdf({ format: 'A4' });
  assert.ok((pdf2.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length >= 2, 'long invoice has several pages');

  // ----- Next invoice keeps the business, clears the client and items -----
  await page.click('#iv-next');
  assert.equal(await page.inputValue('#iv-number'), 'INV-0002');
  assert.equal(await page.inputValue('#iv-from-name'), 'Studio Ōkami 株式会社');
  assert.equal(await page.inputValue('#iv-to-name'), '');
  assert.equal(await page.locator('#iv-items .iv-item').count(), 1);
  assert.equal(await page.locator('#iv-taxes .iv-tax').count(), 2);
  assert.equal(await page.inputValue('#iv-paid'), '');
  assert.equal(await page.inputValue('#iv-date'), '2026-09-24');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'iv-to-name');
  assert.equal(await page.getAttribute('#iv-sheet .iv-brand img', 'src') !== null, true, 'logo kept');

  // ----- JPY: no decimals -----
  await page.click('#iv-clear');
  assert.equal(await page.locator('#iv-taxes .iv-tax').count(), 0);
  assert.equal(await page.inputValue('#iv-from-name'), '');
  await page.selectOption('#iv-currency', 'JPY');
  await fillItem(1, 'Consulting', '3', '1234');
  await page.click('#iv-add-item');
  await fillItem(2, 'Materials', '1', '999.5');       // a rate may have decimals; the line rounds to 1,000
  await page.click('#iv-add-tax');
  await page.fill('#iv-taxes .iv-tax-rate', '10');
  // Python: 3702 + 1000 = 4702, tax 470, total 5172.
  assert.deepEqual(await lineMinors(), ['3702', '1000']);
  assert.deepEqual(await totals(), [['subtotal', '4702'], ['tax-0', '470'], ['total', '5172']]);
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="total"] td'), nf('en-US', 'JPY', 5172));
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="total"] td'), '¥5,172');
  await page.fill('#iv-shipping', '1.5');
  await page.waitForFunction(() => /Shipping must be a whole number \(JPY has no decimal places\)/.test(document.querySelector('#iv-error').textContent));
  await page.fill('#iv-shipping', '');

  // ----- KWD: three decimals -----
  await page.selectOption('#iv-currency', 'KWD');
  await fillItem(1, 'Service', '2.5', '1.2345');     // 3.08625 -> 3.086
  await fillItem(2, 'Parts', '1.5', '0.333');        // 0.4995 -> 0.500
  await page.fill('#iv-taxes .iv-tax-rate', '5');
  // Python: 3.086 + 0.500 = 3.586, tax 0.1793 -> 0.179, total 3.765.
  assert.deepEqual(await lineMinors(), ['3086', '500']);
  assert.deepEqual(await totals(), [['subtotal', '3586'], ['tax-0', '179'], ['total', '3765']]);
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="total"] td'), nf('en-US', 'KWD', 3.765));
  assert.equal(await text('#iv-sheet .iv-tbl tbody tr:nth-child(1) td:nth-child(3)'), nf('en-US', 'KWD', 1.2345).replace('1.235', '1.2345'), 'rates keep their extra decimals');

  // ----- Open a saved invoice file: euros in German format -----
  const file = {
    format: 'triplep-invoice', version: 1, title: 'Rechnung', number: 'RE-2026-007', issueDate: '2026-03-02', paymentTerms: '14', dueDate: '2026-03-16',
    currency: 'EUR', locale: 'de-DE', from: { name: 'Müller GmbH', address: 'Hauptstraße 1\n10115 Berlin', email: '', phone: '', taxId: 'DE123456789' },
    billTo: { name: 'Café Crème', address: '', email: '' },
    items: [{ description: 'Beratung', quantity: '2', rate: '120,50' }, { description: '翻訳サービス', quantity: '1', rate: '99.99' }],
    discount: { type: 'amount', value: '10' }, shipping: { amount: '', taxable: false }, taxes: [{ name: 'USt.', rate: '19' }],
    amountPaid: '', notes: 'Vielen Dank!', terms: '', logo: null,
  };
  await page.setInputFiles('#iv-open-file', { name: 're-2026-007.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await page.waitForFunction(() => document.querySelector('#iv-number').value === 'RE-2026-007');
  assert.match(await text('#iv-ok'), /Opened re-2026-007\.json/);
  assert.equal(await page.inputValue('#iv-currency'), 'EUR');
  assert.equal(await page.inputValue('#iv-locale'), 'de-DE');
  // Python: 241.00 + 99.99 = 340.99, discount 10.00, VAT 19% of 330.99 = 62.89, total 393.88.
  assert.deepEqual(await totals(), [['subtotal', '34099'], ['discount', '-1000'], ['tax-0', '6289'], ['total', '39388']]);
  assert.equal(await text('#iv-sheet .iv-tot tr[data-row="total"] td'), nf('de-DE', 'EUR', 393.88));
  assert.equal(await text('#iv-p-issued'), new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date('2026-03-02T00:00:00Z')));
  assert.equal(await text('#iv-sheet .iv-title'), 'Rechnung');
  assert.equal(await text('#iv-p-terms'), 'Net 14');
  assert.ok((await text('#iv-sheet')).includes('翻訳サービス'));
  assert.equal(await page.locator('#iv-sheet .iv-brand img').count(), 0, 'no logo in that file');

  // Files that are not invoices are refused with a clear message.
  await page.setInputFiles('#iv-open-file', { name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
  await page.waitForFunction(() => /"other.json" is not an invoice file saved by this tool/.test(document.querySelector('#iv-error').textContent));
  await page.setInputFiles('#iv-open-file', { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await page.waitForFunction(() => /"broken.json" is not an invoice file/.test(document.querySelector('#iv-error').textContent));
  assert.equal(await page.inputValue('#iv-number'), 'RE-2026-007', 'a bad file changes nothing');

  // Regression: a file with 20,000 items used to freeze the page for minutes. It is refused.
  const huge = { ...file, number: 'HUGE', items: Array.from({ length: 20000 }, (_, i) => ({ description: 'x' + i, quantity: '1', rate: '1' })) };
  const t0 = Date.now();
  await page.setInputFiles('#iv-open-file', { name: 'huge.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(huge)) });
  await page.waitForFunction(() => /"huge.json" has 20,000 items\. An invoice here can have at most 500 items and 20 taxes\./.test(document.querySelector('#iv-error').textContent));
  assert.ok(Date.now() - t0 < 5000, 'refused quickly');
  assert.equal(await page.inputValue('#iv-number'), 'RE-2026-007');
  // 300 items open, and each row is labelled.
  const many = { ...file, number: 'MANY', items: Array.from({ length: 300 }, (_, i) => ({ description: 'Line ' + (i + 1), quantity: '1', rate: '0.01' })) };
  await page.setInputFiles('#iv-open-file', { name: 'many.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(many)) });
  await page.waitForFunction(() => document.querySelector('#iv-number').value === 'MANY');
  assert.equal(await page.locator('#iv-items .iv-item').count(), 300);
  assert.equal(await page.getAttribute('#iv-items .iv-item:nth-child(300) .iv-desc', 'aria-label'), 'Description, item 300');
  assert.equal(await minor('#iv-sheet .iv-tot tr[data-row="subtotal"]'), '300');

  // Regression: a damaged logo in a file (quotes and markup in the data URL) used to be put
  // in the page as is, which logged a console error. Now it is left out, with a note, and
  // the unknown currency is reported instead of being silently replaced.
  const damaged = { ...file, number: 'DMG', currency: 'US', logo: 'data:image/png;base64,"><img src=x onerror=alert(1)>' };
  await page.setInputFiles('#iv-open-file', { name: 'damaged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)) });
  await page.waitForFunction(() => document.querySelector('#iv-number').value === 'DMG');
  assert.equal(await text('#iv-ok'), 'Opened damaged.json. Its currency "US" is not a currency code, so EUR is selected. Check it. Its logo is not a PNG, JPG, WebP, GIF or SVG image, so it was left out.');
  assert.equal(await page.locator('#iv-sheet .iv-brand img').count(), 0);
  // A well-formed logo that decodes to 49 megapixels is also left out, after checking.
  const bombFile = { ...file, number: 'BOMB', logo: 'data:image/png;base64,' + bomb.toString('base64') };
  await page.setInputFiles('#iv-open-file', { name: 'bomb.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bombFile)) });
  await page.waitForFunction(() => /could not be used, so it was left out/.test(document.querySelector('#iv-ok').textContent));
  assert.equal(await page.locator('#iv-sheet .iv-brand img').count(), 0);
  // A good logo in a file is shown.
  const good = { ...file, number: 'LOGO', logo: 'data:image/png;base64,' + LOGO.toString('base64') };
  await page.setInputFiles('#iv-open-file', { name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(good)) });
  await page.waitForSelector('#iv-sheet .iv-brand img');
  assert.equal(await text('#iv-ok'), 'Opened good.json.');

  // Regression: a fixed discount on a credit (negative subtotal) used to make the credit
  // larger; it is refused like any discount above the subtotal.
  await page.fill(`${row(1)} .iv-qty`, '-2');
  await page.fill(`${row(1)} .iv-rate`, '10');
  await page.fill(`${row(2)} .iv-qty`, '0');
  await page.fill('#iv-disc-value', '5');
  await page.waitForFunction(() => /A fixed discount needs a subtotal above zero/.test(document.querySelector('#iv-error').textContent));
  assert.equal(await page.getAttribute('#iv-disc-value', 'aria-invalid'), 'true');
  // A percentage discount scales the credit down: -20.00 less 10% is -18.00, VAT 19% -3.42.
  await page.selectOption('#iv-disc-type', 'percent');
  await page.fill('#iv-disc-value', '10');
  assert.deepEqual(await totals(), [['subtotal', '-2000'], ['discount', '200'], ['tax-0', '-342'], ['total', '-2142']]);
  await page.fill('#iv-disc-value', '');

  // Recent ISO 4217 codes that Chromium does not list are offered too (2 decimals).
  for (const c of ['SLE', 'VED', 'XCG', 'ZWG']) assert.equal(await page.locator(`#iv-currency option[value="${c}"]`).count(), 1, c);
  await page.selectOption('#iv-currency', 'XCG');
  await page.selectOption('#iv-locale', 'en-US');
  await page.fill(`${row(1)} .iv-qty`, '1');
  await page.fill(`${row(1)} .iv-rate`, '1234.5');
  // Older ICU data has no symbol for XCG and prints the code; newer data prints "Cg.".
  assert.match(await text('#iv-sheet .iv-tot tr[data-row="subtotal"] td'), /^(XCG|Cg\.)\s1,234\.50$/);
  await page.selectOption('#iv-currency', 'EUR');
  await page.selectOption('#iv-locale', 'de-DE');
  await page.setInputFiles('#iv-open-file', { name: 're-2026-007.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await page.waitForFunction(() => document.querySelector('#iv-number').value === 'RE-2026-007');

  // Screen readers get one short total once typing pauses; the preview is not live.
  await page.fill('#iv-paid', '100');
  const spoken = `Total ${nf('de-DE', 'EUR', 393.88)}, balance due ${nf('de-DE', 'EUR', 293.88)}.`;
  const heard = await page.waitForFunction(t => document.querySelector('#iv-status').textContent === t, spoken, { timeout: 3000 }).then(() => true, () => false);
  assert.ok(heard, `status says "${await text('#iv-status')}", expected "${spoken}"`);
  assert.equal(await page.getAttribute('#iv-sheet', 'aria-live'), null);
};
