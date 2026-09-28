const fs = require('fs');
const zlib = require('zlib');

// Expected structures come from the GitHub Flavored Markdown spec (tables, task lists,
// strikethrough, autolinks), GitHub's heading-anchor and footnote numbering rules, and
// Pandoc's rule for $ math. PDF page sizes are the paper sizes in points (1 in = 72 pt).

// A w x h RGBA PNG, written from scratch (zlib + CRC-32).
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
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([200, 30, 30, 255], y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = async ({ page, open, assert, base }) => {
  // Record calls to print() instead of opening a dialog.
  await page.addInitScript(() => {
    window.__prints = [];
    window.print = () => { window.__prints.push({ top: true, title: document.title }); };
  });
  await open();
  const frame = await (await page.$('#mdp-frame')).contentFrame();
  // Waits by polling from the test: inside the sandboxed preview frame no script may run, so
  // Playwright's own in-page polling (requestAnimationFrame) is blocked there.
  const inFrame = async (fn, arg, timeout = 15000) => {
    const end = Date.now() + timeout;
    for (;;) {
      if (await frame.evaluate(fn, arg)) return;
      if (Date.now() > end) throw new Error('timed out waiting in the preview: ' + fn.toString().slice(0, 120));
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const inFrameSel = sel => inFrame(s => !!document.querySelector(s), sel);
  const inDoc = (sel, fn) => frame.$$eval('#mdp-doc ' + sel, fn);
  const html = () => frame.$eval('#mdp-doc', d => d.innerHTML);
  // Rendering follows typing after about 40 ms for short texts.
  const setMd = async md => {
    await page.fill('#mdp-input', md);
    await page.waitForTimeout(200);
  };
  const stubFramePrint = () => page.evaluate(() => {
    const f = document.getElementById('mdp-frame');
    f.contentWindow.print = () => window.__prints.push({ frame: true, title: document.title, frameTitle: f.contentDocument.title });
  });

  // ---- The example renders on load, with lazily loaded highlighting and math. ----
  await inFrameSel('#mdp-doc h1');
  await inFrameSel('#mdp-doc .katex');
  await inFrameSel('#mdp-doc pre code .hljs-keyword');
  assert.equal(await frame.textContent('#mdp-doc h1'), 'Quarterly project update');
  assert.equal(await page.inputValue('#mdp-name'), 'Quarterly project update');
  assert.equal(await inDoc('input[type=checkbox]', l => l.map(c => c.checked).join()), 'true,true,false');
  assert.equal(await inDoc('table th', l => l.map(c => c.getAttribute('align')).join()), 'left,right,right,right');
  assert.equal(await inDoc('.footnotes li', l => l.length), 1);
  assert.match(await page.textContent('#mdp-info'), /^\d+ words$/);
  // The preview is a separate, script-free document: the page keeps one <h1>.
  assert.equal(await page.getAttribute('#mdp-frame', 'sandbox'), 'allow-same-origin allow-modals');

  // ---- GitHub Flavored Markdown ----
  await setMd([
    '# Doc', '', '**b** *i* ~~s~~ `c` www.example.com', '',
    '3. three', '4. four', '   - nested', '', '- [ ] open', '- [x] done', '',
    '| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |', '',
    '## Same', '## Same', '### Déjà vu — ok?', '', 'See[^b] and[^a] and[^b].', '',
    '[^a]: Note A.', '[^b]: Note B', '    continues.', '', '\\newpage', '', 'After [jump](#same-1).'
  ].join('\n'));
  const h = await html();
  assert.match(h, /<strong>b<\/strong> <em>i<\/em> <del>s<\/del> <code>c<\/code> <a href="http:\/\/www\.example\.com"/);
  assert.match(h, /<ol start="3">\s*<li>three<\/li>\s*<li>four<ul>\s*<li>nested<\/li>/);
  assert.match(h, /<ul class="contains-task-list">\s*<li class="task-list-item"><input disabled="" type="checkbox"> open<\/li>\s*<li class="task-list-item"><input checked="" disabled="" type="checkbox"> done<\/li>/);
  assert.equal(await inDoc('th', l => l.map(c => c.getAttribute('align')).join()), 'left,center,right');
  // GitHub anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered.
  assert.deepEqual(await inDoc('h2, h3', l => l.map(e => e.id)), ['user-content-same', 'user-content-same-1', 'user-content-déjà-vu--ok']);
  assert.equal(await frame.getAttribute('#mdp-doc p:last-of-type a', 'href'), '#user-content-same-1');
  // Footnotes are numbered by first reference and collected at the end.
  assert.deepEqual(await inDoc('sup.md-fn-ref a', l => l.map(a => a.textContent + a.getAttribute('href'))), ['1#user-content-fn-1', '2#user-content-fn-2', '1#user-content-fn-1']);
  assert.deepEqual(await inDoc('.footnotes li', l => l.map(li => li.id + ':' + li.textContent.replace(/\s+/g, ' ').trim())),
    ['user-content-fn-1:Note B continues. ↩ ↩2', 'user-content-fn-2:Note A. ↩']);
  assert.equal(await inDoc('.md-pagebreak', l => l.length), 1);

  // Keep single line breaks.
  await setMd('one\ntwo');
  assert.equal(await inDoc('br', l => l.length), 0);
  await page.check('#mdp-breaks');
  await page.waitForTimeout(100);
  assert.equal(await inDoc('br', l => l.length), 1);
  await page.uncheck('#mdp-breaks');

  // ---- Math: $, $$, \( \), \[ \], ```math and environments; prices stay text. ----
  await setMd([
    'Costs $5 and $10, or \\$3.', '', 'Inline $x^2$ and \\(y_1\\).', '', '$$', '\\sum_{i=1}^n i', '$$', '',
    '\\[', 'E = mc^2', '\\]', '', '```math', '\\frac{a}{b}', '```', '', '\\begin{align}', 'a &= b \\\\', 'c &= d', '\\end{align}'
  ].join('\n'));
  await inFrameSel('#mdp-doc .katex');
  assert.equal(await frame.textContent('#mdp-doc p:first-child'), 'Costs $5 and $10, or $3.');
  assert.equal(await inDoc('p:nth-child(2) .katex', l => l.length), 2);
  assert.equal(await inDoc('.katex-display', l => l.length), 4);
  assert.deepEqual(await inDoc('annotation', l => l.map(a => a.textContent.trim())),
    ['x^2', 'y_1', '\\sum_{i=1}^n i', 'E = mc^2', '\\frac{a}{b}', '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}']);
  assert.equal(await inDoc('.katex-error', l => l.length), 0);
  await page.uncheck('#mdp-math');
  await page.waitForTimeout(100);
  assert.equal(await inDoc('.katex', l => l.length), 0);
  await page.check('#mdp-math');

  // An extra highlight.js grammar is fetched when a block asks for it.
  await setMd('```dockerfile\nFROM node:22\nRUN npm ci\n```');
  await inFrameSel('#mdp-doc code.language-dockerfile .hljs-keyword');

  // ---- Sanitising: nothing runs, nothing is fetched from another site. ----
  const evil = [
    '<script>window.__xss=1</script>', '', '<img src=x onerror="window.__xss=2">', '',
    '[a](javascript:window.__xss=3)', '', '[b](  JAVASCRIPT:window.__xss=3 )', '', '[c](&#106;avascript:window.__xss=3)', '',
    '<a href="jav&#x09;ascript:window.__xss=4">d</a>', '', '<iframe src="https://evil.example/f"></iframe>', '',
    '<svg onload="window.__xss=5"><use href="https://evil.example/s.svg#a"/><image href="https://evil.example/i.png"/></svg>', '',
    '<style>body{display:none}</style>', '', '<div style="background:url(https://evil.example/bg.png)">styled</div>', '',
    '![t](https://evil.example/track.png)', '', '<img src="https://evil.example/p.png" srcset="https://evil.example/q.png 2x">', '',
    '<form action="https://evil.example/"><input type="text" name="q"><input type="image" src="https://evil.example/b.png"></form>', '',
    '<math><mi xlink:href="javascript:window.__xss=6">x</mi></math>', '', '<a href="data:text/html,<script>alert(1)</script>">e</a>', '',
    '<details open ontoggle="window.__xss=7"><summary>s</summary>d</details>', '', '<object data="https://evil.example/o"></object>', '',
    '<video poster="https://evil.example/v.png"><source src="https://evil.example/v.mp4"></video>', '',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">', '', '<base href="https://evil.example/">', '',
    '<link rel="stylesheet" href="https://evil.example/s.css">', '', '<p id="location" name="cookie">clobber</p>', '',
    '<a href="https://example.com/ok">web link</a>', '',
    // SVG presentation attributes and MathML <mglyph> can fetch files too; only url(#id) may stay.
    '<svg width="8" height="8"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)" filter="url(https://evil.example/f.svg#f)" mask="url(https://evil.example/m.svg#m)" clip-path="url(\'https://evil.example/c.svg#c\')" marker-start="url(https://evil.example/k.svg#k)"/></svg>', '',
    '<math><mglyph src="https://evil.example/g.png"></mglyph></math>'
  ].join('\n');
  await setMd(evil);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  const audit = await frame.evaluate(() => {
    const body = document.getElementById('mdp-doc');
    const all = [...body.querySelectorAll('*')];
    return {
      tags: [...new Set(all.map(e => e.localName))].filter(t => /^(script|iframe|object|embed|style|form|base|meta|link|video|source|use|image)$/.test(t)),
      on: all.flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => e.localName + ' ' + a.name)),
      urls: all.flatMap(e => [...e.attributes].filter(a => /javascript:|evil\.example|^data:text/i.test(a.value)).map(a => e.localName + ' ' + a.name + '=' + a.value)),
      styled: body.querySelector('div') && body.querySelector('div').getAttribute('style'),
      inputs: [...body.querySelectorAll('input')].map(i => i.type + (i.disabled ? ':disabled' : '')),
      blocked: [...body.querySelectorAll('.md-img-note')].map(n => n.textContent),
      clobber: [...body.querySelectorAll('p')].filter(p => p.textContent === 'clobber').map(p => p.id)[0],
      headStyles: document.head.querySelectorAll('style').length,
      rect: (r => r && [...r.attributes].map(a => a.name + '=' + a.value).join(' '))(body.querySelector('rect'))
    };
  });
  assert.deepEqual(audit.tags, []);
  assert.deepEqual(audit.on, []);
  assert.deepEqual(audit.urls, []);
  assert.equal(audit.styled, null);
  assert.deepEqual([...new Set(audit.inputs)], ['checkbox:disabled']);
  assert.ok(audit.blocked.some(t => /Image: t from evil\.example is not loaded/.test(t)), audit.blocked.join(' | '));
  assert.equal(audit.clobber, 'user-content-location');
  assert.equal(audit.headStyles, 2, 'a pasted <style> never reaches the preview');
  assert.equal(audit.rect, 'width=8 height=8 fill=url(#g)', 'only in-document url() references are kept');
  assert.equal(await page.isVisible('header.site-header'), true, 'the page is untouched');
  // The downloaded HTML is cleaned the same way.
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mdp-html')]);
  let file = fs.readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(file, /<script|<iframe|<object|<form|<base|<meta http-equiv|onerror|onload|ontoggle|javascript:|bg\.png|s\.svg|<link/i);
  assert.match(file, /<img src="https:\/\/evil\.example\/track\.png" alt="t" referrerpolicy="no-referrer">/, 'the document keeps its own web image in the saved copy');

  // ---- Links inside the preview ----
  // Clicked on a second page: once Playwright has evaluated code in a sandboxed frame, its own
  // injected listeners log "Blocked script execution" on every click there (a plain click logs
  // nothing), so those messages, and only those, are tolerated on this page.
  const side = await page.context().newPage();
  const sideErrors = [];
  side.on('console', m => { if (m.type() === 'error' && !/^Blocked script execution in 'blob:/.test(m.text())) sideErrors.push(m.text()); });
  side.on('pageerror', e => sideErrors.push(e.message));
  await side.goto(base + '/markdown-to-pdf/');
  const sideFrame = await (await side.$('#mdp-frame')).contentFrame();
  for (let i = 0; i < 200 && !(await sideFrame.evaluate(() => !!document.querySelector('#mdp-doc h1'))); i++) await side.waitForTimeout(50);
  const filler = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join('\n\n');
  await side.fill('#mdp-input', `[web](${base}/about/) [jump](#target) [file](docs/intro.md)\n\n${filler}\n\n## Target\n\n${filler}`);
  await side.waitForTimeout(300);
  const clickLink = async text => {

    await sideFrame.evaluate(t => [...document.querySelectorAll('#mdp-doc a')].find(a => a.textContent === t).scrollIntoView({ block: 'center' }), text);
    const handle = await sideFrame.evaluateHandle(t => [...document.querySelectorAll('#mdp-doc a')].find(a => a.textContent === t), text);
    const bb = await handle.asElement().boundingBox();
    return side.mouse.click(bb.x + 3, bb.y + bb.height / 2);
  };
  // A web link opens a new tab.
  const [popup] = await Promise.all([side.context().waitForEvent('page'), clickLink('web')]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), `${base}/about/`);
  await popup.close();
  // An in-document link scrolls the preview; neither it nor a relative link loads anything into the frame.
  await sideFrame.evaluate(() => window.scrollTo(0, 0));
  const before = await sideFrame.evaluate(() => document.querySelector('#mdp-doc h2').getBoundingClientRect().top);
  await clickLink('jump');
  await side.waitForTimeout(200);
  const after = await sideFrame.evaluate(() => document.querySelector('#mdp-doc h2').getBoundingClientRect().top);
  assert.ok(before > 1000 && after >= 0 && after < 50, `heading moved from ${before} to ${after}`);
  await clickLink('file');
  await side.waitForTimeout(300);
  assert.match(sideFrame.url(), /^blob:[^#]*$/);
  assert.equal(await sideFrame.evaluate(() => !!document.getElementById('mdp-doc')), true);
  assert.deepEqual(sideErrors, []);
  await side.close();

  // ---- Images: web images wait for permission; local files are matched by name. ----
  const onRequest = [];
  page.on('request', r => onRequest.push(r.url()));
  await setMd(`![Logo](${base}/assets/og.png)\n\n![Chart](images/chart.png)`);
  assert.equal(onRequest.filter(u => u.endsWith('/assets/og.png')).length, 0);
  assert.deepEqual(await inDoc('.md-img-note', l => l.map(n => n.textContent)), [
    '[Image: Logo from 127.0.0.1 is not loaded. Tick \u201cLoad images from the web\u201d to show it.]',
    '[Image: Chart \u2013 add \u201cchart.png\u201d with Open file\u2026 to show it.]'
  ]);
  await page.check('#mdp-remote');
  await inFrame(() => { const i = document.querySelector('#mdp-doc img[alt="Logo"]'); return i && i.complete && i.naturalWidth > 0; });
  await page.uncheck('#mdp-remote');
  await page.setInputFiles('#mdp-file', { name: 'chart.png', mimeType: 'image/png', buffer: png(3, 2) });
  await inFrame(() => { const i = document.querySelector('#mdp-doc img[alt="Chart"]'); return i && i.complete && i.naturalWidth === 3; });
  assert.match(await frame.getAttribute('#mdp-doc img[alt="Chart"]', 'src'), /^blob:/);
  assert.match(await page.textContent('#mdp-ok'), /Added the image chart\.png/);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mdp-html')]);
  file = fs.readFileSync(await dl.path(), 'utf8');
  const embedded = /<img src="data:image\/png;base64,([^"]+)" alt="Chart">/.exec(file);
  assert.ok(embedded, 'the local picture is embedded in the HTML file');
  assert.deepEqual(Buffer.from(embedded[1], 'base64'), png(3, 2));

  // ---- Opening a .md file: UTF-8 with BOM, then Windows-1252, and YAML front matter. ----
  await page.setInputFiles('#mdp-file', { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('\uFEFF# Café notes\n\nMore text.\n') });
  await page.waitForFunction(() => document.getElementById('mdp-input').value.startsWith('# Café'));
  assert.equal(await page.inputValue('#mdp-name'), 'notes');
  assert.match(await page.textContent('#mdp-ok'), /Opened notes\.md/);
  await page.setInputFiles('#mdp-file', { name: 'old.md', mimeType: 'text/markdown', buffer: Buffer.from([0x23, 0x20, 0x52, 0xE9, 0x73, 0x75, 0x6D, 0xE9]) });
  await page.waitForFunction(() => document.getElementById('mdp-input').value === '# Résumé');
  await page.setInputFiles('#mdp-file', { name: 'x.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3, 0, 0]) });
  await page.waitForFunction(() => /x\.bin is not a text file/.test(document.getElementById('mdp-error').textContent));
  assert.equal(await page.inputValue('#mdp-input'), '# Résumé');
  await page.fill('#mdp-name', '');
  await page.click('#mdp-clear');
  await setMd('---\ntitle: "Front matter title"\ndate: 2024-01-01\n---\n\nBody only.');
  assert.equal(await html(), '<p>Body only.</p>\n');
  assert.equal(await page.inputValue('#mdp-name'), 'Front matter title');

  // ---- Table of contents, page options and the print output ----
  await setMd('# Report\n\n## Intro\n\ntext\n\n### Detail\n\n## End\n\ntext\n\n# Appendix\n\nmore');
  await page.check('#mdp-toc');
  await page.check('#mdp-h1break');
  await page.waitForTimeout(100);
  assert.deepEqual(await inDoc('nav.md-toc a', l => l.map(a => a.textContent + '>' + a.getAttribute('href'))),
    ['Report>#user-content-report', 'Intro>#user-content-intro', 'Detail>#user-content-detail', 'End>#user-content-end', 'Appendix>#user-content-appendix']);
  await page.selectOption('#mdp-size', 'letter');
  await page.selectOption('#mdp-orient', 'landscape');
  await page.selectOption('#mdp-margin', '25.4');
  await page.selectOption('#mdp-font', 'serif');
  await page.selectOption('#mdp-fontsize', '12');
  const pageCss = await frame.textContent('#mdp-page');
  assert.match(pageCss, /^@page\{size:letter landscape;margin:25\.4mm;@bottom-center\{content:counter\(page\) " \/ " counter\(pages\)/);
  assert.match(await frame.getAttribute('#mdp-doc', 'style'), /font-family:Charter.*serif;font-size:12pt/);
  // What the print window gets: the preview document, printed on its own.
  const printed = await frame.evaluate(() => document.documentElement.outerHTML);
  const p2 = await page.context().newPage();
  await p2.goto(base + '/404.html');
  await p2.setContent(printed, { waitUntil: 'load' });
  const pdf = (await p2.pdf({ preferCSSPageSize: true })).toString('latin1');
  await p2.close();
  const boxes = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m => m[1] + 'x' + m[2]);
  assert.equal(boxes.length, 2, 'two pages: the top-level headings each start a page');
  assert.ok(boxes.every(b => b === '792x612'), boxes.join());
  await page.selectOption('#mdp-size', 'a4');
  await page.selectOption('#mdp-orient', 'portrait');
  await page.selectOption('#mdp-margin', '20');
  await page.uncheck('#mdp-toc');
  await page.uncheck('#mdp-h1break');

  // The button prints the preview frame, titled with the file name, and keeps focus.
  await stubFramePrint();
  await page.fill('#mdp-name', 'My report');
  await page.click('#mdp-print');
  await page.waitForFunction(() => window.__prints.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__prints[0]), { frame: true, title: 'My report', frameTitle: 'My report' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mdp-print');
  // The page title comes back once printing is over.
  assert.equal(await page.evaluate(() => document.title), 'My report');
  await page.evaluate(() => document.getElementById('mdp-frame').contentWindow.dispatchEvent(new Event('afterprint')));
  assert.match(await page.evaluate(() => document.title), /Markdown to PDF/);
  // Ctrl+P does the same instead of printing the whole page.
  await page.focus('#mdp-input');
  await page.keyboard.press('Control+p');
  await page.waitForFunction(() => window.__prints.length === 2 && window.__prints[1].frame);
  // Printing from the browser menu shows only a copy of the document.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.$$eval('.mdp-print-root', l => l.length), 1);
  assert.equal(await page.isVisible('.mdp-print-root h1'), true);
  assert.equal(await page.isVisible('.site-header'), false);
  assert.equal(await page.isVisible('#mdp-input'), false);
  assert.equal(await page.isVisible('.faq'), false);
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.$$eval('.mdp-print-root', l => l.length), 0);
  assert.equal(await page.$$eval('h1', l => l.length), 1);

  // ---- Download and copy HTML ----
  await setMd('# Title & more\n\nHello $a+b$.');
  await inFrameSel('#mdp-doc .katex');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mdp-html')]);
  assert.equal(dl.suggestedFilename(), 'My report.html');
  file = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(file, /^<!DOCTYPE html>\n<html lang="en">/);
  assert.match(file, /<title>Title &amp; more<\/title>/);
  assert.match(file, /@page\{size:A4 portrait;margin:20mm\}/);
  assert.match(file, /<h1 id="user-content-title--more">Title &amp; more<\/h1>/);
  assert.match(file, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"><semantics><mrow><mi>a<\/mi><mo>\+<\/mo><mi>b<\/mi><\/mrow><annotation encoding="application\/x-tex">a\+b<\/annotation>/);
  assert.match(file, /\.katex-html\{display:none\}/);
  await page.click('#mdp-copy');
  await page.waitForFunction(() => /Copied/.test(document.getElementById('mdp-copy').textContent));
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^<h1 id="user-content-title--more">Title &amp; more<\/h1>/);

  // ---- Nesting too deep for the parser: a short, friendly message ----
  await setMd('>'.repeat(4000) + ' deep');
  await page.waitForFunction(() => /nested too deeply/.test(document.getElementById('mdp-error').textContent));
  assert.doesNotMatch(await page.textContent('#mdp-error'), /report this|github/i);
  await setMd('Back to normal.');
  assert.equal(await page.textContent('#mdp-error'), '');

  // ---- Empty document ----
  await page.click('#mdp-clear');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mdp-input');
  assert.equal(await html(), '');
  await page.click('#mdp-print');
  assert.match(await page.textContent('#mdp-error'), /nothing to save yet/);
  assert.equal(await page.evaluate(() => window.__prints.length), 2);
  await page.click('#mdp-sample');
  await inFrameSel('#mdp-doc .katex');
};
