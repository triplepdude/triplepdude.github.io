// Expected ages come from tests/fixtures/age-calculator/expected.json, written by
// expected.py next to it: Python's datetime, dateutil.relativedelta and zoneinfo, plus
// a day-by-day walk through the calendar. Nothing is read back from the page. Other
// values are from the sources named in the comments.
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const text = sel => page.locator(sel).textContent();
  // The message a field points at, and whether the field is marked invalid.
  const link = sel => page.$eval(sel, el => [el.getAttribute('aria-describedby'), el.getAttribute('aria-invalid')]);
  const invalid = id => page.$$eval(`#${id} input`, els => els.filter(e => e.getAttribute('aria-invalid') === 'true').map(e => e.id.slice(-1)).sort().join(''));
  // A year is typed with four digits (0987); a shorter one is asked for in full.
  const year4 = y => typeof y === 'number' ? String(y).padStart(4, '0') : String(y);
  const setDate = async (id, [d, m, y]) => {
    await page.fill(`#${id}-d`, String(d));
    await page.fill(`#${id}-m`, String(m));
    await page.fill(`#${id}-y`, year4(y));
  };
  const getDate = id => page.evaluate(i => ['d', 'm', 'y'].map(p => document.getElementById(`${i}-${p}`).value).join('/'), id);
  const read = () => page.evaluate(() => {
    const t = id => document.getElementById('ac-' + id).textContent;
    return {
      head: t('head'), age: t('age'), born: t('born'), months: t('months'), monthsRest: t('months-rest'), weeks: t('weeks'), weeksRest: t('weeks-rest'),
      days: t('days'), hours: t('hours'), minutes: t('minutes'), seconds: t('seconds'), next: t('next'), weekday: t('weekday'), mark: t('mark'),
      test: t('test'), korean: t('korean'), exact: t('exact'), note: t('note'),
    };
  });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  const cdp = await page.context().newCDPSession(page);
  const zone = tz => cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz });
  await zone('UTC');
  // A fixed "now": Saturday 2026-11-14, 10:00 UTC.
  await page.clock.install({ time: new Date(data.now) });
  await open();

  // ---- The page opens with an example and counts to today ----
  const first = data.cases[0];
  assert.equal(await getDate('ac-dob'), '1/1/2000');
  assert.equal(await getDate('ac-on'), '14/11/2026');
  let r = await read();
  assert.equal(r.head, 'Age on Saturday, November 14, 2026');
  assert.equal(r.age, '26 years, 10 months, 13 days');
  assert.equal(r.days, '9,814');
  // A US browser puts the month first; the boxes follow the visitor's region.
  assert.deepEqual(await page.$$eval('#ac-dob input', els => els.map(e => e.id)), ['ac-dob-m', 'ac-dob-d', 'ac-dob-y']);
  assert.equal(await page.locator('#ac-leap-field').isVisible(), false);

  // ---- Known answers ----
  for (const c of data.cases) {
    const label = `born ${c.dob.join('/')}, age on ${c.on.join('/')} (${c.rule})`;
    await setDate('ac-dob', c.dob);
    await setDate('ac-on', c.on);
    const leapling = c.dob[0] === 29 && c.dob[1] === 2;
    assert.equal(await page.locator('#ac-leap-field').isVisible(), leapling, `leap-day menu for ${label}`);
    if (leapling) await page.selectOption('#ac-leap', c.rule === 'feb28' ? '28' : '1');
    r = await read();
    for (const key of ['head', 'age', 'born', 'months', 'monthsRest', 'weeks', 'weeksRest', 'days', 'hours', 'minutes', 'seconds', 'weekday', 'test']) {
      assert.equal(r[key], c[key], `${key} for ${label}`);
    }
    const nth = c.on[2] - c.dob[2];
    const ordinal = nth + (nth % 100 >= 11 && nth % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][nth % 10] || 'th');
    // "Today" only when the age is counted to today (14 November 2026 in this test).
    const thisDay = c.on.join('-') === '14-11-2026' ? 'Today' : 'This date';
    assert.equal(r.next, (c.isBirthday ? `${thisDay} is the ${ordinal} birthday. The next one is ` : '') + c.next, `next birthday for ${label}`);
    assert.equal(r.korean, `${c.korean} (one at birth, plus one every 1 January)`, `Korean age for ${label}`);
    if (c.mark) assert.equal(r.mark, c.mark, `1,000-day mark for ${label}`);
    assert.equal(r.exact, '');
    assert.deepEqual([await text('#ac-dob-msg'), await text('#ac-on-msg'), await invalid('ac-dob'), await invalid('ac-on')], ['', '', '', ''], label);
  }
  // The guide's worked examples are among those cases: Pearson's test-manual method
  // (30-day months) gives 9 years, 11 months, 28 days where the calendar gives 29 days.
  const celf = data.cases.find(c => c.dob.join('-') === '20-9-2003');
  assert.deepEqual([celf.test, celf.age], ['9 years, 11 months, 28 days', '9 years, 11 months, 29 days']);
  const guide = await page.locator('.prose').textContent();
  for (const want of ['36 years, 5 months, 30 days', '13,332', '1 year, 1 month, 1 day', '395', '25 years, 0 months, 0 days', '9,132', '9 years, 11 months, 28 days']) {
    assert.ok(guide.includes(want), `guide mentions ${want}`);
  }
  assert.equal(data.cases.filter(c => c.isBirthday).length, 6); // 50th, 24th, 25th (both rules), 4th and 8th
  assert.equal(data.cases.filter(c => c.isBirthday && c.on.join('-') === '14-11-2026').length, 1); // one of them is today
  // A birthday on a date that is not today is not called "today", on the page or in the summary read out.
  await setDate('ac-dob', [15, 5, 1990]);
  await setDate('ac-on', [15, 5, 2030]);
  assert.equal(await text('#ac-next'), 'This date is the 40th birthday. The next one is Thursday, May 15, 2031, in 1 year (365 days). Turning 41.');
  await page.waitForFunction(() => document.querySelector('#ac-status').textContent === '40 years, 0 months, 0 days old on Wednesday, May 15, 2030. This date is the 40th birthday.');
  await setDate('ac-dob', [14, 11, 1976]);
  await page.click('#ac-today');
  assert.match(await text('#ac-next'), /^Today is the 50th birthday\. The next one is Sunday, November 14, 2027, /);
  await page.waitForFunction(() => document.querySelector('#ac-status').textContent === '50 years, 0 months, 0 days old on Saturday, November 14, 2026. Today is the 50th birthday.');
  assert.ok(data.cases.some(c => c.age === '36 years, 5 months, 30 days' && c.days === '13,332'));
  assert.ok(data.cases.some(c => c.age === '25 years, 0 months, 0 days' && c.days === '9,132' && c.rule === 'mar1'));

  // ---- Leap-day births: real 29 Februaries so far and the next one ----
  await setDate('ac-dob', [29, 2, 2000]);
  await page.click('#ac-today');
  assert.equal(await getDate('ac-on'), '14/11/2026');
  await page.selectOption('#ac-leap', '1');
  assert.equal(await page.locator('#ac-leapdays-row').isVisible(), true);
  // 2004, 2008, 2012, 2016, 2020 and 2024; 29 February 2028 is a Tuesday.
  assert.equal(await text('#ac-leapdays'), '6 so far. The next 29 February is Tuesday, February 29, 2028.');
  assert.match(await text('#ac-next'), /^Monday, March 1, 2027, /);
  await page.selectOption('#ac-leap', '28');
  assert.match(await text('#ac-next'), /^Sunday, February 28, 2027, /);
  // Born 29 February 1896: 1900 had no leap day, so the first one came in 1904 (a Monday).
  await setDate('ac-dob', [29, 2, 1896]);
  await setDate('ac-on', [1, 3, 1900]);
  assert.equal(await text('#ac-leapdays'), 'None yet. The next 29 February is Monday, February 29, 1904.');
  await setDate('ac-dob', [28, 2, 2000]);
  assert.equal(await page.locator('#ac-leap-field').isVisible(), false);
  assert.equal(await page.locator('#ac-leapdays-row').isVisible(), false);

  // ---- Errors: a message, the box at fault marked, no stale result ----
  await page.click('#ac-today');
  await setDate('ac-dob', [31, 4, 1990]);
  assert.equal(await text('#ac-dob-msg'), 'April 1990 has only 30 days.');
  assert.deepEqual([await link('#ac-dob-d'), await link('#ac-dob-m'), await link('#ac-dob-y')], [['ac-dob-msg', 'true'], ['ac-dob-msg', null], ['ac-dob-msg', null]]);
  r = await read();
  assert.deepEqual([r.age, r.days, r.next, r.head], ['–', '–', '–', 'Age']);
  assert.equal(await page.locator('#ac-copy').isDisabled(), true);
  assert.equal(await page.locator('#ac-link').isDisabled(), true);
  await setDate('ac-dob', [29, 2, 2001]);
  assert.equal(await text('#ac-dob-msg'), 'February 2001 has only 28 days.');
  await setDate('ac-dob', [29, 2, 1900]);
  assert.equal(await text('#ac-dob-msg'), 'February 1900 has only 28 days.');
  await setDate('ac-dob', [29, 2, 2000]);
  assert.equal(await text('#ac-dob-msg'), '');
  assert.deepEqual(await link('#ac-dob-d'), ['ac-dob-msg', null]);
  // Pasted or typed junk, zero and numbers out of range.
  await page.fill('#ac-dob-d', 'ab');
  assert.equal(await text('#ac-dob-msg'), 'The day must be a number from 1 to 31.');
  assert.equal(await invalid('ac-dob'), 'd');
  await page.fill('#ac-dob-d', '0');
  assert.equal(await invalid('ac-dob'), 'd');
  await page.fill('#ac-dob-d', '-5');
  assert.equal(await invalid('ac-dob'), 'd');
  await page.fill('#ac-dob-d', '15');
  await page.fill('#ac-dob-m', '13');
  assert.equal(await text('#ac-dob-msg'), 'The month must be a number from 1 to 12, or a name such as May.');
  assert.equal(await invalid('ac-dob'), 'm');
  await page.fill('#ac-dob-y', '0000'); // there is no year 0
  assert.equal(await text('#ac-dob-msg'), 'The month must be a number from 1 to 12, or a name such as May. The year must be a number from 1 to 9999.');
  assert.equal(await invalid('ac-dob'), 'my');
  await page.fill('#ac-dob-m', 'May');
  await page.fill('#ac-dob-y', '😀');
  assert.equal(await text('#ac-dob-msg'), 'The year must be a number from 1 to 9999.');
  await page.fill('#ac-dob-y', '1990');
  assert.equal(await text('#ac-dob-msg'), '');
  assert.equal(await text('#ac-age'), '36 years, 5 months, 30 days'); // "May" is month 5
  await page.fill('#ac-dob-m', 'sept.');
  assert.equal(await text('#ac-born'), 'Born on Saturday, September 15, 1990.');
  // Digits of other scripts are read as digits: full-width 15, Arabic-Indic 5, Persian 1990.
  await setDate('ac-dob', ['１５', '٥', '۱۹۹۰']);
  assert.equal(await text('#ac-age'), '36 years, 5 months, 30 days');
  assert.equal(await invalid('ac-dob'), '');
  // A year needs all four digits: "90" is not taken for the year 90, and typing a year
  // does not flash ages of two thousand years. It is a prompt, not an error.
  await page.fill('#ac-dob-y', '90');
  assert.equal(await text('#ac-born'), 'Enter the year of birth with four digits, such as 1990.');
  assert.deepEqual([await text('#ac-age'), await text('#ac-days'), await text('#ac-dob-msg'), await invalid('ac-dob')], ['–', '–', '', '']);
  assert.equal(await page.locator('#ac-copy').isDisabled(), true);
  await page.fill('#ac-dob-y', '');
  const typedYear = [];
  for (const digit of '1990') {
    await page.locator('#ac-dob-y').pressSequentially(digit);
    typedYear.push(await text('#ac-age'));
  }
  assert.deepEqual(typedYear, ['–', '–', '–', '36 years, 5 months, 30 days']);
  // Years before 1000 take leading zeros; a link or a pasted date writes them that way.
  await page.fill('#ac-dob-y', '0090');
  assert.deepEqual([await text('#ac-born'), await text('#ac-age')], ['Born on Monday, May 15, 90.', '1,936 years, 5 months, 30 days']);
  await page.fill('#ac-dob-y', '0000');
  assert.equal(await text('#ac-dob-msg'), 'The year must be a number from 1 to 9999.');
  await page.fill('#ac-dob-y', '1990');
  await page.fill('#ac-on-y', '30');
  assert.equal(await text('#ac-born'), 'Enter the year with four digits, such as 2026.');
  assert.deepEqual([await text('#ac-age'), await text('#ac-on-msg'), await invalid('ac-on')], ['–', '', '']);
  await page.click('#ac-today');
  assert.equal(await text('#ac-age'), '36 years, 5 months, 30 days');
  // A half-filled date is a prompt, not an error.
  await page.fill('#ac-dob-y', '');
  assert.equal(await text('#ac-dob-msg'), '');
  assert.equal(await invalid('ac-dob'), '');
  assert.equal(await text('#ac-born'), 'Enter the day, month and year of birth.');
  assert.equal(await text('#ac-age'), '–');
  await setDate('ac-dob', ['', '', '']);
  assert.equal(await text('#ac-born'), 'Enter the day, month and year of birth.');
  assert.equal(await text('#ac-dob-msg'), '');
  // A date of birth after today.
  await setDate('ac-dob', [15, 11, 2026]);
  assert.equal(await text('#ac-dob-msg'), 'This date is in the future. Enter a date of birth up to today, November 14, 2026.');
  assert.equal(await invalid('ac-dob'), 'dmy');
  assert.equal(await invalid('ac-on'), '');
  assert.equal(await text('#ac-age'), '–');
  // An "age on" date before the birth: that date is the one at fault.
  await setDate('ac-dob', [1, 1, 2000]);
  await setDate('ac-on', [31, 12, 1999]);
  assert.equal(await text('#ac-on-msg'), 'This date is before the date of birth. Enter January 1, 2000 or a later date.');
  assert.deepEqual([await invalid('ac-dob'), await invalid('ac-on')], ['', 'dmy']);
  assert.deepEqual(await link('#ac-on-y'), ['ac-on-msg', 'true']);
  assert.equal(await text('#ac-age'), '–');
  await page.fill('#ac-on-y', '');
  assert.equal(await text('#ac-on-msg'), '');
  assert.equal(await text('#ac-born'), 'Enter the day, month and year to count the age to, or press Today.');
  await page.fill('#ac-on-d', '40');
  assert.equal(await text('#ac-on-msg'), 'The day must be a number from 1 to 31.');
  assert.equal(await invalid('ac-on'), 'd');
  // Today puts the date back, and nothing typed in the other boxes is lost.
  await page.click('#ac-today');
  assert.equal(await getDate('ac-on'), '14/11/2026');
  assert.equal(await getDate('ac-dob'), '1/1/2000');
  assert.equal(await text('#ac-on-msg'), '');
  assert.equal(await text('#ac-age'), '26 years, 10 months, 13 days');

  // ---- A whole date pasted into one box fills all three ----
  const paste = async (sel, value) => {
    await page.evaluate(v => navigator.clipboard.writeText(v), value);
    await page.focus(sel);
    await page.keyboard.press('Control+V');
  };
  for (const [value, want] of [['1990-05-15', '15/5/1990'], ['15 May 1990', '15/5/1990'], ['May 15, 1990', '15/5/1990'], ['Tuesday, May 15th, 1990', '15/5/1990'],
    ['05/15/1990', '15/5/1990'], ['31/12/1999', '31/12/1999'], ['3.4.2001', '4/3/2001']]) {
    await setDate('ac-dob', [9, 9, 1909]);
    await paste('#ac-dob-d', value);
    assert.equal(await getDate('ac-dob'), want, `pasted ${value}`);
  }
  await paste('#ac-on-y', '2030-01-01');
  assert.equal(await getDate('ac-on'), '1/1/2030');
  assert.equal(await text('#ac-head'), 'Age on Tuesday, January 1, 2030');
  // A date before the year 1000 is written with four digits, as the box asks for it.
  await paste('#ac-dob-m', '5 June 987');
  assert.equal(await getDate('ac-dob'), '5/6/0987');
  assert.equal(await text('#ac-born'), 'Born on Tuesday, June 5, 987.');
  // Spaces around a pasted number are dropped; they would use up the two characters of the box.
  await setDate('ac-dob', [9, 9, 1909]);
  await paste('#ac-dob-d', ' 15\n');
  assert.equal(await page.inputValue('#ac-dob-d'), '15');
  assert.equal(await text('#ac-born'), 'Born on Wednesday, September 15, 1909.');
  await paste('#ac-dob-y', '\t１９９０ ');
  assert.deepEqual([await page.inputValue('#ac-dob-y'), await text('#ac-born')], ['1990', 'Born on Saturday, September 15, 1990.']);
  // Anything else is pasted whole and reported. Cut to the two characters of the box,
  // the start of a date that cannot be read (15/5/90, 19900515) would pass for the day.
  for (const junk of ['hello', '15/5/90', '19900515', '1990年5月15日']) {
    await setDate('ac-dob', [9, 9, 1909]);
    await paste('#ac-dob-d', junk);
    assert.equal(await page.inputValue('#ac-dob-d'), junk);
    assert.deepEqual([await text('#ac-dob-msg'), await invalid('ac-dob'), await text('#ac-age')], ['The day must be a number from 1 to 31.', 'd', '–'], `pasted ${junk}`);
  }
  // A megabyte of text does not end up in the box.
  await page.fill('#ac-dob-d', '');
  await paste('#ac-dob-d', 'x'.repeat(1 << 20));
  assert.equal((await page.inputValue('#ac-dob-d')).length, 40);
  await setDate('ac-dob', [15, 5, 1990]);

  // ---- Copy results and Copy link ----
  await page.click('#ac-today');
  await page.click('#ac-copy');
  assert.equal(await clipboard(), [
    'Date of birth: Tuesday, May 15, 1990',
    'Age on Saturday, November 14, 2026: 36 years, 5 months, 30 days',
    'In single units: 437 months and 30 days; 1,904 weeks and 4 days; 13,332 days; 319,968 hours; 19,198,080 minutes; 1,151,884,800 seconds',
    'Next birthday: Saturday, May 15, 2027, in 182 days, turning 37',
  ].join('\n'));
  assert.equal(await text('#ac-copy'), 'Copied!');
  await page.click('#ac-link');
  assert.equal(await clipboard(), `${url}#dob=1990-05-15`);
  // Nothing is put in the address by itself: a date of birth is personal.
  assert.equal(await page.evaluate(() => location.hash), '');
  await setDate('ac-dob', [29, 2, 2000]);
  await page.selectOption('#ac-leap', '28');
  await setDate('ac-on', [28, 2, 2025]);
  await page.fill('#ac-time', '08:30');
  await page.click('#ac-link');
  const shared = await clipboard();
  assert.equal(shared, `${url}#dob=2000-02-29&on=2025-02-28&time=08:30&leap=28`);
  // Opening such a link restores every field.
  await page.goto('about:blank');
  await page.goto(shared, { waitUntil: 'load' });
  assert.deepEqual([await getDate('ac-dob'), await getDate('ac-on'), await page.inputValue('#ac-time'), await page.inputValue('#ac-leap')], ['29/2/2000', '28/2/2025', '08:30', '28']);
  assert.equal(await text('#ac-age'), '25 years, 0 months, 0 days');
  // Once the visitor changes something the address no longer fits, so the dates leave it.
  await page.fill('#ac-on-d', '27');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await text('#ac-age'), '24 years, 11 months, 29 days');
  // A link without an "age on" date counts to today.
  await page.goto('about:blank');
  await page.goto(`${url}#dob=1990-05-15`, { waitUntil: 'load' });
  assert.deepEqual([await getDate('ac-dob'), await getDate('ac-on'), await text('#ac-age')], ['15/5/1990', '14/11/2026', '36 years, 5 months, 30 days']);
  // A link to a year before 1000 fills the year box with four digits.
  await page.goto('about:blank');
  await page.goto(`${url}#dob=0987-06-05&on=1066-10-14`, { waitUntil: 'load' });
  assert.deepEqual([await getDate('ac-dob'), await getDate('ac-on'), await text('#ac-age')], ['5/6/0987', '14/10/1066', '79 years, 4 months, 9 days']);
  // Dates that do not exist in a link are ignored.
  await page.goto('about:blank');
  await page.goto(`${url}#dob=1990-02-30&on=junk`, { waitUntil: 'load' });
  assert.deepEqual([await getDate('ac-dob'), await getDate('ac-on')], ['1/1/2000', '14/11/2026']);

  // ---- Keyboard: Tab into a box selects it, so typing replaces the example ----
  await page.focus('#ac-dob-m');
  await page.waitForFunction(() => { const el = document.activeElement; return el.id === 'ac-dob-m' && el.selectionStart === 0 && el.selectionEnd === el.value.length; });
  await page.keyboard.type('7');
  for (const [id, value] of [['ac-dob-d', '4'], ['ac-dob-y', '1976']]) {
    await page.keyboard.press('Tab');
    await page.waitForFunction(i => { const el = document.activeElement; return el.id === i && el.selectionEnd === el.value.length && el.selectionStart === 0; }, id);
    await page.keyboard.type(value);
  }
  assert.equal(await getDate('ac-dob'), '4/7/1976');
  assert.equal(await text('#ac-age'), '50 years, 4 months, 10 days');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ac-time');
  await page.focus('#ac-on-y');
  await page.waitForFunction(() => document.activeElement.id === 'ac-on-y' && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 4);
  await page.keyboard.type('2000');
  assert.equal(await text('#ac-age'), '24 years, 4 months, 10 days');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ac-today');
  // The focused button has a visible focus ring.
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
  await page.keyboard.press('Enter');
  assert.equal(await text('#ac-age'), '50 years, 4 months, 10 days');

  // ---- Screen readers: results are not live; one summary once typing pauses ----
  for (const sel of ['#ac-age', '#ac-days', '#ac-next', '#ac-dob-msg', '#ac-on-msg', '#ac-time-msg', '#ac-note']) {
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
  await page.fill('#ac-dob-y', '');
  await page.waitForFunction(() => document.querySelector('#ac-status').textContent === 'Enter the day, month and year of birth.');
  await page.evaluate(() => window.__said.splice(0));
  await page.locator('#ac-dob-y').pressSequentially('1990', { delay: 80 });
  const spoken = '36 years, 4 months, 10 days old on Saturday, November 14, 2026. Next birthday in 232 days.';
  await page.waitForFunction(t => document.querySelector('#ac-status').textContent === t, spoken);
  assert.deepEqual(await page.evaluate(() => window.__said.splice(0)), [spoken]);
  await page.fill('#ac-dob-d', '31');
  await page.fill('#ac-dob-m', '6');
  await page.waitForFunction(() => document.querySelector('#ac-status').textContent === 'June 1990 has only 30 days.');
  // The page counting on by itself is not announced.
  await setDate('ac-dob', [15, 5, 1990]);
  await page.waitForFunction(() => /^36 years, 5 months, 30 days old/.test(document.querySelector('#ac-status').textContent));
  await page.evaluate(() => window.__said.splice(0));
  await page.clock.runFor(61000);
  assert.deepEqual(await page.evaluate(() => window.__said.splice(0)), []);

  // ---- Time of birth: real elapsed time in the device's time zone ----
  for (const t of data.timed) {
    const label = `${t.tz}, born ${t.dob.join('/')} ${t.time}, on ${t.on ? t.on.join('/') : 'today'}`;
    await zone(t.tz);
    await page.clock.setSystemTime(new Date(t.now));
    await page.goto('about:blank');
    await open();
    await setDate('ac-dob', t.dob);
    if (t.on) await setDate('ac-on', t.on);
    await page.fill('#ac-time', t.time);
    r = await read();
    for (const key of ['age', 'days', 'hours', 'minutes', 'seconds', 'exact']) assert.equal(r[key], t[key], `${key} for ${label}`);
    // The zone is named in plain words (from the browser's own data).
    assert.match(r.note, /, both read as [^,]+, so clock changes are counted\.$/);
    if (t.tz === 'America/New_York') assert.ok(r.note.includes('both read as Eastern Time,'), r.note);
    if (t.tz === 'Asia/Kolkata') assert.ok(r.note.includes('both read as India Standard Time,'), r.note);
    assert.equal(await text('#ac-time-msg'), '');
  }
  // The count moves on with the clock: one minute later, 60 seconds more.
  await zone('America/New_York');
  await page.clock.setSystemTime(new Date(data.now));
  await page.goto('about:blank');
  await open();
  await setDate('ac-dob', [15, 5, 1990]);
  await page.fill('#ac-time', '08:30');
  const ny = data.timed[0];
  assert.equal(await text('#ac-seconds'), ny.seconds);
  assert.match(await text('#ac-note'), /^Hours, minutes and seconds run from 8:30 AM on May 15, 1990 to 5:00 AM on November 14, 2026 \(now\), both read as Eastern Time, so clock changes are counted\.$/);
  await page.clock.runFor(60000);
  assert.equal(await text('#ac-seconds'), (Number(ny.seconds.replace(/,/g, '')) + 60).toLocaleString('en-US'));
  assert.match(await text('#ac-note'), /to 5:01 AM on November 14, 2026 \(now\)/);
  // The 12-hour clock of a US browser: noon is 12:00 PM, a quarter past midnight 12:15 AM.
  for (const [time, shown] of [['12:00', '12:00 PM'], ['00:15', '12:15 AM'], ['13:05', '1:05 PM'], ['23:59', '11:59 PM'], ['11:59', '11:59 AM']]) {
    await page.fill('#ac-time', time);
    const note = await text('#ac-note');
    assert.ok(note.startsWith(`Hours, minutes and seconds run from ${shown} on May 15, 1990 to 5:01 AM on November 14, 2026 (now), `), `${time}: ${note}`);
  }
  // Years before 100 belong to the first century, also when the hours are counted
  // (JavaScript's own date takes 99 for 1999): two years of 365 days.
  await setDate('ac-dob', [15, 5, 99]);
  await setDate('ac-on', [15, 5, 101]);
  await page.fill('#ac-time', '08:30');
  assert.deepEqual([await text('#ac-age'), await text('#ac-days'), await text('#ac-hours'), await text('#ac-time-msg')], ['2 years, 0 months, 0 days', '730', '17,520', '']);
  await page.click('#ac-today');
  await setDate('ac-dob', [15, 5, 1990]);
  // Without a time the hours are whole days again.
  await page.fill('#ac-time', '');
  assert.equal(await text('#ac-hours'), '319,968');
  assert.equal(await text('#ac-exact'), '');
  assert.match(await text('#ac-note'), /whole days of 24 hours/);
  // A birth later today than the current time (5:01 AM in New York).
  await setDate('ac-dob', [14, 11, 2026]);
  await page.fill('#ac-time', '23:59');
  assert.equal(await text('#ac-time-msg'), 'That time is in the future: it is 5:01 AM now.');
  assert.deepEqual(await link('#ac-time'), ['ac-time-hint ac-time-msg', 'true']);
  assert.equal(await text('#ac-age'), '0 days');
  assert.equal(await text('#ac-hours'), '0');
  await page.fill('#ac-time', '04:00');
  assert.equal(await text('#ac-time-msg'), '');
  assert.deepEqual(await link('#ac-time'), ['ac-time-hint ac-time-msg', null]);
  assert.equal(await text('#ac-minutes'), '61');
  assert.equal(await text('#ac-exact'), 'Counted from the time of birth: 0 days, 1 hour, 1 minute.');
  // Where the browser has no time field this is a plain text box: a time that cannot be read is reported.
  await page.$eval('#ac-time', el => { el.type = 'text'; });
  await page.fill('#ac-time', 'half past four');
  assert.equal(await text('#ac-time-msg'), 'Enter the time as hours and minutes on the 24-hour clock, such as 08:30.');
  assert.deepEqual(await link('#ac-time'), ['ac-time-hint ac-time-msg', 'true']);
  assert.equal(await text('#ac-hours'), '0');
  await page.fill('#ac-time', '4:00');
  assert.deepEqual([await text('#ac-time-msg'), await text('#ac-minutes'), await link('#ac-time')], ['', '61', ['ac-time-hint ac-time-msg', null]]);

  // ---- "Today" is the visitor's local date and rolls over at midnight ----
  // 2026-11-14T10:00Z is still 13 November, 11:00 PM, in Honolulu.
  await zone('Pacific/Honolulu');
  await page.clock.setSystemTime(new Date('2026-11-14T09:59:30Z'));
  await page.goto('about:blank');
  await open();
  assert.equal(await getDate('ac-on'), '13/11/2026');
  assert.equal(await text('#ac-days'), '9,813');
  await page.clock.runFor(60000);
  assert.equal(await getDate('ac-on'), '14/11/2026');
  assert.equal(await text('#ac-days'), '9,814');
  // A date the visitor typed stays put when the day changes.
  await zone('UTC');
  await page.clock.setSystemTime(new Date('2026-11-14T23:59:30Z'));
  await page.goto('about:blank');
  await open();
  await setDate('ac-on', [14, 11, 2026]);
  await page.clock.runFor(60000);
  assert.equal(await getDate('ac-on'), '14/11/2026');
  await page.click('#ac-today');
  assert.equal(await getDate('ac-on'), '15/11/2026');
  await page.clock.setSystemTime(new Date(data.now));

  // ---- Back from another page: the browser may put typed values back after the page
  // has loaded, and the result then follows the boxes ----
  await page.goto('about:blank');
  await open();
  await setDate('ac-dob', [15, 5, 1990]);
  await page.goto(`${base}/about/`, { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'load' });
  const restored = await getDate('ac-dob');
  assert.ok(['15/5/1990', '1/1/2000'].includes(restored), restored);
  assert.deepEqual([await text('#ac-born'), await text('#ac-age')], restored === '15/5/1990'
    ? ['Born on Tuesday, May 15, 1990.', '36 years, 5 months, 30 days'] : ['Born on Saturday, January 1, 2000.', '26 years, 10 months, 13 days']);

  // ---- The FAQ covers privacy, and the page keeps its promise about the address ----
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(/sent or stored/i.test(faqs[faqs.length - 1]), faqs.join(' | '));

  // ---- A British browser: day first, dates written day month year, 24-hour clock ----
  const browser = page.context().browser();
  const gb = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1280, height: 900 } });
  const gbPage = await gb.newPage();
  await gbPage.clock.install({ time: new Date(data.now) });
  await gbPage.goto(url, { waitUntil: 'load' });
  assert.deepEqual(await gbPage.$$eval('#ac-on input', els => els.map(e => e.id)), ['ac-on-d', 'ac-on-m', 'ac-on-y']);
  assert.equal(await gbPage.locator('#ac-head').textContent(), 'Age on Saturday, 14 November 2026');
  assert.equal(await gbPage.locator('#ac-next').textContent(), 'Friday, 1 January 2027, in 1 month, 18 days (48 days). Turning 27.');
  await gbPage.fill('#ac-dob-d', '14');
  await gbPage.fill('#ac-dob-m', '11');
  await gbPage.fill('#ac-dob-y', '2026');
  await gbPage.fill('#ac-time', '15:45');
  assert.equal(await gbPage.locator('#ac-time-msg').textContent(), 'That time is in the future: it is 10:00 now.');
  await gb.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'UTC' });
  const p = await phone.newPage();
  await p.clock.install({ time: new Date(data.now) });
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('#ac-dob-d');
  await p.waitForFunction(() => { const el = document.activeElement; return el.id === 'ac-dob-d' && el.selectionEnd === el.value.length && el.selectionStart === 0; });
  await p.keyboard.type('15');
  await p.tap('#ac-dob-m');
  await p.waitForFunction(() => document.activeElement.id === 'ac-dob-m' && document.activeElement.selectionEnd === 1);
  await p.keyboard.type('5');
  await p.tap('#ac-dob-y');
  await p.waitForFunction(() => document.activeElement.id === 'ac-dob-y' && document.activeElement.selectionEnd === 4);
  await p.keyboard.type('1990');
  assert.equal(await p.locator('#ac-age').textContent(), '36 years, 5 months, 30 days');
  await p.fill('#ac-on-y', '2020');
  assert.equal(await p.locator('#ac-age').textContent(), '30 years, 5 months, 30 days');
  await p.tap('#ac-today');
  assert.equal(await p.locator('#ac-age').textContent(), '36 years, 5 months, 30 days');
  // The leap-day menu shows its choice in full, also on the narrowest phone.
  await p.fill('#ac-dob-d', '29');
  await p.fill('#ac-dob-m', '2');
  await p.fill('#ac-dob-y', '2000');
  await p.setViewportSize({ width: 320, height: 640 });
  for (const rule of ['1', '28']) {
    await p.selectOption('#ac-leap', rule);
    const [need, room] = await p.$eval('#ac-leap', s => {
      const c = document.createElement('canvas').getContext('2d'), cs = getComputedStyle(s);
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      // 28 px are kept free for the arrow of the menu.
      return [Math.ceil(c.measureText(s.selectedOptions[0].textContent).width), Math.floor(s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 28)];
    });
    assert.ok(need <= room, `the leap-day choice needs ${need}px and has ${room}px`);
  }
  assert.match(await p.locator('#ac-next').textContent(), /^Sunday, February 28, 2027, /);
  await p.setViewportSize(devices['Pixel 7'].viewport);
  // Controls are at least 44 px tall, text boxes use 16 px type (no zoom on iOS), numeric keypad.
  const sizes = await p.$$eval('.ac input:not([type="hidden"]), .ac select, .ac button', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id, h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), text: e.matches('input, select'), mode: e.getAttribute('inputmode'), type: e.type,
  })));
  assert.ok(sizes.length >= 10, `found ${sizes.length} controls`);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.text) assert.ok(s.font >= 16, `${s.id} has ${s.font}px type`);
    if (s.type === 'text') assert.equal(s.mode, 'numeric', `${s.id} asks for the numeric keypad`);
  }
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on the phone');
  await phone.close();
};
