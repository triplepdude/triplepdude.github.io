// Expected previews come from Discord's own documentation example
// (<t:1618953630>, shown there as "Tuesday, April 20, 2021 at 16:20" etc. for a
// reader in US Central time), converted to the English (US) 12-hour clock.
// Unix values were computed independently with Python's zoneinfo.
module.exports = async ({ page, open, assert }) => {
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

  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
};
