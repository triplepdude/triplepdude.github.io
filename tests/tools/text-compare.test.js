const fs = require('fs');

module.exports = async ({ page, open, assert }) => {
  await open();

  // Sets both texts and waits for the worker's answer for exactly this input.
  const compare = async (a, b) => {
    await page.evaluate(([x, y]) => {
      const A = document.querySelector('#tc-a'), B = document.querySelector('#tc-b');
      A.value = x;
      B.value = y;
      B.dispatchEvent(new Event('input', { bubbles: true }));
    }, [a, b]);
    await settle();
  };
  // Waits until the debounce and worker round trip are done.
  const settle = () => page.waitForFunction(() => document.querySelector('#tc-out').getAttribute('aria-busy') === 'false');
  const stats = async () => {
    const n = id => page.textContent(id).then(t => Number(t.replace(/,/g, '')));
    return { added: await n('#tc-added'), removed: await n('#tc-removed'), changed: await n('#tc-changed'), same: await n('#tc-same') };
  };
  const texts = sel => page.$$eval(sel, els => els.map(e => e.textContent));
  const setOpt = async (sel, on) => { if (on) await page.check(sel); else await page.uncheck(sel); await settle(); };
  const mode = async m => { await page.check(`input[name="tc-mode"][value="${m}"]`); await settle(); };
  const view = async v => { await page.check(`input[name="tc-view"][value="${v}"]`); await settle(); };

  // Empty on load: hint visible, no output.
  assert.equal(await page.isVisible('#tc-hint'), true);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 0, same: 0 });

  // ---- The example: compared with GNU diff (2,3c2,3 / 5c5 / 10c10 / 11a12). ----
  await page.click('#tc-example');
  await settle();
  assert.deepEqual(await stats(), { added: 1, removed: 0, changed: 4, same: 7 });
  assert.equal(await page.isVisible('#tc-hint'), false);
  // Side by side: 4 paired rows plus one added row, with words highlighted inside changed lines.
  assert.equal(await page.locator('.tc-split td.tc-mk.tc-del').count(), 4);
  assert.equal(await page.locator('.tc-split td.tc-mk.tc-ins').count(), 5);
  assert.deepEqual(await texts('.tc-split td.tc-mk.tc-del'), ['-', '-', '-', '-']);
  assert.deepEqual((await texts('.tc-split del')).slice(0, 3), ['3', 'second', 'Do we need a French translation']);
  assert.deepEqual((await texts('.tc-split ins')).slice(0, 3), ['4', ', Dev', 'last']);

  // Inline view lists removed lines before their replacements.
  await view('unified');
  const marks = await texts('.tc-unified td.tc-mk');
  assert.equal(marks.filter(m => m === '-').length, 4);
  assert.equal(marks.filter(m => m === '+').length, 5);
  assert.equal(marks.join(''), '--++-+-++');
  await view('split');

  // ---- Character mode: kitten -> sitting, the classic edit distance example. ----
  await mode('char');
  await view('unified');
  await compare('kitten', 'sitting');
  const inline = await page.$$eval('.tc-flow pre del, .tc-flow pre ins', els => els.map(e => e.tagName.toLowerCase() + ':' + e.textContent));
  assert.deepEqual(inline, ['del:k', 'ins:s', 'del:e', 'ins:i', 'ins:g']);
  assert.equal(await page.textContent('#tc-tok-added'), '3');
  assert.equal(await page.textContent('#tc-tok-removed'), '2');
  assert.equal(await page.textContent('#tc-tok-added-label'), 'Characters added');
  // Graphemes: an accented letter and a flag each count as one character.
  await compare('cafe\u0301 \u{1F1EB}\u{1F1F7}', 'cafe \u{1F1E9}\u{1F1EA}');
  assert.deepEqual(await page.$$eval('.tc-flow pre del, .tc-flow pre ins', els => els.map(e => e.tagName.toLowerCase() + ':' + e.textContent)),
    ['del:e\u0301', 'ins:e', 'del:\u{1F1EB}\u{1F1F7}', 'ins:\u{1F1E9}\u{1F1EA}']);

  // ---- Word mode ----
  await mode('word');
  await compare('The quick brown fox jumps over the lazy dog.', 'The quick red fox jumped over the lazy dog!');
  assert.deepEqual(await texts('.tc-flow del'), ['brown', 'jumps', '.']);
  assert.deepEqual(await texts('.tc-flow ins'), ['red', 'jumped', '!']);
  assert.equal(await page.textContent('#tc-tok-added'), '2');
  assert.equal(await page.textContent('#tc-tok-removed'), '2');
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 0 });
  // Side by side in word mode: two panes, deletions left, insertions right.
  await view('split');
  // Pane headings sit directly under the page's h1, so they are h2 (axe heading-order).
  assert.deepEqual(await texts('.tc-pane h2'), ['Original', 'Changed']);
  assert.equal(await page.locator('#tc-out h3').count(), 0);
  assert.equal(await page.locator('.tc-pane').nth(0).locator('ins').count(), 0);
  assert.equal(await page.locator('.tc-pane').nth(1).locator('del').count(), 0);

  // ---- Ignore options ----
  await mode('line');
  await compare('Hello World\nfoo', 'hello world\nFOO');
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 2, same: 0 });
  await setOpt('#tc-case', true);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 0, same: 2 });
  assert.equal(await page.textContent('#tc-ok'), 'No differences, ignoring case.');
  await setOpt('#tc-case', false);

  await compare('a  b\n\tc\nd', 'a b\nc  \nd');
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 2, same: 1 });
  await setOpt('#tc-ws', true);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 0, same: 3 });
  assert.equal(await page.textContent('#tc-ok'), 'No differences, ignoring whitespace.');
  // "a b" and "ab" still differ: whitespace is collapsed, not deleted.
  await compare('a b', 'ab');
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 0 });
  // In word mode whitespace-only edits are not highlighted.
  await mode('word');
  await compare('one two  three', 'one  two three four');
  assert.deepEqual(await texts('.tc-flow ins'), [' four']);
  assert.equal(await page.locator('.tc-flow del').count(), 0);
  await setOpt('#tc-ws', false);
  await mode('line');

  // Identical texts, and a difference only in the final line break.
  await compare('same\ntext', 'same\ntext');
  assert.equal(await page.textContent('#tc-ok'), 'The two texts are identical.');
  await compare('abc', 'abc\n');
  assert.match(await page.textContent('#tc-ok'), /apart from a line break at the very end/);

  // ---- Patch download, compared with `diff -u` from GNU diffutils ----
  const a1 = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const b1 = a1.slice();
  b1[1] = 'line two';
  b1.splice(10, 1);
  await compare(a1.join('\n'), b1.join('\n'));
  assert.deepEqual(await stats(), { added: 0, removed: 1, changed: 1, same: 10 });
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(dl.suggestedFilename(), 'text-compare.diff');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), [
    '--- original.txt', '+++ changed.txt',
    '@@ -1,5 +1,5 @@', ' line 1', '-line 2', '+line two', ' line 3', ' line 4', ' line 5',
    '@@ -8,5 +8,4 @@', ' line 8', ' line 9', ' line 10', '-line 11', ' line 12', '\\ No newline at end of file', ''
  ].join('\n'));

  await compare('x\ny', 'x\ny\nz');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), [
    '--- original.txt', '+++ changed.txt', '@@ -1,2 +1,3 @@',
    ' x', '-y', '\\ No newline at end of file', '+y', '+z', '\\ No newline at end of file', ''
  ].join('\n'));
  // On screen the unchanged "y" is not a change: only one line was added.
  assert.deepEqual(await stats(), { added: 1, removed: 0, changed: 0, same: 2 });

  // Download straight after typing: the patch reflects the current texts, not the last comparison.
  await compare('one\ntwo\n', 'one\nTWO\n');
  [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => {
    const B = document.querySelector('#tc-b');
    B.value = 'one\nthree\n';
    B.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tc-download').click();   // before the 200 ms debounce fires
  })]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), ['--- original.txt', '+++ changed.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+three', ''].join('\n'));
  await settle();
  await compare('x\ny', 'x\ny\nz');

  // ---- Swap and clear ----
  await page.click('#tc-swap');
  await settle();
  assert.equal(await page.inputValue('#tc-a'), 'x\ny\nz');
  assert.deepEqual(await stats(), { added: 0, removed: 1, changed: 0, same: 2 });
  await page.click('#tc-clear');
  await settle();
  assert.equal(await page.inputValue('#tc-a'), '');
  assert.equal(await page.inputValue('#tc-b'), '');
  assert.equal(await page.isVisible('#tc-hint'), true);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 0, same: 0 });
  await page.click('#tc-download');
  assert.match(await page.textContent('#tc-error'), /Enter two texts first/);

  // ---- Opening files: CRLF and a byte order mark are normalized ----
  await page.setInputFiles('#tc-file-a', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFone\r\ntwo\r\n', 'utf8') });
  await page.waitForFunction(() => document.querySelector('#tc-a').value === 'one\ntwo\n');
  await page.setInputFiles('#tc-file-b', { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('one\ntwo\n', 'utf8') });
  await page.waitForFunction(() => document.querySelector('#tc-b').value === 'one\ntwo\n');
  await settle();
  assert.equal(await page.textContent('#tc-ok'), 'No differences, ignoring line endings, but only a.txt starts with a byte order mark.');
  assert.equal(await page.textContent('#tc-info-a'), 'a.txt · UTF-8 with BOM · Windows line endings (CRLF)');
  assert.equal(await page.textContent('#tc-info-b'), 'b.txt · UTF-8 · Unix line endings (LF)');
  // With line endings compared, both lines differ and each carriage return is shown as a label.
  await setOpt('#tc-eol', false);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 2, same: 0 });
  assert.deepEqual(await texts('.tc-split del .tc-inv'), ['CR', 'CR']);
  assert.equal(await page.locator('.tc-split ins').count(), 0);
  // GNU diff -u of the two files: CRLF lines keep their CR, and line 1 keeps a.txt's byte
  // order mark (regression: without it, patch rejected the hunk).
  let [eolDl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(fs.readFileSync(await eolDl.path(), 'utf8'), '--- a.txt\n+++ b.txt\n@@ -1,2 +1,2 @@\n-\uFEFFone\r\n-two\r\n+one\n+two\n');
  assert.equal(await page.textContent('#tc-ok'), '', 'no encoding note for UTF-8 files');
  await setOpt('#tc-eol', true);
  await page.setInputFiles('#tc-file-b', { name: 'bin.dat', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 0, 255]) });
  await page.waitForFunction(() => /binary/.test(document.querySelector('#tc-error').textContent));
  // UTF-16 with a byte order mark (Windows "Unicode" text) is decoded, not rejected as binary.
  await page.setInputFiles('#tc-file-a', { name: 'u16le.txt', mimeType: 'text/plain', buffer: Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('one\r\ntwo\r\n', 'utf16le')]) });
  await page.waitForFunction(() => document.querySelector('#tc-a').value === 'one\ntwo\n');
  await settle();
  assert.equal(await page.textContent('#tc-error'), '');
  assert.equal(await page.textContent('#tc-ok'), 'No differences, ignoring line endings.');
  assert.match(await page.textContent('#tc-info-a'), /^u16le\.txt \u00B7 UTF-16 LE \u00B7 Windows line endings/);
  await page.setInputFiles('#tc-file-a', { name: 'u16be.txt', mimeType: 'text/plain', buffer: Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from('caf\u00E9\n', 'utf16le').swap16()]) });
  await page.waitForFunction(() => document.querySelector('#tc-a').value === 'caf\u00E9\n');
  // Regression: the .diff is UTF-8, so it did not apply to a UTF-16 original, without a word.
  await settle();
  [eolDl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(await page.textContent('#tc-ok'), 'This patch is UTF-8 text, but u16be.txt is saved as UTF-16 BE, so save it as UTF-8 before running patch.');

  // ---- 5,000 lines: 100 edited, 20 inserted, 20 deleted ----
  const big = [], changed = [];
  for (let i = 0; i < 5000; i++) {
    const line = `Line ${i}: ${(i * 7919 % 10007).toString(36)} lorem ipsum ${i % 13} dolor`;
    big.push(line);
    if (i % 250 === 200) continue;               // deleted
    changed.push(i % 50 === 7 ? `Line ${i} was edited` : line);
    if (i % 250 === 100) changed.push(`Inserted after ${i}`);
  }
  let t0 = Date.now();
  await compare(big.join('\n'), changed.join('\n'));
  const elapsed = Date.now() - t0;
  assert.deepEqual(await stats(), { added: 20, removed: 20, changed: 100, same: 4880 });
  assert.ok(elapsed < 4000, `5,000-line compare took ${elapsed} ms`);
  // The page stays responsive while the worker computes: a reversed copy is a worst case.
  await page.evaluate(([x, y]) => {
    document.querySelector('#tc-a').value = x;
    const B = document.querySelector('#tc-b');
    B.value = y;
    B.dispatchEvent(new Event('input', { bubbles: true }));
  }, [big.join('\n'), big.slice().reverse().join('\n')]);
  await page.waitForTimeout(250);
  assert.equal(await page.getAttribute('#tc-out', 'aria-busy'), 'true');
  t0 = Date.now();
  await page.evaluate(() => 1 + 1);
  assert.ok(Date.now() - t0 < 500, 'main thread blocked during diff');
  await settle();
  const rev = await stats();
  // The longest common subsequence of a list and its reverse (all lines distinct) is one line.
  assert.equal(rev.same, 1);
  assert.equal(rev.changed + rev.removed, 4999);
  assert.equal(rev.changed + rev.added, 4999);
  // Hiding unchanged lines folds long runs.
  await compare(big.join('\n'), changed.join('\n'));
  await setOpt('#tc-hide', true);
  const folds = await texts('.tc-fold td');
  // 141 unchanged runs; the first (7 lines) and the 40 six-line runs next to an insertion or deletion stay whole.
  assert.equal(folds.length, 100);
  // Lines 0-6 are shown in full (7 lines), the run 8-56 keeps 3 + 3 lines of context.
  assert.equal(folds[0], '\u22EF 43 unchanged lines');
  const rows = await page.locator('.tc-split tr').count();
  assert.ok(rows < 2000, `expected folded output, got ${rows} rows`);
  await setOpt('#tc-hide', false);
  assert.equal(await page.locator('.tc-split tr').count(), 4880 + 100 + 20 + 20);

  // ---- Rendering 5,000 changed lines must not freeze the page ----
  // Output comes in 200-row blocks; the blocks near the screen are drawn at once and the rest a
  // few per frame. As one table this blocked the main thread for over a second, and drawn all at
  // once in blocks for 0.6 to 1.1 s; now no frame takes much over 0.1 s. Frame lengths
  // (long-animation-frame) include the layout, which long tasks leave out. Nothing may skip
  // drawing its content (content-visibility): see the paste test at the end.
  const skipping = () => page.$$eval('#tc-out *', els => [...new Set(els.filter(e => getComputedStyle(e).contentVisibility !== 'visible').map(e => e.tagName.toLowerCase() + '.' + e.className))]);
  const manyA = [], manyB = [];
  for (let i = 0; i < 5000; i++) { manyA.push(`alpha line ${i} text`); manyB.push(`beta line ${i} text`); }
  for (const v of ['split', 'unified']) {
    await view(v);
    const t = await page.evaluate(async ([a, b]) => {
      const frames = [], out = document.querySelector('#tc-out');
      const obs = new PerformanceObserver(l => l.getEntries().forEach(e => frames.push(e.duration)));
      obs.observe({ type: 'long-animation-frame' });
      // The first frame after the result lands in the page.
      let first = 0;
      const mo = new MutationObserver(() => { if (!first) { first = -1; requestAnimationFrame(() => setTimeout(() => { first = performance.now() - t0; }, 0)); } });
      mo.observe(out, { childList: true });
      document.querySelector('#tc-a').value = a;
      const B = document.querySelector('#tc-b');
      B.value = b + (B.value.endsWith('\n') ? '' : '\n');
      const t0 = performance.now();
      B.dispatchEvent(new Event('input', { bubbles: true }));
      while (first <= 0) await new Promise(r => setTimeout(r, 5));
      while (out.getAttribute('aria-busy') !== 'false') await new Promise(r => setTimeout(r, 20));
      const all = performance.now() - t0;
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      obs.disconnect();
      mo.disconnect();
      return { first, all, longest: Math.max(0, ...frames) };
    }, [manyA.join('\n'), manyB.join('\n')]);
    assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 5000, same: 0 });
    assert.ok(t.longest < 400, `${v}: a frame took ${Math.round(t.longest)} ms`);
    assert.ok(t.first < 1500, `${v}: the comparison took ${Math.round(t.first)} ms to appear`);
    assert.ok(t.all < 5000, `${v}: drawing the whole comparison took ${Math.round(t.all)} ms`);
    assert.equal(await page.locator('.tc-blk').count(), v === 'split' ? 25 : 50);
    assert.equal(await page.locator('#tc-out .tc-hole').count(), 0, 'every block drawn once settled');
    assert.deepEqual(await skipping(), [], `${v}: blocks skip drawing their content`);
  }
  // While a long result is still being drawn, the report has all of it at once, the blocks that
  // come into view are drawn before the others, and printing draws the rest at once.
  await page.check('input[name="tc-view"][value="split"]');
  await page.waitForFunction(() => document.querySelector('#tc-out .tc-split') && document.querySelector('#tc-out .tc-hole'));
  const [partialDl, drawing] = await Promise.all([page.waitForEvent('download'), page.evaluate(async () => {
    const out = document.querySelector('#tc-out'), holes = () => [...out.querySelectorAll('.tc-hole')];
    const undrawn = holes().length;
    document.querySelector('#tc-html').click();
    out.lastElementChild.scrollIntoView({ block: 'end', behavior: 'instant' });
    for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
    const left = holes().length, inView = holes().filter(h => { const b = h.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; }).length;
    window.dispatchEvent(new Event('beforeprint'));
    return { undrawn, left, inView, printed: holes().length, busy: out.getAttribute('aria-busy') };
  })]);
  assert.ok(drawing.undrawn > 1 && drawing.left > 0, `blocks still to draw: ${drawing.undrawn}, then ${drawing.left}`);
  const partial = fs.readFileSync(await partialDl.path(), 'utf8');
  assert.equal((partial.match(/<tr>/g) || []).length, 5000, 'the report has every row');
  assert.doesNotMatch(partial, /tc-hole/);
  assert.equal(drawing.inView, 0, 'the blocks in view are drawn first');
  assert.deepEqual([drawing.printed, drawing.busy], [0, 'false'], 'everything drawn before printing');
  await settle();
  // While a long result is drawn, what is on screen stays where it is, in the middle of the result
  // or below it, though a block is rarely as tall as its box was (on a phone, where lines wrap, up
  // to 3,200 px taller). The browser's own scroll anchoring let the rows on screen drift by 32,000 px
  // at 390 px wide and the guide below the result by 150,000 px; at 1280 px it holds, so it would
  // add its correction to the page's own if the page left it on.
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    for (const where of ['middle', 'below']) {
      const d = await page.evaluate(async ([a, b, where]) => {
        const out = document.querySelector('#tc-out');
        document.querySelector('#tc-a').value = a;
        const B = document.querySelector('#tc-b');
        B.value = b;
        B.dispatchEvent(new Event('input', { bubbles: true }));
        // As soon as the result is in the page, jump past the blocks still to draw.
        while (!out.querySelector('.tc-hole')) await new Promise(r => setTimeout(r, 5));
        let mark = null;
        if (where === 'below') {
          mark = document.querySelector('.prose h2');
          mark.scrollIntoView({ block: 'start', behavior: 'instant' });
        } else {
          const parts = out.querySelectorAll('.tc-hole, .tc-blk');
          parts[parts.length >> 1].scrollIntoView({ block: 'start', behavior: 'instant' });
          for (let i = 0; i < 30 && !mark; i++) {
            await new Promise(r => requestAnimationFrame(r));
            mark = [...out.querySelectorAll('tr')].find(e => { const r = e.getBoundingClientRect(); return r.top > 50 && r.top < 400; });
          }
          if (!mark) return { holes: 0, moved: 'no row came into view' };
        }
        const holes = out.querySelectorAll('.tc-hole').length, top = mark.getBoundingClientRect().top;
        while (out.getAttribute('aria-busy') !== 'false') await new Promise(r => requestAnimationFrame(r));
        return { holes, moved: Math.round(mark.getBoundingClientRect().top - top) };
      }, [manyA.join('\n'), manyB.join('\n') + '\n', where]);
      assert.ok(d.holes > 5, `${size.width} px, ${where}: ${d.holes} blocks left to draw after the jump`);
      assert.ok(Math.abs(d.moved) <= 1, `${size.width} px, ${where}: what was on screen moved ${d.moved} px while the comparison was drawn`);
    }
  }
  assert.equal(await page.evaluate(() => document.documentElement.style.overflowAnchor), '', 'scroll anchoring back on once drawn');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Word mode splits running text into blocks too.
  await mode('word');
  assert.ok(await page.locator('.tc-flow pre.tc-blk').count() > 1);
  assert.equal(await page.textContent('#tc-tok-added'), '5,000');
  assert.equal(await page.textContent('#tc-tok-removed'), '5,000');
  assert.deepEqual(await skipping(), [], 'word mode: blocks skip drawing their content');

  // ---- Very long texts: unchanged lines fold on their own, and at most 12,000 rows are drawn
  // (a 2.8 MB minified JSON laid out as 360,000 lines froze the page for 6 seconds). ----
  await mode('line');
  await view('split');
  const longA = Array.from({ length: 25000 }, (_, i) => `entry ${i}`);
  const longB = longA.slice();
  longB[12345] = 'entry changed';
  await compare(longA.join('\n'), longB.join('\n'));
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 24999 });
  assert.match(await page.textContent('#tc-status'), /Unchanged lines are folded because these texts are long/);
  assert.equal(await page.locator('.tc-split tr').count(), 9);
  assert.equal(await page.isChecked('#tc-hide'), false);
  const diffA = Array.from({ length: 13000 }, (_, i) => `left ${i}`), diffB = Array.from({ length: 13000 }, (_, i) => `right ${i}`);
  await compare(diffA.join('\n'), diffB.join('\n'));
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 13000, same: 0 });
  assert.equal(await page.locator('.tc-split tr:not(.tc-cut)').count(), 12000);
  assert.match(await page.textContent('.tc-cut'), /longer than 12,000 rows/);
  assert.match(await page.textContent('#tc-status'), /Only the first 12,000 rows are shown/);
  // Word mode still counts every changed word past the limit.
  await mode('word');
  assert.equal(await page.textContent('#tc-tok-added'), '13,000');
  assert.equal(await page.locator('.tc-flow .tc-cut').count(), 2);
  await mode('line');

  // ---- A worst-case patch (every row reordered) must not freeze the page ----
  // Download before the worker answers builds the patch on the main thread; it used to run an
  // unbounded diff (over 5 s for 20,000 reversed rows). Past its time limit the patch writes the
  // rest as whole blocks, which must still turn the original into the changed text.
  await mode('line');
  const rowsA = Array.from({ length: 20000 }, (_, i) => `row ${i}`);
  const rowsB = rowsA.slice().reverse();
  const [pdl, blocked] = await Promise.all([page.waitForEvent('download'), page.evaluate(([x, y]) => {
    document.querySelector('#tc-a').value = x;
    const B = document.querySelector('#tc-b');
    B.value = y;
    B.dispatchEvent(new Event('input', { bubbles: true }));
    const t = performance.now();
    document.querySelector('#tc-download').click();
    return performance.now() - t;
  }, [rowsA.join('\n') + '\n', rowsB.join('\n') + '\n'])]);
  assert.ok(blocked < 2000, `patch blocked the page for ${Math.round(blocked)} ms`);
  assert.match(await page.textContent('#tc-ok'), /whole removed and added blocks/);
  const applyPatch = (orig, patch) => {
    const src = orig.split('\n'), res = [];
    let pos = 0;
    const pl = patch.split('\n');
    for (let i = 2; i < pl.length; i++) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(pl[i]);
      if (h) {
        const start = +h[1] - (h[2] === '0' ? 0 : 1);
        while (pos < start) res.push(src[pos++]);
        continue;
      }
      const l = pl[i];
      if (l[0] === ' ') { assert.equal(src[pos], l.slice(1)); res.push(src[pos++]); }
      else if (l[0] === '-') { assert.equal(src[pos], l.slice(1)); pos++; }
      else if (l[0] === '+') res.push(l.slice(1));
    }
    while (pos < src.length) res.push(src[pos++]);
    return res.join('\n');
  };
  assert.equal(applyPatch(rowsA.join('\n') + '\n', fs.readFileSync(await pdl.path(), 'utf8')), rowsB.join('\n') + '\n');
  await page.waitForFunction(() => document.querySelector('#tc-out').getAttribute('aria-busy') === 'false', null, { timeout: 20000 });

  // ---- Regression: a Windows-1252 ("ANSI") file lost its accented letters (caf�). ----
  await page.setInputFiles('#tc-file-a', { name: 'ansi.txt', mimeType: 'text/plain', buffer: Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x20, 0x80, 0x0A]) });
  await page.waitForFunction(() => document.querySelector('#tc-a').value === 'café €\n');
  assert.match(await page.textContent('#tc-info-a'), /^ansi\.txt · Windows-1252 \(not valid UTF-8\)/);
  // The UTF-8 .diff does not apply to it, and the page says so; as the changed file, it
  // becomes UTF-8 when patched.
  await page.evaluate(() => {
    const B = document.querySelector('#tc-b');
    B.value = 'café €\nmore\n';
    B.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(await page.textContent('#tc-ok'), 'This patch is UTF-8 text, but ansi.txt is saved as Windows-1252, so save it as UTF-8 before running patch.');
  await page.click('#tc-swap');
  await settle();
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(await page.textContent('#tc-ok'), 'This patch is UTF-8 text, so the patched file will be UTF-8, while ansi.txt is saved as Windows-1252.');

  // ---- CRLF files: the patch keeps their line endings, as `diff -u` does, so it applies to them.
  // Reference: GNU diff 3 on the same bytes. ----
  await page.setInputFiles('#tc-file-a', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('one\r\ntwo\r\nthree\r\n') });
  await page.setInputFiles('#tc-file-b', { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('one\r\nTWO\r\nthree\r\n') });
  await page.waitForFunction(() => document.querySelector('#tc-b').value === 'one\nTWO\nthree\n');
  await settle();
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 2 });
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), '--- a.txt\n+++ b.txt\n@@ -1,3 +1,3 @@\n one\r\n-two\r\n+TWO\r\n three\r\n');
  // Editing a CRLF file keeps its line endings in the exact text, and the info line says it was edited.
  await compare('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
  assert.match(await page.textContent('#tc-info-b'), /· edited$/);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), '--- a.txt\n+++ b.txt\n@@ -1,3 +1,4 @@\n one\r\n-two\r\n+TWO\r\n three\r\n+four\r\n');
  // Swapping moves the file details with the text.
  await page.click('#tc-swap');
  await settle();
  assert.match(await page.textContent('#tc-info-a'), /^b\.txt/);
  assert.match(await page.textContent('#tc-info-b'), /^a\.txt/);

  // ---- Regression: for two UTF-8 files with a byte order mark and a changed first line, patch
  // rejected the hunk, whose first line lacked the mark. Reference: GNU diff 3 on the same bytes. ----
  await page.setInputFiles('#tc-file-a', { name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFTitle\nsecond\nthird\n', 'utf8') });
  await page.setInputFiles('#tc-file-b', { name: 'd.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFTitle changed\nsecond\nthird\n', 'utf8') });
  await page.waitForFunction(() => document.querySelector('#tc-b').value === 'Title changed\nsecond\nthird\n');
  await settle();
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 2 });
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), '--- c.txt\n+++ d.txt\n@@ -1,3 +1,3 @@\n-\uFEFFTitle\n+\uFEFFTitle changed\n second\n third\n');

  // ---- Dropping a file on a box opens it there instead of leaving the page. ----
  const drop = (sel, files) => page.evaluate(([s, list]) => {
    const dt = new DataTransfer();
    for (const [name, text] of list) dt.items.add(new File([text], name, { type: 'text/plain' }));
    const el = document.querySelector(s);
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [sel, files]);
  assert.equal(await drop('#tc-b', [['dropped.log', 'x\ny\n']]), false, 'drop default prevented');
  await page.waitForFunction(() => document.querySelector('#tc-b').value === 'x\ny\n');
  assert.match(await page.textContent('#tc-info-b'), /^dropped\.log/);
  // Two files dropped together fill both sides, in order.
  await drop('#tc-a', [['first.csv', 'id,name\n1,Ann\n'], ['second.csv', 'id,name\n1,Anne\n']]);
  await page.waitForFunction(() => document.querySelector('#tc-a').value === 'id,name\n1,Ann\n' && document.querySelector('#tc-b').value === 'id,name\n1,Anne\n');
  await settle();
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 1 });

  // ---- Invisible characters that make lines differ are drawn as labels. ----
  await page.click('#tc-clear');
  await mode('char');
  await compare('zero\u200Bwidth \u202Eflip', 'zerowidth flip');
  assert.deepEqual(await texts('.tc-flow del'), ['ZWSP', 'RLO']);
  assert.equal(await page.getAttribute('.tc-flow del .tc-inv', 'title'), 'U+200B zero width space');

  // ---- Regression: in word and character mode an empty first line of a 200-line block
  // vanished, on the page and in the report (the HTML parser drops a line break right after
  // <pre>): "\nTitle\n\nBody text.\n" showed 3 lines, a 601-line text 598. ----
  const paneLines = (p, i) => p.evaluate(k => {
    const c = document.querySelectorAll('.tc-pane')[k].cloneNode(true);
    c.querySelectorAll('h2, .tc-nl').forEach(e => e.remove());
    return c.textContent.split('\n').length - 1;
  }, i);
  for (const m of ['char', 'word']) {
    await mode(m);
    await compare('\nTitle\n\nBody text.\n', '\nTitle\n\nBody text changed.\n');
    assert.deepEqual([await paneLines(page, 0), await paneLines(page, 1)], [4, 4], `${m} mode keeps the empty first line`);
  }
  const paras = ['Intro line'];
  for (let i = 0; i < 300; i++) paras.push(`Paragraph ${i} has some words.`, '');
  await compare(paras.join('\n') + '\n', paras.join('\n').replace('Paragraph 7 ', 'Paragraph seven ') + '\n');
  assert.ok(await page.locator('.tc-pane').nth(0).locator('pre.tc-blk').count() >= 4);
  assert.deepEqual([await paneLines(page, 0), await paneLines(page, 1)], [601, 601]);
  const [bdl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-html')]);
  const blankView = await page.context().newPage();
  await blankView.setContent(fs.readFileSync(await bdl.path(), 'utf8'));
  assert.deepEqual([await paneLines(blankView, 0), await paneLines(blankView, 1)], [601, 601], 'the report keeps the empty lines');
  await blankView.close();
  await mode('line');

  // ---- JSON: parsed, keys sorted and laid out the same way. Reference: Python json.dumps
  // (indent=2, sort_keys=True) of both texts, then GNU diff -u. ----
  const jsonA = '{"name":"x","tags":["a","b"],"id":12345678901234567890,"e":"caf\\u00e9"}';
  const jsonB = '{"tags":["a","c"],"id":12345678901234567891,"name":"x","e":"café"}';
  assert.equal(await page.isDisabled('#tc-sort'), true);
  await compare(jsonA, jsonB);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 1, same: 0 });
  await setOpt('#tc-json', true);
  assert.equal(await page.isDisabled('#tc-sort'), false);
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 2, same: 7 });
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-download')]);
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), ['--- original.json', '+++ changed.json', '@@ -1,9 +1,9 @@', ' {', '   "e": "café",',
    '-  "id": 12345678901234567890,', '+  "id": 12345678901234567891,', '   "name": "x",', '   "tags": [', '     "a",', '-    "b"', '+    "c"', '   ]', ' }', ''].join('\n'));
  // Same data, different key order, spacing, number spelling and escapes: equivalent.
  await compare('{"b": 1, "a": [1, 2, {"y": true, "x": null}], "n": 1.0, "k": 1e3, "s": "\\u00e9"}', '{"s":"é","k":1000,"n":1,"a":[1,2,{"x":null,"y":true}],"b":1}');
  assert.deepEqual(await stats(), { added: 0, removed: 0, changed: 0, same: 14 });
  assert.equal(await page.textContent('#tc-ok'), 'The JSON is equivalent: the texts differ only in formatting or key order.');
  await setOpt('#tc-sort', false);
  assert.ok((await stats()).changed + (await stats()).added > 0, 'key order counts when not sorted');
  await setOpt('#tc-sort', true);
  // Comments and trailing commas (tsconfig style) are accepted.
  await compare('{\n  // compiler\n  "strict": true, /* on */\n  "lib": ["dom",],\n}', '{"lib":["dom"],"strict":true}');
  assert.equal(await page.textContent('#tc-ok'), 'The JSON is equivalent: the texts differ only in formatting or key order.');
  assert.equal(await page.textContent('#tc-json-msg'), '');
  // Invalid JSON: Python reports "Expecting value: line 4 column 1"; the texts are compared as plain text.
  await compare('{\n  "a": 1,\n  "b": \n}', '{"a": 1}');
  assert.equal(await page.textContent('#tc-json-msg'), 'Original text is not valid JSON: unexpected "}" at line 4, column 1. The texts are compared as plain text instead.');
  assert.equal(await page.getAttribute('#tc-json-msg', 'role'), null);
  assert.deepEqual(await stats(), { added: 0, removed: 3, changed: 1, same: 0 });
  await compare('[1, 2', '[1, 2]');
  assert.match(await page.textContent('#tc-json-msg'), /^Original text is not valid JSON: the text ends before the array is closed at line 1, column 6\./);
  // Duplicate keys: the last value counts, as in JavaScript, and they are pointed out.
  await compare('{"a": 1, "a": 2}', '{"a": 2}');
  assert.equal(await page.textContent('#tc-ok'), 'The JSON is equivalent: the texts differ only in formatting or key order.');
  assert.equal(await page.textContent('#tc-json-msg'), 'Duplicate key: "a" (original text, line 1, column 10). The last value of each is compared.');
  await setOpt('#tc-json', false);
  assert.equal(await page.textContent('#tc-json-msg'), '');

  // ---- HTML report: the comparison as shown, self-contained. ----
  await page.click('#tc-example');
  await settle();
  const [hdl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-html')]);
  assert.equal(hdl.suggestedFilename(), 'text-compare.html');
  const report = fs.readFileSync(await hdl.path(), 'utf8');
  assert.match(report, /^<!doctype html>/);
  assert.match(report, /<title>Comparison of original\.txt and changed\.txt<\/title>/);
  assert.match(report, /<li class="add"><b>1<\/b> line added<\/li><li class="del"><b>0<\/b> lines removed<\/li><li class=""><b>4<\/b> lines changed<\/li>/);
  assert.doesNotMatch(report, /(?:src|href)=|@import|url\(/, 'no external resources');
  const viewer = await page.context().newPage();
  await viewer.setContent(report);
  assert.deepEqual((await viewer.$$eval('.tc-out del', els => els.map(e => e.textContent))).slice(0, 3), ['3', 'second', 'Do we need a French translation']);
  const delBg = await viewer.$eval('.tc-out del', el => getComputedStyle(el).backgroundColor);
  assert.notEqual(delBg, 'rgba(0, 0, 0, 0)', 'styles travel with the report');
  await viewer.close();
  // Saving right after typing waits for the comparison, then saves the new result.
  const [hdl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => {
    const B = document.querySelector('#tc-b');
    B.value = 'completely new';
    B.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tc-html').click();
  })]);
  assert.match(fs.readFileSync(await hdl2.path(), 'utf8'), /completely new/);
  await settle();

  // ---- Screen readers hear one summary after the result settles, not the whole stats grid. ----
  assert.equal(await page.getAttribute('.tc-stats', 'aria-live'), null);
  await compare('a\nb\nc', 'a\nB\nc\nd');
  await page.waitForFunction(() => document.querySelector('#tc-announce').textContent === '1 line added, 0 removed, 1 changed.');
  await page.click('#tc-clear');
  await settle();
  assert.equal(await page.textContent('#tc-info-a'), '');

  // The focused segment of "Compare by" shows a ring whether or not it is the checked (filled) one.
  await page.focus('input[name="tc-mode"]:checked');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = () => page.$eval('input[name="tc-mode"]:focus-visible', el => getComputedStyle(el.closest('label')).boxShadow);
  assert.match(await ring(), /inset.*inset/);
  await page.keyboard.press('ArrowRight');
  await settle();
  assert.match(await ring(), /inset.*inset/);

  // The two file buttons have distinct accessible names.
  assert.equal(await page.getAttribute('[data-file="#tc-file-a"]', 'aria-label'), 'Open file as original text');
  assert.equal(await page.getAttribute('[data-file="#tc-file-b"]', 'aria-label'), 'Open file as changed text');

  // ---- Regression: with a long comparison on screen, select all and paste 5,000 lines over 5,000
  // in a box took 5 s. The result's off-screen blocks skipped their layout (content-visibility:
  // auto), and while anything in the page skips its content that way, Chromium is slow to replace
  // a long text in a text box. The old text ends with a line break, as pasted text usually does:
  // without one, Chromium is fast either way. The comparison stays on screen for the runner's
  // checks (skippedContent in tests/run.js, and phone widths). ----
  await mode('line');
  await view('split');
  const lines = (word, n) => `${word} line\n`.repeat(n);
  await compare(lines('old', 5000), '');
  assert.equal(await page.locator('.tc-blk').count(), 25);
  await page.evaluate(text => navigator.clipboard.writeText(text), lines('new', 5000));
  await page.evaluate(() => { const A = document.querySelector('#tc-a'); A.focus(); A.select(); });
  const pasteStart = Date.now();
  await page.keyboard.press('ControlOrMeta+V');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  const pasteMs = Date.now() - pasteStart;
  assert.equal(await page.inputValue('#tc-a'), lines('new', 5000), 'the paste replaced the text');
  assert.ok(pasteMs < 1000, `pasting 5,000 lines over 5,000 took ${pasteMs} ms (1,000 allowed)`);
  await settle();
  assert.deepEqual(await stats(), { added: 0, removed: 5000, changed: 0, same: 0 });
  assert.equal(await page.locator('.tc-blk').count(), 25);
  // Deleting it took 3 s.
  await page.evaluate(() => { const A = document.querySelector('#tc-a'); A.focus(); A.select(); });
  const deleteStart = Date.now();
  await page.keyboard.press('Delete');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  const deleteMs = Date.now() - deleteStart;
  assert.equal(await page.inputValue('#tc-a'), '', 'the text was deleted');
  assert.ok(deleteMs < 1000, `deleting 5,000 lines took ${deleteMs} ms (1,000 allowed)`);
  await compare(lines('new', 5000), '');
  assert.equal(await page.locator('.tc-blk').count(), 25);
};
