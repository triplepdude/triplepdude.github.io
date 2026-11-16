// Title case expectations follow the published rules of each style guide
// (Chicago 18th edition 8.160-8.162, AP composition titles, APA 7 title case, MLA 9).
// Unicode expectations were computed with Python's str.upper/lower/title/swapcase.
const fs = require('fs');

module.exports = async ({ page, open, assert }) => {
  await open();
  const out = () => page.inputValue('#cc-output');
  const setCase = v => page.check(`input[name="cc-case"][value="${v}"]`);
  const conv = async (text, c, style) => {
    if (c) await setCase(c);
    if (style) await page.selectOption('#cc-style', style);
    await page.fill('#cc-input', text);
    return out();
  };

  // Default: Title Case, Chicago style, with the other options hidden.
  assert.equal(await page.isChecked('input[name="cc-case"][value="title"]'), true);
  assert.equal(await page.inputValue('#cc-style'), 'chicago');
  assert.equal(await page.isVisible('#cc-ascii-wrap'), false);
  assert.equal(await out(), '');

  const title = {
    'gone with the wind': { chicago: 'Gone with the Wind', ap: 'Gone With the Wind', apa: 'Gone With the Wind', mla: 'Gone with the Wind' },
    // APA has no last-word rule; the others capitalize the last word.
    'what are you looking for?': { chicago: 'What Are You Looking For?', ap: 'What Are You Looking For?', apa: 'What Are You Looking for?', mla: 'What Are You Looking For?' },
    'the lord of the rings: the return of the king': {
      chicago: 'The Lord of the Rings: The Return of the King', ap: 'The Lord of the Rings: The Return of the King',
      apa: 'The Lord of the Rings: The Return of the King', mla: 'The Lord of the Rings: The Return of the King' },
    'a guide to state-of-the-art tools for self-report measures': {
      chicago: 'A Guide to State-of-the-Art Tools for Self-Report Measures', ap: 'A Guide to State-of-the-Art Tools for Self-Report Measures',
      apa: 'A Guide to State-of-the-Art Tools for Self-Report Measures', mla: 'A Guide to State-of-the-Art Tools for Self-Report Measures' },
    // Chicago's 18th edition (8.162) capitalizes the part after a prefix too;
    // the 17th kept it lowercase (Anti-inflammatory).
    'anti-inflammatory drugs for non-English speakers': {
      chicago: 'Anti-Inflammatory Drugs for Non-English Speakers', ap: 'Anti-Inflammatory Drugs for Non-English Speakers',
      apa: 'Anti-Inflammatory Drugs for Non-English Speakers', mla: 'Anti-Inflammatory Drugs for Non-English Speakers' },
    // Long prepositions: lowercase in MLA; capitalized in AP and APA (four
    // letters or more) and in Chicago since its 18th edition (five or more).
    'walking through the valley between two hills': {
      chicago: 'Walking Through the Valley Between Two Hills', ap: 'Walking Through the Valley Between Two Hills',
      apa: 'Walking Through the Valley Between Two Hills', mla: 'Walking through the Valley between Two Hills' },
    'a river runs through it': { chicago: 'A River Runs Through It', ap: 'A River Runs Through It', apa: 'A River Runs Through It', mla: 'A River Runs through It' },
    'much ado about nothing': { chicago: 'Much Ado About Nothing', ap: 'Much Ado About Nothing', apa: 'Much Ado About Nothing', mla: 'Much Ado about Nothing' },
    'once upon a time in the west': { chicago: 'Once upon a Time in the West', ap: 'Once Upon a Time in the West', apa: 'Once Upon a Time in the West', mla: 'Once upon a Time in the West' },
    // Regression: abbreviations typed in lower case were copied as if they
    // were file names (u.s. economy -> "u.s. Economy"). e.g., i.e., a.m. and
    // p.m. stay lowercase inside a title; t.co and x.ai are web addresses.
    'u.s. economy grows': { chicago: 'U.S. Economy Grows', ap: 'U.S. Economy Grows', apa: 'U.S. Economy Grows', mla: 'U.S. Economy Grows' },
    'life in the u.k. and the e.u.': {
      chicago: 'Life in the U.K. and the E.U.', ap: 'Life in the U.K. and the E.U.', apa: 'Life in the U.K. and the E.U.', mla: 'Life in the U.K. and the E.U.' },
    'w.e.b. du bois: a biography': {
      chicago: 'W.E.B. Du Bois: A Biography', ap: 'W.E.B. Du Bois: A Biography', apa: 'W.E.B. Du Bois: A Biography', mla: 'W.E.B. Du Bois: A Biography' },
    'u.s.-based firms hire ph.d. students': {
      chicago: 'U.S.-Based Firms Hire Ph.D. Students', ap: 'U.S.-Based Firms Hire Ph.D. Students',
      apa: 'U.S.-Based Firms Hire Ph.D. Students', mla: 'U.S.-Based Firms Hire Ph.D. Students' },
    'an ed.d. or m.ed. degree': { chicago: 'An Ed.D. or M.Ed. Degree', ap: 'An Ed.D. or M.Ed. Degree', apa: 'An Ed.D. or M.Ed. Degree', mla: 'An Ed.D. or M.Ed. Degree' },
    // The possessive too (gave "The U.k.'s Plan").
    "the u.k.'s plan for growth": {
      chicago: "The U.K.'s Plan for Growth", ap: "The U.K.'s Plan for Growth", apa: "The U.K.'s Plan for Growth", mla: "The U.K.'s Plan for Growth" },
    'the a.m. show at 5 p.m.': { chicago: 'The a.m. Show at 5 p.m.', ap: 'The a.m. Show at 5 p.m.', apa: 'The a.m. Show at 5 p.m.', mla: 'The a.m. Show at 5 p.m.' },
    'e.g. links on t.co and x.ai': {
      chicago: 'E.g. Links on t.co and x.ai', ap: 'E.g. Links on t.co and x.ai', apa: 'E.g. Links on t.co and x.ai', mla: 'E.g. Links on t.co and x.ai' },
    // Chicago lowercases only and, but, for, or, nor; AP, APA and MLA also yet and so.
    'small yet mighty, so what is it': {
      chicago: 'Small Yet Mighty, So What Is It', ap: 'Small yet Mighty, so What Is It',
      apa: 'Small yet Mighty, so What Is It', mla: 'Small yet Mighty, so What Is It' },
    'coffee—the drink of champions': {
      chicago: 'Coffee—The Drink of Champions', ap: 'Coffee—The Drink of Champions', apa: 'Coffee—The Drink of Champions', mla: 'Coffee—The Drink of Champions' },
    'part one - a new hope as told by an old man': {
      chicago: 'Part One - A New Hope as Told by an Old Man', ap: 'Part One - A New Hope as Told by an Old Man',
      apa: 'Part One - A New Hope as Told by an Old Man', mla: 'Part One - A New Hope as Told by an Old Man' },
    // Regressions: Chicago gave "A-list" when it still had a prefix rule; a
    // number before a full stop is not an initial, so the next word starts a
    // new phrase; versus is a preposition of six letters, so only MLA keeps it
    // lowercase, while vs. stays lowercase in all four.
    'a-list celebrities': { chicago: 'A-List Celebrities', ap: 'A-List Celebrities', apa: 'A-List Celebrities', mla: 'A-List Celebrities' },
    'chapter 1. the beginning': { chicago: 'Chapter 1. The Beginning', ap: 'Chapter 1. The Beginning', apa: 'Chapter 1. The Beginning', mla: 'Chapter 1. The Beginning' },
    'batman vs. superman versus the world': {
      chicago: 'Batman vs. Superman Versus the World', ap: 'Batman vs. Superman Versus the World',
      apa: 'Batman vs. Superman Versus the World', mla: 'Batman vs. Superman versus the World' },
  };
  for (const [input, byStyle] of Object.entries(title)) {
    for (const [style, expected] of Object.entries(byStyle)) {
      assert.equal(await conv(input, 'title', style), expected, `${style}: ${input}`);
    }
  }
  await page.selectOption('#cc-style', 'chicago');
  await page.fill('#cc-input', 'gone with the wind');
  assert.equal(await page.textContent('#cc-explain'), 'Chicago style keeps these words lowercase here: with, the.');

  // Acronyms and brand names, all-caps input, verbatim web addresses, lines.
  assert.equal(await conv('NASA launches new iPhone app'), 'NASA Launches New iPhone App');
  await page.uncheck('#cc-keep');
  assert.equal(await out(), 'Nasa Launches New Iphone App');
  await page.check('#cc-keep');
  assert.equal(await conv('THE LORD OF THE RINGS'), 'The Lord of the Rings');
  assert.equal(await conv('how to use example.com and node.js today'), 'How to Use example.com and node.js Today');
  assert.equal(await conv("one\ntwo of three\n\ndon't stop"), "One\nTwo of Three\n\nDon't Stop");
  assert.equal(await conv('ǆungla and ßa'), 'ǅungla and Ssa');

  // Sentence case.
  const sentence = "the QUICK brown fox. it jumps! does it? yes, i'm sure. see fig. 2 and NASA.";
  assert.equal(await conv(sentence, 'sentence'), "The QUICK brown fox. It jumps! Does it? Yes, I'm sure. See fig. 2 and NASA.");
  await page.uncheck('#cc-keep');
  assert.equal(await out(), "The quick brown fox. It jumps! Does it? Yes, I'm sure. See fig. 2 and nasa.");
  await page.check('#cc-keep');
  assert.equal(await conv('HELLO WORLD. THIS IS NASA.'), 'Hello world. This is nasa.');
  assert.equal(await conv('ask dr. smith, e.g. by mail. so am i. then go'), 'Ask dr. smith, e.g. by mail. So am I. Then go');
  assert.equal(await conv('first line\nsecond line'), 'First line\nSecond line');
  // Regressions: a full stop after a web address or a number ends the
  // sentence; one after e.g. or an initial does not.
  assert.equal(await conv('visit example.com. then leave'), 'Visit example.com. Then leave');
  assert.equal(await conv('item 1. second thing. it costs 3.5. then more'), 'Item 1. Second thing. It costs 3.5. Then more');
  assert.equal(await conv('see e.g. this one, or ask j. smith'), 'See e.g. this one, or ask j. smith');
  // Regression: an abbreviation typed in lower case kept its small letter at
  // the start of a sentence ("u.s. economy grows").
  assert.equal(await conv('u.s. economy grows. the u.k. too. e.g. this. ph.d. students'),
    'U.S. economy grows. The u.k. too. E.g. this. Ph.D. students');
  assert.equal(await conv('u.s.-based firms. at 5 p.m. we left'), 'U.S.-based firms. At 5 p.m. we left');
  assert.equal(await conv("a.i. and j.k. rowling's ph.d. at 5 p.m.", 'capital'), "A.I. And J.K. Rowling's Ph.D. At 5 P.M.");
  assert.equal(await conv('the U.S. and x.ai', 'capital'), 'The U.S. And x.ai');
  // A possessive stays with its abbreviation (Capitalize Each Word gave "U.K.'S").
  assert.equal(await conv("the u.k.’s plan", 'capital'), 'The U.K.’s Plan');
  assert.equal(await conv("u.k.'s plan. the u.s.'s too", 'sentence'), "U.K.'s plan. The u.s.'s too");
  // Regression: a kept brand name at the start of a sentence or in
  // Capitalize Each Word was capitalized ("IPhone").
  assert.equal(await conv('iPhone sales rise. eBay falls', 'sentence'), 'iPhone sales rise. eBay falls');
  assert.equal(await conv('iPhone sales rise', 'capital'), 'iPhone Sales Rise');
  await page.uncheck('#cc-keep');
  assert.equal(await out(), 'Iphone Sales Rise');
  await page.check('#cc-keep');
  await setCase('sentence');
  // Paths are left as typed too.
  assert.equal(await conv('run /usr/bin/env or ~/bin/tool', 'title'), 'Run /usr/bin/env or ~/bin/tool');
  await setCase('sentence');

  // Capitalize Each Word, upper, lower, alternating, inverse.
  assert.equal(await conv("the e-mail from o'brien", 'capital'), "The E-Mail From O'brien");
  assert.equal(await conv('Straße', 'upper'), 'STRASSE');
  assert.equal(await page.isVisible('#cc-eszett-wrap'), true);
  await page.check('#cc-eszett');
  assert.equal(await out(), 'STRAẞE');
  await page.uncheck('#cc-eszett');
  assert.equal(await conv('ΟΔΥΣΣΕΥΣ ΚΑΙ ΣΥ', 'lower'), 'οδυσσευς και συ');
  assert.equal(await conv('İ', 'lower'), 'i̇');
  assert.equal(await conv('hello world', 'alternating'), 'hElLo WoRlD');
  assert.equal(await conv('Hello World ß', 'inverse'), 'hELLO wORLD SS');
  // Regression: letter-by-letter conversion lost the word-final sigma
  // (Python: 'ΣΑΣ ΣΑΣ. ΑΣ-Β ΣΑ'.swapcase() == 'σας σας. ας-β σα').
  assert.equal(await conv('ΣΑΣ ΣΑΣ. ΑΣ-Β ΣΑ', 'inverse'), 'σας σας. ας-β σα');
  assert.equal(await conv('ΣΑΣ', 'alternating'), 'σΑς');

  // Turkish and Azerbaijani letter rules.
  await page.selectOption('#cc-lang', 'tr');
  assert.equal(await conv('istanbul ılık', 'upper'), 'İSTANBUL ILIK');
  assert.equal(await conv('İSTANBUL ILIK', 'lower'), 'istanbul ılık');
  assert.equal(await conv('istanbul', 'title'), 'İstanbul');
  await page.selectOption('#cc-lang', 'std');
  assert.equal(await conv('istanbul ılık', 'upper'), 'ISTANBUL ILIK');

  // Programming cases (the table in the guide).
  const code = { camel: 'userLoginCount', pascal: 'UserLoginCount', snake: 'user_login_count', kebab: 'user-login-count', constant: 'USER_LOGIN_COUNT', dot: 'user.login.count' };
  for (const [c, expected] of Object.entries(code)) assert.equal(await conv('user login count', c), expected, c);
  const xml = { camel: 'xmlHttpRequestHandler', pascal: 'XMLHttpRequestHandler', snake: 'xml_http_request_handler', kebab: 'xml-http-request-handler', constant: 'XML_HTTP_REQUEST_HANDLER', dot: 'xml.http.request.handler' };
  for (const [c, expected] of Object.entries(xml)) assert.equal(await conv('XMLHttpRequest handler', c), expected, c);
  await setCase('pascal');
  await page.uncheck('#cc-keep');
  assert.equal(await out(), 'XmlHttpRequestHandler');
  await page.check('#cc-keep');
  assert.equal(await conv("Don't stop-believing, version2Beta", 'snake'), 'dont_stop_believing_version2_beta');
  assert.equal(await conv('HTML5 parser for iPhone12Pro', 'kebab'), 'html5-parser-for-i-phone12-pro');
  assert.equal(await conv('USER ID', 'camel'), 'userId');
  assert.equal(await conv('first name\nlast name', 'camel'), 'firstName\nlastName');
  assert.equal(await conv('Crème brûlée à la Straße', 'snake'), 'crème_brûlée_à_la_straße');
  await page.check('#cc-ascii');
  assert.equal(await out(), 'creme_brulee_a_la_strasse');
  await page.uncheck('#cc-ascii');
  assert.equal(await conv('  ---  ', 'snake'), '');

  // Regressions: long runs of punctuation made the edge-trimming regexes
  // backtrack quadratically (1.5 s for 50,000 characters), and camelCase
  // copied its word list once per word (1.5 s for 200,000 characters).
  const timed = async (t, c) => {
    await setCase(c);
    await page.evaluate(v => { document.querySelector('#cc-input').value = v; }, t);
    return page.evaluate(() => {
      const a = performance.now();
      document.querySelector('#cc-style').dispatchEvent(new Event('change')); // converts at once
      return performance.now() - a;
    });
  };
  for (const t of ['!'.repeat(50000) + 'a', 'a' + '!'.repeat(50000) + 'a', 'a@' + '.'.repeat(50000) + '@', 'a.'.repeat(25000) + 'b!c']) {
    for (const c of ['title', 'sentence', 'capital']) {
      const ms = await timed(t, c);
      assert.ok(ms < 250, `${c} on ${t.slice(0, 3)}…: ${Math.round(ms)} ms`);
    }
  }
  const prose = 'the quick brown fox of the day '.repeat(7000);
  for (const c of ['camel', 'pascal', 'snake', 'title', 'sentence']) {
    const ms = await timed(prose, c);
    assert.ok(ms < 400, `${c} on 217,000 characters: ${Math.round(ms)} ms`);
  }
  await setCase('camel');
  assert.ok((await out()).startsWith('theQuickBrownFoxOfTheDayTheQuick'));

  // Radio group works with arrow keys, and the change is announced.
  await setCase('title');
  await page.focus('input[name="cc-case"][value="title"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.isChecked('input[name="cc-case"][value="capital"]'), true);
  await page.waitForFunction(() => document.querySelector('#cc-status').textContent === 'Converted to Capitalize Each Word');

  // Download, use as input, clear.
  await setCase('title');
  await page.fill('#cc-input', 'the art of war');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cc-download')]);
  assert.equal(dl.suggestedFilename(), 'title-case.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), 'The Art of War');
  await setCase('upper');
  await page.click('#cc-use');
  assert.equal(await page.inputValue('#cc-input'), 'THE ART OF WAR');
  await page.click('#cc-clear');
  assert.equal(await page.inputValue('#cc-input'), '');
  assert.equal(await out(), '');
  assert.equal(await page.isDisabled('#cc-download'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cc-input');
};
