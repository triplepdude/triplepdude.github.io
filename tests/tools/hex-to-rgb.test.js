const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected colours come from tests/fixtures/hex-to-rgb/expected.py (the Python
// library coloraide, which implements CSS Color 4, and the WCAG 2.2 contrast
// formula written out from its definition) or from Chrome's own CSS engine,
// never from this page's code.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await open();
  const text = s => page.locator(s).textContent();
  const out = async () => Object.fromEntries(await page.$$eval('.hx-out tbody tr', trs => trs.filter(t => !t.hidden).map(t => [t.querySelector('th').firstChild.textContent, t.querySelector('td').textContent])));
  const fields = () => page.$$eval('.hx-fs input', is => is.map(i => i.value));
  const typeIn = async v => { await page.fill('#hx-in', v); await page.locator('#hx-in').press('Tab'); };
  const cut2 = r => (Math.floor(r * 100 + 1e-9) / 100).toFixed(2) + ':1';
  const nums = s => (s.match(/-?\d+(\.\d+)?/g) || []).map(Number);

  // ---- The example, #FF5733, as the FAQ describes it. ----
  assert.deepEqual(await out(), {
    'HEX': '#FF5733', 'HEX with alpha': '#FF5733FF', 'RGB': 'rgb(255, 87, 51)', 'HSL': 'hsl(10.6, 100%, 60%)',
    'HWB': 'hwb(10.6 20% 0%)', 'OKLCH': 'oklch(0.68 0.21 33.7)', 'OKLab': 'oklab(0.6804 0.1747 0.1165)',
    'HSV / HSB': 'hsv(10.6, 80%, 100%)', 'CMYK': 'cmyk(0%, 66%, 80%, 0%)', 'ARGB HEX': '#FFFF5733',
    'Decimal': String(0xFF5733), 'Nearest CSS name': 'tomato',
  });
  assert.equal(await text('#hx-cw'), cut2(X['#FF5733'].white));
  assert.equal(await text('#hx-cb'), cut2(X['#FF5733'].black));
  assert.equal(await text('#hx-cw'), '3.15:1');
  assert.equal(await text('#hx-cb'), '6.66:1');
  const faq = (await page.locator('.faq').textContent()).replace(/\s+/g, ' ');
  assert.match(faq, /It is rgb\(255, 87, 51\): FF is 255, 57 is 87 and 33 is 51\. In HSL it is hsl\(10\.6, 100%, 60%\)/);
  assert.match(faq, /Black text on it has a contrast ratio of 6\.66:1 and white text only 3\.15:1\./);
  assert.equal(await text('#hx-cb-v'), 'Passes AA; AAA only for large text.');
  assert.equal(await text('#hx-cw-v'), 'Passes AA only for large text.');
  assert.equal(await text('#hx-best'), 'Black text is easier to read on this colour.');
  assert.deepEqual(await fields(), ['255', '87', '51', '100', '10.6', '100', '60', '0', '66', '80', '0']);
  assert.equal(await page.inputValue('#hx-pick'), '#ff5733');
  // The working, pair by pair, worked out here from the digits.
  const work = () => page.$$eval('#hx-work tr', trs => trs.map(t => [...t.children].map(c => c.textContent)));
  const byHand = hex => hex.match(/../g).map((p, i) => [['Red', 'Green', 'Blue', 'Alpha'][i], p, `${parseInt(p[0], 16)} × 16 + ${parseInt(p[1], 16)}`, parseInt(p, 16)]);
  assert.deepEqual(await work(), byHand('FF5733').map(r => [r[0], r[1], r[2], String(r[3])]));
  assert.equal(await text('#hx-work-note'), '#FF5733 becomes rgb(255, 87, 51).');
  assert.equal(await page.evaluate(() => location.hash), '');

  // ---- Every input in the fixture: the same 8-bit colour as coloraide, the
  // same contrast as the WCAG formula, HSL and OKLCH close to coloraide's. ----
  for (const [input, e] of Object.entries(X)) {
    await typeIn(input);
    const o = await out();
    assert.equal(o['HEX with alpha'], e.hex8, input);
    assert.equal(await text('#hx-cw'), cut2(e.white), input + ' white');
    assert.equal(await text('#hx-cb'), cut2(e.black), input + ' black');
    const h = nums(o.HSL);
    if (e.hsl[1] > 0.5) assert.ok(Math.abs(((h[0] - e.hsl[0] + 540) % 360) - 180) < 0.6, `${input} hue ${o.HSL} vs ${e.hsl}`);
    assert.ok(Math.abs(h[1] - e.hsl[1]) < 0.6 && Math.abs(h[2] - e.hsl[2]) < 0.6, `${input} ${o.HSL} vs ${e.hsl}`);
    const k = nums(o.OKLCH);
    assert.ok(Math.abs(k[0] - e.oklch[0]) < 0.006 && Math.abs(k[1] - e.oklch[1]) < 0.006, `${input} ${o.OKLCH} vs ${e.oklch}`);
    if (e.oklch[1] > 0.02) assert.ok(Math.abs(((k[2] - e.oklch[2] + 540) % 360) - 180) < 0.6, `${input} ${o.OKLCH} vs ${e.oklch}`);
    const c = nums(o.CMYK);
    c.forEach((v, i) => assert.ok(Math.abs(v - e.cmyk[i]) < 0.6, `${input} ${o.CMYK} vs ${e.cmyk}`));
  }
  // An oklch() colour outside sRGB is mapped by lowering its chroma, and the page says so.
  await typeIn('oklch(0.7 0.4 30)');
  assert.equal((await out())['HEX'], '#FF5843');
  assert.match(await text('#hx-read'), /^oklch\(\): lightness 0\.7, chroma 0\.4, hue 30°\. That is outside the sRGB range that HEX can hold, so it is shown with chroma 0\.2\d+, the nearest colour at the same lightness and hue\.$/);
  // An exact half rounds up, as in Chrome: hwb(200 10% 20%) is red 25.5 and green 144.5.
  await typeIn('hwb(200 10% 20%)');
  assert.equal((await out())['HEX'], '#1A91CC');
  assert.equal(await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'hwb(200 10% 20%)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; }), 'rgb(26, 145, 204)');
  // WCAG thresholds are not rounded: #767676 passes AA on white (4.54), #777777 does not (4.47).
  await typeIn('#767676');
  assert.equal(await text('#hx-cw'), '4.54:1');
  assert.equal(await text('#hx-cw-v'), 'Passes AA; AAA only for large text.');
  await typeIn('#777777');
  assert.equal(await text('#hx-cw'), '4.47:1');
  assert.equal(await text('#hx-cw-v'), 'Passes AA only for large text.');
  await typeIn('#FFFFFF');
  assert.equal(await text('#hx-cw-v'), 'Fails, even for large text.');
  assert.equal(await text('#hx-cb-v'), 'Passes AA and AAA.');

  // ---- Chrome's own CSS engine reads every line back as the same colour. ----
  const sample = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 60; i++) sample.push('#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('') + (i % 3 ? '' : Math.floor(rnd() * 256).toString(16).padStart(2, '0')));
  sample.push('#000000', '#FFFFFF', '#808080', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#010203');
  for (const hex of sample) {
    await page.fill('#hx-in', hex);
    const o = await out();
    const chrome = await page.evaluate(snips => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const css = {};
      for (const k of ['HEX with alpha', 'RGB', 'HSL', 'HWB']) {
        el.style.color = '';
        el.style.color = snips[k];
        const m = getComputedStyle(el).color.match(/[\d.]+/g).map(Number);
        css[k] = m.slice(0, 3).map(Math.round).concat([Math.round((m.length > 3 ? m[3] : 1) * 255)]);
      }
      el.remove();
      // oklch() and oklab() stay unconverted in computed styles, so paint them (opaque) on a canvas.
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      for (const k of ['OKLCH', 'OKLab']) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = snips[k].replace(/ \/ [\d.]+\)$/, ')');
        ctx.fillRect(0, 0, 1, 1);
        css[k] = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      }
      return css;
    }, o);
    const want = o['HEX with alpha'].slice(1).match(/../g).map(p => parseInt(p, 16));
    for (const k of ['HEX with alpha', 'RGB', 'HSL', 'HWB']) assert.deepEqual(chrome[k], want, `${hex} ${k} ${o[k]}`);
    for (const k of ['OKLCH', 'OKLab']) assert.ok(chrome[k].every((v, i) => Math.abs(v - want[i]) <= 1), `${hex} ${k} ${o[k]} painted as ${chrome[k]}`);
    // HSV and CMYK are not CSS: convert them back with their own formulas.
    if (want[3] === 255) {
      const [h, s, v] = nums(o['HSV / HSB']);
      const C = v / 100 * s / 100, Xh = C * (1 - Math.abs((h / 60) % 2 - 1)), m = v / 100 - C;
      const seg = [[C, Xh, 0], [Xh, C, 0], [0, C, Xh], [0, Xh, C], [Xh, 0, C], [C, 0, Xh]][Math.floor(h / 60) % 6];
      assert.deepEqual(seg.map(x => Math.round((x + m) * 255)), want.slice(0, 3), `${hex} HSV ${o['HSV / HSB']}`);
      const [cc, mm, yy, kk] = nums(o.CMYK).map(x => x / 100);
      assert.deepEqual([cc, mm, yy].map(x => Math.round(255 * (1 - x) * (1 - kk))), want.slice(0, 3), `${hex} CMYK ${o.CMYK}`);
    }
    assert.equal(o.Decimal, String(parseInt(o.HEX.slice(1), 16)));
    assert.equal(o['ARGB HEX'], '#' + o['HEX with alpha'].slice(7) + o.HEX.slice(1));
  }

  // ---- Short codes, alpha and the order of the 8 digits. ----
  await typeIn('#f53');
  assert.equal(await text('#hx-read'), 'Short HEX #F53, the same as #FF5533.');
  assert.equal((await out())['Short HEX'], '#F53');
  assert.equal(await text('#hx-work-note'), 'The short code #F53 writes each digit once; doubled it is #FF5533, which becomes rgb(255, 85, 51).');
  await typeIn('#FF573380');
  let o = await out();
  assert.equal(o.RGB, 'rgba(255, 87, 51, 0.5)');
  assert.equal(o.HSL, 'hsla(10.6, 100%, 60%, 0.5)');
  assert.equal(o['ARGB HEX'], '#80FF5733');
  assert.equal(o['Short HEX'], undefined);
  // A short code needs every pair doubled, the alpha too: #FF553380 has none, #FF553388 is #F538.
  await typeIn('#FF553380');
  assert.equal((await out())['Short HEX'], undefined);
  await typeIn('#FF553388');
  assert.equal((await out())['Short HEX'], '#F538');
  await typeIn('#FF573380');
  assert.deepEqual((await work())[3], ['Alpha', '80', '8 × 16 + 0', '128 ÷ 255 = 0.5 (50%)']);
  assert.match(await text('#hx-best'), /Contrast is measured with the colour fully opaque/);
  assert.equal((await fields())[3], '50');
  await typeIn('0x80FF5733');
  assert.equal((await out())['HEX with alpha'], '#FF573380');
  assert.equal(await text('#hx-read'), 'Read as 0xAARRGGBB, alpha first as in Android code: alpha 80, colour #FF5733.');
  await typeIn('transparent');
  assert.equal((await out())['HEX with alpha'], '#00000000');
  // Space-separated syntax and lower case.
  await typeIn('#FF573380');
  await page.check('#hx-modern');
  o = await out();
  assert.equal(o.RGB, 'rgb(255 87 51 / 0.5)');
  assert.equal(o.HSL, 'hsl(10.6 100% 60% / 0.5)');
  await page.check('#hx-lower');
  o = await out();
  assert.equal(o.HEX, '#ff5733');
  assert.equal(o['HEX with alpha'], '#ff573380');
  assert.equal(await page.inputValue('#hx-in'), '#FF573380', 'what was typed is kept');
  await page.uncheck('#hx-lower');
  await page.uncheck('#hx-modern');

  // ---- What people paste: CSS declarations, quotes, full-width characters, a degree sign. ----
  for (const [v, hex] of [['color: #ff5733;', '#FF5733'], ['"#FF5733"', '#FF5733'], ['FF5733', '#FF5733'], ['＃ＦＦ５７３３', '#FF5733'],
    ['  #ff5733  ', '#FF5733'], ['255, 87, 51', '#FF5733'], ['255 87 51', '#FF5733'], ['(255,87,51)', '#FF5733'], ['RGB(255,87,51)', '#FF5733'],
    ['rgb(255 87 51 / 50%)', '#FF573380'], ['hsl(11°, 100%, 60%)', '#FF5833'], ['background-color: rgb(100%, 34.1%, 20%) !important;', '#FF5733'],
    ['cmyk(0%, 66%, 80%, 0%)', '#FF5733'], ['device-cmyk(0 0.66 0.8 0)', '#FF5733'],
    // With black ink: 0.8 x 0.7, 0.6 x 0.7 and 0.4 x 0.7 of 255 are 142.8, 107.1 and 71.4.
    ['cmyk(20%, 40%, 60%, 30%)', '#8F6B47'], ['device-cmyk(0.2 0.4 0.6 0.3)', '#8F6B47'], ['hsv(10.6, 80%, 100%)', '#FF5733'], ['hwb(10.6 20% 0%)', '#FF5733'],
    ['REBECCAPURPLE', '#663399'], ['333', '#333333'], ['hsl(10.6 100 60)', '#FF5733'],
    // Custom properties with digits, Sass and Less variables, a line of JSON or a JavaScript object.
    ['--blue-500: #3b82f6;', '#3B82F6'], ['  --color-primary-2:#3B82F6 !important ;', '#3B82F6'], ['$brand-1: #3b82f6;', '#3B82F6'],
    ['@brand: rgb(59 130 246);', '#3B82F6'], ['"primary": "#3b82f6",', '#3B82F6'], ["primary: '#3b82f6',", '#3B82F6'],
    // hwb() with whiteness and blackness adding up to more than 100% is a grey: 60 / (60 + 60) of 255 is 127.5.
    ['hwb(0 60% 60%)', '#808080'], ['hwb(120 80% 40%)', '#AAAAAA'],
    // In oklab() and oklch(), 100% of a, b or chroma is 0.4.
    ['oklab(60% 25% -25%)', X['oklab(0.6 0.1 -0.1)'].hex8.slice(0, 7)], ['oklch(70% 25% 145)', X['oklch(70% 0.1 145)'].hex8.slice(0, 7)],
    ['rgb(none 87 51)', '#005733']]) {
    await typeIn(v);
    assert.equal(await text('#hx-msg'), '', v);
    const o2 = await out();
    assert.equal(hex.length === 9 ? o2['HEX with alpha'] : o2.HEX, hex, v);
  }
  assert.equal(await text('#hx-read'), 'rgb(): red 0, green 87, blue 51.');
  await typeIn('255, 87, 51');
  assert.equal(await text('#hx-read'), 'Read as red, green and blue: red 255, green 87, blue 51.');

  // ---- Errors: the box is marked and points at a message that says what is wrong. ----
  for (const [v, msg] of [
    ['#12345', 'A HEX colour has 3, 4, 6 or 8 digits; this one has 5.'],
    ['#GG0000', 'A HEX colour uses only the digits 0–9 and the letters A–F.'],
    ['#', 'Type the digits after the #, such as #FF5733.'],
    ['0x123', 'A 0x colour has 6 digits (0xRRGGBB) or 8 with alpha first (0xAARRGGBB); this one has 3.'],
    ['rgb(300, 0, 0)', 'Red is 300; red, green and blue go from 0 to 255 (or 0% to 100%).'],
    ['rgb(1, 2)', 'rgb() takes 3 numbers, then an optional alpha.'],
    ['rgba(255, 87, 51, 2)', 'The alpha goes from 0 to 1, or 0% to 100%.'],
    ['hsl(10, 120%, 50%)', 'Saturation goes from 0% to 100%.'],
    ['hsl(10px, 50%, 50%)', 'hsl() takes 3 numbers, then an optional alpha.'],
    ['oklch(1.5 0.1 30)', 'The lightness of oklch() goes from 0 to 1, or 0% to 100%.'],
    ['lab(50% 40 59)', 'lab() is not converted here. Use HEX, rgb(), hsl(), hwb(), oklch() or oklab().'],
    ['rgb(from red r g b)', 'Relative colours (with from) are not converted here. Use HEX, rgb(), hsl(), hwb(), oklch() or oklab().'],
    ['tomatoes', 'Not a colour code or a CSS colour name. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.'],
    ['constructor', 'Not a colour code or a CSS colour name. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.'],
    ['__proto__', 'Not a colour code or a CSS colour name. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.'],
    ['color: hasOwnProperty', 'Not a colour code or a CSS colour name. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.'],
    ['5², 3, 4', 'Red, green and blue must be numbers from 0 to 255, or percentages. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.'],
    ['255, 87', 'Three numbers are read as red, green and blue; this has 2. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.'],
    ['x'.repeat(101), 'That is too long for a colour code (100 characters at most).'],
  ]) {
    await typeIn(v);
    assert.equal(await text('#hx-msg'), msg, v);
    assert.equal(await page.getAttribute('#hx-in', 'aria-invalid'), 'true', v);
    assert.equal((await out()).HEX, '–', v);
  }
  assert.deepEqual((await page.getAttribute('#hx-in', 'aria-describedby')).split(' '), ['hx-msg', 'hx-read']);
  assert.equal(await page.locator('#hx-msg').evaluate(e => e.classList.contains('error')), true);
  assert.equal(await page.isDisabled('.hx-out button[data-copy-target="#hx-o-rgb"]'), true);
  assert.equal(await page.isDisabled('#hx-copy-all'), true);
  // An empty box is a prompt, not an error.
  await typeIn('');
  assert.equal(await text('#hx-msg'), '');
  assert.equal(await page.getAttribute('#hx-in', 'aria-invalid'), null);
  assert.equal(await text('#hx-read'), 'Type or paste a colour to convert it.');
  // The red edge comes only after a pause or on leaving the box, not while typing.
  await page.locator('#hx-in').pressSequentially('#12', { delay: 10 });
  assert.equal(await page.getAttribute('#hx-in', 'aria-invalid'), null);
  await page.waitForFunction(() => document.querySelector('#hx-in').getAttribute('aria-invalid') === 'true', null, { timeout: 3000 });
  await page.locator('#hx-in').pressSequentially('3', { delay: 10 });
  assert.equal(await page.getAttribute('#hx-in', 'aria-invalid'), null);
  assert.equal((await out()).HEX, '#112233');

  // ---- The R, G, B, H, S, L and C, M, Y, K boxes convert the other way. ----
  await typeIn('#FF5733');
  const fill = async (sel, v) => { await page.fill(sel, v); await page.locator(sel).press('Tab'); };
  await fill('#hx-r', '0'); await fill('#hx-g', '128'); await fill('#hx-b', '255');
  assert.equal(await page.inputValue('#hx-in'), '#0080FF');
  // Magenta 50% gives 127.5, which rounds to the 128 of #0080FF, so 50 is enough.
  assert.deepEqual((await fields()).slice(4), ['210', '100', '50', '100', '50', '0', '0']);
  assert.equal(await page.inputValue('#hx-pick'), '#0080ff');
  await fill('#hx-a', '50');
  assert.equal(await page.inputValue('#hx-in'), '#0080FF80');
  await fill('#hx-a', '100');
  await fill('#hx-h', '120'); await fill('#hx-s', '100'); await fill('#hx-l', '25');
  assert.equal(await page.inputValue('#hx-in'), '#008000');
  assert.equal((await out())['CSS name'], 'green');
  await fill('#hx-c', '20'); await fill('#hx-m', '40'); await fill('#hx-y', '60'); await fill('#hx-k', '30');
  assert.equal(await page.inputValue('#hx-in'), '#8F6B47');
  await fill('#hx-c', '0'); await fill('#hx-m', '100'); await fill('#hx-y', '100'); await fill('#hx-k', '0');
  assert.equal(await page.inputValue('#hx-in'), '#FF0000');
  assert.deepEqual((await fields()).slice(0, 7), ['255', '0', '0', '100', '0', '100', '50']);
  // A decimal comma, a % or ° sign and Arabic-Indic digits are read; 5², a tab or 1e2 are not.
  // hsl(0, 50.5%, 50%): 0.5 ± 0.2525 gives 191.89 and 63.11, so #C03F3F.
  await fill('#hx-s', '50,5');
  assert.equal(await page.getAttribute('#hx-s', 'aria-invalid'), null);
  assert.equal(await page.inputValue('#hx-in'), '#C03F3F');
  await fill('#hx-h', '240°');
  assert.equal(await page.inputValue('#hx-in'), '#3F3FC0');
  await fill('#hx-r', '١٢٨');
  assert.equal(await page.inputValue('#hx-in'), '#803FC0');
  for (const [sel, v, msgSel, msg] of [
    ['#hx-r', '300', '#hx-rgb-msg', 'Red must be a number from 0 to 255.'],
    ['#hx-g', '5²', '#hx-rgb-msg', 'Green must be a number from 0 to 255.'],
    ['#hx-b', '3\t4', '#hx-rgb-msg', 'Blue must be a number from 0 to 255.'],
    ['#hx-a', '150', '#hx-rgb-msg', 'Alpha must be a number from 0 to 100 (%).'],
    ['#hx-h', 'abc', '#hx-hsl-msg', 'Enter the hue in degrees, such as 11.'],
    ['#hx-l', '1e2', '#hx-hsl-msg', 'Lightness must be a number from 0 to 100 (%).'],
    ['#hx-k', '-5', '#hx-cmyk-msg', 'Black must be a number from 0 to 100 (%).'],
  ]) {
    const before = await page.inputValue(sel);
    await fill(sel, v);
    assert.equal(await text(msgSel), msg, sel + ' ' + v);
    assert.equal(await page.getAttribute(sel, 'aria-invalid'), 'true', sel);
    assert.equal(await page.getAttribute(sel, 'aria-describedby'), msgSel.slice(1), sel);
    assert.equal((await out()).HEX, '–', sel);
    await fill(sel, before);
    assert.equal(await page.getAttribute(sel, 'aria-invalid'), null, sel);
    assert.equal(await text(msgSel), '', sel);
  }
  // Two wrong boxes, the alpha and then the hue: the hue's message shows in the HSL group it belongs to.
  await fill('#hx-a', '150');
  assert.equal(await text('#hx-rgb-msg'), 'Alpha must be a number from 0 to 100 (%).');
  await fill('#hx-h', 'abc');
  assert.equal(await text('#hx-hsl-msg'), 'Enter the hue in degrees, such as 11.');
  assert.equal(await text('#hx-rgb-msg'), '');
  assert.equal(await page.getAttribute('#hx-h', 'aria-invalid'), 'true');
  await fill('#hx-a', '100');
  assert.equal(await page.inputValue('#hx-in'), '#803FC0');
  // An error in one group goes away once another box sets the colour.
  await fill('#hx-h', 'abc');
  await typeIn('#123456');
  assert.equal(await page.getAttribute('#hx-h', 'aria-invalid'), null);
  assert.equal(await text('#hx-hsl-msg'), '');
  assert.equal(await page.inputValue('#hx-h'), '210');
  // The colour picker.
  await page.evaluate(() => { const p = document.querySelector('#hx-pick'); p.value = '#00ff7f'; p.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.inputValue('#hx-in'), '#00FF7F');
  assert.equal((await out())['CSS name'], 'springgreen');

  // ---- A megabyte pasted into any box is refused at once. ----
  const paste = big => page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel), t0 = performance.now();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return performance.now() - t0;
  }, big);
  assert.ok(await paste(['#hx-in', '#'.repeat(1e6)]) < 300);
  assert.equal(await text('#hx-msg'), 'That is too long for a colour code (100 characters at most).');
  assert.ok(await paste(['#hx-in', ' '.repeat(1e6) + 'x']) < 300);
  assert.equal(await text('#hx-msg'), 'That is too long for a colour code (100 characters at most).');
  for (const sel of ['#hx-in', '#hx-r', '#hx-h', '#hx-k', '#hx-a', '#hx-filter']) {
    const ms = await page.evaluate(sel => {
      const el = document.querySelector(sel), t0 = performance.now();
      el.value = '9'.repeat(1e6) + ' ' + '('.repeat(1e5);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return performance.now() - t0;
    }, sel);
    assert.ok(ms < 300, `${sel} took ${Math.round(ms)} ms`);
  }
  // The Red box still holds its megabyte, so it is the one reported.
  assert.equal(await text('#hx-rgb-msg'), 'Red must be a number from 0 to 255.');
  // The filter sits in the closed list of names, so it is emptied the same way.
  await page.evaluate(() => { const f = document.querySelector('#hx-filter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });

  // ---- Copy one line, or all of them. ----
  await typeIn('#FF5733');
  await page.click('.hx-out button[data-copy-target="#hx-o-hsl"]');
  await page.waitForFunction(() => document.querySelector('.hx-out button[data-copy-target="#hx-o-hsl"]').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'hsl(10.6, 100%, 60%)');
  assert.equal(await page.getAttribute('.hx-out button[data-copy-target="#hx-o-rgb"]', 'aria-label'), 'Copy RGB');
  await page.fill('#hx-in', '#663399');
  await page.click('#hx-copy-all');
  await page.waitForFunction(() => document.querySelector('#hx-copy-all').textContent === 'Copied!');
  const all = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
  assert.equal(all[0], 'HEX: #663399');
  assert.ok(all.includes('RGB: rgb(102, 51, 153)'), all.join(' | '));
  assert.ok(all.includes('HSL: hsl(270, 50%, 40%)'), all.join(' | '));
  assert.equal(all[all.length - 1], 'CSS name: rebeccapurple');
  // #663399 also has a short form, #639, so 13 lines.
  assert.ok(all.includes('Short HEX: #639'), all.join(' | '));
  assert.equal(all.length, 13);

  // ---- The page address keeps the colour: typed text as typed, a HEX without its #. ----
  await page.fill('#hx-in', 'hsl(11 100% 60%)');
  await page.waitForFunction(() => location.hash === '#hsl(11%20100%25%2060%25)');
  await page.reload();
  assert.equal(await page.inputValue('#hx-in'), 'hsl(11 100% 60%)');
  assert.equal((await out()).HEX, '#FF5833');
  await page.fill('#hx-r', '18');
  await page.waitForFunction(() => location.hash === '#125833');
  await page.goto(url + '#0B0');
  assert.equal(await page.inputValue('#hx-in'), '#0B0');
  assert.equal((await out()).HEX, '#00BB00');
  // Editing the address loads the new colour; a link too long to be a colour is not read.
  await page.evaluate(() => { location.hash = '#rebeccapurple'; });
  await page.waitForFunction(() => document.querySelector('#hx-in').value === 'rebeccapurple');
  assert.equal((await out())['CSS name'], 'rebeccapurple');
  await page.goto('about:blank');
  await page.goto(url + '#constructor');
  assert.equal(await page.inputValue('#hx-in'), 'constructor');
  assert.equal(await text('#hx-msg'), 'Not a colour code or a CSS colour name. Try #FF5733, rgb(255, 87, 51), hsl(11, 100%, 60%) or tomato.');
  assert.equal((await out()).HEX, '–');
  await page.goto('about:blank');
  await page.goto(url + '#' + 'a'.repeat(101));
  assert.equal(await text('#hx-note'), 'The colour in the page address is longer than 100 characters, so it was not read.');
  assert.equal(await page.inputValue('#hx-in'), '#FF5733');
  // Back from another page shows results for what the box holds.
  await page.fill('#hx-in', '#ABCDEF');
  await page.waitForFunction(() => location.hash === '#ABCDEF');
  await page.goto(url.replace(/hex-to-rgb\/$/, ''));
  await page.goBack();
  await page.waitForSelector('#hx-in');
  assert.equal(await page.inputValue('#hx-in'), '#ABCDEF');
  assert.equal((await out()).RGB, 'rgb(171, 205, 239)');

  // ---- The 148 named colours: Chrome agrees with every one, and one tap loads it. ----
  await page.click('#hx-names > summary');
  const rows = await page.$$eval('#hx-n-body tr', trs => trs.map(t => [t.querySelector('button').textContent, t.querySelector('.hx-code').textContent]));
  assert.equal(rows.length, 148);
  const chrome = await page.evaluate(names => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const res = names.map(n => { el.style.color = n; return getComputedStyle(el).color; });
    el.remove();
    return res;
  }, rows.map(r => r[0]));
  rows.forEach(([name, code], i) => {
    const rgb = code.match(/rgb\((\d+), (\d+), (\d+)\)/).slice(1).map(Number);
    assert.equal(chrome[i], `rgb(${rgb.join(', ')})`, name);
    assert.equal(code.slice(0, 7), '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(), name);
  });
  await page.fill('#hx-filter', 'blue');
  assert.equal(await page.locator('#hx-n-body tr').count(), rows.filter(r => r[0].includes('blue')).length);
  assert.equal(await text('#hx-n-count'), `${rows.filter(r => r[0].includes('blue')).length} of 148 names match.`);
  await page.fill('#hx-filter', '#663399');
  assert.equal(await page.locator('#hx-n-body tr').count(), 1);
  await page.click('#hx-n-body button');
  assert.equal(await page.inputValue('#hx-in'), 'rebeccapurple');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'hx-in');
  assert.equal((await out()).HEX, '#663399');
  await page.fill('#hx-filter', '');

  // ---- One short summary is announced after typing pauses, only when it changes. ----
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__changes = 0;
    new MutationObserver(() => window.__changes++).observe(document.querySelector('#hx-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#hx-in', '');
  await page.locator('#hx-in').pressSequentially('#00ff7f', { delay: 30 });
  await page.waitForFunction(() => document.querySelector('#hx-status').textContent === '#00FF7F is rgb(0, 255, 127).', null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__changes), 1);
  await page.check('#hx-lower');
  await page.uncheck('#hx-lower');
  await page.waitForTimeout(1300);
  assert.equal(await page.evaluate(() => window.__changes), 1);
  // A transparent colour is announced with its alpha, not as the opaque HEX.
  await page.fill('#hx-in', '#00ff7f80');
  await page.waitForFunction(() => document.querySelector('#hx-status').textContent === '#00FF7F80 is rgba(0, 255, 127, 0.5).', null, { timeout: 4000 });
  await page.fill('#hx-in', '#00ff7f');

  // ---- Keyboard: from the colour box to the boxes and a copy button. ----
  await page.focus('#hx-in');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'hx-pick');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'hx-r');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('10');
  assert.equal(await page.inputValue('#hx-in'), '#0AFF7F');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
  await page.focus('.hx-out button[data-copy-target="#hx-o-hex"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.hx-out button[data-copy-target="#hx-o-hex"]').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '#0AFF7F');

  // The guide promises a round trip only for the lines the converter reads back. Each of
  // them, pasted in again, gives the same colour; ARGB, Decimal and a nearest name do not.
  const guide = (await page.locator('.prose').textContent()).replace(/\s+/g, ' ');
  assert.doesNotMatch(guide, /Every line of the result/);
  assert.match(guide, /The HEX, RGB, HSL, HWB, OKLCH and OKLab lines convert back to exactly the same colour when you paste them in again; so do HSV and CMYK, which leave out the alpha\./);
  await typeIn('#FF573380');
  const lines = await out();
  for (const k of ['HEX with alpha', 'RGB', 'HSL', 'HWB', 'OKLCH', 'OKLab']) {
    await typeIn(lines[k]);
    assert.equal((await out())['HEX with alpha'], '#FF573380', `${k} ${lines[k]}`);
  }
  await typeIn('#FF5733');
  const opaque = await out();
  for (const k of ['HSV / HSB', 'CMYK', 'Short HEX', 'HEX'].filter(k => opaque[k])) {
    await typeIn(opaque[k]);
    assert.equal((await out()).HEX, '#FF5733', `${k} ${opaque[k]}`);
  }
  // Guide links go to pages of this site that exist.
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/binary-translator/', '/image-color-picker/']);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), href);

  // ---- A locale that writes decimals with a comma reads the same way. ----
  const de = await page.context().browser().newContext({ locale: 'de-DE' });
  try {
    const p2 = await de.newPage();
    await p2.goto(url);
    await p2.fill('#hx-in', 'rgb(255, 87, 51)');
    assert.equal(await p2.textContent('#hx-o-hex'), '#FF5733');
    await p2.fill('#hx-s', '50,5');
    await p2.fill('#hx-h', '0');
    await p2.fill('#hx-l', '50');
    assert.equal(await p2.inputValue('#hx-in'), '#C03F3F');
    await p2.fill('#hx-r', '\uFEFF128');
    assert.equal(await p2.inputValue('#hx-in'), '#803F3F');
  } finally {
    await de.close();
  }

  // ---- A phone with a touch screen: big enough targets and text, nothing cut off. ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  try {
    const p3 = await phone.newPage();
    await p3.goto(url);
    await p3.locator('#hx-in').tap();
    await p3.fill('#hx-in', '');
    await p3.keyboard.type('#1E90FF');
    assert.equal(await p3.textContent('#hx-o-name'), 'dodgerblue');
    await p3.locator('#hx-names > summary').tap();
    await p3.locator('#hx-n-body button', { hasText: /^tomato$/ }).tap();
    assert.equal(await p3.textContent('#hx-o-hex'), '#FF6347');
    assert.notEqual(await p3.evaluate(() => document.activeElement.id), 'hx-in');
    // The page scrolls smoothly unless the visitor asks for reduced motion, so wait for it.
    await p3.waitForFunction(() => { const r = document.querySelector('#hx-sw').getBoundingClientRect(); return r.top > -1 && r.bottom < innerHeight + 1; }, null, { timeout: 5000 });
    for (const w of [320, 390]) {
      await p3.setViewportSize({ width: w, height: 800 });
      const probs = await p3.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.tool-card input:not([type=checkbox]), .tool-card button, .tool-card summary')) {
          if (!el.getClientRects().length) continue;
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          if (r.height < 43.5) out.push(`${el.id || el.textContent} is ${r.height}px tall`);
          if (el.tagName === 'INPUT' && el.type !== 'color' && parseFloat(cs.fontSize) < 16) out.push(`${el.id} text is ${cs.fontSize}`);
          if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1) out.push(`button ${el.textContent} is cut off`);
          if (r.right > document.documentElement.clientWidth + 1 && !el.closest('.table-wrap')) out.push(`${el.id || el.textContent} sticks out`);
        }
        for (const l of document.querySelectorAll('.hx-fs label')) if (l.scrollWidth > l.clientWidth + 1) out.push(`label ${l.textContent} is cut off`);
        for (const b of document.querySelectorAll('#hx-n-body button')) {
          const r = document.createRange();
          r.selectNodeContents(b);
          if (new Set([...r.getClientRects()].map(x => Math.round(x.top))).size > 1) out.push(`name ${b.textContent} is broken over two lines`);
        }
        return out;
      });
      assert.deepEqual(probs, [], `at ${w}px`);
    }
  } finally {
    await phone.close();
  }
};
