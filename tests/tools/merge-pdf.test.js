const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Fixtures (tests/fixtures/merge-pdf) were made with reportlab and pikepdf/qpdf: alpha.pdf (3 A4
// pages), bravo.pdf (2 Letter pages, the second with /Rotate 90), locked.pdf (AES-256 R6, user
// password "open sesame", object streams), restricted.pdf (AES-128, owner password only, one
// landscape A4 page), many.pdf (40 pages) and damaged.pdf. Every page shows its label in large
// text ("Alpha 2"). Outputs are read back with pdf.js, an independent reader (the tool writes with
// pdf-lib), checking page order, text, /Rotate and encryption. Sizes are in points: A4 595 x 842,
// Letter 612 x 792.

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
  await open();
  assert.equal(await page.isVisible('#mpdf-drop'), true);
  assert.equal(await page.isVisible('#mpdf-work'), false);

  // Reads a PDF with pdf.js: page texts, rotations, sizes and whether it is encrypted.
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
      pages.push({ text: tc.items.map(t => t.str).join(' ').replace(/\s+/g, ' ').split(' Fixture')[0].trim(), rotate: pg.rotate, size: Math.round(pg.view[2]) + 'x' + Math.round(pg.view[3]) });
    }
    await task.destroy();
    return { encrypted: !!meta.info.EncryptFilterName, producer: meta.info.Producer, pages };
  }, buf.toString('base64'));
  const save = async sel => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  const labels = () => page.$$eval('.mpdf-src', l => l.map(e => e.textContent.replace(/\.pdf · p\. /, ' ')));
  const metas = () => page.$$eval('.mpdf-file-meta', l => l.map(e => e.textContent));

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
  await page.check('.mpdf-page:nth-child(1) .mpdf-check');
  await page.click('.mpdf-page:nth-child(3) .mpdf-thumb', { position: { x: 60, y: 80 } });
  assert.equal(await page.textContent('#mpdf-selinfo'), '2 pages selected');
  await page.click('#mpdf-rotl');
  out = await save('#mpdf-extract');
  assert.equal(out.name, 'merged-selected.pdf');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.pages.map(p => p.text + '@' + p.rotate), ['Bravo 1@0', 'Alpha 2@270']);
  await page.click('#mpdf-selnone');
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
  assert.match(pdf.producer, /TripleP Tools/);
};
