'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { devices } = require('playwright');

// The samples come from tests/fixtures/m4a-to-mp3/make_fixtures.py (ffmpeg,
// Pillow, mutagen), which also writes expected.json: rates, channels, bit
// depths and sample counts from ffprobe (an MP4's edit list included), the
// bitrate the page measures (ffprobe's packets of the first 10 s), and the
// covers' SHA-256. Every file the page writes is checked by
// tests/fixtures/m4a-to-mp3/verify.py, which shares no code with the page:
// ffprobe for the stream, ffmpeg (which honours the LAME tag) and numpy for
// the samples, their count, level and tone, the frame headers, mutagen for
// every ID3v2.3 frame and Pillow for the cover; WAVs made from Apple Lossless
// are compared sample by sample with ffmpeg's own ALAC decoder. A 10-hour
// audiobook and a 350 MB Apple Lossless file are built in the page from
// repeated parts of the samples.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm4a-to-mp3-'));
  try {
    await run({ page, open, assert, fixtures, url, tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

async function run({ page, open, assert, fixtures, url, tmp }) {
  for (const [cmd, args] of [['ffprobe', ['-version']], ['ffmpeg', ['-version']], ['python3', ['-c', 'import numpy, mutagen, PIL']]]) {
    try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch (e) {
      throw new Error(`tests/tools/m4a-to-mp3.test.js checks every file with ffmpeg, ffprobe and python3 with numpy, mutagen and Pillow: ${cmd} ${args.join(' ')} failed`);
    }
  }
  const F = name => path.join(fixtures, name);
  const exp = JSON.parse(fs.readFileSync(F('expected.json'), 'utf8'));
  const T = exp.tags;
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  let saved = 0;
  const verify = (kind, bytes, src) => {
    const p = path.join(tmp, `${++saved}.${kind}`);
    fs.writeFileSync(p, bytes);
    return JSON.parse(execFileSync('python3', [F('verify.py'), kind, p].concat(src ? [F(src)] : []), { maxBuffer: 64 << 20 }).toString());
  };
  const browser = page.context().browser();
  const problems = [];
  const watch = p => {
    p.on('pageerror', e => problems.push('page error: ' + e.message));
    p.on('console', x => { if (x.type() === 'error') problems.push('console error: ' + x.text()); });
  };

  const instrument = () => {
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
    // Bytes read from files, and the screen wake lock.
    window.__read = 0;
    const ab = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { return ab.call(this).then(b => { window.__read += b.byteLength; return b; }); };
    const rd = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function () {
      return rd.call(this).then(r => { if (r && r.value && r.value.byteLength) window.__read += r.value.byteLength; return r; });
    };
    // Apple Lossless decoders (one worker per file): made, ended, most at once.
    window.__alac = { made: 0, ended: 0, most: 0 };
    const W = window.Worker;
    window.Worker = function (url, opts) {
      const w = new W(url, opts);
      if (/alac-worker/.test(String(url))) {
        const a = window.__alac;
        a.made++;
        a.most = Math.max(a.most, a.made - a.ended);
        const end = w.terminate.bind(w);
        w.terminate = () => { a.ended++; end(); };
      }
      return w;
    };
    window.Worker.prototype = W.prototype;
    window.__wake = { requested: 0, released: 0 };
    if (navigator.wakeLock) {
      navigator.wakeLock.request = () => {
        window.__wake.requested++;
        return Promise.resolve({ release() { window.__wake.released++; return Promise.resolve(); }, addEventListener() {} });
      };
    }
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
    const r = row(name, p);
    return {
      info: await r.locator('.m2m-file-info').textContent(), state: await r.locator('.m2m-file-state').textContent(),
      msg: await r.locator('.m2m-file-msg').textContent(), download: await r.locator('.m2m-dl').isVisible()
    };
  };
  const waitRead = (p = page) => p.waitForFunction(() => document.querySelectorAll('.m2m-file').length > 0 &&
    ![...document.querySelectorAll('.m2m-file-state')].some(e => e.textContent === 'Reading…'), null, { timeout: 30000 });
  const waitIdle = (p = page) => p.waitForFunction(() => document.getElementById('m2m-cancel').hidden &&
    document.getElementById('m2m-convert').textContent !== 'Converting…', null, { timeout: 120000 });
  const download = async (action, p = page) => {
    const caller = (new Error().stack.split('\n')[2] || '').trim();
    try {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), action()]);
      return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
    } catch (e) {
      throw new Error(`${String(e.message).split('\n')[0]} (download ${caller})`);
    }
  };
  const fetchFile = (name, p = page) => download(() => row(name, p).locator('.m2m-dl').click(), p);
  const convert = async (p = page) => { await p.click('#m2m-convert'); await waitIdle(p); };
  const typeInto = async (sel, value, p = page) => {
    await p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  const live = (p = page) => p.evaluate(() => window.__live.slice());
  const lastLive = async (p = page) => (await live(p)).filter(x => x).pop();
  const fieldState = async (sel, p = page) => ({
    invalid: await p.getAttribute(sel, 'aria-invalid'),
    describedby: (await p.getAttribute(sel, 'aria-describedby') || '').split(' ')
  });
  const kb = name => exp[name].kbps;
  const srcFacts = name => JSON.parse(execFileSync('python3', [F('verify.py'), 'src', F(name)]).toString());
  const frames = (m, f) => m.id3.frames[f] && m.id3.frames[f].text;

  // ---------- The page as it opens ----------
  assert.equal(await text('h1'), 'M4A to MP3 Converter: Voice Memos and Songs');
  assert.equal(await text('.m2m-drop-title'), 'Drop M4A files here');
  assert.match(await text('#m2m-drop-hint'), /^M4A, M4B, AAC or Apple Lossless \(ALAC\)/);
  assert.ok(await page.isChecked('#m2m-f-mp3'), 'MP3 is chosen first');
  assert.equal(await page.locator('#m2m-f-wav').count(), 1, 'WAV is offered');
  assert.equal(await page.locator('#m2m-f-copy').count(), 0, 'no Original audio choice on this page');
  assert.deepEqual(await page.$$eval('input[name="m2m-format"]', r => r.map(x => x.value)), ['mp3', 'wav'], 'MP3 first, WAV second');
  assert.equal(await page.inputValue('#m2m-bitrate'), 'auto');
  assert.equal(await page.$eval('#m2m-bitrate', s => s.options[s.selectedIndex].textContent), 'Automatic');
  assert.equal(await text('#m2m-format-hint'), "Automatic picks each MP3's bitrate from its source: 96 kbps for voice memos, 192 kbps for most songs, 256 kbps for songs of 200 kbps or more, such as those from iTunes, and 320 kbps for lossless files. A higher bitrate makes a bigger file but cannot bring back detail that the source does not have.");
  assert.equal(await page.isChecked('#m2m-shrink'), false, 'covers are kept as they are at first');
  assert.equal(await page.isDisabled('#m2m-convert'), true);
  assert.equal(await text('#m2m-convert'), 'Convert to MP3');
  assert.equal(await page.isHidden('#m2m-files-sec'), true);
  // The trim editor is folded away.
  assert.equal(await page.$eval('#m2m-trim', d => d.open), false, 'trim, fades and volume start folded');
  assert.equal(await page.$eval('#m2m-trim summary', s => s.textContent), 'Trim, fades and volume');

  // ---------- Four files chosen from the keyboard ----------
  await page.focus('#m2m-open');
  await page.keyboard.press('Enter');
  const chooser = await chooserReady;
  await chooser.setFiles(['song.m4a', 'memo.m4a', 'alac16.m4a', 'alac24.m4a'].map(F));
  await waitRead();
  assert.deepEqual(await card('song.m4a'), { info: `0:03.000 · AAC · 44.1 kHz · stereo · ${kb('song.m4a')} kbps`, state: 'Ready, as MP3 at 256 kbps', msg: '', download: false });
  assert.deepEqual(await card('memo.m4a'), { info: `0:06.000 · AAC · 48 kHz · mono · ${kb('memo.m4a')} kbps`, state: 'Ready, as MP3 at 96 kbps', msg: '', download: false });
  assert.deepEqual(await card('alac16.m4a'), { info: `0:01.500 · Apple Lossless (ALAC) · 44.1 kHz · stereo · 16-bit · ${kb('alac16.m4a')} kbps`, state: 'Ready, as MP3 at 320 kbps', msg: '', download: false });
  assert.deepEqual(await card('alac24.m4a'), { info: `0:01.000 · Apple Lossless (ALAC) · 48 kHz · mono · 24-bit · ${kb('alac24.m4a')} kbps`, state: 'Ready, as MP3 at 320 kbps', msg: '', download: false });
  assert.equal(await lastLive(), 'Added 4 files.');
  assert.equal(await text('#m2m-convert'), 'Convert 4 files to MP3');

  // The first file's tags, every one the page keeps.
  assert.equal(await text('#m2m-edit-name'), 'song.m4a');
  await page.click('#m2m-tags summary');
  const tagFields = { '#m2m-title': T.title, '#m2m-artist': T.artist, '#m2m-album': T.album, '#m2m-albumartist': T.album_artist,
    '#m2m-composer': T.composer, '#m2m-genre': T.genre, '#m2m-year': '2019', '#m2m-track': '3/12', '#m2m-disc': '1/2' };
  for (const [sel, v] of Object.entries(tagFields)) assert.equal(await page.inputValue(sel), v, `${sel} shows the file's tag`);
  assert.equal(await text('#m2m-kept'), `Also kept from the file: its lyrics (${T.lyrics.length} characters) and its comment.`);
  const jpg = exp['cover.jpg'], png = exp['cover.png'];
  assert.equal(await text('#m2m-cover-info'), `Cover: 1400 × 1400 pixels, JPEG, ${Math.round(jpg.bytes / 1000)} KB.`);
  const estimate = () => text('#m2m-estimate');
  // MP3 bytes at 256 kbps for 3 s, plus the cover and its frame.
  assert.equal(await estimate(), `Estimated size: about ${Math.round((256 * 125 * 3 + 300 + jpg.bytes + 32) / 1000)} KB as song.mp3. Automatic: 256 kbps for its source, AAC at ${kb('song.m4a')} kbps.`);
  const edit = async name => { await row(name).locator('.m2m-edit').click(); assert.equal(await text('#m2m-edit-name'), name); };
  await edit('memo.m4a');
  assert.equal(await estimate(), `Estimated size: about ${Math.round((96 * 125 * 6 + 300) / 1000)} KB as memo.mp3. Automatic: 96 kbps for its source, mono AAC at ${kb('memo.m4a')} kbps.`);
  assert.equal(await page.inputValue('#m2m-year'), '2024-05-03', 'a memo keeps its recording date');
  assert.equal(await page.isHidden('#m2m-kept'), true, 'nothing else to keep');
  assert.equal(await page.isHidden('#m2m-cover-row'), true, 'no cover');
  await edit('alac16.m4a');
  assert.match(await estimate(), /as alac16\.mp3\. Automatic: 320 kbps, the most MP3 holds, as its source is lossless\.$/);
  assert.equal(await text('#m2m-cover-info'), `Cover: 900 × 600 pixels, PNG, ${(png.bytes / 1000).toFixed(1)} KB.`);
  await edit('song.m4a');

  // ---------- Convert from the keyboard; check every file ----------
  await page.focus('#m2m-shrink');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-convert', 'Tab goes from the cover switch to Convert');
  assert.ok(await page.$eval('#m2m-convert', b => b.matches(':focus-visible') && getComputedStyle(b).outlineStyle !== 'none'), 'the focused button shows a focus ring');
  await page.keyboard.press('Enter');
  await waitIdle();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-zip', 'the focus moves to Download all');
  assert.equal(await lastLive(), '4 of 4 files converted. Download them one by one or all as a ZIP.');
  assert.ok(await page.evaluate(() => window.__wake.requested > 0 && window.__wake.released === window.__wake.requested), 'the screen is kept on while converting, and let go after');
  // Download all, from the keyboard (the focus is on it).
  const zip = await download(() => page.keyboard.press('Enter'));
  assert.equal(zip.name, 'converted-audio.zip');
  const songCard = await card('song.m4a');
  assert.match(songCard.state, /^Converted: song\.mp3, \d+ KB$/);
  const out = {};
  for (const name of ['song', 'memo', 'alac16', 'alac24']) {
    const f = await fetchFile(name + '.m4a');
    assert.equal(f.name, name + '.mp3');
    out[name] = f.bytes;
  }
  const checkMp3 = (m, o, what) => {
    assert.deepEqual([m.stream.codec, m.stream.rate, m.stream.channels], ['mp3', o.rate, o.channels], `${what}: stream`);
    assert.deepEqual(m.frames.kbps, [o.kbps], `${what}: every frame at ${o.kbps} kbps`);
    assert.equal(m.frames.info, 'Info', `${what}: an Info frame (LAME tag) first`);
    assert.equal(m.frames.end, m.frames.fileEnd, `${what}: frames run to the ID3v1 tag`);
    assert.equal(m.sound.samples, o.samples, `${what}: ${o.samples} samples, as ffmpeg decodes it with its LAME tag`);
    if (o.freq) o.freq.forEach((f, c) => near(m.sound.freq[c], f, 3, `${what}: tone of channel ${c + 1}`));
    if (o.rms) o.rms.forEach((r, c) => near(m.sound.rms[c], r, 0.02, `${what}: level of channel ${c + 1}`));
    assert.deepEqual(m.id3.version, [3, 0], `${what}: ID3v2.3`);
  };
  let m = verify('mp3', out.song);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 256, samples: exp['song.m4a'].samples, freq: [440, 660], rms: [0.5 / Math.SQRT2, 0.25 / Math.SQRT2] }, 'song.mp3');
  const f = m.id3.frames;
  assert.deepEqual(f.TIT2, { text: T.title, encoding: 1 }, 'a title outside ISO-8859-1 is UTF-16');
  assert.deepEqual(f.TPE1, { text: T.artist, encoding: 0 });
  assert.equal(frames(m, 'TALB'), T.album);
  assert.equal(frames(m, 'TPE2'), T.album_artist);
  assert.equal(frames(m, 'TCOM'), T.composer);
  assert.equal(frames(m, 'TRCK'), '3/12');
  assert.equal(frames(m, 'TPOS'), '1/2');
  assert.equal(frames(m, 'TYER'), '2019', 'the year stays a year');
  assert.equal(f.TDAT, undefined, 'no day for a year-only date');
  assert.equal(f.TDRC, undefined, 'no ID3v2.4 frames');
  assert.equal(frames(m, 'TCON'), T.genre);
  assert.deepEqual(f.COMM, [{ lang: 'eng', desc: '', text: T.comment, encoding: 1 }]);
  assert.deepEqual(f.USLT, [{ lang: 'eng', desc: '', text: T.lyrics, encoding: 1 }]);
  assert.equal(m.id3.pictures.length, 1);
  assert.deepEqual({ ...m.id3.pictures[0] }, { mime: 'image/jpeg', type: 3, desc: '', sha256: jpg.sha256, bytes: jpg.bytes, format: 'JPEG', width: 1400, height: 1400 }, 'the cover, byte for byte');
  assert.deepEqual(m.id3v1, { title: 'Café', artist: T.artist, album: T.album, year: '2019', comment: 'A comment', track: 3, genre: 8 },
    'ID3v1: text up to the first letter it cannot hold, track 3, genre Jazz');
  m = verify('mp3', out.memo);
  checkMp3(m, { rate: 48000, channels: 1, kbps: 96, samples: exp['memo.m4a'].samples, freq: [300], rms: [0.4 / Math.SQRT2] }, 'memo.mp3');
  assert.deepEqual([frames(m, 'TIT2'), frames(m, 'TYER'), frames(m, 'TDAT')], ['New Recording 3', '2024', '0305'], 'memo: title and full date (TYER and TDAT)');
  assert.equal(m.id3.pictures.length, 0);
  assert.equal(m.id3v1.title, 'New Recording 3');
  m = verify('mp3', out.alac16);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 320, samples: exp['alac16.m4a'].samples, freq: [1000, 1500], rms: [0.5 / Math.SQRT2, 0.25 / Math.SQRT2] }, 'alac16.mp3');
  assert.deepEqual([frames(m, 'TIT2'), frames(m, 'TPE1'), frames(m, 'TALB'), frames(m, 'TRCK'), frames(m, 'TYER')], ['Lossless sixteen', 'Rip Artist', 'Rip Album', '1/10', '2005']);
  assert.deepEqual([m.id3.pictures[0].mime, m.id3.pictures[0].sha256, m.id3.pictures[0].width], ['image/png', png.sha256, 900], 'a PNG cover kept as it is');
  m = verify('mp3', out.alac24);
  checkMp3(m, { rate: 48000, channels: 1, kbps: 320, samples: exp['alac24.m4a'].samples, freq: [1000], rms: [0.1 / Math.SQRT2] }, 'alac24.mp3');

  // The ZIP holds the same bytes.
  const z = verify('zip', zip.bytes);
  assert.equal(z.bad, null, 'the ZIP passes its own CRC checks');
  assert.deepEqual(z.entries.map(e => [e.name, e.sha256]), ['song', 'memo', 'alac16', 'alac24'].map(n => [n + '.mp3', sha(out[n])]));
  // A second press at once is a double click, not a second download.
  let extra = 0;
  const countDl = () => extra++;
  page.on('download', countDl);
  await download(() => row('memo.m4a').locator('.m2m-dl').dblclick());
  await page.waitForTimeout(1500);
  page.off('download', countDl);
  assert.equal(extra, 1, 'a double click downloads once');

  // ---------- Shrinking covers ----------
  await page.check('#m2m-shrink');
  assert.equal((await card('song.m4a')).state, 'Ready, as MP3 at 256 kbps', 'a file with a big cover is converted again');
  assert.equal((await card('alac16.m4a')).state, 'Ready, as MP3 at 320 kbps');
  assert.match((await card('memo.m4a')).state, /^Converted: /, 'a file without a cover keeps its result');
  assert.match((await card('alac24.m4a')).state, /^Converted: /);
  assert.equal(await text('#m2m-cover-info'), `Cover: 1400 × 1400 pixels, JPEG, ${Math.round(jpg.bytes / 1000)} KB. With Shrink cover art on, it is saved at 600 pixels a side or less.`);
  await page.waitForFunction(b => {
    const m = /about ([\d.]+) KB/.exec(document.getElementById('m2m-estimate').textContent);
    return m && +m[1] < b;
  }, Math.round((256 * 125 * 3 + 300 + jpg.bytes) / 1000), { timeout: 10000 });
  await convert();
  assert.equal(await lastLive(), '2 of 2 files converted. Download them one by one or all as a ZIP.');
  m = verify('mp3', (await fetchFile('song.m4a')).bytes);
  const pic = m.id3.pictures[0];
  assert.deepEqual([pic.mime, pic.format, pic.width, pic.height], ['image/jpeg', 'JPEG', 600, 600], 'the cover is shrunk to 600 x 600');
  assert.ok(pic.bytes < jpg.bytes, `the shrunk cover is smaller (${pic.bytes} bytes)`);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 256, samples: exp['song.m4a'].samples }, 'song.mp3 with a shrunk cover');
  m = verify('mp3', (await fetchFile('alac16.m4a')).bytes);
  assert.deepEqual([m.id3.pictures[0].mime, m.id3.pictures[0].format, m.id3.pictures[0].width, m.id3.pictures[0].height], ['image/png', 'PNG', 600, 400], 'a 900 x 600 PNG cover becomes a 600 x 400 PNG');

  // ---------- Editing tags: wrong values are named, and stop the conversion ----------
  await edit('song.m4a');
  const numError = () => text('#m2m-num-error');
  await typeInto('#m2m-year', '20x9');
  assert.equal(await numError(), 'Type the year as 4 digits, such as 2019, or a date such as 2019-05-03.');
  assert.deepEqual(await fieldState('#m2m-year'), { invalid: 'true', describedby: ['m2m-num-hint', 'm2m-num-error'] });
  assert.equal((await card('song.m4a')).download, false, 'the result goes while a field cannot be read');
  await page.click('#m2m-convert');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-year', 'Convert takes the focus to the field to mend');
  assert.equal(await page.isHidden('#m2m-progress'), true, 'nothing is converted');
  await typeInto('#m2m-year', '2020-02-30');
  assert.equal(await numError(), 'That day does not exist in 2020-02.');
  await typeInto('#m2m-year', '２０２０-02-29');
  assert.equal(await numError(), '', 'full-width digits are digits');
  assert.equal((await fieldState('#m2m-year')).invalid, null);
  for (const [v, msg] of [['13/12', 'The track number (13) cannot be more than the total (12).'], ['3,5', 'Type the track number as a whole number, such as 3, or 3/12 for the number and the total.'],
    ['²', 'Type the track number as a whole number, such as 3, or 3/12 for the number and the total.'], ['0', 'The track number and the total start at 1.']]) {
    await typeInto('#m2m-track', v);
    assert.equal(await numError(), msg, `track "${v}"`);
    assert.equal((await fieldState('#m2m-track')).invalid, 'true');
  }
  await typeInto('#m2m-track', '٣/١٢');
  assert.equal(await numError(), '', 'Arabic-Indic digits are digits');
  await typeInto('#m2m-disc', '1\t2');
  assert.match(await numError(), /^Type the disc number as a whole number/, 'a tab inside a number is not read as part of it');
  // An entry left with a wrong value is the one Convert goes back to.
  await edit('memo.m4a');
  await page.click('#m2m-convert');
  assert.equal(await text('#m2m-edit-name'), 'song.m4a', 'Convert opens the file whose tags need mending');
  assert.equal(await page.inputValue('#m2m-disc'), '1\t2', 'what was typed is still there');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'm2m-disc');
  await typeInto('#m2m-disc', '');
  await typeInto('#m2m-composer', '');
  await typeInto('#m2m-genre', 'Spoken Word');
  await convert();
  m = verify('mp3', (await fetchFile('song.m4a')).bytes);
  assert.deepEqual([frames(m, 'TYER'), frames(m, 'TDAT'), frames(m, 'TRCK'), frames(m, 'TCON')], ['2020', '2902', '3/12', 'Spoken Word']);
  assert.equal(m.id3.frames.TPOS, undefined, 'an empty disc field writes no disc');
  assert.equal(m.id3.frames.TCOM, undefined, 'an empty composer field writes no composer');
  assert.equal(m.id3v1.genre, 255, 'a genre ID3v1 does not list is left out there');

  // ---------- A bitrate chosen by hand ----------
  await edit('memo.m4a');
  await page.selectOption('#m2m-bitrate', '320');
  assert.equal(await estimate(), `Estimated size: about ${Math.round((320 * 125 * 6 + 300) / 1000)} KB as memo.mp3. Its source is mono AAC at ${kb('memo.m4a')} kbps: a higher bitrate makes the file bigger but cannot bring back detail the source does not have.`);
  assert.equal((await card('memo.m4a')).state, 'Ready', 'a chosen bitrate is the same for every file');
  assert.match(await text('#m2m-format-hint'), /^MP3 at 320 kbps takes about 2\.40 MB a minute\./);
  await page.selectOption('#m2m-bitrate', '128');
  await edit('song.m4a');
  assert.match(await estimate(), new RegExp(`Its source is AAC at ${kb('song.m4a')} kbps, so this bitrate loses some of its detail\\.$`));
  await edit('memo.m4a');
  await page.click('#m2m-speech');
  assert.deepEqual([await page.inputValue('#m2m-bitrate'), await page.inputValue('#m2m-channels')], ['96', 'mono']);
  assert.equal(await lastLive(), 'Speech settings: MP3 at 96 kbps, mono.');
  await page.selectOption('#m2m-bitrate', 'auto');
  await page.selectOption('#m2m-channels', 'keep');
  assert.equal((await card('memo.m4a')).state, 'Ready, as MP3 at 96 kbps');

  // ---------- WAV: Apple Lossless sample for sample ----------
  await page.check('#m2m-f-wav');
  assert.equal(await text('#m2m-convert'), 'Convert 4 files to WAV');
  assert.match(await text('#m2m-format-hint'), / 24-bit Apple Lossless stays 24-bit, which takes 1\.5 times as much\.$/);
  await edit('alac24.m4a');
  assert.equal(await estimate(), `Estimated size: about ${Math.round((48000 * 3 + 44) / 1000)} KB as alac24.wav.`, '24-bit sound takes 3 bytes a sample');
  await convert();
  let w = verify('wav', (await fetchFile('alac16.m4a')).bytes, 'alac16.m4a');
  assert.deepEqual([w.stream.codec, w.fmt.bits, w.stream.rate, w.stream.channels], ['pcm_s16le', 16, 44100, 2]);
  assert.equal(w.vsSource.identical, true, 'alac16.wav holds exactly the samples ffmpeg decodes from the ALAC');
  assert.deepEqual(w.info, { INAM: 'Lossless sixteen', IART: 'Rip Artist', IPRD: 'Rip Album', ICRD: '2005', ITRK: '1' }, 'RIFF INFO tags');
  assert.deepEqual(w.id3.version, [3, 0]);
  assert.equal(w.id3.pictures[0].width, 600, 'the WAV gets the shrunk cover in its id3 chunk');
  w = verify('wav', (await fetchFile('alac24.m4a')).bytes, 'alac24.m4a');
  assert.deepEqual([w.stream.codec, w.fmt.bits, w.stream.rate, w.stream.channels, w.samples], ['pcm_s24le', 24, 48000, 1, 48000]);
  assert.equal(w.vsSource.identical, true, 'alac24.wav keeps all 24 bits, sample for sample');
  w = verify('wav', (await fetchFile('song.m4a')).bytes, 'song.m4a');
  assert.deepEqual([w.stream.codec, w.samples], ['pcm_s16le', exp['song.m4a'].samples], 'song.wav is as long as the edit list says');
  assert.ok(w.vsSource.maxDiff < 0.002, `song.wav matches ffmpeg's AAC decode within 0.002 (${w.vsSource.maxDiff})`);
  w = verify('wav', (await fetchFile('memo.m4a')).bytes);
  assert.deepEqual([w.stream.channels, w.samples, w.sound.freq[0]], [1, exp['memo.m4a'].samples, 300]);
  await page.check('#m2m-f-mp3');

  // ---------- Damaged, protected and unsupported files ----------
  await page.click('#m2m-clear');
  assert.equal(await lastLive(), 'All files removed.');
  const odd = ['alac51.m4a', 'alac32.m4a', 'alac-cut.m4a', 'fairplay.m4a', 'bought.m4p', 'audible.aax', 'not-audio.m4a', 'empty.m4a', 'picture.mp4', 'garbage.m4a', 'notags.m4a'];
  await page.setInputFiles('#m2m-file', odd.map(F));
  await waitRead();
  const fairplay = 'This file is copy-protected (Apple FairPlay DRM), so it cannot be converted. Apple Music downloads are protected this way, and so are iTunes Store songs bought before April 2009 and never upgraded to iTunes Plus.';
  const msgs = {
    'alac51.m4a': 'This Apple Lossless file has 6 channels, which this page cannot decode: it decodes Apple Lossless in mono or stereo.',
    'alac32.m4a': 'This Apple Lossless file holds 32-bit sound, which this page cannot decode: it decodes 16 and 24-bit Apple Lossless.',
    'alac-cut.m4a': `This file is incomplete, perhaps a copy or download that did not finish: it should hold 0:03.000 of sound, but its data stops at 0:0${(exp['alac-cut.m4a'].decoded / 44100).toFixed(3)}. That part can still be converted.`,
    'fairplay.m4a': fairplay, 'bought.m4p': fairplay,
    'audible.aax': 'This file is copy-protected (Audible DRM), so it cannot be converted. Audible audiobooks (.aa and .aax files) are protected this way.',
    'not-audio.m4a': 'This is not an audio file that this page can read. It reads M4A, MP3, WAV, FLAC, OGG and AAC files, and the sound of MP4, MOV, WebM, MKV and MPEG-TS videos.',
    'empty.m4a': 'This file is empty.',
    'picture.mp4': 'This video has no sound track, so there is no audio to save.',
    'notags.m4a': ''
  };
  for (const [name, msg] of Object.entries(msgs)) assert.equal((await card(name)).msg, msg, `the message for ${name}`);
  assert.equal(await lastLive(), 'Added 11 files, 9 of them cannot be converted to MP3 and 1 more has a warning: see the message under each.'.replace('9 of them', `${Object.values(msgs).filter(x => x && !/^This file is incomplete/.test(x)).length} of them`));
  assert.equal((await card('alac32.m4a')).info, `0:01.500 · Apple Lossless (ALAC) · 44.1 kHz · stereo · 32-bit · ${kb('alac16.m4a')} kbps`);
  await convert();
  // Every job ends: a result, or a message under the file.
  for (const name of odd) {
    const c = await card(name);
    assert.ok(c.download || c.msg, `${name} ends with a result or a message`);
  }
  m = verify('mp3', (await fetchFile('alac-cut.m4a')).bytes);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 320, samples: exp['alac-cut.m4a'].decoded, freq: [1000, 1500] }, 'alac-cut.mp3: the part that is there');
  m = verify('mp3', (await fetchFile('notags.m4a')).bytes);
  checkMp3(m, { rate: 44100, channels: 1, kbps: 96, samples: exp['notags.m4a'].samples, freq: [330] }, 'notags.mp3');
  assert.deepEqual(Object.keys(m.id3.frames), ['TIT2'], 'a file without tags gets its name as the title, and nothing else');
  assert.equal(frames(m, 'TIT2'), 'notags');
  const g = await card('garbage.m4a');
  if (g.download) {
    m = verify('mp3', (await fetchFile('garbage.m4a')).bytes);
    near(m.sound.samples, exp['song.m4a'].samples, 2048, 'garbage.mp3 keeps its length');
  } else {
    assert.match(g.msg, /could not be decoded|damaged/, 'garbage.m4a: the message says why');
  }

  // ---------- HE-AAC, an audiobook, raw AAC, FLAC, 96 kHz ALAC, and an MP3 and a video dropped here ----------
  await page.click('#m2m-clear');
  const HUB = name => '../mp4-to-mp3/' + name;
  await page.setInputFiles('#m2m-file', ['heaac.m4a', 'book.m4b', 'adts.aac', 'tags.flac', 'alac96.m4a', HUB('lame-cbr.mp3'), HUB('clip.mp4')].map(F));
  await waitRead();
  assert.deepEqual(await card('heaac.m4a'), { info: `0:03.000 · AAC · 48 kHz · stereo · ${kb('heaac.m4a')} kbps`, state: 'Ready, as MP3 at 192 kbps', msg: '', download: false });
  assert.deepEqual(await card('book.m4b'), { info: `0:12.000 · AAC · 22.05 kHz · mono · ${kb('book.m4b')} kbps`, state: 'Ready, as MP3 at 96 kbps', msg: '', download: false });
  assert.equal((await card('adts.aac')).state, 'Ready, as MP3 at 192 kbps');
  assert.deepEqual(await card('tags.flac'), { info: `0:00.500 · FLAC · 44.1 kHz · stereo · ${kb('tags.flac')} kbps`, state: 'Ready, as MP3 at 320 kbps', msg: '', download: false });
  // The MP4 sample entry of a 96 kHz ALAC says 0 Hz; its ALAC settings say 96 kHz.
  assert.deepEqual(await card('alac96.m4a'), { info: `0:00.400 · Apple Lossless (ALAC) · 96 kHz · stereo · 24-bit · ${kb('alac96.m4a')} kbps`, state: 'Ready, as MP3 at 320 kbps', msg: '', download: false });
  for (const name of ['lame-cbr.mp3', 'clip.mp4']) assert.equal((await card(name)).state, 'Ready, as MP3 at 192 kbps', `${name}: Automatic gives a 128 kbps source 192 kbps`);
  await convert();
  m = verify('mp3', (await fetchFile('heaac.m4a')).bytes);
  checkMp3(m, { rate: 48000, channels: 2, kbps: 192, samples: exp['heaac.m4a'].samples, freq: [440, 440] }, 'heaac.mp3 (decoded with SBR at 48 kHz)');
  m = verify('mp3', (await fetchFile('book.m4b')).bytes);
  checkMp3(m, { rate: 22050, channels: 1, kbps: 96, samples: exp['book.m4b'].samples, freq: [220] }, 'book.mp3 (MPEG-2 at 22.05 kHz)');
  assert.deepEqual(['TIT2', 'TPE1', 'TALB', 'TCON', 'TYER'].map(x => frames(m, x)), ['The Test Book', 'An Author', 'The Test Book', 'Audiobook', '2021']);
  m = verify('mp3', (await fetchFile('adts.aac')).bytes);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 192, samples: exp['adts.aac'].samples, freq: [550, 550] }, 'adts.mp3');
  m = verify('mp3', (await fetchFile('tags.flac')).bytes);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 320, samples: exp['tags.flac'].samples, freq: [770, 770] }, 'tags.mp3 from FLAC');
  assert.deepEqual(['TIT2', 'TCOM', 'TRCK', 'TPOS', 'TPE2'].map(x => frames(m, x)), [T.title, T.composer, '3/12', '1/2', T.album_artist], 'Vorbis comments become ID3 tags');
  m = verify('mp3', (await fetchFile('alac96.m4a')).bytes);
  checkMp3(m, { rate: 48000, channels: 2, kbps: 320, samples: exp['alac96.m4a'].samples / 2, freq: [1000, 1000] }, 'alac96.mp3 (resampled to 48 kHz)');
  for (const name of ['lame-cbr.mp3', 'clip.mp4']) {
    const sf = srcFacts(HUB(name));
    m = verify('mp3', (await fetchFile(name)).bytes);
    checkMp3(m, { rate: sf.rate, channels: sf.channels, kbps: 192, samples: sf.samples }, `${name.replace(/\.\w+$/, '.mp3')} from a neighbouring format`);
  }
  await page.check('#m2m-f-wav');
  await convert();
  w = verify('wav', (await fetchFile('alac96.m4a')).bytes, 'alac96.m4a');
  assert.deepEqual([w.stream.codec, w.stream.rate, w.stream.channels, w.vsSource.identical], ['pcm_s24le', 96000, 2, true], 'alac96.wav: 24-bit, 96 kHz, sample for sample');
  await page.check('#m2m-f-mp3');

  // ---------- A 10-hour audiobook: cancel, then a part from the middle ----------
  await page.click('#m2m-clear');
  const silence = Array.from(fs.readFileSync(F('silence.m4a')));
  await page.evaluate(buildBook, silence);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([window.__bookBlob], 'long-book.m4b'));
    const input = document.getElementById('m2m-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitRead();
  const book = await card('long-book.m4b');
  assert.match(book.info, /^10:00:00\.000 · AAC · 48 kHz · mono · \d+ kbps$/);
  assert.equal(book.state, 'Ready, as MP3 at 96 kbps');
  assert.equal(await estimate(), `Estimated size: about ${((96 * 125 * 36000 + 300) / 1e6).toFixed(1)} MB as long-book.mp3. Automatic: 96 kbps for its source, mono AAC at ${(/(\d+) kbps$/.exec(book.info) || [])[1]} kbps.`);
  await page.click('#m2m-convert');
  await page.waitForFunction(() => document.getElementById('m2m-bar').value > 0, null, { timeout: 30000 });
  await page.click('#m2m-cancel');
  await waitIdle();
  assert.equal(await lastLive(), 'Conversion cancelled.');
  assert.deepEqual(await card('long-book.m4b'), { info: book.info, state: 'Ready, as MP3 at 96 kbps', msg: '', download: false }, 'no result after Cancel');
  // The trim editor, folded away, opens; a part from 7.5 hours in.
  await page.click('#m2m-trim summary');
  await typeInto('#m2m-start', '7:30:00');
  await typeInto('#m2m-end', '7:30:03,5');
  assert.equal(await text('#m2m-len'), '0:03.500', 'a decimal comma in a time');
  assert.equal((await card('long-book.m4b')).state, 'Ready, from 7:30:00.000 to 7:30:03.500, as MP3 at 96 kbps');
  await convert();
  m = verify('mp3', (await fetchFile('long-book.m4b')).bytes);
  checkMp3(m, { rate: 48000, channels: 1, kbps: 96, samples: 168000 }, 'a 3.5 s part of the 10-hour book');
  assert.ok(m.sound.peak < 0.001, 'the part is the book\'s silence');
  await row('long-book.m4b').locator('.m2m-remove').click();
  assert.equal(await lastLive(), 'Removed long-book.m4b.');

  // ---------- Fields the browser restores after the script ran ----------
  await page.evaluate(() => {
    document.getElementById('m2m-f-wav').checked = true;
    document.getElementById('m2m-bitrate').value = '320';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await text('#m2m-convert'), 'Convert to WAV', 'restored fields are read again on pageshow');
  await page.check('#m2m-f-mp3');
  assert.match(await text('#m2m-format-hint'), /^MP3 at 320 kbps/);
  await page.selectOption('#m2m-bitrate', 'auto');

  // ---------- Without WebCodecs audio (Firefox for Android, Safari 16.4 to 18) ----------
  const old = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const op = await old.newPage();
  watch(op);
  await op.addInitScript(instrument);
  await op.addInitScript(() => { delete window.AudioDecoder; delete window.AudioEncoder; delete window.AudioData; delete window.EncodedAudioChunk; });
  await op.goto(url);
  assert.equal(await op.evaluate(() => typeof AudioDecoder), 'undefined');
  await op.setInputFiles('#m2m-file', ['song.m4a', 'alac24.m4a'].map(F));
  await waitRead(op);
  assert.equal((await card('song.m4a', op)).state, 'Ready, as MP3 at 256 kbps');
  assert.equal((await card('alac24.m4a', op)).state, 'Ready, as MP3 at 320 kbps', 'Apple Lossless needs no WebCodecs');
  await convert(op);
  m = verify('mp3', (await fetchFile('song.m4a', op)).bytes);
  checkMp3(m, { rate: 44100, channels: 2, kbps: 256, samples: exp['song.m4a'].samples, freq: [440, 660], rms: [0.5 / Math.SQRT2, 0.25 / Math.SQRT2] }, 'song.mp3 decoded whole');
  assert.equal(m.id3.pictures[0].sha256, jpg.sha256);
  await op.check('#m2m-f-wav');
  await convert(op);
  w = verify('wav', (await fetchFile('alac24.m4a', op)).bytes, 'alac24.m4a');
  assert.equal(w.vsSource.identical, true, 'alac24.wav without WebCodecs, sample for sample');
  await old.close();

  // ---------- A phone: limits on memory, touch ----------
  const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE', acceptDownloads: true });
  const pp = await phone.newPage();
  watch(pp);
  await pp.addInitScript(instrument);
  await pp.goto(url);
  await pp.evaluate(buildBook, silence);
  // alac-fs.m4a with megabytes of data after its sound: its index comes
  // first, so the mdat box grows and every chunk offset stays right.
  await pp.evaluate(fs8 => {
    window.__padAlac = (name, pad) => {
      const head = new Uint8Array(fs8);
      const dv = new DataView(head.buffer);
      let p = 0;
      while (p + 8 <= head.length && String.fromCharCode(head[p + 4], head[p + 5], head[p + 6], head[p + 7]) !== 'mdat') p += dv.getUint32(p);
      dv.setUint32(p, dv.getUint32(p) + pad);
      const mb = new Uint8Array(1 << 20);
      const parts = [head];
      for (let i = 0; i < pad >> 20; i++) parts.push(mb);
      return new File(parts, name);
    };
    window.__bigAlac = window.__padAlac('big-rip.m4a', 350 << 20);
  }, Array.from(fs.readFileSync(F('alac-fs.m4a'))));
  await pp.setInputFiles('#m2m-file', [F('memo.m4a')]);
  await waitRead(pp);
  const readBefore = await pp.evaluate(() => window.__read);
  await pp.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__bigAlac);
    dt.items.add(new File([window.__bookBlob], 'long-book.m4b'));
    const input = document.getElementById('m2m-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitRead(pp);
  const bigSize = (fs.statSync(F('alac-fs.m4a')).size + (350 << 20)) / 1e6;
  assert.equal((await card('big-rip.m4a', pp)).msg, `This Apple Lossless file is ${bigSize.toFixed(1)} MB. This page decodes Apple Lossless files of up to 300.0 MB on this device, as the whole file is held in memory while it is decoded.`);
  const readNow = await pp.evaluate(() => window.__read);
  assert.ok(readNow - readBefore < 8e6, `only the index of the 350 MB file is read (${readNow - readBefore} bytes)`);
  // Buttons a finger can hit.
  for (const sel of ['#m2m-open', '#m2m-sample', '#m2m-convert', '#m2m-speech', '#m2m-bitrate', '#m2m-channels', '.m2m-file .m2m-edit >> nth=0', '.m2m-file .m2m-remove >> nth=0']) {
    const box = await pp.locator(sel).boundingBox();
    assert.ok(box && box.height >= 44, `${sel} is at least 44 px tall on a phone (${box && box.height})`);
  }
  await pp.tap('#m2m-convert');
  await waitIdle(pp);
  assert.equal((await card('long-book.m4b', pp)).msg, `As MP3 this would be about ${((96 * 125 * 36000 + 300) / 1e6).toFixed(1)} MB, more than the 300.0 MB this device can build in memory. Choose a lower bitrate, mono or a shorter selection.`);
  m = verify('mp3', (await download(() => row('memo.m4a', pp).locator('.m2m-dl').tap(), pp)).bytes);
  checkMp3(m, { rate: 48000, channels: 1, kbps: 96, samples: exp['memo.m4a'].samples, freq: [300] }, 'memo.mp3 on a phone');
  // A tap on the waveform moves the nearer handle (the trim editor unfolded).
  await pp.tap('#m2m-trim summary');
  await pp.locator('#m2m-trackbox').scrollIntoViewIfNeeded();
  await pp.waitForFunction(() => document.getElementById('m2m-wave-msg').textContent === '', null, { timeout: 20000 });
  const tb = await pp.locator('#m2m-trackbox').boundingBox();
  await pp.touchscreen.tap(tb.x + tb.width * 0.75, tb.y + tb.height / 2);
  near(+(await pp.getAttribute('#m2m-h-end', 'aria-valuenow')), 4.5, 0.05, 'a tap at three quarters of the 6 s memo moves the end to 4.5 s');
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no sideways scroll on a phone (${overflow}px)`);
  // Two Apple Lossless files of 160 MB: together more than the 300 MB a
  // phone's decoders hold, so one decoder closes before the next opens, and
  // a file's decoder opens again when it is needed again.
  await pp.tap('#m2m-clear');
  await pp.evaluate(() => {
    window.__alac = { made: 0, ended: 0, most: 0 };
    const dt = new DataTransfer();
    dt.items.add(window.__padAlac('side-a.m4a', 160 << 20));
    dt.items.add(window.__padAlac('side-b.m4a', 160 << 20));
    const input = document.getElementById('m2m-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitRead(pp);
  for (const name of ['side-a.m4a', 'side-b.m4a']) {
    assert.deepEqual(await card(name, pp), { info: `0:00.500 · Apple Lossless (ALAC) · 44.1 kHz · stereo · 16-bit · ${kb('alac-fs.m4a')} kbps`, state: 'Ready, as MP3 at 320 kbps', msg: '', download: false });
  }
  await pp.waitForFunction(() => document.getElementById('m2m-wave-msg').textContent === '', null, { timeout: 30000 });
  await pp.tap('#m2m-convert');
  await waitIdle(pp);
  for (const name of ['side-a.m4a', 'side-b.m4a']) {
    m = verify('mp3', (await download(() => row(name, pp).locator('.m2m-dl').tap(), pp)).bytes);
    checkMp3(m, { rate: 44100, channels: 2, kbps: 320, samples: exp['alac-fs.m4a'].samples, freq: [1000, 1500] }, `${name} on a phone`);
  }
  await pp.tap('#m2m-f-wav');
  await pp.tap('#m2m-convert');
  await waitIdle(pp);
  for (const name of ['side-a.m4a', 'side-b.m4a']) {
    w = verify('wav', (await download(() => row(name, pp).locator('.m2m-dl').tap(), pp)).bytes, 'alac-fs.m4a');
    assert.equal(w.vsSource.identical, true, `${name}: the WAV after its decoder was opened again, sample for sample`);
  }
  const workers = await pp.evaluate(() => window.__alac);
  assert.equal(workers.most, 1, 'never two 160 MB decoders at once on a phone');
  assert.ok(workers.made >= 3, `decoders opened again when needed (${workers.made})`);
  await phone.close();

  assert.deepEqual(problems, []);
}

// Runs in the page: a 10-hour audiobook (AAC 48 kHz mono) made of 1,687,500
// copies of one 4-byte packet of silence.m4a, with an index written here;
// sets window.__bookBlob.
function buildBook(bytes) {
  const src = new Uint8Array(bytes);
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
  const stbl = find(0, src.length, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const stsd = find(stbl[0] + 8, stbl[1], ['stsd']);
  const stsz = find(stbl[0] + 8, stbl[1], ['stsz']);
  const stco = find(stbl[0] + 8, stbl[1], ['stco']);
  const size = dv.getUint32(stsz[0] + 12);
  if (size !== 4) throw new Error('silence.m4a: packets of ' + size + ' bytes');
  // The tenth packet: AAC packets do not depend on each other.
  const at = dv.getUint32(stco[0] + 16) + 9 * size;
  const packet = src.slice(at, at + size);
  const N = 1687500;
  const u32 = v => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255];
  const str = s => Array.from(s, c => c.charCodeAt(0));
  const box = (t, ...parts) => {
    const body = parts.flat();
    return [...u32(8 + body.length), ...str(t), ...body];
  };
  const full = (t, ...parts) => box(t, 0, 0, 0, 0, ...parts);
  const matrix = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0];
  const seconds = N * 1024 / 48000;
  const build = dataAt => {
    const mvhd = full('mvhd', u32(0), u32(0), u32(1000), u32(seconds * 1000), u32(0x10000), [1, 0], new Array(10).fill(0), matrix, new Array(24).fill(0), u32(2));
    const tkhd = box('tkhd', 0, 0, 0, 7, u32(0), u32(0), u32(1), u32(0), u32(seconds * 1000), new Array(8).fill(0), [0, 0, 0, 0, 1, 0, 0, 0], matrix, u32(0), u32(0));
    const mdhd = full('mdhd', u32(0), u32(0), u32(48000), u32(N * 1024), [0x55, 0xc4, 0, 0]);
    const hdlr = full('hdlr', u32(0), str('soun'), new Array(12).fill(0), str('SoundHandler'), 0);
    const dinf = box('dinf', full('dref', u32(1), box('url ', 0, 0, 0, 1)));
    const stblBox = box('stbl', Array.from(src.subarray(stsd[0], stsd[1])), full('stts', u32(1), u32(N), u32(1024)),
      full('stsc', u32(1), u32(1), u32(N), u32(1)), full('stsz', u32(4), u32(N)), full('stco', u32(1), u32(dataAt)));
    const minf = box('minf', full('smhd', 0, 0, 0, 0), dinf, stblBox);
    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
  };
  const ftyp = box('ftyp', str('M4B '), u32(0), str('M4B '), str('M4A '), str('isom'));
  let moov = build(0);
  moov = build(ftyp.length + moov.length + 8);
  const data = new Uint8Array(N * size);
  for (let i = 0; i < N; i++) data.set(packet, i * size);
  window.__bookBlob = new Blob([new Uint8Array(ftyp), new Uint8Array(moov), new Uint8Array([...u32(8 + data.length), ...str('mdat')]), data]);
}
