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
  // The SVG shown beside the original, read back from its image.
  const shown = () => page.evaluate(async () => (await fetch(document.querySelector('#p2s-svg').src)).text());
  const openFile = async name => {
    await page.setInputFiles('#p2s-file', path.join(fixtures, name));
    await page.waitForFunction(n => document.querySelector('#p2s-drop-title').textContent === n, name);
  };
  const colourList = () => page.$$eval('#p2s-list li .p2s-hex', l => l.map(x => x.firstChild.textContent));
  const setRange = (sel, v) => page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  // Holds the messages of each tracing worker started from now on (window.p2sW[k], k from 0) until it
  // is released, so that a trace is still running, or finishes late, exactly when a test needs it.
  const holdWorkers = () => page.evaluate(() => {
    const W = window.p2sWorker = window.Worker;
    window.p2sW = [];
    window.Worker = function (url) {
      const w = new W(url), rec = { held: [], hold: true, done: false, handler: null };
      rec.release = () => { rec.hold = false; rec.held.splice(0).forEach(e => rec.handler && rec.handler.call(w, e)); };
      w.addEventListener('message', e => {
        if (e.data.type !== 'progress') rec.done = true;
        if (rec.hold) rec.held.push(e); else if (rec.handler) rec.handler.call(w, e);
      });
      Object.defineProperty(w, 'onmessage', { get: () => rec.handler, set: f => { rec.handler = f; } });
      window.p2sW.push(rec);
      return w;
    };
  });
  const releaseWorker = k => page.evaluate(k => window.p2sW[k].release(), k);
  const unholdWorkers = () => page.evaluate(() => { window.Worker = window.p2sWorker; window.p2sW.forEach(r => r.release()); });
  // A fixture handed to the page as a File: dropped on the drop area, or pasted.
  const handOver = (how, name) => page.evaluate(([how, data, name]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name, { type: 'image/png' }));
    if (how === 'paste') document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    else for (const type of ['dragenter', 'dragover', 'drop']) document.querySelector('#p2s-drop').dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [how, b64(name), name]);

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
  // The colours are stacked, so no see-through seams appear where shapes of different colours touch.
  const seams = await page.evaluate(async text => {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: 480, height: 320 }), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(90, 40, 300, 240).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) n++;
    return n;
  }, svg.text);
  assert.equal(seams, 0, 'no see-through pixels inside the badge');

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
  assert.equal(await shown(), svg.text, 'the SVG saved is the one shown');
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
  // From the keyboard, Remove and Restore leave the focus in the colour lists, not on the page.
  const focused = () => page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.focus('button[aria-label="Remove colour #14286e"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^2 colours/.test(document.querySelector('#p2s-info').textContent));
  assert.equal(await focused(), `Remove colour ${green}`, 'the focus moves on to the next colour');
  await page.focus('button[aria-label="Restore colour #14286e"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^3 colours/.test(document.querySelector('#p2s-info').textContent));
  assert.equal(await focused(), 'Remove colour #14286e', 'with no removed colour left, the focus goes to the colour put back');
  // Remove pressed with the mouse, then a scroll up to the picture while it is traced: the page stays
  // there, though the focus still moves on. (Reduced motion, so that any scroll happens at once.)
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await holdWorkers();
  await page.click('button[aria-label="Remove colour #14286e"]');
  await page.waitForFunction(() => window.p2sW.length === 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await page.$eval('#p2s-list', el => el.getBoundingClientRect().top > innerHeight), 'the colour list is out of view');
  await releaseWorker(0);
  await page.waitForFunction(() => /^2 colours/.test(document.querySelector('#p2s-info').textContent));
  assert.equal(await page.evaluate(() => scrollY), 0, 'the page does not jump back to the colour list');
  assert.equal(await focused(), `Remove colour ${green}`);
  await unholdWorkers();
  await page.emulateMedia({ reducedMotion: null });
  await page.click('button[aria-label="Restore colour #14286e"]');
  await page.waitForFunction(() => /^3 colours/.test(document.querySelector('#p2s-info').textContent));

  // Escape ends pick mode.
  await page.click('#p2s-pickbtn');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#p2s-pickbtn').getAttribute('aria-pressed'), document.querySelector('#p2s-view').classList.contains('is-picking')]),
    ['false', false], 'Escape ends picking');
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

  // ---------- Quick changes: a trace overtaken by a newer one is never shown or saved ----------
  // At Speck size 20 the 8 px accent goes; at 0 it stays. The first trace ends after the second began.
  await holdWorkers();
  await setRange('#p2s-speck', 20);
  await page.waitForFunction(() => window.p2sW.length === 1 && window.p2sW[0].done);
  await setRange('#p2s-speck', 0);
  await page.waitForFunction(() => window.p2sW.length === 2);
  const shownBefore = [await info(), await shown()];
  await releaseWorker(0);
  assert.deepEqual([await info(), await shown()], shownBefore, 'the overtaken trace is not shown');
  // Download pressed twice from the keyboard while the newest trace runs: one file, from that trace.
  let saves = 0;
  const onSave = () => saves++;
  page.on('download', onSave);
  const newest = page.waitForEvent('download', { timeout: 60000 });
  await page.focus('#p2s-download');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.p2sW[1].done);
  await releaseWorker(1);
  const newestText = fs.readFileSync(await (await newest).path(), 'utf8');
  assert.equal((await structure(newestText)).groups.length, 3, 'the newest trace (Speck size 0, the accent kept) is saved');
  assert.equal(newestText, await shown());
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('#p2s-progress').textContent));
  await page.waitForTimeout(1000);
  page.off('download', onSave);
  assert.equal(saves, 1, 'pressed twice while tracing, it saves once');
  await unholdWorkers();
  await setRange('#p2s-speck', 2);
  await downloadSvg();

  // ---------- Keyboard ----------
  await page.focus('#p2s-cut');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await page.$eval('#p2s-stage', el => el.style.getPropertyValue('--cut')), '45%');
  assert.equal(await page.getAttribute('#p2s-cut', 'aria-valuetext'), '45%: original on the left, SVG on the right');
  // Each side shows only its own picture, so transparent parts of the SVG look transparent.
  assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector('#p2s-orig')).clipPath, getComputedStyle(document.querySelector('#p2s-svg')).clipPath]),
    ['inset(0px 55% 0px 0px)', 'inset(0px 0px 0px 45%)']);
  // With a mouse, a drag anywhere on the picture moves the divider.
  await page.locator('#p2s-view').scrollIntoViewIfNeeded();
  const sb = await page.locator('#p2s-stage').boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.45, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.7, sb.y + sb.height / 2, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual([await page.$eval('#p2s-stage', el => el.style.getPropertyValue('--cut')), await page.$eval('#p2s-cut', el => el.value)], ['70%', '70'], 'a mouse drag moves the divider');
  // The zoom is a percentage of the picture's own size (240 px wide), which
  // the SVG keeps, not of the copy enlarged four times for tracing.
  const zoomLabel = () => page.evaluate(() => {
    const pct = Math.round(parseFloat(document.querySelector('#p2s-stage').style.width) / 240 * 100);
    return [document.querySelector('#p2s-zoom-val').textContent, pct];
  });
  let [label, pct] = await zoomLabel();
  assert.equal(label, `Fit (${pct}%)`);
  assert.ok(pct > 100, `the 240 px logo fills the wider view: ${label}`);
  await page.focus('#p2s-view');
  await page.keyboard.press('Equal');
  [label, pct] = await zoomLabel();
  assert.equal(label, `${pct}%`);
  const zoomed = await page.$eval('#p2s-view', el => el.scrollWidth > el.clientWidth);
  assert.ok(zoomed, 'zoomed in, the picture scrolls');
  assert.equal(await page.$eval('#p2s-view', el => getComputedStyle(el).overscrollBehaviorY), 'contain', 'zoomed in, the wheel scrolls the picture only');
  await page.keyboard.press('0');
  [label, pct] = await zoomLabel();
  assert.equal(label, `Fit (${pct}%)`);
  // At its fitted size the picture does not hold on to the wheel: the page scrolls.
  await page.$eval('#p2s-view', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const vbox = await page.locator('#p2s-view').boundingBox();
  await page.mouse.move(vbox.x + vbox.width * 0.75, vbox.y + vbox.height / 2);
  const wy = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(y => scrollY !== y, wy, { timeout: 10000 }).catch(() => {});
  assert.ok(await page.evaluate(y => scrollY > y, wy), 'the wheel over the picture scrolls the page');
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
  // Picking a colour to remove ends with the switch: black and white has no colours to remove.
  await page.click('#p2s-pickbtn');
  await page.check('input[name="p2s-mode"][value="bw"]');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#p2s-pickbtn').getAttribute('aria-pressed'), document.querySelector('#p2s-view').classList.contains('is-picking')]),
    ['false', false], 'no picking in black and white');
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
  // A transparent logo: its transparent parts are white paper, never ink (a canvas reads them as
  // black), so only the ring, the accent and the 78% green block are cut; the faint shadow is not.
  await openFile('logo.png');
  svg = await downloadSvg();
  px = await pixels(svg.text, 240, 160, [[5, 5], [90, 30], [90, 80], [200, 20], [190, 80], [190, 135], [235, 155]]);
  assert.deepEqual(px.px.map(p => p[3] >= 128), [false, true, false, true, true, false, false], 'ink where the logo is, paper elsewhere');

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
  assert.equal(await shown(), svg.text, 'the SVG saved is the one shown');

  // ---------- Over 2 megapixels: traced at 2, the SVG keeps the picture's own size ----------
  const big = await page.evaluate(() => {
    const c = Object.assign(document.createElement('canvas'), { width: 2400, height: 1500 }), g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 2400, 1500);
    g.fillStyle = '#c0392b'; g.beginPath(); g.arc(800, 750, 500, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1f6f4a'; g.fillRect(1500, 300, 700, 900);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.check('input[name="p2s-mode"][value="logo"]');
  await page.setInputFiles('#p2s-file', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(big, 'base64') });
  await page.waitForFunction(() => document.querySelector('#p2s-drop-title').textContent === 'big.png');
  svg = await downloadSvg();
  assert.equal(await page.textContent('#p2s-note'), 'Traced at 1,788 × 1,118 px, reduced from 2,400 × 1,500 px; the SVG keeps the original size.');
  assert.deepEqual((await structure(svg.text)).attrs, ['2400', '1500', '0 0 1788 1118']);
  assert.match(await info(), /^3 colours, 4 shapes, /, 'the white ground, the circle, and the block both in red and in green on top (colours are stacked)');
  px = await pixels(svg.text, 2400, 1500, [[800, 750], [1850, 750], [100, 100], [800, 1270]]);
  assert.deepEqual(px.px, [[192, 57, 43, 255], [31, 111, 74, 255], [255, 255, 255, 255], [255, 255, 255, 255]]);
  [label, pct] = await page.evaluate(() => [document.querySelector('#p2s-zoom-val').textContent, Math.round(parseFloat(document.querySelector('#p2s-stage').style.width) / 2400 * 100)]);
  assert.equal(label, `Fit (${pct}%)`, 'the zoom is of the picture\'s own size');

  // ---------- Lines too thin for flat pixels, and a small logo on white ----------
  const near3 = (fill, rgb, tol) => near(rgbOf(fill), rgb, tol);
  // A signature traced at its own size (dropped on the drop area): no pixel of its lines is flat, yet
  // they are drawn, each in its own colour.
  await handOver('drop', 'signature.png');
  await page.waitForFunction(() => document.querySelector('#p2s-drop-title').textContent === 'signature.png');
  svg = await downloadSvg();
  assert.equal(await page.textContent('#p2s-note'), '', 'traced at its own size');
  assert.match(await info(), /^3 colours, \d shapes, /, 'white, the navy scribble and the red line');
  let fl = (await structure(svg.text)).groups.map(g => g.fill);
  assert.ok(fl.includes('#ffffff') && fl.some(f => near3(f, [20, 30, 90], 10)) && fl.some(f => near3(f, [200, 30, 40], 4)), `the lines' own colours: ${fl}`);
  const inkMatch = await page.evaluate(async ([text, data]) => {
    async function ink(src) {
      const img = new Image(); img.src = src; await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 450 }), g = c.getContext('2d');
      g.drawImage(img, 0, 0, 1200, 450);
      const d = g.getImageData(0, 0, 1200, 450).data, m = new Uint8Array(540000);
      for (let i = 0; i < 540000; i++) m[i] = 765 - d[4 * i] - d[4 * i + 1] - d[4 * i + 2] > 192 ? 1 : 0;
      return m;
    }
    const a = await ink(URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))), b = await ink('data:image/png;base64,' + data);
    let both = 0, svgOnly = 0, srcOnly = 0;
    for (let i = 0; i < 540000; i++) { if (a[i] && b[i]) both++; else if (a[i]) svgOnly++; else if (b[i]) srcOnly++; }
    return { both, svgOnly, srcOnly };
  }, [svg.text, b64('signature.png')]);
  assert.ok(inkMatch.both > 0.65 * expected.signature_ink && inkMatch.svgOnly < 0.15 * expected.signature_ink, `the lines are where the picture has them: ${JSON.stringify(inkMatch)}`);
  // A small logo on white, enlarged 4 times to be traced (pasted): its soft edges add no in-between
  // shades as colours, and leave no slivers of grey around the black shapes.
  await handOver('paste', 'badge.png');
  await page.waitForFunction(() => document.querySelector('#p2s-drop-title').textContent === 'badge.png');
  svg = await downloadSvg();
  assert.equal(await page.textContent('#p2s-note'), 'Enlarged 4 times, to 960 × 480 px, so the curves come out smooth.');
  const counts = (await info()).match(/^(\d+) colours, (\d+) shapes, /);
  assert.ok(counts && counts[1] === '4' && Number(counts[2]) <= 12, `four colours and few shapes: ${await info()}`);
  fl = (await structure(svg.text)).groups.map(g => g.fill);
  assert.ok([[255, 255, 255], [20, 20, 20], [128, 128, 128], [210, 40, 50]].every(c => fl.some(f => near3(f, c, 3))), `the badge's own colours: ${fl}`);
  px = await pixels(svg.text, 240, 120, [[19, 60], [60, 60], [145, 57], [200, 40], [200, 83], [235, 110]]);
  assert.deepEqual(px.px.map(p => fl.findIndex(f => near(rgbOf(f), p.slice(0, 3), 3))), [[20, 20, 20], [255, 255, 255], [20, 20, 20], [128, 128, 128], [210, 40, 50], [255, 255, 255]].map(c => fl.findIndex(f => near3(f, c, 3))),
    'ring, hole, bar, grey block, red disc, ground');
  // Drawn at 4 times the size without smoothing, so that only the SVG's own colours show.
  const slivers = await page.evaluate(async text => {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text.replace('<svg ', '<svg shape-rendering="crispEdges" ')], { type: 'image/svg+xml' }));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: 960, height: 480 }), g = c.getContext('2d');
    g.drawImage(img, 0, 0, 960, 480);
    const d = g.getImageData(0, 0, 960, 480).data;
    let n = 0;
    for (let y = 0; y < 480; y++) for (let x = 0; x < 960; x++) {
      const o = 4 * (y * 960 + x);
      if (x >= 4 * 173 && x < 4 * 232 && y >= 4 * 18 && y < 4 * 62) continue;
      if (Math.abs(d[o] - 128) + Math.abs(d[o + 1] - 128) + Math.abs(d[o + 2] - 128) <= 9) n++;
    }
    return n;
  }, svg.text);
  assert.equal(slivers, 0, 'no grey outside the grey block (drawn at 4 times the size)');

  // ---------- Thousands of shapes: a warning ----------
  await page.check('input[name="p2s-mode"][value="logo"]');
  await openFile('dots.png');
  await downloadSvg();
  assert.match(await page.textContent('#p2s-warn'), /^This SVG has 6,401 shapes, so drawing programs and cutting machines may be slow with it\./);
  // Speck size counts pixels of the picture as opened, not of the copy traced at twice its size:
  // at 4 px the 3 px dots go (6 px in that copy).
  await setRange('#p2s-speck', 4);
  await downloadSvg();
  assert.equal(await page.textContent('#p2s-warn'), '', 'spots up to 4 px across dropped: no warning');
  assert.match(await info(), /^1 colour, 1 shape, /);
  assert.deepEqual(await colourList(), ['#ffffff'], 'a colour whose shapes are all specks is not in the SVG, so not in the list');

  // ---------- A new file still opening or tracing: nothing of the last one is shown, copied or saved ----------
  await page.evaluate(() => {
    const decode = TTImage.decode;
    window.p2sOpen = new Promise(r => { window.p2sLetGo = r; });
    TTImage.decode = async function () { await window.p2sOpen; TTImage.decode = decode; return decode.apply(this, arguments); };
    window.p2sSeen = null;
    new MutationObserver((m, o) => {
      o.disconnect();
      window.p2sSeen = { src: document.querySelector('#p2s-svg').getAttribute('src'), info: document.querySelector('#p2s-info').textContent,
        colours: document.querySelectorAll('#p2s-list li').length, code: document.querySelector('#p2s-code').textContent.length };
    }).observe(document.querySelector('#p2s-drop-title'), { childList: true, characterData: true, subtree: true });
  });
  await page.setInputFiles('#p2s-file', path.join(fixtures, 'logo.png'));
  await page.waitForFunction(() => /^Opening logo\.png/.test(document.querySelector('#p2s-progress').textContent));
  const early = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#p2s-download');
  await page.click('#p2s-copy');
  await page.evaluate(() => window.p2sLetGo());
  const edl = await early;
  assert.equal(edl.suggestedFilename(), 'logo.svg', 'Download pressed while the file opens saves that file');
  const etext = fs.readFileSync(await edl.path(), 'utf8');
  assert.deepEqual((await structure(etext)).attrs, ['240', '160', '0 0 960 640']);
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#p2s-copy').textContent));
  const ecopy = await page.evaluate(() => navigator.clipboard.readText());
  assert.deepEqual((await structure(ecopy)).attrs, ['240', '160', '0 0 960 640'], 'Copy pressed while the file opens copies that file');
  assert.equal(ecopy, etext);
  assert.deepEqual(await page.evaluate(() => window.p2sSeen), { src: null, info: '', colours: 0, code: 0 },
    'the last picture\'s SVG, colours and code are gone once the new picture shows');

  // ---------- Files it cannot trace ----------
  await page.setInputFiles('#p2s-file', { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') });
  await page.waitForFunction(() => document.querySelector('#p2s-error').textContent.length > 0);
  assert.equal(await page.textContent('#p2s-error'), 'drawing.svg is already an SVG, so there is nothing to trace. To turn an SVG into a PNG, use the SVG to PNG converter.');
  assert.equal(await page.getAttribute('#p2s-error a', 'href'), '/svg-to-png/');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-describedby'), 'p2s-error');
  // A trace that finishes after the refusal leaves the message in place.
  await setRange('#p2s-speck', 9);
  await page.setInputFiles('#p2s-file', { name: 'again.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await page.waitForFunction(() => /^again\.svg/.test(document.querySelector('#p2s-error').textContent));
  await downloadSvg();
  assert.match(await page.textContent('#p2s-error'), /^again\.svg is already an SVG/);
  // Download pressed while a file opens that then cannot be opened: nothing is saved, not even the last picture.
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.p2sSaved = this.download; return click.call(this); };
    window.p2sSaved = null;
    const decode = TTImage.decode;
    window.p2sOpen = new Promise(r => { window.p2sLetGo = r; });
    TTImage.decode = async function () { await window.p2sOpen; TTImage.decode = decode; return decode.apply(this, arguments); };
  });
  await page.setInputFiles('#p2s-file', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('just some text') });
  await page.waitForFunction(() => /^Opening notes\.png/.test(document.querySelector('#p2s-progress').textContent));
  await page.click('#p2s-download');
  await page.evaluate(() => window.p2sLetGo());
  await page.waitForFunction(() => /not a supported image/.test(document.querySelector('#p2s-error').textContent) && !document.querySelector('#p2s-download').dataset.busy);
  assert.equal(await page.evaluate(() => window.p2sSaved), null, 'nothing saved for a file that could not be opened');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-invalid'), 'true');
  assert.equal(await page.textContent('#p2s-drop-title'), 'logo.png', 'the last good image stays');
  await openFile('logo.png');
  await downloadSvg();
  assert.equal(await page.textContent('#p2s-error'), '');
  assert.equal(await page.getAttribute('#p2s-file', 'aria-invalid'), null);
  // A file the decoder warns about is traced with a note: a PNG damaged half way
  // and one cut off (from the image converter's fixtures).
  for (const [n, re] of [['damaged.png', /seems to be damaged/], ['cut-big.png', /seems to be cut off/]]) {
    await page.setInputFiles('#p2s-file', { name: n, mimeType: 'image/png', buffer: fs.readFileSync(path.join(fixtures, '..', 'image-converter', n)) });
    await page.waitForFunction(name => document.querySelector('#p2s-drop-title').textContent === name, n);
    await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#p2s-note').textContent), re.source);
  }
  // Nothing to draw: say why, and Copy refuses as Download does.
  const drawn = fill => page.evaluate(fill => {
    const c = Object.assign(document.createElement('canvas'), { width: 120, height: 80 }), g = c.getContext('2d');
    g.fillStyle = fill; g.fillRect(0, 0, 120, 80);
    return c.toDataURL('image/png').split(',')[1];
  }, fill);
  for (const [n, fill, why] of [['faint.png', 'rgba(30, 90, 200, 0.4)', 'no pixel is at least half opaque, and fainter ones are left out.'],
    ['clear.png', 'rgba(30, 90, 200, 0)', 'the image is fully transparent.']]) {
    await page.setInputFiles('#p2s-file', { name: n, mimeType: 'image/png', buffer: Buffer.from(await drawn(fill), 'base64') });
    await page.waitForFunction(n => document.querySelector('#p2s-drop-title').textContent === n, n);
    await page.waitForFunction(() => /^Nothing to draw/.test(document.querySelector('#p2s-info').textContent));
    assert.equal(await info(), 'Nothing to draw: ' + why);
  }
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  await page.click('#p2s-copy');
  await page.waitForFunction(() => document.querySelector('#p2s-error').textContent || /Copied/.test(document.querySelector('#p2s-copy').textContent));
  assert.equal(await page.textContent('#p2s-error'), 'There is nothing in the SVG to copy: the image is fully transparent.');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'before', 'an empty SVG is not copied');
  // A long name is cut between whole characters, never inside an emoji.
  const longName = 'x'.repeat(119) + '\u{1F600}y.png';
  await page.setInputFiles('#p2s-file', { name: longName, mimeType: 'image/png', buffer: fs.readFileSync(path.join(fixtures, 'logo.png')) });
  await page.waitForFunction(n => document.querySelector('#p2s-drop-title').textContent === n, longName);
  await downloadSvg();
  assert.equal(await page.evaluate(() => window.p2sSaved), 'x'.repeat(119) + '\u{1F600}.svg');
  await openFile('logo.png');

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
  // A finger on the picture, away from the divider's knob, scrolls the page.
  const cdp = await ctx.newCDPSession(phone);
  await phone.$eval('#p2s-view', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const vb = await phone.$eval('#p2s-view', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const sy = await phone.evaluate(() => scrollY), from = { x: vb.x + vb.w * 0.85, y: vb.y + vb.h * 0.7 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let k = 1; k <= 8; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + k * 0.4, y: from.y - k * 20 }] });
    await phone.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await phone.waitForFunction(y => scrollY !== y, sy, { timeout: 10000 }).catch(() => {});
  assert.ok(await phone.evaluate(y => scrollY > y, sy), 'a swipe on the picture scrolls the page');
  assert.equal(await phone.$eval('#p2s-stage', el => el.style.getPropertyValue('--cut')), '50%', 'and leaves the divider where it was');
  await phone.tap('#p2s-pickbtn');
  await phone.locator('#p2s-view').scrollIntoViewIfNeeded();
  const pb = await phone.locator('#p2s-stage').boundingBox();
  await phone.touchscreen.tap(pb.x + pb.width * 60 / 480, pb.y + pb.height * 160 / 320);
  await phone.waitForFunction(() => document.querySelector('#p2s-removed li'));
  const removed = await phone.textContent('#p2s-removed .p2s-hex');
  assert.ok(removed.startsWith('#1f6f4a'), `the green badge was removed: ${removed}`);
  const knobH = await phone.$eval('#p2s-pickbtn', el => el.getBoundingClientRect().height);
  assert.ok(knobH >= 44, `touch targets are 44 px tall: ${knobH}`);
  // A finger on the knob drags the divider, and the page stays put. (Last: in this emulation a tap
  // straight after a drag is not clicked, which a real finger is too slow to meet.)
  const settled = () => phone.waitForFunction(() => new Promise(r => { const y = scrollY; setTimeout(() => r(scrollY === y), 200); }), null, { timeout: 10000 });
  await phone.$eval('#p2s-view', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await settled();
  const kn = await phone.$eval('#p2s-knob', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const stw = await phone.$eval('#p2s-stage', el => el.getBoundingClientRect().width), ky = await phone.evaluate(() => scrollY);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [kn] });
  for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: kn.x - k * stw * 0.05, y: kn.y + k }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual([await phone.$eval('#p2s-stage', el => el.style.getPropertyValue('--cut')), await phone.evaluate(() => scrollY)], ['20%', ky], 'the knob follows the finger');
  await cdp.detach();
  await ctx.close();
};
