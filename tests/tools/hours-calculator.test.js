// Expected values were computed independently with Python (datetime for the
// spans, decimal.Decimal with ROUND_HALF_UP for decimal hours, rounding and
// pay), not copied from the page.
module.exports = async ({ page, open, assert }) => {
  await open();
  const text = sel => page.locator(sel).textContent();
  const row = n => page.locator('#hc-rows .hc-row').nth(n - 1);
  const cell = (n, sel) => row(n).locator(sel);
  await page.selectOption('#hc-format', '12');

  // Default row: 9:00 AM to 5:15 PM with a 30-minute break is 7:45 = 7.75 h.
  assert.equal(await cell(1, '.hc-start').inputValue(), '9:00 AM');
  assert.equal(await cell(1, '.hc-end').inputValue(), '5:15 PM');
  assert.equal(await text('#hc-total'), '7:45');
  assert.equal(await text('#hc-total-words'), '7 hours 45 minutes');
  assert.equal(await text('#hc-dec'), '7.75');
  assert.equal(await text('#hc-mins'), '465');
  assert.equal(await text('#hc-breaks'), '0:30');
  assert.equal(await text('#hc-explain'), '45 minutes ÷ 60 = 0.75, so 7:45 is exactly 7.75 hours.');
  assert.equal(await text('#hc-pay'), '–');

  // Loose typing is tidied into the chosen format when the field is left.
  const tidy = async (typed, expected) => {
    await cell(1, '.hc-start').fill(typed);
    await cell(1, '.hc-start').press('Tab');
    assert.equal(await cell(1, '.hc-start').inputValue(), expected, `"${typed}"`);
  };
  await tidy('930p', '9:30 PM');
  await tidy('0930', '9:30 AM');
  await tidy('21.30', '9:30 PM');
  await tidy('9h30', '9:30 AM');
  await tidy('7 p.m.', '7:00 PM');
  await tidy('12am', '12:00 AM');
  await tidy('12 pm', '12:00 PM');
  await tidy('noon', '12:00 PM');
  await tidy('Midnight', '12:00 AM');
  await tidy('9', '9:00 AM');

  // Overnight: 10 PM to 6:30 AM minus 30 minutes is 8:00.
  await cell(1, '.hc-start').fill('10pm');
  await cell(1, '.hc-end').fill('6:30am');
  assert.equal(await cell(1, '.hc-hm').textContent(), '8:00');
  assert.equal(await cell(1, '.hc-dec').textContent(), '8.00 h');
  assert.match(await cell(1, '.hc-tag').textContent(), /next day/);
  assert.equal(await text('#hc-total'), '8:00');

  // Several rows are summed: 8:00 + 7:45 + 8:20 = 24:05 = 24.0833… h.
  await page.click('#hc-add');
  assert.equal(await page.evaluate(() => document.activeElement.id), await cell(2, '.hc-start').getAttribute('id'));
  await cell(2, '.hc-start').fill('9:00');
  await cell(2, '.hc-end').fill('17:15');
  await cell(2, '.hc-break').fill('30');
  // Enter in the last row's break field adds another row, like a spreadsheet.
  await cell(2, '.hc-break').press('Enter');
  assert.equal(await page.locator('#hc-rows .hc-row').count(), 3);
  await cell(3, '.hc-start').fill('0830');
  await cell(3, '.hc-end').fill('1650');
  assert.equal(await cell(3, '.hc-hm').textContent(), '8:20');
  assert.equal(await cell(3, '.hc-dec').textContent(), '8.33 h');
  assert.equal(await text('#hc-total'), '24:05');
  assert.equal(await text('#hc-dec'), '24.08');
  assert.equal(await text('#hc-mins'), '1,445');
  assert.equal(await text('#hc-breaks'), '1:00');
  assert.equal(await text('#hc-total-label'), 'Total hours worked (3 rows)');
  assert.equal(await text('#hc-explain'), '5 minutes ÷ 60 = 0.0833…, so 24:05 is 24.0833… hours, rounded to 24.08.');

  // Pay: 1,445 minutes at 15.00 is exactly 361.25.
  await page.fill('#hc-rate', '15');
  assert.equal(await text('#hc-pay'), '361.25');
  assert.equal(await text('#hc-pay-label'), 'Gross pay at 15.00 an hour');

  // Copy results.
  await page.click('#hc-copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, [
    '1. 10:00 PM – 6:30 AM (next day), break 30 min: 8:00 (8.00 h)',
    '2. 9:00 AM – 5:15 PM, break 30 min: 7:45 (7.75 h)',
    '3. 8:30 AM – 4:50 PM: 8:20 (8.33 h)',
    'Total: 24:05 (24.08 h)',
    'Pay at 15.00 an hour: 361.25',
  ].join('\n'));

  // Removing rows keeps focus on the next remove button.
  await cell(1, '.hc-del').click();
  await cell(1, '.hc-del').click();
  assert.equal(await page.locator('#hc-rows .hc-row').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Clear row 1');
  // Pay comes from exact minutes: 8:20 at 15 is 125.00, not 8.33 x 15 = 124.95.
  assert.equal(await text('#hc-total'), '8:20');
  assert.equal(await text('#hc-pay'), '125.00');
  // A half-cent is rounded up exactly: 10 minutes at 18.33 = 3.055 -> 3.06.
  await cell(1, '.hc-start').fill('9:00 AM');
  await cell(1, '.hc-end').fill('9:10 AM');
  await page.fill('#hc-rate', '$18.33');
  assert.equal(await text('#hc-pay'), '3.06');
  assert.equal(await text('#hc-dec'), '0.17');
  await page.fill('#hc-rate', 'abc');
  await page.locator('#hc-rate').press('Tab');
  assert.match(await text('#hc-msg'), /hourly rate/);
  assert.equal(await text('#hc-pay'), '–');
  await page.fill('#hc-rate', '');
  assert.equal(await text('#hc-msg'), '');

  // Rounding: 8:07 AM to 4:08 PM is 8:01 exact; the 7-minute rule counts 8:00 to 4:15.
  await cell(1, '.hc-start').fill('8:07 AM');
  await cell(1, '.hc-end').fill('4:08 PM');
  assert.equal(await text('#hc-total'), '8:01');
  await page.selectOption('#hc-round', '15');
  assert.equal(await text('#hc-total'), '8:15');
  assert.equal(await text('#hc-dec'), '8.25');
  assert.match(await cell(1, '.hc-tag').textContent(), /counted 8:00 AM–4:15 PM/);
  // Nearest 6 minutes: 8:03 -> 8:06 (3 minutes rounds up), 4:02 -> 4:00: 7:54 = 7.90 h.
  await page.selectOption('#hc-round', '6');
  await cell(1, '.hc-start').fill('8:03 AM');
  await cell(1, '.hc-end').fill('4:02 PM');
  assert.equal(await text('#hc-total'), '7:54');
  assert.equal(await text('#hc-dec'), '7.90');
  // Nearest 5 minutes: 8:02 -> 8:00, 4:03 -> 4:05: 8:05 = 8.08 h.
  await page.selectOption('#hc-round', '5');
  await cell(1, '.hc-start').fill('8:02 AM');
  await cell(1, '.hc-end').fill('4:03 PM');
  assert.equal(await text('#hc-total'), '8:05');
  assert.equal(await text('#hc-dec'), '8.08');
  // A start that rounds up to midnight: 11:53 PM to 7:07 AM counts 12:00 AM to 7:00 AM.
  await page.selectOption('#hc-round', '15');
  await cell(1, '.hc-start').fill('11:53 PM');
  await cell(1, '.hc-end').fill('7:07 AM');
  assert.equal(await text('#hc-total'), '7:00');
  await page.selectOption('#hc-round', '0');
  assert.equal(await text('#hc-total'), '7:14');

  // 24-hour format re-tidies the fields.
  await page.selectOption('#hc-format', '24');
  assert.equal(await cell(1, '.hc-start').inputValue(), '23:53');
  assert.equal(await cell(1, '.hc-end').inputValue(), '07:07');

  // Same start and end is 0; 24:00 as the end is a full day.
  await cell(1, '.hc-start').fill('00:00');
  await cell(1, '.hc-end').fill('00:00');
  assert.equal(await text('#hc-total'), '0:00');
  assert.match(await cell(1, '.hc-tag').textContent(), /24:00/);
  await cell(1, '.hc-end').fill('24:00');
  assert.equal(await text('#hc-total'), '24:00');
  assert.equal(await text('#hc-dec'), '24.00');

  // Errors: an impossible time, and a break longer than the shift.
  await cell(1, '.hc-end').fill('25:00');
  await cell(1, '.hc-end').press('Tab');
  assert.match(await cell(1, '.hc-err').textContent(), /isn’t a time/);
  assert.equal(await cell(1, '.hc-end').getAttribute('aria-invalid'), 'true');
  assert.equal(await cell(1, '.hc-hm').textContent(), '–');
  assert.equal(await text('#hc-total'), '0:00');
  await cell(1, '.hc-end').fill('13pm');
  await cell(1, '.hc-end').press('Tab');
  assert.match(await cell(1, '.hc-err').textContent(), /isn’t a time/);
  await cell(1, '.hc-start').fill('09:00');
  await cell(1, '.hc-end').fill('09:30');
  await cell(1, '.hc-break').fill('45');
  await cell(1, '.hc-break').press('Tab');
  assert.match(await cell(1, '.hc-err').textContent(), /longer than the 0:30/);
  await cell(1, '.hc-break').fill('15');
  assert.equal(await cell(1, '.hc-err').textContent(), '');
  assert.equal(await cell(1, '.hc-break').getAttribute('aria-invalid'), null);
  assert.equal(await text('#hc-total'), '0:15');

  // A half-filled row is not flagged while you are still in it, only after leaving it.
  await page.click('#hc-add');
  await cell(2, '.hc-start').fill('8');
  await cell(2, '.hc-start').press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'End, row 2');
  await page.waitForTimeout(1100);
  assert.equal(await cell(2, '.hc-err').textContent(), '');
  // Leaving the row for a button shows the message without moving the button
  // away mid-click, so the copy still happens.
  await page.click('#hc-copy');
  assert.equal(await cell(2, '.hc-err').textContent(), 'Enter an end time.');
  await page.waitForFunction(() => document.querySelector('#hc-copy').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '1. 09:00 – 09:30, break 15 min: 0:15 (0.25 h)\nTotal: 0:15 (0.25 h)');

  // One short summary is announced after typing pauses.
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    window.__hcChanges = 0;
    new MutationObserver(() => window.__hcChanges++).observe(document.querySelector('#hc-status'), { childList: true, characterData: true, subtree: true });
  });
  await cell(2, '.hc-end').pressSequentially('16:30', { delay: 30 });
  await page.waitForFunction(() => /^Total 8 hours 45 minutes, 8\.75 decimal hours\.$/.test(document.querySelector('#hc-status').textContent), null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__hcChanges), 1);
  assert.equal(await page.locator('#hc-status').getAttribute('role'), 'status');

  // Clear all leaves one empty row.
  await page.click('#hc-clear');
  assert.equal(await page.locator('#hc-rows .hc-row').count(), 1);
  assert.equal(await cell(1, '.hc-start').inputValue(), '');
  assert.equal(await text('#hc-total'), '0:00');
  assert.equal(await text('#hc-dec'), '0.00');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'hc-clear');
};
