const fs = require('fs');
const path = require('path');

// Expected values never come from the page's own code:
// - browser, engine and OS: real headless Chromium is compared with its own
//   navigator.userAgentData; stubbed browsers (addInitScript) use real user
//   agent strings and Client Hints, with Windows 11 = platformVersion >= 13
//   and 1-10 = Windows 10 (Microsoft's documented mapping).
// - features: each one is re-detected below with the raw API. Image formats
//   use the fixture files (2x2 images encoded with libavif, libwebp and
//   libjxl), not the page's embedded samples.
// - canvas hash: SHA-256 of the drawn canvas pixels, recomputed here.
// - device memory: the Device Memory spec rounds to the NEAREST power of two
//   and Chrome caps it at 8, so the page may only say "about" (8 = "or more").
// - "AppleWebKit/605.1.15" has been frozen since 2017, so the WebKit version
//   shown is the one that ships with that iOS or Safari release.
// - every user agent below is a real one; Client Hints follow the UA-CH spec
//   (Chromium-only, so any Client Hints next to a Firefox, Safari or iOS user
//   agent mean the string was replaced).
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, base, url, fixtures }) => {
  const text = s => page.locator(s).textContent();
  const done = p => p.waitForFunction(() => document.getElementById('bt').dataset.state === 'done', null, { timeout: 20000, polling: 100 });
  const cell = (p, tbody, key) => p.$eval(`#${tbody} tr[data-key="${key}"] .bt-v`, e => e.textContent);
  const note = (p, tbody, key) => p.$eval(`#${tbody} tr[data-key="${key}"] td small`, e => e.textContent).catch(() => '');
  const items = (p, sel) => p.$$eval(sel, els => els.map(e => e.textContent));

  // Long tasks are recorded from before the first page script runs.
  await page.addInitScript(() => {
    window.__long = [];
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
      }).observe({ type: 'longtask' });
    } catch (e) { /* not supported */ }
  });
  await open();
  await done(page);
  // No long tasks once the page has loaded: the probes yield between steps.
  const long = await page.evaluate(() => {
    const dcl = performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd;
    return window.__long.filter(t => t.start >= dcl);
  });
  assert.ok(long.every(t => t.ms <= 100), `long tasks after load: ${JSON.stringify(long)}`);

  // ---------- Summary in real headless Chromium ----------
  const raw = await page.evaluate(async () => {
    const d = navigator.userAgentData;
    const he = await d.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'formFactors']);
    return { ua: navigator.userAgent, brands: d.brands, platform: d.platform, mobile: d.mobile, he };
  });
  const headless = raw.he.fullVersionList.find(b => b.brand === 'HeadlessChrome');
  const chromium = raw.he.fullVersionList.find(b => b.brand === 'Chromium');
  assert.ok(headless && chromium, JSON.stringify(raw.he.fullVersionList));
  assert.equal(await text('#bt-browser'), 'Headless Chrome ' + headless.version);
  assert.equal(await text('#bt-engine'), 'Blink ' + chromium.version);
  assert.equal(raw.platform, 'Linux');
  assert.equal(await text('#bt-os'), 'Linux');
  assert.equal(await text('#bt-device'), 'Desktop');
  assert.equal(await text('#bt-sentence'), `You are using Headless Chrome ${headless.version.split('.')[0]} on Linux.`);
  assert.match((await items(page, '#bt-notes li')).join(' '), /headless mode/);

  // ---------- User agent and Client Hints ----------
  assert.equal(await text('#bt-ua'), raw.ua);
  assert.match((await items(page, '#bt-ua-notes li')).join('\n'), /"AppleWebKit\/537\.36".*the engine is Blink/);
  assert.equal(await page.isVisible('#bt-ch-none'), false);
  assert.equal(await cell(page, 'bt-ch-rows', 'platform'), 'Linux');
  assert.equal(await cell(page, 'bt-ch-rows', 'mobile'), raw.mobile ? 'Yes' : 'No');
  assert.equal(await cell(page, 'bt-ch-rows', 'platformVersion'), raw.he.platformVersion);
  assert.match(await note(page, 'bt-ch-rows', 'platformVersion'), /kernel version/);
  assert.equal(await cell(page, 'bt-ch-rows', 'architecture'), raw.he.architecture);
  assert.equal(await cell(page, 'bt-ch-rows', 'bitness'), raw.he.bitness);
  assert.equal(await cell(page, 'bt-ch-rows', 'model'), 'Empty');
  assert.equal(await cell(page, 'bt-ch-rows', 'formFactors'), raw.he.formFactors.join(', '));
  const brandText = raw.brands.map(b => b.brand + ' ' + b.version + (/not.?a.?brand/i.test(b.brand) ? ' (placeholder)' : '')).join(', ');
  assert.equal(await cell(page, 'bt-ch-rows', 'brands'), brandText);
  assert.match(await page.$eval('#bt-ch-rows tr[data-key="brands"] th', e => e.textContent), /Sec-CH-UA · sent with every request/);
  assert.match(await page.$eval('#bt-ch-rows tr[data-key="model"] th', e => e.textContent), /Sec-CH-UA-Model · sent when a site asks/);
  // Copy user agent.
  await page.click('#bt-ua-copy');
  await page.waitForFunction(() => document.getElementById('bt-ua-copy').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), raw.ua);

  // ---------- Feature support, re-detected with the raw APIs ----------
  const img = f => 'data:image/' + f + ';base64,' + fs.readFileSync(path.join(fixtures, 'pixels.' + f)).toString('base64');
  const expected = await page.evaluate(async images => {
    const S = q => CSS.supports(q);
    const compiles = src => { try { new Function(src); return true; } catch (e) { return false; } };
    const decode = src => new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth === 2); i.onerror = () => r(false); i.src = src; });
    const media = (tag, types) => types.some(t => document.createElement(tag).canPlayType(t) !== '' || (!!window.MediaSource && MediaSource.isTypeSupported(t)));
    const wasm = b => WebAssembly.validate(new Uint8Array(b));
    const glCtx = type => { const g = document.createElement('canvas').getContext(type); if (g) g.getExtension('WEBGL_lose_context').loseContext(); return !!g; };
    const p3 = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    const n = navigator;
    let regexV = true; try { new RegExp('[\\p{L}--[a-z]]', 'v'); } catch (e) { regexV = false; }
    let ls = true; try { ls = !!localStorage; } catch (e) { ls = false; }
    return {
      'private-fields': compiles('class A { #x = 1; static has(o) { return #x in o; } }'),
      'regexp-v': regexV,
      'array-copy': typeof [].toSorted === 'function' && typeof [].with === 'function',
      'group-by': typeof Object.groupBy === 'function',
      'with-resolvers': typeof Promise.withResolvers === 'function',
      'set-methods': typeof new Set().union === 'function' && typeof new Set().isSubsetOf === 'function',
      'iterator-helpers': typeof globalThis.Iterator === 'function' && typeof [].values().map === 'function',
      'using': compiles('{ using x = null; }'),
      'temporal': typeof globalThis.Temporal === 'object',
      'base64': typeof Uint8Array.fromBase64 === 'function' && typeof new Uint8Array(1).toBase64 === 'function',
      'import-maps': HTMLScriptElement.supports('importmap'),
      'container-queries': S('container-type: inline-size'),
      'has': S('selector(:has(a))'),
      'nesting': S('selector(&)'),
      'subgrid': S('grid-template-rows: subgrid'),
      'layers': 'CSSLayerBlockRule' in window,
      'scope': 'CSSScopeRule' in window,
      'view-transitions': 'startViewTransition' in document && S('view-transition-name: a'),
      'anchor': S('anchor-name: --a'),
      'scroll-timeline': S('animation-timeline: scroll()'),
      'color-mix': S('color: color-mix(in srgb, red, blue)'),
      'oklch': S('color: oklch(50% 0.1 120)'),
      'relative-color': S('color: rgb(from red r g b)'),
      'text-wrap-balance': S('text-wrap: balance'),
      'dialog': typeof document.createElement('dialog').showModal === 'function',
      'popover': 'popover' in document.createElement('div'),
      'invokers': 'command' in document.createElement('button'),
      'dsd': 'shadowRootMode' in document.createElement('template'),
      'inert': 'inert' in document.createElement('div'),
      'base-select': S('appearance: base-select'),
      'navigation-api': 'navigation' in window,
      'web-share': 'share' in n,
      'clipboard': !!n.clipboard && 'writeText' in n.clipboard,
      'canvas': !!document.createElement('canvas').getContext('2d'),
      'offscreen-canvas': 'OffscreenCanvas' in window && !!new OffscreenCanvas(1, 1).getContext('2d'),
      'p3-canvas': !!p3 && p3.getContextAttributes().colorSpace === 'display-p3',
      'webgl': glCtx('webgl'),
      'webgl2': glCtx('webgl2'),
      'webgpu': !!(n.gpu && await n.gpu.requestAdapter()),
      'avif': await decode(images.avif),
      'webp': await decode(images.webp),
      'jxl': await decode(images.jxl),
      'h264': media('video', ['video/mp4; codecs="avc1.42E01E"']),
      'hevc': media('video', ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"']),
      'vp9': media('video', ['video/webm; codecs="vp09.00.10.08"', 'video/mp4; codecs="vp09.00.10.08"', 'video/webm; codecs="vp9"']),
      'av1': media('video', ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"']),
      'aac': media('audio', ['audio/mp4; codecs="mp4a.40.2"']),
      'opus': media('audio', ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"', 'audio/mp4; codecs="opus"']),
      'mse': 'MediaSource' in window || 'ManagedMediaSource' in window,
      'eme': 'requestMediaKeySystemAccess' in n,
      'webcodecs': 'VideoDecoder' in window && 'VideoEncoder' in window,
      'webrtc': 'RTCPeerConnection' in window,
      'web-audio': 'AudioContext' in window,
      'local-storage': ls,
      'indexeddb': !!window.indexedDB,
      'cache-api': 'caches' in window,
      'service-worker': 'serviceWorker' in n,
      'opfs': !!n.storage && 'getDirectory' in n.storage,
      'fs-access': 'showOpenFilePicker' in window,
      'storage-estimate': !!n.storage && 'estimate' in n.storage,
      'persist': !!n.storage && 'persist' in n.storage,
      'cookie-store': 'cookieStore' in window,
      'media-devices': !!n.mediaDevices && 'getUserMedia' in n.mediaDevices,
      'screen-capture': !!n.mediaDevices && 'getDisplayMedia' in n.mediaDevices,
      'gamepad': 'getGamepads' in n,
      'webusb': 'usb' in n,
      'bluetooth': 'bluetooth' in n,
      'serial': 'serial' in n,
      'hid': 'hid' in n,
      'midi': 'requestMIDIAccess' in n,
      'webxr': 'xr' in n,
      'wake-lock': 'wakeLock' in n,
      'secure-context': window.isSecureContext,
      'coi': window.crossOriginIsolated,
      'sab': 'SharedArrayBuffer' in window,
      'web-crypto': !!crypto.subtle,
      'webauthn': 'PublicKeyCredential' in window,
      'passkey-autofill': 'PublicKeyCredential' in window && !!PublicKeyCredential.isConditionalMediationAvailable && await PublicKeyCredential.isConditionalMediationAvailable(),
      'fedcm': 'IdentityCredential' in window,
      'trusted-types': 'trustedTypes' in window,
      'storage-access': 'requestStorageAccess' in document,
      'wasm': wasm([0, 97, 115, 109, 1, 0, 0, 0]),
      'wasm-simd': wasm([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
      'wasm-threads': wasm([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]),
      'wasm-tail': wasm([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11]),
      'wasm-gc': wasm([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0]),
      'workers': 'Worker' in window,
      'shared-workers': 'SharedWorker' in window,
      'post-task': 'scheduler' in window && 'postTask' in scheduler,
      'speculation-rules': HTMLScriptElement.supports('speculationrules')
    };
  }, { avif: img('avif'), webp: img('webp'), jxl: img('jxl') });
  // The independent checks above must themselves be meaningful in this Chromium.
  for (const id of ['webgl', 'webgl2', 'avif', 'webp', 'wasm', 'wasm-simd', 'has', 'container-queries', 'secure-context', 'vp9', 'opus']) assert.equal(expected[id], true, `Chromium supports ${id}`);
  for (const id of ['jxl', 'coi', 'sab']) assert.equal(expected[id], false, `${id} is unavailable here`);
  const shown = await page.$$eval('.bt-feat', els => els.map(e => ({
    id: e.dataset.feature, s: e.dataset.supported, val: e.querySelector('.bt-fval').textContent, ico: e.querySelector('.bt-ico').textContent
  })));
  assert.deepEqual(shown.map(f => f.id).sort(), Object.keys(expected).sort(), 'every feature on the page is checked here');
  assert.ok(shown.length >= 60 && shown.length <= 90, `${shown.length} features`);
  for (const f of shown) {
    assert.equal(f.s, expected[f.id] ? 'yes' : 'no', `feature ${f.id}`);
    // Text and icon, not colour alone.
    assert.equal(f.val, expected[f.id] ? 'Yes' : 'No', `label of ${f.id}`);
    assert.equal(f.ico, expected[f.id] ? '✓' : '✕', `icon of ${f.id}`);
  }
  const yes = Object.values(expected).filter(Boolean).length;
  const total = shown.length;
  assert.equal(await text('#bt-score'), `${yes} of ${total} supported`);
  const groupCount = await page.$eval('.bt-group[data-group="gfx"] .bt-gcount', e => e.textContent);
  const gfx = ['canvas', 'offscreen-canvas', 'p3-canvas', 'webgl', 'webgl2', 'webgpu', 'avif', 'webp', 'jxl'];
  assert.equal(groupCount, `${gfx.filter(id => expected[id]).length} of 9`);
  assert.deepEqual(await page.$$eval('.bt-group h3', els => els.map(e => e.firstChild.textContent.trim())), ['JavaScript', 'CSS', 'HTML & DOM',
    'Graphics', 'Media & codecs', 'Storage & offline', 'Devices & sensors', 'Security & privacy', 'Performance'], 'group order');
  // SharedArrayBuffer explains cross-origin isolation; WebGPU without an adapter says so.
  assert.match(await text('.bt-feat[data-feature="sab"] .bt-fdetail'), /not cross-origin isolated/);
  if (!expected.webgpu) assert.match(await text('.bt-feat[data-feature="webgpu"] .bt-fdetail'), /no GPU adapter/);

  // A second, different way of detecting the features where a wrong answer is
  // most likely: run the syntax, parse real stylesheets, set real style
  // values, decode the fixtures with createImageBitmap, create WebGL on an
  // OffscreenCanvas, validate a different SIMD module and ask MediaCapabilities.
  const raw8 = f => Array.from(fs.readFileSync(path.join(fixtures, 'pixels.' + f)));
  const alt = await page.evaluate(async imgs => {
    const ok = f => { try { return !!f(); } catch (e) { return false; } };
    const rules = css => { const s = new CSSStyleSheet(); s.replaceSync(css); return s.cssRules; };
    const styled = (prop, value) => ok(() => { const e = document.createElement('div'); e.style.setProperty(prop, value); return e.style.getPropertyValue(prop) !== ''; });
    const bitmap = async (bytes, type) => { try { return (await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }))).width === 2; } catch (e) { return false; } };
    const mse = async type => (await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: type, width: 640, height: 360, bitrate: 1e6, framerate: 30 } })).supported;
    const audio = async type => (await navigator.mediaCapabilities.decodingInfo({ type: 'file', audio: { contentType: type } })).supported;
    return {
      'private-fields': ok(() => new Function('class A { #x = 1; static g(o) { return #x in o && o.#x === 1; } } return A.g(new A());')()),
      'using': ok(() => new Function('let ran = false; { using x = { [Symbol.dispose]() { ran = true; } }; } return ran;')()),
      'iterator-helpers': ok(() => [1, 2].values().map(x => x * 2).toArray()[1] === 4),
      'set-methods': ok(() => new Set([1]).union(new Set([2])).size === 2),
      'base64': ok(() => Uint8Array.fromBase64('AQI=')[1] === 2),
      'temporal': ok(() => Temporal.Now.instant()),
      'nesting': ok(() => rules('a { & b { color: red } }')[0].cssRules.length === 1),
      'has': ok(() => (document.querySelector(':has(*)'), true)),
      'container-queries': ok(() => rules('@container (min-width: 1px) { a { color: red } }')[0] instanceof CSSContainerRule),
      'layers': ok(() => rules('@layer x { a { color: red } }')[0] instanceof CSSLayerBlockRule),
      'scope': ok(() => rules('@scope (a) { b { color: red } }')[0] instanceof CSSScopeRule),
      'subgrid': styled('grid-template-columns', 'subgrid'),
      'anchor': styled('position-anchor', '--a'),
      'color-mix': styled('color', 'color-mix(in srgb, red, blue)'),
      'oklch': styled('color', 'oklch(50% 0.1 120)'),
      'relative-color': styled('color', 'rgb(from red r g b)'),
      'text-wrap-balance': styled('text-wrap', 'balance'),
      'scroll-timeline': typeof ScrollTimeline === 'function',
      'view-transitions': typeof ViewTransition === 'function',
      'popover': typeof HTMLElement.prototype.showPopover === 'function',
      'invokers': 'commandForElement' in HTMLButtonElement.prototype,
      'dsd': ok(() => !!Document.parseHTMLUnsafe('<div><template shadowrootmode="open"><b>x</b></template></div>').querySelector('div').shadowRoot),
      'webgl': ok(() => new OffscreenCanvas(1, 1).getContext('webgl')),
      'webgl2': ok(() => new OffscreenCanvas(1, 1).getContext('webgl2')),
      'avif': await bitmap(imgs.avif, 'image/avif'),
      'webp': await bitmap(imgs.webp, 'image/webp'),
      'jxl': await bitmap(imgs.jxl, 'image/jxl'),
      // v128.const i32x4 0 0 0 0, drop: a different SIMD instruction from the page's
      'wasm-simd': WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 23, 1, 21, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 11])),
      'h264': await mse('video/mp4; codecs="avc1.42E01E"'),
      'hevc': await mse('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      'vp9': await mse('video/webm; codecs="vp09.00.10.08"'),
      'av1': await mse('video/mp4; codecs="av01.0.05M.08"'),
      'aac': await audio('audio/mp4; codecs="mp4a.40.2"'),
      'opus': await audio('audio/webm; codecs="opus"')
    };
  }, { avif: raw8('avif'), webp: raw8('webp'), jxl: raw8('jxl') });
  const byId = Object.fromEntries(shown.map(f => [f.id, f.s === 'yes']));
  for (const [id, v] of Object.entries(alt)) assert.equal(byId[id], v, `feature ${id} agrees with a second detection method`);

  // "Show only features this browser lacks", operated with the keyboard.
  await page.focus('#bt-only-no');
  await page.keyboard.press('Space');
  assert.equal(await page.isChecked('#bt-only-no'), true);
  assert.equal(await page.isVisible('.bt-feat[data-feature="has"]'), false);
  assert.equal(await page.isVisible('.bt-feat[data-feature="sab"]'), true);
  // A group with nothing missing says so instead of showing an empty list.
  const cssIds = await page.$$eval('.bt-group[data-group="css"] .bt-feat', els => els.map(e => e.dataset.feature));
  assert.equal(await page.isVisible('.bt-group[data-group="css"] .bt-full-note'), cssIds.every(id => expected[id]));
  await page.keyboard.press('Space');
  assert.equal(await page.isVisible('.bt-feat[data-feature="has"]'), true);

  // ---------- Hardware and display ----------
  const hw = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
      vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), conn: { et: navigator.connection.effectiveType, dl: navigator.connection.downlink } };
  });
  assert.equal(await cell(page, 'bt-hw-rows', 'cores'), hw.cores + ' logical processors');
  assert.equal(await cell(page, 'bt-hw-rows', 'arch'), raw.he.architecture === 'x86' ? 'x86 (Intel or AMD), ' + raw.he.bitness + '-bit' : raw.he.architecture);
  // Chrome before 147 reports 0.25 to 8 GB; 147 and later 2 to 32 GB (2 to 8 on Android).
  const memTop = Number(chromium.version.split('.')[0]) >= 147 ? 32 : 8;
  const memBottom = memTop === 32 ? 2 : 0.25;
  assert.equal(await cell(page, 'bt-hw-rows', 'memory'), 'About ' + (hw.mem < 1 ? hw.mem * 1024 + ' MB' : hw.mem + ' GB') +
    (hw.mem >= memTop ? ' or more' : hw.mem <= memBottom ? ' or less' : ''));
  assert.match(await note(page, 'bt-hw-rows', 'memory'), /nearest power of two.*Chrome 147 and later report 2 to 32 GB \(2 to 8 GB on Android\)/);
  assert.equal(await cell(page, 'bt-hw-rows', 'gpu'), hw.renderer);
  assert.equal(await cell(page, 'bt-hw-rows', 'gpu-vendor'), hw.vendor);
  if (/SwiftShader/.test(hw.renderer)) assert.match(await note(page, 'bt-hw-rows', 'gpu'), /^Software rendering/);
  assert.equal(await cell(page, 'bt-hw-rows', 'touch'), 'None (no touch screen)');
  assert.equal(await cell(page, 'bt-hw-rows', 'screen'), '1280 × 900 CSS pixels');
  assert.equal(await cell(page, 'bt-hw-rows', 'dpr'), '1');
  assert.equal(await cell(page, 'bt-hw-rows', 'gamut'), 'sRGB (standard)');
  // "4g" is the top bucket and Chrome caps downlink at 10 Mb/s, so both are lower bounds.
  assert.ok((await cell(page, 'bt-hw-rows', 'network')).startsWith(hw.conn.et.toUpperCase() + (hw.conn.et === '4g' ? '-class or faster connection, ' : '-class connection, ') +
    (hw.conn.dl >= 10 ? '10 Mb/s or more' : 'about ' + hw.conn.dl + ' Mb/s')), await cell(page, 'bt-hw-rows', 'network'));
  assert.match(await note(page, 'bt-hw-rows', 'network'), /estimate/);
  const links = await page.$$eval('#bt-sec-hardware a', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/screen-resolution/', '/webcam-test/', '/mic-test/', '/keyboard-tester/']);

  // ---------- Privacy and settings ----------
  const pv = await page.evaluate(() => ({
    langs: navigator.languages.join(', '), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gpc: navigator.globalPrivacyControl, dnt: navigator.doNotTrack, webdriver: navigator.webdriver
  }));
  assert.equal(await cell(page, 'bt-pv-rows', 'cookies'), 'Enabled');
  assert.equal(await cell(page, 'bt-pv-rows', 'javascript'), 'On');
  assert.equal(pv.dnt, null);
  assert.equal(await cell(page, 'bt-pv-rows', 'dnt'), 'Off');
  assert.equal(pv.gpc, undefined);
  assert.equal(await cell(page, 'bt-pv-rows', 'gpc'), 'Not supported by this browser');
  assert.equal(await cell(page, 'bt-pv-rows', 'languages'), pv.langs);
  assert.match(await cell(page, 'bt-pv-rows', 'timezone'), new RegExp('^' + pv.tz.replace(/[+]/g, '\\+') + ' \\(UTC[+-]\\d\\d:\\d\\d\\)$'));
  assert.equal(await cell(page, 'bt-pv-rows', 'scheme'), 'Light');
  assert.equal(await cell(page, 'bt-pv-rows', 'motion'), 'Off (no preference)');
  assert.equal(await cell(page, 'bt-pv-rows', 'automation'), pv.webdriver ? 'Yes: automation software (WebDriver) is driving this browser' : 'No');
  assert.equal(await cell(page, 'bt-pv-rows', 'private'), 'Cannot be detected reliably');
  assert.match(await note(page, 'bt-pv-rows', 'dnt'), /Safari removed it in 2019, and Firefox replaced it with Global Privacy Control in version 135/);
  assert.match(await note(page, 'bt-pv-rows', 'gpc'), /Firefox sends it in private windows/);
  assert.match(await note(page, 'bt-pv-rows', 'timezone'), /does not ask for your location/);
  assert.match(await cell(page, 'bt-pv-rows', 'storage'), /^About [\d.]+ (MB|GB) allowed, 0 bytes used$/);

  // ---------- Fingerprint signals ----------
  const hashes = {};
  for (const k of ['canvas', 'webgl', 'audio', 'fonts']) hashes[k] = await text(`#bt-fp-${k}-hash`);
  hashes.combined = await text('#bt-fp-combined');
  for (const [k, v] of Object.entries(hashes)) assert.match(v, /^[0-9a-f]{16}$/, `${k} hash`);
  assert.equal(new Set(Object.values(hashes)).size, 5, 'hashes differ from each other');
  // The canvas hash is SHA-256 of the pixels shown in the drawing.
  const canvasHash = await page.evaluate(async () => {
    const c = document.getElementById('bt-fp-canvas');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const h = await crypto.subtle.digest('SHA-256', px);
    return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
  });
  assert.equal(hashes.canvas, canvasHash.slice(0, 16));
  const fonts = await items(page, '#bt-fonts li');
  assert.ok(fonts.length > 0, 'some fonts found');
  assert.match(await text('#bt-fonts-sum'), new RegExp(`^${fonts.length} of the 34 common fonts checked were found`));
  assert.equal(await text('#bt-fp-msg'), '', 'no randomisation in plain Chromium');
  // A second run gives identical hashes and says so, without long tasks.
  await page.evaluate(() => { window.__long = []; });
  await page.click('#bt-fp-again');
  await page.waitForFunction(() => /^Run 2:/.test(document.getElementById('bt-fp-msg').textContent));
  const longAgain = await page.evaluate(() => window.__long);
  assert.ok(longAgain.every(t => t.ms <= 100), `long tasks while re-running the fingerprint: ${JSON.stringify(longAgain)}`);
  assert.equal(await text('#bt-fp-msg'), 'Run 2: every hash matches the first run, so these values are stable during this visit.');
  assert.equal(await text('#bt-fp-combined'), hashes.combined);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bt-fp-again');
  // Deterministic across reloads: a fresh page load in another tab gives the same hashes.
  const fpHashes = p => p.evaluate(() => Object.fromEntries(['canvas-hash', 'webgl-hash', 'audio-hash', 'fonts-hash', 'combined'].map(k => [k, document.getElementById('bt-fp-' + k).textContent])));
  const firstLoad = await fpHashes(page);
  const reloaded = await page.context().newPage();
  await reloaded.goto(url);
  await done(reloaded);
  assert.deepEqual(await fpHashes(reloaded), firstLoad, 'hashes are identical after a reload');
  await reloaded.close();

  // ---------- Report ----------
  await page.click('#bt-copy');
  await page.waitForFunction(() => document.getElementById('bt-copy').textContent === 'Copied!');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, new RegExp('^Browser report from ' + url.replace(/[.?]/g, '\\$&') + '\nCreated: \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\n'));
  assert.ok(clip.includes(`\nSUMMARY\n  You are using Headless Chrome ${headless.version.split('.')[0]} on Linux.\n  Browser: Headless Chrome ${headless.version}\n`), clip);
  assert.ok(clip.includes(`\nUSER AGENT\n  ${raw.ua}\n`));
  assert.ok(clip.includes('\nCLIENT HINTS\n  Brands: ' + brandText + '\n'));
  assert.ok(clip.includes(`\nFEATURE SUPPORT: ${yes} of ${total}\n`));
  assert.match(clip, /\n {2}Graphics: \d of 9 \(missing: [^)]*JPEG XL images\)\n/);
  assert.match(clip, /\n {2}Security & privacy: \d of 9 \(missing: Cross-origin isolation, SharedArrayBuffer\)\n/);
  assert.ok(clip.includes(`\nHARDWARE AND DISPLAY\n  CPU cores: ${hw.cores} logical processors\n`));
  assert.ok(clip.includes('\nPRIVACY AND SETTINGS\n  Cookies: Enabled\n'));
  assert.ok(!clip.includes(hashes.combined) && !clip.includes(hashes.canvas), 'the text report leaves out fingerprint hashes');
  // The preview shows the same report.
  const strip = s => s.replace(/^Created: .*$/m, '');
  assert.equal(strip(await text('#bt-report-text')), strip(clip));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bt-download')]);
  assert.equal(dl.suggestedFilename(), 'browser-report.json');
  const json = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(json.userAgent, raw.ua);
  assert.equal(json.summary.browser, 'Headless Chrome');
  assert.equal(json.summary.browserVersion, headless.version);
  assert.equal(json.summary.engine, 'Blink');
  assert.equal(json.summary.os, 'Linux');
  assert.equal(json.clientHints.platform, 'Linux');
  assert.equal(json.clientHints.platformVersion, raw.he.platformVersion);
  assert.equal(json.features.supported, yes);
  assert.equal(json.features.total, total);
  const flat = json.features.groups.flatMap(g => g.items);
  assert.equal(flat.length, total);
  for (const f of flat) assert.equal(f.supported, expected[f.id], `JSON ${f.id}`);
  assert.equal(json.hardware['CPU cores'], hw.cores + ' logical processors');
  assert.equal(json.privacy.Cookies, 'Enabled');
  assert.match(json.fingerprint.combined, /^[0-9a-f]{64}$/);
  assert.equal(json.fingerprint.combined.slice(0, 16), hashes.combined);
  assert.equal(json.fingerprint.canvas, canvasHash);
  assert.deepEqual(json.fingerprint.fonts, fonts);
  assert.equal(json.fingerprint.runs, 2);

  // ---------- Accessibility ----------
  assert.equal(await text('#bt-status'), `Browser check finished. You are using Headless Chrome ${headless.version.split('.')[0]} on Linux. ${yes} of ${total} features supported.`);
  assert.equal(await page.getAttribute('#bt-status', 'role'), 'status');
  for (const sel of ['#bt-sentence', '#bt-groups', '#bt-score', '#bt-hw-rows', '#bt-pv-rows', '#bt-ch-rows', '#bt-fp-combined', '#bt-report-text', '#bt-fp-msg']) {
    assert.equal(await page.locator(sel).evaluate(e => !!e.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]')), false, `${sel} is not a live region`);
  }
  // One heading per section, in order, and every control is labelled.
  assert.deepEqual(await items(page, '.bt-sec > h2'), ['Summary', 'User agent', 'Feature support', 'Hardware and display', 'Privacy and settings', 'Fingerprint signals', 'Report']);
  const unlabelled = await page.$$eval('#bt button, #bt input, #bt select', els => els.filter(e => {
    if (e.tagName === 'INPUT') return !(e.labels && e.labels.length && e.labels[0].textContent.trim());
    return !e.textContent.trim() && !e.getAttribute('aria-label');
  }).map(e => e.id));
  assert.deepEqual(unlabelled, []);
  for (const href of await page.$$eval('.bt-jump a', as => as.map(a => a.getAttribute('href')))) {
    assert.equal(await page.locator(href).count(), 1, `jump link ${href}`);
  }
  const noscript = await page.$eval('noscript', e => e.textContent);
  assert.match(noscript, /JavaScript is turned off/);
  // Regression: aria-labelledby on a <p> (whose role forbids a name) was silently ignored.
  const misnamed = await page.$$eval('#bt [aria-label], #bt [aria-labelledby]', els => els
    .filter(e => ['P', 'DIV', 'SPAN', 'PRE', 'B', 'SMALL', 'CODE'].includes(e.tagName) && !e.getAttribute('role')).map(e => e.id || e.tagName));
  assert.deepEqual(misnamed, [], 'aria-label(ledby) on elements that cannot be named');
  // Regression: the report preview scrolled but could not be reached with the keyboard (axe
  // scrollable-region-focusable). Every scrolling area must be focusable and named.
  await page.click('.bt-preview summary');
  const stuck = await page.$$eval('#bt *', els => els.filter(e => {
    const cs = getComputedStyle(e);
    const scrolls = (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1);
    return scrolls && !(e.tabIndex >= 0 && (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')));
  }).map(e => e.id || e.className));
  assert.deepEqual(stuck, [], 'scrollable areas that keyboard users cannot reach');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bt-report-text', 'Tab from the summary reaches the report preview');
  await page.keyboard.press('PageDown');
  // Keyboard scrolling is animated, so wait for it.
  assert.ok(await page.waitForFunction(() => document.getElementById('bt-report-text').scrollTop > 0, null, { timeout: 3000 }).then(() => true, () => false),
    'the report preview scrolls with the keyboard');
  assert.equal(await page.$eval('#bt-report-text', e => getComputedStyle(e).outlineStyle), 'solid', 'visible focus on the report preview');
  await page.click('.bt-preview summary');
  // "Yes"/"No" stays on the first line of its card even when the name wraps.
  const head = await page.$eval('.bt-feat[data-feature="eme"]', li => {
    const n = li.querySelector('.bt-fname').getBoundingClientRect(), v = li.querySelector('.bt-fval').getBoundingClientRect();
    return { nTop: n.top, vTop: v.top, nRight: n.right, vLeft: v.left };
  });
  assert.ok(Math.abs(head.vTop - head.nTop) < 6 && head.vLeft >= head.nRight, `EME value beside its name: ${JSON.stringify(head)}`);

  // ---------- Stubbed browsers ----------
  const ctx = page.context();
  const WIN_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const GREASE = { brand: 'Not?A_Brand', version: '8' };
  const hints = (brands, full, platform, mobile, high) => ({
    brands: brands.concat([GREASE]), platform, mobile,
    high: Object.assign({ fullVersionList: full.concat([{ brand: 'Not?A_Brand', version: '8.0.0.0' }]), architecture: 'x86', bitness: '64', model: '', formFactors: [mobile ? 'Mobile' : 'Desktop'], wow64: false }, high)
  });
  const stub = cfg => {
    const def = (obj, key, value) => Object.defineProperty(obj, key, { configurable: true, get: () => value });
    const N = Navigator.prototype;
    if ('ua' in cfg) def(N, 'userAgent', cfg.ua);
    if (cfg.uaData === 'none') def(N, 'userAgentData', undefined);
    else if (cfg.uaData) {
      const d = cfg.uaData;
      const low = { brands: d.brands, mobile: d.mobile, platform: d.platform };
      def(N, 'userAgentData', Object.assign({}, low, {
        // A browser may refuse the detailed hints (Permissions Policy) or never answer.
        getHighEntropyValues: d.reject ? () => Promise.reject(new DOMException('Refused', 'NotAllowedError')) : d.hang ? () => new Promise(() => {}) :
          list => Promise.resolve(Object.assign({}, low, Object.fromEntries(list.filter(h => h in d.high).map(h => [h, d.high[h]])))),
        toJSON: () => low
      }));
    }
    if ('touch' in cfg) def(N, 'maxTouchPoints', cfg.touch);
    if ('mem' in cfg) def(N, 'deviceMemory', cfg.mem);
    if (cfg.conn) def(N, 'connection', cfg.conn);
    if (cfg.extra) (0, eval)(cfg.extra);
    if (cfg.brave) def(N, 'brave', { isBrave: () => Promise.resolve(true) });
    if ('gpc' in cfg) def(N, 'globalPrivacyControl', cfg.gpc);
    if ('dnt' in cfg) def(N, 'doNotTrack', cfg.dnt === 'unset' ? undefined : cfg.dnt);
    if (cfg.noisyCanvas) {
      // Like Safari's or Firefox's protection: every read gets different noise.
      // (A counter, not Math.random, so two reads can never get the same noise.)
      const read = CanvasRenderingContext2D.prototype.getImageData;
      let reads = 0;
      CanvasRenderingContext2D.prototype.getImageData = function () {
        const d = read.apply(this, arguments);
        d.data[0] = (d.data[0] + 1 + (reads++ % 200)) % 256;
        return d;
      };
    }
  };
  const scenario = async (cfg, check) => {
    const p = await ctx.newPage();
    const problems = [];
    p.on('pageerror', e => problems.push(`page error: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
    await p.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
      problems.push(`external request: ${u}`);
      return r.abort();
    });
    await p.addInitScript(stub, cfg);
    const started = Date.now();
    await p.goto(url);
    await done(p);
    if (cfg.within) assert.ok(Date.now() - started < cfg.within, `${cfg.name}: finished in ${Date.now() - started} ms`);
    const got = {};
    for (const k of ['browser', 'engine', 'os', 'device', 'sentence']) got[k] = await p.locator('#bt-' + k).textContent();
    try {
      for (const [k, v] of Object.entries(cfg.expect)) assert.equal(got[k], v, `${cfg.name}: ${k}`);
      if (check) await check(p);
    } finally {
      await p.close();
    }
    assert.deepEqual(problems, [], cfg.name);
  };
  const notes = p => items(p, '#bt-notes li').then(l => l.join('\n'));
  const uaNotes = p => items(p, '#bt-ua-notes li').then(l => l.join('\n'));
  // Detection only: waits for the summary and the user agent notes, not for every probe.
  const quick = async cfg => {
    const p = await ctx.newPage();
    const problems = [];
    p.on('pageerror', e => problems.push(`page error: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
    await p.route('**/*', r => (r.request().url().startsWith(base) || r.request().url().startsWith('data:') ? r.continue() : (problems.push('external ' + r.request().url()), r.abort())));
    await p.addInitScript(stub, cfg);
    await p.goto(url);
    await p.waitForFunction(() => document.getElementById('bt-browser').textContent !== 'Checking…' && document.getElementById('bt-ua-notes').children.length > 0 &&
      document.getElementById('bt').dataset.tables === 'filled', null, { timeout: 10000 });
    const got = await p.evaluate(() => {
      const t = id => document.getElementById(id).textContent;
      const list = id => Array.from(document.querySelectorAll('#' + id + ' li'), l => l.textContent).join('\n');
      return { browser: t('bt-browser'), engine: t('bt-engine'), os: t('bt-os'), device: t('bt-device'), sentence: t('bt-sentence'), notes: list('bt-notes'), uaNotes: list('bt-ua-notes') };
    });
    // Table rows that depend on the detected browser are filled in the same step as the summary.
    for (const [k, v] of Object.entries(cfg.rows || {})) {
      const [tbody, key] = k.split(':');
      got[k] = await cell(p, tbody, key);
      assert.equal(got[k], v, `${cfg.name}: ${k}`);
    }
    await p.close();
    for (const [k, v] of Object.entries(cfg.expect)) assert.equal(got[k], v, `${cfg.name}: ${k}`);
    if (cfg.notes) assert.match(got.notes, cfg.notes, `${cfg.name}: notes`);
    if (cfg.noNotes) assert.doesNotMatch(got.notes, cfg.noNotes, `${cfg.name}: notes`);
    if (cfg.uaNotes) assert.match(got.uaNotes, cfg.uaNotes, `${cfg.name}: user agent notes`);
    if (cfg.noUaNotes) assert.doesNotMatch(got.uaNotes, cfg.noUaNotes, `${cfg.name}: user agent notes`);
    assert.deepEqual(problems, [], cfg.name);
  };
  const chMissing = async p => {
    assert.equal(await p.isVisible('#bt-ch-wrap'), false);
    assert.match(await p.locator('#bt-ch-none').textContent(), /does not support User-Agent Client Hints/);
  };

  await scenario({
    name: 'Firefox on Windows', uaData: 'none', gpc: true, dnt: '1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    expect: { browser: 'Firefox 131.0', engine: 'Gecko 131.0', os: 'Windows 10 or 11', device: 'Desktop', sentence: 'You are using Firefox 131 on Windows 10 or 11.' }
  }, async p => {
    assert.match(await notes(p), /Windows 10 and 11 send the same user agent/);
    assert.match(await uaNotes(p), /"Windows NT 10\.0" is sent by both Windows 10 and Windows 11\.[\s\S]*"Gecko\/20100101" is a fixed date/);
    await chMissing(p);
    assert.equal(await cell(p, 'bt-pv-rows', 'gpc'), 'On');
    assert.equal(await cell(p, 'bt-pv-rows', 'dnt'), 'On');
    assert.equal(await cell(p, 'bt-hw-rows', 'arch'), 'x64 (64-bit Intel or AMD), according to the user agent');
    assert.match(await note(p, 'bt-hw-rows', 'arch'), /ARM processors can report x64 too/);
  });
  await scenario({
    name: 'Safari on a Mac', uaData: 'none', touch: 0, dnt: 'unset',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    expect: { browser: 'Safari 18.6', engine: 'WebKit (Safari 18.6)', os: 'macOS (version hidden)', device: 'Desktop', sentence: 'You are using Safari 18.6 on macOS.' }
  }, async p => {
    assert.match(await notes(p), /every recent Mac as macOS 10\.15/);
    assert.match(await uaNotes(p), /"Mac OS X 10_15_7".*frozen[\s\S]*"AppleWebKit\/605\.1\.15" is frozen/);
    await chMissing(p);
    assert.equal(await cell(p, 'bt-pv-rows', 'dnt'), 'Not supported by this browser');
    assert.match(await cell(p, 'bt-hw-rows', 'arch'), /^Not reported: Mac user agents say "Intel"/);
  });
  await scenario({
    name: 'Safari on an iPad (desktop mode)', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    expect: { browser: 'Safari 18.6', os: 'iPadOS 18.6', device: 'Tablet (iPad)', sentence: 'You are using Safari 18.6 on iPadOS 18.6.' }
  }, async p => assert.match(await notes(p), /iPads ask for desktop websites/));
  await scenario({
    name: 'Safari 26 on an iPhone (iOS frozen at 18.6)', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    expect: { browser: 'Safari 26.0', engine: 'WebKit (iOS 26)', os: 'iOS 26', device: 'Mobile (iPhone)', sentence: 'You are using Safari 26 on iOS 26.' }
  }, async p => assert.match(await uaNotes(p), /"OS 18_6" is frozen/));
  await scenario({
    name: 'Chrome on an iPhone', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
    expect: { browser: 'Chrome 141.0.7390.96', engine: 'WebKit (iOS 17.5)', os: 'iOS 17.5', device: 'Mobile (iPhone)', sentence: 'You are using Chrome 141 on iOS 17.5.' }
  }, async p => assert.match(await notes(p), /use Apple's WebKit engine/));
  await scenario({
    name: 'Firefox on an iPhone (iOS 26)', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
    expect: { browser: 'Firefox 144.0', engine: 'WebKit (iOS 18.6 or later)', os: 'iOS 18.6 or later', sentence: 'You are using Firefox 144 on iOS 18.6 or later.' }
  });
  await scenario({
    name: 'Edge on Windows 11', touch: 0,
    ua: WIN_CHROME_UA + ' Edg/141.0.0.0',
    uaData: hints([{ brand: 'Microsoft Edge', version: '141' }, { brand: 'Chromium', version: '141' }],
      [{ brand: 'Microsoft Edge', version: '141.0.3537.71' }, { brand: 'Chromium', version: '141.0.7390.108' }], 'Windows', false, { platformVersion: '19.0.0' }),
    expect: { browser: 'Edge 141.0.3537.71', engine: 'Blink 141.0.7390.108', os: 'Windows 11', device: 'Desktop', sentence: 'You are using Edge 141 on Windows 11.' }
  }, async p => {
    assert.equal(await cell(p, 'bt-ch-rows', 'platformVersion'), '19.0.0');
    assert.match(await note(p, 'bt-ch-rows', 'platformVersion'), /Windows 11/);
    assert.match(await uaNotes(p), /"Chrome\/141\.0\.0\.0": the version is reduced to its first number\. The full version \(141\.0\.7390\.108\)/);
    assert.doesNotMatch(await notes(p), /Windows 10 and 11/);
  });
  await scenario({
    name: 'Chrome on Windows 10', touch: 0, ua: WIN_CHROME_UA,
    uaData: hints([{ brand: 'Google Chrome', version: '141' }, { brand: 'Chromium', version: '141' }],
      [{ brand: 'Google Chrome', version: '141.0.7390.108' }, { brand: 'Chromium', version: '141.0.7390.108' }], 'Windows', false, { platformVersion: '10.0.0' }),
    expect: { browser: 'Chrome 141.0.7390.108', engine: 'Blink 141.0.7390.108', os: 'Windows 10', sentence: 'You are using Chrome 141 on Windows 10.' }
  }, async p => assert.match(await note(p, 'bt-ch-rows', 'platformVersion'), /Windows 10/));
  await scenario({
    name: 'Chrome on Android', touch: 5,
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    uaData: hints([{ brand: 'Google Chrome', version: '141' }, { brand: 'Chromium', version: '141' }],
      [{ brand: 'Google Chrome', version: '141.0.7390.111' }, { brand: 'Chromium', version: '141.0.7390.111' }], 'Android', true,
      { platformVersion: '15.0.0', model: 'Pixel 9', architecture: '', bitness: '' }),
    expect: { browser: 'Chrome 141.0.7390.111', engine: 'Blink 141.0.7390.111', os: 'Android 15', device: 'Mobile (Pixel 9)', sentence: 'You are using Chrome 141 on Android 15.' }
  }, async p => {
    assert.match(await uaNotes(p), /"Android 10; K" is a fixed placeholder/);
    assert.equal(await cell(p, 'bt-ch-rows', 'model'), 'Pixel 9');
  });
  await scenario({
    name: 'Samsung Internet without Client Hints', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    expect: { browser: 'Samsung Internet 28.0', engine: 'Blink 130', os: 'Android (version hidden)', device: 'Mobile', sentence: 'You are using Samsung Internet 28 on Android.' }
  }, async p => assert.match(await notes(p), /placeholder "Android 10; K"/));
  await scenario({
    name: 'Samsung Internet with Client Hints', touch: 5,
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    uaData: hints([{ brand: 'Samsung Internet', version: '28.0' }, { brand: 'Chromium', version: '130' }],
      [{ brand: 'Samsung Internet', version: '28.0' }, { brand: 'Chromium', version: '130.0.6723.86' }], 'Android', true,
      { platformVersion: '14.0.0', model: 'SM-S921B', architecture: '', bitness: '' }),
    expect: { browser: 'Samsung Internet 28.0', engine: 'Blink 130.0.6723.86', os: 'Android 14', device: 'Mobile (SM-S921B)', sentence: 'You are using Samsung Internet 28 on Android 14.' }
  });
  await scenario({
    name: 'Brave on Windows 11', touch: 0, brave: true, ua: WIN_CHROME_UA,
    uaData: hints([{ brand: 'Brave', version: '141' }, { brand: 'Chromium', version: '141' }],
      [{ brand: 'Brave', version: '141.0.0.0' }, { brand: 'Chromium', version: '141.0.0.0' }], 'Windows', false, { platformVersion: '15.0.0' }),
    expect: { browser: 'Brave (Chromium 141)', engine: 'Blink 141', os: 'Windows 11', sentence: 'You are using Brave (Chromium 141) on Windows 11.' }
  }, async p => {
    assert.match(await notes(p), /recognised through navigator\.brave/);
    // Brave's noise stays fixed for a session, so matching runs prove nothing there.
    assert.match(await p.locator('#bt-fp-msg').textContent(), /Brave changes its fingerprint noise for each site and each browser session/);
  });
  await scenario({
    name: 'Opera on macOS', touch: 0,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/123.0.0.0',
    uaData: hints([{ brand: 'Opera', version: '123' }, { brand: 'Chromium', version: '139' }],
      [{ brand: 'Opera', version: '123.0.5669.23' }, { brand: 'Chromium', version: '139.0.7258.155' }], 'macOS', false, { platformVersion: '15.6.1', architecture: 'arm' }),
    expect: { browser: 'Opera 123.0.5669.23', engine: 'Blink 139.0.7258.155', os: 'macOS 15.6.1 (Sequoia)', sentence: 'You are using Opera 123 on macOS 15.6.1.' }
  }, async p => {
    assert.doesNotMatch(await notes(p), /version is hidden/);
    assert.equal(await cell(p, 'bt-hw-rows', 'arch'), 'ARM, 64-bit');
  });
  await scenario({
    name: 'Firefox on Android', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    expect: { browser: 'Firefox 131.0', engine: 'Gecko 131.0', os: 'Android 15', device: 'Mobile', sentence: 'You are using Firefox 131 on Android 15.' }
  });
  await scenario({
    name: 'Instagram in-app browser on Android', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 Instagram 344.0.0.34.101 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 628581337)',
    expect: { browser: 'Instagram in-app browser (app 344.0.0.34.101)', engine: 'Blink 127.0.6533.103', os: 'Android 14', device: 'Mobile (Pixel 8)', sentence: 'You are using Instagram\'s in-app browser on Android 14.' }
  }, async p => assert.match(await notes(p), /app's built-in browser/));
  await scenario({
    name: 'Facebook in-app browser on an iPhone', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.98;FBBV/123;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
    expect: { browser: 'Facebook in-app browser (app 470.0.0.40.98)', engine: 'WebKit (iOS 17.5)', os: 'iOS 17.5', device: 'Mobile (iPhone)', sentence: 'You are using Facebook\'s in-app browser on iOS 17.5.' }
  });
  await scenario({
    name: 'DuckDuckGo on Android', uaData: 'none', touch: 5,
    ua: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile DuckDuckGo/5 Safari/537.36',
    expect: { browser: 'DuckDuckGo', engine: 'Blink 124', os: 'Android 14', device: 'Mobile', sentence: 'You are using DuckDuckGo on Android 14.' }
  });
  // A WebView-based browser keeps the name from its user agent token over the generic brand.
  await scenario({
    name: 'DuckDuckGo on Android with Client Hints', touch: 5,
    ua: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile DuckDuckGo/5 Safari/537.36',
    uaData: hints([{ brand: 'Android WebView', version: '124' }, { brand: 'Chromium', version: '124' }],
      [{ brand: 'Android WebView', version: '124.0.6367.179' }, { brand: 'Chromium', version: '124.0.6367.179' }], 'Android', true, { platformVersion: '14.0.0', architecture: '', bitness: '' }),
    expect: { browser: 'DuckDuckGo', engine: 'Blink 124.0.6367.179', os: 'Android 14', device: 'Mobile', sentence: 'You are using DuckDuckGo on Android 14.' }
  });
  // A Firefox user agent on a browser with Client Hints has been changed.
  await scenario({
    name: 'Spoofed user agent',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    expect: { browser: 'Headless Chrome ' + headless.version, engine: 'Blink ' + chromium.version, os: 'Linux' }
  }, async p => {
    assert.match(await notes(p), /The user agent claims Firefox on Windows, but this browser supports Client Hints/);
    assert.doesNotMatch(await notes(p), /The user agent says Windows/, 'one note for one spoof');
  });
  // Canvas noise (Brave, Safari and Firefox protections) is noticed and explained.
  await scenario({ name: 'Randomised canvas', noisyCanvas: true, ua: raw.ua, expect: {} }, async p => {
    assert.match(await p.locator('#bt-fp-msg').textContent(), /^Drawing the same image twice gave different canvas hashes/);
    await p.click('#bt-fp-again');
    await p.waitForFunction(() => /Run 2:/.test(document.getElementById('bt-fp-msg').textContent));
    assert.match(await p.locator('#bt-fp-msg').textContent(), /Run 2: the canvas hash changed since the first run, so this browser randomises that signal\./);
  });
  // ---------- Detection matrix: real user agents and Client Hints ----------
  const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const LINUX_CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  const ANDROID_TABLET_UA = ANDROID_UA.replace(' Mobile', '');
  const SAMSUNG_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
  const OPERA_UA = WIN_CHROME_UA.replace('141.0.0.0', '139.0.0.0') + ' OPR/123.0.0.0';
  const IPHONE = v => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)`;
  const B = {
    chrome: [[{ brand: 'Google Chrome', version: '141' }, { brand: 'Chromium', version: '141' }], [{ brand: 'Google Chrome', version: '141.0.7390.108' }, { brand: 'Chromium', version: '141.0.7390.108' }]],
    edge: [[{ brand: 'Microsoft Edge', version: '141' }, { brand: 'Chromium', version: '141' }], [{ brand: 'Microsoft Edge', version: '141.0.3537.71' }, { brand: 'Chromium', version: '141.0.7390.108' }]],
    opera: [[{ brand: 'Opera', version: '123' }, { brand: 'Chromium', version: '139' }], [{ brand: 'Opera', version: '123.0.5669.23' }, { brand: 'Chromium', version: '139.0.7258.155' }]],
    brave: [[{ brand: 'Brave', version: '141' }, { brand: 'Chromium', version: '141' }], [{ brand: 'Brave', version: '141.0.0.0' }, { brand: 'Chromium', version: '141.0.0.0' }]],
    // Vivaldi lists only Chromium and sends Chrome's user agent.
    vivaldi: [[{ brand: 'Chromium', version: '140' }], [{ brand: 'Chromium', version: '140.0.7339.214' }]],
    samsung: [[{ brand: 'Samsung Internet', version: '28.0' }, { brand: 'Chromium', version: '130' }], [{ brand: 'Samsung Internet', version: '28.0' }, { brand: 'Chromium', version: '130.0.6723.86' }]]
  };
  const ch = (b, platform, mobile, high) => hints(B[b][0], B[b][1], platform, mobile, high);
  const WIN10 = { platformVersion: '10.0.0' }, WIN11 = { platformVersion: '19.0.0' };
  const matrix = [
    // Windows 10 vs 11 for each Chromium browser: platformVersion 1-10 = 10, 13+ = 11.
    { name: 'Chrome, Windows 11', ua: WIN_CHROME_UA, touch: 0, uaData: ch('chrome', 'Windows', false, WIN11), expect: { browser: 'Chrome 141.0.7390.108', os: 'Windows 11', sentence: 'You are using Chrome 141 on Windows 11.' } },
    { name: 'Chrome, Windows 10 1809 (platformVersion 7)', ua: WIN_CHROME_UA, touch: 0, uaData: ch('chrome', 'Windows', false, { platformVersion: '7.0.0' }), expect: { os: 'Windows 10' } },
    { name: 'Chrome, Windows 11 21H2 (platformVersion 13)', ua: WIN_CHROME_UA, touch: 0, uaData: ch('chrome', 'Windows', false, { platformVersion: '13.0.0' }), expect: { os: 'Windows 11' } },
    { name: 'Edge, Windows 10', ua: WIN_CHROME_UA + ' Edg/141.0.0.0', touch: 0, uaData: ch('edge', 'Windows', false, WIN10),
      expect: { browser: 'Edge 141.0.3537.71', engine: 'Blink 141.0.7390.108', os: 'Windows 10', sentence: 'You are using Edge 141 on Windows 10.' }, uaNotes: /"Edg\/141\.0\.0\.0" is reduced in the same way/ },
    { name: 'Edge, Windows 11 on ARM', ua: WIN_CHROME_UA + ' Edg/141.0.0.0', touch: 10, uaData: ch('edge', 'Windows', false, Object.assign({ architecture: 'arm' }, WIN11)),
      expect: { browser: 'Edge 141.0.3537.71', os: 'Windows 11', device: 'Desktop' }, uaNotes: /"Win64; x64" is fixed in Chromium browsers, so Windows PCs with ARM processors send it too/ },
    { name: 'Opera, Windows 10', ua: OPERA_UA, touch: 0, uaData: ch('opera', 'Windows', false, WIN10), expect: { browser: 'Opera 123.0.5669.23', engine: 'Blink 139.0.7258.155', os: 'Windows 10' } },
    { name: 'Opera, Windows 11', ua: OPERA_UA, touch: 0, uaData: ch('opera', 'Windows', false, WIN11), expect: { os: 'Windows 11' } },
    { name: 'Opera GX', ua: OPERA_UA, touch: 0, uaData: hints([{ brand: 'Opera GX', version: '123' }, { brand: 'Chromium', version: '139' }], [{ brand: 'Opera GX', version: '123.0.5669.23' }, { brand: 'Chromium', version: '139.0.7258.155' }], 'Windows', false, WIN11),
      expect: { browser: 'Opera GX 123.0.5669.23' } },
    { name: 'Brave, Windows 10', ua: WIN_CHROME_UA, touch: 0, brave: true, uaData: ch('brave', 'Windows', false, WIN10), expect: { browser: 'Brave (Chromium 141)', engine: 'Blink 141', os: 'Windows 10' } },
    { name: 'Vivaldi, Windows 10', ua: WIN_CHROME_UA.replace('141.0.0.0', '140.0.0.0'), touch: 0, uaData: ch('vivaldi', 'Windows', false, WIN10),
      expect: { browser: 'Chromium 140.0.7339.214', os: 'Windows 10' }, notes: /only Chromium brands, as .*Vivaldi/ },
    { name: 'Vivaldi, Windows 11', ua: WIN_CHROME_UA.replace('141.0.0.0', '140.0.0.0'), touch: 0, uaData: ch('vivaldi', 'Windows', false, WIN11), expect: { os: 'Windows 11' } },
    { name: 'Chrome without Client Hints, Windows', ua: WIN_CHROME_UA, touch: 0, uaData: 'none', expect: { browser: 'Chrome 141', os: 'Windows 10 or 11' } },
    // Regressions: the brand order decided the name ("Yowser 2.5"), and WebView2 showed as Edge.
    { name: 'Yandex Browser (Yowser listed first)', ua: WIN_CHROME_UA.replace('141.0.0.0', '138.0.0.0') + ' YaBrowser/25.8.0.0 Safari/537.36', touch: 0,
      uaData: hints([{ brand: 'Yowser', version: '2.5' }, { brand: 'YaBrowser', version: '25.8' }, { brand: 'Chromium', version: '138' }],
        [{ brand: 'Yowser', version: '2.5' }, { brand: 'YaBrowser', version: '25.8.1.800' }, { brand: 'Chromium', version: '138.0.7204.1012' }], 'Windows', false, WIN11),
      expect: { browser: 'Yandex Browser 25.8.1.800', sentence: 'You are using Yandex Browser 25 on Windows 11.' } },
    { name: 'Edge WebView2', ua: WIN_CHROME_UA + ' Edg/141.0.0.0', touch: 0,
      uaData: hints([{ brand: 'Microsoft Edge', version: '141' }, { brand: 'Microsoft Edge WebView2', version: '141' }, { brand: 'Chromium', version: '141' }],
        [{ brand: 'Microsoft Edge', version: '141.0.3537.71' }, { brand: 'Microsoft Edge WebView2', version: '141.0.3537.71' }, { brand: 'Chromium', version: '141.0.7390.108' }], 'Windows', false, WIN11),
      expect: { browser: 'Edge WebView2 141.0.3537.71' } },
    { name: 'Old GREASE brand ";Not A Brand"', ua: WIN_CHROME_UA, touch: 0,
      uaData: { brands: [{ brand: ';Not A Brand', version: '99' }, { brand: 'Google Chrome', version: '141' }, { brand: 'Chromium', version: '141' }], platform: 'Windows', mobile: false,
        high: { fullVersionList: [{ brand: ';Not A Brand', version: '99.0.0.0' }].concat(B.chrome[1]), platformVersion: '15.0.0' } },
      expect: { browser: 'Chrome 141.0.7390.108', os: 'Windows 11' } },

    // macOS: the user agent is frozen at 10_15_7, so only Client Hints know the version.
    { name: 'Chrome, macOS 15', ua: MAC_CHROME_UA, touch: 0, uaData: ch('chrome', 'macOS', false, { platformVersion: '15.6.1', architecture: 'arm' }),
      expect: { os: 'macOS 15.6.1 (Sequoia)', sentence: 'You are using Chrome 141 on macOS 15.6.1.' } },
    { name: 'Edge, macOS 14', ua: MAC_CHROME_UA + ' Edg/141.0.0.0', touch: 0, uaData: ch('edge', 'macOS', false, { platformVersion: '14.7.0' }), expect: { browser: 'Edge 141.0.3537.71', os: 'macOS 14.7 (Sonoma)' } },
    { name: 'Brave, macOS 26', ua: MAC_CHROME_UA, touch: 0, brave: true, uaData: ch('brave', 'macOS', false, { platformVersion: '26.0.0', architecture: 'arm' }), expect: { browser: 'Brave (Chromium 141)', os: 'macOS 26 (Tahoe)' } },
    { name: 'Vivaldi, macOS', ua: MAC_CHROME_UA.replace('141.0.0.0', '140.0.0.0'), touch: 0, uaData: ch('vivaldi', 'macOS', false, { platformVersion: '15.0.0' }), expect: { browser: 'Chromium 140.0.7339.214', os: 'macOS 15 (Sequoia)' } },
    { name: 'Chrome, macOS, detailed hints refused', ua: MAC_CHROME_UA, touch: 0, uaData: Object.assign(ch('chrome', 'macOS', false, {}), { reject: true }),
      expect: { browser: 'Chrome 141', os: 'macOS (version hidden)' }, notes: /reports every recent Mac as macOS 10\.15/ },
    // Regressions: compatibility version numbers were shown as "macOS 16" and "macOS 10.16".
    { name: 'macOS 26 seen as 16.0 by an older build', ua: MAC_CHROME_UA, touch: 0, uaData: ch('chrome', 'macOS', false, { platformVersion: '16.0.0' }), expect: { os: 'macOS 26 (Tahoe)' } },
    { name: 'macOS 11 seen as 10.16', ua: MAC_CHROME_UA, touch: 0, uaData: ch('chrome', 'macOS', false, { platformVersion: '10.16.0' }), expect: { os: 'macOS 11 (Big Sur)' } },
    // Regression: a Mac with a touch point was taken for an iPad.
    { name: 'Chrome on a Mac with touch points', ua: MAC_CHROME_UA, touch: 5, uaData: ch('chrome', 'macOS', false, { platformVersion: '15.6.1' }),
      expect: { os: 'macOS 15.6.1 (Sequoia)', device: 'Desktop' }, noNotes: /iPad/ },
    { name: 'Chrome on a Mac with touch points, no Client Hints', ua: MAC_CHROME_UA, touch: 5, uaData: 'none', expect: { os: 'macOS (version hidden)', device: 'Desktop' } },
    { name: 'Firefox, macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0', uaData: 'none', touch: 0,
      expect: { browser: 'Firefox 144.0', engine: 'Gecko 144.0', os: 'macOS (version hidden)' } },
    { name: 'Safari, older macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15', uaData: 'none', touch: 0,
      expect: { browser: 'Safari 14.1.2', engine: 'WebKit (Safari 14.1)', os: 'macOS 10.14.6 (Mojave)' } },

    // Linux and ChromeOS
    { name: 'Chrome, Linux', ua: LINUX_CHROME_UA, touch: 0, uaData: ch('chrome', 'Linux', false, { platformVersion: '6.8.0' }), expect: { browser: 'Chrome 141.0.7390.108', os: 'Linux', device: 'Desktop' },
      uaNotes: /"X11; Linux x86_64" is fixed in Chromium browsers/ },
    { name: 'Firefox, Ubuntu', ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', uaData: 'none', touch: 0, expect: { browser: 'Firefox 144.0', os: 'Ubuntu Linux' } },
    // Regression: the platform build number was shown as the ChromeOS version.
    { name: 'Chrome, ChromeOS', ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', touch: 0,
      uaData: ch('chrome', 'Chrome OS', false, { platformVersion: '16404.45.0' }),
      expect: { os: 'ChromeOS (platform 16404.45.0)', sentence: 'You are using Chrome 141 on ChromeOS.' }, notes: /platform build number, not the version/, uaNotes: /"CrOS x86_64 14541\.0\.0" is frozen/ },

    // Android phone and tablet
    { name: 'Chrome, Android phone', ua: ANDROID_UA, touch: 5, uaData: ch('chrome', 'Android', true, { platformVersion: '16.0.0', model: 'Pixel 9 Pro', architecture: '', bitness: '' }),
      expect: { os: 'Android 16', device: 'Mobile (Pixel 9 Pro)' } },
    { name: 'Chrome, Android tablet', ua: ANDROID_TABLET_UA, touch: 5, uaData: ch('chrome', 'Android', false, { platformVersion: '14.0.0', model: 'SM-X710', architecture: '', bitness: '', formFactors: ['Tablet'] }),
      expect: { os: 'Android 14', device: 'Tablet (SM-X710)' } },
    { name: 'Chrome, Android tablet, no form factors', ua: ANDROID_TABLET_UA, touch: 5, uaData: ch('chrome', 'Android', false, { platformVersion: '14.0.0', model: 'SM-X710', architecture: '', bitness: '', formFactors: undefined }),
      expect: { device: 'Tablet (SM-X710)' } },
    { name: 'Chrome, Android tablet, no Client Hints', ua: ANDROID_TABLET_UA, touch: 5, uaData: 'none', expect: { os: 'Android (version hidden)', device: 'Tablet' } },
    { name: 'Samsung Internet, tablet', ua: SAMSUNG_UA.replace(' Mobile', ''), touch: 5, uaData: ch('samsung', 'Android', false, { platformVersion: '14.0.0', model: 'SM-X910', architecture: '', bitness: '', formFactors: ['Tablet'] }),
      expect: { browser: 'Samsung Internet 28.0', device: 'Tablet (SM-X910)' } },
    { name: 'Samsung Internet, older user agent with model', ua: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36', touch: 5, uaData: 'none',
      expect: { browser: 'Samsung Internet 23.0', os: 'Android 13', device: 'Mobile (SM-S918B)' } },
    { name: 'Edge, Android', ua: ANDROID_UA + ' EdgA/141.0.0.0', touch: 5, uaData: ch('edge', 'Android', true, { platformVersion: '14.0.0', model: 'Pixel 8', architecture: '', bitness: '' }), expect: { browser: 'Edge 141.0.3537.71', os: 'Android 14' } },
    { name: 'Firefox, Android tablet', ua: 'Mozilla/5.0 (Android 15; Tablet; rv:144.0) Gecko/144.0 Firefox/144.0', touch: 5, uaData: 'none', expect: { browser: 'Firefox 144.0', os: 'Android 15', device: 'Tablet' } },
    // Firefox for Android 122+ reports versions older than 10 as "Android 10" (Mozilla bugs 1865766, 1894429).
    { name: 'Firefox, Android 10 or older', ua: 'Mozilla/5.0 (Android 10; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0', touch: 5, uaData: 'none',
      expect: { os: 'Android 10 or earlier', sentence: 'You are using Firefox 144 on Android 10 or earlier.' }, notes: /older than 10 as Android 10/ },
    { name: 'Firefox 115, Android 10', ua: 'Mozilla/5.0 (Android 10; Mobile; rv:115.0) Gecko/115.0 Firefox/115.0', touch: 5, uaData: 'none', expect: { os: 'Android 10' }, noNotes: /older than 10/ },
    // Device memory: Chrome 147 changed the range from 0.25-8 GB to 2-32 GB (2-8 GB on Android), so
    // 8 GB is no longer the top of the range on a computer (chromestatus 6330376953921536).
    { name: 'Chrome 147, Windows, 8 GB', ua: WIN_CHROME_UA.replace('141.0.0.0', '147.0.0.0'), touch: 0, mem: 8,
      uaData: hints([{ brand: 'Google Chrome', version: '147' }, { brand: 'Chromium', version: '147' }], [{ brand: 'Google Chrome', version: '147.0.7700.50' }, { brand: 'Chromium', version: '147.0.7700.50' }], 'Windows', false, WIN11),
      expect: { browser: 'Chrome 147.0.7700.50' }, rows: { 'bt-hw-rows:memory': 'About 8 GB' } },
    { name: 'Chrome 147, Windows, 32 GB', ua: WIN_CHROME_UA.replace('141.0.0.0', '147.0.0.0'), touch: 0, mem: 32,
      uaData: hints([{ brand: 'Google Chrome', version: '147' }, { brand: 'Chromium', version: '147' }], [{ brand: 'Google Chrome', version: '147.0.7700.50' }, { brand: 'Chromium', version: '147.0.7700.50' }], 'Windows', false, WIN11),
      expect: {}, rows: { 'bt-hw-rows:memory': 'About 32 GB or more' } },
    { name: 'Chrome 147, Windows, 2 GB', ua: WIN_CHROME_UA.replace('141.0.0.0', '147.0.0.0'), touch: 0, mem: 2,
      uaData: hints([{ brand: 'Google Chrome', version: '147' }, { brand: 'Chromium', version: '147' }], [{ brand: 'Google Chrome', version: '147.0.7700.50' }, { brand: 'Chromium', version: '147.0.7700.50' }], 'Windows', false, WIN11),
      expect: {}, rows: { 'bt-hw-rows:memory': 'About 2 GB or less' } },
    { name: 'Chrome 147, Android, 8 GB', ua: ANDROID_UA.replace('141.0.0.0', '147.0.0.0'), touch: 5, mem: 8,
      uaData: hints([{ brand: 'Google Chrome', version: '147' }, { brand: 'Chromium', version: '147' }], [{ brand: 'Google Chrome', version: '147.0.7700.50' }, { brand: 'Chromium', version: '147.0.7700.50' }], 'Android', true, { platformVersion: '16.0.0', model: 'Pixel 9', architecture: '', bitness: '' }),
      expect: { os: 'Android 16' }, rows: { 'bt-hw-rows:memory': 'About 8 GB or more' } },
    { name: 'Chrome 141, 8 GB (old range)', ua: WIN_CHROME_UA, touch: 0, mem: 8, uaData: ch('chrome', 'Windows', false, WIN11), expect: {}, rows: { 'bt-hw-rows:memory': 'About 8 GB or more' } },
    { name: 'Chrome 141, 256 MB (old range)', ua: WIN_CHROME_UA, touch: 0, mem: 0.25, uaData: ch('chrome', 'Windows', false, WIN11), expect: {}, rows: { 'bt-hw-rows:memory': 'About 256 MB or less' } },
    // Do Not Track: Firefox 135 removed the setting and always reports "unspecified".
    { name: 'Firefox 144, Do Not Track removed', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', touch: 0, uaData: 'none', dnt: 'unspecified',
      expect: {}, rows: { 'bt-pv-rows:dnt': 'Not available: Firefox 135 and later no longer send it' } },
    { name: 'Firefox 128, Do Not Track off', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0', touch: 0, uaData: 'none', dnt: 'unspecified',
      expect: {}, rows: { 'bt-pv-rows:dnt': 'Off' } },
    { name: 'Android WebView', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36', touch: 5, uaData: 'none',
      expect: { browser: 'Android WebView 127.0.6533.103', device: 'Mobile (Pixel 8)' } },
    // Regression: Android TV became "Tablet" once Client Hints said mobile: false.
    { name: 'Android TV with Client Hints', ua: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2 Build/STT1.211025.001.Z4; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Safari/537.36', touch: 0,
      uaData: hints([{ brand: 'Android WebView', version: '120' }, { brand: 'Chromium', version: '120' }], [{ brand: 'Android WebView', version: '120.0.6099.230' }, { brand: 'Chromium', version: '120.0.6099.230' }], 'Android', false,
        { platformVersion: '12.0.0', model: 'BRAVIA 4K VH2', architecture: '', bitness: '', formFactors: undefined }),
      expect: { device: 'TV (BRAVIA 4K VH2)', os: 'Android 12' } },
    { name: 'Amazon Silk, Fire tablet', ua: 'Mozilla/5.0 (Linux; Android 11; KFRAWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/128.3.5 like Chrome/128.0.6613.187 Safari/537.36', touch: 5, uaData: 'none',
      expect: { browser: 'Amazon Silk 128.3.5', engine: 'Blink 128.0.6613.187', device: 'Tablet (KFRAWI)' } },

    // iPhone and iPad: every browser is WebKit, and the version shown is the one that ships with iOS.
    // Regression: Safari 18.6 on iOS 18.6 was shown as "iOS 18.6 or later".
    { name: 'Safari, iOS 18.6', ua: IPHONE('18_6') + ' Version/18.6 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { browser: 'Safari 18.6', engine: 'WebKit (iOS 18.6)', os: 'iOS 18.6', sentence: 'You are using Safari 18.6 on iOS 18.6.' }, noNotes: /or any later version/ },
    { name: 'Safari 26.1, iPhone', ua: IPHONE('18_6') + ' Version/26.1 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none', expect: { os: 'iOS 26.1' }, notes: /version shown comes from Safari/ },
    { name: 'Safari, iPad user agent', ua: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { os: 'iPadOS 17.5', device: 'Tablet (iPad)' } },
    { name: 'Safari 26, iPad in desktop mode', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', touch: 5, uaData: 'none',
      expect: { browser: 'Safari 26.0', engine: 'WebKit (iPadOS 26)', os: 'iPadOS 26', device: 'Tablet (iPad)' } },
    { name: 'Chrome, iPad (iOS 26)', ua: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { browser: 'Chrome 141.0.7390.96', os: 'iPadOS 18.6 or later', device: 'Tablet (iPad)' }, notes: /use Apple's WebKit engine/ },
    { name: 'Firefox, iPhone', ua: IPHONE('17_5') + ' FxiOS/144.0 Mobile/15E148 Safari/605.1.15', touch: 5, uaData: 'none', expect: { browser: 'Firefox 144.0', engine: 'WebKit (iOS 17.5)', os: 'iOS 17.5' } },
    { name: 'Edge, iPhone', ua: IPHONE('17_5') + ' Version/17.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15', touch: 5, uaData: 'none', expect: { browser: 'Edge 141.0.3537.71', os: 'iOS 17.5' } },
    { name: 'DuckDuckGo, iPhone', ua: IPHONE('17_5') + ' Version/17.5 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15', touch: 5, uaData: 'none', expect: { browser: 'DuckDuckGo', os: 'iOS 17.5' } },
    // Regression: only "18_6" was treated as frozen, but Apple moved the frozen value to 18_6_2 and
    // then 18_7 (WebKit bug 298260), so Safari 26.2 showed as "iOS 18.7". Real iOS 18.6.2 and 18.7
    // also exist (older iPhones), so only Safari 26+ proves a freeze.
    { name: 'Safari 26.2, iPhone (OS frozen at 18_7)', ua: IPHONE('18_7') + ' Version/26.2 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { browser: 'Safari 26.2', engine: 'WebKit (iOS 26.2)', os: 'iOS 26.2', sentence: 'You are using Safari 26.2 on iOS 26.2.' },
      notes: /frozen iOS version \(18\.6 or 18\.7\).*comes from Safari/, uaNotes: /"OS 18_7" is frozen: Safari 26 and later/ },
    { name: 'Safari 26.1, iPhone (OS frozen at 18_6_2)', ua: IPHONE('18_6_2') + ' Version/26.1 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none', expect: { os: 'iOS 26.1' } },
    { name: 'Safari 26.2, iPad (OS frozen at 18_7)', ua: 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { os: 'iPadOS 26.2', device: 'Tablet (iPad)' } },
    { name: 'Safari 18.7 on a real iOS 18.7', ua: IPHONE('18_7') + ' Version/18.7 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { os: 'iOS 18.7', engine: 'WebKit (iOS 18.7)', sentence: 'You are using Safari 18.7 on iOS 18.7.' }, noNotes: /frozen/, noUaNotes: /"OS 18_7"/ },
    { name: 'Safari on a real iOS 18.6.2', ua: IPHONE('18_6_2') + ' Version/18.6 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none', expect: { os: 'iOS 18.6.2' }, noNotes: /frozen/ },
    { name: 'Google app, iOS 18_7', ua: IPHONE('18_7') + ' GSA/400.0.800000000 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { os: 'iOS 18.7 or later' }, notes: /could be iOS 18\.7 or any later version/, uaNotes: /"OS 18_7" may be frozen/ },
    { name: 'Facebook, iOS 26.2 (FBSV, OS frozen at 18_7)', ua: IPHONE('18_7') + ' Mobile/15E148 [FBAN/FBIOS;FBAV/540.0.0.30.90;FBBV/1;FBDV/iPhone17,1;FBMD/iPhone;FBSN/iOS;FBSV/26.2;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]', touch: 5, uaData: 'none',
      expect: { os: 'iOS 26.2' }, notes: /this app adds the real iOS version/ },
    // Chrome on iOS is not frozen and sends the full version ("26_0_0"); it was shown as "iOS 26.0.0".
    { name: 'Chrome, iPhone, iOS 26', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { browser: 'Chrome 140.0.7339.122', engine: 'WebKit (iOS 26)', os: 'iOS 26', sentence: 'You are using Chrome 140 on iOS 26.' }, noNotes: /frozen/ },

    // In-app browsers. Regressions: TikTok ("musical_ly_35.1.0") and the Google app were not
    // recognised, Messenger showed as Facebook, and the real iOS version these apps add was ignored.
    { name: 'TikTok, iPhone', ua: IPHONE('17_5') + ' Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US', touch: 5, uaData: 'none',
      expect: { browser: 'TikTok in-app browser (app 35.1.0)', sentence: 'You are using TikTok\'s in-app browser on iOS 17.5.' } },
    { name: 'Messenger, iPhone', ua: IPHONE('17_5') + ' Mobile/15E148 [FBAN/MessengerForiOS;FBAV/470.0.0.40.98;FBBV/1;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]', touch: 5, uaData: 'none',
      expect: { browser: 'Messenger in-app browser (app 470.0.0.40.98)' } },
    { name: 'Google app, iPhone', ua: IPHONE('17_5') + ' GSA/330.0.663880069 Mobile/15E148 Safari/604.1', touch: 5, uaData: 'none',
      expect: { browser: 'Google app in-app browser (app 330.0.663880069)', os: 'iOS 17.5' } },
    { name: 'Facebook, iOS 26 (FBSV)', ua: IPHONE('18_6') + ' Mobile/15E148 [FBAN/FBIOS;FBAV/530.0.0.40.98;FBBV/123;FBDV/iPhone17,1;FBMD/iPhone;FBSN/iOS;FBSV/26.0.1;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]', touch: 5, uaData: 'none',
      expect: { os: 'iOS 26.0.1', engine: 'WebKit (iOS 26.0.1)' }, notes: /this app adds the real iOS version/ },
    { name: 'Instagram, iOS 26', ua: IPHONE('18_6') + ' Mobile/15E148 Instagram 400.0.0.20.85 (iPhone17,1; iOS 26_0; en_US; en; scale=3.00; 1206x2622; 812345678)', touch: 5, uaData: 'none',
      expect: { browser: 'Instagram in-app browser (app 400.0.0.20.85)', os: 'iOS 26' } },
    { name: 'Facebook, Android with Client Hints', ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/485.0.0.70.77;]', touch: 5,
      uaData: hints([{ brand: 'Android WebView', version: '129' }, { brand: 'Chromium', version: '129' }], [{ brand: 'Android WebView', version: '129.0.6668.81' }, { brand: 'Chromium', version: '129.0.6668.81' }], 'Android', true,
        { platformVersion: '14.0.0', model: 'SM-S911B', architecture: '', bitness: '' }),
      expect: { browser: 'Facebook in-app browser (app 485.0.0.70.77)', engine: 'Blink 129.0.6668.81', os: 'Android 14', device: 'Mobile (SM-S911B)' } },

    // Spoofed user agents. Regression: an iPhone user agent on desktop Chromium showed "Desktop (iPhone)" with no warning.
    { name: 'iPhone user agent on desktop Chrome', ua: IPHONE('17_5') + ' Version/17.5 Mobile/15E148 Safari/604.1', touch: 0, uaData: ch('chrome', 'Windows', false, WIN11),
      expect: { browser: 'Chrome 141.0.7390.108', engine: 'Blink 141.0.7390.108', os: 'Windows 11', device: 'Desktop' },
      notes: /The user agent claims Safari on an iPhone, but this browser supports Client Hints/, noNotes: /WebKit engine|iOS 18\.6/ },
    { name: 'Windows user agent, macOS Client Hints', ua: WIN_CHROME_UA, touch: 0, uaData: ch('chrome', 'macOS', false, { platformVersion: '15.6.0' }),
      expect: { os: 'macOS 15.6 (Sequoia)' }, notes: /The user agent says Windows, but Client Hints say macOS/ },
    { name: 'Empty Client Hints (user agent override)', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', touch: 0,
      uaData: { brands: [], platform: '', mobile: false, high: { fullVersionList: [], platformVersion: '' } }, expect: { browser: 'Firefox 144.0', os: 'Windows 10 or 11' }, notes: /Client Hints, but they are empty/ },

    // Retired, unusual and unknown. Regressions: legacy Edge showed a Blink engine, IE was unknown,
    // Windows Phone was Android, and a Tizen TV said "WebKit" while its user agent note said Blink.
    { name: 'Legacy Edge', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582', touch: 0, uaData: 'none',
      expect: { browser: 'Edge Legacy', engine: 'EdgeHTML 18.19582' }, uaNotes: /the engine is EdgeHTML\./, noUaNotes: /the engine is Blink/ },
    { name: 'Internet Explorer 11', ua: 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko', touch: 0, uaData: 'none',
      expect: { browser: 'Internet Explorer 11.0', engine: 'Trident 7.0', sentence: 'You are using Internet Explorer 11 on Windows 10 or 11.' } },
    { name: 'Windows Phone', ua: 'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15063', touch: 5, uaData: 'none',
      expect: { os: 'Windows Phone 10.0', engine: 'EdgeHTML 15.15063', device: 'Mobile' } },
    { name: 'Samsung TV (Tizen)', ua: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36', touch: 0, uaData: 'none',
      expect: { engine: 'Blink', os: 'Tizen 6.0', device: 'TV' } },
    { name: 'Xbox', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edge/20.02', touch: 0, uaData: 'none',
      expect: { browser: 'Edge', engine: 'Blink 120', os: 'Xbox', device: 'Game console' } },
    { name: 'Huawei Browser, HarmonyOS', ua: 'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.4.300', touch: 5, uaData: 'none',
      expect: { browser: 'Huawei Browser 5.0.4.300', os: 'HarmonyOS 5.0', device: 'Mobile' } },
    { name: 'Unknown user agent', ua: 'SomeBrowser/1.0 (+https://example.com)', touch: 0, uaData: 'none',
      expect: { browser: 'Not recognised', engine: 'Not recognised', os: 'Not recognised', device: 'Not recognised',
        sentence: 'You are using a browser this page does not recognise on an operating system this page does not recognise.' }, notes: /could not be recognised/ },
    { name: 'Empty user agent', ua: '', touch: 0, uaData: 'none', expect: { browser: 'Not recognised', os: 'Not recognised' } },
    // Regression: malformed Client Hints left the whole summary on "Checking…".
    { name: 'Malformed Client Hints', ua: WIN_CHROME_UA, touch: 0, uaData: { brands: 'oops', platform: 'Windows', mobile: false, high: { platformVersion: '15.0.0', fullVersionList: 'x' } },
      expect: { browser: 'Chrome 141', os: 'Windows 11' } }
  ];
  for (const cfg of matrix) await quick(cfg);

  // Real device emulation (no stubs): Chromium's own userAgentData next to a phone's user agent.
  const emulate = async (name, device, expect, check) => {
    const c = await ctx.browser().newContext(device);
    const p = await c.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.route('**/*', r => (r.request().url().startsWith(base) || r.request().url().startsWith('data:') ? r.continue() : (errors.push('external ' + r.request().url()), r.abort())));
    await p.goto(url);
    await done(p);
    const real = await p.evaluate(() => ({ brands: navigator.userAgentData.brands.map(b => b.brand), mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }));
    for (const [k, v] of Object.entries(expect)) assert.equal(await p.locator('#bt-' + k).textContent(), v, `${name}: ${k}`);
    if (check) await check(p, real);
    await c.close();
    assert.deepEqual(errors, [], name);
  };
  // Regression: a phone emulated on a computer showed "Desktop (Pixel 7)".
  await emulate('Pixel 7 emulation', devices['Pixel 7'], { os: 'Android 14', device: 'Mobile (Pixel 7)', engine: 'Blink ' + chromium.version }, async (p, real) => {
    assert.equal(real.mobile, true);
    assert.equal(real.platform, 'Android');
  });
  await emulate('iPhone 15 emulation', devices['iPhone 15'], { engine: 'Blink ' + chromium.version, browser: 'Headless Chrome ' + headless.version }, async (p, real) => {
    assert.ok(real.brands.includes('Chromium'), 'Chromium still exposes its brands');
    const n = await notes(p);
    assert.match(n, /The user agent claims Safari on an iPhone, but this browser supports Client Hints/);
    assert.doesNotMatch(n, /use Apple's WebKit engine/, 'no WebKit note next to a Blink engine');
  });

  // Every probe fails: APIs throw, images never load. Each table still fills in, and the
  // cells whose API failed say so instead of guessing.
  await scenario({
    name: 'Hostile environment', within: 15000, expect: { browser: 'Headless Chrome ' + headless.version, os: 'Linux' },
    extra: `
      const boom = () => { throw new Error('hostile'); };
      CSS.supports = boom;
      WebAssembly.validate = boom;
      HTMLCanvasElement.prototype.getContext = () => null; // canvas blocked, as some privacy settings do
      OffscreenCanvas.prototype.getContext = boom;
      crypto.subtle.digest = () => Promise.reject(new Error('hostile'));
      window.OfflineAudioContext = function () { throw new Error('hostile'); };
      window.matchMedia = boom;
      Intl.DateTimeFormat = boom;
      MediaSource.isTypeSupported = boom;
      HTMLMediaElement.prototype.canPlayType = boom;
      for (const k of ['storage', 'connection', 'languages', 'hardwareConcurrency', 'deviceMemory', 'cookieEnabled', 'maxTouchPoints', 'mediaCapabilities']) {
        Object.defineProperty(Navigator.prototype, k, { configurable: true, get: boom });
      }
      Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: boom }) });
      Object.defineProperty(Window.prototype, 'localStorage', { configurable: true, get: boom });
      Object.defineProperty(Screen.prototype, 'width', { configurable: true, get: boom });
      Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, set() {} });
    `
  }, async p => {
    const unread = 'Could not be read in this browser';
    for (const key of ['cores', 'memory', 'touch', 'screen', 'network', 'pointer', 'gamut', 'hdr']) assert.equal(await cell(p, 'bt-hw-rows', key), unread, `hardware ${key}`);
    for (const key of ['cookies', 'languages', 'scheme', 'motion', 'contrast']) assert.equal(await cell(p, 'bt-pv-rows', key), unread, `privacy ${key}`);
    assert.equal(await cell(p, 'bt-pv-rows', 'storage'), 'Not reported by this browser');
    assert.equal(await cell(p, 'bt-pv-rows', 'javascript'), 'On');
    assert.equal(await p.locator('#bt-fonts-sum').textContent(), 'The fonts could not be checked in this browser.');
    assert.equal(await p.locator('#bt-fp-webgl-hash').textContent(), 'No WebGL');
    assert.match(await p.locator('#bt-score').textContent(), /^\d+ of \d+ supported$/);
    for (const id of ['webgl', 'canvas', 'avif', 'wasm', 'has']) assert.equal(await p.getAttribute(`.bt-feat[data-feature="${id}"]`, 'data-supported'), 'no', id);
    assert.equal(await p.locator('#bt-ch-rows tr').count(), 10);
    // The report still works.
    await p.click('#bt-copy');
    await p.waitForFunction(() => document.getElementById('bt-copy').textContent === 'Copied!');
    assert.match(await p.evaluate(() => navigator.clipboard.readText()), /\nHARDWARE AND DISPLAY\n {2}CPU cores: Could not be read in this browser\n/);
  });
  // Promises that never settle: every wait is bounded and they overlap, so the page finishes.
  await scenario({
    name: 'Never-settling promises', within: 16000, expect: { browser: 'Chrome 141', os: 'Linux' },
    extra: `
      Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: () => new Promise(() => {}) }) });
      Object.defineProperty(Navigator.prototype, 'storage', { configurable: true, get: () => ({ estimate: () => new Promise(() => {}) }) });
      Object.defineProperty(Navigator.prototype, 'brave', { configurable: true, get: () => ({ isBrave: () => new Promise(() => {}) }) });
      crypto.subtle.digest = () => new Promise(() => {});
      PublicKeyCredential.isConditionalMediationAvailable = () => new Promise(() => {});
      OfflineAudioContext.prototype.startRendering = () => new Promise(() => {});
    `,
    uaData: Object.assign(hints(B.chrome[0], B.chrome[1], 'Linux', false, {}), { hang: true })
  }, async p => {
    assert.equal(await p.getAttribute('.bt-feat[data-feature="webgpu"]', 'data-supported'), 'no');
    assert.equal(await p.locator('.bt-feat[data-feature="webgpu"] .bt-fdetail').textContent(), 'The browser did not answer the request for a GPU adapter in time.');
    assert.equal(await p.locator('.bt-feat[data-feature="passkey-autofill"] .bt-fdetail').textContent(), 'The check did not finish in time.');
    // WebGL works here; only its hash is missing, so the page must not say "No WebGL".
    assert.equal(await p.locator('#bt-fp-webgl-hash').textContent(), 'Not available');
    assert.match(await p.locator('#bt-fonts-sum').textContent(), /^\d+ of the 34 common fonts/);
    assert.equal(await cell(p, 'bt-pv-rows', 'storage'), 'Not reported by this browser');
    assert.match(await p.locator('#bt-ch-none').textContent(), /did not answer the request for the detailed hints/);
  });
  // Device memory is rounded to the nearest power of two; slower connections are not capped.
  await scenario({ name: 'Small device, slow network', ua: raw.ua, mem: 0.5, conn: { effectiveType: '3g', downlink: 1.45, rtt: 300, saveData: true }, expect: {} }, async p => {
    assert.equal(await cell(p, 'bt-hw-rows', 'memory'), 'About 512 MB');
    assert.equal(await cell(p, 'bt-hw-rows', 'network'), '3G-class connection, about 1.45 Mb/s, about 300 ms round trip, Data Saver on');
  });

  // Dark mode and reduced motion are read from the user's settings.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await open();
  await done(page);
  assert.equal(await cell(page, 'bt-pv-rows', 'scheme'), 'Dark');
  assert.equal(await cell(page, 'bt-pv-rows', 'motion'), 'On (reduce animations)');
  assert.equal(await page.$eval('#bt-bar', e => getComputedStyle(e).transitionDuration), '0s', 'the score bar does not animate with reduced motion');
  assert.match(await page.$eval('.bt-sec', e => getComputedStyle(e).backgroundColor), /^rgb\((23, 26, 29)\)$/);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  // Time zone, offset, languages and number format follow the device settings:
  // India is UTC+05:30 all year, and German writes 1.234.567,89.
  const india = await ctx.browser().newContext({ timezoneId: 'Asia/Kolkata', locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const r = await india.newPage();
  const indiaErrors = [];
  r.on('pageerror', e => indiaErrors.push(e.message));
  r.on('console', m => { if (m.type() === 'error') indiaErrors.push(m.text()); });
  await r.route('**/*', rt => (rt.request().url().startsWith(base) || rt.request().url().startsWith('data:') ? rt.continue() : (indiaErrors.push('external ' + rt.request().url()), rt.abort())));
  await r.goto(url);
  await done(r);
  // ICU may report the zone by its older name, Asia/Calcutta.
  assert.match(await cell(r, 'bt-pv-rows', 'timezone'), /^Asia\/(Kolkata|Calcutta) \(UTC\+05:30\)$/);
  assert.equal(await cell(r, 'bt-pv-rows', 'languages'), 'de-DE');
  assert.match(await cell(r, 'bt-pv-rows', 'locale'), /^de-DE \(1\.234\.567,89 and \d{1,2}\.\d{1,2}\.\d{4}\)$/);
  // Another browser profile on the same device: the drawing, WebGL, audio and font
  // hashes are the same, and the combined one changes with the time zone and language.
  const india8 = await fpHashes(r);
  for (const k of ['canvas-hash', 'webgl-hash', 'audio-hash', 'fonts-hash']) assert.equal(india8[k], firstLoad[k], `${k} in a new profile`);
  assert.notEqual(india8.combined, firstLoad.combined, 'the combined hash includes time zone and language');
  assert.deepEqual(indiaErrors, []);
  await india.close();

  // With JavaScript off, the page says why it is empty.
  const noJs = await ctx.browser().newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const q = await noJs.newPage();
  await q.goto(url);
  // (Playwright's text selectors skip <noscript>, so the element is checked directly.)
  assert.equal(await q.isVisible('noscript p.msg'), true);
  assert.match(await q.textContent('noscript p.msg'), /^JavaScript is turned off/);
  assert.equal(await q.isVisible('#bt'), false, 'no endless "Checking…" placeholders without JavaScript');
  await noJs.close();
};
