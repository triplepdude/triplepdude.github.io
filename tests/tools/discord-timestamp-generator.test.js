// Expected previews come from Discord's own documentation example
// (<t:1618953630>, shown there as "Tuesday, April 20, 2021 at 16:20" etc. for a
// reader in US Central time), converted to the English (US) 12-hour clock.
// Unix values were computed independently with Python's zoneinfo.
module.exports = async ({ page, open, assert, url }) => {
  const text = sel => page.locator(sel).textContent();
  const item = style => page.locator(`.dts-item[data-style="${style}"]`);
  const preview = async style => (await item(style).locator('.dts-preview').textContent()).trim();
  const codeOf = style => item(style).locator('.dts-code').textContent();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' });
  // "Now" is one hour after the docs example moment (2021-04-20T21:20:30Z).
  await page.clock.install({ time: new Date('2021-04-20T22:20:30Z') });
  await open();

  // Defaults: the current minute, in the visitor's own time zone.
  assert.equal(await page.inputValue('#dts-zone'), 'America/Chicago');
  assert.equal(await page.inputValue('#dts-date'), '2021-04-20');
  assert.equal(await page.inputValue('#dts-time'), '17:20:00');
  assert.equal(await text('#dts-unix'), '1618957200');
  assert.equal(await codeOf('R'), '<t:1618957200:R>');

  // Countdown helper: now (17:20:30 CDT, 1618957230) plus a duration, rounded to
  // the nearest step of local clock time (values from Python's zoneinfo).
  const cdCodes = () => page.locator('#dts-cd-list .dts-code').allTextContents();
  const cdPrev = async () => (await page.locator('#dts-cd-list .dts-preview').allTextContents()).map(t => t.trim());
  // Default: 2 hours, rounded to 15 minutes -> 19:15 CDT.
  assert.deepEqual(await cdCodes(), ['<t:1618964100:R>', '<t:1618964100:t> (<t:1618964100:R>)', '<t:1618964100:F> (<t:1618964100:R>)']);
  assert.deepEqual(await cdPrev(), ['in 2 hours', '7:15 PM (in 2 hours)', 'Tuesday, April 20, 2021 at 7:15 PM (in 2 hours)']);
  assert.match(await text('#dts-cd-when'), /^Starts Tuesday, April 20, 2021 at 7:15 PM your time, Unix 1618964100\./);
  await page.click('button[data-cd="0,0,15"]'); // 17:35:30 -> 17:30
  assert.equal(await page.locator('#dts-cd-list .dts-code').first().textContent(), '<t:1618957800:R>');
  // 9.5 minutes away when the page's clock reads 17:20:30 exactly: "in 10 minutes", then 9 once it moves on.
  assert.match((await cdPrev())[0], /^in (9|10) minutes$/);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-cd')), '0,0,15');
  await page.waitForFunction(() => /^Starts in (9|10) minutes: <t:1618957800:R>$/.test(document.querySelector('#dts-cd-status').textContent));
  await page.click('button[data-cd="7,0,0"]'); // Apr 27 17:20:30 -> 17:15
  assert.equal(await page.locator('#dts-cd-list .dts-code').first().textContent(), '<t:1619561700:R>');
  assert.equal((await cdPrev())[0], 'in 7 days');
  await page.fill('#dts-cd-d', '0');
  await page.fill('#dts-cd-h', '3');
  await page.selectOption('#dts-cd-round', '0'); // exact: now + 3 h
  assert.equal(await page.locator('#dts-cd-list .dts-code').first().textContent(), '<t:1618968030:R>');
  await page.fill('#dts-cd-d', '1');
  await page.fill('#dts-cd-h', '0');
  await page.selectOption('#dts-cd-round', '60'); // Apr 21 17:20:30 -> 17:00
  assert.equal(await page.locator('#dts-cd-list .dts-code').first().textContent(), '<t:1619042400:R>');
  assert.equal((await cdPrev())[0], 'in a day');
  // Bad durations: a friendly message and nothing to copy.
  await page.fill('#dts-cd-h', '1.5');
  assert.match(await text('#dts-cd-msg'), /whole numbers/);
  assert.equal(await page.locator('#dts-cd-list button').first().isDisabled(), true);
  assert.equal(await page.isDisabled('#dts-cd-load'), true);
  // Rounding to the hour follows the generator's zone: in India (UTC+05:30),
  // 03:50:30 + 2 h rounds to 06:00 IST, which is 00:30 UTC.
  await page.fill('#dts-cd-d', '0');
  await page.fill('#dts-cd-h', '2');
  await page.selectOption('#dts-zone', 'Asia/Kolkata');
  assert.equal(await page.locator('#dts-cd-list .dts-code').first().textContent(), '<t:1618965000:R>');
  assert.match(await text('#dts-cd-when'), /Asia\/Kolkata time is Wed 6:00 AM/);
  await page.selectOption('#dts-zone', 'America/Chicago');
  // Copy and load into the generator.
  await page.locator('#dts-cd-list button').nth(2).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '<t:1618963200:F> (<t:1618963200:R>)');
  await page.click('#dts-cd-load');
  assert.equal(await text('#dts-unix'), '1618963200');
  assert.equal(await page.inputValue('#dts-time'), '19:00:00');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dts-date');

  // The docs example: 2021-04-20 16:20:30 in Chicago = 1618953630.
  await page.fill('#dts-time', '16:20:30');
  assert.equal(await text('#dts-unix'), '1618953630');
  assert.equal(await text('#dts-utc'), '2021-04-20 21:20:30 UTC');
  const expected = {
    t: '4:20 PM',
    T: '4:20:30 PM',
    d: '04/20/2021',
    D: 'April 20, 2021',
    f: 'April 20, 2021 at 4:20 PM',
    F: 'Tuesday, April 20, 2021 at 4:20 PM',
    s: '04/20/2021, 4:20 PM',
    S: '04/20/2021, 4:20:30 PM',
    R: 'an hour ago',
    default: 'April 20, 2021 at 4:20 PM',
  };
  for (const [style, want] of Object.entries(expected)) {
    assert.equal(await preview(style), want, `preview for ${style}`);
    assert.equal(await codeOf(style), style === 'default' ? '<t:1618953630>' : `<t:1618953630:${style}>`);
  }
  assert.equal(await codeOf('combo'), '<t:1618953630:F> (<t:1618953630:R>)');
  assert.equal(await preview('combo'), 'Tuesday, April 20, 2021 at 4:20 PM (an hour ago)');

  // Copy puts the exact code on the clipboard.
  await item('F').locator('button').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '<t:1618953630:F>');
  await page.click('button[data-copy-target="#dts-unix"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '1618953630');

  // Relative preview updates live as time passes.
  await page.clock.fastForward('02:00:00');
  await page.clock.runFor(1500);
  assert.equal(await preview('R'), '3 hours ago');
  assert.equal(await preview('combo'), 'Tuesday, April 20, 2021 at 4:20 PM (3 hours ago)');
  await page.fill('#dts-date', '2021-04-22');
  assert.equal(await preview('R'), 'in 2 days');
  await page.fill('#dts-date', '2021-04-20');

  // Same wall time entered in another zone (India, UTC+05:30).
  await page.selectOption('#dts-zone', 'Asia/Kolkata');
  assert.equal(await text('#dts-unix'), '1618915830');
  assert.equal(await preview('t'), '5:50 AM'); // shown in the viewer's zone (Chicago)
  assert.match(await text('#dts-note'), /UTC\+05:30/);
  await page.selectOption('#dts-zone', 'UTC');
  assert.equal(await text('#dts-unix'), '1618935630');

  // DST: 02:30 on 2026-03-08 does not exist in New York; 01:30 on 2026-11-01 happens twice.
  await page.selectOption('#dts-zone', 'America/New_York');
  await page.fill('#dts-date', '2026-03-08');
  await page.fill('#dts-time', '02:30:00');
  assert.equal(await text('#dts-unix'), '1772955000');
  assert.match(await text('#dts-note'), /does not exist/);
  await page.fill('#dts-date', '2026-11-01');
  await page.fill('#dts-time', '01:30:00');
  assert.equal(await text('#dts-unix'), '1793511000');
  assert.match(await text('#dts-note'), /happens twice/);
  // +1 day keeps the clock time (01:30 EST the next day is 25 hours later).
  await page.click('button[data-add-days="1"]');
  assert.equal(await text('#dts-unix'), '1793601000');
  assert.equal(await page.inputValue('#dts-date'), '2026-11-02');
  assert.equal(await page.inputValue('#dts-time'), '01:30:00');
  await page.click('button[data-add="3600"]');
  assert.equal(await text('#dts-unix'), '1793604600');
  assert.equal(await page.inputValue('#dts-time'), '02:30:00');
  await page.click('button[data-add="-3600"]');
  await page.click('button[data-add-days="7"]');
  assert.equal(await text('#dts-unix'), '1794205800');

  // Regression: +/-1 hour must step through the repeated hour, not snap back
  // to its first occurrence (Python zoneinfo: 00:30 EDT 1793507400, 01:30 EDT
  // 1793511000, 01:30 EST 1793514600, 02:30 EST 1793518200).
  await page.fill('#dts-date', '2026-11-01');
  await page.fill('#dts-time', '00:30:00');
  assert.equal(await text('#dts-unix'), '1793507400');
  for (const want of ['1793511000', '1793514600', '1793518200']) {
    await page.click('button[data-add="3600"]');
    assert.equal(await text('#dts-unix'), want);
  }
  assert.equal(await page.inputValue('#dts-time'), '02:30:00');
  await page.click('button[data-add="-3600"]');
  assert.equal(await text('#dts-unix'), '1793514600');
  assert.equal(await page.inputValue('#dts-time'), '01:30:00');
  assert.match(await text('#dts-note'), /second occurrence \(UTC\u221205:00\) was used/);
  await page.click('button[data-add="-3600"]');
  assert.equal(await text('#dts-unix'), '1793511000');
  assert.match(await text('#dts-note'), /first occurrence \(UTC\u221204:00\) was used/);
  // Typing a time again means the default, first occurrence.
  await page.click('button[data-add="3600"]');
  assert.equal(await text('#dts-unix'), '1793514600');
  await page.fill('#dts-time', '01:30:00');
  assert.equal(await text('#dts-unix'), '1793511000');

  // Regression: dates before 1970 give negative Unix times, which Discord accepts.
  await page.fill('#dts-date', '1969-07-20');
  await page.fill('#dts-time', '16:17:40');
  assert.equal(await text('#dts-msg'), '');
  assert.equal(await text('#dts-unix'), '-14182940');
  assert.equal(await text('#dts-utc'), '1969-07-20 20:17:40 UTC');
  assert.equal(await codeOf('F'), '<t:-14182940:F>');
  assert.equal(await preview('F'), 'Sunday, July 20, 1969 at 3:17 PM'); // viewer in Chicago (CDT)
  await page.fill('#dts-date', '9999-12-31');
  await page.click('button[data-add-days="1"]');
  assert.match(await text('#dts-msg'), /year from 1 to 9999/);
  assert.equal(await text('#dts-unix'), '–');

  // Error path: an empty date shows a message and disables copying.
  await page.fill('#dts-date', '');
  assert.equal(await text('#dts-msg'), 'Enter a date.');
  assert.equal(await text('#dts-unix'), '–');
  assert.equal(await item('F').locator('button').isDisabled(), true);

  // Decoder: a whole message with two codes.
  await page.fill('#dts-decode', 'Raid starts <t:1618953630:F> (<t:1618953630:R>)!');
  await page.waitForSelector('.dts-message');
  assert.equal(await text('.dts-message'), 'Raid starts Tuesday, April 20, 2021 at 4:20 PM (3 hours ago)!');
  assert.equal(await page.locator('.dts-dec-item').count(), 2);
  assert.match(await page.locator('.dts-dec-item').first().textContent(), /2021-04-20 21:20:30 UTC/);
  await page.click('#dts-decode-load');
  assert.equal(await text('#dts-unix'), '1618953630');
  assert.equal(await text('#dts-msg'), '');

  // A plain Unix time, a millisecond value and a Discord snowflake ID.
  await page.fill('#dts-decode', '1618953630');
  await page.waitForFunction(() => document.querySelector('#dts-decode-out').textContent.includes('<t:1618953630:f>'));
  assert.match(await page.locator('#dts-decode-out').textContent(), /<t:1618953630:f>.*April 20, 2021 at 4:20 PM/s);
  await page.fill('#dts-decode', '1618953630123');
  await page.waitForFunction(() => /milliseconds/.test(document.querySelector('#dts-decode-out').textContent));
  assert.match(await page.locator('#dts-decode-out').textContent(), /use 1618953630/);
  await page.fill('#dts-decode', '175928847299117063');
  await page.waitForFunction(() => /Discord ID/.test(document.querySelector('#dts-decode-out').textContent));
  assert.match(await page.locator('#dts-decode-out').textContent(), /2016-04-30 11:18:25\.796 UTC/);

  // Regression: loading keeps the exact instant, in the repeated DST hour and before 1970.
  await page.selectOption('#dts-zone', 'America/New_York');
  await page.fill('#dts-decode', '<t:1793514600:t>');
  await page.waitForFunction(() => document.querySelector('#dts-decode-out').textContent.includes('<t:1793514600:t>'));
  await page.click('#dts-decode-load');
  assert.equal(await text('#dts-unix'), '1793514600');
  assert.equal(await page.inputValue('#dts-time'), '01:30:00');
  await page.selectOption('#dts-zone', 'America/Chicago');
  await page.fill('#dts-decode', '0');
  await page.waitForFunction(() => document.querySelector('#dts-decode-out').textContent.includes('<t:0:f>'));
  await page.click('#dts-decode-load');
  assert.equal(await text('#dts-msg'), '');
  assert.equal(await text('#dts-unix'), '0');
  assert.equal(await page.inputValue('#dts-date'), '1969-12-31');
  assert.equal(await page.inputValue('#dts-time'), '18:00:00');
  // Beyond what the date picker can hold: a friendly message, no exception.
  await page.fill('#dts-decode', '<t:8640000000000:R>');
  await page.waitForFunction(() => document.querySelector('#dts-decode-out').textContent.includes('<t:8640000000000:R>'));
  await page.click('#dts-decode-load');
  assert.match(await text('#dts-msg'), /outside the years 1 to 9999/);
  assert.equal(await text('#dts-unix'), '–');
  // A huge paste only previews the first 20,000 characters but still decodes every code.
  const big = 'x'.repeat(19990) + ' <t:1618953630:R> ' + 'y'.repeat(100);
  await page.fill('#dts-decode', big);
  await page.waitForFunction(() => /first 20,000/.test(document.querySelector('#dts-decode-out').textContent));
  const shown = await text('.dts-message');
  assert.ok(shown.endsWith(' …') && shown.length < 20000, `preview length ${shown.length}`);
  assert.equal(await page.locator('.dts-dec-item').count(), 1);

  await page.fill('#dts-decode', 'hello there');
  await page.waitForFunction(() => document.querySelector('#dts-decode-msg').textContent.length > 0);
  assert.equal(await page.locator('.dts-dec-item').count(), 0);
  assert.equal(await page.locator('#dts-decode-actions').isHidden(), true);

  // Regression: typing a message into the decoder fired the role=alert "No
  // timestamp found. Paste a code like ..." after almost every keystroke (18
  // alerts, 1,728 characters) and re-announced the whole decoded block. Now
  // one short summary is announced once typing pauses.
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
  const status = want => page.waitForFunction(w => document.querySelector('#dts-decode-status').textContent === w, want);
  for (const sel of ['#dts-decode-out', '#dts-decode-msg']) {
    assert.equal(await page.locator(sel).evaluate(el => !!el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]')), false, `${sel} is not live`);
  }
  await status('No timestamp found.'); // from "hello there"
  await page.fill('#dts-decode', '');
  await page.waitForTimeout(900);
  await said();
  await page.type('#dts-decode', 'at <t:1618953630:R> ok', { delay: 150 });
  await status('1 timestamp found: 3 hours ago');
  await page.waitForTimeout(300);
  assert.deepEqual(await said(), ['1 timestamp found: 3 hours ago']);
  await page.fill('#dts-decode', 'Raid <t:1618953630:F> (<t:1618953630:R>)');
  await status('2 timestamps found. First: Tuesday, April 20, 2021 at 4:20 PM');
  await page.fill('#dts-decode', '1618953630123');
  await status('Looks like milliseconds; Discord needs seconds, so use 1618953630: April 20, 2021 at 4:20 PM');
  await page.fill('#dts-decode', '175928847299117063');
  await status('Discord ID created Saturday, April 30, 2016 at 6:18 AM');

  // The FAQ explains plain-text codes and confirms nothing is uploaded.
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(faqs.some(q => /sent to a server/i.test(q)), faqs.join(' | '));
  assert.ok(faqs.some(q => /plain text/.test(q)), faqs.join(' | '));

  // Regression: codes that Discord shows as plain text were only reported as
  // "No timestamp found", and codes inside backticks were previewed as dates.
  const why = async (input, re) => {
    await page.fill('#dts-decode', input);
    await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#dts-decode-msg').textContent), re.source);
  };
  await why('<t:1618953630:x>', /"x" is not a style letter/);
  await why('<t: 1618953630>', /contains a space/);
  await why('<t:1618953630.5:R>', /decimal point/);
  await why('<t:abc>', /Unix time in seconds right after "t:"/);
  await page.fill('#dts-decode', 'see `<t:1618953630:R>` and <t:1618953630:F>');
  await page.waitForFunction(() => document.querySelectorAll('.dts-dec-item').length === 2);
  assert.equal(await text('.dts-message'), 'see `<t:1618953630:R>` and Tuesday, April 20, 2021 at 4:20 PM');
  assert.match(await page.locator('.dts-dec-item').first().textContent(), /Discord shows: <t:1618953630:R>Inside backticks/);
  // A millisecond value inside a code is flagged (it would show the year 53272).
  await page.fill('#dts-decode', '<t:1618953630123:R>');
  await page.waitForFunction(() => /looks like milliseconds/.test(document.querySelector('#dts-decode-out').textContent));
  assert.match(await text('#dts-decode-out'), /year 53272; the seconds value is 1618953630/);

  // Regression: the generator's results were live regions and its error an
  // alert, so each edit re-read the whole panel. Now one summary is announced.
  for (const sel of ['#dts-msg', '#dts-note', '.dts-stats', '#dts-list', '#dts-cd-list']) {
    assert.equal(await page.locator(sel).evaluate(el => !!el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]')), false, `${sel} is not live`);
  }
  await page.selectOption('#dts-zone', 'UTC');
  await page.fill('#dts-date', '2021-04-20');
  await page.fill('#dts-time', '21:20:30');
  await page.waitForFunction(() => document.querySelector('#dts-status').textContent === 'Unix 1618953630: Tuesday, April 20, 2021 at 4:20 PM, 3 hours ago.');
  await page.fill('#dts-date', '');
  await page.waitForFunction(() => document.querySelector('#dts-status').textContent === 'Enter a date.');

  // Regression: the time zone menu was filled at load, one Intl.DateTimeFormat
  // per zone (about 420), which blocked the main thread for about 400 ms on a
  // throttled phone. Now it starts with the local zone and UTC and fills in
  // small idle-time batches, or at once when first used.
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
  const zoneValues = () => page.$$eval('#dts-zone option', os => os.map(o => o.value));
  await page.goto(url + '?no-idle');
  assert.deepEqual(await zoneValues(), ['America/Chicago', 'UTC']);
  assert.equal(await page.inputValue('#dts-zone'), 'America/Chicago');
  await page.selectOption('#dts-zone', 'UTC');
  await page.focus('#dts-zone'); // first use completes the menu at once
  const all = await zoneValues();
  assert.ok(all.length > 300 && all.includes('Asia/Kolkata') && all[0] === 'UTC', `${all.length} zones`);
  assert.equal(await page.inputValue('#dts-zone'), 'UTC', 'the choice made before the list filled is kept');
  assert.equal(await page.locator('#dts-zone option[value="America/Chicago"]').textContent(), 'America/Chicago (UTC\u221205:00) · local');
  await open();
  await page.waitForFunction(() => document.querySelector('#dts-zone').options.length > 300);
  const dtfMax = await page.evaluate(() => window.__dtfMax);
  assert.ok(dtfMax < 100, `${dtfMax} DateTimeFormats built in one go`);
  assert.equal(await page.inputValue('#dts-zone'), 'America/Chicago');

  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
