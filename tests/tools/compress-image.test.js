const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Independent JPEG reader (ITU T.81): frame size from SOFn, the first quantisation value of
// table 0 (the DC step of the luminance table) and the APPn segments.
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const info = { dqt: {}, app: [] };
  let i = 2;
  while (i < buf.length) {
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m === 0xdb) {
      let p = i + 4;
      while (p < i + 2 + len) {
        const pq = buf[p] >> 4, tq = buf[p] & 15;
        info.dqt[tq] = pq ? buf.readUInt16BE(p + 1) : buf[p + 1];
        p += 1 + 64 * (pq ? 2 : 1);
      }
    }
    if (m >= 0xe0 && m <= 0xef) info.app.push({ m, data: buf.subarray(i + 4, i + 2 + len) });
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      info.height = buf.readUInt16BE(i + 5);
      info.width = buf.readUInt16BE(i + 7);
    }
    if (m === 0xda) break;
    i += 2 + len;
  }
  return info;
}
// IJG libjpeg quality scaling (jcparam.c) applied to the Annex K luminance DC value 16.
function ijgDc(q) {
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q;
  return Math.min(255, Math.max(1, Math.floor((16 * scale + 50) / 100)));
}
// TIFF (EXIF) IFD0 tags and whether a GPS sub-IFD with entries exists.
function exifTags(tiff) {
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)), u32 = o => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const off = u32(4), n = u16(off), tags = {};
  for (let k = 0; k < n; k++) {
    const e = off + 2 + k * 12, type = u16(e + 2), count = u32(e + 4);
    tags[u16(e)] = type === 2 ? tiff.toString('latin1', count <= 4 ? e + 8 : u32(e + 8), (count <= 4 ? e + 8 : u32(e + 8)) + count - 1)
      : type === 3 ? u16(e + 8) : u32(e + 8);
  }
  return { tags, gpsEntries: tags[0x8825] ? u16(tags[0x8825]) : 0 };
}
const kb = n => (n < 1e5 ? (n / 1000).toFixed(1) : (n / 1000).toFixed(0)) + ' KB';
// RIFF/WebP chunk types in order (VP8 = lossy, VP8L = lossless).
function webpChunks(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not WebP');
  const types = [];
  for (let o = 12; o + 8 <= buf.length;) {
    const size = buf.readUInt32LE(o + 4);
    types.push(buf.toString('latin1', o, o + 4));
    o += 8 + size + (size & 1);
  }
  return types;
}
// Independent PNG decoder (ISO/IEC 15948): colour types 2, 3 (bit depths 1-8, PLTE + tRNS) and 6,
// non-interlaced, all five filters. Returns RGBA pixels.
function decodePng(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let o = 8, ihdr = null, plte = null, trns = null;
  const idat = [], types = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    types.push(type);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    if (type === 'PLTE') plte = data;
    if (type === 'tRNS') trns = data;
    if (type === 'IDAT') idat.push(data);
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
  return { w, h, type, depth, types, palette: plte ? plte.length / 3 : 0, px, at: (x, y) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)] };
}
// PSNR of the colour, both images composited on white.
function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) {
    const x = a[i + c] * a[i + 3] / 255 + 255 - a[i + 3], y = b[i + c] * b[i + 3] / 255 + 255 - b[i + 3];
    se += (x - y) ** 2;
  }
  return 10 * Math.log10(255 * 255 / (se / (a.length * 3 / 4)));
}
// ZIP (APPNOTE 6.3) entries from the central directory.
function unzip(buf) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const out = {};
  for (let i = 0, p = buf.readUInt32LE(eocd + 16); i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen), lho = buf.readUInt32LE(p + 42);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(start, start + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert32(zlib.crc32(out[name]), buf.readUInt32LE(p + 16), name);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}
function assert32(a, b, name) { if (a !== b) throw new Error(`CRC mismatch in ${name}`); }

module.exports = async ({ page, open, assert, fixtures, url }) => {
  await open();
  const F = n => path.join(fixtures, n);
  const orig = fs.readFileSync(F('photo.jpg'));
  const text = s => page.textContent(s);
  const settle = async () => {
    await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('#cmpi-result').dataset.state) &&
      !document.querySelector('.cmpi-item[data-state="working"], .cmpi-item[data-state="queued"]'), null, { timeout: 30000 });
    return page.getAttribute('#cmpi-result', 'data-state');
  };
  async function download(sel = '#cmpi-download') {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  }
  const decode = (buf, points = []) => page.evaluate(async ([b64, pts]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, px: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) };
  }, [buf.toString('base64'), points]);
  const setQuality = q => page.$eval('#cmpi-quality', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, q);
  const near = (p, rgba, tol = 12) => rgba.every((v, k) => Math.abs(p[k] - v) <= tol);
  // Re-encode the original photo with the page's plain <canvas> (not the tool's code) at quality q.
  const encodeAt = qq => page.evaluate(async ([b64, qv]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0);
    return (await new Promise(r => c.toBlob(r, 'image/jpeg', qv / 100))).size;
  }, [orig.toString('base64'), qq]);
  // "Clear all" sits with the list, which only shows for two or more images.
  const clearAll = async () => {
    if (await page.isVisible('#cmpi-clear')) await page.click('#cmpi-clear');
    else await page.$eval('#cmpi-clear', btn => btn.click());
    assert.equal(await page.isVisible('#cmpi-result'), false);
  };

  assert.equal(await page.isVisible('#cmpi-result'), false);
  assert.equal(await page.isVisible('#cmpi-target'), true);
  assert.equal(await page.isVisible('#cmpi-quality'), false);
  assert.equal(await page.inputValue('#cmpi-format'), 'auto');
  assert.equal(await page.locator('#cmpi-format option[value="avif"]').count(), 0, 'Chromium cannot encode AVIF, so it is not offered');

  // ---------- Default: a JPG stays JPG, under 100 KB ----------
  await page.setInputFiles('#cmpi-file', F('photo.jpg'));
  assert.equal(await settle(), 'done');
  let d = await download();
  assert.equal(d.name, 'photo-compressed.jpg');
  assert.ok(d.buf.length <= 100000, `${d.buf.length} <= 100000`);
  assert.ok(d.buf.length > 80000, `the search gets close to the limit: ${d.buf.length}`);
  let j = jpegInfo(d.buf);
  assert.deepEqual([j.width, j.height], [1000, 700]);
  let q = parseInt(await text('#cmpi-q'), 10);
  assert.equal(j.dqt[0], ijgDc(q), `quantiser matches ${q}% quality`);
  assert.equal(await text('#cmpi-orig'), kb(orig.length));
  assert.equal(await text('#cmpi-size'), kb(d.buf.length));
  assert.equal(await text('#cmpi-saved'), Math.round((1 - d.buf.length / orig.length) * 100) + '%');
  assert.equal(await text('#cmpi-dims'), '1000 × 700');
  assert.ok((await text('#cmpi-bytes')).includes(`${d.buf.length.toLocaleString('en-US')} bytes (limit 100,000 bytes)`));
  assert.equal(await page.isVisible('#cmpi-batch'), false, 'no list for a single image');
  assert.equal(j.app.filter(a => a.m === 0xe1).length, 0, 'no EXIF by default');
  await page.waitForFunction(() => /^Compressed to .* KB, \d+% smaller\.$/.test(document.querySelector('#cmpi-live').textContent));

  // ---------- 50 KB preset: the result is the highest quality that fits ----------
  await page.click('.cmpi-presets [data-kb="50"]');
  assert.equal(await page.getAttribute('.cmpi-presets [data-kb="50"]', 'aria-pressed'), 'true');
  assert.equal(await settle(), 'done');
  d = await download();
  assert.ok(d.buf.length <= 50000 && d.buf.length > 40000, `50 KB target gave ${d.buf.length} bytes`);
  j = jpegInfo(d.buf);
  q = parseInt(await text('#cmpi-q'), 10);
  assert.ok(q >= 30 && q < 95, `quality ${q}`);
  assert.equal(j.dqt[0], ijgDc(q));
  const nextSize = await encodeAt(q + 1);
  assert.ok(nextSize > 50000, `quality ${q + 1} would be ${nextSize} bytes`);
  const d50 = d.buf;

  // ---------- A limit above the original: never larger than the original ----------
  await page.fill('#cmpi-target', '500');
  assert.equal(await settle(), 'done');
  d = await download();
  q = parseInt(await text('#cmpi-q'), 10);
  assert.ok(d.buf.length <= orig.length, `${d.buf.length} <= original ${orig.length}`);
  assert.ok(await encodeAt(Math.min(95, q + 1)) > orig.length || q === 95, 'one step higher would be larger than the original');
  assert.match(await text('#cmpi-note'), /Your original is only 188 KB, so the result was kept smaller than that/);

  // ---------- Unreachable at the 30% floor: scaled down ----------
  await page.fill('#cmpi-target', '4');
  assert.equal(await settle(), 'done');
  const note = await text('#cmpi-note');
  const m = /scaled down to (\d+) × (\d+) px/.exec(note);
  assert.ok(m, note);
  d = await download();
  assert.ok(d.buf.length <= 4000, `${d.buf.length} <= 4000`);
  j = jpegInfo(d.buf);
  assert.deepEqual([j.width, j.height], [Number(m[1]), Number(m[2])]);
  assert.ok(j.width < 1000 && Math.abs(j.width / j.height - 1000 / 700) < 0.02, `${j.width}x${j.height} keeps the aspect ratio`);

  // ---------- Quality mode ----------
  await page.check('input[name="cmpi-mode"][value="quality"]');
  assert.equal(await page.isVisible('#cmpi-quality'), true);
  assert.equal(await page.isVisible('#cmpi-target'), false);
  assert.equal(await page.isVisible('#cmpi-png-field'), false, 'no PNG options for a JPG');
  await settle();
  await setQuality(90);
  assert.equal(await settle(), 'done');
  assert.equal(await text('#cmpi-quality-out'), '90%');
  assert.equal(await page.getAttribute('#cmpi-quality', 'aria-valuetext'), '90%');
  const d90 = await download();
  j = jpegInfo(d90.buf);
  assert.deepEqual([j.width, j.height, j.dqt[0]], [1000, 700, ijgDc(90)]);
  assert.equal(ijgDc(90), 3);
  await setQuality(30);
  assert.equal(await settle(), 'done');
  const d30 = await download();
  j = jpegInfo(d30.buf);
  assert.deepEqual([j.width, j.height, j.dqt[0]], [1000, 700, 27]);
  assert.ok(d30.buf.length < d90.buf.length * 0.6, `${d30.buf.length} vs ${d90.buf.length}`);
  assert.equal(await text('#cmpi-q'), '30%');

  // ---------- Resize and WebP ----------
  await page.selectOption('#cmpi-resize', '640');
  assert.equal(await settle(), 'done');
  j = jpegInfo((await download()).buf);
  assert.deepEqual([j.width, j.height], [640, 448]);
  assert.equal(await page.isVisible('#cmpi-maxpx'), false);
  await page.selectOption('#cmpi-resize', 'custom');
  assert.equal(await page.isVisible('#cmpi-maxpx'), true);
  await settle();
  await page.fill('#cmpi-maxpx', '500');
  assert.equal(await settle(), 'done');
  j = jpegInfo((await download()).buf);
  assert.deepEqual([j.width, j.height], [500, 350]);
  await page.fill('#cmpi-maxpx', '5');
  assert.equal(await settle(), 'error');
  assert.match(await text('#cmpi-error'), /between 16 and 20,000 px/);
  await page.fill('#cmpi-maxpx', '640');
  assert.equal(await settle(), 'done');
  await page.selectOption('#cmpi-format', 'webp');
  assert.equal(await settle(), 'done');
  d = await download();
  assert.equal(d.name, 'photo-compressed.webp');
  assert.equal(d.buf.toString('latin1', 0, 4) + d.buf.toString('latin1', 8, 12), 'RIFFWEBP');
  let img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [640, 448]);
  await page.selectOption('#cmpi-resize', '0');
  await settle();

  // ---------- Transparent PNG as JPG and WebP ----------
  await page.selectOption('#cmpi-format', 'jpeg');
  await settle();
  await page.check('input[name="cmpi-mode"][value="target"]');
  await page.fill('#cmpi-target', '100');
  await settle();
  await clearAll();
  await page.setInputFiles('#cmpi-file', F('logo.png'));
  assert.equal(await settle(), 'done');
  assert.match(await text('#cmpi-note'), /filled with white/);
  assert.match(await text('#cmpi-note'), /larger than your original/);
  assert.match(await text('#cmpi-drop-title'), /logo\.png/);
  d = await download();
  assert.equal(d.name, 'logo-compressed.jpg');
  img = await decode(d.buf, [[2, 2], [150, 100], [60, 100]]);
  assert.deepEqual([img.w, img.h], [300, 200]);
  assert.ok(near(img.px[0], [255, 255, 255, 255]), `corner flattened to white: ${img.px[0]}`);
  assert.ok(near(img.px[1], [20, 60, 200, 255], 20), `centre stays blue: ${img.px[1]}`);
  assert.ok(near(img.px[2], [220, 40, 60, 255], 20), `shape stays red: ${img.px[2]}`);

  await page.selectOption('#cmpi-format', 'webp');
  assert.equal(await settle(), 'done');
  assert.doesNotMatch(await text('#cmpi-note'), /white/);
  d = await download();
  img = await decode(d.buf, [[2, 2], [150, 100]]);
  assert.equal(img.px[0][3], 0, 'WebP keeps the transparent corner');
  assert.equal(img.px[1][3], 255);

  // ---------- PNG stays PNG: an image with 3 colours is pixel-exact ----------
  await page.selectOption('#cmpi-format', 'auto');
  assert.equal(await settle(), 'done');
  assert.equal(await page.isVisible('#cmpi-png-field'), true, 'PNG options appear for a PNG');
  assert.equal(await page.isVisible('#cmpi-colors'), false, 'colour count is searched in target mode');
  d = await download();
  assert.equal(d.name, 'logo-compressed.png');
  let png = decodePng(d.buf, assert);
  const logo = decodePng(fs.readFileSync(F('logo.png')), assert);
  assert.equal(png.type, 3, 'indexed colour');
  assert.equal(png.palette, 3);
  assert.equal(png.depth, 2, 'three colours need 2 bits per pixel');
  assert.ok(png.px.equals(logo.px), 'every pixel is identical to the original');
  assert.ok(d.buf.length < 1314, `smaller than the original: ${d.buf.length}`);
  assert.equal(await text('#cmpi-q'), '3 colours');
  assert.match(await text('#cmpi-note'), /only 3 colours, so the PNG is pixel-exact/);

  // ---------- Lossy PNG: palette quality on a photo with a transparent mask ----------
  await clearAll();
  await page.setInputFiles('#cmpi-file', F('scene.png'));
  assert.equal(await settle(), 'done');
  const scene = decodePng(fs.readFileSync(F('scene.png')), assert);
  d = await download();
  png = decodePng(d.buf, assert);
  assert.ok(d.buf.length <= 100000, `${d.buf.length}`);
  assert.equal(png.type, 3);
  assert.deepEqual([png.w, png.h], [360, 252]);
  const colours = parseInt(await text('#cmpi-q'), 10);
  assert.ok(colours >= 32 && colours <= 256 && png.palette === colours, `${colours} colours, palette ${png.palette}`);
  let alphaSame = 0;
  for (let i = 3; i < png.px.length; i += 4) if (png.px[i] === scene.px[i]) alphaSame++;
  assert.equal(alphaSame, png.w * png.h, 'the transparent mask is kept exactly');
  const sceneQ = psnr(scene.px, png.px);
  assert.ok(sceneQ > 28, `PSNR ${sceneQ.toFixed(1)} dB`);

  // Quality mode: fixed palettes, with and without dithering.
  await page.check('input[name="cmpi-mode"][value="quality"]');
  assert.equal(await page.isVisible('#cmpi-colors'), true);
  assert.equal(await page.isVisible('#cmpi-quality'), false, 'no JPG quality slider for a PNG');
  await page.selectOption('#cmpi-colors', '16');
  await page.uncheck('#cmpi-dither');
  assert.equal(await settle(), 'done');
  d = await download();
  png = decodePng(d.buf, assert);
  assert.deepEqual([png.palette, png.depth], [16, 4]);
  const plain16 = psnr(scene.px, png.px);
  // A 16-colour palette must beat a fixed 16-level grey or a 2-2-... uniform palette by far:
  // an independent uniform 4x4x... quantisation (R 3 levels, G 3, B 2 = 18 colours) as a floor.
  const uni = Buffer.from(scene.px);
  for (let i = 0; i < uni.length; i += 4) { uni[i] = Math.round(uni[i] / 127.5) * 127.5; uni[i + 1] = Math.round(uni[i + 1] / 127.5) * 127.5; uni[i + 2] = Math.round(uni[i + 2] / 255) * 255; }
  assert.ok(plain16 > psnr(scene.px, uni) + 3, `16-colour median cut ${plain16.toFixed(1)} dB beats a uniform palette ${psnr(scene.px, uni).toFixed(1)} dB`);
  await page.check('#cmpi-dither');
  assert.equal(await settle(), 'done');
  const dith = decodePng((await download()).buf, assert);
  assert.equal(dith.palette, 16);
  // Dithering: 3x3 box-blurred, the dithered image is closer to the original than the plain one.
  const blur = (px, w, h) => {
    const out = Buffer.alloc(px.length);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += px[((y + dy) * w + x + dx) * 4 + c];
      out[(y * w + x) * 4 + c] = Math.round(s / 9);
    }
    return out;
  };
  assert.ok(psnr(blur(scene.px, 360, 252), blur(dith.px, 360, 252)) > psnr(blur(scene.px, 360, 252), blur(png.px, 360, 252)), 'dithering spreads the error');
  await page.selectOption('#cmpi-colors', '0');
  assert.equal(await settle(), 'done');
  d = await download();
  png = decodePng(d.buf, assert);
  assert.equal(await text('#cmpi-q'), 'Lossless');
  assert.ok(png.px.equals(scene.px) || psnr(scene.px, png.px) === Infinity, 'All (lossless) keeps every pixel');
  await page.selectOption('#cmpi-colors', '256');
  await page.check('input[name="cmpi-mode"][value="target"]');
  await settle();

  // Gradients with an alpha ramp: fully transparent stays fully transparent, opaque stays opaque.
  await page.setInputFiles('#cmpi-file', F('gradient.png'));
  assert.equal(await settle(), 'done');
  const grad = decodePng(fs.readFileSync(F('gradient.png')), assert);
  png = decodePng((await download()).buf, assert);
  assert.equal(await page.isVisible('#cmpi-batch'), true, 'two images: the list appears');
  for (const [x, y] of [[10, 10], [250, 100], [220, 150]]) {
    assert.ok(near(png.at(x, y), grad.at(x, y), 24), `(${x},${y}) ${png.at(x, y)} vs ${grad.at(x, y)}`);
  }
  assert.equal(png.at(230, 150)[3], 0, 'transparent corner');
  assert.equal(png.at(10, 60)[3], 255, 'opaque area');
  assert.ok(Math.abs(png.at(128, 130)[3] - 128) < 24, `alpha ramp midpoint ${png.at(128, 130)[3]}`);

  // ---------- Compare view: transparent parts of the original show the checkerboard ----------
  await clearAll();
  await page.setInputFiles('#cmpi-file', F('logo.png'));
  await page.selectOption('#cmpi-format', 'jpeg');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await settle(), 'done');
  await page.$eval('#cmpi-split', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#cmpi-compare').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#cmpi-after').complete && document.querySelector('#cmpi-before').complete &&
    document.querySelector('#cmpi-after').naturalWidth > 0 && document.querySelector('#cmpi-before').naturalWidth > 0);
  const shot = await page.locator('#cmpi-compare').screenshot();
  const corners = await page.evaluate(async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
    return { left: at(3, bmp.height - 4), right: at(bmp.width - 4, bmp.height - 4) };
  }, shot.toString('base64'));
  assert.ok(corners.left[0] < 90 && corners.left[1] < 90, `original's transparent corner is dark checkerboard: ${corners.left}`);
  assert.ok(near(corners.right, [255, 255, 255, 255], 6), `compressed JPG corner is white: ${corners.right}`);
  await page.emulateMedia({ colorScheme: 'light' });

  // ---------- Compare slider ----------
  await page.$eval('#cmpi-split', el => { el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cmpi-compare', el => el.style.getPropertyValue('--pos')), '20%');
  await page.locator('#cmpi-compare').scrollIntoViewIfNeeded();
  const box = await page.locator('#cmpi-compare').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  assert.equal(await page.inputValue('#cmpi-split'), '75');

  // ---------- Errors ----------
  await page.fill('#cmpi-target', '0');
  assert.equal(await settle(), 'error');
  assert.match(await text('#cmpi-error'), /between 1 and 100,000 KB/);
  assert.equal(await page.isDisabled('#cmpi-download'), true);
  await page.fill('#cmpi-target', '50');
  assert.equal(await settle(), 'done');
  assert.equal(await text('#cmpi-error'), '');

  await page.setInputFiles('#cmpi-file', { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('definitely not an image') });
  assert.equal(await settle(), 'error');
  assert.match(await text('#cmpi-error'), /not a supported image/);
  assert.match(await text('.cmpi-item[data-state="error"] .hint'), /not a supported image/);
  assert.equal(await page.isDisabled('.cmpi-item[data-state="error"] [data-act="dl"]'), true);

  // ---------- Keep the width and height: go below 30% quality instead of shrinking ----------
  // Independently measured: this photo is 35,573 bytes at q30 and 5,866 bytes at q1.
  await clearAll();
  await page.setInputFiles('#cmpi-file', F('photo.jpg'));
  assert.equal(await settle(), 'done');
  await page.fill('#cmpi-target', '20');
  assert.equal(await settle(), 'done');
  assert.match(await text('#cmpi-note'), /scaled down to/, 'by default the image shrinks');
  await page.check('#cmpi-keepsize');
  assert.equal(await settle(), 'done');
  d = await download();
  j = jpegInfo(d.buf);
  q = parseInt(await text('#cmpi-q'), 10);
  assert.deepEqual([j.width, j.height], [1000, 700], 'dimensions kept');
  assert.ok(q >= 1 && q < 30, `quality ${q}`);
  assert.equal(j.dqt[0], ijgDc(q));
  assert.ok(d.buf.length <= 20000, `${d.buf.length} <= 20000`);
  assert.ok(await encodeAt(q + 1) > 20000, 'one step higher would not fit');
  assert.match(await text('#cmpi-note'), new RegExp(`keep all 1000 × 700 px, the quality had to drop to ${q}%`));
  await page.fill('#cmpi-target', '5');
  assert.equal(await settle(), 'error');
  assert.match(await text('#cmpi-error'), /Even at 1% quality this image is 5\.9 KB at 1000 × 700 px/);
  await page.uncheck('#cmpi-keepsize');
  assert.equal(await settle(), 'done');
  assert.ok(parseInt(await text('#cmpi-dims'), 10) < 1000, 'shrinks again once unticked');

  // ---------- SVG: rendered on the page ----------
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#2050c0"/><circle cx="200" cy="150" r="80" fill="#e02040"/></svg>';
  await page.fill('#cmpi-target', '50');
  await settle();
  await clearAll();
  await page.setInputFiles('#cmpi-file', { name: 'shape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  assert.equal(await settle(), 'done');
  d = await download();
  assert.equal(d.name, 'shape-compressed.jpg', 'JPG is chosen');
  img = await decode(d.buf, [[200, 150], [10, 10]]);
  assert.deepEqual([img.w, img.h], [400, 300]);
  assert.ok(near(img.px[0], [224, 32, 64, 255], 20), `circle ${img.px[0]}`);
  assert.ok(near(img.px[1], [32, 80, 192, 255], 20), `background ${img.px[1]}`);
  // ...and a photo afterwards gives the same bytes as before.
  await clearAll();
  await page.setInputFiles('#cmpi-file', F('photo.jpg'));
  assert.equal(await settle(), 'done');
  assert.ok((await download()).buf.equals(d50), 'same 50 KB result as before');

  // ---------- A browser without OffscreenCanvas encodes on the page, with identical output ----------
  const p2 = await page.context().newPage();
  const p2errors = [];
  p2.on('pageerror', e => p2errors.push(e.message));
  p2.on('console', msg => { if (msg.type() === 'error') p2errors.push(msg.text()); });
  await p2.addInitScript(() => { delete window.OffscreenCanvas; });
  await p2.goto(url);
  assert.equal(await p2.evaluate(() => typeof OffscreenCanvas), 'undefined');
  await p2.setInputFiles('#cmpi-file', F('photo.jpg'));
  await p2.click('.cmpi-presets [data-kb="50"]');
  await p2.waitForFunction(() => document.querySelector('#cmpi-result').dataset.state === 'done' && document.querySelector('#cmpi-bytes').textContent.includes('limit 50,000'), null, { timeout: 30000 });
  const [dl2] = await Promise.all([p2.waitForEvent('download'), p2.click('#cmpi-download')]);
  assert.ok(fs.readFileSync(await dl2.path()).equals(d50), 'fallback gives the same bytes as the worker');
  // The palette PNG also works without a worker.
  await p2.setInputFiles('#cmpi-file', F('logo.png'));
  await p2.waitForFunction(() => document.querySelector('#cmpi-result').dataset.state === 'done' && /logo/.test(document.querySelector('#cmpi-current').textContent), null, { timeout: 30000 });
  const [dl3] = await Promise.all([p2.waitForEvent('download'), p2.click('#cmpi-download')]);
  assert.ok(decodePng(fs.readFileSync(await dl3.path()), assert).px.equals(logo.px));
  assert.deepEqual(p2errors, []);
  await p2.close();

  // ---------- Actual size: the scrolling stage can be focused and panned from the keyboard ----------
  assert.equal(await page.getAttribute('#cmpi-stage', 'tabindex'), null, 'not a tab stop while it does not scroll');
  await page.check('#cmpi-zoom');
  const zs = await page.$eval('#cmpi-stage', s => ({ tab: s.getAttribute('tabindex'), role: s.getAttribute('role'), label: s.getAttribute('aria-label'),
    scrolls: s.scrollWidth > s.clientWidth || s.scrollHeight > s.clientHeight }));
  assert.deepEqual(zs, { tab: '0', role: 'region', label: 'Comparison at actual size (scroll to pan)', scrolls: true });
  await page.focus('#cmpi-stage');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => { const s = document.querySelector('#cmpi-stage'); return s.scrollLeft > 0 || s.scrollTop > 0; });
  await page.uncheck('#cmpi-zoom');
  assert.deepEqual(await page.$eval('#cmpi-stage', s => [s.getAttribute('tabindex'), s.getAttribute('role'), s.getAttribute('aria-label')]), [null, null, null]);

  // ---------- WebP at 100% quality is lossless, and the page says so ----------
  await page.selectOption('#cmpi-format', 'webp');
  await page.check('input[name="cmpi-mode"][value="quality"]');
  await setQuality(100);
  assert.equal(await settle(), 'done');
  d = await download();
  assert.ok(webpChunks(d.buf).includes('VP8L'), `lossless bitstream: ${webpChunks(d.buf)}`);
  assert.match(await text('#cmpi-note'), /This WebP is lossless/);
  await setQuality(99);
  assert.equal(await settle(), 'done');
  d = await download();
  assert.ok(webpChunks(d.buf).includes('VP8 '), `lossy bitstream: ${webpChunks(d.buf)}`);
  assert.doesNotMatch(await text('#cmpi-note'), /lossless/);

  // ---------- Photo details (EXIF): removed, kept without GPS, or kept ----------
  // exif.jpg: Canon EOS 80D, GPS IFD, Orientation 6 (stored 120 x 80, shown 80 x 120).
  await setQuality(80);
  await page.selectOption('#cmpi-format', 'jpeg');
  await clearAll();
  await page.setInputFiles('#cmpi-file', F('exif.jpg'));
  assert.equal(await settle(), 'done');
  const app1 = buf => jpegInfo(buf).app.filter(a => a.m === 0xe1 && a.data.toString('latin1', 0, 6) === 'Exif\0\0');
  d = await download();
  assert.equal(app1(d.buf).length, 0, 'removed by default');
  assert.deepEqual([jpegInfo(d.buf).width, jpegInfo(d.buf).height], [80, 120], 'rotation applied to the pixels');
  await page.selectOption('#cmpi-meta', 'nogps');
  assert.equal(await settle(), 'done');
  d = await download();
  let ex = exifTags(app1(d.buf)[0].data.subarray(6));
  assert.equal(ex.tags[0x010f], 'Canon');
  assert.equal(ex.tags[0x0112], 1, 'orientation reset: the pixels are upright');
  assert.equal(ex.gpsEntries, 0, 'no GPS');
  assert.equal(d.buf.includes('GPS'), false);
  assert.match(await text('#cmpi-note'), /kept, without the location/);
  await page.selectOption('#cmpi-meta', 'keep');
  assert.equal(await settle(), 'done');
  ex = exifTags(app1((await download()).buf)[0].data.subarray(6));
  assert.ok(ex.gpsEntries > 0, 'GPS kept when asked');
  await page.selectOption('#cmpi-format', 'png');
  assert.equal(await settle(), 'done');
  assert.match(await text('#cmpi-note'), /kept only in JPG and WebP/);
  await page.selectOption('#cmpi-meta', 'strip');
  await page.selectOption('#cmpi-format', 'auto');
  await page.check('input[name="cmpi-mode"][value="target"]');
  await page.fill('#cmpi-target', '100');
  await settle();

  // ---------- Batch: HEIC, TIFF, GIF and BMP in; one ZIP out ----------
  await clearAll();
  await page.setInputFiles('#cmpi-file', ['gps.heic', 'tiled-o8.tif', 'anim.gif', 'green.bmp'].map(F));
  assert.equal(await settle(), 'done');
  assert.equal(await page.locator('.cmpi-item').count(), 4);
  assert.equal(await page.locator('.cmpi-item[data-state="done"]').count(), 4);
  assert.match(await text('#cmpi-batch-sum'), /^4 images · .* → .* \(−\d+%\)$/);
  await page.waitForFunction(() => /^Compressed 4 images: .* to .*\.$/.test(document.querySelector('#cmpi-live').textContent));
  const rows = await page.$$eval('.cmpi-item .hint', els => els.map(e => e.textContent));
  assert.match(rows[0], /^JPG · 96 × 64 px/, 'HEIC becomes JPG');
  assert.match(rows[1], /^PNG · 32 × 48 px/, 'a TIFF with transparency becomes PNG, upright (orientation 8)');
  assert.match(rows[2], /^PNG · 40 × 30 px/, 'GIF becomes PNG');
  assert.match(rows[3], /^JPG · 50 × 30 px/, 'BMP becomes JPG');
  assert.equal(await page.getAttribute('.cmpi-item:nth-child(1)', 'aria-current'), 'true', 'the first new image is previewed');
  const one = {};
  for (let i = 1; i <= 4; i++) {
    const r = await download(`.cmpi-item:nth-child(${i}) [data-act="dl"]`);
    one[r.name] = r.buf;
  }
  assert.deepEqual(Object.keys(one), ['gps-compressed.jpg', 'tiled-o8-compressed.png', 'anim-compressed.png', 'green-compressed.jpg']);
  img = await decode(one['gps-compressed.jpg'], [[10, 10], [80, 10], [10, 55], [80, 55]]);
  assert.deepEqual([img.w, img.h], [96, 64]);
  assert.ok(near(img.px[0], [230, 30, 30], 30) && near(img.px[1], [30, 200, 60], 30) && near(img.px[2], [40, 90, 210], 30) && near(img.px[3], [240, 220, 40], 30), JSON.stringify(img.px));
  png = decodePng(one['tiled-o8-compressed.png'], assert);
  assert.deepEqual([png.w, png.h], [32, 48]);
  assert.ok(near(png.at(4, 40), [230, 30, 30, 255], 4) && png.at(25, 3)[3] === 0, 'upright, transparency kept');
  png = decodePng(one['anim-compressed.png'], assert);
  assert.deepEqual([png.w, png.h, png.type], [40, 30, 3]);
  assert.deepEqual(png.at(1, 1), [255, 0, 0, 255], 'first frame, exact colours');
  await page.click('.cmpi-item:nth-child(3) [data-act="show"]');
  assert.equal(await page.getAttribute('.cmpi-item:nth-child(3) [data-act="show"]', 'aria-pressed'), 'true');
  assert.match(await text('#cmpi-current'), /anim\.gif/);
  assert.match(await text('#cmpi-note'), /Only the first frame/);
  // The HEIC original cannot be shown by the browser, so its preview is drawn by the decoder.
  await page.click('.cmpi-item:nth-child(1) [data-act="show"]');
  await page.waitForFunction(() => document.querySelector('#cmpi-before').naturalWidth === 96);
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#cmpi-zip')]);
  assert.equal(zdl.suggestedFilename(), 'compressed-images.zip');
  const zip = unzip(fs.readFileSync(await zdl.path()));
  assert.deepEqual(Object.keys(zip).sort(), Object.keys(one).sort());
  for (const n of Object.keys(one)) assert.ok(zip[n].equals(one[n]), `${n} in the ZIP matches its own download`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cmpi-zip', 'focus stays on the ZIP button');

  // Settings apply to every image; removing one moves focus to the next row.
  await page.selectOption('#cmpi-format', 'webp');
  assert.equal(await settle(), 'done');
  assert.equal((await page.$$eval('.cmpi-item .hint', els => els.map(e => e.textContent))).filter(t => /^WebP/.test(t)).length, 4);
  await page.click('.cmpi-item:nth-child(2) [data-act="rm"]');
  assert.equal(await page.locator('.cmpi-item').count(), 3);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove anim.gif');
  await page.click('#cmpi-clear');
  assert.equal(await page.isVisible('#cmpi-batch'), false);
  assert.equal(await page.isVisible('#cmpi-result'), false);

  // ---------- A file that cannot be opened, before any image: no empty result panel ----------
  await open();
  await page.setInputFiles('#cmpi-file', { name: 'nope.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a picture') });
  await page.waitForFunction(() => document.querySelector('#cmpi-error').textContent.length > 0);
  assert.match(await text('#cmpi-error'), /not a supported image/);
  assert.equal(await page.isVisible('#cmpi-result'), false);
};
