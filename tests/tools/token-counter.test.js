// Expected token IDs come from OpenAI's tiktoken 0.14.0 (encode_ordinary),
// computed by tests/fixtures/token-counter/make-vectors.py, not by the page.
const fs = require('fs');
const path = require('path');

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const vectors = JSON.parse(fs.readFileSync(path.join(fixtures, 'vectors.json'), 'utf8'));
  const vec = name => vectors.find(v => v.name === name);
  const text = sel => page.locator(sel).textContent();
  const fmt = n => n.toLocaleString('en-US');
  const requests = [];
  page.on('request', r => requests.push(r.url()));

  await open();
  // The default tokenizer loads by itself; the other one only on demand.
  await page.waitForFunction(() => document.querySelector('#tc-big').textContent === '0', null, { timeout: 15000 });
  assert.ok(requests.some(u => u.endsWith('/assets/data/token-counter/o200k_base.bin.gz')), 'o200k data requested');
  assert.ok(!requests.some(u => u.includes('cl100k')), 'cl100k must not load until asked for');
  assert.equal(await page.locator('#tc-n-cl100k_base button').count(), 1);
  assert.equal(await text('#tc-n-o200k_base'), '0');

  const idsText = ids => '[' + ids.join(', ') + ']';
  const setView = v => page.check(`input[name="tc-view"][value="${v}"]`);
  const expectIds = async (t, ids, label) => {
    await page.fill('#tc-input', t);
    await page.waitForFunction(exp => document.querySelector('#tc-ids-text').value === exp, idsText(ids), { timeout: 10000 })
      .catch(async () => assert.fail(`${label}: got ${await page.inputValue('#tc-ids-text')} expected ${idsText(ids)}`));
    assert.equal(await text('#tc-big'), fmt(ids.length), `${label} count`);
  };

  // Exact o200k_base IDs for every known-answer vector.
  await setView('ids');
  for (const v of vectors.filter(x => x.o)) await expectIds(v.t, v.o, `o200k ${v.name}`);

  // Characters, words, bytes and ratio for a simple case.
  await page.fill('#tc-input', 'Hello world');
  await page.waitForFunction(() => document.querySelector('#tc-big').textContent === '2');
  assert.equal(await text('#tc-chars'), '11');
  assert.equal(await text('#tc-words'), '2');
  assert.equal(await text('#tc-bytes'), '11');
  assert.equal(await text('#tc-ratio'), '5.50');
  assert.equal(await text('#tc-big-unit'), 'tokens');

  // Estimates: Anthropic's 3.5 characters per token (x1.35 for the newer
  // tokenizer) and Google's 4 characters per token.
  const seventy = 'The quick brown fox jumps over the lazy dog. Pack my box with liquor!!';
  assert.equal(seventy.length, 70);
  await page.fill('#tc-input', seventy);
  assert.equal(await text('#tc-n-claude'), `≈ ${Math.round(70 / 3.5)}–${Math.round(70 / 3.5 * 1.35)}`);
  assert.equal(await text('#tc-n-gemini'), `≈ ${Math.round(70 / 4)}`);
  assert.match(await text('#tc-est-note'), /rules of thumb for English/);
  await page.fill('#tc-input', '東京は日本の首都です。私はガラスを食べられます。それは私を傷つけません。');
  assert.match(await text('#tc-est-note'), /not in the Latin alphabet/);

  // Coloured view: token boundaries are marked by more than colour.
  await setView('vis');
  await page.fill('#tc-input', 'Hello world');
  await page.waitForFunction(() => document.querySelectorAll('#tc-vis .tc-t').length === 2);
  assert.deepEqual(await page.locator('#tc-vis .tc-t').allTextContents(), ['Hello', '·world']);
  const edge = await page.locator('#tc-vis .tc-t').first().evaluate(e => parseFloat(getComputedStyle(e).borderRightWidth));
  assert.ok(edge >= 1, 'tokens have a visible end marker');
  await page.uncheck('#tc-ws');
  assert.deepEqual(await page.locator('#tc-vis .tc-t').allTextContents(), ['Hello', ' world']);
  await page.check('#tc-ws');
  // One emoji split into three byte-level tokens (tiktoken: 4103, 104, 254) is one dashed box.
  await page.fill('#tc-input', '🫠');
  await page.waitForFunction(() => document.querySelector('#tc-big').textContent === '3');
  assert.equal(await page.locator('#tc-vis .tc-t').count(), 1);
  assert.equal(await page.locator('#tc-vis .tc-multi').textContent(), '🫠');
  assert.match(await page.locator('#tc-vis .tc-multi').getAttribute('title'), /^3 tokens: 4103, 104, 254$/);

  // Token list shows the raw bytes of partial tokens.
  await setView('list');
  const rows = page.locator('#tc-list tbody tr');
  assert.equal(await rows.count(), 3);
  assert.deepEqual(await rows.nth(0).locator('td').allTextContents(), ['1', 'bytes F0 9F', '4103']);
  assert.deepEqual(await rows.nth(2).locator('td').allTextContents(), ['3', 'bytes A0', '254']);
  await page.fill('#tc-input', 'Hello world');
  await page.waitForFunction(() => document.querySelectorAll('#tc-list tbody tr').length === 2);
  assert.deepEqual(await rows.nth(1).locator('td').allTextContents(), ['2', '·world', '2375']);

  // Long single chunks (no spaces) stay fast: the handler returns at once and
  // the worker does the heavy lifting.
  await setView('ids');
  for (const v of vectors.filter(x => x.oCount)) {
    const ms = await page.evaluate(t => {
      const el = document.querySelector('#tc-input');
      el.value = t;
      const t0 = performance.now();
      el.dispatchEvent(new Event('input'));
      return performance.now() - t0;
    }, v.t);
    assert.ok(ms < 150, `${v.name}: input handler took ${ms} ms`);
    await page.waitForFunction(n => document.querySelector('#tc-big').textContent === n, fmt(v.oCount), { timeout: 20000 });
  }

  // Load example matches tiktoken exactly.
  await page.click('#tc-example');
  assert.equal(await page.inputValue('#tc-input'), vec('example').t);
  await page.waitForFunction(exp => document.querySelector('#tc-ids-text').value === exp, idsText(vec('example').o));

  // Download the IDs as JSON.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tc-dl-ids')]);
  assert.equal(dl.suggestedFilename(), 'tokens-o200k_base.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(await dl.path(), 'utf8')), vec('example').o);

  // Files: UTF-8, UTF-16 with BOM, Windows-1252 and a binary file.
  await page.setInputFiles('#tc-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello world', 'utf8') });
  await page.waitForFunction(() => document.querySelector('#tc-input').value === 'Hello world');
  assert.match(await text('#tc-note'), /^Opened notes\.txt \(11 characters\)\.$/);
  await page.waitForFunction(() => document.querySelector('#tc-big').textContent === '2');
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Größe 東京', 'utf16le')]);
  await page.setInputFiles('#tc-file', { name: 'u16.txt', mimeType: 'text/plain', buffer: u16 });
  await page.waitForFunction(() => document.querySelector('#tc-input').value === 'Größe 東京');
  assert.match(await text('#tc-note'), /read as UTF-16/);
  await page.setInputFiles('#tc-file', { name: 'latin.txt', mimeType: 'text/plain', buffer: Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
  await page.waitForFunction(() => document.querySelector('#tc-input').value === 'café');
  assert.match(await text('#tc-note'), /read as Windows-1252/);
  await page.setInputFiles('#tc-file', { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]) });
  await page.waitForFunction(() => document.querySelector('#tc-msg').textContent.length > 0);
  assert.match(await text('#tc-msg'), /doc\.pdf is not a plain-text file/);
  assert.equal(await page.inputValue('#tc-input'), 'café');

  // cl100k_base loads on demand and matches tiktoken too.
  await page.click('#tc-n-cl100k_base button');
  await page.waitForFunction(() => /^\d/.test(document.querySelector('#tc-n-cl100k_base').textContent), null, { timeout: 15000 });
  assert.ok(requests.some(u => u.endsWith('/assets/data/token-counter/cl100k_base.bin.gz')));
  await page.selectOption('#tc-enc', 'cl100k_base');
  for (const v of vectors.filter(x => x.c)) await expectIds(v.t, v.c, `cl100k ${v.name}`);
  await expectIds('Hello world', [9906, 1917], 'cl100k hello'); // tiktoken cl100k_base
  assert.equal(await text('#tc-n-o200k_base'), '2');
  assert.equal(await text('#tc-n-cl100k_base'), '2');
  assert.equal(await text('#tc-big-note'), 'Exact count with cl100k_base');
  await page.fill('#tc-input', vec('dna').t);
  await page.waitForFunction(n => document.querySelector('#tc-n-cl100k_base').textContent === n, fmt(vec('dna').cCount), { timeout: 20000 });
  await page.waitForFunction(n => document.querySelector('#tc-n-o200k_base').textContent === n, fmt(vec('dna').oCount), { timeout: 20000 });

  // One short summary is announced after typing pauses.
  await page.selectOption('#tc-enc', 'o200k_base');
  await page.fill('#tc-input', '');
  await page.locator('#tc-input').pressSequentially('Hello world', { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#tc-status').textContent === '2 tokens with o200k_base, 11 characters', null, { timeout: 4000 });

  // A failed download shows a friendly error and a Retry button that works.
  // (A second tab, so the expected 404 isn't counted as a console error of the page under test.)
  const p2 = await page.context().newPage();
  let fail = true;
  await p2.route('**/token-counter/o200k_base.bin.gz', route => (fail ? route.fulfill({ status: 404, body: '' }) : route.continue()));
  await p2.goto(url);
  await p2.waitForFunction(() => /could not be downloaded/.test(document.querySelector('#tc-msg').textContent));
  assert.equal(await p2.textContent('#tc-big'), '–');
  assert.equal(await p2.textContent('#tc-n-o200k_base button'), 'Retry');
  fail = false;
  await p2.fill('#tc-input', 'Hello world');
  await p2.click('#tc-n-o200k_base button');
  await p2.waitForFunction(() => document.querySelector('#tc-big').textContent === '2', null, { timeout: 15000 });
  assert.equal(await p2.textContent('#tc-msg'), '');
  assert.equal(await p2.evaluate(() => document.activeElement.textContent.trim().startsWith('GPT-5')), true);
  await p2.close();

  await page.click('#tc-clear');
  await page.waitForFunction(() => document.querySelector('#tc-big').textContent === '0');
  assert.equal(await page.inputValue('#tc-input'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-input');
  assert.equal(await text('#tc-n-claude'), '0');
};
