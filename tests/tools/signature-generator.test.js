const fs = require('fs');

function pngSize(b, assert) {
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(b.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

module.exports = async ({ page, open, assert, url }) => {
  await open();
  const strokes = async () => Number(await page.getAttribute('#sg-pad', 'data-strokes'));
  const setRange = (sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  const download = async sel => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  // Decodes a PNG with the browser and reports corner/centre pixels and the ink extent.
  const analyse = buf => page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const at = (px, py) => Array.from(d.subarray((py * c.width + px) * 4, (py * c.width + px) * 4 + 4));
    let ink = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
    for (let py = 0; py < c.height; py++) for (let px = 0; px < c.width; px++) {
      if (d[(py * c.width + px) * 4 + 3] > 128) {
        ink++;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    return {
      corners: [at(0, 0), at(c.width - 1, 0), at(0, c.height - 1), at(c.width - 1, c.height - 1)],
      centre: at(Math.floor(c.width / 2), Math.floor(c.height / 2)), ink, minX, maxX, minY, maxY,
    };
  }, buf.toString('base64'));

  // Empty pad: exports disabled, touch scrolling disabled on the pad.
  assert.equal(await strokes(), 0);
  for (const b of ['#sg-png', '#sg-svg', '#sg-copy', '#sg-undo', '#sg-clear']) assert.equal(await page.isDisabled(b), true, `${b} disabled`);
  assert.equal(await page.isVisible('#sg-hint'), true);
  assert.equal(await page.$eval('#sg-canvas', el => getComputedStyle(el).touchAction), 'none');

  // Constant 4 px line from (100,100) to (300,100) in pad coordinates.
  await page.uncheck('#sg-vary');
  await setRange('#sg-width', 4);
  assert.equal(await page.textContent('#sg-width-out'), '4 px');
  const box = await page.locator('#sg-canvas').boundingBox();
  const drawLine = async (x0, y0, x1, y1, steps = 20) => {
    await page.mouse.move(box.x + x0, box.y + y0);
    await page.mouse.down();
    await page.mouse.move(box.x + x1, box.y + y1, { steps });
    await page.mouse.up();
  };
  await drawLine(100, 100, 300, 100);
  assert.equal(await strokes(), 1);
  assert.equal(await page.isHidden('#sg-hint'), true);
  assert.equal(await page.isEnabled('#sg-png'), true);

  // Ink spans 200 + 4 (round caps) by 4 px, plus 12 px padding each side: 228 x 28 at 1x.
  assert.match(await page.textContent('#sg-info'), /PNG: 45[5-7] × 5[5-7] px/);
  let png = await download('#sg-png');
  assert.equal(png.name, 'signature.png');
  let size = pngSize(png.buf, assert);
  assert.ok(Math.abs(size.width - 456) <= 2 && Math.abs(size.height - 56) <= 2, `2x PNG is ~456x56, got ${size.width}x${size.height}`);
  assert.equal(size.colorType, 6, 'RGBA PNG');
  let a = await analyse(png.buf);
  for (const c of a.corners) assert.equal(c[3], 0, 'transparent background');
  assert.deepEqual(a.centre.slice(0, 3), [0, 0, 0], 'black ink');
  assert.equal(a.centre[3], 255);
  // Ink sits inside the 24 px (2x) padding and fills the width.
  assert.ok(a.minX >= 22 && a.minX <= 27 && a.maxX >= size.width - 28 && a.maxX <= size.width - 23, `ink x-extent ${a.minX}..${a.maxX}`);
  assert.ok(Math.abs((a.maxY - a.minY + 1) - 8) <= 2, `ink is 8 px tall at 2x, got ${a.maxY - a.minY + 1}`);

  let svg = (await download('#sg-svg')).buf.toString('utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  assert.ok(Math.abs(vb[1] - 228) <= 1 && Math.abs(vb[2] - 28) <= 1, `SVG viewBox ~228x28, got ${vb[1]}x${vb[2]}`);
  assert.match(svg, /<path stroke-width="4" d="M[\d. ]+[QL]/);
  assert.match(svg, /stroke="#000000"/);
  assert.doesNotMatch(svg, /<rect/);

  // Blue ink recolours the whole signature.
  await page.check('input[name="sg-ink"][value="#1a47b8"]');
  svg = (await download('#sg-svg')).buf.toString('utf8');
  assert.match(svg, /stroke="#1a47b8"/);
  await page.selectOption('#sg-scale', '1');
  png = await download('#sg-png');
  size = pngSize(png.buf, assert);
  assert.ok(Math.abs(size.width - 228) <= 1 && Math.abs(size.height - 28) <= 1, `1x PNG ~228x28, got ${size.width}x${size.height}`);
  a = await analyse(png.buf);
  assert.deepEqual(a.centre, [0x1a, 0x47, 0xb8, 255], 'blue ink');

  // A click makes a dot; undo, clear and undo-after-clear.
  await page.mouse.click(box.x + 150, box.y + 150);
  assert.equal(await strokes(), 2);
  svg = (await download('#sg-svg')).buf.toString('utf8');
  assert.match(svg, /<circle cx="[\d.]+" cy="[\d.]+" r="2"\/>/);
  await page.click('#sg-undo');
  assert.equal(await strokes(), 1);
  await page.click('#sg-clear');
  assert.equal(await strokes(), 0);
  assert.equal(await page.isDisabled('#sg-png'), true);
  assert.equal(await page.isVisible('#sg-hint'), true);
  await page.click('#sg-undo');
  assert.equal(await strokes(), 1, 'undo restores a cleared signature');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  assert.equal(await strokes(), 0, 'Ctrl+Z undoes');
  assert.equal(await page.isDisabled('#sg-undo'), true);

  // Keyboard focus is never dropped to the page when Clear or Undo disables itself (WCAG 2.4.3).
  const focusedId = () => page.evaluate(() => document.activeElement.id);
  await drawLine(60, 60, 260, 120);
  await page.focus('#sg-clear');
  await page.keyboard.press('Enter');
  assert.equal(await strokes(), 0);
  assert.equal(await focusedId(), 'sg-undo', 'after Clear, focus moves to Undo');
  await page.keyboard.press('Enter');
  assert.equal(await strokes(), 1);
  assert.equal(await focusedId(), 'sg-undo', 'Undo keeps focus while there is more to undo');
  await page.keyboard.press('Enter');
  assert.equal(await strokes(), 0);
  assert.equal(await page.isDisabled('#sg-undo'), true);
  assert.equal(await focusedId(), 'sg-width', 'with nothing left to undo, focus moves to the thickness slider');
  // The "Sign here" prompt meets 4.5:1 on the pad (WCAG 1.4.3), and the PNG/SVG table has no empty header.
  for (const colorScheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme });
  const hintContrast = await page.evaluate(() => {
    const rgb = s => s.match(/\d+/g).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const f = lum(rgb(getComputedStyle(document.querySelector('#sg-hint')).color));
    const bg = lum(rgb(getComputedStyle(document.querySelector('#sg-pad')).backgroundColor));
    return (Math.max(f, bg) + 0.05) / (Math.min(f, bg) + 0.05);
  });
  assert.ok(hintContrast >= 4.5, `${colorScheme}: "Sign here" contrast ${hintContrast.toFixed(2)}:1`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  for (const th of await page.locator('.sg-table th').allTextContents()) assert.ok(th.trim(), 'table header cell has text');

  // White background option.
  await drawLine(60, 60, 260, 120);
  await page.check('#sg-white');
  png = await download('#sg-png');
  a = await analyse(png.buf);
  for (const c of a.corners) assert.deepEqual(c, [255, 255, 255, 255], 'white background');
  assert.match((await download('#sg-svg')).buf.toString('utf8'), /<rect width="100%" height="100%" fill="#ffffff"\/>/);
  await page.uncheck('#sg-white');
  await page.click('#sg-clear');

  // Pen pressure changes the width; a second pointer during a stroke is ignored.
  await page.check('#sg-vary');
  await page.evaluate(({ x, y }) => {
    const c = document.querySelector('#sg-canvas');
    const fire = (type, id, kind, px, py, pressure) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: kind, isPrimary: true, clientX: x + px, clientY: y + py,
      pressure, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', 7, 'pen', 40, 60, 0.1);
    fire('pointerdown', 8, 'touch', 200, 150, 0.5);
    for (let i = 1; i <= 30; i++) {
      fire('pointermove', 7, 'pen', 40 + i * 10, 60, 0.1 + 0.9 * i / 30);
      fire('pointermove', 8, 'touch', 200 + i, 150, 0.5);
    }
    fire('pointerup', 7, 'pen', 340, 60, 0);
    fire('pointerup', 8, 'touch', 230, 150, 0);
  }, { x: box.x, y: box.y });
  assert.equal(await strokes(), 1, 'only the first pointer draws');
  svg = (await download('#sg-svg')).buf.toString('utf8');
  const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(widths.length > 3, 'pressure produces several widths');
  const [lo, hi] = [Math.min(...widths), Math.max(...widths)];
  assert.ok(hi > lo * 2.5, `light pressure is thinner than heavy pressure (${lo}..${hi})`);

  // Copy image puts the same PNG on the clipboard.
  await page.selectOption('#sg-scale', '2');
  const info = await page.textContent('#sg-info');
  const [, cw, ch] = /PNG: (\d+) × (\d+) px/.exec(info).map(Number);
  await page.click('#sg-copy');
  await page.waitForFunction(() => document.querySelector('#sg-copy').textContent === 'Copied!');
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const bmp = await createImageBitmap(await items[0].getType('image/png'));
    return { types: items[0].types, w: bmp.width, h: bmp.height };
  });
  assert.ok(clip.types.includes('image/png'), `clipboard types ${clip.types}`);
  assert.deepEqual([clip.w, clip.h], [cw, ch], 'clipboard image matches the PNG export size');
  assert.equal(await page.textContent('#sg-error'), '');

  // Undo pressed in the middle of a stroke drops only the stroke being drawn. Before the fix it undid the
  // previous action as well (here: brought back the cleared signature) and left a ghost history entry.
  await page.click('#sg-clear');
  await page.uncheck('#sg-vary');
  await drawLine(40, 40, 240, 40);
  await drawLine(40, 80, 240, 80);
  await page.click('#sg-clear');
  assert.equal(await strokes(), 0);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.mouse.move(box.x + 40, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 120, { steps: 5 });
  assert.equal(await strokes(), 1);
  await page.keyboard.press('Control+z');
  assert.equal(await strokes(), 0, 'Ctrl+Z mid-stroke removes just that stroke');
  await page.mouse.move(box.x + 240, box.y + 120, { steps: 5 });
  await page.mouse.up();
  assert.equal(await strokes(), 0, 'the rest of the aborted stroke is ignored');
  await page.click('#sg-undo');
  assert.equal(await strokes(), 2, 'the next Undo brings back the cleared signature');

  // Clear tapped with a second finger while the first is still drawing clears that stroke too, and
  // Undo then restores exactly what was there before it.
  const touch = (type, px, py) => page.evaluate(({ type, x, y }) => {
    document.querySelector('#sg-canvas').dispatchEvent(new PointerEvent(type, {
      pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5,
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
    }));
  }, { type, x: box.x + px, y: box.y + py });
  await touch('pointerdown', 40, 150);
  for (let i = 1; i <= 10; i++) await touch('pointermove', 40 + i * 15, 150);
  assert.equal(await strokes(), 3);
  await page.click('#sg-clear');
  assert.equal(await strokes(), 0);
  for (let i = 11; i <= 15; i++) await touch('pointermove', 40 + i * 15, 150);
  await touch('pointerup', 265, 150);
  assert.equal(await strokes(), 0, 'the cleared stroke does not come back when the finger lifts');
  await page.click('#sg-undo');
  assert.equal(await strokes(), 2, 'Undo restores the two finished strokes');
  await page.click('#sg-undo');
  assert.equal(await strokes(), 1);

  // Narrowing the window (or turning a phone to portrait) shrinks the signature so none of it is hidden.
  await page.click('#sg-clear');
  await drawLine(100, 60, 900, 60);
  const inkX = () => page.evaluate(() => {
    const c = document.querySelector('#sg-canvas');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, t.width, t.height).data;
    let min = Infinity, max = -1;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) { const x = ((i - 3) / 4) % t.width; if (x < min) min = x; if (x > max) max = x; }
    const k = t.width / c.getBoundingClientRect().width;
    return { min: min / k, max: max / k, width: c.getBoundingClientRect().width };
  });
  const wide = await inkX();
  assert.ok(Math.abs(wide.min - 98) <= 3 && Math.abs(wide.max - 902) <= 3, `ink 98..902 before, got ${wide.min}..${wide.max}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#sg-canvas').getBoundingClientRect().width < 400);
  await page.waitForTimeout(200);
  const narrow = await inkX();
  const k = narrow.width / 900;
  assert.ok(narrow.max <= narrow.width && narrow.max >= narrow.width - 4, `ink reaches but stays inside the ${narrow.width} px pad, got max ${narrow.max}`);
  assert.ok(Math.abs(narrow.min - 100 * k) <= 3, `left end scaled to ${100 * k}, got ${narrow.min}`);
  svg = (await download('#sg-svg')).buf.toString('utf8');
  const vbw = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
  assert.ok(Math.abs(vbw - (800 * k + 4 + 24)) <= 1.5, `SVG follows the scaled ink: ${vbw}`);
  await page.setViewportSize({ width: 1280, height: 900 });

  // HiDPI: the backing store follows devicePixelRatio.
  const hi2 = await page.context().browser().newContext({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 2 });
  const p2 = await hi2.newPage();
  await p2.goto(url);
  const dims = await p2.$eval('#sg-canvas', el => [el.width, el.height, el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
  assert.ok(Math.abs(dims[0] - dims[2] * 2) <= 1 && Math.abs(dims[1] - dims[3] * 2) <= 1, `canvas is 2x its CSS size: ${dims}`);
  await hi2.close();
};
