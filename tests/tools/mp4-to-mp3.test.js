const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { devices } = require('playwright');

// The samples and the facts checked against them come from
// tests/fixtures/mp4-to-mp3/make_fixtures.py (ffmpeg and ffprobe): durations,
// codecs, the SHA-256 of every AAC packet in clip.mp4, and peak levels from
// ffmpeg's astats. Outputs are checked by parsing them here (MPEG frame
// headers, ID3v2.4 frames, RIFF chunks, MP4 boxes, the ZIP directory) and by
// decoding them with the browser's own decoder, which shares no code with the
// LAME encoder that wrote them: duration, tone frequency (zero crossings) and
// RMS per channel. Source tones in clip.mp4: 440 Hz for 0-2 s, 660 Hz for
// 2-4 s, 880 Hz for 4-6 s; left at 0.5, right at 0.25 (RMS 0.354 and 0.177).
module.exports = async ({ page, open, assert, fixtures }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const F = name => path.join(fixtures, name);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);

  const instrument = () => {
    // Bytes read from files, scheduled preview buffers, gain automation and the wake lock.
    window.__read = 0;
    const rd = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function () {
      return rd.call(this).then(r => { if (r && r.value && r.value.byteLength) window.__read += r.value.byteLength; return r; });
    };
    const ab = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { return ab.call(this).then(b => { window.__read += b.byteLength; return b; }); };
    window.__starts = [];
    const st = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, off, dur) {
      if (!(this.context instanceof OfflineAudioContext)) window.__starts.push({ when, off: off || 0, dur, now: this.context.currentTime });
      return st.apply(this, arguments);
    };
    window.__ramps = [];
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime']) {
      const f = AudioParam.prototype[m];
      AudioParam.prototype[m] = function (v, t) { window.__ramps.push([m, v, t]); return f.apply(this, arguments); };
    }
    window.__wake = { requested: 0, released: 0 };
    if (navigator.wakeLock) {
      navigator.wakeLock.request = () => {
        window.__wake.requested++;
        return Promise.resolve({ release() { window.__wake.released++; return Promise.resolve(); }, addEventListener() {} });
      };
    }
    // Safari's audio session (iOS mutes web audio in silent mode unless it is 'playback').
    window.__session = [];
    let sessionType = 'auto';
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: {
      get type() { return sessionType; }, set type(v) { sessionType = v; window.__session.push(v); }
    } });
    // What screen readers are told: every change to a live region.
    window.__live = [];
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => {
      const seen = new Set();
      for (const m of ms) {
        const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const live = n && n.closest('[role=alert],[role=status],[aria-live]');
        if (live && live.textContent && !seen.has(live)) { seen.add(live); window.__live.push(live.textContent); }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true }));
  };
  await page.addInitScript(instrument);
  // Listening from the start lets Playwright intercept the file picker before
  // any key is pressed (a listener added just before the key press can be late).
  let gotChooser;
  const chooserReady = new Promise(r => { gotChooser = r; });
  page.on('filechooser', fc => gotChooser(fc));
  await open();

  // ---------- helpers ----------
  const text = (sel, p = page) => p.locator(sel).textContent();
  const row = (name, p = page) => p.locator('.m2m-file').filter({ has: p.locator('.m2m-file-name').getByText(name, { exact: true }) });
  const card = async (name, p = page) => {
    const r = row(name, p);
    return {
      info: await r.locator('.m2m-file-info').textContent(), state: await r.locator('.m2m-file-state').textContent(),
      msg: await r.locator('.m2m-file-msg').textContent(), current: await r.getAttribute('aria-current'),
      download: await r.locator('.m2m-dl').isVisible()
    };
  };
  const waitRead = (p = page) => p.waitForFunction(() => document.querySelectorAll('.m2m-file').length > 0 &&
    ![...document.querySelectorAll('.m2m-file-state')].some(e => e.textContent === 'Reading…'), null, { timeout: 20000 });
  const waitIdle = (p = page) => p.waitForFunction(() => document.getElementById('m2m-cancel').hidden &&
    document.getElementById('m2m-convert').textContent !== 'Converting…', null, { timeout: 60000 });
  const waitWave = (p = page) => p.waitForFunction(() => document.getElementById('m2m-wave-msg').textContent === '' &&
    document.getElementById('m2m-peak').textContent !== '', null, { timeout: 20000 });
  const download = async (action, p = page) => {
    // Names the line of the test that asked, which a timeout's stack does not.
    const caller = (new Error().stack.split('\n')[2] || '').trim();
    try {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), action()]);
      return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
    } catch (e) {
      throw new Error(`${String(e.message).split('\n')[0]} (download ${caller})`);
    }
  };
  const convert = async (p = page) => { await p.click('#m2m-convert'); await waitIdle(p); };
  // The site scrolls smoothly, so a focused element may still be moving: wait
  // until the page has not scrolled for a few frames before measuring boxes.
  const settle = (p = page) => p.evaluate(() => new Promise(resolve => {
    let last = NaN, same = 0;
    const tick = () => { if (scrollY === last) { if (++same > 4) return resolve(); } else { same = 0; last = scrollY; } requestAnimationFrame(tick); };
    tick();
  }));
  const typeInto = async (sel, value, p = page) => {
    await p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  const errorOf = async (sel, p = page) => ({
    invalid: await p.getAttribute(sel, 'aria-invalid'),
    describedby: await p.getAttribute(sel, 'aria-describedby')
  });

  // MPEG-1/2 Layer III frame headers and the ID3v2 tag in front of them.
  const synch = b => ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f);
  function parseMp3(buf) {
    let off = 0;
    const tags = {};
    let id3 = 0;
    if (buf.toString('latin1', 0, 3) === 'ID3') {
      id3 = buf[3];
      const size = synch(buf.subarray(6, 10));
      for (let q = 10; q + 10 <= 10 + size;) {
        const id = buf.toString('latin1', q, q + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const len = id3 === 4 ? synch(buf.subarray(q + 4, q + 8)) : buf.readUInt32BE(q + 4);
        const body = buf.subarray(q + 10, q + 10 + len);
        if (id[0] === 'T' && id !== 'TXXX') {
          assert.equal(body[0] === 3 || body[0] === 0, true, `${id} text encoding ${body[0]}`);
          tags[id] = (body[0] === 3 ? body.toString('utf8', 1) : body.toString('latin1', 1)).replace(/\0+$/, '');
        } else tags[id] = body;
        q += 10 + len;
      }
      off = 10 + size;
    }
    const BR = { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000] };
    const frames = [];
    while (off + 4 <= buf.length) {
      const h = buf.readUInt32BE(off);
      if ((h >>> 21) !== 0x7ff) break;
      const ver = (h >>> 19) & 3, layer = (h >>> 17) & 3, kbps = BR[ver][(h >>> 12) & 15], sr = SR[ver][(h >>> 10) & 3];
      const mode = (h >>> 6) & 3, pad = (h >>> 9) & 1;
      const len = Math.floor((ver === 3 ? 144000 : 72000) * kbps / sr) + pad;
      const side = ver === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17);
      frames.push({ ver, layer, kbps, sr, mode, tag: buf.toString('latin1', off + 4 + side, off + 8 + side) });
      off += len;
    }
    return { id3, tags, frames, rest: buf.length - off, tail: buf.toString('latin1', off, off + 3) };
  }
  function checkMp3(buf, { kbps, sr, mono, seconds }, what) {
    const m = parseMp3(buf);
    assert.equal(m.id3, 4, `${what}: ID3v2.4 tag`);
    assert.ok(m.frames.length > 3, `${what}: MPEG frames found`);
    assert.ok(m.rest === 0 || (m.rest === 128 && m.tail === 'TAG'), `${what}: ${m.rest} bytes after the last frame`);
    assert.ok(['Xing', 'Info'].includes(m.frames[0].tag), `${what}: Xing or Info frame first, got ${m.frames[0].tag}`);
    // The first frame carries the Xing/Info header, not sound; its bitrate only has to fit it.
    for (const [i, f] of m.frames.entries()) {
      assert.equal(f.ver, 3, `${what}: MPEG-1`);
      assert.equal(f.layer, 1, `${what}: Layer III`);
      if (i > 0) assert.equal(f.kbps, kbps, `${what}: frame ${i} is ${f.kbps} kbps, not a constant ${kbps} kbps`);
      assert.equal(f.sr, sr, `${what}: ${sr} Hz`);
      assert.equal(f.mode === 3, mono, `${what}: channel mode ${f.mode}`);
    }
    const audioFrames = m.frames.length - 1;
    const need = Math.ceil(seconds * sr / 1152);
    assert.ok(audioFrames >= need && audioFrames <= need + 3, `${what}: ${audioFrames} audio frames for ${seconds} s (at least ${need})`);
    return m;
  }
  // Decodes a file with the page's browser and measures windows [from, to] in seconds.
  const analyse = (bytes, sr, wins, p = page) => p.evaluate(async ([b64, sr, wins]) => {
    const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ab = await new OfflineAudioContext(1, 1, sr).decodeAudioData(u8.buffer);
    const out = { dur: ab.duration, ch: ab.numberOfChannels, win: [] };
    for (const [a, b] of wins) {
      const i0 = Math.round(a * sr), i1 = Math.min(ab.length, Math.round(b * sr)), rms = [], freq = [];
      for (let c = 0; c < ab.numberOfChannels; c++) {
        const d = ab.getChannelData(c);
        let s = 0;
        const xs = [];
        for (let i = i0; i < i1; i++) s += d[i] * d[i];
        for (let i = i0 + 1; i < i1; i++) if (d[i - 1] < 0 && d[i] >= 0) xs.push(i - 1 + d[i - 1] / (d[i - 1] - d[i]));
        rms.push(Math.sqrt(s / (i1 - i0)));
        freq.push(xs.length > 2 ? (xs.length - 1) / ((xs[xs.length - 1] - xs[0]) / sr) : 0);
      }
      out.win.push({ rms, freq });
    }
    return out;
  }, [bytes.toString('base64'), sr, wins]);
  // RIFF WAVE: format and the sample data.
  function parseWav(buf) {
    assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
    assert.equal(buf.toString('latin1', 8, 12), 'WAVE');
    const out = { info: {} };
    for (let q = 12; q + 8 <= buf.length;) {
      const id = buf.toString('latin1', q, q + 4), len = buf.readUInt32LE(q + 4), body = buf.subarray(q + 8, q + 8 + len);
      if (id === 'fmt ') Object.assign(out, { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sr: body.readUInt32LE(4), bits: body.readUInt16LE(14) });
      if (id === 'data') out.data = new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + len));
      if (id === 'ID3 ' || id === 'id3 ') out.id3 = parseMp3(Buffer.from(body)).tags;
      if (id === 'LIST' && body.toString('latin1', 0, 4) === 'INFO') {
        for (let r = 4; r + 8 <= body.length;) {
          const k = body.toString('latin1', r, r + 4), n = body.readUInt32LE(r + 4);
          out.info[k] = body.toString('utf8', r + 8, r + 8 + n).replace(/\0+$/, '');
          r += 8 + n + (n & 1);
        }
      }
      q += 8 + len + (len & 1);
    }
    return out;
  }
  // MP4: the samples of the first track, located through stsz, stsc and stco.
  function mp4Samples(buf) {
    const boxes = {};
    (function walk(a, b) {
      for (let q = a; q + 8 <= b;) {
        let len = buf.readUInt32BE(q), hdr = 8;
        const typ = buf.toString('latin1', q + 4, q + 8);
        if (len === 1) { len = Number(buf.readBigUInt64BE(q + 8)); hdr = 16; }
        if (!boxes[typ]) boxes[typ] = buf.subarray(q + hdr, q + len);
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(typ)) walk(q + hdr, q + len);
        q += len;
      }
    })(0, buf.length);
    const stsz = boxes.stsz, stsc = boxes.stsc, stco = boxes.stco || boxes.co64;
    const sizes = [];
    const fixed = stsz.readUInt32BE(4), count = stsz.readUInt32BE(8);
    for (let i = 0; i < count; i++) sizes.push(fixed || stsz.readUInt32BE(12 + 4 * i));
    const chunks = [];
    for (let i = 0, n = stco.readUInt32BE(4); i < n; i++) chunks.push(boxes.co64 ? Number(stco.readBigUInt64BE(8 + 8 * i)) : stco.readUInt32BE(8 + 4 * i));
    const runs = [];
    for (let i = 0, n = stsc.readUInt32BE(4); i < n; i++) runs.push([stsc.readUInt32BE(8 + 12 * i), stsc.readUInt32BE(12 + 12 * i)]);
    const out = [];
    let s = 0;
    chunks.forEach((off, ci) => {
      let per = 0;
      for (const [first, n] of runs) if (first <= ci + 1) per = n;
      for (let k = 0; k < per && s < sizes.length; k++, s++) { out.push(buf.subarray(off, off + sizes[s])); off += sizes[s]; }
    });
    return { ftyp: boxes.ftyp, stsd: boxes.stsd, samples: out };
  }
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  // The picture inside an ID3 APIC frame: after the encoding, MIME type, picture type and description.
  const apicImage = body => {
    let q = body.indexOf(0, 1) + 2;
    if (body[0] === 1 || body[0] === 2) { while (body[q] || body[q + 1]) q += 2; q += 2; } else q = body.indexOf(0, q) + 1;
    return body.subarray(q);
  };
  const mmss = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
  // A RIFF WAVE file of 16-bit PCM made from one function per channel.
  const dropWav = (name, sr, seconds, chans, p = page) => p.evaluate(([name, sr, seconds, chans]) => {
    const fns = chans.map(src => new Function('t', 'return ' + src));
    const n = Math.round(sr * seconds), ch = fns.length, buf = new ArrayBuffer(44 + n * ch * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * ch * 2, true);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) v.setInt16(44 + (i * ch + c) * 2, Math.round(fns[c](i / sr) * 32767), true);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], name, { type: 'audio/wav' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [name, sr, seconds, chans]);

  // ---------- Initial state: nothing loaded until a file is added ----------
  assert.equal(await text('#m2m-convert'), 'Convert to MP3');
  assert.equal(await page.isDisabled('#m2m-convert'), true);
  assert.equal(await page.isVisible('#m2m-edit'), false);
  assert.equal(await page.isVisible('#m2m-files-sec'), false);
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 192 kbps takes about 1.44 MB a minute. A higher bitrate cannot add detail that the source does not have.');
  assert.equal(await page.evaluate(() => typeof window.Mediabunny), 'undefined', 'the converter library is not loaded on page load');
  assert.equal(await page.locator('script[src*="mediabunny"]').count(), 0);

  // ---------- Files that cannot be converted, each with its reason ----------
  await page.setInputFiles('#m2m-file', ['protected.mp4', 'silent-video.mp4', 'not-media.mp4', 'dolby.mkv'].map(F));
  await waitRead();
  await page.waitForFunction(() => document.getElementById('m2m-status').textContent !== '');
  assert.equal(await text('#m2m-status'), 'Added 4 files, 4 of them cannot be converted to MP3: see the message under each.');
  assert.equal(await page.evaluate(() => typeof window.Mediabunny), 'object');
  assert.equal((await card('protected.mp4')).msg, 'This file is protected with DRM (encrypted), so its sound cannot be read. Films and music bought or rented from a store are usually protected.');
  assert.equal((await card('silent-video.mp4')).msg, 'This video has no sound track, so there is no audio to save.');
  assert.equal((await card('not-media.mp4')).msg, 'This is not a video or audio file that this page can read. It reads MP4, MOV, WebM, MKV, M4A, MP3, WAV, OGG, FLAC and MPEG-TS files.');
  let c = await card('dolby.mkv');
  assert.equal(c.info, '0:01.995 · AC-3 (Dolby Digital) · 48 kHz · stereo');
  assert.equal(c.msg, 'This browser cannot decode AC-3 (Dolby Digital) audio, so it cannot make MP3 or WAV from this file.');
  assert.equal(c.state, '', 'a file that cannot become MP3 is not called ready');
  assert.equal(c.current, 'true', 'the only readable file is the one being edited');
  assert.equal(await text('#m2m-wave-msg'), 'No waveform: this browser cannot decode AC-3 (Dolby Digital) audio. You can still type the start and end.');
  assert.equal(await page.isDisabled('#m2m-play'), true);
  assert.equal(await page.isDisabled('#m2m-convert'), true, 'nothing here can be converted to MP3');
  await page.evaluate(() => { window.__live = []; });
  await page.check('#m2m-f-copy');
  assert.equal((await card('dolby.mkv')).msg, 'Its audio is AC-3 (Dolby Digital), not AAC, so it cannot be copied into an .m4a file. Choose MP3 or WAV for this file.');
  // Screen readers hear one sentence that says what the change means, not
  // every file's message without its file name.
  assert.deepEqual(await page.evaluate(() => window.__live), ['One file cannot be saved as original audio: see the message under it.']);
  assert.equal(await page.isDisabled('#m2m-convert'), true);
  await page.check('#m2m-f-mp3');
  assert.equal(await page.locator('.m2m-file').count(), 4);
  await page.click('#m2m-clear');
  assert.equal(await page.locator('.m2m-file').count(), 0);
  assert.equal(await page.isVisible('#m2m-files-sec'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-open');

  // ---------- Incomplete and empty files say so ----------
  // cut-short.mp4 is clip.mp4 cut off after 50,000 bytes: its index still lists
  // 6 s of sound, but the data holds only what ffmpeg decodes from it.
  const shortSec = exp['cut-short.mp4'].decoded_samples / 48000;
  await page.setInputFiles('#m2m-file', F('cut-short.mp4'));
  await waitRead();
  c = await card('cut-short.mp4');
  assert.equal(c.info.split(' · ')[0], mmss(shortSec), 'the length is what the file holds, not what its index lists');
  const SHORT = `This file is incomplete, perhaps a copy or download that did not finish: it should hold 0:06.000 of sound, but its data stops at ${mmss(shortSec)}. That part can still be converted.`;
  assert.equal(c.msg, SHORT);
  assert.equal(await text('#m2m-status'), `Added cut-short.mp4: ${mmss(shortSec)}, AAC stereo. ${SHORT}`);
  assert.equal(await page.inputValue('#m2m-end'), mmss(shortSec));
  await page.check('#m2m-f-wav');
  await convert();
  const shortWav = parseWav((await download(() => row('cut-short.mp4').locator('.m2m-dl').click())).bytes);
  assert.equal(shortWav.data.length / 2, exp['cut-short.mp4'].decoded_samples, 'the WAV holds every sample there is, and no more');
  await page.check('#m2m-f-mp3');
  // The first half of clip.mp4 has no index at all (it is at the end), a WAV
  // header with no samples has an empty sound track, and a copy of
  // cut-short.mp4 can be converted, with a warning.
  await page.evaluate(([b64, b64short]) => {
    const clip = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const head = new DataView(new ArrayBuffer(44)), w = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); head.setUint32(4, 36, true); w(8, 'WAVEfmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 2, true);
    head.setUint32(24, 44100, true); head.setUint32(28, 176400, true); head.setUint16(32, 4, true); head.setUint16(34, 16, true); w(36, 'data');
    const dt = new DataTransfer();
    dt.items.add(new File([clip.subarray(0, clip.length >> 1)], 'half.mp4', { type: 'video/mp4' }));
    dt.items.add(new File([head.buffer], 'empty.wav', { type: 'audio/wav' }));
    dt.items.add(new File([Uint8Array.from(atob(b64short), ch => ch.charCodeAt(0))], 'cut-short copy.mp4', { type: 'video/mp4' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [fs.readFileSync(F('clip.mp4')).toString('base64'), fs.readFileSync(F('cut-short.mp4')).toString('base64')]);
  await waitRead();
  assert.equal((await card('half.mp4')).msg, 'No sound or video was found in this file. It may be incomplete, such as a copy or download that did not finish, or damaged.');
  assert.equal((await card('empty.wav')).msg, 'Its sound track is empty, so there is no audio to save. The file may be incomplete or damaged.');
  assert.equal(await text('#m2m-status'), 'Added 3 files, 2 of them cannot be converted to MP3 and 1 more has a warning: see the message under each.');
  await page.click('#m2m-clear');

  // ---------- Keyboard: Choose files opens the file picker ----------
  await page.focus('#m2m-open');
  await page.keyboard.press('Enter');
  const chooser = await Promise.race([chooserReady, new Promise((_, no) => setTimeout(() => no(new Error('Enter on Choose files opened no file picker')), 10000))]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(F('clip.mp4'));
  await waitRead();
  await waitWave();
  c = await card('clip.mp4');
  assert.equal(c.info, `0:06.000 · AAC · 48 kHz · stereo · ${Math.round(exp['clip.mp4'].bit_rate / 1000)} kbps`);
  assert.equal(c.state, 'Ready');
  assert.equal(await text('#m2m-status'), 'Added clip.mp4: 0:06.000, AAC stereo.');
  assert.equal(await page.inputValue('#m2m-start'), '0:00.000');
  assert.equal(await page.inputValue('#m2m-end'), '0:06.000');
  assert.equal(await text('#m2m-scale-end'), '0:06');
  assert.equal(await page.inputValue('#m2m-title'), 'Fixture clip', 'tags are read from the file');
  assert.equal(await page.inputValue('#m2m-artist'), 'Test Artist');
  // ffmpeg's astats: the decoded sound peaks at -1.106 dBFS, so 113% would reach full scale.
  const peakAll = exp['clip.mp4'].peak_db;
  assert.equal(await text('#m2m-peak'), `Loudest point at this volume: −${Math.abs(peakAll).toFixed(1)} dB of full scale. Up to ${Math.floor(100 / 10 ** (peakAll / 20) / 5) * 5}% stays clear of distortion.`);
  assert.equal(await text('#m2m-estimate'), 'Estimated size: about 144 KB as clip.mp3.');

  // ---------- Typed times: formats, decimal commas and every error ----------
  const timeErr = () => text('#m2m-time-error');
  await typeInto('#m2m-start', 'abc');
  assert.equal(await timeErr(), 'Type the start as minutes:seconds, such as 1:05.5, or as seconds, such as 65.5.');
  assert.deepEqual(await errorOf('#m2m-start'), { invalid: 'true', describedby: 'm2m-time-hint m2m-time-error' });
  await typeInto('#m2m-start', '5²');
  assert.equal(await timeErr(), 'Type the start as minutes:seconds, such as 1:05.5, or as seconds, such as 65.5.', 'a raised 2 is not a digit');
  await typeInto('#m2m-start', '1\t2');
  assert.notEqual(await timeErr(), '', 'a tab inside a time is refused');
  await typeInto('#m2m-start', '0:75');
  assert.equal(await timeErr(), 'Minutes and seconds go up to 59: write 1:15 rather than 0:75.');
  await typeInto('#m2m-start', '5,95');
  assert.equal(await timeErr(), 'The start must be at least 0.1 seconds before the end (0:06.000).');
  // Digits from a phone set to Arabic-Indic digits, with the Arabic decimal mark.
  await typeInto('#m2m-start', '\u0660:\u0660\u0661\u066B\u0662');
  assert.equal(await timeErr(), '', 'Arabic-Indic digits');
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuenow'), '1.2');
  await typeInto('#m2m-start', '0,500');
  assert.equal(await timeErr(), '', '0,500 is half a second, not 500');
  assert.equal(await page.getAttribute('#m2m-start', 'aria-invalid'), null);
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuenow'), '0.5');
  await typeInto('#m2m-end', '9');
  assert.equal(await timeErr(), 'The file is only 0:06.000 long, so the end cannot be later than that.');
  assert.equal(await page.getAttribute('#m2m-end', 'aria-invalid'), 'true');
  await typeInto('#m2m-end', '0:00:05.9999');
  assert.equal(await timeErr(), '');
  assert.equal(await page.getAttribute('#m2m-h-end', 'aria-valuetext'), '0:06.000', '5.9999 s rounds to 6.000');
  await typeInto('#m2m-end', '0:00.55');
  assert.equal(await timeErr(), 'The end must be at least 0.1 seconds after the start (0:00.500).');
  await typeInto('#m2m-end', '5.5');
  assert.equal(await text('#m2m-len'), '0:05.000');
  // A start that was refused keeps its message when the end is changed next.
  await typeInto('#m2m-start', 'abc');
  await typeInto('#m2m-end', '5');
  assert.equal(await timeErr(), 'Type the start as minutes:seconds, such as 1:05.5, or as seconds, such as 65.5.', 'the start is still wrong');
  assert.equal(await page.getAttribute('#m2m-start', 'aria-invalid'), 'true');
  // A start refused for lying past the end takes effect once the end moves past it.
  await typeInto('#m2m-start', '5,5');
  assert.equal(await timeErr(), 'The start must be at least 0.1 seconds before the end (0:05.000).');
  await typeInto('#m2m-end', '5.9');
  assert.equal(await timeErr(), '');
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuenow'), '5.5');
  await typeInto('#m2m-start', '0,500');
  await typeInto('#m2m-end', '5.5');
  assert.equal(await text('#m2m-len'), '0:05.000');
  // ↑ and ↓ in a time field, then the value is tidied when the field is left.
  await page.focus('#m2m-start');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  assert.equal(await page.inputValue('#m2m-start'), '0:01.600');
  await typeInto('#m2m-start', '83,5');
  assert.equal(await timeErr(), 'The file is only 0:06.000 long, so the start cannot be later than that.');
  await page.fill('#m2m-start', '2');
  await page.locator('#m2m-start').blur();
  assert.equal(await page.inputValue('#m2m-start'), '0:02.000');

  // ---------- Handles: keyboard ----------
  await page.focus('#m2m-h-start');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuetext'), '0:02.100');
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuetext'), '0:01.100');
  await page.keyboard.press('PageDown');
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuenow'), '0', 'clamped at the start of the file');
  await page.keyboard.press('End');
  assert.equal(await page.getAttribute('#m2m-h-start', 'aria-valuetext'), '0:05.400', 'End puts the start 0.1 s before the end');
  assert.equal(await page.inputValue('#m2m-start'), '0:05.400');
  await page.keyboard.press('Home');
  await page.focus('#m2m-h-end');
  await page.keyboard.press('End');
  assert.equal(await page.getAttribute('#m2m-h-end', 'aria-valuetext'), '0:06.000');
  assert.equal(await page.getAttribute('#m2m-h-end', 'aria-valuemax'), '6');
  // ---------- Handles: mouse drag and a click on the waveform ----------
  await settle();
  const box = await page.locator('#m2m-trackbox').boundingBox();
  const handle = await page.locator('#m2m-h-end').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  near(+(await page.getAttribute('#m2m-h-end', 'aria-valuenow')), 3.6, 0.02, 'end dragged to 60%');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-h-end');
  await page.mouse.click(box.x + box.width * 0.25, box.y + 10);
  near(+(await page.getAttribute('#m2m-h-start', 'aria-valuenow')), 1.5, 0.02, 'a click moves the nearer handle');

  // ---------- MP3 with a cut, fades, volume, tags and 128 kbps ----------
  await typeInto('#m2m-start', '2,5');
  await typeInto('#m2m-end', '0:03.5');
  assert.equal(await text('#m2m-len'), '0:01.000');
  assert.equal((await card('clip.mp4')).state, 'Ready, from 0:02.500 to 0:03.500');
  await page.focus('#m2m-vol');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#m2m-vol-out'), '50% (−6.0 dB)');
  await typeInto('#m2m-fadein', '0,6');
  await typeInto('#m2m-fadeout', '0.6');
  assert.equal(await text('#m2m-fade-error'), 'The fades together (1.2 s) are longer than the selection (1 s). Shorten them or the selection.');
  assert.deepEqual(await errorOf('#m2m-fadein'), { invalid: 'true', describedby: 'm2m-fade-error' });
  assert.equal(await page.getAttribute('#m2m-fadeout', 'aria-invalid'), 'true');
  await typeInto('#m2m-fadeout', 'x');
  assert.equal(await text('#m2m-fade-error'), 'Type the fade-out length in seconds, such as 2 or 0.5.');
  // Converting is refused while a field is wrong, and the field gets the focus.
  await page.click('#m2m-convert');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-fadeout');
  assert.equal(await page.isVisible('#m2m-progress'), false);
  await typeInto('#m2m-fadein', '0,25');
  await typeInto('#m2m-fadeout', '0.25');
  assert.equal(await text('#m2m-fade-error'), '');
  assert.equal(await page.getAttribute('#m2m-fadein', 'aria-invalid'), null);
  await page.click('#m2m-tags summary');
  const title = 'Café ☕ – Ünïcödé 🎵';
  await page.fill('#m2m-title', title);
  await page.fill('#m2m-artist', 'Ärtist');
  await page.fill('#m2m-album', 'Albüm');
  await page.selectOption('#m2m-bitrate', '128');
  assert.equal(await text('#m2m-estimate'), 'Estimated size: about 16 KB as clip.mp3.');
  assert.equal(await text('#m2m-convert'), 'Convert to MP3');
  await page.focus('#m2m-convert');
  await page.keyboard.press('Enter');
  await waitIdle();
  c = await card('clip.mp4');
  assert.match(c.state, /^Converted: clip\.mp3, \d+(\.\d)? KB$/);
  assert.equal(await text('#m2m-status'), `${c.state.replace('Converted: ', '').replace(', ', ' is ready to download, ')}.`);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Download clip.mp3', 'focus moves to the download');
  let mp3 = await download(() => page.keyboard.press('Enter'));
  assert.equal(mp3.name, 'clip.mp3');
  let m = checkMp3(mp3.bytes, { kbps: 128, sr: 48000, mono: false, seconds: 1 }, 'clip.mp3');
  assert.equal(m.tags.TIT2, title);
  assert.equal(m.tags.TPE1, 'Ärtist');
  assert.equal(m.tags.TALB, 'Albüm');
  assert.equal(c.state, `Converted: clip.mp3, ${(mp3.bytes.length / 1000).toFixed(mp3.bytes.length < 1e4 ? 1 : 0)} KB`);
  // Decoded: 1 s of the 660 Hz part, halved, with 0.25 s fades at both ends.
  let a = await analyse(mp3.bytes, 48000, [[0.35, 0.65], [0, 0.05], [0.1, 0.15], [0.95, 1.0]]);
  near(a.dur, 1, 0.06, 'clip.mp3 length');
  assert.equal(a.ch, 2);
  near(a.win[0].freq[0], 660, 3, 'clip.mp3 tone (the 2-4 s part)');
  near(a.win[0].rms[0], 0.5 / Math.SQRT2 * 0.5, 0.012, 'left RMS at 50% volume');
  near(a.win[0].rms[1], 0.25 / Math.SQRT2 * 0.5, 0.008, 'right RMS at 50% volume');
  assert.ok(a.win[1].rms[0] < 0.25 * a.win[0].rms[0], `fade in starts quiet: ${a.win[1].rms[0]}`);
  const half = a.win[2].rms[0] / a.win[0].rms[0];
  assert.ok(half > 0.3 && half < 0.75, `halfway through the fade in the level is about half: ${half}`);
  assert.ok(a.win[3].rms[0] < 0.3 * a.win[0].rms[0], `fade out ends quiet: ${a.win[3].rms[0]}`);
  // A quick second press on Download saves the file once, but a new result
  // can be saved at once. The page's clock is stopped 10 s ahead until the
  // M4A below has been saved, so every press counts as quick.
  await page.evaluate(() => { const t = Date.now() + 10000; window.__realNow = Date.now; Date.now = () => t; });
  let downloads = 0;
  const countDl = () => downloads++;
  page.on('download', countDl);
  await row('clip.mp4').locator('.m2m-dl').dblclick();
  await page.waitForTimeout(800);
  page.off('download', countDl);
  assert.equal(downloads, 1, 'a double click downloads once');

  // ---------- Play selection: buffers inside the cut, gain ramps for the fades ----------
  await page.evaluate(() => { window.__starts = []; window.__ramps = []; });
  await page.click('#m2m-play');
  assert.equal(await text('#m2m-play'), 'Stop');
  await page.waitForFunction(() => window.__starts.length > 0, null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('m2m-play').textContent === 'Play selection', null, { timeout: 8000 });
  assert.deepEqual(await page.evaluate(() => window.__session), ['playback', 'auto'],
    'playing asks for media playback, which iOS lets through in silent mode, then gives the sound back');
  const starts = await page.evaluate(() => window.__starts);
  const played = starts.reduce((s, x) => s + x.dur, 0);
  near(played, 1, 0.03, 'seconds of sound scheduled for the 1 s selection');
  const t0 = Math.min(...starts.map(x => x.when));
  assert.ok(starts.every(x => x.when + x.dur <= t0 + 1.001), 'nothing plays past the end of the selection');
  const ramps = await page.evaluate(() => window.__ramps);
  assert.deepEqual(ramps.slice(0, 4).map(r => [r[0], +r[1].toFixed(3), +(r[2] - ramps[0][2]).toFixed(3)]),
    [['setValueAtTime', 0, 0], ['linearRampToValueAtTime', 0.5, 0.25], ['setValueAtTime', 0.5, 0.75], ['linearRampToValueAtTime', 0, 1]]);
  // A change after converting makes the result out of date.
  await page.focus('#m2m-vol');
  await page.keyboard.press('ArrowRight');
  c = await card('clip.mp4');
  assert.equal(c.download, false, 'the old MP3 is dropped when the volume changes');
  assert.equal(c.state, 'Ready, from 0:02.500 to 0:03.500');

  // ---------- Original audio: AAC packets copied byte for byte ----------
  await page.check('#m2m-f-copy');
  assert.equal(await page.isDisabled('#m2m-vol'), true);
  assert.equal(await page.isDisabled('#m2m-fadein'), true);
  assert.equal(await page.isVisible('#m2m-copy-note'), true);
  assert.equal(await page.isVisible('#m2m-bitrate'), false);
  assert.equal(await text('#m2m-convert'), 'Save original audio');
  await convert();
  const m4a = await download(() => row('clip.mp4').locator('.m2m-dl').click());
  await page.evaluate(() => { Date.now = window.__realNow; });
  assert.equal(m4a.name, 'clip.m4a');
  const mp4 = mp4Samples(m4a.bytes);
  assert.ok(mp4.stsd.includes(Buffer.from('mp4a')), 'the track is AAC (mp4a)');
  const src = exp['clip.mp4'].packets;
  const firstIdx = src.findIndex(pk => pk.sha256 === sha(mp4.samples[0]));
  assert.ok(firstIdx >= 0, 'the first packet is a packet of the source, unchanged');
  mp4.samples.forEach((s, i) => assert.equal(sha(s), src[firstIdx + i].sha256, `packet ${i} copied unchanged`));
  const first = src[firstIdx], last = src[firstIdx + mp4.samples.length - 1];
  assert.ok(first.pts <= 2.5 && first.pts > 2.5 - 0.0214 * 3, `copy starts at ${first.pts} s, at most a few frames before 2.5 s`);
  assert.ok(last.pts + last.dur >= 3.5 && last.pts < 3.5 + 0.0214, `copy ends at ${last.pts + last.dur} s, on the frame holding 3.5 s`);

  // ---------- WAV: exact samples, sample-exact cuts, volume and mono ----------
  await page.setInputFiles('#m2m-file', F('chirp.wav'));
  await waitRead();
  assert.equal((await card('chirp.wav')).info, '0:01.000 · PCM · 44.1 kHz · stereo');
  assert.equal(await row('chirp.wav').locator('.m2m-edit').getAttribute('aria-pressed'), 'false');
  await row('chirp.wav').locator('.m2m-edit').click();
  assert.equal((await card('chirp.wav')).current, 'true');
  assert.equal(await row('clip.mp4').locator('.m2m-edit').getAttribute('aria-pressed'), 'false');
  await page.check('#m2m-f-wav');
  await waitWave();
  // A value that arrives without an input event (as when a browser restores a
  // form) is read when converting.
  await page.$eval('#m2m-start', el => { el.value = '0.25'; });
  await page.focus('#m2m-h-end');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await page.inputValue('#m2m-end'), '0:00.700');
  assert.equal(await text('#m2m-convert'), 'Convert 2 files to WAV');
  await convert();
  assert.equal(await text('#m2m-status'), '2 of 2 files converted. Download them one by one or all as a ZIP.');
  const chirpSrc = fs.readFileSync(F('chirp.wav'));
  const srcPcm = new Int16Array(chirpSrc.buffer.slice(chirpSrc.byteOffset + exp['chirp.wav'].data_offset, chirpSrc.byteOffset + chirpSrc.length));
  const cut = srcPcm.subarray(11025 * 2, 30870 * 2);
  let wav = await download(() => row('chirp.wav').locator('.m2m-dl').click());
  assert.equal(wav.name, 'chirp.wav');
  let w = parseWav(wav.bytes);
  assert.deepEqual([w.format, w.channels, w.sr, w.bits], [1, 2, 44100, 16]);
  assert.equal(w.info.INAM, 'chirp', 'a plain title goes in the RIFF INFO chunk');
  assert.equal(w.data.length, cut.length, 'samples 11025 to 30870, exactly');
  assert.ok(w.data.every((v, i) => v === cut[i]), 'the WAV holds the source samples unchanged');
  const clipWav = await download(() => row('clip.mp4').locator('.m2m-dl').click());
  w = parseWav(clipWav.bytes);
  assert.deepEqual([w.channels, w.sr, w.data.length], [2, 48000, 96000], 'clip.wav: exactly 1 s of stereo at 48 kHz');
  assert.equal(w.info.INAM, undefined, 'RIFF INFO cannot hold this title');
  assert.equal(w.id3.TIT2, title, 'so the title is in an ID3 chunk of the WAV');
  // The ZIP holds both files, byte for byte.
  const zip = await download(() => page.click('#m2m-zip'));
  assert.equal(zip.name, 'converted-audio.zip');
  const eocd = zip.bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const names = [];
  for (let q = zip.bytes.readUInt32LE(eocd + 16), n = zip.bytes.readUInt16LE(eocd + 10); n > 0; n--) {
    const nl = zip.bytes.readUInt16LE(q + 28), el = zip.bytes.readUInt16LE(q + 30), cl = zip.bytes.readUInt16LE(q + 32);
    const size = zip.bytes.readUInt32LE(q + 20), local = zip.bytes.readUInt32LE(q + 42);
    const name = zip.bytes.toString('utf8', q + 46, q + 46 + nl);
    const start = local + 30 + zip.bytes.readUInt16LE(local + 26) + zip.bytes.readUInt16LE(local + 28);
    names.push([name, zip.bytes.subarray(start, start + size)]);
    q += 46 + nl + el + cl;
  }
  assert.deepEqual(names.map(n => n[0]), ['clip.wav', 'chirp.wav']);
  assert.ok(names[0][1].equals(clipWav.bytes) && names[1][1].equals(wav.bytes), 'ZIP entries equal the single downloads');
  // 50% volume: every sample is exactly half, rounded half up.
  await page.focus('#m2m-vol');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#m2m-convert'), 'Convert to WAV');
  await convert();
  w = parseWav((await download(() => row('chirp.wav').locator('.m2m-dl').click())).bytes);
  assert.ok(w.data.every((v, i) => v === Math.round(cut[i] / 2)), 'half volume halves every sample');
  // Mono: the average of left and right.
  await page.selectOption('#m2m-channels', 'mono');
  assert.equal(await text('#m2m-convert'), 'Convert 2 files to WAV', 'a new channel setting outdates every result');
  await page.focus('#m2m-vol');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await convert();
  w = parseWav((await download(() => row('chirp.wav').locator('.m2m-dl').click())).bytes);
  assert.equal(w.channels, 1);
  assert.equal(w.data.length, cut.length / 2);
  let off = 0;
  for (let i = 0; i < w.data.length; i++) off = Math.max(off, Math.abs(w.data[i] - (cut[2 * i] + cut[2 * i + 1]) / 2));
  assert.ok(off <= 0.5, `mono is (left + right) / 2, largest difference ${off}`);
  await page.selectOption('#m2m-channels', 'keep');

  // ---------- Opus in WebM, AAC in MOV, and the second track of an MKV ----------
  await page.check('#m2m-f-mp3');
  await page.selectOption('#m2m-bitrate', '192');
  await page.click('#m2m-clear');
  await page.setInputFiles('#m2m-file', ['voice.webm', 'phone.mov', 'two-langs.mkv'].map(F));
  await waitRead();
  assert.equal((await card('phone.mov')).info, '0:02.000 · AAC · 44.1 kHz · mono');
  assert.equal((await card('two-langs.mkv')).info, '0:01.994 · Opus · 48 kHz · mono · 2 audio tracks');
  await row('two-langs.mkv').locator('.m2m-edit').click();
  assert.deepEqual(await page.$$eval('#m2m-tracks .check', l => l.map(x => x.textContent.trim())),
    ['1, English, Opus, mono', '2, French, Commentaire, Opus, mono']);
  assert.equal(await page.isChecked('#m2m-track-0'), true, 'the file\'s default track comes first');
  await page.focus('#m2m-track-0');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.isChecked('#m2m-track-1'), true, 'the arrow key chooses the second track');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-track-1', 'the chosen track keeps the focus');
  await waitWave();
  await page.click('#m2m-speech');
  assert.equal(await page.inputValue('#m2m-bitrate'), '96');
  assert.equal(await page.inputValue('#m2m-channels'), 'mono');
  assert.equal(await text('#m2m-status'), 'Speech settings: MP3 at 96 kbps, mono.');
  await convert();
  const res = {};
  for (const n of ['voice.webm', 'phone.mov', 'two-langs.mkv']) res[n] = (await download(() => row(n).locator('.m2m-dl').click())).bytes;
  checkMp3(res['voice.webm'], { kbps: 96, sr: 48000, mono: true, seconds: 2.99 }, 'voice.mp3');
  checkMp3(res['phone.mov'], { kbps: 96, sr: 44100, mono: true, seconds: 2 }, 'phone.mp3');
  checkMp3(res['two-langs.mkv'], { kbps: 96, sr: 48000, mono: true, seconds: 1.99 }, 'two-langs.mp3');
  near((await analyse(res['voice.webm'], 48000, [[0.5, 2.5]])).win[0].freq[0], 300, 2, 'voice.webm tone');
  near((await analyse(res['phone.mov'], 44100, [[0.5, 1.5]])).win[0].freq[0], 523.25, 2, 'phone.mov tone');
  near((await analyse(res['two-langs.mkv'], 48000, [[0.5, 1.5]])).win[0].freq[0], 880, 3, 'the French track (880 Hz) was converted');
  await page.selectOption('#m2m-channels', 'keep');
  await page.selectOption('#m2m-bitrate', '192');

  // ---------- A 4 GB file is read in small pieces: only the sound is read ----------
  await page.click('#m2m-clear');
  const clipB64 = fs.readFileSync(F('clip.mp4')).toString('base64');
  const size = await page.evaluate(b64 => {
    window.__read = 0;
    const clip = new Blob([Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))]);
    const zero = new Blob([new Uint8Array(1 << 20)]);
    const head = new Uint8Array(16), dv = new DataView(head.buffer);
    dv.setUint32(0, 1);
    head.set([102, 114, 101, 101], 4); // a 'free' box with a 64-bit size: 4 GiB of padding
    dv.setBigUint64(8, BigInt(4 * 1024 ** 3 + 16));
    const parts = [clip, head];
    for (let i = 0; i < 4096; i++) parts.push(zero);
    const file = new File(parts, 'big.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return file.size;
  }, clipB64);
  assert.ok(size > 4.29e9, `virtual file of ${size} bytes`);
  await waitRead();
  assert.equal((await card('big.mp4')).info, `0:06.000 · AAC · 48 kHz · stereo · ${Math.round(exp['clip.mp4'].bit_rate / 1000)} kbps`);
  await waitWave();
  await convert();
  const big = await download(() => row('big.mp4').locator('.m2m-dl').click());
  checkMp3(big.bytes, { kbps: 192, sr: 48000, mono: false, seconds: 6 }, 'big.mp3');
  const read = await page.evaluate(() => window.__read);
  assert.ok(read < 3e6, `read ${read} bytes of a ${size}-byte file`);

  // ---------- Links are refused with a reason ----------
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://www.youtube.com/watch?v=abc');
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const LINK = 'Links cannot be converted: this page only reads files on your device. Save the video to your device first, if you own it or may use it, then choose it here.';
  assert.equal(await text('#m2m-file-error'), LINK);
  await page.evaluate(() => { document.getElementById('m2m-file-error').textContent = ''; });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://youtu.be/abc');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  assert.equal(await text('#m2m-file-error'), LINK);
  await page.evaluate(() => { document.getElementById('m2m-file-error').textContent = ''; });

  // ---------- A megabyte pasted into every text field stays quick ----------
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(x => x.name === 'ThreadTime').value * 1000;
  const before = await threadMs();
  const mega = '7'.repeat(1 << 20);
  for (const id of ['m2m-start', 'm2m-end', 'm2m-fadein', 'm2m-fadeout']) await typeInto('#' + id, mega);
  await typeInto('#m2m-title', 'a'.repeat(199) + '🎵' + 'b'.repeat(1 << 20));
  await typeInto('#m2m-artist', mega);
  await typeInto('#m2m-album', mega);
  const spent = (await threadMs()) - before;
  assert.ok(spent < 1000, `seven megabyte pastes took ${Math.round(spent)} ms of main-thread time`);
  assert.equal(await text('#m2m-time-error'), 'Type the end as minutes:seconds, such as 1:05.5, or as seconds, such as 65.5.');
  assert.equal(await text('#m2m-fade-error'), 'Type the fade-in length in seconds, such as 2 or 0.5.');
  // What a script or an input method puts past maxlength is cut, never inside an emoji.
  assert.deepEqual(await page.$$eval('#m2m-edit input[type=text]', l => l.map(x => x.value.length)), [40, 40, 12, 12, 199, 200, 200]);
  await typeInto('#m2m-start', '0');
  await typeInto('#m2m-end', '6');
  await typeInto('#m2m-fadein', '');
  await typeInto('#m2m-fadeout', '0');
  assert.equal(await text('#m2m-time-error') + await text('#m2m-fade-error'), '');
  await convert();
  m = parseMp3((await download(() => row('big.mp4').locator('.m2m-dl').click())).bytes);
  assert.equal(m.tags.TIT2, 'a'.repeat(199), 'a long title is cut to 200 characters without splitting the emoji');
  assert.equal(m.tags.TPE1, '7'.repeat(200));

  // ---------- Cancel: a 10-minute file, progress, wake lock ----------
  assert.equal(await page.isVisible('#m2m-clear'), false, 'Remove all files is only offered for two or more');
  await page.click('[aria-label="Remove big.mp4"]');
  assert.equal(await text('#m2m-status'), 'Removed big.mp4.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-open', 'focus does not get lost with the removed file');
  await page.evaluate(() => {
    const sr = 44100, sec = new Int16Array(sr * 2);
    for (let i = 0; i < sr; i++) sec[2 * i] = sec[2 * i + 1] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / sr));
    const one = new Blob([sec]), n = 600, head = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); head.setUint32(4, 36 + n * sr * 4, true); w(8, 'WAVEfmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true);
    head.setUint16(22, 2, true); head.setUint32(24, sr, true); head.setUint32(28, sr * 4, true); head.setUint16(32, 4, true); head.setUint16(34, 16, true);
    w(36, 'data'); head.setUint32(40, n * sr * 4, true);
    const parts = [head.buffer];
    for (let i = 0; i < n; i++) parts.push(one);
    const dt = new DataTransfer();
    dt.items.add(new File(parts, 'ten minutes.wav', { type: 'audio/wav' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitRead();
  assert.equal((await card('ten minutes.wav')).info, '10:00.000 · PCM · 44.1 kHz · stereo');
  await page.evaluate(() => { window.__wake = { requested: 0, released: 0 }; });
  await page.click('#m2m-convert');
  await page.waitForFunction(() => /, [1-9]\d*%$/.test(document.getElementById('m2m-progress-text').textContent), null, { timeout: 30000 });
  assert.equal(await page.isVisible('#m2m-cancel'), true);
  assert.equal(await page.isDisabled('#m2m-bitrate'), true, 'settings are locked while converting');
  assert.match((await card('ten minutes.wav')).state, /^Converting… \d+%$/);
  assert.equal(await page.evaluate(() => window.__wake.requested), 1, 'the screen is kept on while converting');
  await page.click('#m2m-cancel');
  await waitIdle();
  assert.equal(await text('#m2m-status'), 'Conversion cancelled.');
  c = await card('ten minutes.wav');
  assert.equal(c.download, false);
  assert.equal(c.state, 'Ready');
  assert.equal(await page.isDisabled('#m2m-convert'), false);
  assert.equal(await page.evaluate(() => window.__wake.released), 1, 'the wake lock is released');
  assert.equal(await page.isVisible('#m2m-progress'), false);

  // ---------- WAV over the 2 GB a computer may build in memory ----------
  await page.evaluate(() => {
    const sr = 44100, n = 12600, one = new Blob([new Int16Array(sr * 2)]), head = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); head.setUint32(4, 36 + n * sr * 4, true); w(8, 'WAVEfmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true);
    head.setUint16(22, 2, true); head.setUint32(24, sr, true); head.setUint32(28, sr * 4, true); head.setUint16(32, 4, true); head.setUint16(34, 16, true);
    w(36, 'data'); head.setUint32(40, n * sr * 4, true);
    const parts = [head.buffer];
    for (let i = 0; i < n; i++) parts.push(one);
    const dt = new DataTransfer();
    dt.items.add(new File(parts, 'long.wav'));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitRead();
  assert.equal((await card('long.wav')).info, '3:30:00.000 · PCM · 44.1 kHz · stereo');
  await page.click('[aria-label="Remove ten minutes.wav"]');
  // long.wav is now edited and its 3.5 hours are scanned for the waveform; the
  // page keeps painting its progress meanwhile instead of freezing until done.
  await page.waitForFunction(() => /^Reading the sound… [1-9]\d?%$/.test(document.getElementById('m2m-wave-msg').textContent), null, { timeout: 20000 });
  await page.check('#m2m-f-wav');
  assert.equal(await text('#m2m-estimate'), 'Estimated size: about 2.22 GB as long.wav.');
  await convert();
  assert.equal((await card('long.wav')).msg, 'As WAV this would be about 2.22 GB, more than the 2.00 GB this device can build in memory. Choose MP3, mono or a shorter selection.');
  assert.equal(await text('#m2m-status'), 'long.wav: As WAV this would be about 2.22 GB, more than the 2.00 GB this device can build in memory. Choose MP3, mono or a shorter selection.');
  await page.click('[aria-label="Remove long.wav"]');

  // ---------- Cover art in every format; surround and other channel layouts ----------
  await page.setInputFiles('#m2m-file', F('cover.m4a'));
  await waitRead();
  await waitWave();
  assert.equal(await page.isChecked('#m2m-cover'), true, 'the cover is kept by default');
  await convert();
  const coverWav = parseWav((await download(() => row('cover.m4a').locator('.m2m-dl').click())).bytes);
  assert.ok(coverWav.id3 && coverWav.id3.APIC, 'a WAV keeps the cover too (in an ID3 chunk, as RIFF INFO holds no pictures)');
  assert.equal(sha(apicImage(coverWav.id3.APIC)), exp['cover.m4a'].jpeg_sha256, 'the cover picture, byte for byte');
  assert.equal(coverWav.id3.TIT2, 'Cover test');
  await page.check('#m2m-f-mp3');
  await convert();
  m = parseMp3((await download(() => row('cover.m4a').locator('.m2m-dl').click())).bytes);
  assert.equal(sha(apicImage(m.tags.APIC)), exp['cover.m4a'].jpeg_sha256, 'the MP3 keeps the cover');
  await page.uncheck('#m2m-cover');
  await convert();
  m = parseMp3((await download(() => row('cover.m4a').locator('.m2m-dl').click())).bytes);
  assert.equal(m.tags.APIC, undefined, 'unticked, the cover is left out');
  await page.check('#m2m-f-wav');
  await page.click('[aria-label="Remove cover.m4a"]');
  // Only mono, stereo, quad and 5.1 are mixed down; of other layouts two channels are kept.
  await dropWav('centre.wav', 48000, 1, ['0', '0', '0.3 * Math.sin(2 * Math.PI * 440 * t)']);
  await waitRead();
  await waitWave();
  c = await card('centre.wav');
  assert.equal(c.info, '0:01.000 · PCM · 48 kHz · 3 channels');
  assert.equal(c.msg, 'Its sound has 3 channels, and MP3 and WAV keep only the first two (usually front left and right; with Mono only the first), so sound that is only in the others, such as speech in a centre channel, is lost.');
  assert.equal(await text('#m2m-peak'), 'The selection is silent.', 'the readout is of the two channels that are kept');
  // 5.1 with the same tone at 0.5 in left, centre and left surround: mixed to
  // stereo the left is L + 0.707 (C + SL), 1.207 times as loud.
  const tone = '0.5 * Math.sin(2 * Math.PI * 440 * t)';
  await dropWav('surround.wav', 48000, 1, [tone, '0', tone, '0', tone, '0']);
  await waitRead();
  await row('surround.wav').locator('.m2m-edit').click();
  await waitWave();
  assert.equal((await card('surround.wav')).msg, '');
  assert.equal(await text('#m2m-peak'), 'At this volume the loudest parts go above full scale and will distort. 80% is the most without distortion.');
  await page.focus('#m2m-vol');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await convert();
  const mixed = parseWav((await download(() => row('surround.wav').locator('.m2m-dl').click())).bytes);
  const loudest = mixed.data.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  assert.equal(mixed.channels, 2);
  assert.ok(loudest > 0.95 * 32767 && loudest < 32767, `at 80% the stereo mix peaks just below full scale: ${loudest}`);
  // A quiet file: the readout stops at the slider's 400%; at 0% it says silent.
  await dropWav('quiet.wav', 48000, 1, ['0.1 * Math.sin(2 * Math.PI * 440 * t)', '0.1 * Math.sin(2 * Math.PI * 440 * t)']);
  await waitRead();
  await row('quiet.wav').locator('.m2m-edit').click();
  await waitWave();
  assert.equal(await text('#m2m-peak'), 'Loudest point at this volume: −20.0 dB of full scale. Up to 400% stays clear of distortion.');
  await page.focus('#m2m-vol');
  await page.keyboard.press('Home');
  assert.equal(await text('#m2m-peak'), 'At 0% the result is silent.');
  await page.click('#m2m-clear');
  // MP3 at 192 kbps needs MPEG-1, so sound at 22.05 kHz is made at 44.1 kHz.
  await dropWav('low-rate.wav', 22050, 1, ['0.4 * Math.sin(2 * Math.PI * 440 * t)']);
  await waitRead();
  await page.check('#m2m-f-mp3');
  await convert();
  checkMp3((await download(() => row('low-rate.wav').locator('.m2m-dl').click())).bytes, { kbps: 192, sr: 44100, mono: true, seconds: 1 }, 'low-rate.mp3');
  await page.click('[aria-label="Remove low-rate.wav"]');

  // ---------- Fields the browser restores on Back are read again ----------
  await page.evaluate(() => { document.getElementById('m2m-f-mp3').checked = true; document.getElementById('m2m-bitrate').value = '320'; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 320 kbps takes about 2.40 MB a minute. A higher bitrate cannot add detail that the source does not have.');

  // Leave a converted file on screen for the runner's phone-width checks.
  await page.click('#m2m-sample');
  await waitRead();
  assert.equal((await card('sample.wav')).info, '0:08.000 · PCM · 44.1 kHz · stereo');
  await convert();
  checkMp3((await download(() => row('sample.wav').locator('.m2m-dl').click())).bytes, { kbps: 320, sr: 44100, mono: false, seconds: 8 }, 'sample.mp3');

  const browser = page.context().browser();
  const problems = [];
  const watch = p => {
    p.on('pageerror', e => problems.push('page error: ' + e.message));
    p.on('console', x => { if (x.type() === 'error') problems.push('console error: ' + x.text()); });
  };

  // ---------- Without a streaming decoder (Safari before 26, Firefox on Android) ----------
  const old = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const op = await old.newPage();
  watch(op);
  await op.addInitScript(instrument);
  await op.addInitScript(() => {
    delete window.AudioDecoder;
    delete window.AudioEncoder;
    // Holds every whole-track decode until the test lets them go.
    let release;
    const gate = new Promise(r => { release = r; });
    window.__releaseDecode = release;
    const decode = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (...args) { return gate.then(() => decode.apply(this, args)); };
  });
  await op.goto(page.url());
  await op.setInputFiles('#m2m-file', [F('clip.mp4'), F('long-claim.m4a')]);
  await waitRead(op);
  // Stop pressed while the sound is still being decoded puts the button back.
  await op.click('#m2m-play');
  assert.equal(await op.textContent('#m2m-play'), 'Stop');
  await op.click('#m2m-play');
  assert.equal(await op.textContent('#m2m-play'), 'Play selection', 'Stop works before the sound has been read');
  await op.evaluate(() => window.__releaseDecode());
  await waitWave(op);
  await op.click('#m2m-play');
  await op.waitForFunction(() => window.__starts.length > 0, null, { timeout: 5000 });
  await op.click('#m2m-play');
  assert.equal(await op.textContent('#m2m-play'), 'Play selection');
  assert.equal(await op.textContent('#m2m-peak'), `Loudest point at this volume: −${Math.abs(peakAll).toFixed(1)} dB of full scale. Up to ${Math.floor(100 / 10 ** (peakAll / 20) / 5) * 5}% stays clear of distortion.`);
  await typeInto('#m2m-start', '4.5', op);
  await typeInto('#m2m-end', '5.5', op);
  near(+(await op.textContent('#m2m-peak')).match(/−([\d.]+) dB/)[1], -exp['clip.mp4']['peak_db_4.5_5.5'], 0.15, 'peak of 4.5-5.5 s');
  const longCard = await card('long-claim.m4a', op);
  // 61.5 minutes in the sample table, less the 1024 priming samples (21 ms) that the edit list skips.
  assert.equal(longCard.info, '1:01:29.979 · AAC · 48 kHz · mono');
  await op.click('#m2m-convert');
  await waitIdle(op);
  const oldMp3 = await download(() => row('clip.mp4', op).locator('.m2m-dl').click(), op);
  checkMp3(oldMp3.bytes, { kbps: 192, sr: 48000, mono: false, seconds: 1 }, 'clip.mp3 without AudioDecoder');
  a = await analyse(oldMp3.bytes, 48000, [[0.2, 0.8]], op);
  near(a.dur, 1, 0.06, 'length without AudioDecoder');
  near(a.win[0].freq[0], 880, 3, 'the 4-6 s tone without AudioDecoder');
  near(a.win[0].rms[0], 0.5 / Math.SQRT2, 0.02, 'level without AudioDecoder');
  assert.equal((await card('long-claim.m4a', op)).msg, 'This browser has to decode the whole sound track at once, which works up to 60 minutes on this device. Choose Original audio, or use a current version of Chrome, Edge, Firefox (on a computer) or Safari (26 or later).');
  await old.close();

  // ---------- A phone in a decimal-comma locale: touch drag, tap to convert ----------
  const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE', acceptDownloads: true });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(page.url());
  await pp.tap('#m2m-sample');
  await waitRead(pp);
  await waitWave(pp);
  await pp.locator('#m2m-trackbox').scrollIntoViewIfNeeded();
  await settle(pp);
  const pbox = await pp.locator('#m2m-trackbox').boundingBox();
  const ph = await pp.locator('#m2m-h-end').boundingBox();
  const tcdp = await phone.newCDPSession(pp);
  const touch = (type, x, y) => tcdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const y = pbox.y + pbox.height / 2;
  // A finger moves at a finger's pace and rests before it lifts. (Moves sent
  // all at once end in a fling, and Chrome then swallows the next tap.)
  await touch('touchStart', ph.x + ph.width / 2, y);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', ph.x + ph.width / 2 - (ph.x + ph.width / 2 - (pbox.x + pbox.width / 2)) * i / 6, y);
    await pp.waitForTimeout(40);
  }
  await pp.waitForTimeout(300);
  await touch('touchEnd');
  near(+(await pp.getAttribute('#m2m-h-end', 'aria-valuenow')), 4, 0.05, 'end dragged to the middle with a finger');
  assert.equal(await pp.inputValue('#m2m-end'), await pp.getAttribute('#m2m-h-end', 'aria-valuetext'));
  assert.equal(await pp.evaluate(() => (1.5).toLocaleString()), '1,5', 'the browser uses a decimal comma');
  await typeInto('#m2m-start', '1,5', pp);
  assert.equal(await pp.textContent('#m2m-len'), '0:02.500');
  assert.equal((await card('sample.wav', pp)).info, '0:08.000 · PCM · 44.1 kHz · stereo', 'the page writes numbers the same way in every locale');
  await pp.tap('#m2m-convert');
  await waitIdle(pp);
  const phoneMp3 = await download(() => row('sample.wav', pp).locator('.m2m-dl').tap(), pp);
  checkMp3(phoneMp3.bytes, { kbps: 192, sr: 44100, mono: false, seconds: 2.5 }, 'sample.mp3 on a phone');
  // A finger that scrolls the page across the waveform moves no handle; a tap
  // moves the nearer one, and a sideways drag on the waveform moves it along.
  const handlesNow = () => pp.evaluate(() => ['m2m-h-start', 'm2m-h-end'].map(id => document.getElementById(id).getAttribute('aria-valuenow')));
  const held = await handlesNow();
  await pp.locator('#m2m-trackbox').scrollIntoViewIfNeeded();
  await settle(pp);
  let tb = await pp.locator('#m2m-trackbox').boundingBox();
  const scrolledFrom = await pp.evaluate(() => scrollY);
  const sx = tb.x + tb.width * 0.3, sy = tb.y + tb.height * 0.9;
  await touch('touchStart', sx, sy);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', sx + 1, sy - i * 20);
    await pp.waitForTimeout(40);
  }
  await pp.waitForTimeout(300);
  await touch('touchEnd');
  await settle(pp);
  assert.ok(await pp.evaluate(y => scrollY > y, scrolledFrom), 'the swipe scrolled the page');
  assert.deepEqual(await handlesNow(), held, 'a finger scrolling the page over the waveform moves no handle');
  await pp.locator('#m2m-trackbox').scrollIntoViewIfNeeded();
  await settle(pp);
  tb = await pp.locator('#m2m-trackbox').boundingBox();
  await pp.touchscreen.tap(tb.x + tb.width * 0.875, tb.y + tb.height * 0.8);
  near(+(await pp.getAttribute('#m2m-h-end', 'aria-valuenow')), 7, 0.05, 'a tap at 7 s moves the end there');
  await touch('touchStart', tb.x + tb.width * 0.0625, tb.y + tb.height * 0.8);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', tb.x + tb.width * (0.0625 + 0.0625 * i / 6), tb.y + tb.height * 0.8);
    await pp.waitForTimeout(40);
  }
  await pp.waitForTimeout(300);
  await touch('touchEnd');
  near(+(await pp.getAttribute('#m2m-h-start', 'aria-valuenow')), 1, 0.05, 'a sideways drag from 0.5 s takes the start to 1 s');
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no sideways scroll on a phone with a result (${overflow}px)`);
  await pp.tap('#m2m-f-wav');
  assert.match(await pp.textContent('#m2m-format-hint'), / Limit on this device: 300\.0 MB per file\.$/, 'a phone builds smaller WAV files');
  await phone.close();

  assert.deepEqual(problems, []);
};
