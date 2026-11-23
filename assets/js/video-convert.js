/*
 * TTVideo: the engine shared by the video converter pages (window.TTVideo).
 * A plain script with no dependencies of its own. Load it before the page's
 * own script:
 *
 *   <script src="{{ '/assets/js/video-convert.js' | relative_url }}"></script>
 *
 * It loads mediabunny from assets/vendor/mediabunny/ (found next to this
 * file's own folder) when the first file is read, and two extensions only
 * when a file needs them: the AAC encoder where the browser cannot encode
 * AAC itself (Firefox, desktop Linux, Safari before 26), and the ProRes
 * decoder for ProRes video. Everything runs in the browser; nothing is sent
 * anywhere or stored. The pages keep their interface and wording: this file
 * holds no visible text except codec names.
 *
 * API
 *   TTVideo.load() -> Promise<Mediabunny>
 *       Loads mediabunny once (and silences its console output: its warnings
 *       are kept per job instead). Rejects when the file cannot be loaded.
 *
 *   TTVideo.probe(file) -> Promise<Info>
 *       Reads a file's container, tracks and tags, and what this browser can
 *       do with them. Never rejects: a file that cannot be used comes back
 *       with info.error = { code, detail }. Codes: 'empty'; 'not-video' (not
 *       MOV, MP4, M4V, 3GP, WebM or MKV); 'no-index' (an MP4 or MOV whose
 *       index, the moov box, is missing: cut off or never finished);
 *       'no-tracks'; 'protected' (DRM); 'damaged' (the index cannot be read
 *       or points outside the file, or reading took over 30 s); 'library'
 *       (mediabunny did not load).
 *       Info: { file, name, size, format ('mov' | 'mp4' | 'mkv' | 'webm'),
 *         isobmff, duration (s), created (Date | null: the movie's creation
 *         time, else its date tag, else the file's own date), createdFrom
 *         ('file' | 'tag' | 'modified' | null), dropped: { location, make,
 *         model, software, localDate } (true where the file has them: the
 *         MP4 keeps none), videos: [Track], audios: [Track], others: [{ kind:
 *         'timecode' | 'subtitles' | 'metadata' | 'other', handler }] (tracks
 *         mediabunny does not read, which the MP4 leaves out), truncated: null
 *         | { at, listed } (a cut-off file: its data stops at `at` seconds,
 *         its index lists `listed`), dolbyVision, error }.
 *       Track: { id, type, codec (mediabunny's codec name, or null when
 *         unknown), internal (the sample entry: 'hvc1', 'jpeg', 'alac' ...),
 *         label (a display name), canDecode, bitrate, duration, first,
 *         packets; video: width, height (as shown, after rotation),
 *         codedWidth, codedHeight, rotation, hdr, colour, alpha, frameRate,
 *         canH264 (this browser can encode H.264 at the even size); audio:
 *         sampleRate, channels, language, canAac ('native' | 'wasm' | null) }.
 *
 *   TTVideo.plan(info, choice) -> Plan
 *       What converting to MP4 does with each track, for choice = { video:
 *       'copy' | 'h264' }. 'copy' copies every track an MP4 player takes
 *       (H.264, HEVC, VP9, AV1, VP8; AAC, MP3, Opus, FLAC, AC-3, E-AC-3, DTS,
 *       TrueHD) and re-encodes the rest: PCM, u-law, A-law and Vorbis sound
 *       to AAC, ProRes video to H.264 (or refuses the file). 'h264' also
 *       re-encodes HEVC, VP9, AV1 and VP8 video to H.264, and sound other
 *       than AAC and MP3 to AAC, where this browser can. WebM and MKV files
 *       are only copied: mediabunny 1.65 drops the frames a WebM recorder
 *       writes with no duration when it re-encodes (fixed in 1.66).
 *       Plan: { ok, refuse: null | { code, track }, video: [Step], audio:
 *         [Step], notes: [{ code, track?, ... }], reencode, needs: { aac,
 *         prores }, bytes (estimated size), seconds (estimated time) }, with
 *         Step = { id, action: 'copy' | 'h264' | 'aac' | 'drop', bitrate?,
 *         crop? (to the even size H.264 needs) }. Refusal codes: 'error' (see
 *         info.error), 'no-video', 'video-codec' (an unknown codec, such as
 *         Motion JPEG), 'prores' (no H.264 encoder for it here),
 *         'video-undecodable'. Note codes: 'hevc', 'h264-unavailable',
 *         'h264-webm', 'odd-size', 'hdr-sdr', 'hdr-kept', 'alpha',
 *         'video-dropped', 'audio-dropped' (spatial: APAC), 'audio-aac',
 *         'audio-copied', 'aac-unavailable', 'no-sound', 'no-sound-left',
 *         'track-dropped' (kind, count), 'truncated', 'metadata' (lost).
 *
 *   TTVideo.convert(info, plan, options) -> Job
 *       options: { sink, onProgress(fraction, secondsDone), stallSeconds }.
 *       Job: { promise, cancel() }. The MP4 keeps the tags mediabunny reads
 *       (title, date, comment ...) and the creation time from info.created,
 *       never the raw QuickTime keys. The promise resolves to { bytes, blob }
 *       (memory sink) or { bytes, saved: true, name } (file sink), or
 *       rejects with an Error whose .code is 'canceled', 'stalled' (no
 *       progress for stallSeconds, default 90, counted only while the page is
 *       visible), 'lost-track' (with .kind and .reason: mediabunny left out a
 *       track it was asked to keep, which it reports as a valid conversion),
 *       'check' (the finished index failed the engine's own check: a track
 *       came out missing, empty or too short), 'memory', 'write' or 'failed'.
 *       Cancelling settles the promise at once, even while a read hangs.
 *       Nothing is committed to a file or a Blob unless the check passed.
 *
 *   TTVideo.memorySink() -> Sink
 *       Builds the MP4 in this tab: the first 1 MiB in memory (the header is
 *       patched there at the end) and the rest streamed into
 *       new Response(stream).blob(), whose write waits while the stream's
 *       queue is full. Firefox keeps such a Blob in a temporary file (not in
 *       private windows), Chromium in memory up to 2 GB and then on disk.
 *       Falls back to an in-memory buffer where WritableStream is missing.
 *   TTVideo.canSaveToFile() -> boolean (window.showSaveFilePicker exists)
 *   TTVideo.chooseFile(name) -> Promise<FileSystemFileHandle | null>
 *       Opens the save dialog, which needs a click. null when the visitor
 *       closes it; rejects with .code 'no-gesture' when the browser wants a
 *       click first.
 *   TTVideo.fileSink(handle) -> Promise<Sink>   writes straight to that file
 *
 *   TTVideo.wake(on)            holds or releases a screen wake lock, taken
 *                               again when the page comes back on screen
 *   TTVideo.outputName(name, used) -> string   "clip.mov" -> "clip.mp4",
 *       "clip.mp4" -> "clip (converted).mp4", unique (case-insensitively)
 *       within the Set `used`, which it extends
 *   TTVideo.codecName(track) -> string   the label probe() gives tracks
 *   TTVideo.checkIndex(moovBytes, expected) -> { ok, why, tracks }
 *   TTVideo.dispose(info)       closes the file
 *   TTVideo.isPhone, TTVideo.isIOS (iPhone and iPad, where every browser is
 *       WebKit), TTVideo.simd (WebAssembly SIMD, which the AAC encoder needs)
 */
(function () {
  'use strict';

  var SELF = (document.currentScript && document.currentScript.src) || location.href;
  var BASE = new URL('../vendor/mediabunny/', SELF).href;
  var UA = navigator.userAgent;
  var IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
  var PHONE = IOS || /Android|Mobile/i.test(UA);
  var HEAD = 1 << 20;                 // bytes of the output kept in memory for the final patch
  var CHUNK = 4 << 20;                // StreamTarget chunk size
  var MOOV_MAX = 64 << 20;            // largest index read for the track scan
  var PROBE_SECONDS = 30;             // a probe that takes longer reports a damaged file
  // A module with one WebAssembly SIMD instruction: the AAC encoder needs SIMD.
  var SIMD = (function () {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  })();

  var MB = null;
  var warnings = [];                  // mediabunny's warnings during the current job

  // ---------- Loading ----------
  var scripts = new Map();
  function loadScript(url) {
    if (scripts.has(url)) return scripts.get(url);
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(); };
      s.onerror = function () { scripts.delete(url); s.remove(); reject(new Error('Could not load ' + url)); };
      document.head.appendChild(s);
    });
    scripts.set(url, p);
    return p;
  }
  var libPromise = null;
  function load() {
    if (!libPromise) {
      libPromise = loadScript(BASE + 'mediabunny.min.js').then(function () {
        if (!window.Mediabunny) throw new Error('mediabunny did not start');
        MB = window.Mediabunny;
        // Nothing goes to the console; warnings are kept for the current job.
        MB.Logging.level = MB.LogLevel.Silent;
        MB.Logging.on('warn', function (args) { if (warnings.length < 50) warnings.push(args.map(String).join(' ')); });
        return MB;
      }).catch(function (e) { libPromise = null; throw e; });
    }
    return libPromise;
  }
  var aacPromise = null;
  function loadAac() {
    if (!SIMD) return Promise.reject(new Error('no WebAssembly SIMD'));
    if (!aacPromise) {
      aacPromise = loadScript(BASE + 'mediabunny-aac-encoder.min.js').then(function () {
        window.MediabunnyAacEncoder.registerAacEncoder();
      }).catch(function (e) { aacPromise = null; throw e; });
    }
    return aacPromise;
  }
  var proresPromise = null;
  function loadProres() {
    if (!proresPromise) {
      proresPromise = loadScript(BASE + 'mediabunny-prores.min.js').then(function () {
        window.MediabunnyProres.registerProresDecoder();
      }).catch(function (e) { proresPromise = null; throw e; });
    }
    return proresPromise;
  }

  // ---------- Small helpers ----------
  function err(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function withTimeout(promise, seconds, code) {
    var t;
    return Promise.race([promise, new Promise(function (_, reject) { t = setTimeout(function () { reject(err(code || 'timeout')); }, seconds * 1000); })])
      .finally(function () { clearTimeout(t); });
  }
  async function attempt(fn, fallback) { try { return await fn(); } catch (e) { return fallback; } }
  function even(n) { return Math.max(2, Math.floor(n / 2) * 2); }
  var PCM = /^pcm-|^ulaw$|^alaw$/;

  // ---------- Codec names (shared by the pages) ----------
  var VIDEO_NAMES = new Map([['avc', 'H.264'], ['hevc', 'HEVC (H.265)'], ['vp9', 'VP9'], ['vp8', 'VP8'], ['av1', 'AV1']]);
  var PRORES_NAMES = new Map([['apco', 'ProRes 422 Proxy'], ['apcs', 'ProRes 422 LT'], ['apcn', 'ProRes 422'], ['apch', 'ProRes 422 HQ'],
    ['ap4h', 'ProRes 4444'], ['ap4x', 'ProRes 4444 XQ']]);
  var UNKNOWN_VIDEO = new Map([['jpeg', 'Motion JPEG (MJPEG)'], ['mjpa', 'Motion JPEG (MJPEG)'], ['mjpb', 'Motion JPEG (MJPEG)'], ['avrn', 'Motion JPEG (MJPEG)'],
    ['mp4v', 'MPEG-4 Part 2'], ['xvid', 'MPEG-4 Part 2'], ['png ', 'PNG'], ['rle ', 'QuickTime Animation'], ['cvid', 'Cinepak'], ['svq1', 'Sorenson Video'],
    ['svq3', 'Sorenson Video 3'], ['h263', 'H.263'], ['s263', 'H.263'], ['mjp2', 'Motion JPEG 2000'], ['aprn', 'ProRes RAW'], ['aprh', 'ProRes RAW HQ'],
    ['dvh1', 'Dolby Vision'], ['dvhe', 'Dolby Vision'], ['dva1', 'Dolby Vision'], ['dvav', 'Dolby Vision'], ['avdn', 'Avid DNxHD'], ['avdh', 'Avid DNxHR'],
    ['hap1', 'HAP'], ['hap5', 'HAP Alpha'], ['hapy', 'HAP Q'], ['v210', 'uncompressed 10-bit video'], ['2vuy', 'uncompressed video'], ['raw ', 'uncompressed video'],
    ['mpeg', 'MPEG-1'], ['mp2v', 'MPEG-2'], ['hdv1', 'HDV (MPEG-2)'], ['xdv7', 'XDCAM (MPEG-2)'], ['xdvc', 'XDCAM (MPEG-2)'], ['wmv3', 'WMV'], ['vc-1', 'VC-1']]);
  var AUDIO_NAMES = new Map([['aac', 'AAC'], ['mp3', 'MP3'], ['opus', 'Opus'], ['vorbis', 'Vorbis'], ['flac', 'FLAC'],
    ['ac3', 'Dolby Digital (AC-3)'], ['eac3', 'Dolby Digital Plus (E-AC-3)'], ['dts', 'DTS'], ['truehd', 'Dolby TrueHD'],
    ['ulaw', 'µ-law'], ['alaw', 'A-law']]);
  var UNKNOWN_AUDIO = new Map([['alac', 'Apple Lossless (ALAC)'], ['apac', 'Apple Spatial Audio (APAC)'], ['samr', 'AMR'], ['sawb', 'AMR-WB'],
    ['ima4', 'IMA ADPCM'], ['qdm2', 'QDesign Music 2'], ['qdmc', 'QDesign Music'], ['qclp', 'QCELP'], ['agsm', 'GSM'], ['mac3', 'MACE 3:1'], ['mac6', 'MACE 6:1'],
    ['dtsc', 'DTS'], ['dtsh', 'DTS-HD'], ['dtsl', 'DTS-HD'], ['mlpa', 'Dolby TrueHD'], ['ac-4', 'Dolby AC-4'], ['mha1', 'MPEG-H 3D Audio'], ['mhm1', 'MPEG-H 3D Audio']]);
  function cleanId(id) {
    return typeof id === 'string' ? id.replace(/[^\x20-\x7e]/g, '').slice(0, 8) : '';
  }
  function codecName(t) {
    var internal = (t.internal || '').toLowerCase();
    if (t.type === 'video') {
      if (t.codec === 'prores') return PRORES_NAMES.get(internal) || 'ProRes';
      if (t.codec) return VIDEO_NAMES.get(t.codec) || t.codec.toUpperCase();
      return UNKNOWN_VIDEO.get(internal) || (t.internal ? 'an unknown codec (“' + t.internal.trim() + '”)' : 'an unknown codec');
    }
    if (t.codec && /^pcm-/.test(t.codec)) {
      var bits = /(\d+)/.exec(t.codec);
      return 'PCM' + (bits ? ', ' + bits[1] + '-bit' : '') + (/f\d/.test(t.codec) ? ' float' : '');
    }
    if (t.codec) return AUDIO_NAMES.get(t.codec) || t.codec.toUpperCase();
    return UNKNOWN_AUDIO.get(internal) || (t.internal ? 'an unknown codec (“' + t.internal.trim() + '”)' : 'an unknown codec');
  }

  // ---------- ISO BMFF boxes (index scan of the input, check of the output) ----------
  function u32(v, o) { return v.getUint32(o); }
  function u64(v, o) { return v.getUint32(o) * 4294967296 + v.getUint32(o + 4); }
  function fourcc(v, o) { return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); }
  // Calls fn(type, start, end) for each box in [from, to) of the DataView; start is the payload.
  function eachBox(v, from, to, fn) {
    var p = from, guard = 0;
    while (p + 8 <= to && guard++ < 100000) {
      var size = u32(v, p), type = fourcc(v, p + 4), head = 8;
      if (size === 1) { if (p + 16 > to) return; size = u64(v, p + 8); head = 16; }
      else if (size === 0) size = to - p;
      if (size < head || p + size > to) return;
      if (fn(type, p + head, p + size) === false) return;
      p += size;
    }
  }
  function child(v, from, to, type) {
    var found = null;
    eachBox(v, from, to, function (t, s, e) { if (t === type) { found = [s, e]; return false; } });
    return found;
  }
  function path(v, from, to, types) {
    var r = [from, to];
    for (var i = 0; i < types.length && r; i++) r = child(v, r[0], r[1], types[i]);
    return r;
  }
  // The tracks listed in a moov box: handler, sample entry, sample count, media duration.
  function moovTracks(v, from, to) {
    var tracks = [];
    eachBox(v, from, to, function (type, s, e) {
      if (type !== 'trak') return;
      var t = { handler: '', entry: '', samples: 0, seconds: 0, boxes: '' };
      var hdlr = path(v, s, e, ['mdia', 'hdlr']);
      if (hdlr && hdlr[0] + 12 <= hdlr[1]) t.handler = fourcc(v, hdlr[0] + 8);
      var mdhd = path(v, s, e, ['mdia', 'mdhd']);
      if (mdhd && mdhd[0] + 24 <= mdhd[1]) {
        var ver = v.getUint8(mdhd[0]);
        var scale = ver === 1 ? u32(v, mdhd[0] + 20) : u32(v, mdhd[0] + 12);
        var dur = ver === 1 ? u64(v, mdhd[0] + 24) : u32(v, mdhd[0] + 16);
        if (scale) t.seconds = dur / scale;
      }
      var stbl = path(v, s, e, ['mdia', 'minf', 'stbl']);
      if (stbl) {
        var stsd = child(v, stbl[0], stbl[1], 'stsd');
        if (stsd && stsd[0] + 16 <= stsd[1]) {
          t.entry = fourcc(v, stsd[0] + 12);
          // The boxes inside the first sample entry, for codec extensions such as Dolby Vision.
          var entryEnd = Math.min(stsd[1], stsd[0] + 8 + u32(v, stsd[0] + 8));
          var names = [];
          for (var q = stsd[0] + 16; q + 8 <= entryEnd; q++) {
            var n = fourcc(v, q + 4);
            if (/^(dvcC|dvvC|dvwC|lhvC|hvcC|avcC|mdcv|clli|colr)$/.test(n) && u32(v, q) >= 8 && q + u32(v, q) <= entryEnd) names.push(n);
          }
          t.boxes = names.join(' ');
        }
        var stsz = child(v, stbl[0], stbl[1], 'stsz');
        if (stsz && stsz[0] + 12 <= stsz[1]) t.samples = u32(v, stsz[0] + 8);
        var stz2 = !stsz && child(v, stbl[0], stbl[1], 'stz2');
        if (stz2 && stz2[0] + 12 <= stz2[1]) t.samples = u32(v, stz2[0] + 8);
      }
      tracks.push(t);
    });
    return tracks;
  }
  async function readBytes(file, from, to) {
    return new DataView(await file.slice(from, to).arrayBuffer());
  }
  // Finds the top-level moov box of an MP4 or MOV file and lists its tracks.
  // Returns null when there is no moov box.
  async function scanIndex(file) {
    var pos = 0, size = file.size;
    for (var i = 0; i < 5000 && pos + 8 <= size; i++) {
      var h = await readBytes(file, pos, Math.min(size, pos + 16));
      var len = u32(h, 0), type = fourcc(h, 4), head = 8;
      if (len === 1) { if (h.byteLength < 16) return null; len = u64(h, 8); head = 16; }
      else if (len === 0) len = size - pos;
      if (len < head || !/^[\x20-\x7e]{4}$/.test(type)) return null;
      if (type === 'moov') {
        if (pos + len > size || len > MOOV_MAX) return { tracks: null, cut: pos + len > size };
        var v = await readBytes(file, pos, pos + len);
        return { tracks: moovTracks(v, head, len), cut: false };
      }
      pos += len;
    }
    return null;
  }

  // ---------- Probing ----------
  var FORMATS = null;
  function formats() {
    if (!FORMATS) FORMATS = [MB.QTFF, MB.MP4, MB.MATROSKA, MB.WEBM];
    return FORMATS;
  }
  var OTHER_KINDS = new Map([['tmcd', 'timecode'], ['text', 'subtitles'], ['sbtl', 'subtitles'], ['subt', 'subtitles'], ['clcp', 'subtitles'],
    ['subp', 'subtitles'], ['meta', 'metadata'], ['mdta', 'metadata'], ['hint', 'other'], ['tmet', 'metadata']]);
  // The raw tag names of metadata that an MP4 made here leaves out.
  var DROPPED = [['location', /location|©xyz|^xyz$|^loci$|gps/i], ['make', /\.make$|©mak/i], ['model', /\.model$|©mod/i],
    ['software', /\.software$/i], ['localDate', /quicktime\.creationdate$/i]];

  // The end of the last packet whose data is in the file. In a file that was
  // cut short the index promises more than there is, and every packet after
  // the first missing one is missing too, so halving the gap finds the end.
  async function readableEnd(track, end) {
    var sink = new MB.EncodedPacketSink(track);
    if (await sink.getPacket(Infinity)) return null;
    var p = await sink.getFirstPacket();
    if (!p) return 0;
    var lo = p.timestamp, hi = end;
    while (hi - lo > 0.001) {
      var mid = (lo + hi) / 2, q = await sink.getPacket(mid);
      if (q) { p = q; lo = mid; } else hi = mid;
    }
    return p.timestamp + p.duration;
  }

  async function probe(file) {
    var info = {
      file: file, name: String(file.name || ''), size: file.size, format: '', isobmff: false, duration: 0,
      created: null, createdFrom: null, dropped: {}, videos: [], audios: [], others: [], truncated: null,
      dolbyVision: false, tags: {}, error: null, input: null, isProtected: false
    };
    if (!file.size) { info.error = { code: 'empty' }; return info; }
    try { await load(); } catch (e) { info.error = { code: 'library' }; return info; }
    try {
      await withTimeout(read(info), PROBE_SECONDS, 'damaged');
    } catch (e) {
      info.error = { code: info.isProtected ? 'protected' : e && e.code && /^(empty|not-video|no-index|no-tracks|protected|damaged)$/.test(e.code) ? e.code : 'damaged',
        detail: String((e && e.message) || e).slice(0, 160) };
    }
    if (info.error && info.input) { try { info.input.dispose(); } catch (x) { /* already closed */ } info.input = null; }
    return info;
  }

  async function read(info) {
    var file = info.file;
    var input = info.input = new MB.Input({
      source: new MB.BlobSource(file, { handleUnhandledError: function () {} }),
      formats: formats(),
      formatOptions: { isobmff: { resolveKeyId: function () { info.isProtected = true; throw err('protected'); } } }
    });
    if (!(await input.canRead())) throw err('not-video');
    var format = await input.getFormat();
    info.format = format === MB.QTFF ? 'mov' : format === MB.MP4 ? 'mp4' : format === MB.WEBM ? 'webm' : 'mkv';
    info.isobmff = info.format === 'mov' || info.format === 'mp4';
    var index = info.isobmff ? await attempt(function () { return scanIndex(file); }, null) : null;
    var tracks = await input.getTracks();
    if (!tracks.length) {
      if (info.isobmff && (!index || index.cut)) throw err('no-index');
      throw err('no-tracks');
    }
    for (var i = 0; i < tracks.length; i++) {
      var t = await describe(tracks[i], info);
      if (t.type === 'video') info.videos.push(t);
      else if (t.type === 'audio') info.audios.push(t);
    }
    if (info.isProtected) throw err('protected');
    if (info.videos.concat(info.audios).some(function (t) { return t.codec && t.unreadable; })) throw err('damaged', 'the index points outside the file');
    info.duration = await attempt(function () { return input.computeDuration(); }, 0);
    // Tracks mediabunny does not read: timecode, subtitles, camera metadata.
    if (index && index.tracks) {
      index.tracks.forEach(function (t) {
        if (/dv[cvw]C/.test(t.boxes)) info.dolbyVision = true;
        if (t.handler === 'vide' || t.handler === 'soun') return;
        info.others.push({ kind: OTHER_KINDS.get(t.handler) || 'other', handler: t.handler });
      });
    }
    // Dates: the movie's creation time (mvhd), else its date tag, else the file's own date.
    var tags = await attempt(function () { return input.getMetadataTags(); }, {});
    info.tags = tags || {};
    var raw = Object.keys((tags && tags.raw) || {});
    DROPPED.forEach(function (d) { info.dropped[d[0]] = raw.some(function (k) { return d[1].test(k); }); });
    var valid = function (d) { return d instanceof Date && !isNaN(d) && d.getTime() > Date.UTC(1971, 0, 1) && d.getTime() < Date.now() + 864e5 * 366; };
    if (valid(tags.creationTime)) { info.created = tags.creationTime; info.createdFrom = 'file'; }
    else if (valid(tags.date)) { info.created = tags.date; info.createdFrom = 'tag'; }
    else if (file.lastModified && valid(new Date(file.lastModified))) { info.created = new Date(file.lastModified); info.createdFrom = 'modified'; }
    // A file that was cut short: its index lists more than its data holds.
    if (info.isobmff) {
      var ends = [];
      for (var k = 0; k < info.videos.length + info.audios.length; k++) {
        var tr = k < info.videos.length ? info.videos[k] : info.audios[k - info.videos.length];
        if (!tr.codec || !tr.duration) continue;
        var end = await attempt(function () { return readableEnd(tr.track, tr.duration); }, null);
        if (end !== null) ends.push(end);
      }
      if (ends.length) {
        var at = Math.min.apply(null, ends);
        info.truncated = { at: Math.max(0, at), listed: info.duration };
        if (!(at > 0.05)) throw err('damaged', 'no readable data');
      }
    }
    await capabilities(info);
  }

  async function describe(track, info) {
    var internal = cleanId(String(await attempt(function () { return track.getInternalCodecId(); }, '')));
    if (/^(encv|enca|drms|drmi|drac|drmn)$/.test(internal)) info.isProtected = true;
    var t = {
      track: track, id: track.id, type: track.type, codec: await track.getCodec(), internal: internal,
      canDecode: false, bitrate: 0, duration: 0, first: 0, packets: 0
    };
    t.canDecode = t.codec ? await attempt(function () { return track.canDecode(); }, false) : false;
    t.first = await attempt(function () { return track.getFirstTimestamp(); }, 0);
    // Rates from the first 2,000 packets: an hour-long index takes seconds to walk.
    // Both throw when the index points outside the file.
    t.duration = await attempt(function () { return track.computeDuration(); }, null);
    var stats = await attempt(function () { return track.computePacketStats(2000); }, null);
    t.unreadable = t.duration === null || !stats;
    t.duration = t.duration || 0;
    if (stats) { t.packets = stats.packetCount; t.bitrate = stats.averageBitrate || 0; t.packetRate = stats.averagePacketRate || 0; }
    if (t.type === 'video') {
      t.codedWidth = await track.getCodedWidth();
      t.codedHeight = await track.getCodedHeight();
      t.width = await track.getDisplayWidth();
      t.height = await track.getDisplayHeight();
      t.rotation = await attempt(function () { return track.getRotation(); }, 0);
      t.colour = t.codec ? await attempt(function () { return track.getColorSpace(); }, {}) : {};
      t.hdr = t.codec ? await attempt(function () { return track.hasHighDynamicRange(); }, false) : false;
      t.alpha = await attempt(function () { return track.canBeTransparent(); }, false);
      t.frameRate = t.packetRate || (t.packets && t.duration ? t.packets / t.duration : 30);
    } else if (t.type === 'audio') {
      t.sampleRate = await attempt(function () { return track.getSampleRate(); }, 0);
      t.channels = await attempt(function () { return track.getNumberOfChannels(); }, 0);
      t.language = await attempt(function () { return track.getLanguageCode(); }, 'und');
    }
    t.label = codecName(t);
    return t;
  }

  // What this browser can do with each track.
  async function capabilities(info) {
    for (var i = 0; i < info.videos.length; i++) {
      var v = info.videos[i];
      if (v.codec === 'prores' && typeof VideoFrame !== 'undefined') {
        try { await loadProres(); v.canDecode = await v.track.canDecode(); } catch (e) { v.canDecode = false; }
      }
      v.canH264 = false;
      if (v.codec && v.canDecode) {
        var size = encodeSize(v);
        v.canH264 = await attempt(function () {
          return MB.canEncodeVideo('avc', { width: size.width, height: size.height, frameRate: Math.min(240, Math.max(1, v.frameRate || 30)),
            quality: new MB.Quality({ bitrate: h264Bitrate(v) }) });
        }, false);
      }
    }
    var native = Object.create(null);
    for (var j = 0; j < info.audios.length; j++) {
      var a = info.audios[j];
      a.canAac = null;
      if (!a.codec || !a.canDecode) continue;
      var key = a.channels + '/' + a.sampleRate;
      if (!(key in native)) {
        native[key] = await attempt(function () {
          return MB.canEncodeAudio('aac', { numberOfChannels: a.channels, sampleRate: a.sampleRate, quality: new MB.Quality({ bitrate: aacBitrate(a) }) });
        }, false);
      }
      // The wasm encoder (FFmpeg's) takes 1 to 8 channels at the usual rates.
      a.canAac = native[key] ? 'native' : SIMD && a.channels >= 1 && a.channels <= 8 && a.sampleRate >= 8000 && a.sampleRate <= 96000 ? 'wasm' : null;
    }
  }

  // ---------- Planning ----------
  var COPY_VIDEO = /^(avc|hevc|vp9|av1|vp8)$/;
  var COPY_AUDIO = /^(aac|mp3|opus|flac|ac3|eac3|dts|truehd)$/;
  var PLAIN_AUDIO = /^(aac|mp3)$/;   // plays everywhere
  function h264Bitrate(v) {
    var w = v.width || v.codedWidth || 1280, h = v.height || v.codedHeight || 720;
    var fps = Math.min(120, Math.max(10, v.frameRate || 30));
    // About 0.1 bit per pixel and frame (6.2 Mbps at 1080p30), and for a
    // compressed source 1.3 times its own rate, since H.264 needs more bits
    // than HEVC, VP9 or AV1 for the same picture.
    var base = 0.1 * w * h * fps;
    var rate = v.codec === 'prores' || !v.bitrate ? base * 1.2 : Math.min(base * 1.2, Math.max(base * 0.4, v.bitrate * 1.3));
    return Math.max(300000, Math.round(rate / 1000) * 1000);
  }
  function aacBitrate(a) {
    return a.channels <= 1 ? 128000 : a.channels === 2 ? 192000 : Math.min(512000, 64000 * a.channels);
  }
  function encodeSize(v) {
    // H.264 encoders take only even sizes: an odd one loses a pixel at the right or bottom.
    return { width: even(v.width), height: even(v.height) };
  }
  // Software speeds measured in Chromium on a 4-core laptop-class machine:
  // copying about 300 MB/s, H.264 encoding about 65 frames/s of 1080p.
  function encodeSeconds(v, seconds) {
    var fps = 65 * (1920 * 1080) / Math.max(1, v.width * v.height);
    return seconds * (v.frameRate || 30) / Math.min(600, fps);
  }

  function plan(info, choice) {
    var want = (choice && choice.video) === 'h264' ? 'h264' : 'copy';
    var p = { ok: false, refuse: null, video: [], audio: [], notes: [], reencode: false, needs: { aac: false, prores: false }, bytes: 0, seconds: 0 };
    if (info.error) { p.refuse = { code: 'error' }; return p; }
    var span = info.truncated ? info.truncated.at : info.duration;
    if (!info.videos.length) { p.refuse = { code: 'no-video' }; return p; }
    var matroska = !info.isobmff;
    info.videos.forEach(function (v, i) {
      var step = { id: v.id, action: 'drop' };
      if (v.codec === 'prores') {
        if (v.canDecode && v.canH264) { step.action = 'h264'; p.needs.prores = true; }
      } else if (v.codec && COPY_VIDEO.test(v.codec)) {
        step.action = 'copy';
        if (want === 'h264' && v.codec !== 'avc') {
          // mediabunny 1.65 drops the frames a WebM recorder writes with no
          // duration when it re-encodes, so WebM and MKV are only copied.
          if (!matroska && v.canDecode && v.canH264) step.action = 'h264';
          else p.notes.push({ code: matroska ? 'h264-webm' : 'h264-unavailable', track: v, decode: v.canDecode });
        }
      }
      if (step.action === 'h264') {
        step.bitrate = h264Bitrate(v);
        var size = encodeSize(v);
        if (size.width !== v.width || size.height !== v.height) {
          step.crop = { left: 0, top: 0, width: size.width, height: size.height };
          p.notes.push({ code: 'odd-size', track: v, width: size.width, height: size.height });
        }
        if (v.hdr) p.notes.push({ code: 'hdr-sdr', track: v });
        if (v.alpha) p.notes.push({ code: 'alpha', track: v });
        p.reencode = true;
        p.bytes += step.bitrate / 8 * span;
        p.seconds += encodeSeconds(v, span);
      } else if (step.action === 'copy') {
        p.bytes += (v.bitrate || 0) / 8 * span;
        if (v.codec === 'hevc') p.notes.push({ code: 'hevc', track: v });
        if (v.hdr) p.notes.push({ code: 'hdr-kept', track: v, dolbyVision: info.dolbyVision && v.codec === 'hevc' });
      }
      if (step.action === 'drop') {
        if (i === 0) {
          p.refuse = v.codec === 'prores' ? { code: 'prores', track: v }
            : !v.codec ? { code: 'video-codec', track: v } : { code: 'video-undecodable', track: v };
        } else p.notes.push({ code: 'video-dropped', track: v });
      }
      p.video.push(step);
    });
    var keptAudio = 0;
    info.audios.forEach(function (a) {
      var step = { id: a.id, action: 'drop' };
      var reencode = PCM.test(a.codec || '') || a.codec === 'vorbis' || (want === 'h264' && !matroska && a.codec && !PLAIN_AUDIO.test(a.codec));
      if (!a.codec) {
        p.notes.push({ code: 'audio-dropped', track: a, spatial: a.internal.toLowerCase() === 'apac' });
      } else if (reencode && a.canDecode && a.canAac) {
        step.action = 'aac';
        step.bitrate = aacBitrate(a);
        if (a.canAac === 'wasm') p.needs.aac = true;
        p.notes.push({ code: 'audio-aac', track: a });
        p.reencode = true;
        p.bytes += step.bitrate / 8 * span;
        p.seconds += span / 20;
      } else if (COPY_AUDIO.test(a.codec) || /^pcm-(s16|s24|s32|f32|f64)/.test(a.codec)) {
        step.action = 'copy';
        p.bytes += (a.bitrate || 0) / 8 * span;
        if (reencode) p.notes.push({ code: 'aac-unavailable', track: a });
        else if (!PLAIN_AUDIO.test(a.codec)) p.notes.push({ code: 'audio-copied', track: a });
      } else {
        p.notes.push({ code: 'aac-unavailable', track: a, dropped: true });
      }
      if (step.action !== 'drop') keptAudio++;
      p.audio.push(step);
    });
    if (!keptAudio) p.notes.push({ code: info.audios.length ? 'no-sound-left' : 'no-sound' });
    var kinds = new Map();
    info.others.forEach(function (o) { kinds.set(o.kind, (kinds.get(o.kind) || 0) + 1); });
    kinds.forEach(function (n, kind) { p.notes.push({ code: 'track-dropped', kind: kind, count: n }); });
    if (info.truncated) p.notes.push({ code: 'truncated', at: info.truncated.at, listed: info.truncated.listed });
    var lost = DROPPED.map(function (d) { return d[0]; }).filter(function (k) { return info.dropped[k]; });
    if (lost.length) p.notes.push({ code: 'metadata', lost: lost });
    p.seconds += p.bytes / 300e6;
    p.bytes = Math.round(p.bytes);
    p.ok = !p.refuse;
    return p;
  }

  // ---------- Output check ----------
  // Reads the finished index (moov) and checks every track that should be
  // there: mediabunny can report a conversion as valid while a track it
  // could not read came out empty.
  function checkIndex(bytes, expected) {
    var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var moov = child(v, 0, v.byteLength, 'moov');
    if (!moov) return { ok: false, why: 'no index' };
    var tracks = moovTracks(v, moov[0], moov[1]);
    var problems = [];
    ['vide', 'soun'].forEach(function (handler) {
      var want = expected.filter(function (x) { return x.handler === handler; });
      var got = tracks.filter(function (x) { return x.handler === handler; });
      if (got.length !== want.length) problems.push(handler + ': ' + got.length + ' of ' + want.length + ' tracks');
      want.forEach(function (w, i) {
        var g = got[i];
        if (!g) return;
        if (!g.samples) problems.push(handler + ' track ' + (i + 1) + ' is empty');
        else if (g.seconds < w.seconds * 0.8 - 0.25) problems.push(handler + ' track ' + (i + 1) + ' lasts ' + g.seconds.toFixed(2) + ' s of ' + w.seconds.toFixed(2) + ' s');
      });
    });
    return { ok: !problems.length, why: problems.join('; '), tracks: tracks };
  }

  // ---------- Sinks ----------
  // Both sinks commit what they were given only when the engine says the
  // file passed its check: mediabunny closes (rather than aborts) its stream
  // on cancel and on errors too.
  function memorySink() {
    if (typeof WritableStream === 'undefined' || typeof ReadableStream === 'undefined' || typeof Response === 'undefined') {
      var bt = new MB.BufferTarget();
      return {
        kind: 'memory', bytes: 0, target: bt, allow: function () {}, fail: function () {},
        finish: function () { return Promise.resolve(new Blob([bt.buffer], { type: 'video/mp4' })); }
      };
    }
    var head = new Uint8Array(HEAD), headEnd = 0, pos = HEAD, ctrl = null, wakeUp = null, allowed = false, done = false;
    var stream = new ReadableStream({
      start: function (c) { ctrl = c; },
      pull: function () { if (wakeUp) { var w = wakeUp; wakeUp = null; w(); } }
    }, new CountQueuingStrategy({ highWaterMark: 2 }));
    var blobPromise = new Response(stream).blob();
    blobPromise.catch(function () {});
    var sink = { kind: 'memory', bytes: 0 };
    function stop(reason) {
      if (done) return;
      done = true;
      try { ctrl.error(reason || err('canceled')); } catch (e) { /* already closed */ }
      if (wakeUp) { var w = wakeUp; wakeUp = null; w(); }
    }
    var writable = new WritableStream({
      write: async function (chunk) {
        if (done) throw err('canceled');
        var d = chunk.data, p = chunk.position;
        if (p < HEAD) {
          var n = Math.min(HEAD - p, d.byteLength);
          head.set(d.subarray(0, n), p);
          headEnd = Math.max(headEnd, p + n);
          d = d.subarray(n);
          p += n;
        }
        if (!d.byteLength) return;
        if (p !== pos || headEnd < HEAD) throw err('write', 'Output written out of order at ' + p);
        ctrl.enqueue(d.slice());
        pos += d.byteLength;
        sink.bytes = pos;
        while (!done && ctrl.desiredSize <= 0) await new Promise(function (r) { wakeUp = r; });
      },
      close: function () {
        if (!allowed) { stop(err('check')); return; }
        done = true;
        ctrl.close();
      },
      abort: function (reason) { stop(reason); }
    });
    sink.target = new MB.StreamTarget(writable, { chunked: true, chunkSize: CHUNK });
    sink.allow = function () { allowed = true; };
    sink.fail = function (reason) { stop(reason); };
    sink.finish = async function () {
      var rest = await blobPromise;
      sink.bytes = Math.max(headEnd, pos === HEAD ? headEnd : pos);
      return new Blob([head.subarray(0, Math.min(headEnd, HEAD)), rest], { type: 'video/mp4' });
    };
    return sink;
  }

  function canSaveToFile() { return typeof window.showSaveFilePicker === 'function'; }
  async function chooseFile(name) {
    try {
      return await window.showSaveFilePicker({
        suggestedName: name, id: 'tt-video',
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }]
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      if (e && (e.name === 'SecurityError' || e.name === 'NotAllowedError')) throw err('no-gesture', e.message);
      throw err('write', e && e.message);
    }
  }
  async function fileSink(handle) {
    var w = await handle.createWritable();
    var allowed = false, closed = false;
    var sink = { kind: 'file', bytes: 0, name: handle.name };
    function stop() {
      if (closed) return Promise.resolve();
      closed = true;
      return w.abort().catch(function () {});
    }
    var writable = new WritableStream({
      write: function (chunk) {
        sink.bytes = Math.max(sink.bytes, chunk.position + chunk.data.byteLength);
        return w.write({ type: 'write', position: chunk.position, data: chunk.data });
      },
      close: function () {
        if (!allowed) return stop();
        closed = true;
        return w.close();
      },
      abort: function () { return stop(); }
    });
    sink.target = new MB.StreamTarget(writable, { chunked: true, chunkSize: CHUNK });
    sink.allow = function () { allowed = true; };
    sink.fail = function () { stop(); };
    sink.finish = function () { return Promise.resolve(null); };
    return sink;
  }

  // ---------- Converting ----------
  // The ProRes decoder gives frames without colour information when the
  // frames leave it unset (ffmpeg's ProRes encoder does), and the H.264
  // encoder then guesses (an SD frame becomes BT.601). Such frames get the
  // container's colour tags, by copying their planes as they are.
  // (mediabunny re-draws frames on a canvas when `process` meets a rotated
  // video, so this is used for ProRes only.)
  function tagColour(cs) {
    var init = { primaries: cs.primaries, transfer: cs.transfer, matrix: cs.matrix, fullRange: !!cs.fullRange };
    return async function (sample) {
      if (!sample.format || (sample.colorSpace && sample.colorSpace.matrix)) return sample;
      var rect = sample.visibleRect, opts = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      var buf = new Uint8Array(sample.allocationSize(opts));
      var layout = await sample.copyTo(buf, opts);
      var out = new MB.VideoSample(buf, {
        format: sample.format, codedWidth: rect.width, codedHeight: rect.height,
        timestamp: sample.timestamp, duration: sample.duration, colorSpace: init, layout: layout
      });
      sample.close();
      return out;
    };
  }

  function convert(info, steps, options) {
    options = options || {};
    var canceled = false, conv = null, sink = options.sink, finished = false, stopJob = null;
    // A file whose reads never answer must not hold the page: cancelling
    // settles the job at once, whatever the library is still waiting for.
    var stopped = new Promise(function (_, reject) { stopJob = reject; });
    stopped.catch(function () {});
    var job = {
      cancel: function () {
        if (finished || canceled) return;
        canceled = true;
        if (conv) conv.cancel().catch(function () {});
        if (sink) sink.fail(err('canceled'));
        stopJob(err('canceled'));
      }
    };
    job.promise = run();
    return job;

    async function run() {
      var verdict = null, lastProgress = Date.now(), stalled = false, watch = null;
      warnings.length = 0;
      try {
        await load();
        if (steps.needs.prores) await loadProres();
        if (steps.needs.aac) await loadAac();
        if (canceled) throw err('canceled');
        var vOpts = new Map(), aOpts = new Map(), expected = [];
        var span = info.truncated ? info.truncated.at : info.duration;
        steps.video.forEach(function (s) {
          var v = info.videos.filter(function (x) { return x.id === s.id; })[0];
          if (s.action === 'drop') return;
          var o = {};
          if (s.action === 'h264') {
            o = { codec: 'avc', forceTranscode: true, quality: new MB.Quality({ bitrate: s.bitrate }) };
            // mediabunny crops on a canvas, which also turns the colours into full-range sRGB.
            if (s.crop) o.crop = s.crop;
            var cs = v.colour;
            if (v.codec === 'prores' && cs && cs.matrix && cs.primaries && cs.transfer) o.process = tagColour(cs);
          }
          vOpts.set(s.id, o);
          expected.push({ handler: 'vide', seconds: Math.max(0, span - Math.max(0, v.first)) });
        });
        steps.audio.forEach(function (s) {
          var a = info.audios.filter(function (x) { return x.id === s.id; })[0];
          if (s.action === 'drop') return;
          aOpts.set(s.id, s.action === 'aac' ? { codec: 'aac', forceTranscode: true, quality: new MB.Quality({ bitrate: s.bitrate }) } : {});
          expected.push({ handler: 'soun', seconds: Math.max(0, Math.min(span, a.duration || span) - Math.max(0, a.first)) });
        });
        var format = new MB.Mp4OutputFormat({
          fastStart: false,
          onMoov: function (data) { verdict = checkIndex(data, expected); if (verdict.ok) sink.allow(); }
        });
        var output = new MB.Output({ format: format, target: sink.target });
        // A damaged file must not hang the page: no progress for a while
        // (counted only while the page is visible) stops the job.
        var limit = (options.stallSeconds || 90) * 1000, last = Date.now(), quiet = 0;
        watch = setInterval(function () {
          var now = Date.now();
          if (document.visibilityState === 'visible') quiet += Math.min(5000, now - last);
          last = now;
          if (lastProgress > now - 1000) quiet = 0;
          if (quiet > limit && !canceled) { stalled = true; job.cancel(); }
        }, 1000);
        conv = await Promise.race([MB.Conversion.init({
          input: info.input, output: output, showWarnings: false,
          trim: info.truncated ? { end: info.truncated.at } : undefined,
          video: function (track) { return vOpts.has(track.id) ? vOpts.get(track.id) : { discard: true }; },
          audio: function (track) { return aOpts.has(track.id) ? aOpts.get(track.id) : { discard: true }; },
          // The tags mediabunny reads (title, date, comment ...) without the
          // raw QuickTime keys (location, camera make and model, Apple's
          // local-time date), and the film's own creation time: left unset,
          // mediabunny would write the time of the conversion.
          tags: function (t) {
            var out = {};
            Object.keys(t || {}).forEach(function (k) { if (k !== 'raw' && k !== 'creationTime' && t[k] != null) out[k] = t[k]; });
            out.creationTime = info.created || null;
            return out;
          }
        }), stopped]);
        if (canceled) throw err('canceled');
        var lostTrack = conv.discardedTracks.filter(function (d) { return vOpts.has(d.track.id) || aOpts.has(d.track.id); })[0];
        if (lostTrack) throw err('lost-track', lostTrack.reason, { track: lostTrack.track.id, kind: lostTrack.track.type, reason: lostTrack.reason });
        if (!conv.isValid) throw err('lost-track', 'invalid');
        conv.onProgress = function (fraction, seconds) {
          lastProgress = Date.now();
          if (options.onProgress) options.onProgress(Math.max(0, Math.min(1, fraction)), seconds);
        };
        lastProgress = Date.now();
        await Promise.race([conv.execute(), stopped]);
        clearInterval(watch);
        if (canceled) throw err(stalled ? 'stalled' : 'canceled');
        if (!verdict) throw err('check', 'no index written');
        if (!verdict.ok) throw err('check', verdict.why);
        var blob = await sink.finish();
        finished = true;
        return { bytes: blob ? blob.size : sink.bytes, blob: blob, saved: sink.kind === 'file', name: sink.name || '', warnings: warnings.slice() };
      } catch (e) {
        if (sink) sink.fail(e);
        var code = stalled ? 'stalled' : canceled ? 'canceled' : e && e.code ? e.code
          : e && (e.name === 'ConversionCanceledError' || (MB && e instanceof MB.ConversionCanceledError)) ? 'canceled'
          : e && /out of memory|allocation failed|could not allocate/i.test(e.message || '') ? 'memory'
          : e && /NotReadable|NotFound|QuotaExceeded|NoModificationAllowed|InvalidState/.test(e.name || '') ? 'write' : 'failed';
        throw err(code, (e && e.message) || String(e), { track: e && e.track, kind: e && e.kind, reason: e && e.reason, original: e && e.name });
      } finally {
        if (watch) clearInterval(watch);
        finished = true;
      }
    }
  }

  // ---------- Wake lock ----------
  var lock = null, wanted = false;
  function wake(on) {
    wanted = !!on;
    if (!navigator.wakeLock) return;
    if (on && !lock && document.visibilityState === 'visible') {
      lock = 'pending';
      navigator.wakeLock.request('screen').then(function (l) {
        if (!wanted) { l.release().catch(function () {}); lock = null; return; }
        lock = l;
        l.addEventListener('release', function () { if (lock === l) lock = null; });
      }, function () { lock = null; });
    } else if (!on && lock && lock !== 'pending') {
      var l = lock;
      lock = null;
      l.release().catch(function () {});
    }
  }
  // The browser drops the lock when the page is hidden; take it again on return.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wanted) wake(true);
  });

  // ---------- Names ----------
  function outputName(name, used) {
    var stem = String(name || '').replace(/\.[^.\/\\]{1,8}$/, '').trim() || 'video';
    if (/\.mp4$/i.test(String(name || ''))) stem += ' (converted)';
    var base = stem.slice(0, 120), out = base + '.mp4';
    for (var i = 2; used && used.has(out.toLowerCase()); i++) out = base + ' (' + i + ').mp4';
    if (used) used.add(out.toLowerCase());
    return out;
  }

  function dispose(info) {
    if (info && info.input) { try { info.input.dispose(); } catch (e) { /* closed */ } info.input = null; }
  }

  window.TTVideo = {
    load: load, probe: probe, plan: plan, convert: convert,
    memorySink: memorySink, fileSink: fileSink, canSaveToFile: canSaveToFile, chooseFile: chooseFile,
    wake: wake, outputName: outputName, dispose: dispose, codecName: codecName,
    checkIndex: checkIndex, isPhone: PHONE, isIOS: IOS, simd: SIMD
  };
})();
