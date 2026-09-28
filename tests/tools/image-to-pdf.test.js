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
  const infoRef = Number(/\/Info (\d+) 0 R/.exec(trailer)[1]);

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
    // Fill pages clip to the area inside the margins: "x y w h re W n" before the matrix.
    const clipM = /^q\n([-\d.\s]+) re W n\n/.exec(content);
    const clip = clipM ? clipM[1].trim().split(/\s+/).map(Number) : null;
    const imName = /\/(\w+) Do/.exec(content)[1];
    const imRef = Number(new RegExp('/' + imName + ' (\\d+) 0 R').exec(pg.dict)[1]);
    const im = obj(imRef);
    const num = key => Number(new RegExp('/' + key + ' (\\d+)').exec(im.dict)[1]);
    // Either a device colour space name or [/ICCBased N 0 R].
    const cs = /\/ColorSpace (?:\/(\w+)|\[\s*\/ICCBased (\d+) 0 R\s*\])/.exec(im.dict);
    assert.ok(cs, `image ${imRef} has a /ColorSpace`);
    let icc = null, smask = null;
    const sm = /\/SMask (\d+) 0 R/.exec(im.dict);
    if (sm) {
      const m = obj(Number(sm[1]));
      smask = { dict: m.dict, data: m.data, width: Number(/\/Width (\d+)/.exec(m.dict)[1]), height: Number(/\/Height (\d+)/.exec(m.dict)[1]) };
    }
    if (cs[2]) {
      const prof = obj(Number(cs[2]));
      icc = { num: Number(cs[2]), n: Number(/\/N (\d+)/.exec(prof.dict)[1]), alternate: (/\/Alternate \/(\w+)/.exec(prof.dict) || [])[1], data: prof.data };
    }
    const pred = /\/DecodeParms << \/Predictor (\d+) \/Colors (\d+) \/BitsPerComponent 8 \/Columns (\d+) >>/.exec(im.dict);
    return {
      mediaBox, cm, clip,
      image: {
        width: num('Width'), height: num('Height'),
        colorSpace: cs[1] || 'ICCBased', icc, smask, dict: im.dict,
        filter: /\/Filter \/(\w+)/.exec(im.dict)[1],
        predictor: pred ? Number(pred[1]) : null,
        data: im.data,
      },
    };
  });
  return { pages, text: s, count, catalog: catalog.dict, info: obj(infoRef).dict };
}

// Undoes the PNG row filters of a /Predictor 15 Flate stream (RFC 2083, 6), written from the spec.
function unpredict(data, colors, width, assert) {
  const rowLen = colors * width, rows = data.length / (rowLen + 1);
  assert.ok(Number.isInteger(rows), `predicted data is whole rows: ${data.length} bytes for ${width} columns`);
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < rows; y++) {
    const f = data[y * (rowLen + 1)];
    assert.ok(f <= 4, `row ${y} filter type ${f}`);
    const line = data.subarray(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1));
    const cur = out.subarray(y * rowLen, (y + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= colors ? cur[i - colors] : 0, b = prev[i], c = i >= colors ? prev[i - colors] : 0;
      let pr = 0;
      if (f === 1) pr = a;
      else if (f === 2) pr = b;
      else if (f === 3) pr = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = (line[i] + pr) & 255;
    }
    prev = cur;
  }
  return out;
}
// Raw pixels of a lossless page image, from its zlib data and predictor.
function flatePixels(image, assert) {
  assert.equal(image.filter, 'FlateDecode');
  assert.equal(image.predictor, 15, 'PNG predictors');
  return unpredict(zlib.inflateSync(image.data), 3, image.width, assert);
}
// Decodes a PDF text string: <FEFF...> UTF-16BE hex.
function pdfString(dict, key) {
  const m = new RegExp('/' + key + ' <FEFF([0-9A-F]*)>').exec(dict);
  if (!m) return null;
  return Buffer.from(m[1], 'hex').swap16().toString('utf16le');
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

// Lists a JPEG's marker segments up to EOI: [{ m, start, end }], plus the offset just after EOI.
function jpegSegments(b) {
  const segs = [];
  let i = 2;
  while (i + 1 < b.length) {
    const m = b[i + 1];
    if (m === 0xd9) return { segs, eoiEnd: i + 2 };
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (m === 0xda) {
      let j = end;
      while (!(b[j] === 0xff && b[j + 1] !== 0 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      segs.push({ m, start: i, end: j });
      i = j;
    } else {
      segs.push({ m, start: i, end });
      i = end;
    }
  }
  throw new Error('no EOI');
}
// What the PDF should hold for a JPEG: the original minus APP1-APP13, APP15 and COM segments and
// anything after EOI, with the JFIF APP0 kept (without a thumbnail).
function metadataFree(b) {
  const parts = [b.subarray(0, 2)];
  for (const s of jpegSegments(b).segs) {
    if ((s.m >= 0xe1 && s.m <= 0xef && s.m !== 0xee) || s.m === 0xfe) continue;
    if (s.m === 0xe0) { const j = Buffer.from(b.subarray(s.start, s.start + 18)); j[3] = 16; j[16] = j[17] = 0; parts.push(j); continue; }
    parts.push(b.subarray(s.start, s.end));
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const near = (assert, actual, expected, msg, tol = 0.002) => {
  assert.equal(actual.length, expected.length, msg);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tol, `${msg}: got [${actual}] expected [${expected}]`));
};

module.exports = async ({ page, open, assert, fixtures, url }) => {
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
  // Keyboard focus survives the move buttons (WCAG 2.4.3): it stays on the pressed button, or moves to
  // the item's other arrow or handle when that button becomes disabled at the end of the list.
  const focused = () => page.evaluate(() => document.activeElement.getAttribute('aria-label') || document.activeElement.className);
  await page.locator('#itp-list .itp-down').nth(1).focus(); // alpha.png, middle
  await page.keyboard.press('Enter');
  assert.deepEqual(await names(), ['rot6.jpg', 'gray.jpg', 'alpha.png']);
  assert.match(await focused(), /earlier.*alpha\.png|alpha\.png.*earlier/i, 'focus moves to "Move earlier" of the item now last');
  await page.keyboard.press('Enter');
  assert.deepEqual(await names(), ['rot6.jpg', 'alpha.png', 'gray.jpg']);
  assert.match(await focused(), /earlier.*alpha\.png|alpha\.png.*earlier/i, 'focus stays on the same button');
  await page.keyboard.press('Enter');
  assert.deepEqual(await names(), ['alpha.png', 'rot6.jpg', 'gray.jpg']);
  assert.match(await focused(), /later.*alpha\.png|alpha\.png.*later/i, 'first item: focus moves to "Move later"');
  await page.keyboard.press('Enter');
  assert.deepEqual(await names(), ['rot6.jpg', 'alpha.png', 'gray.jpg']);
  assert.match(await focused(), /later.*alpha\.png|alpha\.png.*later/i);
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

  // Page 1: the JPEG data is copied without re-encoding, rotated by the matrix (EXIF 6), portrait A4.
  // Only its EXIF segment (APP1) is left out; the scan data after SOF is identical.
  const rot6 = fs.readFileSync(fx('rot6.jpg'));
  let [p1, p2, p3] = pdf.pages;
  assert.equal(buf.indexOf(Buffer.from('Exif\0\0', 'latin1')), -1, 'no EXIF block in the PDF');
  assert.equal(p1.image.data.length, rot6.length - 36, 'only the 36-byte APP1 is dropped');
  assert.equal(Buffer.compare(p1.image.data, metadataFree(rot6)), 0);
  assert.ok(buf.indexOf(rot6.subarray(56)) > 0, 'quantisation tables, Huffman tables and scan data copied unchanged');
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
  assert.equal(Buffer.compare(p3.image.data, fs.readFileSync(fx('gray.jpg'))), 0, 'a JPEG with no metadata is copied byte for byte');
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
  const px = flatePixels(p2.image, assert);
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
  await page.locator('#itp-list .itp-handle').nth(2).scrollIntoViewIfNeeded();
  const handle = await page.locator('#itp-list .itp-handle').nth(2).boundingBox();
  const target = await page.locator('#itp-list .itp-thumb').first().boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await names(), ['orange.webp', 'cmyk.jpg', 'green.gif']);
  assert.equal(await page.locator('#itp-list .itp-num').first().textContent(), '1');

  ({ buf, pdf } = await makePdf());
  [p1, p2, p3] = pdf.pages;
  near(assert, p1.mediaBox, [0, 0, 37.5, 18.75], 'WebP 50x25 page');
  near(assert, p2.mediaBox, [0, 0, 22.5, 15], 'CMYK 30x20 page');
  near(assert, p3.mediaBox, [0, 0, 18, 18], 'GIF 24x24 page');
  near(assert, p2.cm, [22.5, 0, 0, 15, 0, 0], 'image fills fitted page');
  assert.deepEqual([...flatePixels(p1.image, assert).subarray(0, 3)], [255, 128, 0], 'WebP pixel exact');
  assert.deepEqual([...flatePixels(p3.image, assert).subarray(0, 3)], [0, 128, 0], 'GIF pixel exact');
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
  await page.click('#itp-clear');

  // Colour profiles. p3-split.jpg carries a Display P3 profile split over two APP2 segments, stored in
  // reverse order, so the chunks must be joined by sequence number (ICC.1 Annex B.4). Without the
  // profile a PDF reader shows the P3 pixel values as plain sRGB, visibly duller than the browser.
  const p3jpg = fs.readFileSync(fx('p3-split.jpg'));
  const p3icc = fs.readFileSync(fx('p3.icc'));
  const app2 = (seq, cnt, data) => {
    const body = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([seq, cnt]), data]);
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xe2]), len, body]);
  };
  const withSegment = (jpeg, seg) => Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
  // An RGB profile in a greyscale JPEG does not match, and half of a two-part profile is incomplete: both are ignored.
  const grayRgbProfile = withSegment(fs.readFileSync(fx('gray.jpg')), app2(1, 1, p3icc));
  const halfProfile = withSegment(fs.readFileSync(fx('rot6.jpg')), app2(1, 2, p3icc.subarray(0, 3000)));
  // A 2 x 2 PNG is 1.5 pt wide at 96 px per inch, below the 3 pt minimum page size of ISO 32000-1 Annex C.
  const tinyPng = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 2; c.height = 2;
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.selectOption('#itp-mode', 'jpeg');
  await page.setInputFiles('#itp-file', [
    { name: 'p3-a.jpg', mimeType: 'image/jpeg', buffer: p3jpg },
    { name: 'p3-b.jpg', mimeType: 'image/jpeg', buffer: p3jpg },
    { name: 'gray-rgb-profile.jpg', mimeType: 'image/jpeg', buffer: grayRgbProfile },
    { name: 'half-profile.jpg', mimeType: 'image/jpeg', buffer: halfProfile },
    { name: 'tiny.png', mimeType: 'image/png', buffer: tinyPng },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 5);
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);
  assert.equal(await page.textContent('#itp-error'), '');
  ({ buf, pdf } = await makePdf());
  assert.ok(pdf.text.startsWith('%PDF-1.7\n'), 'ICC version 4 profiles need PDF 1.5 or later; the file says 1.7');
  const [q1, q2, q3, q4, q5] = pdf.pages;
  assert.equal(Buffer.compare(q1.image.data, metadataFree(p3jpg)), 0, 'the P3 JPEG is copied without its APP2 segments');
  assert.equal(q1.image.data.length, p3jpg.length - 2 * 3340);
  assert.equal(q1.image.colorSpace, 'ICCBased');
  assert.equal(q1.image.icc.n, 3);
  assert.equal(q1.image.icc.alternate, 'DeviceRGB');
  assert.equal(Buffer.compare(q1.image.icc.data, p3icc), 0, 'the joined profile is embedded exactly');
  assert.equal(q2.image.icc.num, q1.image.icc.num, 'identical profiles are stored once');
  assert.equal(pdf.count, 4 + 3 * 5 + 1, 'xref covers the catalog, pages, info, 15 page objects and one profile');
  assert.equal(q3.image.colorSpace, 'DeviceGray', 'an RGB profile is not attached to a greyscale JPEG');
  assert.equal(q4.image.colorSpace, 'DeviceRGB', 'an incomplete profile is ignored');
  assert.equal(Buffer.compare(q4.image.data, metadataFree(halfProfile)), 0);
  near(assert, q1.mediaBox, [0, 0, 30, 15], 'P3 40x20 page');
  near(assert, q5.mediaBox, [0, 0, 3, 3], 'tiny image gets the 3 pt minimum page');
  near(assert, q5.cm, [1.5, 0, 0, 1.5, 0.75, 0.75], 'tiny image centred on its page');

  // Privacy: a phone photo's EXIF (GPS position, camera serial, owner), XMP, ICC-less APP2, IPTC (APP13),
  // comment and the motion-photo video appended after EOI must not end up in the PDF. Pixels must be
  // unchanged, for baseline and progressive JPEGs.
  await page.click('#itp-clear');
  const gps = fs.readFileSync(fx('gps-motion.jpg'));
  const prog = fs.readFileSync(fx('progressive.jpg'));
  await page.setInputFiles('#itp-file', [fx('gps-motion.jpg'), fx('progressive.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 2);
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);
  ({ buf, pdf } = await makePdf());
  for (const secret of ['Exif\0\0', 'Canon', 'Jane Example', '012345678901', 'Lightroom', 'ns.adobe.com', 'Photoshop 3.0', 'ftypmp42', 'SECRET-VIDEO']) {
    assert.equal(buf.indexOf(Buffer.from(secret, 'latin1')), -1, `PDF does not contain ${JSON.stringify(secret)}`);
  }
  assert.ok(gps.indexOf('Canon') > 0 && gps.indexOf('SECRET-VIDEO') > 0 && prog.indexOf('Exif') > 0, 'fixtures do carry the metadata');
  const [g1, g2] = pdf.pages;
  assert.equal(g1.image.filter, 'DCTDecode');
  assert.equal(g2.image.filter, 'DCTDecode');
  assert.equal(Buffer.compare(g1.image.data, metadataFree(gps)), 0);
  assert.equal(Buffer.compare(g2.image.data, metadataFree(prog)), 0);
  const { segs, eoiEnd } = jpegSegments(g1.image.data);
  assert.equal(eoiEnd, g1.image.data.length, 'nothing after EOI');
  assert.deepEqual([...new Set(segs.map(x => x.m.toString(16)))].sort(), ['c0', 'c4', 'da', 'db', 'e0']);
  near(assert, g1.cm, [0, -g1.mediaBox[3], g1.mediaBox[2], 0, 0, g1.mediaBox[3]], 'EXIF orientation 6 is still applied', 0.01);
  // Reference decode of the untouched original, with its EXIF renamed so the browser does not apply the
  // orientation (the PDF applies it with the page matrix instead).
  const unrotated = jpeg => { const c = Buffer.from(jpeg); let k; while ((k = c.indexOf('Exif\0\0', 0, 'latin1')) !== -1) c[k + 3] = 0x78; return c; };
  const samePixels = await page.evaluate(async pairs => {
    const px = async bytes => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const out = [];
    for (const [a, b] of pairs) {
      const [pa, pb] = [await px(a), await px(b)];
      out.push(pa.length === pb.length && pa.every((v, i) => v === pb[i]));
    }
    return out;
  }, [[[...unrotated(gps)], [...g1.image.data]], [[...unrotated(prog)], [...g2.image.data]]]);
  assert.deepEqual(JSON.stringify(samePixels), JSON.stringify([true, true]), 'decoded pixels are identical to the original photos');
  await page.click('#itp-clear');
  await page.setInputFiles('#itp-file', [
    { name: 'p3-a.jpg', mimeType: 'image/jpeg', buffer: p3jpg },
  ]);
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);

  // Creating the PDF from the keyboard: the button is disabled while working, then gets focus back.
  await page.focus('#itp-make');
  await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'itp-make', 'focus returns to Create PDF');

  // Default page size follows the CLDR paper-size territories: Letter in Belize, A4 in Germany and the Dominican Republic.
  for (const [locale, size] of [['en-BZ', 'letter'], ['de-DE', 'a4'], ['es-DO', 'a4'], ['en-US', 'letter']]) {
    const ctx = await page.context().browser().newContext({ locale });
    const p = await ctx.newPage();
    await p.goto(url);
    assert.equal(await p.inputValue('#itp-size'), size, `default page size for ${locale}`);
    await ctx.close();
  }

  // A 4097 x 4097 PNG is just over the 16,777,216-pixel canvas budget: it is scaled to 4096 x 4096
  // (4097 * sqrt(2^24 / 4097^2) = 4096), and the status says so instead of claiming exact pixels.
  const big = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 4097; c.height = 4097;
    const x = c.getContext('2d');
    x.fillStyle = '#3366cc'; x.fillRect(0, 0, c.width, c.height);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.click('#itp-clear');
  await page.setInputFiles('#itp-file', { name: 'huge.png', mimeType: 'image/png', buffer: big });
  await page.waitForFunction(() => !document.querySelector('#itp-make').disabled);
  ({ pdf } = await makePdf());
  assert.deepEqual([pdf.pages[0].image.width, pdf.pages[0].image.height], [4096, 4096]);
  near(assert, pdf.pages[0].mediaBox, [0, 0, 3072.75, 3072.75], 'page still follows the original 4097 px size');
  assert.match(await page.textContent('#itp-status'), /“huge\.png” was larger than 16\.7 megapixels.*scaled down/);

  // ---------- HEIC, TIFF, BMP, AVIF and SVG input ----------
  // quadrants.heic 240x160: (220,40,40) (40,180,60) / (40,60,200) (240,240,240) (from the heic-to-jpg fixtures).
  // two-pages.tif, flag.bmp and flat.avif were made with Pillow (colours below). The SVG has only a viewBox,
  // 100 x 50: it used to be read as the browser's 300 x 150 default, squashing it, and drawn at that size.
  await page.click('#itp-clear');
  await page.selectOption('#itp-size', 'fit');
  await page.selectOption('#itp-margin', '0');
  await page.selectOption('#itp-mode', 'lossless');
  await page.uncheck('#itp-alpha');
  const halves = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#ff0000"/><rect x="50" width="50" height="50" fill="#0000ff"/></svg>');
  await page.setInputFiles('#itp-file', [
    { name: 'quadrants.heic', mimeType: 'image/heic', buffer: fs.readFileSync(fx('quadrants.heic')) },
    { name: 'two-pages.tif', mimeType: 'image/tiff', buffer: fs.readFileSync(fx('two-pages.tif')) },
    { name: 'flag.bmp', mimeType: 'image/bmp', buffer: fs.readFileSync(fx('flag.bmp')) },
    { name: 'flat.avif', mimeType: 'image/avif', buffer: fs.readFileSync(fx('flat.avif')) },
    { name: 'halves.svg', mimeType: 'image/svg+xml', buffer: halves },
    { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
    { name: 'broken.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>') },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 5 && !document.querySelector('#itp-make').disabled, null, { timeout: 30000 });
  assert.deepEqual((await page.locator('#itp-list .itp-dims').allTextContents()).map(t => t.replace(/ · [\d.]+ K?B$/, '')),
    ['240 × 160 · HEIC', '60 × 40 · TIFF', '32 × 16 · BMP', '64 × 32 · AVIF', '100 × 50 · SVG']);
  assert.match(await page.textContent('#itp-note'), /two-pages\.tif” holds 2 pages; only the first page is added/);
  const errText = await page.textContent('#itp-error');
  assert.match(errText, /^2 files could not be added: empty\.png \(The file is empty \(0 bytes\)\); broken\.svg \(This is not valid SVG/, errText);
  ({ buf, pdf } = await makePdf());
  const [h1, t1, b1, a1, s1] = pdf.pages;
  near(assert, h1.mediaBox, [0, 0, 180, 120], 'HEIC page at 96 px per inch');
  assert.deepEqual([h1.image.width, h1.image.height, h1.image.filter], [240, 160, 'DCTDecode'], 'HEIC photos become JPEG even in lossless mode');
  const quad = await page.evaluate(async bytes => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    return [[60, 40], [180, 40], [60, 120], [180, 120]].map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data.slice(0, 3)));
  }, [...h1.image.data]);
  [[220, 40, 40], [40, 180, 60], [40, 60, 200], [240, 240, 240]].forEach((c, i) => c.forEach((v, j) => assert.ok(Math.abs(quad[i][j] - v) <= 12, `HEIC quadrant ${i}: ${quad[i]} vs ${c}`)));
  const tif = flatePixels(t1.image, assert), tpx = (x, y) => [...tif.subarray((y * 60 + x) * 3, (y * 60 + x) * 3 + 3)];
  assert.deepEqual([tpx(10, 20), tpx(45, 20)], [[200, 30, 30], [30, 30, 200]], 'first TIFF page, exact pixels');
  const bmpPx = flatePixels(b1.image, assert), bpx = (x, y) => [...bmpPx.subarray((y * 32 + x) * 3, (y * 32 + x) * 3 + 3)];
  assert.deepEqual([bpx(5, 3), bpx(5, 12)], [[250, 200, 0], [0, 90, 160]], 'BMP pixels exact');
  assert.deepEqual([a1.image.width, a1.image.height, a1.image.filter], [64, 32, 'DCTDecode'], 'AVIF is a lossy photo: JPEG');
  // SVG: page 100 x 50 px at 96 px/in = 75 x 37.5 pt; drawn at 300 ppi = 312.5 x 156.25, rounded.
  near(assert, s1.mediaBox, [0, 0, 75, 37.5], 'SVG keeps its viewBox shape');
  assert.deepEqual([s1.image.width, s1.image.height], [313, 156], 'SVG rendered at 300 ppi, not its nominal 100 x 50 px');
  const svgPx = flatePixels(s1.image, assert), spx = (x, y) => [...svgPx.subarray((y * 313 + x) * 3, (y * 313 + x) * 3 + 3)];
  assert.deepEqual([spx(40, 78), spx(270, 78)], [[255, 0, 0], [0, 0, 255]], 'SVG halves');
  // The predictor data is standard PNG: wrapped in a PNG file, the browser's own decoder reads the same pixels.
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(60, 0); ihdr.writeUInt32BE(40, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pngWrap = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', t1.image.data), chunk('IEND', Buffer.alloc(0))]);
  const viaBrowser = await page.evaluate(async bytes => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = new OffscreenCanvas(60, 40), x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, 60, 40).data, out = [];
    for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
    return out;
  }, [...pngWrap]);
  assert.deepEqual(viaBrowser, [...tif], 'browser PNG decoder agrees with the predictor decoding');

  // ---------- Fit or fill, per page ----------
  // A4 portrait, 1/2 in (36 pt) margin: the area inside is 523.28 x 769.89 pt.
  await page.click('#itp-clear');
  await page.selectOption('#itp-size', 'a4');
  await page.selectOption('#itp-orient', 'portrait');
  await page.selectOption('#itp-margin', '36');
  await page.selectOption('#itp-mode', 'jpeg');
  await page.check('#itp-enlarge');
  await page.selectOption('#itp-place', 'fill');
  await page.setInputFiles('#itp-file', [fx('alpha.png'), fx('gray.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 2 && !document.querySelector('#itp-make').disabled);
  assert.deepEqual(await page.locator('#itp-list select.itp-fit').evaluateAll(els => els.map(e => e.value)), ['fill', 'fill'], 'new pages follow the all-pages setting');
  await page.locator('#itp-list select.itp-fit').nth(1).selectOption('fit');
  assert.equal(await page.inputValue('#itp-place'), 'mixed', 'the all-pages select says the pages differ');
  assert.match(await page.textContent('#itp-status'), /Page 2 set to fit/);
  // The Fill preview overflows its (clipped) area; the Fit one does not.
  const previewW = await page.locator('#itp-list .itp-area img').evaluateAll(els => els.map(e => parseFloat(e.style.width)));
  assert.ok(previewW[0] > 150 && Math.abs(previewW[1] - 100) < 0.01, `preview widths ${previewW}`);
  ({ pdf } = await makePdf());
  let [f1, f2] = pdf.pages;
  // alpha.png 40 x 30 px = 30 x 22.5 pt. Cover: max(523.28 / 30, 769.89 / 22.5) = 34.21733, so 1026.52 x 769.89,
  // centred: x = (595.28 - 1026.52) / 2 = -215.62.
  near(assert, f1.clip, [36, 36, 523.28, 769.89], 'fill clips to the margins');
  near(assert, f1.cm, [1026.52, 0, 0, 769.89, -215.62, 36], 'fill covers the area', 0.01);
  // gray.jpg 32 x 40 px = 24 x 30 pt. Fit: min(523.28 / 24, 769.89 / 30) = 21.80333, so 523.28 x 654.1.
  assert.equal(f2.clip, null, 'fit needs no clipping');
  near(assert, f2.cm, [523.28, 0, 0, 654.1, 36, 93.895], 'fit inside the margins', 0.01);
  await page.selectOption('#itp-place', 'fit');
  assert.deepEqual(await page.locator('#itp-list select.itp-fit').evaluateAll(els => els.map(e => e.value)), ['fit', 'fit']);
  await page.selectOption('#itp-size', 'fit');
  assert.equal(await page.locator('#itp-list select.itp-fit').first().isDisabled(), true, 'placement does not apply to fitted pages');
  assert.equal(await page.isDisabled('#itp-place'), true);

  // Other page sizes, in points: US Legal, A5, A3 (portrait, whatever the image).
  for (const [size, box] of [['legal', [612, 1008]], ['a5', [419.53, 595.28]], ['a3', [841.89, 1190.55]]]) {
    await page.selectOption('#itp-size', size);
    ({ pdf } = await makePdf());
    for (const pg of pdf.pages) near(assert, pg.mediaBox, [0, 0, ...box], size);
  }

  // ---------- Keep transparency ----------
  // alpha.png: red opaque (x < 20), blue with alpha 0 (x >= 20, y < 20), black with alpha 128 (x >= 20, y >= 20).
  await page.selectOption('#itp-size', 'fit');
  await page.selectOption('#itp-margin', '0');
  await page.selectOption('#itp-mode', 'lossless');
  await page.check('#itp-alpha');
  ({ pdf } = await makePdf());
  [f1, f2] = pdf.pages;
  const mask = f1.image.smask;
  assert.ok(mask, 'transparent PNG gets a soft mask');
  assert.match(mask.dict, /\/ColorSpace \/DeviceGray \/BitsPerComponent 8 \/Matte \[1 1 1\] \/Filter \/FlateDecode \/DecodeParms << \/Predictor 15 \/Colors 1 \/BitsPerComponent 8 \/Columns 40 >>/);
  assert.deepEqual([mask.width, mask.height], [40, 30]);
  const alphaPx = unpredict(zlib.inflateSync(mask.data), 1, 40, assert);
  assert.deepEqual([alphaPx[0], alphaPx[5 * 40 + 30], alphaPx[25 * 40 + 30]], [255, 0, 128], 'alpha values kept');
  const colour = flatePixels(f1.image, assert);
  assert.deepEqual([...colour.subarray((5 * 40 + 30) * 3, (5 * 40 + 30) * 3 + 3)], [255, 255, 255], 'invisible pixels are the matte colour, white');
  colour.subarray((25 * 40 + 30) * 3, (25 * 40 + 30) * 3 + 3).forEach(v => assert.ok(Math.abs(v - 127) <= 2, `pre-blended with white: ${v}`));
  assert.equal(f2.image.smask, null, 'an opaque JPEG has no mask');
  await page.selectOption('#itp-mode', 'jpeg');
  ({ pdf } = await makePdf());
  assert.equal(pdf.pages[0].image.filter, 'DCTDecode');
  assert.ok(pdf.pages[0].image.smask, 'JPEG colour with a Flate mask');
  await page.uncheck('#itp-alpha');
  ({ buf, pdf } = await makePdf());
  assert.equal(buf.indexOf('/SMask'), -1, 'no masks unless asked for');

  // ---------- Compression, resolution limit and the size estimate ----------
  const noiseJpeg = async (w, h, q) => Buffer.from(await page.evaluate(async ([w, h, q]) => {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d'), img = x.createImageData(w, h);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      img.data[i] = (seed >>> 8) & 255; img.data[i + 1] = (i >> 6) & 255; img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, [w, h, q]));
  const photo = await noiseJpeg(2000, 1500, 0.95), lowq = await noiseJpeg(200, 150, 0.3);
  await page.click('#itp-clear');
  await page.selectOption('#itp-size', 'a4');
  await page.selectOption('#itp-orient', 'auto');
  await page.selectOption('#itp-margin', '18');
  await page.selectOption('#itp-place', 'fit');
  await page.setInputFiles('#itp-file', [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo }, { name: 'lowq.jpg', mimeType: 'image/jpeg', buffer: lowq }]);
  await page.waitForFunction(() => document.querySelectorAll('#itp-list .itp-item').length === 2 && !document.querySelector('#itp-make').disabled);
  const estimateOf = async () => {
    await page.waitForFunction(() => /^Estimated PDF size: about [\d.]+ [KM]?B\.$/.test(document.querySelector('#itp-estimate').textContent), null, { timeout: 30000 });
    const [, v, unit] = /about ([\d.]+) ([KM]?B)/.exec(await page.textContent('#itp-estimate'));
    return Number(v) * { B: 1, KB: 1024, MB: 1048576 }[unit];
  };
  let est = await estimateOf();
  ({ buf, pdf } = await makePdf());
  const offSize = buf.length;
  assert.ok(Math.abs(est - offSize) / offSize < 0.03, `estimate ${est} vs actual ${offSize}`);
  assert.equal(pdf.pages[0].image.width, 2000, 'compression off copies the photo');
  assert.equal(Buffer.compare(pdf.pages[0].image.data, metadataFree(photo)), 0);
  await page.selectOption('#itp-compress', 'on');
  assert.equal(await page.inputValue('#itp-quality'), '75', 'compression starts from quality 75');
  assert.equal(await page.isVisible('#itp-ppi-field'), true);
  assert.equal(await page.isHidden('#itp-mode-field'), true);
  assert.equal(await page.inputValue('#itp-ppi'), '150');
  assert.match(await page.textContent('#itp-estimate'), /^Estimating/, 'a stale estimate is replaced at once');
  // Page 1: landscape A4 (841.89 x 595.28) with 18 pt margins; 1500 x 1125 pt scaled by
  // min(805.89 / 1500, 559.28 / 1125) = 0.4971378 is 745.707 pt wide. At 150 ppi that is 745.707 / 72 * 150 = 1553.6 px.
  // Page 2 (200 px wide, 128 ppi at its enlarged size) stays under the limit; at quality 75 it would grow, so it is kept.
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' });
  });
  est = await estimateOf();
  ({ buf, pdf } = await makePdf());
  assert.ok(Math.abs(est - buf.length) / buf.length < 0.03, `estimate ${est} vs actual ${buf.length}`);
  assert.ok(buf.length < offSize / 3, `compressed PDF ${buf.length} vs ${offSize}`);
  const [c1, c2] = pdf.pages;
  assert.ok(Math.abs(c1.image.width - 1554) <= 1 && Math.abs(c1.image.height - 1165) <= 1, `150 ppi: ${c1.image.width} x ${c1.image.height}`);
  assert.equal(c1.image.filter, 'DCTDecode');
  near(assert, c1.cm, [745.707, 0, 0, 559.28, 48.092, 18], 'same place on the page', 0.01);
  assert.equal(Buffer.compare(c2.image.data, metadataFree(lowq)), 0, 'a JPEG that would grow is kept as it was');
  const tasks = await page.evaluate(() => window.__lt);
  assert.ok(tasks.every(t => t < 200), `no long main-thread tasks while compressing: ${tasks}`);
  await page.selectOption('#itp-ppi', '300');
  est = await estimateOf();
  ({ buf, pdf } = await makePdf());
  assert.equal(pdf.pages[0].image.width, 2000, 'at 300 ppi the 193 ppi photo keeps its pixels');
  assert.ok(est > 0);
  await page.selectOption('#itp-compress', 'off');
  assert.equal(await page.inputValue('#itp-quality'), '92', 'back to the default quality');

  // ---------- Title and author ----------
  await page.fill('#itp-title', 'Überweisung – März 😀');
  await page.fill('#itp-author', 'Zoë (O’Brien)');
  await page.fill('#itp-name', 'receipts');
  let res = await makePdf();
  assert.equal(res.name, 'receipts.pdf');
  assert.equal(pdfString(res.pdf.info, 'Title'), 'Überweisung – März 😀', 'UTF-16 title with an emoji');
  assert.equal(pdfString(res.pdf.info, 'Author'), 'Zoë (O’Brien)');
  assert.match(res.pdf.catalog, /\/ViewerPreferences << \/DisplayDocTitle true >>/, 'readers show the title');
  await page.fill('#itp-title', '');
  await page.fill('#itp-author', '  ');
  res = await makePdf();
  assert.equal(pdfString(res.pdf.info, 'Title'), 'receipts', 'no title: the file name');
  assert.equal(pdfString(res.pdf.info, 'Author'), null, 'no empty author');
  assert.doesNotMatch(res.pdf.catalog, /DisplayDocTitle/);

  // Phone width after adding pages: no sideways scrolling, and the settings sit under the pages.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'no horizontal scroll at 390 px');
  const [listBox, sideBox] = [await page.locator('#itp-list').boundingBox(), await page.locator('.itp-side').boundingBox()];
  assert.ok(sideBox.y >= listBox.y + listBox.height, 'settings below the pages on a phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Adding images while a PDF is being created is refused with a message, not silently dropped.
  await page.evaluate(() => {
    document.querySelector('#itp-make').click();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1])], 'late.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  assert.match(await page.textContent('#itp-error'), /wait until the current step has finished/);
};
