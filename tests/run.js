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
 * other hosts, a single <h1>, a meta description, and no horizontal scroll
 * at phone width.
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

async function newPage(browser, base, viewport, problems) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
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
      await context.close();

      const mobile = await newPage(browser, server.base, { width: 390, height: 844 }, problems);
      await mobile.page.goto(url, { waitUntil: 'load' });
      const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`horizontal scroll at 390px wide (${overflow}px overflow)`);
      await mobile.context.close();
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

  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${testFiles.length - failed}/${testFiles.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
