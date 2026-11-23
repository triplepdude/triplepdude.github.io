const fs = require('fs');
const path = require('path');

// The pictures in tests/fixtures/image-to-text/ are drawn by make_fixtures.py with Pillow from
// known lines of text, which are saved in expected.json: the test compares what the page reads
// with the text that was drawn, not with an earlier reading. Paragraph breaks are Tesseract's
// choice, so texts are compared line by line, with blank lines left out. (pq.avif, a 128 x 16
// HDR AVIF with no text, is a copy of tests/fixtures/heic-to-jpg/pq.avif.)
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const fx = name => path.join(fixtures, name);
  const lines = t => t.split('\n').filter(l => l.trim() !== '');
  const clip = p => p.evaluate(() => navigator.clipboard.readText());

  const state = (p = page) => p.evaluate(() => ({
    status: document.querySelector('#i2t-status').textContent,
    error: document.querySelector('#i2t-error').textContent,
    text: document.querySelector('#i2t-text').value,
    count: document.querySelector('#i2t-count').textContent,
    size: document.querySelector('#i2t-size').textContent,
    notes: [...document.querySelectorAll('#i2t-notes li')].map(li => li.textContent),
    rows: [...document.querySelectorAll('#i2t-lines tr')].map(tr => ({
      n: tr.cells[0].textContent, text: tr.cells[1].textContent,
      conf: parseInt(tr.cells[2].textContent, 10), check: !!tr.cells[2].querySelector('.i2t-low')
    })),
    linesNote: document.querySelector('#i2t-lines-note').hidden ? '' : document.querySelector('#i2t-lines-note').textContent,
    options: [...document.querySelectorAll('#i2t-page option')].map(o => o.textContent),
    shown: document.querySelector('#i2t-page').value ? document.querySelector('#i2t-page').selectedOptions[0].textContent : '',
    alt: document.querySelector('#i2t-img').alt,
    boxes: [...document.querySelectorAll('#i2t-boxes polygon.i2t-line')].map(p => ({ low: p.classList.contains('is-low'), pts: p.getAttribute('points').split(' ').map(xy => xy.split(',').map(Number)) })),
    tags: [...document.querySelectorAll('#i2t-boxes text')].map(t => t.textContent),
    outHidden: document.querySelector('#i2t-out').hidden,
    busy: !document.querySelector('#i2t-progress').hidden
  }));
  const clearStatus = (p = page) => p.evaluate(() => { document.querySelector('#i2t-status').textContent = ''; });
  // A run is over when the progress bar has gone and the status gives its summary.
  const done = (p = page, timeout = 90000) => p.waitForFunction(() => document.querySelector('#i2t-progress').hidden &&
    /^(Read |No text|Copied|Stopped)/.test(document.querySelector('#i2t-status').textContent), null, { timeout });
  const add = async (names, p = page) => {
    await clearStatus(p);
    await p.setInputFiles('#i2t-file', [].concat(names).map(fx));
    await done(p);
  };
  // The text of one page in the box, between its heading and the next one.
  const section = (text, label) => {
    const all = text.split('\n'), i = all.indexOf('--- ' + label + ' ---');
    assert.ok(i >= 0, `heading for ${label} in ${JSON.stringify(text.slice(0, 300))}`);
    const out = [];
    for (let k = i + 1; k < all.length && !/^--- .* ---$/.test(all[k]); k++) out.push(all[k]);
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  };
  const show = async (label, p = page) => {
    const opts = await p.$$eval('#i2t-page option', os => os.map(o => ({ v: o.value, t: o.textContent })));
    const o = opts.find(x => x.t.replace(/^\d+\. /, '') === label);
    assert.ok(o, `page ${label} in ${JSON.stringify(opts)}`);
    await p.selectOption('#i2t-page', o.v);
  };
  const ocrFiles = [];
  page.on('request', r => { if (r.url().includes('/assets/vendor/tesseract/')) ocrFiles.push(r.url().slice(r.url().indexOf('/assets/'))); });
  page.on('filechooser', () => {});

  // ---- Starting state: nothing of the OCR engine is loaded ----
  await open();
  let s = await state();
  assert.equal(await page.isVisible('#i2t-placeholder'), true);
  assert.equal(s.outHidden, true);
  assert.equal(await page.isVisible('#i2t-page-bar'), false);
  assert.equal(s.busy, false);
  assert.equal(await page.isVisible('#i2t-also-row'), false, 'no "also English" box while English is chosen');
  assert.equal(s.size, 'Before reading, the page downloads about 4.5 MB from this site: the OCR engine (1.5 MB) and English data (3.0 MB). Nothing is uploaded.');
  assert.equal(await page.getAttribute('#i2t-error', 'role'), 'alert');
  assert.equal(await page.getAttribute('#i2t-status', 'role'), 'status');
  assert.equal(await page.getAttribute('#i2t-bar', 'aria-label'), 'Reading progress');
  await page.waitForTimeout(300);
  assert.deepEqual(ocrFiles, [], 'no OCR file is downloaded before the visitor starts');
  assert.ok(await page.$('.prose a[href="/pdf-to-text/"]'), 'the guide sends PDFs that hold text to PDF to Text');

  // ---- The sample, from the keyboard ----
  const seen = [];
  await page.exposeFunction('i2tSeen', t => seen.push(t));
  await page.evaluate(() => new MutationObserver(() => window.i2tSeen(document.querySelector('#i2t-status').textContent))
    .observe(document.querySelector('#i2t-status'), { childList: true, characterData: true, subtree: true }));
  await page.focus('#i2t-sample');
  await page.keyboard.press('Enter');
  await done();
  s = await state();
  assert.deepEqual(lines(s.text), lines(expected.sample), 'the sample is read word for word');
  assert.deepEqual(s.rows.map(r => r.text), lines(expected.sample));
  assert.deepEqual(s.rows.map(r => r.n), ['1', '2', '3', '4']);
  for (const r of s.rows) assert.ok(r.conf >= 85 && r.conf <= 100 && !r.check, `confidence of "${r.text}": ${r.conf}`);
  assert.match(s.status, /^Read 4 lines from sample\.png, average confidence (8[5-9]|9\d|100)%\.$/);
  assert.equal(s.count, '4 lines, 23 words');
  assert.equal(s.alt, 'sample.png: 4 lines of text outlined');
  assert.deepEqual(s.tags, ['1', '2', '3', '4']);
  assert.equal(s.boxes.length, 4);
  assert.equal(s.size, 'The OCR engine is loaded, with English data. Nothing is uploaded.');
  assert.ok(seen.includes('Downloading the OCR engine (1.5 MB)…'), `statuses: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes('Downloading English data (3.0 MB)…'), `statuses: ${JSON.stringify(seen)}`);
  assert.ok(ocrFiles.includes('/assets/vendor/tesseract/lang/eng.traineddata.gz'));
  assert.ok(ocrFiles.some(f => /\/core\/tesseract-core-(relaxedsimd-|simd-)?lstm\.wasm\.js$/.test(f)), JSON.stringify(ocrFiles));
  assert.ok(!ocrFiles.some(f => /\/lang\/(?!eng)/.test(f)), 'only the English data is downloaded');
  // The boxes sit on the lines: line 1 (the heading) above line 2, all inside the picture.
  const top = b => Math.min(...b.pts.map(p => p[1])), bottom = b => Math.max(...b.pts.map(p => p[1]));
  for (let i = 1; i < s.boxes.length; i++) assert.ok(bottom(s.boxes[i - 1]) <= top(s.boxes[i]) + 2, 'lines in reading order, one under the other');
  const vb = (await page.getAttribute('#i2t-boxes', 'viewBox')).split(' ').map(Number);
  for (const b of s.boxes) for (const [x, y] of b.pts) assert.ok(x >= 0 && y >= 0 && x <= vb[2] && y <= vb[3], 'box inside the picture');
  // The heading of the sample (bold, 26 px) is the first line, in the top quarter of the picture.
  assert.ok(bottom(s.boxes[0]) < vb[3] * 0.3 && top(s.boxes[3]) > vb[3] * 0.6, JSON.stringify(s.boxes.map(b => [top(b), bottom(b)])));

  // ---- Copy and download act on the text as it stands ----
  await page.click('#i2t-copy');
  assert.equal(await clip(page), s.text);
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#i2t-download')]);
  assert.equal(dl.suggestedFilename(), 'sample.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), s.text);

  // ---- Join lines into paragraphs, and edits that a rebuild replaces ----
  const unjoined = s.text;
  await page.check('#i2t-join');
  s = await state();
  // A paragraph ends after a line that stops well short of the others (the heading, and the
  // Saturday line); the other line breaks become spaces.
  assert.equal(s.text.replace(/\n\n/g, '\n'), 'Library opening hours\nMonday to Friday: 9:00 to 18:30 Saturday: 10:00 to 16:00\nClosed on Sundays and bank holidays');
  assert.equal(s.text.replace(/\s+/g, ' '), unjoined.replace(/\s+/g, ' '), 'the same words in the same order');
  await page.uncheck('#i2t-join');
  assert.equal((await state()).text, unjoined);
  await page.click('#i2t-text');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' (checked)');
  assert.equal(await page.isVisible('#i2t-restore'), false);
  await page.check('#i2t-join');
  assert.equal(await page.isVisible('#i2t-restore'), true, 'a rebuild over edited text offers the edits back');
  assert.ok(!(await state()).text.includes('(checked)'));
  await page.click('#i2t-restore-btn');
  s = await state();
  assert.equal(s.text, unjoined + ' (checked)');
  assert.equal(s.status, 'Your edited text is back.');
  assert.equal(await page.isVisible('#i2t-restore'), false);
  await page.click('#i2t-copy');
  assert.equal(await clip(page), unjoined + ' (checked)', 'Copy takes the edited text');
  await page.uncheck('#i2t-join');

  // ---- Lines ending in a hyphen join without a space ----
  await page.click('#i2t-clear');
  assert.equal((await state()).outHidden, true);
  assert.equal(await page.isVisible('#i2t-placeholder'), true);
  // (A double click on the sample reads it once.)
  await clearStatus();
  await page.dblclick('#i2t-sample');
  await done();
  assert.deepEqual((await state()).options, ['1. sample.png'], 'a double click adds the sample once');
  await page.click('#i2t-clear');
  await add('hyphen.png');
  s = await state();
  assert.deepEqual(lines(s.text), lines(expected.hyphen));
  await page.check('#i2t-join');
  assert.equal((await state()).text, 'The test checks a well-known rule for lines that end in a hyphen: a long-awaited answer at last.');
  await page.uncheck('#i2t-join');
  // Layout: One line reads the whole picture as a single line.
  await clearStatus();
  await page.selectOption('#i2t-layout', '7');
  await done();
  assert.equal((await state()).rows.length, 1, 'one line with Layout set to One line');
  await clearStatus();
  await page.selectOption('#i2t-layout', '3');
  await done();
  assert.deepEqual((await state()).rows.map(r => r.text), lines(expected.hyphen));

  // ---- Many formats at once: EXIF orientation, HEIC, AVIF, TIFF, a cut-off PNG ----
  await page.click('#i2t-clear');
  await add(['para.png', 'turned.jpg', 'para.heic', 'para.avif', 'para.tif', 'cut.png']);
  s = await state();
  assert.equal(s.error, '');
  assert.deepEqual(s.options, ['1. para.png', '2. turned.jpg', '3. para.heic', '4. para.avif', '5. para.tif', '6. cut.png']);
  assert.match(s.status, /^Read 6 pages: \d+ lines, average confidence \d+%\.$/);
  for (const name of ['para.png', 'turned.jpg', 'para.heic', 'para.avif', 'para.tif']) {
    assert.deepEqual(lines(section(s.text, name)), lines(expected.para), `${name} read word for word`);
  }
  assert.equal(lines(section(s.text, 'cut.png'))[0], expected.cut_first_line);
  await show('turned.jpg');
  s = await state();
  assert.deepEqual(s.notes, ['Turned upright using the photo’s orientation tag.']);
  assert.deepEqual(s.rows.map(r => r.text), lines(expected.para));
  assert.equal(await page.textContent('#i2t-lines-h'), 'Lines and confidence: turned.jpg');
  await show('cut.png');
  s = await state();
  assert.deepEqual(s.notes, ['The file seems to be cut off, so part of the picture may be blank.']);
  assert.equal(s.rows[0].text, expected.cut_first_line);
  assert.equal(s.rows[0].check, false);
  // What is left of the half-drawn second line is garbage, and is marked so.
  assert.ok(s.rows.slice(1).every(r => r.check && r.conf < 80), JSON.stringify(s.rows));
  assert.ok(s.boxes.slice(1).every(b => b.low) && !s.boxes[0].low, 'low lines are dashed on the picture');
  assert.match(s.alt, /^cut\.png: \d lines of text outlined, \d lines? to check$/);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#i2t-download')]);
  assert.equal(dl.suggestedFilename(), 'image-text.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), s.text);
  // Without page headings the pages are only separated by blank lines.
  await page.uncheck('#i2t-heads');
  assert.ok(!(await state()).text.includes('--- '));
  await page.check('#i2t-heads');
  // Remove a page: its text goes too. (A double click removes only the one shown.)
  await show('para.heic');
  await page.dblclick('#i2t-remove');
  s = await state();
  assert.equal(s.status, 'Removed para.heic.');
  assert.equal(s.options.length, 5);
  assert.ok(!s.text.includes('--- para.heic ---'));
  assert.equal(s.shown, '3. para.avif', 'the next page is shown');

  // ---- Small text is enlarged, shadows are evened out, dark pictures inverted ----
  await page.click('#i2t-clear');
  await add(['small.png', 'shadow.png', 'dark.png', 'ui.png', 'skew.png']);
  s = await state();
  assert.deepEqual(lines(section(s.text, 'small.png')), lines(expected.small));
  assert.deepEqual(lines(section(s.text, 'shadow.png')), lines(expected.shadow));
  assert.deepEqual(lines(section(s.text, 'dark.png')), lines(expected.dark));
  const ui = lines(expected.ui);
  assert.equal(section(s.text, 'ui.png'), ui[0] + '\n\n' + ui.slice(1).join('\n'),
    'white text in a dark bar survives evening out the light, and the gap under the bar is a blank line');
  assert.deepEqual(lines(section(s.text, 'skew.png')), lines(expected.para));
  await show('small.png');
  assert.deepEqual((await state()).notes, ['Enlarged 3× because the text is small.']);
  await show('dark.png');
  assert.deepEqual((await state()).notes, ['Light text on a dark background: the picture was inverted before reading.']);
  // The picture shown, as stored, and as the OCR engine gets it.
  const shown = () => page.evaluate(async () => {
    const im = document.querySelector('#i2t-img');
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, other = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (!(d[i] === d[i + 1] && d[i] === d[i + 2] && (d[i] === 0 || d[i] === 255))) other++;
    }
    return { mean: sum / (d.length / 4), grey: other };
  });
  assert.ok((await shown()).mean < 80, 'the dark picture as it is');
  await page.check('#i2t-asread');
  assert.ok((await shown()).mean > 200, 'as it is read: inverted to dark text on light');
  assert.equal((await state()).alt, 'dark.png, as it is read: 2 lines of text outlined');
  await page.uncheck('#i2t-asread');
  await show('ui.png');
  assert.deepEqual((await state()).notes, ['Enlarged 3× because the text is small.']);
  await show('skew.png');
  s = await state();
  assert.deepEqual(s.notes, ['Straightened by 4°.']);
  // The text in skew.png rises to the right by 4 degrees, and so must its outlines.
  for (const b of s.boxes) {
    const [tl, tr] = b.pts, slope = (tl[1] - tr[1]) / (tr[0] - tl[0]);
    assert.ok(slope > 0.05 && slope < 0.09, `outline tilted like the text (tan 4° = 0.07): ${slope}`);
  }
  // Settings apply to every page and read them again.
  await clearStatus();
  await page.selectOption('#i2t-enlarge', '1');
  await done();
  await show('small.png');
  assert.deepEqual((await state()).notes, [], 'no enlarging with Enlarge small text off');
  await clearStatus();
  await page.selectOption('#i2t-enlarge', '2');
  await done();
  await show('small.png');
  s = await state();
  assert.deepEqual(s.notes, ['Enlarged 2×.']);
  assert.deepEqual(s.rows.map(r => r.text), lines(expected.small));
  await page.selectOption('#i2t-enlarge', 'auto');
  await done();
  await clearStatus();
  await page.uncheck('#i2t-clean');
  await done();
  await show('dark.png');
  assert.deepEqual((await state()).notes, [], 'not inverted with clean-up off');
  await clearStatus();
  await page.check('#i2t-bw');
  await done();
  s = await state();
  assert.deepEqual(lines(section(s.text, 'small.png')), lines(expected.small), 'black and white alone');
  await clearStatus();
  await page.check('#i2t-clean');
  await done();
  s = await state();
  assert.deepEqual(lines(section(s.text, 'shadow.png')), lines(expected.shadow), 'evened out, then black and white');
  await show('shadow.png');
  await page.check('#i2t-asread');
  assert.equal((await shown()).grey, 0, 'black and white: every pixel is black or white');
  await page.uncheck('#i2t-asread');
  assert.ok((await shown()).grey > 1000, 'the photo itself has greys');
  assert.deepEqual(lines(section(s.text, 'dark.png')), lines(expected.dark));
  // Faint grey print: Otsu's level falls between the letters and the paper, so the letters
  // turn black (a fixed level of 128 would turn them white, and nothing would be read).
  await page.click('#i2t-clear');
  await add('faint.png');
  s = await state();
  assert.deepEqual(lines(s.text), lines(expected.faint), 'faint print read in black and white');
  await page.check('#i2t-asread');
  const faint = await shown();
  assert.ok(faint.grey === 0 && faint.mean < 245, `the letters are black as read: ${JSON.stringify(faint)}`);
  await page.uncheck('#i2t-asread');
  await page.uncheck('#i2t-bw');
  await done();

  // ---- Rotate page: a picture stored sideways without an orientation tag ----
  await page.click('#i2t-clear');
  await add('sideways.png');
  s = await state();
  assert.notDeepEqual(lines(s.text), lines(expected.para));
  // Read sideways, little is certain: the page suggests turning it, or choosing the language
  // (gibberish comes from either).
  const unsure = 'If the text is not in English, choose its language under Language of the text. If it is sideways or upside down, press Rotate page.';
  assert.match(s.status, /^Read \d+ lines? from sideways\.png, average confidence [1-4]?\d%; \d+ lines? to check\. /);
  assert.ok(s.status.endsWith(' to check. ' + unsure), s.status);
  assert.deepEqual(s.notes, ['Little of this page was read with confidence. ' + unsure]);
  await clearStatus();
  await page.click('#i2t-rotate');
  await done();
  s = await state();
  assert.deepEqual(lines(s.text), lines(expected.para), 'read upright after one turn clockwise');
  assert.deepEqual(s.notes, ['Turned 90° clockwise.']);
  assert.ok(!s.status.includes('Rotate page'), s.status);

  // ---- A picture of more than 16 megapixels is made smaller in the decoder's worker ----
  await page.click('#i2t-clear');
  await add('big.png');
  s = await state();
  assert.deepEqual(lines(s.text), lines(expected.para));
  assert.deepEqual(s.notes, ['Reduced from 4800 \u00d7 3600 to 4618 \u00d7 3464 pixels to keep reading quick.']);

  // ---- PDFs: a scan, a text layer, a password ----
  // A PDF whose page tree is empty (written by some broken exporters): said so at once, where
  // nothing at all used to happen.
  await page.click('#i2t-clear');
  await page.setInputFiles('#i2t-file', fx('zero-pages.pdf'));
  await page.waitForFunction(() => document.querySelector('#i2t-error').textContent !== '', null, { timeout: 30000 });
  s = await state();
  assert.equal(s.error, 'zero-pages.pdf has no pages, so there is nothing to read. It may be damaged; try saving it again from the app that made it.');
  assert.deepEqual([s.status, s.outHidden, s.busy, s.options], ['', true, false, []]);
  await add(['scan.pdf', 'text.pdf']);
  s = await state();
  assert.deepEqual(s.options, ['1. scan.pdf, page 1', '2. scan.pdf, page 2', '3. text.pdf']);
  assert.deepEqual(lines(section(s.text, 'scan.pdf, page 1')), lines(expected.page1));
  assert.deepEqual(lines(section(s.text, 'scan.pdf, page 2')), lines(expected.page2));
  assert.equal(section(s.text, 'text.pdf'), expected.text_pdf, 'the text layer is copied exactly');
  await show('text.pdf');
  s = await state();
  assert.deepEqual(s.notes, ['The text was copied from the PDF file, not read from the picture.']);
  assert.equal(s.linesNote, 'This page’s text was copied from the PDF file, so there are no confidence scores.');
  assert.deepEqual(s.rows, []);
  await page.waitForFunction(() => !document.querySelector('#i2t-fig').hidden);
  await clearStatus();
  seen.length = 0;
  await page.uncheck('#i2t-pdftext');
  await done();
  await show('text.pdf');
  s = await state();
  assert.deepEqual(s.rows.map(r => r.text), lines(expected.text_pdf), 'read as a picture when the text layer is not used');
  assert.equal(s.linesNote, '');
  // The scanned pages read the same either way: only text.pdf is read again.
  assert.deepEqual(seen.filter(t => /^Reading /.test(t)), ['Reading 3 of 3: text.pdf…'], JSON.stringify(seen));
  await clearStatus();
  seen.length = 0;
  await page.check('#i2t-pdftext');
  await done();
  assert.equal(section((await state()).text, 'text.pdf'), expected.text_pdf);
  assert.deepEqual(seen.filter(t => /^Reading /.test(t)), ['Reading 3 of 3: text.pdf…'], JSON.stringify(seen));
  // A scan with only a reference number typed on it is still read from the picture; a scan
  // with its scanner's own invisible text layer has that text copied.
  await page.click('#i2t-clear');
  await add(['stamped.pdf', 'searchable.pdf']);
  s = await state();
  assert.deepEqual(lines(section(s.text, 'stamped.pdf')), lines(expected.para).concat(expected.stamp), 'the scan and its stamp are read');
  assert.equal(section(s.text, 'searchable.pdf'), expected.para, 'the stored text of a searchable scan is copied');
  await show('stamped.pdf');
  s = await state();
  assert.deepEqual(s.notes, ['This page is a scan with little text stored in the file, so the picture was read.']);
  assert.equal(s.rows.length, 4);
  await show('searchable.pdf');
  assert.deepEqual((await state()).notes, ['The text was copied from the PDF file, not read from the picture.']);
  // Limits: 50 files at a time, and 100 pages of a PDF (the guide says both).
  await page.click('#i2t-clear');
  await clearStatus();
  const tiny = fs.readFileSync(fx('tiny.pdf'));
  await page.setInputFiles('#i2t-file', [{ name: 'long.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('long.pdf')) }]
    .concat(Array.from({ length: 50 }, (_, i) => ({ name: `t${i + 1}.pdf`, mimeType: 'application/pdf', buffer: tiny }))));
  await done(page, 180000);
  s = await state();
  assert.equal(s.error, 'Only the first 50 of 51 files were added. Only the first 100 of the 101 pages of long.pdf were added. To read others, take them out first with Split PDF.');
  assert.equal(s.options.length, 149);
  assert.equal(s.options[99], '100. long.pdf, page 100');
  assert.equal(s.options[148], '149. t49.pdf');
  assert.equal(section(s.text, 'long.pdf, page 100'), 'Page 100');
  assert.equal(section(s.text, 't49.pdf'), 'Tiny page');
  assert.equal(s.status, 'Read 149 pages: 149 lines.');
  // A single PDF page with a text layer is summed up as copied.
  await page.click('#i2t-clear');
  await add('text.pdf');
  assert.equal((await state()).status, 'Copied 2 lines of text from text.pdf.');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#i2t-download')]);
  assert.equal(dl.suggestedFilename(), 'text.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), expected.text_pdf);

  await page.click('#i2t-clear');
  await clearStatus();
  await page.setInputFiles('#i2t-file', fx('locked.pdf'));
  await page.waitForSelector('#i2t-pw-box:not([hidden])');
  assert.equal(await page.textContent('#i2t-pw-label'), 'Password for locked.pdf');
  assert.equal((await state()).status, 'locked.pdf is locked with a password. Type the password that opens it.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'i2t-pw');
  assert.equal(await page.getAttribute('#i2t-pw', 'aria-describedby'), 'i2t-pw-error');
  await page.click('#i2t-pw-go');
  assert.equal(await page.textContent('#i2t-pw-error'), 'Type the password first.');
  assert.equal(await page.getAttribute('#i2t-pw', 'aria-invalid'), 'true');
  await page.fill('#i2t-pw', 'x'.repeat(5000));
  assert.ok((await page.$eval('#i2t-pw', el => el.value.length)) <= 1024, 'a pasted megabyte is cut to the field\u2019s 1,024 characters');
  await page.fill('#i2t-pw', 'sesame');
  assert.equal(await page.getAttribute('#i2t-pw', 'aria-invalid'), null, 'typing clears the error');
  assert.equal(await page.textContent('#i2t-pw-error'), '');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#i2t-pw-error').textContent !== '');
  assert.equal(await page.textContent('#i2t-pw-error'), 'That password is not right. Check it and try again.');
  assert.equal(await page.getAttribute('#i2t-pw', 'aria-invalid'), 'true');
  assert.equal((await state()).status, 'locked.pdf is locked with a password. Type the password that opens it.',
    'while the page waits for the password again, the status does not say it is still opening the file');
  await page.fill('#i2t-pw', 'open sesame');
  await page.keyboard.press('Enter');
  await done();
  s = await state();
  assert.equal(await page.isVisible('#i2t-pw-box'), false);
  assert.deepEqual(lines(section(s.text, 'locked.pdf, page 1')), lines(expected.page1));
  assert.deepEqual(lines(section(s.text, 'locked.pdf, page 2')), lines(expected.page2));
  // Skipping a locked file.
  await page.setInputFiles('#i2t-file', fx('locked.pdf'));
  await page.waitForSelector('#i2t-pw-box:not([hidden])');
  await page.click('#i2t-pw-skip');
  await page.waitForFunction(() => document.querySelector('#i2t-error').textContent !== '');
  assert.equal((await state()).error, 'locked.pdf was skipped: it needs a password.');
  assert.equal((await state()).options.length, 2, 'nothing added');
  // A PDF whose author forbids copying its text is not read, from its text or by OCR; PDF to Text
  // reads it with the permissions password. (The file is PDF to Text's fixture.)
  await page.setInputFiles('#i2t-file', path.join(fixtures, '..', 'pdf-to-text', 'nocopy.pdf'));
  await page.waitForFunction(() => /nocopy\.pdf/.test(document.querySelector('#i2t-error').textContent));
  assert.equal((await state()).error, 'nocopy.pdf was not read: its author does not allow copying its text. With its permissions password, PDF to Text can read it.');
  assert.equal((await state()).options.length, 2, 'nothing added');

  // ---- Files that are not pictures ----
  await clearStatus();
  const asBuffer = (name, mimeType) => ({ name, mimeType, buffer: fs.readFileSync(fx(name)) });
  // A PNG header that claims 20,000 x 20,000 pixels, and files the image reader names.
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(20000, 8);
  ihdr.writeUInt32BE(20000, 12);
  ihdr.set([8, 2, 0, 0, 0], 16);
  const odd = [
    { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), ihdr, Buffer.alloc(64)]) },
    { name: 'layers.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: Buffer.concat([Buffer.from('8BPS\u0000\u0001', 'latin1'), Buffer.alloc(200)]) },
    { name: 'photos.zip', mimeType: 'application/zip', buffer: Buffer.concat([Buffer.from([0x50, 0x4B, 3, 4]), Buffer.alloc(100)]) },
    { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(300)]) },
    { name: 'scan.tif', mimeType: 'image/tiff', buffer: Buffer.concat([Buffer.from([0x49, 0x49, 0x2B, 0, 8, 0, 0, 0]), Buffer.alloc(300)]) },
    { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnothing that a PDF needs\n', 'latin1') }
  ];
  await page.setInputFiles('#i2t-file', [asBuffer('notes.txt', 'text/plain'), asBuffer('fake.png', 'image/png'), { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }, ...odd]);
  await page.waitForFunction(() => /scan\.tif/.test(document.querySelector('#i2t-error').textContent) && document.querySelector('#i2t-progress').hidden);
  s = await state();
  const notPicture = ': this is not a picture or PDF the page can read. Use a JPG, PNG, WebP, HEIC, AVIF, GIF, BMP, TIFF, SVG or PDF file.';
  // The image reader's own explanation is passed on where it says more than "not a picture".
  assert.equal(s.error, 'empty.png is empty. broken.pdf is damaged or is not a valid PDF. notes.txt' + notPicture + ' fake.png' + notPicture +
    ' huge.png: The image is 20000 × 20000 pixels (400 megapixels), over the 100 megapixel limit for opening in a browser.' +
    ' layers.psd: Photoshop (PSD) files are not supported. Export a PNG or JPG from Photoshop first.' +
    ' photos.zip: This is a ZIP archive. Unzip it first, then add the images.' +
    ' clip.mp4: This looks like a video file, not a still image.' +
    ' scan.tif: BigTIFF files are not supported.');
  assert.equal(s.options.length, 2, 'pages that cannot be read are not kept');
  // Clear all while a password is asked for drops that PDF quietly, and the files chosen
  // with it, before and after it, and files chosen while it waited, as well.
  await page.setInputFiles('#i2t-file', [fx('para.png'), fx('locked.pdf'), fx('hyphen.png')]);
  await page.waitForSelector('#i2t-pw-box:not([hidden])');
  await page.setInputFiles('#i2t-file', fx('small.png'));
  await page.click('#i2t-clear');
  await page.waitForFunction(() => document.querySelector('#i2t-pw-box').hidden);
  await page.waitForTimeout(1500);
  s = await state();
  assert.equal(s.error, '');
  assert.deepEqual(s.options, [], 'nothing of that batch is added after Clear all');
  assert.equal(s.text, '');
  assert.equal(s.busy, false);
  assert.equal(s.outHidden, true);
  assert.equal(await page.isVisible('#i2t-placeholder'), true);
  assert.equal(await page.isVisible('#i2t-wait'), false, 'no cleared page is shown');
  assert.equal(s.status, 'Cleared.');
  await add('blank.png');
  s = await state();
  assert.equal(s.status, 'No text found in blank.png. If it has text, try Enlarge small text at 3×, another Layout, or turn the picture upright.');
  assert.equal(s.linesNote, 'No text was found on this page.');
  assert.deepEqual(s.notes, [], 'no claim of small text on an empty page');
  assert.equal(s.text, '');
  await page.click('#i2t-copy');
  assert.equal((await state()).status, 'There is no text to copy yet.');
  // A PNG with %PDF- in its metadata, where a PDF's header could be, is still a picture.
  await page.click('#i2t-clear');
  await add('pdfish.png');
  s = await state();
  assert.equal(s.error, '');
  assert.deepEqual(lines(s.text), lines(expected.para));
  // An HDR picture: the browser maps it into standard range, and the page says so.
  await page.click('#i2t-clear');
  await add('pq.avif');
  assert.deepEqual((await state()).notes, ['This is an HDR image. The browser mapped it into standard range before it was read.']);
  // A long file name is cut by whole characters for the download: an emoji is never split
  // (half of one is saved as a replacement character). Headless Chromium reports any name
  // that is not ASCII as "download", so the name the page asks for is read from the link.
  await page.click('#i2t-clear');
  await clearStatus();
  const emojiName = 'a'.repeat(79) + '\u{1F600}';
  await page.setInputFiles('#i2t-file', { name: emojiName + '.png', mimeType: 'image/png', buffer: fs.readFileSync(fx('small.png')) });
  await done();
  let downloads = 0;
  const countDownload = () => { downloads++; };
  page.on('download', countDownload);
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.i2tName = this.download; return click.call(this); };
  });
  await Promise.all([page.waitForEvent('download'), page.dblclick('#i2t-download')]);
  assert.equal(await page.evaluate(() => window.i2tName), emojiName + '.txt');
  assert.equal((await state()).status, 'Downloaded ' + emojiName + '.txt.');
  await page.waitForTimeout(500);
  page.off('download', countDownload);
  assert.equal(downloads, 1, 'a double click downloads the text once');

  // ---- Other languages: data is downloaded once per language ----
  // Read with the English data, Spanish letters come out wrong, as the guide says.
  await page.click('#i2t-clear');
  await add('spanish.png');
  assert.ok((await state()).text.includes('nifio'), (await state()).text);
  assert.ok((await page.textContent('body')).includes('the Spanish niño comes out as nifio'), 'the guide gives the example');
  // Upright Chinese read with the English data comes out as gibberish read with little confidence:
  // the advice names the language chosen, not only turning the page.
  await page.click('#i2t-clear');
  await add('chinese.png');
  s = await state();
  assert.ok(s.status.endsWith(' to check. ' + unsure), s.status);
  assert.ok(s.notes.includes('Little of this page was read with confidence. ' + unsure), JSON.stringify(s.notes));
  await page.click('#i2t-clear');
  await page.selectOption('#i2t-lang', 'spa');
  assert.equal(await page.isVisible('#i2t-also-row'), true);
  assert.equal((await state()).size, 'Before reading, the page downloads about 2.1 MB from this site: Spanish data (2.1 MB). Nothing is uploaded.');
  await add('spanish.png');
  s = await state();
  assert.deepEqual(lines(s.text), lines(expected.spanish), 'accents read with the Spanish data');
  assert.ok(ocrFiles.includes('/assets/vendor/tesseract/lang/spa.traineddata.gz'));
  await page.selectOption('#i2t-lang', 'chi_sim');
  await done();
  await page.click('#i2t-clear');
  await add('chinese.png');
  assert.deepEqual(lines((await state()).text), lines(expected.chinese), 'no spaces between Chinese characters');
  // English is still loaded in the engine from the first pictures: nothing more to download.
  await page.check('#i2t-also');
  assert.equal((await state()).size, 'The OCR engine is loaded, with Chinese (Simplified) and English data. Nothing is uploaded.');
  await done();
  assert.deepEqual(lines((await state()).text), lines(expected.chinese));
  await page.uncheck('#i2t-also');
  await done();
  // Arabic: read in logical order, and the box runs right to left.
  await page.click('#i2t-clear');
  await page.selectOption('#i2t-lang', 'ara');
  await add('arabic.png');
  assert.equal((await state()).text, expected.arabic);
  assert.equal(await page.getAttribute('#i2t-text', 'dir'), 'rtl');
  await page.selectOption('#i2t-lang', 'eng');
  await done();
  assert.equal(await page.getAttribute('#i2t-text', 'dir'), 'ltr', 'Latin letters (or none) run left to right');
  assert.deepEqual(ocrFiles.filter(f => f.includes('/lang/')), ['/assets/vendor/tesseract/lang/eng.traineddata.gz',
    '/assets/vendor/tesseract/lang/spa.traineddata.gz', '/assets/vendor/tesseract/lang/chi_sim.traineddata.gz',
    '/assets/vendor/tesseract/lang/ara.traineddata.gz'], 'each language is downloaded once');

  // ---- Paste and drop ----
  const png = b64 => `Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0))`;
  const paraB64 = fs.readFileSync(fx('para.png')).toString('base64');
  await page.click('#i2t-clear');
  await clearStatus();
  await page.evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${png(paraB64)}], 'image.png', { type: 'image/png' }));
    document.querySelector('#i2t-open').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await done();
  s = await state();
  assert.deepEqual(s.options, ['1. Pasted image 1']);
  assert.equal(await page.isVisible('#i2t-page-field'), false, 'no page list for a single page');
  assert.equal(await page.isVisible('#i2t-rotate'), true);
  assert.match(s.status, /^Read 3 lines from Pasted image 1, average confidence \d+%\.$/);
  assert.deepEqual(lines(s.text), lines(expected.para));
  // Text on the clipboard is not a picture.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    document.querySelector('#i2t-open').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  assert.equal((await state()).error, 'The clipboard holds text, not a picture. Copy an image or take a screenshot, then paste again.');
  // The Paste image button reads the clipboard.
  await page.evaluate(`navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([${png(fs.readFileSync(fx('hyphen.png')).toString('base64'))}], { type: 'image/png' }) })])`);
  await clearStatus();
  await page.dblclick('#i2t-paste');
  await done();
  s = await state();
  assert.deepEqual(s.options, ['1. Pasted image 1', '2. Pasted image 2']);
  assert.deepEqual(lines(section(s.text, 'Pasted image 2')), lines(expected.hyphen));
  await clearStatus();
  await page.evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${png(fs.readFileSync(fx('dark.png')).toString('base64'))}], 'dropped.png', { type: 'image/png' }));
    const stage = document.querySelector('#i2t-stage');
    stage.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    stage.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    stage.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await done();
  s = await state();
  assert.deepEqual(lines(section(s.text, 'dropped.png')), lines(expected.dark));
  assert.equal(await page.$eval('#i2t-stage', e => e.classList.contains('is-over')), false);

  // ---- A megabyte pasted into the text box stays responsive and is copied whole ----
  const big = ('Line of pasted text with words éè 😀 ' + '    '.repeat(10) + '\n').repeat(12000);
  await page.evaluate(t => navigator.clipboard.writeText(t), big);
  // (Into an empty box: pasting over a selection takes Chromium seconds on any long page of
  // this site, word counter included, whatever the page's own code does.)
  await page.fill('#i2t-text', '');
  await page.focus('#i2t-text');
  const t0 = Date.now();
  await page.keyboard.press('Control+V');
  await page.waitForFunction(n => document.querySelector('#i2t-text').value.length === n, big.length);
  assert.ok(Date.now() - t0 < 4000, `pasting a megabyte took ${Date.now() - t0} ms`);
  assert.equal((await state()).error, '', 'text pasted into the box is not taken for a picture');
  assert.equal((await state()).count, '12,000 lines, 84,000 words');
  await page.click('#i2t-copy');
  assert.equal((await clip(page)).length, big.length);
  // ...and the next rebuild offers it back.
  await page.check('#i2t-join');
  assert.equal(await page.isVisible('#i2t-restore'), true);
  await page.click('#i2t-restore-btn');
  assert.equal((await page.$eval('#i2t-text', el => el.value)).length, big.length);
  await page.uncheck('#i2t-join');

  // ---- Camera: Chromium's fake camera shows a test pattern ----
  await page.click('#i2t-clear');
  await page.click('#i2t-camera');
  await page.waitForSelector('#i2t-video:not([hidden])');
  assert.equal(await page.isVisible('#i2t-cam-bar'), true);
  assert.equal(await page.isVisible('#i2t-placeholder'), false);
  assert.equal((await state()).status, 'Camera on. Hold the text steady and fill the frame, then press Capture.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'i2t-capture');
  await clearStatus();
  await page.keyboard.press('Enter');
  // The camera bar goes, and the focus goes back to Take photo (it fell to the top of the page,
  // so a screen reader lost its place while the photo was read).
  await page.waitForFunction(() => document.querySelector('#i2t-cam-bar').hidden);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'i2t-camera', 'focus after Capture');
  await done();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'i2t-camera', 'focus once the photo is read');
  s = await state();
  assert.deepEqual(s.options, ['1. Photo 1']);
  assert.equal(await page.isVisible('#i2t-video'), false, 'the camera is off after the photo');
  assert.ok(/^(Read \d+ lines? from Photo 1|No text found in Photo 1)/.test(s.status), s.status);
  assert.equal(await page.isVisible('#i2t-fig'), true);
  await page.click('#i2t-camera');
  await page.waitForSelector('#i2t-video:not([hidden])');
  await page.focus('#i2t-cam-stop');
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('#i2t-video'), false);
  assert.equal((await state()).status, 'Camera off.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'i2t-camera', 'focus after Cancel');
  // A photo taken while a PDF waits for its password: the camera goes off at once, and the
  // photo is read once the PDF is dealt with.
  await page.setInputFiles('#i2t-file', fx('locked.pdf'));
  await page.waitForSelector('#i2t-pw-box:not([hidden])');
  await page.click('#i2t-camera');
  await page.waitForSelector('#i2t-video:not([hidden])');
  await page.dblclick('#i2t-capture');
  await page.waitForFunction(() => document.querySelector('#i2t-video').hidden, null, { timeout: 5000 });
  await clearStatus();
  await page.click('#i2t-pw-skip');
  await done();
  s = await state();
  assert.deepEqual(s.options, ['1. Photo 1', '2. Photo 2']);

  // ---- The main flow from the keyboard: Choose images opens the file chooser ----
  await page.click('#i2t-clear');
  await page.focus('#i2t-open');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await clearStatus();
  await chooser.setFiles(fx('para.png'));
  await done();
  assert.deepEqual(lines((await state()).text), lines(expected.para));
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name)), [], 'nothing kept in IndexedDB');

  // ---- Stop, an engine that cannot load, Continue: a fresh page with slow downloads ----
  const ctx = page.context();
  const p2 = await ctx.newPage();
  const p2errors = [];
  p2.on('pageerror', e => p2errors.push(e.message));
  let failLang = true;
  await p2.route('**/lang/eng.traineddata.gz', async route => {
    if (failLang) return route.fulfill({ status: 404, body: 'gone' });
    await new Promise(r => setTimeout(r, 3000));
    return route.continue();
  });
  // The tesseract.js workers alive on the page (terminated ones go within a moment).
  const ocrWorkers = async (want) => {
    for (let i = 0; i < 40; i++) {
      const n = p2.workers().filter(w => w.url().includes('/assets/vendor/tesseract/worker.min.js')).length;
      if (n === want || i === 39) return n;
      await p2.waitForTimeout(100);
    }
  };
  await p2.goto(url);
  await clearStatus(p2);
  await p2.setInputFiles('#i2t-file', fx('para.png'));
  await p2.waitForFunction(() => document.querySelector('#i2t-error').textContent !== '' && document.querySelector('#i2t-progress').hidden, null, { timeout: 30000 });
  s = await state(p2);
  assert.equal(s.error, 'The OCR engine could not be loaded. Check your connection and try again.');
  assert.equal(await p2.isVisible('#i2t-continue'), true);
  assert.match(s.status, /^0 pages of 1 read with the current settings\.$/);
  assert.equal(await ocrWorkers(0), 0, 'the half-started engine is ended');
  failLang = false;
  await p2.click('#i2t-continue');
  await p2.waitForFunction(() => /^Downloading English data/.test(document.querySelector('#i2t-status').textContent));
  assert.equal(await p2.getAttribute('#i2t-copy', 'aria-disabled'), 'true');
  // Playwright waits for an aria-disabled button to be enabled; a visitor can press it at once.
  await p2.focus('#i2t-copy');
  await p2.keyboard.press('Enter');
  s = await state(p2);
  assert.equal(s.status, 'Wait until the reading has finished, or press Stop.');
  assert.equal(s.busy, true);
  assert.equal(await clip(p2), await clip(page), 'nothing was copied');
  assert.equal(await p2.$eval('#i2t-text', el => el.readOnly), true);
  await p2.focus('#i2t-stop');
  await p2.keyboard.press('Enter');
  await done(p2);
  s = await state(p2);
  assert.equal(s.status, 'Stopped. 0 pages of 1 read with the current settings.');
  assert.equal(await p2.evaluate(() => document.activeElement.id), 'i2t-continue', 'the focus moves to Continue');
  assert.equal(await ocrWorkers(0), 0, 'Stop ends an engine that is still starting');
  assert.equal(s.size, 'Before reading, the page downloads about 4.5 MB from this site: the OCR engine (1.5 MB) and English data (3.0 MB). Nothing is uploaded.');
  await clearStatus(p2);
  await p2.keyboard.press('Enter');
  await done(p2);
  s = await state(p2);
  assert.deepEqual(lines(s.text), lines(expected.para), 'read in full after Continue');
  assert.equal(s.error, '');
  assert.equal(await p2.getAttribute('#i2t-copy', 'aria-disabled'), 'false');
  assert.equal(await ocrWorkers(1), 1);
  // Stop in the middle of reading a big picture ends the engine there and then.
  await clearStatus(p2);
  await p2.setInputFiles('#i2t-file', fx('big.png'));
  await p2.waitForFunction(() => document.querySelector('#i2t-bar').value >= 15 && /^Reading 2 of 2/.test(document.querySelector('#i2t-status').textContent));
  await p2.click('#i2t-stop');
  await done(p2);
  s = await state(p2);
  assert.equal(s.status, 'Stopped. 1 page of 2 read with the current settings.');
  assert.equal(s.size, 'Before reading, the page downloads about 4.5 MB from this site: the OCR engine (1.5 MB) and English data (3.0 MB). Nothing is uploaded.');
  assert.equal(await ocrWorkers(0), 0, 'the engine was ended');
  assert.deepEqual(p2errors, []);
  // The Back button: a language chosen before leaving comes back, with its download size.
  await p2.click('#i2t-clear');
  await p2.selectOption('#i2t-lang', 'deu');
  await p2.goto(base + '/');
  await p2.goBack();
  await p2.waitForFunction(() => document.querySelector('#i2t-lang'));
  const lang = await p2.$eval('#i2t-lang', el => el.value);
  if (lang === 'deu') {
    assert.equal(await p2.isVisible('#i2t-also-row'), true);
    assert.match((await state(p2)).size, /German data \(1\.3 MB\)/);
  } else assert.equal(await p2.isVisible('#i2t-also-row'), false);
  await p2.close();

  // ---- A phone with a touch screen ----
  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p3 = await phone.newPage();
  await p3.goto(url);
  for (const id of ['#i2t-open', '#i2t-paste', '#i2t-camera', '#i2t-sample']) {
    const h = await p3.$eval(id, el => el.getBoundingClientRect().height);
    assert.ok(h >= 44, `${id} is ${h}px tall on a phone`);
  }
  await p3.tap('#i2t-sample');
  await done(p3);
  s = await state(p3);
  assert.deepEqual(lines(s.text), lines(expected.sample));
  assert.ok(await p3.$eval('#i2t-text', el => parseFloat(getComputedStyle(el).fontSize) >= 16));
  for (const id of ['#i2t-copy', '#i2t-download', '#i2t-rotate', '#i2t-remove']) {
    const h = await p3.$eval(id, el => el.getBoundingClientRect().height);
    assert.ok(h >= 44, `${id} is ${h}px tall on a phone`);
  }
  assert.ok(await p3.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll on a phone');
  // A long file name is shortened in the middle so that the list box shows its end.
  await clearStatus(p3);
  await p3.setInputFiles('#i2t-file', { name: 'Screenshot 2026-11-21 at 09.41.27 of the quarterly report.png', mimeType: 'image/png', buffer: fs.readFileSync(fx('small.png')) });
  await done(p3);
  const fit = await p3.evaluate(() => {
    const sel = document.querySelector('#i2t-page'), cs = getComputedStyle(sel), c = document.createElement('canvas').getContext('2d');
    c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
    return [...sel.options].map(o => ({ text: o.text, fits: c.measureText(o.text).width <= room }));
  });
  assert.equal(fit.length, 2);
  assert.match(fit[1].text, /^2\. Screenshot .*\u2026.*report\.png$/);
  assert.ok(fit.every(o => o.fits), JSON.stringify(fit));
  assert.equal(section((await state(p3)).text, 'Screenshot 2026-11-21 at 09.41.27 of the quarterly report.png'), expected.small, 'the text keeps the whole name');
  // Held sideways, with the text on screen, Take photo brings the preview and the Capture button on
  // screen together (focusing Capture once scrolled the top 77 px of the preview off the screen).
  await p3.setViewportSize({ width: 844, height: 390 });
  await p3.evaluate(() => document.querySelector('#i2t-text').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p3.tap('#i2t-camera');
  await p3.waitForFunction(() => /^Camera on/.test(document.querySelector('#i2t-status').textContent) && document.querySelector('#i2t-video').videoWidth > 0);
  // The page scrolls smoothly (unless reduced motion is asked for), so where things end up is
  // measured once it has kept still for ten frames.
  await p3.evaluate(() => new Promise(done => {
    let last = scrollY, still = 0;
    const give = setTimeout(done, 3000);
    const tick = () => {
      if (scrollY !== last) { last = scrollY; still = 0; } else if (++still >= 10) { clearTimeout(give); done(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const camBox = await p3.evaluate(() => ({ preview: document.querySelector('#i2t-stage').getBoundingClientRect().top,
    capture: document.querySelector('#i2t-cam-bar').getBoundingClientRect().bottom, screen: innerHeight, bar: !document.querySelector('#i2t-cam-bar').hidden }));
  assert.ok(camBox.bar && camBox.preview >= 0 && camBox.capture <= camBox.screen + 1, 'camera off screen: ' + JSON.stringify(camBox));
  assert.equal(await p3.evaluate(() => document.activeElement.id), 'i2t-capture');
  await p3.tap('#i2t-cam-stop');
  await phone.close();

  // ---- The browser's language is the first guess for the text ----
  const taiwan = await page.context().browser().newContext({ locale: 'zh-TW' });
  const p4 = await taiwan.newPage();
  await p4.goto(url);
  assert.equal(await p4.$eval('#i2t-lang', el => el.value), 'chi_tra');
  assert.equal(await p4.isVisible('#i2t-also-row'), true);
  assert.equal((await state(p4)).size, 'Before reading, the page downloads about 3.2 MB from this site: the OCR engine (1.5 MB) and Chinese (Traditional) data (1.7 MB). Nothing is uploaded.');
  await taiwan.close();

  // ---- A new tab whose first request for the PDF reader fails, as a dropped connection leaves it ----
  // The browser keeps a module that failed to load as failed for the page, so asking for the same
  // address again cannot work: the next try must ask for it under another one.
  const fresh = await page.context().browser().newContext();
  const p5 = await fresh.newPage();
  const p5errors = [];
  p5.on('pageerror', e => p5errors.push(e.message));
  p5.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) p5errors.push(m.text()); });
  let readerAsks = 0;
  await p5.route(/\/pdfjs\/pdf\.min\.js(\?.*)?$/, route => (readerAsks++ ? route.fallback() : route.abort('connectionreset')));
  await p5.goto(url);
  await p5.setInputFiles('#i2t-file', fx('text.pdf'));
  await p5.waitForFunction(() => document.querySelector('#i2t-error').textContent);
  assert.equal((await state(p5)).error, 'The PDF reader could not be loaded. Check your connection and try again.');
  await clearStatus(p5);
  await p5.evaluate(() => { document.querySelector('#i2t-error').textContent = ''; });
  await p5.setInputFiles('#i2t-file', fx('text.pdf'));
  await p5.waitForFunction(() => document.querySelector('#i2t-error').textContent ||
    (document.querySelector('#i2t-progress').hidden && /^(Read |No text|Copied|Stopped)/.test(document.querySelector('#i2t-status').textContent)), null, { timeout: 60000 });
  assert.equal((await state(p5)).error, '', 'the reader loads on the next try');
  assert.equal((await state(p5)).status, 'Copied 2 lines of text from text.pdf.');
  assert.equal(readerAsks, 2);

  // ---- An open password with the euro sign ----
  // Split PDF's pdfdoc-password.pdf (AES-128) keeps its open password "café€" in PDFDocEncoding, where
  // € is 0xA0. PDF.js takes the low byte of each character (0xAC for €), so the page asks it again
  // with the other bytes the shared unlocker tries; before, that password was "not right".
  await p5.click('#i2t-clear');
  await clearStatus(p5);
  await p5.setInputFiles('#i2t-file', path.join(fixtures, '..', 'split-pdf', 'pdfdoc-password.pdf'));
  await p5.waitForSelector('#i2t-pw-box:not([hidden])');
  await p5.fill('#i2t-pw', 'café€');
  await p5.press('#i2t-pw', 'Enter');
  await p5.waitForFunction(() => document.querySelector('#i2t-pw-error').textContent !== '' ||
    /^(Read |No text|Copied|Stopped)/.test(document.querySelector('#i2t-status').textContent), null, { timeout: 60000 });
  assert.equal(await p5.textContent('#i2t-pw-error'), '', 'café€ opens pdfdoc-password.pdf');
  await done(p5);
  const euro = await state(p5);
  assert.deepEqual(lines(section(euro.text, 'pdfdoc-password.pdf, page 2')), ['PDFDoc 2', 'PDFDOC-MARK-02']);
  assert.equal(await p5.isVisible('#i2t-pw-box'), false);
  // A wrong password is still refused after the other encodings have been tried.
  await p5.click('#i2t-clear');
  await p5.setInputFiles('#i2t-file', path.join(fixtures, '..', 'split-pdf', 'pdfdoc-password.pdf'));
  await p5.waitForSelector('#i2t-pw-box:not([hidden])');
  await p5.fill('#i2t-pw', 'cafe€');
  await p5.press('#i2t-pw', 'Enter');
  await p5.waitForFunction(() => document.querySelector('#i2t-pw-error').textContent !== '');
  assert.equal(await p5.textContent('#i2t-pw-error'), 'That password is not right. Check it and try again.');
  assert.deepEqual(p5errors, []);
  await fresh.close();
};
