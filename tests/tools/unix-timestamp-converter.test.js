// Known answers were computed independently with Python
// (datetime.fromtimestamp(..., timezone.utc) and zoneinfo), not copied from
// the page. The browser runs in Europe/Rome with a fixed clock.
module.exports = async ({ page, open, assert, url }) => {
  const text = sel => page.locator(sel).textContent();
  const r = id => text('#ut-r-' + id);
  const conv = async (value, unit = 'auto') => {
    await page.selectOption('#ut-unit', unit);
    await page.fill('#ut-ts', value);
  };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' });
  await page.clock.install({ time: new Date('2026-09-24T00:00:00Z') }); // 1790208000
  await open();

  // Live clock, in seconds and milliseconds.
  const s0 = Number(await text('#ut-now-s'));
  const ms0 = Number(await text('#ut-now-ms'));
  assert.ok(s0 >= 1790208000 && s0 < 1790208010, `current seconds ${s0}`);
  assert.ok(ms0 >= 1790208000000 && ms0 < 1790208010000, `current ms ${ms0}`);
  await page.clock.runFor(5000);
  const s1 = Number(await text('#ut-now-s'));
  assert.ok(s1 >= s0 + 5 && s1 < s0 + 10, `clock ticks: ${s0} -> ${s1}`);
  const def = Number(await page.inputValue('#ut-ts'));
  assert.ok(def >= 1790208000 && def < 1790208010, 'defaults to the current time');
  assert.match(await text('#ut-detected'), /seconds/);

  // Epoch zero.
  await conv('0');
  assert.equal(await r('iso'), '1970-01-01T00:00:00Z');
  assert.equal(await r('isolocal'), '1970-01-01T01:00:00+01:00');
  assert.equal(await r('rfc2822'), 'Thu, 01 Jan 1970 00:00:00 +0000');
  assert.equal(await r('http'), 'Thu, 01 Jan 1970 00:00:00 GMT');
  assert.match(await r('utc'), /Thursday, January 1, 1970.*12:00:00 AM UTC/);

  // 1e9 seconds, in several spellings.
  for (const v of ['1000000000', '1e9', '1,000,000,000', ' 1_000_000_000 ']) {
    await conv(v);
    assert.equal(await r('iso'), '2001-09-09T01:46:40Z', `input ${v}`);
  }
  assert.equal(await r('isolocal'), '2001-09-09T03:46:40+02:00');
  assert.equal(await r('http'), 'Sun, 09 Sep 2001 01:46:40 GMT');
  assert.equal(await r('rfc2822'), 'Sun, 09 Sep 2001 01:46:40 +0000');
  assert.match(await r('local'), /Sunday, September 9, 2001.*3:46:40 AM GMT\+2/);
  assert.equal(await r('rel'), '25 years ago (9,145 days)');
  assert.equal(await r('ms'), '1000000000000');
  assert.equal(await r('us'), '1000000000000000');
  assert.equal(await r('ns'), '1000000000000000000');
  assert.equal(await text('#ut-note'), '');

  // Another zone for the local rows (Nepal is UTC+05:45).
  await page.selectOption('#ut-view-zone', 'Asia/Kathmandu');
  assert.equal(await r('isolocal'), '2001-09-09T07:31:40+05:45');
  await page.selectOption('#ut-view-zone', 'Europe/Rome');

  // The 32-bit limit and its neighbours.
  await conv('2147483647');
  assert.equal(await r('iso'), '2038-01-19T03:14:07Z');
  assert.match(await text('#ut-note'), /largest value a signed 32-bit/);
  assert.match(await r('rel'), /^in 11 years/);
  await conv('2147483648');
  assert.equal(await r('iso'), '2038-01-19T03:14:08Z');
  assert.match(await text('#ut-note'), /Year 2038 problem/);
  await conv('-2147483648');
  assert.equal(await r('iso'), '1901-12-13T20:45:52Z');
  await conv('-2147483649');
  assert.match(await text('#ut-note'), /below the signed 32-bit range/);

  // Negative timestamps.
  await conv('-1');
  assert.equal(await r('iso'), '1969-12-31T23:59:59Z');
  assert.equal(await r('rfc2822'), 'Wed, 31 Dec 1969 23:59:59 +0000');
  assert.match(await text('#ut-note'), /before the Unix epoch/);
  await conv('-14182940');
  assert.equal(await r('iso'), '1969-07-20T20:17:40Z');
  await conv('-1.5');
  assert.equal(await r('iso'), '1969-12-31T23:59:58.500Z');
  assert.equal(await r('ms'), '-1500');

  // Unit detection by magnitude, with exact sub-second digits.
  await conv('1700000000000');
  assert.match(await text('#ut-detected'), /milliseconds/);
  assert.equal(await r('iso'), '2023-11-14T22:13:20Z');
  assert.equal(await r('s'), '1700000000');
  await conv('1700000000123');
  assert.equal(await r('iso'), '2023-11-14T22:13:20.123Z');
  assert.equal(await r('s'), '1700000000.123');
  await conv('1700000000123456');
  assert.match(await text('#ut-detected'), /microseconds/);
  assert.equal(await r('iso'), '2023-11-14T22:13:20.123456Z');
  await conv('1700000000123456789');
  assert.match(await text('#ut-detected'), /nanoseconds/);
  assert.equal(await r('iso'), '2023-11-14T22:13:20.123456789Z');
  assert.equal(await r('s'), '1700000000.123456789');
  assert.equal(await r('ms'), '1700000000123.456789');
  await conv('1700000000.5');
  assert.equal(await r('iso'), '2023-11-14T22:13:20.500Z');

  // Regression: the "with offset" row used Date arithmetic that overflowed at
  // the end of the Date range and printed NaN. Rome's rule puts 13 September
  // in summer time (+02:00); at the other end Rome is on local mean time
  // (+00:49:56 in tzdata).
  await conv('8640000000000000', 'ms');
  assert.equal(await r('iso'), '+275760-09-13T00:00:00Z');
  assert.equal(await r('isolocal'), '+275760-09-13T02:00:00+02:00');
  assert.equal(await r('http'), 'Not defined for years outside 0000 to 9999');
  await conv('-8640000000000000', 'ms');
  assert.equal(await r('iso'), '-271821-04-20T00:00:00Z');
  assert.equal(await r('isolocal'), '-271821-04-20T00:49:56+00:49:56');
  await conv('8640000000000001', 'ms');
  assert.match(await text('#ut-ts-msg'), /Out of range/);

  // RFC 5322 dates start in 1900 (section 3.3); HTTP dates need 4-digit years.
  await conv('-2208988800');
  assert.equal(await r('rfc2822'), 'Mon, 01 Jan 1900 00:00:00 +0000');
  await conv('-2208988801');
  assert.equal(await r('rfc2822'), 'Not defined for years before 1900');
  assert.equal(await page.locator('#ut-r-rfc2822 + td button').isDisabled(), true);
  assert.equal(await r('http'), 'Sun, 31 Dec 1899 23:59:59 GMT');

  // Regression: relative time used numeric:'auto', which called 45 hours ago
  // "yesterday" and 693 days ahead "next year".
  const nowS = Number(await text('#ut-now-s'));
  await conv(String(nowS - 45 * 3600));
  assert.equal(await r('rel'), '1 day ago');
  await conv(String(nowS + 36 * 3600));
  assert.equal(await r('rel'), 'in 1 day');
  await conv(String(nowS + 693 * 86400 + 60));
  assert.equal(await r('rel'), 'in 1 year (693 days)');
  await conv(String(nowS - 400 * 86400 - 60));
  assert.equal(await r('rel'), '1 year ago (400 days)');

  // Manual unit override.
  await conv('1700000000', 'ms');
  assert.equal(await r('iso'), '1970-01-20T16:13:20Z');
  assert.match(await text('#ut-detected'), /as milliseconds/);

  // Bad input never throws; it shows a message.
  await conv('abc');
  assert.ok((await text('#ut-ts-msg')).length > 0);
  assert.equal(await r('iso'), '–');
  await conv('1e30');
  assert.match(await text('#ut-ts-msg'), /range|large/);
  await conv('');
  assert.equal(await text('#ut-ts-msg'), '');

  // Example buttons and copy.
  await page.click('button[data-example="2147483647"]');
  assert.equal(await page.inputValue('#ut-ts'), '2147483647');
  await page.locator('#ut-r-iso + td button').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '2038-01-19T03:14:07Z');

  // Date -> timestamp. Defaults to now in the local zone.
  assert.equal(await page.inputValue('#ut-zone'), 'Europe/Rome');
  assert.equal(await page.inputValue('#ut-date'), '2026-09-24');
  const outS = Number(await text('#ut-out-s'));
  assert.ok(outS >= 1790208000 && outS < 1790208010, `default date to timestamp ${outS}`);

  await page.selectOption('#ut-zone', 'UTC');
  await page.fill('#ut-date', '2038-01-19');
  await page.fill('#ut-time', '03:14:07');
  assert.equal(await text('#ut-out-s'), '2147483647');
  assert.equal(await text('#ut-out-ms'), '2147483647000');
  assert.equal(await text('#ut-out-iso'), '2038-01-19T03:14:07Z');
  await page.fill('#ut-date', '1969-12-31');
  await page.fill('#ut-time', '23:59:59');
  assert.equal(await text('#ut-out-s'), '-1');
  await page.fill('#ut-date', '1970-01-01');
  await page.fill('#ut-time', '00:00:00');
  assert.equal(await text('#ut-out-s'), '0');

  await page.selectOption('#ut-zone', 'Asia/Kathmandu');
  await page.fill('#ut-date', '2026-07-04');
  await page.fill('#ut-time', '20:00:00');
  assert.equal(await text('#ut-out-s'), '1783174500');
  await page.selectOption('#ut-zone', 'America/New_York');
  await page.fill('#ut-date', '2026-03-08');
  await page.fill('#ut-time', '02:30:00');
  assert.equal(await text('#ut-out-s'), '1772955000');
  assert.match(await text('#ut-date-note'), /does not exist/);
  await page.fill('#ut-date', '2026-11-01');
  await page.fill('#ut-time', '01:30:00');
  assert.equal(await text('#ut-out-s'), '1793511000');
  assert.match(await text('#ut-date-note'), /happens twice/);
  await page.fill('#ut-date', '');
  assert.equal(await text('#ut-date-msg'), 'Enter a date.');
  assert.equal(await text('#ut-out-s'), '–');

  // Date strings.
  await page.selectOption('#ut-zone', 'UTC');
  for (const s of ['2001-09-09T01:46:40Z', 'Sun, 09 Sep 2001 01:46:40 GMT', '2001-09-09T03:46:40+02:00', '2001-09-09 01:46:40']) {
    await page.fill('#ut-parse', s);
    const out = await text('#ut-parse-out');
    assert.match(out, /Seconds:\s+1000000000\n/, `parse ${s}`);
    assert.match(out, /ISO 8601 UTC:\s+2001-09-09T01:46:40Z/);
  }
  assert.match(await text('#ut-parse-out'), /read as UTC/);
  await page.fill('#ut-parse', '2001-02-30T00:00:00Z');
  assert.ok((await text('#ut-parse-msg')).length > 0);
  assert.equal(await page.locator('#ut-parse-out').isHidden(), true);
  await page.fill('#ut-parse', 'not a date');
  assert.ok((await text('#ut-parse-msg')).length > 0);

  // Regression: the old fallback to Date.parse read junk such as "hello 1" as
  // 2001-01-01 in Chrome. Only well-defined formats are accepted now.
  for (const junk of ['hello 1', 'Test 5 3', '1/2/3', 'June 2021', 'Foo, 09 Sep 2001 01:46:40 GMT']) {
    await page.fill('#ut-parse', junk);
    assert.match(await text('#ut-parse-msg'), /Could not read/, junk);
    assert.equal(await page.locator('#ut-parse-out').isHidden(), true, junk);
  }
  // Regression: offsets outside -23:59..+23:59 were accepted.
  for (const bad of ['2001-09-09T01:46:40+25:00', '2001-09-09T01:46:40+05:99', 'Sun, 09 Sep 2001 01:46:40 XYZ']) {
    await page.fill('#ut-parse', bad);
    assert.match(await text('#ut-parse-msg'), /not a valid time zone/, bad);
  }
  await page.fill('#ut-parse', '2001-09-09T23:59:60Z');
  assert.match(await text('#ut-parse-msg'), /leap second/);
  // Other standard forms (values from Python's email.utils and datetime).
  const forms = {
    '2001-09-09T01:46:40+05:30': '999980200',
    'Tue, 1 Jul 2003 10:52:37 +0200 (CEST)': '1057049557',
    'Sunday, 09-Sep-01 01:46:40 GMT': '1000000000', // RFC 850
    'Sun Sep  9 01:46:40 2001': '1000000000', // asctime, read in the selected zone (UTC)
    'Sun, 09 Sep 2001 01:46:40 EDT': '1000014400',
    'Sun Sep 09 2001 03:46:40 GMT+0200 (Central European Summer Time)': '1000000000',
    '+275760-09-13T00:00:00Z': '8640000000000',
  };
  for (const [str, want] of Object.entries(forms)) {
    await page.fill('#ut-parse', str);
    assert.equal(await text('#ut-parse-msg'), '', str);
    assert.match(await text('#ut-parse-out'), new RegExp('^Seconds:\\s+' + want + '\\n'), str);
  }
  await page.fill('#ut-parse', 'Mon, 09 Sep 2001 01:46:40 GMT');
  assert.match(await text('#ut-parse-out'), /says Monday, but that date is a Sunday/);
  await page.fill('#ut-parse', '+275760-09-13T00:00:00-01:00');
  assert.match(await text('#ut-parse-msg'), /outside the range/);
  // Ambiguous local times get a note (New York, fall back: first occurrence).
  await page.selectOption('#ut-zone', 'America/New_York');
  await page.fill('#ut-parse', '2026-11-01T01:30:00');
  assert.match(await text('#ut-parse-out'), /Seconds:\s+1793511000\n[\s\S]*happens twice/);
  await page.selectOption('#ut-zone', 'UTC');
  await page.fill('#ut-parse', '1700000000');
  assert.match(await text('#ut-parse-msg'), /Unix timestamp/);

  // Regression: the results table was inside a live region and rebuilt on
  // every keystroke (about 150 announcements, 3,300 characters, for one typed
  // timestamp, plus "N seconds ago" every second), and half-typed values fired
  // role=alert errors. Now each field has one short status line, set once
  // typing pauses.
  await page.evaluate(() => {
    window.__said = [];
    new MutationObserver(ms => ms.forEach(m => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const region = el && el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"], [role="log"]');
      const added = m.type === 'characterData' ? m.target.data : [...m.addedNodes].map(n => n.textContent).join('');
      if (region && added.trim()) window.__said.push(added.trim());
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const said = () => page.evaluate(() => window.__said.splice(0));
  const status = (sel, want) => page.waitForFunction(([s, w]) => document.querySelector(s).textContent === w, [sel, want]);
  for (const sel of ['#ut-results', '#ut-ts-msg', '#ut-parse-out', '#ut-parse-msg']) {
    assert.equal(await page.locator(sel).evaluate(el => !!el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]')), false, `${sel} is not live`);
  }
  await page.fill('#ut-ts', '');
  await page.waitForTimeout(800);
  await said();
  await page.type('#ut-ts', '-1700000000', { delay: 120 }); // "-" alone is not a number yet (Python: 1916-02-18T01:46:40Z)
  await status('#ut-ts-status', 'Seconds: Friday, February 18, 1916 at 1:46:40 AM UTC');
  await page.waitForTimeout(300);
  let heard = await said();
  assert.deepEqual(heard, ['Seconds: Friday, February 18, 1916 at 1:46:40 AM UTC']);
  await page.waitForTimeout(1500); // the ticking relative time is not announced
  assert.deepEqual(await said(), []);
  await page.fill('#ut-ts', '12x');
  await status('#ut-ts-status', 'That is not a number.');
  await page.click('button[data-example="0"]');
  await status('#ut-ts-status', 'Seconds: Thursday, January 1, 1970 at 12:00:00 AM UTC');
  await page.selectOption('#ut-view-zone', 'Asia/Kathmandu');
  await status('#ut-ts-status', 'Asia/Kathmandu: Thursday, January 1, 1970 at 5:30:00 AM GMT+5:30');
  await page.selectOption('#ut-view-zone', 'Europe/Rome');
  await page.fill('#ut-parse', '');
  await page.waitForTimeout(800);
  await said();
  await page.type('#ut-parse', '2001-09-09T01:46:40Z', { delay: 60 });
  await status('#ut-parse-status', 'Unix time 1000000000 seconds, 2001-09-09T01:46:40Z');
  await page.waitForTimeout(300);
  heard = await said();
  assert.deepEqual(heard, ['Unix time 1000000000 seconds, 2001-09-09T01:46:40Z']);
  await page.fill('#ut-parse', 'hello 1');
  await status('#ut-parse-status', 'Could not read that date.');

  // The privacy line is in every page's footer; this slot answers a real question.
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(!faqs.some(q => /uploaded|sent to a server/i.test(q)), faqs.join(' | '));
  assert.ok(faqs.some(q => /Excel or Google Sheets/.test(q)), faqs.join(' | '));
  // The FAQ's spreadsheet formula =A2/86400 + DATE(1970,1,1): DATE(1970,1,1) is
  // serial 25569 in Excel's 1900 system, and 1e9 s gives 2001-09-09 01:46:40.
  const serial = 1e9 / 86400 + 25569;
  const excelEpoch = Date.UTC(1899, 11, 30); // serial 0 for dates after 1900-02-28
  assert.equal(new Date(excelEpoch + Math.round(serial * 864e5)).toISOString(), '2001-09-09T01:46:40.000Z');

  // Regression: at 320px the "current time" cards were 3px wider than the page.
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, 'no sideways scroll at 320px');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Regression: both time zone menus were filled at load, one
  // Intl.DateTimeFormat per zone (about 420), which blocked the main thread
  // for about 400 ms on a throttled phone. Now they start with the local zone
  // and UTC and fill in small idle-time batches, or at once when first used.
  await page.addInitScript(() => {
    // Most DateTimeFormat constructions in one uninterrupted run of page JS
    // (the test clock's idle callbacks report no time left, so every idle
    // batch is the minimum size; the old page built about 440 in one go).
    let run = 0;
    window.__dtfMax = 0;
    const count = () => { if (!run++) queueMicrotask(() => { window.__dtfMax = Math.max(window.__dtfMax, run); run = 0; }); };
    Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
      construct(t, a, nt) { count(); return Reflect.construct(t, a, nt); },
      apply(t, self, a) { count(); return Reflect.apply(t, self, a); },
    });
    if (location.search === '?no-idle') window.requestIdleCallback = () => 0; // the browser never goes idle
  });
  const zoneValues = sel => page.$$eval(sel + ' option', os => os.map(o => o.value));
  await page.goto(url + '?no-idle');
  assert.deepEqual(await zoneValues('#ut-view-zone'), ['Europe/Rome', 'UTC']);
  assert.deepEqual(await zoneValues('#ut-zone'), ['Europe/Rome', 'UTC']);
  assert.equal(await page.inputValue('#ut-zone'), 'Europe/Rome');
  await page.selectOption('#ut-zone', 'UTC');
  await page.focus('#ut-zone'); // first use completes both menus at once
  assert.ok((await zoneValues('#ut-zone')).length > 300);
  assert.ok((await zoneValues('#ut-view-zone')).length > 300);
  assert.ok((await zoneValues('#ut-zone')).includes('Asia/Kathmandu'));
  assert.equal(await page.inputValue('#ut-zone'), 'UTC', 'the choice made before the list filled is kept');
  assert.equal(await page.inputValue('#ut-view-zone'), 'Europe/Rome');
  assert.equal(await page.locator('#ut-view-zone option:checked').textContent(), 'Europe/Rome (UTC+02:00) · local');
  await open();
  await page.waitForFunction(() => ['#ut-zone', '#ut-view-zone'].every(s => document.querySelector(s).options.length > 300));
  const dtfMax = await page.evaluate(() => window.__dtfMax);
  assert.ok(dtfMax < 100, `${dtfMax} DateTimeFormats built in one go`);
  assert.equal(await page.inputValue('#ut-view-zone'), 'Europe/Rome');

  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
