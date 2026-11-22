const fs = require('fs');
const path = require('path');

// Counts are made here, independently of the page: words by splitting on white space, bytes with
// Node's Buffer, paragraphs by blank lines or <p> elements. The word list, the standard passage's
// size and the letters it never uses come from tests/fixtures/lorem-ipsum-generator/make_expected.py,
// which types the source texts out separately.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const VOCAB = new Set(exp.vocab);
  await open();
  const out = () => page.inputValue('#li-output');
  const text = s => page.locator(s).textContent();
  const set = async (n, unit, opts = {}) => {
    if (unit) await page.selectOption('#li-unit', unit);
    if (opts.length) await page.selectOption('#li-length', opts.length);
    if (opts.start !== undefined) await page.setChecked('#li-start', opts.start);
    if (opts.html !== undefined && !(await page.isDisabled('#li-html'))) await page.setChecked('#li-html', opts.html);
    await page.fill('#li-count', String(n));
    await page.locator('#li-count').dispatchEvent('change');
    return out();
  };
  const words = t => t.split(/\s+/).filter(Boolean);
  const bare = w => w.toLowerCase().replace(/[.,]/g, '');
  const sentencesOf = t => t.match(/[^.]+\./g) || [];
  // Every sentence starts with a capital, words are single-spaced, commas sit inside sentences.
  const wellFormed = (t, label) => {
    assert.ok(!/ {2}|^ | $| [.,]|,\.|,,|\.\./.test(t), `${label}: spacing or punctuation: ${t.slice(0, 120)}`);
    for (const s of sentencesOf(t)) assert.match(s.trim(), /^[A-Z][a-z]*(,? [a-z]+)*\.$/, `${label}: ${s}`);
  };

  // ---- First view: five medium paragraphs, starting with the classic sentence; nothing in the address ----
  let t = await out();
  let paras = t.split('\n\n');
  assert.equal(paras.length, 5);
  assert.ok(t.startsWith(exp.first_sentence + ' '));
  paras.forEach((p, i) => { wellFormed(p, 'paragraph ' + i); const n = sentencesOf(p).length; assert.ok(n >= 5 && n <= 8, `medium paragraph has ${n} sentences`); });
  const n0 = words(t).length;
  assert.equal(await text('#li-summary'), `5 paragraphs · ${paras.reduce((s, p) => s + sentencesOf(p).length, 0)} sentences · ${n0.toLocaleString('en-GB')} words · ${t.length.toLocaleString('en-GB')} characters · ${Buffer.byteLength(t).toLocaleString('en-GB')} bytes`);
  assert.equal(await page.getAttribute('#li-summary', 'role'), 'status');
  // A wrong number is announced at once (the site's error convention), not only shown.
  assert.equal(await page.getAttribute('#li-count-error', 'role'), 'alert');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.isVisible('#li-length-field'), true);

  // ---- Words: exactly n, in whole sentences; the classic opening is cut to fit ----
  for (const n of [1, 2, 5, 6, 8, 9, 10, 11, 37, 1000]) {
    t = await set(n, 'words', { start: true });
    assert.equal(words(t).length, n, `${n} words`);
    wellFormed(t, `${n} words`);
    const lead = exp.first_sentence.slice(0, -1).split(' ');
    const prefix = n >= 8 ? exp.first_sentence + (n > 8 ? ' ' : '') : lead.slice(0, n).join(' ').replace(/,$/, '') + '.';
    assert.ok(t.startsWith(prefix), `${n} words: ${t.slice(0, 80)}`);
  }
  assert.equal(await set(5, 'words'), 'Lorem ipsum dolor sit amet.');
  assert.equal(await set(1, 'words'), 'Lorem.');
  t = await set(37, 'words', { start: false });
  assert.equal(words(t).length, 37);
  assert.ok(!t.startsWith('Lorem ipsum'));
  wellFormed(t, '37 words, no lorem');
  // 100,000 words: every one is a word of the source texts, all 210 of them turn up, and none
  // has j, k, w, y or z (the guide says so).
  t = await set('100,000', 'words', { start: true });
  const all = words(t);
  assert.equal(all.length, 100000);
  const seen = new Set(all.map(bare));
  for (const w of seen) assert.ok(VOCAB.has(w), `"${w}" is not a word of the source texts`);
  assert.equal(seen.size, exp.vocab_size);
  for (const c of exp.letters_never_used) assert.ok(!t.toLowerCase().includes(c), `letter ${c} appears`);
  // No word comes twice in a row ("et et"). The first word after the classic sentence is drawn
  // without regard to it (so that the option changes only that sentence), so that place is skipped.
  const lw = all.map(bare), leadLen = exp.first_sentence.split(' ').length;
  for (let i = 1; i < lw.length; i++) if (i !== leadLen && lw[i] === lw[i - 1]) assert.fail(`"${lw[i]}" twice in a row at word ${i}`);
  assert.match(await text('#li-summary'), /^\d[\d,]* sentences · 100,000 words · /);

  // ---- Bytes: exactly n bytes in one block, ending in a full stop ----
  // With the Lorem start, "Lorem a." (8 bytes) is the shortest whole sentence; below that the
  // text is the start of "Lorem ipsum", cut to size.
  await page.check('#li-start');
  for (const n of [1, 2, 3, 5, 6, 7, 8, 9, 10, 20, 55, 56, 57, 58, 59, 60, 61, 100, 160, 255, 256, 1000, 4096, 65535]) {
    t = await set(n, 'bytes');
    assert.equal(Buffer.byteLength(t, 'utf8'), n, `${n} bytes`);
    assert.ok(!t.includes('\n'), 'one block');
    if (n >= 8) {
      assert.ok(t.startsWith('Lorem '), t.slice(0, 20));
      assert.ok(t.endsWith('.'), `${n} bytes ends with a full stop`);
      wellFormed(t, `${n} bytes`);
      for (const w of words(t)) assert.ok(VOCAB.has(bare(w)), `"${w}" in ${n} bytes`);
    } else assert.equal(t, n === 6 ? 'Lorem.' : 'Lorem ipsum'.slice(0, n));
    if (n >= 59) assert.ok(t.startsWith(exp.first_sentence + ' '), `${n} bytes keeps the classic sentence`);
  }
  assert.equal(await set(56, 'bytes'), exp.first_sentence);
  assert.match(await set(8, 'bytes'), /^Lorem [a-z]\.$/);
  await page.uncheck('#li-start');
  for (const n of [1, 2, 3, 4, 17, 255, 1000]) {
    t = await set(n, 'bytes');
    assert.equal(Buffer.byteLength(t, 'utf8'), n, `${n} bytes without lorem`);
    if (n >= 2) { assert.ok(t.endsWith('.')); wellFormed(t, `${n} bytes, no lorem`); }
  }
  assert.equal(await set(2, 'bytes'), 'A.');
  // The largest size, 1 MB, is made without a long freeze.
  const ms = await page.evaluate(() => {
    const el = document.querySelector('#li-count');
    el.value = '1000000';
    const t0 = performance.now();
    el.dispatchEvent(new Event('change'));
    return performance.now() - t0;
  });
  t = await out();
  assert.equal(Buffer.byteLength(t, 'utf8'), 1000000);
  assert.ok(ms < 1500, `1 MB took ${Math.round(ms)} ms`);
  assert.match(await text('#li-summary'), /^1,000,000 bytes · /);
  // HTML is off for bytes, and says why.
  assert.equal(await page.isDisabled('#li-html'), true);
  assert.equal(await page.isVisible('#li-html-hint'), true);
  assert.equal(await page.getAttribute('#li-html', 'aria-describedby'), 'li-html-hint');
  assert.equal(await page.isVisible('#li-length-field'), false);

  // ---- Sentences, list items ----
  await page.check('#li-start');
  t = await set(12, 'sentences', { html: false });
  assert.equal(sentencesOf(t).length, 12);
  assert.ok(t.startsWith(exp.first_sentence + ' '));
  for (const s of sentencesOf(t).slice(1)) { const n = words(s).length; assert.ok(n >= 4 && n <= 16, `sentence of ${n} words`); }
  t = await set(7, 'items');
  let lines = t.split('\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[0], 'Lorem ipsum dolor sit amet');
  for (const l of lines.slice(1)) { assert.match(l, /^[A-Z][a-z]*( [a-z]+){2,7}$/, l); }
  await page.check('#li-html');
  t = await out();
  assert.equal(t, '<ul>\n' + lines.map(l => '  <li>' + l + '</li>').join('\n') + '\n</ul>');
  assert.equal(await page.textContent('#li-download'), 'Download .html');

  // ---- Paragraph lengths: the guide's "about 40, 65 or 100 words" over 1,000 paragraphs ----
  await page.uncheck('#li-html');
  for (const [len, lo, hi, mean] of [['short', 3, 5, 40], ['medium', 5, 8, 65], ['long', 8, 12, 100]]) {
    t = await set(1000, 'paragraphs', { length: len, start: false });
    paras = t.split('\n\n');
    assert.equal(paras.length, 1000);
    for (const p of paras) { const n = sentencesOf(p).length; assert.ok(n >= lo && n <= hi, `${len}: ${n} sentences`); }
    const avg = words(t).length / 1000;
    assert.ok(Math.abs(avg - mean) / mean < 0.06, `${len} paragraphs average ${avg} words`);
  }
  // HTML paragraphs hold the same text as the plain ones.
  t = await set(4, 'paragraphs', { length: 'medium', start: true, html: false });
  await page.check('#li-html');
  const html = await out();
  assert.match(html, /^<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit\. [^<]+<\/p>(\n<p>[^<]+<\/p>){3}$/);
  assert.deepEqual(await page.evaluate(h => [...new DOMParser().parseFromString(h, 'text/html').querySelectorAll('p')].map(p => p.textContent), html), t.split('\n\n'));
  await page.uncheck('#li-html');

  // ---- The same settings and seed give the same text: adding a paragraph keeps the others ----
  const five = await set(5, 'paragraphs', { length: 'medium', start: true });
  const six = await set(6, 'paragraphs');
  assert.ok(six.startsWith(five + '\n\n'));
  // "Start with Lorem ipsum" changes only the first sentence.
  await page.uncheck('#li-start');
  const noLorem = await set(6, 'paragraphs');
  assert.equal(noLorem.slice(noLorem.indexOf('. ') + 2), six.slice(six.indexOf('. ') + 2));
  assert.notEqual(noLorem, six);
  await page.check('#li-start');
  // The address holds settings and seed; a reload shows the same text.
  const hash = await page.evaluate(() => location.hash);
  assert.match(hash, /^#n=6&unit=paragraphs&len=medium&start=1&html=0&seed=[0-9a-f]{1,8}$/);
  await page.reload();
  assert.equal(await out(), six);
  assert.equal(await page.inputValue('#li-count'), '6');
  // Generate new text: new words, new seed, same settings; from the keyboard.
  await page.focus('#li-generate');
  await page.keyboard.press('Enter');
  t = await out();
  assert.notEqual(t, six);
  assert.equal(t.split('\n\n').length, 6);
  assert.ok(t.startsWith(exp.first_sentence));
  const hash2 = await page.evaluate(() => location.hash);
  assert.notEqual(hash2, hash);
  assert.equal(hash2.replace(/seed=.*/, ''), hash.replace(/seed=.*/, ''));
  // Changing the address by hand is followed; a too-long or broken address is ignored.
  await page.evaluate(h => { location.hash = h; }, hash.replace('n=6', 'n=2').replace('unit=paragraphs', 'unit=sentences'));
  await page.waitForFunction(() => document.querySelector('#li-unit').value === 'sentences');
  assert.equal(sentencesOf(await out()).length, 2);
  await page.goto('about:blank');
  await page.goto(url + '#n=3&unit=evil&len=huge&start=7&html=1&seed=zz' + '&x=' + 'a'.repeat(300));
  assert.equal(await page.inputValue('#li-count'), '5');
  assert.equal(await page.inputValue('#li-unit'), 'paragraphs');
  // So is a name that every object has, such as constructor: the menus keep their default
  // instead of going blank.
  for (const h of ['unit=constructor', 'len=__proto__', 'unit=toString&len=hasOwnProperty']) {
    await page.goto('about:blank');
    await page.goto(url + '#n=3&' + h);
    assert.equal(await page.inputValue('#li-unit'), 'paragraphs', h);
    assert.equal(await page.inputValue('#li-length'), 'medium', h);
    assert.equal(await page.inputValue('#li-count'), '3', h);
  }
  await page.goto('about:blank');
  await page.goto(url + '#n=3&unit=evil&seed=1f');
  assert.equal(await page.inputValue('#li-count'), '3');
  assert.equal(await page.inputValue('#li-unit'), 'paragraphs');
  const seeded = await out();
  await page.goto('about:blank');
  await page.goto(url + '#n=3&unit=paragraphs&seed=1f');
  assert.equal(await out(), seeded);

  // ---- Reading the number: separators, other digits, and refusals ----
  await page.selectOption('#li-unit', 'items');
  const countOf = async v => { await set(v); return (await out()).split('\n').filter(Boolean).length; };
  for (const [v, n] of [['1,000', 1000], ['1.000', 1000], ['1 000', 1000], ['1 000', 1000], ["1'000", 1000], ['١٬٠٠٠', 1000],
    ['٥', 5], ['１２', 12], ['۷', 7], [' 42 ', 42], ['+3', 3], ['007', 7]]) {
    assert.equal(await countOf(v), n, JSON.stringify(v));
    assert.equal(await page.getAttribute('#li-count', 'aria-invalid'), 'false');
    assert.equal(await text('#li-count-error'), '');
  }
  await page.selectOption('#li-unit', 'bytes');
  t = await set('1,00,000');
  assert.equal(Buffer.byteLength(t), 100000, 'Indian grouping 1,00,000');
  await page.selectOption('#li-unit', 'items');
  for (const [v, re] of [['0,500', /decimals are not allowed/], ['1,5', /decimals/], ['2.5', /decimals/], ['٣٫٥', /decimals/],
    ['5²', /^Enter a whole number, such as 5/], ['5\t6', /^Enter a whole number/], ['1,0000', /^Enter a whole number/], ['1,000.000', /^Enter a whole number/],
    ['-3', /at least 1/], ['0', /at least 1/], ['', /^Enter how many list items/], ['abc', /^Enter a whole number/], ['1001', /most this page makes at once is 1,000 list items/]]) {
    await set(v);
    assert.match(await text('#li-count-error'), re, JSON.stringify(v));
    assert.equal(await page.getAttribute('#li-count', 'aria-invalid'), 'true');
    assert.ok((await page.getAttribute('#li-count', 'aria-describedby')).split(' ').includes('li-count-error'));
    assert.equal(await out(), '');
    assert.equal(await page.isDisabled('#li-copy'), true);
    assert.equal(await page.isDisabled('#li-download'), true);
  }
  // The same number is fine for a unit with a higher limit; fixing the number brings the text back.
  await page.selectOption('#li-unit', 'words');
  assert.equal(await text('#li-count-error'), '');
  assert.equal(words(await out()).length, 1001);
  // A megabyte pasted into the field is refused at once, without echoing it.
  const pasteMs = await page.evaluate(() => {
    const el = document.querySelector('#li-count');
    el.value = '9'.repeat(1 << 20);
    const t0 = performance.now();
    el.dispatchEvent(new Event('change'));
    return performance.now() - t0;
  });
  assert.ok(pasteMs < 200, `megabyte paste took ${pasteMs} ms`);
  assert.match(await text('#li-count-error'), /^Enter a whole number, such as 5/);
  assert.ok((await text('#li-count-error')).length < 120);

  // ---- Copy and download always use the up-to-date text, even straight after typing ----
  await set(3, 'paragraphs', { start: true, html: false });
  await page.fill('#li-count', '2');
  await page.click('#li-copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied.split('\n\n').length, 2);
  assert.equal(copied, await out());
  // The button's own handler brings the text up to date, even when the field keeps the focus (no
  // change event), as with a click started from a script or an assistive tool.
  await page.focus('#li-count');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('1');
  await page.$eval('#li-copy', b => b.click());
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).split('\n\n').length, 1);
  await page.fill('#li-count', '4');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.$eval('#li-download', b => b.click())]);
  assert.equal(dl.suggestedFilename(), 'lorem-ipsum.txt');
  const file = fs.readFileSync(await dl.path(), 'utf8');
  assert.equal(file, await out());
  assert.equal(file.split('\n\n').length, 4);
  await page.check('#li-html');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#li-download')]);
  assert.equal(dl2.suggestedFilename(), 'lorem-ipsum.html');
  assert.equal(fs.readFileSync(await dl2.path(), 'utf8'), await out());
  await page.uncheck('#li-html');

  // ---- The summary is a live region written once per change, not on every keystroke ----
  await page.evaluate(() => {
    window.__liChanges = 0;
    new MutationObserver(() => window.__liChanges++).observe(document.querySelector('#li-summary'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#li-count', '');
  await page.locator('#li-count').pressSequentially('12', { delay: 30 });
  await page.waitForFunction(() => /^12 paragraphs/.test(document.querySelector('#li-summary').textContent));
  await page.waitForTimeout(400);
  const changes = await page.evaluate(() => window.__liChanges);
  assert.ok(changes <= 2, `summary rewritten ${changes} times`);
  await page.evaluate(() => { window.__liChanges = 0; });
  await page.selectOption('#li-length', 'medium');
  await page.locator('#li-count').dispatchEvent('change');
  assert.equal(await page.evaluate(() => window.__liChanges), 0, 'same text, summary left alone');

  // ---- Fields put back by the browser after the script ran (Back button): pageshow catches up ----
  await page.evaluate(() => {
    document.querySelector('#li-count').value = '2';
    document.querySelector('#li-unit').value = 'sentences';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(sentencesOf(await out()).length, 2);
  // And a real round trip to another page and back.
  await set(3, 'paragraphs');
  const before = await out();
  await page.goto(base + '/');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#li-output').value.length > 0);
  assert.equal(await out(), before);
  assert.equal(await page.inputValue('#li-count'), '3');

  // ---- Keyboard: every control is reachable with Tab, in order ----
  await page.focus('#li-count');
  const order = [];
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.id)); }
  assert.deepEqual(order, ['li-unit', 'li-length', 'li-start', 'li-html', 'li-generate', 'li-copy', 'li-download', 'li-output']);

  // ---- Phone with a touch screen: big targets, and select text that is not cut off ----
  const browser = page.context().browser();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await phone.setViewportSize({ width, height: 800 });
    const cut = await phone.evaluate(() => {
      const bad = [];
      const g = document.createElement('canvas').getContext('2d');
      for (const sel of document.querySelectorAll('.li select')) {
        const cs = getComputedStyle(sel);
        g.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
        for (const o of sel.options) if (g.measureText(o.text).width > room) bad.push(sel.id + ': ' + o.text);
      }
      for (const b of document.querySelectorAll('.li .btn')) if (b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().height < 44) bad.push(b.id);
      return bad;
    });
    assert.deepEqual(cut, [], `at ${width} px`);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await phone.tap('#li-generate');
  assert.equal((await phone.inputValue('#li-output')).split('\n\n').length, 5);
  await ctx.close();
};
