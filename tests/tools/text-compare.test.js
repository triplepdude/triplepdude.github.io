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
  assert.deepEqual(await texts('.tc-pane h3'), ['Original', 'Changed']);
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
  assert.equal(await page.textContent('#tc-ok'), 'The two texts are identical.');
  await page.setInputFiles('#tc-file-b', { name: 'bin.dat', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 0, 255]) });
  await page.waitForFunction(() => /binary/.test(document.querySelector('#tc-error').textContent));

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
};
