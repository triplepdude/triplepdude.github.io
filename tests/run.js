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
 * rendered, and valid JSON-LD with no blog-post markup.
 *
 * A full run (no slugs) also runs siteChecks: the homepage, About, Privacy and
 * 404 pages, the sitemap, related-tool links, the shared colour tokens, the
 * icon and theme colours in the head, reduced motion, and keyboard scrolling
 * of a guide table that is too wide for a phone.
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

// Checks of the shared pages and files, run once on a full build.
async function siteChecks(browser, base, problems) {
  const slugs = fs.readdirSync(path.join(ROOT, '_tools')).map(f => f.replace(/\.(html|md)$/, ''));
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
  await narrow.context.close();
  await page.goto(base + '/case-converter/', { waitUntil: 'load' });
  const onDesktop = await guideTables(page);
  if (onDesktop.some(t => t.scrolls || t.tabindex !== null)) problems.push(`/case-converter/ at 1280px: the guide tables should fit and have no tabindex: ${JSON.stringify(onDesktop)}`);
  if (await tabReaches(page, '.prose table')) problems.push('/case-converter/ at 1280px: a guide table that fits is a tab stop');

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
      await commonChecks(page, problems);
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
      await phone.context.close();
      await zoomed.context.close();
    } catch (e) {
      problems.push(`test failed: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e}`);
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
      problems.push(`site checks failed: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e}`);
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
