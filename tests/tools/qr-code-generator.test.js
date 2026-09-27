// Expected payloads are written by hand from the format specs (RFC 6068 mailto,
// RFC 3966 tel, RFC 2426 vCard 3.0, RFC 5870 geo, RFC 5545 iCalendar); the
// percent-encodings and UTC conversions were checked with Python's
// urllib.parse.quote and zoneinfo. Codes are decoded with jsQR, an independent
// decoder that is injected only in this test.
const fs = require('fs');
const path = require('path');

// Byte-mode capacity per version 1-10, from ISO/IEC 18004 table 7.
const CAPACITY = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};
const expectedModules = (payload, ecl) => 17 + 4 * (CAPACITY[ecl].findIndex(c => c >= Buffer.byteLength(payload, 'utf8')) + 1);

function pngInfo(b, assert) {
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  await page.addScriptTag({ content: fs.readFileSync(path.join(fixtures, 'jsQR.min.js'), 'utf8') });

  const payload = () => page.textContent('#qg-payload');
  const modules = () => page.getAttribute('#qg-qr svg', 'data-modules').then(Number);
  const warn = () => page.textContent('#qg-warn');
  const err = () => page.textContent('#qg-error');
  const pick = t => page.check(`input[name="qg-type"][value="${t}"]`);
  const download = async sel => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  // Decode PNG or SVG bytes with jsQR; returns the raw bytes (and corner alpha).
  const decode = (buf, mime) => page.evaluate(async ({ b64, mime }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    const raw = (() => { ctx.drawImage(img, 0, 0, w, h); return ctx.getImageData(0, 0, w, h); })();
    const alpha = raw.data[3];
    // Flatten any transparency onto white before decoding.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillRect(0, 0, w, h);
    URL.revokeObjectURL(url);
    const res = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
    return res ? { bytes: Array.from(res.binaryData), version: res.version, alpha } : { bytes: null, alpha };
  }, { b64: buf.toString('base64'), mime });
  const decodesTo = async (sel, expected, msg) => {
    const f = await download(sel);
    const d = await decode(f.buf, sel === '#qg-svg' ? 'image/svg+xml' : 'image/png');
    assert.ok(d.bytes, `${msg}: decodes`);
    assert.equal(Buffer.from(d.bytes).toString('utf8'), expected, msg);
    return f;
  };

  // ----- Default: a link, shown immediately -----
  assert.equal(await payload(), 'https://example.com/');
  assert.equal(await modules(), expectedModules('https://example.com/', 'M'));
  assert.match(await page.textContent('#qg-meta'), /^Version 2, 25 × 25 modules, error correction M \(15%\), 20 bytes$/);
  assert.equal(await page.textContent('#qg-status'), '', 'nothing announced on load');
  const png = await decodesTo('#qg-png', 'https://example.com/', 'default PNG');
  assert.equal(png.name, 'qr-code-example-com.png');
  assert.deepEqual(pngInfo(png.buf, assert), { width: 1024, height: 1024 });

  // https:// is added when the scheme is missing; spaces are an error.
  await page.fill('#qg-url', 'example.org/path?x=1&y=ü');
  assert.equal(await payload(), 'https://example.org/path?x=1&y=ü');
  await page.fill('#qg-url', 'example.org/a b');
  assert.match(await err(), /cannot contain spaces/);
  assert.equal(await page.getAttribute('#qg-url', 'aria-invalid'), 'true');
  assert.match(await page.textContent('#qg-qr'), /cannot contain spaces/, 'the preview says what is wrong');
  assert.equal(await page.isDisabled('#qg-png'), true);
  await page.fill('#qg-url', '');
  assert.equal(await err(), '', 'an empty field is a prompt, not an error');
  assert.equal(await page.getAttribute('#qg-url', 'aria-invalid'), null);
  assert.match(await page.textContent('#qg-qr'), /Enter a web address/);
  await page.fill('#qg-url', 'mailto:someone@example.com');
  assert.equal(await payload(), 'mailto:someone@example.com', 'other schemes are kept');

  // ----- Text with UTF-8 and line breaks -----
  await pick('text');
  assert.equal(await page.isVisible('#qg-text'), true);
  assert.equal(await page.isVisible('#qg-url'), false);
  const text = 'Hello, 世界! ☕\nLine 2';
  await page.fill('#qg-text', text);
  assert.equal(await payload(), text);
  assert.equal(await modules(), expectedModules(text, 'M'));
  await decodesTo('#qg-png', text, 'text PNG');

  // ----- Email: RFC 6068 percent-encoding, CRLF line breaks, several recipients -----
  await pick('email');
  await page.fill('#qg-email-to', 'ana@example.com, bo+x@example.org');
  await page.fill('#qg-email-subject', 'Hi & welcome');
  await page.fill('#qg-email-body', 'Line 1\nLine 2 ü');
  const mail = 'mailto:ana@example.com,bo%2Bx@example.org?subject=Hi%20%26%20welcome&body=Line%201%0D%0ALine%202%20%C3%BC';
  assert.equal(await payload(), mail);
  await decodesTo('#qg-png', mail, 'mailto PNG');
  await page.fill('#qg-email-to', 'not-an-address');
  assert.match(await err(), /"not-an-address" is not a valid email address/);
  await page.fill('#qg-email-to', 'ana@example.com');
  await page.fill('#qg-email-subject', '');
  await page.fill('#qg-email-body', '');
  assert.equal(await payload(), 'mailto:ana@example.com');

  // ----- Phone: separators removed, letters rejected -----
  await pick('phone');
  await page.fill('#qg-phone', '+1 (555) 123-4567');
  assert.equal(await payload(), 'tel:+15551234567');
  await decodesTo('#qg-svg', 'tel:+15551234567', 'tel SVG');
  await page.fill('#qg-phone', '555-CALL-NOW');
  assert.match(await err(), /can only contain digits/);
  assert.equal(await page.getAttribute('#qg-phone', 'aria-invalid'), 'true');

  // ----- SMS: SMSTO (colons in the message are fine) and the RFC 5724 sms: form -----
  await pick('sms');
  await page.fill('#qg-sms-to', '+44 7700 900123');
  await page.fill('#qg-sms-body', 'See you at 5:30; OK?');
  assert.equal(await payload(), 'SMSTO:+447700900123:See you at 5:30; OK?');
  await decodesTo('#qg-png', 'SMSTO:+447700900123:See you at 5:30; OK?', 'SMSTO PNG');
  await page.selectOption('#qg-sms-format', 'uri');
  assert.equal(await payload(), 'sms:+447700900123?body=See%20you%20at%205%3A30%3B%20OK%3F');

  // ----- vCard 3.0 with RFC 2426 escaping -----
  await pick('vcard');
  assert.match(await page.textContent('#qg-qr'), /Enter a name or a company/);
  await page.fill('#qg-vc-first', 'Zoë');
  await page.fill('#qg-vc-last', "O'Brien; Jr");
  await page.fill('#qg-vc-org', 'Acme, Inc.');
  await page.fill('#qg-vc-title', 'CEO');
  await page.fill('#qg-vc-mobile', '+1 555 010 9999');
  await page.fill('#qg-vc-email', 'zoe@acme.example');
  await page.fill('#qg-vc-url', 'acme.example');
  await page.fill('#qg-vc-street', '1 Main St, Suite 5');
  await page.fill('#qg-vc-city', 'Springfield');
  await page.fill('#qg-vc-region', 'IL');
  await page.fill('#qg-vc-zip', '62701');
  await page.fill('#qg-vc-country', 'USA');
  await page.fill('#qg-vc-note', 'Back\\slash\nsecond line');
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    "N:O'Brien\\; Jr;Zoë;;;",
    "FN:Zoë O'Brien\\; Jr",
    'ORG:Acme\\, Inc.',
    'TITLE:CEO',
    'TEL;TYPE=CELL:+15550109999',
    'EMAIL;TYPE=INTERNET:zoe@acme.example',
    'URL:https://acme.example',
    'ADR;TYPE=WORK:;;1 Main St\\, Suite 5;Springfield;IL;62701;USA',
    'NOTE:Back\\\\slash\\nsecond line',
    'END:VCARD',
  ].join('\r\n') + '\r\n';
  assert.equal(await payload(), vcard);
  await decodesTo('#qg-png', vcard, 'vCard PNG');
  // A company alone is enough; FN falls back to it and N stays present (both required in 3.0).
  for (const id of ['#qg-vc-first', '#qg-vc-last', '#qg-vc-title', '#qg-vc-mobile', '#qg-vc-email', '#qg-vc-url', '#qg-vc-street', '#qg-vc-city', '#qg-vc-region', '#qg-vc-zip', '#qg-vc-country', '#qg-vc-note']) await page.fill(id, '');
  assert.equal(await payload(), 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;;;;\r\nFN:Acme\\, Inc.\r\nORG:Acme\\, Inc.\r\nEND:VCARD\r\n');
  await page.fill('#qg-vc-email', 'nope');
  assert.match(await err(), /"nope" is not a valid email address/);
  await page.fill('#qg-vc-email', '');

  // ----- Location: geo: URI, pasted pairs split, ranges checked -----
  await pick('geo');
  await page.fill('#qg-lat', '48.8584, 2.2945');
  assert.equal(await page.inputValue('#qg-lat'), '48.8584');
  assert.equal(await page.inputValue('#qg-lon'), '2.2945');
  assert.equal(await payload(), 'geo:48.8584,2.2945');
  await decodesTo('#qg-png', 'geo:48.8584,2.2945', 'geo PNG');
  await page.fill('#qg-lon', '-.5');
  assert.equal(await payload(), 'geo:48.8584,-0.5');
  await page.selectOption('#qg-geo-format', 'google');
  assert.equal(await payload(), 'https://maps.google.com/?q=48.8584,-0.5');
  await page.fill('#qg-lat', '91');
  assert.match(await err(), /Latitude must be a number from -90 to 90/);
  await page.fill('#qg-lat', '-33.8568');
  await page.fill('#qg-lon', '151.2153');
  await page.selectOption('#qg-geo-format', 'geo');
  assert.equal(await payload(), 'geo:-33.8568,151.2153');

  // ----- Calendar event: RFC 5545 escaping, UTC conversion from a chosen time zone -----
  await pick('event');
  await page.fill('#qg-ev-title', 'Launch; party, v2');
  await page.selectOption('#qg-ev-tz', 'America/New_York');
  await page.fill('#qg-ev-sdate', '2026-07-04');
  await page.fill('#qg-ev-stime', '09:00');
  await page.fill('#qg-ev-edate', '2026-07-04');
  await page.fill('#qg-ev-etime', '17:30');
  await page.fill('#qg-ev-loc', 'Pier 17, NYC');
  await page.fill('#qg-ev-desc', 'Bring ID\nNo pets');
  const ev = 'BEGIN:VEVENT\r\nSUMMARY:Launch\\; party\\, v2\r\nDTSTART:20260704T130000Z\r\nDTEND:20260704T213000Z\r\nLOCATION:Pier 17\\, NYC\r\nDESCRIPTION:Bring ID\\nNo pets\r\nEND:VEVENT\r\n';
  assert.equal(await payload(), ev);
  await decodesTo('#qg-png', ev, 'VEVENT PNG');
  // Moving the start keeps the duration.
  await page.fill('#qg-ev-sdate', '2026-07-05');
  assert.equal(await page.inputValue('#qg-ev-edate'), '2026-07-05');
  assert.equal(await page.inputValue('#qg-ev-etime'), '17:30');
  assert.match(await payload(), /DTSTART:20260705T130000Z\r\nDTEND:20260705T213000Z/);
  // Other zones (Python zoneinfo): Berlin in winter is UTC+1; Kolkata is UTC+5:30 across a year end.
  await page.selectOption('#qg-ev-tz', 'Europe/Berlin');
  await page.fill('#qg-ev-sdate', '2026-01-15');
  await page.fill('#qg-ev-stime', '18:00');
  assert.match(await payload(), /DTSTART:20260115T170000Z\r\n/);
  await page.selectOption('#qg-ev-tz', 'Asia/Kolkata');
  await page.fill('#qg-ev-sdate', '2026-12-31');
  await page.fill('#qg-ev-stime', '23:45');
  assert.match(await payload(), /DTSTART:20261231T181500Z\r\n/);
  // A time skipped by the spring-forward change uses the offset before the gap (02:30 EST
  // = 07:30Z), and a time that happens twice means the first one (02:30 CEST = 00:30Z).
  await page.selectOption('#qg-ev-tz', 'America/New_York');
  await page.fill('#qg-ev-sdate', '2026-03-08');
  await page.fill('#qg-ev-stime', '02:30');
  await page.fill('#qg-ev-edate', '2026-03-08');
  await page.fill('#qg-ev-etime', '04:00');
  assert.match(await payload(), /DTSTART:20260308T073000Z\r\nDTEND:20260308T080000Z\r\n/);
  assert.match(await warn(), /start time does not exist in America\/New_York[\s\S]*03:30/);
  await page.selectOption('#qg-ev-tz', 'Europe/Berlin');
  await page.fill('#qg-ev-sdate', '2026-10-25');
  await page.fill('#qg-ev-stime', '02:30');
  await page.fill('#qg-ev-edate', '2026-10-25');
  await page.fill('#qg-ev-etime', '05:00');
  assert.match(await payload(), /DTSTART:20261025T003000Z\r\nDTEND:20261025T040000Z\r\n/);
  assert.match(await warn(), /happens twice/);
  // Floating time keeps the clock time with no Z.
  await page.selectOption('#qg-ev-tz', 'floating');
  assert.match(await payload(), /DTSTART:20261025T023000\r\nDTEND:20261025T050000\r\n/);
  // All-day: DTEND is the day after the last day.
  await page.check('#qg-ev-allday');
  assert.equal(await page.isVisible('#qg-ev-stime'), false);
  await page.fill('#qg-ev-sdate', '2026-12-24');
  await page.fill('#qg-ev-edate', '2026-12-26');
  assert.match(await payload(), /DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261227\r\n/);
  await page.fill('#qg-ev-edate', '2026-12-20');
  assert.match(await err(), /ends before it starts/);
  assert.equal(await page.getAttribute('#qg-ev-edate', 'aria-invalid'), 'true');
  await page.uncheck('#qg-ev-allday');

  // ----- Back to a link for the design options -----
  await pick('url');
  await page.fill('#qg-url', 'https://example.com/');
  await page.fill('#qg-margin', '2');
  assert.match(await warn(), /quiet zone of at least 4 modules/);
  let svg = (await download('#qg-svg')).buf.toString('utf8');
  assert.match(svg, /width="1024" height="1024" viewBox="0 0 29 29"/);
  await page.fill('#qg-margin', '4');
  assert.equal(await warn(), '');

  // Low-contrast colours: #ffcc00 has relative luminance 0.645, so 36% against white.
  await page.fill('#qg-fg-hex', '#ffcc00');
  assert.equal(await page.inputValue('#qg-fg'), '#ffcc00');
  assert.match(await page.textContent('#qg-contrast'), /Contrast 36% \(too low\)/);
  assert.match(await warn(), /too similar \(contrast 36%\)/);
  await page.fill('#qg-fg-hex', '#1f3a93');
  assert.match(await page.textContent('#qg-contrast'), /\(good\)/);
  svg = (await download('#qg-svg')).buf.toString('utf8');
  assert.match(svg, /<rect width="33" height="33" fill="#ffffff"\/><path fill="#1f3a93"/);
  await decodesTo('#qg-png', 'https://example.com/', 'coloured PNG');
  // Inverted colours warn.
  await page.fill('#qg-fg-hex', '#fff');
  await page.fill('#qg-bg-hex', '#000000');
  assert.match(await page.textContent('#qg-contrast'), /Inverted/);
  assert.match(await warn(), /lighter than the background/);
  await page.fill('#qg-bg-hex', 'nothex');
  assert.match(await err(), /background colour must be a hex colour/);
  await page.fill('#qg-fg-hex', '#000000');
  await page.fill('#qg-bg-hex', '#ffffff');
  assert.equal(await err(), '');

  // Transparent background: no background rect in the SVG, transparent PNG corners.
  await page.check('#qg-transparent');
  svg = (await download('#qg-svg')).buf.toString('utf8');
  assert.ok(!svg.includes('<rect'), 'no background rect');
  const tPng = await download('#qg-png');
  const td = await decode(tPng.buf, 'image/png');
  assert.equal(td.alpha, 0, 'corner pixel is transparent');
  assert.equal(Buffer.from(td.bytes).toString('utf8'), 'https://example.com/');
  await page.uncheck('#qg-transparent');

  // PNG size option.
  await page.selectOption('#qg-size', '256');
  const small = await decodesTo('#qg-png', 'https://example.com/', '256 px PNG');
  assert.deepEqual(pngInfo(small.buf, assert), { width: 256, height: 256 });
  await page.selectOption('#qg-size', '1024');

  // ----- Logo: forces level H, still decodes, removable -----
  await page.selectOption('#qg-ecl', 'L');
  await page.setInputFiles('#qg-logo-file', path.join(fixtures, 'logo.png'));
  await page.waitForSelector('#qg-logo-remove:not([hidden])');
  assert.equal(await page.inputValue('#qg-ecl'), 'H');
  assert.equal(await page.isDisabled('#qg-ecl'), true);
  assert.equal(await modules(), expectedModules('https://example.com/', 'H'));
  assert.equal(await page.textContent('#qg-logo-name'), 'logo.png');
  await decodesTo('#qg-png', 'https://example.com/', 'PNG with logo');
  svg = (await download('#qg-svg')).buf.toString('utf8');
  assert.match(svg, /<image [^>]*xlink:href="data:image\/png;base64,/);
  // The largest logo still decodes with a longer link.
  const long = 'https://example.com/products/spring-collection?utm_source=poster';
  await page.fill('#qg-url', long);
  await page.fill('#qg-logo-size', '25');
  assert.equal(await page.textContent('#qg-logo-size-out'), '25%');
  await decodesTo('#qg-png', long, 'PNG with 25% logo');
  await decodesTo('#qg-svg', long, 'SVG with 25% logo');
  await page.click('#qg-logo-remove');
  assert.equal(await page.isDisabled('#qg-ecl'), false);
  assert.equal(await page.inputValue('#qg-ecl'), 'L', 'the chosen level comes back');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qg-logo-choose');
  // A non-image file is refused with a clear message.
  await page.setInputFiles('#qg-logo-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  assert.match(await err(), /"notes.txt" is not a PNG, JPG, WebP, GIF or SVG image/);
  await page.fill('#qg-url', 'https://example.com/');
  assert.equal(await err(), '');

  // ----- Capacity: 2,953 bytes fit at level L (version 40), one more does not -----
  await pick('text');
  await page.fill('#qg-text', 'a'.repeat(2953));
  assert.equal(await modules(), 177);
  assert.match(await warn(), /dense code \(version 40\)/);
  await page.fill('#qg-text', 'a'.repeat(2954));
  assert.match(await err(), /2,954 bytes, and the maximum at error correction L is 2,953 bytes/);
  assert.equal(await page.isDisabled('#qg-svg'), true);
  await page.selectOption('#qg-ecl', 'M');
  await page.fill('#qg-text', 'Short again');
  assert.equal(await err(), '');

  // ----- Copy image puts a PNG on the clipboard -----
  await page.click('#qg-copy-img');
  await page.waitForFunction(() => document.querySelector('#qg-copy-img').textContent === 'Copied!');
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType('image/png');
    return blob.size > 100 ? blob.type : null;
  });
  assert.equal(clip, 'image/png');

  // ----- Screen readers: one short summary once typing pauses -----
  await page.evaluate(() => {
    window.__live = [];
    new MutationObserver(ms => ms.forEach(m => {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const r = n && n.closest('[aria-live]:not([aria-live="off"]), [role=status], [role=alert]');
      if (r && r.id !== 'qg-copy-img' && r.textContent) window.__live.push(r.id + ':' + r.textContent);
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.fill('#qg-text', '');
  await page.type('#qg-text', 'Hello there!');
  await page.waitForFunction(() => document.querySelector('#qg-status').textContent === 'QR code updated: version 1, 12 bytes.');
  await page.waitForTimeout(300);
  const live = await page.evaluate(() => window.__live.filter(t => !t.startsWith(':')));
  assert.deepEqual(live, ['qg-status:QR code updated: version 1, 12 bytes.'], JSON.stringify(live));
  for (const sel of ['#qg-payload', '#qg-meta', '#qg-warn']) assert.equal(await page.getAttribute(sel, 'aria-live'), null, `${sel} is not live`);
};
