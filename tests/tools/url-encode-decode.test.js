// Expected results come from tests/fixtures/url-encode-decode/make_expected.py (Python's
// urllib.parse and codecs) and from Node's own encodeURIComponent, encodeURI, URLSearchParams,
// decodeURIComponent and TextDecoder. The page uses none of these: it has its own encoder and
// decoder, so each of them is an independent check.
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const REPLACEMENT = String.fromCharCode(0xFFFD), POUND = String.fromCharCode(0xA3), EURO = String.fromCharCode(0x20AC), E_ACUTE = String.fromCharCode(0xE9);
  const GRIN = String.fromCodePoint(0x1F600);
  await open();

  const text = sel => page.locator(sel).textContent();
  const settle = () => page.waitForFunction(() => document.querySelector('#ue-result').getAttribute('aria-busy') === 'false');
  const type = async t => { await page.fill('#ue-input', t); await settle(); };
  // Sets the box as a paste would, for texts with characters that cannot be typed.
  const put = async t => {
    await page.evaluate(v => { const el = document.querySelector('#ue-input'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, t);
    await settle();
  };
  const dir = d => page.check(`input[name="ue-dir"][value="${d}"]`);
  const mode = m => page.check(`input[name="ue-mode"][value="${m}"]`);
  const result = () => text('#ue-out');
  const marks = () => page.$$eval('#ue-out mark', ms => ms.map(m => m.textContent));
  const rows = () => page.$$eval('#ue-changes tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const invalid = () => page.getAttribute('#ue-input', 'aria-invalid');
  const kept = /[A-Za-z0-9\-_.!~*'()]/;

  // ---- The page starts with an example, encoded as one value. ----
  const example = await page.inputValue('#ue-input');
  assert.equal(example, `Fish & chips: ${POUND}5.50 (2 for ${POUND}10?)`);
  assert.equal(await result(), encodeURIComponent(example));
  assert.equal(await result(), 'Fish%20%26%20chips%3A%20%C2%A35.50%20(2%20for%20%C2%A310%3F)');
  // Marked: exactly the runs of characters that encodeURIComponent changes.
  assert.deepEqual(await marks(), example.match(/[^A-Za-z0-9\-_.!~*'()]+/g).map(encodeURIComponent));
  const changedCount = [...example].filter(c => !kept.test(c)).length;
  assert.equal(await text('#ue-out-info'), `${changedCount} characters of ${[...example].length} encoded`);
  assert.deepEqual(await rows(), [['space', 'U+0020', '%20', '6'], ['&', 'U+0026', '%26', '1'], [':', 'U+003A', '%3A', '1'], [POUND, 'U+00A3', '%C2%A3', '2'], ['?', 'U+003F', '%3F', '1']]);
  assert.equal(await invalid(), 'false');
  assert.equal(await text('#ue-error') + await text('#ue-note') + await text('#ue-status'), '');
  assert.equal(await page.isVisible('#ue-tip'), false);
  assert.equal(await page.isVisible('#ue-plus') || await page.isVisible('#ue-charset') || await page.isVisible('#ue-eol'), false);
  // Still nothing a second later: a page that only loaded has nothing to announce.
  await page.waitForTimeout(1000);
  assert.equal(await text('#ue-status'), '');

  // ---- Encoding: Python, Node and the page agree in all four modes. ----
  for (const c of expected.encode) {
    await put(c.input);
    assert.equal(await page.inputValue('#ue-input'), c.input, 'the box holds the text unchanged');
    for (const m of ['component', 'url', 'form', 'rfc3986']) {
      await mode(m);
      assert.equal(await result(), c[m], `${m}: ${JSON.stringify(c.input)}`);
    }
    assert.equal(c.component, encodeURIComponent(c.input));
    assert.equal(c.url, encodeURI(c.input));
    assert.equal(c.form, new URLSearchParams({ a: c.input }).toString().slice(2));
    assert.equal(decodeURIComponent(c.rfc3986), c.input);
    await mode('component');
  }
  // One row per different character, in order of appearance, with its code point and bytes.
  await put(`${E_ACUTE} ${EURO}${GRIN} ${E_ACUTE}\t`);
  assert.deepEqual(await rows(), [[E_ACUTE, 'U+00E9', '%C3%A9', '2'], ['space', 'U+0020', '%20', '2'], [EURO, 'U+20AC', '%E2%82%AC', '1'], [GRIN, 'U+1F600', '%F0%9F%98%80', '1'], ['tab', 'U+0009', '%09', '1']]);
  assert.equal(await text('#ue-out-info'), '7 characters of 7 encoded');
  await put('abc-123');
  assert.deepEqual(await rows(), []);
  assert.equal(await text('#ue-changes-note'), 'Nothing needed encoding.');
  assert.equal(await text('#ue-out-info'), '0 characters of 7 encoded');
  assert.deepEqual(await marks(), []);

  // ---- Line breaks: as typed, as CR LF, or each line on its own. ----
  const names = { component: 'component', whole: 'url', form: 'form', strict: 'rfc3986' };
  for (const c of expected.lines) {
    await put(c.input);
    assert.equal(await page.isVisible('#ue-eol'), true);
    for (const [fn, m] of Object.entries(names)) {
      await mode(m);
      await page.selectOption('#ue-eol', 'crlf');
      assert.equal(await result(), c.crlf[fn], `${m}, CR LF: ${JSON.stringify(c.input)}`);
      await page.selectOption('#ue-eol', 'lf');
      await page.check('#ue-lines');
      assert.equal(await result(), c.each[fn], `${m}, line by line: ${JSON.stringify(c.input)}`);
      assert.equal(await page.isVisible('#ue-eol'), false, 'no line break to encode when each line stands alone');
      await page.uncheck('#ue-lines');
    }
    await mode('component');
  }
  await put('one line');
  assert.equal(await page.isVisible('#ue-eol'), false);

  // ---- Text that is encoded already: a tip, and one press to decode it instead. ----
  await type('a%20b');
  assert.equal(await result(), 'a%2520b');
  assert.equal(await text('#ue-tip-text'), 'This text already has percent-encoded sequences, such as %20. Encoding it again turns every % into %25.');
  assert.equal(await text('#ue-tip-btn'), 'Switch to Decode');
  await page.click('#ue-tip-btn');
  assert.equal(await page.isChecked('input[name="ue-dir"][value="decode"]'), true);
  assert.equal(await result(), 'a b');
  assert.equal(await text('#ue-done'), 'Switched to Decode.');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'decode', 'focus goes to the direction that is now chosen');
  assert.equal(await text('#ue-input-label'), 'Text or URL to decode');
  assert.equal(await page.isVisible('#ue-mode-set') || await page.isVisible('#ue-lines'), false);
  assert.equal(await page.isVisible('#ue-plus') && await page.isVisible('#ue-charset'), true);

  // ---- Decoding against Python: + kept, + as a space. ----
  for (const c of expected.decode) {
    await put(c.input);
    await page.selectOption('#ue-plus', 'keep');
    assert.equal(await result(), c.keep, `+ kept: ${JSON.stringify(c.input)}`);
    await page.selectOption('#ue-plus', 'space');
    assert.equal(await result(), c.space, `+ as space: ${JSON.stringify(c.input)}`);
  }
  // Whole URLs, decoded part by part by Python's urlsplit: + is a space in the query string only.
  await page.selectOption('#ue-plus', 'auto');
  for (const c of expected.urls) {
    await put(c.input);
    assert.equal(await result(), c.auto, c.input);
    await page.selectOption('#ue-plus', 'space');
    assert.equal(await result(), c.space, `always spaces: ${c.input}`);
    await page.selectOption('#ue-plus', 'keep');
    assert.equal(await result(), c.keep, `always plus signs: ${c.input}`);
    await page.selectOption('#ue-plus', 'auto');
  }
  // Text that is not a URL is form data; a URL without a query has no form data; each line is judged alone.
  for (const [input, want] of [
    ['hello+world%21', 'hello world!'], ['q=a+b&c=d%2Be', 'q=a b&c=d+e'], ['mailto:a+b@example.com', 'mailto:a+b@example.com'], ['tel:+44%20161', 'tel:+44 161'],
    ['page#frag?x=a+b', 'page#frag?x=a+b'], ['q=a+b\nhttps://e.com/a+b\nx+y?z+w#v+u', 'q=a b\nhttps://e.com/a+b\nx+y?z w#v+u'],
  ]) {
    await put(input);
    assert.equal(await result(), want, input);
  }
  await put('https://e.com/a+b?q=c+d+e');
  assert.equal(await text('#ue-note'), '2 plus signs were read as spaces, which is what + means in form data and query strings. 1 plus sign outside a query string was kept.');
  await put('a%2Bb');
  assert.equal(await text('#ue-note'), '');
  // A space written in two ways is listed as two rows.
  await put('x=a+b%20c+d%20');
  assert.deepEqual(await rows(), [['space', 'U+0020', '+', '2'], ['space', 'U+0020', '%20', '2']]);

  // The example for this direction, what is marked and what the table lists.
  await page.click('#ue-example');
  assert.equal(await page.inputValue('#ue-input'), 'https://example.com/search?q=fish+%26+chips&price=%C2%A35.50#top');
  assert.equal(await result(), `https://example.com/search?q=fish & chips&price=${POUND}5.50#top`);
  assert.deepEqual(await marks(), [' ', '&', ' ', POUND]);
  assert.deepEqual(await rows(), [['space', 'U+0020', '+', '2'], ['&', 'U+0026', '%26', '1'], [POUND, 'U+00A3', '%C2%A3', '1']]);
  assert.equal(await text('#ue-out-info'), '4 characters decoded');
  assert.equal(await text('#ue-note'), '2 plus signs were read as spaces, which is what + means in form data and query strings.');

  // ---- Older character sets, against Python's codecs. ----
  for (const c of expected.legacy) {
    await page.selectOption('#ue-charset', c.charset);
    await page.selectOption('#ue-plus', 'keep');
    await put(c.encoded);
    assert.equal(await result(), c.text, `${c.charset}: ${c.encoded}`);
    await page.selectOption('#ue-plus', 'space');
    await put(c.plus);
    assert.equal(await result(), c.text, `${c.charset} with +: ${c.plus}`);
    assert.equal(await invalid(), 'false', c.charset);
  }
  // The same bytes read with the wrong character set: an error on the field, and the hint to change it.
  await page.selectOption('#ue-plus', 'auto');
  await page.selectOption('#ue-charset', 'utf-8');
  await put('caf%E9');
  assert.equal(await result(), 'caf' + REPLACEMENT);
  assert.equal(await text('#ue-error'), `1 byte sequence (line 1, column 4) is not valid UTF-8 and is shown as ${REPLACEMENT}. If the text comes from an older site, try another character set.`);
  assert.equal(await invalid(), 'true');
  assert.ok((await page.getAttribute('#ue-input', 'aria-describedby')).split(' ').includes('ue-error'));
  assert.equal(await page.locator('#ue-error').evaluate(e => e.classList.contains('msg') && e.classList.contains('error')), true);
  assert.deepEqual(await rows(), [[`${REPLACEMENT} (not valid UTF-8)`, '', '%E9', '1']]);
  await page.selectOption('#ue-charset', 'windows-1252');
  assert.equal(await result(), 'caf' + E_ACUTE);
  assert.equal(await text('#ue-error'), '');
  assert.equal(await invalid(), 'false');
  // A letter typed as itself is read as a character of its own unless a lead byte is waiting for it.
  await page.selectOption('#ue-charset', 'shift_jis');
  await put('%93%FAA%96%7BBC %83e');
  const [NI, HON, TE] = [0x65E5, 0x672C, 0x30C6].map(c => String.fromCharCode(c));
  assert.equal(await result(), `${NI}A${HON}BC ${TE}`);
  assert.deepEqual(await marks(), [NI, HON, TE]);
  assert.deepEqual(await rows(), [[NI, 'U+65E5', '%93%FA', '1'], [HON, 'U+672C', '%96%7B', '1'], [TE, 'U+30C6', '%83e', '1']]);
  assert.equal(await text('#ue-out-info'), '3 characters decoded');
  await put('%93%FA%96%7B %FF');
  assert.equal(await text('#ue-error'), `1 byte sequence (line 1, column 14) is not valid Shift_JIS and is shown as ${REPLACEMENT}. If the text comes from an older site, try another character set.`);
  // In GBK a digit can be the second of four bytes. When the four do not follow, the decoder gives
  // the digit back, as it would mid-text: it is not lost at the end of a run of %XX.
  await page.selectOption('#ue-charset', 'gbk');
  await put('%8A9~ %DF0A %C4%E3 %8A9');
  assert.equal(await result(), `${REPLACEMENT}9~ ${REPLACEMENT}0A ${String.fromCharCode(0x4F60)} ${REPLACEMENT}9`);
  assert.equal(await text('#ue-error'), `3 byte sequences (the first on line 1, column 1) are not valid GBK and are shown as ${REPLACEMENT}. If the text comes from an older site, try another character set.`);
  await page.selectOption('#ue-charset', 'utf-8');

  // ---- Broken input is decoded as far as it goes, and said to be broken. ----
  await put('ok\n100% sure %4 %zz%41');
  assert.equal(await result(), 'ok\n100% sure %4 %zzA');
  assert.equal(await text('#ue-error'), '3 percent signs (the first on line 2, column 4) are not followed by two hexadecimal digits and were left as they are. A percent sign of its own is written %25.');
  assert.equal(await invalid(), 'true');
  await put('50%');
  assert.equal(await text('#ue-error'), '1 percent sign (line 1, column 3) is not followed by two hexadecimal digits and was left as it is. A percent sign of its own is written %25.');
  await put('caf%E9 %FF%FE ok%C3 %');
  assert.equal(await text('#ue-error'), `4 byte sequences (the first on line 1, column 4) are not valid UTF-8 and are shown as ${REPLACEMENT}. If the text comes from an older site, try another character set. ` +
    '1 percent sign (line 1, column 21) is not followed by two hexadecimal digits and was left as it is. A percent sign of its own is written %25.');
  // The place is that of the broken bytes, not of the run of sequences they are in.
  await put('ok%C3%A9%FF%41\n%E2%82%AC%E2%82');
  assert.equal(await result(), 'ok' + E_ACUTE + REPLACEMENT + 'A\n' + EURO + REPLACEMENT);
  assert.equal(await text('#ue-error'), `2 byte sequences (the first on line 1, column 9) are not valid UTF-8 and are shown as ${REPLACEMENT}. If the text comes from an older site, try another character set.`);
  await put('50%25');
  assert.equal(await text('#ue-error'), '');
  assert.equal(await invalid(), 'false');
  assert.equal(await result(), '50%');
  // Malformed UTF-8 is replaced exactly as the Encoding Standard says: 400 random byte runs
  // against Node's TextDecoder.
  let seed = 20261115;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const lead = [0x41, 0x7F, 0x80, 0x9F, 0xA0, 0xBF, 0xC0, 0xC1, 0xC2, 0xDF, 0xE0, 0xE1, 0xEC, 0xED, 0xEE, 0xEF, 0xF0, 0xF1, 0xF3, 0xF4, 0xF5, 0xFF, 0x8F, 0x90, 0xBB];
  const runs = Array.from({ length: 400 }, () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pick(lead)));
  const strict = new TextDecoder('utf-8', { ignoreBOM: true });
  await put(runs.map(r => r.map(b => '%' + b.toString(16).padStart(2, '0')).join('')).join(' '));
  assert.equal(await result(), runs.map(r => strict.decode(Uint8Array.from(r))).join(' '));
  for (const [bytes, chars] of [[[0xE2, 0x82], 1], [[0xE0, 0x80, 0x80], 3], [[0xED, 0xA0, 0x80], 3], [[0xF4, 0x90, 0x80, 0x80], 4], [[0xF0, 0x9F, 0x98], 1], [[0xEF, 0xBB, 0xBF], 1], [[0xEF, 0xBF, 0xBD], 1], [[0xC3, 0xA9, 0xC3], 2]]) {
    await put(bytes.map(b => '%' + b.toString(16).toUpperCase()).join(''));
    const got = await result();
    assert.equal(got, strict.decode(Uint8Array.from(bytes)), bytes.join());
    assert.equal([...got].length, chars, bytes.join());
  }
  assert.equal(await text('#ue-error') !== '', true);
  // A valid U+FFFD (EF BF BD) and a byte order mark are characters, not errors.
  await put('%EF%BF%BD%EF%BB%BFx');
  assert.equal(await text('#ue-error'), '');
  assert.equal(await result(), REPLACEMENT + String.fromCharCode(0xFEFF) + 'x');

  // ---- The %uXXXX form of the old escape() function. ----
  await put('%u20AC%u00e9 %uD83D%uDE00 %u12');
  assert.equal(await result(), `${EURO}${E_ACUTE} ${GRIN} %u12`);
  assert.match(await text('#ue-note'), /^3 characters in the %uXXXX form of JavaScript.s old escape function, which is not standard, were decoded as well\.$/);
  assert.deepEqual((await rows()).map(r => r[2]), ['%u20AC', '%u00e9', '%uD83D%uDE00']);
  assert.match(await text('#ue-error'), /^1 percent sign \(line 1, column 27\) is not followed by two hexadecimal digits/);

  // ---- Encoded twice: the page says so and decodes again on request. ----
  await put('a%2520b%253F');
  assert.equal(await result(), 'a%20b%3F');
  assert.equal(await text('#ue-tip-text'), 'The result still has percent-encoded sequences, such as %20: the text was encoded more than once.');
  assert.equal(await text('#ue-tip-btn'), 'Decode again');
  await page.click('#ue-tip-btn');
  assert.equal(await page.inputValue('#ue-input'), 'a%20b%3F');
  assert.equal(await result(), 'a b?');
  assert.equal(await page.isVisible('#ue-tip'), false);
  assert.equal(await text('#ue-done'), 'Decoded once more.');
  await page.click('#ue-undo');
  assert.equal(await page.inputValue('#ue-input'), 'a%2520b%253F');
  assert.equal(await page.isVisible('#ue-undo'), false);
  await put('plain text, nothing encoded');
  assert.equal(await text('#ue-note'), 'Nothing to decode: the text has no percent-encoded sequences.');
  assert.equal(await text('#ue-changes-note'), 'Nothing was decoded.');

  // ---- Copy, download, swap and undo. ----
  await put('caf%C3%A9%20%26%20cr%C3%A8me');
  const decoded = decodeURIComponent('caf%C3%A9%20%26%20cr%C3%A8me');
  await page.click('#ue-copy');
  assert.equal(await clipboard(), decoded);
  assert.equal(await text('#ue-copy'), 'Copied!');
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ue-download')]);
  assert.equal(dl.suggestedFilename(), 'decoded.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), decoded);
  await page.click('#ue-swap');
  assert.equal(await page.isChecked('input[name="ue-dir"][value="encode"]'), true);
  assert.equal(await page.inputValue('#ue-input'), decoded);
  assert.equal(await result(), 'caf%C3%A9%20%26%20cr%C3%A8me');
  assert.equal(await text('#ue-done'), 'The result is now the text to encode.');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ue-download')]);
  assert.equal(dl.suggestedFilename(), 'encoded.txt');
  assert.deepEqual([...fs.readFileSync(await dl.path())], [...Buffer.from('caf%C3%A9%20%26%20cr%C3%A8me')]);
  await page.click('#ue-undo');
  assert.equal(await page.isChecked('input[name="ue-dir"][value="decode"]'), true, 'Undo also turns the direction back');
  assert.equal(await page.inputValue('#ue-input'), 'caf%C3%A9%20%26%20cr%C3%A8me');
  assert.equal(await result(), decoded);
  // An example nobody changed follows the direction; a text of one's own stays.
  await page.click('#ue-example');
  await dir('encode');
  assert.equal(await page.inputValue('#ue-input'), example);
  await dir('decode');
  assert.equal(await page.inputValue('#ue-input'), 'https://example.com/search?q=fish+%26+chips&price=%C2%A35.50#top');
  await type('my%20own');
  await dir('encode');
  assert.equal(await page.inputValue('#ue-input'), 'my%20own');
  assert.equal(await result(), 'my%2520own');
  await page.click('#ue-clear');
  assert.equal(await page.inputValue('#ue-input'), '');
  assert.equal(await result() + await text('#ue-out-info') + await text('#ue-error') + await text('#ue-changes-note'), '');
  assert.equal(await text('#ue-done'), 'The box is empty. Undo brings your text back.');
  assert.equal(await page.isDisabled('#ue-copy') && await page.isDisabled('#ue-download') && await page.isDisabled('#ue-swap'), true);
  assert.equal(await page.isVisible('#ue-tip'), false);
  await page.click('#ue-undo');
  assert.equal(await page.inputValue('#ue-input'), 'my%20own');

  // ---- Half a surrogate pair cannot be encoded: JavaScript throws, the page says what it did. ----
  const half = 'a' + String.fromCharCode(0xD83D) + 'b\n' + String.fromCharCode(0xDE00);
  assert.throws(() => encodeURIComponent(half), URIError);
  await put(half);
  assert.equal(await result(), 'a%EF%BF%BDb%0A%EF%BF%BD');
  assert.equal(await text('#ue-error'), '2 unpaired surrogates (the first on line 1, column 2), half of a character that takes two code units, cannot be encoded and were written as %EF%BF%BD, the replacement character.');
  assert.equal(await invalid(), 'true');
  assert.deepEqual(await rows(), [['unpaired surrogate', '', '%EF%BF%BD', '1'], ['line break', 'U+000A', '%0A', '1'], ['unpaired surrogate', '', '%EF%BF%BD', '1']]);
  await put('a' + GRIN + 'b');
  assert.equal(await text('#ue-error'), '');
  assert.equal(await invalid(), 'false');

  // ---- Long texts. Up to two million characters are worked on; the page stays quick. ----
  const chunk = `Fish & chips: ${POUND}5.50 ${GRIN} caf${E_ACUTE}/path?x=1&y=2#z\n`;
  const long = chunk.repeat(Math.ceil(1500000 / chunk.length));
  const timed = async v => page.evaluate(t => {
    const el = document.querySelector('#ue-input');
    el.value = t;
    const t0 = performance.now();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return performance.now() - t0;
  }, v);
  let ms = await timed(long);
  assert.ok(ms < 200, `input handler took ${Math.round(ms)} ms for 1.5 million characters`);
  let t0 = Date.now();
  await settle();
  assert.ok(Date.now() - t0 < 5000, `encoding took ${Date.now() - t0} ms`);
  const longEncoded = encodeURIComponent(long);
  const shown = await result();
  // One line of that length is slow to lay out, so the first 100,000 characters are shown; of a text in lines, 400,000.
  assert.equal(shown, longEncoded.slice(0, 100000));
  assert.equal(await text('#ue-out-note'), `Showing the first 100,000 of ${longEncoded.length.toLocaleString('en-GB')} characters. Copy and Download give all of it.`);
  await page.check('#ue-lines');
  await settle();
  assert.equal(await result(), long.split('\n').map(encodeURIComponent).join('\n').slice(0, 400000));
  await page.uncheck('#ue-lines');
  await settle();
  assert.equal(await page.locator('#ue-out mark').count(), 0);
  await page.click('#ue-copy');
  assert.equal(await clipboard() === longEncoded, true, 'Copy gives the whole result');
  await dir('decode');
  const unit = encodeURIComponent(chunk), part = unit.repeat(Math.floor(1800000 / unit.length));
  ms = await timed(part);
  assert.ok(ms < 200, `input handler took ${Math.round(ms)} ms for 1.8 million characters to decode`);
  await settle();
  await page.click('#ue-copy');
  assert.equal(await clipboard() === decodeURIComponent(part), true, 'a long text decodes exactly');
  // Junk by the megabyte: percent signs, plus signs, broken sequences.
  for (const [junk, want] of [['%'.repeat(1200000), '%'.repeat(1200000)], ['+'.repeat(1200000), ' '.repeat(1200000)], ['%E9%'.repeat(400000), (REPLACEMENT + '%').repeat(400000)], ['%u00'.repeat(400000), '%u00'.repeat(400000)]]) {
    ms = await timed(junk);
    assert.ok(ms < 200, `input handler took ${Math.round(ms)} ms for ${junk.slice(0, 8)}`);
    t0 = Date.now();
    await settle();
    assert.ok(Date.now() - t0 < 5000, `decoding ${junk.slice(0, 8)} took ${Date.now() - t0} ms`);
    await page.click('#ue-copy');
    assert.equal(await clipboard() === want, true, junk.slice(0, 8));
  }
  assert.equal(await text('#ue-error'), '400,000 percent signs (the first on line 1, column 1) are not followed by two hexadecimal digits and were left as they are. A percent sign of its own is written %25.');
  // One character too many is refused, and said so on the field.
  await timed('x'.repeat(2000000));
  await settle();
  assert.equal(await text('#ue-error'), '');
  assert.equal(await text('#ue-out-info'), '0 characters decoded');
  await timed('x'.repeat(2000001));
  await settle();
  assert.equal(await text('#ue-error'), 'This text has 2,000,001 characters. The page works on up to 2,000,000.');
  assert.equal(await invalid(), 'true');
  assert.equal(await result(), '');
  assert.equal(await page.isDisabled('#ue-copy'), true);
  // Up to 5,000 pieces are marked; beyond that the result is shown plain, with a note.
  await dir('encode');
  await put('a b '.repeat(1300));
  assert.equal(await page.locator('#ue-out mark').count(), 0);
  assert.equal(await text('#ue-out-note'), 'There are too many changes to mark each one in the result.');
  assert.equal(await result(), 'a%20b%20'.repeat(1300));
  await put('a b '.repeat(1250));
  assert.equal(await page.locator('#ue-out mark').count(), 2500);
  assert.equal(await text('#ue-out-note'), '');
  // The table stops at 100 different characters.
  await put(Array.from({ length: 150 }, (_, i) => String.fromCharCode(0x4E00 + i)).join(''));
  assert.equal((await rows()).length, 100);
  assert.equal(await text('#ue-changes-note'), 'The first 100 of 150 different characters are listed.');
  // A long text is worked on once typing pauses. A button pressed before then acts on the text as it is now.
  await put('a b '.repeat(6000));
  const editThenClick = (tail, sel) => page.evaluate(([tail, sel]) => {
    const el = document.querySelector('#ue-input');
    el.value += tail;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector(sel).click();
  }, [tail, sel]);
  await page.waitForFunction(() => document.querySelector('#ue-copy').textContent === 'Copy result');
  await editThenClick('tail!', '#ue-copy');
  await page.waitForFunction(() => document.querySelector('#ue-copy').textContent === 'Copied!');
  assert.ok((await clipboard()).endsWith('a%20b%20tail!'), 'Copy gives the result of the text with the last edit');
  [dl] = await Promise.all([page.waitForEvent('download'), editThenClick('?', '#ue-download')]);
  assert.ok(fs.readFileSync(await dl.path(), 'utf8').endsWith('tail!%3F'), 'Download too');
  await editThenClick('&', '#ue-swap');
  assert.ok((await page.inputValue('#ue-input')).endsWith('tail!%3F%26'), 'Swap too');
  await page.click('#ue-undo');
  await settle();
  assert.equal(await page.isChecked('input[name="ue-dir"][value="encode"]'), true);

  // ---- Announcements: one summary after typing pauses, written once. ----
  await type('');
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__ueSaid = [];
    new MutationObserver(() => window.__ueSaid.push(document.querySelector('#ue-status').textContent)).observe(document.querySelector('#ue-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#ue-input').pressSequentially('a b c', { delay: 20 });
  await page.waitForFunction(() => window.__ueSaid.length > 0, null, { timeout: 4000 });
  await page.waitForTimeout(900);
  assert.deepEqual(await page.evaluate(() => window.__ueSaid), ['Encoded: 2 characters of 5 encoded.']);
  await dir('decode');
  await page.locator('#ue-input').pressSequentially('%', { delay: 20 });
  await page.waitForFunction(() => window.__ueSaid.length === 2, null, { timeout: 4000 });
  assert.equal(await text('#ue-status'), '1 percent sign (line 1, column 6) is not followed by two hexadecimal digits and was left as it is. A percent sign of its own is written %25. Decoded: 0 characters decoded.');
  assert.equal(await page.getAttribute('#ue-status', 'role'), 'status');

  // ---- After Back or a reload the browser puts the fields back without telling the script. ----
  await page.evaluate(() => {
    document.querySelector('#ue-input').value = 'x%20y';
    document.querySelector('input[name="ue-dir"][value="decode"]').checked = true;
    document.querySelector('#ue-plus').value = 'keep';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await result(), 'x y');
  assert.equal(await page.isVisible('#ue-charset'), true);
  await page.selectOption('#ue-plus', 'auto');
  // The text box is not put back (autocomplete is off), so it holds the example for Encode: it
  // follows the direction that was put back.
  await page.evaluate(v => {
    document.querySelector('#ue-input').value = v;
    document.querySelector('input[name="ue-dir"][value="decode"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  }, example);
  assert.equal(await page.inputValue('#ue-input'), 'https://example.com/search?q=fish+%26+chips&price=%C2%A35.50#top');
  assert.equal(await result(), `https://example.com/search?q=fish & chips&price=${POUND}5.50#top`);

  // ---- The main flow from the keyboard alone. ----
  await page.click('#ue-clear');
  await page.evaluate(() => document.activeElement.blur());
  const tabTo = async sel => {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(s => document.activeElement.matches(s), sel)) return;
    }
    assert.fail(`Tab never reached ${sel}`);
  };
  await tabTo('input[name="ue-dir"]');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.isChecked('input[name="ue-dir"][value="encode"]'), true);
  await tabTo('#ue-input');
  await page.keyboard.type('a/b c');
  await tabTo('input[name="ue-mode"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.isChecked('input[name="ue-mode"][value="url"]'), true);
  assert.equal(await result(), 'a/b%20c');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await result(), 'a%2Fb%20c');
  await tabTo('#ue-out');
  assert.equal(await page.locator('#ue-out').evaluate(e => getComputedStyle(e).outlineStyle), 'solid', 'the result shows a focus ring');
  await tabTo('#ue-copy');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#ue-copy').textContent === 'Copied!');
  assert.equal(await clipboard(), 'a%2Fb%20c');

  // ---- The reference table in the page: every cell against Python, and the page's own encoder against it too. ----
  const table = await page.$$eval('#ue-ref tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
  assert.equal(table.length, expected.table.length + 2);
  for (const c of expected.table) {
    const row = table.find(r => r[0] === (c.char === ' ' ? 'space' : c.char));
    assert.ok(row, `row for ${c.char}`);
    assert.deepEqual(row.slice(1, 5), [c.component, c.url, c.form, c.rfc3986], `table row for ${JSON.stringify(c.char)}`);
    const kind = '-._~'.includes(c.char) ? 'unreserved' : ':/?#[]@'.includes(c.char) ? 'reserved (gen-delim)' : "!$&'()*+,;=".includes(c.char) ? 'reserved (sub-delim)' : c.char === '%' ? 'the escape character' : 'must be encoded';
    assert.equal(row[5], kind, `class of ${c.char}`);
  }
  for (const m of ['component', 'url', 'form', 'rfc3986']) {
    await mode(m);
    for (const c of expected.table.filter(c => '%+~*! #/'.includes(c.char))) {
      await put(c.char);
      assert.equal(await result(), c[m], `${m}: ${JSON.stringify(c.char)}`);
    }
  }
  await mode('component');

  // ---- On a phone, by touch. ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  const phoneErrors = [];
  p.on('pageerror', e => phoneErrors.push(e.message));
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('.ue-chip:has(input[value="form"])');
  assert.equal(await p.locator('#ue-out').textContent(), 'Fish+%26+chips%3A+%C2%A35.50+%282+for+%C2%A310%3F%29');
  await p.tap('.ue-chip:has(input[value="decode"])');
  await p.tap('#ue-input');
  await p.fill('#ue-input', '%E6%97%A5%E6%9C%AC'.repeat(40) + '+%zz');
  assert.equal(await p.locator('#ue-out').textContent(), String.fromCharCode(0x65E5, 0x672C).repeat(40) + ' %zz');
  const sizes = await p.evaluate(() => {
    const h = sel => Math.min(...[...document.querySelectorAll(sel)].filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height));
    return { chips: h('.ue-chip span'), buttons: h('.ue button'), selects: h('.ue select'), font: Math.min(...[...document.querySelectorAll('.ue textarea, .ue select')].map(e => parseFloat(getComputedStyle(e).fontSize))) };
  });
  assert.ok(sizes.chips >= 44 && sizes.buttons >= 44 && sizes.selects >= 44, JSON.stringify(sizes));
  assert.ok(sizes.font >= 16, `fields have ${sizes.font}px text`);
  await p.tap('.ue-chip:has(input[value="encode"])');
  await p.fill('#ue-input', String.fromCharCode(0x65E5).repeat(300) + '\nsecond line');
  assert.equal(await p.locator('#ue-eol').isVisible(), true);
  assert.ok((await p.locator('.ue .check').boundingBox()).height >= 44);
  for (const width of [412, 320]) {
    await p.setViewportSize({ width, height: 800 });
    assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px with a long result`);
  }
  assert.deepEqual(phoneErrors, []);
  await phone.close();

  // Left for the runner's phone-width check: an error, a tip, a long unbroken result and the tables.
  await dir('decode');
  await put('%E6%97%A5%E6%9C%AC'.repeat(60) + '%2520+%zz%E9');
};
