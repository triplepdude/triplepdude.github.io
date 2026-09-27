const fs = require('fs');
const zlib = require('zlib');

// Expected values are worked out from ECMA-376 (WordprocessingML): twips are 1/20 pt, so A4 is
// 11906 x 16838 and US Letter 12240 x 15840; picture sizes are EMUs, 914400 per inch = 9525 per
// CSS pixel at 96 dpi. The produced files were also checked against the ISO/IEC 29500
// transitional XSDs and opened in LibreOffice while this tool was built.

// A minimal ZIP reader (central directory; stored or deflated entries).
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (data.length !== usize) throw new Error(`${name}: size mismatch`);
    files[name] = data;
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([30, 90, 200], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = async ({ page, open, assert }) => {
  await open();
  const frame = await (await page.$('#mdw-frame')).contentFrame();
  await frame.waitForSelector('#mdw-doc h1');
  await frame.waitForSelector('#mdw-doc .katex');
  assert.equal(await frame.textContent('#mdw-doc h1'), 'Project kickoff notes');
  assert.equal(await page.inputValue('#mdw-name'), 'Project kickoff notes');
  assert.equal(await page.$$eval('h1', l => l.length), 1);

  const setMd = async md => { await page.fill('#mdw-input', md); await page.waitForTimeout(200); };
  // Parses every XML part in the page's XML parser and returns the files.
  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mdw-docx')]);
    const buf = fs.readFileSync(await dl.path());
    const files = unzip(buf);
    const xmlParts = Object.keys(files).filter(n => /\.(xml|rels)$/.test(n));
    const bad = await page.evaluate(parts => parts.filter(([, x]) => new DOMParser().parseFromString(x, 'application/xml').getElementsByTagName('parsererror').length).map(([n]) => n),
      xmlParts.map(n => [n, files[n].toString('utf8')]));
    assert.deepEqual(bad, [], 'every part is well-formed XML');
    const text = n => (files[n] ? files[n].toString('utf8') : '');
    return { name: dl.suggestedFilename(), files, doc: text('word/document.xml'), rels: text('word/_rels/document.xml.rels'), text, buf };
  };

  // ---- The example: a complete package with the parts Word needs ----
  let d = await download();
  assert.equal(d.name, 'Project kickoff notes.docx');
  assert.equal(Object.keys(d.files)[0], '[Content_Types].xml');
  for (const part of ['_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/_rels/document.xml.rels', 'word/footnotes.xml', 'word/footer1.xml']) {
    assert.ok(d.files[part], `has ${part}`);
  }
  const ct = d.text('[Content_Types].xml');
  assert.match(ct, /PartName="\/word\/document\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml"/);
  assert.match(ct, /PartName="\/word\/footnotes\.xml"/);
  assert.match(d.text('_rels/.rels'), /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/officeDocument" Target="word\/document\.xml"/);
  assert.match(d.text('docProps/core.xml'), /<dc:title>Project kickoff notes<\/dc:title>/);
  const styles = d.text('word/styles.xml');
  for (const id of ['Normal', 'Heading1', 'Heading2', 'Heading6', 'Quote', 'CodeBlock', 'CodeChar', 'Hyperlink', 'TableGrid', 'FootnoteText', 'FootnoteReference', 'ListParagraph']) assert.match(styles, new RegExp(`w:styleId="${id}"`));
  assert.match(styles, /<w:name w:val="heading 1"\/>.*?<w:outlineLvl w:val="0"\/>/, 'headings are Word\'s built-in headings');
  assert.match(styles, /<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"\/><w:sz w:val="22"\/>/, '11 pt Calibri');
  assert.match(d.doc, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:bookmarkStart w:id="\d+" w:name="_project_kickoff_notes"\/><w:r><w:t xml:space="preserve">Project kickoff notes<\/w:t>/);
  // Page size, margins and the page number footer.
  assert.match(d.doc, /<w:footerReference w:type="default" r:id="rIdFooter"\/>/);
  assert.match(d.doc, /<w:pgSz w:w="(11906" w:h="16838|12240" w:h="15840)"\/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  assert.match(d.text('word/footer1.xml'), /<w:instrText xml:space="preserve"> PAGE <\/w:instrText>/);
  // Clickable checkboxes for the task list: ticked, then two empty.
  assert.deepEqual([...d.doc.matchAll(/<w14:checked w14:val="(\d)"\/>/g)].map(m => m[1]), ['1', '0', '0']);
  // The table: header row repeated on each page, bold and shaded; right-aligned money column.
  const tbl = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(d.doc)[0];
  assert.equal((tbl.match(/<w:tr>/g) || []).length, 4);
  assert.match(tbl, /^<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"\/>/);
  assert.match(tbl, /<w:tr><w:trPr><w:tblHeader\/><\/w:trPr><w:tc><w:tcPr><w:tcW w:w="\d+" w:type="dxa"\/><w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"\/><\/w:tcPr><w:p><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Item<\/w:t>/);
  assert.match(tbl, /<w:p><w:pPr><w:jc w:val="right"\/><\/w:pPr><w:r><w:t xml:space="preserve">\$4,800<\/w:t>/);
  // The formula became Office Math: a fraction and a sum with limits.
  assert.match(d.doc, /<m:oMath>.*<m:f><m:num><m:sSub>/);
  assert.match(d.doc, /<m:oMathPara><m:oMathParaPr><m:jc m:val="center"\/><\/m:oMathParaPr><m:oMath><m:nary><m:naryPr><m:chr m:val="∑"\/><m:limLoc m:val="undOvr"\/><\/m:naryPr><m:sub>/);
  assert.match(d.doc, /<m:acc><m:accPr><m:chr m:val="̅"\/><\/m:accPr><m:e><m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"\/><\/w:rPr><m:t xml:space="preserve">t<\/m:t>/, '\\bar{t} is an accent');
  // The code block: Code Block style, keywords coloured, lines broken with <w:br/>.
  const code = /<w:pStyle w:val="CodeBlock"\/>[\s\S]*?<\/w:p>/.exec(d.doc)[0];
  assert.match(code, /<w:r><w:rPr><w:color w:val="CF222E"\/><\/w:rPr><w:t xml:space="preserve">const<\/w:t><\/w:r>/);
  assert.match(code, /<w:br\/>/);
  // The footnote is a real Word footnote.
  assert.match(d.doc, /<w:pStyle w:val="Quote"\/>.*<w:footnoteReference w:id="1"\/>/);
  assert.match(d.text('word/footnotes.xml'), /<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteRef\/><\/w:r><w:r><w:t xml:space="preserve"> <\/w:t><\/w:r><w:r><w:t xml:space="preserve">Changes need the agreement of the whole team\.<\/w:t>/);
  assert.match(d.text('word/settings.xml'), /<w:footnotePr><w:footnote w:id="-1"\/><w:footnote w:id="0"\/><\/w:footnotePr>/);
  // Inline code uses the character style.
  assert.match(d.doc, /<w:r><w:rPr><w:rStyle w:val="CodeChar"\/><\/w:rPr><w:t xml:space="preserve">\.md<\/w:t><\/w:r>/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mdw-docx');
  assert.match(await page.textContent('#mdw-status'), /^Saved Project kickoff notes\.docx \(\d+ KB\)\.$/);

  // ---- Lists: numbering restarts per list and honours the first number; nesting uses levels ----
  await setMd('3. three\n4. four\n   1. nested\n\ntext\n\n1. again\n2. more\n\n- bullet\n  - sub\n');
  d = await download();
  const nums = [...d.doc.matchAll(/<w:numPr><w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/g)].map(m => m[1] + ':' + m[2]);
  assert.deepEqual(nums, ['0:2', '0:2', '1:3', '0:4', '0:4', '0:1', '1:1']);
  const numbering = d.text('word/numbering.xml');
  const startOf = (numId, lvl) => {
    const abs = new RegExp(`<w:num w:numId="${numId}"><w:abstractNumId w:val="(\\d+)"/>`).exec(numbering)[1];
    const def = new RegExp(`<w:abstractNum w:abstractNumId="${abs}">[\\s\\S]*?</w:abstractNum>`).exec(numbering)[0];
    return new RegExp(`<w:lvl w:ilvl="${lvl}"><w:start w:val="(\\d+)"/><w:numFmt w:val="(\\w+)"/>`).exec(def).slice(1).join(' ');
  };
  assert.equal(startOf(2, 0), '3 decimal');
  assert.equal(startOf(3, 1), '1 lowerLetter');
  assert.equal(startOf(4, 0), '1 decimal');
  assert.equal(startOf(1, 0), '1 bullet');
  assert.equal(new Set([...numbering.matchAll(/<w:nsid w:val="(\w+)"\/>/g)].map(m => m[1])).size, 4, 'each list definition has its own id');

  // ---- Links, pictures, HTML tables, page breaks, TOC and options ----
  const img = png(40, 20);
  await page.setInputFiles('#mdw-file', [
    { name: 'chart.png', mimeType: 'image/png', buffer: img },
    { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="12"><rect width="30" height="12" fill="#c00"/></svg>') }
  ]);
  await page.waitForFunction(() => /Added 2 images/.test(document.getElementById('mdw-ok').textContent));
  await page.check('#mdw-toc');
  await page.uncheck('#mdw-pagenum');
  await page.selectOption('#mdw-page', 'letter');
  await page.selectOption('#mdw-margin', '720');
  await page.selectOption('#mdw-font', 'Georgia');
  await page.selectOption('#mdw-size', '12');
  await page.selectOption('#mdw-spacing', '360');
  await setMd([
    '# Report', '', '## Intro', '', 'See [the site](https://example.com/a?b=1&c=2), [Details](#details) and <mailto:me@example.com>.', '',
    '![Chart](img/chart.png) ![Logo](logo.svg) ![Remote](https://example.com/p.png) ![Gone](missing.png)', '', `![Inline](data:image/png;base64,${img.toString('base64')})`, '',
    '<table><tr><th colspan="2">Wide</th></tr><tr><td rowspan="2">A</td><td>b</td></tr><tr><td>c</td></tr></table>', '',
    '\\newpage', '', '## Details', '', 'H<sub>2</sub>O, x<sup>2</sup>, <u>u</u>, <mark>m</mark>, ~~s~~, <kbd>Ctrl</kbd>', '', '---', '',
    '> quoted **bold**', '>', '> > deeper'
  ].join('\n'));
  d = await download();
  assert.equal(d.name, 'Report.docx');
  // Word paper and margins in twips; no footer when page numbers are off.
  assert.match(d.doc, /<w:sectPr><w:pgSz w:w="12240" w:h="15840"\/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/);
  assert.ok(!d.files['word/footer1.xml']);
  const st = d.text('word/styles.xml');
  assert.match(st, /<w:rFonts w:ascii="Georgia" w:eastAsia="Georgia" w:hAnsi="Georgia" w:cs="Georgia"\/><w:sz w:val="24"\/>/);
  assert.match(st, /<w:spacing w:after="160" w:line="360" w:lineRule="auto"\/>/);
  // Hyperlinks: external targets in the relationships; the in-page link jumps to the heading's bookmark.
  const rel = href => new RegExp(`Id="(rId\\d+)" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${href.replace(/[.?&]/g, '\\$&')}" TargetMode="External"`).exec(d.rels);
  const r1 = rel('https://example.com/a?b=1&amp;c=2');
  assert.ok(r1, d.rels);
  assert.match(d.doc, new RegExp(`<w:hyperlink r:id="${r1[1]}" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">the site</w:t>`));
  assert.ok(rel('mailto:me@example.com'));
  assert.match(d.doc, /<w:hyperlink w:anchor="_details" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">Details<\/w:t>/);
  assert.match(d.doc, /<w:bookmarkStart w:id="\d+" w:name="_details"\/><w:r><w:t xml:space="preserve">Details<\/w:t><\/w:r><w:bookmarkEnd/);
  // Table of contents after the title: a TOC field whose entries link to the headings.
  assert.match(d.doc, /<w:pStyle w:val="Heading1"\/>[\s\S]*?<\/w:p><w:p><w:pPr><w:pStyle w:val="TOCHeading"\/><\/w:pPr><w:r><w:t>Contents<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:pStyle w:val="TOC1"\/><\/w:pPr><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u <\/w:instrText>/);
  assert.equal((d.doc.match(/<w:pStyle w:val="TOC1"\/>/g) || []).length, 2);
  // Pictures: the PNG file and the data: PNG are stored as they are (one media part each), the SVG as a PNG.
  const media = Object.keys(d.files).filter(n => n.startsWith('word/media/')).sort();
  assert.deepEqual(media, ['word/media/image1.png', 'word/media/image2.png', 'word/media/image3.png']);
  assert.ok(d.files['word/media/image1.png'].equals(img));
  assert.ok(d.files['word/media/image3.png'].equals(img));
  const svgPng = d.files['word/media/image2.png'];
  assert.equal(svgPng.readUInt32BE(16) + 'x' + svgPng.readUInt32BE(20), '30x12');
  const extents = [...d.doc.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(m => m[1] + 'x' + m[2]);
  assert.deepEqual(extents, [`${40 * 9525}x${20 * 9525}`, `${30 * 9525}x${12 * 9525}`, `${40 * 9525}x${20 * 9525}`]);
  assert.match(d.doc, /<wp:docPr id="1" name="Picture 1" descr="Chart"\/>/);
  // A web picture is not downloaded: it becomes a link to it. A missing file leaves a note.
  const r2 = rel('https://example.com/p.png');
  assert.ok(r2);
  assert.match(d.doc, new RegExp(`<w:hyperlink r:id="${r2[1]}" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">\\[Image: Remote\\]</w:t>`));
  assert.match(d.doc, /<w:t xml:space="preserve">\[Image: Gone\]<\/w:t>/);
  assert.match(d.text('[Content_Types].xml'), /<Default Extension="png" ContentType="image\/png"\/>/);
  // HTML table: colspan -> gridSpan, rowspan -> vMerge.
  assert.match(d.doc, /<w:gridSpan w:val="2"\/>/);
  assert.match(d.doc, /<w:vMerge w:val="restart"\/>[\s\S]*?<w:vMerge\/>/);
  // Page break, inline HTML formatting, rule and nested quotes.
  assert.match(d.doc, /<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>/);
  assert.match(d.doc, /<w:t xml:space="preserve">H<\/w:t><\/w:r><w:r><w:rPr><w:vertAlign w:val="subscript"\/><\/w:rPr><w:t xml:space="preserve">2<\/w:t>/);
  assert.match(d.doc, /<w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:t xml:space="preserve">2<\/w:t>/);
  assert.match(d.doc, /<w:rPr><w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">u<\/w:t>/);
  assert.match(d.doc, /<w:rPr><w:highlight w:val="yellow"\/><\/w:rPr><w:t xml:space="preserve">m<\/w:t>/);
  assert.match(d.doc, /<w:rPr><w:strike\/><\/w:rPr><w:t xml:space="preserve">s<\/w:t>/);
  assert.match(d.doc, /<w:rPr><w:rStyle w:val="CodeChar"\/><\/w:rPr><w:t xml:space="preserve">Ctrl<\/w:t>/);
  assert.match(d.doc, /<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D7DE"\/><\/w:pBdr>/);
  assert.match(d.doc, /<w:pPr><w:pStyle w:val="Quote"\/><\/w:pPr><w:r><w:t xml:space="preserve">quoted <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">bold<\/w:t>/);
  assert.match(d.doc, /<w:pPr><w:pStyle w:val="Quote"\/><w:ind w:left="600"\/><\/w:pPr><w:r><w:t xml:space="preserve">deeper<\/w:t>/);
  await page.uncheck('#mdw-toc');

  // ---- Math: LaTeX to Office Math ----
  await setMd('Roots $\\sqrt[3]{x}$, $\\sqrt{y}$ and \\(\\sin x\\), limit $\\lim_{n\\to\\infty} a_n$.\n\n$$\n\\int_0^1 x^2\\,dx = \\left(\\frac{1}{3}\\right)\n$$\n\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n\nCosts $5 and $10.');
  await frame.waitForSelector('#mdw-doc .katex');
  d = await download();
  assert.match(d.doc, /<m:rad><m:deg><m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"\/><\/w:rPr><m:t xml:space="preserve">3<\/m:t><\/m:r><\/m:deg><m:e>/);
  assert.match(d.doc, /<m:rad><m:radPr><m:degHide m:val="1"\/><\/m:radPr><m:deg\/><m:e>/);
  assert.match(d.doc, /<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"\/><\/m:rPr>(<w:rPr>.*?<\/w:rPr>)?<m:t xml:space="preserve">sin<\/m:t><\/m:r><\/m:fName><m:e>/);
  assert.match(d.doc, /<m:func><m:fName><m:limLow><m:e><m:r><m:rPr><m:sty m:val="p"\/><\/m:rPr>(<w:rPr>.*?<\/w:rPr>)?<m:t xml:space="preserve">lim<\/m:t>/);
  assert.match(d.doc, /<m:nary><m:naryPr><m:chr m:val="∫"\/><m:limLoc m:val="subSup"\/><\/m:naryPr><m:sub>.*?>0<\/m:t>.*?<\/m:sub><m:sup>.*?>1<\/m:t>.*?<\/m:sup><m:e><m:sSup>/);
  assert.match(d.doc, /<m:d><m:dPr><m:begChr m:val="\("\/><m:endChr m:val="\)"\/><\/m:dPr><m:e><m:f>/);
  assert.match(d.doc, /<m:eqArr><m:e>.*?<m:r><m:rPr><m:aln\/><\/m:rPr>(<w:rPr>.*?<\/w:rPr>)?<m:t xml:space="preserve">=<\/m:t>/);
  assert.match(d.doc, /<w:t xml:space="preserve">Costs \$5 and \$10\.<\/w:t>/);
  // With the option off, formulas stay as their LaTeX source.
  await page.uncheck('#mdw-math');
  d = await download();
  assert.doesNotMatch(d.doc, /<m:oMath>/);
  assert.match(d.doc, /\$\\sqrt\[3\]\{x\}\$/);
  await page.check('#mdw-math');

  // ---- Nothing unsafe reaches the file ----
  await setMd('<script>window.__x=1</script>\n\n<img src=x onerror="window.__x=2">\n\n[bad](javascript:window.__x=3) [data](data:text/html,hi) [vb](vbscript:msgbox)\n\n<a href="https://example.com/" onclick="window.__x=4">ok</a>\n\nText with \u0001control\u0008 chars & <b>bold</b> "quotes"');
  d = await download();
  assert.equal(await page.evaluate(() => window.__x), undefined);
  assert.doesNotMatch(d.doc + d.rels, /javascript|vbscript|data:text|onclick|onerror|<script|window\.__x/i);
  assert.deepEqual([...d.rels.matchAll(/TargetMode="External"/g)].length, 1);
  assert.match(d.doc, /<w:t xml:space="preserve">Text with control chars &amp; <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">bold<\/w:t><\/w:r><w:r><w:t xml:space="preserve"> &quot;quotes&quot;<\/w:t>/);

  // ---- Copy as rich text: HTML with inline styles, and plain text ----
  await setMd('# Title\n\n**Bold** and `code`.\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n- [x] done\n\nMath $x^2$.');
  await frame.waitForSelector('#mdw-doc .katex');
  await page.click('#mdw-rich');
  await page.waitForFunction(() => /Copied with formatting/.test(document.getElementById('mdw-status').textContent));
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const html = await (await items[0].getType('text/html')).text();
    const text = await (await items[0].getType('text/plain')).text();
    return { html, text };
  });
  // Text size is still 12 pt from above; Heading 1 is 1.8 times that.
  assert.match(clip.html, /^<div style="font-family:Georgia, 'DejaVu Serif', serif;font-size:12pt;line-height:1\.75">/);
  assert.match(clip.html, /<h1 id="user-content-title" style="font-size:21\.6pt;color:#0F4761;font-weight:bold;margin:18pt 0 6pt">Title<\/h1>/);
  assert.match(clip.html, /<strong>Bold<\/strong> and <code style="font-family:Consolas,monospace;background:#EFF1F3">code<\/code>/);
  assert.match(clip.html, /<td align="right" style="border:1px solid #A6A6A6;padding:3pt 6pt;text-align:right">2<\/td>/);
  assert.match(clip.html, /<ul style="margin:0 0 8pt;list-style:none;padding-left:1\.2em">\s*<li>☒ done<\/li>/);
  assert.match(clip.html, /\\\(x\^2\\\)/);
  assert.doesNotMatch(clip.html, /class=/);
  assert.match(clip.text, /^Title\n/);

  // ---- Errors ----
  await page.click('#mdw-clear');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mdw-input');
  await page.click('#mdw-docx');
  assert.match(await page.textContent('#mdw-error'), /nothing to convert yet/);
  await page.setInputFiles('#mdw-file', { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from([0, 1, 2, 0, 3]) });
  await page.waitForFunction(() => /notes\.md is not a text file/.test(document.getElementById('mdw-error').textContent));
  await page.setInputFiles('#mdw-file', { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# From file\n\nHello.') });
  await page.waitForFunction(() => document.getElementById('mdw-name').value === 'notes');
  d = await download();
  assert.equal(d.name, 'notes.docx');
  assert.match(d.text('docProps/core.xml'), /<dc:title>From file<\/dc:title>/);
};
