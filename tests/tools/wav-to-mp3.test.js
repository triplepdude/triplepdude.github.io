const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { devices } = require('playwright');

// The samples and the facts checked against them come from
// tests/fixtures/wav-to-mp3/make_fixtures.py (numpy, ffmpeg, mutagen and
// ffprobe): every kind of WAV, headers that state the wrong length, tags in
// RIFF INFO and in an 'id3 ' chunk, and the neighbours people drop on a WAV
// page. The MP3s the page writes are checked by parsing them here (frame
// headers, the Info frame and its LAME tag, ID3v2.3 and ID3v1) and by
// decoding them with the browser's own MP3 decoder, which shares no code with
// the LAME encoder that wrote them: exact length, tone frequencies and levels.
// With W2M_DUMP set to a folder, the MP3s are also saved there for
// tests/fixtures/wav-to-mp3/check_outputs.py (ffprobe, ffmpeg with numpy, mutagen).
module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const F = name => path.join(fixtures, name);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const dump = (name, bytes) => { if (process.env.W2M_DUMP) fs.writeFileSync(path.join(process.env.W2M_DUMP, name), bytes); };

  const instrument = () => {
    window.__wake = { requested: 0, released: 0 };
    if (navigator.wakeLock) {
      navigator.wakeLock.request = () => {
        window.__wake.requested++;
        return Promise.resolve({ release() { window.__wake.released++; return Promise.resolve(); }, addEventListener() {} });
      };
    }
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
    // A save dialog that hands over a file kept in memory, as a
    // FileSystemWritableFileStream takes writes: { type: 'write', position, data }.
    window.__picks = [];
    window.__saved = {};
    window.__fakePicker = (mode) => {
      window.showSaveFilePicker = async opts => {
        window.__picks.push(JSON.parse(JSON.stringify(opts)));
        if (mode.cancel) throw new DOMException('The user aborted a request.', 'AbortError');
        const name = mode.names ? mode.names.shift() : 'chosen.mp3';
        const file = window.__saved[name] = { bytes: new Uint8Array(0), closed: false, aborted: false, writes: 0 };
        return {
          name, kind: 'file',
          createWritable: async () => new WritableStream({
            async write(c) {
              if (mode.slow) await new Promise(r => setTimeout(r, mode.slow));
              if (mode.fail && ++file.writes > mode.fail) throw new DOMException('There is not enough space on the disk.', 'QuotaExceededError');
              const d = new Uint8Array(c.data.buffer || c.data, c.data.byteOffset || 0, c.data.byteLength), end = c.position + d.length;
              if (end > file.bytes.length) { const b = new Uint8Array(end); b.set(file.bytes); file.bytes = b; }
              file.bytes.set(d, c.position);
            },
            close() { file.closed = true; },
            abort() { file.aborted = true; }
          })
        };
      };
    };
  };
  await page.addInitScript(instrument);
  let gotChooser;
  const chooserReady = new Promise(r => { gotChooser = r; });
  page.on('filechooser', fc => gotChooser(fc));
  await open();

  // ---------- helpers ----------
  const text = (sel, p = page) => p.locator(sel).textContent();
  const row = (name, p = page) => p.locator('.m2m-file').filter({ has: p.locator('.m2m-file-name').getByText(name, { exact: true }) });
  const card = async (name, p = page) => {
    const r = row(name, p), note = r.locator('.m2m-file-note');
    return {
      info: await r.locator('.m2m-file-info').isVisible() ? await r.locator('.m2m-file-info').textContent() : '',
      note: await note.isVisible() ? await note.textContent() : '',
      state: await r.locator('.m2m-file-state').textContent(), msg: await r.locator('.m2m-file-msg').textContent(),
      download: await r.locator('.m2m-dl').isVisible()
    };
  };
  const waitRead = (p = page) => p.waitForFunction(() => document.querySelectorAll('.m2m-file').length > 0 &&
    ![...document.querySelectorAll('.m2m-file-state')].some(e => e.textContent === 'Reading…'), null, { timeout: 30000 });
  const waitIdle = (p = page) => p.waitForFunction(() => document.getElementById('m2m-cancel').hidden &&
    document.getElementById('m2m-convert').textContent !== 'Converting…', null, { timeout: 120000 });
  const download = async (action, p = page) => {
    const caller = (new Error().stack.split('\n')[2] || '').trim();
    try {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), action()]);
      return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
    } catch (e) {
      throw new Error(`${String(e.message).split('\n')[0]} (download ${caller})`);
    }
  };
  const dl = (name, p = page) => download(() => row(name, p).locator('.m2m-dl').click(), p);
  const convert = async (p = page) => { await p.click('#m2m-convert'); await waitIdle(p); };
  const add = async (names, p = page) => { await p.setInputFiles('#m2m-file', names.map(F)); await waitRead(p); };
  const clear = async (p = page) => { if (await p.isVisible('#m2m-clear')) await p.click('#m2m-clear'); else if (await p.locator('.m2m-remove').count()) await p.locator('.m2m-remove').first().click(); };
  const edit = async (name, p = page) => { if (await row(name, p).locator('.m2m-edit').isVisible()) await row(name, p).locator('.m2m-edit').click(); };
  const typeInto = async (sel, value, p = page) => {
    await p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  const live = (p = page) => p.evaluate(() => window.__live.slice());
  // The site scrolls smoothly: wait until the page has not moved for a few frames.
  const settle = (p = page) => p.evaluate(() => new Promise(resolve => {
    let last = NaN, same = 0;
    const tick = () => { if (scrollY === last) { if (++same > 4) return resolve(); } else { same = 0; last = scrollY; } requestAnimationFrame(tick); };
    tick();
  }));
  // Drops a WAV of 16-bit PCM made here, from one function of t per channel.
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
  // Opens a folded section (Trim, fades and volume; Tags) the way a visitor does, unless it is open.
  const unfold = async (id, p = page) => { if (!(await p.evaluate(i => document.getElementById(i).open, id))) await p.click(`#${id} summary`); };
  // The page's size and change wording, for sizes this test measured itself.
  const fmtBytes = n => n < 1000 ? n + ' bytes' : n < 1e6 ? (n / 1000).toFixed(n < 1e4 ? 1 : 0) + ' KB' : n < 1e9 ? (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB' : (n / 1e9).toFixed(2) + ' GB';
  const smaller = (from, to) => Math.min(99, Math.round((1 - to / from) * 100)) + '% smaller';
  const pad = (n, w) => String(n).padStart(w, '0');
  const fmtTime = ms => {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, tail = pad(Math.floor(ms / 1000) % 60, 2) + '.' + pad(ms % 1000, 3);
    return h ? `${h}:${pad(mi, 2)}:${tail}` : `${mi}:${tail}`;
  };

  // MPEG-1, 2 and 2.5 Layer III frame headers, the ID3v2 tag in front of them
  // and the ID3v1 tag after them.
  const synch = b => ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f);
  function id3String(b, enc) {
    if (enc === 0) return b.toString('latin1').replace(/\0+$/, '');
    assert.equal(enc, 1, `text encoding ${enc}`);
    if (!b.length) return '';
    assert.ok(b[0] === 0xff && b[1] === 0xfe, 'UTF-16 text starts with a byte order mark');
    return Buffer.from(b.subarray(2)).toString('utf16le').replace(/\0+$/, '');
  }
  function splitString(b, enc) {
    if (enc !== 1) { const i = b.indexOf(0); return [b.subarray(0, i), b.subarray(i + 1)]; }
    for (let i = 0; i + 1 < b.length; i += 2) if (!b[i] && !b[i + 1]) return [b.subarray(0, i), b.subarray(i + 2)];
    return [b, Buffer.alloc(0)];
  }
  function parseMp3(buf) {
    let off = 0, id3 = 0;
    const tags = {}, enc = {};
    if (buf.toString('latin1', 0, 3) === 'ID3') {
      id3 = buf[3];
      assert.equal(buf[5], 0, 'ID3v2 flags: no unsynchronisation, extended header or experimental bit');
      const size = synch(buf.subarray(6, 10));
      for (let q = 10; q + 10 <= 10 + size;) {
        const id = buf.toString('latin1', q, q + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const len = buf.readUInt32BE(q + 4), body = buf.subarray(q + 10, q + 10 + len);
        assert.equal(buf.readUInt16BE(q + 8), 0, `${id} frame flags`);
        assert.equal(tags[id], undefined, `one ${id} frame`);
        if ((id[0] === 'T' && id !== 'TXXX') || id === 'COMM' || id === 'USLT') {
          assert.ok([0, 1].includes(body[0]), `${id} text encoding ${body[0]} in ID3v2.3`);
          enc[id] = body[0];
          if (id[0] === 'T') tags[id] = id3String(body.subarray(1), body[0]);
          else {
            const [desc, t] = splitString(body.subarray(4), body[0]);
            tags[id] = { lang: body.toString('latin1', 1, 4), desc: id3String(desc, body[0]), text: id3String(t, body[0]) };
          }
        } else tags[id] = body;
        q += 10 + len;
      }
      off = 10 + size;
    }
    const BR = { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
    BR[0] = BR[2];
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    const frames = [];
    while (off + 4 <= buf.length) {
      const h = buf.readUInt32BE(off);
      if ((h >>> 21) !== 0x7ff) break;
      const ver = (h >>> 19) & 3, layer = (h >>> 17) & 3, kbps = BR[ver][(h >>> 12) & 15], sr = SR[ver][(h >>> 10) & 3];
      const mode = (h >>> 6) & 3, pad = (h >>> 9) & 1;
      const len = Math.floor((ver === 3 ? 144000 : 72000) * kbps / sr) + pad;
      const side = ver === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17);
      frames.push({ ver, layer, kbps, sr, mode, tag: buf.toString('latin1', off + 4 + side, off + 8 + side), pos: off, len });
      off += len;
    }
    let v1 = null;
    if (buf.length - off === 128 && buf.toString('latin1', off, off + 3) === 'TAG') {
      const t = (a, n) => buf.toString('latin1', off + a, off + a + n).replace(/\0+$/, '');
      v1 = { title: t(3, 30), artist: t(33, 30), album: t(63, 30), year: t(93, 4), comment: t(97, 28), zero: buf[off + 125], track: buf[off + 126], genre: buf[off + 127] };
    }
    return { id3, tags, enc, frames, v1, rest: buf.length - off };
  }
  const crcArc = (b, from = 0, to = b.length) => {
    let c = 0;
    for (let i = from; i < to; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; }
    return c;
  };
  function lameTag(buf) {
    const p = buf.toString('latin1', 0, 3) === 'ID3' ? 10 + synch(buf.subarray(6, 10)) : 0;
    const ver = (buf[p + 1] >>> 3) & 3, mode = buf[p + 3] >>> 6, o = p + 4 + (ver === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17));
    const tag = buf.toString('latin1', o, o + 4);
    if (tag !== 'Info' && tag !== 'Xing') return { tag: null };
    const flags = buf.readUInt32BE(o + 4), r = { tag, frames: null, bytes: null, toc: null, pos: p };
    let q = o + 8;
    if (flags & 1) { r.frames = buf.readUInt32BE(q); q += 4; }
    if (flags & 2) { r.bytes = buf.readUInt32BE(q); q += 4; }
    if (flags & 4) { r.toc = [...buf.subarray(q, q + 100)]; q += 100; }
    if (flags & 8) q += 4;
    const v = buf.readUIntBE(q + 21, 3);
    Object.assign(r, { encoder: buf.toString('latin1', q, q + 9), delay: v >>> 12, padding: v & 4095,
      musicCrc: buf.readUInt16BE(q + 32), crcOk: crcArc(buf, p, q + 34) === buf.readUInt16BE(q + 34) });
    return r;
  }
  // An MP3 this page wrote: MPEG-1 above 32 kHz, MPEG-2 from 16 to 24 kHz,
  // MPEG-2.5 below, constant bitrate, an Info frame whose LAME tag makes it
  // exactly `samples` long in gapless decoders, ID3v2.3 in front and ID3v1 after.
  function checkMp3(buf, { kbps, sr, mono, samples, v1 = true }, what) {
    const m = parseMp3(buf);
    const ver = sr >= 32000 ? 3 : sr >= 16000 ? 2 : 0, spf = ver === 3 ? 1152 : 576;
    assert.equal(m.id3, 3, `${what}: ID3v2.3 tag`);
    assert.ok(m.frames.length > 2, `${what}: MPEG frames found`);
    assert.equal(m.rest, v1 ? 128 : 0, `${what}: ${v1 ? 'a 128-byte ID3v1 tag' : 'nothing'} after the last frame`);
    for (const [i, f] of m.frames.entries()) {
      assert.deepEqual([f.ver, f.layer, f.sr, f.mode === 3], [ver, 1, sr, mono], `${what}: frame ${i} is MPEG ${ver} Layer III at ${sr} Hz, ${mono ? 'mono' : 'stereo'}`);
      assert.equal(f.kbps, kbps, `${what}: frame ${i} at ${f.kbps} kbps, not ${kbps}`);
    }
    const lt = lameTag(buf), last = m.frames[m.frames.length - 1];
    assert.equal(lt.tag, 'Info', `${what}: an Info frame (constant bitrate)`);
    assert.equal(lt.frames, m.frames.length - 1, `${what}: the Info frame counts the frames after it`);
    assert.equal(lt.bytes, last.pos + last.len - m.frames[0].pos, `${what}: the Info frame's byte count`);
    assert.ok(lt.crcOk, `${what}: the LAME tag's CRC`);
    assert.equal(lt.musicCrc, crcArc(buf, m.frames[1].pos, last.pos + last.len), `${what}: the CRC of the music`);
    assert.deepEqual([lt.encoder, lt.delay], ['LAME3.100', 576], `${what}: LAME's encoder delay`);
    m.exact = (m.frames.length - 1) * spf - lt.delay - lt.padding;
    if (samples !== undefined) assert.equal(m.exact, samples, `${what}: the LAME tag makes it ${m.exact} samples long, not ${samples}`);
    return m;
  }
  // Decodes an MP3 with the browser (which honours the LAME tag) at its own rate.
  const decode = (bytes, sr, p = page) => p.evaluate(async ([b64, sr]) => {
    const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ab = await new OfflineAudioContext(1, 1, sr).decodeAudioData(u8.buffer);
    const ch = [];
    for (let c = 0; c < ab.numberOfChannels; c++) ch.push(Array.from(ab.getChannelData(c)));
    return { len: ab.length, ch };
  }, [bytes.toString('base64'), sr]);
  const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const peakOf = x => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  // Frequency from the zero crossings of the middle of x.
  const hz = (x, sr) => {
    const a = Math.floor(x.length * 0.1), b = Math.floor(x.length * 0.9), xs = [];
    for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) xs.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
    return xs.length > 2 ? (xs.length - 1) / ((xs[xs.length - 1] - xs[0]) / sr) : 0;
  };
  // The level of a tone at exactly f, in dB of full scale, from a Kaiser-windowed DFT (beta 20).
  const besselI0 = v => { let s = 1, t = 1; for (let k = 1; k < 200; k++) { t *= (v / 2 / k) ** 2; s += t; if (t < 1e-16 * s) break; } return s; };
  const toneDb = (x, sr, f) => {
    const n = Math.floor(x.length * 0.8), off = (x.length - n) >> 1;
    let re = 0, im = 0, ws = 0;
    for (let i = 0; i < n; i++) {
      const r = 2 * i / (n - 1) - 1, wv = besselI0(20 * Math.sqrt(1 - r * r)) / besselI0(20), ph = 2 * Math.PI * f * (off + i) / sr;
      re += x[off + i] * wv * Math.cos(ph); im -= x[off + i] * wv * Math.sin(ph); ws += wv;
    }
    return 20 * Math.log10(Math.hypot(re, im) / (ws / 2) + 1e-30);
  };
  const db = a => 20 * Math.log10(a);
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  const apicImage = body => {
    let q = body.indexOf(0, 1) + 2;
    if (body[0] === 1) { while (body[q] || body[q + 1]) q += 2; q += 2; } else q = body.indexOf(0, q) + 1;
    return body.subarray(q);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const thread = async () => (await cdp.send('Performance.getMetrics')).metrics.find(x => x.name === 'ThreadTime').value * 1000;
  const HINT = ' A higher bitrate cannot add detail that the source does not have. MP3 has no bit depth: a 24-bit or 32-bit float WAV gives an MP3 of the same size as a 16-bit one.';

  // ---------- The page as it opens: set for WAV recordings, MP3 only ----------
  assert.equal(await text('h1'), 'WAV to MP3 Converter: Large Files, No Upload');
  assert.equal(await text('.m2m-drop-title'), 'Drop WAV files here');
  assert.equal(await text('#m2m-drop-hint'), 'WAV, BWF and RF64 files of any size, as many as you like; MP3, FLAC, M4A and OGG work too. Nothing is uploaded.');
  assert.match(await page.getAttribute('#m2m-file', 'accept'), /\.wav,.*\.bwf,\.rf64$/, 'the file picker offers .bwf and .rf64 files too');
  assert.equal(await page.locator('input[name="m2m-format"]').count(), 1, 'MP3 is the one format');
  assert.equal(await page.isVisible('input[name="m2m-format"]'), false, 'so no Format choice is shown');
  assert.deepEqual(await page.$$eval('#m2m-presets button', bs => bs.map(b => b.textContent)), ['Music: 192 kbps', 'Speech: 96 kbps mono', 'Speech: 64 kbps mono']);
  assert.equal(await page.getAttribute('#m2m-presets', 'role'), 'group');
  assert.equal(await page.locator('#m2m-presets').getAttribute('aria-labelledby').then(id => text('#' + id)), 'Presets');
  assert.equal(await page.locator('#m2m-speech').count(), 0, 'the presets take the place of the hub\'s one Speech button');
  assert.deepEqual([await page.inputValue('#m2m-bitrate'), await page.inputValue('#m2m-channels')], ['192', 'keep']);
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 192 kbps takes about 1.44 MB a minute, 86% less than 16-bit stereo WAV at 44.1 kHz (10.6 MB).' + HINT);
  assert.deepEqual([await text('#m2m-convert'), await page.isDisabled('#m2m-convert')], ['Convert to MP3', true]);
  assert.equal(await page.isVisible('#m2m-edit'), false);
  assert.equal(await page.evaluate(() => typeof window.Mediabunny), 'undefined', 'the converter library is not loaded before a file is added');

  // ---------- Presets: music, speech at 96 and at 64 kbps ----------
  await page.click('#m2m-p-speech96');
  assert.deepEqual([await page.inputValue('#m2m-bitrate'), await page.inputValue('#m2m-channels')], ['96', 'mono']);
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 96 kbps mono takes about 0.72 MB a minute, 86% less than 16-bit mono WAV at 44.1 kHz (5.29 MB).' + HINT);
  assert.equal(await text('#m2m-status'), 'Speech settings: MP3 at 96 kbps, mono.');
  await page.click('#m2m-p-speech64');
  assert.deepEqual([await page.inputValue('#m2m-bitrate'), await page.inputValue('#m2m-channels')], ['64', 'mono']);
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 64 kbps mono takes about 0.48 MB a minute, 91% less than 16-bit mono WAV at 44.1 kHz (5.29 MB).' + HINT);
  await page.selectOption('#m2m-bitrate', '320');
  await page.selectOption('#m2m-channels', 'keep');
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 320 kbps takes about 2.40 MB a minute, 77% less than 16-bit stereo WAV at 44.1 kHz (10.6 MB).' + HINT);
  await page.click('#m2m-p-music');
  assert.deepEqual([await page.inputValue('#m2m-bitrate'), await page.inputValue('#m2m-channels')], ['192', 'keep']);
  assert.equal(await text('#m2m-status'), 'Music settings: MP3 at 192 kbps, channels as in the file.');

  // ---------- Files that cannot be converted, and the neighbours people drop anyway ----------
  await add(['not-audio.wav', 'empty.wav', 'ima-adpcm.wav', 'ms-adpcm.wav', 'gsm.wav', 'silent.mp4', 'alac.m4a', 'song.mp3', 'voice.m4a', 'song.flac', 'voice.ogg', 'clip.mp4']);
  const refused = {
    'not-audio.wav': 'This is not an audio file that this page can read. It reads M4A, MP3, WAV, FLAC, OGG and AAC files, and the sound of MP4, MOV, WebM, MKV and MPEG-TS videos.',
    'empty.wav': 'This file is empty.',
    'ima-adpcm.wav': 'This WAV file holds IMA ADPCM sound, which this page cannot decode. An audio editor can save it again as ordinary (PCM) WAV, which this page reads.',
    'ms-adpcm.wav': 'This WAV file holds Microsoft ADPCM sound, which this page cannot decode. An audio editor can save it again as ordinary (PCM) WAV, which this page reads.',
    'gsm.wav': 'This WAV file holds GSM 6.10 sound, which this page cannot decode. An audio editor can save it again as ordinary (PCM) WAV, which this page reads.',
    'silent.mp4': 'This video has no sound track, so there is no audio to save.',
    'alac.m4a': 'Its audio uses an unknown codec (alac), which this page cannot read.'
  };
  for (const [name, msg] of Object.entries(refused)) assert.equal((await card(name)).msg, msg, name);
  assert.equal(await text('#m2m-status'), 'Added 12 files, 7 of them cannot be converted to MP3: see the message under each.');
  assert.equal(await text('#m2m-convert'), 'Convert 5 files to MP3');
  for (const [name, info] of [['song.mp3', '0:00.500 · MP3 · 44.1 kHz · stereo · 128 kbps'], ['song.flac', '0:00.500 · FLAC · 44.1 kHz · mono'],
    ['voice.ogg', '0:00.500 · Opus · 48 kHz · mono'], ['voice.m4a', '0:00.500 · AAC · 44.1 kHz · mono'], ['clip.mp4', '0:00.500 · AAC · 44.1 kHz · mono']]) {
    assert.ok((await card(name)).info.startsWith(info), `${name}: ${(await card(name)).info}`);
  }
  // Damaged headers, made here: each ends in a sentence that says why.
  await page.evaluate(() => {
    const enc = t => new TextEncoder().encode(t), u32 = v => new Uint8Array(new Uint32Array([v]).buffer), u16 = v => new Uint8Array(new Uint16Array([v]).buffer);
    const cat = a => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
    const fmt = (ch, sr, bits) => cat([enc('fmt '), u32(16), u16(1), u16(ch), u32(sr), u32(sr * ch * bits / 8), u16(ch * bits / 8), u16(bits)]);
    const noise = n => Uint8Array.from({ length: n }, (_, i) => (i * 2654435761 >>> 13) & 255);
    const wav = (...parts) => cat([enc('RIFF'), u32(0), enc('WAVE'), ...parts]);
    const dt = new DataTransfer();
    for (const [name, bytes] of [['no-format.wav', wav(noise(5000))], ['no-channels.wav', wav(fmt(0, 44100, 16), enc('data'), u32(4000), noise(4000))],
      ['twelve-bit.wav', wav(fmt(1, 8000, 12), enc('data'), u32(3000), noise(3000))], ['no-sound.wav', wav(fmt(1, 8000, 16), enc('data'), u32(0))]]) {
      dt.items.add(new File([bytes], name, { type: 'audio/wav' }));
    }
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.m2m-file').length === 16);
  await waitRead();
  for (const [name, msg] of [['no-format.wav', 'This WAV file is damaged: it has no format chunk, which says how its sound is stored, so the sound cannot be read.'],
    ['no-channels.wav', 'This WAV file is damaged: its header states no channels or no sample rate, so the sound cannot be read.'],
    ['twelve-bit.wav', 'This WAV file holds 12-bit sound, which this page cannot read. An audio editor can save it again as 16 or 24-bit WAV.'],
    ['no-sound.wav', 'Its sound track is empty, so there is no audio to save. The file may be incomplete or damaged.']]) assert.equal((await card(name)).msg, msg, name);
  assert.equal(await text('#m2m-status'), 'Added 4 files, 4 of them cannot be converted to MP3: see the message under each.');
  await convert();
  for (const [name, out, sr, freq, samples] of [['song.mp3', 'song.mp3', 44100, 440, 22050], ['song.flac', 'song (2).mp3', 44100, 600, 22050],
    ['voice.ogg', 'voice (2).mp3', 48000, 800], ['voice.m4a', 'voice.mp3', 44100, 300], ['clip.mp4', 'clip.mp3', 44100, 500]]) {
    const d = await dl(name);
    assert.equal(d.name, out, `${name} is saved as ${out}`);
    const m = checkMp3(d.bytes, { kbps: 192, sr, mono: name !== 'song.mp3', samples }, out);
    near(m.exact, sr / 2, sr * 0.03, `${name}: about 0.5 s`);
    const dec = await decode(d.bytes, sr);
    near(hz(dec.ch[0], sr), freq, 3, `${name}: the tone`);
  }
  await clear();

  // ---------- A recording with RIFF INFO tags in UTF-8: every tag, and the saving ----------
  await add(['take.wav']);
  let c = await card('take.wav');
  assert.deepEqual([c.info, c.note, c.state, c.msg], ['0:00.750 · PCM 16-bit · 44.1 kHz · stereo', '', 'Ready', '']);
  assert.equal(await text('#m2m-status'), 'Added take.wav: 0:00.750, PCM stereo.');
  assert.equal(await text('#m2m-edit-h'), 'Edit take.wav');
  assert.equal(await page.isVisible('#m2m-wave'), false, 'the waveform is folded away under Trim, fades and volume');
  await unfold('m2m-tags');
  assert.deepEqual([await page.inputValue('#m2m-title'), await page.inputValue('#m2m-artist'), await page.inputValue('#m2m-album')],
    [exp.tags.INAM, exp.tags.IART, exp.tags.IPRD], 'the INFO text is read as UTF-8');
  assert.equal(await text('#m2m-more-row'), ' Keep the file\'s other tags: date “2019”, genre “Speech”, track 3 of 12, composer “Ana Composer”, comment “Take 4, Zoom H5”');
  assert.equal(await page.isChecked('#m2m-more'), true);
  assert.equal(await page.isVisible('#m2m-cover-row'), false, 'no cover to keep');
  assert.equal(await text('#m2m-tags .hint'), 'Saved as ID3 tags (version 2.3, and version 1 for old players).');
  const takeBytes = exp['take.wav'].bytes;
  assert.equal(await text('#m2m-estimate'), `Estimated size: about 18 KB as take.mp3, ${smaller(takeBytes, 18300)} than the WAV.`);
  await convert();
  const take = await dl('take.wav');
  assert.equal(take.name, 'take.mp3');
  dump('take.mp3', take.bytes);
  let m = checkMp3(take.bytes, { kbps: 192, sr: 44100, mono: false, samples: exp['take.wav'].samples }, 'take.mp3');
  assert.deepEqual(m.tags, { TIT2: exp.tags.INAM, TPE1: exp.tags.IART, TALB: exp.tags.IPRD, TRCK: '3/12', TCOM: 'Ana Composer', TYER: '2019', TCON: 'Speech',
    COMM: { lang: 'eng', desc: '', text: 'Take 4, Zoom H5' } }, 'every RIFF INFO tag as ID3v2.3, the year as a year');
  assert.deepEqual([m.enc.TIT2, m.enc.TPE1, m.enc.TALB], [1, 0, 1], 'ISO-8859-1 where the text fits, else UTF-16');
  assert.deepEqual(m.v1, { title: 'Morning take', artist: 'Zoë Field', album: 'Field notes', year: '2019', comment: 'Take 4, Zoom H5', zero: 0, track: 3, genre: 255 },
    'ID3v1, cut where ISO-8859-1 ends');
  let dec = await decode(take.bytes, 44100);
  assert.equal(dec.len, 33075, 'decoded, exactly as long as the WAV');
  near(hz(dec.ch[0], 44100), 440, 1, 'left: 440 Hz');
  near(hz(dec.ch[1], 44100), 660, 1, 'right: 660 Hz');
  // LAME takes a quarter of a dB off this pair of tones (ffmpeg's libmp3lame the same).
  near(rms(dec.ch[0].slice(4410, 28665)), 0.3536, 0.015, 'left RMS');
  near(rms(dec.ch[1].slice(4410, 28665)), 0.1768, 0.008, 'right RMS');
  const takeLine = `${fmtBytes(takeBytes)} WAV → ${fmtBytes(take.bytes.length)} MP3, ${smaller(takeBytes, take.bytes.length)}`;
  c = await card('take.wav');
  assert.deepEqual([c.state, c.download], [`Converted: take.mp3. ${takeLine}.`, true]);
  assert.equal(await text('#m2m-status'), `take.mp3 is ready to download: ${takeLine}.`);
  assert.equal(await page.isVisible('#m2m-total'), false, 'no total for one file');
  // A part of it: the saving of that part.
  await unfold('m2m-trim');
  await typeInto('#m2m-start', '0.25');
  await typeInto('#m2m-end', '0.5');
  assert.deepEqual([(await card('take.wav')).state, (await card('take.wav')).download], ['Ready, from 0:00.250 to 0:00.500', false], 'a new cut makes the result out of date');
  assert.equal(await text('#m2m-estimate'), `Estimated size: about 6.3 KB as take.mp3, ${smaller(44100, 6300)} than that part of the WAV.`);
  await convert();
  const part = await dl('take.wav');
  checkMp3(part.bytes, { kbps: 192, sr: 44100, mono: false, samples: 11025 }, 'a quarter second of take.wav');
  assert.equal((await card('take.wav')).state, `Converted: take.mp3. 0:00.250 of 0:00.750: 44 KB WAV → ${fmtBytes(part.bytes.length)} MP3, ${smaller(44100, part.bytes.length)}.`);
  await page.click('#m2m-all');
  await page.click('#m2m-trim summary');
  assert.equal(await page.isVisible('#m2m-wave'), false, 'folded again');

  // ---------- Tags in an 'id3 ' chunk after the sound, with a cover ----------
  await add(['tags-after.wav']);
  await edit('tags-after.wav');
  assert.deepEqual([await page.inputValue('#m2m-title'), await page.inputValue('#m2m-artist'), await page.inputValue('#m2m-album')], [exp.id3.title, exp.id3.artist, exp.id3.album]);
  assert.equal(await text('#m2m-more-row'), ' Keep the file\'s other tags: date “2021-06-15”, genre “Podcast”, track 7 of 9, disc 1 of 2, album artist “Album Artist”, composer “After Composer”, comment “Second line follows here”, lyrics');
  assert.equal(await page.isVisible('#m2m-cover-row'), true);
  assert.equal(await text('#m2m-estimate'), 'Estimated size: about 10 KB as tags-after.mp3, 86% smaller than the WAV. Its sound is at 22.05 kHz, where MP3 goes up to 160 kbps, so it is saved at 160 kbps.');
  await convert();
  const after = await dl('tags-after.wav');
  dump('tags-after.mp3', after.bytes);
  m = checkMp3(after.bytes, { kbps: 160, sr: 22050, mono: true, samples: 11025 }, 'tags-after.mp3');
  const pic = m.tags.APIC;
  delete m.tags.APIC;
  assert.deepEqual(m.tags, { TIT2: exp.id3.title, TPE1: exp.id3.artist, TALB: exp.id3.album, TPE2: 'Album Artist', TRCK: '7/9', TPOS: '1/2', TCOM: 'After Composer',
    TYER: '2021', TDAT: '1506', TCON: 'Podcast', COMM: { lang: 'eng', desc: '', text: 'Second line follows\nhere' }, USLT: { lang: 'eng', desc: '', text: 'La la la\nLa la' } });
  assert.equal(sha(apicImage(pic)), exp.coverSha256, 'the 300×300 JPEG cover, byte for byte');
  assert.deepEqual([pic[0], pic.toString('latin1', 1, 11), pic[12]], [0, 'image/jpeg', 3], 'APIC: front cover, image/jpeg');
  // The total of the two files on screen.
  const afterBytes = exp['tags-after.wav'].bytes;
  assert.equal(await text('#m2m-total'), `All 2 files: ${fmtBytes(takeBytes + afterBytes)} WAV → ${fmtBytes(take.bytes.length + after.bytes.length)} MP3, ${smaller(takeBytes + afterBytes, take.bytes.length + after.bytes.length)}.`);
  // Unticked, the other tags and the cover are left out.
  await page.uncheck('#m2m-more');
  await page.uncheck('#m2m-cover');
  assert.equal((await card('tags-after.wav')).download, false, 'a tag change makes the result out of date');
  await convert();
  m = parseMp3((await dl('tags-after.wav')).bytes);
  assert.deepEqual(m.tags, { TIT2: exp.id3.title, TPE1: exp.id3.artist, TALB: exp.id3.album }, 'only the title, artist and album');
  assert.deepEqual([m.v1.title, m.v1.year, m.v1.comment, m.v1.track], ['Tagged after', '', '', 0]);
  await clear();

  // ---------- Every kind of WAV: bit depths, float, G.711, RF64, BWF, surround ----------
  const kinds = ['pcm8.wav', 'pcm32.wav', 'float64.wav', 'ulaw.wav', 'alaw.wav', 'rf64.wav', 'bwf.wav', 'three.wav', 'surround51.wav', 'surround71.wav'];
  await add(kinds);
  const infos = {
    'pcm8.wav': '0:00.500 · PCM 8-bit · 8 kHz · mono', 'pcm32.wav': '0:00.500 · PCM 32-bit · 16 kHz · mono', 'float64.wav': '0:00.250 · 64-bit float · 22.05 kHz · mono',
    'ulaw.wav': '0:01.000 · µ-law · 8 kHz · mono · 64 kbps', 'alaw.wav': '0:01.000 · A-law · 8 kHz · mono · 64 kbps',
    'rf64.wav': '0:00.250 · PCM 16-bit · 44.1 kHz · stereo · RF64', 'bwf.wav': '0:00.250 · PCM 24-bit · 48 kHz · stereo · BWF',
    'three.wav': '0:00.100 · PCM 16-bit · 48 kHz · 3 channels', 'surround51.wav': '0:00.100 · PCM 16-bit · 48 kHz · 5.1 surround',
    'surround71.wav': '0:00.100 · PCM 16-bit · 48 kHz · 7.1 surround'
  };
  for (const name of kinds) assert.equal((await card(name)).info, infos[name], name);
  for (const name of ['three.wav', 'surround71.wav']) {
    assert.equal((await card(name)).msg, `Its sound has ${exp[name].ch} channels, and MP3 keeps only the first two (usually front left and right; with Mono only the first), so sound that is only in the others, such as speech in a centre channel, is lost.`);
  }
  await edit('pcm8.wav');
  assert.equal(await text('#m2m-estimate'), 'Estimated size: about 4.3 KB as pcm8.mp3, 6% bigger than the WAV. Its sound is at 8 kHz, where MP3 goes up to 64 kbps, so it is saved at 64 kbps.',
    'a phone-rate recording keeps its 8 kHz');
  await convert();
  const outs = {};
  for (const [name, kbps, sr, mono, samples] of [['pcm8.wav', 64, 8000, true, 4000], ['pcm32.wav', 160, 16000, true, 8000], ['float64.wav', 160, 22050, true, 5512],
    ['ulaw.wav', 64, 8000, true, 8000], ['alaw.wav', 64, 8000, true, 8000], ['rf64.wav', 192, 44100, false, 11025], ['bwf.wav', 192, 48000, false, 12000],
    ['three.wav', 192, 48000, false, 4800], ['surround51.wav', 192, 48000, false, 4800], ['surround71.wav', 192, 48000, false, 4800]]) {
    const d = await dl(name);
    dump(d.name, d.bytes);
    checkMp3(d.bytes, { kbps, sr, mono, samples, v1: true }, name);
    outs[name] = await decode(d.bytes, sr);
    assert.equal(outs[name].len, samples, `${name}: decoded to ${samples} samples`);
  }
  for (const [name, freq, sr] of [['pcm8.wav', 300, 8000], ['pcm32.wav', 500, 16000], ['float64.wav', 700, 22050], ['ulaw.wav', 400, 8000], ['alaw.wav', 400, 8000]]) {
    near(hz(outs[name].ch[0], sr), freq, 2, `${name}: the tone`);
    // Within 0.8 dB: LAME at 64 kbps and 8 kHz takes up to half a dB off a tone.
    near(rms(outs[name].ch[0].slice(Math.floor(outs[name].len * 0.2), Math.floor(outs[name].len * 0.8))), 0.3536, 0.03, `${name}: its level`);
  }
  for (const name of ['rf64.wav', 'bwf.wav']) {
    const sr = name === 'bwf.wav' ? 48000 : 44100;
    near(hz(outs[name].ch[0], sr), 440, 2, `${name}: left`);
    near(hz(outs[name].ch[1], sr), 660, 2, `${name}: right`);
  }
  // Surround: 5.1 is mixed down (left = FL + 0.707 (FC + BL), scaled by
  // 0.414 so that it cannot clip, LFE left out); of 3.0 and 7.1 the first two
  // channels are kept. Each channel of the files holds its own tone at 0.25.
  const lvl = (x, f) => toneDb(x, 48000, f);
  const H = exp.channelHz, k51 = Math.SQRT2 - 1;
  for (const [ch, own, cross] of [[0, H[0], H[1]], [1, H[1], H[0]]]) {
    near(lvl(outs['surround51.wav'].ch[ch], own), db(0.25 * k51), 0.3, `5.1 ${ch ? 'right' : 'left'}: its front channel`);
    near(lvl(outs['surround51.wav'].ch[ch], H[2]), db(0.25 * k51 * Math.SQRT1_2), 0.3, `5.1 ${ch ? 'right' : 'left'}: the centre at 0.707`);
    near(lvl(outs['surround51.wav'].ch[ch], H[4 + ch]), db(0.25 * k51 * Math.SQRT1_2), 0.3, `5.1 ${ch ? 'right' : 'left'}: its surround at 0.707`);
    assert.ok(lvl(outs['surround51.wav'].ch[ch], H[3]) < -60, '5.1: the LFE is left out');
    assert.ok(lvl(outs['surround51.wav'].ch[ch], cross) < -60, '5.1: the other front channel is not in this one');
    for (const name of ['three.wav', 'surround71.wav']) {
      near(lvl(outs[name].ch[ch], own), db(0.25), 0.3, `${name} ${ch ? 'right' : 'left'}: the front channel as it is`);
      assert.ok(lvl(outs[name].ch[ch], H[2]) < -60, `${name}: the centre is not mixed in`);
    }
  }
  await clear();

  // ---------- 88.2 to 192 kHz: resampled with a windowed-sinc filter, no aliases ----------
  await add(['hires-96k.wav', 'hires-88k.wav', 'hires-192k.wav', 'float-loud.wav']);
  assert.equal((await card('hires-96k.wav')).info, '0:00.500 · PCM 24-bit · 96 kHz · mono');
  assert.equal((await card('hires-88k.wav')).info, '0:00.500 · PCM 16-bit · 88.2 kHz · mono');
  assert.equal((await card('hires-192k.wav')).info, '0:00.200 · 32-bit float · 192 kHz · mono');
  await edit('hires-96k.wav');
  assert.match(await text('#m2m-estimate'), /than the WAV\. MP3 has no 96 kHz, so its sound is resampled to 48 kHz\.$/);
  await edit('hires-88k.wav');
  assert.match(await text('#m2m-estimate'), /MP3 has no 88\.2 kHz, so its sound is resampled to 44\.1 kHz\.$/);
  // A 32-bit float recording over full scale: the readout says how far to turn it down.
  await edit('float-loud.wav');
  assert.equal((await card('float-loud.wav')).info, '0:00.500 · 32-bit float · 48 kHz · mono');
  await unfold('m2m-trim');
  await page.waitForFunction(() => document.getElementById('m2m-peak').textContent !== '');
  assert.equal(await text('#m2m-peak'), 'At this volume the loudest parts go above full scale and will distort. 65% is the most without distortion.');
  await convert();
  for (const [name, sr, alias] of [['hires-96k.wav', 48000, 18000], ['hires-88k.wav', 44100, 14100], ['hires-192k.wav', 48000, 8000]]) {
    const d = await dl(name);
    dump(d.name, d.bytes);
    const samples = Math.round(exp[name].samples * sr / exp[name].sr);
    checkMp3(d.bytes, { kbps: 192, sr, mono: true, samples }, name);
    const x = (await decode(d.bytes, sr)).ch[0];
    near(toneDb(x, sr, 1000), db(0.5), 0.3, `${name}: the 1 kHz tone`);
    const a = toneDb(x, sr, alias);
    assert.ok(a < -75, `${name}: its ${exp[name].sr / 1000} kHz content does not fold back to ${alias} Hz (${a.toFixed(1)} dBFS)`);
  }
  // At 100% the peaks are clipped at full scale (the encoder takes 16-bit
  // samples): the third harmonic of a sine at 1.5 clipped at 1 is at -15.1
  // dBFS (numpy). At 65% the tone is whole.
  let loud = (await decode((await dl('float-loud.wav')).bytes, 48000)).ch[0];
  near(toneDb(loud, 48000, 1320), -15.1, 1.5, 'float-loud.wav at 100%: clipped, with a 1320 Hz harmonic');
  await page.fill('#m2m-vol', '65');
  assert.equal(await text('#m2m-peak'), 'Loudest point at this volume: −0.2 dB of full scale. Up to 65% stays clear of distortion.');
  await convert();
  loud = (await decode((await dl('float-loud.wav')).bytes, 48000)).ch[0];
  near(peakOf(loud), 1.5 * 0.65, 0.04, 'float-loud.wav at 65%: its peaks');
  assert.ok(toneDb(loud, 48000, 1320) < -60, `float-loud.wav at 65%: no clipping harmonic (${toneDb(loud, 48000, 1320).toFixed(1)} dBFS)`);
  near(hz(loud, 48000), 440, 1, 'float-loud.wav: the tone');
  await page.fill('#m2m-vol', '100');
  await clear();

  // ---------- MP3 inside a WAV: saved as it is ----------
  await add(['mp3-in.wav']);
  c = await card('mp3-in.wav');
  assert.deepEqual([c.info, c.note], ['0:01.080 · MP3 in a WAV · 16 kHz · mono · 64 kbps', 'This WAV holds MP3 sound, which is saved as it is, without re-encoding.']);
  assert.deepEqual([await page.isVisible('#m2m-asis-row'), await page.isChecked('#m2m-asis')], [true, true]);
  await unfold('m2m-trim');
  assert.deepEqual([await page.isVisible('#m2m-asis-note'), await page.isDisabled('#m2m-vol'), await page.isDisabled('#m2m-fadein'), await text('#m2m-peak')],
    [true, true, true, ''], 'fades, volume and the readout do not apply');
  await convert();
  let inside = await dl('mp3-in.wav');
  dump('mp3-in.mp3', inside.bytes);
  m = parseMp3(inside.bytes);
  const head = 10 + synch(inside.bytes.subarray(6, 10)), frames = inside.bytes.subarray(head, inside.bytes.length - 128);
  assert.deepEqual([sha(frames), frames.length], [exp['mp3-in.wav'].mp3Sha256, exp['mp3-in.wav'].mp3Bytes], 'the MP3 frames, byte for byte');
  assert.deepEqual([m.tags.TIT2, m.tags.TPE1, m.v1.title], ['MP3 inside', 'Wave Artist', 'MP3 inside'], 'with the WAV\'s tags');
  // Trimmed, it is cut between frames without re-encoding.
  await typeInto('#m2m-start', '0.3');
  await typeInto('#m2m-end', '0.8');
  await convert();
  inside = await dl('mp3-in.wav');
  m = parseMp3(inside.bytes);
  for (const f of m.frames.slice(-3)) assert.ok(frames.includes(inside.bytes.subarray(f.pos, f.pos + f.len)), 'frames copied, not re-encoded');
  dec = await decode(inside.bytes, 16000);
  assert.equal(dec.len, 8000, 'the cut is the 0.5 s chosen');
  near(hz(dec.ch[0], 16000), 440, 2, 'the cut: 440 Hz');
  // Unticked, it is re-encoded with the settings below.
  await page.uncheck('#m2m-asis');
  assert.deepEqual([await page.isVisible('#m2m-asis-note'), await page.isDisabled('#m2m-vol'), (await card('mp3-in.wav')).note], [false, false, '']);
  await page.click('#m2m-all');
  await convert();
  checkMp3((await dl('mp3-in.wav')).bytes, { kbps: 160, sr: 16000, mono: true, samples: 17280 }, 'mp3-in.wav re-encoded');
  await clear();

  // ---------- Headers that state the wrong length are read to the real end ----------
  const broken = ['never-finished.wav', 'unknown-size.wav', 'short-header.wav', 'cut-off.wav', 'list-after.wav'];
  await add(broken.slice(0, 1));
  await add(broken.slice(1));
  const notes = {
    'never-finished.wav': 'Its header was never finished, as when a recorder stops suddenly, so the sound is read to the end of the file: 0:01.000.',
    'unknown-size.wav': 'Its header does not state how long the sound is, as some recorders leave it while recording, so the sound is read to the end of the file: 0:01.000.',
    'short-header.wav': 'Its header states less sound than the file holds, so all of it is read: 0:01.000.',
    'cut-off.wav': 'Its header states more sound than the file holds, perhaps a copy that did not finish, so it is read to where the sound stops: 0:00.600.',
    'list-after.wav': ''
  };
  for (const name of broken) assert.equal((await card(name)).note, notes[name], name);
  assert.ok((await live()).includes(`Added never-finished.wav: 0:01.000, PCM mono. ${notes['never-finished.wav']}`), 'the note is said when the file is added');
  // ffmpeg trusts the stated size and reads 0.4 s of short-header.wav; it holds 1 s.
  assert.equal(exp['short-header.wav'].samples, 3200);
  await edit('list-after.wav');
  await unfold('m2m-tags');
  assert.equal(await page.inputValue('#m2m-title'), 'Tag after the sound');
  await convert();
  for (const [name, n] of [['never-finished.wav', 8000], ['unknown-size.wav', 8000], ['short-header.wav', 8000], ['cut-off.wav', 4800], ['list-after.wav', 8000]]) {
    const d = await dl(name);
    checkMp3(d.bytes, { kbps: 64, sr: 8000, mono: true, samples: n }, name);
    const x = (await decode(d.bytes, 8000)).ch[0];
    assert.equal(x.length, n, `${name}: ${n} samples`);
    near(hz(x, 8000), 1000, 2, `${name}: the 1 kHz tone throughout`);
    near(rms(x.slice(400, n - 400)), 0.3536, 0.02, `${name}: no chunk read as sound`);
  }
  await clear();

  // ---------- A big MP3 is written straight to a file as it converts ----------
  // The page asks where to save an MP3 of 200 MB or more. Here a short
  // recording is made to look that big, and the save dialog hands over a
  // file kept in memory, so that what is written can be compared with the
  // MP3 the page builds in memory for the same file.
  await add(['take.wav', 'rf64.wav']);
  const inMemory = { take: take.bytes };
  await page.evaluate(() => {
    window.__estimate = TTAudio.estimate;
    TTAudio.estimate = (m, ti, o) => window.__estimate(m, ti, o) * 100000;
    window.__fakePicker({});
    document.getElementById('m2m-bitrate').dispatchEvent(new Event('change'));
  });
  await edit('take.wav');
  assert.match(await text('#m2m-estimate'), / An MP3 this big is written straight to a file as it converts: Convert asks where to save it\.$/);
  await page.click('#m2m-convert');
  await waitIdle();
  assert.deepEqual(await page.evaluate(() => window.__picks), [{ suggestedName: 'take.mp3', types: [{ description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } }] }], 'one save dialog, for the first big file');
  let saved = await page.evaluate(() => { const f = window.__saved['chosen.mp3']; return { b64: btoa(Array.from(f.bytes, x => String.fromCharCode(x)).join('')), closed: f.closed, aborted: f.aborted }; });
  assert.deepEqual([saved.closed, saved.aborted], [true, false], 'the file is closed once written');
  assert.ok(Buffer.from(saved.b64, 'base64').equals(inMemory.take), 'what is written is the MP3 built in memory, byte for byte');
  c = await card('take.wav');
  const takeSaved = `${fmtBytes(takeBytes)} WAV → ${fmtBytes(inMemory.take.length)} MP3, ${smaller(takeBytes, inMemory.take.length)}`;
  assert.deepEqual([c.state, c.download], [`Saved: chosen.mp3. ${takeSaved}.`, false], 'saved already, so no Download button');
  assert.equal(await text('#m2m-status'), `chosen.mp3 is saved: ${takeSaved}. One more file is written straight to a file: press Convert to choose where.`);
  assert.equal((await card('rf64.wav')).state, 'Ready', 'one big file a press');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-convert', 'the focus goes to Convert for the next one');
  // The save dialog closed without a choice: nothing is converted.
  await page.evaluate(() => window.__fakePicker({ cancel: true }));
  await page.click('#m2m-convert');
  await page.waitForFunction(() => document.getElementById('m2m-status').textContent.startsWith('Nothing'));
  assert.equal(await text('#m2m-status'), 'Nothing was converted: no file was chosen to save rf64.wav in.');
  assert.equal((await card('rf64.wav')).state, 'Ready');
  // A disk that fills up: the file is discarded and the reason shown.
  await page.evaluate(() => window.__fakePicker({ fail: 3, names: ['full.mp3'] }));
  await page.click('#m2m-convert');
  await waitIdle();
  c = await card('rf64.wav');
  assert.equal(c.msg, 'The MP3 could not be written to full.mp3 (There is not enough space on the disk.). Check the space left on the device, then convert it again.');
  assert.equal(await page.evaluate(() => window.__saved['full.mp3'].closed), false, 'the stream is never closed, so nothing half-written is kept');
  // Saved properly at Speech settings.
  await row('take.wav').locator('.m2m-remove').click();
  await page.click('#m2m-p-speech64');
  await page.evaluate(() => window.__fakePicker({ names: ['rf64 speech.mp3'] }));
  await convert();
  assert.equal((await card('rf64.wav')).state, `Saved: rf64 speech.mp3. ${fmtBytes(exp['rf64.wav'].bytes)} WAV → ${fmtBytes(await page.evaluate(() => window.__saved['rf64 speech.mp3'].bytes.length))} MP3, ${smaller(exp['rf64.wav'].bytes, await page.evaluate(() => window.__saved['rf64 speech.mp3'].bytes.length))}.`);
  saved = await page.evaluate(() => btoa(Array.from(window.__saved['rf64 speech.mp3'].bytes, x => String.fromCharCode(x)).join('')));
  // Cancel while it writes: the file is aborted, not closed.
  await dropWav('twenty.wav', 44100, 20, ['0.4 * Math.sin(2 * Math.PI * 440 * t)', '0.4 * Math.sin(2 * Math.PI * 550 * t)']);
  await waitRead();
  await page.evaluate(() => window.__fakePicker({ slow: 300, names: ['slow.mp3'] }));
  await page.click('#m2m-convert');
  await page.waitForFunction(() => window.__saved['slow.mp3'] && window.__saved['slow.mp3'].bytes.length > 0);
  await page.click('#m2m-cancel');
  await waitIdle();
  assert.deepEqual(await page.evaluate(() => [window.__saved['slow.mp3'].aborted, window.__saved['slow.mp3'].closed]), [true, false]);
  assert.equal((await card('twenty.wav')).state, 'Ready');
  assert.equal(await text('#m2m-status'), 'Conversion cancelled.');
  await row('twenty.wav').locator('.m2m-remove').click();
  // The same file built in memory: the same bytes as written.
  await page.evaluate(() => { TTAudio.estimate = window.__estimate; window.showSaveFilePicker = undefined; });
  await page.click('#m2m-p-speech96');
  await page.click('#m2m-p-speech64');
  await convert();
  const rfMem = await dl('rf64.wav');
  assert.ok(Buffer.from(saved, 'base64').equals(rfMem.bytes), 'Speech 64 kbps mono: written and built in memory alike');
  checkMp3(rfMem.bytes, { kbps: 64, sr: 44100, mono: true, samples: 11025 }, 'rf64.wav at Speech 64');
  await page.click('#m2m-p-music');
  await clear();

  // ---------- A 4.5 GB WAV whose sizes wrapped round past 4 GB ----------
  // Built of repeated parts, so that it takes no memory: 16-bit stereo at
  // 44.1 kHz, the last 2 s a 1 kHz tone. It is read to its end.
  const cpu0 = await thread();
  await page.evaluate(() => {
    const sr = 44100, n = 2 * sr, pcm = new Int16Array(2 * n);
    for (let i = 0; i < n; i++) pcm[2 * i] = pcm[2 * i + 1] = Math.round(16000 * Math.sin(2 * Math.PI * 1000 * i / sr));
    const mb = new Blob([new Uint8Array(1 << 20)]), parts = [], count = 4292;
    for (let i = 0; i < count; i++) parts.push(mb);
    const data = count * (1 << 20) + pcm.byteLength, h = new DataView(new ArrayBuffer(44)), w = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, (36 + data) % 4294967296, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
    h.setUint32(24, sr, true); h.setUint32(28, 4 * sr, true); h.setUint16(32, 4, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, data % 4294967296, true);
    const dt = new DataTransfer();
    dt.items.add(new File([h.buffer, ...parts, pcm], 'huge.wav', { type: 'audio/wav' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitRead();
  const spent = (await thread()) - cpu0;
  const hugeSize = 44 + 4292 * (1 << 20) + 4 * 2 * 44100, hugeMs = Math.round((hugeSize - 44) / 176400 * 1000);
  c = await card('huge.wav');
  assert.equal(c.info, `${fmtTime(hugeMs)} · PCM 16-bit · 44.1 kHz · stereo`);
  assert.ok(hugeMs > 7 * 3600000, `${fmtTime(hugeMs)} of sound`);
  assert.equal(c.note, `A plain WAV cannot state sizes over 4 GB, so this header is wrong. The sound is read to the end of the file: ${fmtTime(hugeMs)}.`);
  assert.ok(spent < 3000, `opening a 4.5 GB file took ${Math.round(spent)} ms of main-thread time`);
  const hugeEst = Math.round(192 * 125 * hugeMs / 1000) + 300;
  assert.equal(await text('#m2m-estimate'), `Estimated size: about ${fmtBytes(hugeEst)} as huge.mp3, ${smaller(hugeSize, hugeEst)} than the WAV. An MP3 this big is written straight to a file as it converts: Convert asks where to save it.`);
  // Its last 1.5 s, small enough to build in memory.
  await unfold('m2m-trim');
  await typeInto('#m2m-start', fmtTime(hugeMs - 1500));
  await page.waitForFunction(() => /^Estimated size: about 36 KB/.test(document.getElementById('m2m-estimate').textContent));
  await convert();
  const tail = await dl('huge.wav');
  near(checkMp3(tail.bytes, { kbps: 192, sr: 44100, mono: false }, 'the last 1.5 s of huge.wav').exact, 66150, 50, 'the last 1.5 s of huge.wav');
  near(hz((await decode(tail.bytes, 44100)).ch[0], 44100), 1000, 2, 'the end of a 4.5 GB file holds its 1 kHz tone');
  await clear();

  // ---------- An hour: progress, the wake lock, a hidden tab and Cancel ----------
  await page.evaluate(() => {
    const sr = 44100, one = new Int16Array(2 * sr);
    for (let i = 0; i < sr; i++) one[2 * i] = one[2 * i + 1] = Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / sr));
    const sec = new Blob([one]), parts = [];
    for (let i = 0; i < 3600; i++) parts.push(sec);
    const data = 3600 * 4 * sr, h = new DataView(new ArrayBuffer(44)), w = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
    h.setUint32(24, sr, true); h.setUint32(28, 4 * sr, true); h.setUint16(32, 4, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, data, true);
    const dt = new DataTransfer();
    dt.items.add(new File([h.buffer, ...parts], 'hour.wav', { type: 'audio/wav' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitRead();
  assert.equal((await card('hour.wav')).info, '1:00:00.000 · PCM 16-bit · 44.1 kHz · stereo');
  assert.equal(await text('#m2m-estimate'), `Estimated size: about 86.4 MB as hour.mp3, ${smaller(44 + 3600 * 176400, 86400300)} than the WAV.`);
  const wake0 = await page.evaluate(() => window.__wake.requested);
  await page.click('#m2m-convert');
  await page.waitForFunction(() => /^Converting… [1-9]/.test(document.querySelector('.m2m-file-state').textContent), null, { timeout: 30000 });
  // A hidden tab carries on: the engine's waits are messages, not timers.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const p1 = await page.evaluate(() => +document.getElementById('m2m-bar').value);
  await page.waitForFunction(p => +document.getElementById('m2m-bar').value > p, p1, { timeout: 30000 });
  await page.evaluate(() => {
    delete document.visibilityState; delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => window.__wake.requested) > wake0, true, 'the screen is kept on while converting');
  assert.match(await text('#m2m-progress-text'), /^hour\.wav, \d+%$/);
  await page.click('#m2m-cancel');
  await waitIdle();
  assert.equal(await text('#m2m-status'), 'Conversion cancelled.');
  assert.deepEqual([(await card('hour.wav')).state, await page.isVisible('#m2m-progress')], ['Ready', false]);
  assert.equal(await page.evaluate(() => window.__wake.released >= 1), true, 'and let go when it stops');
  await clear();

  // ---------- Typed times: decimal commas, errors and their fields ----------
  await add(['take.wav']);
  await unfold('m2m-trim');
  for (const [typed, ms] of [['0,5', 500], ['0.5', 500], ['0:00,25', 250], ['٠٫٥', 500]]) {
    await typeInto('#m2m-start', typed);
    assert.equal(await page.evaluate(() => document.getElementById('m2m-start').getAttribute('aria-invalid')), null, typed);
    assert.equal((await card('take.wav')).state, `Ready, from ${fmtTime(ms)} to 0:00.750`, `${typed} is ${ms} ms`);
  }
  // Refused: a raised digit, a tab, 75 seconds, a start too near the end.
  for (const [typed, msg] of [['0.5²', 'Type the start as minutes:seconds, such as 1:05.5, or as seconds, such as 65.5.'], ['1\t2', 'Type the start as minutes:seconds, such as 1:05.5, or as seconds, such as 65.5.'],
    ['0:75', 'Minutes and seconds go up to 59: write 1:15 rather than 0:75.'], ['0.7', 'The start must be at least 0.1 seconds before the end (0:00.750).']]) {
    await typeInto('#m2m-start', typed);
    assert.equal(await text('#m2m-time-error'), msg, typed);
    assert.equal(await page.getAttribute('#m2m-start', 'aria-invalid'), 'true');
    assert.match(await page.getAttribute('#m2m-start', 'aria-describedby'), /\bm2m-time-error\b/);
    assert.equal(await page.isDisabled('#m2m-convert'), false);
  }
  await page.click('#m2m-convert');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-start', 'Convert is refused while a time is wrong, and the field gets the focus');
  assert.equal((await card('take.wav')).state, 'Ready, from 0:00.500 to 0:00.750', 'the last time that was right stays');
  await typeInto('#m2m-fadein', 'x');
  assert.equal(await text('#m2m-fade-error'), 'Type the fade-in length in seconds, such as 2 or 0.5.');
  assert.deepEqual([await page.getAttribute('#m2m-fadein', 'aria-invalid'), await page.getAttribute('#m2m-fadein', 'aria-describedby')], ['true', 'm2m-fade-error']);
  await typeInto('#m2m-fadein', '0');
  await typeInto('#m2m-start', '0');
  assert.equal(await page.getAttribute('#m2m-start', 'aria-invalid'), null);
  // A megabyte pasted into a tag field is cut at once.
  await unfold('m2m-tags');
  const cpu1 = await thread();
  await typeInto('#m2m-title', 'é'.repeat(1 << 20));
  assert.equal((await page.inputValue('#m2m-title')).length, 200);
  assert.ok((await thread()) - cpu1 < 1500, 'a megabyte in a tag field stays quick');

  // ---------- Keyboard only: choose, preset, convert, download ----------
  await clear();
  await page.focus('#m2m-open');
  await page.keyboard.press('Enter');
  await (await chooserReady).setFiles([F('take.wav')]);
  await waitRead();
  await page.focus('#m2m-p-speech96');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#m2m-bitrate'), '96');
  await page.focus('#m2m-convert');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), true, 'a visible focus ring');
  await page.keyboard.press('Enter');
  await waitIdle();
  assert.equal(await page.evaluate(() => document.activeElement.className), 'btn small m2m-dl', 'the focus moves to Download');
  const kb = await download(() => page.keyboard.press('Enter'));
  checkMp3(kb.bytes, { kbps: 96, sr: 44100, mono: true, samples: 33075 }, 'take.wav at Speech 96 kbps');
  // A double click on Convert converts once, and on Download saves once.
  await page.click('#m2m-p-music');
  const live0 = (await live()).length;
  await page.dblclick('#m2m-convert');
  await waitIdle();
  assert.equal((await live()).slice(live0).filter(t => t.startsWith('Converting')).length, 1, 'one conversion for a double click');
  let downloads = 0;
  const count = () => downloads++;
  page.on('download', count);
  await row('take.wav').locator('.m2m-dl').dblclick();
  await page.waitForTimeout(1000);
  page.off('download', count);
  assert.equal(downloads, 1, 'one download for a double click');
  // A setting changed after converting makes the result out of date.
  await page.selectOption('#m2m-bitrate', '128');
  assert.deepEqual([(await card('take.wav')).state, (await card('take.wav')).download], ['Ready', false]);
  // Fields the browser restores on Back are read again.
  await page.evaluate(() => { document.getElementById('m2m-bitrate').value = '320'; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await text('#m2m-format-hint'), 'MP3 at 320 kbps takes about 2.40 MB a minute, 77% less than 16-bit stereo WAV at 44.1 kHz (10.6 MB).' + HINT);
  await page.click('#m2m-p-music');
  // Leave a converted file and the total on screen for the runner's phone-width checks.
  await add(['tags-after.wav']);
  await convert();
  assert.match(await text('#m2m-total'), /^All 2 files: .* WAV → .* MP3, \d+% smaller\.$/);

  // ---------- Without WebCodecs audio (Firefox for Android, Safari 16.4 to 18) ----------
  // WAV is decoded by mediabunny's own code, so the MP3 comes out the same.
  const noWc = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  const pw = await noWc.newPage();
  await pw.addInitScript(() => { for (const k of ['AudioDecoder', 'AudioEncoder', 'AudioData', 'EncodedAudioChunk']) delete window[k]; });
  await pw.addInitScript(instrument);
  await pw.goto(url);
  assert.equal(await pw.evaluate(() => typeof AudioDecoder), 'undefined');
  await add(['take.wav', 'hires-96k.wav', 'song.mp3'], pw);
  assert.equal((await card('song.mp3', pw)).info, '0:00.500 · MP3 · 44.1 kHz · stereo · 128 kbps');
  await convert(pw);
  const wTake = await dl('take.wav', pw);
  assert.ok(wTake.bytes.equals(take.bytes), 'take.mp3 without WebCodecs: the same bytes');
  checkMp3((await dl('hires-96k.wav', pw)).bytes, { kbps: 192, sr: 48000, mono: true, samples: 24000 }, 'hires-96k.wav without WebCodecs');
  const wSong = await dl('song.mp3', pw);
  checkMp3(wSong.bytes, { kbps: 192, sr: 44100, mono: false, samples: 22050 }, 'song.mp3 decoded whole without WebCodecs');
  await noWc.close();

  // ---------- A phone with touch, in a decimal-comma locale, without a save dialog ----------
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'], locale: 'de-DE' });
  const pp = await phone.newPage();
  await pp.addInitScript(() => { delete window.showSaveFilePicker; });
  await pp.addInitScript(instrument);
  await pp.goto(url);
  assert.equal(await pp.evaluate(() => TTAudio.PHONE && TTAudio.limits.wav), 300e6);
  for (const sel of ['#m2m-p-music', '#m2m-p-speech96', '#m2m-p-speech64', '#m2m-convert', '#m2m-open']) {
    const box = await pp.locator(sel).boundingBox();
    assert.ok(box.height >= 44, `${sel} is ${box.height}px tall`);
  }
  await pp.tap('#m2m-p-speech96');
  assert.deepEqual([await pp.inputValue('#m2m-bitrate'), await pp.inputValue('#m2m-channels')], ['96', 'mono']);
  await add(['take.wav'], pp);
  await unfold('m2m-trim', pp);
  await typeInto('#m2m-start', '0,25', pp);
  assert.equal((await card('take.wav', pp)).state, 'Ready, from 0:00.250 to 0:00.750');
  await pp.tap('#m2m-convert');
  await waitIdle(pp);
  checkMp3((await dl('take.wav', pp)).bytes, { kbps: 96, sr: 44100, mono: true, samples: 22050 }, 'take.wav on a phone');
  // A tap on the waveform moves the nearer handle there; a swipe that scrolls moves nothing.
  await pp.locator('#m2m-trackbox').scrollIntoViewIfNeeded();
  await settle(pp);
  const tb = await pp.locator('#m2m-trackbox').boundingBox();
  await pp.touchscreen.tap(tb.x + tb.width * 0.7, tb.y + tb.height * 0.8);
  const tapped = (await card('take.wav', pp)).state;
  assert.match(tapped, /^Ready, from 0:00\.250 to 0:00\.5[23]0$/, `a tap at 70% moves the nearer handle, the end, there: ${tapped}`);
  // A 4.5 GB recording is more MP3 than a phone may build in memory.
  await pp.evaluate(() => {
    const mb = new Blob([new Uint8Array(1 << 20)]), parts = [];
    for (let i = 0; i < 4292; i++) parts.push(mb);
    const data = 4292 * (1 << 20), h = new DataView(new ArrayBuffer(44)), w = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, (36 + data) % 4294967296, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
    h.setUint32(24, 44100, true); h.setUint32(28, 176400, true); h.setUint16(32, 4, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, data % 4294967296, true);
    const dt = new DataTransfer();
    dt.items.add(new File([h.buffer, ...parts], 'phone-huge.wav', { type: 'audio/wav' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitRead(pp);
  await pp.tap('#m2m-p-music');
  const phMs = Math.round(4292 * (1 << 20) / 176400 * 1000), phEst = Math.round(24000 * phMs / 1000) + 300;
  assert.equal((await card('phone-huge.wav', pp)).msg, `As MP3 this would be about ${fmtBytes(phEst)}, more than the 300 MB a phone can build in memory. Choose a lower bitrate, Mono or a shorter part (under Trim, fades and volume), or use Chrome on Android, or Chrome or Edge on a computer, which can write a big MP3 straight to a file as it converts.`);
  assert.equal(await text('#m2m-convert', pp), 'Convert to MP3', 'only take.wav is left to convert');
  await pp.tap('#m2m-p-speech64');
  assert.equal((await card('phone-huge.wav', pp)).msg, '', 'at 64 kbps mono it fits in memory');
  assert.equal(await text('#m2m-convert', pp), 'Convert 2 files to MP3');
  await phone.close();

  // What screen readers heard: each sentence once, when it was known.
  const said = await live();
  for (let i = 1; i < said.length; i++) assert.notEqual(said[i], said[i - 1], `"${said[i]}" was announced twice in a row`);
};
