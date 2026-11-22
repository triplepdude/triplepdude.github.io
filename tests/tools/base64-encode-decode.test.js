const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { devices } = require('playwright');

// Expected values come from tests/fixtures/base64-encode-decode/expected.py (Python's
// base64 module and codecs, and its own few lines for the hex dump), from Node's Buffer,
// or from the test vectors of RFC 4648. Nothing is read back from the page.
module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const files = data.files;
  const file = name => path.join(fixtures, name);
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
  const n = v => v.toLocaleString('en-GB');
  const plural = (v, word) => `${n(v)} ${word}${v === 1 ? '' : 's'}`;
  const encStats = (bytes, chars) => bytes || chars ? `${plural(bytes, 'byte')} in, ${plural(chars, 'character')} out${bytes ? ` (${n(Math.round((chars - bytes) / bytes * 100))}% larger)` : ''}.` : '';

  await open();
  const on = p => ({
    out: () => p.inputValue('#b64-output'),
    text: sel => p.locator(sel).textContent(),
    attr: (sel, name) => p.getAttribute(sel, name),
    setMode: v => p.check(`input[name="b64-mode"][value="${v}"]`),
    type: async s => { await p.fill('#b64-input', s); return p.inputValue('#b64-output'); },
    // Waits until the element says this, and shows what it says instead when it never does.
    settles: (sel, expected) => p.waitForFunction(([s, t]) => document.querySelector(s).textContent === t, [sel, expected], { timeout: 15000 })
      .catch(async () => assert.equal(await p.locator(sel).textContent(), expected)),
    // Like a paste: the whole value arrives at once.
    paste: value => p.$eval('#b64-input', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value),
  });
  const { out, text, attr, setMode, type, settles, paste } = on(page);
  const status = expected => settles('#b64-status', expected);
  const AUTO_ENC = 'Auto: this is not Base64, so it is encoded.', AUTO_DEC = 'Auto: this is Base64, so it is decoded.';
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  // Clicks Copy and returns what arrived on the clipboard, once it has arrived.
  const copied = async () => {
    await page.evaluate(() => navigator.clipboard.writeText('(nothing copied yet)'));
    await page.click('#b64-copy');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== '(nothing copied yet)', null, { timeout: 8000 }).catch(() => {});
    return clipboard();
  };
  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#b64-download')]);
    return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
  };
  const errors = async () => ({ input: await text('#b64-error'), file: await text('#b64-file-error'), charset: await text('#b64-charset-error') });
  const NONE = { input: '', file: '', charset: '' };
  // Options that cannot apply are greyed out as a group: the group and each control in it.
  const off = sel => page.$eval(sel, el => el.matches(':disabled') && [...el.querySelectorAll('input, select')].every(c => c.matches(':disabled')));

  // ---- Defaults: an example is on the page, and nothing is announced on load ----
  assert.equal(await page.inputValue('#b64-input'), 'Hello, World!');
  assert.equal(await page.isChecked('input[name="b64-mode"][value="auto"]'), true);
  assert.equal(await out(), 'SGVsbG8sIFdvcmxkIQ==');
  assert.equal(await out(), data.texts[0].as['utf-8'].std);
  assert.equal(await text('#b64-output-label'), 'Base64');
  assert.equal(await text('#b64-auto'), AUTO_ENC);
  assert.equal(await text('#b64-stats'), '13 bytes in, 20 characters out (54% larger).');
  assert.equal(await text('#b64-download'), 'Download .txt');
  assert.equal(await page.isVisible('#b64-preview'), false);
  assert.equal(await page.isVisible('#b64-file-pane'), false);
  assert.deepEqual(await errors(), NONE);
  await page.waitForTimeout(900);
  assert.equal(await text('#b64-status'), '');

  // Until something is typed, the example follows the direction, where an untouched
  // "Hello, World!" would be decoded into nonsense.
  await setMode('decode');
  assert.equal(await page.inputValue('#b64-input'), 'SGVsbG8sIFdvcmxkIQ==');
  assert.equal(await out(), 'Hello, World!');
  assert.deepEqual(await errors(), NONE);
  await setMode('encode');
  assert.equal(await page.inputValue('#b64-input'), 'Hello, World!');
  assert.equal(await out(), 'SGVsbG8sIFdvcmxkIQ==');
  await setMode('auto');
  assert.equal(await page.inputValue('#b64-input'), 'Hello, World!');
  // What was typed is never replaced.
  await type('Hello, World?');
  await setMode('decode');
  assert.equal(await page.inputValue('#b64-input'), 'Hello, World?');
  assert.equal(await text('#b64-note'), '2 characters that are not Base64 were skipped (\u201C,\u201D, \u201C?\u201D). These bytes are not valid UTF-8, so the characters shown as \uFFFD are wrong. If this is text, try another text encoding. If it is a file, download it.');

  // ---- Encode: the test vectors of RFC 4648, section 10 ----
  await setMode('encode');
  assert.equal(await page.inputValue('#b64-input'), 'Hello, World?');
  assert.equal(await text('#b64-auto'), '');
  const RFC = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
  for (const [plain, encoded] of RFC) assert.equal(await type(plain), encoded, plain);
  assert.equal(await off('#b64-dec-set'), true);
  assert.equal(await off('#b64-enc-set'), false);
  // Text as UTF-8, with every combination of the options, against Python's base64 module.
  const options = async o => {
    await page.setChecked('#b64-url', !!o.url);
    await page.setChecked('#b64-nopad', !!o.nopad);
    await page.selectOption('#b64-wrap', String(o.wrap || 0));
  };
  for (const [o, key] of [[{}, 'std'], [{ url: 1 }, 'url'], [{ nopad: 1 }, 'nopad'], [{ url: 1, nopad: 1 }, 'urlnopad'], [{ wrap: 76 }, 'lines76'], [{ wrap: 64 }, 'lines64'], [{ url: 1, nopad: 1, wrap: 76 }, 'urllines76']]) {
    await options(o);
    for (const t of data.texts) {
      const want = t.as['utf-8'];
      assert.equal(await type(t.text), want[key], `${key} of ${JSON.stringify(t.text.slice(0, 20))}`);
      assert.equal(await text('#b64-stats'), encStats(want.bytes, want[key].length));
    }
  }
  await options({});
  assert.equal(await type('subjects?_d>>>???'), 'c3ViamVjdHM/X2Q+Pj4/Pz8=');
  await options({ url: 1 });
  assert.equal(await out(), 'c3ViamVjdHM_X2Q-Pj4_Pz8=');
  await options({});
  // A long line is broken exactly at the limit, with no break after the last line.
  await options({ wrap: 76 });
  assert.equal(await type('x'.repeat(57)), b64('x'.repeat(57)));
  assert.equal(await type('x'.repeat(58)), b64('x'.repeat(57)) + '\neA==');
  assert.equal(await type('x'.repeat(114)), b64('x'.repeat(57)) + '\n' + b64('x'.repeat(57)));
  await options({});
  // Other text encodings; a character the encoding lacks is named, never replaced by a question mark.
  const NAMES = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1252': 'Windows-1252', 'windows-1250': 'Windows-1250', 'windows-1251': 'Windows-1251' };
  for (const cs of Object.keys(NAMES)) {
    await page.selectOption('#b64-charset', cs);
    for (const t of data.texts) {
      const want = t.as[cs];
      await type(t.text);
      if (want.error) {
        assert.equal(await out(), '', `${cs} ${t.text}`);
        assert.deepEqual(await errors(), { ...NONE, charset: `${NAMES[cs]} has no code for “${want.char}” (character ${want.error}). Choose UTF-8 to encode any text.` });
        assert.equal(await attr('#b64-charset', 'aria-invalid'), 'true');
        assert.equal(await page.isDisabled('#b64-copy'), true);
        assert.equal(await page.isDisabled('#b64-download'), true);
      } else {
        assert.equal(await out(), want.std, `${cs} ${t.text}`);
        assert.deepEqual(await errors(), NONE);
        assert.equal(await attr('#b64-charset', 'aria-invalid'), null);
        assert.equal(await text('#b64-stats'), encStats(want.bytes, want.std.length));
      }
    }
  }
  assert.ok((await attr('#b64-charset', 'aria-describedby')).split(' ').includes('b64-charset-error'));
  assert.equal(await page.locator('#b64-charset-error').evaluate(el => el.matches('.msg.error')), true);
  await page.selectOption('#b64-charset', 'shift_jis');
  assert.equal(await type('abc'), '');
  assert.deepEqual(await errors(), { ...NONE, charset: 'Shift_JIS text can only be decoded on this page. To encode, choose UTF-8 or another encoding from the list.' });
  assert.equal(await attr('#b64-charset', 'aria-invalid'), 'true');
  await status('Shift_JIS text can only be decoded on this page. To encode, choose UTF-8 or another encoding from the list.');
  await page.selectOption('#b64-charset', 'utf-8');
  assert.equal(await out(), 'YWJj');
  assert.deepEqual(await errors(), NONE);
  // Half of a surrogate pair has no bytes in UTF-8: U+FFFD (EF BF BD) is encoded, and the page says so.
  await paste('a\ud83d');
  assert.equal(await out(), Buffer.from([0x61, 0xef, 0xbf, 0xbd]).toString('base64'));
  assert.equal(await text('#b64-note'), 'Half of a surrogate pair is not a character, so it was encoded as U+FFFD (\uFFFD).');
  // As a data URI: standard alphabet, padding, no line breaks, whatever else is ticked.
  await options({ url: 1, nopad: 1, wrap: 64 });
  await type('subjects?_d>>>???');
  await page.check('#b64-datauri');
  assert.equal(await out(), 'data:text/plain;charset=utf-8;base64,c3ViamVjdHM/X2Q+Pj4/Pz8=');
  assert.equal(await text('#b64-output-label'), 'Data URI');
  assert.equal(await text('#b64-datauri-hint'), 'A data URI always uses the standard alphabet, with padding and without line breaks.');
  assert.deepEqual([await page.isDisabled('#b64-url'), await page.isDisabled('#b64-nopad'), await page.isDisabled('#b64-wrap')], [true, true, true]);
  assert.equal(await text('#b64-stats'), encStats(17, 61));
  await status('Encoded 17 bytes to 61 characters as a data URI.');
  await page.uncheck('#b64-datauri');
  assert.equal(await out(), 'c3ViamVjdHM_X2Q-Pj4_Pz8');
  assert.equal(await text('#b64-datauri-hint'), '');
  assert.deepEqual([await page.isDisabled('#b64-url'), await page.isDisabled('#b64-nopad'), await page.isDisabled('#b64-wrap')], [false, false, false]);
  await options({});

  // ---- Decode ----
  await setMode('decode');
  assert.equal(await text('#b64-output-label'), 'Decoded text');
  assert.equal(await off('#b64-enc-set'), true);
  assert.equal(await off('#b64-dec-set'), false);
  for (const [plain, encoded] of RFC) assert.equal(await type(encoded), plain, encoded);
  for (const t of data.texts) {
    const want = t.as['utf-8'];
    for (const key of ['std', 'url', 'nopad', 'urlnopad', 'lines76', 'lines64', 'urllines76']) {
      assert.equal(await type(want[key]), t.text, `${key} of ${JSON.stringify(t.text.slice(0, 20))}`);
      assert.deepEqual(await errors(), NONE);
    }
    if (t.text) assert.equal(await text('#b64-stats'), `${plural(want.urllines76.replace(/\n/g, '').length, 'Base64 character')} in, ${plural(want.bytes, 'byte')} out: text in UTF-8.`);
    for (const cs of Object.keys(NAMES)) {
      if (cs === 'utf-8' || t.as[cs].error || !t.text) continue;
      await page.selectOption('#b64-charset', cs);
      assert.equal(await type(t.as[cs].std), t.text, `${cs} ${t.text}`);
      assert.equal(await text('#b64-stats'), `${plural(t.as[cs].std.length, 'Base64 character')} in, ${plural(t.as[cs].bytes, 'byte')} out: text in ${NAMES[cs]}.`);
    }
    await page.selectOption('#b64-charset', 'utf-8');
  }
  assert.equal(await type(''), '');
  assert.equal(await text('#b64-stats'), '');
  assert.equal(await type(' \n '), '');
  assert.deepEqual(await errors(), NONE);
  // Text in encodings the page only decodes, and the guide's example: 6Q== is the byte E9, é in
  // Windows-1252 and in Windows-1250 too (so not "only" in Windows-1252), й in Windows-1251.
  for (const l of data.legacy) {
    await page.selectOption('#b64-charset', l.charset);
    assert.equal(await type(l.std), l.text, l.charset);
    assert.equal(await text('#b64-note'), '');
  }
  await page.selectOption('#b64-charset', 'windows-1252');
  assert.equal(await type('6Q=='), 'é');
  await page.selectOption('#b64-charset', 'windows-1250');
  assert.equal(await out(), Buffer.from([0xE9]).toString('latin1'));
  await page.selectOption('#b64-charset', 'windows-1251');
  assert.equal(await out(), '\u0439');
  const guide = (await text('.prose')).replace(/\s+/g, ' ');
  assert.ok(guide.includes('so 6Q== decodes to \uFFFD as UTF-8 and to é once Text encoding is set to Windows-1252.'), guide);
  assert.ok(!/é only when/.test(guide));
  // The guide sends percent-encoding to the URL encoder.
  assert.ok(guide.includes('To percent-encode text for a link or a query string instead, use the URL encoder and decoder.'), guide);
  assert.ok((await page.$$eval('.prose a[href^="/"]', as => as.map(a => a.getAttribute('href')))).includes('/url-encode-decode/'));
  await page.selectOption('#b64-charset', 'utf-8');
  assert.equal(await out(), '\uFFFD');
  assert.equal(await text('#b64-note'), 'These bytes are not valid UTF-8, so the characters shown as \uFFFD are wrong. If this is text, try another text encoding. If it is a file, download it.');
  assert.equal(await text('#b64-stats'), '4 Base64 characters in, 1 byte out: not UTF-8 text.');
  assert.equal(await text('#b64-download'), 'Download .bin');
  assert.equal(await type('w6k='), 'é');
  assert.equal(await text('#b64-note'), '');
  // Bytes that are not text: shown as the browser decodes them, with a warning, and downloadable as they are.
  for (const r of data.raw) {
    assert.equal(await type(r.std), r.lossy, r.hex);
    if (r.lossy.includes('\uFFFD')) {
      assert.match(await text('#b64-note'), /^These bytes are not valid UTF-8, so the characters shown as \uFFFD are wrong\./, r.hex);
      const dl = await download();
      assert.equal(dl.name, 'decoded.bin');
      assert.equal(dl.bytes.toString('hex'), r.hex);
    }
  }
  await type(data.raw.find(r => r.hex === 'fffe680069000000').std);
  assert.match(await text('#b64-note'), /They start with a UTF-16 byte order mark: choose UTF-16 LE as the text encoding\.$/);
  await page.selectOption('#b64-charset', 'utf-16le');
  assert.equal(await out(), 'hi\u0000');
  assert.equal(await text('#b64-note'), '1 control character in this text cannot be seen in the box. The hex dump shows every byte.');
  await page.selectOption('#b64-charset', 'utf-8');
  await type(data.raw.find(r => r.hex === 'feff00680069').std);
  assert.match(await text('#b64-note'), /choose UTF-16 BE as the text encoding\.$/);
  await type(data.raw.find(r => r.hex === '00010203').std);
  assert.equal(await text('#b64-note'), '4 control characters in this text cannot be seen in the box. The hex dump shows every byte.');

  // Lenient decoding: what it skips, forgives and undoes.
  assert.equal(await type('SGVsbG8h!!'), 'Hello!');
  assert.equal(await text('#b64-note'), '2 characters that are not Base64 were skipped (“!”).');
  assert.equal(await type('S*G.V#s?bG8h😀é'), 'Hello!');
  assert.equal(await text('#b64-note'), '6 characters that are not Base64 were skipped (“*”, “.”, “#” and others).');
  assert.equal(await type('SGVs bG8h'), 'Hello!');
  assert.equal(await type(' S G\tV s\r\nb G 8 h '), 'Hello!');
  assert.equal(await text('#b64-note'), '');
  assert.equal(await text('#b64-stats'), '8 Base64 characters in, 6 bytes out: text in UTF-8.');
  assert.equal(await type('SGk=SGk='), 'HiHi');
  assert.equal(await type('SGVsbG8=\nV29ybGQ='), 'HelloWorld');
  assert.equal(await type('SGVsbG8%3D'), 'Hello');
  assert.equal(await type('c3ViamVjdHM%2FX2Q%2bPj4%2FPz8%3d'), 'subjects?_d>>>???');
  assert.equal(await type('c3ViamVjdHM_X2Q+Pj4/Pz8'), 'subjects?_d>>>???');
  assert.equal(await type('QR=='), 'A');
  assert.equal(await type('SGVsbG8hS'), 'Hello!');
  assert.equal(await text('#b64-note'), 'A character that stood alone at the end of a group was left out: one character holds only 6 bits, less than a byte.');
  assert.equal(await type('S'), '');
  assert.equal(await text('#b64-stats'), '1 Base64 character in, 0 bytes out.');
  assert.equal(await page.isDisabled('#b64-download'), true);
  assert.equal(await type('-----BEGIN MESSAGE-----\r\nSGVsbG8s\r\nIFdvcmxkIQ==\r\n-----END MESSAGE-----\r\n'), 'Hello, World!');
  assert.equal(await text('#b64-note'), '');
  // A PEM block indented in a YAML or config file.
  assert.equal(await type('  -----BEGIN MESSAGE-----\n    SGVsbG8s\n    IFdvcmxkIQ==\n    -----END MESSAGE-----\n'), 'Hello, World!');
  assert.equal(await text('#b64-note'), '');
  // Base64 copied out of a JSON string, where a line break is written \n and a slash may be \/.
  assert.equal(await type('-----BEGIN PRIVATE KEY-----\\nSGVsbG8s\\nIFdvcmxkIQ==\\n-----END PRIVATE KEY-----\\n'), 'Hello, World!');
  assert.equal(await type('SGVsbG8s\\nIFdvcmxk\\r\\nIQ==\\n'), 'Hello, World!');
  assert.equal(await type('SGVsbG8s\\tIFdvcmxkIQ=='), 'Hello, World!');
  assert.equal(await type('c3ViamVjdHM\\/X2Q+Pj4\\/Pz8='), 'subjects?_d>>>???');
  assert.equal(await text('#b64-note'), '');
  assert.equal(await type('SGVs\\bG8h'), 'Hello!');
  assert.equal(await text('#b64-note'), '1 character that is not Base64 was skipped (“\\”).');
  // A data URI: the part before the comma is not data.
  assert.equal(await type('data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='), 'Hello, World!');
  assert.equal(await text('#b64-stats'), '20 Base64 characters in, 13 bytes out: text in UTF-8.');
  assert.equal(await type('  DATA:text/plain;charset=UTF-8;BASE64,SGk%3D'), 'Hi');
  assert.equal(await type('data:;base64,SGk='), 'Hi');
  // A data URI that names the text encoding of its bytes: the page says which one to choose.
  assert.equal(await type('data:text/plain;charset=windows-1252;base64,R3L832UgYXVzIEv2bG4='), 'Gr\uFFFD\uFFFDe aus K\uFFFDln');
  assert.equal(await text('#b64-note'), 'These bytes are not valid UTF-8, so the characters shown as \uFFFD are wrong. The data URI says they are Windows-1252: choose it as the text encoding.');
  assert.equal(await type('data:text/plain;charset=ISO-8859-1;base64,R3L832UgYXVzIEv2bG4='), 'Gr\uFFFD\uFFFDe aus K\uFFFDln');
  assert.match(await text('#b64-note'), /The data URI says they are Windows-1252: choose it as the text encoding\.$/);
  await page.selectOption('#b64-charset', 'windows-1252');
  assert.equal(await out(), 'Grüße aus Köln');
  assert.equal(await text('#b64-note'), '');
  await page.selectOption('#b64-charset', 'utf-8');
  await type('data:application/octet-stream;base64,AAECAw==');
  assert.equal(await text('#b64-download'), 'Download .bin');
  assert.equal(await type('data:text/plain,hello'), '');
  assert.deepEqual(await errors(), { ...NONE, input: 'This data URI is not Base64: there is no “;base64” before the comma, so its data is plain text.' });
  assert.equal(await attr('#b64-input', 'aria-invalid'), 'true');
  assert.ok((await attr('#b64-input', 'aria-describedby')).split(' ').includes('b64-error'));
  assert.equal(await page.locator('#b64-error').evaluate(el => el.matches('.msg.error')), true);
  assert.equal(await type('data:text/plain;base64'), '');
  assert.deepEqual(await errors(), { ...NONE, input: 'This data URI has no comma, so it has no data to decode.' });
  assert.equal(await type('!!! ???'), '');
  assert.deepEqual(await errors(), { ...NONE, input: 'There is nothing to decode: no character here is in the Base64 alphabet.' });
  assert.equal(await attr('#b64-input', 'aria-invalid'), 'true');
  assert.deepEqual([await page.isDisabled('#b64-copy'), await page.isDisabled('#b64-download'), await page.isDisabled('#b64-swap')], [true, true, true]);
  assert.equal(await text('#b64-stats'), '');
  await status('There is nothing to decode: no character here is in the Base64 alphabet.');
  assert.equal(await type('SGk='), 'Hi');
  assert.deepEqual(await errors(), NONE);
  assert.equal(await attr('#b64-input', 'aria-invalid'), null);

  // Strict decoding: every way of being malformed has its own message.
  await page.check('#b64-strict');
  const strict = async (s, msg) => {
    assert.equal(await type(s), '', s);
    assert.deepEqual(await errors(), { ...NONE, input: msg }, s);
    assert.equal(await attr('#b64-input', 'aria-invalid'), 'true');
    assert.equal(await text('#b64-stats'), '');
    assert.equal(await page.isDisabled('#b64-copy'), true);
  };
  await strict('SGVsbG8h!!', '“!” (character 9) is not in the Base64 alphabet.');
  await strict('SGVsbG8hé', '“é” (character 9) is not in the Base64 alphabet.');
  await strict('SGVsbG8h😀', '“😀” (character 9) is not in the Base64 alphabet.');
  await strict('SGVsbG8%3D', '“%” (character 8) is not in the Base64 alphabet. Turn Strict off to read URL-encoded data.');
  await strict('SGVs bG8h', 'There is a space at character 5. Strict Base64 has line breaks at most, no other white space.');
  await strict('SGVs\tbG8h', 'There is a tab at character 5. Strict Base64 has line breaks at most, no other white space.');
  await strict('SGVs\fbG8h', 'There is a form feed at character 5. Strict Base64 has line breaks at most, no other white space.');
  await strict('SGVs\vbG8h', 'There is a vertical tab at character 5. Strict Base64 has line breaks at most, no other white space.');
  await strict('SGVsbG8', 'The padding is missing: strict Base64 ends with = here. Add it, or turn Strict off.');
  await strict('SGk', 'The padding is missing: strict Base64 ends with = here. Add it, or turn Strict off.');
  await strict('SA', 'The padding is missing: strict Base64 ends with == here. Add it, or turn Strict off.');
  await strict('SGVsbA=', 'The padding is wrong: this data needs == at the end and has =.');
  await strict('SGk==', 'The padding is wrong: this data needs = at the end and has ==.');
  await strict('SGVsbG8h=', 'The padding is wrong: this data needs no = at the end and has =.');
  await strict('SGk=======', 'The padding is wrong: this data needs = at the end and has 7 = signs.');
  await strict('SGk=SGk=', 'Character 5 comes after the = padding, which must be the end of the data.');
  await strict('S', 'The length is wrong: 1 character leaves one over after the groups of four, and a single character holds only 6 bits of a byte.');
  await strict('SGVsb', 'The length is wrong: 5 characters leave one over after the groups of four, and a single character holds only 6 bits of a byte.');
  await strict('a+b_', 'Character 4 mixes two alphabets: + and / belong to standard Base64, - and _ to the URL-safe kind.');
  await strict('a-b/', 'Character 4 mixes two alphabets: + and / belong to standard Base64, - and _ to the URL-safe kind.');
  // QQ== is A; QR== has a bit set in the four bits that are thrown away (RFC 4648, section 3.5).
  await strict('QR==', 'The last character, “R”, has bits set that no byte uses. A careful encoder writes “Q” there.');
  await strict('SGl=', 'The last character, “l”, has bits set that no byte uses. A careful encoder writes “k” there.');
  // Padding in the middle of a line, and a line break inside the padding.
  await strict('SG=k', 'Character 4 comes after the = padding, which must be the end of the data.');
  assert.equal(await type('SGVsbG8sIFdvcmxkIQ=\n=\n'), 'Hello, World!');
  await strict('-----BEGIN MESSAGE-----\nSGVsbG8=\n-----END MESSAGE-----', 'A PEM block has BEGIN and END lines that are not Base64. Turn Strict off to skip them.');
  await strict('data:text/plain;base64,SGk', 'The padding is missing: strict Base64 ends with = here. Add it, or turn Strict off.');
  await strict('data:text/plain;base64,SG k=', 'There is a space at character 26. Strict Base64 has line breaks at most, no other white space.');
  // Well-formed Base64 passes: either alphabet, padded, with line breaks and white space round it.
  for (const t of data.texts) {
    if (!t.text) continue;
    const want = t.as['utf-8'];
    for (const key of ['std', 'url', 'lines76', 'lines64']) assert.equal(await type(want[key]), t.text, `strict ${key} of ${JSON.stringify(t.text.slice(0, 20))}`);
    assert.equal(await type(`  ${want.std.replace(/(.{20})/g, '$1\r\n')}\n\n`), t.text);
    assert.deepEqual(await errors(), NONE);
  }
  assert.equal(await type('QQ=='), 'A');
  assert.equal(await type('data:text/plain;base64,SGk='), 'Hi');
  assert.equal(await type('-_-_'), Buffer.from('-_-_', 'base64url').toString('latin1').replace(/[\x80-\xff]/g, '\uFFFD'));
  await page.uncheck('#b64-strict');
  assert.equal(await type('SGVsbG8'), 'Hello');
  assert.deepEqual(await errors(), NONE);

  // ---- Auto: decode only what is surely Base64 ----
  await setMode('auto');
  assert.equal(await off('#b64-enc-set'), false);
  assert.equal(await off('#b64-dec-set'), false);
  const png = files['pixel.png'];
  for (const [typed, decoded] of [['SGVsbG8sIFdvcmxkIQ==', 'Hello, World!'], ['SGVsbG8sIFdvcmxkIQ', 'Hello, World!'], ['Zm9v', 'foo'], ['aGk=', 'hi'], ['  aGk=\n', 'hi'],
    ['eyJhbGciOiJIUzI1NiJ9', '{"alg":"HS256"}'], ['4pyTIMOgIGxhIG1vZGU=', '✓ à la mode'], ['data:text/plain;base64,SGk=', 'Hi'], ['DATA:;BASE64,SGk=', 'Hi'],
    ['-----BEGIN X-----\nSGVsbG8=\n-----END X-----', 'Hello'], ['SGVsbG8s\r\nIFdvcmxkIQ==', 'Hello, World!'], ['c3ViamVjdHM_X2Q-Pj4_Pz8', 'subjects?_d>>>???'],
    [data.texts.find(t => t.text.startsWith('The quick')).as['utf-8'].lines76, 'The quick brown fox jumps over the lazy dog. '.repeat(4)],
    ['3q2+7w==', data.raw[0].lossy], ['AAECAwQFBgcICQoLDA0ODw==', Buffer.from('AAECAwQFBgcICQoLDA0ODw==', 'base64').toString('utf8')],
    ['q83vEjRWeJAq83vEjRWeJA', Buffer.from('q83vEjRWeJAq83vEjRWeJA', 'base64').toString('utf8')]]) {
    // A text box shows every line break as a line feed; Copy and Download keep the bytes as they are.
    assert.equal(await type(typed), decoded.replace(/\r\n?/g, '\n'), typed);
    assert.equal(await text('#b64-auto'), AUTO_DEC, typed);
    assert.equal(await text('#b64-output-label'), 'Decoded text');
  }
  // Words, numbers, names, hashes and addresses are made of Base64 characters too: they are encoded.
  for (const typed of ['test', 'Hello', 'HELLO', 'hello world', '0400', '1500', '12345678', '2026', 'key=', 'a=1', 'JavaScript', 'iPhone', 'McDonald', 'TitleCase/Path/With/Slashes',
    'SGVs bG8h', '5d41402abc4b2a76b9719d911017c592', '550e8400-e29b-41d4-a716-446655440000', 'q83vEjRWeJA', '//79', 'data:text/plain,hello', 'a', 'Zm9', 'Zm9v!', 'SGk==', 'SGVsb',
    'ünïcödé', 'https://example.com/a?b=c', 'user@example.com', 'well-known', 'snake_case_name', 'a+b_', 'deadbeefcafe', 'Lorem ipsum dolor sit amet',
    // AQgw would decode to the control codes 01 08 and a 0: that is not readable text either.
    'AQgw',
    // These words are well-formed Base64 of printable text (Milk is "2)d", NERD is "4DC"),
    // and still words: lower case, Capitalised or CAPITALS without a digit are never decoded.
    'Milk', 'Silk', 'Wild', 'Nile', 'NERD', 'also',
    // A hash in capitals, a long name without a digit, and Base64 that mixes the two alphabets
    // (it would decode to readable text, but no encoder writes that).
    '5D41402ABC4B2A76B9719D911017C592', 'TheQuickBrownFoxJumpsOverTheLazyDog', 'c3ViamVjdHM_X2Q+Pj4/Pz8=']) {
    assert.equal(await type(typed), b64(typed), typed);
    assert.equal(await text('#b64-auto'), AUTO_ENC, typed);
    assert.equal(await text('#b64-output-label'), 'Base64');
  }
  assert.equal(await type(''), '');
  assert.equal(await text('#b64-auto'), '');
  assert.equal(await type('  \n'), b64('  \n'));
  assert.equal(await text('#b64-auto'), '');

  // ---- Pictures and other files that arrive as Base64 ----
  assert.equal(await type(png.std), '');
  assert.equal(await text('#b64-auto'), AUTO_DEC);
  assert.equal(await page.isVisible('#b64-out-pane'), false);
  assert.equal(await page.isVisible('#b64-preview'), true);
  await settles('#b64-img-info', 'PNG image, 3 × 2 pixels, 83 bytes.');
  assert.deepEqual(await page.$eval('#b64-img', el => [el.naturalWidth, el.naturalHeight, el.alt, el.src.slice(0, 5)]), [3, 2, 'Preview of the image', 'blob:']);
  // A picture of a few pixels is shown enlarged (3 x 2 at 42 times), a larger one at its own size.
  assert.deepEqual(await page.$eval('#b64-img', el => [el.clientWidth, el.clientHeight, getComputedStyle(el).imageRendering]), [126, 84, 'pixelated']);
  assert.equal(await text('#b64-stats'), `${n(png.std.length)} Base64 characters in, 83 bytes out: a PNG image.`);
  assert.equal(await text('#b64-download'), 'Download .png');
  assert.deepEqual([await page.isDisabled('#b64-copy'), await page.isDisabled('#b64-swap'), await page.isDisabled('#b64-download')], [true, true, false]);
  let dl = await download();
  assert.equal(dl.name, 'decoded.png');
  assert.equal(sha(dl.bytes), png.sha256);
  assert.deepEqual(dl.bytes, fs.readFileSync(file('pixel.png')));
  await status(`${AUTO_DEC} Decoded 83 bytes: a PNG image.`);
  for (const form of [`data:image/png;base64,${png.std}`, png.lines76, png.url, png.urlnopad, fs.readFileSync(file('pixel.pem'), 'utf8')]) {
    await type(form);
    assert.equal(await text('#b64-stats'), `${n(png.std.length - (form === png.urlnopad ? 1 : 0))} Base64 characters in, 83 bytes out: a PNG image.`);
    assert.equal(sha((await download()).bytes), png.sha256);
  }
  for (const [name, label, size, ext] of [['photo.jpg', 'JPEG image', '16 × 12', 'jpg'], ['dots.gif', 'GIF image', '4 × 4', 'gif'], ['flat.webp', 'WebP image', '8 × 6', 'webp'], ['shape.svg', 'SVG image', '40 × 30', 'svg']]) {
    const f = files[name];
    await type(f.std);
    await settles('#b64-img-info', `${label}, ${size} pixels, ${n(f.size)} bytes.`);
    assert.equal(await text('#b64-download'), 'Download .' + ext);
    dl = await download();
    assert.equal(dl.name, 'decoded.' + ext);
    assert.equal(sha(dl.bytes), f.sha256);
    // An SVG is text as well as a picture: both are shown.
    assert.equal(await page.isVisible('#b64-out-pane'), name === 'shape.svg');
    if (name === 'shape.svg') assert.equal(await out(), fs.readFileSync(file(name), 'utf8'));
  }
  for (const [name, what, ext] of [['blank.pdf', 'a PDF document', 'pdf'], ['hello.zip', 'a ZIP archive (the container of .docx, .xlsx and .jar files too)', 'zip']]) {
    const f = files[name];
    await type(f.std);
    assert.equal(await text('#b64-stats'), `${n(f.std.length)} Base64 characters in, ${n(f.size)} bytes out: ${what}.`);
    assert.equal(await page.isVisible('#b64-preview'), false);
    assert.equal(await page.isVisible('#b64-out-pane'), false);
    dl = await download();
    assert.equal(dl.name, 'decoded.' + ext);
    assert.equal(sha(dl.bytes), f.sha256);
  }
  assert.equal(await type(b64('{"name":"Base64","ok":true}')), '{"name":"Base64","ok":true}');
  assert.equal(await text('#b64-stats'), '36 Base64 characters in, 27 bytes out: JSON in UTF-8.');
  assert.equal(await text('#b64-download'), 'Download .json');
  assert.equal(await type(b64('<!DOCTYPE html><title>x</title>')), '<!DOCTYPE html><title>x</title>');
  assert.equal(await text('#b64-download'), 'Download .html');
  // Text that starts like a file signature is still text (OTTO, ID3, GIF89a...): a real file has bytes that text has not.
  await setMode('decode');
  for (const t of ['OTTO is my name', 'ID3 tags are metadata', 'GIF89a is the newer format', 'OggS', 'BZh2', 'fLaC and MThd', 'wOFF', 'BMW is a car maker from Munich']) {
    assert.equal(await type(b64(t)), t, t);
    assert.equal(await page.isVisible('#b64-out-pane'), true, t);
    assert.equal(await page.isVisible('#b64-preview'), false, t);
    assert.equal(await text('#b64-download'), 'Download .txt', t);
  }
  assert.equal(await type(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1').toString('base64')), '');
  assert.equal(await text('#b64-download'), 'Download .gif');
  // ... and the real ones, with their binary bytes, are still files.
  for (const [start, label, ext] of [['ID3\x03\x00\x00\x00\x00\x00\x0f', 'an MP3 audio file', 'mp3'], ['OggS\x00\x02\x00\x00', 'an Ogg file', 'ogg'],
    ['fLaC\x00\x00\x00\x22', 'a FLAC audio file', 'flac'], ['MThd\x00\x00\x00\x06\x00\x01', 'a MIDI file', 'mid'], ['wOFF\x00\x01\x00\x00', 'a WOFF font', 'woff'],
    ['wOF2\x00\x01\x00\x00', 'a WOFF2 font', 'woff2'], ['OTTO\x00\x0a\x00\x80', 'an OpenType font', 'otf'], ['BZh91AY&SY\x8f\x12', 'a bzip2 file', 'bz2'],
    ['%PDF-1.4\n', 'a PDF document', 'pdf'], ['0\x82\x00\x04\x02\x01\x05\x00', 'a DER file (the binary form of a certificate or key)', 'der'], ['\x1f\x8b\x08\x00', 'a gzip file', 'gz'], ['PK\x03\x04\x14\x00', 'a ZIP archive (the container of .docx, .xlsx and .jar files too)', 'zip']]) {
    await type(Buffer.from(start, 'latin1').toString('base64'));
    assert.equal(await page.isVisible('#b64-out-pane'), false, label);
    assert.ok((await text('#b64-stats')).endsWith(`: ${label}.`), label);
    assert.equal(await text('#b64-download'), 'Download .' + ext, label);
  }
  // A DER sequence whose length field does not cover the rest is no DER file.
  await type(Buffer.from('3082000502010500', 'hex').toString('base64'));
  assert.equal(await text('#b64-download'), 'Download .bin');
  await setMode('auto');
  // A data URI names the kind of plain text and of bytes without a signature; a signature wins.
  assert.equal(await type('data:text/css;base64,' + b64('a{color:red}')), 'a{color:red}');
  assert.equal(await text('#b64-download'), 'Download .css');
  dl = await download();
  assert.deepEqual([dl.name, dl.bytes.toString('utf8')], ['decoded.css', 'a{color:red}']);
  await type('data:application/x-unknown;base64,3q2+7w==');
  assert.equal(await text('#b64-download'), 'Download .bin');
  await type('data:text/css;base64,' + png.std);
  assert.equal(await text('#b64-download'), 'Download .png');
  await type('data:image/png;base64,3q2+7w==');
  await settles('#b64-img-info', 'Image, 4 bytes. This browser cannot show it.');
  assert.equal(await text('#b64-download'), 'Download .png');
  assert.equal(await page.isVisible('#b64-img'), false);
  // A picture that is damaged: its kind is still named, and the page says that it cannot be shown.
  await type(Buffer.concat([fs.readFileSync(file('pixel.png')).subarray(0, 20), Buffer.alloc(8)]).toString('base64'));
  await settles('#b64-img-info', 'PNG image, 28 bytes. This browser cannot show it.');
  assert.equal(await page.isVisible('#b64-img'), false);
  await type(png.std);
  await settles('#b64-img-info', 'PNG image, 3 × 2 pixels, 83 bytes.');
  assert.equal(await page.isVisible('#b64-img'), true);

  // ---- Files: opened, dropped or pasted, encoded in the browser ----
  await type('kept while a file is open');
  await page.setInputFiles('#b64-file', file('pixel.png'));
  await settles('#b64-file-name', 'pixel.png');
  assert.equal(await text('#b64-file-info'), '83 bytes, image/png');
  assert.equal(await page.isVisible('#b64-text-pane'), false);
  assert.equal(await page.isVisible('#b64-file-pane'), true);
  assert.equal(await out(), png.std);
  assert.equal(await text('#b64-auto'), AUTO_ENC);
  assert.equal(await text('#b64-stats'), encStats(83, png.std.length));
  await settles('#b64-img-info', 'PNG image, 3 × 2 pixels, 83 bytes.');
  dl = await download();
  assert.equal(dl.name, 'pixel.png.base64.txt');
  assert.equal(dl.bytes.toString('utf8'), png.std);
  assert.equal(await copied(), png.std);
  await page.check('#b64-datauri');
  assert.equal(await out(), `data:image/png;base64,${png.std}`);
  await page.uncheck('#b64-datauri');
  // A file without a media type, or with only the generic one, takes the one its first bytes name.
  await page.setInputFiles('#b64-file', { name: 'picture', mimeType: '', buffer: fs.readFileSync(file('pixel.png')) });
  await settles('#b64-file-name', 'picture');
  await page.check('#b64-datauri');
  assert.equal(await out(), `data:image/png;base64,${png.std}`);
  await page.uncheck('#b64-datauri');
  await page.setInputFiles('#b64-file', file('pixel.png'));
  await settles('#b64-file-name', 'pixel.png');
  await options({ wrap: 64 });
  assert.equal(await out(), png.lines64);
  await options({ url: 1, nopad: 1 });
  assert.equal(await out(), png.urlnopad);
  await options({});
  for (const name of Object.keys(files)) {
    await page.setInputFiles('#b64-file', file(name));
    await settles('#b64-file-name', name);
    assert.equal(await out(), files[name].std, name);
    assert.equal(await text('#b64-stats'), encStats(files[name].size, files[name].std.length));
    assert.equal(await page.isVisible('#b64-preview'), /\.(png|jpg|gif|webp|svg)$/.test(name), name);
  }
  // all-bytes.bin holds every byte value: the URL-safe alphabet and the line lengths are exact.
  await options({ url: 1 });
  assert.equal(await out(), files['all-bytes.bin'].url);
  await options({ wrap: 76 });
  assert.equal(await out(), files['all-bytes.bin'].lines76);
  await options({});
  await page.check('#b64-datauri');
  assert.equal(await out(), `data:application/octet-stream;base64,${files['all-bytes.bin'].std}`);
  await page.uncheck('#b64-datauri');
  // Forced to decode, a file that is not Base64 text is refused, and the message belongs to the file button.
  await setMode('decode');
  assert.deepEqual(await errors(), { ...NONE, file: '“all-bytes.bin” is not Base64 text, so there is nothing to decode. Choose Encode to turn the file into Base64.' });
  assert.equal(await attr('#b64-file', 'aria-invalid'), 'true');
  assert.ok((await attr('#b64-file', 'aria-describedby')).split(' ').includes('b64-file-error'));
  assert.equal(await page.locator('#b64-file-error').evaluate(el => el.matches('.msg.error') && el.getAttribute('role')), 'alert');
  assert.equal(await out(), '');
  await setMode('auto');
  assert.deepEqual(await errors(), NONE);
  assert.equal(await attr('#b64-file', 'aria-invalid'), null);
  // Removing the file brings back the text that was in the box.
  await page.click('#b64-file-remove');
  assert.equal(await page.isVisible('#b64-text-pane'), true);
  assert.equal(await page.isVisible('#b64-file-pane'), false);
  assert.equal(await page.inputValue('#b64-input'), 'kept while a file is open');
  assert.equal(await out(), b64('kept while a file is open'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-input');
  // Files that hold Base64 text are decoded: MIME lines and a PEM block.
  for (const name of ['pixel.b64', 'pixel.pem']) {
    await page.setInputFiles('#b64-file', file(name));
    await settles('#b64-file-name', name);
    assert.equal(await text('#b64-auto'), AUTO_DEC);
    await settles('#b64-img-info', 'PNG image, 3 × 2 pixels, 83 bytes.');
    dl = await download();
    assert.equal(dl.name, 'decoded.png');
    assert.equal(sha(dl.bytes), png.sha256);
  }
  await page.check('#b64-strict');
  await settles('#b64-file-error', 'A PEM block has BEGIN and END lines that are not Base64. Turn Strict off to skip them.');
  assert.equal(await attr('#b64-file', 'aria-invalid'), 'true');
  assert.equal(await page.isVisible('#b64-preview'), false);
  assert.equal(await page.isDisabled('#b64-download'), true);
  await page.uncheck('#b64-strict');
  await settles('#b64-file-error', '');
  await setMode('encode');
  assert.equal(await out(), b64(fs.readFileSync(file('pixel.pem'), 'utf8')));
  await setMode('auto');
  // Base64 saved by Notepad (with a UTF-8 byte order mark) or by PowerShell (UTF-16 with a byte order mark).
  const pixelText = fs.readFileSync(file('pixel.b64'), 'utf8');
  for (const [name, buf] of [['notepad.b64', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(pixelText)])],
    ['powershell.b64', Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(pixelText, 'utf16le')])],
    ['big-endian.b64', Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(pixelText, 'utf16le').swap16()])]]) {
    for (const m of ['auto', 'decode']) {
      await setMode(m);
      await page.setInputFiles('#b64-file', { name, mimeType: 'text/plain', buffer: buf });
      await settles('#b64-file-name', name);
      assert.deepEqual(await errors(), NONE, name);
      assert.equal(await text('#b64-auto'), m === 'auto' ? AUTO_DEC : '', name);
      await settles('#b64-img-info', 'PNG image, 3 × 2 pixels, 83 bytes.');
      assert.equal(sha((await download()).bytes), png.sha256, name);
    }
  }
  await setMode('auto');
  // A file dropped on the tool, and a picture pasted into the box.
  await page.click('#b64-file-remove');
  const give = (how, name) => page.evaluate(([how, name, b64, type]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type }));
    const box = document.querySelector('#b64-input');
    if (how === 'paste') return box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = document.querySelector('#b64').classList.contains('is-over');
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return over && !document.querySelector('#b64').classList.contains('is-over');
  }, [how, name, files[name].std, files[name].mime]);
  assert.equal(await give('drop', 'dots.gif'), true);
  await settles('#b64-file-name', 'dots.gif');
  assert.equal(await out(), files['dots.gif'].std);
  await settles('#b64-img-info', 'GIF image, 4 × 4 pixels, 53 bytes.');
  assert.equal(await text('#b64-note'), '');
  // A file dropped anywhere else on the page is opened too: the browser would otherwise open it in
  // place of the page and lose what is in the box. Of several, the first, and the page says so.
  const dropOn = (sel, names) => page.evaluate(([sel, names, b64, type]) => {
    const dt = new DataTransfer();
    for (const name of names) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type }));
    const el = document.querySelector(sel), root = document.querySelector('#b64');
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }), drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(over);
    const marked = root.classList.contains('is-over');
    el.dispatchEvent(drop);
    return [over.defaultPrevented, marked, drop.defaultPrevented, root.classList.contains('is-over')];
  }, [sel, names, files['dots.gif'].std, files['dots.gif'].mime]);
  for (const [sel, name] of [['h1', 'title.gif'], ['.prose', 'guide.gif'], ['.faq', 'faq.gif'], ['.site-footer', 'footer.gif']]) {
    assert.deepEqual(await dropOn(sel, [name]), [true, true, true, false], sel);
    await settles('#b64-file-name', name);
    assert.equal(await out(), files['dots.gif'].std);
  }
  assert.deepEqual(await dropOn('.faq', ['list-1.gif', 'list-2.gif', 'list-3.gif']), [true, true, true, false]);
  await settles('#b64-file-name', 'list-1.gif');
  await settles('#b64-note', 'Only the first of the 3 files was opened.');
  // The box is marked while a file is over the page, through every element it crosses, until it
  // leaves the window: dragenter and dragleave come in pairs, without a relatedTarget in Safari.
  assert.deepEqual(await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
    const fire = (type, sel) => document.querySelector(sel).dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    const marked = () => document.querySelector('#b64').classList.contains('is-over');
    const seen = [];
    fire('dragenter', 'h1'); seen.push(marked());
    fire('dragenter', '.faq'); fire('dragleave', 'h1'); seen.push(marked());
    fire('dragleave', '.faq'); seen.push(marked());
    return seen;
  }), [true, true, false]);
  await page.click('#b64-file-remove');
  assert.equal(await text('#b64-note'), '');
  await page.evaluate(([b64, type]) => {
    const dt = new DataTransfer();
    for (const name of ['copied-1.gif', 'copied-2.gif']) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type }));
    document.querySelector('#b64-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [files['dots.gif'].std, files['dots.gif'].mime]);
  await settles('#b64-file-name', 'copied-1.gif');
  await settles('#b64-note', 'Only the first of the 2 files was opened.');
  assert.equal(await give('paste', 'photo.jpg'), false);
  await settles('#b64-file-name', 'photo.jpg');
  assert.equal(await out(), files['photo.jpg'].std);
  // Cells copied from a spreadsheet come with a picture of themselves: that is a paste of text.
  await page.click('#b64-file-remove');
  const pastedAsText = await page.evaluate(([b64]) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'A1\tB1');
    dt.setData('text/html', '<table><tr><td>A1<td>B1</table>');
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    return document.querySelector('#b64-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [png.std]);
  assert.equal(pastedAsText, true);
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible('#b64-file-pane'), false);
  assert.equal(await give('paste', 'photo.jpg'), false);
  await settles('#b64-file-name', 'photo.jpg');
  // A file over 50 MB is refused before it is read, and the file that was open stays.
  const huge = path.join(os.tmpdir(), `b64-huge-${process.pid}.bin`);
  fs.writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024));
  try {
    await page.setInputFiles('#b64-file', huge);
    await settles('#b64-file-error', `“${path.basename(huge)}” has 53,477,376 bytes. The largest file this page takes is 52,428,800 bytes (50 MB).`);
  } finally {
    fs.unlinkSync(huge);
  }
  assert.equal(await attr('#b64-file', 'aria-invalid'), 'true');
  assert.equal(await text('#b64-file-name'), 'photo.jpg');
  assert.equal(await out(), files['photo.jpg'].std);
  // The message has been read once another choice is made; the open file stays.
  await page.check('#b64-url');
  assert.deepEqual(await errors(), NONE);
  assert.equal(await attr('#b64-file', 'aria-invalid'), null);
  assert.equal(await out(), files['photo.jpg'].url);
  await page.uncheck('#b64-url');
  await page.setInputFiles('#b64-file', file('dots.gif'));
  await settles('#b64-file-name', 'dots.gif');
  assert.deepEqual(await errors(), NONE);
  // With no file open, the message goes away as soon as something is typed.
  await page.click('#b64-file-remove');
  fs.writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024));
  try {
    await page.setInputFiles('#b64-file', huge);
    await settles('#b64-file-error', `\u201C${path.basename(huge)}\u201D has 53,477,376 bytes. The largest file this page takes is 52,428,800 bytes (50 MB).`);
  } finally {
    fs.unlinkSync(huge);
  }
  assert.equal(await page.isVisible('#b64-text-pane'), true);
  await type('typed after the refusal');
  assert.deepEqual(await errors(), NONE);
  assert.equal(await attr('#b64-file', 'aria-invalid'), null);
  await page.setInputFiles('#b64-file', file('dots.gif'));
  await settles('#b64-file-name', 'dots.gif');
  // A 3 MB file: the box shows the first 500,000 characters, Copy and Download give all 4,194,304.
  const big = Buffer.alloc(3 * 1024 * 1024 + 1);
  for (let i = 0, x = 12345; i < big.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; big[i] = x >> 16; }
  const bigPath = path.join(os.tmpdir(), `b64-big-${process.pid}.bin`);
  fs.writeFileSync(bigPath, big);
  try {
    await page.setInputFiles('#b64-file', bigPath);
    await settles('#b64-stats', encStats(big.length, 4194308));
  } finally {
    fs.unlinkSync(bigPath);
  }
  const bigB64 = big.toString('base64');
  assert.equal(bigB64.length, 4194308);
  assert.equal(await out(), bigB64.slice(0, 500000));
  assert.equal(await text('#b64-note'), 'The box shows the first 500,000 of 4,194,308 characters. Copy and Download give all of them.');
  assert.equal(sha(Buffer.from(await copied())), sha(Buffer.from(bigB64)));
  dl = await download();
  assert.equal(sha(dl.bytes), sha(Buffer.from(bigB64)));
  // ... and back: the whole result becomes the input, and decodes to the same bytes.
  await page.click('#b64-swap');
  await settles('#b64-stats', `4,194,308 Base64 characters in, ${n(big.length)} bytes out: not UTF-8 text.`);
  assert.equal(await page.isVisible('#b64-file-pane'), false);
  assert.equal(await text('#b64-auto'), AUTO_DEC);
  dl = await download();
  assert.equal(dl.name, 'decoded.bin');
  assert.equal(sha(dl.bytes), sha(big));
  // An 8 MB file gives 11,184,812 characters: more than the box takes, so it cannot become the input.
  const eight = Buffer.alloc(8 * 1024 * 1024, 0x41);
  const eightPath = path.join(os.tmpdir(), `b64-eight-${process.pid}.bin`);
  fs.writeFileSync(eightPath, eight);
  try {
    await page.setInputFiles('#b64-file', eightPath);
    await settles('#b64-stats', encStats(eight.length, 11184812));
  } finally {
    fs.unlinkSync(eightPath);
  }
  assert.deepEqual([await page.isDisabled('#b64-copy'), await page.isDisabled('#b64-download'), await page.isDisabled('#b64-swap')], [false, false, true]);
  await page.click('#b64-file-remove');

  // ---- Hex dump: opened from the keyboard, in the layout of hexdump -C ----
  await setMode('encode');
  await type('Hello, World!');
  assert.equal(await text('#b64-hex-summary'), 'Hex dump of the input (13 bytes)');
  assert.equal(await page.isVisible('#b64-dump'), false);
  await page.focus('#b64-hex summary');
  await page.keyboard.press('Enter');
  await settles('#b64-dump', '00000000  48 65 6c 6c 6f 2c 20 57  6f 72 6c 64 21           |Hello, World!|');
  assert.equal(await text('#b64-dump'), data.texts[0].as['utf-8'].dump);
  for (const t of data.texts.slice(11, 20)) {
    await type(t.text);
    assert.equal(await text('#b64-dump'), t.as['utf-8'].dump, t.text);
  }
  await type('');
  assert.equal(await text('#b64-dump'), '');
  assert.equal(await text('#b64-hex-note'), 'There are no bytes to show yet.');
  await page.setInputFiles('#b64-file', file('all-bytes.bin'));
  await settles('#b64-hex-summary', 'Hex dump of the input (512 bytes)');
  assert.equal(await text('#b64-dump'), files['all-bytes.bin'].dump16);
  assert.equal(await text('#b64-hex-note'), '');
  await page.click('#b64-file-remove');
  await setMode('decode');
  await type(png.std);
  assert.equal(await text('#b64-hex-summary'), 'Hex dump of the decoded data (83 bytes)');
  assert.equal(await text('#b64-dump'), png.dump16);
  await type('SGk');
  assert.equal(await text('#b64-dump'), '00000000  48 69                                             |Hi|');
  await page.check('#b64-strict');
  assert.equal(await text('#b64-dump'), '');
  assert.equal(await text('#b64-hex-summary'), 'Hex dump');
  await page.uncheck('#b64-strict');
  // Only the first 4,096 bytes are listed.
  await setMode('encode');
  await type('0123456789'.repeat(500));
  assert.equal(await text('#b64-hex-note'), 'The first 4,096 of 5,000 bytes are shown.');
  const dumped = (await text('#b64-dump')).split('\n');
  assert.equal(dumped.length, 256);
  assert.equal(dumped[255], '00000ff0  30 31 32 33 34 35 36 37  38 39 30 31 32 33 34 35  |0123456789012345|');

  // ---- Use result as input, copy, download, clear ----
  // A carriage return survives the round trip, although the box shows it as a line feed.
  await setMode('decode');
  await type('YQ0KYg==');
  await page.click('#b64-swap');
  assert.equal(await page.isChecked('input[name="b64-mode"][value="encode"]'), true);
  assert.equal(await page.inputValue('#b64-input'), 'a\nb');
  assert.equal(await out(), 'YQ0KYg==');
  assert.equal(await text('#b64-stats'), encStats(4, 8));
  // Once the box is edited, what it shows is what counts.
  assert.equal(await type('a\nbc'), b64('a\nbc'));
  await type('Grüße aus Köln');
  await page.click('#b64-swap');
  assert.equal(await page.isChecked('input[name="b64-mode"][value="decode"]'), true);
  assert.equal(await page.inputValue('#b64-input'), b64('Grüße aus Köln'));
  assert.equal(await out(), 'Grüße aus Köln');
  assert.equal(await copied(), 'Grüße aus Köln');
  dl = await download();
  assert.equal(dl.name, 'decoded.txt');
  assert.deepEqual(dl.bytes, Buffer.from('Grüße aus Köln', 'utf8'));
  await page.click('#b64-swap');
  assert.equal(await page.isChecked('input[name="b64-mode"][value="encode"]'), true);
  assert.equal(await page.inputValue('#b64-input'), 'Grüße aus Köln');
  assert.equal(await out(), b64('Grüße aus Köln'));
  assert.equal(await copied(), b64('Grüße aus Köln'));
  dl = await download();
  assert.equal(dl.name, 'base64.txt');
  assert.equal(dl.bytes.toString('utf8'), b64('Grüße aus Köln'));
  await setMode('auto');
  await page.click('#b64-swap');
  assert.equal(await page.isChecked('input[name="b64-mode"][value="auto"]'), true);
  assert.equal(await out(), 'Grüße aus Köln');
  await page.click('#b64-clear');
  assert.equal(await page.inputValue('#b64-input'), '');
  assert.equal(await out(), '');
  assert.equal(await text('#b64-stats'), '');
  assert.equal(await text('#b64-auto'), '');
  assert.deepEqual([await page.isDisabled('#b64-copy'), await page.isDisabled('#b64-download'), await page.isDisabled('#b64-swap')], [true, true, true]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-input');

  // ---- What a screen reader hears: said once typing pauses, and only when it changes ----
  await type('hi');
  await status(`${AUTO_ENC} Encoded 2 bytes to 4 characters of Base64.`);
  await page.evaluate(() => {
    window.b64Writes = 0;
    new MutationObserver(m => { window.b64Writes += m.length; }).observe(document.querySelector('#b64-status'), { childList: true, characterData: true, subtree: true });
  });
  await type('ho');
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.b64Writes), 0);
  await type('aGk=');
  await status(`${AUTO_DEC} Decoded 2 bytes: text in UTF-8.`);
  await setMode('decode');
  await status('Decoded 2 bytes: text in UTF-8.');
  await type('aGk=!');
  await status('Decoded 2 bytes: text in UTF-8. 1 character that is not Base64 was skipped (“!”).');
  await page.check('#b64-strict');
  await status('“!” (character 5) is not in the Base64 alphabet.');
  await page.uncheck('#b64-strict');
  assert.ok(await page.evaluate(() => window.b64Writes) >= 4);
  assert.equal(await page.locator('#b64-status').evaluate(el => el.getAttribute('role')), 'status');

  // ---- Long input: nothing freezes, and the limit comes with a message ----
  const started = Date.now();
  await setMode('auto');
  await paste('a'.repeat(1048576));
  await settles('#b64-stats', encStats(1048576, 1398104));
  assert.equal(await out(), 'YWFh'.repeat(125000));
  assert.equal(await text('#b64-note'), 'The box shows the first 500,000 of 1,398,104 characters. Copy and Download give all of them.');
  // A megabyte of spaces is text like any other here (and where a careless pattern takes minutes).
  await paste(' '.repeat(1048576));
  await page.waitForFunction(() => document.querySelector('#b64-output').value.startsWith('ICAgICAg'), null, { timeout: 15000 }).catch(() => {});
  assert.equal(await out(), 'ICAg'.repeat(125000));
  assert.equal(await text('#b64-stats'), encStats(1048576, 1398104));
  const long = 'Base64 is fine. '.repeat(49152);
  assert.equal(b64(long).length, 1048576);
  await paste(b64(long));
  await settles('#b64-stats', '1,048,576 Base64 characters in, 786,432 bytes out: text in UTF-8.');
  assert.equal(await text('#b64-auto'), AUTO_DEC);
  assert.equal(await out(), long.slice(0, 500000));
  assert.equal(await text('#b64-note'), 'The box shows the first 500,000 of 786,432 characters. Copy and Download give all of them.');
  assert.equal(await copied(), long);
  await setMode('decode');
  for (const [junk, msg] of [[' ', ''], ['=', 'There is nothing to decode: no character here is in the Base64 alphabet.'], ['-', 'There is nothing to decode: no character here is in the Base64 alphabet.'],
    ['%', 'There is nothing to decode: no character here is in the Base64 alphabet.'], ['\n', ''], ['é', 'There is nothing to decode: no character here is in the Base64 alphabet.']]) {
    await paste('QUJD');
    await settles('#b64-stats', '4 Base64 characters in, 3 bytes out: text in UTF-8.');
    await paste(junk.repeat(1048576));
    await settles('#b64-stats', '');
    await settles('#b64-error', msg);
    assert.equal(await out(), '');
  }
  await page.check('#b64-strict');
  await paste('QUJD'.repeat(262144) + '!');
  await settles('#b64-error', '“!” (character 1,048,577) is not in the Base64 alphabet.');
  await paste(' '.repeat(1048576) + 'QUJD' + '\n'.repeat(1048576));
  await settles('#b64-stats', '4 Base64 characters in, 3 bytes out: text in UTF-8.');
  await page.uncheck('#b64-strict');
  await paste('Q'.repeat(10000001));
  await settles('#b64-error', 'This is 10,000,001 characters long. The box takes up to 10,000,000; open longer data as a file.');
  assert.equal(await out(), '');
  assert.equal(await attr('#b64-input', 'aria-invalid'), 'true');
  await setMode('encode');
  await settles('#b64-error', 'This is 10,000,001 characters long. The box takes up to 10,000,000; open longer data as a file.');
  await paste('hi');
  await settles('#b64-stats', encStats(2, 4));
  assert.deepEqual(await errors(), NONE);
  assert.ok(Date.now() - started < 90000, `long input took ${Date.now() - started} ms`);

  // ---- The whole flow from the keyboard ----
  await open();
  await page.focus('input[name="b64-mode"][value="auto"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.isChecked('input[name="b64-mode"][value="decode"]'), true);
  assert.notEqual(await page.$eval('input[name="b64-mode"]:checked + span', el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-file');
  assert.notEqual(await page.$eval('label[for="b64-file"]', el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-input');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('SGVsbG8sIFdvcmxkIQ==');
  assert.equal(await out(), 'Hello, World!');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-strict');
  await page.keyboard.press('Space');
  assert.equal(await page.isChecked('#b64-strict'), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-charset');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-output');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'b64-copy');
  assert.notEqual(await page.$eval('#b64-copy', el => getComputedStyle(el).outlineStyle), 'none');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#b64-copy').textContent === 'Copied!');
  assert.equal(await clipboard(), 'Hello, World!');
  // Labels: every field and button has a name, and a button's name starts with what it shows.
  const unnamed = await page.$$eval('.b64 textarea, .b64 input, .b64 select, .b64 button, .b64 summary', els => els.filter(el => {
    const label = el.labels && el.labels.length ? el.labels[0].textContent.trim() : '';
    const name = el.getAttribute('aria-label') || label || el.textContent.trim();
    return !name || (el.tagName === 'BUTTON' && el.textContent.trim() && !name.startsWith(el.textContent.trim()));
  }).map(el => el.id || el.outerHTML.slice(0, 60)));
  assert.deepEqual(unnamed, []);

  // ---- Back from another page: the browser may put typed values back after the script ran ----
  await setMode('auto');
  await page.uncheck('#b64-strict');
  await type('Zm9v');
  assert.equal(await out(), 'foo');
  await page.goto(`${base}/about/`, { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'load' });
  const restored = await page.inputValue('#b64-input');
  assert.ok(['Zm9v', 'Hello, World!'].includes(restored), restored);
  const mode = await page.$eval('input[name="b64-mode"]:checked', el => el.value);
  assert.equal(await out(), restored === 'Zm9v' ? (mode === 'encode' ? 'Wm05dg==' : 'foo') : (mode === 'decode' ? '\u001d\uFFFDe\uFFFDk\u001aY' : 'SGVsbG8sIFdvcmxkIQ=='), `${restored} in mode ${mode}`);
  assert.equal(await text('#b64-output-label'), (await out()) === 'foo' || mode === 'decode' ? 'Decoded text' : 'Base64');

  // ---- The FAQ covers privacy ----
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.match(faqs[faqs.length - 1], /uploaded/);

  // ---- A phone with a touch screen ----
  const browser = page.context().browser();
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  const ph = on(p);
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('.b64-seg label:nth-child(3)');
  assert.equal(await p.isChecked('input[name="b64-mode"][value="decode"]'), true);
  await p.tap('#b64-input');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('SGk=');
  assert.equal(await ph.out(), 'Hi');
  await p.tap('#b64-swap');
  assert.equal(await p.inputValue('#b64-input'), 'Hi');
  assert.equal(await ph.out(), 'SGk=');
  await p.tap('.b64-seg label:nth-child(1)');
  await p.setInputFiles('#b64-file', file('all-bytes.bin'));
  await ph.settles('#b64-file-name', 'all-bytes.bin');
  // On a narrow screen the dump has 8 bytes on a line.
  await p.tap('#b64-hex summary');
  await ph.settles('#b64-dump', files['all-bytes.bin'].dump8);
  await p.tap('#b64-file-remove');
  await ph.type(png.std);
  await ph.settles('#b64-img-info', 'PNG image, 3 × 2 pixels, 83 bytes.');
  assert.equal(await ph.text('#b64-dump'), png.dump8);
  // Controls are at least 44 px tall and text boxes use 16 px type (no zoom on iOS).
  await ph.type('Hello');
  const sizes = await p.$$eval('.b64 button, .b64 textarea, .b64 select, .b64-seg span, .b64 .check, .b64 summary, .b64-pick label', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id || e.textContent.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), field: /TEXTAREA|SELECT/.test(e.tagName),
  })));
  assert.ok(sizes.length >= 16, `found ${sizes.length} controls`);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px text`);
  }
  // Nothing is cut off at any phone width: buttons, labels, and every choice of the two menus.
  await ph.type('x'.repeat(300));
  await p.check('#b64-datauri');
  for (const width of [320, 340, 360, 390, 412, 480, 540]) {
    await p.setViewportSize({ width, height: 800 });
    const cut = await p.$$eval('.b64 button, .b64-seg span, .b64 label, .b64 summary, .b64 legend, .b64-pick label', els => els.filter(e => e.offsetParent).filter(e => {
      const r = e.getBoundingClientRect(), card = e.closest('.tool-card').getBoundingClientRect();
      return e.scrollWidth > e.clientWidth + 1 || r.right > card.right + 0.5 || r.left < card.left - 0.5;
    }).map(e => e.id || e.textContent.trim().slice(0, 30)));
    assert.deepEqual(cut, [], `cut off at ${width}px`);
    for (const id of ['b64-charset', 'b64-wrap']) {
      const tight = await p.$eval('#' + id, s => {
        const c = document.createElement('canvas').getContext('2d'), cs = getComputedStyle(s);
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        // 28 px are kept free for the arrow of the menu.
        const room = Math.floor(s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 28);
        return [...s.options].filter(o => Math.ceil(c.measureText(o.textContent).width) > room).map(o => `${o.textContent} (room ${room}px)`);
      });
      assert.deepEqual(tight, [], `choices of #${id} cut off at ${width}px`);
    }
    assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `sideways scroll at ${width}px`);
  }
  await phone.close();
};
