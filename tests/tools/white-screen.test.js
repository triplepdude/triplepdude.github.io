// White screen. Colours are checked against exact sRGB values: presets are the
// CSS colour codes, colour temperatures come from tests/fixtures/white-screen/
// colour-temperature.py (Planck's law integrated against the CIE 1931
// observer below 4000 K, the CIE daylight series from 4000 K), and brightness
// works in linear light, so 50% of white is 188 (#BCBCBC), as the guide says.
// The Fullscreen and Wake Lock APIs are stubbed: headless Chromium has no real
// full screen. ?nofs removes the Fullscreen API, as on an iPhone.
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const temps = JSON.parse(fs.readFileSync(path.join(fixtures, 'colour-temperature.json'), 'utf8'));
  await page.addInitScript(() => {
    window.__fs = [];
    window.__wake = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request(type) {
        window.__wake.push('request:' + type);
        const l = new EventTarget();
        l.release = () => { window.__wake.push('release'); return Promise.resolve(); };
        window.__lock = l;
        return Promise.resolve(l);
      },
    } });
    const q = location.search;
    if (q.includes('touch')) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = s => (/pointer:\s*coarse/.test(s) ? { matches: true, media: s, addEventListener() {}, removeEventListener() {} } : mm(s));
    }
    if (q.includes('nofs')) {
      delete Element.prototype.requestFullscreen;
      delete Element.prototype.webkitRequestFullscreen;
      return;
    }
    let el = null;
    const fire = () => setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 10);
    // The browser leaving full screen without an event, as on a Back visit.
    window.__drop = () => { el = null; };
    Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => el });
    Element.prototype.requestFullscreen = function (opts) {
      window.__fs.push(['request', this.id, opts && opts.navigationUI]);
      if (q.includes('hang')) { window.__grant = () => { el = this; fire(); }; return new Promise(() => {}); }
      if (q.includes('reject')) return Promise.reject(new TypeError('Permissions check failed'));
      el = this; fire(); return Promise.resolve();
    };
    Document.prototype.exitFullscreen = function () { window.__fs.push(['exit']); el = null; fire(); return Promise.resolve(); };
  });
  await open();

  const text = s => page.locator(s).textContent();
  const bg = () => page.$eval('#ws-stage', e => getComputedStyle(e).backgroundColor);
  const rgbOf = async () => (await bg()).match(/\d+/g).map(Number);
  const rgb = a => `rgb(${a.join(', ')})`;
  const active = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  const has = cls => page.$eval('#ws-stage', (e, c) => e.classList.contains(c), cls);
  const hash = () => page.evaluate(() => location.hash);
  // The address is written 0.25 s after the last change.
  const hashIs = async (want, what) => {
    await page.waitForFunction(h => location.hash === h, want, { timeout: 3000 }).catch(() => {});
    assert.equal(await hash(), want, what);
  };
  const slide = (id, v) => page.$eval(id, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  // The sRGB curve (IEC 61966-2-1), to dim a colour in linear light.
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const enc = c => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  const dim = (c, f) => c.map(v => enc(lin(v) * f));
  const near = (got, want, tol, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= tol), `${what}: got ${got}, expected ${want} (±${tol})`);

  // ---- Starts on plain white ----
  assert.equal(await bg(), 'rgb(255, 255, 255)');
  assert.deepEqual([await text('#ws-name'), await text('#ws-desc'), await text('#ws-code')], ['White', '6500 K, 100% brightness', '#FFFFFF']);
  assert.equal(await hash(), '');
  const names = await page.$$eval('.ws-sw', els => els.map(e => e.textContent));
  assert.deepEqual(names, ['White', 'Black', 'Red', 'Green', 'Blue', 'Yellow', 'Orange', 'Pink', 'Purple', 'Grey', 'Custom']);
  assert.equal(await page.getAttribute('.ws-sw:nth-child(1)', 'aria-pressed'), 'true');

  // ---- Preset colours are the CSS colour codes ----
  const presets = { Black: [0, 0, 0], Red: [255, 0, 0], Green: [0, 255, 0], Blue: [0, 0, 255], Yellow: [255, 255, 0],
    Orange: [255, 165, 0], Pink: [255, 192, 203], Purple: [128, 0, 128], Grey: [128, 128, 128] };
  for (const [n, c] of Object.entries(presets)) {
    await page.click(`.ws-sw:text-is("${n}")`);
    assert.equal(await bg(), rgb(c), n);
    assert.equal(await page.getAttribute(`.ws-sw:text-is("${n}")`, 'aria-pressed'), 'true');
    assert.equal(await text('#ws-desc'), '100% brightness', `${n} has no colour temperature`);
  }
  await hashIs('#grey');

  // ---- Colour temperature (fixture: colour-science) ----
  // Below 4000 K the page uses Krystek's approximation of the Planckian locus,
  // within one step of the integrated spectrum; the daylight series is exact.
  await page.click('.ws-sw:text-is("White")');
  for (const t of temps.filter(c => c.brightness === 100)) {
    await slide('#ws-k', t.kelvin);
    near(await rgbOf(), t.rgb, t.kelvin < 4000 ? 1 : 0, `${t.kelvin} K`);
    assert.equal(await text('#ws-k-out'), `${t.kelvin} K`);
    assert.equal(await page.getAttribute('#ws-k', 'aria-valuetext'), `${t.kelvin} K`);
  }
  // 1900 K, the lowest setting, is on the edge of the sRGB gamut: blue is 0.
  await page.focus('#ws-k');
  await page.keyboard.press('Home');
  assert.equal(await text('#ws-k-out'), '1900 K');
  assert.ok((await rgbOf())[2] <= 1, 'blue is all but off at 1900 K');
  await page.keyboard.press('ArrowRight');
  assert.equal(await text('#ws-k-out'), '2000 K');
  await page.keyboard.press('End');
  assert.equal(await text('#ws-k-out'), '10000 K');
  // The temperature buttons, and moving the slider while another colour is
  // shown switches back to white.
  await page.click('.ws-presets [data-k="2700"]');
  near(await rgbOf(), temps.find(t => t.kelvin === 2700 && t.brightness === 100).rgb, 1, '2700 K button');
  await page.click('.ws-sw:text-is("Blue")');
  await slide('#ws-k', 5000);
  assert.equal(await text('#ws-name'), 'White');
  assert.equal(await bg(), rgb(temps.find(t => t.kelvin === 5000 && t.brightness === 100).rgb));
  await page.click('.ws-presets [data-k="6500"]');
  assert.equal(await bg(), 'rgb(255, 255, 255)');

  // ---- Brightness in linear light ----
  for (const t of temps.filter(c => c.brightness !== 100)) {
    await slide('#ws-k', t.kelvin);
    await slide('#ws-b', t.brightness);
    near(await rgbOf(), t.rgb, t.kelvin < 4000 ? 1 : 0, `${t.kelvin} K at ${t.brightness}%`);
  }
  await slide('#ws-k', 6500);
  await slide('#ws-b', 50);
  assert.equal(await text('#ws-code'), '#BCBCBC', 'the guide: 50% of white is #BCBCBC');
  assert.equal(await text('#ws-b-out'), '50%');
  await page.click('.ws-sw:text-is("Red")');
  assert.equal(await bg(), 'rgb(188, 0, 0)');
  await page.click('.ws-sw:text-is("Black")');
  assert.equal(await bg(), 'rgb(0, 0, 0)');
  await page.focus('#ws-b');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#ws-b-out'), '49%');
  await page.keyboard.press('Home');
  assert.equal(await text('#ws-b-out'), '1%');
  await page.click('.ws-sw:text-is("White")');
  assert.equal(await bg(), rgb(dim([255, 255, 255], 0.01)), '1% of white');
  await page.keyboard.press('Tab'); // leave the swatch
  await page.focus('#ws-b');
  await page.keyboard.press('End');
  await hashIs('');

  // ---- Custom colour code ----
  const hexIn = '#ws-hex', err = '#ws-hex-err';
  const hexState = async () => [await page.getAttribute(hexIn, 'aria-invalid'), await page.getAttribute(hexIn, 'aria-describedby'), await text(err)];
  await page.fill(hexIn, '#f80');
  assert.equal(await bg(), 'rgb(255, 136, 0)');
  assert.equal(await text('#ws-name'), 'Custom');
  await page.fill(hexIn, '  00FF7F ');
  assert.equal(await bg(), 'rgb(0, 255, 127)');
  // While typing, a short unfinished code is no error; Enter makes it one.
  await page.fill(hexIn, '#12345');
  assert.deepEqual(await hexState(), [null, null, '']);
  assert.equal(await bg(), 'rgb(0, 255, 127)', 'an unfinished code leaves the colour alone');
  await page.press(hexIn, 'Enter');
  assert.deepEqual(await hexState(), ['true', 'ws-hex-err', 'Enter 3 or 6 hex digits (0 to 9 and A to F), such as #FF8800.']);
  await page.fill(hexIn, '#12345g7');
  assert.equal((await hexState())[0], 'true');
  await page.fill(hexIn, '#123456');
  assert.deepEqual(await hexState(), [null, null, '']);
  assert.equal(await bg(), 'rgb(18, 52, 86)');
  // A megabyte pasted into the field is cut to the field's 32 characters.
  const t0 = Date.now();
  await page.fill(hexIn, 'f'.repeat(1 << 20));
  assert.ok(Date.now() - t0 < 3000, 'a megabyte paste is handled at once');
  assert.ok((await page.inputValue(hexIn)).length <= 32);
  assert.equal((await hexState())[0], 'true');
  assert.equal(await bg(), 'rgb(18, 52, 86)');
  await page.fill(hexIn, 'ABC');
  await page.press(hexIn, 'Tab');
  assert.equal(await page.inputValue(hexIn), '#AABBCC', 'the code is tidied when you leave the field');
  // The colour picker sets the custom colour too.
  await page.$eval('#ws-picker', e => { e.value = '#336699'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await bg(), 'rgb(51, 102, 153)');
  assert.equal(await page.inputValue(hexIn), '#336699');
  await hashIs('#336699');

  // ---- Copy link and the address ----
  // Copy straight after a change, before the address would be written by itself.
  await page.evaluate(() => {
    const b = document.getElementById('ws-b');
    b.value = '80';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('ws-link').click();
  });
  await page.waitForFunction(() => document.getElementById('ws-link').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url + '#336699&b=80', 'Copy link brings the address up to date first');
  const visit = async h => { await page.goto(url + h); await page.evaluate(() => 0); };
  await visit('#red&b=50');
  assert.equal(await bg(), 'rgb(188, 0, 0)');
  assert.equal(await page.inputValue('#ws-b'), '50');
  assert.equal(await text('#ws-msg'), '');
  await visit('#white&k=2750');
  assert.equal(await text('#ws-k-out'), '2800 K', 'rounded to the slider step');
  await visit('#F80');
  assert.equal(await bg(), 'rgb(255, 136, 0)');
  await visit('#zzz&b=40');
  assert.equal(await bg(), rgb(dim([255, 255, 255], 0.4)), 'unknown colour: white, at the brightness asked for');
  assert.equal(await text('#ws-msg'), 'Part of this link could not be read (“zzz”), so white is shown.');
  await visit('#blue&b=500&k=3000');
  assert.equal(await bg(), 'rgb(0, 0, 255)');
  assert.equal(await text('#ws-msg'), 'Part of this link could not be read (“b=500”), so that part was left out.');
  // A long bad part is quoted without splitting an emoji in two.
  await visit('#' + 'x'.repeat(23) + '\u{1F600}y');
  assert.equal(await text('#ws-msg'), 'Part of this link could not be read (“' + 'x'.repeat(23) + '\u{1F600}…”), so white is shown.');
  await visit('#' + 'a'.repeat(65));
  assert.equal(await text('#ws-msg'), 'The colour in this link is too long to read, so white is shown.');
  await visit('#ffffff');
  await hashIs('#ffffff', 'a custom colour stays custom');
  // Editing the address on the page switches the colour.
  await page.evaluate(() => { location.hash = '#green&b=10'; });
  await page.waitForFunction(() => document.getElementById('ws-name').textContent === 'Green');
  assert.equal(await bg(), rgb(dim([0, 255, 0], 0.1)));
  // A link opened afresh keeps its message: the page tidies the address at
  // once, and reading it again when the page is shown must not clear it.
  for (const [h, want, msg] of [
    ['#zzz&b=40', '#white&b=40', 'Part of this link could not be read (“zzz”), so white is shown.'],
    // A single word could name a heading, so it is read once the page is complete.
    ['#zzz', '', 'Part of this link could not be read (“zzz”), so white is shown.'],
    ['#' + 'a'.repeat(65), '', 'The colour in this link is too long to read, so white is shown.'],
  ]) {
    await page.goto('about:blank');
    await visit(h);
    await hashIs(want);
    await page.waitForTimeout(300);
    assert.equal(await text('#ws-msg'), msg, `fresh visit to ${h.slice(0, 12)}`);
  }
  // A link to a section of the guide is no colour: no message, the address
  // keeps it, and the browser scrolls to the heading.
  await page.goto('about:blank');
  await visit('#brightness');
  await page.waitForTimeout(400);
  assert.deepEqual([await text('#ws-msg'), await hash(), await text('#ws-name')], ['', '#brightness', 'White']);
  const [headTop, vh, sy] = await page.evaluate(() => [document.getElementById('brightness').getBoundingClientRect().top, innerHeight, scrollY]);
  assert.ok(sy > 0 && headTop > -2 && headTop < vh / 2, `scrolled to the Brightness heading (top ${headTop}, scrollY ${sy})`);
  // Followed from the page itself, it leaves the colour alone until the next change.
  await visit('#red&b=50');
  await page.evaluate(() => { location.hash = '#colour-temperature'; });
  await page.waitForTimeout(400);
  assert.deepEqual([await text('#ws-msg'), await hash(), await text('#ws-name'), await bg()], ['', '#colour-temperature', 'Red', 'rgb(188, 0, 0)']);
  await page.click('.ws-sw:text-is("Blue")');
  await hashIs('#blue&b=50');
  // Back to the top: the stubbed full screen below leaves the colour in place.
  await page.evaluate(() => window.scrollTo(0, 0));

  // After Back, the address wins over whatever the browser restores.
  await page.goto(url + '#purple&b=60');
  await page.goto(url.replace(/white-screen\/$/, ''));
  await page.goBack();
  assert.equal(await text('#ws-name'), 'Purple');
  assert.equal(await page.inputValue('#ws-b'), '60');
  assert.equal(await bg(), rgb(dim([128, 0, 128], 0.6)));

  // ---- Download PNG: the screen's size in device pixels, in the shown colour ----
  await visit('#white&k=2700&b=60');
  const shown = await rgbOf();
  const [sw, sh, dpr] = await page.evaluate(() => [screen.width, screen.height, devicePixelRatio]);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ws-png')]);
  const hex = shown.map(v => v.toString(16).padStart(2, '0')).join('');
  assert.equal(dl.suggestedFilename(), `white-${hex}-${Math.round(sw * dpr)}x${Math.round(sh * dpr)}.png`);
  const png = fs.readFileSync(await dl.path());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Math.round(sw * dpr), Math.round(sh * dpr)]);
  const pixels = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return [[0, 0], [img.width - 1, img.height - 1], [img.width >> 1, img.height >> 1]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  }, png.toString('base64'));
  for (const p of pixels) assert.deepEqual(p, [...shown, 255]);
  assert.match(await text('#ws-msg'), /^Saved white-[0-9a-f]{6}-\d+x\d+\.png, \d+ × \d+ pixels\.$/);

  // ---- Full screen (stubbed API) ----
  await visit('#white');
  await page.click('#ws-full');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-active'));
  assert.deepEqual(await page.evaluate(() => window.__fs), [['request', 'ws-stage', 'hide']]);
  assert.equal(await active(), 'ws-stage');
  assert.equal(await page.getAttribute('#ws-stage', 'role'), 'application');
  assert.match(await page.getAttribute('#ws-stage', 'aria-label'), /^Full-screen colour: White, 6500 K, 100% brightness\./);
  await page.waitForFunction(() => window.__wake.length === 1);
  // The browser drops the lock while the page is hidden; it is asked for
  // again when the page is back in view.
  await page.evaluate(() => { window.__lock.dispatchEvent(new Event('release')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.__wake.length === 2, null, { timeout: 3000 });
  assert.deepEqual(await page.$eval('#ws-stage', e => { const s = getComputedStyle(e); return [s.borderTopWidth, s.borderTopLeftRadius]; }), ['0px', '0px']);
  // Arrows change the colour and the brightness in steps of 5%.
  await page.keyboard.press('ArrowRight');
  assert.equal(await text('#ws-name'), 'Black');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#ws-name'), 'Custom', 'wraps around backwards');
  await page.keyboard.press('ArrowRight');
  assert.equal(await text('#ws-name'), 'White');
  for (const [key, want] of [['ArrowDown', '95%'], ['ArrowDown', '90%'], ['ArrowUp', '95%'], ['ArrowUp', '100%'], ['ArrowUp', '100%']]) {
    await page.keyboard.press(key);
    assert.equal(await text('#ws-b-out'), want, key);
  }
  assert.equal(await text('#ws-live'), '100% brightness');
  // Tab cannot reach the page behind; a click shows the controls but keeps the colour.
  for (const k of ['Tab', 'Shift+Tab']) {
    await page.keyboard.press(k);
    assert.equal(await active(), 'ws-stage', k);
  }
  await page.evaluate(() => document.getElementById('ws-full').focus());
  assert.equal(await active(), 'ws-stage', 'focus is pulled back to the colour');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-idle'), null, { timeout: 5000 });
  assert.equal(await has('show-bar'), false);
  assert.equal(await page.$eval('#ws-stage', e => getComputedStyle(e).cursor), 'none');
  const box = await page.locator('#ws-stage').boundingBox();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.3);
  assert.equal(await has('show-bar'), true);
  assert.equal(await text('#ws-name'), 'White', 'a click does not change the colour (tracing)');
  await page.click('#ws-bar-dim');
  assert.equal(await text('#ws-b-out'), '95%');
  await page.click('#ws-bar-up');
  await page.click('#ws-bar-next');
  assert.equal(await text('#ws-name'), 'Black');
  assert.match(await text('#ws-bar-text'), /^Black 100% brightness$/);
  await page.click('#ws-bar-prev');
  // Esc leaves full screen and gives focus back to the button.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('ws-stage').classList.contains('is-active'));
  assert.deepEqual((await page.evaluate(() => window.__fs)).map(c => c[0]), ['request', 'exit']);
  assert.equal(await active(), 'ws-full');
  assert.deepEqual(await page.evaluate(() => window.__wake), ['request:screen', 'request:screen', 'release']);
  // Arrow steps land on multiples of 5 from any brightness, never below 1%.
  await page.focus('#ws-stage');
  for (const [from, key, want] of [[37, 'ArrowUp', '40%'], [37, 'ArrowDown', '35%'], [3, 'ArrowDown', '1%'], [1, 'ArrowUp', '5%'], [99, 'ArrowUp', '100%']]) {
    await slide('#ws-b', from);
    await page.keyboard.press(key);
    assert.equal(await text('#ws-b-out'), want, `${key} from ${from}%`);
  }
  await slide('#ws-b', 100);
  // From the focused preview: Enter and F start it, F ends it, and the
  // browser leaving full screen by itself ends it too.
  await page.focus('#ws-stage');
  await page.keyboard.press('ArrowRight');
  assert.equal(await text('#ws-name'), 'Black', 'arrows work on the preview too');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-active'));
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.getElementById('ws-stage').classList.contains('is-active'));
  await page.focus('#ws-stage');
  await page.keyboard.press('F');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-active'));
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.getElementById('ws-stage').classList.contains('is-active'));
  await page.click('#ws-stage');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-active'));
  await page.click('#ws-bar-exit');
  await page.waitForFunction(() => !document.getElementById('ws-stage').classList.contains('is-active'));
  // Back to the page after the browser left full screen without a word: the
  // colour returns to the page, so the keyboard is not kept on it.
  await page.focus('#ws-stage');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-active'));
  await page.evaluate(() => { window.__drop(); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await has('is-active'), false, 'not left in full screen after a Back visit');
  await page.keyboard.press('Tab');
  assert.notEqual(await active(), 'ws-stage', 'Tab leaves the colour again');
  // F typed into the colour code field is just a letter.
  await page.fill(hexIn, '#ff');
  await page.focus(hexIn);
  await page.keyboard.press('f');
  assert.equal(await has('is-active'), false);
  assert.equal(await page.inputValue(hexIn), '#fff');

  // ---- No Fullscreen API: the colour covers the window instead ----
  await page.goto(url + '?nofs#red');
  await page.click('#ws-full');
  assert.equal(await has('is-pseudo'), true);
  assert.equal(await active(), 'ws-stage');
  assert.equal(await text('#ws-msg'), 'This browser cannot put a page in full screen, so the colour covers the browser window. To hide the toolbars as well, use the browser’s own full-screen key, F11 (Ctrl+Cmd+F on a Mac).');
  await page.waitForSelector('#ws-note', { state: 'visible', timeout: 1000 });
  const vp = page.viewportSize();
  const pb = await page.locator('#ws-stage').boundingBox();
  assert.deepEqual([pb.x, pb.y, pb.width, pb.height], [0, 0, vp.width, vp.height]);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden');
  await page.keyboard.press('Escape');
  assert.equal(await has('is-active'), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'visible');
  await page.goto(url + '?nofs&touch');
  await page.click('#ws-full');
  assert.match(await text('#ws-msg'), /use Download PNG and open the image in your photo viewer\.$/);
  await page.keyboard.press('Escape');
  await page.goto(url + '?reject');
  await page.click('#ws-full');
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-pseudo'));
  assert.match(await text('#ws-msg'), /^The browser refused full screen, so the colour covers the browser window\./);
  await page.keyboard.press('Escape');
  // A request that never answers: the window is covered after 1.5 s, and a
  // late full screen takes over.
  await page.goto(url + '?hang');
  await page.click('#ws-full');
  assert.equal(await has('is-active'), false);
  await page.waitForFunction(() => document.getElementById('ws-stage').classList.contains('is-pseudo'), null, { timeout: 3000 });
  await page.evaluate(() => window.__grant());
  await page.waitForFunction(() => !document.getElementById('ws-stage').classList.contains('is-pseudo'));
  assert.equal(await has('is-active'), true);
  assert.equal(await text('#ws-msg'), '');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('ws-stage').classList.contains('is-active'));

  // ---- The guide links the dead pixel test rather than repeating it ----
  const links = await page.$$eval('.prose a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.ok(links.includes('/dead-pixel-test/'), `guide links: ${links}`);
  for (const href of links) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), `${href} is not a tool page`);
  }

  // ---- On a phone, with touch ----
  const ctx = await page.context().browser().newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  try {
    const phone = await ctx.newPage();
    await phone.goto(url + '#orange');
    await phone.tap('.ws-sw:text-is("Pink")');
    assert.equal(await phone.$eval('#ws-stage', e => getComputedStyle(e).backgroundColor), 'rgb(255, 192, 203)');
    const heights = await phone.$$eval('.ws-sw, #ws-full, #ws-png, #ws-link, .ws-presets .btn', els => els.map(e => e.getBoundingClientRect().height));
    assert.ok(heights.every(h => h >= 44), `touch targets: ${heights}`);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    // The PNG has the phone's real pixels: CSS pixels times the pixel ratio.
    const [pw, ph, pr] = await phone.evaluate(() => [screen.width, screen.height, devicePixelRatio]);
    assert.ok(pr > 2, `a high-density phone screen (${pr})`);
    const [pdl] = await Promise.all([phone.waitForEvent('download'), phone.tap('#ws-png')]);
    assert.equal(pdl.suggestedFilename(), `pink-ffc0cb-${Math.round(pw * pr)}x${Math.round(ph * pr)}.png`);
    const ppng = fs.readFileSync(await pdl.path());
    assert.deepEqual([ppng.readUInt32BE(16), ppng.readUInt32BE(20)], [Math.round(pw * pr), Math.round(ph * pr)]);
  } finally {
    await ctx.close();
  }

  // Leave a custom colour with an error showing for the runner's checks.
  await page.goto(url + '#ff8800&b=70');
  await page.fill(hexIn, '#ggg');
  await page.press(hexIn, 'Enter');
};
