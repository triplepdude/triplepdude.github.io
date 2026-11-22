const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Known answers come from tests/fixtures/time-zone-converter/expected.json, made by expected.py with
// Python's zoneinfo and tzdata 2026f compiled with zic, never from the page or the browser. The
// browser runs in Europe/Rome with its clock fixed at 2026-11-24 12:00 UTC.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const E = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = iso => { const [y, m, d] = iso.split('-').map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]} ${y}`; };
  const text = sel => page.locator(sel).textContent();
  const rows = () => page.$$eval('#tzc-rows > li', ls => ls.map(l => ({
    name: l.querySelector('.tzc-name').textContent, time: l.querySelector('.tzc-t').textContent,
    date: l.querySelector('.tzc-d').textContent, tags: [...l.querySelectorAll('.tzc-tag')].map(t => t.textContent),
    text: l.textContent.replace(/\s+/g, ' '),
  })));
  const ask = async q => {
    await page.fill('#tzc-ask', q);
    await page.press('#tzc-ask', 'Enter');
    await page.waitForFunction(() => document.querySelector('#tzc-ask-ok').textContent || document.querySelector('#tzc-ask-error').textContent);
    return rows();
  };
  const describedBy = async (field, msg) => {
    assert.equal(await page.getAttribute(field, 'aria-invalid'), 'true', `${field} is marked invalid`);
    assert.ok((await page.getAttribute(field, 'aria-describedby')).split(' ').includes(msg), `${field} points at #${msg}`);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' });
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  await page.clock.install({ time: new Date('2026-11-24T12:00:00Z') });
  await open();
  assert.equal(await page.evaluate(() => location.hash), '', 'an untouched page keeps a clean address');
  // The clock follows the browser's language (en-US here: 12-hour); the test reads 24-hour times.
  assert.equal(await page.isChecked('#tzc-c12'), await page.evaluate(() => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true));
  await page.check('#tzc-c24');

  // ---- The page starts with the device's zone and three common places, following the clock. ----
  let r = await rows();
  assert.deepEqual(r.map(x => x.name), ['Rome', 'New York', 'London', 'New Delhi']);
  assert.deepEqual(r.map(x => x.time), ['Europe/Rome', 'America/New_York', 'Europe/London', 'Asia/Kolkata'].map(z => E.now[z].time));
  assert.deepEqual(r[0].tags, ['first place', 'your device']);
  assert.match(r[1].text, /EST · UTC−05:00 · 6 h behind Rome/);
  assert.match(r[3].text, /IST · UTC\+05:30 · 4 h 30 min ahead of Rome/);
  assert.equal(await page.inputValue('#tzc-date'), '2026-11-24');
  assert.equal(await page.inputValue('#tzc-time'), '13:00');
  assert.equal(await page.getAttribute('#tzc-now', 'aria-pressed'), 'true');
  assert.match(await text('#tzc-live'), /device’s clock/);
  assert.match(await page.evaluate(() => location.hash), /&t=now&c=24&/, 'a change is kept in the address');
  // Next clock changes, from tzdata 2026f.
  const ch = E.changes['America/New_York'][0];
  assert.match(r[1].text, new RegExp(`Next clock change: ${day(ch.before.slice(0, 10))} at ${ch.before.slice(11)}, forward 1 hour to ${ch.after.slice(11)} \\(EDT, UTC−04:00\\)`));
  assert.match(r[3].text, /No clock change in the next 12 months/);
  // The planner has the 24 hours of Rome's day, with 13:00 picked.
  assert.equal(await page.locator('#tzc-plan [role="option"]').count(), 24);
  assert.equal(await page.getAttribute('#tzc-plan', 'aria-activedescendant'), 'tzc-col-13');
  assert.match(await page.locator('#tzc-col-13').textContent(), /13:00 in Rome \(working hours\);07:00 in New York \(morning or evening\);/);
  // Live: a minute later every row has moved on, in the same elements, and the focus stays put.
  const clockEl = await page.$('#tzc-rows li[data-i="0"] .tzc-t');
  await page.focus('#tzc-rows li[data-i="2"] button[data-act="first"]');
  await page.clock.runFor(60000);
  assert.equal((await rows())[0].time, '13:01');
  assert.equal(await clockEl.evaluate(e => e.isConnected && e.textContent), '13:01', 'the minute tick updates the same element');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Make first place: London');
  assert.equal(await page.inputValue('#tzc-time'), '13:01');
  // The tz 2026f check, in the small print.
  const browserOld = await page.evaluate(() => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' }).format(new Date('2026-11-24T12:00:00Z')) === '04');
  assert.match(await text('#tzc-rules'), /tz 2026f \(27 October 2026\)/);
  if (browserOld) assert.match(await text('#tzc-rules'), /out of date for Vancouver \(British Columbia\)/);

  // ---- Typed questions ----
  r = await ask('3pm EST to IST');
  assert.deepEqual(r.map(x => [x.name, x.time, x.date]), [
    ['New York', E.est_winter['America/New_York'].time, day(E.est_winter['America/New_York'].date)],
    ['New Delhi', E.est_winter['Asia/Kolkata'].time, day(E.est_winter['Asia/Kolkata'].date)],
  ]);
  assert.ok(r[1].tags.includes('next day'));
  assert.match(await text('#tzc-ask-ok'), /^Read as 15:00 on Tue 24 Nov 2026 in New York \(EST\), compared with New Delhi\.$/);
  assert.equal(await text('#tzc-status'), `15:00 in New York is ${E.est_winter['Asia/Kolkata'].time} Wed in New Delhi.`);
  assert.equal(await page.getAttribute('#tzc-ask', 'aria-invalid'), null);
  // IST is ambiguous: the page says which meaning it used and offers the others.
  assert.match(r[1].text, /IST is read as India Standard Time\. It can also mean:/);
  await page.click('#tzc-rows button:has-text("Israel Standard Time")');
  r = await rows();
  assert.deepEqual([r[1].name, r[1].time], ['Jerusalem', E.est_winter['Asia/Jerusalem'].time]);
  assert.match(r[1].text, /India Standard Time \(New Delhi, UTC\+05:30\)/, 'the first meaning is still offered');

  r = await ask('What is 3 pm EST in UK and India time?');
  assert.deepEqual(r.map(x => [x.name, x.time]), [['New York', '15:00'], ['United Kingdom', E.est_winter['Europe/London'].time], ['India', E.est_winter['Asia/Kolkata'].time]]);

  // A summer EST is read as New York time, said so, and one tap gives fixed UTC-5.
  r = await ask('3pm EST on 14 July 2027 to IST');
  assert.deepEqual(r.map(x => x.time), [E.est_summer_ny['America/New_York'].time, E.est_summer_ny['Asia/Kolkata'].time]);
  assert.match(r[0].text, /EST is read as New York time: on Wed 14 Jul 2027 New York is on EDT \(UTC−04:00\), not EST \(UTC−05:00\)\./);
  await page.click('#tzc-rows button:has-text("Use fixed UTC−05:00")');
  r = await rows();
  assert.equal(r[0].name, 'EST (fixed)');
  assert.equal(r[0].time, '15:00');
  assert.equal(r[1].time, E.est_summer_fixed['Asia/Kolkata'].time);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Remove EST (fixed)', 'focus stays in the row that changed');

  // Skipped and repeated times.
  assert.deepEqual(E.skipped, []);
  r = await ask('2:30 New York 14 Mar 2027 to London');
  assert.deepEqual(r.map(x => x.time), [E.skipped_shown['America/New_York'].time, E.skipped_shown['Europe/London'].time]);
  assert.match(r[0].text, /02:30 does not exist in New York City on Sun 14 Mar 2027: clocks go forward 1 hour that night\. Showing 03:30 EDT/);
  r = await ask('1:30 New York 7 Nov 2027 to London');
  assert.deepEqual(r.map(x => x.time), [E.repeated[0]['America/New_York'].time, E.repeated[0]['Europe/London'].time]);
  assert.match(r[0].text, /01:30 happens twice in New York City on Sun 7 Nov 2027, as clocks go back\. Showing the first time, EDT/);
  await page.click('#tzc-rows button:has-text("Use the second time (EST)")');
  r = await rows();
  assert.deepEqual(r.map(x => x.time), [E.repeated[1]['America/New_York'].time, E.repeated[1]['Europe/London'].time]);
  assert.match(r[0].text, /EST · UTC−05:00/);
  assert.match(await page.evaluate(() => location.hash), /&t=2027-11-07T01:30-2&/);
  assert.ok(!/Other places called/.test(r[1].text), 'much smaller namesakes (London, Ontario) are not offered');
  // A city name shared by places in other zones: the larger is used and the others are offered.
  r = await ask('9am Hyderabad to London');
  assert.deepEqual(r.map(x => [x.name, x.time]), [['Hyderabad', '09:00'], ['London', '03:30']]);
  assert.match(r[0].text, /Hyderabad is read as Hyderabad, Telangana, India\. Other places called Hyderabad:/);
  await page.click('#tzc-rows button:has-text("Hyderabad, Sindh, Pakistan (UTC+05:00)")');
  r = await rows();
  assert.deepEqual(r.map(x => [x.name, x.sub, x.time]).map(x => [x[0], x[2]]), [['Hyderabad', '09:00'], ['London', '04:00']]);
  assert.match(r[0].text, /Pakistan · Asia\/Karachi/);
  assert.match(r[0].text, /Other places called Hyderabad:Hyderabad, Telangana, India/);

  // The eight zones whose rules changed in 2026 show tzdata 2026f's time, corrected if need be.
  const stale = ['America/Vancouver', 'America/Edmonton', 'America/Inuvik', 'America/Winnipeg', 'America/Havana', 'Africa/Casablanca', 'Africa/El_Aaiun'];
  r = await ask('noon UTC to Vancouver, Edmonton, Inuvik, Winnipeg, Havana, Casablanca, Laayoune');
  assert.deepEqual(r.map(x => x.name), ['UTC', 'Vancouver', 'Edmonton', 'Inuvik', 'Winnipeg', 'Havana', 'Casablanca', 'Laayoune']);
  assert.deepEqual(r.slice(1).map(x => x.time), stale.map(z => E.stale[z].time));
  const oldRules = await page.evaluate(zs => zs.map(z => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    return f.format(new Date('2026-11-24T12:00:00Z'));
  }), stale);
  stale.forEach((z, i) => {
    const corrected = oldRules[i] !== E.stale[z].time;
    assert.equal(/Corrected: your browser’s time zone rules/.test(r[i + 1].text), corrected, `${z}: corrected note only when the browser is out of date`);
  });
  if (browserOld) assert.match(r[1].text, /MST · UTC−07:00 · 7 h behind UTC/);
  assert.match(r[5].text, /Next clock change: Sun 7 Nov 2027 at 01:00, back 1 hour to 00:00 \(CST, UTC−05:00\)/);
  await page.goto(url + '#p=UTC,Europe/Chisinau&t=2027-03-28T00:30&c=24&w=9-17');
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 2 && document.querySelector('.tzc-t').textContent === '00:30');
  assert.equal((await rows())[1].time, E.chisinau_spring.time);
  await page.goto(url + '#p=UTC,America/Havana&t=2027-12-01T12:00');
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 2);
  assert.equal((await rows())[1].time, E.havana_2027_12.time);

  // Mistakes are explained next to the field.
  for (const [q, msg] of [
    ['25pm London', /^25pm is not a time: with am or pm the hour runs from 1 to 12\.$/],
    ['3pm Atlantis', /^No place called “Atlantis” was found\./],
    ['10:00 14/03/2027 London', /^Write the date as 14 Mar 2027 or 2027-03-14: 14\/03\/2027 is a different day in the UK and the US\.$/],
    ['3pm London on 31 February', /^There is no 31 Feb 2026\.$/],
    ['   ', /^Type a time and places/],
  ]) {
    await ask(q);
    assert.match(await text('#tzc-ask-error'), msg, q);
    await describedBy('#tzc-ask', 'tzc-ask-error');
  }
  // Words that name built-in properties of objects are just unknown places.
  for (const w of ['constructor', '__proto__', 'toString']) {
    await ask('3pm ' + w);
    assert.equal(await text('#tzc-ask-error'), `No place called “${w}” was found. Try a larger city nearby, the country, a zone such as Europe/Paris or an offset such as UTC+2.`);
    await page.fill('#tzc-add', w);
    assert.equal(await page.$$eval('#tzc-sugg [data-opt]', ls => ls.length), 0, w);
  }
  await page.fill('#tzc-add', '');
  await page.fill('#tzc-ask', 'London');
  assert.equal(await page.getAttribute('#tzc-ask', 'aria-invalid'), null, 'typing clears the error');
  assert.equal(await text('#tzc-ask-error'), '');
  // A megabyte pasted into the question box is refused at once.
  let cpu = await threadMs();
  await page.$eval('#tzc-ask', el => { el.value = '3pm EST to IST, '.repeat(70000); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.press('#tzc-ask', 'Enter');
  assert.match(await text('#tzc-ask-error'), /too long for a question/);
  assert.ok((await threadMs()) - cpu < 1000, 'a megabyte question is refused without a long pattern run');

  // ---- The add box: keyboard, suggestions, limits ----
  await page.goto(url + '#p=America/New_York:New%20York,Europe/London:London,Asia/Kolkata:New%20Delhi&t=2026-11-24T10:00&c=24&w=9-17');
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 3);
  await page.click('#tzc-add');
  await page.keyboard.type('Mumb');
  await page.waitForSelector('#tzc-sugg [role="option"]:has-text("Mumbai")');
  assert.equal(await page.getAttribute('#tzc-add', 'aria-expanded'), 'true');
  assert.equal(await page.getAttribute('#tzc-add', 'aria-activedescendant'), 'tzc-opt-0');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  r = await rows();
  assert.deepEqual(r.map(x => x.name), ['New York', 'London', 'New Delhi', 'Mumbai']);
  assert.equal(r[3].time, '20:30');
  assert.equal(await text('#tzc-status'), 'Mumbai added: 20:30, Tue 24 Nov 2026.');
  assert.equal(await page.inputValue('#tzc-add'), '');
  const sugg = async q => { await page.fill('#tzc-add', q); return page.$$eval('#tzc-sugg [data-opt]', ls => ls.map(l => l.firstChild.textContent)); };
  assert.deepEqual((await sugg('EST')).slice(0, 2), ['New York', 'EST (fixed)']);
  assert.deepEqual(await sugg('zurich'), ['Zürich'], 'accents are ignored and the zone is not offered twice');
  assert.deepEqual((await sugg('UTC−3')), ['UTC−03:00']);
  assert.deepEqual((await sugg('united states')).slice(0, 2), ['Washington', 'Los Angeles']);
  assert.ok((await sugg('AoE')).includes('AoE'));
  await page.fill('#tzc-add', 'Qwertyville');
  await page.press('#tzc-add', 'Enter');
  assert.equal(await text('#tzc-add-error'), 'No place matches “Qwertyville”.');
  await describedBy('#tzc-add', 'tzc-add-error');
  await page.keyboard.press('Escape');
  await page.$eval('#tzc-add', el => { el.value = 'x'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.getAttribute('#tzc-add', 'aria-expanded'), 'false', 'a megabyte in the add box searches nothing');
  for (const q of ['Tokyo', 'Sydney', 'Paris', 'Lagos', 'Dubai', 'Kathmandu', 'Honolulu', 'Santiago']) {
    await page.fill('#tzc-add', q);
    await page.press('#tzc-add', 'Enter');
  }
  assert.equal((await rows()).length, 12);
  await page.fill('#tzc-add', 'Lima');
  await page.press('#tzc-add', 'Enter');
  assert.equal(await text('#tzc-add-error'), 'Up to 12 places can be compared. Remove one first.');
  assert.equal((await rows()).length, 12);

  // ---- Row buttons from the keyboard; a double click removes one row only ----
  await page.focus('#tzc-rows li[data-i="1"] button[data-act="first"]');
  await page.keyboard.press('Enter');
  r = await rows();
  assert.deepEqual(r.slice(0, 2).map(x => [x.name, x.time]), [['London', '15:00'], ['New York', '10:00']], 'the moment stays when the first place changes');
  assert.equal(await page.inputValue('#tzc-time'), '15:00');
  // Rows of the same height, so the second click of a double click lands on the next row's button.
  await page.goto(url + '#p=UTC,UTC+01:00,UTC+02:00,UTC+03:00,UTC+04:00&t=2026-11-24T10:00&c=24');
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 5);
  await page.locator('#tzc-rows li[data-i="1"] button[data-act="remove"]').scrollIntoViewIfNeeded();
  const y1 = (await page.locator('#tzc-rows li[data-i="1"] button[data-act="remove"]').boundingBox()).y;
  assert.equal((await page.locator('#tzc-rows li[data-i="2"] .tzc-line').count()), 2);
  await page.dblclick('#tzc-rows li[data-i="1"] button[data-act="remove"]');
  assert.deepEqual((await rows()).map(x => x.name), ['UTC', 'UTC+02:00', 'UTC+03:00', 'UTC+04:00']);
  assert.equal((await page.locator('#tzc-rows li[data-i="1"] button[data-act="remove"]').boundingBox()).y, y1, 'the next row moved up under the pointer');
  assert.match(await page.evaluate(() => location.hash), /^#p=UTC:UTC:Coordinated%20Universal%20Time,UTC\+0200:UTC%2B02%3A00:Fixed%20offset%20from%20UTC,/, 'offsets are kept without a colon');
  await page.reload();
  assert.deepEqual((await rows()).map(x => x.name), ['UTC', 'UTC+02:00', 'UTC+03:00', 'UTC+04:00'], 'fixed offsets come back from the link');
  await page.goto(url + '#p=America/New_York:New%20York,Europe/London:London,Asia/Kolkata:New%20Delhi&t=2026-11-24T10:00&c=24&w=9-17');
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 3);

  // ---- Planner: arrow keys, Home and End, Page Up and Down, a click ----
  assert.equal(await page.getAttribute('#tzc-plan', 'aria-activedescendant'), 'tzc-col-10');
  await page.focus('#tzc-plan');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.inputValue('#tzc-time'), '11:00');
  assert.equal(await page.getAttribute('#tzc-plan', 'aria-activedescendant'), 'tzc-col-11');
  assert.equal(await page.getAttribute('#tzc-now', 'aria-pressed'), 'false');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual([await page.inputValue('#tzc-date'), await page.inputValue('#tzc-time')], ['2026-11-25', '00:00']);
  await page.keyboard.press('PageUp');
  assert.deepEqual([await page.inputValue('#tzc-date'), await page.inputValue('#tzc-time')], ['2026-11-24', '00:00']);
  await page.keyboard.press('Home');
  await page.click('#tzc-col-8');
  assert.equal(await page.inputValue('#tzc-time'), '08:00');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tzc-plan');
  assert.match(await page.locator('#tzc-col-8').textContent(), /08:00 in New York \(morning or evening\);13:00 in London \(working hours\);.*18:30 in New Delhi \(morning or evening\);/);
  const classes = await page.$$eval('#tzc-col-8 .tzc-cell', cs => cs.map(c => c.className.replace('tzc-cell ', '')));
  assert.deepEqual(classes, ['tzc-eve', 'tzc-work', 'tzc-eve']);
  assert.equal(await page.$eval('#tzc-col-3 .tzc-cell:nth-child(1)', c => c.className), 'tzc-cell tzc-night');

  // ---- When everyone can meet (New York's 24 Nov 2026) ----
  assert.deepEqual(E.overlap_work, []);
  assert.match(await text('#tzc-overlap-sum'), /^No time on Tue 24 Nov 2026 falls within everyone’s working hours \(09:00 to 17:00\)\. Times when nobody is in the night/);
  const [a0, a1] = E.overlap_awake[0];
  const runs = await page.$$eval('#tzc-runs li > span', ss => ss.map(s => s.textContent));
  assert.equal(runs.length, 1);
  assert.ok(runs[0].startsWith(`New York ${a0}–${a1} · London 12:00–16:30 · New Delhi 17:30–22:00`), runs[0]);
  await page.click('#tzc-runs button');
  assert.equal(await page.inputValue('#tzc-time'), a0);
  await page.selectOption('#tzc-ws', '17');
  assert.equal(await text('#tzc-work-error'), 'Working hours must end after they start.');
  await describedBy('#tzc-ws', 'tzc-work-error');
  await describedBy('#tzc-we', 'tzc-work-error');
  await page.selectOption('#tzc-ws', '8');
  assert.equal(await page.getAttribute('#tzc-ws', 'aria-invalid'), null);
  assert.match(await page.evaluate(() => location.hash), /&w=8-17$/);
  await page.selectOption('#tzc-ws', '9');

  // ---- A weekly meeting across a year: rows start where a clock change moves a time ----
  await page.goto(url + '#p=America/New_York:New%20York,Europe/London:London,Asia/Kolkata:New%20Delhi&t=2027-03-02T10:00&c=24&w=9-17');
  await page.waitForFunction(() => document.querySelector('#tzc-time').value === '10:00');
  const week = await page.$$eval('#tzc-week tbody tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent)));
  assert.deepEqual(week.map(c => [c[2].replace(' (changed)', ''), c[3].replace(' (changed)', ''), Number(/\((\d+) weeks?\)/.exec(c[0])[1])]),
    E.weekly_runs.map(x => [x.london, x.delhi, x.weeks]));
  assert.equal(week[1][2], '14:00 (changed)');
  assert.equal(await page.$eval('#tzc-week tbody tr:nth-child(2) td:nth-child(3)', td => getComputedStyle(td).fontWeight), '700');
  r = await rows();
  assert.match(r[1].text, /Gap changes: 4 h ahead of New York from Sun 14 Mar 2027 to Sun 28 Mar 2027; 4 h ahead of New York from Sun 31 Oct 2027 to Sun 7 Nov 2027\./);
  assert.deepEqual(E.gap_ny_london.map(g => g[1]), [300, 240, 300, 240, 300]);

  // ---- Calendar file: one event per date in UTC, folded at 75 octets, a double click saves once ----
  await page.selectOption('#tzc-rep', '4');
  const title = 'Équipe ✓ planning 😀 ' + 'x'.repeat(70) + '; a,b';
  await page.fill('#tzc-title', title);
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.dblclick('#tzc-ics');
  await page.waitForTimeout(300);
  assert.equal(downloads.length, 1, 'a double click saves one file');
  assert.equal(downloads[0].suggestedFilename(), 'meeting-2027-03-02.ics');
  const ics = fs.readFileSync(await downloads[0].path(), 'utf8');
  const lines = ics.split('\r\n');
  assert.ok(ics.endsWith('\r\n') && !/[^\r]\n/.test(ics), 'CRLF line ends');
  assert.ok(lines.every(l => Buffer.byteLength(l, 'utf8') <= 75), 'no line over 75 octets');
  const unfolded = ics.replace(/\r\n /g, '').split('\r\n');
  assert.deepEqual(unfolded.filter(l => l.startsWith('DTSTART')), E.weekly.slice(0, 4).map(w => 'DTSTART:' + w.utc));
  assert.deepEqual(unfolded.filter(l => l.startsWith('DTEND')).slice(2, 3), ['DTEND:20270316T150000Z']);
  assert.equal(unfolded.filter(l => l.startsWith('SUMMARY'))[0], 'SUMMARY:' + title.replace(/[;,]/g, c => '\\' + c));
  assert.ok(unfolded.includes('DESCRIPTION:New York: Tue 16 Mar 2027\\, 10:00 (EDT\\, UTC−04:00)\\nLondon: Tue 16 Mar 2027\\, 14:00 (GMT\\, UTC+00:00)\\nNew Delhi: Tue 16 Mar 2027\\, 19:30 (IST\\, UTC+05:30)'));
  assert.equal(unfolded.filter(l => l === 'BEGIN:VEVENT').length, 4);

  // ---- Copy the times and the link; the link brings the same places back ----
  await page.click('#tzc-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
    'Tue 2 Mar 2027\nNew York: 10:00 (EST, UTC−05:00)\nLondon: 15:00 (GMT, UTC+00:00)\nNew Delhi: 20:30 (IST, UTC+05:30)');
  await page.click('#tzc-c12');
  assert.equal((await rows())[0].time, '10:00 am');
  await page.click('#tzc-link');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(link.startsWith(url + '#p='), link);
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 3);
  r = await rows();
  assert.deepEqual(r.map(x => x.name + ' ' + x.time), ['New York 10:00 am', 'London 3:00 pm', 'New Delhi 8:30 pm']);
  assert.equal(await page.isChecked('#tzc-c12'), true);
  // Back to a page restored from the cache: the fields and the rows agree.
  await page.goto('about:blank');
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll('#tzc-rows > li').length === 3);
  assert.equal(await page.inputValue('#tzc-time'), '10:00');
  assert.equal((await rows())[1].time, '3:00 pm');

  // ---- Links that cannot be read ----
  await page.goto(url + '#p=Mars/Olympus_Mons,Europe/Paris:Paris&t=2026-11-24T10:00');
  await page.waitForFunction(() => document.querySelector('#tzc-ask-error').textContent);
  assert.equal(await text('#tzc-ask-error'), '1 place in the link could not be read and was left out.');
  assert.deepEqual((await rows()).map(x => x.name), ['Paris']);
  await page.goto('about:blank');
  await page.goto(url + '#p=' + 'Europe/Paris,'.repeat(300));
  await page.waitForFunction(() => document.querySelector('#tzc-ask-error').textContent);
  assert.match(await text('#tzc-ask-error'), /too long to read \(over 3,000 characters\)/);
  assert.equal((await rows())[0].name, 'Rome');

  // ---- Date and time fields ----
  await page.check('#tzc-c24');
  await page.fill('#tzc-date', '');
  assert.equal(await text('#tzc-when-error'), 'Pick a date.');
  await describedBy('#tzc-date', 'tzc-when-error');
  await page.fill('#tzc-date', '2027-03-14');
  await page.fill('#tzc-time', '02:30');
  assert.equal(await page.getAttribute('#tzc-date', 'aria-invalid'), null);
  assert.equal(await text('#tzc-when-error'), '');
  r = await rows();
  assert.deepEqual([r[0].time, r[1].time, r[1].date], ['02:30', '20:30', 'Sat 13 Mar 2027'], '02:30 in Rome (UTC+1) is 20:30 the day before in New York (UTC-5)');
  assert.ok(r[1].tags.includes('previous day'));
  await page.click('#tzc-now');
  assert.equal(await page.getAttribute('#tzc-now', 'aria-pressed'), 'true');
  assert.equal(await page.inputValue('#tzc-date'), '2026-11-24');

  // ---- On a phone, with touch ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'], timezoneId: 'Asia/Kolkata' });
  const tp = await phone.newPage();
  const errors = [];
  tp.on('pageerror', e => errors.push(e.message));
  await tp.goto(url);
  assert.deepEqual(await tp.$$eval('#tzc-rows .tzc-name', ns => ns.map(n => n.textContent)), ['New Delhi', 'New York', 'London'], 'the device zone joins the defaults once');
  assert.ok(await tp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
  const box = await tp.locator('#tzc-plan-wrap').boundingBox();
  assert.ok(box.width <= 412, 'the planner scrolls inside its own box');
  await tp.locator('#tzc-col-2').tap();
  assert.equal(await tp.inputValue('#tzc-time'), '02:00');
  assert.ok((await tp.locator('#tzc-col-2').boundingBox()).width >= 44, 'planner columns are 44 px wide on touch screens');
  await tp.locator('#tzc-add').tap();
  await tp.locator('#tzc-add').fill('São');
  await tp.locator('#tzc-sugg [role="option"]:has-text("São Paulo")').first().tap();
  assert.deepEqual(await tp.$$eval('#tzc-rows .tzc-name', ns => ns.map(n => n.textContent)), ['New Delhi', 'New York', 'London', 'São Paulo']);
  assert.ok(parseFloat(await tp.$eval('#tzc-add', el => getComputedStyle(el).fontSize)) >= 16);
  assert.deepEqual(errors, []);
  await phone.close();
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
