/*
 * TTZip: a small ZIP writer for the browser (window.TTZip). No dependencies.
 *
 * Load it where it is needed:
 *   <script src="{{ '/assets/js/zip.js' | relative_url }}"></script>
 *
 * API
 *   TTZip.create(files, options) -> Promise<Blob>   (type application/zip)
 *     files:   [{ name, data, date? }]
 *              name  path inside the archive; "a/b.txt" makes a folder. Backslashes
 *                    become "/", leading "/" and "." / ".." segments are dropped, and
 *                    repeated names get " (2)", " (3)" ... before the extension
 *                    (compared case-insensitively, as Windows and macOS do).
 *              data  Blob, File, ArrayBuffer, typed array or string (saved as UTF-8).
 *              date  Date for the entry's modified time (default: now, local time).
 *     options: { compress: 'auto' | 'store' | 'deflate' }   (default 'auto')
 *              auto:    deflate (CompressionStream 'deflate-raw') unless the name
 *                       ends in an already-compressed format (jpg, png, webp, avif,
 *                       gif, heic, zip, gz, mp3, mp4, woff2, pdf ...), and keep
 *                       the deflated copy only when it is smaller.
 *              store:   never compress (fastest; right for photos).
 *              deflate: always try to deflate, still stored if that is not smaller.
 *     Rejects with an Error whose .message is readable by users (for example
 *     when the archive would pass the 4 GB limit of a non-ZIP64 file).
 *   TTZip.crc32(bytes[, crc]) -> number   CRC-32 (IEEE) of a Uint8Array.
 *   TTZip.uniqueName(name, usedSet) -> string   the de-duplication used above.
 *
 * File names are stored as UTF-8 with general-purpose flag bit 11 set, so
 * accented and non-Latin names survive in Windows Explorer, macOS and unzip.
 * Long loops yield to the event loop, so large archives do not freeze the page.
 */
(function () {
  'use strict';

  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, crc) {
    var c = (crc == null ? 0 : crc) ^ 0xFFFFFFFF;
    for (var i = 0, n = bytes.length; i < n; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  // CRC in slices, yielding between them, so a 100 MB batch does not block for a second.
  async function crcAsync(bytes) {
    var crc = 0, step = 4 << 20;
    for (var i = 0; i < bytes.length; i += step) {
      crc = crc32(bytes.subarray(i, Math.min(bytes.length, i + step)), crc);
      if (i + step < bytes.length) await tick();
    }
    return crc;
  }

  async function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    throw new Error('Unsupported ZIP entry data');
  }

  function cleanName(name) {
    var s = String(name == null ? '' : name).replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '_');
    var parts = s.split('/').filter(function (p) { return p && p !== '.' && p !== '..'; });
    s = parts.map(function (p) { return p.trim() || '_'; }).join('/');
    return s || 'file';
  }

  function uniqueName(name, used) {
    var base = cleanName(name);
    if (!used) return base;
    var key = base.toLowerCase();
    if (!used.has(key)) { used.add(key); return base; }
    var slash = base.lastIndexOf('/');
    var dot = base.lastIndexOf('.');
    if (dot <= slash + 1) dot = base.length; // no extension, or a dot-file such as ".env"
    var stem = base.slice(0, dot), ext = base.slice(dot);
    for (var i = 2; ; i++) {
      var cand = stem + ' (' + i + ')' + ext;
      if (!used.has(cand.toLowerCase())) { used.add(cand.toLowerCase()); return cand; }
    }
  }

  var PACKED = /\.(jpe?g|jfif|png|apng|gif|webp|avif|heic|heif|hif|jxl|zip|gz|tgz|bz2|xz|7z|rar|zst|br|mp3|mp4|m4a|m4v|mov|webm|ogg|opus|aac|flac|mkv|woff2?|pdf|docx|xlsx|pptx|odt|epub|apk|jar)$/i;

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      var cs = new CompressionStream('deflate-raw');
      var out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
      return new Uint8Array(await out.arrayBuffer());
    } catch (e) {
      return null; // older browsers only know 'deflate' and 'gzip'
    }
  }

  function dosDateTime(d) {
    var date = d instanceof Date && !isNaN(d) ? d : new Date();
    var y = date.getFullYear();
    if (y < 1980) return { time: 0, date: (1 << 5) | 1 };            // 1980-01-01 00:00
    if (y > 2107) return { time: 0xBF7D, date: 0xFF9F };              // 2107-12-31 23:59:58
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  var LIMIT = 0xFFFFFFFF;

  async function create(files, options) {
    if (!Array.isArray(files)) throw new Error('No files to put in the ZIP');
    if (files.length > 0xFFFF) throw new Error('A ZIP file can hold at most 65,535 files; split the batch.');
    var mode = (options && options.compress) || 'auto';
    var enc = new TextEncoder();
    var used = new Set();
    var parts = [], central = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var f = files[i] || {};
      var name = uniqueName(f.name, used);
      var nameBytes = enc.encode(name);
      if (nameBytes.length > 0xFFFF) throw new Error('A file name is too long for a ZIP file.');
      var raw = await toBytes(f.data);
      var crc = await crcAsync(raw);
      var method = 0, stored = raw;
      var tryDeflate = mode === 'deflate' || (mode === 'auto' && raw.length > 128 && !PACKED.test(name));
      if (tryDeflate) {
        var def = await deflateRaw(raw);
        if (def && def.length < raw.length) { stored = def; method = 8; }
      }
      if (raw.length > LIMIT || stored.length > LIMIT || offset > LIMIT) {
        throw new Error('The ZIP would be larger than 4 GB. Download fewer files at a time.');
      }
      var dt = dosDateTime(f.date);
      var flags = 0x0800; // bit 11: names are UTF-8

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // version needed: 2.0
      lv.setUint16(6, flags, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, stored.length, true);
      lv.setUint32(22, raw.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, (3 << 8) | 20, true); // made by: Unix, spec 2.0 (so the mode bits below apply)
      cv.setUint16(6, 20, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, stored.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);            // extra length
      cv.setUint16(32, 0, true);            // comment length
      cv.setUint16(34, 0, true);            // disk number
      cv.setUint16(36, 0, true);            // internal attributes
      cv.setUint32(38, (0x81A4 << 16) >>> 0, true); // regular file, rw-r--r--
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);

      parts.push(local, stored);
      central.push(cen);
      offset += local.length + stored.length;
    }

    var cdSize = central.reduce(function (n, c) { return n + c.length; }, 0);
    if (offset > LIMIT || offset + cdSize > LIMIT) throw new Error('The ZIP would be larger than 4 GB. Download fewer files at a time.');
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  window.TTZip = { create: create, crc32: crc32, uniqueName: uniqueName };
})();
