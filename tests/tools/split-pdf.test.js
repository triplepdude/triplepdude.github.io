const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Fixtures (tests/fixtures/split-pdf, made by make_fixtures.py with reportlab and pikepdf/qpdf):
// ten.pdf has 10 pages, A4 except page 10 (Letter landscape), page 4 with /Rotate 90, each with the
// marker SPLIT-MARK-NN and its own incompressible picture (expected.json gives the picture's bytes).
// Page 1 links to page 10, page 2 to a web address, page 3 has a sticky note whose /P is page 3,
// page 5 links to page 6 through the named destination "sec6", and page 7 to page 8 through a
// /GoTo action. locked.pdf needs the password "open sesame" (AES-256), restricted.pdf has only an
// owner password (AES-128), sixty.pdf has 60 pages, damaged.pdf is not a PDF inside. shared.pdf has
// 3 pages that share one resource dictionary with all three pictures, and form fields with one parent.
// The tool writes with pdf-lib; outputs are read back with pdf.js, an independent reader, for page
// order (markers), sizes, /Rotate, links and encryption. A file's size shows whose pictures it holds:
// a plain page copy follows page 1's link and carries a hidden copy of page 10 with its picture.

// The text of a PDF file with every Flate stream inflated (object streams too), to search it.
function allText(buf) {
  const raw = buf.toString('latin1');
  let text = raw, at = 0;
  for (;;) {
    const s = raw.indexOf('stream', at);
    if (s < 0) break;
    let b = s + 6;
    if (raw[b] === '\r') b++;
    if (raw[b] === '\n') b++;
    const e = raw.indexOf('endstream', b);
    if (e < 0) break;
    try { text += zlib.inflateSync(buf.subarray(b, e)).toString('latin1'); } catch (err) { /* not deflated */ }
    at = e + 9;
  }
  return text;
}

function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const fx = n => path.join(fixtures, n);
  const expectedAll = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  const expected = expectedAll.ten.pages;
  const pictures = list => list.reduce((s, n) => s + expected[n - 1].image_bytes, 0);
  await open();
  assert.equal(await page.isVisible('#spl-drop'), true);
  assert.equal(await page.isVisible('#spl-work'), false);

  // Reads a PDF with pdf.js: markers, rotation, size, annotations (link targets as page numbers).
  const inspect = buf => page.evaluate(async b64 => {
    const lib = await import('/assets/vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.js';
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const task = lib.getDocument({ data, verbosity: 0 });
    const doc = await task.promise;
    const meta = await doc.getMetadata();
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const text = (await pg.getTextContent()).items.map(t => t.str).join(' ');
      const anns = [], ids = [];
      for (const a of await pg.getAnnotations()) {
        ids.push(a.id);
        let s = a.subtype;
        if (a.url) s += ' ' + a.url;
        if (Array.isArray(a.dest) && a.dest[0] && typeof a.dest[0] === 'object') s += ' ->' + (await doc.getPageIndex(a.dest[0]) + 1);
        if (a.contentsObj && a.contentsObj.str) s += ' "' + a.contentsObj.str + '"';
        anns.push(s);
      }
      pages.push({ mark: (text.match(/[A-Z]+-MARK-\d+/) || [''])[0].replace(/^SPLIT-MARK-/, ''), rotate: pg.rotate, size: Math.round(pg.view[2] - pg.view[0]) + 'x' + Math.round(pg.view[3] - pg.view[1]), anns, ids });
    }
    await task.destroy();
    return { encrypted: !!meta.info.EncryptFilterName, title: meta.info.Title, producer: meta.info.Producer, pages };
  }, buf.toString('base64'));
  const marks = async buf => (await inspect(buf)).pages.map(p => p.mark);
  const save = async (sel = '#spl-split') => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  const text = sel => page.textContent(sel);
  const plan = () => text('#spl-plan');
  const tags = () => page.$$eval('.spl-tag', l => l.map(e => e.textContent));
  const setMode = m => page.click(`.spl-seg label:has(input[value="${m}"])`);
  const fieldError = async id => page.evaluate(id => {
    const f = document.getElementById(id), box = document.getElementById(id + '-error');
    return { text: box.textContent, invalid: f.getAttribute('aria-invalid'), linked: (f.getAttribute('aria-describedby') || '').split(/\s+/).includes(id + '-error') };
  }, id);
  const open10 = async () => {
    await page.setInputFiles('#spl-file', fx('ten.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('.spl-page').length === 10 && /ten\.pdf is open/.test(document.getElementById('spl-status').textContent));
  };

  // ---- Files that cannot be split ----
  await page.setInputFiles('#spl-file', { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
  await page.waitForFunction(() => document.getElementById('spl-error').textContent === 'empty.pdf is empty.');
  // A file over 1 GB is refused before it is read (its size is faked, as a real one is too big for a test).
  await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(Blob.prototype, 'size');
    Object.defineProperty(Blob.prototype, 'size', { configurable: true, get() { return this.name === 'huge.pdf' ? 1073741825 : d.get.call(this); } });
    window.__restoreSize = () => Object.defineProperty(Blob.prototype, 'size', d);
  });
  await page.setInputFiles('#spl-file', { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
  await page.waitForFunction(() => document.getElementById('spl-error').textContent === 'huge.pdf is larger than 1 GB.');
  await page.evaluate(() => window.__restoreSize());
  await page.setInputFiles('#spl-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello, not a pdf') });
  await page.waitForFunction(() => /notes\.txt is not a PDF file/.test(document.getElementById('spl-error').textContent));
  await page.setInputFiles('#spl-file', fx('damaged.pdf'));
  await page.waitForFunction(() => /damaged\.pdf is damaged or is not a valid PDF/.test(document.getElementById('spl-error').textContent));
  assert.equal(await page.isVisible('#spl-work'), false);

  // ---- A password to open: missing, wrong, right ----
  await page.setInputFiles('#spl-file', fx('locked.pdf'));
  await page.waitForSelector('#spl-unlock:not([hidden])');
  assert.equal(await page.textContent('#spl-error'), '', 'a new file clears the old error');
  assert.match(await text('#spl-status'), /locked\.pdf is protected with a password/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'spl-pw');
  assert.equal(await text('#spl-pw-label'), 'Password for locked.pdf');
  await page.click('#spl-pw-go');
  assert.deepEqual(await fieldError('spl-pw'), { text: 'Type the password first.', invalid: 'true', linked: true });
  await page.fill('#spl-pw', 'not it');
  assert.equal(await page.getAttribute('#spl-pw', 'aria-invalid'), null, 'typing clears the error');
  await page.press('#spl-pw', 'Enter');
  await page.waitForFunction(() => /not right/.test(document.getElementById('spl-pw-error').textContent));
  assert.deepEqual(await fieldError('spl-pw'), { text: 'That password is not right. Check it and try again.', invalid: 'true', linked: true });
  // A megabyte pasted into the password field stops at 1,024 characters: a PDF uses at most 127 bytes of
  // a password, and a field holding a megabyte makes the browser slow to draw it.
  await page.focus('#spl-pw');
  await page.keyboard.insertText('x'.repeat(1048576));
  assert.equal(await page.$eval('#spl-pw', el => el.value.length), 1024);
  assert.equal(await page.getAttribute('#spl-pw', 'aria-invalid'), null, 'typing clears the error');
  await page.press('#spl-pw', 'Enter');
  await page.waitForFunction(() => /not right/.test(document.getElementById('spl-pw-error').textContent));
  await page.fill('#spl-pw', 'open sesame');
  await page.click('#spl-pw-go');
  await page.waitForFunction(() => document.querySelectorAll('.spl-page').length === 3);
  assert.equal(await page.isVisible('#spl-unlock'), false);
  assert.equal(await text('#spl-meta'), '3 pages · 3.4\u00a0KB · unlocked', 'a no-break space keeps a size and its unit together');
  assert.equal(await page.inputValue('#spl-ranges'), '1-2, 3');
  await setMode('each');
  let out = await save();
  assert.equal(out.name, 'locked-split.zip');
  let entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['locked-page-1.pdf', 'locked-page-2.pdf', 'locked-page-3.pdf']);
  let pdf = await inspect(entries[2].data);
  assert.equal(pdf.encrypted, false, 'the split files have no password');
  assert.deepEqual(pdf.pages.map(p => p.mark), ['LOCKED-MARK-03']);

  // An owner password only: opened and split without asking.
  await page.setInputFiles('#spl-file', fx('restricted.pdf'));
  await page.waitForFunction(() => /restricted\.pdf is open: 2 pages, unlocked/.test(document.getElementById('spl-status').textContent));
  assert.equal(await page.isVisible('#spl-unlock'), false);
  assert.equal(await page.isChecked('input[value="each"]'), true, 'the chosen way to split is kept for the next file');
  await setMode('ranges');
  assert.equal(await page.inputValue('#spl-ranges'), '1, 2', 'untouched ranges follow the new file');
  await page.fill('#spl-ranges', '2');
  out = await save();
  assert.equal(out.name, 'restricted-page-2.pdf');
  pdf = await inspect(out.buf);
  assert.deepEqual([pdf.encrypted, pdf.pages.length, pdf.pages[0].mark], [false, 1, 'RESTRICTED-MARK-02']);

  // ---- ten.pdf: the suggested halves, labels and the summary ----
  await page.fill('#spl-ranges', '');
  await open10();
  assert.equal(await page.inputValue('#spl-ranges'), '1-5, 6-10');
  assert.equal(await text('#spl-meta'), '10 pages · 364\u00a0KB');
  assert.equal(await plan(), '2 PDFs: pages 1–5 and 6–10.');
  assert.equal(await text('#spl-split'), 'Split into 2 PDFs');
  assert.deepEqual(await tags(), ['PDF 1', 'PDF 1', 'PDF 1', 'PDF 1', 'PDF 1', 'PDF 2', 'PDF 2', 'PDF 2', 'PDF 2', 'PDF 2']);
  await page.waitForFunction(() => [...document.querySelectorAll('.spl-thumb img')].slice(0, 4).every(i => i.complete && i.naturalWidth > 0));
  assert.deepEqual(await page.$$eval('.spl-thumb img', l => l.slice(2, 4).map(i => i.naturalWidth > i.naturalHeight ? 'wide' : 'tall')), ['tall', 'wide'], 'page 4 is drawn turned by its /Rotate');

  // The summary is a live region: it is written only when it changes.
  await page.evaluate(() => {
    window.__planWrites = [];
    const el = document.getElementById('spl-plan');
    new MutationObserver(() => window.__planWrites.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#spl-ranges', '1-3, 10');
  await page.type('#spl-ranges', ' ');
  await page.fill('#spl-ranges', '1-3,10');
  assert.deepEqual(await page.evaluate(() => window.__planWrites.splice(0)), ['2 PDFs: pages 1–3 and 10.']);
  assert.deepEqual(await tags(), ['PDF 1', 'PDF 1', 'PDF 1', 'Left out', 'Left out', 'Left out', 'Left out', 'Left out', 'Left out', 'PDF 2']);
  assert.equal(await page.$$eval('.spl-page.is-out', l => l.length), 6);

  // Two files in a ZIP. Page 1's link to page 10 points outside its file and is dropped; the web
  // link, the note and page 10's size are kept, and each file holds only its own pictures.
  out = await save();
  assert.equal(out.name, 'ten-split.zip');
  entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-pages-01-03.pdf', 'ten-page-10.pdf']);
  pdf = await inspect(entries[0].data);
  assert.deepEqual(pdf.pages.map(p => p.mark), ['01', '02', '03']);
  assert.deepEqual(pdf.pages.map(p => p.anns), [[], ['Link https://example.com/split'], ['Text "Note on page 3"']]);
  assert.equal(pdf.title, 'Ten pages');
  assert.match(pdf.producer, /TripleP Tools/);
  assert.ok(entries[0].data.length > pictures([1, 2, 3]) && entries[0].data.length < pictures([1, 2, 3]) + 6000, `pages 1-3 hold their own pictures only (${entries[0].data.length} bytes)`);
  assert.ok(entries[1].data.length < pictures([10]) + 6000, `page 10 alone is small (${entries[1].data.length} bytes)`);
  assert.deepEqual((await inspect(entries[1].data)).pages.map(p => p.size), ['792x612']);
  assert.match(await text('#spl-status'), /^Saved ten-split\.zip with 2 PDFs, [\d.]+\u00a0KB\.$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'spl-split');
  // Each file of the ZIP can also be downloaded on its own, byte for byte the same.
  assert.equal(await text('#spl-results-h'), 'Your files');
  assert.equal(await text('#spl-results-note'), '2 PDFs, saved together as ten-split.zip.');
  assert.deepEqual(await page.$$eval('#spl-out button', l => l.map(b => b.getAttribute('aria-label'))), ['Download ten-pages-01-03.pdf', 'Download ten-page-10.pdf']);
  const single = await save('#spl-out li:nth-child(2) button');
  assert.equal(single.name, 'ten-page-10.pdf');
  assert.ok(single.buf.equals(entries[1].data));
  const again = await save('#spl-zip');
  assert.ok(again.buf.equals(out.buf));

  // Merged: one file in the typed order, and page 1's link now points at page 10, the new page 4.
  // The same files typed another way are not a change; a real change marks the list as earlier files.
  await page.fill('#spl-ranges', ' 1 - 3 ; end ');
  assert.equal(await page.$eval('#spl-results', e => e.className), 'spl-results');
  await page.check('#spl-merge');
  assert.equal(await page.$eval('#spl-results', e => e.className), 'spl-results is-stale');
  assert.equal(await text('#spl-results-note'), 'From your last split. The settings have changed since; split again for files that match them.');
  await page.uncheck('#spl-merge');
  assert.equal(await text('#spl-results-note'), '2 PDFs, saved together as ten-split.zip.', 'going back to the same settings makes the list current again');
  await page.check('#spl-merge');
  assert.equal(await plan(), '1 PDF with 4 pages: 1–3 and 10.');
  assert.equal(await text('#spl-split'), 'Extract 4 pages');
  assert.equal((await tags())[9], 'In the PDF');
  out = await save();
  assert.equal(out.name, 'ten-extracted.pdf');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.pages.map(p => p.mark), ['01', '02', '03', '10']);
  assert.deepEqual(pdf.pages.map(p => p.anns)[0], ['Link ->4']);
  assert.ok(out.buf.length < pictures([1, 2, 3, 10]) + 6000, `the merged file holds 4 pictures (${out.buf.length} bytes)`);
  await page.uncheck('#spl-merge');

  // Named destinations and /GoTo actions are followed inside a file; reversed and open ranges.
  await page.fill('#spl-ranges', '5-6; 7 to 8, 7, 4');
  assert.equal(await plan(), '4 PDFs: pages 5–6, 7–8, 7 and 4.');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-pages-05-06.pdf', 'ten-pages-07-08.pdf', 'ten-page-07.pdf', 'ten-page-04.pdf']);
  assert.deepEqual((await inspect(entries[0].data)).pages[0].anns, ['Link ->2']);
  assert.deepEqual((await inspect(entries[1].data)).pages[0].anns, ['Link ->2']);
  assert.deepEqual((await inspect(entries[2].data)).pages[0].anns, []);
  pdf = await inspect(entries[3].data);
  assert.deepEqual([pdf.pages[0].mark, pdf.pages[0].rotate, pdf.pages[0].size], ['04', 90, '595x842']);
  await page.fill('#spl-ranges', '3-1, 8-, -2, END');
  assert.equal(await plan(), '4 PDFs: pages 3–1, 8–10, 1–2 and 10.');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-pages-03-01.pdf', 'ten-pages-08-10.pdf', 'ten-pages-01-02.pdf', 'ten-page-10.pdf']);
  assert.deepEqual(await marks(entries[0].data), ['03', '02', '01']);
  assert.deepEqual(await marks(entries[1].data), ['08', '09', '10']);
  // The same range twice makes two files with different names, in the list as in the ZIP.
  await page.fill('#spl-ranges', '1, 1');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-page-01.pdf', 'ten-page-01 (2).pdf']);
  assert.deepEqual(await page.$$eval('#spl-out .spl-out-name', l => l.map(e => e.textContent)), ['ten-page-01.pdf', 'ten-page-01 (2).pdf']);
  assert.equal((await save('#spl-out li:nth-child(2) button')).name, 'ten-page-01 (2).pdf');
  // The same page twice in one file: both copies are there, each with its own annotation.
  await page.fill('#spl-ranges', '3, 3');
  await page.check('#spl-merge');
  pdf = await inspect((await save()).buf);
  assert.deepEqual(pdf.pages.map(p => p.mark + ' ' + p.anns.join()), ['03 Text "Note on page 3"', '03 Text "Note on page 3"']);
  assert.notEqual(pdf.pages[0].ids[0], pdf.pages[1].ids[0], 'an annotation object sits on one page only (ISO 32000-1, 12.5.2)');
  await page.uncheck('#spl-merge');

  // Other ways to type numbers: full-width and Arabic-Indic digits, an ideographic comma, a tab.
  await page.fill('#spl-ranges', '１－３、٥');
  assert.equal(await plan(), '2 PDFs: pages 1–3 and 5.');
  await page.fill('#spl-ranges', '1\t3');
  assert.equal(await plan(), '2 PDFs: pages 1 and 3.');
  await page.fill('#spl-ranges', '0000000001, 00000000000000000003');
  assert.equal(await plan(), '2 PDFs: pages 1 and 3.', 'leading zeros do not make a number too long');

  // ---- Mistakes in the ranges: shown after a pause, at once on Split, and cleared when fixed ----
  const bad = [
    ['0', 'There is no page 0: the first page is 1.'],
    ['1,000', 'There is no page 0: the first page is 1.'],
    ['0,500', 'There is no page 0: the first page is 1.'],
    ['4-11', 'Page 11 does not exist: this PDF has 10 pages.'],
    ['99999999999999', 'Page 999999999999… does not exist: this PDF has 10 pages.'],
    ['1-3, x', '“x” is not a page number. Use numbers, dashes and commas, such as 1-3, 5.'],
    ['5²', '“²” cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.'],
    ['2.5', '“.” cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.'],
    ['1, 😀', '“😀” cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.'],
    ['1--3', 'Two dashes in a row: write a range as 4-7.'],
    ['-', 'A dash needs a page number before or after it, as in 4-7.'],
    ['1-3-5', 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.'],
    ['2, 4-6 -8', 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.'],
    ['all-5', 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.'],
    ['5-all', 'A range ends with a page number or “end”, as in 5-end.'],
    ['000000000011', 'Page 11 does not exist: this PDF has 10 pages.'],
    ['1\u200b2', 'A hidden character (U+200B) cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.'],
  ];
  for (const [value, message] of bad) {
    await page.fill('#spl-ranges', value);
    await page.waitForFunction(() => document.getElementById('spl-ranges-error').textContent !== '');
    const got = await fieldError('spl-ranges');
    assert.deepEqual(got, { text: message, invalid: 'true', linked: true }, `${value}: ${JSON.stringify(got)}`);
    assert.equal(await plan(), '', value);
    assert.equal(await text('#spl-split'), 'Split PDF');
  }
  assert.deepEqual(await tags(), ['PDF 1', 'Left out', 'PDF 2', 'Left out', 'Left out', 'Left out', 'Left out', 'Left out', 'Left out', 'Left out'], 'labels keep the last good plan (1 and 3) while the ranges are wrong');
  await page.fill('#spl-ranges', '2-3');
  assert.deepEqual(await fieldError('spl-ranges'), { text: '', invalid: null, linked: true });
  // While typing, a list that is not finished yet ("1-1" on the way to "1-10") is not flagged at once.
  await page.fill('#spl-ranges', '1-1');
  await page.type('#spl-ranges', '1');
  assert.deepEqual(await fieldError('spl-ranges'), { text: '', invalid: null, linked: true }, 'no message before a pause in typing');
  await page.waitForFunction(() => document.getElementById('spl-ranges-error').textContent !== '');
  assert.equal((await fieldError('spl-ranges')).text, 'Page 11 does not exist: this PDF has 10 pages.');
  await page.fill('#spl-ranges', '2-3');
  // Split with a mistake: the message shows at once, the field gets the focus and nothing is saved.
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.fill('#spl-ranges', '12');
  await page.click('#spl-split');
  assert.equal((await fieldError('spl-ranges')).text, 'Page 12 does not exist: this PDF has 10 pages.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'spl-ranges');
  await page.fill('#spl-ranges', '');
  await page.click('#spl-split');
  assert.deepEqual(await fieldError('spl-ranges'), { text: 'Type the page ranges to split, such as 1-3, 4-6.', invalid: 'true', linked: true });
  await page.waitForTimeout(300);
  assert.equal(downloads, 0);
  // A megabyte pasted into each field is refused quickly, and kept as it was typed.
  for (const [id, mode, filler] of [['spl-ranges', 'ranges', '1, '], ['spl-ranges', 'ranges', ' '], ['spl-pick', 'select', '7-'], ['spl-every', 'fixed', '2']]) {
    await setMode(mode);
    const big = filler.repeat(Math.ceil(1048576 / filler.length));
    const t0 = Date.now();
    await page.$eval('#' + id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, big);
    await page.waitForFunction(id => document.getElementById(id + '-error').textContent !== '', id);
    const err = await fieldError(id);
    assert.ok(Date.now() - t0 < 3000, `a megabyte in #${id} is handled quickly`);
    assert.equal(err.invalid, 'true', id);
    assert.match(err.text, mode === 'fixed' ? /^Enter a whole number of pages/ : /^This list is 1,04\d,\d{3} characters long\. Keep it under 10,000 characters\.$/);
    assert.equal(await page.$eval('#' + id, el => el.value.length), big.length);
    await page.fill('#' + id, mode === 'fixed' ? '2' : '');
  }

  // ---- Every N pages ----
  await setMode('fixed');
  assert.equal(await plan(), '5 PDFs of 2 pages each.');
  assert.deepEqual(await tags(), ['PDF 1', 'PDF 1', 'PDF 2', 'PDF 2', 'PDF 3', 'PDF 3', 'PDF 4', 'PDF 4', 'PDF 5', 'PDF 5']);
  out = await save();
  entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-pages-01-02.pdf', 'ten-pages-03-04.pdf', 'ten-pages-05-06.pdf', 'ten-pages-07-08.pdf', 'ten-pages-09-10.pdf']);
  assert.deepEqual(await marks(entries[1].data), ['03', '04']);
  await page.fill('#spl-every', '3');
  assert.equal(await plan(), '4 PDFs of 3 pages, the last one with 1 page.');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-pages-01-03.pdf', 'ten-pages-04-06.pdf', 'ten-pages-07-09.pdf', 'ten-page-10.pdf']);
  await page.fill('#spl-every', '15');
  assert.equal(await plan(), '1 PDF with all 10 pages, as the PDF has no more pages than that.');
  assert.equal(await text('#spl-split'), 'Save 1 PDF');
  for (const [value, message] of [['0', 'Each PDF needs at least 1 page.'], ['2.5', 'Enter a whole number of pages, such as 2.'], ['-2', 'Enter a whole number of pages, such as 2.'], ['2²', 'Enter a whole number of pages, such as 2.']]) {
    await page.fill('#spl-every', value);
    await page.waitForFunction(() => document.getElementById('spl-every-error').textContent !== '');
    assert.deepEqual(await fieldError('spl-every'), { text: message, invalid: 'true', linked: true }, value);
  }
  await page.fill('#spl-every', '４');
  assert.equal(await plan(), '3 PDFs of 4 pages, the last one with 2 pages.');
  await page.fill('#spl-every', '0000000002');
  assert.equal(await plan(), '5 PDFs of 2 pages each.', 'leading zeros do not make a number too long');
  await page.fill('#spl-every', '99999999999');
  assert.equal(await plan(), '1 PDF with all 10 pages, as the PDF has no more pages than that.');

  // ---- Every page ----
  await setMode('each');
  assert.equal(await plan(), '10 PDFs, one for each page.');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), Array.from({ length: 10 }, (_, i) => `ten-page-${String(i + 1).padStart(2, '0')}.pdf`));
  for (const i of [0, 3, 9]) {
    assert.deepEqual(await marks(entries[i].data), [expected[i].mark.slice(-2)]);
    assert.ok(entries[i].data.length < pictures([i + 1]) + 6000, `page ${i + 1} alone holds one picture (${entries[i].data.length} bytes)`);
  }

  // ---- Select pages: clicks, a drag, Shift+click, the quick buttons, typing, the keyboard ----
  await setMode('select');
  assert.equal(await page.inputValue('#spl-pick'), '');
  assert.equal(await plan(), 'Select at least one page: click it below or type its number.');
  assert.equal((await fieldError('spl-pick')).invalid, null, 'an empty selection is not an error until Split is pressed');
  await page.click('.spl-page:nth-child(2) .spl-thumb');
  await page.click('.spl-page:nth-child(5) .spl-thumb');
  assert.equal(await page.inputValue('#spl-pick'), '2, 5');
  assert.equal(await plan(), '2 pages selected (2 and 5), saved as 1 PDF.');
  assert.equal(await text('#spl-split'), 'Extract 2 pages');
  assert.deepEqual(await page.$$eval('.spl-check', l => l.map(c => c.checked)), [false, true, false, false, true, false, false, false, false, false]);
  out = await save();
  assert.equal(out.name, 'ten-extracted.pdf');
  assert.deepEqual(await marks(out.buf), ['02', '05']);
  // Drag with the mouse from page 6 to page 8, then Shift+click page 10.
  const box = async n => (await page.$(`.spl-page:nth-child(${n}) .spl-thumb`)).boundingBox();
  await page.$eval('.spl-page:nth-child(6)', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const b6 = await box(6), b8 = await box(8);
  await page.mouse.move(b6.x + 30, b6.y + 40);
  await page.mouse.down();
  await page.mouse.move(b6.x + 60, b6.y + 50, { steps: 3 });
  await page.mouse.move(b8.x + 30, b8.y + 40, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.inputValue('#spl-pick'), '2, 5-8');
  await page.click('.spl-page:nth-child(10) .spl-thumb', { modifiers: ['Shift'] });
  assert.equal(await page.inputValue('#spl-pick'), '2, 5-10');
  // A drag that starts on a selected page clears the pages it passes.
  const b9 = await box(9), b7 = await box(7);
  await page.mouse.move(b9.x + 30, b9.y + 40);
  await page.mouse.down();
  await page.mouse.move(b7.x + 30, b7.y + 40, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.inputValue('#spl-pick'), '2, 5-6, 10');
  for (const [btn, value] of [['odd', '1, 3, 5, 7, 9'], ['invert', '2, 4, 6, 8, 10'], ['none', ''], ['all', '1-10'], ['even', '2, 4, 6, 8, 10']]) {
    await page.click(`[data-pick="${btn}"]`);
    assert.equal(await page.inputValue('#spl-pick'), value, btn);
  }
  await page.fill('#spl-pick', '4, 1, 3-4');
  assert.deepEqual(await page.$$eval('.spl-page.is-selected', l => l.map(e => Number(e.dataset.i) + 1)), [1, 3, 4]);
  await page.uncheck('#spl-one');
  assert.equal(await plan(), '3 pages selected (1 and 3–4), saved as 3 PDFs.');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), ['ten-page-01.pdf', 'ten-page-03.pdf', 'ten-page-04.pdf']);
  await page.check('#spl-one');
  // Keyboard: every page's checkbox is a tab stop, and Space ticks it.
  await page.focus('.spl-page:nth-child(7) .spl-check');
  await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#spl-pick'), '1, 3-4, 7');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 8');
  await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#spl-pick'), '1, 3-4, 7-8');
  // Enter in the field splits, as the button does.
  await page.focus('#spl-pick');
  const [dlEnter] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.deepEqual(await marks(fs.readFileSync(await dlEnter.path())), ['01', '03', '04', '07', '08']);
  await page.click('[data-pick="none"]');
  await page.click('#spl-split');
  assert.deepEqual(await fieldError('spl-pick'), { text: 'Select at least one page: click it below or type its number.', invalid: 'true', linked: true });

  // ---- Cancel stops a split; the next one still works ----
  await setMode('each');
  const during = await page.evaluate(() => {
    let stopped = 0;
    const terminate = Worker.prototype.terminate;
    Worker.prototype.terminate = function () { stopped++; return terminate.call(this); };
    document.getElementById('spl-split').click();
    const ids = ['spl-split', 'spl-another', 'spl-ranges', 'spl-every', 'spl-pick', 'spl-merge', 'spl-one'];
    const off = ids.filter(id => document.getElementById(id).disabled).length + [...document.querySelectorAll('input[name="spl-mode"], [data-pick], .spl-check')].filter(e => e.disabled).length;
    const all = ids.length + document.querySelectorAll('input[name="spl-mode"], [data-pick], .spl-check').length;
    const cancelShown = !document.getElementById('spl-cancel').hidden;
    document.getElementById('spl-cancel').click();
    Worker.prototype.terminate = terminate;
    return { off, all, cancelShown, stopped };
  });
  assert.equal(during.off, during.all, 'every control that changes the split is disabled while it runs');
  assert.deepEqual([during.cancelShown, during.stopped], [true, 1], 'Cancel is offered and stops the splitter at once');
  await page.waitForFunction(() => document.getElementById('spl-status').textContent === 'Cancelled. Nothing was saved.');
  assert.equal(await page.$$eval('input[name="spl-mode"], #spl-ranges, .spl-check', l => l.filter(e => e.disabled).length), 0, 'the controls work again');
  assert.equal(await page.isVisible('#spl-progress'), false);
  assert.equal(await page.isDisabled('#spl-split'), false);
  assert.equal(unzip((await save()).buf).length, 10);

  // ---- Dropped files: one PDF at a time; a big file draws only the thumbnails in view ----
  const drop = list => page.evaluate(files => {
    const dt = new DataTransfer();
    for (const [name, b64] of files) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, list);
  await drop([['first.txt', Buffer.from('plain text').toString('base64')]]);
  await page.waitForFunction(() => /first\.txt is not a PDF file/.test(document.getElementById('spl-error').textContent));
  assert.equal(await page.$$eval('.spl-page', l => l.length), 10, 'the open PDF stays open');
  await drop([['sixty.pdf', fs.readFileSync(fx('sixty.pdf')).toString('base64')], ['restricted.pdf', fs.readFileSync(fx('restricted.pdf')).toString('base64')]]);
  await page.waitForFunction(() => document.querySelectorAll('.spl-page').length === 60);
  assert.equal(await text('#spl-error'), 'This tool splits one PDF at a time, so only sixty.pdf was opened.');
  await page.waitForTimeout(600);
  const drawn = await page.$$eval('.spl-thumb img', l => l.filter(i => i.getAttribute('src')).length);
  assert.ok(drawn > 0 && drawn < 60, `only thumbnails in view are drawn (${drawn})`);
  await page.$eval('.spl-page:last-child', el => el.scrollIntoView());
  await page.waitForFunction(() => { const i = document.querySelector('.spl-page:last-child img'); return i.complete && i.naturalWidth > 0; });
  assert.equal(await plan(), '60 PDFs, one for each page.');
  entries = unzip((await save()).buf);
  assert.equal(entries.length, 60);
  assert.deepEqual([entries[0].name, entries[59].name], ['sixty-page-01.pdf', 'sixty-page-60.pdf']);
  assert.deepEqual(await marks(entries[59].data), ['SIXTY-MARK-60']);

  // ---- The limits of one split, on a PDF of 10,001 small pages ----
  // Every page would make 10,001 files (the limit is 10,000): there is no field to mark in this mode,
  // so the summary says it, and so does Split.
  const manyPages = n => {
    const objs = ['', '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Length 22 >>\nstream\n0 0 1 rg 10 10 50 50 re f\nendstream'];
    const kids = [];
    for (let i = 0; i < n; i++) { kids.push((4 + i) + ' 0 R'); objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 3 0 R >>'); }
    objs[2] = '<< /Type /Pages /Count ' + n + ' /Kids [' + kids.join(' ') + '] >>';
    let body = '%PDF-1.4\n';
    const offs = [];
    for (let i = 1; i < objs.length; i++) { offs[i] = body.length; body += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    const xref = body.length;
    body += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n' + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    return Buffer.from(body + 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n', 'latin1');
  };
  await page.setInputFiles('#spl-file', { name: 'many.pdf', mimeType: 'application/pdf', buffer: manyPages(10001) });
  await page.waitForFunction(() => document.querySelectorAll('.spl-page').length === 10001 && /many\.pdf is open/.test(document.getElementById('spl-status').textContent), null, { timeout: 60000 });
  await setMode('each');
  assert.equal(await plan(), 'That makes 10,001 PDFs; one split can make up to 10,000.');
  assert.equal(await text('#spl-split'), 'Split PDF');
  const before = downloads;
  await page.click('#spl-split');
  await page.waitForTimeout(300);
  assert.equal(downloads, before, 'nothing is saved');
  assert.equal(await plan(), 'That makes 10,001 PDFs; one split can make up to 10,000.');
  await setMode('ranges');
  await page.fill('#spl-ranges', 'all, all');
  await page.waitForFunction(() => document.getElementById('spl-ranges-error').textContent !== '');
  assert.equal((await fieldError('spl-ranges')).text, 'That puts 20,002 pages into the new files; one split can hold up to 20,000.');
  await page.fill('#spl-ranges', 'all, 1-9999');
  assert.equal(await plan(), '2 PDFs: pages 1–10001 and 1–9999.', '20,000 pages in all is allowed');
  // Counting comes first: 2,500 times every page (25 million pages) is refused without listing the pages
  // one by one, which on a phone can use more memory than the tab has. The work is measured by the
  // number of items added to lists while the input is handled.
  await page.fill('#spl-ranges', '1');
  const added = await page.$eval('#spl-ranges', (el, v) => {
    const push = Array.prototype.push;
    let n = 0;
    Array.prototype.push = function (...a) { n += a.length; return push.apply(this, a); };
    try { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } finally { Array.prototype.push = push; }
    return n;
  }, 'all,'.repeat(2499) + 'all');
  assert.ok(added < 100000, `every page 2,500 times is counted, not listed (${added} items listed)`);
  await page.waitForFunction(() => document.getElementById('spl-ranges-error').textContent !== '');
  assert.equal((await fieldError('spl-ranges')).text, 'That puts 25,002,500 pages into the new files; one split can hold up to 20,000.');
  await setMode('select');
  await page.click('[data-pick="all"]');
  await page.uncheck('#spl-one');
  await page.waitForFunction(() => document.getElementById('spl-pick-error').textContent !== '');
  assert.equal((await fieldError('spl-pick')).text, 'That makes 10,001 PDFs; one split can make up to 10,000.');
  await page.check('#spl-one');
  assert.equal(await plan(), '10,001 pages selected (1–10001), saved as 1 PDF.');
  await setMode('each');

  // ---- Pages that share one resource dictionary, and form fields with one parent ----
  // Each file holds only the picture its page draws (page 3's through a form that uses the page's
  // resources), and the value of a field on page 2 does not travel with page 1, neither through
  // their parent field nor through the catalog that page 1's signature value refers to.
  await page.setInputFiles('#spl-file', fx('shared.pdf'));
  await page.waitForFunction(() => /shared\.pdf is open: 3 pages/.test(document.getElementById('spl-status').textContent));
  assert.equal(await plan(), '3 PDFs, one for each page.');
  entries = unzip((await save()).buf);
  const picture = expectedAll.shared.image_bytes;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await marks(entries[i].data), [`SHARED-MARK-${i + 1}`]);
    assert.ok(entries[i].data.length > picture[i] && entries[i].data.length < picture[i] + 6000, `page ${i + 1} holds one picture (${entries[i].data.length} bytes)`);
  }
  const redLevel = async buf => page.evaluate(async b64 => {
    const lib = await import('/assets/vendor/pdfjs/pdf.min.js');
    const task = lib.getDocument({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), verbosity: 0 });
    const pg = await (await task.promise).getPage(1);
    const vp = pg.getViewport({ scale: 0.5 }), c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp }).promise;
    const d = c.getContext('2d').getImageData(55, 76, 95, 95).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i];
    await task.destroy();
    return sum / (d.length / 4);
  }, buf.toString('base64'));
  const level = await redLevel(entries[2].data);
  assert.ok(level > 90 && level < 165, `page 3 still draws its picture (mean red ${level.toFixed(1)})`);
  assert.ok(allText(entries[0].data).includes('Alice Example'), 'the field on page 1 is kept');
  assert.ok(!allText(entries[0].data).includes('SHARED-SECRET-2'), 'the field on page 2 is not in the file of page 1');
  await page.click('.spl-seg label:has(input[value="ranges"])');
  await page.fill('#spl-ranges', '1-2');
  out = await save();
  assert.ok(allText(out.buf).includes('SHARED-SECRET-2'), 'a file with page 2 has its field');
  assert.ok(out.buf.length > picture[0] + picture[1] && out.buf.length < picture[0] + picture[1] + 6000, `pages 1-2 hold two pictures (${out.buf.length} bytes)`);
  await page.click('.spl-seg label:has(input[value="each"])');

  // ---- The sample PDF, offered while no PDF is open; the drop area hides once one is ----
  assert.equal(await page.isVisible('#spl-drop'), false);
  await open();
  await page.click('#spl-sample');
  await page.waitForFunction(() => document.querySelectorAll('.spl-page').length === 12);
  assert.equal(await page.inputValue('#spl-ranges'), '1-6, 7-12');
  assert.equal(await text('#spl-name'), 'sample.pdf');
  out = await save();
  assert.deepEqual(unzip(out.buf).map(e => e.name), ['sample-pages-01-06.pdf', 'sample-pages-07-12.pdf']);

  // ---- A phone with a touch screen: tap a page, touch and hold another and drag ----
  const browser = page.context().browser();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true, locale: 'de-DE' });
  const p2 = await phone.newPage();
  const errors = [];
  p2.on('pageerror', e => errors.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p2.goto(url);
  await p2.setInputFiles('#spl-file', fx('ten.pdf'));
  await p2.waitForFunction(() => document.querySelectorAll('.spl-page').length === 10);
  // A browser set to German, with a decimal comma: "1,5" is still pages 1 and 5.
  assert.equal(await p2.evaluate(() => (1.5).toLocaleString()), '1,5');
  await p2.fill('#spl-ranges', '1,5');
  assert.equal(await p2.textContent('#spl-plan'), '2 PDFs: pages 1 and 5.');
  // Labels of the four ways to split fit their buttons at every common phone width.
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p2.setViewportSize({ width, height: 844 });
    const cut = await p2.$$eval('.spl-seg label, .spl-quick .btn, #spl-split, .spl-file .btn', l => l.filter(e => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map(e => e.textContent.trim()));
    assert.deepEqual(cut, [], `nothing cut off at ${width}px`);
    assert.ok(await p2.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px`);
  }
  await p2.setViewportSize({ width: 390, height: 844 });
  assert.ok((await p2.$eval('.spl-seg label', e => e.getBoundingClientRect().height)) >= 44);
  await p2.tap('.spl-seg label:has(input[value="select"])');
  assert.equal(await p2.isChecked('input[value="select"]'), true);
  await p2.$eval('.spl-page:nth-child(4)', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p2.tap('.spl-page:nth-child(3) .spl-thumb');
  assert.equal(await p2.inputValue('#spl-pick'), '3');
  const cdp = await phone.newCDPSession(p2);
  const t4 = await (await p2.$('.spl-page:nth-child(4) .spl-thumb')).boundingBox();
  const t6 = await (await p2.$('.spl-page:nth-child(6) .spl-thumb')).boundingBox();
  const scrollBefore = await p2.evaluate(() => scrollY);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', t4.x + 20, t4.y + 30);
  await p2.waitForTimeout(700);
  for (let s = 1; s <= 6; s++) await touch('touchMove', t4.x + 20 + (t6.x - t4.x) * s / 6, t4.y + 30 + (t6.y - t4.y) * s / 6);
  await touch('touchEnd');
  assert.equal(await p2.inputValue('#spl-pick'), '3-6', 'touch and hold, then drag, selects pages 4 to 6');
  assert.equal(await p2.evaluate(() => scrollY), scrollBefore, 'the page did not scroll during the drag');
  // A quick swipe scrolls and selects nothing.
  await touch('touchStart', t6.x + 20, t6.y + 60);
  for (let s = 1; s <= 5; s++) await touch('touchMove', t6.x + 20, t6.y + 60 - s * 40);
  await touch('touchEnd');
  await p2.waitForTimeout(600);
  assert.equal(await p2.inputValue('#spl-pick'), '3-6');
  const [dlPhone] = await Promise.all([p2.waitForEvent('download'), p2.tap('#spl-split')]);
  assert.deepEqual(await marks(fs.readFileSync(await dlPhone.path())), ['03', '04', '05', '06']);
  // A long file name wraps at 320 px: in the password prompt, the summary and the list of results.
  const longName = 'Quarterly_report_final_version_with_all_appendices_and_signatures_reviewed_by_legal';
  await p2.setViewportSize({ width: 320, height: 640 });
  await p2.setInputFiles('#spl-file', { name: longName + '.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('locked.pdf')) });
  await p2.waitForSelector('#spl-unlock:not([hidden])');
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 320), 'the password prompt fits at 320px');
  await p2.fill('#spl-pw', 'open sesame');
  await p2.press('#spl-pw', 'Enter');
  await p2.waitForFunction(() => !document.getElementById('spl-work').hidden);
  await p2.tap('.spl-seg label:has(input[value="each"])');
  await Promise.all([p2.waitForEvent('download'), p2.tap('#spl-split')]);
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 320), 'the results fit at 320px');
  assert.deepEqual(errors, []);
  await phone.close();
};
