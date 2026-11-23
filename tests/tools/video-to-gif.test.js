const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// The test videos and the expected answers come from tests/fixtures/video-to-gif/make_fixtures.py.
// Every frame of the coded videos shows its own number as 7 black or white blocks, and the script
// works out from ffprobe's frame timestamps which video frame each GIF frame must show, the frame
// times in hundredths of a second and the loop count, never from this page's code. The test reads
// the GIF bytes itself (parseGif below) and reads the blocks back from every decoded frame.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const scen = Object.fromEntries(exp.scenarios.map(s => [s.name, s]));
  const fx = f => path.join(fixtures, f);
  const text = sel => page.textContent(sel);

  // ---------- Helpers ----------
  function parseGif(buf) {
    assert.equal(buf.toString('latin1', 0, 6), 'GIF89a', 'GIF signature');
    const g = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), frames: [], loop: null, trailer: false };
    const packed = buf[10];
    let p = 13;
    g.gctSize = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
    p += 3 * g.gctSize;
    let gce = null;
    const skipBlocks = () => { while (buf[p]) p += buf[p] + 1; p++; };
    while (p < buf.length) {
      const b = buf[p++];
      if (b === 0x3B) { g.trailer = p === buf.length; break; }
      if (b === 0x21) {
        const label = buf[p++];
        if (label === 0xF9) {
          const pk = buf[p + 1];
          gce = { disposal: (pk >> 2) & 7, transparent: !!(pk & 1), delay: buf.readUInt16LE(p + 2), index: buf[p + 4] };
          p += buf[p] + 1;
          skipBlocks();
        } else if (label === 0xFF) {
          const app = buf.toString('latin1', p + 1, p + 1 + buf[p]);
          p += buf[p] + 1;
          if (app === 'NETSCAPE2.0') g.loop = buf.readUInt16LE(p + 2);
          skipBlocks();
        } else skipBlocks();
      } else if (b === 0x2C) {
        const f = { x: buf.readUInt16LE(p), y: buf.readUInt16LE(p + 2), w: buf.readUInt16LE(p + 4), h: buf.readUInt16LE(p + 6), local: !!(buf[p + 8] & 0x80), gce };
        const lpk = buf[p + 8];
        p += 9;
        if (f.local) p += 3 * (1 << ((lpk & 7) + 1));
        p++; // LZW minimum code size
        skipBlocks();
        g.frames.push(f);
        gce = null;
      } else throw new Error(`unexpected GIF block 0x${b.toString(16)} at byte ${p - 1}`);
    }
    return g;
  }
  // Decodes every frame in the browser (ImageDecoder composites them as an <img> would) and
  // returns, for each frame, the mean brightness of an 8 x 8 square around each point.
  async function probe(p, buf, points) {
    return p.evaluate(async ({ b64, points }) => {
      const bin = atob(b64), data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const dec = new ImageDecoder({ data, type: 'image/gif' });
      await dec.tracks.ready;
      const out = [];
      let ctx = null;
      for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        if (!ctx) ctx = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        image.close();
        out.push(points.map(([x, y]) => {
          const d = ctx.getImageData(x - 4, y - 4, 8, 8).data;
          let s = 0;
          for (let k = 0; k < d.length; k += 4) s += d[k] + d[k + 1] + d[k + 2];
          return s / 192;
        }));
      }
      dec.close();
      return out;
    }, { b64: buf.toString('base64'), points });
  }
  // The mean colour [r, g, b] of the 8 x 8 square around a point, in each decoded frame.
  async function colourAt(p, buf, [x, y]) {
    return p.evaluate(async ({ b64, x, y }) => {
      const bin = atob(b64), data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const dec = new ImageDecoder({ data, type: 'image/gif' });
      await dec.tracks.ready;
      const out = [];
      let ctx = null;
      for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        if (!ctx) ctx = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        image.close();
        const d = ctx.getImageData(x - 4, y - 4, 8, 8).data, sum = [0, 0, 0];
        for (let k = 0; k < d.length; k += 4) { sum[0] += d[k]; sum[1] += d[k + 1]; sum[2] += d[k + 2]; }
        out.push(sum.map(v => Math.round(v / 64)));
      }
      dec.close();
      return out;
    }, { b64: buf.toString('base64'), x, y });
  }
  const toCodes = rows => rows.map(r => r.reduce((n, v, i) => n | ((v > 128 ? 1 : 0) << i), 0));
  async function codesOf(p, buf, points) { return toCodes(await probe(p, buf, points)); }
  // Mean difference per colour channel between the frames of two GIFs of the same size.
  async function frameDiff(p, a, b) {
    return p.evaluate(async ({ a64, b64 }) => {
      const load = async s => {
        const bin = atob(s), data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        const dec = new ImageDecoder({ data, type: 'image/gif' });
        await dec.tracks.ready;
        const frames = [];
        let ctx = null;
        for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          if (!ctx) ctx = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          image.close();
          frames.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data);
        }
        return frames;
      };
      const fa = await load(a64), fb = await load(b64);
      return fa.map((x, i) => { let s = 0; for (let k = 0; k < x.length; k++) if ((k & 3) !== 3) s += Math.abs(x[k] - fb[i][k]); return s / (x.length * 0.75); });
    }, { a64: a.toString('base64'), b64: b.toString('base64') });
  }
  // Mean difference per colour channel between each frame of a GIF of fade.webm (frame i shows video
  // frame i) and the picture make_fixtures.py drew for it (fade_clip): column x of frame f is
  // (min(255, v), min(255, floor(v / 2) + 30), 90) with v = 40 + 8 f + floor(x / 2).
  async function fadeError(p, buf) {
    return p.evaluate(async b64 => {
      const bin = atob(b64), data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const dec = new ImageDecoder({ data, type: 'image/gif' });
      await dec.tracks.ready;
      const out = [];
      let ctx = null;
      for (let f = 0; f < dec.tracks.selectedTrack.frameCount; f++) {
        const { image } = await dec.decode({ frameIndex: f });
        if (!ctx) ctx = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        image.close();
        const w = ctx.canvas.width, px = ctx.getImageData(0, 0, w, ctx.canvas.height).data;
        let s = 0;
        for (let k = 0; k < px.length; k += 4) {
          const v = 40 + 8 * f + Math.floor((k / 4 % w) / 2);
          s += Math.abs(px[k] - Math.min(255, v)) + Math.abs(px[k + 1] - Math.min(255, Math.floor(v / 2) + 30)) + Math.abs(px[k + 2] - 90);
        }
        out.push(s / (px.length * 0.75));
      }
      dec.close();
      return out;
    }, buf.toString('base64'));
  }
  async function openVideo(p, file) {
    await p.setInputFiles('#v2g-file', typeof file === 'string' ? fx(file) : file);
    await p.waitForFunction(() => !document.querySelector('#v2g-editor').hidden || document.querySelector('#v2g-file-error').textContent);
  }
  const estimated = (p, timeout) => p.waitForFunction(() => /\d (KB|MB|bytes)/.test(document.querySelector('#v2g-summary').textContent), null, timeout ? { timeout } : {});
  async function setTimes(p, start, end) {
    // End first when the new start lies past the old end, so neither is refused on the way.
    const s = Number(start), cur = await p.evaluate(() => [document.querySelector('#v2g-start').value, document.querySelector('#v2g-end').value]);
    if (s >= Number(cur[1])) { await p.fill('#v2g-end', end); await p.fill('#v2g-start', start); } else { await p.fill('#v2g-start', start); await p.fill('#v2g-end', end); }
    assert.equal(await p.getAttribute('#v2g-start', 'aria-invalid'), null, `start ${start} accepted`);
    assert.equal(await p.getAttribute('#v2g-end', 'aria-invalid'), null, `end ${end} accepted`);
  }
  async function configure(p, sc, extra = {}) {
    await setTimes(p, sc.start, sc.end);
    await p.selectOption('#v2g-fps', String(sc.fps));
    await p.selectOption('#v2g-speed', String(sc.speed));
    await p.selectOption('#v2g-dir', sc.direction);
    await p.selectOption('#v2g-plays', String(sc.plays));
    for (const [sel, v] of Object.entries(extra)) await p.selectOption(sel, v);
  }
  let made = 0, readyText = '', focusAfter = '';
  async function make(p) {
    const before = made;
    await p.click('#v2g-make');
    await p.waitForFunction(() => !document.querySelector('#v2g-make').disabled && document.querySelector('#v2g-cancel').hidden, null, { timeout: 60000 });
    assert.equal(await p.textContent('#v2g-error'), '', 'no error while making the GIF');
    await p.waitForFunction(n => document.querySelector('#v2g-result-info').textContent && !document.querySelector('#v2g-result').hidden, before);
    readyText = await p.textContent('#v2g-status');
    focusAfter = await p.evaluate(() => document.activeElement.id);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#v2g-download')]);
    made++;
    return fs.readFileSync(await dl.path());
  }
  function checkTiming(g, sc, label) {
    assert.equal(g.frames.length, sc.frames, `${label}: frame count`);
    assert.deepEqual(g.frames.map(f => f.gce && f.gce.delay), sc.delays, `${label}: frame times in hundredths`);
    assert.equal(g.loop, sc.loop, `${label}: NETSCAPE2.0 loop count`);
    assert.ok(g.trailer, `${label}: ends with the GIF trailer`);
    for (const f of g.frames) {
      assert.deepEqual([f.x, f.y, f.w, f.h, f.local], [0, 0, g.width, g.height, false], `${label}: full frames on the global palette`);
    }
  }

  // ---------- As served ----------
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await open();
  assert.ok(await page.isVisible('#v2g-choose'));
  assert.ok(await page.isHidden('#v2g-editor'));
  assert.equal(await page.getAttribute('#v2g-file', 'accept'), 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.ogv');

  // ---------- Files that are not usable videos ----------
  const fileError = async (file, re) => {
    await page.setInputFiles('#v2g-file', file);
    await page.waitForFunction(() => document.querySelector('#v2g-file-error').textContent);
    assert.match(await text('#v2g-file-error'), re);
    assert.match(await page.getAttribute('#v2g-choose', 'aria-describedby'), /^v2g-file-error /);
    assert.ok(await page.isHidden('#v2g-editor'));
  };
  await fileError(fx('broken.mp4'), /^This browser cannot play broken\.mp4\. AVI, WMV and FLV files do not open in browsers/);
  await fileError(fx('sound.webm'), /^No picture could be read from sound\.webm\. It may hold only sound/);
  await fileError({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') }, /^photo\.png is a picture, not a video\./);
  await fileError({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3') }, /^song\.mp3 is a sound file/);
  await fileError({ name: 'empty.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(0) }, /^empty\.mp4 is empty \(0 bytes\)\.$/);
  assert.ok(!requests.some(u => u.includes('gifenc')), 'the encoder is not loaded before a video opens');

  // ---------- Default: the first 10 seconds (here the whole 3 s), 480 px wide, 10 fps ----------
  // The encoder arrives 1.5 s late, so the size estimate does too: the summary is announced once,
  // with the size, not first with "estimating the file size" and then again.
  await page.route('**/assets/vendor/gifenc/gifenc.esm.js', async route => { await new Promise(r => setTimeout(r, 1500)); await route.fallback(); });
  await page.evaluate(() => {
    const live = document.querySelector('#v2g-summary-live');
    window.liveWrites = [];
    new MutationObserver(() => window.liveWrites.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
  });
  await openVideo(page, 'frames.webm');
  assert.equal(await text('#v2g-file-error'), '');
  assert.equal(await page.getAttribute('#v2g-choose', 'aria-describedby'), 'v2g-drop-hint');
  assert.equal(await text('#v2g-info'), 'frames.webm · 320 × 180 px · 3.00 s');
  assert.equal(await page.inputValue('#v2g-start'), '0.00');
  assert.equal(await page.inputValue('#v2g-end'), '3.00');
  assert.equal(await page.getAttribute('#v2g-h-end', 'aria-valuetext'), '3 seconds');
  assert.equal(await text('#v2g-choose'), 'Choose another video');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#v2g-strip img').length), 10);
  await estimated(page);
  const sum0 = await text('#v2g-summary');
  assert.match(sum0, /^30 frames · 320 × 180 px · 3\.00 s · about [\d.]+ KB\. The video is only 320 px wide, so the GIF is not enlarged\.$/);
  assert.ok(requests.some(u => u.endsWith('/assets/vendor/gifenc/gifenc.esm.js')), 'the encoder loads once a video is open');
  await page.unroute('**/assets/vendor/gifenc/gifenc.esm.js');
  await page.waitForFunction(() => document.querySelector('#v2g-summary-live').textContent === document.querySelector('#v2g-summary').textContent);
  assert.deepEqual(await page.evaluate(() => window.liveWrites), [sum0], 'the summary is announced once, with its size');
  const gif0 = await make(page);
  const g0 = parseGif(gif0);
  assert.deepEqual([g0.width, g0.height], [320, 180]);
  checkTiming(g0, scen.default, 'default');
  assert.equal(g0.gctSize, 256);
  assert.ok(g0.frames.every(f => !f.gce.transparent && f.gce.disposal === 0), 'no transparency without "skip unchanged pixels"');
  assert.deepEqual(await codesOf(page, gif0, exp.blocks.coded), scen.default.codes, 'default: video frames shown');
  const est0 = Number(sum0.match(/about ([\d.]+) KB/)[1]) * 1000;
  assert.ok(Math.abs(est0 - gif0.length) / gif0.length < 0.2, `estimate ${est0} within 20% of ${gif0.length}`);
  assert.equal(await text('#v2g-result-info'), `${(gif0.length / 1000).toFixed(gif0.length < 1e5 ? 1 : 0)} KB (${gif0.length.toLocaleString('en-GB')} bytes) · 320 × 180 px · 30 frames · 3.00 s · plays forever`);
  assert.equal(focusAfter, 'v2g-download', 'focus moves to Download');
  assert.match(readyText, /^GIF ready: [\d.]+ KB, 30 frames, 320 by 180 pixels\.$/);
  assert.equal(await text('#v2g-status'), 'Downloading frames.gif.');
  assert.ok(await page.isHidden('#v2g-share'), 'no Share button where files cannot be shared');
  const shown = await page.$eval('#v2g-gif', img => ({ src: img.src.slice(0, 5), w: img.naturalWidth, alt: img.alt }));
  assert.deepEqual(shown, { src: 'blob:', w: 320, alt: 'Animated GIF made from frames.webm, 320 by 180 pixels' });

  // A double click downloads once.
  let downloads = 0;
  const countDl = () => downloads++;
  page.on('download', countDl);
  await page.waitForTimeout(1100); // the last download was just now
  await page.dblclick('#v2g-download');
  await page.waitForTimeout(1500);
  page.off('download', countDl);
  assert.equal(downloads, 1, 'a double click on Download saves one file');

  // Back or Forward can restore a menu after the script has run: the page reads it again on pageshow.
  await page.$eval('#v2g-fps', el => { el.value = '5'; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.match(await text('#v2g-summary'), /^15 frames · 320 × 180 px · 3\.00 s · /);
  await page.selectOption('#v2g-fps', '10');

  // Play selection plays the chosen part and stops again.
  await page.click('#v2g-play');
  assert.equal(await text('#v2g-play'), 'Pause');
  await page.waitForFunction(() => document.querySelector('#v2g-video').currentTime > 0.3);
  await page.click('#v2g-play');
  assert.equal(await text('#v2g-play'), 'Play selection');
  assert.ok(await page.evaluate(() => document.querySelector('#v2g-video').paused));

  // ---------- Trim, frame rate, speed, reverse and 3 plays ----------
  await configure(page, scen.reverse);
  await estimated(page);
  assert.match(await text('#v2g-summary'), /^15 frames · 320 × 180 px · 1\.00 s · about /);
  const gifR = await make(page);
  const gR = parseGif(gifR);
  checkTiming(gR, scen.reverse, 'reverse');
  assert.deepEqual(await codesOf(page, gifR, exp.blocks.coded), scen.reverse.codes, 'reverse: video frames shown');
  assert.match(await text('#v2g-result-info'), / · 15 frames · 1\.00 s · plays 3 times$/);

  // ---------- Boomerang, played once (no NETSCAPE2.0 block), 128 colours ----------
  await configure(page, scen.boomerang);
  await page.selectOption('#v2g-colors', '128');
  const gifB = await make(page);
  const gB = parseGif(gifB);
  checkTiming(gB, scen.boomerang, 'boomerang');
  assert.equal(gB.gctSize, 128, 'boomerang: a palette of 128 colours');
  assert.deepEqual(await codesOf(page, gifB, exp.blocks.coded), scen.boomerang.codes, 'boomerang: forward, then back without repeating the ends');
  assert.match(await text('#v2g-result-info'), / · 22 frames · 1\.83 s · plays once$/);
  await page.selectOption('#v2g-colors', '256');

  // ---------- Half speed at 30 fps: every video frame is used twice ----------
  await configure(page, scen.slow);
  const gifS = await make(page);
  const gS = parseGif(gifS);
  checkTiming(gS, scen.slow, 'slow');
  assert.deepEqual(await codesOf(page, gifS, exp.blocks.coded), scen.slow.codes, 'slow: repeated frames');

  // ---------- Up to 16 frames the size is worked out exactly ----------
  await configure(page, scen.exact);
  await estimated(page);
  const sumE = await text('#v2g-summary');
  assert.match(sumE, /^15 frames · 320 × 180 px · 3\.00 s · [\d.]+ KB \([\d,]+ bytes\)\./, 'no "about" for an exact size');
  const gifE = await make(page);
  checkTiming(parseGif(gifE), scen.exact, 'exact');
  assert.equal(sumE.match(/ KB \(([\d,]+) bytes\)/)[1], gifE.length.toLocaleString('en-GB'), 'the forecast is the size of the file made');
  assert.deepEqual(await codesOf(page, gifE, exp.blocks.coded), scen.exact.codes);

  // ---------- Width, crop and zoom ----------
  await configure(page, scen.crop);
  await page.selectOption('#v2g-width', '160');
  assert.match(await text('#v2g-summary'), /^10 frames · 160 × 90 px · 1\.00 s · /);
  await page.selectOption('#v2g-width', 'orig');
  assert.match(await text('#v2g-summary'), /^10 frames · 320 × 180 px · /);
  assert.ok(await page.isHidden('#v2g-crop'), 'no crop frame without a crop');
  await page.selectOption('#v2g-width', '480');
  await page.selectOption('#v2g-aspect', '1:1');
  assert.ok(await page.isVisible('#v2g-crop'));
  assert.match(await text('#v2g-summary'), /^10 frames · 180 × 180 px · 1\.00 s · .*The cropped part is only 180 px wide/);
  // Drag the frame to the left edge with the mouse.
  await page.locator('#v2g-stage').scrollIntoViewIfNeeded();
  const stage = await page.locator('#v2g-stage').boundingBox();
  const cropBox = await page.locator('#v2g-crop').boundingBox();
  await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x - 50, cropBox.y + cropBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const cropLeft = await page.locator('#v2g-crop').boundingBox();
  assert.ok(Math.abs(cropLeft.x - stage.x) < 1, 'the frame sits at the left edge');
  const gifC = await make(page);
  const gC = parseGif(gifC);
  assert.deepEqual([gC.width, gC.height], [180, 180]);
  const leftBlocks = exp.blocks.coded.slice(0, 3);
  assert.deepEqual(await codesOf(page, gifC, leftBlocks), scen.crop.codes.map(c => c & 7), 'crop at the left: blocks 0 to 2');
  // Ten presses of → move the frame by 10% of the video width, 32 px.
  await page.focus('#v2g-crop');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  const gifC2 = await make(page);
  const shifted = exp.blocks.coded.slice(1, 4).map(([x, y]) => [x - 32, y]);
  assert.deepEqual(await codesOf(page, gifC2, shifted), scen.crop.codes.map(c => (c >> 1) & 7), 'crop moved 32 px right: blocks 1 to 3');
  const setZoom = v => page.$eval('#v2g-zoom', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setZoom('200');
  assert.equal(await text('#v2g-zoom-out'), '200%');
  assert.equal(await page.getAttribute('#v2g-zoom', 'aria-valuetext'), '200%');
  assert.match(await text('#v2g-summary'), /^10 frames · 90 × 90 px · /);
  // Zoomed in, the frame moves up and down too: at the bottom left it shows the red end of the
  // band along the bottom of the video (rows 130 to 179), not the grey above it.
  await page.focus('#v2g-crop');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowLeft');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowDown');
  const gifZ = await make(page);
  assert.deepEqual([parseGif(gifZ).width, parseGif(gifZ).height], [90, 90]);
  const bottomLeft = await colourAt(page, gifZ, [45, 62]); // video pixel (45, 152)
  assert.ok(bottomLeft.every(([r, , b]) => r > 170 && b < 80), `crop at the bottom left: ${JSON.stringify(bottomLeft.slice(0, 3))}`);
  await setZoom('100');
  await page.selectOption('#v2g-aspect', 'orig');
  assert.ok(await page.isHidden('#v2g-crop'));

  // ---------- Typed times: formats, errors and long pastes ----------
  const startState = async () => ({
    value: await page.inputValue('#v2g-start'),
    invalid: await page.getAttribute('#v2g-start', 'aria-invalid'),
    describedby: await page.getAttribute('#v2g-start', 'aria-describedby'),
    error: await text('#v2g-start-error'),
  });
  await setTimes(page, '0', '3');
  const typeStart = async v => { await page.fill('#v2g-start', v); return startState(); };
  for (const [typed, msg] of [
    ['abc', 'Start: enter a time such as 2.5 or 1:02.5, without other characters.'],
    ['5²', 'Start: enter a time such as 2.5 or 1:02.5, without other characters.'],
    ['1\t5', 'Start: enter a time such as 2.5 or 1:02.5, without other characters.'],
    ['-1', 'Start: enter a time such as 2.5 or 1:02.5, without other characters.'],
    ['1,000.5', 'Start: enter a time such as 2.5 or 1:02.5, without other characters.'],
    ['1٬5', 'Start: enter a time such as 2.5 or 1:02.5, without other characters.'],
    ['0:75', 'Start: after a colon, use fewer than 60 seconds or minutes, as in 1:05.'],
    ['', 'Start: enter a time, such as 2.5 or 1:02.5.'],
    ['3.5', 'Start: the video is only 3.00 seconds long.'],
    ['3', 'Start: must be before the end (3.00).'],
  ]) {
    const st = await typeStart(typed);
    assert.deepEqual([st.invalid, st.describedby, st.error], ['true', 'v2g-start-error v2g-time-hint', msg], `start "${typed}"`);
  }
  // Make GIF with a wrong time goes to the field instead.
  const madeBefore = await text('#v2g-result-info');
  await page.click('#v2g-make');
  assert.ok(await page.evaluate(() => document.activeElement.id === 'v2g-start'));
  assert.ok(await page.isHidden('#v2g-progress'));
  assert.equal(await text('#v2g-result-info'), madeBefore);
  // Decimal commas, full-width and Arabic-Indic digits, a trailing "s", and m:ss.
  for (const [typed, frames] of [['0,500', 25], ['1,5', 15], ['１．５', 15], ['١٫٥', 15], ['2.5 s', 5], ['0:01.5', 15], ['0:00:02', 10], ['.5', 25]]) {
    const st = await typeStart(typed);
    assert.deepEqual([st.invalid, st.error], [null, ''], `start "${typed}" accepted`);
    assert.match(await text('#v2g-summary'), new RegExp(`^${frames} frames · `), `start "${typed}"`);
  }
  await page.fill('#v2g-start', '1,25');
  await page.locator('#v2g-start').blur();
  assert.equal(await page.inputValue('#v2g-start'), '1.25', 'a valid time is tidied when the field is left');
  await page.fill('#v2g-end', '99');
  assert.equal(await text('#v2g-end-error'), 'End: the video is only 3.00 seconds long.');
  assert.equal(await page.getAttribute('#v2g-end', 'aria-invalid'), 'true');
  await page.fill('#v2g-end', '1');
  assert.equal(await text('#v2g-end-error'), 'End: must be after the start (1.25).');
  // Moving the start handle does not overwrite an end being corrected.
  await page.focus('#v2g-h-start');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.inputValue('#v2g-start'), '1.15');
  assert.equal(await page.inputValue('#v2g-end'), '1');
  assert.equal(await page.getAttribute('#v2g-end', 'aria-invalid'), 'true');
  await page.fill('#v2g-end', '3');
  assert.equal(await page.getAttribute('#v2g-end', 'aria-invalid'), null);
  // A megabyte pasted through the clipboard is refused at once.
  const mb = '1'.repeat(1 << 20);
  await page.evaluate(t => navigator.clipboard.writeText(t), mb);
  await page.fill('#v2g-end', '2.5');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  await page.fill('#v2g-start', '0.5');
  // (Leaving a field tidies a valid time: 2.5 becomes 2.50.)
  for (const [id, name, kept] of [['#v2g-end', 'End', '2.50'], ['#v2g-start', 'Start', '0.50']]) {
    const cpu0 = await threadMs();
    await page.focus(id);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForFunction(sel => document.querySelector(sel + '-error').textContent, id);
    const cpu = (await threadMs()) - cpu0;
    assert.equal(await page.inputValue(id), kept, `${name}: the paste was refused`);
    assert.equal(await text(id + '-error'), `${name}: that is too long to be a time, so it was not pasted.`);
    assert.equal(await page.getAttribute(id, 'aria-invalid'), 'true');
    assert.ok(cpu < 1000, `refusing a megabyte paste took ${Math.round(cpu)} ms of CPU`);
  }
  await page.fill('#v2g-start', '0.5');
  // Text set without a paste event (a phone keyboard's clipboard strip) is not parsed either.
  await page.$eval('#v2g-end', (el, t) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, mb);
  assert.equal(await text('#v2g-end-error'), 'End: that is too long to be a time.');
  await page.fill('#v2g-end', '3');
  await cdp.detach();

  // ---------- A long video: m:ss times and the frame limit ----------
  assert.ok(await page.isVisible('#v2g-result'));
  await openVideo(page, 'long.webm');
  // Nothing of the last video stays on screen: its GIF goes too.
  assert.ok(await page.isHidden('#v2g-result'), 'the GIF of the last video goes when another opens');
  assert.equal(await page.getAttribute('#v2g-gif', 'src'), null);
  assert.equal(await text('#v2g-info'), 'long.webm · 64 × 36 px · 2:30.00');
  assert.equal(await page.inputValue('#v2g-start'), '0:00.00');
  assert.equal(await page.inputValue('#v2g-end'), '0:10.00', 'the first 10 seconds are selected');
  assert.match(await text('#v2g-status'), /The first 10 seconds are selected\.$/);
  await make(page);
  assert.match(await text('#v2g-result-info'), / · 64 × 36 px · 100 frames · 10\.00 s · /);
  await page.selectOption('#v2g-fps', '30');
  await page.selectOption('#v2g-speed', '0.25');
  await page.selectOption('#v2g-dir', 'forward');
  await page.fill('#v2g-end', '2:30');
  assert.match(await text('#v2g-summary'), /^18,000 frames · 64 × 36 px · 10 min 0\.00 s · too many frames\. The video is only 64 px wide/);
  assert.equal(await text('#v2g-error'), 'That is 18,000 frames; a GIF can have at most 3,000 here. Shorten the selection, lower the frame rate or raise the speed.');
  await page.click('#v2g-make');
  assert.ok(await page.isHidden('#v2g-progress'), 'nothing starts above the frame limit');
  await page.selectOption('#v2g-speed', '1');
  await page.fill('#v2g-end', '1:40');
  assert.equal(await text('#v2g-error'), '', 'the message goes once the GIF fits');
  assert.match(await text('#v2g-summary'), /^3,000 frames · 64 × 36 px · 1 min 40\.00 s · /);

  // Cancel, and the page going to the background, during a long job.
  const resultBefore = await text('#v2g-result-info');
  await page.selectOption('#v2g-fps', '10');
  await page.click('#v2g-make');
  assert.ok(await page.evaluate(() => document.activeElement.id === 'v2g-cancel'), 'focus moves to Cancel');
  await page.waitForFunction(() => /^Frame (\d+) of 1,000/.test(document.querySelector('#v2g-progress-text').textContent) && Number(document.querySelector('#v2g-progress-text').textContent.match(/^Frame (\d+)/)[1]) >= 10, null, { timeout: 30000 });
  assert.ok(await page.evaluate(() => document.querySelector('#v2g-part').inert), 'settings are locked while the GIF is made');
  const frameNo = async () => Number((await text('#v2g-progress-text')).match(/^Frame ([\d,]+)/)[1].replace(/,/g, ''));
  const hide = on => page.evaluate(on => {
    if (on) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    } else {
      delete document.hidden;
      delete document.visibilityState;
    }
    document.dispatchEvent(new Event('visibilitychange'));
    return document.querySelector('#v2g-progress-text').textContent;
  }, on);
  await hide(true);
  await page.waitForFunction(() => /^Paused/.test(document.querySelector('#v2g-progress-text').textContent));
  assert.equal(await text('#v2g-status'), 'Paused while the page is in the background.');
  const pausedAt = await page.evaluate(() => document.querySelector('#v2g-bar').value);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelector('#v2g-bar').value), pausedAt, 'no frames are read while the page is hidden');
  // Back in front, the progress line says at once what it said before the pause.
  assert.match(await hide(false), /^Frame [\d,]+ of 1,000/, 'the progress line no longer says paused');
  await page.waitForFunction(v => document.querySelector('#v2g-bar').value > v, pausedAt, { timeout: 30000 });
  assert.ok((await frameNo()) < 1000);
  // Cancel while paused in the background (a phone's task switcher, say) ends the job at once.
  await hide(true);
  await page.waitForFunction(() => /^Paused/.test(document.querySelector('#v2g-progress-text').textContent));
  await page.click('#v2g-cancel');
  await page.waitForFunction(() => !document.querySelector('#v2g-make').disabled);
  await hide(false);
  assert.equal(await text('#v2g-status'), 'Cancelled. No GIF was made.');
  assert.ok(await page.isHidden('#v2g-progress'));
  assert.ok(await page.isHidden('#v2g-cancel'));
  assert.ok(await page.evaluate(() => document.activeElement.id === 'v2g-make'), 'focus returns to Make GIF');
  assert.equal(await text('#v2g-result-info'), resultBefore, 'the previous GIF stays');
  assert.equal(await page.evaluate(() => document.querySelector('#v2g-part').inert), false);
  // Cancelled while the colours are still being chosen (Make GIF straight after a change), the
  // size estimate still arrives.
  // (The summary is read in the same step as the change, before the estimate can arrive.)
  assert.equal(await page.evaluate(() => {
    const fps = document.querySelector('#v2g-fps');
    fps.value = '12';
    fps.dispatchEvent(new Event('change', { bubbles: true }));
    return document.querySelector('#v2g-summary').textContent;
  }), '1,200 frames · 64 × 36 px · 1 min 40.00 s · estimating the file size… The video is only 64 px wide, so the GIF is not enlarged.');
  await page.evaluate(() => { document.querySelector('#v2g-make').click(); document.querySelector('#v2g-cancel').click(); });
  await page.waitForFunction(() => !document.querySelector('#v2g-make').disabled);
  assert.equal(await text('#v2g-status'), 'Cancelled. No GIF was made.');
  await estimated(page, 15000);
  // An encoder that cannot be loaded is reported, and the message goes once a later estimate
  // works. (A cancelled job ends the encoder, so the next estimate loads it again.)
  await page.route('**/assets/vendor/gifenc/gifenc.esm.js', route => route.abort());
  await page.evaluate(() => { document.querySelector('#v2g-make').click(); document.querySelector('#v2g-cancel').click(); });
  await page.waitForFunction(() => !document.querySelector('#v2g-make').disabled);
  await page.selectOption('#v2g-fps', '15');
  await page.waitForFunction(() => document.querySelector('#v2g-error').textContent, null, { timeout: 15000 });
  assert.equal(await text('#v2g-error'), 'The GIF encoder could not be loaded. Check your connection and try again.');
  assert.match(await text('#v2g-summary'), / · file size unknown\. /);
  await page.unroute('**/assets/vendor/gifenc/gifenc.esm.js');
  await page.selectOption('#v2g-fps', '10');
  await estimated(page, 15000);
  assert.equal(await text('#v2g-error'), '', 'the message goes once the encoder loads');

  // ---------- A screen recording: "skip unchanged pixels" ----------
  await openVideo(page, 'screen.webm');
  await configure(page, scen.screen);
  const gifP0 = await make(page);
  await page.check('#v2g-skip');
  await estimated(page);
  const gifP1 = await make(page);
  const gP0 = parseGif(gifP0), gP1 = parseGif(gifP1);
  checkTiming(gP1, scen.screen, 'skip');
  assert.ok(gifP1.length < gifP0.length * 0.6, `skipping unchanged pixels: ${gifP1.length} bytes instead of ${gifP0.length}`);
  assert.deepEqual([gP1.frames[0].gce.disposal, gP1.frames[0].gce.transparent], [1, false], 'first frame: whole, kept');
  const tIndex = gP1.frames[1].gce.index;
  assert.ok(tIndex > 0 && tIndex < gP1.gctSize);
  assert.ok(gP1.frames.slice(1).every(f => f.gce.disposal === 1 && f.gce.transparent && f.gce.index === tIndex), 'later frames: transparent where unchanged, drawn over the last');
  assert.ok(gP0.frames.every(f => f.gce.disposal === 0 && !f.gce.transparent));
  assert.deepEqual(await codesOf(page, gifP1, exp.blocks.screen), scen.screen.codes, 'skip: video frames shown');
  assert.deepEqual(await codesOf(page, gifP0, exp.blocks.screen), scen.screen.codes);
  // The page's plain white stays pure white with dithering on: colours the palette holds are not dithered.
  const white = await probe(page, gifP0, [[300, 60], [5, 175], [150, 40]]); // never crossed by the moving cursor
  assert.ok(white.every(r => r.every(v => v === 255)), `white areas in every frame: ${JSON.stringify(white.slice(0, 3))}`);
  // Flat colours are left undithered, so dithering costs a screen recording little: with dithering
  // applied everywhere this clip grew by 70%.
  await page.uncheck('#v2g-skip');
  await page.uncheck('#v2g-dither');
  const gifP2 = await make(page);
  await page.check('#v2g-dither');
  assert.ok(gifP0.length < gifP2.length * 1.3, `dithering a screen recording: ${gifP0.length} bytes, ${gifP2.length} without`);
  const diffs = await frameDiff(page, gifP0, gifP1);
  assert.ok(Math.max(...diffs) < 3, `frames look the same with and without skipping: ${diffs.map(d => d.toFixed(2)).join(' ')}`);
  // Where every pixel changes, frames are stored whole, so skipping never makes a GIF bigger.
  await openVideo(page, 'fade.webm');
  await page.uncheck('#v2g-skip');
  const gifF0 = await make(page);
  // The colours stay true to the video in every frame, the last (brightest) ones too: the palette
  // comes from frames across the selection, and dithering (which 64 colours need here) only adds a
  // fine pattern. (Here they are under 2. A palette from the first frame alone gave errors up to 37
  // at 256 colours, and dithering four times as strong up to 4 at 64 colours.)
  const fadeErr = await fadeError(page, gifF0);
  assert.equal(fadeErr.length, 15);
  assert.ok(Math.max(...fadeErr) < 3, `fade: colour error per frame ${fadeErr.map(d => d.toFixed(1)).join(' ')}`);
  await page.selectOption('#v2g-colors', '64');
  const gifF64 = await make(page);
  const fadeErr64 = await fadeError(page, gifF64);
  assert.ok(Math.max(...fadeErr64) < 3, `fade, 64 colours: colour error per frame ${fadeErr64.map(d => d.toFixed(1)).join(' ')}`);
  // Dithering changes the pixels whose colour the palette lacks (here 4 to 14% of them, a mean
  // change of 0.2 to 0.8 per channel); without it they take the nearest colour.
  await page.uncheck('#v2g-dither');
  const ditherDiff = await frameDiff(page, gifF64, await make(page));
  await page.check('#v2g-dither');
  assert.ok(Math.min(...ditherDiff) > 0.05, `dithering on and off differ in every frame: ${ditherDiff.map(d => d.toFixed(2)).join(' ')}`);
  await page.selectOption('#v2g-colors', '256');
  await page.check('#v2g-skip');
  const gifF1 = await make(page);
  const gF1 = parseGif(gifF1);
  assert.equal(gF1.frames.length, 15);
  assert.ok(gF1.frames.every(f => f.gce.disposal === 1 && !f.gce.transparent), 'fade: every frame stored whole');
  assert.ok(gifF1.length <= gifF0.length * 1.02, `fade: ${gifF1.length} bytes with skipping, ${gifF0.length} without`);
  assert.ok(Math.max(...await frameDiff(page, gifF0, gifF1)) < 3);
  await page.uncheck('#v2g-skip');

  // ---------- A file dropped on the page, or pasted, opens too ----------
  const drop = async (type, file, mime) => page.evaluate(async ({ type, b64, name, mime }) => {
    const bin = atob(b64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([data], name, { type: mime }));
    if (type === 'drop') {
      document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { type, b64: fs.readFileSync(fx(file)).toString('base64'), name: file, mime });
  await drop('drop', 'rotated.mp4', 'video/mp4');
  await page.waitForFunction(() => /^rotated\.mp4 /.test(document.querySelector('#v2g-info').textContent));
  assert.ok(await page.evaluate(() => !document.querySelector('#v2g-drop').classList.contains('is-over')));
  await drop('paste', 'frames.webm', 'video/webm');
  await page.waitForFunction(() => /^frames\.webm /.test(document.querySelector('#v2g-info').textContent));

  // ---------- An iPhone-style portrait video: rotation is applied ----------
  await openVideo(page, 'rotated.mp4');
  assert.equal(await text('#v2g-info'), 'rotated.mp4 · 180 × 320 px · 1.00 s');
  await configure(page, scen.rotated);
  const gifRot = await make(page);
  const gRot = parseGif(gifRot);
  assert.deepEqual([gRot.width, gRot.height], [180, 320]);
  checkTiming(gRot, scen.rotated, 'rotated');
  assert.deepEqual(await codesOf(page, gifRot, exp.blocks.rotated), scen.rotated.codes, 'rotated: video frames shown upright');

  // ---------- A browser recording without a length in its header ----------
  await openVideo(page, 'recorded.webm');
  assert.equal(await text('#v2g-file-error'), '');
  assert.match(await text('#v2g-info'), /^recorded\.webm · 320 × 180 px · (3\.00|2\.97) s$/);
  // Its length is only known once the browser has read it all, so the end is left as found.
  await configure(page, { ...scen.recorded, end: await page.inputValue('#v2g-end') });
  const gifRec = await make(page);
  checkTiming(parseGif(gifRec), scen.recorded, 'recorded');
  assert.deepEqual(await codesOf(page, gifRec, exp.blocks.coded), scen.recorded.codes);

  // ---------- A damaged file: the picture data stops after about 1.4 of its 3 seconds ----------
  // Reading past that point (the film strip does) makes the browser report a decoding error. The
  // page says where, promptly, and still makes a GIF from the part before it.
  const decodeMsg = /^The video could not be decoded at 1\.\d+ seconds\. The file may be damaged there: choose a part that ends before it\.$/;
  await openVideo(page, 'damaged.mp4');
  assert.equal(await text('#v2g-info'), 'damaged.mp4 · 320 × 180 px · 3.00 s');
  await page.waitForFunction(() => document.querySelector('#v2g-error').textContent, null, { timeout: 15000 });
  assert.match(await text('#v2g-error'), decodeMsg);
  assert.match(await text('#v2g-summary'), /^30 frames · 320 × 180 px · 3\.00 s · file size unknown\. /);
  await page.fill('#v2g-end', '1');
  await estimated(page, 15000);
  assert.equal(await text('#v2g-error'), '', 'the message goes once the selection can be read');
  const gifD = await make(page);
  checkTiming(parseGif(gifD), scen.damaged, 'damaged');
  assert.deepEqual(await codesOf(page, gifD, exp.blocks.coded), scen.damaged.codes, 'damaged: the readable part');
  await page.fill('#v2g-end', '3');
  await page.click('#v2g-make');
  await page.waitForFunction(() => !document.querySelector('#v2g-make').disabled, null, { timeout: 15000 });
  assert.match(await text('#v2g-error'), decodeMsg);

  // ---------- Keyboard only ----------
  await open();
  // Listening first: Playwright turns on catching the file dialog asynchronously.
  const chooserSoon = page.waitForEvent('filechooser', { timeout: 15000 });
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement.id === 'v2g-choose');
  }
  assert.ok(reached, 'Tab reaches Choose a video');
  await page.keyboard.press('Enter');
  await (await chooserSoon).setFiles(fx('frames.webm'));
  await page.waitForFunction(() => !document.querySelector('#v2g-editor').hidden);
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement.id === 'v2g-h-start'), 'the start handle follows');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.inputValue('#v2g-start'), '0.10', '→ moves one GIF frame (0.1 s at 10 fps)');
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await page.inputValue('#v2g-start'), '1.10', 'Shift+→ moves one second');
  assert.equal(await page.getAttribute('#v2g-h-start', 'aria-valuetext'), '1.1 seconds');
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement.id === 'v2g-h-end'));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('End');
  assert.equal(await page.inputValue('#v2g-end'), '3.00');
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await page.inputValue('#v2g-end'), '2.00');
  reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement.id === 'v2g-make');
  }
  assert.ok(reached, 'Tab reaches Make GIF');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'v2g-download', null, { timeout: 60000 });
  const [dlK] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(dlK.suggestedFilename(), 'frames.gif');
  const gifK = fs.readFileSync(await dlK.path());
  checkTiming(parseGif(gifK), scen.keyboard, 'keyboard');
  assert.deepEqual(await codesOf(page, gifK, exp.blocks.coded), scen.keyboard.codes);

  // A GIF under 1 KB gives its size once ("739 bytes", not "739 bytes (739 bytes)"):
  // a 64 x 36 px, 1-second video made by tests/fixtures/mp4-to-mp3/make_fixtures.py.
  // Its long name is cut to 120 characters for the GIF without splitting the emoji at the cut.
  const longName = 'a'.repeat(119) + '😀 tiny';
  await openVideo(page, { name: longName + '.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(path.join(fixtures, '..', 'mp4-to-mp3', 'silent-video.mp4')) });
  await estimated(page);
  const tiny = await text('#v2g-summary');
  assert.match(tiny, / · \d{3} bytes\./, tiny);
  assert.doesNotMatch(tiny, /bytes \(/, tiny);
  // (The browser here may save names that are not plain ASCII as "download", so the name is read
  // where the page hands it over.)
  await page.evaluate(() => {
    window.savedAs = [];
    const save = TT.download;
    TT.download = (name, ...rest) => { window.savedAs.push(name); return save(name, ...rest); };
  });
  await make(page);
  assert.deepEqual(await page.evaluate(() => window.savedAs), ['a'.repeat(119) + '😀.gif']);

  // ---------- Times past an hour (a 62-minute still picture) ----------
  await openVideo(page, 'hour.webm');
  assert.equal(await text('#v2g-info'), 'hour.webm · 32 × 18 px · 1:02:10.00');
  assert.equal(await text('#v2g-status'), 'Opened hour.webm: 1 hour 2 minutes 10 seconds, 32 × 18 pixels. The first 10 seconds are selected.');
  await page.fill('#v2g-end', '1:02:10');
  await page.fill('#v2g-start', '1:00:00');
  assert.deepEqual([await page.getAttribute('#v2g-start', 'aria-invalid'), await page.getAttribute('#v2g-end', 'aria-invalid')], [null, null]);
  assert.equal(await page.getAttribute('#v2g-h-start', 'aria-valuetext'), '1 hour');
  assert.equal(await page.getAttribute('#v2g-h-end', 'aria-valuetext'), '1 hour 2 minutes 10 seconds');
  await page.locator('#v2g-start').blur();
  assert.equal(await page.inputValue('#v2g-start'), '1:00:00.00');
  assert.match(await text('#v2g-summary'), /^1,300 frames · 32 × 18 px · 2 min 10\.00 s · /);

  // ---------- A page in the background ----------
  // A tab that is not in front draws nothing: document.hidden is true, animation frames do not run
  // and no video frames are presented, so requestVideoFrameCallback does not fire either. These
  // pages imitate that, and page.clock jumps over the page's 3- and 20-second waits.
  const browser = page.context().browser();
  function backgroundTab(noRvfc) {
    let hidden = false, key = 0;
    const held = new Map();
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => { if (!hidden) return raf(cb); const id = 1e9 + ++key; held.set(id, cb); return id; };
    window.cancelAnimationFrame = id => { if (held.has(id)) held.delete(id); else caf(id); };
    const P = HTMLVideoElement.prototype, rv = P.requestVideoFrameCallback, cv = P.cancelVideoFrameCallback;
    window.frameRequests = 0;
    if (noRvfc) { delete P.requestVideoFrameCallback; delete P.cancelVideoFrameCallback; } else {
      const recs = new Map();
      P.requestVideoFrameCallback = function (cb) {
        window.frameRequests++;
        const v = this, k = ++key, rec = { off: false, id: 0 };
        // A frame presented while hidden is not reported: wait for the next one.
        const wrap = (...a) => { if (rec.off) return; if (hidden) rec.id = rv.call(v, wrap); else { recs.delete(k); cb(...a); } };
        rec.id = rv.call(v, wrap);
        recs.set(k, rec);
        return k;
      };
      P.cancelVideoFrameCallback = function (k) { const r = recs.get(k); if (r) { r.off = true; recs.delete(k); cv.call(this, r.id); } };
    }
    window.setHidden = on => {
      hidden = on;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      if (!on) { const q = [...held.values()]; held.clear(); q.forEach(cb => raf(cb)); }
      document.dispatchEvent(new Event('visibilitychange'));
    };
    // The page goes to the background just as the hidden video finishes its next seek.
    window.seeks = 0;
    document.addEventListener('DOMContentLoaded', () => document.querySelector('#v2g-cap').addEventListener('seeked', () => {
      window.seeks++;
      if (window.hideNext) { window.hideNext = false; window.setHidden(true); }
    }));
  }
  const bgProblems = [];
  async function backgroundPage(noRvfc) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const bp = await ctx.newPage();
    bp.on('pageerror', e => bgProblems.push(e.message));
    bp.on('console', m => { if (m.type() === 'error') bgProblems.push(m.text()); });
    await bp.clock.install();
    await bp.addInitScript(backgroundTab, noRvfc);
    await bp.goto(url);
    return bp;
  }
  // Sent to the background while the film strip is being made: no frames are read until the page
  // is back in front, and from then on it still waits for each new frame to be presented.
  let bp = await backgroundPage(false);
  await bp.evaluate(() => { window.hideNext = true; });
  await bp.setInputFiles('#v2g-file', fx('long.webm'));
  await bp.waitForFunction(() => document.hidden, null, { polling: 100 });
  const seeksHidden = await bp.evaluate(() => window.seeks);
  for (let i = 0; i < 4; i++) {
    await bp.clock.fastForward(3100);
    await bp.waitForTimeout(150);
  }
  assert.equal(await bp.evaluate(() => window.seeks), seeksHidden, 'no frames are read while the page is in the background');
  const requestsHidden = await bp.evaluate(() => window.frameRequests);
  await bp.evaluate(() => window.setHidden(false));
  await estimated(bp);
  assert.ok(await bp.evaluate(n => window.frameRequests > n, requestsHidden), 'back in front, the page still waits for presented frames');
  await bp.context().close();
  // Where the browser cannot report presented frames (Firefox before 132), a job that goes to the
  // background in the middle of a seek pauses, however long it stays there, and then finishes.
  bp = await backgroundPage(true);
  await openVideo(bp, 'long.webm');
  await estimated(bp);
  await bp.click('#v2g-make');
  await bp.waitForFunction(() => /^Frame (\d+)/.test(document.querySelector('#v2g-progress-text').textContent) && Number(document.querySelector('#v2g-progress-text').textContent.match(/^Frame (\d+)/)[1]) >= 10);
  await bp.evaluate(() => { window.hideNext = true; });
  await bp.waitForFunction(() => document.hidden, null, { polling: 100 });
  await bp.clock.fastForward(25000);
  await bp.waitForTimeout(150);
  assert.equal(await bp.textContent('#v2g-error'), '', 'no error after 25 s in the background');
  assert.ok(await bp.evaluate(() => document.querySelector('#v2g-make').disabled), 'the job waits');
  await bp.evaluate(() => window.setHidden(false));
  await bp.waitForFunction(() => !document.querySelector('#v2g-make').disabled, null, { timeout: 60000 });
  assert.equal(await bp.textContent('#v2g-error'), '');
  assert.match(await bp.textContent('#v2g-result-info'), / · 100 frames · 10\.00 s · plays forever$/);
  await bp.context().close();
  assert.deepEqual(bgProblems, [], 'background pages: errors');

  // ---------- A GIF over the size limit ----------
  // A GIF that passes 250 MB is stopped. The size estimate shows that in advance, so such a GIF is
  // refused before any work, with the reason. Here the page is served with the limit lowered to
  // 100 KB, so that the 3-second clip, about 235 KB at 480 px, is over it.
  const limited = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const lp = await limited.newPage();
  const limitProblems = [];
  lp.on('pageerror', e => limitProblems.push(e.message));
  await lp.route(url, async route => {
    const res = await route.fetch(), body = await res.text();
    assert.ok(body.includes('const MAX_BYTES = 250e6;'), 'the page sets its size limit');
    await route.fulfill({ response: res, body: body.replace('const MAX_BYTES = 250e6;', 'const MAX_BYTES = 1e5;') });
  });
  await lp.goto(url);
  await openVideo(lp, 'frames.webm');
  await estimated(lp);
  const overLimit = /^That is about [\d.]+ KB; a GIF can be at most 100 KB here\. Make it shorter, narrower or slower \(fewer frames per second\)\.$/;
  assert.match(await lp.textContent('#v2g-error'), overLimit);
  const opened = await lp.textContent('#v2g-status');
  await lp.click('#v2g-make');
  assert.ok(await lp.isHidden('#v2g-progress'), 'nothing starts above the size limit');
  assert.equal(await lp.textContent('#v2g-status'), opened, 'no GIF is announced');
  assert.ok(await lp.isHidden('#v2g-result'));
  await lp.selectOption('#v2g-width', '160');
  await estimated(lp);
  assert.equal(await lp.textContent('#v2g-error'), '', 'the message goes once the GIF fits');
  await lp.click('#v2g-make');
  await lp.waitForFunction(() => !document.querySelector('#v2g-result').hidden && !document.querySelector('#v2g-make').disabled, null, { timeout: 60000 });
  const smallGif = await lp.textContent('#v2g-result-info');
  assert.match(smallGif, / · 160 × 90 px · 30 frames · /);
  // Make GIF pressed straight after a change, before the estimate: the job finds the GIF too big
  // once it has chosen the colours, and stops there, before reading a single frame.
  await lp.evaluate(() => {
    const progress = document.querySelector('#v2g-progress-text');
    window.progressTexts = [];
    new MutationObserver(() => window.progressTexts.push(progress.textContent)).observe(progress, { childList: true, characterData: true, subtree: true });
    const w = document.querySelector('#v2g-width');
    w.value = '480';
    w.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#v2g-make').click();
  });
  await lp.waitForFunction(() => !document.querySelector('#v2g-make').disabled, null, { timeout: 30000 });
  assert.match(await lp.textContent('#v2g-error'), overLimit);
  assert.deepEqual(await lp.evaluate(() => window.progressTexts.filter(t => /^Frame/.test(t))), [], 'no frame is read');
  assert.equal(await lp.textContent('#v2g-result-info'), smallGif, 'the GIF made before stays');
  await limited.close();
  assert.deepEqual(limitProblems, [], 'size limit page: errors');

  // ---------- A phone: touch drags and taps ----------
  // A German phone: the comma is the decimal mark there.
  const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE', acceptDownloads: true });
  const pp = await phone.newPage();
  const problems = [];
  pp.on('pageerror', e => problems.push(e.message));
  pp.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await pp.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(new URL(url).origin) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
    problems.push('request to another host: ' + u);
    return route.abort();
  });
  await pp.goto(url);
  await openVideo(pp, 'frames.webm');
  await estimated(pp);
  for (const sel of ['#v2g-choose', '#v2g-h-start', '#v2g-h-end', '[data-nudge="start"][data-dir="1"]', '#v2g-play', '#v2g-make', '#v2g-fps', '#v2g-start', '.v2g-checks .check']) {
    const b = await pp.locator(sel).first().boundingBox();
    assert.ok(b.height >= 44 && b.width >= 40, `${sel} is ${b.width} x ${b.height}`);
  }
  assert.ok(await pp.$eval('#v2g-start', el => parseFloat(getComputedStyle(el).fontSize) >= 16));
  await pp.tap('#v2g-play');
  assert.equal(await pp.textContent('#v2g-play'), 'Pause', 'a tap plays the selection');
  await pp.tap('#v2g-play');
  assert.equal(await pp.textContent('#v2g-play'), 'Play selection');
  const pcdp = await phone.newCDPSession(pp);
  const touch = (type, x, y) => pcdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await pp.locator('#v2g-track').scrollIntoViewIfNeeded();
  const tr = await pp.locator('#v2g-track').boundingBox();
  const hs = await pp.locator('#v2g-h-start').boundingBox();
  const scrolled = await pp.evaluate(() => scrollY);
  await touch('touchStart', hs.x + hs.width - 8, tr.y + tr.height / 2);
  for (let s = 1; s <= 5; s++) await touch('touchMove', hs.x + hs.width - 8 + tr.width / 2 * s / 5, tr.y + tr.height / 2);
  await touch('touchEnd');
  const dragged = Number(await pp.inputValue('#v2g-start'));
  assert.ok(Math.abs(dragged - 1.5) < 0.15, `dragging the start handle half way puts the start at ${dragged}`);
  assert.equal(await pp.evaluate(() => scrollY), scrolled, 'the page did not scroll during the drag');
  // A finger that lands on the film strip and moves up scrolls the page and leaves the selection
  // alone; a tap on the strip moves the nearer edge there.
  const edges = async () => [await pp.inputValue('#v2g-start'), await pp.inputValue('#v2g-end')];
  const kept = await edges();
  const sx = tr.x + tr.width * 0.75, sy = tr.y + tr.height / 2;
  await touch('touchStart', sx, sy);
  for (let s = 1; s <= 8; s++) await touch('touchMove', sx + s, sy - s * 25);
  await touch('touchEnd');
  await pp.waitForFunction(y => scrollY !== y, scrolled);
  assert.deepEqual(await edges(), kept, 'a vertical swipe that starts on the strip moves no edge');
  await pp.locator('#v2g-track').scrollIntoViewIfNeeded();
  const tr2 = await pp.locator('#v2g-track').boundingBox();
  await touch('touchStart', tr2.x + tr2.width * 0.8, tr2.y + tr2.height / 2);
  await touch('touchEnd');
  await pp.waitForFunction(() => document.querySelector('#v2g-end').value !== '3.00');
  assert.ok(Math.abs(Number(await pp.inputValue('#v2g-end')) - 2.4) < 0.15, `a tap at 80% moves the end there: ${await pp.inputValue('#v2g-end')}`);
  await pp.fill('#v2g-end', '3');
  await pp.fill('#v2g-start', '0,5');
  assert.equal(await pp.getAttribute('#v2g-start', 'aria-invalid'), null, 'a decimal comma is accepted');
  assert.match(await pp.textContent('#v2g-summary'), /^25 frames · /);
  await pp.selectOption('#v2g-aspect', '1:1');
  await pp.locator('#v2g-stage').scrollIntoViewIfNeeded();
  const cb = await pp.locator('#v2g-crop').boundingBox();
  const st = await pp.locator('#v2g-stage').boundingBox();
  await touch('touchStart', cb.x + cb.width / 2, cb.y + cb.height / 2);
  for (let s = 1; s <= 5; s++) await touch('touchMove', cb.x + cb.width / 2 + (st.x + st.width - cb.x - cb.width) * s / 5 + 30, cb.y + cb.height / 2);
  await touch('touchEnd');
  const cr = await pp.locator('#v2g-crop').boundingBox();
  assert.ok(Math.abs(cr.x + cr.width - st.x - st.width) < 1, 'a touch drag moves the crop frame to the right edge');
  // Chromium's touch emulation often turns a tap soon after a drag into no click at all (on any
  // page, crop-image-circle too), so this button is pressed from the keyboard.
  await pp.focus('#v2g-make');
  await pp.keyboard.press('Enter');
  await pp.waitForFunction(() => !document.querySelector('#v2g-result').hidden && !document.querySelector('#v2g-make').disabled, null, { timeout: 60000 });
  assert.match(await pp.textContent('#v2g-result-info'), / · 180 × 180 px · 25 frames · 2\.50 s · plays forever$/);
  assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll with a result');
  // Nothing in the controls is cut off, from 320 to 540 px wide.
  for (const width of [320, 340, 360, 390, 412, 480, 540]) {
    await pp.setViewportSize({ width, height: 800 });
    const cut = await pp.$$eval('#v2g .btn, #v2g select', els => els.filter(b => b.getClientRects().length).map(b => {
      const cs = getComputedStyle(b);
      if (b.tagName === 'SELECT') {
        const c = document.createElement('canvas').getContext('2d');
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const widest = Math.max(...[...b.options].map(o => c.measureText(o.text).width));
        return widest > b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16 ? b.id : null;
      }
      return b.scrollWidth > b.clientWidth + 1 || b.getClientRects().length > 1 || b.getBoundingClientRect().height > 60 ? b.textContent : null;
    }).filter(Boolean));
    assert.deepEqual(cut, [], `controls cut off at ${width} px`);
    assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll at ${width} px`);
  }
  await phone.close();
  assert.deepEqual(problems, [], 'phone page errors');
};
