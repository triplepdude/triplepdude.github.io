const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected answers come from tests/fixtures/percentage-calculator/expected.py, which works
// every case out with Python's fractions.Fraction and writes it the way the guide describes
// (expected.json is its output). The other values here are worked out by hand in the comments.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await open();
  const text = sel => page.textContent(sel);
  const attr = (sel, name) => page.getAttribute(sel, name);
  const steps = id => page.$$eval(`#pc-${id}-steps li`, els => els.map(e => e.textContent));
  const set = async (id, a, b, op) => {
    await page.fill(`#pc-${id}-a`, a);
    await page.fill(`#pc-${id}-b`, b);
    if (op) await page.selectOption(`#pc-${id}-op`, op);
  };
  const leave = sel => page.locator(sel).press('Tab');
  const IDS = ['of', 'what', 'change', 'add', 'diff', 'whole', 'orig'];

  // ---- The page opens with a worked example in every calculator. ----
  assert.equal(await text('#pc-of-answer'), '15% of 80 = 12');
  assert.deepEqual(await steps('of'), ['15 ÷ 100 = 0.15', '0.15 × 80 = 12']);
  assert.equal(await text('#pc-of-formula'), 'X ÷ 100 × Y');
  assert.equal(await text('#pc-what-answer'), '12 is 15% of 80');
  assert.equal(await text('#pc-change-answer'), 'From 80 to 100: 25% increase');
  assert.deepEqual(await steps('change'), ['100 − 80 = 20', '20 ÷ 80 = 0.25', '0.25 × 100 = 25%']);
  assert.equal(await text('#pc-add-answer'), '80 + 15% = 92');
  // 20 / 90 = 0.2222...: a value that never ends is rounded to 6 places and marked.
  assert.equal(await text('#pc-diff-answer'), '80 and 100 differ by about 22.222222%');
  assert.deepEqual(await steps('diff'), ['|80 − 100| = 20', '(80 + 100) ÷ 2 = 90', '20 ÷ 90 × 100 ≈ 22.222222%']);
  assert.equal(await text('#pc-whole-answer'), '12 is 15% of 80');
  assert.equal(await text('#pc-orig-answer'), '92 is 15% more than 80');
  assert.deepEqual(await steps('orig'), ['1 + 15 ÷ 100 = 1.15', '92 ÷ 1.15 = 80', 'The change itself: 92 − 80 = 12']);
  // The answer itself is marked up, not only coloured.
  assert.equal(await page.$eval('#pc-of-answer b', b => getComputedStyle(b).fontWeight >= 600), true);
  for (const id of IDS) assert.equal(await page.isVisible(`#pc-${id}-work`), true, id);

  // ---- Every case of the Python reference: answer, the part in bold, formula and steps. ----
  let dp = 'auto';
  for (const c of expected) {
    if (c.dp !== dp) { await page.selectOption('#pc-dp', c.dp); dp = c.dp; }
    await set(c.calc, c.a, c.b, c.op);
    const label = `${c.calc}(${c.a}, ${c.b}${c.op ? ', ' + c.op : ''}) rounded to ${c.dp}`;
    assert.equal(await text(`#pc-${c.calc}-answer`), c.answer, label);
    assert.equal(await text(`#pc-${c.calc}-answer b`), c.value, label);
    assert.equal(await text(`#pc-${c.calc}-formula`), c.formula, label);
    assert.deepEqual(await steps(c.calc), c.steps, label);
    assert.equal(await text(`#pc-${c.calc}-msg`), '', label);
  }
  await page.selectOption('#pc-dp', 'auto');

  // ---- Exact decimal arithmetic. In floating point 0.1 + 0.2 is 0.30000000000000004,
  // 1.005 rounds to 1.00 and 2.675 to 2.67; done by hand they are 0.3, 1.01 and 2.68. ----
  await set('add', '0.1', '200', 'add');
  assert.equal(await text('#pc-add-answer'), '0.1 + 200% = 0.3');
  await set('of', '0.1', '0.2');
  assert.equal(await text('#pc-of-answer'), '0.1% of 0.2 = 0.0002');
  await page.selectOption('#pc-dp', '2');
  await set('add', '1.005', '0', 'add');
  assert.equal(await text('#pc-add-answer b'), '1.01');
  await set('add', '2.675', '0', 'sub');
  assert.equal(await text('#pc-add-answer b'), '2.68');
  // Halves round away from zero: 2.5 -> 3 and -2.5 -> -3.
  await page.selectOption('#pc-dp', '0');
  await set('of', '50', '5');
  assert.equal(await text('#pc-of-answer'), '50% of 5 ≈ 3');
  await set('of', '50', '-5');
  assert.equal(await text('#pc-of-answer'), '50% of -5 ≈ -3');
  // Changing the rounding redraws every calculator at once; fixed places keep their zeros.
  await set('diff', '0', '10');
  assert.equal(await text('#pc-diff-answer'), '0 and 10 differ by 200%');
  await page.selectOption('#pc-dp', '2');
  assert.equal(await text('#pc-diff-answer'), '0 and 10 differ by 200.00%');
  assert.equal(await text('#pc-of-answer'), '50% of -5 = -2.50');
  await set('diff', '80', '100');
  assert.equal(await text('#pc-diff-answer'), '80 and 100 differ by about 22.22%');
  await page.selectOption('#pc-dp', 'auto');
  // Statements made in the guide and the FAQ.
  await set('add', '92', '15', 'sub');
  assert.equal(await text('#pc-add-answer'), '92 − 15% = 78.2');
  await set('of', '8', '50');
  assert.equal(await text('#pc-of-answer b'), '4');
  await set('of', '50', '8');
  assert.equal(await text('#pc-of-answer b'), '4');
  await set('add', '100', '50', 'add');
  assert.equal(await text('#pc-add-answer b'), '150');
  await set('add', '150', '50', 'sub');
  assert.equal(await text('#pc-add-answer b'), '75');
  // A value that ends after more than 12 places is rounded: 1 / 2^20 = 0.00000095367431640625.
  await set('whole', '1', '104857600');
  assert.equal(await text('#pc-whole-answer'), '1 is 104,857,600% of about 0.000000953674');

  // ---- Numbers as people type and paste them. 100% of N echoes N as it was read. ----
  await page.fill('#pc-of-a', '100');
  const nnbsp = String.fromCharCode(0x202F), nbsp = String.fromCharCode(0xA0);
  const READS = [
    ['1,250.50', '1,250.5'], ['1.250,50', '1,250.5'], ['1 250,5', '1,250.5'], [`1${nnbsp}250,5`, '1,250.5'], [`1${nbsp}250.5`, '1,250.5'],
    ["1'250.5", '1,250.5'], ['$1,250.50', '1,250.5'], ['€ 1.250,50', '1,250.5'], ['1250,5', '1,250.5'], ['1250.50 €', '1,250.5'],
    ['1,234', '1,234'], ['1,234,567', '1,234,567'], ['1.234.567', '1,234,567'], ['88,5', '88.5'], ['0,5', '0.5'], ['15%', '15'], ['15 %', '15'],
    ['−3', '-3'], ['-3', '-3'], ['-$3', '-3'], ['$-3', '-3'], ['+7', '7'], ['１２．５', '12.5'], ['٣٫٥', '3.5'], ['۱۲', '12'],
    ['2.5e3', '2,500'], ['1E-3', '0.001'], ['.5', '0.5'], ['5.', '5'], ['007', '7'], ['-0', '0'], ['  42  ', '42'], ['0.50', '0.5'],
    ['999999999999999999999999999999', '999,999,999,999,999,999,999,999,999,999'], ['0.00000000000000000001', '0.00000000000000000001'],
    // A thousands group never starts with 0, so "0,500" is a half and not five hundred.
    ['0,500', '0.5'], ['0,125', '0.125'], ['-0,250', '-0.25'], ['0,5000', '0.5'],
    // Arabic-Indic digits with their own thousands and decimal separators (U+066C, U+066B).
    ['\u0661\u066C\u0662\u0663\u0664', '1,234'], ['\u0661\u066C\u0662\u0663\u0664\u066B\u0665', '1,234.5'],
  ];
  for (const [typed, read] of READS) {
    await page.fill('#pc-of-b', typed);
    assert.equal(await text('#pc-of-answer'), `100% of ${read} = ${read}`, JSON.stringify(typed));
  }
  // Things that are not one number are refused, and what was typed stays in the box.
  // A raised or lowered digit is not read as a digit (5 squared is not 52), a tab sits between
  // two pasted spreadsheet cells, and a group of thousands cannot start with 0.
  const ODD = ['5\u00B2', '10\u00B3', '1\u2082', '2\u2075', '1\t250', '0 500', '0.500.000', '0,500,000'];
  for (const junk of ['abc', '1 2', '--5', '+-5', '5-', '1.2.3', '1,2,3', '$', '%', '-', '.', '12abc', 'NaN', 'Infinity', '0x10', '(5)', '1e', 'e3', '1/2', '5 5%5', ...ODD]) {
    await page.fill('#pc-of-b', junk);
    await leave('#pc-of-b');
    assert.equal(await text('#pc-of-msg'), 'Number (Y) must be a number, such as 12.5 or 1,250.', JSON.stringify(junk));
    assert.equal(await attr('#pc-of-b', 'aria-invalid'), 'true', JSON.stringify(junk));
    assert.equal(await attr('#pc-of-a', 'aria-invalid'), null);
    assert.equal(await text('#pc-of-answer'), '–');
    assert.equal(await page.isVisible('#pc-of-work'), false);
    assert.equal(await page.inputValue('#pc-of-b'), junk);
  }
  // 31 digits before the point, or 21 after it, is one too many.
  for (const long of ['1000000000000000000000000000000', '0.000000000000000000001', '1e31', '9'.repeat(5000)]) {
    await page.fill('#pc-of-b', long);
    await leave('#pc-of-b');
    assert.equal(await text('#pc-of-msg'), 'Number (Y) is too long. Use at most 30 digits before the decimal point and 20 after it.', long.slice(0, 40));
    assert.equal(await attr('#pc-of-b', 'aria-invalid'), 'true');
  }
  // A huge paste is answered at once, whatever is in it: a long run of spaces between other
  // characters used to keep the page busy for seconds.
  for (const [pasted, message] of [['a' + ' '.repeat(40000) + 'a', 'must be a number'], ['1' + ' '.repeat(40000) + '1', 'is too long'], ['lorem ipsum '.repeat(90000), 'must be a number'], ['9'.repeat(1 << 20), 'is too long']]) {
    const took = await page.evaluate(v => {
      const el = document.querySelector('#pc-of-b'), t0 = performance.now();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return performance.now() - t0;
    }, pasted);
    assert.ok((await text('#pc-of-msg')).includes(message), `${pasted.length} characters: ${await text('#pc-of-msg')}`);
    assert.ok(took < 400, `a paste of ${pasted.length} characters took ${Math.round(took)} ms`);
  }
  // Putting it right clears the message at once.
  await page.fill('#pc-of-b', '80');
  assert.equal(await text('#pc-of-msg'), '');
  assert.equal(await attr('#pc-of-b', 'aria-invalid'), null);
  assert.equal(await text('#pc-of-answer'), '100% of 80 = 80');
  await page.fill('#pc-of-a', '15');

  // ---- Errors. Every box points at its calculator's message. ----
  for (const id of IDS) {
    for (const f of ['a', 'b']) assert.equal(await attr(`#pc-${id}-${f}`, 'aria-describedby'), `pc-${id}-msg`);
    assert.equal(await page.$eval(`#pc-${id}-msg`, e => e.classList.contains('msg') && e.classList.contains('error')), true);
  }
  const refuses = async (id, a, b, op, field, message) => {
    await set(id, a, b, op);
    await leave(`#pc-${id}-b`);
    assert.equal(await text(`#pc-${id}-msg`), message);
    assert.equal(await attr(`#pc-${id}-${field}`, 'aria-invalid'), 'true');
    assert.equal(await attr(`#pc-${id}-${field === 'a' ? 'b' : 'a'}`, 'aria-invalid'), null);
    assert.equal(await text(`#pc-${id}-answer`), '–');
    assert.equal(await page.isVisible(`#pc-${id}-work`), false);
  };
  await refuses('what', '12', '0', '', 'b', 'The whole (Y) cannot be 0, because nothing can be divided by 0.');
  await refuses('change', '0', '50', '', 'a', 'A change from 0 cannot be written as a percentage, because it would mean dividing by 0.');
  await refuses('diff', '0', '0.0', '', 'a', 'Both values are 0, so there is no percentage difference to work out.');
  await refuses('whole', '12', '0', '', 'b', '0% of any number is 0, so the whole cannot be found. Enter a percentage other than 0.');
  await refuses('orig', '50', '100', 'dec', 'b', 'A fall of 100% turns every number into 0, so the value before it cannot be found.');
  await refuses('orig', '50', '-100', 'inc', 'b', 'A fall of 100% turns every number into 0, so the value before it cannot be found.');
  // The other calculators are untouched by one calculator's error.
  assert.equal(await text('#pc-add-msg'), '');
  assert.equal(await text('#pc-of-answer'), '15% of 80 = 12');
  // A new mistake is not flagged in the middle of typing, only once typing pauses...
  await set('what', '12', '80');
  assert.equal(await text('#pc-what-msg'), '');
  assert.equal(await page.evaluate(() => {
    const el = document.querySelector('#pc-what-b');
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#pc-what-msg').textContent + '|' + el.getAttribute('aria-invalid') + '|' + document.querySelector('#pc-what-answer').textContent;
  }), '|null|–');
  await page.waitForFunction(() => /cannot be 0/.test(document.querySelector('#pc-what-msg').textContent), null, { timeout: 3000 });
  assert.equal(await attr('#pc-what-b', 'aria-invalid'), 'true');
  // ...and the error is announced once in the status line.
  await page.waitForFunction(() => document.querySelector('#pc-status').textContent === 'The whole (Y) cannot be 0, because nothing can be divided by 0.', null, { timeout: 3000 });
  await page.fill('#pc-what-b', '0.5');
  assert.equal(await text('#pc-what-msg'), '');
  assert.equal(await text('#pc-what-answer'), '12 is 2,400% of 0.5');
  // An empty box is a prompt, never an error, and nothing typed elsewhere is lost.
  await page.fill('#pc-what-a', '');
  await leave('#pc-what-a');
  assert.equal(await text('#pc-what-answer'), 'Enter both numbers to see the answer.');
  assert.equal(await text('#pc-what-msg'), '');
  assert.equal(await attr('#pc-what-a', 'aria-invalid'), null);
  assert.equal(await page.inputValue('#pc-what-b'), '0.5');
  // Two bad boxes are both marked; the message names the first.
  await set('diff', 'x', 'y');
  await leave('#pc-diff-b');
  assert.equal(await text('#pc-diff-msg'), 'First value (X) must be a number, such as 12.5 or 1,250.');
  assert.deepEqual([await attr('#pc-diff-a', 'aria-invalid'), await attr('#pc-diff-b', 'aria-invalid')], ['true', 'true']);
  await page.fill('#pc-diff-a', '80');
  assert.equal(await text('#pc-diff-msg'), 'Second value (Y) must be a number, such as 12.5 or 1,250.');
  assert.deepEqual([await attr('#pc-diff-a', 'aria-invalid'), await attr('#pc-diff-b', 'aria-invalid')], [null, 'true']);
  await page.fill('#pc-diff-b', '100');
  assert.equal(await text('#pc-diff-msg'), '');

  // ---- Copy buttons. ----
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const copied = async (sel, want) => {
    await page.click(sel);
    await page.waitForFunction(s => document.querySelector(s).textContent === 'Copied!', sel);
    assert.equal(await clip(), want);
  };
  await set('of', '15', '80');
  await copied('#pc-of-copy', '12');
  await set('change', '80', '100');
  await copied('#pc-change-copy', '25% increase');
  await set('of', '250', '1234567.89');
  await copied('#pc-of-copy', '3,086,419.725');
  await set('orig', '92', '15', 'inc');
  await copied('#pc-orig-copy-steps', ['92 is 15% more than 80', 'Formula: X ÷ (1 + Y ÷ 100)', '1. 1 + 15 ÷ 100 = 1.15', '2. 92 ÷ 1.15 = 80', '3. The change itself: 92 − 80 = 12'].join('\n'));
  await set('what', '1', '3');
  await copied('#pc-what-copy', '33.333333%');
  await copied('#pc-what-copy-steps', ['1 is about 33.333333% of 3', 'Formula: X ÷ Y × 100', '1. 1 ÷ 3 ≈ 0.33333333', '2. 0.33333333 × 100 ≈ 33.333333%'].join('\n'));
  // With nothing to copy the button says so and the clipboard is left alone.
  await page.fill('#pc-what-a', '');
  await page.click('#pc-what-copy');
  await page.waitForFunction(() => document.querySelector('#pc-what-copy').textContent === 'Nothing to copy yet');
  assert.match(await clip(), /^1 is about/);
  await page.fill('#pc-what-a', '12');
  await page.fill('#pc-what-b', '80');
  // A button's accessible name is the words on it, also while it says "Copied!". Which
  // calculator it belongs to comes from that calculator's heading, as its description.
  const names = await page.$$eval('.pc button', bs => bs.map(b => [b.id, b.getAttribute('aria-label'), b.getAttribute('aria-labelledby'), b.getAttribute('aria-describedby')]));
  assert.equal(names.length, 14);
  for (const [id, label, labelledby, describedby] of names) {
    assert.deepEqual([label, labelledby], [null, null], id);
    assert.equal(describedby, `pc-${id.split('-')[1]}-h`, id);
  }
  assert.equal(await page.$eval('#pc-orig-copy-steps', b => b.textContent + ' / ' + document.getElementById(b.getAttribute('aria-describedby')).textContent), 'Copy steps / Reverse percentage: the value before a change of Y%');

  // ---- Keyboard: Tab into a box selects the example so typing replaces it; Enter
  // announces the answer straight away; Tab reaches the copy buttons. ----
  await page.reload({ waitUntil: 'load' });
  await page.focus('#pc-dp');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pc-of-a');
  assert.deepEqual(await page.evaluate(() => [document.activeElement.selectionStart, document.activeElement.selectionEnd]), [0, 2]);
  await page.keyboard.type('20');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pc-of-b');
  await page.keyboard.type('50');
  assert.equal(await text('#pc-of-answer'), '20% of 50 = 10');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#pc-status').textContent === '20% of 50 = 10', null, { timeout: 800 });
  assert.equal(await attr('#pc-status', 'role'), 'status');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pc-of-copy');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#pc-of-copy').textContent === 'Copied!');
  assert.equal(await clip(), '10');
  const ring = await page.$eval('#pc-of-copy', b => { const s = getComputedStyle(b); return s.outlineStyle + ' ' + s.outlineWidth; });
  assert.equal(ring, 'solid 2px');
  // Clicking an example selects it too; a number the visitor typed is left alone.
  await page.click('#pc-what-a');
  await page.keyboard.type('3');
  assert.equal(await page.inputValue('#pc-what-a'), '3');
  await page.click('#pc-what-b');
  await page.click('#pc-what-a');
  await page.keyboard.type('0');
  assert.equal((await page.inputValue('#pc-what-a')).length, 2);
  // The select changes the answer from the keyboard as well.
  await page.focus('#pc-add-op');
  await page.keyboard.press('ArrowDown');
  assert.equal(await text('#pc-add-answer'), '80 − 15% = 68');

  // One line is announced after typing pauses, not one for every key.
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__pcChanges = 0;
    new MutationObserver(() => window.__pcChanges++).observe(document.querySelector('#pc-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#pc-change-b', '');
  await page.locator('#pc-change-b').pressSequentially('120', { delay: 40 });
  // (120 - 80) / 80 = 50%.
  await page.waitForFunction(() => document.querySelector('#pc-status').textContent === 'From 80 to 120: 50% increase', null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__pcChanges), 1);
  // The result boxes themselves are not live regions.
  assert.equal(await page.$$eval('.pc-out, .pc-answer', els => els.filter(e => e.getAttribute('aria-live') || e.getAttribute('role')).length), 0);

  // ---- The guide's examples open in the calculator, and give what the guide says. ----
  const EXAMPLES = [
    ['#subtract=45,20', 'add', '45 − 20% = 36'], ['#add=150,20', 'add', '150 + 20% = 180'], ['#before-increase=180,20', 'orig', '180 is 20% more than 150'],
    ['#of=18,64.5', 'of', '18% of 64.5 = 11.61'], ['#change=80,60', 'change', 'From 80 to 60: 25% decrease'],
  ];
  assert.deepEqual(await page.$$eval('.prose a[href*="="]', as => as.map(a => a.getAttribute('href'))), EXAMPLES.map(e => e[0]));
  for (const [href, id, answer] of EXAMPLES) {
    await page.click(`.prose a[href="${href}"]`);
    await page.waitForFunction(i => document.activeElement.id === `pc-${i}-h`, id);
    assert.equal(await text(`#pc-${id}-answer`), answer, href);
    await page.waitForFunction(i => { const r = document.querySelector(`#pc-${i}`).getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight / 2; }, id);
    await page.waitForFunction(a => document.querySelector('#pc-status').textContent === a, answer);
  }
  // 180 ÷ 6 = 30: at 20% the VAT is one sixth of the price that includes it.
  assert.deepEqual(await steps('orig'), ['1 + 20 ÷ 100 = 1.2', '180 ÷ 1.2 = 150', 'The change itself: 180 − 150 = 30']);
  // Clicking the same example again restores it after the numbers were changed.
  await page.fill('#pc-change-a', '500');
  await page.click('.prose a[href="#change=80,60"]');
  await page.waitForFunction(() => document.querySelector('#pc-change-a').value === '80');
  assert.equal(await text('#pc-change-answer'), 'From 80 to 60: 25% decrease');
  // An example address opens directly; anything else after the # is ignored.
  // (From a blank page, so that the address is loaded afresh and not just jumped to.)
  await page.goto('about:blank');
  await page.goto(url + '#before-decrease=36,20', { waitUntil: 'load' });
  assert.equal(await text('#pc-orig-answer'), '36 is 20% less than 45');
  assert.equal(await page.inputValue('#pc-orig-op'), 'dec');
  // It is the last calculator: the page has to be complete before it can be brought to the top.
  await page.waitForFunction(() => { const t = document.querySelector('#pc-orig').getBoundingClientRect().top; return t >= 0 && t <= 20; }, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pc-orig-h');
  await page.goto(url + '#of=<b>1,2', { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  assert.equal(await text('#pc-of-answer'), '15% of 80 = 12');
  await page.goto(url + '#nothing=1,2', { waitUntil: 'load' });
  assert.equal(await text('#pc-of-answer'), '15% of 80 = 12');
  // The "See examples" link under the add or subtract calculator has a target.
  assert.equal(await page.locator(await attr('.pc-note a', 'href')).count(), 1);

  // ---- A locale that writes decimals with a comma reads "1,234" as 1.234. ----
  const de = await page.context().browser().newContext({ locale: 'de-DE' });
  const dePage = await de.newPage();
  await dePage.goto(url, { waitUntil: 'load' });
  await dePage.fill('#pc-of-a', '100');
  await dePage.fill('#pc-of-b', '1,234');
  assert.equal(await dePage.textContent('#pc-of-answer'), '100% of 1.234 = 1.234');
  await dePage.fill('#pc-of-b', '1.234,5');
  assert.equal(await dePage.textContent('#pc-of-answer'), '100% of 1,234.5 = 1,234.5');
  // The Arabic thousands separator groups thousands here too; it is not a decimal comma.
  for (const [typed, read] of [['\u0661\u066C\u0662\u0663\u0664', '1,234'], ['\u0661\u066C\u0662\u0663\u0664\u066B\u0665', '1,234.5'], ['0,500', '0.5']]) {
    await dePage.fill('#pc-of-b', typed);
    assert.equal(await dePage.textContent('#pc-of-answer'), `100% of ${read} = ${read}`, JSON.stringify(typed));
  }
  await de.close();

  // ---- A phone with a touch screen. ----
  const phone = await page.context().browser().newContext({ ...devices['iPhone 13'] });
  const p = await phone.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(url, { waitUntil: 'load' });
  assert.equal(await p.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  await p.tap('#pc-what-a');
  await p.keyboard.type('45');
  await p.tap('#pc-what-b');
  await p.keyboard.type('60');
  assert.equal(await p.textContent('#pc-what-answer'), '45 is 75% of 60');
  await p.tap('#pc-add-op');
  await p.selectOption('#pc-add-op', 'sub');
  assert.equal(await p.textContent('#pc-add-answer'), '80 − 15% = 68');
  // Controls are at least 44 px tall and text boxes at least 16 px, so iOS does not zoom in.
  const sizes = await p.$$eval('.pc input, .pc select, .pc button', els => els.map(e => ({ id: e.id, h: e.getBoundingClientRect().height, font: parseFloat(getComputedStyle(e).fontSize), tag: e.tagName })));
  assert.equal(sizes.length, 31);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.tag !== 'BUTTON') assert.ok(s.font >= 16, `${s.id} has ${s.font}px text`);
  }
  assert.deepEqual(await p.$$eval('.pc input', els => [...new Set(els.map(e => e.getAttribute('inputmode')))]), ['decimal']);
  // A 31-digit answer wraps inside its box at 320 px instead of widening the page.
  await p.setViewportSize({ width: 320, height: 568 });
  await p.fill('#pc-of-a', '12.5');
  await p.fill('#pc-of-b', '999999999999999999999999999999');
  assert.equal(await p.textContent('#pc-of-answer b'), '124,999,999,999,999,999,999,999,999,999.875');
  await p.fill('#pc-what-a', '0.000001');
  await p.fill('#pc-what-b', '999999999999');
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'no sideways scroll with long numbers');
  // Every option of every select fits its box (text, padding, border and 22 px for the
  // arrow) at phone, tablet and desktop widths: "an increase of" used to be cut off at 360 px.
  for (const width of [320, 340, 360, 375, 390, 412, 480, 540, 768, 1280]) {
    await p.setViewportSize({ width, height: 700 });
    const cut = await p.evaluate(() => {
      const cv = document.createElement('canvas').getContext('2d'), out = [];
      for (const e of document.querySelectorAll('.pc select')) {
        const cs = getComputedStyle(e);
        cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = e.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 - 22;
        for (const o of e.options) if (cv.measureText(o.textContent).width > room) out.push(`${e.id} "${o.textContent}"`);
      }
      return out;
    });
    assert.deepEqual(cut, [], `options cut off at ${width}px`);
  }
  await p.setViewportSize({ width: 320, height: 568 });
  // A tapped example link moves to its calculator without opening the keyboard on a box.
  await p.tap('.prose a[href="#of=18,64.5"]');
  await p.waitForFunction(() => document.activeElement.id === 'pc-of-h');
  assert.equal(await p.textContent('#pc-of-answer'), '18% of 64.5 = 11.61');
  assert.deepEqual(errors, []);
  await phone.close();
};
