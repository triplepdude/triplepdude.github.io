const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// Fixtures and expected.json come from tests/fixtures/pdf-to-png/make_fixtures.py (pikepdf, reportlab,
// Pillow, poppler): page sizes from the PDF boxes, poppler's drawing of each page as a 12 x 12 grid of
// average colours, the box of the logo's ink in poppler's drawing, and the pixels of every picture in
// pictures.pdf as made by numpy and decoded by Pillow. Every PNG the page saves is read here byte by
// byte (decodePng: zlib for the image data, the CRC of every chunk checked), never by the page.

function decodePng(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let o = 8, ihdr = null, plte = null, trns = null, phys = null, physAt = -1, idatAt = -1;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    if (type === 'PLTE') plte = data;
    if (type === 'tRNS') trns = data;
    if (type === 'pHYs') { phys = { x: data.readUInt32BE(0), y: data.readUInt32BE(4), unit: data[8] }; physAt = o; }
    if (type === 'IDAT') { idat.push(data); if (idatAt < 0) idatAt = o; }
    o += 12 + len;
  }
  assert.equal(ihdr.interlace, 0);
  const { w, h, depth, type } = ihdr, chans = { 2: 3, 3: 1, 6: 4 }[type];
  assert.ok(chans && (type === 3 || depth === 8), `colour type ${type} depth ${depth}`);
  const bpp = Math.max(1, (chans * depth) >> 3), stride = Math.ceil(w * chans * depth / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat)), un = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? un[y * stride + i - bpp] : 0, b = y ? un[(y - 1) * stride + i] : 0, c = i >= bpp && y ? un[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      un[y * stride + i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
  }
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y * w + x) * 4;
    if (type === 3) {
      const byte = un[y * stride + ((x * depth) >> 3)], i = depth === 8 ? byte : (byte >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
      px[q] = plte[i * 3]; px[q + 1] = plte[i * 3 + 1]; px[q + 2] = plte[i * 3 + 2]; px[q + 3] = trns && i < trns.length ? trns[i] : 255;
    } else {
      const s = y * stride + x * chans;
      px[q] = un[s]; px[q + 1] = un[s + 1]; px[q + 2] = un[s + 2]; px[q + 3] = chans === 4 ? un[s + 3] : 255;
    }
  }
  return { w, h, type, depth, palette: plte ? plte.length / 3 : 0, phys, physFirst: physAt >= 0 && physAt < idatAt, px,
    at: (x, y) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)] };
}
// pHYs is in pixels per metre: a DPI is rounded to a whole number first, then divided by 0.0254.
const ppm = dpi => Math.round(Math.round(dpi) / 0.0254);
// A 12 x 12 grid of average colours, composited on white as poppler draws (make_fixtures.py, grid()).
function gridOf(img, n = 12) {
  const out = [];
  for (let gy = 0; gy < n; gy++) {
    const row = [];
    for (let gx = 0; gx < n; gx++) {
      const s = [0, 0, 0];
      let k = 0;
      for (let y = Math.floor(gy * img.h / n); y < Math.floor((gy + 1) * img.h / n); y++) {
        for (let x = Math.floor(gx * img.w / n); x < Math.floor((gx + 1) * img.w / n); x++) {
          const i = (y * img.w + x) * 4, a = img.px[i + 3] / 255;
          for (let c = 0; c < 3; c++) s[c] += img.px[i + c] * a + 255 * (1 - a);
          k++;
        }
      }
      row.push(s.map(v => v / k));
    }
    out.push(row);
  }
  return out;
}
function gridDiff(a, b) {
  let sum = 0, max = 0, n = 0;
  for (let y = 0; y < a.length; y++) for (let x = 0; x < a[y].length; x++) for (let c = 0; c < 3; c++) {
    const d = Math.abs(a[y][x][c] - b[y][x][c]);
    sum += d; n++; if (d > max) max = d;
  }
  return { mean: sum / n, max };
}
// PSNR of the colour, both images composited on white.
function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) {
    const x = a[i + c] * a[i + 3] / 255 + 255 - a[i + 3], y = b[i + c] * b[i + 3] / 255 + 255 - b[i + 3];
    se += (x - y) ** 2;
  }
  return se ? 10 * Math.log10(255 * 255 / (se / (a.length * 3 / 4))) : Infinity;
}
// ITU-R 601 luma with Pillow's rounding, as Pillow's convert('L') does it (Convert.c, L24).
const luma = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
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
// A PDF written by hand from its objects (numbered from 1), for files no app would write.
function rawPdf(objs, trailer = '') {
  let body = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(body.length); body += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = body.length;
  body += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(body + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R' + trailer + ' >>\nstartxref\n' + xref + '\n%%EOF\n', 'latin1');
}
// n pages of w x h points, each with its number and a box, in one shared content stream per page.
function manyPages(n, w = 144, h = 144) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 0; i < n; i++) {
    const s = `0.2 0.4 0.8 rg 10 10 40 40 re f BT /F1 24 Tf 20 80 Td (${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length + 2} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
  return rawPdf(objs);
}

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const fx = n => path.join(fixtures, n);
  const exp = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  const browser = page.context().browser();
  await open();
  assert.equal(await page.isVisible('#p2p-drop'), true);
  assert.equal(await page.isVisible('#p2p-work'), false);
  assert.equal(await page.textContent('#p2p-drop .hint'), 'Pages become PNG images on your device; nothing is uploaded.');
  // The guide and FAQ as built: every answer whole (a YAML value holding ": " must be quoted) and the
  // links pointing at pages of this site.
  const faq = await page.$$eval('.faq details', l => l.map(d => [d.querySelector('summary').textContent, d.querySelector('.faq-answer').textContent.trim()]));
  assert.equal(faq.length, 5);
  assert.match(faq[0][1], /^No\. .*nothing is sent to a server\./, 'the first answer is about privacy');
  assert.ok(faq.some(([q, a]) => /without losing quality/.test(q) && /^Choose 300 DPI or more and Exact colours: PNG itself loses nothing\./.test(a) && /not sharper ones\.$/.test(a)));
  assert.ok(faq.some(([q, a]) => /several PDFs/.test(q) && /^One at a time: open the next PDF/.test(a) && /the same way\.$/.test(a)));
  assert.deepEqual(await page.$$eval('.prose a, .faq a', l => l.map(a => new URL(a.href).pathname)), ['/pdf-to-jpg/', '/image-to-pdf/', '/pdf-to-text/']);

  const text = sel => page.textContent(sel);
  const plan = () => text('#p2p-plan');
  const infos = () => page.$$eval('.p2p-info', l => l.map(e => e.textContent));
  const png = buf => decodePng(buf, assert);
  const save = async (sel = '#p2p-go', p = page) => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  const what = v => page.click(`.p2p-seg label:has(input[value="${v}"])`);
  const background = v => page.check(`input[name="p2p-bg"][value="${v}"]`);
  const openPdf = async (file, n, p = page) => {
    const name = typeof file === 'string' ? path.basename(file) : file.name;
    await p.setInputFiles('#p2p-file', file);
    await p.waitForFunction(([name, n]) => document.getElementById('p2p-name').textContent === name && document.querySelectorAll('.p2p-page').length === n &&
      /is open/.test(document.getElementById('p2p-status').textContent), [name, n]);
  };
  const fieldError = id => page.evaluate(id => {
    const f = document.getElementById(id), box = document.getElementById(id + '-error');
    return { text: box.textContent, invalid: f.getAttribute('aria-invalid'), linked: (f.getAttribute('aria-describedby') || '').split(/\s+/).includes(id + '-error') };
  }, id);
  const near = (got, want, tol, msg) => assert.ok(want.every((v, i) => Math.abs(got[i] - v) <= tol), `${msg}: ${JSON.stringify(got)} is not ${JSON.stringify(want)}`);
  // The live regions are written only when their text changes.
  const watch = () => page.evaluate(() => {
    window.__writes = { plan: [], status: [] };
    for (const [k, id] of [['plan', 'p2p-plan'], ['status', 'p2p-status']]) {
      const el = document.getElementById(id);
      new MutationObserver(() => window.__writes[k].push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
  await watch();

  // ---- Files that cannot be converted ----
  await page.setInputFiles('#p2p-file', { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
  await page.waitForFunction(() => document.getElementById('p2p-error').textContent === 'empty.pdf is empty.');
  await page.setInputFiles('#p2p-file', fx('notpdf.pdf'));
  await page.waitForFunction(() => document.getElementById('p2p-error').textContent === 'notpdf.pdf is not a PDF file.');
  for (const f of ['damaged-junk.pdf', 'damaged-cut.pdf']) {
    await page.setInputFiles('#p2p-file', fx(f));
    await page.waitForFunction(f => document.getElementById('p2p-error').textContent === f + ' is damaged or is not a valid PDF.', f);
    assert.equal(await text('#p2p-status'), '', `${f}: "Opening" is not left on screen`);
    assert.equal(await page.isVisible('#p2p-work'), false);
  }
  // A broken cross-reference table and garbage in the middle are repaired by PDF.js: the pages come out
  // as drawn, not blank (the garbage spoils the font, not the boxes).
  await openPdf(fx('damaged-xref.pdf'), 1);
  await page.selectOption('#p2p-size', '72');
  let out = await save();
  assert.equal(out.name, 'damaged-xref-page-1.png');
  let img = png(out.buf);
  assert.deepEqual([img.w, img.h], [200, 100]);
  await openPdf(fx('damaged-garbage.pdf'), 4);
  await page.fill('#p2p-pages', '1');
  img = png((await save()).buf);
  near(img.at(200, 175), [255, 0, 0, 255], 12, 'the red box of a repaired file');
  near(img.at(425, 175), [0, 0, 255, 255], 12, 'the blue box of a repaired file');

  // ---- Passwords: RC4 40 and 128 bit, AES 128 and 256, a wrong one, non-ASCII ones ----
  await page.setInputFiles('#p2p-file', fx('locked-aes-256.pdf'));
  await page.waitForSelector('#p2p-unlock:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2p-pw');
  assert.equal(await text('#p2p-status'), 'locked-aes-256.pdf is protected with a password. Enter the password that opens it.');
  await page.click('#p2p-pw-go');
  assert.deepEqual(await fieldError('p2p-pw'), { text: 'Type the password first.', invalid: 'true', linked: true });
  await page.fill('#p2p-pw', 'парол');
  await page.press('#p2p-pw', 'Enter');
  await page.waitForFunction(() => /not right/.test(document.getElementById('p2p-pw-error').textContent));
  assert.deepEqual(await fieldError('p2p-pw'), { text: 'That password is not right. Check it and try again.', invalid: 'true', linked: true });
  // café€ on RC4 128: PDF.js reads each character's low byte, which is wrong for the euro sign, so the
  // page tries PDFDocEncoding (where it is 0xA0) once more.
  for (const [file, pw] of [['locked-aes-256.pdf', 'пароль'], ['locked-rc4-40.pdf', 'sesame40'], ['locked-rc4-128.pdf', 'pässwort'], ['locked-aes-128.pdf', 'open sesame'],
    ['locked-rc4-128-euro.pdf', 'café€']]) {
    if (file !== 'locked-aes-256.pdf') {
      await page.setInputFiles('#p2p-file', fx(file));
      await page.waitForFunction(f => document.getElementById('p2p-pw-label').textContent === 'Password for ' + f && !document.getElementById('p2p-unlock').hidden, file);
    }
    await page.fill('#p2p-pw', pw);
    await page.press('#p2p-pw', 'Enter');
    await page.waitForFunction(f => document.getElementById('p2p-status').textContent === f + ' is open: 1 page, unlocked.' || /not right/.test(document.getElementById('p2p-pw-error').textContent), file);
    assert.equal(await text('#p2p-status'), file + ' is open: 1 page, unlocked.', `${file} opens with ${pw}`);
    assert.match(await text('#p2p-meta'), /^1 page · [\d.]+\u00a0KB · unlocked$/);
    out = await save();
    assert.equal(out.name, file.replace('.pdf', '-page-1.png'));
    img = png(out.buf);
    assert.deepEqual([img.w, img.h], [595, 842], file);
    assert.ok(gridOf(img).flat().some(c => c[0] < 200), `${file}: the text is drawn`);
  }
  // An owner password only, forbidding printing and copying: converted without asking.
  await openPdf(fx('restricted.pdf'), 1);
  assert.equal(await page.isVisible('#p2p-unlock'), false);
  assert.ok(gridOf(png((await save()).buf)).flat().some(c => c[0] < 200), 'the restricted page is drawn');

  // ---- pages.pdf: a size for every page, at a DPI or a width ----
  await page.selectOption('#p2p-size', '300');
  await openPdf(fx('pages.pdf'), 4);
  await page.waitForFunction(() => [...document.querySelectorAll('.p2p-info')].every(e => e.textContent));
  assert.equal(await page.inputValue('#p2p-pages'), '1-4');
  assert.equal(await plan(), 'All 4 pages to PNG at 300 DPI. Page 1 becomes 2,480 × 3,508 pixels.');
  assert.equal(await text('#p2p-go'), 'Convert 4 pages to PNG');
  const sized = dpi => exp.sizes[dpi].map(([w, h]) => `${w} × ${h} px`);
  // Inherited /Rotate 270, a crop box and /UserUnit 2 give these sizes.
  assert.deepEqual(await infos(), sized(300));
  await page.selectOption('#p2p-size', '150');
  assert.deepEqual(await infos(), sized(150));
  await page.selectOption('#p2p-size', 'w1920');
  assert.deepEqual(await infos(), exp.width1920.map(([w, h]) => `${w} × ${h} px`));
  assert.equal(await plan(), 'All 4 pages to PNG, 1,920 pixels wide. Page 1 becomes 1,920 × 2,715 pixels.');
  await page.selectOption('#p2p-size', '72');
  assert.deepEqual(await infos(), sized(72));
  out = await save();
  assert.equal(out.name, 'pages-png.zip');
  assert.match(await text('#p2p-status'), /^Saved pages-png\.zip with 4 PNG images, [\d.]+\u00a0KB\.$/);
  let entries = unzip(out.buf);
  assert.deepEqual(entries.map(e => e.name), ['pages-page-1.png', 'pages-page-2.png', 'pages-page-3.png', 'pages-page-4.png']);
  for (let i = 0; i < 4; i++) {
    const p = png(entries[i].data);
    assert.deepEqual([p.w, p.h], exp.sizes['72'][i], `page ${i + 1} size`);
    assert.equal(p.type, 2, 'an opaque page is an RGB PNG, the browser\'s own');
    assert.ok(p.phys, `page ${i + 1} has a pHYs chunk`);
    assert.deepEqual([p.phys.x, p.phys.y, p.phys.unit, p.physFirst], [2835, 2835, 1, true], 'pHYs says 72 DPI, before the image data');
    const diff = gridDiff(gridOf(p), exp.poppler.pages[String(i + 1)].grid);
    assert.ok(diff.mean < 3 && diff.max < 40, `page ${i + 1} looks as poppler draws it (mean ${diff.mean.toFixed(2)}, max ${diff.max.toFixed(1)})`);
  }
  // Each page can be downloaded on its own, byte for byte as in the ZIP; a double click saves it once.
  assert.match(await page.getAttribute('.p2p-page:nth-child(2) .p2p-dl', 'aria-label'), /^Download page 2 as PNG, [\d.]+\u00a0KB$/);
  let count = 0;
  const counter = () => count++;
  page.on('download', counter);
  const [single] = await Promise.all([page.waitForEvent('download'), page.dblclick('.p2p-page:nth-child(2) .p2p-dl')]);
  assert.equal(single.suggestedFilename(), 'pages-page-2.png');
  assert.ok(fs.readFileSync(await single.path()).equals(entries[1].data));
  await page.waitForTimeout(500);
  assert.equal(count, 1, 'a double click on Download saves the page once');
  // Converting again with the same settings reuses the images; a double click on Convert saves once.
  count = 0;
  await page.evaluate(() => {
    window.__drawn = 0;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) { if (this.width > 400) window.__drawn++; return getContext.apply(this, a); };
    window.__undo = () => { HTMLCanvasElement.prototype.getContext = getContext; };
  });
  await page.dblclick('#p2p-go');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('p2p-status').textContent));
  await page.waitForTimeout(500);
  assert.equal(count, 1, 'a double click on Convert saves once');
  assert.equal(await page.evaluate(() => { window.__undo(); return window.__drawn; }), 0, 'pages converted with the same settings are not drawn again');
  page.off('download', counter);

  // A width: every page gets it, and its DPI goes into pHYs.
  await page.selectOption('#p2p-size', 'w1920');
  await page.fill('#p2p-pages', '1, 3');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => [e.name, png(e.data).w, png(e.data).h]), [['pages-page-1.png', ...exp.width1920[0]], ['pages-page-3.png', ...exp.width1920[2]]]);
  assert.equal(png(entries[0].data).phys.x, ppm(72 * 1920 / 595.28), 'A4 at 1920 pixels wide is 232 DPI');
  // Other DPI and other width: typed values and mistakes. Only digits make a number: a thousands
  // separator, a decimal comma or point, a raised digit or a tab inside is refused, not read as 1920 or 3.
  await page.selectOption('#p2p-size', 'width');
  assert.equal(await page.isVisible('#p2p-width'), true);
  assert.equal(await page.isVisible('#p2p-dpi'), false);
  for (const [value, message] of [['1,920', 'Enter the width as a whole number of pixels, such as 1920.'], ['1.920', 'Enter the width as a whole number of pixels, such as 1920.'],
    ['19\t20', 'Enter the width as a whole number of pixels, such as 1920.'], ['3²', 'Enter the width as a whole number of pixels, such as 1920.'],
    ['15', 'Enter a width from 16 to 16,000 pixels.'], ['16001', 'Enter a width from 16 to 16,000 pixels.'], ['', 'Enter a width from 16 to 16,000 pixels.'],
    ['0,500', 'Enter the width as a whole number of pixels, such as 1920.']]) {
    await page.$eval('#p2p-width', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await page.waitForFunction(() => document.getElementById('p2p-width-error').textContent !== '');
    assert.deepEqual(await fieldError('p2p-width'), { text: message, invalid: 'true', linked: true }, JSON.stringify(value));
    assert.equal(await plan(), '');
    assert.equal(await text('#p2p-go'), 'Convert');
  }
  await page.click('#p2p-go');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2p-width', 'Convert with a mistake goes to the field');
  await page.fill('#p2p-width', '٣٠٠');
  assert.deepEqual(await fieldError('p2p-width'), { text: '', invalid: null, linked: true }, 'Arabic-Indic digits are read');
  assert.deepEqual((await infos())[0], '300 × 424 px');
  // A megabyte pasted into a field is answered at once, and kept.
  for (const [id, filler, pattern] of [['p2p-width', '9', /^Enter the width as a whole number/], ['p2p-pages', '2, ', /^This list is 1,04\d,\d{3} characters long\./]]) {
    const big = filler.repeat(Math.ceil(1048576 / filler.length));
    await page.$eval('#' + id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, big);
    await page.waitForFunction(id => document.getElementById(id + '-error').textContent !== '', id);
    assert.match((await fieldError(id)).text, pattern);
    assert.equal(await page.$eval('#' + id, el => el.value.length), big.length, 'what was typed is kept');
  }
  await page.fill('#p2p-pages', '1-4');
  await page.selectOption('#p2p-size', 'dpi');
  for (const [value, message] of [['5', 'Enter a resolution from 10 to 1200 DPI.'], ['1201', 'Enter a resolution from 10 to 1200 DPI.'], ['150.5', 'Enter a whole number of DPI from 10 to 1200.']]) {
    await page.fill('#p2p-dpi', value);
    await page.waitForFunction(() => document.getElementById('p2p-dpi-error').textContent !== '');
    assert.deepEqual(await fieldError('p2p-dpi'), { text: message, invalid: 'true', linked: true }, value);
  }
  await page.fill('#p2p-dpi', '１００');
  assert.equal(await plan(), 'All 4 pages to PNG at 100 DPI. Page 1 becomes 827 × 1,169 pixels.', 'full-width digits are read');
  // Back or Forward can put earlier values into the controls after the script ran: pageshow redraws.
  await page.$eval('#p2p-size', el => { el.value = '150'; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await page.isVisible('#p2p-dpi'), false);
  assert.equal(await plan(), 'All 4 pages to PNG at 150 DPI. Page 1 becomes 1,240 × 1,754 pixels.');

  // ---- Copy image: one page on the clipboard, made inside the click ----
  const clipboardPng = () => page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const b = await items[0].getType('image/png');
    return btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer())));
  }).then(b64 => png(Buffer.from(b64, 'base64')));
  assert.equal(await page.isVisible('#p2p-copy'), false, 'Copy image is offered for one page only');
  await page.selectOption('#p2p-size', '72');
  await page.fill('#p2p-pages', '3');
  assert.equal(await page.isVisible('#p2p-copy'), true);
  assert.equal(await page.getAttribute('#p2p-copy', 'aria-label'), 'Copy image of page 3');
  await page.evaluate(() => navigator.clipboard.writeText('old'));
  await page.click('#p2p-copy');
  await page.waitForFunction(() => /^Copied page 3/.test(document.getElementById('p2p-status').textContent));
  assert.equal(await text('#p2p-status'), 'Copied page 3 as an image of 300 × 200 pixels. Paste it where you need it.');
  let clip = await clipboardPng();
  const page3 = png((await save('.p2p-page:nth-child(3) .p2p-dl')).buf);
  assert.deepEqual([clip.w, clip.h], [300, 200]);
  assert.ok(psnr(clip.px, page3.px) > 45, 'the clipboard holds the converted page');
  // A clipboard that refuses: a message, and the status line does not keep "Converting".
  await page.selectOption('#p2p-colours', 'grey');
  await page.evaluate(() => {
    navigator.clipboard.write = async items => { await items[0].getType('image/png'); throw new DOMException('Write blocked', 'NotAllowedError'); };
  });
  await page.click('#p2p-copy');
  await page.waitForFunction(() => document.getElementById('p2p-error').textContent !== '');
  assert.equal(await text('#p2p-error'), 'The image could not be copied. The browser did not allow it: click the page first, then try again.');
  assert.equal(await text('#p2p-status'), '');
  await page.selectOption('#p2p-colours', 'exact');

  // ---- Background and Trim margins, on a logo that paints its page white ----
  await openPdf(fx('logo.pdf'), 1);
  await page.selectOption('#p2p-size', '150');
  const exact = png((await save()).buf);
  assert.deepEqual([exact.w, exact.h], [625, 417]);
  await page.check('#p2p-trim');
  assert.equal(await plan(), 'The page to PNG at 150 DPI, margins trimmed. Page 1 becomes 625 × 417 pixels before trimming.');
  const [bx, by, bw, bh] = exp.logo_box;
  let trimmed = png((await save()).buf);
  assert.ok(Math.abs(trimmed.w - bw) <= 2 && Math.abs(trimmed.h - bh) <= 2, `trimmed to the ink as poppler finds it: ${trimmed.w} × ${trimmed.h}, poppler ${bw} × ${bh}`);
  assert.equal(trimmed.type, 2, 'a trimmed opaque page stays an RGB PNG');
  assert.equal(trimmed.phys.x, ppm(150), 'and keeps its DPI');
  // Trimmed means every pixel is the full page's, from a box near the one poppler finds.
  let cutAt = null;
  for (let dy = -3; dy <= 3 && !cutAt; dy++) for (let dx = -3; dx <= 3 && !cutAt; dx++) {
    let ok = bx + dx >= 0 && by + dy >= 0;
    for (let y = 0; y < trimmed.h && ok; y++) {
      const a = trimmed.px.subarray(y * trimmed.w * 4, (y + 1) * trimmed.w * 4), at = ((y + by + dy) * exact.w + bx + dx) * 4;
      if (!a.equals(exact.px.subarray(at, at + trimmed.w * 4))) ok = false;
    }
    if (ok) cutAt = [dx, dy];
  }
  assert.ok(cutAt, 'the trimmed image is a cut-out of the page, pixel for pixel');
  // Transparent background: this page paints itself white, so nothing is clear and nothing is trimmed.
  await background('clear');
  img = png((await save()).buf);
  assert.deepEqual([img.w, img.h, img.type], [625, 417, 6]);
  assert.equal(img.at(5, 5)[3], 255, 'painted white stays white');
  // Make white transparent: white goes clear, grey becomes half-clear black, pink a clear red, soft edges kept.
  await page.uncheck('#p2p-trim');
  await background('nowhite');
  assert.equal(await plan(), 'The page to PNG at 150 DPI, white made transparent. Page 1 becomes 625 × 417 pixels.');
  img = png((await save()).buf);
  assert.deepEqual([img.w, img.h, img.type], [625, 417, 6]);
  const pt = (x, y) => [Math.round(x * 150 / 72), Math.round(y * 150 / 72)];
  assert.equal(img.at(...pt(150, 30))[3], 0, 'white is clear');
  near(img.at(...pt(40, 40)), [0, 0, 0, 127], 1, 'grey 128 is black at half opacity');
  near(img.at(...pt(100, 40)), [255, 0, 0, 51], 1, 'pink 255, 204, 204 is red at 20%');
  // The disc, RGB 26, 51, 128, is lighter than black too: laid over white it must look the same, so it
  // becomes 0, 28, 114 at alpha 229 (229 = 255 - 26, its darkest channel taken from white).
  near(img.at(...pt(200, 110)), [0, 28, 114, 229], 2, 'a dark colour keeps most of its opacity');
  let worst = 0, partial = 0;
  for (let i = 0; i < img.px.length; i += 4) {
    const a = img.px[i + 3];
    if (a > 0 && a < 255) partial++;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(img.px[i + c] * a / 255 + 255 - a - exact.px[i + c]));
  }
  assert.ok(worst <= 2, `laid over white it is the page again (worst ${worst.toFixed(2)})`);
  assert.ok(partial > 1000, `the soft edges are partly see-through (${partial} pixels)`);
  await page.check('#p2p-trim');
  trimmed = png((await save()).buf);
  assert.ok(Math.abs(trimmed.w - bw) <= 2 && Math.abs(trimmed.h - bh) <= 2, `white made clear, then trimmed: ${trimmed.w} × ${trimmed.h}`);
  // Trim and a width: the trimmed image gets exactly that width.
  await page.selectOption('#p2p-size', 'w1080');
  assert.equal(await plan(), 'The page to PNG, trimmed and then 1,080 pixels wide, white made transparent.');
  assert.equal(await text('.p2p-info'), '1,080 px wide after trimming');
  img = png((await save()).buf);
  assert.equal(img.w, 1080);
  assert.ok(Math.abs(img.h - Math.round(1080 * bh / bw)) <= 4, `${img.h} high for a ${bw} × ${bh} box`);
  // Its DPI is what makes the logo, 230 points wide, 1080 pixels wide: about 1080 / (bw / 150).
  assert.ok(Math.abs(img.phys.x - ppm(1080 * 150 / bw)) / img.phys.x < 0.01, `pHYs ${img.phys.x}, about ${ppm(1080 * 150 / bw)}`);
  await background('white');
  img = png((await save()).buf);
  assert.deepEqual([img.w, img.type], [1080, 2]);
  // A blank page is not trimmed to nothing.
  await openPdf({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>']) }, 1);
  await page.selectOption('#p2p-size', '72');
  img = png((await save()).buf);
  assert.deepEqual([img.w, img.h], [200, 100]);
  assert.match(await text('#p2p-status'), /^Saved blank-page-1\.png: 200 × 100 pixels, [\d.]+\u00a0B\. Page 1 is blank, so it was not trimmed\.$/);
  await page.uncheck('#p2p-trim');

  // ---- Colours: Exact, 256, greyscale, black and white, on a page with pictures and text ----
  await openPdf(fx('pictures.pdf'), 3);
  await page.selectOption('#p2p-size', '72');
  await page.fill('#p2p-pages', '1');
  const ref = png((await save()).buf);
  assert.ok(gridDiff(gridOf(ref), exp.poppler.pictures.grid).mean < 4, 'the page of pictures looks as poppler draws it');
  // Where pictures are drawn (with 4 pixels to spare); dithering happens only there.
  const boxes = Object.values(exp.picture_box).map(([x0, y0, x1, y1]) => [x0 * ref.w - 4, y0 * ref.h - 4, x1 * ref.w + 4, y1 * ref.h + 4]);
  const inPicture = (x, y) => boxes.some(b => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
  await page.selectOption('#p2p-colours', 'grey');
  assert.equal(await plan(), 'Page 1 to PNG at 72 DPI, greyscale. Page 1 becomes 612 × 792 pixels.');
  out = await save();
  img = png(out.buf);
  assert.equal(img.type, 3, 'an indexed PNG');
  assert.equal(img.phys.x, 2835, 'with its DPI');
  let wrong = 0;
  for (let i = 0; i < img.px.length; i += 4) {
    const l = luma(ref.px[i], ref.px[i + 1], ref.px[i + 2]);
    if (img.px[i] !== l || img.px[i + 1] !== l || img.px[i + 2] !== l) wrong++;
  }
  assert.equal(wrong, 0, 'every pixel is the Rec. 601 grey of the page, as Pillow computes it');
  await page.selectOption('#p2p-colours', 'bw');
  img = png((await save()).buf);
  assert.deepEqual([img.type, img.depth, img.palette], [3, 1, 2], 'one bit a pixel');
  wrong = 0;
  let dots = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4, v = img.px[i];
    assert.ok(v === 0 || v === 255);
    if (inPicture(x, y)) continue;
    if (v !== (luma(ref.px[i], ref.px[i + 1], ref.px[i + 2]) >= 128 ? 255 : 0)) wrong++;
  }
  assert.equal(wrong, 0, 'outside the pictures, grey 128 or more is white: text is not dithered');
  const [jx0, jy0, jx1, jy1] = exp.picture_box.jpeg.map((v, k) => Math.round(v * (k % 2 ? ref.h : ref.w)));
  for (let y = jy0 + 4; y < jy1 - 4; y++) for (let x = jx0 + 4; x < jx1 - 4; x++) {
    const i = (y * img.w + x) * 4;
    if (img.px[i] !== (luma(ref.px[i], ref.px[i + 1], ref.px[i + 2]) >= 128 ? 255 : 0)) dots++;
  }
  assert.ok(dots > 500, `the photo is dithered into dots (${dots} pixels differ from a plain threshold)`);
  await page.selectOption('#p2p-colours', '256');
  const pal = png((await save()).buf);
  assert.ok(pal.type === 3 && pal.palette <= 256, `at most 256 colours (${pal.palette})`);
  assert.ok(psnr(ref.px, pal.px) > 30, `close to the page (${psnr(ref.px, pal.px).toFixed(1)} dB)`);
  // Outside the pictures every colour of the page always becomes the same colour; in the gradient photo
  // the same colour becomes different ones: it is dithered there only.
  const outside = new Map(), inside = new Map();
  for (let y = 0; y < pal.h; y++) for (let x = 0; x < pal.w; x++) {
    const i = (y * pal.w + x) * 4, from = ref.px.readUInt32BE(i), to = pal.px.readUInt32BE(i);
    const m = inPicture(x, y) ? (x >= jx0 + 4 && x < jx1 - 4 && y >= jy0 + 4 && y < jy1 - 4 ? inside : null) : outside;
    if (!m) continue;
    if (!m.has(from)) m.set(from, new Set());
    m.get(from).add(to);
  }
  assert.ok([...outside.values()].every(s => s.size === 1), 'text and drawings are not dithered');
  assert.ok([...inside.values()].some(s => s.size > 1), 'the photo is dithered');
  await page.selectOption('#p2p-colours', 'exact');

  // ---- Pictures in the PDF, each at its own pixel size ----
  await page.fill('#p2p-pages', '1-3');
  await what('pictures');
  assert.equal(await page.isVisible('#p2p-size'), false, 'no size for pictures');
  assert.equal(await page.isVisible('#p2p-bg-field'), false);
  assert.equal(await plan(), 'The pictures on all 3 pages, saved as PNG files at their own size.');
  assert.equal(await text('#p2p-go'), 'Save the pictures of 3 pages');
  out = await save();
  assert.equal(out.name, 'pictures-pictures.zip');
  assert.match(await text('#p2p-status'), /^Saved pictures-pictures\.zip with 5 pictures from 1 page, [\d.]+\u00a0KB\. A picture that appears more than once is saved once\.$/);
  entries = unzip(out.buf);
  // The stencil mask (a shape painted in one colour) and the 4 x 4 image are not pictures; page 2's
  // picture is page 1's first one again.
  assert.deepEqual(entries.map(e => e.name), [1, 2, 3, 4, 5].map(k => `pictures-page-1-picture-${k}.png`));
  exp.pictures.forEach((want, k) => {
    const got = png(entries[k].data), wpx = Buffer.from(want.rgba, 'base64');
    assert.deepEqual([got.w, got.h], [want.w, want.h], `${want.kind}: its own size`);
    assert.equal(got.phys, null, 'a picture has no page DPI');
    if (want.kind === 'jpeg') {
      let sum = 0;
      for (let i = 0; i < wpx.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(got.px[i + c] - wpx[i + c]);
      assert.ok(sum / (wpx.length * 3 / 4) < 3, `the JPEG decodes as libjpeg does (mean difference ${(sum / (wpx.length * 3 / 4)).toFixed(2)})`);
    } else if (want.kind === 'masked') {
      assert.equal(got.type, 6, 'a picture with a soft mask keeps its alpha');
      for (let i = 0; i < wpx.length; i += 4) {
        assert.ok(Math.abs(got.px[i + 3] - wpx[i + 3]) <= 1, `alpha at ${i / 4}`);
        if (wpx[i + 3] >= 128) near(got.px.subarray(i, i + 3), [20, 120, 220], 2, 'colour of the masked picture');
      }
    } else {
      assert.equal(got.type, 2, `${want.kind}: an opaque picture is an RGB PNG`);
      assert.ok(got.px.equals(wpx), `${want.kind}: every pixel as stored in the PDF`);
    }
  });
  const pictureInfos = await infos();
  assert.ok(/^5 pictures · [\d.]+\u00a0KB$/.test(pictureInfos[0]) && /^1 picture · [\d.]+\u00a0(B|KB)$/.test(pictureInfos[1]) && pictureInfos[2] === 'No pictures', JSON.stringify(pictureInfos));
  assert.deepEqual(await page.$$eval('.p2p-dl', l => l.map(b => b.hidden)), [false, false, true], 'a page without pictures has nothing to download');
  assert.match(await page.getAttribute('.p2p-page:nth-child(1) .p2p-dl', 'aria-label'), /^Download the 5 pictures on page 1, [\d.]+\u00a0KB$/);
  let one = await save('.p2p-page:nth-child(1) .p2p-dl');
  assert.equal(one.name, 'pictures-page-1-pictures.zip');
  assert.deepEqual(unzip(one.buf).map(e => e.data.length), entries.map(e => e.data.length));
  one = await save('.p2p-page:nth-child(2) .p2p-dl');
  assert.equal(one.name, 'pictures-page-2-picture-1.png');
  assert.ok(one.buf.equals(entries[0].data), 'the same picture on page 2');
  assert.equal(await page.isVisible('.p2p-page:nth-child(2) .p2p-copy'), true, 'one picture can be copied');
  assert.equal(await page.isVisible('.p2p-page:nth-child(1) .p2p-copy'), false, 'five cannot');
  await page.evaluate(() => { delete navigator.clipboard.write; });
  await page.click('.p2p-page:nth-child(2) .p2p-copy');
  await page.waitForFunction(() => document.getElementById('p2p-status').textContent === 'Copied the picture on page 2 as an image of 64 × 48 pixels.');
  clip = await clipboardPng();
  assert.ok(clip.px.equals(Buffer.from(exp.pictures[0].rgba, 'base64')), 'the clipboard holds the picture');
  await page.fill('#p2p-pages', '3');
  await page.click('#p2p-go');
  await page.waitForFunction(() => /^No pictures/.test(document.getElementById('p2p-status').textContent));
  assert.equal(await text('#p2p-status'), 'No pictures were found on page 3. Text and drawings made of lines are not pictures: save them as whole pages.');
  await page.fill('#p2p-pages', '1');
  await page.selectOption('#p2p-colours', 'grey');
  entries = unzip((await save()).buf);
  img = png(entries[0].data);
  assert.equal(img.type, 3);
  const rgb = Buffer.from(exp.pictures[0].rgba, 'base64');
  for (let i = 0; i < rgb.length; i += 4) assert.equal(img.px[i], luma(rgb[i], rgb[i + 1], rgb[i + 2]), 'a greyscale picture');
  await page.selectOption('#p2p-colours', 'exact');
  await what('pages');
  assert.equal(await page.inputValue('#p2p-size'), '72', 'the page settings are kept while pictures are chosen');

  // ---- The keyboard: the pages are one tab stop, arrows move, Space picks, Enter converts ----
  await openPdf(fx('pages.pdf'), 4);
  await page.focus('#p2p-another');
  await page.keyboard.press('Tab');
  for (let i = 0; i < 20 && !(await page.evaluate(() => document.activeElement.classList.contains('p2p-check'))); i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 1');
  assert.deepEqual(await page.$$eval('.p2p-check', l => l.map(c => c.tabIndex)), [0, -1, -1, -1]);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 2');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.closest('.p2p-page')).outlineStyle), 'solid', 'the focused page shows a ring');
  await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#p2p-pages'), '1, 3-4');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Page 4');
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#p2p-pages'), '3');
  const cols = await page.$$eval('.p2p-page', l => l.filter(e => e.offsetTop === l[0].offsetTop).length);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), cols < 4 ? `Page ${1 + cols}` : 'Page 1', 'down moves by a row');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('p2p-check')), true, 'Tab comes back to the page last used');
  const [dlKey] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(dlKey.suggestedFilename(), 'pages-page-3.png');
  // Choose another PDF from the keyboard: Enter and Space on the focused button open the file chooser
  // (the click on the hidden file input is what the page does; the dialog is the browser's, and under
  // Playwright it opens only now and then once setInputFiles has been used, on PDF to JPG alike).
  await page.evaluate(() => { window.__chooser = 0; document.getElementById('p2p-file').addEventListener('click', () => window.__chooser++); });
  for (const key of ['Enter', 'Space']) {
    await page.focus('#p2p-another');
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => window.__chooser), key === 'Enter' ? 1 : 2, `${key} on Choose another PDF opens the file chooser`);
  }
  await page.setInputFiles('#p2p-file', fx('logo.pdf'));
  await page.waitForFunction(() => document.getElementById('p2p-name').textContent === 'logo.pdf');

  // ---- Cancel, a page too large, a background tab, the memory limit ----
  await openPdf(fx('pages.pdf'), 4);
  await page.selectOption('#p2p-size', '300');
  const during = await page.evaluate(() => {
    document.getElementById('p2p-go').click();
    const els = [...document.querySelectorAll('#p2p-go, #p2p-another, #p2p-size, #p2p-colours, #p2p-trim, #p2p-dpi, #p2p-width, #p2p-pages, input[name="p2p-what"], input[name="p2p-bg"], [data-pick], .p2p-check')];
    const off = els.filter(e => e.disabled).length;
    document.getElementById('p2p-cancel').click();
    return { off, all: els.length };
  });
  assert.equal(during.off, during.all, 'the controls are disabled while converting');
  await page.waitForFunction(() => /^Cancelled\./.test(document.getElementById('p2p-status').textContent));
  assert.equal(await page.isDisabled('#p2p-go'), false);
  // In a tab that is hidden the conversion carries on and ends.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.selectOption('#p2p-size', '72');
  await page.selectOption('#p2p-colours', '256');
  out = await save();
  assert.equal(unzip(out.buf).length, 4, 'a hidden tab still converts every page');
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
  await page.selectOption('#p2p-colours', 'exact');
  // The images of one conversion are kept in memory: past 1.5 GB (simulated by their reported size)
  // the rest are left, with a message, and what was made is saved.
  await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(Blob.prototype, 'size');
    Object.defineProperty(Blob.prototype, 'size', { configurable: true, get() { return this.type === 'image/png' ? 1000 * 1048576 : d.get.call(this); } });
    window.__restoreSize = () => Object.defineProperty(Blob.prototype, 'size', d);
  });
  await page.selectOption('#p2p-size', '96');
  out = await save();
  await page.evaluate(() => window.__restoreSize());
  assert.deepEqual(unzip(out.buf).map(e => e.name), ['pages-page-1.png', 'pages-page-2.png']);
  assert.equal(await text('#p2p-error'), 'Pages 3–4 were not converted: the images already made take 2000.0\u00a0MB, as much as this device can safely hold at once. Convert them separately.');
  // A page of 200 x 200 inches gets the most pixels one image can have here: 64 million.
  await openPdf({ name: 'poster.pdf', mimeType: 'application/pdf', buffer: rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] /Contents 4 0 R >>', '<< /Length 22 >>\nstream\n0 g 0 0 14400 14400 re f\nendstream']) }, 1);
  await page.selectOption('#p2p-size', '300');
  assert.equal(await plan(), 'The page to PNG at 300 DPI. Page 1 becomes 8,000 × 8,000 pixels, at 40 DPI as it is very large.');
  await page.selectOption('#p2p-size', 'w3840');
  assert.equal(await plan(), 'The page to PNG, 3,840 pixels wide. Page 1 becomes 3,840 × 3,840 pixels.');

  // ---- 1,000 pages: thumbnails are drawn only as they come into view ----
  await openPdf({ name: 'thousand.pdf', mimeType: 'application/pdf', buffer: manyPages(1000) }, 1000);
  assert.equal(await page.inputValue('#p2p-pages'), '1-1000');
  await page.waitForTimeout(1000);
  const drawnThumbs = await page.$$eval('.p2p-thumb img[src]', l => l.length);
  assert.ok(drawnThumbs < 100, `${drawnThumbs} thumbnails drawn, not 1,000`);
  await page.selectOption('#p2p-size', '72');
  await page.click('#p2p-go');
  await page.waitForFunction(() => { const m = /\((\d+) of 1000\)/.exec(document.getElementById('p2p-pct').textContent); return m && Number(m[1]) >= 3; });
  await page.click('#p2p-cancel');
  assert.match(await text('#p2p-status'), /^Cancelled\. \d+ pages? (is|are) ready to download one by one below\.$/);
  await page.fill('#p2p-pages', '998-1000');
  entries = unzip((await save()).buf);
  assert.deepEqual(entries.map(e => e.name), ['thousand-page-0998.png', 'thousand-page-0999.png', 'thousand-page-1000.png'], 'names sort: page 998 is 0998');
  assert.deepEqual([png(entries[0].data).w, png(entries[0].data).h], [144, 144]);

  // ---- A 100 MB file: an update appended to pages.pdf adds a 100 MB stream no page uses ----
  const small = fs.readFileSync(fx('pages.pdf')), tail = small.toString('latin1');
  const trailer = tail.slice(tail.lastIndexOf('trailer')), root = /\/Root (\d+ \d+ R)/.exec(trailer)[1], size = Number(/\/Size (\d+)/.exec(trailer)[1]);
  const prev = Number(/startxref\s+(\d+)/.exec(tail.slice(tail.lastIndexOf('startxref')))[1]);
  const big = path.join(os.tmpdir(), `pdf-to-png-big-${process.pid}.pdf`);
  const MB100 = 100 * 1048576, objAt = small.length + 1;
  const head = Buffer.from(`\n${size} 0 obj\n<< /Length ${MB100} >>\nstream\n`, 'latin1');
  const end = Buffer.from(`\nendstream\nendobj\n`, 'latin1');
  const xrefAt = objAt - 1 + head.length + MB100 + end.length;
  const xref = Buffer.from(`xref\n${size} 1\n${String(objAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1');
  const fd = fs.openSync(big, 'w');
  for (const part of [small, head]) fs.writeSync(fd, part);
  const zeros = Buffer.alloc(1048576, 0x41);
  for (let i = 0; i < 100; i++) fs.writeSync(fd, zeros);
  fs.writeSync(fd, end);
  fs.writeSync(fd, xref);
  fs.closeSync(fd);
  try {
    await page.setInputFiles('#p2p-file', big);
    await page.waitForFunction(() => /is open: 4 pages/.test(document.getElementById('p2p-status').textContent), null, { timeout: 60000 });
    assert.match(await text('#p2p-meta'), /^4 pages · 100\.\d\u00a0MB$/);
    await page.fill('#p2p-pages', '2');
    await page.selectOption('#p2p-size', '72');
    img = png((await save()).buf);
    assert.deepEqual([img.w, img.h], exp.sizes['72'][1]);
  } finally {
    fs.rmSync(big, { force: true });
  }

  // ---- Other structures: object and cross-reference streams, linearised, PDF 2.0, an incremental
  // update (its new text shows), forms, links, bookmarks, tags, attachments and a signature field ----
  for (const f of ['objstm.pdf', 'linear.pdf', 'v20.pdf']) {
    await openPdf(fx(f), 4);
    await page.fill('#p2p-pages', '2');
    const p2 = png((await save()).buf);
    assert.ok(gridDiff(gridOf(p2), exp.poppler.pages['2'].grid).mean < 3, `${f}: page 2 turned by its inherited /Rotate as poppler draws it`);
  }
  for (const [f, key] of [['incremental.pdf', 'incremental'], ['features.pdf', 'features']]) {
    await openPdf(fx(f), 1);
    const p1 = png((await save()).buf), diff = gridDiff(gridOf(p1), exp.poppler[key].grid);
    assert.ok(diff.mean < 3 && diff.max < 60, `${f} looks as poppler draws it (mean ${diff.mean.toFixed(2)}, max ${diff.max.toFixed(1)})`);
    if (key === 'features') {
      const [x0, y0, x1, y1] = exp.field.map((v, k) => Math.round(v * (k % 2 ? p1.h : p1.w)));
      let ink = 0;
      for (let y = y0 + 4; y < y1 - 4; y++) for (let x = x0 + 4; x < x1 - 4; x++) if (p1.at(x, y)[0] < 128) ink++;
      assert.ok(ink > 100, `the filled-in field's text is drawn (${ink} dark pixels)`);
    }
  }
  assert.ok((await page.evaluate(() => window.__writes.plan)).every((t, i, a) => i === 0 || t !== a[i - 1]), 'the summary is never written twice in a row');

  // ---- A phone with a touch screen, set to German, that can share files ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true, locale: 'de-DE', deviceScaleFactor: 2 });
  await phone.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = data => !!(data && data.files && data.files.every(f => f instanceof File));
    navigator.share = data => { window.__shared.push(data.files.map(f => [f.name, f.type, f.size])); return Promise.resolve(); };
  });
  const p2 = await phone.newPage();
  const errors = [];
  p2.on('pageerror', e => errors.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p2.goto(url);
  assert.equal(await p2.evaluate(() => (1.5).toLocaleString()), '1,5', 'the browser uses a decimal comma');
  await openPdf(fx('pages.pdf'), 4, p2);
  assert.equal(await p2.textContent('#p2p-plan'), 'All 4 pages to PNG at 300 DPI. Page 1 becomes 2,480 × 3,508 pixels.');
  await p2.selectOption('#p2p-size', 'dpi');
  await p2.fill('#p2p-dpi', '150,5');
  await p2.waitForFunction(() => document.getElementById('p2p-dpi-error').textContent !== '');
  assert.equal(await p2.textContent('#p2p-dpi-error'), 'Enter a whole number of DPI from 10 to 1200.', 'a decimal comma is not read as 1505 or 150');
  await p2.selectOption('#p2p-size', 'width');
  await p2.fill('#p2p-width', '1.920');
  await p2.waitForFunction(() => document.getElementById('p2p-width-error').textContent !== '');
  assert.equal(await p2.textContent('#p2p-width-error'), 'Enter the width as a whole number of pixels, such as 1920.', 'a German thousands point is not read');
  await p2.selectOption('#p2p-size', '72');
  // Nothing is cut off, and the targets are big enough, at common phone widths.
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p2.setViewportSize({ width, height: 844 });
    const cut = await p2.$$eval('.p2p-seg label, .p2p-quick .btn, #p2p-go, .p2p-file .btn, .p2p-bg .check, .p2p-trim', l => l.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim()));
    assert.deepEqual(cut, [], `no text cut off at ${width}px`);
    for (const sel of ['#p2p-size', '#p2p-colours']) {
      const tooLong = await p2.$eval(sel, s => {
        const cs = getComputedStyle(s), probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
        document.body.appendChild(probe);
        const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
        const long = [...s.options].filter(o => { probe.textContent = o.text; return probe.getBoundingClientRect().width > room; }).map(o => o.text);
        probe.remove();
        return long;
      });
      assert.deepEqual(tooLong, [], `${sel} choices fit at ${width}px`);
    }
    assert.ok(await p2.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px`);
  }
  await p2.setViewportSize({ width: 390, height: 844 });
  const small44 = await p2.$$eval('#p2p-go, .p2p-seg label, .p2p-bg .check, .p2p-trim, #p2p-size, #p2p-colours, .p2p-quick .btn, #p2p-another', l => l.filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.textContent.trim()));
  assert.deepEqual(small44, [], 'the controls are at least 44 px tall on a touch screen');
  // A tap picks a page; touch and hold, then a drag, picks several without scrolling the page.
  await p2.$eval('.p2p-page:nth-child(1)', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p2.tap('.p2p-page:nth-child(2) .p2p-thumb');
  assert.equal(await p2.inputValue('#p2p-pages'), '1, 3-4');
  const cdp = await phone.newCDPSession(p2);
  const t1 = await (await p2.$('.p2p-page:nth-child(1) .p2p-thumb')).boundingBox();
  const t3 = await (await p2.$('.p2p-page:nth-child(3) .p2p-thumb')).boundingBox();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const before = await p2.evaluate(() => scrollY);
  await touch('touchStart', t1.x + 30, t1.y + 40);
  await p2.waitForTimeout(700);
  for (let s = 1; s <= 6; s++) await touch('touchMove', t1.x + 30 + (t3.x - t1.x) * s / 6, t1.y + 40 + (t3.y - t1.y) * s / 6);
  await touch('touchEnd');
  assert.equal(await p2.inputValue('#p2p-pages'), '4', 'touch and hold on a picked page, then drag, drops pages 1 to 3');
  assert.equal(await p2.evaluate(() => scrollY), before, 'the page did not scroll during the drag');
  // A swipe that starts on a page scrolls the page and picks nothing.
  await touch('touchStart', t1.x + 30, t1.y + 40);
  for (let s = 1; s <= 5; s++) await touch('touchMove', t1.x + 30, t1.y + 40 - s * 20);
  await touch('touchEnd');
  assert.equal(await p2.inputValue('#p2p-pages'), '4', 'a swipe does not change the choice');
  // The swipe may glide on: wait until the page stands still.
  await p2.waitForFunction(() => new Promise(done => { const y = scrollY; setTimeout(() => done(scrollY === y), 300); }));
  assert.notEqual(await p2.evaluate(() => scrollY), before, 'the swipe scrolled the page, so the check above tested something');
  await p2.$eval('.p2p-page:nth-child(2)', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p2.tap('.p2p-page:nth-child(2) .p2p-thumb');
  // Convert with a tap; then Share offers the images, for Photos on an iPhone.
  assert.equal(await p2.isVisible('#p2p-share'), false);
  const [dlPhone] = await Promise.all([p2.waitForEvent('download'), p2.tap('#p2p-go')]);
  assert.equal(dlPhone.suggestedFilename(), 'pages-png.zip');
  const zipped = unzip(fs.readFileSync(await dlPhone.path()));
  await p2.waitForSelector('#p2p-share:not([hidden])');
  assert.equal(await p2.textContent('#p2p-share'), 'Share 2 images');
  await p2.tap('#p2p-share');
  assert.deepEqual(await p2.evaluate(() => window.__shared), [zipped.map(e => [e.name, 'image/png', e.data.length])], 'the files shared are the files saved');
  await p2.selectOption('#p2p-colours', 'grey');
  assert.equal(await p2.isVisible('#p2p-share'), false, 'images made with other settings are not offered');
  // A touch screen device gets at most 36 million pixels a page.
  await openPdf({ name: 'poster.pdf', mimeType: 'application/pdf', buffer: rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] >>']) }, 1, p2);
  await p2.selectOption('#p2p-size', '300');
  assert.equal(await p2.textContent('#p2p-plan'), 'The page to PNG at 300 DPI, greyscale. Page 1 becomes 6,000 × 6,000 pixels, at 30 DPI as it is very large.');
  // A long file name wraps at 320 px, in the password prompt and the results.
  const longName = 'Quarterly_report_final_version_with_all_appendices_and_signatures_reviewed_by_legal';
  await p2.setViewportSize({ width: 320, height: 640 });
  await p2.setInputFiles('#p2p-file', { name: longName + '.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('locked-aes-128.pdf')) });
  await p2.waitForSelector('#p2p-unlock:not([hidden])');
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 320), 'the password prompt fits at 320px');
  await p2.fill('#p2p-pw', 'open sesame');
  await p2.press('#p2p-pw', 'Enter');
  await p2.waitForFunction(name => document.getElementById('p2p-name').textContent === name, longName + '.pdf');
  await p2.selectOption('#p2p-size', '72');
  const [dlLong] = await Promise.all([p2.waitForEvent('download'), p2.tap('#p2p-go')]);
  assert.equal(dlLong.suggestedFilename(), longName + '-page-1.png');
  assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= 320), 'the results fit at 320px');
  assert.deepEqual(errors, []);
  await cdp.detach();
  await phone.close();
};
