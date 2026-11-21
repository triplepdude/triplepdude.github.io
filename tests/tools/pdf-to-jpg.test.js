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
  await page.setInputFiles('#p2j-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a pdf') });
  await page.waitForFunction(() => /notes\.txt is not a PDF file/.test(document.getElementById('p2j-error').textContent));
  await page.setInputFiles('#p2j-file', fx('damaged.pdf'));
  await page.waitForFunction(() => /damaged\.pdf is damaged or is not a valid PDF/.test(document.getElementById('p2j-error').textContent));
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
  await page.fill('#p2j-pw', 'open sesame');
  await page.press('#p2j-pw', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 1);
  assert.match(await text('#p2j-meta'), /^1 page · [\d.]+ KB · unlocked$/);
  assert.equal(await page.inputValue('#p2j-pages'), '1');
  assert.equal(await text('#p2j-go'), 'Convert page 1 to JPG');
  let out = await save();
  assert.equal(out.name, 'locked-page-1.jpg', 'one page is saved as an image, not a ZIP');
  let info = jpegInfo(out.buf);
  assert.deepEqual([info.soi, info.w, info.h], [true, 1240, 1754]);
  let img = await look(out.buf, 'image/jpeg', [{ x: 0.05, y: 0.05 }]);
  near(img.samples[0], [255, 255, 255], 3, 'the corner of the locked page is white');
  assert.ok(img.grid.flat().some(c => c[0] < 200), 'the text of the locked page is drawn');

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
  assert.match(await text('#p2j-status'), /^Saved pages-png\.zip with 3 PNG images, [\d.]+ KB\.$/);
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
  assert.match(await page.getAttribute('.p2j-page:nth-child(2) .p2j-dl', 'aria-label'), /^Download page 2 as PNG, [\d.]+ KB$/);
  let single = await save('.p2j-page:nth-child(2) .p2j-dl');
  assert.equal(single.name, 'pages-page-2.png');
  assert.ok(single.buf.equals(entries[1].data));
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
    ['1-2-3', 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.'], ['0,500', 'There is no page 0: the first page is 1.'], ['00000000004', 'Page 4 does not exist: this PDF has 3 pages.'],
    ['2\u200b3', 'A hidden character (U+200B) cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.']]) {
    await page.fill('#p2j-pages', value);
    await page.waitForFunction(() => document.getElementById('p2j-pages-error').textContent !== '');
    assert.deepEqual(await fieldError('p2j-pages'), { text: message, invalid: 'true', linked: true }, value);
  }
  await page.fill('#p2j-pages', '00000000002');
  assert.equal(await plan(), 'Page 2 to JPG at 150 DPI, quality 95. Page 2 becomes 1,650 × 1,275 pixels.', 'leading zeros do not make a number too long');
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
  await page.evaluate(() => { document.getElementById('p2j-go').click(); document.getElementById('p2j-cancel').click(); });
  await page.waitForFunction(() => /^Cancelled\./.test(document.getElementById('p2j-status').textContent));
  assert.equal(await page.isVisible('#p2j-progress'), false);
  assert.equal(await page.isDisabled('#p2j-go'), false);
  await page.setInputFiles('#p2j-file', fx('huge.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 1 && document.querySelector('.p2j-info').textContent);
  await page.selectOption('#p2j-dpi', '300');
  // 14,400 pt is 200 inches: 60,000 pixels a side at 300 DPI. Capped at 64 million pixels: 8,000 a side, 40 DPI.
  assert.equal(await plan(), 'The page to JPG at 300 DPI, quality 95. Page 1 becomes 8,000 × 8,000 pixels, at 40 DPI as it is very large.');
  assert.equal(await text('.p2j-info'), '8000 × 8000 pxat 40 DPI');
  out = await save();
  info = jpegInfo(out.buf);
  assert.deepEqual([info.w, info.h, info.units, info.xd], [8000, 8000, 1, 40]);
  assert.match(await text('#p2j-status'), /^Saved huge-page-1\.jpg: 8000 × 8000 pixels, [\d.]+ [KM]B\. Page 1 is too large for 300 DPI, so it was converted at 40 DPI, the most pixels one image can have here\.$/);
  img = await look(out.buf, 'image/jpeg', [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1 }], { resizeWidth: 240, resizeHeight: 240 });
  near(img.samples[0], [255, 255, 255], 8, 'white middle');
  near(img.samples[1], [0, 0, 0], 8, 'black edge');

  // ---- Fonts that are not embedded: the CMap and the Dingbats font come from this site ----
  const fetched = [];
  page.on('response', r => { if (/pdfjs-resources/.test(r.url())) fetched.push(r.status() + ' ' + r.url().replace(/^.*pdfjs-resources\//, '')); });
  await page.setInputFiles('#p2j-file', fx('fonts.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.p2j-page').length === 1);
  await page.selectOption('#p2j-dpi', '72');
  out = await save();
  assert.ok(fetched.includes('200 cmaps/UniJIS-UCS2-H.bcmap'), fetched.join());
  assert.ok(fetched.includes('200 standard_fonts/FoxitDingbats.pfb'), fetched.join());
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
  const [dlPhone] = await Promise.all([p2.waitForEvent('download'), p2.tap('#p2j-go')]);
  assert.equal(dlPhone.suggestedFilename(), 'pages-page-3.jpg');
  assert.deepEqual(errors, []);
  await phone.close();
};
