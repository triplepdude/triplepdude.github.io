const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { devices } = require('playwright');

// The test GIFs and their expected frames come from tests/fixtures/gif-to-mp4/make_fixtures.py,
// which writes them byte by byte and composites their frames with a small model of how browsers
// show a GIF, checked against ImageMagick's -coalesce wherever ImageMagick shows GIFs as browsers
// do (see the list in that script). Here the page's frames (assets/js/gif-frames.js, with the
// browser's ImageDecoder and, with ImageDecoder removed, with omggif) must hash to those frames.
// The edge-*.gif files (make_edge_fixtures.py) bend the rules further; for them the reference is
// what Chromium's own ImageDecoder shows, frame by frame.
// The MP4s are read back three ways that share no code with the page: the boxes are parsed below
// (sizes, frame durations, sample bytes), tests/fixtures/gif-to-mp4/verify.py runs ffprobe and
// decodes them with ffmpeg against ImageMagick's frames (PSNR), and Chromium's <video> plays them.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8')).files;
  const fx = f => path.join(fixtures, f);
  const read = f => fs.readFileSync(fx(f));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-to-mp4-test-'));
  const browser = page.context().browser();
  try {
    await run();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  async function run() {
    // ffmpeg, ffprobe, ImageMagick and numpy for verify.py. Without them the MP4s are still
    // parsed here and played in Chromium, and a note says what was skipped.
    let tools = true;
    try {
      execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      execFileSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' });
      try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); } catch (e) { execFileSync('convert', ['-version'], { stdio: 'ignore' }); }
    } catch (e) { tools = false; }
    if (!tools) console.log('  (gif-to-mp4: ffmpeg, ffprobe, ImageMagick or numpy is missing: MP4s are checked by parsing and in Chromium only)');
    let saved = 0;
    const verify = (gifName, buf, opt) => {
      if (!tools) return null;
      const p = path.join(tmp, `out-${++saved}.mp4`);
      fs.writeFileSync(p, buf);
      return JSON.parse(execFileSync('python3', [fx('verify.py'), typeof gifName === 'string' && !path.isAbsolute(gifName) ? fx(gifName) : gifName, p, JSON.stringify(opt)], { maxBuffer: 256 << 20 }).toString());
    };

    // ---------- Reading MP4 and ZIP files ----------
    function boxes(buf, start, end, cb) {
      for (let p = start; p + 8 <= end;) {
        let size = buf.readUInt32BE(p), hdr = 8;
        const type = buf.toString('latin1', p + 4, p + 8);
        if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
        assert.ok(size >= hdr && p + size <= end, `box ${type} at ${p} fits`);
        cb(type, p + hdr, p + size);
        p += size;
      }
    }
    function parseMp4(buf) {
      const r = { top: [], tracks: [] };
      boxes(buf, 0, buf.length, (type, s, e) => {
        r.top.push(type);
        if (type === 'ftyp') r.brand = buf.toString('latin1', s, s + 4);
        if (type !== 'moov') return;
        boxes(buf, s, e, (t, s2, e2) => {
          if (t === 'mvhd') { const v = buf[s2]; r.timescale = buf.readUInt32BE(s2 + (v ? 20 : 12)); r.duration = v ? Number(buf.readBigUInt64BE(s2 + 24)) : buf.readUInt32BE(s2 + 16); }
          if (t !== 'trak') return;
          const tr = { sampleSizes: [], deltas: [], sync: null, chunks: [], stsc: [], ctts: false };
          r.tracks.push(tr);
          const walk = (a, b) => boxes(buf, a, b, (t3, s3, e3) => {
            if (t3 === 'tkhd') {
              const v = buf[s3], m = s3 + (v ? 52 : 40); // version, flags, times, ids, duration, reserved, layer, group, volume
              tr.matrix = [0, 1, 3, 4].map(i => buf.readInt32BE(m + i * 4));
              tr.width = buf.readUInt32BE(e3 - 8) / 65536;
              tr.height = buf.readUInt32BE(e3 - 4) / 65536;
            } else if (t3 === 'mdhd') {
              const v = buf[s3];
              tr.timescale = buf.readUInt32BE(s3 + (v ? 20 : 12));
              tr.duration = v ? Number(buf.readBigUInt64BE(s3 + 24)) : buf.readUInt32BE(s3 + 16);
            } else if (t3 === 'hdlr') tr.handler = buf.toString('latin1', s3 + 8, s3 + 12);
            else if (t3 === 'stsd') {
              tr.codec = buf.toString('latin1', s3 + 12, s3 + 16);
              tr.codedWidth = buf.readUInt16BE(s3 + 8 + 32);
              tr.codedHeight = buf.readUInt16BE(s3 + 8 + 34);
              const avcC = buf.indexOf('avcC', s3);
              if (avcC > 0 && avcC < e3) tr.profile = buf[avcC + 5];
            } else if (t3 === 'stts') {
              for (let i = 0, n = buf.readUInt32BE(s3 + 4); i < n; i++) {
                const c = buf.readUInt32BE(s3 + 8 + i * 8), d = buf.readUInt32BE(s3 + 12 + i * 8);
                for (let k = 0; k < c; k++) tr.deltas.push(d);
              }
            } else if (t3 === 'stss') {
              tr.sync = [];
              for (let i = 0, n = buf.readUInt32BE(s3 + 4); i < n; i++) tr.sync.push(buf.readUInt32BE(s3 + 8 + i * 4) - 1);
            } else if (t3 === 'stsz') {
              const fixed = buf.readUInt32BE(s3 + 4), n = buf.readUInt32BE(s3 + 8);
              for (let i = 0; i < n; i++) tr.sampleSizes.push(fixed || buf.readUInt32BE(s3 + 12 + i * 4));
            } else if (t3 === 'stco' || t3 === 'co64') {
              for (let i = 0, n = buf.readUInt32BE(s3 + 4); i < n; i++) tr.chunks.push(t3 === 'stco' ? buf.readUInt32BE(s3 + 8 + i * 4) : Number(buf.readBigUInt64BE(s3 + 8 + i * 8)));
            } else if (t3 === 'stsc') {
              for (let i = 0, n = buf.readUInt32BE(s3 + 4); i < n; i++) tr.stsc.push([buf.readUInt32BE(s3 + 8 + i * 12), buf.readUInt32BE(s3 + 12 + i * 12)]);
            } else if (t3 === 'ctts') tr.ctts = true;
            else if (['mdia', 'minf', 'stbl'].includes(t3)) walk(s3, e3);
          });
          walk(s2, e2);
          // Each sample's bytes, from the chunk offsets and the samples per chunk.
          tr.samples = [];
          let k = 0;
          for (let c = 0; c < tr.chunks.length; c++) {
            let per = 0;
            for (const [first, n] of tr.stsc) if (first - 1 <= c) per = n;
            for (let p = tr.chunks[c], i = 0; i < per && k < tr.sampleSizes.length; i++, k++) {
              tr.samples.push(crypto.createHash('sha256').update(buf.subarray(p, p + tr.sampleSizes[k])).digest('hex').slice(0, 16));
              p += tr.sampleSizes[k];
            }
          }
          tr.ms = tr.deltas.map(d => d * 1000 / tr.timescale);
        });
      });
      return r;
    }
    // Checks the structure of an MP4 the page made: one H.264 video track, nothing else, its index
    // before the data (fast start), the expected size, no rotation, and one sample per frame
    // lasting the expected times (ms).
    function checkMp4(buf, { width, height, ms, label }) {
      const m = parseMp4(buf);
      assert.deepEqual(m.top.filter(t => t !== 'free'), ['ftyp', 'moov', 'mdat'], `${label}: ftyp, then the index (moov), then the data`);
      assert.equal(m.tracks.length, 1, `${label}: one track`);
      const t = m.tracks[0];
      assert.deepEqual([t.handler, t.codec], ['vide', 'avc1'], `${label}: an H.264 video track`);
      assert.deepEqual([t.width, t.height, t.codedWidth, t.codedHeight], [width, height, width, height], `${label}: ${width} x ${height}`);
      assert.deepEqual(t.matrix, [65536, 0, 0, 65536], `${label}: not rotated`);
      assert.equal(t.sampleSizes.length, ms.length, `${label}: ${ms.length} frames`);
      assert.deepEqual(t.ms.map(x => Math.round(x * 1000) / 1000), ms, `${label}: frame durations in ms`);
      assert.equal(t.duration * 1000 / t.timescale, ms.reduce((a, b) => a + b, 0), `${label}: track length`);
      // Without a sync sample box every frame is a key frame.
      assert.ok(!t.sync || t.sync[0] === 0, `${label}: starts with a key frame`);
      assert.ok(!t.ctts, `${label}: no reordered frames`);
      return m;
    }
    function parseZip(buf) {
      const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      assert.ok(eocd >= 0, 'ZIP end record');
      const n = buf.readUInt16LE(eocd + 10);
      let p = buf.readUInt32LE(eocd + 16);
      const out = [];
      for (let i = 0; i < n; i++) {
        assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry');
        const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(dataAt, dataAt + size);
        out.push({ name, method, crc, data });
        p += 46 + nameLen + extra + comment;
      }
      return out;
    }
    const crc32 = b => (zlib.crc32 ? zlib.crc32(b) : null);

    // ---------- Page helpers ----------
    const text = (sel, p = page) => p.textContent(sel);
    const rowOf = (name, p = page) => p.evaluate(n => {
      const li = [...document.querySelectorAll('.g2m-file')].find(x => x.querySelector('.g2m-name').textContent === n);
      if (!li) return null;
      const q = s => li.querySelector(s);
      return {
        id: li.id, info: q('.g2m-info').textContent, plan: q('.g2m-plan').textContent, note: q('.hint').hidden ? '' : q('.hint').textContent,
        state: q('.g2m-state').textContent, msg: q('.msg.error').textContent, buttons: [...q('.g2m-row-actions').querySelectorAll('button')].map(b => b.textContent),
        result: q('.g2m-result').hidden ? null : q('.g2m-result .g2m-info').textContent, code: q('.g2m-result pre') ? q('.g2m-result pre').textContent : null,
      };
    }, name);
    async function addFiles(files, p = page) {
      const before = await p.evaluate(() => document.querySelectorAll('.g2m-file').length);
      // Playwright takes paths or buffers, not both in one call.
      const asBuffer = f => (typeof f === 'string' ? { name: path.basename(f), mimeType: 'image/gif', buffer: fs.readFileSync(f) } : f);
      await p.setInputFiles('#g2m-file', Array.isArray(files) ? files.map(asBuffer) : asBuffer(files));
      const want = before + (Array.isArray(files) ? files.length : 1);
      await p.waitForFunction(w => document.querySelectorAll('.g2m-file').length + (document.querySelector('#g2m-file-error').textContent ? 1 : 0) >= w || document.querySelector('#g2m-file-error').textContent, want);
    }
    async function convert(p = page) {
      await p.click('#g2m-convert');
      await p.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 120000 });
    }
    async function download(name, p = page) {
      const row = await rowOf(name, p);
      const btn = p.locator(`#${row.id} .g2m-row-actions button`, { hasText: 'Download MP4' });
      const [dl] = await Promise.all([p.waitForEvent('download'), btn.click()]);
      return { buf: fs.readFileSync(await dl.path()), name: dl.suggestedFilename() };
    }
    const b64 = f => read(f).toString('base64');
    // Plays an MP4 in Chromium's own <video> element.
    async function playBack(buf, p = page) {
      return p.evaluate(async b => {
        const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0));
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        document.body.appendChild(v);
        const u = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        const r = {};
        try {
          await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('media error ' + (v.error && v.error.code))); v.src = u; });
          r.w = v.videoWidth; r.h = v.videoHeight; r.duration = Math.round(v.duration * 1000) / 1000;
          await v.play();
          await new Promise(ok => { const t = () => (v.getVideoPlaybackQuality().totalVideoFrames > 0 && v.currentTime > 0) || v.ended ? ok() : setTimeout(t, 20); t(); });
          r.frames = v.getVideoPlaybackQuality().totalVideoFrames;
          v.pause();
        } catch (e) { r.error = e.message; }
        v.remove();
        URL.revokeObjectURL(u);
        return r;
      }, buf.toString('base64'));
    }
    // TTGif's frames for a fixture, as hashes like make_fixtures.py's, with the decoder used.
    async function engine(p, names, decoder) {
      return p.evaluate(async ({ files, decoder }) => {
        const out = {};
        for (const [name, data] of files) {
          const blob = new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))]);
          const info = await TTGif.scan(blob);
          const r = {
            info: {
              width: info.width, height: info.height, screen: [info.screenWidth, info.screenHeight], frameCount: info.frameCount,
              delays: info.frames.map(f => f.delay), durations: info.frames.map(f => f.duration), loopCount: info.loopCount,
              truncated: info.truncated, partialFrame: info.partialFrame,
            },
            plays: info.plays === Infinity ? 'Infinity' : info.plays, hashes: [], damagedAt: null, sizes: [],
          };
          const rd = await TTGif.open(blob, { decoder });
          r.started = rd.decoder;
          try {
            for await (const f of rd.frames()) {
              const h = new Uint8Array(await crypto.subtle.digest('SHA-256', f.data));
              r.hashes.push([...h.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(''));
              if (f.data.length !== f.width * f.height * 4 || f.index !== r.hashes.length - 1) r.sizes.push('bad frame ' + f.index);
            }
          } catch (e) {
            if (e.code === 'DAMAGED') r.damagedAt = e.frame; else r.error = e.code + ': ' + e.message;
          }
          r.ended = rd.decoder;
          rd.close();
          out[name] = r;
        }
        return out;
      }, { files: names.map(n => [n, b64(n)]), decoder });
    }
    function checkEngine(got, label) {
      for (const [name, e] of Object.entries(exp)) {
        const g = got[name];
        assert.ok(!g.error, `${label} ${name}: ${g.error}`);
        assert.deepEqual(g.sizes, [], `${label} ${name}: frame objects`);
        assert.deepEqual(g.info, {
          width: e.width, height: e.height, screen: e.screen, frameCount: e.frameCount, delays: e.delays, durations: e.durations,
          loopCount: e.loopCount, truncated: e.truncated, partialFrame: e.partialFrame,
        }, `${label} ${name}: what the scan reads`);
        assert.deepEqual(g.hashes, e.hashes, `${label} ${name}: every frame as browsers show it`);
        assert.equal(g.damagedAt, e.damagedAt, `${label} ${name}: the damaged frame`);
      }
    }
    // ---------- As served ----------
    const requests = [];
    page.on('request', r => requests.push(r.url()));
    await open();
    assert.ok(await page.isVisible('#g2m-open'));
    assert.ok(await page.isHidden('#g2m-list'));
    assert.ok(await page.isDisabled('#g2m-convert'));
    assert.equal(await page.getAttribute('#g2m-file', 'accept'), 'image/gif,.gif');
    assert.equal(await page.inputValue('#g2m-bg-hex'), '#FFFFFF');
    assert.deepEqual(await page.$$eval('#g2m-opts select', els => els.map(e => e.value)), ['1', 'pad', '1', 'high']);
    assert.equal(await text('#g2m-summary'), '');
    assert.ok(!requests.some(u => /gif-frames|mediabunny|omggif/.test(u)), 'no decoder or encoder is loaded before a GIF is chosen');

    // ---------- Files that are not GIFs, or GIFs without a picture ----------
    const refuse = async (file, re) => {
      await page.setInputFiles('#g2m-file', file);
      await page.waitForFunction(() => document.querySelector('#g2m-file-error').textContent);
      const msg = await text('#g2m-file-error');
      assert.match(msg, re);
      assert.equal(await page.getAttribute('#g2m-open', 'aria-describedby'), 'g2m-file-error g2m-drop-hint');
      assert.equal(await page.getAttribute('#g2m-file-error', 'aria-live'), 'polite', 'file messages are polite');
      assert.ok(await page.isHidden('#g2m-list'));
      return msg;
    };
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40)]);
    assert.equal(await refuse({ name: 'photo.gif', mimeType: 'image/gif', buffer: png }, /./), 'photo.gif is a PNG image, not a GIF. Choose a .gif file.');
    assert.equal(await refuse({ name: 'empty.gif', mimeType: 'image/gif', buffer: Buffer.alloc(0) }, /./), 'empty.gif is empty (0 bytes).');
    assert.equal(await refuse({ name: 'clip.gif', mimeType: 'image/gif', buffer: Buffer.concat([Buffer.from('0000001c66747970', 'hex'), Buffer.from('isom'), Buffer.alloc(40)]) }, /./), 'clip.gif is already a video, not a GIF.');
    assert.equal(await refuse({ name: 'notes.gif', mimeType: 'image/gif', buffer: Buffer.from('These are notes, not a picture.\n') }, /./), 'notes.gif is a text file, not a GIF. Choose a .gif file.');
    assert.equal(await refuse({ name: 'head.gif', mimeType: 'image/gif', buffer: read('still.gif').subarray(0, 30) }, /./),
      'head.gif is a GIF with no picture that can be read: the file stops before its first whole frame.');
    // A canvas of 60 megapixels, which no browser could hold frame by frame.
    const huge = Buffer.from(read('still.gif'));
    huge.writeUInt16LE(10000, 6);
    huge.writeUInt16LE(6000, 8);
    assert.equal(await refuse({ name: 'poster.gif', mimeType: 'image/gif', buffer: huge }, /./), 'poster.gif is 10,000 × 6,000 pixels, too large to convert in a browser.');
    // Two at once: both reasons, one after the other.
    assert.equal(await refuse([{ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.alloc(0) }, { name: 'b.gif', mimeType: 'image/gif', buffer: png }], /./),
      'a.gif is empty (0 bytes). b.gif is a PNG image, not a GIF. Choose a .gif file.');
    assert.ok(requests.some(u => u.endsWith('/assets/js/gif-frames.js')), 'the GIF reader loads once a file is chosen');
    assert.ok(!requests.some(u => u.includes('omggif')), 'omggif is not loaded where the browser has ImageDecoder');

    // ---------- The frames, as the page reads them (ImageDecoder in Chromium) ----------
    const names = Object.keys(exp);
    const withId = await engine(page, names, 'auto');
    checkEngine(withId, 'ImageDecoder');
    assert.ok(names.every(n => withId[n].started === 'imagedecoder'), 'ImageDecoder is used where the browser has it');
    assert.equal(withId['damaged.gif'].ended, 'omggif', 'where ImageDecoder refuses a frame, omggif checks it too');
    assert.equal(withId['unusual.gif'].ended, 'imagedecoder');

    // ---------- GIFs that bend the rules: the same frames as Chromium's own decoder ----------
    // make_edge_fixtures.py writes them (LZW data that stops early, a full code table without a
    // clear code, two GCEs before an image, a GCE of 5 bytes, a stray byte, no trailer, no palette
    // ...). Chromium's ImageDecoder, frame by frame, is the reference: TTGif must show the same
    // frames and stop at the frame it refuses, with ImageDecoder here and with omggif below.
    const edges = fs.readdirSync(fixtures).filter(f => /^edge-.*\.gif$/.test(f)).sort();
    assert.ok(edges.length >= 20, `the edge-*.gif files are there: ${edges.length}`);
    const edgeRef = await page.evaluate(async files => {
      const out = {};
      for (const [name, data] of files) {
        const r = { hashes: [], refusedAt: null, size: null };
        const dec = new ImageDecoder({ data: Uint8Array.from(atob(data), c => c.charCodeAt(0)), type: 'image/gif', colorSpaceConversion: 'none' });
        await dec.tracks.ready;
        await dec.completed.catch(() => {});
        for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
          let vf;
          try { vf = (await dec.decode({ frameIndex: i, completeFramesOnly: true })).image; } catch (e) { r.refusedAt = i; break; }
          const c = new OffscreenCanvas(vf.displayWidth, vf.displayHeight);
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(vf, 0, 0);
          r.size = [vf.displayWidth, vf.displayHeight];
          vf.close();
          const h = new Uint8Array(await crypto.subtle.digest('SHA-256', g.getImageData(0, 0, c.width, c.height).data));
          r.hashes.push([...h.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(''));
        }
        dec.close();
        out[name] = r;
      }
      return out;
    }, edges.map(n => [n, b64(n)]));
    const checkEdges = (got, label) => {
      for (const n of edges) {
        const g = got[n], want = edgeRef[n];
        assert.ok(!g.error, `${label} ${n}: ${g.error}`);
        assert.deepEqual(g.sizes, [], `${label} ${n}: frame objects`);
        assert.deepEqual([g.info.width, g.info.height], want.size, `${label} ${n}: the canvas Chromium shows`);
        assert.deepEqual(g.hashes, want.hashes, `${label} ${n}: the frames Chromium shows`);
        assert.equal(g.damagedAt, want.refusedAt, `${label} ${n}: it stops at the frame Chromium refuses`);
      }
    };
    const edgeId = await engine(page, edges, 'auto');
    checkEdges(edgeId, 'ImageDecoder');
    assert.deepEqual(edges.filter(n => edgeRef[n].refusedAt !== null), ['edge-bad-code-late.gif', 'edge-empty-data.gif', 'edge-mincode9.gif', 'edge-short-lzw.gif', 'edge-short-noeoi.gif'], 'Chromium refuses the frames with damaged LZW data');
    assert.deepEqual(edgeId['edge-two-gce.gif'].info.durations, [100, 200, 100], 'of two GCEs before an image, the second counts');
    assert.deepEqual(edgeId['edge-layers.gif'].info.durations, [100, 100, 100, 100, 100, 100], 'delays of 0 play as 100 ms');
    for (const [n, frames, cut] of [['edge-stray00.gif', 1, true], ['edge-gce5.gif', 1, true], ['edge-notrailer.gif', 2, true], ['edge-trailing.gif', 2, false]]) {
      assert.deepEqual([edgeId[n].info.frameCount, edgeId[n].info.truncated], [frames, cut], `${n}: ${frames} frames, ${cut ? '' : 'not '}cut short`);
    }
    assert.equal(edgeId['edge-netscape-odd.gif'].plays, 1, 'a loop block whose first sub-block is not the loop count: one play');

    // ---------- Default settings: a GIF of odd size with varied frame times ----------
    await addFiles(fx('timing.gif'));
    assert.equal(await text('#g2m-file-error'), '', 'a GIF clears the earlier message');
    assert.equal(await page.getAttribute('#g2m-open', 'aria-describedby'), 'g2m-drop-hint');
    let row = await rowOf('timing.gif');
    assert.equal(row.info, '7.7 KB · 481 × 271 px · 13 frames · 0.88 s · loops forever');
    assert.equal(row.plan, 'MP4: 482 × 272 px (a pixel added for an even size) · 0.88 s');
    assert.equal(row.state, 'Ready to convert');
    assert.deepEqual(row.buttons, ['Remove']);
    assert.equal(await text('#g2m-status'), 'Added timing.gif: 481 × 271 pixels, 13 frames, 0.88 seconds.');
    assert.equal(await text('#g2m-summary'), '1 GIF, 7.7 KB');
    assert.ok(await page.isEnabled('#g2m-convert'));
    await page.waitForFunction(() => document.querySelector('.g2m-thumb').width === 481, null, { timeout: 10000 });
    await convert();
    assert.equal(await text('#g2m-error'), '');
    row = await rowOf('timing.gif');
    assert.equal(row.state, 'Converted');
    assert.deepEqual(row.buttons, ['Download MP4', 'Copy HTML', 'Remove'], 'no Share button where files cannot be shared');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Download MP4', 'focus moves to Download MP4');
    assert.match(await text('#g2m-status'), /^timing\.mp4 is ready: [\d.]+ KB, 0\.88 seconds\.$/);
    const t1 = await download('timing.gif');
    assert.equal(t1.name, 'timing.mp4');
    const timingMs = exp['timing.gif'].durations;
    assert.deepEqual(timingMs, [100, 100, 50, 20, 100, 100, 70, 30, 40, 100, 50, 20, 100], 'delays 1 and 0 hundredths play as 100 ms');
    const mt = checkMp4(t1.buf, { width: 482, height: 272, ms: timingMs, label: 'timing' });
    assert.equal(mt.tracks[0].profile, 100, 'H.264 High profile');
    const kb = n => (n / 1000).toFixed(n < 1e4 ? 1 : 0) + ' KB';
    assert.equal(row.result, `${kb(t1.buf.length)} (${t1.buf.length.toLocaleString('en-GB')} bytes) · ${Math.round((1 - t1.buf.length / read('timing.gif').length) * 100)}% smaller than the GIF · 482 × 272 px · 0.88 s · 13 frames`);
    assert.equal(row.code, '<video src="timing.mp4" width="482" height="272" autoplay loop muted playsinline></video>');
    const v1 = verify('timing.gif', t1.buf, { bg: '#ffffff', factor: 1, odd: 'pad' });
    if (v1) {
      const s = v1.streams;
      assert.equal(s.length, 1, 'ffprobe: one stream');
      assert.deepEqual([s[0].codec_name, s[0].profile, s[0].width, s[0].height, s[0].pix_fmt], ['h264', 'High', 482, 272, 'yuvj420p']);
      assert.deepEqual([s[0].color_range, s[0].color_space, s[0].color_primaries, s[0].color_transfer], ['pc', 'bt709', 'bt709', 'iec61966-2-1'], 'colour tags: full range, BT.709, sRGB transfer');
      assert.equal(Number(s[0].nb_frames), 13);
      assert.equal(Number(v1.format.duration), 0.88);
      let at = 0;
      assert.deepEqual(v1.packets.map(p => [Math.round(p[0] * 1000), Math.round(p[1] * 1000)]), timingMs.map(d => { const r = [at, d]; at += d; return r; }), 'ffprobe: each frame at its time, for its time');
      assert.equal(v1.decodedFrames, 13);
      assert.ok(v1.psnrMin >= 32, `ffmpeg's frames against ImageMagick's: ${v1.psnrMin} dB at least`);
    }
    const pb1 = await playBack(t1.buf);
    assert.deepEqual([pb1.w, pb1.h, pb1.duration, pb1.error], [482, 272, 0.88, undefined], 'Chromium plays it');
    assert.ok(pb1.frames > 0, 'Chromium shows frames');
    // Copy HTML puts the snippet on the clipboard.
    await page.locator(`#${row.id} button`, { hasText: 'Copy HTML' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), row.code);
    // A double click on Download saves one file.
    let downloads = 0;
    const countDl = () => downloads++;
    page.on('download', countDl);
    await page.waitForTimeout(1600);
    await page.locator(`#${row.id} button`, { hasText: 'Download MP4' }).dblclick();
    await page.waitForTimeout(1200);
    page.off('download', countDl);
    assert.equal(downloads, 1, 'a double click on Download MP4 saves one file');

    // ---------- A changed setting clears the result; Back restores menus ----------
    await page.selectOption('#g2m-quality', 'medium');
    row = await rowOf('timing.gif');
    assert.deepEqual([row.state, row.result, row.buttons], ['Ready to convert', null, ['Remove']], 'a result made with other settings is not offered');
    assert.equal(await text('#g2m-status'), 'The settings changed, so the MP4 was cleared. Press Convert to MP4 to make it again.');
    await page.selectOption('#g2m-quality', 'high');
    // The browser can restore a menu after the script ran: pageshow reads it again.
    await page.$eval('#g2m-odd', el => { el.value = 'crop'; });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal((await rowOf('timing.gif')).plan, 'MP4: 480 × 270 px (a pixel removed for an even size) · 0.88 s');

    // ---------- Odd sizes: a pixel removed ----------
    await convert();
    const t2 = await download('timing.gif');
    checkMp4(t2.buf, { width: 480, height: 270, ms: timingMs, label: 'timing, cropped' });
    const v2 = verify('timing.gif', t2.buf, { bg: '#ffffff', factor: 1, odd: 'crop' });
    if (v2) assert.ok(v2.psnrMin >= 32, `cropped: ${v2.psnrMin} dB`);
    await page.selectOption('#g2m-odd', 'pad');

    // ---------- Background: the hex field, its errors, and pixel art enlarged 4 times ----------
    await page.click('#g2m-clear');
    assert.ok(await page.isHidden('#g2m-list'));
    assert.equal(await text('#g2m-status'), 'All GIFs removed.');
    await addFiles(fx('pixel-art.gif'));
    const bgState = async () => ({
      invalid: await page.getAttribute('#g2m-bg-hex', 'aria-invalid'),
      describedby: await page.getAttribute('#g2m-bg-hex', 'aria-describedby'),
      error: await text('#g2m-bg-error'),
      picker: await page.inputValue('#g2m-bg'),
    });
    const badHex = 'Background: enter a colour as # and 3 or 6 hex digits, such as #FFF or #1E1E1E.';
    for (const typed of ['#12', 'white', '#12345g', '1e1e1e1', '#', '', '#1e 1e1e']) {
      await page.fill('#g2m-bg-hex', typed);
      assert.deepEqual(await bgState(), { invalid: 'true', describedby: 'g2m-bg-error g2m-bg-hint', error: badHex, picker: '#ffffff' }, `background "${typed}" is refused`);
    }
    // Convert goes to the field instead, and nothing starts.
    await page.click('#g2m-convert');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'g2m-bg-hex');
    assert.ok(await page.isHidden('#g2m-progress'));
    for (const [typed, want] of [['#1e1e1e', '#1e1e1e'], ['FFF', '#ffffff'], ['＃１Ｅ１Ｅ１Ｅ', '#1e1e1e'], ['  #abc  ', '#aabbcc']]) {
      await page.fill('#g2m-bg-hex', typed);
      assert.deepEqual(await bgState(), { invalid: null, describedby: 'g2m-bg-hint', error: '', picker: want }, `background "${typed}" is read as ${want}`);
    }
    await page.locator('#g2m-bg-hex').blur();
    assert.equal(await page.inputValue('#g2m-bg-hex'), '#AABBCC', 'a valid colour is tidied when the field is left');
    // The colour picker writes the hex field.
    await page.$eval('#g2m-bg', el => { el.value = '#1e1e1e'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.inputValue('#g2m-bg-hex'), '#1E1E1E');
    await page.selectOption('#g2m-size', '2');
    assert.equal((await rowOf('pixel-art.gif')).plan, 'MP4: 48 × 32 px (enlarged 2×) · 0.60 s');
    await page.selectOption('#g2m-size', '4');
    assert.equal((await rowOf('pixel-art.gif')).plan, 'MP4: 96 × 64 px (enlarged 4×) · 0.60 s');
    await convert();
    const px = await download('pixel-art.gif');
    checkMp4(px.buf, { width: 96, height: 64, ms: [150, 150, 150, 150], label: 'pixel art 4x' });
    const vpx = verify('pixel-art.gif', px.buf, { bg: '#1e1e1e', factor: 4, odd: 'pad' });
    if (vpx) assert.ok(vpx.psnrMin >= 28, `pixel art 4x on #1E1E1E: ${vpx.psnrMin} dB`);
    // The transparent background shows the chosen colour (decoded by Chromium), and each GIF pixel
    // is a 4 x 4 block of one colour.
    const look = await page.evaluate(async b => {
      const v = document.createElement('video');
      v.muted = true;
      document.body.appendChild(v);
      v.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], { type: 'video/mp4' }));
      await new Promise(ok => { v.onloadeddata = ok; });
      await new Promise(ok => { v.onseeked = ok; v.currentTime = 0.05; });
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 64;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0);
      const at = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
      const r = { corner: at(2, 2), skin: at(4 * 7 + 1, 4 * 3 + 1), skin2: at(4 * 7 + 2, 4 * 3 + 2) };
      v.remove();
      return r;
    }, px.buf.toString('base64'));
    assert.ok(look.corner.every(v => Math.abs(v - 30) <= 6), `the background is #1E1E1E: ${look.corner}`);
    assert.ok(look.skin.every((v, i) => Math.abs(v - [255, 214, 170][i]) <= 12), `a skin-coloured pixel stays that colour: ${look.skin}`);
    await page.selectOption('#g2m-size', '1');
    await page.fill('#g2m-bg-hex', '#ffffff');

    // ---------- Plays: loops built in by repeating the encoded frames ----------
    await page.click('#g2m-clear');
    await addFiles([fx('loop3.gif'), fx('still.gif')]);
    assert.match((await rowOf('loop3.gif')).info, / · 2 frames · 0\.50 s · plays 4 times$/, 'a loop count of 3 is 4 plays');
    assert.match((await rowOf('still.gif')).info, / · 1 frame · 0\.10 s · plays once$/);
    await page.selectOption('#g2m-plays', '3');
    assert.equal((await rowOf('loop3.gif')).plan, 'MP4: 40 × 20 px (enlarged 2×, as videos need at least 16 pixels each way) · 1.50 s (3 plays)');
    assert.equal((await rowOf('still.gif')).plan, 'MP4: 30 × 20 px · 0.30 s (3 plays)');
    await convert();
    const l3 = await download('loop3.gif');
    const m3 = checkMp4(l3.buf, { width: 40, height: 20, ms: [250, 250, 250, 250, 250, 250], label: 'loop3 3 plays' });
    const s3 = m3.tracks[0].samples;
    assert.deepEqual([s3[2], s3[3], s3[4], s3[5]], [s3[0], s3[1], s3[0], s3[1]], 'plays 2 and 3 repeat the first play byte for byte');
    assert.notEqual(s3[0], s3[1]);
    assert.match((await rowOf('loop3.gif')).result, / · 40 × 20 px · 1\.50 s · 6 frames · 3 plays$/);
    checkMp4((await download('still.gif')).buf, { width: 30, height: 20, ms: [300], label: 'still 3 plays: one frame of 0.3 s' });
    // A still GIF with "5 s or more": one frame that lasts 5 s.
    await page.selectOption('#g2m-plays', 's5');
    assert.equal((await rowOf('still.gif')).plan, 'MP4: 30 × 20 px · 5.00 s (50 plays)');
    assert.equal((await rowOf('loop3.gif')).plan, 'MP4: 40 × 20 px (enlarged 2×, as videos need at least 16 pixels each way) · 5.00 s (10 plays)');
    await convert();
    const st = await download('still.gif');
    checkMp4(st.buf, { width: 30, height: 20, ms: [5000], label: 'still 5 s' });
    assert.match((await rowOf('still.gif')).result, / · 30 × 20 px · 5\.00 s · 1 frame · 50 plays$/);
    const pbs = await playBack(st.buf);
    assert.deepEqual([pbs.w, pbs.h, pbs.duration], [30, 20, 5]);
    await page.selectOption('#g2m-plays', '1');

    // ---------- Quality: Best, High and Medium ----------
    await page.click('#g2m-clear');
    await addFiles(fx('real.gif'));
    const real = {};
    for (const q of ['best', 'high', 'medium']) {
      await page.selectOption('#g2m-quality', q);
      await convert();
      real[q] = (await download('real.gif')).buf;
      checkMp4(real[q], { width: 240, height: 136, ms: exp['real.gif'].durations, label: 'real ' + q });
    }
    assert.ok(real.best.length > real.high.length && real.high.length > real.medium.length, `sizes: ${real.best.length} > ${real.high.length} > ${real.medium.length}`);
    assert.ok(real.high.length < read('real.gif').length / 3, 'High is under a third of the GIF');
    if (tools) {
      const q = Object.fromEntries(['best', 'high', 'medium'].map(k => [k, verify('real.gif', real[k], { bg: '#ffffff', factor: 1 })]));
      assert.ok(q.best.psnrMean > q.high.psnrMean && q.high.psnrMean > q.medium.psnrMean, `PSNR ${q.best.psnrMean} > ${q.high.psnrMean} > ${q.medium.psnrMean}`);
      assert.ok(q.high.psnrMin >= 24 && q.medium.psnrMin >= 23, `dithered GIF: ${q.high.psnrMin} and ${q.medium.psnrMin} dB`);
    }
    await page.selectOption('#g2m-quality', 'high');

    // ---------- Many GIFs at once, the unusual ones, and a ZIP ----------
    await page.click('#g2m-clear');
    const batch = ['unusual.gif', 'gif87a.gif', 'oversized.gif', 'browser-rules.gif', 'cut-off.gif', 'damaged.gif', 'real.gif'];
    await addFiles([...batch.map(fx), { name: 'real.GIF', mimeType: 'image/gif', buffer: read('real.gif') }, { name: 'walk.png', mimeType: 'image/png', buffer: read('pixel-art.gif') }]);
    assert.equal(await text('#g2m-status'), 'Added 9 GIFs.');
    assert.equal(await text('#g2m-file-error'), '', 'a GIF named .png is read as the GIF it is');
    assert.equal((await rowOf('cut-off.gif')).note, 'The file is cut off in frame 4: the 3 whole frames before it are used.');
    assert.equal((await rowOf('oversized.gif')).info, '791 bytes · 72 × 54 px · 3 frames · 0.30 s · loops forever', 'the canvas grows to an oversized first frame');
    await convert();
    assert.equal(await text('#g2m-status'), '9 of 9 GIFs converted. Download them one by one or all as a ZIP.');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'g2m-zip', 'focus moves to Download all');
    const dmg = await rowOf('damaged.gif');
    assert.equal(dmg.note, 'Frame 2 is damaged, so the MP4 ends before it (1 frame).');
    const single = {};
    for (const n of [...batch, 'real.GIF', 'walk.png']) {
      await page.waitForTimeout(50);
      single[n] = await download(n);
    }
    assert.deepEqual(Object.values(single).map(x => x.name), ['unusual.mp4', 'gif87a.mp4', 'oversized.mp4', 'browser-rules.mp4', 'cut-off.mp4', 'damaged.mp4', 'real.mp4', 'real.mp4', 'walk.mp4']);
    const even = n => n + (n % 2);
    for (const n of batch) {
      const e = exp[n], frames = e.damagedAt == null ? e.durations : e.durations.slice(0, e.damagedAt);
      checkMp4(single[n].buf, { width: even(e.width), height: even(e.height), ms: frames, label: n });
      // At the GIF's own size, 4:2:0 colour (one colour sample for 2 x 2 pixels) smears fine
      // checkerboards of strong colours, which these files have on purpose: a loose check here,
      // and every frame checked closely at 2x below.
      if (e.checkedWithImageMagick) {
        const v = verify(n, single[n].buf, { bg: '#ffffff', factor: 1 });
        if (v) assert.ok(v.psnrMean >= 20 && v.decodedFrames === frames.length, `${n}: ${v.decodedFrames} frames, ${v.psnrMean} dB on average`);
      }
    }
    // The ZIP holds the same files, stored, under names that do not clash.
    await page.waitForTimeout(1600);
    const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('#g2m-zip')]);
    assert.equal(zdl.suggestedFilename(), 'gif-to-mp4.zip');
    const zip = parseZip(fs.readFileSync(await zdl.path()));
    assert.deepEqual(zip.map(z => z.name), ['unusual.mp4', 'gif87a.mp4', 'oversized.mp4', 'browser-rules.mp4', 'cut-off.mp4', 'damaged.mp4', 'real.mp4', 'real (2).mp4', 'walk.mp4']);
    assert.ok(zip.every(z => z.method === 0), 'MP4s are stored, not compressed again');
    zip.forEach((z, i) => {
      assert.ok(z.data.equals(Object.values(single)[i].buf), `${z.name}: the same bytes as its own download`);
      if (crc32(z.data) !== null) assert.equal(z.crc >>> 0, crc32(z.data) >>> 0, `${z.name}: CRC`);
    });
    assert.match(await text('#g2m-status'), /^Downloading gif-to-mp4\.zip: 9 MP4s, [\d.]+ KB\.$/);
    // A setting changed while the ZIP is being made clears the MP4s in it: that ZIP is not saved.
    await page.evaluate(() => {
      const real = TTZip.create;
      window.zipGate = new Promise(r => { window.openZipGate = r; });
      TTZip.create = async (...a) => { await window.zipGate; return real(...a); };
    });
    let zips = 0;
    const countZip = () => zips++;
    page.on('download', countZip);
    await page.waitForTimeout(1600);
    await page.click('#g2m-zip');
    await page.waitForFunction(() => document.querySelector('#g2m-zip').getAttribute('aria-busy') === 'true');
    await page.selectOption('#g2m-quality', 'medium');
    await page.evaluate(() => window.openZipGate());
    await page.waitForFunction(() => !document.querySelector('#g2m-zip').hasAttribute('aria-busy'));
    await page.waitForTimeout(500);
    page.off('download', countZip);
    assert.equal(zips, 0, 'a ZIP of MP4s that a changed setting cleared is not saved');
    assert.equal(await text('#g2m-status'), 'The settings changed, so the 9 MP4s were cleared. Press Convert to MP4 to make them again.');
    await page.selectOption('#g2m-quality', 'high');

    // Enlarged 2x, each GIF pixel has a colour sample of its own: at Best, every frame of the
    // unusual GIFs (disposal, interlacing, local palettes, frames past the edge, Plain Text
    // Extensions...) must come out close to the expected frame: ImageMagick's, through ffmpeg,
    // where ImageMagick shows GIFs as browsers do, and the page's own frames (whose hashes match
    // the model above) through Chromium's decoder for the others.
    await page.click('#g2m-clear');
    await page.selectOption('#g2m-size', '2');
    await page.selectOption('#g2m-quality', 'best');
    const detail = ['unusual.gif', 'gif87a.gif', 'real.gif', 'oversized.gif', 'browser-rules.gif', 'damaged.gif', 'cut-off.gif'];
    await addFiles(detail.map(fx));
    await convert();
    const x2 = {};
    for (const n of detail) {
      const e = exp[n], frames = e.damagedAt == null ? e.durations : e.durations.slice(0, e.damagedAt);
      x2[n] = (await download(n)).buf;
      checkMp4(x2[n], { width: 2 * e.width, height: 2 * e.height, ms: frames, label: n + ' at 2x' });
      if (e.checkedWithImageMagick && tools) {
        const v = verify(n, x2[n], { bg: '#ffffff', factor: 2 });
        assert.ok(v.psnrMin >= 30 && v.decodedFrames === e.frameCount, `${n} at 2x: ${v.decodedFrames} frames, ${v.psnrMin} dB at least`);
      }
    }
    const close = await page.evaluate(async files => {
      const out = {};
      for (const [name, gif, mp4] of files) {
        const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
        const rd = await TTGif.open(new Blob([bytes(gif)]));
        const W = 2 * rd.info.width, H = 2 * rd.info.height;
        const want = [];
        try {
          for await (const f of rd.frames()) {
            const a = new Uint8ClampedArray(W * H * 4).fill(255);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              const s = ((y >> 1) * f.width + (x >> 1)) * 4, d = (y * W + x) * 4;
              if (f.data[s + 3]) { a[d] = f.data[s]; a[d + 1] = f.data[s + 1]; a[d + 2] = f.data[s + 2]; }
            }
            want.push(a);
          }
        } catch (e) {
          if (e.code !== 'DAMAGED') throw e; // the frames before a damaged one
        }
        rd.close();
        const input = new Mediabunny.Input({ source: new Mediabunny.BlobSource(new Blob([bytes(mp4)])), formats: Mediabunny.ALL_FORMATS });
        const sink = new Mediabunny.CanvasSink(await input.getPrimaryVideoTrack());
        const psnr = (a, b) => {
          let se = 0;
          for (let k = 0; k < a.length; k += 4) for (let c = 0; c < 3; c++) se += (a[k + c] - b[k + c]) ** 2;
          return se ? 10 * Math.log10(255 * 255 / (se / (W * H * 3))) : 99;
        };
        const ps = [], nearest = [];
        let i = 0;
        for await (const { canvas } of sink.canvases()) {
          const got = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
          const all = want.map(w => psnr(got, w));
          ps.push(Math.round(all[i] * 10) / 10);
          // Closest to its own frame (or to one that looks the same), not to another.
          nearest.push(all[i] >= Math.max(...all) - 0.01);
          i++;
        }
        out[name] = { ps, nearest, want: want.length };
      }
      return out;
    }, detail.map(n => [n, b64(n), x2[n].toString('base64')]));
    for (const [n, r] of Object.entries(close)) {
      const e = exp[n];
      assert.equal(r.ps.length, e.damagedAt == null ? e.frameCount : e.damagedAt, `${n}: frames in the MP4`);
      assert.equal(r.want, r.ps.length, `${n}: as many as the page reads`);
      // cut-off.gif and damaged.gif are random pixels, which no video codec keeps closely.
      const floor = /^(cut-off|damaged)\.gif$/.test(n) ? 15 : 25;
      assert.ok(Math.min(...r.ps) >= floor, `${n} at 2x: Chromium's frames of the MP4 against the page's: ${r.ps}`);
      assert.ok(r.nearest.every(Boolean), `${n} at 2x: each frame is closest to its own: ${r.nearest}`);
    }
    await page.selectOption('#g2m-size', '1');
    await page.selectOption('#g2m-quality', 'high');

    // ---------- Larger than the browser's H.264 encoder takes ----------
    await page.click('#g2m-clear');
    const wide = Buffer.from(read('still.gif'));
    wide.writeUInt16LE(5000, 6);
    wide.writeUInt16LE(5000, 8);
    await addFiles({ name: 'wide.gif', mimeType: 'image/gif', buffer: wide });
    assert.equal((await rowOf('wide.gif')).plan, 'MP4: 5000 × 5000 px · 0.10 s');
    await convert();
    row = await rowOf('wide.gif');
    assert.deepEqual([row.state, row.msg], ['Not converted', 'This browser’s H.264 encoder does not take a video of 5000 × 5000 pixels.']);
    assert.equal(await text('#g2m-status'), 'wide.gif: This browser’s H.264 encoder does not take a video of 5000 × 5000 pixels.');

    // ---------- A GIF whose first frame is damaged ----------
    await page.click('#g2m-clear');
    // still.gif with the first sub-block of its only frame's pixel data overwritten.
    const broken = Buffer.from(read('still.gif'));
    const sub = 13 + 12 + 10 + 1; // header, 4-colour palette, image descriptor, LZW code size
    assert.equal(broken[13 + 12], 0x2c, 'still.gif: the image descriptor follows the palette');
    broken.fill(0xff, sub + 1, sub + 1 + broken[sub]);
    await addFiles({ name: 'broken.gif', mimeType: 'image/gif', buffer: broken });
    await convert();
    row = await rowOf('broken.gif');
    assert.deepEqual([row.state, row.msg, row.result], ['Not converted', 'Its first frame is damaged, so nothing could be converted.', null]);
    assert.equal(await text('#g2m-status'), 'broken.gif: Its first frame is damaged, so nothing could be converted.');
    assert.ok(await page.isEnabled('#g2m-convert'), 'it can be tried again');

    // ---------- Cancel ----------
    await page.click('#g2m-clear');
    const long = makeGif({ w: 320, h: 180, frames: 400, delay: 4 });
    await addFiles({ name: 'long.gif', mimeType: 'image/gif', buffer: long });
    await page.click('#g2m-convert');
    await page.waitForFunction(() => /frame (\d+) of/.test(document.querySelector('#g2m-progress-text').textContent));
    // GIFs dropped or pasted while a job runs are not added; a message that can be seen (not only
    // one for screen readers) says so, and it goes when the job ends.
    const busyAdd = 'Wait until converting ends, then add the GIFs again.';
    await page.evaluate(b => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'dropped.gif', { type: 'image/gif' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64('still.gif'));
    assert.equal(await text('#g2m-file-error'), busyAdd, 'a GIF dropped during a job: the visible message says why it was not added');
    assert.ok(await page.isVisible('#g2m-file-error'));
    await page.evaluate(() => { document.querySelector('#g2m-file-error').textContent = ''; });
    const pasted = await page.evaluate(b => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'pasted.gif', { type: 'image/gif' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, b64('still.gif'));
    assert.equal(await text('#g2m-file-error'), busyAdd, 'a GIF pasted during a job: the same message');
    assert.ok(pasted, 'the paste is taken by the page');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.g2m-file').length), 1, 'nothing is added during a job');
    await page.click('#g2m-cancel');
    await page.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 30000 });
    assert.equal(await text('#g2m-file-error'), '', 'the message goes when the job ends');
    row = await rowOf('long.gif');
    assert.deepEqual([row.state, row.result, row.msg], ['Ready to convert', null, '']);
    assert.equal(await text('#g2m-status'), 'Converting was cancelled.');
    assert.equal(await text('#g2m-error'), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'g2m-convert', 'focus goes back to Convert to MP4');
    await page.waitForTimeout(300);
    assert.deepEqual([(await rowOf('long.gif')).state, await page.isHidden('#g2m-progress')], ['Ready to convert', true], 'nothing of the cancelled job shows up afterwards');
    // A double click on Convert starts one job, which then finishes.
    await page.dblclick('#g2m-convert');
    await page.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 120000 });
    assert.match((await rowOf('long.gif')).result, / · 320 × 180 px · 16\.00 s · 400 frames$/);
    assert.match(await text('#g2m-status'), /^long\.mp4 is ready: [\d.]+ (KB|MB), 16 seconds\.$/);

    // ---------- An hour-long GIF, and one of several GB ----------
    await page.click('#g2m-clear');
    const hour = makeGif({ w: 32, h: 18, frames: 1200, delay: 300 });
    await addFiles({ name: 'hour.gif', mimeType: 'image/gif', buffer: hour });
    assert.match((await rowOf('hour.gif')).info, / · 32 × 18 px · 1,200 frames · 1 h 0 min 0\.00 s · loops forever$/);
    await convert();
    const hr = await download('hour.gif');
    checkMp4(hr.buf, { width: 32, height: 18, ms: new Array(1200).fill(3000), label: 'an hour' });
    const pbh = await playBack(hr.buf);
    assert.deepEqual([pbh.w, pbh.h, pbh.duration], [32, 18, 3600]);
    // 3 GiB of comment, then three frames, dropped on the page as one File made of a repeated
    // 1 MiB Blob. The page reads it in slices (the omggif worker, as ImageDecoder would hold the
    // whole file in memory) and must stay small.
    await page.click('#g2m-clear');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const cpuMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
    const heapMB = async () => (await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6;
    const tiny = makeGif({ w: 40, h: 30, frames: 3, delay: 50 });
    const cpu0 = await cpuMs();
    await page.evaluate(({ gif, cut, n }) => {
      const bytes = Uint8Array.from(atob(gif), c => c.charCodeAt(0));
      const part = new Uint8Array(1 << 20);
      for (let i = 0; i < part.length; i += 256) part[i] = 255; // sub-blocks of 255 bytes
      const blob = new Blob([bytes.slice(0, cut), new Uint8Array([0x21, 0xfe]), ...new Array(n).fill(new Blob([part])), new Uint8Array([0]), bytes.slice(cut)]);
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'huge.gif', { type: 'image/gif' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { gif: tiny.toString('base64'), cut: tiny.indexOf(Buffer.from([0x21, 0xf9])), n: 3072 });
    await page.waitForFunction(() => document.querySelectorAll('.g2m-file').length || document.querySelector('#g2m-file-error').textContent, null, { timeout: 120000 });
    assert.equal((await rowOf('huge.gif')).info, '3.22 GB · 40 × 30 px · 3 frames · 1.50 s · loops forever');
    const scanCpu = await cpuMs() - cpu0;
    assert.ok(scanCpu < 20000, `reading 3.2 GB took ${Math.round(scanCpu)} ms of main-thread CPU`);
    await convert();
    const hg = await download('huge.gif');
    checkMp4(hg.buf, { width: 40, height: 30, ms: [500, 500, 500], label: 'huge' });
    assert.match((await rowOf('huge.gif')).result, /^([\d,]+ bytes|[\d.]+ KB \([\d,]+ bytes\)) · under 1% of the GIF’s size · 40 × 30 px · 1\.50 s · 3 frames$/);
    assert.ok(await heapMB() < 100, `the page's heap after a 3.2 GB GIF: ${Math.round(await heapMB())} MB`);
    await cdp.detach();

    // ---------- Keyboard only ----------
    await open();
    const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement.id === 'g2m-open');
    }
    assert.ok(reached, 'Tab reaches Choose GIFs');
    assert.ok(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), 'with a visible focus ring');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(fx('timing.gif'));
    await page.waitForFunction(() => document.querySelectorAll('.g2m-file').length === 1);
    reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement.id === 'g2m-quality');
    }
    assert.ok(reached, 'Tab reaches Quality');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#g2m-quality'), 'best', 'the arrow keys choose a quality');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'g2m-convert', 'Convert to MP4 comes next');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement && document.activeElement.textContent === 'Download MP4', null, { timeout: 60000 });
    const [kdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    assert.equal(kdl.suggestedFilename(), 'timing.mp4');
    const kbuf = fs.readFileSync(await kdl.path());
    checkMp4(kbuf, { width: 482, height: 272, ms: timingMs, label: 'keyboard' });

    // ---------- Without ImageDecoder (Safari before 27.3): omggif in a worker ----------
    const noId = await browser.newContext({ acceptDownloads: true });
    await noId.addInitScript(() => { delete window.ImageDecoder; });
    const np = await noId.newPage();
    const nProblems = [];
    np.on('pageerror', e => nProblems.push(e.message));
    np.on('console', m => { if (m.type() === 'error') nProblems.push(m.text()); });
    const nReq = [];
    np.on('request', r => nReq.push(r.url()));
    await np.goto(url);
    await addFiles(fx('timing.gif'), np);
    const withOmg = await engine(np, names, 'auto');
    checkEngine(withOmg, 'omggif');
    assert.ok(names.every(n => withOmg[n].started === 'omggif'));
    const edgeOmg = await engine(np, edges, 'auto');
    checkEdges(edgeOmg, 'omggif');
    assert.ok(edges.every(n => edgeOmg[n].started === 'omggif'));
    assert.ok(nReq.some(u => u.endsWith('/assets/vendor/omggif/omggif.js')), 'omggif is loaded from this site');
    await addFiles([fx('real.gif'), fx('unusual.gif')], np);
    await convert(np);
    for (const [n, idBuf] of [['timing.gif', t1.buf], ['real.gif', real.high], ['unusual.gif', single['unusual.gif'].buf]]) {
      const b = (await download(n, np)).buf;
      assert.deepEqual(parseMp4(b).tracks[0].samples, parseMp4(idBuf).tracks[0].samples, `${n}: the same encoded frames as with ImageDecoder`);
    }
    // A worker that cannot load omggif ends with a message, not a hang.
    await np.route('**/omggif.js', r => r.abort());
    await np.click('#g2m-clear');
    await np.goto(url);
    await addFiles({ name: 'x.gif', mimeType: 'image/gif', buffer: read('pixel-art.gif') }, np);
    await convert(np);
    assert.equal((await rowOf('x.gif', np)).msg, 'The GIF decoder could not be loaded. Check your connection and try again.');
    await np.unroute('**/omggif.js');
    // omggif that never arrives (a stalled connection): Cancel still ends the job.
    await np.route('**/omggif.js', () => {});
    await np.goto(url);
    await addFiles({ name: 'y.gif', mimeType: 'image/gif', buffer: read('pixel-art.gif') }, np);
    await np.click('#g2m-convert');
    await np.waitForFunction(() => !document.querySelector('#g2m-cancel').hidden);
    await np.waitForTimeout(500);
    await np.click('#g2m-cancel');
    await np.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 15000 }).catch(() => {});
    assert.ok(await np.isHidden('#g2m-cancel'), 'Cancel ends a job whose GIF decoder never arrives');
    assert.deepEqual([await text('#g2m-status', np), (await rowOf('y.gif', np)).state], ['Converting was cancelled.', 'Ready to convert']);
    // The same in TTGif itself, for the pages that use it: an abort ends the wait for omggif.
    const aborted = await np.evaluate(async b => {
      const rd = await TTGif.open(new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))]), { decoder: 'omggif' });
      const ac = new AbortController();
      const next = rd.frames({ signal: ac.signal }).next().then(() => 'a frame', e => e.name);
      setTimeout(() => ac.abort(), 300);
      const r = await Promise.race([next, new Promise(ok => setTimeout(() => ok('still waiting'), 5000))]);
      rd.close();
      return r;
    }, b64('pixel-art.gif'));
    assert.equal(aborted, 'AbortError', 'TTGif: an abort ends the wait for omggif to load');
    await np.unrouteAll({ behavior: 'ignoreErrors' });
    await noId.close();
    assert.deepEqual(nProblems.filter(m => !/omggif/.test(m)), [], 'no errors without ImageDecoder');

    // ---------- Code that cannot be loaded ----------
    const offline = await browser.newContext();
    const op = await offline.newPage();
    await op.goto(url);
    await op.route('**/assets/js/gif-frames.js', r => r.abort());
    await op.setInputFiles('#g2m-file', { name: 'real.gif', mimeType: 'image/gif', buffer: read('real.gif') });
    await op.waitForFunction(() => document.querySelector('#g2m-file-error').textContent);
    assert.equal(await text('#g2m-file-error', op), 'The GIF reader could not be loaded. Check your connection and choose the GIFs again.');
    assert.ok(await op.isHidden('#g2m-list'));
    await op.unroute('**/assets/js/gif-frames.js');
    await op.route('**/assets/vendor/mediabunny/mediabunny.min.js', r => r.abort());
    await addFiles(fx('real.gif'), op);
    assert.equal(await text('#g2m-file-error', op), '', 'choosing again works');
    await convert(op);
    assert.equal(await text('#g2m-error', op), 'The video encoder could not be loaded. Check your connection and try again.');
    assert.equal((await rowOf('real.gif', op)).state, 'Ready to convert');
    await op.unroute('**/assets/vendor/mediabunny/mediabunny.min.js');
    await convert(op);
    assert.equal(await text('#g2m-error', op), '', 'trying again works');
    assert.equal((await rowOf('real.gif', op)).state, 'Converted');
    await offline.close();

    // ---------- Without WebCodecs (Firefox for Android) ----------
    const noWc = await browser.newContext();
    await noWc.addInitScript(() => {
      for (const k of ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder', 'VideoFrame', 'AudioData', 'EncodedVideoChunk', 'EncodedAudioChunk']) delete window[k];
    });
    const wp = await noWc.newPage();
    await wp.goto(url);
    await addFiles(fx('real.gif'), wp);
    assert.equal((await rowOf('real.gif', wp)).state, 'Ready to convert', 'GIFs are still read');
    await wp.click('#g2m-convert');
    assert.equal(await text('#g2m-error', wp), 'This browser cannot make MP4 videos: it has no video encoder for web pages (WebCodecs), as in Firefox for Android. Use Chrome, Edge or Samsung Internet, Firefox 130 or later on a computer, or Safari 16.4 or later.');
    assert.equal(await wp.getAttribute('#g2m-error', 'role'), 'alert');
    assert.ok(await wp.isHidden('#g2m-progress'), 'nothing starts');
    assert.equal((await rowOf('real.gif', wp)).state, 'Ready to convert');
    await noWc.close();

    // ---------- A page in the background carries on ----------
    // A hidden tab runs no animation frames and its timers are slowed; the job needs neither, and
    // its check for a stalled job counts only time in front.
    const bgCtx = await browser.newContext({ acceptDownloads: true });
    const bp = await bgCtx.newPage();
    await bp.clock.install();
    await bp.addInitScript(() => {
      let hidden = false;
      window.setHidden = on => {
        hidden = on;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      };
    });
    await bp.goto(url);
    await addFiles({ name: 'long.gif', mimeType: 'image/gif', buffer: long }, bp);
    await bp.click('#g2m-convert');
    await bp.waitForFunction(() => /frame (\d+) of/.test(document.querySelector('#g2m-progress-text').textContent));
    await bp.evaluate(() => window.setHidden(true));
    await bp.clock.fastForward(90000);
    await bp.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 120000 });
    assert.equal(await text('#g2m-error', bp), '');
    assert.match((await rowOf('long.gif', bp)).result, / · 400 frames$/, 'the job finished in the background');
    await bgCtx.close();

    // ---------- An encoder that stops answering ----------
    // A hardware encoder can stop giving frames back without an error. After a minute in front
    // with nothing, the job ends with a message instead of waiting for ever.
    const stuckCtx = await browser.newContext();
    const stuck = await stuckCtx.newPage();
    await stuck.clock.install();
    await stuck.addInitScript(() => {
      VideoEncoder.prototype.encode = function () {};
      VideoEncoder.prototype.flush = function () { return new Promise(() => {}); };
    });
    await stuck.goto(url);
    await addFiles(fx('timing.gif'), stuck);
    await stuck.click('#g2m-convert');
    await stuck.waitForFunction(() => /frame 13 of 13/.test(document.querySelector('#g2m-progress-text').textContent));
    await stuck.clock.fastForward(70000);
    await stuck.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 15000 }).catch(() => {});
    assert.ok(await stuck.isHidden('#g2m-cancel'), 'a job whose encoder stops answering ends after a minute');
    row = await rowOf('timing.gif', stuck);
    assert.deepEqual([row.state, row.msg, await text('#g2m-status', stuck)],
      ['Not converted', 'Converting stopped: no frame came for a minute. Try again, or try another browser.', 'Converting stopped responding. See the message under the GIF.']);
    await stuckCtx.close();

    // ---------- A slow connection: the video encoder takes over a minute to load ----------
    // Only a job that gets no frame for a minute has stopped; time spent loading the encoder's
    // code (which has its own error when it fails) does not count.
    const slowCtx = await browser.newContext({ acceptDownloads: true });
    const slow = await slowCtx.newPage();
    await slow.clock.install();
    let letLoad;
    const held = new Promise(r => { letLoad = r; });
    await slow.route('**/assets/vendor/mediabunny/mediabunny.min.js', async r => { await held; await r.continue(); });
    await slow.goto(url);
    await addFiles(fx('loop3.gif'), slow);
    // Cancel works while the code is still on its way.
    await slow.click('#g2m-convert');
    await slow.waitForFunction(() => document.querySelector('#g2m-progress-text').textContent === 'Loading the video encoder…');
    await slow.click('#g2m-cancel');
    await slow.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 15000 }).catch(() => {});
    assert.ok(await slow.isHidden('#g2m-cancel'), 'Cancel ends a job that waits for the encoder to load');
    assert.deepEqual([await text('#g2m-status', slow), await text('#g2m-error', slow), (await rowOf('loop3.gif', slow)).state], ['Converting was cancelled.', '', 'Ready to convert']);
    await slow.click('#g2m-convert');
    await slow.waitForFunction(() => document.querySelector('#g2m-progress-text').textContent === 'Loading the video encoder…');
    await slow.clock.fastForward(90000);
    letLoad();
    await slow.waitForFunction(() => document.querySelector('#g2m-cancel').hidden, null, { timeout: 60000 });
    assert.deepEqual([(await rowOf('loop3.gif', slow)).state, (await rowOf('loop3.gif', slow)).msg], ['Converted', ''], 'a slow download of the encoder is not a stalled job');
    await slowCtx.close();

    // ---------- Reduced motion: no autoplay ----------
    const still = await browser.newContext({ reducedMotion: 'reduce' });
    const sp = await still.newPage();
    await sp.goto(url);
    await addFiles(fx('real.gif'), sp);
    await convert(sp);
    assert.deepEqual(await sp.$eval('.g2m-result video', v => [v.autoplay, v.paused, v.controls]), [false, true, true], 'the preview waits for Play');
    await still.close();
    assert.deepEqual(await page.$eval('.g2m-result video', v => [v.autoplay, v.controls, v.muted, v.loop]), [true, true, true, true], 'it plays by itself otherwise');

    // ---------- A phone: touch and a German locale ----------
    const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE', acceptDownloads: true });
    // A phone that can share files (Chrome for Android, Safari): the share sheet is recorded.
    await phone.addInitScript(() => {
      window.shared = [];
      navigator.canShare = d => !!(d && d.files && d.files.length && d.files.every(f => f instanceof File));
      navigator.share = async d => {
        if (window.shareFails) throw new DOMException('Permission denied', 'NotAllowedError');
        window.shared.push(...d.files.map(f => ({ name: f.name, type: f.type, size: f.size })));
      };
    });
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
    await addFiles([fx('timing.gif'), fx('pixel-art.gif')], pp);
    for (const sel of ['#g2m-open', '#g2m-convert', '#g2m-size', '#g2m-bg-hex', '#g2m-bg', '.g2m-row-actions button', '#g2m-clear']) {
      const b = await pp.locator(sel).first().boundingBox();
      assert.ok(b.height >= 44 && b.width >= 44, `${sel} is ${b.width} x ${b.height}`);
    }
    assert.ok(await pp.$eval('#g2m-bg-hex', el => parseFloat(getComputedStyle(el).fontSize) >= 16), 'the hex field has 16 px text');
    await pp.tap('#g2m-convert');
    await pp.waitForFunction(() => document.querySelector('#g2m-cancel').hidden && document.querySelectorAll('.g2m-result:not([hidden])').length === 2, null, { timeout: 60000 });
    const [pdl] = await Promise.all([pp.waitForEvent('download'), pp.locator('.g2m-row-actions button', { hasText: 'Download MP4' }).first().tap()]);
    const pbuf = fs.readFileSync(await pdl.path());
    checkMp4(pbuf, { width: 482, height: 272, ms: timingMs, label: 'phone' });
    assert.deepEqual((await rowOf('timing.gif', pp)).buttons, ['Download MP4', 'Share', 'Copy HTML', 'Remove'], 'Share where files can be shared');
    await pp.locator('.g2m-row-actions button', { hasText: 'Share' }).first().tap();
    await pp.waitForFunction(() => window.shared.length === 1);
    assert.deepEqual(await pp.evaluate(() => window.shared), [{ name: 'timing.mp4', type: 'video/mp4', size: pbuf.length }].map(x => ({ ...x, size: pbuf.length })), 'the share sheet gets the MP4');
    await pp.evaluate(() => { window.shareFails = true; });
    await pp.waitForTimeout(1600);
    await pp.locator('.g2m-row-actions button', { hasText: 'Share' }).first().tap();
    await pp.waitForFunction(() => document.querySelector('#g2m-status').textContent === 'Sharing did not work here. Use Download MP4 instead.');
    assert.equal((await rowOf('timing.gif', pp)).info, '7.7 KB · 481 × 271 px · 13 frames · 0.88 s · loops forever', 'numbers as on the rest of the site');
    // Nothing is cut off or scrolls sideways, from 320 to 540 px wide.
    for (const width of [320, 340, 360, 390, 412, 480, 540]) {
      await pp.setViewportSize({ width, height: 800 });
      const cut = await pp.$$eval('#g2m .btn, #g2m select', els => els.filter(b => b.getClientRects().length).map(b => {
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
  }

  // ---------- Test GIFs built here ----------
  // A GIF of `frames` frames, each with a bar in its own place, all `delay` hundredths long.
  function makeGif({ w, h, frames, delay }) {
    const out = [...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xf1, 0, 0, 255, 255, 255, 200, 0, 0, 0, 150, 0, 0, 0, 200];
    out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
    for (let i = 0; i < frames; i++) {
      const pix = new Uint8Array(w * h);
      const bar = Math.max(1, Math.round(w / 8)), x0 = (i * 3) % w;
      for (let y = 0; y < h; y++) for (let x = 0; x < bar; x++) pix[y * w + ((x0 + x) % w)] = 1 + (i % 3);
      out.push(0x21, 0xf9, 4, 4, delay & 255, delay >> 8, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2);
      const data = lzw(pix, 2);
      for (let k = 0; k < data.length; k += 255) { const p = data.slice(k, k + 255); out.push(p.length, ...p); }
      out.push(0);
    }
    out.push(0x3b);
    return Buffer.from(out);
  }
  // LZW as in make_fixtures.py: codes widen when the decoder's will.
  function lzw(indices, minCode) {
    const clear = 1 << minCode, eoi = clear + 1, out = [];
    let size = minCode + 1, acc = 0, nbits = 0;
    const put = code => { acc |= code << nbits; nbits += size; while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; } };
    let table = new Map(), next = eoi + 1, sent = 0, w = -1;
    put(clear);
    for (const k of indices) {
      if (w < 0) { w = k; continue; }
      const key = w * 256 + k;
      if (table.has(key)) { w = table.get(key); continue; }
      put(w);
      sent++;
      if (next < 4096) {
        table.set(key, next++);
        if (next - 1 >= (1 << size) && sent >= 2 && size < 12) size++;
      } else {
        put(clear);
        table = new Map();
        next = eoi + 1;
        sent = 0;
        size = minCode + 1;
      }
      w = k;
    }
    if (w >= 0) put(w);
    put(eoi);
    if (nbits) out.push(acc & 255);
    return out;
  }
};
