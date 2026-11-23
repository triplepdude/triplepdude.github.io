const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// Fixtures (tests/fixtures/rotate-pdf, made by make_fixtures.py; see its header): mixed.pdf has 6 pages
// of mixed sizes with /Rotate 90 (page 3), 270 inherited from a /Pages node (page 4) and 450 (page 5),
// bookmarks, links, a form field, tags and an attachment; its text runs upright on pages 1 and 3-5,
// upside down on page 2 and from bottom to top on page 6. mixed-objstm.pdf is the same with a
// cross-reference stream, linearized.pdf linearised, updated.pdf has an earlier update, hybrid.pdf a
// /XRefStm. The enc-*.pdf files need "open sesame"; no-assembly.pdf and no-modify-r2.pdf forbid page
// assembly without "owner secret". signed.pdf and certified.pdf carry signatures; cut.pdf, garbage.pdf,
// badxref.pdf and enc-badxref.pdf are damaged but readable, truncated.pdf is not. A 1,000-page file and a 100 MB file are made here.
//
// The page writes with pdf-lib. Every saved file is checked independently: its bytes here (the
// original is kept as the first part, the trailer points back at it), PDF.js in the browser (each
// page's rotation and marker), and, when python3 with pikepdf and poppler are installed, verify.py:
// libqpdf's check, each page's rotation read by pikepdf and by pdfinfo, and the outline, links,
// fields, tags, attachments, encryption and page strings compared with the original.

// Added to pdf-lib as a test page loads it: each time pdf-lib reads a file (PDFDocument.load reads
// through the same function), it logs how many objects it reads between pauses: "pdf-lib parse: 400".
const PARSE_SPY = '\n;(function () { var P = self.PDFLib.PDFParser, f = P.forBytesWithOptions; P.forBytesWithOptions = function (b, n) { console.log("pdf-lib parse: " + n); return f.apply(this, arguments); }; })();\n';

function rawPdf(objs, trailer = '') {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offs = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.isBuffer(o) ? Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n'), o, Buffer.from('\nendobj\n')]) : Buffer.from((i + 1) + ' 0 obj\n' + o + '\nendobj\n', 'latin1');
    offs.push(len);
    parts.push(b);
    len += b.length;
  });
  let x = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  x += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R' + trailer + ' >>\nstartxref\n' + len + '\n%%EOF\n';
  parts.push(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
}
// n small pages, each with the marker BIG-MARK-nnnn.
function manyPages(n) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'], kids = [];
  for (let i = 0; i < n; i++) {
    const c = `BT /F1 30 Tf 30 300 Td (BIG-MARK-${String(i + 1).padStart(4, '0')}) Tj ET`;
    kids.push((4 + 2 * i) + ' 0 R');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
  return rawPdf(objs);
}
// 3 pages and an attached file of `size` random bytes.
function bigPdf(size) {
  const data = crypto.randomBytes(size);
  const objs = ['<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(noise.bin) 6 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'];
  for (let i = 0; i < 3; i++) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 9 0 R >> >> /Contents ${10 + i} 0 R >>`);
  objs.push('<< /Type /Filespec /F (noise.bin) /UF (noise.bin) /EF << /F 7 0 R >> >>');
  objs.push(Buffer.concat([Buffer.from(`<< /Type /EmbeddedFile /Length ${size} >>\nstream\n`), data, Buffer.from('\nendstream')]));
  objs.push('<< /Title (Big file) >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < 3; i++) { const c = `BT /F1 40 Tf 72 700 Td (HUGE-MARK-0${i + 1}) Tj ET`; objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`); }
  return rawPdf(objs, ' /Info 8 0 R');
}

// A PDF from objects [{ n, g, body }] with a classic table; eol false ends it at %%EOF with no end of
// line, as some writers do.
function pdfFrom(list, trailer = '', eol = true) {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], at = {};
  let len = parts[0].length;
  for (const o of list) {
    const b = Buffer.concat([Buffer.from(`${o.n} ${o.g || 0} obj\n`), Buffer.from(o.body, 'latin1'), Buffer.from('\nendobj\n')]);
    at[o.n] = String(len).padStart(10, '0') + ' ' + String(o.g || 0).padStart(5, '0') + ' n \n';
    parts.push(b);
    len += b.length;
  }
  const size = Math.max(...list.map(o => o.n)) + 1;
  let x = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
  for (let n = 1; n < size; n++) x += at[n] || '0000000000 00001 f \n';
  x += `trailer\n<< /Size ${size} /Root 1 0 R${trailer} >>\nstartxref\n${len}\n%%EOF` + (eol ? '\n' : '');
  parts.push(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
}
// A page (object n) with the marker text and its content stream (object n + 1).
const markPage = (n, text) => {
  const c = `BT /F1 30 Tf 30 300 Td (${text}) Tj ET`;
  return [{ n, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>` },
    { n: n + 1, body: `<< /Length ${c.length} >>\nstream\n${c}\nendstream` }];
};
const HEAD = [{ n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' }, { n: 2, body: '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>' },
  { n: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }];
// Page 1 is object 4 of generation 1 (a number used again, as some editors leave it), and the file
// ends at %%EOF with no end of line.
function genPdf() {
  const [p1, c1] = markPage(4, 'GEN-MARK-1');
  p1.g = 1;
  return pdfFrom([HEAD[0], { n: 2, body: '<< /Type /Pages /Kids [4 1 R 6 0 R] /Count 2 >>' }, HEAD[2], p1, c1, ...markPage(6, 'GEN-MARK-2')], '', false);
}
// Two pages in a file that ends with a cross-reference stream (W [1 4 2], not compressed), padded
// past 64 KB, so that the offsets in an update take three bytes.
function xrefStreamPdf(pad) {
  const objs = [...HEAD, ...markPage(4, 'XSTM-MARK-1'), ...markPage(6, 'XSTM-MARK-2'), { n: 8, body: `<< /Length ${pad} >>\nstream\n${'%'.repeat(pad)}\nendstream` }];
  let s = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const rows = [], row = (t, a, b) => { const r = Buffer.alloc(7); r[0] = t; r.writeUInt32BE(a, 1); r.writeUInt16BE(b, 5); return r; };
  rows.push(row(0, 0, 65535));
  for (const o of objs) { rows.push(row(1, s.length, 0)); s += `${o.n} 0 obj\n${o.body}\nendobj\n`; }
  rows.push(row(1, s.length, 0));
  const xoff = s.length, data = Buffer.concat(rows), id = '<00112233445566778899AABBCCDDEEFF>';
  s += `9 0 obj\n<< /Type /XRef /Size 10 /W [1 4 2] /Root 1 0 R /ID [${id} ${id}] /Length ${data.length} >>\nstream\n`;
  return Buffer.concat([Buffer.from(s, 'latin1'), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`, 'latin1')]);
}
// Two pages with Adobe usage rights (Reader extensions, as on many tax forms): a signature
// dictionary whose reference has /TransformMethod /UR3, kept in the catalogue's /Perms. With
// approval, also a signature field signed by a person. Neither signature is a real one: the page
// only tells which kind each is.
function rightsPdf(approval) {
  const sig = more => `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20 10] /Contents <${'00'.repeat(32)}>${more} >>`;
  const list = [{ n: 1, body: `<< /Type /Catalog /Pages 2 0 R /Perms << /UR3 8 0 R >>${approval ? ' /AcroForm << /Fields [9 0 R] /SigFlags 3 >>' : ''} >>` }, HEAD[1], HEAD[2],
    ...markPage(4, 'RIGHTS-MARK-1'), ...markPage(6, 'RIGHTS-MARK-2'),
    { n: 8, body: sig(' /Reference [<< /Type /SigRef /TransformMethod /UR3 /TransformParams << /Type /TransformParams /V /2.2 /Document [/FullSave] /Form [/FillIn] >> >>]') }];
  if (approval) list.push({ n: 9, body: '<< /FT /Sig /T (Approval) /V 10 0 R /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 4 0 R /F 132 >>' }, { n: 10, body: sig('') });
  return pdfFrom(list);
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

// The last cross-reference section of a file: its offset, its kind and its trailer's text.
function lastSection(buf) {
  const s = buf.toString('latin1'), k = s.lastIndexOf('startxref'), off = parseInt(s.slice(k + 9).trim(), 10);
  const at = s.slice(off, off + 200000);
  if (at.startsWith('xref')) return { off, kind: 'table', dict: at.slice(at.indexOf('trailer') + 7, at.indexOf('startxref')) };
  return { off, kind: /^\d+ \d+ obj/.test(at) ? 'stream' : '?', dict: at.slice(at.indexOf('<<'), at.indexOf('stream')) };
}
// An entry's value, with white space that does not matter taken out ("[ <AB> <CD> ]" is "[<AB> <CD>]").
const entry = (dict, key) => {
  const m = new RegExp('/' + key + '\\s*(\\d+\\s+\\d+\\s+R|\\d+|\\[[^\\]]*\\])').exec(dict);
  return m ? m[1].replace(/\s+/g, ' ').replace(/\[\s*/g, '[').replace(/\s*\]/g, ']').replace(/>\s*</g, '> <') : null;
};

// The objects in use that the last cross-reference section of buf lists: [number, generation, offset].
// A table entry must be exactly 20 bytes long (ISO 32000-1 7.5.4).
function sectionEntries(buf, sec, assert, label) {
  const s = buf.toString('latin1'), out = [];
  if (sec.kind === 'table') {
    let p = sec.off + 4;
    while (/\s/.test(s[p])) p++;
    for (let h; (h = /^(\d+) (\d+)[ \t]*(?:\r\n|\n|\r)/.exec(s.slice(p, p + 40)));) {
      p += h[0].length;
      for (let i = 0; i < Number(h[2]); i++, p += 20) {
        const e = s.slice(p, p + 20);
        assert.match(e, /^\d{10} \d{5} [nf](?: \r| \n|\r\n)$/, `${label}: a table entry is exactly 20 bytes (${JSON.stringify(e)})`);
        if (e[17] === 'n') out.push([Number(h[1]) + i, Number(e.slice(11, 16)), Number(e.slice(0, 10))]);
      }
    }
    return out;
  }
  const d = sec.dict, W = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(d).slice(1).map(Number);
  const index = /\/Index\s*\[([^\]]*)\]/.exec(d), runs = index ? index[1].trim().split(/\s+/).map(Number) : [0, Number(entry(d, 'Size'))];
  assert.ok(!/\/DecodeParms/.test(d), `${label}: the new cross-reference stream has no predictor (not read here)`);
  let at = s.indexOf('stream', sec.off + d.length) + 6;
  if (s[at] === '\r') at++;
  if (s[at] === '\n') at++;
  let data = buf.subarray(at, at + Number(entry(d, 'Length')));
  if (/\/Filter/.test(d)) data = zlib.inflateSync(data);
  let pos = 0;
  const field = (w, dflt) => { if (!w) return dflt; let v = 0; for (let j = 0; j < w; j++) v = v * 256 + data[pos++]; return v; };
  for (let r = 0; r < runs.length; r += 2) {
    for (let i = 0; i < runs[r + 1]; i++) {
      const t = field(W[0], 1), f2 = field(W[1], 0), f3 = field(W[2], 0);
      if (t === 1) out.push([runs[r] + i, f3, f2]);
    }
  }
  return out;
}

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const fx = n => path.join(fixtures, n);
  const expected = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-pdf-test-'));
  let tools = true;
  try {
    execFileSync('python3', ['-c', 'import pikepdf'], { stdio: 'ignore' });
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
  } catch (e) { tools = false; }
  if (!tools) console.log('  (rotate-pdf: python3 with pikepdf, or poppler, is missing: copies are checked with PDF.js and their bytes only)');
  const verify = (orig, file, pw) => JSON.parse(execFileSync('python3', [fx('verify.py'), orig, file, pw || ''], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  try {
    await open();
    const text = sel => page.textContent(sel);
    const status = () => text('#rot-status');
    // What the status line says, in order, recorded from when listen() runs; said() empties the record.
    const listen = () => page.evaluate(() => {
      window.__said = [];
      const s = document.getElementById('rot-status');
      new MutationObserver(() => { if (s.textContent) window.__said.push(s.textContent); }).observe(s, { childList: true, characterData: true, subtree: true });
    });
    const said = () => page.evaluate(() => window.__said.splice(0));
    await listen();
    const states = () => page.$$eval('.rot-state', l => l.map(e => e.textContent));
    const checked = () => page.$$eval('.rot-check', l => l.map(e => e.checked));
    const turns = () => page.$$eval('.rot-thumb img', l => l.map(e => e.style.transform));
    const sec = n => `.rot-file:nth-of-type(${n})`;
    const card = (n, f = 1) => `${sec(f)} .rot-page:nth-child(${n})`;
    const btn = (n, q, f = 1) => `${card(n, f)} .rot-tb[data-q="${q}"]`;
    let downloads = 0;
    page.on('download', () => { downloads++; });
    const save = async (sel = '#rot-go', timeout = 60000) => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), page.click(sel)]);
      const file = path.join(tmp, String(downloads) + '-' + dl.suggestedFilename());
      await dl.saveAs(file);
      return { name: dl.suggestedFilename(), file, buf: fs.readFileSync(file) };
    };
    const ready = () => page.waitForFunction(() => !document.querySelector('.rot-pages[data-reading]') && !document.querySelector('.rot-wait-file:not([hidden])'), null, { timeout: 60000 });
    const addFiles = async (list, total) => {
      await page.setInputFiles('#rot-file', list);
      await page.waitForFunction(n => document.querySelectorAll('.rot-page').length === n, total, { timeout: 60000 });
      await ready();
    };
    const clearAll = async () => {
      if (await page.isVisible('#rot-clear')) await page.click('#rot-clear');
      await page.waitForFunction(() => !document.querySelector('.rot-file'));
    };
    // Reads a saved PDF with PDF.js, through a file input of its own: rotation and marker of each page,
    // and the note on any page.
    await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 't-read'; i.hidden = true; document.body.appendChild(i); });
    const readBack = async (file, password) => {
      await page.setInputFiles('#t-read', file);
      return page.evaluate(async pw => {
        const f = document.getElementById('t-read').files[0];
        // A name of its own: the page's first copy of the module was made to fail above, and stays failed.
        const lib = await import('/assets/vendor/pdfjs/pdf.min.js?read-back');
        lib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.js';
        const task = lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), password: pw || undefined, verbosity: 0 });
        const doc = await task.promise;
        const meta = await doc.getMetadata();
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const pg = await doc.getPage(i);
          const t = (await pg.getTextContent()).items.map(x => x.str).join(' ');
          const notes = (await pg.getAnnotations()).filter(a => a.contentsObj && a.contentsObj.str).map(a => a.contentsObj.str);
          pages.push({ rotate: pg.rotate, mark: (t.match(/[A-Z]+-MARK-\d+/) || [''])[0], notes });
        }
        const outline = await doc.getOutline();
        const att = await doc.getAttachments();
        await task.destroy();
        return { encrypted: !!meta.info.EncryptFilterName, pages, outline: outline ? outline.map(o => o.title) : [], attachments: att ? (att instanceof Map ? [...att.keys()] : Object.keys(att)) : [] };
      }, password);
    };
    // The bytes of an incremental update: the original first, then a section of the same kind whose
    // trailer points back at the original's and repeats its /Root, /Info, /ID and /Encrypt.
    const checkUpdate = (orig, out, label) => {
      assert.ok(out.length > orig.length && out.subarray(0, orig.length).equals(orig), label + ': the original bytes come first, unchanged');
      const a = lastSection(orig), b = lastSection(out);
      assert.equal(b.kind, a.kind, label + ': the update has a cross-reference section of the same kind as the original');
      assert.equal(Number(entry(b.dict, 'Prev')), a.off, label + ': /Prev points at the original last section');
      assert.ok(Number(entry(b.dict, 'Size')) >= Number(entry(a.dict, 'Size')), label + ': /Size is not smaller than the original');
      for (const k of ['Root', 'Info', 'ID', 'Encrypt']) assert.equal(entry(b.dict, k), entry(a.dict, k), label + ': /' + k + ' is repeated');
      // Byte by byte: each entry of the new section points exactly at "n g obj" of its own generation
      // in the update, /Size covers every number, and each /Rotate written is 0, 90, 180 or 270.
      const news = sectionEntries(out, b, assert, label), s = out.toString('latin1');
      assert.ok(news.length > 0, label + ': the update lists its objects');
      for (const [n, g, off] of news) assert.ok(off >= orig.length && s.startsWith(`${n} ${g} obj`, off), `${label}: "${n} ${g} obj" is at ${off}`);
      assert.ok(news.every(e => e[0] < Number(entry(b.dict, 'Size'))), label + ': /Size covers the new objects');
      for (const m of s.slice(orig.length).matchAll(/\/Rotate\s+([-+]?[\d.]+)/g)) assert.ok(['0', '90', '180', '270'].includes(m[1]), `${label}: /Rotate ${m[1]} is written as 0, 90, 180 or 270`);
    };
    // libqpdf, pikepdf and poppler (when installed): no problem, the rotations expected, and what the
    // original holds kept.
    const checkCopy = (orig, file, pw, rotations, label, opts = {}) => {
      if (!tools) return null;
      const v = verify(orig, file, pw);
      assert.deepEqual(v.check, opts.oldProblems ? v.check_orig : [], label + ': libqpdf finds no problem in the copy');
      assert.deepEqual(v.rotations, rotations, label + ': rotations read by pikepdf');
      assert.deepEqual(v.poppler, rotations, label + ': rotations read by pdfinfo');
      for (const [k, same] of Object.entries(v.same)) assert.ok(same, `${label}: ${k} kept (${JSON.stringify(v.detail[k] || '')})`);
      if (!opts.rewrite) {
        assert.equal(v.prefix, true, label + ': saved as an update');
        assert.equal(v.trailer, true, label + ': the new trailer repeats every entry of the last one except /Prev');
        assert.equal(v.last, v.orig_last, label + ': the section is of the file\'s own kind');
      }
      return v;
    };
    const rotationsOf = (facts, q) => facts.map((p, i) => (p.rotate + 90 * (q[i] || 0)) % 360);

    // ---------- the empty page explains itself ----------
    assert.equal(await page.isVisible('#rot-drop'), true);
    assert.equal(await page.isVisible('#rot-work'), false);
    assert.equal((await text('#rot-choose')).trim(), 'Choose PDF files');
    assert.match(await text('#rot-drop'), /never uploaded/);

    // ---------- the libraries fail to load (no connection): a clear message, and it works later ----------
    // The scripts come back as a script that fails, as a cut connection would leave them (an aborted
    // request would also log a console error, which the runner counts).
    const fail = route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("offline");' });
    const READER = /\/pdf\.min\.js(\?.*)?$/, WRITER = /\/pdf-lib\.min\.js(\?.*)?$/;
    await page.route(READER, fail);
    await page.setInputFiles('#rot-file', fx('mixed.pdf'));
    await page.waitForFunction(() => document.getElementById('rot-error').textContent);
    assert.equal(await text('#rot-error'), 'The PDF reader could not load. Check your connection and try again.');
    assert.equal(await page.isVisible('#rot-work'), false);
    await page.unroute(READER, fail);
    await page.route(WRITER, fail);
    await addFiles(fx('mixed.pdf'), 6);
    await page.click(`.rot-page:nth-child(1) .rot-tb[data-q="1"]`);
    await page.click('#rot-go');
    await page.waitForFunction(() => document.getElementById('rot-error').textContent);
    assert.equal(await text('#rot-error'), 'The PDF writer could not load. Check your connection and try again.');
    assert.equal(await text('#rot-status'), 'Nothing was saved.');
    assert.match(await text('#rot-out'), /Not saved: The PDF writer could not load/);
    await page.unroute(WRITER, fail);
    const again = await (async () => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rot-go')]); return fs.readFileSync(await dl.path()); })();
    checkUpdate(fs.readFileSync(fx('mixed.pdf')), again, 'after the writer loads');
    await clearAll();

    // ---------- not PDFs, an empty file and a damaged one ----------
    await page.setInputFiles('#rot-file', [
      { name: 'photo.pdf', mimeType: 'application/pdf', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') },
      { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) }]);
    await page.waitForFunction(() => /empty\.pdf is empty/.test(document.getElementById('rot-error').textContent));
    assert.equal(await text('#rot-error'), 'photo.pdf is not a PDF file. empty.pdf is empty.');
    assert.equal(await page.getAttribute('#rot-error', 'role'), 'alert');
    assert.equal(await page.isVisible('#rot-work'), false);
    await page.setInputFiles('#rot-file', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n' + 'x'.repeat(3000) + '\n%%EOF\n') });
    await page.waitForFunction(() => /broken\.pdf/.test(document.getElementById('rot-error').textContent));
    assert.equal(await text('#rot-error'), 'broken.pdf is damaged or is not a valid PDF.');
    // The first 60% of a file, as an interrupted download leaves it: PDF.js cannot rebuild it either.
    await page.setInputFiles('#rot-file', fx('truncated.pdf'));
    await page.waitForFunction(() => /truncated\.pdf/.test(document.getElementById('rot-error').textContent));
    assert.equal(await text('#rot-error'), 'truncated.pdf is damaged or is not a valid PDF.');
    assert.equal(await page.isVisible('#rot-work'), false);

    // ---------- mixed.pdf: what the page reads ----------
    await said();
    await addFiles(fx('mixed.pdf'), 6);
    assert.equal(await text('#rot-error'), '');
    assert.equal(await text(`${sec(1)} .rot-fmeta`), '6 pages · ' + (fs.statSync(fx('mixed.pdf')).size / 1024).toFixed(1) + '\u00a0KB');
    // Text upright in pages 1 and 3-5, but pages 3-5 are shown turned (/Rotate 90, 270, 90); page 2's
    // text is upside down and page 6's runs from bottom to top.
    assert.equal(await text('#rot-flags-text'), 'Text runs sideways or upside down on 5 pages: pages 2–6.');
    assert.deepEqual(await states(), ['', 'Upside-down text', 'Sideways text', 'Sideways text', 'Sideways text', 'Sideways text']);
    assert.equal(await status(), 'Text runs sideways or upside down on 5 pages of mixed.pdf.');
    // The file is announced once, when it is open (no "Opening…" just before), then what the text check found.
    assert.deepEqual(await said(), ['mixed.pdf is open: 6 pages.', 'Text runs sideways or upside down on 5 pages of mixed.pdf.']);
    assert.equal(await text('#rot-plan'), 'No pages turned yet. Use the buttons under a page, or select pages and use Rotate selected.');
    assert.equal(await page.getAttribute('#rot-plan', 'aria-live'), null, 'the plan is redrawn on every change, so it is not a live region');
    assert.equal(await page.getAttribute('#rot-status', 'role'), 'status');
    // Saving with nothing turned says so and saves nothing.
    const none = downloads;
    await page.click('#rot-go');
    await page.waitForFunction(() => document.getElementById('rot-status').textContent === 'No pages turned yet: turn some pages first.');
    assert.equal(downloads, none);

    // The buttons on a page, with what is announced.
    await page.click(btn(1, 1));
    assert.equal(await status(), 'Page 1 turned right.');
    assert.equal((await states())[0], 'Turned right · Sideways text');
    assert.equal((await turns())[0], 'rotate(90deg)');
    assert.equal(await text('#rot-plan'), '1 page turned in mixed.pdf.');
    await page.click(btn(1, 1));
    assert.equal(await status(), 'Page 1 turned right; it will be saved turned 180°.');
    await page.click(btn(1, 2));
    assert.equal(await status(), 'Page 1 is back as it was saved.');
    assert.equal((await states())[0], '');
    // Undo brings back each step in turn.
    await page.click('#rot-undo');
    assert.equal((await states())[0], 'Turned 180° · Upside-down text');
    await page.click('#rot-undo');
    assert.equal((await states())[0], 'Turned right · Sideways text');
    await page.click('#rot-undo');
    assert.equal((await states())[0], '');

    // Selecting: a click, Shift+click, then Rotate selected; buttons name what they act on.
    for (const b of await page.$$('.rot-bar button')) {
      const label = await b.getAttribute('aria-label'), visible = (await b.textContent()).trim();
      if (label) assert.ok(label.startsWith(visible), `the accessible name "${label}" starts with the visible text "${visible}"`);
    }
    // With nothing selected, Rotate selected looks off but still answers when pressed.
    assert.equal(await page.getAttribute('[data-sel="1"]', 'aria-disabled'), 'true');
    await page.focus('[data-sel="1"]');
    await page.keyboard.press('Enter');
    assert.equal(await status(), 'Select pages first: click them, or use the Select buttons.');
    await page.click(`${card(2)} .rot-thumb`);
    await page.click(`${card(4)} .rot-thumb`, { modifiers: ['Shift'] });
    assert.deepEqual(await checked(), [false, true, true, true, false, false]);
    assert.equal(await text('#rot-selcount'), '(3 pages)');
    await page.click('[data-sel="3"]');
    assert.equal(await status(), '3 pages turned left.');
    // Page 2's text now runs sideways, page 3 (saved at 90) is upright, page 4 (inherited 270) upside down.
    assert.deepEqual(await states(), ['', 'Turned left · Sideways text', 'Turned left', 'Turned left · Upside-down text', 'Sideways text', 'Sideways text']);
    await page.click('#rot-undo');
    // A drag across pages 4 to 6 selects them (it starts on an unselected page).
    await page.click('[data-pick="none"]');
    // The site scrolls smoothly; the drag needs the pages on screen now.
    await page.locator(card(4)).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box4 = await page.locator(`${card(4)} .rot-thumb`).boundingBox(), box6 = await page.locator(`${card(6)} .rot-thumb`).boundingBox();
    await page.mouse.move(box4.x + 20, box4.y + 20);
    await page.mouse.down();
    await page.mouse.move(box6.x + 30, box6.y + 30, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await checked(), [false, false, false, true, true, true]);
    // The quick picks: odd and even page numbers, and the shape each page is shown in.
    const facts = expected.mixed;
    const shapeOf = (p, q) => { const swap = ((p.rotate + 90 * q) % 180) === 90, w = swap ? p.height : p.width, h = swap ? p.width : p.height; return w > h ? 'landscape' : 'portrait'; };
    await page.click('[data-pick="odd"]');
    assert.deepEqual(await checked(), [true, false, true, false, true, false]);
    await page.click('[data-pick="even"]');
    assert.deepEqual(await checked(), [false, true, false, true, false, true]);
    await page.click('[data-pick="portrait"]');
    assert.deepEqual(await checked(), facts.map(p => shapeOf(p, 0) === 'portrait'));
    assert.deepEqual(await checked(), [true, false, false, false, false, true]);
    await page.click('[data-pick="landscape"]');
    assert.deepEqual(await checked(), [false, true, true, true, true, false]);
    assert.equal(await status(), '4 pages selected.');
    // Rotate all, then Portrait again follows the new shapes; Reset and Undo.
    await page.click('[data-all="1"]');
    assert.equal(await status(), 'All 6 pages turned right.');
    await page.click('[data-pick="portrait"]');
    assert.deepEqual(await checked(), facts.map(p => shapeOf(p, 1) === 'portrait'));
    await page.click('#rot-reset');
    assert.equal(await status(), 'Every page is back as it was saved. Undo brings your turns back.');
    assert.deepEqual(await turns(), ['', '', '', '', '', '']);
    await page.click('#rot-undo');
    assert.deepEqual(await turns(), Array(6).fill('rotate(90deg)'));
    await page.click('#rot-reset');
    await page.click('[data-pick="none"]');

    // Turn them upright: each marked page is turned so its text reads normally.
    await page.click('#rot-upright');
    assert.equal(await status(), 'Turned 5 pages so their text is upright.');
    assert.equal(await page.isVisible('#rot-flags'), false);
    const upright = [0, 2, 3, 1, 3, 1];   // quarter turns: page 2 by 180, 3 and 5 back from 90, 4 from 270, 6 by 90
    assert.deepEqual(await turns(), upright.map(q => q ? `rotate(${q * 90}deg)` : ''));

    // Saving: one file is saved as a PDF, whose bytes are the original plus an update.
    const orig = fs.readFileSync(fx('mixed.pdf'));
    const first = await save();
    assert.equal(first.name, 'mixed-rotated.pdf');
    assert.equal(await status(), `Saved mixed-rotated.pdf: 5 pages turned, ${(first.buf.length / 1024).toFixed(1)}\u00a0KB.`);
    checkUpdate(orig, first.buf, 'mixed.pdf');
    assert.ok(first.buf.length - orig.length < 2000, `the update is small (${first.buf.length - orig.length} bytes)`);
    const wantMixed = rotationsOf(facts, upright);
    assert.deepEqual(wantMixed, [0, 180, 0, 0, 0, 90]);
    const back = await readBack(first.file);
    assert.deepEqual(back.pages.map(p => p.rotate), wantMixed, 'PDF.js reads the new rotations');
    assert.deepEqual(back.pages.map(p => p.mark), ['ROT-MARK-01', 'ROT-MARK-02', 'ROT-MARK-03', 'ROT-MARK-04', 'ROT-MARK-05', 'ROT-MARK-06']);
    assert.deepEqual(back.outline, ['Start', 'Inherited page']);
    assert.deepEqual(back.attachments, ['note.txt']);
    assert.deepEqual(back.pages[2].notes, ['Note on page 3']);
    const v1 = checkCopy(fx('mixed.pdf'), first.file, '', wantMixed, 'mixed.pdf');
    // /Rotate is written on each changed page, page 4's too, which inherited it.
    if (v1) assert.deepEqual(v1.own, [false, true, true, true, true, true]);
    assert.match(await text('#rot-results'), /Saved as mixed-rotated\.pdf\./);
    assert.match(await text('#rot-out'), /5 pages turned · [\d.]+\u00a0KB · [\d.]+\u00a0KB added to the original/);
    // A file added with nothing turned leaves the copy offered: it still matches the pages.
    await addFiles(fx('hybrid.pdf'), 8);
    assert.equal(await text('#rot-results-note'), 'Saved as mixed-rotated.pdf.');
    assert.equal(await page.isVisible('#rot-out button'), true);
    await page.click(`${sec(2)} [data-remove]`);
    // A double click on Save saves once, and one on Download downloads once. Downloads arrive in order,
    // so after a later, single download any second one would have been counted.
    let before = downloads;
    await page.click('[data-all="2"]');
    let next = page.waitForEvent('download');
    await page.dblclick('#rot-go');
    await next;
    await page.waitForFunction(() => /^Saved /.test(document.getElementById('rot-status').textContent) && document.getElementById('rot-cancel').hidden);
    next = page.waitForEvent('download');
    await page.dblclick('#rot-out button');
    await next;
    next = page.waitForEvent('download');
    await page.click('#rot-go');
    await next;
    assert.equal(downloads - before, 3, 'a double click on Save or Download saves once');
    // After another change the old copy is no longer offered.
    await page.click(btn(1, 1));
    assert.match(await text('#rot-results-note'), /^These copies no longer match the pages above\./);
    assert.equal(await page.isVisible('#rot-out button'), false);

    // ---------- the keyboard ----------
    await page.click('#rot-reset');
    await page.click('[data-pick="none"]');
    await page.setViewportSize({ width: 700, height: 900 });
    await page.focus(`${sec(1)} [data-remove]`);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 1');
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.closest('.rot-page')).outlineStyle), 'solid', 'the page with focus has a visible ring');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 2');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    assert.deepEqual(await checked(), [false, true, true, false, false, false]);
    await page.keyboard.press('r');
    assert.equal(await status(), '2 selected pages turned right.');
    await page.keyboard.press('ArrowDown');
    const below = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    assert.ok(/^Page [4-6]$/.test(below), `ArrowDown moves to the row below (${below})`);
    await page.keyboard.press('Shift+R');
    assert.match(await status(), /^Page [4-6] turned left\.$/);
    await page.keyboard.press('Control+z');
    assert.match(await status(), /^Undone\.$/);
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 1');
    // Tab from a page reaches its own buttons; Enter presses one.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Rotate page 1 left');
    await page.keyboard.press('Enter');
    assert.equal(await status(), 'Page 1 turned left.');
    assert.deepEqual(await turns(), ['rotate(270deg)', 'rotate(90deg)', 'rotate(90deg)', '', '', '']);
    await page.focus('#rot-go');
    const kb = await (async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
      const file = path.join(tmp, 'kb-' + dl.suggestedFilename());
      await dl.saveAs(file);
      return file;
    })();
    const wantKb = rotationsOf(facts, [3, 1, 1, 0, 0, 0]);
    assert.deepEqual((await readBack(kb)).pages.map(p => p.rotate), wantKb);
    checkCopy(fx('mixed.pdf'), kb, '', wantKb, 'keyboard');
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---------- removing a file, and Undo ----------
    await page.click(`${sec(1)} [data-remove]`);
    assert.equal(await status(), 'Removed mixed.pdf. Undo brings it back.');
    // The page is empty again, with Undo next to the drop area.
    assert.equal(await page.isVisible('#rot-work'), false);
    assert.equal(await text('#rot-gone-text'), 'Removed mixed.pdf.');
    await page.click('#rot-undo-gone');
    assert.equal(await status(), 'mixed.pdf is back.');
    assert.deepEqual(await turns(), ['rotate(270deg)', 'rotate(90deg)', 'rotate(90deg)', '', '', '']);
    await clearAll();
    assert.equal(await page.isVisible('#rot-drop'), true);

    // ---------- several files: a ZIP, each saved in its own form ----------
    const structural = ['mixed-objstm.pdf', 'linearized.pdf', 'updated.pdf', 'hybrid.pdf'];
    await addFiles(structural.map(fx), 6 + 6 + 6 + 2);
    await page.click('[data-all="1"]');
    assert.equal(await text('#rot-plan'), '20 pages turned in 4 files, saved together in a ZIP file.');
    assert.equal((await text('#rot-go')).trim(), 'Save 4 rotated PDFs');
    const zip = await save();
    assert.equal(zip.name, 'rotated-pdfs.zip');
    const entries = unzip(zip.buf);
    assert.deepEqual(entries.map(e => e.name), structural.map(n => n.replace('.pdf', '-rotated.pdf')));
    for (const [k, n] of structural.entries()) {
      const out = path.join(tmp, 'zip-' + entries[k].name);
      fs.writeFileSync(out, entries[k].data);
      checkUpdate(fs.readFileSync(fx(n)), entries[k].data, n);
      const key = n.replace('.pdf', ''), want = rotationsOf(expected[key], expected[key].map(() => 1));
      assert.deepEqual((await readBack(out)).pages.map(p => p.rotate), want, n + ': PDF.js');
      const v = checkCopy(fx(n), out, '', want, n);
      if (v && n === 'hybrid.pdf') assert.ok(v.trailer_keys.includes('/XRefStm'), 'a hybrid file keeps /XRefStm in the new trailer');
    }
    assert.equal(lastSection(entries[0].data).kind, 'stream', 'a file that ends with a cross-reference stream gets one');
    assert.equal(lastSection(entries[1].data).kind, 'table', 'a file that ends with a table gets a table');
    assert.match(await text('#rot-results-note'), /^4 PDFs, saved together as rotated-pdfs\.zip\.$/);
    await clearAll();

    // The same file twice: the copies get different names, the same in the list and in the ZIP.
    await addFiles([fx('hybrid.pdf'), fx('hybrid.pdf')], 4);
    await page.click(btn(1, 1, 1));
    await page.click(btn(2, 3, 2));
    const twice = unzip((await save()).buf);
    assert.deepEqual(twice.map(e => e.name), ['hybrid-rotated.pdf', 'hybrid-rotated (2).pdf']);
    assert.deepEqual(await page.$$eval('.rot-out-name', l => l.map(e => e.textContent)), ['hybrid-rotated.pdf', 'hybrid-rotated (2).pdf']);
    assert.deepEqual((await readBack((() => { const f = path.join(tmp, 'twice.pdf'); fs.writeFileSync(f, twice[1].data); return f; })())).pages.map(p => p.rotate), [0, 270]);
    await clearAll();

    // A page object of generation 1 in a file that ends with no end of line, and a file over 64 KB
    // that ends with a cross-reference stream, so that the update's offsets take three bytes.
    const genFile = path.join(tmp, 'gen.pdf'), xstmFile = path.join(tmp, 'xstm.pdf');
    fs.writeFileSync(genFile, genPdf());
    fs.writeFileSync(xstmFile, xrefStreamPdf(80000));
    await addFiles([genFile, xstmFile], 4);
    await page.click('[data-all="1"]');
    const gx = unzip((await save()).buf);
    for (const [k, src, mark] of [[0, genFile, 'GEN'], [1, xstmFile, 'XSTM']]) {
      const out = path.join(tmp, 'gx-' + gx[k].name);
      fs.writeFileSync(out, gx[k].data);
      checkUpdate(fs.readFileSync(src), gx[k].data, gx[k].name);
      assert.deepEqual((await readBack(out)).pages.map(p => [p.rotate, p.mark]), [[90, mark + '-MARK-1'], [90, mark + '-MARK-2']], gx[k].name + ': PDF.js');
      checkCopy(src, out, '', [90, 90], gx[k].name);
    }
    assert.equal(lastSection(gx[1].data).kind, 'stream');
    await clearAll();

    // ---------- passwords ----------
    await page.setInputFiles('#rot-file', fx('enc-aes-256.pdf'));
    await page.waitForSelector('#rot-pw-1, .rot-unlock:not([hidden]) input');
    const pwId = await page.$eval('.rot-unlock:not([hidden]) input', e => e.id);
    const pwField = async () => page.evaluate(id => {
      const f = document.getElementById(id), box = document.getElementById(id + '-error');
      return { text: box.textContent, invalid: f.getAttribute('aria-invalid'), linked: (f.getAttribute('aria-describedby') || '').split(/\s+/).includes(id + '-error'), cls: box.className, focused: document.activeElement === f };
    }, pwId);
    assert.equal(await text(`label[for="${pwId}"]`), 'Password for enc-aes-256.pdf');
    assert.equal(await page.getAttribute('#' + pwId + '-error', 'aria-live'), 'polite', 'a wrong password is announced');
    assert.equal(await page.evaluate(() => document.activeElement.type), 'password');
    await page.click('[data-unlock]');
    assert.deepEqual(await pwField(), { text: 'Type the password first.', invalid: 'true', linked: true, cls: 'msg error', focused: true });
    await page.fill('#' + pwId, 'open sesam');
    assert.equal((await pwField()).invalid, null, 'typing clears the message');
    await page.press('#' + pwId, 'Enter');
    await page.waitForFunction(id => document.getElementById(id + '-error').textContent, pwId);
    assert.deepEqual(await pwField(), { text: 'That password does not open enc-aes-256.pdf. Check it and try again.', invalid: 'true', linked: true, cls: 'msg error', focused: true });
    // A megabyte pasted into the field stops at its limit at once.
    await page.$eval('#' + pwId, el => { el.value = 'x'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.$eval('#' + pwId, el => el.value.length), 1024);
    await page.fill('#' + pwId, 'open sesame');
    // A double click on Open opens the file once.
    await page.dblclick('[data-unlock]');
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 6, null, { timeout: 30000 });
    await ready();
    assert.equal(await page.$$eval('.rot-num', l => l.map(e => e.textContent).join()), '1,2,3,4,5,6', 'each page is shown once');
    await page.waitForFunction(() => /Encrypted/.test(document.querySelector('.rot-notes').textContent));
    assert.equal(await text('.rot-notes'), 'Encrypted (AES 256-bit). The rotated copy keeps the same encryption and passwords.');
    await page.click(btn(3, 3));
    await page.click(btn(6, 1));
    const enc = await save();
    checkUpdate(fs.readFileSync(fx('enc-aes-256.pdf')), enc.buf, 'enc-aes-256.pdf');
    const encFacts = expected.mixed, encWant = rotationsOf(encFacts, [0, 0, 3, 0, 0, 1]);
    const encBack = await readBack(enc.file, 'open sesame');
    assert.equal(encBack.encrypted, true, 'the copy is still encrypted');
    assert.deepEqual(encBack.pages.map(p => p.rotate), encWant);
    // The note kept in page 3's own dictionary was encrypted again with that object's key.
    assert.deepEqual(encBack.pages[2].notes, ['Note on page 3']);
    checkCopy(fx('enc-aes-256.pdf'), enc.file, 'open sesame', encWant, 'enc-aes-256.pdf');
    await clearAll();

    // Each kind of encryption, and passwords with characters outside ASCII: PDF.js takes RC4 and
    // AES-128 passwords as bytes, so "café€" is given to it in PDFDocEncoding.
    const encs = [['enc-rc4-40.pdf', 'open sesame'], ['enc-rc4-128.pdf', 'open sesame'], ['enc-aes-128.pdf', 'open sesame'],
      ['enc-aes-256-objstm.pdf', 'open sesame'], ['pdfdoc-password.pdf', 'café€', 'caf\xe9\xa0'], ['utf8-password.pdf', 'パスワード１２３']];
    await page.setInputFiles('#rot-file', encs.map(e => fx(e[0])));
    for (let k = 0; k < encs.length; k++) {
      await page.waitForFunction(() => document.querySelectorAll('.rot-unlock:not([hidden]) input').length >= 1);
      const id = await page.$eval('.rot-unlock:not([hidden]) input', e => e.id);
      const name = await page.$eval(`label[for="${id}"]`, e => e.textContent.replace('Password for ', ''));
      const pw = encs.find(e => e[0] === name)[1];
      await page.fill('#' + id, pw);
      await page.press('#' + id, 'Enter');
      await page.waitForFunction(id => document.getElementById(id).closest('.rot-unlock').hidden, id, { timeout: 30000 });
    }
    await page.waitForFunction(n => document.querySelectorAll('.rot-page').length === n, 3 + 3 + 3 + 6 + 3 + 3);
    await ready();
    const names = await page.$$eval('.rot-fname', l => l.map(e => e.textContent));
    for (let k = 0; k < names.length; k++) await page.click(btn(2, 1, k + 1));
    const encZip = unzip((await save()).buf);
    assert.deepEqual(encZip.map(e => e.name).sort(), encs.map(e => e[0].replace('.pdf', '-rotated.pdf')).sort());
    for (const e of encs) {
      const z = encZip.find(x => x.name === e[0].replace('.pdf', '-rotated.pdf')), out = path.join(tmp, 'enc-' + z.name);
      fs.writeFileSync(out, z.data);
      checkUpdate(fs.readFileSync(fx(e[0])), z.data, e[0]);
      const rb = await readBack(out, e[2] || e[1]);
      assert.equal(rb.encrypted, true, e[0] + ' stays encrypted');
      assert.deepEqual(rb.pages.map(p => p.rotate).slice(0, 3), [0, 90, e[0].includes('256-objstm') ? 90 : 0], e[0]);
      if (/^enc-(rc4|aes-128)/.test(e[0])) assert.deepEqual(rb.pages[1].notes, ['Secret note 2'], e[0] + ': the note on page 2 still reads');
      checkCopy(fx(e[0]), out, e[1], rb.pages.map(p => p.rotate), e[0]);
    }
    await clearAll();

    // ---------- permissions: page assembly forbidden needs the permissions password ----------
    await addFiles(['no-assembly.pdf', 'assembly-only.pdf', 'restricted.pdf'].map(fx), 9);
    await page.waitForSelector(`${sec(1)} .rot-unlock:not([hidden])`);
    assert.equal(await page.isVisible(`${sec(2)} .rot-unlock`), false, 'assembly allowed (bit 11) even though changes are forbidden: no prompt');
    assert.equal(await page.isVisible(`${sec(3)} .rot-unlock`), false);
    assert.match(await text(`${sec(1)} .rot-unlock-why`), /^The permissions of no-assembly\.pdf do not allow its pages to be rotated\./);
    assert.equal(await text(`${sec(3)} .rot-notes`), 'Encrypted (AES 128-bit). The rotated copy keeps the same encryption and passwords, and still blocks printing and copying.');
    for (let f = 1; f <= 3; f++) await page.click(btn(1, 1, f));
    assert.equal(await text('#rot-plan'), '2 pages turned in 2 files, saved together in a ZIP file. no-assembly.pdf needs its permissions password first.');
    const ownerId = await page.$eval(`${sec(1)} .rot-unlock input`, e => e.id);
    await page.fill('#' + ownerId, 'open sesame');
    await page.press('#' + ownerId, 'Enter');
    await page.waitForFunction(id => document.getElementById(id + '-error').textContent, ownerId);
    assert.equal(await text('#' + ownerId + '-error'), 'That is not the permissions password of no-assembly.pdf. Check it and try again.');
    assert.equal(await page.getAttribute('#' + ownerId, 'aria-invalid'), 'true');
    await page.fill('#' + ownerId, 'owner secret');
    await page.press('#' + ownerId, 'Enter');
    await page.waitForFunction(() => /is unlocked/.test(document.getElementById('rot-status').textContent));
    assert.equal(await status(), 'no-assembly.pdf is unlocked: its pages can be rotated now.');
    assert.equal(await text('#rot-plan'), '3 pages turned in 3 files, saved together in a ZIP file.');
    const permZip = unzip((await save()).buf);
    for (const n of ['no-assembly.pdf', 'assembly-only.pdf', 'restricted.pdf']) {
      const z = permZip.find(x => x.name === n.replace('.pdf', '-rotated.pdf')), out = path.join(tmp, 'perm-' + z.name);
      fs.writeFileSync(out, z.data);
      checkUpdate(fs.readFileSync(fx(n)), z.data, n);
      assert.deepEqual((await readBack(out)).pages.map(p => p.rotate), [90, 0, 0], n);
      const v = checkCopy(fx(n), out, n === 'no-assembly.pdf' ? 'owner secret' : '', [90, 0, 0], n);
      if (v) assert.equal(v.encryption.allow.modify_assembly, n !== 'no-assembly.pdf', n + ': the permissions are kept as they were');
    }
    await clearAll();
    // RC4 40-bit (R2) has no assembly bit: with changes forbidden, it needs the permissions password too.
    await addFiles(fx('no-modify-r2.pdf'), 3);
    await page.waitForSelector('.rot-unlock:not([hidden])');
    await page.click(btn(1, 1));
    await page.click('#rot-go');
    assert.equal(await status(), 'no-modify-r2.pdf needs its permissions password before it can be saved.');
    assert.equal(await page.evaluate(() => document.activeElement.type), 'password');
    await clearAll();

    // ---------- signatures ----------
    await addFiles(['signed.pdf', 'certified.pdf'].map(fx), 6);
    await page.waitForFunction(() => document.querySelectorAll('.rot-notes li').length === 2);
    assert.match(await text(`${sec(1)} .rot-notes`), /^Digitally signed\. The signed version stays inside the file/);
    assert.match(await text(`${sec(2)} .rot-notes`), /^Certified by its author: a certified PDF allows no page changes, so rotating any page breaks its certification\./);
    await page.click(btn(2, 1, 1));
    await page.click(btn(1, 2, 2));
    const sigZip = unzip((await save()).buf);
    for (const [n, want] of [['signed.pdf', [0, 90, 0]], ['certified.pdf', [180, 0, 0]]]) {
      const z = sigZip.find(x => x.name === n.replace('.pdf', '-rotated.pdf')), out = path.join(tmp, 'sig-' + z.name);
      fs.writeFileSync(out, z.data);
      checkUpdate(fs.readFileSync(fx(n)), z.data, n);
      assert.deepEqual((await readBack(out)).pages.map(p => p.rotate), want, n);
      const v = checkCopy(fx(n), out, '', want, n);
      if (v) assert.deepEqual(v.sig, [true], n + ': the signed bytes are unchanged');
    }
    await clearAll();
    // Adobe's usage rights (Reader extensions, as on many tax forms) are a signature of Adobe's, not
    // of a person: named as such, and a person's signature next to them is still named.
    const rightsFile = path.join(tmp, 'rights.pdf'), bothFile = path.join(tmp, 'rights-signed.pdf');
    fs.writeFileSync(rightsFile, rightsPdf(false));
    fs.writeFileSync(bothFile, rightsPdf(true));
    await addFiles([rightsFile, bothFile], 4);
    await page.waitForFunction(() => document.querySelectorAll('.rot-notes li').length === 3);
    const RIGHTS = 'Reader-extended: an Adobe usage-rights signature, not a person’s, turns on extended features in Adobe Acrobat Reader. Rotating pages ends them, and Acrobat Reader then says the document has changed since it was created.';
    assert.deepEqual(await page.$$eval(`${sec(1)} .rot-notes li`, l => l.map(e => e.textContent)), [RIGHTS]);
    assert.deepEqual(await page.$$eval(`${sec(2)} .rot-notes li`, l => l.map(e => e.textContent.split('.')[0])), ['Digitally signed', 'Reader-extended: an Adobe usage-rights signature, not a person’s, turns on extended features in Adobe Acrobat Reader']);
    await page.click(btn(1, 1, 1));
    checkUpdate(fs.readFileSync(rightsFile), (await save()).buf, 'rights.pdf');
    await clearAll();

    // ---------- damaged files are written out in full, which repairs them ----------
    await addFiles(['cut.pdf', 'garbage.pdf', 'badxref.pdf'].map(fx), 18);
    await page.waitForFunction(() => document.querySelectorAll('.rot-notes li').length === 3);
    assert.equal(await text(`${sec(1)} .rot-notes`), 'Its index of objects is damaged, so the rotated copy is written out in full, which also repairs it.');
    await page.click('[data-all="1"]');
    const dmgZip = unzip((await save()).buf);
    for (const n of ['cut.pdf', 'garbage.pdf', 'badxref.pdf']) {
      const z = dmgZip.find(x => x.name === n.replace('.pdf', '-rotated.pdf')), out = path.join(tmp, 'dmg-' + z.name);
      fs.writeFileSync(out, z.data);
      const want = rotationsOf(facts, [1, 1, 1, 1, 1, 1]);
      assert.deepEqual((await readBack(out)).pages.map(p => p.rotate), want, n);
      // Compared with mixed.pdf, the file each one was damaged from.
      checkCopy(fx('mixed.pdf'), out, '', want, n, { rewrite: true });
    }
    assert.match(await text('#rot-out'), /written out in full, which repaired it/);
    await clearAll();
    await page.setInputFiles('#rot-file', fx('enc-badxref.pdf'));
    await page.waitForSelector('.rot-unlock:not([hidden]) input');
    await page.fill('.rot-unlock:not([hidden]) input', 'open sesame');
    await page.press('.rot-unlock:not([hidden]) input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 3);
    await ready();
    await page.waitForFunction(() => /damaged/.test(document.querySelector('.rot-notes').textContent));
    await page.click(btn(2, 1));
    const encDmg = await save();
    const encDmgBack = await readBack(encDmg.file, 'open sesame');
    assert.equal(encDmgBack.encrypted, true, 'a damaged encrypted file stays encrypted');
    assert.deepEqual(encDmgBack.pages.map(p => p.rotate), [0, 90, 0]);
    assert.deepEqual(encDmgBack.pages[1].notes, ['Secret note 2']);
    checkCopy(fx('enc-aes-128.pdf'), encDmg.file, 'open sesame', [0, 90, 0], 'enc-badxref.pdf', { rewrite: true });
    await clearAll();

    // ---------- 1,000 pages: thumbnails drawn as they come into view, quick work ----------
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
    const cpuMs = async action => { const t0 = await threadMs(); await action(); return (await threadMs()) - t0; };
    const styleMs = async action => {
      const ms = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'RecalcStyleDuration').value * 1000;
      const t0 = await ms();
      await action();
      return (await ms()) - t0;
    };
    const many = path.join(tmp, 'thousand.pdf');
    fs.writeFileSync(many, manyPages(1000));
    await page.setInputFiles('#rot-file', many);
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 1000, null, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('.rot-thumb img[src]').length >= 6, null, { timeout: 60000 });
    const drawn = await page.$$eval('.rot-thumb img[src]', l => l.length);
    assert.ok(drawn < 150, `only the thumbnails near the screen are drawn (${drawn})`);
    // Removing a file while its pages are being read stops the reading; Undo goes on from there.
    await page.click(`${sec(1)} [data-remove]`);
    await page.click('#rot-undo-gone');
    await ready();
    // A click on a page selects it without restyling the whole list (the drag cursor waits for a drag).
    const clickStyle = await styleMs(() => page.click('.rot-page:nth-child(2) .rot-thumb'));
    assert.ok(clickStyle < 40, `selecting one page of 1,000 took ${clickStyle.toFixed(0)} ms of style work`);
    assert.equal(await page.$eval('.rot-page:nth-child(2) .rot-check', e => e.checked), true);
    const allCpu = await cpuMs(async () => {
      await page.click('[data-all="1"]');
      await page.waitForFunction(() => document.getElementById('rot-status').textContent === 'All 1,000 pages turned right.');
    });
    assert.ok(allCpu < 1500, `turning 1,000 pages took ${allCpu.toFixed(0)} ms of main-thread CPU time`);
    let thousand;
    const saveCpu = await cpuMs(async () => { thousand = await save(); });
    assert.ok(saveCpu < 1500, `saving 1,000 turned pages took ${saveCpu.toFixed(0)} ms of main-thread CPU time`);
    checkUpdate(fs.readFileSync(many), thousand.buf, 'thousand.pdf');
    const tb = await readBack(thousand.file);
    assert.equal(tb.pages.length, 1000);
    assert.ok(tb.pages.every((p, i) => p.rotate === 90 && p.mark === 'BIG-MARK-' + String(i + 1).padStart(4, '0')), 'every page turned, in order');
    checkCopy(many, thousand.file, '', Array(1000).fill(90), 'thousand.pdf');
    // The last thumbnail is drawn once it is scrolled to.
    await page.locator('.rot-page:last-child').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.rot-page:last-child img[src]'), null, { timeout: 60000 });
    await clearAll();

    // ---------- 100 MB: a warning, Cancel, and an update of a few hundred bytes ----------
    const huge = path.join(tmp, 'huge.pdf');
    fs.writeFileSync(huge, bigPdf(100 * 1024 * 1024));
    await addFiles(huge, 3);
    assert.equal(await text('.rot-notes'), 'A file this large is handled in your device’s memory, which can fail on a phone.');
    await page.click(btn(1, 1));
    before = downloads;
    // Cancel at once, and Cancel while the worker reads the file: neither saves anything.
    await page.evaluate(() => { document.getElementById('rot-go').click(); document.getElementById('rot-cancel').click(); });
    assert.equal(await status(), 'Cancelled. Nothing was saved.');
    await page.click('#rot-go');
    await page.evaluate(() => document.getElementById('rot-cancel').click());
    assert.equal(await status(), 'Cancelled. Nothing was saved.');
    assert.equal(await page.isVisible('#rot-cancel'), false);
    const hugeOut = await save('#rot-go', 180000);
    assert.equal(downloads - before, 1, 'the cancelled save saved nothing');
    const hugeIn = fs.readFileSync(huge);
    checkUpdate(hugeIn, hugeOut.buf, 'huge.pdf');
    assert.ok(hugeOut.buf.length - hugeIn.length < 1000, `${hugeOut.buf.length - hugeIn.length} bytes added`);
    checkCopy(huge, hugeOut.file, '', [90, 0, 0], 'huge.pdf');
    await clearAll();
    fs.rmSync(huge);

    // ---------- the sample, and a file named like an object's own keys ----------
    // A double click adds it once.
    await page.dblclick('#rot-sample');
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 4);
    await ready();
    assert.equal(await page.$$eval('.rot-file', l => l.length), 1);
    assert.equal(await text('#rot-flags-text'), 'Text runs sideways or upside down on 2 pages: pages 2–3.');
    await page.click('#rot-upright');
    const sample = await save();
    assert.equal(sample.name, 'sample-rotated.pdf');
    assert.deepEqual((await readBack(sample.file)).pages.map(p => p.rotate), [0, 90, 180, 0]);
    const proto = path.join(tmp, '__proto__.pdf');
    fs.copyFileSync(fx('mixed.pdf'), proto);
    await addFiles(proto, 10);
    assert.equal(await page.$$eval('.rot-fname', l => l.map(e => e.textContent).join()), 'sample.pdf,__proto__.pdf');
    assert.equal(await text('#rot-flags-text'), 'Text runs sideways or upside down on 5 pages: __proto__.pdf, pages 2–6.');
    // After Back and Forward, the browser may restore old checkbox states: they are drawn again.
    await page.$$eval('.rot-check', l => l.forEach(c => { c.checked = true; }));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.ok((await checked()).every(c => !c), 'pageshow draws the selection from the page\'s state');
    await clearAll();

    // ---------- a check of a file that is still running when Save is pressed ----------
    // The writer is held back until released, so the check of a newly added file waits for the worker.
    // Each part opens the page again, for a worker that has not started yet.
    let gate = null, release = null;
    const hold = async route => { await gate; try { await route.continue(); } catch (e) { /* the worker was stopped meanwhile */ } };
    await page.addInitScript(() => {
      window.__posted = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m) { if (m && /^(init|inspect|save)$/.test(m.type)) window.__posted.push(m.type); return post.apply(this, arguments); };
    });
    await page.route(WRITER, hold);
    // Cancel stops only the save: the check goes on and asks for the permissions password, and the save
    // that was waiting for it is never sent to the writer.
    gate = new Promise(r => { release = r; });
    await open();
    await page.setInputFiles('#rot-file', fx('no-assembly.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 3);
    await page.click(btn(1, 1));
    await page.click('#rot-go');
    await page.click('#rot-cancel');
    assert.equal(await status(), 'Cancelled. Nothing was saved.');
    release();
    await page.waitForSelector('.rot-unlock:not([hidden])', { timeout: 20000 });
    assert.match(await text('.rot-notes'), /^Encrypted \(AES 256-bit\)\./);
    const ownerIn = await page.$eval('.rot-unlock input', e => e.id);
    await page.fill('#' + ownerIn, 'not it');
    await page.press('#' + ownerIn, 'Enter');
    await page.waitForFunction(id => document.getElementById(id + '-error').textContent, ownerIn);
    assert.deepEqual(await page.evaluate(() => window.__posted), ['init', 'inspect', 'inspect'], 'the cancelled save never reached the writer');
    // Saved before its check has ended, a file whose permissions forbid assembling is refused by the
    // writer itself: nothing is saved, and the permissions password is asked for.
    gate = new Promise(r => { release = r; });
    await open();
    await page.setInputFiles('#rot-file', fx('no-assembly.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 3);
    await page.click(btn(1, 1));
    const held = downloads;
    await page.click('#rot-go');
    release();
    await page.waitForFunction(() => document.getElementById('rot-cancel').hidden && document.getElementById('rot-error').textContent, null, { timeout: 30000 });
    assert.equal(await text('#rot-error'), 'no-assembly.pdf: its permissions do not allow its pages to be rotated; type its permissions password above its pages.');
    assert.equal(await status(), 'Nothing was saved.');
    assert.equal(downloads, held);
    assert.equal(await page.isVisible('.rot-unlock'), true);
    await page.unroute(WRITER, hold);

    // ---------- keyboard focus stays on the tool ----------
    // A button that its own action hides or turns off hands focus on: Turn them upright to Save,
    // Reset to Undo, and the last Undo to the page that is the list's tab stop.
    await open();
    await page.click('#rot-sample');
    await page.waitForFunction(() => document.querySelectorAll('.rot-page').length === 4);
    await ready();
    const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.getAttribute('aria-label'));
    await page.focus('#rot-upright');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'rot-go');
    await page.focus('#rot-reset');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'rot-undo');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'rot-undo');
    await page.keyboard.press('Enter');
    assert.equal(await page.isDisabled('#rot-undo'), true);
    assert.equal(await focused(), 'Page 1');
    await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 't-read'; i.hidden = true; document.body.appendChild(i); });

    // ---------- a phone with a touch screen ----------
    const { devices } = require('playwright');
    const phoneCtx = await page.context().browser().newContext({ ...devices['Pixel 7'], acceptDownloads: true });
    const phone = await phoneCtx.newPage();
    const outside = [];
    await phone.route('**/*', r => { const u = r.request().url(); if (u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue(); outside.push(u); return r.abort(); });
    const phoneErrors = [];
    phone.on('pageerror', e => phoneErrors.push(e.message));
    await phone.goto(base + '/rotate-pdf/');
    await phone.setInputFiles('#rot-file', fx('mixed.pdf'));
    await phone.waitForFunction(() => document.querySelectorAll('.rot-page').length === 6 && !document.querySelector('.rot-pages[data-reading]'), null, { timeout: 60000 });
    const small = await phone.$$eval('.rot-tb, .rot-bar .btn, #rot-go', l => l.filter(b => b.getBoundingClientRect().height < 44).length);
    assert.equal(small, 0, 'every button is at least 44 px tall on a touch screen');
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    await phone.tap('.rot-page:nth-child(2) .rot-thumb');
    assert.deepEqual(await phone.$$eval('.rot-check', l => l.map(e => e.checked)), [false, true, false, false, false, false]);
    // Touch and hold, then drag, selects a run; a vertical swipe scrolls and selects nothing.
    const tcdp = await phoneCtx.newCDPSession(phone);
    const center = async sel => { const b = await phone.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    await phone.locator('.rot-page:nth-child(3)').scrollIntoViewIfNeeded();
    const c3 = await center('.rot-page:nth-child(3) .rot-thumb');
    await tcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [c3] });
    await phone.waitForFunction(() => document.getElementById('rot').classList.contains('is-sweeping'));
    const c4 = await center('.rot-page:nth-child(4) .rot-thumb');
    for (let s = 1; s <= 6; s++) await tcdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c3.x + (c4.x - c3.x) * s / 6, y: c3.y + (c4.y - c3.y) * s / 6 }] });
    await tcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.deepEqual(await phone.$$eval('.rot-check', l => l.map(e => e.checked)), [false, true, true, true, false, false]);
    const y0 = await phone.evaluate(() => scrollY), c5 = await center('.rot-page:nth-child(5) .rot-thumb');
    await tcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [c5] });
    for (let s = 1; s <= 8; s++) await tcdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c5.x, y: c5.y - 30 * s }] });
    await tcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await phone.waitForFunction(y => scrollY !== y, y0);
    assert.deepEqual(await phone.$$eval('.rot-check', l => l.map(e => e.checked)), [false, true, true, true, false, false], 'a swipe selects nothing');
    // A tap while the page still glides after the swipe only stops it, as on a real phone: the next
    // tap waits until the page has been still for ten frames.
    await phone.evaluate(() => new Promise(done => {
      let y = scrollY, still = 0;
      const frame = () => { if (scrollY === y) still++; else { still = 0; y = scrollY; } if (still >= 10) done(); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }));
    await phone.tap('.rot-page:nth-child(6) .rot-tb[data-q="1"]');
    await phone.tap('[data-sel="2"]');
    const [pdl] = await Promise.all([phone.waitForEvent('download'), phone.tap('#rot-go')]);
    const pfile = path.join(tmp, 'phone-' + pdl.suggestedFilename());
    await pdl.saveAs(pfile);
    const pwant = rotationsOf(facts, [0, 2, 2, 2, 0, 1]);
    assert.deepEqual((await readBack(pfile)).pages.map(p => p.rotate), pwant);
    checkCopy(fx('mixed.pdf'), pfile, '', pwant, 'phone');
    // The password field uses 16 px text on a touch screen, so iOS does not zoom into it.
    await phone.setInputFiles('#rot-file', fx('enc-aes-128.pdf'));
    await phone.waitForSelector('.rot-unlock:not([hidden]) input');
    assert.ok(await phone.$eval('.rot-unlock:not([hidden]) input', e => parseFloat(getComputedStyle(e).fontSize) >= 16));
    // On a touch screen no page button is under 44 by 44 px: from 389 px down 180° takes a row of its
    // own, and on wider screens, a tablet or a phone on its side, the pages are laid out wide enough.
    for (const width of [320, 640, 800, 960]) {
      await phone.setViewportSize({ width, height: 640 });
      assert.deepEqual(await phone.$$eval('.rot-tb', l => l.filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.width < 44 || r.height < 44).map(r => Math.round(r.width) + 'x' + Math.round(r.height))), [], `every page button is at least 44 by 44 px at ${width} px`);
    }
    assert.deepEqual(outside, [], 'no request to another host on the phone');
    assert.deepEqual(phoneErrors, []);
    await phoneCtx.close();


    // ---------- pdf-lib reads without pausing: it runs in a worker ----------
    // A file that is not encrypted is read once, by this page itself. The shared unlocker read an
    // encrypted file 400 objects at a time, with a pause of at least 4 ms after each 400: once to find
    // its key, once more to decrypt it, when the file is added and again when it is saved.
    {
      const fresh = await page.context().browser().newContext({ acceptDownloads: true });
      const p3 = await fresh.newPage();
      const p3errors = [], parses = [];
      p3.on('pageerror', e => p3errors.push(e.message));
      p3.on('console', m => {
        if (m.text().startsWith('pdf-lib parse: ')) parses.push(m.text().slice(15));
        else if (m.type() === 'error') p3errors.push(m.text());
      });
      await p3.route('**/assets/vendor/pdf-lib/pdf-lib.min.js', async route => {
        const r = await route.fetch();
        await route.fulfill({ response: r, body: (await r.text()) + PARSE_SPY });
      });
      const parsed = async n => {
        for (let i = 0; i < 100 && parses.length < n; i++) await p3.waitForTimeout(20);
        return parses.splice(0);
      };
      await p3.goto(url);
      await p3.setInputFiles('#rot-file', fx('restricted.pdf'));
      await p3.waitForFunction(() => document.querySelectorAll('.rot-page').length === 3 && !document.querySelector('.rot-pages[data-reading]') &&
        !document.querySelector('.rot-wait-file:not([hidden])'), null, { timeout: 60000 });
      assert.deepEqual(await parsed(2), ['Infinity', 'Infinity'], 'restricted.pdf, encrypted, is read twice when it is added');
      await p3.click('.rot-page:nth-child(1) .rot-tb[data-q="1"]');
      const [dlTurned] = await Promise.all([p3.waitForEvent('download', { timeout: 60000 }), p3.click('#rot-go')]);
      assert.equal(dlTurned.suggestedFilename(), 'restricted-rotated.pdf');
      assert.deepEqual(await parsed(2), ['Infinity', 'Infinity'], 'and twice when it is saved');
      await p3.click('#rot-clear');
      await p3.waitForFunction(() => !document.querySelector('.rot-file'));
      await p3.setInputFiles('#rot-file', fx('mixed.pdf'));
      await p3.waitForFunction(() => document.querySelectorAll('.rot-page').length === 6 && !document.querySelector('.rot-pages[data-reading]'), null, { timeout: 60000 });
      await p3.click('.rot-page:nth-child(1) .rot-tb[data-q="1"]');
      await Promise.all([p3.waitForEvent('download', { timeout: 60000 }), p3.click('#rot-go')]);
      assert.deepEqual(await parsed(1), ['Infinity'], 'mixed.pdf, not encrypted, is read once, when it is saved');
      assert.deepEqual(p3errors, []);
      await fresh.close();
    }

    await page.evaluate(() => document.getElementById('t-read').remove());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
