const fs = require('fs');
const zlib = require('zlib');

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

// New symbologies, module strings from zint 2.15 (pip zint-bindings 1.2.2), not from this tool.
const ZINT = {
  // UPC-E 0425261 -> 04252614 (UPC-A 042100005264, the Wikipedia example); number system 1.
  upce_04252614: '101001110100100110111001001101101011110011001010101',
  upce_12345656: '101001001101000010011101011100101011110110001010101',
  upce_01234565: '101011001100100110111101001110101110010101111010101',
  // Add-ons. zint leaves 7 modules before an EAN-13/UPC-E add-on and 9 before a UPC-A one;
  // this tool always leaves 9 (GS1 allows 7-12, and 9-12 for UPC).
  ean13_addon5_51299: '10110110001010110011010010011010001011010010111',
  ean13_addon2_05: '10110001101010111001',
  upca_addon2_12: '1010001101011110101011110001101000110100011010101011011001110100110011010111001001110110110010100000000010110011001010010011',
  upce_addon5_12345: '10110110011010010011010100001010100011010110001',
  // Code 93 "TEST93" (also the Wikipedia example, check characters + and 6) and full ASCII.
  code93_TEST93: '1010111101101001101100100101101011001101001101000010101010000101011101101001000101010111101',
  code93_mixed: '1010111101101000101001100101001011001001100101100101001001100101100100101110100101000010101010000101110101101101010001001101101110101101010111101',
  // Codabar A40156B with a 2:1 ratio, without and with the mod 16 check character (+).
  // zint ends the symbol with one extra space module, removed here.
  codabar: '10110010010101101001010101001101010110010110101001010010101101001001011',
  codabar_check: '1011001001010110100101010100110101011001011010100101001010110101101101101001001011',
  // MSI Plessey 1234567: no check, mod 10 (4), mod 10 + mod 10 (41).
  msi_none: '1101001001001101001001101001001001101101001101001001001101001101001101101001001101101101001',
  msi_10: '1101001001001101001001101001001001101101001101001001001101001101001101101001001101101101001101001001001',
  msi_1010: '1101001001001101001001101001001001101101001101001001001101001101001101101001001101101101001101001001001001001101001',
};
// MSI check digits for 2029 from zint: mod 10 -> 7, mod 10+10 -> 78, mod 11 -> 10 (two digits), mod 11+10 -> 106.

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
    if (v === 102) { text += '\x1d'; continue; } // FNC1 in any code set
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

// Minimal ZIP reader: every entry's name and bytes, with CRC-32 checked.
function unzip(buf, assert) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'end of central directory');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (zlib.crc32) assert.equal(zlib.crc32(data), crc, `CRC of ${name}`);
    out.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// Module string from a downloaded SVG, given the bar width and left quiet zone in px.
function svgModules(svg, X, q) {
  const bits = [];
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)) {
    for (let k = (Number(m[1]) - q) / X; k < (Number(m[1]) - q + Number(m[2])) / X; k++) bits[k] = '1';
  }
  return Array.from(bits, b => b || '0').join('');
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

  // ---------- UPC-E ----------
  await page.selectOption('#bc-width', '2');
  await setData('');
  await page.selectOption('#bc-type', 'upce');
  assert.equal(await page.inputValue('#bc-data'), '0425261', 'UPC-E example swapped in');
  assert.equal(await text('#bc-encoded'), '04252614');
  assert.equal(await text('#bc-upca'), '042100005264');
  assert.equal(await page.isVisible('#bc-upca-stat'), true);
  assert.equal(await modules(), ZINT.upce_04252614);
  // Human-readable: number system and check digit small outside, six digits under the bars.
  assert.equal(await page.$$eval('#bc-preview text', ts => ts.map(t => t.textContent).join('')), '04252614');
  for (const v of ['425261', '04252614', '042100005264', '04210000526']) {
    await setData(v);
    assert.equal(await text('#bc-encoded'), '04252614', v);
    assert.equal(await modules(), ZINT.upce_04252614, v);
  }
  await setData('1234565');
  assert.equal(await text('#bc-encoded'), '12345656');
  assert.equal(await modules(), ZINT.upce_12345656);
  await setData('012345');
  assert.equal(await text('#bc-encoded'), '00123457');
  await setData('0123456');
  assert.equal(await modules(), ZINT.upce_01234565);
  await setData('04252615');
  assert.match(await text('#bc-error'), /check digit should be 4, not 5\. The correct UPC-E is 04252614/);
  await page.click('#bc-fix');
  assert.equal(await text('#bc-encoded'), '04252614');
  await setData('036000291452');
  assert.match(await text('#bc-error'), /cannot be shortened to UPC-E/);
  await setData('2425261');
  assert.match(await text('#bc-error'), /number system, 0 or 1, not 2/);
  // 120003 expands to UPC-A 012000000003, which UPC-E writes as 120000 (Python, Wikipedia rules).
  await setData('0120003');
  assert.match(await text('#bc-error'), /not a valid UPC-E: 120003 expands to UPC-A 012000000003, which is written 120000/);
  await page.click('#bc-fix');
  assert.equal(await text('#bc-encoded'), '01200003');
  await setData('12345');
  assert.match(await text('#bc-error'), /needs 6, 7 or 8 digits/);

  // ---------- EAN/UPC add-ons ----------
  const mainAndAddon = async (mainLen, addonBits) => {
    const bits = await modules();
    assert.equal(bits.slice(mainLen, mainLen + 9), '000000000', '9-module gap before the add-on');
    assert.equal(bits.slice(mainLen + 9), addonBits);
    return bits.slice(0, mainLen);
  };
  await setData('0425261');
  await page.fill('#bc-addon', '12345');
  assert.equal(await mainAndAddon(51, ZINT.upce_addon5_12345), ZINT.upce_04252614);
  await page.fill('#bc-addon', '');
  await page.selectOption('#bc-type', 'ean13');
  await setData('978030640615');
  assert.equal(await page.isVisible('#bc-addon'), true);
  await page.fill('#bc-addon', '51299');
  assert.equal(await text('#bc-encoded'), '9780306406157 + 51299');
  assert.equal(await mainAndAddon(95, ZINT.ean13_addon5_51299), EAN13_ALL['9780306406157']);
  // Add-on digits sit above the add-on bars, whose bottoms line up with the guard bars.
  const geo = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('#bc-preview g.bc-bars rect')].map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), h: +r.getAttribute('height') }));
    const ts = [...document.querySelectorAll('#bc-preview text')].map(t => ({ s: t.textContent, y: +t.getAttribute('y') }));
    return { first: rs[0], last: rs[rs.length - 1], ts };
  });
  assert.ok(geo.last.y > geo.first.y, 'add-on bars start lower');
  assert.equal(geo.last.y + geo.last.h, geo.first.y + geo.first.h, 'add-on bars end level with the guard bars');
  assert.deepEqual(geo.ts.slice(-5).map(t => t.s).join(''), '51299');
  assert.ok(geo.ts.slice(-5).every(t => t.y < geo.last.y), 'add-on text above its bars');
  const addonSvg = await download('#bc-svg');
  assert.equal(addonSvg.name, 'barcode-ean13-9780306406157-51299.svg');
  // "+" in the data box does the same; both at once is an error.
  await setData('978030640615+05');
  assert.match(await text('#bc-error'), /either after a \+ or in the Add-on box/);
  assert.equal(await page.getAttribute('#bc-data', 'aria-invalid'), 'true');
  await page.fill('#bc-addon', '');
  assert.equal(await mainAndAddon(95, ZINT.ean13_addon2_05), EAN13_ALL['9780306406157']);
  await page.fill('#bc-addon', '123');
  await setData('978030640615');
  assert.match(await text('#bc-error'), /2 digits \(EAN-2\) or 5 digits \(EAN-5\), not 3/);
  assert.equal(await page.getAttribute('#bc-addon', 'aria-invalid'), 'true');
  await page.fill('#bc-addon', '');
  await page.selectOption('#bc-type', 'upca');
  await setData('03600029145+12');
  assert.equal(await modules(), ZINT.upca_addon2_12, 'UPC-A + EAN-2 (same 9-module gap as zint)');
  await page.selectOption('#bc-type', 'ean8');
  await setData('9638507+12');
  assert.match(await text('#bc-error'), /EAN-8 barcodes do not take an add-on/);
  assert.equal(await page.isVisible('#bc-addon'), false);

  // ---------- Code 93 ----------
  await page.selectOption('#bc-type', 'code93');
  await setData('TEST93');
  assert.equal(await modules(), ZINT.code93_TEST93);
  assert.equal(await text('#bc-check'), '+ 6');
  await setData('Code 93!');
  assert.equal(await modules(), ZINT.code93_mixed);
  assert.equal(await page.$eval('#bc-preview text', t => t.textContent), 'Code 93!');
  await setData('naïve');
  assert.match(await text('#bc-error'), /ASCII characters only\. Remove: ï/);

  // ---------- Codabar ----------
  await page.selectOption('#bc-type', 'codabar');
  await page.selectOption('#bc-ratio', '2');
  await setData('a40156b');
  assert.equal(await text('#bc-encoded'), 'A40156B');
  assert.equal(await modules(), ZINT.codabar);
  await page.check('#bc-codabar-check');
  assert.equal(await text('#bc-encoded'), 'A40156+B');
  assert.equal(await modules(), ZINT.codabar_check);
  await page.uncheck('#bc-codabar-check');
  await setData('40156');
  assert.equal(await text('#bc-encoded'), 'A40156A', 'start/stop A added');
  await setData('A40156');
  assert.match(await text('#bc-error'), /starts and ends with one of the letters A–D/);
  await setData('A40E56B');
  assert.match(await text('#bc-error'), /Remove: E/);
  await page.selectOption('#bc-ratio', '3');

  // ---------- MSI Plessey ----------
  await page.selectOption('#bc-type', 'msi');
  await setData('1234567');
  assert.equal(await text('#bc-encoded'), '12345674', 'mod 10 by default');
  assert.equal(await modules(), ZINT.msi_10);
  await page.selectOption('#bc-msi-check', 'none');
  assert.equal(await modules(), ZINT.msi_none);
  await page.selectOption('#bc-msi-check', '1010');
  assert.equal(await modules(), ZINT.msi_1010);
  for (const [mode, enc] of [['10', '20297'], ['1010', '202978'], ['11', '202910'], ['1110', '2029106']]) {
    await page.selectOption('#bc-msi-check', mode);
    await setData('2029');
    assert.equal(await text('#bc-encoded'), enc, `MSI mode ${mode}`);
  }
  await page.selectOption('#bc-msi-check', '10');
  await setData('12a');
  assert.match(await text('#bc-error'), /digits only\. Remove: a/);

  // ---------- GS1-128 ----------
  // zint encodes the same data in the same number of symbols (it breaks a tie between
  // code sets differently), so compare the decoded data, FNC1 positions and length
  // (start, data and check symbols: 23, 23 and 13 in zint's 266-, 266- and 156-module symbols).
  const GS = '\x1d';
  await setData('');
  await page.selectOption('#bc-type', 'gs1128');
  assert.equal(await page.inputValue('#bc-data'), '(01)09501101530003(17)281231(10)AB-123');
  const gs1Cases = [
    ['(01)09501101530003(17)281231(10)AB-123', GS + '010950110153000317281231' + '10AB-123', 23],
    // 10 is variable-length, so FNC1 separates it from the next AI.
    ['(01)09501101530003(10)AB12(21)XYZ', GS + '0109501101530003' + '10AB12' + GS + '21XYZ', 23],
    ['(00)106141412345678908', GS + '00106141412345678908', 13],
  ];
  for (const [input, data, symbols] of gs1Cases) {
    await setData(input);
    const dd = decode128(await modules(), assert);
    assert.equal(dd.text, data, input);
    assert.equal(dd.symbols, symbols, `${input}: as short as zint`);
  }
  await setData('(01)09501101530003(17)281231(10)AB-123');
  assert.equal(await text('#bc-encoded'), '(01)09501101530003(17)281231(10)AB-123');
  assert.equal(await page.$eval('#bc-preview text', t => t.textContent), '(01)09501101530003(17)281231(10)AB-123');
  assert.deepEqual(await page.$$eval('#bc-gs1-body tr', rs => rs.map(r => r.textContent)),
    ['(01)GTIN09501101530003', '(17)Expiry date281231', '(10)Batch or lot numberAB-123']);
  // Predefined-length AIs (here 3103) need no FNC1 after them; square brackets allow "(" in data.
  await setData('(3103)001250(10)X');
  assert.equal(decode128(await modules(), assert).text, GS + '3103001250' + '10X');
  assert.match(await page.textContent('#bc-gs1-body'), /Net weight \(kg\), 3 decimals/);
  await setData('[10]AB(1)[3103]001250');
  assert.equal(decode128(await modules(), assert).text, GS + '10AB(1)' + GS + '3103001250');
  assert.equal(await text('#bc-encoded'), '(10)AB(1)(3103)001250');
  // Errors, with a fix where one is certain. 9501101530003 is a valid GTIN-13; 0950110153000
  // is not (its check digit would be 7), so it is read as a GTIN-14 missing its check digit 3.
  const gs1Errors = [
    ['(01)09501101530004', /\(01\): the check digit should be 3, not 4/, '(01)09501101530003'],
    ['(01)9501101530003(10)A', /GTIN-13 is written with leading zeros: 09501101530003/, '(01)09501101530003(10)A'],
    ['(01)0950110153000', /With the check digit added it is 09501101530003/, '(01)09501101530003'],
    ['(17)281331', /281331 is not a valid date/],
    ['(17)270229', /270229 is not a valid date/],
    ['(10)AB C', /Remove: space/],
    ['(10)' + 'A'.repeat(21), /at most 20 characters\. This has 21/],
    ['(23)123', /AI \(23\) is not one this generator supports/],
    ['(3106)001250', /AI \(3106\) is not one/],
    ['0109501101530003', /Start with an Application Identifier in brackets/],
    ['(10)A(10)B', /appears twice/],
    ['(10)', /\(10\) has no data after it/],
    ['(01)09501101530003(10)' + 'A'.repeat(20) + '(21)' + 'B'.repeat(20), /at most 48 characters of AIs and data, and this has 60/],
  ];
  for (const [input, re, fix] of gs1Errors) {
    await setData(input);
    assert.match(await text('#bc-error'), re, input);
    assert.equal(await page.isVisible('#bc-fix'), !!fix, `fix offered for ${input}`);
    if (fix) {
      await page.click('#bc-fix');
      assert.equal(await page.inputValue('#bc-data'), fix);
      assert.equal(await text('#bc-error'), '');
    }
  }
  for (const ok of ['(17)280229', '(17)281200', '(421)25075001', '(99)ABC-1', '(3922)1299']) {
    await setData(ok);
    assert.equal(await text('#bc-error'), '', ok);
  }

  // ---------- Screen readers: one summary after typing pauses, never on load ----------
  await open();
  assert.equal(await text('#bc-status'), '');
  for (const sel of ['.bc-stats', '#bc-error', '#bc-warn']) assert.equal(await page.getAttribute(sel, 'aria-live'), null, `${sel} is not live`);
  await page.evaluate(() => {
    window.__st = [];
    new MutationObserver(() => window.__st.push(document.querySelector('#bc-status').textContent))
      .observe(document.querySelector('#bc-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#bc-data', '');
  await page.locator('#bc-data').pressSequentially('AB-12', { delay: 30 });
  await page.waitForFunction(() => document.querySelector('#bc-status').textContent !== '');
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.__st), ['Code 128 barcode ready: AB-12.']);

  // ---------- PNG larger than browsers can draw: a clear error, no download ----------
  await page.selectOption('#bc-width', '6');
  await page.selectOption('#bc-scale', '4');
  await setData('A'.repeat(120));
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.click('#bc-png');
  await page.waitForTimeout(300);
  assert.match(await text('#bc-error'), /At 4× the PNG would be \d+ × \d+ pixels, more than browsers can draw/);
  assert.equal(downloads, 0);
  await page.selectOption('#bc-width', '2');
  await page.selectOption('#bc-scale', '1');

  // ---------- Bulk ZIP ----------
  assert.equal(await page.isDisabled('#bc-bulk-zip'), true, 'nothing to zip yet');
  // A spreadsheet's byte order mark is dropped; lines over 120 characters are refused.
  await page.fill('#bc-bulk-input', '\uFEFFSKU-1\r\n\n  SKU-2  \nbad€\nSKU-1\n' + 'X'.repeat(121) + '\n');
  await page.waitForFunction(() => /3 Code 128/.test(document.querySelector('#bc-bulk-summary').textContent));
  assert.equal(await text('#bc-bulk-summary'), '3 Code 128 barcodes ready; 2 lines have problems and will be left out.');
  assert.deepEqual(await page.$$eval('#bc-bulk-errors tr', rs => rs.map(r => [...r.cells].map(c => c.textContent))),
    [['4', 'bad€', 'Code 128 encodes ASCII characters only. Remove: €.'], ['6', 'X'.repeat(60) + '…', 'Longer than 120 characters, too long for one barcode.']]);
  let zdl = await download('#bc-bulk-zip');
  assert.equal(zdl.name, 'barcodes-code128.zip');
  let files = unzip(zdl.buf, assert);
  assert.deepEqual([...files.keys()], ['barcode-code128-SKU-1.svg', 'barcode-code128-SKU-2.svg', 'barcode-code128-SKU-1 (2).svg']);
  assert.equal(decode128(svgModules(files.get('barcode-code128-SKU-2.svg').toString('utf8'), 2, 20), assert).text, 'SKU-2', 'spaces around a line are trimmed');
  assert.match(await text('#bc-bulk-summary'), /Downloaded barcodes-code128\.zip with 3 files\. 2 lines were left out\./);
  // Names from a second column (CSV quoting, or tabs), PNG and SVG together.
  await page.check('#bc-bulk-names');
  await page.selectOption('#bc-bulk-format', 'both');
  await page.fill('#bc-bulk-input', 'SKU-1,first label\n"SKU,2","second, ""quoted"" label"\nSKU-3\tthird/label.svg\n,no data');
  await page.waitForFunction(() => /2 lines|3 Code 128/.test(document.querySelector('#bc-bulk-summary').textContent));
  zdl = await download('#bc-bulk-zip');
  files = unzip(zdl.buf, assert);
  assert.deepEqual([...files.keys()].sort(), ['first label.png', 'first label.svg', 'second, -quoted- label.png', 'second, -quoted- label.svg', 'third-label.png', 'third-label.svg'].sort());
  assert.equal(decode128(svgModules(files.get('second, -quoted- label.svg').toString('utf8'), 2, 20), assert).text, 'SKU,2');
  const zpng = files.get('third-label.png');
  assert.equal(zpng.subarray(1, 4).toString(), 'PNG');
  await setData('SKU-3');
  const [sw, sh] = (await text('#bc-size')).split(' × ').map(Number);
  assert.deepEqual([zpng.readUInt32BE(16), zpng.readUInt32BE(20)], [sw, sh], 'PNG in the ZIP has the single-barcode size');
  assert.match(await text('#bc-bulk-errors'), /The first column is empty/);
  // The type and style above apply: EAN-13 lines with "+" add-ons.
  await page.uncheck('#bc-bulk-names');
  await page.selectOption('#bc-bulk-format', 'svg');
  await page.selectOption('#bc-type', 'ean13');
  await page.fill('#bc-bulk-input', '978030640615+51299\n4006381333932');
  await page.waitForFunction(() => /1 EAN-13 barcode ready/.test(document.querySelector('#bc-bulk-summary').textContent));
  assert.match(await text('#bc-bulk-errors'), /check digit should be 1, not 2/);
  zdl = await download('#bc-bulk-zip');
  files = unzip(zdl.buf, assert);
  const eanSvg = files.get('barcode-ean13-9780306406157-51299.svg').toString('utf8');
  const eanBits = svgModules(eanSvg, 2, 22);
  assert.equal(eanBits.slice(0, 95), EAN13_ALL['9780306406157']);
  assert.equal(eanBits.slice(104), ZINT.ean13_addon5_51299);
  // Over 1,000 lines: the first 1,000 are used, and the page stays responsive.
  await page.selectOption('#bc-type', 'code128');
  await page.$eval('#bc-bulk-input', el => {
    el.value = Array.from({ length: 1005 }, (_, i) => 'ITEM-' + i).join('\n');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => /1,000 Code 128 barcodes ready/.test(document.querySelector('#bc-bulk-summary').textContent));
  assert.match(await text('#bc-bulk-error'), /Only the first 1,000 lines are used/);
  const longTask = await page.evaluate(() => new Promise(resolve => {
    let worst = 0;
    const obs = new PerformanceObserver(l => l.getEntries().forEach(e => { worst = Math.max(worst, e.duration); }));
    obs.observe({ type: 'longtask' });
    document.querySelector('#bc-bulk-zip').click();
    const t0 = performance.now();
    (function wait() {
      if (/Downloaded/.test(document.querySelector('#bc-bulk-summary').textContent) || performance.now() - t0 > 20000) { obs.disconnect(); resolve(worst); }
      else setTimeout(wait, 50);
    })();
  }));
  assert.match(await text('#bc-bulk-summary'), /with 1,000 files/);
  assert.ok(longTask < 250, `longest task while zipping 1,000 SVGs: ${longTask} ms`);
};
