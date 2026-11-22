// WebP to JPG: the image converter set up for this pair. Fixtures:
//   alpha.webp  lossless 64x48 (copy of image-converter's): left half (200,30,60),
//               right half transparent, top-right quarter (20,100,220) at alpha 128
//   anim.webp   40x30 animation, frame 1 red, frame 2 blue
//   photo.webp  scikit-image's "astronaut" sample (NASA, public domain) at
//               200x200, saved by Pillow as lossy WebP at quality 80
//   rotated.webp    lossless (Pillow), stored 120x80: a (220,30,30) band along the
//                   top 20 rows, (235,235,235) elsewhere; EXIF Orientation 6, Make
//                   TestCam, a GPS position -> shown 80x120 with the band on the right
//   late-exif.webp  40x30 lossless animation (Pillow), frame 1 (30,140,90), with an
//                   sRGB profile: chunks VP8X, ICCP, ANIM, ANMF, ANMF, then EXIF (Make
//                   LateCam, a GPS position)
const fs = require('fs');
const path = require('path');

// JPEG reader: size and chroma sampling from the frame header, EXIF from APP1.
function jpegInfo(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('not a JPEG');
  const info = { exif: false };
  for (let i = 2; i < b.length;) {
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m === 0xDA) break;
    if (m === 0xE1 && b.toString('latin1', i + 4, i + 8) === 'Exif') { info.exif = true; info.tags = exifTags(b.subarray(i + 10, i + 2 + len)); }
    if (m >= 0xC0 && m <= 0xC2) {
      info.h = b.readUInt16BE(i + 5); info.w = b.readUInt16BE(i + 7);
      info.sampling = [0, 1, 2].map(k => (b[i + 11 + 3 * k] >> 4) + 'x' + (b[i + 11 + 3 * k] & 15)).join(' ');
    }
    i += 2 + len;
  }
  return info;
}
// TIFF/EXIF reader: IFD0 tags, and the GPS IFD if linked.
function exifTags(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const r16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), r32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = off => {
    const out = {};
    for (let k = 0, n = r16(off); k < n; k++) {
      const p = off + 2 + k * 12, tag = r16(p), type = r16(p + 2), count = r32(p + 4);
      if (type === 3) out[tag] = r16(p + 8);
      else if (type === 4) out[tag] = r32(p + 8);
      else if (type === 2) out[tag] = t.toString('latin1', count > 4 ? r32(p + 8) : p + 8, (count > 4 ? r32(p + 8) : p + 8) + count - 1);
      else out[tag] = true;
    }
    return out;
  };
  const ifd0 = ifd(r32(4));
  return { ifd0, gps: ifd0[0x8825] ? ifd(ifd0[0x8825]) : null };
}
// File names in a ZIP, from its central directory.
function zipNames(b) {
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054B50) e--;
  if (e < 0) throw new Error('not a ZIP');
  const names = [];
  for (let k = 0, o = b.readUInt32LE(e + 16); k < b.readUInt16LE(e + 10); k++) {
    if (b.readUInt32LE(o) !== 0x02014B50) throw new Error('bad ZIP directory');
    const n = b.readUInt16LE(o + 28);
    names.push(b.toString('utf8', o + 46, o + 46 + n));
    o += 46 + n + b.readUInt16LE(o + 30) + b.readUInt16LE(o + 32);
  }
  return names;
}

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  await open();
  assert.equal(await page.textContent('h1'), 'WebP to JPG Converter (WebP to JPEG)');

  // ---------- Set up for WebP to JPG as served, and nothing moves as the script starts ----------
  const NOTE = 'WebP is usually smaller than JPG at the same quality, so each JPG may come out larger than its WebP; the list shows the difference.';
  const HINT = 'WebP files from websites, chats or sticker packs, as many as you like. Nothing is uploaded.';
  const START = ['jpeg', '90', '90%', '#ffffff', 'strip', 'false,false,false,false,true,true', NOTE, HINT];
  const load = await page.evaluate(async () => {
    const state = doc => {
      const q = s => doc.querySelector(s);
      return [q('#imc-format').value, q('#imc-quality').value, q('#imc-quality-out').textContent, q('#imc-bg').value, q('#imc-meta').value,
        ['#imc-quality-field', '#imc-resize-field', '#imc-bg-field', '#imc-meta-field', '#imc-sizes', '#imc-resize-val'].map(s => q(s).hidden).join(),
        q('#imc-note').textContent, q('#imc-drop .hint').textContent];
    };
    const live = state(document);
    const html = await (await fetch(location.href)).text();
    await Promise.all(['webp', 'avif'].map(f => TTImage.canEncode(f, { wasm: true })));
    await new Promise(r => setTimeout(r, 50));
    return { html, served: state(new DOMParser().parseFromString(html, 'text/html')), live, settled: state(document) };
  });
  assert.doesNotMatch(load.html, /\{%|\{\{|include\.|imc_[a-z]|animated_note/, 'Liquid or include notes in the page');
  assert.deepEqual(load.served, START);
  assert.deepEqual(load.live, START, 'the script changed the controls as it started');
  assert.deepEqual(load.settled, START, 'the encoder checks changed the controls');

  // ---------- The guide links to the hub, WebP to PNG and the compressor, all real tool pages ----------
  const links = await page.$$eval('.prose a', as => as.map(a => a.getAttribute('href')));
  for (const h of ['/image-converter/', '/webp-to-png/', '/compress-image/']) assert.ok(links.includes(h), `guide links to ${h}`);
  for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `guide link ${h} is not a tool page`);
  // The FAQ answers why saved pictures are WebP at all, and sends .avif downloads to their own page.
  assert.deepEqual(await page.$$eval('.faq summary', s => s.map(e => e.textContent.trim())), [
    'Why do pictures I save from websites come out as WebP?', 'What happens to a transparent WebP when it becomes a JPG?',
    'Which JPG quality should I choose for a WebP?', 'Can I convert several WebP files to JPG at once?']);
  assert.match((await page.textContent('.faq')).replace(/\s+/g, ' '), /the browser saves the file it was sent\. Chrome, Edge, Firefox and Safari have no setting to save it as JPG instead/);
  assert.deepEqual(await page.$$eval('.faq a', as => as.map(a => a.getAttribute('href'))), ['/avif-to-jpg/']);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', 'avif-to-jpg.html')));

  const rows = page.locator('.imc-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  // Change a setting and wait until the list has been converted again.
  const rerun = async action => {
    await page.evaluate(() => {
      window.__saw = false;
      const el = document.querySelector('#imc-summary');
      if (window.__mo) window.__mo.disconnect();
      window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
      window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    await action();
    await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  };
  const setInput = (sel, v) => rerun(() => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v));
  const pixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, [buf.toString('base64'), pts]);
  const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

  // ---------- Convert: a transparent WebP, a photo, an animation ----------
  await page.setInputFiles('#imc-file', ['alpha.webp', 'photo.webp', 'anim.webp'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '3 of 3 converted.', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 3 images to JPG.');
  assert.match(await rowText(0), /^alpha\.jpg WebP 64×48, 74 B → JPG 64×48, .*Transparent areas were filled with white\./);
  const photo90 = (await rowText(1)).match(/^photo\.jpg WebP 200×200, 9\.1 KB → JPG 200×200, ([\d.]+) KB \((\d+)% larger\)/);
  assert.ok(photo90, 'the JPG of a lossy WebP photo is reported as larger: ' + await rowText(1));
  assert.ok(+photo90[2] >= 20 && +photo90[2] <= 300, `photo grew ${photo90[2]}%`);
  assert.match(await rowText(2), /^anim\.jpg WebP 40×30, .*Animated image: only the first frame was converted\. A JPG cannot move: keep the WebP if you need the animation\./);

  let f = await download(0);
  assert.equal(f.name, 'alpha.jpg');
  let j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.exif, j.sampling], [64, 48, false, '2x2 1x1 1x1']);
  let px = await pixels(f.data, [[10, 40], [50, 40], [50, 10]]);
  near(px[0], [200, 30, 60, 255], 10, 'opaque red');
  near(px[1], [255, 255, 255, 255], 6, 'transparent -> white');
  near(px[2], [137, 177, 237, 255], 10, 'alpha 128 blue over white');
  px = await pixels((await download(2)).data, [[20, 15], [2, 2]]);
  near(px[0], [255, 0, 0, 255], 12, 'first frame (red)');
  near(px[1], [255, 0, 0, 255], 12, 'first frame (red) at the edge');

  // ---------- A dark background colour ----------
  await setInput('#imc-bg', '#000000');
  assert.match(await rowText(0), /Transparent areas were filled with black\./);
  px = await pixels((await download(0)).data, [[50, 40], [50, 10], [10, 40]]);
  near(px[0], [0, 0, 0, 255], 6, 'transparent -> black');
  near(px[1], [10, 50, 110, 255], 10, 'alpha 128 blue over black');
  near(px[2], [200, 30, 60, 255], 10, 'opaque red unchanged');

  // ---------- Lower quality, smaller JPG ----------
  await setInput('#imc-quality', '50');
  assert.equal(await page.textContent('#imc-quality-out'), '50%');
  const photo50 = (await rowText(1)).match(/→ JPG 200×200, ([\d.]+) KB/);
  assert.ok(photo50 && +photo50[1] < +photo90[1] * 0.8, `quality 50 should be much smaller: ${photo50 && photo50[1]} vs ${photo90[1]} KB`);

  // ---------- Everything in one ZIP ----------
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#imc-zip')]);
  assert.equal(zdl.suggestedFilename(), 'converted-images-jpg.zip');
  assert.deepEqual(zipNames(fs.readFileSync(await zdl.path())), ['alpha.jpg', 'photo.jpg', 'anim.jpg']);

  // ---------- EXIF in a WebP is found, wherever its chunk is, and its orientation applied ----------
  // (It used to be missed: the chunk length was read from the wrong place.)
  await page.click('#imc-clear');
  await page.selectOption('#imc-meta', 'keep');
  await page.setInputFiles('#imc-file', ['rotated.webp', 'late-exif.webp'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 30000 });
  assert.match(await rowText(0), /^rotated\.jpg WebP 80×120, 240 B → JPG 80×120, .*Rotated upright using the photo’s orientation tag\. EXIF kept, including any location\./);
  assert.match(await rowText(1), /^late-exif\.jpg WebP 40×30, .*Animated image: only the first frame was converted\..* EXIF kept, including any location\./);
  f = await download(0);
  j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.tags.ifd0[0x010F], j.tags.ifd0[0x0112], !!j.tags.gps], [80, 120, 'TestCam', 1, true], 'rotated.jpg: upright, EXIF kept with its location, orientation reset');
  px = await pixels(f.data, [[75, 60], [10, 60], [40, 2]]);
  near(px[0], [220, 30, 30, 255], 14, 'band on the right');
  near(px[1], [235, 235, 235, 255], 8, 'background');
  near(px[2], [235, 235, 235, 255], 8, 'top is not the band');
  f = await download(1);
  j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.tags.ifd0[0x010F], !!j.tags.gps], [40, 30, 'LateCam', true], 'late-exif.jpg: EXIF after the animation chunks is kept');
  near((await pixels(f.data, [[20, 15]]))[0], [30, 140, 90, 255], 10, 'late-exif.jpg first frame');
  await rerun(() => page.selectOption('#imc-meta', 'nogps'));
  for (const [i, make] of [[0, 'TestCam'], [1, 'LateCam']]) {
    assert.match(await rowText(i), /EXIF kept without location\./);
    j = jpegInfo((await download(i)).data);
    assert.deepEqual([j.tags.ifd0[0x010F], j.tags.gps], [make, null], `${make}: camera kept, GPS removed`);
  }
};
