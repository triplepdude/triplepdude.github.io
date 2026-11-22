const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Known answers come from tests/fixtures/roman-numerals-converter/expected.json, made by expected.py
// with one table per decimal place (a different method from the page) and checked against the strict
// pattern for standard numerals. The browser's clock is fixed at 2026-11-24 12:00 UTC.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const E = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const BAR = String.fromCharCode(0x305), MACRON = String.fromCharCode(0x304);
  const text = sel => page.locator(sel).textContent();
  const describedBy = async (field, msg) => {
    assert.equal(await page.getAttribute(field, 'aria-invalid'), 'true', `${field} is marked invalid`);
    assert.ok((await page.getAttribute(field, 'aria-describedby')).split(' ').includes(msg), `${field} points at #${msg}`);
  };
  const valid = async field => assert.equal(await page.getAttribute(field, 'aria-invalid'), null, `${field} is valid`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  await page.clock.install({ time: new Date('2026-11-24T12:00:00Z') });
  await open();

  // ---- The page starts with this year and today's date, and a clean address ----
  assert.equal(await page.inputValue('#rn-num'), '2026');
  assert.equal(await page.inputValue('#rn-rom'), E.roman[2025]);
  assert.equal(await text('#rn-breakdown'), '2,026 = MM + XX + VI = 2,000 + 20 + 6');
  assert.equal(await page.inputValue('#rn-date'), '2026-11-24');
  assert.equal(await text('#rn-date-big'), 'XXIV·XI·MMXXVI');
  assert.equal(await text('#rn-date-words'), `= ${E.weekdays['2026-11-24']} 24 November 2026 (today)`);
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.locator('#rn-c3 li.is-now').textContent(), '2026 (this year)MMXXVI');

  // ---- Every number from 1 to 3,999, typed in each box in turn, matches the table ----
  const both = await page.evaluate(() => {
    const num = document.querySelector('#rn-num'), rom = document.querySelector('#rn-rom'), out = { r: [], n: [], low: [] };
    for (let n = 1; n < 4000; n++) {
      num.value = String(n); num.dispatchEvent(new Event('input', { bubbles: true }));
      out.r.push(rom.value);
    }
    for (const r of out.r) {
      rom.value = r; rom.dispatchEvent(new Event('input', { bubbles: true }));
      out.n.push(num.value);
      if (document.querySelector('#rn-note').textContent) out.n.push('note for ' + r);
    }
    for (const r of out.r.slice(0, 400)) {
      rom.value = r.toLowerCase(); rom.dispatchEvent(new Event('input', { bubbles: true }));
      out.low.push(num.value);
    }
    return out;
  });
  assert.deepEqual(both.r, E.roman);
  assert.deepEqual(both.n, E.roman.map((_, i) => String(i + 1)), 'every standard numeral reads back, with no note');
  assert.deepEqual(both.low, E.roman.slice(0, 400).map((_, i) => String(i + 1)), 'lower case is read');
  // The chart agrees with the table.
  const chart = await page.$$eval('#rn-c1 li span', ss => ss.map(s => s.textContent));
  assert.deepEqual(chart, E.roman.slice(0, 100));
  const years = await page.$$eval('#rn-c3 li span', ss => ss.map(s => s.textContent));
  assert.deepEqual(years, E.roman.slice(1949, 2035));

  // ---- Breakdown, bars from 4,000, both copy forms ----
  await page.fill('#rn-num', '1994');
  assert.equal(await text('#rn-breakdown'), '1,994 = M + CM + XC + IV = 1,000 + 900 + 90 + 4');
  for (const [n, r] of Object.entries(E.big)) {
    await page.fill('#rn-num', n);
    assert.equal(await page.inputValue('#rn-rom'), r, n);
  }
  await page.fill('#rn-num', '1234567');
  assert.equal(await text('#rn-breakdown'), `1,234,567 = M${BAR} + C${BAR}C${BAR} + X${BAR}X${BAR}X${BAR} + I${BAR}V${BAR} + D + LX + VII = 1,000,000 + 200,000 + 30,000 + 4,000 + 500 + 60 + 7`);
  // On screen each run of barred letters has one overline; screen readers are told about the bar.
  assert.deepEqual(await page.$$eval('#rn-big .rn-bar', bs => bs.map(b => [b.textContent, getComputedStyle(b).textDecorationLine])), [['MCCXXXIV', 'overline']]);
  assert.equal(await text('#rn-big'), 'MCCXXXIV with a bar,DLXVII');
  await page.fill('#rn-num', '4000');
  await page.click('#rn-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `I${BAR}V${BAR}`);
  assert.equal(await text('#rn-copy-us'), 'Copy as _I_V');
  await page.click('#rn-copy-us');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '_I_V');
  await page.click('#rn-copy-num');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '4000');
  await page.fill('#rn-num', '3999');
  assert.equal(await page.isHidden('#rn-copy-us'), true, 'no underscore form without bars');
  // The status line is written after a pause, and only when it changes.
  await page.clock.runFor(500);
  assert.equal(await text('#rn-status'), '3,999 is MMMCMXCIX.');
  await page.fill('#rn-num', '4500');
  await page.clock.runFor(500);
  assert.equal(await text('#rn-status'), '4,500 is IV with a bar, D.');

  // ---- Numbers: separators the same in every language, and mistakes explained ----
  for (const v of ['1,994', '1.994', '1 994', '1 994', "1'994", '١٬٩٩٤', '１９９４', ' 1994 ', '+1994', '01994']) {
    await page.fill('#rn-num', v);
    assert.equal(await page.inputValue('#rn-rom'), 'MCMXCIV', v);
    await valid('#rn-num');
  }
  await page.fill('#rn-num', '12.000');
  assert.equal(await page.inputValue('#rn-rom'), `X${BAR}I${BAR}I${BAR}`, '12.000 is twelve thousand, not 12');
  for (const [v, msg] of [
    ['0,500', /^0,500 is not a number: digits before a thousands separator cannot start with 0\.$/],
    ['12.5', /^Roman numerals are whole numbers, and 12\.5 has a fraction\.$/],
    ['1,5', /^Roman numerals are whole numbers, and 1,5 has a fraction\.$/],
    ['١٫٥', /has a fraction/],
    ['5²', /^“²” is not a digit\./],
    ['1994\t2027', /^This looks like more than one number\./],
    ['1994 2027', /^This looks like more than one number\./],
    ['-4', /^Roman numerals have no negative numbers\.$/],
    ['4000000', /^4,000,000 is too big: with single bars, Roman numerals go up to 3,999,999/],
    ['abc', /^“a” is not a digit\./],
  ]) {
    await page.fill('#rn-num', v);
    assert.match(await text('#rn-num-error'), msg, v);
    await describedBy('#rn-num', 'rn-num-error');
    assert.equal(await page.inputValue('#rn-rom'), '', `${v}: no numeral is shown`);
    assert.equal(await text('#rn-big'), '');
  }
  await page.fill('#rn-num', '0');
  await valid('#rn-num');
  assert.match(await text('#rn-note'), /^There is no Roman numeral for zero\. Dionysius Exiguus wrote the Latin word nulla in 525, and about 725 Bede or a colleague used the letter N\.$/);
  await page.fill('#rn-num', '7');
  assert.equal(await text('#rn-num-error'), '');
  await valid('#rn-num');

  // ---- Numerals that break the rules: likely value, standard form and the rule broken ----
  const rules = {
    IIII: /a numeral is used at most three times in a row \(IIII\)/,
    IIX: /only one numeral is subtracted at a time \(IIX\)/,
    IC: /a numeral subtracts only from the next two numerals up, at most ten times its value \(IC\)/,
    VX: /only I, X and C are put before a larger numeral to subtract \(VX\)/,
    VIV: /V, L and D are never repeated/,
    XCX: /each place, thousands, hundreds, tens and units, is written once, largest first/,
    MMMM: /at most three times in a row \(MMMM\)/,
    XM: /at most ten times its value \(XM\)/,
    XIIX: /only one numeral is subtracted at a time \(IIX\)/,
  };
  for (const [s, re] of Object.entries(rules)) {
    await page.fill('#rn-rom', s);
    assert.equal(await page.inputValue('#rn-num'), String(E.likely[s]), s);
    assert.equal(await page.inputValue('#rn-rom'), s, 'what was typed stays');
    const note = await text('#rn-note');
    assert.ok(note.startsWith(`${s} is not the standard form. Its likely value is ${E.likely[s].toLocaleString('en-GB')}, written ${E.standard_of_likely[s]}.`), note);
    assert.match(note, re, s);
    assert.match(note, /non-standard rather than wrong/);
    await valid('#rn-rom');
  }
  await page.fill('#rn-rom', 'IIII');
  assert.match(await text('#rn-note'), /Clock faces often use IIII for four\./);
  await page.fill('#rn-rom', 'IIX');
  assert.match(await text('#rn-note'), /IIX for 8 is found in Roman inscriptions\./);
  // Other ways of writing barred numerals and old characters.
  for (const [s, n] of [['_I_V', '4000'], [`I${MACRON}V${MACRON}`, '4000'], ['Ⅻ', '12'], ['ⅻ', '12'], ['ↂ', '10000'], ['CIↃ', '1000'], ['IↃ', '500'], [' mcm xc iv ', '1994']]) {
    await page.fill('#rn-rom', s);
    assert.equal(await page.inputValue('#rn-num'), n, s);
  }
  await page.fill('#rn-rom', `MV${BAR}`);
  assert.equal(await page.inputValue('#rn-num'), '4000');
  assert.match(await text('#rn-note'), new RegExp(`^MV${BAR} is 4,000, written I${BAR}V${BAR} here: M and I with a bar both stand for 1,000`));
  for (const [s, msg] of [
    ['ABC', /^“A” is not a Roman numeral\. Use I, V, X, L, C, D and M\.$/],
    ['MO', /^“O” is not a Roman numeral\. Use I, V, X, L, C, D and M \(there is no Roman numeral for zero\)\.$/],
    ['M😀X', /^“😀” is not a Roman numeral\./],
    ['X1', /^This box takes Roman numerals; type numbers in the Number box\.$/],
    ['_Q', /^An underscore must come before a numeral/],
    [`M${BAR}M${BAR}M${BAR}M${BAR}`, /^That is 4,000,000\. With single bars, Roman numerals go up to 3,999,999\.$/],
  ]) {
    await page.fill('#rn-rom', s);
    assert.match(await text('#rn-rom-error'), msg, s);
    await describedBy('#rn-rom', 'rn-rom-error');
    assert.equal(await page.inputValue('#rn-num'), '');
  }
  await page.fill('#rn-rom', 'N');
  assert.equal(await page.inputValue('#rn-num'), '0');
  assert.match(await text('#rn-note'), /no Roman numeral for zero/);
  await valid('#rn-rom');

  // ---- A megabyte pasted into any box is refused at once ----
  let cpu = await threadMs();
  for (const sel of ['#rn-num', '#rn-rom', '#rn-rdate']) {
    await page.$eval(sel, el => { el.value = 'MCMXCIV '.repeat(131072); el.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  assert.match(await text('#rn-rom-error'), /^This is 1,048,576 characters long; a Roman numeral here has up to 200\.$/);
  assert.match(await text('#rn-rdate-error'), /too long for a date/);
  await page.$eval('#rn-list', el => { el.value = 'MCMXCIV + 7\n'.repeat(90000); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.clock.runFor(300);
  assert.match(await text('#rn-list-error'), /^Only the first 1,000 lines are read\.$|^Only the first 100,000 characters are read\.$/);
  assert.ok((await threadMs()) - cpu < 2500, 'megabyte pastes are cut before any pattern runs');
  assert.equal(await page.$$eval('#rn-list-out tbody tr', rs => rs.length), 1000);

  // ---- Lists and sums ----
  await page.fill('#rn-list', 'MMXXVII\n1994\nXIV + IX\nMMXXVII − MCMXCIV\nX ÷ III\nC / IV\n3 × 4 + 1\nV - X\nIIX\nfoo\n');
  await page.clock.runFor(300);
  const listed = await page.$$eval('#rn-list-out tbody tr', rs => rs.map(r => [...r.cells].map(c => c.textContent)));
  assert.deepEqual(listed.map(r => r.slice(0, 3)), [
    ['MMXXVII', '2,027', 'MMXXVII'], ['1994', '1,994', 'MCMXCIV'], ['XIV + IX', '23', 'XXIII'], ['MMXXVII − MCMXCIV', '33', 'XXXIII'],
    ['X ÷ III', '3 r 1', 'III remainder I'], ['C / IV', '25', 'XXV'], ['3 × 4 + 1', '13', 'XIII'], ['V - X', '', ''], ['IIX', '8', 'VIII'], ['foo', '', ''],
  ]);
  assert.equal(listed[7][3], 'Not read: the result is -5, and Roman numerals start at 1.');
  assert.equal(listed[8][3], 'IIX read as 8');
  assert.equal(listed[9][3], 'Not read: “f” is not a Roman numeral. Use I, V, X, L, C, D and M.');
  assert.deepEqual(await page.$$eval('#rn-list-out tfoot td', ts => ts.map(t => t.textContent)), ['4,126', 'IV with a bar,CXXVI', '']);
  assert.equal(await text('#rn-list-error'), '2 lines could not be read; see the notes in the table.');
  await describedBy('#rn-list', 'rn-list-error');
  // Copy brings the table up to date first, even straight after typing.
  await page.fill('#rn-list', 'XL\nII');
  await page.click('#rn-list-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Line\tValue\tRoman numeral\nXL\t40\tXL\nII\t2\tII\nTotal\t42\tXLII');
  await valid('#rn-list');

  // ---- Dates ----
  await page.fill('#rn-date', '2027-04-14');
  assert.equal(await text('#rn-date-big'), 'XIV·IV·MMXXVII');
  assert.equal(await text('#rn-date-words'), `= ${E.weekdays['2027-04-14']} 14 April 2027`);
  assert.equal(await page.isHidden('#rn-date-note'), true, 'no warning when only one order makes sense');
  await page.selectOption('#rn-order', 'mdy');
  assert.equal(await text('#rn-date-big'), 'IV·XIV·MMXXVII');
  await page.selectOption('#rn-sep', 'slash');
  await page.selectOption('#rn-year', '2');
  assert.equal(await text('#rn-date-big'), 'IV/XIV/XXVII');
  await page.selectOption('#rn-order', 'ymd');
  await page.selectOption('#rn-sep', 'period');
  assert.equal(await text('#rn-date-big'), 'XXVII.IV.XIV');
  await page.selectOption('#rn-order', 'dmy');
  await page.selectOption('#rn-sep', 'dot');
  await page.selectOption('#rn-year', '4');
  await page.fill('#rn-date', '2027-05-04');
  assert.equal(await text('#rn-date-big'), 'IV·V·MMXXVII');
  assert.equal(await text('#rn-date-note'), 'Careful: read in the US order (month first), the same numerals mean 5 April 2027.');
  await page.click('#rn-date-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'IV·V·MMXXVII');
  await page.selectOption('#rn-year', '2');
  await page.fill('#rn-date', '2000-01-01');
  assert.equal(await text('#rn-date-big'), 'I·I·MM');
  assert.match(await text('#rn-date-note'), /The last two digits of 2000 are 00, which has no Roman numeral, so the whole year is shown\./);
  assert.equal(await text('#rn-date-words'), `= ${E.weekdays['2000-01-01']} 1 January 2000`);
  await page.selectOption('#rn-year', '4');
  await page.fill('#rn-date', '');
  assert.equal(await text('#rn-date-error'), 'Pick a date.');
  await describedBy('#rn-date', 'rn-date-error');
  await page.click('#rn-today');
  assert.equal(await page.inputValue('#rn-date'), '2026-11-24');
  assert.match(await text('#rn-date-words'), /\(today\)$/);
  await valid('#rn-date');
  // Reading a Roman date back, with a calendar check.
  const rdate = async v => { await page.fill('#rn-rdate', v); return [await text('#rn-rdate-out'), await text('#rn-rdate-error')]; };
  assert.deepEqual(await rdate('XIV·IV·MMXXVII'), [`XIV·IV·MMXXVII = ${E.weekdays['2027-04-14']} 14 April 2027.`, '']);
  assert.deepEqual(await rdate('xiv/iv/mmxxvii'), [`xiv/iv/mmxxvii = ${E.weekdays['2027-04-14']} 14 April 2027.`, '']);
  assert.deepEqual(await rdate('XXIX.II.MM'), [`XXIX.II.MM = Tuesday 29 February 2000.`, ''], 'a leap day');
  assert.deepEqual(await rdate('XXIX II MCM'), ['', `There is no 29 February 1900: February 1900 has ${E.feb_days['1900']} days.`]);
  await describedBy('#rn-rdate', 'rn-rdate-error');
  assert.deepEqual(await rdate('XXXI-II-MMXXVII'), ['', 'There is no 31 February 2027: February 2027 has 28 days.']);
  assert.deepEqual(await rdate('IV·XIV·MMXXVII'), ['', 'There is no month 14. Read in the US order it is Wednesday 14 April 2027; change Order above.']);
  assert.deepEqual(await rdate('XIV·IV·XXVII'), ['XIV·IV·XXVII = Wednesday 14 April 2027. The two-digit year 27 is read as 2027.', '']);
  assert.deepEqual(await rdate('XIV·IV·LXXX'), ['XIV·IV·LXXX = Monday 14 April 1980. The two-digit year 80 is read as 1980.', '']);
  assert.deepEqual(await rdate('XIV·IIII·MMXXVII'), ['XIV·IIII·MMXXVII = Wednesday 14 April 2027. Non-standard: IIII (4, standard IV).', '']);
  assert.deepEqual(await rdate('XIV·IV'), ['', 'A date needs three numerals, such as XIV·IV·MMXXVII; this has 2.']);
  await page.fill('#rn-rdate', '');
  await valid('#rn-rdate');

  // ---- Large numerals: outlines from the font, a bar over barred letters, PNG and SVG ----
  await page.fill('#rn-num', '1994');
  await page.locator('#rn-canvas').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => /^Preview of MCMXCIV in the Cinzel typeface\.$/.test(document.querySelector('#rn-canvas').getAttribute('aria-label')));
  const bands = () => page.evaluate(() => { // horizontal bands of ink, top to bottom, on the preview
    const c = document.querySelector('#rn-canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, rows = [];
    for (let y = 0; y < c.height; y++) {
      let ink = false;
      for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] < 128 && d[i + 3] > 128) { ink = true; break; } }
      rows.push(ink);
    }
    let n = 0;
    rows.forEach((r, i) => { if (r && !rows[i - 1]) n++; });
    return n;
  });
  assert.equal(await bands(), 1, 'MCMXCIV: one band of letters');
  await page.fill('#rn-num', '4500');
  await page.waitForFunction(() => /^Preview of I.V.D in the Cinzel typeface, with bars\.$/.test(document.querySelector('#rn-canvas').getAttribute('aria-label')));
  assert.equal(await bands(), 2, 'IV with a bar, D: the bar and the letters');
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.dblclick('#rn-svg');
  await page.waitForTimeout(300);
  assert.equal(downloads.length, 1, 'a double click saves one file');
  assert.equal(downloads[0].suggestedFilename(), 'roman--I-VD.svg');
  const svg = fs.readFileSync(await downloads[0].path(), 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[-\d. ]+" width="[\d.]+" height="[\d.]+">\n<rect [^>]*fill="#ffffff"\/>\n<path fill="#000000" d="M[^"]+"\/>\n<rect fill="#000000" [^>]+\/>\n<\/svg>\n$/);
  assert.ok(!/<text|font-family/.test(svg), 'the SVG has outlines, not text');
  const bar = /<rect fill="#000000" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)"/.exec(svg).slice(1).map(Number);
  const ys = [...svg.match(/ d="([^"]+)"/)[1].matchAll(/-?\d+\.?\d*/g)].map(m => Number(m[0])).filter((_, i) => i % 2 === 1);
  assert.ok(bar[1] < Math.min(...ys), 'the bar is above the letters');
  await page.clock.runFor(1500);
  await page.selectOption('#rn-ink', 'wb');
  await page.click('#rn-png');
  for (let i = 0; i < 50 && downloads.length < 2; i++) await page.waitForTimeout(100);
  assert.equal(downloads.length, 2);
  assert.equal(downloads[1].suggestedFilename(), 'roman--I-VD.png');
  const png = fs.readFileSync(await downloads[1].path());
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  const [pw, ph] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const vb = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg).slice(1).map(Number);
  assert.ok(Math.abs(pw / ph - vb[0] / vb[1]) < 0.01 && pw >= vb[0] * 2.9, `PNG ${pw}x${ph} has the SVG's shape, 3 times larger`);
  assert.equal(await page.evaluate(() => [...document.querySelector('#rn-canvas').getContext('2d').getImageData(0, 0, 1, 1).data].join()), '0,0,0,255', 'white on black');
  await page.check('input[name="rn-src"][value="d"]');
  await page.waitForFunction(() => /^Preview of XXIV·XI·MMXXVI in the Cinzel typeface\.$/.test(document.querySelector('#rn-canvas').getAttribute('aria-label')));

  // ---- The address keeps what was typed; a link brings it back ----
  await page.fill('#rn-rom', 'IIX');
  await page.selectOption('#rn-order', 'mdy');
  assert.match(await page.evaluate(() => location.hash), /^#r=IIX&d=2026-11-24&o=mdy&s=dot&y=4&v=d&k=wb$/);
  await page.reload();
  assert.equal(await page.inputValue('#rn-rom'), 'IIX');
  assert.equal(await page.inputValue('#rn-num'), '8');
  assert.match(await text('#rn-note'), /only one numeral is subtracted at a time/);
  assert.equal(await page.inputValue('#rn-order'), 'mdy');
  assert.equal(await page.isChecked('input[name="rn-src"][value="d"]'), true);
  // Back from another page: fields and results agree.
  await page.fill('#rn-num', '1994');
  await page.goto('about:blank');
  await page.goBack();
  assert.equal(await page.inputValue('#rn-num'), '1994');
  assert.equal(await page.inputValue('#rn-rom'), 'MCMXCIV');
  assert.equal(await text('#rn-big'), 'MCMXCIV');
  await page.goto('about:blank');
  await page.goto(url + '#n=' + '1'.repeat(2000));
  assert.equal(await text('#rn-num-error'), 'The link is too long to read, so the page starts with this year.');
  assert.equal(await page.inputValue('#rn-num'), '2026');

  // ---- A phone with touch: a number keypad, large text, no sideways scroll ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const tp = await phone.newPage();
  const errors = [];
  tp.on('pageerror', e => errors.push(e.message));
  await tp.goto(url);
  assert.equal(await tp.getAttribute('#rn-num', 'inputmode'), 'numeric');
  assert.equal(await tp.getAttribute('#rn-rom', 'autocapitalize'), 'characters');
  assert.equal(await tp.getAttribute('#rn-rom', 'autocorrect'), 'off');
  await tp.locator('#rn-num').tap();
  await tp.locator('#rn-num').fill('');
  await tp.keyboard.type('2027');
  assert.equal(await tp.inputValue('#rn-rom'), 'MMXXVII');
  for (const sel of ['#rn-num', '#rn-rom', '#rn-rdate', '#rn-list']) assert.ok(parseFloat(await tp.$eval(sel, el => getComputedStyle(el).fontSize)) >= 16, sel);
  assert.ok(await tp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await tp.locator('#rn-today').tap();
  assert.equal(await tp.inputValue('#rn-date'), await tp.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }));
  assert.deepEqual(errors, []);
  await phone.close();
};
