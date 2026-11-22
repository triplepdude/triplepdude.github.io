// AVIF to JPG: the image converter set up for this pair. Fixtures:
//   gradient.avif  copy of image-converter's, 200x150
//   alpha.avif     image-converter's alpha.png saved by Pillow as AVIF: 64x48, left
//                  half (200,30,60), right half transparent, top-right quarter
//                  (20,100,220) at alpha 128
//   srgb.avif      32x32 of (200,100,100) made with ffmpeg (libaom), tagged sRGB
//   p3.avif        the same values tagged as Display P3 (nclx primaries 12), so the
//                  browser must convert them: redder and less green in sRGB
//   anim.avif      40x30 image sequence (avis), frame 1 red, frame 2 blue
//   cut.avif       gradient.avif cut off a third of the way into its image data,
//                  as an interrupted download leaves it
//   damaged.avif   gradient.avif at full length, its AV1 data overwritten with a
//                  byte pattern: Chrome draws it as a blank, transparent picture
//   broken.avif    gradient.avif's ftyp box followed by zeros: no readable boxes
//   pq.avif        128x16 HDR AVIF made with ffmpeg (libaom, 10-bit 4:4:4, BT.2020,
//                  PQ transfer): eight grey steps at PQ code values 0.3 to 1.0, 16 px each
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
    if (m >= 0xC0 && m <= 0xC2) { info.h = b.readUInt16BE(i + 5); info.w = b.readUInt16BE(i + 7); }
    i += 2 + len;
  }
  return info;
}

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await open();
  assert.equal(await page.textContent('h1'), 'AVIF to JPG Converter: Open AVIF Anywhere');

  // ---------- Set up for AVIF to JPG as served, and nothing moves as the script starts ----------
  const NOTE = 'Wide-colour and HDR AVIFs become standard sRGB pictures, the range a JPG holds.';
  const HINT = 'AVIF images, as many as you like. Your browser decodes them, and nothing is uploaded.';
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

  // ---------- The guide links to the hub and to HEIC to JPG, all real tool pages ----------
  const links = await page.$$eval('.prose a', as => as.map(a => a.getAttribute('href')));
  for (const h of ['/image-converter/', '/heic-to-jpg/']) assert.ok(links.includes(h), `guide links to ${h}`);
  for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `guide link ${h} is not a tool page`);

  const rows = page.locator('.imc-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  const pixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, [buf.toString('base64'), pts]);
  const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

  // ---------- Convert five AVIFs, decoded by the browser itself ----------
  await page.setInputFiles('#imc-file', ['gradient.avif', 'alpha.avif', 'srgb.avif', 'p3.avif', 'anim.avif'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '5 of 5 converted.', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 5 images to JPG.');
  assert.deepEqual(requests.filter(u => /libheif|UTIF|pako|avif_enc/.test(u)), [], 'no decoder or encoder is downloaded for AVIF to JPG');
  assert.match(await rowText(0), /^gradient\.jpg AVIF 200×150, 1\.2 KB → JPG 200×150, [\d.]+ KB \(\d+% larger\)/);
  assert.match(await rowText(1), /^alpha\.jpg AVIF 64×48, 520 B → JPG 64×48, .*Transparent areas were filled with white\./);
  assert.match(await rowText(4), /^anim\.jpg AVIF 40×30, .*Animated image: only the first frame was converted\. JPG has no animation, so keep the AVIF if the movement matters\./);
  assert.doesNotMatch(await rowText(0), /Animated|filled with/);

  // gradient.jpg: the same picture as the browser shows the AVIF.
  let f = await download(0);
  assert.equal(f.name, 'gradient.jpg');
  let j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.exif], [200, 150, false]);
  const pts = [[5, 5], [100, 75], [195, 145], [195, 5], [5, 145]];
  const want = await pixels(fs.readFileSync(fx('gradient.avif')), pts);
  const got = await pixels(f.data, pts);
  pts.forEach((p, i) => near(got[i], want[i], 10, `gradient at ${p}`));

  // alpha.jpg: transparent areas white, half-transparent blue blended with white.
  let px = await pixels((await download(1)).data, [[10, 40], [50, 40], [50, 10]]);
  near(px[0], [200, 30, 60, 255], 10, 'opaque red');
  near(px[1], [255, 255, 255, 255], 6, 'transparent -> white');
  near(px[2], [137, 177, 237, 255], 12, 'alpha 128 blue over white');

  // Display P3 is converted to sRGB: the same stored values come out redder and less green.
  const s = (await pixels((await download(2)).data, [[16, 16]]))[0];
  const p3 = (await pixels((await download(3)).data, [[16, 16]]))[0];
  assert.ok(p3[0] - s[0] >= 8 && s[1] - p3[1] >= 3, `P3 not converted to sRGB: sRGB-tagged ${s}, P3-tagged ${p3}`);

  // anim.jpg: the red first frame.
  px = await pixels((await download(4)).data, [[20, 15]]);
  near(px[0], [255, 0, 0, 255], 14, 'first frame (red)');

  // ---------- Another background colour ----------
  await page.evaluate(() => {
    window.__saw = false;
    const el = document.querySelector('#imc-summary');
    window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
    window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.$eval('#imc-bg', el => { el.value = '#000000'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  assert.match(await rowText(1), /Transparent areas were filled with black\./);
  px = await pixels((await download(1)).data, [[50, 40], [10, 40]]);
  near(px[0], [0, 0, 0, 255], 6, 'transparent -> black');
  near(px[1], [200, 30, 60, 255], 10, 'opaque red unchanged');

  // ---------- Cut-off and damaged AVIFs are named as such ----------
  // Chrome draws them as blank pictures without an error (which became a white
  // JPG "filled with white"), and an AVIF it cannot parse was blamed on the browser.
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', ['cut.avif', 'damaged.avif', 'broken.avif', 'srgb.avif'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '1 of 4 converted, 3 failed.', null, { timeout: 30000 });
  assert.equal(await rowText(0), 'cut.avif 590 B The AVIF file is incomplete: it ends before all of its image data. Download or copy it again. ×');
  const BAD = 'The AVIF file could not be decoded. It may be damaged or use a feature this browser does not support.';
  assert.equal(await rowText(1), `damaged.avif 1.2 KB ${BAD} ×`);
  assert.equal(await rowText(2), `broken.avif 1.2 KB ${BAD} ×`);
  assert.match(await rowText(3), /^srgb\.jpg AVIF 32×32, 318 B → JPG 32×32, /);
  assert.doesNotMatch(await rowText(3), /filled with/, 'an AVIF without transparency was reported as transparent');
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 1 image to JPG. 3 could not be converted.');
  // Only failures: the announcement does not claim "Converted 0 images".
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', ['cut.avif', 'broken.avif'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '0 of 2 converted, 2 failed.', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent !== 'All images removed.');
  assert.equal(await page.textContent('#imc-status'), 'None of the 2 images could be converted to JPG.');
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', [fx('cut.avif')]);
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'The image could not be converted to JPG.', null, { timeout: 30000 });
  assert.equal(await page.isDisabled('#imc-zip'), true);

  // ---------- An HDR AVIF gets a note; Chromium tone-maps it, so highlights are not clipped ----------
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', ['pq.avif', 'srgb.avif'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 30000 });
  assert.match(await rowText(0), /^pq\.jpg AVIF 128×16, .* This is an HDR image\. The browser mapped it into standard range, so highlights look less brilliant than on an HDR screen\. /);
  assert.doesNotMatch(await rowText(1), /HDR/, 'no HDR note for a standard-range AVIF');
  const steps = (await pixels((await download(0)).data, [0, 1, 2, 3, 4].map(k => [8 + 16 * k, 8]))).map(p => p[1]);
  assert.ok(steps.every((v, k) => !k || v > steps[k - 1] + 10) && steps[4] < 245, `PQ 0.3 to 0.7 (about 10 to 600 nits) should stay apart, not clip at white: ${steps}`);
};
