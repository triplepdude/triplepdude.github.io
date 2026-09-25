const fs = require('fs');

// Independent PNG reader: checks the signature and every chunk CRC (ISO/IEC 15948).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function readPng(buf, assert) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const body = buf.subarray(off + 4, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(body), `CRC of ${type}`);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  assert.equal(chunks[0].type, 'IHDR');
  assert.equal(chunks[chunks.length - 1].type, 'IEND');
  assert.ok(chunks.some(c => c.type === 'IDAT'));
  return { width: chunks[0].data.readUInt32BE(0), height: chunks[0].data.readUInt32BE(4) };
}

module.exports = async ({ page, open, assert }) => {
  await open();
  const text = s => page.locator(s).textContent();
  const waitText = (sel, re, timeout = 6000) => page.waitForFunction(
    ([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout });

  assert.equal(await page.isEnabled('#wct-start'), true);
  assert.equal(await page.isDisabled('#wct-stop'), true);
  assert.equal(await page.isDisabled('#wct-snap'), true);
  assert.equal(await page.isVisible('#wct-video'), false);
  assert.equal(await page.isVisible('#wct-placeholder'), true);
  assert.equal(await page.isVisible('#wct-snap-wrap'), false);

  await page.evaluate(() => {
    const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
    window.__gum = { calls: [], streams: [] };
    md.getUserMedia = async c => {
      window.__gum.calls.push(JSON.parse(JSON.stringify(c)));
      const s = await orig(c);
      window.__gum.streams.push(s);
      return s;
    };
  });
  const lastSettings = () => page.evaluate(() => {
    const t = window.__gum.streams[window.__gum.streams.length - 1].getVideoTracks()[0];
    return { ...t.getSettings(), label: t.label, caps: t.getCapabilities ? t.getCapabilities() : null };
  });

  // Default mode of Chromium's fake camera. Started from the keyboard: Start disables
  // itself, so focus moves on to Stop instead of falling back to <body> (WCAG 2.4.3).
  await page.focus('#wct-start');
  await page.keyboard.press('Enter');
  await waitText('#wct-resolution', /\d+ × \d+/);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'wct-stop');
  let s = await lastSettings();
  assert.equal(await text('#wct-resolution'), `${s.width} × ${s.height}`);
  assert.equal(`${s.width}x${s.height}`, '640x480');
  assert.equal(await text('#wct-aspect'), '4:3 (1.33)');
  assert.equal(await text('#wct-mp'), '0.31 MP');
  assert.equal(await text('#wct-rate'), `${Math.round(s.frameRate)} fps`);
  assert.equal(await page.isVisible('#wct-video'), true);
  assert.equal(await page.$eval('#wct-video', v => v.videoWidth), 640);
  assert.ok((await page.locator('#wct-device option').allTextContents()).includes(s.label));
  assert.match(await text('#wct-status'), /camera is working/);
  assert.equal(await page.isDisabled('#wct-start'), true);

  // Measured FPS is close to the fake camera's rate; brightness is reported.
  await page.waitForTimeout(2500);
  const fps = parseFloat(await text('#wct-measured'));
  assert.ok(fps > s.frameRate * 0.5 && fps < s.frameRate * 1.5, `measured ${fps} vs ${s.frameRate}`);
  assert.match(await text('#wct-bright'), /^\d+%$/);

  // Highest available: the camera's maximum from getCapabilities().
  await page.selectOption('#wct-res', 'max');
  await page.waitForFunction(() => window.__gum.streams.length === 2);
  await waitText('#wct-details', /Delivered resolution3840 × 2160/);
  s = await lastSettings();
  assert.equal(await text('#wct-resolution'), `${s.caps.width.max} × ${s.caps.height.max}`);
  assert.match(await text('#wct-details'), new RegExp(`Maximum resolution${s.caps.width.max} × ${s.caps.height.max}`));
  assert.equal(await text('#wct-aspect'), '16:9 (1.78)');
  assert.equal(await text('#wct-mp'), (3840 * 2160 / 1e6).toFixed(2) + ' MP');
  const fr = s.caps.frameRate;
  assert.match(await text('#wct-details'), new RegExp(`Frame rate range${+(fr.min || 0).toFixed(2)} to ${+fr.max.toFixed(2)} fps`));
  // The previous stream was released before reopening.
  assert.equal(await page.evaluate(() => window.__gum.streams[0].getTracks().every(t => t.readyState === 'ended')), true);

  // 1280 x 720 is requested as an ideal constraint and delivered.
  await page.selectOption('#wct-res', '1280x720');
  await page.waitForFunction(() => window.__gum.streams.length === 3);
  assert.deepEqual(await page.evaluate(() => window.__gum.calls[2].video.width), { ideal: 1280 });
  await waitText('#wct-resolution', /^1280 × 720$/);
  assert.equal(await text('#wct-aspect'), '16:9 (1.78)');
  assert.equal(await text('#wct-mp'), '0.92 MP');
  await waitText('#wct-status', /requested 1280 × 720/);
  await page.waitForFunction(() => document.getElementById('wct-video').videoWidth === 1280);

  // Mirror toggle flips the preview.
  const transform = () => page.$eval('#wct-video', v => getComputedStyle(v).transform);
  assert.match(await transform(), /^matrix\(-1, 0, 0, 1, 0, 0\)$/);
  await page.uncheck('#wct-mirror');
  assert.equal(await transform(), 'none');
  await page.check('#wct-mirror');

  // Snapshot at full resolution, downloaded as a valid PNG.
  await page.click('#wct-snap');
  assert.equal(await page.isVisible('#wct-snap-wrap'), true);
  assert.match(await text('#wct-snap-info'), /^1280 × 720 PNG, mirrored/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#wct-download')]);
  assert.match(dl.suggestedFilename(), /^webcam-snapshot-\d{8}-\d{6}\.png$/);
  const png = readPng(fs.readFileSync(await dl.path()), assert);
  assert.deepEqual(png, { width: 1280, height: 720 });

  // Stop releases the camera, and keyboard focus goes back to Start.
  await page.focus('#wct-stop');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('wct-start').disabled);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'wct-start');
  assert.equal(await page.evaluate(() => window.__gum.streams.every(st => st.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.$eval('#wct-video', v => v.srcObject), null);
  assert.equal(await page.isVisible('#wct-placeholder'), true);
  assert.equal(await page.isEnabled('#wct-start'), true);
  assert.equal(await page.isDisabled('#wct-snap'), true);
  assert.match(await text('#wct-status'), /released/);

  // Regression: picking a resolution while the browser was still opening the camera was
  // ignored, and the page then claimed the camera could not deliver the new size.
  await page.evaluate(() => {
    const md = navigator.mediaDevices, gum = md.getUserMedia;
    md.getUserMedia = c => new Promise(r => setTimeout(r, 600)).then(() => gum(c));
  });
  await page.selectOption('#wct-res', '');
  const n0 = await page.evaluate(() => window.__gum.calls.length);
  await page.click('#wct-start');
  await page.selectOption('#wct-res', '1920x1080');
  await page.waitForFunction(n => window.__gum.streams.length === n + 2, n0, { timeout: 8000 });
  await waitText('#wct-resolution', /^1920 × 1080$/);
  await waitText('#wct-status', /working at the requested 1920 × 1080/);
  assert.deepEqual(await page.evaluate(n => [window.__gum.calls[n].video.width, window.__gum.calls[n + 1].video.width], n0), [undefined, { ideal: 1920 }]);
  assert.equal(await page.evaluate(n => window.__gum.streams[n].getTracks().every(t => t.readyState === 'ended'), n0), true);

  // Leaving the page releases the camera and resets the controls (back/forward cache).
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.evaluate(() => window.__gum.streams.every(st => st.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.isEnabled('#wct-start'), true);
  assert.equal(await page.isDisabled('#wct-stop'), true);
  assert.equal(await page.isVisible('#wct-video'), false);
  await page.selectOption('#wct-res', '');

  // Known picture: left half pure red, right half pure blue, 320 x 180.
  const useCanvas = colors => page.evaluate(cols => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d');
    const paint = () => { g.fillStyle = cols[0]; g.fillRect(0, 0, 160, 180); g.fillStyle = cols[1]; g.fillRect(160, 0, 160, 180); };
    paint();
    clearInterval(window.__paint);
    window.__paint = setInterval(paint, 40);
    navigator.mediaDevices.getUserMedia = async () => c.captureStream(25);
  }, colors);
  const leftPixel = () => page.$eval('#wct-canvas', c => Array.from(c.getContext('2d').getImageData(4, 90, 1, 1).data.slice(0, 3)));
  await useCanvas(['#ff0000', '#0000ff']);
  await page.click('#wct-start');
  await page.waitForFunction(() => document.getElementById('wct-video').videoWidth === 320);
  await page.waitForTimeout(700);
  await page.click('#wct-snap');
  let px = await leftPixel();
  assert.ok(px[2] > 200 && px[0] < 60, `mirrored snapshot should start blue, got ${px}`);
  await page.uncheck('#wct-mirror');
  await page.click('#wct-snap');
  px = await leftPixel();
  assert.ok(px[0] > 200 && px[2] < 60, `unmirrored snapshot should start red, got ${px}`);
  // Mean Rec. 709 luma of half red, half blue = (0.2126 + 0.0722) / 2 = 14%.
  await waitText('#wct-bright', /%/);
  const bright = parseInt(await text('#wct-bright'), 10);
  assert.ok(Math.abs(bright - 14) <= 3, `brightness ${bright}%`);
  await page.click('#wct-stop');

  // Aspect ratios of sizes that do not reduce neatly (computed by hand):
  // 1280 x 800 = 8:5, sold as 16:10; 1366 x 768 = 683:384 = 1.7786, within 1% of 16:9.
  for (const [w, h, want] of [[1280, 800, '16:10 (1.60)'], [1366, 768, '≈16:9 (1.78)'], [480, 640, '3:4 (0.75)']]) {
    await page.evaluate(([cw, ch]) => {
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const g = c.getContext('2d');
      clearInterval(window.__paint);
      window.__paint = setInterval(() => { g.fillStyle = '#808080'; g.fillRect(0, 0, cw, ch); }, 40);
      navigator.mediaDevices.getUserMedia = async () => c.captureStream(25);
    }, [w, h]);
    await page.click('#wct-start');
    await waitText('#wct-resolution', new RegExp(`^${w} × ${h}$`));
    assert.equal(await text('#wct-aspect'), want);
    assert.equal(await text('#wct-mp'), (w * h / 1e6).toFixed(2) + ' MP');
    await page.click('#wct-stop');
  }

  // A black picture triggers the covered-lens warning.
  await useCanvas(['#000000', '#000000']);
  await page.click('#wct-start');
  await waitText('#wct-error', /almost completely black/, 7000);
  assert.equal(await text('#wct-bright'), '0%');
  await page.click('#wct-stop');
  await page.evaluate(() => clearInterval(window.__paint));

  // Clear messages for each getUserMedia failure.
  const cases = [
    ['NotAllowedError', 'Permission denied', /^Permission denied: camera/],
    ['NotAllowedError', 'Permission denied by system', /operating system is blocking camera/],
    ['NotFoundError', 'Requested device not found', /^No camera found/],
    ['NotReadableError', 'Could not start video source', /camera is in use by another app/],
    ['OverconstrainedError', '', /no longer available/],
  ];
  for (const [name, message, re] of cases) {
    await page.evaluate(([n, m]) => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException(m, n)); }, [name, message]);
    await page.click('#wct-start');
    await waitText('#wct-error', re);
    assert.equal(await page.isDisabled('#wct-stop'), true);
    assert.equal(await page.isEnabled('#wct-start'), true);
  }

  // Regression: when the browser restores an unticked Mirror box on reload, the preview
  // must not stay mirrored.
  await page.addInitScript(() => {
    new MutationObserver((_, obs) => {
      const m = document.getElementById('wct-mirror');
      if (m) { m.checked = false; obs.disconnect(); }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  assert.equal(await page.isChecked('#wct-mirror'), false);
  assert.equal(await page.$eval('#wct-video', v => v.classList.contains('is-mirrored')), false);

  // Insecure context: explained on click and on load, and Start is disabled.
  await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }));
  await page.click('#wct-start');
  assert.match(await text('#wct-error'), /secure connection/);
  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }));
  await page.reload();
  assert.match(await text('#wct-error'), /secure connection/);
  assert.equal(await page.isDisabled('#wct-start'), true);
};
