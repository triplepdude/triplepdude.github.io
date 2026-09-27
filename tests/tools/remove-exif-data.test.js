const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- Independent container readers (ITU T.81 JPEG, ISO 15948 PNG, RIFF WebP, TIFF 6.0) ----
function jpegSegments(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('no SOI');
  const segs = [];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`expected marker at ${i}`);
    const m = buf[i + 1];
    if (m === 0xd9) { segs.push({ m, start: i, end: i + 2 }); return { segs, end: i + 2 }; }
    const len = buf.readUInt16BE(i + 2);
    const seg = { m, start: i, payload: buf.subarray(i + 4, i + 2 + len), end: i + 2 + len };
    if (m === 0xda) {
      let k = seg.end;
      while (!(buf[k] === 0xff && buf[k + 1] !== 0 && !(buf[k + 1] >= 0xd0 && buf[k + 1] <= 0xd7))) k++;
      seg.end = k;
    }
    segs.push(seg);
    i = seg.end;
  }
  return { segs, end: buf.length };
}
const hex = m => m.toString(16).toUpperCase();
const markerList = buf => jpegSegments(buf).segs.map(s => hex(s.m));
// Bytes from the first SOS to the end of the primary image's EOI: the compressed pixels.
function scanData(buf) {
  const { segs, end } = jpegSegments(buf);
  return buf.subarray(segs.find(s => s.m === 0xda).start, end);
}

function tiffIfd0(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('not TIFF');
  const off = u32(4), n = u16(off), tags = [];
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    tags.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), short: u16(e + 8) });
  }
  return { tags, next: u32(off + 2 + n * 12) };
}

function pngChunks(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const chunks = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    chunks.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return chunks;
}

function webpChunks(buf, assert) {
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
  assert.equal(buf.toString('latin1', 8, 12), 'WEBP');
  assert.equal(buf.readUInt32LE(4), buf.length - 8, 'RIFF size field matches the file length');
  const chunks = [];
  let o = 12;
  while (o < buf.length) {
    const type = buf.toString('latin1', o, o + 4), size = buf.readUInt32LE(o + 4);
    chunks.push({ type, data: buf.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  assert.equal(o, buf.length, 'chunks end exactly at the end of the file');
  return chunks;
}

// ---- ISO BMFF (ISO/IEC 14496-12 and 23008-12): boxes, items and item data ----
function isoBoxes(buf, s = 0, e = buf.length) {
  const out = [];
  for (let o = s; o + 8 <= e;) {
    let size = buf.readUInt32BE(o), h = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); h = 16; } else if (size === 0) size = e - o;
    if (size < h || o + size > e) throw new Error(`bad box at ${o}`);
    out.push({ type: buf.toString('latin1', o + 4, o + 8), s: o, d: o + h, e: o + size });
    o += size;
  }
  return out;
}
function heifItems(buf) {
  const top = isoBoxes(buf), meta = top.find(b => b.type === 'meta');
  const kids = isoBoxes(buf, meta.d + 4, meta.e), items = {}, loc = {}, refs = [];
  let idat = null;
  for (const b of kids) {
    const v = buf[b.d], p = b.d + 4;
    if (b.type === 'iinf') {
      const cw = v === 0 ? 2 : 4, count = cw === 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
      const infes = isoBoxes(buf, p + cw, b.e);
      if (infes.length !== count) throw new Error(`iinf count ${count} but ${infes.length} entries`);
      for (const c of infes) {
        const iv = buf[c.d], id = iv === 2 ? buf.readUInt16BE(c.d + 4) : buf.readUInt32BE(c.d + 4);
        items[id] = buf.toString('latin1', c.d + (iv === 2 ? 8 : 10), c.d + (iv === 2 ? 12 : 14));
      }
    } else if (b.type === 'iloc') {
      const os = buf[p] >> 4, ls = buf[p] & 15, bs = buf[p + 1] >> 4, is = v ? buf[p + 1] & 15 : 0;
      const rd = (o, n) => (n === 0 ? 0 : n === 2 ? buf.readUInt16BE(o) : n === 4 ? buf.readUInt32BE(o) : Number(buf.readBigUInt64BE(o)));
      let q = p + 2;
      const count = v < 2 ? buf.readUInt16BE(q) : buf.readUInt32BE(q);
      q += v < 2 ? 2 : 4;
      for (let i = 0; i < count; i++) {
        const id = v < 2 ? buf.readUInt16BE(q) : buf.readUInt32BE(q);
        q += v < 2 ? 2 : 4;
        let method = 0;
        if (v) { method = buf.readUInt16BE(q) & 15; q += 2; }
        q += 2;
        const base = rd(q, bs); q += bs;
        const n = buf.readUInt16BE(q); q += 2;
        const ext = [];
        for (let j = 0; j < n; j++) { q += is; const off = rd(q, os); q += os; const len = rd(q, ls); q += ls; ext.push([base + off, len]); }
        loc[id] = { method, ext };
      }
    } else if (b.type === 'iref') {
      for (const r of isoBoxes(buf, p, b.e)) refs.push({ type: r.type, from: buf.readUInt16BE(r.d) });
    } else if (b.type === 'idat') idat = b;
  }
  const data = id => Buffer.concat(loc[id].ext.map(([o, n]) => (loc[id].method === 1 ? buf.subarray(idat.d + o, idat.d + o + n) : buf.subarray(o, o + n))));
  return { top, items, loc, refs, data };
}

// ---- TIFF 6.0: every IFD as { tag: values } ----
function tiffPages(buf) {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)), u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  assert42(u16(2));
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }, pages = [];
  for (let off = u32(4); off; off = u32(off + 2 + u16(off) * 12)) {
    const tags = {};
    for (let i = 0; i < u16(off); i++) {
      const e = off + 2 + i * 12, type = u16(e + 2), n = u32(e + 4), size = SIZE[type] * n, vo = size <= 4 ? e + 8 : u32(e + 8);
      tags[u16(e)] = type === 2 ? buf.toString('latin1', vo, vo + n - 1)
        : Array.from({ length: type === 5 ? 1 : n }, (_, k) => (type === 3 ? u16(vo + 2 * k) : type === 4 ? u32(vo + 4 * k) : type === 5 ? u32(vo) / u32(vo + 4) : buf[vo + k]));
    }
    pages.push(tags);
  }
  return { le, pages };
}
function assert42(v) { if (v !== 42) throw new Error('not a TIFF'); }
// The image data of a TIFF page: its strips or tiles, in order.
function tiffData(buf, page) {
  const offs = page[273] || page[324], lens = page[279] || page[325];
  return Buffer.concat(offs.map((o, k) => buf.subarray(o, o + lens[k])));
}

// ---- GIF89a blocks ----
function gifBlocks(buf) {
  let o = 13 + (buf[10] & 0x80 ? 3 * (1 << ((buf[10] & 7) + 1)) : 0);
  const out = [];
  const subs = p => { while (buf[p]) p += buf[p] + 1; return p + 1; };
  while (buf[o] !== 0x3b) {
    if (buf[o] === 0x21) { const e = subs(o + 2); out.push({ kind: 'ext', label: buf[o + 1], app: buf[o + 1] === 0xff ? buf.toString('latin1', o + 3, o + 14) : '', bytes: buf.subarray(o, e) }); o = e; }
    else if (buf[o] === 0x2c) { const f = buf[o + 9], e = subs(o + 10 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1); out.push({ kind: 'img', bytes: buf.subarray(o, e) }); o = e; }
    else throw new Error(`bad GIF block at ${o}`);
  }
  return { blocks: out, end: o + 1 };
}

// ---- ZIP (APPNOTE 6.3): entries from the central directory ----
function unzip(buf) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10), out = {};
  for (let i = 0, p = buf.readUInt32LE(eocd + 16); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize), data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (zlib.crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out[name] = data;
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  const F = n => path.join(fixtures, n);
  const card = i => `#rexif-list > article:nth-child(${i + 1})`;
  const idle = () => page.waitForFunction(() => document.querySelector('#rexif-list').dataset.busy === '0'
    && !document.querySelector('[data-rexif-card][data-state="working"]'), null, { timeout: 15000 });
  const table = i => page.$$eval(`${card(i)} tbody tr`, trs => Object.fromEntries(
    trs.map(tr => [tr.cells[0].textContent, [tr.cells[1].textContent, tr.cells[2].textContent]])));
  async function download(i) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`${card(i)} [data-rexif-dl]`)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  }
  // Decode with the browser's own decoder (EXIF orientation applied) and sample pixels.
  const decode = (buf, points = []) => page.evaluate(async ([b64, pts]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, px: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) };
  }, [buf.toString('base64'), points]);
  const setMode = async v => { await page.check(`input[name="rexif-orient"][value="${v}"]`); await idle(); };
  // HEIC and TIFF decoded by the site's shared decoder (libheif, UTIF), which is independent of
  // the metadata rewriting under test; AVIF, GIF and the rest by the browser itself.
  const decodeShared = (buf, points = []) => page.evaluate(async ([b64, pts]) => {
    const d = await TTImage.decode(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const g = d.canvas.getContext('2d');
    const res = { w: d.width, h: d.height, px: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) };
    TTImage.release(d);
    return res;
  }, [buf.toString('base64'), points]);
  const clear = async () => { await page.click('#rexif-clear'); assert.equal(await page.locator('[data-rexif-card]').count(), 0); };

  assert.equal(await page.isVisible('#rexif-empty'), true);
  assert.equal(await page.isVisible('#rexif-bulk'), false);

  await page.setInputFiles('#rexif-file', ['gps-rotated.jpg', 'meta.png', 'meta.webp', 'plain.jpg'].map(F));
  await idle();
  assert.equal(await page.locator('[data-rexif-card]').count(), 4);
  assert.equal(await page.isVisible('#rexif-empty'), false);
  assert.match(await page.textContent('#rexif-status'), /Cleaned 4 files\. 3 of them had a GPS location/);

  // ---------- JPEG: what was found ----------
  // 48° 51' 29.09" N, 2° 17' 40.20" E written by piexif as rationals.
  const lat = (48 + 51 / 60 + 29.09 / 3600).toFixed(6), lon = (2 + 17 / 60 + 40.2 / 3600).toFixed(6);
  assert.equal(lat, '48.858081');
  const warn = await page.textContent(`${card(0)} .rexif-gps`);
  assert.ok(warn.includes(`${lat}, ${lon}`), warn);
  assert.equal(await page.getAttribute(`${card(0)} .rexif-gps a`, 'href'),
    `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/48.85808/2.29450`);
  let t = await table(0);
  assert.equal(t['Location (GPS)'][0], `${lat}, ${lon} (48°51′29.1″N 2°17′40.2″E)`);
  assert.equal(t['Location (GPS)'][1], 'Removed');
  assert.equal(t.Altitude[0], '35 m above sea level');
  assert.equal(t['Date taken'][0], '2023-07-14 18:32:05 (UTC+02:00)');
  assert.equal(t.Camera[0], 'Canon EOS 80D');
  assert.equal(t.Lens[0], 'EF-S 18-135mm f/3.5-5.6 IS USM');
  assert.equal(t['Serial number'][0], 'camera 012345678901');
  assert.equal(t['Owner / author'][0], 'Jane Example');
  assert.equal(t.Copyright[0], '(c) Jane Example');
  assert.equal(t.Software[0], 'Adobe Lightroom Classic 12.4');
  assert.equal(t['Last edited'][0], '2023-07-15 09:12:44');
  assert.equal(t.Exposure[0], '1/250 s · f/5.6 · ISO 200');
  assert.equal(t['Focal length'][0], '35 mm');
  assert.deepEqual(t.Orientation, ['Rotate 90° clockwise (6)', 'Kept']);
  assert.match(t['Embedded thumbnail'][0], /preview image/);
  assert.match(t.XMP[0], /includes GPS location, made with Adobe Lightroom Classic 12\.4/);
  assert.match(t.IPTC[0], /By-line: Jane Example; City: Paris; Country: France; Caption: Evening at the tower/);
  assert.equal(t.Comment[0], 'Shot on holiday by Jane');
  assert.equal(t['Colour profile (ICC)'][1], 'Kept');
  assert.match(t['Data after the image'][0], /another JPEG image/);

  // ---------- JPEG, default: keep only the orientation tag ----------
  let d = await download(0);
  assert.equal(d.name, 'gps-rotated-clean.jpg');
  assert.deepEqual(markerList(d.buf), ['E0', 'E1', 'E2', 'DB', 'DB', 'C0', 'C4', 'C4', 'C4', 'C4', 'DA', 'D9']);
  const app1 = jpegSegments(d.buf).segs.find(s => s.m === 0xe1).payload;
  assert.equal(app1.toString('latin1', 0, 6), 'Exif\0\0');
  const ifd = tiffIfd0(app1.subarray(6));
  assert.deepEqual(ifd.tags, [{ tag: 0x0112, type: 3, count: 1, short: 6 }], 'only the Orientation tag remains');
  assert.equal(ifd.next, 0, 'no IFD1 thumbnail');
  for (const s of ['Canon', 'Jane', 'Paris', 'Lightroom', 'ns.adobe.com', 'Photoshop', 'holiday', '012345678901']) {
    assert.equal(d.buf.includes(s), false, `"${s}" is gone`);
  }
  assert.ok(scanData(d.buf).equals(scanData(fs.readFileSync(F('gps-rotated.jpg')))), 'compressed image data is byte-identical');
  assert.equal(jpegSegments(d.buf).end, d.buf.length, 'the trailing second image is dropped');
  let img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [80, 120], 'still displays upright (rotated by the tag)');

  // ---------- JPEG: remove everything (lossless) ----------
  await setMode('strip');
  t = await table(0);
  assert.equal(t.Orientation[1], 'Removed');
  assert.match(await page.textContent(`${card(0)} .rexif-note`), /sideways/);
  d = await download(0);
  assert.deepEqual(markerList(d.buf), ['E0', 'E2', 'DB', 'DB', 'C0', 'C4', 'C4', 'C4', 'C4', 'DA', 'D9']);
  assert.equal(d.buf.includes('Exif'), false);
  assert.ok(scanData(d.buf).equals(scanData(fs.readFileSync(F('gps-rotated.jpg')))));
  img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [120, 80], 'raw sensor orientation without the tag');

  await page.uncheck('#rexif-icc');
  await idle();
  d = await download(0);
  assert.deepEqual(markerList(d.buf), ['E0', 'DB', 'DB', 'C0', 'C4', 'C4', 'C4', 'C4', 'DA', 'D9']);
  assert.equal((await table(0))['Colour profile (ICC)'][1], 'Removed');

  // ---------- JPEG: rotate the pixels ----------
  await setMode('bake');
  t = await table(0);
  assert.equal(t.Orientation[1], 'Applied to pixels');
  d = await download(0);
  assert.equal(d.buf.includes('Exif'), false);
  assert.ok(!markerList(d.buf).includes('E1'));
  // Orientation 6: raw (x, y) is shown at (H-1-y, x). The raw red block (x 0-29, y 0-19) lands
  // top-right, the raw green block (x 90-119, y 60-79) lands bottom-left.
  img = await decode(d.buf, [[70, 10], [10, 105], [40, 60]]);
  assert.deepEqual([img.w, img.h], [80, 120]);
  const near = (p, rgb) => p.slice(0, 3).every((v, k) => Math.abs(v - rgb[k]) < 40);
  assert.ok(near(img.px[0], [255, 0, 0]), `top-right is red: ${img.px[0]}`);
  assert.ok(near(img.px[1], [0, 200, 0]), `bottom-left is green: ${img.px[1]}`);
  assert.ok(near(img.px[2], [40, 90, 200]), `middle is blue: ${img.px[2]}`);

  await page.check('#rexif-icc');
  await setMode('keep');

  // ---------- PNG ----------
  t = await table(1);
  assert.equal(t['Text: Author'][0], 'Jane Example');
  assert.equal(t['Text: Comment'][0], 'Shot in Paris', 'zTXt is decompressed');
  assert.equal(t['Last modified'][0], '2023-07-14 18:32:05 UTC');
  assert.equal(t.Camera[0], 'Apple iPhone 13');
  assert.match(t['Location (GPS)'][0], new RegExp(`^${lat}, ${lon}`));
  assert.match(t.XMP[0], /includes GPS location/);
  d = await download(1);
  assert.equal(d.name, 'meta-clean.png');
  const pc = pngChunks(d.buf, assert);
  assert.deepEqual(pc.map(c => c.type), ['IHDR', 'iCCP', 'pHYs', 'IDAT', 'IEND']);
  const origIdat = pngChunks(fs.readFileSync(F('meta.png')), assert).find(c => c.type === 'IDAT').data;
  assert.ok(pc.find(c => c.type === 'IDAT').data.equals(origIdat), 'pixel data is byte-identical');
  img = await decode(d.buf, [[5, 5]]);
  assert.deepEqual([img.w, img.h], [120, 80]);
  assert.deepEqual(img.px[0], [255, 0, 0, 255]);

  // ---------- WebP ----------
  assert.match((await table(2)).XMP[0], /includes GPS location/);
  d = await download(2);
  assert.equal(d.name, 'meta-clean.webp');
  const wc = webpChunks(d.buf, assert);
  assert.deepEqual(wc.map(c => c.type), ['VP8X', 'ICCP', 'VP8 ']);
  assert.equal(wc[0].data[0] & 0x0c, 0, 'VP8X EXIF and XMP flags cleared');
  assert.equal(wc[0].data[0] & 0x20, 0x20, 'VP8X ICC flag kept');
  const origVp8 = webpChunks(fs.readFileSync(F('meta.webp')), assert).find(c => c.type === 'VP8 ').data;
  assert.ok(wc[2].data.equals(origVp8));
  img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [120, 80]);

  // ---------- Already clean JPEG ----------
  assert.equal(await page.isVisible(`${card(3)} .rexif-none`), true);
  assert.equal(await page.locator(`${card(3)} table`).count(), 0);
  d = await download(3);
  assert.ok(d.buf.equals(fs.readFileSync(F('plain.jpg'))), 'nothing to remove: identical bytes');

  // ---------- Download all: one ZIP ----------
  assert.equal(await page.textContent('#rexif-all'), 'Download all as ZIP (4)');
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#rexif-all')]);
  assert.equal(zdl.suggestedFilename(), 'photos-without-metadata.zip');
  const zip = unzip(fs.readFileSync(await zdl.path()));
  assert.deepEqual(Object.keys(zip).sort(), ['gps-rotated-clean.jpg', 'meta-clean.png', 'meta-clean.webp', 'plain-clean.jpg']);
  assert.ok(zip['plain-clean.jpg'].equals(fs.readFileSync(F('plain.jpg'))), 'ZIP entry matches the single download');
  assert.deepEqual(webpChunks(zip['meta-clean.webp'], assert).map(c => c.type), ['VP8X', 'ICCP', 'VP8 ']);
  assert.match(await page.textContent('#rexif-status'), /Downloaded a ZIP with 4 cleaned files/);

  // ---------- Bad input ----------
  const png = fs.readFileSync(F('meta.png'));
  await page.setInputFiles('#rexif-file', [
    { name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('just some text, not a photo') },
    { name: 'phone.heic', mimeType: 'image/heic', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic')]) },
    { name: 'cut.png', mimeType: 'image/png', buffer: png.subarray(0, 300) },
  ]);
  await idle();
  assert.match(await page.textContent(`${card(4)} .rexif-err`), /not a JPEG, PNG, WebP, HEIC, AVIF, TIFF or GIF image/);
  assert.match(await page.textContent(`${card(5)} .rexif-err`), /This HEIC file has no image data/);
  assert.match(await page.textContent(`${card(6)} .rexif-err`), /damaged or truncated/);
  assert.equal(await page.locator(`${card(4)} [data-rexif-dl]`).count(), 0);
  assert.match(await page.textContent('#rexif-error'), /3 files could not be cleaned/);

  await page.click('#rexif-clear');
  assert.equal(await page.locator('[data-rexif-card]').count(), 0);
  assert.equal(await page.isVisible('#rexif-empty'), true);
  assert.equal(await page.textContent('#rexif-error'), '');

  // ---------- Built-in sample ----------
  await page.click('#rexif-sample');
  await page.waitForSelector('[data-rexif-card]');
  await idle();
  t = await table(0);
  const sLat = (40 + 41 / 60 + 21.29 / 3600).toFixed(6), sLon = (-(74 + 2 / 60 + 40.21 / 3600)).toFixed(6);
  assert.match(t['Location (GPS)'][0], new RegExp(`^${sLat}, ${sLon} \\(40°41′21\\.3″N 74°2′40\\.2″W\\)`));
  assert.equal(t.Camera[0], 'Example Camera Co. EC-1 Mark II');
  assert.equal(t['Date taken'][0], '2024-05-18 14:07:32 (UTC-04:00)');
  d = await download(0);
  assert.equal(d.name, 'sample-photo-clean.jpg');
  assert.ok(!markerList(d.buf).includes('E1'), 'orientation 1 needs no tag, so no EXIF at all');
  assert.equal(d.buf.includes('Example Camera'), false);
  img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [720, 480]);

  // ---------- Little-endian EXIF, southern and western hemisphere, progressive JPEG ----------
  // le-progressive-o8.jpg carries a hand-written "II" TIFF block: Make, Orientation 8, GPS
  // S 33/1 51/1 545/10, W 151/1 12/1 36/1, altitude 125/10 with AltitudeRef 1 (below sea level).
  await page.click('#rexif-clear');
  await page.setInputFiles('#rexif-file', F('le-progressive-o8.jpg'));
  await idle();
  t = await table(0);
  const leLat = (-(33 + 51 / 60 + 54.5 / 3600)).toFixed(6), leLon = (-(151 + 12 / 60 + 36 / 3600)).toFixed(6);
  assert.equal(leLat, '-33.865139');
  assert.equal(t['Location (GPS)'][0], `${leLat}, ${leLon} (33°51′54.5″S 151°12′36.0″W)`);
  assert.equal(t.Altitude[0], '12.5 m below sea level', 'AltitudeRef 1');
  assert.equal(t.Camera[0], 'NIKON CORPORATION');
  assert.deepEqual(t.Orientation, ['Rotate 270° clockwise (8)', 'Kept']);
  d = await download(0);
  const leOrig = fs.readFileSync(F('le-progressive-o8.jpg'));
  assert.ok(jpegSegments(leOrig).segs.filter(s => s.m === 0xda).length > 1, 'the fixture is progressive (several scans)');
  assert.ok(scanData(d.buf).equals(scanData(leOrig)), 'every progressive scan is byte-identical');
  const leApp1 = jpegSegments(d.buf).segs.find(s => s.m === 0xe1).payload;
  assert.deepEqual(tiffIfd0(leApp1.subarray(6)).tags, [{ tag: 0x0112, type: 3, count: 1, short: 8 }]);
  assert.equal(d.buf.includes('NIKON'), false);
  img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [80, 120], 'orientation 8 is still applied');

  // ---------- Files without image data are refused; undisplayable ones are flagged ----------
  const gpsJpg = fs.readFileSync(F('gps-rotated.jpg'));
  const sos = jpegSegments(gpsJpg).segs.find(s => s.m === 0xda).start;
  const metaPng = fs.readFileSync(F('meta.png'));
  // Intact chunk structure, but IHDR claims a bit depth of 3, which PNG does not allow (1, 2, 4, 8
  // or 16), so browsers refuse it. The CRC is recomputed so only the value is wrong.
  const badPng = Buffer.from(metaPng);
  assert.equal(badPng.toString('latin1', 12, 16), 'IHDR');
  badPng[24] = 3;
  badPng.writeUInt32BE(zlib.crc32(badPng.subarray(12, 29)), 29);
  await page.click('#rexif-clear');
  await page.setInputFiles('#rexif-file', [
    { name: 'cut-before-scan.jpg', mimeType: 'image/jpeg', buffer: gpsJpg.subarray(0, sos) },
    { name: 'header-only.png', mimeType: 'image/png', buffer: metaPng.subarray(0, 33) },
    { name: 'bad-depth.png', mimeType: 'image/png', buffer: badPng },
  ]);
  await idle();
  assert.match(await page.textContent(`${card(0)} .rexif-err`), /This JPEG file has no image data/);
  assert.match(await page.textContent(`${card(1)} .rexif-err`), /This PNG file has no image data/);
  assert.equal(await page.locator(`${card(0)} [data-rexif-dl]`).count(), 0);
  await page.waitForSelector(`${card(2)} .rexif-undecodable`);
  assert.match(await page.textContent(`${card(2)} .rexif-undecodable`), /cannot display this image/);
  assert.match((await table(2))['Text: Author'][0], /Jane Example/, 'its metadata is still listed and removed');
  assert.match(await page.textContent('#rexif-error'), /2 files could not be cleaned/);

  // ---------- Hostile text chunks are read in linear time ----------
  // Each is a few KB of zTXt that inflates to ~4 MB of text shaped to make a backtracking regular
  // expression quadratic: NULs that are not at the end, "CreatorTool>" with no "<", and a raw
  // profile whose header is followed by millions of spaces. Before the fix each froze the tab for hours.
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ztxt = (key, text) => chunk('zTXt', Buffer.concat([Buffer.from(key + '\0\0', 'latin1'), zlib.deflateSync(Buffer.from(text, 'latin1'))]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png1x1 = extra => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extra,
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 200, 30, 30]))), chunk('IEND', Buffer.alloc(0))]);
  const hostile = [
    { name: 'nul-run.png', mimeType: 'image/png', buffer: png1x1([ztxt('Comment', '\0'.repeat(3999000) + 'x')]) },
    { name: 'xmp-creatortool.png', mimeType: 'image/png', buffer: png1x1([ztxt('XML:com.adobe.xmp', 'CreatorTool>'.repeat(333250))]) },
    { name: 'raw-profile.png', mimeType: 'image/png', buffer: png1x1([ztxt('Raw profile type exif', '\nexif\n12' + ' '.repeat(3990000) + 'Z')]) },
    { name: 'long-value.png', mimeType: 'image/png', buffer: png1x1([ztxt('Title', ' '.repeat(100000) + 'A'.repeat(300))]) },
  ];
  hostile.forEach(f => assert.ok(f.buffer.length < 20000, `${f.name} is small: ${f.buffer.length}`));
  await page.click('#rexif-clear');
  const t0 = Date.now();
  await page.setInputFiles('#rexif-file', hostile);
  await idle();
  assert.ok(Date.now() - t0 < 8000, `hostile text read in ${Date.now() - t0} ms`);
  assert.equal(await page.locator('[data-rexif-card][data-state="done"]').count(), 4);
  assert.equal((await table(0))['Text: Comment'][0], 'x');
  assert.equal((await table(1)).XMP[0], '4.00 MB');
  assert.equal((await table(2))['Text: Raw profile type exif'][0], 'exif 12…', 'not a valid profile, so listed as text');
  // Only the start of a long value is tidied, after skipping leading blanks; it is shown cut off.
  assert.equal((await table(3))['Text: Title'][0], 'A'.repeat(199) + '…');

  // ---------- Keyboard focus survives the buttons' rows being hidden ----------
  await page.focus('#rexif-clear');
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('#rexif-bulk'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'rexif-sample', 'Clear list hands focus to the sample button');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${card(0)} [data-rexif-dl]`);
  await idle();
  assert.equal(await page.isVisible('#rexif-empty'), false);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Download cleaned sample-photo.jpg',
    'the sample hands focus to its Download button');

  // ---------- HEIC: Exif and XMP items removed without re-encoding ----------
  // gps.heic (pillow-heif): item 1 hvc1, item 2 Exif (GPS 51°30'26.35"N 0°7'39.6"W, alt 21.5 m,
  // direction 212.75° true, iPhone 15 Pro, 1/120 s f/1.78 ISO 64, 6.765 mm = 24 mm), item 3 mime XMP.
  await clear();
  await page.setInputFiles('#rexif-file', [F('gps.heic'), F('rot6.heic'), F('gps.avif')]);
  await idle();
  t = await table(0);
  const hLat = (51 + 30 / 60 + 26.35 / 3600).toFixed(6), hLon = (-(7 / 60 + 39.6 / 3600)).toFixed(6);
  // 26.35 s is a rounding tie; converted to decimal degrees and back it is 26.34999…, so 26.3.
  assert.equal(t['Location (GPS)'][0], `${hLat}, ${hLon} (51°30′26.3″N 0°7′39.6″W)`);
  assert.equal(t.Altitude[0], '21.5 m above sea level');
  assert.equal(t.Direction[0], 'Facing 213° (true north)');
  assert.equal(t['Date taken'][0], '2024-03-09 10:15:42 (UTC+01:00)');
  assert.equal(t.Camera[0], 'Apple iPhone 15 Pro');
  assert.equal(t.Lens[0], 'Apple iPhone 15 Pro back triple camera 6.765mm f/1.78');
  assert.equal(t.Exposure[0], '1/120 s · f/1.8 · ISO 64');
  assert.equal(t['Focal length'][0], '6.8 mm (24 mm in 35 mm film terms)');
  assert.match(t.XMP[0], /includes GPS location, made with Photos 9\.0/);
  assert.match(await page.textContent(`${card(0)} .rexif-name .hint`), /^HEIC · 96 × 64 px/);
  d = await download(0);
  assert.equal(d.name, 'gps-clean.heic');
  const hOrig = fs.readFileSync(F('gps.heic'));
  let hi = heifItems(d.buf);
  const ho = heifItems(hOrig);
  assert.deepEqual(ho.items, { 1: 'hvc1', 2: 'Exif', 3: 'mime' }, 'the fixture has Exif and XMP items');
  assert.deepEqual(hi.items, { 1: 'hvc1' }, 'only the image item is left');
  assert.deepEqual(Object.keys(hi.loc), ['1']);
  assert.deepEqual(hi.refs, [], 'no cdsc references to removed items');
  assert.deepEqual(hi.top.map(b => b.type), ['ftyp', 'meta', 'free', 'mdat']);
  assert.equal(d.buf.length, hOrig.length, 'same size: the free box replaces the removed entries');
  assert.ok(hi.data(1).equals(ho.data(1)), 'the HEVC image data is byte-identical');
  assert.equal(hi.loc[1].ext[0][0], ho.loc[1].ext[0][0], 'and at the same offset');
  assert.ok(!d.buf.includes(ho.data(2)) && !d.buf.includes(ho.data(3)), 'the Exif and XMP bytes are gone');
  for (const str of ['iPhone', 'Apple', 'rdf:RDF', 'GPSLatitude', 'Photos 9.0']) assert.equal(d.buf.includes(str), false, `"${str}" is gone`);
  const hPts = [[10, 10], [80, 10], [10, 55], [80, 55]];
  const hA = await decodeShared(hOrig, hPts), hB = await decodeShared(d.buf, hPts);
  assert.deepEqual(hB, hA, 'decodes to the same pixels');
  assert.ok(near(hB.px[0], [230, 30, 30]) && near(hB.px[3], [240, 220, 40]), `quadrants ${JSON.stringify(hB.px)}`);
  await page.waitForSelector(`${card(0)}[data-thumb="ready"]`);

  // Orientation lives in the HEIF irot property, which stays, so the photo is still upright.
  t = await table(1);
  assert.deepEqual(t.Orientation, ['Rotate 90° clockwise (6)', 'Removed']);
  assert.match(await page.textContent(`${card(1)} .rexif-note`), /keeps its own rotation setting/);
  d = await download(1);
  const r6o = fs.readFileSync(F('rot6.heic'));
  hi = heifItems(d.buf);
  assert.deepEqual(hi.items, { 1: 'hvc1' });
  const r6a = await decodeShared(r6o, [[5, 5], [60, 5]]), r6b = await decodeShared(d.buf, [[5, 5], [60, 5]]);
  assert.deepEqual([r6b.w, r6b.h], [64, 96], 'still rotated by irot');
  assert.deepEqual(r6b, r6a);
  assert.ok(near(r6b.px[1], [230, 30, 30]), `stored top-left red block is now top-right: ${r6b.px[1]}`);

  // ---------- HEIC with a grid of tiles (grid descriptor in idat), a second image with its own Exif ----------
  await page.setInputFiles('#rexif-file', F('multi.heic'));
  await idle();
  t = await table(3);
  assert.equal(t['Location (GPS)'][0], '-33.850000, 151.200000 (33°51′0.0″S 151°12′0.0″E)');
  d = await download(3);
  const mOrig = fs.readFileSync(F('multi.heic')), mo = heifItems(mOrig), mc = heifItems(d.buf);
  assert.deepEqual(Object.values(mo.items).filter(x => x !== 'hvc1'), ['grid', 'Exif', 'mime', 'Exif']);
  assert.deepEqual(Object.values(mc.items).filter(x => x !== 'hvc1'), ['grid'], 'both images lose their Exif, the XMP goes');
  assert.equal(Object.keys(mc.items).length, Object.keys(mo.items).length - 3);
  assert.deepEqual(mc.refs.map(r => r.type), ['dimg'], 'the grid still lists its tiles');
  for (const id of Object.keys(mc.items)) assert.ok(mc.data(id).equals(mo.data(id)), `item ${id} data unchanged`);
  for (const str of ['Apple', 'SecondCam', 'rdf']) assert.equal(d.buf.includes(str), false, `"${str}" is gone`);
  const mPts = [[20, 20], [300, 200], [590, 390]];
  assert.deepEqual(await decodeShared(d.buf, mPts), await decodeShared(mOrig, mPts));

  // ---------- AVIF: same container; the browser decodes it ----------
  t = await table(2);
  assert.equal(t['Location (GPS)'][0], `${hLat}, ${hLon} (51°30′26.3″N 0°7′39.6″W)`);
  d = await download(2);
  assert.equal(d.name, 'gps-clean.avif');
  const aOrig = fs.readFileSync(F('gps.avif'));
  hi = heifItems(d.buf);
  assert.deepEqual(hi.items, { 1: 'av01' });
  assert.ok(hi.data(1).equals(heifItems(aOrig).data(1)), 'AV1 data byte-identical');
  assert.equal(d.buf.includes('iPhone'), false);
  assert.deepEqual(await decode(d.buf, hPts), await decode(aOrig, hPts));

  // ---------- TIFF: rebuilt with only the image tags, every page kept ----------
  await clear();
  await page.setInputFiles('#rexif-file', [F('meta.tif'), F('tiled-o8.tif')]);
  await idle();
  t = await table(0);
  assert.equal(t['Location (GPS)'][0], '35.660000, 139.740000 (35°39′36.0″N 139°44′24.0″E)');
  assert.equal(t['Date taken'][0], '2024-04-02 14:21:09 (UTC+09:00)');
  assert.equal(t.Camera[0], 'FUJIFILM X-T5');
  assert.equal(t.Lens[0], 'XF23mmF1.4 R LM WR');
  assert.equal(t.Exposure[0], '1/250 s · f/5.6 · ISO 400');
  assert.equal(t['Focal length'][0], '23 mm (35 mm in 35 mm film terms)');
  assert.equal(t['Serial number'][0], 'camera 5C123456');
  assert.equal(t['Computer name'][0], 'KENJI-MACBOOK');
  assert.equal(t.Description[0], 'Cherry blossoms at the park');
  assert.match(t.IPTC[0], /By-line: Kenji Sato; City: Tokyo/);
  assert.equal(t['Text: Page 2 software'][0], 'Capture One 23');
  assert.match(await page.textContent(`${card(0)} .rexif-note`), /2 pages/);
  d = await download(0);
  assert.equal(d.name, 'meta-clean.tif');
  const tOrig = fs.readFileSync(F('meta.tif')), tp = tiffPages(d.buf), to = tiffPages(tOrig);
  assert.equal(tp.le, true, 'byte order kept');
  assert.equal(tp.pages.length, 2);
  assert.deepEqual(Object.keys(tp.pages[0]).map(Number), [256, 257, 258, 259, 262, 273, 277, 278, 279, 282, 283, 284, 296]);
  assert.deepEqual(Object.keys(tp.pages[1]).map(Number), [254, 256, 257, 258, 259, 262, 273, 277, 278, 279, 297]);
  assert.ok(tiffData(d.buf, tp.pages[0]).equals(tiffData(tOrig, to.pages[0])), 'strips byte-identical');
  assert.ok(tiffData(d.buf, tp.pages[1]).equals(tiffData(tOrig, to.pages[1])), 'second page too');
  for (const str of ['FUJIFILM', 'Kenji', 'KENJI', 'Capture One', 'xmpmeta', 'Tokyo', 'Cherry']) assert.equal(d.buf.includes(str), false, `"${str}" is gone`);
  const tPts = [[5, 5], [30, 5], [5, 20], [30, 20]];
  assert.deepEqual(await decodeShared(d.buf, tPts), await decodeShared(tOrig, tPts));
  await page.waitForSelector(`${card(0)}[data-thumb="ready"]`);

  // Big-endian, tiled, RGBA, orientation 8: the tag is kept (default), tiles relocated.
  t = await table(1);
  assert.deepEqual(t.Orientation, ['Rotate 270° clockwise (8)', 'Kept']);
  assert.equal(t['Owner / author'][0], 'Ana Lopez');
  d = await download(1);
  const oOrig = fs.readFileSync(F('tiled-o8.tif')), op = tiffPages(d.buf), oo = tiffPages(oOrig);
  assert.equal(op.le, false);
  assert.deepEqual(Object.keys(op.pages[0]).map(Number), [256, 257, 258, 259, 262, 274, 277, 282, 283, 284, 296, 322, 323, 324, 325, 338]);
  assert.deepEqual(op.pages[0][274], [8]);
  assert.ok(tiffData(d.buf, op.pages[0]).equals(tiffData(oOrig, oo.pages[0])), 'tiles byte-identical');
  // Independently (Pillow, ImageOps.exif_transpose): upright 32 x 48, red at (4, 40), transparent at (25, 3).
  const oPts = [[4, 40], [4, 5], [25, 3]];
  let ob = await decodeShared(d.buf, oPts);
  assert.deepEqual([ob.w, ob.h], [32, 48]);
  assert.ok(near(ob.px[0], [230, 30, 30]) && near(ob.px[1], [40, 90, 210]) && ob.px[2][3] === 0, JSON.stringify(ob.px));

  // Rotate the pixels: a TIFF comes out as an upright PNG.
  await setMode('bake');
  t = await table(1);
  assert.equal(t.Orientation[1], 'Applied to pixels');
  assert.match(await page.textContent(`${card(1)} .rexif-note`), /re-encoded the photo as PNG/);
  d = await download(1);
  assert.equal(d.name, 'tiled-o8-clean.png');
  assert.deepEqual(pngChunks(d.buf, assert).map(c => c.type).filter(x => x !== 'IDAT'), ['IHDR', 'IEND']);
  ob = await decode(d.buf, oPts);
  assert.deepEqual([ob.w, ob.h], [32, 48]);
  assert.ok(near(ob.px[0], [230, 30, 30]) && ob.px[2][3] === 0, JSON.stringify(ob.px));
  // A TIFF without the tag stays a lossless TIFF in this mode.
  assert.equal((await download(0)).name, 'meta-clean.tif');
  await setMode('strip');
  d = await download(1);
  assert.equal(tiffPages(d.buf).pages[0][274], undefined, 'orientation removed too');
  await setMode('keep');

  // ---------- GIF: comment, XMP, IPTC and trailing data removed, both frames kept ----------
  await clear();
  await page.setInputFiles('#rexif-file', F('meta.gif'));
  await idle();
  t = await table(0);
  assert.equal(t.Comment[0], 'Taken at 12 Rue de Rivoli, Paris by Marie');
  assert.match(t.XMP[0], /includes GPS location, made with Adobe Photoshop 25\.0/);
  assert.match(t.IPTC[0], /By-line: Marie/);
  assert.match(t['Data after the image'][0], /^29 bytes/);
  assert.match(await page.textContent(`${card(0)} .rexif-gps`), /GPS coordinates in its XMP/);
  d = await download(0);
  const gOrig = fs.readFileSync(F('meta.gif')), gb = gifBlocks(d.buf), go = gifBlocks(gOrig);
  assert.equal(gb.end, d.buf.length, 'ends at the trailer');
  assert.deepEqual(gb.blocks.map(b => b.kind === 'img' ? 'img' : b.label.toString(16) + (b.app ? ':' + b.app : '')),
    ['ff:NETSCAPE2.0', 'f9', 'img', 'f9', 'img'], 'loop count, timing and frames only');
  assert.deepEqual(gb.blocks.filter(b => b.kind === 'img').map(b => b.bytes.toString('hex')), go.blocks.filter(b => b.kind === 'img').map(b => b.bytes.toString('hex')));
  assert.ok(d.buf.subarray(0, 13).equals(gOrig.subarray(0, 13)));
  for (const str of ['Rivoli', 'Marie', 'XMP', 'Photoshop', 'extra bytes']) assert.equal(d.buf.includes(str), false, `"${str}" is gone`);
  img = await decode(d.buf, [[3, 3], [20, 3]]);
  assert.deepEqual([img.w, img.h], [24, 16]);
  assert.ok(near(img.px[0], [230, 30, 30]) && near(img.px[1], [40, 90, 210]), JSON.stringify(img.px));
};
