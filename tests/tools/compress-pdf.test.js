const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { devices } = require('playwright');

// Fixtures (tests/fixtures/compress-pdf, made by make_fixtures.py with reportlab, pikepdf and
// Pillow): scans, photos, a CMYK JPEG, an EXIF-rotated JPEG, a tagged PDF with links, bookmarks
// and a form, pictures drawn in every way the page must handle, PDF/A-1 and PDF/X files, a
// PDF/A-2 file with a CMYK output intent, attachments and a signature, linearised, updated and
// PDF 2.0 files, encrypted copies and damaged files. expected.json says what each marked picture must become at each level,
// worked out from its pixel size and the size it is drawn at. Every copy the page writes is
// checked with libqpdf (pikepdf) and poppler (pdftotext, pdftoppm) by verify.py, when they are
// installed, and always with PDF.js. Files too big to keep are built below at test time.

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

// A PDF written by hand with a cross-reference table: pages of Helvetica text, each with an
// optional picture (Flate RGB) drawn at a given size, and an optional attachment. A picture is
// marked /TTMark /B unless it names its own mark; keys adds entries to its dictionary.
function buildPdf(pages, extra = {}) {
  const objs = [null, null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const add = body => { objs.push(body); return objs.length; };
  const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  const kids = [];
  for (const sp of pages) {
    let res = '/Font << /F1 3 0 R >>', draw = '';
    if (sp.image) {
      const im = add(stream(`/Type /XObject /Subtype /Image /Width ${sp.image.w} /Height ${sp.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /TTMark /${sp.image.mark || 'B'}${sp.image.keys ? ' ' + sp.image.keys : ''}`, sp.image.data));
      res += ` /XObject << /Im0 ${im} 0 R >>`;
      draw = `q ${sp.image.drawW} 0 0 ${sp.image.drawH} 72 72 cm /Im0 Do Q\n`;
    }
    const content = add(stream('', Buffer.from(draw + `BT /F1 12 Tf 72 740 Td (${sp.text}) Tj ET`, 'latin1')));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${res} >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let names = '';
  if (extra.attachment) {
    const ef = add(stream('/Type /EmbeddedFile' + (extra.filtered ? ' /Filter /FlateDecode' : ''), extra.attachment));
    const spec = add(`<< /Type /Filespec /F (data.bin) /UF (data.bin) /EF << /F ${ef} 0 R >> >>`);
    names = ` /Names << /EmbeddedFiles << /Names [(data.bin) ${spec} 0 R] >> >>`;
  }
  objs[0] = `<< /Type /Catalog /Pages 2 0 R${names} >>`;
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let off = parts[0].length;
  const offs = [];
  objs.forEach((b, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'), tail = Buffer.from('\nendobj\n', 'latin1');
    offs.push(off);
    parts.push(head, body, tail);
    off += head.length + body.length + tail.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
// A noisy, photo-like picture (a camera's grain: no two neighbours alike), Flate-compressed.
function photo(w, h, seed) {
  const px = Buffer.alloc(w * h * 3);
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const c = v => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, u = x / w, v = y / h;
      px[i] = c(128 + 90 * Math.sin(6 * u + seed) * Math.cos(4 * v) + (rnd() - 0.5) * 30);
      px[i + 1] = c(120 + 80 * Math.sin(5 * v + 2 * u) + (rnd() - 0.5) * 30);
      px[i + 2] = c(140 + 70 * Math.cos(7 * u - 3 * v) + (rnd() - 0.5) * 30);
    }
  }
  return { w, h, data: zlib.deflateSync(px, { level: 1 }) };
}
// Noise in a 16 x 16 tile repeated: a photo to the page (no flat areas, over 256 colours), but
// Flate stores it in a few KB, where a JPEG takes many times that.
function tiled(w, h) {
  const T = 16, tile = Buffer.alloc(T * T * 3), px = Buffer.alloc(w * h * 3);
  for (let i = 0, s = 5; i < tile.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; tile[i] = s >>> 24; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tile.copy(px, (y * w + x) * 3, ((y % T) * T + (x % T)) * 3, ((y % T) * T + (x % T)) * 3 + 3);
  return { w, h, data: zlib.deflateSync(px, { level: 9 }) };
}
// Announcements of the status region, from now on, in window.__said.
const listen = p => p.evaluate(() => {
  window.__said = [];
  if (window.__listening) return;
  window.__listening = true;
  new MutationObserver(() => { const t = document.getElementById('cp-status').textContent; if (t) window.__said.push(t); })
    .observe(document.getElementById('cp-status'), { childList: true, characterData: true, subtree: true });
});

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const fx = n => path.join(fixtures, n);
  const exp = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-pdf-'));
  try {
    await run({ page, open, assert, fixtures, base, url, fx, exp, tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

// Added to pdf-lib as a test page loads it: each time pdf-lib reads a file, it logs how many objects
// it reads between pauses: "pdf-lib parse: 400".
const PARSE_SPY = '\n;(function () { var P = self.PDFLib.PDFParser, f = P.forBytesWithOptions; P.forBytesWithOptions = function (b, n) { console.log("pdf-lib parse: " + n); return f.apply(this, arguments); }; })();\n';

async function run({ page, open, assert, fixtures, base, url, fx, exp, tmp }) {
  const browser = page.context().browser();

  // libqpdf (pikepdf) and poppler, for checks independent of the page's own libraries.
  let tools = false;
  try {
    execFileSync('python3', ['-c', 'import pikepdf, numpy, PIL'], { stdio: 'ignore' });
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    tools = true;
  } catch (e) { tools = false; }
  if (!tools) console.log('  (compress-pdf: python3 with pikepdf, numpy and Pillow, or poppler, is missing: copies are checked with PDF.js only)');
  let copyNo = 0;
  const verify = (orig, buf, pw) => {
    const p = path.join(tmp, `copy-${++copyNo}.pdf`);
    fs.writeFileSync(p, buf);
    return JSON.parse(execFileSync('python3', [fx('verify.py'), orig, p, pw || ''], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  };

  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await open();

  // ---------- helpers ----------
  const text = sel => page.$eval(sel, e => e.textContent);
  const rows = (p = page) => p.$$eval('.cp-file', l => l.map(e => ({
    name: e.querySelector('.cp-name').textContent, meta: e.querySelector('.cp-meta').textContent,
    state: e.querySelector('.cp-state').textContent, note: e.querySelector('.cp-note').textContent,
    dl: !e.querySelectorAll('button')[0].hidden, pv: !e.querySelectorAll('button')[1].hidden,
  })));
  const rowOf = async (name, p = page) => (await rows(p)).find(r => r.name === name);
  // Every row settled: nothing waiting or working, no "…" left.
  const idle = (p = page, timeout = 120000) => p.waitForFunction(() => {
    const r = [...document.querySelectorAll('.cp-file')];
    return r.length && document.getElementById('cp-cancel').hidden && r.every(e => !/…$/.test(e.querySelector('.cp-state').textContent));
  }, null, { timeout });
  const download = async (locator, p = page) => {
    const [d] = await Promise.all([p.waitForEvent('download'), locator.click()]);
    return { name: d.suggestedFilename(), buf: fs.readFileSync(await d.path()) };
  };
  const dlButton = (name, p = page) => p.locator('.cp-file', { has: p.locator('.cp-name', { hasText: new RegExp('^' + name.replace(/[.()]/g, '\\$&') + '$') }) }).locator('button', { hasText: /^Download$/ });
  const pvButton = (name, p = page) => p.locator('.cp-file', { has: p.locator('.cp-name', { hasText: new RegExp('^' + name.replace(/[.()]/g, '\\$&') + '$') }) }).locator('button', { hasText: /^Preview$/ });
  const level = async v => { await page.check(`input[name="cp-level"][value="${v}"]`); };
  const clear = async () => {
    await page.click('#cp-clear');
    await page.waitForFunction(() => document.getElementById('cp-files').hidden && document.getElementById('cp-status').textContent === 'The list is empty.');
  };
  // How the page writes sizes (1 KB = 1,000 bytes) and savings.
  const fmt = n => n < 1000 ? `${n} bytes` : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)} MB`;
  const pct = (a, b) => Math.max(0, Math.min(99, Math.round((1 - b / a) * 100)));
  // PDF.js on the page reads a PDF: text per page, outline, annotations, form values, tags.
  const readPdf = (buf, password) => page.evaluate(async ({ b64, password }) => {
    const lib = await import('/assets/vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.js';
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const task = lib.getDocument({ data, password, verbosity: 0 });
    const doc = await task.promise;
    const out = { pages: doc.numPages, text: [], annots: [], tags: [] };
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      out.text.push((await pg.getTextContent()).items.map(t => t.str).join(' '));
      out.annots.push((await pg.getAnnotations()).map(a => [a.subtype, a.url || '', a.fieldName || '', a.fieldValue == null ? '' : String(a.fieldValue)]));
      const tree = await pg.getStructTree().catch(() => null);
      out.tags.push(JSON.stringify(tree));
    }
    out.outline = ((await doc.getOutline()) || []).map(function walk(o) { return [o.title, (o.items || []).map(walk)]; });
    await task.destroy();
    return out;
  }, { b64: buf.toString('base64'), password });
  const samePdf = async (orig, copy, pw, label) => {
    const a = await readPdf(fs.readFileSync(orig), pw), b = await readPdf(copy, pw);
    for (const k of ['pages', 'text', 'annots', 'tags', 'outline']) assert.deepEqual(b[k], a[k], `${label}: PDF.js reads the same ${k}`);
    return b;
  };
  // The independent check of a copy: libqpdf finds nothing wrong, poppler extracts the same text,
  // the structure is the same, and each marked picture became what expected.json says.
  const check = (name, buf, lv, pw, extra = {}) => {
    if (!tools) return null;
    const v = verify(fx(name), buf, pw);
    assert.deepEqual(v.check, [], `${name}: libqpdf finds no problem in the copy`);
    assert.equal(v.text_same, true, `${name}: pdftotext reads the same text`);
    for (const [k, same] of Object.entries(v.same)) assert.equal(same, true, `${name}: ${k} unchanged ${JSON.stringify((v.diff || {})[k] || '')}`);
    const want = (exp[name] || {}).images || {};
    for (const [mark, fates] of Object.entries(want)) {
      const before = v.images.orig[mark] || [], after = v.images.copy[mark] || [];
      assert.ok(after.length >= 1, `${name}: picture ${mark} is still there`);
      const f = extra.fates && extra.fates[mark] || fates[lv];
      if (f === 'same') {
        assert.deepEqual(after.map(i => i.sha).sort(), [...new Set(before.map(i => i.sha))].sort(), `${name}: picture ${mark} is left exactly as it was at ${lv}`);
      } else {
        for (const i of after) assert.deepEqual([i.w, i.h, i.filter], f, `${name}: picture ${mark} at ${lv}`);
      }
    }
    for (const p of v.psnr) assert.ok(p >= (extra.psnr || 30), `${name}: every page looks like the original (PSNR ${v.psnr.join(', ')} dB)`);
    return v;
  };

  // ---------- the first state ----------
  assert.equal(await page.isVisible('#cp-drop'), true);
  assert.equal(await page.isHidden('#cp-files'), true);
  assert.equal(await page.isHidden('#cp-actions'), true);
  assert.equal(await page.isChecked('input[name="cp-level"][value="recommended"]'), true);
  assert.equal(await text('#cp-level-hint'), 'Pictures sharper than 150 ppi are reduced to it, at quality 75. Sharp on screens and in office prints: right for email and uploads.');
  assert.equal(await page.isHidden('#cp-custom'), true);
  assert.equal(await page.isHidden('#cp-fit'), true);
  assert.ok(!requests.some(u => /pdf-lib|pdfjs/.test(u)), 'the PDF libraries load only when a file is chosen');

  // ---------- Recommended, a batch of every kind of file ----------
  const BATCH = ['scan-colour', 'scan-grey', 'photo', 'cmyk', 'exif', 'tagged', 'placement', 'kinds', 'pdfa1', 'pdfx', 'attach', 'linear', 'update', 'pdf20', 'damaged-xref', 'damaged-garbage'];
  await page.setInputFiles('#cp-file', BATCH.map(n => fx(n + '.pdf')));
  await idle();
  // Chromium refuses an eleventh download within a few seconds, so the batch is saved as one ZIP
  // file, and a few files with their own Download buttons, which must give the same bytes.
  const zip = await download(page.locator('#cp-zip'));
  assert.equal(zip.name, 'compressed-pdfs.zip');
  const entries = unzip(zip.buf);
  const offered = BATCH.filter(n => n !== 'pdfx');
  assert.deepEqual(entries.map(e => e.name), offered.map(n => n + '-compressed.pdf'), 'the ZIP holds every copy, named after its file');
  const copies = {};
  for (const e of entries) copies[e.name.replace(/-compressed\.pdf$/, '')] = Buffer.from(e.data);
  for (const n of ['photo', 'tagged', 'damaged-garbage']) {
    const got = await download(dlButton(n + '.pdf'));
    assert.equal(got.name, n + '-compressed.pdf');
    assert.ok(got.buf.equals(copies[n]), `${n}: Download saves the same bytes as the ZIP`);
  }
  let totalIn = 0, totalOut = 0;
  for (const n of BATCH) {
    const file = n + '.pdf', size = fs.statSync(fx(file)).size, r = await rowOf(file);
    if (n === 'pdfx') {
      assert.deepEqual([r.state, r.dl, r.pv], ['Already compact: keep your original.', false, false], 'a PDF/X file keeps its CMYK picture: nothing to offer');
      assert.match(r.note, /^Its CMYK pictures must stay CMYK in a PDF\/X file, so they are left as they are\. It stays marked as PDF\/X\.$/);
      continue;
    }
    const buf = copies[n];
    assert.ok(buf.length <= size * 0.99, `${file}: the copy is smaller (${size} -> ${buf.length})`);
    assert.equal(r.state, `${fmt(buf.length)}, ${pct(size, buf.length)}% smaller.`, `${file}: the row states the size of the file it saves`);
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    totalIn += size;
    totalOut += buf.length;
  }
  assert.equal(await text('#cp-sum'), `15 PDFs compressed: ${fmt(totalIn)} → ${fmt(totalOut)}, ${pct(totalIn, totalOut)}% smaller.`);
  assert.equal((await rowOf('tagged.pdf')).meta, `${fmt(fs.statSync(fx('tagged.pdf')).size)} · 2 pages`);
  assert.equal((await rowOf('cmyk.pdf')).note, '1 picture made smaller. 1 CMYK picture is now RGB, which suits screens; keep the original for professional printing.');
  assert.equal((await rowOf('pdfa1.pdf')).note, '1 picture made smaller. It stays marked as PDF/A-1.');
  assert.equal((await rowOf('attach.pdf')).note, '1 picture made smaller. It was digitally signed: the signature will not validate in the copy, so keep the signed original.');

  // PDF.js reads the same pages, text, links, form values, tags and outline in every copy.
  for (const n of Object.keys(copies)) await samePdf(fx(n + '.pdf'), copies[n], undefined, n);
  const upd = await readPdf(copies.update);
  assert.match(upd.text[0], /REVISION-2/, 'the copy of an updated file shows the latest revision');

  if (tools) {
    const v = {};
    for (const n of Object.keys(copies)) v[n] = check(n + '.pdf', copies[n], 'recommended', '', { psnr: n === 'cmyk' ? 24 : n === 'damaged-garbage' ? 25 : 30 });
    // Grey stays grey; CMYK becomes RGB; the EXIF-rotated photo stays as PDF readers draw it.
    assert.deepEqual(v['scan-grey'].images.copy.S.map(i => [i.cs, i.jpeg]), [['/DeviceGray', ['L', 300, 375]]], 'a grey JPEG stays a one-channel grey JPEG');
    assert.deepEqual(v.cmyk.images.copy.C.map(i => [i.cs, i.decode]), [['/DeviceRGB', null]]);
    assert.deepEqual(v.exif.images.copy.E.map(i => [i.jpeg, i.orient]), [[['RGB', 600, 375], null]], 'the turned JPEG is stored unturned and keeps its proportions');
    assert.ok(v.exif.psnr[0] >= 33, `the EXIF-rotated photo looks as before (${v.exif.psnr[0]} dB)`);
    // Duplicates merged; thumbnails, PieceInfo and linearisation dropped.
    assert.deepEqual(v.tagged.fontfiles, [2, 1], 'the font stored twice is kept once');
    assert.deepEqual(v.tagged.thumbs, [1, 0]);
    assert.deepEqual(v.tagged.pieceinfo, [true, false]);
    assert.deepEqual(v.linear.linearized, [true, false]);
    assert.equal(v.kinds.images.orig.L.length, 2);
    assert.equal(v.kinds.images.copy.L.length, 1, 'the chart stored twice is kept once');
    assert.deepEqual(v.kinds.images.copy.M.map(i => i.smask.slice(0, 2)), [[60, 60]], 'the soft mask is shrunk with its picture');
    // How each copy is stored: object streams, except PDF/A-1 (classic table, PDF 1.4 kept).
    for (const n of Object.keys(v)) {
      const s = v[n].storage.copy;
      if (n === 'pdfa1') assert.deepEqual([s.header, s.xref, s.objstm, s.xrefstm], ['%PDF-1.4', 'table', false, false], 'PDF/A-1: a cross-reference table and no object streams');
      else assert.deepEqual([s.xref, s.objstm], ['stream', true], `${n}: object streams and a cross-reference stream`);
      assert.match(s.eof_tail, /^%%EOF\n?$/, `${n}: nothing after %%EOF`);
    }
    assert.equal(v.pdf20.storage.copy.header, '%PDF-2.0', 'PDF 2.0 stays 2.0');
    assert.equal(v.photo.storage.copy.header, '%PDF-1.5', 'a PDF 1.4 file with object streams becomes 1.5');
    for (const [p, i] of exp['placement.pdf'].pages.rotate.entries()) assert.equal(true, v.placement.same.boxes, `page ${p}: boxes, /Rotate ${i} and /UserUnit kept`);
  }

  // ---------- Double clicks ----------
  // A double click saves once.
  let downloads = 0;
  const countDl = () => downloads++;
  page.on('download', countDl);
  await dlButton('photo.pdf').dblclick();
  await page.waitForTimeout(1500);
  page.off('download', countDl);
  assert.equal(downloads, 1, 'a double click saves the file once');

  // ---------- Light, Strong and Custom ----------
  await clear();
  const FEW = ['scan-colour', 'placement', 'kinds', 'photo', 'cmyk'];
  for (const lv of ['light', 'strong']) {
    await level(lv);
    if (lv === 'light') await page.setInputFiles('#cp-file', FEW.map(n => fx(n + '.pdf')));
    await idle();
    for (const n of FEW) {
      const r = await rowOf(n + '.pdf');
      if (!r.dl) { assert.equal(lv, 'light'); continue; }
      const got = await download(dlButton(n + '.pdf'));
      if (tools) check(n + '.pdf', got.buf, lv, '', { psnr: n === 'cmyk' ? 24 : lv === 'strong' ? 26 : 30 });
    }
  }
  assert.equal(await text('#cp-level-hint'), 'Pictures sharper than 100 ppi are reduced to it, at quality 60. The smallest files; small print in scans turns soft.');

  // Custom: the resolution field takes whole numbers only, in any locale.
  await level('custom');
  assert.equal(await page.isVisible('#cp-custom'), true);
  const ppiErr = async () => ({ msg: await text('#cp-ppi-error'), invalid: await page.getAttribute('#cp-ppi', 'aria-invalid'), described: await page.getAttribute('#cp-ppi', 'aria-describedby') });
  const BAD = 'Enter a whole number of ppi from 50 to 600, such as 150.';
  for (const bad of ['0,500', '1.000', '1,000', '150,5', '150.5', '15²', '\t150x', '49', '601', 'abc', '']) {
    await page.fill('#cp-ppi', bad);
    await page.press('#cp-ppi', 'Enter');
    assert.deepEqual(await ppiErr(), { msg: BAD, invalid: 'true', described: 'cp-ppi-hint cp-ppi-error' }, `"${bad}" is refused`);
    const waiting = await rows();
    assert.ok(waiting.every(r => !r.dl && r.state === 'Waiting: fix the setting above.'), `no copy is offered while "${bad}" is in the field: ${JSON.stringify(waiting.map(r => r.state))}`);
  }
  // A megabyte pasted in is cut to the field's limit at once, and refused.
  await page.$eval('#cp-ppi', el => { el.value = '1'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cp-ppi', el => el.value.length), 40);
  await page.press('#cp-ppi', 'Enter');
  assert.equal((await ppiErr()).msg, BAD);
  // The Arabic thousands separator is not read as a decimal comma, or skipped.
  await page.fill('#cp-ppi', '١٬٥٠');
  await page.press('#cp-ppi', 'Enter');
  assert.equal((await ppiErr()).msg, BAD, 'the Arabic thousands separator is refused');
  // Fullwidth and Arabic-Indic digits are digits.
  await page.fill('#cp-ppi', '１２٠');
  await page.press('#cp-ppi', 'Enter');
  assert.deepEqual(await ppiErr(), { msg: '', invalid: null, described: 'cp-ppi-hint cp-ppi-error' });
  await page.$eval('#cp-quality', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await text('#cp-quality-out'), '50');
  await page.check('#cp-grey');
  await idle();
  {
    const got = await download(dlButton('scan-colour.pdf'));
    if (tools) {
      // 600 x 750 drawn at 2 x 2.5 in, at 120 ppi: 240 x 300, grey
      const v = check('scan-colour.pdf', got.buf, 'custom', '', { fates: { S: [240, 300, 'DCTDecode'] }, psnr: 22 });
      assert.deepEqual(v.images.copy.S.map(i => [i.cs, i.jpeg]), [['/DeviceGray', ['L', 240, 300]]], 'Make pictures grey writes grey JPEGs');
    }
    assert.equal((await rowOf('cmyk.pdf')).note, '1 picture made smaller.', 'a CMYK picture made grey is not reported as RGB');
  }
  await page.uncheck('#cp-grey');

  // ---------- Fit a size ----------
  await clear();
  await level('fit');
  assert.equal(await page.isVisible('#cp-fit'), true);
  const photos = buildPdf([1, 2, 3, 4].map(i => ({ text: 'Photo page ' + i, image: { ...photo(800, 600, i), drawW: 230, drawH: 172.5 } })));
  fs.writeFileSync(path.join(tmp, 'photos.pdf'), photos);
  const noise = Buffer.alloc(600000);
  for (let i = 0, s = 7; i < noise.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; noise[i] = s >>> 24; }
  fs.writeFileSync(path.join(tmp, 'attached.pdf'), buildPdf([{ text: 'Attachment' }], { attachment: noise }));
  await page.selectOption('#cp-limit', '500000');
  await page.setInputFiles('#cp-file', [path.join(tmp, 'photos.pdf'), path.join(tmp, 'attached.pdf'), fx('photo.pdf')]);
  await idle();
  const fit = await rowOf('photos.pdf');
  const m = /^(\S+ KB), (\d+)% smaller, under 500 KB \(at (\d+) ppi, quality (\d+)\)\.$/.exec(fit.state.replace(/ /g, ' '));
  assert.ok(m, 'Fit a size says which level fits: ' + fit.state);
  const fitted = await download(dlButton('photos.pdf'));
  assert.ok(fitted.buf.length <= 500000, `the copy is at most 500,000 bytes (${fitted.buf.length})`);
  const [ppi, q] = [+m[3], +m[4]];
  if (tools) {
    const v = verify(path.join(tmp, 'photos.pdf'), fitted.buf);
    assert.deepEqual(v.check, []);
    // 800 x 600 drawn at 230 x 172.5 pt: shrunk to the ppi the row names
    const k = ppi * (230 / 72) / 800;
    const want = k < 0.9 ? [Math.round(800 * k), Math.round(600 * k)] : [800, 600];
    assert.equal(v.images.copy.B.length, 4);
    for (const i of v.images.copy.B) assert.deepEqual([i.w, i.h, i.filter], [...want, 'DCTDecode']);
  }
  assert.equal((await rowOf('attached.pdf')).state, 'Could not get under 500\u00a0KB, and no copy came out smaller: keep your original.');
  assert.equal((await rowOf('attached.pdf')).dl, false);
  assert.equal((await rowOf('photo.pdf')).state, 'Already under 500\u00a0KB, so it was left as it is: keep your original.');
  // The next sharper level of the ladder does not fit: Fit a size kept the sharpest that does.
  const LADDER = [[220, 85], [200, 80], [150, 75], [120, 70], [100, 60], [85, 55], [72, 50]];
  const at = LADDER.findIndex(l => l[0] === ppi && l[1] === q);
  assert.ok(at >= 0, 'the level is one of the ladder');
  if (at > 0) {
    await level('custom');
    await page.fill('#cp-ppi', String(LADDER[at - 1][0]));
    await page.$eval('#cp-quality', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })); }, LADDER[at - 1][1]);
    await page.press('#cp-ppi', 'Enter');
    await idle();
    const sharper = await download(dlButton('photos.pdf'));
    assert.ok(sharper.buf.length > 500000, `the next sharper level (${LADDER[at - 1]}) is over 500 KB (${sharper.buf.length})`);
  }

  // ---------- Passwords ----------
  await clear();
  await level('recommended');
  const ENC = ['enc-rc4-40', 'enc-rc4-128', 'enc-aes-128', 'enc-aes-256', 'enc-unicode', 'enc-latin', 'enc-objstm'];
  await page.setInputFiles('#cp-file', fx('enc-aes-256.pdf'));
  await page.waitForSelector('#cp-unlock:not([hidden])');
  assert.equal((await rowOf('enc-aes-256.pdf')).state, 'It needs the password that opens it.');
  assert.equal(await text('#cp-pw-label'), 'Password for enc-aes-256.pdf');
  // An empty password is refused at once; a wrong one after trying it.
  await page.click('#cp-pw-go');
  assert.equal(await text('#cp-pw-error'), 'Type the password first.');
  assert.equal(await page.getAttribute('#cp-pw', 'aria-invalid'), 'true');
  assert.match(await page.getAttribute('#cp-pw', 'aria-describedby'), /\bcp-pw-error\b/);
  await page.fill('#cp-pw', 'not the password');
  assert.equal(await page.getAttribute('#cp-pw', 'aria-invalid'), null, 'typing clears the error');
  await page.press('#cp-pw', 'Enter');
  await page.waitForFunction(() => document.getElementById('cp-pw-error').textContent);
  assert.equal(await text('#cp-pw-error'), 'That password does not open this file. Check it, or ask whoever sent it.');
  assert.equal(await page.getAttribute('#cp-pw', 'aria-invalid'), 'true');
  // A long paste is cut to 1,024 characters.
  await page.$eval('#cp-pw', el => { el.value = 'x'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cp-pw', el => el.value.length), 1024);
  await clear();
  // Every encryption, and one password for several files: each file opens with its own.
  await page.setInputFiles('#cp-file', ENC.map(n => fx(n + '.pdf')));
  await page.waitForSelector('#cp-unlock:not([hidden])');
  await page.waitForFunction(n => document.querySelectorAll('.cp-file').length === n && [...document.querySelectorAll('.cp-state')].every(e => !/…$/.test(e.textContent)), ENC.length);
  assert.equal(await text('#cp-pw-label'), 'Password for 7 files');
  for (const n of ENC) {
    await page.fill('#cp-pw', exp[n + '.pdf'].password);
    await page.press('#cp-pw', 'Enter');
    await page.waitForFunction(name => {
      const row = [...document.querySelectorAll('.cp-file')].find(e => e.querySelector('.cp-name').textContent === name);
      return row && /smaller\.$/.test(row.querySelector('.cp-state').textContent) && [...document.querySelectorAll('.cp-state')].every(e => !/…$/.test(e.textContent));
    }, n + '.pdf', { timeout: 60000 });
    if (n !== ENC[ENC.length - 1]) assert.equal(await text('#cp-pw-error'), '', 'a password that opens some of the files is no error');
  }
  assert.equal(await page.isHidden('#cp-unlock'), true, 'the password box goes once every file is open');
  // The focus was in the password field: it moves on to the copies, not back to the top of the page.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cp-zip', 'the focus moves from the password field to Download all');
  for (const n of ENC) {
    const r = await rowOf(n + '.pdf'), got = await download(dlButton(n + '.pdf'));
    const pw = exp[n + '.pdf'].password;
    assert.match(r.note, /It keeps its password and (RC4 40-bit|RC4 128-bit|AES 128-bit|AES 256-bit) encryption\.$/);
    await samePdf(fx(n + '.pdf'), got.buf, pw, n);
    if (tools) {
      const v = check(n + '.pdf', got.buf, 'recommended', pw);
      assert.deepEqual(v.encrypt.copy, v.encrypt.orig, `${n}: the same encryption (R, V, P, methods)`);
      const ownerOk = verify(fx(n + '.pdf'), got.buf, 'owner pass');
      assert.deepEqual(ownerOk.check, [], `${n}: the permissions password still opens the copy`);
    }
  }
  // Restrictions: a file that forbids printing and copying is compressed without a password and
  // keeps them; one that forbids changes needs its permissions password.
  await clear();
  await page.setInputFiles('#cp-file', [fx('enc-restricted.pdf'), fx('enc-nochanges.pdf')]);
  await page.waitForSelector('#cp-unlock:not([hidden])');
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-state')].every(e => !/…$/.test(e.textContent)));
  assert.equal((await rowOf('enc-nochanges.pdf')).state, 'Its author does not allow changes. Type its permissions password to compress it.');
  assert.equal(await text('#cp-pw-label'), 'Permissions password for enc-nochanges.pdf');
  await page.fill('#cp-pw', 'wrong');
  await page.press('#cp-pw', 'Enter');
  await page.waitForFunction(() => document.getElementById('cp-pw-error').textContent);
  assert.equal(await text('#cp-pw-error'), 'That is not the permissions password of this file.');
  await page.fill('#cp-pw', 'owner pass');
  await page.press('#cp-pw', 'Enter');
  await idle();
  for (const n of ['enc-restricted', 'enc-nochanges']) {
    const got = await download(dlButton(n + '.pdf'));
    if (tools) {
      const v = check(n + '.pdf', got.buf, 'recommended', '');
      assert.deepEqual(v.encrypt.copy, v.encrypt.orig, `${n}: the same restrictions`);
    }
  }

  // ---------- A picture's own dictionary keys survive, also ones named like JavaScript's ----------
  await clear();
  {
    const KEYS = '/constructor (c1) /toString (t1) /valueOf (v1) /hasOwnProperty (h1) /__proto__ (p1) /Private (k1)';
    fs.writeFileSync(path.join(tmp, 'keys.pdf'), buildPdf([{ text: 'Keys', image: { ...photo(800, 600, 9), drawW: 230, drawH: 172.5, keys: KEYS } }]));
    await page.setInputFiles('#cp-file', path.join(tmp, 'keys.pdf'));
    await idle();
    const got = await download(dlButton('keys.pdf'));
    // The picture is shrunk (250 ppi to 150), so its dictionary is written anew.
    const s = got.buf.toString('latin1');
    for (const k of KEYS.match(/\/\w+ \(\w+\)/g)) assert.ok(s.includes(k), `the shrunk picture keeps ${k}`);
    const k = 150 * (230 / 72) / 800;
    if (tools) assert.deepEqual(verify(path.join(tmp, 'keys.pdf'), got.buf).images.copy.B.map(i => [i.w, i.h, i.filter]), [[Math.round(800 * k), Math.round(600 * k), 'DCTDecode']]);
  }

  // ---------- A picture that would not get 10% smaller is left exactly as it was ----------
  await clear();
  {
    // The tiled picture is drawn at 100 ppi: as a JPEG it would grow from 5 KB to over 100 KB.
    fs.writeFileSync(path.join(tmp, 'gain.pdf'), buildPdf([{ text: 'Tiled', image: { ...tiled(600, 600), drawW: 432, drawH: 432, mark: 'G' } },
      { text: 'Photo', image: { ...photo(800, 600, 4), drawW: 230, drawH: 172.5 } }]));
    await page.setInputFiles('#cp-file', path.join(tmp, 'gain.pdf'));
    await idle();
    const got = await download(dlButton('gain.pdf'));
    if (tools) {
      const v = verify(path.join(tmp, 'gain.pdf'), got.buf);
      assert.deepEqual(v.check, []);
      assert.deepEqual(v.images.copy.G.map(i => [i.filter, i.sha]), v.images.orig.G.map(i => [i.filter, i.sha]), 'the tiled picture is kept as it was');
      assert.deepEqual(v.images.copy.B.map(i => i.filter), ['DCTDecode'], 'the photo next to it is shrunk');
    }
  }

  // ---------- A picture of a kind the page leaves alone: the row gives that reason ----------
  await clear();
  {
    // An inverted /Decode: never re-encoded, so not "losing more than they save".
    fs.writeFileSync(path.join(tmp, 'kind.pdf'), buildPdf([{ text: 'Inverted', image: { ...photo(800, 600, 6), drawW: 230, drawH: 172.5, keys: '/Decode [1 0 1 0 1 0]' } }]));
    await page.setInputFiles('#cp-file', path.join(tmp, 'kind.pdf'));
    await idle();
    assert.deepEqual(await rowOf('kind.pdf').then(r => [r.state, r.note, r.dl]), ['Already compact: keep your original.',
      'Its pictures are of kinds this page leaves as they are, such as indexed colours, 16-bit samples or colour masks.', false]);
  }

  // ---------- PDF/A with a CMYK output intent: its CMYK picture stays CMYK ----------
  await clear();
  await page.setInputFiles('#cp-file', fx('pdfa-cmyk.pdf'));
  await idle();
  {
    const r = await rowOf('pdfa-cmyk.pdf');
    assert.ok(!/RGB/.test(r.note), `no picture becomes RGB in a file that promises CMYK: ${r.note}`);
    if (r.dl) {
      assert.equal(r.note, 'It stays marked as PDF/A-2.');
      const got = await download(dlButton('pdfa-cmyk.pdf'));
      if (tools) check('pdfa-cmyk.pdf', got.buf, 'recommended');
    } else assert.match(r.note, /^Its CMYK pictures must stay CMYK in a PDF\/A-2 file/);
  }

  // ---------- Files that cannot be compressed ----------
  await clear();
  await listen(page);
  const asFile = n => ({ name: n, mimeType: 'application/pdf', buffer: fs.readFileSync(fx(n)) });
  await page.setInputFiles('#cp-file', [asFile('damaged-cut.pdf'), asFile('not-a-pdf.pdf'), { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
    { name: 'header-only.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%%EOF\n') }]);
  await idle();
  assert.deepEqual((await rows()).map(r => [r.name, r.state, r.dl]), [
    ['damaged-cut.pdf', 'This file is damaged or is not a valid PDF.', false],
    ['not-a-pdf.pdf', 'This is not a PDF file.', false],
    ['empty.pdf', 'This file is empty.', false],
    ['header-only.pdf', 'This file is damaged or is not a valid PDF.', false],
  ]);
  {
    // Each refusal is said, not only shown: also the two found as the files are added.
    const REFUSED = (await rows()).map(r => r.name + ': ' + r.state);
    await page.waitForFunction(rs => rs.every(r => window.__said.join(' ').includes(r)), REFUSED, { timeout: 5000 }).catch(() => {});
    const said = (await page.evaluate(() => window.__said)).join(' ');
    for (const r of REFUSED) assert.ok(said.includes(r), `the status region says "${r}" (it said: ${said})`);
  }
  // Over 1 GB: refused before it is read (its size is faked).
  await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(Blob.prototype, 'size');
    Object.defineProperty(Blob.prototype, 'size', { configurable: true, get() { return this.name === 'huge.pdf' ? 1073741825 : d.get.call(this); } });
    window.__restoreSize = () => Object.defineProperty(Blob.prototype, 'size', d);
  });
  await page.setInputFiles('#cp-file', { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
  await page.waitForFunction(() => /huge\.pdf/.test(document.getElementById('cp-files').textContent));
  await page.evaluate(() => window.__restoreSize());
  assert.equal((await rowOf('huge.pdf')).state, 'Larger than 1 GB, which is too big to compress in a browser.');
  // A file named like an object's built-in property is just a file.
  await clear();
  await page.setInputFiles('#cp-file', { name: '__proto__.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('photo.pdf')) });
  await idle();
  assert.equal((await download(dlButton('__proto__.pdf'))).name, '__proto__-compressed.pdf');

  // ---------- 1,000 pages: the work is cancelled at once, and the page stays responsive ----------
  await clear();
  const many = buildPdf(Array.from({ length: 1000 }, (_, i) => ({ text: 'Page ' + (i + 1), image: { ...photo(120, 120, i + 3), drawW: 30, drawH: 30 } })));
  fs.writeFileSync(path.join(tmp, 'thousand.pdf'), many);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(x => x.name === 'ThreadTime').value * 1000;
  const cpu0 = await threadMs();
  await page.setInputFiles('#cp-file', path.join(tmp, 'thousand.pdf'));
  await page.waitForFunction(() => /^Picture (\d+) of 1,000/.test(document.querySelector('.cp-state').textContent) && +/^Picture (\d+)/.exec(document.querySelector('.cp-state').textContent)[1] >= 100, null, { timeout: 120000 });
  const cpu = Math.round(await threadMs() - cpu0);
  assert.ok(cpu < 1500, `100 pictures in, the page's own thread has used ${cpu} ms of CPU: the work runs in a worker`);
  assert.equal(await page.isVisible('#cp-cancel'), true);
  // A double click cancels once: Compress takes Cancel's place, and the second click must not press it.
  await page.dblclick('#cp-cancel');
  assert.equal((await rowOf('thousand.pdf')).state, 'Cancelled.');
  assert.equal(await page.isVisible('#cp-go'), true, 'Compress starts again after Cancel');
  assert.equal(await page.isHidden('#cp-cancel'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cp-go');
  const stateAfter = (await rowOf('thousand.pdf')).state;
  await page.waitForTimeout(1500);
  assert.equal((await rowOf('thousand.pdf')).state, stateAfter, 'nothing more happens after Cancel');
  // A level changed while a file is being compressed: the old work is dropped, never shown.
  // Compress is double-clicked: it starts once, and the second click does not press Cancel.
  await page.dblclick('#cp-go');
  assert.equal(await page.isVisible('#cp-cancel'), true, 'a double click on Compress does not cancel what it started');
  await page.waitForFunction(() => /^Picture \d+ of 1,000 at 150/.test(document.querySelector('.cp-state').textContent), null, { timeout: 120000 });
  await level('strong');
  await page.waitForFunction(() => /^Picture \d+ of 1,000 at 100/.test(document.querySelector('.cp-state').textContent), null, { timeout: 120000 });
  await idle(page, 300000);
  const thousand = await download(dlButton('thousand.pdf'));
  assert.equal((await rowOf('thousand.pdf')).meta, `${fmt(many.length)} · 1,000 pages`);
  if (tools) {
    const v = verify(path.join(tmp, 'thousand.pdf'), thousand.buf);
    assert.deepEqual(v.check, []);
    assert.equal(v.same.pages, true);
  }
  {
    // Strong: 120 px drawn 30 pt wide is 288 ppi; at 100 ppi it becomes 42 x 42
    const info = await page.evaluate(async b64 => {
      const lib = await import('/assets/vendor/pdfjs/pdf.min.js');
      const doc = await lib.getDocument({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), verbosity: 0 }).promise;
      const pg = await doc.getPage(1000);
      const ops = await pg.getOperatorList();
      const t = (await pg.getTextContent()).items.map(i => i.str).join('');
      return { pages: doc.numPages, text: t, ops: ops.fnArray.length };
    }, thousand.buf.toString('base64'));
    assert.deepEqual([info.pages, info.text], [1000, 'Page 1000']);
  }
  await cdp.detach();

  // A level changed while the finished copy is being checked: that copy is dropped too.
  await clear();
  await level('recommended');
  await page.evaluate(() => {
    const strong = document.querySelector('input[name="cp-level"][value="strong"]');
    const obs = new MutationObserver(() => {
      const st = document.querySelector('.cp-state');
      if (st && st.textContent === 'Checking the copy…') { obs.disconnect(); strong.click(); }
    });
    obs.observe(document.getElementById('cp-files'), { childList: true, characterData: true, subtree: true });
  });
  await listen(page);
  await page.setInputFiles('#cp-file', fx('photo.pdf'));
  await page.waitForFunction(() => document.querySelector('input[name="cp-level"][value="strong"]').checked);
  await idle();
  {
    const got = await download(dlButton('photo.pdf'));
    const state = (await rowOf('photo.pdf')).state;
    assert.equal(state, `${fmt(got.buf.length)}, ${pct(fs.statSync(fx('photo.pdf')).size, got.buf.length)}% smaller.`);
    if (tools) check('photo.pdf', got.buf, 'strong', '', { psnr: 26 });
    // The dropped copy was never shown or said: the only result announced is the one made at Strong.
    await page.waitForFunction(t => window.__said.join(' ').includes(t), 'photo.pdf: ' + state, { timeout: 5000 }).catch(() => {});
    const said = (await page.evaluate(() => window.__said)).join('\n');
    assert.deepEqual(said.match(/photo\.pdf: [^\n]*?smaller\./g), ['photo.pdf: ' + state], `one result is announced, the final one (said: ${said})`);
  }

  // ---------- A 100 MB file: a note about memory, and nothing worse ----------
  await clear();
  await level('recommended');
  {
    const big = Buffer.alloc(101 * 1024 * 1024);
    for (let i = 0, s = 11; i < big.length; i += 4) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; big.writeUInt32LE(s, i); }
    fs.writeFileSync(path.join(tmp, 'big.pdf'), buildPdf([{ text: 'Big attachment' }], { attachment: big, filtered: true }));
  }
  await page.setInputFiles('#cp-file', path.join(tmp, 'big.pdf'));
  await idle(page, 300000);
  assert.deepEqual(await rowOf('big.pdf'), {
    name: 'big.pdf', meta: `${fmt(fs.statSync(path.join(tmp, 'big.pdf')).size)} · 1 page`, state: 'Already compact: keep your original.',
    note: 'It has no pictures to shrink, and its text and fonts are already stored compactly. A file this large needs about twice its size in memory, which can fail on a phone.',
    dl: false, pv: false,
  });

  // ---------- The preview at actual size ----------
  await clear();
  await page.setInputFiles('#cp-file', fx('photo.pdf'));
  await idle();
  await pvButton('photo.pdf').click();
  await page.waitForFunction(() => !document.getElementById('cp-preview').hidden && document.getElementById('cp-wait').hidden);
  assert.equal(await text('#cp-pv-title'), 'Preview: photo-compressed.pdf');
  assert.equal(await pvButton('photo.pdf').getAttribute('aria-pressed'), 'true');
  // 5 x 4 in at 96 px per inch, on a screen with one device pixel per CSS pixel
  const canvasSize = () => page.$eval('#cp-canvas', c => [c.width, c.height, c.getAttribute('aria-label')]);
  assert.deepEqual(await canvasSize(), [480, 384, 'Page 1 of the compressed copy at 100%']);
  assert.equal(await text('#cp-pv-info'), 'Page 1 of 1, compressed, at actual size (100%). Switch between Compressed and Original to compare.');
  const pixels = () => page.$eval('#cp-canvas', c => Array.from(c.getContext('2d').getImageData(96, 72, 288, 192).data));
  const after = await pixels();
  await page.check('input[name="cp-show"][value="orig"]');
  await page.waitForFunction(() => /original/.test(document.getElementById('cp-canvas').getAttribute('aria-label')));
  const before = await pixels();
  let diff = 0;
  for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - after[i]);
  diff /= before.length;
  assert.ok(diff > 0.1 && diff < 12, `the original and the copy look alike but not identical at 100% (mean difference ${diff.toFixed(2)})`);
  // The page number field
  for (const [v, msg] of [['0', 'Enter a page number from 1 to 1.'], ['2', 'Enter a page number from 1 to 1.'], ['1,0', 'Enter a page number from 1 to 1.'], ['x', 'Enter a page number from 1 to 1.']]) {
    await page.fill('#cp-page', v);
    await page.press('#cp-page', 'Enter');
    assert.equal(await text('#cp-page-error'), msg);
    assert.equal(await page.getAttribute('#cp-page', 'aria-invalid'), 'true');
    assert.match(await page.getAttribute('#cp-page', 'aria-describedby'), /\bcp-page-error\b/);
  }
  await page.$eval('#cp-page', el => { el.value = '1'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cp-page', el => el.value.length), 40, 'a megabyte pasted into the page field is cut at once');
  await page.click('#cp-prev');
  assert.equal(await page.inputValue('#cp-page'), '1');
  assert.equal(await page.$eval('#cp-prev', b => b.textContent), '− Previous page', 'the button is named after the sign it shows');
  assert.equal(await page.getAttribute('#cp-page', 'aria-invalid'), null);
  await page.click('#cp-pv-close');
  assert.equal(await page.isHidden('#cp-preview'), true);
  assert.equal(await pvButton('photo.pdf').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Preview', 'focus returns to the Preview button');
  // A change of level drops the copy, and the preview with it.
  await pvButton('photo.pdf').click();
  await page.waitForFunction(() => !document.getElementById('cp-preview').hidden);
  await level('light');
  assert.equal(await page.isHidden('#cp-preview'), true, 'a copy made with other settings is never previewed');
  assert.equal((await rowOf('photo.pdf')).dl, false, 'or offered for download');
  await idle();
  await level('recommended');
  await idle();

  // ---------- The live region: one announcement per file, when its result is known ----------
  await clear();
  await listen(page);
  await page.setInputFiles('#cp-file', fx('scan-grey.pdf'));
  await idle();
  await page.waitForTimeout(300);
  const said = await page.evaluate(() => window.__said);
  const r1 = await rowOf('scan-grey.pdf');
  // Messages that come within a moment of each other are said in one go: what matters is that
  // nothing but these two is said, each once, in this order.
  assert.equal(said.join(' '), '1 file added. scan-grey.pdf: ' + r1.state, 'progress is never announced, the result once');

  // ---------- Back and Forward: the controls the browser restores are read again ----------
  await page.evaluate(() => {
    document.querySelector('input[name="cp-level"][value="fit"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await page.isVisible('#cp-fit'), true);
  assert.match(await text('#cp-level-hint'), /^Searches the levels from 220 down to 72 ppi/);
  await idle();
  assert.equal((await rowOf('scan-grey.pdf')).state, 'Already under 500\u00a0KB, so it was left as it is: keep your original.');

  // ---------- The PDF library fails to load: a clear message, and Compress tries again ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const fp = await ctx.newPage();
    let blocked = true;
    await fp.route('**/pdf-lib.min.js', route => (blocked ? route.fulfill({ status: 404, body: 'gone' }) : route.continue()));
    await fp.goto(url);
    await fp.setInputFiles('#cp-file', [fx('photo.pdf'), fx('scan-colour.pdf')]);
    await idle(fp);
    for (const n of ['photo.pdf', 'scan-colour.pdf']) {
      assert.deepEqual(await rowOf(n, fp).then(r => [r.state, r.dl]), ['The PDF tools could not load. Check your connection, then press Compress.', false]);
    }
    assert.equal(await fp.textContent('#cp-sum'), '2 files not compressed yet: press Compress.', 'the summary does not say the files failed to get smaller');
    assert.equal(await fp.isVisible('#cp-go'), true);
    blocked = false;
    // The tab is in the background (as when the visitor switches tabs): the work goes on.
    await fp.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Compress is double-clicked: Cancel takes its place, and the second click must not press it.
    await fp.dblclick('#cp-go');
    assert.equal(await fp.isVisible('#cp-cancel'), true, 'a double click on Compress does not cancel what it started');
    assert.equal(await fp.evaluate(() => document.activeElement.id), 'cp-cancel', 'Compress hands the focus to Cancel, which takes its place');
    await idle(fp);
    assert.match((await rowOf('photo.pdf', fp)).state, /^\S+\u00a0KB, \d+% smaller\.$/);
    // Cancel went when the work was done: the focus moves on to the copies, not to the top of the page.
    assert.equal(await fp.evaluate(() => document.activeElement.id), 'cp-zip', 'the focus moves on to Download all');
    await ctx.close();
  }

  // ---------- A background tab: the browser holds back animation frames, and the work goes on ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      // As browsers run a hidden tab: requestAnimationFrame callbacks wait until it is shown again.
      let hidden = false;
      const held = [], raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => { if (hidden) { held.push(cb); return 0; } return raf(cb); };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      window.__hide = h => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); if (!h) held.splice(0).forEach(cb => raf(cb)); };
    });
    const hp = await ctx.newPage();
    await hp.goto(url);
    await hp.evaluate(() => window.__hide(true));
    await hp.setInputFiles('#cp-file', [fx('cmyk.pdf'), fx('photo.pdf')]);
    // Polled on a timer: Playwright polls on animation frames by default, and those are held.
    const done = await hp.waitForFunction(() => {
      const r = [...document.querySelectorAll('.cp-file')];
      return r.length === 2 && document.getElementById('cp-cancel').hidden && r.every(e => !/\u2026$/.test(e.querySelector('.cp-state').textContent));
    }, null, { timeout: 60000, polling: 250 }).then(() => true, () => false);
    const states = await hp.$$eval('.cp-state', l => l.map(e => e.textContent));
    assert.ok(done && states.every(s => /% smaller\.$/.test(s)), `both files are compressed in a background tab, the CMYK picture too: ${JSON.stringify(states)}`);
    await ctx.close();
  }

  // ---------- Out of memory: said as such, not as a damaged file ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      // The worker cannot have the buffers it asks for, as on a phone short of memory: its copies of
      // parts of the file fail the way Chromium fails an allocation.
      const make = URL.createObjectURL.bind(URL);
      const short = 'var s = Uint8Array.prototype.slice; Uint8Array.prototype.slice = function (a, b) { var e = b === undefined ? this.length : b;' +
        ' if (e - (a || 0) > 20000) throw new RangeError("Array buffer allocation failed"); return s.apply(this, arguments); };\n';
      URL.createObjectURL = b => make(b instanceof Blob && b.type === 'text/javascript' ? new Blob([short, b], { type: 'text/javascript' }) : b);
    });
    const mp = await ctx.newPage();
    await mp.goto(url);
    await mp.setInputFiles('#cp-file', fx('photo.pdf'));
    await idle(mp);
    assert.deepEqual(await rowOf('photo.pdf', mp).then(r => [r.state, r.dl]), ['The browser ran out of memory. Try this file on a computer, or split it first.', false]);
    await ctx.close();
  }

  // ---------- The keyboard alone ----------
  const kb = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
  await kb.goto(url);
  let found = false;
  for (let i = 0; i < 30 && !found; i++) { await kb.keyboard.press('Tab'); found = await kb.evaluate(() => document.activeElement.id === 'cp-choose'); }
  assert.ok(found, 'Tab reaches Choose PDF files');
  assert.equal(await kb.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'with a visible focus ring');
  // Playwright starts catching the file chooser when asked to wait for it; a round trip to the
  // page makes sure it does before the key is pressed (a context closed just before can delay it).
  const chooserP = kb.waitForEvent('filechooser');
  await kb.evaluate(() => 0);
  await kb.keyboard.press('Enter');
  const chooser = await chooserP;
  await chooser.setFiles(fx('scan-colour.pdf'));
  await idle(kb);
  // To the levels, arrow to Strong
  for (let i = 0; i < 10 && !(await kb.evaluate(() => document.activeElement.name === 'cp-level')); i++) await kb.keyboard.press('Tab');
  assert.equal(await kb.evaluate(() => document.activeElement.value), 'recommended');
  await kb.keyboard.press('ArrowRight');
  assert.equal(await kb.isChecked('input[name="cp-level"][value="strong"]'), true);
  await idle(kb);
  for (let i = 0; i < 20 && !(await kb.evaluate(() => document.activeElement.textContent === 'Download')); i++) await kb.keyboard.press('Tab');
  const [kd] = await Promise.all([kb.waitForEvent('download'), kb.keyboard.press('Enter')]);
  assert.equal(kd.suggestedFilename(), 'scan-colour-compressed.pdf');
  if (tools) check('scan-colour.pdf', fs.readFileSync(await kd.path()), 'strong', '', { psnr: 26 });
  await kb.context().close();

  // ---------- A phone with a touch screen ----------
  const phone = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const p = await phone.newPage();
  await p.goto(url);
  const pcP = p.waitForEvent('filechooser');
  await p.evaluate(() => 0);
  await p.tap('#cp-choose');
  const pc = await pcP;
  await pc.setFiles([fx('photo.pdf'), fx('enc-aes-256.pdf')]);
  await idle(p);
  await p.tap('#cp-pw');
  await p.fill('#cp-pw', 'aes two five six');
  await p.tap('#cp-pw-go');
  await idle(p);
  const [pd] = await Promise.all([p.waitForEvent('download'), dlButton('photo.pdf', p).tap()]);
  assert.equal(pd.suggestedFilename(), 'photo-compressed.pdf');
  await pvButton('photo.pdf', p).tap();
  await p.waitForFunction(() => document.getElementById('cp-wait').hidden);
  await p.tap('input[name="cp-show"][value="orig"] >> xpath=..');
  assert.equal(await p.isChecked('input[name="cp-show"][value="orig"]'), true);
  const small = await p.$$eval('#cp button:not([hidden]), #cp .cp-seg label, #cp input[type="text"], #cp input[type="password"], #cp select', l => l
    .filter(e => e.getClientRects().length && !e.closest('[hidden]'))
    .filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.textContent.trim()));
  assert.deepEqual(small, [], 'every control is at least 44 px tall on a touch screen');
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= 412), 'no sideways scroll on the phone');
  await phone.close();

  // ---------- Text fits its button or box at every width from 320 to 540 px ----------
  const narrow = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true });
  const np = await narrow.newPage();
  await np.goto(url);
  await np.setInputFiles('#cp-file', [fx('photo.pdf'), fx('scan-colour.pdf')]);
  await idle(np);
  await pvButton('photo.pdf', np).click();
  for (const w of [320, 340, 360, 390, 414, 440, 480, 540]) {
    await np.setViewportSize({ width: w, height: 700 });
    for (const lv of ['custom', 'fit']) {
      await np.check(`input[name="cp-level"][value="${lv}"]`);
      const cut = await np.$$eval('#cp button, #cp .cp-seg label, #cp select, #cp .cp-name, #cp .cp-state', l => l
        .filter(e => e.getClientRects().length)
        .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.id || e.textContent.trim().slice(0, 30)));
      assert.deepEqual(cut, [], `nothing is cut off at ${w} px (${lv})`);
      assert.ok(await np.evaluate(v => document.documentElement.scrollWidth <= v, w), `no sideways scroll at ${w} px`);
    }
    const opt = await np.$eval('#cp-limit', s => { const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(s).font; return { need: Math.max(...[...s.options].map(o => c.measureText(o.text).width)), have: s.clientWidth }; });
    assert.ok(opt.need + 40 <= opt.have, `the longest size limit fits its box at ${w} px`);
  }
  await narrow.close();

  // ---------- A decimal-comma locale reads the fields the same way ----------
  const de = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const dp = await de.newPage();
  await dp.goto(url);
  await dp.check('input[name="cp-level"][value="custom"]');
  for (const [v, ok] of [['150', true], ['1.000', false], ['0,500', false], ['150,0', false]]) {
    await dp.fill('#cp-ppi', v);
    await dp.press('#cp-ppi', 'Enter');
    assert.equal(await dp.getAttribute('#cp-ppi', 'aria-invalid'), ok ? null : 'true', `de-DE: "${v}"`);
  }
  await de.close();

  // ---------- A new tab whose first request for PDF.js fails, as a dropped connection leaves it ----------
  // PDF.js checks each copy and draws the preview. A copy made while it could not load is offered
  // unchecked. The browser keeps a module that failed to load as failed for the page, so the next
  // use, the preview, must ask for it under another address.
  {
    const fresh = await page.context().browser().newContext({ acceptDownloads: true });
    const p3 = await fresh.newPage();
    const p3errors = [], parses = [];
    p3.on('pageerror', e => p3errors.push(e.message));
    p3.on('console', m => {
      if (m.text().startsWith('pdf-lib parse: ')) parses.push(m.text().slice(15));
      else if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) p3errors.push(m.text());
    });
    let readerAsks = 0;
    await p3.route(/\/pdfjs\/pdf\.min\.js(\?.*)?$/, route => (readerAsks++ ? route.fallback() : route.abort('connectionreset')));
    await p3.route('**/assets/vendor/pdf-lib/pdf-lib.min.js', async route => {
      const r = await route.fetch();
      await route.fulfill({ response: r, body: (await r.text()) + PARSE_SPY });
    });
    await p3.goto(url);
    await p3.setInputFiles('#cp-file', fx('photo.pdf'));
    await idle(p3);
    assert.equal(readerAsks, 1, 'PDF.js was asked for, to check the copy');
    assert.equal((await rowOf('photo.pdf', p3)).dl, true, 'a copy PDF.js could not check is offered');
    await pvButton('photo.pdf', p3).click();
    await p3.waitForFunction(() => !document.getElementById('cp-preview').hidden && document.getElementById('cp-wait').hidden);
    assert.equal(await p3.textContent('#cp-pv-info'), 'Page 1 of 1, compressed, at actual size (100%). Switch between Compressed and Original to compare.',
      'PDF.js loads on the next try, for the preview');
    assert.equal(readerAsks, 2);

    // ---------- pdf-lib reads a file once, and without pausing: it runs in a worker ----------
    // An encrypted file was read three times: by this page to see that it is encrypted, then twice by
    // the shared unlocker, 400 objects at a time. It is now read once to find its key, then once more
    // to decrypt it, and a file that is not encrypted once.
    const parsed = async n => {
      for (let i = 0; i < 100 && parses.length < n; i++) await p3.waitForTimeout(20);
      return parses.splice(0);
    };
    assert.deepEqual(await parsed(1), ['Infinity'], 'photo.pdf is read once');
    await p3.setInputFiles('#cp-file', fx('enc-restricted.pdf'));
    await idle(p3);
    assert.equal((await rowOf('enc-restricted.pdf', p3)).dl, true, 'enc-restricted.pdf is compressed');
    assert.deepEqual(await parsed(2), ['Infinity', 'Infinity'], 'an encrypted file is read twice, without pausing');
    assert.deepEqual(p3errors, []);
    await fresh.close();
  }

  // ---------- Leave the main page with a result on screen ----------
  await clear();
  await page.setInputFiles('#cp-file', [fx('photo.pdf'), fx('enc-aes-256.pdf'), fx('not-a-pdf.pdf')]);
  await idle();
}
