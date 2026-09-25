const fs = require('fs');
const path = require('path');

// Byte-mode capacity (characters) per QR version 1-10 and error correction
// level, from ISO/IEC 18004 table 7. Used to predict the version independently.
const CAPACITY = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};
const expectedModules = (payload, ecl) => {
  const n = Buffer.byteLength(payload, 'utf8');
  const v = CAPACITY[ecl].findIndex(c => c >= n) + 1;
  if (v < 1) throw new Error('payload too long for this table');
  return 17 + 4 * v;
};

function pngInfo(b, assert) {
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(b.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  // jsQR is an independent decoder, injected inline (test-only, no network).
  await page.addScriptTag({ content: fs.readFileSync(path.join(fixtures, 'jsQR.min.js'), 'utf8') });

  const payload = () => page.textContent('#wq-payload');
  const modules = () => page.getAttribute('#wq-qr svg', 'data-modules').then(Number);
  const download = async sel => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  // Decode an image (PNG or SVG bytes) with jsQR in the page; returns the raw bytes.
  const decode = (buf, mime) => page.evaluate(async ({ b64, mime }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const res = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    return res ? { bytes: Array.from(res.binaryData), version: res.version } : null;
  }, { b64: buf.toString('base64'), mime });

  // Defaults render immediately: 58-byte payload needs version 4 at level M.
  const def = 'WIFI:T:WPA;S:Home Network;P:correct horse battery staple;;';
  assert.equal(await payload(), def);
  assert.equal(await modules(), expectedModules(def, 'M'));
  assert.equal(await modules(), 33);
  assert.match(await page.textContent('#wq-meta'), /Version 4, 33 × 33 modules, error correction M/);
  assert.equal(await page.textContent('#wq-error'), '');
  assert.equal(await page.textContent('#wq-card-ssid'), 'Home Network');

  // Escaping of \ ; , : and " per the ZXing WIFI: format, plus UTF-8 text.
  const ssid = 'Café "Guest"; 2:4, a\\b ☕';
  const pass = 'p@ss;w:rd,"q"\\z';
  const escaped = String.raw`WIFI:T:WPA;S:Café \"Guest\"\; 2\:4\, a\\b ☕;P:p@ss\;w\:rd\,\"q\"\\z;;`;
  await page.fill('#wq-ssid', ssid);
  await page.fill('#wq-pass', pass);
  assert.equal(await payload(), escaped);
  assert.equal(await page.textContent('#wq-warn'), '');

  for (const ecl of ['L', 'M', 'Q', 'H']) {
    await page.selectOption('#wq-ecl', ecl);
    assert.equal(await modules(), expectedModules(escaped, ecl), `module count at level ${ecl}`);
  }

  // PNG: exact size, and jsQR reads back the exact UTF-8 payload.
  await page.selectOption('#wq-size', '1024');
  const png = await download('#wq-png');
  assert.match(png.name, /^wifi-qr-cafe-guest-2-4-a-b\.png$/);
  assert.deepEqual(pngInfo(png.buf, assert), { width: 1024, height: 1024 });
  const decodedPng = await decode(png.buf, 'image/png');
  assert.ok(decodedPng, 'PNG decodes as a QR code');
  assert.deepEqual(decodedPng.bytes, Array.from(Buffer.from(escaped, 'utf8')));
  assert.equal(decodedPng.version, (expectedModules(escaped, 'H') - 17) / 4);

  // SVG: sized, 4-module quiet zone in the viewBox, and decodes the same.
  await page.selectOption('#wq-ecl', 'M');
  await page.selectOption('#wq-size', '512');
  const svg = await download('#wq-svg');
  const svgText = svg.buf.toString('utf8');
  assert.match(svg.name, /\.svg$/);
  const total = expectedModules(escaped, 'M') + 8;
  assert.match(svgText, new RegExp(`width="512" height="512" viewBox="0 0 ${total} ${total}"`));
  const decodedSvg = await decode(svg.buf, 'image/svg+xml');
  assert.ok(decodedSvg, 'SVG decodes as a QR code');
  assert.equal(Buffer.from(decodedSvg.bytes).toString('utf8'), escaped);

  // Small PNG still decodes (module edges rounded to whole pixels).
  await page.selectOption('#wq-size', '256');
  const small = await download('#wq-png');
  assert.deepEqual(pngInfo(small.buf, assert), { width: 256, height: 256 });
  assert.equal(Buffer.from((await decode(small.buf, 'image/png')).bytes).toString('utf8'), escaped);

  // WEP + hidden network; a WEP key of the wrong length gets a warning.
  await page.fill('#wq-ssid', 'Lab');
  await page.fill('#wq-pass', 'abcde');
  await page.selectOption('#wq-sec', 'WEP');
  await page.check('#wq-hidden');
  assert.equal(await payload(), 'WIFI:T:WEP;S:Lab;P:abcde;H:true;;');
  assert.equal(await page.textContent('#wq-warn'), '');
  await page.fill('#wq-pass', 'abcd');
  assert.match(await page.textContent('#wq-warn'), /WEP keys are 5 or 13 characters/);
  await page.fill('#wq-pass', '0123456789');
  assert.equal(await page.textContent('#wq-warn'), '');

  // Open network: no password field in the payload, password input disabled.
  await page.uncheck('#wq-hidden');
  await page.selectOption('#wq-sec', 'nopass');
  assert.equal(await payload(), 'WIFI:T:nopass;S:Lab;;');
  assert.equal(await page.isDisabled('#wq-pass'), true);
  assert.equal(await page.isHidden('#wq-card-pass'), true);
  const openPng = await download('#wq-png');
  assert.equal(Buffer.from((await decode(openPng.buf, 'image/png')).bytes).toString('utf8'), 'WIFI:T:nopass;S:Lab;;');

  // Hex-only names are quoted only when asked.
  await page.fill('#wq-ssid', 'CAFE1234');
  assert.equal(await payload(), 'WIFI:T:nopass;S:CAFE1234;;');
  await page.click('.wq-adv summary');
  await page.check('#wq-quote');
  assert.equal(await payload(), 'WIFI:T:nopass;S:"CAFE1234";;');
  await page.fill('#wq-ssid', 'CAFE 1234');
  assert.equal(await payload(), 'WIFI:T:nopass;S:CAFE 1234;;');
  await page.uncheck('#wq-quote');

  // WPA password length warnings; 64 hex digits is a raw key and is fine.
  await page.selectOption('#wq-sec', 'WPA');
  await page.fill('#wq-ssid', 'Home');
  await page.fill('#wq-pass', 'short');
  assert.match(await page.textContent('#wq-warn'), /8 to 63 characters/);
  await page.fill('#wq-pass', 'x'.repeat(64));
  assert.match(await page.textContent('#wq-warn'), /8 to 63 characters/);
  await page.fill('#wq-pass', 'ab12'.repeat(16));
  assert.equal(await page.textContent('#wq-warn'), '');
  // SSID over 32 bytes (é is 2 bytes in UTF-8).
  await page.fill('#wq-ssid', 'é'.repeat(17));
  assert.match(await page.textContent('#wq-warn'), /at most 32 bytes, and this one is 34 bytes/);

  // Errors: missing SSID or missing WPA password disable the downloads.
  await page.fill('#wq-ssid', '');
  assert.match(await page.textContent('#wq-error'), /Enter the network name/);
  assert.equal(await page.isDisabled('#wq-png'), true);
  assert.equal(await page.isDisabled('#wq-svg'), true);
  assert.equal(await page.locator('#wq-qr svg').count(), 0);
  await page.fill('#wq-ssid', 'Home');
  await page.fill('#wq-pass', '');
  assert.match(await page.textContent('#wq-error'), /Enter the Wi-Fi password/);
  await page.fill('#wq-pass', 'hunter2hunter2');
  assert.equal(await page.textContent('#wq-error'), '');
  assert.equal(await page.isEnabled('#wq-png'), true);

  // Password visibility toggle.
  assert.equal(await page.getAttribute('#wq-pass-toggle', 'aria-label'), 'Hide password');
  await page.click('#wq-pass-toggle');
  assert.equal(await page.getAttribute('#wq-pass', 'type'), 'password');
  assert.equal(await page.getAttribute('#wq-pass-toggle', 'aria-label'), 'Show password');
  assert.equal(await page.getAttribute('#wq-pass-toggle', 'aria-pressed'), null, 'no aria-pressed on a button whose label changes');
  await page.click('#wq-pass-toggle');
  assert.equal(await page.getAttribute('#wq-pass', 'type'), 'text');

  // Printable card: heading and password toggles, and print CSS shows only the card.
  await page.fill('#wq-card-heading', 'Guest Wi-Fi');
  assert.equal(await page.textContent('#wq-card-title'), 'Guest Wi-Fi');
  assert.equal(await page.textContent('#wq-card-pass'), 'hunter2hunter2');
  await page.uncheck('#wq-card-showpass');
  assert.equal(await page.isHidden('#wq-card-pass'), true);
  await page.check('#wq-card-showpass');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.isVisible('.wq-print-root .wq-card'), true);
  assert.equal(await page.isVisible('h1'), false);
  assert.equal(await page.isVisible('.wq-print-root .wq-card svg'), true);
  assert.match(await page.textContent('.wq-print-root .wq-card'), /Guest Wi-Fi[\s\S]*Home[\s\S]*hunter2hunter2/);
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await page.isVisible('.wq-print-root'), false);
  // Without a valid code, printing falls back to the normal page.
  await page.fill('#wq-ssid', '');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.isVisible('h1'), true);
  assert.equal(await page.locator('.wq-print-root .wq-card').count(), 0);
  await page.emulateMedia({ media: 'screen' });

  // A value ending in a backslash is escaped to "\\;", which Android's older parser
  // does not treat as the end of the field: the code is still made, with a warning.
  await page.fill('#wq-ssid', 'Home');
  await page.fill('#wq-pass', 'hunter2hunter2\\');
  assert.equal(await payload(), String.raw`WIFI:T:WPA;S:Home;P:hunter2hunter2\\;;`);
  assert.match(await page.textContent('#wq-warn'), /password ends with a backslash/);
  const bs = await download('#wq-png');
  assert.equal(Buffer.from((await decode(bs.buf, 'image/png')).bytes).toString('utf8'), String.raw`WIFI:T:WPA;S:Home;P:hunter2hunter2\\;;`);
  await page.fill('#wq-pass', 'back\\slash-inside');
  assert.equal(await page.textContent('#wq-warn'), '');
  await page.fill('#wq-ssid', 'Lab\\');
  assert.match(await page.textContent('#wq-warn'), /network name ends with a backslash/);

  // A lone UTF-16 surrogate (bad paste) is replaced by U+FFFD, so the QR bytes, the
  // byte count and the text shown all agree.
  await page.$eval('#wq-ssid', el => {
    el.value = 'Net' + String.fromCharCode(0xD83D) + 'X';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const lone = 'WIFI:T:WPA;S:Net\uFFFDX;P:back\\\\slash-inside;;';
  assert.equal(await payload(), lone);
  assert.match(await page.textContent('#wq-meta'), new RegExp(`, ${Buffer.byteLength(lone, 'utf8')} bytes$`));
  const lonePng = await download('#wq-png');
  assert.deepEqual((await decode(lonePng.buf, 'image/png')).bytes, Array.from(Buffer.from(lone, 'utf8')));

  // Same through the fallback used by browsers without String.prototype.toWellFormed:
  // lone high and low surrogates become U+FFFD, a valid pair is kept.
  await page.addInitScript(() => { delete String.prototype.toWellFormed; });
  await open();
  assert.equal(await page.evaluate(() => typeof ''.toWellFormed), 'undefined');
  await page.$eval('#wq-ssid', el => {
    const f = String.fromCharCode;
    el.value = f(0xDC00) + 'a' + f(0xD83D, 0xDE00) + 'b' + f(0xD800);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await payload(), 'WIFI:T:WPA;S:\uFFFDa\u{1F600}b\uFFFD;P:correct horse battery staple;;');
  // Screen readers: the payload is a named group, not a live region, and the details
  // line is not live either, so typing is not read back keystroke by keystroke. One
  // short summary is announced in #wq-status once typing pauses, and nothing on load.
  await open();
  assert.equal(await page.getAttribute('#wq-payload', 'role'), 'group');
  assert.equal(await page.getAttribute('#wq-payload', 'aria-labelledby'), 'wq-payload-label');
  for (const sel of ['#wq-payload', '#wq-meta']) assert.equal(await page.getAttribute(sel, 'aria-live'), null, `${sel} is not live`);
  assert.equal(await page.textContent('#wq-status'), '');
  await page.evaluate(() => {
    window.__live = [];
    new MutationObserver(ms => ms.forEach(m => {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const r = n && n.closest('[aria-live]:not([aria-live="off"]), [role=status], [role=alert], output');
      if (r) window.__live.push(r.id + ':' + r.textContent);
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.fill('#wq-ssid', 'C');
  await page.type('#wq-ssid', 'afe Guest');
  await page.waitForFunction(() => document.querySelector('#wq-status').textContent !== '');
  await page.waitForTimeout(300);
  const live = await page.evaluate(() => window.__live);
  assert.deepEqual(live, ['wq-status:QR code updated: version 4, 56 bytes.'], JSON.stringify(live));
  assert.match(await page.textContent('#wq-meta'), /^Version 4, 33 × 33 modules, .*, 56 bytes$/);
  // Messages are rewritten only when they change, and a missing name clears the summary.
  await page.evaluate(() => { window.__live = []; });
  await page.fill('#wq-ssid', '');
  await page.type('#wq-pass', 'xy');
  await page.waitForTimeout(900);
  const live2 = await page.evaluate(() => window.__live);
  assert.equal(live2.filter(t => t.startsWith('wq-error:')).length, 1, JSON.stringify(live2));
  assert.equal(await page.textContent('#wq-status'), '');
};
