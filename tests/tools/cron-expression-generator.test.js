// Expected run times were computed independently in Python: with croniter
// for standard expressions, and with a separate minute-by-minute walk over
// real instants (zoneinfo) that simulates cronie/Vixie cron's main loop and
// entry parser, covering the "*/2 day-of-month" quirk and daylight-saving
// changes (Europe/Rome, Australia/Lord_Howe, America/Santiago). croniter itself
// reads "0 0 */2 * 1" as day-of-month OR Monday, which is not what Vixie cron
// and cronie do, so that case uses only the brute-force walk.
module.exports = async ({ page, open, assert }) => {
  const text = sel => page.locator(sel).textContent();
  const runs = () => page.$$eval('#cr-runs td.cr-when', tds => tds.map(td => td.textContent));
  const rels = () => page.$$eval('#cr-runs td.cr-rel', tds => tds.map(td => td.textContent));
  const setExpr = v => page.fill('#cr-expr', v);
  const setNow = async iso => { await page.clock.setFixedTime(new Date(iso)); };
  const useUtc = on => (on ? page.check('#cr-utc') : page.uncheck('#cr-utc'));

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' });
  await setNow('2026-09-24T10:17:30Z'); // Thursday, 12:17:30 in Rome (CEST)
  await open();

  // The description is announced; the run list, refreshed every 30 s, is not.
  assert.equal(await page.locator('#cr-desc').evaluate(el => !!el.closest('[aria-live]')), true);
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

  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
