const fs = require('fs');

// Expected module patterns below were produced independently with the
// python-barcode package (0.16.1), not with this tool.
const EXPECTED = {
  ean13_4006381333931: '10100011010100111010111101111010001001011001101010100001010000101000010111010010000101100110101',
  upca_036000291452: '10100011010111101010111100011010001101000110101010110110011101001100110101110010011101101100101',
  ean8_96385074: '1010001011010111101111010110111010101001110111001010001001011100101',
  // ITF-14 15400141288763 with a 3:1 wide-to-narrow ratio.
  itf14_15400141288763: '101011100010100010111010101110001000111010001011101110100010001011101011100010001110101000111011101010111000100010001110001110101011101',
  // Code 39 "*CODE-39*" (3:1) with and without the mod 43 check character "P".
  code39_plain: '10001011101110101110111010001010111010111010001010101110001011101110101110001010100010101110111011101110001010101011100010111010100010111011101',
  code39_check: '100010111011101011101110100010101110101110100010101011100010111011101011100010101000101011101110111011100010101010111000101110101011101110100010100010111011101',
  // Code 128: "Wikipedia" (all set B) and "1234567890" (all set C) have a single optimal encoding.
  code128_wikipedia: '11010010000111010001101000011010011000010010100001101001010011110010110010000100001001101000011010010010110000111100100101100011101011',
  code128_digits: '110100111001011001110010001011000111000101101100001010011011110110100111100101100011101011',
};

// EAN-13 for every leading digit, so all ten odd/even parity patterns are covered
// (python-barcode, from the 12-digit input; the check digit is the last digit).
const EAN13_ALL = {
  '0123456789012': '10100110010010011011110101000110110001010111101010100010010010001110100111001011001101101100101',
  '1234567890128': '10100100110111101001110101100010000101001000101010100100011101001110010110011011011001001000101',
  '2345678901234': '10101111010100011011100100001010111011000100101010111010011100101100110110110010000101011100101',
  '3456789012340': '10101000110110001000010100100010001001000101101010111001011001101101100100001010111001110010101',
  '4567890123456': '10101100010000101011101101101110010111010011101010110011011011001000010101110010011101010000101',
  '5678901234562': '10101011110010001000100100010110001101011001101010110110010000101011100100111010100001101100101',
  '6789012345678': '10101110110001001001011101001110011001001001101010100001010111001001110101000010001001001000101',
  '7890123456784': '10101101110010111000110101100110010011010000101010101110010011101010000100010010010001011100101',
  '8901234567890': '10100010110100111001100100110110100001010001101010100111010100001000100100100011101001110010101',
  '9780306406157': '10101110110001001010011101111010100111010111101010101110011100101010000110011010011101000100101',
};

// Code 128 symbol patterns 0-105 (ISO/IEC 15417), for decoding in the test.
const C128 = ('11011001100 11001101100 11001100110 10010011000 10010001100 10001001100 10011001000 10011000100 10001100100 11001001000 11001000100 11000100100 10110011100 10011011100 10011001110 10111001100 10011101100 10011100110 11001110010 11001011100 11001001110 11011100100 11001110100 11101101110 11101001100 11100101100 11100100110 11101100100 11100110100 11100110010 11011011000 11011000110 11000110110 10100011000 10001011000 10001000110 10110001000 10001101000 10001100010 11010001000 11000101000 11000100010 10110111000 10110001110 10001101110 10111011000 10111000110 10001110110 11101110110 11010001110 11000101110 11011101000 11011100010 11011101110 11101011000 11101000110 11100010110 11101101000 11101100010 11100011010 11101111010 11001000010 11110001010 10100110000 10100001100 10010110000 10010000110 10000101100 10000100110 10110010000 10110000100 10011010000 10011000010 10000110100 10000110010 11000010010 11001010000 11110111010 11000010100 10001111010 10100111100 10010111100 10010011110 10111100100 10011110100 10011110010 11110100100 11110010100 11110010010 11011011110 11011110110 11110110110 10101111000 10100011110 10001011110 10111101000 10111100010 11110101000 11110100010 10111011110 10111101110 11101011110 11110101110 11010000100 11010010000 11010011100').split(' ');
const C128_STOP = '1100011101011';

// Decodes a Code 128 module string: returns { text, symbols } and checks the mod 103 checksum.
function decode128(bits, assert) {
  assert.ok(bits.endsWith(C128_STOP), 'ends with the stop pattern');
  const body = bits.slice(0, -13);
  assert.equal(body.length % 11, 0, 'whole number of symbols');
  const vals = [];
  for (let i = 0; i < body.length; i += 11) {
    const v = C128.indexOf(body.slice(i, i + 11));
    assert.ok(v >= 0, `valid symbol at module ${i}`);
    vals.push(v);
  }
  const check = vals.pop();
  assert.equal(vals.reduce((s, v, i) => s + (i === 0 ? v : i * v), 0) % 103, check, 'mod 103 checksum');
  let set = { 103: 'A', 104: 'B', 105: 'C' }[vals[0]];
  assert.ok(set, 'start code');
  let text = '';
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i];
    if (set === 'C') {
      if (v < 100) text += String(v).padStart(2, '0');
      else set = v === 100 ? 'B' : 'A';
    } else if (v === 99) set = 'C';
    else if (v === 98) { i++; const w = vals[i]; text += set === 'A' ? String.fromCharCode(w + 32) : String.fromCharCode(w < 64 ? w + 32 : w - 64); }
    else if (set === 'A' && v === 100) set = 'B';
    else if (set === 'B' && v === 101) set = 'A';
    else if (set === 'A') text += String.fromCharCode(v < 64 ? v + 32 : v - 64);
    else text += String.fromCharCode(v + 32);
  }
  return { text, symbols: vals.length + 1 };
}

module.exports = async ({ page, open, assert }) => {
  await open();
  const text = sel => page.textContent(sel);
  // Reads the preview SVG bars back into a module string ('1' = bar).
  const modules = () => page.evaluate(() => {
    const svg = document.querySelector('#bc-preview svg');
    const X = Number(svg.getAttribute('data-module')), q = Number(svg.getAttribute('data-quiet'));
    const bits = [];
    for (const r of svg.querySelectorAll('g.bc-bars rect')) {
      const s = (Number(r.getAttribute('x')) - q) / X, w = Number(r.getAttribute('width')) / X;
      if (s !== Math.round(s) || w !== Math.round(w)) return 'misaligned bar at ' + s;
      for (let k = s; k < s + w; k++) bits[k] = '1';
    }
    return Array.from(bits, b => b || '0').join('');
  });
  const setData = v => page.fill('#bc-data', v);
  const download = async sel => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };

  // Default: Code 128 renders immediately and decodes back to the input.
  assert.equal(await page.inputValue('#bc-data'), 'SKU-10492-B');
  let d = decode128(await modules(), assert);
  assert.equal(d.text, 'SKU-10492-B');
  assert.equal(await page.isEnabled('#bc-svg'), true);

  // Code 128 known answers and code-set optimisation.
  await setData('Wikipedia');
  assert.equal(await modules(), EXPECTED.code128_wikipedia);
  await setData('1234567890');
  assert.equal(await modules(), EXPECTED.code128_digits);
  assert.equal(await text('#bc-sets'), 'C');
  // Letters then a long digit run: switches to set C, 1 start + 3 + 1 switch + 5 pairs + check.
  await setData('ABC1234567890');
  d = decode128(await modules(), assert);
  assert.equal(d.text, 'ABC1234567890');
  assert.equal(d.symbols, 11);
  assert.match(await text('#bc-sets'), /→ C$/);
  // Control characters use set A; lowercase needs set B.
  await setData('ab\tcd');
  d = decode128(await modules(), assert);
  assert.equal(d.text, 'ab\tcd');
  await setData('Prix 5€');
  assert.match(await text('#bc-error'), /ASCII characters only. Remove: €/);
  assert.equal(await page.isDisabled('#bc-png'), true);

  // EAN-13: check digit calculated (400638133393 -> 4006381333931) and bar pattern.
  await page.selectOption('#bc-type', 'ean13');
  await setData('400638133393');
  assert.equal(await text('#bc-encoded'), '4006381333931');
  assert.equal(await text('#bc-check'), '1 (added)');
  assert.equal(await modules(), EXPECTED.ean13_4006381333931);
  for (const [full, bits] of Object.entries(EAN13_ALL)) {
    await setData(full.slice(0, 12));
    assert.equal(await text('#bc-encoded'), full, `check digit for ${full.slice(0, 12)}`);
    assert.equal(await modules(), bits, `bars for ${full}`);
  }
  await setData('400638133393');
  // Guard bars extend below the others when the text is shown.
  const heights = await page.$$eval('#bc-preview g.bc-bars rect', rs => rs.map(r => Number(r.getAttribute('height'))));
  assert.equal(new Set(heights).size, 2);
  assert.equal(heights.filter(h => h === Math.max(...heights)).length, 6, 'three guard patterns = 6 long bars');
  // Human-readable digits: 1 outside + 6 + 6.
  assert.deepEqual(await page.$$eval('#bc-preview text', ts => ts.map(t => t.textContent).join('')), '4006381333931');
  // Full number verifies; a wrong check digit is reported with the fix.
  await setData('4006381333931');
  assert.equal(await text('#bc-check'), '1 (verified)');
  await setData('4006381333932');
  assert.match(await text('#bc-error'), /check digit should be 1, not 2\. The correct EAN-13 is 4006381333931/);
  assert.equal(await page.getAttribute('#bc-data', 'aria-invalid'), 'true');
  assert.equal(await page.locator('#bc-preview svg').count(), 0);
  await page.click('#bc-fix');
  assert.equal(await page.inputValue('#bc-data'), '4006381333931');
  assert.equal(await text('#bc-error'), '');
  assert.equal(await page.getAttribute('#bc-data', 'aria-invalid'), 'false');
  await setData('40063813339');
  assert.match(await text('#bc-error'), /needs 12 digits .* or 13 digits\. You entered 11/);
  await setData('4006381A3393');
  assert.match(await text('#bc-error'), /digits only\. Remove: A/);
  await setData('400-638 133393');
  assert.equal(await text('#bc-encoded'), '4006381333931', 'spaces and hyphens are ignored');

  // SVG download is the same drawing; PNG pixels reproduce the module pattern.
  const svg = await download('#bc-svg');
  assert.equal(svg.name, 'barcode-ean13-4006381333931.svg');
  const svgText = svg.buf.toString('utf8');
  assert.match(svgText, /^<\?xml[^>]*>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)"/);
  assert.equal((svgText.match(/<rect x=/g) || []).length, heights.length);
  const [w, h] = (await text('#bc-size')).split(' × ').map(Number);
  const png = await download('#bc-png');
  assert.equal(png.buf.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.buf.readUInt32BE(16), w);
  assert.equal(png.buf.readUInt32BE(20), h);
  const row = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    const svg = document.querySelector('#bc-preview svg');
    const X = Number(svg.getAttribute('data-module')), q = Number(svg.getAttribute('data-quiet'));
    const y = Number(svg.querySelector('g.bc-bars rect').getAttribute('y')) + 10;
    const d = x.getImageData(0, y, c.width, 1).data;
    let bits = '';
    for (let m = 0; m < 95; m++) bits += d[(q + m * X + Math.floor(X / 2)) * 4] < 128 ? '1' : '0';
    return { bits, left: d[0], right: d[(c.width - 1) * 4] };
  }, png.buf.toString('base64'));
  assert.equal(row.bits, EXPECTED.ean13_4006381333931);
  assert.equal(row.left, 255, 'white quiet zone');
  // 2x PNG doubles the pixel size.
  await page.selectOption('#bc-scale', '2');
  const png2 = await download('#bc-png');
  assert.equal(png2.buf.readUInt32BE(16), 2 * w);
  await page.selectOption('#bc-scale', '1');

  // UPC-A: 03600029145 -> 036000291452.
  await page.selectOption('#bc-type', 'upca');
  await setData('03600029145');
  assert.equal(await text('#bc-encoded'), '036000291452');
  assert.equal(await modules(), EXPECTED.upca_036000291452);
  await setData('036000291453');
  assert.match(await text('#bc-error'), /should be 2, not 3/);

  // EAN-8: 9638507 -> 96385074.
  await page.selectOption('#bc-type', 'ean8');
  await setData('9638507');
  assert.equal(await text('#bc-encoded'), '96385074');
  assert.equal(await modules(), EXPECTED.ean8_96385074);

  // ITF-14: 1540014128876 -> 15400141288763, with and without the bearer frame.
  await page.selectOption('#bc-type', 'itf14');
  await setData('1540014128876');
  assert.equal(await text('#bc-encoded'), '15400141288763');
  assert.equal(await page.isVisible('#bc-bearer'), true);
  await page.uncheck('#bc-bearer');
  assert.equal(await modules(), EXPECTED.itf14_15400141288763);
  await page.check('#bc-bearer');
  const frameRects = await page.$$eval('#bc-preview g.bc-bars rect', rs => rs.length);
  assert.equal(frameRects, EXPECTED.itf14_15400141288763.match(/1+/g).length + 4);

  // Code 39: lowercase converted, optional mod 43 check, invalid characters.
  await page.selectOption('#bc-type', 'code39');
  await setData('code-39');
  assert.equal(await text('#bc-encoded'), 'CODE-39');
  assert.match(await text('#bc-warn'), /converted to capitals/);
  assert.equal(await modules(), EXPECTED.code39_plain);
  await page.check('#bc-c39check');
  assert.equal(await text('#bc-encoded'), 'CODE-39P');
  assert.equal(await modules(), EXPECTED.code39_check);
  await setData('A@B');
  assert.match(await text('#bc-error'), /Code 39 cannot encode: @/);
  await page.uncheck('#bc-c39check');

  // Switching type swaps in that type's example when the box holds the old example.
  await page.selectOption('#bc-type', 'itf14');
  await page.selectOption('#bc-type', 'ean13');
  await setData('');
  await page.selectOption('#bc-type', 'ean8');
  assert.equal(await page.inputValue('#bc-data'), '9638507');

  // Options: bar width scales the drawing, colours apply, text can be hidden.
  await page.selectOption('#bc-width', '3');
  assert.equal(await modules(), EXPECTED.ean8_96385074);
  await page.fill('#bc-fg-hex', '#1a237e');
  assert.equal(await page.getAttribute('#bc-preview g.bc-bars', 'fill'), '#1a237e');
  assert.equal(await page.inputValue('#bc-fg'), '#1a237e');
  await page.uncheck('#bc-text');
  assert.equal(await page.locator('#bc-preview text').count(), 0);
  // Light bars on a dark background get a warning; transparent drops the background rect.
  await page.fill('#bc-fg-hex', '#ffffff');
  await page.fill('#bc-bg-hex', '#000000');
  assert.match(await text('#bc-warn'), /bars are lighter than the background/);
  await page.fill('#bc-fg-hex', '#000000');
  await page.fill('#bc-bg-hex', '#ffffff');
  assert.equal(await text('#bc-warn'), '');
  await page.check('#bc-transparent');
  assert.equal(await page.locator('#bc-preview svg > rect').count(), 0);
  // Bad height input is clamped rather than breaking the drawing.
  await page.fill('#bc-height', '-5');
  assert.equal(await page.locator('#bc-preview svg').count(), 1);
  assert.equal(await page.getAttribute('#bc-preview g.bc-bars rect', 'height'), '10');
  await page.fill('#bc-height', '2.5e1');
  assert.equal(await page.getAttribute('#bc-preview g.bc-bars rect', 'height'), '25', 'exponent notation is read as a number');
  await page.fill('#bc-height', '80');
  await page.uncheck('#bc-transparent');
  await page.check('#bc-text');

  // Hex colour box: #rgb shorthand is accepted; an invalid code is flagged and ignored.
  await page.fill('#bc-fg-hex', '#f00');
  assert.equal(await page.getAttribute('#bc-preview g.bc-bars', 'fill'), '#ff0000');
  assert.equal(await page.inputValue('#bc-fg'), '#ff0000');
  await page.fill('#bc-fg-hex', '#12');
  assert.equal(await page.getAttribute('#bc-fg-hex', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#bc-preview g.bc-bars', 'fill'), '#ff0000');
  // The problem is stated in text tied to the box, not shown by the red border alone (WCAG 1.4.1, 3.3.1).
  for (const k of ['fg', 'bg']) assert.equal(await page.getAttribute(`#bc-${k}-hex`, 'aria-describedby'), `bc-${k}-err`);
  assert.ok(await page.isVisible('#bc-fg-err'));
  assert.match(await page.textContent('#bc-fg-err'), /^Enter a colour as #RRGGBB or #RGB, .* #ff0000 is used\.$/);
  assert.equal(await page.isVisible('#bc-bg-err'), false);
  await page.fill('#bc-bg-hex', '#zz12');
  assert.equal(await page.getAttribute('#bc-bg-hex', 'aria-invalid'), 'true');
  assert.match(await page.textContent('#bc-bg-err'), /#ffffff is used/);
  await page.dispatchEvent('#bc-bg-hex', 'change');
  assert.equal(await page.inputValue('#bc-bg-hex'), '#ffffff');
  assert.equal(await page.getAttribute('#bc-bg-hex', 'aria-invalid'), 'false');
  assert.equal(await page.isVisible('#bc-bg-err'), false);
  assert.equal(await page.textContent('#bc-bg-err'), '');
  await page.fill('#bc-fg-hex', '000000');
  assert.equal(await page.getAttribute('#bc-fg-hex', 'aria-invalid'), 'false');
  assert.equal(await page.isVisible('#bc-fg-err'), false);
  assert.equal(await page.getAttribute('#bc-preview g.bc-bars', 'fill'), '#000000');

  // ISBN-10 in the EAN-13 box: offered as its ISBN-13 (978 + 9 digits + GS1 check),
  // values computed independently in Python. An invalid ISBN-10 is not converted.
  await page.selectOption('#bc-type', 'ean13');
  await page.selectOption('#bc-width', '2');
  await setData('0-306-40615-2');
  assert.match(await text('#bc-error'), /ISBN-10.*9780306406157/);
  await page.click('#bc-fix');
  assert.equal(await text('#bc-encoded'), '9780306406157');
  assert.equal(await modules(), EAN13_ALL['9780306406157']);
  await setData('080442957X');
  assert.match(await text('#bc-error'), /9780804429573/);
  await setData('0306406153');
  assert.match(await text('#bc-error'), /needs 12 digits/);

  // Wide bars are whole pixels: ITF-14 at 1 px with a 2.5 ratio draws 3 px wide bars
  // (the ratio note says so) and the PNG has no grey anti-aliased columns.
  await page.selectOption('#bc-type', 'itf14');
  await setData('1540014128876');
  await page.uncheck('#bc-bearer');
  await page.selectOption('#bc-width', '1');
  await page.selectOption('#bc-ratio', '2.5');
  assert.match(await text('#bc-ratio-note'), /rounded to 3 px, so the ratio is 3 : 1/);
  const itfRects = await page.$$eval('#bc-preview g.bc-bars rect', rs => rs.map(r => [Number(r.getAttribute('x')), Number(r.getAttribute('width'))]));
  assert.ok(itfRects.every(([x, wd]) => Number.isInteger(x) && Number.isInteger(wd)), 'bars on whole pixels');
  assert.deepEqual([...new Set(itfRects.map(r => r[1]))].sort(), [1, 3]);
  assert.equal(await modules(), EXPECTED.itf14_15400141288763);
  await page.selectOption('#bc-type', 'ean8');
  assert.equal(await text('#bc-ratio-note'), '', 'no ratio note for types without wide bars');
  await page.selectOption('#bc-type', 'itf14');
  await setData('1540014128876');
  const itfPng = await download('#bc-png');
  const greys = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    const y = Number(document.querySelector('#bc-preview g.bc-bars rect').getAttribute('y')) + 5;
    const d = x.getImageData(0, y, c.width, 1).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== 0 && d[i] !== 255) n++;
    return n;
  }, itfPng.buf.toString('base64'));
  assert.equal(greys, 0, 'no grey pixels in a bar row');
  // At 2 px a 2.5 ratio is exact (5 px), so there is no note.
  await page.selectOption('#bc-width', '2');
  assert.equal(await text('#bc-ratio-note'), '');
  assert.deepEqual([...new Set(await page.$$eval('#bc-preview g.bc-bars rect', rs => rs.map(r => r.getAttribute('width'))))].sort(), ['2', '5']);

  // Long human-readable text is shrunk to fit inside the image rather than clipped.
  await page.selectOption('#bc-type', 'code128');
  await page.selectOption('#bc-width', '1');
  await setData('1'.repeat(120));
  const fitBox = await page.evaluate(() => {
    const svg = document.querySelector('#bc-preview svg');
    const bb = svg.querySelector('text').getBBox();
    return { left: bb.x, right: bb.x + bb.width, width: Number(svg.getAttribute('width')) };
  });
  assert.ok(fitBox.left >= 0 && fitBox.right <= fitBox.width, `text inside image: ${JSON.stringify(fitBox)}`);
  assert.equal(decode128(await modules(), assert).text, '1'.repeat(120));
};
