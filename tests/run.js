#!/usr/bin/env node
/*
 * Test runner for the tool pages.
 *
 *   node tests/run.js                 build the whole site, run every test
 *   node tests/run.js json-formatter  build only that tool, run its test
 *
 * Each tests/tools/<slug>.test.js exports:
 *   module.exports = async ({ page, open, assert, fixtures }) => { ... }
 * where open() navigates to the tool's page and fixtures is the path of
 * tests/fixtures/<slug>/ for any sample files the test needs. The browser
 * has a fake camera and microphone, and clipboard/camera/mic permissions. On top of each tool's own
 * assertions the runner checks, for every page: no JS errors, no requests to
 * other hosts, a single <h1>, a meta description, no horizontal scroll at
 * phone width (on a fresh page and with the test's results on screen) or at
 * 200% zoom, no text field under 16px on a touch screen,
 * nothing saved in cookies or browser storage, empty .msg live regions still
 * rendered, no button that a quick second tap would zoom instead of pressing,
 * nothing that skips drawing its content (content-visibility) on a page with
 * a text box, after the test and as served, and valid JSON-LD with no
 * blog-post markup.
 *
 * A full run (no slugs) also runs siteChecks: the homepage, About, Privacy and
 * 404 pages, the sitemap, related-tool links, the shared colour tokens, the
 * icon and theme colours in the head, reduced motion, keyboard scrolling of a
 * guide table that is too wide for a phone, a long line in a guide's code
 * block on a phone (on a sample page that only a full run builds), the
 * time a paste over a long text takes on Word Counter, a link to a quoted
 * FAQ answer on a page without a text box, the shared image decoder
 * with a canvas size limit like Safari's, front matter values cut short by
 * a " #" that YAML reads as a comment, and a swipe that starts on a slider.
 *
 * Needs `jekyll` (or $JEKYLL) and the `playwright` package on the module path.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(__dirname, 'tools');
const SKIP = new Set(['.git', '_site', '.jekyll-cache', 'node_modules', 'tests', '_tools', 'vendor']);

// SKIP applies to top-level entries only (assets/vendor must still be copied).
function copyDir(src, dst, top = true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (top && SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

function toolFile(slug) {
  for (const ext of ['.html', '.md']) {
    const f = path.join(ROOT, '_tools', slug + ext);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`No _tools/${slug}.html or .md`);
}

// No guide has a code block yet, so a full run builds this page, which is in
// no list and not in the sitemap, through the tool layout: kramdown renders
// its guide and FAQ answer as on a real tool page (see siteChecks). Its file
// name must not start with an `exclude` entry of _config.yml, such as tests.
const CODE_SAMPLE_URL = '/sample-code-block/';
const CODE_SAMPLE = [
  '---',
  'layout: tool',
  'title: Code block sample',
  'description: Built only by a full test run, to check that a long line in a code block of a guide or an FAQ answer fits on a phone.',
  'category: Developer',
  `permalink: ${CODE_SAMPLE_URL}`,
  'sitemap: false',
  'howto: |',
  '  ## Guide',
  '',
  '  ```bash',
  '  magick input.webp -auto-orient -strip -quality 92 -define png:compression-level=9 output-with-a-long-file-name.png',
  '  ```',
  'faq:',
  '  - q: A question',
  '    a: |',
  '      ```',
  '      data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  '      ```',
  '---',
  '<p>A sample page for the test runner.</p>',
  '',
].join('\n');

// Builds into a private temp dir so several runs can happen at once.
function build(onlySlugs) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-site-'));
  const src = path.join(work, 'src');
  copyDir(ROOT, src);
  fs.mkdirSync(path.join(src, '_tools'));
  const slugs = onlySlugs.length ? onlySlugs : fs.readdirSync(path.join(ROOT, '_tools')).map(f => f.replace(/\.(html|md)$/, ''));
  for (const slug of slugs) {
    const f = toolFile(slug);
    fs.copyFileSync(f, path.join(src, '_tools', path.basename(f)));
  }
  if (!onlySlugs.length) fs.writeFileSync(path.join(src, 'sample-code-block.html'), CODE_SAMPLE);
  const out = path.join(work, 'site');
  // cwd matters: Jekyll 3 resolves _layouts relative to the working directory.
  execFileSync(process.env.JEKYLL || 'jekyll', ['build', '--quiet', '-s', src, '-d', out], { stdio: 'inherit', cwd: src });
  return { out, work };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
  '.xml': 'application/xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff2': 'font/woff2',
};

function serve(dir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dir, p);
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': TYPES['.html'] });
      return res.end(fs.existsSync(path.join(dir, '404.html')) ? fs.readFileSync(path.join(dir, '404.html')) : 'Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
  }));
}

async function newPage(browser, base, viewport, problems, options = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, ...options });
  await context.grantPermissions(['clipboard-read', 'clipboard-write', 'camera', 'microphone'], { origin: base });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    problems.push(`external request: ${url}`);
    return route.abort();
  });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  return { context, page };
}

// Controls that may be tapped twice in quick succession (Lap, +1 min, a row of
// choices). iOS Safari can take two quick taps as a double-tap zoom and drop
// the second one, so _includes/style.css gives them touch-action: manipulation.
const TAP_TARGETS = 'button, .btn, .check, label, summary, [role="button"], input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], input[type="reset"]';

// Chromium takes seconds, and minutes for longer texts, to replace or delete a
// long text in a textarea or contenteditable while the page has an element
// that skips drawing its content: content-visibility hidden (which
// hidden="until-found" also sets) or auto (once off screen), or a closed
// <details> as the browser draws it. _includes/style.css hides closed details
// with display: none instead. Lists such elements on a page with a text box.
async function skippedContent(page) {
  return page.evaluate(() => {
    if (!document.querySelector('textarea, [contenteditable]:not([contenteditable="false"])')) return [];
    const skips = v => v === 'hidden' || v === 'auto';
    const name = e => e.tagName === 'DETAILS' && !e.id
      ? `<details> "${((e.querySelector('summary') || {}).textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
      : e.tagName.toLowerCase() + (e.id ? '#' + e.id : [...e.classList].map(c => '.' + c).join(''));
    const found = new Set();
    for (const e of document.querySelectorAll('body *')) {
      const cv = getComputedStyle(e).contentVisibility;
      // An element without a box (display: none, or inside one) skips nothing.
      if (skips(cv) && e.getClientRects().length) {
        found.add(`${name(e)} (content-visibility: ${cv}${e.getAttribute('hidden') === 'until-found' ? ', from hidden="until-found"' : ''})`);
      }
      if (e.tagName === 'DETAILS' && !e.open && e.getClientRects().length) {
        const content = getComputedStyle(e, '::details-content');
        if (content.display !== 'none' && skips(content.contentVisibility)) found.add(`${name(e)} (closed, its ::details-content has content-visibility: ${content.contentVisibility})`);
      }
    }
    return [...found];
  });
}

function skippedProblem(found, prefix = '') {
  return `${prefix}on a page with a text box, these elements skip drawing their content with content-visibility, which makes pasting over or deleting a long text in the box take seconds in Chromium (hide content with display: none instead): ${found.slice(0, 4).join(', ')}${found.length > 4 ? ` and ${found.length - 4} more` : ''}`;
}

async function commonChecks(page, problems) {
  const h1s = await page.locator('h1').count();
  if (h1s !== 1) problems.push(`expected exactly one <h1>, found ${h1s}`);
  const desc = await page.locator('meta[name="description"]').getAttribute('content').catch(() => null);
  if (!desc || desc.length < 50) problems.push('meta description missing or shorter than 50 chars');
  if (desc && desc.length > 170) problems.push(`meta description is ${desc.length} chars (keep it <= 160)`);

  // An empty message must stay rendered: a live region that is display: none
  // until its text arrives is often not announced (see .msg:empty in
  // _includes/style.css). An explicit hidden attribute is the page's choice.
  const removed = await page.$$eval('.msg:empty:not([hidden])', els => els
    .filter(e => getComputedStyle(e).display === 'none' && e.style.display !== 'none')
    .map(e => '#' + e.id));
  if (removed.length) problems.push(`empty .msg elements are display: none, so not in the accessibility tree: ${removed.join(', ')}`);

  // A tool may give a control a touch-action of its own (none on a drag
  // handle), but auto, which lets a double tap zoom, means the shared rule
  // was lost or overridden.
  const zoomable = await page.$$eval(TAP_TARGETS, els => [...new Set(els
    .filter(e => getComputedStyle(e).touchAction === 'auto')
    .map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].map(c => '.' + c).join(''))))]);
  if (zoomable.length) problems.push(`controls where a quick second tap zooms the page on iPhone instead of pressing again (touch-action: auto): ${zoomable.slice(0, 5).join(', ')}${zoomable.length > 5 ? ` and ${zoomable.length - 5} more` : ''}`);

  const skipped = await skippedContent(page);
  if (skipped.length) problems.push(skippedProblem(skipped));

  // Structured data must parse, and a tool page is not a blog post.
  for (const text of await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.textContent))) {
    try {
      if (JSON.stringify(JSON.parse(text)).includes('"BlogPosting"')) problems.push('JSON-LD marks the page as a BlogPosting');
    } catch (e) {
      problems.push(`JSON-LD does not parse: ${e.message}`);
    }
  }
  const ogType = await page.locator('meta[property="og:type"]').getAttribute('content').catch(() => null);
  if (ogType !== 'website') problems.push(`og:type is ${ogType}, expected website`);
  if (await page.locator('meta[property^="article:"]').count()) problems.push('page has article:* meta tags');

  // privacy.md promises that nothing is stored. Each test has a fresh browser
  // context, so anything found here was written by the page.
  const stored = await page.evaluate(async () => {
    const idb = indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : [];
    const cache = self.caches ? await caches.keys() : [];
    return { local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie, idb, cache };
  }).catch(() => null);
  if (stored && (stored.local.length || stored.session.length || stored.cookie || stored.idb.length || stored.cache.length)) {
    problems.push(`page stored data in the browser, which privacy.md says never happens: ${JSON.stringify(stored)}`);
  }
  return { skipped };
}

// No page may scroll sideways on a phone, down to 320px, the width at which
// content still has to reflow (WCAG 1.4.10), or in a 1280px wide window zoomed
// to 200%: ZOOMED is half of the 1280x900 viewport the tool tests run in.
// Phones are checked with a touch screen, so that `@media (pointer: coarse)`
// rules apply as they do on a real one.
const PHONES = [{ width: 390, height: 844 }, { width: 320, height: 568 }];
const ZOOMED = { width: 640, height: 450 };
const TOUCH = { hasTouch: true };

// The overflow is measured against the viewport that was asked for, not
// window.innerWidth, which grows with the content under mobile emulation.
async function sidewaysScroll(page, viewport, url, problems, prefix) {
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: 'load' });
  const overflow = await page.evaluate(width => document.documentElement.scrollWidth - width, viewport.width);
  if (overflow > 1) problems.push(`${prefix}horizontal scroll at ${viewport.width}px wide (${overflow}px overflow)`);
}

// iOS Safari zooms the page, and leaves it zoomed, when a field whose text is
// smaller than 16px gets the focus. Read-only fields are exempt.
async function smallFields(page) {
  return page.evaluate(() => {
    const notText = ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image', 'hidden'];
    const small = [];
    for (const el of document.querySelectorAll('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) {
      if ((el.tagName === 'INPUT' && notText.includes(el.type)) || el.readOnly) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) small.push(`${el.id ? '#' + el.id : el.tagName.toLowerCase()} (${size}px)`);
    }
    return small;
  });
}

// `phone` is a page made with the TOUCH options, `desktop` one without.
async function narrowChecks(phone, desktop, url, problems, prefix = '') {
  for (const viewport of PHONES) {
    await sidewaysScroll(phone, viewport, url, problems, prefix);
    const small = await smallFields(phone);
    if (small.length) problems.push(`${prefix}text fields under 16px on a touch screen ${viewport.width}px wide, where iOS zooms the page when one gets the focus: ${small.join(', ')}`);
  }
  await sidewaysScroll(desktop, ZOOMED, url, problems, prefix);
}

// Tabs through a freshly loaded page from the top: true as soon as focus lands
// on an element matching the selector, false once focus is back on <body>.
async function tabReaches(page, selector) {
  for (let i = 0; i < 300; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(sel => {
      const el = document.activeElement;
      return !el || el === document.body ? 'top' : el.matches(sel) ? 'match' : 'other';
    }, selector);
    if (at === 'match') return true;
    if (at === 'top') return false;
  }
  return false;
}

function frontMatter(file) {
  return fs.readFileSync(file, 'utf8').split(/^---\s*$/m)[1] || '';
}

function luminance(rgb) {
  const c = rgb.match(/[\d.]+/g).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// What skippedContent guards against, in practice: on Word Counter as served,
// every FAQ item closed, select all and paste 5,000 lines over 5,000 through
// the clipboard. That takes about 0.1 s, and 3 to 5 s while a closed <details>
// skips drawing its content. The old text ends with a line break, as pasted
// and typed text usually does: without one, Chromium is fast either way.
async function pasteOverLongText(page, base, problems) {
  const p = '/word-counter/';
  const lines = (word, n) => `${word} line\n`.repeat(n);
  await page.goto(base + p, { waitUntil: 'load' });
  const box = page.locator('main textarea').first();
  const before = await page.evaluate(() => ({ boxes: document.querySelectorAll('main textarea').length, closed: document.querySelectorAll('details:not([open])').length }));
  if (!before.boxes || !before.closed) {
    problems.push(`${p}: expected a text box and closed <details> (the FAQ), found ${before.boxes} and ${before.closed}, so pasting over a long text is not tested`);
    return;
  }
  await box.evaluate((t, text) => { t.value = text; t.dispatchEvent(new Event('input', { bubbles: true })); }, lines('old', 5000));
  await page.waitForTimeout(300);
  await page.evaluate(text => navigator.clipboard.writeText(text), lines('new', 5000));
  await box.evaluate(t => { t.focus(); t.select(); });
  // Timed in main-thread CPU time (Chrome's ThreadTime metric), not wall time:
  // on a busy machine the page waits for a CPU, which once stretched the usual
  // 0.1 s to 1.1 s. A page that skips drawing content takes about 5 s of CPU.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const cpu0 = await threadMs();
  const start = Date.now();
  await page.keyboard.press('ControlOrMeta+V');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  const ms = Date.now() - start;
  const cpu = Math.round((await threadMs()) - cpu0);
  await cdp.detach();
  if (!(await box.evaluate((t, text) => t.value === text, lines('new', 5000)))) problems.push(`${p}: select all and paste through the clipboard did not replace the text in the box, so pasting over a long text is not tested`);
  else if (cpu > 1000) problems.push(`${p}: pasting 5,000 lines over 5,000 took ${cpu} ms of main-thread CPU time (${ms} ms in all; 1,000 allowed): something skips drawing its content (see skippedContent in tests/run.js)`);
}

// The other side of has-text-box (_layouts/tool.html): on a tool page without
// a text box, closed <details> keep the browser's way of hiding their content,
// so a link to a quoted passage of an FAQ answer (#:~:text=, as search results
// use) and find in page open the item. Checked on the first such tool by name.
async function quotedAnswerOpens(page, base, slugs, problems) {
  const textBox = /textarea|contenteditable/;
  const slug = slugs.slice().sort().find(s => {
    const file = ['.html', '.md'].map(e => path.join(ROOT, '_tools', s + e)).find(f => fs.existsSync(f));
    const src = fs.readFileSync(file, 'utf8');
    return !textBox.test(src.replace(/^---[\s\S]*?\n---/, '')) && /\nfaq:/.test(src);
  });
  if (!slug) { problems.push('no tool page without a text box has an FAQ, so a link to a quoted FAQ answer is not tested'); return; }
  const p = `/${slug}/`;
  await page.goto(base + p, { waitUntil: 'load' });
  const info = await page.evaluate(() => {
    const answer = document.querySelector('.faq details .faq-answer');
    return {
      marked: !!document.querySelector('.has-text-box'),
      quote: answer ? answer.textContent.trim().split(/\s+/).slice(0, 5).join(' ') : '',
    };
  });
  if (info.marked) problems.push(`${p}: has no text box but is marked has-text-box`);
  if (!info.quote) { problems.push(`${p}: expected an FAQ answer to quote`); return; }
  await page.goto('about:blank');
  await page.goto(`${base}${p}#:~:text=${encodeURIComponent(info.quote).replace(/-/g, '%2D')}`, { waitUntil: 'load' });
  const opened = await page.waitForFunction(() => document.querySelector('.faq details').open, null, { timeout: 3000 }).then(() => true, () => false);
  if (!opened) problems.push(`${p}: a link to a quoted FAQ answer (#:~:text=${info.quote}) did not open the closed item; only pages with a text box should hide closed <details> with display: none`);
}

// Safari leaves a canvas over its size limit (16.7 or 67 megapixels) blank
// instead of failing. With such a limit emulated on the page and in the
// workers of the shared image decoder (assets/js/image-decode.js), a picture
// over four times the limit must still give right scaled copies, a file too
// big to draw must fail with TOO_BIG instead of being saved blank, and the
// full-size copies of a picture the page cannot draw must be let go at once.
const CANVAS_LIMIT = 4.2e6;
function emulateCanvasLimit() {
  // A 2D canvas over self.canvasLimit pixels draws nowhere and reads back transparent.
  const shim = () => {
    for (const C of [self.HTMLCanvasElement, self.OffscreenCanvas]) {
      if (!C) continue;
      const real = C.prototype.getContext;
      C.prototype.getContext = function (type, options) {
        if (!self.canvasLimit || type !== '2d' || this.width * this.height <= self.canvasLimit) return real.call(this, type, options);
        const elsewhere = C === self.OffscreenCanvas ? new OffscreenCanvas(1, 1) : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
        return real.call(elsewhere, type, options);
      };
    }
  };
  shim();
  // Each new worker gets the limit too; what is closed or sent to a worker is logged.
  self.closedBitmaps = [];
  self.workerJobs = [];
  const close = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () { if (this.width) self.closedBitmaps.push(`${this.width}x${this.height}`); return close.call(this); };
  const RealWorker = self.Worker, post = RealWorker.prototype.postMessage;
  RealWorker.prototype.postMessage = function (m, transfer) { if (m && m.cmd) self.workerJobs.push(`${m.cmd}:${m.key}`); return post.call(this, m, transfer); };
  self.Worker = function (url, options) {
    if (self.canvasLimit && typeof url === 'string' && url.startsWith('blob:') && !(options && options.type === 'module')) {
      url = URL.createObjectURL(new Blob([`self.canvasLimit = ${self.canvasLimit}; (${shim})(); importScripts(${JSON.stringify(url)});`], { type: 'text/javascript' }));
    }
    return new RealWorker(url, options);
  };
  self.Worker.prototype = RealWorker.prototype;
}

// On a touch screen, Chrome on Android moves a slider's thumb to where the
// finger lands, then hands the touch to page scrolling. The shared script puts
// the old value back on that pointercancel (_includes/common.js), so a swipe
// that starts on a slider scrolls the page and leaves the value alone, while a
// drag along the slider still changes it. Checked on the metronome's tempo.
async function sliderSwipeChecks(browser, base, problems) {
  const p = '/metronome/', sel = '#mt-slider';
  const { context, page } = await newPage(browser, base, { width: 412, height: 915 }, problems, { hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await page.goto(base + p, { waitUntil: 'load' });
  const cdp = await context.newCDPSession(page);
  const drag = async (from, to) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let s = 1; s <= 8; s++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * s / 8, y: from.y + (to.y - from.y) * s / 8 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
  };
  const box = async () => {
    await page.$eval(sel, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    return page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  };
  let b = await box();
  const before = await page.inputValue(sel), y0 = await page.evaluate(() => scrollY);
  await drag({ x: b.x + b.w * 0.2, y: b.y + b.h / 2 }, { x: b.x + b.w * 0.2 + 3, y: b.y + b.h / 2 - 200 });
  const after = await page.inputValue(sel), y1 = await page.evaluate(() => scrollY);
  if (!(y1 > y0)) problems.push(`${p}: a vertical swipe that starts on ${sel} did not scroll the page, so the slider check is not testing anything`);
  else if (after !== before) problems.push(`${p}: a swipe that starts on ${sel} and scrolls the page changed it from ${before} to ${after}`);
  b = await box();
  await drag({ x: b.x + b.w * 0.3, y: b.y + b.h / 2 }, { x: b.x + b.w * 0.8, y: b.y + b.h / 2 + 2 });
  if ((await page.inputValue(sel)) === before) problems.push(`${p}: a drag along ${sel} no longer changes it`);
  await cdp.detach();
  await context.close();
}

async function canvasLimitChecks(browser, base, problems) {
  const { context, page } = await newPage(browser, base, { width: 1280, height: 900 }, problems);
  await context.addInitScript(emulateCanvasLimit);
  await page.goto(base + '/404.html', { waitUntil: 'load' });
  await page.addScriptTag({ url: '/assets/js/image-decode.js' });
  const r = await page.evaluate(async limit => {
    // 4200 x 4200 pixels (17.6 megapixels) in four colours, drawn before the limit is on.
    const N = 4200, colours = [[220, 30, 30], [30, 180, 40], [30, 60, 220], [240, 210, 20]];
    const c = Object.assign(document.createElement('canvas'), { width: N, height: N }), g = c.getContext('2d');
    colours.forEach((rgb, i) => { g.fillStyle = `rgb(${rgb})`; g.fillRect((i % 2) * N / 2, (i >> 1) * N / 2, N / 2, N / 2); });
    const file = new File([await new Promise(done => c.toBlob(done, 'image/png'))], 'quarters.png', { type: 'image/png' });
    c.width = 0;
    self.canvasLimit = limit;
    const outcome = async f => { try { return { value: await f() }; } catch (e) { return { code: e.code || String(e) }; } };
    // Whether an encoded picture shows the four colours, with no pixel transparent.
    const right = async blob => {
      const bm = await createImageBitmap(blob), w = bm.width, h = bm.height;
      const cv = Object.assign(document.createElement('canvas'), { width: w, height: h }), cg = cv.getContext('2d');
      cg.drawImage(bm, 0, 0);
      bm.close();
      const d = cg.getImageData(0, 0, w, h).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return false;
      return colours.every((rgb, i) => {
        const p = cg.getImageData(Math.floor(((i % 2) * 2 + 1) * w / 4), Math.floor(((i >> 1) * 2 + 1) * h / 4), 1, 1).data;
        return rgb.every((v, k) => Math.abs(p[k] - v) <= 4);
      });
    };
    const out = {};
    const res = await outcome(() => TTImage.decode(file, { canvas: false }));
    if (!res.value) return { decoded: res.code };
    out.png = await outcome(async () => right(await TTImage.encode(res.value, 'png', { width: 600, height: 600 })));
    out.ico = await outcome(async () => {
      const b = new Uint8Array(await (await TTImage.encode(res.value, 'ico', { icoSizes: [256] })).arrayBuffer()), dv = new DataView(b.buffer);
      return right(new Blob([b.subarray(dv.getUint32(18, true), dv.getUint32(18, true) + dv.getUint32(14, true))], { type: 'image/png' }));
    });
    out.bmp = await outcome(async () => (await TTImage.encode(res.value, 'bmp')).size);
    TTImage.release(res.value);
    // The page cannot draw it: decode() with a canvas, and toCanvas().
    closedBitmaps.length = workerJobs.length = 0;
    out.decode = await outcome(() => TTImage.decode(file));
    const key = (workerJobs.find(j => j.startsWith('native:')) || '').slice(7);
    out.decodeFreed = workerJobs.includes(`free:${key}`);
    out.decodeClosed = closedBitmaps.includes(`${N}x${N}`);
    const lazy = await TTImage.decode(file, { canvas: false });
    closedBitmaps.length = 0;
    out.toCanvas = await outcome(() => TTImage.toCanvas(lazy));
    out.toCanvasClosed = closedBitmaps.includes(`${N}x${N}`);
    TTImage.release(lazy);
    const bm = await createImageBitmap(file);
    out.resize = await outcome(() => TTImage.resize(bm, 600, 600));
    bm.close();
    return out;
  }, CANVAS_LIMIT);
  await context.close();
  const where = `assets/js/image-decode.js, with a canvas size limit like Safari's (here ${CANVAS_LIMIT / 1e6} megapixels) and a 4200 x 4200 picture`;
  if (r.decoded) { problems.push(`${where}: decode({ canvas: false }) failed (${r.decoded}), so the limit is not tested`); return; }
  for (const k of ['png', 'ico']) {
    if (r[k].value !== true) problems.push(`${where}: a ${k === 'png' ? '600 x 600 PNG' : '256 x 256 ICO'} copy ${r[k].code ? `failed (${r[k].code})` : 'came out blank or wrong'}: the first half-size step is over the limit and must be made without a canvas`);
  }
  if (r.bmp.code !== 'TOO_BIG') problems.push(`${where}: a full-size BMP ${r.bmp.code ? `failed with ${r.bmp.code}` : 'was saved blank'} instead of failing with TOO_BIG`);
  if (r.decode.code !== 'TOO_BIG') problems.push(`${where}: decode() with a canvas gave ${r.decode.code || 'a result'}, expected TOO_BIG`);
  else if (!r.decodeFreed || !r.decodeClosed) problems.push(`${where}: decode() failed with TOO_BIG but ${!r.decodeFreed ? 'left the picture in its worker' : 'did not close its full-size copy on the page'}`);
  if (r.toCanvas.code !== 'TOO_BIG') problems.push(`${where}: toCanvas() gave ${r.toCanvas.code || 'a canvas'}, expected TOO_BIG`);
  else if (!r.toCanvasClosed) problems.push(`${where}: toCanvas() failed with TOO_BIG but did not close its full-size copy`);
  if (r.resize.code !== 'TOO_BIG') problems.push(`${where}: resize() to 600 x 600 gave ${r.resize.code || 'a canvas (blank)'}, expected TOO_BIG`);
}

// Checks of the shared pages and files, run once on a full build.
// Lines of a page's front matter where a plain (unquoted) YAML value meets
// " #", which YAML reads as the start of a comment, so the rest of the value
// is dropped. Block scalars (| and >) keep # as text and are skipped.
function hashCuts(src) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!fm) return [];
  const cut = [];
  let block = -1; // a block scalar's lines are indented past this column
  fm[1].split(/\r?\n/).forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (block >= 0) {
      if (!line.trim() || indent > block) return;
      block = -1;
    }
    if (/^\s*(#|$)/.test(line)) return; // a comment or a blank line
    const m = /^(\s*(?:-\s+)?)([^\s:#][^:#]*?):(?:\s+(.*))?$/.exec(line);
    const value = m ? (m[3] || '') : line.trim();
    if (m && /^[|>][-+0-9]*\s*(#.*)?$/.test(value)) { block = m[1].length; return; }
    if (/^["']/.test(value)) return;
    if (/(^|\s)#/.test(value)) cut.push(i + 2);
  });
  return cut;
}

async function siteChecks(browser, base, problems) {
  const slugs = fs.readdirSync(path.join(ROOT, '_tools')).map(f => f.replace(/\.(html|md)$/, ''));
  // A value cut at " #" in the front matter: eight FAQ answers once lost
  // everything after "the # sign", and a question "What is #FF5733 in RGB?"
  // showed as "What is".
  for (const f of fs.readdirSync(path.join(ROOT, '_tools')).sort()) {
    for (const line of hashCuts(fs.readFileSync(path.join(ROOT, '_tools', f), 'utf8'))) {
      problems.push(`_tools/${f}, line ${line}: a front matter value is cut at " #", which YAML reads as a comment; quote the value`);
    }
  }
  const { context, page } = await newPage(browser, base, { width: 1280, height: 900 }, problems);
  const get = async p => {
    const resp = await page.request.get(base + p);
    if (resp.status() !== 200) problems.push(`GET ${p} returned ${resp.status()}`);
    return resp.text();
  };

  for (const p of ['/', '/about/', '/privacy/', '/404.html']) {
    await page.goto(base + p, { waitUntil: 'load' });
    const before = problems.length;
    await commonChecks(page, problems);
    for (let i = before; i < problems.length; i++) problems[i] = `${p}: ${problems[i]}`;
    // Styles and TT are inlined; a blocking request in <head> costs a round trip before first paint.
    const blocking = await page.$$eval('head link[rel="stylesheet"], head script[src]:not([async]):not([defer])', els => els.map(e => e.getAttribute('href') || e.getAttribute('src')));
    if (blocking.length) problems.push(`${p}: render-blocking resources in <head>: ${blocking.join(', ')}`);
    if (!(await page.evaluate(() => window.TT && typeof TT.copy === 'function'))) problems.push(`${p}: window.TT is missing`);
  }
  // Old cached pages still link these.
  if (!/^\s*:root \{/.test(await get('/assets/css/style.css'))) problems.push('/assets/css/style.css does not serve the stylesheet');
  if (!/window\.TT = /.test(await get('/assets/js/common.js'))) problems.push('/assets/js/common.js does not serve the shared helpers');

  // Every head names the home-screen icon and gives the browser's own bars the
  // colour of the page background (--bg) in each colour scheme.
  for (const p of ['/', '/case-converter/']) {
    await page.goto(base + p, { waitUntil: 'load' });
    const icons = await page.$$eval('link[rel="apple-touch-icon"]', links => links.map(l => l.getAttribute('href')));
    if (icons.join() !== '/assets/apple-touch-icon.png') problems.push(`${p}: expected one apple-touch-icon link to /assets/apple-touch-icon.png, found [${icons.join(', ')}]`);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      const c = await page.evaluate(scheme => {
        const probe = document.body.appendChild(document.createElement('div'));
        const rgb = colour => { probe.style.color = colour; return getComputedStyle(probe).color; };
        const metas = [...document.querySelectorAll('meta[name="theme-color"]')].filter(m => m.getAttribute('media') === `(prefers-color-scheme: ${scheme})`);
        const out = { count: metas.length, theme: metas.length ? rgb(metas[0].content) : null, bg: rgb('var(--bg)') };
        probe.remove();
        return out;
      }, colorScheme);
      if (c.count !== 1) problems.push(`${p}: expected one theme-color meta tag for the ${colorScheme} colour scheme, found ${c.count}`);
      else if (c.theme !== c.bg) problems.push(`${p}: the ${colorScheme} theme-color is ${c.theme}, but the page background (--bg) is ${c.bg}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
  // The icon is a 180x180 PNG without transparency, which iOS would paint
  // black. Width and height are at bytes 16 and 20 of a PNG, the colour type
  // at byte 25 (4 and 6 have an alpha channel).
  const icon = await page.request.get(base + '/assets/apple-touch-icon.png');
  const png = icon.status() === 200 ? await icon.body() : Buffer.alloc(0);
  if (icon.status() !== 200 || !/^image\/png/.test(icon.headers()['content-type'] || '') || png.length < 26 || png.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') {
    problems.push(`/assets/apple-touch-icon.png is not served as a PNG (status ${icon.status()})`);
  } else {
    const [w, h, type] = [png.readUInt32BE(16), png.readUInt32BE(20), png[25]];
    if (w !== 180 || h !== 180) problems.push(`/assets/apple-touch-icon.png is ${w}x${h}, expected 180x180`);
    if (type === 4 || type === 6 || png.includes('tRNS')) problems.push('/assets/apple-touch-icon.png has transparency, which iOS paints black');
    if (png.length >= 20 * 1024) problems.push(`/assets/apple-touch-icon.png is ${png.length} bytes (keep it under 20 KB)`);
  }

  // Smooth scrolling is animation, so it is only for visitors who have not
  // asked their system to reduce motion (WCAG 2.3.3).
  for (const [reducedMotion, expected] of [['reduce', 'auto'], ['no-preference', 'smooth']]) {
    await page.emulateMedia({ reducedMotion });
    const behavior = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
    if (behavior !== expected) problems.push(`with prefers-reduced-motion: ${reducedMotion} the page's scroll-behavior is ${behavior}, expected ${expected}`);
  }
  await page.emulateMedia({ reducedMotion: null });

  // Homepage search results are announced (WCAG 4.1.3).
  await page.goto(base + '/', { waitUntil: 'load' });
  const announced = async (query, expected) => {
    await page.fill('#tool-search', query);
    const ok = await page.waitForFunction(t => {
      const el = document.querySelector('#search-status[role="status"]');
      return el && el.textContent === t;
    }, expected, { timeout: 3000 }).then(() => true, () => false);
    if (!ok) problems.push(`homepage search "${query}" is not announced as "${expected}" in a role=status region`);
  };
  await announced('zzzz-no-such-tool', 'No tools match that search.');
  await page.fill('#tool-search', 'image');
  const matches = await page.$$eval('#all-tools li[data-search]:not([hidden])', l => l.length);
  assert.ok(matches > 1 && matches < slugs.length, `"image" matched ${matches} tools`);
  await announced('image', `${matches} tools match.`);
  await announced('', `Showing all ${slugs.length} tools.`);

  // A word with a letter and a digit side by side finds a tool however its
  // text spells them: "code128" and "code-128" find "Code 128", "300dpi" finds
  // "300 dpi". The examples come from the tools' own text: the first word of
  // three or more letters next to a number, letters first and digits first,
  // that the text writes with a hyphen or space and never joined up.
  const spellings = await page.$$eval('#all-tools li[data-search]', lis => {
    const out = [];
    for (const order of [/(?<![a-z\d])([a-z]{3,})[- ](\d+)(?![a-z\d])/g, /(?<![a-z\d])(\d+)[- ]([a-z]{3,})(?![a-z\d])/g]) {
      found: for (const li of lis) {
        const text = li.getAttribute('data-search');
        for (const m of text.matchAll(order)) {
          if (text.includes(m[1] + m[2])) continue;
          out.push({ said: m[0], href: li.querySelector('a').getAttribute('href'), words: [m[1] + m[2], `${m[1]}-${m[2]}`] });
          break found;
        }
      }
    }
    return out;
  });
  if (spellings.length < 2) problems.push(`homepage search: found ${spellings.length} of the 2 kinds of tool text it needs (a word then a number, a number then a word) to test joined-up spellings`);
  for (const s of spellings) {
    for (const word of s.words) {
      await page.fill('#tool-search', word);
      if (await page.$eval(`#all-tools a[href="${s.href}"]`, a => a.closest('li').hidden)) problems.push(`homepage search "${word}" does not show ${s.href}, whose text says "${s.said}"`);
    }
  }
  await page.fill('#tool-search', '');

  // Field outlines need 3:1 and placeholder text 4.5:1 against the surfaces
  // fields sit on, in both colour schemes (WCAG 1.4.11, 1.4.3).
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const c = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('div'));
      const out = {};
      for (const v of ['--field-border', '--bg', '--surface', '--surface-2']) {
        probe.style.color = `var(${v})`;
        out[v] = getComputedStyle(probe).color;
      }
      probe.remove();
      const search = document.getElementById('tool-search');
      out.searchBorder = getComputedStyle(search).borderTopColor;
      out.placeholder = getComputedStyle(search, '::placeholder').color;
      return out;
    });
    if (c.searchBorder !== c['--field-border']) problems.push(`${colorScheme}: the search box border does not use --field-border`);
    for (const bg of ['--bg', '--surface', '--surface-2']) {
      const r = contrast(c.searchBorder, c[bg]);
      if (r < 3) problems.push(`${colorScheme}: field border is ${r.toFixed(2)}:1 against ${bg} (needs 3:1)`);
      const pr = contrast(c.placeholder, c[bg]);
      if (pr < 4.5) problems.push(`${colorScheme}: placeholder text is ${pr.toFixed(2)}:1 against ${bg} (needs 4.5:1)`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone widths and 200% zoom for the non-tool pages.
  const narrow = await newPage(browser, base, PHONES[0], problems, TOUCH);
  for (const p of ['/', '/about/', '/privacy/', '/404.html']) await narrowChecks(narrow.page, page, base + p, problems, `${p}: `);
  await page.setViewportSize({ width: 1280, height: 900 });

  // A guide table too wide for a phone scrolls inside its own box, and what
  // that hides must be reachable without a pointer (WCAG 2.1.1): the table is
  // a tab stop that the arrow keys scroll. Chromium makes any scrolling box a
  // tab stop, Safari only one with a tabindex, which common.js therefore sets
  // and takes away again where the table fits.
  const guideTables = p => p.$$eval('.prose table', tables => tables.map(t => ({ scrolls: t.scrollWidth > t.clientWidth + 1, tabindex: t.getAttribute('tabindex') })));
  await narrow.page.setViewportSize(PHONES[0]);
  await narrow.page.goto(base + '/case-converter/', { waitUntil: 'load' });
  const onPhone = await guideTables(narrow.page);
  if (!onPhone.some(t => t.scrolls)) {
    problems.push('/case-converter/: no guide table is wider than a 390px screen, so keyboard scrolling of such a table is not being tested');
  } else {
    if (onPhone.some(t => t.scrolls !== (t.tabindex === '0'))) problems.push(`/case-converter/ at 390px: a guide table should have tabindex="0" exactly when it scrolls sideways: ${JSON.stringify(onPhone)}`);
    if (!(await tabReaches(narrow.page, '.prose table'))) {
      problems.push('/case-converter/ at 390px: Tab does not reach the guide table that scrolls sideways');
    } else {
      const focused = await narrow.page.evaluate(() => document.activeElement.scrollWidth > document.activeElement.clientWidth + 1 && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none');
      if (!focused) problems.push('/case-converter/ at 390px: the guide table that Tab reaches is not the one that scrolls, or shows no focus outline');
      await narrow.page.keyboard.press('ArrowRight');
      const scrolled = await narrow.page.waitForFunction(() => document.activeElement.scrollLeft > 0, null, { timeout: 3000 }).then(() => true, () => false);
      if (!scrolled) problems.push('/case-converter/ at 390px: the Right arrow key does not scroll the focused guide table');
    }
  }

  // A long line in a code block of a guide or an FAQ answer must not make the
  // page scroll sideways on a phone or at 200% zoom, nor be cut off in a box
  // that is not a tab stop, which keyboard users could not scroll. The style
  // sheet wraps the line.
  for (const [p, viewport] of [[narrow.page, PHONES[0]], [narrow.page, PHONES[1]], [page, ZOOMED]]) {
    await p.setViewportSize(viewport);
    await p.goto(base + CODE_SAMPLE_URL, { waitUntil: 'load' });
    const c = await p.evaluate(width => {
      for (const d of document.querySelectorAll('details')) d.open = true;
      const blocks = [...document.querySelectorAll('.prose pre, .faq pre')];
      return {
        where: blocks.map(b => (b.closest('.prose') ? 'guide' : 'faq')).sort().join(),
        cut: blocks.filter(b => getComputedStyle(b).overflowX !== 'visible' && b.scrollWidth > b.clientWidth + 1 && b.getAttribute('tabindex') !== '0').length,
        overflow: document.documentElement.scrollWidth - width,
      };
    }, viewport.width);
    if (c.where !== 'faq,guide') problems.push(`${CODE_SAMPLE_URL}: expected one code block (pre) in the guide and one in the FAQ answer, found [${c.where}]`);
    if (c.overflow > 1) problems.push(`${CODE_SAMPLE_URL}: a long line in a code block makes the page scroll sideways at ${viewport.width}px wide (${c.overflow}px overflow)`);
    if (c.cut) problems.push(`${CODE_SAMPLE_URL}: at ${viewport.width}px wide ${c.cut} code block(s) cut off a long line in a box that is not a tab stop, so a keyboard cannot scroll to the rest`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await narrow.context.close();
  await page.goto(base + '/case-converter/', { waitUntil: 'load' });
  const onDesktop = await guideTables(page);
  if (onDesktop.some(t => t.scrolls || t.tabindex !== null)) problems.push(`/case-converter/ at 1280px: the guide tables should fit and have no tabindex: ${JSON.stringify(onDesktop)}`);
  if (await tabReaches(page, '.prose table')) problems.push('/case-converter/ at 1280px: a guide table that fits is a tab stop');

  await pasteOverLongText(page, base, problems);
  await quotedAnswerOpens(page, base, slugs, problems);
  await canvasLimitChecks(browser, base, problems);
  await sliderSwipeChecks(browser, base, problems);

  // About and Privacy agree on whether the site shows ads, and the ad-blocker
  // promise only appears when there are ads.
  const text = async p => { await page.goto(base + p); return page.textContent('main'); };
  const about = await text('/about/');
  const privacy = await text('/privacy/');
  const noAds = /does not currently show ads/.test(privacy);
  if (/kept free by advertising/.test(about) === noAds) problems.push('About and Privacy disagree about whether the site shows ads');
  if (noAds && /Ads never block/.test(privacy)) problems.push('Privacy promises ads never block a tool right after saying there are no ads');

  // <lastmod> only for pages that set a date. Jekyll dates every tool with
  // the build time, which must never be published as a modification date.
  const sitemap = await get('/sitemap.xml');
  const urls = new Map([...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g)].map(m => [new URL(m[1]).pathname, m[2]]));
  for (const p of ['/', '/about/', '/privacy/']) if (!urls.has(p)) problems.push(`sitemap.xml is missing ${p}`);
  if (urls.has('/404.html')) problems.push('sitemap.xml lists /404.html');
  for (const slug of slugs) {
    const dated = /^(last_modified_at|date):/m.test(frontMatter(toolFile(slug)));
    if (!urls.has(`/${slug}/`)) problems.push(`sitemap.xml is missing /${slug}/`);
    else if (!!urls.get(`/${slug}/`) !== dated) {
      problems.push(`sitemap.xml: /${slug}/ ${dated ? 'has no <lastmod> although its front matter sets a date' : `has <lastmod> ${urls.get(`/${slug}/`)} but its front matter sets no date`}`);
    }
  }
  for (const p of urls.keys()) {
    if (!['/', '/about/', '/privacy/'].includes(p) && !slugs.includes(p.replace(/^\/|\/$/g, ''))) problems.push(`sitemap.xml lists ${p}, which is neither a tool nor a shared page`);
  }
  // GitHub Pages turns every Markdown file it publishes into a web page, with
  // or without front matter, and the sitemap then lists it. This build does
  // not, so the files are checked instead: outside the folders Jekyll skips
  // (dot and underscore names, and `exclude` in _config.yml) only the About
  // and Privacy pages may be Markdown. Licence notices are kept as .txt.
  const excluded = new Set(((fs.readFileSync(path.join(ROOT, '_config.yml'), 'utf8').match(/^exclude:\n((?: +- .*\n)+)/m) || [])[1] || '')
    .split('\n').map(l => l.replace(/^ +- /, '').trim()).filter(Boolean));
  const strayMarkdown = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (/^[._#~]/.test(entry.name) || excluded.has(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(md|markdown|mkdown|mkdn|mkd)$/i.test(entry.name) && !['about.md', 'privacy.md'].includes(rel)) strayMarkdown.push(rel);
    }
  })('');
  if (strayMarkdown.length) problems.push(`GitHub Pages would publish these Markdown files as web pages and list them in the sitemap; rename them to .txt: ${strayMarkdown.join(', ')}`);
  if (!/Sitemap: .*\/sitemap\.xml/.test(await get('/robots.txt'))) problems.push('robots.txt does not point to the sitemap');

  // "More free tools" rotates, so every tool is linked from several others
  // rather than the alphabetically first ones from every page.
  const inbound = Object.fromEntries(slugs.map(s => [s, 0]));
  for (const slug of slugs) {
    const section = ((await get(`/${slug}/`)).match(/<section class="related">([\s\S]*?)<\/section>/) || [])[1] || '';
    const links = [...section.matchAll(/href="\/([^"/]+)\/"/g)].map(m => m[1]);
    if (links.length !== Math.min(6, slugs.length - 1)) problems.push(`/${slug}/ lists ${links.length} related tools`);
    if (links.includes(slug) || new Set(links).size !== links.length) problems.push(`/${slug}/ related tools repeat or include itself: ${links.join(' ')}`);
    for (const l of links) if (l in inbound) inbound[l]++;
  }
  if (slugs.length >= 7) {
    const few = Object.entries(inbound).filter(([, n]) => n < 3);
    if (few.length) problems.push(`tools linked from fewer than 3 related-tool lists: ${few.map(([s, n]) => `${s} (${n})`).join(', ')}`);
  }
  await context.close();
}


// The first four lines of an error's stack, plus the first line that points
// into a test file when those lines do not reach one. An assertion message
// with a diff can fill the first four lines, and the failing line of the test
// is what is needed to find the fault.
function failureText(e) {
  if (!e || !e.stack) return String(e);
  const lines = e.stack.split('\n');
  // The whole message, which for a failed deepEqual is a diff over several
  // lines (up to 40 of them are kept), then three frames.
  const head = lines.slice(0, Math.min(String(e.message).split('\n').length, 40) + 3);
  const at = lines.find(l => /^\s*at .*[\\/]tests[\\/]tools[\\/]/.test(l)) ||
    lines.find(l => /^\s*at .*[\\/]tests[\\/]run\.js:/.test(l));
  if (at && !head.includes(at)) head.push(at);
  return head.join('\n');
}

async function main() {
  const only = process.argv.slice(2);
  const testFiles = (only.length ? only : fs.readdirSync(TESTS).filter(f => f.endsWith('.test.js')).map(f => f.replace(/\.test\.js$/, '')))
    .map(slug => ({ slug, file: path.join(TESTS, slug + '.test.js') }));
  for (const t of testFiles) if (!fs.existsSync(t.file)) throw new Error(`Missing test file tests/tools/${t.slug}.test.js`);

  const { out, work } = build(only);
  const server = await serve(out);
  // Fake camera/microphone so device-test tools can be exercised headlessly.
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  let failed = 0;
  let total = testFiles.length;

  for (const t of testFiles) {
    const problems = [];
    const url = `${server.base}/${t.slug}/`;
    try {
      const { context, page } = await newPage(browser, server.base, { width: 1280, height: 900 }, problems);
      const open = async () => {
        const resp = await page.goto(url, { waitUntil: 'load' });
        assert.equal(resp.status(), 200, `GET ${url} returned ${resp.status()}`);
      };
      await require(t.file)({ page, open, assert, base: server.base, url, fixtures: path.join(__dirname, 'fixtures', t.slug) });
      const { skipped } = await commonChecks(page, problems);
      // With whatever the test left on screen (results, messages, tables) the
      // page must still fit a phone. The pause lets scripts that follow the
      // window size, such as a canvas being redrawn, catch up.
      for (const viewport of PHONES) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(width => document.documentElement.scrollWidth - width, viewport.width);
        if (overflow > 1) problems.push(`horizontal scroll at ${viewport.width}px wide with the test's results on screen (${overflow}px overflow)`);
      }
      await context.close();

      const phone = await newPage(browser, server.base, PHONES[0], problems, TOUCH);
      const zoomed = await newPage(browser, server.base, ZOOMED, problems);
      await narrowChecks(phone.page, zoomed.page, url, problems);
      // Also as served, every <details> closed, in case the test opened or
      // removed something that skipped its content.
      const served = (await skippedContent(zoomed.page)).filter(s => !skipped.includes(s));
      if (served.length) problems.push(skippedProblem(served, 'as served: '));
      await phone.context.close();
      await zoomed.context.close();
    } catch (e) {
      problems.push(`test failed: ${failureText(e)}`);
    }
    if (problems.length) {
      failed++;
      console.log(`FAIL ${t.slug}\n  - ${problems.join('\n  - ')}`);
    } else {
      console.log(`ok   ${t.slug}`);
    }
  }

  if (!only.length) {
    total++;
    const problems = [];
    try {
      await siteChecks(browser, server.base, problems);
    } catch (e) {
      problems.push(`site checks failed: ${failureText(e)}`);
    }
    if (problems.length) {
      failed++;
      console.log(`FAIL (site)\n  - ${problems.join('\n  - ')}`);
    } else {
      console.log('ok   (site)');
    }
  }

  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
