{%- comment -%}
  pdfUnlocker(PDFLib): the PDF standard security handler (ISO 32000-1 7.6.3, ISO 32000-2 7.6.4)
  for pdf-lib, shared by Split PDF, Merge PDF and Unlock PDF. It reads RC4 (40 to 128-bit),
  AES-128 and AES-256 files (R2 to R6) with the open (user) or the permissions (owner) password,
  decrypts them in memory, and encrypts objects again with the file key.

  A page includes it in its script, where the function is to be defined, with an include tag
  for pdf-unlocker.js at the start of a line of its own. The tag must sit outside the page's
  raw block: end the raw block just before it and open it again just after. The function is
  indented to sit inside the page's (function () { ... })() wrapper, and the file ends without
  a newline, so the built page reads as if the function were written there. It uses nothing
  from outside itself, so pdfUnlocker.toString() puts it into a worker.

  pdfUnlocker(PDFLib) -> { open, inspect, unlock, encrypt, encryptObject, pdfjsPasswords, md5, rc4 }
    PDFLib is the pdf-lib 1.17.1 module (self.PDFLib after importScripts in a worker). The first
    parse patches PDFLib.PDFParser and PDFLib.PDFObjectStreamParser once, so that object streams
    are decrypted as they are read; other parsing is unaffected. open, inspect and unlock parse
    one file at a time: wait for one call to finish before starting the next. pdfUnlocker(null)
    is enough for pdfjsPasswords, md5 and rc4, which need no pdf-lib.

  Passwords. For R2 to R4 a password is tried in PDFDocEncoding, then UTF-8, then Windows-1252,
  then as the low byte of each character (as qpdf does); for R5 and R6 in UTF-8 after NFKC
  (the normalisation of SASLprep), then in UTF-8 as typed. Only the first 32 bytes count for R2
  to R4, and the first 127 for R5 and R6.

  Errors are Error objects with a .code:
    'PASSWORD'     open: neither the password given nor a blank one is the open or the
                   permissions password. encrypt and encryptObject: the data needs the key
                   and security.key is null (a file that encrypts only its attachments, opened
                   without its password).
    'UNSUPPORTED'  open, inspect and unlock: an encryption this code cannot remove. .reason is
                   'certificate' (public-key security: Adobe.PubSec, adbe.pkcs7.s3 to s5),
                   'drm' (another security handler, or none named), 'revision' (/R outside 2
                   to 6), 'attachments' (only embedded files are encrypted; inspect and unlock
                   only) or 'cryptfilter' (a stream with a crypt filter of its own other than
                   /Identity; inspect only).
                   .detail is the handler's /Filter name, 'R7' and the like, or ''.
    'DAMAGED'      inspect: the trailer names no catalogue.
  Anything pdf-lib throws for a file it cannot parse passes through, without a .code.

  open(bytes, password) -> Promise of { doc, encrypted, security }
    bytes is a Uint8Array of the whole file; password a string ('' or undefined for none). For
    Split PDF, Merge PDF, and pages that change or rewrite a file.
    doc        a PDFDocument. A file that is not encrypted is read with PDFDocument.load
               (updateMetadata false). An encrypted one is decrypted in memory, with the same
               rules as unlock: every string and stream, but not a signature's /Contents, a
               stream with its own /Crypt filter, nor the catalogue's /Metadata when
               /EncryptMetadata is false. doc.context.trailerInfo.Encrypt is cleared; the
               encryption dictionary stays in the context, unused, at security.ref (delete it
               before saving a whole new file), and trailerInfo.ID is kept.
    encrypted  true when the file has an encryption dictionary.
    security   null when it has none, otherwise:
      access     'owner' when the password given, or a blank one, is the permissions (owner)
                 password; 'user' when it is only the open (user) password; null for a file that
                 encrypts only its attachments, opened without its password (its pages are in
                 the clear, and its embedded files stay encrypted).
      key        the file encryption key, a Uint8Array of 5 to 16 bytes (RC4), 16 (AES-128) or
                 32 (AES-256); null when access is null.
      method     'RC4', 'AES-128' or 'AES-256'; keyBits: 40 to 128 for RC4, 128 or 256.
      cipher     the same as a label: 'RC4 40-bit', 'RC4 128-bit', 'AES 128-bit', 'AES 256-bit'.
      V, R       the /V and /R of the encryption dictionary.
      stm, str, eff  the method for streams, strings and embedded files: 'V2' (RC4), 'AESV2'
                 (AES-128), 'AESV3' (AES-256) or 'None' (left in the clear).
      encryptMetadata  false when the catalogue's /Metadata stream is not encrypted.
      P          /P, the permission bits, as a signed 32-bit number.
      permissions  { print, modify, copy, annotate, fill, assemble, hq }: true when allowed, from
                 bits 3, 4, 5, 6, 9, 11 and 12 of P (for R2, fill, assemble and hq follow bits 6,
                 4 and 3). Assembling (inserting, deleting, rotating pages) is forbidden when
                 both modify and assemble are false.
      restrictions  what is forbidden, as inspect lists it.
      ref        the trailer's /Encrypt entry (a PDFRef), for the trailer of an incremental update.
      metadataRef  the catalogue's /Metadata (a PDFRef), or null.
    Throws 'PASSWORD' or 'UNSUPPORTED' ('certificate', 'drm' or 'revision').

  inspect(bytes) -> Promise of what protects a file, without its password:
    { encrypted: false, signed } or
    { encrypted: true, V, R, P, cipher, restrictions, emptyOwner, emptyUser, signed }
    restrictions lists what is forbidden: 'printing' or 'high-quality printing', 'changes',
    'copying', 'comments' or 'comments and form filling', 'page assembly'. emptyOwner and
    emptyUser: a blank permissions, or open, password works. signed: the file holds a signature.
    Throws 'DAMAGED' or 'UNSUPPORTED' (any reason).

  unlock(bytes, password, ownerOnly) -> Promise of a copy without the password (Unlock PDF).
    Tries the password as the permissions password, then a blank one, then (unless ownerOnly)
    the password as the open password, then a blank one.
    { access: 'none' }  the file is not encrypted; no copy is made.
    { access: null }    the password does not open it.
    { access: 'owner' | 'user', kept, signed, bytes }  bytes is a Uint8Array of the copy. With
                        the permissions password (access 'owner') the copy is not encrypted and
                        kept is []. With only the open password, kept lists the restrictions,
                        which stay: the copy is encrypted with AES-256 (R6), with no open
                        password and a random permissions password.
    Throws 'UNSUPPORTED' ('certificate', 'drm', 'revision' or 'attachments').

  encrypt(security, data, objectNumber, generation, kind) -> Promise of a Uint8Array
    Encrypts data, a Uint8Array (a string's bytes, or a stream's data after its filters), as
    part of the indirect object objectNumber generation, with the security of open(). kind is
    'string' (the /StrF method), 'stream' (/StmF, the default) or 'file' (/EFF, an embedded
    file stream). RC4 gives the same length; AES gives a random 16-byte IV followed by the
    data in CBC mode with PKCS#7 padding. When that method is 'None', data is returned as it is.

  encryptObject(security, object, objectNumber, generation) -> Promise of a PDF object
    A copy of a pdf-lib object (dictionary, array, string or stream) ready to be written as
    the indirect object objectNumber generation of the encrypted file: each string is
    encrypted as kind 'string', except a signature's /Contents, and a stream's data as
    'stream' ('file' for /Type /EmbeddedFile), except a stream with its own /Crypt filter and
    the catalogue's /Metadata when encryptMetadata is false. Direct objects inside are copied,
    references are kept as they are; a stream comes back as a PDFRawStream, whose /Length
    pdf-lib sets when it writes it. The encryption dictionary (security.ref) and an /XRef
    stream come back unchanged: they are never encrypted. Objects inside an object stream are
    not encrypted one by one; the object stream is, as a stream.
    An incremental update to an encrypted file: after the file's last byte, for each changed
    object, "n g obj", encryptObject(security, object, n, g) written out, "endobj"; then a
    cross-reference section for those objects and a trailer with /Size, /Root, /Info, /Prev
    (the file's last startxref offset), the same /Encrypt (security.ref) and the same /ID
    (doc.context.trailerInfo.ID: the key of an RC4 or AES-128 file depends on its first string).
    /Size is at least that of the file's last trailer or cross-reference stream, and a new
    object takes a number from there up: doc.context.largestObjectNumber leaves out the number
    of a cross-reference stream, and pypdf misreads an object that reuses it. A classic
    cross-reference section may follow a cross-reference stream: PDF.js, qpdf, pypdf and
    poppler read such updates to RC4 128-bit, AES-128 and AES-256 files.

  pdfjsPasswords(password) -> an array of strings, to give PDF.js in turn: the first to
    getDocument, the others through loadingTask.onPassword while the reason is
    PasswordResponses.INCORRECT_PASSWORD. PDF.js reads an RC4 or AES-128 password as the low
    byte of each character, so after the password itself come the other byte sequences that
    open tries for such a file (PDFDocEncoding, UTF-8, Windows-1252), each as a string of those
    bytes. PDF.js reads an AES-256 password as UTF-8 itself. An ASCII password gives [password].

  md5(data) -> a 16-byte Uint8Array (RFC 1321). rc4(key, data) -> a Uint8Array as long as data.
{%- endcomment -%}
{% raw %}  function pdfUnlocker(PDFLib) {
    'use strict';
    var subtle = (self.crypto || crypto).subtle;
    var N = function (n) { return PDFLib.PDFName.of(n); };
    var PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
      0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
    // PDFDocEncoding 0x18-0x1F and 0x80-0xA0 (0x9F is undefined), and Windows-1252 0x80-0x9F.
    var PDFDOC_LOW = '˘ˇˆ˙˝˛˚˜';
    var PDFDOC_HIGH = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž�€';
    var CP1252_HIGH = '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ';

    function concat() {
      var n = 0, i, a = arguments;
      for (i = 0; i < a.length; i++) n += a[i].length;
      var out = new Uint8Array(n), o = 0;
      for (i = 0; i < a.length; i++) { out.set(a[i], o); o += a[i].length; }
      return out;
    }
    function equal(a, b, n) {
      if (a.length < n || b.length < n) return false;
      for (var i = 0; i < n; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
    function random(n) { return (self.crypto || crypto).getRandomValues(new Uint8Array(n)); }
    function fail(code) { var err = new Error(code); err.code = code; return err; }

    // ---- MD5 (RFC 1321) ----
    var K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (var ki = 0; ki < 64; ki++) K[ki] = Math.floor(Math.abs(Math.sin(ki + 1)) * 4294967296) | 0;
    function md5(data) {
      var n = data.length, padded = new Uint8Array(((n + 8) >> 6 << 6) + 64);
      padded.set(data);
      padded[n] = 0x80;
      var bits = n * 8, dv = new DataView(padded.buffer);
      dv.setUint32(padded.length - 8, bits >>> 0, true);
      dv.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);
      var a0 = 0x67452301, b0 = 0xEFCDAB89 | 0, c0 = 0x98BADCFE | 0, d0 = 0x10325476, M = new Int32Array(16);
      for (var off = 0; off < padded.length; off += 64) {
        for (var j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);
        var A = a0, B = b0, C = c0, D = d0;
        for (var i = 0; i < 64; i++) {
          var F, g, r = i >> 4;
          if (r === 0) { F = (B & C) | (~B & D); g = i; }
          else if (r === 1) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
          else if (r === 2) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
          else { F = C ^ (B | ~D); g = (7 * i) & 15; }
          var t = D; D = C; C = B;
          var x = (A + F + K[i] + M[g]) | 0, s = S[(r << 2) | (i & 3)];
          B = (B + ((x << s) | (x >>> (32 - s)))) | 0;
          A = t;
        }
        a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
      }
      var out = new Uint8Array(16), ov = new DataView(out.buffer);
      ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
      return out;
    }

    // ---- RC4 ----
    function rc4(key, data) {
      var s = new Uint8Array(256), i, j = 0, t;
      for (i = 0; i < 256; i++) s[i] = i;
      for (i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; t = s[i]; s[i] = s[j]; s[j] = t; }
      var out = new Uint8Array(data.length);
      i = 0; j = 0;
      for (var k = 0; k < data.length; k++) {
        i = (i + 1) & 255; j = (j + s[i]) & 255;
        t = s[i]; s[i] = s[j]; s[j] = t;
        out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
      }
      return out;
    }

    // ---- AES-CBC and SHA-2 through Web Crypto ----
    // An R5/R6 file key is the same for every object, so it is imported once (WeakMap by key array).
    var keyCache = new WeakMap();
    function aesKey(raw, usage) {
      var c = keyCache.get(raw);
      if (c && c[usage]) return c[usage];
      var p = subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, [usage]);
      if (!c) { c = {}; keyCache.set(raw, c); }
      c[usage] = p;
      return p;
    }
    async function aesEncryptNoPad(key, iv, data) {
      var k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
      var out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: iv }, k, data));
      return out.subarray(0, data.length);   // drop the padding block Web Crypto always adds
    }
    // Decrypts data whose length is a multiple of 16 without expecting padding: a crafted last block
    // decrypts to a full block of padding, which Web Crypto then removes.
    async function aesDecryptNoPad(key, iv, data) {
      if (!data.length || data.length % 16) throw new Error('bad AES data');
      var last = data.subarray(data.length - 16);
      var pad = new Uint8Array(16).fill(16);
      var ek = await aesKey(key, 'encrypt'), dk = await aesKey(key, 'decrypt');
      var extra = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: last }, ek, pad)).subarray(0, 16);
      return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: iv }, dk, concat(data, extra)));
    }
    async function aesDecrypt(key, data) {
      if (data.length < 16) return new Uint8Array(0);
      var iv = data.subarray(0, 16), body = data.subarray(16);
      if (body.length % 16) body = body.subarray(0, body.length - (body.length % 16));
      // Less than a block after the IV (a string some writer left unencrypted): nothing, as in PDF.js.
      if (!body.length) return new Uint8Array(0);
      try {
        var dk = await aesKey(key, 'decrypt');
        return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: iv }, dk, body));
      } catch (e) {
        // Bad padding: keep the bytes as they decrypt.
        return aesDecryptNoPad(key, iv, body);
      }
    }
    // A string or stream as an encrypted file stores it: a random IV, then the data in CBC mode with
    // PKCS#7 padding (ISO 32000-1 7.6.2).
    async function aesEncrypt(key, data) {
      var iv = random(16), k = await aesKey(key, 'encrypt');
      return concat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: iv }, k, data)));
    }
    async function sha(name, data) { return new Uint8Array(await subtle.digest(name, data)); }

    // ---- Reading the encryption dictionary ----
    function num(v) { return v && typeof v.asNumber === 'function' ? v.asNumber() : (v && typeof v.value === 'function' ? Number(v.value()) : NaN); }
    function bytesOf(v) {
      if (!v) return new Uint8Array(0);
      if (v instanceof PDFLib.PDFString || v instanceof PDFLib.PDFHexString) return v.asBytes();
      return new Uint8Array(0);
    }
    function nameOf(v) { return v instanceof PDFLib.PDFName ? v.decodeText ? v.decodeText() : v.asString().slice(1) : ''; }

    // Password bytes. R2-R4 passwords are PDFDocEncoding; writers also used UTF-8 and Windows-1252,
    // which are tried next, as qpdf does. R5/R6 passwords are UTF-8 after SASLprep (NFKC here).
    function encodeWith(pw, high, base, low) {
      var out = [];
      for (var i = 0; i < pw.length; i++) {
        var c = pw.charCodeAt(i), b = -1;
        if (c < 0x18 || (c >= 0x20 && c < 0x7F) || (c >= 0xA1 && c <= 0xFF && c !== 0xAD)) b = c;
        if (b < 0 && low) { var l = low.indexOf(pw.charAt(i)); if (l >= 0) b = 0x18 + l; }
        if (b < 0) { var h = high.indexOf(pw.charAt(i)); if (h >= 0) b = base + h; }
        if (b < 0) return null;
        out.push(b);
      }
      return new Uint8Array(out);
    }
    function utf8(s) { return new TextEncoder().encode(s); }
    // The low byte of each character: what PDF.js, and this code before it learnt the encodings, used.
    function lowBytes(pw) {
      var out = new Uint8Array(pw.length);
      for (var i = 0; i < pw.length; i++) out[i] = pw.charCodeAt(i) & 0xFF;
      return out;
    }
    function candidates(e, pw) {
      var list = [], seen = new Set();
      function add(b) {
        if (!b) return;
        if (e.R >= 5 && b.length > 127) b = b.subarray(0, 127);
        var k = hex(e.R >= 5 ? b : b.subarray(0, 32));
        if (!seen.has(k)) { seen.add(k); list.push(b); }
      }
      if (e.R >= 5) { add(utf8(pw.normalize('NFKC'))); add(utf8(pw)); return list; }
      add(encodeWith(pw, PDFDOC_HIGH, 0x80, PDFDOC_LOW));
      add(utf8(pw));
      add(encodeWith(pw, CP1252_HIGH, 0x80, ''));
      add(lowBytes(pw));
      return list;
    }
    function pad32(b) {
      var p = b.subarray(0, 32);
      return concat(p, PAD.subarray(0, 32 - p.length));
    }
    // The same R2-R4 candidates for PDF.js, which takes the low byte of each character: the password
    // itself, then each other candidate as a string of its bytes.
    function pdfjsPasswords(password) {
      var pw = String(password || ''), out = [pw];
      if (!pw) return out;
      var seen = new Set([hex(lowBytes(pw).subarray(0, 32))]);
      candidates({ R: 4 }, pw).forEach(function (b) {
        b = b.subarray(0, 32);
        var k = hex(b);
        if (seen.has(k)) return;
        seen.add(k);
        out.push(String.fromCharCode.apply(null, b));
      });
      return out;
    }

    // Algorithm 2: the file key from a (padded) user password, R2-R4.
    function legacyKey(e, pw32) {
      var P = new Uint8Array(4);
      new DataView(P.buffer).setInt32(0, e.P, true);
      var input = concat(pw32, e.O.subarray(0, 32), P, e.id0);
      if (e.R >= 4 && !e.encryptMetadata) input = concat(input, new Uint8Array([255, 255, 255, 255]));
      var h = md5(input), n = e.length;
      if (e.R >= 3) for (var i = 0; i < 50; i++) h = md5(h.subarray(0, n));
      return h.subarray(0, n);
    }
    // Algorithms 4 and 5: is this the user password?
    function checkUser(e, key) {
      if (e.R === 2) return equal(rc4(key, PAD), e.U, 32);
      var x = rc4(key, md5(concat(PAD, e.id0)));
      for (var i = 1; i <= 19; i++) {
        var k2 = new Uint8Array(key.length);
        for (var j = 0; j < key.length; j++) k2[j] = key[j] ^ i;
        x = rc4(k2, x);
      }
      return equal(x, e.U, 16);
    }
    // Algorithm 7: the user password recovered from the owner password.
    function userFromOwner(e, ownerPw) {
      var h = md5(pad32(ownerPw)), n = e.length;
      if (e.R >= 3) for (var i = 0; i < 50; i++) h = md5(h.subarray(0, n));
      var key = h.subarray(0, n), x = e.O.subarray(0, 32);
      if (e.R === 2) return rc4(key, x);
      for (var r = 19; r >= 0; r--) {
        var k2 = new Uint8Array(n);
        for (var j = 0; j < n; j++) k2[j] = key[j] ^ r;
        x = rc4(k2, x);
      }
      return x;
    }
    // Algorithm 2.B (R6) and the plain SHA-256 of R5.
    async function hash6(pw, salt, udata, R) {
      var k = await sha('SHA-256', concat(pw, salt, udata));
      if (R === 5) return k;
      for (var round = 0; ; round++) {
        var seq = concat(pw, k, udata), k1 = new Uint8Array(seq.length * 64);
        for (var i = 0; i < 64; i++) k1.set(seq, i * seq.length);
        var en = await aesEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
        var sum = 0;
        for (var b = 0; b < 16; b++) sum += en[b];
        k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], en);
        if (round >= 63 && en[en.length - 1] <= round - 31) break;
      }
      return k.subarray(0, 32);
    }

    // The file key for this password used as the permissions (owner) password, or null.
    async function ownerKey(e, password) {
      var list = candidates(e, password);
      for (var i = 0; i < list.length; i++) {
        var pw = list[i];
        if (e.R >= 5) {
          if (e.O.length < 48 || e.U.length < 48) return null;
          var h = await hash6(pw, e.O.subarray(32, 40), e.U.subarray(0, 48), e.R);
          if (equal(h, e.O, 32)) return aesDecryptNoPad(await hash6(pw, e.O.subarray(40, 48), e.U.subarray(0, 48), e.R), new Uint8Array(16), e.OE.subarray(0, 32));
        } else {
          var key = legacyKey(e, userFromOwner(e, pw));
          if (checkUser(e, key)) return key;
        }
      }
      return null;
    }
    // The file key for this password used as the open (user) password, or null.
    async function userKey(e, password) {
      var list = candidates(e, password);
      for (var i = 0; i < list.length; i++) {
        var pw = list[i];
        if (e.R >= 5) {
          if (e.U.length < 48) return null;
          var h = await hash6(pw, e.U.subarray(32, 40), new Uint8Array(0), e.R);
          if (equal(h, e.U, 32)) return aesDecryptNoPad(await hash6(pw, e.U.subarray(40, 48), new Uint8Array(0), e.R), new Uint8Array(16), e.UE.subarray(0, 32));
        } else {
          var key = legacyKey(e, pad32(pw));
          if (checkUser(e, key)) return key;
        }
      }
      return null;
    }
    // The permissions password first, then a blank one, then the open password (typed, then blank)
    // unless ownerOnly. Returns { key, access: 'owner' | 'user' }, or a null key and access.
    async function findKey(e, password, ownerOnly) {
      var key = null, tries = password ? [password, ''] : [''], i;
      for (i = 0; i < tries.length; i++) { key = await ownerKey(e, tries[i]); if (key) return { key: key, access: 'owner' }; }
      for (i = 0; i < tries.length && !ownerOnly; i++) { key = await userKey(e, tries[i]); if (key) return { key: key, access: 'user' }; }
      return { key: null, access: null };
    }

    function unsupported(reason, detail) { var err = new Error('UNSUPPORTED'); err.code = 'UNSUPPORTED'; err.reason = reason; err.detail = detail || ''; return err; }

    // A file that encrypts only its attachments is refused, unless attachmentsOnly allows it (open).
    function readEncrypt(context, attachmentsOnly) {
      var t = context.trailerInfo, enc = t.Encrypt && context.lookup(t.Encrypt);
      if (!(enc instanceof PDFLib.PDFDict)) return null;
      var get = function (k) { return enc.get(N(k)); };
      var filter = nameOf(get('Filter')), subFilter = nameOf(get('SubFilter'));
      if (filter !== 'Standard') {
        var cert = filter === 'Adobe.PubSec' || /^adbe\.pkcs7\.s[345]$/.test(subFilter);
        throw unsupported(cert ? 'certificate' : 'drm', filter);
      }
      var e = {
        V: num(get('V')) || 0, R: num(get('R')) || 2, P: num(get('P')) | 0,
        O: bytesOf(get('O')), U: bytesOf(get('U')), OE: bytesOf(get('OE')), UE: bytesOf(get('UE')),
        length: (num(get('Length')) || 40) / 8, encryptMetadata: true, stm: 'V2', str: 'V2', eff: 'V2', ref: t.Encrypt,
        attachmentsOnly: false
      };
      var em = get('EncryptMetadata');
      if (em && em.toString() === 'false') e.encryptMetadata = false;
      var ids = t.ID && context.lookup(t.ID);
      e.id0 = ids instanceof PDFLib.PDFArray && ids.size() ? bytesOf(context.lookup(ids.get(0))) : new Uint8Array(0);
      if (e.V === 4 || e.V === 5) {
        var cf = get('CF'), stmF = nameOf(get('StmF')) || 'Identity', strF = nameOf(get('StrF')) || 'Identity';
        var effF = get('EFF') ? nameOf(get('EFF')) : stmF;
        cf = cf && context.lookup(cf);
        var method = function (name) {
          if (name === 'Identity') return 'None';
          var f = cf instanceof PDFLib.PDFDict ? cf.lookup(N(name)) : null;
          var m = f instanceof PDFLib.PDFDict ? nameOf(f.get(N('CFM'))) || 'None' : 'None';
          if (f instanceof PDFLib.PDFDict && e.V === 4) {
            var len = num(f.get(N('Length')));
            if (len) e.length = len > 40 ? len / 8 : len;  // some writers give bytes, some bits
          }
          return m;
        };
        e.stm = method(stmF);
        e.str = method(strF);
        e.eff = method(effF);
        // Only attachments encrypted (ISO 32000-1 7.6.5): the document itself is in the clear.
        if (stmF === 'Identity' && strF === 'Identity' && e.eff !== 'None') {
          if (!attachmentsOnly) throw unsupported('attachments');
          e.attachmentsOnly = true;
        }
      }
      if (!(e.R >= 2 && e.R <= 6)) throw unsupported('revision', 'R' + e.R);
      if (e.V < 4) e.length = e.V === 1 ? 5 : Math.min(16, Math.max(5, e.length));
      if (e.V === 4) e.length = 16;
      e.cipher = e.V >= 5 ? 'AES 256-bit' : (e.V === 4 && e.stm === 'AESV2') ? 'AES 128-bit' : 'RC4 ' + (e.length * 8) + '-bit';
      return e;
    }

    // ---- Permissions (ISO 32000-1 Table 22) ----
    function bits(e) {
      var p = e.P >>> 0, bit = function (n) { return ((p >>> (n - 1)) & 1) === 1; };
      var b = { print: bit(3), modify: bit(4), copy: bit(5), annotate: bit(6) };
      // R2 has only bits 3-6: form filling, assembly and full-quality printing follow them.
      if (e.R === 2) { b.fill = b.annotate; b.assemble = b.modify; b.hq = b.print; }
      else { b.fill = bit(9); b.assemble = bit(11); b.hq = bit(12); }
      return b;
    }
    function restrictions(e) {
      var b = bits(e), out = [];
      if (!b.print) out.push('printing');
      else if (!b.hq) out.push('high-quality printing');
      if (!b.modify) out.push('changes');
      if (!b.copy) out.push('copying');
      if (!b.annotate) out.push(b.fill ? 'comments' : 'comments and form filling');
      if (!b.assemble && b.modify) out.push('page assembly');
      return out;
    }
    // /P for an R6 copy: the same permissions, bits 7-8 and 13-32 set, bits 1-2 clear, and bit 10
    // (copying for accessibility, which PDF 2.0 tells readers to ignore) set.
    function permsR6(e) {
      var b = bits(e), p = 0xFFFFF000 | 0xC0 | 0x200;
      if (b.print) p |= 1 << 2;
      if (b.modify) p |= 1 << 3;
      if (b.copy) p |= 1 << 4;
      if (b.annotate) p |= 1 << 5;
      if (b.fill) p |= 1 << 8;
      if (b.assemble) p |= 1 << 10;
      if (b.hq) p |= 1 << 11;
      return p | 0;
    }

    // Parses a document with pdf-lib's parser, decrypting object streams before they are read.
    // pdf-lib reads the file from start to end, so a later definition of an object replaces an
    // earlier one: an object from an object stream that an incremental update writes again on its
    // own is no longer one of the inner objects (decrypted with their object stream).
    var hookState = null;
    var patched = false;
    function patch() {
      if (patched) return;
      patched = true;
      var P = PDFLib.PDFParser.prototype, origHeader = P.parseIndirectObjectHeader;
      P.parseIndirectObjectHeader = function () {
        var ref = origHeader.apply(this, arguments);
        if (hookState) { hookState.ref = ref; hookState.parser = this; if (hookState.inner) hookState.inner.delete(ref.tag); }
        return ref;
      };
      var OS = PDFLib.PDFObjectStreamParser, origFor = OS.forStream;
      OS.forStream = function (raw, wait) {
        if (!hookState) return origFor.apply(this, arguments);
        var st = hookState, ref = st.ref, parser = st.parser;
        return {
          parseIntoContext: async function () {
            if (st.mode === 'skip') { parser.context.assign(ref, raw); return; }
            raw.contents = await decryptData(st.e, st.key, ref, raw.contents, st.e.stm);
            var real = origFor.call(OS, raw, wait), ctx = parser.context, origAssign = ctx.assign;
            ctx.assign = function (r, o) { st.inner.add(r.tag); return origAssign.apply(this, arguments); };
            try { await real.parseIntoContext(); } finally { ctx.assign = origAssign; }
          }
        };
      };
    }
    async function parse(bytes, state) {
      patch();
      hookState = state;
      try {
        return await PDFLib.PDFParser.forBytesWithOptions(bytes, 400, false, false).parseDocument();
      } finally { hookState = null; }
    }

    function objectKey(e, key, ref, aes) {
      if (e.R >= 5) return key;
      var n = ref.objectNumber, g = ref.generationNumber;
      var extra = new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]);
      var h = md5(aes ? concat(key, extra, new Uint8Array([0x73, 0x41, 0x6C, 0x54])) : concat(key, extra));
      return h.subarray(0, Math.min(key.length + 5, 16));
    }
    // Without a key (open, for a file that encrypts only its attachments), data stays as it is.
    async function decryptData(e, key, ref, data, method) {
      if (method === 'None' || !key) return data;
      if (method === 'AESV2' || method === 'AESV3') return aesDecrypt(objectKey(e, key, ref, true), data);
      return rc4(objectKey(e, key, ref, false), data);
    }

    // A signature's /Contents is never encrypted (ISO 32000-2 7.6.2), nor that of a document timestamp.
    function isSignature(d) {
      if (!d.has(N('ByteRange')) || !d.has(N('Contents'))) return false;
      var type = nameOf(d.get(N('Type')));
      return !type || type === 'Sig' || type === 'DocTimeStamp';
    }
    async function mapStrings(v, fn) {
      if (v instanceof PDFLib.PDFString || v instanceof PDFLib.PDFHexString) return PDFLib.PDFHexString.of(hex(await fn(v.asBytes())));
      if (v instanceof PDFLib.PDFDict) {
        var sig = isSignature(v), entries = v.entries();
        for (var k = 0; k < entries.length; k++) {
          if (sig && entries[k][0] === N('Contents')) continue;
          var nv = await mapStrings(entries[k][1], fn);
          if (nv !== entries[k][1]) v.set(entries[k][0], nv);
        }
        return v;
      }
      if (v instanceof PDFLib.PDFArray) {
        for (var a = 0; a < v.size(); a++) {
          var el = v.get(a), nel = await mapStrings(el, fn);
          if (nel !== el) v.set(a, nel);
        }
        return v;
      }
      return v;
    }
    // The /Crypt filter of a stream (ISO 32000-1 7.4.10): '' when it has none, else the filter name.
    function cryptFilter(ctx, dict) {
      var f = ctx.lookup(dict.get(N('Filter'))), parms = ctx.lookup(dict.get(N('DecodeParms')));
      var names = f instanceof PDFLib.PDFArray ? f.asArray().map(function (x) { return nameOf(ctx.lookup(x)); }) : [nameOf(f)];
      var at = names.indexOf('Crypt');
      if (at < 0) return '';
      var p = parms instanceof PDFLib.PDFArray ? ctx.lookup(parms.get(at)) : parms;
      return (p instanceof PDFLib.PDFDict && nameOf(p.get(N('Name')))) || 'Identity';
    }
    function hasSignature(ctx) {
      var objects = ctx.enumerateIndirectObjects();
      for (var i = 0; i < objects.length; i++) {
        var o = objects[i][1];
        if (!(o instanceof PDFLib.PDFDict)) continue;
        if (isSignature(o)) return true;
        var v = o.get(N('V'));
        if (v instanceof PDFLib.PDFDict && isSignature(v)) return true;
      }
      return false;
    }
    function catalogMetadataRef(ctx) {
      var cat = ctx.lookup(ctx.trailerInfo.Root);
      var m = cat instanceof PDFLib.PDFDict ? cat.get(N('Metadata')) : null;
      return m instanceof PDFLib.PDFRef ? m : null;
    }

    // Decrypts every object of a parsed context in place, except those that came out of an object
    // stream (decrypted as a whole while parsing) and the encryption dictionary, then clears the
    // trailer's /Encrypt.
    async function decryptObjects(context, e, key, inner, metaRef) {
      var encRef = context.trailerInfo.Encrypt;
      var objects = context.enumerateIndirectObjects();
      var decrypt = function (ref) { return function (b) { return decryptData(e, key, ref, b, e.str); }; };
      for (var k = 0; k < objects.length; k++) {
        var ref = objects[k][0], obj = objects[k][1];
        if (inner.has(ref.tag) || (encRef instanceof PDFLib.PDFRef && ref === encRef)) continue;
        if (obj instanceof PDFLib.PDFRawStream) {
          var tname = nameOf(obj.dict.get(N('Type')));
          if (tname === 'XRef') continue;
          await mapStrings(obj.dict, decrypt(ref));
          if (cryptFilter(context, obj.dict)) continue;            // an /Identity crypt filter: left as it is
          if (ref === metaRef && !e.encryptMetadata) continue;      // EncryptMetadata false: only the catalogue's
          obj.contents = await decryptData(e, key, ref, obj.contents, tname === 'EmbeddedFile' ? e.eff : e.stm);
        } else {
          // An indirect object can be a string itself (a /Title or a field value kept as "12 0 R"):
          // mapStrings returns a new object for it, which must replace the old one.
          var plain = await mapStrings(obj, decrypt(ref));
          if (plain !== obj) context.assign(ref, plain);
        }
      }
      context.trailerInfo.Encrypt = undefined;
    }

    // What protects a file, without its password. Throws .code 'UNSUPPORTED' or 'DAMAGED'.
    async function inspect(bytes) {
      var probe = await parse(bytes, { mode: 'skip' });
      // No catalogue in the trailer (or cross-reference stream): not a readable PDF.
      if (!probe.trailerInfo.Root) throw fail('DAMAGED');
      var e = readEncrypt(probe);
      if (!e) return { encrypted: false, signed: hasSignature(probe) };
      var objects = probe.enumerateIndirectObjects();
      for (var i = 0; i < objects.length; i++) {
        var o = objects[i][1];
        if (o instanceof PDFLib.PDFRawStream) {
          var cf = cryptFilter(probe, o.dict);
          if (cf && cf !== 'Identity') throw unsupported('cryptfilter');
        }
      }
      return {
        encrypted: true, V: e.V, R: e.R, P: e.P, cipher: e.cipher, restrictions: restrictions(e),
        emptyOwner: !!(await ownerKey(e, '')), emptyUser: !!(await userKey(e, '')), signed: hasSignature(probe)
      };
    }

    // Opens the file with the password for reading and changing it in pdf-lib.
    // Returns { doc, encrypted, security }; throws .code 'PASSWORD' or 'UNSUPPORTED'.
    async function open(bytes, password) {
      var probe = await parse(bytes, { mode: 'skip' });
      var e = readEncrypt(probe, true);
      if (!e) return { doc: await PDFLib.PDFDocument.load(bytes, { updateMetadata: false }), encrypted: false, security: null };
      probe = null;
      var found = await findKey(e, password || '', false);
      if (!found.key && !e.attachmentsOnly) throw fail('PASSWORD');
      var state = { mode: 'decrypt', e: e, key: found.key, inner: new Set() };
      var context = await parse(bytes, state);
      var metaRef = catalogMetadataRef(context);
      await decryptObjects(context, e, found.key, state.inner, metaRef);
      var security = {
        access: found.access, key: found.key,
        method: e.V >= 5 ? 'AES-256' : (e.V === 4 && e.stm === 'AESV2') ? 'AES-128' : 'RC4',
        keyBits: e.V >= 5 ? 256 : e.length * 8, cipher: e.cipher, V: e.V, R: e.R,
        stm: e.stm, str: e.str, eff: e.eff, encryptMetadata: e.encryptMetadata,
        P: e.P, permissions: bits(e), restrictions: restrictions(e), ref: e.ref, metadataRef: metaRef
      };
      return { doc: new PDFLib.PDFDocument(context, true, false), encrypted: true, security: security };
    }

    // Opens the file with the password: the permissions password first, then a blank one, then
    // the open password (typed or blank), unless ownerOnly. Returns { access: 'owner' | 'user' | null, ... }.
    async function unlock(bytes, password, ownerOnly) {
      var probe = await parse(bytes, { mode: 'skip' });
      var e = readEncrypt(probe);
      if (!e) return { access: 'none' };
      probe = null;
      var found = await findKey(e, password, ownerOnly), key = found.key, access = found.access;
      if (!key) return { access: null };
      var state = { mode: 'decrypt', e: e, key: key, inner: new Set() };
      var context = await parse(bytes, state);
      var encRef = context.trailerInfo.Encrypt, metaRef = catalogMetadataRef(context);
      await decryptObjects(context, e, key, state.inner, metaRef);
      // The old dictionary would otherwise be written out as an orphan, and its /O and /U let
      // anyone with the copy test guesses at the original passwords.
      if (encRef instanceof PDFLib.PDFRef) context.delete(encRef);
      // The trailer's /Size must be one more than the highest object number left.
      var highest = 0;
      context.enumerateIndirectObjects().forEach(function (o) { if (o[0].objectNumber > highest) highest = o[0].objectNumber; });
      context.largestObjectNumber = highest;
      var doc = new PDFLib.PDFDocument(context, true, false);
      var kept = access === 'user' ? restrictions(e) : [];
      if (kept.length) await encryptR6(doc, e, metaRef);
      // A plain copy keeps object streams when the original had them: without them, a file with many
      // small objects (links, a tagged structure tree) can come out several times larger. The AES-256
      // writer encrypts each string on its own, which object streams do not allow, so it never uses them.
      var out = await doc.save({ useObjectStreams: !kept.length && state.inner.size > 0, addDefaultPage: false, updateFieldAppearances: false });
      return { access: access, kept: kept, signed: hasSignature(context), bytes: out };
    }

    // ---- Encrypting objects for a file opened with open(): an incremental update, or a rewrite
    // that keeps the original encryption dictionary and /ID ----
    function isObject(ref, objectNumber, generation) {
      return !!ref && ref.objectNumber === objectNumber && ref.generationNumber === generation;
    }
    async function encrypt(security, data, objectNumber, generation, kind) {
      var method = kind === 'string' ? security.str : kind === 'file' ? security.eff : security.stm;
      if (method === 'None') return data;
      if (!security.key) throw fail('PASSWORD');
      var ref = { objectNumber: objectNumber, generationNumber: generation || 0 };
      if (method === 'AESV2' || method === 'AESV3') return aesEncrypt(objectKey(security, security.key, ref, true), data);
      return rc4(objectKey(security, security.key, ref, false), data);
    }
    // A copy with each string mapped through fn, except a signature's /Contents; references and
    // other objects are kept.
    async function sealed(v, fn) {
      if (v instanceof PDFLib.PDFString || v instanceof PDFLib.PDFHexString) return PDFLib.PDFHexString.of(hex(await fn(v.asBytes())));
      var i, out;
      if (v instanceof PDFLib.PDFDict) {
        var sig = isSignature(v), entries = v.entries();
        out = PDFLib.PDFDict.withContext(v.context);
        for (i = 0; i < entries.length; i++) {
          var keep = sig && entries[i][0] === N('Contents');
          out.set(entries[i][0], keep ? entries[i][1] : await sealed(entries[i][1], fn));
        }
        return out;
      }
      if (v instanceof PDFLib.PDFArray) {
        out = PDFLib.PDFArray.withContext(v.context);
        for (i = 0; i < v.size(); i++) out.push(await sealed(v.get(i), fn));
        return out;
      }
      return v;
    }
    async function encryptObject(security, object, objectNumber, generation) {
      var g = generation || 0;
      if (isObject(security.ref, objectNumber, g)) return object;
      var str = function (b) { return encrypt(security, b, objectNumber, g, 'string'); };
      if (!(object instanceof PDFLib.PDFStream)) return sealed(object, str);
      var type = nameOf(object.dict.get(N('Type')));
      if (type === 'XRef') return object;
      var data = object instanceof PDFLib.PDFRawStream ? object.contents : object.getContents();
      var clear = cryptFilter(object.dict.context, object.dict) || (!security.encryptMetadata && isObject(security.metadataRef, objectNumber, g));
      if (!clear) data = await encrypt(security, data, objectNumber, g, type === 'EmbeddedFile' ? 'file' : 'stream');
      return PDFLib.PDFRawStream.of(await sealed(object.dict, str), data);
    }

    // ---- AES-256 (R6) writer: an empty open password, a random permissions password and the
    // original permissions (ISO 32000-2 Algorithms 8, 9 and 10) ----
    async function encryptR6(doc, e, metaRef) {
      var ctx = doc.context, H = function (b) { return PDFLib.PDFHexString.of(hex(b)); };
      var fileKey = random(32), ownerPw = utf8(hex(random(16))), none = new Uint8Array(0), zero = new Uint8Array(16);
      var uvs = random(8), uks = random(8), ovs = random(8), oks = random(8);
      var U = concat(await hash6(none, uvs, none, 6), uvs, uks);
      var UE = await aesEncryptNoPad(await hash6(none, uks, none, 6), zero, fileKey);
      var O = concat(await hash6(ownerPw, ovs, U, 6), ovs, oks);
      var OE = await aesEncryptNoPad(await hash6(ownerPw, oks, U, 6), zero, fileKey);
      var P = permsR6(e), block = new Uint8Array(16);
      new DataView(block.buffer).setInt32(0, P, true);
      block.set([0xFF, 0xFF, 0xFF, 0xFF, e.encryptMetadata ? 0x54 : 0x46, 0x61, 0x64, 0x62], 4);
      block.set(random(4), 12);
      var Perms = await aesEncryptNoPad(fileKey, zero, block);   // one block: CBC with a zero IV is ECB
      var enc = function (data) { return aesEncrypt(fileKey, data); };
      var objects = ctx.enumerateIndirectObjects();
      for (var i = 0; i < objects.length; i++) {
        var ref = objects[i][0], obj = objects[i][1];
        if (obj instanceof PDFLib.PDFRawStream) {
          await mapStrings(obj.dict, enc);
          if (cryptFilter(ctx, obj.dict)) continue;
          if (ref === metaRef && !e.encryptMetadata) continue;
          obj.contents = await enc(obj.contents);
        } else if (obj instanceof PDFLib.PDFStream) {
          throw new Error('unexpected stream');
        } else {
          var sealedObj = await mapStrings(obj, enc);
          if (sealedObj !== obj) ctx.assign(ref, sealedObj);
        }
      }
      var dict = {
        Filter: 'Standard', V: 5, R: 6, Length: 256, P: P, O: H(O), U: H(U), OE: H(OE), UE: H(UE), Perms: H(Perms),
        CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF'
      };
      if (!e.encryptMetadata) dict.EncryptMetadata = false;
      ctx.trailerInfo.Encrypt = ctx.register(ctx.obj(dict));
      if (!ctx.trailerInfo.ID) { var id = H(random(16)); ctx.trailerInfo.ID = ctx.obj([id, id]); }
      // AES-256 is native to PDF 2.0; a PDF 1.x file declares Adobe's extension level 8, as qpdf does.
      if (!ctx.header || String(ctx.header).indexOf('%PDF-2') !== 0) {
        ctx.header = PDFLib.PDFHeader.forVersion(1, 7);
        var ext = doc.catalog.lookup(N('Extensions'));
        if (!(ext instanceof PDFLib.PDFDict)) { ext = ctx.obj({}); doc.catalog.set(N('Extensions'), ext); }
        ext.set(N('ADBE'), ctx.obj({ BaseVersion: N('1.7'), ExtensionLevel: 8 }));
      }
    }

    return { open: open, inspect: inspect, unlock: unlock, encrypt: encrypt, encryptObject: encryptObject, pdfjsPasswords: pdfjsPasswords, md5: md5, rc4: rc4 };
  }{% endraw %}