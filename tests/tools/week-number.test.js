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
  // The FAQ answers the spreadsheet question and confirms nothing is uploaded.
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(faqs.some(q => /sent to a server/i.test(q)), faqs.join(' | '));
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
  // Regression: the US header had a semicolon, which splits the column in
  // spreadsheets that use ; as the list separator (much of Europe).
  assert.equal(us[0], 'US week,Start,End,Days');
  assert.equal(us[1], '1,2028-01-01,2028-01-01,1');
  assert.equal(us[54], '54,2028-12-31,2028-12-31,1');

  // Calendar file (RFC 5545): one all-day event per week, CRLF line endings,
  // DTEND exclusive. US 2028 (54 weeks): week 1 is Sat Jan 1 only, week 54 is
  // Sun Dec 31 only (Excel WEEKNUM type 1).
  const readIcs = async () => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#wn-ics')]);
    const raw = fs.readFileSync(await d.path(), 'utf8');
    assert.ok(/^BEGIN:VCALENDAR\r\n/.test(raw) && /\r\nEND:VCALENDAR\r\n$/.test(raw), 'CRLF-delimited VCALENDAR');
    assert.ok(!/[^\r]\n/.test(raw), 'every line ends with CRLF');
    const lines = raw.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean); // unfold
    assert.ok(lines.every(l => l.length <= 75 || !raw.includes(l)), 'long lines are folded');
    const events = [];
    let cur = null;
    for (const l of lines) {
      if (l === 'BEGIN:VEVENT') cur = {};
      else if (l === 'END:VEVENT') { events.push(cur); cur = null; }
      else if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i)] = l.slice(i + 1); }
    }
    return { name: d.suggestedFilename(), raw, events };
  };
  let ics = await readIcs();
  assert.equal(ics.name, 'us-weeks-2028.ics');
  assert.equal(ics.events.length, 54);
  assert.match(ics.raw, /\r\nX-WR-CALNAME:US week numbers 2028\r\n/);
  assert.deepEqual([ics.events[0]['DTSTART;VALUE=DATE'], ics.events[0]['DTEND;VALUE=DATE'], ics.events[0].SUMMARY], ['20280101', '20280102', 'Week 1']);
  assert.deepEqual([ics.events[53]['DTSTART;VALUE=DATE'], ics.events[53]['DTEND;VALUE=DATE']], ['20281231', '20290101']);
  assert.equal(ics.events[1].DESCRIPTION, 'US week 2 of 2028 (Sunday start\\, not ISO): Sunday\\, January 2 to Saturday\\, January 8\\, 2028');
  assert.equal(new Set(ics.events.map(e => e.UID)).size, 54);
  assert.ok(ics.events.every(e => /^\d{8}T\d{6}Z$/.test(e.DTSTAMP) && e.TRANSP === 'TRANSPARENT'));
  // Whole-week events for ISO 2026: W01 is Mon 2025-12-29 to Sun 2026-01-04
  // (DTEND is the next Monday), W53 ends Sun 2027-01-03 (Python fromisocalendar).
  await page.selectOption('#wn-system', 'iso');
  await page.fill('#wn-year', '2026');
  await page.selectOption('#wn-ics-mode', 'week');
  ics = await readIcs();
  assert.equal(ics.name, 'iso-weeks-2026.ics');
  assert.equal(ics.events.length, 53);
  assert.deepEqual([ics.events[0]['DTSTART;VALUE=DATE'], ics.events[0]['DTEND;VALUE=DATE'], ics.events[0].UID], ['20251229', '20260105', 'iso-week-2026-W01@triplepdude.github.io']);
  assert.deepEqual([ics.events[38]['DTSTART;VALUE=DATE'], ics.events[38]['DTEND;VALUE=DATE'], ics.events[38].SUMMARY], ['20260921', '20260928', 'Week 39']);
  assert.deepEqual([ics.events[52]['DTSTART;VALUE=DATE'], ics.events[52]['DTEND;VALUE=DATE']], ['20261228', '20270104']);
  assert.equal(ics.events[52].DESCRIPTION, 'ISO week 2026-W53: Monday\\, December 28\\, 2026 to Sunday\\, January 3\\, 2027');
  // The last ISO week of 9999 ends in the year 10000, which DTEND cannot write.
  await page.fill('#wn-year', '9999');
  ics = await readIcs();
  assert.deepEqual([ics.events[51]['DTSTART;VALUE=DATE'], ics.events[51].DURATION, ics.events[51]['DTEND;VALUE=DATE']], ['99991227', 'P7D', undefined]);
  await page.selectOption('#wn-ics-mode', 'first');
  ics = await readIcs();
  assert.deepEqual([ics.events[51]['DTSTART;VALUE=DATE'], ics.events[51]['DTEND;VALUE=DATE']], ['99991227', '99991228']);
  await page.selectOption('#wn-system', 'us');
  await page.fill('#wn-year', '2028');

  // Bad year: friendly error, no rows, download disabled.
  await page.fill('#wn-year', '0');
  assert.ok((await text('#wn-year-msg')).length > 0);
  assert.equal(await rows.count(), 0);
  assert.equal(await page.locator('#wn-csv').isDisabled(), true);
  assert.equal(await page.locator('#wn-ics').isDisabled(), true);
  await page.click('#wn-this');
  assert.equal(await page.inputValue('#wn-year'), '2026');
  assert.equal(await rows.count(), 53);

  // Regression: the result blocks were live regions and errors were alerts, so
  // typing a year announced "2 has 52 ISO weeks", "20 has ..." and whole stat
  // blocks on every keystroke. Each section now has one short, delayed summary.
  for (const sel of ['#wn-date-msg', '#wn-date-week', '#wn-find-msg', '#wn-find-out', '#wn-year-msg', '#wn-table-note', '#wn-today-week']) {
    assert.equal(await page.locator(sel).evaluate(el => !!el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]')), false, `${sel} is not live`);
  }
  await page.evaluate(() => {
    window.__said = [];
    new MutationObserver(ms => ms.forEach(m => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const region = el && el.closest('[role="status"]');
      if (region && region.textContent.trim()) window.__said.push(region.textContent.trim());
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.selectOption('#wn-system', 'iso');
  await page.fill('#wn-year', '');
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__said.splice(0));
  await page.locator('#wn-year').pressSequentially('2032', { delay: 80 });
  await page.waitForFunction(() => document.querySelector('#wn-year-status').textContent === '2032: 53 ISO weeks.');
  assert.deepEqual(await page.evaluate(() => window.__said.splice(0)), ['2032: 53 ISO weeks.']);
  await page.fill('#wn-find-year', '2025');
  await page.fill('#wn-find-week', '53');
  await page.waitForFunction(() => document.querySelector('#wn-find-status').textContent === '2025 has 52 ISO weeks. Enter a week from 1 to 52.');
  await page.fill('#wn-date', '2021-01-03');
  await page.waitForFunction(() => document.querySelector('#wn-date-status').textContent === 'Sunday, January 3, 2021: ISO week 53 of 2020, 2020-W53-7.');
  await page.click('#wn-next');
  await page.waitForFunction(() => document.querySelector('#wn-year-status').textContent === '2033: 52 ISO weeks.');

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
