// Expected hours and pay were computed independently in Python: an
// allocation written from the FLSA / California Labor Code 510 rules, with
// decimal.Decimal and ROUND_HALF_UP for pay. Not copied from the page.
const fs = require('fs');

module.exports = async ({ page, open, assert }) => {
  // Thursday 2026-09-24: the default week is Monday 2026-09-21 to Sunday 2026-09-27.
  await page.clock.install({ time: new Date('2026-09-24T12:00:00Z') });
  await open();
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  await page.selectOption('#tc-format', '12');
  const text = sel => page.locator(sel).textContent();
  const f = (w, d, k) => page.locator(`#tc-${w}-${d}-${k}`);
  const day = (w, d) => page.locator(`#tc-${w}-${d}-l`).locator('xpath=..');
  const MON = 0, TUE = 1, WED = 2, THU = 3, FRI = 4, SAT = 5, SUN = 6;
  const setDay = async (w, d, inT, outT, brk) => {
    await f(w, d, 'in1').fill(inT);
    await f(w, d, 'out1').fill(outT);
    await f(w, d, 'brk').fill(brk);
  };

  // Default: Mon-Fri 8:00 AM to 5:00 PM with 30-minute breaks = 42:30,
  // 40 regular + 2:30 overtime; at 20.00 that is 800.00 + 75.00 = 875.00.
  assert.equal(await page.inputValue('#tc-date'), '2026-09-21');
  assert.equal(await text('#tc-wh0'), 'Week: Mon, Sep 21, 2026 to Sun, Sep 27, 2026');
  assert.equal(await f(0, MON, 'in1').inputValue(), '8:00 AM');
  assert.equal(await text('#tc-total'), '42:30');
  assert.equal(await text('#tc-total-dec'), '42.50 hours');
  assert.equal(await text('#tc-reg'), '40:00');
  assert.equal(await text('#tc-ot'), '2:30');
  assert.equal(await text('#tc-pay'), '875.00');
  assert.equal(await day(0, FRI).locator('.tc-split').textContent(), 'OT 2:30');
  assert.equal(await day(0, THU).locator('.tc-split').textContent(), '');
  assert.equal(await day(0, MON).locator('.tc-hm').textContent(), '8:30');
  assert.equal(await day(0, MON).locator('.tc-dec').textContent(), '8.50');
  const payRows = async () => page.$$eval('#tc-paytable tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
  assert.deepEqual(await payRows(), [
    ['Regular', '40:00', '40.00', '20.00', '800.00'],
    ['Overtime (1.5×)', '2:30', '2.50', '30.00', '75.00'],
  ]);
  assert.equal(await text('#tc-f-pay'), '875.00');

  // Rate 18.33: 733.20 + 2.5 h x 27.495 = 68.7375 -> 68.74; total 801.94.
  await page.fill('#tc-rate', '18.33');
  assert.deepEqual((await payRows())[1], ['Overtime (1.5×)', '2:30', '2.50', '27.495', '68.74']);
  assert.equal(await text('#tc-pay'), '801.94');

  // CSV download of that week.
  await page.fill('#tc-name', 'Sam O\'Neil, Jr.');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-csv')]);
  assert.equal(dl.suggestedFilename(), 'time-card-2026-09-21.csv');
  const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').split('\r\n');
  assert.equal(csv[0], 'Time card,"Sam O\'Neil, Jr."');
  assert.equal(csv[1], 'Rules,Overtime (1.5×) over 40 hours a week.');
  assert.equal(csv[3], 'Week,Date,Day,In,Out,Break (min),Hours (h:mm),Hours (decimal),Regular,Overtime,Double time');
  assert.equal(csv[4], '1,2026-09-21,Monday,8:00 AM,5:00 PM,30,8:30,8.50,8.50,0.00,0.00');
  assert.equal(csv[8], '1,2026-09-25,Friday,8:00 AM,5:00 PM,30,8:30,8.50,6.00,2.50,0.00');
  assert.equal(csv[9], '1,2026-09-26,Saturday,,,,,,,,');
  assert.equal(csv[11], 'Week 1 total,,,,,,42:30,42.50,40.00,2.50,0.00');
  assert.equal(csv[13], 'Pay type,Hours (decimal),Rate,Amount');
  assert.equal(csv[14], 'Regular,40.00,18.33,733.20');
  assert.equal(csv[15], 'Overtime (1.5×),2.50,27.495,68.74');
  assert.equal(csv[17], 'Total,42.50,,801.94');
  // A name that looks like a formula is neutralised.
  await page.fill('#tc-name', '=HYPERLINK("x")');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#tc-csv')]);
  assert.equal(fs.readFileSync(await dl2.path(), 'utf8').replace(/^﻿/, '').split('\r\n')[0], 'Time card,"\'=HYPERLINK(""x"")"');

  // California: Mon 10 h, Tue 13 h, Wed 8, Thu 9, Fri 8, Sat 6, Sun 5 (all seven days).
  await page.fill('#tc-rate', '25');
  await setDay(0, MON, '8:00 AM', '6:30 PM', '30');
  await setDay(0, TUE, '6am', '7:30pm', '30');
  await setDay(0, WED, '9', '17:30', '30');
  await setDay(0, THU, '8', '17:30', '30');
  await setDay(0, FRI, '9', '17:30', '30');
  await setDay(0, SAT, '9', '15', '');
  await setDay(0, SUN, '10', '15', '0');
  assert.equal(await text('#tc-total'), '59:00');
  // Federal: 40 regular, 19 overtime (Friday's 8 hours onward), 1,712.50.
  assert.equal(await text('#tc-reg'), '40:00');
  assert.equal(await text('#tc-ot'), '19:00');
  assert.equal(await text('#tc-pay'), '1,712.50');
  assert.equal(await day(0, FRI).locator('.tc-split').textContent(), 'OT 8:00');
  await page.selectOption('#tc-preset', 'california');
  assert.equal(await page.isChecked('#tc-daily-on'), true);
  assert.equal(await page.isChecked('#tc-seventh-on'), true);
  assert.equal(await text('#tc-reg'), '40:00');
  assert.equal(await text('#tc-ot'), '18:00');
  assert.equal(await text('#tc-dtt'), '1:00');
  assert.equal(await text('#tc-pay'), '1,725.00');
  assert.equal(await day(0, MON).locator('.tc-split').textContent(), 'OT 2:00');
  assert.equal(await day(0, TUE).locator('.tc-split').textContent(), 'OT 4:00 · DT 1:00');
  assert.equal(await day(0, SAT).locator('.tc-split').textContent(), 'OT 6:00');
  assert.equal(await day(0, SUN).locator('.tc-split').textContent(), 'OT 5:00');
  assert.match(await text('#tc-rule-note'), /California/);
  // Week starting Sunday: Saturday becomes the 7th day. The date moves back to Sunday Sep 20.
  await page.selectOption('#tc-startday', '6');
  assert.equal(await page.inputValue('#tc-date'), '2026-09-20');
  assert.equal(await page.locator('.tc-week:first-of-type .tc-day .tc-dname').first().textContent(), 'Sunday');
  assert.equal(await text('#tc-ot'), '18:00');
  assert.equal(await text('#tc-dtt'), '1:00');
  assert.equal(await day(0, FRI).locator('.tc-split').textContent(), 'OT 5:00');
  assert.equal(await day(0, SAT).locator('.tc-split').textContent(), 'OT 6:00');
  assert.equal(await day(0, SUN).locator('.tc-split').textContent(), '');
  // Changing a rule by hand switches the preset to Custom.
  await page.uncheck('#tc-seventh-on');
  assert.equal(await page.inputValue('#tc-preset'), 'custom');
  await page.check('#tc-seventh-on');
  assert.equal(await page.inputValue('#tc-preset'), 'california');
  // A double-time threshold below the daily one is an error.
  await page.fill('#tc-dt', '6');
  assert.match(await text('#tc-settings-msg'), /double-time threshold must be higher/);
  await page.fill('#tc-dt', '12');
  assert.equal(await text('#tc-settings-msg'), '');
  // Picking a date moves the start day to match.
  await page.fill('#tc-date', '2026-09-21');
  assert.equal(await page.inputValue('#tc-startday'), '0');
  assert.equal(await page.inputValue('#tc-date'), '2026-09-21');

  // Bi-weekly, federal: 45 h then 35 h is 5 h overtime, not 0 (weeks are never averaged).
  await page.selectOption('#tc-preset', 'federal');
  await page.fill('#tc-rate', '20');
  await page.click('#tc-clear');
  assert.equal(await text('#tc-total'), '0:00');
  await page.selectOption('#tc-period', '2');
  assert.equal(await page.locator('#tc-week1').isVisible(), true);
  assert.equal(await text('#tc-wh1'), 'Week 2: Mon, Sep 28, 2026 to Sun, Oct 4, 2026');
  await setDay(0, MON, '8', '5:30p', '30');
  await page.click('#tc-fill');
  for (const d of [TUE, WED, THU, FRI]) assert.equal(await f(0, d, 'out1').inputValue(), '5:30 PM');
  assert.equal(await f(1, MON, 'in1').inputValue(), '8:00 AM');
  for (const d of [MON, TUE, WED, THU, FRI]) await f(1, d, 'out1').fill('3:30 PM');
  assert.equal(await f(0, SAT, 'in1').inputValue(), '');
  assert.equal(await text('#tc-total'), '80:00');
  assert.equal(await text('#tc-reg'), '75:00');
  assert.equal(await text('#tc-ot'), '5:00');
  assert.equal(await text('#tc-pay'), '1,650.00');
  assert.match(await text('#tc-wt0'), /Overtime: 5:00 \(5\.00\)/);
  assert.match(await text('#tc-wt1'), /Overtime: 0:00 \(0\.00\)/);
  assert.equal(await text('#tc-total-label'), 'Total for the two weeks');
  await page.selectOption('#tc-period', '1');

  // Two in/out pairs: lunch clocked out, and an overnight split shift.
  await page.selectOption('#tc-pairs', '2');
  assert.equal(await f(0, MON, 'in2').isVisible(), true);
  await page.click('#tc-clear');
  await f(0, MON, 'in1').fill('8:00 AM'); await f(0, MON, 'out1').fill('12:00 PM');
  await f(0, MON, 'in2').fill('12:30 PM'); await f(0, MON, 'out2').fill('5:00 PM');
  assert.equal(await day(0, MON).locator('.tc-hm').textContent(), '8:30');
  await f(0, TUE, 'in1').fill('10 PM'); await f(0, TUE, 'out1').fill('2 AM');
  await f(0, TUE, 'in2').fill('2:30 AM'); await f(0, TUE, 'out2').fill('6:30 AM');
  assert.equal(await day(0, TUE).locator('.tc-hm').textContent(), '8:00');
  assert.match(await day(0, TUE).locator('.tc-split').textContent(), /ends next day/);
  assert.equal(await text('#tc-total'), '16:30');
  // Pairs out of order cover more than 24 hours.
  await f(0, WED, 'in1').fill('9 AM'); await f(0, WED, 'out1').fill('12 PM');
  await f(0, WED, 'in2').fill('11 AM'); await f(0, WED, 'out2').fill('1 PM');
  await f(0, WED, 'out2').press('Tab');
  assert.match(await day(0, WED).locator('.tc-err').textContent(), /more than 24 hours/);
  assert.equal(await text('#tc-total'), '16:30');
  await f(0, WED, 'in2').fill('');
  await f(0, WED, 'out2').fill('');
  // Errors: a bad time and a break longer than the shift.
  await f(0, WED, 'out1').fill('13 pm');
  await f(0, WED, 'out1').press('Tab');
  assert.match(await day(0, WED).locator('.tc-err').textContent(), /isn’t a time/);
  assert.equal(await f(0, WED, 'out1').getAttribute('aria-invalid'), 'true');
  await f(0, WED, 'out1').fill('10 AM');
  await f(0, WED, 'brk').fill('90');
  await f(0, WED, 'brk').press('Tab');
  assert.match(await day(0, WED).locator('.tc-err').textContent(), /90-minute break is longer than the 1:00/);
  await f(0, WED, 'brk').fill('');
  assert.equal(await day(0, WED).locator('.tc-err').textContent(), '');
  assert.equal(await text('#tc-total'), '17:30');
  // A half-filled day is flagged only after focus leaves it.
  await f(0, THU, 'in1').fill('9');
  await f(0, THU, 'in1').press('Tab');
  await page.waitForTimeout(1000);
  assert.equal(await day(0, THU).locator('.tc-err').textContent(), '');
  await page.click('#tc-copy');
  assert.equal(await day(0, THU).locator('.tc-err').textContent(), 'Enter the out time.');
  await page.waitForFunction(() => document.querySelector('#tc-copy').textContent === 'Copied!');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, [
    'Monday Sep 21: 8:30', 'Tuesday Sep 22: 8:00', 'Wednesday Sep 23: 1:00',
    'Total: 17:30 (17.50 h)', 'Regular 17.50 h, overtime 0.00 h', 'Gross pay: 350.00',
  ].join('\n'));

  // 24-hour format re-tidies the grid.
  await page.selectOption('#tc-format', '24');
  assert.equal(await f(0, TUE, 'in1').inputValue(), '22:00');
  assert.equal(await f(0, MON, 'out2').inputValue(), '17:00');

  // Print: only the time card, with a header and signature lines.
  await page.fill('#tc-name', 'Alex Kim');
  await page.click('#tc-print');
  assert.equal(await page.evaluate(() => window.__printed), 1);
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.site-header').isVisible(), false);
  assert.equal(await page.locator('.prose').isVisible(), false);
  assert.equal(await page.locator('#tc-preset').isVisible(), false);
  assert.equal(await page.locator('.tc-print-head').isVisible(), true);
  assert.equal(await text('#tc-print-name'), 'Employee: Alex Kim');
  assert.equal(await text('#tc-print-period'), 'Period: Mon, Sep 21, 2026 to Sun, Sep 27, 2026');
  assert.equal(await page.locator('.tc-sign').isVisible(), true);
  assert.equal(await page.locator('#tc-paytable').isVisible(), true);
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await page.locator('.tc-print-head').isVisible(), false);

  // Three pairs still fit "12:30 PM" in every box at desktop width; narrower
  // grids switch to stacked day cards instead of clipping the times.
  await page.selectOption('#tc-pairs', '3');
  await f(0, SAT, 'in3').fill('12:30 PM');
  const clipped = () => page.$$eval('.tc-day input[type="text"]', els => els.filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).length);
  await page.selectOption('#tc-format', '12');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#tc-grid.tc-stack').count(), 0);
  assert.equal(await clipped(), 0);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForFunction(() => document.querySelector('#tc-grid').classList.contains('tc-stack'));
  assert.equal(await clipped(), 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !document.querySelector('#tc-grid').classList.contains('tc-stack'));
  await f(0, SAT, 'in3').fill('');
  await page.selectOption('#tc-pairs', '2');

  // No overtime preset: all hours regular; bad rate is a friendly error.
  await page.selectOption('#tc-preset', 'none');
  assert.equal(await text('#tc-ot'), '0:00');
  await page.fill('#tc-rate', 'twenty');
  await page.locator('#tc-rate').press('Tab');
  assert.match(await text('#tc-settings-msg'), /hourly rate/);
  assert.equal(await text('#tc-pay'), '–');

  // The status region gets one short summary after typing pauses.
  await page.fill('#tc-rate', '20');
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    window.__tcChanges = 0;
    new MutationObserver(() => window.__tcChanges++).observe(document.querySelector('#tc-status'), { childList: true, characterData: true, subtree: true });
  });
  await f(0, THU, 'out1').pressSequentially('17:00', { delay: 30 });
  await page.waitForFunction(() => document.querySelector('#tc-status').textContent === 'Total 25 hours 30 minutes: 25.50 regular, 0.00 overtime hours. Pay 510.00.', null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__tcChanges), 1);
};
