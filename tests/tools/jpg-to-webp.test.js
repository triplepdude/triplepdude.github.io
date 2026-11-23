// JPG to WebP: the image converter with format="webp", quality 80, metadata="nogps",
// profile="keep", compare="true" and longest-side presets. Fixtures (made by
// tests/fixtures/jpg-to-webp/make_fixtures.py, which lists them): a camera photo
// stored sideways (EXIF Orientation 6, camera, date and GPS), JPGs with a
// Display P3 and an Adobe RGB profile, a CMYK JPG, a web photo saved at 60, a
// 1 x 1 JPG, a 20,000 px panorama, a cut-off JPG, a PNG and a text file named
// .jpg, an empty file and an iPhone-style HEIC. Each WebP is read back with
// ../png-to-webp/verify.py (Pillow's libwebp, littleCMS) and the RIFF parser below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

function riff(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP');
  if (b.readUInt32LE(4) + 8 !== b.length) throw new Error('RIFF size does not match the file');
  const out = { chunks: [], flags: null, iccp: null, exif: null };
  for (let p = 12; p + 8 <= b.length;) {
    const t = b.toString('latin1', p, p + 4), len = b.readUInt32LE(p + 4), d = b.subarray(p + 8, p + 8 + len);
    out.chunks.push(t.trim());
    if (t === 'VP8X') { out.flags = d[0]; out.w = d.readUIntLE(4, 3) + 1; out.h = d.readUIntLE(7, 3) + 1; }
    if (t === 'VP8 ') {
      if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error('VP8 start code');
      out.vw = d.readUInt16LE(6) & 0x3fff; out.vh = d.readUInt16LE(8) & 0x3fff;
    }
    if (t === 'VP8L') { const bits = d.readUInt32LE(1); out.vw = (bits & 0x3fff) + 1; out.vh = ((bits >>> 14) & 0x3fff) + 1; }
    if (t === 'ICCP') out.iccp = Buffer.from(d);
    if (t === 'EXIF') out.exif = Buffer.from(d);
    p += 8 + len + (len & 1);
  }
  if (out.w == null) { out.w = out.vw; out.h = out.vh; }
  return out;
}
function unzip(buf) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const out = {};
  for (let i = 0, p = buf.readUInt32LE(eocd + 16); i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen), lho = buf.readUInt32LE(p + 42);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(start, start + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (zlib.crc32(out[name]) !== buf.readUInt32LE(p + 16)) throw new Error('CRC mismatch in ' + name);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}
// Tags of the first IFD of a TIFF-layout EXIF block, and whether it points to GPS data.
function exifTags(b) {
  const le = b.toString('latin1', 0, 2) === 'II', u16 = o => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = u32(4), out = {};
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + 12 * i, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (type === 2) { const at = count > 4 ? u32(e + 8) : e + 8; out[tag] = b.toString('latin1', at, at + count - 1); }
    else if (type === 3) out[tag] = u16(e + 8);
    else out[tag] = u32(e + 8);
  }
  return out;
}
function fmtBytes(n) {
  if (n < 1000) return n + ' B';
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + ' KB';
  return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB';
}
function change(from, to) {
  const saved = Math.round((1 - to / from) * 100);
  return saved > 99 ? ' (over 99% smaller)' : saved > 0 ? ` (${saved}% smaller)` : saved < 0 ? ` (${-saved}% larger)` : '';
}

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const fx = f => path.join(fixtures, f);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpg-to-webp-'));
  let pillow = true;
  try { execFileSync('python3', ['-c', 'import PIL.WebPImagePlugin, PIL.ImageCms, numpy'], { stdio: 'ignore' }); } catch (e) { pillow = false; }
  if (!pillow) console.log('  (jpg-to-webp: python3 with Pillow and numpy is missing: WebP files are checked in Chromium only)');
  const verify = pairs => {
    if (!pillow) return null;
    const args = [];
    pairs.forEach(([src, data], i) => { const f = path.join(tmp, i + '.webp'); fs.writeFileSync(f, data); args.push(src, f); });
    return JSON.parse(execFileSync('python3', [path.join(fixtures, '..', 'png-to-webp', 'verify.py'), ...args], { maxBuffer: 64 << 20 }).toString());
  };

  try {
    await open();
    assert.equal(await page.textContent('h1'), 'JPG to WebP Converter for Smaller Photos');

    // ---------- Set up for JPG to WebP as served, and nothing moves as the script starts ----------
    const NOTE = 'There is no lossless mode: a lossless WebP of a JPG is 3 to 10 times its size, as it keeps the JPG’s compression noise exactly.';
    const HINT = 'JPG photos, and HEIC from an iPhone, as many as you like. Nothing is uploaded.';
    const START = ['webp', '80', '80%', 'nogps', 'none', 'false,false,true,false,true,true', NOTE, HINT, 'false', 'none'];
    const load = await page.evaluate(async () => {
      const state = doc => {
        const q = s => doc.querySelector(s);
        return [q('#imc-format').value, q('#imc-quality').value, q('#imc-quality-out').textContent, q('#imc-meta').value, q('#imc-resize').value,
          ['#imc-quality-field', '#imc-resize-field', '#imc-bg-field', '#imc-meta-field', '#imc-sizes', '#imc-resize-val'].map(s => q(s).hidden).join(),
          q('#imc-note').textContent, q('#imc-drop .hint').textContent, String(q('#imc-skip').checked), q('#imc-mode-field') ? 'switch' : 'none'];
      };
      const live = state(document);
      const html = await (await fetch(location.href)).text();
      await Promise.all(['webp', 'avif'].map(f => TTImage.canEncode(f, { wasm: true })));
      await new Promise(r => setTimeout(r, 50));
      return { html, served: state(new DOMParser().parseFromString(html, 'text/html')), live, settled: state(document) };
    });
    assert.doesNotMatch(load.html, /\{%|\{\{|include\.|imc_[a-z]|presets=/, 'Liquid or include notes in the page');
    assert.deepEqual(load.served, START);
    assert.deepEqual(load.live, START, 'the script changed the controls as it started');
    assert.deepEqual(load.settled, START, 'the encoder checks changed the controls');
    assert.deepEqual(await page.$$eval('#imc-resize option', os => os.map(o => o.textContent)), ['Keep original size', 'Longest side (px)',
      'Longest side 1280 px', 'Longest side 1920 px', 'Longest side 2560 px', 'Longest side 3840 px', 'Width (px)', 'Height (px)', 'Scale (%)']);

    // ---------- The guide and the FAQ ----------
    const links = await page.$$eval('.prose a, .faq a', as => as.map(a => a.getAttribute('href')));
    for (const h of ['/png-to-webp/', '/remove-exif-data/', '/webp-to-jpg/']) assert.ok(links.includes(h), `links to ${h}`);
    for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `link ${h} is not a tool page`);
    const guide = (await page.textContent('.prose')).replace(/\s+/g, ' ');
    assert.match(guide, /“Larger than the original: keep the JPG”, and Leave files that are not smaller out of the ZIP keeps such files out of the download\./);
    assert.match(guide, /the Photo metadata menu can remove all or keep all\./);
    assert.match(guide, /pick a longest side under Size, such as 1920 px\./);
    assert.deepEqual([await page.textContent('label[for="imc-meta"]'), await page.textContent('label[for="imc-resize"]')], ['Photo metadata (EXIF)', 'Size']);
    assert.deepEqual(await page.$$eval('.faq summary', s => s.map(e => e.textContent.trim())), [
      'Is WebP better than JPG?', 'Will WebP open on Windows, a Mac or in Photoshop?', 'Can I convert WebP back to JPG?', 'Are my photos uploaded?']);
    assert.match((await page.textContent('.faq')).replace(/\s+/g, ' '), /In most current software, yes\. Photoshop has opened and saved WebP since version 23\.2 \(February 2022\)/);

    const rows = page.locator('.imc-item');
    const rowText = async (i, p = page) => (await p.locator('.imc-item').nth(i).innerText()).replace(/\s+/g, ' ').replace(/( Download)? ×$/, '').trim();
    const download = async (i, p = page) => {
      const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('.imc-item').nth(i).locator('[data-act="dl"]').click()]);
      return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
    };
    const zipNow = async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#imc-zip')]);
      return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
    };
    const settled = (n, p = page) => p.waitForFunction(n => {
      const t = document.querySelector('#imc-summary').textContent;
      return new RegExp('^\\d+ of ' + n + ' converted').test(t) && !/working/.test(t) && !document.querySelector('.imc-item progress:not([hidden])');
    }, n, { timeout: 90000 });
    const rerun = async action => {
      await page.evaluate(() => {
        window.__saw = false;
        const el = document.querySelector('#imc-summary');
        if (window.__mo) window.__mo.disconnect();
        window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
        window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
      });
      await action();
      await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 90000 });
    };
    const chromePixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
    }, [buf.toString('base64'), pts]);
    const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

    // ---------- A batch of photos and odd files ----------
    const FILES = ['camera.jpg', 'p3.jpg', 'adobe.jpg', 'cmyk.jpg', 'web.jpg', 'tiny.jpg', 'cut.jpg', 'png-named.jpg', 'small.heic', 'pano.jpg', 'empty.jpg', 'notes.jpg'];
    const NAMES = FILES.slice(0, 10).map(f => f.replace(/\.(jpg|heic)$/, '.webp'));
    await page.setInputFiles('#imc-file', FILES.map(fx));
    await settled(FILES.length);
    assert.match(await page.textContent('#imc-summary'), /^10 of 12 converted, 2 failed\. In total [\d.]+ KB → [\d.]+ KB \(\d+% smaller\)\.$/);
    await page.waitForFunction(() => /^Converted 10 images to WebP\. 2 could not be converted\. In total [\d.]+ [KM]B → [\d.]+ [KM]B \(\d+% smaller\)\.$/.test(document.querySelector('#imc-status').textContent));
    assert.equal(await rowText(10), 'empty.jpg 0 B The file is empty (0 bytes).');
    assert.match(await rowText(11), /^notes\.jpg 36 B This is not a supported image\./);

    let z = await zipNow();
    assert.equal(z.name, 'converted-images-webp.zip');
    let entries = unzip(z.data);
    assert.deepEqual(Object.keys(entries).sort(), NAMES.slice().sort());
    const one = await download(0);
    assert.equal(one.name, 'camera.webp');
    assert.ok(one.data.equals(entries['camera.webp']), 'Download and ZIP hold the same file');
    let before = 0, after = 0;
    for (let i = 0; i < 10; i++) {
      const src = fs.statSync(fx(FILES[i])).size, out = entries[NAMES[i]].length, t = await rowText(i);
      before += src; after += out;
      assert.ok(t.startsWith(NAMES[i] + ' ') && t.includes(', ' + fmtBytes(src) + ' → WebP ') && t.includes(', ' + fmtBytes(out) + change(src, out)), `${NAMES[i]}: ${t}`);
    }
    assert.ok((await page.textContent('#imc-summary')).includes(`In total ${fmtBytes(before)} → ${fmtBytes(after)}${change(before, after)}.`));

    // Each file, read back.
    const R = Object.fromEntries(NAMES.map(n => [n, riff(entries[n])]));
    const v = verify(NAMES.map((n, i) => [fx(FILES[i]), entries[n]]));
    const V = v ? Object.fromEntries(NAMES.map((n, i) => [n, v[i]])) : null;
    const T = Object.fromEntries(await Promise.all(NAMES.map(async (n, i) => [n, await rowText(i)])));

    // The camera photo: upright, lossy, EXIF kept without GPS and with Orientation reset.
    assert.match(T['camera.webp'], /^camera\.webp JPG 1200×800, 216 KB → WebP 1200×800, \d+ KB \(\d+% smaller\) Rotated upright using the photo’s orientation tag\. EXIF kept without location\.$/);
    assert.deepEqual(R['camera.webp'].chunks, ['VP8X', 'VP8', 'EXIF']);
    assert.deepEqual([R['camera.webp'].flags, R['camera.webp'].w, R['camera.webp'].h, R['camera.webp'].vw, R['camera.webp'].vh], [0x08, 1200, 800, 1200, 800]);
    const tags = exifTags(R['camera.webp'].exif);
    assert.deepEqual([tags[0x010f], tags[0x0110], tags[0x0112]], ['TestCam', 'TC-1', 1]);
    assert.equal(tags[0x8825], undefined, 'no GPS pointer');
    if (V) {
      assert.deepEqual(V['camera.webp'].size, [1200, 800]);
      assert.ok(V['camera.webp'].psnr > 33, 'camera PSNR ' + V['camera.webp'].psnr);
      assert.deepEqual(V['camera.webp'].exif, { make: 'TestCam', model: 'TC-1', orientation: 1, dateTimeOriginal: '2026:10:05 14:30:00', gps: false, width: null, height: null });
    }
    // Wide-gamut profiles: the JPG's own profile goes into the WebP with the colours as stored.
    for (const [n, icc, name] of [['p3.webp', 'p3.icc', 'Display P3 (test)'], ['adobe.webp', 'adobe.icc', 'Adobe RGB primaries (test)']]) {
      assert.deepEqual(R[n].chunks, ['VP8X', 'ICCP', 'VP8'], n);
      assert.equal(R[n].flags, 0x20, n);
      assert.ok(R[n].iccp.equals(fs.readFileSync(fx(icc))), n + ': the JPG profile, byte for byte');
      assert.match(T[n], new RegExp('Colour profile “' + name.replace(/[()]/g, '\\$&') + '” kept, so the colours look as in the original\\. The original had no EXIF data to keep\\.$'));
      if (V) {
        assert.equal(V[n].iccName, name);
        // Stored values compared with the JPG's stored values, and both seen through their profiles.
        assert.ok(V[n].psnr > 34 && V[n].srgbPsnr > 34, `${n}: PSNR ${V[n].psnr}, as seen ${V[n].srgbPsnr}`);
      }
    }
    // Chromium shows the P3 WebP as it shows the P3 JPG (both colour-managed): the saturated red end.
    near((await chromePixels(entries['p3.webp'], [[2, 20]]))[0], (await chromePixels(fs.readFileSync(fx('p3.jpg')), [[2, 20]]))[0], 6, 'P3 red as shown');
    // CMYK: converted to sRGB as the browser shows it, and no profile.
    assert.deepEqual(R['cmyk.webp'].chunks, ['VP8']);
    assert.match(T['cmyk.webp'], /This is a CMYK JPG, made for print: its colours were converted to RGB \(sRGB\)\./);
    const cm = await chromePixels(fs.readFileSync(fx('cmyk.jpg')), [[10, 24], [54, 24]]);
    const cw = await chromePixels(entries['cmyk.webp'], [[10, 24], [54, 24]]);
    near(cw[0], cm[0], 8, 'CMYK cyan half'); near(cw[1], cm[1], 8, 'CMYK magenta half');
    // The rest.
    assert.deepEqual(R['web.webp'].chunks, ['VP8']);
    if (V) assert.ok(V['web.webp'].psnr > 33, 'web PSNR ' + V['web.webp'].psnr);
    assert.deepEqual([R['tiny.webp'].w, R['tiny.webp'].h], [1, 1]);
    near((await chromePixels(entries['tiny.webp'], [[0, 0]]))[0], [10, 120, 200, 255], 6, '1 x 1');
    assert.match(T['cut.webp'], /The file seems to be cut off, so part of the picture may be blank\./);
    // Stored sideways, the rows that were there end up on the right once it is turned upright.
    const cutPx = await chromePixels(entries['cut.webp'], [[1190, 400], [10, 400]]);
    assert.equal(cutPx[0][3], 255, 'the part that was there is opaque');
    assert.equal(cutPx[1][3], 0, 'the missing part is transparent');
    assert.match(T['png-named.webp'], /^png-named\.webp PNG 40×30, /);
    near((await chromePixels(entries['png-named.webp'], [[20, 15]]))[0], [40, 160, 90, 255], 6, 'PNG named .jpg');
    assert.match(T['small.webp'], /^small\.webp HEIC 64×48, /);
    assert.deepEqual(R['small.webp'].chunks, ['VP8']);
    // The panorama: WebP's 16,383 px limit, scaled to fit and said so.
    assert.match(T['pano.webp'], /^pano\.webp JPG 20000×200, [\d.]+ KB → WebP 16383×164, .* Scaled down to 16383×164: a WebP can be at most 16,383 pixels wide or high\./);
    assert.deepEqual([R['pano.webp'].w, R['pano.webp'].h], [16383, 164]);
    const pano = await chromePixels(entries['pano.webp'], [[4, 80], [16378, 80]]);
    near(pano[0], [0, 120, 255, 255], 10, 'pano left'); near(pano[1], [255, 120, 0, 255], 10, 'pano right');
    assert.deepEqual(await page.$$eval('.imc-flag', fs => fs.map(f => f.textContent).filter(Boolean)), [], 'nothing grew at 80%');

    // ---------- Photo metadata: keep all (GPS included), remove all ----------
    await rerun(() => page.selectOption('#imc-meta', 'keep'));
    let cam = riff((await download(0)).data);
    assert.ok(exifTags(cam.exif)[0x8825] > 0, 'GPS kept with "Keep all"');
    assert.match(await rowText(0), /EXIF kept, including any location\.$/);
    await rerun(() => page.selectOption('#imc-meta', 'strip'));
    cam = riff((await download(0)).data);
    assert.deepEqual(cam.chunks, ['VP8'], 'no EXIF, no VP8X');
    await rerun(() => page.selectOption('#imc-meta', 'nogps'));

    // ---------- Quality 95 from the keyboard: compressed JPGs grow, are flagged and can stay out of the ZIP ----------
    await page.focus('#imc-quality');
    await rerun(async () => { for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight'); });
    assert.equal(await page.textContent('#imc-quality-out'), '95%');
    z = await zipNow();
    entries = unzip(z.data);
    const grew = NAMES.filter((n, i) => entries[n].length >= fs.statSync(fx(FILES[i])).size);
    assert.ok(grew.includes('web.webp'), 'the photo saved at 60 grows as a WebP at 95: ' + grew);
    assert.ok(!grew.includes('camera.webp'), 'the camera photo still shrinks');
    const flags = await page.$$eval('.imc-item', ls => ls.map(l => (l.querySelector('.imc-flag') || {}).textContent || ''));
    NAMES.forEach((n, i) => assert.equal(flags[i], grew.includes(n) ? 'Larger than the original: keep the ' + (n === 'png-named.webp' ? 'PNG' : n === 'small.webp' ? 'HEIC' : 'JPG') : '', n));
    const k = grew.length;
    assert.match(await page.textContent('#imc-summary'), new RegExp((k === 1 ? '1 file is not smaller than its original' : k + ' files are not smaller than their originals') + '\\.$'));
    await page.waitForFunction(k => document.querySelector('#imc-status').textContent.endsWith(' ' + (k === 1 ? '1 is' : k + ' are') + ' not smaller than the original.'), k);
    // From the keyboard: Space ticks the box by the ZIP button.
    await page.focus('#imc-skip');
    await page.keyboard.press('Space');
    assert.equal(await page.isChecked('#imc-skip'), true);
    assert.equal(await page.textContent('#imc-zip'), `Download ${10 - k} of 10 (ZIP)`);
    await page.waitForFunction(k => document.querySelector('#imc-status').textContent === `The ZIP holds ${10 - k} of the 10 files: those that got smaller.`, k);
    await page.focus('#imc-zip');
    const [kd] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    entries = unzip(fs.readFileSync(await kd.path()));
    assert.deepEqual(Object.keys(entries).sort(), NAMES.filter(n => !grew.includes(n)).sort());
    await page.uncheck('#imc-skip');

    // ---------- A longest-side preset: big pictures shrink, small ones are not enlarged ----------
    await page.focus('#imc-quality');
    await rerun(async () => { for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowLeft'); });
    await rerun(() => page.selectOption('#imc-resize', 'max-1280'));
    assert.equal(await page.isVisible('#imc-resize-val'), false, 'a preset needs no number');
    assert.equal(await page.textContent('#imc-note'), NOTE + ' Images smaller than this are not enlarged.');
    assert.match(await rowText(0), /→ WebP 1200×800, /);
    assert.match(await rowText(9), /→ WebP 1280×13, /);
    assert.doesNotMatch(await rowText(9), /Scaled down/);

    // ---------- The size box: decimal commas and thousands, in English and German; an error state ----------
    await page.selectOption('#imc-resize', 'width');
    const other = await page.context().browser().newContext({ locale: 'de-DE' });
    const de = await other.newPage();
    await de.goto(url);
    for (const p of [page, de]) {
      for (const [mode, text, want] of [['width', '1.920', /Read as 1920 pixels\./], ['width', '1,920', /Read as 1920 pixels\./], ['width', '0,500', /Read as 0\.5 pixels\./],
        ['percent', '12,5', /Read as 12\.5%\./], ['width', '5²', /“5²” is not a size this tool can read/], ['width', '1٬920', /is not a size this tool can read/]]) {
        if (await p.inputValue('#imc-resize') !== mode) await p.selectOption('#imc-resize', mode);
        await p.fill('#imc-resize-val', text);
        await p.waitForFunction(([s, f]) => new RegExp(s, f).test(document.querySelector('#imc-note').textContent), [want.source, want.flags], { timeout: 5000 });
        const bad = /not a size/.test(want.source);
        assert.deepEqual(await p.$eval('#imc-resize-val', (el) => [el.getAttribute('aria-invalid'), el.getAttribute('aria-describedby')]), [bad ? 'true' : 'false', 'imc-note'], `"${text}"`);
      }
    }
    await other.close();
    // Over-long text is refused with a message in the error box, which goes once a normal value is typed.
    await page.selectOption('#imc-resize', 'width');
    await page.$eval('#imc-resize-val', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.focus('#imc-resize-val');
    const t0 = Date.now();
    await page.keyboard.insertText('9'.repeat(1 << 20));
    assert.ok(Date.now() - t0 < 3000, `a megabyte paste took ${Date.now() - t0} ms`);
    assert.equal(await page.inputValue('#imc-resize-val'), '', 'the long text must not land in the field');
    assert.equal(await page.textContent('#imc-error.msg.error'), 'That text is too long to be a size, so it was not pasted. Sizes have at most 5 digits.');
    await page.selectOption('#imc-resize', 'none');

    // ---------- The keyboard alone: choose a file, convert, download ----------
    // From a fresh page, Tab reaches Choose images.
    await open();
    for (let i = 0; i < 40 && await page.evaluate(() => document.activeElement.id) !== 'imc-choose'; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'imc-choose');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await chooser.setFiles([fx('camera.jpg')]);
    await settled(1);
    await page.focus('.imc-item [data-act="dl"]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none' || getComputedStyle(document.activeElement).boxShadow !== 'none'), true, 'a visible focus ring');
    const [kb] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    assert.equal(kb.suggestedFilename(), 'camera.webp');
    assert.deepEqual(riff(fs.readFileSync(await kb.path())).chunks, ['VP8X', 'VP8', 'EXIF']);

    // ---------- Back from another page: the restored controls and what they show agree ----------
    await page.selectOption('#imc-resize', 'width');
    await page.goto('about:blank');
    await page.goBack();
    await page.waitForFunction(() => window.TTImage && document.querySelector('#imc-note').textContent !== '');
    assert.equal(await page.evaluate(() => document.querySelector('#imc-resize-val').hidden === (document.querySelector('#imc-resize').value === 'none')), true);

    // ---------- A phone, by touch: an iPhone-style sideways photo ----------
    const { devices } = require('playwright');
    const ph = await page.context().browser().newContext({ ...devices['Pixel 7'], acceptDownloads: true });
    const pp = await ph.newPage();
    const errs = [];
    pp.on('pageerror', e => errs.push(e.message));
    await pp.goto(url);
    const [pc] = await Promise.all([pp.waitForEvent('filechooser'), pp.tap('#imc-choose')]);
    await pc.setFiles([fx('camera.jpg'), fx('p3.jpg')]);
    await settled(2, pp);
    assert.match(await rowText(0, pp), /^camera\.webp JPG 1200×800, .* Rotated upright/);
    const [pdl] = await Promise.all([pp.waitForEvent('download'), pp.locator('.imc-item [data-act="dl"]').first().tap()]);
    const pw = riff(fs.readFileSync(await pdl.path()));
    assert.deepEqual([pw.chunks.join(), pw.w, pw.h], ['VP8X,VP8,EXIF', 1200, 800]);
    await pp.tap('.imc-skip');
    assert.equal(await pp.isChecked('#imc-skip'), true);
    const small = await pp.$$eval('#imc-choose, #imc-zip, #imc-clear, .imc-item .btn, .imc-skip, #imc-quality, #imc-format, #imc-resize, #imc-meta', els => els.filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.className));
    assert.deepEqual(small, [], 'controls under 44 px on a phone');
    assert.deepEqual(errs, []);
    await ph.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
