const fs = require('fs');
const path = require('path');

// Independent JPEG reader (ITU T.81): frame size from SOFn and the first quantisation value
// of table 0 (the DC step of the luminance table).
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const info = { dqt: {} };
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
const kb = n => (n < 1e5 ? (n / 1000).toFixed(1) : (n / 1000).toFixed(0)) + ' KB';

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  const F = n => path.join(fixtures, n);
  const orig = fs.readFileSync(F('photo.jpg'));
  const text = s => page.textContent(s);
  const settle = async () => {
    await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('#cmpi-result').dataset.state), null, { timeout: 30000 });
    return page.getAttribute('#cmpi-result', 'data-state');
  };
  async function download() {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cmpi-download')]);
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

  assert.equal(await page.isVisible('#cmpi-result'), false);
  assert.equal(await page.isVisible('#cmpi-target'), true);
  assert.equal(await page.isVisible('#cmpi-quality'), false);

  // ---------- Default: JPG under 100 KB ----------
  await page.setInputFiles('#cmpi-file', F('photo.jpg'));
  assert.equal(await settle(), 'done');
  let d = await download();
  assert.equal(d.name, 'photo-compressed.jpg');
  assert.ok(d.buf.length <= 100000, `${d.buf.length} <= 100000`);
  assert.ok(d.buf.length > 80000, `binary search gets close to the limit: ${d.buf.length}`);
  let j = jpegInfo(d.buf);
  assert.deepEqual([j.width, j.height], [1000, 700]);
  let q = parseInt(await text('#cmpi-q'), 10);
  assert.equal(j.dqt[0], ijgDc(q), `quantiser matches ${q}% quality`);
  assert.equal(await text('#cmpi-orig'), kb(orig.length));
  assert.equal(await text('#cmpi-size'), kb(d.buf.length));
  assert.equal(await text('#cmpi-saved'), Math.round((1 - d.buf.length / orig.length) * 100) + '%');
  assert.equal(await text('#cmpi-dims'), '1000 × 700');
  assert.ok((await text('#cmpi-bytes')).includes(`${d.buf.length.toLocaleString('en-US')} bytes (limit 100,000 bytes)`));

  // ---------- 50 KB preset: the result is the highest quality that fits ----------
  await page.click('.cmpi-presets [data-kb="50"]');
  assert.equal(await page.getAttribute('.cmpi-presets [data-kb="50"]', 'aria-pressed'), 'true');
  assert.equal(await settle(), 'done');
  d = await download();
  assert.ok(d.buf.length <= 50000 && d.buf.length > 40000, `50 KB target gave ${d.buf.length} bytes`);
  j = jpegInfo(d.buf);
  assert.deepEqual([j.width, j.height], [1000, 700]);
  q = parseInt(await text('#cmpi-q'), 10);
  assert.ok(q >= 30 && q < 95, `quality ${q}`);
  assert.equal(j.dqt[0], ijgDc(q));
  // Independently re-encode the original one quality step higher: it must not fit.
  const nextSize = await page.evaluate(async ([b64, qq]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0);
    return (await new Promise(r => c.toBlob(r, 'image/jpeg', qq / 100))).size;
  }, [orig.toString('base64'), q + 1]);
  assert.ok(nextSize > 50000, `quality ${q + 1} would be ${nextSize} bytes`);

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
  await settle();
  await setQuality(90);
  assert.equal(await settle(), 'done');
  assert.equal(await text('#cmpi-quality-out'), '90%');
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
  await page.selectOption('#cmpi-format', 'image/webp');
  assert.equal(await settle(), 'done');
  d = await download();
  assert.equal(d.name, 'photo-compressed.webp');
  assert.equal(d.buf.toString('latin1', 0, 4) + d.buf.toString('latin1', 8, 12), 'RIFFWEBP');
  let img = await decode(d.buf);
  assert.deepEqual([img.w, img.h], [640, 448]);
  await page.selectOption('#cmpi-resize', '0');
  await settle();

  // ---------- Transparent PNG ----------
  await page.selectOption('#cmpi-format', 'image/jpeg');
  await settle();
  await page.check('input[name="cmpi-mode"][value="target"]');
  await settle();
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

  await page.selectOption('#cmpi-format', 'image/webp');
  assert.equal(await settle(), 'done');
  assert.doesNotMatch(await text('#cmpi-note'), /white/);
  d = await download();
  img = await decode(d.buf, [[2, 2], [150, 100]]);
  assert.equal(img.px[0][3], 0, 'WebP keeps the transparent corner');
  assert.equal(img.px[1][3], 255);

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
  assert.match(await text('#cmpi-error'), /could not be opened as an image/);
  assert.equal(await page.isDisabled('#cmpi-download'), true);
};
