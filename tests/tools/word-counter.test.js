const fs = require('fs');
const path = require('path');

// Expected values are worked out by hand from the documented rules, or computed with
// Python: readability from CMU Pronouncing Dictionary syllables (cmudict package) and
// keyword densities from a plain split of the passage, never read back from this page.
module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  const val = id => page.locator(id).textContent();
  const fill = async t => { await page.fill('#wc-input', t); };
  const counts = async t => {
    await fill(t);
    return { words: await val('#wc-words'), sentences: await val('#wc-sentences') };
  };

  assert.equal(await val('#wc-words'), '0');
  assert.equal(await val('#wc-fre'), '\u2013');

  await fill("Hello world. It's a well-known fact!\n\nSecond paragraph here? Yes.");
  assert.equal(await val('#wc-words'), '10');
  assert.equal(await val('#wc-sentences'), '4');
  assert.equal(await val('#wc-paragraphs'), '2');
  assert.equal(await val('#wc-chars'), '65');
  assert.equal(await val('#wc-chars-ns'), '55');

  // Emoji and combining accents count as one character each.
  await fill('café 👍🏽');
  assert.equal(await val('#wc-chars'), '6');
  assert.equal(await val('#wc-words'), '1');

  // 476 words at 238 wpm is exactly 2 minutes.
  await fill(Array(476).fill('word').join(' '));
  assert.equal(await val('#wc-reading'), '2 min');

  // Numbers with separators are one word, and don't end a sentence.
  assert.deepEqual(await counts('It costs 3.5 million. Up 1,000 at 10:30!'), { words: '8', sentences: '2' });

  // ---- Regressions: domains, emails, web addresses and initialisms were split into several
  // words and sentences ("Visit example.com today." was 4 words and 2 sentences). ----
  assert.deepEqual(await counts('Visit example.com today.'), { words: '3', sentences: '1' });
  assert.deepEqual(await counts('Email john.doe@example.com now.'), { words: '3', sentences: '1' });
  assert.deepEqual(await counts('See https://example.com/a-b?x=1 for more.'), { words: '4', sentences: '1' });
  assert.deepEqual(await counts('The U.S.A. is big.'), { words: '4', sentences: '1' });
  // Unicode hyphens (U+2011, U+2010), underscores and slashes join words.
  assert.deepEqual(await counts('well\u2011known and well\u2010known'), { words: '3', sentences: '1' });
  assert.deepEqual(await counts('snake_case and and/or'), { words: '3', sentences: '1' });
  // Titles, initials and a lower-case next word don't end a sentence; ? and ! do.
  assert.deepEqual(await counts('Mr. Smith met Dr. J. R. Jones at 10 a.m. on Monday. They talked. Q: Why? A: Because.'), { words: '18', sentences: '4' });
  assert.deepEqual(await counts('e.g. this is fine. Dr. Smith arrived.'), { words: '7', sentences: '2' });
  assert.deepEqual(await counts('Wait... what? Yes!'), { words: '3', sentences: '2' });
  assert.deepEqual(await counts('"Quoted." Next sentence.'), { words: '3', sentences: '2' });
  // A heading without a full stop is its own sentence when a blank line follows.
  assert.deepEqual(await counts('# Heading\n\nText here.'), { words: '3', sentences: '2' });
  assert.deepEqual(await counts('   '), { words: '0', sentences: '0' });

  // A decomposed accent (e + U+0301) must not split the word.
  await fill('cafe\u0301 au lait');
  assert.equal(await val('#wc-words'), '3');
  assert.equal(await val('#wc-chars'), '12');

  // Han and Kana count one word per character; Korean is space-separated.
  assert.deepEqual(await counts('日本語を話します。'), { words: '8', sentences: '1' });
  assert.deepEqual(await counts('안녕하세요 세계'), { words: '2', sentences: '1' });
  // Thai has no spaces: it is split with the browser's word dictionary, not counted as one word.
  const thai = 'สว\u0E31สด\u0E35คร\u0E31บว\u0E31นน\u0E35\u0E49อากาศด\u0E35';
  const thaiWords = await page.evaluate(t => [...new Intl.Segmenter('th', { granularity: 'word' }).segment(t)].filter(s => s.isWordLike).length, thai);
  assert.ok(thaiWords > 1);
  await fill(thai);
  assert.equal(await val('#wc-words'), String(thaiWords));
  assert.match(await val('#wc-read-note'), /made for English/);
  assert.equal(await val('#wc-fre'), '\u2013');

  // 1,000 words: 4 min 12 sec reading, 6 min 40 sec speaking (as the FAQ says).
  await fill(Array(1000).fill('word').join(' '));
  assert.equal(await val('#wc-reading'), '4 min 12 sec');
  assert.equal(await val('#wc-speaking'), '6 min 40 sec');

  // ---- Readability. Python with cmudict: 41 words, 4 sentences, 56 syllables,
  // Flesch Reading Ease 80.9, Flesch-Kincaid grade 4.5. ----
  const passage = 'The sun rose over the quiet valley. Farmers walked to their fields before breakfast. A small river runs beside the old stone bridge, and children often play there in the summer. Everyone in the village knows the story of the flood.';
  await fill(passage);
  assert.equal(await val('#wc-words'), '41');
  assert.equal(await val('#wc-sentences'), '4');
  assert.equal(await val('#wc-fre'), '80.9');
  assert.equal(await val('#wc-fre-band'), 'Easy');
  assert.equal(await val('#wc-fk'), '4.5');
  assert.equal(await val('#wc-spw'), '1.37');
  assert.equal(await val('#wc-wps'), '10.3');
  assert.equal(await val('#wc-unique'), '34');
  assert.match(await val('#wc-read-note'), /fewer than 100 words/);
  assert.equal(await val('#wc-longest-label'), 'Longest sentence (17 words)');
  assert.equal(await val('#wc-longest'), 'A small river runs beside the old stone bridge, and children often play there in the summer.');
  // Very simple text is capped at 100 (206.835 - 1.015*3 - 84.6*1 = 119.2).
  await fill('The cat sat.');
  assert.equal(await val('#wc-fre'), '100.0');
  assert.equal(await val('#wc-fk'), '0.0');

  // Syllable estimate against CMUdict for 40 words drawn at random (seed 7) from the 3,000 most
  // frequent English words. The rules are a heuristic, so at least 36 of 40 must agree.
  const cmu = { winter: 2, county: 2, winner: 2, writers: 2, put: 1, open: 2, applications: 4, wrong: 1, critical: 3, educational: 5,
    week: 1, golden: 2, voice: 1, part: 1, guys: 1, thoughts: 1, ad: 1, american: 4, sales: 1, true: 1, false: 1, vehicle: 3,
    person: 2, stream: 1, son: 1, risk: 1, importance: 3, depending: 3, told: 1, papers: 2, newspaper: 3, continues: 3, left: 1,
    followed: 2, feel: 1, stadium: 3, main: 1, successful: 3, birthday: 2, parents: 2 };
  let agree = 0;
  const misses = [];
  for (const [w, n] of Object.entries(cmu)) {
    await fill(w);
    const got = Number(await val('#wc-spw'));
    if (got === n) agree++; else misses.push(`${w}: ${got} (CMU ${n})`);
  }
  assert.ok(agree >= 36, `syllables agree with CMUdict for ${agree}/40 words; misses: ${misses.join(', ')}`);
  // Words the old vowel-group rule got wrong: silent -ed, spoken -le, hiatus vowels, -ing after a vowel.
  for (const [w, n] of [['called', 1], ['little', 2], ['wanted', 2], ['idea', 3], ['being', 2], ['beautiful', 3], ['something', 2]]) {
    await fill(w);
    assert.equal(Number(await val('#wc-spw')), n, w);
  }

  // ---- Keyword density (Python: "the" 7 of 41 words = 17.07%; "in the" twice = 2*2/41 = 9.76%). ----
  await fill(passage);
  const kwRows = () => page.$$eval('#wc-kw-body tr', trs => trs.map(t => [...t.children].map(c => c.textContent)));
  let rows = await kwRows();
  assert.equal(rows.length, 10);
  assert.ok(rows.every(r => !['the', 'in', 'and', 'of', 'a'].includes(r[1])), 'stop words hidden by default');
  await page.uncheck('#wc-kw-stop');
  rows = await kwRows();
  assert.deepEqual(rows[0], ['1', 'the', '7', '17.07%']);
  assert.deepEqual(rows[1], ['2', 'in', '2', '4.88%']);
  await page.selectOption('#wc-kw-n', '2');
  rows = await kwRows();
  assert.deepEqual(rows, [['1', 'in the', '2', '9.76%']]);
  // With common words hidden, "in the" goes, and nothing else repeats.
  await page.check('#wc-kw-stop');
  assert.equal((await kwRows()).length, 0);
  assert.match(await val('#wc-kw-empty'), /No two-word phrase appears more than once/);
  assert.equal(await page.isVisible('#wc-kw-empty'), true);
  // Phrases stop at punctuation and sentence ends: "red apples" twice, never "apples green".
  await fill('Red apples, green pears. Red apples are sweet! Green pears too.');
  rows = await kwRows();
  assert.deepEqual(rows.map(r => r[1] + ':' + r[2]), ['green pears:2', 'red apples:2']);
  // Top 50 rows, CSV download of the whole list.
  await page.selectOption('#wc-kw-n', '1');
  await page.uncheck('#wc-kw-stop');
  await fill(Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(2, '0')} `.repeat(60 - i)).join(''));
  assert.equal((await kwRows()).length, 10);
  await page.selectOption('#wc-kw-rows', '50');
  rows = await kwRows();
  assert.equal(rows.length, 50);
  assert.deepEqual(rows[0], ['1', 'w00', '60', `${(60 / 1830 * 100).toFixed(2)}%`]);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#wc-kw-csv')]);
  assert.equal(dl.suggestedFilename(), 'keyword-density.csv');
  const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(csv[0], 'keyword,count,density_percent');
  assert.equal(csv.length, 51);
  assert.equal(csv[1], `w00,60,${(60 / 1830 * 100).toFixed(2)}`);
  assert.equal(csv[50], `w49,11,${(11 / 1830 * 100).toFixed(2)}`);
  await page.selectOption('#wc-kw-rows', '10');
  await page.check('#wc-kw-stop');

  // ---- Opening documents. Word counts come from the fixture generator (Python regex on the
  // visible text it wrote); deleted tracked changes, the text box fallback copy, field codes,
  // headers and comments must not be counted. ----
  const openFiles = async files => {
    await page.setInputFiles('#wc-file', files.map(f => path.join(fixtures, f)));
    await page.waitForFunction(() => !/^Reading/.test(document.querySelector('#wc-file-ok').textContent));
  };
  await openFiles(['report.docx']);
  assert.equal(await val('#wc-words'), '34');
  assert.equal(await val('#wc-paragraphs'), '10');
  assert.equal(await val('#wc-file-ok'), 'Opened report.docx: 34 words.');
  let text = await page.inputValue('#wc-input');
  assert.ok(text.startsWith('Quarterly report\n\nSales grew strongly this quarter.\n\nWe opened two stores in May.\n\nPage 7 shows the chart.'), text);
  for (const gone of ['deleted', 'moved away', 'PAGE', 'MERGEFORMAT', 'Confidential', 'comment']) assert.ok(!text.includes(gone), `${gone} should not be counted`);
  assert.equal(text.split('Text box words').length, 2, 'text box counted once');
  assert.ok(text.endsWith('Line one\nline two.\n\nSource: annual accounts.'), 'footnote at the end');
  // A document saved by python-docx (Word's default template) with a table.
  await openFiles(['notes.docx']);
  assert.equal(await val('#wc-words'), '18');
  // OpenDocument: tracked deletion and comment skipped, <text:s text:c="3"/> is three spaces.
  await openFiles(['trip.odt']);
  assert.equal(await val('#wc-words'), '16');
  assert.equal(await page.inputValue('#wc-input'), 'Trip plan\n\nWe leave   on Monday morning.\n\nPack boots\n\nBook the\thut\n\nDay one\n\nWeather permitting.');
  // HTML: script, style, noscript and the title are not text.
  await openFiles(['page.html']);
  assert.equal(await page.inputValue('#wc-input'), 'Home About\n\nBig news\n\nFirst paragraph with a line wrap.\n\nOne item\n\nTwo items\n\nLast\nline.');
  assert.equal(await val('#wc-words'), '16');
  // Markdown: front matter, marks and link addresses removed.
  await openFiles(['post.md']);
  assert.equal(await page.inputValue('#wc-input'), 'Hello world\n\nRead the full guide or see a chart.\n\nBold point\ncode_span here\n\nconst x = 1;\n\nQuoted text.');
  // Lines full of unmatched Markdown marks are read quickly (the patterns are bounded).
  const t0 = Date.now();
  await page.setInputFiles('#wc-file', { name: 'marks.md', mimeType: 'text/markdown', buffer: Buffer.from('*a '.repeat(40000) + '\n' + '['.repeat(100000) + '\n' + '`a'.repeat(50000)) });
  await page.waitForFunction(() => /^Opened marks\.md/.test(document.querySelector('#wc-file-ok').textContent));
  assert.ok(Date.now() - t0 < 3000, `Markdown file took ${Date.now() - t0} ms`);
  // Windows-1252 and UTF-16 text files.
  await openFiles(['legacy.txt']);
  assert.equal(await page.inputValue('#wc-input'), 'Café naïve résumé \u2013 5 €');
  assert.match(await val('#wc-file-ok'), /not valid UTF-8 and was read as Windows-1252/);
  await openFiles(['utf16.txt']);
  assert.equal(await page.inputValue('#wc-input'), 'Hello UTF-16 world\nsecond line');
  // Files it cannot read get a clear message and leave the text alone.
  await openFiles(['old.doc']);
  assert.match(await val('#wc-file-error'), /^old\.doc is an old Word 97\u20132003 \(\.doc\) file/);
  assert.equal(await page.inputValue('#wc-input'), 'Hello UTF-16 world\nsecond line');
  await openFiles(['scan.pdf']);
  assert.match(await val('#wc-file-error'), /scan\.pdf is a PDF/);
  await page.setInputFiles('#wc-file', { name: 'broken.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\u0003\u0004 not really a zip') });
  await page.waitForFunction(() => /broken\.docx/.test(document.querySelector('#wc-file-error').textContent));
  // Several files: one row each and a total; the unreadable one is reported, the rest still count.
  await openFiles(['report.docx', 'trip.odt', 'old.doc', 'page.html']);
  assert.equal(await page.isVisible('#wc-files'), true);
  const fileRows = await page.$$eval('#wc-files tbody tr, #wc-files tfoot tr', trs => trs.map(t => [...t.children].slice(0, 2).map(c => c.textContent).join(':')));
  assert.deepEqual(fileRows, ['report.docx:34', 'trip.odt:16', 'page.html:16', 'Total (3 files):66']);
  assert.equal(await val('#wc-words'), '66');
  assert.match(await val('#wc-file-error'), /old\.doc/);
  assert.equal(await val('#wc-file-ok'), 'Opened 3 files: 66 words in total.');

  // Dropping a file on the box opens it instead of navigating away.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['Dropped text with five words.'], 'drop.txt', { type: 'text/plain' }));
    const box = document.querySelector('#wc-input');
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#wc-file-ok').textContent === 'Opened drop.txt: 5 words.');
  assert.equal(await page.isVisible('#wc-files'), false);
  assert.equal(await val('#wc-words'), '5');

  // A long run of spaces between end marks must not freeze the page (the old sentence regex
  // was quadratic: ~2 s for 40,000 spaces). Long texts are counted in a worker.
  const ms = await page.evaluate(() => {
    const el = document.querySelector('#wc-input');
    el.value = 'x.' + ' '.repeat(40000) + '.' + '\t'.repeat(40000) + 'y';
    const t = performance.now();
    el.dispatchEvent(new Event('input'));
    return performance.now() - t;
  });
  assert.ok(ms < 300, `input handler took ${ms} ms`);
  await page.waitForFunction(() => document.querySelector('#wc-sentences').textContent === '2');
  assert.equal(await val('#wc-words'), '2');
  // A 1.1 MB text is counted off the main thread: no long task while it is analysed.
  const longest = await page.evaluate(async () => {
    const el = document.querySelector('#wc-input');
    el.value = 'The quick brown fox jumps over the lazy dog. '.repeat(25000);
    await new Promise(r => setTimeout(r, 400));
    const tasks = [];
    const obs = new PerformanceObserver(l => l.getEntries().forEach(e => tasks.push(e.duration)));
    obs.observe({ entryTypes: ['longtask'] });
    el.dispatchEvent(new Event('input'));
    while (document.querySelector('#wc-words').textContent !== '225,000') await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 50));
    obs.disconnect();
    return Math.max(0, ...tasks);
  });
  assert.ok(longest < 120, `main thread blocked for ${Math.round(longest)} ms`);
  assert.equal(await val('#wc-sentences'), '25,000');
  assert.equal(await val('#wc-reading'), '15 hr 45 min');

  // The stats grid is not a live region; one labelled summary is announced after typing pauses.
  assert.equal(await page.locator('.stats').first().getAttribute('aria-live'), null);
  await fill('');
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__wcChanges = 0;
    new MutationObserver(() => window.__wcChanges++).observe(document.querySelector('#wc-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#wc-input').pressSequentially('The quick brown fox.', { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#wc-status').textContent === '4 words, 20 characters', null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__wcChanges), 1);

  // Clear empties everything, including the files table, and keeps focus in the box.
  await openFiles(['report.docx', 'trip.odt']);
  await page.click('#wc-clear');
  assert.equal(await val('#wc-words'), '0');
  assert.equal(await page.inputValue('#wc-input'), '');
  assert.equal(await page.isVisible('#wc-files'), false);
  assert.equal(await val('#wc-file-ok'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wc-input');
  assert.equal(await page.locator('#wc-kw-body tr').count(), 0);
};
