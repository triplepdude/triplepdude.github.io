/*
 * TTAudio: the audio engine of MP4 to MP3 and its pair pages (window.TTAudio).
 * It reads video and audio files with mediabunny (assets/vendor/mediabunny/,
 * loaded on first use together with its LAME MP3 encoder), decodes their sound
 * a piece at a time, or the whole track at once with decodeAudioData where the
 * browser has no streaming decoder for it, measures levels for a waveform,
 * cuts, fades, changes the volume, mixes to stereo or mono, and writes MP3,
 * WAV or M4A with tags. It has no page UI and stores nothing.
 *
 * Load it where it is needed; it loads nothing more until load() is called:
 *   <script src="{{ '/assets/js/audio-engine.js' | relative_url }}"></script>
 * The include _includes/audio-converter-tool.html is the page UI built on it.
 *
 * ORDER OF CALLS
 *   1. await TTAudio.load()                    before anything that reads a file
 *   2. var m = await TTAudio.open(file)        per file: m.tracks, m.primary, m.tags
 *   3. var src = await TTAudio.decodeSource(m, ti)   sound of track ti, then
 *        TTAudio.scan(src, levels, options)    waveform levels and the peak, and/or
 *        TTAudio.buffers(src, from, to)        AudioBuffers to play
 *   4. var job = TTAudio.convert(m, ti, options); var result = await job.promise
 *   5. TTAudio.close(m)                        when the file is removed
 * open(), decodeSource() and convert() call load() themselves, so a page that
 * cares only about the error of a failed load can skip step 1.
 *
 * ERRORS. What this engine throws for a reason it knows is an Error with
 * .code (below) and .userText, a sentence for the visitor. A page may show
 * its own sentence for a code instead, as the include does for the codes
 * whose advice names other formats. Errors without a .code come from the
 * browser or mediabunny: TTAudio.describe(err, drm) turns any error into a
 * sentence (memory, decoding, protection, or "Something went wrong").
 *   LOAD         load(): mediabunny could not be fetched (offline, blocked).
 *   EMPTY        open(): the file has no bytes.
 *   UNREADABLE   open(): no container mediabunny reads.
 *   NO_SOUND     open(): a video without a sound track.
 *   NO_TRACKS    open(): neither sound nor picture (cut off, damaged).
 *   PROTECTED    open(): the default sound track is encrypted; .drm says how
 *                ('cenc', 'fairplay' or 'audible', also for .m4p, .aa and
 *                .aax files that cannot be read at all).
 *   EMPTY_TRACK  open(): the default sound track holds no sound.
 *   NO_DECODE    decodeSource(), convert(): this browser has no decoder for
 *                the codec (.track is the track info).
 *   TOO_LONG     decodeSource(), convert(): the track must be decoded whole,
 *                and it is longer than limits.whole seconds (.limit).
 *   NOT_AAC      convert() with format 'copy': only AAC is copied to .m4a.
 *   TOO_BIG      convert() with format 'wav': the WAV would be over
 *                limits.wav bytes (.bytes, .limit).
 *   NO_ENCODER   convert(): the browser cannot write the format (MP3
 *                without WebAssembly SIMD, or the encoder did not load).
 *   CANNOT_COPY  convert() with format 'copy': the packets cannot be copied.
 *   CANCELLED    convert(): job.cancel() was called (isCancel(err) is true).
 *
 * LOADING
 *   TTAudio.load() -> Promise. Loads mediabunny and, where WebAssembly SIMD
 *     exists, its MP3 encoder; once (later calls share the promise; after a
 *     failure the next call tries again). Rejects with LOAD.
 *   TTAudio.MB        the Mediabunny namespace once loaded (null before).
 *   TTAudio.simd      true when WebAssembly SIMD exists (the MP3 encoder needs it).
 *   TTAudio.canWriteMp3() -> true once the MP3 encoder is registered.
 *   TTAudio.PHONE     true on phones and tablets (smaller memory limits).
 *   TTAudio.limits    { wav: bytes of WAV built in memory (2 GB, 300 MB on a
 *     phone), zip: bytes put in one ZIP (the same), whole: seconds decoded at
 *     once without a streaming decoder (3600, 1200 on a phone) }.
 *   TTAudio.loadScript(url) -> Promise: a classic script, loaded once.
 *
 * OPENING A FILE
 *   TTAudio.open(file) -> Promise of a media object:
 *     { file, input (mediabunny Input),
 *       container: 'mp4' | 'mov' | 'mkv' | 'webm' | 'mp3' | 'wav' | 'ogg' |
 *                  'flac' | 'adts' | 'mpegts',
 *       tracks: [track info], primary: index of the file's default track,
 *       tags: the file's tags (see TAGS), drm: '' or how a track is protected }
 *     Track info:
 *     { track     the mediabunny InputAudioTrack
 *       codec     mediabunny's codec name ('aac', 'mp3', 'opus', 'vorbis',
 *                 'flac', 'ac3', 'pcm-s16', 'ulaw' ...), null when unknown
 *       internal  the container's codec id ('mp4a', 'alac', 'drms' ...), ''
 *       sr, ch    sample rate (Hz) and channels as the file states them
 *       lang, name  language code ('und' when none) and the track's title
 *       first     timestamp (s) of the first packet; may be negative
 *       t0        max(0, first): where the sound that is heard starts
 *       end       end (s) of the last packet whose data is in the file
 *       listed    end (s) the file's index lists; above end when it is cut off
 *       durMs     round((end - t0) * 1000), the length shown and cut in ms
 *       bitrate   bits per second; from the file's metadata, else measured
 *                 from the packets of the first 10 s (never a whole-file
 *                 scan); 0 for PCM and when unknown
 *       decodable this browser decodes it a piece at a time (WebCodecs, or
 *                 mediabunny's own PCM decoders)
 *       whole     it is not decodable, but decodeAudioData may read it: the
 *                 whole track is decoded at once (see decodeSource)
 *       drm       '' or 'cenc' | 'fairplay' | 'audible' for an encrypted
 *                 track ('enca', 'drms' or 'aavd'), which is never decoded }
 *     A WAV file is opened through wavSource() below, so a repair of its
 *     header can go there. Rejects with EMPTY, UNREADABLE, NO_SOUND,
 *     NO_TRACKS, PROTECTED or EMPTY_TRACK (the input is then disposed); other
 *     errors carry .drm when a protected sample was met.
 *   TTAudio.close(media)    disposes its input and any whole decode of it.
 *   TTAudio.codecName(track) -> 'AAC', 'AC-3 (Dolby Digital)', 'PCM' ...
 *   TTAudio.channelsText(n)  -> 'mono', 'stereo', '5.1 surround' ...
 *
 * THE SOUND OF A TRACK
 *   TTAudio.decodeSource(media, ti) -> Promise of { input, track, base }:
 *     what AudioSampleSink and AudioBufferSink read for track ti. A decodable
 *     track is the file's own (base = t0). A 'whole' track is copied out of
 *     the file, decoded with decodeAudioData and kept as 16-bit PCM in a WAV
 *     held in memory (base = 0); one such decode is kept at a time, for the
 *     last media and track asked for. Rejects with NO_DECODE or TOO_LONG.
 *   TTAudio.release(media)  drops the whole decode of media, if it holds one.
 *   TTAudio.buffers(src, from, to) -> async iterable of mediabunny's
 *     { buffer (AudioBuffer), timestamp, duration } from `from` to `to` (s, in
 *     src's own times: base + ms / 1000), for playing with Web Audio.
 *   TTAudio.mixGain(ch, mono) -> the factor the engine scales the mix of a
 *     ch-channel file by: sqrt(2) - 1 for 5.1 to stereo, 1 - 1/sqrt(2) for 5.1
 *     to mono, 1 otherwise. Web Audio mixes 5.1 the same way but unscaled, so
 *     a page playing a 5.1 file multiplies its gain by this to play what is
 *     written.
 *   TTAudio.gainFn(volume, fadeIn, fadeOut, len) -> function (t) giving the
 *     gain at t seconds into a selection len seconds long (linear fades).
 *
 * WAVEFORM AND PEAK
 *   TTAudio.levels(buckets) -> { min, max, monoMin, monoMax (Float32Arrays of
 *     `buckets`, min > max where nothing was read), filled: seconds read,
 *     done: false }.
 *   TTAudio.scan(src, lv, { dur, stopped, onUpdate }) -> Promise of true when
 *     done (lv.done is set), false when stopped() returned true. Reads the
 *     sound from src.base for dur seconds and keeps, per bucket, the lowest
 *     and highest sample of the sound as convert() writes it: min/max as
 *     stereo (or mono for a mono file), monoMin/monoMax as Mono. Quad and 5.1
 *     are mixed down as convert() mixes them, other layouts keep their first
 *     two channels (their first with Mono). onUpdate(lv) is called about every
 *     150 ms, after the page has had a turn. Rejects on decoding errors.
 *   TTAudio.peak(lv, from, to, mono) -> the highest |level| in the fractions
 *     from..to (0 to 1) of the track; -1 without levels.
 *
 * CONVERTING
 *   TTAudio.mp3Plan(sampleRate, kbps) -> { sampleRate, kbps }: what an MP3 of
 *     sound at sampleRate gets when kbps is asked. A rate MP3 has (8 to 48
 *     kHz) is kept and the bitrate lowered to what MPEG-2 (16 to 24 kHz: 160
 *     kbps) or MPEG-2.5 (8 to 12 kHz: 64 kbps) holds; other rates go to the
 *     nearest MP3 rate above them (44.1 or 48 kHz above 48 kHz).
 *   TTAudio.outChannels(track, mono) -> 1 or 2: channels of the result.
 *   TTAudio.estimate(media, ti, options) -> bytes the result will take about
 *     (0 when it cannot be told: a copy of a track whose bitrate is unknown).
 *   TTAudio.convert(media, ti, options) -> job { promise, cancel() }.
 *     options:
 *       format    'mp3' | 'wav' (16-bit PCM) | 'copy' (AAC packets copied
 *                 unchanged into .m4a; no effects, the cut rounded out to
 *                 whole packets)
 *       kbps      MP3 bitrate, 64 to 320 (default 192; see mp3Plan)
 *       mono      true for one channel: the average of left and right, quad
 *                 and 5.1 mixed as in scan(), the first channel of others
 *       sel       { start, end } in ms from t0 (default the whole track)
 *       volume    gain factor (default 1); fadeIn, fadeOut: seconds
 *       tags      a tag model (see TAGS) to write, or null to write no tags
 *       onProgress(fraction)
 *     promise resolves { blob, ext ('mp3' | 'wav' | 'm4a'), mime, sampleRate,
 *     channels, kbps (MP3) }. Rejects with CANCELLED, NO_DECODE, TOO_LONG,
 *     NOT_AAC, TOO_BIG, NO_ENCODER or CANNOT_COPY, or another error.
 *     A WAV keeps the sample rate of the sound; an MP3 gets mp3Plan()'s.
 *     Three functions inside are the one place for what they do: finishMp3()
 *     finishes every MP3 before it is returned (the place for a gapless fix
 *     of its Xing/LAME frame), wavOutput(tags, options) gives the format,
 *     codec and tags of every WAV (the place for 24-bit, float and RF64), and
 *     resampleStage(from, to) sets the sample rate of every MP3 and WAV, as
 *     conversion options and an optional step run after the volume and fades
 *     (the place for a better resampler). With wavSource() above they are
 *     where the WAV header repair, the WAV writer and the resampler of the
 *     pair pages go.
 *   TTAudio.isCancel(err) -> true for a cancelled conversion.
 *   TTAudio.describe(err, drm) -> a sentence for any error.
 *   TTAudio.yieldNow() -> Promise resolved on the next turn of the event loop
 *     (a message, which a background tab does not slow down as it does timers).
 *
 * TAGS
 *   A tag model: { title, artist, album, albumArtist, composer, genre,
 *   comment, lyrics: strings ('' when absent); date: 'YYYY', 'YYYY-MM' or
 *   'YYYY-MM-DD', as precise as the file has it ('' when absent); track,
 *   tracks, disc, discs: whole numbers (0 when absent); images: [{ data
 *   (Uint8Array), mimeType ('image/jpeg', 'image/png', 'image/gif' or
 *   'image/webp'), kind ('coverFront', 'coverBack' or 'unknown'),
 *   description }] }.
 *   open() reads them from MP4 and MOV (iTunes ilst: ©nam, ©ART, aART, ©alb,
 *   ©wrt, ©day, trkn, disk, ©gen, ©cmt, ©lyr, covr), ID3v1 and ID3v2.2 to
 *   v2.4 (MP3, ADTS, FLAC, WAV id3 chunks), RIFF INFO (text in UTF-8 when it
 *   is valid UTF-8, else Windows-1252), Vorbis comments (Ogg, FLAC) and
 *   Matroska tags. Fields a page does not want can be blanked before
 *   convert(); convert() writes what is left:
 *     MP3  an ID3v2.3 tag (TIT2, TPE1, TALB, TPE2, TRCK, TPOS, TCOM, TYER and
 *          TDAT, TCON, COMM, USLT, APIC; ISO-8859-1 where the text fits, else
 *          UTF-16 with a BOM; no unsynchronisation) and a 128-byte ID3v1.1
 *          tag at the end (text cut at the first letter ISO-8859-1 lacks).
 *     M4A  iTunes tags through mediabunny (the year as written, composer).
 *     WAV  RIFF INFO when every text is ISO-8859-1 and nothing needs more,
 *          else an ID3 chunk (ID3v2.4, through mediabunny).
 *   TTAudio.emptyTags() -> a model with nothing in it.
 *   TTAudio.id3v23(tags) -> Uint8Array (empty when there is nothing to write).
 *   TTAudio.id3v1(tags)  -> Uint8Array of 128 bytes, or null.
 *   TTAudio.finishMp3(bytes, tags, info) -> Blob of the MP3 as saved.
 *   TTAudio.mbTags(tags, kind) -> mediabunny MetadataTags for kind 'm4a',
 *     'wav-info' or 'wav-id3'; TTAudio.wavTagFormat(tags) -> 'info' | 'id3'.
 *
 * TTAudio.text holds the default sentences; a page may replace them before
 * opening files (the include changes `unreadable` on audio pages).
 */
(function () {
  'use strict';

  var SCRIPT = document.currentScript && document.currentScript.src;
  var VENDOR = new URL('../vendor/mediabunny/', SCRIPT || new URL('/assets/js/audio-engine.js', location.href).href).href;
  var LIB_URL = VENDOR + 'mediabunny.min.js';
  var MP3_URL = VENDOR + 'mediabunny-mp3-encoder.min.js';

  var UA = navigator.userAgent;
  var PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
  var LIMITS = {
    wav: PHONE ? 300e6 : 2e9,       // bytes of WAV built in memory
    zip: PHONE ? 300e6 : 2e9,       // bytes put in one ZIP
    whole: PHONE ? 1200 : 3600      // seconds decoded at once without a streaming decoder
  };
  // A module with one WebAssembly SIMD instruction: the MP3 encoder needs SIMD.
  var SIMD = (function () {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  })();
  var STATS_SECONDS = 10;           // packets measured for a bitrate the file does not state
  var PROTECTED_MARK = 'tt-audio-protected';
  // Encrypted sample entries: CENC (films, streaming), Apple FairPlay, Audible.
  var DRM_ENTRIES = { enca: 'cenc', drms: 'fairplay', aavd: 'audible' };
  // Codecs that decodeAudioData may read where no streaming decoder does
  // (Firefox for Android, Safari before 26, a WebCodecs without the codec).
  // Without AudioDecoder every known codec is tried, as some browsers read
  // AC-3 too.
  var WHOLE_CODECS = /^(aac|mp3|opus|vorbis|flac|ulaw|alaw|pcm-.*)$/;
  // mediabunny and Web Audio mix 5.1 to stereo as L + 0.707 (C + SL) and to
  // mono as 0.707 (L + R) + C + 0.5 (SL + SR); scaled by these, a full-scale
  // file cannot go over full scale. Quad (0.5 (L + SL)) needs no scaling.
  var K51_STEREO = Math.SQRT2 - 1;
  var K51_MONO = 1 - Math.SQRT1_2;
  var CODECS = new Map([['aac', 'AAC'], ['mp3', 'MP3'], ['opus', 'Opus'], ['vorbis', 'Vorbis'], ['flac', 'FLAC'],
    ['ac3', 'AC-3 (Dolby Digital)'], ['eac3', 'E-AC-3 (Dolby Digital Plus)'], ['dts', 'DTS'], ['truehd', 'Dolby TrueHD'],
    ['ulaw', 'µ-law'], ['alaw', 'A-law']]);

  var TEXT = {
    load: 'The converter could not be loaded. Check the connection and reload the page.',
    empty: 'This file is empty.',
    unreadable: 'This is not a video or audio file that this page can read. It reads MP4, MOV, WebM, MKV, M4A, MP3, WAV, OGG, FLAC and MPEG-TS files.',
    noSound: 'This video has no sound track, so there is no audio to save.',
    noTracks: 'No sound or video was found in this file. It may be incomplete, such as a copy or download that did not finish, or damaged.',
    emptyTrack: 'Its sound track is empty, so there is no audio to save. The file may be incomplete or damaged.',
    cenc: 'This file is protected with DRM (encrypted), so its sound cannot be read. Films and music bought or rented from a store are usually protected.',
    fairplay: 'This file is copy-protected (Apple FairPlay DRM), so it cannot be converted. Apple Music downloads are protected this way, and so are iTunes Store songs bought before April 2009 and never upgraded to iTunes Plus.',
    audible: 'This file is copy-protected (Audible DRM), so it cannot be converted. Audible audiobooks (.aa and .aax files) are protected this way.',
    noDecode: 'This browser cannot decode {codec} audio.',
    tooLong: 'This browser has to decode the whole sound track at once, which works up to {minutes} minutes on this device.',
    notAac: 'Its audio is {codec}, not AAC, so it cannot be copied into an .m4a file.',
    tooBig: 'As WAV this would be about {size}, more than the {limit} this device can build in memory.',
    noEncoder: 'This browser cannot write this format here.',
    cannotCopy: 'This sound cannot be copied without re-encoding.',
    memory: 'The browser ran out of memory. Try MP3 instead of WAV, a shorter selection, or a computer.',
    decode: 'The sound could not be decoded. The file may be damaged, or this browser may not support its codec.',
    other: 'Something went wrong while reading this file ({message}).'
  };

  var MB = null;
  var mp3Ok = false;
  var api;

  // ---------- Small helpers ----------
  function cut(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    var i = n;
    if (/[\uD800-\uDBFF]/.test(s.charAt(i - 1))) i--;
    return s.slice(0, i);
  }
  function fill(text, values) {
    return text.replace(/\{(\w+)\}/g, function (m, k) { return values && values[k] != null ? String(values[k]) : m; });
  }
  function coded(code, text, extra) {
    var e = new Error(text);
    e.code = code;
    e.userText = text;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }
  function fmtBytes(n) {
    if (n < 1000) return n + ' bytes';
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + ' KB';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB';
    return (n / 1e9).toFixed(2) + ' GB';
  }
  // Lets clicks and drawing through during long work. Sound decoded in
  // JavaScript (WAV) resolves only promises, which would hold the page until
  // done. A message, unlike a timer, is not slowed down in a background tab.
  var yieldPort = new MessageChannel(), yieldQueue = [];
  yieldPort.port1.onmessage = function () { var r = yieldQueue.shift(); if (r) r(); };
  function yieldNow() { return new Promise(function (r) { yieldQueue.push(r); yieldPort.port2.postMessage(0); }); }

  function codecName(t) {
    if (!t.codec) return t.internal ? 'an unknown codec (' + t.internal + ')' : 'an unknown codec';
    if (/^pcm-/.test(t.codec)) return 'PCM';
    return CODECS.get(t.codec) || t.codec.toUpperCase();
  }
  function channelsText(n) {
    return n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1 surround' : n === 8 ? '7.1 surround' : n + ' channels';
  }

  // ---------- Loading ----------
  var scripts = new Map();
  function loadScript(url) {
    if (scripts.has(url)) return scripts.get(url);
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(); };
      s.onerror = function () { scripts.delete(url); reject(new Error('Could not load ' + url)); };
      document.head.appendChild(s);
    });
    scripts.set(url, p);
    return p;
  }
  var libPromise = null;
  function load() {
    if (!libPromise) {
      libPromise = loadScript(LIB_URL).then(function () {
        if (!window.Mediabunny) throw new Error('no library');
        MB = api.MB = window.Mediabunny;
        if (!SIMD) return;
        return loadScript(MP3_URL).then(function () { window.MediabunnyMp3Encoder.registerMp3Encoder(); mp3Ok = true; }, function () {});
      }).catch(function (e) { libPromise = null; throw coded('LOAD', TEXT.load, { cause: e }); });
    }
    return libPromise;
  }

  // ---------- Opening a file ----------
  function drmError(kind) {
    return coded('PROTECTED', TEXT[kind] || TEXT.cenc, { drm: kind });
  }
  function containerOf(fmt) {
    var pairs = [[MB.MP4, 'mp4'], [MB.QTFF, 'mov'], [MB.WEBM, 'webm'], [MB.MATROSKA, 'mkv'], [MB.MP3, 'mp3'], [MB.WAVE, 'wav'],
      [MB.OGG, 'ogg'], [MB.FLAC, 'flac'], [MB.ADTS, 'adts'], [MB.MPEG_TS, 'mpegts']];
    for (var i = 0; i < pairs.length; i++) if (pairs[i][0] && fmt === pairs[i][0]) return pairs[i][1];
    return fmt instanceof MB.IsobmffInputFormat ? 'mp4' : 'other';
  }
  // The source mediabunny reads a file from. A WAV file comes through
  // wavSource(), the one place where a WAV is opened.
  async function sourceFor(file) {
    var head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    var tag = String.fromCharCode.apply(null, head.subarray(0, 4)), form = String.fromCharCode.apply(null, head.subarray(8, 12));
    if ((tag === 'RIFF' || tag === 'RF64' || tag === 'RIFX') && form === 'WAVE') return wavSource(file, head);
    return new MB.BlobSource(file, { handleUnhandledError: function () {} });
  }
  // Every WAV file is opened here; head is its first 12 bytes. (A repair of
  // headers whose sizes are wrong, such as an RF64 wrapper for files over
  // 4 GB, belongs here.)
  function wavSource(file, head) {
    return new MB.BlobSource(file, { handleUnhandledError: function () {} });
  }

  async function open(file) {
    await load();
    var name = String(file && file.name || '');
    var nameDrm = /\.m4p$/i.test(name) ? 'fairplay' : /\.aax?$/i.test(name) ? 'audible' : '';
    var m = { file: file, input: null, container: 'other', tracks: [], primary: 0, tags: emptyTags(), drm: '' };
    try {
      if (!file || !(file.size > 0)) throw coded('EMPTY', TEXT.empty);
      m.input = new MB.Input({
        source: await sourceFor(file),
        formats: MB.ALL_FORMATS,
        formatOptions: { isobmff: { resolveKeyId: function () { m.drm = m.drm || 'cenc'; throw new Error(PROTECTED_MARK); } } }
      });
      if (!(await m.input.canRead())) throw nameDrm ? drmError(nameDrm) : coded('UNREADABLE', TEXT.unreadable);
      var fmt = await m.input.getFormat();
      m.container = containerOf(fmt);
      var tracks = await m.input.getAudioTracks();
      if (!tracks.length) {
        var videos = await m.input.getVideoTracks();
        throw videos.length ? coded('NO_SOUND', TEXT.noSound) : nameDrm ? drmError(nameDrm) : coded('NO_TRACKS', TEXT.noTracks);
      }
      var primary = await m.input.getPrimaryAudioTrack();
      var indexed = fmt instanceof MB.IsobmffInputFormat;
      for (var i = 0; i < tracks.length; i++) {
        m.tracks.push(await trackInfo(m, tracks[i], indexed));
        if (tracks[i] === primary) m.primary = i;
      }
      var p = m.tracks[m.primary];
      if (p.drm) { m.drm = p.drm; throw drmError(p.drm); }
      if (!(p.durMs > 0)) throw coded('EMPTY_TRACK', TEXT.emptyTrack);
      m.tags = await readTags(m);
      return m;
    } catch (err) {
      if (m.input) { try { m.input.dispose(); } catch (x) { /* already gone */ } }
      m.input = null;
      if (m.drm && err && typeof err === 'object' && !err.drm) { try { err.drm = m.drm; } catch (x) { /* frozen */ } }
      throw err;
    }
  }

  async function trackInfo(m, tr, indexed) {
    var internal = await tr.getInternalCodecId();
    var info = {
      track: tr, codec: await tr.getCodec(),
      internal: typeof internal === 'string' || typeof internal === 'number' ? String(internal).replace(/[^\w.\-]/g, '').slice(0, 16) : '',
      sr: await tr.getSampleRate(), ch: await tr.getNumberOfChannels(), lang: await tr.getLanguageCode(), name: oneLine(await tr.getName(), 200),
      first: await tr.getFirstTimestamp(), end: await tr.computeDuration(), bitrate: (await tr.getAverageBitrate()) || (await tr.getBitrate()) || 0
    };
    info.drm = DRM_ENTRIES[info.internal] || '';
    // MP4 and MOV files list their samples in an index. In a file that was
    // cut short the index promises more sound than there is, so the sound
    // ends with the last sample whose data is in the file.
    info.listed = info.end;
    if (indexed && !info.drm) {
      try { info.end = await readableEnd(tr, info.first, info.end); } catch (x) { if (m.drm) throw x; }
    }
    info.decodable = !info.drm && !!info.codec && (await tr.canDecode());
    info.whole = !info.decodable && !info.drm && !!info.codec && typeof OfflineAudioContext !== 'undefined' &&
      (typeof AudioDecoder === 'undefined' || WHOLE_CODECS.test(info.codec));
    info.t0 = Math.max(0, info.first || 0);
    info.durMs = Math.max(0, Math.round((info.end - info.t0) * 1000));
    if (!info.bitrate && !info.drm && info.codec && !/^pcm-/.test(info.codec)) info.bitrate = await measureBitrate(tr);
    return info;
  }

  // The end of the last sample whose data is in the file. A file that was cut
  // short loses its tail, so every sample after the first missing one is
  // missing too, and halving the gap finds it in a few reads.
  async function readableEnd(tr, first, end) {
    var sink = new MB.EncodedPacketSink(tr);
    if (await sink.getPacket(Infinity)) return end;
    var p = await sink.getPacket(first);
    if (!p) return first;
    var lo = p.timestamp, hi = end;
    while (hi - lo > 0.001) {
      var mid = (lo + hi) / 2, q = await sink.getPacket(mid);
      if (q) { p = q; lo = mid; } else hi = mid;
    }
    return p.timestamp + p.duration;
  }

  // Bits per second from the sizes of the packets of the first 10 s: files
  // made by ffmpeg and many phones state no bitrate. Reading only the start
  // keeps this quick for a 4 GB video or a two-hour index. The last packet
  // read is left out, as containers often cut its duration short: the rate
  // is the bytes before it over the time to it.
  async function measureBitrate(tr) {
    try {
      var sink = new MB.EncodedPacketSink(tr), bytes = 0, first = null, last = null;
      for await (var p of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (first === null) first = p;
        else bytes += last.byteLength;
        last = p;
        if (p.timestamp >= first.timestamp + STATS_SECONDS) break;
      }
      if (!first) return 0;
      if (last === first) return first.duration > 0 ? first.byteLength * 8 / first.duration : 0;
      var span = last.timestamp - first.timestamp;
      return span > 0 && bytes > 0 ? bytes * 8 / span : 0;
    } catch (e) {
      return 0;
    }
  }

  function close(m) {
    if (!m) return;
    release(m);
    if (m.input) { try { m.input.dispose(); } catch (x) { /* ignore */ } }
    m.input = null;
  }

  // ---------- Tags ----------
  function emptyTags() {
    return { title: '', artist: '', album: '', albumArtist: '', composer: '', genre: '', comment: '', lyrics: '',
      date: '', track: 0, tracks: 0, disc: 0, discs: 0, images: [] };
  }
  // Text of a tag on one line: no control characters, at most n characters.
  function oneLine(s, n) {
    return cut(String(s == null ? '' : s).slice(0, n * 4).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim(), n);
  }
  // Lyrics and comments keep their line breaks.
  function lines(s, n) {
    return cut(String(s == null ? '' : s).slice(0, n * 4).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, ' ').trim(), n);
  }
  function whole(n) { n = Math.floor(+n); return n > 0 && n < 1e6 ? n : 0; }
  function rawText(raw, keys) {
    for (var i = 0; i < keys.length; i++) {
      var want = keys[i].toLowerCase();
      for (var k in raw) {
        if (k.toLowerCase() !== want) continue;
        var v = raw[k];
        if (Array.isArray(v)) v = v[0];
        if (typeof v === 'string' && v.trim()) return v;
      }
    }
    return '';
  }
  // A date as precise as it is written: 2019, 2019-05 or 2019-05-03.
  function dateText(s, ddmm) {
    var m = /^\s*(\d{4})(?:[-.\/](\d{1,2})(?:[-.\/](\d{1,2}))?)?/.exec(String(s || ''));
    if (!m || +m[1] < 1) return '';
    var out = m[1], mo = m[2] ? +m[2] : 0, d = m[3] ? +m[3] : 0;
    var dm = /^(\d{2})(\d{2})$/.exec(String(ddmm || '').trim());   // ID3v2.3 TDAT: DDMM
    if (!mo && dm) { d = +dm[1]; mo = +dm[2]; }
    if (mo >= 1 && mo <= 12) {
      out += '-' + (mo < 10 ? '0' : '') + mo;
      if (d >= 1 && d <= 31) out += '-' + (d < 10 ? '0' : '') + d;
    }
    return out;
  }
  // RIFF INFO text is bytes in no stated character set (mediabunny gives each
  // byte as one character): UTF-8 when the bytes are valid UTF-8, as ffmpeg
  // and most tools now write it, else Windows-1252.
  function infoText(s) {
    if (typeof s !== 'string' || !/[\u0080-\u00FF]/.test(s) || /[^\u0000-\u00FF]/.test(s)) return s;
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
  var INFO_FIELDS = { title: ['INAM', 'TITL'], artist: ['IART'], album: ['IPRD'], genre: ['IGNR', 'GENR'], comment: ['ICMT', 'CMNT', 'COMM'] };

  async function readTags(m) {
    var t = {};
    try { t = await m.input.getMetadataTags() || {}; } catch (e) { t = {}; }
    var raw = t.raw && typeof t.raw === 'object' ? t.raw : {};
    var out = emptyTags();
    out.title = oneLine(t.title, 1000);
    out.artist = oneLine(t.artist, 1000);
    out.album = oneLine(t.album, 1000);
    out.albumArtist = oneLine(t.albumArtist, 1000);
    out.genre = oneLine(t.genre, 1000);
    out.comment = lines(t.comment, 10000);
    out.lyrics = lines(t.lyrics, 100000);
    out.track = whole(t.trackNumber);
    out.tracks = whole(t.tracksTotal);
    out.disc = whole(t.discNumber);
    out.discs = whole(t.discsTotal);
    if (m.container === 'wav') {
      // Fields that came from RIFF INFO (mediabunny reads it as ISO-8859-1).
      Object.keys(INFO_FIELDS).forEach(function (f) {
        var norm = f === 'comment' ? function (x) { return lines(x, 10000); } : function (x) { return oneLine(x, 1000); };
        INFO_FIELDS[f].some(function (k) {
          if (typeof raw[k] !== 'string' || norm(raw[k]) !== out[f]) return false;
          out[f] = norm(infoText(raw[k]));
          return true;
        });
      });
    }
    // ffmpeg writes an MP3's comment and lyrics as TXXX frames.
    var txxx = raw.TXXX && typeof raw.TXXX === 'object' && !(raw.TXXX instanceof Uint8Array) ? raw.TXXX : {};
    if (!out.comment) out.comment = lines(rawText(txxx, ['comment', 'description']), 10000);
    if (!out.lyrics) out.lyrics = lines(rawText(txxx, ['lyrics', 'USLT', 'unsyncedlyrics', 'unsynced lyrics']), 100000);
    // Vorbis comments and Matroska tags: ffmpeg writes a comment as DESCRIPTION.
    if (!out.comment) out.comment = lines(rawText(raw, ['COMMENT', 'DESCRIPTION']), 10000);
    var composer = rawText(raw, ['©wrt', 'TCOM', 'TCM', 'COMPOSER', 'IMUS']);
    out.composer = oneLine(m.container === 'wav' ? infoText(composer) : composer, 1000);
    // The date as the file writes it, so that a year stays a year.
    var date = dateText(rawText(raw, ['©day', 'TDRC', 'TYER', 'TYE', 'DATE', 'YEAR', 'DATE_RELEASED', 'DATE_RECORDED', 'ICRD']),
      rawText(raw, ['TDAT', 'TDA']));
    if (!date && t.date instanceof Date && !isNaN(t.date)) {
      var d = t.date, y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate();
      if (d.getMonth() === 0 && d.getDate() === 1 && !d.getHours() && !d.getMinutes()) { y = d.getFullYear(); mo = 1; day = 1; }
      date = mo === 1 && day === 1 ? String(y) : dateText(y + '-' + mo + '-' + day);
    }
    out.date = date;
    out.images = (t.images || []).filter(function (im) {
      return im && im.data && im.data.byteLength && /^image\/(jpeg|png|gif|webp)$/i.test(im.mimeType || '');
    }).map(function (im) {
      return { data: im.data, mimeType: String(im.mimeType).toLowerCase(), kind: im.kind || 'unknown', description: oneLine(im.description, 64) };
    });
    return out;
  }

  // Text in ISO-8859-1 when every character fits, else UTF-16 with a BOM
  // (ID3v2.3 has no UTF-8). Returns [encoding byte, bytes, terminator].
  function id3Text(s) {
    if (/^[\u0000-\u00FF]*$/.test(s)) {
      var a = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return [0, a, [0]];
    }
    var b = new Uint8Array(2 + s.length * 2);
    b[0] = 0xFF; b[1] = 0xFE;
    for (var j = 0; j < s.length; j++) { var c = s.charCodeAt(j); b[2 + 2 * j] = c & 255; b[3 + 2 * j] = c >> 8; }
    return [1, b, [0, 0]];
  }
  function latin1(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
    return a;
  }
  function concatBytes(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  function id3Frame(id, body) {
    var h = new Uint8Array(10), n = body.length;
    for (var i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
    h[4] = n >>> 24 & 255; h[5] = n >>> 16 & 255; h[6] = n >>> 8 & 255; h[7] = n & 255;
    return concatBytes([h, body]);
  }
  // The ID3v2.3 tag of an MP3: Windows File Explorer and some car stereos
  // read v2.3 and skip v2.4, which mediabunny writes.
  function id3v23(tags) {
    tags = tags || {};
    var frames = [];
    function text(id, v) {
      v = String(v == null ? '' : v);
      if (!v) return;
      var e = id3Text(v);
      frames.push(id3Frame(id, concatBytes([[e[0]], e[1]])));
    }
    function described(id, v) {
      v = String(v == null ? '' : v);
      if (!v) return;
      var e = id3Text(v), empty = e[0] ? new Uint8Array([0xFF, 0xFE, 0, 0]) : new Uint8Array([0]);
      frames.push(id3Frame(id, concatBytes([[e[0]], latin1('eng'), empty, e[1]])));
    }
    text('TIT2', tags.title);
    text('TPE1', tags.artist);
    text('TALB', tags.album);
    text('TPE2', tags.albumArtist);
    if (whole(tags.track)) text('TRCK', whole(tags.track) + (whole(tags.tracks) ? '/' + whole(tags.tracks) : ''));
    if (whole(tags.disc)) text('TPOS', whole(tags.disc) + (whole(tags.discs) ? '/' + whole(tags.discs) : ''));
    text('TCOM', tags.composer);
    var date = dateText(tags.date);
    if (date) {
      text('TYER', date.slice(0, 4));
      if (date.length === 10) text('TDAT', date.slice(8, 10) + date.slice(5, 7));
    }
    text('TCON', tags.genre);
    described('COMM', tags.comment);
    described('USLT', tags.lyrics);
    var images = (tags.images || []).filter(function (im) { return im && im.data && im.data.length; });
    var front = images.some(function (im) { return im.kind === 'coverFront'; }), seen = new Set();
    images.forEach(function (im, i) {
      var type = im.kind === 'coverFront' || (!front && i === 0) ? 3 : im.kind === 'coverBack' ? 4 : 0;
      // Each picture needs a description of its own.
      var desc = oneLine(im.description, 64), base = desc, k = 2;
      while (seen.has(desc)) desc = base + ' (' + k++ + ')';
      seen.add(desc);
      var e = id3Text(desc);
      frames.push(id3Frame('APIC', concatBytes([[e[0]], latin1(String(im.mimeType || 'image/jpeg').toLowerCase()), [0], [type], e[1], e[2],
        im.data instanceof Uint8Array ? im.data : new Uint8Array(im.data)])));
    });
    if (!frames.length) return new Uint8Array(0);
    var body = concatBytes(frames), n = body.length;
    if (n >= 1 << 28) return new Uint8Array(0);   // beyond what a tag can hold
    var head = new Uint8Array([73, 68, 51, 3, 0, 0, n >>> 21 & 127, n >>> 14 & 127, n >>> 7 & 127, n & 127]);
    return concatBytes([head, body]);
  }

  // ID3v1 genres 0 to 79, for the genre byte.
  var GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies',
    'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack',
    'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
    'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock',
    'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult',
    'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes',
    'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];
  // The start of s that is all ISO-8859-1 printing characters and fits n
  // bytes: text is cut at the first character ID3v1 cannot hold, never
  // turned into question marks.
  function latinStart(s, n) {
    s = String(s == null ? '' : s);
    var out = [];
    for (var i = 0; i < s.length && out.length < n; i++) {
      var c = s.charCodeAt(i);
      if (c < 32 || c > 255 || (c >= 127 && c < 160)) break;
      out.push(c);
    }
    while (out.length && out[out.length - 1] === 32) out.pop();
    return out;
  }
  // A 128-byte ID3v1.1 tag for very old players.
  function id3v1(tags) {
    tags = tags || {};
    var date = dateText(tags.date), track = whole(tags.track);
    var fields = [[3, 30, tags.title], [33, 30, tags.artist], [63, 30, tags.album], [93, 4, date.slice(0, 4)], [97, 28, String(tags.comment || '').split('\n')[0]]];
    var b = new Uint8Array(128), any = false;
    b[0] = 84; b[1] = 65; b[2] = 71;   // TAG
    fields.forEach(function (f) {
      var bytes = latinStart(f[2], f[1]);
      if (bytes.length) { b.set(bytes, f[0]); any = true; }
    });
    if (track > 0 && track < 256) { b[126] = track; any = true; }
    var g = String(tags.genre || '').trim().toLowerCase(), gi = -1;
    for (var i = 0; i < GENRES.length && g; i++) if (GENRES[i].toLowerCase() === g) gi = i;
    b[127] = gi >= 0 ? gi : 255;
    if (gi >= 0) any = true;
    return any ? b : null;
  }

  // Every MP3 this engine makes is finished here before it is returned: the
  // ID3v2.3 tag goes in front of the frames, the ID3v1 tag after them. (The
  // place for the gapless fix of the Xing/LAME frame: `info` holds what the
  // conversion knows, { sampleRate, channels, kbps, samples }.)
  function finishMp3(bytes, tags, info) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var parts = [], head = tags ? id3v23(tags) : new Uint8Array(0), tail = tags ? id3v1(tags) : null;
    if (head.length) parts.push(head);
    parts.push(u8);
    if (tail) parts.push(tail);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  // mediabunny's tags for an M4A ('m4a') or a WAV ('wav-info', 'wav-id3').
  // Three fields go in as raw tags, round mediabunny 1.65.2: a year-only
  // date would become 1 January, its 'disc' atom should be 'disk', and its
  // ID3 USLT frame gets a wrong size for lyrics that are not ISO-8859-1.
  function mbTags(tags, kind) {
    var t = { creationTime: null };
    if (!tags) return t;
    ['title', 'artist', 'album', 'albumArtist', 'genre', 'comment'].forEach(function (k) { if (tags[k]) t[k] = String(tags[k]); });
    if (whole(tags.track)) { t.trackNumber = whole(tags.track); if (whole(tags.tracks)) t.tracksTotal = whole(tags.tracks); }
    var raw = {}, date = dateText(tags.date), disc = whole(tags.disc), discs = whole(tags.discs), lyrics = tags.lyrics ? String(tags.lyrics) : '';
    if (kind === 'm4a') {
      if (date) raw['©day'] = date;
      if (tags.composer) raw['©wrt'] = String(tags.composer);
      if (disc) raw.disk = new Uint8Array([0, 0, disc >> 8 & 255, disc & 255, discs >> 8 & 255, discs & 255]);
      if (lyrics) t.lyrics = lyrics;
    } else if (kind === 'wav-id3') {
      if (date) raw.TDRC = date;
      if (tags.composer) raw.TCOM = String(tags.composer);
      if (disc) raw.TPOS = disc + (discs ? '/' + discs : '');
      // USLT: UTF-8, language und, no description.
      if (lyrics) raw.USLT = concatBytes([[3], latin1('und'), [0], new TextEncoder().encode(lyrics), [0]]);
    } else if (date) raw.ICRD = date;
    if (Object.keys(raw).length) t.raw = raw;
    var images = (tags.images || []).filter(function (im) { return im && im.data && im.data.length; });
    if (images.length && kind !== 'wav-info') t.images = images;
    return t;
  }
  // RIFF INFO holds only ISO 8859-1 text and no pictures, album artist,
  // composer, disc or lyrics: anything more goes in an ID3 chunk.
  function wavTagFormat(tags) {
    if (!tags) return 'info';
    if ((tags.images || []).some(function (im) { return im && im.data && im.data.length; })) return 'id3';
    if (tags.albumArtist || tags.composer || tags.lyrics || whole(tags.disc)) return 'id3';
    return ['title', 'artist', 'album', 'genre', 'comment'].every(function (k) { return !tags[k] || /^[\u0000-\u00FF]*$/.test(tags[k]); }) ? 'info' : 'id3';
  }

  // ---------- The sound of a track ----------
  function noDecode(t) { return coded('NO_DECODE', fill(TEXT.noDecode, { codec: codecName(t) }), { track: t }); }
  var whole1 = null;   // the one whole-track decode kept: { m, t, promise }
  function decodeSource(m, ti) {
    var t = m.tracks[ti];
    if (t.decodable) return Promise.resolve({ input: m.input, track: t.track, base: t.t0 });
    if (!t.whole) return Promise.reject(noDecode(t));
    if (whole1 && whole1.m === m && whole1.t === t) return whole1.promise;
    releaseWhole();
    var w = whole1 = { m: m, t: t };
    w.promise = load().then(function () { return buildWhole(m, t); }).catch(function (err) { if (whole1 === w) whole1 = null; throw err; });
    return w.promise;
  }
  function releaseWhole() {
    if (!whole1) return;
    var w = whole1;
    whole1 = null;
    w.promise.then(function (src) { try { src.input.dispose(); } catch (x) { /* ignore */ } }, function () {});
  }
  function release(m) { if (whole1 && whole1.m === m) releaseWhole(); }
  // Browsers without a streaming decoder for the codec decode the whole
  // sound track with decodeAudioData. Only the audio is copied out first.
  async function buildWhole(m, t) {
    if (t.durMs / 1000 > LIMITS.whole) {
      throw coded('TOO_LONG', fill(TEXT.tooLong, { minutes: LIMITS.whole / 60 }), { limit: LIMITS.whole });
    }
    var format = t.codec === 'mp3' ? new MB.Mp3OutputFormat() : t.codec === 'flac' ? new MB.FlacOutputFormat()
      : (t.codec === 'opus' || t.codec === 'vorbis') ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat();
    var out = new MB.Output({ format: format, target: new MB.BufferTarget() });
    var conv = await MB.Conversion.init({
      input: m.input, output: out, showWarnings: false, video: { discard: true },
      audio: function (tr) { return tr === t.track ? {} : { discard: true }; }, copy: { mode: 'forced' }, tags: {}
    });
    if (!conv.isValid) throw noDecode(t);
    await conv.execute();
    var ctx;
    try { ctx = new OfflineAudioContext(1, 1, t.sr); } catch (x) { ctx = new OfflineAudioContext(1, 1, 48000); }
    var ab = await new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(out.target.buffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    }).catch(function () { throw noDecode(t); });
    var input = new MB.Input({ source: new MB.BufferSource(wav16(ab)), formats: [MB.WAVE] });
    return { input: input, track: await input.getPrimaryAudioTrack(), base: 0 };
  }
  function wav16(ab) {
    var ch = ab.numberOfChannels, n = ab.length, sr = ab.sampleRate;
    var buf = new ArrayBuffer(44 + n * ch * 2), v = new DataView(buf), pcm = new Int16Array(buf, 44);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true);
    v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
    for (var c = 0; c < ch; c++) {
      var d = ab.getChannelData(c);
      for (var i = 0, j = c; i < n; i++, j += ch) {
        var x = Math.round(d[i] * 32768);
        pcm[j] = x > 32767 ? 32767 : x < -32768 ? -32768 : x;
      }
    }
    return buf;
  }
  function buffers(src, from, to) {
    return new MB.AudioBufferSink(src.track).buffers(from, to);
  }
  function mixGain(ch, mono) { return ch === 6 ? (mono ? K51_MONO : K51_STEREO) : 1; }
  function gainFn(volume, fadeIn, fadeOut, len) {
    // t in seconds from the start of the selection; linear fades.
    return function (t) {
      var g = volume;
      if (fadeIn > 0 && t < fadeIn) g *= Math.max(0, t) / fadeIn;
      if (fadeOut > 0 && t > len - fadeOut) g *= Math.max(0, len - t) / fadeOut;
      return g;
    };
  }

  // ---------- Waveform levels ----------
  function levels(buckets) {
    var f = function (v) { return new Float32Array(buckets).fill(v); };
    return { buckets: buckets, min: f(Infinity), max: f(-Infinity), monoMin: f(Infinity), monoMax: f(-Infinity), filled: 0, done: false };
  }
  // The channels as the result has them: [left, right, mono]. A mono file
  // gives [its channel, null, null]; stereo gives [left, right, null], its
  // Mono being (left + right) / 2, worked out while scanning; quad and 5.1
  // are mixed as convert() mixes them; other layouts give their first two
  // channels, and their first as Mono.
  var planes = [], mixed = [];
  function heard(s, n) {
    var ch = s.numberOfChannels, k = ch === 4 || ch === 6 ? ch : Math.min(ch, 2), P = planes, i;
    for (var c = 0; c < k; c++) {
      if (!P[c] || P[c].length < n) P[c] = new Float32Array(Math.max(n, 4096));
      s.copyTo(P[c], { planeIndex: c, format: 'f32-planar', frameCount: n });
    }
    if (ch === 1) return [P[0], null, null];
    if (k === 2) return [P[0], P[1], ch === 2 ? null : P[0]];
    for (c = 0; c < 3; c++) if (!mixed[c] || mixed[c].length < n) mixed[c] = new Float32Array(Math.max(n, 4096));
    var L = mixed[0], R = mixed[1], M = mixed[2], a = Math.SQRT1_2;
    for (i = 0; i < n; i++) {
      if (k === 4) { L[i] = 0.5 * (P[0][i] + P[2][i]); R[i] = 0.5 * (P[1][i] + P[3][i]); M[i] = 0.25 * (P[0][i] + P[1][i] + P[2][i] + P[3][i]); }
      else {
        L[i] = K51_STEREO * (P[0][i] + a * (P[2][i] + P[4][i]));
        R[i] = K51_STEREO * (P[1][i] + a * (P[2][i] + P[5][i]));
        M[i] = K51_MONO * (a * (P[0][i] + P[1][i]) + P[2][i] + 0.5 * (P[4][i] + P[5][i]));
      }
    }
    return [L, R, M];
  }
  async function scan(src, lv, opts) {
    opts = opts || {};
    var stopped = opts.stopped || function () { return false; };
    var dur = opts.dur || 0.001, B = lv.buckets, lastDraw = 0;
    var min = lv.min, max = lv.max, mmin = lv.monoMin, mmax = lv.monoMax;
    var sink = new MB.AudioSampleSink(src.track);
    for await (var s of sink.samples(src.base, src.base + dur)) {
      if (stopped()) { s.close(); return false; }
      var n = s.numberOfFrames, sr = s.sampleRate, t = s.timestamp - src.base, lines = heard(s, n);
      var L = lines[0], R = lines[1], M = lines[2], i = 0;
      // One pass over each bucket's share of the sample, for every line.
      while (i < n) {
        var b = Math.floor((t + i / sr) / dur * B);
        if (b >= B) break;
        var iEnd = b < 0 ? Math.ceil(-t * sr) : Math.min(n, Math.ceil(((b + 1) * dur / B - t) * sr));
        if (iEnd <= i) iEnd = i + 1;
        if (b >= 0) {
          var lo = min[b], hi = max[b], mlo = mmin[b], mhi = mmax[b], k, v, w;
          if (!R) {
            for (k = i; k < iEnd; k++) { v = L[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
            mlo = lo; mhi = hi;
          } else if (!M) {
            for (k = i; k < iEnd; k++) {
              v = L[k]; w = R[k];
              if (v < lo) lo = v; if (v > hi) hi = v; if (w < lo) lo = w; if (w > hi) hi = w;
              v = 0.5 * (v + w); if (v < mlo) mlo = v; if (v > mhi) mhi = v;
            }
          } else {
            for (k = i; k < iEnd; k++) {
              v = L[k]; w = R[k];
              if (v < lo) lo = v; if (v > hi) hi = v; if (w < lo) lo = w; if (w > hi) hi = w;
              v = M[k]; if (v < mlo) mlo = v; if (v > mhi) mhi = v;
            }
          }
          min[b] = lo; max[b] = hi; mmin[b] = mlo; mmax[b] = mhi;
        }
        i = iEnd;
      }
      lv.filled = Math.min(dur, t + n / sr);
      s.close();
      var now = performance.now();
      if (now - lastDraw > 150) {
        lastDraw = now;
        if (opts.onUpdate) opts.onUpdate(lv);
        await yieldNow();
        if (stopped()) return false;
      }
    }
    if (stopped()) return false;
    lv.done = true;
    return true;
  }
  function peak(lv, from, to, mono) {
    if (!lv) return -1;
    var min = mono ? lv.monoMin : lv.min, max = mono ? lv.monoMax : lv.max, B = lv.buckets;
    var b0 = Math.floor(from * B), b1 = Math.ceil(to * B), m = 0;
    for (var b = Math.max(0, b0); b < Math.min(B, b1); b++) {
      if (min[b] > max[b]) continue;
      m = Math.max(m, -min[b], max[b]);
    }
    return m;
  }

  // ---------- Converting ----------
  var MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  function mp3MaxKbps(sr) { return sr >= 32000 ? 320 : sr >= 16000 ? 160 : 64; }
  function mp3Plan(sr, kbps) {
    kbps = Math.max(8, Math.min(320, Math.round(+kbps) || 192));
    var rate;
    if (MP3_RATES.indexOf(sr) >= 0) rate = sr;
    else if (!(sr > 0) || sr > 48000) rate = sr % 11025 === 0 ? 44100 : 48000;
    else {
      // The next MP3 rate up, from the same family (multiples of 11,025, of
      // 12,000 or of 8,000 Hz) when the rate belongs to one.
      var fam = sr % 11025 === 0 ? [11025, 22050, 44100] : sr % 12000 === 0 ? [12000, 24000, 48000] : sr % 8000 === 0 ? [8000, 16000, 32000] : MP3_RATES;
      rate = fam.filter(function (r) { return r >= sr; })[0] || (sr % 11025 === 0 ? 44100 : 48000);
    }
    return { sampleRate: rate, kbps: Math.max(rate >= 32000 ? 32 : 8, Math.min(kbps, mp3MaxKbps(rate))) };
  }
  function outChannels(t, mono) { return mono ? 1 : Math.min(2, t.ch || 2); }
  function selOf(t, sel) {
    var s = sel && sel.start > 0 ? Math.min(sel.start, t.durMs) : 0;
    var e = sel && sel.end >= 0 && sel.end < t.durMs ? sel.end : t.durMs;
    return { start: s, end: Math.max(s, e) };
  }
  function estimate(m, ti, o) {
    var t = m.tracks[ti], sel = selOf(t, o.sel), sec = (sel.end - sel.start) / 1000;
    if (o.format === 'mp3') return Math.round(mp3Plan(t.sr, o.kbps).kbps * 125 * sec) + 300;
    if (o.format === 'wav') return Math.round(sec * t.sr) * outChannels(t, o.mono) * 2 + 44;
    return t.bitrate > 0 && t.codec === 'aac' ? Math.round(t.bitrate / 8 * sec) + 2000 : 0;
  }
  // The format, codec and tags of every WAV written; o is convert()'s
  // options. (The place for 24-bit, float and RF64.)
  function wavOutput(tags, o) {
    var kind = wavTagFormat(tags);
    return { format: new MB.WavOutputFormat({ metadataFormat: kind }), codec: 'pcm-s16', tags: mbTags(tags, 'wav-' + kind) };
  }
  // Every sample rate of a result is set here: { options, process } that
  // give toRate from sound at fromRate. options join the conversion's audio
  // options; process, if any, runs on each AudioSample after the volume and
  // fades. Today mediabunny resamples, with linear interpolation, in the
  // step that also mixes the channels, so there is no process. (A
  // windowed-sinc resampler would give no sampleRate option but
  // processedSampleRate: toRate, and a process that returns the sample at
  // toRate and closes what it does not return.)
  function resampleStage(fromRate, toRate) {
    return { options: { sampleRate: toRate }, process: null };
  }
  function makeProcess(fx, len, k) {
    var vol = fx.vol * k;
    var gain = gainFn(vol, fx.fadeIn, fx.fadeOut, len), lastYield = performance.now();
    return async function (s) {
      if (performance.now() - lastYield > 40) { await yieldNow(); lastYield = performance.now(); }
      var n = s.numberOfFrames, ch = s.numberOfChannels, sr = s.sampleRate, t0 = s.timestamp, t1 = t0 + n / sr;
      var flat = t0 >= fx.fadeIn && t1 <= len - fx.fadeOut;
      if (flat && vol === 1) return s;
      var data = new Float32Array(n * ch);
      for (var c = 0; c < ch; c++) {
        var plane = data.subarray(c * n, (c + 1) * n);
        s.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        if (flat) { for (var i = 0; i < n; i++) plane[i] *= vol; }
        else { for (var j = 0; j < n; j++) plane[j] *= gain(t0 + j / sr); }
      }
      return new MB.AudioSample({ data: data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: t0 });
    };
  }

  function convert(m, ti, o) {
    var job = { cancelled: false, conv: null };
    job.cancel = function () {
      job.cancelled = true;
      return job.conv ? job.conv.cancel().catch(function () {}) : Promise.resolve();
    };
    job.promise = run(m, ti, o || {}, job);
    return job;
  }
  async function run(m, ti, o, job) {
    await load();
    var t = m.tracks[ti], fmt = o.format === 'wav' || o.format === 'copy' ? o.format : 'mp3';
    var sel = selOf(t, o.sel), len = (sel.end - sel.start) / 1000, copyMode = fmt === 'copy';
    var fx = { vol: copyMode ? 1 : (o.volume == null ? 1 : Math.max(0, +o.volume || 0)), fadeIn: copyMode ? 0 : Math.max(0, +o.fadeIn || 0),
      fadeOut: copyMode ? 0 : Math.max(0, +o.fadeOut || 0) };
    var tags = o.tags || null, src, format, ext, mime, audio, copy = {}, mbt = tags ? mbTags(tags, 'm4a') : { creationTime: null };
    var plan = null, ch = outChannels(t, !copyMode && !!o.mono);
    if (t.drm) throw drmError(t.drm);
    if (copyMode) {
      if (t.codec !== 'aac') throw coded('NOT_AAC', fill(TEXT.notAac, { codec: codecName(t) }), { track: t });
      src = { input: m.input, track: t.track, base: t.t0 };
      format = new MB.Mp4OutputFormat({ fastStart: 'in-memory' });
      ext = 'm4a'; mime = 'audio/mp4'; audio = {}; copy = { mode: 'forced' };
    } else {
      if (!t.decodable && !t.whole) throw noDecode(t);
      if (fmt === 'wav') {
        var bytes = estimate(m, ti, { format: 'wav', sel: sel, mono: o.mono });
        if (bytes > LIMITS.wav) throw coded('TOO_BIG', fill(TEXT.tooBig, { size: fmtBytes(bytes), limit: fmtBytes(LIMITS.wav) }), { bytes: bytes, limit: LIMITS.wav });
      }
      src = await decodeSource(m, ti);
      if (fmt === 'mp3') plan = mp3Plan(t.sr, o.kbps);
      var stage = resampleStage(t.sr, plan ? plan.sampleRate : t.sr);
      if (fmt === 'mp3') {
        format = new MB.Mp3OutputFormat(); ext = 'mp3'; mime = 'audio/mpeg';
        audio = { codec: 'mp3', quality: new MB.Quality({ bitrate: plan.kbps * 1000 }), numberOfChannels: ch };
        mbt = { creationTime: null };   // the MP3's tags are written by finishMp3()
      } else {
        var wav = wavOutput(tags, o);
        format = wav.format; ext = 'wav'; mime = 'audio/wav'; mbt = wav.tags;
        audio = { codec: wav.codec, numberOfChannels: ch, forceTranscode: true };
      }
      Object.assign(audio, stage.options);
      // Always set: besides fades and volume it gives the page a moment to
      // respond now and then, and scales a 5.1 mix so it cannot clip.
      var shape = makeProcess(fx, len, mixGain(t.ch, ch === 1));
      audio.process = stage.process ? function (s) {
        return Promise.resolve(shape(s)).then(function (x) { return x && stage.process(x); });
      } : shape;
      copy = false;
    }
    var trim = {};
    if (sel.start > 0) trim.start = src.base + sel.start / 1000;
    if (sel.end < t.durMs) trim.end = src.base + sel.end / 1000;
    // Sound decoded a piece at a time ends where the file says it does,
    // without the padding an AAC encoder adds after the last sample (up to
    // about 46 ms). A whole-track decode is kept as the browser made it.
    else if (!copyMode && t.decodable) trim.end = t.end;
    var out = new MB.Output({ format: format, target: new MB.BufferTarget() });
    var conv = await MB.Conversion.init({
      input: src.input, output: out, showWarnings: false, trim: trim, copy: copy,
      video: { discard: true },
      audio: function (tr) { return tr === src.track ? audio : { discard: true }; },
      tags: function () { return mbt; }
    });
    if (!conv.isValid) {
      var d = conv.discardedTracks.filter(function (x) { return x.track === src.track; })[0];
      var reason = d ? d.reason : '';
      if (reason === 'no_encodable_target_codec') throw coded('NO_ENCODER', TEXT.noEncoder, { format: fmt });
      if (reason === 'cannot_copy') throw coded('CANNOT_COPY', TEXT.cannotCopy);
      throw noDecode(t);
    }
    if (o.onProgress) conv.onProgress = function (p) { o.onProgress(p); };
    job.conv = conv;
    try {
      if (job.cancelled) await conv.cancel();
      await conv.execute();
    } catch (err) {
      if (job.cancelled || isCancel(err)) throw coded('CANCELLED', 'Conversion cancelled.', { cause: err });
      throw err;
    } finally {
      job.conv = null;
    }
    if (job.cancelled) throw coded('CANCELLED', 'Conversion cancelled.');
    var result = { ext: ext, mime: mime, channels: copyMode ? t.ch : ch, sampleRate: plan ? plan.sampleRate : t.sr };
    if (fmt === 'mp3') {
      result.kbps = plan.kbps;
      result.blob = finishMp3(out.target.buffer, tags, { sampleRate: plan.sampleRate, channels: ch, kbps: plan.kbps, samples: Math.round(len * plan.sampleRate) });
    } else {
      result.blob = new Blob([out.target.buffer], { type: mime });
    }
    return result;
  }
  function isCancel(err) {
    return !!err && (err.code === 'CANCELLED' || err.name === 'ConversionCanceledError' ||
      (MB && MB.ConversionCanceledError && err instanceof MB.ConversionCanceledError) || /cancel/i.test(err.message || ''));
  }

  function describe(err, drm) {
    if (err && err.userText) return err.userText;
    var msg = String((err && err.message) || err || '');
    drm = drm || (err && err.drm) || '';
    if (drm || msg.indexOf(PROTECTED_MARK) >= 0 || /encrypted media samples/i.test(msg)) return TEXT[drm] || TEXT.cenc;
    if ((err && err.name === 'RangeError') || /out of memory|allocation failed|array buffer allocation/i.test(msg)) return TEXT.memory;
    if (/decod/i.test(msg)) return TEXT.decode;
    return fill(TEXT.other, { message: cut(msg, 120) });
  }

  api = window.TTAudio = {
    MB: null, simd: SIMD, PHONE: PHONE, limits: LIMITS, text: TEXT,
    load: load, loadScript: loadScript, canWriteMp3: function () { return mp3Ok; },
    open: open, close: close, codecName: codecName, channelsText: channelsText,
    decodeSource: decodeSource, release: release, buffers: buffers, mixGain: mixGain, gainFn: gainFn,
    levels: levels, scan: scan, peak: peak,
    mp3Plan: mp3Plan, outChannels: outChannels, estimate: estimate, convert: convert, isCancel: isCancel, describe: describe,
    emptyTags: emptyTags, id3v23: id3v23, id3v1: id3v1, finishMp3: finishMp3, mbTags: mbTags, wavTagFormat: wavTagFormat,
    yieldNow: yieldNow
  };
})();
