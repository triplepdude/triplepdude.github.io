const fs = require('fs');
const path = require('path');

// The images in tests/fixtures/qr-code-scanner/ were encoded with segno and each one was read
// back with zxing-cpp (make_fixtures.py), so expected.json holds what an independent reader sees.
// IBAN and EMV checksums there were worked out in Python. The camera is fed either Chromium's fake
// camera (no code in sight) or a canvas stream that shows one of the fixture images.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const want = name => expected[name].texts[0];
  const text = s => page.locator(s).textContent();
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const fresh = p => p.evaluate(() => { document.querySelector('#qs-status').textContent = ''; document.querySelector('#qs-error').textContent = ''; });
  const done = (p, timeout = 30000) => p.waitForFunction(() => {
    const s = document.querySelector('#qs-status').textContent, e = document.querySelector('#qs-error').textContent;
    return (/^Found/.test(s) || e !== '') && !/^Reading/.test(s);
  }, null, { timeout });
  const scan = async (files, p = page) => {
    await fresh(p);
    await p.setInputFiles('#qs-file', files.map(f => path.join(fixtures, f)));
    await done(p);
  };
  // Every result card, keyed by the file it came from.
  const cards = async (p = page) => {
    const list = await p.$$eval('.qs-card', cs => cs.map(c => ({
      label: c.querySelector('h3').textContent.replace(/^\d+\. /, ''),
      meta: c.querySelector('.qs-meta').textContent,
      head: c.querySelector('.qs-domain strong') ? c.querySelector('.qs-domain strong').textContent : null,
      warnings: [...c.querySelectorAll('.qs-warn li:not(.qs-good)')].map(li => li.textContent),
      goods: [...c.querySelectorAll('.qs-warn li.qs-good')].map(li => li.textContent),
      fields: Object.fromEntries([...c.querySelectorAll(':scope > .qs-fields dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])),
      raw: c.querySelector('.qs-raw').textContent,
      links: [...c.querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.getAttribute('href'), target: a.target, rel: a.rel })),
      buttons: [...c.querySelectorAll('button')].map(b => b.textContent),
    })));
    const by = {};
    for (const c of list) by[c.meta.split(' \u00b7 ')[1]] = c;
    return { list, by };
  };
  const cardButton = (file, label) => page.locator('.qs-card', { has: page.locator('.qs-meta', { hasText: file }) }).getByRole('button', { name: label, exact: true });
  const download = async (file, label) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), cardButton(file, label).click()]);
    return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
  };

  // ---- Starting state ----
  await open();
  // Playwright sees a file chooser only once it intercepts them. Switched on together with the key
  // press that opens one, it sometimes comes too late (about one run in three after a few scans), so
  // a listener keeps it on for the whole test.
  page.on('filechooser', () => {});
  assert.equal(await page.isVisible('#qs-placeholder'), true);
  assert.equal(await page.isVisible('#qs-results'), false);
  assert.equal(await page.isVisible('#qs-history'), false);
  assert.equal(await page.isVisible('#qs-cam-opts'), false);
  assert.match(await text('#qs-engine'), /no built-in barcode reader/);
  assert.equal(await page.getAttribute('#qs-error', 'role'), 'alert');
  assert.equal(await page.getAttribute('#qs-status', 'role'), 'status');

  // The sample code on the page, from the keyboard.
  await page.focus('#qs-sample');
  await fresh(page);
  await page.keyboard.press('Enter');
  await done(page);
  let r = await cards();
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].label, 'Web link');
  assert.equal(r.list[0].head, 'example.com');
  assert.equal(r.list[0].raw, 'https://example.com/menu?table=12');
  assert.deepEqual(r.list[0].links, [{ text: 'Open example.com', href: 'https://example.com/menu?table=12', target: '_blank', rel: 'noopener noreferrer' }]);
  assert.equal(await text('#qs-status'), 'Found: Web link, example.com.');
  assert.equal(await page.isVisible('#qs-view'), true);
  assert.equal(await page.isVisible('#qs-placeholder'), false);

  // Every decoded picture must be released once it has been scanned and drawn: until then the
  // decoder holds its pixels in its worker and on the page (46 MB for a 12-megapixel photo), and
  // two batches of 20 phone photos once took the tab to 2.3 GB. Each decode() result is recorded,
  // and marked when the page hands it to release().
  await page.evaluate(() => {
    const T = window.TTImage, decode = T.decode, release = T.release;
    window.__qsPics = [];
    T.decode = async function () { const res = await decode.apply(this, arguments); window.__qsPics.push({ res, freed: false }); return res; };
    T.release = function (res) { window.__qsPics.forEach(p => { if (p.res === res) p.freed = true; }); return release.apply(this, arguments); };
  });
  const pics = () => page.evaluate(() => ({ decoded: window.__qsPics.length, kept: window.__qsPics.filter(p => !p.freed).length }));

  // ---- One code per payload type, 20 files at once ----
  const types = ['wifi.png', 'vcard.png', 'text.png', 'latin1.png', 'kanji.png', 'mecard.png', 'mailto.png', 'tel.png', 'sms.png', 'geo.png',
    'event.png', 'otp.png', 'upi.png', 'bitcoin.png', 'epc.png', 'epc-bad.png', 'emv.png', 'emv-bad.png', 'binary.png', 'plain-note.png'];
  await scan(types);
  assert.equal(await text('#qs-status'), 'Found 20 codes in 20 images.');
  assert.equal(await text('#qs-error'), '');
  ({ by: r } = await cards());
  for (const f of types) if (f !== 'binary.png') assert.equal(r[f].raw, want(f), `${f}: text read`);
  assert.equal(await text('#qs-results-h'), 'Results (20)');
  assert.deepEqual(await pics(), { decoded: 20, kept: 0 }, 'every picture of the batch is released');

  // Wi-Fi: Latin-1 bytes without a character set, escaped \" \; \: \\ (wifi.png).
  assert.equal(r['wifi.png'].label, 'Wi-Fi network');
  assert.equal(r['wifi.png'].head, 'Caf\u00e9 "Corner"');
  assert.deepEqual(r['wifi.png'].fields, { Password: 'pa;ss:wo\\rd', Security: 'WPA, WPA2 or WPA3 Personal', 'Hidden network': 'Yes' });
  await cardButton('wifi.png', 'Copy password').click();
  assert.equal(await clip(), 'pa;ss:wo\\rd');
  // UTF-8 with an ECI header, CR LF kept exactly when copied.
  await cardButton('text.png', 'Copy text').click();
  assert.equal(await clip(), want('text.png'));
  assert.ok(want('text.png').includes('\u{1F44B}\r\n'));
  assert.equal(r['text.png'].fields.Length, '20 characters');
  assert.equal(r['text.png'].fields.Lines, '3');
  // Windows-1252 bytes (jsQR alone returns nothing for them) and Kanji mode.
  assert.equal(r['latin1.png'].raw, 'Cr\u00e8me br\u00fbl\u00e9e \u2013 5 \u20ac');
  assert.equal(r['kanji.png'].raw, '\u65e5\u672c\u8a9e');
  // vCard: fields, and the .vcf is the code's text byte for byte (CR LF line ends).
  assert.equal(r['vcard.png'].head, 'Dr Zo\u00eb \u00c5ngstr\u00f6m');
  assert.equal(r['vcard.png'].fields.Organisation, '\u00c5ngstr\u00f6m & Co, Ltd');
  assert.equal(r['vcard.png'].fields.Address, '1 High Street, Oxford, OX1 1AA, United Kingdom');
  assert.equal(r['vcard.png'].fields.Note, 'Line one\nLine two');
  assert.deepEqual(await page.$$eval('.qs-card:has(.qs-meta:text("vcard.png")) dt', dts => dts.filter(d => d.textContent === 'Phone').map(d => d.nextElementSibling.textContent)),
    ['+44 7700 900123 (mobile)', '+44 1632 960000 (work)']);
  let dl = await download('vcard.png', 'Save contact (.vcf)');
  assert.equal(dl.name, 'dr-zoe-angstrom.vcf');
  assert.equal(dl.bytes.toString('utf8'), want('vcard.png'));
  // MECARD becomes a vCard 3.0 file; an escaped colon in the URL is read as a colon.
  assert.equal(r['mecard.png'].head, 'Jane Doe');
  assert.equal(r['mecard.png'].fields.Website, 'https://example.com');
  dl = await download('mecard.png', 'Save contact (.vcf)');
  assert.equal(dl.bytes.toString('utf8'), 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nTEL:+15551230000\r\nEMAIL:jane@example.com\r\nURL:https://example.com\r\nEND:VCARD\r\n');
  // Email, phone, text message and place open the matching app; nothing else is a link.
  assert.deepEqual(r['mailto.png'].fields, { To: 'ana@example.com', Subject: 'Hello there', Message: 'Line 1\r\nLine 2' });
  assert.equal(r['mailto.png'].links[0].href, 'mailto:ana@example.com?subject=Hello%20there&body=Line%201%0D%0ALine%202');
  assert.deepEqual(r['tel.png'].links.map(l => [l.text, l.href]), [['Call +441632960123', 'tel:+441632960123']]);
  assert.deepEqual(r['sms.png'].fields, { To: '+15551234567', Message: 'Hello there' });
  assert.equal(r['sms.png'].links[0].href, 'sms:+15551234567?body=Hello%20there');
  assert.deepEqual(r['geo.png'].fields, { Latitude: '51.50070', Longitude: '-0.12460' });
  assert.equal(r['geo.png'].links[0].href, 'https://www.openstreetmap.org/?mlat=51.50070&mlon=-0.12460#map=17/51.50070/-0.12460');
  // Event: UTC times, and an .ics wrapped in VCALENDAR with CR LF line ends.
  assert.equal(r['event.png'].head, 'Carol concert');
  assert.equal(r['event.png'].fields.Place, 'Town hall, Main Street');
  const startUtc = await page.evaluate(() => new Date(Date.UTC(2026, 11, 24, 18)).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }));
  assert.equal(r['event.png'].fields.Starts, startUtc);
  dl = await download('event.png', 'Save event (.ics)');
  assert.equal(dl.name, 'carol-concert.ics');
  assert.equal(dl.bytes.toString('utf8'), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TripleP Tools//QR Code Scanner//EN\r\n' + want('event.png').replace(/\r?\n/g, '\r\n') + '\r\nEND:VCALENDAR\r\n');
  // Two-step key: the secret stays folded away until asked for.
  assert.equal(r['otp.png'].label, 'Two-step sign-in key');
  assert.deepEqual(r['otp.png'].fields, { Service: 'Example Co', Account: 'alice@example.com', Type: 'Time-based (TOTP), a new code every 30 seconds', Digits: '6', Algorithm: 'SHA1' });
  assert.match(r['otp.png'].warnings[0], /anyone who sees it can create your sign-in codes/);
  const otpCard = page.locator('.qs-card', { has: page.locator('.qs-meta', { hasText: 'otp.png' }) });
  assert.equal(await otpCard.getByText('JBSWY3DPEHPK3PXP', { exact: true }).isVisible(), false);
  await otpCard.locator('summary').click();
  assert.equal(await otpCard.getByText('JBSWY3DPEHPK3PXP', { exact: true }).isVisible(), true);
  // Payments: UPI, crypto, SEPA with IBAN mod 97, EMV with CRC-16 (both checked in Python).
  assert.equal(r['upi.png'].head, 'Example Store');
  assert.deepEqual(r['upi.png'].fields, { 'UPI ID': 'merchant@examplebank', Amount: '249.00 INR', Note: 'Order 42' });
  assert.equal(r['bitcoin.png'].head, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  assert.equal(r['bitcoin.png'].fields.Amount, '0.0015');
  assert.equal(r['epc.png'].head, 'Example Supplies GmbH');
  assert.equal(r['epc.png'].fields.IBAN, 'DE89 3704 0044 0532 0130 00');
  assert.equal(r['epc.png'].fields.Amount, '123.45 EUR');
  assert.deepEqual(r['epc.png'].goods, ['Checked: IBAN checksum is correct.']);
  assert.deepEqual(r['epc.png'].warnings, []);
  assert.equal(r['epc-bad.png'].goods.length, 0);
  assert.match(r['epc-bad.png'].warnings.join(), /IBAN checksum does not match/);
  await cardButton('epc.png', 'Copy IBAN').click();
  assert.equal(await clip(), expected._checks.good_iban);
  assert.equal(r['emv.png'].head, 'Loja Exemplo');
  assert.equal(r['emv.png'].fields.Amount, '10.50 BRL');
  assert.equal(r['emv.png'].fields['Payment network'], 'Pix (Brazil)');
  assert.equal(r['emv.png'].fields.Reference, 'REF123');
  assert.deepEqual(r['emv.png'].goods, ['Checked: Checksum (CRC) is correct.']);
  assert.match(r['emv-bad.png'].warnings.join(), /checksum does not match/);
  assert.equal(r['emv-bad.png'].fields.Amount, '90.50 BRL');
  // Binary data is shown as hex and downloaded byte for byte.
  assert.equal(r['binary.png'].label, 'Binary data');
  assert.equal(r['binary.png'].raw, expected['binary.png'].hex.match(/../g).join(' '));
  dl = await download('binary.png', 'Download .bin');
  assert.equal(dl.bytes.toString('hex'), expected['binary.png'].hex);
  assert.equal(r['plain-note.png'].label, 'Text');

  // ---- Links: the domain comes first, and risky ones are flagged ----
  await scan(['phishy.png', 'short.png', 'idn.png', 'js.png', 'apk.png', 'www.png', 'fido.png', 'url.png', 'eci-cp1251.png',
    'fake-wifi.png', 'bom-wifi.png', 'emoji-long.png']);
  ({ by: r } = await cards());
  // Starting like a Wi-Fi code is not enough; a byte order mark in front does not hide one.
  assert.equal(r['fake-wifi.png'].label, 'Text');
  assert.equal(r['fake-wifi.png'].raw, want('fake-wifi.png'));
  assert.equal(r['bom-wifi.png'].label, 'Wi-Fi network');
  assert.equal(r['bom-wifi.png'].head, 'Home');
  assert.equal(r['bom-wifi.png'].raw, want('bom-wifi.png'));
  assert.equal(r['emoji-long.png'].raw, want('emoji-long.png'));
  // "Mood ", 60 faces, then 20 times a space and a thumb with a skin tone: 5 + 60 + 20 * 2
  // characters as people see them.
  assert.equal(r['emoji-long.png'].fields.Length, '105 characters');
  // Windows-1251 bytes behind an ECI 22 header: only right if the declared character set is used.
  assert.equal(r['eci-cp1251.png'].raw, want('eci-cp1251.png'));
  assert.equal(r['phishy.png'].head, '203.0.113.9');
  assert.equal(r['phishy.png'].warnings.length, 4);
  for (const re of [/^Warning: Not encrypted/, /part before the @ \(paypal\.com\) is not the website/, /IP number/, /unusual port \(:8080\)/]) assert.ok(r['phishy.png'].warnings.some(w => re.test(w)), String(re));
  assert.equal(r['phishy.png'].links[0].text, 'Open 203.0.113.9');
  assert.match(r['short.png'].warnings.join(), /short link/);
  assert.equal(r['idn.png'].head, 'xn--pple-43d.com');
  assert.equal(r['idn.png'].fields['Written in the code as'], '\u0430pple.com');
  assert.match(r['idn.png'].warnings.join(), /another alphabet/);
  assert.equal(r['js.png'].label, 'Not a web link');
  assert.deepEqual(r['js.png'].links, []);
  assert.match(r['js.png'].warnings.join(), /script \(javascript:\)/);
  assert.match(r['apk.png'].warnings.join(), /\(\.apk\)/);
  assert.equal(r['www.png'].label, 'Web address');
  assert.equal(r['www.png'].links[0].href, 'https://www.example.com/menu');
  assert.equal(r['fido.png'].label, 'Passkey sign-in code');
  assert.deepEqual(r['url.png'].warnings, []);
  assert.deepEqual(r['url.png'].goods, []);

  // ---- Hard pictures ----
  await scan(['inverted.png', 'tiny.png', 'nomargin.png', 'transparent.png', 'code.webp', 'code.gif', 'code.heic', 'screenshot.png']);
  assert.equal(await text('#qs-error'), '');
  ({ by: r } = await cards());
  for (const f of ['inverted.png', 'tiny.png', 'nomargin.png', 'transparent.png', 'code.webp', 'code.gif', 'code.heic', 'screenshot.png']) assert.equal(r[f].raw, want(f), f);
  // A sideways-stored JPEG (EXIF orientation 6) is shown upright.
  await scan(['photo.jpg']);
  ({ list: r } = await cards());
  assert.equal(r[0].raw, want('photo.jpg'));
  const vw = await page.$eval('#qs-view', c => [c.width, c.height]);
  assert.ok(vw[0] > vw[1], `photo shown upright (${vw})`);
  assert.equal(Math.round(vw[0] / vw[1] * 100), Math.round(expected['photo.jpg'].width / expected['photo.jpg'].height * 100));
  // Three codes in one picture, in reading order and outlined with numbers.
  await scan(['multi.png']);
  ({ list: r } = await cards());
  assert.deepEqual(r.map(c => c.raw), expected['multi.png'].texts);
  assert.deepEqual(r.map(c => c.meta.split(' \u00b7 ')[1]), ['multi.png, code 1', 'multi.png, code 2', 'multi.png, code 3']);
  assert.equal(await page.getAttribute('#qs-view', 'aria-label'), 'multi.png: 3 codes found and outlined');
  // Six codes in a grid: all are read (the whole-picture pass alone found four), in reading order.
  await scan(['grid6.png']);
  ({ list: r } = await cards());
  assert.deepEqual(r.map(c => c.raw), expected['grid6.png'].texts);
  assert.equal(await text('#qs-status'), 'Found 6 codes.');
  // Three in a row, where the pass over the whole picture reads only one: the windows read after it
  // find the other two.
  await scan(['row3.png']);
  ({ list: r } = await cards());
  assert.deepEqual(r.map(c => c.raw), expected['row3.png'].texts);
  // Ten codes: the page reads eight from one picture, says so, and repeats none.
  await scan(['grid10.png']);
  ({ list: r } = await cards());
  assert.equal(r.length, 8);
  assert.equal(new Set(r.map(c => c.raw)).size, 8);
  for (const c of r) assert.ok(expected['grid10.png'].texts.includes(c.raw), c.raw);
  assert.equal(await text('#qs-status'), 'Found 8 codes. At most 8 codes are read from one picture: crop it to read the others.');
  // A 24-megapixel picture is read without freezing the page.
  await page.evaluate(() => {
    window.__qsLong = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__qsLong.push(e.duration))).observe({ entryTypes: ['longtask'] });
  });
  const t0 = Date.now();
  await scan(['big.png']);
  assert.equal((await cards()).list[0].raw, want('big.png'));
  const blocked = await page.evaluate(() => Math.max(0, ...window.__qsLong));
  assert.ok(Date.now() - t0 < 15000, `big picture took ${Date.now() - t0} ms`);
  assert.ok(blocked < 1500, `main thread blocked for ${Math.round(blocked)} ms`);
  // A scan replaced by a newer one releases its picture too.
  let n0 = (await pics()).decoded;
  await fresh(page);
  await page.setInputFiles('#qs-file', path.join(fixtures, 'big.png'));
  await page.setInputFiles('#qs-file', path.join(fixtures, 'url.png'));
  await done(page);
  assert.equal(await text('#qs-status'), 'Found: Web link, example.com.');
  assert.equal(await page.getAttribute('#qs-view', 'aria-label'), 'url.png: 1 code found and outlined');
  await page.waitForFunction(n => window.__qsPics.length === n && window.__qsPics.every(p => p.freed), n0 + 2, { timeout: 30000 });

  // ---- A busy photo without a code ----
  // A 12-megapixel JPEG of fine noise, made on the page. jsQR finds nothing in it, but its five
  // passes once took 99 s while the status said only "Reading noise.jpg…". Now the status says
  // that the page is looking more closely, and the reading stops after 15 s.
  const seen = [];
  await page.exposeFunction('qsSeen', t => seen.push(t));
  await page.evaluate(() => new MutationObserver(() => window.qsSeen(document.querySelector('#qs-status').textContent))
    .observe(document.querySelector('#qs-status'), { childList: true, characterData: true, subtree: true }));
  const dropNoise = () => page.evaluate(async () => {
    if (!window.__qsNoise) {
      const W = 4000, H = 3000, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
      let x = 2463534242;
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        const v = 110 + (i % W) / W * 40;
        d[j] = v + ((x & 255) - 128) * 0.9; d[j + 1] = v + (((x >>> 8) & 255) - 128) * 0.9; d[j + 2] = v + (((x >>> 16) & 255) - 128) * 0.9; d[j + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      window.__qsNoise = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
      c.width = 0;
    }
    const dt = new DataTransfer();
    dt.items.add(new File([window.__qsNoise], 'noise.jpg', { type: 'image/jpeg' }));
    document.querySelector('#qs-stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const closer = 'Reading noise.jpg\u2026 No code found yet; looking more closely (this can take several seconds).';
  await fresh(page);
  let t1 = Date.now();
  await dropNoise();
  await done(page, 90000);
  const noiseMs = Date.now() - t1;
  assert.match(await text('#qs-error'), /^No QR code found in noise\.jpg\. Make sure the whole code/);
  assert.ok(seen.includes(closer), JSON.stringify(seen));
  assert.ok(noiseMs < 35000, `noise.jpg was read for ${noiseMs} ms`);
  // A picture added while a slow one is read is read at once: the old reading is dropped (it held
  // the reader for up to 15 s), and its picture released.
  n0 = (await pics()).decoded;
  await fresh(page);
  await dropNoise();
  await page.waitForFunction(t => document.querySelector('#qs-status').textContent === t, closer, { timeout: 30000 });
  t1 = Date.now();
  await page.setInputFiles('#qs-file', path.join(fixtures, 'url.png'));
  await page.waitForFunction(() => /^Found/.test(document.querySelector('#qs-status').textContent), null, { timeout: 30000 });
  const quickMs = Date.now() - t1;
  assert.ok(quickMs < 8000, `url.png waited ${quickMs} ms behind the reading of noise.jpg`);
  assert.equal(await text('#qs-status'), 'Found: Web link, example.com.');
  assert.equal(await text('#qs-error'), '');
  await page.waitForFunction(n => window.__qsPics.length === n && window.__qsPics.every(p => p.freed), n0 + 2, { timeout: 30000 });

  // ---- Nothing found, not an image ----
  const histBefore = await page.locator('#qs-hist-body tr').count();
  await scan(['none.png']);
  assert.match(await text('#qs-error'), /^No QR code found in none\.png\. /);
  assert.equal(await page.getAttribute('#qs-view', 'aria-label'), 'none.png: no code found');
  await scan(['notes.txt']);
  assert.match(await text('#qs-error'), /^notes\.txt: this is not an image the page can read/);
  assert.equal(await page.locator('#qs-hist-body tr').count(), histBefore);

  // ---- Choose image from the keyboard ----
  await fresh(page);
  await page.focus('#qs-open');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(path.join(fixtures, 'geo.png'));
  await done(page);
  assert.equal((await cards()).list[0].raw, want('geo.png'));

  // ---- Paste and drop ----
  const urlPng = fs.readFileSync(path.join(fixtures, 'url.png')).toString('base64');
  await fresh(page);
  await page.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, urlPng);
  await done(page);
  ({ list: r } = await cards());
  assert.equal(r[0].raw, want('url.png'));
  assert.match(r[0].meta, /Pasted image/);
  // Pasting text, even a megabyte of it, is refused at once.
  await fresh(page);
  const pasteMs = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'x '.repeat(512 * 1024));
    const t = performance.now();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return performance.now() - t;
  });
  assert.ok(pasteMs < 100, `text paste took ${pasteMs} ms`);
  assert.match(await text('#qs-error'), /^The clipboard holds text, not a picture/);
  // The Paste image button reads the clipboard (stubbed with a picture, then with text only).
  await fresh(page);
  await page.evaluate(b64 => {
    const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/png' });
    navigator.clipboard.read = async () => [{ types: ['text/html', 'image/png'], getType: async () => blob }];
  }, fs.readFileSync(path.join(fixtures, 'tel.png')).toString('base64'));
  await page.click('#qs-paste');
  await done(page);
  assert.equal((await cards()).list[0].raw, want('tel.png'));
  // Ctrl+V still scans a picture after the Keep scanning box was clicked (the paste event then
  // comes from that checkbox; only text fields keep their own paste).
  await fresh(page);
  await page.click('#qs-continuous');
  await page.click('#qs-continuous');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qs-continuous');
  await page.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, fs.readFileSync(path.join(fixtures, 'geo.png')).toString('base64'));
  await done(page);
  assert.equal((await cards()).list[0].raw, want('geo.png'));
  await page.evaluate(() => { navigator.clipboard.read = async () => [{ types: ['text/plain'], getType: async () => new Blob(['hi']) }]; });
  await fresh(page);
  await page.click('#qs-paste');
  await page.waitForFunction(() => document.querySelector('#qs-error').textContent !== '');
  assert.match(await text('#qs-error'), /holds no picture/);
  await page.evaluate(() => { navigator.clipboard.read = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
  await page.click('#qs-paste');
  await page.waitForFunction(() => /did not allow/.test(document.querySelector('#qs-error').textContent));
  // Dropping a file anywhere on the page scans it instead of opening it.
  await fresh(page);
  await page.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }));
    const stage = document.querySelector('#qs-stage');
    stage.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.__qsOver = stage.classList.contains('is-over');
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    stage.dispatchEvent(ev);
    window.__qsPrevented = ev.defaultPrevented;
  }, fs.readFileSync(path.join(fixtures, 'sms.png')).toString('base64'));
  await done(page);
  assert.deepEqual(await page.evaluate(() => [window.__qsOver, window.__qsPrevented]), [true, true]);
  ({ list: r } = await cards());
  assert.equal(r[0].raw, want('sms.png'));
  assert.match(r[0].meta, /dropped\.png/);

  // Every picture decoded so far, by every route in, has been released.
  assert.equal((await pics()).kept, 0, 'a decoded picture was kept');

  // ---- History ----
  const histRows = () => page.$$eval('#qs-hist-body tr', trs => trs.map(t => [t.querySelector('.qs-hist-type').textContent, t.querySelector('.qs-hist-clip').textContent]));
  let rows = await histRows();
  assert.equal(rows.length, 1 + 20 + 12 + 8 + 1 + 3 + 6 + 3 + 8 + 1 + 2 + 1 + 1 + 1 + 1 + 1);
  // The table never shows a two-step secret key (it is folded away on the card too); copying the
  // row still gives the whole text. Each row shows the scan's number that its buttons are named by.
  const histText = await page.textContent('#qs-hist-body');
  assert.ok(!histText.includes('JBSWY3DPEHPK3PXP'), 'secret key shown in the history');
  const otpRow = rows.find(x => x[0] === 'Two-step sign-in key');
  assert.ok(otpRow[1].startsWith('otpauth://totp/Example%20Co:alice@example.com?secret=[hidden]&issuer='), otpRow[1]);
  assert.match(await page.$eval('#qs-hist-body tr:last-child .qs-hist-when', s => s.textContent), /^#1 \u00b7 \d\d:\d\d:\d\d$/);
  const otpNo = await page.$$eval('#qs-hist-body tr', trs => trs.find(t => t.querySelector('.qs-hist-type').textContent === 'Two-step sign-in key').querySelector('.qs-hist-when').textContent.match(/^#(\d+)/)[1]);
  await page.getByRole('button', { name: 'Copy scan ' + otpNo, exact: true }).click();
  assert.equal(await clip(), want('otp.png'));
  // Shortened without cutting an emoji (a surrogate pair) or a skin-tone sequence in half.
  const emojiRow = rows.find(x => x[1].startsWith('Mood \u{1F600}'));
  assert.ok(emojiRow[1].endsWith('\u2026'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiRow[1]), 'no lone surrogate');
  assert.ok(!/\u{1F44D}\u2026$/u.test(emojiRow[1]), 'skin tone kept with its hand');
  assert.deepEqual(rows[0], ['Text message', 'SMSTO:+15551234567:Hello there']);
  assert.deepEqual(rows[rows.length - 1], ['Web link', 'https://example.com/menu?table=12']);
  // Long texts are shortened for the table without splitting characters.
  const vcardRow = rows.find(x => x[0] === 'Contact' && x[1].startsWith('BEGIN:VCARD VERSION:3.0 N:'));
  assert.ok(vcardRow && vcardRow[1].endsWith('\u2026') && vcardRow[1].length <= 91, vcardRow);
  await page.getByRole('button', { name: 'Copy scan 1', exact: true }).click();
  assert.equal(await clip(), 'https://example.com/menu?table=12');
  await page.getByRole('button', { name: 'Show scan 3', exact: true }).click();
  ({ list: r } = await cards());
  assert.equal(r.length, 1);
  assert.equal(r[0].label, 'Contact');
  assert.equal(await page.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.textContent), 'H3:Contact');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#qs-csv')]);
  assert.equal(csv.suggestedFilename(), 'qr-scan-history.csv');
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(csvText.startsWith('\uFEFFtime,source,format,type,text\r\n'));
  const csvLines = csvText.slice(1).split('\r\n');
  assert.match(csvLines[1], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,Sample code,QR code,Web link,https:\/\/example\.com\/menu\?table=12$/);
  assert.ok(csvText.includes(',Wi-Fi network,"WIFI:T:WPA;S:Caf\u00e9 \\""Corner\\"";P:pa\\;ss\\:wo\\\\rd;H:true;;"\r\n'), 'quotes doubled in CSV');
  await page.click('#qs-copy-all');
  const all = await clip();
  assert.ok(all.startsWith('https://example.com/menu?table=12\n\nWIFI:'), all.slice(0, 60));
  await page.click('#qs-clear');
  assert.equal(await page.isVisible('#qs-history'), false);
  assert.equal(await text('#qs-status'), 'History cleared.');

  // ---- Camera ----
  await page.evaluate(() => {
    const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
    window.__gum = { calls: [], streams: [] };
    window.__gumSource = null;
    md.getUserMedia = async c => {
      window.__gum.calls.push(JSON.parse(JSON.stringify(c)));
      const s = window.__gumSource ? window.__gumSource() : await orig(c);
      window.__gum.streams.push(s);
      return s;
    };
  });
  const allEnded = () => page.evaluate(() => window.__gum.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
  // Chromium's fake camera, started from the keyboard: the back camera is asked for, the preview
  // and frame marks show, nothing is found in its test pattern, and Stop releases it.
  await page.focus('#qs-camera');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Camera on/.test(document.querySelector('#qs-status').textContent));
  assert.deepEqual(await page.evaluate(() => window.__gum.calls[0].video.facingMode), { ideal: 'environment' });
  assert.equal(await text('#qs-camera'), 'Stop camera');
  assert.equal(await page.isVisible('#qs-video'), true);
  assert.equal(await page.isVisible('#qs-frame'), true);
  assert.equal(await page.isVisible('#qs-torch'), false);
  assert.equal(await page.isVisible('#qs-zoom-field'), false);
  // The camera list shows only when there is more than one camera to choose from.
  const cameras = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length);
  await page.waitForFunction(n => document.querySelector('#qs-device').options.length === n + 1, cameras);
  assert.equal(await page.isVisible('#qs-device'), cameras > 1);
  assert.equal(await page.isVisible('#qs-cam-opts'), cameras > 1);
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.qs-card').count(), 1, 'nothing found in the fake camera picture');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qs-camera');
  await page.keyboard.press('Enter');
  assert.equal(await text('#qs-status'), 'Camera off.');
  assert.equal(await text('#qs-camera'), 'Start camera');
  assert.equal(await allEnded(), true);

  // A camera that shows a QR code (a canvas stream of url.png). The code is read, the frame is
  // kept with the code outlined, and the camera is released.
  const canvasCamera = async (files, opts = {}) => page.evaluate(async ([imgs, o]) => {
    const pics = await Promise.all(imgs.map(async b64 => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); return i; }));
    window.__gumSource = () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      const t0 = performance.now();
      const draw = () => {
        const pic = pics[Math.floor((performance.now() - t0) / 1500) % pics.length];
        g.fillStyle = '#6b6b6b'; g.fillRect(0, 0, 640, 480);
        g.drawImage(pic, 200, 120, 240, 240);
        if (!s || s.getVideoTracks()[0].readyState === 'live') requestAnimationFrame(draw);
      };
      let s = null;
      draw();
      s = c.captureStream(15);
      const tr = s.getVideoTracks()[0];
      if (o.caps) {
        window.__applied = [];
        tr.getCapabilities = () => o.caps;
        tr.applyConstraints = async x => { window.__applied.push(x); };
      }
      return s;
    };
  }, [files.map(f => fs.readFileSync(path.join(fixtures, f)).toString('base64')), opts]);
  await canvasCamera(['url.png']);
  await fresh(page);
  await page.click('#qs-camera');
  await page.waitForFunction(() => /^Found/.test(document.querySelector('#qs-status').textContent), null, { timeout: 10000 });
  assert.equal(await text('#qs-status'), 'Found: Web link, example.com. The camera is off; press Scan another code to read more.');
  ({ list: r } = await cards());
  assert.equal(r[0].raw, want('url.png'));
  assert.match(r[0].meta, /QR code \u00b7 Camera \u00b7/);
  assert.equal(await text('#qs-camera'), 'Scan another code');
  assert.equal(await page.isVisible('#qs-view'), true);
  assert.equal(await page.isVisible('#qs-video'), false);
  assert.equal(await allEnded(), true);
  assert.equal(await page.getAttribute('#qs-view', 'aria-label'), 'Camera picture: 1 code found and outlined');

  // Keep scanning: two codes in turn are each added once, while the camera stays on.
  await page.check('#qs-continuous');
  await canvasCamera(['tel.png', 'sms.png']);
  await page.click('#qs-camera');
  await page.waitForFunction(() => /2 codes found so far/.test(document.querySelector('#qs-status').textContent), null, { timeout: 15000 });
  await page.waitForTimeout(1600);
  ({ list: r } = await cards());
  assert.deepEqual(r.map(c => c.raw).sort(), [want('sms.png'), want('tel.png')].sort());
  assert.equal(await page.locator('#qs-hist-body tr').count(), 3);
  assert.equal(await text('#qs-camera'), 'Stop camera');
  await page.click('#qs-camera');
  assert.equal(await allEnded(), true);
  await page.uncheck('#qs-continuous');

  // Torch and zoom appear only when the camera offers them, and are applied to the track.
  await canvasCamera(['none.png'], { caps: { torch: true, zoom: { min: 1, max: 5, step: 0.5 } } });
  await page.click('#qs-camera');
  await page.waitForFunction(() => /^Camera on/.test(document.querySelector('#qs-status').textContent));
  assert.equal(await page.isVisible('#qs-cam-opts'), true);
  assert.equal(await page.isVisible('#qs-torch'), true);
  assert.equal(await page.isVisible('#qs-zoom'), true);
  assert.equal(await page.getAttribute('#qs-torch', 'aria-pressed'), 'false');
  await page.click('#qs-torch');
  await page.waitForFunction(() => document.querySelector('#qs-torch').getAttribute('aria-pressed') === 'true');
  await page.$eval('#qs-zoom', z => { z.value = '2.5'; z.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.deepEqual(await page.evaluate(() => window.__applied), [{ advanced: [{ torch: true }] }, { advanced: [{ zoom: 2.5 }] }]);
  assert.deepEqual(await page.$eval('#qs-zoom', z => [z.min, z.max, z.step]), ['1', '5', '0.5']);
  // Focus on the torch button moves to the camera button when the camera stops and the row hides.
  await page.focus('#qs-torch');
  await page.evaluate(() => window.__gum.streams[window.__gum.streams.length - 1].getVideoTracks()[0].dispatchEvent(new Event('ended')));
  assert.equal(await text('#qs-error'), 'The camera was disconnected or turned off by the system.');
  assert.equal(await page.isVisible('#qs-cam-opts'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qs-camera');

  // Blocked camera: a clear message, and nothing left running.
  await page.evaluate(() => { window.__gumSource = () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await page.click('#qs-camera');
  await page.waitForFunction(() => /^Camera access is blocked/.test(document.querySelector('#qs-error').textContent));
  assert.equal(await text('#qs-camera'), 'Start camera');
  assert.equal(await text('#qs-status'), '');

  // ---- A browser with a built-in BarcodeDetector (stubbed: Chromium on Linux has none) ----
  const p2 = await page.context().newPage();
  const p2errors = [];
  p2.on('pageerror', e => p2errors.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') p2errors.push(m.text()); });
  await p2.addInitScript(() => {
    window.__bdCalls = 0;
    window.__bdNext = [];
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['qr_code', 'ean_13', 'code_128']; }
      constructor(o) { window.__bdFormats = o.formats; }
      async detect() { window.__bdCalls++; return window.__bdNext.shift() || []; }
    };
  });
  await p2.goto(url);
  await p2.waitForFunction(() => /built-in reader/.test(document.querySelector('#qs-engine').textContent));
  assert.equal(await p2.textContent('#qs-engine'), 'Reads QR codes with your browser\u2019s built-in reader, which also reads EAN-13, Code 128 codes.');
  const corners = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 40 }, { x: 10, y: 40 }];
  await p2.evaluate(c => { window.__bdNext = [[{ rawValue: '4006381333931', format: 'ean_13', cornerPoints: c }, { rawValue: '9780306406157', format: 'ean_13', cornerPoints: c }]]; }, corners);
  await scan(['none.png'], p2);
  let r2 = (await cards(p2)).list;
  assert.deepEqual(r2.map(c => [c.label, c.head, c.goods.join(), c.meta.split(' \u00b7 ')[0]]), [
    ['Product number', '4006381333931', 'Checked: Check digit is correct.', 'EAN-13 barcode'],
    ['Book (ISBN)', '9780306406157', 'Checked: Check digit is correct.', 'EAN-13 barcode']]);
  assert.deepEqual(await p2.evaluate(() => window.__bdFormats), ['qr_code', 'ean_13', 'code_128']);
  await p2.evaluate(c => { window.__bdNext = [[{ rawValue: '4006381333932', format: 'ean_13', cornerPoints: c }]]; }, corners);
  await scan(['none.png'], p2);
  r2 = (await cards(p2)).list;
  assert.match(r2[0].warnings.join(), /check digit does not match/);
  // A byte order mark the built-in reader passes on is dropped, so the Wi-Fi code is recognised.
  await p2.evaluate(() => { window.__bdNext = [[{ rawValue: '\uFEFFWIFI:S:Attic;T:nopass;;', format: 'qr_code' }]]; });
  await scan(['none.png'], p2);
  r2 = (await cards(p2)).list;
  assert.deepEqual([r2[0].label, r2[0].head, r2[0].raw, r2[0].fields.Security], ['Wi-Fi network', 'Attic', 'WIFI:S:Attic;T:nopass;;', 'None (open network)']);
  // Texts read through the stub: the meaning is worked out the same way as for jsQR's results.
  const classifyAll = async texts => {
    await p2.evaluate(ts => { window.__bdNext = [ts.map(t => ({ rawValue: t, format: 'qr_code' }))]; }, texts);
    await scan(['none.png'], p2);
    return (await cards(p2)).list;
  };
  const day = (y, m, d) => p2.evaluate(([y, m, d]) => new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' (all day)', [y, m, d]);
  r2 = await classifyAll([
    // All-day events: DTEND is the day after the last day (RFC 5545 3.6.1).
    'BEGIN:VEVENT\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261225\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20261228\r\nDTEND;VALUE=DATE:20270101\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nSUMMARY:Leap\r\nDTSTART:20280228\r\nDTEND:20280301\r\nEND:VEVENT',
    // Accented Latin letters are not "another alphabet"; Cyrillic is.
    'https://bücher.de/', 'https://аpple.com/',
    // A script address with a space in it is still a script; text that only starts like one is text.
    "javascript:alert('a b')", 'JavaScript: The Good Parts', 'Data: 42 rows', 'data:text/html,<b>hi</b> there',
    'otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZSABKAEwAhABGAEgACjr4JKK',
  ]);
  assert.deepEqual(r2[0].fields, { Date: await day(2026, 12, 24) });
  assert.deepEqual(r2[1].fields, { 'First day': await day(2026, 12, 28), 'Last day': await day(2026, 12, 31) });
  assert.deepEqual(r2[2].fields, { 'First day': await day(2028, 2, 28), 'Last day': await day(2028, 2, 29) });
  assert.match(r2[3].warnings.join(), /accented letters/);
  assert.doesNotMatch(r2[3].warnings.join(), /another alphabet/);
  assert.match(r2[4].warnings.join(), /letters from another alphabet/);
  assert.deepEqual(r2.slice(5, 9).map(c => c.label), ['Not a web link', 'Text', 'Text', 'Not a web link']);
  assert.match(r2[5].warnings.join(), /script \(javascript:\)/);
  assert.match(r2[8].warnings.join(), /data: address/);
  assert.equal(r2[9].label, 'Authenticator export');
  const migRow = await p2.$eval('#qs-hist-body tr:first-child .qs-hist-clip', s => s.textContent);
  assert.equal(migRow, 'otpauth-migration://offline?data=[hidden]');
  // When the built-in reader finds nothing, jsQR still reads the code.
  await scan(['wifi.png'], p2);
  r2 = (await cards(p2)).list;
  assert.equal(r2[0].raw, want('wifi.png'));
  assert.match(await p2.textContent('#qs-error'), /^$/);
  await p2.evaluate(() => { window.__bdNext = []; });
  await scan(['none.png'], p2);
  assert.match(await p2.textContent('#qs-error'), /^No QR code or barcode found in none\.png/);
  await p2.close();
  assert.deepEqual(p2errors, []);

  // ---- No Web Workers: jsQR runs on the page instead ----
  const p3 = await page.context().newPage();
  await p3.addInitScript(() => { window.Worker = undefined; });
  await p3.goto(url);
  await scan(['multi.png'], p3);
  assert.deepEqual((await cards(p3)).list.map(c => c.raw), expected['multi.png'].texts);
  await p3.close();

  // ---- Phone with a touch screen ----
  const browser = page.context().browser();
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  await phone.goto(url);
  assert.ok((await phone.$eval('#qs-sample', b => b.getBoundingClientRect().height)) >= 44, 'sample button is a 44 px target');
  await phone.tap('#qs-sample');
  await done(phone);
  assert.equal((await cards(phone)).list[0].head, 'example.com');
  const small = await phone.$$eval('.qs-bar .btn, .qs-card .btn, #qs-sample, .qs-hist .btn, #qs-history .actions .btn', bs => bs.filter(b => b.getClientRects().length && b.getBoundingClientRect().height < 44).map(b => b.textContent));
  assert.deepEqual(small, []);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
  // The history table at phone widths: buttons keep their words on one line, and no word of the
  // type or time is split across lines (the table once squeezed "Copy" into a column one letter wide).
  await phone.setInputFiles('#qs-file', ['epc-bad.png', 'phishy.png', 'otp.png', 'emv.png'].map(f => path.join(fixtures, f)));
  await phone.waitForFunction(() => /^Found 4 codes/.test(document.querySelector('#qs-status').textContent), null, { timeout: 30000 });
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await phone.setViewportSize({ width, height: 800 });
    const bad = await phone.evaluate(() => {
      const out = [];
      for (const b of document.querySelectorAll('#qs-history .btn, .qs-card .btn')) {
        const r = b.getBoundingClientRect();
        if (r.height > 56 || b.scrollWidth > b.clientWidth + 1) out.push('button ' + b.textContent + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      for (const cell of document.querySelectorAll('#qs-hist-body .qs-hist-what')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const m of n.data.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            if (range.getClientRects().length > 1) out.push('word split: ' + m[0]);
          }
        }
      }
      return out;
    });
    assert.deepEqual(bad, [], `history at ${width} px`);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await phoneCtx.close();

  // ---- A phone held sideways: the whole camera preview is brought on screen ----
  // (It started 112 px below the screen when the camera was started from below a result.)
  const land = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, permissions: ['camera'] });
  const lp = await land.newPage();
  await lp.goto(url);
  await lp.tap('#qs-sample');
  await done(lp);
  await lp.evaluate(() => document.querySelector('#qs-results').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await lp.tap('#qs-camera');
  await lp.waitForFunction(() => /^Camera on/.test(document.querySelector('#qs-status').textContent));
  // The page scrolls smoothly (unless reduced motion is asked for), so where the preview ends up is
  // measured once the page has kept still for ten frames.
  await lp.evaluate(() => new Promise(res => {
    let last = scrollY, still = 0;
    const give = setTimeout(res, 3000);
    const tick = () => {
      if (scrollY !== last) { last = scrollY; still = 0; } else if (++still >= 10) { clearTimeout(give); res(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const preview = await lp.$eval('#qs-stage', e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, screen: innerHeight }; });
  assert.ok(preview.top >= 0 && preview.bottom <= preview.screen + 1, 'camera preview off screen: ' + JSON.stringify(preview));
  await lp.tap('#qs-camera');
  assert.equal(await lp.textContent('#qs-status'), 'Camera off.');
  await land.close();

  // ---- The home page's search finds the scanner for barcode and decoder searches ----
  const home = await page.context().newPage();
  await home.goto(base + '/');
  for (const q of ['barcode scanner', 'scan barcode', 'qr decoder', 'decode qr', 'qr code from photo']) {
    await home.fill('#tool-search', q);
    assert.ok(await home.isVisible('#all-tools a[href$="/qr-code-scanner/"]'), `search for "${q}"`);
  }
  await home.close();

  // Leave a full result on screen for the runner's phone-width checks.
  await scan(['vcard.png', 'phishy.png']);
};
