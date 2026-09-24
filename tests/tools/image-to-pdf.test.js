const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Independent PDF reader: follows startxref -> xref table -> objects, and checks
// every in-use xref offset lands exactly on "N 0 obj" (ISO 32000-1, 7.5.4).
function parsePdf(buf, assert) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.'), 'PDF header');
  assert.match(s, /%%EOF\s*$/, 'ends with %%EOF');
  const sx = s.lastIndexOf('startxref');
  assert.ok(sx > 0, 'has startxref');
  const xrefPos = parseInt(s.slice(sx + 9).trim(), 10);
  assert.equal(s.slice(xrefPos, xrefPos + 4), 'xref', 'startxref points at the xref table');
  const head = /^xref\r?\n(\d+) (\d+)\r?\n/.exec(s.slice(xrefPos));
  assert.ok(head, 'xref subsection header');
  const first = Number(head[1]), count = Number(head[2]);
  assert.equal(first, 0);
  let p = xrefPos + head[0].length;
  const offsets = {};
  for (let i = 0; i < count; i++, p += 20) {
    const entry = s.slice(p, p + 20);
    assert.match(entry, /^\d{10} \d{5} [nf](\r\n| \n| \r)$/, `xref entry ${i} is 20 bytes`);
    if (i === 0) { assert.equal(entry.slice(0, 18), '0000000000 65535 f'); continue; }
    if (entry[17] !== 'n') continue;
    const off = Number(entry.slice(0, 10));
    const tag = `${i} 0 obj`;
    assert.equal(s.slice(off, off + tag.length), tag, `xref offset of object ${i}`);
    offsets[i] = off;
  }
  const trailer = s.slice(p, sx);
  assert.match(trailer, /^trailer/);
  assert.equal(Number(/\/Size (\d+)/.exec(trailer)[1]), count, 'trailer /Size');
  const rootRef = Number(/\/Root (\d+) 0 R/.exec(trailer)[1]);

  function obj(n) {
    const off = offsets[n];
    assert.ok(off !== undefined, `object ${n} exists`);
    const start = s.indexOf('\n', off) + 1;
    const streamAt = s.indexOf('\nstream\n', start);
    const endAt = s.indexOf('\nendobj', start);
    if (streamAt !== -1 && streamAt < endAt) {
      const dict = s.slice(start, streamAt);
      const len = Number(/\/Length (\d+)/.exec(dict)[1]);
      const dataStart = streamAt + 8;
      assert.equal(s.slice(dataStart + len, dataStart + len + 10), '\nendstream', `stream ${n} /Length is exact`);
      return { dict, data: buf.subarray(dataStart, dataStart + len) };
    }
    return { dict: s.slice(start, endAt), data: null };
  }

  const catalog = obj(rootRef);
  assert.match(catalog.dict, /\/Type \/Catalog/);
  const pagesObj = obj(Number(/\/Pages (\d+) 0 R/.exec(catalog.dict)[1]));
  const kids = [.../\/Kids \[([^\]]*)\]/.exec(pagesObj.dict)[1].matchAll(/(\d+) 0 R/g)].map(m => Number(m[1]));
  assert.equal(Number(/\/Count (\d+)/.exec(pagesObj.dict)[1]), kids.length, '/Count matches /Kids');
  const pages = kids.map(k => {
    const pg = obj(k);
    assert.match(pg.dict, /\/Type \/Page\b/);
    const mediaBox = /\/MediaBox \[([^\]]+)\]/.exec(pg.dict)[1].trim().split(/\s+/).map(Number);
    const content = obj(Number(/\/Contents (\d+) 0 R/.exec(pg.dict)[1])).data.toString('latin1');
    const cm = /([-\d.\s]+) cm/.exec(content)[1].trim().split(/\s+/).map(Number);
    const imName = /\/(\w+) Do/.exec(content)[1];
    const imRef = Number(new RegExp('/' + imName + ' (\\d+) 0 R').exec(pg.dict)[1]);
    const im = obj(imRef);
    const num = key => Number(new RegExp('/' + key + ' (\\d+)').exec(im.dict)[1]);
    return {
      mediaBox, cm,
      image: {
        width: num('Width'), height: num('Height'),
        colorSpace: /\/ColorSpace \/(\w+)/.exec(im.dict)[1],
        filter: /\/Filter \/(\w+)/.exec(im.dict)[1],
        data: im.data,
      },
    };
  });
  return { pages, text: s };
}

// Reads width, height and component count from a JPEG's SOF marker.
function jpegInfo(b) {
  let i = 2;
  while (i < b.length) {
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), comps: b[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

const near = (assert, actual, expected, msg, tol = 0.002) => {
  assert.equal(actual.length, expected.length, msg);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tol, `${msg}: got [${actual}] expected [${expected}]`));
};

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  const fx = f => path.join(fixtures, f);
  const names = () => page.locator('#itp-list .itp-name').allTextContents();
  const makePdf = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#itp-make')]);
    const buf = fs.readFileSync(await dl.path());
    return { name: dl.suggestedFilename(), buf, pdf: parsePdf(buf, assert) };
  };

  assert.equal(await page.isDisabled('#itp-make'), true, 'nothing to convert yet');
  assert.equal(await page.locator('#itp-list .itp-item').count(), 0);

  await page.selectOption('#itp-size', 'a4');
  await page.selectOption('#itp-orient', 'auto');
  await page.selectOption('#itp-margin', '0');
  await page.selectOption('#itp-mode', 'jpeg');

  // A text file with a .png name is rejected with a friendly message; the rest are added.
  await page.setInputFiles('#itp-file', [fx('rot6.jpg'), fx('alpha.png'), fx('gray.jpg'), fx('not-an-image.png')]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 3);
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);
  assert.match(await page.textContent('#itp-error'), /not-an-image\.png/);
  assert.deepEqual(await names(), ['rot6.jpg', 'alpha.png', 'gray.jpg']);
  // The EXIF orientation 6 photo is stored 64x48 but displays upright as 48x64.
  assert.match(await page.locator('#itp-list .itp-dims').first().textContent(), /^48 × 64/);
  assert.equal(await page.inputValue('#itp-name'), 'rot6.pdf', 'file name follows the first image');
  assert.match(await page.textContent('#itp-summary'), /^3 images/);

  // Reorder with the buttons: first image later, then back.
  await page.locator('#itp-list .itp-down').first().click();
  assert.deepEqual(await names(), ['alpha.png', 'rot6.jpg', 'gray.jpg']);
  await page.locator('#itp-list .itp-up').nth(1).click();
  assert.deepEqual(await names(), ['rot6.jpg', 'alpha.png', 'gray.jpg']);
  assert.equal(await page.locator('#itp-list .itp-up').first().isDisabled(), true);
  assert.equal(await page.locator('#itp-list .itp-down').last().isDisabled(), true);
  // Keyboard reorder on the drag handle.
  await page.locator('#itp-list .itp-handle').nth(2).focus();
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await names(), ['rot6.jpg', 'gray.jpg', 'alpha.png']);
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await names(), ['rot6.jpg', 'alpha.png', 'gray.jpg']);

  await page.fill('#itp-name', 'my scans');
  let { name, buf, pdf } = await makePdf();
  assert.equal(name, 'my scans.pdf');
  assert.match(await page.textContent('#itp-status'), /3 pages/);
  assert.equal(pdf.pages.length, 3);
  assert.match(pdf.text, /\/Title <FEFF006D00790020007300630061006E0073>/, 'UTF-16 title "my scans"');

  // Page 1: the JPEG is embedded byte for byte, rotated by the matrix (EXIF 6), portrait A4.
  const rot6 = fs.readFileSync(fx('rot6.jpg'));
  let [p1, p2, p3] = pdf.pages;
  assert.ok(buf.indexOf(rot6) > 0, 'original JPEG bytes are embedded unchanged');
  assert.equal(Buffer.compare(p1.image.data, rot6), 0);
  assert.deepEqual([p1.image.width, p1.image.height, p1.image.colorSpace, p1.image.filter], [64, 48, 'DeviceRGB', 'DCTDecode']);
  near(assert, p1.mediaBox, [0, 0, 595.28, 841.89], 'A4 portrait');
  near(assert, p1.cm, [0, -793.707, 595.28, 0, 0, 817.798], 'orientation 6 matrix');

  // Page 2: transparent PNG flattened to a JPEG, landscape page because the image is wide.
  near(assert, p2.mediaBox, [0, 0, 841.89, 595.28], 'A4 landscape (auto)');
  near(assert, p2.cm, [793.707, 0, 0, 595.28, 24.092, 0], 'scaled to fit and centred');
  assert.equal(p2.image.filter, 'DCTDecode');
  assert.equal(p2.image.data.subarray(0, 2).toString('hex'), 'ffd8');
  assert.deepEqual(jpegInfo(p2.image.data), { width: 40, height: 30, comps: 3 });

  // Page 3: greyscale JPEG kept as DeviceGray.
  assert.equal(Buffer.compare(p3.image.data, fs.readFileSync(fx('gray.jpg'))), 0);
  assert.equal(p3.image.colorSpace, 'DeviceGray');
  near(assert, p3.cm, [595.28, 0, 0, 744.1, 0, 48.895], 'grey page placement');

  // Letter, forced landscape, 1/2 in margin, no enlarging, lossless PNG.
  await page.selectOption('#itp-size', 'letter');
  await page.selectOption('#itp-orient', 'landscape');
  await page.selectOption('#itp-margin', '36');
  await page.uncheck('#itp-enlarge');
  await page.selectOption('#itp-mode', 'lossless');
  ({ pdf } = await makePdf());
  [p1, p2, p3] = pdf.pages;
  for (const p of pdf.pages) near(assert, p.mediaBox, [0, 0, 792, 612], 'Letter landscape');
  near(assert, p1.cm, [0, -48, 36, 0, 378, 330], 'natural size, EXIF 6');
  near(assert, p2.cm, [30, 0, 0, 22.5, 381, 294.75], 'natural size at 96 dpi, centred');
  near(assert, p3.cm, [24, 0, 0, 30, 384, 291], 'natural size, grey');
  assert.equal(p1.image.filter, 'DCTDecode', 'JPEGs stay JPEG in lossless mode');
  assert.equal(p2.image.filter, 'FlateDecode');
  const px = zlib.inflateSync(p2.image.data);
  assert.equal(px.length, 40 * 30 * 3);
  const rgb = (x, y) => [...px.subarray((y * 40 + x) * 3, (y * 40 + x) * 3 + 3)];
  assert.deepEqual(rgb(0, 0), [255, 0, 0], 'opaque red stays red');
  assert.deepEqual(rgb(30, 5), [255, 255, 255], 'transparent blue becomes white, not blue');
  rgb(30, 25).forEach(v => assert.ok(Math.abs(v - 127) <= 2, `50% black over white is mid grey, got ${v}`));

  // Removing pages.
  await page.locator('#itp-list .itp-remove').nth(1).click();
  assert.deepEqual(await names(), ['rot6.jpg', 'gray.jpg']);
  await page.click('#itp-clear');
  assert.equal(await page.locator('#itp-list .itp-item').count(), 0);
  assert.equal(await page.isDisabled('#itp-make'), true);

  // Fit page to image: 96 px per inch, so 1 px = 0.75 pt. CMYK JPEG, GIF and WebP go through canvas.
  await page.selectOption('#itp-size', 'fit');
  assert.equal(await page.isDisabled('#itp-orient'), true, 'orientation does not apply to fitted pages');
  await page.selectOption('#itp-margin', '0');
  await page.setInputFiles('#itp-file', [fx('cmyk.jpg'), fx('green.gif'), fx('orange.webp')]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 3);
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);

  // Drag the third card's handle onto the first card with the mouse.
  const handle = await page.locator('#itp-list .itp-handle').nth(2).boundingBox();
  const target = await page.locator('#itp-list .itp-thumb').first().boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await names(), ['orange.webp', 'cmyk.jpg', 'green.gif']);
  assert.equal(await page.locator('#itp-list .itp-num').first().textContent(), '1');

  ({ pdf } = await makePdf());
  [p1, p2, p3] = pdf.pages;
  near(assert, p1.mediaBox, [0, 0, 37.5, 18.75], 'WebP 50x25 page');
  near(assert, p2.mediaBox, [0, 0, 22.5, 15], 'CMYK 30x20 page');
  near(assert, p3.mediaBox, [0, 0, 18, 18], 'GIF 24x24 page');
  near(assert, p2.cm, [22.5, 0, 0, 15, 0, 0], 'image fills fitted page');
  assert.deepEqual(zlib.inflateSync(p1.image.data).subarray(0, 3).toJSON().data, [255, 128, 0], 'WebP pixel exact');
  assert.deepEqual(zlib.inflateSync(p3.image.data).subarray(0, 3).toJSON().data, [0, 128, 0], 'GIF pixel exact');
  // CMYK JPEG is not copied raw; it is decoded by the browser and stored as RGB.
  assert.equal(p2.image.colorSpace, 'DeviceRGB');
  assert.equal(p2.image.filter, 'DCTDecode');
  assert.equal(buf.indexOf(fs.readFileSync(fx('cmyk.jpg'))), -1);
  assert.deepEqual(jpegInfo(p2.image.data), { width: 30, height: 20, comps: 3 });

  // Paste an image from the clipboard.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 10; c.height = 20;
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 4);
};
