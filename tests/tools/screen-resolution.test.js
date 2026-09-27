const fs = require('fs');

// Expected values are worked out independently of the page:
// - physical pixels: 1707 x 960 CSS px at DPR 1.5 is a 2560 x 1440 panel;
//   412 x 915 CSS px at DPR 2.625 is a 1080 x 2400 phone (e.g. Pixel 7).
// - PPI = hypot(w, h) / diagonal; pitch = 25.4 / PPI mm; blend distance is where
//   one pixel subtends 1 arcminute: 1 / (PPI * tan(1/60 deg)) inches.
//   python3: 1920x1080 @ 24in -> 91.79 PPI, 0.2767 mm, 20.92 x 11.77 in
//   (53.1 x 29.9 cm), 95 cm (37.5 in); 2560x1440 @ 27in -> 108.79 PPI, 0.2335 mm.
module.exports = async ({ page, open, assert }) => {
  const text = s => page.locator(s).textContent();
  // Interval polling: Playwright's default polls with requestAnimationFrame,
  // which would share the fake display clock installed further down.
  const waitText = (sel, re, timeout = 8000) => page.waitForFunction(
    ([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout, polling: 50 });
  const row = name => page.evaluate(n => {
    const tr = [...document.querySelectorAll('#scr-rows tr')].find(r => r.querySelector('th').firstChild.nodeValue === n);
    return tr ? tr.querySelector('td').textContent : null;
  }, name);

  await open();
  // Plain 1280 x 900 window at DPR 1: physical = CSS pixels.
  assert.equal(await text('#scr-phys'), '1280 × 900');
  assert.match(await text('#scr-sub'), /same as CSS pixels/);
  assert.equal(await text('#scr-css'), '1280 × 900');
  assert.equal(await text('#scr-vp'), '1280 × 900');
  assert.equal(await text('#scr-dpr'), '1');
  // 1280:900 reduces to 64:45, which is no common ratio, so it shows as a decimal.
  assert.equal(await text('#scr-aspect'), '1.42:1');
  assert.equal(await text('#scr-depth'), '24-bit');
  assert.equal(await text('#scr-hdr'), 'No');
  assert.equal(await text('#scr-gamut'), 'sRGB');
  assert.equal(await row('Colour depth'), '24-bit (8 bits per channel)');
  assert.equal(await row('Orientation'), 'Landscape (primary), 0°');
  assert.equal(await row('Device pixel ratio'), '1 (100% scaling)');
  assert.equal(await text('#scr-zoom'), '');
  // The empty zoom note stays rendered for screen readers.
  assert.equal(await page.$eval('#scr-zoom', e => getComputedStyle(e).display !== 'none'), true);
  // The window fills the screen in the diagram.
  assert.equal(await page.$eval('#scr-win', e => e.style.width), '100%');
  assert.equal(await text('#scr-vp-tag'), 'Viewport 1280 × 900');
  assert.equal(await text('#scr-caption'), 'Your browser window on the 1280 × 900 screen, to scale');

  // Real refresh rate measurement in headless Chromium (about 60 Hz).
  assert.equal(await text('#scr-hz'), 'Measuring…');
  await waitText('#scr-hz', /Hz$/);
  assert.match(await text('#scr-hz'), /^\d+(\.\d)? Hz$/);
  assert.match(await text('#scr-hz-detail'), /^Measured [\d.]+ Hz: [\d.]+ ms per frame over \d+ frames/);

  // Windows at 150% on a 1440p panel: screen reports 1707 x 960 CSS pixels.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1.5, mobile: false, screenWidth: 1707, screenHeight: 960 });
  await waitText('#scr-phys', /^2560 × 1440$/);
  assert.equal(await text('#scr-css'), '1707 × 960');
  assert.equal(await text('#scr-dpr'), '1.5');
  assert.equal(await text('#scr-aspect'), '16:9');
  assert.match(await text('#scr-sub'), /shown as 1707 × 960 CSS pixels at 150% scaling/);
  assert.equal(await row('Aspect ratio'), '16:9 (1.78:1)');

  // Phone: 412 x 915 CSS px at DPR 2.625 is a 1080 x 2400 panel (20:9).
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, screenWidth: 412, screenHeight: 915 });
  await waitText('#scr-phys', /^1080 × 2400$/);
  assert.equal(await text('#scr-aspect'), '20:9');
  assert.equal(await text('#scr-vp'), '412 × 915');

  // Chrome at 125% zoom on a 1920 x 1080 screen at 100%: devicePixelRatio is
  // 1.25, screen.width stays 1920, the window is 1920 wide, the viewport 1536.
  await page.evaluate(() => {
    Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(window, 'outerHeight', { configurable: true, get: () => 1040 });
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 736, deviceScaleFactor: 1.25, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  await waitText('#scr-zoom', /zoom looks like 125%/);
  assert.equal(await text('#scr-phys'), '1920 × 1080', 'physical size corrected for zoom');
  assert.match(await text('#scr-zoom'), /corrected for the zoom/);
  assert.equal(await row('Browser zoom (estimated)'), '125%');
  assert.equal(await row('Device pixel ratio'), '1.25 (100% display scaling × 125% zoom)');
  assert.equal(await text('#scr-vp'), '1536 × 736');

  // Wide gamut and HDR are read from media queries.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'color-gamut', value: 'p3' }] });
  await page.evaluate(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = q => (q.replace(/\s/g, '') === '(dynamic-range:high)'
      ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : orig(q));
  });
  await waitText('#scr-hdr', /^Yes$/);
  assert.equal(await text('#scr-gamut'), 'Display P3');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 900 });

  // ---- Refresh rate with a fake 144 Hz display (every 50th frame is dropped). ----
  await page.addInitScript(() => {
    let t = 1000, k = 0;
    window.__step = 1000 / 144;
    window.requestAnimationFrame = cb => setTimeout(() => { k++; t += k % 50 === 0 ? 2 * window.__step : window.__step; cb(t); }, 0);
    window.cancelAnimationFrame = id => clearTimeout(id);
  });
  await open();
  await waitText('#scr-hz', /Hz$/);
  assert.equal(await text('#scr-hz'), '144 Hz');
  assert.match(await text('#scr-hz-detail'), /^Measured 144\.00 Hz: 6\.94 ms per frame over \d+ frames, ignoring [1-9]\d* slow frames\./);
  assert.equal(await row('Refresh rate'), 'About 144 Hz (measured 144.00 Hz)');
  await page.waitForFunction(() => document.getElementById('scr-status').textContent === 'Refresh rate about 144 hertz.', null, { polling: 50 });

  // A rate that is not a standard one is shown as measured; focus stays on the button.
  await page.evaluate(() => { window.__step = 1000 / 57.3; });
  await page.click('#scr-hz-again');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'scr-hz-again');
  await waitText('#scr-hz', /Hz$/);
  assert.equal(await text('#scr-hz'), '57.3 Hz');
  assert.match(await text('#scr-hz-detail'), /^Measured 57\.30 Hz: 17\.45 ms per frame/);

  // ---- PPI calculator ----
  assert.equal(await page.inputValue('#scr-pw'), '1280');
  assert.equal(await page.inputValue('#scr-ph'), '900');
  assert.equal(await text('#scr-ppi'), '–');
  await page.fill('#scr-pw', '1920');
  await page.fill('#scr-ph', '1080');
  await page.fill('#scr-diag', '24');
  assert.equal(await text('#scr-ppi'), '91.79 PPI');
  assert.equal(await text('#scr-pitch'), '0.2767 mm');
  assert.equal(await text('#scr-size-in'), '20.9 × 11.8 in');
  assert.equal(await text('#scr-size-cm'), '53.1 × 29.9 cm');
  assert.equal(await text('#scr-blend'), '95 cm (37.5 in)');
  // 27 inches entered in centimetres.
  await page.fill('#scr-pw', '2560');
  await page.fill('#scr-ph', '1440');
  await page.selectOption('#scr-unit', 'cm');
  await page.fill('#scr-diag', '68.58');
  assert.equal(await text('#scr-ppi'), '108.79 PPI');
  assert.equal(await text('#scr-pitch'), '0.2335 mm');
  // Resizing must not overwrite a resolution the user typed.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1000, screenHeight: 800 });
  await waitText('#scr-vp', /^1000 × 800$/);
  assert.equal(await page.inputValue('#scr-pw'), '2560');
  // Bad input gives a polite error, never a crash.
  await page.fill('#scr-diag', '0');
  assert.match(await text('#scr-ppi-msg'), /greater than 0 and up to 2540 cm/);
  assert.equal(await text('#scr-ppi'), '–');
  await page.fill('#scr-diag', '');
  assert.equal(await text('#scr-ppi-msg'), '');
  await page.fill('#scr-diag', '27');
  await page.fill('#scr-pw', '12.5');
  assert.match(await text('#scr-ppi-msg'), /whole numbers/);
  assert.equal(await page.getAttribute('#scr-ppi-msg', 'role'), null, 'typing errors are not assertive');
  await page.click('#scr-use');
  assert.equal(await page.inputValue('#scr-pw'), '1000');
  assert.equal(await page.inputValue('#scr-ph'), '800');
  assert.equal(await text('#scr-ppi-msg'), '');
  assert.equal(await text('#scr-ppi'), (Math.hypot(1000, 800) / (27 / 2.54)).toFixed(2) + ' PPI');

  // ---- Copy and download the summary ----
  await page.click('#scr-copy');
  await waitText('#scr-copy', /Copied!/, 3000);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^Screen resolution \(physical pixels\): 1000 × 800\n/);
  assert.match(clip, /\nViewport: 1000 × 800\n/);
  assert.match(clip, /\nRefresh rate: 57\.3 Hz \(measured 57\.30 Hz\)\n/);
  assert.match(clip, /\nColour depth: 24-bit \(8 bits per channel\)\n/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#scr-download')]);
  assert.equal(dl.suggestedFilename(), 'screen-resolution.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), clip);
};
