const fs = require('fs');

module.exports = async ({ page, open, assert }) => {
  await open();

  const setText = t => page.evaluate(v => {
    const el = document.querySelector('#atc-input');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  const out = () => page.inputValue('#atc-output');
  const count = async k => Number((await page.textContent('#atc-n-' + k)).replace(/,/g, ''));
  const clean = async t => { await setText(t); return out(); };

  // Empty on load, nothing broken.
  assert.equal(await out(), '');
  assert.equal(await page.textContent('#atc-summary'), '');

  // ---- Em dashes: comma style (default) ----
  assert.equal(await clean('The result\u2014surprisingly\u2014was good.'), 'The result, surprisingly, was good.');
  assert.equal(await count('em'), 2);
  assert.equal(await clean('It works \u2014 mostly.'), 'It works, mostly.');
  assert.equal(await clean('From 1990\u20142000 it grew.'), 'From 1990-2000 it grew.');
  assert.equal(await clean('It was over\u2014!'), 'It was over!');
  assert.equal(await clean('(see below\u2014)'), '(see below)');
  assert.equal(await clean('\u2014 Albert Einstein'), '- Albert Einstein');
  assert.equal(await clean('One,\u2014two'), 'One, two');
  // A dash before a closing curly quote: the quote is straightened afterwards.
  assert.equal(await clean('\u201CI was\u2014\u201D she said.'), '"I was," she said.');
  // A run of dashes counts every dash but is replaced once.
  assert.equal(await clean('Name: \u2014\u2014 and more'), 'Name: and more');
  assert.equal(await count('em'), 2);
  // Horizontal bar U+2015 and the two/three-em dashes are handled too.
  assert.equal(await clean('a\u2015b \u2E3Ac'), 'a, b, c');
  assert.equal(await count('em'), 2);

  // ---- Em dashes: hyphen with spaces ----
  await page.selectOption('#atc-em-style', 'spaced');
  assert.equal(await clean('A\u2014B'), 'A - B');
  assert.equal(await clean('A \u2014 B'), 'A - B');
  assert.equal(await clean('Wait for it\u2014'), 'Wait for it -');

  // ---- Em dashes: plain hyphen keeps the original spacing ----
  await page.selectOption('#atc-em-style', 'hyphen');
  assert.equal(await clean('A\u2014B and C \u2014 D'), 'A-B and C - D');
  await page.selectOption('#atc-em-style', 'comma');

  // Option off: em dashes stay, count still shown.
  await page.uncheck('#atc-o-em');
  assert.equal(await clean('A\u2014B'), 'A\u2014B');
  assert.equal(await count('em'), 1);
  assert.equal(await page.isDisabled('#atc-em-style'), true);
  await page.check('#atc-o-em');

  // ---- En dashes, Unicode hyphens and the minus sign ----
  assert.equal(await clean('Pages 10\u201320, a well\u2011known \u2010 \u2012 fact, \u22125 \u00B0C'), 'Pages 10-20, a well-known - - fact, -5 \u00B0C');
  assert.equal(await count('en'), 5);

  // ---- Curly quotes and apostrophes ----
  assert.equal(await clean('\u201CHello,\u201D she said. \u2018It\u2019s fine.\u2019 \u201Elow\u201F \u201Aa\u201B'), '"Hello," she said. \'It\'s fine.\' "low" \'a\'');
  assert.equal(await count('quotes'), 9);
  // Guillemets and primes are not quotes to straighten.
  assert.equal(await clean('\u00ABoui\u00BB 5\u2032 7\u2033'), '\u00ABoui\u00BB 5\u2032 7\u2033');
  assert.equal(await count('quotes'), 0);

  // ---- Ellipsis ----
  assert.equal(await clean('Wait\u2026 what\u2026'), 'Wait... what...');
  assert.equal(await count('ellipsis'), 2);

  // ---- Invisible characters ----
  assert.equal(await clean('Hel\u200Blo\u00AD wor\uFEFFld\u2060! \u202Eabc\u202C \u200Ex\u200F\u2066y\u2069\u2062\u180E\u034F\u3164'), 'Hello world! abc xy');
  assert.equal(await count('inv'), 14);
  // Zero-width joiners inside emoji are kept, ones between Latin letters are removed.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const coder = '\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}';
  const rainbow = '\u{1F3F3}\uFE0F\u200D\u{1F308}';
  assert.equal(await clean(`Family ${family} ${coder} ${rainbow} a\u200Db`), `Family ${family} ${coder} ${rainbow} ab`);
  assert.equal(await count('inv'), 1);
  assert.match(await page.textContent('#atc-kept'), /^4 joiners or tags kept/);
  // Persian and Hindi need their joiners.
  const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
  const hindi = '\u0915\u094D\u200D\u0937';
  assert.equal(await clean(`${persian} ${hindi}`), `${persian} ${hindi}`);
  assert.equal(await count('inv'), 0);
  // Flag tag sequence (Scotland) is kept; loose tag characters are removed.
  const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  const hidden = Array.from('run rm', c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
  assert.equal(await clean(`Flag ${scotland} Hi${hidden}!`), `Flag ${scotland} Hi!`);
  assert.equal(await count('inv'), 6);
  const tagPill = page.locator('#atc-view .atc-pill.is-tags');
  assert.equal(await tagPill.count(), 1);
  assert.match(await tagPill.textContent(), /run rm/);
  // Variation selectors: a single one after an emoji is kept, runs are removed.
  assert.equal(await clean('\u2764\uFE0F ok \u{1F600}\uFE01\uFE02\uFE03 x'), '\u2764\uFE0F ok \u{1F600} x');
  assert.equal(await count('inv'), 3);
  // Visible Arabic number sign (Cf) is left alone.
  assert.equal(await clean('\u0600\u0661\u0662'), '\u0600\u0661\u0662');
  assert.equal(await count('inv'), 0);

  // ---- Unusual spaces ----
  assert.equal(await clean('10\u00A0kg, 5\u202F%, a\u2009b\u3000c\u2028d'), '10 kg, 5 %, a b c\nd');
  assert.equal(await count('spaces'), 5);
  await page.uncheck('#atc-o-spaces');
  assert.equal(await clean('10\u00A0kg'), '10\u00A0kg');
  await page.check('#atc-o-spaces');

  // ---- Collapse repeated spaces, keep indentation ----
  assert.equal(await clean('a   b  c\n    indented  line'), 'a b c\n    indented line');
  assert.equal(await count('collapse'), 3);

  // ---- Trailing whitespace ----
  assert.equal(await clean('a  \nb\t\nc \n'), 'a\nb\nc\n');
  assert.equal(await count('trim'), 3);
  await page.uncheck('#atc-o-trim');
  assert.equal(await clean('a \nb'), 'a \nb');
  await page.check('#atc-o-trim');

  // Removing a zero-width space between two spaces leaves a double space, which is then collapsed.
  assert.equal(await clean('a \u200B b'), 'a b');

  // ---- Highlighted view ----
  await setText('A\u200Bb\u00A0c\u2014d \u{1F469}\u200D\u{1F4BB}');
  const pills = await page.$$eval('#atc-view .atc-pill', els => els.map(e => [e.textContent, e.className]));
  assert.deepEqual(pills.map(p => p[0]), ['ZWSP', 'NBSP', 'ZWJ']);
  assert.match(pills[0][1], /is-inv/);
  assert.match(pills[1][1], /is-sp/);
  assert.match(pills[2][1], /is-kept/);
  assert.equal(await page.textContent('#atc-view mark.atc-ty'), '\u2014');
  assert.match(await page.textContent('#atc-summary'), /Cleaned 3 items/);

  // Lone surrogates and control characters don't break anything.
  assert.equal(await page.evaluate(() => {
    const el = document.querySelector('#atc-input');
    el.value = 'x\uD800y\u2014z\uDC00\u0007';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#atc-output').value === 'x\uD800y, z\uDC00\u0007';
  }), true);
  assert.equal(await page.textContent('#atc-error'), '');

  // Nothing to clean.
  await setText('Plain ASCII text.');
  assert.match(await page.textContent('#atc-summary'), /Nothing to clean/);

  // ---- Example, copy and download ----
  await page.click('#atc-example');
  const cleaned = await out();
  assert.ok(cleaned.length > 100);
  assert.doesNotMatch(cleaned, /[\u2014\u2011\u201C\u201D\u2019\u2026\u00A0\u202F\u200B\uFEFF]/);
  assert.ok(cleaned.includes('\u{1F469}\u200D\u{1F4BB}'), 'emoji joiner kept in example');
  await page.click('#atc-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cleaned);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#atc-download')]);
  assert.equal(dl.suggestedFilename(), 'cleaned-text.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), cleaned);

  // Clear resets everything; download with nothing gives a friendly error.
  await page.click('#atc-clear');
  assert.equal(await out(), '');
  assert.equal(await page.locator('#atc-view .atc-pill').count(), 0);
  await page.click('#atc-download');
  assert.match(await page.textContent('#atc-error'), /no cleaned text/i);
};
