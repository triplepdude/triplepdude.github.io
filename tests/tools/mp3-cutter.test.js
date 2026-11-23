'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { devices } = require('playwright');

// The samples come from tests/fixtures/mp3-cutter/make_fixtures.py (ffmpeg,
// numpy, mutagen, Pillow), which also writes expected.json: sample counts as
// ffmpeg decodes each file (honouring its LAME tag), rates, channels and the
// covers' SHA-256. Every file the page saves is checked by
// tests/fixtures/mp3-cutter/verify.py, which shares no code with the page:
// an exact copy must decode, in ffmpeg, to exactly the samples ffmpeg decodes
// from the whole file between the start and the end, bit for bit; its LAME
// tag (delay, padding, CRCs) is read by a reader written there, its tags by
// mutagen; re-encoded files are checked for their length, line-up and
// signal-to-noise ratio against the source, joins against a crossfade worked
// out in numpy, M4A files for their AAC stream and MP4 edit list, and ZIPs
// for their entries. Long files (an hour of MP3, a WAV over 4 GB) are built
// in the page from repeated parts of the samples.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-cutter-'));
  try {
    await run({ page, open, assert, fixtures, url, tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

async function run({ page, open, assert, fixtures, url, tmp }) {
  for (const [cmd, args] of [['ffprobe', ['-version']], ['ffmpeg', ['-version']], ['python3', ['-c', 'import numpy, mutagen']]]) {
    try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch (e) {
      throw new Error(`tests/tools/mp3-cutter.test.js checks every file with ffmpeg, ffprobe and python3 with numpy and mutagen: ${cmd} ${args.join(' ')} failed`);
    }
  }
  const F = name => path.join(fixtures, name);
  const exp = JSON.parse(fs.readFileSync(F('expected.json'), 'utf8'));
  const T = exp.tags;
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b} ± ${tol}`);
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  let saved = 0;
  // verify.py on bytes the page saved: kind 'facts', 'cut' or 'join', with its arguments.
  const verify = (kind, bytes, ...args) => {
    const p = path.join(tmp, `${++saved}-${kind}`);
    fs.writeFileSync(p, bytes);
    return JSON.parse(execFileSync('python3', [F('verify.py'), kind, p, ...args.map(String)], { maxBuffer: 64 << 20 }).toString());
  };
  const browser = page.context().browser();

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
    // Scripts loaded, scheduled preview buffers, gain automation, the wake lock, Safari's audio session.
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
    window.__session = [];
    let sessionType = 'auto';
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: {
      get type() { return sessionType; }, set type(v) { sessionType = v; window.__session.push(v); }
    } });
  };
  await page.addInitScript(instrument);
  const requested = [];
  page.on('request', r => requested.push(r.url()));
  let gotChooser;
  let chooserReady = new Promise(r => { gotChooser = r; });
  page.on('filechooser', fc => { gotChooser(fc); });
  await open();

  // ---------- helpers ----------
  const text = (sel, p = page) => p.locator(sel).textContent();
  const val = (sel, p = page) => p.locator(sel).inputValue();
  const typeInto = async (sel, value, p = page) => {
    await p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  const live = (p = page) => p.evaluate(() => window.__live.slice());
  const fieldState = async (sel, p = page) => ({
    invalid: await p.getAttribute(sel, 'aria-invalid'),
    describedby: (await p.getAttribute(sel, 'aria-describedby') || '').split(' ')
  });
  // Opens a file the way the page is given one (the file input), and waits
  // until it is open (or refused) and its waveform is read.
  const openFile = async (name, p = page, waitWave = true) => {
    await p.setInputFiles('#mc-file', typeof name === 'string' ? F(name) : name);
    const base = typeof name === 'string' ? name : name.name;
    await p.waitForFunction(b => (document.getElementById('mc-name').textContent === b && !document.getElementById('mc-edit').hidden) ||
      document.getElementById('mc-file-error').textContent.indexOf(b) >= 0, base, { timeout: 30000 });
    if (waitWave && !(await p.locator('#mc-file-error').textContent())) await waitWaveDone(p);
  };
  const waitWaveDone = (p = page) => p.waitForFunction(() => {
    const m = document.getElementById('mc-wave-msg').textContent;
    return m === '' || m.indexOf('No waveform') === 0;
  }, null, { timeout: 60000 });
  const setTimes = async (start, end, p = page) => {
    await typeInto('#mc-end', end, p);
    await typeInto('#mc-start', start, p);
    await typeInto('#mc-end', end, p);
  };
  const results = (p = page) => p.$$eval('#mc-results .mc-result', ls => ls.map(l => ({ name: l.querySelector('b').textContent, text: l.querySelector('span').textContent })));
  const cut = async (p = page) => {
    await p.click('#mc-save');
    await p.waitForFunction(() => !document.getElementById('mc-results').hidden || document.getElementById('mc-error').textContent, null, { timeout: 120000 });
    const err = await p.locator('#mc-error').textContent();
    assert.equal(err, '', 'no error after Cut');
    return results(p);
  };
  const download = async (action, p = page) => {
    const caller = (new Error().stack.split('\n')[2] || '').trim();
    try {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), action()]);
      return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
    } catch (e) {
      throw new Error(`${String(e.message).split('\n')[0]} (download ${caller})`);
    }
  };
  const fetchResult = (i = 0, p = page) => download(() => p.locator('#mc-results .mc-result button').nth(i).click(), p);
  // Samples (per channel) a time in ms is, as the page counts them.
  const smp = (ms, rate) => Math.round(ms * rate / 1000);
  const checkExact = (got, src, startMs, endMs, what, clean) => {
    const e = exp[src], a = smp(startMs, e.rate), b = smp(endMs, e.rate);
    const v = verify('cut', got.bytes, F(src), a, b, ...(clean ? [clean] : []));
    assert.equal(v.codec, 'mp3', `${what}: MP3`);
    assert.equal(v.samples, b - a, `${what}: ffmpeg decodes exactly the ${b - a} samples selected`);
    assert.equal(v.vs.diff, 0, `${what}: bit for bit the samples of the whole file, ${a} to ${b}`);
    assert.ok(v.lame && v.lame.crc_ok && v.lame.music_crc_ok && v.lame.bytes_ok, `${what}: LAME tag with good CRCs: ${JSON.stringify(v.lame)}`);
    assert.ok(v.lame.delay <= 4095 && v.lame.padding <= 4095, `${what}: delay and padding fit the LAME tag`);
    assert.equal(v.rate, e.rate, `${what}: rate`);
    assert.equal(v.channels, e.channels, `${what}: channels`);
    return v;
  };
  const cpu = async (p = page) => {
    const c = await p.context().newCDPSession(p);
    await c.send('Performance.enable');
    const m = (await c.send('Performance.getMetrics')).metrics.find(x => x.name === 'ThreadTime');
    await c.detach();
    return m ? m.value : 0;
  };

  // ---------- The page as it opens ----------
  assert.equal(await text('h1'), 'MP3 Cutter: Trim Audio and Make Ringtones');
  assert.equal(await page.isVisible('#mc-edit'), false, 'no editor before a file is chosen');
  assert.equal(await page.isDisabled('#mc-save'), true, 'Cut waits for a file');
  assert.equal(await text('#mc-save'), 'Cut');
  assert.equal(await page.isChecked('#mc-f-mp3'), true, 'MP3 to begin with');
  assert.equal(await page.isChecked('#mc-m-keep'), true, 'keeping the selection to begin with');
  assert.equal(await page.isChecked('#mc-exact'), true, 'exact copy to begin with');
  assert.match(await text('#mc-drop-hint'), /MP3 files are cut without re-encoding/);
  assert.equal(requested.filter(u => /mediabunny|audio-engine-data/.test(u)).length, 0, 'mediabunny is loaded only when a file is added');

  // ---------- An MP3 opened from the keyboard, cut exactly ----------
  await page.focus('#mc-open');
  await page.keyboard.press('Enter');
  const chooser = await chooserReady;
  await chooser.setFiles(F('song.mp3'));
  await page.waitForFunction(() => document.getElementById('mc-name').textContent === 'song.mp3', null, { timeout: 30000 });
  await waitWaveDone();
  assert.equal(await text('#mc-info'), `MP3 · 128 kbps · stereo · 44.1 kHz · 0:08.000 · ${(exp['song.mp3'].size / 1000).toFixed(0)} KB · gapless (LAME tag)`);
  assert.equal(await val('#mc-start'), '0:00.000');
  assert.equal(await val('#mc-end'), '0:08.000');
  assert.equal(await text('#mc-len'), '0:08.000');
  assert.equal(await val('#mc-title'), T.title, 'the title is read from the ID3v2.3 tag');
  assert.equal(await val('#mc-artist'), T.artist);
  assert.equal(await val('#mc-album'), T.album);
  assert.equal(await val('#mc-kbps'), '128', 're-encoding starts at the file\'s own bitrate');
  assert.equal(await page.isVisible('#mc-kbps-field'), false, 'no bitrate for an exact copy');
  assert.match(await text('#mc-estimate'), /^Copied without re-encoding: about 1\d\d KB\.$/);
  assert.match(await text('#mc-exact-note'), /exact to the sample in players that read its LAME tag/);
  assert.ok((await live()).some(t => /^song\.mp3 is open: MP3 · 128 kbps/.test(t)), 'the opened file is announced by name');
  assert.ok(requested.some(u => /mediabunny\.min\.js/.test(u)), 'mediabunny was loaded for the file');
  assert.equal(requested.filter(u => /aac-encoder/.test(u)).length, 0, 'the AAC encoder is not loaded for an MP3 cut');

  // Times typed with a decimal comma and with a dot, then Cut and Download from the keyboard.
  await page.focus('#mc-start');
  await typeInto('#mc-start', '1,5');
  await typeInto('#mc-end', '0:04.25');
  assert.equal(await text('#mc-len'), '0:02.750');
  assert.equal(await page.getAttribute('#mc-h-start', 'aria-valuetext'), '0:01.500, selection 0:02.750 long');
  const cpu0 = await cpu();
  await page.focus('#mc-save');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('mc-results').hidden, null, { timeout: 30000 });
  const cutCpu = await cpu() - cpu0;
  assert.ok(cutCpu < 1.5, `an exact cut of 8 s takes little main-thread time (${cutCpu.toFixed(2)} s)`);
  let res = await results();
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'song (cut).mp3');
  assert.match(res[0].text, /^0:02\.750 · \d\d(\.\d)? KB · exact copy, nothing re-encoded \(players that ignore the LAME tag also play (\d+) ms before and (\d+) ms after\)$/);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Download', 'the Download button takes the focus');
  assert.ok((await live()).some(t => t.indexOf('song (cut).mp3 is ready: 0:02.750') === 0), 'the result is announced');
  const songCut = await download(() => page.keyboard.press('Enter'));
  assert.equal(songCut.name, 'song (cut).mp3');
  let v = checkExact(songCut, 'song.mp3', 1500, 4250, 'song (cut).mp3');
  // What the page says players without the tag play, from the tag itself.
  const m = /play (\d+) ms before and (\d+) ms after/.exec(res[0].text);
  assert.equal(+m[1], Math.round((v.lame.delay + 529) / 44.1), 'the time before is the delay of the LAME tag and the decoder');
  assert.equal(+m[2], Math.round((v.lame.padding - 529) / 44.1), 'the time after is the padding less the decoder delay');
  assert.ok(+m[1] >= 50 && +m[1] <= 105, `at 128 kbps a twentieth to a tenth of a second before (${m[1]} ms)`);
  // Every tag kept, as ID3v2.3 (UTF-16 where the text needs it) and ID3v1.
  assert.equal(v.id3.version, 3, 'ID3v2.3');
  const fr = v.id3.frames;
  assert.equal(fr.TIT2, T.title);
  assert.equal(fr.TPE1, T.artist);
  assert.equal(fr.TALB, T.album);
  assert.equal(fr.TPE2, T.albumartist);
  assert.equal(fr.TCOM, T.composer);
  assert.equal(fr.TYER, '2019', 'a year-only date stays a year');
  assert.equal(fr.TRCK, '3/12');
  assert.equal(fr.TPOS, '1/2');
  assert.equal(fr.TCON, 'Pop');
  assert.equal(fr.COMM, T.comment);
  assert.equal(fr.USLT, T.lyrics);
  assert.equal(fr.APIC.sha256, exp['song.mp3'].cover_sha256, 'the cover, byte for byte');
  assert.equal(fr.APIC.mime, 'image/jpeg');
  assert.deepEqual(v.id3.encodings, [0, 1], 'ISO-8859-1 where the text fits, UTF-16 where it does not');
  assert.equal(v.id3v1.title, 'Café', 'ID3v1 cut at the first letter it cannot hold');
  assert.equal(v.id3v1.track, 3);
  assert.equal(songCut.bytes.subarray(0, 3).toString(), 'ID3', 'the ID3v2 tag comes first');

  // ---------- Exact cuts of every kind of MP3 ----------
  // Times off the frame grid. At 64 and 32 kbps the frames reach further back
  // into the bit reservoir than the LAME tag's delay can skip, MPEG-2 and 2.5
  // frames hold 576 samples, files without a LAME tag count every decoded
  // sample, CRC frames carry two more bytes, and junk.mp3 has junk before and
  // between its frames (ffmpeg decodes its frames without the junk).
  const secs = ms => (ms / 1000).toFixed(3);
  for (const [name, a, b, clean] of [
    ['vbr.mp3', 333, 4777], ['mono64.mp3', 1234, 9876], ['low32.mp3', 2021, 7013], ['mpeg2.mp3', 501, 6502], ['mpeg25.mp3', 777, 5333],
    ['notag.mp3', 250, 3100], ['crc.mp3', 400, 1700], ['vbri.mp3', 1111, 5222], ['junk.mp3', 300, 1900, exp.junk_clean]
  ]) {
    await openFile(name);
    assert.equal(await page.isChecked('#mc-exact'), true, `${name}: exact copy is still chosen`);
    await setTimes(secs(a), secs(b));
    const r = await cut();
    assert.match(r[0].text, /exact copy, nothing re-encoded/, `${name}: copied`);
    const got = await fetchResult();
    v = checkExact(got, name, a, b, name, clean);
    if (name === 'notag.mp3') assert.match(await text('#mc-info'), /· no LAME tag$/);
    if (name === 'junk.mp3') {
      assert.equal(v.after_frames, 128, 'junk.mp3: after the frames only the new ID3v1 tag (no junk, no APE tag)');
      assert.equal(v.id3v1.title, 'Junk test!', 'junk.mp3: its title kept');
    }
  }
  // The length the page shows is the frames', with or without a LAME tag.
  await openFile('notag.mp3');
  assert.equal(await val('#mc-end'), '0:04.049', 'notag.mp3: every decoded sample, 178,560 at 44.1 kHz');

  // ---------- Tags of every ID3 version, a PNG cover, and tags typed in ----------
  await openFile('tags24.mp3');
  assert.equal(await val('#mc-title'), 'Ünïcode v2.4 ✓');
  await setTimes('0.5', '1.5');
  await cut();
  v = checkExact(await fetchResult(), 'tags24.mp3', 500, 1500, 'tags24 cut');
  assert.equal(v.id3.version, 3, 'an ID3v2.4 tag is written as v2.3');
  assert.equal(v.id3.frames.TIT2, 'Ünïcode v2.4 ✓');
  assert.equal(v.id3.frames.TYER, '2019', 'the year of a full date');
  assert.equal(v.id3.frames.TDAT, '0305', 'and its day and month, as v2.3 writes them');
  assert.equal(v.id3.frames.TRCK, '7');
  await openFile('tags22.mp3');
  assert.equal(await val('#mc-title'), 'Ôld Title');
  await cut();
  v = checkExact(await fetchResult(), 'tags22.mp3', 0, 2000, 'tags22 cut');
  assert.deepEqual([v.id3.version, v.id3.frames.TIT2, v.id3.frames.TPE1, v.id3.frames.TALB, v.id3.frames.TYER, v.id3.frames.TRCK],
    [3, 'Ôld Title', 'Old Artist', 'Old Album', '1999', '5/9'], 'ID3v2.2 tags carried over as v2.3');
  await openFile('pngcover.mp3');
  await typeInto('#mc-title', 'Typed títle 🎧');
  await typeInto('#mc-artist', '');
  await cut();
  v = checkExact(await fetchResult(), 'pngcover.mp3', 0, 1000, 'pngcover cut');
  assert.equal(v.id3.frames.TIT2, 'Typed títle 🎧', 'the title typed in is written');
  assert.equal(v.id3.frames.TPE1, undefined, 'an emptied field writes no tag');
  assert.equal(v.id3.frames.APIC.sha256, exp['pngcover.mp3'].cover_sha256, 'a 150 KB PNG cover kept byte for byte');
  assert.equal(v.id3.frames.APIC.mime, 'image/png');
  // A long paste into a tag field is cut to its 200 characters at once.
  await typeInto('#mc-title', 'x'.repeat(1000000));
  assert.equal((await val('#mc-title')).length, 200);

  // ---------- Markers from the keyboard, split into parts and a ZIP ----------
  await openFile('song.mp3');
  await page.focus('#mc-cursor');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await text('#mc-pos'), '0:02.000', 'the playhead moves 1 s with Shift+→');
  await page.keyboard.press('m');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('M');
  assert.deepEqual(await page.$$eval('.mc-mark', ms => ms.map(m => [m.getAttribute('aria-label'), m.getAttribute('aria-valuetext')])),
    [['Marker 1', '0:02.000'], ['Marker 2', '0:05.100']]);
  assert.ok((await live()).includes('Marker 2 added at 0:05.100.'), 'a new marker is announced');
  // A marker moves with the arrow keys and goes with Delete.
  await page.focus('.mc-mark >> nth=1');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getAttribute('.mc-mark >> nth=1', 'aria-valuetext'), '0:05.000');
  await page.check('#mc-m-split');
  assert.equal(await text('#mc-save'), 'Cut into 3 parts');
  assert.deepEqual(await page.$$eval('#mc-parts tbody tr', rs => rs.map(r => [...r.cells].slice(0, 4).map(c => c.textContent))),
    [['1', '0:00.000', '0:02.000', '0:02.000'], ['2', '0:02.000', '0:05.000', '0:03.000'], ['3', '0:05.000', '0:08.000', '0:03.000']]);
  assert.equal(await page.getAttribute('#mc-parts tbody tr:nth-child(2) button', 'aria-label'), 'Remove marker 1 at 0:02.000');
  assert.equal(await text('#mc-parts tbody tr:nth-child(2) button'), 'Remove', 'its name starts with what it shows');
  res = await cut();
  assert.deepEqual(res.map(r => r.name), ['song (part 1).mp3', 'song (part 2).mp3', 'song (part 3).mp3']);
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(await fetchResult(i));
  [[0, 2000], [2000, 5000], [5000, 8000]].forEach(([a, b], i) => {
    const pv = checkExact(parts[i], 'song.mp3', a, b, `part ${i + 1}`);
    assert.equal(pv.id3.frames.TIT2, T.title + ` (part ${i + 1})`, `part ${i + 1}: "(part ${i + 1})" after the title`);
    assert.equal(pv.id3.frames.APIC.sha256, exp['song.mp3'].cover_sha256, `part ${i + 1}: the cover`);
  });
  const zip = await download(() => page.click('#mc-zip'));
  assert.equal(zip.name, 'song (parts).zip');
  const z = verify('zip', zip.bytes);
  assert.deepEqual(z.names, ['song (part 1).mp3', 'song (part 2).mp3', 'song (part 3).mp3']);
  assert.deepEqual(z.sha256, parts.map(p => sha(p.bytes)), 'the ZIP holds the very files offered one by one');
  assert.ok(z.utf8 && z.stored, 'UTF-8 names, stored');
  // A marker removed from the table: two parts.
  await page.click('#mc-parts tbody tr:nth-child(2) button');
  assert.equal(await text('#mc-save'), 'Cut into 2 parts');
  assert.equal(await page.isVisible('#mc-results'), false, 'a change takes the old results away');
  // Markers every 3 seconds; a wrong interval is refused with its message.
  await typeInto('#mc-every', '1:75');
  await page.click('#mc-every-add');
  assert.match(await text('#mc-every-error'), /go up to 59/);
  assert.equal((await fieldState('#mc-every')).invalid, 'true');
  assert.ok((await fieldState('#mc-every')).describedby.includes('mc-every-error'));
  await typeInto('#mc-every', '0:03');
  assert.equal(await text('#mc-every-error'), '', 'typing again takes the message away');
  assert.equal(await page.getAttribute('#mc-every', 'aria-invalid'), null);
  await page.click('#mc-every-add');
  assert.deepEqual(await page.$$eval('.mc-mark', ms => ms.map(m => m.getAttribute('aria-valuetext'))), ['0:03.000', '0:05.000', '0:06.000']);
  assert.equal(await text('#mc-save'), 'Cut into 4 parts');
  // Markers outside the selection are left out.
  await setTimes('0:01', '0:05.5');
  assert.deepEqual(await page.$$eval('#mc-parts tbody tr', rs => rs.map(r => r.cells[1].textContent + '-' + r.cells[2].textContent)),
    ['0:01.000-0:03.000', '0:03.000-0:05.000', '0:05.000-0:05.500']);
  await page.click('#mc-clear-marks');
  assert.equal(await page.locator('.mc-mark').count(), 0);
  assert.equal(await text('#mc-save'), 'Cut');

  // ---------- Cutting out the middle: a crossfaded join ----------
  await page.check('#mc-m-remove');
  await setTimes('2', '3');
  assert.equal(await text('#mc-save'), 'Cut out the selection');
  assert.equal(await text('#mc-exact-note'), 'Cutting out a part joins what is left, which needs re-encoding: this file is re-encoded as MP3 at 128 kbps.');
  assert.equal(await page.isVisible('#mc-join-row'), true);
  assert.equal(await text('#mc-play-sel'), 'Play the join');
  await page.check('#mc-f-wav');
  res = await cut();
  assert.equal(res[0].name, 'song (edited).wav');
  let w = verify('join', (await fetchResult()).bytes, F('song.mp3'), 0, 88200, 132300, 352800, 882);
  assert.equal(w.samples, 352800 - 44100, 'what is left is exactly 7 s long: the crossfade takes nothing away');
  assert.ok(w.vs.diff <= 1.5 / 32768, `the join is a 20 ms linear crossfade centred on it, to the 16-bit step (${w.vs.diff})`);
  await page.uncheck('#mc-join');
  await cut();
  w = verify('join', (await fetchResult()).bytes, F('song.mp3'), 0, 88200, 132300, 352800, 0);
  assert.ok(w.samples === 308700 && w.vs.diff <= 1.5 / 32768, `without the crossfade the parts are butted together (${w.vs.diff})`);
  await page.check('#mc-join');
  await page.check('#mc-f-mp3');
  res = await cut();
  assert.match(res[0].text, /^0:07\.000 · \d+ KB · MP3 at 128 kbps$/);
  w = verify('join', (await fetchResult()).bytes, F('song.mp3'), 0, 88200, 132300, 352800, 882);
  assert.equal(w.samples, 308700, 'the re-encoded MP3 is gapless: exactly 7 s in ffmpeg');
  assert.equal(w.vs.lag, 0, 'and lines up with the source to the sample');
  assert.ok(w.vs.snr > 12, `and sounds like it (SNR ${w.vs.snr.toFixed(1)} dB at 128 kbps)`);
  // Cutting out the very start leaves one part, which is copied exactly.
  await setTimes('0', '1.25');
  assert.equal(await text('#mc-exact-note'), 'The cut is exact to the sample in players that read its LAME tag. Players that ignore the tag also play a few hundredths of a second before the start and after the end.');
  await cut();
  checkExact(await fetchResult(), 'song.mp3', 1250, 8000, 'the start cut off');
  // Nothing left to save when the selection is the whole file.
  await page.click('#mc-all');
  assert.equal(await page.isDisabled('#mc-save'), true);
  assert.equal(await text('#mc-estimate'), 'The selection covers the whole file, so nothing would be left.');
  await page.check('#mc-m-keep');

  // ---------- Fades and volume (re-encoded), and their errors ----------
  await setTimes('1', '5');
  await typeInto('#mc-fadein', 'abc');
  assert.equal(await text('#mc-fade-error'), 'Type the fade-in length in seconds, such as 2 or 0.5.');
  assert.deepEqual(await fieldState('#mc-fadein'), { invalid: 'true', describedby: ['mc-fade-error'] });
  await typeInto('#mc-fadein', '3');
  await typeInto('#mc-fadeout', '2');
  assert.match(await text('#mc-fade-error'), /^The fades together \(5 s\) are longer than what is saved \(4 s\)/);
  assert.equal(await page.getAttribute('#mc-fadein', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#mc-fadeout', 'aria-invalid'), 'true');
  await page.click('#mc-save');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mc-fadein', 'Cut goes to the field in error instead');
  assert.equal(await page.isVisible('#mc-results'), false);
  await typeInto('#mc-fadein', '0,5');
  await typeInto('#mc-fadeout', '1');
  assert.equal(await text('#mc-fade-error'), '');
  await page.$eval('#mc-vol', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await text('#mc-vol-out'), '50% (−6.0 dB)');
  assert.equal(await text('#mc-exact-note'), 'Fades change the sound, which needs re-encoding: this file is re-encoded as MP3 at 128 kbps.');
  assert.match(await text('#mc-peak'), /^Loudest point at this volume: −\d+\.\d dB of full scale\. Up to \d+% stays clear of distortion\.$/);
  await page.check('#mc-f-wav');
  await cut();
  w = verify('fade', (await fetchResult()).bytes, F('song.mp3'), 44100, 220500, 22050, 44100, 0.5);
  assert.equal(w.samples, 176400);
  assert.ok(w.vs.diff <= 1.5 / 32768, `half volume, a 0.5 s fade-in and a 1 s fade-out, sample by sample (${w.vs.diff})`);
  await page.check('#mc-f-mp3');
  await cut();
  w = verify('fade', (await fetchResult()).bytes, F('song.mp3'), 44100, 220500, 22050, 44100, 0.5);
  assert.ok(w.samples === 176400 && w.vs.lag === 0 && w.vs.snr > 12, `the MP3 too (${w.samples}, lag ${w.vs.lag}, ${w.vs.snr.toFixed(1)} dB)`);
  await page.$eval('#mc-vol', el => { el.value = '400'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await text('#mc-peak'), /^At this volume the loudest parts go above full scale and will distort\. \d+% is the most without distortion\.$/);
  await page.$eval('#mc-vol', el => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await typeInto('#mc-fadein', '0');
  await typeInto('#mc-fadeout', '');
  assert.match(await text('#mc-estimate'), /^Copied without re-encoding/, 'with the fades and volume back, the copy is exact again');

  // ---------- Times: separators, digits of other scripts, mistakes ----------
  const timeError = async (value, which, re) => {
    await typeInto(which === 'start' ? '#mc-start' : '#mc-end', value);
    assert.match(await text('#mc-time-error'), re, `${which} "${value}"`);
    const f = await fieldState(which === 'start' ? '#mc-start' : '#mc-end');
    assert.equal(f.invalid, 'true', `${which} "${value}" is marked invalid`);
    assert.ok(f.describedby.includes('mc-time-error'), `${which} points at its message`);
  };
  await timeError('1:75', 'start', /^Minutes and seconds go up to 59/);
  await timeError('abc', 'start', /^Type the start as minutes:seconds/);
  await timeError('1\t2', 'start', /^Type the start as/);
  await timeError('²', 'start', /^Type the start as/);
  await timeError('9', 'end', /^The file is only 0:08\.000 long/);
  await timeError('0.5', 'end', /^The end must be at least 0\.1 seconds after the start \(0:01\.000\)/);
  // A good end with the start still wrong keeps the start's message.
  await typeInto('#mc-end', '4');
  assert.match(await text('#mc-time-error'), /^Type the start as/);
  assert.equal(await page.getAttribute('#mc-start', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#mc-end', 'aria-invalid'), null);
  await typeInto('#mc-start', '1');
  await typeInto('#mc-end', '٣٫٥');
  assert.equal(await text('#mc-time-error'), '');
  assert.equal(await text('#mc-len'), '0:02.500', 'Arabic-Indic digits and decimal separator: 3.5 s');
  await typeInto('#mc-start', '０：０２，５');
  assert.equal(await text('#mc-len'), '0:01.000', 'full-width digits, colon and comma: 0:02.5');
  const before = await cpu();
  await typeInto('#mc-start', '1'.repeat(1000000));
  assert.ok(await cpu() - before < 1, 'a megabyte pasted into a time is cut to 40 characters before any pattern runs');
  assert.equal((await val('#mc-start')).length, 40);
  await typeInto('#mc-start', '1.0');
  await page.keyboard.press('Tab');
  assert.equal(await text('#mc-time-error'), '');

  // ---------- AAC: copied without re-encoding, or encoded for an M4R ----------
  await openFile('song.m4a');
  assert.match(await text('#mc-info'), /^AAC · 128 kbps · stereo · 44\.1 kHz · 0:06\.0\d\d · 98 KB$/);
  assert.equal(await page.isVisible('#mc-exact-row'), false, 'no exact copy of AAC as MP3');
  assert.match(await text('#mc-estimate'), /^Re-encoded as MP3 at 128 kbps: about /);
  await page.check('#mc-f-m4a');
  assert.equal(await page.isVisible('#mc-exact-row'), true);
  assert.equal(await text('#mc-exact-label'), 'Exact copy: keep the AAC sound as it is, without re-encoding');
  assert.match(await text('#mc-exact-note'), /^AAC is cut between its frames, every 23 ms/);
  await setTimes('1', '4');
  res = await cut();
  assert.match(res[0].text, /AAC copied without re-encoding$/);
  let m4a = await fetchResult();
  assert.equal(m4a.name, 'song (cut).m4a');
  const srcPk = JSON.parse(execFileSync('python3', [F('verify.py'), 'packets', F('song.m4a')]).toString());
  const outPk = verify('packets', m4a.bytes);
  const at = srcPk.indexOf(outPk[0]);
  assert.ok(at > 0 && outPk.length > 120 && outPk.every((h, i) => srcPk[at + i] === h), 'every AAC packet of the cut is a packet of the file, in order, byte for byte');
  v = verify('facts', m4a.bytes);
  assert.equal(v.codec, 'aac');
  assert.equal(v.mp4.tags['©nam'], 'M4A Song', 'iTunes tags kept');
  assert.ok(v.duration >= 3 && v.duration < 3.1, `about 3 s, cut at AAC frames (${v.duration})`);
  // M4R from AAC: copied too, with its own name; with a fade, encoded.
  await page.check('#mc-f-m4r');
  res = await cut();
  assert.equal(res[0].name, 'song (ringtone).m4r');
  assert.match(res[0].text, /AAC copied without re-encoding$/);
  assert.equal(requested.filter(u => /aac-encoder/.test(u)).length, 0, 'no AAC encoder for a copy');
  await typeInto('#mc-fadeout', '1');
  assert.equal(await text('#mc-exact-note'), 'Fades change the sound, which needs re-encoding: this file is re-encoded as M4R at 128 kbps.');
  res = await cut();
  assert.match(res[0].text, /^0:03\.000 · \d+ KB · AAC at 128 kbps$/);
  const hasAac = await page.evaluate(async () => { await window.TTAudio.load(); return window.TTAudio.MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 44100, bitrate: 128000 }); });
  assert.equal(requested.filter(u => /mediabunny-aac-encoder\.min\.js/.test(u)).length, 1,
    'this browser\'s own AAC encoder is missing (Chromium on Linux), so FFmpeg\'s is loaded, once, and only now');
  assert.equal(hasAac, true, 'and registered');
  let r4 = await fetchResult();
  assert.equal(r4.name, 'song (ringtone).m4r');
  v = verify('fade', r4.bytes, F('song.m4a'), 44100, 176400, 0, 44100, 1);
  assert.deepEqual([v.codec, v.profile, v.rate, v.channels], ['aac', 'LC', 44100, 2]);
  assert.equal(v.mp4.movie.duration, Math.round(3 * v.mp4.movie.timescale), 'the movie ends at the last sample: exactly 3 s');
  assert.equal(v.mp4.elst.length, 1);
  assert.equal(v.mp4.elst[0][0], v.mp4.movie.duration, 'and so does its edit list');
  assert.ok(v.samples >= 132300 && v.samples < 132300 + 1024, `ffmpeg skips the encoder delay (it keeps the last frame's padding): ${v.samples}`);
  assert.equal(v.vs.lag, 0, 'the AAC lines up with the source');
  assert.ok(v.vs.snr > 12, `and has the fade-out (SNR ${v.vs.snr.toFixed(1)} dB against the faded source)`);
  assert.equal(v.mp4.tags['©nam'], 'M4A Song');
  await typeInto('#mc-fadeout', '0');
  await page.check('#mc-f-mp3');

  // ---------- Other inputs: re-encoded, or saved as WAV ----------
  await openFile('take.wav');
  assert.equal(await val('#mc-title'), 'Take One', 'RIFF INFO tags are read');
  assert.equal(await page.isVisible('#mc-exact-row'), false);
  assert.equal(await val('#mc-kbps'), '320', 'lossless sound is re-encoded at 320 kbps to begin with');
  await setTimes('0.25', '1.75');
  await cut();
  v = verify('cut', (await fetchResult()).bytes, F('take.wav'), 4000, 28000);
  assert.deepEqual([v.codec, v.rate, v.channels, v.samples, v.lame.tag], ['mp3', 16000, 2, 24000, 'Info'], '16 kHz kept, exact length (MPEG-2 MP3 at 160 kbps)');
  assert.equal(v.bit_rate, 160000, 'MP3 at 16 kHz goes up to 160 kbps');
  assert.ok(v.vs.lag === 0 && v.vs.snr > 15, `the WAV re-encoded (${v.vs.snr.toFixed(1)} dB)`);
  assert.equal(v.id3.frames.TIT2, 'Take One');
  await openFile('song.flac');
  await page.check('#mc-f-wav');
  await setTimes('0.5', '1.5');
  await cut();
  v = verify('cut', (await fetchResult()).bytes, F('song.flac'), 11025, 33075);
  assert.deepEqual([v.codec, v.rate, v.channels, v.samples, v.vs.diff], ['pcm_s16le', 22050, 2, 22050, 0], 'FLAC to WAV: the same samples, bit for bit');
  assert.equal(v.info.INAM, 'FLAC Song', 'tags as RIFF INFO');
  await page.check('#mc-f-mp3');
  await openFile('voice.ogg');
  await setTimes('0.5', '2.5');
  await cut();
  v = verify('facts', (await fetchResult()).bytes);
  assert.deepEqual([v.codec, v.rate, v.channels, v.samples], ['mp3', 48000, 1, 96000], 'Opus to MP3: 2 s at 48 kHz mono');
  await openFile('clip.mp4');
  assert.match(await text('#mc-info'), /^AAC · \d+ kbps · stereo · 48 kHz · 0:04\.0\d\d/);
  await page.check('#mc-f-m4a');
  await setTimes('1', '2');
  res = await cut();
  assert.match(res[0].text, /AAC copied without re-encoding$/, 'the sound of a video copied');
  v = verify('facts', (await fetchResult()).bytes);
  assert.ok(v.codec === 'aac' && v.channels === 2 && v.format.indexOf('mp4') >= 0, 'an M4A with the AAC of the video, no picture');
  await page.check('#mc-f-mp3');
  await openFile('surround.wav');
  assert.match(await text('#mc-info'), /5\.1 surround/);
  await cut();
  v = verify('facts', (await fetchResult()).bytes);
  assert.deepEqual([v.codec, v.channels, v.rate, v.samples], ['mp3', 2, 8000, 8000], '5.1 mixed down to stereo, 8 kHz kept');
  await openFile('seven.wav');
  await cut();
  v = verify('facts', (await fetchResult()).bytes);
  assert.deepEqual([v.channels, v.samples], [2, 8000], '7.1: its first two channels');
  await openFile('hires.wav');
  await cut();
  v = verify('facts', (await fetchResult()).bytes);
  assert.deepEqual([v.codec, v.rate, v.samples], ['mp3', 48000, 24000], '96 kHz becomes 48 kHz MP3, exact length');
  await page.check('#mc-f-wav');
  await cut();
  v = verify('facts', (await fetchResult()).bytes);
  assert.deepEqual([v.codec, v.rate, v.samples], ['pcm_s16le', 96000, 48000], 'WAV keeps 96 kHz');
  await page.check('#mc-f-mp3');

  // ---------- Files that cannot be cut, and links ----------
  await openFile('song.mp3');
  for (const [name, re] of [
    ['not-audio.mp3', /^not-audio\.mp3: This is not an audio file that this page can read\./],
    ['empty.mp3', /^empty\.mp3 is empty \(0 bytes\)\.$/],
    ['free.mp3', /^free\.mp3: This MP3 is in free format/],
    ['ima-adpcm.wav', /^ima-adpcm\.wav: This WAV file holds IMA ADPCM sound/],
    ['silent.mp4', /^silent\.mp4 is a video without a sound track/],
    ['fairplay.m4a', /^fairplay\.m4a: This file is copy-protected \(Apple FairPlay DRM\)/]
  ]) {
    await openFile(name, page, false);
    assert.match(await text('#mc-file-error'), re, name);
    assert.ok((await page.getAttribute('#mc-open', 'aria-describedby')).split(' ').includes('mc-file-error'), 'Choose a file points at the message');
    assert.equal(await text('#mc-name'), 'song.mp3', `${name}: the file already open stays open`);
  }
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://www.youtube.com/watch?v=abc');
    document.getElementById('mc-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  assert.match(await text('#mc-file-error'), /^Links cannot be cut: this page only reads files on your device/);
  await openFile('cut-off.mp3');
  assert.equal(await text('#mc-file-error'), '', 'a file cut off in a frame opens');
  const cutOffEnd = await val('#mc-end');
  assert.ok(cutOffEnd < '0:05.300' && cutOffEnd > '0:05.100', `what is there of it: ${cutOffEnd} of the 8 s its tag claims`);
  await setTimes('1', '5');
  await cut();
  checkExact(await fetchResult(), 'cut-off.mp3', 1000, 5000, 'cut-off.mp3');

  // ---------- The sample song, made a ringtone, and undone ----------
  await page.click('#mc-sample');
  await page.waitForFunction(() => document.getElementById('mc-name').textContent === 'sample.mp3', null, { timeout: 30000 });
  await waitWaveDone();
  assert.match(await text('#mc-info'), /^MP3 · 192 kbps · stereo · 44\.1 kHz · 0:32\.000 · /, 'a 32 s MP3 made in the page');
  await typeInto('#mc-start', '1');
  await page.locator('#mc-ring').dblclick();
  assert.equal(await val('#mc-start'), '0:01.000', 'the ringtone keeps the start');
  assert.equal(await val('#mc-end'), '0:30.500', 'and 29.5 s from it');
  assert.equal(await val('#mc-fadeout'), '1');
  assert.equal(await page.isChecked('#mc-f-mp3'), true);
  assert.equal(await text('#mc-ring-note'), 'Ringtone: 0:01.000 to 0:30.500 (29.5 s), with a 1 s fade-out, as MP3. Move the handles to choose another part, then press Cut.');
  assert.equal(await page.isVisible('#mc-undo'), true);
  res = await cut();
  assert.equal(res[0].name, 'sample (cut).mp3');
  assert.match(await text('#mc-after'), /^As a ringtone: on an iPhone with iOS 26 or later, save it to the Files app, touch and hold it there, tap Share and then Use as Ringtone\. On Android, open it in Files by Google, tap More and then Set as ringtone\.$/);
  const ring = await fetchResult();
  v = verify('facts', ring.bytes);
  assert.deepEqual([v.codec, v.samples, v.bit_rate], ['mp3', 1300950, 192000], 'exactly 29.5 s at 44.1 kHz, re-encoded at the sample\'s 192 kbps');
  assert.ok(v.samples / 44100 < 30, 'under 30 seconds');
  await page.click('#mc-undo');
  assert.deepEqual([await val('#mc-start'), await val('#mc-end'), await val('#mc-fadeout')], ['0:01.000', '0:32.000', '0'],
    'Undo gives back what was there before, also after a double click');
  assert.equal(await page.isVisible('#mc-undo'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mc-ring');
  // A change of the visitor's own after the preset drops the Undo.
  await page.click('#mc-ring');
  await typeInto('#mc-end', '20');
  assert.equal(await page.isVisible('#mc-undo'), false, 'Undo goes once the visitor changes something');

  // ---------- Playing: from the playhead, and the selection with its fades ----------
  await openFile('song.mp3');
  await page.evaluate(() => { window.__starts = []; window.__ramps = []; window.__session = []; });
  await page.focus('#mc-cursor');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__starts.length > 0 && document.getElementById('mc-pos').textContent > '0:00.300', null, { timeout: 20000 });
  assert.equal(await text('#mc-play'), 'Pause');
  assert.deepEqual(await page.evaluate(() => window.__session), ['playback'], 'iOS plays it in silent mode too');
  await page.keyboard.press('i');
  const startAt = await val('#mc-start');
  assert.ok(startAt > '0:00.300' && startAt < '0:05.000', `I takes the start at the playhead while it plays (${startAt})`);
  await page.waitForFunction(s => document.getElementById('mc-pos').textContent > s, startAt);
  await page.keyboard.press('o');
  assert.ok(await val('#mc-end') > startAt, 'O takes the end at the playhead');
  await page.keyboard.press('Space');
  assert.equal(await text('#mc-play'), 'Play');
  assert.deepEqual(await page.evaluate(() => window.__session), ['playback', 'auto'], 'and gives the sound back to other apps when it stops');
  // Play selection: the fades and volume as gain ramps on the selection's own time.
  await setTimes('2', '6');
  await typeInto('#mc-fadein', '1');
  await typeInto('#mc-fadeout', '0.5');
  await page.$eval('#mc-vol', el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => { window.__starts = []; window.__ramps = []; });
  await page.click('#mc-play-sel');
  await page.waitForFunction(() => window.__starts.length > 0, null, { timeout: 20000 });
  const ramps = await page.evaluate(() => window.__ramps);
  const T0 = ramps[0][2];
  assert.deepEqual(ramps.map(r => [r[0], +r[1].toFixed(4), +(r[2] - T0).toFixed(4)]),
    [['setValueAtTime', 0, 0], ['linearRampToValueAtTime', 0.5, 1], ['linearRampToValueAtTime', 0.5, 3.5], ['linearRampToValueAtTime', 0, 4]],
    'silent at the start, half volume after 1 s, down to nothing over the last 0.5 s of the 4 s');
  const starts = await page.evaluate(() => window.__starts);
  near(starts[0].when - T0, 0, 0.001, 'the first buffer starts with the ramps');
  assert.equal(await text('#mc-play-sel'), 'Stop');
  await page.click('#mc-play-sel');
  assert.equal(await text('#mc-play-sel'), 'Play selection');
  await typeInto('#mc-fadein', '0');
  await typeInto('#mc-fadeout', '0');
  await page.$eval('#mc-vol', el => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });

  // ---------- Zoom ----------
  await page.click('#mc-all');
  await page.focus('#mc-cursor');
  await page.keyboard.press('Home');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing the whole file, 0:08.000');
  await page.click('#mc-zin');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:00.000 to 0:04.000 of 0:08.000', 'zoomed in on the playhead');
  await page.keyboard.press('+');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:00.000 to 0:02.000 of 0:08.000', '+ zooms in too');
  await page.focus('#mc-over');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:00.200 to 0:02.200 of 0:08.000', '→ on the overview moves the view a tenth');
  await page.keyboard.press('End');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:06.000 to 0:08.000 of 0:08.000');
  await page.focus('#mc-h-start');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:00.000 to 0:02.000 of 0:08.000', 'a handle that takes the focus is brought into view');
  await page.keyboard.press('-');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:00.000 to 0:04.000 of 0:08.000', '− zooms out');
  await setTimes('3.2', '3.3');
  await page.click('#mc-zsel');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:03.195 to 0:03.305 of 0:08.000', 'zoomed to the selection');
  // So far in, the part shown is read again in detail: a wave fills the view.
  await page.waitForFunction(() => {
    const c = document.getElementById('mc-canvas'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data, seen = new Set();
    for (let x = 0; x < c.width; x += 4) for (let y = 0; y < c.height; y++) { const i = (y * c.width + x) * 4; if (d[i] < 100 && d[i + 1] > 90) { seen.add(x); break; } }
    return seen.size > c.width / 4 * 0.9;
  }, null, { timeout: 20000 });
  // A focused handle moves 10 ms with Alt, deep in a zoom.
  await page.focus('#mc-h-end');
  await page.keyboard.press('Alt+ArrowRight');
  assert.equal(await val('#mc-end'), '0:03.310');
  const box = await page.locator('#mc-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  assert.notEqual(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing 0:03.195 to 0:03.305 of 0:08.000', 'Ctrl and the wheel zoom');
  await page.click('#mc-zall');
  assert.equal(await page.getAttribute('#mc-over', 'aria-valuetext'), 'Showing the whole file, 0:08.000');

  // ---------- Double presses, and what the browser restores ----------
  await page.click('#mc-all');
  await cut();
  let downloads = 0;
  const count = () => downloads++;
  page.on('download', count);
  await page.locator('#mc-results button').dblclick();
  await page.waitForTimeout(1600);
  page.off('download', count);
  assert.equal(downloads, 1, 'a double click downloads once');
  await page.evaluate(() => {
    document.getElementById('mc-f-wav').checked = true;
    document.getElementById('mc-m-split').checked = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.match(await text('#mc-estimate'), /^Saved as 16-bit WAV: about 1\.41 MB\.$/, 'fields the browser restores are read again');
  assert.equal(await page.isVisible('#mc-split'), true);
  assert.equal(await page.isVisible('#mc-results'), false, 'and the results of other settings are gone');
  await page.check('#mc-m-keep');
  await page.check('#mc-f-mp3');

  // ---------- An hour-long MP3 and a WAV over 4 GB, built in the page ----------
  // The hour: song.mp3's frames (no tags, no Info frame) 450 times over. Every
  // copy after the first decodes the same, so ffmpeg's decode of three copies
  // gives what any later copy holds.
  const [f0, f1, perCopy] = exp.song_frames;
  const copySamples = perCopy * 1152;
  await page.evaluate(async ([b64, f0, f1]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).subarray(f0, f1);
    const part = new Blob([bytes]);
    window.__hour = new File(new Array(450).fill(part), 'hour.mp3', { type: 'audio/mpeg' });
  }, [fs.readFileSync(F('song.mp3')).toString('base64'), f0, f1]);
  const dropFile = (expr, p = page) => p.evaluate(expr => {
    const dt = new DataTransfer();
    dt.items.add(eval(expr));
    document.getElementById('mc-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, expr);
  await dropFile('window.__hour');
  await page.waitForFunction(() => document.getElementById('mc-name').textContent === 'hour.mp3', null, { timeout: 60000 });
  const hourMs = Math.round(450 * copySamples / 44.1);
  assert.equal(await val('#mc-end'), '1:00:20.571', `an hour and 20 s: 450 × ${copySamples} samples`);
  assert.equal(hourMs, 3620571);
  assert.match(await text('#mc-info'), /^MP3 · 128 kbps · stereo · 44\.1 kHz · 1:00:20\.571 · 57\.9 MB · no LAME tag$/);
  await setTimes('59:50', '59:55');
  await page.click('#mc-f-m4r');
  await page.click('#mc-f-mp3');
  const hourCpu = await cpu();
  res = await cut();
  assert.ok(await cpu() - hourCpu < 4, 'an exact cut of an hour-long MP3 reads it, decodes none of it');
  assert.equal(res[0].name, 'hour (cut).mp3');
  const at0 = smp(3590000, 44100), k = Math.floor(at0 / copySamples), off = at0 - k * copySamples;
  assert.ok(k >= 2 && off + 220500 < copySamples, 'the cut lies inside one copy');
  v = verify('cut', (await fetchResult()).bytes, F('song.mp3'), 2 * copySamples + off, 2 * copySamples + off + 220500, `${f0}:${f1},${f0}:${f1},${f0}:${f1}`);
  assert.equal(v.samples, 220500);
  assert.equal(v.vs.diff, 0, 'five seconds from 59:50, bit for bit');
  // An M4R of more than 40 s is flagged; a long re-encode can be cancelled.
  await setTimes('10:00', '11:00');
  await page.check('#mc-f-m4r');
  assert.match(await text('#mc-estimate'), /Ringtones made with Apple’s tools are 40 seconds long at most/);
  await page.check('#mc-f-mp3');
  await page.uncheck('#mc-exact');
  await setTimes('0', '30:00');
  await page.evaluate(() => { window.__wake = { requested: 0, released: 0 }; window.__live = []; });
  await page.click('#mc-save');
  await page.waitForFunction(() => document.getElementById('mc-pbar').value > 0, null, { timeout: 60000 });
  assert.equal(await page.isDisabled('#mc-start'), true, 'nothing can be changed while it cuts');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'mc-cancel', 'Cancel takes the focus');
  assert.equal((await page.evaluate(() => window.__wake)).requested, 1, 'the screen is kept on while it cuts');
  // A tab in the background goes on cutting.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const p1 = await page.evaluate(() => document.getElementById('mc-pbar').value);
  await page.waitForFunction(p => document.getElementById('mc-pbar').value > p, p1, { timeout: 60000 });
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('mc-cancel').hidden);
  assert.equal(await page.isVisible('#mc-results'), false, 'a cancelled cut leaves nothing to save');
  assert.ok((await live()).includes('Cancelled.'));
  assert.equal(await page.isDisabled('#mc-start'), false);
  assert.equal((await page.evaluate(() => window.__wake)).released, 1, 'and lets the screen sleep again');
  await page.check('#mc-exact');
  // Over 4 GB of WAV, its 32-bit sizes wrapped round: 25,500 s of a 1 kHz tone.
  await page.evaluate(() => {
    const sr = 44100, sec = new Int16Array(sr * 2);
    for (let i = 0; i < sr; i++) { const x = Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 1000 * i / sr)); sec[2 * i] = x; sec[2 * i + 1] = x >> 1; }
    const n = 25500, bytes = sr * 4 * n, h = new DataView(new ArrayBuffer(44)), w = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, (bytes + 36) % 4294967296, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
    h.setUint16(22, 2, true); h.setUint32(24, sr, true); h.setUint32(28, sr * 4, true); h.setUint16(32, 4, true); h.setUint16(34, 16, true);
    w(36, 'data'); h.setUint32(40, bytes % 4294967296, true);
    const part = new Blob([sec]);
    window.__big = new File([h.buffer].concat(new Array(n).fill(part)), 'big.wav', { type: 'audio/wav' });
  });
  await dropFile('window.__big');
  await page.waitForFunction(() => document.getElementById('mc-name').textContent === 'big.wav', null, { timeout: 60000 });
  assert.equal(await val('#mc-end'), '7:05:00.000', 'read to its real end, past 4 GB');
  await setTimes('7:00:00', '7:00:05');
  res = await cut();
  v = verify('facts', (await fetchResult()).bytes);
  assert.deepEqual([v.codec, v.rate, v.channels, v.samples], ['mp3', 44100, 2, 220500], 'five seconds from 7:00:00 of it');
  near(v.rms[0], 0.5 / Math.SQRT2, 0.01, 'the tone, left');
  near(v.rms[1], 0.25 / Math.SQRT2, 0.01, 'and right');
  await openFile('song.mp3');

  // ---------- When the cutter's library cannot be loaded (offline) ----------
  const offline = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const offPage = await offline.newPage();
  await offPage.route('**/mediabunny.min.js', r => r.abort());
  await offPage.goto(url);
  await openFile('song.mp3', offPage, false);
  assert.equal(await offPage.locator('#mc-file-error').textContent(), 'song.mp3: The cutter could not be loaded. Check the connection and reload the page.');
  await offline.close();

  // ---------- Without WebCodecs audio (Firefox for Android, Safari 16.4-18) ----------
  const problems = [];
  const watch = p => {
    p.on('pageerror', e => problems.push('page error: ' + e.message));
    p.on('console', x => { if (x.type() === 'error') problems.push('console error: ' + x.text()); });
  };
  const old = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const op = await old.newPage();
  watch(op);
  await op.addInitScript(() => { delete window.AudioDecoder; delete window.AudioEncoder; delete window.AudioData; delete window.EncodedAudioChunk; });
  await op.goto(url);
  await openFile('song.mp3', op);
  assert.equal(await op.evaluate(() => typeof AudioDecoder), 'undefined');
  assert.equal(await op.locator('#mc-wave-msg').textContent(), '', 'the waveform, from the whole file decoded at once');
  await setTimes('2.5', '6', op);
  await cut(op);
  checkExact(await fetchResult(0, op), 'song.mp3', 2500, 6000, 'exact copy without WebCodecs');
  await typeInto('#mc-fadeout', '1', op);
  await cut(op);
  v = verify('fade', (await fetchResult(0, op)).bytes, F('song.mp3'), 110250, 264600, 0, 44100, 1);
  assert.ok(v.samples === 154350 && v.vs.lag === 0 && v.vs.snr > 12, `re-encoded with a fade without WebCodecs (${v.samples}, ${v.vs.snr.toFixed(1)} dB)`);
  await op.check('#mc-f-m4a');
  await cut(op);
  v = verify('facts', (await fetchResult(0, op)).bytes);
  assert.deepEqual([v.codec, v.profile, v.mp4.movie.duration / v.mp4.movie.timescale], ['aac', 'LC', 3.5], 'and AAC, with FFmpeg\'s encoder');
  await old.close();

  // ---------- A phone: touch, a decimal comma, and memory ----------
  const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE', acceptDownloads: true });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(url);
  assert.deepEqual(await pp.evaluate(() => [TTAudio.PHONE, TTAudio.limits.wav]), [true, 300e6]);
  await pp.tap('#mc-sample');
  await pp.waitForFunction(() => document.getElementById('mc-name').textContent === 'sample.mp3', null, { timeout: 30000 });
  await waitWaveDone(pp);
  await pp.locator('#mc-box').scrollIntoViewIfNeeded();
  const settle = () => pp.evaluate(() => new Promise(resolve => {
    let last = NaN, same = 0;
    const tick = () => { if (scrollY === last) { if (++same > 4) return resolve(); } else { same = 0; last = scrollY; } requestAnimationFrame(tick); };
    tick();
  }));
  await settle();
  const tcdp = await phone.newCDPSession(pp);
  const touch = (type, x, y) => tcdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const swipe = async (x0, y0, x1, y1) => {
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8); await pp.waitForTimeout(40); }
    await pp.waitForTimeout(300);
    await touch('touchEnd');
  };
  const sliders = () => pp.evaluate(() => ['mc-h-start', 'mc-h-end', 'mc-cursor'].map(id => +document.getElementById(id).getAttribute('aria-valuenow')));
  let tb = await pp.locator('#mc-box').boundingBox();
  // A tap puts the playhead there and moves no handle.
  await pp.touchscreen.tap(tb.x + tb.width * 0.25, tb.y + tb.height * 0.8);
  let sl = await sliders();
  assert.deepEqual(sl.slice(0, 2), [0, 32], 'a tap moves no handle');
  near(sl[2], 8, 0.15, 'a tap at a quarter puts the playhead at 8 s');
  // A finger scrolling the page over the waveform moves nothing.
  const from = await pp.evaluate(() => scrollY);
  await swipe(tb.x + tb.width * 0.6, tb.y + tb.height * 0.9, tb.x + tb.width * 0.6 + 2, tb.y + tb.height * 0.9 - 160);
  await settle();
  assert.ok(await pp.evaluate(y => scrollY > y, from), 'the swipe scrolled the page');
  assert.deepEqual(await sliders(), sl, 'and moved neither the handles nor the playhead');
  await pp.locator('#mc-box').scrollIntoViewIfNeeded();
  await settle();
  tb = await pp.locator('#mc-box').boundingBox();
  // The end handle dragged to the middle; a sideways slide moves the playhead.
  const eh = await pp.locator('#mc-h-end').boundingBox();
  await swipe(eh.x + eh.width / 2, tb.y + tb.height / 2, tb.x + tb.width / 2, tb.y + tb.height / 2);
  near(+(await pp.getAttribute('#mc-h-end', 'aria-valuenow')), 16, 0.2, 'the end handle dragged to 16 s with a finger');
  // (Chrome moves a touch onto a slider within a few pixels, so the slide
  // starts well away from the handles and the playhead.)
  await pp.touchscreen.tap(tb.x + tb.width * 0.9, tb.y + tb.height * 0.8);
  await swipe(tb.x + tb.width * 0.7, tb.y + tb.height * 0.85, tb.x + tb.width * 0.8, tb.y + tb.height * 0.85);
  sl = await sliders();
  near(sl[2], 25.6, 0.2, 'a sideways slide takes the playhead along');
  assert.deepEqual(sl.slice(0, 1), [0], 'and leaves the start where it was');
  assert.equal(await pp.evaluate(() => (1.5).toLocaleString()), '1,5', 'the browser uses a decimal comma');
  await typeInto('#mc-start', '1,5', pp);
  assert.equal(await pp.textContent('#mc-len'), '0:14.500', 'and so may the visitor');
  // Every button is at least 44 px tall.
  const small = await pp.$$eval('#mc .btn', bs => bs.filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.textContent));
  assert.deepEqual(small, [], 'buttons are 44 px tall on a touch screen');
  await pp.tap('#mc-save');
  await pp.waitForFunction(() => !document.getElementById('mc-results').hidden, null, { timeout: 30000 });
  const phoneCut = await download(() => pp.locator('#mc-results button').tap(), pp);
  v = verify('facts', phoneCut.bytes);
  assert.deepEqual([v.codec, v.samples], ['mp3', 639450], 'exactly 14.5 s');
  // An MP3 over this phone's 300 MB is re-encoded, and the page says why.
  await pp.evaluate(async ([b64, f0, f1]) => {
    const part = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0)).subarray(f0, f1)]);
    window.__huge = new File(new Array(2400).fill(part), 'huge.mp3', { type: 'audio/mpeg' });
  }, [fs.readFileSync(F('song.mp3')).toString('base64'), f0, f1]);
  await dropFile('window.__huge', pp);
  await pp.waitForFunction(() => document.getElementById('mc-name').textContent === 'huge.mp3', null, { timeout: 120000 });
  assert.equal(await pp.textContent('#mc-exact-note'), 'This MP3 is over 300 MB, more than this device can hold in memory to copy, so it is re-encoded as MP3 at 128 kbps.');
  await typeInto('#mc-end', '2', pp);
  await pp.tap('#mc-save');
  await pp.waitForFunction(() => !document.getElementById('mc-results').hidden || document.getElementById('mc-error').textContent, null, { timeout: 120000 });
  assert.equal(await pp.textContent('#mc-error'), '');
  assert.match(await pp.textContent('#mc-results'), /0:02\.000 · \d+ KB · MP3 at 128 kbps/);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no sideways scroll on a phone with a result (${overflow}px)`);
  await phone.close();
  assert.deepEqual(problems, []);
}
