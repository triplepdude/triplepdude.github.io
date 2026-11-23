'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { execFileSync } = require('child_process');
const { devices, chromium } = require('playwright');

// ---------- Independent readers ----------

// PNG (ISO/IEC 15948): 8-bit RGB or RGBA, non-interlaced, all five filters; checks every chunk's CRC.
function decodePng(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let o = 8, ihdr = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
    if (type === 'IEND') break;
  }
  assert.equal(o, buf.length, 'nothing after IEND');
  assert.equal(ihdr.depth, 8);
  assert.equal(ihdr.interlace, 0);
  assert.ok(ihdr.type === 6 || ihdr.type === 2, `colour type ${ihdr.type}`);
  const bpp = ihdr.type === 6 ? 4 : 3, stride = ihdr.w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(ihdr.h * stride);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0;
      const b = y ? px[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y ? px[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][f]) & 255;
    }
  }
  const at = (x, y) => { const k = y * stride + x * bpp; return bpp === 4 ? [...px.subarray(k, k + 4)] : [...px.subarray(k, k + 3), 255]; };
  return {
    w: ihdr.w, h: ihdr.h, at,
    // Every distinct colour, as "r,g,b,a" strings.
    colours() { const s = new Set(); for (let y = 0; y < ihdr.h; y++) for (let x = 0; x < ihdr.w; x++) s.add(at(x, y).join()); return [...s]; },
    // The box of the pixels for which test(rgba) holds, or null.
    box(test) {
      let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
      for (let y = 0; y < ihdr.h; y++) for (let x = 0; x < ihdr.w; x++) if (test(at(x, y))) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
      return x2 < 0 ? null : { x1, y1, x2, y2 };
    },
    count(test) { let n = 0; for (let y = 0; y < ihdr.h; y++) for (let x = 0; x < ihdr.w; x++) if (test(at(x, y), x, y)) n++; return n; },
  };
}

// ICO (the Windows icon directory): every entry a 32-bit PNG of the size its directory entry gives,
// stored one after another.
function parseIco(buf, assert) {
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type is icon');
  const n = buf.readUInt16LE(4), out = [];
  let end = 6 + 16 * n;
  for (let i = 0; i < n; i++) {
    const o = 6 + 16 * i, w = buf[o] || 256, h = buf[o + 1] || 256;
    assert.equal(buf[o + 2], 0, 'no palette');
    assert.equal(buf[o + 3], 0, 'reserved byte');
    assert.equal(buf.readUInt16LE(o + 4), 1, 'one plane');
    assert.equal(buf.readUInt16LE(o + 6), 32, '32 bits a pixel');
    const size = buf.readUInt32LE(o + 8), off = buf.readUInt32LE(o + 12);
    assert.equal(off, end, `entry ${i} starts where the previous one ends`);
    end = off + size;
    const png = decodePng(buf.subarray(off, off + size), assert);
    assert.deepEqual([png.w, png.h], [w, h], 'the PNG has the size of its directory entry');
    out.push(png);
  }
  assert.equal(end, buf.length, 'the file ends with its last entry');
  return out;
}

// Entries of a ZIP file (stored or deflated), read from its central directory.
function unzip(buf) {
  let e = buf.length - 22;
  while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = new Map();
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

// The numbers in an SVG path's d attribute, as [x, y] pairs (the page writes absolute M, L, C, Q and Z).
function pathBox(d) {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number), xs = [], ys = [];
  for (let i = 0; i + 1 < n.length; i += 2) { xs.push(n[i]); ys.push(n[i + 1]); }
  return { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
}

const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const FILES = ['favicon.ico', 'icon.svg', 'favicon-96x96.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'site.webmanifest'];
const SNIPPET = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="icon" href="/icon.svg" type="image/svg+xml">',
  '<link rel="icon" href="/favicon-96x96.png" type="image/png" sizes="96x96">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<link rel="manifest" href="/site.webmanifest">',
].join('\n');

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const fx = n => path.join(fixtures, n);
  const other = (dir, n) => path.join(fixtures, '..', dir, n);
  const expected = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  const requests = [];
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  const fontsAsked = () => requests.filter(p => /\.woff2?$/.test(p)).map(p => path.basename(p));

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;

  // The page's own work on a long paste, in main-thread CPU time: the value goes in and is laid out first
  // (the browser's work, as in any text field), then the input event is timed until the next frame.
  async function pasteCost(sel, v) {
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))));
    await page.$eval(sel, (e, v) => { e.value = v; }, v);
    await frame();
    const t = await threadMs();
    await page.$eval(sel, e => e.dispatchEvent(new Event('input', { bubbles: true })));
    await frame();
    return await threadMs() - t;
  }

  await open();
  const text = sel => page.$eval(sel, e => e.textContent);
  const attr = (sel, a) => page.$eval(sel, (e, a) => e.getAttribute(a), a);
  // The sizes beside the files appear once the files for the icon as it is now are made.
  const ready = () => page.waitForFunction(() => document.querySelector('.fav-file[data-file="favicon.ico"] .fav-size').textContent !== '', null, { timeout: 30000 });
  const summaryIs = s => page.waitForFunction(s => document.querySelector('#fav-summary').textContent === s, s, { timeout: 10000 })
    .catch(async () => assert.fail(`summary "${await text('#fav-summary')}", expected "${s}"`));
  // Downloads one file (or the ZIP) the way a visitor does and returns its bytes.
  async function get(file, p = page) {
    const sel = file === 'zip' ? '#fav-zip' : `.fav-file[data-file="${file}"] button`;
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click(sel)]);
    assert.equal(dl.suggestedFilename(), file === 'zip' ? 'favicons.zip' : file);
    return fs.readFileSync(await dl.path());
  }
  const png = async file => decodePng(await get(file), assert);
  // Opens a picture through the file field (a path or { name, mimeType, buffer }) and waits for the outcome.
  async function openImage(file, p = page) {
    const name = typeof file === 'string' ? path.basename(file) : file.name;
    await p.setInputFiles('#fav-file', file);
    await p.waitForFunction(n => document.querySelector('#fav-status').textContent === `Opened ${n}.` ||
      (document.querySelector('#fav-file-error').textContent.includes(n) && !document.querySelector('#fav-status').textContent), name, { timeout: 60000 });
    return { error: await p.textContent('#fav-file-error'), note: await p.textContent('#fav-file-note') };
  }
  const describedBy = async (field, msg) => {
    assert.equal(await attr(field, 'aria-invalid'), 'true', `${field} is marked invalid`);
    assert.ok((await attr(field, 'aria-describedby')).split(/\s+/).includes(msg.slice(1)), `${field} points at ${msg}`);
  };
  const valid = async field => assert.equal(await attr(field, 'aria-invalid'), null, `${field} is not marked invalid`);

  // ---------- The page as it opens: the letter F, its own defaults ----------
  assert.equal(await text('h1'), 'Favicon Generator from Image, Text or Emoji');
  assert.ok(await page.isChecked('#fav-src-text'), 'Text is the first source');
  assert.equal(await page.inputValue('#fav-text'), 'F');
  await summaryIs('Icon from the letters “F” in Inter.');
  await ready();
  assert.equal(await text('#fav-snippet'), SNIPPET);
  assert.deepEqual(fontsAsked(), ['inter-latin-700-normal.woff'], 'only the chosen font is loaded');
  assert.ok(requests.some(p => p.endsWith('/opentype/opentype.min.js')), 'opentype.js loads for the outlines');
  const sizes = await page.$$eval('.fav-file', l => l.map(li => [li.dataset.file, li.querySelector('.fav-size').textContent]));
  assert.deepEqual(sizes.map(s => s[0]), FILES);
  for (const [f, s] of sizes) assert.match(s, /^\d+(\.\d)? (bytes|KB)$/, `${f} shows its size: "${s}"`);
  // Every preview is drawn at its real size.
  const previews = await page.$$eval('.fav-prev canvas', l => l.map(c => {
    const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) ink++;
    return { id: c.id, css: c.getBoundingClientRect().width, ink };
  }));
  assert.deepEqual(previews.map(p => [p.id, p.css]), [['fav-p-tab-light', 16], ['fav-p-tab-dark', 16], ['fav-p-tab-safari', 16], ['fav-p-serp', 18], ['fav-p-ios', 60], ['fav-p-android', 56], ['fav-p-16', 80]]);
  for (const p of previews) assert.ok(p.ink > 0, `${p.id} shows the icon`);

  // ---------- The files for "F": known answers from the font itself (fontTools, in expected.json) ----------
  const files = new Map();
  for (const f of FILES) files.set(f, await get(f));
  const zipF = unzip(await get('zip'));
  assert.deepEqual([...zipF.keys()], [...FILES, 'favicon-snippet.html'], 'the ZIP holds every file and the HTML');
  for (const f of FILES) assert.ok(zipF.get(f).equals(files.get(f)), `${f} in the ZIP is the file the button saves`);
  assert.equal(zipF.get('favicon-snippet.html').toString(), '<!-- Paste these lines into the <head> of every page. -->\n' + SNIPPET + '\n');
  assert.match(await text('#fav-status'), /^Saved favicons\.zip \(\d+(\.\d)? KB\): 9 files\.$/);

  const BLUE = [29, 78, 216, 255], WHITE = [255, 255, 255, 255];
  const ico = parseIco(files.get('favicon.ico'), assert);
  assert.deepEqual(ico.map(p => p.w), [16, 32, 48], 'favicon.ico holds 16, 32 and 48 px pictures');
  for (const p of ico) {
    assert.ok(p.at(0, 0)[3] < 8, `${p.w} px: the rounded corner is transparent (${p.at(0, 0)})`);
    assert.deepEqual(p.at(p.w / 2, 0), BLUE, `${p.w} px: the background colour`);
  }
  assert.deepEqual(ico[2].at(17, 24), WHITE, 'the stem of the F at 48 px');
  const [x0, y0, x1b, y1b] = expected.inter_F.bounds;
  const k = 60 / Math.max(x1b - x0, y1b - y0), fw = (x1b - x0) * k, fh = (y1b - y0) * k;
  const svgF = files.get('icon.svg').toString();
  assert.match(svgF, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">\n/);
  assert.doesNotMatch(svgF, /<text|font-family|<style/, 'the letters are outlines, with no dark style unless asked for');
  const dF = svgF.match(/<path class="fav-ink" style="fill:#ffffff" d="([^"]+)"\/>/)[1];
  const bF = pathBox(dF);
  assert.ok(near([bF.x1, bF.x2, bF.y1, bF.y2], [50 - fw / 2, 50 + fw / 2, 50 - fh / 2, 50 + fh / 2], 0.011), `the F fills 60% of the height, centred: ${JSON.stringify(bF)}`);
  assert.match(svgF, /<rect width="100" height="100" rx="22" class="fav-bg" style="fill:#1d4ed8"\/>/);
  for (const [f, side] of [['favicon-96x96.png', 96], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const p = decodePng(files.get(f), assert), s = side / 100;
    assert.deepEqual([p.w, p.h], [side, side], f);
    assert.equal(p.at(0, 0)[3], 0, `${f}: transparent corner`);
    assert.deepEqual(p.at(side / 2, 1), BLUE, `${f}: background`);
    const ink = p.box(c => c[0] > 200 && c[1] > 200 && c[2] > 200);
    assert.ok(near([ink.x1, ink.x2 + 1, ink.y1, ink.y2 + 1], [bF.x1 * s, bF.x2 * s, bF.y1 * s, bF.y2 * s], 1.01), `${f}: the white letter where the font puts it: ${JSON.stringify(ink)}`);
  }
  const touch = decodePng(files.get('apple-touch-icon.png'), assert);
  assert.deepEqual([touch.w, touch.h], [180, 180]);
  assert.equal(touch.count(c => c[3] !== 255), 0, 'apple-touch-icon.png is opaque');
  assert.deepEqual(touch.at(0, 0), BLUE, 'apple-touch-icon.png fills its corners: iOS rounds them');
  const mask = decodePng(files.get('icon-maskable-512.png'), assert);
  assert.equal(mask.count(c => c[3] !== 255), 0, 'the maskable icon is opaque');
  assert.deepEqual(mask.at(0, 0), BLUE, 'its background runs to the edges');
  const outside = mask.count((c, x, y) => c[0] > 40 && Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 204.8 + 0.75);
  assert.equal(outside, 0, 'the letter stays inside the safe zone, the central circle of radius 40%');
  assert.ok(mask.count(c => c[0] > 200) > 5000, 'the letter is there');
  assert.deepEqual(JSON.parse(files.get('site.webmanifest').toString()), {
    name: 'My site', short_name: 'My site',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme_color: '#1d4ed8', background_color: '#1d4ed8', display: 'standalone', start_url: './',
  });
  // Pillow reads the same pictures, when it is here.
  let pillow = false;
  try { execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }); pillow = true; } catch (e) { console.log('  (favicon-generator: python3 with Pillow is missing: files are checked with the test\'s own readers only)'); }
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'favgen-'));
  const pil = (name, bytes) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, bytes);
    return JSON.parse(execFileSync('python3', [fx('verify.py'), p]).toString());
  };
  if (pillow) {
    const pi = pil('favicon.ico', files.get('favicon.ico'));
    assert.deepEqual(pi.sizes, [[16, 16], [32, 32], [48, 48]], 'Pillow finds the three sizes');
    assert.deepEqual(pi.pixel, ico[2].at(17, 24), 'Pillow reads the 48 px picture as the test does');
    const pm = pil('mask.png', files.get('icon-maskable-512.png'));
    assert.deepEqual([pm.size, pm.mode, pm.alpha_min], [[512, 512], 'RGBA', 255]);
  }

  // ---------- Pair kerning: "AV" is set as the font sets it (Inter keeps its kerning in GPOS Extension lookups) ----------
  const setLetters = v => page.$eval('#fav-text', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setLetters('AV');
  await summaryIs('Icon from the letters “AV” in Inter.');
  const [ax0, ay0, ax1, ay1] = expected.inter_AV.bounds;
  const ka = 60 / Math.max(ax1 - ax0, ay1 - ay0), aw = (ax1 - ax0) * ka, ah = (ay1 - ay0) * ka;
  const bAV = pathBox((await get('icon.svg')).toString().match(/<path class="fav-ink" style="fill:#ffffff" d="([^"]+)"\/>/)[1]);
  assert.ok(near([bAV.x1, bAV.x2, bAV.y1, bAV.y2], [50 - aw / 2, 50 + aw / 2, 50 - ah / 2, 50 + ah / 2], 0.011),
    `"AV" is kerned by the font's ${expected.inter_AV.kern} units: ${JSON.stringify(bAV)}, expected y ${(50 - ah / 2).toFixed(2)} to ${(50 + ah / 2).toFixed(2)}`);
  await setLetters('F');
  await summaryIs('Icon from the letters “F” in Inter.');

  // ---------- Dark style: icon.svg switches colours, the PNGs keep the light ones ----------
  await page.check('#fav-dark');
  assert.ok(await page.isVisible('#fav-dark-ink') && await page.isVisible('#fav-dark-bg'), 'the dark colours appear');
  const svgDark = (await get('icon.svg')).toString();
  assert.match(svgDark, /<style>@media \(prefers-color-scheme:dark\)\{\.fav-bg\{fill:#bfdbfe!important\}\.fav-ink\{fill:#0b1f4d!important\}\}<\/style>/);
  assert.ok((await get('favicon-96x96.png')).equals(files.get('favicon-96x96.png')), 'the PNG keeps the light colours');
  // Chromium draws the SVG with the dark colours when it is in dark mode, as a favicon would.
  const drawSvg = async (svg, scheme) => {
    await page.emulateMedia({ colorScheme: scheme });
    const c = await page.evaluate(async svg => {
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = cv.height = 100;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, 100, 100);
      return [...g.getImageData(50, 2, 1, 1).data, ...g.getImageData(37, 50, 1, 1).data];
    }, svg);
    await page.emulateMedia({ colorScheme: null });
    return c;
  };
  assert.deepEqual(await drawSvg(svgDark, 'light'), [...BLUE, ...WHITE], 'light: blue with a white F');
  assert.deepEqual(await drawSvg(svgDark, 'dark'), [191, 219, 254, 255, 11, 31, 77, 255], 'dark: the dark style');
  const tabPx = id => page.$eval(id, c => [...c.getContext('2d').getImageData(c.width / 2, 1, 1, 1).data]);
  assert.deepEqual(await tabPx('#fav-p-tab-dark'), [191, 219, 254, 255], 'the dark tab preview uses the dark style');
  assert.deepEqual(await tabPx('#fav-p-tab-safari'), BLUE, 'the Safari tab keeps the light colours');
  assert.match(await text('#fav-dark-caption'), /Right: Safari 26 keeps the light one/);
  await page.uncheck('#fav-dark');
  await ready();

  // ---------- Fonts load when picked; letters a font lacks use the device's font ----------
  await page.selectOption('#fav-font', 'fraunces');
  await summaryIs('Icon from the letters “F” in Fraunces.');
  assert.deepEqual(fontsAsked(), ['inter-latin-700-normal.woff', 'fraunces-latin-700-normal.woff']);
  const dFr = (await get('icon.svg')).toString().match(/ d="([^"]+)"/)[1];
  assert.notEqual(dFr, dF, 'Fraunces draws another F');
  await page.fill('#fav-text', 'Жa');
  await summaryIs('Icon from the letters “Жa” in your device’s font.');
  assert.equal(await text('#fav-font-note'), 'Fraunces has no “Ж”, so your device’s serif font draws these letters. icon.svg then depends on each visitor’s own fonts and can look different on other devices; the PNG and ICO files keep what you see.');
  const svgDev = (await get('icon.svg')).toString();
  assert.match(svgDev, /<text x="[\d.]+" y="[\d.]+" font-size="[\d.]+" font-family="Georgia,'Times New Roman',serif" font-weight="700" class="fav-ink" style="fill:#ffffff">Жa<\/text>/);
  assert.ok((await png('favicon-96x96.png')).count(c => c[0] > 200 && c[2] > 200 && c[1] > 200) > 100, 'the device font drew the letters');
  await page.fill('#fav-text', 'Éa');
  await summaryIs('Icon from the letters “Éa” in Fraunces.');
  assert.equal(await text('#fav-font-note'), '', 'Latin letters with accents have outlines');
  // An accent typed as a separate mark (q with a combining tilde has no single character) needs the font's mark
  // positioning: the device's font draws it, rather than outlines with the tilde beside the q.
  await page.fill('#fav-text', 'q\u0303');
  await summaryIs('Icon from the letters “q\u0303” in your device’s font.');
  assert.match(await text('#fav-font-note'), /^An accent typed as a separate mark cannot be placed on its letter here, so your device’s serif font draws these letters\./);
  assert.match((await get('icon.svg')).toString(), />q\u0303<\/text>/);
  await page.fill('#fav-text', '\u00c9a');
  await summaryIs('Icon from the letters \u201c\u00c9a\u201d in Fraunces.');
  await page.selectOption('#fav-font', 'inter');
  // Letters that barely show on the background get a warning.
  await page.fill('#fav-ink', '#2050d0');
  await page.waitForFunction(() => /barely show/.test(document.querySelector('#fav-font-note').textContent));
  await page.fill('#fav-ink', '#ffffff');
  await page.waitForFunction(() => document.querySelector('#fav-font-note').textContent === '');

  // ---------- Letters: what counts as a character, and every error ----------
  const letters = async v => {
    await page.$eval('#fav-text', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    return text('#fav-text-error');
  };
  assert.equal(await letters(''), 'Type 1 to 3 letters, digits or other characters.');
  await describedBy('#fav-text', '#fav-text-error');
  assert.equal(await text('#fav-stage-empty'), 'Correct the letters', 'the empty preview says why');
  assert.ok(await page.isVisible('#fav-stage-empty'));
  // Saving says what to fix and goes there.
  await page.click('#fav-zip');
  await page.waitForFunction(() => document.querySelector('#fav-dl-error').textContent === 'Correct the letters first.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fav-text', 'focus moves to the letters');
  await page.click('#fav-copy');
  assert.equal(await text('#fav-copy-error'), '', 'the HTML does not depend on the letters');
  assert.equal(await letters('ABCD'), 'Use at most 3 characters; this has 4.');
  assert.equal(await letters('   '), 'Type 1 to 3 letters, digits or other characters.');
  assert.equal(await letters('ééé'), '', 'a letter with a combining accent is one character');
  assert.equal(await letters('👨‍👩‍👧A'), '', 'a family emoji is one character');
  assert.equal(await letters('A​B'), '', 'invisible characters are left out');
  let cost = await pasteCost('#fav-text', 'W'.repeat(1 << 20));
  assert.equal(await text('#fav-text-error'), 'Use 1 to 3 characters.');
  assert.ok(cost < 300, `a megabyte paste is refused quickly: ${Math.round(cost)} ms`);
  assert.equal(await letters('Ab'), '');
  await valid('#fav-text');
  assert.equal(await text('#fav-dl-error'), '', 'the saving error goes once the letters are right');
  await summaryIs('Icon from the letters “Ab” in Inter.');

  // ---------- A change while the files are being made: the saved file is always the latest icon ----------
  await ready();
  await page.evaluate(() => {
    const real = HTMLCanvasElement.prototype.toBlob;
    window.__held = [];
    window.__hold = true;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...a) {
      const go = () => real.call(this, cb, ...a);
      if (window.__hold) window.__held.push(go); else go();
    };
  });
  await page.fill('#fav-text', 'G');
  const later = page.waitForEvent('download');
  await page.click('.fav-file[data-file="favicon-96x96.png"] button');
  await page.waitForFunction(() => window.__held.length > 0);
  await page.fill('#fav-text', 'H');
  await page.evaluate(() => { window.__hold = false; window.__held.splice(0).forEach(f => f()); });
  const raced = fs.readFileSync(await (await later).path());
  await summaryIs('Icon from the letters “H” in Inter.');
  const fresh = await get('favicon-96x96.png');
  assert.ok(raced.equals(fresh), 'the file saved during a change is the icon after it (H), not the one before (G)');
  await page.fill('#fav-text', 'G');
  assert.ok(!(await get('favicon-96x96.png')).equals(fresh), 'G and H differ');
  // A double click saves once.
  await page.evaluate(() => {
    window.__saved = 0;
    const real = TT.download;
    TT.download = function () { window.__saved++; return real.apply(this, arguments); };
  });
  await page.dblclick('#fav-zip');
  await page.waitForFunction(() => /^Saved favicons\.zip/.test(document.querySelector('#fav-status').textContent) && window.__saved > 0);
  await page.click('.fav-file[data-file="site.webmanifest"] button');
  await page.waitForFunction(() => /^Saved site\.webmanifest/.test(document.querySelector('#fav-status').textContent));
  assert.equal(await page.evaluate(() => window.__saved), 2, 'a double click on Download all saves one ZIP');

  // ---------- Back: fields the browser brings back are read again ----------
  await page.$eval('#fav-text', e => { e.value = 'Q'; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await summaryIs('Icon from the letters “Q” in Inter.');
  assert.match((await get('icon.svg')).toString(), /<path class="fav-ink"/);

  // ---------- Emoji ----------
  await page.click('label:has(#fav-src-emoji)');
  await summaryIs('Icon from the emoji 🚀.');
  assert.ok(await page.isHidden('#fav-panel-text') && await page.isVisible('#fav-panel-emoji'));
  assert.equal(await page.inputValue('#fav-shape'), 'none', 'an emoji starts without a background');
  const svgE = (await get('icon.svg')).toString();
  assert.equal(svgE.split('\n').length, 4, 'icon.svg is the emoji alone: ' + svgE);
  assert.match(svgE, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">\n<text x="[\d.]+" y="[\d.]+" font-size="[\d.]+" font-family="'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif">🚀<\/text>\n<\/svg>\n$/);
  const rocket = await png('icon-512.png');
  const opaque = rocket.count(c => c[3] > 128), colourful = rocket.count(c => c[3] > 128 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) > 60);
  assert.ok(opaque > 512 * 512 * 0.2 && colourful > opaque * 0.3, `the emoji is drawn in colour (${colourful} of ${opaque})`);
  assert.equal(rocket.at(0, 0)[3], 0, 'no background');
  assert.ok(rocket.box(c => c[3] > 128).x2 - rocket.box(c => c[3] > 128).x1 > 512 * 0.8, 'the emoji fills 84% of the icon');
  const touchE = await png('apple-touch-icon.png');
  assert.equal(touchE.count(c => c[3] !== 255), 0, 'the iPhone icon is opaque');
  assert.deepEqual(touchE.at(0, 0), WHITE, 'on the phone icon fill colour');
  assert.ok(await page.isVisible('#fav-fill'), 'the phone fill colour is offered without a background');
  // The list, from the keyboard: arrows move through the emoji.
  await page.focus('#fav-emojis input:checked');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.inputValue('#fav-emoji'), '⭐');
  await summaryIs('Icon from the emoji ⭐.');
  const ring = await page.$eval('#fav-emojis input:checked + span', s => getComputedStyle(s).outlineStyle);
  assert.notEqual(ring, 'none', 'the focused emoji shows a focus ring');
  const emoji = async v => {
    await page.$eval('#fav-emoji', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    return text('#fav-emoji-error');
  };
  assert.equal(await emoji('abc'), 'Enter one emoji. For letters, choose Text above.');
  await describedBy('#fav-emoji', '#fav-emoji-error');
  assert.equal(await text('#fav-stage-empty'), 'Correct the emoji');
  assert.equal(await emoji('🚀🔥'), 'Enter one emoji; this has 2.');
  assert.equal(await emoji('x'), 'That is not an emoji. For letters, choose Text above.');
  assert.equal(await emoji(''), 'Pick or paste an emoji.');
  cost = await pasteCost('#fav-emoji', '🙂'.repeat(1 << 19));
  assert.equal(await text('#fav-emoji-error'), 'Enter one emoji.');
  assert.ok(cost < 300, `a megabyte of emoji is refused quickly: ${Math.round(cost)} ms`);
  assert.equal(await emoji('❤'), '', 'a heart without the emoji style is taken');
  await valid('#fav-emoji');
  assert.match((await get('icon.svg')).toString(), />❤️<\/text>/, 'and drawn as the emoji');
  assert.equal(await emoji('🇬🇧'), '', 'a flag is one emoji');
  await summaryIs('Icon from the emoji 🇬🇧.');
  // Some emoji are grey by design (© in Noto Color Emoji): that is no sign of a missing colour emoji font.
  assert.equal(await emoji('©'), '');
  await summaryIs('Icon from the emoji ©️.');
  assert.match(await text('#fav-emoji-note'), /^Your device’s emoji font draws the emoji\./, 'the rocket was drawn in colour, so the device has a colour emoji font');

  // ---------- Image: a logo with transparent edges, every file solid blue ----------
  await page.click('label:has(#fav-src-image)');
  await summaryIs('No icon yet.');
  assert.equal(await text('#fav-stage-empty'), 'Choose an image');
  await page.click('#fav-zip');
  await page.waitForFunction(() => document.querySelector('#fav-dl-error').textContent === 'Choose an image first.');
  await page.click('#fav-copy');
  assert.equal(await text('#fav-copy-error'), 'Choose an image first: the HTML depends on whether it is an SVG.');
  let r = await openImage(fx('logo.png'));
  assert.equal(r.error, '');
  assert.equal(r.note, 'Its transparent edges were trimmed, so the visible part is centred. The 512 px icons are enlarged from fewer pixels of the picture, so they may look soft. A larger picture or an SVG gives sharper icons.');
  await summaryIs('Icon from logo.png, fitted inside the square.');
  assert.equal(await text('#fav-copy-error'), '', 'the HTML error goes once there is a picture');
  assert.equal(await text('#fav-drop-hint'), 'PNG, 400 × 300 px. Choose or drop another image to replace it.');
  assert.equal(await text('#fav-snippet'), SNIPPET.split('\n').filter(l => !l.includes('icon.svg')).join('\n'), 'no icon.svg from a bitmap');
  assert.ok(await page.isHidden('.fav-file[data-file="icon.svg"] button'), 'nor its button');
  assert.ok(await page.isDisabled('#fav-dark'), 'nor a dark style');
  assert.equal(await text('#fav-dark-caption'), 'Browser tab, dark. A bitmap picture has no dark style, so dark tabs show the same icon.');
  const zipL = unzip(await get('zip'));
  assert.deepEqual([...zipL.keys()], [...FILES.filter(f => f !== 'icon.svg'), 'favicon-snippet.html']);
  const solid = (p, c, what) => assert.deepEqual(p.colours(), [c.join()], `${what} is solid ${c}`);
  // Smoothing blends the pixels at a crop's edge with the picture just outside it, by a few levels.
  const nearly = (p, c, what) => assert.equal(p.count(x => !near(x, c, 8)), 0, `${what} is ${c}: ${p.colours().slice(0, 4).join(' ')}`);
  parseIco(zipL.get('favicon.ico'), assert).forEach(p => solid(p, [0, 0, 255, 255], `the ${p.w} px picture in favicon.ico`));
  for (const f of ['favicon-96x96.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) solid(decodePng(zipL.get(f), assert), [0, 0, 255, 255], f);
  // Maskable: the square shrinks until its corners touch the safe circle (radius 204.8 px): 289.6 px.
  const mL = decodePng(zipL.get('icon-maskable-512.png'), assert);
  assert.deepEqual(mL.colours().sort(), ['0,0,255,255', '255,255,255,255'], 'blue on the white phone fill, no blending at pixel edges');
  assert.deepEqual(mL.box(c => c[0] === 0), { x1: 111, y1: 111, x2: 400, y2: 400 });
  assert.equal(mL.count((c, x, y) => c[0] === 0 && Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 204.8), 0, 'nothing outside the safe zone');
  if (pillow) assert.deepEqual(pil('mask2.png', zipL.get('icon-maskable-512.png')).colours, 2, 'Pillow sees two colours');
  // A background shape around the picture, at half the size.
  await page.selectOption('#fav-shape', 'circle');
  await page.fill('#fav-bg', '#ff0000');
  const slide = (sel, v) => page.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  await slide('#fav-img-size', 50);
  assert.equal(await text('#fav-img-size-out'), '50%');
  const circ = await png('icon-192.png');
  assert.deepEqual([circ.at(49, 49), circ.at(142, 142)], [[0, 0, 255, 255], [0, 0, 255, 255]], 'the square spans the middle half');
  assert.deepEqual([circ.at(47, 47), circ.at(96, 2)], [[255, 0, 0, 255], [255, 0, 0, 255]], 'on the red circle');
  assert.equal(circ.at(2, 2)[3], 0, 'outside the circle');
  await page.selectOption('#fav-shape', 'none');
  await slide('#fav-img-size', 100);

  // ---------- Fit or crop, from the keyboard and with a mouse ----------
  r = await openImage(fx('halves.png'));
  assert.equal(r.error, '');
  assert.equal(r.note, 'The 512 px icons are enlarged from fewer pixels of the picture, so they may look soft. A larger picture or an SVG gives sharper icons.');
  const RED = [255, 0, 0, 255], BLUE2 = [0, 0, 255, 255];
  let h = await png('favicon-96x96.png');
  assert.equal(h.at(10, 10)[3], 0, 'fitted: empty band above');
  assert.deepEqual([h.at(10, 48), h.at(90, 48)], [RED, BLUE2]);
  assert.equal(h.box(c => c[3] > 0).y1, 24, 'the picture starts 24 px down');
  assert.equal(h.box(c => c[3] > 0).y2, 71);
  await page.check('input[name="fav-fit"][value="crop"]');
  assert.ok(await page.isVisible('#fav-zoom') && await page.isHidden('#fav-img-size'), 'cropping offers a zoom instead of a size');
  await page.waitForFunction(() => /^The icons of 180 px and larger are enlarged/.test(document.querySelector('#fav-file-note').textContent));
  h = await png('favicon-96x96.png');
  assert.equal(h.count(c => c[3] !== 255), 0, 'cropped: the square is filled');
  assert.deepEqual([h.at(10, 10), h.at(90, 90)], [RED, BLUE2]);
  // Filled into a circle on green, the maskable icon's circle is shrunk into the safe zone and clips the picture.
  await page.selectOption('#fav-shape', 'circle');
  await page.fill('#fav-bg', '#00ff00');
  const mC = await png('icon-maskable-512.png'), GREEN = [0, 255, 0, 255], r0 = (x, y) => Math.hypot(x + 0.5 - 256, y + 0.5 - 256);
  assert.equal(mC.count((c, x, y) => !near(c, GREEN, 24) && r0(x, y) > 204.8 + 0.75), 0, 'nothing but the background outside the safe zone');
  assert.ok(mC.count((c, x, y) => !near(c, GREEN, 24) && r0(x, y) > 200) > 100, 'the picture fills the safe zone');
  await page.selectOption('#fav-shape', 'none');
  assert.equal(await attr('#fav-stage', 'role'), 'application');
  assert.equal(await attr('#fav-stage', 'tabindex'), '0');
  await page.focus('#fav-centre');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fav-stage', 'the crop area takes keyboard focus');
  assert.notEqual(await page.$eval('#fav-stage', c => getComputedStyle(c).outlineStyle), 'none', 'the crop area shows a focus ring');
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
  nearly(await png('favicon-96x96.png'), RED, 'moved right as far as it goes, the left (red) half');
  await page.focus('#fav-stage');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowLeft');
  nearly(await png('favicon-96x96.png'), BLUE2, 'moved left, the blue half');
  await page.click('#fav-centre');
  h = await png('favicon-96x96.png');
  assert.deepEqual([h.at(10, 48), h.at(90, 48)], [RED, BLUE2], 'Centre the picture');
  await page.focus('#fav-stage');
  await page.keyboard.press('+');
  assert.equal(await page.inputValue('#fav-zoom'), '125');
  assert.equal(await attr('#fav-zoom', 'aria-valuetext'), '125%');
  assert.equal(await text('#fav-zoom-out'), '125%');
  await page.keyboard.press('-');
  assert.equal(await page.inputValue('#fav-zoom'), '100');
  // A mouse drag: the picture follows the pointer.
  await page.locator('#fav-stage').scrollIntoViewIfNeeded();
  const box = await page.$eval('#fav-stage', c => { const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 4, box.y, { steps: 5 });
  await page.mouse.up();
  h = await png('favicon-96x96.png');
  assert.deepEqual([h.at(10, 48), h.at(60, 48), h.at(90, 48)], [RED, RED, BLUE2], 'dragged right a quarter: more of the red half');
  await page.check('input[name="fav-fit"][value="pad"]');

  // ---------- A photo turned by its EXIF orientation ----------
  r = await openImage(fx('rotated.jpg'));
  assert.match(r.note, /^The photo’s rotation tag was applied, so it is upright\./);
  h = await png('favicon-96x96.png');
  assert.deepEqual(expected.rotated_upright.size, [32, 64]);
  assert.ok(near(h.at(48, 20), [...expected.rotated_upright.top, 255], 40) && near(h.at(48, 76), [...expected.rotated_upright.bottom, 255], 40), `red above blue, as Pillow turns it: ${h.at(48, 20)} ${h.at(48, 76)}`);
  assert.equal(h.at(10, 48)[3], 0, 'a tall photo is fitted between empty bands');

  // ---------- An SVG stays vector, without its script or links ----------
  r = await openImage(fx('logo.svg'));
  assert.equal(r.note, 'Its scripts are left out: they never run in a favicon. Files it links to are left out, as browsers do in an icon.');
  assert.ok(await page.isEnabled('#fav-dark'), 'an SVG can have a dark style');
  assert.equal(await text('#fav-snippet'), SNIPPET);
  let svgS = (await get('icon.svg')).toString();
  assert.doesNotMatch(svgS, /script|onload|example\.com|alert/i, 'no script, handler or link in icon.svg');
  assert.doesNotMatch(svgS, /srcdoc|\ssrc=/, 'its HTML keeps no frame content and no address of another file');
  assert.match(svgS, /<svg [^>]*viewBox="0 0 200 100" x="0" y="25" width="100" height="50">/);
  let v = await png('icon-512.png');
  assert.deepEqual(v.colours().sort(), ['0,0,0,0', '0,255,0,255', '255,0,255,255'], 'drawn from the vector: no blended pixels');
  assert.deepEqual([v.at(255, 127)[3], v.at(255, 128), v.at(256, 128), v.at(256, 383), v.at(256, 384)[3]], [0, [0, 255, 0, 255], [255, 0, 255, 255], [255, 0, 255, 255], 0]);
  await page.check('input[name="fav-fit"][value="crop"]');
  svgS = (await get('icon.svg')).toString();
  assert.match(svgS, /<svg [^>]*viewBox="0 0 200 100" x="-50" y="0" width="200" height="100">/);
  v = await png('icon-512.png');
  assert.deepEqual([v.at(255, 0), v.at(256, 511)], [[0, 255, 0, 255], [255, 0, 255, 255]], 'the middle square, split down the centre');
  assert.equal(v.count(c => c[3] !== 255), 0);
  await page.check('input[name="fav-fit"][value="pad"]');
  await page.check('#fav-dark');
  assert.equal(await text('#fav-dark-hint'), 'Without a background there is nothing to change in dark mode: choose a shape first.');
  await page.uncheck('#fav-dark');

  // ---------- An SVG with its own dark style, opened while the page is dark: the files take its light colours ----------
  // Browsers draw an SVG picture in the page's colour scheme; Google Search and phones show the PNGs on light backgrounds.
  await page.emulateMedia({ colorScheme: 'dark' });
  r = await openImage(fx('duo.svg'));
  assert.match(r.note, /Its own dark-mode colours stay in icon\.svg; the PNG and ICO files and the previews here use its light colours\./);
  const duo = await png('favicon-96x96.png');
  assert.deepEqual([duo.at(30, 48), duo.at(66, 48)], [RED, RED], 'light colours from @media (prefers-color-scheme) and from light-dark()');
  assert.deepEqual(parseIco(await get('favicon.ico'), assert)[0].at(4, 8), RED, 'in favicon.ico too');
  const duoSvg = (await get('icon.svg')).toString();
  assert.match(duoSvg, /@media \(prefers-color-scheme: dark\) \{ #a \{ fill: #00ff00 \} \}/, 'icon.svg keeps the dark style');
  assert.match(duoSvg, /#b \{ color-scheme: light dark; fill: light-dark\(#ff0000, #00ff00\) \}/);
  assert.equal(await text('#fav-dark-caption'), 'Browser tab, dark. Chrome and Firefox switch to the SVG’s own dark colours, which icon.svg keeps; this preview shows its light ones.');
  await page.emulateMedia({ colorScheme: null });

  // ---------- Every format the site reads ----------
  const formats = [
    [fx('deep.png'), p => near(p.at(48, 48), [128, 64, 192, 255], 1), null],
    [fx('palette.png'), p => p.colours().join(' ') === '255,128,0,255', /transparent edges were trimmed/],
    [other('crop-image', 'anim.gif'), p => near(p.at(48, 48), RED, 2), /^This GIF is animated: its first frame is used\./],
    [other('image-converter', 'alpha.webp'), p => near(p.at(2, 14), [200, 30, 60, 255], 8) && p.at(48, 48)[3] < 128, null],
    [other('avif-to-jpg', 'srgb.avif'), p => near(p.at(48, 48), [197, 110, 100, 255], 12), null],
    [other('heic-to-jpg', 'quadrants.heic'), p => near(p.at(24, 32), [220, 40, 40, 255], 16) && near(p.at(72, 64), [240, 240, 240, 255], 16), null],
    [other('image-converter', 'green.bmp'), p => near(p.at(20, 48), [10, 200, 30, 255], 2) || near(p.at(76, 48), [10, 200, 30, 255], 2), null],
    [other('image-converter', 'icon.ico'), p => near(p.at(48, 48), [250, 150, 0, 255], 2), null],
    [other('image-converter', 'count.tif'), p => p.at(48, 48)[3] === 255, null],
    [other('jpg-to-png', 'p3.jpg'), p => p.at(48, 48)[3] === 255, /Its colours were converted to sRGB/],
    [other('image-to-pdf', 'cmyk.jpg'), p => near(p.at(48, 48), [255, 55, 55, 255], 30), null],
    [other('image-converter', 'cut-big.png'), p => p.w === 96, /cut off/],
    [fx('dot.png'), p => p.colours().join(' ') === '255,0,0,255', /^The icons of 16 px and larger are enlarged/],
    [{ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(fx('logo.png')) }, p => p.colours().join(' ') === '0,0,255,255', null],
  ];
  for (const [file, check, note] of formats) {
    const name = typeof file === 'string' ? path.basename(file) : file.name;
    r = await openImage(file);
    assert.equal(r.error, '', `${name} opens`);
    if (note) assert.match(r.note, note, `${name}: ${r.note}`);
    await summaryIs(`Icon from ${name}, fitted inside the square.`);
    const p = await png('favicon-96x96.png');
    assert.ok(check(p), `${name}: the icon shows the picture (${p.at(48, 48)}; ${p.colours().length} colours)`);
  }

  // ---------- Files that are not pictures, or are broken ----------
  for (const [file, re] of [
    [{ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }, /^empty\.png: /],
    [{ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('Shopping list: milk, eggs.\n') }, /^notes\.png: /],
    [{ name: 'broken.png', mimeType: 'image/png', buffer: fs.readFileSync(other('image-converter', 'broken.png')) }, /^broken\.png/],
  ]) {
    r = await openImage(file);
    assert.match(r.error, re, `${file.name}: ${r.error}`);
    await describedBy('#fav-file', '#fav-file-error');
    assert.equal(await text('#fav-drop-title'), 'logo.jpg', 'the picture before stays');
    await summaryIs('Icon from logo.jpg, fitted inside the square.');
  }
  r = await openImage(fx('halves.png'));
  await valid('#fav-file');

  // ---------- Pasting: a picture opens; text with a picture of itself stays text in a text field ----------
  const pasteFile = (sel, withText) => page.$eval(sel, (el, [b64, withText]) => {
    const dt = new DataTransfer(), bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (withText) dt.setData('text/plain', 'AB');
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [fs.readFileSync(fx('dot.png')).toString('base64'), withText]);
  await page.click('label:has(#fav-src-text)');
  await pasteFile('#fav-text', true);
  assert.ok(await page.isChecked('#fav-src-text'), 'text pasted into the letters stays text (a picture would switch the source at once)');
  await pasteFile('body', false);
  await page.waitForFunction(() => document.querySelector('#fav-status').textContent === 'Opened pasted.png.');
  assert.ok(await page.isChecked('#fav-src-image'), 'a pasted picture opens');
  await summaryIs('Icon from pasted.png, fitted inside the square.');
  // Several files dropped at once: the first opens, and the note says so.
  await page.evaluate(([a, b]) => {
    const dt = new DataTransfer();
    for (const [n, b64] of [['one.png', a], ['two.png', b]]) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], n, { type: 'image/png' }));
    document.querySelector('#fav-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [fs.readFileSync(fx('halves.png')).toString('base64'), fs.readFileSync(fx('dot.png')).toString('base64')]);
  await page.waitForFunction(() => document.querySelector('#fav-status').textContent === 'Opened one.png.');
  assert.match(await text('#fav-file-note'), /^Of the 2 files, only the first, one\.png, is used\./);

  // ---------- Large pictures: a 20,000 px panorama and a 12 MP photo ----------
  r = await openImage(fx('panorama.png'));
  assert.equal(r.note, 'This picture is 20,000 × 300 px; a copy of 8,192 × 123 px is used, which keeps memory use low.');
  await page.check('input[name="fav-fit"][value="crop"]');
  solid(await png('favicon-96x96.png'), [0, 255, 0, 255], 'the centre of the panorama');
  assert.match(await text('#fav-file-note'), /The icons of 180 px and larger are enlarged/);
  await page.check('input[name="fav-fit"][value="pad"]');
  let t0 = await threadMs();
  r = await openImage(other('heic-to-jpg', 'photo-12mp.heic'));
  assert.equal(r.note, 'This picture is 4,032 × 3,024 px; a copy of 2,731 × 2,048 px is used, which keeps memory use low.');
  assert.ok(await threadMs() - t0 < 4000, 'a 12 MP photo opens without long work on the page');
  const big = await png('icon-192.png');
  assert.ok(big.count(c => near(c, [240, 200, 40, 255], 30)) > 200, 'the yellow disc of the photo');

  // ---------- Cancel, and a picture that never finishes opening ----------
  await page.evaluate(() => {
    const real = TTImage.decode;
    const release = TTImage.release;
    window.__release = null;
    window.__finished = false;
    TTImage.decode = function (f, o) { TTImage.decode = real; return new Promise((res, rej) => { window.__release = () => real(f, o).then(res, rej); }); };
    // The opening job releases its decoded picture as its last step.
    TTImage.release = function (x) { TTImage.release = release; release.call(this, x); window.__finished = true; };
  });
  await page.setInputFiles('#fav-file', fx('halves.png'));
  await page.waitForFunction(() => window.__release && document.querySelector('#fav-status').textContent === 'Opening halves.png…');
  assert.ok(await page.isVisible('#fav-cancel'), 'Cancel shows while a picture opens');
  await page.click('#fav-zip');
  await page.waitForFunction(() => document.querySelector('#fav-dl-error').textContent === 'Wait until the image has opened.');
  // The wait is for the Image source only: the letters can be saved meanwhile.
  await page.click('label:has(#fav-src-text)');
  await page.waitForFunction(() => document.querySelector('#fav-dl-error').textContent === '', null, { timeout: 10000 })
    .catch(async () => assert.fail(`the Text source still says "${await text('#fav-dl-error')}"`));
  await ready();
  assert.equal(parseIco(await get('favicon.ico'), assert).length, 3, 'the letters are saved while a picture opens');
  await page.click('label:has(#fav-src-image)');
  assert.ok(await page.isVisible('#fav-cancel'), 'the picture is still opening');
  await page.click('#fav-cancel');
  assert.equal(await text('#fav-status'), 'Stopped opening halves.png.');
  assert.ok(await page.isHidden('#fav-cancel'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fav-file', 'focus goes back to the file field');
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => window.__finished);
  await page.evaluate(() => new Promise(r => setTimeout(r, 50)));
  assert.equal(await text('#fav-drop-title'), 'photo-12mp.heic', 'the cancelled picture never replaces the open one');
  await summaryIs('Icon from photo-12mp.heic, fitted inside the square.');
  await ready();

  // ---------- Site name, short name and folder ----------
  await page.fill('#fav-name', '');
  assert.equal(await text('#fav-name-error'), 'Enter the site’s name: the manifest needs one.');
  await describedBy('#fav-name', '#fav-name-error');
  await page.click('.fav-file[data-file="site.webmanifest"] button');
  await page.waitForFunction(() => document.querySelector('#fav-dl-error').textContent === 'Correct the site name first.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fav-name');
  await page.fill('#fav-name', '  Acme   Tools ');
  await valid('#fav-name');
  assert.deepEqual(await page.$$eval('.fav-site-name', l => [...new Set(l.map(e => e.textContent))]), ['Acme Tools'], 'the previews use the name');
  await page.fill('#fav-short', 'x'.repeat(101));
  assert.equal(await text('#fav-short-error'), 'Keep the short name to 100 characters or fewer.');
  await describedBy('#fav-short', '#fav-short-error');
  await page.fill('#fav-short', 'Acme');
  await valid('#fav-short');
  assert.deepEqual(await page.$$eval('.fav-short-name', l => l.map(e => e.textContent)), ['Acme', 'Acme']);
  for (const id of ['#fav-name', '#fav-short', '#fav-base']) {
    cost = await pasteCost(id, '/'.repeat(1 << 20));
    assert.ok(cost < 300, `a megabyte paste in ${id} is refused quickly: ${Math.round(cost)} ms`);
  }
  assert.equal(await text('#fav-name-error'), 'Keep the site name to 100 characters or fewer.');
  assert.equal(await text('#fav-base-error'), 'Use a folder path under 300 characters, such as /blog/.');
  await page.fill('#fav-name', 'Acme Tools');
  await page.fill('#fav-short', 'Acme');
  const base = async v => { await page.fill('#fav-base', v); return text('#fav-base-error'); };
  assert.equal(await base('/my folder/'), 'A folder path cannot contain spaces, quotes, angle brackets or backslashes.');
  await describedBy('#fav-base', '#fav-base-error');
  assert.equal(await text('#fav-snippet'), 'The HTML appears here once the folder above is corrected.');
  await page.click('#fav-copy');
  assert.equal(await text('#fav-copy-error'), 'Correct the folder first.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fav-base');
  assert.equal(await base('javascript:alert(1)'), 'Use a path such as /blog/, or an address that starts with https://.');
  assert.equal(await base('/blog/?v=2'), 'Leave out ? and # parts: enter the folder only.');
  assert.equal(await base('blog'), '');
  await valid('#fav-base');
  assert.equal(await text('#fav-copy-error'), '');
  await page.press('#fav-base', 'Tab');
  assert.equal(await page.inputValue('#fav-base'), '/blog/', 'the folder is written out in full');
  await page.click('label:has(#fav-src-text)');
  await summaryIs('Icon from the letters “Q” in Inter.');
  const blogSnippet = SNIPPET.replace(/href="\//g, 'href="/blog/');
  assert.equal(await text('#fav-snippet'), blogSnippet);
  await page.click('#fav-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), blogSnippet, 'Copy HTML copies the snippet');
  assert.equal(await base('https://example.com/static'), '');
  assert.equal(await text('#fav-snippet'), SNIPPET.replace(/href="\//g, 'href="https://example.com/static/'));
  const zipS = unzip(await get('zip'));
  assert.match(zipS.get('favicon-snippet.html').toString(), /href="https:\/\/example\.com\/static\/favicon\.ico" sizes="32x32"/);
  const man = JSON.parse(zipS.get('site.webmanifest').toString());
  assert.deepEqual([man.name, man.short_name, man.icons[0].src, man.start_url], ['Acme Tools', 'Acme', 'icon-192.png', './'], 'icon paths are relative to the manifest');
  await base('/');

  // ---------- The main flow from the keyboard ----------
  await page.focus('#fav-src-text');
  await page.keyboard.press('ArrowRight');
  assert.ok(await page.isChecked('#fav-src-emoji'), 'arrow keys switch the source');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.name), 'fav-emoji-pick', 'Tab goes on to the emoji');
  await page.keyboard.press('ArrowRight');
  const picked = await page.inputValue('#fav-emoji');
  await summaryIs(`Icon from the emoji ${picked}.`);
  await page.focus('#fav-zip');
  const [kd] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.ok(unzip(fs.readFileSync(await kd.path())).get('icon.svg').toString().includes('>' + picked + '</text>'), 'Enter on Download all saves the chosen emoji');

  // ---------- A picture that never finishes opening is given up after a minute in view ----------
  const cctx = await page.context().browser().newContext({ acceptDownloads: true });
  const cp = await cctx.newPage();
  await cp.clock.install();
  await cp.goto(url);
  await cp.click('label:has(#fav-src-image)');
  await cp.evaluate(() => { TTImage.decode = () => new Promise(() => {}); });
  await cp.setInputFiles('#fav-file', fx('halves.png'));
  await cp.waitForFunction(() => document.querySelector('#fav-status').textContent === 'Opening halves.png…');
  await cp.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await cp.clock.runFor(120000);
  assert.equal(await cp.textContent('#fav-file-error'), '', 'time in a background tab does not count');
  await cp.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await cp.clock.runFor(61000);
  await cp.waitForFunction(() => document.querySelector('#fav-file-error').textContent !== '');
  assert.equal(await cp.textContent('#fav-file-error'), 'halves.png took too long to open and was given up. It may be damaged, or too large for this device.');
  assert.equal(await cp.getAttribute('#fav-file', 'aria-invalid'), 'true');
  assert.ok(await cp.isHidden('#fav-cancel'));
  await cctx.close();

  // ---------- A phone: touch, 44 px targets, menus that fit ----------
  const ctx = await page.context().browser().newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.waitForFunction(() => document.querySelector('#fav-summary').textContent === 'Icon from the letters “F” in Inter.');
  const small = await phone.$$eval('.fav-seg span, .fav-file .btn, #fav-zip, #fav-copy, .fav-emojis span', l => Math.min(...l.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height)));
  assert.ok(small >= 44, `controls are at least 44 px tall on a touch screen: ${small}`);
  await phone.click('label:has(#fav-src-image)');
  await openImage(fx('halves.png'), phone);
  await phone.check('input[name="fav-fit"][value="crop"]');
  await phone.locator('#fav-stage').scrollIntoViewIfNeeded();
  const pc = await ctx.newCDPSession(phone);
  const stageAt = async () => {
    await phone.locator('#fav-stage').scrollIntoViewIfNeeded();
    return phone.$eval('#fav-stage', c => { const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
  };
  let g = await stageAt();
  const touchPts = (type, pts) => pc.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q.x, y: q.y, id: i })) });
  const scrollBefore = await phone.evaluate(() => scrollY);
  await touchPts('touchStart', [{ x: g.x, y: g.y }]);
  for (let i = 1; i <= 6; i++) await touchPts('touchMove', [{ x: g.x - g.w / 4 * i / 6, y: g.y - 40 * i / 6 }]);
  await touchPts('touchEnd', []);
  assert.equal(await phone.evaluate(() => scrollY), scrollBefore, 'a finger on the crop area moves the picture, not the page');
  const hp = decodePng(await get('favicon-96x96.png', phone), assert);
  assert.deepEqual([hp.at(10, 48), hp.at(40, 48), hp.at(90, 48)], [RED, BLUE2, BLUE2], 'a finger dragged left shows more of the blue half');
  g = await stageAt();
  await touchPts('touchStart', [{ x: g.x - 20, y: g.y }, { x: g.x + 20, y: g.y }]);
  for (let i = 1; i <= 6; i++) await touchPts('touchMove', [{ x: g.x - 20 - 8 * i, y: g.y }, { x: g.x + 20 + 8 * i, y: g.y }]);
  await touchPts('touchEnd', []);
  assert.ok(+await phone.inputValue('#fav-zoom') > 150, 'a pinch zooms in');
  // No menu cuts off the option it shows, at any phone or tablet width.
  await phone.click('label:has(#fav-src-text)');
  const cut = [];
  for (let w = 320; w <= 760; w += 8) {
    await phone.setViewportSize({ width: w, height: 800 });
    cut.push(...await phone.evaluate(w => {
      const out = [];
      for (const s of document.querySelectorAll('.tool-card select')) {
        if (!s.offsetParent) continue;
        for (const o of s.options) {
          const c = s.cloneNode(false);
          c.removeAttribute('id');
          c.appendChild(o.cloneNode(true));
          c.style.cssText = 'width: auto !important; position: absolute; visibility: hidden';
          s.parentNode.appendChild(c);
          const need = c.getBoundingClientRect().width, have = s.getBoundingClientRect().width;
          c.remove();
          if (need > have + 0.5) out.push(`${w} px: ${s.id} "${o.textContent}" (${Math.round(have)} of ${Math.round(need)} px)`);
        }
      }
      for (const b of document.querySelectorAll('.tool-card .btn, .fav-seg span')) {
        if (b.offsetParent && b.scrollWidth > b.clientWidth + 1) out.push(`${w} px: button "${b.textContent}" cut off`);
      }
      return out;
    }, w));
  }
  assert.deepEqual(cut, [], 'menus and buttons that cut off their text');
  await ctx.close();

  // ---------- A decimal-comma locale changes nothing ----------
  const dctx = await page.context().browser().newContext({ locale: 'de-DE', acceptDownloads: true });
  const de = await dctx.newPage();
  await de.goto(url);
  await de.waitForFunction(() => document.querySelector('.fav-file[data-file="favicon.ico"] .fav-size').textContent !== '');
  assert.match(await de.textContent('.fav-file[data-file="icon-512.png"] .fav-size'), /^\d+(\.\d)? KB$/);
  assert.equal(await de.textContent('#fav-text-size-out'), '60%');
  assert.ok(parseIco(await get('favicon.ico', de), assert).length === 3);
  await dctx.close();

  // ---------- The files in a real page: the full Chromium build fetches favicons, as a browser window does ----------
  let full = null;
  try { full = await chromium.launch({ channel: 'chromium' }); } catch (e) { console.log('  (favicon-generator: no full Chromium build here: the real-page check is skipped)'); }
  if (full) {
    const site = fs.mkdtempSync(path.join(require('os').tmpdir(), 'favsite-'));
    const head = zipF.get('favicon-snippet.html').toString();
    for (const [n, b] of zipF) fs.writeFileSync(path.join(site, n), b);
    const pageWith = lines => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test</title>\n${lines}</head><body><p>Test</p></body></html>`;
    fs.writeFileSync(path.join(site, 'index.html'), pageWith(head));
    fs.writeFileSync(path.join(site, 'bitmap.html'), pageWith(head.split('\n').filter(l => !l.includes('icon.svg')).join('\n')));
    const asked = [];
    const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname, f = path.join(site, p === '/' ? 'index.html' : p.slice(1));
      asked.push(p);
      if (!f.startsWith(site + path.sep) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const until = async (test, what) => {
      for (let i = 0; i < 300 && !test(); i++) await new Promise(r => setTimeout(r, 50));
      assert.ok(test(), what());
    };
    try {
      const fctx = await full.newContext();
      const fp = await fctx.newPage();
      await fp.goto(origin + '/');
      await until(() => asked.includes('/icon.svg'), () => `the browser fetches icon.svg for the tab: ${asked}`);
      const cdp = await fctx.newCDPSession(fp);
      const man = await cdp.send('Page.getAppManifest');
      assert.equal(man.url, origin + '/site.webmanifest');
      assert.deepEqual(man.errors, [], 'Chromium reads site.webmanifest without errors');
      const inst = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.map(e => e.errorId);
      assert.deepEqual(inst.filter(e => e !== 'in-incognito'), [], 'nothing in the files stops the site from being installed');
      assert.ok(!asked.includes('/favicon.ico'), `with sizes="32x32" on the ICO, Chrome takes the SVG alone: ${asked}`);
      asked.length = 0;
      await fp.goto(origin + '/bitmap.html');
      await until(() => asked.includes('/favicon.ico'), () => `without icon.svg the browser takes favicon.ico: ${asked}`);
      await fctx.close();
    } finally {
      server.close();
      await full.close();
      fs.rmSync(site, { recursive: true, force: true });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
};
