/*
 * TTImage: shared image decoding and encoding for the image tools (window.TTImage).
 * No dependencies; the HEIC/HEIF decoder (libheif) and the TIFF decoder (UTIF +
 * pako) load from /assets/vendor/ into a Web Worker the first time such a file
 * is opened. Heavy pixel work (decoding, resizing, encoding) runs in workers on
 * an OffscreenCanvas where the browser has one, so big photos never freeze the page.
 *
 * Load it where it is needed:
 *   <script src="{{ '/assets/js/image-decode.js' | relative_url }}"></script>
 *
 * FORMAT KEYS: 'png' 'jpeg' 'webp' 'gif' 'bmp' 'ico' 'avif' 'heic' 'tiff' 'svg'
 * (and 'jxl', decoded only where the browser can). TTImage.formats[key] gives
 * { mime, ext, label }.
 *
 * TTImage.sniff(fileOrBytes) -> key|null for bytes (Uint8Array/ArrayBuffer),
 *   Promise<key|null> for a Blob/File. The format from the first bytes (magic
 *   numbers), never the name; `await TTImage.sniff(x)` works for both.
 * TTImage.sniffBytes(uint8Array) -> key|null
 * TTImage.accept   value for <input type="file" accept="..."> covering every
 *                  readable type and extension (HEIC, TIFF and ICO included).
 *
 * TTImage.decode(file, options) -> Promise<result>
 *   options: { maxPixels = 100e6,
 *              exif = false     also return the EXIF block,
 *              canvas = true    false keeps the pixels in a worker: use
 *                               encode(result) / toCanvas(result); fastest for
 *                               converters, as the page never touches the pixels }
 *   result:  { canvas,       an upright <canvas> (see options.canvas); the EXIF
 *                            orientation of JPEG, PNG and WebP, the rotation and
 *                            mirror boxes of HEIC and AVIF and the TIFF
 *                            Orientation tag are all applied
 *              width, height, format, hasAlpha (any transparent pixel),
 *              orientation,  EXIF orientation found in the file (1 = none)
 *              exif,         Uint8Array of the EXIF block (TIFF layout) if
 *                            options.exif and the file has one, else null
 *              animated, frames,   only the first frame is decoded (GIF, APNG, WebP)
 *              images,       HEIC: number of top-level images (the primary one is
 *                            decoded); TIFF: number of pages (the first is decoded)
 *              colorProfile, 'converted' when a wide-gamut HEIC/TIFF profile was
 *                            converted to sRGB (browsers do this themselves for
 *                            the formats they decode)
 *              decoder,      'browser' | 'libheif' | 'utif' | 'svg'
 *              warnings }    'truncated' when a PNG/WebP ends early (the rest is blank);
 *                            'foreignObject' when an SVG's HTML content was left out;
 *                            'hdr' when a HEIC decoded by libheif is HDR (PQ/HLG), which
 *                            is converted without tone mapping
 *   Rejects with an Error with a readable .message and a .code: EMPTY,
 *   UNSUPPORTED, CORRUPT, TOO_BIG, NO_SUPPORT (browser lacks AVIF/JPEG XL),
 *   LOAD_FAILED (decoder file could not load), SVG_INVALID; encode() also GONE
 *   (the result was released, or its worker crashed: decode the file again).
 * TTImage.toCanvas(result) -> Promise<canvas>    the pixels on the page
 * TTImage.release(result)    frees a result's memory (in the page and the worker)
 *
 * TTImage.canEncode(formatOrMime, { wasm }) -> Promise<boolean>
 *   PNG, BMP, ICO, TIFF and GIF always; JPEG/WebP/AVIF by trying canvas.toBlob. With
 *   { wasm: true }, AVIF also counts where the WebAssembly encoder can run.
 * TTImage.encode(source, format, options) -> Promise<Blob>
 *   source:  a decode() result (best), a canvas, an ImageBitmap or an <img>
 *   format:  'png' | 'jpeg' | 'webp' | 'avif' | 'bmp' | 'ico' | 'tiff' | 'gif' (or a MIME type)
 *   options: { width, height: output size in pixels (default: the source's),
 *                         resized with repeated halving for a smooth result,
 *              quality: 0..1 (JPEG/WebP/AVIF, default 0.92),
 *              background: CSS colour; always used for JPEG and BMP (default
 *                          white), used for PNG/WebP/AVIF only when given,
 *              icoSizes: [16, 32, 48, 256] square sizes (1..256) for ICO; each is
 *                        a PNG entry, the image fitted and centred,
 *              exif: Uint8Array from decode(); written into JPEG/PNG/WebP with
 *                    Orientation reset to 1 (pixels are already upright), the
 *                    pixel size updated and the embedded thumbnail removed,
 *              stripGps: true removes the GPS block from that EXIF,
 *              dpi: print resolution to record (PNG pHYs, JPEG JFIF, BMP header,
 *                   TIFF XResolution; TIFF defaults to 72),
 *              wasm: true lets AVIF use the libavif encoder in /assets/vendor/avif/
 *                    (3.5 MB, loaded on first use, in a module worker) where the
 *                    browser's canvas cannot encode AVIF; up to 50 megapixels,
 *              speed: 0..10 for that encoder (default 6, or 8 above 2.5 MP) }
 *   BMP is written as 24-bit; ICO holds one PNG per size; TIFF is 8-bit RGB (RGBA
 *   when any pixel is transparent), LZW-compressed with the horizontal predictor;
 *   GIF keeps up to 256 colours exactly, else a median-cut palette with
 *   Floyd-Steinberg dithering, and pixels under half opacity become transparent.
 *   Rejects like decode().
 * TTImage.resize(canvasOrImage, width, height) -> canvas   (on the page)
 * TTImage.exif.orientation(tiffBytes), TTImage.exif.prepare(tiffBytes, {width,
 *   height, stripGps})   the EXIF helpers encode() uses.
 * TTImage.svg.info(text) -> { width, height, from, viewBox, notes[], external,
 *                            scripts, hasText, foreignObject (count), text }  or { error }
 *   Intrinsic size from width/height (px, pt, pc, in, cm, mm, Q, em, ex) and
 *   viewBox, following the SVG sizing rules; adds a missing xmlns and replaces
 *   HTML entities (text is the fixed code).
 * TTImage.svg.render(text, width, height) -> Promise<canvas>
 *   Rasterises through an <img> loaded from a Blob URL, so scripts in the SVG
 *   never run and nothing referenced by URL is fetched; linked images are left
 *   out rather than drawn as broken-image icons. Where the browser would lock
 *   the canvas because of HTML inside <foreignObject> (Chrome does), that
 *   HTML is left out and canvas.dataset.omitted is 'foreignObject'.
 */
(function () {
  'use strict';

  var SCRIPT = document.currentScript && document.currentScript.src;
  var VENDOR = new URL('../vendor/', SCRIPT || new URL('/assets/js/image-decode.js', location.href).href).href;
  var DEFAULT_MAX = 100e6;

  var FORMATS = {
    png: { mime: 'image/png', ext: 'png', label: 'PNG' },
    jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
    webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
    gif: { mime: 'image/gif', ext: 'gif', label: 'GIF' },
    bmp: { mime: 'image/bmp', ext: 'bmp', label: 'BMP' },
    ico: { mime: 'image/x-icon', ext: 'ico', label: 'ICO' },
    avif: { mime: 'image/avif', ext: 'avif', label: 'AVIF' },
    heic: { mime: 'image/heic', ext: 'heic', label: 'HEIC' },
    tiff: { mime: 'image/tiff', ext: 'tif', label: 'TIFF' },
    svg: { mime: 'image/svg+xml', ext: 'svg', label: 'SVG' },
    jxl: { mime: 'image/jxl', ext: 'jxl', label: 'JPEG XL' }
  };
  var ACCEPT = 'image/*,.png,.apng,.jpg,.jpeg,.jfif,.pjpeg,.pjp,.webp,.gif,.bmp,.dib,.ico,.cur,.avif,.heic,.heif,.hif,.tif,.tiff,.svg,.jxl';

  function fail(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    e.friendly = true;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  // ---------- Byte helpers ----------
  function ascii(b, o, n) {
    var s = '';
    for (var i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }
  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32be(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
  function u32le(b, o) { return ((b[o + 3] << 24) >>> 0) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o]); }
  function i32le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }
  function concat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(parts) {
    var c = 0xFFFFFFFF;
    for (var p = 0; p < parts.length; p++) for (var i = 0; i < parts[p].length; i++) c = CRC[(c ^ parts[p][i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function bytesOf(str) { var a = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 255; return a; }

  async function readRange(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  // ---------- Sniffing ----------
  var HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'];
  function brands(b) {
    var size = u32be(b, 0), list = [ascii(b, 8, 4)];
    for (var o = 16; o + 4 <= Math.min(size, b.length, 256); o += 4) list.push(ascii(b, o, 4));
    return list;
  }
  // Does the text start with an <svg> element, after any XML declaration,
  // comments, processing instructions and DOCTYPE? A plain scan in linear time:
  // a regular expression for this backtracks exponentially on a text file that
  // starts with a few dozen comments, freezing the page for minutes.
  function svgStart(s) {
    var i = s.charCodeAt(0) === 0xFEFF ? 1 : 0, n = s.length, e;
    for (;;) {
      while (i < n && /\s/.test(s.charAt(i))) i++;
      if (s.startsWith('<!--', i)) e = s.indexOf('-->', i + 4) + 3;
      else if (s.startsWith('<?', i)) e = s.indexOf('?>', i + 2) + 2;
      else if (s.substr(i, 9).toUpperCase() === '<!DOCTYPE') {
        var gt = s.indexOf('>', i), br = s.indexOf('[', i);
        if (br >= 0 && (gt < 0 || br < gt)) { e = s.indexOf(']', br); e = e < 0 ? -1 : s.indexOf('>', e); }
        else e = gt;
        e = e < 0 ? 2 : e + 1;
      } else break;
      if (e < 3) return false; // unterminated
      i = e;
    }
    return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/i.test(s.substr(i, 256));
  }
  function looksSvg(b) {
    var n = Math.min(b.length, 65536);
    for (var i = 0; i < Math.min(n, 512); i++) if (b[i] === 0) return false;
    var s;
    try { s = new TextDecoder('utf-8').decode(b.subarray(0, n)); } catch (e) { return false; }
    return svgStart(s);
  }
  function sniffBytes(b) {
    if (!b || !b.length) return null;
    if (!(b instanceof Uint8Array)) b = new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength);
    var n = b.length;
    if (n >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) return 'png';
    if (n >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (n >= 6 && ascii(b, 0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
    if (n >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (n >= 18 && b[0] === 0x42 && b[1] === 0x4D && [12, 16, 40, 52, 56, 64, 108, 124].indexOf(u32le(b, 14)) >= 0) return 'bmp';
    if (n >= 22 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) {
      var count = u16le(b, 4);
      if (count > 0 && count < 256 && b[9] === 0 && u32le(b, 18) >= 6 + 16 * count) return 'ico';
    }
    if (n >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43) && b[3] === 0) ||
      (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0 && (b[3] === 42 || b[3] === 43)))) return 'tiff';
    if (n >= 12 && ascii(b, 4, 4) === 'ftyp') {
      var br = brands(b);
      if (br.indexOf('avif') >= 0 || br.indexOf('avis') >= 0) return 'avif';
      for (var i = 0; i < HEIC_BRANDS.length; i++) if (br.indexOf(HEIC_BRANDS[i]) >= 0) return 'heic';
      if (br.indexOf('mif1') >= 0 || br.indexOf('msf1') >= 0) return 'heic';
      return null;
    }
    if (n >= 2 && b[0] === 0xFF && b[1] === 0x0A) return 'jxl';
    if (n >= 12 && u32be(b, 0) === 12 && ascii(b, 4, 4) === 'JXL ') return 'jxl';
    if (looksSvg(b)) return 'svg';
    return null;
  }
  // Bytes give the answer at once; a Blob (File) has to be read, so gives a Promise.
  function sniff(x) {
    if (x instanceof Blob) return readRange(x, 0, 65536).then(sniffBytes, function () { return null; });
    if (x instanceof ArrayBuffer) return sniffBytes(new Uint8Array(x));
    if (ArrayBuffer.isView(x)) return sniffBytes(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    return null;
  }
  // A readable message for files that are clearly something else.
  function notImage(b) {
    if (ascii(b, 0, 5) === '%PDF-') return 'This is a PDF document, not an image.';
    if (ascii(b, 0, 4) === '8BPS') return 'Photoshop (PSD) files are not supported. Export a PNG or JPG from Photoshop first.';
    if (ascii(b, 4, 4) === 'ftyp') return 'This looks like a video file, not a still image.';
    if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 3 && b[3] === 4) return 'This is a ZIP archive. Unzip it first, then add the images.';
    return 'This is not a supported image. Supported: PNG, JPG, WebP, GIF, BMP, ICO, AVIF, HEIC, TIFF and SVG.';
  }

  // Pixel size from the header, to refuse huge images before decoding them.
  function headerSize(b, fmt) {
    try {
      if (fmt === 'png' && ascii(b, 12, 4) === 'IHDR') return [u32be(b, 16), u32be(b, 20)];
      if (fmt === 'gif') return [u16le(b, 6), u16le(b, 8)];
      if (fmt === 'bmp') return u32le(b, 14) === 12 ? [u16le(b, 18), u16le(b, 20)] : [Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22))];
      if (fmt === 'webp') {
        var c = ascii(b, 12, 4);
        if (c === 'VP8X') return [1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)];
        if (c === 'VP8 ') return [u16le(b, 26) & 0x3FFF, u16le(b, 28) & 0x3FFF];
        if (c === 'VP8L') return [1 + (((b[22] & 0x3F) << 8) | b[21]), 1 + (((b[24] & 0x0F) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6))];
      }
      if (fmt === 'jpeg') {
        var i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xFF) return null;
          var m = b[i + 1];
          if (m === 0xFF) { i++; continue; }
          if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [u16be(b, i + 7), u16be(b, i + 5)];
          if (m === 0xDA || m === 0xD9) return null;
          i += 2 + u16be(b, i + 2);
        }
      }
      if (fmt === 'ico') {
        var best = 0;
        for (var k = 0, n = u16le(b, 4); k < n && 6 + 16 * k + 16 <= b.length; k++) best = Math.max(best, b[6 + 16 * k] || 256);
        return best ? [best, best] : null;
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  // ---------- EXIF (TIFF-structured) ----------
  function tiffView(u8) {
    if (!u8 || u8.length < 8) return null;
    var le = u8[0] === 0x49 && u8[1] === 0x49;
    if (!le && !(u8[0] === 0x4D && u8[1] === 0x4D)) return null;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint16(2, le) !== 42) return null;
    return {
      u8: u8, le: le, ifd0: dv.getUint32(4, le),
      r16: function (o) { return dv.getUint16(o, le); },
      r32: function (o) { return dv.getUint32(o, le); },
      w16: function (o, v) { dv.setUint16(o, v, le); },
      w32: function (o, v) { dv.setUint32(o, v, le); }
    };
  }
  var TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
  function ifdEntries(t, off) {
    if (!off || off + 2 > t.u8.length) return null;
    var n = t.r16(off);
    if (off + 2 + n * 12 + 4 > t.u8.length) return null;
    var list = [];
    for (var i = 0; i < n; i++) {
      var p = off + 2 + i * 12, type = t.r16(p + 2), count = t.r32(p + 4);
      var size = (TYPE_SIZE[type] || 1) * count;
      list.push({ tag: t.r16(p), type: type, count: count, pos: p, val: p + 8, size: size, data: size > 4 ? t.r32(p + 8) : p + 8 });
    }
    return { off: off, list: list, next: off + 2 + n * 12 };
  }
  function findTag(ifd, tag) { for (var i = 0; ifd && i < ifd.list.length; i++) if (ifd.list[i].tag === tag) return ifd.list[i]; return null; }
  function exifOrientation(tiff) {
    try {
      var t = tiffView(tiff), ifd = t && ifdEntries(t, t.ifd0), e = findTag(ifd, 0x0112);
      if (e && e.type === 3) { var o = t.r16(e.val); return o >= 1 && o <= 8 ? o : 1; }
    } catch (err) { /* ignore */ }
    return 1;
  }
  // A copy of the EXIF block that is right for a re-encoded image.
  function prepareExif(src, o) {
    try {
      var u8 = new Uint8Array(src);
      var t = tiffView(u8);
      if (!t) return null;
      var ifd0 = ifdEntries(t, t.ifd0);
      if (!ifd0) return null;
      var or = findTag(ifd0, 0x0112);
      if (or && or.type === 3) t.w16(or.val, 1);
      var sub = findTag(ifd0, 0x8769);
      var exifIfd = sub && ifdEntries(t, t.r32(sub.val));
      [[0xA002, o.width], [0xA003, o.height]].forEach(function (p) {
        var e = findTag(exifIfd, p[0]);
        if (!e || !p[1]) return;
        if (e.type === 3 && p[1] < 65536) t.w16(e.val, p[1]);
        else if (e.type === 4) t.w32(e.val, p[1]);
      });
      // Bytes still in use by the IFDs that are kept are never wiped, even when a
      // damaged file points other structures at them (IFD1 pointing back at IFD0).
      var keep = [];
      var protect = function (ifd) {
        if (!ifd) return;
        keep.push([ifd.off, ifd.next + 4]);
        ifd.list.forEach(function (e) { if (e.size > 4) keep.push([e.data, e.data + e.size]); });
      };
      var wipe = function (a, b) {
        if (!(a >= 0 && b > a && b <= u8.length)) return;
        var p = a;
        keep.filter(function (r) { return r[1] > a && r[0] < b; }).sort(function (x, y) { return x[0] - y[0]; }).forEach(function (r) {
          if (r[0] > p) u8.fill(0, p, r[0]);
          p = Math.max(p, r[1]);
        });
        if (p < b) u8.fill(0, p, b);
      };
      var wipeIfd = function (ifd) {
        ifd.list.forEach(function (e) { if (e.size > 4) wipe(e.data, e.data + e.size); });
        wipe(ifd.off, ifd.next + 4);
      };
      var interop = findTag(exifIfd, 0xA005);
      var gps = findTag(ifd0, 0x8825), gpsIfd = gps && ifdEntries(t, t.r32(gps.val));
      protect(ifd0);
      protect(exifIfd);
      protect(interop && ifdEntries(t, t.r32(interop.val)));
      if (!o.stripGps) protect(gpsIfd);
      // IFD1 holds a thumbnail of the original (possibly sideways) picture: drop it.
      var ifd1 = ifdEntries(t, t.r32(ifd0.next));
      if (ifd1) {
        var jo = findTag(ifd1, 0x0201), jl = findTag(ifd1, 0x0202);
        if (jo && jl) wipe(t.r32(jo.val), t.r32(jo.val) + t.r32(jl.val));
        wipeIfd(ifd1);
      }
      t.w32(ifd0.next, 0);
      if (o.stripGps && gps) {
        if (gpsIfd) wipeIfd(gpsIfd);
        // Remove the GPS entry from IFD0: later entries and the (zero) next-IFD link move up.
        u8.copyWithin(gps.pos, gps.pos + 12, ifd0.next + 4);
        u8.fill(0, ifd0.next - 8, ifd0.next + 4);
        t.w16(ifd0.off, ifd0.list.length - 1);
      }
      return u8;
    } catch (e) {
      return null;
    }
  }
  function tinyExif(orientation) {
    return new Uint8Array([0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  }
  function exifStart(d) {
    if (!d || d.length < 8) return null;
    if (ascii(d, 0, 6) === 'Exif\0\0') d = d.subarray(6);
    return tiffView(d) ? d : null;
  }
  function jpegExif(b) {
    var i = 2;
    while (i + 4 <= b.length && b[i] === 0xFF) {
      var m = b[i + 1];
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { i += m === 0xFF ? 1 : 2; continue; }
      if (m === 0xDA || m === 0xD9) break;
      var len = u16be(b, i + 2);
      if (m === 0xE1 && ascii(b, i + 4, 6) === 'Exif\0\0') return exifStart(b.slice(i + 4, i + 2 + len));
      i += 2 + len;
    }
    return null;
  }
  // An IEND chunk: length 0, type, CRC AE 42 60 82.
  function hasIend(b) {
    for (var i = b.length - 12; i >= 0; i--) {
      if (b[i + 4] === 0x49 && b[i + 5] === 0x45 && b[i + 6] === 0x4E && b[i + 7] === 0x44 && !b[i] && !b[i + 1] && !b[i + 2] && !b[i + 3] &&
        b[i + 8] === 0xAE && b[i + 9] === 0x42 && b[i + 10] === 0x60 && b[i + 11] === 0x82) return true;
    }
    return false;
  }
  function pngChunks(b, fn) {
    var o = 8;
    while (o + 8 <= b.length) {
      var len = u32be(b, o), type = ascii(b, o + 4, 4);
      if (fn(type, o + 8, len) === false) return;
      if (type === 'IEND') return;
      o += 12 + len;
    }
  }
  async function webpChunks(blob, fn) {
    var size = blob.size, o = 12;
    while (o + 8 <= size) {
      var h = await readRange(blob, o, o + 8), len = u32le(h, 0), type = ascii(h, 0, 4);
      if (await fn(type, o + 8, len) === false) return;
      o += 8 + len + (len & 1);
    }
  }

  // Write EXIF into an encoded JPEG, PNG or WebP.
  function withExif(b, fmt, exif, w, h) {
    if (fmt === 'jpeg') {
      if (exif.length > 65527) return null;
      var at = 2;
      if (b[2] === 0xFF && b[3] === 0xE0) at = 4 + u16be(b, 4);
      var len = exif.length + 8, seg = new Uint8Array(4 + 6);
      seg.set([0xFF, 0xE1, len >> 8, len & 255]);
      seg.set(bytesOf('Exif\0\0'), 4);
      return concat([b.subarray(0, at), seg, exif, b.subarray(at)]);
    }
    if (fmt === 'png') {
      var after = 8 + 12 + u32be(b, 8);
      var head = new Uint8Array(8), type = bytesOf('eXIf');
      head.set([exif.length >>> 24, (exif.length >> 16) & 255, (exif.length >> 8) & 255, exif.length & 255]);
      head.set(type, 4);
      var c = crc32([type, exif]), tail = new Uint8Array([c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255]);
      return concat([b.subarray(0, after), head, exif, tail, b.subarray(after)]);
    }
    if (fmt === 'webp') {
      var chunk = new Uint8Array(8 + exif.length + (exif.length & 1));
      chunk.set(bytesOf('EXIF'));
      chunk.set([exif.length & 255, (exif.length >> 8) & 255, (exif.length >> 16) & 255, exif.length >>> 24], 4);
      chunk.set(exif, 8);
      var first = ascii(b, 12, 4), body;
      if (first === 'VP8X') {
        body = concat([b.subarray(12), chunk]);
        body[8] |= 0x08;
      } else {
        var alpha = first === 'VP8L' && (b[24] & 0x10) ? 0x10 : 0;
        var x = new Uint8Array(18);
        x.set(bytesOf('VP8X'));
        x.set([10, 0, 0, 0, 0x08 | alpha, 0, 0, 0], 4);
        x.set([(w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255], 12);
        body = concat([x, b.subarray(12), chunk]);
      }
      var riff = new Uint8Array(12), size = body.length + 4;
      riff.set(bytesOf('RIFF'));
      riff.set([size & 255, (size >> 8) & 255, (size >> 16) & 255, size >>> 24], 4);
      riff.set(bytesOf('WEBP'), 8);
      return concat([riff, body]);
    }
    return null;
  }

  // Record a print resolution: PNG pHYs chunk, JPEG JFIF density (WebP has no field for it).
  function withDpi(b, fmt, dpi) {
    if (fmt === 'png') {
      var ppm = Math.round(dpi / 0.0254), data = new Uint8Array(9), type = bytesOf('pHYs');
      data.set([ppm >>> 24, (ppm >> 16) & 255, (ppm >> 8) & 255, ppm & 255, ppm >>> 24, (ppm >> 16) & 255, (ppm >> 8) & 255, ppm & 255, 1]);
      var parts = [], o = 8;
      parts.push(b.subarray(0, 8));
      while (o + 12 <= b.length) {
        var len = u32be(b, o), t = ascii(b, o + 4, 4);
        if (t !== 'pHYs') parts.push(b.subarray(o, o + 12 + len));
        if (t === 'IHDR') {
          var c = crc32([type, data]);
          parts.push(new Uint8Array([0, 0, 0, 9]), type, data, new Uint8Array([c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255]));
        }
        o += 12 + len;
      }
      return concat(parts);
    }
    if (fmt === 'jpeg') {
      var d = Math.max(1, Math.min(65535, Math.round(dpi)));
      if (b[2] === 0xFF && b[3] === 0xE0 && ascii(b, 6, 5) === 'JFIF\0') {
        var out = b.slice();
        out.set([1, d >> 8, d & 255, d >> 8, d & 255], 13);
        return out;
      }
      var app0 = new Uint8Array([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
      return concat([b.subarray(0, 2), app0, b.subarray(2)]);
    }
    return null;
  }

  // ---------- HEIF / AVIF container (ISO BMFF) ----------
  function parseHeif(u8) {
    var out = { primary: 0, items: {}, iloc: {}, refs: [], props: [], assoc: {}, idat: null, meta: false };
    try {
      var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
      var r16 = function (o) { return dv.getUint16(o); }, r32 = function (o) { return dv.getUint32(o); };
      var rN = function (o, size) { return size === 0 ? 0 : size === 1 ? u8[o] : size === 2 ? r16(o) : size === 4 ? r32(o) : r32(o) * 4294967296 + r32(o + 4); };
      var boxes = function (start, end, fn) {
        var off = start;
        while (off + 8 <= end) {
          var size = r32(off), hdr = 8;
          if (size === 1) { size = r32(off + 8) * 4294967296 + r32(off + 12); hdr = 16; } else if (size === 0) size = end - off;
          if (size < hdr || off + size > end) return;
          if (fn(ascii(u8, off + 4, 4), off + hdr, off + size) === false) return;
          off += size;
        }
      };
      var meta = null;
      boxes(0, n, function (t, s, e) { if (t === 'meta') { meta = [s + 4, e]; return false; } });
      if (!meta) return out;
      out.meta = true;
      boxes(meta[0], meta[1], function (t, s, e) {
        var v = u8[s], p = s + 4, i, j;
        if (t === 'pitm') out.primary = v === 0 ? r16(p) : r32(p);
        else if (t === 'iinf') {
          boxes(p + (v === 0 ? 2 : 4), e, function (t2, s2) {
            if (t2 !== 'infe' || u8[s2] < 2) return;
            var v2 = u8[s2], q = s2 + 4, id = v2 === 2 ? r16(q) : r32(q);
            q += (v2 === 2 ? 2 : 4) + 2;
            out.items[id] = { type: ascii(u8, q, 4), hidden: !!(u8[s2 + 3] & 1) };
          });
        } else if (t === 'iloc') {
          var os = u8[p] >> 4, ls = u8[p] & 15, bs = u8[p + 1] >> 4, is = v === 1 || v === 2 ? u8[p + 1] & 15 : 0;
          p += 2;
          var count = v < 2 ? r16(p) : r32(p);
          p += v < 2 ? 2 : 4;
          for (i = 0; i < count; i++) {
            var id = v < 2 ? r16(p) : r32(p);
            p += v < 2 ? 2 : 4;
            var method = 0;
            if (v === 1 || v === 2) { method = r16(p) & 15; p += 2; }
            p += 2;
            var base = rN(p, bs);
            p += bs;
            var ec = r16(p), ext = [];
            p += 2;
            for (j = 0; j < ec; j++) {
              p += is;
              var eo = rN(p, os);
              p += os;
              var el = rN(p, ls);
              p += ls;
              ext.push([base + eo, el]);
            }
            out.iloc[id] = { method: method, ext: ext };
          }
        } else if (t === 'idat') out.idat = [s, e];
        else if (t === 'iref') {
          var wide = v === 1;
          boxes(p, e, function (rt, rs) {
            var q = rs, from = wide ? r32(q) : r16(q);
            q += wide ? 4 : 2;
            var rc = r16(q), to = [];
            q += 2;
            for (var k = 0; k < rc; k++) { to.push(wide ? r32(q) : r16(q)); q += wide ? 4 : 2; }
            out.refs.push({ type: rt, from: from, to: to });
          });
        } else if (t === 'iprp') {
          boxes(s, e, function (pt, ps, pe) {
            if (pt === 'ipco') boxes(ps, pe, function (ct, cs, ce) { out.props.push({ type: ct, s: cs, e: ce }); });
            else if (pt === 'ipma') {
              var pv = u8[ps], pf = u8[ps + 3], q = ps + 4, ec2 = r32(q);
              q += 4;
              for (var k = 0; k < ec2; k++) {
                var iid = pv < 1 ? r16(q) : r32(q);
                q += pv < 1 ? 2 : 4;
                var ac = u8[q++], list = out.assoc[iid] || (out.assoc[iid] = []);
                for (var m = 0; m < ac; m++) {
                  var idx;
                  if (pf & 1) { idx = r16(q) & 0x7FFF; q += 2; } else { idx = u8[q] & 0x7F; q += 1; }
                  if (idx) list.push(idx - 1);
                }
              }
            }
          });
        }
      });

      var propsOf = function (id, type) {
        return (out.assoc[id] || []).map(function (i) { return out.props[i]; }).filter(function (p) { return p && p.type === type; });
      };
      var dataOf = function (id) {
        var loc = out.iloc[id];
        if (!loc) return null;
        return concat(loc.ext.map(function (x) {
          var start = loc.method === 1 ? (out.idat ? out.idat[0] + x[0] : -1) : x[0];
          var len = x[1] || (loc.method === 1 ? out.idat[1] - start : n - start);
          if (start < 0 || start + len > n) throw new Error('extent');
          return u8.subarray(start, start + len);
        }));
      };
      var ids = Object.keys(out.items).map(Number);
      var IMAGE = ['hvc1', 'av01', 'grid', 'iden', 'iovl', 'jpeg', 'j2k1', 'unci', 'avc1', 'vvc1'];
      var notTop = {};
      out.refs.forEach(function (r) {
        if (r.type === 'thmb' || r.type === 'auxl') notTop[r.from] = 1;
        if (r.type === 'dimg') r.to.forEach(function (x) { notTop[x] = 1; });
      });
      out.count = ids.filter(function (id) { return IMAGE.indexOf(out.items[id].type) >= 0 && !out.items[id].hidden && !notTop[id]; }).length;
      out.truncated = ids.some(function (id) {
        var loc = out.iloc[id];
        return IMAGE.indexOf(out.items[id].type) >= 0 && loc && loc.method === 0 && loc.ext.some(function (x) { return x[0] + x[1] > n; });
      });
      var primary = out.primary || ids.filter(function (id) { return IMAGE.indexOf(out.items[id].type) >= 0; })[0];
      out.primary = primary;
      var ispe = propsOf(primary, 'ispe')[0];
      if (ispe) { out.width = r32(ispe.s + 4); out.height = r32(ispe.s + 8); }
      var colr = propsOf(primary, 'colr');
      if (!colr.length) {
        var d = out.refs.filter(function (r) { return r.type === 'dimg' && r.from === primary; })[0];
        if (d) colr = propsOf(d.to[0], 'colr');
      }
      colr.forEach(function (c) {
        var ct = ascii(u8, c.s, 4);
        if (ct === 'prof' || ct === 'rICC') out.icc = u8.slice(c.s + 4, c.e);
        else if (ct === 'nclx') out.nclx = { p: r16(c.s + 4), t: r16(c.s + 6), m: r16(c.s + 8) };
      });
      var exifIds = ids.filter(function (id) { return out.items[id].type === 'Exif'; });
      var forPrimary = exifIds.filter(function (id) {
        return out.refs.some(function (r) { return r.type === 'cdsc' && r.from === id && r.to.indexOf(primary) >= 0; });
      });
      var exifId = forPrimary[0] || exifIds[0];
      if (exifId) {
        var raw = dataOf(exifId);
        if (raw && raw.length > 8) {
          var skip = 4 + r32Of(raw, 0), found = null;
          if (skip < raw.length) found = exifStart(raw.subarray(skip));
          for (var k = 4; !found && k < Math.min(raw.length, 40); k++) found = exifStart(raw.subarray(k));
          out.exif = found ? found.slice() : null;
        }
      }
    } catch (e) {
      out.broken = true;
    }
    return out;
  }
  function r32Of(b, o) { return u32be(b, o); }

  // ---------- Worker side (HEIC via libheif, TIFF via UTIF) ----------
  // Serialised into a Blob worker. It must not use anything from the enclosing scope.
  function workerMain(g, pixelOps) {
    var heif = null, utifLoaded = false;
    var ops = pixelOps(function (w, h) { return new OffscreenCanvas(w, h); });

    function err(code, message) { var e = new Error(message || code); e.code = code; e.friendly = message || ''; return e; }

    function heifLib(base) {
      if (!heif) {
        heif = (async function () {
          var res;
          try { res = await fetch(base + 'libheif/libheif.wasm'); } catch (e) { res = null; }
          if (!res || !res.ok) throw err('LOAD_FAILED', 'The HEIC decoder could not be downloaded. Check your connection and try again.');
          var wasm = await res.arrayBuffer();
          try { g.importScripts(base + 'libheif/libheif.js'); } catch (e) { throw err('LOAD_FAILED', 'The HEIC decoder could not be loaded. Check your connection and try again.'); }
          return await new Promise(function (resolve, reject) {
            var done = false, mod;
            var ready = function () { if (!done && mod) { done = true; resolve(mod); } };
            try {
              mod = g.libheif({ wasmBinary: wasm, print: function () {}, printErr: function () {}, onRuntimeInitialized: function () { setTimeout(ready, 0); } });
              if (mod && mod.calledRun) ready();
            } catch (e) { reject(err('LOAD_FAILED', 'The HEIC decoder could not start in this browser.')); }
          });
        })();
        heif.catch(function () { heif = null; });
      }
      return heif;
    }

    // --- colour: ICC matrix/TRC profiles and nclx primaries to sRGB ---
    function s15(dv, o) { return dv.getInt32(o) / 65536; }
    function curveLut(dv, o) {
      var type = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      var lut = new Float32Array(256), i, x;
      if (type === 'curv') {
        var n = dv.getUint32(o + 8);
        if (n === 0) for (i = 0; i < 256; i++) lut[i] = i / 255;
        else if (n === 1) { var gm = dv.getUint16(o + 12) / 256; for (i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gm); }
        else {
          for (i = 0; i < 256; i++) {
            var pos = i / 255 * (n - 1), k = Math.floor(pos), f = pos - k;
            var a = dv.getUint16(o + 12 + 2 * k), b = dv.getUint16(o + 12 + 2 * Math.min(n - 1, k + 1));
            lut[i] = (a + (b - a) * f) / 65535;
          }
        }
        return lut;
      }
      if (type === 'para') {
        var ft = dv.getUint16(o + 8), p = [];
        for (i = 0; i < 7; i++) p.push(o + 12 + 4 * i + 4 <= dv.byteLength ? s15(dv, o + 12 + 4 * i) : 0);
        for (i = 0; i < 256; i++) {
          x = i / 255;
          var G = p[0], A = p[1], B = p[2], C = p[3], D = p[4], E = p[5], F = p[6], y;
          if (ft === 0) y = Math.pow(x, G);
          else if (ft === 1) y = x >= -B / A ? Math.pow(A * x + B, G) : 0;
          else if (ft === 2) y = x >= -B / A ? Math.pow(A * x + B, G) + C : C;
          else if (ft === 3) y = x >= D ? Math.pow(A * x + B, G) : C * x;
          else if (ft === 4) y = x >= D ? Math.pow(A * x + B, G) + E : C * x + F;
          else return null;
          lut[i] = Math.min(1, Math.max(0, y));
        }
        return lut;
      }
      return null;
    }
    function srgbLut() {
      var lut = new Float32Array(256);
      for (var i = 0; i < 256; i++) { var x = i / 255; lut[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
      return lut;
    }
    function mul(a, b) {
      var r = [];
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
      return r;
    }
    function inv(m) {
      var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g2 = m[6], h = m[7], i = m[8];
      var A = e * i - f * h, B = -(d * i - f * g2), C = d * h - e * g2, det = a * A + b * B + c * C;
      return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g2) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g2) / det, (a * e - b * d) / det];
    }
    function fromPrimaries(xy) { // RGB->XYZ for chromaticities [rx,ry,gx,gy,bx,by,wx,wy]
      var cols = [];
      for (var i = 0; i < 3; i++) { var x = xy[2 * i], y = xy[2 * i + 1]; cols.push([x / y, 1, (1 - x - y) / y]); }
      var m = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
      var W = [xy[6] / xy[7], 1, (1 - xy[6] - xy[7]) / xy[7]], mi = inv(m);
      var S = [mi[0] * W[0] + mi[1] * W[1] + mi[2] * W[2], mi[3] * W[0] + mi[4] * W[1] + mi[5] * W[2], mi[6] * W[0] + mi[7] * W[1] + mi[8] * W[2]];
      return [m[0] * S[0], m[1] * S[1], m[2] * S[2], m[3] * S[0], m[4] * S[1], m[5] * S[2], m[6] * S[0], m[7] * S[1], m[8] * S[2]];
    }
    var SRGB_D50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
    var SRGB_XY = [0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290];
    function colourTransform(color) {
      if (!color) return null;
      var lin = srgbLut(), luts, M;
      if (color.icc && color.icc.length >= 132) {
        var icc = color.icc, dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
        var tag = function (i) { return String.fromCharCode(icc[i], icc[i + 1], icc[i + 2], icc[i + 3]); };
        if (tag(16) !== 'RGB ' || tag(20) !== 'XYZ ') return null;
        var tags = {}, n = dv.getUint32(128);
        for (var i = 0; i < n && 132 + 12 * i + 12 <= icc.length; i++) tags[tag(132 + 12 * i)] = dv.getUint32(136 + 12 * i);
        if (!(tags.rXYZ && tags.gXYZ && tags.bXYZ && tags.rTRC && tags.gTRC && tags.bTRC)) return null;
        var xyz = function (o) { return [s15(dv, o + 8), s15(dv, o + 12), s15(dv, o + 16)]; };
        var r = xyz(tags.rXYZ), gg = xyz(tags.gXYZ), b = xyz(tags.bXYZ);
        M = mul(inv(SRGB_D50), [r[0], gg[0], b[0], r[1], gg[1], b[1], r[2], gg[2], b[2]]);
        luts = [curveLut(dv, tags.rTRC), curveLut(dv, tags.gTRC), curveLut(dv, tags.bTRC)];
        if (!luts[0] || !luts[1] || !luts[2]) return null;
      } else if (color.nclx) {
        var P = { 9: [0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290], 12: [0.680, 0.320, 0.265, 0.690, 0.150, 0.060, 0.3127, 0.3290] }[color.nclx.p];
        if (!P) return null;
        M = mul(inv(fromPrimaries(SRGB_XY)), fromPrimaries(P));
        var curve = color.nclx.t === 8 ? (function () { var l = new Float32Array(256); for (var q = 0; q < 256; q++) l[q] = q / 255; return l; })() : lin;
        luts = [curve, curve, curve];
      } else return null;
      var same = true;
      for (var j = 0; j < 9; j++) if (Math.abs(M[j] - (j % 4 === 0 ? 1 : 0)) > 0.003) same = false;
      for (var c = 0; c < 3 && same; c++) for (var v = 0; v < 256; v++) if (Math.abs(luts[c][v] - lin[v]) > 0.004) { same = false; break; }
      if (same) return null;
      var OUT = new Uint8Array(16385);
      for (var k = 0; k <= 16384; k++) { var x = k / 16384; OUT[k] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); }
      return { M: M, luts: luts, OUT: OUT };
    }
    function applyColour(data, tf) {
      var M = tf.M, L0 = tf.luts[0], L1 = tf.luts[1], L2 = tf.luts[2], OUT = tf.OUT;
      var m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
      for (var i = 0, n = data.length; i < n; i += 4) {
        var r = L0[data[i]], g2 = L1[data[i + 1]], b = L2[data[i + 2]];
        var R = m0 * r + m1 * g2 + m2 * b, G = m3 * r + m4 * g2 + m5 * b, B = m6 * r + m7 * g2 + m8 * b;
        data[i] = OUT[R <= 0 ? 0 : R >= 1 ? 16384 : (R * 16384 + 0.5) | 0];
        data[i + 1] = OUT[G <= 0 ? 0 : G >= 1 ? 16384 : (G * 16384 + 0.5) | 0];
        data[i + 2] = OUT[B <= 0 ? 0 : B >= 1 ? 16384 : (B * 16384 + 0.5) | 0];
      }
    }
    function orientRGBA(src, w, h, o) {
      if (o < 2 || o > 8) return { data: src, w: w, h: h };
      var swap = o >= 5, W = swap ? h : w, H = swap ? w : h, out = new Uint8ClampedArray(src.length);
      var s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), d32 = new Uint32Array(out.buffer);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var X, Y;
          switch (o) {
            case 2: X = w - 1 - x; Y = y; break;
            case 3: X = w - 1 - x; Y = h - 1 - y; break;
            case 4: X = x; Y = h - 1 - y; break;
            case 5: X = y; Y = x; break;
            case 6: X = h - 1 - y; Y = x; break;
            case 7: X = h - 1 - y; Y = w - 1 - x; break;
            default: X = y; Y = w - 1 - x;
          }
          d32[Y * W + X] = s32[y * w + x];
        }
      }
      return { data: out, w: W, h: H };
    }

    async function decodeHeif(m) {
      var lib = await heifLib(m.base);
      var dec = new lib.HeifDecoder(), images = [];
      try {
        try { images = dec.decode(new Uint8Array(m.buffer)) || []; } catch (e) { images = []; }
        if (!images.length) throw err('CORRUPT');
        var pick = 0;
        for (var i = 0; i < images.length; i++) if (images[i].is_primary()) { pick = i; break; }
        var img = images[pick], w = img.get_width(), h = img.get_height();
        if (!(w > 0 && h > 0)) throw err('CORRUPT');
        if (w * h > m.maxPixels) throw Object.assign(err('TOO_BIG'), { w: w, h: h });
        var data = new Uint8ClampedArray(w * h * 4);
        var ok = await new Promise(function (resolve) { img.display({ data: data, width: w, height: h }, function (d) { resolve(!!d); }); });
        if (!ok) throw err('CORRUPT');
        var alpha = img.has_alpha_channel(), pre = alpha && img.is_premultiplied_alpha();
        if (pre) for (var p = 0; p < data.length; p += 4) { var a = data[p + 3]; if (a && a < 255) { data[p] = data[p] * 255 / a; data[p + 1] = data[p + 1] * 255 / a; data[p + 2] = data[p + 2] * 255 / a; } }
        return { w: w, h: h, data: data, alpha: alpha, images: images.length };
      } finally {
        images.forEach(function (im) { try { im.free(); } catch (e) { /* already freed */ } });
        try { if (dec.decoder) lib.heif_context_free(dec.decoder); } catch (e) { /* ignore */ }
        dec.decoder = null;
      }
    }

    // UTIF follows the links inside a TIFF without checking them: a page chain
    // that loops back, or a tag claiming billions of values, makes it loop
    // forever or run out of memory (which takes the whole tab down in Chrome).
    // Walk the structure first and, in this private copy of the file, end a
    // looping chain and empty any tag whose values lie outside the file.
    function tiffSanitize(u8) {
      var n = u8.length, le = u8[0] === 0x49, dv = new DataView(u8.buffer, u8.byteOffset, n);
      var r16 = function (o) { return dv.getUint16(o, le); }, r32 = function (o) { return dv.getUint32(o, le); };
      var SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4], seen = new Set(), budget = 100000;
      var SUB = { 330: 1, 34665: 1, 34853: 1 }; // the sub-IFDs UTIF reads: SubIFDs, EXIF, GPS
      function drop(p) { dv.setUint32(p + 4, 0, le); }
      function readable(off) { return off >= 8 && off + 2 <= n && off + 2 + 12 * r16(off) <= n && !seen.has(off); }
      function walk(off, depth) {
        seen.add(off);
        var cnt = r16(off);
        if ((budget -= cnt) < 0) throw err('CORRUPT');
        for (var i = 0; i < cnt; i++) {
          var p = off + 2 + 12 * i, tag = r16(p), type = r16(p + 2), count = r32(p + 4);
          var size = (SIZE[type] || 0) * count, at = size > 4 ? r32(p + 8) : p + 8;
          // Private blocks UTIF would parse as more IFDs (DNG, Fujifilm): not needed.
          if (tag === 50740 || tag === 61440 || (size && at + size > n)) { drop(p); continue; }
          if (SUB[tag] && (type === 4 || type === 13) && count) {
            for (var k = 0; k < count; k++) {
              var so = r32(at + 4 * k);
              if (depth >= 3 || !readable(so)) { drop(p); break; }
              walk(so, depth + 1);
            }
          }
        }
      }
      var pos = 4, off = r32(4), pages = 0;
      while (off) {
        if (pages >= 2000 || !readable(off)) {
          if (!pages) throw err('CORRUPT');
          if (pos + 4 <= n) dv.setUint32(pos, 0, le);
          break;
        }
        walk(off, 0);
        pages++;
        pos = off + 2 + 12 * r16(off);
        off = pos + 4 <= n ? r32(pos) : 0;
      }
    }

    function decodeTiff(m) {
      if (!utifLoaded) {
        try { g.importScripts(m.base + 'pako/pako_inflate.min.js', m.base + 'utif/UTIF.min.js'); } catch (e) { throw err('LOAD_FAILED', 'The TIFF decoder could not be loaded. Check your connection and try again.'); }
        utifLoaded = true;
      }
      var U = g.UTIF, buf = m.buffer, ifds;
      if (buf.byteLength < 16) throw err('CORRUPT');
      if (new Uint8Array(buf, 2, 1)[0] === 43 || new Uint8Array(buf, 3, 1)[0] === 43) throw err('UNSUPPORTED', 'BigTIFF files are not supported.');
      tiffSanitize(new Uint8Array(buf));
      try { ifds = U.decode(buf, { parseMN: false, debug: false }); } catch (e) { throw err('CORRUPT'); }
      var pages = (ifds || []).filter(function (f) { return f.t256 && f.t257 && !((f.t254 ? f.t254[0] : 0) & 1); });
      if (!pages.length) throw err('CORRUPT');
      var ifd = pages[0], w = ifd.t256[0], h = ifd.t257[0];
      if (w * h > m.maxPixels) throw Object.assign(err('TOO_BIG'), { w: w, h: h });
      // More than 128 bits per pixel (four 32-bit channels) is not a real image and would need huge buffers.
      var bits = (ifd.t258 ? ifd.t258[0] : 1) * (ifd.t277 ? ifd.t277[0] : 1);
      if (!(bits > 0 && bits <= 128)) throw err('CORRUPT', 'This kind of TIFF (compression or colour model) is not supported.');
      var rgba;
      try { U.decodeImage(buf, ifd, ifds); rgba = U.toRGBA8(ifd); } catch (e) { throw err('CORRUPT'); }
      w = ifd.width; h = ifd.height;
      if (!rgba || rgba.length < w * h * 4 || !w || !h) throw err('CORRUPT', 'This kind of TIFF (compression or colour model) is not supported.');
      var data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4);
      var spp = ifd.t277 ? ifd.t277[0] : 1, photo = ifd.t262 ? ifd.t262[0] : 1;
      var alpha = !!ifd.t338 || (photo === 2 && spp >= 4) || ((photo === 0 || photo === 1) && spp >= 2);
      var o = ifd.t274 ? ifd.t274[0] : 1, r = orientRGBA(data, w, h, o);
      var icc = ifd.t34675 ? new Uint8Array(ifd.t34675) : null;
      return { w: r.w, h: r.h, data: r.data, alpha: alpha, images: pages.length, orientation: o, icc: icc };
    }

    // Decoded images stay in the worker, keyed by the page's handle, so their
    // pixels never cross threads: moving a 12-megapixel bitmap to or from the
    // page blocks it for 150 ms or more.
    var store = new Map();
    function keep(key, bmp) {
      var old = store.get(key);
      if (old && old !== bmp && old.close) old.close();
      store.set(key, bmp);
    }
    function image(m) {
      var b = m.key != null ? store.get(m.key) : m.bitmap;
      if (!b) throw err('GONE');
      return b;
    }
    function canvasOk() {
      try { return typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch (e) { return false; }
    }
    async function nativeDecode(file) {
      if (typeof g.createImageBitmap !== 'function') return null;
      try { return await g.createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* try without options */ }
      try { return await g.createImageBitmap(file); } catch (e) { return null; }
    }

    async function handle(m) {
      if (m.cmd === 'native') {
        var nb = await nativeDecode(m.file);
        if (!nb) return { ok: false, code: 'NATIVE_FAILED' };
        if (nb.width * nb.height > m.maxPixels) { var big = { ok: false, code: 'TOO_BIG', w: nb.width, h: nb.height }; nb.close(); return big; }
        keep(m.key, nb);
        return { ok: true, w: nb.width, h: nb.height };
      }
      if (m.cmd === 'put') { keep(m.key, m.bitmap); return { ok: true }; }
      if (m.cmd === 'free') {
        var fb = store.get(m.key);
        if (fb && fb.close) fb.close();
        store.delete(m.key);
        return { ok: true };
      }
      if (m.cmd === 'get') {
        var copy = await g.createImageBitmap(image(m));
        return { ok: true, bitmap: copy, transfer: [copy] };
      }
      if (m.cmd === 'alpha' || m.cmd === 'encode' || m.cmd === 'orient') {
        if (!canvasOk()) return { ok: false, code: 'NO_CANVAS' };
        var src = image(m);
        try {
          if (m.cmd === 'alpha') return { ok: true, alpha: ops.alpha(src) };
          if (m.cmd === 'orient') {
            var oc = ops.orient(src, m.orientation), ob = await g.createImageBitmap(oc);
            oc.width = 0;
            keep(m.key, ob);
            return { ok: true, w: ob.width, h: ob.height };
          }
          var bytes = await ops.encode(src, m);
          return { ok: true, buffer: bytes.buffer, transfer: [bytes.buffer] };
        } finally {
          if (m.key == null && m.bitmap && m.bitmap.close) m.bitmap.close();
        }
      }
      // HEIC (libheif) or TIFF (UTIF)
      var r = m.cmd === 'heif' ? await decodeHeif(m) : decodeTiff(m);
      var color = m.cmd === 'heif' ? m.color : (r.icc ? { icc: r.icc } : null);
      var tf = null;
      try { tf = colourTransform(color); } catch (x) { tf = null; }
      if (tf) applyColour(r.data, tf);
      var out = { ok: true, w: r.w, h: r.h, alpha: r.alpha, images: r.images, orientation: r.orientation || 1, converted: !!tf };
      var bitmap = null;
      if (typeof g.createImageBitmap === 'function' && typeof ImageData === 'function') {
        try { bitmap = await g.createImageBitmap(new ImageData(r.data, r.w, r.h)); } catch (x) { bitmap = null; }
      }
      if (bitmap && m.key != null && canvasOk()) { keep(m.key, bitmap); out.kept = true; }
      else if (bitmap) { out.bitmap = bitmap; out.transfer = [bitmap]; }
      else { out.data = r.data; out.transfer = [r.data.buffer]; }
      return out;
    }

    g.onmessage = async function (e) {
      var m = e.data, res;
      try {
        res = await handle(m);
      } catch (x) {
        var fatal = x instanceof WebAssembly.RuntimeError || /memory|abort/i.test(String(x && x.message));
        res = { ok: false, code: fatal ? 'TOO_BIG_MEM' : (x && x.code) || 'CORRUPT', message: (x && x.friendly) || '', w: x && x.w, h: x && x.h, fatal: fatal };
      }
      var transfer = res.transfer || [];
      delete res.transfer;
      res.id = m.id;
      g.postMessage(res, transfer);
    };
  }

  var pool = [], jobId = 0, keySeq = 0;
  var MAX_WORKERS = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
  var workerUrl = null;
  function newWorker() {
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob(['(' + workerMain + ')(self, ' + pixelOps + ');'], { type: 'text/javascript' }));
    var w = { worker: new Worker(workerUrl), pending: new Map(), dead: false };
    var die = function () {
      w.dead = true;
      w.pending.forEach(function (p) { clearTimeout(p.timer); p.reject(fail('CORRUPT', 'The background worker stopped unexpectedly, probably because the image needs more memory than the browser allows.')); });
      w.pending.clear();
      try { w.worker.terminate(); } catch (e) { /* gone */ }
      pool = pool.filter(function (x) { return x !== w; });
    };
    w.worker.onmessage = function (e) {
      var p = w.pending.get(e.data.id);
      if (!p) return;
      w.pending.delete(e.data.id);
      clearTimeout(p.timer);
      p.resolve(e.data);
      if (e.data.fatal) die();
    };
    w.worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); die(); };
    w.die = die;
    pool.push(w);
    return w;
  }
  // The least busy worker, adding one while all are busy (up to MAX_WORKERS).
  function pickWorker() {
    var w = null;
    try {
      pool.forEach(function (x) { if (!w || x.pending.size < w.pending.size) w = x; });
      if (!w || (w.pending.size && pool.length < MAX_WORKERS)) w = newWorker();
    } catch (e) {
      throw fail('LOAD_FAILED', 'This browser blocked the background worker, so this file cannot be processed here.');
    }
    return w;
  }
  function runOn(w, msg, transfer) {
    if (w.dead) return Promise.reject(fail('CORRUPT', 'The background worker stopped unexpectedly, probably because the image needs more memory than the browser allows.'));
    return new Promise(function (resolve, reject) {
      msg.id = ++jobId;
      msg.base = VENDOR;
      var p = { resolve: resolve, reject: reject };
      p.timer = setTimeout(function () {
        if (!w.pending.has(msg.id)) return;
        w.pending.delete(msg.id);
        reject(fail('CORRUPT', 'Processing took too long and was stopped.'));
        w.die();
      }, 180000);
      w.pending.set(msg.id, p);
      w.worker.postMessage(msg, transfer || []);
    });
  }
  function runWorker(msg, transfer) {
    var w;
    try { w = pickWorker(); } catch (e) { return Promise.reject(e); }
    return runOn(w, msg, transfer);
  }

  // ---------- Canvas helpers ----------
  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  function context(c) {
    var g = c.getContext('2d');
    if (!g) throw fail('TOO_BIG', 'The image is too large for this browser to hold in memory.');
    return g;
  }
  // Canvases over a browser's size limit (Safari: 16.7 megapixels) stay blank instead of failing.
  function checkUsable(c, g) {
    var x = c.width - 1, y = c.height - 1;
    g.fillStyle = '#010203';
    g.fillRect(x, y, 1, 1);
    var p = g.getImageData(x, y, 1, 1).data;
    g.clearRect(x, y, 1, 1);
    if (p[3] !== 255) throw fail('TOO_BIG', 'The image (' + c.width + ' × ' + c.height + ' pixels) is larger than this browser can handle. Try a desktop browser.');
  }
  function toBlob(c, mime, q) {
    return new Promise(function (resolve) {
      try { c.toBlob(function (b) { resolve(b); }, mime, q); } catch (e) { resolve(null); }
    });
  }
  function sizeOf(src) {
    return [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height];
  }
  // ---------- Pixel work: resizing, filling, encoding, the alpha check ----------
  // Runs in the worker on an OffscreenCanvas, so a 12-megapixel photo never
  // blocks the page; the same code runs on the page where OffscreenCanvas is
  // missing. It is serialised into the worker: no outside variables.
  function pixelOps(make) {
    function err(code) { var e = new Error(code); e.code = code; return e; }
    function ctx(c, opts) { var g = c.getContext('2d', opts); if (!g) throw err('TOO_BIG'); return g; }
    function dims(src) { return [src.naturalWidth || src.width, src.naturalHeight || src.height]; }
    function pause() { return new Promise(function (r) { setTimeout(r, 0); }); }
    function blobOf(c, type, q) {
      if (c.convertToBlob) return c.convertToBlob({ type: type, quality: q });
      return new Promise(function (resolve) { c.toBlob(resolve, type, q); });
    }
    // Halve while the image is at least twice too big, then one smooth draw:
    // a single big step skips pixels in some browsers.
    function scaled(src, w, h, bg) {
      var d = dims(src), cur = src, cw = d[0], ch = d[1];
      while (cw >= w * 2 && ch >= h * 2) {
        cw = Math.max(w, Math.floor(cw / 2));
        ch = Math.max(h, Math.floor(ch / 2));
        var half = make(cw, ch), hg = ctx(half);
        hg.imageSmoothingEnabled = true;
        hg.imageSmoothingQuality = 'high';
        hg.drawImage(cur, 0, 0, cw, ch);
        if (cur !== src) cur.width = 0;
        cur = half;
      }
      var out = make(w, h), g = ctx(out);
      if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      if (cw === w && ch === h) g.drawImage(cur, 0, 0); else g.drawImage(cur, 0, 0, w, h);
      if (cur !== src) cur.width = 0;
      return out;
    }
    async function bmp(c, dpi) {
      var w = c.width, h = c.height, row = (w * 3 + 3) & ~3, size = 54 + row * h, ppm = Math.round((dpi || 96) / 0.0254);
      if (size > 0xFFFFFFFF) throw err('TOO_BIG');
      var out = new Uint8Array(size), dv = new DataView(out.buffer);
      out[0] = 0x42;
      out[1] = 0x4D;
      dv.setUint32(2, size, true);
      dv.setUint32(10, 54, true);
      dv.setUint32(14, 40, true);            // BITMAPINFOHEADER
      dv.setInt32(18, w, true);
      dv.setInt32(22, h, true);              // positive height: rows stored bottom-up
      dv.setUint16(26, 1, true);
      dv.setUint16(28, 24, true);
      dv.setUint32(34, row * h, true);
      dv.setInt32(38, ppm, true);            // pixels per metre (3780 = 96 dpi)
      dv.setInt32(42, ppm, true);
      var g = ctx(c, { willReadFrequently: true }), strip = Math.max(1, Math.floor(1048576 / w));
      for (var y0 = 0; y0 < h; y0 += strip) {
        var n = Math.min(strip, h - y0), d = g.getImageData(0, y0, w, n).data;
        for (var y = 0; y < n; y++) {
          var o = 54 + (h - 1 - (y0 + y)) * row, p = y * w * 4;
          for (var x = 0; x < w; x++, p += 4, o += 3) { out[o] = d[p + 2]; out[o + 1] = d[p + 1]; out[o + 2] = d[p]; }
        }
        if (y0 + strip < h) await pause();
      }
      return out;
    }
    // TIFF LZW (TIFF 6.0 section 13) as libtiff writes it: codes sent MSB first,
    // starting at 9 bits, one bit wider once the next free code passes the
    // current maximum, a Clear code when the table reaches 4094 entries.
    var lzwCode = null, lzwStamp = null, lzwGen = 0;
    function lzw(input) {
      if (!lzwCode) { lzwCode = new Int16Array(1 << 20); lzwStamp = new Uint16Array(1 << 20); }
      var n = input.length, out = new Uint8Array(Math.ceil(n * 1.5) + 16), op = 0, acc = 0, bits = 0, width = 9, next = 258;
      var put = function (code) {
        acc = (acc << width) | code;
        bits += width;
        while (bits >= 8) { bits -= 8; out[op++] = (acc >>> bits) & 255; }
        acc &= (1 << bits) - 1;
      };
      var reset = function () {
        next = 258;
        width = 9;
        if (++lzwGen > 65535) { lzwStamp.fill(0); lzwGen = 1; }
      };
      // After each code the decoder adds a table entry, so the encoder does too.
      var added = function () {
        if (++next === 4094) { put(256); reset(); } else if (next > (1 << width) - 1) width++;
      };
      reset();
      put(256);
      if (!n) { put(257); return out.slice(0, op + (bits ? 1 : 0)); }
      var prefix = input[0];
      for (var i = 1; i < n; i++) {
        var c = input[i], key = (prefix << 8) | c;
        if (lzwStamp[key] === lzwGen) { prefix = lzwCode[key]; continue; }
        put(prefix);
        lzwCode[key] = next;
        lzwStamp[key] = lzwGen;
        added();
        prefix = c;
      }
      put(prefix);
      added();
      put(257);
      if (bits) out[op++] = (acc << (8 - bits)) & 255;
      return out.slice(0, op);
    }
    // Baseline TIFF: 8-bit RGB, or RGBA with unassociated alpha when any pixel is
    // transparent; LZW with the horizontal predictor, in strips of about 128 KB.
    async function tiff(c, dpi) {
      var w = c.width, h = c.height, px = ctx(c, { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      var alpha = false, i, y, x;
      for (i = 3; i < px.length; i += 4) if (px[i] < 255) { alpha = true; break; }
      var spp = alpha ? 4 : 3, rowBytes = w * spp, rps = Math.max(1, Math.min(h, Math.floor(131072 / rowBytes)));
      var nStrips = Math.ceil(h / rps), strips = [];
      for (var s = 0; s < nStrips; s++) {
        var y0 = s * rps, rows = Math.min(rps, h - y0), raw = new Uint8Array(rows * rowBytes), o = 0;
        for (y = 0; y < rows; y++) {
          var start = o, p = (y0 + y) * w * 4;
          for (x = 0; x < w; x++, p += 4) {
            raw[o++] = px[p]; raw[o++] = px[p + 1]; raw[o++] = px[p + 2];
            if (alpha) raw[o++] = px[p + 3];
          }
          // Predictor 2: each sample minus the same sample of the pixel to its left.
          for (i = o - 1; i >= start + spp; i--) raw[i] = (raw[i] - raw[i - spp]) & 255;
        }
        strips.push(lzw(raw));
        if (s % 32 === 31) await pause();
      }
      var tags = [[256, 4, [w]], [257, 4, [h]], [258, 3, alpha ? [8, 8, 8, 8] : [8, 8, 8]], [259, 3, [5]], [262, 3, [2]],
        [273, 4, strips.map(function () { return 0; })], [277, 3, [spp]], [278, 4, [rps]], [279, 4, strips.map(function (b) { return b.length; })],
        [282, 5, [Math.round(dpi || 72), 1]], [283, 5, [Math.round(dpi || 72), 1]], [284, 3, [1]], [296, 3, [2]], [317, 3, [2]]];
      if (alpha) tags.push([338, 3, [2]]);
      var SZ = { 3: 2, 4: 4, 5: 4 }, ifdSize = 2 + 12 * tags.length + 4, extra = 8 + ifdSize;
      tags.forEach(function (t) { var len = SZ[t[1]] * t[2].length; t.at = len > 4 ? extra : -1; if (len > 4) extra += len + (len & 1); });
      var total = extra;
      strips.forEach(function (b) { total += b.length; });
      if (total > 0xFFFFFFFF) throw err('TOO_BIG');
      var out = new Uint8Array(total), dv = new DataView(out.buffer), off = extra;
      tags[5][2] = strips.map(function (b) { var at = off; off += b.length; return at; });
      out.set([0x49, 0x49, 42, 0]);
      dv.setUint32(4, 8, true);
      dv.setUint16(8, tags.length, true);
      tags.forEach(function (t, k) {
        var e = 10 + 12 * k, at = t.at >= 0 ? t.at : e + 8;
        dv.setUint16(e, t[0], true);
        dv.setUint16(e + 2, t[1], true);
        dv.setUint32(e + 4, t[1] === 5 ? t[2].length / 2 : t[2].length, true);
        if (t.at >= 0) dv.setUint32(e + 8, t.at, true);
        t[2].forEach(function (v, j) { if (t[1] === 3) dv.setUint16(at + 2 * j, v, true); else dv.setUint32(at + 4 * j, v, true); });
      });
      off = extra;
      strips.forEach(function (b) { out.set(b, off); off += b.length; });
      return out;
    }
    // GIF89a with one 256-entry colour table. Pictures with 256 colours or fewer
    // (255 when some pixels are transparent) keep them exactly; others get a
    // median-cut palette and Floyd-Steinberg dithering. GIF has no partial
    // transparency: pixels less than half opaque become fully transparent.
    async function gif(c) {
      var w = c.width, h = c.height, px = ctx(c, { willReadFrequently: true }).getImageData(0, 0, w, h).data, n = w * h, i, k;
      if (w > 65535 || h > 65535) throw err('TOO_BIG');
      var clear = false;
      for (i = 3; i < px.length; i += 4) if (px[i] < 128) { clear = true; break; }
      var max = clear ? 255 : 256, pal = [], idx = new Uint8Array(n), seen = new Map(), exact = true;
      for (i = 0; i < n && exact; i++) {
        if (px[4 * i + 3] < 128) continue;
        var key = (px[4 * i] << 16) | (px[4 * i + 1] << 8) | px[4 * i + 2], at = seen.get(key);
        if (at === undefined) {
          if (pal.length >= max) exact = false;
          else { at = pal.length; seen.set(key, at); pal.push([px[4 * i], px[4 * i + 1], px[4 * i + 2]]); }
        }
        idx[i] = at;
      }
      if (!exact) {
        pal = medianCut(px, max);
        await pause();
        dither(px, w, h, pal, idx);
      }
      var tIndex = pal.length;
      if (clear) for (i = 0; i < n; i++) if (px[4 * i + 3] < 128) idx[i] = tIndex;
      await pause();
      var data = gifLzw(idx), blocks = Math.ceil(data.length / 255);
      var out = new Uint8Array(13 + 768 + (clear ? 8 : 0) + 10 + 1 + data.length + blocks + 1 + 1), o = 0;
      var u16 = function (v) { out[o++] = v & 255; out[o++] = v >> 8; };
      'GIF89a'.split('').forEach(function (ch) { out[o++] = ch.charCodeAt(0); });
      u16(w); u16(h);
      out[o++] = 0xF7; out[o++] = 0; out[o++] = 0;   // global table of 256 colours
      for (k = 0; k < 256; k++) { var col = pal[k] || [0, 0, 0]; out[o++] = col[0]; out[o++] = col[1]; out[o++] = col[2]; }
      if (clear) { out.set([0x21, 0xF9, 4, 1, 0, 0, tIndex, 0], o); o += 8; }  // graphic control: transparent index
      out[o++] = 0x2C; u16(0); u16(0); u16(w); u16(h); out[o++] = 0;
      out[o++] = 8;                                    // LZW minimum code size
      for (k = 0; k < data.length; k += 255) {
        var len = Math.min(255, data.length - k);
        out[o++] = len;
        out.set(data.subarray(k, k + len), o);
        o += len;
      }
      out[o++] = 0;
      out[o++] = 0x3B;
      return out;
    }
    // Median cut on a 5-bit-per-channel histogram: split the box with the most
    // pixels times its widest side at its median, until there are enough boxes.
    function medianCut(px, max) {
      var count = new Uint32Array(32768), sum = new Float64Array(32768 * 3), i, b;
      for (i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) continue;
        b = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
        count[b]++; sum[3 * b] += px[i]; sum[3 * b + 1] += px[i + 1]; sum[3 * b + 2] += px[i + 2];
      }
      var bins = [];
      for (b = 0; b < 32768; b++) if (count[b]) bins.push(b);
      var ch = function (bin, c) { return (bin >> (10 - 5 * c)) & 31; };
      var box = function (list) {
        var lo = [31, 31, 31], hi = [0, 0, 0], total = 0;
        list.forEach(function (bin) { total += count[bin]; for (var c = 0; c < 3; c++) { var v = ch(bin, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; } });
        var axis = 0;
        for (var c = 1; c < 3; c++) if (hi[c] - lo[c] > hi[axis] - lo[axis]) axis = c;
        return { list: list, total: total, axis: axis, score: list.length > 1 ? total * (hi[axis] - lo[axis] + 1) : 0 };
      };
      var boxes = [box(bins)];
      while (boxes.length < max) {
        var best = 0;
        for (i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[best].score) best = i;
        var bx = boxes[best];
        if (!bx.score) break;
        var sorted = bx.list.slice().sort(function (p, q) { return ch(p, bx.axis) - ch(q, bx.axis); });
        var half = bx.total / 2, acc = 0, cut = 1;
        for (i = 0; i < sorted.length - 1; i++) { acc += count[sorted[i]]; if (acc >= half) { cut = i + 1; break; } cut = i + 1; }
        boxes.splice(best, 1, box(sorted.slice(0, cut)), box(sorted.slice(cut)));
      }
      return boxes.map(function (bx) {
        var r = 0, g2 = 0, bl = 0;
        bx.list.forEach(function (bin) { r += sum[3 * bin]; g2 += sum[3 * bin + 1]; bl += sum[3 * bin + 2]; });
        return [Math.round(r / bx.total), Math.round(g2 / bx.total), Math.round(bl / bx.total)];
      });
    }
    // Nearest palette colour for each pixel, spreading the error to its neighbours.
    function dither(px, w, h, pal, idx) {
      var cache = new Int16Array(32768).fill(-1), cur = new Float32Array((w + 2) * 3), nxt = new Float32Array((w + 2) * 3);
      var nearest = function (r, g2, b) {
        var key = ((r >> 3) << 10) | ((g2 >> 3) << 5) | (b >> 3);
        if (cache[key] >= 0) return cache[key];
        var bi = 0, bd = Infinity;
        for (var p = 0; p < pal.length; p++) {
          var dr = pal[p][0] - r, dg = pal[p][1] - g2, db = pal[p][2] - b, d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; bi = p; }
        }
        cache[key] = bi;
        return bi;
      };
      for (var y = 0; y < h; y++) {
        var tmp = cur; cur = nxt; nxt = tmp; nxt.fill(0);
        for (var x = 0; x < w; x++) {
          var i = y * w + x, q = 4 * i, e = 3 * (x + 1);
          if (px[q + 3] < 128) continue;
          var r = Math.min(255, Math.max(0, px[q] + cur[e])), g2 = Math.min(255, Math.max(0, px[q + 1] + cur[e + 1])), b = Math.min(255, Math.max(0, px[q + 2] + cur[e + 2]));
          var p2 = nearest(r | 0, g2 | 0, b | 0), col = pal[p2];
          idx[i] = p2;
          var er = r - col[0], eg = g2 - col[1], eb = b - col[2];
          cur[e + 3] += er * 7 / 16; cur[e + 4] += eg * 7 / 16; cur[e + 5] += eb * 7 / 16;
          nxt[e - 3] += er * 3 / 16; nxt[e - 2] += eg * 3 / 16; nxt[e - 1] += eb * 3 / 16;
          nxt[e] += er * 5 / 16; nxt[e + 1] += eg * 5 / 16; nxt[e + 2] += eb * 5 / 16;
          nxt[e + 3] += er / 16; nxt[e + 4] += eg / 16; nxt[e + 5] += eb / 16;
        }
      }
    }
    // GIF LZW: codes packed least significant bit first, 9 to 12 bits wide; the
    // code size grows just before the first table entry that needs the extra bit.
    function gifLzw(input) {
      if (!lzwCode) { lzwCode = new Int16Array(1 << 20); lzwStamp = new Uint16Array(1 << 20); }
      var out = new Uint8Array(Math.ceil(input.length * 1.5) + 16), op = 0, cur = 0, shift = 0, size = 9, next = 258;
      var fresh = function () {
        next = 258;
        size = 9;
        if (++lzwGen > 65535) { lzwStamp.fill(0); lzwGen = 1; }
      };
      var emit = function (code) {
        cur |= code << shift;
        shift += size;
        while (shift >= 8) { out[op++] = cur & 255; cur >>>= 8; shift -= 8; }
      };
      fresh();
      emit(256);
      var prefix = input[0];
      for (var i = 1; i < input.length; i++) {
        var k = input[i], key = (prefix << 8) | k;
        if (lzwStamp[key] === lzwGen) { prefix = lzwCode[key]; continue; }
        emit(prefix);
        if (next === 4096) { emit(256); fresh(); } else {
          if (next >= (1 << size)) size++;
          lzwCode[key] = next++;
          lzwStamp[key] = lzwGen;
        }
        prefix = k;
      }
      emit(prefix);
      emit(257);
      if (shift > 0) out[op++] = cur & 255;
      return out.slice(0, op);
    }
    // ICO: one PNG per size, the picture fitted and centred on a transparent square.
    async function ico(src, sizes) {
      var d = dims(src), pngs = [];
      for (var i = 0; i < sizes.length; i++) {
        var s = sizes[i], k = Math.min(s / d[0], s / d[1]);
        var dw = Math.max(1, Math.round(d[0] * k)), dh = Math.max(1, Math.round(d[1] * k));
        var fit = scaled(src, dw, dh), c = make(s, s);
        ctx(c).drawImage(fit, Math.floor((s - dw) / 2), Math.floor((s - dh) / 2));
        fit.width = 0;
        var b = await blobOf(c, 'image/png');
        c.width = 0;
        if (!b || !b.size) throw err('CORRUPT');
        pngs.push(new Uint8Array(await b.arrayBuffer()));
      }
      var total = 6 + 16 * sizes.length;
      pngs.forEach(function (x) { total += x.length; });
      var out = new Uint8Array(total), dv = new DataView(out.buffer), off = 6 + 16 * sizes.length;
      dv.setUint16(2, 1, true);
      dv.setUint16(4, sizes.length, true);
      sizes.forEach(function (sz, j) {
        var p = 6 + 16 * j;
        out[p] = out[p + 1] = sz >= 256 ? 0 : sz;
        dv.setUint16(p + 4, 1, true);         // colour planes
        dv.setUint16(p + 6, 32, true);        // bits per pixel
        dv.setUint32(p + 8, pngs[j].length, true);
        dv.setUint32(p + 12, off, true);
        out.set(pngs[j], off);
        off += pngs[j].length;
      });
      return out;
    }
    return {
      scaled: scaled,
      // EXIF orientation 2..8 applied to the pixels.
      orient: function (src, o) {
        var d = dims(src), w = d[0], h = d[1], swap = o >= 5, c = make(swap ? h : w, swap ? w : h), g = ctx(c);
        var T = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w] }[o];
        if (T) g.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
        g.drawImage(src, 0, 0);
        return c;
      },
      encode: async function (src, o) {
        if (o.fmt === 'ico') return ico(src, o.sizes);
        var c = scaled(src, o.width, o.height, o.background);
        try {
          if (o.fmt === 'bmp') return await bmp(c, o.dpi);
          if (o.fmt === 'tiff') return await tiff(c, o.dpi);
          if (o.fmt === 'gif') return await gif(c);
          // Raw RGBA (not premultiplied), for encoders that are not built into canvas.
          if (o.fmt === 'rgba') return new Uint8Array(ctx(c).getImageData(0, 0, c.width, c.height).data.buffer);
          var b = await blobOf(c, o.mime, o.quality);
          if (!b || !b.size) throw err('CORRUPT');
          if (b.type !== o.mime) throw err('NO_SUPPORT');
          return new Uint8Array(await b.arrayBuffer());
        } finally {
          c.width = 0;
        }
      },
      // Any transparent pixel? Checked on a copy of at most 4 megapixels.
      alpha: function (src) {
        var d = dims(src), k = d[0] * d[1] <= 4194304 ? 1 : Math.sqrt(4194304 / (d[0] * d[1]));
        var w = Math.max(1, Math.round(d[0] * k)), h = Math.max(1, Math.round(d[1] * k));
        var c = make(w, h), g = ctx(c, { willReadFrequently: true });
        g.drawImage(src, 0, 0, w, h);
        var px = g.getImageData(0, 0, w, h).data;
        c.width = 0;
        for (var i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
        return false;
      }
    };
  }
  var pageOps = pixelOps(newCanvas);
  var useWorker = (function () {
    try {
      return typeof Worker === 'function' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' &&
        typeof OffscreenCanvas.prototype.convertToBlob === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d');
    } catch (e) { return false; }
  })();
  function isBitmap(x) { return typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap; }
  function resize(src, w, h) { return pageOps.scaled(src && src.bitmap ? src.bitmap : src, Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); }

  // Pixel work on an image held by a worker (res._h), or on a canvas/bitmap on
  // the page: in a worker when possible (a transferred copy), else right here.
  async function pixelWork(cmd, src, job) {
    var h = src && src._h;
    if (h) {
      var gone = fail('GONE', 'The decoded image is no longer available. Add the file again.');
      if (h.w.dead) throw gone;
      var hr = await runOn(h.w, Object.assign({ cmd: cmd, key: h.key }, job));
      if (hr.ok) return hr;
      if (hr.code === 'GONE') throw gone;
      throw pixelError(hr.code, job);
    }
    if (useWorker) {
      var copy = null, r = null;
      try { copy = await createImageBitmap(src); } catch (e) { copy = null; }
      if (copy) {
        try {
          r = await runWorker(Object.assign({ cmd: cmd, bitmap: copy }, job), [copy]);
        } catch (e) {
          if (e.code !== 'LOAD_FAILED') throw e;
          r = { ok: false, code: 'NO_CANVAS' };
        }
        if (r.ok) return r;
        if (r.code !== 'NO_CANVAS') throw pixelError(r.code, job);
        useWorker = false;
      }
    }
    try {
      if (cmd === 'alpha') return { ok: true, alpha: pageOps.alpha(src) };
      return { ok: true, buffer: (await pageOps.encode(src, job)).buffer };
    } catch (e) {
      throw pixelError(e.code, job);
    }
  }
  function pixelError(code, job) {
    if (code === 'NO_SUPPORT') return fail('NO_SUPPORT', 'This browser cannot save ' + (FORMATS[job.fmt] || { label: 'these' }).label + ' images.');
    if (code === 'TOO_BIG' || code === 'TOO_BIG_MEM') return fail('TOO_BIG', 'The image is too large for this browser to process in memory. Try a smaller size.');
    return fail('CORRUPT', 'The browser could not encode the image. It may be too large.');
  }

  // ---------- Native decoding ----------
  function loadImg(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob), img = new Image();
      var done = function (ok) { setTimeout(function () { URL.revokeObjectURL(url); }, 0); resolve(ok && (img.naturalWidth || img.width) ? img : null); };
      img.onload = function () { if (img.decode) img.decode().then(function () { done(true); }, function () { done(true); }); else done(true); };
      img.onerror = function () { done(false); };
      img.src = url;
    });
  }
  async function nativeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* try below */ }
      try { return await createImageBitmap(blob); } catch (e) { /* try <img> */ }
    }
    return loadImg(blob);
  }
  function closeSrc(src) { if (src && src.close) src.close(); }

  // Does this browser apply the EXIF orientation of this format? Tested once with
  // a 2x1 image tagged "rotate 90°": the answer differs for PNG and WebP.
  var orientTests = {};
  function browserOrients(fmt) {
    if (!orientTests[fmt]) {
      orientTests[fmt] = (async function () {
        try {
          var c = newCanvas(2, 1), g = context(c);
          g.fillStyle = '#f00';
          g.fillRect(0, 0, 2, 1);
          var blob = await toBlob(c, FORMATS[fmt].mime, 1);
          if (!blob || blob.type !== FORMATS[fmt].mime) return true;
          var tagged = new Blob([withExif(new Uint8Array(await blob.arrayBuffer()), fmt, tinyExif(6), 2, 1)], { type: FORMATS[fmt].mime });
          if (useWorker) {
            var w = pickWorker(), key = ++keySeq, r = await runOn(w, { cmd: 'native', file: tagged, key: key, maxPixels: 100 });
            runOn(w, { cmd: 'free', key: key }).catch(function () {});
            return !r.ok || (r.w === 1 && r.h === 2);
          }
          var img = await nativeImage(tagged);
          if (!img) return true;
          var s = sizeOf(img);
          closeSrc(img);
          return s[0] === 1 && s[1] === 2;
        } catch (e) {
          return true;
        }
      })();
    }
    return orientTests[fmt];
  }

  function tooBig(w, h, max) {
    var mp = function (n) { return (n / 1e6).toFixed(n < 1e7 ? 1 : 0); };
    return fail('TOO_BIG', 'The image is ' + w + ' × ' + h + ' pixels (' + mp(w * h) + ' megapixels), over the ' + mp(max) + ' megapixel limit for converting in a browser.', { width: w, height: h });
  }

  // ---------- SVG ----------
  var UNITS = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8, ch: 8 };
  function svgLength(s) {
    if (s == null) return null;
    var m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(s);
    if (!m) return null;
    var unit = m[2].toLowerCase();
    if (unit === '%') return { percent: parseFloat(m[1]) };
    if (!(unit in UNITS) && unit !== '') return null;
    var v = parseFloat(m[1]) * (UNITS[unit] || 1);
    return v > 0 && isFinite(v) ? { px: v, unit: unit || 'px' } : null;
  }
  var ENTITIES = { nbsp: 160, copy: 169, reg: 174, trade: 8482, mdash: 8212, ndash: 8211, hellip: 8230, laquo: 171, raquo: 187, deg: 176, times: 215, middot: 183, bull: 8226, euro: 8364 };
  function svgFix(text) {
    var notes = [];
    text = String(text).replace(/^﻿/, '');
    var start = /<svg\b[^>]*>/i.exec(text);
    if (start) {
      var tag = start[0], fixed = tag;
      if (!/\sxmlns\s*=/.test(tag)) { fixed = fixed.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"'); notes.push('Added the missing xmlns="http://www.w3.org/2000/svg" attribute, which standalone SVG files need.'); }
      if (/\bxlink:/.test(text) && !/\sxmlns:xlink\s*=/.test(tag)) fixed = fixed.replace(/^<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
      if (fixed !== tag) text = text.slice(0, start.index) + fixed + text.slice(start.index + tag.length);
    }
    var html = false;
    text = text.replace(/&([a-z]+);/gi, function (all, name) {
      if (/^(amp|lt|gt|quot|apos)$/.test(name)) return all;
      var code = ENTITIES[name.toLowerCase()];
      if (code) { html = true; return '&#' + code + ';'; }
      return all;
    });
    if (html) notes.push('Replaced HTML entities such as &nbsp; with their XML character codes.');
    return { text: text, notes: notes };
  }
  function svgInfo(input) {
    var fix = svgFix(input), text = fix.text;
    if (!/\S/.test(text)) return { error: 'Paste SVG code or open an .svg file.' };
    var doc;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch (e) { doc = null; }
    var perr = doc && doc.getElementsByTagName('parsererror')[0];
    if (!doc || perr) {
      var msg = perr ? (perr.textContent || '').replace(/\s+/g, ' ').replace(/^.*?error on /i, 'Error on ').replace(/Below is a rendering.*$/i, '').trim() : '';
      return { error: 'This is not valid SVG (XML) code' + (msg ? ': ' + msg.slice(0, 160) : '.') };
    }
    var root = doc.documentElement;
    if (!root || root.localName !== 'svg') return { error: 'The code has no <svg> element at the top level.' };
    var notes = fix.notes.slice();
    var vb = null, vbm = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vbm.length === 4 && vbm.every(isFinite) && vbm[2] > 0 && vbm[3] > 0) vb = vbm;
    var wa = root.getAttribute('width'), ha = root.getAttribute('height');
    var W = svgLength(wa), H = svgLength(ha), w = W && W.px, h = H && H.px, from;
    if (W && W.percent != null) notes.push('Width is ' + wa.trim() + ', a percentage of a page that an image does not have, so it is ignored.');
    if (H && H.percent != null) notes.push('Height is ' + ha.trim() + ', a percentage, so it is ignored.');
    if ((wa && !W) || (ha && !H)) notes.push('A width or height value could not be read (' + [wa, ha].filter(Boolean).join(', ') + ').');
    [W, H].forEach(function (L) { if (L && /^(em|rem|ex|ch)$/.test(L.unit)) notes.push('Font-relative units (' + L.unit + ') are converted at the default 16 px font size.'); });
    if (w && h) from = 'width and height';
    else if (w && vb) { h = w * vb[3] / vb[2]; from = 'width and the viewBox ratio'; }
    else if (h && vb) { w = h * vb[2] / vb[3]; from = 'height and the viewBox ratio'; }
    else if (vb) { w = vb[2]; h = vb[3]; from = 'viewBox'; }
    else { w = w || 300; h = h || 150; from = 'default'; notes.push('No viewBox and no complete width and height, so a missing side uses the browser default of 300 × 150.'); }
    notes = notes.filter(function (n, i) { return notes.indexOf(n) === i; });
    var external = 0, scripts = doc.getElementsByTagName('script').length, all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i], href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href && !/^\s*(#|data:)/i.test(href) && /^(image|use|feImage|script)$/.test(el.localName)) external++;
      for (var j = 0; j < el.attributes.length; j++) if (/^on/i.test(el.attributes[j].name)) scripts++;
    }
    var css = Array.prototype.map.call(doc.getElementsByTagName('style'), function (s) { return s.textContent; }).join('\n');
    var urls = (css.match(/url\(\s*['"]?\s*(?!data:|#)[^)'"\s]+/gi) || []).length + (css.match(/@import\s*['"]/gi) || []).length;
    return {
      width: w, height: h, from: from, viewBox: vb, widthAttr: wa, heightAttr: ha,
      notes: notes, external: external + urls, scripts: scripts, text: text,
      hasText: doc.getElementsByTagName('text').length > 0,
      foreignObject: doc.getElementsByTagName('foreignObject').length
    };
  }
  async function svgRender(input, w, h) {
    var info = svgInfo(input);
    if (info.error) throw fail('SVG_INVALID', info.error);
    w = Math.max(1, Math.round(w || info.width));
    h = Math.max(1, Math.round(h || info.height));
    var doc = new DOMParser().parseFromString(info.text, 'image/svg+xml'), root = doc.documentElement;
    // Linked files never load in an SVG drawn as an image, and Chrome would draw
    // a broken-image icon in their place: leave them out instead.
    var all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (!/^(image|feImage|use)$/.test(all[i].localName)) continue;
      ['href', 'xlink:href'].forEach(function (a) {
        var v = all[i].getAttribute(a);
        if (v && !/^\s*(#|data:)/i.test(v)) all[i].removeAttribute(a);
      });
    }
    if (!info.viewBox) root.setAttribute('viewBox', '0 0 ' + info.width + ' ' + info.height);
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    var draw = async function () {
      var img = await loadImg(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }));
      if (!img) throw fail('SVG_INVALID', 'The browser could not draw this SVG.');
      // A one-pixel test drawing: would this picture lock the canvas against export?
      var probe = newCanvas(1, 1), pg = context(probe);
      pg.drawImage(img, 0, 0, 1, 1);
      try { pg.getImageData(0, 0, 1, 1); } catch (e) { return null; } finally { probe.width = 0; }
      var cv = newCanvas(w, h), cg = context(cv);
      checkUsable(cv, cg);
      cg.drawImage(img, 0, 0, w, h);
      return cv;
    };
    var c = await draw();
    if (!c) {
      // Chrome (and other browsers that do the same) refuses to export a canvas once
      // HTML inside <foreignObject> has been drawn on it. Draw the SVG again without that HTML.
      var fo = doc.getElementsByTagName('foreignObject');
      while (fo.length) fo[0].parentNode.removeChild(fo[0]);
      c = await draw();
      if (!c) throw fail('SVG_INVALID', 'This browser does not allow this SVG to be converted to an image.');
      c.dataset.omitted = 'foreignObject';
    }
    return c;
  }

  // ---------- Decode ----------
  async function decode(file, options) {
    var o = options || {};
    var maxPixels = o.maxPixels || DEFAULT_MAX, lazy = o.canvas === false;
    if (!(file instanceof Blob)) throw fail('UNSUPPORTED', 'No file given.');
    if (!file.size) throw fail('EMPTY', 'The file is empty (0 bytes).');
    var head = await readRange(file, 0, 262144);
    var fmt = sniffBytes(head);
    if (!fmt) throw fail('UNSUPPORTED', notImage(head));
    var res = { format: fmt, orientation: 1, exif: null, animated: false, frames: null, images: 1, colorProfile: null, decoder: 'browser', warnings: [] };
    var dims = headerSize(head, fmt), src = null, canvas = null, h = null, inWorker = false, W = 0, H = 0, i;
    if (dims && dims[0] * dims[1] > maxPixels) throw tooBig(dims[0], dims[1], maxPixels);
    var worker = function () {
      try { return { w: pickWorker(), key: ++keySeq }; } catch (e) { useWorker = false; return null; }
    };
    if (useWorker && fmt !== 'svg') h = worker();
    var cleanup = function () {
      if (h && !h.w.dead) runOn(h.w, { cmd: 'free', key: h.key }).catch(function () {});
      closeSrc(src);
    };

    try {
      if (fmt === 'svg') {
        var text = await file.text(), info = svgInfo(text);
        if (info.error) throw fail('SVG_INVALID', info.error);
        var sw = Math.round(info.width), sh = Math.round(info.height);
        if (sw * sh > maxPixels) throw tooBig(sw, sh, maxPixels);
        src = await svgRender(text, sw, sh);
        if (src.dataset.omitted) res.warnings.push(src.dataset.omitted);
        res.decoder = 'svg';
        if (useWorker) h = worker();
      } else {
        // Byte-level checks and metadata first.
        // Browsers draw a cut-off PNG or WebP with the missing part blank, without an error.
        // Some apps add bytes after a PNG's IEND chunk, so look for it near the end.
        if (fmt === 'png' && !hasIend(await readRange(file, Math.max(0, file.size - 65536), file.size))) {
          // Refused when it ends before any real amount of image data (a first
          // IDAT chunk that is complete, or at least 4 KB of it).
          var idat = null;
          pngChunks(head, function (t, st, len) { if (t === 'IDAT') { idat = st + len <= file.size || file.size - st >= 4096; return false; } });
          if (idat === false || (idat === null && head.length >= file.size)) throw fail('CORRUPT', 'The PNG file is incomplete: it ends before its image data, so there is nothing to convert.');
          res.warnings.push('truncated');
        }
        if (fmt === 'webp' && u32le(head, 4) + 8 > file.size) res.warnings.push('truncated');
        var exif = null;
        try {
          if (fmt === 'jpeg') exif = jpegExif(head);
          else if (fmt === 'png') pngChunks(head, function (t, st, len) { if (t === 'eXIf') { exif = exifStart(head.slice(st, st + len)); return false; } if (t === 'IDAT') return false; });
          else if (fmt === 'webp') await webpChunks(file, async function (t, st, len) { if (t === 'EXIF') { exif = exifStart(await readRange(file, st, st + len)); return false; } });
        } catch (e) { exif = null; }
        if (exif) res.orientation = exifOrientation(exif);
        if (o.exif) res.exif = exif;
        if (fmt === 'gif') {
          res.frames = gifFrames(file.size <= 64e6 ? new Uint8Array(await file.arrayBuffer()) : head);
          res.animated = res.frames > 1;
        } else if (fmt === 'png') {
          pngChunks(head, function (t, st) { if (t === 'acTL') { res.frames = u32be(head, st); res.animated = res.frames > 1; return false; } if (t === 'IDAT') return false; });
        } else if (fmt === 'webp') {
          res.animated = ascii(head, 12, 4) === 'VP8X' && !!(head[20] & 0x02);
        } else if (fmt === 'avif') {
          res.animated = brands(head).indexOf('avis') >= 0;
        }
        if (fmt === 'jpeg') res.hasAlpha = false;
        // HEIF container facts (EXIF, image count, colour profile), whichever decoder runs.
        var bytes = null, box = null;
        if (fmt === 'heic' || fmt === 'tiff') bytes = new Uint8Array(await file.arrayBuffer());
        if (fmt === 'heic') {
          box = parseHeif(bytes);
          res.images = box.count || 1;
          if (o.exif && box.exif) res.exif = box.exif;
          if (box.width && box.height && box.width * box.height > maxPixels) throw tooBig(box.width, box.height, maxPixels);
        }

        // The browser's own decoder (Safari also reads HEIC and TIFF), in the worker if there is one.
        if (h) {
          var nr = await runOn(h.w, { cmd: 'native', file: file, key: h.key, maxPixels: maxPixels });
          if (nr.ok) { inWorker = true; W = nr.w; H = nr.h; } else if (nr.code === 'TOO_BIG') throw tooBig(nr.w, nr.h, maxPixels);
          // The page's decoder also draws damaged files partially (with a warning above).
          else if (fmt !== 'heic' && fmt !== 'tiff') src = await nativeImage(file);
        } else if (fmt !== 'heic' && fmt !== 'tiff') {
          src = await nativeImage(file);
        } else {
          src = await nativeImage(file).catch(function () { return null; });
        }

        if (!inWorker && !src && (fmt === 'heic' || fmt === 'tiff')) {
          if (box && !box.meta) throw fail('UNSUPPORTED', 'This HEIF file holds an image sequence or video without a still picture, which this converter cannot read.');
          var msg = { cmd: fmt === 'heic' ? 'heif' : 'tiff', buffer: bytes.buffer, maxPixels: maxPixels, color: box ? { icc: box.icc, nclx: box.nclx } : null, key: h ? h.key : null };
          var r = await (h ? runOn(h.w, msg, [bytes.buffer]) : runWorker(msg, [bytes.buffer]));
          if (!r.ok) {
            if (r.code === 'TOO_BIG' && r.w) throw tooBig(r.w, r.h, maxPixels);
            if (r.code === 'TOO_BIG_MEM') throw fail('TOO_BIG', 'The image needs more memory than this browser allows. Try a desktop browser.');
            if (r.code === 'LOAD_FAILED' || r.code === 'UNSUPPORTED') throw fail(r.code, r.message);
            if (box && box.truncated) throw fail('CORRUPT', 'The HEIC file is incomplete: it ends before all of its image data. Copy or download it again.');
            throw fail('CORRUPT', r.message || 'The ' + FORMATS[fmt].label + ' file could not be decoded. It may be damaged, incomplete or use a feature this decoder does not support.');
          }
          res.decoder = fmt === 'heic' ? 'libheif' : 'utif';
          // HDR (PQ or HLG transfer): the decoder gives the raw values, without tone mapping.
          if (box && box.nclx && (box.nclx.t === 16 || box.nclx.t === 18)) res.warnings.push('hdr');
          res.images = r.images || res.images;
          if (fmt === 'tiff') res.orientation = r.orientation;
          if (r.converted) res.colorProfile = 'converted';
          if (r.kept) { inWorker = true; W = r.w; H = r.h; } else if (r.bitmap) src = r.bitmap;
          else {
            src = newCanvas(r.w, r.h);
            context(src).putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
          }
          res.hasAlpha = r.alpha ? null : false;
        } else if (fmt === 'avif' && o.exif && file.size < 64e6) {
          try { res.exif = parseHeif(new Uint8Array(await file.arrayBuffer())).exif || null; } catch (e) { res.exif = null; }
        }
        if (!inWorker && !src) {
          if (fmt === 'avif') throw fail('NO_SUPPORT', 'This browser cannot open AVIF images. Chrome, Edge, Firefox and Safari 16.4 or later can.');
          if (fmt === 'jxl') throw fail('NO_SUPPORT', 'This browser cannot open JPEG XL images. Safari 17 or later can.');
          throw fail('CORRUPT', 'The ' + FORMATS[fmt].label + ' file could not be decoded. It may be damaged or incomplete.');
        }

        // EXIF orientation of JPEG, PNG and WebP, where this browser's decoder ignores it.
        if ((fmt === 'jpeg' || fmt === 'png' || fmt === 'webp') && res.orientation > 1 && !(await browserOrients(fmt))) {
          if (inWorker) {
            var or = await runOn(h.w, { cmd: 'orient', key: h.key, orientation: res.orientation });
            if (or.ok) { W = or.w; H = or.h; }
          } else {
            var turned = pageOps.orient(src, res.orientation);
            closeSrc(src);
            src = turned;
          }
        }
      }

      // Pixels now sit in the worker (inWorker) or in src on the page.
      if (!inWorker) {
        var sz = sizeOf(src);
        W = sz[0];
        H = sz[1];
      }
      if (!W || !H) throw fail('CORRUPT', 'The image has no pixels.');
      if (W * H > maxPixels) throw tooBig(W, H, maxPixels);
      if (!inWorker && h) {
        // Hand page-side pixels (SVG, fallbacks) to the worker once.
        if (!lazy) canvas = src.getContext ? src : drawCanvas(src, W, H);
        var bm = isBitmap(src) ? src : await toBitmap(src, W, H);
        await runOn(h.w, { cmd: 'put', key: h.key, bitmap: bm }, [bm]);
        if (src !== canvas) closeSrc(src);
        src = null;
        inWorker = true;
      }
    } catch (e) {
      cleanup();
      if (e && e.friendly) throw e;
      throw fail('CORRUPT', 'The ' + FORMATS[fmt].label + ' file could not be decoded. It may be damaged or use a feature this browser does not support.');
    }

    res.width = W;
    res.height = H;
    var bitmap = null;
    if (!inWorker) {
      canvas = src.getContext ? src : null;
      bitmap = isBitmap(src) ? src : null;
      if (!bitmap && typeof createImageBitmap === 'function') {
        try { bitmap = await createImageBitmap(src); } catch (e) { bitmap = null; }
      }
      if (!bitmap && !canvas) canvas = drawCanvas(src, W, H);
      res.bitmap = bitmap;
    }
    for (i in res) if (res[i] === undefined) delete res[i];
    Object.defineProperty(res, '_h', { configurable: true, value: inWorker ? h : null });
    Object.defineProperty(res, '_release', {
      configurable: true,
      value: function () {
        if (res._h && !res._h.w.dead) runOn(res._h.w, { cmd: 'free', key: res._h.key }).catch(function () {});
        if (bitmap && bitmap.close) bitmap.close();
        if (canvas) canvas.width = 0;
        bitmap = canvas = null;
        res.bitmap = null;
        Object.defineProperty(res, '_h', { configurable: true, value: null });
      }
    });
    // Not enumerable, so copying or logging the result never draws it by accident.
    Object.defineProperty(res, 'canvas', {
      configurable: true,
      get: function () {
        if (!canvas && bitmap) canvas = drawCanvas(bitmap, W, H);
        if (!canvas) throw new Error('This image was decoded with { canvas: false }, so its pixels stay in a worker. Use TTImage.encode(result) or await TTImage.toCanvas(result).');
        return canvas;
      }
    });
    Object.defineProperty(res, '_setCanvas', { configurable: true, value: function (c) { canvas = c; } });
    if (res.hasAlpha !== false) {
      try { res.hasAlpha = (await pixelWork('alpha', inWorker ? res : (bitmap || canvas), { fmt: 'png' })).alpha; } catch (e) { res.hasAlpha = true; }
    }
    if (inWorker && !lazy && !canvas) canvas = await toCanvas(res);
    return res;
  }
  // An ImageBitmap of any drawable; a partly loaded <img> needs a canvas in between.
  async function toBitmap(src, w, h) {
    try { return await createImageBitmap(src); } catch (e) { /* draw it first */ }
    var c = drawCanvas(src, w, h);
    try { return await createImageBitmap(c); } finally { c.width = 0; }
  }
  function drawCanvas(src, w, h) {
    var c = newCanvas(w, h), g = context(c);
    checkUsable(c, g);
    g.drawImage(src, 0, 0);
    return c;
  }
  // The pixels as a canvas on the page (fetched from the worker if they are there).
  async function toCanvas(res) {
    if (!res) throw fail('CORRUPT', 'There is no image.');
    var d = Object.getOwnPropertyDescriptor(res, 'canvas');
    if (!res._h) return d && d.get ? res.canvas : res;
    var r = await runOn(res._h.w, { cmd: 'get', key: res._h.key });
    if (!r.ok) throw fail('CORRUPT', 'This image was already released. Open the file again.');
    var c = drawCanvas(r.bitmap, res.width, res.height);
    r.bitmap.close();
    if (res._setCanvas) res._setCanvas(c);
    return c;
  }
  // Frees the memory held by a decode() result.
  function release(res) {
    if (res && res._release) res._release();
  }
  function gifFrames(b) {
    try {
      var p = 13, frames = 0;
      if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
      while (p < b.length) {
        var c = b[p];
        if (c === 0x3B) break;
        if (c === 0x21) { p += 2; while (p < b.length && b[p]) p += b[p] + 1; p++; } else if (c === 0x2C) {
          frames++;
          var f = b[p + 9];
          p += 10;
          if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
          p++;
          while (p < b.length && b[p]) p += b[p] + 1;
          p++;
        } else break;
      }
      return frames || 1;
    } catch (e) { return 1; }
  }

  // ---------- Encode ----------
  var ALIASES = { 'image/gif': 'gif', jpg: 'jpeg', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', tif: 'tiff', 'image/tiff': 'tiff' };
  function norm(f) { f = String(f || '').toLowerCase(); return ALIASES[f] || f; }
  var encTests = {};
  function canEncode(f, opts) {
    var fmt = norm(f);
    if (fmt === 'png' || fmt === 'bmp' || fmt === 'ico' || fmt === 'tiff' || fmt === 'gif') return Promise.resolve(true);
    if (!(fmt === 'jpeg' || fmt === 'webp' || fmt === 'avif')) return Promise.resolve(false);
    if (!encTests[fmt]) {
      encTests[fmt] = (async function () {
        var c = newCanvas(2, 2);
        context(c).fillRect(0, 0, 1, 1);
        var b = await toBlob(c, FORMATS[fmt].mime, 0.8);
        return !!b && b.type === FORMATS[fmt].mime && b.size > 0;
      })().catch(function () { return false; });
    }
    if (fmt === 'avif' && opts && opts.wasm) return encTests.avif.then(function (ok) { return ok || avifWasmPossible(); });
    return encTests[fmt];
  }

  // ---------- AVIF through WebAssembly (opt-in: encode(..., { wasm: true })) ----------
  // Most browsers cannot encode AVIF from a canvas. The libavif/libaom encoder in
  // /assets/vendor/avif/ (3.5 MB, loaded on first use) runs in its own module
  // worker; the image worker hands it the resized pixels.
  var AVIF_MAX = 50e6, avifState = null, avifPossible = null;
  function avifWasmPossible() {
    if (avifPossible === null) {
      avifPossible = false;
      if (typeof WebAssembly === 'object' && typeof Worker === 'function') {
        // Browsers without module workers never read the "type" option.
        var url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
        try { new Worker(url, { get type() { avifPossible = true; return 'module'; } }).terminate(); } catch (e) { /* none */ }
        URL.revokeObjectURL(url);
      }
    }
    return avifPossible;
  }
  function avifWorker() {
    if (avifState) return avifState;
    var src = 'import encoder from ' + JSON.stringify(VENDOR + 'avif/avif_enc.js') + ';\n' +
      'var mod = null;\n' +
      'async function load(url) {\n' +
      '  var res = await fetch(url);\n' +
      '  if (!res.ok) throw new Error("load");\n' +
      '  return encoder({ wasmBinary: await res.arrayBuffer(), print: function () {}, printErr: function () {} });\n' +
      '}\n' +
      'self.onmessage = async function (e) {\n' +
      '  var m = e.data, M;\n' +
      '  try {\n' +
      '    if (!mod) { mod = load(m.wasm); mod.catch(function () { mod = null; }); }\n' +
      '    try { M = await mod; } catch (x) { self.postMessage({ id: m.id, ok: false, code: "LOAD_FAILED" }); return; }\n' +
      '    var out = M.encode(new Uint8Array(m.buffer), m.w, m.h, m.opts);\n' +
      '    if (!out || !out.length) throw new Error("encode");\n' +
      '    var copy = out.slice();\n' +
      '    self.postMessage({ id: m.id, ok: true, buffer: copy.buffer }, [copy.buffer]);\n' +
      '  } catch (x) {\n' +
      '    self.postMessage({ id: m.id, ok: false, code: "CORRUPT", fatal: x instanceof WebAssembly.RuntimeError });\n' +
      '  }\n' +
      '};\n';
    var st = { pending: new Map(), seq: 0 };
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    var stop = function (code) {
      if (avifState === st) avifState = null;
      st.pending.forEach(function (p) { clearTimeout(p.timer); p.reject(avifError(code)); });
      st.pending.clear();
      try { st.worker.terminate(); } catch (e) { /* gone */ }
      URL.revokeObjectURL(url);
    };
    try {
      st.worker = new Worker(url, { type: 'module' });
    } catch (e) {
      URL.revokeObjectURL(url);
      throw avifError('LOAD_FAILED');
    }
    st.worker.onmessage = function (e) {
      var p = st.pending.get(e.data.id);
      if (!p) return;
      st.pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(new Uint8Array(e.data.buffer)); else p.reject(avifError(e.data.code));
      // After a WebAssembly crash (out of memory) the module cannot be used again.
      if (e.data.fatal) stop('CORRUPT');
    };
    st.worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); stop('LOAD_FAILED'); };
    st.stop = stop;
    avifState = st;
    return st;
  }
  function avifError(code) {
    if (code === 'LOAD_FAILED') return fail('LOAD_FAILED', 'The AVIF encoder could not be loaded. Check your connection and try again.');
    return fail('CORRUPT', 'The AVIF encoder failed on this image. It may be too large for this browser: try a smaller size.');
  }
  function avifEncode(rgba, w, h, quality, speed) {
    var st;
    try { st = avifWorker(); } catch (e) { return Promise.reject(e); }
    return new Promise(function (resolve, reject) {
      var id = ++st.seq, p = { resolve: resolve, reject: reject };
      p.timer = setTimeout(function () { if (st.pending.has(id)) { st.pending.delete(id); reject(fail('CORRUPT', 'Encoding the AVIF took too long and was stopped.')); st.stop('CORRUPT'); } }, 300000);
      st.pending.set(id, p);
      st.worker.postMessage({
        id: id, wasm: VENDOR + 'avif/avif_enc.wasm', buffer: rgba.buffer, w: w, h: h,
        opts: {
          quality: Math.round(quality * 100), qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
          speed: speed, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false
        }
      }, [rgba.buffer]);
    });
  }
  async function encode(source, format, options) {
    var o = options || {}, fmt = norm(format);
    var src = source && (isBitmap(source) || source.getContext || source.naturalWidth) ? source : null;
    if (!src && source && source._release) {
      // A decode() result: pixels in a worker, or on the page.
      if (source._h) src = source;
      else if (source.bitmap) src = source.bitmap;
      else {
        try { src = source.canvas; } catch (e) { src = null; }
        if (!src) throw fail('GONE', 'The decoded image is no longer available. Add the file again.');
      }
    }
    if (!src) throw fail('CORRUPT', 'There is no image to save.');
    var d = src._h ? [source.width, source.height] : sizeOf(src);
    if (!d[0] || !d[1]) throw fail('CORRUPT', 'There is no image to save.');
    if (!(fmt === 'png' || fmt === 'jpeg' || fmt === 'webp' || fmt === 'avif' || fmt === 'bmp' || fmt === 'ico' || fmt === 'tiff' || fmt === 'gif')) throw fail('UNSUPPORTED', 'Saving as ' + format + ' is not supported.');
    var W = Math.max(1, Math.round(o.width || d[0])), H = Math.max(1, Math.round(o.height || d[1]));
    var bg = o.background && o.background !== 'transparent' ? o.background : null;
    if (fmt === 'jpeg' || fmt === 'bmp') bg = bg || '#ffffff';
    var sizes = null;
    if (fmt === 'ico') {
      sizes = (o.icoSizes && o.icoSizes.length ? o.icoSizes : [16, 32, 48, 256]).map(function (x) { return Math.round(+x); })
        .filter(function (x, i, a) { return x >= 1 && x <= 256 && a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
      if (!sizes.length) throw fail('UNSUPPORTED', 'Choose at least one icon size between 1 and 256 pixels.');
    }
    var mime = FORMATS[fmt].mime;
    var job = { fmt: fmt, mime: mime, quality: o.quality == null ? 0.92 : Math.min(1, Math.max(0, +o.quality)), background: bg, width: W, height: H, sizes: sizes, dpi: o.dpi > 0 ? +o.dpi : 0 };
    var bytes;
    if (fmt === 'avif' && o.wasm && !(await canEncode('avif'))) {
      if (!avifWasmPossible()) throw fail('NO_SUPPORT', 'This browser cannot save AVIF images.');
      if (W * H > AVIF_MAX) throw fail('TOO_BIG', 'AVIF files can be made here up to ' + AVIF_MAX / 1e6 + ' megapixels; this image is ' + (W * H / 1e6).toFixed(1) + '. Choose a smaller size.');
      var rgba = new Uint8Array((await pixelWork('encode', src, Object.assign({}, job, { fmt: 'rgba' }))).buffer);
      bytes = await avifEncode(rgba, W, H, job.quality, o.speed != null ? +o.speed : W * H > 2.5e6 ? 8 : 6);
    } else {
      bytes = new Uint8Array((await pixelWork('encode', src, job)).buffer);
    }
    if ((o.exif && (fmt === 'jpeg' || fmt === 'png' || fmt === 'webp')) || (job.dpi && (fmt === 'png' || fmt === 'jpeg'))) {
      var ex = o.exif && fmt !== 'avif' ? prepareExif(o.exif, { width: W, height: H, stripGps: !!o.stripGps }) : null;
      if (job.dpi) bytes = withDpi(bytes, fmt, job.dpi) || bytes;
      if (ex) bytes = withExif(bytes, fmt, ex, W, H) || bytes;
    }
    return new Blob([bytes], { type: mime });
  }

  window.TTImage = {
    formats: FORMATS,
    accept: ACCEPT,
    sniff: sniff,
    sniffBytes: sniffBytes,
    decode: decode,
    canEncode: canEncode,
    encode: encode,
    resize: resize,
    svg: { info: svgInfo, render: svgRender },
    release: release,
    toCanvas: toCanvas,
    exif: { orientation: exifOrientation, prepare: prepareExif },
    _parseHeif: parseHeif
  };
})();
