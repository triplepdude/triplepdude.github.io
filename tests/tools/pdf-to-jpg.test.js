const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Fixtures and expected.json come from tests/fixtures/pdf-to-jpg/make_fixtures.py (reportlab, pikepdf,
// poppler): pages.pdf has an A4 page with a red and a blue box, a Letter page turned by /Rotate 90
// with a green box that shows at the top left, and a 300.4 x 150.3 pt orange page with a black bar.
// expected.json gives each page's pixel size at 72, 150 and 300 DPI (round(points x DPI / 72)), the
// colours at known points, each page drawn by poppler (an independent renderer) as a 12 x 12 grid of
// average colours, and the IJG quantisation tables for JPEG qualities 50 and 95. Image headers are
// read here byte by byte (JFIF density, PNG pHYs with its CRC checked by zlib), not by the page.

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
// JPEG: size from the SOF marker, density from JFIF APP0, the first 8 values of the first DQT table.
function jpegInfo(b) {
  const info = { soi: b[0] === 0xFF && b[1] === 0xD8 };
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xFF) {
    const m = b[p + 1], len = b.readUInt16BE(p + 2);
    if (m === 0xE0 && b.toString('latin1', p + 4, p + 9) === 'JFIF\0') Object.assign(info, { units: b[p + 11], xd: b.readUInt16BE(p + 12), yd: b.readUInt16BE(p + 14) });
    if (m === 0xDB && !info.dqt) info.dqt = Array.from(b.subarray(p + 5, p + 13));
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) { info.h = b.readUInt16BE(p + 5); info.w = b.readUInt16BE(p + 7); break; }
    p += 2 + len;
  }
  return info;
}
function pngInfo(b) {
  const info = { sig: b.toString('latin1', 1, 4) === 'PNG', w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
  let p = 8;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8);
    if (type === 'pHYs') Object.assign(info, { physAt: p, ppx: b.readUInt32BE(p + 8), ppy: b.readUInt32BE(p + 12), unit: b[p + 16], crcOk: zlib.crc32(b.subarray(p + 4, p + 17)) === b.readUInt32BE(p + 17) });
    if (type === 'IDAT' && info.idatAt === undefined) info.idatAt = p;
    p += 12 + len;
  }
  return info;
}

// A PDF written by hand from its objects (numbered from 1), for files no app would write.
function rawPdf(objs, trailer = '') {
  let body = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(body.length); body += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = body.length;
  body += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(body + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R' + trailer + ' >>\nstartxref\n' + xref + '\n%%EOF\n', 'latin1');
}
const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>', A_PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>';

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const fx = n => path.join(fixtures, n);
  const exp = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  await open();
  assert.equal(await page.isVisible('#p2j-drop'), true);
  assert.equal(await page.isVisible('#p2j-work'), false);

  const text = sel => page.textContent(sel);
  const plan = () => text('#p2j-plan');
  const infos = () => page.$$eval('.p2j-info', l => l.map(e => e.textContent));
  const save = async (sel = '#p2j-go') => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  const setFormat = f => page.click(`.p2j-seg label:has(input[value="${f}"])`);
  const fieldError = id => page.evaluate(id => {
    const f = document.getElementById(id), box = document.getElementById(id + '-error');
    return { text: box.textContent, invalid: f.getAttribute('aria-invalid'), linked: (f.getAttribute('aria-describedby') || '').split(/\s+/).includes(id + '-error') };
  }, id);
  // Decodes an image in the browser: colours at points given as fractions of its size, and a 12 x 12
  // grid of average colours with transparency laid over white, as poppler draws.
  const look = (buf, mime, points = [], opts = {}) => page.evaluate(async ([b64, mime, points, opts]) => {
    const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: mime });
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', ...opts });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    const samples = points.map(p => at(Math.min(c.width - 1, Math.floor(p.x * c.width)), Math.min(c.height - 1, Math.floor(p.y * c.height))));
    const n = 12, grid = [];
    for (let gy = 0; gy < n; gy++) {
      const row = [];
      for (let gx = 0; gx < n; gx++) {
        const s = [0, 0, 0];
        let k = 0;
        for (let y = Math.floor(gy * c.height / n); y < Math.floor((gy + 1) * c.height / n); y++) {
          for (let x = Math.floor(gx * c.width / n); x < Math.floor((gx + 1) * c.width / n); x++) {
            const i = (y * c.width + x) * 4, a = d[i + 3] / 255;
            for (let ch = 0; ch < 3; ch++) s[ch] += d[i + ch] * a + 255 * (1 - a);
            k++;
          }
        }
        row.push(s.map(v => v / k));
      }
      grid.push(row);
    }
    return { w: c.width, h: c.height, samples, grid };
  }, [buf.toString('base64'), mime, points, opts]);
  const near = (got, want, tol, msg) => assert.ok(want.every((v, i) => Math.abs(got[i] - v) <= tol), `${msg}: ${JSON.stringify(got)} is not ${JSON.stringify(want)}`);
  const gridDiff = (a, b) => {
    let sum = 0, max = 0, n = 0;
    for (let y = 0; y < a.length; y++) for (let x = 0; x < a[y].length; x++) for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(a[y][x][ch] - b[y][x][ch]);
      sum += d; n++; if (d > max) max = d;
    }
    return { mean: sum / n, max };
  };
  // The summary is a live region: it is written only when its text changes.
  await page.evaluate(() => {
    window.__planWrites = [];
    const el = document.getElementById('p2j-plan');
    new MutationObserver(() => window.__planWrites.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });

  // ---- Files that cannot be converted, and a password ----
  await page.setInputFiles('#p2j-file', { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
  await page.waitForFunction(() => document.getElementById('p2j-error').textContent === 'empty.pdf is empty.');
  // A file over 1 GB is refused before it is read (its size is faked, as a real one is too big for a test).
  await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(Blob.prototype, 'size');
    Object.defineProperty(Blob.prototype, 'size', { configurable: true, get() { return this.name === 'huge.pdf' ? 1073741825 : d.get.call(this); } });
    window.__restoreSize = () => Object.defineProperty(Blob.prototype, 'size', d);
  });
  await page.setInputFiles('#p2j-file', { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
  await page.waitForFunction(() => document.getElementById('p2j-error').textContent === 'huge.pdf is larger than 1 GB.');
  await page.evaluate(() => window.__restoreSize());
  await page.setInputFiles('#p2j-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a pdf') });
  await page.waitForFunction(() => /notes\.txt is not a PDF file/.test(document.getElementById('p2j-error').textContent));
  await page.setInputFiles('#p2j-file', fx('damaged.pdf'));
  await page.waitForFunction(() => /damaged\.pdf is damaged or is not a valid PDF/.test(document.getElementById('p2j-error').textContent));
  // PDFs that PDF.js opens but this tool cannot use are explained in plain words; PDF.js's own messages
  // ("Invalid page request.", "unknown encryption method") are never shown. A page tree with no pages
  // (some broken exporters write one; PDF.js takes a /Count of -1 as it is), a first page that is a
  // number instead of a page, and an encryption the reader does not know.
  const REPAIR = 'It may be damaged; try saving it again from the app that made it.';
  for (const [name, buf, want] of [
    ['no-pages.pdf', rawPdf([CATALOG, '<< /Type /Pages /Kids [] /Count 0 >>']), 'no-pages.pdf has no pages, so there is nothing to convert. ' + REPAIR],
    ['minus-one.pdf', rawPdf([CATALOG, '<< /Type /Pages /Kids [3 0 R] /Count -1 >>', A_PAGE]), 'minus-one.pdf has no pages, so there is nothing to convert. ' + REPAIR],
    ['bad-first.pdf', rawPdf([CATALOG, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '42', A_PAGE]), 'bad-first.pdf could not be opened. ' + REPAIR],
    ['odd-lock.pdf', rawPdf([CATALOG, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', A_PAGE, '<< /Filter /OddLock /V 1 >>'], ' /Encrypt 4 0 R /ID [<00> <00>]'), 'odd-lock.pdf uses a kind of encryption this tool cannot open.']
  ]) {
    await page.setInputFiles('#p2j-file', { name, mimeType: 'application/pdf', buffer: buf });
    await page.waitForFunction(n => document.getElementById('p2j-error').textContent.startsWith(n + ' '), name);
    assert.equal(await text('#p2j-error'), want);
    assert.equal(await text('#p2j-status'), '', name + ': "Opening" is not left on screen');
    assert.equal(await page.isVisible('#p2j-work'), false, name + ': no form for a PDF that cannot be converted');
  }
  await page.setInputFiles('#p2j-file', fx('locked.pdf'));
  await page.waitForSelector('#p2j-unlock:not([hidden])');
  assert.equal(await text('#p2j-error'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2j-pw');
  await page.click('#p2j-pw-go');
  assert.deepEqual(await fieldError('p2j-pw'), { text: 'Type the password first.', invalid: 'true', linked: true });
  await page.fill('#p2j-pw', 'sesame');
  await page.press('#p2j-pw', 'Enter');
  await page.waitForFunction(() => /not right/.test(document.getElementById('p2j-pw-error').textContent));
  assert.deepEqual(await fieldError('p2j-pw'), { text: 'That password is not right. Check it and try again.', invalid: 'true', linked: true });
  // A megabyte pasted into the password field stops at 1,024 characters: a PDF uses at most 127 bytes of
  // a password, and a field holding a megabyte makes the browser slow to draw it.
  await page.focus('#p2j-pw');
  await page.keyboard.insertText('x'.repeat(1048576));
  assert.equal(await page.$eval('#p2j-pw', el => el.value.length), 1024);
  assert.equal(await page.getAttribute('#p2j-pw', 'aria-invalid'), null, 'typing clears the error');
  await page.press('#p2j-pw', 'Enter');
  await page.waitForFunction(() => /not right/.test(document.getElementById('p2j-pw-error').textContent));
  await page.fill('#p2j-pw', 'open sesame');
  await page.press('#p2j-pw', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 1);
  assert.match(await text('#p2j-meta'), /^1 page · [\d.]+\u00a0KB · unlocked$/);
  assert.equal(await page.inputValue('#p2j-pages'), '1');
  assert.equal(await text('#p2j-go'), 'Convert page 1 to JPG');
  let out = await save();
  assert.equal(out.name, 'locked-page-1.jpg', 'one page is saved as an image, not a ZIP');
  let info = jpegInfo(out.buf);
  assert.deepEqual([info.soi, info.w, info.h], [true, 1240, 1754]);
  let img = await look(out.buf, 'image/jpeg', [{ x: 0.05, y: 0.05 }]);
  near(img.samples[0], [255, 255, 255], 3, 'the corner of the locked page is white');
  assert.ok(img.grid.flat().some(c => c[0] < 200), 'the text of the locked page is drawn');
  // An owner password only, forbidding printing and copying: opened and converted without asking.
  await page.setInputFiles('#p2j-file', fx('restricted.pdf'));
  await page.waitForFunction(() => /restricted\.pdf is open: 1 page, unlocked\./.test(document.getElementById('p2j-status').textContent));
  assert.equal(await page.isVisible('#p2j-unlock'), false);
  out = await save();
  assert.equal(out.name, 'restricted-page-1.jpg');
  img = await look(out.buf, 'image/jpeg', [{ x: 0.05, y: 0.05 }]);
  assert.ok(img.grid.flat().some(c => c[0] < 200), 'the text of the restricted page is drawn');

  // ---- pages.pdf: sizes at each DPI, follow the setting at once ----
  await page.setInputFiles('#p2j-file', fx('pages.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 3);
  await page.waitForFunction(() => [...document.querySelectorAll('.p2j-info')].every(e => e.textContent));
  assert.equal(await page.inputValue('#p2j-pages'), '1-3');
  assert.equal(await plan(), 'All 3 pages to JPG at 150 DPI, quality 90. Page 1 becomes 1,240 × 1,754 pixels.');
  assert.equal(await text('#p2j-go'), 'Convert 3 pages to JPG');
  const sized = dpi => exp.sizes[dpi].map(([w, h]) => `${w} × ${h} px`);
  assert.deepEqual(await infos(), sized(150));
  await page.selectOption('#p2j-dpi', '300');
  assert.deepEqual(await infos(), sized(300));
  await page.selectOption('#p2j-dpi', '72');
  assert.deepEqual(await infos(), sized(72));
  assert.equal(await plan(), 'All 3 pages to JPG at 72 DPI, quality 90. Page 1 becomes 595 × 842 pixels.');
  await page.waitForFunction(() => [...document.querySelectorAll('.p2j-thumb img')].every(i => i.complete && i.naturalWidth > 0));
  assert.deepEqual(await page.$$eval('.p2j-thumb img', l => l.map(i => i.naturalWidth > i.naturalHeight ? 'wide' : 'tall')), ['tall', 'wide', 'wide']);

  // ---- PNG at 72 DPI: compared with poppler, colours at known points, the DPI in pHYs ----
  await setFormat('png');
  assert.equal(await page.isVisible('#p2j-q-field'), false);
  assert.equal(await page.isVisible('#p2j-transp-row'), true);
  assert.equal(await text('#p2j-go'), 'Convert 3 pages to PNG');
  out = await save();
  assert.equal(out.name, 'pages-png.zip');
  let entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['pages-page-1.png', 'pages-page-2.png', 'pages-page-3.png']);
  assert.match(await text('#p2j-status'), /^Saved pages-png\.zip with 3 PNG images, [\d.]+\u00a0KB\.$/);
  for (let i = 0; i < 3; i++) {
    const p = pngInfo(entries[i].data);
    assert.deepEqual([p.sig, p.w, p.h], [true, ...exp.sizes['72'][i]], `page ${i + 1} size`);
    assert.deepEqual([p.ppx, p.ppy, p.unit, p.crcOk], [2835, 2835, 1, true], 'pHYs says 72 DPI (2835 pixels per metre)');
    assert.ok(p.physAt < p.idatAt, 'pHYs comes before the image data');
    const pts = exp.points[String(i + 1)];
    img = await look(entries[i].data, 'image/png', pts);
    pts.forEach((pt, k) => near(img.samples[k], pt.rgb ? [...pt.rgb, 255] : [255, 255, 255, 255], 12, `page ${i + 1} point ${k + 1}`));
    const diff = gridDiff(img.grid, exp.poppler[String(i + 1)].grid);
    assert.ok(diff.mean < 3 && diff.max < 40, `page ${i + 1} looks as poppler draws it (mean ${diff.mean.toFixed(2)}, max ${diff.max.toFixed(1)})`);
  }
  // Each converted page can be downloaded on its own, byte for byte as in the ZIP.
  assert.deepEqual(await page.$$eval('.p2j-dl', l => l.map(b => b.hidden)), [false, false, false]);
  assert.match(await page.getAttribute('.p2j-page:nth-child(2) .p2j-dl', 'aria-label'), /^Download page 2 as PNG, [\d.]+\u00a0KB$/);
  let single = await save('.p2j-page:nth-child(2) .p2j-dl');
  assert.equal(single.name, 'pages-page-2.png');
  assert.ok(single.buf.equals(entries[1].data));
  // Converting again with the same settings reuses the images: no page is drawn again.
  await page.evaluate(() => {
    window.__drawn = 0;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) { if (this.width > 400) window.__drawn++; return getContext.apply(this, a); };
    window.__undo = () => { HTMLCanvasElement.prototype.getContext = getContext; };
  });
  const again = unzip((await save()).buf);
  assert.equal(await page.evaluate(() => { window.__undo(); return window.__drawn; }), 0, 'pages converted with the same settings are not drawn again');
  assert.ok(again.length === 3 && again.every((e, i) => e.name === entries[i].name && e.data.equals(entries[i].data)));
  // A no-break space keeps a file size and its unit on one line in the narrow page cards.
  assert.match((await infos())[0], /^595 × 842 · [\d.]+\u00a0KB$/);

  // Transparent background: only the parts with nothing drawn on them.
  await page.check('#p2j-transp');
  assert.deepEqual(await page.$$eval('.p2j-dl', l => l.map(b => b.hidden)), [true, true, true], 'images made with other settings are dropped at once');
  assert.equal(await plan(), 'All 3 pages to PNG at 72 DPI, transparent. Page 1 becomes 595 × 842 pixels.');
  await page.fill('#p2j-pages', '1');
  out = await save();
  assert.equal(out.name, 'pages-page-1.png');
  img = await look(out.buf, 'image/png', exp.points['1']);
  assert.equal(pngInfo(out.buf).colorType, 6, 'RGBA');
  near(img.samples[0], [255, 0, 0, 255], 12, 'red box');
  assert.equal(img.samples[2][3], 0, 'blank paper is transparent');
  await page.uncheck('#p2j-transp');

  // ---- JPG: quality reaches the encoder (IJG tables), DPI is written in JFIF ----
  await setFormat('jpg');
  await page.selectOption('#p2j-dpi', '300');
  await page.fill('#p2j-pages', '3');
  await page.$eval('#p2j-quality', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#p2j-qval'), '50');
  assert.equal(await plan(), 'Page 3 to JPG at 300 DPI, quality 50. Page 3 becomes 1,252 × 626 pixels.');
  out = await save();
  assert.equal(out.name, 'pages-page-3.jpg');
  info = jpegInfo(out.buf);
  assert.deepEqual([info.w, info.h], exp.sizes['300'][2]);
  assert.deepEqual([info.units, info.xd, info.yd], [1, 300, 300], 'JFIF density: 300 dots per inch');
  assert.deepEqual(info.dqt, exp.jpeg_luma_q['50']);
  // 300.4 pt at 300 DPI is 1251.67 pixels: the drawing is stretched to fill all 1252, so the last
  // column and row are orange too, not part white.
  img = await look(out.buf, 'image/jpeg', [...exp.points['3'], { x: 1, y: 0.15 }, { x: 0.25, y: 1 }]);
  near(img.samples[0], [255, 128, 0], 16, 'orange');
  near(img.samples[1], [0, 0, 0], 16, 'black bar');
  near(img.samples[2], [255, 128, 0], 16, 'orange in the last column');
  near(img.samples[3], [255, 128, 0], 16, 'orange in the last row');
  const q50 = out.buf.length;
  await page.focus('#p2j-quality');
  for (let i = 0; i < 45; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await text('#p2j-qval'), '95', 'the quality slider works from the keyboard');
  out = await save();
  info = jpegInfo(out.buf);
  assert.deepEqual(info.dqt, exp.jpeg_luma_q['95']);
  assert.ok(out.buf.length > q50, 'quality 95 makes a larger file than 50');

  // ---- Other DPI: typed values, mistakes ----
  await page.selectOption('#p2j-dpi', 'custom');
  assert.equal(await page.isVisible('#p2j-custom'), true);
  await page.fill('#p2j-pages', '1-3');
  assert.equal(await plan(), 'All 3 pages to JPG at 250 DPI, quality 95. Page 1 becomes 2,067 × 2,923 pixels.');
  for (const [value, message] of [['5', 'Enter a resolution from 10 to 1200 DPI.'], ['1201', 'Enter a resolution from 10 to 1200 DPI.'], ['abc', 'Enter a whole number of DPI from 10 to 1200.'],
    ['3²', 'Enter a whole number of DPI from 10 to 1200.'], ['150.5', 'Enter a whole number of DPI from 10 to 1200.'], ['', 'Enter a resolution from 10 to 1200 DPI.']]) {
    await page.fill('#p2j-custom', value);
    await page.waitForFunction(() => document.getElementById('p2j-custom-error').textContent !== '');
    const got = await fieldError('p2j-custom');
    assert.deepEqual(got, { text: message, invalid: 'true', linked: true }, `${value}: ${JSON.stringify(got)}`);
    assert.equal(await plan(), '');
    assert.equal(await text('#p2j-go'), 'Convert');
  }
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.click('#p2j-go');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2j-custom');
  await page.fill('#p2j-custom', '１５０');
  assert.deepEqual(await fieldError('p2j-custom'), { text: '', invalid: null, linked: true });
  assert.deepEqual(await infos(), sized(150), 'full-width digits are read');

  // ---- Pages to convert: mistakes, an empty choice, a megabyte paste ----
  for (const [value, message] of [['4', 'Page 4 does not exist: this PDF has 3 pages.'], ['0', 'There is no page 0: the first page is 1.'], ['1-x', '“x” is not a page number. Use numbers, dashes and commas, such as 1-3, 5.'],
    ['1-2-3', 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.'], ['2-all', 'A range ends with a page number or “end”, as in 5-end.'], ['0,500', 'There is no page 0: the first page is 1.'], ['00000000004', 'Page 4 does not exist: this PDF has 3 pages.'],
    ['2\u200b3', 'A hidden character (U+200B) cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.']]) {
    await page.fill('#p2j-pages', value);
    await page.waitForFunction(() => document.getElementById('p2j-pages-error').textContent !== '');
    assert.deepEqual(await fieldError('p2j-pages'), { text: message, invalid: 'true', linked: true }, value);
  }
  await page.fill('#p2j-pages', '00000000002');
  assert.equal(await plan(), 'Page 2 to JPG at 150 DPI, quality 95. Page 2 becomes 1,650 × 1,275 pixels.', 'leading zeros do not make a number too long');
  assert.equal((await fieldError('p2j-pages')).invalid, null, 'a good value clears the message at once');
  // A list that is not finished yet is not flagged while typing: "1-" on the way to "1-4".
  await page.fill('#p2j-pages', '1-');
  await page.type('#p2j-pages', '4');
  assert.deepEqual(await fieldError('p2j-pages'), { text: '', invalid: null, linked: true }, 'no message before a pause in typing');
  await page.waitForFunction(() => document.getElementById('p2j-pages-error').textContent !== '');
  assert.equal((await fieldError('p2j-pages')).text, 'Page 4 does not exist: this PDF has 3 pages.');
  await page.fill('#p2j-pages', '');
  assert.equal(await plan(), 'Select at least one page: click it below or type its number.');
  assert.equal((await fieldError('p2j-pages')).invalid, null, 'no error before Convert is pressed');
  await page.click('#p2j-go');
  assert.deepEqual(await fieldError('p2j-pages'), { text: 'Select at least one page: click it below or type its number.', invalid: 'true', linked: true });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2j-pages');
  for (const [id, filler, pattern] of [['p2j-pages', '2, ', /^This list is 1,04\d,\d{3} characters long\. Keep it under 10,000 characters\.$/], ['p2j-pages', '   ', /^This list is/], ['p2j-custom', '9', /^Enter a whole number of DPI/]]) {
    const big = filler.repeat(Math.ceil(1048576 / filler.length));
    const t0 = Date.now();
    await page.$eval('#' + id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, big);
    await page.waitForFunction(id => document.getElementById(id + '-error').textContent !== '', id);
    assert.ok(Date.now() - t0 < 3000, `a megabyte in #${id} is handled quickly`);
    assert.match((await fieldError(id)).text, pattern);
    assert.equal(await page.$eval('#' + id, el => el.value.length), big.length, 'what was typed is kept');
  }
  await page.fill('#p2j-custom', '150');
  await page.waitForTimeout(200);
  assert.equal(downloads, 0);

  // ---- Picking pages: clicks, a drag, Shift+click, the keyboard ----
  await page.fill('#p2j-pages', '1-3');
  await page.evaluate(() => window.__planWrites.splice(0));
  await page.type('#p2j-pages', ' ');
  assert.deepEqual(await page.evaluate(() => window.__planWrites.splice(0)), [], 'the same choice typed differently does not repeat the summary');
  await page.click('.p2j-page:nth-child(2) .p2j-thumb');
  assert.equal(await page.inputValue('#p2j-pages'), '1, 3');
  assert.equal(await plan(), 'Pages 1 and 3 to JPG at 150 DPI, quality 95. Page 1 becomes 1,240 × 1,754 pixels.');
  assert.deepEqual(await page.evaluate(() => window.__planWrites.splice(0)), ['Pages 1 and 3 to JPG at 150 DPI, quality 95. Page 1 becomes 1,240 × 1,754 pixels.']);
  await page.$eval('.p2j-page:nth-child(1)', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = async n => (await page.$(`.p2j-page:nth-child(${n}) .p2j-thumb`)).boundingBox();
  const b1 = await box(1), b3 = await box(3);
  await page.mouse.move(b1.x + 40, b1.y + 50);
  await page.mouse.down();
  await page.mouse.move(b3.x + 40, b3.y + 50, { steps: 10 });
  await page.mouse.up();
  assert.equal(await page.inputValue('#p2j-pages'), '', 'a drag from a picked page clears the pages it passes');
  await page.click('.p2j-page:nth-child(1) .p2j-thumb');
  await page.click('.p2j-page:nth-child(3) .p2j-thumb', { modifiers: ['Shift'] });
  assert.equal(await page.inputValue('#p2j-pages'), '1-3');
  await page.click('[data-pick="none"]');
  await page.focus('.p2j-page:nth-child(2) .p2j-check');
  await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#p2j-pages'), '2');
  assert.deepEqual(await page.$$eval('.p2j-page', l => l.map(e => e.classList.contains('is-selected'))), [false, true, false]);
  // Convert from the keyboard, then download that page with its own button.
  await page.focus('#p2j-pages');
  const [dlKey] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(dlKey.suggestedFilename(), 'pages-page-2.jpg');
  assert.deepEqual([jpegInfo(fs.readFileSync(await dlKey.path())).w, jpegInfo(fs.readFileSync(await dlKey.path())).h], exp.sizes['150'][1]);
  await page.focus('.p2j-page:nth-child(2) .p2j-dl');
  const [dlBtn] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.ok(fs.readFileSync(await dlBtn.path()).equals(fs.readFileSync(await dlKey.path())));
  await page.click('[data-pick="all"]');
  assert.equal(await page.inputValue('#p2j-pages'), '1-3');

  // ---- Cancel; then a page too large for the DPI ----
  // While converting, every control that changes the images is disabled. A Cancel pressed before the
  // first page is drawn means no page is drawn at all.
  const during = await page.evaluate(() => {
    window.__bigCanvases = 0;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) { if (this.width > 400) window.__bigCanvases++; return getContext.apply(this, a); };
    window.__restoreCanvas = () => { HTMLCanvasElement.prototype.getContext = getContext; };
    document.getElementById('p2j-go').click();
    const els = [...document.querySelectorAll('#p2j-go, #p2j-another, #p2j-dpi, #p2j-quality, #p2j-transp, #p2j-custom, #p2j-pages, input[name="p2j-format"], [data-pick], .p2j-check')];
    const off = els.filter(e => e.disabled).length;
    const cancelShown = !document.getElementById('p2j-cancel').hidden;
    document.getElementById('p2j-cancel').click();
    return { off, all: els.length, cancelShown };
  });
  assert.equal(during.off, during.all, 'the controls are disabled while converting');
  assert.equal(during.cancelShown, true);
  await page.waitForFunction(() => /^Cancelled\./.test(document.getElementById('p2j-status').textContent));
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => { window.__restoreCanvas(); return window.__bigCanvases; }), 0, 'a conversion cancelled at once draws no page');
  assert.equal(await page.$$eval('#p2j-pages, #p2j-dpi, .p2j-check', l => l.filter(e => e.disabled).length), 0, 'the controls work again');
  // Cancel while a page is still being read from the file (its request to the PDF.js worker is held
  // back here): once the page arrives it is not drawn.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    window.__held = null;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.action === 'GetPage' && msg.data && msg.data.pageIndex === 2 && !window.__held) { window.__held = () => post.call(this, msg, ...rest); return; }
      return post.call(this, msg, ...rest);
    };
    window.__unhook = () => { Worker.prototype.postMessage = post; };
  });
  await page.setInputFiles('#p2j-file', { name: 'slow.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('pages.pdf')) });
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 3 && window.__held);
  await page.fill('#p2j-pages', '3');
  const late = await page.evaluate(async () => {
    let big = 0;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) { if (this.width > 400) big++; return getContext.apply(this, a); };
    document.getElementById('p2j-go').click();
    await new Promise(r => setTimeout(r, 50));
    document.getElementById('p2j-cancel').click();
    window.__unhook();
    window.__held();
    await new Promise(r => setTimeout(r, 1000));
    HTMLCanvasElement.prototype.getContext = getContext;
    return { big, status: document.getElementById('p2j-status').textContent };
  });
  assert.deepEqual(late, { big: 0, status: 'Cancelled. Nothing was saved.' }, 'a page that arrives after Cancel is not drawn: ' + JSON.stringify(late));
  assert.equal(await page.isVisible('#p2j-progress'), false);
  assert.equal(await page.isDisabled('#p2j-go'), false);
  await page.setInputFiles('#p2j-file', fx('huge.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 1 && document.querySelector('.p2j-info').textContent);
  await page.selectOption('#p2j-dpi', '300');
  // 14,400 pt is 200 inches: 60,000 pixels a side at 300 DPI. Capped at 64 million pixels: 8,000 a side, 40 DPI.
  assert.equal(await plan(), 'The page to JPG at 300 DPI, quality 95. Page 1 becomes 8,000 × 8,000 pixels, at 40 DPI as it is very large.');
  assert.equal(await text('.p2j-info'), '8000 × 8000 pxat 40 DPI');
  // Cancel while the page is being drawn stops the drawing: the image is never encoded. The Cancel is
  // pressed when PDF.js paints the page's white background, the first thing it draws.
  const stopped = await page.evaluate(async () => {
    const toBlob = HTMLCanvasElement.prototype.toBlob, fillRect = CanvasRenderingContext2D.prototype.fillRect;
    let pressed = 0, encoded = 0;
    CanvasRenderingContext2D.prototype.fillRect = function (...a) {
      if (this.canvas.width > 1000 && a[2] === this.canvas.width && !pressed) { pressed++; document.getElementById('p2j-cancel').click(); }
      return fillRect.apply(this, a);
    };
    HTMLCanvasElement.prototype.toBlob = function (...a) { if (this.width > 1000) encoded++; return toBlob.apply(this, a); };
    document.getElementById('p2j-go').click();
    await new Promise(r => setTimeout(r, 2500));
    HTMLCanvasElement.prototype.toBlob = toBlob;
    CanvasRenderingContext2D.prototype.fillRect = fillRect;
    return { pressed, encoded, status: document.getElementById('p2j-status').textContent };
  });
  assert.deepEqual(stopped, { pressed: 1, encoded: 0, status: 'Cancelled. Nothing was saved.' }, 'Cancel stops the drawing: ' + JSON.stringify(stopped));
  out = await save();
  info = jpegInfo(out.buf);
  assert.deepEqual([info.w, info.h, info.units, info.xd], [8000, 8000, 1, 40]);
  assert.match(await text('#p2j-status'), /^Saved huge-page-1\.jpg: 8000 × 8000 pixels, [\d.]+\u00a0[KM]B\. Page 1 is too large for 300 DPI, so it was converted at 40 DPI, the most pixels one image can have here\.$/);
  img = await look(out.buf, 'image/jpeg', [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1 }], { resizeWidth: 240, resizeHeight: 240 });
  near(img.samples[0], [255, 255, 255], 8, 'white middle');
  near(img.samples[1], [0, 0, 0], 8, 'black edge');
  // A browser that holds fewer pixels than that (simulated: a canvas over 40 million pixels stays blank)
  // gets the page at a lower DPI, tried in steps: 40 DPI is 64 million pixels, 32 is 41 million, 25 fits.
  await page.evaluate(() => {
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...a) {
      const d = getImageData.apply(this, a);
      if (this.canvas.width * this.canvas.height > 40e6) d.data.fill(0);
      return d;
    };
    window.__restoreImageData = () => { CanvasRenderingContext2D.prototype.getImageData = getImageData; };
  });
  await page.selectOption('#p2j-dpi', '600');
  out = await save();
  await page.evaluate(() => window.__restoreImageData());
  info = jpegInfo(out.buf);
  assert.deepEqual([info.w, info.h, info.xd], [5000, 5000, 25]);
  assert.match(await text('#p2j-status'), /^Saved huge-page-1\.jpg: 5000 × 5000 pixels, [\d.]+\u00a0[KM]B\. Page 1 is too large for 600 DPI, so it was converted at 25 DPI, the most pixels one image can have here\.$/);

  // ---- Fonts that are not embedded: the CMap and the Dingbats font come from this site ----
  // The PDF.js worker fetches them; each response is awaited, so the check does not depend on when the
  // worker's network events reach the test.
  const fontFiles = ['cmaps/UniJIS-UCS2-H.bcmap', 'standard_fonts/FoxitDingbats.pfb'];
  const fontResponses = fontFiles.map(f => page.waitForResponse(r => r.url().endsWith('/pdfjs-resources/' + f)).then(r => r.status() + ' ' + f, () => 'no response for ' + f));
  // Convert pressed while a newly chosen PDF is still being checked or opened does nothing. It used to
  // convert the PDF still on screen (huge.pdf, also one page) and, once the new one had opened, save
  // the old page under the new name. Both reads of fonts.pdf, its first kilobyte (is it a PDF?) and
  // then the whole file, are held back here until Convert has been pressed.
  await page.evaluate(() => {
    const slice = Blob.prototype.slice, read = Blob.prototype.arrayBuffer;
    window.__held = [];
    Blob.prototype.slice = function (...a) { const b = slice.apply(this, a); if (this.name === 'fonts.pdf') b.__fonts = true; return b; };
    Blob.prototype.arrayBuffer = function () {
      if (this.name !== 'fonts.pdf' && !this.__fonts) return read.call(this);
      if (this.name === 'fonts.pdf') { Blob.prototype.slice = slice; Blob.prototype.arrayBuffer = read; }
      return new Promise(resolve => window.__held.push(() => resolve(read.call(this))));
    };
  });
  // Waits for read n to be held, presses Convert, notes whether a conversion started, lets the read go on.
  const pressWhileReading = async n => {
    await page.waitForFunction(n => window.__held.length === n, n);
    return page.evaluate(n => {
      document.getElementById('p2j-go').click();
      const seen = { converting: !document.getElementById('p2j-progress').hidden, status: document.getElementById('p2j-status').textContent };
      window.__held[n - 1]();
      return seen;
    }, n);
  };
  await page.setInputFiles('#p2j-file', fx('fonts.pdf'));
  assert.equal((await pressWhileReading(1)).converting, false, 'Convert waits while the chosen file is checked');
  assert.deepEqual(await pressWhileReading(2), { converting: false, status: 'Opening fonts.pdf…' }, 'Convert waits for the PDF being opened');
  // Waiting for one page would not do: huge.pdf has one page too.
  await page.waitForFunction(() => document.getElementById('p2j-status').textContent === 'fonts.pdf is open: 1 page.');
  await page.selectOption('#p2j-dpi', '72');
  out = await save();
  assert.equal(out.name, 'fonts-page-1.jpg');
  assert.deepEqual(await Promise.all(fontResponses), fontFiles.map(f => '200 ' + f));
  img = await look(out.buf, 'image/jpeg');
  // Row 2 of the 12 x 12 grid holds the Japanese line (8 characters, about 5 cells wide), row 4 the
  // Dingbats; without the CMap or the font file they would stay blank.
  assert.ok(img.grid[1].filter(c => c[0] < 248).length >= 4, 'the Japanese line is drawn: ' + img.grid[1].map(c => Math.round(c[0])).join(' '));
  assert.ok(img.grid[3].filter(c => c[0] < 235).length >= 2, 'the Dingbats are drawn: ' + img.grid[3].map(c => Math.round(c[0])).join(' '));

  // ---- The sample PDF, offered while no PDF is open; the drop area hides once one is ----
  assert.equal(await page.isVisible('#p2j-drop'), false);
  await open();
  await page.click('#p2j-sample');
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 3);
  assert.equal(await text('#p2j-name'), 'sample.pdf');
  await page.selectOption('#p2j-dpi', '72');
  await setFormat('png');
  await page.check('#p2j-transp');
  await page.fill('#p2j-pages', '3');
  out = await save();
  assert.equal(out.name, 'sample-page-3.png');
  img = await look(out.buf, 'image/png', [{ x: 0.95, y: 0.95 }, { x: 0.5, y: 0.4 }]);
  assert.deepEqual([img.w, img.h], [612, 792], 'a Letter page at 72 DPI');
  assert.equal(img.samples[0][3], 0);
  near(img.samples[1], [217, 38, 51, 255], 6, 'the red bar of the sample');

  // ---- Names are padded so that page 10 sorts after page 9 ----
  await page.setInputFiles('#p2j-file', fx('twelve.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 12);
  assert.equal(await page.inputValue('#p2j-pages'), '1-12');
  await setFormat('jpg');
  await page.fill('#p2j-pages', '9-10');
  out = await save();
  assert.equal(out.name, 'twelve-jpg.zip');
  assert.deepEqual(unzip(out.buf).map(e => e.name), ['twelve-page-09.jpg', 'twelve-page-10.jpg']);
  // A page that cannot be made into an image (simulated: the second one is not encoded) is named, and
  // the other page is still saved.
  await page.evaluate(() => {
    let n = 0;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...a) { if (this.width > 400 && ++n === 2) { setTimeout(() => cb(null), 0); return; } return toBlob.call(this, cb, ...a); };
    window.__restoreBlob = () => { HTMLCanvasElement.prototype.toBlob = toBlob; };
  });
  await page.fill('#p2j-pages', '1-2');
  out = await save();
  await page.evaluate(() => window.__restoreBlob());
  assert.equal(out.name, 'twelve-page-01.jpg');
  assert.equal(await text('#p2j-error'), 'Page 2 could not be converted: the image could not be encoded. The other page was saved.');
  assert.deepEqual(await page.$$eval('.p2j-dl', l => l.slice(0, 3).map(b => b.hidden)), [false, true, true]);
  // A page PDF.js cannot read (its entry in the page tree is a number) is named in plain words, with
  // one full stop: not "Page dictionary kid reference points to wrong type of object..".
  await page.setInputFiles('#p2j-file', { name: 'bad-page.pdf', mimeType: 'application/pdf', buffer: rawPdf([CATALOG, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>', A_PAGE, '42', A_PAGE]) });
  await page.waitForFunction(() => /^bad-page\.pdf is open/.test(document.getElementById('p2j-status').textContent));
  out = await save();
  assert.match(out.name, /^bad-page-(page-1\.jpg|jpg\.zip)$/);
  assert.equal(await text('#p2j-error'), 'Page 2 could not be converted: it may be damaged. ' + (out.name.endsWith('.zip') ? 'The other pages were saved.' : 'The other page was saved.'));

  // ---- Dropped files: one PDF at a time; a page with /UserUnit 2 is twice as big ----
  const drop = list => page.evaluate(files => {
    const dt = new DataTransfer();
    for (const [name, b64] of files) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, list);
  const tinyPdf = extra => {
    const objs = ['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] ${extra} /Contents 4 0 R >>`, '<< /Length 21 >>\nstream\n1 0 0 rg 0 0 50 50 re f\nendstream'];
    let body = '%PDF-1.6\n';
    const offs = [];
    for (let i = 1; i < objs.length; i++) { offs[i] = body.length; body += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    const xref = body.length;
    body += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n' + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    return Buffer.from(body + 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n', 'latin1').toString('base64');
  };
  await drop([['big-unit.pdf', tinyPdf('/UserUnit 2')], ['other.pdf', tinyPdf('')]]);
  await page.waitForFunction(() => document.getElementById('p2j-name').textContent === 'big-unit.pdf' && document.querySelector('.p2j-info').textContent);
  assert.equal(await text('#p2j-error'), 'This tool converts one PDF at a time, so only big-unit.pdf was opened.');
  await page.selectOption('#p2j-dpi', '72');
  assert.deepEqual(await infos(), ['200 × 100 px'], '100 × 50 units of 2/72 inch');
  out = await save();
  assert.deepEqual([jpegInfo(out.buf).w, jpegInfo(out.buf).h], [200, 100]);

  // ---- A PDF dropped while converting is refused with a message, which goes when the conversion ends ----
  // The conversion is held at its page image (its encoding waits) so that the drop lands while it runs.
  // The status line is not emptied meanwhile: emptied, it moved the whole form up, and down again at the end.
  const hold = () => page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    window.__go = null;
    HTMLCanvasElement.prototype.toBlob = function (...a) {
      if (this.width <= 400 || window.__go) return toBlob.apply(this, a);
      window.__go = () => { HTMLCanvasElement.prototype.toBlob = toBlob; toBlob.apply(this, a); };
    };
  });
  const top = id => page.$eval('#' + id, el => Math.round(el.getBoundingClientRect().top + scrollY));
  await page.selectOption('#p2j-dpi', '150');
  const goTop = await top('p2j-go');
  await hold();
  await page.click('#p2j-go');
  await page.waitForFunction(() => window.__go);
  assert.equal(await text('#p2j-status'), 'Converting page 1 to JPG…');
  assert.equal(await top('p2j-go'), goTop, 'the Convert button stays where it was');
  // A real drop reaches the page only if dragover leaves a drop effect other than none; the drop area,
  // which invites a drop, does not show.
  const second = [['second.pdf', tinyPdf('')]];
  const over = await page.evaluate(() => {
    const dt = new DataTransfer();
    let effect = 'not set';
    dt.items.add(new File(['%PDF-1.4'], 'second.pdf'));
    // Outside a real drag the browser ignores what is written to dropEffect, so it is caught here.
    Object.defineProperty(dt, 'dropEffect', { get: () => effect, set: v => { effect = v; } });
    const ev = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return { taken: ev.defaultPrevented, effect, shown: document.getElementById('p2j-drop').classList.contains('is-over') };
  });
  assert.deepEqual(over, { taken: true, effect: 'copy', shown: false });
  await drop(second);
  assert.equal(await text('#p2j-error'), 'Wait until the conversion finishes, or press Cancel, then drop second.pdf again.');
  assert.equal(await text('#p2j-name'), 'big-unit.pdf', 'the PDF being converted stays open');
  const [dlHeld] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__go())]);
  assert.equal(dlHeld.suggestedFilename(), 'big-unit-page-1.jpg');
  assert.equal(await text('#p2j-error'), '', 'the message goes when the conversion ends');
  assert.match(await text('#p2j-status'), /^Saved big-unit-page-1\.jpg: 417 × 208 pixels/);
  assert.equal(await top('p2j-go'), goTop);
  // Cancel clears it too; the dropped file is then opened as usual.
  await page.selectOption('#p2j-dpi', '200');
  await hold();
  await page.click('#p2j-go');
  await page.waitForFunction(() => window.__go);
  await drop(second);
  assert.match(await text('#p2j-error'), /^Wait until the conversion finishes/);
  await page.click('#p2j-cancel');
  assert.equal(await text('#p2j-error'), '');
  assert.equal(await text('#p2j-status'), 'Cancelled. Nothing was saved.');
  await page.evaluate(() => window.__go());
  await drop(second);
  await page.waitForFunction(() => document.getElementById('p2j-name').textContent === 'second.pdf');

  // ---- A phone with a touch screen, set to German: a decimal comma does not change how lists or DPI are read ----
  const browser = page.context().browser();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true, locale: 'de-DE' });
  const p2 = await phone.newPage();
  const errors = [];
  p2.on('pageerror', e => errors.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p2.goto(url);
  await p2.setInputFiles('#p2j-file', fx('pages.pdf'));
  await p2.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 3);
  assert.equal(await p2.evaluate(() => (1.5).toLocaleString()), '1,5', 'the browser uses a decimal comma');
  assert.equal(await p2.textContent('#p2j-plan'), 'All 3 pages to JPG at 150 DPI, quality 90. Page 1 becomes 1,240 × 1,754 pixels.');
  await p2.fill('#p2j-pages', '1,3');
  assert.equal(await p2.textContent('#p2j-plan'), 'Pages 1 and 3 to JPG at 150 DPI, quality 90. Page 1 becomes 1,240 × 1,754 pixels.', 'a comma separates pages');
  await p2.selectOption('#p2j-dpi', 'custom');
  await p2.fill('#p2j-custom', '150,5');
  await p2.waitForFunction(() => document.getElementById('p2j-custom-error').textContent !== '');
  assert.equal(await p2.textContent('#p2j-custom-error'), 'Enter a whole number of DPI from 10 to 1200.');
  await p2.selectOption('#p2j-dpi', '150');
  await p2.fill('#p2j-pages', '1-3');
  // Nothing is cut off: buttons, and every choice in the resolution list, at common phone widths.
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p2.setViewportSize({ width, height: 844 });
    const cut = await p2.$$eval('.p2j-seg label, .p2j-quick .btn, #p2j-go, .p2j-file .btn, .p2j-dl', l => l.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim()));
    assert.deepEqual(cut, [], `no button text cut off at ${width}px`);
    const tooLong = await p2.$eval('#p2j-dpi', sel => {
      const cs = getComputedStyle(sel), probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
      document.body.appendChild(probe);
      const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
      const long = [...sel.options].filter(o => { probe.textContent = o.text; return probe.getBoundingClientRect().width > room; }).map(o => o.text);
      probe.remove();
      return long;
    });
    assert.deepEqual(tooLong, [], `resolution choices fit at ${width}px`);
    assert.ok(await p2.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px`);
  }
  await p2.setViewportSize({ width: 390, height: 844 });
  assert.ok((await p2.$eval('#p2j-quality', e => e.getBoundingClientRect().height)) >= 44, 'the slider is a big enough target');
  await p2.$eval('.p2j-page:nth-child(1)', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p2.tap('.p2j-page:nth-child(2) .p2j-thumb');
  assert.equal(await p2.inputValue('#p2j-pages'), '1, 3');
  const cdp = await phone.newCDPSession(p2);
  const t1 = await (await p2.$('.p2j-page:nth-child(1) .p2j-thumb')).boundingBox();
  const t3 = await (await p2.$('.p2j-page:nth-child(3) .p2j-thumb')).boundingBox();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const before = await p2.evaluate(() => scrollY);
  await touch('touchStart', t1.x + 30, t1.y + 40);
  await p2.waitForTimeout(700);
  for (let s = 1; s <= 6; s++) await touch('touchMove', t1.x + 30 + (t3.x - t1.x) * s / 6, t1.y + 40 + (t3.y - t1.y) * s / 6);
  await touch('touchEnd');
  assert.equal(await p2.inputValue('#p2j-pages'), '', 'touch and hold on a picked page, then drag, clears pages 1 to 3');
  assert.equal(await p2.evaluate(() => scrollY), before, 'the page did not scroll during the drag');
  await p2.tap('.p2j-page:nth-child(3) .p2j-thumb');
  // The form does not move when a conversion starts or ends. The status line keeps two lines' height
  // on a phone, so the one-line "is open" and "Converting" give way to the two-line "Saved" in place
  // (the Convert button used to jump 58 px up and 81 px down: a layout shift of 0.08 a conversion).
  // Where the status line starts and ends, and where the Convert button and the pages start.
  const spots = () => p2.evaluate(() => {
    const at = id => document.getElementById(id).getBoundingClientRect(), s = at('p2j-status');
    return [s.top + scrollY, s.bottom + scrollY, at('p2j-go').top + scrollY, at('p2j-grid').top + scrollY].map(Math.round);
  });
  const lines = () => p2.$eval('#p2j-status', el => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map(c => Math.round(c.top))).size; });
  const rest = await spots();
  assert.equal(await p2.textContent('#p2j-status'), 'pages.pdf is open: 3 pages.');
  assert.equal(await lines(), 1);
  const [dlPhone, moved] = await Promise.all([p2.waitForEvent('download'), p2.evaluate(() => {
    document.getElementById('p2j-go').click();
    const at = id => document.getElementById(id).getBoundingClientRect(), s = at('p2j-status');
    return [document.getElementById('p2j-status').textContent].concat([s.top + scrollY, s.bottom + scrollY, at('p2j-go').top + scrollY].map(Math.round));
  })]);
  assert.deepEqual(moved, ['Converting page 3 to JPG…'].concat(rest.slice(0, 3)), 'nothing above the Convert button moves when it is pressed');
  assert.equal(dlPhone.suggestedFilename(), 'pages-page-3.jpg');
  await p2.waitForFunction(() => /^Saved/.test(document.getElementById('p2j-status').textContent));
  assert.equal(await lines(), 2, 'the message that ends the conversion takes two lines here');
  assert.deepEqual(await spots(), rest, 'nothing moves when the conversion ends');
  // A touch screen device gets at most 36 million pixels a page: 6,000 a side, 30 DPI for the poster.
  await p2.setInputFiles('#p2j-file', fx('huge.pdf'));
  await p2.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 1 && document.querySelector('.p2j-info').textContent);
  await p2.selectOption('#p2j-dpi', '300');
  assert.equal(await p2.textContent('#p2j-plan'), 'The page to JPG at 300 DPI, quality 90. Page 1 becomes 6,000 × 6,000 pixels, at 30 DPI as it is very large.');
  // A long file name wraps at 320 px: in the password prompt, the summary and the list of results.
  const longName = 'Quarterly_report_final_version_with_all_appendices_and_signatures_reviewed_by_legal';
  await p2.setViewportSize({ width: 320, height: 640 });
  await p2.setInputFiles('#p2j-file', { name: longName + '.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('locked.pdf')) });
  await p2.waitForSelector('#p2j-unlock:not([hidden])');
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 320), 'the password prompt fits at 320px');
  await p2.fill('#p2j-pw', 'open sesame');
  await p2.press('#p2j-pw', 'Enter');
  // By its name: the pages of huge.pdf are still on screen until this PDF is open.
  await p2.waitForFunction(name => document.getElementById('p2j-name').textContent === name, longName + '.pdf');
  const [dlLong] = await Promise.all([p2.waitForEvent('download'), p2.tap('#p2j-go')]);
  assert.equal(dlLong.suggestedFilename(), longName + '-page-1.jpg');
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 320), 'the results fit at 320px');
  assert.deepEqual(errors, []);
  await phone.close();
};
