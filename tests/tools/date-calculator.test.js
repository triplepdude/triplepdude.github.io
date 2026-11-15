// Expected values come from tests/fixtures/date-calculator/expected.json, written by
// expected.py next to it: Python's datetime, dateutil (relativedelta, easter) and
// numpy's business-day functions. Nothing is read back from the page. Other values are
// from the sources named in the comments (Microsoft's function reference, the US Office
// of Personnel Management's holiday lists).
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const text = sel => page.locator(sel).textContent();
  // The message a field points at, and whether the field is marked invalid.
  const link = sel => page.$eval(sel, el => [el.getAttribute('aria-describedby'), el.getAttribute('aria-invalid')]);
  const hash = () => page.evaluate(() => decodeURIComponent(location.hash));
  const hashIs = want => page.waitForFunction(w => decodeURIComponent(location.hash) === w, want);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const pressed = () => page.$$eval('[data-preset][aria-pressed="true"]', els => els.map(e => e.dataset.preset).join());
  const readB = () => page.evaluate(() => {
    const t = id => document.getElementById('dc-b-' + id).textContent;
    return { big: t('big'), line: t('line'), ymd: t('ymd'), weeks: t('weeks'), work: t('work'), offDays: t('off'), offLabel: t('off-label'), hours: t('hours'), minutes: t('minutes'), seconds: t('seconds') };
  });
  const readA = () => page.evaluate(() => {
    const t = id => document.getElementById('dc-a-' + id).textContent;
    return { big: t('big'), line: t('line'), iso: t('iso'), days: t('days'), daysLabel: t('days-label'), today: t('today'), week: t('week'), note: t('note') };
  });
  const setWork = async (off, holidays) => {
    for (let n = 1; n <= 7; n++) await page.setChecked(`#dc-off-${n}`, off.includes(n));
    await page.fill('#dc-hol', holidays.join('\n'));
  };
  const setAmounts = async (y, m, w, d) => {
    await page.fill('#dc-y', String(y));
    await page.fill('#dc-m', String(m));
    await page.fill('#dc-w', String(w));
    await page.fill('#dc-d', String(d));
  };
  const fresh = async (hashPart = '') => {
    await page.goto('about:blank');
    await page.goto(url + hashPart, { waitUntil: 'load' });
  };

  const cdp = await page.context().newCDPSession(page);
  const zone = tz => cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz });
  await zone('UTC');
  // A fixed "now": Saturday 2026-11-14, 10:00 UTC.
  await page.clock.install({ time: new Date('2026-11-14T10:00:00Z') });
  await open();

  // ---- The page opens counting from today to New Year's Day ----
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to')], ['2026-11-14', '2027-01-01']);
  let b = await readB();
  assert.equal(b.big, '48 days until New Year\'s Day');
  assert.equal(b.line, 'From Saturday, November 14, 2026 to Friday, January 1, 2027, not counting the last day.');
  assert.deepEqual([b.ymd, b.weeks, b.work, b.offDays], ['1 month, 18 days', '6 weeks, 6 days', '34', '14']);
  assert.equal(await pressed(), 'new-year');
  assert.equal(await hash(), '');
  assert.equal(await text('#dc-work-sum'), '(Monday to Friday, no holidays listed)');
  // The working-day settings open from the keyboard.
  await page.focus('#dc-work summary');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#dc-hol').isVisible(), true);

  // ---- Days between two dates: known answers ----
  for (const c of data.between) {
    const label = `${c.from} to ${c.to}${c.incl ? ' with the end date' : ''}, off ${c.off.join('')}, ${c.holidays.length} holidays`;
    await setWork(c.off, c.holidays);
    await page.fill('#dc-from', c.from);
    await page.fill('#dc-to', c.to);
    await page.setChecked('#dc-incl', c.incl);
    b = await readB();
    for (const key of ['big', 'ymd', 'weeks', 'work', 'offDays', 'offLabel', 'hours', 'minutes', 'seconds']) assert.equal(b[key], c[key], `${key} for ${label}`);
    const line = c.from === c.to
      ? `The start and the end are the same day, ${c.lo}${c.incl ? ', which counts as one day.' : '.'}`
      : `From ${c.lo} to ${c.hi}${c.incl ? ', counting both the first and the last day.' : ', not counting the last day.'}${c.to < c.from ? ' The end date is before the start date, so the two are taken in order.' : ''}`;
    assert.equal(b.line, line, `sentence for ${label}`);
    assert.equal(await text('#dc-between-msg'), '');
  }
  // Microsoft's NETWORKDAYS example (1 October 2012 to 1 March 2013, both counted):
  // 110 working days, 109 with one holiday, 107 with three.
  assert.deepEqual(data.between.filter(c => c.from === '2012-10-01').map(c => c.work), ['110', '109', '107']);
  // The FAQ: a year has 260 to 262 weekdays, 2026 has 261.
  assert.deepEqual(data.between.filter(c => c.from.endsWith('-01-01') && c.to.endsWith('-12-31') && c.incl).map(c => c.work), ['261', '260']);
  await setWork([6, 7], []);
  await page.setChecked('#dc-incl', false);

  // ---- Errors and prompts ----
  await page.fill('#dc-from', '10000-01-01');
  assert.equal(await text('#dc-between-msg'), 'Enter a date from the year 1 to the year 9999.');
  assert.deepEqual([await link('#dc-from'), await link('#dc-to')], [['dc-between-msg', 'true'], ['dc-between-msg', null]]);
  b = await readB();
  assert.deepEqual([b.big, b.work, b.line], ['–', '–', '']);
  assert.equal(await page.locator('#dc-b-copy').isDisabled(), true);
  // An empty date is a prompt, not an error.
  await page.fill('#dc-from', '');
  assert.equal(await text('#dc-between-msg'), '');
  assert.deepEqual(await link('#dc-from'), ['dc-between-msg', null]);
  assert.equal(await text('#dc-b-line'), 'Choose a start date and an end date.');
  assert.equal(await text('#dc-b-big'), '–');
  await page.click('#dc-from-today');
  assert.equal(await page.inputValue('#dc-from'), '2026-11-14');
  assert.equal(await page.locator('#dc-b-copy').isDisabled(), false);

  // ---- "Days until" buttons ----
  const until = iso => Math.round((Date.parse(iso) - Date.parse('2026-11-14')) / 864e5);
  await page.click('[data-preset="christmas"]');
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to'), await pressed()], ['2026-11-14', '2026-12-25', 'christmas']);
  assert.equal(await text('#dc-b-big'), '41 days until Christmas Day');
  await hashIs('#to=christmas');
  await page.click('[data-preset="easter"]');
  assert.equal(await page.inputValue('#dc-to'), data.easter['2027']);
  assert.equal(await text('#dc-b-big'), `${until(data.easter['2027'])} days until Easter Sunday`);
  assert.equal(until(data.easter['2027']), 134);
  // The button gives the next one after the start date: Easter falls between 22 March and 25 April.
  for (const [from, year] of [['2038-01-01', '2038'], ['2285-01-01', '2285'], ['2011-04-25', '2012'], ['2028-04-16', '2028'], ['1961-01-01', '1961']]) {
    await page.fill('#dc-from', from);
    assert.equal(await page.inputValue('#dc-to'), data.easter[year], `Easter after ${from}`);
  }
  assert.equal(await pressed(), 'easter');
  // 2026-11-26 is Thanksgiving Day on the US government's holiday list.
  await page.click('[data-preset="thanksgiving"]');
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to')], ['2026-11-14', '2026-11-26']);
  assert.equal(await text('#dc-b-big'), '12 days until Thanksgiving in the US');
  // The fourth Thursday is not always the last one: November 2028 and 2029 have five.
  await page.fill('#dc-from', '2028-01-01');
  assert.equal(await page.inputValue('#dc-to'), '2028-11-23');
  await page.fill('#dc-from', '2028-11-24');
  assert.equal(await page.inputValue('#dc-to'), '2029-11-22');
  for (const [key, date, big] of [['halloween', '2027-10-31', '351 days until Halloween'], ['valentines-day', '2027-02-14', '92 days until Valentine\'s Day'], ['new-year', '2027-01-01', '48 days until New Year\'s Day']]) {
    await page.click(`[data-preset="${key}"]`);
    assert.deepEqual([await page.inputValue('#dc-to'), await text('#dc-b-big')], [date, big]);
  }
  // Counting the end date as well is no longer "days until".
  await page.click('[data-preset="christmas"]');
  await page.setChecked('#dc-incl', true);
  assert.equal(await text('#dc-b-big'), '42 days');
  await hashIs('#to=christmas&incl=1');
  await page.setChecked('#dc-incl', false);
  // Typing an end date lets go of the button.
  await page.fill('#dc-to', '2026-12-24');
  assert.equal(await pressed(), '');
  assert.equal(await text('#dc-b-big'), '40 days');
  await hashIs('#to=2026-12-24');

  // ---- Today buttons and Swap: "days since" ----
  await page.fill('#dc-from', '2001-09-11');
  await page.click('#dc-to-today');
  assert.equal(await page.inputValue('#dc-to'), '2026-11-14');
  assert.equal(await text('#dc-b-big'), '9,195 days');
  await hashIs('#from=2001-09-11&to=today');
  await page.click('#dc-swap');
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to')], ['2026-11-14', '2001-09-11']);
  assert.equal(await text('#dc-b-big'), '9,195 days');
  assert.match(await text('#dc-b-line'), /^From Tuesday, September 11, 2001 to Saturday, November 14, 2026, not counting the last day\. The end date is before the start date/);
  await hashIs('#to=2001-09-11');
  // Swapping lets go of a "days until" button: Christmas becomes the fixed start, today the end.
  await page.click('[data-preset="christmas"]');
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to'), await pressed()], ['2026-11-14', '2026-12-25', 'christmas']);
  await page.click('#dc-swap');
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to'), await pressed(), await text('#dc-b-big')], ['2026-12-25', '2026-11-14', '', '41 days']);
  await hashIs('#from=2026-12-25&to=today');

  // ---- Working days: the weekend and the holiday list ----
  const summary = async off => { await setWork(off, []); return text('#dc-work-sum'); };
  assert.equal(await summary([5, 6]), '(Sunday to Thursday, no holidays listed)');
  assert.equal(await summary([7]), '(Monday to Saturday, no holidays listed)');
  assert.equal(await summary([2, 4, 6, 7]), '(Mon, Wed, Fri, no holidays listed)');
  assert.equal(await summary([1, 2, 3, 4, 5, 7]), '(Saturday only, no holidays listed)');
  assert.equal(await summary([]), '(every day, no holidays listed)');
  assert.equal(await summary([1, 2, 3, 4, 5, 6, 7]), '(no working days, no holidays listed)');
  await page.fill('#dc-from', '2026-11-01');
  await page.fill('#dc-to', '2026-12-01');
  assert.deepEqual([await text('#dc-b-work'), await text('#dc-b-off-label')], ['0', 'Days off: 30 weekly, 0 holidays']);
  await setWork([6, 7], []);
  // Dates in several notations, with notes, a semicolon and full-width digits.
  await page.fill('#dc-hol', '25 Dec 2026 Christmas\nDec 28, 2026; 1/2/2027\nFriday, January 15th, 2027 - day off\n２０２７-０２-１５: moved');
  assert.equal(await text('#dc-hol-msg'), '');
  assert.equal(await text('#dc-work-sum'), '(Monday to Friday, 5 holidays listed)');
  // Thursday 24 to Tuesday 29 December 2026, both counted: Friday 25 and Monday 28 are
  // holidays, so only the Thursday and the Tuesday are working days.
  await page.fill('#dc-from', '2026-12-24');
  await page.fill('#dc-to', '2026-12-29');
  await page.setChecked('#dc-incl', true);
  assert.deepEqual([await text('#dc-b-big'), await text('#dc-b-work'), await text('#dc-b-off-label')], ['6 days', '2', 'Days off: 2 weekly, 2 holidays']);
  // A US browser reads 1/2/2027 as January 2 (a Saturday); 15 January and 15 February are counted.
  await page.fill('#dc-from', '2027-01-01');
  await page.fill('#dc-to', '2027-02-28');
  assert.equal(await text('#dc-b-off-label'), 'Days off: 18 weekly, 2 holidays');
  // A line that is not a date is reported; the good lines still count.
  await page.fill('#dc-hol', '2027-01-15\nnot a date\n2027-13-45\nFeb 15, 2027');
  assert.equal(await text('#dc-hol-msg'), 'Line 2 is not a date: “not a date”, and 1 more line cannot be read. Write one date per line with its year, such as 2026-12-25 or 25 Dec 2026.');
  assert.deepEqual(await link('#dc-hol'), ['dc-hol-hint dc-hol-msg dc-hol-long', 'true']);
  assert.equal(await text('#dc-b-off-label'), 'Days off: 18 weekly, 2 holidays');
  // 2100 is not a leap year, so it has no 29 February; 2096 has one.
  await page.fill('#dc-hol', '2096-02-29\n29 Feb 2100');
  assert.match(await text('#dc-hol-msg'), /^Line 2 is not a date: “29 Feb 2100”\. /);
  assert.equal(await text('#dc-work-sum'), '(Monday to Friday, 1 holiday listed)');
  await page.fill('#dc-hol', '25 December');
  assert.equal(await text('#dc-hol-msg'), 'Line 1 is not a date: “25 December”. Write one date per line with its year, such as 2026-12-25 or 25 Dec 2026.');
  await page.click('#dc-hol-clear');
  assert.equal(await page.inputValue('#dc-hol'), '');
  assert.equal(await text('#dc-hol-msg'), '');
  assert.deepEqual(await link('#dc-hol'), ['dc-hol-hint dc-hol-msg dc-hol-long', null]);

  // US federal holidays as the Office of Personnel Management lists them for 2026 to 2028.
  // A holiday on a Saturday is taken on the Friday before (3 July 2026, 18 June and
  // 24 December 2027, 31 December 2027 for New Year's Day 2028, 10 November 2028), one
  // on a Sunday on the Monday after (5 July 2027).
  const opm = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24',
    '2027-12-31', '2028-01-17', '2028-02-21', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-10-09', '2028-11-10', '2028-11-23', '2028-12-25'];
  await page.fill('#dc-from', '2026-01-01');
  await page.fill('#dc-to', '2028-12-31');
  await page.click('#dc-us');
  const lines = (await page.inputValue('#dc-hol')).split('\n');
  assert.deepEqual(lines.map(l => l.slice(0, 10)).sort(), opm);
  assert.ok(lines.includes('2026-11-26 Thanksgiving Day') && lines.includes('2026-07-03 Independence Day (observed)') && lines.includes('2027-12-31 New Year\'s Day (observed)'), lines.join(' | '));
  assert.equal(await text('#dc-hol-note'), 'Added 33 US federal holidays for 2026 to 2028, as observed by federal offices.');
  assert.equal(await text('#dc-hol-msg'), '');
  // The FAQ: 2026 has 261 weekdays and 250 working days after the eleven federal holidays.
  await page.fill('#dc-to', '2026-12-31');
  assert.deepEqual([await text('#dc-b-big'), await text('#dc-b-work'), await text('#dc-b-off-label')], ['365 days', '250', 'Days off: 104 weekly, 11 holidays']);
  await page.click('#dc-us');
  assert.equal(await text('#dc-hol-note'), 'The US federal holidays for 2026 are already on the list.');
  assert.equal((await page.inputValue('#dc-hol')).split('\n').length, 33);
  await page.fill('#dc-from', '2019-01-01');
  await page.fill('#dc-to', '2020-12-31');
  await page.click('#dc-us');
  assert.match(await text('#dc-hol-note'), /^This button covers 2021 onwards/);
  await page.click('#dc-hol-clear');
  await page.setChecked('#dc-incl', false);
  // New Year's Day 2028 is a Saturday and is taken on Friday 31 December 2027, so 2027
  // has twelve federal holidays and 2028 ten. The same happened with 2021 and 2022.
  for (const [year, count, has] of [[2027, 12, '2027-12-31 New Year\'s Day (observed)'], [2028, 10, '2028-01-17 Birthday of Martin Luther King, Jr.'],
    [2021, 12, '2021-12-31 New Year\'s Day (observed)'], [2022, 10, '2022-12-26 Christmas Day (observed)']]) {
    await page.click('#dc-hol-clear');
    await page.fill('#dc-from', `${year}-01-01`);
    await page.fill('#dc-to', `${year}-12-31`);
    await page.click('#dc-us');
    const got = (await page.inputValue('#dc-hol')).split('\n');
    assert.equal(await text('#dc-hol-note'), `Added ${count} US federal holidays for ${year}, as observed by federal offices.`);
    assert.ok(got.length === count && got.includes(has) && got.every(l => l.startsWith(`${year}-`)), got.join(' | '));
  }
  // A list of more than 1,500 characters would make the address too long to pass on:
  // it is left out, and the page says so (on screen, to the field and in the announcement).
  const tooLong = 'This list is too long for the page address (over 1,500 characters). A reload or a link to this page will not bring it back, so keep a copy.';
  assert.equal(await text('#dc-hol-long'), '');
  await hashIs('#from=2022-01-01&to=2022-12-31&hol=' + (await page.inputValue('#dc-hol')));
  await page.fill('#dc-to', '2026-12-31');
  await page.click('#dc-us');
  assert.ok((await page.inputValue('#dc-hol')).length > 1500);
  assert.equal(await text('#dc-hol-note'), 'Added 44 US federal holidays for 2022 to 2026, as observed by federal offices.');
  assert.equal(await text('#dc-hol-long'), tooLong);
  await page.waitForFunction(t => document.querySelector('#dc-status').textContent === t, 'Added 44 US federal holidays for 2022 to 2026, as observed by federal offices. ' + tooLong);
  await hashIs('#from=2022-01-01&to=2026-12-31');
  assert.equal(await text('#dc-b-off-label'), 'Days off: 522 weekly, 54 holidays'); // the holidays still count
  await page.fill('#dc-hol', '2026-12-25 Christmas Day');
  assert.equal(await text('#dc-hol-long'), '');
  await hashIs('#from=2022-01-01&to=2026-12-31&hol=2026-12-25 Christmas Day');
  await page.click('#dc-hol-clear');

  // ---- Copy the result ----
  await page.click('[data-preset="new-year"]');
  await page.click('#dc-b-copy');
  assert.equal(await clipboard(), '48 days until New Year\'s Day. From Saturday, November 14, 2026 to Friday, January 1, 2027, not counting the last day. That is 1 month, 18 days, or 6 weeks, 6 days, with 34 working days.');
  assert.equal(await text('#dc-b-copy'), 'Copied!');

  // ---- Tabs work from the keyboard ----
  const tabsState = () => page.evaluate(() => ['between', 'add'].map(n => {
    const t = document.getElementById('dc-tab-' + n);
    return [t.getAttribute('aria-selected'), t.tabIndex, !document.getElementById('dc-' + n).hidden].join();
  }).join(' | '));
  assert.equal(await tabsState(), 'true,0,true | false,-1,false');
  await page.focus('#dc-tab-between');
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabsState(), 'false,-1,false | true,0,true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dc-tab-add');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
  assert.equal(await page.locator('#dc-start').isVisible(), true);
  assert.equal(await page.locator('#dc-from').isVisible(), false);
  await hashIs('#tab=add');
  await page.keyboard.press('Home');
  assert.equal(await tabsState(), 'true,0,true | false,-1,false');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dc-tab-add');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dc-tab-between');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await tabsState(), 'false,-1,false | true,0,true');
  // The working-day settings follow the open tab.
  assert.equal(await page.locator('#dc-add #dc-work').count(), 1);
  // From the tab, Tab reaches the start date and then the amounts; a box is selected ready to type over.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dc-start');

  // ---- Add or subtract: it opens with 90 days from today ----
  let a = await readA();
  assert.deepEqual([await page.inputValue('#dc-start'), await page.inputValue('#dc-d')], ['2026-11-14', '90']);
  assert.equal(a.big, 'Friday, February 12, 2027');
  assert.equal(a.line, '90 days after Saturday, November 14, 2026.');
  await page.focus('#dc-d');
  await page.keyboard.type('45');
  assert.equal(await page.inputValue('#dc-d'), '45');
  assert.equal(await text('#dc-a-big'), 'Tuesday, December 29, 2026'); // the guide's example
  await hashIs('#tab=add&d=45');

  for (const c of data.add) {
    const label = `${c.start} ${c.op} ${c.y}y ${c.m}m ${c.w}w ${c.d}d${c.biz ? ' working' : ''}, off ${c.off.join('')}, ${c.holidays.length} holidays`;
    await setWork(c.off, c.holidays);
    await page.fill('#dc-start', c.start);
    await page.selectOption('#dc-op', c.op);
    await setAmounts(c.y, c.m, c.w, c.d);
    await page.setChecked('#dc-biz', c.biz);
    a = await readA();
    for (const key of ['big', 'iso', 'days', 'daysLabel', 'today', 'week']) assert.equal(a[key], c[key], `${key} for ${label}`);
    assert.equal(await text('#dc-add-msg'), '');
  }
  // Microsoft's WORKDAY example: 151 working days from 1 October 2008 is 30 April 2009,
  // or 5 May 2009 with three holidays.
  assert.deepEqual(data.add.filter(c => c.start === '2008-10-01').map(c => c.iso), ['2009-04-30', '2009-05-05']);
  // The FAQ's example: 90 days and three months from 14 November 2026.
  assert.deepEqual([data.add[0].iso, data.add[2].iso], ['2027-02-12', '2027-02-14']);
  await setWork([6, 7], []);

  // The sentence under the result, and the notes.
  const say = async (start, op, y, m, w, d, biz) => {
    await page.fill('#dc-start', start);
    await page.selectOption('#dc-op', op);
    await setAmounts(y, m, w, d);
    await page.setChecked('#dc-biz', biz);
    return readA();
  };
  a = await say('2026-11-14', 'sub', 1, 2, 3, 4, false);
  assert.deepEqual([a.line, a.note], ['1 year, 2 months, 3 weeks and 4 days before Saturday, November 14, 2026.', '']);
  a = await say('2024-01-31', 'add', 0, 1, 0, 0, false);
  assert.deepEqual([a.line, a.note], ['1 month after Wednesday, January 31, 2024.', 'There is no February 31, 2024, so the years and months stop at the last day of that month, February 29, 2024.']);
  a = await say('2024-02-29', 'add', 1, 0, 0, 3, false);
  assert.deepEqual([a.iso, a.note], ['2025-03-03', 'There is no February 29, 2025, so the years and months stop at the last day of that month, February 28, 2025.']);
  a = await say('2026-11-13', 'add', 0, 0, 0, 10, true);
  assert.deepEqual([a.line, a.note], ['10 working days after Friday, November 13, 2026.', 'Working days: Monday to Friday, no holidays listed.']);
  a = await say('2026-11-14', 'add', 1, 0, 0, '-3', false);
  assert.deepEqual([a.line, a.iso], ['Saturday, November 14, 2026 plus 1 year, minus 3 days.', '2027-11-11']);
  a = await say('2026-11-14', 'add', 0, 0, 0, 0, false);
  assert.deepEqual([a.line, a.days, a.daysLabel, a.today, a.big], ['Nothing is added, so the result is the start date.', 'The same day', 'From the start date', 'Today', 'Saturday, November 14, 2026']);
  // Empty boxes count as 0; a thousands separator, a typographic minus and full-width digits are read.
  a = await say('2026-11-14', 'add', '', '', '', '1,000', false);
  assert.deepEqual([a.iso, a.days], ['2029-08-10', '1,000 days later']);
  a = await say('2026-11-14', 'add', '', '', '', '−5', false);
  assert.deepEqual([a.iso, a.days], ['2026-11-09', '5 days earlier']);
  a = await say('2026-11-14', 'sub', '', '', '', '４５', false);
  assert.equal(a.days, '45 days earlier');
  // Quick picks set the days and clear the rest.
  await say('2026-11-14', 'add', 3, 2, 1, 7, false);
  await page.click('[data-days="45"]');
  assert.deepEqual(await page.$$eval('.dc-amounts input', els => els.map(e => e.value)), ['0', '0', '0', '45']);
  assert.equal(await text('#dc-a-iso'), '2026-12-29');

  // ---- Errors on the second tab ----
  const amountFlags = () => page.$$eval('.dc-amounts input', els => els.map(e => e.getAttribute('aria-invalid') === 'true' ? e.id.slice(-1) : '').join(''));
  await page.fill('#dc-d', '1.5');
  assert.equal(await text('#dc-add-msg'), 'Enter whole numbers only, such as 45 or -3, with up to 9 digits.');
  assert.deepEqual([await link('#dc-d'), await link('#dc-y')], [['dc-add-msg', 'true'], ['dc-add-msg', null]]);
  a = await readA();
  assert.deepEqual([a.big, a.iso, a.line], ['–', '–', '']);
  assert.equal(await page.locator('#dc-a-copy').isDisabled(), true);
  await page.fill('#dc-y', 'two');
  assert.equal(await amountFlags(), 'yd');
  await page.fill('#dc-y', '0');
  await page.fill('#dc-d', '1234567890');
  assert.equal(await amountFlags(), 'd');
  await page.fill('#dc-d', '45');
  assert.deepEqual([await amountFlags(), await text('#dc-add-msg'), await text('#dc-a-iso')], ['', '', '2026-12-29']);
  // A result outside the years 1 to 9999, however large the numbers.
  await page.fill('#dc-y', '8000');
  assert.equal(await text('#dc-add-msg'), 'The result is outside the years 1 to 9999. Enter smaller numbers.');
  assert.equal(await amountFlags(), 'yd');
  assert.equal(await text('#dc-a-big'), '–');
  await page.fill('#dc-y', '0');
  for (const biz of [false, true]) {
    await page.setChecked('#dc-biz', biz);
    await page.fill('#dc-d', '999999999');
    assert.equal(await text('#dc-add-msg'), 'The result is outside the years 1 to 9999. Enter smaller numbers.');
    assert.equal(await amountFlags(), 'd');
    await page.selectOption('#dc-op', biz ? 'add' : 'sub');
  }
  // No working day left to count.
  await page.fill('#dc-d', '5');
  await setWork([1, 2, 3, 4, 5, 6, 7], []);
  assert.match(await text('#dc-add-msg'), /^Every day of the week is marked as a day off/);
  assert.deepEqual(await link('#dc-biz'), ['dc-add-msg', 'true']);
  assert.equal(await text('#dc-a-big'), '–');
  await setWork([6, 7], []);
  assert.deepEqual([await link('#dc-biz'), await text('#dc-add-msg'), await text('#dc-a-iso')], [['dc-add-msg', null], '', '2026-11-20']);
  await page.setChecked('#dc-biz', false);
  await page.fill('#dc-start', '10000-01-01');
  assert.equal(await text('#dc-add-msg'), 'Enter a date from the year 1 to the year 9999.');
  assert.deepEqual(await link('#dc-start'), ['dc-add-msg', 'true']);
  await page.fill('#dc-start', '');
  assert.deepEqual([await text('#dc-add-msg'), await text('#dc-a-line'), await link('#dc-start')], ['', 'Choose a start date.', ['dc-add-msg', null]]);
  await page.click('#dc-start-today');
  await page.click('[data-days="90"]');
  await page.click('#dc-a-copy');
  assert.equal(await clipboard(), 'Friday, February 12, 2027 (2027-02-12). 90 days after Saturday, November 14, 2026.');

  // ---- Screen readers: results are not live; one summary once typing pauses ----
  for (const sel of ['#dc-a-big', '#dc-a-iso', '#dc-b-big', '#dc-b-work', '#dc-add-msg', '#dc-between-msg', '#dc-hol-msg', '#dc-hol-note']) {
    assert.equal(await page.locator(sel).evaluate(el => !!el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]')), false, `${sel} is not live`);
  }
  await page.waitForFunction(() => document.querySelector('#dc-status').textContent.startsWith('Friday, February 12, 2027.'));
  await page.evaluate(() => {
    window.__said = [];
    new MutationObserver(ms => ms.forEach(m => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const region = el && el.closest('#dc-status');
      if (region && region.textContent.trim()) window.__said.push(region.textContent.trim());
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.fill('#dc-d', '');
  await page.locator('#dc-d').pressSequentially('120', { delay: 80 });
  const spoken = 'Sunday, March 14, 2027. 120 days after Saturday, November 14, 2026.';
  await page.waitForFunction(t => document.querySelector('#dc-status').textContent === t, spoken);
  assert.deepEqual(await page.evaluate(() => window.__said.splice(0)), [spoken]);
  await page.fill('#dc-d', 'x');
  await page.waitForFunction(() => document.querySelector('#dc-status').textContent === 'Enter whole numbers only, such as 45 or -3, with up to 9 digits.');
  await page.fill('#dc-d', '90');
  await page.click('#dc-tab-between');
  await page.waitForFunction(() => document.querySelector('#dc-status').textContent.startsWith('48 days until New Year\'s Day, 34 working days.'));
  // A holiday line that cannot be read is announced while the list is edited; other changes announce the result.
  await page.fill('#dc-hol', 'soon');
  await page.waitForFunction(() => document.querySelector('#dc-status').textContent.startsWith('Line 1 is not a date: “soon”.'));
  await page.setChecked('#dc-incl', true);
  await page.waitForFunction(() => document.querySelector('#dc-status').textContent.startsWith('49 days, 35 working days.'));
  await page.setChecked('#dc-incl', false);
  await page.fill('#dc-hol', '');

  // ---- The address carries the calculation, and opening it restores everything ----
  await page.click('#dc-tab-add');
  await page.fill('#dc-start', '2024-01-31');
  await page.selectOption('#dc-op', 'sub');
  await setAmounts(1, 0, 2, '-3');
  await page.setChecked('#dc-biz', true);
  await setWork([5, 6], []);
  await page.fill('#dc-hol', '2024-01-01 New Year\n25 Dec 2023');
  await page.click('#dc-tab-between');
  await page.fill('#dc-from', '2026-12-01');
  await page.click('[data-preset="christmas"]'); // back to today, until Christmas
  await page.fill('#dc-from', '2026-12-01');
  await page.setChecked('#dc-incl', true);
  const state = '#from=2026-12-01&to=christmas&incl=1&start=2024-01-31&op=sub&y=1&w=2&d=-3&biz=1&off=56&hol=2024-01-01 New Year\n25 Dec 2023';
  await hashIs(state);
  const snapshot = () => page.evaluate(() => [...document.querySelectorAll('.dc input, .dc select, .dc textarea')].map(e => e.id + '=' + (e.type === 'checkbox' ? e.checked : e.value)).join('&') +
    ' | ' + document.querySelector('.dc-tab[aria-selected="true"]').id + ' | ' + document.getElementById('dc-b-big').textContent + ' | ' + document.getElementById('dc-a-iso').textContent);
  const before = await snapshot();
  assert.match(before, /dc-from=2026-12-01&dc-to=2026-12-25&.*dc-y=1&dc-m=0&dc-w=2&dc-d=-3.*dc-tab-between \| 25 days \| /s);
  await fresh(await page.evaluate(() => location.hash));
  assert.equal(await snapshot(), before);
  await page.click('#dc-tab-add');
  await hashIs('#tab=add' + state.replace('#', '&'));
  // 31 January 2024 minus a year is 31 January 2023, minus 2 weeks is 17 January, plus 3
  // working days (Sunday to Thursday week) is Sunday 22 January 2023.
  assert.equal(await text('#dc-a-iso'), '2023-01-22');
  // Links people write by hand.
  await fresh('#until=2026-12-25');
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to'), await text('#dc-b-big'), await pressed()], ['2026-11-14', '2026-12-25', '41 days', '']);
  await fresh('#until=christmas');
  assert.deepEqual([await text('#dc-b-big'), await pressed()], ['41 days until Christmas Day', 'christmas']);
  await fresh('#from=2001-09-11&to=today');
  assert.deepEqual([await page.inputValue('#dc-to'), await text('#dc-b-big')], ['2026-11-14', '9,195 days']);
  await fresh('#tab=add&start=2024-01-31&m=1');
  assert.deepEqual([await text('#dc-a-iso'), await page.inputValue('#dc-d'), await page.locator('#dc-add').isVisible()], ['2024-02-29', '0', true]);
  await fresh('#d=45');
  assert.deepEqual([await text('#dc-a-iso'), await page.locator('#dc-add').isVisible()], ['2026-12-29', true]);
  // A date that does not exist leaves the field empty; an anchor of the guide changes nothing.
  await fresh('#to=2026-02-30');
  assert.deepEqual([await page.inputValue('#dc-to'), await text('#dc-b-line')], ['', 'Choose a start date and an end date.']);
  await fresh('#is-the-end-date-included');
  assert.deepEqual([await text('#dc-b-big'), await hash()], ['48 days until New Year\'s Day', '#is-the-end-date-included']);
  // A link in the guide sets the calculator and brings it into view. It changes only
  // the end date: the holidays and the other tab keep what was typed.
  await page.click('#dc-work summary');
  await page.fill('#dc-hol', '2026\u201112\u201124 Christmas Eve'); // typed with non-breaking hyphens
  assert.equal(await text('#dc-hol-msg'), '');
  await page.click('#dc-tab-add');
  await setAmounts(0, 6, 0, 0);
  await page.click('.prose a[href="#to=christmas"]');
  await page.waitForFunction(() => document.querySelector('#dc-b-big').textContent === '41 days until Christmas Day');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dc-tab-between');
  await page.waitForFunction(() => { const r = document.querySelector('.dc').getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight / 2; });
  assert.deepEqual([await page.inputValue('#dc-hol'), await page.inputValue('#dc-m'), await text('#dc-b-off-label')], ['2026\u201112\u201124 Christmas Eve', '6', 'Days off: 12 weekly, 1 holiday']);
  await hashIs('#to=christmas&m=6&hol=2026\u201112\u201124 Christmas Eve');
  await page.click('.prose a[href="#to=easter"]');
  await page.waitForFunction(() => document.querySelector('#dc-b-big').textContent === '134 days until Easter Sunday');
  await page.click('#dc-hol-clear');

  // ---- The FAQ's Christmas numbers; "today" is the visitor's local date ----
  await page.clock.setSystemTime(new Date('2026-12-01T12:00:00Z'));
  await fresh('#to=christmas');
  assert.equal(await text('#dc-b-big'), '24 days until Christmas Day');
  await page.clock.setSystemTime(new Date('2026-12-25T12:00:00Z'));
  await fresh('#to=christmas');
  assert.equal(await text('#dc-b-big'), 'Today is Christmas Day');
  await page.clock.setSystemTime(new Date('2026-12-26T12:00:00Z'));
  await fresh('#to=christmas');
  assert.deepEqual([await page.inputValue('#dc-to'), await text('#dc-b-big')], ['2027-12-25', '364 days until Christmas Day']);
  await page.clock.setSystemTime(new Date('2027-12-26T12:00:00Z')); // 29 February 2028 is in between
  await fresh('#to=christmas');
  assert.equal(await text('#dc-b-big'), '365 days until Christmas Day');
  // 2026-12-31T12:00Z is already 1 January, 01:00, in Auckland and still 31 December in Honolulu.
  await page.clock.setSystemTime(new Date('2026-12-31T12:00:00Z'));
  await zone('Pacific/Auckland');
  await fresh();
  assert.deepEqual([await page.inputValue('#dc-from'), await text('#dc-b-big')], ['2027-01-01', 'Today is New Year\'s Day']);
  await zone('Pacific/Honolulu');
  await fresh();
  assert.deepEqual([await page.inputValue('#dc-from'), await text('#dc-b-big')], ['2026-12-31', '1 day until New Year\'s Day']);
  // The page rolls over at local midnight without a reload; a typed date stays put.
  await zone('UTC');
  await page.clock.setSystemTime(new Date('2026-11-14T23:59:30Z'));
  await fresh();
  await page.click('#dc-tab-add');
  await page.fill('#dc-start', '2026-11-14');
  await page.click('#dc-tab-between');
  assert.equal(await text('#dc-b-big'), '48 days until New Year\'s Day');
  await page.clock.runFor(60000);
  assert.deepEqual([await page.inputValue('#dc-from'), await text('#dc-b-big'), await page.inputValue('#dc-start')], ['2026-11-15', '47 days until New Year\'s Day', '2026-11-14']);
  await page.clock.setSystemTime(new Date('2026-11-14T10:00:00Z'));

  // ---- Back from another page on a later day: the browser may put the old values back
  // into the fields after the page has loaded; the fields and the result still agree ----
  await fresh('#to=christmas');
  assert.equal(await page.inputValue('#dc-from'), '2026-11-14');
  await page.goto(`${base}/about/`, { waitUntil: 'load' });
  await page.clock.setSystemTime(new Date('2026-11-16T10:00:00Z'));
  await page.goBack({ waitUntil: 'load' });
  assert.deepEqual([await page.inputValue('#dc-from'), await page.inputValue('#dc-to'), await text('#dc-b-big'), await text('#dc-b-line')],
    ['2026-11-16', '2026-12-25', '39 days until Christmas Day', 'From Monday, November 16, 2026 to Friday, December 25, 2026, not counting the last day.']);
  await page.click('#dc-tab-add');
  assert.deepEqual([await page.inputValue('#dc-start'), await text('#dc-a-line')], ['2026-11-16', '90 days after Monday, November 16, 2026.']);
  await page.clock.setSystemTime(new Date('2026-11-14T10:00:00Z'));

  // ---- A browser without a date field shows a text box: a typed date is read, and the
  // address carries it in the form that opens again ----
  await fresh();
  await page.$$eval('#dc-from, #dc-to, #dc-start', els => els.forEach(el => { el.type = 'text'; }));
  await page.fill('#dc-to', '25 Dec 2026');
  assert.equal(await text('#dc-b-big'), '41 days');
  await hashIs('#to=2026-12-25');
  await page.fill('#dc-from', 'Nov 1, 2026');
  await page.fill('#dc-to', '12/24/2026');
  assert.equal(await text('#dc-b-big'), '53 days');
  await hashIs('#from=2026-11-01&to=2026-12-24');
  await page.fill('#dc-to', 'next week');
  assert.equal(await text('#dc-between-msg'), 'Write the date like 2026-12-25 or 25 Dec 2026, with a year from 1 to 9999.');
  assert.deepEqual([await link('#dc-to'), await text('#dc-b-big')], [['dc-between-msg', 'true'], '–']);
  await page.click('#dc-tab-add');
  await page.fill('#dc-start', '1 March 2027');
  assert.equal(await text('#dc-a-iso'), '2027-05-30');
  await hashIs('#tab=add&from=2026-11-01&to=next week&start=2027-03-01');
  await page.fill('#dc-start', 'tomorrow');
  assert.equal(await text('#dc-add-msg'), 'Write the date like 2026-12-25 or 25 Dec 2026, with a year from 1 to 9999.');
  await fresh();

  // ---- The FAQ covers privacy ----
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(/stored or sent/i.test(faqs[faqs.length - 1]), faqs.join(' | '));

  // ---- A British browser: dates written day month year, 1/2/2027 is 1 February ----
  const browser = page.context().browser();
  const gb = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1280, height: 900 } });
  const g = await gb.newPage();
  await g.clock.install({ time: new Date('2026-11-14T10:00:00Z') });
  await g.goto(url + '#from=2027-01-29&to=2027-02-03&hol=1/2/2027', { waitUntil: 'load' });
  assert.equal(await g.locator('#dc-b-line').textContent(), 'From Friday, 29 January 2027 to Wednesday, 3 February 2027, not counting the last day.');
  assert.equal(await g.locator('#dc-b-off-label').textContent(), 'Days off: 2 weekly, 1 holiday'); // Monday 1 February
  await g.goto('about:blank');
  await g.goto(url + '#tab=add&start=2023-01-31&m=1', { waitUntil: 'load' });
  assert.equal(await g.locator('#dc-a-note').textContent(), 'There is no 31 February 2023, so the years and months stop at the last day of that month, 28 February 2023.');
  await gb.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'UTC' });
  const p = await phone.newPage();
  await p.clock.install({ time: new Date('2026-11-14T10:00:00Z') });
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('[data-preset="christmas"]');
  assert.equal(await p.locator('#dc-b-big').textContent(), '41 days until Christmas Day');
  await p.tap('#dc-incl');
  assert.equal(await p.locator('#dc-b-big').textContent(), '42 days');
  await p.tap('#dc-tab-add');
  await p.tap('[data-days="30"]');
  assert.equal(await p.locator('#dc-a-big').textContent(), 'Monday, December 14, 2026');
  await p.tap('#dc-d');
  await p.waitForFunction(() => document.activeElement.id === 'dc-d' && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 2);
  await p.keyboard.type('7');
  assert.equal(await p.locator('#dc-a-iso').textContent(), '2026-11-21');
  await p.tap('#dc-work summary');
  await p.tap('#dc-us');
  assert.equal(await p.locator('#dc-hol-note').textContent(), 'Added 11 US federal holidays for 2026, as observed by federal offices.');
  // Controls are at least 44 px tall and text boxes use 16 px type (no zoom on iOS).
  for (const tab of ['add', 'between']) {
    await p.tap('#dc-tab-' + tab);
    const sizes = await p.$$eval('.dc button, .dc input:not([type="checkbox"]), .dc select, .dc textarea, .dc summary, .dc .check', els => els.filter(e => e.offsetParent).map(e => ({
      id: e.id || e.textContent.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), field: e.matches('input, select, textarea'),
    })));
    assert.ok(sizes.length >= 18, `found ${sizes.length} controls on the ${tab} tab`);
    for (const s of sizes) {
      assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
      if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px type`);
    }
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll on the phone, ${tab} tab`);
  }
  await phone.close();
};
