/*
 * TTAudio: the audio engine of MP4 to MP3 and its pair pages (window.TTAudio).
 * It reads video and audio files with mediabunny (assets/vendor/mediabunny/,
 * loaded on first use together with its LAME MP3 encoder), decodes their sound
 * a piece at a time, or the whole track at once with decodeAudioData where the
 * browser has no streaming decoder for it, measures levels for a waveform,
 * cuts, fades, changes the volume, mixes to stereo or mono, resamples, and
 * writes MP3, WAV or M4A with tags. Its own parts: an MP3 frame reader and
 * writer (gapless MP3s, exact cuts without re-encoding), a WAV reader that
 * mends wrong header sizes, a WAV writer (16 and 24-bit, float, µ-law,
 * A-law, RF64), a windowed-sinc resampler and an Apple Lossless (ALAC)
 * decoder (@mgz-dev/alac in assets/vendor/alac/, run in the module worker
 * assets/js/alac-worker.js, both loaded only for an ALAC file). It has no
 * page UI and stores nothing.
 *
 * Load it where it is needed; it loads nothing more until load() is called:
 *   <script src="{{ '/assets/js/audio-engine.js' | relative_url }}"></script>
 * The include _includes/audio-converter-tool.html is the page UI built on it.
 *
 * ORDER OF CALLS
 *   1. await TTAudio.load()                    before anything that reads a file
 *   2. var m = await TTAudio.open(file[, { alac: true }])  per file: m.tracks, m.primary, m.tags
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
 *   FREE_FORMAT  open(), mp3Frames(): a free-format MP3 (its frames state no
 *                bitrate), which browsers cannot decode.
 *   WAV_CODEC    open(): a WAV whose sound browsers cannot decode (ADPCM,
 *                GSM ...); .codec is its format tag and the sentence names
 *                it (TEXT.wavCodec).
 *   NO_SOUND     open(): a video without a sound track.
 *   NO_TRACKS    open(): neither sound nor picture (cut off, damaged).
 *   PROTECTED    open(): the default sound track is encrypted; .drm says how
 *                ('cenc', 'fairplay' or 'audible', also for .m4p, .aa and
 *                .aax files that cannot be read at all).
 *   EMPTY_TRACK  open(): the default sound track holds no sound.
 *   NO_DECODE    decodeSource(), convert(): this browser has no decoder for
 *                the codec (.track is the track info), or the track is one
 *                the engine cannot decode (track.unsupported says why).
 *   ALAC_FAILED  decodeSource(), convert(), and reads of its sound: the
 *                Apple Lossless decoder could not open or decode the file
 *                (damaged, or too big for the memory of the device).
 *   ALAC_CLOSED  the same: the file's Apple Lossless decoder was closed to
 *                keep within limits.alac while another file was opened (a
 *                decoder that is answering reads is never closed); trying
 *                again opens it again.
 *   TOO_LONG     decodeSource(), convert(): the track must be decoded whole,
 *                and it is longer than limits.whole seconds (.limit).
 *   NOT_AAC      convert() with format 'copy': only AAC is copied to .m4a.
 *   TOO_BIG      convert(): the WAV would be over limits.wav bytes, or the
 *                MP3 over limits.mp3 (either not written into o.writable)
 *                (.bytes, .limit, .format 'wav' or 'mp3').
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
 *   TTAudio.limits    { wav: bytes of WAV built in memory when no o.writable
 *     takes it (2 GB, 300 MB on a phone), mp3: bytes of MP3 built in memory
 *     when no o.writable takes it
 *     (as wav), zip: bytes put in one ZIP (as wav), whole: seconds decoded
 *     at once without a streaming decoder (3600, 1200 on a phone), alac:
 *     bytes of Apple Lossless files the decoder holds at once, and so the
 *     largest it decodes (2 GB, 300 MB on a phone) }.
 *   TTAudio.loadScript(url) -> Promise: a classic script, loaded once.
 *
 * OPENING A FILE
 *   TTAudio.open(file, options) -> Promise of a media object. options: {
 *     alac: true to decode Apple Lossless with the engine's own decoder (see
 *     decodeSource); without it an ALAC track keeps the null codec that
 *     mediabunny gives it and cannot be decoded, as before the decoder came }.
 *     The media object:
 *     { file, input (mediabunny Input),
 *       container: 'mp4' | 'mov' | 'mkv' | 'webm' | 'mp3' | 'wav' | 'ogg' |
 *                  'flac' | 'adts' | 'mpegts',
 *       tracks: [track info], primary: index of the file's default track,
 *       tags: the file's tags (see TAGS), drm: '' or how a track is protected,
 *       wav: null, or for a WAV file its layout (see WAV FILES) }
 *     Track info:
 *     { track     the mediabunny InputAudioTrack
 *       codec     mediabunny's codec name ('aac', 'mp3', 'opus', 'vorbis',
 *                 'flac', 'ac3', 'pcm-s16', 'ulaw' ...), or 'alac' for
 *                 Apple Lossless when open() was asked to decode it
 *                 (mediabunny lists it without a codec); null when unknown
 *       internal  the container's codec id ('mp4a', 'alac', 'drms' ...), ''
 *       sr, ch    sample rate (Hz) and channels as the file states them
 *                 (for ALAC as its own settings state them: an MP4 sample
 *                 entry cannot hold rates above 65,535 Hz)
 *       lang, name  language code ('und' when none) and the track's title
 *       first     timestamp (s) of the first packet; may be negative
 *       t0        max(0, first): where the sound that is heard starts
 *       end       end (s) of the last packet whose data is in the file
 *       listed    end (s) the file's index lists; above end when it is cut off
 *       durMs     round((end - t0) * 1000), the length shown and cut in ms
 *       bitrate   bits per second; from the file's metadata, else measured
 *                 from the packets of the first 10 s (never a whole-file
 *                 scan); 0 for PCM and when unknown
 *       decodable this browser decodes it a piece at a time (WebCodecs,
 *                 mediabunny's own PCM decoders, or for ALAC the engine's
 *                 decoder: WebAssembly SIMD, reference types and module
 *                 workers, so Chrome 96, Firefox 114, Safari 16.4)
 *       whole     it is not decodable, but decodeAudioData may read it: the
 *                 whole track is decoded at once (see decodeSource)
 *       drm       '' or 'cenc' | 'fairplay' | 'audible' for an encrypted
 *                 track ('enca', 'drms' or 'aavd'), which is never decoded
 *       alac      for Apple Lossless { bits (16, 24 ... per sample, 0 when
 *                 the settings could not be read), frameLength }, else null
 *       unsupported  '' or a sentence saying why the engine cannot decode
 *                 this track although it knows the codec: ALAC of 20 or 32
 *                 bits, of more than 2 channels, a file over limits.alac,
 *                 sound over 4 GB, a second ALAC track (decodable is then
 *                 false; NO_DECODE carries the sentence)
 *       mp3       for MP3 sound (an MP3 file, or MP3 in a WAV) { gapless:
 *                 true when a LAME tag gives the encoder delay and padding,
 *                 so that t0..end is exactly the sound encoded, as gapless
 *                 decoders play it (mediabunny drops the delay, the engine
 *                 the padding); delay, padding, frames: the tag's; samples:
 *                 the number encoded (0 without a tag); leadIn: samples
 *                 before the sound that are kept, as no tag says to drop
 *                 them (1,105 at 44.1 kHz: LAME's 576 and the decoder's
 *                 529; 0 with a tag), for a page to mention; tag: 'Info',
 *                 'Xing', 'VBRI' or ''; encoder; crcOk: the LAME tag's own
 *                 CRC }, else null }
 *     A WAV file is read through wavParse() (see WAV FILES): one whose header
 *     states wrong sizes is read to the real end of its sound, and MP3 in a
 *     WAV as the MP3 it is. A VBRI frame (Fraunhofer) is left out, as
 *     decoders leave it out. Rejects with EMPTY, UNREADABLE, FREE_FORMAT,
 *     WAV_CODEC, NO_SOUND, NO_TRACKS, PROTECTED or EMPTY_TRACK (the input is
 *     then disposed); other errors carry .drm when a protected sample was met.
 *   TTAudio.close(media)    disposes its input and any whole decode of it.
 *   TTAudio.codecName(track) -> 'AAC', 'AC-3 (Dolby Digital)', 'PCM' ...
 *   TTAudio.channelsText(n)  -> 'mono', 'stereo', '5.1 surround' ...
 *
 * THE SOUND OF A TRACK
 *   TTAudio.decodeSource(media, ti) -> Promise of { input, track, base }:
 *     what AudioSampleSink and AudioBufferSink read for track ti. A decodable
 *     track is the file's own (base = t0). A 'whole' track is copied out of
 *     the file (an MP3 file as it is, so that its LAME tag is honoured),
 *     decoded with decodeAudioData at its own rate and kept as 16-bit PCM in
 *     a WAV held in memory (base = 0), so 24-bit and float WAVs made from it
 *     carry 16 bits; one such decode is kept at a time, for the last media
 *     and track asked for. An ALAC track is read through a WAV of 16 or
 *     24-bit PCM that its decoder fills as mediabunny reads it (base = 0):
 *     the decoder (a worker holding the whole file) is kept per media until
 *     release() or close(), or until the files held would pass limits.alac,
 *     when the one used least recently is closed unless it is answering
 *     reads. Rejects with NO_DECODE, TOO_LONG or ALAC_FAILED; reads of an
 *     ALAC track's sound can fail with ALAC_FAILED or ALAC_CLOSED.
 *   TTAudio.release(media)  drops the whole decode of media, if it holds one,
 *     and its ALAC decoder (a later decodeSource() starts a new one).
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
 *   TTAudio.outChannels(track, mono, stereo) -> 1 or 2: channels of the
 *     result (mono: 1; stereo: 2, also for a mono track; else the track's,
 *     at most 2).
 *   TTAudio.estimate(media, ti, options) -> bytes the result will take about
 *     (0 when it cannot be told: a copy of a track whose bitrate is unknown).
 *   TTAudio.convert(media, ti, options) -> job { promise, cancel() }.
 *     options:
 *       format    'mp3' | 'wav' | 'copy' (AAC packets copied unchanged
 *                 into .m4a; no effects, the cut rounded out to whole
 *                 packets)
 *       kbps      MP3 bitrate, 64 to 320 (default 192; see mp3Plan)
 *       mono      true for one channel: the average of left and right, quad
 *                 and 5.1 mixed as in scan(), the first channel of others
 *       stereo    true for two channels also from a mono track (the same
 *                 sound in both, as CD audio is always stereo); a track of
 *                 more channels is mixed or cut to two as without it
 *       sel       { start, end } in ms from t0 (default the whole track)
 *       volume    gain factor (default 1); fadeIn, fadeOut: seconds
 *       tags      a tag model (see TAGS) to write, or null to write no tags
 *       sampleFormat  WAV: 's16' (the default, but 's24' for 24-bit ALAC,
 *                 which then keeps every bit), 's24', 'f32' (32-bit float),
 *                 'ulaw' or 'alaw' (G.711, 8 bits), as wavWriter() writes
 *       sampleRate  WAV: the rate to write (default the sound's own)
 *       rf64      WAV: RF64 even under 4 GB (past 4 GB it is RF64 anyway)
 *       writable  MP3 and WAV: a WritableStream that takes { type: 'write',
 *                 position, data } chunks, such as the
 *                 FileSystemWritableFileStream of a handle from
 *                 showSaveFilePicker(). The file is written into it as it is
 *                 made, so it is never held in memory (limits.mp3 and
 *                 limits.wav do not apply), and the stream is closed at the
 *                 end (aborted on an error or a cancel). The file is the
 *                 same, byte for byte, as the Blob convert() gives without
 *                 it. An MP3: the ID3v2.3 tag, room for the Info frame, the
 *                 frames as the encoder makes them (their count, positions
 *                 and CRC taken as they pass), the ID3v1 tag, and the Info
 *                 frame put in its room once the length is known. A WAV
 *                 (wavWriter with o.writable): room for the header, the
 *                 sound a megabyte at a time, then the header and the tags;
 *                 a WAV estimated at 2 GB or more keeps the 36 bytes RF64
 *                 needs, so it is written as RF64 past 4 GB and with a 'JUNK'
 *                 chunk in their place below that.
 *       onProgress(fraction)
 *     promise resolves { blob, ext ('mp3' | 'wav' | 'm4a'), mime, sampleRate,
 *     channels, samples (MP3, WAV: per channel, as written), kbps (MP3),
 *     sampleFormat (WAV) }; with writable, blob is null, streamed is true
 *     and size is the bytes written. Rejects with CANCELLED, NO_DECODE,
 *     TOO_LONG, NOT_AAC, TOO_BIG, NO_ENCODER, CANNOT_COPY, ALAC_FAILED or
 *     ALAC_CLOSED, or another error.
 *     MP3 and WAV are made by the engine's own pipeline: the sound decoded a
 *     piece at a time from the start of the selection, cut to the sample,
 *     mixed, shaped, resampled where the rate changes (the windowed-sinc
 *     resampler below, never mediabunny's linear one), then given to the
 *     LAME encoder or to wavWriter(). A WAV keeps the sample rate of the
 *     sound unless sampleRate says otherwise; an MP3 gets mp3Plan()'s. Every
 *     MP3 is gapless (finishMp3): its LAME tag gives the number of samples
 *     encoded, so ffmpeg, Chromium and other gapless decoders give exactly
 *     the samples selected. Float WAV keeps what the decoder gives, but
 *     Chromium's MP3 and AAC decoders clip at full scale: a float WAV of a
 *     clipped MP3 does not get its peaks back, so never say that it does.
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
 *     WAV  a LIST INFO chunk in UTF-8 before the sound (INAM, IART, IPRD,
 *          IMUS, IGNR, ICRD, ITRK, ICMT) and after it an 'id3 ' chunk with
 *          the ID3v2.3 tag an MP3 gets, pictures and all.
 *   TTAudio.emptyTags() -> a model with nothing in it.
 *   TTAudio.id3v23(tags) -> Uint8Array (empty when there is nothing to write).
 *   TTAudio.id3v1(tags)  -> Uint8Array of 128 bytes, or null.
 *   TTAudio.finishMp3(bytes, tags, info) -> Blob of the MP3 as saved: the
 *     frames made gapless with info.samples (mp3Gapless), between the tags.
 *   TTAudio.mbTags(tags) -> mediabunny MetadataTags for an M4A.
 *
 * MP3 FRAMES (MPEG-1, 2 and 2.5 Layer III; for /mp3-cutter/ and checks)
 *   TTAudio.mp3Header(bytes, p) -> the frame header at p, or null: { id (3
 *     MPEG-1, 2 MPEG-2, 0 MPEG-2.5), version (1, 2 or 2.5), crc, bitrateIndex,
 *     kbps, free, sampleRateIndex, sampleRate, padding, mode (3 is mono),
 *     modeExtension, channels, priv, flags (copyright, original, emphasis),
 *     spf (samples a frame: 1152, or 576 in MPEG-2 and 2.5), side (bytes of
 *     side information), size (bytes of the frame; 0 in free format) }.
 *   TTAudio.mp3Frames(bytes) -> every frame of sound of an MP3 file held in
 *     a Uint8Array, or null when there is none: { count; pos, size, kbps,
 *     mdb (typed arrays of each frame's offset, bytes, bitrate and
 *     main_data_begin: how many bytes of its main data lie in the frames
 *     before it, the bit reservoir); start, end (of the frames); version,
 *     id, sampleRate, sampleRateIndex, spf, granules (2 a frame in MPEG-1,
 *     1 otherwise), side, channels, mode, modeExtension, priv, flags, crc
 *     (of the first frame); cbr; info: mp3Info() of the first frame (that
 *     frame is not counted), or null; tags: [{ kind: 'id3v2' | 'id3v1' |
 *     'ape' | 'lyrics3', start, end }]; junk: bytes skipped between frames
 *     (sync is found again after junk, and only where two more frames of
 *     the stream follow); cutShort: the last frame is cut off }. CRC-
 *     protected frames are read; throws FREE_FORMAT for free format.
 *   TTAudio.readMp3(blob) -> Promise of { bytes, frames }: the whole file.
 *   TTAudio.mp3Info(bytes, p, header) -> the Xing, Info or VBRI header in
 *     the frame at p, or null: { tag ('Xing', 'Info', 'VBRI'), vbr, pos,
 *     size, frames, bytes, toc (Xing: 100 bytes; VBRI: byte counts),
 *     quality, encoder, lame (a LAME tag that decoders honour: LAME, Lavf,
 *     Lavc ...), delay, padding (samples), crcOk (the LAME tag's CRC-16 of
 *     its frame), musicLength, musicCrc; VBRI also version, framesPerEntry }.
 *   TTAudio.mp3Samples(frames) -> samples encoded, frames x spf - delay -
 *     padding from the LAME tag, or -1 without one.
 *   TTAudio.MP3_DECODER_DELAY  529, the samples every decoder gives before
 *     the first one encoded. A decoder that honours the LAME tag drops
 *     delay + 529 samples at the start and keeps mp3Samples() samples.
 *   TTAudio.mp3LeadIn(frames, k) -> how many frames before frame k a
 *     decoder must read for frame k to come out as in the whole file: the
 *     frames it decodes in full (one in MPEG-1, two in MPEG-2 and 2.5) and
 *     those that hold the start of their main data. Two or three at 128
 *     kbps and above; up to eight at 32 kbps, more than the LAME tag's
 *     delay (12 bits: 4,095 samples) can skip.
 *   TTAudio.mp3Donor(bytes, frames, k, silent) -> one or two frames of
 *     silence holding the main data frame k reads from the frames before it,
 *     to stand in their place in front of frame k (null when k reads none;
 *     with silent, one frame of silence that holds nothing).
 *   TTAudio.mp3Cut(bytes, frames, start, end) -> an exact cut without
 *     re-encoding, of samples start to end (end not included) counted as
 *     the track's times count them: sample = round(ms from t0 x rate /
 *     1000). { bytes (Uint8Array: an Info or Xing frame and the frames, no
 *     tags; put id3v23() before and id3v1() after, or the file's own tags),
 *     start, end (clamped), frames, delay, padding, lead (frames before the
 *     one that holds start), donors (frames of silence in it) } or null. It
 *     copies whole frames with mp3LeadIn() frames before them, or mp3Donor()
 *     frames where those need too long a delay, under a LAME tag that pins
 *     playback to those samples; decoded by ffmpeg or Chromium it is the
 *     whole file's decoded sound from start to end, bit for bit. Players
 *     that ignore the tag also play the lead (25 to 80 ms) and up to a
 *     frame after the end. In ffmpeg 6 (not in Chromium) a cut that lies
 *     within one frame (26 ms at 44.1 kHz) keeps that frame's samples
 *     before start too. Joins (a middle cut out) and fades need re-encoding.
 *   TTAudio.mp3InfoFrame(o) -> an Info (CBR) or Xing (VBR) frame with a LAME
 *     tag and its CRC: o = { id, sampleRateIndex, mode, modeExtension, priv,
 *     flags (from the stream's header), kbps (a CBR stream's own; null for
 *     the smallest frame that holds the tag), vbr, frames, bytes (of the
 *     frames after it), toc (100 bytes, a function (frameSize) giving them,
 *     or null), delay, padding (0 to 4,095), musicCrc (crc16 of those
 *     frames), encoder (default 'LAME3.100') }. A CBR frame too small for
 *     the table of contents goes without one.
 *   TTAudio.mp3Toc(frames, first, count, infoSize) -> the 100-byte table of
 *     contents of count frames from first, after an Info frame of infoSize.
 *   TTAudio.mp3Gapless(bytes, samples) -> an MP3 whose Info frame is written
 *     again so that it decodes to exactly `samples` samples (mediabunny
 *     1.65.2 writes "no end trim" in its LAME tag and counts the Info frame).
 *   TTAudio.crc16(bytes, from, to, crc) -> the CRC-16 (ARC) of the LAME tag.
 *
 * WAV FILES
 *   TTAudio.wavParse(file) -> Promise of the layout of a WAV or RF64 file
 *     (open() keeps it as media.wav), or null when it is not one: { rf64,
 *     riffSize, fmt: { tag, codec (the tag, or the subformat of
 *     WAVE_FORMAT_EXTENSIBLE), name ('PCM', 'IEEE float', 'µ-law', 'A-law',
 *     'MP3', 'IMA ADPCM', 'Microsoft ADPCM', 'GSM 6.10' ...), channels,
 *     sampleRate, byteRate, blockAlign, bits, extensible, validBits,
 *     channelMask }, ds64, chunks: [{ id, pos, size }] before the sound,
 *     dataPos, dataStart, declared (bytes of sound the header states),
 *     dataEnd (where the sound really ends: whole blocks; to the byte for
 *     MP3), tail (where the chunks after the sound start, or the file's
 *     size), repaired: '' when the header is right, else 'zero' (sizes 0:
 *     never finished), 'unknown' (0xFFFFFFFF), 'short' (no chunk header
 *     follows the stated end), 'past-end' or 'riff' }; open() adds .mp3.
 *     A size is wrong only when no valid chunk follows where it says the
 *     sound ends (editors write LIST and id3 chunks after the sound). Such
 *     a file, and an RF64 file with chunks after its sound, is read through
 *     a header built here in front of the file's own bytes (a Blob of
 *     slices; nothing is copied), as RF64 when the sizes need it: a 4.5 GB
 *     WAV whose 32-bit sizes wrapped round is read to its end.
 *     Read: PCM of 8 to 32 bits, 32 and 64-bit float, µ-law, A-law,
 *     WAVE_FORMAT_EXTENSIBLE, RF64; tags from LIST INFO and id3 chunks
 *     before or after the sound. Refused with WAV_CODEC: ADPCM, GSM and
 *     other codecs, by name. MP3 sound (format 0x55) is read as an MP3.
 *   TTAudio.wavMp3(media, tags) -> the MP3 frames of such a WAV as an .mp3
 *     Blob, byte for byte, with tags as ID3v2.3 and ID3v1 (null for any
 *     other file): MP3 in a WAV saved as the MP3 it is.
 *   TTAudio.wavWriter(o) -> a WAV built a block at a time: o = { sampleRate,
 *     channels, sampleFormat ('s16', 's24', 'f32', 'ulaw', 'alaw'), rf64,
 *     writable, tags, room }. .add(planes, n) takes n samples of each
 *     channel (Float32Arrays, full scale 1; integer formats are rounded and
 *     clipped, float kept as it is), .finish(tags) -> the Blob (RF64 with a
 *     ds64 chunk past 4 GB; tags as LIST INFO and id3 chunks, none for
 *     null), .frames() -> samples a channel so far. With o.writable (see
 *     convert) nothing is kept: each megabyte is written as it fills, after
 *     room for the header; .wait() -> a promise while a megabyte is still
 *     being written (else null), .finish() -> a promise of the bytes written
 *     (the header and o.tags, which the header's length depends on, are
 *     written last, then the stream is closed), .abort() discards it; with
 *     o.room the header keeps room for RF64's ds64 chunk, as a 'JUNK' chunk
 *     when the file stays under 4 GB. convert() writes every WAV with it.
 *   TTAudio.wavHeader(f) -> the bytes of a WAV header up to the data chunk's:
 *     f = { tag, channels, sampleRate, bits, frames, data (bytes of sound),
 *     info (a LIST chunk or null), after (bytes after the sound), rf64,
 *     junk (36 bytes of 'JUNK' chunk where RF64's ds64 would go) }.
 *
 * RESAMPLING
 *   TTAudio.resampler(inRate, outRate, channels) -> { process(planes, n) ->
 *     the planes that are ready, flush() -> the rest; taps }: a Kaiser-
 *     windowed sinc low-pass filter, polyphase for rational ratios such as
 *     160:147 (ratios of more than 1,024 phases interpolate between 512).
 *     The passband is flat within 0.001 dB to 20 kHz (to 0.907 of the lower
 *     Nyquist frequency below 44.1 kHz); a full-scale tone above the new
 *     Nyquist frequency folds back at least 90 dB down. It carries its state
 *     from block to block, so sound resampled a block at a time is the same
 *     as resampled at once, and n samples give round(n x out / in) once
 *     flushed. 10 minutes of 96 kHz stereo to 48 kHz take about 5 s of CPU
 *     in Chromium; convert() yields to the page between blocks.
 *   TTAudio.resample(planes, inRate, outRate) -> planes: a whole sound at once.
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
  var ALAC_WORKER_URL = new URL('alac-worker.js', SCRIPT || new URL('/assets/js/audio-engine.js', location.href).href).href;

  var UA = navigator.userAgent;
  var PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
  var LIMITS = {
    wav: PHONE ? 300e6 : 2e9,       // bytes of WAV built in memory
    mp3: PHONE ? 300e6 : 2e9,       // bytes of MP3 built in memory (not written into o.writable)
    zip: PHONE ? 300e6 : 2e9,       // bytes put in one ZIP
    whole: PHONE ? 1200 : 3600,     // seconds decoded at once without a streaming decoder
    alac: PHONE ? 300e6 : 2e9       // bytes of Apple Lossless files held by the decoder at once
  };
  // A module with one WebAssembly SIMD instruction: the MP3 encoder needs SIMD.
  var SIMD = (function () {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  })();
  // A module with one reference-types instruction: the ALAC decoder needs
  // reference types as well as SIMD (Chrome 96, Firefox 89, Safari 16.4).
  var REFTYPES = (function () {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 111, 3, 2, 1, 0, 10, 6, 1, 4, 0, 208, 111, 11])); } catch (e) { return false; }
  })();
  var ALAC_OK = SIMD && REFTYPES && typeof Worker !== 'undefined';
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
    ['ulaw', 'µ-law'], ['alaw', 'A-law'], ['alac', 'Apple Lossless (ALAC)']]);

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
    other: 'Something went wrong while reading this file ({message}).',
    mp3Free: 'This MP3 is in free format (its frames state no bitrate), which browsers cannot decode.',
    wavCodec: 'This WAV file holds {codec} sound, which this page cannot decode. An audio editor can save it again as ordinary (PCM) WAV, which this page reads.',
    tooBigMp3: 'As MP3 this would be about {size}, more than the {limit} this device can build in memory.',
    alacBits: 'This Apple Lossless file holds {bits}-bit sound, which this page cannot decode: it decodes 16 and 24-bit Apple Lossless.',
    alacChannels: 'This Apple Lossless file has {channels} channels, which this page cannot decode: it decodes Apple Lossless in mono or stereo.',
    alacBig: 'This Apple Lossless file is {size}. This page decodes Apple Lossless files of up to {limit} on this device, as the whole file is held in memory while it is decoded.',
    alacLong: 'This Apple Lossless file is too long to decode here: its sound would take more than 4 GB.',
    alacHeader: 'The Apple Lossless settings of this file could not be read, so it cannot be decoded.',
    alacSecond: 'This page decodes only the first Apple Lossless track of a file.',
    alacDamaged: 'The Apple Lossless sound could not be decoded. The file may be damaged.',
    alacClosed: 'This Apple Lossless file was closed to free memory for another one. Try again.',
    alacOpen: 'The Apple Lossless sound could not be decoded. The file may be damaged, or too big for the memory of this device.'
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
  // The source mediabunny reads a file from; m.audio is the Blob it reads.
  // A WAV file comes through wavSource(), the one place where a WAV is opened.
  async function sourceFor(file, m) {
    var head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    var tag = String.fromCharCode.apply(null, head.subarray(0, 4)), form = String.fromCharCode.apply(null, head.subarray(8, 12));
    m.audio = file;
    if ((tag === 'RIFF' || tag === 'RF64') && form === 'WAVE') m.audio = await wavSource(file, m);
    else if (tag.slice(0, 3) === 'ID3' || (head[0] === 255 && (head[1] & 0xE0) === 0xE0)) {
      // An MP3 (throws FREE_FORMAT for a free-format one). A VBRI header
      // frame is left out, as decoders leave it out: mediabunny would take it
      // for sound, or not read the file at all.
      var h = m.mp3head = await mp3Head(file);
      if (h && h.info && h.info.tag === 'VBRI') m.audio = new Blob([file.slice(0, h.offset), file.slice(h.offset + h.info.size)]);
    }
    var source = new MB.BlobSource(m.audio, { handleUnhandledError: function () {} });
    if (m.unsized) source._getFileSize = function () { return null; };
    return source;
  }
  // Every WAV file is opened here: m.wav gets its layout (wavParse). A codec
  // that browsers cannot decode is named; MP3 sound is read as the MP3 file
  // it is (its tags from the WAV's chunks); a header whose sizes are wrong
  // is replaced by one built here (wavWrapped), and so is an RF64 header
  // with chunks after the sound, whose tags mediabunny would not reach.
  async function wavSource(file, m) {
    var w = m.wav = await wavParse(file);
    if (!w || !w.fmt || w.dataStart < 0) return file;
    var f = w.fmt;
    w.mp3 = f.codec === 0x55;
    if (!WAV_READS[f.codec]) throw coded('WAV_CODEC', fill(TEXT.wavCodec, { codec: f.name }), { codec: f.codec });
    if (w.mp3) { m.tagBlob = wavTagBlob(file, w); return file.slice(w.dataStart, w.dataEnd); }
    var out = w.repaired || (w.rf64 && w.tail < file.size) ? wavWrapped(file, w) : file;
    // Past the 'data' chunk of an RF64 file, mediabunny 1.65.2 moves on by
    // the chunk's 32-bit size (0xFFFFFFFF), which lands inside sound of more
    // than 4 GB and reads it 8 bytes at a time where it is silent. A source
    // of unknown size makes it stop at the 'data' chunk.
    m.unsized = (out === file ? w.rf64 : w.big) && w.dataEnd - w.dataStart > 0xFFFFFFFF;
    return out;
  }

  async function open(file, opts) {
    await load();
    var name = String(file && file.name || '');
    var nameDrm = /\.m4p$/i.test(name) ? 'fairplay' : /\.aax?$/i.test(name) ? 'audible' : '';
    var m = { file: file, input: null, audio: file, container: 'other', tracks: [], primary: 0, tags: emptyTags(), drm: '', wav: null, alacOn: !!(opts && opts.alac) };
    try {
      if (!file || !(file.size > 0)) throw coded('EMPTY', TEXT.empty);
      m.input = new MB.Input({
        source: await sourceFor(file, m),
        formats: m.wav && m.wav.fmt && !m.wav.mp3 ? [MB.WAVE] : MB.ALL_FORMATS,
        formatOptions: { isobmff: { resolveKeyId: function () { m.drm = m.drm || 'cenc'; throw new Error(PROTECTED_MARK); } } }
      });
      if (!(await m.input.canRead())) {
        if (nameDrm) throw drmError(nameDrm);
        await mp3Head(file);   // throws FREE_FORMAT for a free-format MP3
        throw coded('UNREADABLE', TEXT.unreadable);
      }
      var fmt = await m.input.getFormat();
      m.container = m.wav && m.wav.fmt ? 'wav' : containerOf(fmt);
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
    // Apple Lossless: mediabunny reads the track but has no decoder for it;
    // the engine's own decodes it (see alacSource).
    info.alac = null;
    info.unsupported = '';
    if (info.internal === 'alac' && !info.drm && m.alacOn) await alacInfo(m, info);
    info.decodable = info.alac ? ALAC_OK && !info.unsupported : !info.drm && !!info.codec && (await tr.canDecode());
    info.whole = !info.alac && !info.decodable && !info.drm && !!info.codec && typeof OfflineAudioContext !== 'undefined' &&
      (typeof AudioDecoder === 'undefined' || WHOLE_CODECS.test(info.codec));
    info.t0 = Math.max(0, info.first || 0);
    info.mp3 = null;
    if (info.codec === 'mp3' && !info.drm && (m.container === 'mp3' || (m.wav && m.wav.mp3))) await mp3Timing(m, info);
    info.durMs = Math.max(0, Math.round((info.end - info.t0) * 1000));
    if (!info.bitrate && !info.drm && info.codec && !/^pcm-/.test(info.codec)) info.bitrate = await measureBitrate(tr);
    return info;
  }

  // An MP3's length as its LAME tag gives it. mediabunny drops the encoder
  // delay the tag states but keeps the padding after the last sample, which
  // a gapless decoder drops: the sound ends where the tag says, so a WAV made
  // of it is as long as what was encoded. Without a tag everything decoded
  // is kept, with the encoder's lead-in (about 25 ms: 576 + 529 samples for
  // LAME, the usual encoder); info.mp3 says which.
  async function mp3Timing(m, info) {
    var head = m.mp3head || null;
    if (m.mp3head === undefined) { try { head = await mp3Head(m.audio || m.file); } catch (e) { head = null; } }
    var i = head && head.info, h = head && head.header;
    info.mp3 = { gapless: false, delay: 0, padding: 0, frames: i && i.frames || 0, samples: 0,
      leadIn: LAME_DELAY + MP3_DECODER_DELAY, tag: i ? i.tag : '', encoder: i ? i.encoder : '', crcOk: i ? i.crcOk : null };
    if (!h || !i || !i.lame || !(i.frames > 0)) return;
    var n = i.frames * h.spf - i.delay - i.padding;
    if (!(n > 0)) return;
    var start = (info.first || 0) + (i.delay + MP3_DECODER_DELAY) / h.sampleRate;
    if (Math.abs(start) < 1e-9) start = 0;
    info.mp3.gapless = true; info.mp3.delay = i.delay; info.mp3.padding = i.padding; info.mp3.samples = n; info.mp3.leadIn = 0;
    info.t0 = Math.max(0, start);
    info.end = info.listed = Math.min(info.end, start + n / h.sampleRate);
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
    var t = {}, own = m.tagBlob ? new MB.Input({ source: new MB.BlobSource(m.tagBlob), formats: [MB.WAVE] }) : null;
    try { t = await (own || m.input).getMetadataTags() || {}; } catch (e) { t = {}; }
    if (own) { try { own.dispose(); } catch (x) { /* ignore */ } }
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

  // Every MP3 this engine makes is finished here before it is returned: its
  // Info or Xing frame is written again for gapless decoders (mp3Gapless,
  // with info.samples, the number of samples encoded), the ID3v2.3 tag goes
  // in front of the frames and the ID3v1 tag after them. info: { sampleRate,
  // channels, kbps, samples }.
  function finishMp3(bytes, tags, info) {
    var u8 = info && info.samples > 0 ? mp3Gapless(bytes, info.samples) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var parts = [], head = tags ? id3v23(tags) : new Uint8Array(0), tail = tags ? id3v1(tags) : null;
    if (head.length) parts.push(head);
    parts.push(u8);
    if (tail) parts.push(tail);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  // mediabunny's tags for an M4A. Two fields go in as raw tags, round
  // mediabunny 1.65.2: a year-only date would become 1 January, and its
  // 'disc' atom should be 'disk'.
  function mbTags(tags) {
    var t = { creationTime: null };
    if (!tags) return t;
    ['title', 'artist', 'album', 'albumArtist', 'genre', 'comment', 'lyrics'].forEach(function (k) { if (tags[k]) t[k] = String(tags[k]); });
    if (whole(tags.track)) { t.trackNumber = whole(tags.track); if (whole(tags.tracks)) t.tracksTotal = whole(tags.tracks); }
    var raw = {}, date = dateText(tags.date), disc = whole(tags.disc), discs = whole(tags.discs);
    if (date) raw['\u00a9day'] = date;
    if (tags.composer) raw['\u00a9wrt'] = String(tags.composer);
    if (disc) raw.disk = new Uint8Array([0, 0, disc >> 8 & 255, disc & 255, discs >> 8 & 255, discs & 255]);
    if (Object.keys(raw).length) t.raw = raw;
    var images = (tags.images || []).filter(function (im) { return im && im.data && im.data.length; });
    if (images.length) t.images = images;
    return t;
  }

  // ---------- Bytes ----------
  function u16be(b, p) { return b[p] << 8 | b[p + 1]; }
  function u32be(b, p) { return (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0; }
  function u16le(b, p) { return b[p] | b[p + 1] << 8; }
  function u32le(b, p) { return (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0; }
  function u64le(b, p) { return u32le(b, p) + u32le(b, p + 4) * 4294967296; }
  function ascii(b, p, n) { return p >= 0 && p + n <= b.length ? String.fromCharCode.apply(null, b.subarray(p, p + n)) : ''; }
  function putAscii(b, p, s) { for (var i = 0; i < s.length; i++) b[p + i] = s.charCodeAt(i) & 255; }
  function put32be(b, p, v) { b[p] = v >>> 24 & 255; b[p + 1] = v >>> 16 & 255; b[p + 2] = v >>> 8 & 255; b[p + 3] = v & 255; }
  function syncsafe(b, p) { return (b[p] & 127) << 21 | (b[p + 1] & 127) << 14 | (b[p + 2] & 127) << 7 | (b[p + 3] & 127); }
  // CRC-16/ARC (polynomial 0x8005, reflected, starting at 0), as the LAME
  // tag uses for its own bytes and for the music after it.
  var CRC_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var i = 0; i < 256; i++) { var c = i; for (var k = 0; k < 8; k++) c = c & 1 ? c >>> 1 ^ 0xA001 : c >>> 1; t[i] = c; }
    return t;
  })();
  function crc16(b, from, to, crc) {
    crc = crc || 0;
    for (var i = from || 0, n = to == null ? b.length : to; i < n; i++) crc = crc >>> 8 ^ CRC_TABLE[(crc ^ b[i]) & 255];
    return crc;
  }

  // ---------- MP3 frames ----------
  // MPEG-1, 2 and 2.5 Layer III. A frame is a 4-byte header, a CRC when the
  // header says so, the side information and the main data; main_data_begin
  // says how many bytes of that main data sit in the frames before (the bit
  // reservoir). The first frame of most files is no sound but an Info (CBR)
  // or Xing (VBR) header, usually with a LAME tag that says how many samples
  // of encoder delay and of end padding to drop; Fraunhofer encoders write a
  // VBRI header instead.
  var MP3_KBPS = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
  var MP3_RATES_BY_ID = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  var MP3_DECODER_DELAY = 529;     // samples every Layer III decoder outputs before the first one encoded
  var LAME_DELAY = 576;            // LAME's encoder delay, and the usual lead-in of files without a LAME tag
  var MP3_ENCODERS = /^(LAME|Lavf|Lavc|L3\.99|GOGO)/;   // LAME tags whose delay and padding decoders honour
  function mp3Header(b, p) {
    if (p < 0 || p + 4 > b.length || b[p] !== 255 || (b[p + 1] & 0xE0) !== 0xE0) return null;
    var id = b[p + 1] >> 3 & 3, layer = b[p + 1] >> 1 & 3, bri = b[p + 2] >> 4, sri = b[p + 2] >> 2 & 3;
    if (id === 1 || layer !== 1 || bri === 15 || sri === 3 || (b[p + 3] & 3) === 2) return null;
    var v1 = id === 3, mode = b[p + 3] >> 6, sr = MP3_RATES_BY_ID[id][sri], kbps = MP3_KBPS[v1 ? 0 : 1][bri], pad = b[p + 2] >> 1 & 1;
    return {
      id: id, version: v1 ? 1 : id === 2 ? 2 : 2.5, crc: !(b[p + 1] & 1), bitrateIndex: bri, kbps: kbps, free: bri === 0,
      sampleRateIndex: sri, sampleRate: sr, padding: pad, mode: mode, modeExtension: b[p + 3] >> 4 & 3, channels: mode === 3 ? 1 : 2,
      priv: b[p + 2] & 1, flags: b[p + 3] & 15, spf: v1 ? 1152 : 576, side: v1 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17),
      size: bri ? Math.floor((v1 ? 144000 : 72000) * kbps / sr) + pad : 0
    };
  }
  // Frames of one stream keep their MPEG version, sample rate and mono or
  // not; a header that changes them is a false sync.
  function sameStream(h, h0) { return h.id === h0.id && h.sampleRateIndex === h0.sampleRateIndex && (h.mode === 3) === (h0.mode === 3); }
  function freeFormat() { return coded('FREE_FORMAT', TEXT.mp3Free); }
  // The tags around the frames: ID3v2 at the start (one or more), and at the
  // end ID3v1, APEv2, Lyrics3 v2 or an ID3v2 tag with a footer, in any order.
  function mp3Tags(b) {
    var tags = [], p = 0, e = b.length, len;
    while (p + 10 <= e && ascii(b, p, 3) === 'ID3' && b[p + 3] < 255 && !((b[p + 6] | b[p + 7] | b[p + 8] | b[p + 9]) & 128)) {
      len = 10 + syncsafe(b, p + 6) + (b[p + 5] & 16 ? 10 : 0);
      tags.push({ kind: 'id3v2', start: p, end: Math.min(e, p + len) });
      p += len;
    }
    for (var again = true; again && e > p;) {
      again = false;
      var st = -1, kind = '';
      if (e - 128 >= p && ascii(b, e - 128, 3) === 'TAG') { st = e - 128; kind = 'id3v1'; }
      else if (e - 32 >= p && ascii(b, e - 32, 8) === 'APETAGEX') { st = e - u32le(b, e - 20) - (u32le(b, e - 12) & 0x80000000 ? 32 : 0); kind = 'ape'; }
      else if (e - 15 >= p && ascii(b, e - 9, 9) === 'LYRICS200' && /^\d{6}$/.test(ascii(b, e - 15, 6))) { st = e - 15 - +ascii(b, e - 15, 6); kind = 'lyrics3'; }
      else if (e - 10 >= p && ascii(b, e - 10, 3) === '3DI') { st = e - 20 - syncsafe(b, e - 4); kind = 'id3v2'; }
      if (st >= p && st < e) { tags.push({ kind: kind, start: st, end: e }); e = st; again = true; }
    }
    return { tags: tags, start: p, end: e };
  }
  // The first frame from p on whose header is followed by two more of the
  // same stream (or by the end of the frames). A free-format stream (no
  // bitrate in its headers) is refused: browsers and this page cannot read it.
  function mp3Sync(b, p, end, h0) {
    for (; p + 4 <= end; p++) {
      if (b[p] !== 255) continue;
      var h = mp3Header(b, p);
      if (!h || (h0 && !sameStream(h, h0))) continue;
      if (h.free) {
        // Free format: two more headers like it, evenly spaced (give or take a padding byte).
        for (var d = 21; d < 2000 && p + 2 * d + 5 <= end; d++) {
          var f2 = mp3Header(b, p + d);
          if (!f2 || !f2.free || !sameStream(f2, h)) continue;
          for (var e2 = -1; e2 <= 1; e2++) {
            var f3 = mp3Header(b, p + 2 * d + e2);
            if (f3 && f3.free && sameStream(f3, h)) throw freeFormat();
          }
        }
        continue;
      }
      var q1 = p + h.size, n = 0, bad = false;
      while (n < 2 && q1 + 4 <= end) {
        var h2 = mp3Header(b, q1);
        if (!h2 || h2.free || !sameStream(h2, h)) { bad = true; break; }
        q1 += h2.size; n++;
      }
      if (n === 2 || (!bad && (n > 0 || q1 === end))) return p;
    }
    return -1;
  }
  // The Xing, Info or VBRI header in the frame at p (header h), or null.
  function mp3Info(b, p, h) {
    var offs = [p + 4 + h.side];
    if (h.crc) offs.push(p + 6 + h.side);
    for (var i = 0; i < offs.length; i++) {
      var o = offs[i], tag = ascii(b, o, 4);
      if (tag !== 'Xing' && tag !== 'Info') continue;
      var fl = u32be(b, o + 4), q = o + 8;
      var r = { tag: tag, vbr: tag === 'Xing', pos: p, size: h.size, frames: null, bytes: null, toc: null, quality: null,
        encoder: '', lame: false, delay: null, padding: null, crcOk: null, musicLength: null, musicCrc: null };
      if (fl & 1) { r.frames = u32be(b, q); q += 4; }
      if (fl & 2) { r.bytes = u32be(b, q); q += 4; }
      if (fl & 4) { r.toc = b.slice(q, q + 100); q += 100; }
      if (fl & 8) { r.quality = u32be(b, q); q += 4; }
      if (q + 36 <= p + h.size && q + 36 <= b.length) {
        var enc = ascii(b, q, 9);
        r.encoder = enc.replace(/[^\x20-\x7e]/g, '').trim();
        if (MP3_ENCODERS.test(enc)) {
          var v = b[q + 21] << 16 | b[q + 22] << 8 | b[q + 23];
          r.lame = true; r.delay = v >> 12; r.padding = v & 4095;
          r.musicLength = u32be(b, q + 28); r.musicCrc = u16be(b, q + 32);
          r.crcOk = crc16(b, p, q + 34) === u16be(b, q + 34);
        }
      }
      return r;
    }
    var w = p + 36;
    if (ascii(b, w, 4) === 'VBRI' && w + 26 <= b.length) {
      var count = u16be(b, w + 18), scale = u16be(b, w + 20), es = u16be(b, w + 22), toc = [];
      for (var k = 0, z = w + 26; k < count && es >= 1 && es <= 4 && z + es <= b.length; k++, z += es) {
        for (var x = 0, y = 0; y < es; y++) x = x * 256 + b[z + y];
        toc.push(x * scale);
      }
      return { tag: 'VBRI', vbr: true, pos: p, size: h.size, version: u16be(b, w + 4), delay: u16be(b, w + 6), quality: u16be(b, w + 8),
        bytes: u32be(b, w + 10), frames: u32be(b, w + 14), toc: toc, framesPerEntry: u16be(b, w + 24), encoder: '', lame: false,
        padding: null, crcOk: null };
    }
    return null;
  }
  // Every frame of an MP3 file held in b (a Uint8Array): see the header.
  function mp3Frames(b) {
    b = b instanceof Uint8Array ? b : new Uint8Array(b);
    var t = mp3Tags(b), end = t.end, p = mp3Sync(b, t.start, end, null);
    if (p < 0) return null;
    var junk = p - t.start, h0 = mp3Header(b, p), info = mp3Info(b, p, h0), cap = 1024, n = 0, kbpsSeen = -1, cbr = true, cut = false;
    var pos = new Float64Array(cap), size = new Uint16Array(cap), kbps = new Uint16Array(cap), mdb = new Uint16Array(cap);
    if (info) p += h0.size;
    while (p + 4 <= end) {
      var h = mp3Header(b, p);
      if (!h || h.free || !sameStream(h, h0)) {
        var q = mp3Sync(b, p + 1, end, h0);
        if (q < 0) { junk += end - p; break; }
        junk += q - p; p = q;
        continue;
      }
      if (p + h.size > end) { cut = true; break; }
      if (n === cap) {
        cap *= 2;
        var grow = function (a, T) { var x = new T(cap); x.set(a); return x; };
        pos = grow(pos, Float64Array); size = grow(size, Uint16Array); kbps = grow(kbps, Uint16Array); mdb = grow(mdb, Uint16Array);
      }
      var s = p + 4 + (h.crc ? 2 : 0);
      pos[n] = p; size[n] = h.size; kbps[n] = h.kbps;
      mdb[n] = h.id === 3 ? b[s] << 1 | b[s + 1] >> 7 : b[s];
      if (kbpsSeen < 0) kbpsSeen = h.kbps; else if (h.kbps !== kbpsSeen) cbr = false;
      n++;
      p += h.size;
    }
    var first = n ? mp3Header(b, pos[0]) : h0;
    return {
      count: n, pos: pos.subarray(0, n), size: size.subarray(0, n), kbps: kbps.subarray(0, n), mdb: mdb.subarray(0, n),
      start: n ? pos[0] : p, end: n ? pos[n - 1] + size[n - 1] : p, version: first.version, id: first.id, sampleRate: first.sampleRate,
      sampleRateIndex: first.sampleRateIndex, spf: first.spf, granules: first.id === 3 ? 2 : 1, side: first.side, channels: first.channels,
      mode: first.mode, modeExtension: first.modeExtension, priv: first.priv, flags: first.flags,
      crc: first.crc, cbr: cbr && n > 0, info: info, tags: t.tags, junk: junk, cutShort: cut
    };
  }
  // The number of samples the frames hold as encoded, when a LAME tag says.
  function mp3Samples(fr) {
    var i = fr && fr.info;
    if (!i || !i.lame || i.delay == null || !(i.frames > 0)) return -1;
    var n = i.frames * fr.spf - i.delay - i.padding;
    return n > 0 ? n : -1;
  }
  // How many frames before frame k a decoder must read for k's sound to come
  // out exactly as in the whole file: the frames it must decode in full,
  // and before them the frames that hold the start of their main data. The
  // sound of a granule overlaps the one before it, and the synthesis filter
  // carries the last 16 of its 18 slots on, so the granule before k's first
  // must decode exactly, and the one before that too for its overlap: one
  // frame in MPEG-1 (two granules a frame), two in MPEG-2 and 2.5 (one).
  function mp3LeadIn(fr, k) {
    if (k <= 0) return 0;
    var first = Math.max(0, k - (fr.granules === 2 ? 1 : 2)), need = fr.mdb[first], have = 0, lead = k - first, over = 4 + (fr.crc ? 2 : 0) + fr.side;
    for (var i = first - 1; need > have && i >= 0; i--) { have += fr.size[i] - over; lead++; }
    return lead;
  }
  // The Xing table of contents for `count` frames from `first`, after an Info
  // or Xing frame of infoSize bytes: per percent of the time, the position
  // (in 256ths of the bytes) of the frame where it starts.
  function mp3Toc(fr, first, count, infoSize) {
    var toc = new Uint8Array(100);
    if (!count) return toc;
    var base = fr.pos[first], total = infoSize + fr.pos[first + count - 1] + fr.size[first + count - 1] - base;
    for (var i = 0; i < 100; i++) {
      var k = first + Math.floor(i * count / 100);
      toc[i] = Math.min(255, Math.floor(256 * (infoSize + fr.pos[k] - base) / total));
    }
    return toc;
  }
  // An Info (constant bitrate) or Xing (variable bitrate) frame with a LAME
  // tag, to put in front of `frames` frames of `bytes` bytes. o: { id,
  // sampleRateIndex, mode, modeExtension, priv, flags (from the stream's
  // header: mp3Header() gives them), kbps (a CBR stream's
  // own bitrate; null for the smallest frame that holds the tag), vbr,
  // frames, bytes, toc (100 bytes, a function (frameSize) giving them, or
  // null), delay, padding (0 to 4095 samples), musicCrc, encoder (default
  // 'LAME3.100') }. A CBR frame too small for the table of contents goes
  // without one; returns a Uint8Array.
  function mp3InfoFrame(o) {
    var id = o.id, v1 = id === 3, mode = o.mode & 3, side = v1 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17);
    var sr = MP3_RATES_BY_ID[id][o.sampleRateIndex], table = MP3_KBPS[v1 ? 0 : 1], toc = o.toc || null;
    var sizeAt = function (bri) { return Math.floor((v1 ? 144000 : 72000) * table[bri] / sr); };
    var need = function () { return 4 + side + 16 + (toc ? 100 : 0) + 36; };
    var bri = o.kbps ? table.indexOf(o.kbps) : -1;
    if (bri > 0 && sizeAt(bri) < need() && !o.vbr) toc = null;
    if (!(bri > 0) || sizeAt(bri) < need()) for (bri = 1; bri < 14 && sizeAt(bri) < need(); bri++);
    var size = sizeAt(bri), f = new Uint8Array(size), q = 4 + side;
    if (typeof toc === 'function') toc = toc(size);
    f[0] = 255; f[1] = 0xE0 | id << 3 | 3; f[2] = bri << 4 | o.sampleRateIndex << 2 | (o.priv & 1);
    f[3] = mode << 6 | (mode === 1 ? (o.modeExtension || 0) << 4 : 0) | (o.flags & 15);
    putAscii(f, q, o.vbr ? 'Xing' : 'Info');
    put32be(f, q + 4, toc ? 7 : 3);
    put32be(f, q + 8, o.frames);
    put32be(f, q + 12, size + o.bytes);
    if (toc) f.set(toc.subarray ? toc.subarray(0, 100) : toc, q + 16);
    var l = q + 16 + (toc ? 100 : 0), delay = Math.max(0, Math.min(4095, Math.round(o.delay) || 0)), pad = Math.max(0, Math.min(4095, Math.round(o.padding) || 0));
    putAscii(f, l, (String(o.encoder || 'LAME3.100') + '         ').slice(0, 9));
    f[l + 9] = o.vbr ? 4 : 1;                      // tag revision 0; VBR method: CBR (1) or VBR (4)
    f[l + 20] = o.vbr ? 0 : Math.min(255, table[bri]);
    f[l + 21] = delay >> 4; f[l + 22] = (delay & 15) << 4 | pad >> 8; f[l + 23] = pad & 255;
    f[l + 24] = (sr === 44100 ? 1 : sr === 48000 ? 2 : 0) << 6;   // source sample rate
    put32be(f, l + 28, size + o.bytes);
    f[l + 32] = (o.musicCrc || 0) >> 8 & 255; f[l + 33] = (o.musicCrc || 0) & 255;
    var crc = crc16(f, 0, l + 34);
    f[l + 34] = crc >> 8; f[l + 35] = crc & 255;
    return f;
  }
  // An MP3 this engine wrote, its Info or Xing frame written again so that
  // decoders that honour the LAME tag (ffmpeg, Chromium, foobar2000, Apple's)
  // give exactly `samples` samples: the frame count without the Info frame,
  // the encoder's delay, the padding from the real number of samples, the
  // CRCs, and for CBR the stream's own bitrate. Other bytes are unchanged;
  // returns the bytes as they were when they cannot be read or the padding
  // does not fit the tag.
  function mp3Gapless(bytes, samples) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), fr;
    try { fr = mp3Frames(u8); } catch (e) { return u8; }
    if (!fr || !fr.count || !(samples > 0)) return u8;
    var delay = fr.info && fr.info.delay != null ? fr.info.delay : LAME_DELAY, padding = fr.count * fr.spf - delay - samples;
    if (padding < 0 || padding > 4095) return u8;
    var body = u8.subarray(fr.start, fr.end), h = mp3Header(u8, fr.start);
    var frame = mp3InfoFrame({ id: h.id, sampleRateIndex: h.sampleRateIndex, mode: h.mode, modeExtension: h.modeExtension, priv: h.priv,
      flags: h.flags, kbps: fr.cbr ? h.kbps : null, vbr: !fr.cbr, frames: fr.count, bytes: body.length, delay: delay, padding: padding,
      musicCrc: crc16(body), toc: function (size) { return mp3Toc(fr, 0, fr.count, size); } });
    return concatBytes([u8.subarray(0, fr.info ? fr.info.pos : fr.start), frame, body, u8.subarray(fr.end)]);
  }
  // An MP3 written into `writable` (convert()'s o.writable) as it is made, as
  // finishMp3() lays it out: the ID3v2.3 tag, room for the Info frame, the
  // frames, the ID3v1 tag. mediabunny writes the frames alone (no Xing frame
  // of its own) through .sink; their count, positions and CRC are taken as
  // they pass, and .finish(samples) puts in the room the Info frame that
  // mp3Gapless() writes, then closes the stream. .abort() discards it.
  function mp3Stream(writable, tags, sampleRate, channels, kbps) {
    var id = sampleRate >= 32000 ? 3 : sampleRate >= 16000 ? 2 : 0, sri = MP3_RATES_BY_ID[id].indexOf(sampleRate);
    var head = tags ? id3v23(tags) : new Uint8Array(0), tail = tags ? id3v1(tags) : null, mode = channels === 1 ? 3 : 1;
    var room = mp3InfoFrame({ id: id, sampleRateIndex: sri, mode: mode, kbps: kbps, frames: 0, bytes: 0, toc: new Uint8Array(100) }).length;
    var fw = writable.getWriter(), base = head.length + room, done = false;
    var s = { bytes: 0, crc: 0, count: 0, next: 0, pos: new Float64Array(4096), size: new Uint32Array(4096), carry: new Uint8Array(0), h0: null, cbr: true, lost: false };
    if (head.length) fw.write({ type: 'write', position: 0, data: head }).catch(function () {});
    // Frame headers as the bytes pass; one may straddle two writes.
    function track(d) {
      var off = s.bytes, carry = s.carry;
      var at = function (q) { return q >= off ? d[q - off] : carry[carry.length - (off - q)]; };
      while (!s.lost && s.next + 4 <= off + d.length) {
        var h = mp3Header(new Uint8Array([at(s.next), at(s.next + 1), at(s.next + 2), at(s.next + 3)]), 0);
        if (!h || !h.size) { s.lost = true; break; }
        if (s.count === s.pos.length) {
          var p2 = new Float64Array(s.pos.length * 2), z2 = new Uint32Array(s.pos.length * 2);
          p2.set(s.pos); z2.set(s.size); s.pos = p2; s.size = z2;
        }
        if (!s.h0) s.h0 = h; else if (h.kbps !== s.h0.kbps) s.cbr = false;
        s.pos[s.count] = s.next; s.size[s.count] = h.size; s.count++;
        s.next += h.size;
      }
      var all = carry.length + d.length, keep = new Uint8Array(Math.min(3, all));
      for (var i = 0; i < keep.length; i++) keep[i] = at(off + d.length - keep.length + i);
      s.carry = keep;
    }
    s.sink = new WritableStream({
      write: function (chunk) {
        var d = chunk && chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data);
        if (chunk.position !== s.bytes) throw new Error('The MP3 frames were not written in order.');
        s.crc = crc16(d, 0, d.length, s.crc);
        track(d);
        s.bytes += d.length;
        return fw.write({ type: 'write', position: base + chunk.position, data: d });
      },
      close: function () {}, abort: function () {}
    });
    s.finish = async function (samples) {
      var h = s.h0;
      if (!h || s.lost || s.next !== s.bytes) throw new Error('The MP3 frames could not be read back.');
      var padding = Math.max(0, Math.min(4095, s.count * h.spf - LAME_DELAY - samples));
      var o = { id: h.id, sampleRateIndex: h.sampleRateIndex, mode: h.mode, modeExtension: h.modeExtension, priv: h.priv, flags: h.flags,
        kbps: s.cbr ? h.kbps : null, vbr: !s.cbr, frames: s.count, bytes: s.bytes, delay: LAME_DELAY, padding: padding, musicCrc: s.crc,
        toc: function (size) { return mp3Toc({ pos: s.pos, size: s.size }, 0, s.count, size); } };
      var frame = mp3InfoFrame(o);
      if (frame.length !== room) { o.kbps = kbps; o.vbr = false; frame = mp3InfoFrame(o); }
      await fw.write({ type: 'write', position: head.length, data: frame });
      if (tail) await fw.write({ type: 'write', position: base + s.bytes, data: tail });
      done = true;
      await fw.close();
      return base + s.bytes + (tail ? tail.length : 0);
    };
    s.abort = function () { if (!done) { done = true; return fw.abort().catch(function () {}); } };
    return s;
  }
  // The main data that frame k takes from the frames before it (its
  // main_data_begin bytes, the bit reservoir), held in frames of silence
  // to put in front of frame k in place of the frames those bytes come
  // from: a cut then needs no more than these before frame k, however far
  // back the reservoir reaches (seven frames at 32 kbps). The frames have
  // the stream's header bits, no CRC and side information of zeros, so
  // they decode to silence, and no more main data than a decoder keeps
  // (511 bytes, 255 in MPEG-2 and 2.5): one frame, at the stream's bitrate
  // when it holds the bytes, else the smallest that does, or two when no
  // single frame does, the second's main data starting in the first. With
  // `silent`, one frame of silence holding nothing; null when frame k
  // takes nothing from before it. Returns a Uint8Array of whole frames.
  function mp3Donor(bytes, fr, k, silent) {
    var over = 4 + (fr.crc ? 2 : 0) + fr.side, need = silent ? 0 : fr.mdb[k], parts = [], have = 0, i;
    if (!need && !silent) return null;
    for (i = k - 1; i >= 0 && have < need; i--) { parts.unshift(bytes.subarray(fr.pos[i] + over, fr.pos[i] + fr.size[i])); have += fr.size[i] - over; }
    var data = concatBytes(parts);
    data = data.subarray(Math.max(0, data.length - need));
    var v1 = fr.id === 3, table = MP3_KBPS[v1 ? 0 : 1], max = v1 ? 511 : 255, side = fr.side, q = fr.pos[Math.min(k, fr.count - 1)];
    var area = function (bri) { return Math.floor((v1 ? 144000 : 72000) * table[bri] / fr.sampleRate) - 4 - side; };
    var fits = function (bri, n) { return area(bri) >= n && area(bri) <= max; };
    var frame = function (bri, mdb, body) {
      var f = new Uint8Array(area(bri) + 4 + side);
      f[0] = 255; f[1] = bytes[q + 1] | 1; f[2] = bri << 4 | (bytes[q + 2] & 0x0D); f[3] = bytes[q + 3];
      if (v1) { f[4] = mdb >> 1; f[5] = (mdb & 1) << 7; } else f[4] = mdb;
      f.set(body, f.length - body.length);
      return f;
    };
    var bri = table.indexOf(fr.kbps[Math.min(k, fr.count - 1)]);
    if (!(bri > 0 && fits(bri, data.length))) for (bri = 1; bri < 15 && !fits(bri, data.length); bri++);
    if (bri < 15) return frame(bri, 0, data);
    var rest = data.length - area(1);
    for (bri = 1; bri < 15 && !fits(bri, rest); bri++);
    return concatBytes([frame(bri, 0, data.subarray(0, rest)), frame(1, rest, data.subarray(rest))]);
  }
  // An exact cut of the MP3 in bytes (fr: its mp3Frames()), without
  // re-encoding: the samples start to end (end not included) of its sound
  // as decoders give it, after the encoder delay and without the padding
  // when a LAME tag states them, else every sample decoded (the lead-in
  // too). Whole frames are copied, from the one that holds `start` to the
  // one that holds `end`, with the frames before it that the decoder needs
  // (mp3LeadIn), or, where those would be more than the LAME tag's delay
  // can skip (4,095 samples: low bitrates), the frames of mp3Donor(); a new
  // Info (CBR) or Xing (VBR, with a table of contents) frame goes in front,
  // its LAME tag (signed LAME, as every reader of the tag knows that name)
  // pinning playback to exactly those samples in decoders that read it
  // (ffmpeg, Chromium, Firefox, Apple's, foobar2000). Others also
  // play the frames before `start` (the `lead` frames, 25 to 80 ms) and
  // up to a frame after `end` (four in a cut under seven frames, which is
  // made longer for ffmpeg to recognise it). One limit of ffmpeg 6 (not of
  // Chromium): a cut that lies within one frame (under 26 ms at 44.1 kHz)
  // keeps that frame's samples before `start` too. Returns { bytes (Uint8Array:
  // the frames, without tags; put ID3v2 before and ID3v1 after), start, end
  // (as clamped to the sound), frames, delay, padding (the LAME tag's),
  // lead, donors (frames of silence put in) }, or null for an empty cut.
  function mp3Cut(bytes, fr, start, end) {
    var spf = fr.spf, D = MP3_DECODER_DELAY, i = fr.info, lame = !!(i && i.lame && i.delay != null);
    var skip = lame ? i.delay + D : 0, total = lame ? Math.max(0, mp3Samples(fr)) : fr.count * spf;
    start = Math.max(0, Math.min(total, Math.round(start) || 0));
    end = Math.max(start, Math.min(total, Math.round(end) || 0));
    if (end <= start || !fr.count) return null;
    var P = start + skip, F = Math.min(fr.count - 1, Math.floor(P / spf)), o = P - F * spf;
    var last = Math.max(F, Math.min(fr.count - 1, Math.ceil((end + skip) / spf) - 1));
    var first = F - mp3LeadIn(fr, F), pre = null;
    if ((F - first) * spf + o - D > 4095) { first = Math.max(0, F - (fr.granules === 2 ? 1 : 2)); pre = mp3Donor(bytes, fr, first); }
    if (!pre && (F - first) * spf + o < D) pre = mp3Donor(bytes, fr, first, true);
    var donors = [], at = 0;
    while (pre && at < pre.length) { var dh = mp3Header(pre, at); donors.push({ at: at, kbps: dh.kbps }); at += dh.size; }
    var lead = F - first + donors.length, count = last - first + 1 + donors.length, preLen = pre ? pre.length : 0;
    var delay = lead * spf + o - D, padding = count * spf - delay - (end - start);
    // At least two frames, as decoders take no MP3 of one, and seven where
    // the LAME tag's delay and padding allow, as ffmpeg recognises an MP3 by
    // seven frames in a row: frames after the end, then frames of silence.
    while (count < 7 && last < fr.count - 1 && (count < 2 || padding + spf <= 4095)) { last++; count++; padding += spf; }
    while (count < 2 || (count < 7 && delay + spf <= 4095)) {
      var sil = mp3Donor(bytes, fr, first, true);
      pre = pre ? concatBytes([sil, pre]) : sil;
      donors = donors.map(function (d) { return { at: d.at + sil.length, kbps: d.kbps }; });
      donors.unshift({ at: 0, kbps: mp3Header(sil, 0).kbps });
      preLen = pre.length; lead++; count++; delay += spf;
    }
    // The frames as they are, without what lies between them in the file (junk, a cut-off frame).
    var parts = pre ? [pre] : [], offs = [], len = preLen, run = fr.pos[first], k;
    for (k = first; k <= last; k++) {
      if (k > first && fr.pos[k] !== fr.pos[k - 1] + fr.size[k - 1]) { parts.push(bytes.subarray(run, fr.pos[k - 1] + fr.size[k - 1])); run = fr.pos[k]; }
      offs.push(len); len += fr.size[k];
    }
    parts.push(bytes.subarray(run, fr.pos[last] + fr.size[last]));
    var body = concatBytes(parts);
    var h = mp3Header(bytes, fr.pos[first]), cbr = fr.cbr && donors.every(function (d) { return d.kbps === h.kbps; });
    var info = mp3InfoFrame({ id: fr.id, sampleRateIndex: fr.sampleRateIndex, mode: h.mode, modeExtension: h.modeExtension, priv: h.priv,
      flags: h.flags, kbps: cbr ? h.kbps : null, vbr: !cbr, frames: count, bytes: body.length, delay: delay, padding: padding,
      musicCrc: crc16(body), encoder: lame && /^LAME/.test(i.encoder) ? i.encoder : '',
      toc: function (size) {
        var toc = new Uint8Array(100), all = size + body.length;
        for (var t = 0; t < 100; t++) {
          var j = Math.floor(t * count / 100), off = j < donors.length ? donors[j].at : offs[j - donors.length];
          toc[t] = Math.min(255, Math.floor(256 * (size + off) / all));
        }
        return toc;
      } });
    return { bytes: concatBytes([info, body]), start: start, end: end, frames: count, delay: delay, padding: padding, lead: lead, donors: donors.length };
  }
  // The whole of an MP3 file, for a page that copies or cuts its frames.
  async function readMp3(blob) {
    var b = new Uint8Array(await blob.arrayBuffer());
    return { bytes: b, frames: mp3Frames(b) };
  }
  // The first frame of an MP3 file, read from its start: { header, info, offset } or null.
  async function mp3Head(blob) {
    var p = 0, b;
    for (var i = 0; i < 8; i++) {
      b = new Uint8Array(await blob.slice(p, p + 65536).arrayBuffer());
      if (b.length < 10 || ascii(b, 0, 3) !== 'ID3' || b[3] === 255) break;
      p += 10 + syncsafe(b, 6) + (b[5] & 16 ? 10 : 0);
    }
    var q = mp3Sync(b, 0, b.length, null);
    if (q < 0) return null;
    var h = mp3Header(b, q);
    return { header: h, info: mp3Info(b, q, h), offset: p + q };
  }

  // ---------- WAV files ----------
  // Reading. mediabunny trusts the sizes in a WAV header. A recorder that
  // never finished its file (sizes 0 or 0xFFFFFFFF), an editor that wrote
  // more than 4 GB without RF64 (sizes that wrapped round) or a size that is
  // simply too small would read short or not at all. wavParse() finds where
  // the sound really ends; such a file is then read through an RF64 header
  // built here, in front of the file's own bytes (wavSource below).
  var WAV_NAMES = { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', 0x55: 'MP3', 2: 'Microsoft ADPCM', 0x11: 'IMA ADPCM',
    0x31: 'GSM 6.10', 0x32: 'GSM', 0x22: 'TrueSpeech', 0x40: 'G.721 ADPCM', 0x45: 'G.726 ADPCM', 0x64: 'G.726 ADPCM',
    0x65: 'G.722 ADPCM', 0x50: 'MPEG Layer II', 0x92: 'AC-3', 0xFF: 'AAC', 0x160: 'WMA', 0x161: 'WMA', 0x162: 'WMA Pro',
    0x163: 'WMA Lossless', 0x1610: 'AAC', 0x2000: 'AC-3', 0x2001: 'DTS' };
  var WAV_READS = { 1: true, 3: true, 6: true, 7: true, 0x55: true };
  // Chunks that editors and recorders put after the sound, and their first letters.
  var WAV_CHUNKS = /^(LIST|list|id3 |ID3 |bext|cue |smpl|inst|iXML|axml|_PMX|JUNK|junk|PAD |FLLR|fact|PEAK|plst|labl|note|ltxt|DISP|umid|cart|acid|strc|afsp|ResU|MD5 |SyLp|chna|dbmd|levl|link|regn|bxml|sxml)$/;
  var CHUNK_FIRST = new Uint8Array(256);
  'LliIbcsJjPFfa_DuRMSn'.split('').forEach(function (c) { CHUNK_FIRST[c.charCodeAt(0)] = 1; });
  function set32le(b, p, v) { b[p] = v & 255; b[p + 1] = v >>> 8 & 255; b[p + 2] = v >>> 16 & 255; b[p + 3] = v >>> 24 & 255; }
  function set64le(b, p, v) { set32le(b, p, v % 4294967296); set32le(b, p + 4, Math.floor(v / 4294967296)); }
  async function readBytes(file, p, n) { return new Uint8Array(await file.slice(p, Math.min(file.size, p + n)).arrayBuffer()); }
  function wavFmt(b) {
    var f = { tag: u16le(b, 0), channels: u16le(b, 2), sampleRate: u32le(b, 4), byteRate: u32le(b, 8), blockAlign: u16le(b, 12),
      bits: b.length >= 16 ? u16le(b, 14) : 8, extensible: false, validBits: 0, channelMask: 0 };
    f.codec = f.tag;
    if (f.tag === 0xFFFE && b.length >= 26) { f.extensible = true; f.validBits = u16le(b, 18); f.channelMask = u32le(b, 20); f.codec = u16le(b, 24); }
    f.name = WAV_NAMES[f.codec] || 'format 0x' + ('000' + f.codec.toString(16).toUpperCase()).slice(-4);
    return f;
  }
  // A chunk at p that a writer may have put after the sound: a known id and
  // a size that stays inside the file.
  async function chunkAt(file, p) {
    if (p + 8 > file.size) return false;
    var h = await readBytes(file, p, 8);
    return WAV_CHUNKS.test(ascii(h, 0, 4)) && p + 8 + u32le(h, 4) <= file.size + 1;
  }
  // Where the chunks start that run on to the end of the file, found in its
  // last 8 MB after `from`; the file's size when there are none.
  async function chunksAtEnd(file, from) {
    var size = file.size, at = Math.max(from, size - (8 << 20)), b = await readBytes(file, at, size - at), best = size;
    for (var i = b.length - 8; i >= 0; i--) {
      if (!CHUNK_FIRST[b[i]] || !WAV_CHUNKS.test(ascii(b, i, 4))) continue;
      for (var q = i; q + 8 <= b.length && WAV_CHUNKS.test(ascii(b, q, 4));) {
        var n = u32le(b, q + 4);
        q += 8 + n + (n & 1);
        if (q === b.length || q === b.length + 1) { best = at + i; break; }
      }
    }
    return best;
  }
  // The layout of a WAV or RF64 file: { rf64, riffSize, fmt (see wavFmt), ds64,
  // chunks: [{ id, pos, size }] before the sound, dataPos, dataStart,
  // declared (bytes of sound the header states), dataEnd (where the sound
  // really ends, in whole blocks), tail (where the chunks after the sound
  // start; the file's size when there are none), repaired: '' when the
  // header is right, else why not: 'zero', 'unknown' (0xFFFFFFFF), 'short'
  // (no chunk follows the stated end), 'past-end' or 'riff' }; null for a
  // file that is not RIFF or RF64 WAVE.
  async function wavParse(file) {
    var size = file.size, head = await readBytes(file, 0, 65536), riff = ascii(head, 0, 4);
    if ((riff !== 'RIFF' && riff !== 'RF64') || ascii(head, 8, 4) !== 'WAVE') return null;
    var w = { rf64: riff === 'RF64', riffSize: u32le(head, 4), fmt: null, ds64: null, chunks: [], dataPos: -1, dataStart: -1,
      declared: 0, dataEnd: 0, tail: size, repaired: '' };
    for (var pos = 12, guard = 0; pos + 8 <= size && guard < 4096; guard++) {
      var hb = pos + 8 <= head.length ? head.subarray(pos, pos + 8) : await readBytes(file, pos, 8), id = ascii(hb, 0, 4), n = u32le(hb, 4);
      if (!/^[\x20-\x7e]{4}$/.test(id)) break;
      if (id === 'data') { w.dataPos = pos; w.dataStart = pos + 8; w.declared = n; break; }
      if (id === 'fmt ' || id === 'ds64') {
        var body = pos + 8 + n <= head.length ? head.subarray(pos + 8, pos + 8 + n) : await readBytes(file, pos + 8, Math.min(n, 4096));
        if (id === 'fmt ' && body.length >= 14) w.fmt = wavFmt(body);
        if (id === 'ds64' && body.length >= 16) w.ds64 = { riffSize: u64le(body, 0), dataSize: u64le(body, 8) };
      }
      w.chunks.push({ id: id, pos: pos, size: n });
      pos += 8 + n + (n & 1);
    }
    if (!w.fmt || w.dataStart < 0) return w;
    if (w.rf64 && w.ds64 && w.declared === 0xFFFFFFFF) w.declared = w.ds64.dataSize;
    var end = w.dataStart + w.declared, pad = w.declared & 1, wrong = '';
    if (!w.rf64 && (w.declared === 0 || w.declared === 0xFFFFFFFF) && end !== size) wrong = w.declared ? 'unknown' : 'zero';
    else if (end > size) wrong = 'past-end';
    else if (end + pad < size && !(await chunkAt(file, end + pad)) && !(pad && await chunkAt(file, end))) wrong = 'short';
    else if (!w.rf64 && w.riffSize + 8 < end) wrong = 'riff';
    w.repaired = wrong;
    w.tail = wrong ? await chunksAtEnd(file, w.dataStart) : Math.min(size, end + pad);
    // Whole blocks of samples; MP3 frames are kept to the byte.
    var real = Math.min(wrong ? w.tail : end, size) - w.dataStart, block = WAV_READS[w.fmt.codec] && w.fmt.codec !== 0x55 && w.fmt.blockAlign || 1;
    w.dataEnd = w.dataStart + Math.max(0, Math.floor(real / block) * block);
    return w;
  }
  // A WAV made of a header built here and the file's own bytes: its chunks
  // before the sound, then those after it (so that mediabunny reads their
  // tags before it reaches the sound), then the sound to its real end. RIFF
  // when the sizes fit in 32 bits, else RF64 (w.big is then set).
  function wavWrapped(file, w) {
    var parts = [], body = 4 + 8, len = w.dataEnd - w.dataStart, i, c, e;
    for (i = 0; i < w.chunks.length; i++) {
      c = w.chunks[i];
      if (/^(ds64|JUNK|junk)$/.test(c.id)) continue;
      e = Math.min(file.size, c.pos + 8 + c.size + (c.size & 1));
      parts.push(file.slice(c.pos, e));
      body += e - c.pos;
    }
    if (w.tail < file.size) {
      parts.push(file.slice(w.tail));
      body += file.size - w.tail;
      if ((file.size - w.tail) & 1) { parts.push(new Uint8Array(1)); body++; }
    }
    body += len + (len & 1);
    var big = w.big = body > 0xFFFFFFFF, h = new Uint8Array(big ? 48 : 12), d = new Uint8Array(8), pcm = w.fmt.codec === 1 || w.fmt.codec === 3;
    putAscii(h, 0, big ? 'RF64' : 'RIFF'); set32le(h, 4, big ? 0xFFFFFFFF : body); putAscii(h, 8, 'WAVE');
    if (big) {
      putAscii(h, 12, 'ds64'); set32le(h, 16, 28);
      set64le(h, 20, body + 36); set64le(h, 28, len); set64le(h, 36, pcm && w.fmt.blockAlign ? len / w.fmt.blockAlign : 0);
    }
    putAscii(d, 0, 'data'); set32le(d, 4, big ? 0xFFFFFFFF : len);
    return new Blob([h].concat(parts, [d, file.slice(w.dataStart, w.dataEnd)], len & 1 ? [new Uint8Array(1)] : []));
  }
  // A WAV with no sound and the tag chunks of w's file, for reading the tags
  // of a WAV whose sound is MP3.
  function wavTagBlob(file, w) {
    var parts = [], fmt = new Uint8Array(24), d = new Uint8Array(8), n = 4 + 24 + 8, h = new Uint8Array(12);
    w.chunks.forEach(function (c) {
      if (!/^(LIST|id3 |ID3 )$/.test(c.id)) return;
      var e = Math.min(file.size, c.pos + 8 + c.size + (c.size & 1));
      parts.push(file.slice(c.pos, e)); n += e - c.pos;
    });
    if (w.tail < file.size) { parts.push(file.slice(w.tail)); n += file.size - w.tail; if ((file.size - w.tail) & 1) { parts.push(new Uint8Array(1)); n++; } }
    putAscii(fmt, 0, 'fmt '); set32le(fmt, 4, 16); fmt[8] = 1; fmt[10] = 1; set32le(fmt, 12, 8000); set32le(fmt, 16, 16000); fmt[20] = 2; fmt[22] = 16;
    putAscii(d, 0, 'data');
    putAscii(h, 0, 'RIFF'); set32le(h, 4, n); putAscii(h, 8, 'WAVE');
    return new Blob([h, fmt].concat(parts, [d]));
  }
  // The frames of a WAV file whose sound is MP3 (format 0x55), as an .mp3
  // file: unchanged, with the WAV's tags as ID3v2.3 and ID3v1 when given.
  function wavMp3(media, tags) {
    if (!media || !media.wav || !media.wav.mp3) return null;
    var parts = [], head = tags ? id3v23(tags) : new Uint8Array(0), tail = tags ? id3v1(tags) : null;
    if (head.length) parts.push(head);
    parts.push(media.file.slice(media.wav.dataStart, media.wav.dataEnd));
    if (tail) parts.push(tail);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  // Writing: 16-bit or 24-bit PCM, 32-bit float, µ-law or A-law; RF64 (with
  // a ds64 chunk) when the file passes 4 GB; the tags as a LIST INFO chunk
  // in UTF-8 before the sound and an ID3v2.3 'id3 ' chunk (with the
  // pictures) after it.
  var WAV_OUT = { s16: { tag: 1, bits: 16 }, s24: { tag: 1, bits: 24 }, f32: { tag: 3, bits: 32 }, ulaw: { tag: 7, bits: 8 }, alaw: { tag: 6, bits: 8 } };
  var ULAW_END = [0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF], ALAW_END = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];
  function g711Segment(v, ends) { for (var i = 0; i < 8; i++) if (v <= ends[i]) return i; return 8; }
  // ITU-T G.711 from 16-bit samples, as the reference code (and ffmpeg) does it.
  function linearToUlaw(x) {
    var mask = 0xFF, v = x >> 2;
    if (v < 0) { v = -v; mask = 0x7F; }
    if (v > 8159) v = 8159;
    v += 0x84 >> 2;
    var seg = g711Segment(v, ULAW_END);
    return (seg >= 8 ? 0x7F : seg << 4 | v >> seg + 1 & 15) ^ mask;
  }
  function linearToAlaw(x) {
    var mask = 0xD5, v = x >> 3;
    if (v < 0) { mask = 0x55; v = -v - 1; }
    var seg = g711Segment(v, ALAW_END);
    return (seg >= 8 ? 0x7F : seg << 4 | (seg < 2 ? v >> 1 : v >> seg) & 15) ^ mask;
  }
  var G711 = {};
  function g711Table(law) {
    if (!G711[law]) {
      var t = new Uint8Array(65536);
      for (var i = 0; i < 65536; i++) t[i] = law === 7 ? linearToUlaw(i - 32768) : linearToAlaw(i - 32768);
      G711[law] = t;
    }
    return G711[law];
  }
  function wavInfoChunk(tags) {
    var items = [['INAM', tags.title], ['IART', tags.artist], ['IPRD', tags.album], ['IMUS', tags.composer], ['IGNR', tags.genre],
      ['ICRD', dateText(tags.date)], ['ITRK', whole(tags.track) ? String(whole(tags.track)) : ''], ['ICMT', tags.comment]];
    var parts = [], n = 4, enc = new TextEncoder();
    items.forEach(function (it) {
      var s = String(it[1] == null ? '' : it[1]);
      if (!s) return;
      var t = enc.encode(s), len = t.length + 1, c = new Uint8Array(8 + len + (len & 1));
      putAscii(c, 0, it[0]); set32le(c, 4, len); c.set(t, 8);
      parts.push(c); n += c.length;
    });
    if (n === 4) return null;
    var head = new Uint8Array(12);
    putAscii(head, 0, 'LIST'); set32le(head, 4, n); putAscii(head, 8, 'INFO');
    return concatBytes([head].concat(parts));
  }
  // The header of a WAV: f = { tag, channels, sampleRate, bits, frames,
  // data (bytes of sound), info (a LIST chunk or null), after (bytes after
  // the sound), rf64 (true to write RF64 even under 4 GB), junk (true to
  // keep the 36 bytes a ds64 chunk takes in a RIFF file too, as a 'JUNK'
  // chunk, so that the header is as long whichever it turns out to be) }.
  function wavHeader(f) {
    var pcm = f.tag === 1, fmtLen = pcm ? 16 : 18, fact = pcm ? 0 : 12, info = f.info ? f.info.length : 0, block = f.channels * f.bits / 8;
    var body = 4 + 8 + fmtLen + fact + info + 8 + f.data + (f.after || 0), big = !!f.rf64 || body + (f.junk ? 36 : 0) > 0xFFFFFFFF, ds = big || f.junk ? 36 : 0;
    var h = new Uint8Array(12 + ds + 8 + fmtLen + fact + info + 8), p = 12;
    putAscii(h, 0, big ? 'RF64' : 'RIFF'); set32le(h, 4, big ? 0xFFFFFFFF : body + ds); putAscii(h, 8, 'WAVE');
    if (big) { putAscii(h, 12, 'ds64'); set32le(h, 16, 28); set64le(h, 20, body + ds); set64le(h, 28, f.data); set64le(h, 36, f.frames); p = 48; }
    else if (ds) { putAscii(h, 12, 'JUNK'); set32le(h, 16, 28); p = 48; }
    putAscii(h, p, 'fmt '); set32le(h, p + 4, fmtLen);
    h[p + 8] = f.tag; h[p + 10] = f.channels; set32le(h, p + 12, f.sampleRate); set32le(h, p + 16, f.sampleRate * block);
    h[p + 20] = block & 255; h[p + 21] = block >> 8; h[p + 22] = f.bits;
    p += 8 + fmtLen;
    if (fact) { putAscii(h, p, 'fact'); set32le(h, p + 4, 4); set32le(h, p + 8, Math.min(f.frames, 0xFFFFFFFF)); p += 12; }
    if (info) { h.set(f.info, p); p += info; }
    putAscii(h, p, 'data'); set32le(h, p + 4, big ? 0xFFFFFFFF : f.data);
    return h;
  }
  // A WAV built a block at a time: o = { sampleRate, channels, sampleFormat
  // ('s16' (default), 's24', 'f32', 'ulaw', 'alaw'), rf64, writable, tags,
  // room }. add(planes, n) takes n samples of each channel (Float32Arrays,
  // full scale ±1; integer formats are rounded and clipped there, float is
  // kept as it is); finish(tags) gives the Blob, with the tags (or none for
  // null). With o.writable (a WritableStream that takes { type: 'write',
  // position, data }, as a FileSystemWritableFileStream does) nothing is
  // kept: each megabyte of sound is written as it fills, after room for the
  // header, and finish() writes the header and the tags (o.tags, known from
  // the start, as the header's length depends on them), closes the stream
  // and resolves the bytes written. wait() is then a promise while the
  // stream has a megabyte to write already (else null), and abort()
  // discards the file. The file is the Blob that finish() gives without
  // o.writable, byte for byte, unless o.room asks for the room RF64 needs
  // past 4 GB: a file that stays under 4 GB then keeps it as a 'JUNK'
  // chunk (wavHeader's junk), as EBU Tech 3306 recommends.
  function wavWriter(o) {
    var spec = WAV_OUT[o.sampleFormat] || WAV_OUT.s16, ch = Math.max(1, o.channels | 0), bytes = spec.bits / 8, block = ch * bytes;
    var size = Math.floor((1 << 20) / block) * block, parts = [], buf, u8, i16, f32, at = 0, frames = 0, law = bytes === 1 ? g711Table(spec.tag) : null;
    var fw = o.writable ? o.writable.getWriter() : null, info = fw && o.tags ? wavInfoChunk(o.tags) : null, head = 0, written = 0, failed = null, closed = false;
    function layout(data, after) {
      return wavHeader({ tag: spec.tag, channels: ch, sampleRate: o.sampleRate, bits: spec.bits, frames: frames, data: data, info: info, after: after, rf64: o.rf64, junk: !!o.room });
    }
    if (fw) head = layout(0, 0).length;
    function fresh() { buf = new ArrayBuffer(size); u8 = new Uint8Array(buf); i16 = bytes === 2 ? new Int16Array(buf) : null; f32 = bytes === 4 ? new Float32Array(buf) : null; at = 0; }
    fresh();
    // A full megabyte (or the last part): kept, or written behind the header.
    function put(chunk) {
      if (!fw) { parts.push(chunk); return; }
      var p = head + written;
      written += chunk.length;
      fw.write({ type: 'write', position: p, data: chunk }).catch(function (e) { if (!failed) failed = e; });
    }
    function wait() {
      if (!fw) return null;
      if (failed) return Promise.reject(failed);
      return fw.desiredSize > 0 ? null : fw.ready.then(function () { if (failed) throw failed; });
    }
    function add(planes, n) {
      for (var i = 0; i < n;) {
        var m = Math.min(n - i, (size - at) / block), c, j, k, x, pl;
        for (c = 0; c < ch; c++) {
          pl = planes[c];
          if (bytes === 2) {
            for (j = 0, k = at / 2 + c; j < m; j++, k += ch) { x = Math.round(pl[i + j] * 32768); i16[k] = x > 32767 ? 32767 : x < -32768 ? -32768 : x; }
          } else if (bytes === 3) {
            for (j = 0, k = at + 3 * c; j < m; j++, k += block) {
              x = Math.round(pl[i + j] * 8388608); x = x > 8388607 ? 8388607 : x < -8388608 ? -8388608 : x;
              u8[k] = x & 255; u8[k + 1] = x >> 8 & 255; u8[k + 2] = x >> 16 & 255;
            }
          } else if (bytes === 4) {
            for (j = 0, k = at / 4 + c; j < m; j++, k += ch) f32[k] = pl[i + j];
          } else {
            for (j = 0, k = at + c; j < m; j++, k += ch) { x = Math.round(pl[i + j] * 32768); u8[k] = law[(x > 32767 ? 32767 : x < -32768 ? -32768 : x) + 32768]; }
          }
        }
        at += m * block; i += m; frames += m;
        if (at === size) { put(u8); fresh(); }
      }
    }
    // Frames sf to sf + n of an AudioSample as they are, when its channels
    // are the WAV's and nothing changes them (16-bit only: mediabunny rounds
    // to 16 bits as add() does).
    function addSample(s, sf, n) {
      for (var i = 0; i < n;) {
        var m = Math.min(n - i, (size - at) / block);
        s.copyTo(new Int16Array(buf, at, m * ch), { planeIndex: 0, format: 's16', frameOffset: sf + i, frameCount: m });
        at += m * block; i += m; frames += m;
        if (at === size) { put(u8); fresh(); }
      }
    }
    function finish(tags) {
      if (at) put(u8.subarray(0, at));
      if (fw) tags = o.tags || null;
      else info = tags ? wavInfoChunk(tags) : null;
      var data = frames * block, id3 = tags ? id3v23(tags) : new Uint8Array(0), tail = [], after = 0;
      if (data & 1) { tail.push(new Uint8Array(1)); after++; }
      if (id3.length) {
        var hd = new Uint8Array(8);
        putAscii(hd, 0, 'id3 '); set32le(hd, 4, id3.length);
        tail.push(hd, id3); after += 8 + id3.length;
        if (id3.length & 1) { tail.push(new Uint8Array(1)); after++; }
      }
      var top = layout(data, after);
      if (!fw) return new Blob([top].concat(parts, tail), { type: 'audio/wav' });
      return (async function () {
        if (failed) throw failed;
        if (top.length !== head) throw new Error('The WAV passed 4 GB, and its header has no room for the RF64 sizes it then needs.');
        await fw.write({ type: 'write', position: 0, data: top });
        if (after) await fw.write({ type: 'write', position: head + data, data: concatBytes(tail) });
        closed = true;
        await fw.close();
        return head + data + after;
      })();
    }
    function abort() { if (fw && !closed) { closed = true; return fw.abort().catch(function () {}); } }
    return { add: add, addSample: bytes === 2 ? addSample : null, finish: finish, wait: wait, abort: abort, frames: function () { return frames; }, bytesPerFrame: block };
  }

  // ---------- Resampling ----------
  // A windowed-sinc low-pass filter (Kaiser window), polyphase for rational
  // ratios such as 147:160. The passband is flat (within 0.001 dB) to 20 kHz,
  // or to 0.907 of the lower Nyquist frequency below 44.1 kHz; a tone above
  // the new Nyquist frequency folds back at least 96 dB down. It keeps its
  // state between blocks, so sound resampled a block at a time is the same
  // as resampled at once, and n samples give exactly round(n * out / in).
  // Ratios with more than 1024 phases (odd rates) interpolate between 512
  // phases of the filter. mediabunny's own resampler interpolates linearly,
  // which lets tones above the new Nyquist frequency fold back loudly and
  // dulls the top octave, so the engine never asks it to change a rate.
  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }
  function besselI0(x) {
    var s = 1, t = 1, h = x / 2;
    for (var k = 1; k < 500; k++) { t *= (h / k) * (h / k); s += t; if (t < 1e-17 * s) break; }
    return s;
  }
  // The filters' inner loops: y[o] (and z[o] for a second channel) from the
  // K inputs starting at x[s0], with phase P's coefficients; the window moves
  // on by dI inputs and dP phases per output.
  function firPoly(y, z, n, x, w, s0, tab, K, P, L, dP, dI) {
    for (var o = 0; o < n; o++) {
      var t = P * K, a0 = 0, a1 = 0, b0 = 0, b1 = 0, k = 0, c;
      if (w) {
        for (; k + 1 < K; k += 2) {
          c = tab[t + k]; a0 += x[s0 + k] * c; b0 += w[s0 + k] * c;
          c = tab[t + k + 1]; a1 += x[s0 + k + 1] * c; b1 += w[s0 + k + 1] * c;
        }
        for (; k < K; k++) { c = tab[t + k]; a0 += x[s0 + k] * c; b0 += w[s0 + k] * c; }
        z[o] = b0 + b1;
      } else {
        for (; k + 1 < K; k += 2) { a0 += x[s0 + k] * tab[t + k]; a1 += x[s0 + k + 1] * tab[t + k + 1]; }
        for (; k < K; k++) a0 += x[s0 + k] * tab[t + k];
      }
      y[o] = a0 + a1;
      P += dP; s0 += dI;
      if (P >= L) { P -= L; s0++; }
    }
  }
  // One phase (a whole-number ratio such as 2:1): the filter is symmetric
  // about its tap h, so each pair of taps takes one multiplication.
  function firFold(y, z, n, x, w, s0, tab, h, dI) {
    var c0 = tab[h];
    for (var o = 0; o < n; o++, s0 += dI) {
      var e = s0 + 2 * h, a = c0 * x[s0 + h], b = w ? c0 * w[s0 + h] : 0, k, c;
      if (w) { for (k = 0; k < h; k++) { c = tab[k]; a += c * (x[s0 + k] + x[e - k]); b += c * (w[s0 + k] + w[e - k]); } z[o] = b; }
      else for (k = 0; k < h; k++) a += tab[k] * (x[s0 + k] + x[e - k]);
      y[o] = a;
    }
  }
  // Odd ratios: the phase lies between two of R tabulated ones.
  function firLerp(y, n, x, s0, tab, K, R, P, L, dP, dI) {
    for (var o = 0; o < n; o++) {
      var f = P / L * R, q = Math.floor(f), u = f - q, t0 = q * K, t1 = t0 + K, a = 0, b = 0;
      for (var k = 0; k < K; k++) { a += x[s0 + k] * tab[t0 + k]; b += x[s0 + k] * tab[t1 + k]; }
      y[o] = a + u * (b - a);
      P += dP; s0 += dI;
      if (P >= L) { P -= L; s0++; }
    }
  }
  function resampler(inRate, outRate, channels) {
    inRate = Math.round(inRate); outRate = Math.round(outRate); channels = Math.max(1, channels | 0);
    var g = gcd(inRate, outRate), L = outRate / g, M = inRate / g, R = L > 1024 ? 512 : 0, phases = R ? R + 1 : L;
    var edge = Math.min(inRate, outRate) / 2, pass = Math.min(20000, edge * 0.9071), A = 96, beta = 0.1102 * (A - 8.7);
    var W = (A - 7.95) / (28.714 * (edge - pass)) * inRate, Wc = Math.ceil(W), K = 2 * Wc, x0 = (pass + edge) / inRate, I0b = besselI0(beta);
    var tab = new Float64Array(phases * K), p, k, sum;
    for (p = 0; p < phases; p++) {
      for (sum = 0, k = 0; k < K; k++) {
        var u = p / (R || L) + Wc - 1 - k, v = 0;
        if (Math.abs(u) < W) {
          var a = Math.PI * x0 * u, r = u / W;
          v = x0 * (a ? Math.sin(a) / a : 1) * besselI0(beta * Math.sqrt(1 - r * r)) / I0b;
        }
        sum += (tab[p * K + k] = v);
      }
      for (k = 0; k < K; k++) tab[p * K + k] /= sum;   // each phase passes DC exactly
    }
    var dI = Math.floor(M / L), dP = M % L, bufs = [], cap = 0, start = -(Wc - 1), len = Wc - 1, inN = 0, j = 0, ph = 0, ip = 0;
    function room(n) {
      if (len + n <= cap) return;
      cap = Math.max(2 * cap, len + n + 8192);
      for (var c = 0; c < channels; c++) { var nb = new Float64Array(cap); if (bufs[c]) nb.set(bufs[c].subarray(0, len)); bufs[c] = nb; }
    }
    room(0);
    function append(planes, n) {
      room(n);
      for (var c = 0; c < channels; c++) { var b = bufs[c], s = planes[c]; if (s) for (var i = 0; i < n; i++) b[len + i] = s[i]; else b.fill(0, len, len + n); }
      len += n;
    }
    // Every output whose window is in hand (its first input at most `last`), up to `most` in all.
    function run(last, most) {
      var n = 0, P = ph, I = ip, c, out = [];
      while (I <= last && j + n < most) { n++; P += dP; I += dI; if (P >= L) { P -= L; I++; } }
      var s0 = ip - Wc + 1 - start;
      for (c = 0; c < channels; c++) out.push(new Float32Array(n));
      for (c = 0; c < channels; c += R ? 1 : 2) {
        var two = !R && c + 1 < channels;
        if (R) firLerp(out[c], n, bufs[c], s0, tab, K, R, ph, L, dP, dI);
        else if (L === 1) firFold(out[c], two ? out[c + 1] : null, n, bufs[c], two ? bufs[c + 1] : null, s0, tab, Wc - 1, dI);
        else firPoly(out[c], two ? out[c + 1] : null, n, bufs[c], two ? bufs[c + 1] : null, s0, tab, K, ph, L, dP, dI);
      }
      j += n; ph = P; ip = I;
      var drop = ip - Wc + 1 - start;
      if (drop > 0) { for (c = 0; c < channels; c++) bufs[c].copyWithin(0, drop, len); start += drop; len -= drop; }
      return out;
    }
    return {
      inRate: inRate, outRate: outRate, channels: channels, taps: K,
      // n samples of each channel in (Float32Arrays); out what is ready.
      process: function (planes, n) { append(planes, n); inN += n; return run(inN - 1 - Wc, Infinity); },
      // The rest, once all the input is in.
      flush: function () { append([], 2 * Wc + 2); return run(Infinity, Math.round(inN * L / M)); }
    };
  }
  // A whole sound at once: planes (one Float32Array per channel) at inRate to outRate.
  function resample(planes, inRate, outRate) {
    var r = resampler(inRate, outRate, planes.length), a = r.process(planes, planes[0].length), b = r.flush();
    return a.map(function (x, c) { var y = new Float32Array(x.length + b[c].length); y.set(x); y.set(b[c], x.length); return y; });
  }

  // ---------- Apple Lossless (ALAC) ----------
  // mediabunny 1.65.2 lists an ALAC track (internal codec 'alac') with no
  // codec and no decoder, and only Safari decodes ALAC itself. The engine
  // reads the file's ALAC settings (the 'alac' box in its sample entry: bit
  // depth, channels and the true sample rate, which the sample entry's own
  // 16-bit field cannot hold above 65,535 Hz) and decodes the sound with
  // @mgz-dev/alac (assets/vendor/alac/) in a module worker
  // (assets/js/alac-worker.js). The worker holds the whole file; mediabunny
  // reads the decoded sound as the PCM of a WAV file (16 or 24-bit, as
  // the ALAC is) through a CustomSource, which asks the worker only for
  // the samples it reads, so a waveform, a preview and a conversion all
  // work a piece at a time. The library decodes 16 and 24-bit sound in mono
  // or stereo; it gives silence for other bit depths and wrong sound for
  // more channels, so those are refused from the settings.
  async function alacInfo(m, info) {
    info.codec = 'alac';
    var c = null;
    try { c = await alacCookie(m.audio || m.file, info.track.id); } catch (e) { c = null; }
    if (!c) { info.alac = { bits: 0, frameLength: 0 }; info.unsupported = TEXT.alacHeader; return; }
    info.alac = { bits: c.bits, frameLength: c.frameLength };
    if (c.sampleRate > 0) info.sr = c.sampleRate;
    if (c.channels > 0) info.ch = c.channels;
    var size = (m.audio || m.file).size, pcm = Math.max(0, info.end - Math.max(0, info.first || 0)) * info.sr * info.ch * c.bits / 8;
    if (!c.first) info.unsupported = TEXT.alacSecond;
    else if (c.bits !== 16 && c.bits !== 24) info.unsupported = fill(TEXT.alacBits, { bits: c.bits });
    else if (c.channels !== 1 && c.channels !== 2) info.unsupported = fill(TEXT.alacChannels, { channels: c.channels });
    else if (size > LIMITS.alac) info.unsupported = fill(TEXT.alacBig, { size: fmtBytes(size), limit: fmtBytes(LIMITS.alac) });
    else if (pcm > 0xFFFFFFFF - 1024) info.unsupported = TEXT.alacLong;
  }
  // Boxes of an MP4 file between from and to: [type, start, header, size],
  // read from the file a box header at a time (up to 64 boxes on a level).
  async function mp4Boxes(file, from, to) {
    var out = [], p = from;
    while (p + 8 <= to && out.length < 64) {
      var h = await readBytes(file, p, 16), size = u32be(h, 0), head = 8;
      if (size === 1) { size = u32be(h, 8) * 4294967296 + u32be(h, 12); head = 16; } else if (size === 0) size = to - p;
      if (size < head || p + size > to) break;
      out.push([ascii(h, 4, 4), p, head, size]);
      p += size;
    }
    return out;
  }
  function boxesIn(b, from, to) {
    var out = [], p = from;
    while (p + 8 <= to && out.length < 4096) {
      var size = u32be(b, p), head = 8;
      if (size === 1 && p + 16 <= to) { size = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12); head = 16; } else if (size === 0) size = to - p;
      if (size < head || p + size > to) break;
      out.push([ascii(b, p + 4, 4), p, head, size]);
      p += size;
    }
    return out;
  }
  // The ALAC settings of the track with tkhd id `id`: { bits, channels,
  // sampleRate, frameLength, first (it is the file's first ALAC track, the
  // one the decoder opens) }, or null.
  async function alacCookie(file, id) {
    var top = await mp4Boxes(file, 0, file.size), moov = top.filter(function (x) { return x[0] === 'moov'; })[0];
    if (!moov || moov[3] > 64e6) return null;
    var b = await readBytes(file, moov[1], moov[3]), firstAlac = true;
    var traks = boxesIn(b, moov[2], b.length).filter(function (x) { return x[0] === 'trak'; });
    for (var i = 0; i < traks.length; i++) {
      var tk = traks[i], kids = boxesIn(b, tk[1] + tk[2], tk[1] + tk[3]), tkhd = kids.filter(function (x) { return x[0] === 'tkhd'; })[0];
      var tid = tkhd ? u32be(b, tkhd[1] + tkhd[2] + (b[tkhd[1] + tkhd[2]] === 1 ? 20 : 12)) : -1;
      var box = [tk[1], tk[2], tk[3]];
      ['mdia', 'minf', 'stbl', 'stsd'].forEach(function (name) {
        if (!box) return;
        var k = boxesIn(b, box[0] + box[1], box[0] + box[2]).filter(function (x) { return x[0] === name; })[0];
        box = k ? [k[1], k[2], k[3]] : null;
      });
      if (!box) continue;
      // stsd: version and flags, entry count, then the sample entries.
      var entries = boxesIn(b, box[0] + box[1] + 8, box[0] + box[2]).filter(function (x) { return x[0] === 'alac'; });
      if (!entries.length) continue;
      if (tid === id || id == null) {
        // The 'alac' box (36 bytes: header, version and flags, then the 24
        // bytes of ALACSpecificConfig) follows the AudioSampleEntry fields,
        // also inside a QuickTime 'wave' box.
        var e = entries[0], end = e[1] + e[3];
        for (var p = e[1] + e[2] + 28; p + 36 <= end; p++) {
          if (b[p + 4] !== 97 || b[p + 5] !== 108 || b[p + 6] !== 97 || b[p + 7] !== 99 || u32be(b, p) !== 36) continue;
          var c = p + 12;
          var r = { frameLength: u32be(b, c), bits: b[c + 5], channels: b[c + 9], sampleRate: u32be(b, c + 20), first: firstAlac };
          return r.bits > 0 && r.channels > 0 && r.sampleRate > 0 && r.sampleRate <= 768000 && r.frameLength > 0 ? r : null;
        }
        return null;
      }
      firstAlac = false;
    }
    return null;
  }

  // One worker per file being decoded, kept until release() or close(), or
  // until more files would be held than limits.alac allows (the least
  // recently used is closed first).
  var alacSlots = [], alacTick = 0;
  function alacError(text, extra) { return coded('ALAC_FAILED', text, extra); }
  function alacCall(slot, msg, transfer) {
    if (slot.dead) return Promise.reject(slot.dead);
    return new Promise(function (resolve, reject) {
      msg.id = ++slot.seq;
      slot.calls.set(msg.id, { resolve: resolve, reject: reject, open: msg.op === 'open' });
      slot.worker.postMessage(msg, transfer || []);
    });
  }
  function alacKill(slot, err) {
    if (!slot.dead) slot.dead = err || coded('CANCELLED', 'The Apple Lossless decoder was closed.');
    try { slot.worker.terminate(); } catch (x) { /* gone */ }
    slot.calls.forEach(function (c) { c.reject(slot.dead); });
    slot.calls.clear();
  }
  function alacClose(slot, err) {
    var i = alacSlots.indexOf(slot);
    if (i >= 0) alacSlots.splice(i, 1);
    alacKill(slot, err);
    slot.promise.then(function (src) { try { src.input.dispose(); } catch (x) { /* ignore */ } }, function () {});
  }
  function alacSource(m, t) {
    var slot = alacSlots.filter(function (x) { return x.m === m && x.t === t; })[0];
    if (slot) { slot.used = ++alacTick; return slot.promise; }
    var size = (m.audio || m.file).size, held = 0;
    alacSlots.forEach(function (x) { held += x.size; });
    // A decoder that is still answering reads stays open, even past the limit.
    alacSlots.slice().sort(function (a, b) { return a.used - b.used; }).forEach(function (x) {
      if (held + size > LIMITS.alac && !x.calls.size) { held -= x.size; alacClose(x, coded('ALAC_CLOSED', TEXT.alacClosed)); }
    });
    slot = { m: m, t: t, size: size, used: ++alacTick, seq: 0, calls: new Map(), dead: null, worker: null };
    alacSlots.push(slot);
    slot.promise = alacOpen(slot).catch(function (err) {
      var i = alacSlots.indexOf(slot);
      if (i >= 0) alacSlots.splice(i, 1);
      alacKill(slot, err);
      throw err;
    });
    return slot.promise;
  }
  async function alacOpen(slot) {
    var m = slot.m, t = slot.t, w;
    try { w = slot.worker = new Worker(ALAC_WORKER_URL, { type: 'module' }); } catch (e) { throw noDecode(t); }
    w.onmessage = function (ev) {
      var d = ev.data || {}, c = slot.calls.get(d.id);
      if (!c) return;
      slot.calls.delete(d.id);
      if (d.error != null) c.reject(alacError(d.op === 'open' || c.open ? TEXT.alacOpen : TEXT.alacDamaged, { cause: new Error(d.error) })); else c.resolve(d);
    };
    // The module or its WebAssembly could not start (an old browser).
    w.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); alacKill(slot, noDecode(t)); };
    var r = await alacCall(slot, { op: 'open', file: m.audio || m.file }), lib = r.info;
    if (!lib || lib.bits !== t.alac.bits || lib.channels !== t.ch || lib.sampleRate !== t.sr || !(lib.samples > 0)) throw alacError(TEXT.alacDamaged);
    var bpf = lib.bytesPerSample, sr = lib.sampleRate;
    // The heard sound starts at t0 on the track's time line, which starts
    // with the first sample the decoder gives (unless an edit list moves it).
    var skip = Math.max(0, Math.round((t.t0 - (t.first || 0)) * sr));
    var frames = Math.max(0, Math.min(lib.samples - skip, Math.round((t.end - t.t0) * sr)));
    var head = wavHeader({ tag: 1, channels: lib.channels, sampleRate: sr, bits: lib.bits, frames: frames, data: frames * bpf, info: null, after: 0 });
    var H = head.length, total = H + frames * bpf;
    if (total > 0xFFFFFFFF) throw alacError(TEXT.alacLong);
    var source = new MB.CustomSource({
      getSize: function () { return total; },
      read: function (start, end) {
        var out = new Uint8Array(end - start), p = start;
        if (p < H) { out.set(head.subarray(p, Math.min(end, H))); p = Math.min(end, H); }
        if (p >= end) return out;
        var d0 = p - H, d1 = end - H, f0 = Math.floor(d0 / bpf), f1 = Math.min(frames, Math.ceil(d1 / bpf));
        slot.used = ++alacTick;
        return alacCall(slot, { op: 'read', from: skip + f0, count: f1 - f0 }).then(function (res) {
          // Fewer samples than asked (the file ends early) stay silent.
          var bytes = res.bytes, from = d0 - f0 * bpf, n = Math.min(bytes.length - from, d1 - d0);
          if (n > 0) out.set(bytes.subarray(from, from + n), p - start);
          return out;
        });
      },
      prefetchProfile: 'fileSystem',
      handleUnhandledError: function () {}
    });
    var input = new MB.Input({ source: source, formats: [MB.WAVE] });
    var track = await input.getPrimaryAudioTrack();
    if (!track) throw alacError(TEXT.alacDamaged);
    return { input: input, track: track, base: 0 };
  }

  // ---------- The sound of a track ----------
  function noDecode(t) { return coded('NO_DECODE', t.unsupported || fill(TEXT.noDecode, { codec: codecName(t) }), { track: t }); }
  var whole1 = null;   // the one whole-track decode kept: { m, t, promise }
  function decodeSource(m, ti) {
    var t = m.tracks[ti];
    if (t.alac && t.decodable) return load().then(function () { return alacSource(m, t); });
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
  function release(m) {
    if (whole1 && whole1.m === m) releaseWhole();
    alacSlots.filter(function (x) { return x.m === m; }).forEach(alacClose);
  }
  // Browsers without a streaming decoder for the codec decode the whole
  // sound track with decodeAudioData. Only the audio is copied out first.
  async function buildWhole(m, t) {
    if (t.durMs / 1000 > LIMITS.whole) {
      throw coded('TOO_LONG', fill(TEXT.tooLong, { minutes: LIMITS.whole / 60 }), { limit: LIMITS.whole });
    }
    var data;
    if (t.mp3) {
      // An MP3 file as it is: decodeAudioData honours its LAME tag.
      data = await m.audio.arrayBuffer();
    } else {
      var format = t.codec === 'mp3' ? new MB.Mp3OutputFormat() : t.codec === 'flac' ? new MB.FlacOutputFormat()
        : (t.codec === 'opus' || t.codec === 'vorbis') ? new MB.WebMOutputFormat() : new MB.Mp4OutputFormat();
      var out = new MB.Output({ format: format, target: new MB.BufferTarget() });
      var conv = await MB.Conversion.init({
        input: m.input, output: out, showWarnings: false, video: { discard: true },
        audio: function (tr) { return tr === t.track ? {} : { discard: true }; }, copy: { mode: 'forced' }, tags: {}
      });
      if (!conv.isValid) throw noDecode(t);
      await conv.execute();
      data = out.target.buffer;
    }
    var ctx;
    try { ctx = new OfflineAudioContext(1, 1, t.sr); } catch (x) { ctx = new OfflineAudioContext(1, 1, 48000); }
    var ab = await new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(data, resolve, reject);
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
  function outChannels(t, mono, stereo) { return mono ? 1 : stereo ? 2 : Math.min(2, t.ch || 2); }
  // The WAV sample format when none is asked for: 24-bit Apple Lossless
  // keeps its 24 bits, everything else is written as 16-bit.
  function wavDefault(t) { return t.alac && t.alac.bits === 24 ? 's24' : 's16'; }
  function selOf(t, sel) {
    var s = sel && sel.start > 0 ? Math.min(sel.start, t.durMs) : 0;
    var e = sel && sel.end >= 0 && sel.end < t.durMs ? sel.end : t.durMs;
    return { start: s, end: Math.max(s, e) };
  }
  function estimate(m, ti, o) {
    var t = m.tracks[ti], sel = selOf(t, o.sel), sec = (sel.end - sel.start) / 1000;
    if (o.format === 'mp3') return Math.round(mp3Plan(t.sr, o.kbps).kbps * 125 * sec) + 300;
    if (o.format === 'wav') {
      var rate = o.sampleRate > 0 ? Math.round(o.sampleRate) : t.sr, spec = WAV_OUT[o.sampleFormat] || WAV_OUT[wavDefault(t)];
      return Math.round(sec * rate) * outChannels(t, o.mono, o.stereo) * spec.bits / 8 + 44;
    }
    return t.bitrate > 0 && t.codec === 'aac' ? Math.round(t.bitrate / 8 * sec) + 2000 : 0;
  }

  // Frames sf to sf + n of an AudioSample, as the result's ch channels
  // (Float32Arrays): mixed as mediabunny mixes channels (in 32-bit floats),
  // quad and 5.1 down to stereo or mono, stereo to mono as the average; of
  // other layouts the first channels; mono as two equal channels for stereo.
  function mixDown(s, sf, n, inCh, ch) {
    var need = inCh === 4 || inCh === 6 ? inCh : inCh === 2 ? 2 : Math.min(inCh, ch), P = [], out = [], c, i;
    for (c = 0; c < need; c++) {
      var x = new Float32Array(n);
      s.copyTo(x, { planeIndex: c, format: 'f32-planar', frameOffset: sf, frameCount: n });
      P.push(x);
    }
    if (inCh === 1 && ch === 2) return [P[0], P[0].slice()];
    if (inCh === ch || (inCh !== 2 && inCh !== 4 && inCh !== 6)) return P.slice(0, ch);
    for (c = 0; c < ch; c++) out.push(new Float32Array(n));
    var L = out[0], R = out[1], a = Math.SQRT1_2;
    if (inCh === 2) for (i = 0; i < n; i++) L[i] = 0.5 * (P[0][i] + P[1][i]);
    else if (inCh === 4 && ch === 2) for (i = 0; i < n; i++) { L[i] = 0.5 * (P[0][i] + P[2][i]); R[i] = 0.5 * (P[1][i] + P[3][i]); }
    else if (inCh === 4) for (i = 0; i < n; i++) L[i] = 0.25 * (P[0][i] + P[1][i] + P[2][i] + P[3][i]);
    else if (ch === 2) for (i = 0; i < n; i++) { L[i] = P[0][i] + a * (P[2][i] + P[4][i]); R[i] = P[1][i] + a * (P[2][i] + P[5][i]); }
    else for (i = 0; i < n; i++) L[i] = a * (P[0][i] + P[1][i]) + P[2][i] + 0.5 * (P[4][i] + P[5][i]);
    return out;
  }
  // Volume and fades on n frames starting t0 seconds into the selection.
  function shape(planes, n, t0, sr, vol, gain, fx, len) {
    var flat = t0 >= fx.fadeIn && t0 + n / sr <= len - fx.fadeOut, c, i;
    if (flat && vol === 1) return;
    for (c = 0; c < planes.length; c++) {
      var p = planes[c];
      if (flat) for (i = 0; i < n; i++) p[i] *= vol;
      else for (i = 0; i < n; i++) p[i] *= gain(t0 + i / sr);
    }
  }

  function convert(m, ti, o) {
    var job = { cancelled: false, conv: null, onCancel: null };
    job.cancel = function () {
      job.cancelled = true;
      var p = job.conv ? job.conv.cancel() : job.onCancel ? job.onCancel() : null;
      return Promise.resolve(p).catch(function () {});
    };
    job.promise = run(m, ti, o || {}, job).catch(async function (err) {
      // A file given to write into is never left open: discarded unwritten.
      var w = o && o.writable;
      if (w) await (job.stream ? job.stream.abort() : w.locked ? null : w.abort().catch(function () {}));
      if (err && err.code === 'CANCELLED') throw err;
      if (job.cancelled || isCancel(err)) throw coded('CANCELLED', 'Conversion cancelled.', { cause: err });
      throw err;
    });
    return job;
  }
  async function run(m, ti, o, job) {
    await load();
    var t = m.tracks[ti], fmt = o.format === 'wav' || o.format === 'copy' ? o.format : 'mp3';
    var sel = selOf(t, o.sel), len = (sel.end - sel.start) / 1000, tags = o.tags || null;
    if (t.drm) throw drmError(t.drm);
    if (fmt !== 'copy') return transcode(m, ti, o, job, fmt, sel, len, tags);
    // Original audio: the AAC packets copied into .m4a, cut at packets.
    if (t.codec !== 'aac') throw coded('NOT_AAC', fill(TEXT.notAac, { codec: codecName(t) }), { track: t });
    var trim = {};
    if (sel.start > 0) trim.start = t.t0 + sel.start / 1000;
    if (sel.end < t.durMs) trim.end = t.t0 + sel.end / 1000;
    var out = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
    var conv = await MB.Conversion.init({
      input: m.input, output: out, showWarnings: false, trim: trim, copy: { mode: 'forced' },
      video: { discard: true },
      audio: function (tr) { return tr === t.track ? {} : { discard: true }; },
      tags: function () { return tags ? mbTags(tags, 'm4a') : { creationTime: null }; }
    });
    if (!conv.isValid) {
      var d = conv.discardedTracks.filter(function (x) { return x.track === t.track; })[0];
      if (d && d.reason === 'cannot_copy') throw coded('CANNOT_COPY', TEXT.cannotCopy);
      throw noDecode(t);
    }
    if (o.onProgress) conv.onProgress = function (p) { o.onProgress(p); };
    job.conv = conv;
    try {
      if (job.cancelled) await conv.cancel();
      await conv.execute();
    } finally {
      job.conv = null;
    }
    if (job.cancelled) throw coded('CANCELLED', 'Conversion cancelled.');
    return { blob: new Blob([out.target.buffer], { type: 'audio/mp4' }), ext: 'm4a', mime: 'audio/mp4', channels: t.ch, sampleRate: t.sr };
  }
  // MP3 and WAV: the sound decoded a piece at a time from the start of the
  // selection to its end (cut to the sample as mediabunny's own conversion
  // cuts), mixed, shaped by the volume and fades, resampled where the rate
  // changes, and passed to the LAME encoder or the WAV writer. A gap in the
  // timestamps of 64 samples or more is filled with silence, as mediabunny
  // does. Every MP3 goes through finishMp3() with the number of samples
  // encoded, and every WAV through wavWriter().
  async function transcode(m, ti, o, job, fmt, sel, len, tags) {
    var t = m.tracks[ti], ch = outChannels(t, !!o.mono, !!o.stereo), plan = null, outRate, spec = null;
    var fx = { vol: o.volume == null ? 1 : Math.max(0, +o.volume || 0), fadeIn: Math.max(0, +o.fadeIn || 0), fadeOut: Math.max(0, +o.fadeOut || 0) };
    if (!t.decodable && !t.whole) throw noDecode(t);
    if (fmt === 'mp3') {
      plan = mp3Plan(t.sr, o.kbps);
      outRate = plan.sampleRate;
      if (!mp3Ok || !(await MB.canEncodeAudio('mp3', { numberOfChannels: ch, sampleRate: outRate, bitrate: plan.kbps * 1000 }))) {
        throw coded('NO_ENCODER', TEXT.noEncoder, { format: fmt });
      }
      // An MP3 not written into o.writable is built in memory.
      var mp3Bytes = o.writable ? 0 : estimate(m, ti, { format: 'mp3', kbps: o.kbps, sel: sel });
      if (mp3Bytes > LIMITS.mp3) {
        throw coded('TOO_BIG', fill(TEXT.tooBigMp3, { size: fmtBytes(mp3Bytes), limit: fmtBytes(LIMITS.mp3) }), { bytes: mp3Bytes, limit: LIMITS.mp3, format: 'mp3' });
      }
    } else {
      spec = WAV_OUT[o.sampleFormat] ? o.sampleFormat : wavDefault(t);
      outRate = o.sampleRate > 0 ? Math.round(o.sampleRate) : t.sr;
      var bytes = estimate(m, ti, { format: 'wav', sel: sel, mono: o.mono, stereo: o.stereo, sampleRate: outRate, sampleFormat: spec });
      // A WAV not written into o.writable is built in memory.
      if (!o.writable && bytes > LIMITS.wav) throw coded('TOO_BIG', fill(TEXT.tooBig, { size: fmtBytes(bytes), limit: fmtBytes(LIMITS.wav) }), { bytes: bytes, limit: LIMITS.wav, format: 'wav' });
    }
    var src = await decodeSource(m, ti);
    if (job.cancelled) throw coded('CANCELLED', 'Conversion cancelled.');
    var a = src.base + sel.start / 1000, b = sel.end < t.durMs ? src.base + sel.end / 1000 : t.decodable ? t.end : Infinity;
    var span = len > 0 ? len : 0.001, out = null, enc = null, wav = null, rs = null, inRate = 0, inCh = 0, vol = fx.vol, gain = null;
    var kept = 0, outN = 0, lastYield = performance.now(), stream = null;
    if (fmt === 'mp3') {
      // Into o.writable as it is made (mp3Stream), else into memory.
      if (o.writable) stream = job.stream = mp3Stream(o.writable, tags, outRate, ch, plan.kbps);
      out = stream ? new MB.Output({ format: new MB.Mp3OutputFormat({ xingHeader: false }), target: new MB.StreamTarget(stream.sink) })
        : new MB.Output({ format: new MB.Mp3OutputFormat(), target: new MB.BufferTarget() });
      enc = new MB.AudioSampleSource({ codec: 'mp3', quality: new MB.Quality({ bitrate: plan.kbps * 1000 }) });
      out.addAudioTrack(enc);
      await out.start();
      job.onCancel = function () { return out.cancel(); };
    } else {
      // Into o.writable as it is made, with room for RF64 sizes when it may
      // pass 4 GB, else into memory.
      wav = wavWriter({ sampleRate: outRate, channels: ch, sampleFormat: spec, rf64: o.rf64, writable: o.writable || null, tags: tags, room: !!o.writable && bytes >= 2e9 });
      if (o.writable) job.stream = wav;
    }
    // The encoder gets about a second at a time: each block is a round trip
    // to its worker, and small ones would leave it waiting.
    var block = fmt === 'mp3' ? outRate : 0, pend = null, pendN = 0, sent = 0;
    async function send() {
      if (!pendN) return;
      var d = pendN === block ? pend : pend.subarray(0, pendN * ch);
      if (pendN < block) { var e = new Float32Array(pendN * ch); for (var c = 0; c < ch; c++) e.set(pend.subarray(c * block, c * block + pendN), c * pendN); d = e; }
      var x = new MB.AudioSample({ data: d, format: 'f32-planar', numberOfChannels: ch, sampleRate: outRate, timestamp: sent / outRate });
      sent += pendN; pendN = 0; pend = null;
      try { await enc.add(x); } finally { x.close(); }
    }
    async function emit(planes, sample, sf) {
      var n = sample ? planes : planes.length ? planes[0].length : 0;
      if (!n) return;
      outN += n;
      if (wav) {
        if (sample) wav.addSample(sample, sf, n); else wav.add(planes, n);
        var busy = wav.wait();
        if (busy) await busy;
        return;
      }
      for (var i = 0; i < n;) {
        if (!pend) pend = new Float32Array(block * ch);
        var m = Math.min(n - i, block - pendN);
        for (var c = 0; c < ch; c++) {
          if (sample) sample.copyTo(pend.subarray(c * block + pendN, c * block + pendN + m), { planeIndex: c, format: 'f32-planar', frameOffset: sf + i, frameCount: m });
          else pend.set(planes[c].subarray(i, i + m), c * block + pendN);
        }
        pendN += m; i += m;
        if (pendN === block) await send();
      }
    }
    async function feed(planes, n) {
      kept += n;
      await emit(rs ? rs.process(planes, n) : planes);
    }
    try {
      for await (var s of new MB.AudioSampleSink(src.track).samples(a, b)) {
        try {
          if (job.cancelled) break;
          var sr = s.sampleRate, n = s.numberOfFrames, sf = 0, ef = n;
          if (s.timestamp < a) sf = Math.round((a - s.timestamp) * sr);
          if (s.timestamp + s.duration > b) ef = Math.round((b - s.timestamp) * sr);
          if (sf >= ef) continue;
          if (!inRate) {
            inRate = sr; inCh = s.numberOfChannels;
            vol = fx.vol * mixGain(inCh, ch === 1);
            gain = gainFn(vol, fx.fadeIn, fx.fadeOut, len);
            if (inRate !== outRate) rs = resampler(inRate, outRate, ch);
          } else if (sr !== inRate || s.numberOfChannels !== inCh) throw new Error('The sound changes its sample rate or channels partway through.');
          // Silence for a gap before this sample (any gap at the start).
          var gap = Math.round((s.timestamp + sf / sr - a) * sr) - kept;
          while (gap >= (kept ? 64 : 1)) {
            var z = Math.min(gap, sr), zs = [];
            for (var c = 0; c < ch; c++) zs.push(new Float32Array(z));
            await feed(zs, z);
            gap -= z;
          }
          // Sound that nothing changes goes on as it is decoded.
          var k0 = kept / inRate, m0 = ef - sf;
          if (inCh === ch && !rs && vol === 1 && k0 >= fx.fadeIn && k0 + m0 / inRate <= len - fx.fadeOut && (enc || wav.addSample)) {
            kept += m0;
            await emit(m0, s, sf);
          } else {
            var planes = mixDown(s, sf, m0, inCh, ch);
            shape(planes, m0, k0, inRate, vol, gain, fx, len);
            await feed(planes, m0);
          }
          if (o.onProgress) o.onProgress(Math.max(0, Math.min(1, (s.timestamp + s.duration - a) / span)));
          if (performance.now() - lastYield > 40) { await yieldNow(); lastYield = performance.now(); }
        } finally {
          s.close();
        }
      }
      if (job.cancelled) throw coded('CANCELLED', 'Conversion cancelled.');
      if (rs) await emit(rs.flush());
      if (enc) await send();
      var result = { ext: fmt, mime: fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav', channels: ch, sampleRate: outRate, samples: outN };
      if (wav) {
        result.sampleFormat = spec;
        if (o.writable) {
          result.size = await wav.finish(tags);
          result.blob = null;
          result.streamed = true;
        } else result.blob = wav.finish(tags);
      } else {
        enc.close();
        await out.finalize();
        result.kbps = plan.kbps;
        if (stream) {
          result.size = await stream.finish(outN);
          result.blob = null;
          result.streamed = true;
        } else result.blob = finishMp3(out.target.buffer, tags, { sampleRate: outRate, channels: ch, kbps: plan.kbps, samples: outN });
      }
      return result;
    } catch (err) {
      if (out) { try { await out.cancel(); } catch (x) { /* already stopped */ } }
      throw err;
    } finally {
      job.onCancel = null;
    }
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
    emptyTags: emptyTags, id3v23: id3v23, id3v1: id3v1, finishMp3: finishMp3, mbTags: mbTags,
    mp3Header: mp3Header, mp3Frames: mp3Frames, mp3Info: mp3Info, mp3Samples: mp3Samples, mp3LeadIn: mp3LeadIn, mp3Toc: mp3Toc,
    mp3InfoFrame: mp3InfoFrame, mp3Gapless: mp3Gapless, mp3Donor: mp3Donor, mp3Cut: mp3Cut, readMp3: readMp3, crc16: crc16,
    MP3_DECODER_DELAY: MP3_DECODER_DELAY,
    wavParse: wavParse, wavMp3: wavMp3, wavWriter: wavWriter, wavHeader: wavHeader,
    resampler: resampler, resample: resample,
    yieldNow: yieldNow
  };
})();
