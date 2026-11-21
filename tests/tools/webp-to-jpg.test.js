// WebP to JPG: the image converter set up for this pair. Fixtures:
//   alpha.webp  lossless 64x48 (copy of image-converter's): left half (200,30,60),
//               right half transparent, top-right quarter (20,100,220) at alpha 128
//   anim.webp   40x30 animation, frame 1 red, frame 2 blue
//   photo.webp  scikit-image's "astronaut" sample (NASA, public domain) at
//               200x200, saved by Pillow as lossy WebP at quality 80
const fs = require('fs');
const path = require('path');

// JPEG reader: size and chroma sampling from the frame header, EXIF from APP1.
function jpegInfo(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('not a JPEG');
  const info = { exif: false };
  for (let i = 2; i < b.length;) {
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m === 0xDA) break;
    if (m === 0xE1 && b.toString('latin1', i + 4, i + 8) === 'Exif') info.exif = true;
    if (m >= 0xC0 && m <= 0xC2) {
      info.h = b.readUInt16BE(i + 5); info.w = b.readUInt16BE(i + 7);
      info.sampling = [0, 1, 2].map(k => (b[i + 11 + 3 * k] >> 4) + 'x' + (b[i + 11 + 3 * k] & 15)).join(' ');
    }
    i += 2 + len;
  }
  return info;
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
};
