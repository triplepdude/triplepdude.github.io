// PNG to WebP: the image converter with webp_mode="lossless", profile="keep" and
// compare="true". Fixtures (made by tests/fixtures/png-to-webp/make_fixtures.py,
// which lists them): PNGs of every kind (RGBA, palette, 1/2/4-bit, 16-bit,
// interlaced, colour keys, a Display P3 profile, gAMA 1.0, an APNG), a cut-off
// PNG, a JPEG named .png, an empty file and a text file. Every WebP the page
// writes is read back with verify.py (Pillow's libwebp, littleCMS) and with the
// RIFF parser below; big pictures are made here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// RIFF/WebP: chunk list, canvas size, VP8X flags, VP8L alpha bit, ICCP and EXIF bodies.
function riff(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP');
  const out = { chunks: [], flags: null, alphaBit: null, iccp: null, exif: null };
  if (b.readUInt32LE(4) + 8 !== b.length) throw new Error('RIFF size ' + (b.readUInt32LE(4) + 8) + ' != file size ' + b.length);
  for (let p = 12; p + 8 <= b.length;) {
    const t = b.toString('latin1', p, p + 4), len = b.readUInt32LE(p + 4), d = b.subarray(p + 8, p + 8 + len);
    out.chunks.push(t.trim());
    if (t === 'VP8X') { out.flags = d[0]; out.w = d.readUIntLE(4, 3) + 1; out.h = d.readUIntLE(7, 3) + 1; }
    if (t === 'VP8L') {
      const bits = d.readUInt32LE(1);
      if (d[0] !== 0x2f) throw new Error('VP8L signature');
      out.lw = (bits & 0x3fff) + 1; out.lh = ((bits >>> 14) & 0x3fff) + 1; out.alphaBit = (bits >>> 28) & 1;
    }
    if (t === 'VP8 ') { out.lw = d.readUInt16LE(6) & 0x3fff; out.lh = d.readUInt16LE(8) & 0x3fff; }
    if (t === 'ICCP') out.iccp = Buffer.from(d);
    if (t === 'EXIF') out.exif = Buffer.from(d);
    p += 8 + len + (len & 1);
  }
  if (out.w == null) { out.w = out.lw; out.h = out.lh; }
  return out;
}
// ZIP (APPNOTE 6.3) entries from the central directory, CRCs checked.
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
// A PNG of one colour (8-bit RGB), any size, kept small with the Sub filter.
function flatPng(w, h, rgb) {
  const line = Buffer.alloc(1 + w * 3);
  line.set([1, ...rgb]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => line)), { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
// The converter's own size format, to compare the rows with the files.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'png-to-webp-'));
  // Pillow and numpy check the files where they are installed (as here); without them the
  // RIFF parser and Chromium's own decoder still do.
  let pillow = true;
  try { execFileSync('python3', ['-c', 'import PIL.WebPImagePlugin, numpy'], { stdio: 'ignore' }); } catch (e) { pillow = false; }
  if (!pillow) console.log('  (png-to-webp: python3 with Pillow and numpy is missing: WebP files are checked in Chromium only)');
  const verify = pairs => {
    if (!pillow) return null;
    const args = [];
    pairs.forEach(([src, data], i) => { const f = path.join(tmp, i + '.webp'); fs.writeFileSync(f, data); args.push(src, f); });
    return JSON.parse(execFileSync('python3', [fx('verify.py'), ...args], { maxBuffer: 64 << 20 }).toString());
  };

  try {
    await open();
    assert.equal(await page.textContent('h1'), 'PNG to WebP Converter: Lossless or Lossy');

    // ---------- Set up for PNG to WebP as served, and nothing moves as the script starts ----------
    const NOTE = 'Lossless: every pixel, transparency included, is kept exactly. For photos, Lossy makes far smaller files.';
    const HINT = 'PNG images, transparent ones included, as many as you like. Nothing is uploaded.';
    const START = ['webp', 'lossless', '80', '80%', 'strip', 'none', 'true,false,false,true,false,true,true', NOTE, HINT, 'false'];
    const load = await page.evaluate(async () => {
      const state = doc => {
        const q = s => doc.querySelector(s);
        return [q('#imc-format').value, (q('input[name="imc-mode"]:checked') || {}).value, q('#imc-quality').value, q('#imc-quality-out').textContent, q('#imc-meta').value, q('#imc-resize').value,
          ['#imc-quality-field', '#imc-mode-field', '#imc-resize-field', '#imc-bg-field', '#imc-meta-field', '#imc-sizes', '#imc-resize-val'].map(s => q(s).hidden).join(),
          q('#imc-note').textContent, q('#imc-drop .hint').textContent, String(q('#imc-skip').checked)];
      };
      const live = state(document);
      const html = await (await fetch(location.href)).text();
      await Promise.all(['webp', 'avif'].map(f => TTImage.canEncode(f, { wasm: true })));
      await new Promise(r => setTimeout(r, 50));
      return { html, served: state(new DOMParser().parseFromString(html, 'text/html')), live, settled: state(document) };
    });
    assert.doesNotMatch(load.html, /\{%|\{\{|include\.|imc_[a-z]|webp_mode|animated_note/, 'Liquid or include notes in the page');
    assert.deepEqual(load.served, START);
    assert.deepEqual(load.live, START, 'the script changed the controls as it started');
    assert.deepEqual(load.settled, START, 'the encoder checks changed the controls');
    // The WebP option stays on: libwebp runs here.
    assert.deepEqual(await page.$eval('#imc-format option[value="webp"]', o => [o.disabled, o.textContent]), [false, 'WebP']);
    assert.deepEqual(await page.$$eval('#imc-mode-field label', ls => ls.map(l => l.textContent.trim())), ['Lossless', 'Lossy']);
    assert.equal(await page.textContent('#imc-mode-field legend'), 'WebP compression');
    assert.equal((await page.textContent('label[for="imc-skip"], .imc-skip')).trim(), 'Leave files that are not smaller out of the ZIP');
    // Nothing loads the encoder until a WebP is made.
    const requests = [];
    page.on('request', r => requests.push(r.url()));

    // ---------- The guide and the FAQ ----------
    const links = await page.$$eval('.prose a', as => as.map(a => a.getAttribute('href')));
    for (const h of ['/webp-to-png/', '/jpg-to-webp/', '/compress-image/']) assert.ok(links.includes(h), `guide links to ${h}`);
    for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `guide link ${h} is not a tool page`);
    const guide = (await page.textContent('.prose')).replace(/\s+/g, ' ');
    // The guide names the real controls and messages.
    assert.match(guide, /Tick Leave files that are not smaller out of the ZIP to download only the ones worth replacing\./);
    assert.match(guide, /is marked “Larger than the original: keep the PNG”/);
    assert.match(guide, /Lossless files over 4 megapixels use a faster setting, about 1% larger\./);
    assert.deepEqual(await page.$$eval('.faq summary', s => s.map(e => e.textContent.trim())), [
      'Is PNG to WebP lossless?', 'Does WordPress accept WebP images?', 'Can I convert PNG to WebP on an iPhone?', 'Are my PNG files uploaded?']);
    const faq = (await page.textContent('.faq')).replace(/\s+/g, ' ');
    assert.match(faq, /With Lossless chosen, as it is when the page opens, yes: decode the WebP and you get the PNG’s pixels back, transparency included\./);
    assert.match(faq, /On a phone, lossless files are limited to 13 megapixels to fit in its memory, and larger pictures are scaled down with a note\./);

    const rows = page.locator('.imc-item');
    const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ').replace(/( Download)? ×$/, '').trim();
    const download = async (i, p = page) => {
      const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('.imc-item').nth(i).locator('[data-act="dl"]').click()]);
      return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
    };
    const zipNow = async (p = page) => {
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#imc-zip')]);
      return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
    };
    const settled = (n, p = page) => p.waitForFunction(n => {
      const t = document.querySelector('#imc-summary').textContent;
      return new RegExp('^\\d+ of ' + n + ' converted').test(t) && !/working/.test(t) && !document.querySelector('.imc-item progress:not([hidden])');
    }, n, { timeout: 60000 });
    const rerun = async action => {
      await page.evaluate(() => {
        window.__saw = false;
        const el = document.querySelector('#imc-summary');
        if (window.__mo) window.__mo.disconnect();
        window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
        window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
      });
      await action();
      await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 60000 });
    };
    // Chromium's own decode of a file, at a few points (for files whose colours the browser changes).
    const chromePixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]), { premultiplyAlpha: 'none' });
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
    }, [buf.toString('base64'), pts]);

    // ---------- Every kind of PNG, lossless ----------
    const FILES = ['logo.png', 'screenshot.png', 'photo.png', 'flat.png', 'interlaced.png', 'grey2.png', 'pal4.png', 'rgb16.png', 'ga16.png',
      'rgbkey.png', 'p3.png', 'gamma1.png', 'anim.png', 'cut.png', 'dot.png', 'photo-as.png', 'empty.png', 'notes.png'];
    await page.setInputFiles('#imc-file', FILES.map(fx));
    await settled(FILES.length);
    assert.match(await page.textContent('#imc-summary'), /^16 of 18 converted, 2 failed\. In total [\d.]+ KB → [\d.]+ KB \(\d+% smaller\)\. 2 files are not smaller than their originals\.$/);
    await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 16 images to WebP. 2 could not be converted. 2 are not smaller than the original.');
    assert.ok(requests.some(u => /\/assets\/vendor\/webp\/webp_enc(_simd)?\.wasm$/.test(u)), 'the WebP encoder loads on the first WebP');
    assert.ok(!requests.some(u => /avif_enc/.test(u)), 'the AVIF encoder is not loaded');

    // The two that fail say why, and offer no download.
    assert.equal(await rowText(16), 'empty.png 0 B The file is empty (0 bytes).');
    assert.match(await rowText(17), /^notes\.png 35 B This is not a supported image\./);
    assert.deepEqual(await page.$$eval('.imc-item:nth-child(n+17) [data-act="dl"]', b => b.map(x => x.hidden)), [true, true]);

    // The ZIP holds all 16, the same bytes as each Download button.
    let z = await zipNow();
    assert.equal(z.name, 'converted-images-webp.zip');
    let entries = unzip(z.data);
    const NAMES = FILES.slice(0, 16).map(f => f.replace(/\.png$/, '.webp'));
    assert.deepEqual(Object.keys(entries).sort(), NAMES.slice().sort());
    for (const i of [0, 10, 15]) {
      const d = await download(i);
      assert.equal(d.name, NAMES[i]);
      assert.ok(d.data.equals(entries[NAMES[i]]), `${NAMES[i]}: Download and ZIP differ`);
    }
    // Each row: the sizes of the original and of the WebP in the ZIP, and the change between them.
    let before = 0, after = 0;
    for (let i = 0; i < 16; i++) {
      const src = fs.statSync(fx(FILES[i])).size, out = entries[NAMES[i]].length;
      before += src; after += out;
      const t = await rowText(i);
      const head = t.slice(0, t.indexOf(')') + 1 || t.length);
      assert.ok(t.startsWith(NAMES[i] + ' '), t);
      assert.ok(t.includes(', ' + fmtBytes(src) + ' → WebP ') && t.includes(', ' + fmtBytes(out) + change(src, out)), `${NAMES[i]}: ${head} (want ${fmtBytes(src)} → ${fmtBytes(out)}${change(src, out)})`);
    }
    assert.ok((await page.textContent('#imc-summary')).includes(`In total ${fmtBytes(before)} → ${fmtBytes(after)}${change(before, after)}.`), 'the total matches the files');

    const losslessSize = Object.fromEntries(NAMES.map(n => [n, entries[n].length]));
    // Containers: lossless (VP8L) everywhere; VP8X and ICCP only for the P3 profile; the alpha bit set where there is transparency.
    const info = Object.fromEntries(NAMES.map(n => [n, riff(entries[n])]));
    for (const n of NAMES) {
      if (n === 'p3.webp') assert.deepEqual(info[n].chunks, ['VP8X', 'ICCP', 'VP8L'], n);
      else assert.deepEqual(info[n].chunks, ['VP8L'], n);
    }
    assert.equal(info['p3.webp'].flags, 0x20, 'VP8X: ICC flag only');
    assert.ok(info['p3.webp'].iccp.equals(fs.readFileSync(fx('p3.icc'))), 'the PNG profile is copied byte for byte');
    for (const n of ['logo.webp', 'interlaced.webp', 'grey2.webp', 'pal4.webp', 'ga16.webp', 'rgbkey.webp', 'cut.webp']) assert.equal(info[n].alphaBit, 1, n + ' has alpha');
    for (const n of ['screenshot.webp', 'photo.webp', 'flat.webp', 'rgb16.webp', 'p3.webp', 'dot.webp']) assert.equal(info[n].alphaBit, 0, n + ' is opaque');
    assert.deepEqual([info['screenshot.webp'].w, info['screenshot.webp'].h, info['dot.webp'].w, info['dot.webp'].h], [480, 300, 1, 1]);

    // Pixels, read back with Pillow: exactly the PNG's, alpha included, wherever the browser shows them unchanged.
    const v = verify(NAMES.map((n, i) => [fx(FILES[i]), entries[n]]));
    if (v) {
      NAMES.forEach((n, i) => {
        const r = v[i];
        assert.equal(r.format, 'WEBP', n);
        assert.equal(r.frames, 1, n);
        if (n === 'gamma1.webp' || n === 'cut.webp') return;
        assert.deepEqual([r.maxDiff, r.alphaDiff], [0, 0], `${n}: lossless must keep every visible pixel: ${JSON.stringify(r)}`);
        assert.equal(r.exif, null, n + ': no EXIF was asked for');
      });
      const p3 = v[NAMES.indexOf('p3.webp')];
      assert.deepEqual([p3.icc, p3.iccName], [p3.srcIcc, 'Display P3 (test)'], 'littleCMS reads the copied profile');
      assert.equal(p3.srgbPsnr, 99, 'converted to sRGB, the WebP looks exactly like the PNG');
      // The cut-off file: what was there is exact (173 of 300 rows), the rest transparent.
      const cut = v[NAMES.indexOf('cut.webp')];
      assert.ok(cut.exactRows >= 170 && cut.exactRows < 300, 'cut.png rows kept: ' + cut.exactRows);
      assert.deepEqual(cut.pixels[2].slice(2), [0, 0, 0, 0], 'the missing part is transparent');
    }
    // gAMA 1.0: the browser brightens it, and the WebP holds what the browser shows.
    const g1 = await chromePixels(fs.readFileSync(fx('gamma1.png')), [[1, 1], [20, 10], [31, 15]]);
    assert.deepEqual(await chromePixels(entries['gamma1.webp'], [[1, 1], [20, 10], [31, 15]]), g1, 'gamma1: as Chromium shows the PNG');
    // Chromium decodes every WebP the page wrote, to the same pixels as Pillow.
    if (v) {
      for (const n of ['logo.webp', 'pal4.webp', 'p3.webp']) {
        const want = v[NAMES.indexOf(n)].pixels;
        const got = await chromePixels(entries[n], want.map(p => [p[0], p[1]]));
        // Chromium shows the P3 file converted to sRGB, so only its position matters here. Its
        // canvas keeps no colour under transparent pixels and rounds semi-transparent ones.
        if (n !== 'p3.webp') got.forEach((g, k) => {
          const w = want[k].slice(2);
          assert.equal(g[3], w[3], `${n}: alpha at ${want[k].slice(0, 2)}: Chromium ${g}, Pillow ${w}`);
          if (w[3]) assert.ok(g.slice(0, 3).every((c, j) => Math.abs(c - w[j]) <= (w[3] === 255 ? 0 : Math.ceil(255 / w[3]))), `${n} at ${want[k].slice(0, 2)}: Chromium ${g}, Pillow ${w}`);
        });
      }
    }

    // ---------- What each file says ----------
    const notes = Object.fromEntries(await Promise.all(NAMES.map(async (n, i) => [n, await rowText(i)])));
    assert.match(notes['rgb16.webp'], /16-bit PNG: WebP holds 8 bits a channel, so each colour was rounded to 8 bits\.$/);
    assert.match(notes['ga16.webp'], /16-bit PNG: WebP holds 8 bits a channel/);
    assert.doesNotMatch(notes['logo.webp'], /16-bit/);
    assert.match(notes['p3.webp'], /Colour profile “Display P3 \(test\)” kept, so the colours look as in the original\.$/);
    assert.match(notes['anim.webp'], /Animated image: only the first frame was converted\.$/);
    assert.match(notes['cut.webp'], /The file seems to be cut off, so part of the picture may be blank\.$/);
    assert.match(notes['photo-as.webp'], /^photo-as\.webp JPG 64×64, .* \(\d+% larger\) Larger than the original: keep the JPG$/);
    assert.match(notes['p3.webp'], /\(\d+% larger\) Larger than the original: keep the PNG /);
    // Every other row: no flag.
    assert.deepEqual(await page.$$eval('.imc-flag', fs => fs.map(f => f.textContent).filter(Boolean)), ['Larger than the original: keep the PNG', 'Larger than the original: keep the JPG']);

    // ---------- Leaving the files that did not shrink out of the ZIP ----------
    await page.check('#imc-skip');
    assert.equal(await page.textContent('#imc-zip'), 'Download 14 of 16 (ZIP)');
    assert.match(await page.textContent('#imc-summary'), /2 files are not smaller than their originals, so the ZIP leaves them out\.$/);
    await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'The ZIP holds 14 of the 16 files: those that got smaller.');
    // A double click makes one ZIP.
    const zips = [], onZip = d => zips.push(d);
    page.on('download', onZip);
    await page.dblclick('#imc-zip');
    await page.waitForFunction(() => /^The ZIP holds|^ZIP with/.test(document.querySelector('#imc-status').textContent) && document.querySelector('#imc-zip').textContent !== 'Creating ZIP…');
    await page.waitForTimeout(300);
    page.off('download', onZip);
    assert.equal(zips.length, 1, 'a double click made ' + zips.length + ' ZIPs');
    // A double click on a file's Download saves it once.
    const singles = [], onOne = d => singles.push(d);
    page.on('download', onOne);
    await page.dblclick('.imc-item:nth-child(2) [data-act="dl"]');
    await page.waitForTimeout(500);
    page.off('download', onOne);
    assert.deepEqual(singles.map(d => d.suggestedFilename()), ['screenshot.webp'], 'a double click on Download');
    entries = unzip(fs.readFileSync(await zips[0].path()));
    assert.deepEqual(Object.keys(entries).sort(), NAMES.filter(n => n !== 'p3.webp' && n !== 'photo-as.webp').sort());
    assert.equal(await page.textContent('#imc-status'), 'ZIP with 14 images downloaded. 2 not smaller than their originals were left out.');
    await page.uncheck('#imc-skip');
    assert.equal(await page.textContent('#imc-zip'), 'Download all (ZIP)');

    // ---------- Lossy, chosen from the keyboard: transparency still exact ----------
    await page.focus('#imc-mode-field input[value="lossless"]');
    await rerun(() => page.keyboard.press('ArrowDown'));
    assert.equal(await page.$eval('input[name="imc-mode"]:checked', r => r.value), 'lossy');
    assert.equal(await page.isVisible('#imc-quality-field'), true, 'the quality slider shows for lossy');
    assert.equal(await page.textContent('#imc-note'), 'Lossy: much smaller files for photos, with a little loss of detail; transparency is still kept exactly. For photos, Lossy makes far smaller files.');
    z = await zipNow();
    entries = unzip(z.data);
    const lossy = Object.fromEntries(['logo.webp', 'photo.webp', 'screenshot.webp', 'flat.webp'].map(n => [n, riff(entries[n])]));
    assert.deepEqual(lossy['logo.webp'].chunks, ['VP8X', 'ALPH', 'VP8'], 'lossy with alpha: ALPH then VP8');
    assert.equal(lossy['logo.webp'].flags, 0x10, 'VP8X: alpha flag');
    assert.deepEqual(lossy['photo.webp'].chunks, ['VP8']);
    const photoLossy = entries['photo.webp'].length;
    assert.ok(photoLossy * 4 < losslessSize['photo.webp'], `lossy photo (${photoLossy}) is far smaller than lossless (${losslessSize['photo.webp']})`);
    if (pillow) {
      const lv = verify([[fx('logo.png'), entries['logo.webp']], [fx('photo.png'), entries['photo.webp']], [fx('screenshot.png'), entries['screenshot.webp']]]);
      assert.equal(lv[0].alphaDiff, 0, 'lossy keeps alpha exactly');
      assert.ok(lv[0].psnr > 30 && lv[1].psnr > 30 && lv[2].psnr > 25, 'lossy at 80 stays close: ' + lv.map(r => r.psnr));
      assert.ok(lv[1].maxDiff > 0, 'lossy is lossy');
    }
    // The quality slider, from the keyboard: 80% -> 60%, a smaller photo.
    await page.focus('#imc-quality');
    await rerun(async () => { for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft'); });
    assert.equal(await page.textContent('#imc-quality-out'), '60%');
    const at60 = (await download(2)).data;
    assert.ok(at60.length < photoLossy, `quality 60 (${at60.length}) should be smaller than 80 (${photoLossy})`);
    // The choice survives a trip to another format and back.
    await rerun(() => page.selectOption('#imc-format', 'png'));
    assert.equal(await page.isVisible('#imc-mode-field'), false, 'the switch is for WebP only');
    assert.match(await rowText(0), /^logo\.png PNG 120×80/);
    await rerun(() => page.selectOption('#imc-format', 'webp'));
    assert.deepEqual([await page.$eval('input[name="imc-mode"]:checked', r => r.value), await page.inputValue('#imc-quality')], ['lossy', '60']);
    await rerun(() => page.check('#imc-mode-field input[value="lossless"]'));
    assert.equal(await page.isVisible('#imc-quality-field'), false, 'no quality slider for lossless');
    const again = await download(2);
    assert.deepEqual([riff(again.data).chunks.join(), again.data.length], ['VP8L', losslessSize['photo.webp']], 'lossless again, the same file as before');

    // ---------- A picture over WebP's 16,383 pixels, and one over 4 megapixels ----------
    await page.click('#imc-clear');
    await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'All images removed.');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
    const t0 = await threadMs();
    await page.setInputFiles('#imc-file', [
      { name: 'tall.png', mimeType: 'image/png', buffer: flatPng(1280, 20000, [30, 90, 150]) },
      { name: 'big.png', mimeType: 'image/png', buffer: flatPng(2500, 2000, [200, 40, 90]) }]);
    await settled(2);
    const busyMs = await threadMs() - t0;
    // Decoding and encoding run in workers: the page itself stays free.
    assert.ok(busyMs < 2500, `main thread busy for ${Math.round(busyMs)} ms while converting 30 megapixels`);
    assert.match(await rowText(0), /^tall\.webp PNG 1280×20000, [\d.]+ KB → WebP 1048×16383, [\d.]+ K?B \((over )?\d+% smaller\) Scaled down to 1048×16383: a WebP can be at most 16,383 pixels wide or high\. Over 4 megapixels, so libwebp’s faster lossless setting was used: about 2\.4 times quicker, for a file about 1% larger\.$/);
    const tall = await download(0);
    assert.deepEqual([riff(tall.data).w, riff(tall.data).h, riff(tall.data).chunks.join()], [1048, 16383, 'VP8L']);
    assert.deepEqual((await chromePixels(tall.data, [[500, 16000]]))[0], [30, 90, 150, 255]);
    assert.match(await rowText(1), /^big\.webp PNG 2500×2000, .* → WebP 2500×2000, .* Over 4 megapixels, so libwebp’s faster lossless setting was used: about 2\.4 times quicker, for a file about 1% larger\.$/);

    // ---------- Removing a file stops its encoder; nothing it made is offered ----------
    await page.click('#imc-clear');
    await page.setInputFiles('#imc-file', [{ name: 'slow.png', mimeType: 'image/png', buffer: flatPng(3000, 3000, [10, 20, 30]) }]);
    await page.waitForFunction(() => /Loading the WebP encoder|Converting to WebP/.test(document.querySelector('.imc-item .imc-meta').textContent), null, { timeout: 20000 });
    await page.click('.imc-item [data-act="rm"]');
    assert.equal(await page.textContent('#imc-status'), 'slow.png removed.');
    assert.equal(await page.locator('.imc-item').count(), 0);
    // The encoder is ready again for the next file.
    await page.setInputFiles('#imc-file', [fx('logo.png')]);
    await settled(1);
    assert.match(await rowText(0), /^logo\.webp PNG 120×80, 3\.4 KB → WebP 120×80/);

    // ---------- Safari 15 to 16.3: its canvas cannot write WebP, and it has no WebAssembly SIMD ----------
    // libwebp makes the file instead, from the build without SIMD.
    await page.addInitScript(() => {
      WebAssembly.validate = () => false;
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { return toBlob.call(this, cb, type === 'image/webp' ? 'image/png' : type, q); };
      if (typeof OffscreenCanvas === 'function') {
        const c2b = OffscreenCanvas.prototype.convertToBlob;
        OffscreenCanvas.prototype.convertToBlob = function (o) { return c2b.call(this, o && o.type === 'image/webp' ? Object.assign({}, o, { type: 'image/png' }) : o); };
      }
    });
    requests.length = 0;
    await open();
    assert.equal(await page.evaluate(() => TTImage.canEncode('webp')), false, 'the canvas refuses WebP, as in Safari');
    assert.equal(await page.evaluate(() => TTImage.canEncode('webp', { wasm: true })), true);
    await page.setInputFiles('#imc-file', [fx('logo.png')]);
    await settled(1);
    const saf = await download(0);
    assert.deepEqual(riff(saf.data).chunks, ['VP8L']);
    assert.ok(requests.some(u => /\/assets\/vendor\/webp\/webp_enc\.wasm$/.test(u)) && !requests.some(u => /webp_enc_simd/.test(u)), 'the build without SIMD: ' + requests.filter(u => /webp_enc/.test(u)));
    if (pillow) assert.deepEqual((({ maxDiff, alphaDiff }) => [maxDiff, alphaDiff])(verify([[fx('logo.png'), saf.data]])[0]), [0, 0]);

    // ---------- No WebAssembly either: WebP is unavailable, and never replaced by a JPG ----------
    await page.addInitScript(() => { delete window.WebAssembly; delete window.OffscreenCanvas; });
    await open();
    await page.waitForFunction(() => document.querySelector('#imc-format option[value="webp"]').disabled);
    assert.equal(await page.textContent('#imc-format option[value="webp"]'), 'WebP (this browser cannot save it)');
    assert.match(await page.textContent('#imc-note'), /^This browser cannot save WebP images, so WebP output is unavailable here\./);
    await page.setInputFiles('#imc-file', [fx('logo.png')]);
    await settled(1);
    assert.equal(await rowText(0), 'logo.png 3.4 KB This browser cannot save WebP images.');

    // ---------- The encoder cannot load (a dropped connection): the file says so, and a retry works ----------
    const lctx = await page.context().browser().newContext();
    const lp = await lctx.newPage();
    let block = true;
    await lp.route(/\/assets\/vendor\/webp\/webp_enc(_simd)?\.wasm$/, r => (block ? r.abort() : r.continue()));
    await lp.goto(url);
    await lp.setInputFiles('#imc-file', [fx('logo.png')]);
    await settled(1, lp);
    assert.equal((await lp.locator('.imc-item').innerText()).replace(/\s+/g, ' ').replace(/ ×$/, ''), 'logo.png 3.4 KB The WebP encoder could not be loaded. Check your connection and try again.');
    await lp.waitForFunction(() => document.querySelector('#imc-status').textContent === 'The image could not be converted to WebP.');
    block = false;
    await lp.click('#imc-clear');
    await lp.setInputFiles('#imc-file', [fx('logo.png')]);
    await settled(1, lp);
    assert.match((await lp.locator('.imc-item').innerText()).replace(/\s+/g, ' '), /^logo\.webp PNG 120×80, 3\.4 KB → WebP 120×80/);
    await lctx.close();

    // ---------- A phone: lossless is capped at 13 megapixels, said so; touch works ----------
    const { devices } = require('playwright');
    const ph = await page.context().browser().newContext({ ...devices['Pixel 7'], acceptDownloads: true });
    const pp = await ph.newPage();
    const errs = [];
    pp.on('pageerror', e => errs.push(e.message));
    await pp.goto(url);
    assert.deepEqual(await pp.evaluate(() => TTImage.webpLimits(true)), { side: 16383, pixels: 13e6, phone: true, wasm: true });
    await pp.setInputFiles('#imc-file', [{ name: 'phone.png', mimeType: 'image/png', buffer: flatPng(4000, 3500, [250, 200, 0]) }]);
    await settled(1, pp);
    assert.match((await pp.locator('.imc-item').nth(0).innerText()).replace(/\s+/g, ' '),
      /phone\.webp PNG 4000×3500, .* → WebP 3854×3372, .* Scaled down to 3854×3372: lossless WebP files are made here up to 13 megapixels on a phone, to fit in its memory\./);
    const [pdl] = await Promise.all([pp.waitForEvent('download'), pp.locator('.imc-item [data-act="dl"]').tap()]);
    const pw = riff(fs.readFileSync(await pdl.path()));
    assert.deepEqual([pw.w, pw.h, pw.chunks.join()], [3854, 3372, 'VP8L']);
    // Lossy by touch.
    await pp.tap('#imc-mode-field label:has-text("Lossy")');
    await pp.waitForFunction(() => /→ WebP 4000×3500/.test(document.querySelector('.imc-item').textContent) && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 60000 });
    const small = await pp.$$eval('#imc-choose, #imc-zip, #imc-clear, .imc-item .btn, #imc-mode-field .check, .imc-skip, #imc-quality, #imc-format, #imc-resize', els => els.filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.className));
    assert.deepEqual(small, [], 'controls under 44 px on a phone');
    assert.deepEqual(errs, []);
    await ph.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

