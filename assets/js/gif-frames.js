/*
 * TTGif: reads GIF files frame by frame in the browser (window.TTGif). It uses the
 * browser's ImageDecoder where there is one, and otherwise decodes in a worker (this
 * same file) with omggif 1.0.10 (assets/vendor/omggif/omggif.js, MIT licence).
 *
 * Load it where it is needed:
 *   <script src="{{ '/assets/js/gif-frames.js' | relative_url }}"></script>
 *
 * Frames come out as browsers show them, and both ways give the same pixels: each frame
 * drawn over the ones before it (disposal 1 keeps it, 2 clears its area, 3 restores what was
 * there before it; 4 counts as 3 and 5 to 7 as 1, as in Chrome and Firefox), interlaced rows
 * in place, local palettes and the transparent colour applied, clipped to the canvas, and the
 * canvas grown to a first frame that is larger than the logical screen. Delays of 0 or 1
 * hundredth of a second play as 100 ms, as in every browser. The background colour that the
 * file names is ignored, as browsers do: cleared areas are transparent.
 *
 * API
 *   TTGif.scan(source) -> Promise<info>
 *     Reads the file's blocks without decoding any pixels (a few ms per MB). A Blob is read
 *     in 8 MiB slices, so even a file of several GB needs little memory.
 *     source: Blob (a File), ArrayBuffer or Uint8Array.
 *     info: {
 *       size            bytes in the file
 *       version         '87a' or '89a'
 *       width, height   the canvas, as browsers show it
 *       screenWidth, screenHeight   the logical screen size the file states
 *       frameCount      whole frames (in a cut-off file, the frames before the cut)
 *       frames          [{ x, y, width, height, delay (hundredths, as stored), duration (ms, as
 *                        played), disposal (0-7, as stored), transparent (palette index, or -1),
 *                        interlaced, localPalette }]
 *       duration        ms for one play
 *       loopCount       the NETSCAPE2.0 (or ANIMEXTS1.0) loop count, 0 meaning forever, or null
 *                       when the file has none
 *       plays           how many times browsers play it: Infinity, loopCount + 1, or 1
 *       truncated       true when the file stops before its last byte (the trailer), or turns
 *                       into bytes that cannot be read, as Chrome stops reading there too:
 *                       frames after that point, if there were any, are missing, and
 *                       frameCount counts the frames before it
 *       partialFrame    true when that point falls inside a frame (that frame is not counted)
 *       trailer         whether the blocks end with the trailer byte (0x3B), as they should
 *       transparency    true when some pixels may show through: a transparent colour, a cleared
 *                       or restored area, or a first frame that leaves part of the canvas empty
 *       plainText       how many Plain Text Extensions were skipped (browsers draw none)
 *     }
 *     Rejects with a TTGif.Error whose code is 'EMPTY' (0 bytes), 'NOT_GIF' (err.type then
 *     names what the file is when its first bytes say so: 'png', 'jpeg', 'webp', 'bmp', 'avif',
 *     'heic', 'mp4', 'webm', 'pdf', 'zip', 'svg' or 'text'; else null), 'NO_FRAMES' (a GIF
 *     header without one whole frame) or 'TOO_BIG' (a canvas over TTGif.MAX_PIXELS; err.width
 *     and err.height give its size).
 *
 *   TTGif.open(source, options) -> Promise<reader>
 *     Scans the file as above and gets a decoder ready.
 *     options.decoder  'auto' (the default: ImageDecoder where the page has it and the file is
 *                      at most TTGif.IMAGE_DECODER_MAX_BYTES, else omggif in a worker),
 *                      'imagedecoder' or 'omggif'.
 *     options.info     the info of an earlier scan of this same source, to skip scanning again.
 *     reader.info      as from scan()
 *     reader.decoder   'imagedecoder' or 'omggif'. It changes to 'omggif' part way when
 *                      ImageDecoder refuses a frame or shows the canvas at another size; omggif
 *                      then carries on from that frame, or ends with 'DAMAGED' as well.
 *     reader.frames({ from, to, signal }) -> async iterator over frames from to to - 1
 *       (default: all). Each frame: { index, width, height, data, delay, duration, disposal,
 *       x, y, w, h }. data is a new Uint8ClampedArray of width * height * 4 bytes, RGBA with
 *       straight alpha that is always 0 or 255; transparent pixels are 0, 0, 0, 0. Frames are
 *       made one at a time (the next one is prepared meanwhile), so memory stays at a few
 *       canvases however long the GIF is. A frame that cannot be decoded ends the iteration
 *       with a TTGif.Error coded 'DAMAGED', err.frame being its index, after the frames before
 *       it. An aborted signal ends it with an error named 'AbortError'. 'LOAD' means the
 *       worker or omggif could not be loaded. Iterate one at a time per reader.
 *     reader.close()   frees the decoder and the worker.
 *
 *   TTGif.isGif(bytes) -> boolean   whether the bytes start with GIF87a or GIF89a.
 *   TTGif.playedDuration(delay) -> ms   0 or 1 hundredth -> 100, otherwise delay * 10.
 *   TTGif.Error(code, message)    the error type above.
 *   TTGif.MAX_PIXELS              canvas limit, 50,000,000 pixels.
 *   TTGif.IMAGE_DECODER_MAX_BYTES 268,435,456 (ImageDecoder keeps the whole file in memory;
 *                                 omggif reads one frame at a time from the Blob).
 *
 * Messages to and from the worker (internal): open, run, more, stop; frame, damaged, done,
 * error. omggif's GifReader is given one small GIF per frame (that frame at 0,0 on its own
 * screen, its palette padded to 256 colours with black, as Chrome shows indexes past the end
 * of a palette), so it never sees what makes it throw or wrap (Plain Text Extensions, cut-off
 * data, frames past the edge); interlacing and compositing are done here. Each frame's LZW
 * codes are first checked as Chrome checks them: a code that is not yet defined, a minimum
 * code size over 8 or fewer pixels than the frame needs make the frame damaged. Extra pixels
 * are ignored.
 */
(function () {
  'use strict';

  var IN_WORKER = typeof document === 'undefined' && typeof importScripts === 'function';
  var WINDOW = 8 << 20;

  function GifError(code, message) {
    var e = new Error(message || code);
    e.name = 'TTGifError';
    e.code = code;
    return e;
  }

  function playedDuration(cs) { return cs <= 1 ? 100 : cs * 10; }

  function isGif(b) {
    return !!b && b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
  }

  // What a file is, from its first bytes, when it is not a GIF.
  function sniff(b) {
    var s = '';
    for (var i = 0; i < Math.min(b.length, 32); i++) s += String.fromCharCode(b[i]);
    if (s.slice(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (s.slice(0, 4) === 'RIFF' && s.slice(8, 12) === 'WEBP') return 'webp';
    if (s.slice(0, 2) === 'BM') return 'bmp';
    if (s.slice(4, 8) === 'ftyp') {
      var brand = s.slice(8, 12);
      if (/^avi[fs]$/.test(brand)) return 'avif';
      if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
      return 'mp4';
    }
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'webm';
    if (s.slice(0, 5) === '%PDF-') return 'pdf';
    if (s.slice(0, 4) === 'PK\x03\x04') return 'zip';
    if (/^\s*<(\?xml|svg)/i.test(s)) return 'svg';
    if (s.length && /^[\t\n\r\x20-\x7e]*$/.test(s)) return 'text';
    return null;
  }

  // ---------- Reading bytes ----------
  // A source holds one window of the file in memory: the whole file when it is small (up to two
  // windows), otherwise 8 MiB from the place being read.
  function makeSource(input) {
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      var blob = input;
      var src = { size: blob.size, blob: blob, buf: new Uint8Array(0), start: 0, end: 0 };
      // Makes bytes pos .. pos + need - 1 readable; false when the file is shorter than that.
      src.fill = async function (pos, need) {
        if (pos + need > src.size) return false;
        if (pos >= src.start && pos + need <= src.end) return true;
        var a = pos, b = Math.min(src.size, pos + Math.max(need, WINDOW));
        if (src.size <= 2 * WINDOW) { a = 0; b = src.size; }
        src.buf = new Uint8Array(await blob.slice(a, b).arrayBuffer());
        src.start = a;
        src.end = a + src.buf.length;
        return pos + need <= src.end;
      };
      return src;
    }
    var u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    return {
      size: u8.length, blob: null, buf: u8, start: 0, end: u8.length,
      fill: function (pos, need) { return Promise.resolve(pos + need <= u8.length); },
    };
  }
  function bytesOf(src, a, b) {
    if (a >= src.start && b <= src.end) return src.buf.subarray(a - src.start, b - src.start);
    return null;
  }

  // ---------- Scanning the blocks ----------
  var NO_GCE = { delay: 0, disposal: 0, transparent: -1 };

  async function scanSource(src) {
    var size = src.size;
    if (!size) throw GifError('EMPTY', 'The file is empty.');
    await src.fill(0, Math.min(size, 32));
    var head = bytesOf(src, 0, Math.min(size, 32));
    if (!isGif(head)) {
      var e = GifError('NOT_GIF', 'The file is not a GIF.');
      e.type = sniff(head);
      throw e;
    }
    if (size < 13) throw GifError('NO_FRAMES', 'The file stops inside its header.');
    var at = function (p) { return src.buf[p - src.start]; };
    var u16 = function (p) { return src.buf[p - src.start] | (src.buf[p + 1 - src.start] << 8); };
    var info = {
      size: size, version: head[4] === 0x37 ? '87a' : '89a',
      screenWidth: u16(6), screenHeight: u16(8), width: 0, height: 0,
      frames: [], frameCount: 0, duration: 0, loopCount: null, plays: 1,
      truncated: false, partialFrame: false, trailer: false, transparency: false, plainText: 0,
    };
    var flags = at(10), p = 13, gct = null;
    if (flags & 0x80) {
      var n = 3 << ((flags & 7) + 1);
      if (!(await src.fill(13, n))) throw GifError('NO_FRAMES', 'The file stops inside its colour table.');
      gct = bytesOf(src, 13, 13 + n).slice();
      p += n;
    }
    // Skips sub-blocks from q (a length byte): the position after the terminator, or -1 when
    // the file ends first.
    async function skipBlocks(q) {
      for (;;) {
        if (q >= src.end || q < src.start) {
          if (q >= size) return -1;
          await src.fill(q, 1);
        }
        var len = src.buf[q - src.start];
        q += 1 + len;
        if (len === 0) return q;
      }
    }
    var gce = null, cut = false;
    for (;;) {
      if (p >= size) { cut = true; break; }
      await src.fill(p, 1);
      var t = at(p);
      if (t === 0x3B) { info.trailer = true; break; }
      if (t === 0x21) {
        if (!(await src.fill(p, 2))) { cut = true; break; }
        var label = at(p + 1), q = p + 2;
        if (label === 0xF9) {
          if (!(await src.fill(q, 6))) { cut = true; break; }
          // Chrome stops reading at a Graphic Control Extension of another size.
          if (at(q) !== 4) { info.truncated = true; break; }
          var pk = at(q + 1);
          gce = { delay: u16(q + 2), disposal: (pk >> 2) & 7, transparent: pk & 1 ? at(q + 4) : -1 };
        } else if (label === 0xFF) {
          if (!(await src.fill(q, 1))) { cut = true; break; }
          var idLen = at(q);
          if (!(await src.fill(q, 1 + idLen + 1))) { cut = true; break; }
          var id = '';
          for (var k = 1; k <= idLen; k++) id += String.fromCharCode(at(q + k));
          var dq = q + 1 + idLen;
          if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
            // The loop sub-block: 3 bytes, the first one 1.
            if ((await src.fill(dq, 4)) && at(dq) >= 3 && at(dq + 1) === 1) info.loopCount = u16(dq + 2);
          }
          q = dq;
        } else if (label === 0x01) {
          info.plainText++;
        }
        q = await skipBlocks(q);
        if (q < 0) { cut = true; break; }
        p = q;
        continue;
      }
      if (t === 0x2C) {
        if (!(await src.fill(p, 10))) { cut = true; info.partialFrame = true; break; }
        var fx = u16(p + 1), fy = u16(p + 3), fw = u16(p + 5), fh = u16(p + 7), ff = at(p + 9);
        var lct = ff & 0x80 ? 3 << ((ff & 7) + 1) : 0;
        var dataAt = p + 10 + lct;
        if (!(await src.fill(dataAt, 2))) { cut = true; info.partialFrame = true; break; }
        var end = await skipBlocks(dataAt + 1);
        if (end < 0) { cut = true; info.partialFrame = true; break; }
        var g = gce || NO_GCE;
        gce = null; // a GCE belongs to the next image only (a Plain Text Extension does not use it up, as in Chrome)
        info.frames.push({
          x: fx, y: fy, width: fw, height: fh, delay: g.delay, duration: playedDuration(g.delay),
          disposal: g.disposal, transparent: g.transparent, interlaced: !!(ff & 0x40), localPalette: lct > 0,
          start: p, end: end, lct: lct,
        });
        p = end;
        continue;
      }
      info.truncated = true; // an unknown block: nothing after it can be read
      break;
    }
    if (cut) info.truncated = true;
    var fr = info.frames;
    if (!fr.length) throw GifError('NO_FRAMES', info.truncated ? 'The file stops before its first whole frame.' : 'The file has no frames.');
    var f0 = fr[0];
    info.width = Math.max(info.screenWidth, f0.x + f0.width);
    info.height = Math.max(info.screenHeight, f0.y + f0.height);
    if (!info.width || !info.height) throw GifError('NO_FRAMES', 'The picture is 0 pixels wide or high.');
    if (info.width * info.height > TTGif.MAX_PIXELS) {
      var big = GifError('TOO_BIG', 'The picture is ' + info.width + ' x ' + info.height + ' pixels.');
      big.width = info.width;
      big.height = info.height;
      throw big;
    }
    info.frameCount = fr.length;
    var total = 0, holes = !(f0.x === 0 && f0.y === 0 && f0.width >= info.width && f0.height >= info.height);
    for (var i = 0; i < fr.length; i++) {
      total += fr[i].duration;
      if (fr[i].transparent >= 0 || fr[i].disposal === 2 || fr[i].disposal === 3 || fr[i].disposal === 4) holes = true;
    }
    info.duration = total;
    info.transparency = holes;
    info.plays = info.loopCount === null ? 1 : info.loopCount === 0 ? Infinity : info.loopCount + 1;
    info._gct = gct;
    return info;
  }

  // ---------- Decoding one frame with omggif (in the worker) ----------
  var LENS = new Uint16Array(4096);

  // How many pixels the LZW data at b[p] (its minimum code size byte) codes for, or -1 when a
  // code is not defined yet or the minimum code size is over 8 (Chrome refuses both). Reads the
  // bits exactly as omggif does.
  function lzwCount(b, p) {
    var min = b[p++];
    if (min > 8) return -1;
    var clear = 1 << min, eoi = clear + 1, next = eoi + 1, size = min + 1, mask = (1 << size) - 1;
    for (var i = 0; i < clear; i++) LENS[i] = 1;
    var cur = 0, shift = 0, sub = b[p++], prev = -1, count = 0;
    for (;;) {
      while (shift < 16) {
        if (sub === 0 || sub === undefined) break;
        cur |= b[p++] << shift;
        shift += 8;
        if (sub === 1) sub = b[p++]; else sub--;
      }
      if (shift < size) break;
      var code = cur & mask;
      cur >>= size;
      shift -= size;
      if (code === clear) {
        next = eoi + 1;
        size = min + 1;
        mask = (1 << size) - 1;
        prev = -1;
        continue;
      }
      if (code === eoi) break;
      var len;
      if (code < clear) len = 1;
      else if (code < next && code > eoi) len = LENS[code];
      else if (code === next && prev >= 0) len = LENS[prev] + 1;
      else return -1;
      if (prev >= 0 && next < 4096) {
        LENS[next] = LENS[prev] + 1;
        next++;
        if (next >= mask + 1 && size < 12) {
          size++;
          mask = mask << 1 | 1;
        }
      }
      count += len;
      prev = code;
    }
    return count;
  }

  var ROWS = new Map();
  function interlacedRows(h) {
    var order = ROWS.get(h);
    if (order) return order;
    order = new Int32Array(h);
    var s = 0, passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
    for (var k = 0; k < 4; k++) for (var r = passes[k][0]; r < h; r += passes[k][1]) order[s++] = r;
    if (ROWS.size > 64) ROWS.clear();
    ROWS.set(h, order);
    return order;
  }

  // RGBA pixels (w * h * 4, transparent ones 0) of a frame, from its bytes: the image descriptor
  // through its last sub-block. Returns null for a frame of no pixels; throws 'DAMAGED'.
  function decodeWithOmggif(f, bytes, gct) {
    var w = f.width, h = f.height;
    if (!w || !h) return null;
    var dataAt = 10 + f.lct;
    var count = lzwCount(bytes, dataAt);
    if (count < w * h) throw GifError('DAMAGED', count < 0 ? 'The picture data has a code that cannot be read.' : 'The picture data stops early.');
    // A small GIF of this frame alone: its palette as the global one, padded with black to 256
    // colours, a GCE for its transparent colour, and the frame at 0,0, not interlaced.
    var pal = new Uint8Array(768);
    if (f.lct) pal.set(bytes.subarray(10, 10 + f.lct));
    else if (gct) pal.set(gct.subarray(0, Math.min(768, gct.length)));
    var tall = count > w * h ? h + Math.ceil(4096 / w) : h;
    var data = bytes.subarray(dataAt, bytes.length);
    var mini = new Uint8Array(13 + 768 + 8 + 10 + data.length + 1);
    var o = 0;
    mini.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, tall & 255, tall >> 8, 0xF7, 0, 0], 0);
    o = 13;
    mini.set(pal, o);
    o += 768;
    if (f.transparent >= 0) {
      mini.set([0x21, 0xF9, 4, 1, 0, 0, f.transparent, 0], o);
      o += 8;
    }
    mini.set([0x2C, 0, 0, 0, 0, w & 255, w >> 8, tall & 255, tall >> 8, 0], o);
    o += 10;
    mini.set(data, o);
    o += data.length;
    mini[o++] = 0x3B;
    var out = new Uint8Array(w * tall * 4);
    var log = console.log;
    console.log = function () {}; // omggif notes data of another length with console.log
    try {
      new self.GifReader(mini.subarray(0, o)).decodeAndBlitFrameRGBA(0, out);
    } finally {
      console.log = log;
    }
    if (!f.interlaced) return out;
    var rows = interlacedRows(h), shown = new Uint8Array(w * h * 4), stride = w * 4;
    for (var s = 0; s < h; s++) shown.set(out.subarray(s * stride, (s + 1) * stride), rows[s] * stride);
    return shown;
  }

  // Draws a frame's pixels (w x h) onto the canvas (W x H) at x, y: only the pixels that are not
  // transparent, and only what lies on the canvas.
  function blit(cv, W, H, px, x, y, w, h) {
    var cw = Math.min(w, W - x), ch = Math.min(h, H - y);
    if (cw <= 0 || ch <= 0) return;
    for (var r = 0; r < ch; r++) {
      var si = r * w * 4, di = ((y + r) * W + x) * 4;
      for (var c = 0; c < cw; c++, si += 4, di += 4) {
        if (px[si + 3]) {
          cv[di] = px[si];
          cv[di + 1] = px[si + 1];
          cv[di + 2] = px[si + 2];
          cv[di + 3] = 255;
        }
      }
    }
  }
  function clearRect(cv, W, H, x, y, w, h) {
    var cw = Math.min(w, W - x), ch = Math.min(h, H - y);
    if (cw <= 0 || ch <= 0) return;
    for (var r = 0; r < ch; r++) cv.fill(0, ((y + r) * W + x) * 4, ((y + r) * W + x + cw) * 4);
  }

  // The worker side: composites frames in order, one canvas, and posts copies of it.
  function workerMain() {
    var st = null; // { id, blob, frames, gct, W, H, cv, saved, next, prev, src }
    var job = null; // { id, to, credit, stopped }
    function post(m, transfer) { self.postMessage(m, transfer || []); }
    async function frameBytes(f) {
      var src = st.src;
      if (f.end - f.start > WINDOW) return new Uint8Array(await st.blob.slice(f.start, f.end).arrayBuffer());
      if (!(f.start >= src.start && f.end <= src.end)) {
        var b = Math.min(st.blob.size, Math.max(f.end, f.start + WINDOW));
        src.buf = new Uint8Array(await st.blob.slice(f.start, b).arrayBuffer());
        src.start = f.start;
        src.end = f.start + src.buf.length;
      }
      return src.buf.subarray(f.start - src.start, f.end - src.start);
    }
    async function step() {
      var i = st.next, f = st.frames[i], W = st.W, H = st.H, cv = st.cv;
      var p = st.prev;
      if (p) {
        if (p.disposal === 2) clearRect(cv, W, H, p.x, p.y, p.width, p.height);
        else if ((p.disposal === 3 || p.disposal === 4) && st.saved) cv.set(st.saved);
      }
      st.saved = f.disposal === 3 || f.disposal === 4 ? cv.slice() : null;
      var px = decodeWithOmggif(f, await frameBytes(f), st.gct);
      if (px) blit(cv, W, H, px, f.x, f.y, f.width, f.height);
      st.prev = f;
      st.next = i + 1;
    }
    // One run at a time: a new one waits until the one before has stopped, so that two never
    // draw on the canvas together.
    var chain = Promise.resolve();
    async function run(j) {
      try {
        if (j.stopped) return;
        if (j.from < st.next) { st.cv.fill(0); st.saved = null; st.prev = null; st.next = 0; }
        while (st.next < j.to) {
          if (j.stopped) return;
          var i = st.next;
          if (i >= j.from && j.credit <= 0) {
            await new Promise(function (r) { j.wake = r; });
            continue;
          }
          try {
            await step();
          } catch (e) {
            if (e && e.code === 'DAMAGED') { post({ cmd: 'damaged', id: j.id, index: i, message: e.message }); return; }
            throw e;
          }
          if (i >= j.from && !j.stopped) {
            j.credit--;
            var copy = st.cv.slice();
            post({ cmd: 'frame', id: j.id, index: i, buffer: copy.buffer }, [copy.buffer]);
          }
        }
        if (!j.stopped) post({ cmd: 'done', id: j.id });
      } catch (e) {
        post({ cmd: 'error', id: j.id, message: String((e && e.message) || e) });
      } finally {
        if (job === j) job = null;
      }
    }
    function stopJob() {
      if (!job) return;
      job.stopped = true;
      if (job.wake) { var w = job.wake; job.wake = null; w(); }
      job = null;
    }
    self.onmessage = function (e) {
      var m = e.data;
      if (m.cmd === 'open') {
        try {
          if (!self.GifReader) importScripts(m.omggif);
          if (typeof self.GifReader !== 'function') throw new Error('no GifReader');
        } catch (err) {
          post({ cmd: 'error', id: m.id, code: 'LOAD', message: 'omggif could not be loaded' });
          return;
        }
        st = {
          blob: m.blob, frames: m.frames, gct: m.gct, W: m.width, H: m.height, cv: new Uint8ClampedArray(m.width * m.height * 4),
          saved: null, next: 0, prev: null, src: { buf: new Uint8Array(0), start: 0, end: 0 },
        };
        post({ cmd: 'opened', id: m.id });
      } else if (m.cmd === 'run') {
        stopJob();
        if (!st) { post({ cmd: 'error', id: m.id, message: 'not open' }); return; }
        var j = { id: m.id, from: m.from, to: m.to, credit: m.credit, stopped: false, wake: null };
        job = j;
        chain = chain.then(function () { return run(j); });
      } else if (m.cmd === 'more') {
        if (job && job.id === m.id) {
          job.credit += m.n;
          if (job.wake) { var w = job.wake; job.wake = null; w(); }
        }
      } else if (m.cmd === 'stop') {
        stopJob();
      }
    };
  }

  if (IN_WORKER) {
    workerMain();
    return;
  }

  // ---------- The page side ----------
  var SCRIPT_URL = (document.currentScript && document.currentScript.src) || '';

  function abortError() {
    var e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }

  // Frames from the browser's ImageDecoder, drawn into a canvas to read their pixels. Gives
  // null instead of a frame where ImageDecoder refuses it or shows another canvas size: omggif
  // takes over from there.
  async function idFrame(rd, i) {
    var info = rd.info;
    try {
      if (!rd.dec) {
        var data = rd.src.blob ? (rd.src.start === 0 && rd.src.end === rd.src.size ? rd.src.buf : rd.src.blob.stream()) : rd.src.buf;
        rd.dec = new ImageDecoder({ data: data, type: 'image/gif', colorSpaceConversion: 'none', preferAnimation: true });
        await rd.dec.tracks.ready;
      }
      var res = await rd.dec.decode({ frameIndex: i, completeFramesOnly: true });
      var vf = res.image;
      if (vf.displayWidth !== info.width || vf.displayHeight !== info.height) { vf.close(); return null; }
      if (!rd.ctx) {
        var c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(info.width, info.height) : Object.assign(document.createElement('canvas'), { width: info.width, height: info.height });
        rd.ctx = c.getContext('2d', { willReadFrequently: true });
      }
      rd.ctx.clearRect(0, 0, info.width, info.height);
      rd.ctx.drawImage(vf, 0, 0);
      vf.close();
      return rd.ctx.getImageData(0, 0, info.width, info.height).data;
    } catch (e) {
      return null;
    }
  }

  function closeDecoder(rd) {
    if (rd.dec) { try { rd.dec.close(); } catch (e) { /* closed */ } }
    rd.dec = null;
    rd.ctx = null;
  }

  var jobSeq = 0;
  function startWorker(rd) {
    if (rd.worker) return rd.opened;
    var w;
    try {
      w = new Worker(rd.workerUrl);
    } catch (e) {
      return Promise.reject(GifError('LOAD', 'The GIF decoder could not be started.'));
    }
    rd.worker = w;
    rd.inbox = [];
    rd.waiter = null;
    var deliver = function (m) {
      rd.inbox.push(m);
      if (rd.waiter) { var f = rd.waiter; rd.waiter = null; f(); }
    };
    w.onmessage = function (e) { deliver(e.data); };
    w.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      deliver({ cmd: 'error', id: -1, code: 'LOAD', message: 'The GIF decoder could not be loaded.' });
    };
    var id = ++jobSeq;
    var info = rd.info;
    var frames = info.frames.map(function (f) {
      return { x: f.x, y: f.y, width: f.width, height: f.height, disposal: f.disposal, transparent: f.transparent, interlaced: f.interlaced, start: f.start, end: f.end, lct: f.lct };
    });
    var blob = rd.src.blob || new Blob([rd.src.buf]);
    w.postMessage({ cmd: 'open', id: id, blob: blob, frames: frames, gct: info._gct, width: info.width, height: info.height, omggif: rd.omggifUrl });
    rd.opened = (async function () {
      for (;;) {
        var m = await nextMessage(rd);
        if (m.cmd === 'opened' && m.id === id) return;
        if (m.cmd === 'error') throw GifError('LOAD', 'The GIF decoder could not be loaded.');
      }
    })();
    return rd.opened;
  }
  function nextMessage(rd) {
    if (rd.inbox.length) return Promise.resolve(rd.inbox.shift());
    return new Promise(function (resolve) { rd.waiter = function () { resolve(rd.inbox.shift()); }; });
  }

  async function* workerFrames(rd, from, to, signal) {
    if (signal && signal.aborted) throw abortError();
    // Starting waits for omggif to load in the worker, which a stalled connection can stretch
    // without end: an abort ends that wait too.
    await (signal ? Promise.race([startWorker(rd), new Promise(function (resolve, reject) {
      signal.addEventListener('abort', function () { reject(abortError()); }, { once: true });
    })]) : startWorker(rd));
    var id = ++jobSeq, info = rd.info;
    rd.worker.postMessage({ cmd: 'run', id: id, from: from, to: to, credit: 2 });
    var finished = false;
    var onAbort = function () {
      if (rd.waiter) { var f = rd.waiter; rd.waiter = null; rd.inbox.unshift({ cmd: 'aborted', id: id }); f(); }
    };
    if (signal) signal.addEventListener('abort', onAbort);
    try {
      for (;;) {
        if (signal && signal.aborted) throw abortError();
        var m = await nextMessage(rd);
        if (m.cmd === 'aborted') throw abortError();
        if (m.id !== id && m.id !== -1) continue; // left over from an earlier run
        if (m.cmd === 'frame') {
          var f = info.frames[m.index];
          var frame = {
            index: m.index, width: info.width, height: info.height, data: new Uint8ClampedArray(m.buffer),
            delay: f.delay, duration: f.duration, disposal: f.disposal, x: f.x, y: f.y, w: f.width, h: f.height,
          };
          rd.worker.postMessage({ cmd: 'more', id: id, n: 1 });
          yield frame;
        } else if (m.cmd === 'damaged') {
          finished = true;
          var e = GifError('DAMAGED', 'Frame ' + (m.index + 1) + ' cannot be decoded: ' + m.message);
          e.frame = m.index;
          throw e;
        } else if (m.cmd === 'done') {
          finished = true;
          return;
        } else if (m.cmd === 'error') {
          finished = true;
          throw GifError(m.code === 'LOAD' ? 'LOAD' : 'DECODE', m.message);
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!finished && rd.worker) rd.worker.postMessage({ cmd: 'stop' });
    }
  }

  async function* frames(rd, opts) {
    opts = opts || {};
    var info = rd.info, signal = opts.signal;
    var from = Math.max(0, opts.from | 0), to = Math.min(info.frameCount, opts.to == null ? info.frameCount : opts.to);
    if (rd.closed) throw GifError('CLOSED', 'The reader is closed.');
    var i = from;
    if (rd.decoder === 'imagedecoder') {
      for (; i < to; i++) {
        if (signal && signal.aborted) throw abortError();
        var data = await idFrame(rd, i);
        if (signal && signal.aborted) throw abortError();
        if (!data) { rd.decoder = 'omggif'; closeDecoder(rd); break; }
        var f = info.frames[i];
        yield { index: i, width: info.width, height: info.height, data: data, delay: f.delay, duration: f.duration, disposal: f.disposal, x: f.x, y: f.y, w: f.width, h: f.height };
      }
    }
    if (i < to) yield* workerFrames(rd, i, to, signal);
  }

  async function open(input, options) {
    options = options || {};
    var src = makeSource(input);
    var info = options.info || await scanSource(src);
    var want = options.decoder || 'auto';
    var hasId = typeof ImageDecoder === 'function';
    var decoder = want === 'omggif' || !hasId ? 'omggif' : want === 'imagedecoder' ? 'imagedecoder' : info.size <= TTGif.IMAGE_DECODER_MAX_BYTES ? 'imagedecoder' : 'omggif';
    var workerUrl = options.workerUrl || SCRIPT_URL;
    var rd = {
      info: info, decoder: decoder, src: src, dec: null, ctx: null, worker: null, closed: false,
      workerUrl: workerUrl, omggifUrl: options.omggifUrl || new URL('../vendor/omggif/omggif.js', workerUrl || location.href).href,
    };
    return {
      info: info,
      get decoder() { return rd.decoder; },
      frames: function (o) { return frames(rd, o); },
      close: function () {
        rd.closed = true;
        closeDecoder(rd);
        if (rd.worker) { rd.worker.terminate(); rd.worker = null; }
      },
    };
  }

  var TTGif = window.TTGif = {
    scan: function (input) { return scanSource(makeSource(input)); },
    open: open,
    isGif: isGif,
    playedDuration: playedDuration,
    Error: GifError,
    MAX_PIXELS: 50e6,
    IMAGE_DECODER_MAX_BYTES: 256 << 20,
  };
})();
