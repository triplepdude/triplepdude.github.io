// Expected run times were computed independently in Python: with croniter
// for standard expressions, and with a separate minute-by-minute walk over
// real instants (zoneinfo) that simulates cronie/Vixie cron's main loop and
// entry parser, covering the "*/2 day-of-month" quirk and daylight-saving
// changes (Europe/Rome, Australia/Lord_Howe, America/Santiago). croniter itself
// reads "0 0 */2 * 1" as day-of-month OR Monday, which is not what Vixie cron
// and cronie do, so that case uses only the brute-force walk.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async ({ page, open, assert, fixtures }) => {
  const text = sel => page.locator(sel).textContent();
  const runs = () => page.$$eval('#cr-runs td.cr-when', tds => tds.map(td => td.textContent));
  const rels = () => page.$$eval('#cr-runs td.cr-rel', tds => tds.map(td => td.textContent));
  const setExpr = v => page.fill('#cr-expr', v);
  const setNow = async iso => { await page.clock.setFixedTime(new Date(iso)); };
  const useUtc = on => page.selectOption('#cr-tz', on ? 'UTC' : 'local');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' });
  await setNow('2026-09-24T10:17:30Z'); // Thursday, 12:17:30 in Rome (CEST)
  await open();

  // Neither the description (it changes on every key) nor the run list (refreshed every
  // 30 s) is a live region; #cr-err-status reads a summary once typing pauses.
  assert.equal(await page.locator('#cr-desc').evaluate(el => !!el.closest('[aria-live]')), false);
  assert.equal(await page.locator('#cr-runs').evaluate(el => !!el.closest('[aria-live]')), false);

  // Default: weekdays at 09:00, local time.
  assert.equal(await page.inputValue('#cr-expr'), '0 9 * * 1-5');
  assert.equal(await text('#cr-desc'), 'At 09:00, Monday through Friday.');
  assert.equal(await page.inputValue('#cr-b-type'), 'weekdays');
  assert.equal(await text('#cr-zone'), 'Times in Europe/Rome');
  assert.deepEqual(await runs(), [
    'Fri 2026-09-25 09:00', 'Mon 2026-09-28 09:00', 'Tue 2026-09-29 09:00', 'Wed 2026-09-30 09:00', 'Thu 2026-10-01 09:00',
    'Fri 2026-10-02 09:00', 'Mon 2026-10-05 09:00', 'Tue 2026-10-06 09:00', 'Wed 2026-10-07 09:00', 'Thu 2026-10-08 09:00'
  ]);
  assert.equal((await rels())[0], 'in 20 h 43 min'); // 20 h 42.5 min, rounded
  assert.equal(await text('#cr-err'), '');

  // Office hours every 15 minutes, evaluated in UTC.
  await setExpr('*/15 9-17 * * 1-5');
  assert.equal(await text('#cr-desc'), 'Every 15 minutes from 09:00 through 17:45, Monday through Friday.');
  await useUtc(true);
  assert.equal(await text('#cr-zone'), 'Times in UTC');
  assert.deepEqual(await runs(), [
    'Thu 2026-09-24 10:30', 'Thu 2026-09-24 10:45', 'Thu 2026-09-24 11:00', 'Thu 2026-09-24 11:15', 'Thu 2026-09-24 11:30',
    'Thu 2026-09-24 11:45', 'Thu 2026-09-24 12:00', 'Thu 2026-09-24 12:15', 'Thu 2026-09-24 12:30', 'Thu 2026-09-24 12:45'
  ]);
  assert.equal((await rels())[0], 'in 13 min');
  const fieldRows = await page.$$eval('#cr-fields tr', trs => trs.map(tr => Array.from(tr.cells).map(c => c.textContent)));
  assert.deepEqual(fieldRows, [
    ['Minute', '*/15', '0, 15, 30, 45'], ['Hour', '9-17', '9–17'], ['Day of month', '*', 'every day'],
    ['Month', '*', 'every month'], ['Day of week', '1-5', 'Mon–Fri']
  ]);

  await setExpr('5 */2 * * *');
  assert.equal(await text('#cr-desc'), 'Every 2 hours from 00:05 through 22:05.');
  assert.deepEqual((await runs()).slice(0, 7), [
    'Thu 2026-09-24 12:05', 'Thu 2026-09-24 14:05', 'Thu 2026-09-24 16:05', 'Thu 2026-09-24 18:05',
    'Thu 2026-09-24 20:05', 'Thu 2026-09-24 22:05', 'Fri 2026-09-25 00:05'
  ]);

  // Names are case-insensitive and work in ranges.
  await setExpr('0 0 * jan-mar mon-fri');
  assert.equal(await text('#cr-desc'), 'At 00:00, Monday through Friday, January through March.');
  assert.deepEqual((await runs()).slice(0, 4), ['Fri 2027-01-01 00:00', 'Mon 2027-01-04 00:00', 'Tue 2027-01-05 00:00', 'Wed 2027-01-06 00:00']);

  // Leap day: only in leap years. February 30: never.
  await setExpr('0 0 29 2 *');
  assert.equal(await text('#cr-desc'), 'At 00:00 on the 29th of February.');
  assert.match(await text('#cr-note'), /only in leap years/);
  assert.deepEqual((await runs()).slice(0, 4), ['Tue 2028-02-29 00:00', 'Sun 2032-02-29 00:00', 'Fri 2036-02-29 00:00', 'Wed 2040-02-29 00:00']);
  await setExpr('0 0 30 2 *');
  assert.match(await text('#cr-note'), /February never has day 30, so this schedule never runs/);
  assert.deepEqual(await runs(), []);
  assert.match(await text('#cr-runs'), /never runs/);
  await useUtc(false);

  // Vixie rule: both day fields restricted -> either one matches.
  await setExpr('0 12 13 * 5');
  assert.equal(await text('#cr-desc'), 'At 12:00 on the 13th of the month and every Friday.');
  assert.match(await text('#cr-note'), /either the day of month or the day of week matches/);
  assert.deepEqual(await runs(), [
    'Fri 2026-09-25 12:00', 'Fri 2026-10-02 12:00', 'Fri 2026-10-09 12:00', 'Tue 2026-10-13 12:00', 'Fri 2026-10-16 12:00',
    'Fri 2026-10-23 12:00', 'Fri 2026-10-30 12:00', 'Fri 2026-11-06 12:00', 'Fri 2026-11-13 12:00', 'Fri 2026-11-20 12:00'
  ]);
  // ...but a day field starting with * (even */2) means both must match.
  await setExpr('0 0 */2 * 1');
  assert.equal(await text('#cr-desc'), 'At 00:00 on every 2nd day of the month from the 1st through the 31st, but only if that day is a Monday.');
  assert.match(await text('#cr-note'), /require both/);
  assert.deepEqual(await runs(), [
    'Mon 2026-10-05 00:00', 'Mon 2026-10-19 00:00', 'Mon 2026-11-09 00:00', 'Mon 2026-11-23 00:00', 'Mon 2026-12-07 00:00',
    'Mon 2026-12-21 00:00', 'Mon 2027-01-11 00:00', 'Mon 2027-01-25 00:00', 'Mon 2027-02-01 00:00', 'Mon 2027-02-15 00:00'
  ]);
  await setExpr('0 0 1-31 * 1-5');
  assert.equal(await text('#cr-desc'), 'At 00:00 every day.');
  assert.match(await text('#cr-note'), /runs every day/);

  // 7 is Sunday, like 0; quarterly months; shortcuts.
  await setExpr('0 0 * * 7');
  assert.equal(await text('#cr-desc'), 'At 00:00 on Sunday.');
  assert.deepEqual((await runs()).slice(0, 3), ['Sun 2026-09-27 00:00', 'Sun 2026-10-04 00:00', 'Sun 2026-10-11 00:00']);
  await setExpr('0 0 1 */3 *');
  assert.equal(await text('#cr-desc'), 'At 00:00 on the 1st of January, April, July and October.');
  assert.deepEqual((await runs()).slice(0, 5), ['Thu 2026-10-01 00:00', 'Fri 2027-01-01 00:00', 'Thu 2027-04-01 00:00', 'Thu 2027-07-01 00:00', 'Fri 2027-10-01 00:00']);
  await setExpr('@weekly');
  assert.equal(await text('#cr-desc'), 'At 00:00 on Sunday.');
  assert.match(await text('#cr-note'), /@weekly is shorthand for 0 0 \* \* 0/);
  await setExpr('@hourly');
  assert.equal(await text('#cr-desc'), 'Every hour, on the hour.');
  assert.equal((await runs())[0], 'Thu 2026-09-24 13:00');
  // Vixie cron, cronie and BusyBox compare shortcut names with strcmp.
  for (const bad of ['@HOURLY', '@Daily', '@REBOOT']) {
    await setExpr(bad);
    assert.equal(await text('#cr-err'), `Write ${bad.toLowerCase()} in lower case. Cron does not recognise "${bad}".`, bad);
    assert.equal(await text('#cr-desc'), '', bad);
    assert.deepEqual(await runs(), [], bad);
  }
  await setExpr('@reboot');
  assert.match(await text('#cr-desc'), /each time the cron daemon starts/);
  assert.deepEqual(await runs(), []);

  // More descriptions.
  const descs = [
    ['* * * * *', 'Every minute.'],
    ['*/5 * * * *', 'Every 5 minutes.'],
    ['0,30 * * * *', 'Every 30 minutes.'],
    ['15 * * * *', 'At 15 minutes past every hour.'],
    ['15,45 * * * *', 'At minutes 15 and 45 of every hour.'],
    ['0 */4 * * *', 'At 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 every day.'],
    ['0 0,12 * * *', 'At 00:00 and 12:00 every day.'],
    ['* 9 * * *', 'Every minute from 09:00 through 09:59.'],
    ['*/10 9,17 * * *', 'Every 10 minutes from 09:00 through 09:50 and from 17:00 through 17:50.'],
    ['0 0 1,15 * *', 'At 00:00 on the 1st and 15th of the month.'],
    ['0 0 1-7 * *', 'At 00:00 on days 1 through 7 of the month.'],
    ['0 0 1 1 *', 'At 00:00 on the 1st of January.'],
    ['30 2 * * 0,6', 'At 02:30 on Saturday and Sunday.'],
    ['0 0 * * 5-7', 'At 00:00, Friday through Sunday.'],
    ['0 9 * 6-8 1-5', 'At 09:00, Monday through Friday, June through August.'],
    ['0 8 * * 1,3,5', 'At 08:00 on Monday, Wednesday and Friday.'],
  ];
  for (const [e, d] of descs) {
    await setExpr(e);
    assert.equal(await text('#cr-desc'), d, e);
    assert.equal(await text('#cr-err'), '', e);
  }

  // A step after a single value works but is flagged as non-portable, in
  // the warning box rather than the neutral note.
  await setExpr('5/15 * * * *');
  assert.equal(await text('#cr-desc'), 'Every 15 minutes from minute 5 through 50 of every hour.');
  assert.match(await text('#cr-warn'), /Vixie cron and cronie reject .*BusyBox cron runs it only at 5.*Write 5-59\/15/);
  assert.equal(await text('#cr-note'), '');
  await setExpr('0 9 * * 1-5');
  assert.equal(await text('#cr-warn'), '', 'no warning for a portable expression');
  // cronie reads a day-of-week range ending in 0/SUN as ending in 7; Debian's
  // Vixie cron rejects it, so it is accepted with a warning.
  await setExpr('0 0 * * SAT-SUN');
  assert.equal(await text('#cr-err'), '');
  assert.equal(await text('#cr-desc'), 'At 00:00 on Saturday and Sunday.');
  assert.match(await text('#cr-warn'), /cronie reads "SAT-SUN" as 6-7.*Write 6-7/);
  assert.deepEqual((await runs()).slice(0, 3), ['Sat 2026-09-26 00:00', 'Sun 2026-09-27 00:00', 'Sat 2026-10-03 00:00']);
  await setExpr('0 0 * * 5-0');
  assert.equal(await text('#cr-desc'), 'At 00:00, Friday through Sunday.');
  // Feb 29 that is also a Sunday (AND mode because of */7): rare, but the
  // search covers 400 years. Expected dates from Python's datetime.
  await setExpr('0 0 29 2 */7');
  assert.deepEqual(await runs(), [
    'Sun 2032-02-29 00:00', 'Sun 2060-02-29 00:00', 'Sun 2088-02-29 00:00', 'Sun 2128-02-29 00:00', 'Sun 2156-02-29 00:00',
    'Sun 2184-02-29 00:00', 'Sun 2224-02-29 00:00', 'Sun 2252-02-29 00:00', 'Sun 2280-02-29 00:00', 'Sun 2320-02-29 00:00'
  ]);
  // A full crontab line: the rest is the command.
  await setExpr('0 5 * * * /usr/bin/backup.sh --full');
  assert.equal(await text('#cr-desc'), 'At 05:00 every day.');
  assert.match(await text('#cr-note'), /command: \/usr\/bin\/backup\.sh --full/);

  // Validation errors name the field and never throw.
  const errors = [
    ['60 * * * *', /^Minute field: 60 is out of range\. Allowed: 0–59\.$/, 0],
    ['* 24 * * *', /^Hour field: 24 is out of range/, 1],
    ['* * 0 * *', /^Day of month field: 0 is out of range/, 2],
    ['* * * 13 *', /^Month field: 13 is out of range/, 3],
    ['* * * * 8', /^Day of week field: 8 is out of range.*0 and 7 are Sunday/, 4],
    ['* * 5-1 * *', /^Day of month field: the range 5-1 runs backwards.*5-31,1/, 2],
    ['* * * * SAT-SUN/2', /^Day of week field: .*backwards.*6-7/, 4],
    ['0 22-2 * * *', /^Hour field: the range 22-2 runs backwards.*22-23,0-2/, 1],
    ['*/0 * * * *', /^Minute field: .*cannot be 0/, 0],
    ['1,,2 * * * *', /^Minute field: .*empty item/, 0],
    ['0 0 L * *', /^Day of month field: .*Quartz/, 2],
    ['0 0 ? * MON', /^Day of month field: .*Quartz/, 2],
    ['0 0 * * monday', /^Day of week field: write the three-letter name MON/, 4],
    ['x * * * *', /^Minute field: "x" is not a valid value/, 0],
  ];
  for (const [e, re, field] of errors) {
    await setExpr(e);
    assert.match(await text('#cr-err'), re, e);
    assert.equal(await text('#cr-desc'), '', e);
    assert.deepEqual(await runs(), [], e);
    const bad = await page.$$eval('#cr-fields tr', trs => trs.map((tr, i) => tr.classList.contains('cr-bad') ? i : -1).filter(i => i >= 0));
    assert.deepEqual(bad, [field], e);
  }
  await setExpr('60 24 * * *');
  assert.equal(await text('#cr-err'), 'Minute field: 60 is out of range. Allowed: 0–59.\nHour field: 24 is out of range. Allowed: 0–23.');
  await setExpr('* * * *');
  assert.match(await text('#cr-err'), /Expected 5 fields .* found 4/);
  await setExpr('0 0 12 * * ?');
  assert.match(await text('#cr-err'), /Found 6 fields.*seconds/);
  await setExpr('0 0 1 1 * 2027');
  assert.match(await text('#cr-err'), /Found 6 fields.*year/);
  await setExpr('@every 5m');
  assert.match(await text('#cr-err'), /Unknown shortcut "@every"/);
  await setExpr('   ');
  assert.match(await text('#cr-err'), /Enter a cron expression/);
  // Dashes pasted from documents are not hyphens.
  await setExpr('0 9 * * 1–5');
  assert.equal(await text('#cr-err'), 'Day of week field: "1–5" contains a typographic dash. Write ranges with a plain hyphen, as in 1-5.');
  // Long unbroken tokens in messages must wrap instead of widening the page.
  await page.setViewportSize({ width: 390, height: 844 });
  const long = 'x'.repeat(300);
  for (const e of ['0 9 * * 1-5 /usr/bin/' + long, long + ' * * * *', '@' + long, '5/15 * * * ' + long]) {
    await setExpr(e);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, 'no horizontal scroll for ' + e.slice(0, 20));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Regression: a long sixth token (the command) was tested with a regex that backtracked
  // quadratically: 20,000 characters took about 250 ms, 60,000 over 2 s.
  const longMs = await page.evaluate(() => {
    const el = document.querySelector('#cr-expr');
    el.value = '0 5 * * * ' + '1'.repeat(60000) + 'x';
    const t = performance.now();
    el.dispatchEvent(new Event('input'));
    return performance.now() - t;
  });
  assert.ok(longMs < 150, `a 60,000-character command took ${Math.round(longMs)} ms`);
  assert.match(await text('#cr-note'), /The rest of the line is the command: 1{100}/);

  // Builder writes the expression.
  const build = async (type, fill) => {
    await page.selectOption('#cr-b-type', type);
    if (fill) await fill();
    return page.inputValue('#cr-expr');
  };
  assert.equal(await build('minutes', () => page.selectOption('#cr-b-mstep', '15')), '*/15 * * * *');
  assert.equal(await text('#cr-desc'), 'Every 15 minutes.');
  assert.equal(await build('minutes', () => page.selectOption('#cr-b-mstep', '1')), '* * * * *');
  assert.equal(await build('hours', async () => { await page.selectOption('#cr-b-hstep', '6'); await page.fill('#cr-b-atmin', '30'); }), '30 */6 * * *');
  assert.equal(await text('#cr-desc'), 'At 00:30, 06:30, 12:30 and 18:30 every day.');
  assert.equal(await build('daily', () => page.fill('#cr-b-time', '14:05')), '5 14 * * *');
  assert.equal(await build('weekdays'), '5 14 * * 1-5');
  assert.equal(await page.isVisible('#cr-b-days'), false);
  assert.equal(await build('weekly', async () => {
    for (const v of ['1', '3', '5']) await page.uncheck(`#cr-b-days input[value="${v}"]`);
    for (const v of ['6', '0']) await page.check(`#cr-b-days input[value="${v}"]`);
  }), '5 14 * * 0,6');
  assert.equal(await text('#cr-desc'), 'At 14:05 on Saturday and Sunday.');
  await page.check('#cr-b-days input[value="1"]');
  await page.check('#cr-b-days input[value="2"]');
  assert.equal(await page.inputValue('#cr-expr'), '5 14 * * 0-2,6');
  for (const v of ['0', '1', '2']) await page.uncheck(`#cr-b-days input[value="${v}"]`);
  assert.equal(await page.inputValue('#cr-expr'), '5 14 * * 6');
  await page.uncheck('#cr-b-days input[value="6"]');
  assert.match(await text('#cr-b-hint'), /at least one day/);
  assert.equal(await page.inputValue('#cr-expr'), '5 14 * * 6', 'unchanged while the builder has an error');
  assert.equal(await build('monthly', async () => { await page.fill('#cr-b-dom', '31'); await page.fill('#cr-b-time', '23:59'); }), '59 23 31 * *');
  assert.match(await text('#cr-note'), /Months that have no day 31 are skipped/);
  await page.selectOption('#cr-b-type', 'yearly');
  await page.selectOption('#cr-b-month', '2');
  await page.fill('#cr-b-dom', '30');
  assert.equal(await text('#cr-b-hint'), 'February never has 30 days.');
  await page.selectOption('#cr-b-month', '12');
  await page.fill('#cr-b-dom', '25');
  await page.fill('#cr-b-time', '07:00');
  assert.equal(await page.inputValue('#cr-expr'), '0 7 25 12 *');
  assert.equal(await text('#cr-desc'), 'At 07:00 on the 25th of December.');
  assert.equal(await text('#cr-b-hint'), '');

  // Typing an expression moves the builder to the matching schedule.
  await setExpr('*/20 * * * *');
  assert.equal(await page.inputValue('#cr-b-type'), 'minutes');
  assert.equal(await page.inputValue('#cr-b-mstep'), '20');
  await setExpr('45 7 1 * *');
  assert.equal(await page.inputValue('#cr-b-type'), 'monthly');
  assert.equal(await page.inputValue('#cr-b-dom'), '1');
  assert.equal(await page.inputValue('#cr-b-time'), '07:45');
  await setExpr('0 9 * * mon-fri');
  assert.equal(await page.inputValue('#cr-b-type'), 'weekdays');
  await setExpr('*/15 9-17 * * 1-5');
  assert.equal(await page.inputValue('#cr-b-type'), 'custom');

  // Example buttons and copy.
  await page.click('button[data-cron="0 0 1,15 * *"]');
  assert.equal(await page.inputValue('#cr-expr'), '0 0 1,15 * *');
  assert.equal(await text('#cr-desc'), 'At 00:00 on the 1st and 15th of the month.');
  await page.click('.cr-exprrow button[data-copy-target]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '0 0 1,15 * *');

  // Daylight saving in Rome. Spring forward, 2027-03-28 02:00 -> 03:00: a
  // fixed-time 02:30 job runs right after the jump; * jobs skip the gap.
  await setNow('2027-03-27T12:00:00Z');
  await setExpr('30 2 * * *');
  assert.deepEqual((await runs()).slice(0, 3), ['Sun 2027-03-28 03:00', 'Mon 2027-03-29 02:30', 'Tue 2027-03-30 02:30']);
  assert.match(await text('#cr-runs tr:first-child .cr-dst'), /02:30 is skipped as clocks go forward/);
  await setExpr('0,30 2 * * *');
  assert.deepEqual((await runs()).slice(0, 4), ['Sun 2027-03-28 03:00', 'Sun 2027-03-28 03:00', 'Mon 2027-03-29 02:00', 'Mon 2027-03-29 02:30']);
  await setExpr('*/30 1-3 * * *');
  assert.deepEqual((await runs()).slice(0, 6), [
    'Sun 2027-03-28 01:00', 'Sun 2027-03-28 01:30', 'Sun 2027-03-28 03:00', 'Sun 2027-03-28 03:30', 'Mon 2027-03-29 01:00', 'Mon 2027-03-29 01:30'
  ]);
  // Fall back, 2026-10-25 03:00 -> 02:00: * jobs run in both copies of the
  // repeated hour, fixed-time jobs only once.
  await setNow('2026-10-24T21:00:00Z');
  await setExpr('*/30 * * * *');
  assert.deepEqual(await runs(), [
    'Sat 2026-10-24 23:30', 'Sun 2026-10-25 00:00', 'Sun 2026-10-25 00:30', 'Sun 2026-10-25 01:00', 'Sun 2026-10-25 01:30',
    'Sun 2026-10-25 02:00', 'Sun 2026-10-25 02:30', 'Sun 2026-10-25 02:00', 'Sun 2026-10-25 02:30', 'Sun 2026-10-25 03:00'
  ]);
  assert.deepEqual(await rels(), [
    'in 30 min', 'in 1 h', 'in 1 h 30 min', 'in 2 h', 'in 2 h 30 min', 'in 3 h', 'in 3 h 30 min',
    'in 4 h02:00 again, after clocks go back.', 'in 4 h 30 min02:30 again, after clocks go back.', 'in 5 h'
  ]);
  await setExpr('15 1-3 * * *');
  assert.deepEqual((await runs()).slice(0, 4), ['Sun 2026-10-25 01:15', 'Sun 2026-10-25 02:15', 'Sun 2026-10-25 03:15', 'Mon 2026-10-26 01:15']);
  assert.match(await text('#cr-runs tr:nth-child(2) .cr-dst'), /happens twice/);
  // The same schedule in UTC has no daylight saving.
  await useUtc(true);
  assert.deepEqual((await runs()).slice(0, 4), ['Sun 2026-10-25 01:15', 'Sun 2026-10-25 02:15', 'Sun 2026-10-25 03:15', 'Mon 2026-10-26 01:15']);
  assert.equal(await page.locator('#cr-runs .cr-dst').count(), 0);

  // Other daylight-saving shapes. Expected values come from a separate
  // minute-by-minute Python simulation of cronie's main loop (cron.c: the
  // "medium" jump runs skipped fixed-time jobs, the "negative" jump runs only
  // wildcard jobs), using zoneinfo. Lord Howe moves clocks by 30 minutes.
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Australia/Lord_Howe' });
  await setNow('2026-10-03T00:00:00Z');
  await open();
  await setExpr('15 2 * * *');
  assert.deepEqual((await runs()).slice(0, 3), ['Sun 2026-10-04 02:30', 'Mon 2026-10-05 02:15', 'Tue 2026-10-06 02:15']);
  await setExpr('*/10 2 * * *');
  assert.deepEqual((await runs()).slice(0, 6), [
    'Sun 2026-10-04 02:30', 'Sun 2026-10-04 02:40', 'Sun 2026-10-04 02:50', 'Mon 2026-10-05 02:00', 'Mon 2026-10-05 02:10', 'Mon 2026-10-05 02:20'
  ]);
  await setNow('2027-04-03T00:00:00Z');
  await setExpr('*/15 1 * * *');
  assert.deepEqual((await runs()).slice(0, 8), [
    'Sun 2027-04-04 01:00', 'Sun 2027-04-04 01:15', 'Sun 2027-04-04 01:30', 'Sun 2027-04-04 01:45',
    'Sun 2027-04-04 01:30', 'Sun 2027-04-04 01:45', 'Mon 2027-04-05 01:00', 'Mon 2027-04-05 01:15'
  ]);
  await setExpr('40 1 * * *');
  assert.deepEqual((await runs()).slice(0, 3), ['Sun 2027-04-04 01:40', 'Mon 2027-04-05 01:40', 'Tue 2027-04-06 01:40']);
  // Santiago changes at midnight: 00:00 -> 01:00 in September, and in April
  // 24:00 on Saturday goes back to Saturday 23:00.
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Santiago' });
  await setNow('2026-09-05T12:00:00Z');
  await open();
  await setExpr('30 0 * * *');
  assert.deepEqual((await runs()).slice(0, 3), ['Sun 2026-09-06 01:00', 'Mon 2026-09-07 00:30', 'Tue 2026-09-08 00:30']);
  await setNow('2027-04-03T12:00:00Z');
  await setExpr('*/20 23 * * *');
  assert.deepEqual((await runs()).slice(0, 8), [
    'Sat 2027-04-03 23:00', 'Sat 2027-04-03 23:20', 'Sat 2027-04-03 23:40', 'Sat 2027-04-03 23:00',
    'Sat 2027-04-03 23:20', 'Sat 2027-04-03 23:40', 'Sun 2027-04-04 23:00', 'Sun 2027-04-04 23:20'
  ]);

  // Live regions: typing must not fire an announcement per key.
  const record = () => page.evaluate(() => {
    window.__live = [];
    if (window.__liveOn) return;
    window.__liveOn = true;
    document.querySelectorAll('[aria-live], [role=alert], [role=status]').forEach(r => new MutationObserver(() =>
      window.__live.push([r.id || r.className, r.getAttribute('role') || r.getAttribute('aria-live'), r.textContent.trim()])
    ).observe(r, { childList: true, subtree: true, characterData: true }));
  });
  const heard = () => page.evaluate(() => window.__live);
  assert.equal(await page.locator('[role=alert]').count(), 0, 'no alert for typing errors');
  assert.deepEqual(await page.$eval('#cr-expr', e => e.getAttribute('aria-describedby').split(' ')), ['cr-err', 'cr-desc']);
  await setExpr('');
  await page.waitForTimeout(1000);
  await record();
  await page.focus('#cr-expr');
  await page.keyboard.type('*/5 9 * * 1', { delay: 30 });
  assert.match(await text('#cr-err'), /^$|Expected 5 fields/, 'the visible error still updates at once');
  await page.waitForTimeout(1200);
  let log = await heard();
  assert.deepEqual(log.map(l => l[0]), ['cr-err-status'], 'one status update for 11 keys: ' + JSON.stringify(log));
  assert.equal(log[0][2], await text('#cr-desc'), 'the pause reads the description, not an error');
  // Editing a valid expression key by key still gives one announcement, not one per key.
  await record();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('2', { delay: 30 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('3', { delay: 30 });
  await page.waitForTimeout(1200);
  log = await heard();
  assert.equal(log.filter(l => l[2]).length, 1, JSON.stringify(log));
  assert.match(log.filter(l => l[2])[0][2], /on Wednesday\./);
  await setExpr('*/5 9 * * 1');
  // A pause on an unfinished expression reads the error once, as a status.
  await record();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.doesNotMatch(await text('#cr-err-status'), /Expected/, 'not read out while typing');
  await page.waitForTimeout(1200);
  log = (await heard()).filter(l => l[0] === 'cr-err-status');
  assert.equal(log.length, 1, JSON.stringify(log));
  assert.match(log[0][2], /Expected 5 fields .* found 3\./);
  // Leaving the field says it at once.
  await setExpr('0 9 * *');
  await page.dispatchEvent('#cr-expr', 'change');
  assert.match(await text('#cr-err-status'), /Expected 5 fields .* found 4/);
  await page.click('[data-cron]');
  assert.equal(await text('#cr-err-status'), await text('#cr-desc'), 'an example reads its description');

  // ---------- Other formats ----------
  // Reference runs come from tests/fixtures/cron-expression-generator/reference-runs.json: a
  // separate brute-force Python implementation of each scheduler's documented rules (L, W,
  // LW, #, Quartz's 1 = Sunday, Spring's "both day fields must match", Kubernetes' OR rule,
  // cross-checked with croniter), all in UTC from 2026-09-24T10:17:30Z.
  const REF = JSON.parse(fs.readFileSync(path.join(fixtures, 'reference-runs.json'), 'utf8'));
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await setNow('2026-09-24T10:17:30Z');
  await open();
  const pick = async (dialect, expr) => {
    await page.selectOption('#cr-dialect', dialect);
    if (!(await page.isDisabled('#cr-tz'))) await page.selectOption('#cr-tz', 'UTC');
    if (expr !== undefined) await setExpr(expr);
  };
  const withSec = d => d === 'quartz' || d === 'spring';
  for (const [key, want] of Object.entries(REF.runs)) {
    const [dialect, expr] = key.split('|');
    await pick(dialect, expr);
    assert.equal(await text('#cr-err'), '', key);
    const got = await runs();
    const exp = want.map(w => (withSec(dialect) ? w : w.slice(0, -3)));
    assert.deepEqual(got.slice(0, exp.length), exp, key);
  }
  assert.match(await text('#cr-runs'), /./);
  await pick('quartz', '0 0 0 1 1 ? 2030');
  assert.deepEqual(await runs(), ['Tue 2030-01-01 00:00:00']);
  assert.match(await text('#cr-runs'), /No further runs in the chosen years/);

  // Descriptions, notes and field breakdowns.
  const DESCS = [
    ['quartz', '0 15 10 ? * 6#3', 'At 10:15 on the third Friday of the month.'],
    ['quartz', '0 15 10 L * ?', 'At 10:15 on the last day of the month.'],
    ['quartz', '0 15 10 L-2 * ?', 'At 10:15 on the day 2 days before the last day of the month.'],
    ['quartz', '0 0 9 LW * ?', 'At 09:00 on the last weekday (Monday to Friday) of the month.'],
    ['quartz', '0 0 9 15W * ?', 'At 09:00 on the weekday nearest the 15th of the month.'],
    ['quartz', '0 15 10 ? * 6L', 'At 10:15 on the last Friday of the month.'],
    ['quartz', '*/20 * * * * ?', 'Every 20 seconds.'],
    ['quartz', '0 0 8 ? JAN-MAR 2#1 2027-2028', 'At 08:00 on the first Monday of the month, January through March, 2027 through 2028.'],
    ['quartz', '0 0 12 ? * 4', 'At 12:00 on Wednesday.'],
    ['spring', '0 0 0 13 * FRI', 'At 00:00 on the 13th of the month, but only if that day is a Friday.'],
    ['spring', '30 0 9 * * 7', 'At 09:00:30 on Sunday.'],
    ['spring', '15 */5 * * * *', 'At second 15, every 5 minutes.'],
    ['spring', '*/10 * 9 * * *', 'Every 10 seconds from 09:00:00 through 09:59:59.'],
    ['spring', '@daily', 'At 00:00 every day.'],
    ['aws', 'cron(0 18 ? * MON-FRI *)', 'At 18:00, Monday through Friday.'],
    ['aws', 'cron(0 12 * * ? 2027)', 'At 12:00 every day in 2027.'],
    ['aws', 'rate(5 minutes)', 'Every 5 minutes, counted from when the rule is created.'],
    ['aws', 'rate(1 day)', 'Every day, counted from when the rule is created.'],
    ['aws', 'at(2026-12-24T18:00:00)', 'Once, on Thursday, December 24, 2026 at 18:00:00.'],
    ['k8s', '0 0 */2 * 1', 'At 00:00 on every 2nd day of the month from the 1st through the 31st and every Monday.'],
    ['k8s', '@weekly', 'At 00:00 on Sunday.'],
    ['github', '17 */6 * * *', 'At 00:17, 06:17, 12:17 and 18:17 every day.'],
  ];
  for (const [d, e, want] of DESCS) {
    await pick(d, e);
    assert.equal(await text('#cr-err'), '', `${d} ${e}`);
    assert.equal(await text('#cr-desc'), want, `${d} ${e}`);
  }
  await pick('quartz', '0 15 10 ? * 6#3');
  assert.match(await text('#cr-note'), /Quartz numbers weekdays from 1 \(Sunday\) to 7 \(Saturday\)/);
  assert.deepEqual(await page.$$eval('#cr-fields tr', trs => trs.map(tr => Array.from(tr.cells).map(c => c.textContent))), [
    ['Second', '0', '0'], ['Minute', '15', '15'], ['Hour', '10', '10'], ['Day of month', '?', 'no specific value (?)'], ['Month', '*', 'every month'], ['Day of week', '6#3', 'third Friday']]);
  await pick('spring', '0 0 0 13 * FRI');
  assert.match(await text('#cr-note'), /only on days that match both/);
  await pick('spring', '0 9 * * 1-5');
  assert.match(await text('#cr-note'), /node-cron reads this as second 0, but Spring requires all 6 fields/);
  assert.equal((await runs())[0], 'Fri 2026-09-25 09:00:00');
  await pick('k8s', '0 0 */2 * 1');
  assert.match(await text('#cr-note'), /runs when either the day of month or the day of week matches/);
  await pick('aws', '0 18 ? * MON-FRI *');
  assert.match(await text('#cr-note'), /EventBridge expects the expression wrapped as cron\(0 18 \? \* MON-FRI \*\)/);
  await pick('aws', 'rate(5 minutes)');
  assert.deepEqual((await runs()).slice(0, 2), ['Thu 2026-09-24 10:22:30', 'Thu 2026-09-24 10:27:30']);
  assert.match(await text('#cr-runs'), /Counted from now/);
  await pick('aws', 'at(2026-12-24T18:00:00)');
  assert.deepEqual(await runs(), ['Thu 2026-12-24 18:00:00']);

  // Errors specific to each format.
  const ERRS = [
    ['quartz', '0 0 12 * * MON', /Quartz does not allow both day fields to be set\. Put \? in the one you don’t use: "0 0 12 \* \* \?" .* "0 0 12 \? \* MON"/],
    ['quartz', '0 0 12 ? * ?', /Only one of the day fields can be \?/],
    ['quartz', '0 0 12 ? * 0', /^Day of week field: 0 is out of range\. Allowed: 1–7 \(1 is Sunday, 7 is Saturday\)/],
    ['quartz', '0 0 12 ? * FRI#6', /the number after # must be from 1 to 5/],
    ['quartz', '0 0 12 1,L * ?', /must stand alone in the field/],
    ['quartz', '0 12 * * ?', /^Expected 6 or 7 fields/],
    ['quartz', '0 0 12 ? * MON 2100', /^Year field: 2100 is out of range\. Allowed: 1970–2099/],
    ['quartz', '0 0 12 ? * 2-6/?', /"\?" must stand alone/],
    ['spring', '0 0 9 * * L', /write the weekday instead of a bare "L"/],
    ['spring', '0 0 9 * * * *', /Found 7 fields, but Spring uses 6/],
    ['spring', '@reboot', /Spring has no @reboot/],
    ['aws', 'cron(0 12 * * * *)', /AWS EventBridge does not allow both day fields/],
    ['aws', 'cron(0 12 * * ?)', /Expected 6 fields/],
    ['aws', 'CRON(0 12 * * ? *)', /Write cron\( \) in lower case/],
    ['aws', 'rate(1 minutes)', /singular unit for a value of 1: rate\(1 minute\)/],
    ['aws', 'rate(2 hour)', /plural unit for values above 1: rate\(2 hours\)/],
    ['aws', 'rate(5 weeks)', /"weeks" is not a rate unit/],
    ['aws', 'rate(5 minutes', /Close the brackets/],
    ['aws', 'at(2026-02-30T10:00:00)', /not a real date and time/],
    ['aws', 'cron(0 12 ? * MON 2200)', /^Year field: 2200 is out of range\. Allowed: 1970–2199/],
    ['aws', '@daily', /AWS EventBridge does not accept shortcuts like @daily\. Write the fields out, for example cron\(0 0 \* \* \? \*\)/],
    ['github', '@daily', /GitHub Actions does not accept shortcuts like @daily\. Write the fields out, for example 0 0 \* \* \*/],
    ['github', '0 0 L * *', /extension \(L, W, #\) that GitHub Actions does not support/],
    ['github', '0 0 ? * 1', /"\?" is a Quartz, Spring and AWS symbol that GitHub Actions does not accept/],
    ['k8s', 'TZ=Europe/Rome 0 9 * * *', /Kubernetes rejects a time zone inside the schedule.*spec\.timeZone/],
    ['k8s', '@reboot', /Kubernetes has no @reboot/],
    ['k8s', '0 9 * * 5-0', /^Day of week field: the range 5-0 runs backwards/],
    ['k8s', '0 0 9 * * *', /Found 6 fields, but Kubernetes uses 5.*seconds field belongs to Quartz or Spring/],
  ];
  for (const [d, e, re] of ERRS) {
    await pick(d, e);
    assert.match(await text('#cr-err'), re, `${d} ${e}`);
    assert.equal(await text('#cr-desc'), '', `${d} ${e}`);
  }
  // Quirks that are accepted: robfig's N/step, AWS's LW (with a warning).
  await pick('k8s', '5/15 * * * *');
  assert.equal(await text('#cr-warn'), '', 'Kubernetes reads 5/15 as 5-59/15 without complaint');
  await pick('aws', 'cron(0 9 LW * ? *)');
  assert.match(await text('#cr-warn'), /"LW" works in Quartz and Spring, but AWS does not document it/);

  // GitHub: UTC by default (the schedule may set timezone), at most every 5 minutes,
  // the top of the hour is busy, and N/step is documented (no Vixie warning).
  await pick('github', '*/2 * * * *');
  assert.equal(await page.isDisabled('#cr-tz'), false);
  assert.equal(await page.inputValue('#cr-tz'), 'UTC');
  assert.match(await text('#cr-warn'), /at most once every 5 minutes/);
  await setExpr('20/15 * * * *');
  assert.equal(await text('#cr-warn'), '', 'GitHub documents 20/15 as minutes 20, 35 and 50');
  assert.deepEqual((await runs()).slice(0, 3), ['Thu 2026-09-24 10:20', 'Thu 2026-09-24 10:35', 'Thu 2026-09-24 10:50']);
  await setExpr('0 9 * * 7');
  assert.match(await text('#cr-warn'), /GitHub documents weekdays as 0–6/);
  await setExpr('0 9 * * 1-5');
  await page.selectOption('#cr-tz', 'America/New_York');
  assert.match(await text('#cr-note'), /Add timezone: "America\/New_York"/);
  await page.selectOption('#cr-dialect', 'unix');
  await page.selectOption('#cr-tz', 'America/New_York');
  assert.equal((await page.$$eval('#cr-trans tr', trs => Object.fromEntries(trs.map(tr => [tr.dataset.target, tr.cells[1].textContent])))).github,
    "on:\n  schedule:\n    - cron: '0 9 * * 1-5'\n      timezone: \"America/New_York\"");
  // Kubernetes (robfig/cron) allows weekdays 0-6 only, and a * anywhere in a day-field list
  // makes both day fields required.
  await pick('k8s', '0 9 * * 7');
  assert.match(await text('#cr-err'), /7 is out of range\. Allowed: 0–6/);
  // robfig reads 5/1 in the weekday field as 5-6 (its maximum is 6), never Sunday.
  await setExpr('0 9 * * 5/1');
  assert.deepEqual((await runs()).slice(0, 3), ['Fri 2026-09-25 09:00', 'Sat 2026-09-26 09:00', 'Fri 2026-10-02 09:00']);
  await setExpr('0 0 1,* * 1');
  assert.deepEqual((await runs()).slice(0, 2), ['Mon 2026-09-28 00:00', 'Mon 2026-10-05 00:00']);
  await pick('github', '*/2 * * * *');
  await setExpr('*/5 * * * *');
  assert.equal(await text('#cr-warn'), '');
  await setExpr('0 * * * *');
  assert.match(await text('#cr-note'), /start of each hour/);
  assert.match(await text('#cr-note'), /GitHub runs schedules in UTC/);

  // ---------- Same schedule elsewhere ----------
  const trans = () => page.$$eval('#cr-trans tr', trs => Object.fromEntries(trs.map(tr => [tr.dataset.target, tr.cells[1].textContent])));
  await page.selectOption('#cr-tz', 'UTC').catch(() => {});
  await pick('unix', '0 9 * * 1-5');
  assert.deepEqual(await trans(), {
    k8s: 'schedule: "0 9 * * 1-5"\ntimeZone: "Etc/UTC"', github: "on:\n  schedule:\n    - cron: '0 9 * * 1-5'", aws: 'cron(0 9 ? * MON-FRI *)',
    quartz: '0 0 9 ? * MON-FRI', spring: '0 0 9 * * MON-FRI', systemd: 'OnCalendar=Mon..Fri *-*-* 09:00:00 UTC',
  });
  await page.selectOption('#cr-tz', 'Europe/Rome');
  assert.equal((await trans()).k8s, 'schedule: "0 9 * * 1-5"\ntimeZone: "Europe/Rome"');
  assert.equal((await trans()).systemd, 'OnCalendar=Mon..Fri *-*-* 09:00:00 Europe/Rome');
  await page.selectOption('#cr-tz', 'UTC');
  await setExpr('0 12 13 * 5');
  let tr = await trans();
  assert.equal(tr.systemd, 'OnCalendar=Fri *-*-* 12:00:00 UTC\nOnCalendar=*-*-13 12:00:00 UTC');
  assert.match(tr.quartz, /either day field matches, which Quartz can’t express/);
  assert.equal(tr.k8s, 'schedule: "0 12 13 * 5"\ntimeZone: "Etc/UTC"');
  await setExpr('0 0 */2 * 1');
  tr = await trans();
  assert.equal(tr.spring, '0 0 0 */2 * MON');
  assert.match(tr.k8s, /Needs both day fields to match, which Kubernetes can’t express/);
  assert.equal(tr.github, "on:\n  schedule:\n    - cron: '0 0 */2 * 1'");
  await pick('k8s', '0 0 */2 * 1');
  assert.equal((await trans()).unix, '0 0 1-31/2 * 1', 'the OR rule needs a field that does not start with *');
  await pick('quartz', '0 15 10 ? * 6#3');
  tr = await trans();
  assert.deepEqual([tr.aws, tr.spring, tr.systemd, tr.unix], ['cron(15 10 ? * 6#3 *)', '0 15 10 * * FRI#3', 'OnCalendar=Fri *-*-15..21 10:15:00 UTC', 'No L, W or # values.']);
  await pick('quartz', '*/20 * * * * ?');
  tr = await trans();
  assert.deepEqual([tr.spring, tr.systemd, tr.unix], ['*/20 * * * * *', 'OnCalendar=*-*-* *:*:00/20 UTC', 'No seconds field.']);

  // Every translation runs at the same times as the original, checked by reading it back in
  // its own format (UTC). Crontab-style ones are also checked against systemd below.
  const cronOf = (target, t) => (target === 'github' ? t.match(/cron: '([^']+)'/)[1] : target === 'k8s' ? t.match(/schedule: "([^"]+)"/)[1] : t);
  const SOURCES = [['unix', '0 9 * * 1-5'], ['unix', '*/15 9-17 * * 1-5'], ['unix', '0 0 1,15 * *'], ['unix', '0 0 */2 * 1'], ['unix', '0 12 13 * 5'], ['unix', '5 */2 * 1-6 0,6'],
    ['quartz', '0 15 10 ? * 6#3'], ['quartz', '0 15 10 L-2 * ?'], ['quartz', '0 0 8 ? JAN-MAR 2#1 2027-2028'], ['spring', '0 0 0 13 * FRI'], ['spring', '*/10 * 9 * * *'],
    ['aws', 'cron(0 10 L * ? *)'], ['k8s', '0 0 */2 * 1'], ['aws', 'cron(30 6 ? * 1,7 *)']];
  let checked = 0;
  for (const [d, e] of SOURCES) {
    await pick(d, e);
    const base = (await runs()).map(r => (withSec(d) ? r : r + ':00'));
    const t = await trans();
    for (const [target, text2] of Object.entries(t)) {
      if (target === 'systemd' || /^[A-Z][a-z ]|^No |^Not |^Runs |^Needs /.test(text2)) continue;
      await pick(target, cronOf(target, text2));
      assert.equal(await text('#cr-err'), '', `${d} ${e} -> ${target} ${text2}`);
      const got = (await runs()).map(r => (withSec(target) ? r : r + ':00'));
      assert.deepEqual(got, base, `${d} ${e} -> ${target} ${text2}`);
      checked++;
    }
  }
  assert.ok(checked > 30, `${checked} translations read back`);

  // systemd-analyze, when present, computes the OnCalendar times independently.
  let systemdOk = false;
  try { systemdOk = process.platform === 'linux' && /systemd/.test(execFileSync('systemd-analyze', ['--version']).toString()); } catch (e) { systemdOk = false; }
  if (systemdOk) {
    const SD = [['unix', '0 9 * * 1-5'], ['unix', '*/15 9-17 * * 1-5'], ['unix', '0 12 13 * 5'], ['unix', '0 0 */2 * 1'], ['unix', '5 */2 * 1-6 0,6'], ['unix', '0 0 1 */3 *'],
      ['quartz', '0 15 10 ? * 6#3'], ['quartz', '0 15 10 ? * 6L'], ['quartz', '0 15 10 L * ?'], ['quartz', '0 15 10 L-2 * ?'], ['quartz', '*/20 * * * * ?'],
      ['quartz', '0 0 8 ? JAN-MAR 2#1 2027-2028'], ['spring', '0 0 0 13 * FRI'], ['spring', '15 */5 * * * *'], ['aws', 'cron(0 18 ? * MON-FRI *)'], ['k8s', '0 0 */2 * 1']];
    for (const [d, e] of SD) {
      await pick(d, e);
      const lines = (await text('#cr-trans-systemd')).split('\n').map(l => l.replace(/^OnCalendar=/, ''));
      const out = execFileSync('systemd-analyze', ['calendar', '--iterations=6', '--base-time=2026-09-24 10:17:30 UTC', ...lines], { env: { TZ: 'UTC', PATH: process.env.PATH } }).toString();
      const sdRuns = [...out.matchAll(/(?:Next elapse|Iteration #\d+): (\w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/g)].map(m => m[1]).sort((a, b) => a.slice(4).localeCompare(b.slice(4)));
      const uniq = [...new Set(sdRuns)].slice(0, 6);
      const page6 = (await runs()).slice(0, 6).map(r => (withSec(d) ? r : r + ':00'));
      assert.deepEqual(page6, uniq, `systemd ${lines.join(' + ')} for ${d} ${e}`);
    }
  }

  // ---------- Switching format converts the expression ----------
  await pick('unix', '0 9 * * 1-5');
  await page.selectOption('#cr-dialect', 'quartz');
  assert.equal(await page.inputValue('#cr-expr'), '0 0 9 ? * MON-FRI');
  assert.equal(await text('#cr-desc'), 'At 09:00, Monday through Friday.');
  assert.equal(await page.inputValue('#cr-b-type'), 'weekdays');
  await page.selectOption('#cr-dialect', 'aws');
  assert.equal(await page.inputValue('#cr-expr'), 'cron(0 9 ? * MON-FRI *)');
  await page.selectOption('#cr-dialect', 'spring');
  assert.equal(await page.inputValue('#cr-expr'), '0 0 9 * * MON-FRI');
  await page.selectOption('#cr-dialect', 'unix');
  assert.equal(await page.inputValue('#cr-expr'), '0 9 * * 1-5');
  await setExpr('0 12 13 * 5');
  await page.selectOption('#cr-dialect', 'quartz');
  assert.equal(await page.inputValue('#cr-expr'), '0 12 13 * 5', 'kept as typed');
  assert.match(await text('#cr-err'), /^Kept as typed: Quartz can’t express this schedule/);
  // Builder output follows the format.
  await pick('quartz');
  await page.selectOption('#cr-b-type', 'weekly');
  await page.fill('#cr-b-time', '07:30');
  for (const v of ['1', '3', '5']) await page.check(`#cr-b-days input[value="${v}"]`);
  for (const v of ['2', '4', '6', '0']) await page.uncheck(`#cr-b-days input[value="${v}"]`);
  assert.equal(await page.inputValue('#cr-expr'), '0 30 7 ? * MON,WED,FRI');
  await page.selectOption('#cr-b-type', 'seconds');
  await page.selectOption('#cr-b-sstep', '15');
  assert.equal(await page.inputValue('#cr-expr'), '*/15 * * * * ?');
  assert.equal(await page.inputValue('#cr-b-type'), 'seconds');
  await pick('aws');
  assert.equal(await page.isVisible('#cr-b-sstep'), false);
  await page.selectOption('#cr-b-type', 'monthly');
  await page.fill('#cr-b-dom', '15');
  await page.fill('#cr-b-time', '06:00');
  assert.equal(await page.inputValue('#cr-expr'), 'cron(0 6 15 * ? *)');
  assert.equal(await page.locator('#cr-b-type option[value="seconds"]').isDisabled(), true);
  await pick('spring', '0 0 9 1 1 *');
  assert.equal(await page.inputValue('#cr-b-type'), 'yearly');

  // Daylight saving in other formats: the run is listed and flagged rather than guessed.
  await setNow('2027-03-27T12:00:00Z');
  await pick('quartz', '0 30 2 * * ?');
  await page.selectOption('#cr-tz', 'Europe/Rome');
  assert.equal((await runs())[0], 'Sun 2027-03-28 03:00:00');
  assert.match(await text('#cr-runs tr:first-child .cr-dst'), /02:30:00 does not exist on this day.*Schedulers differ/);
  assert.equal((await runs())[1], 'Mon 2027-03-29 02:30:00');
  await setNow('2026-10-24T12:00:00Z');
  await setExpr('0 30 2 * * ?');
  assert.deepEqual((await runs()).slice(0, 2), ['Sun 2026-10-25 02:30:00', 'Mon 2026-10-26 02:30:00']);
  assert.match(await text('#cr-runs tr:first-child .cr-dst'), /happens twice as clocks go back; check whether Quartz runs the job once or twice/);
  // Any IANA zone can be picked: 09:00 in Tokyo is 00:00 UTC.
  await pick('spring', '0 0 9 * * *');
  await page.selectOption('#cr-tz', 'Asia/Tokyo');
  assert.equal(await text('#cr-zone'), 'Times in Asia/Tokyo');
  assert.equal((await runs())[0], 'Sun 2026-10-25 09:00:00');
  assert.equal(await page.locator('#cr-tz option').count() > 100, true);
  await page.selectOption('#cr-dialect', 'unix');

  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
