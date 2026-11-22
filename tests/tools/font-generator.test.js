const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected styles come from tests/fixtures/font-generator/expected.py, which finds every
// styled character by its Unicode character name (Python's unicodedata) and splits text
// into the characters a reader sees with the regex module's \X, never from this page's
// tables. The letters that fill holes of the Mathematical Alphanumeric Symbols block are
// also checked by hand against the Unicode code charts (U+1D400 block, Letterlike Symbols).
module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const ids = Object.keys(data.expected.default);
  const exp = (input, id) => data.expected[input][id].text;

  await open();
  const text = sel => page.locator(sel).textContent();
  const outs = () => page.$$eval('.fg-item', lis => Object.fromEntries(lis.map(li => [li.querySelector('.fg-copy').dataset.style,
    { text: li.querySelector('.fg-out').textContent, note: li.querySelector('.fg-note').textContent, sample: li.querySelector('.fg-out').classList.contains('is-sample'), disabled: li.querySelector('.fg-copy').disabled }])));
  const fill = v => page.fill('#fg-input', v);
  // Like a paste: the whole value arrives at once, with one input event.
  const paste = v => page.$eval('#fg-input', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  // Waits until the element says this, and shows what it says instead when it never does.
  const settles = (sel, expected, on = page) => on.waitForFunction(([s, t]) => document.querySelector(s).textContent === t, [sel, expected], { timeout: 10000 })
    .catch(async () => assert.equal(await on.locator(sel).textContent(), expected));
  const clipboard = (on = page) => on.evaluate(() => navigator.clipboard.readText());
  // Clicks a copy button and returns what arrived on the clipboard.
  const copied = async (id, click = () => page.click(`#fg-c-${id}`), on = page) => {
    await on.evaluate(() => navigator.clipboard.writeText('(nothing copied yet)'));
    await click();
    await on.waitForFunction(async () => (await navigator.clipboard.readText()) !== '(nothing copied yet)', null, { timeout: 5000 }).catch(() => {});
    return clipboard(on);
  };
  // Equal strings, or a short message at the first difference (not two megabytes of text).
  const same = (actual, expected, label = 'text') => {
    if (actual === expected) return;
    let i = 0;
    while (i < actual.length && actual[i] === expected[i]) i++;
    assert.fail(`${label}: ${actual.length} vs ${expected.length} UTF-16 units, first difference at ${i}: ` +
      `${JSON.stringify(actual.slice(Math.max(0, i - 10), i + 20))} vs ${JSON.stringify(expected.slice(Math.max(0, i - 10), i + 20))}`);
  };
  const lone = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  // ---- 31 styles in six groups, with the example text, and nothing announced on load ----
  assert.equal(ids.length, 31);
  assert.deepEqual(Object.keys(await outs()), ids);
  assert.deepEqual(await page.locator('.fg-h').allTextContents(), ['Bold, italic and script', 'Sans-serif and monospace', 'Small letters',
    'Letters in circles and squares', 'Wide, flipped and reversed', 'Lines through, under and over']);
  assert.equal(await page.inputValue('#fg-input'), 'Fancy Text 123');
  let got = await outs();
  for (const id of ids) assert.equal(got[id].text, exp('default', id), `example in ${id}`);
  assert.equal(got.bold.text, '𝐅𝐚𝐧𝐜𝐲 𝐓𝐞𝐱𝐭 𝟏𝟐𝟑');
  assert.equal(got.italic.note, 'Left as typed: 1, 2, 3.');
  assert.equal(got.bold.note, '');
  await page.waitForTimeout(900);
  assert.equal(await text('#fg-status'), '');
  assert.equal(await text('#fg-error'), '');
  assert.equal(await page.getAttribute('#fg-input', 'aria-invalid'), null);

  // ---- Every fixture text in every style, and the letters each style left as typed ----
  for (const [name, input] of Object.entries(data.inputs)) {
    await fill(input);
    got = await outs();
    for (const id of ids) {
      const e = data.expected[name][id];
      same(got[id].text, e.text, `${name} in ${id}`);
      assert.equal(lone(got[id].text), false, `${name} in ${id} has half a surrogate pair`);
      const left = e.left.length ? `Left as typed: ${e.left.slice(0, 8).join(', ')}${e.left.length > 8 ? ` and ${e.left.length - 8} more` : ''}.` : '';
      if (left) assert.ok(got[id].note.startsWith(left), `${name} in ${id}: note "${got[id].note}", expected "${left}"`);
      else assert.ok(!got[id].note.includes('Left as typed'), `${name} in ${id}: note "${got[id].note}"`);
    }
  }
  // The holes of the block, by hand: script B E F H I L M R e g o, Fraktur C H I R Z,
  // double-struck C H N P Q R Z and italic h are the older Letterlike Symbols.
  await fill('BEFHILMR ego CHIRZ CHNPQRZ h');
  got = await outs();
  assert.equal(got.script.text.slice(0, 12), 'ℬℰℱℋℐℒℳℛ ℯℊℴ');
  assert.equal(got.fraktur.text.split(' ')[2], 'ℭℌℑℜℨ');
  assert.equal(got.double.text.split(' ')[3], 'ℂℍℕℙℚℝℤ');
  assert.equal(got.italic.text.split(' ')[4], 'ℎ');
  // Greek has bold, italic and sans-serif bold forms; script has none, and says so.
  await fill('αβγ Ω');
  got = await outs();
  assert.equal(got.bold.text, '𝛂𝛃𝛄 𝛀');
  assert.equal(got['sans-bold'].text, '𝝰𝝱𝝲 𝝮');
  assert.equal(got.script.text, 'αβγ Ω');
  assert.equal(got.script.note, 'Left as typed: α, β, γ, Ω.');
  // Accents stay on their letter: é is the styled e and a combining acute accent.
  await fill('Café');
  got = await outs();
  assert.equal(got.bold.text, '𝐂𝐚𝐟𝐞\u0301');
  assert.equal(got['upside-down'].text, 'ǝ\u0301ɟɐƆ');
  assert.equal(got.backwards.text, 'éfaC');

  // Notes that depend on the letters typed.
  await fill('Quiz box Pop');
  got = await outs();
  assert.equal(got['small-caps'].text, 'ꞯᴜɪᴢ ʙᴏx ᴘᴏᴘ');
  assert.equal(got['small-caps'].note, 'ꞯ (q) was added to Unicode in 2018, so older devices may show a box. x has no small capital, so a plain x is used.');
  assert.equal(got.superscript.text, '𐞥ᵘⁱᶻ ᵇᵒˣ ᴾᵒᵖ');
  assert.equal(got.superscript.note, '𐞥 (q) was added to Unicode in 2021, so older devices may show a box. C, F, Q, S, X, Y and Z have no superscript capital, so the small letter is used.');
  assert.equal(got['black-squared'].note, 'Capitals only, so small letters become capitals. 🅰 🅱 🅾 🅿 are also emoji, so some apps show them in colour.');
  assert.equal(got.subscript.note, 'Left as typed: Q, z, b, P.');
  // Chemical formulas keep their capitals in subscript.
  await fill('H2O');
  assert.equal((await outs()).subscript.text, 'H₂O');

  // ---- Empty: each style shows its own name as a sample, and nothing can be copied ----
  await fill('');
  got = await outs();
  assert.equal(got.bold.text, '𝐁𝐨𝐥𝐝');
  assert.equal(got['upside-down'].text, 'uʍop ǝpᴉsd∩');
  assert.ok(ids.every(id => got[id].sample && got[id].disabled), 'samples and disabled buttons when empty');
  await settles('#fg-status', 'Type some text to see it in 31 styles.');

  // ---- Copy: the exact characters, a visible and spoken confirmation ----
  await fill('Hello');
  got = await outs();
  assert.ok(ids.every(id => !got[id].sample && !got[id].disabled));
  assert.equal(await copied('bold'), '\u{1D407}\u{1D41E}\u{1D425}\u{1D425}\u{1D428}');
  assert.equal(await text('#fg-c-bold'), 'Copied');
  assert.equal(await page.getByRole('button', { name: 'Copied Bold', exact: true }).count(), 1);
  await settles('#fg-status', 'Bold copied to the clipboard.');
  await page.waitForFunction(() => document.querySelector('#fg-c-bold').textContent === 'Copy', null, { timeout: 3000 });
  for (const id of ['upside-down', 'strike', 'black-circled', 'fullwidth']) assert.equal(await copied(id), exp('hello', id), `copy ${id}`);
  assert.equal(exp('hello', 'upside-down'), 'ollǝH');
  // Copying the same style again is confirmed again.
  await page.evaluate(() => {
    window.__fgSaid = [];
    new MutationObserver(() => window.__fgSaid.push(document.querySelector('#fg-status').textContent))
      .observe(document.querySelector('#fg-status'), { childList: true, characterData: true, subtree: true });
  });
  await copied('fullwidth');
  await page.waitForFunction(() => window.__fgSaid.filter(t => t === 'Full-width (vaporwave) copied to the clipboard.').length >= 1);

  // ---- A long text is shown in part, and copied whole ----
  const bold = s => [...s].map(c => /[a-z]/.test(c) ? String.fromCodePoint(0x1D41A + c.charCodeAt(0) - 97) : c).join('');
  await paste('abc '.repeat(500));
  got = await outs();
  same(got.bold.text, bold('abc '.repeat(150)), 'bold preview');
  assert.equal(got.bold.note, 'Showing the beginning. Copy takes the whole text.');
  same(await copied('bold'), bold('abc '.repeat(500)), 'bold copy');
  assert.equal(await text('#fg-error'), '');
  // Long emoji sequences: only whole ones are shown, never half of one.
  const family = '\u{1F468}\u{1F3FD}\u200D\u{1F469}\u{1F3FD}\u200D\u{1F467}\u{1F3FD}\u200D\u{1F466}\u{1F3FD}';
  assert.equal(family.length, 19);
  await paste(family.repeat(500));
  await page.waitForFunction(f => document.querySelector('#fg-o-bold').textContent.startsWith(f), family);
  got = await outs();
  same(got.backwards.text, family.repeat(378), 'backwards preview');
  same(got.bold.text, family.repeat(378), 'bold preview');
  assert.equal(lone(got.backwards.text), false);
  same(await copied('backwards'), family.repeat(500), 'backwards copy');

  // ---- Copy right after a paste that is styled after a pause: never the old styles ----
  await paste('ab'.repeat(1500));
  same(await copied('upside-down'), 'qɐ'.repeat(1500), 'upside-down copy');
  await paste('cd'.repeat(1600));
  same(await copied('backwards'), 'dc'.repeat(1600), 'backwards copy');

  // ---- A megabyte paste: a message, the first 10,000 characters styled, no frozen page ----
  const t0 = Date.now();
  await paste('a'.repeat(1048576));
  await settles('#fg-error', 'This text is 1,048,576 characters long. Only the first 10,000 are styled below, so shorten it to style the rest.');
  assert.ok(Date.now() - t0 < 3000, `a megabyte paste took ${Date.now() - t0} ms`);
  assert.equal(await page.getAttribute('#fg-input', 'aria-invalid'), 'true');
  assert.ok((await page.getAttribute('#fg-input', 'aria-describedby')).split(' ').includes('fg-error'));
  await settles('#fg-status', 'This text is 1,048,576 characters long. Only the first 10,000 are styled below, so shorten it to style the rest.');
  same(await copied('bold'), '\u{1D41A}'.repeat(10000), 'bold copy');
  // The cut never splits an emoji or an accent from its letter.
  await paste('a'.repeat(9999) + '😀'.repeat(10));
  await settles('#fg-error', 'This text is 10,019 characters long. Only the first 9,999 are styled below, so shorten it to style the rest.');
  let c = await copied('bold');
  assert.equal(lone(c), false);
  same(c, '\u{1D41A}'.repeat(9999), 'bold copy');
  await paste('a'.repeat(9999) + 'e\u0301xyz');
  c = await copied('underline');
  same(c, 'a\u0332'.repeat(9999), 'underline copy');
  // Back under the limit, the message and the red edge go.
  await fill('ok');
  assert.equal(await text('#fg-error'), '');
  assert.equal(await page.getAttribute('#fg-input', 'aria-invalid'), null);
  assert.equal((await outs()).bold.text, '𝐨𝐤');

  // ---- One spoken summary after typing pauses, with the text that was typed ----
  await fill('');
  await settles('#fg-status', 'Type some text to see it in 31 styles.');
  await page.evaluate(() => {
    window.__fgChanges = 0;
    new MutationObserver(() => window.__fgChanges++).observe(document.querySelector('#fg-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#fg-input').pressSequentially('Hi there', { delay: 30 });
  await settles('#fg-status', '“Hi there” is shown in 31 styles.');
  assert.equal(await page.evaluate(() => window.__fgChanges), 1);
  await paste('line one\nline two '.repeat(5));
  await settles('#fg-status', '“line one line two line one line two line…” is shown in 31 styles.');

  // ---- Keyboard: the text box, Clear, then the copy buttons in order ----
  await fill('Keys');
  await page.focus('#fg-input');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fg-clear');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fg-c-bold');
  assert.notEqual(await page.$eval('#fg-c-bold', el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fg-c-italic');
  assert.equal(await copied('italic', () => page.keyboard.press('Enter')), '\u{1D43E}\u{1D452}\u{1D466}\u{1D460}');
  await page.focus('#fg-clear');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#fg-input'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fg-input');
  // Every button is named after what it shows: "Copy Bold", "Copy Italic"...
  for (const name of ['Copy Bold', 'Copy Script (cursive)', 'Copy Upside down', 'Copy Overline', 'Clear']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, name);
  }
  assert.equal(await page.getByRole('textbox', { name: 'Your text', exact: true }).count(), 1);

  // ---- Back from another page: the browser may put the text back after the script ran ----
  await fill(data.inputs.back);
  await page.goto(`${base}/about/`, { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'load' });
  const restored = await page.inputValue('#fg-input');
  const which = restored === data.inputs.back ? 'back' : restored === data.inputs.default ? 'default' : null;
  assert.ok(which, `restored "${restored}"`);
  got = await outs();
  for (const id of ids) assert.equal(got[id].text, exp(which, id), `after Back, ${id}`);
  // When the browser puts the text back after the script has run (as Firefox can, when
  // the page is not kept in the back-forward cache), the styles follow on pageshow.
  await page.evaluate(t => {
    document.querySelector('#fg-input').value = t;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  }, data.inputs.hello);
  got = await outs();
  for (const id of ids) assert.equal(got[id].text, exp('hello', id), `on pageshow, ${id}`);

  // ---- The guide links to tools of this site, and the FAQ ends with privacy ----
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/discord-timestamp-generator/', '/case-converter/']);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), href);
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.match(faqs[faqs.length - 1], /uploaded/);

  // ---- A phone with a touch screen ----
  const browser = page.context().browser();
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  await phone.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const p = await phone.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('#fg-input');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('Hello');
  assert.equal(await copied('script', () => p.tap('#fg-c-script'), p), exp('hello', 'script'));
  assert.equal(await p.locator('#fg-c-script').textContent(), 'Copied');
  // Controls are at least 44 px tall and the text box uses 16 px type (no zoom on iOS).
  const sizes = await p.$$eval('.fg button, .fg textarea', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id, h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), field: e.tagName === 'TEXTAREA',
  })));
  assert.equal(sizes.length, 33);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px text`);
  }
  // Nothing is cut off or pushed off the card at any phone width, with a long word on screen.
  await p.fill('#fg-input', 'Supercalifragilisticexpialidocious '.repeat(3) + '👋🏽');
  for (const width of [320, 340, 360, 390, 412, 480, 540]) {
    await p.setViewportSize({ width, height: 800 });
    const cut = await p.$$eval('.fg button, .fg-name, .fg-out, .fg-note, .fg-h, .fg-warn, .fg label', els => els.filter(e => e.offsetParent).filter(e => {
      const r = e.getBoundingClientRect(), card = e.closest('.tool-card').getBoundingClientRect();
      return e.scrollWidth > e.clientWidth + 1 || r.right > card.right + 0.5 || r.left < card.left - 0.5;
    }).map(e => e.id || e.textContent.trim().slice(0, 30)), width);
    assert.deepEqual(cut, [], `cut off at ${width}px`);
    assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `sideways scroll at ${width}px`);
  }
  await phone.close();
};
