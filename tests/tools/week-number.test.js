// Expected values were computed independently with Python's
// datetime.date.isocalendar() / date.fromisocalendar() and the Excel WEEKNUM
// (return type 1) definition, not copied from the page.
const fs = require('fs');

module.exports = async ({ page, open, assert }) => {
  const text = sel => page.locator(sel).textContent();

  // A fixed "now": Thursday 2026-09-24 (ISO 2026-W39-4, day 267, US week 39).
  await page.clock.install({ time: new Date('2026-09-24T10:00:00Z') });
  await open();

  assert.equal(await text('#wn-today-week'), '39');
  assert.equal(await text('#wn-today-iso'), '2026-W39-4');
  assert.equal(await text('#wn-today-range'), 'Monday, September 21 to Sunday, September 27, 2026');
  assert.equal(await text('#wn-today-year'), '2026');
  assert.equal(await text('#wn-today-doy'), '267');
  assert.equal(await text('#wn-today-count'), '53');
  assert.equal(await text('#wn-today-us'), '39');
  assert.equal(await page.inputValue('#wn-date'), '2026-09-24');

  // Year-boundary edge cases.
  const cases = [
    // date, ISO week, ISO week date, US week, day of year
    ['2020-12-31', '53', '2020-W53-4', '53', '366'],
    ['2021-01-03', '53', '2020-W53-7', '2', '3'],
    ['2021-01-04', '1', '2021-W01-1', '2', '4'],
    ['2024-12-30', '1', '2025-W01-1', '53', '365'],
    ['2027-01-01', '53', '2026-W53-5', '1', '1'],
    ['2026-01-01', '1', '2026-W01-4', '1', '1'],
    ['2015-12-31', '53', '2015-W53-4', '53', '365'],
  ];
  for (const [d, week, iso, us, doy] of cases) {
    await page.fill('#wn-date', d);
    assert.equal(await text('#wn-date-week'), week, `ISO week of ${d}`);
    assert.equal(await text('#wn-date-iso'), iso, `ISO week date of ${d}`);
    assert.equal(await text('#wn-date-us'), us, `US week of ${d}`);
    assert.equal(await text('#wn-date-doy'), doy, `day of year of ${d}`);
    // The FAQ's spreadsheet formula for the week-year, =YEAR(A2 - WEEKDAY(A2, 2) + 4),
    // where WEEKDAY(..., 2) counts Monday = 1 to Sunday = 7.
    const t = new Date(d + 'T00:00:00Z');
    const weekday2 = (t.getUTCDay() + 6) % 7 + 1;
    assert.equal(String(new Date(t.getTime() + (4 - weekday2) * 864e5).getUTCFullYear()), iso.slice(0, 4), `FAQ week-year formula for ${d}`);
  }
  // The privacy line is in every page's footer; this FAQ slot answers a real question.
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(!faqs.some(q => /uploaded|sent to a server/i.test(q)), faqs.join(' | '));
  assert.ok(faqs.some(q => /ISO week number in Excel or Google Sheets/.test(q)), faqs.join(' | '));
  await page.fill('#wn-date', '2021-01-03');
  const line = await text('#wn-date-range');
  assert.ok(line.includes('Monday, December 28, 2020 to Sunday, January 3, 2021'), line);
  assert.ok(line.includes('week-year 2020'), line);
  // An empty field is a prompt, not an error.
  await page.fill('#wn-date', '');
  assert.equal(await text('#wn-date-msg'), '');
  assert.match(await text('#wn-date-range'), /Pick a date/);
  assert.equal(await text('#wn-date-week'), '–');
  // Extremes of the supported range (Python: date(1,1,1).isocalendar() == (1, 1, 1),
  // date(9999,12,31).isocalendar() == (9999, 52, 5)).
  await page.fill('#wn-date', '0001-01-01');
  assert.equal(await text('#wn-date-iso'), '0001-W01-1');
  await page.fill('#wn-date', '9999-12-31');
  assert.equal(await text('#wn-date-iso'), '9999-W52-5');
  assert.equal(await text('#wn-date-doy'), '365');
  await page.click('#wn-date-today');
  assert.equal(await text('#wn-date-iso'), '2026-W39-4');

  // Dates of a week.
  await page.fill('#wn-find-year', '2026');
  await page.fill('#wn-find-week', '10');
  assert.equal(await text('#wn-find-out'), '2026-W10 runs from Monday, March 2, 2026 to Sunday, March 8, 2026.');
  await page.fill('#wn-find-week', '53');
  assert.ok((await text('#wn-find-out')).includes('Monday, December 28, 2026 to Sunday, January 3, 2027'));
  await page.fill('#wn-find-year', '2025');
  assert.match(await text('#wn-find-msg'), /2025 has 52 ISO weeks/);
  assert.equal(await text('#wn-find-out'), '');
  await page.fill('#wn-find-year', '2020');
  assert.ok((await text('#wn-find-out')).includes('Monday, December 28, 2020 to Sunday, January 3, 2021'));

  // Year table: defaults to the current week-year and highlights this week.
  const rows = page.locator('#wn-table tbody tr');
  assert.equal(await rows.count(), 53);
  assert.equal(await page.locator('#wn-table tbody tr.wn-current').count(), 1);
  assert.match(await page.locator('#wn-table tbody tr.wn-current th').textContent(), /^39/);
  assert.deepEqual(await rows.nth(0).locator('td').allTextContents(), ['Mon, Dec 29, 2025', 'Sun, Jan 4']);
  assert.deepEqual(await rows.nth(52).locator('td').allTextContents(), ['Mon, Dec 28', 'Sun, Jan 3, 2027']);

  const longYears = { 2015: 53, 2016: 52, 2019: 52, 2020: 53, 2021: 52, 2024: 52, 2025: 52, 2026: 53, 2027: 52, 2032: 53 };
  for (const [y, n] of Object.entries(longYears)) {
    await page.fill('#wn-year', y);
    assert.equal(await rows.count(), n, `ISO weeks in ${y}`);
  }
  await page.fill('#wn-year', '2025');
  assert.equal(await page.locator('#wn-table tbody tr.wn-current').count(), 0);
  await page.click('#wn-next');
  assert.equal(await page.inputValue('#wn-year'), '2026');
  assert.equal(await page.locator('#wn-table tbody tr.wn-current').count(), 1);

  // CSV download of the ISO weeks of 2026.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#wn-csv')]);
  assert.equal(dl.suggestedFilename(), 'iso-weeks-2026.csv');
  const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split(/\r\n/);
  assert.equal(csv.length, 54);
  assert.equal(csv[0], 'Week,ISO week,Start (Monday),End (Sunday)');
  assert.equal(csv[1], '1,2026-W01,2025-12-29,2026-01-04');
  assert.equal(csv[39], '39,2026-W39,2026-09-21,2026-09-27');
  assert.equal(csv[53], '53,2026-W53,2026-12-28,2027-01-03');

  // US numbering (Excel WEEKNUM type 1): partial first/last weeks, 54 weeks in 2028.
  await page.selectOption('#wn-system', 'us');
  assert.equal(await rows.count(), 53);
  assert.deepEqual(await rows.nth(0).locator('td').allTextContents(), ['Thu, Jan 1', 'Sat, Jan 3 (3 days)']);
  assert.deepEqual(await rows.nth(1).locator('td').allTextContents(), ['Sun, Jan 4', 'Sat, Jan 10']);
  assert.deepEqual(await rows.nth(52).locator('td').allTextContents(), ['Sun, Dec 27', 'Thu, Dec 31 (5 days)']);
  assert.match(await page.locator('#wn-table tbody tr.wn-current th').textContent(), /^39/);
  await page.fill('#wn-year', '2028');
  assert.equal(await rows.count(), 54);
  assert.deepEqual(await rows.nth(53).locator('td').allTextContents(), ['Sun, Dec 31', 'Sun, Dec 31 (1 day)']);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#wn-csv')]);
  const us = fs.readFileSync(await dl2.path(), 'utf8').trim().split(/\r\n/);
  assert.equal(us.length, 55);
  assert.equal(us[1], '1,2028-01-01,2028-01-01,1');
  assert.equal(us[54], '54,2028-12-31,2028-12-31,1');

  // Bad year: friendly error, no rows, download disabled.
  await page.fill('#wn-year', '0');
  assert.ok((await text('#wn-year-msg')).length > 0);
  assert.equal(await rows.count(), 0);
  assert.equal(await page.locator('#wn-csv').isDisabled(), true);
  await page.click('#wn-this');
  assert.equal(await page.inputValue('#wn-year'), '2026');
  assert.equal(await rows.count(), 53);

  // The page rolls over to the new week at local midnight without a reload.
  await page.clock.setSystemTime(new Date('2026-09-27T23:59:30Z'));
  await page.reload();
  assert.equal(await text('#wn-today-iso'), '2026-W39-7');
  await page.clock.runFor(60000);
  assert.equal(await text('#wn-today-iso'), '2026-W40-1');
  assert.match(await page.locator('#wn-table tbody tr.wn-current th').textContent(), /^40/);

  // "Today" uses the visitor's local date, not UTC. 2026-01-04T12:00Z is
  // Sunday in UTC (2026-W01-7) but already Monday 01:00 in Auckland (W02-1).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Auckland' });
  await page.clock.setSystemTime(new Date('2026-01-04T12:00:00Z'));
  await page.reload();
  assert.equal(await text('#wn-today-iso'), '2026-W02-1');
  assert.equal(await text('#wn-today-week'), '2');
  // In Honolulu the same instant is still Sunday 2026-01-04 (W01-7), and
  // date math must not drift across a DST change (New York, spring forward).
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Honolulu' });
  await page.reload();
  assert.equal(await text('#wn-today-iso'), '2026-W01-7');
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await page.clock.setSystemTime(new Date('2026-03-09T04:30:00Z')); // 00:30 EDT Monday
  await page.reload();
  assert.equal(await text('#wn-today-iso'), '2026-W11-1');
  await page.fill('#wn-date', '2026-03-08');
  assert.equal(await text('#wn-date-iso'), '2026-W10-7');

  // Around New Year the ISO week-year and the calendar year differ. On Monday
  // 2024-12-30 (2025-W01, US week 53 of 2024) "This year" must follow the
  // numbering: ISO shows 2025, US shows 2024, each with the current week marked.
  await page.clock.setSystemTime(new Date('2024-12-30T17:00:00Z'));
  await page.reload();
  assert.equal(await text('#wn-today-iso'), '2025-W01-1');
  assert.equal(await text('#wn-today-us'), '53');
  assert.equal(await page.inputValue('#wn-year'), '2025');
  assert.match(await page.locator('#wn-table tbody tr.wn-current th').textContent(), /^1/);
  await page.selectOption('#wn-system', 'us');
  assert.equal(await page.inputValue('#wn-year'), '2024');
  assert.equal(await rows.count(), 53);
  assert.match(await page.locator('#wn-table tbody tr.wn-current th').textContent(), /^53/);
  await page.fill('#wn-year', '2000'); // leap year starting on Saturday: 54 US weeks
  assert.equal(await rows.count(), 54);
  await page.click('#wn-this');
  assert.equal(await page.inputValue('#wn-year'), '2024');
  await page.selectOption('#wn-system', 'iso');
  assert.equal(await page.inputValue('#wn-year'), '2025');
  assert.equal(await page.locator('#wn-table tbody tr.wn-current').count(), 1);

  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
