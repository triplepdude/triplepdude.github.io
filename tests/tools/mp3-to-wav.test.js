const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { devices } = require('playwright');

// The samples and the facts checked against them come from
// tests/fixtures/mp3-to-wav/make_fixtures.py: ffprobe for each file, ffmpeg's
// decoding of each MP3 (it honours the LAME tag's encoder delay and padding,
// as gapless players do) measured with numpy, and the tags mutagen reads.
// The WAV files the page writes are parsed here (RIFF and RF64 chunks, RIFF
// INFO, the ID3v2.3 chunk, G.711 decoded with the reference tables) and
// compared with those facts, with the chirp the MP3s were made of, and with
// the browser's own decodeAudioData, which shares no code with the page's
// decoding pipeline. With M2W_DUMP set to a folder, the WAVs are also saved
// there for tests/fixtures/mp3-to-wav/check_outputs.py (ffprobe, ffmpeg with
// numpy, mutagen).
module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const exp = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const F = name => path.join(fixtures, name);
  // The copy-protected samples of MP4 to MP3 (a FairPlay song and an Audible book).
  const HUB = name => path.join(fixtures, '..', 'mp4-to-mp3', name);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const dump = (name, bytes) => { if (process.env.M2W_DUMP) fs.writeFileSync(path.join(process.env.M2W_DUMP, name), bytes); };

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
        const name = mode.names ? mode.names.shift() : 'chosen.wav';
        const file = window.__saved[name] = { bytes: new Uint8Array(0), closed: false, aborted: false, writes: 0, queued: 0, done: 0, queuedMax: 0 };
        return {
          name, kind: 'file',
          // As FileSystemWritableFileStream: one chunk at a time (a high water
          // mark of 1); queuedMax counts the chunks handed over but not yet written.
          createWritable: async () => new WritableStream({
            async write(c) {
              file.queuedMax = Math.max(file.queuedMax, file.queued - file.done);
              if (mode.slow) await new Promise(r => setTimeout(r, mode.slow));
              if (mode.fail && ++file.writes > mode.fail) throw new DOMException('There is not enough space on the disk.', 'QuotaExceededError');
              const d = new Uint8Array(c.data.buffer || c.data, c.data.byteOffset || 0, c.data.byteLength), end = c.position + d.length;
              if (end > file.bytes.length) { const b = new Uint8Array(end); b.set(file.bytes); file.bytes = b; }
              file.bytes.set(d, c.position);
              file.done++;
            },
            close() { file.closed = true; },
            abort() { file.aborted = true; }
          }, { highWaterMark: 1, size() { file.queued++; return 1; } })
        };
      };
    };
  };
  await page.addInitScript(instrument);
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
      const [d] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), action()]);
      return { name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) };
    } catch (e) {
      throw new Error(`${String(e.message).split('\n')[0]} (download ${caller})`);
    }
  };
  const dl = (name, p = page) => download(() => row(name, p).locator('.m2m-dl').click(), p);
  const convert = async (p = page) => { await p.click('#m2m-convert'); await waitIdle(p); };
  const add = async (names, p = page) => { await p.setInputFiles('#m2m-file', names.map(n => n.includes('/') ? n : F(n))); await waitRead(p); };
  const clear = async (p = page) => { if (await p.isVisible('#m2m-clear')) await p.click('#m2m-clear'); else if (await p.locator('.m2m-remove').count()) await p.locator('.m2m-remove').first().click(); };
  const edit = async (name, p = page) => { if (await row(name, p).locator('.m2m-edit').isVisible()) await row(name, p).locator('.m2m-edit').click(); };
  const typeInto = async (sel, value, p = page) => {
    await p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  const live = (p = page) => p.evaluate(() => window.__live.slice());
  // The site scrolls smoothly: a tap is aimed once the page has stopped moving.
  const settle = (p = page) => p.evaluate(() => new Promise(resolve => {
    let last = NaN, same = 0;
    const tick = () => { if (scrollY === last) { if (++same > 4) return resolve(); } else { same = 0; last = scrollY; } requestAnimationFrame(tick); };
    tick();
  }));
  const tap = async (sel, p) => { await p.locator(sel).scrollIntoViewIfNeeded(); await settle(p); await p.tap(sel); };
  const unfold = async (id, p = page) => { if (!(await p.evaluate(i => document.getElementById(i).open, id))) await p.click(`#${id} summary`); };
  const fmtBytes = n => n < 1000 ? n + ' bytes' : n < 1e6 ? (n / 1000).toFixed(n < 1e4 ? 1 : 0) + ' KB' : n < 1e9 ? (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB' : (n / 1e9).toFixed(2) + ' GB';
  const times = (from, to) => { const q = to / from; return q >= 2 ? `${Math.floor(q * 10) / 10} times the size` : `${Math.round((q - 1) * 100)}% bigger`; };
  const pad = (n, w) => String(n).padStart(w, '0');
  const fmtTime = ms => {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, tail = pad(Math.floor(ms / 1000) % 60, 2) + '.' + pad(ms % 1000, 3);
    return h ? `${h}:${pad(mi, 2)}:${tail}` : `${mi}:${tail}`;
  };
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
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
  // G.711 as ITU-T's reference code decodes it (16-bit values over 32768).
  const ulaw = u => { u = ~u & 0xff; let t = ((u & 15) << 3) + 0x84; t <<= (u & 0x70) >> 4; return ((u & 0x80) ? 0x84 - t : t - 0x84) / 32768; };
  const alaw = a => { a ^= 0x55; let t = (a & 15) << 4; const seg = (a & 0x70) >> 4; t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1); return ((a & 0x80) ? t : -t) / 32768; };

  // A WAV or RF64 file: its chunks in order, the format, RIFF INFO, the id3
  // chunk, and each channel's samples as numbers of full scale 1.
  function parseWav(buf) {
    const id = buf.toString('latin1', 0, 4);
    assert.ok(id === 'RIFF' || id === 'RF64', `a RIFF or RF64 file, not ${JSON.stringify(id)}`);
    assert.equal(buf.toString('latin1', 8, 12), 'WAVE');
    const w = { id, riffSize: buf.readUInt32LE(4), chunks: [], info: {}, id3: null };
    let q = 12, ds64 = null;
    while (q + 8 <= buf.length) {
      const cid = buf.toString('latin1', q, q + 4);
      let size = buf.readUInt32LE(q + 4);
      if (cid === 'data' && ds64) size = ds64.data;
      w.chunks.push(cid);
      const body = buf.subarray(q + 8, q + 8 + size);
      if (cid === 'ds64') ds64 = { riff: Number(body.readBigUInt64LE(0)), data: Number(body.readBigUInt64LE(8)), frames: Number(body.readBigUInt64LE(16)) };
      if (cid === 'fmt ') Object.assign(w, { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), byteRate: body.readUInt32LE(8), block: body.readUInt16LE(12), bits: body.readUInt16LE(14), fmtSize: size });
      if (cid === 'fact') w.fact = body.readUInt32LE(0);
      if (cid === 'data') { w.dataPos = q + 8; w.dataSize = size; }
      if (cid === 'id3 ') w.id3 = body;
      if (cid === 'LIST' && body.toString('latin1', 0, 4) === 'INFO') {
        for (let p = 4; p + 8 <= body.length;) {
          const k = body.toString('latin1', p, p + 4), n = body.readUInt32LE(p + 4);
          w.info[k] = body.toString('utf8', p + 8, p + 8 + n).replace(/\0+$/, '');
          p += 8 + n + (n & 1);
        }
      }
      q += 8 + size + (size & 1);
    }
    assert.equal(q, buf.length, 'the chunks fill the file exactly');
    if (id === 'RF64') Object.assign(w, { ds64 });
    else assert.equal(w.riffSize, buf.length - 8, 'the RIFF size is the file size less 8');
    assert.equal(w.byteRate, w.sampleRate * w.block, 'byte rate = rate × block');
    assert.equal(w.block, w.channels * w.bits / 8, 'block = channels × bytes a sample');
    const n = w.frames = w.dataSize / w.block;
    assert.equal(n, Math.floor(n), 'whole frames of sound');
    const ch = [];
    for (let c = 0; c < w.channels; c++) ch.push(new Float64Array(n));
    const d = buf.subarray(w.dataPos, w.dataPos + w.dataSize);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < w.channels; c++) {
        const o = i * w.block + c * w.bits / 8;
        ch[c][i] = w.tag === 3 ? d.readFloatLE(o) : w.tag === 7 ? ulaw(d[o]) : w.tag === 6 ? alaw(d[o])
          : w.bits === 16 ? d.readInt16LE(o) / 32768 : w.bits === 24 ? d.readIntLE(o, 3) / 8388608 : NaN;
      }
    }
    w.ch = ch;
    return w;
  }
  // ID3v2.3: text frames (ISO-8859-1 or UTF-16 with a BOM), COMM, USLT and APIC.
  const synch = b => ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f);
  const id3Text = (b, enc) => {
    if (enc === 0) return b.toString('latin1').replace(/\0+$/, '');
    assert.equal(enc, 1, `text encoding ${enc} in ID3v2.3`);
    if (!b.length) return '';
    assert.ok(b[0] === 0xff && b[1] === 0xfe, 'UTF-16 text starts with a byte order mark');
    return Buffer.from(b.subarray(2)).toString('utf16le').replace(/\0+$/, '');
  };
  const split = (b, enc) => {
    if (enc !== 1) { const i = b.indexOf(0); return [b.subarray(0, i), b.subarray(i + 1)]; }
    for (let i = 0; i + 1 < b.length; i += 2) if (!b[i] && !b[i + 1]) return [b.subarray(0, i), b.subarray(i + 2)];
    return [b, Buffer.alloc(0)];
  };
  function parseId3(buf) {
    assert.equal(buf.toString('latin1', 0, 3), 'ID3');
    const out = { version: buf[3], frames: {} };
    const size = synch(buf.subarray(6, 10));
    for (let q = 10; q + 10 <= 10 + size;) {
      const id = buf.toString('latin1', q, q + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = buf.readUInt32BE(q + 4), body = buf.subarray(q + 10, q + 10 + len);
      if (id[0] === 'T') out.frames[id] = id3Text(body.subarray(1), body[0]);
      else if (id === 'COMM' || id === 'USLT') out.frames[id] = id3Text(split(body.subarray(4), body[0])[1], body[0]);
      else if (id === 'APIC') {
        const mimeEnd = body.indexOf(0, 1), mime = body.toString('latin1', 1, mimeEnd), rest = body.subarray(mimeEnd + 2);
        out.frames.APIC = { mime, type: body[mimeEnd + 1], data: split(rest, body[0])[1] };
      }
      q += 10 + len;
    }
    return out;
  }
  // Where the left channel lines up with the chirp the MP3s were made of.
  const chirpL = i => 0.5 * Math.sin(2 * Math.PI * (200 * i / 44100 + 300 * (i / 44100) ** 2));
  // off: where x starts in the chirp (a part cut from it).
  const lagOf = (x, from, len, range, off = 0) => {
    let best = 0, bestDot = -Infinity;
    for (let lag = -range; lag <= range; lag++) {
      let d = 0;
      for (let i = from; i < from + len; i += 2) d += x[i + lag] * chirpL(i + off);
      if (d > bestDot) { bestDot = d; best = lag; }
    }
    return best;
  };
  // The browser's own decoding of a file, at the file's rate (decodeAudioData honours the LAME tag).
  const browserDecode = (name, sr, p = page) => p.evaluate(async ([b64, sr]) => {
    const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ab = await new OfflineAudioContext(1, 1, sr).decodeAudioData(u8.buffer);
    const ch = [];
    for (let c = 0; c < ab.numberOfChannels; c++) ch.push(Array.from(ab.getChannelData(c)));
    return { len: ab.length, ch };
  }, [fs.readFileSync(F(name)).toString('base64'), sr]);
  const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const thread = async () => (await cdp.send('Performance.getMetrics')).metrics.find(x => x.name === 'ThreadTime').value * 1000;
  const MEM = ' Each WAV is built in memory, up to 2 GB on this device, and one of 200 MB or more is written straight to a file you choose.';
  const BIGGER = ' A higher bit depth or rate makes a bigger file but cannot add detail that the original does not have.';
  const GAPLESS = 'Gapless: the encoder’s delay and padding, which its LAME tag gives, are left out, so nothing is added before or after the sound.';
  const LEADIN = 'No LAME tag gives the encoder’s delay, so about 25 ms of silence (1,105 samples) stays at the start.';

  // ---------- The page as it opens: WAV only, with its own presets and options ----------
  assert.equal(await text('h1'), 'MP3 to WAV Converter for CDs and Editors');
  assert.equal(await text('.m2m-drop-title'), 'Drop MP3 files here');
  assert.equal(await text('#m2m-drop-hint'), 'MP3 files of any length, as many as you like; M4A, FLAC, OGG and the sound of videos work too. Nothing is uploaded.');
  assert.equal(await page.locator('input[name="m2m-format"]').count(), 1, 'WAV is the one format');
  assert.equal(await page.isVisible('input[name="m2m-format"]'), false, 'so no Format choice is shown');
  assert.deepEqual(await page.$$eval('#m2m-presets button:not([hidden])', bs => bs.map(b => b.textContent)),
    ['CD: 44.1 kHz 16-bit stereo', 'Video: 48 kHz 24-bit', 'Phone: 8 kHz 16-bit mono', 'Phone: 8 kHz µ-law mono']);
  assert.equal(await page.locator('#m2m-presets').getAttribute('aria-labelledby').then(id => text('#' + id)), 'Presets');
  assert.deepEqual(await page.$$eval('#m2m-bits option', o => o.map(x => [x.value, x.textContent])),
    [['s16', '16-bit'], ['s24', '24-bit'], ['f32', '32-bit float'], ['ulaw', '8-bit µ-law'], ['alaw', '8-bit A-law']]);
  assert.deepEqual(await page.$$eval('#m2m-rate option', o => o.map(x => x.textContent)), ['As in the file', '44.1 kHz', '48 kHz', '22.05 kHz', '16 kHz', '8 kHz']);
  assert.deepEqual(await page.$$eval('#m2m-channels option', o => o.map(x => x.textContent)), ['As in the file', 'Stereo', 'Mono']);
  assert.deepEqual([await page.inputValue('#m2m-bits'), await page.inputValue('#m2m-rate'), await page.inputValue('#m2m-channels')], ['s16', '0', 'keep']);
  assert.equal(await page.isVisible('#m2m-bitrate'), false, 'no MP3 bitrate on a WAV page');
  assert.equal(await page.locator('#m2m-speech').count(), 0);
  const HINT16 = 'WAV, 16-bit PCM, as on a CD, which every player, editor and burning program reads. A minute of stereo at 44.1 kHz takes 10.6 MB.' + BIGGER + MEM;
  assert.equal(await text('#m2m-format-hint'), HINT16);
  assert.equal(await page.isChecked('#m2m-notags'), false);
  assert.equal(await text('#m2m-notags-hint'), 'For samplers and other devices that refuse files holding anything but the sound: no title, artist or cover art is written.');
  assert.deepEqual([await text('#m2m-convert'), await page.isDisabled('#m2m-convert')], ['Convert to WAV', true]);
  assert.equal(await page.evaluate(() => typeof window.Mediabunny), 'undefined', 'the converter library is not loaded before a file is added');

  // ---------- Presets and the options they set ----------
  await page.click('#m2m-p-video');
  assert.deepEqual([await page.inputValue('#m2m-bits'), await page.inputValue('#m2m-rate'), await page.inputValue('#m2m-channels')], ['s24', '48000', 'keep']);
  assert.equal(await text('#m2m-status'), 'Video settings: WAV at 48 kHz, 24-bit, channels as in the file.');
  assert.equal(await text('#m2m-format-hint'), 'WAV, 24-bit PCM, which video editors and recording programs work in. A minute of stereo at 48 kHz takes 17.3 MB.' + BIGGER + MEM);
  await page.click('#m2m-p-phone-ulaw');
  assert.deepEqual([await page.inputValue('#m2m-bits'), await page.inputValue('#m2m-rate'), await page.inputValue('#m2m-channels')], ['ulaw', '8000', 'mono']);
  assert.equal(await text('#m2m-status'), 'Phone settings: WAV at 8 kHz, 8-bit µ-law, mono.');
  assert.equal(await text('#m2m-format-hint'), 'WAV, 8-bit µ-law, the G.711 of phone systems in North America and Japan, at telephone quality. A minute of mono at 8 kHz takes 0.48 MB.' + BIGGER + MEM);
  await page.click('#m2m-p-phone16');
  assert.equal(await text('#m2m-status'), 'Phone settings: WAV at 8 kHz, 16-bit, mono.');
  await page.selectOption('#m2m-bits', 'alaw');
  assert.equal(await text('#m2m-format-hint'), 'WAV, 8-bit A-law, the G.711 of phone systems in Europe and most other countries, at telephone quality. A minute of mono at 8 kHz takes 0.48 MB.' + BIGGER + MEM);
  await page.selectOption('#m2m-bits', 'f32');
  await page.selectOption('#m2m-rate', '22050');
  await page.selectOption('#m2m-channels', 'stereo');
  assert.equal(await text('#m2m-format-hint'), 'WAV, 32-bit float, which audio editors work in. A minute of stereo at 22.05 kHz takes 10.6 MB.' + BIGGER + MEM);
  await page.click('#m2m-p-cd');
  assert.deepEqual([await page.inputValue('#m2m-bits'), await page.inputValue('#m2m-rate'), await page.inputValue('#m2m-channels')], ['s16', '44100', 'stereo']);
  assert.equal(await text('#m2m-status'), 'CD settings: WAV at 44.1 kHz, 16-bit, stereo.');
  // Back to the page's own defaults.
  await page.selectOption('#m2m-rate', '0');
  await page.selectOption('#m2m-channels', 'keep');
  assert.equal(await text('#m2m-format-hint'), HINT16);

  // ---------- A tagged MP3 with a LAME tag: exactly the samples encoded, every tag kept ----------
  await add(['song.mp3']);
  let c = await card('song.mp3');
  assert.deepEqual(c, { info: '0:03.000 · MP3 · 44.1 kHz · stereo · 128 kbps', note: GAPLESS, state: 'Ready', msg: '', download: false });
  assert.equal(await text('#m2m-status'), 'Added song.mp3: 0:03.000, MP3 stereo. ' + GAPLESS);
  const songBytes = exp['song.mp3'].bytes;
  assert.equal(await page.inputValue('#m2m-title'), exp.tags.title, 'the title is read from the ID3v2.3 tag');
  assert.equal(await page.inputValue('#m2m-artist'), exp.tags.artist);
  assert.equal(await page.inputValue('#m2m-album'), exp.tags.album);
  await unfold('m2m-tags');
  assert.equal(await text('#m2m-more-list'), 'date “2019”, genre “Live”, track 3 of 12, disc 1 of 2, album artist “Various Artists”, composer “Åsa Composer”, comment “Recorded live second line”, lyrics');
  const est = await text('#m2m-estimate');
  const estBytes = await page.evaluate(() => {
    const m = document.getElementById('m2m-estimate').textContent.match(/about ([\d.]+) (KB|MB)/);
    return m ? +m[1] * (m[2] === 'KB' ? 1e3 : 1e6) : 0;
  });
  assert.match(est, /^Estimated size: about [\d.]+ KB as song\.wav, [\d.]+ times the size of the MP3\.$/);
  await convert();
  let song = await dl('song.mp3');
  assert.equal(song.name, 'song.wav');
  dump('song.wav', song.bytes);
  near(song.bytes.length, estBytes, song.bytes.length * 0.01, 'the size estimate counts the tags and cover too');
  c = await card('song.mp3');
  assert.equal(c.state, `Converted: song.wav. ${fmtBytes(songBytes)} MP3 → ${fmtBytes(song.bytes.length)} WAV, ${times(songBytes, song.bytes.length)}.`);
  assert.equal(await text('#m2m-status'), `song.wav is ready to download: ${fmtBytes(songBytes)} MP3 → ${fmtBytes(song.bytes.length)} WAV, ${times(songBytes, song.bytes.length)}.`);
  let w = parseWav(song.bytes);
  assert.deepEqual([w.id, w.tag, w.bits, w.channels, w.sampleRate, w.fmtSize], ['RIFF', 1, 16, 2, 44100, 16], 'plain 16-bit PCM, stereo, 44.1 kHz');
  assert.deepEqual(w.chunks, ['fmt ', 'LIST', 'data', 'id3 '], 'RIFF INFO before the sound, the ID3 tag after it');
  assert.equal(w.frames, exp['song.mp3'].samples, `exactly the ${exp['song.mp3'].samples} samples encoded, as ffmpeg decodes them`);
  assert.equal(lagOf(w.ch[0], 20000, 20000, 1200), 0, 'lined up with the chirp to the sample: no lead-in');
  near(rms(w.ch[0]), exp['song.mp3'].rms[0], 0.002, 'left level as ffmpeg decodes it');
  near(rms(w.ch[1]), exp['song.mp3'].rms[1], 0.002, 'right level as ffmpeg decodes it');
  // The browser's own decoder (decodeAudioData, not the page's WebCodecs
  // pipeline) gives the same sound. Sound that goes to 16 bits unchanged is
  // converted by the decoder's own 16-bit output (AudioData.copyTo), which
  // rounds down and scales positive values by 32,767: within 1.5 steps.
  const STEP = 1.5 / 32768;
  let ref = await browserDecode('song.mp3', 44100);
  assert.equal(ref.len, w.frames, 'decodeAudioData gives as many samples');
  assert.ok(maxDiff(w.ch[0], ref.ch[0]) <= STEP && maxDiff(w.ch[1], ref.ch[1]) <= STEP, 'the same samples, to the rounding of 16 bits');
  assert.deepEqual(w.info, { INAM: exp.tags.title, IART: exp.tags.artist, IPRD: exp.tags.album, IMUS: exp.tags.composer, IGNR: exp.tags.genre,
    ICRD: '2019', ITRK: '3', ICMT: exp.tags.comment }, 'RIFF INFO in UTF-8');
  let id3 = parseId3(w.id3);
  assert.equal(id3.version, 3, 'an ID3v2.3 chunk');
  assert.deepEqual([id3.frames.TIT2, id3.frames.TPE1, id3.frames.TALB, id3.frames.TPE2, id3.frames.TCOM, id3.frames.TCON, id3.frames.TYER, id3.frames.TRCK, id3.frames.TPOS, id3.frames.COMM, id3.frames.USLT],
    [exp.tags.title, exp.tags.artist, exp.tags.album, exp.tags.albumartist, exp.tags.composer, exp.tags.genre, '2019', '3/12', '1/2', exp.tags.comment, exp.tags.lyrics]);
  assert.deepEqual([id3.frames.APIC.mime, id3.frames.APIC.type, sha(id3.frames.APIC.data)], ['image/jpeg', 3, exp.coverSha256], 'the front cover, byte for byte');
  const song16 = w;

  // ---------- 24-bit, 32-bit float, µ-law and A-law ----------
  const bitsOf = async (bits, sel = '#m2m-bits') => {
    await page.selectOption(sel, bits);
    assert.equal((await card('song.mp3')).download, false, 'a new setting drops the result made before it');
    await convert();
    const d = await dl('song.mp3');
    dump(`song-${bits}.wav`, d.bytes);
    return parseWav(d.bytes);
  };
  w = await bitsOf('s24');
  assert.deepEqual([w.tag, w.bits, w.block, w.frames], [1, 24, 6, 132300], '24-bit PCM');
  assert.ok(maxDiff(w.ch[0], song16.ch[0]) <= STEP, '24-bit holds the same sound, unrounded');
  assert.ok(maxDiff(w.ch[0], ref.ch[0]) <= 0.51 / 8388608, 'the decoder\'s output to the nearest 24-bit step');
  assert.ok(w.ch[0].some(v => Math.abs(v * 32768 - Math.round(v * 32768)) > 0.01), 'and more than 16 bits of it');
  w = await bitsOf('f32');
  assert.deepEqual([w.tag, w.bits, w.fmtSize, w.fact, w.frames], [3, 32, 18, 132300, 132300], '32-bit float with a fact chunk');
  assert.deepEqual(w.chunks, ['fmt ', 'fact', 'LIST', 'data', 'id3 ']);
  assert.equal(maxDiff(w.ch[1], ref.ch[1]), 0, 'float holds the decoder\'s output exactly');
  for (const [bits, tag] of [['ulaw', 7], ['alaw', 6]]) {
    w = await bitsOf(bits);
    assert.deepEqual([w.tag, w.bits, w.block, w.fact, w.frames], [tag, 8, 2, 132300, 132300], `${bits}: G.711, 8 bits, a fact chunk`);
    // G.711 keeps about 38 dB of signal to noise: decoded by the reference tables, close to the 16-bit sound.
    const err = rms(w.ch[0].map((v, i) => v - song16.ch[0][i]));
    assert.ok(err < rms(song16.ch[0]) * 0.03 && err > 0, `${bits}: decodes to the same sound within G.711's error (${(20 * Math.log10(err / rms(song16.ch[0]))).toFixed(1)} dB)`);
  }
  await page.selectOption('#m2m-bits', 's16');

  // ---------- Rates and channels: resampled with the engine's filter ----------
  await page.click('#m2m-p-video');
  assert.match(await text('#m2m-estimate'), / times the size of the MP3\. Its sound is resampled from 44\.1 kHz to 48 kHz\.$/);
  await convert();
  w = parseWav((await dl('song.mp3')).bytes);
  assert.deepEqual([w.tag, w.bits, w.channels, w.sampleRate, w.frames], [1, 24, 2, 48000, 144000], '48 kHz 24-bit: 3 s is 144,000 samples');
  near(rms(w.ch[0]), exp['song.mp3'].rms[0], 0.002, 'the chirp keeps its level at 48 kHz');
  await page.click('#m2m-p-phone16');
  await convert();
  w = parseWav((await dl('song.mp3')).bytes);
  assert.deepEqual([w.tag, w.bits, w.channels, w.sampleRate, w.frames], [1, 16, 1, 8000, 24000], 'phone: 8 kHz mono 16-bit');
  await page.click('#m2m-p-phone-ulaw');
  await convert();
  const phoneU = await dl('song.mp3');
  dump('song-phone-ulaw.wav', phoneU.bytes);
  w = parseWav(phoneU.bytes);
  assert.deepEqual([w.tag, w.bits, w.channels, w.sampleRate, w.frames], [7, 8, 1, 8000, 24000], 'phone: 8 kHz mono µ-law');
  await page.selectOption('#m2m-bits', 's16');
  await page.selectOption('#m2m-rate', '16000');
  await page.selectOption('#m2m-channels', 'mono');
  await convert();
  w = parseWav((await dl('song.mp3')).bytes);
  assert.deepEqual([w.channels, w.sampleRate, w.frames], [1, 16000, 48000], '16 kHz mono');
  await page.selectOption('#m2m-rate', '0');
  await convert();
  w = parseWav((await dl('song.mp3')).bytes);
  const mix = song16.ch[0].map((v, i) => (v + song16.ch[1][i]) / 2);
  assert.ok(maxDiff(w.ch[0], ref.ch[0].map((v, i) => (v + ref.ch[1][i]) / 2)) <= 0.51 / 32768, 'Mono is the average of left and right, rounded');
  assert.ok(maxDiff(w.ch[0], mix) <= 2 / 32768);
  await page.selectOption('#m2m-channels', 'keep');
  await clear();

  // 48 kHz to 44.1 kHz, the CD preset: an exact length, 1 kHz and 12 kHz kept at their levels.
  await add(['hz48.mp3', 'mono.mp3']);
  await page.click('#m2m-p-cd');
  await edit('hz48.mp3');
  assert.match(await text('#m2m-estimate'), / Its sound is resampled from 48 kHz to 44\.1 kHz\.$/);
  await convert();
  w = parseWav((await dl('hz48.mp3')).bytes);
  assert.deepEqual([w.channels, w.sampleRate, w.frames], [2, 44100, Math.round(exp['hz48.mp3'].samples * 147 / 160)], '96,000 samples at 48 kHz are 88,200 at 44.1 kHz');
  near(hz(w.ch[0], 44100), 1000, 1, 'the 1 kHz tone stays at 1 kHz');
  near(toneDb(w.ch[1], 44100, 12000), 20 * Math.log10(exp['hz48.mp3'].rms[1] * Math.SQRT2), 0.3, 'the 12 kHz tone keeps its level (ffmpeg\'s decoding at 48 kHz)');
  // A mono MP3 written as stereo for the CD preset: the same sound on both sides.
  w = parseWav((await dl('mono.mp3')).bytes);
  assert.deepEqual([w.channels, w.sampleRate, w.frames], [2, 44100, exp['mono.mp3'].samples], 'Stereo from a mono MP3');
  assert.equal(maxDiff(w.ch[0], w.ch[1]), 0, 'both channels the same');
  near(hz(w.ch[0], 44100), 440, 1, 'the 440 Hz tone');
  await page.selectOption('#m2m-rate', '0');
  await page.selectOption('#m2m-channels', 'keep');
  await clear();

  // ---------- Save without tags: a bare 44-byte header ----------
  await add(['song.mp3']);
  await unfold('m2m-tags');
  await page.check('#m2m-notags');
  assert.equal(await page.isVisible('#m2m-notags-note'), true);
  assert.equal(await text('#m2m-notags-note'), '“Save without tags” is ticked under Output, so none of these is written.');
  assert.deepEqual(await page.$$eval('#m2m-title, #m2m-artist, #m2m-album, #m2m-cover, #m2m-more', f => f.map(x => x.disabled)), [true, true, true, true, true], 'the Tags fields are off');
  await convert();
  const bare = await dl('song.mp3');
  dump('song-notags.wav', bare.bytes);
  w = parseWav(bare.bytes);
  assert.deepEqual(w.chunks, ['fmt ', 'data'], 'only the format and the sound');
  assert.equal(w.dataPos, 44, 'the classic 44-byte header');
  assert.equal(bare.bytes.length, 44 + 132300 * 4);
  assert.ok(bare.bytes.subarray(44).equals(song.bytes.subarray(song16.dataPos, song16.dataPos + song16.dataSize)), 'the same sound as with tags');
  await page.uncheck('#m2m-notags');
  assert.deepEqual(await page.$$eval('#m2m-title, #m2m-artist, #m2m-album', f => f.map(x => x.disabled)), [false, false, false]);
  assert.equal(await page.isVisible('#m2m-notags-note'), false);
  // Tags typed over: written as typed (the field cut at 200 characters).
  await typeInto('#m2m-title', 'Typed – ' + 'x'.repeat(400));
  await page.uncheck('#m2m-cover');
  await page.uncheck('#m2m-more');
  await convert();
  w = parseWav((await dl('song.mp3')).bytes);
  assert.equal(w.info.INAM, ('Typed – ' + 'x'.repeat(400)).slice(0, 200), 'the title as typed, at most 200 characters');
  assert.deepEqual(Object.keys(w.info).sort(), ['IART', 'INAM', 'IPRD'], 'the other tags left out when unticked');
  assert.equal(parseId3(w.id3).frames.APIC, undefined, 'and the cover');
  await clear();

  // ---------- Exact lengths: MPEG-2, MPEG-2.5, VBR; the lead-in kept without a LAME tag ----------
  await add(['vbr.mp3', 'mpeg2.mp3', 'mpeg25.mp3', 'no-tag.mp3', 'vbri.mp3', 'cut-off.mp3', 'junk.mp3']);
  for (const [name, info, note] of [['vbr.mp3', '0:03.000 · MP3 · 44.1 kHz · stereo · 138 kbps', GAPLESS], ['mpeg2.mp3', '0:02.000 · MP3 · 22.05 kHz · mono · 64 kbps', GAPLESS],
    ['mpeg25.mp3', '0:02.000 · MP3 · 8 kHz · mono · 24 kbps', GAPLESS], ['no-tag.mp3', '0:03.030 · MP3 · 44.1 kHz · stereo · 128 kbps', LEADIN],
    ['vbri.mp3', '0:03.030 · MP3 · 44.1 kHz · stereo · 138 kbps', LEADIN], ['junk.mp3', '0:01.045 · MP3 · 44.1 kHz · stereo · 128 kbps', LEADIN]]) {
    c = await card(name);
    assert.deepEqual([c.info, c.note, c.msg], [info, note, ''], name);
  }
  c = await card('cut-off.mp3');
  assert.deepEqual([c.info, c.note], ['0:01.177 · MP3 · 44.1 kHz · stereo · 128 kbps', GAPLESS]);
  assert.equal(c.msg, 'This MP3 is incomplete, perhaps a download that did not finish: its header says it holds 0:03.000 of sound, but its frames stop at 0:01.177. That part can still be converted.');
  assert.equal(await text('#m2m-status'), 'Added 7 files, 1 of them has a warning: see the message under each.');
  await convert();
  for (const [name, lag] of [['vbr.mp3', null], ['mpeg2.mp3', null], ['mpeg25.mp3', null], ['no-tag.mp3', 1105], ['vbri.mp3', null], ['cut-off.mp3', 0]]) {
    const d = await dl(name);
    dump(name.replace('.mp3', '.wav'), d.bytes);
    w = parseWav(d.bytes);
    assert.equal(w.frames, exp[name].samples, `${name}: ${exp[name].samples} samples, as ffmpeg decodes it`);
    assert.equal(w.sampleRate, exp[name].sr);
    if (lag !== null) assert.equal(lagOf(w.ch[0], 20000, 20000, 1200), lag, `${name} lines up with the chirp ${lag ? lag + ' samples late' : 'to the sample'}`);
  }
  // Junk in the middle: read past, the sound kept to within one frame of ffmpeg's.
  w = parseWav((await dl('junk.mp3')).bytes);
  near(w.frames, exp['junk.mp3'].samples, 1152, 'junk.mp3');
  assert.equal(lagOf(w.ch[0], 4000, 6000, 1200), 1105, 'junk.mp3 starts as an MP3 without a LAME tag does');
  await clear();

  // ---------- A loud MP3 as float: the decoder stops at full scale ----------
  // ffmpeg decodes peaks above full scale from this file (exp: over > 0);
  // the browser's MP3 decoder clips them at 1.0, so float cannot bring them back.
  assert.ok(exp['loud.mp3'].peak[0] > 1.1 && exp['loud.mp3'].over > 1000, 'ffmpeg finds peaks over full scale');
  await add(['loud.mp3']);
  await page.selectOption('#m2m-bits', 'f32');
  await convert();
  w = parseWav((await dl('loud.mp3')).bytes);
  assert.equal(w.tag, 3);
  assert.equal(peakOf(w.ch[0]), 1, 'the float WAV peaks at exactly full scale');
  assert.ok(w.ch[0].filter(v => Math.abs(v) >= 0.9999).length > 100, 'where many samples were over it');
  await page.selectOption('#m2m-bits', 's16');
  await clear();

  // ---------- Tags in every ID3 version, ID3v1 only, APE only ----------
  await add(['tags-v22.mp3', 'tags-v24.mp3', 'v1only.mp3', 'ape.mp3']);
  await convert();
  w = parseWav((await dl('tags-v22.mp3')).bytes);
  assert.deepEqual([w.info.INAM, w.info.IART, w.info.IPRD, w.info.ICRD, w.info.ITRK, w.info.IGNR], [exp.v22.TT2, exp.v22.TP1, exp.v22.TAL, '1999', '5', 'Rock'], 'ID3v2.2');
  w = parseWav((await dl('tags-v24.mp3')).bytes);
  id3 = parseId3(w.id3);
  assert.deepEqual([w.info.INAM, id3.frames.TPE2, id3.frames.TCOM, id3.frames.TYER, id3.frames.TDAT, id3.frames.TRCK, id3.frames.TPOS],
    [exp.v24.title, exp.v24.albumartist, exp.v24.composer, '2021', '1506', '7', '2/3'], 'ID3v2.4 in UTF-8, its date as TYER and TDAT');
  assert.deepEqual([id3.frames.APIC.mime, sha(id3.frames.APIC.data)], ['image/png', exp.pngSha256], 'a PNG cover, byte for byte');
  w = parseWav((await dl('v1only.mp3')).bytes);
  assert.deepEqual([w.info.INAM, w.info.IART, w.info.IPRD, w.info.ICRD, w.info.ITRK], [exp.v1.title, exp.v1.artist, exp.v1.album, exp.v1.year, '4'], 'ID3v1');
  const apeWav = await dl('ape.mp3');
  w = parseWav(apeWav.bytes);
  assert.deepEqual(w.info, { INAM: 'ape' }, 'an APE tag is not read: the title is the file name');
  // Several results: the sizes added up, and a ZIP of the WAVs as they are.
  const totals = await text('#m2m-total');
  assert.match(totals, /^All 4 files: [\d.]+ KB MP3 → [\d.]+ KB WAV, [\d.]+ times the size\.$/);
  const zip = await download(() => page.click('#m2m-zip'));
  assert.equal(zip.name, 'converted-audio.zip');
  const entries = [];
  for (let q = 0; zip.bytes.readUInt32LE(q) === 0x04034b50;) {
    const n = zip.bytes.readUInt16LE(q + 26), x = zip.bytes.readUInt16LE(q + 28), size = zip.bytes.readUInt32LE(q + 18);
    assert.equal(zip.bytes.readUInt16LE(q + 8), 0, 'stored, not compressed again');
    entries.push({ name: zip.bytes.toString('utf8', q + 30, q + 30 + n), data: zip.bytes.subarray(q + 30 + n + x, q + 30 + n + x + size) });
    q += 30 + n + x + size;
  }
  assert.deepEqual(entries.map(e => e.name), ['tags-v22.wav', 'tags-v24.wav', 'v1only.wav', 'ape.wav']);
  assert.ok(entries[3].data.equals(apeWav.bytes), 'the ZIP holds the WAVs byte for byte');
  await clear();

  // ---------- Files that cannot be converted, and the neighbours people drop anyway ----------
  await add(['not-audio.mp3', 'empty.mp3', 'free.mp3', 'silent.mp4', HUB('fairplay.m4a'), HUB('audible.m4b'), 'really-wav.mp3', 'take.wav', 'voice.m4a', 'alac.m4a', 'hires.flac', 'surround.flac', 'voice.ogg', 'clip.mp4']);
  const refused = {
    'not-audio.mp3': 'This is not an audio file that this page can read. It reads M4A, MP3, WAV, FLAC, OGG and AAC files, and the sound of MP4, MOV, WebM, MKV and MPEG-TS videos.',
    'empty.mp3': 'This file is empty.',
    'free.mp3': 'This MP3 is in free format (its frames state no bitrate), which browsers cannot decode.',
    'silent.mp4': 'This video has no sound track, so there is no audio to save.',
    'fairplay.m4a': 'This file is copy-protected (Apple FairPlay DRM), so it cannot be converted. Apple Music downloads are protected this way, and so are iTunes Store songs bought before April 2009 and never upgraded to iTunes Plus.',
    'audible.m4b': 'This file is copy-protected (Audible DRM), so it cannot be converted. Audible audiobooks (.aa and .aax files) are protected this way.'
  };
  for (const [name, msg] of Object.entries(refused)) assert.equal((await card(name)).msg, msg, name);
  assert.equal(await text('#m2m-status'), 'Added 14 files, 6 of them cannot be converted to WAV: see the message under each.');
  assert.equal(await text('#m2m-convert'), 'Convert 8 files to WAV');
  for (const [name, info] of [['really-wav.mp3', '0:00.500 · PCM · 16 kHz · mono'], ['take.wav', '0:00.500 · PCM · 44.1 kHz · stereo'], ['voice.m4a', '0:00.500 · AAC · 44.1 kHz · mono · 66 kbps'],
    ['alac.m4a', '0:00.500 · Apple Lossless (ALAC) · 44.1 kHz · stereo · 16-bit'], ['hires.flac', '0:00.500 · FLAC · 96 kHz · stereo'],
    ['surround.flac', '0:00.250 · FLAC · 48 kHz · 5.1 surround'], ['voice.ogg', '0:00.500 · Opus · 48 kHz · mono'], ['clip.mp4', '0:00.500 · AAC · 44.1 kHz · mono']]) {
    assert.ok((await card(name)).info.startsWith(info), `${name}: ${(await card(name)).info}`);
  }
  await convert();
  for (const [name, ch, sr, frames, tone] of [['really-wav.mp3', 1, 16000, 8000, 500], ['take.wav', 2, 44100, 22050, 440], ['voice.m4a', 1, 44100, null, 300], ['alac.m4a', 2, 44100, 22050, 300],
    ['hires.flac', 2, 96000, 48000, 1000], ['surround.flac', 2, 48000, 12000, null], ['voice.ogg', 1, 48000, 24000, 800], ['clip.mp4', 1, 44100, null, 500]]) {
    const d = await dl(name);
    // Two files named voice: the second WAV gets a name of its own.
    assert.equal(d.name, name === 'voice.ogg' ? 'voice (2).wav' : name.replace(/\.[^.]+$/, '') + '.wav');
    w = parseWav(d.bytes);
    assert.deepEqual([w.channels, w.sampleRate], [ch, sr], name);
    if (frames) assert.equal(w.frames, frames, `${name}: ${frames} samples`);
    if (tone) near(hz(w.ch[0], sr), tone, tone * 0.01, `${name}: its ${tone} Hz tone`);
  }
  // 96 kHz 24-bit FLAC at the Video preset: 48 kHz, and 30 kHz filtered out rather than folded back to 18 kHz.
  await page.click('#m2m-p-video');
  await convert();
  w = parseWav((await dl('hires.flac')).bytes);
  assert.deepEqual([w.bits, w.sampleRate, w.frames], [24, 48000, 24000]);
  near(toneDb(w.ch[0], 48000, 1000), 20 * Math.log10(0.5), 0.1, 'hires.flac: 1 kHz kept');
  assert.ok(toneDb(w.ch[1], 48000, 18000) < -90, `hires.flac: 30 kHz does not fold back to 18 kHz (${toneDb(w.ch[1], 48000, 18000).toFixed(1)} dB)`);
  await page.selectOption('#m2m-bits', 's16');
  await page.selectOption('#m2m-rate', '0');
  await clear();

  // ---------- Trim fields: decimal commas, errors pointed at by the field ----------
  await add(['song.mp3']);
  await unfold('m2m-trim');
  await typeInto('#m2m-start', '0,5');
  await typeInto('#m2m-end', '2.5');
  assert.equal(await text('#m2m-len'), '0:02.000');
  await typeInto('#m2m-end', '1:75');
  assert.equal(await text('#m2m-time-error'), 'Minutes and seconds go up to 59: write 1:15 rather than 0:75.');
  assert.equal(await page.getAttribute('#m2m-end', 'aria-invalid'), 'true');
  assert.match(await page.getAttribute('#m2m-end', 'aria-describedby'), /\bm2m-time-error\b/);
  await page.click('#m2m-convert');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-end', 'Convert sends the focus to the field to mend');
  await typeInto('#m2m-end', '2,5');
  assert.equal(await page.getAttribute('#m2m-end', 'aria-invalid'), null);
  assert.equal(await text('#m2m-time-error'), '');
  await convert();
  const part = await dl('song.mp3');
  w = parseWav(part.bytes);
  assert.equal(w.frames, 88200, '0.5 s to 2.5 s is 88,200 samples');
  assert.equal(lagOf(w.ch[0], 20000, 20000, 1200, 22050), 0, 'starting 0.5 s into the chirp, to the sample');
  const partFrom = Math.round(songBytes * 2000 / 3000);
  assert.equal(await text('#m2m-status'), `song.wav is ready to download: 0:02.000 of 0:03.000: ${fmtBytes(partFrom)} MP3 → ${fmtBytes(part.bytes.length)} WAV, ${times(partFrom, part.bytes.length)}.`);
  await clear();

  // ---------- Written straight to a file: the same bytes as built in memory ----------
  // The page writes a WAV of 200 MB or more into a file the visitor chooses.
  // Here a short song is made to look that big; the save dialog hands over a
  // file kept in memory.
  await add(['song.mp3']);
  await page.evaluate(() => {
    window.__estimate = TTAudio.estimate;
    TTAudio.estimate = (m, ti, o) => window.__estimate(m, ti, o) * 100000;
    window.__fakePicker({});
    document.getElementById('m2m-bits').dispatchEvent(new Event('change'));
  });
  assert.match(await text('#m2m-estimate'), / A WAV this big is written straight to a file as it converts: Convert asks where to save it\.$/);
  await page.click('#m2m-convert');
  await waitIdle();
  assert.deepEqual(await page.evaluate(() => window.__picks), [{ suggestedName: 'song.wav', types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] }]);
  let saved = await page.evaluate(() => { const f = window.__saved['chosen.wav']; return { b64: btoa(Array.from(f.bytes, x => String.fromCharCode(x)).join('')), closed: f.closed, aborted: f.aborted }; });
  assert.deepEqual([saved.closed, saved.aborted], [true, false], 'the file is closed once written');
  assert.ok(Buffer.from(saved.b64, 'base64').equals(song.bytes), 'what is written is the WAV built in memory, byte for byte');
  c = await card('song.mp3');
  assert.deepEqual([c.state, c.download], [`Saved: chosen.wav. ${fmtBytes(songBytes)} MP3 → ${fmtBytes(song.bytes.length)} WAV, ${times(songBytes, song.bytes.length)}.`, false], 'saved already, so no Download button');
  // A disk that fills up: the file is discarded and the reason shown.
  await page.evaluate(() => { window.__fakePicker({ fail: 1, names: ['full.wav'] }); document.getElementById('m2m-bits').value = 's24'; document.getElementById('m2m-bits').dispatchEvent(new Event('change')); });
  await convert();
  c = await card('song.mp3');
  assert.equal(c.msg, 'The WAV could not be written to full.wav (There is not enough space on the disk.). Check the space left on the device, then convert it again.');
  assert.equal(await page.evaluate(() => window.__saved['full.wav'].closed), false, 'never closed, so nothing half-written is kept');
  await page.evaluate(() => { TTAudio.estimate = window.__estimate; document.getElementById('m2m-bits').value = 's16'; document.getElementById('m2m-bits').dispatchEvent(new Event('change')); });
  await clear();

  // ---------- RF64 past 4 GB, and room for it in a big WAV that stays smaller ----------
  // The engine's WAV writer, which convert() writes every WAV with, given
  // 4.3 GB of float sound (zeros made once, so no memory is needed) and a
  // file that keeps only the header and the size.
  const cpu0 = await thread();
  const big = await page.evaluate(async () => {
    const mk = () => {
      const f = { size: 0, head: null, closed: false };
      f.ws = new WritableStream({ write(c) { if (c.position === 0) f.head = Array.from(new Uint8Array(c.data.buffer || c.data, c.data.byteOffset || 0, Math.min(120, c.data.byteLength))); f.size = Math.max(f.size, c.position + c.data.byteLength); }, close() { f.closed = true; } });
      return f;
    };
    let f = mk(), w = TTAudio.wavWriter({ sampleRate: 44100, channels: 2, sampleFormat: 's16', writable: f.ws, tags: null, room: true });
    w.add([new Float32Array(1000), new Float32Array(1000)], 1000);
    const small = { size: await w.finish(null), head: f.head, closed: f.closed };
    f = mk(); w = TTAudio.wavWriter({ sampleRate: 48000, channels: 2, sampleFormat: 'f32', writable: f.ws, tags: null, room: true });
    const n = 1 << 20, z = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < 513; i++) { w.add(z, n); const p = w.wait(); if (p) await p; }
    return { small, big: { size: await w.finish(null), head: f.head, closed: f.closed } };
  });
  const head = b => Buffer.from(b);
  let h = head(big.small.head);
  assert.deepEqual([h.toString('latin1', 0, 4), h.readUInt32LE(4), h.toString('latin1', 12, 16), h.readUInt32LE(16)], ['RIFF', big.small.size - 8, 'JUNK', 28], 'under 4 GB: RIFF, with the room as a JUNK chunk');
  assert.equal(big.small.size, 12 + 36 + 24 + 8 + 4000);
  h = head(big.big.head);
  const frames4 = 513 * (1 << 20);
  assert.deepEqual([h.toString('latin1', 0, 4), h.readUInt32LE(4), h.toString('latin1', 12, 16), h.readUInt32LE(16)], ['RF64', 0xffffffff, 'ds64', 28], 'past 4 GB: RF64');
  assert.deepEqual([Number(h.readBigUInt64LE(20)), Number(h.readBigUInt64LE(28)), Number(h.readBigUInt64LE(36))], [big.big.size - 8, frames4 * 8, frames4], 'its ds64 sizes: RIFF, data and frames');
  assert.deepEqual([h.toString('latin1', 48, 52), h.readUInt16LE(56), h.toString('latin1', 74, 78), h.toString('latin1', 86, 90), h.readUInt32LE(90)], ['fmt ', 3, 'fact', 'data', 0xffffffff]);
  assert.ok(big.big.size > 4294967296 && big.big.closed, `${big.big.size} bytes written and closed`);
  assert.ok((await thread()) - cpu0 < 12000, 'writing 4.3 GB took little enough main-thread time');

  // ---------- The keyboard: choose, preset, convert, download ----------
  const chooser = page.waitForEvent('filechooser');
  await page.focus('#m2m-open');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles([F('mpeg2.mp3')]);
  await waitRead();
  await page.focus('#m2m-p-cd');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#m2m-rate'), '44100');
  let tabs = 0;
  while (await page.evaluate(() => document.activeElement.id) !== 'm2m-convert' && tabs++ < 12) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-convert', 'Convert follows the options in tab order');
  await page.keyboard.press('Enter');
  await waitIdle();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Download', 'the focus moves to the result');
  const viaKeys = await download(() => page.keyboard.press('Enter'));
  w = parseWav(viaKeys.bytes);
  assert.deepEqual([w.channels, w.sampleRate, w.frames], [2, 44100, 88200], 'mpeg2.mp3 for a CD: 22.05 kHz mono to 44.1 kHz stereo');
  assert.equal(maxDiff(w.ch[0], w.ch[1]), 0);
  // A double click converts once and downloads once.
  await page.selectOption('#m2m-bits', 's24');
  const wake0 = await page.evaluate(() => window.__wake.requested);
  await page.dblclick('#m2m-convert');
  await waitIdle();
  assert.equal(await page.evaluate(() => window.__live.filter(t => t.startsWith('mpeg2.wav is ready')).length), 2, 'one more announcement for one more conversion');
  assert.equal(await page.evaluate(() => window.__wake.requested) - wake0, 1, 'the screen kept on while converting');
  assert.equal(await page.evaluate(() => window.__wake.released), await page.evaluate(() => window.__wake.requested), 'and let go after');
  let count = 0;
  page.on('download', () => count++);
  await row('mpeg2.mp3').locator('.m2m-dl').dblclick();
  await page.waitForTimeout(800);
  assert.equal(count, 1, 'a double click downloads once');
  // Fields the browser restores after Back are read again on pageshow.
  await page.evaluate(() => { document.getElementById('m2m-bits').value = 'f32'; document.getElementById('m2m-rate').value = '48000'; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await text('#m2m-format-hint'), 'WAV, 32-bit float, which audio editors work in. A minute of stereo at 48 kHz takes 23 MB.' + BIGGER + MEM);
  assert.equal((await card('mpeg2.mp3')).download, false, 'and the result made at the old settings is dropped');
  await page.selectOption('#m2m-bits', 's16');
  await page.selectOption('#m2m-rate', '0');
  await page.selectOption('#m2m-channels', 'keep');
  await clear();

  // ---------- The sample sound is an MP3 ----------
  await page.click('#m2m-sample');
  await waitRead();
  c = await card('sample.mp3');
  assert.deepEqual([c.info, c.note], ['0:08.000 · MP3 · 44.1 kHz · stereo · 192 kbps', GAPLESS]);
  await convert();
  w = parseWav((await dl('sample.mp3')).bytes);
  assert.deepEqual([w.frames, w.info.INAM], [352800, 'Sample sound'], 'the 8 s sample, to the sample');
  await clear();

  // ---------- An hour-long MP3 (repeated frames): progress, Cancel, a part ----------
  const hourBlock = fs.readFileSync(F('hour-block.mp3')).toString('base64');
  const dropHour = (p, repeats) => p.evaluate(([b64, repeats]) => {
    const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), blk = new Blob([u8]), parts = [];
    for (let i = 0; i < repeats; i++) parts.push(blk);
    const dt = new DataTransfer();
    dt.items.add(new File(parts, 'hour.mp3', { type: 'audio/mpeg' }));
    document.getElementById('m2m-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [hourBlock, repeats]);
  const hourMs = Math.round(345 * exp['hour-block.mp3'].samples / 44.1);
  const hourWav = Math.round(hourMs / 1000 * 44100) * 4 + 44;
  await dropHour(page, 345);
  await waitRead();
  c = await card('hour.mp3');
  assert.deepEqual([c.info, c.note, c.msg], [`${fmtTime(hourMs)} · MP3 · 44.1 kHz · stereo · 64 kbps`, LEADIN, '']);
  assert.equal(await text('#m2m-estimate'), `Estimated size: about ${fmtBytes(hourWav)} as hour.wav, 22 times the size of the MP3. A WAV this big is written straight to a file as it converts: Convert asks where to save it.`);
  // Written to a slow disk, a megabyte at a time, and cancelled: the file is discarded.
  await page.evaluate(() => { window.__picks = []; window.__fakePicker({ slow: 300, names: ['hour.wav'] }); });
  await page.click('#m2m-convert');
  await page.waitForFunction(() => window.__saved['hour.wav'] && window.__saved['hour.wav'].bytes.length > 2e6);
  assert.match(await text('.m2m-file-state'), /^Converting… \d+%$/);
  assert.deepEqual(await page.evaluate(() => window.__picks.map(x => x.suggestedName)), ['hour.wav']);
  await page.click('#m2m-cancel');
  await waitIdle();
  assert.deepEqual(await page.evaluate(() => [window.__saved['hour.wav'].aborted, window.__saved['hour.wav'].closed]), [true, false], 'aborted, not closed');
  assert.ok(await page.evaluate(() => window.__saved['hour.wav'].queuedMax <= 2), 'the converter waits for the disk rather than piling up megabytes in memory');
  assert.deepEqual([(await card('hour.mp3')).state, await text('#m2m-status')], ['Ready', 'Conversion cancelled.']);
  await unfold('m2m-trim');
  await typeInto('#m2m-start', fmtTime(hourMs - 2000));
  await convert();
  w = parseWav((await dl('hour.mp3')).bytes);
  // From the start typed to the real end of the sound (the length shown is rounded to the millisecond).
  assert.equal(w.frames, 345 * exp['hour-block.mp3'].samples - Math.round((hourMs - 2000) * 44.1), 'its last 2 s, to the sample');
  near(hz(w.ch[0], 44100), 440, 1, 'the end of an hour holds its 440 Hz tone');
  await clear();

  // ---------- A browser without WebCodecs audio (Firefox for Android, Safari before 26) ----------
  const ctx2 = await page.context().browser().newContext({ viewport: { width: 1000, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => { delete window.AudioDecoder; delete window.AudioEncoder; delete window.AudioData; delete window.EncodedAudioChunk; });
  await p2.goto(url);
  await add(['song.mp3', 'no-tag.mp3'], p2);
  assert.equal(await p2.evaluate(() => [...document.querySelectorAll('.m2m-file-state')].map(e => e.textContent).join()), 'Ready,Ready');
  await convert(p2);
  w = parseWav((await dl('song.mp3', p2)).bytes);
  assert.equal(w.frames, 132300, 'decoded whole, still exactly the samples encoded');
  assert.ok(maxDiff(w.ch[0], song16.ch[0]) <= STEP, 'the same sound as with WebCodecs');
  w = parseWav((await dl('no-tag.mp3', p2)).bytes);
  assert.equal(w.frames, exp['no-tag.mp3'].samples);
  await p2.selectOption('#m2m-bits', 's24');
  await edit('song.mp3', p2);
  assert.match(await text('#m2m-estimate', p2), / This browser decodes MP3 whole, at 16 bits, so this 24-bit WAV holds no more than a 16-bit one\.$/);
  await convert(p2);
  w = parseWav((await dl('song.mp3', p2)).bytes);
  assert.ok(w.ch[0].every(v => Number.isInteger(v * 32768)), 'its 24-bit WAV holds 16 bits');
  await clear(p2);
  // Longer than the hour this browser decodes at once: refused as soon as it is added.
  await dropHour(p2, 345);
  await waitRead(p2);
  c = await card('hour.mp3', p2);
  assert.equal(c.msg, 'This browser has to decode the whole sound track at once, which works up to 60 minutes on this device. Use a current version of Chrome, Edge, Firefox (on a computer) or Safari (26 or later).');
  assert.equal(await p2.isDisabled('#m2m-convert'), true);
  await ctx2.close();

  // ---------- A phone with touch, without a save dialog ----------
  const ctx3 = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  const p3 = await ctx3.newPage();
  await p3.addInitScript(() => { delete window.showSaveFilePicker; });
  await p3.goto(url);
  assert.equal(await text('#m2m-format-hint', p3), HINT16.replace(MEM, ' Each WAV is built in memory, up to 300 MB on this device.'));
  await dropHour(p3, 345);
  await waitRead(p3);
  c = await card('hour.mp3', p3);
  assert.equal(c.msg, `As WAV this would be about ${fmtBytes(hourWav)}, more than the 300 MB a phone can build in memory. Choose a lower sample rate or bit depth, Mono or a shorter part (under Trim, fades and volume), or use Chrome on Android, or Chrome or Edge on a computer, which can write a big WAV straight to a file as it converts.`);
  assert.equal(await p3.isDisabled('#m2m-convert'), true);
  await tap('#m2m-p-phone16', p3);
  c = await card('hour.mp3', p3);
  assert.deepEqual([c.msg, c.state], ['', 'Ready'], 'at 8 kHz mono it fits');
  // The start handle dragged with a finger to the end of the waveform.
  await tap('#m2m-trim summary', p3);
  await p3.locator('#m2m-trackbox').scrollIntoViewIfNeeded();
  await settle(p3);
  const box = await p3.locator('#m2m-trackbox').boundingBox(), hb = await p3.locator('#m2m-h-start').boundingBox();
  const touch = await ctx3.newCDPSession(p3), from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, to = { x: box.x + box.width - 1, y: hb.y + hb.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let s = 1; s <= 8; s++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * s / 8, y: from.y }] });
  // The finger stops before it lifts, as on a handle put in place; a flick
  // would leave a fling that the next tap only stops.
  for (let s = 0; s < 2; s++) { await p3.waitForTimeout(250); await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] }); }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const startMs = await p3.evaluate(() => +document.getElementById('m2m-h-start').getAttribute('aria-valuenow') * 1000);
  assert.ok(startMs > hourMs * 0.99, `the start handle followed the finger to ${fmtTime(startMs)}`);
  await tap('#m2m-convert', p3);
  await waitIdle(p3);
  const phoneWav = await dl('hour.mp3', p3);
  w = parseWav(phoneWav.bytes);
  assert.deepEqual([w.channels, w.sampleRate, w.bits], [1, 8000, 16]);
  near(w.frames, (hourMs - startMs) * 8, 16, 'the part selected, at 8 kHz');
  await ctx3.close();

  // Each announcement once, naming its file.
  const said = await live();
  assert.equal(said.filter(t => t === 'Conversion cancelled.').length, 1);
  assert.ok(said.every((t, i) => i === 0 || t !== said[i - 1]), 'no announcement repeated back to back');
};
