const fs = require('fs');
const os = require('os');
const path = require('path');

// The PDFs in tests/fixtures/pdf-to-text/ are written by make_fixtures.py from known text, which
// it saves in expected.json: the test compares what the page extracts with the text that was
// drawn, not with an earlier extraction. expected.json also records what poppler's pdftotext and
// pypdf make of the same files ("others"), for the cases where the page does something they do
// not (letter spacing, ligatures, hyphens, columns run on). The 1,000-page and 100 MB files are
// written here, by a small PDF writer.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const others = expected.others;
  const fx = name => path.join(fixtures, name);
  const clip = p => p.evaluate(() => navigator.clipboard.readText());
  const state = (p = page) => p.evaluate(() => ({
    status: document.querySelector('#p2t-status').textContent,
    error: document.querySelector('#p2t-error').textContent,
    text: document.querySelector('#p2t-text').value,
    count: document.querySelector('#p2t-count').textContent,
    flags: [...document.querySelectorAll('#p2t-flags li')].map(li => li.textContent),
    ocr: document.querySelector('#p2t-ocr').hidden ? '' : document.querySelector('#p2t-ocr-text').textContent,
    ocrButton: document.querySelector('#p2t-ocr-go').textContent,
    meta: document.querySelector('#p2t-file-line').hidden ? '' : document.querySelector('#p2t-name').textContent + ' | ' + document.querySelector('#p2t-meta').textContent,
    work: !document.querySelector('#p2t-work').hidden,
    busy: !document.querySelector('#p2t-progress').hidden,
    pagesError: document.querySelector('#p2t-pages-error').textContent,
    lock: document.querySelector('#p2t-lock-box').hidden ? '' : document.querySelector('#p2t-lock-text').textContent
  }));
  const clearStatus = (p = page) => p.evaluate(() => { document.querySelector('#p2t-status').textContent = ''; document.querySelector('#p2t-error').textContent = ''; });
  // A file is done when nothing is running and the status (or an error) says how it went.
  const settled = (p = page, timeout = 60000) => p.waitForFunction(() => document.querySelector('#p2t-progress').hidden &&
    (document.querySelector('#p2t-error').textContent || /^(?!Opening|Reading|Checking|Downloading|Starting).+/.test(document.querySelector('#p2t-status').textContent)), null, { timeout });
  const load = async (name, p = page) => {
    await clearStatus(p);
    await p.setInputFiles('#p2t-file', typeof name === 'string' && !path.isAbsolute(name) ? fx(name) : name);
    await settled(p);
    return state(p);
  };
  const mode = async (m, p = page) => { await p.check(`input[name="p2t-mode"][value="${m}"]`); return state(p); };
  const words = t => (t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]*[\p{L}\p{N}][^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]*/gu) || []).length;
  const fmt = n => n.toLocaleString('en-GB');
  const requests = [];
  page.on('request', r => { const u = r.url(); if (u.includes('/assets/vendor/')) requests.push(u.slice(u.indexOf('/assets/'))); });
  page.on('filechooser', () => {});

  // ---- The page as it opens: it says what to do, and loads nothing yet ----
  await open();
  let s = await state();
  assert.equal(await page.textContent('#p2t-intro'), 'Drop a PDF here, or choose one. Its text is read in your browser: nothing is uploaded.');
  assert.equal(s.work, false);
  assert.equal(await page.getAttribute('#p2t-status', 'role'), 'status');
  assert.equal(await page.getAttribute('#p2t-error', 'role'), 'alert');
  await page.waitForTimeout(300);
  assert.deepEqual(requests, [], 'no PDF reader or OCR engine is downloaded before a file is chosen');

  // ---- The sample, from the keyboard ----
  const seen = [];
  await page.exposeFunction('p2tSeen', t => seen.push(t));
  await page.evaluate(() => new MutationObserver(() => window.p2tSeen(document.querySelector('#p2t-status').textContent))
    .observe(document.querySelector('#p2t-status'), { childList: true, characterData: true, subtree: true }));
  await page.focus('#p2t-sample');
  await page.keyboard.press('Enter');
  await settled();
  s = await state();
  const sm = expected.sample;
  const sampleText = [sm.heading, sm.title, sm.para, sm.note, sm.rows.map(r => r.join('\t')).join('\n'), sm.foot].join('\n\n');
  assert.equal(s.text, sampleText, 'letter spacing closed up, the hyphen joined, the table kept in rows with tabs');
  assert.equal(s.status, `sample.pdf: ${fmt(words(sampleText))} words from 1 page.`);
  assert.equal(s.count, `${fmt(words(sampleText))} words \u00b7 ${fmt(Array.from(sampleText).length)} characters`);
  assert.equal(s.meta, 'sample.pdf | 1 page \u00b7 2 KB');
  assert.equal(await page.textContent('#p2t-open'), 'Choose another PDF\u2026');
  assert.deepEqual(seen.filter(t => t), ['Opening sample.pdf\u2026', 'Reading the text of sample.pdf\u2026', s.status], 'the result is announced once');
  assert.ok(requests.some(r => r.endsWith('/pdfjs/pdf.min.js')) && !requests.some(r => r.includes('/tesseract/')), JSON.stringify(requests));
  // Lines as in the PDF, and Layout (from the keyboard: the arrow keys move along the radio group).
  await page.focus('input[name="p2t-mode"][value="para"]');
  await page.keyboard.press('ArrowRight');
  s = await state();
  assert.equal(await page.$eval('input[name="p2t-mode"]:checked', el => el.value), 'lines');
  assert.equal(await page.isVisible('#p2t-hyph-row'), false, 'joining hyphens is an option of Paragraphs only');
  assert.ok(s.text.includes('hyphen at the end of a line, such as docu-\nments, and keeps the columns in reading order.'), s.text);
  assert.ok(s.text.includes('\nMonth\tVisits\nJanuary\t1,204\nFebruary\t1,876\n'));
  await page.keyboard.press('ArrowRight');
  s = await state();
  assert.equal(await page.getAttribute('#p2t-text', 'wrap'), 'off');
  assert.ok(await page.$eval('#p2t-text', el => /mono/i.test(getComputedStyle(el).fontFamily) || getComputedStyle(el).fontFamily.includes('Consolas')), 'Layout is shown in a fixed-width font');
  const lay = s.text.split('\n');
  const row = w => lay.find(l => l.includes(w));
  // The table's second column lines up (right-aligned numbers end at the same column), and sits
  // to the right of the paragraph beside it.
  assert.equal(row('January').indexOf('1,204') + 5, row('February').indexOf('1,876') + 5);
  assert.ok(row('Month').indexOf('Month') > row('A PDF stores').indexOf('drawn,') + 6, JSON.stringify([row('Month'), row('A PDF stores')]));
  await mode('para');

  // ---- Two columns, three pages, running heads ----
  s = await load('columns.pdf');
  const col = expected.columns;
  const tableText = col.table.map(r => r.join('\t')).join('\n');
  const colText = col.paragraphs.join('\n\n') + '\n\n' + col.intro + '\n\n' + tableText + '\n\n' + col.close;
  assert.equal(s.text, colText);
  assert.equal(s.status, `columns.pdf: ${fmt(words(colText))} words from 3 pages.`);
  assert.deepEqual(s.flags, []);
  // Where pdftotext (poppler 24.02, default mode) differs: it joins Jean-Paul without its hyphen,
  // puts each word of a widely spaced justified line on a line of its own, and keeps the running
  // heads. Like this page, it joins the split word and the compound split at its hyphen.
  const pt = others['columns.pdf'].pdftotext;
  assert.ok(pt.includes('JeanPaul Martin') && pt.includes('trust\nand\nwith\nlocal') && pt.includes('Ouse River Survey') && pt.includes('measurements') && pt.includes('wellknown'), pt.slice(0, 600));
  for (const p of col.paragraphs) assert.ok(s.text.includes(p), p);
  assert.ok(!s.text.includes('Ouse River Survey') && !s.text.includes('Page 2 of 3'));
  // Hyphens kept: the word, the compound and the name keep theirs, with no space after.
  await page.uncheck('#p2t-hyph');
  s = await state();
  assert.ok(s.text.includes('took measure-ments of depth'), 'the hyphen of a split word is kept, joined without a space');
  assert.ok(s.text.includes('A well-known problem') && s.text.includes('Jean-Paul Martin'));
  await page.check('#p2t-hyph');
  s = await state();
  assert.ok(s.text.includes('took measurements of depth') && s.text.includes('A wellknown problem') && s.text.includes('Jean-Paul Martin'),
    'a compound split at its own hyphen loses it (as the guide says); a capital after the hyphen keeps it');
  // Lines as in the PDF, page 1, without and with the running heads.
  await page.fill('#p2t-pages', '1');
  await page.press('#p2t-pages', 'Enter');
  s = await mode('lines');
  assert.equal(s.text, col.lines_page1.slice(2).join('\n'), 'the heads are left out even with one page chosen');
  await page.uncheck('#p2t-hf');
  s = await state();
  assert.equal(s.text, col.lines_page1.join('\n'));
  await page.check('#p2t-hf');
  await page.fill('#p2t-pages', '');
  await page.press('#p2t-pages', 'Enter');
  await mode('para');
  // Between pages.
  await page.selectOption('#p2t-breaks', 'marker');
  s = await state();
  assert.ok(s.text.startsWith('--- Page 1 ---\nThe Ouse river survey\n\n') && s.text.includes('\n\n--- Page 2 ---\naffected most, because') &&
    s.text.includes('\n\n--- Page 3 ---\n3. Measurements by site'), 'with page markers a paragraph cut by the page break is not joined');
  await page.selectOption('#p2t-breaks', 'ff');
  s = await state();
  assert.equal(s.text.split('\f').length - 1, 3, 'a form feed after each page, as pdftotext writes');
  assert.ok(s.text.endsWith(col.close + '\n\f'));
  assert.equal(s.text.split('\n\f').length, others['columns.pdf'].pdftotext.split('\f').length);
  await page.selectOption('#p2t-breaks', 'blank');
  // Layout: the columns side by side, and the table's numbers lined up.
  s = await mode('layout');
  const lines = s.text.split('\n');
  const at = t => lines.find(l => l.includes(t));
  const right = ['clearer than in the town centre', 'could be compared over the season.', 'Water samples from twelve sites'].map(t => at(t).indexOf(t));
  assert.ok(right[0] === right[1] && right[0] > 50, `the right column starts at one column of characters: ${right}`);
  assert.ok(at('clearer than in the town centre').startsWith('1. Introduction'), 'the left column\u2019s heading and the right column\u2019s first line share a row');
  const rowOf = t => lines.find(l => l.startsWith(t));
  for (const [a, b] of [['Naburn', '2.4'], ['Selby', '3.1'], ['Goole', '5.8']]) assert.equal(rowOf(a).indexOf(b), rowOf('Naburn').indexOf('2.4'), `${b} lines up`);
  assert.equal(rowOf('Selby').indexOf('15.0'), rowOf('Naburn').indexOf('14.5'));
  assert.equal(rowOf('Site').indexOf('Temperature (C)') + 15, rowOf('Goole').indexOf('15.5') + 4, 'the heading and the numbers end at one column');
  await mode('para');

  // ---- Copy and download act on the text as the options make it now ----
  await page.check('input[name="p2t-mode"][value="lines"]');
  await page.click('#p2t-copy');
  assert.equal(await clip(page), (await state()).text, 'Copy takes the text in the mode just chosen');
  let downloads = 0;
  const countDownload = () => { downloads++; };
  page.on('download', countDownload);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.dblclick('#p2t-download')]);
  assert.equal(dl.suggestedFilename(), 'columns.txt');
  const bytes = fs.readFileSync(await dl.path());
  assert.equal(bytes.toString('utf8'), (await state()).text, 'the .txt holds the text, in UTF-8');
  assert.ok(!bytes.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'no byte order mark');
  await page.waitForTimeout(500);
  page.off('download', countDownload);
  assert.equal(downloads, 1, 'a double click downloads once');
  assert.equal((await state()).status, 'Downloaded columns.txt.');
  await mode('para');

  // ---- Pages: a list, its mistakes, and other ways of writing numbers ----
  const pages = async (v, key = 'Enter') => { await page.fill('#p2t-pages', v); await page.press('#p2t-pages', key); return state(); };
  s = await pages('2');
  assert.equal(s.text, [col.paragraphs[8].split('lower reaches were ')[1], ...col.paragraphs.slice(9, 14)].join('\n\n'));
  s = await pages('3, 1');
  assert.ok(s.text.startsWith('3. Measurements by site\n\n' + col.intro + '\n\n' + tableText) && s.text.endsWith('and the lower reaches were'), 'pages in the order typed');
  const threeOne = s.text;
  assert.equal(await page.getAttribute('#p2t-pages', 'aria-describedby'), 'p2t-pages-error p2t-pages-hint');
  const listError = async (v, msg) => {
    const r = await pages(v);
    assert.equal(r.pagesError, msg, v);
    assert.equal(await page.getAttribute('#p2t-pages', 'aria-invalid'), 'true', v);
    return r;
  };
  const hint = ' Use numbers, dashes and commas, such as 1-3, 5.';
  await listError('1.5', '\u201c.\u201d cannot be used in a page list.' + hint);
  await listError('0', 'There is no page 0: the first page is 1.');
  await listError('4', 'Page 4 does not exist: this PDF has 3 pages.');
  // A comma separates pages: "1,5" is pages 1 and 5, never 1.5 or 15.
  await listError('1,5', 'Page 5 does not exist: this PDF has 3 pages.');
  await listError('1-2-3', 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.');
  await listError('first', '\u201cfirst\u201d is not a page number.' + hint);
  await listError('\u00b2', '\u201c\u00b2\u201d cannot be used in a page list.' + hint);
  await listError('1\u066c000', '\u201c\u066c\u201d cannot be used in a page list.' + hint);
  s = await listError('\u200b2', 'A hidden character (U+200B) cannot be used in a page list.' + hint);
  assert.equal(s.text, threeOne, 'a mistake leaves the text as it was');
  // A mistake shows only once the field is left or Enter pressed, and goes as soon as it is fixed.
  await page.fill('#p2t-pages', '2-');
  await page.waitForTimeout(600);
  assert.equal((await state()).pagesError, '', 'no error while a range is still being typed');
  s = await pages('\uff12');
  assert.equal(s.pagesError, '');
  assert.equal(await page.getAttribute('#p2t-pages', 'aria-invalid'), null);
  assert.ok(s.text.startsWith('affected most'), 'full-width 2 is page 2');
  s = await pages('\u0663', 'Tab');
  assert.ok(s.text.startsWith('3. Measurements by site'), 'Arabic-Indic 3 is page 3, applied when the field is left');
  // A megabyte pasted into the field is refused before any pattern runs.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  let t0 = await threadMs();
  await page.$eval('#p2t-pages', el => { el.value = '1-'.repeat(524288); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal((await state()).pagesError, 'This list is 1,048,576 characters long. Keep it under 1,000 characters.');
  assert.ok(await threadMs() - t0 < 1500, `a megabyte list took ${Math.round(await threadMs() - t0)} ms of CPU`);
  await page.click('#p2t-copy');
  assert.equal((await state()).status, 'Correct the list of pages first.', 'nothing is copied while the list holds a mistake');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2t-pages');
  await pages('');
  assert.equal((await state()).text, colText);
  // The list stays for the next file, and is checked against it.
  await pages('2-3');
  s = await load('sample.pdf');
  assert.equal(s.pagesError, 'Page 2 does not exist: this PDF has 1 page.');
  assert.equal(s.status, 'The list of pages does not fit sample.pdf: correct it to read the text.');
  assert.equal(s.text, '');
  await pages('1');
  await settled();
  assert.equal((await state()).text, sampleText);
  s = await load('columns.pdf');
  assert.equal(s.text, col.paragraphs.slice(0, 9).join('\n\n').replace(/ affected most.*$/, ''), 'page 1 of the next file');
  await pages('');

  // ---- Letter spacing, kerning and dot leaders ----
  s = await load('spacing.pdf');
  s = await mode('lines');
  assert.equal(s.text, expected.spacing.join('\n'));
  // pdftotext and pypdf each get one of the first three wrong.
  assert.ok(!others['spacing.pdf'].pdftotext.includes('OFFICE OF MANAGEMENT AND BUDGET'), 'pdftotext splits the kerned heading');
  assert.ok(others['spacing.pdf'].pypdf.includes('S U M M A R Y'), 'pypdf leaves the TJ-spaced heading spaced out');
  await mode('para');

  // ---- Ligatures, Chinese, Japanese, Hebrew and Arabic ----
  s = await load('scripts.pdf');
  const sc = expected.scripts;
  s = await mode('lines');
  assert.equal(s.text, [...sc.ligatures, ...sc.zh_lines, ...sc.ja_lines, sc.he, sc.ar, 'Total 42 ' + sc.mixed_he].join('\n'));
  assert.ok(others['scripts.pdf'].pdftotext.includes('\ufb01') && others['scripts.pdf'].pypdf.includes('\ufb01'), 'pdftotext and pypdf keep the ligature characters');
  s = await mode('para');
  assert.ok(s.text.includes('\n\n' + sc.zh + '\n\n' + sc.ja + '\n\n'), 'Chinese and Japanese lines join without a space');
  assert.ok(others['scripts.pdf'].pdftotext.includes(sc.he) && others['scripts.pdf'].pypdf.includes(sc.he), 'the other programs agree on the order of the Hebrew');

  // ---- Characters that are not letters ----
  s = await load('symbols.pdf');
  s = await mode('lines');
  assert.equal(s.text, expected.symbols.page1 + '\n\n' + expected.symbols.page2, 'private-use and replacement characters are kept as they are');
  assert.equal(others['symbols.pdf'].pdftotext.replace(/\s+/g, ''), (expected.symbols.page1 + expected.symbols.page2).replace(/\s+/g, ''), 'pdftotext gives the same');
  assert.deepEqual(s.flags, ['Page 1: 3 characters that its fonts do not match to letters, shown as \ufffd or as symbols.',
    'Page 2: 23 characters that its fonts do not match to letters, shown as \ufffd or as symbols. Reading the page with OCR may do better.']);
  assert.equal(s.ocr, 'Page 2 can be read with OCR, which finds the letters in the picture of a page. OCR makes mistakes: check what it reads.');
  assert.ok(await page.$eval('#p2t-flags li', li => li.classList.contains('is-warn')));
  await mode('para');

  // ---- Form fields ----
  s = await load('form.pdf');
  assert.equal(await page.textContent('#p2t-fields-row'), ' Add filled-in form fields (3)');
  assert.equal(s.text, expected.form.text.join('\n\n') + '\n\n' + expected.form.fields.join('\n'));
  assert.ok(!s.text.includes('reviewer note'), 'a comment is not page text');
  await page.uncheck('#p2t-fields');
  assert.equal((await state()).text, expected.form.text.join('\n\n'));
  await page.check('#p2t-fields');

  // ---- Structures: object streams, linearised, PDF 2.0, an update, turned and cropped pages ----
  const st = expected.structures;
  for (const name of ['objstm.pdf', 'linearized.pdf', 'pdf20.pdf', 'badxref.pdf']) {
    s = await load(name);
    assert.equal(s.text, st.two.join('\n\n'), name);
    assert.equal(s.error, '', name);
  }
  s = await load('incremental.pdf');
  assert.equal(s.text, st.updated + '\n\n' + st.two[1], 'the text of the latest update');
  s = await load('rotated.pdf');
  assert.equal(s.text, st.rotated.slice(0, 5).join('\n\n'), 'turned pages read the right way; text outside the crop box is not shown, so not taken');
  assert.ok(others['rotated.pdf'].pdftotext.includes(st.rotated[5]), 'pdftotext takes it');
  assert.equal(s.meta, 'rotated.pdf | 5 pages \u00b7 3 KB');

  // ---- Damaged files, and files that are not PDFs ----
  s = await load('cut-tail.pdf');
  assert.equal(s.text, st.three.join('\n\n'), 'a file cut after its last page is repaired');
  s = await load('badpage.pdf');
  assert.equal(s.text, st.three[0] + '\n\n' + st.three[2]);
  assert.deepEqual(s.flags, ['Page 2 has no text to copy: it is probably a scan or a picture.']);
  for (const name of ['cut.pdf', 'garbage.pdf']) {
    s = await load(name);
    assert.equal(s.error, `${name} is damaged or is not a valid PDF. Try saving it again from the app that made it.`);
    assert.equal(s.work, false);
    assert.equal(s.status, '');
  }
  s = await load('notpdf.pdf');
  assert.equal(s.error, 'notpdf.pdf is not a PDF file.');
  s = await load('word.pdf');
  assert.equal(s.error, 'word.pdf is not a PDF file. It is a ZIP file, or a Word, Excel or PowerPoint document.');
  s = await load({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
  assert.equal(s.error, 'empty.pdf is empty: it has 0 bytes.');
  s = await load({ name: 'photo.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100)]) });
  assert.equal(s.error, 'photo.pdf is not a PDF file. It is a picture: copy its text with Image to Text.');

  // ---- Passwords ----
  const lk = expected.locked;
  const unlock = async (name, pw) => {
    await clearStatus();
    await page.setInputFiles('#p2t-file', fx(name));
    await page.waitForSelector('#p2t-pw-box:not([hidden])');
    await page.fill('#p2t-pw', pw);
    await page.press('#p2t-pw', 'Enter');
    await settled();
    return state();
  };
  for (const name of ['rc4-40.pdf', 'rc4-128.pdf', 'aes-128.pdf', 'aes-256.pdf']) {
    s = await unlock(name, lk.password);
    assert.equal(s.text, lk.text, name);
    assert.ok(s.meta.endsWith(' \u00b7 unlocked'), s.meta);
  }
  // Passwords with letters outside ASCII: stored as PDFDocEncoding (AES-128), UTF-8 (AES-256) and
  // Latin-1 (RC4) by the programs that wrote them.
  for (const [name, pw] of [['unicode-aes-128.pdf', lk.unicode], ['unicode-aes-256.pdf', lk.unicode], ['latin1-rc4.pdf', lk.latin1]]) {
    s = await unlock(name, pw);
    assert.equal(s.text, lk.text, name);
  }
  await clearStatus();
  await page.setInputFiles('#p2t-file', fx('aes-256.pdf'));
  await page.waitForSelector('#p2t-pw-box:not([hidden])');
  assert.equal(await page.textContent('#p2t-pw-label'), 'Password for aes-256.pdf');
  assert.equal((await state()).status, 'aes-256.pdf is locked with a password. Type the password that opens it.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2t-pw');
  assert.equal(await page.getAttribute('#p2t-pw', 'aria-describedby'), 'p2t-pw-error');
  await page.click('#p2t-pw-go');
  assert.equal(await page.textContent('#p2t-pw-error'), 'Type the password first.');
  assert.equal(await page.getAttribute('#p2t-pw', 'aria-invalid'), 'true');
  await page.fill('#p2t-pw', 'x'.repeat(5000));
  assert.equal(await page.$eval('#p2t-pw', el => el.value.length), 1024, 'a pasted megabyte is cut to 1,024 characters');
  await page.fill('#p2t-pw', 'sesame');
  assert.equal(await page.getAttribute('#p2t-pw', 'aria-invalid'), null, 'typing clears the error');
  await page.press('#p2t-pw', 'Enter');
  await page.waitForFunction(() => document.querySelector('#p2t-pw-error').textContent !== '');
  assert.equal(await page.textContent('#p2t-pw-error'), 'That password is not right. Check it and try again.');
  assert.equal(await page.getAttribute('#p2t-pw', 'aria-invalid'), 'true');
  await page.click('#p2t-pw-cancel');
  s = await state();
  assert.equal(s.error, 'aes-256.pdf was not opened: it needs a password.');
  assert.equal(await page.isVisible('#p2t-pw-box'), false);

  // ---- Permissions: printing forbidden is no obstacle; copying forbidden needs the permissions password ----
  s = await load('noprint.pdf');
  assert.equal(s.text, lk.text);
  s = await load('nocopy.pdf');
  assert.equal(s.lock, 'The author of nocopy.pdf does not allow copying its text. As on Unlock PDF, this page lifts that only with the file\u2019s permissions password.');
  assert.equal(s.work, false);
  assert.equal(s.text, '', 'no text is shown');
  assert.equal(s.status, 'Copying the text of nocopy.pdf is not allowed. Type its permissions password to extract it.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2t-owner');
  assert.equal(await page.getAttribute('#p2t-owner', 'aria-describedby'), 'p2t-owner-error p2t-owner-hint');
  await page.click('#p2t-owner-go');
  assert.equal(await page.textContent('#p2t-owner-error'), 'Type the permissions password first.');
  await page.fill('#p2t-owner', lk.password);
  await page.press('#p2t-owner', 'Enter');
  await page.waitForFunction(() => document.querySelector('#p2t-owner-error').textContent !== '');
  assert.equal(await page.textContent('#p2t-owner-error'), 'That is not the permissions password of this file. Check it and try again.');
  assert.equal(await page.getAttribute('#p2t-owner', 'aria-invalid'), 'true');
  assert.ok(!requests.some(r => r.includes('/tesseract/')));
  await page.fill('#p2t-owner', lk.permissions);
  await page.press('#p2t-owner', 'Enter');
  await settled();
  s = await state();
  assert.equal(s.text, lk.text);
  assert.deepEqual(s.flags, ['Its author does not allow copying its text; with its permissions password the text is read anyway.']);
  // The open password is not the permissions password.
  s = await unlock('nocopy-locked.pdf', lk.password);
  assert.ok(s.lock.startsWith('The author of nocopy-locked.pdf does not allow copying its text.'));
  assert.equal(s.text, '');

  // ---- Scans: listed, and read with OCR on request ----
  s = await load('stamped.pdf');
  assert.deepEqual(s.flags, ['Page 1 is a scan with only a few words stored as text.']);
  assert.equal(s.text, expected.scan.stamp);
  s = await load('mixed-scan.pdf');
  assert.equal(s.text, expected.scan.cover);
  assert.deepEqual(s.flags, ['Page 2 has no text to copy: it is probably a scan or a picture.']);
  assert.equal(s.ocrButton, 'Read page 2 with OCR');
  assert.equal(await page.textContent('#p2t-ocr-size'), 'Before reading, the page downloads about 4.5 MB from this site: the OCR engine (1.5 MB) and English data (3.0 MB). Nothing is uploaded. About 10 seconds a page on a computer, longer on a phone.');
  assert.ok(!requests.some(r => r.includes('/tesseract/')), 'the OCR engine is loaded only when asked for');
  // The settings sent to Tesseract are recorded on their way to its worker.
  await page.evaluate(() => {
    window.p2tMsgs = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m) { try { window.p2tMsgs.push(JSON.stringify(m, (k, v) => (v instanceof Blob || ArrayBuffer.isView(v) ? '[data]' : v))); } catch (e) { /* not JSON */ } return post.apply(this, arguments); };
  });
  seen.length = 0;
  await page.focus('#p2t-ocr-go');
  await page.keyboard.press('Enter');
  await settled(page, 120000);
  s = await state();
  assert.equal(s.text.replace(/\s+/g, ' '), [expected.scan.cover, ...expected.scan.lines].join(' '), 'the scanned page read word for word');
  assert.match(s.flags[0], /^Page 2 was read with OCR in English, average confidence (8\d|9\d|100)%\. Check names, numbers and dates in it\.$/);
  assert.equal(s.ocr, 'To read page 2 again in another language, choose the language.');
  assert.equal(await page.isVisible('#p2t-ocr-go'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2t-copy', 'the focus moves on from the button that went');
  assert.ok(seen.includes('Downloading the OCR engine (1.5 MB)\u2026') && seen.includes('Reading page 2 with OCR\u2026'), JSON.stringify(seen));
  const msgs = await page.evaluate(() => window.p2tMsgs);
  assert.ok(msgs.some(m => /"tessedit_pageseg_mode":"3"/.test(m)), 'automatic page layout (page segmentation mode 3), as on Image to Text');
  assert.ok(msgs.some(m => /"cacheMethod":"none"/.test(m)), 'the language data is not cached in IndexedDB');
  assert.ok(requests.includes('/assets/vendor/tesseract/lang/eng.traineddata.gz'));
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name)), []);
  // Lines and Layout show the page read with OCR line by line.
  s = await mode('lines');
  assert.deepEqual(s.text.split('\n'), [expected.scan.cover, '', ...expected.scan.lines], 'a blank line between the pages');
  await mode('para');
  // In another language the page can be read again; the size of that language's data comes first.
  await page.selectOption('#p2t-lang', 'deu');
  s = await state();
  assert.equal(s.ocrButton, 'Read page 2 with OCR');
  assert.equal(await page.textContent('#p2t-ocr-size'), 'Before reading, the page downloads about 1.3 MB from this site: German data (1.3 MB). Nothing is uploaded. About 10 seconds a page on a computer, longer on a phone.');
  await page.selectOption('#p2t-lang', 'eng');
  assert.equal((await state()).ocr, 'To read page 2 again in another language, choose the language.', 'nothing left to read in English');
  assert.equal(await page.isVisible('#p2t-ocr-go'), false);

  // ---- A 1,000-page file: progress, Stop, the other pages later, and only the pages asked for ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2t-'));
  const longPdf = path.join(tmp, 'long.pdf');
  fs.writeFileSync(longPdf, makePdf(1000));
  await clearStatus();
  t0 = await threadMs();
  await page.setInputFiles('#p2t-file', longPdf);
  await page.waitForFunction(() => /^Page [1-9]\d* of 1,000$/.test(document.querySelector('#p2t-step').textContent) && document.querySelector('#p2t-bar').value > 0);
  assert.equal(await page.getAttribute('#p2t-copy', 'aria-disabled'), 'true');
  await page.focus('#p2t-copy');
  await page.keyboard.press('Enter');
  assert.equal((await state()).status, 'Wait until the reading has finished, or press Stop.');
  await page.focus('#p2t-stop');
  await page.keyboard.press('Enter');
  await settled();
  s = await state();
  const read = Number((s.status.match(/from (\d+) pages/) || [])[1]);
  assert.ok(read > 0 && read < 1000, s.status);
  assert.equal(s.status, `Stopped. long.pdf: ${fmt(read * 7)} words from ${read} pages. ${fmt(1000 - read)} pages not read yet.`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p2t-continue', 'the focus goes to Read the other pages');
  // Read the other pages, from the keyboard, then stop again.
  await clearStatus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => {
    const m = document.querySelector('#p2t-step').textContent.match(/^Page ([\d,]+) of/);
    return !document.querySelector('#p2t-progress').hidden && m && Number(m[1].replace(/,/g, '')) > 1;
  }, read);
  await page.click('#p2t-stop');
  await settled();
  const read2 = Number(((await state()).status.match(/from ([\d,]+) pages/) || [])[1].replace(/,/g, ''));
  assert.ok(read2 > read && read2 < 1000, `${read} then ${read2} pages`);
  // Only the pages asked for are read.
  s = await pages('995-1000');
  await settled();
  s = await state();
  assert.equal(s.text.split('\n\n').length, 6);
  assert.ok(s.text.startsWith('Page 995 of the long test file.'));
  assert.equal(s.status, 'long.pdf: 42 words from 6 pages.');
  // Back to every page: the rest is read.
  await pages('');
  await settled(page, 120000);
  s = await state();
  assert.equal(s.status, 'long.pdf: 7,000 words from 1,000 pages.');
  const cpu = await threadMs() - t0;
  assert.ok(cpu < 20000, `reading 1,000 pages took ${Math.round(cpu)} ms of main-thread CPU`);
  t0 = await threadMs();
  await mode('layout');
  await mode('para');
  assert.ok(await threadMs() - t0 < 4000, 'switching the layout of 1,000 pages');
  // A new file while one is read: only the new file's text is shown.
  await clearStatus();
  await page.setInputFiles('#p2t-file', longPdf);
  await page.waitForFunction(() => /^Page [1-9]/.test(document.querySelector('#p2t-step').textContent));
  await page.setInputFiles('#p2t-file', fx('sample.pdf'));
  await settled();
  await page.waitForTimeout(500);
  assert.equal((await state()).text, sampleText);
  // A 100 MB file.
  const hugePdf = path.join(tmp, 'huge.pdf');
  fs.writeFileSync(hugePdf, makePdf(2, 100 * 1024 * 1024));
  s = await load(hugePdf);
  assert.equal(s.text, 'Page 1 of the long test file.\n\nPage 2 of the long test file.');
  assert.equal(s.meta, 'huge.pdf | 2 pages \u00b7 100 MB');

  // ---- Back and forward: the options chosen come back, and the page follows them ----
  await page.check('input[name="p2t-mode"][value="lines"]');
  await page.goto(base + '/');
  await page.goBack();
  await page.waitForSelector('#p2t-text', { state: 'attached' });
  await page.waitForLoadState('load');
  const m = await page.$eval('input[name="p2t-mode"]:checked', el => el.value);
  assert.equal(await page.$eval('#p2t-hyph-row', el => el.hidden), m !== 'para', `the hyphen option follows the mode the browser put back (${m})`);

  // ---- Things that fail: the PDF reader, the OCR engine or pdf-lib cannot be downloaded ----
  const p2 = await page.context().newPage();
  const p2errors = [];
  p2.on('pageerror', e => p2errors.push(e.message));
  await p2.route('**/assets/vendor/pdfjs/pdf.min.js', r => r.abort());
  await p2.goto(url);
  s = await load('columns.pdf', p2);
  assert.equal(s.error, 'The PDF reader could not be loaded. Check your connection and try again.');
  assert.equal(s.status, '');
  await p2.unroute('**/assets/vendor/pdfjs/pdf.min.js');
  s = await load('columns.pdf', p2);
  assert.equal(s.text, colText, 'it loads once the connection is back');
  // pdf-lib checks a permissions password; without it, the page says so and extracts nothing.
  await p2.route('**/assets/vendor/pdf-lib/pdf-lib.min.js', r => r.abort());
  s = await load('nocopy.pdf', p2);
  assert.equal(s.lock, 'The author of nocopy.pdf does not allow copying its text, and its permissions could not be checked. If you have its permissions password, remove the restriction with Unlock PDF first.');
  assert.equal(s.status, 'The permissions of nocopy.pdf could not be checked.');
  assert.equal(await p2.$eval('#p2t-owner', el => el.disabled), true);
  assert.equal(s.text, '');
  // The OCR engine: its language data missing, then slow enough to stop.
  let slow = false;
  await p2.route('**/lang/eng.traineddata.gz', async r => {
    if (!slow) return r.fulfill({ status: 404, body: 'gone' });
    await new Promise(res => setTimeout(res, 4000));
    return r.continue().catch(() => {});
  });
  const ocrWorkers = async want => {
    for (let i = 0; i < 40; i++) {
      const n = p2.workers().filter(w => w.url().includes('/assets/vendor/tesseract/worker.min.js')).length;
      if (n === want || i === 39) return n;
      await p2.waitForTimeout(100);
    }
  };
  s = await load('mixed-scan.pdf', p2);
  await clearStatus(p2);
  await p2.click('#p2t-ocr-go');
  await settled(p2, 60000);
  s = await state(p2);
  assert.equal(s.error, 'The OCR engine could not be loaded. Check your connection and try again.');
  assert.equal(s.status, 'mixed-scan.pdf: 4 words from 2 pages.');
  assert.equal(s.ocrButton, 'Read page 2 with OCR', 'the page can be read again');
  assert.equal(await ocrWorkers(0), 0, 'the half-started engine is ended');
  slow = true;
  await clearStatus(p2);
  await p2.click('#p2t-ocr-go');
  await p2.waitForFunction(() => /^Downloading English data/.test(document.querySelector('#p2t-status').textContent));
  assert.equal(await p2.getAttribute('#p2t-download', 'aria-disabled'), 'true');
  await p2.focus('#p2t-stop');
  await p2.keyboard.press('Enter');
  await settled(p2);
  s = await state(p2);
  assert.equal(s.status, 'OCR stopped. mixed-scan.pdf: 4 words from 2 pages.');
  assert.equal(s.ocr !== '', true, 'the page is still offered for OCR');
  assert.equal(await p2.evaluate(() => document.activeElement.id), 'p2t-ocr-go', 'the focus goes back to the OCR button');
  assert.equal(await ocrWorkers(0), 0, 'Stop ends the engine');
  assert.deepEqual(p2errors, []);
  await p2.close();

  // ---- A phone: touch, the share sheet, a warning for a big file ----
  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p3 = await phone.newPage();
  await p3.addInitScript(() => {
    window.p2tShared = null;
    navigator.canShare = d => !!(d && d.files && d.files.length);
    navigator.share = async d => { window.p2tShared = { name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text() }; };
  });
  await p3.goto(url);
  for (const id of ['#p2t-open', '#p2t-sample']) assert.ok((await p3.$eval(id, el => el.getBoundingClientRect().height)) >= 44, id);
  await p3.tap('#p2t-sample');
  await settled(p3);
  assert.equal((await state(p3)).text, sampleText);
  for (const id of ['#p2t-copy', '#p2t-download', '#p2t-share']) assert.ok((await p3.$eval(id, el => el.getBoundingClientRect().height)) >= 44, `${id} on a phone`);
  for (const id of ['#p2t-text', '#p2t-pages']) assert.ok((await p3.$eval(id, el => parseFloat(getComputedStyle(el).fontSize))) >= 16, `${id} text size`);
  await p3.tap('#p2t-share');
  await p3.waitForFunction(() => window.p2tShared);
  assert.deepEqual(await p3.evaluate(() => window.p2tShared), { name: 'sample.txt', type: 'text/plain', text: sampleText });
  await p3.tap('input[name="p2t-mode"][value="layout"]');
  assert.equal(await p3.$eval('input[name="p2t-mode"]:checked', el => el.value), 'layout');
  assert.ok(await p3.evaluate(() => document.documentElement.scrollWidth <= 390), 'Layout scrolls inside its box, not the page');
  await clearStatus(p3);
  await p3.setInputFiles('#p2t-file', hugePdf);
  await settled(p3);
  s = await state(p3);
  assert.equal(s.error, 'huge.pdf is 100 MB: a phone may run out of memory with a file this large. If the page stops, read it on a computer.');
  assert.equal(s.text, 'Page 1 of the long test file.\n\nPage 2 of the long test file.');
  await phone.close();
  // A decimal-comma locale reads page lists the same way.
  const de = await page.context().browser().newContext({ locale: 'de-DE' });
  const p4 = await de.newPage();
  await p4.goto(url);
  await p4.setInputFiles('#p2t-file', fx('columns.pdf'));
  await settled(p4);
  await p4.fill('#p2t-pages', '1,3');
  await p4.press('#p2t-pages', 'Enter');
  s = await state(p4);
  assert.ok(s.text.startsWith('The Ouse river survey') && s.text.includes('3. Measurements by site') && !s.text.includes('2. Results'), 'pages 1 and 3');
  await de.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---- The main flow from the keyboard: Choose a PDF file opens the file chooser ----
  await open();
  await page.focus('#p2t-open');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(fx('columns.pdf'));
  await settled();
  assert.equal((await state()).text, colText);
  await page.focus('#p2t-copy');
  await page.keyboard.press('Enter');
  assert.equal(await clip(page), colText);
};

// A PDF of n pages, each with one line ("Page 1 of the long test file."), and optionally an
// unused stream of pad bytes, to make a big file.
function makePdf(n, pad = 0) {
  const parts = [], offsets = [];
  let size = 0;
  const add = b => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); size += buf.length; };
  const obj = (num, body) => { offsets[num] = size; add(`${num} 0 obj\n`); add(body); add('\nendobj\n'); };
  add('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${5 + 2 * i} 0 R`);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let last = 4;
  if (pad) {
    offsets[4] = size;
    add(`4 0 obj\n<< /Length ${pad} >>\nstream\n`);
    add(Buffer.alloc(pad, 0x20));
    add('\nendstream\nendobj\n');
  } else obj(4, '<< >>');
  for (let i = 0; i < n; i++) {
    const c = `BT /F1 12 Tf 72 720 Td (Page ${i + 1} of the long test file.) Tj ET`;
    obj(5 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
    obj(6 + 2 * i, `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    last = 6 + 2 * i;
  }
  const xref = size;
  let x = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= last; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  add(x + `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}
