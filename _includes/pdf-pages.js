{%- comment -%}
  The engine of the PDF page tools (PDF to JPG, PDF to PNG), whose markup and styles are the parts
  of _includes/pdf-pages.html. It opens a PDF with PDF.js (with the password prompt), draws page
  thumbnails as they scroll into view, keeps the page choice (a list such as 1-3, 5, clicks, a drag,
  touch and hold), draws pages on a canvas at a DPI (at a lower one when the browser cannot hold that
  many pixels), runs the conversion with progress and Cancel, and saves one image or a ZIP file.
  PDF.js is imported with _includes/pdfjs-loader.js, which tries again after a failed download.

  A page puts it in a script after zip.js and png-kit.js, and starts it once:

    <script>
    {% raw %}{% include pdf-pages.js %}{% endraw %}   (passwords=true: see docPasswords below)
    (function () {
      var E = TTPdfPages({ p: 'p2j', settings: ..., planText: ..., convertPage: ... });
    })();
    </script>

  Config (only p, settings, planText and convertPage are required):
    p            prefix of the ids and classes, as given to pdf-pages.html.
    settings()   the page's settings, read from its controls every time: { key, format, dpi, errors }.
                 key holds every setting that changes the images (a result made with another key is
                 dropped at once); format is the file extension and the name in messages ('jpg');
                 errors is [{ field, text }] for the page's own fields that hold a mistake.
    fields       the page's own text fields, whose messages go in #<id>-error; Enter in one converts.
    controls()   the page's controls to disable while converting.
    sync()       shows and hides the page's options; also run after Back or Forward.
    planText(st, pk)  the summary above Convert (pk.pages: the chosen page numbers).
    convertPage(d, index, st, job) -> Promise<result>: makes page index (0-based) of the open PDF d
                 with settings st, or resolves to null if job.cancelled. A result is
                 { key: st.key, blob, w, h, dpi } plus reduced (true when the page was made smaller
                 than asked; by default when dpi differs from st.dpi) and size (bytes, for maxBytes).
    canDownload(r)  false hides a page's Download button although it has a result.
    drawn(st, pk)   told after every redraw; saved(r, st) after a conversion was saved.
    Optional texts and steps, each defaulting to PDF to JPG's: goLabel(st, pk), idleLabel(st),
    infoHtml(i, st, r, size), dlLabel(i, r, st), startText(st, pages), stepText(p, k, n),
    workingText, outputs(pages, st) -> [{ name, blob, w, h }], zipName(st, d),
    savedText(r, st, reduced), emptyText(st, pages), cardDownload(i, r, st).
    card(c, i, st, r, put)  draws the page's own parts of a page card (cardHtml adds them, as HTML).
    busy(on), closed()     told when converting starts and ends, and when a PDF is closed.
    keys         true: arrow keys move between the pages (one tab stop), Space picks, Enter converts.
    docPasswords true: a password that PDF.js refuses is tried again as the other byte sequences
                 that _includes/pdf-unlocker.js tries; the page includes this file with
                 passwords=true, which brings in that unlocker.
    maxBytes     stop converting once the images take this many bytes (default: no limit).

  It returns the engine (see the end of the file). Hooks are called only once a PDF is open,
  except sync, so they may use the returned engine.
{%- endcomment -%}
window.TTPdfPages = (function () {
  'use strict';
  var PDFJS_URL = new URL({{ '/assets/vendor/pdfjs/pdf.min.js' | relative_url | jsonify }}, location.href).href;
  var PDFJS_WORKER = new URL({{ '/assets/vendor/pdfjs/pdf.worker.min.js' | relative_url | jsonify }}, location.href).href;
  var PDFJS_WASM = new URL({{ '/assets/vendor/pdfjs/wasm/' | relative_url | jsonify }}, location.href).href;
  var PDFJS_RES = new URL({{ '/assets/vendor/pdfjs-resources/' | relative_url | jsonify }}, location.href).href;
{%- if include.passwords %}
  // The standard security handler shared by the PDF tools, for its pdfjsPasswords (see docPasswords).
{% include pdf-unlocker.js %}
{%- endif %}
  // The PDF.js loader shared by the PDF tools: after a failed try it asks for the module under
  // another address, which the browser would otherwise refuse again until the page is reloaded.
{% include pdfjs-loader.js %}
  {% raw %}
  return function (cfg) {
  var P = cfg.p;
  var $ = TT.$, $$ = TT.$$;
  var el = function (name) { return $('#' + P + '-' + name); };
  var root = $('#' + P), fileInput = el('file'), dropZone = el('drop'), work = el('work'), grid = el('grid');
  var errBox = el('error'), statusBox = el('status'), planBox = el('plan'), pagesIn = el('pages');
  var goBtn = el('go'), cancelBtn = el('cancel'), progressBox = el('progress'), bar = el('bar'), pct = el('pct');
  var unlockBox = el('unlock'), pwIn = el('pw'), pwErr = el('pw-error');
  var FIELDS = (cfg.fields || []).concat([pagesIn]);
  var MAX_FILE = 1024 * 1024 * 1024, MAX_TEXT = 10000;
  // The most pixels one page may have: a canvas this big needs 256 MB (touch devices: 144 MB). The
  // browser may allow fewer, which is checked on the canvas itself before drawing.
  var TOUCH = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  var MAX_PIXELS = TOUCH ? 36e6 : 64e6, MAX_SIDE = 32767;
  var MAX_BYTES = cfg.maxBytes || Infinity;

  var doc = null;      // the open PDF: { id, file, name, size, pdf, n, password, encrypted, sizes }
  var pending = null;  // a PDF that is being opened
  // Convert does nothing while a chosen file is checked or opened: that PDF replaces the one on screen,
  // and a page drawn from the old one would be saved under the new name.
  var checking = 0, opening = null;
  var cards = [];      // per page: { el, img, cb, info, dl, thumb, queued, last }
  var selected = [];   // per page, always read from the page field
  var done = [];       // per page: the result made with the settings in its key
  var anchor = -1, busy = false, nextId = 1, errTimer = 0, current = null, rove = -1;

  // ---------- small helpers ----------
  var NUM = new Intl.NumberFormat('en-GB');
  // A no-break space keeps a size and its unit on one line: "23 KB", never "23" and "KB".
  function fmtBytes(n) {
    if (n < 1024) return n + '\u00a0B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + '\u00a0KB';
    return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + '\u00a0MB';
  }
  function plural(n, one, many) { return NUM.format(n) + ' ' + (n === 1 ? one : many); }
  function setError(t) { errBox.textContent = t || ''; }
  // An error whose message is written for visitors. Other messages, such as PDF.js's "Invalid page
  // request.", are written for programmers and are never shown.
  function friendly(text) { var e = new Error(text); e.friendly = true; return e; }
  var REPAIR = 'It may be damaged; try saving it again from the app that made it.';
  function say(t, again) {
    t = t || '';
    if (statusBox.textContent !== t) { statusBox.textContent = t; return; }
    if (again && t) { statusBox.textContent = ''; setTimeout(function () { statusBox.textContent = t; }, 60); }
  }
  function baseName(n) { return String(n || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'document'; }
  function shorten(s, max) { var cps = Array.from(s); return cps.length > max ? cps.slice(0, max).join('') + '…' : s; }
  function dash(a, b) { return a === b ? String(a) : a + '–' + b; }
  function firstError(st) { return st.errors && st.errors.length ? st.errors[0] : null; }
  // A helper script (assets/js/png-kit.js, zip.js) that did not load is named as such, not as a damaged page.
  function needs(name) { if (!window[name]) throw friendly('part of this page did not load; reload it and try again'); return window[name]; }
  // A whole number typed in a field: ASCII, full-width or Arabic-Indic digits only, so no sign,
  // separator, decimal point, raised digit or space inside it. { n }, or { error: 'chars' } for
  // anything else (also more than 12 characters, checked first) or { error: 'empty' }.
  function readWhole(text) {
    var s = String(text).trim(), v = '';
    if (s.length > 12) return { error: 'chars' };
    for (var i = 0; i < s.length; i++) {
      var d = digitOf(s.charCodeAt(i));
      if (d < 0) return { error: 'chars' };
      v += d;
    }
    return v ? { n: parseInt(v, 10) } : { error: 'empty' };
  }

  // ---------- page lists: "1-3, 5, 8-end" (as in the Split PDF tool) ----------
  var DASHES = '-‐‑‒–—―−﹘﹣－~～〜';
  var SEPS = ',;，、；،؛';
  function digitOf(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 0xFF10 && c <= 0xFF19) return c - 0xFF10;
    if (c >= 0x660 && c <= 0x669) return c - 0x660;
    if (c >= 0x6F0 && c <= 0x6F9) return c - 0x6F0;
    return -1;
  }
  function tokenize(s) {
    var toks = [], i = 0;
    while (i < s.length) {
      var c = s.charCodeAt(i), ch = s[i];
      if (digitOf(c) >= 0) {
        var v = '';
        while (i < s.length && digitOf(s.charCodeAt(i)) >= 0) { v += digitOf(s.charCodeAt(i)); i++; }
        toks.push({ t: 'num', v: v });
      } else if (DASHES.indexOf(ch) >= 0) { toks.push({ t: 'dash' }); i++; }
      else if (SEPS.indexOf(ch) >= 0) { toks.push({ t: 'sep' }); i++; }
      else if (/\s/.test(ch)) { i++; }
      else if (/[a-z]/i.test(ch)) {
        var w = '';
        while (i < s.length && /[a-z]/i.test(s[i])) { w += s[i]; i++; }
        var lw = w.toLowerCase();
        if (lw === 'end' || lw === 'last') toks.push({ t: 'end' });
        else if (lw === 'to') toks.push({ t: 'dash' });
        else if (lw === 'and') toks.push({ t: 'sep' });
        else if (lw === 'all') toks.push({ t: 'all' });
        else return { error: '“' + shorten(w, 24) + '” is not a page number. Use numbers, dashes and commas, such as 1-3, 5.' };
      } else {
        var cp = String.fromCodePoint(s.codePointAt(i));
        // A character that does not show (a zero-width space, a control character) is named by its code.
        if (/[\p{C}\p{M}]/u.test(cp)) cp = 'A hidden character (U+' + s.codePointAt(i).toString(16).toUpperCase().padStart(4, '0') + ')';
        else cp = '“' + cp + '”';
        return { error: cp + ' cannot be used in a page list. Use numbers, dashes and commas, such as 1-3, 5.' };
      }
    }
    return { toks: toks };
  }
  var ONE_DASH = 'A range has one dash, as in 4-7. Separate ranges with commas: 1-3, 5.';
  function parseList(text, n) {
    if (text.length > MAX_TEXT) return { error: 'This list is ' + NUM.format(text.length) + ' characters long. Keep it under ' + NUM.format(MAX_TEXT) + ' characters.' };
    var tk = tokenize(text);
    if (tk.error) return tk;
    var toks = tk.toks, items = [], k = 0;
    function atom(t) { return t && (t.t === 'num' || t.t === 'end'); }
    function val(t) { if (t.t === 'end') return n; var v = t.v.replace(/^0+(?=\d)/, ''); return v.length > 9 ? Infinity : parseInt(v, 10); }
    function shown(t) { return t.t === 'end' ? 'end' : shorten(t.v.replace(/^0+(?=\d)/, ''), 12); }
    while (k < toks.length) {
      var t = toks[k], a = null, b = null, at = null, bt = null;
      if (t.t === 'sep') { k++; continue; }
      if (t.t === 'all') {
        items.push({ a: 1, b: n });
        k++;
        if (toks[k] && toks[k].t === 'dash') return { error: ONE_DASH };
        continue;
      }
      if (atom(t)) { at = t; a = val(t); k++; }
      if (toks[k] && toks[k].t === 'dash') {
        k++;
        if (toks[k] && toks[k].t === 'dash') return { error: 'Two dashes in a row: write a range as 4-7.' };
        // "5-all" is not read as 5-end followed by every page.
        if (toks[k] && toks[k].t === 'all') return { error: 'A range ends with a page number or “end”, as in 5-end.' };
        if (atom(toks[k])) { bt = toks[k]; b = val(toks[k]); k++; }
        else if (a === null) return { error: 'A dash needs a page number before or after it, as in 4-7.' };
        else b = n;
        if (a === null) a = 1;
        // "1-3-5" is not read as 1-3 and an open range -5.
        if (toks[k] && toks[k].t === 'dash') return { error: ONE_DASH };
      } else if (a === null) {
        return { error: 'A page list starts with a page number, such as 1-3, 5.' };
      } else b = a;
      if (a === 0 || b === 0) return { error: 'There is no page 0: the first page is 1.' };
      if (a > n || b > n) {
        var big = a > n ? at : bt;
        return { error: 'Page ' + (big ? shown(big) : NUM.format(Math.max(a, b))) + ' does not exist: this PDF has ' + plural(n, 'page', 'pages') + '.' };
      }
      items.push({ a: a, b: b });
    }
    return { items: items };
  }
  function compact(list) {
    var out = [], i = 0;
    while (i < list.length) {
      var a = list[i], b = a;
      while (i + 1 < list.length && list[i + 1] === b + 1) { i++; b++; }
      out.push(a === b ? String(a) : a + '-' + b);
      i++;
    }
    return out.join(', ');
  }
  function listText(pages) {
    var runs = [], i = 0;
    while (i < pages.length) {
      var a = pages[i], b = a;
      while (i + 1 < pages.length && pages[i + 1] === b + 1) { i++; b++; }
      runs.push(dash(a, b));
      i++;
    }
    if (runs.length > 5) runs = runs.slice(0, 3).concat(['…', runs[runs.length - 1]]);
    return runs.length === 1 ? runs[0] : runs.slice(0, -1).join(', ') + ' and ' + runs[runs.length - 1];
  }
  // "All 3 pages", "The page", "Pages 1 and 3": the start of a summary.
  function pagesPhrase(pages) {
    var n = pages.length;
    return n === doc.n ? (n === 1 ? 'The page' : 'All ' + NUM.format(n) + ' pages') : (n === 1 ? 'Page ' : 'Pages ') + listText(pages);
  }

  // The pages to convert, read from the page field; also updates the ticks on the thumbnails.
  function pickedPages() {
    var r = parseList(pagesIn.value, doc.n);
    if (r.error) return { error: r.error };
    var on = new Uint8Array(doc.n);
    r.items.forEach(function (it) { var lo = Math.min(it.a, it.b), hi = Math.max(it.a, it.b); for (var q = lo; q <= hi; q++) on[q - 1] = 1; });
    var list = [];
    for (var q = 0; q < doc.n; q++) { selected[q] = !!on[q]; if (on[q]) list.push(q + 1); }
    if (!list.length) return { error: 'Select at least one page: click it below or type its number.', empty: true, pages: list };
    return { pages: list };
  }
  // Pixel size of a page (or part of one, { w, h } in points) at a DPI, and the DPI actually used when
  // the browser cannot hold that many pixels.
  function pixelsFor(size, dpi) {
    var w = Math.max(1, Math.round(size.w * dpi / 72)), h = Math.max(1, Math.round(size.h * dpi / 72)), used = dpi;
    var k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)), MAX_SIDE / w, MAX_SIDE / h);
    if (k < 1) {
      used = Math.max(1, Math.floor(dpi * k + 1e-9));
      w = Math.max(1, Math.round(size.w * used / 72));
      h = Math.max(1, Math.round(size.h * used / 72));
    }
    return { w: w, h: h, dpi: used };
  }

  // ---------- pdf.js, loaded on first use (pdfjsLoader, from _includes/pdfjs-loader.js) ----------
  var pdfjs = null, pdfjsWorker = null;
  var importPdfjs = pdfjsLoader(PDFJS_URL, PDFJS_WORKER, function (lib) {
    pdfjs = lib;
    pdfjsWorker = new lib.PDFWorker({ verbosity: 0 });
  });
  function loadPdfjs() {
    return importPdfjs().catch(function () {
      throw friendly('The PDF reader could not load. Check your connection and try again.');
    });
  }
  function openPdf(d, password) {
    return loadPdfjs().then(function (lib) {
      return d.file.arrayBuffer().then(function (buf) {
        var task = lib.getDocument({
          data: new Uint8Array(buf), password: password || undefined, worker: pdfjsWorker, verbosity: 0,
          wasmUrl: PDFJS_WASM, cMapUrl: PDFJS_RES + 'cmaps/', cMapPacked: true,
          standardFontDataUrl: PDFJS_RES + 'standard_fonts/', iccUrl: PDFJS_RES + 'iccs/'
        });
        // docPasswords: PDF.js reads an RC4 or AES-128 password as the low byte of each character, so a
        // password with the euro sign or another character PDFDocEncoding places elsewhere is tried
        // again as the other bytes the shared unlocker tries (PDFDocEncoding, UTF-8, Windows-1252),
        // as Split PDF and Merge PDF do. A last refusal still reads as a wrong password.
        var tries = cfg.docPasswords && password && typeof pdfUnlocker === 'function' ? pdfUnlocker(null).pdfjsPasswords(password) : [], next = 1;
        if (tries.length > 1) {
          task.onPassword = function (retry, reason) {
            if (reason === lib.PasswordResponses.INCORRECT_PASSWORD && next < tries.length) { retry(tries[next++]); return; }
            var e = new Error('Incorrect password');
            e.name = 'PasswordException';
            retry(e);
          };
        }
        d.task = task;
        return task.promise;
      });
    });
  }

  // ---------- opening a file ----------
  function isPdf(bytes) {
    var head = new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength));
    for (var i = 0; i + 4 < head.length; i++) {
      if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2D) return true;
    }
    return false;
  }
  function chooseFiles(list, how) {
    var all = Array.prototype.slice.call(list || []);
    if (!all.length) return Promise.resolve();
    var file = all[0];
    // The PDF on screen is being converted; the message is cleared when that ends.
    if (busy) { setError('Wait until the conversion finishes, or press Cancel, then ' + (how || 'choose') + ' ' + file.name + ' again.'); return Promise.resolve(); }
    var note = all.length > 1 ? 'This tool converts one PDF at a time, so only ' + file.name + ' was opened.' : '';
    setError('');
    if (file.size > MAX_FILE) { setError(file.name + ' is larger than 1 GB.'); return Promise.resolve(); }
    if (!file.size) { setError(file.name + ' is empty.'); return Promise.resolve(); }
    checking++;
    return file.slice(0, 1024).arrayBuffer().then(function (head) {
      checking--;
      if (!isPdf(head)) { setError(file.name + ' is not a PDF file.'); return; }
      var d = { id: nextId++, file: file, name: file.name, size: file.size, password: '' };
      pending = d;
      hideUnlock();
      say('Opening ' + file.name + '…');
      return tryOpen(d, '').then(function () { if (note && doc === d) setError(note); });
    }, function () { checking--; setError(file.name + ' could not be read.'); });
  }
  function failOpen(d, text) {
    pending = null;
    hideUnlock();
    say('');
    setError(text);
  }
  // PDF.js's message is read to tell the cause, never shown.
  function openError(d, err) {
    var why = err ? (err.name || '') + ' ' + (err.message || '') : '';
    if (err && err.friendly) return err.message;
    if (/Invalid PDF|FormatError|Invalid XRef|InvalidPDF/i.test(why)) return d.name + ' is damaged or is not a valid PDF.';
    if (/encryption|security handler/i.test(why)) return d.name + ' uses a kind of encryption this tool cannot open.';
    return d.name + ' could not be opened. ' + REPAIR;
  }
  function tryOpen(d, password) {
    opening = d;
    function settled() { if (opening === d) opening = null; }
    return openPdf(d, password).then(function (pdf) {
      if (pending !== d) { pdf.loadingTask.destroy(); return; }
      // Some broken exporters write a PDF whose page tree is empty (PDF.js reads a /Count of -1 as is).
      if (!(pdf.numPages >= 1)) { pdf.loadingTask.destroy(); failOpen(d, d.name + ' has no pages, so there is nothing to convert. ' + REPAIR); return; }
      var info = {};
      return pdf.getMetadata().then(function (meta) { info = meta && meta.info || {}; }, function () { /* metadata is optional */ })
        // The first page's size is known before the summary is first written, so it is announced once.
        .then(function () { return pdf.getPage(1); }).then(function (first) {
          if (pending !== d) { pdf.loadingTask.destroy(); return; }
          pending = null;
          d.password = password || '';
          d.encrypted = !!info.EncryptFilterName;
          showDoc(d, pdf, first);
        }).catch(function (err) {
          if (pending !== d) return;
          failOpen(d, openError(d, err));
        });
    }, function (err) {
      if (pending !== d) return;
      if (err && err.name === 'PasswordException') { showUnlock(d, !!password); return; }
      failOpen(d, openError(d, err));
    }).then(settled, function (err) { settled(); throw err; });
  }
  function showUnlock(d, wrong) {
    unlockBox.hidden = false;
    el('pw-label').textContent = 'Password for ' + d.name;
    if (wrong) {
      pwErr.textContent = 'That password is not right. Check it and try again.';
      pwIn.setAttribute('aria-invalid', 'true');
    } else {
      pwErr.textContent = '';
      pwIn.removeAttribute('aria-invalid');
      pwIn.value = '';
    }
    say(wrong ? '' : d.name + ' is protected with a password. Enter the password that opens it.');
    pwIn.focus();
    if (wrong) pwIn.select();
  }
  function hideUnlock() {
    unlockBox.hidden = true;
    pwErr.textContent = '';
    pwIn.removeAttribute('aria-invalid');
    pwIn.value = '';
  }
  function unlock() {
    var d = pending;
    if (!d || busy) return;
    if (!pwIn.value) {
      pwErr.textContent = 'Type the password first.';
      pwIn.setAttribute('aria-invalid', 'true');
      pwIn.focus();
      return;
    }
    say('Opening ' + d.name + '…');
    tryOpen(d, pwIn.value);
  }
  function closeDoc() {
    if (doc && doc.pdf) doc.pdf.loadingTask.destroy();
    cards.forEach(function (c) { if (c.thumb) URL.revokeObjectURL(c.thumb); if (observer) observer.unobserve(c.el); });
    cards = [];
    thumbQueue = [];
    done = [];
    grid.textContent = '';
    doc = null;
    rove = -1;
    if (cfg.closed) cfg.closed();
  }
  function showDoc(d, pdf, first) {
    closeDoc();
    hideUnlock();
    d.pdf = pdf;
    d.n = pdf.numPages;
    d.sizes = new Array(d.n);
    doc = d;
    noteSize(d, 0, first);
    selected = new Array(d.n).fill(true);
    anchor = -1;
    pagesIn.value = compact(Array.from({ length: d.n }, function (_, i) { return i + 1; }));
    el('name').textContent = d.name;
    el('meta').textContent = plural(d.n, 'page', 'pages') + ' · ' + fmtBytes(d.size) + (d.encrypted ? ' · unlocked' : '');
    el('count').textContent = plural(d.n, 'page', 'pages');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < d.n; i++) frag.appendChild(buildCard(i));
    grid.appendChild(frag);
    root.classList.remove('is-empty');
    work.hidden = false;
    refresh(true);
    say(d.name + ' is open: ' + plural(d.n, 'page', 'pages') + (d.encrypted ? ', unlocked' : '') + '.');
    readSizes(d);
  }
  // Page sizes in points (with /Rotate and /UserUnit applied), read in the background for the
  // pixel size shown on each page.
  function readSizes(d) {
    var i = 0;
    function next() {
      if (doc !== d || i >= d.n) return;
      var k = i++;
      if (d.sizes[k]) { next(); return; }
      d.pdf.getPage(k + 1).then(function (page) {
        noteSize(d, k, page);
        if (k % 50 === 49) setTimeout(next, 0); else next();
      }, function () { next(); });
    }
    next();
  }
  function noteSize(d, k, page) {
    if (d.sizes[k]) return;
    var vp = page.getViewport({ scale: 1 });
    d.sizes[k] = { w: vp.width, h: vp.height };
    if (doc === d && !renderQueued) {
      renderQueued = true;
      requestAnimationFrame(function () { renderQueued = false; render(); });
    }
  }
  var renderQueued = false;

  // ---------- thumbnails, drawn when they scroll into view ----------
  var thumbQueue = [], thumbBusy = 0, thumbWaiters = [];
  var observer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      observer.unobserve(en.target);
      var c = cards[Number(en.target.dataset.i)];
      if (c && c.el === en.target) queueThumb(c, Number(en.target.dataset.i));
    });
  }, { rootMargin: '300px 0px' }) : null;
  function queueThumb(c, i) {
    if (c.thumb || c.queued) return;
    c.queued = true;
    thumbQueue.push({ c: c, i: i, d: doc });
    pumpThumbs();
  }
  function pumpThumbs() {
    while (thumbBusy < 2 && thumbQueue.length && !busy) {
      var job = thumbQueue.shift();
      if (job.d !== doc) continue;
      thumbBusy++;
      drawThumb(job).catch(function () { /* the placeholder stays */ }).then(function () {
        thumbBusy--;
        if (!thumbBusy) thumbWaiters.splice(0).forEach(function (done) { done(); });
        pumpThumbs();
      });
    }
  }
  // Resolves once no thumbnail is being drawn; none starts while converting. A drawn thumbnail
  // cleans its page up, which drops the images PDF.js decoded for that page, also those a
  // conversion reading the same page's pictures is about to take (see thumbsIdle in the API).
  function thumbsIdle() {
    return thumbBusy ? new Promise(function (done) { thumbWaiters.push(done); }) : Promise.resolve();
  }
  function drawThumb(job) {
    var d = job.d, c = job.c;
    return d.pdf.getPage(job.i + 1).then(function (page) {
      noteSize(d, job.i, page);
      var base = page.getViewport({ scale: 1 });
      var target = 170 * Math.min(2, window.devicePixelRatio || 1);
      var vp = page.getViewport({ scale: Math.min(4, target / Math.max(base.width, base.height)) });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      var ctx = canvas.getContext('2d', { alpha: false });
      return page.render({ canvasContext: ctx, canvas: canvas, viewport: vp }).promise.then(function () {
        page.cleanup();
        return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.82); });
      }).then(function (blob) {
        canvas.width = canvas.height = 0;
        if (!blob || d !== doc) return;
        c.thumb = URL.createObjectURL(blob);
        c.img.src = c.thumb;
        var w = TT.$('.' + P + '-wait', c.el);
        if (w) w.remove();
      });
    });
  }
  function buildCard(i) {
    var li = document.createElement('li');
    li.className = P + '-page';
    li.dataset.i = i;
    li.innerHTML = '<div class="' + P + '-thumb"><img alt="" draggable="false"><span class="' + P + '-wait">Loading…</span>' +
      '<span class="' + P + '-num"><span class="visually-hidden">Page </span>' + (i + 1) + '</span>' +
      '<input type="checkbox" class="' + P + '-check"></div><p class="' + P + '-info"></p>' +
      '<button type="button" class="btn secondary small ' + P + '-dl" hidden>Download</button>' + (cfg.cardHtml || '');
    var c = { el: li, img: TT.$('img', li), cb: TT.$('.' + P + '-check', li), info: TT.$('.' + P + '-info', li), dl: TT.$('.' + P + '-dl', li), last: {} };
    c.cb.setAttribute('aria-label', 'Page ' + (i + 1));
    c.cb.dataset.i = i;
    c.dl.dataset.i = i;
    // The first page is the tab stop until another is used; roveTo takes it from there.
    if (cfg.keys) { c.cb.tabIndex = i === 0 ? 0 : -1; if (i === 0) rove = 0; }
    cards[i] = c;
    if (observer) observer.observe(li); else queueThumb(c, i);
    return li;
  }

  // ---------- drawing the state ----------
  function put(c, key, fn, value) {
    if (c.last[key] === value) return;
    c.last[key] = value;
    fn(value);
  }
  function infoHtml(i, st) {
    var r = done[i], size = doc.sizes[i];
    if (cfg.infoHtml) return cfg.infoHtml(i, st, r && r.key === st.key ? r : null, size);
    if (r && r.key === st.key) return '<strong>' + r.w + ' × ' + r.h + '</strong> · ' + fmtBytes(r.blob.size) + (r.dpi !== st.dpi ? '<br>at ' + r.dpi + ' DPI' : '');
    if (!size || firstError(st)) return '';
    var px = pixelsFor(size, st.dpi);
    return px.w + ' × ' + px.h + ' px' + (px.dpi !== st.dpi ? '<br>at ' + px.dpi + ' DPI' : '');
  }
  function render() {
    if (!doc) return null;
    var st = cfg.settings(), pk = pickedPages();
    var fmt = st.format.toUpperCase();
    if (cfg.sync) cfg.sync(st);
    // Images made with other settings are dropped at once, so a Download button never gives an old image.
    for (var i = 0; i < done.length; i++) if (done[i] && done[i].key !== st.key) done[i] = null;
    cards.forEach(function (c, i) {
      var on = !!selected[i];
      if (c.cb.checked !== on) c.cb.checked = on;
      put(c, 'sel', function (v) { c.el.classList.toggle('is-selected', v); }, on);
      put(c, 'info', function (v) { c.info.innerHTML = v; }, c.working ? (typeof cfg.workingText === 'function' ? cfg.workingText(st) : cfg.workingText || 'Converting…') : infoHtml(i, st));
      var r = done[i];
      put(c, 'dl', function (v) { c.dl.hidden = !v; }, !!r && (!cfg.canDownload || cfg.canDownload(r)));
      put(c, 'dlName', function (v) { c.dl.setAttribute('aria-label', v); }, r ? (cfg.dlLabel ? cfg.dlLabel(i, r, st) : 'Download page ' + (i + 1) + ' as ' + fmt + ', ' + fmtBytes(r.blob.size)) : '');
      put(c, 'busy', function (v) { c.cb.disabled = v; }, busy);
      if (cfg.card) cfg.card(c, i, st, r, put);
    });
    var text = '', bad = !!firstError(st);
    if (!bad && !(pk.error && !pk.empty)) {
      if (pk.empty) text = pk.error;
      else text = cfg.planText(st, pk);
    }
    if (planBox.textContent !== text) planBox.textContent = text;
    var label = pk.error || bad ? (cfg.idleLabel ? cfg.idleLabel(st) : 'Convert') :
      cfg.goLabel ? cfg.goLabel(st, pk) : 'Convert ' + (pk.pages.length === 1 ? 'page ' + pk.pages[0] : plural(pk.pages.length, 'page', 'pages')) + ' to ' + fmt;
    if (goBtn.textContent !== label) goBtn.textContent = label;
    if (cfg.drawn) cfg.drawn(st, pk);
    return { st: st, pk: pk };
  }
  function showFieldError(field, text) {
    var box = $('#' + field.id + '-error');
    if (box.textContent !== text) box.textContent = text;
    if (text) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }
  // A mistake shows after a pause in typing, or at once when Convert is pressed; a message already on
  // screen is replaced at once, so it never describes an older value.
  function refresh(now) {
    var s = render();
    if (!s) return null;
    clearTimeout(errTimer);
    var want = Object.create(null), later = false;
    (s.st.errors || []).forEach(function (e) { if (!want[e.field.id]) want[e.field.id] = e.text; });
    if (s.pk.error && (!s.pk.empty || now === true)) want[pagesIn.id] = s.pk.error;
    FIELDS.forEach(function (f) {
      var msg = want[f.id] || '';
      if (!msg || now === true || $('#' + f.id + '-error').textContent) showFieldError(f, msg);
      else later = true;
    });
    if (later) errTimer = setTimeout(function () { FIELDS.forEach(function (f) { if (want[f.id]) showFieldError(f, want[f.id]); }); }, 700);
    return s;
  }
  function setBusy(on) {
    busy = on;
    progressBox.hidden = !on;
    cancelBtn.hidden = !on;
    [goBtn, el('another'), el('choose'), el('sample')].concat(cfg.controls ? cfg.controls() : [], FIELDS, $$('[data-pick]'))
      .forEach(function (e) { e.disabled = on; });
    $$('.' + P + '-seg').forEach(function (e) { e.classList.toggle('is-off', on); });
    if (cfg.busy) cfg.busy(on);
    render();
    if (!on) pumpThumbs();
  }

  // ---------- drawing a page ----------
  function canvasFits(canvas, ctx, w, h) {
    if (!ctx) return false;
    try {
      ctx.fillStyle = '#010203';
      ctx.fillRect(w - 1, h - 1, 1, 1);
      var px = ctx.getImageData(w - 1, h - 1, 1, 1).data;
      ctx.clearRect(w - 1, h - 1, 1, 1);
      return px[0] === 1 && px[1] === 2 && px[2] === 3 && px[3] === 255;
    } catch (e) { return false; }
  }
  // Draws page index of d on a new canvas. o = { dpi (a number, or a function of the page's size in
  // points), alpha, background, region: { x, y, w, h } (a part of the page as shown, in points),
  // images: true to note where pictures are drawn }. Resolves to { canvas, ctx, px: { w, h, dpi },
  // size, images (PDF.js's corners of each picture, as fractions of the canvas) }, or to null when
  // job was cancelled while the page was being read. The caller frees the canvas.
  function renderPage(d, index, o, job) {
    return d.pdf.getPage(index + 1).then(function (page) {
      // Cancel was pressed while the page was being read: nothing is drawn.
      if (job && job.cancelled) return null;
      noteSize(d, index, page);
      var size = d.sizes[index], area = o.region || size, dpi = typeof o.dpi === 'function' ? o.dpi(size) : o.dpi;
      var px = pixelsFor(area, dpi), canvas = null, ctx = null;
      // The browser may hold fewer pixels than MAX_PIXELS: then a smaller DPI is tried.
      for (var tries = 0; tries < 12; tries++) {
        canvas = document.createElement('canvas');
        canvas.width = px.w;
        canvas.height = px.h;
        ctx = canvas.getContext('2d', { alpha: !!o.alpha });
        if (canvasFits(canvas, ctx, px.w, px.h)) break;
        canvas.width = canvas.height = 0;
        ctx = null;
        var smaller = Math.floor(px.dpi * 0.8);
        if (smaller < 1) break;
        px = { w: Math.max(1, Math.round(area.w * smaller / 72)), h: Math.max(1, Math.round(area.h * smaller / 72)), dpi: smaller };
      }
      if (!ctx) throw friendly('this browser cannot make an image that large');
      var vp = page.getViewport({ scale: px.dpi / 72 }), s = px.dpi / 72, transform;
      // Stretches the drawing by less than a pixel, so it fills the whole-pixel canvas exactly; a
      // region is moved to the canvas's corner first.
      if (o.region) {
        var kx = px.w / (o.region.w * s), ky = px.h / (o.region.h * s);
        transform = [kx, 0, 0, ky, -o.region.x * s * kx, -o.region.y * s * ky];
      } else transform = [px.w / vp.width, 0, 0, px.h / vp.height, 0, 0];
      var params = { canvasContext: ctx, canvas: canvas, viewport: vp, transform: transform, background: o.background };
      if (o.images) { page.imageCoordinates = null; params.recordImages = true; }
      var task = page.render(params);
      d.renderTask = task;
      return task.promise.then(function () {
        d.renderTask = null;
        var images = o.images ? page.imageCoordinates : null;
        page.cleanup();
        return { canvas: canvas, ctx: ctx, px: px, size: size, images: images };
      }, function (err) {
        d.renderTask = null;
        canvas.width = canvas.height = 0;
        throw err;
      });
    });
  }
  function nameFor(i, st) {
    var w = String(doc.n).length, s = String(i + 1);
    while (s.length < w) s = '0' + s;
    return baseName(doc.name) + '-page-' + s + '.' + st.format;
  }
  function sizeOf(r) { return r ? (r.size !== undefined ? r.size : r.blob ? r.blob.size : 0) : 0; }
  // how.keep: the images are made but not saved, and the result is handed back (for Copy).
  // how.focus: where the focus goes at the end (default: Convert).
  function convert(how) {
    how = how || {};
    if (busy || !doc || checking || opening) return null;
    setError('');
    var s = refresh(true);
    if (!s) return null;
    var bad = firstError(s.st);
    if (bad) { bad.field.focus(); return null; }
    if (s.pk.error) { pagesIn.focus(); return null; }
    var st = s.st, pages = s.pk.pages, d = doc, job = current = { cancelled: false }, fails = [], reduced = [];
    var todo = pages.filter(function (p) { return !(done[p - 1] && done[p - 1].key === st.key); });
    var bytes = 0, stopped = null;
    pages.forEach(function (p) { if (done[p - 1] && done[p - 1].key === st.key) bytes += sizeOf(done[p - 1]); });
    // The status line keeps its place while converting: emptied, it would move the whole form up,
    // and down again when the result is written.
    say(cfg.startText ? cfg.startText(st, pages) : 'Converting ' + (pages.length === 1 ? 'page ' + pages[0] : plural(pages.length, 'page', 'pages')) + ' to ' + st.format.toUpperCase() + '…');
    setBusy(true);
    var k = 0;
    function step() {
      if (job.cancelled) return null;
      bar.value = Math.round(100 * k / Math.max(1, todo.length));
      if (k >= todo.length) return null;
      // The images made so far are as much as this device should hold at once: the rest is left.
      if (bytes > MAX_BYTES) { stopped = todo.slice(k); return null; }
      var p = todo[k], c = cards[p - 1];
      pct.textContent = cfg.stepText ? cfg.stepText(p, k, todo.length) : 'Converting page ' + p + ' (' + (k + 1) + ' of ' + todo.length + ')…';
      c.working = true;
      render();
      return cfg.convertPage(d, p - 1, st, job).then(function (r) {
        c.working = false;
        if (job.cancelled) return null;
        done[p - 1] = r;
        bytes += sizeOf(r);
        if (r.reduced !== undefined ? r.reduced : r.dpi !== st.dpi) reduced.push(p);
        k++;
        render();
        return step();
      }, function (err) {
        c.working = false;
        if (job.cancelled) return null;
        fails.push({ page: p, message: err && err.friendly ? err.message : 'it may be damaged' });
        k++;
        render();
        return step();
      });
    }
    return Promise.resolve().then(step).then(function () {
      if (job.cancelled) return null;
      var ready = pages.filter(function (p) { return done[p - 1] && done[p - 1].key === st.key; });
      var items = cfg.outputs ? cfg.outputs(ready, st) : ready.map(function (p) {
        var r = done[p - 1];
        return { name: nameFor(p - 1, st), blob: r.blob, w: r.w, h: r.h, page: p };
      });
      if (how.keep || !items.length) return { pages: ready, items: items };
      if (items.length === 1) return { pages: ready, items: items, name: items[0].name, blob: items[0].blob };
      pct.textContent = 'Making the ZIP file…';
      var name = cfg.zipName ? cfg.zipName(st, d) : baseName(d.name) + '-' + st.format + '.zip';
      return window.TTZip.create(items.map(function (it) { return { name: it.name, data: it.blob }; }), { compress: 'store' })
        .then(function (zip) { return { pages: ready, items: items, name: name, blob: zip, zip: true }; });
    }).then(function (r) {
      if (job.cancelled || !r) return null;
      current = null;
      setBusy(false);
      setError('');
      if (how.keep) {
        // The caller writes the status once it has used the image.
      } else if (r.items.length) {
        TT.download(r.name, r.blob);
        var fmt = st.format.toUpperCase();
        var msg = cfg.savedText ? cfg.savedText(r, st, reduced) : (r.zip ? 'Saved ' + r.name + ' with ' + plural(r.items.length, fmt + ' image', fmt + ' images') + ', ' + fmtBytes(r.blob.size) + '.' :
          'Saved ' + r.name + ': ' + r.items[0].w + ' × ' + r.items[0].h + ' pixels, ' + fmtBytes(r.blob.size) + '.');
        if (!cfg.savedText && reduced.length) msg += ' ' + (reduced.length === 1 ? 'Page ' + reduced[0] + ' is' : 'Pages ' + listText(reduced) + ' are') + ' too large for ' + st.dpi + ' DPI, so ' + (reduced.length === 1 ? 'it was' : 'they were') + ' converted at ' + (reduced.length === 1 ? done[reduced[0] - 1].dpi + ' DPI' : 'a lower DPI') + ', the most pixels one image can have here.';
        say(msg, true);
        if (cfg.saved) cfg.saved(r, st);
      } else say(cfg.emptyText && !fails.length ? cfg.emptyText(st, pages) : '');
      var problem = '';
      if (fails.length) problem = (fails.length === 1 ? 'Page ' + fails[0].page + ' could not be converted: ' + fails[0].message + '.' : 'Pages ' + listText(fails.map(function (f) { return f.page; })) + ' could not be converted.') + (r.pages.length ? (r.pages.length === 1 ? ' The other page was saved.' : ' The other pages were saved.') : '');
      if (stopped) problem += (problem ? ' ' : '') + (stopped.length === 1 ? 'Page ' + stopped[0] + ' was' : 'Pages ' + listText(stopped) + ' were') + ' not converted: the images already made take ' + fmtBytes(bytes) + ', as much as this device can safely hold at once. Convert ' + (stopped.length === 1 ? 'it' : 'them') + ' separately.';
      if (problem) setError(problem);
      (how.focus || goBtn).focus();
      r.fails = fails;
      r.stopped = stopped;
      r.reduced = reduced;
      return r;
    }, function (err) {
      if (job.cancelled) return null;
      current = null;
      setBusy(false);
      say('');
      // The ZIP maker explains its own limits (65,535 files, 4 GB); anything else is memory running out.
      setError('The images could not be saved. ' + (err && err.name === 'Error' && err.message ? err.message : 'The device may have run out of memory; try fewer pages or a lower DPI.'));
      return null;
    });
  }
  function cancel() {
    if (!busy || !current) return;
    current.cancelled = true;
    current = null;
    if (doc && doc.renderTask) { try { doc.renderTask.cancel(); } catch (e) { /* already finished */ } }
    cards.forEach(function (c) { c.working = false; });
    setBusy(false);
    setError('');
    var have = done.filter(Boolean).length;
    say('Cancelled. ' + (have ? plural(have, 'page is', 'pages are') + ' ready to download one by one below.' : 'Nothing was saved.'), true);
    goBtn.focus();
  }

  // ---------- selecting pages ----------
  function writePick() {
    var list = [];
    for (var i = 0; i < selected.length; i++) if (selected[i]) list.push(i + 1);
    pagesIn.value = compact(list);
  }
  function setSelection(fn) {
    for (var i = 0; i < selected.length; i++) selected[i] = !!fn(i, selected[i]);
    writePick();
    refresh();
  }
  var sweep = null, scrollRaf = 0;
  function cardAt(x, y) {
    var e = document.elementFromPoint(x, y), li = e && e.closest ? e.closest('.' + P + '-page') : null;
    return li && li.parentNode === grid ? Number(li.dataset.i) : -1;
  }
  function beginSweep(s) {
    s.active = true;
    s.base = selected.slice();
    s.value = !selected[s.start];
    s.last = -1;
    root.classList.add('is-sweeping');
    applySweep(s.start);
    if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
  }
  function applySweep(i) {
    var s = sweep;
    if (!s || i < 0 || i === s.last) return;
    s.last = i;
    var lo = Math.min(s.start, i), hi = Math.max(s.start, i);
    for (var j = 0; j < selected.length; j++) selected[j] = j >= lo && j <= hi ? s.value : s.base[j];
    writePick();
    render();
  }
  function endSweep() {
    var s = sweep;
    sweep = null;
    root.classList.remove('is-sweeping');
    if (s && s.timer) clearTimeout(s.timer);
    if (s && s.active) { anchor = s.start; refresh(); }
  }
  function autoScroll() {
    scrollRaf = 0;
    if (!sweep || !sweep.active) return;
    var edge = 56, y = sweep.y, h = window.innerHeight, dy = 0;
    if (y < edge) dy = -Math.ceil((edge - y) / 4);
    else if (y > h - edge) dy = Math.ceil((y - (h - edge)) / 4);
    if (dy) { window.scrollBy({ top: dy, behavior: 'instant' }); applySweep(cardAt(sweep.x, sweep.y)); }
    scrollRaf = requestAnimationFrame(autoScroll);
  }
  grid.addEventListener('pointerdown', function (e) {
    if (busy || !doc || sweep || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('button')) return;
    var li = e.target.closest('.' + P + '-page');
    if (!li) return;
    var i = Number(li.dataset.i);
    if (e.pointerType === 'touch') {
      sweep = { pid: e.pointerId, touch: true, start: i, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, active: false };
      sweep.timer = setTimeout(function () { if (sweep && !sweep.active) beginSweep(sweep); }, 450);
      return;
    }
    e.preventDefault();
    if (e.shiftKey && anchor >= 0) {
      var lo = Math.min(anchor, i), hi = Math.max(anchor, i);
      setSelection(function (j, was) { return (j >= lo && j <= hi) || was; });
      anchor = i;
      return;
    }
    sweep = { pid: e.pointerId, touch: false, start: i, x: e.clientX, y: e.clientY, active: false };
    beginSweep(sweep);
    try { grid.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  });
  grid.addEventListener('pointermove', function (e) {
    var s = sweep;
    if (!s || e.pointerId !== s.pid) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.active) {
      if (Math.abs(e.clientX - s.x0) + Math.abs(e.clientY - s.y0) > 10) { clearTimeout(s.timer); sweep = null; }
      return;
    }
    applySweep(cardAt(e.clientX, e.clientY));
  });
  grid.addEventListener('pointerup', function (e) {
    var s = sweep;
    if (!s || e.pointerId !== s.pid) return;
    if (s.touch && !s.active) {
      clearTimeout(s.timer);
      sweep = null;
      selected[s.start] = !selected[s.start];
      anchor = s.start;
      writePick();
      refresh();
      return;
    }
    endSweep();
  });
  grid.addEventListener('pointercancel', function (e) { if (sweep && e.pointerId === sweep.pid) endSweep(); });
  grid.addEventListener('lostpointercapture', function (e) { if (sweep && !sweep.touch && e.pointerId === sweep.pid) endSweep(); });
  grid.addEventListener('touchmove', function (e) { if (sweep && sweep.active && e.cancelable) e.preventDefault(); }, { passive: false });
  grid.addEventListener('contextmenu', function (e) { if (!e.target.closest('button')) e.preventDefault(); });
  grid.addEventListener('change', function (e) {
    var cb = e.target.closest('.' + P + '-check');
    if (!cb || busy) return;
    var i = Number(cb.dataset.i);
    selected[i] = cb.checked;
    anchor = i;
    writePick();
    refresh();
  });
  grid.addEventListener('click', function (e) {
    var b = e.target.closest('.' + P + '-dl');
    if (!b || !doc) return;
    var i = Number(b.dataset.i), st = cfg.settings(), r = done[i];
    if (r && r.key === st.key) { if (cfg.cardDownload) cfg.cardDownload(i, r, st); else TT.download(nameFor(i, st), r.blob); }
  });
  $$('[data-pick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var all = b.dataset.pick === 'all';
      pickedPages();
      setSelection(function () { return all; });
    });
  });
  // The pages are one tab stop: the arrow keys move between them (up and down by a row), Home and
  // End go to the first and last, Space picks or drops a page and Enter converts.
  function columns() {
    var top = cards[0].el.offsetTop, n = 0;
    while (n < cards.length && cards[n].el.offsetTop === top) n++;
    return Math.max(1, n);
  }
  function roveTo(i, focus) {
    if (!cards[i]) return;
    if (rove >= 0 && rove !== i && cards[rove]) cards[rove].cb.tabIndex = -1;
    rove = i;
    cards[i].cb.tabIndex = 0;
    if (focus) cards[i].cb.focus();
  }
  if (cfg.keys) {
    grid.addEventListener('focusin', function (e) {
      var cb = e.target.closest && e.target.closest('.' + P + '-check');
      if (cb) roveTo(Number(cb.dataset.i), false);
    });
    grid.addEventListener('keydown', function (e) {
      var cb = e.target.closest && e.target.closest('.' + P + '-check');
      if (!cb || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Enter') { e.preventDefault(); convert(); return; }
      var i = Number(cb.dataset.i), n = cards.length, to;
      if (e.key === 'ArrowRight') to = i + 1;
      else if (e.key === 'ArrowLeft') to = i - 1;
      else if (e.key === 'ArrowDown') to = i + columns();
      else if (e.key === 'ArrowUp') to = i - columns();
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      else return;
      e.preventDefault();
      if (to >= 0 && to < n) roveTo(to, true);
    });
  }

  // ---------- events ----------
  el('choose').addEventListener('click', function () { fileInput.click(); });
  el('another').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var list = fileInput.files;
    chooseFiles(list).then(function () { fileInput.value = ''; });
  });
  el('sample').addEventListener('click', function () { chooseFiles([samplePdf()]); });
  el('pw-go').addEventListener('click', unlock);
  pwIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
  pwIn.addEventListener('input', function () { if (pwIn.getAttribute('aria-invalid')) { pwErr.textContent = ''; pwIn.removeAttribute('aria-invalid'); } });
  pagesIn.addEventListener('input', function () { refresh(); });
  FIELDS.forEach(function (f) { f.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); convert(); } }); });
  goBtn.addEventListener('click', function () { convert(); });
  cancelBtn.addEventListener('click', cancel);

  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  document.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    // A drop while converting is taken and answered with a message, so the drop area is not shown.
    e.dataTransfer.dropEffect = 'copy';
    if (!busy) dropZone.classList.add('is-over');
  });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) dropZone.classList.remove('is-over'); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropZone.classList.remove('is-over');
    chooseFiles(e.dataTransfer.files, 'drop');
  });
  // After Back or Forward the browser may put earlier values back into the controls once this
  // script has run, so everything shown is worked out from them again.
  function syncControls() {
    if (cfg.sync) cfg.sync();
    if (doc && !busy) refresh();
  }
  window.addEventListener('pageshow', syncControls);
  syncControls();

  // ---------- a sample to try the tool with: three pages written by hand ----------
  function samplePdf() {
    var pages = [
      { w: 595, h: 842, s: '0.93 0.95 0.98 rg 0 0 595 842 re f\n0.12 0.35 0.75 rg 60 560 220 200 re f\n0.90 0.42 0.12 rg 315 560 220 200 re f\n' +
        '0.15 0.62 0.38 rg 297 330 m 297 396 243 450 177 450 c 111 450 57 396 57 330 c 57 264 111 210 177 210 c 243 210 297 264 297 330 c f\n' +
        '0.12 0.14 0.17 rg BT /F1 40 Tf 60 120 Td (Sample page 1) Tj ET BT /F2 18 Tf 330 330 Td (Shapes and text) Tj ET' },
      { w: 842, h: 595, s: '1 1 1 rg 0 0 842 595 re f\n0.95 0.88 0.30 rg 60 300 722 230 re f\n0.55 0.25 0.65 rg 60 60 340 200 re f\n' +
        '0.12 0.14 0.17 rg BT /F1 44 Tf 90 400 Td (A landscape page) Tj ET BT /F2 18 Tf 440 150 Td (Sample page 2) Tj ET' },
      { w: 612, h: 792, s: '0.12 0.14 0.17 rg BT /F1 36 Tf 60 680 Td (Sample page 3) Tj ET\n' +
        'BT /F2 16 Tf 60 640 Td (Nothing is painted behind this text, so it can be transparent as a PNG.) Tj ET\n' +
        '0.85 0.15 0.20 rg 60 380 492 200 re f' }
    ];
    var objs = [], kids = [], i;
    for (i = 0; i < pages.length; i++) kids.push((5 + 2 * i) + ' 0 R');
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    for (i = 0; i < pages.length; i++) {
      var pg = pages[i];
      objs[5 + 2 * i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pg.w + ' ' + pg.h + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (6 + 2 * i) + ' 0 R >>';
      objs[6 + 2 * i] = '<< /Length ' + pg.s.length + ' >>\nstream\n' + pg.s + '\nendstream';
    }
    var out = '%PDF-1.4\n', at = [];
    for (i = 1; i < objs.length; i++) { at[i] = out.length; out += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    var xref = out.length;
    out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
    for (i = 1; i < objs.length; i++) out += ('000000000' + at[i]).slice(-10) + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return new File([out], 'sample.pdf', { type: 'application/pdf' });
  }

  return {
    refresh: refresh, render: render, convert: convert, cancel: cancel, renderPage: renderPage, noteSize: noteSize, thumbsIdle: thumbsIdle,
    doc: function () { return doc; }, result: function (i) { return done[i]; }, isBusy: function () { return busy; },
    pdfjs: function () { return pdfjs; }, cards: function () { return cards; },
    say: say, setError: setError, friendly: friendly, fmtBytes: fmtBytes, plural: plural, listText: listText,
    pagesPhrase: pagesPhrase, dash: dash, NUM: NUM, pixelsFor: pixelsFor, nameFor: nameFor, baseName: baseName, readWhole: readWhole, needs: needs,
    TOUCH: TOUCH, MAX_PIXELS: MAX_PIXELS
  };
  };
  {% endraw %}
})();
