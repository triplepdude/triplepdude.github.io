// Expected results are worked out without the page: by tests/fixtures/json-formatter/
// make_expected.py (Python's json module for layouts and sorted keys, a token-level reference
// for texts that must be copied as written, Python's parser for what is not JSON and where it
// stops, ast.literal_eval for Python literals), by Node's own JSON and vm (JavaScript literals,
// escaping), or by building the input so that the answer is known.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const bigText = fs.readFileSync(path.join(fixtures, 'big.json'), 'utf8');
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const NBSP = String.fromCharCode(0xA0), ZWSP = String.fromCharCode(0x200B), BOM = String.fromCharCode(0xFEFF), DASH = String.fromCharCode(0x2014), E_ACUTE = String.fromCharCode(0xE9);
  const requests = [];
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  // Counts the workers the page starts.
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.__workers = 0;
    window.Worker = function (src, options) { window.__workers++; return new Native(src, options); };
  });
  await open();

  const text = sel => page.locator(sel).textContent();
  const idle = () => page.waitForFunction(() => document.querySelector('#jf-result').getAttribute('aria-busy') === 'false');
  const type = async t => { await page.fill('#jf-input', t); await idle(); };
  // Sets the box as a paste would, for texts with characters that cannot be typed.
  const put = async t => {
    await page.evaluate(v => { const el = document.querySelector('#jf-input'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, t);
    await idle();
  };
  const mode = async m => { await page.check(`input[name="jf-mode"][value="${m}"]`); await idle(); };
  const indent = async v => { await page.selectOption('#jf-indent', v); await idle(); };
  const sort = async on => { await page.setChecked('#jf-sort', on); await idle(); };
  const result = () => text('#jf-out');
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#jf-download')]);
    return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
  };

  // ---- The page starts with an example, already formatted and coloured, and loads nothing for it. ----
  const example = await page.inputValue('#jf-input');
  assert.equal(await result(), JSON.stringify(JSON.parse(example), null, 2));
  assert.equal(await text('#jf-ok'), 'Valid JSON. 4 objects, 1 array, 13 keys, 11 values, 3 levels deep.');
  assert.equal(await text('#jf-out-info'), '288 bytes formatted, 181 bytes as entered');
  assert.equal(await page.getAttribute('#jf-input', 'aria-invalid'), 'false');
  assert.equal(await text('#jf-error'), '');
  assert.equal(await text('#jf-status'), '', 'nothing is announced before the visitor does something');
  assert.deepEqual(await page.$$eval('#jf-out span', s => ['hljs-attr', 'hljs-string', 'hljs-number', 'hljs-keyword'].map(c => s.filter(e => e.className === c).length)), [13, 4, 5, 2]);
  assert.ok(!requests.some(r => /highlight/.test(r)), 'highlight.js is not loaded for the example');
  assert.equal(await page.evaluate(() => typeof window.hljs), 'undefined');
  const staticHtml = await page.innerHTML('#jf-out');
  // Still nothing a second later: a page that only loaded has nothing to announce.
  await page.waitForTimeout(1000);
  assert.equal(await text('#jf-status'), '');
  assert.equal(await page.isVisible('#jf-undo'), false);
  assert.equal(await page.isVisible('#jf-fix'), false);

  // ---- Layouts and sorted keys against Python's json module. ----
  for (const c of expected.objects) {
    for (const [i, input] of c.inputs.entries()) {
      await type(input);
      assert.equal(await result(), c.indent2, `${c.name}, input ${i}, 2 spaces`);
    }
    await indent('4');
    assert.equal(await result(), c.indent4, `${c.name}, 4 spaces`);
    await indent('tab');
    assert.equal(await result(), c.tab, `${c.name}, tab`);
    await indent('2');
    await sort(true);
    assert.equal(await result(), c.sorted2, `${c.name}, sorted`);
    await mode('minify');
    assert.equal(await result(), c.sortedMin, `${c.name}, sorted and minified`);
    assert.equal(await page.isVisible('#jf-indent'), false, 'no indent to choose when minifying');
    await sort(false);
    assert.equal(await result(), c.min, `${c.name}, minified`);
    await mode('format');
  }
  // Colours came from highlight.js, fetched once from this site when the first other text needed them.
  await page.waitForFunction(() => document.querySelectorAll('#jf-out span').length > 0);
  assert.deepEqual(requests.filter(r => /highlight/.test(r)), ['/assets/vendor/highlight.js/highlight.min.js']);

  // ---- Numbers and strings are copied as written; a parser would rewrite every one of these. ----
  for (const c of expected.raw) {
    await type(c.input);
    assert.equal(await result(), c.indent2, c.input);
    await indent('tab');
    assert.equal(await result(), c.tab, c.input);
    await indent('2');
    await mode('minify');
    assert.equal(await result(), c.min, c.input);
    await mode('format');
  }
  // JSON.parse would have changed the first one in five places.
  const lossy = expected.raw[0].input;
  assert.notEqual(JSON.stringify(JSON.parse(lossy)), expected.raw[0].min);
  await type(lossy);
  assert.equal(await text('#jf-ok'), 'Valid JSON. 1 object, 1 array, 10 keys, 11 values, 2 levels deep.');
  const note = await text('#jf-note');
  assert.ok(note.startsWith(`Duplicate key: "dup" appears more than once in the same object (line 1, column ${lossy.lastIndexOf('"dup"') + 1}). That is still valid JSON`), note);
  assert.ok(note.includes(`Large number: 12345678901234567890 (line 1, column ${lossy.indexOf('1234567890123') + 1}) cannot be held exactly by a double-precision number`), note);
  await type('[9007199254740991, -9007199254740991, 9007199254740992, 1e308, 0.1, 3.14159265358979323846]');
  assert.equal(await text('#jf-note'), '', 'numbers a double holds, or only rounds in the last decimals, are not flagged');
  await type('[9007199254740993, 1e309,\n -1E400]');
  assert.match(await text('#jf-note'), /^Large number: 9007199254740993 \(line 1, column 2\) and 2 more numbers cannot be held exactly/);
  await type('{"a":1,"b":{"x":1,"\\u0078":2,"x":3},"a":2}');
  assert.match(await text('#jf-note'), /^Duplicate key: "x" appears more than once in the same object \(line 1, column 19\), and 2 more duplicates follow\./);
  // Whole numbers of more than 309 digits are beyond a double's range: still JSON, copied as written and noted.
  const huge = '9'.repeat(400), negHuge = '-1' + '0'.repeat(320);
  await type(`[${huge}, ${negHuge}]`);
  assert.equal(await text('#jf-ok'), 'Valid JSON. 1 array, 2 values, 1 level deep.');
  assert.equal(await result(), `[\n  ${huge},\n  ${negHuge}\n]`);
  assert.match(await text('#jf-note'), /^Large number: 9{24}\u2026 \(line 1, column 2\) and 1 more number cannot be held exactly/);

  // ---- What is not JSON, and where: Python's parser stops at the same line and column, except
  // where this page points at the cause instead (the comma to remove, the place for a missing
  // comma, the start of a number). ----
  const elsewhere = { '{"a": 1,}': [1, 8], '[1,]': [1, 3], '[01]': [1, 2], '[1 2]': [1, 3], '{"a":1 "b":2}': [1, 7], '["\\u12G4"]': [1, 3], '[0x10]': [1, 2], '{"a":"b"\n"c":"d"}': [1, 9] };
  for (const c of expected.invalid) {
    await put(c.input);
    const err = await text('#jf-error');
    const [line, col] = elsewhere[c.input] || [c.line, c.col];
    assert.ok(err.length > 20, `${JSON.stringify(c.input)} is not JSON (Python: ${c.why})`);
    if (line) assert.ok(err.startsWith(`Line ${line}, column ${col}. `), `${JSON.stringify(c.input)}: ${err} (Python stops at ${c.line}:${c.col}, ${c.why})`);
    assert.throws(() => JSON.parse(c.input), SyntaxError, c.input);
    assert.equal(await page.getAttribute('#jf-input', 'aria-invalid'), 'true', c.input);
    assert.equal(await text('#jf-ok'), '', c.input);
    assert.equal(await result(), '', c.input);
    assert.equal(await page.isDisabled('#jf-copy') && await page.isDisabled('#jf-download') && await page.isDisabled('#jf-use'), true, c.input);
  }
  assert.ok((await page.getAttribute('#jf-input', 'aria-describedby')).split(' ').includes('jf-error'));
  assert.equal(await page.locator('#jf-error').evaluate(e => e.classList.contains('msg') && e.classList.contains('error')), true);

  // ---- The reason, in words, and whether Fix is offered. ----
  const reasons = [
    ['{"a": 1,}', 'Line 1, column 8. Trailing comma: JSON does not allow a comma before a closing } or ]. Remove it.', 'Fix it', ','],
    ["{'a': 1}", 'Line 1, column 2. Single quotes: JSON strings and keys must be in double quotes (").', 'Fix it', "'a'"],
    ['{\n  a: 1\n}', 'Line 2, column 3. Unquoted key: an object key must be a string in double quotes, as in "name".', 'Fix it', 'a'],
    ['[1, 2] // done', 'Line 1, column 8. Comment: JSON has no comments. Remove it.', 'Fix it', '// done'],
    ['{"ok": True}', 'Line 1, column 8. True is not JSON: true, false and null are written in lower case.', 'Fix it', 'True'],
    ['[None]', 'Line 1, column 2. None is not JSON: true, false and null are written in lower case, and the empty value is null.', 'Fix it', 'None'],
    ['[NaN]', 'Line 1, column 2. NaN is not JSON: a number must be finite. null is the usual replacement.', 'Fix it', 'NaN'],
    ['["a"\n"b"]', 'Line 1, column 5. Missing comma: add a comma after this value.', 'Fix it', null],
    ['["one\ntwo"]', 'Line 1, column 6. Line break inside a string: either the closing quote is missing, or the line break must be written as \\n.', 'Fix it', null],
    ['["a\\qb"]', 'Line 1, column 4. \\q is not a JSON escape. The escapes are \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX; a backslash itself is written \\\\.', 'Fix it', '\\q'],
    ['[' + NBSP + '1]', 'Line 1, column 2. Unusual space (U+00A0, a no-break space): between values JSON allows only spaces, tabs and line breaks.', 'Fix it', 'U+00A0'],
    ['{"a":1}\n{"a":2}', 'Line 2, column 1. More than one JSON value: a JSON text holds exactly one value, and a second one starts here (as in JSON Lines, or a piece copied out of a list).', 'Fix it', '{'],
    ['{"a": [1, {"b": 2', 'Line 1, column 18. Unexpected end: 3 brackets are never closed. The { opened on line 1, column 11 still needs its }.', 'Fix it', 'end of text'],
    ['[01]', 'Line 1, column 2. Leading zero: a number cannot start with 0 and go on with more digits. Remove the zeros, or put the value in double quotes if they matter, as in a postcode.', null, '01'],
    ['{"msg": "say "hi" now"}', 'Line 1, column 15. Unexpected hi after a string. If the double quote before it belongs to the text, write it as \\" ' + DASH + ' otherwise a comma is missing.', null, 'hi'],
    ['[1, 2}', 'Line 1, column 6. } does not match: the [ opened on line 1, column 1 must be closed with ] first.', null, '}'],
    ['{"a": "b', 'Line 1, column 7. This string never ends: its closing double quote (") is missing.', null, '"'],
    ['{"when": 2024-01-15}', 'Line 1, column 14. Unexpected - right after 2024. If this is a date, a version or other text, put it in double quotes.', null, '-'],
    ['{"a": hello}', 'Line 1, column 7. Unexpected hello: text must be in double quotes. The only bare words in JSON are true, false and null.', null, 'hello'],
    ['{"a": 1}}', 'Line 1, column 9. Unexpected }: there is no open { for it to close.', null, '}'],
    ['{"items": [}', 'Line 1, column 12. } does not match: the [ opened on line 1, column 11 must be closed with ] first.', null, '}'],
    ['[1, 2, }', 'Line 1, column 8. } does not match: the [ opened on line 1, column 1 must be closed with ] first.', null, '}'],
    ['{"a": ]', 'Line 1, column 7. The key has no value: something must follow the colon.', null, ']'],
    ['{"a":', 'Line 1, column 6. Unexpected end: the text stops after a colon, where a value is expected. It looks cut off.', null, 'end of text'],
    ['[' + '['.repeat(1000) + ']'.repeat(1001), 'Line 1, column 1,001. Nested more than 1,000 levels deep. That is still JSON, but deeper than this page reads.', null, '['],
  ];
  for (const [input, message, fix, mark] of reasons) {
    await put(input);
    assert.equal(await text('#jf-error'), message, JSON.stringify(input).slice(0, 60));
    assert.equal(await page.isVisible('#jf-fix'), !!fix, `${input.slice(0, 40)}: Fix ${fix ? 'offered' : 'not offered'}`);
    if (fix) assert.equal(await text('#jf-fix'), fix);
    if (mark !== null) assert.equal(await text('#jf-snip mark'), mark, input.slice(0, 40));
    assert.equal(await page.isVisible('#jf-goto'), true);
  }
  // 1,000 levels are read; the message above starts at 1,001.
  await put('['.repeat(1000) + ']'.repeat(1000));
  assert.equal(await text('#jf-ok'), 'Valid JSON. 1,000 arrays, 0 values, 1,000 levels deep.');

  // ---- Fix. Several problems at once, the list of what was done, and Undo. ----
  const messy = '{a: 1, \'b\': \'c\', "d": [1, 2,], "e": True}';
  await type(messy);
  assert.equal(await text('#jf-error'), 'Line 1, column 2. Unquoted key: an object key must be a string in double quotes, as in "name". In all, 5 problems can be fixed for you.');
  assert.equal(await text('#jf-fix'), 'Fix 5 problems');
  await page.click('#jf-fix');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), '{"a": 1, "b": "c", "d": [1, 2], "e": true}');
  assert.equal(await text('#jf-done'), 'Fixed 5 problems: removed 1 trailing comma, changed 2 single-quoted strings to double quotes, put 1 key in double quotes, rewrote 1 word as true, false or null.');
  assert.equal(await text('#jf-ok'), 'Valid JSON. 1 object, 1 array, 4 keys, 5 values, 2 levels deep.');
  assert.equal(await result(), '{\n  "a": 1,\n  "b": "c",\n  "d": [\n    1,\n    2\n  ],\n  "e": true\n}');
  assert.equal(await page.getAttribute('#jf-input', 'aria-invalid'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'jf-input', 'focus is not lost when the Fix button goes away');
  assert.equal(await page.isVisible('#jf-undo'), true);
  await page.click('#jf-undo');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), messy, 'Undo brings the text back as it was');
  assert.equal(await page.isVisible('#jf-undo'), false);
  assert.equal(await text('#jf-fix'), 'Fix 5 problems');
  // Typing after a fix ends the offer to undo it.
  await page.click('#jf-fix');
  await idle();
  await page.locator('#jf-input').press('End');
  await page.keyboard.type(' ');
  assert.equal(await page.isVisible('#jf-undo'), false);
  assert.equal(await text('#jf-done'), '');

  // JavaScript literals mean what the JavaScript engine says they mean (undefined, NaN and
  // Infinity become null, as in JSON.stringify for array items).
  const plain = v => v === undefined || (typeof v === 'number' && !isFinite(v)) ? null
    : Array.isArray(v) ? Array.from(v, plain) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map(k => [k, plain(v[k])])) : v;
  const fixAll = async src => {
    await put(src);
    assert.equal(await page.isVisible('#jf-fix'), true, src);
    await page.click('#jf-fix');
    await idle();
    assert.match(await text('#jf-ok'), /^Valid JSON\./, src);
    return page.inputValue('#jf-input');
  };
  for (const src of [
    '{a: 1, \'b\': "x", /* c */ c: [1, 2, ], d: 0x1F, e: +1, f: .5, g: 5., h: Infinity, i: NaN, j: undefined, k: -Infinity, // end\n}',
    '[\'it\\\'s\', "tab\\there", \'\\x41 \\u00e9 "q"\', {$_k1: true, "n": -0x10,}, [], 0xffffffffffffffffffff]',
    '{\n  // settings\n  name: \'demo\',\n  list: [1, 2, 3,],\n  on: true,\n  nested: {deep: {deeper: [{}, [],]}},\n}',
  ]) {
    assert.deepEqual(JSON.parse(await fixAll(src)), plain(vm.runInNewContext('(' + src + ')')), src);
  }
  // 0xffffffffffffffffffff is written out in full, not as a rounded double.
  assert.ok((await fixAll('[0xffffffffffffffffffff]')).includes('1208925819614629174706175'));
  // Python literals mean what ast.literal_eval says.
  for (const c of expected.python) assert.deepEqual(JSON.parse(await fixAll(c.input)), c.value, c.input);
  // Each repair, with the text it leaves.
  const repairs = [
    ['{"a":1}\n{"a":2}\n{"a":3}\n', '[{"a":1},\n{"a":2},\n{"a":3}]\n', 'Fixed 1 problem: wrapped the values in one array.'],
    ['{"a":1},{"a":2},', '[{"a":1},{"a":2}]', 'Fixed 2 problems: removed 1 extra comma, wrapped the values in one array.'],
    ['{"a": [1, {"b": 2', '{"a": [1, {"b": 2}]}', 'Fixed 1 problem: closed the brackets left open at the end.'],
    ['[1, 2,\n', '[1, 2]\n', 'Fixed 2 problems: removed 1 trailing comma, closed the brackets left open at the end.'],
    ['{' + String.fromCharCode(0x201C) + 'a' + String.fromCharCode(0x201D) + ': ' + String.fromCharCode(0x2018) + 'b' + String.fromCharCode(0x2019) + '}', '{"a": "b"}', 'Fixed 2 problems: straightened the quotes of 2 strings.'],
    ['["one\ntwo\tthree"]', '["one\\ntwo\\tthree"]', 'Fixed 2 problems: escaped 2 control characters inside strings.'],
    ['["a' + String.fromCharCode(8) + 'b' + String.fromCharCode(12) + 'c' + String.fromCharCode(1) + 'd' + String.fromCharCode(31) + '"]', '["a\\bb\\fc\\u0001d\\u001f"]', 'Fixed 4 problems: escaped 4 control characters inside strings.'],
    ['{"path": "C:\\dir\\file"}', '{"path": "C:\\\\dir\\file"}', 'Fixed 1 problem: repaired 1 invalid escape.'],
    ['{"a" = 1, "b" => 2}', '{"a" : 1, "b" : 2}', 'Fixed 2 problems: changed 2 = signs to a colon.'],
    ['[1 2 "x" true\n{"a": 1 "b": 2}]', '[1, 2, "x", true,\n{"a": 1, "b": 2}]', 'Fixed 5 problems: added 5 missing commas.'],
    [BOM + '[1,' + NBSP + '2' + ZWSP + ']', '[1, 2]', 'Fixed 3 problems: replaced 3 unusual spaces or invisible characters.'],
    ['[1,,2,]', '[1,2]', 'Fixed 2 problems: removed 1 trailing comma, removed 1 extra comma.'],
    ['["\\x41\\xe9", "it\\\'s"]', '["\\u0041\\u00e9", "it\'s"]', 'Fixed 3 problems: repaired 3 invalid escapes.'],
    ['[+1, .5, 5., -.25e3, 0x1F]', '[1, 0.5, 5.0, -0.25e3, 31]', 'Fixed 5 problems: removed 1 leading plus sign, completed 3 numbers such as .5, converted 1 hexadecimal number to decimal.'],
  ];
  for (const [input, fixed, said] of repairs) {
    assert.equal(await fixAll(input), fixed, JSON.stringify(input));
    assert.equal(await text('#jf-done'), said, JSON.stringify(input));
    JSON.parse(fixed);
  }
  // What cannot be repaired safely is left alone, and what could be waits for it.
  await type('{\'a\': 1, "b": 01}');
  assert.equal(await text('#jf-error'), 'Line 1, column 2. Single quotes: JSON strings and keys must be in double quotes ("). Further on, line 1, column 15: Leading zero: a number cannot start with 0 and go on with more digits. ' +
    'Remove the zeros, or put the value in double quotes if they matter, as in a postcode. That one has to be corrected by hand; after that the rest can be fixed for you.');
  assert.equal(await page.isVisible('#jf-fix'), false);

  // ---- A long text is read again only once typing pauses. A button pressed before then acts on
  // the text as it is now, so the edit made just before it is kept. ----
  const longList = '[' + Array.from({ length: 5000 }, (_, i) => `"v${i}"`).join(',');
  await type(longList + ',]');
  assert.ok(longList.length > 20000 && await page.isVisible('#jf-fix'));
  const editThenClick = (tail, sel) => page.evaluate(([tail, sel]) => {
    const el = document.querySelector('#jf-input');
    el.value = el.value.replace(/,?\]$/, tail);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector(sel).click();
  }, [tail, sel]);
  await editThenClick(',"added",]', '#jf-fix');
  await page.waitForFunction(() => /^Fixed 1 problem/.test(document.querySelector('#jf-done').textContent));
  await idle();
  assert.equal(await page.inputValue('#jf-input'), longList + ',"added"]', 'the edit made just before Fix is kept');
  await page.waitForFunction(() => document.querySelector('#jf-copy').textContent === 'Copy result');
  await editThenClick(',"more"]', '#jf-copy');
  await page.waitForFunction(() => document.querySelector('#jf-copy').textContent === 'Copied!');
  assert.ok((await clipboard()).endsWith('\n  "added",\n  "more"\n]'), 'Copy gives the result of the text with the last edit');
  const [lateFile] = await Promise.all([page.waitForEvent('download'), editThenClick(',"late"]', '#jf-download')]);
  assert.ok(fs.readFileSync(await lateFile.path(), 'utf8').endsWith('\n  "more",\n  "late"\n]'), 'Download too');
  await editThenClick(',"third"]', '#jf-use');
  await page.waitForFunction(() => document.querySelector('#jf-done').textContent === 'The result is now the input.');
  await idle();
  assert.ok((await page.inputValue('#jf-input')).endsWith('\n  "late",\n  "third"\n]'), 'Use as input takes the result of the text with the last edit');
  await page.evaluate(([v]) => {
    const el = document.querySelector('#jf-input');
    el.value = v + ',]';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [longList]);
  await idle();
  await page.evaluate(() => {
    const el = document.querySelector('#jf-input');
    el.value = '[nul,' + el.value.slice(1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#jf-goto').click();
  });
  await page.waitForFunction(() => /^Line 1, column 2\. Unexpected nul/.test(document.querySelector('#jf-error').textContent));
  await idle();
  assert.equal(await page.evaluate(() => { const el = document.querySelector('#jf-input'); return el.value.slice(el.selectionStart, el.selectionEnd); }), 'nul', 'Go to marks the error of the text as it is now');

  // ---- Go to the error selects it in the box and scrolls there. ----
  const lines = Array.from({ length: 300 }, (_, i) => `  "key${i}": "value ${i}",`);
  await type('{\n' + lines.join('\n') + '\n  "last": tru\n}');
  assert.equal(await text('#jf-error'), 'Line 302, column 11. Unexpected tru: text must be in double quotes. The only bare words in JSON are true, false and null.');
  assert.equal((await text('#jf-snip')).trim(), '"last": tru');
  await page.evaluate(() => { document.querySelector('#jf-input').scrollTop = 0; });
  await page.click('#jf-goto');
  const at = await page.evaluate(() => {
    const el = document.querySelector('#jf-input');
    return { focus: document.activeElement === el, selected: el.value.slice(el.selectionStart, el.selectionEnd), top: el.scrollTop, max: el.scrollHeight - el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight) };
  });
  assert.equal(at.focus, true);
  assert.equal(at.selected, 'tru');
  assert.ok(at.top > at.max - 12 * at.line && at.top <= at.max, `the error line is in view (scrolled to ${at.top} of ${at.max})`);
  assert.equal(await page.locator('.jf-in textarea').count(), 1, 'the measuring copy of the box is removed again');

  // ---- Empty input is not an error. ----
  for (const empty of ['', '   \n\t ']) {
    await type(empty);
    assert.equal(await text('#jf-error') + await text('#jf-ok') + await text('#jf-note') + await result(), '');
    assert.equal(await page.getAttribute('#jf-input', 'aria-invalid'), 'false');
    assert.equal(await page.isDisabled('#jf-copy'), true);
  }

  // ---- Tree view. ----
  await type('{"b":{"x":[1,"two",null,true,{"deep":{}}],"y":""},"a":3.50,"":[],"long":"' + 'x'.repeat(300) + '"}');
  await mode('tree');
  assert.equal(await page.isVisible('#jf-out'), false);
  const rows = () => page.$$eval('#jf-tree li', lis => lis.map(li => (li.querySelector(':scope > details > summary') || li).textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(await rows(), ['{…} object, 4 keys', 'b: {…} object, 2 keys', 'a: 3.50', '"": []', 'long: "' + 'x'.repeat(239) + '…']);
  assert.equal(await page.locator('#jf-tree details').first().getAttribute('open'), '');
  // Opened from the keyboard: the summary is a native control.
  await page.locator('#jf-tree summary', { hasText: 'b:' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li').length === 7);
  assert.deepEqual((await rows()).slice(1, 4), ['b: {…} object, 2 keys', 'x: […] array, 5 items', 'y: ""']);
  await page.click('#jf-expand');
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li').length === 13);
  assert.deepEqual((await rows()).slice(2, 10), ['x: […] array, 5 items', '0: 1', '1: "two"', '2: null', '3: true', '4: {…} object, 1 key', 'deep: {}', 'y: ""']);
  await sort(true);
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li').length === 5);
  assert.deepEqual((await rows()).map(r => r.split(':')[0]), ['{…} object, 4 keys', '""', 'a', 'b', 'long']);
  await sort(false);
  await page.click('#jf-expand');
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li').length === 13);
  await page.click('#jf-collapse');
  assert.equal(await page.locator('#jf-tree details[open]').count(), 1, 'only the root stays open');
  // Copy and Download give the formatted text in tree view.
  await page.click('#jf-copy');
  assert.equal(await clipboard(), JSON.stringify(JSON.parse(await page.inputValue('#jf-input')), null, 2).replace('"a": 3.5,', '"a": 3.50,'));
  // A long array comes 100 rows at a time.
  await type('[' + Array.from({ length: 250 }, (_, i) => i * 2).join(',') + ']');
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li:not(.jf-more)').length === 101);
  assert.equal((await text('#jf-tree .jf-more')).trim(), 'Show 100 more 150 not shown');
  await page.locator('#jf-tree .jf-more button').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li:not(.jf-more)').length === 201);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '100: 200', 'focus moves to the first new row');
  assert.equal((await text('#jf-tree .jf-more')).trim(), 'Show 50 more 50 not shown');
  await page.click('#jf-tree .jf-more button');
  await page.waitForFunction(() => document.querySelectorAll('#jf-tree li:not(.jf-more)').length === 251);
  assert.equal(await page.locator('#jf-tree .jf-more').count(), 0);
  assert.equal((await rows())[250], '249: 498');
  // A value that is not an object or array is a single row; invalid JSON shows the error, no tree.
  await type('"just text"');
  assert.deepEqual(await rows(), ['"just text"']);
  assert.equal(await page.isVisible('#jf-tree-acts'), false);
  // A long string is cut at 240 characters, never between the two halves of an emoji.
  await type('["' + 'x'.repeat(238) + String.fromCodePoint(0x1F600) + 'tail"]');
  assert.deepEqual(await rows(), ['[\u2026] array, 1 item', '0: "' + 'x'.repeat(238) + '\u2026']);
  await type('[1,');
  assert.equal(await page.isVisible('#jf-tree'), false);
  assert.match(await text('#jf-error'), /^Line 1, column 3\. Trailing comma/);
  await mode('format');

  // ---- Escape and unescape, against JSON.stringify. ----
  const samples = ['He said "hi"\nand left.\tC:\\temp\\x', '{"id": 1, "name": "Ada \\"the first\\""}',
    'caf' + E_ACUTE + ' ' + String.fromCodePoint(0x1F600) + ' / ' + String.fromCharCode(1) + String.fromCharCode(0x2028), 'plain'];
  await mode('escape');
  assert.equal(await page.isVisible('#jf-sort'), false);
  for (const s of samples) {
    await put(s);
    assert.equal(await result(), JSON.stringify(s), s);
    await page.uncheck('#jf-quotes');
    await idle();
    assert.equal(await result(), JSON.stringify(s).slice(1, -1), s);
    await page.check('#jf-quotes');
    await idle();
  }
  await put(samples[0]);
  assert.equal(await text('#jf-ok'), 'Escaped: 6 characters needed a backslash.');
  await put('plain');
  assert.equal(await text('#jf-ok'), 'Escaped: no character needed a backslash.');
  // White space is text too, and the 50,000 characters up to which a result is coloured are counted exactly.
  await put(' \n');
  assert.equal(await result(), '" \\n"');
  await put('x'.repeat(49998));
  assert.equal(await page.locator('#jf-out span.hljs-string').count(), 1);
  assert.equal(await text('#jf-out-note'), '');
  await put('x'.repeat(49999));
  assert.equal(await page.locator('#jf-out span').count(), 0);
  assert.equal(await text('#jf-out-note'), 'Colours are switched off above 50,000 characters to keep the page quick.');
  await mode('unescape');
  for (const s of samples) {
    await put(JSON.stringify(s));
    assert.equal(await result(), s, 'in quotes: ' + s);
    await put(JSON.stringify(s).slice(1, -1));
    assert.equal(await result(), s, 'without quotes: ' + s);
  }
  await put('"\\u0041\\u00e9\\ud83d\\ude00\\/"');
  assert.equal(await result(), 'A' + E_ACUTE + String.fromCodePoint(0x1F600) + '/');
  await put('no escapes here');
  assert.equal(await text('#jf-ok'), 'Nothing to unescape: the text has no backslash escapes.');
  assert.equal(await result(), 'no escapes here');
  // A result that is a number beyond a double's range is still checked for being JSON.
  await put('\\u0031' + '0'.repeat(400));
  assert.equal(await result(), '1' + '0'.repeat(400));
  assert.equal(await text('#jf-ok'), 'Unescaped. The result is valid JSON: choose Use as input to format it.');
  // A bad escape is an error on the field, with its place.
  await put('line one\nabc\\qdef');
  assert.equal(await text('#jf-error'), 'Line 2, column 4. \\q is not a JSON escape. The escapes are \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX; a backslash itself is written \\\\.');
  assert.equal(await page.getAttribute('#jf-input', 'aria-invalid'), 'true');
  assert.equal(await result(), '');
  assert.equal(await page.isVisible('#jf-fix'), false);
  await put('ends with \\');
  assert.equal(await text('#jf-error'), 'Line 1, column 11. A backslash at the very end has nothing to escape.');
  await put('bad \\u12 unicode');
  assert.equal(await text('#jf-error'), 'Line 1, column 5. \\u must be followed by four hexadecimal digits, as in \\u00e9.');
  // JSON inside a string, as in a log: unescape, then use the result as the input.
  const inner = { id: 7, tags: ['a', 'b'], note: 'say "hi"' };
  await put(JSON.stringify(JSON.stringify(inner)));
  assert.equal(await result(), JSON.stringify(inner));
  assert.equal(await text('#jf-ok'), 'Unescaped. The result is valid JSON: choose Use as input to format it.');
  await page.click('#jf-use');
  await idle();
  assert.equal(await page.isChecked('input[name="jf-mode"][value="format"]'), true);
  assert.equal(await page.inputValue('#jf-input'), JSON.stringify(inner));
  assert.equal(await result(), JSON.stringify(inner, null, 2));
  assert.equal(await text('#jf-done'), 'The result is now the input.');
  await page.click('#jf-undo');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), JSON.stringify(JSON.stringify(inner)));

  // ---- Copy and download. ----
  const compact = '{"k":[1,2,{"z":null}],"s":"' + E_ACUTE + '"}';
  await type(compact);
  const pretty = '{\n  "k": [\n    1,\n    2,\n    {\n      "z": null\n    }\n  ],\n  "s": "' + E_ACUTE + '"\n}';
  await page.click('#jf-copy');
  assert.equal(await clipboard(), pretty);
  assert.equal(await text('#jf-copy'), 'Copied!');
  let file = await download();
  assert.equal(file.name, 'formatted.json');
  assert.equal(file.bytes.toString('utf8'), pretty);
  assert.equal(file.bytes.length, pretty.length + 1, 'UTF-8, no byte order mark');
  await mode('minify');
  assert.equal(await text('#jf-out-info'), '31 bytes minified, 31 bytes as entered');
  await type(pretty);
  assert.equal(Buffer.byteLength(compact), 31);
  assert.equal(await text('#jf-out-info'), `31 bytes minified, ${Buffer.byteLength(pretty)} bytes as entered (${Math.round((1 - 31 / Buffer.byteLength(pretty)) * 100)}% smaller)`);
  file = await download();
  assert.equal(file.name, 'minified.json');
  assert.equal(file.bytes.toString('utf8'), compact);
  await mode('escape');
  file = await download();
  assert.equal(file.name, 'json.escaped.txt');
  assert.equal(file.bytes.toString('utf8'), JSON.stringify(pretty));
  await mode('format');

  // ---- Example and Clear replace the text, and Undo brings it back. ----
  await type('[1, 2, 3]');
  await page.click('#jf-clear');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), '');
  assert.equal(await text('#jf-done'), 'The box is empty. Undo brings your text back.');
  await page.click('#jf-undo');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), '[1, 2, 3]');
  await page.click('#jf-example');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), example);
  // The example's colours in the page are exactly what highlight.js makes of it.
  assert.equal(await page.evaluate(() => typeof window.hljs), 'object');
  assert.equal(await page.innerHTML('#jf-out'), staticHtml);

  // ---- Files. A 150 KB document is read in a worker; the result matches Python's byte for byte. ----
  assert.equal(await page.evaluate(() => window.__workers), 0, 'no worker for short texts');
  const openFile = async (name, buffer) => {
    await page.setInputFiles('#jf-file', { name, mimeType: 'application/json', buffer });
    await page.waitForFunction(n => document.querySelector('#jf-done').textContent.startsWith('Opened ' + n) || document.querySelector('#jf-file-error').textContent, name);
    await idle();
  };
  await openFile('big.json', Buffer.from(bigText));
  assert.equal(await text('#jf-done'), 'Opened big.json (154 KB).');
  assert.equal(await page.evaluate(() => window.__workers), 1);
  assert.equal(await page.inputValue('#jf-input'), bigText, 'a file of this size goes into the box');
  assert.match(await text('#jf-ok'), /^Valid JSON\. /);
  assert.equal(await text('#jf-out-info'), `295 KB formatted, 154 KB as entered`);
  assert.equal(await text('#jf-out-note'), 'Colours are switched off above 50,000 characters to keep the page quick.');
  assert.equal(await page.locator('#jf-out span').count(), 0);
  file = await download();
  assert.equal(file.name, 'big.formatted.json');
  assert.equal(file.bytes.length, expected.big.indent2.bytes);
  assert.equal(sha(file.bytes), expected.big.indent2.sha256);
  await page.click('#jf-copy');
  assert.equal(sha(Buffer.from(await clipboard())), expected.big.indent2.sha256);
  await mode('minify');
  file = await download();
  assert.equal(file.name, 'big.min.json');
  assert.equal(sha(file.bytes), expected.big.min.sha256);
  await mode('format');
  await indent('4');
  await sort(true);
  assert.equal(sha((await download()).bytes), expected.big.sorted4.sha256);
  await sort(false);
  await indent('2');
  assert.equal(await page.evaluate(() => window.__workers), 1, 'the same worker is used again');
  // Tree of a large document: Expand all stops at 2,000 rows.
  await mode('tree');
  await page.click('#jf-expand');
  await page.waitForFunction(() => /^Opened the first 2,000 rows/.test(document.querySelector('#jf-out-note').textContent));
  const treeRows = await page.locator('#jf-tree li').count();
  assert.ok(treeRows >= 2000 && treeRows < 2200, `${treeRows} rows`);
  await mode('format');
  // Other encodings: UTF-16 with and without a byte order mark, UTF-8 with one, and bytes that are not UTF-8.
  const sample = '{"city":"K' + String.fromCharCode(0xF8) + 'benhavn","n":[1,2]}';
  const utf16 = Buffer.from(sample, 'utf16le');
  for (const [name, buffer, said] of [
    ['utf16le-bom.json', Buffer.concat([Buffer.from([0xFF, 0xFE]), utf16]), ' It was read as UTF-16.'],
    ['utf16le.json', utf16, ' It was read as UTF-16.'],
    ['utf16be-bom.json', Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(utf16).swap16()]), ' It was read as UTF-16.'],
    ['utf8-bom.json', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(sample)]), ''],
    ['latin1.json', Buffer.from(sample, 'latin1'), ' It is not valid UTF-8 and was read as Windows-1252.'],
  ]) {
    await openFile(name, buffer);
    assert.equal(await text('#jf-done'), `Opened ${name} (${buffer.length} bytes).${said}`);
    assert.equal(await page.inputValue('#jf-input'), sample, name);
    assert.match(await text('#jf-ok'), /^Valid JSON\. 1 object, 1 array, 2 keys/, name);
  }
  // A size is rounded once: 999,608 bytes are 1.0 MB, not 1000 KB.
  const nearMB = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('[' + '1,\n'.repeat(166600) + '1]', 'utf16le')]);
  assert.equal(nearMB.length, 999608);
  await openFile('near-mb.json', nearMB);
  assert.equal(await text('#jf-done'), 'Opened near-mb.json (1.0 MB). It was read as UTF-16.');
  assert.match(await text('#jf-ok'), /^Valid JSON\. 1 array, 166,601 values/);
  // Old Mac files end a line with a carriage return alone. A file too long for the box is read as
  // it is, and its lines are still counted.
  await openFile('cr.json', Buffer.from('[\r' + '1,\r'.repeat(340000) + ']'));
  assert.equal(await page.isVisible('#jf-input'), false);
  assert.equal(await text('#jf-error'), 'Line 340,001, column 2. Trailing comma: JSON does not allow a comma before a closing } or ]. Remove it.');
  await page.click('#jf-held-close');
  await idle();
  await type(sample);
  // A file over 50 MB is refused before it is read, and the text in the box stays.
  const tooBig = path.join(os.tmpdir(), `jf-too-big-${process.pid}.json`);
  fs.writeFileSync(tooBig, Buffer.alloc(50000001, 0x20));
  try {
    await page.setInputFiles('#jf-file', tooBig);
    await page.waitForFunction(() => document.querySelector('#jf-file-error').textContent !== '');
    assert.equal(await text('#jf-file-error'), `${path.basename(tooBig)} is larger than 50 MB, the largest file this page opens.`);
    assert.equal(await page.inputValue('#jf-input'), sample);
  } finally {
    fs.unlinkSync(tooBig);
  }
  // Dropping a file on the box opens it instead of leaving the page; of several, the first.
  const drop = files => page.evaluate(list => {
    const dt = new DataTransfer();
    for (const [name, body] of list) dt.items.add(new File([body], name, { type: 'application/json' }));
    const box = document.querySelector('#jf-input');
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
  await drop([['one.json', '[1]'], ['two.json', '[2]']]);
  await page.waitForFunction(() => /^Opened one\.json/.test(document.querySelector('#jf-done').textContent));
  await idle();
  assert.equal(await text('#jf-done'), 'Opened one.json (3 bytes). Only the first of the 2 files was opened.');
  assert.equal(await page.inputValue('#jf-input'), '[1]');
  await drop([['drop.json', '[true, false]']]);
  await page.waitForFunction(() => document.querySelector('#jf-done').textContent === 'Opened drop.json (13 bytes).');
  await idle();
  assert.equal(await result(), '[\n  true,\n  false\n]');

  // ---- Long texts. More than a million characters pasted over the box stay beside it, the
  // page keeps answering, and Copy still gives everything. ----
  const rowsBig = Array.from({ length: 12000 }, (_, i) => ({ id: i, name: 'Item number ' + i, tags: ['alpha', 'beta'], price: i * 1.25, ok: i % 3 === 0 }));
  const million = JSON.stringify(rowsBig);
  assert.ok(million.length > 1000000);
  await page.evaluate(v => navigator.clipboard.writeText(v), million);
  await page.focus('#jf-input');
  await page.keyboard.press('Control+A');
  let t0 = Date.now();
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => /^Pasted/.test(document.querySelector('#jf-done').textContent));
  await idle();
  assert.ok(Date.now() - t0 < 5000, `paste took ${Date.now() - t0} ms`);
  assert.equal(await text('#jf-done'), `Pasted ${million.length.toLocaleString('en-GB')} characters.`);
  assert.equal(await page.isVisible('#jf-input'), false);
  assert.equal((await text('#jf-held')).replace(/\s+/g, ' ').trim(), `This text (${million.length.toLocaleString('en-GB')} characters) is open. It is too long to edit in the box, so only the result is shown. Close it`);
  assert.equal(await text('#jf-ok'), 'Valid JSON. 12,000 objects, 12,001 arrays, 60,000 keys, 72,000 values, 3 levels deep.');
  const prettyMillion = JSON.stringify(rowsBig, null, 2);
  const shown = await result();
  assert.ok(shown.length > 390000 && shown.length <= 400000 && prettyMillion.startsWith(shown), 'the start of the result is shown');
  assert.equal(await text('#jf-out-note'), `Showing the first ${shown.length.toLocaleString('en-GB')} of ${prettyMillion.length.toLocaleString('en-GB')} characters. Copy and Download give all of it.`);
  await page.click('#jf-copy');
  assert.equal(sha(Buffer.from(await clipboard())), sha(Buffer.from(prettyMillion)));
  // Minified it is one line, which a browser lays out slowly: the first 100,000 characters are shown.
  await mode('minify');
  assert.equal(await result(), million.slice(0, 100000));
  assert.equal(await text('#jf-out-note'), `Showing the first 100,000 of ${million.length.toLocaleString('en-GB')} characters. Copy and Download give all of it.`);
  await mode('format');
  // An error in a text kept beside the box: no "Go to", the place is in the message.
  await page.evaluate(v => navigator.clipboard.writeText(v), million.slice(0, -1) + ',]');
  await page.click('#jf-held-close');
  await idle();
  assert.equal(await page.isVisible('#jf-input'), true);
  await page.focus('#jf-input');
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => /^Line 1, column/.test(document.querySelector('#jf-error').textContent));
  assert.equal(await text('#jf-error'), `Line 1, column ${million.length.toLocaleString('en-GB')}. Trailing comma: JSON does not allow a comma before a closing } or ]. Remove it.`);
  assert.equal(await page.isVisible('#jf-goto'), false);
  await page.click('#jf-fix');
  await page.waitForFunction(() => /^Fixed 1 problem/.test(document.querySelector('#jf-done').textContent));
  await idle();
  assert.match(await text('#jf-ok'), /^Valid JSON\. 12,000 objects/);
  await page.click('#jf-held-close');
  await idle();
  // A paste into the middle of a text that makes it longer than a million characters stays beside the box too.
  await type('{"rows": , "n": 1}');
  await page.evaluate(v => navigator.clipboard.writeText(v), million);
  await page.focus('#jf-input');
  await page.evaluate(() => document.querySelector('#jf-input').setSelectionRange(9, 9));
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => /^Pasted/.test(document.querySelector('#jf-done').textContent));
  await idle();
  assert.equal(await page.isVisible('#jf-input'), false);
  assert.equal(await text('#jf-ok'), 'Valid JSON. 12,001 objects, 12,001 arrays, 60,002 keys, 72,001 values, 4 levels deep.');
  await page.click('#jf-undo');
  await idle();
  assert.equal(await page.inputValue('#jf-input'), '{"rows": , "n": 1}', 'Undo brings back the text before the paste');
  // A megabyte of anything in the box itself: the typing handler returns at once and the answer follows.
  for (const [junk, check] of [
    ['['.repeat(1100000), () => text('#jf-error').then(e => assert.match(e, /^Line 1, column 1,001\. Nested more than 1,000 levels deep/))],
    [' '.repeat(1100000), () => text('#jf-error').then(e => assert.equal(e, ''))],
    ['"' + 'a\\'.repeat(550000), () => text('#jf-error').then(e => assert.match(e, /^Line 1, column 1\. This string never ends/))],
    ['["' + '\\q'.repeat(400000) + '"]', () => text('#jf-fix').then(e => assert.equal(e, 'Fix 400,000 problems'))],
    ['{' + '"k":1 '.repeat(190000) + '}', () => text('#jf-fix').then(e => assert.equal(e, 'Fix 189,999 problems'))],
    [million, () => text('#jf-ok').then(e => assert.match(e, /^Valid JSON\. 12,000 objects/))],
  ]) {
    const ms = await page.evaluate(v => {
      const el = document.querySelector('#jf-input');
      el.value = v;
      const t = performance.now();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - t;
    }, junk);
    assert.ok(ms < 200, `input handler took ${Math.round(ms)} ms for ${junk.slice(0, 12)}`);
    t0 = Date.now();
    await idle();
    assert.ok(Date.now() - t0 < 6000, `answer took ${Date.now() - t0} ms for ${junk.slice(0, 12)}`);
    await check();
  }

  // ---- Announcements: one summary after typing pauses, written once. ----
  await type('');
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__jfSaid = [];
    new MutationObserver(() => window.__jfSaid.push(document.querySelector('#jf-status').textContent)).observe(document.querySelector('#jf-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#jf-input').pressSequentially('{"a": [1, 2]}', { delay: 15 });
  await page.waitForFunction(() => document.querySelector('#jf-status').textContent !== '', null, { timeout: 4000 });
  assert.deepEqual(await page.evaluate(() => window.__jfSaid), ['Valid JSON. 1 object, 1 array, 1 key, 2 values, 2 levels deep.']);
  await page.locator('#jf-input').pressSequentially(' x', { delay: 15 });
  await page.waitForFunction(() => window.__jfSaid.length === 2, null, { timeout: 4000 });
  assert.equal(await text('#jf-status'), 'Not valid JSON. Line 1, column 15. Unexpected x after the end of the JSON value.');
  assert.equal(await page.getAttribute('#jf-status', 'role'), 'status');
  assert.equal(await page.getAttribute('#jf-done', 'aria-live'), 'polite');

  // ---- After Back or a reload the browser puts the fields back without telling the script. ----
  await page.evaluate(() => {
    document.querySelector('#jf-input').value = '[3,2,1]';
    document.querySelector('input[name="jf-mode"][value="minify"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await idle();
  assert.equal(await result(), '[3,2,1]');
  assert.equal(await page.isVisible('#jf-indent'), false);
  await mode('format');

  // ---- The main flow from the keyboard alone. ----
  await page.click('#jf-clear');
  await page.keyboard.type('{"k":[1,2]}');
  const tabTo = async sel => {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(s => document.activeElement.matches(s), sel)) return;
    }
    assert.fail(`Tab never reached ${sel}`);
  };
  await tabTo('input[name="jf-mode"]');
  await page.keyboard.press('ArrowRight');
  await idle();
  assert.equal(await page.isChecked('input[name="jf-mode"][value="minify"]'), true);
  assert.equal(await result(), '{"k":[1,2]}');
  await page.keyboard.press('ArrowLeft');
  await tabTo('#jf-indent');
  await page.keyboard.press('ArrowDown');
  await idle();
  assert.equal(await result(), '{\n    "k": [\n        1,\n        2\n    ]\n}');
  await tabTo('#jf-out');
  assert.equal(await page.locator('#jf-out').evaluate(e => getComputedStyle(e).outlineStyle), 'solid', 'the result shows a focus ring');
  await tabTo('#jf-copy');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#jf-copy').textContent === 'Copied!');
  assert.equal(await clipboard(), '{\n    "k": [\n        1,\n        2\n    ]\n}');
  await indent('2');

  // ---- On a phone, by touch. ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  const phoneErrors = [];
  p.on('pageerror', e => phoneErrors.push(e.message));
  await p.goto(url, { waitUntil: 'load' });
  const pIdle = () => p.waitForFunction(() => document.querySelector('#jf-result').getAttribute('aria-busy') === 'false');
  await p.tap('#jf-input');
  await p.fill('#jf-input', '{"list":[1,2,{"deep":true}],"text":"' + 'longword'.repeat(60) + '"}');
  await pIdle();
  await p.tap('.jf-chip:has(input[value="minify"])');
  await pIdle();
  assert.equal(await p.locator('#jf-out').textContent(), await p.inputValue('#jf-input'));
  await p.tap('.jf-chip:has(input[value="tree"])');
  await pIdle();
  await p.tap('#jf-tree summary >> nth=1');
  await p.waitForFunction(() => document.querySelectorAll('#jf-tree li').length === 6);
  const sizes = await p.evaluate(() => {
    const h = sel => Math.min(...[...document.querySelectorAll(sel)].filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height));
    return { chips: h('.jf-chip span'), buttons: h('.jf button'), summaries: h('#jf-tree summary'), check: h('.jf .check'), font: parseFloat(getComputedStyle(document.querySelector('#jf-input')).fontSize) };
  });
  assert.ok(sizes.chips >= 44 && sizes.buttons >= 44 && sizes.summaries >= 44 && sizes.check >= 44, JSON.stringify(sizes));
  assert.ok(sizes.font >= 16, `the box has ${sizes.font}px text`);
  for (const width of [412, 320]) {
    await p.setViewportSize({ width, height: 800 });
    assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px with a long string in the tree`);
  }
  const oops = '{"a": "' + 'x'.repeat(90) + '" oops}';
  await p.fill('#jf-input', oops);
  await pIdle();
  assert.ok((await p.locator('#jf-error').textContent()).startsWith(`Line 1, column ${oops.indexOf('oops') + 1}. Unexpected oops after a string`));
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320px with an error on screen');
  assert.deepEqual(phoneErrors, []);
  await phone.close();

  // Left for the runner's phone-width check: an error with its place marked, and a long result.
  await type('{"words": "' + 'unbroken'.repeat(80) + '", "n": [1, 2, 3]}');
  await put('{"words": "' + 'unbroken'.repeat(80) + '", n: [1, 2, 3]}');
};
