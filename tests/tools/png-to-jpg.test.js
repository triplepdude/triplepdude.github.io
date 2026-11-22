// PNG to JPG: the image converter set up for this pair. Fixtures:
//   alpha.png  64x48 (copy of image-converter's): left half (200,30,60), right
//              half transparent, top-right quarter (20,100,220) at alpha 128
//   photo.png  scikit-image's "astronaut" sample (NASA, public domain) at 200x200
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// JPEG reader: size and chroma sampling from the frame header, EXIF from APP1.
function jpegInfo(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('not a JPEG');
  const info = { exif: false };
  for (let i = 2; i < b.length;) {
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m === 0xDA) break;
    if (m === 0xE1 && b.toString('latin1', i + 4, i + 8) === 'Exif') info.exif = true;
    if (m >= 0xC0 && m <= 0xC2) {
      info.h = b.readUInt16BE(i + 5); info.w = b.readUInt16BE(i + 7);
      info.sampling = [0, 1, 2].map(k => (b[i + 11 + 3 * k] >> 4) + 'x' + (b[i + 11 + 3 * k] & 15)).join(' ');
    }
    i += 2 + len;
  }
  return info;
}

module.exports = async ({ page, open, assert, fixtures }) => {
  const fx = f => path.join(fixtures, f);
  await open();
  assert.equal(await page.textContent('h1'), 'PNG to JPG Converter for Smaller Files');

  // ---------- Set up for PNG to JPG as served, and nothing moves as the script starts ----------
  const NOTE = 'Screenshots, text and logos are better kept as PNG: JPG softens their edges and often saves little on them.';
  const HINT = 'PNG images, transparent ones included, as many as you like. Nothing is uploaded.';
  const START = ['jpeg', '90', '90%', '#ffffff', 'strip', 'false,false,false,false,true,true', NOTE, HINT];
  const load = await page.evaluate(async () => {
    const state = doc => {
      const q = s => doc.querySelector(s);
      return [q('#imc-format').value, q('#imc-quality').value, q('#imc-quality-out').textContent, q('#imc-bg').value, q('#imc-meta').value,
        ['#imc-quality-field', '#imc-resize-field', '#imc-bg-field', '#imc-meta-field', '#imc-sizes', '#imc-resize-val'].map(s => q(s).hidden).join(),
        q('#imc-note').textContent, q('#imc-drop .hint').textContent];
    };
    const live = state(document);
    const html = await (await fetch(location.href)).text();
    await Promise.all(['webp', 'avif'].map(f => TTImage.canEncode(f, { wasm: true })));
    await new Promise(r => setTimeout(r, 50));
    return { html, served: state(new DOMParser().parseFromString(html, 'text/html')), live, settled: state(document) };
  });
  assert.doesNotMatch(load.html, /\{%|\{\{|include\.|imc_[a-z]|animated_note/, 'Liquid or include notes in the page');
  assert.deepEqual(load.served, START);
  assert.deepEqual(load.live, START, 'the script changed the controls as it started');
  assert.deepEqual(load.settled, START, 'the encoder checks changed the controls');

  // ---------- The guide links to the hub, JPG to PNG and the compressor, all real tool pages ----------
  const links = await page.$$eval('.prose a', as => as.map(a => a.getAttribute('href')));
  for (const h of ['/image-converter/', '/jpg-to-png/', '/compress-image/']) assert.ok(links.includes(h), `guide links to ${h}`);
  for (const h of links) assert.ok(/^\/[a-z0-9-]+\/$/.test(h) && fs.existsSync(path.join(__dirname, '..', '..', '_tools', h.slice(1, -1) + '.html')), `guide link ${h} is not a tool page`);
  // The guide's advice names the real controls: the Size menu with its longest-side choice, and
  // the ZIP button that the batch question in the FAQ points to.
  const guide = (await page.textContent('.prose')).replace(/\s+/g, ' ');
  assert.match(guide, /If the picture has more pixels than it needs, also set Size to a longest side such as 2000 px: a 12-megapixel phone photo then keeps a quarter of its pixels, and the file shrinks with them\./);
  assert.deepEqual([await page.textContent('label[for="imc-resize"]'), await page.textContent('#imc-resize option[value="max"]'), await page.textContent('#imc-zip')], ['Size', 'Longest side (px)', 'Download all (ZIP)']);
  assert.deepEqual(await page.$$eval('.faq summary', s => s.map(e => e.textContent.trim())), [
    'How much smaller is a JPG than a PNG?', 'Why does my transparent PNG get a white background as a JPG?', 'Can I convert many PNG files at once?', 'Will my picture look worse as a JPG?']);
  assert.match((await page.textContent('.faq')).replace(/\s+/g, ' '), /and Download all \(ZIP\) saves the JPGs in one file\./);

  const rows = page.locator('.imc-item');
  const rowText = async i => (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
  const download = async i => {
    const [dl] = await Promise.all([page.waitForEvent('download'), rows.nth(i).locator('[data-act="dl"]').click()]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  const rerun = async action => {
    await page.evaluate(() => {
      window.__saw = false;
      const el = document.querySelector('#imc-summary');
      if (window.__mo) window.__mo.disconnect();
      window.__mo = new MutationObserver(() => { if (/working/.test(el.textContent)) window.__saw = true; });
      window.__mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    await action();
    await page.waitForFunction(() => window.__saw && !/working/.test(document.querySelector('#imc-summary').textContent), null, { timeout: 20000 });
  };
  const setInput = (sel, v) => rerun(() => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v));
  const pixels = (buf, pts) => page.evaluate(async ([b64, pts]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
  }, [buf.toString('base64'), pts]);
  const near = (got, want, tol, what) => want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tol, `${what}: got ${got} want ${want}`));

  // ---------- Convert: a transparent PNG and a photo saved as PNG ----------
  await page.setInputFiles('#imc-file', ['alpha.png', 'photo.png'].map(fx));
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#imc-status').textContent === 'Converted 2 images to JPG.');
  assert.match(await rowText(0), /^alpha\.jpg PNG 64×48, 207 B → JPG 64×48, .*Transparent areas were filled with white\./);
  const saving = (await rowText(1)).match(/^photo\.jpg PNG 200×200, 72 KB → JPG 200×200, (\d+) KB \((\d+)% smaller\)/);
  assert.ok(saving, 'the saving is shown: ' + await rowText(1));
  assert.ok(+saving[2] >= 60, `a photo saved as PNG should shrink a lot as JPG, got ${saving[2]}%`);
  assert.ok(Math.abs((1 - saving[1] * 1000 / fs.statSync(fx('photo.png')).size) * 100 - saving[2]) < 2, 'the percentage matches the sizes shown');

  let f = await download(0);
  assert.equal(f.name, 'alpha.jpg');
  let j = jpegInfo(f.data);
  assert.deepEqual([j.w, j.h, j.exif, j.sampling], [64, 48, false, '2x2 1x1 1x1']);
  let px = await pixels(f.data, [[10, 40], [50, 40], [50, 10]]);
  near(px[0], [200, 30, 60, 255], 10, 'opaque red');
  near(px[1], [255, 255, 255, 255], 6, 'transparent -> white');
  near(px[2], [137, 177, 237, 255], 10, 'alpha 128 blue over white');

  // ---------- A colour of your own, named by its code ----------
  // The list is redone 250 ms after a change. Until then no button may hand
  // over a JPG made on the old colour.
  await rerun(async () => {
    await page.$eval('#imc-bg', el => { el.value = '#336699'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.deepEqual(await page.$$eval('.imc-item [data-act="dl"]', b => b.map(x => x.disabled)), [true, true], 'Download offered a JPG made on the old colour');
    assert.equal(await page.isDisabled('#imc-zip'), true, 'the ZIP offered JPGs made on the old colour');
  });
  assert.match(await rowText(0), /Transparent areas were filled with #336699\./);
  px = await pixels((await download(0)).data, [[50, 40], [50, 10]]);
  near(px[0], [51, 102, 153, 255], 8, 'transparent -> #336699');
  near(px[1], [36, 101, 187, 255], 10, 'alpha 128 blue over #336699');

  // ---------- 100% keeps colour at full resolution (the guide's advice for screenshots) ----------
  await setInput('#imc-quality', '100');
  j = jpegInfo((await download(1)).data);
  assert.equal(j.sampling, '1x1 1x1 1x1', 'quality 100 should not subsample colour');
  assert.match(await rowText(1), /→ JPG 200×200, [\d.]+ KB \(\d+% smaller\)/);

  // ---------- The page's note belongs to JPG: not shown for PNG, back with JPG ----------
  await rerun(() => page.selectOption('#imc-format', 'png'));
  assert.equal(await page.textContent('#imc-note'), 'PNG is lossless: every pixel is kept exactly, and photos make large files.');
  assert.equal(await page.isVisible('#imc-bg-field'), false);
  assert.match(await rowText(0), /^alpha\.png PNG 64×48/);
  assert.doesNotMatch(await rowText(0), /filled with/);
  await rerun(() => page.selectOption('#imc-format', 'jpeg'));
  assert.equal(await page.textContent('#imc-note'), NOTE);
  assert.match(await rowText(0), /^alpha\.jpg .*filled with #336699\./);

  // ---------- A megabyte pasted into the size box (the only text field) ----------
  // A number field took Chrome about 30 s to reject that much text; the page refuses it at once.
  await rerun(() => page.selectOption('#imc-resize', 'width'));
  assert.equal(await page.inputValue('#imc-resize-val'), '1200');
  assert.match(await rowText(1), /→ JPG 1200×1200,/);
  const t0 = Date.now();
  await page.focus('#imc-resize-val');
  await page.keyboard.insertText('9'.repeat(1 << 20));
  assert.ok(Date.now() - t0 < 3000, `a megabyte paste took ${Date.now() - t0} ms`);
  assert.equal(await page.inputValue('#imc-resize-val'), '1200', 'the long text must not land in the field');
  assert.equal(await page.textContent('#imc-error'), 'That text is too long to be a size, so it was not pasted. Sizes have at most 5 digits.');
  // A normal value is accepted, clears the message and resizes again. The box is
  // read 500 ms after typing stops; meanwhile the files of the old size are not offered.
  await rerun(async () => {
    await page.fill('#imc-resize-val', '100');
    assert.equal(await page.isDisabled('#imc-zip'), true, 'the ZIP offered files of the old size while a new one was typed');
    assert.deepEqual(await page.$$eval('.imc-item [data-act="dl"]', b => b.map(x => x.disabled)), [true, true], 'Download offered a file of the old size');
  });
  assert.equal(await page.textContent('#imc-error'), '');
  assert.match(await rowText(1), /→ JPG 100×100,/);

  // ---------- How sizes are read, the same in an English and a German browser ----------
  // A comma or point marks decimals; for pixels a point, comma or space before
  // exactly three digits groups thousands, never after a leading 0.
  const readAs = async (p, mode, text, want) => {
    if (await p.inputValue('#imc-resize') !== mode) await p.selectOption('#imc-resize', mode);
    await p.fill('#imc-resize-val', text);
    // The box is read 500 ms after typing stops.
    await p.waitForFunction(([src, fl]) => new RegExp(src, fl).test(document.querySelector('#imc-note').textContent), [want.source, want.flags], { timeout: 3000 }).catch(() => {});
    return { note: await p.textContent('#imc-note'), invalid: await p.getAttribute('#imc-resize-val', 'aria-invalid') };
  };
  const other = await page.context().browser().newContext({ locale: 'de-DE' });
  const de = await other.newPage();
  await de.goto(page.url());
  for (const p of [page, de]) {
    const lang = p === de ? 'de-DE' : 'en';
    const cases = [
      ['width', '1.920', /Read as 1920 pixels\./], ['width', '1,920', /Read as 1920 pixels\./], ['width', '1 920', /Read as 1920 pixels\./],
      ['width', '0,500', /Read as 0\.5 pixels\./], ['percent', '12,5', /Read as 12\.5%\./], ['percent', '1.250', /Read as 1\.25%\./],
      ['height', '640', /^(?!.*Read as)/], ['width', '5²', /“5²” is not a size this tool can read/], ['width', '50\t60', /is not a size this tool can read/],
      ['width', '1٬920', /is not a size this tool can read/], ['percent', '1 250', /is not a size this tool can read/],
    ];
    for (const [mode, text, want] of cases) {
      const r = await readAs(p, mode, text, want);
      assert.match(r.note, want, `${lang}: ${mode} "${text}" -> ${r.note}`);
      assert.equal(r.invalid, /not a size/.test(r.note) ? 'true' : 'false', `${lang}: aria-invalid for "${text}"`);
    }
  }
  await other.close();
  // The reading drives the conversion: 12,5% of 64x48 is 8x6.
  await page.selectOption('#imc-resize', 'percent');
  await page.fill('#imc-resize-val', '12,5');
  await page.waitForFunction(() => /→ JPG 8×6,/.test(document.querySelector('.imc-item').textContent) && document.querySelector('#imc-summary').textContent === '2 of 2 converted.', null, { timeout: 20000 });
  assert.match(await rowText(1), /→ JPG 25×25,/);

  // ---------- Files added or converting: nothing is offered before it is finished ----------
  // Files go in through the file box and the controls are read in the same task,
  // before any conversion can finish.
  const b64 = n => fs.readFileSync(fx(n)).toString('base64');
  const addNow = (files, colour) => page.evaluate(async ([files, colour]) => {
    const dt = new DataTransfer(), input = document.querySelector('#imc-file');
    for (const [name, data] of files) dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name, { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const offered = [document.querySelector('#imc-zip').disabled, ...Array.from(document.querySelectorAll('.imc-item [data-act="dl"]'), b => b.disabled)];
    // A colour picked while they convert: record every state the list shows until all are done.
    const texts = [];
    if (colour) {
      const mo = new MutationObserver(() => document.querySelectorAll('.imc-item').forEach(li => texts.push(li.textContent)));
      mo.observe(document.querySelector('#imc-list'), { subtree: true, childList: true, characterData: true, attributes: true });
      const bg = document.querySelector('#imc-bg');
      bg.value = colour;
      bg.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => { const t = setInterval(() => { if (/^(\d+) of \1 converted\.$/.test(document.querySelector('#imc-summary').textContent)) { clearInterval(t); mo.disconnect(); r(); } }, 10); });
    }
    return { offered, texts };
  }, [files, colour]);
  await page.click('#imc-clear');
  await page.setInputFiles('#imc-file', [fx('alpha.png')]);
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '1 of 1 converted.');
  // One file done, one just added: its Download and the ZIP wait for it.
  assert.deepEqual((await addNow([['photo.png', b64('photo.png')]])).offered, [true, false, true], '[ZIP, first Download, second Download] disabled');
  await page.waitForFunction(() => document.querySelector('#imc-summary').textContent === '2 of 2 converted.');
  assert.equal(await page.isDisabled('#imc-zip'), false);
  // Two files converting when the colour changes: neither is ever shown finished on the old colour.
  await page.click('#imc-clear');
  const seen = await addNow([['alpha.png', b64('alpha.png')], ['photo.png', b64('photo.png')]], '#000000');
  assert.deepEqual(seen.offered, [true, true, true]);
  assert.ok(seen.texts.length, 'no list changes were recorded');
  assert.deepEqual(seen.texts.filter(t => /#336699/.test(t)), [], 'a file finished on the colour that had just been changed');
  assert.match(await rowText(0), /Transparent areas were filled with black\./);

  // ---------- A 12-megapixel picture with Size set to a longest side of 2000 px ----------
  // 4032x3024, the size of most phone photos, made here as one flat colour so the PNG is small.
  // As the guide says, 2000 x 1500 keeps a quarter of the pixels (24.6%).
  const big = (() => {
    const w = 4032, h = 3024, line = Buffer.alloc(1 + w * 3);
    line.set([1, 60, 120, 180]); // Sub filter: the first pixel's colour repeats across the line
    const chunk = (type, data) => {
      const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      len.writeUInt32BE(data.length);
      crc.writeUInt32BE(zlib.crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => line)));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  })();
  await page.click('#imc-clear');
  await page.selectOption('#imc-resize', 'max');
  await page.fill('#imc-resize-val', '2000');
  await page.setInputFiles('#imc-file', [{ name: 'phone.png', mimeType: 'image/png', buffer: big }]);
  await page.waitForFunction(() => /→ JPG 2000×1500,/.test(document.querySelector('.imc-item').textContent) && document.querySelector('#imc-summary').textContent === '1 of 1 converted.', null, { timeout: 30000 });
  assert.match(await rowText(0), /^phone\.jpg PNG 4032×3024, [\d.]+ KB → JPG 2000×1500, /);
  assert.ok((2000 * 1500) / (4032 * 3024) <= 0.25);
};
