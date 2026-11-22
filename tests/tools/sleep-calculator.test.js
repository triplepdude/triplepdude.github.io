// Expected times come from tests/fixtures/sleep-calculator/expected.json, written by
// expected.py next to it with Python's datetime and zoneinfo, in real elapsed time.
// Nothing is read back from the page. Hours per age group are the CDC's table of
// 15 May 2024; the guide's worked example is checked against the same fixture.
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const cdp = await page.context().newCDPSession(page);
  const zone = tz => cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz });
  const text = sel => page.locator(sel).textContent();
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  // The message a field points at, and whether the field is marked invalid.
  const aria = sel => page.$eval(sel, el => [el.getAttribute('aria-describedby'), el.getAttribute('aria-invalid')]);
  const read = () => page.evaluate(() => {
    const t = id => document.getElementById(id).textContent;
    return {
      head: t('sl-head'), sub: t('sl-sub'), dst: t('sl-dst'), win: t('sl-window'), listHead: t('sl-list-head'), note: t('sl-cnote'), nowLine: t('sl-now-line'),
      rows: [...document.querySelectorAll('#sl-list li')].map(li => ({
        key: li.querySelector('.sl-key').firstChild.textContent, tag: (li.querySelector('.sl-key small') || {}).textContent || '',
        dur: li.querySelector('.sl-dur').textContent, more: li.querySelector('.sl-more').textContent,
        flag: (li.querySelector('.sl-flag') || {}).textContent || '', short: li.classList.contains('is-short'), passed: li.classList.contains('is-passed'),
      })),
      copy: document.getElementById('sl-copy').disabled,
    };
  });
  const hm = min => {
    const h = Math.floor(min / 60), m = min % 60, out = [];
    if (h) out.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m || !h) out.push(m + (m === 1 ? ' minute' : ' minutes'));
    return out.join(' ');
  };
  const pad = n => String(n).padStart(2, '0');
  const hhmm = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const ampm = min => { const h = Math.floor(min / 60); return `${(h % 12) || 12}:${pad(min % 60)} ${h < 12 ? 'AM' : 'PM'}`; };
  // CDC, 15 May 2024: hours a day, and whether naps count.
  const GROUP = {
    n0: ['babies of 0 to 3 months', 14, 17, true], m4: ['babies of 4 to 12 months', 12, 16, true], y1: ['children of 1 to 2', 11, 14, true],
    y3: ['children of 3 to 5', 10, 13, true], y6: ['children of 6 to 12', 9, 12, false], y13: ['teenagers of 13 to 17', 8, 10, false],
    a18: ['adults of 18 to 60', 7, 0, false], a61: ['adults of 61 to 64', 7, 9, false], a65: ['adults of 65 and older', 7, 8, false],
  };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const span = (a, b) => a % 60 || b % 60 ? `${hm(a)} to ${hm(b)}` : `${a / 60} to ${b / 60} hours`;
  function windowText(c) {
    const [who, lo, hi, naps] = GROUP[c.age], need = hi ? `${lo} to ${hi} hours` : `${lo} hours or more`;
    if (c.age === 'n0') return `${cap(who)} need ${need} in 24 hours (CDC). Sleep patterns vary widely at this age (NHLBI), so there is no bedtime to work out.`;
    let t = `${cap(who)} need ${need}${naps ? ' in 24 hours, naps included' : ''} (CDC).`;
    if (naps) t += c.naps ? ` With ${hm(c.naps)} of naps, that leaves ${span(lo * 60 - c.naps, hi * 60 - c.naps)} at night.` : ' With no naps, all of it is at night.';
    const w = c.window;
    if (c.mode === 'wake') return t + (w.a1 ? ` Be asleep between ${w.a1} and ${w.a2}, so in bed between ${w.b1} and ${w.b2}.` : ` Be asleep by ${w.a2}, so in bed by ${w.b2}.`);
    if (!w.w2) return `${t} Wake up at ${w.w1} or later.`;
    const both = / next day$/.test(w.w1) && / next day$/.test(w.w2);
    return `${t} Wake up between ${both ? w.w1.replace(/ next day$/, '') : w.w1} and ${w.w2}.`;
  }
  const flagText = age => `Under ${GROUP[age][1]} hours, the minimum for ${GROUP[age][0]}`;
  function check(r, c) {
    const label = c.name;
    const head = c.age === 'n0' ? 'Sleep for babies of 0 to 3 months' : c.mode === 'wake' ? `Bedtimes for waking up at ${c.anchor}`
      : c.mode === 'bed' ? `Wake-up times for going to bed at ${c.anchor}` : 'Wake-up times for going to bed now';
    assert.equal(r.head, head, `heading, ${label}`);
    if (c.mode === 'wake') assert.ok(r.sub.startsWith(`Waking up on ${c.anchorDay}.`), `${label}: ${r.sub}`);
    else if (c.mode === 'bed') assert.ok(r.sub.startsWith(`Bedtime on ${c.anchorDay}.`), `${label}: ${r.sub}`);
    else {
      // The time is in the line under the menu, and the summary does not repeat it.
      assert.equal(r.nowLine, `It is ${c.anchor} on ${c.anchorDay}.`, label);
      assert.ok(r.sub.startsWith('Allowing '), `${label}: ${r.sub}`);
    }
    if (c.mode !== 'wake' && c.age !== 'n0') assert.ok(r.sub.includes(`, you will be asleep by ${c.asleep}.`), `${label}: ${r.sub}`);
    assert.equal(r.sub.includes('because the clocks go forward'), !!c.gap, `gap note, ${label}`);
    assert.equal(r.win, windowText(c), `hours window, ${label}`);
    const twice = c.dst && c.dst.twice ? ` From ${c.dst.twice.from} to ${c.dst.twice.to} each clock time comes twice, so a time in that hour names its zone: ${c.dst.twice.zones[0]} before the change, ${c.dst.twice.zones[1]} after.` : '';
    assert.equal(r.dst, c.dst ? `The clocks go ${c.dst.shift > 0 ? 'forward' : 'back'} ${hm(Math.abs(c.dst.shift))} at ${c.dst.before} on ${c.dst.day}. These times allow for it, so each gives the full sleep shown.${twice}` : '', `clock change, ${label}`);
    assert.equal(r.rows.length, c.rows.length, `number of options, ${label}`);
    c.rows.forEach((e, i) => {
      const got = r.rows[i];
      assert.equal(got.key, e.key, `option ${i + 1} time, ${label}`);
      assert.equal(got.tag, e.tag, `option ${i + 1} label, ${label}`);
      assert.equal(got.dur, `${hm(e.sleep)} of sleep, ${e.n} cycles`, `option ${i + 1} sleep, ${label}`);
      assert.equal(got.more, c.mode === 'wake' ? `Asleep by ${e.asleep}, up at ${e.wake}` : `In bed ${e.bed}, asleep by ${e.asleep}`, `option ${i + 1} details, ${label}`);
      assert.equal(got.flag, e.short ? flagText(c.age) : '', `option ${i + 1} flag, ${label}`);
      assert.deepEqual([got.short, got.passed], [e.short, e.passed], `option ${i + 1} state, ${label}`);
    });
  }
  const hashOf = c => '#' + [c.mode === 'now' ? 'now' : `${c.mode}=${hhmm(c.time)}`].concat(c.fall !== 15 ? [`fall=${c.fall}`] : [], c.cycle !== 90 ? [`cycle=${c.cycle}`] : [],
    c.age !== 'a18' ? [`age=${c.age}`] : [], c.naps ? [`naps=${c.naps}`] : []).join('&');
  const reload = async (hash = '') => { await page.goto('about:blank'); await page.goto(url + hash, { waitUntil: 'load' }); };

  await zone('America/New_York');
  await page.clock.install({ time: new Date(data.cases[0].now) });
  await open();

  // ---- The page opens with an example: waking at 6:30 AM, an adult, nothing in the address ----
  assert.equal(await page.isChecked('input[name="sl-mode"][value="wake"]'), true);
  assert.equal(await page.inputValue('#sl-wake'), '6:30 AM');
  assert.equal(await text('#sl-wake-read'), 'Read as 6:30 AM.');
  assert.equal(await page.inputValue('#sl-age'), 'a18');
  assert.equal(await page.inputValue('#sl-clock'), '12');
  check(await read(), data.cases[0]);
  assert.equal(await page.evaluate(() => location.hash), '', 'a first visit leaves the address alone');
  // The guide's worked example is the first case.
  const table = await page.$$eval('.prose table', ts => ts[0].innerText.split('\n').map(l => l.split('\t').map(c => c.trim()).join('|')));
  assert.deepEqual(table.slice(1), data.cases[0].rows.map(r => `${r.n}|${hm(r.sleep)}|${r.bed}|${r.asleep.replace(/ next day$/, '')}`));

  // ---- Known answers, some typed and some from a link ----
  for (const [i, c] of data.cases.entries()) {
    await zone(c.tz);
    await page.clock.setSystemTime(new Date(c.now));
    if (i % 2) {
      await reload(hashOf(c));
    } else {
      await reload();
      await page.check(`input[name="sl-mode"][value="${c.mode}"]`);
      if (c.mode !== 'now') await page.fill(`#sl-${c.mode}`, c.h12 ? ampm(c.time) : hhmm(c.time));
      await page.fill('#sl-fall', String(c.fall));
      await page.selectOption('#sl-age', c.age);
      if (GROUP[c.age][3]) { if (c.age !== 'n0') await page.selectOption('#sl-naps', String(c.naps)); } else await page.fill('#sl-cycle', String(c.cycle));
    }
    if (!c.h12) await page.selectOption('#sl-clock', '24');
    check(await read(), c);
    assert.equal(await page.isVisible('#sl-cycle-field'), !GROUP[c.age][3], `cycle box, ${c.name}`);
    assert.equal(await page.isVisible('#sl-naps-field'), GROUP[c.age][3] && c.age !== 'n0', `naps box, ${c.name}`);
    if (i % 2 === 0) assert.equal(await page.evaluate(() => location.hash), hashOf(c), `address after typing, ${c.name}`);
  }
  // Under 6 the page plans by hours only, and says why.
  await zone('America/Los_Angeles');
  await page.clock.setSystemTime(new Date('2026-11-22T12:00:00-08:00'));
  await reload('#wake=07:00&age=y3&naps=60');
  assert.equal(await text('#sl-cnote'), 'Under 6, the page plans by hours only: naps count towards the total, and a baby\'s sleep cycle is about 50 minutes at 3 months (Institute of Medicine).');
  assert.equal(await text('#sl-list-head'), '');
  await page.selectOption('#sl-age', 'y6');
  assert.equal(await text('#sl-cnote'), 'The cycle lengths on this page come from studies of adults, so for children aim for the hours above.');
  assert.equal(await text('#sl-list-head'), 'Or go to bed so that you wake up at the end of a cycle:');

  // ---- Reading typed times: a bare bedtime on a 12-hour clock is night from 6 to 12 ----
  await zone('America/New_York');
  await page.clock.setSystemTime(new Date(data.cases[0].now));
  await reload();
  await page.check('input[name="sl-mode"][value="bed"]');
  const bedReads = [['11', '11:00 PM'], ['12', '12:00 AM (midnight)'], ['12:30', '12:30 AM'], ['5', '5:00 AM'], ['6', '6:00 PM'], ['10:45', '10:45 PM'],
    ['06:30', '6:30 AM'], ['630a', '6:30 AM'], ['1830', '6:30 PM'], ['11.30 p.m.', '11:30 PM'], ['9h30', '9:30 PM'], ['noon', '12:00 PM (noon)'],
    ['Midnight', '12:00 AM (midnight)'], ['24:00', '12:00 AM (midnight)'], ['0:15', '12:15 AM'], ['２３：１５', '11:15 PM'], ['٢٣:١٥', '11:15 PM'], ['۲۳:۱۵', '11:15 PM'], ['२३:१५', '11:15 PM'], ['  10 pm ', '10:00 PM'],
    ['22:30:00', '10:30 PM'], ['12 am', '12:00 AM (midnight)'], ['12p', '12:00 PM (noon)']];
  for (const [typed, want] of bedReads) {
    await page.fill('#sl-bed', typed);
    assert.equal(await text('#sl-bed-read'), `Read as ${want}.`, `bedtime "${typed}"`);
  }
  await page.fill('#sl-bed', '11');
  assert.equal(await text('#sl-head'), 'Wake-up times for going to bed at 11:00 PM');
  await page.check('input[name="sl-mode"][value="wake"]');
  for (const [typed, want] of [['12', '12:00 PM (noon)'], ['7', '7:00 AM'], ['6:30 pm', '6:30 PM'], ['0630', '6:30 AM'], ['11', '11:00 AM']]) {
    await page.fill('#sl-wake', typed);
    assert.equal(await text('#sl-wake-read'), `Read as ${want}.`, `wake-up time "${typed}"`);
  }
  // On a 24-hour clock nothing is guessed, and switching clocks keeps what a time meant.
  await page.fill('#sl-wake', '6:30 AM');
  await page.check('input[name="sl-mode"][value="bed"]');
  await page.fill('#sl-bed', '11');
  await page.selectOption('#sl-clock', '24');
  assert.deepEqual([await page.inputValue('#sl-bed'), await page.inputValue('#sl-wake'), await text('#sl-bed-read')], ['23:00', '06:30', 'Read as 23:00.']);
  assert.equal(await text('#sl-head'), 'Wake-up times for going to bed at 23:00');
  await page.fill('#sl-bed', '11');
  assert.equal(await text('#sl-bed-read'), 'Read as 11:00.');
  await page.selectOption('#sl-clock', '12');
  assert.deepEqual([await page.inputValue('#sl-bed'), await text('#sl-bed-read')], ['11:00 AM', 'Read as 11:00 AM.']);

  // ---- Errors: shown once typing pauses or the box is left, the box marked, no stale times ----
  await reload();
  await page.fill('#sl-wake', '6:');
  let r = await read();
  assert.deepEqual([await text('#sl-wake-msg'), await page.getAttribute('#sl-wake', 'aria-invalid'), r.sub, r.rows.length, r.copy], ['', null, 'Finish typing to see the times.', 0, true]);
  await page.clock.runFor(1000);
  assert.equal(await text('#sl-wake-msg'), 'Type a time such as 6:30 AM, 630a or 18:30.');
  assert.deepEqual(await aria('#sl-wake'), ['sl-wake-read sl-wake-msg', 'true']);
  r = await read();
  assert.deepEqual([r.head, r.sub, r.win, r.rows.length, r.copy], ['Bedtimes', 'Correct the box marked in red to see the times.', '', 0, true]);
  await page.clock.runFor(800);
  assert.equal(await text('#sl-status'), 'Type a time such as 6:30 AM, 630a or 18:30.');
  for (const bad of ['25:00', '6:60', '13 pm', '0 pm', 'abc', '6:30:15', '1:2', '6:30 am pm', '6:3⁰', '6:30\t7:00']) {
    await page.fill('#sl-wake', bad);
    await page.press('#sl-wake', 'Enter');
    assert.equal(await text('#sl-wake-msg'), 'Type a time such as 6:30 AM, 630a or 18:30.', `"${bad}" is not a time`);
  }
  await page.fill('#sl-wake', '7:15');
  assert.deepEqual([await text('#sl-wake-msg'), await page.getAttribute('#sl-wake', 'aria-invalid'), await text('#sl-head')], ['', null, 'Bedtimes for waking up at 7:15 AM']);
  // Leaving the box shows the message at once.
  await page.fill('#sl-fall', '200');
  assert.equal(await text('#sl-fall-msg'), '');
  await page.locator('#sl-fall').blur();
  assert.equal(await text('#sl-fall-msg'), 'Enter whole minutes from 0 to 120.');
  assert.deepEqual(await aria('#sl-fall'), ['sl-fall-msg', 'true']);
  // The limits themselves are allowed: 0 to 120 minutes to fall asleep, cycles of 70 to 120.
  for (const [id, v, ok] of [['#sl-fall', '120', true], ['#sl-fall', '0', true], ['#sl-fall', '121', false], ['#sl-cycle', '70', true], ['#sl-cycle', '120', true], ['#sl-cycle', '69', false]]) {
    await page.fill(id, v);
    await page.press(id, 'Enter');
    assert.equal(await page.getAttribute(id, 'aria-invalid'), ok ? null : 'true', `${id} ${v}`);
  }
  await page.fill('#sl-cycle', '90');
  await page.fill('#sl-fall', '20 min');
  assert.deepEqual([await text('#sl-fall-msg'), await page.getAttribute('#sl-fall', 'aria-invalid')], ['', null]);
  assert.match(await text('#sl-sub'), /allows 20 minutes to fall asleep/);
  for (const bad of ['60', '121', '9.5', '-90', '90 hours', '9⁰']) {
    await page.fill('#sl-cycle', bad);
    await page.press('#sl-cycle', 'Enter');
    assert.equal(await text('#sl-cycle-msg'), 'Enter whole minutes from 70 to 120.', `cycle "${bad}"`);
    assert.deepEqual(await aria('#sl-cycle'), ['sl-cycle-msg', 'true']);
  }
  // A cycle length is not used under 6, so its error goes away with it.
  await page.selectOption('#sl-age', 'y1');
  assert.deepEqual([await text('#sl-cycle-msg'), await page.isVisible('#sl-cycle-field')], ['', false]);
  assert.match(await text('#sl-window'), /^Children of 1 to 2 need 11 to 14 hours in 24 hours, naps included \(CDC\)\. With no naps, all of it is at night\. Be asleep between /);
  await page.selectOption('#sl-age', 'a18');
  await page.fill('#sl-cycle', '١٠٠'); // Arabic-Indic digits
  assert.deepEqual([await text('#sl-cycle-msg'), (await read()).rows[0].dur], ['', '10 hours of sleep, 6 cycles']);

  // ---- A megabyte pasted into each box is refused at once, without freezing the page ----
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  await cdp.send('Performance.enable');
  for (const id of ['sl-wake', 'sl-fall', 'sl-cycle', 'sl-bed']) {
    if (id === 'sl-bed') await page.check('input[name="sl-mode"][value="bed"]');
    const t0 = await threadMs();
    await page.$eval('#' + id, el => { el.value = '1'.repeat(1 << 20) + ':30'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    const spent = await threadMs() - t0;
    assert.ok(spent < 1500, `a megabyte in #${id} took ${Math.round(spent)} ms of main-thread time`);
    assert.equal(await page.getAttribute('#' + id, 'aria-invalid'), 'true', `#${id} is marked`);
    if (id === 'sl-wake' || id === 'sl-bed') assert.match(await text(`#${id}-msg`), /^That is too long for a time\./);
    assert.ok((await page.evaluate(() => location.href)).length < 300, 'the address stays short');
    await page.fill('#' + id, { 'sl-wake': '6:30', 'sl-fall': '15', 'sl-cycle': '90', 'sl-bed': '11' }[id]);
  }

  // ---- Steps of 15 minutes, by button and by arrow key, to the next quarter hour ----
  await reload();
  await page.fill('#sl-wake', '6:32');
  await page.click('#sl-wake-field [data-step="15"]');
  assert.equal(await page.inputValue('#sl-wake'), '6:45 AM');
  await page.click('#sl-wake-field [data-step="-15"]');
  await page.click('#sl-wake-field [data-step="-15"]');
  assert.equal(await page.inputValue('#sl-wake'), '6:15 AM');
  await page.fill('#sl-wake', '12:05 AM');
  await page.press('#sl-wake', 'ArrowDown');
  assert.equal(await page.inputValue('#sl-wake'), '12:00 AM');
  await page.press('#sl-wake', 'ArrowDown');
  assert.equal(await page.inputValue('#sl-wake'), '11:45 PM');
  await page.press('#sl-wake', 'ArrowUp');
  await page.press('#sl-wake', 'ArrowUp');
  assert.deepEqual([await page.inputValue('#sl-wake'), await text('#sl-head')], ['12:15 AM', 'Bedtimes for waking up at 12:15 AM']);
  await page.clock.runFor(100);
  assert.match(await text('#sl-status'), /^Bedtimes to wake up at 12:15 AM: /, 'a step is announced at once');

  // ---- Copy, the address and Copy link ----
  await reload();
  await page.click('#sl-copy');
  const c0 = data.cases[0];
  assert.equal(await clipboard(), [
    `Bedtimes for waking up at 6:30 AM (waking up on ${c0.anchorDay})`,
    windowText(c0),
    ...c0.rows.map(e => `- In bed ${e.bed}, asleep by ${e.asleep}: ${hm(e.sleep)} of sleep, ${e.n} cycles${e.short ? ' (under 7 hours, the minimum for adults of 18 to 60)' : ''}`),
    'Allowing 15 minutes to fall asleep and 90-minute cycles. Times rounded to the nearest 5 minutes.',
  ].join('\n'));
  await page.check('input[name="sl-mode"][value="bed"]');
  await page.fill('#sl-bed', '11');
  await page.fill('#sl-fall', '20');
  await page.selectOption('#sl-age', 'y13');
  assert.equal(await page.evaluate(() => location.hash), '#bed=23:00&fall=20&age=y13');
  await page.click('#sl-link');
  assert.equal(await clipboard(), `${url}#bed=23:00&fall=20&age=y13`);
  // Copy brings the times up to date first: the box was changed without an input event.
  await page.$eval('#sl-bed', el => { el.value = '10:30 PM'; });
  await page.click('#sl-copy');
  assert.match(await clipboard(), /^Wake-up times for going to bed at 10:30 PM /);
  // The link opens the same page, and the status line names the times.
  await reload('#bed=23:00&fall=20&age=y13');
  assert.deepEqual([await page.isChecked('input[value="bed"]'), await page.inputValue('#sl-bed'), await page.inputValue('#sl-fall'), await page.inputValue('#sl-age')], [true, '11:00 PM', '20', 'y13']);
  await page.selectOption('#sl-age', 'a18');
  await page.clock.runFor(100);
  assert.equal(await text('#sl-status'), 'Wake-up times: 8:20 AM next day, 6:50 AM next day, 5:20 AM next day or 3:50 AM next day. Adults of 18 to 60 need 7 hours or more (CDC). Wake up at 6:20 AM next day or later.');
  // Links that are wrong, or that name what a plain object would answer to, change nothing.
  for (const h of ['#wake=25:00', '#wake=6:30', '#wake=06:30&age=constructor', '#wake=06:30&age=__proto__&naps=toString', '#bed=' + '1'.repeat(5000), '#fall=20']) {
    await reload(h);
    assert.deepEqual([await page.$eval('input[name="sl-mode"]:checked', e => e.value), await page.inputValue('#sl-wake'), await page.inputValue('#sl-age')], ['wake', '6:30 AM', 'a18'], h.slice(0, 40));
    assert.equal((await read()).rows.length, 4, h.slice(0, 40));
  }
  await reload('#now&age=y3&naps=90');
  assert.deepEqual([await page.isChecked('input[value="now"]'), await page.inputValue('#sl-naps'), await page.isVisible('#sl-now-line')], [true, '90', true]);
  // Typing a new address in the bar is followed.
  await page.evaluate(() => { location.hash = '#wake=05:45'; });
  await page.waitForFunction(() => document.querySelector('#sl-head').textContent === 'Bedtimes for waking up at 5:45 AM');

  // ---- "Now" moves on: every minute, and when the page is shown again ----
  await zone('America/New_York');
  await page.clock.setSystemTime(new Date('2026-11-22T22:47:10-05:00'));
  await reload('#now');
  assert.equal(await text('#sl-now-line'), 'It is 10:47 PM on Sunday, November 22.');
  assert.equal((await read()).rows[0].key, '8:00 AM'); // 10:47 + 15 = 11:02, rounded 11:00, + 9 h
  assert.equal(await text('#sl-sub'), 'Allowing 15 minutes to fall asleep, you will be asleep by 11:00 PM.');
  await page.click('#sl-copy');
  assert.equal((await clipboard()).split('\n')[0], 'Wake-up times for going to bed now (at 10:47 PM on Sunday, November 22)');
  await page.clock.runFor(3 * 60000);
  assert.equal(await text('#sl-now-line'), 'It is 10:50 PM on Sunday, November 22.');
  assert.equal((await read()).rows[0].key, '8:05 AM');
  await page.clock.setSystemTime(new Date('2026-11-23T01:10:20-05:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await text('#sl-now-line'), 'It is 1:10 AM on Monday, November 23.');
  assert.equal((await read()).rows[3].key, '5:55 AM');
  // Fields put back by the browser after the Back button are counted again.
  await reload();
  await page.$eval('#sl-wake', el => { el.value = '8:00 AM'; window.dispatchEvent(new Event('pageshow')); });
  assert.equal(await text('#sl-head'), 'Bedtimes for waking up at 8:00 AM');
  // Back from another page: the browser puts back the clock menu but not the
  // time boxes, which the address fills in; the boxes follow the menu.
  await reload();
  await page.check('input[value="bed"]');
  await page.fill('#sl-bed', '11');
  await page.selectOption('#sl-clock', '24');
  assert.equal(await page.evaluate(() => location.hash), '#bed=23:00');
  await page.goto(base + '/');
  await page.goBack({ waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('sl-head').textContent !== '');
  const back = await page.evaluate(() => [document.getElementById('sl-clock').value, document.getElementById('sl-bed').value, document.getElementById('sl-head').textContent]);
  assert.deepEqual(back.slice(1), back[0] === '24' ? ['23:00', 'Wake-up times for going to bed at 23:00'] : ['11:00 PM', 'Wake-up times for going to bed at 11:00 PM'], back.join(' | '));
  await page.selectOption('#sl-clock', back[0] === '24' ? '12' : '24');
  assert.equal(await page.inputValue('#sl-bed'), back[0] === '24' ? '11:00 PM' : '23:00', 'a bedtime keeps its meaning when the clock changes after Back');

  // ---- Keyboard only ----
  await reload();
  await page.focus('input[name="sl-mode"][value="wake"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.isChecked('input[value="bed"]'), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sl-bed');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('1115p');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space'); // +15 min
  assert.equal(await page.inputValue('#sl-bed'), '11:30 PM');
  assert.equal(await text('#sl-head'), 'Wake-up times for going to bed at 11:30 PM');
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(ring, 'solid', 'the focused button shows a focus ring');

  // ---- The FAQ ends with privacy ----
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(/stored or sent/i.test(faqs[faqs.length - 1]), faqs.join(' | '));
  assert.ok(faqs.some(q => /7\.5 hours/.test(q)));

  const browser = page.context().browser();
  // ---- A British browser: 24-hour clock, day before month ----
  const gb = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1280, height: 900 } });
  const gbPage = await gb.newPage();
  await gbPage.clock.install({ time: new Date('2026-11-22T20:00:00Z') });
  await gbPage.goto(url, { waitUntil: 'load' });
  assert.deepEqual([await gbPage.inputValue('#sl-clock'), await gbPage.inputValue('#sl-wake'), await gbPage.locator('#sl-sub').textContent()],
    ['24', '06:30', 'Waking up on Monday 23 November. Each bedtime allows 15 minutes to fall asleep.']);
  await gbPage.check('input[value="bed"]');
  await gbPage.fill('#sl-bed', '11');
  assert.equal(await gbPage.locator('#sl-bed-read').textContent(), 'Read as 11:00.');
  // The night the clocks go back: the hour that comes twice is told apart as BST and GMT.
  await gbPage.clock.setSystemTime(new Date('2026-10-24T19:00:00+01:00'));
  await gbPage.goto(url + '#wake=06:30', { waitUntil: 'load' });
  assert.deepEqual(await gbPage.$$eval('#sl-list .sl-key', ks => ks.map(k => k.firstChild.textContent)), ['22:15', '23:45', '01:15 BST', '01:45 GMT']);
  assert.equal(await gbPage.locator('#sl-dst').textContent(), 'The clocks go back 1 hour at 02:00 on Sunday 25 October. These times allow for it, so each gives the full sleep shown. ' +
    'From 01:00 to 01:59 each clock time comes twice, so a time in that hour names its zone: BST before the change, GMT after.');
  await gb.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'America/New_York' });
  const p = await phone.newPage();
  await p.clock.install({ time: new Date(data.cases[0].now) });
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('text=Go to bed at a set time');
  assert.equal(await p.isVisible('#sl-bed'), true);
  await p.tap('#sl-bed');
  await p.fill('#sl-bed', '10');
  await p.tap('#sl-bed-field [data-step="15"]');
  assert.equal(await p.inputValue('#sl-bed'), '10:15 PM');
  assert.equal(await p.locator('#sl-head').textContent(), 'Wake-up times for going to bed at 10:15 PM');
  assert.equal(await p.locator('#sl-list li .sl-key').first().evaluate(e => e.firstChild.textContent), '7:30 AM');
  const sizes = await p.$$eval('.sl input:not([type="radio"]), .sl select, .sl button, .sl .check', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id || e.textContent.trim(), h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), field: e.matches('input, select'),
  })));
  assert.ok(sizes.length >= 12, `found ${sizes.length} controls`);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px type`);
  }
  // Menu choices and button labels fit at every common phone width.
  await p.selectOption('#sl-age', 'y3');
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p.setViewportSize({ width, height: 800 });
    const cut = await p.evaluate(() => {
      const c = document.createElement('canvas').getContext('2d'), out = [];
      for (const s of document.querySelectorAll('.sl select')) {
        if (!s.offsetParent) continue;
        const cs = getComputedStyle(s);
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 28;
        for (const o of s.options) if (c.measureText(o.textContent).width > room) out.push(`${s.id}: ${o.textContent}`);
      }
      for (const b of document.querySelectorAll('.sl button')) if (b.offsetParent && b.scrollWidth > b.clientWidth + 1) out.push(b.textContent);
      return out;
    });
    assert.deepEqual(cut, [], `cut off at ${width}px`);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll at ${width}px`);
  }
  await phone.close();
};
