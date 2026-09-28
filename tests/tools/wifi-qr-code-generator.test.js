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


  // ---------- Password masking ----------
  // Hiding the password also masks it in the payload box and on the on-screen card,
  // but Copy text, the downloads and the printed cards use the real password.
  await open();
  await page.addScriptTag({ content: fs.readFileSync(path.join(fixtures, 'jsQR.min.js'), 'utf8') });
  await page.click('#wq-pass-toggle');
  assert.equal(await payload(), 'WIFI:T:WPA;S:Home Network;P:••••••••;;');
  assert.equal(await page.textContent('#wq-card-pass'), '•'.repeat(16));
  await page.click('#wq-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), def);
  assert.match(await page.textContent('.wq-print-root .wq-card'), /correct horse battery staple/);
  // Regression: the small on-screen sheet preview masks it too (it showed the real password).
  assert.doesNotMatch(await page.textContent('#wq-sheet-frame'), /correct horse/);
  assert.match(await page.textContent('#wq-sheet-frame .wq-card'), /••••/);
  const masked = await download('#wq-png');
  assert.equal(Buffer.from((await decode(masked.buf, 'image/png')).bytes).toString('utf8'), def);
  await page.click('#wq-pass-toggle');
  assert.equal(await payload(), def);
  assert.equal(await page.textContent('#wq-card-pass'), 'correct horse battery staple');
  assert.match(await page.textContent('#wq-sheet-frame .wq-card'), /correct horse battery staple/);

  // Regression: a file dropped outside the logo drop zone must not replace the page
  // (the browser's default is to open the file); a drop on the zone still works.
  const outside = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'logo.png', { type: 'image/png' }));
    const res = {};
    for (const t of ['dragover', 'drop']) {
      const ev = new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector('#wq-ssid').dispatchEvent(ev);
      res[t] = ev.defaultPrevented;
    }
    // Plain text dragged between fields keeps its normal behaviour.
    const tdt = new DataTransfer(); tdt.setData('text/plain', 'abc');
    const tev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: tdt });
    document.querySelector('#wq-ssid').dispatchEvent(tev);
    res.text = tev.defaultPrevented;
    return res;
  });
  assert.deepEqual(outside, { dragover: true, drop: true, text: false });
  assert.equal(await page.inputValue('#wq-ssid'), 'Home Network');

  // IEEE 802.11 passphrases are printable ASCII only.
  await page.fill('#wq-pass', 'mot de passe été');
  assert.match(await page.textContent('#wq-warn'), /outside printable ASCII/);
  // Length is counted in characters: 8 emoji are 8, not 16 UTF-16 units.
  await page.fill('#wq-pass', '😀'.repeat(8));
  assert.doesNotMatch(await page.textContent('#wq-warn'), /8 to 63 characters/);
  await page.fill('#wq-pass', 'correct horse battery staple');
  assert.equal(await page.textContent('#wq-warn'), '');

  // ---------- Colours ----------
  // Contrast ratios computed with the WCAG formula in Python:
  // #1a237e on #ffffff = 13.2, #ffffff on #000000 = 21, #999999 on #ffffff = 2.8.
  assert.equal(await page.textContent('#wq-contrast'), 'Contrast 21.0 : 1, good for scanning.');
  await page.fill('#wq-fg-hex', '#1a237e');
  await page.fill('#wq-bg-hex', '#fff8e1');
  assert.equal(await page.getAttribute('#wq-qr svg path', 'fill'), '#1a237e');
  assert.equal(await page.getAttribute('#wq-qr svg rect', 'fill'), '#fff8e1');
  assert.equal(await page.inputValue('#wq-fg'), '#1a237e');
  assert.equal(await page.textContent('#wq-warn'), '');
  const coloured = await download('#wq-png');
  const px = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return [Array.from(x.getImageData(2, 2, 1, 1).data), Array.from(x.getImageData(Math.round(img.width * 4.5 / 41), Math.round(img.width * 4.5 / 41), 1, 1).data)];
  }, coloured.buf.toString('base64'));
  assert.deepEqual(px[0], [0xff, 0xf8, 0xe1, 255], 'quiet zone is the background colour');
  assert.deepEqual(px[1], [0x1a, 0x23, 0x7e, 255], 'finder pattern (outer ring, module 4.5 of 41) is the code colour');
  assert.equal(Buffer.from((await decode(coloured.buf, 'image/png')).bytes).toString('utf8'), def);
  await page.fill('#wq-fg-hex', '#999');
  await page.fill('#wq-bg-hex', '#ffffff');
  assert.match(await page.textContent('#wq-warn'), /close in brightness \(contrast 2\.8 : 1\)/);
  await page.fill('#wq-fg-hex', '#ffffff');
  await page.fill('#wq-bg-hex', '#000000');
  assert.match(await page.textContent('#wq-warn'), /lighter than its background/);
  await page.fill('#wq-fg-hex', '#zz');
  assert.equal(await page.getAttribute('#wq-fg-hex', 'aria-invalid'), 'true');
  assert.match(await page.textContent('#wq-fg-err'), /#ffffff is used/);
  await page.fill('#wq-fg-hex', '#000000');
  await page.fill('#wq-bg-hex', '#ffffff');
  assert.equal(await page.getAttribute('#wq-fg-hex', 'aria-invalid'), 'false');

  // ---------- Logo ----------
  // Choosing a logo switches error correction to H; the SVG and PNG still decode (jsQR).
  await page.selectOption('#wq-ecl', 'M');
  await page.selectOption('#wq-logo', 'wifi');
  assert.equal(await page.inputValue('#wq-ecl'), 'H');
  assert.match(await page.textContent('#wq-meta'), /error correction H \(30%\), 58 bytes, with logo$/);
  assert.equal(await page.locator('#wq-qr svg g path[stroke]').count(), 1, 'Wi-Fi arcs drawn');
  for (const size of ['0.15', '0.2', '0.25']) {
    await page.selectOption('#wq-logo-size', size);
    assert.equal(await page.textContent('#wq-warn'), '', `no warning for a ${size} logo at H`);
    const lp = await download('#wq-png');
    assert.equal(Buffer.from((await decode(lp.buf, 'image/png')).bytes).toString('utf8'), def, `PNG with ${size} logo decodes`);
    const ls = await download('#wq-svg');
    assert.equal(Buffer.from((await decode(ls.buf, 'image/svg+xml')).bytes).toString('utf8'), def, `SVG with ${size} logo decodes`);
  }
  // The modules behind the logo are left blank: none of the path's squares is in the centre.
  const inCentre = await page.evaluate(() => {
    const n = Number(document.querySelector('#wq-qr svg').getAttribute('data-modules'));
    const d = document.querySelector('#wq-qr svg > path').getAttribute('d');
    const mid = 4 + n / 2;
    return [...d.matchAll(/M(\d+) (\d+)h(\d+)/g)].some(m => +m[2] <= mid && +m[2] + 1 >= mid && +m[1] <= mid && +m[1] + +m[3] >= mid);
  });
  assert.equal(inCentre, false);
  // A large logo at level L is flagged (it fails to decode at that level).
  await page.selectOption('#wq-ecl', 'L');
  assert.match(await page.textContent('#wq-warn'), /more than error correction L can safely repair/);
  await page.selectOption('#wq-logo-size', '0.2');
  await page.selectOption('#wq-ecl', 'H');
  // Turning the logo off and on again only switches to H the first time.
  await page.selectOption('#wq-logo', 'none');
  await page.selectOption('#wq-ecl', 'Q');
  await page.selectOption('#wq-logo', 'wifi');
  assert.equal(await page.inputValue('#wq-ecl'), 'H');
  await page.selectOption('#wq-ecl', 'Q');
  await page.selectOption('#wq-logo-size', '0.15');
  assert.equal(await page.inputValue('#wq-ecl'), 'Q');
  await page.selectOption('#wq-ecl', 'H');

  // Your own image: chosen with the file picker, scaled to at most 512 px, kept in the page.
  await page.selectOption('#wq-logo', 'image');
  assert.equal(await page.isVisible('#wq-drop'), true);
  assert.doesNotMatch(await page.textContent('#wq-meta'), /with logo/, 'no logo until an image is chosen');
  await page.setInputFiles('#wq-logo-file', path.join(fixtures, 'logo.png'));
  await page.waitForFunction(() => /logo\.png/.test(document.querySelector('#wq-drop-text').textContent));
  assert.match(await page.textContent('#wq-drop-text'), /logo\.png \(400 × 300 px\)/);
  assert.match(await page.getAttribute('#wq-qr svg image', 'href'), /^blob:/);
  assert.match(await page.textContent('#wq-meta'), /with logo$/);
  const ip = await download('#wq-png');
  assert.equal(Buffer.from((await decode(ip.buf, 'image/png')).bytes).toString('utf8'), def);
  const is = await download('#wq-svg');
  const isText = is.buf.toString('utf8');
  assert.match(isText, /<image [^>]*href="data:image\/png;base64,[^"]+"/, 'downloaded SVG embeds the image');
  assert.doesNotMatch(isText, /blob:/);
  assert.equal(Buffer.from((await decode(is.buf, 'image/svg+xml')).bytes).toString('utf8'), def);
  // An SVG logo, then a file that is not an image.
  await page.setInputFiles('#wq-logo-file', path.join(fixtures, 'logo.svg'));
  await page.waitForFunction(() => /logo\.svg/.test(document.querySelector('#wq-drop-text').textContent));
  await page.setInputFiles('#wq-logo-file', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not really a picture') });
  await page.waitForFunction(() => document.querySelector('#wq-logo-error').textContent !== '');
  assert.match(await page.textContent('#wq-logo-error'), /notes\.png could not be read as an image/);
  assert.match(await page.textContent('#wq-drop-text'), /logo\.svg/, 'the previous logo stays');
  // Drag and drop onto the drop zone.
  const pngB64 = fs.readFileSync(path.join(fixtures, 'logo.png')).toString('base64');
  await page.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }));
    document.querySelector('#wq-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, pngB64);
  await page.waitForFunction(() => /dropped\.png/.test(document.querySelector('#wq-drop-text').textContent));
  assert.equal(await page.textContent('#wq-logo-error'), '');

  // ---------- Printable sheet ----------
  await page.fill('#wq-ssid', 'Seaside Guest House 5G Extra');
  await page.fill('#wq-pass', 'sunny-harbour-7-lighthouse-breeze-sunny-harbour-7-lighthouse');
  for (const [per, paper] of [['1', 'a4'], ['2', 'letter'], ['4', 'a4'], ['6', 'letter'], ['8', 'a4'], ['8', 'letter']]) {
    await page.selectOption('#wq-per-page', per);
    await page.selectOption('#wq-paper', paper);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.wq-print-root .wq-card').count(), Number(per));
    assert.equal(await page.getAttribute('.wq-print-root .wq-sheet', 'class'), `wq-sheet wq-n${per}${paper === 'letter' ? ' wq-letter' : ''}`);
    // Every card fits inside its cell, and the sheet inside the printable area.
    const fit = await page.evaluate(() => {
      const sheet = document.querySelector('.wq-print-root .wq-sheet').getBoundingClientRect();
      return [...document.querySelectorAll('.wq-print-root .wq-cell')].map(cell => {
        const c = cell.getBoundingClientRect(), k = cell.firstElementChild.getBoundingClientRect();
        return { over: cell.scrollHeight - cell.clientHeight, inside: k.top >= c.top - 1 && k.bottom <= c.bottom + 1 && c.bottom <= sheet.bottom + 1 };
      });
    });
    assert.ok(fit.every(f => f.over <= 1 && f.inside), `${per} per ${paper} page: ${JSON.stringify(fit)}`);
    assert.match(await page.textContent('.wq-print-root'), /sunny-harbour-7-lighthouse-breeze-sunny-harbour-7-lighthouse/);
    await page.emulateMedia({ media: 'screen' });
    assert.match(await page.evaluate(() => [...document.querySelectorAll('head style')].map(s => s.textContent).join('')),
      new RegExp(`@page \\{ size: ${paper === 'letter' ? 'letter' : 'A4'} portrait; margin: 10mm; \\}`));
  }
  assert.equal(await page.textContent('#wq-sheet-note'), '8 cards on each US Letter page, each about 98 × 65 mm, with dashed cut lines.');
  assert.equal(await page.locator('#wq-sheet-frame .wq-card').count(), 8, 'on-screen sheet preview');
  const frameBox = await page.$eval('#wq-sheet-frame', el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  assert.ok(Math.abs(frameBox[1] / frameBox[0] - 259.4 / 195.9) < 0.03, `preview has the sheet's shape ${frameBox}`);
  // At phone width the sheet preview and the cards section do not overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Typing stays fast with an image logo and eight cards on the sheet.
  const ms = await page.evaluate(() => {
    const el = document.querySelector('#wq-ssid');
    const t = performance.now();
    for (let i = 0; i < 5; i++) { el.value += 'x'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    return (performance.now() - t) / 5;
  });
  assert.ok(ms < 60, `input handler ${ms} ms`);
};
