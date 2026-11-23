'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { devices } = require('playwright');

// The sample videos come from tests/fixtures/mov-to-mp4/make_fixtures.py (ffmpeg). Every MP4 the
// page writes is checked with ffprobe, ffmpeg and numpy (tests/fixtures/mov-to-mp4/verify.py),
// never with the page's own library: codecs, sizes, rotation, colour tags, creation time and
// metadata; for copies, the SHA-256 and presentation time of every packet against the source;
// for re-encodes, every decoded frame (count, times, PSNR, colour) and the sound (sync to the
// sample and SNR). Chromium's own <video> plays the H.264 results. The multi-gigabyte, hour-long
// inputs are built in the page from Blob parts that repeat the samples of intra.mov.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mov-to-mp4-'));
  try {
    await run({ page, open, assert, fixtures, url, base, tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

// Builds, in the page, a QuickTime file of `frames` H.264 frames at 30 fps from the all-intra
// samples of intra.mov, each followed by a filler NAL unit of `filler` bytes (decoders skip
// filler), so that the file can be an hour long and gigabytes big while each sample is a Blob part
// shared with the others. Returns the facts the converted MP4 must keep.
function buildBigMov([intraBytes, frames, filler, name]) {
  const src = new Uint8Array(intraBytes);
  const dv = new DataView(src.buffer);
  const type = o => String.fromCharCode(src[o + 4], src[o + 5], src[o + 6], src[o + 7]);
  function find(from, to, names) {
    for (let p = from; p + 8 <= to;) {
      const size = dv.getUint32(p);
      if (type(p) === names[0]) return names.length === 1 ? [p, p + size] : find(p + 8, p + size, names.slice(1));
      p += size;
    }
    throw new Error('no ' + names[0]);
  }
  const moov = find(0, src.length, ['moov']);
  const stbl = find(moov[0] + 8, moov[1], ['trak', 'mdia', 'minf', 'stbl']);
  const box = n => find(stbl[0] + 8, stbl[1], [n]);
  const stsd = box('stsd'), stsz = box('stsz'), stco = box('stco'), stsc = box('stsc');
  const entry = src.slice(stsd[0] + 16, stsd[1]);
  const n = dv.getUint32(stsz[0] + 16), sizes = [];
  for (let i = 0; i < n; i++) sizes.push(dv.getUint32(stsz[0] + 20 + 4 * i));
  const runs = [];
  for (let i = 0, k = dv.getUint32(stsc[0] + 12); i < k; i++) runs.push([dv.getUint32(stsc[0] + 16 + 12 * i), dv.getUint32(stsc[0] + 20 + 12 * i)]);
  const offsets = [];
  for (let c = 1, s = 0; s < n; c++) {
    let per = runs[0][1];
    for (const r of runs) if (r[0] <= c) per = r[1];
    let off = dv.getUint32(stco[0] + 16 + 4 * (c - 1));
    for (let j = 0; j < per && s < n; j++) { offsets.push(off); off += sizes[s++]; }
  }
  const fill = new Uint8Array(filler);
  new DataView(fill.buffer).setUint32(0, filler - 4);
  fill[4] = 0x0c;                  // NAL unit type 12: filler data
  fill.fill(0xff, 5, filler - 1);
  fill[filler - 1] = 0x80;
  const samples = sizes.map((s, i) => { const b = new Uint8Array(s + filler); b.set(src.subarray(offsets[i], offsets[i] + s)); b.set(fill, s); return b; });
  const blobs = samples.map(b => new Blob([b]));
  const enc = s => new TextEncoder().encode(s);
  const u32 = (...v) => { const b = new Uint8Array(4 * v.length); v.forEach((x, i) => new DataView(b.buffer).setUint32(4 * i, x)); return b; };
  const mk = (t, ...parts) => {
    const len = 8 + parts.reduce((a, b) => a + b.length, 0), out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    out.set(enc(t), 4);
    let p = 8;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  };
  let payload = 0;
  for (let i = 0; i < frames; i++) payload += samples[i % n].length;
  const ftyp = mk('ftyp', enc('qt  '), u32(0x200), enc('qt  '));
  const mdat = new Uint8Array(16);
  const md = new DataView(mdat.buffer);
  md.setUint32(0, 1);
  mdat.set(enc('mdat'), 4);
  md.setUint32(8, Math.floor((payload + 16) / 2 ** 32));
  md.setUint32(12, (payload + 16) % 2 ** 32);
  const start = ftyp.length + 16;
  const co64 = new Uint8Array(8 + 8 * frames), cv = new DataView(co64.buffer);
  const stszOut = new Uint8Array(12 + 4 * frames), sv = new DataView(stszOut.buffer);
  cv.setUint32(4, frames);
  sv.setUint32(8, frames);
  for (let i = 0, off = start; i < frames; i++) {
    cv.setUint32(8 + 8 * i, Math.floor(off / 2 ** 32));
    cv.setUint32(12 + 8 * i, off % 2 ** 32);
    sv.setUint32(12 + 4 * i, samples[i % n].length);
    off += samples[i % n].length;
  }
  const w = dv.getUint16(stsd[0] + 16 + 32), h = dv.getUint16(stsd[0] + 16 + 34);
  const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
  const secs600 = Math.round(frames / 30 * 600);
  const moovOut = mk('moov',
    mk('mvhd', u32(0, 0, 0, 600, secs600, 0x10000), new Uint8Array([1, 0]), new Uint8Array(10), matrix, new Uint8Array(24), u32(2)),
    mk('trak',
      mk('tkhd', u32(3, 0, 0, 1, 0, secs600, 0, 0, 0), matrix, u32(w << 16, h << 16)),
      mk('mdia',
        mk('mdhd', u32(0, 0, 0, 30000, frames * 1000), new Uint8Array([0x55, 0xc4, 0, 0])),
        mk('hdlr', u32(0, 0), enc('vide'), new Uint8Array(13)),
        mk('minf',
          mk('vmhd', u32(1, 0, 0)),
          mk('dinf', mk('dref', u32(0, 1), mk('url ', u32(1)))),
          mk('stbl', mk('stsd', u32(0, 1), entry), mk('stts', u32(0, 1, frames, 1000)), mk('stsc', u32(0, 1, 1, 1, 1)),
            mk('stsz', stszOut), mk('co64', co64))))));
  const parts = [ftyp, mdat];
  for (let i = 0; i < frames; i++) parts.push(blobs[i % n]);
  parts.push(moovOut);
  const file = new File(parts, name, { type: 'video/quicktime', lastModified: Date.UTC(2024, 4, 5, 6, 7, 8) });
  window.__big = window.__big || {};
  window.__big[name] = { file, samples, payload };
  return { size: file.size, payload, cycle: samples.map(s => s.length) };
}

// In the page: a showSaveFilePicker whose files only check what they are given. Each save keeps
// the first MiB, everything written after `tailFrom`, and 32 bytes from each write, with their
// positions, so the test can compare them with what a copy must contain.
function mockPicker() {
  window.__saves = [];
  window.__pickerCalls = [];
  window.showSaveFilePicker = async opts => {
    window.__pickerCalls.push(opts.suggestedName);
    const name = opts.suggestedName;
    const save = { name, head: new Uint8Array(1 << 20), headEnd: 0, writes: 0, back: 0, end: 0, max: 0, spots: [], tail: [], closed: false, aborted: false };
    window.__saves.push(save);
    return {
      name,
      createWritable: async () => ({
        write: async ({ type, position, data }) => {
          if (type !== 'write' || !(data instanceof Uint8Array)) throw new Error('unexpected write ' + type);
          save.writes++;
          if (position < save.end) save.back++;
          save.end = position + data.length;
          save.max = Math.max(save.max, save.end);
          if (position < save.head.length) {
            const k = Math.min(data.length, save.head.length - position);
            save.head.set(data.subarray(0, k), position);
            save.headEnd = Math.max(save.headEnd, position + k);
          }
          if (save.tailFrom !== undefined && save.end > save.tailFrom) save.tail.push([position, data.slice()]);
          for (let i = 0; i < 32; i++) {
            const q = Math.floor((data.length - 1) * i / 31);
            save.spots.push(position + q, data[q]);
          }
          await new Promise(r => setTimeout(r, 0));
        },
        close: async () => { save.closed = true; },
        abort: async () => { save.aborted = true; }
      })
    };
  };
}

// In the page: checks a mocked save against the big input it copied: the MP4 header, the index
// (sample count, sizes, 64-bit chunk offsets, duration) and every recorded byte of the media data.
function checkSave([saveIndex, name]) {
  const save = window.__saves[saveIndex], big = window.__big[name];
  const h = new DataView(save.head.buffer);
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const ftypSize = h.getUint32(0);
  const out = { brand: fourcc(save.head, 8), mdatType: fourcc(save.head, ftypSize + 4) };
  let mdatSize = h.getUint32(ftypSize), mdatHead = 8;
  if (mdatSize === 1) { mdatSize = h.getUint32(ftypSize + 8) * 2 ** 32 + h.getUint32(ftypSize + 12); mdatHead = 16; }
  out.mdatSize = mdatSize;
  const moovAt = ftypSize + mdatSize;
  // The moov box from the recorded tail writes.
  const tailBytes = new Uint8Array(save.max - moovAt);
  for (const [pos, data] of save.tail) {
    const from = Math.max(pos, moovAt), to = pos + data.length;
    if (to > from) tailBytes.set(data.subarray(from - pos, to - pos), from - moovAt);
  }
  const v = new DataView(tailBytes.buffer);
  out.moovType = fourcc(tailBytes, 4);
  const kids = (from, to) => { const r = {}; for (let p = from; p + 8 <= to;) { const s = v.getUint32(p); r[fourcc(tailBytes, p + 4)] = [p + 8, p + s]; p += s; } return r; };
  const moov = kids(8, v.getUint32(0));
  const mvhd = moov.mvhd[0];
  out.seconds = v.getUint32(mvhd + 16) / v.getUint32(mvhd + 12);
  const trak = kids(...moov.trak), mdia = kids(...trak.mdia), stbl = kids(...kids(...mdia.minf).stbl);
  out.handler = fourcc(tailBytes, mdia.hdlr[0] + 8);
  out.mediaSeconds = v.getUint32(mdia.mdhd[0] + 16) / v.getUint32(mdia.mdhd[0] + 12);
  out.samples = v.getUint32(stbl.stsz[0] + 8);
  out.chunkBox = stbl.co64 ? 'co64' : 'stco';
  // Sample sizes and where each sample is, then every spot byte against the source sample.
  const sizes = [];
  for (let i = 0; i < out.samples; i++) sizes.push(v.getUint32(stbl.stsz[0] + 12 + 4 * i));
  const n = big.samples.length;
  out.sizesMatch = sizes.every((s, i) => s === big.samples[i % n].length);
  const stsc = stbl.stsc[0], runs = [];
  for (let i = 0, k = v.getUint32(stsc + 4); i < k; i++) runs.push([v.getUint32(stsc + 8 + 12 * i), v.getUint32(stsc + 12 + 12 * i)]);
  const chunkCount = v.getUint32(stbl[out.chunkBox][0] + 4);
  const chunkOff = i => out.chunkBox === 'co64' ? v.getUint32(stbl.co64[0] + 8 + 8 * i) * 2 ** 32 + v.getUint32(stbl.co64[0] + 12 + 8 * i) : v.getUint32(stbl.stco[0] + 8 + 4 * i);
  const starts = new Float64Array(out.samples);
  for (let c = 0, s = 0; c < chunkCount && s < out.samples; c++) {
    let per = runs[0][1];
    for (const r of runs) if (r[0] <= c + 1) per = r[1];
    let off = chunkOff(c);
    for (let j = 0; j < per && s < out.samples; j++) { starts[s] = off; off += sizes[s]; s++; }
  }
  out.firstSampleAt = starts[0];
  out.contiguous = starts.every((s, i) => i === 0 || s === starts[i - 1] + sizes[i - 1]);
  out.dataEnd = starts[out.samples - 1] + sizes[out.samples - 1];
  // Every recorded byte inside the media data must be the source's byte at that place.
  let checked = 0, wrong = 0;
  const cycle = big.samples.reduce((a, s) => a + s.length, 0), cum = [0];
  big.samples.forEach(s => cum.push(cum[cum.length - 1] + s.length));
  for (let i = 0; i < save.spots.length; i += 2) {
    const pos = save.spots[i], byte = save.spots[i + 1];
    if (pos < out.firstSampleAt || pos >= out.dataEnd) continue;
    const r = (pos - out.firstSampleAt) % cycle;
    let k = 0;
    while (cum[k + 1] <= r) k++;
    checked++;
    if (big.samples[k][r - cum[k]] !== byte) wrong++;
  }
  Object.assign(out, { checked, wrong, writes: save.writes, back: save.back, max: save.max, closed: save.closed, aborted: save.aborted, headEnd: save.headEnd });
  return out;
}

async function run({ page, open, assert, fixtures, url, tmp }) {
  const browser = page.context().browser();
  const fx = name => path.join(fixtures, name);
  for (const [cmd, args] of [['ffprobe', ['-version']], ['ffmpeg', ['-version']], ['python3', ['-c', 'import numpy']]]) {
    try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch (e) {
      throw new Error(`tests/tools/mov-to-mp4.test.js checks every MP4 with ffmpeg, ffprobe and python3 with numpy: ${cmd} is missing`);
    }
  }
  const py = (...args) => JSON.parse(execFileSync('python3', [fx('verify.py'), ...args], { maxBuffer: 512 << 20, stdio: ['ignore', 'pipe', 'inherit'] }).toString());
  const factCache = new Map();
  const facts = p => { if (!factCache.has(p)) factCache.set(p, py('facts', p)); return factCache.get(p); };
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const kb = n => Math.round(n / 1000);

  // ---------- instrumentation ----------
  const instrument = () => {
    // What screen readers are told: every change to a live region.
    window.__live = [];
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => {
      const seen = new Set();
      for (const m of ms) {
        const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const live = n && n.closest('[role=alert],[role=status],[aria-live]');
        if (live && live.textContent && !seen.has(live)) { seen.add(live); window.__live.push([live.id, live.textContent]); }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true }));
    // A screen wake lock that, like the browser's, is let go when the page is hidden.
    window.__wake = { requested: 0, released: 0, held: 0 };
    if (navigator.wakeLock) {
      navigator.wakeLock.request = () => {
        window.__wake.requested++;
        window.__wake.held++;
        const listeners = [];
        const lock = {
          released: false,
          release() {
            if (!this.released) { this.released = true; window.__wake.released++; window.__wake.held--; listeners.forEach(f => f()); }
            return Promise.resolve();
          },
          addEventListener(type, f) { if (type === 'release') listeners.push(f); }
        };
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') lock.release(); });
        return Promise.resolve(lock);
      };
    }
  };
  await page.addInitScript(instrument);
  let gotChooser;
  const chooserReady = new Promise(r => { gotChooser = r; });
  page.on('filechooser', fc => gotChooser(fc));
  await open();

  // ---------- helpers ----------
  const status = (p = page) => p.$eval('#mvp-status', e => e.textContent);
  const row = (name, p = page) => p.locator('.mvp-file').filter({ has: p.locator('.mvp-file-name').getByText(name, { exact: true }) });
  const card = async (name, p = page) => row(name, p).evaluate(li => {
    const t = sel => { const e = li.querySelector(sel); return e && !e.hidden ? e.textContent : ''; };
    return {
      info: t('.mvp-file-info'), tracks: t('.mvp-file-tracks'), plan: t('.mvp-file-plan'), state: t('.mvp-file-state'), msg: t('.mvp-file-msg'),
      notes: [...li.querySelectorAll('.mvp-file-notes li')].map(x => x.textContent),
      download: !li.querySelector('.mvp-dl').hidden, refused: li.querySelector('.mvp-file-plan').classList.contains('is-refused')
    };
  });
  const waitRead = (p = page) => p.waitForFunction(() => document.querySelectorAll('.mvp-file').length > 0 &&
    ![...document.querySelectorAll('.mvp-file-state')].some(e => e.textContent === 'Reading…'), null, { timeout: 60000 });
  const waitIdle = (p = page, timeout = 180000) => p.waitForFunction(() => document.getElementById('mvp-cancel').hidden &&
    document.getElementById('mvp-convert').textContent !== 'Converting…', null, { timeout });
  const add = async (names, p = page) => { await p.setInputFiles('#mvp-file', names.map(fx)); await waitRead(p); };
  let dlNo = 0, lastDownload = 0;
  const download = async (action, p = page) => {
    const caller = (new Error().stack.split('\n')[2] || '').trim();
    // Chromium drops a download that follows ten others within a second or
    // so, so the test leaves a short gap between downloads, as a person would.
    await new Promise(r => setTimeout(r, Math.max(0, lastDownload + 300 - Date.now())));
    try {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), action()]);
      lastDownload = Date.now();
      const dir = path.join(tmp, 'dl' + (++dlNo));
      fs.mkdirSync(dir);
      const file = path.join(dir, dl.suggestedFilename());
      await dl.saveAs(file);
      return { name: dl.suggestedFilename(), file, url: dl.url() };
    } catch (e) {
      throw new Error(`${String(e.message).split('\n')[0]} (download ${caller})`);
    }
  };
  const downloadOf = (name, p = page) => download(() => row(name, p).locator('.mvp-dl').click(), p);
  // The output's track `i` of a kind is a run of the source's packets: same bytes, same times.
  const samePackets = (src, out, kind, i, what) => {
    const a = src.streams.filter(s => s.type === kind)[i], b = out.streams.filter(s => s.type === kind)[i];
    assert.ok(a && b, `${what}: ${kind} track ${i + 1} in the source and the MP4`);
    assert.equal(b.codec, a.codec, `${what}: ${kind} codec`);
    const ha = a.packets.map(x => x.hash), hb = b.packets.map(x => x.hash);
    const k = ha.indexOf(hb[0]);
    assert.ok(k >= 0 && hb.length > 0, `${what}: the first ${kind} packet of the MP4 is one of the source's`);
    assert.deepEqual(hb, ha.slice(k, k + hb.length), `${what}: ${kind} packets copied byte for byte`);
    b.packets.forEach((x, j) => near(x.pts, a.packets[k + j].pts, 0.0006, `${what}: ${kind} packet ${j} time`));
    return { from: k, count: hb.length, of: ha.length };
  };
  // Clockwise rotation from ffprobe's display matrix (counter-clockwise degrees).
  const cw = r => ((360 - Math.round(r)) % 360 + 360) % 360;
  const plays = async (dlUrl, p = page) => p.evaluate(async src => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    document.body.appendChild(v);
    const r = {};
    try {
      await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('media error ' + (v.error && v.error.code))); v.src = src; });
      r.w = v.videoWidth; r.h = v.videoHeight; r.dur = v.duration;
      await v.play();
      await new Promise(ok => { const t = () => (v.currentTime > 0.3 || v.ended ? ok() : requestAnimationFrame(t)); t(); });
      v.pause();
      r.frames = v.getVideoPlaybackQuality().totalVideoFrames;
    } finally { v.remove(); }
    return r;
  }, dlUrl);

  // ===================================================================================
  // 1. The page explains itself before any file is added.
  // ===================================================================================
  assert.equal(await page.isHidden('#mvp-files-sec'), true, 'no file list before a file is added');
  assert.equal(await page.isDisabled('#mvp-convert'), true, 'Convert waits for a file');
  assert.equal(await page.textContent('#mvp-convert'), 'Convert to MP4');
  assert.equal(await page.isChecked('#mvp-v-copy'), true, 'copying is the default');
  assert.match(await page.textContent('#mvp-drop-hint'), /MOV, M4V or MP4 .* any size/);
  assert.equal(await page.getAttribute('#mvp-open', 'aria-describedby'), 'mvp-drop-hint mvp-file-error');
  assert.equal(await page.isHidden('#mvp-progress'), true);

  // ===================================================================================
  // 2. An iPhone video, from the keyboard: HEVC with B-frames, rotation, Apple metadata.
  // ===================================================================================
  for (let i = 0; i < 40 && !(await page.evaluate(() => document.activeElement && document.activeElement.id === 'mvp-open')); i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mvp-open', 'Tab reaches Choose videos');
  await page.keyboard.press('Enter');
  const chooser = await chooserReady;
  assert.equal(chooser.isMultiple(), true, 'several files can be chosen at once');
  await chooser.setFiles(fx('iphone-hevc.mov'));
  await waitRead();
  const iphoneSrc = facts(fx('iphone-hevc.mov'));
  const recorded = await page.evaluate(() => new Date(Date.UTC(2025, 5, 1, 10, 20, 30)).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
  let c = await card('iphone-hevc.mov');
  assert.equal(c.info, `0:02 · 360 × 640 · ${kb(fs.statSync(fx('iphone-hevc.mov')).size)} KB · recorded ${recorded}`);
  const srcRot = cw(iphoneSrc.streams[0].rotation);
  assert.equal(c.tracks, `Video: HEVC (H.265), rotated ${srcRot}° · Sound: AAC stereo`);
  assert.match(c.plan, /^Copy, quality unchanged · about \d+ KB$/);
  assert.ok(c.notes.some(t => /HEVC Video Extensions \(\$0\.99 in the Microsoft Store\)/.test(t)), 'HEVC files warn about Windows');
  assert.ok(c.notes.includes('Not kept: the location, the camera maker, the camera model, the software version and the local time and time zone of the recording. The date and time stay, in universal time.'), c.notes.join(' | '));
  assert.equal(c.msg, '');
  assert.equal(await status(), `Added iphone-hevc.mov: ${c.plan}.`);
  for (let i = 0; i < 40 && !(await page.evaluate(() => document.activeElement && document.activeElement.id === 'mvp-convert')); i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mvp-convert', 'Tab reaches Convert');
  // A visible focus ring on the focused button.
  assert.notEqual(await page.$eval('#mvp-convert', e => getComputedStyle(e).outlineStyle), 'none', 'focus ring on Convert');
  await page.keyboard.press('Enter');
  await waitIdle();
  c = await card('iphone-hevc.mov');
  assert.match(c.state, /^Done: iphone-hevc\.mp4, \d+ KB$/);
  assert.match(await status(), /^iphone-hevc\.mp4 is ready to download, \d+ KB\.$/);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('mvp-dl')), true, 'focus moves to Download');
  const iphone = await download(() => page.keyboard.press('Enter'));
  assert.equal(iphone.name, 'iphone-hevc.mp4');
  let out = facts(iphone.file);
  assert.equal(out.brand, 'isom', 'an MP4, not a QuickTime movie');
  assert.equal(out.streams.length, 2);
  assert.equal(out.streams[0].tag, 'hvc1');
  assert.deepEqual([out.streams[0].width, out.streams[0].height, out.streams[0].rotation], [640, 360, iphoneSrc.streams[0].rotation], 'size and rotation kept');
  assert.equal(out.tags.creation_time, '2025-06-01T10:20:30.000000Z', 'the recording time, not the conversion time');
  for (const k of Object.keys(out.tags)) assert.ok(!/location|make|model|software|com\.apple|xyz/i.test(k), `metadata ${k} is left out`);
  samePackets(iphoneSrc, out, 'video', 0, 'iPhone video');
  samePackets(iphoneSrc, out, 'audio', 0, 'iPhone sound');
  near(out.duration, 2, 0.01, 'iPhone duration');
  assert.equal(await page.evaluate(() => window.__wake.requested > 0 && window.__wake.held === 0), true, 'the screen was kept on while converting, and released');
  let said = await page.evaluate(() => window.__live.filter(x => x[0] === 'mvp-status').map(x => x[1]));
  assert.deepEqual(said.slice(-2), ['Converting iphone-hevc.mov.', await status()], 'one announcement when it starts, one when it ends');

  // ===================================================================================
  // 3. A batch of awkward files, with the mouse.
  // ===================================================================================
  const batch = ['h264-timecode-trimmed.mov', 'two-languages.mov', 'vfr-silent.mov', 'rotated-180.mov', 'rotated-270.mov', 'aac-alac.mov',
    'iphone-spatial.mov', 'hdr-hlg.mov', 'iphone-dolby-vision.mov', 'vp9-odd-size.mp4', 'vp9-odd-rotated.mp4', 'av1-opus.mp4', 'screen.webm',
    'quicktime-named.mp4', 'android-location.mp4', 'cut-off.mov', 'garbage-inside.mov', 'h264-pcm16.mov', 'prores422-pcm24.mov', 'prores4444-alpha.mov',
    'mjpeg-pcm.mov', 'sound-only.mov', 'notes.mov', 'empty.mov', 'cut-before-index.mov'];
  await add(batch);
  assert.equal(await status(), `Added ${batch.length} files, 5 of them cannot be converted: see the message under each.`);
  assert.equal(await page.textContent('#mvp-convert'), `Convert ${batch.length - 5} files to MP4`);
  const refusals = {
    'mjpeg-pcm.mov': 'Its video is Motion JPEG (MJPEG), which this page cannot convert: browsers have no decoder for it. Free desktop programs such as HandBrake can convert Motion JPEG.',
    'sound-only.mov': 'This file has sound but no video. To save its sound, use MP4 to MP3.',
    'notes.mov': 'This is not a video this page can read. It reads MOV, M4V, MP4, WebM and MKV files.',
    'empty.mov': 'This file is empty (0 bytes).',
    'cut-before-index.mov': 'This file is incomplete: it ends before its index, the part that says where every frame is, so it cannot be read. This happens when a recording, copy or download did not finish.'
  };
  for (const [name, text] of Object.entries(refusals)) {
    c = await card(name);
    assert.equal(c.plan, 'Not supported', name);
    assert.equal(c.refused, true, `${name}: shown as refused`);
    assert.equal(c.msg, text, name);
    assert.equal(c.state, '', `${name}: no state`);
  }
  assert.equal(await row('sound-only.mov').locator('.mvp-file-msg a').getAttribute('href'), '/mp4-to-mp3/');
  const expectNotes = {
    'h264-timecode-trimmed.mov': ['Left out: the timecode track, used by editing software.'],
    'two-languages.mov': ['Left out: the subtitle track.'],
    'aac-alac.mov': ['Left out: a sound track in Apple Lossless (ALAC), which this page cannot read.'],
    'iphone-spatial.mov': ['Left out: the Spatial Audio track (APAC), which this page cannot read. The other sound track is kept.'],
    'hdr-hlg.mov': ['HDR is kept: the colour information is copied.'],
    'iphone-dolby-vision.mov': ['HDR is kept. The Dolby Vision information is not, so players show it as ordinary HLG HDR.'],
    'vp9-odd-size.mp4': ['The Opus sound is copied as it is. Some players and video editors do not play it in an MP4: “Plays everywhere” turns it into AAC.'],
    'screen.webm': ['The Opus sound is copied as it is. Some players and video editors do not play it in an MP4.'],
    'cut-off.mov': ['This file is incomplete: it should run 0:02, but its data stops at 0:01. That part is converted.'],
    'android-location.mp4': ['Not kept: the location.'],
    'h264-pcm16.mov': ['The sound is uncompressed (PCM, 16-bit), which many MP4 players refuse: it becomes AAC at 192 kbps.'],
    'prores422-pcm24.mov': ['The sound is uncompressed (PCM, 24-bit), which many MP4 players refuse: it becomes AAC at 192 kbps.'],
    'prores4444-alpha.mov': ['Transparency is lost: H.264 has no alpha channel.']
  };
  for (const [name, notes] of Object.entries(expectNotes)) {
    c = await card(name);
    assert.equal(c.msg, '', `${name}: no error`);
    for (const n of notes) assert.ok(c.notes.includes(n), `${name}: note "${n}" in ${JSON.stringify(c.notes)}`);
  }
  assert.match((await card('h264-pcm16.mov')).plan, /^Copy the video, re-encode the sound to AAC · about \d+ KB$/);
  assert.match((await card('prores422-pcm24.mov')).plan, /^Re-encode the video to H\.264 and the sound to AAC · about \d+ KB$/);
  assert.equal((await card('prores422-pcm24.mov')).tracks, 'Video: ProRes 422 · Sound: PCM, 24-bit stereo');
  assert.equal((await card('hdr-hlg.mov')).tracks, 'Video: HEVC (H.265), HDR (HLG) · Sound: AAC mono');
  assert.equal((await card('vp9-odd-size.mp4')).info, `0:01 · 1365 × 767 · ${kb(fs.statSync(fx('vp9-odd-size.mp4')).size)} KB`);
  assert.equal((await card('two-languages.mov')).tracks, 'Video: H.264 · Sound: AAC mono, AAC mono');
  assert.equal((await card('prores4444-alpha.mov')).tracks, 'Video: ProRes 4444 · No sound');

  await page.click('#mvp-convert');
  await waitIdle();
  const converted = batch.length - 5;
  assert.equal(await status(), `${converted} of ${converted} files converted. Download them with the buttons under each file or all as a ZIP.`);
  for (const name of Object.keys(refusals)) assert.equal((await card(name)).download, false, `${name}: nothing to download`);
  const results = {};
  for (const name of batch.filter(n => !refusals[n])) {
    c = await card(name);
    assert.match(c.state, /^Done: .+\.mp4, [\d.]+ KB$/, name);
    results[name] = await downloadOf(name);
  }
  assert.equal(results['quicktime-named.mp4'].name, 'quicktime-named (converted).mp4', 'an .mp4 input gets a new name');
  assert.equal(results['screen.webm'].name, 'screen.mp4');

  // Copies: every packet the same, at the same time.
  const copied = ['two-languages.mov', 'vfr-silent.mov', 'rotated-180.mov', 'rotated-270.mov', 'aac-alac.mov', 'iphone-spatial.mov', 'hdr-hlg.mov',
    'iphone-dolby-vision.mov', 'vp9-odd-size.mp4', 'vp9-odd-rotated.mp4', 'av1-opus.mp4', 'screen.webm', 'quicktime-named.mp4', 'android-location.mp4',
    'garbage-inside.mov'];
  for (const name of copied) {
    const src = facts(fx(name)), o = facts(results[name].file);
    assert.equal(o.brand, 'isom', `${name}: MP4 brand`);
    const v = samePackets(src, o, 'video', 0, name);
    assert.equal(v.count, v.of, `${name}: every video packet`);
    assert.equal(o.streams[0].rotation, src.streams[0].rotation, `${name}: rotation`);
    assert.deepEqual([o.streams[0].width, o.streams[0].height], [src.streams[0].width, src.streams[0].height], `${name}: size`);
    for (const k of ['primaries', 'transfer', 'matrix']) assert.equal(o.streams[0][k], src.streams[0][k], `${name}: colour ${k}`);
  }
  // Sound: AAC and Opus copied, unreadable tracks (ALAC, APAC) and subtitles left out.
  for (const [name, kept] of [['two-languages.mov', 2], ['aac-alac.mov', 1], ['iphone-spatial.mov', 1], ['vp9-odd-size.mp4', 1], ['av1-opus.mp4', 1], ['screen.webm', 1], ['hdr-hlg.mov', 1]]) {
    const src = facts(fx(name)), o = facts(results[name].file);
    assert.equal(o.streams.filter(s => s.type === 'audio').length, kept, `${name}: sound tracks kept`);
    assert.equal(o.streams.filter(s => s.type === 'subtitle' || s.type === 'data').length, 0, `${name}: no subtitle or timecode track`);
    for (let i = 0; i < kept; i++) assert.equal(samePackets(src, o, 'audio', i, name).count, src.streams.filter(s => s.type === 'audio')[i].packets.length, `${name}: every sound packet`);
  }
  // An Android MP4's place of filming goes; its recording time stays.
  out = facts(results['android-location.mp4'].file);
  assert.equal(facts(fx('android-location.mp4')).tags.location, '+48.8584+002.2945/', 'the source says where it was filmed');
  assert.deepEqual(Object.keys(out.tags).filter(k => /location|xyz|loci/i.test(k)), [], 'the MP4 does not');
  assert.equal(fs.readFileSync(results['android-location.mp4'].file).includes('48.8584'), false, 'nor anywhere in its bytes');
  assert.equal(out.tags.creation_time, '2026-03-04T05:06:07.000000Z');
  out = facts(results['hdr-hlg.mov'].file);
  assert.deepEqual([out.streams[0].primaries, out.streams[0].transfer, out.streams[0].matrix], ['bt2020', 'arib-std-b67', 'bt2020nc'], 'HLG colour tags kept');
  assert.equal(fs.readFileSync(results['iphone-dolby-vision.mov'].file).includes('dvvC'), false, 'as the note says, the Dolby Vision box is not kept');
  // Edit list and timecode: the copy starts at the key frame before the cut, shows the same
  // frames at the same times, and the timecode track is gone.
  const tc = facts(fx('h264-timecode-trimmed.mov'));
  out = facts(results['h264-timecode-trimmed.mov'].file);
  assert.equal(tc.streams.some(s => s.tag === 'tmcd'), true, 'the source has a timecode track');
  assert.deepEqual(out.streams.map(s => s.type), ['video', 'audio'], 'no timecode track');
  assert.equal(samePackets(tc, out, 'video', 0, 'trimmed').count, tc.streams[0].packets.length, 'every video packet, B-frames included');
  const tcAudio = samePackets(tc, out, 'audio', 0, 'trimmed sound');
  assert.equal(tcAudio.from + tcAudio.count, tc.streams[1].packets.length, 'the sound runs to its end');
  let fr = py('frames', fx('h264-timecode-trimmed.mov'), results['h264-timecode-trimmed.mov'].file);
  assert.equal(fr.frames[1], fr.frames[0], 'the same frames are shown');
  assert.equal(fr.psnr_min, 99, 'identical pictures');
  assert.deepEqual(fr.times[1].map(t => t.toFixed(4)), fr.times[0].map(t => t.toFixed(4)), 'at the same times (edit list kept)');
  // Variable frame rate: 30 fps then 10 fps, timestamps kept.
  out = facts(results['vfr-silent.mov'].file);
  const gaps = out.streams[0].packets.map(p => p.pts).sort((a, b) => a - b).map((t, i, a) => i ? +(t - a[i - 1]).toFixed(4) : 0).slice(1);
  assert.deepEqual([...new Set(gaps)].sort(), [0.0333, 0.1], 'frame gaps of 1/30 s and 1/10 s');
  // Cut-off file: the readable second, every packet of it the same.
  const cutSrc = facts(fx('cut-off.mov'));
  out = facts(results['cut-off.mov'].file);
  const cutV = samePackets(cutSrc, out, 'video', 0, 'cut-off');
  assert.equal(cutV.from, 0);
  near(out.duration, 1.03, 0.05, 'cut-off file: the part with data');
  // Damaged data inside: copied as it is (the same damage, nothing else changed).
  assert.equal(facts(results['garbage-inside.mov'].file).streams[0].packets.length, 60);
  // PCM to AAC: the video copied, the sound AAC 192 kbps, in sync to the sample (click at 0.5 s).
  for (const [name, sr] of [['h264-pcm16.mov', 44100], ['prores422-pcm24.mov', 48000]]) {
    out = facts(results[name].file);
    const a = out.streams.find(s => s.type === 'audio');
    assert.deepEqual([a.codec, a.sample_rate, a.channels], ['aac', sr, 2], `${name}: AAC stereo at the source's rate`);
    // 192 kbps is the encoder's target; simple sound like this test signal takes less.
    assert.ok(a.bit_rate > 100e3 && a.bit_rate < 200e3, `${name}: AAC at ${Math.round(a.bit_rate / 1000)} kbps`);
    const snd = py('sound', fx(name), results[name].file);
    assert.equal(snd.lag, 0, `${name}: sound in sync`);
    assert.ok(snd.snr > 25, `${name}: sound SNR ${snd.snr}`);
  }
  samePackets(facts(fx('h264-pcm16.mov')), facts(results['h264-pcm16.mov'].file), 'video', 0, 'PCM file video');
  // ProRes to H.264: every frame, at the same time, close to the source; colours right.
  for (const name of ['prores422-pcm24.mov', 'prores4444-alpha.mov']) {
    const src = facts(fx(name));
    out = facts(results[name].file);
    const v = out.streams.find(s => s.type === 'video');
    assert.deepEqual([v.codec, v.width, v.height], ['h264', src.streams[0].width, src.streams[0].height], `${name}: H.264 at the same size`);
    fr = py('frames', fx(name), results[name].file);
    assert.equal(fr.frames[1], fr.frames[0], `${name}: every frame`);
    assert.deepEqual(fr.times[1].map(t => t.toFixed(3)), fr.times[0].map(t => t.toFixed(3)), `${name}: frame times`);
    assert.ok(fr.psnr_min > 34, `${name}: PSNR ${fr.psnr_min}`);
    // (The 96 x 54 ProRes 4444 clip is mostly 1-pixel coloured text, which 4:2:0 H.264 smears,
    // so its colours are checked on the 4:2:2 clip only.)
    if (name === 'prores422-pcm24.mov') assert.ok(fr.colour_mean < 3 && fr.colour_bias < 2, `${name}: colours off by ${fr.colour_mean.toFixed(2)} on average, ${fr.colour_bias.toFixed(2)} in one channel`);
    const shown = await plays(results[name].url);
    assert.deepEqual([shown.w, shown.h], [src.streams[0].width, src.streams[0].height], `${name}: Chromium shows it`);
    assert.ok(shown.frames > 0, `${name}: Chromium decodes frames`);
  }
  assert.deepEqual(facts(results['prores422-pcm24.mov'].file).streams[0].primaries, 'bt709', 'ProRes tagged BT.709 stays BT.709');
  // Chromium plays the copied H.264 files too.
  for (const name of ['h264-timecode-trimmed.mov', 'rotated-270.mov', 'h264-pcm16.mov']) {
    const shown = await plays(results[name].url);
    assert.ok(shown.frames > 0, `${name}: Chromium shows frames`);
  }
  // The ZIP holds every MP4 (stored, names cleaned, CRC right).
  const zip = await download(() => page.click('#mvp-zip'));
  assert.equal(zip.name, 'converted-videos.zip');
  const zbuf = fs.readFileSync(zip.file);
  const eocd = zbuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zbuf.readUInt16LE(eocd + 10);
  assert.equal(count, Object.keys(results).length + 1, 'every MP4 in the ZIP');
  const inZip = new Map();
  for (let p = zbuf.readUInt32LE(eocd + 16), i = 0; i < count; i++) {
    const nameLen = zbuf.readUInt16LE(p + 28), extra = zbuf.readUInt16LE(p + 30), note = zbuf.readUInt16LE(p + 32);
    const name = zbuf.toString('utf8', p + 46, p + 46 + nameLen), local = zbuf.readUInt32LE(p + 42), size = zbuf.readUInt32LE(p + 20);
    assert.equal(zbuf.readUInt16LE(p + 10), 0, `${name}: stored`);
    const data = zbuf.subarray(local + 30 + zbuf.readUInt16LE(local + 26) + zbuf.readUInt16LE(local + 28)).subarray(0, size);
    assert.equal(zlib.crc32(data), zbuf.readUInt32LE(p + 16), `${name}: CRC`);
    inZip.set(name, data);
    p += 46 + nameLen + extra + note;
  }
  for (const r of [iphone, ...Object.values(results)]) assert.equal(Buffer.compare(inZip.get(r.name), fs.readFileSync(r.file)), 0, `${r.name}: same bytes in the ZIP`);

  // ===================================================================================
  // 4. "Plays everywhere": HEVC cannot be decoded here, VP9 and AV1 become H.264 and AAC.
  // ===================================================================================
  await page.check('#mvp-v-h264');
  assert.equal(await status(), 'The video setting changed, so 3 files need converting again.');
  c = await card('vp9-odd-size.mp4');
  assert.match(c.plan, /^Re-encode the video to H\.264 and the sound to AAC · about \d+ KB$/);
  assert.equal(c.state, 'Ready', 'the old copy is gone');
  assert.equal(c.download, false);
  assert.ok(c.notes.includes('H.264 needs an even width and height, so the H.264 video is 1364 × 766: it loses the last column or row of pixels.'), c.notes.join(' | '));
  c = await card('iphone-hevc.mov');
  // (Edge on Windows decodes HEVC only with the HEVC Video Extensions, so it is not named here.)
  assert.ok(c.notes.includes('This browser cannot decode HEVC, so the video is copied as HEVC. Safari on a Mac, iPhone or iPad, and Chrome on most Windows PCs and Macs, can make H.264 from it.'), c.notes.join(' | '));
  assert.match(c.state, /^Done: /, 'a result whose plan did not change stays');
  assert.match((await card('screen.webm')).notes.join(' '), /Re-encoding is not offered for WebM and MKV files here/);
  assert.equal(await page.textContent('#mvp-convert'), 'Convert 3 files to MP4');
  await page.click('#mvp-convert');
  await waitIdle();
  for (const [name, w, h, minPsnr, maxColour] of [['vp9-odd-size.mp4', 1364, 766, 32, 4.5], ['vp9-odd-rotated.mp4', 766, 1364, 32, 4.5], ['av1-opus.mp4', 320, 180, 36, 1.5]]) {
    const r = await downloadOf(name);
    out = facts(r.file);
    const v = out.streams.find(s => s.type === 'video'), a = out.streams.find(s => s.type === 'audio');
    assert.deepEqual([v.codec, v.width, v.height, a.codec], ['h264', w, h, 'aac'], `${name}: H.264 and AAC`);
    fr = py('frames', fx(name), r.file, String(w), String(h));
    assert.equal(fr.frames[1], fr.frames[0], `${name}: every frame`);
    assert.deepEqual(fr.times[1].map(t => t.toFixed(3)), fr.times[0].map(t => t.toFixed(3)), `${name}: frame times`);
    assert.ok(fr.psnr_min > minPsnr, `${name}: PSNR ${fr.psnr_min}`);
    // An odd size is cropped on a canvas (full-range sRGB), which costs a little more colour.
    assert.ok(fr.colour_mean < maxColour && fr.colour_bias < 2.5, `${name}: colours off by ${fr.colour_mean.toFixed(2)} on average, ${fr.colour_bias.toFixed(2)} in one channel`);
    // Opus decoded and encoded again as AAC: in sync to within a millisecond.
    const snd = py('sound', fx(name), r.file);
    assert.ok(Math.abs(snd.lag) <= 48, `${name}: sound ${snd.lag} samples off`);
    assert.ok(snd.snr > 30, `${name}: sound SNR ${snd.snr}`);
    const shown = await plays(r.url);
    assert.deepEqual([shown.w, shown.h], [w, h], `${name}: Chromium shows ${w} × ${h}`);
    near(shown.dur, 1, 0.05, `${name}: duration in Chromium`);
    assert.ok(shown.frames > 0, `${name}: Chromium decodes frames`);
  }
  // A double click downloads once.
  let downloads = 0;
  const countDl = () => downloads++;
  page.on('download', countDl);
  await row('av1-opus.mp4').locator('.mvp-dl').dblclick();
  await page.waitForEvent('download', { timeout: 1500 }).catch(() => null);
  page.off('download', countDl);
  assert.equal(downloads, 1, 'one download for a double click');

  // ===================================================================================
  // 5. Removing files, and a link instead of a file.
  // ===================================================================================
  await row('notes.mov').locator('.mvp-remove').click();
  assert.equal(await row('notes.mov').count(), 0);
  assert.equal(await status(), 'Removed notes.mov.');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://www.example.com/video.mov');
    document.getElementById('mvp-drop').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  assert.equal(await page.textContent('#mvp-file-error'), 'Links cannot be converted: this page only reads files on your device. Save the video to your device first, then choose it here.');
  await page.click('#mvp-clear');
  assert.equal(await status(), 'All files removed.');
  assert.equal(await page.isHidden('#mvp-files-sec'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mvp-open', 'focus goes back to Choose videos');
  // A file whose index is whole but whose video settings are wrong: the library calls the
  // copy valid, yet it has no video. The page checks every MP4 before offering it.
  // And an index that points outside the file, refused before converting.
  await page.check('#mvp-v-copy');
  await add(['bad-nal-length.mov', 'bad-sample-count.mov']);
  assert.equal((await card('bad-nal-length.mov')).plan, 'Copy, quality unchanged · about 59 KB');
  c = await card('bad-sample-count.mov');
  assert.deepEqual([c.plan, c.refused, c.msg], ['Not supported', true, 'This file is damaged: its index cannot be read, so it cannot be converted.']);
  await page.click('#mvp-convert');
  await waitIdle();
  c = await card('bad-nal-length.mov');
  const lost = 'The converter could not copy all of this file (its video): the file may be damaged. Nothing was saved.';
  assert.deepEqual([c.state, c.msg], ['Not converted', lost]);
  assert.equal(c.download, false, 'no MP4 without its video is offered');
  assert.equal(await status(), 'bad-nal-length.mov: ' + lost);
  await page.click('#mvp-clear');


  // ===================================================================================
  // 6. An hour-long, 4.6 GB MOV saved straight to a file (a save dialog mocked so that it only
  //    checks what it is given): cancelled once, then with a second big file in the same batch,
  //    which asks where to save it. The tab is hidden for a while in between.
  // ===================================================================================
  await page.check('#mvp-v-copy');
  await page.evaluate(mockPicker);
  const intra = [...fs.readFileSync(fx('intra.mov'))];
  const addBig = async names => page.evaluate(list => {
    const dt = new DataTransfer();
    for (const n of list) dt.items.add(window.__big[n].file);
    const input = document.getElementById('mvp-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, names);
  const longFacts = await page.evaluate(buildBigMov, [intra, 108000, 40000, 'long.mov']);
  const midFacts = await page.evaluate(buildBigMov, [intra, 15000, 40000, 'second.mov']);
  assert.ok(longFacts.size > 4.5e9 && midFacts.size > 6e8, 'big inputs');
  await addBig(['long.mov', 'second.mov']);
  await waitRead();
  c = await card('long.mov');
  assert.equal(c.info, '1:00:00 · 320 × 180 · 4.58 GB');
  assert.match(c.plan, /^Copy, quality unchanged · about 4\.\d\d GB$/);
  // Each save keeps what is written past its media data: the index.
  await page.evaluate(({ a, b }) => {
    const tails = { 'long.mp4': a, 'second.mp4': b }, orig = window.showSaveFilePicker;
    window.showSaveFilePicker = async opts => { const h = await orig(opts); window.__saves[window.__saves.length - 1].tailFrom = tails[opts.suggestedName]; return h; };
  }, { a: longFacts.payload, b: midFacts.payload });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const heapWatch = () => {
    const w = { peak: 0, on: true };
    w.done = (async () => {
      while (w.on) {
        const u = await cdp.send('Runtime.getHeapUsage').catch(() => null);
        if (u) w.peak = Math.max(w.peak, u.usedSize);
        await new Promise(r => setTimeout(r, 200));
      }
    })();
    w.stop = async () => { w.on = false; await w.done; return w.peak; };
    return w;
  };
  const setHidden = hidden => page.evaluate(h => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  const progressAt = pct => page.waitForFunction(p => {
    const m = /long\.mov, (\d+)%/.exec(document.getElementById('mvp-progress-text').textContent);
    return m && +m[1] >= p;
  }, pct, { timeout: 180000 });
  // Cancel at about a third of the way.
  await page.click('#mvp-convert');
  await progressAt(30);
  assert.deepEqual(await page.evaluate(() => window.__pickerCalls), ['long.mp4'], 'the click opened the save dialog at once');
  await page.click('#mvp-cancel');
  await waitIdle();
  assert.equal(await status(), 'Conversion cancelled.');
  assert.deepEqual(await page.evaluate(() => { const s = window.__saves[0]; return [s.closed, s.aborted]; }), [false, true], 'a cancelled file is never committed');
  assert.equal((await card('long.mov')).state, 'Ready');
  assert.equal(await page.evaluate(() => window.__wake.held), 0, 'wake lock released after cancelling');
  // The whole batch. The first file's dialog opens from the click; the second file comes later,
  // when the click no longer counts, so the page asks first.
  const heap = heapWatch();
  const cpu0 = await threadMs();
  const wakes0 = await page.evaluate(() => window.__wake.requested);
  await page.click('#mvp-convert');
  await progressAt(20);
  await setHidden(true);
  await progressAt(50);
  await setHidden(false);
  assert.equal(await page.evaluate(() => window.__wake.requested), wakes0 + 2, 'the screen lock is asked for again when the page is back on screen');
  await page.waitForSelector('#mvp-ask:not([hidden])', { timeout: 180000 });
  const cpuLong = (await threadMs()) - cpu0;
  assert.match(await page.textContent('#mvp-ask-text'), /^second\.mov will be about 63\d\.\d MB\. Choose where to save the MP4, so that it is written straight to disk\.$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mvp-ask-save', 'focus on the question');
  assert.equal((await card('second.mov')).state, 'Waiting for a place to save it…');
  await page.click('#mvp-ask-save');
  await waitIdle();
  const heapPeak = await heap.stop();
  assert.deepEqual(await page.evaluate(() => window.__pickerCalls), ['long.mp4', 'long.mp4', 'second.mp4']);
  assert.equal(await status(), '2 of 2 files converted.');
  assert.match((await card('long.mov')).state, /^Saved as long\.mp4, 4\.\d\d GB$/);
  assert.equal((await card('long.mov')).download, false, 'a saved file needs no Download button');
  for (const [i, name, f, frames] of [[1, 'long.mov', longFacts, 108000], [2, 'second.mov', midFacts, 15000]]) {
    const r = await page.evaluate(checkSave, [i, name]);
    assert.deepEqual([r.brand, r.mdatType, r.moovType, r.handler], ['isom', 'mdat', 'moov', 'vide'], `${name}: MP4 boxes`);
    assert.deepEqual([r.closed, r.aborted], [true, false], `${name}: committed`);
    assert.equal(r.samples, frames, `${name}: every frame`);
    assert.equal(r.sizesMatch, true, `${name}: sample sizes`);
    assert.equal(r.contiguous, true, `${name}: samples in order`);
    near(r.seconds, frames / 30, 0.01, `${name}: duration`);
    assert.equal(r.dataEnd - r.firstSampleAt, f.payload, `${name}: all media data`);
    assert.ok(r.checked > 1000 && r.wrong === 0, `${name}: ${r.wrong} of ${r.checked} checked bytes differ`);
    assert.equal(r.back, 1, `${name}: the only write that goes back is the header's`);
    if (frames === 108000) {
      assert.equal(r.chunkBox, 'co64', 'offsets past 4 GB need 64-bit chunk offsets');
      assert.ok(r.mdatSize > 2 ** 32, 'a 64-bit media data size');
    }
  }
  assert.ok(heapPeak < 400e6, `JavaScript heap peaked at ${Math.round(heapPeak / 1e6)} MB while copying 4.6 GB`);
  assert.ok(cpuLong < 120000, `main-thread CPU for the 4.6 GB copy: ${Math.round(cpuLong)} ms`);
  await page.evaluate(() => { window.__big = {}; window.__saves.length = 0; });
  await page.click('#mvp-clear');

  // ===================================================================================
  // 7. A 300 MB file where the browser has no save dialog (Safari, Firefox): built in the tab
  //    through a stream whose writes wait while its queue is full, then downloaded.
  // ===================================================================================
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const memFacts = await page.evaluate(buildBigMov, [intra, 7200, 40000, 'memory.mov']);
  await addBig(['memory.mov']);
  await waitRead();
  // The stream that builds the MP4 must make each write wait while its queue is full, so that
  // a Blob slower than the conversion (here 20 ms a chunk) holds only a few 4 MiB chunks back.
  // (The chunks live outside the JavaScript heap, so the heap peak below would not show them.)
  await page.evaluate(() => {
    window.__queued = 0;
    const enqueue = ReadableStreamDefaultController.prototype.enqueue, R = window.Response;
    ReadableStreamDefaultController.prototype.enqueue = function (chunk) {
      enqueue.call(this, chunk);
      if (chunk && chunk.byteLength >= 1 << 20) window.__queued = Math.max(window.__queued, 2 - this.desiredSize);
    };
    window.Response = function (body, init) {
      if (body instanceof ReadableStream) body = body.pipeThrough(new TransformStream({ transform: (c, out) => new Promise(r => setTimeout(() => { out.enqueue(c); r(); }, 20)) }));
      return new R(body, init);
    };
    window.Response.prototype = R.prototype;
    window.__unslow = () => { ReadableStreamDefaultController.prototype.enqueue = enqueue; window.Response = R; };
  });
  const heap2 = heapWatch();
  await page.click('#mvp-convert');
  await waitIdle();
  const heapPeak2 = await heap2.stop();
  const queued = await page.evaluate(() => { window.__unslow(); return window.__queued; });
  assert.ok(queued >= 1 && queued <= 3, `at most 3 chunks wait for a slow Blob (${queued})`);
  assert.ok(heapPeak2 < 250e6, `JavaScript heap peaked at ${Math.round(heapPeak2 / 1e6)} MB for a ${Math.round(memFacts.size / 1e6)} MB file`);
  assert.match((await card('memory.mov')).state, /^Done: memory\.mp4, 30\d\.\d MB$/);
  const mem = await downloadOf('memory.mov');
  out = facts(mem.file);
  const intraBuf = fs.readFileSync(fx('intra.mov'));
  const filler = Buffer.alloc(40000, 0xff);
  filler.writeUInt32BE(39996, 0);
  filler[4] = 0x0c;
  filler[39999] = 0x80;
  const intraPos = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', fx('intra.mov')])).packets;
  const expectHash = intraPos.map(p => 'SHA256:' + crypto.createHash('sha256').update(Buffer.concat([intraBuf.subarray(+p.pos, +p.pos + +p.size), filler])).digest('hex'));
  const got = out.streams[0].packets;
  assert.equal(got.length, 7200, 'every frame of the 300 MB file');
  assert.equal(got.every((p, i) => p.hash === expectHash[i % expectHash.length]), true, 'every packet byte for byte');
  near(out.duration, 240, 0.05, 'four minutes');
  fs.rmSync(path.dirname(mem.file), { recursive: true, force: true });
  await page.evaluate(() => { window.__big = {}; });
  assert.equal(await page.isHidden('#mvp-clear'), true, 'Remove all only shows for two files or more');
  await row('memory.mov').locator('.mvp-remove').click();
  assert.equal(await page.isHidden('#mvp-files-sec'), true);

  // ===================================================================================
  // 8. A file whose data stops arriving: the engine ends the job with a message, counting only
  //    the time the page is on screen; the page shows it.
  // ===================================================================================
  const hangPage = await page.context().newPage();
  await hangPage.clock.install();
  await hangPage.goto(url);
  await hangPage.evaluate(buildBigMov, [intra, 9000, 40000, 'stuck.mov']);
  // Reads of this file (through every stream made from it, also those made while probing) stop
  // answering once window.__hanging is set.
  await hangPage.evaluate(() => {
    const f = window.__big['stuck.mov'].file, hang = new WeakSet([f]);
    const slice = Blob.prototype.slice, stream = Blob.prototype.stream, ab = Blob.prototype.arrayBuffer;
    const never = () => new Promise(() => {});
    Blob.prototype.slice = function () { const s = slice.apply(this, arguments); if (hang.has(this)) hang.add(s); return s; };
    Blob.prototype.stream = function () {
      const native = stream.call(this);
      if (!hang.has(this)) return native;
      const r = native.getReader();
      return new ReadableStream({
        async pull(c) {
          if (window.__hanging) return never();
          const { done, value } = await r.read();
          if (window.__hanging) return never();
          if (done) c.close(); else c.enqueue(value);
        },
        cancel: reason => r.cancel(reason)
      });
    };
    Blob.prototype.arrayBuffer = function () { return hang.has(this) && window.__hanging ? never() : ab.call(this); };
    const dt = new DataTransfer();
    dt.items.add(f);
    const input = document.getElementById('mvp-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await waitRead(hangPage);
  await hangPage.evaluate(() => { window.__hanging = true; });
  await hangPage.click('#mvp-convert');
  await hangPage.waitForFunction(() => /stuck\.mov/.test(document.getElementById('mvp-progress-text').textContent));
  // Hidden, the page waits: a phone may pause it, and that is no failure.
  await hangPage.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await hangPage.clock.runFor(300000);
  assert.equal(await hangPage.isVisible('#mvp-cancel'), true, 'still waiting while hidden');
  await hangPage.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await hangPage.clock.runFor(95000);
  await waitIdle(hangPage);
  c = await card('stuck.mov', hangPage);
  assert.equal(c.msg, 'The conversion stopped making progress, so it was stopped: the file may be damaged.');
  assert.equal(c.state, 'Not converted');
  assert.equal(await status(hangPage), 'stuck.mov: The conversion stopped making progress, so it was stopped: the file may be damaged.');
  await hangPage.close();

  // ===================================================================================
  // 9. A phone browser without WebCodecs (Firefox for Android), with touch: the copy needs no
  //    codec, PCM still becomes AAC (with the WebAssembly encoder), ProRes is refused by name.
  // ===================================================================================
  const phone = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  await phone.addInitScript(() => {
    for (const k of ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder', 'VideoFrame', 'AudioData', 'EncodedVideoChunk', 'EncodedAudioChunk', 'showSaveFilePicker']) delete window[k];
  });
  await phone.addInitScript(instrument);
  const pp = await phone.newPage();
  await pp.goto(url);
  await add(['iphone-hevc.mov', 'h264-pcm16.mov', 'prores422-pcm24.mov', 'vp9-odd-size.mp4'], pp);
  c = await card('prores422-pcm24.mov', pp);
  assert.equal(c.msg, 'Its video is ProRes 422, which MP4 players do not show, and this browser cannot re-encode video. Open this page in Chrome, Edge, Firefox or Safari on a computer to turn it into H.264.');
  await pp.tap('#mvp-v-h264');
  assert.equal(await pp.isChecked('#mvp-v-h264'), true);
  assert.ok((await card('vp9-odd-size.mp4', pp)).notes.includes('This browser cannot re-encode this video to H.264, so it is copied as it is.'));
  for (const sel of ['#mvp-open', '#mvp-convert', '.mvp-remove >> nth=0', 'label.check >> nth=0']) {
    const box = await pp.locator(sel).boundingBox();
    assert.ok(box.height >= 44, `${sel} is ${box.height}px tall on a phone`);
  }
  await pp.tap('#mvp-convert');
  await waitIdle(pp);
  assert.equal(await status(pp), '3 of 3 files converted. Download them with the buttons under each file or all as a ZIP.');
  const phoneOut = {};
  for (const name of ['iphone-hevc.mov', 'h264-pcm16.mov', 'vp9-odd-size.mp4']) {
    phoneOut[name] = await download(() => row(name, pp).locator('.mvp-dl').tap(), pp);
    const box = await row(name, pp).locator('.mvp-dl').boundingBox();
    assert.ok(box.height >= 44, `Download is ${box.height}px tall on a phone`);
  }
  assert.equal(samePackets(iphoneSrc, facts(phoneOut['iphone-hevc.mov'].file), 'video', 0, 'phone copy').count, 60);
  out = facts(phoneOut['h264-pcm16.mov'].file);
  assert.equal(out.streams[1].codec, 'aac', 'PCM became AAC without WebCodecs');
  const snd = py('sound', fx('h264-pcm16.mov'), phoneOut['h264-pcm16.mov'].file);
  assert.equal(snd.lag, 0, 'in sync');
  assert.ok(snd.snr > 25, `sound SNR ${snd.snr}`);
  assert.equal(samePackets(facts(fx('vp9-odd-size.mp4')), facts(phoneOut['vp9-odd-size.mp4'].file), 'video', 0, 'phone VP9').count, 30);
  for (const width of [390, 320]) {
    await pp.setViewportSize({ width, height: 800 });
    assert.ok(await pp.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px with results`);
  }
  await phone.close();

  // ===================================================================================
  // 10. An iPhone keeps the MP4 in memory: a 1.2 GB result is warned about before converting.
  // ===================================================================================
  const iphoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
  await iphoneCtx.addInitScript(() => { delete window.showSaveFilePicker; });
  const ip = await iphoneCtx.newPage();
  await ip.goto(url);
  await ip.evaluate(buildBigMov, [intra, 28800, 40000, 'big-phone.mov']);
  await ip.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__big['big-phone.mov'].file);
    const input = document.getElementById('mvp-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await waitRead(ip);
  c = await card('big-phone.mov', ip);
  assert.ok(c.notes.some(t => /^The MP4 will be about 1\.2\d GB\. This browser builds it in memory, which may run out on files this large on an iPhone or iPad\. Chrome or Edge on a computer save it straight to disk instead\.$/.test(t)), c.notes.join(' | '));
  await iphoneCtx.close();

  // ===================================================================================
  // 11. Back and forward: the restored setting and the plans agree.
  // ===================================================================================
  await page.check('#mvp-v-h264');
  await page.goto(url.replace(/mov-to-mp4\/$/, ''));
  await page.goBack();
  assert.equal(await page.isChecked('#mvp-v-h264'), true, 'the choice is restored');
  await add(['av1-opus.mp4']);
  assert.match((await card('av1-opus.mp4')).plan, /^Re-encode the video to H\.264 and the sound to AAC/, 'the plan follows the restored choice');
  said = await page.evaluate(() => window.__live.filter(x => x[0] === 'mvp-status').map(x => x[1]));
  assert.ok(said.every((t, i) => i === 0 || t !== said[i - 1]), 'no announcement repeated');

  // ===================================================================================
  // 12. More files: a picture that stops before the sound, an older QuickTime movie with no
  //     ftyp box, a HEIC photo and an AVIF image, sound the page cannot read, three files with
  //     the same name, and 10-bit HDR made into H.264.
  // ===================================================================================
  await row('av1-opus.mp4').locator('.mvp-remove').click();
  await page.check('#mvp-v-copy');
  await add(['short-video.mov', 'old-quicktime.mov', 'IMG_0001.HEIC', 'photo.avif', 'alac-only.mov', 'mp3-in-mov.mov']);
  c = await card('IMG_0001.HEIC');
  assert.deepEqual([c.plan, c.refused, c.msg], ['Not supported', true, 'This is a HEIC photo, not a video. The video of a Live Photo is a separate MOV file. To turn it into a JPG, use HEIC to JPG.'], 'a photo is called a photo');
  assert.equal(await row('IMG_0001.HEIC').locator('.mvp-file-msg a').getAttribute('href'), '/heic-to-jpg/');
  c = await card('photo.avif');
  assert.deepEqual([c.plan, c.refused, c.msg], ['Not supported', true, 'This is an AVIF image, not a video. To turn it into a JPG, use AVIF to JPG.']);
  assert.equal(await row('photo.avif').locator('.mvp-file-msg a').getAttribute('href'), '/avif-to-jpg/');
  for (const [name, label] of [['alac-only.mov', 'Apple Lossless (ALAC)'], ['mp3-in-mov.mov', 'MP3']]) {
    c = await card(name);
    assert.match(c.plan, /^Copy the video, without its sound · about [\d.]+ KB$/, `${name}: the plan says the MP4 is silent`);
    assert.deepEqual(c.notes, [`Left out: a sound track in ${label}, which this page cannot read.`, 'The MP4 will have no sound.'], name);
  }
  c = await card('short-video.mov');
  assert.equal(c.tracks, 'Video: H.264 · Sound: AAC mono');
  const shortPlan = +/about (\d+) KB$/.exec(c.plan)[1];
  assert.match((await card('old-quicktime.mov')).plan, /^Copy, quality unchanged · about \d+ KB$/, 'a movie without an ftyp box is read');
  await page.click('#mvp-convert');
  await waitIdle();
  assert.equal(await status(), '4 of 4 files converted. Download them with the buttons under each file or all as a ZIP.');
  // 1 s of picture and 5 s of sound: both copied whole, and the size estimate counts the picture's second only.
  const shortSrc = facts(fx('short-video.mov'));
  const shortOut = await downloadOf('short-video.mov');
  out = facts(shortOut.file);
  assert.equal(samePackets(shortSrc, out, 'video', 0, 'short picture').count, 30, 'every video packet');
  assert.equal(samePackets(shortSrc, out, 'audio', 0, 'longer sound').count, shortSrc.streams[1].packets.length, 'every sound packet');
  near(out.duration, 5, 0.05, 'the MP4 runs as long as its sound');
  near(shortPlan, fs.statSync(shortOut.file).size / 1000, fs.statSync(shortOut.file).size / 1000 * 0.25, 'size estimate');
  // The engine's own check of a finished MP4 (TTVideo.checkIndex, which later pages use too): a
  // track that is missing, extra or much shorter than expected fails it.
  const verdicts = await page.evaluate(b64 => {
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const check = (...want) => TTVideo.checkIndex(bytes, want.map(([handler, seconds]) => ({ handler, seconds })));
    return [check(['vide', 1], ['soun', 5]), check(['vide', 5], ['soun', 5]), check(['vide', 1], ['soun', 5], ['soun', 5]), check(['vide', 1])].map(r => [r.ok, r.why]);
  }, fs.readFileSync(shortOut.file).toString('base64'));
  assert.deepEqual(verdicts.map(v => v[0]), [true, false, false, false], JSON.stringify(verdicts));
  assert.match(verdicts[1][1], /^vide track 1 lasts 1\.0\d s of 5\.00 s$/);
  assert.deepEqual([verdicts[2][1], verdicts[3][1]], ['soun: 1 of 2 tracks', 'soun: 1 of 0 tracks']);
  // No ftyp box: copied packet for packet, with the date in its index.
  const oldSrc = facts(fx('old-quicktime.mov'));
  out = facts((await downloadOf('old-quicktime.mov')).file);
  assert.equal(fs.readFileSync(fx('old-quicktime.mov')).toString('latin1', 4, 8), 'wide', 'the source starts without ftyp');
  assert.equal(out.brand, 'isom');
  for (const kind of ['video', 'audio']) assert.equal(samePackets(oldSrc, out, kind, 0, 'old QuickTime').count, oldSrc.streams.find(s => s.type === kind).packets.length, `every ${kind} packet`);
  assert.equal(out.tags.creation_time, '2004-05-06T07:08:09.000000Z');
  for (const name of ['alac-only.mov', 'mp3-in-mov.mov']) {
    out = facts((await downloadOf(name)).file);
    assert.deepEqual(out.streams.map(s => s.type), ['video'], `${name}: the picture only, as the plan said`);
    assert.equal(samePackets(facts(fx(name)), out, 'video', 0, name).count, 30);
  }
  // Three files called clip.mov (or CLIP.MOV) from different folders: three different MP4 names.
  await page.click('#mvp-clear');
  const clipBytes = ['iphone-hevc.mov', 'rotated-180.mov', 'aac-alac.mov'].map(n => fs.readFileSync(fx(n)));
  await page.setInputFiles('#mvp-file', [['clip.mov', 0], ['clip.mov', 1], ['CLIP.MOV', 2]].map(([name, i]) => ({ name, mimeType: 'video/quicktime', buffer: clipBytes[i] })));
  await waitRead();
  await page.click('#mvp-convert');
  await waitIdle();
  const clipNames = [];
  for (let i = 0; i < 3; i++) clipNames.push((await download(() => page.locator('.mvp-dl').nth(i).click())).name);
  assert.deepEqual(clipNames, ['clip.mp4', 'clip (2).mp4', 'CLIP (3).mp4'], 'each MP4 has its own name');
  // Files removed while the batch waits (here, for a place to save a big MP4) are not counted:
  // neither one already converted nor one still waiting its turn.
  await page.click('#mvp-clear');
  await page.evaluate(mockPicker);
  await page.evaluate(buildBigMov, [intra, 15000, 40000, 'big.mov']);
  await page.evaluate(b64 => {
    const small = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const dt = new DataTransfer();
    for (const f of [new File([small], 'first.mov'), new File([small], 'second.mov'), window.__big['big.mov'].file, new File([small], 'last.mov')]) dt.items.add(f);
    const input = document.getElementById('mvp-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, fs.readFileSync(fx('iphone-hevc.mov')).toString('base64'));
  await waitRead();
  await page.click('#mvp-convert');
  await page.waitForSelector('#mvp-ask:not([hidden])', { timeout: 60000 });
  assert.match((await card('first.mov')).state, /^Done: first\.mp4/);
  await row('first.mov').locator('.mvp-remove').click();
  await row('last.mov').locator('.mvp-remove').click();
  await page.click('#mvp-ask-save');
  await waitIdle();
  assert.equal(await status(), '2 of 2 files converted. Download them with the buttons under each file.', 'the removed files are not counted');
  assert.match((await card('big.mov')).state, /^Saved as big\.mp4, 6\d\d\.\d MB$/);
  await page.evaluate(() => { window.__big = {}; window.__saves.length = 0; delete window.showSaveFilePicker; });
  await page.click('#mvp-clear');
  // "Plays everywhere" for 10-bit HDR that this browser decodes: the note says it becomes standard
  // range, and so it does: the H.264 is not tagged HLG or PQ.
  await page.check('#mvp-v-h264');
  await add(['vp9-hlg10.mp4', 'av1-pq10.mp4']);
  for (const name of ['vp9-hlg10.mp4', 'av1-pq10.mp4']) assert.ok((await card(name)).notes.includes('HDR becomes standard range (SDR) in H.264, so the picture can look duller.'), name);
  await page.click('#mvp-convert');
  await waitIdle();
  for (const name of ['vp9-hlg10.mp4', 'av1-pq10.mp4']) {
    const r = await downloadOf(name);
    const v = facts(r.file).streams[0];
    assert.deepEqual([v.codec, v.width, v.height, /^yuvj?420p$/.test(v.pix_fmt)], ['h264', 320, 180, true], `${name}: 8-bit H.264`);
    assert.equal(v.primaries, 'bt709', `${name}: standard-range colours, not ${v.primaries}`);
    assert.ok(/^(bt709|iec61966-2-1|smpte170m)$/.test(v.transfer), `${name}: a standard-range transfer, not ${v.transfer}`);
    fr = py('frames', fx(name), r.file);
    assert.equal(fr.frames[1], fr.frames[0], `${name}: every frame`);
    assert.deepEqual(fr.times[1].map(t => t.toFixed(3)), fr.times[0].map(t => t.toFixed(3)), `${name}: frame times`);
    const shown = await plays(r.url);
    assert.deepEqual([shown.w, shown.h], [320, 180], `${name}: Chromium shows it`);
    assert.ok(shown.frames > 0, `${name}: Chromium decodes frames`);
  }

  // ===================================================================================
  // 13. The ProRes decoder or the AAC encoder does not load (a dropped connection): the page says
  //     so, rather than blaming the browser's H.264 encoder or the file.
  // ===================================================================================
  const offline = await page.context().newPage();
  await offline.route(/mediabunny-(aac-encoder|prores)\.min\.js$/, r => r.abort());
  await offline.goto(url);
  await add(['prores422-pcm24.mov', 'h264-pcm16.mov'], offline);
  const noLibrary = 'The converter could not be loaded. Check the connection and reload the page.';
  c = await card('prores422-pcm24.mov', offline);
  assert.deepEqual([c.plan, c.msg], ['Not supported', noLibrary], 'no ProRes decoder');
  assert.match((await card('h264-pcm16.mov', offline)).plan, /^Copy the video, re-encode the sound to AAC/);
  await offline.click('#mvp-convert');
  await waitIdle(offline);
  c = await card('h264-pcm16.mov', offline);
  assert.deepEqual([c.state, c.msg, c.download], ['Not converted', noLibrary, false], 'no AAC encoder');
  assert.equal(await status(offline), 'h264-pcm16.mov: ' + noLibrary);
  await offline.close();
}
