const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Fixtures (tests/fixtures/merge-pdf) were made with reportlab and pikepdf/qpdf: alpha.pdf (3 A4
// pages), bravo.pdf (2 Letter pages, the second with /Rotate 90), locked.pdf (AES-256 R6, user
// password "open sesame", object streams), restricted.pdf (AES-128, owner password only, one
// landscape A4 page), many.pdf (40 pages), damaged.pdf, inherit.pdf (2 pages that inherit /Rotate 90
// from the page tree) and oddrot.pdf (page 1 has the invalid /Rotate 45, page 2 /Rotate -90). Every page shows its label in large
// text ("Alpha 2"). Outputs are read back with pdf.js, an independent reader (the tool writes with
// pdf-lib), checking page order, text, /Rotate, links and encryption. Sizes are in points: A4 595 x 842,
// Letter 612 x 792. ten.pdf and shared.pdf are copies of the Split PDF tool's fixtures (made by
// tests/fixtures/split-pdf/make_fixtures.py, described where they are used); fonts.pdf is made by
// make_fonts.py here, and pdfdoc-password.pdf (RC4 128-bit, open password "café€" in PDFDocEncoding)
// and utf8-password.pdf (AES-256, open password "パスワード１２３" in UTF-8) by make_passwords.py.

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

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = n => path.join(fixtures, n);
  // PDF.js fetches CMaps, fonts and the CMYK profile from the site only when a PDF needs them.
  const fetched = [];
  page.on('response', r => { if (/pdfjs-resources/.test(r.url())) fetched.push(r.status() + ' ' + r.url().replace(/^.*pdfjs-resources\//, '')); });
  await open();
  assert.equal(await page.isVisible('#mpdf-drop'), true);
  assert.equal(await page.isVisible('#mpdf-work'), false);
  // Rotate PDF turns pages without copying them, keeping bookmarks and form fields: linked where the guide rotates.
  assert.deepEqual(await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href'))), ['/image-to-pdf/', '/rotate-pdf/', '/split-pdf/', '/pdf-to-jpg/', '/unlock-pdf/']);
  assert.match(await page.$eval('.prose a[href="/rotate-pdf/"]', a => a.closest('li').textContent), /^Rotate or remove pages:/);

  // Reads a PDF with pdf.js: page texts, rotations, sizes, annotations (link targets as page
  // numbers, with the annotation ids) and whether it is encrypted.
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
      const tc = await pg.getTextContent();
      const anns = [], ids = [];
      for (const a of await pg.getAnnotations()) {
        ids.push(a.id);
        let s = a.subtype;
        if (a.url) s += ' ' + a.url;
        if (Array.isArray(a.dest) && a.dest[0] && typeof a.dest[0] === 'object') s += ' ->' + (await doc.getPageIndex(a.dest[0]) + 1);
        if (a.contentsObj && a.contentsObj.str) s += ' "' + a.contentsObj.str + '"';
        anns.push(s);
      }
      pages.push({ text: tc.items.map(t => t.str).join(' ').replace(/\s+/g, ' ').split(' Fixture')[0].trim(), rotate: pg.rotate, size: Math.round(pg.view[2]) + 'x' + Math.round(pg.view[3]), anns: anns.join(), ids });
    }
    await task.destroy();
    const info = {};
    for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) if (meta.info[k] !== undefined) info[k] = meta.info[k];
    return { encrypted: !!meta.info.EncryptFilterName, producer: meta.info.Producer, info, pages };
  }, buf.toString('base64'));
  // Walks every object of a PDF with pdf-lib: the pages in the page tree, the page objects in the
  // file (a page that is not in the tree is a hidden copy) and the pictures; with withResources, also
  // the number of different resource dictionaries the pages use.
  const objects = (buf, withResources) => page.evaluate(async ([b64, withRes]) => {
    if (!window.PDFLib) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/assets/vendor/pdf-lib/pdf-lib.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const L = window.PDFLib, doc = await L.PDFDocument.load(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    let pageObjects = 0, pictures = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const d = obj instanceof L.PDFDict ? obj : obj.dict;
      if (!(d instanceof L.PDFDict)) continue;
      if (d.get(L.PDFName.of('Type')) === L.PDFName.of('Page')) pageObjects++;
      if (d.get(L.PDFName.of('Subtype')) === L.PDFName.of('Image')) pictures++;
    }
    const r = { pages: doc.getPageCount(), pageObjects, pictures };
    if (withRes) r.resources = new Set(doc.getPages().map(p => p.node.get(L.PDFName.of('Resources')))).size;
    return r;
  }, [buf.toString('base64'), !!withResources]);
  const save = async sel => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  const labels = () => page.$$eval('.mpdf-src', l => l.map(e => e.textContent.replace(/\.pdf · p\. /, ' ')));
  const metas = () => page.$$eval('.mpdf-file-meta', l => l.map(e => e.textContent));
  // The selection count is a live region, and the page list is redrawn several times for each file
  // added and at every move or rotation: the count may be written only when it changes, because a
  // screen reader reads it out at every write.
  await page.evaluate(() => {
    window.__selWrites = [];
    const el = document.getElementById('mpdf-selinfo');
    new MutationObserver(records => records.forEach(() => window.__selWrites.push(el.textContent)))
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
  const selWrites = () => page.evaluate(() => window.__selWrites.splice(0));

  // ---- Not a PDF, damaged, encrypted and ordinary files ----
  await page.setInputFiles('#mpdf-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello, not a pdf') });
  await page.waitForFunction(() => /notes\.txt is not a PDF file/.test(document.getElementById('mpdf-error').textContent));
  assert.equal(await page.isVisible('#mpdf-work'), false);

  await page.setInputFiles('#mpdf-file', [fx('alpha.pdf'), fx('bravo.pdf'), fx('restricted.pdf'), fx('locked.pdf'), fx('damaged.pdf')]);
  // Files are read one after another; the damaged one comes last and is then reported and dropped.
  await page.waitForFunction(() => /damaged\.pdf/.test(document.getElementById('mpdf-error').textContent) &&
    document.querySelectorAll('.mpdf-file').length === 4 && !/Reading/.test(document.getElementById('mpdf-files').textContent));
  assert.match(await page.textContent('#mpdf-error'), /damaged\.pdf is damaged or is not a valid PDF/);
  assert.deepEqual(await metas(), ['3 pages · 3.2 KB', '2 pages · 2.2 KB', '1 page · 1.6 KB · unlocked', 'Password protected: enter the password that opens it']);
  assert.equal(await page.inputValue('#mpdf-name'), 'merged.pdf');
  assert.deepEqual(await labels(), ['alpha 1', 'alpha 2', 'alpha 3', 'bravo 1', 'bravo 2', 'restricted 1']);
  // Merging now would need the locked file's password: it is not part of the pages yet, so it merges fine.
  await page.fill('.mpdf-unlock input', 'not it');
  await page.press('.mpdf-unlock input', 'Enter');
  await page.waitForFunction(() => /wrong password/.test(document.getElementById('mpdf-files').textContent));
  assert.equal(await page.evaluate(() => document.activeElement.type), 'password');
  await page.fill('.mpdf-unlock input', 'open sesame');
  await page.click('.mpdf-unlock-btn');
  await page.waitForFunction(() => document.querySelectorAll('.mpdf-page').length === 8);
  assert.match(await page.textContent('#mpdf-status'), /Unlocked locked\.pdf: 2 pages added/);
  assert.equal((await metas())[3], '2 pages · 2.1 KB · unlocked');
  assert.equal(await page.textContent('#mpdf-pages-info'), '8 pages');
  // Thumbnails are drawn by pdf.js; the source rotation of bravo p. 2 is drawn in, not added by CSS.
  await page.waitForFunction(() => [...document.querySelectorAll('.mpdf-thumb img')].slice(0, 6).every(i => i.complete && i.naturalWidth > 0));
  const dims = await page.$$eval('.mpdf-thumb img', l => l.slice(3, 5).map(i => i.naturalWidth > i.naturalHeight ? 'wide' : 'tall'));
  assert.deepEqual(dims, ['tall', 'wide']);

  // ---- Merge everything: order, source rotation kept, decrypted, unencrypted output ----
  let out = await save('#mpdf-merge');
  assert.equal(out.name, 'merged.pdf');
  assert.equal(out.buf.subarray(0, 5).toString(), '%PDF-');
  let pdf = await inspect(out.buf);
  assert.equal(pdf.encrypted, false);
  assert.deepEqual(pdf.pages.map(p => p.text), ['Alpha 1', 'Alpha 2', 'Alpha 3', 'Bravo 1', 'Bravo 2', 'Restricted 1', 'Locked 1', 'Locked 2']);
  assert.deepEqual(pdf.pages.map(p => p.rotate), [0, 0, 0, 0, 90, 0, 0, 0]);
  assert.deepEqual(pdf.pages.map(p => p.size), ['595x842', '595x842', '595x842', '612x792', '612x792', '842x595', '595x842', '595x842']);
  assert.match(await page.textContent('#mpdf-status'), /^Saved merged\.pdf: 8 pages, [\d.]+ KB\.$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mpdf-merge');

  // ---- Organising: files, single pages, selection, undo ----
  await page.click('.mpdf-file:nth-child(2) .mpdf-fup');       // bravo before alpha
  assert.deepEqual(await labels(), ['bravo 1', 'bravo 2', 'alpha 1', 'alpha 2', 'alpha 3', 'restricted 1', 'locked 1', 'locked 2']);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Move bravo.pdf down');
  await page.click('.mpdf-page:nth-child(3) .mpdf-down');       // alpha 1 after alpha 2
  assert.deepEqual((await labels()).slice(2, 4), ['alpha 2', 'alpha 1']);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Move page 4 later');
  await page.click('.mpdf-page:nth-child(1) .mpdf-rr');          // bravo 1: +90
  await page.click('.mpdf-page:nth-child(2) .mpdf-rl');          // bravo 2: 90 - 90 = 0
  await page.click('.mpdf-page:nth-child(6) .mpdf-rr');
  await page.click('.mpdf-page:nth-child(6) .mpdf-rr');          // restricted 1: +180
  assert.equal(await page.$eval('.mpdf-page:nth-child(6) img', i => i.style.transform), 'rotate(180deg)');
  await page.click('.mpdf-page:nth-child(8) .mpdf-del');         // drop locked 2
  assert.equal(await page.textContent('#mpdf-pages-info'), '7 pages');
  assert.match(await page.textContent('#mpdf-status'), /Removed locked\.pdf, page 2\. Undo brings it back\./);
  await page.click('#mpdf-undo');
  assert.equal(await page.textContent('#mpdf-pages-info'), '8 pages');
  await page.click('.mpdf-page:nth-child(8) .mpdf-del');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove page 7 (locked.pdf, page 1)');
  out = await save('#mpdf-merge');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.pages.map(p => p.text + '@' + p.rotate), ['Bravo 1@90', 'Bravo 2@0', 'Alpha 2@0', 'Alpha 1@0', 'Alpha 3@0', 'Restricted 1@180', 'Locked 1@0']);

  // Drag with the mouse: page 1 onto page 3.
  const b1 = await (await page.$('.mpdf-page:nth-child(1) .mpdf-thumb')).boundingBox();
  const b3 = await (await page.$('.mpdf-page:nth-child(3) .mpdf-thumb')).boundingBox();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width / 2 + 20, b1.y + b1.height / 2, { steps: 3 });
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.deepEqual((await labels()).slice(0, 3), ['bravo 2', 'alpha 2', 'bravo 1']);
  await page.keyboard.press('Control+z');
  assert.deepEqual((await labels()).slice(0, 3), ['bravo 1', 'bravo 2', 'alpha 2']);

  // Select pages 1 and 3 (checkbox, then a click on the thumbnail), rotate them left, save just those.
  assert.equal(await page.textContent('#mpdf-selinfo'), 'No pages selected');
  assert.deepEqual(await selWrites(), [], 'adding, moving and rotating pages did not write the unchanged selection count again');
  await page.check('.mpdf-page:nth-child(1) .mpdf-check');
  await page.click('.mpdf-page:nth-child(3) .mpdf-thumb', { position: { x: 60, y: 80 } });
  assert.equal(await page.textContent('#mpdf-selinfo'), '2 pages selected');
  await page.click('#mpdf-rotl');
  out = await save('#mpdf-extract');
  assert.equal(out.name, 'merged-selected.pdf');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.pages.map(p => p.text + '@' + p.rotate), ['Bravo 1@0', 'Alpha 2@270']);
  await page.click('#mpdf-selnone');
  assert.deepEqual(await selWrites(), ['1 page selected', '2 pages selected', 'No pages selected'], 'the count is written once for each change');
  assert.equal(await page.isDisabled('#mpdf-extract'), true);
  await page.click('#mpdf-reverse');
  assert.deepEqual(await labels(), ['locked 1', 'restricted 1', 'alpha 3', 'alpha 1', 'alpha 2', 'bravo 2', 'bravo 1']);
  await page.click('#mpdf-sort');
  // Sorting groups the pages by file in name order, each file keeping its current page order.
  assert.deepEqual(await labels(), ['alpha 3', 'alpha 1', 'alpha 2', 'bravo 2', 'bravo 1', 'locked 1', 'restricted 1']);
  assert.deepEqual(await page.$$eval('.mpdf-file-name', l => l.map(e => e.textContent)), ['alpha.pdf', 'bravo.pdf', 'locked.pdf', 'restricted.pdf']);

  // ---- Splitting into a ZIP ----
  await page.fill('#mpdf-name', 'report.pdf');
  assert.equal(await page.isVisible('#mpdf-every'), false);
  out = await save('#mpdf-split');
  assert.equal(out.name, 'report-split.zip');
  let entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['report-page-1.pdf', 'report-page-2.pdf', 'report-page-3.pdf', 'report-page-4.pdf', 'report-page-5.pdf', 'report-page-6.pdf', 'report-page-7.pdf']);
  pdf = await inspect(entries[3].data);
  assert.equal(pdf.pages.length, 1);
  assert.equal(pdf.pages[0].text, 'Bravo 2');
  await page.selectOption('#mpdf-split-mode', 'every');
  await page.fill('#mpdf-every', '3');
  out = await save('#mpdf-split');
  entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['report-pages-1-3.pdf', 'report-pages-4-6.pdf', 'report-pages-7.pdf']);
  assert.deepEqual((await inspect(entries[1].data)).pages.map(p => p.text), ['Bravo 2', 'Bravo 1', 'Locked 1']);
  await page.fill('#mpdf-every', '0');
  await page.click('#mpdf-split');
  assert.match(await page.textContent('#mpdf-error'), /from 1 to 9999/);
  await page.selectOption('#mpdf-split-mode', 'files');
  out = await save('#mpdf-split');
  entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['alpha.pdf', 'bravo.pdf', 'locked.pdf', 'restricted.pdf']);
  assert.deepEqual((await inspect(entries[0].data)).pages.map(p => p.text + '@' + p.rotate), ['Alpha 3@0', 'Alpha 1@0', 'Alpha 2@270']);

  // ---- Removing a file, undo, and a big file with lazy thumbnails ----
  await page.click('.mpdf-file:nth-child(3) .mpdf-fdel');
  assert.deepEqual(await page.$$eval('.mpdf-file-name', l => l.map(e => e.textContent)), ['alpha.pdf', 'bravo.pdf', 'restricted.pdf']);
  assert.equal(await page.textContent('#mpdf-pages-info'), '6 pages');
  await page.click('#mpdf-undo');
  assert.equal(await page.textContent('#mpdf-pages-info'), '7 pages');
  await page.click('#mpdf-clear');
  assert.equal(await page.isVisible('#mpdf-work'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mpdf-choose');
  await page.setInputFiles('#mpdf-file', fx('many.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.mpdf-page').length === 40);
  await page.waitForTimeout(800);
  const drawn = await page.$$eval('.mpdf-thumb img', l => l.filter(i => i.getAttribute('src')).length);
  assert.ok(drawn > 0 && drawn < 40, `only visible thumbnails are drawn (${drawn})`);
  await page.$eval('.mpdf-page:last-child', el => el.scrollIntoView());
  await page.waitForFunction(() => { const i = document.querySelector('.mpdf-page:last-child img'); return i.complete && i.naturalWidth > 0; });
  assert.equal(await page.inputValue('#mpdf-name'), 'report.pdf', 'a name the user typed is kept');
  await page.fill('#mpdf-name', 'forty');
  out = await save('#mpdf-merge');
  assert.equal(out.name, 'forty.pdf');
  pdf = await inspect(out.buf);
  assert.equal(pdf.pages.length, 40);
  assert.equal(pdf.pages[39].text, 'Many 40');
  // Only the tool's name: none of many.pdf's document properties, and no date of making, which
  // would tell anyone given the file when it was made, to the second.
  assert.deepEqual(pdf.info, { Creator: 'TripleP Tools Merge PDF', Producer: 'TripleP Tools (pdf-lib)' });

  // ---- Rotation read from the page tree, and invalid /Rotate values ----
  // ISO 32000-1 7.7.3.3: /Rotate is inheritable and must be a multiple of 90; readers treat 45 as 0
  // and -90 as 270. A bad value once made the whole merge fail.
  await page.click('#mpdf-clear');
  await page.setInputFiles('#mpdf-file', [fx('inherit.pdf'), fx('oddrot.pdf')]);
  await page.waitForFunction(() => document.querySelectorAll('.mpdf-page').length === 4);
  await page.click('.mpdf-page:nth-child(1) .mpdf-rr');
  out = await save('#mpdf-merge');
  assert.equal(await page.textContent('#mpdf-error'), '');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.pages.map(p => p.text + '@' + p.rotate), ['Inh 1@180', 'Inh 2@90', 'Odd 1@0', 'Odd 2@270']);

  // ---- Links: a new file holds only its own pages, and its links lead to them ----
  // ten.pdf has 10 pages, each with its own incompressible picture of 36,321 bytes, so a file's size
  // shows whose pictures it holds. Page 1 links to page 10, page 2 to a web address, page 3 has a
  // note whose /P is page 3, page 5 links to page 6 through the named destination "sec6" and page 7
  // to page 8 through a /GoTo action. A plain page copy follows every reference of a page: page 1
  // saved alone carried a hidden copy of page 10 with its picture, and in a merged file the links
  // led to such hidden copies instead of the pages in the file.
  const PICTURE = 36321;
  const holds = (buf, n) => buf.length > n * PICTURE && buf.length < (n + 0.5) * PICTURE;
  const tenLinks = at => ['Link ->' + (at + 9), 'Link https://example.com/split', 'Text "Note on page 3"', '', 'Link ->' + (at + 5), '', 'Link ->' + (at + 7), '', '', ''];
  await page.click('#mpdf-clear');
  await page.setInputFiles('#mpdf-file', [fx('ten.pdf'), fx('alpha.pdf'), fx('ten.pdf')]);
  await page.waitForFunction(() => document.querySelectorAll('.mpdf-page').length === 23 && !/Reading/.test(document.getElementById('mpdf-files').textContent));
  out = await save('#mpdf-merge');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.pages.map(p => p.anns), [...tenLinks(1), ...[1, 2, 3].map(n => 'Link https://example.com/Alpha-' + n), ...tenLinks(14)], 'each copy of ten.pdf links to its own pages');
  assert.deepEqual(await objects(out.buf), { pages: 23, pageObjects: 23, pictures: 20 });
  // Page 1 alone: its link to page 10, which is not in the file, is removed, and page 10 stays out.
  await page.check('.mpdf-page:nth-child(1) .mpdf-check');
  out = await save('#mpdf-extract');
  assert.deepEqual((await inspect(out.buf)).pages.map(p => p.anns), ['']);
  assert.deepEqual(await objects(out.buf), { pages: 1, pageObjects: 1, pictures: 1 });
  assert.ok(holds(out.buf, 1), `page 1 alone holds one picture (${out.buf.length} bytes)`);
  // Page 10 removed: the merge leaves it out, link and picture.
  await page.click('#mpdf-selnone');
  await page.click('.mpdf-file:nth-child(3) .mpdf-fdel');
  await page.click('.mpdf-file:nth-child(2) .mpdf-fdel');
  await page.click('.mpdf-page:nth-child(10) .mpdf-del');
  out = await save('#mpdf-merge');
  assert.deepEqual((await inspect(out.buf)).pages.map(p => p.anns), ['', ...tenLinks(1).slice(1, 9)]);
  assert.deepEqual(await objects(out.buf), { pages: 9, pageObjects: 9, pictures: 9 });
  assert.ok(holds(out.buf, 9), `9 pages hold 9 pictures (${out.buf.length} bytes)`);
  await page.selectOption('#mpdf-split-mode', 'each');
  entries = unzip((await save('#mpdf-split')).buf);
  assert.equal(entries.length, 9);
  entries.forEach((e, i) => assert.ok(holds(e.data, 1), `page ${i + 1} alone holds one picture (${e.data.length} bytes)`));
  // Named destinations and /GoTo actions lead to the right page inside each part.
  await page.selectOption('#mpdf-split-mode', 'every');
  await page.fill('#mpdf-every', '2');
  entries = unzip((await save('#mpdf-split')).buf);
  assert.deepEqual((await inspect(entries[2].data)).pages.map(p => p.anns), ['Link ->2', ''], 'pages 5-6');
  assert.deepEqual((await inspect(entries[3].data)).pages.map(p => p.anns), ['Link ->2', ''], 'pages 7-8');

  // ---- Pages that share one resource dictionary, and form fields with one parent ----
  // shared.pdf has 3 pages that share one resource dictionary with all three pictures (43,200 bytes
  // each; page 3 draws its own through a form that uses the page's resources). Page 1 has the form
  // field applicant.name and page 2 applicant.ssn, whose value is SHARED-SECRET-2, both kids of the
  // field "applicant"; page 1 also has a signature whose value refers to the document catalog. A
  // page's file gets only its own picture, and no field of another page, through either path.
  const redLevel = async buf => page.evaluate(async b64 => {
    const lib = await import('/assets/vendor/pdfjs/pdf.min.js');
    const task = lib.getDocument({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), verbosity: 0 });
    const pg = await (await task.promise).getPage(1);
    const vp = pg.getViewport({ scale: 0.5 }), c = document.createElement('canvas');
    c.width = vp.width;
    c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp }).promise;
    const d = c.getContext('2d').getImageData(55, 76, 95, 95).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i];
    await task.destroy();
    return sum / (d.length / 4);
  }, buf.toString('base64'));
  await page.click('#mpdf-clear');
  await page.setInputFiles('#mpdf-file', fx('shared.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.mpdf-page').length === 3);
  await page.selectOption('#mpdf-split-mode', 'each');
  entries = unzip((await save('#mpdf-split')).buf);
  entries.forEach((e, i) => assert.ok(e.data.length > 43200 && e.data.length < 43200 + 6000, `page ${i + 1} holds one picture (${e.data.length} bytes)`));
  assert.ok(allText(entries[0].data).includes('Alice Example'), 'the field on page 1 is kept');
  assert.ok(!allText(entries[0].data).includes('SHARED-SECRET-2'), 'the field on page 2 is not in the file of page 1');
  const level = await redLevel(entries[2].data);
  assert.ok(level > 90 && level < 165, `page 3 still draws its picture (mean red ${level.toFixed(1)})`);
  // A merge of the whole file copies the shared dictionary as it is: trimming it would mean reading
  // the content of every page, which made merging big drawings 3 to 4 times slower, for nothing.
  out = await save('#mpdf-merge');
  assert.ok(allText(out.buf).includes('SHARED-SECRET-2'), 'the merged file has the field of page 2');
  assert.deepEqual(await objects(out.buf, true), { pages: 3, pageObjects: 3, pictures: 3, resources: 1 });
  // A merge that leaves page 2 out trims it, so page 2's picture and field stay out.
  await page.click('.mpdf-page:nth-child(2) .mpdf-del');
  out = await save('#mpdf-merge');
  assert.ok(!allText(out.buf).includes('SHARED-SECRET-2'), 'the field of the removed page 2 is not in the merge');
  assert.deepEqual(await objects(out.buf, true), { pages: 2, pageObjects: 2, pictures: 2, resources: 2 });
  assert.ok(out.buf.length > 2 * 43200 && out.buf.length < 3 * 43200, `pages 1 and 3 hold two pictures (${out.buf.length} bytes)`);

  // ---- Thumbnails of fonts that are not embedded, and of CMYK colours ----
  // fonts.pdf: a Japanese line set with the predefined CMap UniJIS-UCS2-H, ZapfDingbats below it and a
  // cyan DeviceCMYK box below that. Without the CMap from this site the Japanese line stayed blank.
  await page.click('#mpdf-clear');
  await page.setInputFiles('#mpdf-file', fx('fonts.pdf'));
  await page.waitForFunction(() => { const i = document.querySelector('.mpdf-thumb img'); return i && i.complete && i.naturalWidth > 0; });
  for (const f of ['cmaps/UniJIS-UCS2-H.bcmap', 'standard_fonts/FoxitDingbats.pfb', 'iccs/CGATS001Compat-v2-micro.icc']) {
    assert.ok(fetched.includes('200 ' + f), `PDF.js fetched ${f} from this site: ${fetched.join()}`);
  }
  const thumb = await page.$eval('.mpdf-thumb img', img => {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    g.drawImage(img, 0, 0);
    // A box given in points of the A4 page (595 x 842, from the bottom left): its share of dark pixels and its colour.
    const box = (x0, y0, x1, y1) => {
      const sx = c.width / 595, sy = c.height / 842;
      const d = g.getImageData(Math.round(x0 * sx), Math.round((842 - y1) * sy), Math.round((x1 - x0) * sx), Math.round((y1 - y0) * sy)).data;
      const n = d.length / 4, rgb = [0, 0, 0];
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] < 384) dark++;
        for (let k = 0; k < 3; k++) rgb[k] += d[i + k] / n;
      }
      return { dark: dark / n, rgb: rgb.map(Math.round) };
    };
    return { japanese: box(60, 695, 380, 740), cyan: box(80, 320, 240, 430) };
  });
  assert.ok(thumb.japanese.dark > 0.05, `the Japanese line is drawn (${thumb.japanese.dark.toFixed(3)} of its box is dark)`);
  assert.ok(thumb.cyan.rgb[0] < 40 && thumb.cyan.rgb[1] > 120 && thumb.cyan.rgb[2] > 200, `the CMYK box is cyan (${thumb.cyan.rgb})`);

  // ---- Open passwords with characters outside ASCII (make_passwords.py) ----
  // pdfdoc-password.pdf (RC4 128-bit) keeps "café€" in PDFDocEncoding, where € is 0xA0. PDF.js takes
  // the low byte of each character (0xAC for €), so the page asks it again with the bytes the
  // unlocker tries; before, the password was "wrong". utf8-password.pdf (AES-256) keeps
  // "パスワード１２３" in UTF-8 as typed, with full-width digits: PDF.js opened it, but the unlocker
  // tried only the NFKC form (ASCII digits), and the merge then asked for the password again.
  await page.click('#mpdf-clear');
  await page.setInputFiles('#mpdf-file', [fx('pdfdoc-password.pdf'), fx('utf8-password.pdf')]);
  await page.waitForFunction(() => document.querySelectorAll('.mpdf-unlock input').length === 2);
  for (const [name, password] of [['pdfdoc-password.pdf', 'café€'], ['utf8-password.pdf', 'パスワード１２３']]) {
    await page.fill('.mpdf-unlock input', password);
    await page.press('.mpdf-unlock input', 'Enter');
    await page.waitForFunction(n => document.getElementById('mpdf-status').textContent === 'Unlocked ' + n + ': 2 pages added.' ||
      /wrong password/.test(document.getElementById('mpdf-files').textContent), name);
    assert.doesNotMatch(await page.textContent('#mpdf-files'), /wrong password/, name + ': the password opens it');
  }
  assert.deepEqual(await labels(), ['pdfdoc-password 1', 'pdfdoc-password 2', 'utf8-password 1', 'utf8-password 2']);
  // The merge either downloads the file or says why it could not.
  const download = page.waitForEvent('download').catch(() => null);
  await page.click('#mpdf-merge');
  const failed = page.waitForFunction(() => document.getElementById('mpdf-error').textContent !== '').catch(() => null);
  const dl = await Promise.race([download, failed.then(() => null)]);
  assert.equal(await page.textContent('#mpdf-error'), '', 'merged with the same passwords');
  pdf = await inspect(fs.readFileSync(await dl.path()));
  assert.equal(pdf.encrypted, false);
  assert.deepEqual(pdf.pages.map(p => p.text), ['PDFDoc 1 PDFDOC-MARK-01', 'PDFDoc 2 PDFDOC-MARK-02', 'Unicode 1 UNICODE-MARK-01', 'Unicode 2 UNICODE-MARK-02']);
};
