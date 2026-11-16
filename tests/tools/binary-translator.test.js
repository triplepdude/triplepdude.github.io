const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected values come from tests/fixtures/binary-translator/expected.py (Python's own
// UTF-8 codec and integers), from Node's Buffer, from RFC 3629 and RFC 20, or are worked
// out by hand in the comments. Nothing is read back from the page.
module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const bits = (s, sep = ' ') => [...Buffer.from(s, 'utf8')].map(b => b.toString(2).padStart(8, '0')).join(sep);
  const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

  await open();
  const out = () => page.inputValue('#bn-output');
  const text = sel => page.locator(sel).textContent();
  const attr = (sel, name) => page.getAttribute(sel, name);
  const setDir = v => page.check(`input[name="bn-dir"][value="${v}"]`);
  const dirIs = v => page.isChecked(`input[name="bn-dir"][value="${v}"]`);
  const type = async s => { await page.fill('#bn-input', s); return out(); };
  // The first text of every cell: a flag under the digits is left out.
  const rows = () => page.$$eval('#bn-rows tr', trs => trs.map(tr => [...tr.cells].map(c => c.firstChild ? c.firstChild.textContent : '')));
  // Waits until the element says this, and shows what it says instead when it never does.
  const settles = (sel, expected, on = page) => on.waitForFunction(([s, t]) => document.querySelector(s).textContent === t, [sel, expected], { timeout: 15000 })
    .catch(async () => assert.equal(await on.locator(sel).textContent(), expected));
  const status = expected => settles('#bn-status', expected);
  // Like a paste: the whole value arrives at once.
  // Clicks a copy button and returns what arrived on the clipboard, once it has arrived.
  const copied = async sel => {
    await page.evaluate(() => navigator.clipboard.writeText('(nothing copied yet)'));
    await page.click(sel);
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== '(nothing copied yet)', null, { timeout: 5000 }).catch(() => {});
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const paste = (sel, value) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);

  // ---- Defaults: an example is on the page, and nothing is announced on load ----
  assert.equal(await page.inputValue('#bn-input'), 'Hi 👋');
  assert.equal(await dirIs('t2b'), true);
  assert.equal(await out(), data.encode[0].spaced);
  assert.equal(await out(), '01001000 01101001 00100000 11110000 10011111 10010001 10001011');
  assert.equal(await text('#bn-summary'), '4 characters, 7 bytes, 56 bits.');
  assert.equal(await text('#bn-input-label'), 'Text');
  assert.equal(await text('#bn-output-label'), 'Binary code');
  assert.equal(await text('#bn-col-bin'), 'Binary (UTF-8 bytes)');
  assert.deepEqual((await rows())[3], ['👋', 'U+1F44B', '11110000 10011111 10010001 10001011', 'F0 9F 91 8B', '240 159 145 139']);
  await page.waitForTimeout(900);
  assert.equal(await text('#bn-status'), '');
  assert.equal(await text('#bn-error'), '');
  assert.equal(await attr('#bn-input', 'aria-invalid'), null);

  // Until something is typed, the example follows the direction, where an untouched "Hi"
  // would only be reported as bad binary.
  await setDir('b2t');
  assert.equal(await page.inputValue('#bn-input'), data.encode[0].spaced);
  assert.equal(await out(), 'Hi 👋');
  assert.equal(await text('#bn-error'), '');
  await setDir('t2b');
  assert.equal(await page.inputValue('#bn-input'), 'Hi 👋');
  assert.equal(await out(), data.encode[0].spaced);
  // What was typed is never replaced: it stays, with a message.
  await type('abc');
  await setDir('b2t');
  assert.equal(await page.inputValue('#bn-input'), 'abc');
  assert.equal(await out(), '');
  assert.equal(await text('#bn-error'), '\u201Ca\u201D is not a binary digit (character 1). Binary code uses only 0 and 1.');
  await setDir('t2b');
  assert.equal(await page.inputValue('#bn-input'), 'abc');

  // ---- Text to binary: UTF-8 bytes, eight digits each ----
  for (const e of data.encode) {
    assert.equal(await type(e.text), e.spaced, JSON.stringify(e.text));
    assert.equal(e.spaced, bits(e.text));
    assert.equal(await text('#bn-summary'), `${plural(e.chars, 'character')}, ${plural(e.bytes, 'byte')}, ${plural(e.bytes * 8, 'bit')}.`);
    assert.deepEqual((await rows()).map(r => r.slice(1)), e.rows, JSON.stringify(e.text));
  }
  // The per-character table names what cannot be seen.
  await type('a\tb\nc \u00A0\u200D');
  assert.deepEqual((await rows()).map(r => r[0]), ['a', 'HT (horizontal tab)', 'b', 'LF (line feed)', 'c', 'Space', 'No-break space', 'Zero width joiner']);
  await type('e\u0301\u007f\u2028');
  assert.deepEqual((await rows()).map(r => r[0]), ['e', '\u25CC\u0301', 'DEL (delete)', 'Line separator']);
  // Half of a surrogate pair is not a character: UTF-8 has no bytes for it, U+FFFD is written.
  await paste('#bn-input', 'a\ud83d');
  assert.equal(await out(), '01100001 11101111 10111111 10111101');
  assert.equal(await text('#bn-summary'), '2 characters, 4 bytes, 32 bits. 1 half of a surrogate pair was written as \uFFFD.');
  assert.match(await page.locator('#bn-rows tr').nth(1).textContent(), /Half of a surrogate pair is not a character/);
  // Without the space between bytes.
  await page.uncheck('#bn-space');
  for (const e of data.encode) assert.equal(await type(e.text), e.joined, JSON.stringify(e.text));
  await page.check('#bn-space');
  assert.equal(await type('hi'), '01101000 01101001');
  // The table lists the first 100 characters of a long text.
  await type('ab'.repeat(75));
  assert.equal(await page.locator('#bn-rows tr').count(), 100);
  assert.equal(await text('#bn-rows-note'), 'The first 100 of 150 characters are listed.');
  await type('ab'.repeat(50));
  assert.equal(await page.locator('#bn-rows tr').count(), 100);
  assert.equal(await text('#bn-rows-note'), '');

  // ---- Binary to text ----
  await setDir('b2t');
  assert.equal(await text('#bn-input-label'), 'Binary code');
  assert.equal(await text('#bn-output-label'), 'Text');
  assert.equal(await page.isVisible('#bn-space'), false);
  // Every sample comes back, whatever stands between the bytes.
  for (const e of data.encode) {
    for (const b of [e.spaced, e.joined, e.spaced.replace(/ /g, '\n'), e.spaced.replace(/ /g, ', '), e.spaced.replace(/ /g, '\r\n\t')]) {
      assert.equal(await type(b), e.text, JSON.stringify(e.text) + ' from ' + JSON.stringify(b.slice(0, 40)));
      assert.equal(await text('#bn-error'), '');
    }
    assert.equal(await text('#bn-summary'), `${plural(e.bytes * 8, 'binary digit')}, ${plural(e.bytes, 'byte')}, ${plural(e.chars, 'character')}.`);
    assert.deepEqual((await rows()).map(r => r.slice(1)), e.rows);
  }
  // What the FAQ says: 01101000 is 104 (h) and 01101001 is 105 (i).
  assert.equal(await type('01101000 01101001'), 'hi');
  assert.equal(await text('#bn-summary'), '16 binary digits, 2 bytes, 2 characters.');
  // The guide's example: 79 and 75 are O and K (RFC 20).
  assert.equal(await type('01001111 01001011'), 'OK');
  assert.equal(await type('1001111 1001011'), 'OK');
  // Lenient: 0b prefixes, punctuation, no-break and zero-width spaces that come with a paste.
  assert.equal(await type('0b01101000,0b01101001'), 'hi');
  assert.equal(await type('0B01101000 0b1101001'), 'hi');
  assert.equal(await type('[01101000|01101001]'), 'hi');
  assert.equal(await type('\uFEFF01101000\u00A001101001\u200B\u3000'), 'hi');
  assert.equal(await type('  01101000\r\n01101001\t'), 'hi');
  // Typographic punctuation and direction marks that come with a paste from a document.
  assert.equal(await type('“01101000—01101001”'), 'hi');
  assert.equal(await type('01101000…01101001·01101000–01101001'), 'hihi');
  assert.equal(await type('\u200E«01101000、01101001»\u200F\u202A'), 'hi');
  // A mark beyond the first 65,536 code points takes two UTF-16 units (U+1D173 is a format character).
  assert.equal(await type('01101000\u{1D173}01101001'), 'hi');
  assert.equal(await text('#bn-error'), '');
  // Groups shorter than a byte get leading zeros: 7-bit ASCII, and tools that drop them
  // (H e l l o space line-feed w: 72 101 108 108 111 32 10 119).
  assert.equal(await type('1101000 1101001'), 'hi');
  assert.equal(await text('#bn-summary'), '14 binary digits, 2 bytes, 2 characters. Groups shorter than 8 digits were filled with leading zeros.');
  assert.equal(await type('1001000 1100101 1101100 1101100 1101111 100000 1010 1110111'), 'Hello \nw');
  // 24 digits in groups of 7, 7, 6 and 4: still one byte per group, not three bytes.
  assert.equal(await type('1101000 1101001 100001 1010'), 'hi!\n');
  // Tab, ! and line feed as groups of 5, 6 and 5 digits. Joined, the 16 digits would be "L*",
  // but groups of up to 8 digits are one byte each whenever that gives text.
  assert.equal(await type('01001 100001 01010'), '\t!\n');
  assert.equal(await type('1101000'), 'h');
  assert.equal(await type('0'), '\u0000');
  // Nibbles and odd spacing: one byte per group would give control codes, so the digits are joined.
  assert.equal(await type('0110 1000 0110 1001'), 'hi');
  assert.equal(await text('#bn-summary'), '16 binary digits, 2 bytes, 2 characters. The digits were joined and read 8 at a time.');
  assert.equal(await type('01101 000011 01001'), 'hi');
  assert.equal(await type('0110100001101001 0110100001101001'), 'hihi');
  assert.equal(await type('011010000110\n1001'), 'hi');
  // One number per character instead of UTF-8 bytes: Latin-1 bytes, code points, UTF-16 units.
  assert.equal(await type('01100011 01100001 01100110 11101001'), 'café');
  assert.equal(await text('#bn-summary'), '32 binary digits, 4 groups, 4 characters. Each group was read as the number of one character (its Unicode code point), because as UTF-8 bytes the digits do not give readable text.');
  assert.equal(await text('#bn-col-bin'), 'Binary (code point)');
  assert.deepEqual((await rows())[3], ['é', 'U+00E9', '11101001', 'E9', '233']);
  for (const c of data.codepoints.concat(data.utf16)) {
    assert.equal(await type(c.binary), c.text, c.binary);
    assert.equal(await text('#bn-error'), '');
    assert.match(await text('#bn-summary'), /Each group was read as the number of one character/);
  }
  assert.deepEqual(await rows(), [['h', 'U+0068', '1101000', '68', '104'], ['i', 'U+0069', '1101001', '69', '105']]);
  await type(data.utf16.find(c => c.text === 'x😀y').binary);
  assert.deepEqual((await rows())[1], ['😀', 'U+1F600', '1101100000111101 1101111000000000', 'D83D DE00', '55357 56832']);
  // The largest code point is U+10FFFF; one more is not a character.
  assert.equal(await type('100001111111111111111 1101000'), '\u{10FFFF}h');
  assert.equal(await type('100010000000000000000 1101000'), '');
  assert.equal(await text('#bn-error'), 'These groups cannot be read as characters: the longest has 21 digits, and the 28 digits together do not make whole 8-bit bytes.');
  assert.equal(await type('1101100000111101 1101000'), '\uFFFDh');
  assert.match(await text('#bn-summary'), /Half a surrogate pair is not a character and is shown as \uFFFD\.$/);
  // A group on its own is read the same way when it is no UTF-8: the guide's examples, \u00E9 and the Cyrillic \u043F.
  assert.equal(await type('11101001'), '\u00E9');
  assert.equal(await text('#bn-summary'), '8 binary digits, 1 group, 1 character. The group was read as the number of one character (its Unicode code point), because as UTF-8 it does not give readable text.');
  assert.equal(await text('#bn-error'), '');
  assert.equal(await type('10000111111'), '\u043F');
  assert.equal(await text('#bn-error'), '');
  assert.deepEqual(await rows(), [['\u043F', 'U+043F', '10000111111', '43F', '1087']]);
  // U+0080 is a control code, so that byte stays a byte that is not UTF-8.
  assert.equal(await type('10000000'), '\uFFFD');
  // Valid UTF-8 wins over the other readings, also for the bytes of é, € and an emoji.
  assert.equal(await type('11000011 10101001'), 'é');
  assert.equal(await text('#bn-col-bin'), 'Binary (UTF-8 bytes)');
  assert.equal(await type('11100010 10000010 10101100'), '€');
  assert.equal(await type('11110000 10011111 10010001 10001011'), '👋');
  // Control codes are kept when that is what the bytes say (ESC [ 1 m).
  assert.equal(await type('00011011 01011011 00110001 01101101'), '\u001b[1m');
  assert.deepEqual((await rows())[0], ['ESC (escape)', 'U+001B', '00011011', '1B', '27']);

  // Bytes that are not UTF-8 are decoded as browsers do it (WHATWG Encoding Standard).
  for (const b of data.lossy) {
    assert.equal(await type(b.binary), b.text, b.hex);
    assert.equal(b.text, await page.evaluate(h => new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(h.match(/../g), x => parseInt(x, 16))), b.hex), b.hex);
    assert.match(await text('#bn-summary'), /Not all bytes are valid UTF-8: the others are shown as \uFFFD\.$/, b.hex);
    assert.equal(await text('#bn-error'), '');
  }
  await type(data.lossy[0].binary);
  assert.match(await page.locator('#bn-rows tr').first().textContent(), /^\uFFFDU\+FFFD11111111Not valid UTF-8FF255$/);
  for (const b of data.strict) {
    assert.equal(await type(b.binary), b.text, b.hex);
    assert.doesNotMatch(await text('#bn-summary'), /Not all bytes/, b.hex);
  }
  // Separate bytes: 11000000 10000000 is no character in any reading.
  assert.equal(await type('11000000 10000000'), '\uFFFD\uFFFD');
  assert.equal(await type('11111111 01101000'), 'ÿh');

  // ---- Errors ----
  assert.equal(await type('01101000 hello'), '');
  assert.equal(await text('#bn-error'), '“h” is not a binary digit (character 10). Binary code uses only 0 and 1.');
  assert.equal(await attr('#bn-input', 'aria-invalid'), 'true');
  assert.ok((await attr('#bn-input', 'aria-describedby')).split(' ').includes('bn-error'));
  assert.equal(await page.locator('#bn-error').evaluate(el => el.matches('.msg.error')), true);
  assert.equal(await page.isDisabled('#bn-copy'), true);
  assert.equal(await page.isDisabled('#bn-download'), true);
  assert.equal(await page.locator('#bn-rows tr').count(), 0);
  assert.equal(await page.isVisible('#bn-suggest'), true);
  assert.equal(await text('#bn-suggest-text'), 'Is this ordinary text?');
  assert.equal(await text('#bn-suggest-btn'), 'Translate it to binary');
  await status('“h” is not a binary digit (character 10). Binary code uses only 0 and 1. Is this ordinary text? The button after the box switches the direction.');
  await type('01101002');
  assert.equal(await text('#bn-error'), '“2” is not a binary digit (character 8). Binary code uses only 0 and 1.');
  await type('O1101000');
  assert.equal(await text('#bn-error'), '“O” is not a binary digit (character 1). Binary code uses only 0 and 1.');
  await type('0110\u0661');
  assert.equal(await text('#bn-error'), '“\u0661” is not a binary digit (character 5). Binary code uses only 0 and 1.');
  await type('01 😀');
  assert.equal(await text('#bn-error'), '“😀” is not a binary digit (character 4). Binary code uses only 0 and 1.');
  await type('10b1');
  assert.equal(await text('#bn-error'), '“b” is not a binary digit (character 3). Binary code uses only 0 and 1.');
  // Punctuation may stand between groups, but symbols may not.
  await type('01101000 © 01101001');
  assert.equal(await text('#bn-error'), '“©” is not a binary digit (character 10). Binary code uses only 0 and 1.');
  // Mending the input takes the message away.
  assert.equal(await type('01101000'), 'h');
  assert.equal(await text('#bn-error'), '');
  assert.equal(await attr('#bn-input', 'aria-invalid'), null);
  assert.equal(await page.isVisible('#bn-suggest'), false);
  assert.equal(await page.isDisabled('#bn-copy'), false);
  // One run that is not a whole number of bytes: the whole bytes are shown, the rest is named.
  assert.equal(await type('011010000110100'), 'h');
  assert.equal(await text('#bn-error'), '15 binary digits do not make whole 8-bit bytes: the last 7 digits were left out. A digit may be missing, or the groups need spaces between them.');
  assert.equal(await attr('#bn-input', 'aria-invalid'), 'true');
  assert.equal(await type('011010000'), 'h');
  assert.equal(await text('#bn-error'), '9 binary digits do not make whole 8-bit bytes: the last digit was left out. A digit may be missing, or the groups need spaces between them.');
  assert.equal(await type('111111111111111111111111111111111 1'), '');
  assert.equal(await text('#bn-error'), 'These groups cannot be read as characters: the longest has 33 digits, and the 34 digits together do not make whole 8-bit bytes.');
  // Groups of four with a digit missing are not control codes: the whole bytes are shown, and the rest is named.
  assert.equal(await type('0100 1000 0110 100'), 'H');
  assert.equal(await text('#bn-error'), '15 binary digits do not make whole 8-bit bytes: the last 7 digits were left out. A digit may be missing, or the groups need spaces between them.');
  // ... but control codes stay when the joined digits give no text either (ESC [ 1 m without leading zeros).
  assert.equal(await type('00011011 1011011 110001 1101101'), '\u001b[1m');
  assert.equal(await text('#bn-error'), '');
  // Nothing but separators is nothing to translate, not a mistake.
  assert.equal(await type(' \n , '), '');
  assert.equal(await text('#bn-error'), '');
  assert.equal(await text('#bn-summary'), '');

  // The offer to turn round: text typed into the binary box.
  await type('hello');
  await page.click('#bn-suggest-btn');
  assert.equal(await dirIs('t2b'), true);
  assert.equal(await out(), bits('hello'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-input');
  assert.equal(await page.isVisible('#bn-suggest'), false);
  // And binary typed into the text box: it is translated as text, with an offer.
  assert.equal(await type('01101000 01101001'), bits('01101000 01101001'));
  assert.equal(await page.isVisible('#bn-suggest'), true);
  assert.equal(await text('#bn-suggest-text'), 'This looks like binary code.');
  assert.equal(await text('#bn-suggest-btn'), 'Translate it to text');
  await page.click('#bn-suggest-btn');
  assert.equal(await dirIs('b2t'), true);
  assert.equal(await out(), 'hi');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-input');
  await setDir('t2b');
  for (const notBinary of ['0110100', '0110100 x', '1.01101000', 'hello']) {
    await type(notBinary);
    assert.equal(await page.isVisible('#bn-suggest'), false, notBinary);
  }

  // ---- Swap, copy, download, clear ----
  await type('Hi 👋');
  await page.click('#bn-swap');
  assert.equal(await dirIs('b2t'), true);
  assert.equal(await page.inputValue('#bn-input'), data.encode[0].spaced);
  assert.equal(await out(), 'Hi 👋');
  assert.equal(await copied('#bn-copy'), 'Hi 👋');
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bn-download')]);
  assert.equal(dl.suggestedFilename(), 'text.txt');
  assert.deepEqual(fs.readFileSync(await dl.path()), Buffer.from('Hi 👋', 'utf8'));
  await page.click('#bn-swap');
  assert.equal(await dirIs('t2b'), true);
  assert.equal(await page.inputValue('#bn-input'), 'Hi 👋');
  assert.equal(await out(), data.encode[0].spaced);
  assert.equal(await copied('#bn-copy'), data.encode[0].spaced);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bn-download')]);
  assert.equal(dl.suggestedFilename(), 'binary.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), data.encode[0].spaced);
  // A carriage return survives: the box shows it as a line feed, but Copy, Download and Swap keep the byte.
  await setDir('b2t');
  assert.equal(await type('01100001 00001101 00001010 01100010'), 'a\nb');
  assert.equal(await copied('#bn-copy'), 'a\r\nb');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bn-download')]);
  assert.deepEqual(fs.readFileSync(await dl.path()), Buffer.from('a\r\nb', 'utf8'));
  await page.click('#bn-swap');
  assert.equal(await dirIs('t2b'), true);
  assert.equal(await out(), '01100001 00001101 00001010 01100010');
  assert.equal(await text('#bn-summary'), '4 characters, 4 bytes, 32 bits.');
  // Once the box is edited, what it shows is what counts.
  assert.equal(await type((await page.inputValue('#bn-input')) + 'c'), '01100001 00001010 01100010 01100011');
  // With nothing to swap in, Swap turns the direction and keeps what was typed.
  await setDir('b2t');
  await type('hello');
  await page.click('#bn-swap');
  assert.equal(await dirIs('t2b'), true);
  assert.equal(await page.inputValue('#bn-input'), 'hello');
  assert.equal(await out(), bits('hello'));
  await page.click('#bn-clear');
  assert.equal(await page.inputValue('#bn-input'), '');
  assert.equal(await out(), '');
  assert.equal(await text('#bn-summary'), '');
  assert.equal(await page.isDisabled('#bn-copy'), true);
  assert.equal(await page.isDisabled('#bn-download'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-input');
  assert.equal(await text('#bn-rows-note'), 'Each character is listed here with its codes as soon as there is something to translate.');

  // ---- What a screen reader hears: said once typing pauses, and only when it changes ----
  await type('hi');
  await status('2 characters translated to 16 binary digits.');
  await page.evaluate(() => {
    window.bnWrites = 0;
    new MutationObserver(m => { window.bnWrites += m.length; }).observe(document.querySelector('#bn-status'), { childList: true, characterData: true, subtree: true });
  });
  await type('ho');
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.bnWrites), 0);
  await type('hi 01101000 01101001');
  await status('20 characters translated to 160 binary digits.');
  await type('01101000 01101001');
  await status('17 characters translated to 136 binary digits. This looks like binary code. The button after the box switches the direction.');
  await setDir('b2t');
  await status('16 binary digits translated to 2 characters.');
  assert.ok(await page.evaluate(() => window.bnWrites) >= 3);
  assert.equal(await page.locator('#bn-status').evaluate(el => el.getAttribute('role')), 'status');

  // ---- Long input: a message before anything reads it, and no frozen page ----
  let started = Date.now();
  await paste('#bn-input', '01101000'.repeat(131072));
  await settles('#bn-error', 'This is 1,048,576 characters long. The most this page translates at once is 1,000,000.');
  assert.equal(await out(), '');
  assert.equal(await attr('#bn-input', 'aria-invalid'), 'true');
  await paste('#bn-input', '01101000'.repeat(125000));
  await settles('#bn-summary', '1,000,000 binary digits, 125,000 bytes, 125,000 characters.');
  assert.equal(await out(), 'h'.repeat(125000));
  assert.equal(await text('#bn-error'), '');
  assert.equal(await text('#bn-rows-note'), 'The first 100 of 125,000 characters are listed.');
  // A megabyte of spaces is where a careless pattern takes minutes.
  await paste('#bn-input', ' '.repeat(1000000));
  await settles('#bn-summary', '');
  assert.equal(await out(), '');
  assert.equal(await text('#bn-error'), '');
  await paste('#bn-input', '0 1 '.repeat(250000));
  await settles('#bn-summary', '500,000 binary digits, 62,500 bytes, 62,500 characters. The digits were joined and read 8 at a time.');
  assert.equal(await out(), 'U'.repeat(62500));
  await paste('#bn-input', ' '.repeat(999999) + 'x');
  await settles('#bn-error', '\u201cx\u201d is not a binary digit (character 1,000,000). Binary code uses only 0 and 1.');
  await paste('#bn-input', 'hi');
  await settles('#bn-error', '\u201ch\u201d is not a binary digit (character 1). Binary code uses only 0 and 1.');
  await setDir('t2b');
  await paste('#bn-input', 'a'.repeat(1048576));
  await settles('#bn-error', 'This text has 1,048,576 characters. The most this page translates at once is 100,000.');
  assert.equal(await out(), '');
  await paste('#bn-input', ' '.repeat(1048577));
  await settles('#bn-error', 'This text has 1,048,577 characters. The most this page translates at once is 100,000.');
  assert.equal(await out(), '');
  await paste('#bn-input', 'é'.repeat(100000));
  await settles('#bn-summary', '100,000 characters, 200,000 bytes, 1,600,000 bits.');
  assert.equal(await text('#bn-error'), '');
  assert.equal((await out()).length, 1799999);
  assert.equal((await out()).slice(0, 35), '11000011 10101001 11000011 10101001');
  await paste('#bn-input', ' '.repeat(100000));
  await settles('#bn-summary', '100,000 characters, 100,000 bytes, 800,000 bits.');
  assert.equal(await out(), Array(100000).fill('00100000').join(' '));
  await paste('#bn-input', 'é'.repeat(100001));
  await settles('#bn-error', 'This text has 100,001 characters. The most this page translates at once is 100,000.');
  for (const id of ['dec', 'bin', 'hex', 'oct']) {
    await paste('#bn-' + id, '1'.repeat(1048576));
    assert.equal(await text(`#bn-${id}-err`), 'This is 1,048,576 characters long. The converter reads numbers of up to 10,000 characters.');
    await paste('#bn-' + id, ' '.repeat(10000));
    assert.equal(await text(`#bn-${id}-err`), '');
    await paste('#bn-' + id, '1 '.repeat(5000));
    assert.equal(await text(`#bn-${id}-err`), id === 'dec' ? 'A space can only stand between groups of three digits, as in 1 234 567. Enter one whole number.' : '');
    if (id !== 'dec') assert.equal(await page.inputValue('#bn-dec'), BigInt({ bin: '0b', hex: '0x', oct: '0o' }[id] + '1'.repeat(5000)).toString());
  }
  await paste('#bn-dec', '9'.repeat(10000));
  assert.equal(await page.inputValue('#bn-hex'), (10n ** 10000n - 1n).toString(16).toUpperCase());
  assert.equal(await text('#bn-num-info'), 'This number takes 33,220 bits (4,153 bytes).');
  assert.ok(Date.now() - started < 60000, `long input took ${Date.now() - started} ms`);
  await type('hi');
  assert.equal(await out(), '01101000 01101001');

  // ---- Number converter: exact at any size ----
  const num = async (id, v) => {
    await page.fill('#bn-' + id, v);
    return { dec: await page.inputValue('#bn-dec'), bin: await page.inputValue('#bn-bin'), hex: await page.inputValue('#bn-hex'), oct: await page.inputValue('#bn-oct') };
  };
  const numErr = async id => ({ msg: await text(`#bn-${id}-err`), invalid: await attr('#bn-' + id, 'aria-invalid') });
  for (const n of data.numbers.concat(data.negatives)) {
    const want = { dec: n.dec, bin: n.bin, hex: n.hex, oct: n.oct };
    for (const id of ['dec', 'bin', 'hex', 'oct']) {
      assert.deepEqual(await num(id, n[id]), want, `${id} ${n[id]}`);
      assert.deepEqual(await numErr(id), { msg: '', invalid: null });
    }
    assert.deepEqual(await num('hex', n.hex.toLowerCase()), { ...want, hex: n.hex.toLowerCase() });
  }
  // 2^53 + 1 is where floating point would lose the last digit.
  assert.equal((await num('dec', '9007199254740993')).bin, '1' + '0'.repeat(52) + '1');
  assert.equal((await num('bin', '1' + '0'.repeat(52) + '1')).dec, '9007199254740993');
  // The note under the boxes.
  await num('dec', '104');
  assert.equal(await text('#bn-num-info'), 'This number takes 7 bits (1 byte). Padded to 8 bits it is 01101000. The place values of its 1s add up: 64 + 32 + 8 = 104.');
  await num('dec', '255');
  assert.equal(await text('#bn-num-info'), 'This number takes 8 bits (1 byte). The place values of its 1s add up: 128 + 64 + 32 + 16 + 8 + 4 + 2 + 1 = 255.');
  await num('dec', '8');
  assert.equal(await text('#bn-num-info'), 'This number takes 4 bits (1 byte). Padded to 8 bits it is 00001000. Its only 1 stands in the place worth 8.');
  await num('dec', '1000');
  assert.equal(await text('#bn-num-info'), 'This number takes 10 bits (2 bytes). Padded to 16 bits it is 0000001111101000. The place values of its 1s add up: 512 + 256 + 128 + 64 + 32 + 8 = 1,000.');
  await num('dec', '65536');
  assert.equal(await text('#bn-num-info'), 'This number takes 17 bits (3 bytes). Padded to 32 bits it is 00000000000000010000000000000000.');
  await num('dec', '1');
  assert.equal(await text('#bn-num-info'), 'This number takes 1 bit (1 byte). Padded to 8 bits it is 00000001.');
  await num('dec', '0');
  assert.equal(await text('#bn-num-info'), '0 is written 0 in every base.');
  await num('dec', '18446744073709551616');
  assert.equal(await text('#bn-num-info'), 'This number takes 65 bits (9 bytes).');
  for (const n of data.negatives) {
    await num('dec', n.dec);
    assert.equal(await text('#bn-num-info'), 'A negative number is written with a minus sign in front of the digits of the positive number.' +
      (n.width ? ` As a signed ${n.width}-bit value (two’s complement) it is ${n.twos}, hex ${n.twosHex}.` : ''), n.dec);
  }
  // Lenient input: prefixes, signs, digit separators, digits of other scripts.
  const reads = async (id, typed, dec) => {
    assert.equal((await num(id, typed)).dec, id === 'dec' ? typed : dec, `${id} ${JSON.stringify(typed)}`);
    assert.deepEqual(await numErr(id), { msg: '', invalid: null }, `${id} ${JSON.stringify(typed)}`);
    assert.equal(await page.inputValue('#bn-hex'), id === 'hex' ? typed : BigInt(dec).toString(16).toUpperCase().replace(/^-(.*)/, '-$1'), `${id} ${JSON.stringify(typed)}`);
  };
  await reads('bin', '0b1010_1010', '170');
  await reads('bin', '1010 1010', '170');
  await reads('bin', "0B1010'1010", '170');
  await reads('bin', '-101', '-5');
  await reads('bin', '  0001\n', '1');
  await reads('hex', '0xDEAD_BEEF', '3735928559');
  await reads('hex', 'dead beef', '3735928559');
  await reads('hex', 'Ff', '255');
  await reads('oct', '0o777', '511');
  await reads('oct', '0777', '511');
  await reads('dec', '+42', '42');
  await reads('dec', '\u22125', '-5');
  await reads('dec', '007', '7');
  await reads('dec', '  42 \n', '42');
  await reads('dec', '1,000', '1000');
  await reads('dec', '1,234,567', '1234567');
  await reads('dec', '12,34,567', '1234567');
  await reads('dec', "1'000'000", '1000000');
  await reads('dec', '1’000', '1000');
  await reads('dec', '1 000 000', '1000000');
  await reads('dec', '1\u00A0000\u00A0000', '1000000');
  await reads('dec', '1\u202F000', '1000');
  await reads('dec', '1_0_0', '100');
  await reads('dec', '1.000.000', '1000000');
  await reads('dec', '\u0661\u0662\u0663', '123');
  await reads('dec', '\u06F1\u06F2\u06F3', '123');
  await reads('dec', '\uFF11\uFF12\uFF13', '123');
  await reads('dec', '\u0967\u0968\u0969', '123');
  await reads('dec', '\u0661\u066C\u0662\u0663\u0664\u066C\u0665\u0666\u0667', '1234567');
  await reads('bin', '\u0661\u0660\u0661', '5');
  assert.equal((await num('dec', '-0')).bin, '0');
  // Decimal commas, thousands separators and pasted junk: never a silent wrong number.
  const refuses = async (id, typed, msg) => {
    const got = await num(id, typed);
    for (const other of ['dec', 'bin', 'hex', 'oct']) {
      assert.equal(got[other], other === id ? typed : '', `${id} ${JSON.stringify(typed)} leaves ${other} = ${got[other]}`);
      assert.deepEqual(await numErr(other), other === id ? { msg, invalid: 'true' } : { msg: '', invalid: null }, `${id} ${JSON.stringify(typed)}`);
      assert.ok((await attr('#bn-' + other, 'aria-describedby')).split(' ').includes(`bn-${other}-err`));
    }
    assert.equal(await text('#bn-num-info'), '');
    assert.equal(await page.isDisabled('[data-copy-target="#bn-bin"]'), id !== 'bin');
  };
  const point = 'Whole numbers only: “.” is read as the decimal point, and fractions cannot be converted here.';
  const comma = 'A comma can only stand between groups of three digits, as in 1,234,567. Enter one whole number.';
  await refuses('dec', '0,500', 'Whole numbers only: a grouped number cannot start with 0, so this looks like a fraction.');
  await refuses('dec', '0,5', 'Whole numbers only: a grouped number cannot start with 0, so this looks like a fraction.');
  await refuses('dec', '1.5', point);
  await refuses('dec', '1.000', point);
  await refuses('dec', '3.125', point);
  await refuses('dec', '1.5.2', point);
  await refuses('dec', '.5', point);
  await refuses('dec', '1,5', comma);
  await refuses('dec', '1,00', comma);
  await refuses('dec', '1,0000', comma);
  await refuses('dec', '1234,567', comma);
  await refuses('dec', '1,000,', comma);
  await refuses('dec', '1,,000', comma);
  await refuses('dec', '12 34', 'A space can only stand between groups of three digits, as in 1 234 567. Enter one whole number.');
  await refuses('dec', "1'0", "An apostrophe can only stand between groups of three digits, as in 1'234'567. Enter one whole number.");
  await refuses('dec', '1,234.5', 'Whole numbers only: this has two kinds of separator, like a number with a fraction.');
  await refuses('dec', '1 234,5', 'Whole numbers only: this has two kinds of separator, like a number with a fraction.');
  await refuses('dec', '\u0661\u066B\u0665', 'Whole numbers only: “\u066B” is read as the decimal separator, and fractions cannot be converted here.');
  await refuses('dec', '\u0661\u066C\u0665', 'The separator \u066C can only stand between groups of three digits, as in 1\u066C234\u066C567. Enter one whole number.');
  await refuses('dec', '5²', '“²” is not a decimal digit. Decimal uses 0 to 9.');
  await refuses('dec', '12\t34', 'Enter one number: a tab or line break separates two numbers here.');
  await refuses('dec', '12\n34', 'Enter one number: a tab or line break separates two numbers here.');
  await refuses('dec', '1e3', '“e” is not a decimal digit. Decimal uses 0 to 9.');
  await refuses('dec', '0x1F', '“x” is not a decimal digit. Decimal uses 0 to 9.');
  await refuses('dec', '12a', '“a” is not a decimal digit. Decimal uses 0 to 9.');
  await refuses('dec', '-', 'There are no digits to convert.');
  await refuses('dec', '1-2', '“-” is not a decimal digit. Decimal uses 0 to 9.');
  await refuses('bin', '102', '“2” is not a binary digit. Binary uses only 0 and 1.');
  await refuses('bin', '1.1', '“.” is not a binary digit. Binary uses only 0 and 1.');
  await refuses('bin', '10\t11', 'Enter one number: a tab or line break separates two numbers here.');
  await refuses('bin', '0b', 'There are no digits to convert.');
  await refuses('hex', 'xyz', '“x” is not a hex digit. Hex uses 0 to 9 and A to F.');
  await refuses('hex', '0xFG', '“G” is not a hex digit. Hex uses 0 to 9 and A to F.');
  await refuses('hex', 'FF,FF', '“,” is not a hex digit. Hex uses 0 to 9 and A to F.');
  await refuses('oct', '18', '“8” is not an octal digit. Octal uses 0 to 7.');
  await refuses('oct', '0x7', '“x” is not an octal digit. Octal uses 0 to 7.');
  // Mending it brings the other three back; an empty box empties them without a message.
  assert.deepEqual(await num('oct', '17'), { dec: '15', bin: '1111', hex: 'F', oct: '17' });
  assert.deepEqual(await numErr('oct'), { msg: '', invalid: null });
  assert.deepEqual(await num('hex', ''), { dec: '', bin: '', hex: '', oct: '' });
  assert.deepEqual(await numErr('hex'), { msg: '', invalid: null });
  assert.equal(await page.isDisabled('[data-copy-target="#bn-dec"]'), true);
  await num('dec', '255');
  await status('Decimal 255, binary 11111111, hex FF, octal 377.');
  assert.equal(await copied('[data-copy-target="#bn-bin"]'), '11111111');
  assert.equal(await copied('[data-copy-target="#bn-hex"]'), 'FF');
  assert.deepEqual(await page.$$eval('.bn-num button', bs => bs.map(b => b.getAttribute('aria-label'))), ['Copy decimal', 'Copy binary', 'Copy hexadecimal', 'Copy octal']);
  await num('bin', '102');
  await status('“2” is not a binary digit. Binary uses only 0 and 1.');
  await num('dec', '1' + '0'.repeat(30));
  await status('Converted a number of 31 decimal digits.');
  assert.equal(await text('#bn-ex-group'), '1,234,567');
  assert.equal(await text('#bn-ex-point'), 'decimal point');

  // ---- ASCII table: opened from the keyboard, 128 rows that agree with Python ----
  assert.equal(await page.locator('#bn-ascii').evaluate(el => el.open), false);
  await page.focus('#bn-ascii summary');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#bn-ascii').evaluate(el => el.open), true);
  const ascii = await page.$$eval('#bn-ascii tbody tr', trs => trs.map(tr => [...tr.cells].map(c => c.firstChild.textContent)));
  assert.deepEqual(ascii, data.ascii);
  // Names of the control codes as RFC 20 lists them (tabulation shortened to tab).
  const names = await page.$$eval('#bn-ascii .bn-name', els => els.map(e => e.textContent));
  assert.deepEqual(names, ['null', 'start of heading', 'start of text', 'end of text', 'end of transmission', 'enquiry', 'acknowledge', 'bell', 'backspace',
    'horizontal tab', 'line feed', 'vertical tab', 'form feed', 'carriage return', 'shift out', 'shift in', 'data link escape', 'device control 1',
    'device control 2', 'device control 3', 'device control 4', 'negative acknowledge', 'synchronous idle', 'end of transmission block', 'cancel',
    'end of medium', 'substitute', 'escape', 'file separator', 'group separator', 'record separator', 'unit separator', 'delete']);
  assert.deepEqual(await page.$$eval('#bn-ascii caption', els => els.map(e => e.textContent)),
    ['0 to 31: control codes', '32 to 63: punctuation and digits', '64 to 95: capital letters', '96 to 127: lower-case letters']);
  assert.equal(await page.locator('#bn-ascii th[scope="col"]').count(), 16);

  // ---- The whole flow from the keyboard ----
  await open();
  await page.focus('input[name="bn-dir"][value="t2b"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await dirIs('b2t'), true);
  assert.notEqual(await page.$eval('input[name="bn-dir"]:checked + span', el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-swap');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-input');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('01101000 01101001');
  assert.equal(await out(), 'hi');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-output');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-copy');
  assert.notEqual(await page.$eval('#bn-copy', el => getComputedStyle(el).outlineStyle), 'none');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#bn-copy').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'hi');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  assert.equal(await dirIs('t2b'), true);
  assert.equal(await page.inputValue('#bn-input'), 'hi');
  assert.equal(await out(), '01101000 01101001');
  // Labels: every field and button has a name, and a button's name starts with what it shows.
  const unnamed = await page.$$eval('.bn textarea, .bn input, .bn button, .bn summary', els => els.filter(el => {
    const label = el.labels && el.labels.length ? el.labels[0].textContent.trim() : '';
    const name = el.getAttribute('aria-label') || label || el.textContent.trim();
    return !name || (el.tagName === 'BUTTON' && !el.hidden && el.textContent.trim() && !name.startsWith(el.textContent.trim()));
  }).map(el => el.id || el.outerHTML.slice(0, 60)));
  assert.deepEqual(unnamed, []);

  // ---- Back from another page: the browser may put typed values back after the script ran ----
  await setDir('b2t');
  await type('01001111 01001011');
  await page.fill('#bn-hex', 'ff');
  await page.goto(`${base}/about/`, { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'load' });
  const restored = { input: await page.inputValue('#bn-input'), b2t: await dirIs('b2t'), hex: await page.inputValue('#bn-hex') };
  assert.ok(['01001111 01001011', 'Hi 👋'].includes(restored.input), restored.input);
  if (restored.input === '01001111 01001011' && restored.b2t) assert.equal(await out(), 'OK');
  else if (restored.input === 'Hi 👋' && !restored.b2t) assert.equal(await out(), data.encode[0].spaced);
  else assert.equal(await out(), restored.b2t ? '' : bits(restored.input));
  assert.equal(await text('#bn-output-label'), restored.b2t ? 'Text' : 'Binary code');
  assert.equal(await page.inputValue('#bn-dec'), restored.hex === 'ff' ? '255' : '104');
  assert.equal(await page.inputValue('#bn-bin'), restored.hex === 'ff' ? '11111111' : '1101000');
  assert.match(await text('#bn-num-info'), restored.hex === 'ff' ? /^This number takes 8 bits/ : /^This number takes 7 bits/);

  // ---- The FAQ covers privacy ----
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.match(faqs[faqs.length - 1], /sent to a server/);
  // The examples of the FAQ agree with Node's own UTF-8: Sam, and the ë of Zoë in two bytes.
  const faqText = await page.locator('.faq').first().textContent();
  assert.ok(faqText.includes(bits('Sam')) && faqText.includes(`the ë of Zoë is ${bits('ë')}`) && faqText.includes('01101000 01101001 mean'), 'FAQ examples');

  // ---- A browser set to German: the comma is the decimal mark, the dot groups thousands ----
  const browser = page.context().browser();
  const de = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const dePage = await de.newPage();
  await dePage.goto(url, { waitUntil: 'load' });
  const deNum = async v => {
    await dePage.fill('#bn-dec', v);
    return [await dePage.inputValue('#bn-bin'), await dePage.locator('#bn-dec-err').textContent()];
  };
  const deComma = 'Whole numbers only: “,” is read as the decimal comma, and fractions cannot be converted here.';
  assert.deepEqual(await deNum('1.000'), ['1111101000', '']);
  assert.deepEqual(await deNum('1.234.567'), [(1234567).toString(2), '']);
  assert.deepEqual(await deNum('1,000,000'), [(1000000).toString(2), '']);
  assert.deepEqual(await deNum('1,5'), ['', deComma]);
  assert.deepEqual(await deNum('1,000'), ['', deComma]);
  assert.deepEqual(await deNum('0,500'), ['', deComma]);
  assert.deepEqual(await deNum('1.5'), ['', 'A dot can only stand between groups of three digits, as in 1.234.567. Enter one whole number.']);
  assert.deepEqual(await deNum('0.500'), ['', 'Whole numbers only: a grouped number cannot start with 0, so this looks like a fraction.']);
  assert.deepEqual(await deNum('1.234,5'), ['', 'Whole numbers only: this has two kinds of separator, like a number with a fraction.']);
  assert.deepEqual(await deNum('1 000'), ['1111101000', '']);
  assert.equal(await dePage.locator('#bn-ex-group').textContent(), '1.234.567');
  assert.equal(await dePage.locator('#bn-ex-point').textContent(), 'decimal comma');
  // The messages of the page stay in English, with English number formatting.
  await dePage.check('input[name="bn-dir"][value="b2t"]');
  await dePage.$eval('#bn-input', el => { el.value = '0'.repeat(1000001); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await settles('#bn-error', 'This is 1,000,001 characters long. The most this page translates at once is 1,000,000.', dePage);
  await de.close();
  // Arabic (Egypt): Arabic-Indic digits and separators by default, and they are read as such.
  const ar = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1280, height: 900 } });
  const arPage = await ar.newPage();
  await arPage.goto(url, { waitUntil: 'load' });
  await arPage.fill('#bn-dec', '\u0661\u066C\u0660\u0660\u0660');
  assert.equal(await arPage.inputValue('#bn-bin'), '1111101000');
  await arPage.fill('#bn-dec', '\u0661\u066B\u0665');
  assert.equal(await arPage.inputValue('#bn-bin'), '');
  assert.equal(await arPage.locator('#bn-dec-err').textContent(), 'Whole numbers only: “\u066B” is read as the decimal separator, and fractions cannot be converted here.');
  await arPage.fill('#bn-dec', '1,000');
  assert.equal(await arPage.inputValue('#bn-bin'), '1111101000');
  await arPage.fill('#bn-dec', '1.5');
  assert.equal(await arPage.locator('#bn-dec-err').textContent(), point);
  await ar.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('.bn-seg label:nth-child(2)');
  assert.equal(await p.isChecked('input[name="bn-dir"][value="b2t"]'), true);
  await p.tap('#bn-input');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('01001111 01001011');
  assert.equal(await p.inputValue('#bn-output'), 'OK');
  await p.tap('#bn-swap');
  assert.equal(await p.inputValue('#bn-input'), 'OK');
  assert.equal(await p.inputValue('#bn-output'), '01001111 01001011');
  await p.tap('#bn-bin');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('11111111');
  assert.equal(await p.inputValue('#bn-dec'), '255');
  await p.tap('#bn-ascii summary');
  assert.equal(await p.locator('#bn-ascii tbody tr').count(), 128);
  // Controls are at least 44 px tall and text boxes use 16 px type (no zoom on iOS).
  const sizes = await p.$$eval('.bn button, .bn textarea, .bn-seg span, .bn .check, .bn summary', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id || e.textContent.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), field: e.tagName === 'TEXTAREA',
  })));
  assert.ok(sizes.length >= 14, `found ${sizes.length} controls`);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px text`);
  }
  // Nothing is cut off or pushed off the card at any phone width, with long results on screen.
  await p.fill('#bn-dec', '9'.repeat(60));
  await p.check('input[name="bn-dir"][value="b2t"]');
  await p.fill('#bn-input', '01101000 hello');
  assert.equal(await p.isVisible('#bn-suggest-btn'), true);
  for (const width of [320, 340, 360, 390, 412, 480, 540]) {
    await p.setViewportSize({ width, height: 800 });
    const cut = await p.$$eval('.bn button, .bn-seg span, .bn label, .bn summary, .bn th, .bn caption', (els, w) => els.filter(e => e.offsetParent).filter(e => {
      const r = e.getBoundingClientRect(), card = e.closest('.tool-card').getBoundingClientRect();
      const scroller = e.closest('.table-wrap');
      return e.scrollWidth > e.clientWidth + 1 || (!scroller && (r.right > card.right + 0.5 || r.left < card.left - 0.5));
    }).map(e => e.id || e.textContent.trim().slice(0, 30)), width);
    assert.deepEqual(cut, [], `cut off at ${width}px`);
    assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `sideways scroll at ${width}px`);
  }
  await phone.close();
};
