const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Fixtures and the expected Otsu threshold come from tests/fixtures/png-to-svg/make_fixtures.py.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const b64 = name => fs.readFileSync(path.join(fixtures, name)).toString('base64');
  await open();

  const info = () => page.textContent('#p2s-info');
  async function downloadSvg(p = page) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click('#p2s-download')]);
    return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
  }
  // The SVG's structure, read with the browser's own XML parser.
  const structure = svg => page.evaluate(text => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml'), root = doc.documentElement;
    return {
      error: doc.getElementsByTagName('parsererror').length,
      root: root.localName, ns: root.namespaceURI,
      attrs: ['width', 'height', 'viewBox'].map(a => root.getAttribute(a)),
      groups: [...root.children].map(g => ({ tag: g.localName, fill: g.getAttribute('fill'), attrs: g.getAttributeNames().join(','), paths: g.children.length,
        pathAttrs: [...new Set([...g.children].map(p => p.localName + ':' + p.getAttributeNames().join(',')))] })),
      badD: [...root.querySelectorAll('path')].filter(p => !/^(M[-\d. ]+([LQ][-\d. ]+)+Z)+$/.test(p.getAttribute('d'))).length,
      other: root.querySelectorAll('[opacity],[fill-opacity],[desc],[stroke],image,text').length,
    };
  }, svg);
  // Pixels of the SVG drawn by the browser at w x h, at the given points.
  const pixels = (svg, w, h, pts) => page.evaluate(async ([text, w, h, pts]) => {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) opaque++;
    return { opaque, px: pts.map(([x, y]) => Array.from(d.subarray(4 * (y * w + x), 4 * (y * w + x) + 4))) };
  }, [svg, w, h, pts]);
  const near = (p, q, tol = 3) => q.every((v, k) => Math.abs(p[k] - v) <= tol);
  const openFile = async name => {
    await page.setInputFiles('#p2s-file', path.join(fixtures, name));
    await page.waitForFunction(n => document.querySelector('#p2s-drop-title').textContent === n, name);
  };
  const colourList = () => page.$$eval('#p2s-list li .p2s-hex', l => l.map(x => x.firstChild.textContent));
  const setRange = (sel, v) => page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);

  // ---------- The sample logo: four colours, the small red sun included ----------
  await page.waitForFunction(() => /SVG\.$/.test(document.querySelector('#p2s-info').textContent), null, { timeout: 30000 });
  let svg = await downloadSvg();
  assert.equal(svg.name, 'sample-logo.svg');
  assert.match(await info(), /^4 colours, \d+ shapes, [\d.]+ KB SVG\.$/);
  assert.deepEqual((await colourList()).sort(), ['#1f6f4a', '#c0392b', '#e07a2e', '#f4ecd8']);
  let s = await structure(svg.text);
  assert.equal(s.error, 0);
  assert.equal(s.ns, 'http://www.w3.org/2000/svg');
  assert.deepEqual(s.attrs, ['480', '320', '0 0 960 640'], 'original size, traced at twice the size');
  assert.deepEqual(s.groups.map(g => g.fill), ['#1f6f4a', '#f4ecd8', '#e07a2e', '#c0392b'], 'one group per colour, largest at the bottom');
  assert.ok(s.groups.every(g => g.tag === 'g' && g.attrs === 'fill' && g.pathAttrs.join() === 'path:d'), 'only a fill on each group, only d on each path');
  assert.equal(s.badD, 0, 'every path is M, L, Q and Z commands');
  assert.equal(s.other, 0, 'no opacity, stroke, desc, image or text');
  let px = await pixels(svg.text, 480, 320, [[60, 160], [240, 80], [240, 200], [300, 98], [10, 10], [240, 232], [240, 252]]);
  assert.deepEqual(px.px, [[31, 111, 74, 255], [244, 236, 216, 255], [224, 122, 46, 255], [192, 57, 43, 255], [0, 0, 0, 0], [31, 111, 74, 255], [244, 236, 216, 255]]);

  // ---------- A transparent logo: a ring with a hole, a tiny accent, alpha either side of 50% ----------
  await openFile('logo.png');
  assert.equal(await page.textContent('#p2s-drop-hint'), '240 × 160 px PNG. Choose or drop another image to replace it.');
  svg = await downloadSvg();
  assert.equal(svg.name, 'logo.svg');
  assert.equal(await page.textContent('#p2s-note'), 'Enlarged 4 times, to 960 × 640 px, so the curves come out smooth.');
  assert.match(await info(), /^3 colours, \d+ shapes, [\d.]+ KB SVG\.$/);
  s = await structure(svg.text);
  assert.deepEqual(s.attrs, ['240', '160', '0 0 960 640']);
  // Flat colours come out within 2 levels (the fixture's Lanczos reduction rings a little at edges).
  const fills = s.groups.map(g => g.fill), rgbOf = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  assert.equal(fills.length, 3);
  assert.equal(fills[0], '#14286e', 'the navy ring is the largest');
  const accent = fills.find(f => near(rgbOf(f), [220, 30, 40], 2));
  assert.ok(accent, `the 0.2% red accent keeps its own colour: ${fills}`);
  const green = fills.find(f => f !== '#14286e' && f !== accent);
  assert.ok(near(rgbOf(green), [30, 160, 60], 2), `the 78% opaque green stays green: ${green}`);
  px = await pixels(svg.text, 240, 160, [[90, 30], [90, 80], [200, 20], [190, 80], [190, 135], [5, 5], [90, 130]]);
  assert.deepEqual(px.px[0], [20, 40, 110, 255], 'ring');
  assert.equal(px.px[1][3], 0, 'the hole in the ring stays open');
  assert.deepEqual(px.px[2], rgbOf(accent).concat(255), 'accent');
  assert.ok(near(px.px[3], [30, 160, 60, 255], 2), `green block ${px.px[3]}`);
  assert.equal(px.px[4][3], 0, 'the 31% shadow is under the cut and vanishes');
  assert.equal(px.px[5][3], 0, 'transparent background');
  assert.deepEqual(px.px[6], [20, 40, 110, 255]);
  assert.ok(Math.abs(px.opaque - expected.logo_opaque) / expected.logo_opaque < 0.02, `edges do not grow: ${px.opaque} opaque px vs ${expected.logo_opaque}`);

  // ---------- Recolour, remove and restore ----------
  await page.$eval(`#p2s-list input[aria-label^="Colour ${accent}"]`, el => { el.value = '#00ff00'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  svg = await downloadSvg(); // the change is applied before saving, without waiting for the pause
  assert.ok(svg.text.includes('<g fill="#00ff00">') && !svg.text.includes(accent), 'recoloured');
  assert.deepEqual((await pixels(svg.text, 240, 160, [[200, 20]])).px[0], [0, 255, 0, 255]);
  assert.ok((await page.textContent('#p2s-list')).includes('was ' + accent));
  await page.click('button[aria-label="Remove colour #14286e"]');
  svg = await downloadSvg();
  assert.ok(!svg.text.includes('#14286e'), 'navy removed');
  assert.equal((await pixels(svg.text, 240, 160, [[90, 30]])).px[0][3], 0, 'the ring is gone');
  assert.match(await info(), /^2 colours, /);
  assert.equal(await page.isVisible('#p2s-removed'), true);
  assert.equal(await page.textContent('#p2s-removed .p2s-hex'), '#14286e' + (await page.textContent('#p2s-removed small')));
  await page.click('button[aria-label="Restore colour #14286e"]');
  svg = await downloadSvg();
  assert.ok(svg.text.includes('<g fill="#14286e">') && svg.text.includes('<g fill="#00ff00">'), 'navy back, the new green kept');
  assert.equal(await page.isHidden('#p2s-removed'), true);

  // Pick mode: a click on the picture removes the colour under it.
  await page.click('#p2s-pickbtn');
  assert.equal(await page.getAttribute('#p2s-pickbtn', 'aria-pressed'), 'true');
  await page.locator('#p2s-view').scrollIntoViewIfNeeded();
  const box = await page.locator('#p2s-stage').boundingBox();
  await page.mouse.click(box.x + box.width * 90.5 / 240, box.y + box.height * 30.5 / 160);
  assert.equal(await page.getAttribute('#p2s-pickbtn', 'aria-pressed'), 'false', 'one pick, then the mode ends');
  svg = await downloadSvg();
  assert.ok(!svg.text.includes('#14286e'), 'picked colour removed');
  await page.click('button[aria-label="Restore colour #14286e"]');

  // ---------- Copy gives exactly the file ----------
  svg = await downloadSvg();
  await page.click('#p2s-copy');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#p2s-copy').textContent));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), svg.text);

  // ---------- Keyboard ----------
  await page.focus('#p2s-cut');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await page.$eval('#p2s-stage', el => el.style.getPropertyValue('--cut')), '45%');
  assert.equal(await page.getAttribute('#p2s-cut', 'aria-valuetext'), '45%: original on the left, SVG on the right');
  await page.focus('#p2s-view');
  await page.keyboard.press('Equal');
  assert.doesNotMatch(await page.textContent('#p2s-zoom-val'), /Fit/);
  const zoomed = await page.$eval('#p2s-view', el => el.scrollWidth > el.clientWidth);
  assert.ok(zoomed, 'zoomed in, the picture scrolls');
  await page.keyboard.press('0');
  assert.match(await page.textContent('#p2s-zoom-val'), /^Fit \(\d+%\)$/);
  await page.focus('#p2s-copy');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2s-download');
  const [kdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(kdl.suggestedFilename(), 'logo.svg');
  // A double click saves once.
  let count = 0;
  const onDl = () => count++;
  page.on('download', onDl);
  await page.dblclick('#p2s-download');
  await page.waitForTimeout(1500);
  page.off('download', onDl);
  assert.equal(count, 1, 'a double click downloads one file');

  // ---------- Black and white: Otsu's threshold, holes, specks, invert ----------
  await openFile('lettering.png');
  await page.check('input[name="p2s-mode"][value="bw"]');
  assert.equal(await page.isHidden('#p2s-colours-field'), true);
  svg = await downloadSvg();
  assert.equal(await page.textContent('#p2s-thr-out'), expected.otsu + ' (automatic)', 'Otsu threshold as computed independently');
  assert.equal(await page.textContent('#p2s-note'), '', 'traced at its own size');
  s = await structure(svg.text);
  assert.deepEqual(s.attrs, ['1000', '600', '0 0 1000 600']);
  assert.deepEqual(s.groups.map(g => g.fill), ['#000000'], 'one black layer, no white');
  assert.match(await info(), /^1 colour, \d+ shapes, /);
  const compareMask = text => page.evaluate(async ([text, mask]) => {
    async function data(src) {
      const img = new Image(); img.src = src; await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: 1000, height: 600 }), g = c.getContext('2d');
      g.drawImage(img, 0, 0, 1000, 600);
      return g.getImageData(0, 0, 1000, 600).data;
    }
    const a = await data(URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))), m = await data('data:image/png;base64,' + mask);
    let diff = 0, ink = 0;
    for (let i = 0; i < 600000; i++) { const s = a[4 * i + 3] >= 128, t = m[4 * i] >= 128; if (s) ink++; if (s !== t) diff++; }
    const at = (x, y) => a[4 * (y * 1000 + x) + 3] >= 128;
    return { diff, ink, hole: at(250, 300), ring: at(250, 185), bar: at(520, 300), speck: at(801, 101), dot: at(803, 203), paper: at(900, 500) };
  }, [text, b64('lettering-mask.png')]);
  let cm = await compareMask(svg.text);
  assert.ok(cm.diff / expected.ink_pixels < 0.02, `the ink matches the thresholded image: ${cm.diff} pixels differ`);
  assert.deepEqual([cm.hole, cm.ring, cm.bar, cm.speck, cm.dot, cm.paper], [false, true, true, false, true, false], 'hole open, 2 px speck dropped, 6 px dot kept');
  await setRange('#p2s-speck', 0);
  assert.equal(await page.textContent('#p2s-speck-out'), 'off');
  cm = await compareMask((await downloadSvg()).text);
  assert.equal(cm.speck, true, 'with speck size off the 2 px speck is kept');
  await page.check('#p2s-invert');
  cm = await compareMask((await downloadSvg()).text);
  assert.deepEqual([cm.hole, cm.bar, cm.paper], [true, false, true], 'inverted: the paper is cut');
  await page.uncheck('#p2s-invert');
  await setRange('#p2s-speck', 3);
  await setRange('#p2s-thr', 60);
  assert.equal(await page.isChecked('#p2s-auto'), false, 'moving the slider turns off the automatic threshold');
  assert.equal(await page.textContent('#p2s-thr-out'), '60');
  cm = await compareMask((await downloadSvg()).text);
  assert.ok(Math.abs(cm.ink - expected.ink_at_60) / expected.ink_at_60 < 0.02, `ink at threshold 60: ${cm.ink} vs ${expected.ink_at_60}`);
  await page.check('#p2s-auto');
  await downloadSvg();
  assert.equal(await page.textContent('#p2s-thr-out'), expected.otsu + ' (automatic)');

  // ---------- A photo: 16 to 64 colours, traced at its own size ----------
  await page.check('input[name="p2s-mode"][value="photo"]');
  await openFile('photo.jpg');
  assert.deepEqual(await page.$eval('#p2s-colours', el => [el.min, el.max, el.value]), ['16', '64', '24']);
  svg = await downloadSvg();
  assert.match(await info(), /^(1[6-9]|2[0-4]) colours, [\d,]+ shapes, [\d.]+ (KB|MB) SVG\.$/);
  assert.equal(await page.textContent('#p2s-note'), '');
  assert.deepEqual((await structure(svg.text)).attrs, ['640', '480', '0 0 640 480']);
  px = await pixels(svg.text, 640, 480, [[480, 110], [100, 50]]);
  assert.ok(near(px.px[0], [250, 220, 120, 255], 30), `sun ${px.px[0]}`);
  assert.ok(near(px.px[1], [60, 120, 196, 255], 30), `sky ${px.px[1]}`);

  // ---------- Thousands of shapes: a warning ----------
  await page.check('input[name="p2s-mode"][value="logo"]');
  await openFile('dots.png');
  await downloadSvg();
  assert.match(await page.textContent('#p2s-warn'), /^This SVG has 6,401 shapes, so drawing programs and cutting machines may be slow with it\./);
  await setRange('#p2s-speck', 10);
  await downloadSvg();
  assert.equal(await page.textContent('#p2s-warn'), '', 'specks up to 10 px dropped: no warning');
  assert.match(await info(), /^1 colour, 1 shape, /);

  // ---------- Files it cannot trace ----------
  await page.setInputFiles('#p2s-file', { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') });
  await page.waitForFunction(() => document.querySelector('#p2s-error').textContent.length > 0);
  assert.equal(await page.textContent('#p2s-error'), 'drawing.svg is already an SVG, so there is nothing to trace. To turn an SVG into a PNG, use the SVG to PNG converter.');
  assert.equal(await page.getAttribute('#p2s-error a', 'href'), '/svg-to-png/');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-describedby'), 'p2s-error');
  await page.setInputFiles('#p2s-file', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('just some text') });
  await page.waitForFunction(() => /not a supported image/.test(document.querySelector('#p2s-error').textContent));
  assert.equal(await page.getAttribute('#p2s-file', 'aria-invalid'), 'true');
  assert.equal(await page.textContent('#p2s-drop-title'), 'dots.png', 'the last good image stays');
  await openFile('logo.png');
  await downloadSvg();
  assert.equal(await page.textContent('#p2s-error'), '');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-invalid'), null);

  // ---------- Back to the page: the browser may restore the radios after the script ran ----------
  await page.evaluate(() => {
    document.querySelector('input[name="p2s-mode"][value="photo"]').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.deepEqual(await page.$eval('#p2s-colours', el => [el.min, el.max]), ['16', '64'], 'pageshow reads the restored radio');
  await downloadSvg();
  assert.match(await info(), /colours, /);

  // ---------- A phone: touch the picture to remove a colour ----------
  const ctx = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.waitForFunction(() => /SVG\.$/.test(document.querySelector('#p2s-info').textContent), null, { timeout: 30000 });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.tap('#p2s-pickbtn');
  await phone.locator('#p2s-view').scrollIntoViewIfNeeded();
  const pb = await phone.locator('#p2s-stage').boundingBox();
  await phone.touchscreen.tap(pb.x + pb.width * 60 / 480, pb.y + pb.height * 160 / 320);
  await phone.waitForFunction(() => document.querySelector('#p2s-removed li'));
  const removed = await phone.textContent('#p2s-removed .p2s-hex');
  assert.ok(removed.startsWith('#1f6f4a'), `the green badge was removed: ${removed}`);
  const knobH = await phone.$eval('#p2s-pickbtn', el => el.getBoundingClientRect().height);
  assert.ok(knobH >= 44, `touch targets are 44 px tall: ${knobH}`);
  await ctx.close();
};
