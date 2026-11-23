{%- comment -%}
  The OCR engine shared by Image to Text and PDF to Text: tesseract.js 7 with the LSTM engine,
  loaded from this site (assets/vendor/tesseract/) only when a page is first read. cacheMethod is
  'none', so the language data is never written to IndexedDB, and Tesseract's console notes go to
  /dev/null. A page puts it in a script of its own, before its own script:

    <script>
    {% raw %}{% include ocr-engine.js %}{% endraw %}
    </script>

  and starts it once: const ocr = TTOcr({ status, progress, sizes }).
    status(text)    a step of loading, for the page's status line: 'Downloading the OCR engine
                    (1.5 MB)…', 'Downloading English data (3.0 MB)…', 'Starting the OCR engine…'.
    progress(v)     the progress bar, 0 to 100: 2 and 5 while the engine downloads, 30 for the
                    language data, 80 while it starts, then 15 to 100 while a picture is read.
    sizes()         told when what is loaded changes (sizeHint then says something else).

  The engine (ocr):
    LANGS           { code: [name, bytes of its .traineddata.gz] } for the 19 languages served.
    ENGINE_BYTES, MAX_PX, MAX_SIDE, PDF_DPI
    loaded          a Set: 'core' and the language codes the running engine holds.
    sizeHint(langs) 'Before reading, the page downloads about 4.5 MB from this site: ...'.
    getEngine(langs, guard) -> Promise of the tesseract.js worker, started or switched to langs.
                    guard(promise) wraps each wait, so that a Stop (a rejection with .stopped)
                    ends it. A failure rejects with .engine and a message for visitors.
    dropEngine()    ends the engine, and one that is still starting.
    read(src, s, guard, hooks) -> Promise of { result, prep, notes }: reads a canvas (released
                    afterwards) with s = { langs, psm, enlarge ('auto', '1', '2', '3'), clean, bw }.
                    hooks.engineReady() is told once the engine is ready, before the picture is
                    prepared. result is ocrResult's; notes are the visitor's notes, in order:
                    'Reduced from W × H to w × h pixels…', 'Enlarged 3× because the text is
                    small.', 'Light text on a dark background…', 'Straightened by 4°.'.
    ocrResult(data, prep) -> { method: 'ocr', lines: [{ text, conf, poly }], blocks, conf, rot }:
                    blocks are paragraphs of line texts, [[[line, ...], ...], ...].
    joinPara(lines) the lines of a paragraph as one line (a hyphen at a line end is kept, with no
                    space after it; Chinese and Japanese lines join without a space).
    renderPdf(page, maxPx) -> Promise of a canvas: a PDF.js page at up to 300 dpi, on white.
    mostlyPicture(lib, page, text) -> Promise of true for a scan with only a little stored text.
    prepare, layout, tidy, release, median, friendly, stopError, engineFailure.
{%- endcomment -%}
window.TTOcr = (function () {
  'use strict';
  const VENDOR = new URL({{ '/assets/vendor/tesseract/' | relative_url | jsonify }}, location.href).href;
  {% raw %}
  // Download sizes as this site serves them: the engine's script is sent compressed (about
  // 1.5 MB of its 3.9 MB); each .traineddata.gz is already compressed (its file size).
  const ENGINE_BYTES = 1.5e6;
  const LANGS = {
    eng: ['English', 2952873], ara: ['Arabic', 1661906], chi_sim: ['Chinese (Simplified)', 1718768],
    chi_tra: ['Chinese (Traditional)', 1656239], nld: ['Dutch', 3005696], fra: ['French', 707406],
    deu: ['German', 1333102], hin: ['Hindi', 1389692], ind: ['Indonesian', 1194182], ita: ['Italian', 1660998],
    jpn: ['Japanese', 2030256], kor: ['Korean', 1572336], pol: ['Polish', 2642356], por: ['Portuguese', 1392239],
    rus: ['Russian', 2679598], spa: ['Spanish', 2100190], tur: ['Turkish', 2141291], ukr: ['Ukrainian', 2114206],
    vie: ['Vietnamese', 1423003]
  };
  const MAX_PX = 16e6, MAX_SIDE = 16000, PDF_DPI = 300;

  const NUM = new Intl.NumberFormat('en-GB');
  function mb(bytes) { return (Math.round(bytes / 1e5) / 10).toFixed(1) + ' MB'; }
  function listText(items) { return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]; }
  function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
  function friendly(message, extra) { const e = new Error(message); e.friendly = true; return Object.assign(e, extra || {}); }
  function stopError() { return Object.assign(new Error('stopped'), { stopped: true }); }
  function engineFailure() {
    return friendly('The OCR engine could not be loaded. Check your connection and try again.', { engine: true });
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }
  function release(c) { if (c && c.width !== undefined) { c.width = 0; c.height = 0; } }

  // ---------- Picture clean-up (runs in a worker) ----------
  // Grey from RGB (the canvas is painted white first, so there is no transparency); a mostly
  // dark picture is inverted, the lighting is evened out, and Black and white applies Otsu's
  // threshold. The result is a Netpbm file (P5 grey, or P6 colour when nothing is changed),
  // which Tesseract reads without the cost of PNG encoding.
  function prepPixels(rgba, w, h, o) {
    const n = w * h;
    let i, j;
    if (!o.clean && !o.bw) {
      const head = 'P6\n' + w + ' ' + h + '\n255\n', out = new Uint8Array(head.length + n * 3);
      for (i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
      for (i = 0, j = head.length; i < n * 4; i += 4) { out[j++] = rgba[i]; out[j++] = rgba[i + 1]; out[j++] = rgba[i + 2]; }
      return { buf: out.buffer, inverted: false, view: viewOf(out, head.length, 3, w, h) };
    }
    const head = 'P5\n' + w + ' ' + h + '\n255\n', out = new Uint8Array(head.length + n);
    for (i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
    const g = out.subarray(head.length);
    for (i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114 + 500) / 1000;
    let inverted = false;
    if (o.clean) {
      const hist = new Uint32Array(256);
      for (i = 0; i < n; i++) hist[g[i]]++;
      if (levelAt(hist, n, 0.5) < 100) {
        inverted = true;
        for (i = 0; i < n; i++) g[i] = 255 - g[i];
      }
      evenLight(g, w, h);
    }
    if (o.bw) {
      const t = otsuLevel(g);
      for (i = 0; i < n; i++) g[i] = g[i] > t ? 255 : 0;
    }
    return { buf: out.buffer, inverted, view: viewOf(out, head.length, 1, w, h) };
  }
  // A small copy of the picture as Tesseract gets it (RGBA, at most 1400 pixels a side),
  // each pixel the average of the block it covers.
  function viewOf(src, off, ch, w, h) {
    const k = Math.min(1, 1400 / Math.max(w, h)), tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
    const sum = new Float64Array(tw * th * 3), cnt = new Uint32Array(tw * th);
    for (let y = 0; y < h; y++) {
      const row = Math.min(th - 1, Math.floor(y * k)) * tw;
      for (let x = 0; x < w; x++) {
        const t = row + Math.min(tw - 1, Math.floor(x * k)), i = off + (y * w + x) * ch;
        sum[t * 3] += src[i];
        sum[t * 3 + 1] += src[i + (ch === 3 ? 1 : 0)];
        sum[t * 3 + 2] += src[i + (ch === 3 ? 2 : 0)];
        cnt[t]++;
      }
    }
    const px = new Uint8ClampedArray(tw * th * 4);
    for (let t = 0; t < tw * th; t++) {
      const c = cnt[t] || 1;
      px[t * 4] = sum[t * 3] / c;
      px[t * 4 + 1] = sum[t * 3 + 1] / c;
      px[t * 4 + 2] = sum[t * 3 + 2] / c;
      px[t * 4 + 3] = 255;
    }
    return { w: tw, h: th, px };
  }
  function levelAt(hist, count, q) {
    const want = count * q;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
    return 255;
  }
  // The paper's brightness is measured in blocks (the 90th percentile, so ink does not count),
  // smoothed, and each pixel is divided by it. Blocks darker than 40% of the paper are not paper
  // (a dark title bar, a photo, a thick letter): they take the level of the paper around them,
  // so text inside them keeps its contrast instead of being washed out.
  function evenLight(g, w, h) {
    const n = w * h, all = new Uint32Array(256);
    for (let i = 0; i < n; i++) all[g[i]]++;
    const paper = levelAt(all, n, 0.9);
    if (paper < 16) return;
    const floor = paper * 0.4, b = Math.max(8, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / b), gh = Math.ceil(h / b), m = gw * gh;
    let grid = new Float32Array(m);
    const ok = new Uint8Array(m), hist = new Uint32Array(256);
    for (let by = 0; by < gh; by++) {
      for (let bx = 0; bx < gw; bx++) {
        hist.fill(0);
        const x0 = bx * b, y0 = by * b, x1 = Math.min(w, x0 + b), y1 = Math.min(h, y0 + b);
        for (let y = y0; y < y1; y++) for (let k = y * w + x0, e = y * w + x1; k < e; k++) hist[g[k]]++;
        const v = levelAt(hist, (x1 - x0) * (y1 - y0), 0.9);
        if (v > floor) { grid[by * gw + bx] = v; ok[by * gw + bx] = 1; }
      }
    }
    let left = 0;
    for (let k = 0; k < m; k++) if (!ok[k]) left++;
    for (let pass = 0; left && pass < gw + gh; pass++) {
      const next = grid.slice(), got = [];
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const k = y * gw + x;
          if (ok[k]) continue;
          let s = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < gh && xx >= 0 && xx < gw && ok[yy * gw + xx]) { s += grid[yy * gw + xx]; c++; }
          }
          if (c) { next[k] = s / c; got.push(k); }
        }
      }
      if (!got.length) break;
      got.forEach(k => { ok[k] = 1; });
      left -= got.length;
      grid = next;
    }
    if (left) for (let k = 0; k < m; k++) if (!ok[k]) grid[k] = paper;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(m);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          let s = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) { s += grid[yy * gw + xx]; c++; }
          }
          next[y * gw + x] = s / c;
        }
      }
      grid = next;
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / b - 0.5)), ya = Math.floor(fy), yb = Math.min(gh - 1, ya + 1), ty = fy - ya;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / b - 0.5)), xa = Math.floor(fx), xb = Math.min(gw - 1, xa + 1), tx = fx - xa;
        const top = grid[ya * gw + xa] * (1 - tx) + grid[ya * gw + xb] * tx, bot = grid[yb * gw + xa] * (1 - tx) + grid[yb * gw + xb] * tx;
        const bg = top * (1 - ty) + bot * ty, k = y * w + x;
        g[k] = bg < 1 ? 255 : Math.min(255, Math.round(g[k] * 255 / bg));
      }
    }
  }
  function otsuLevel(g) {
    const hist = new Float64Array(256), n = g.length;
    for (let i = 0; i < n; i++) hist[g[i]]++;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let wB = 0, sumB = 0, best = -1, t = 127;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = v; }
    }
    return t;
  }
  function prepWorkerMain() {
    self.onmessage = function (e) {
      const m = e.data;
      try {
        const r = prepPixels(new Uint8ClampedArray(m.buf), m.w, m.h, m.o);
        self.postMessage({ id: m.id, buf: r.buf, inverted: r.inverted, view: r.view }, [r.buf, r.view.px.buffer]);
      } catch (err) { self.postMessage({ id: m.id, error: String(err && err.message || err) }); }
    };
  }
  let prepWorker = null, prepN = 0;
  const prepWaiting = new Map();
  function prepRun(buf, w, h, o) {
    if (prepWorker === null) {
      try {
        const src = [prepPixels, viewOf, levelAt, evenLight, otsuLevel].map(f => f.toString()).join('\n') + '\n(' + prepWorkerMain.toString() + ')();';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        prepWorker = new Worker(url);
        URL.revokeObjectURL(url);
        prepWorker.onmessage = e => {
          const p = prepWaiting.get(e.data.id);
          if (!p) return;
          prepWaiting.delete(e.data.id);
          if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
        };
        prepWorker.onerror = e => {
          if (e && e.preventDefault) e.preventDefault();
          prepWaiting.forEach(p => p.reject(new Error('The picture could not be prepared.')));
          prepWaiting.clear();
          prepWorker.terminate();
          prepWorker = false;
        };
      } catch (e) { prepWorker = false; }
    }
    if (!prepWorker) return Promise.resolve(prepPixels(new Uint8ClampedArray(buf), w, h, o));
    return new Promise((resolve, reject) => {
      const id = ++prepN;
      prepWaiting.set(id, { resolve, reject });
      prepWorker.postMessage({ id, buf, w, h, o }, [buf]);
    });
  }
  // The picture at a scale, painted on white, then cleaned up in the worker.
  async function prepare(src, scale, s) {
    const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h);
    release(c);
    const r = await prepRun(data.data.buffer, w, h, { clean: s.clean, bw: s.bw });
    return { blob: new Blob([r.buf]), w, h, inverted: r.inverted, view: r.view };
  }

  // ---------- What Tesseract found ----------
  // Tesseract straightens a tilted page by rotateRadians about its centre, and gives boxes in
  // that straightened picture; each corner is turned back, as a fraction of the picture's size.
  function ocrResult(d, p) {
    const rot = d.rotateRadians || 0, cx = p.w / 2, cy = p.h / 2, c = Math.cos(-rot), sn = Math.sin(-rot);
    const at = (x, y) => [(cx + (x - cx) * c - (y - cy) * sn) / p.w, (cy + (x - cx) * sn + (y - cy) * c) / p.h];
    const lines = [];
    (d.blocks || []).forEach(b => (b.paragraphs || []).forEach(par => (par.lines || []).forEach(l => {
      const text = tidy(l.text), bb = l.bbox;
      if (!text || !bb) return;
      lines.push({ text, b: bb, conf: Math.max(0, Math.min(100, Math.round(l.confidence))), poly: [at(bb.x0, bb.y0), at(bb.x1, bb.y0), at(bb.x1, bb.y1), at(bb.x0, bb.y1)] });
    })));
    const conf = lines.length ? Math.round(lines.reduce((a, l) => a + l.conf * l.text.length, 0) / lines.reduce((a, l) => a + l.text.length, 0)) : null;
    const blocks = layout(lines).map(bl => bl.map(par => par.map(i => lines[i].text)));
    lines.forEach(l => { delete l.b; });
    return { method: 'ocr', lines, blocks, conf, rot };
  }
  // The lines, in Tesseract's reading order, grouped as they look on the page. A block ends
  // where the picture has a gap of about a blank line or a new column starts; it is a blank
  // line in the text. Inside a block, a paragraph ends where a line stops well short of the
  // others or the next line is indented; Join lines into paragraphs joins only within one.
  const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
  function layout(ls) {
    if (!ls.length) return [];
    const h = median(ls.map(l => l.b.y1 - l.b.y0)) || 1;
    const newColumn = (a, b) => b.y0 < a.y0 - h / 4 || Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) < 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0);
    const gaps = [];
    for (let i = 1; i < ls.length; i++) if (!newColumn(ls[i - 1].b, ls[i].b)) gaps.push(Math.max(0, ls[i].b.y0 - ls[i - 1].b.y1));
    const big = Math.max(0.8 * h, 1.8 * (gaps.length ? Math.min.apply(null, gaps) : 0));
    const blocks = [];
    let cur = [0];
    for (let i = 1; i < ls.length; i++) {
      const a = ls[i - 1].b, b = ls[i].b;
      if (newColumn(a, b) || b.y0 - a.y1 > big) { blocks.push(cur); cur = [i]; } else cur.push(i);
    }
    blocks.push(cur);
    return blocks.map(idx => {
      const left = Math.min.apply(null, idx.map(i => ls[i].b.x0)), right = Math.max.apply(null, idx.map(i => ls[i].b.x1));
      const width = right - left, rtl = idx.some(i => RTL.test(ls[i].text)), paras = [];
      let par = [idx[0]];
      for (let k = 1; k < idx.length; k++) {
        const a = ls[idx[k - 1]].b, b = ls[idx[k]].b;
        const short = idx.length > 2 && (rtl ? a.x0 > left + width / 4 : a.x1 < right - width / 4);
        const indent = rtl ? b.x1 < a.x1 - 0.8 * h : b.x0 > a.x0 + 0.8 * h;
        if (short || indent) { paras.push(par); par = [idx[k]]; } else par.push(idx[k]);
      }
      paras.push(par);
      return paras;
    });
  }
  // Tesseract puts spaces between Chinese and Japanese characters; they do not belong there.
  const CJK = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef]';
  const CJK_GAP = new RegExp('(' + CJK + ') +(?=' + CJK + ')', 'gu'), CJK_ONE = new RegExp(CJK, 'u');
  function tidy(t) { return String(t || '').replace(/[\r\n]+/g, ' ').trim().replace(CJK_GAP, '$1'); }
  // A line that ends in a hyphen after a letter runs on into the next without a space (the
  // hyphen stays: it may belong to a word such as well-known); Chinese and Japanese lines join
  // without a space too.
  function joinPara(lines) {
    let out = '';
    for (const l of lines) {
      if (!out) { out = l; continue; }
      const a = Array.from(out.slice(-2)).pop(), b = Array.from(l.slice(0, 2))[0];
      if (/[\p{L}\p{N}]-$/u.test(out) || (CJK_ONE.test(a) && CJK_ONE.test(b))) out += l;
      else out += ' ' + l;
    }
    return out;
  }

  // ---------- PDF pages ----------
  async function renderPdf(page, maxPx) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(PDF_DPI / 72, Math.sqrt(maxPx / (base.width * base.height)), MAX_SIDE / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    const ctx = c.getContext('2d');
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp, background: '#ffffff', transform: [c.width / vp.width, 0, 0, c.height / vp.height, 0, 0] }).promise;
    return c;
  }
  // Whether a page is a scan that holds only a little typed text, such as a reference number
  // or a page number stamped on it later: pictures cover at least half the page, with less
  // than one stored letter or digit per square inch of picture. Its text is then read from
  // the picture, as copying would leave out everything scanned.
  async function mostlyPicture(lib, page, text) {
    try {
      const O = lib.OPS, v = page.view, pageArea = (v[2] - v[0]) * (v[3] - v[1]);
      if (!(pageArea > 0)) return false;
      const ops = await page.getOperatorList({ annotationMode: lib.AnnotationMode.DISABLE });
      const mul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
        p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
      let m = [1, 0, 0, 1, 0, 0], area = 0;
      const stack = [];
      // A picture fills the unit square of the current transform; its box is clipped to the page.
      const paint = t => {
        const xs = [t[4], t[0] + t[4], t[2] + t[4], t[0] + t[2] + t[4]], ys = [t[5], t[1] + t[5], t[3] + t[5], t[1] + t[3] + t[5]];
        const w = Math.min(v[2], Math.max(...xs)) - Math.max(v[0], Math.min(...xs));
        const h = Math.min(v[3], Math.max(...ys)) - Math.max(v[1], Math.min(...ys));
        if (w > 0 && h > 0) area += w * h;
      };
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], a = ops.argsArray[i];
        if (fn === O.save) stack.push(m);
        else if (fn === O.restore) { if (stack.length) m = stack.pop(); }
        else if (fn === O.transform) m = mul(m, a);
        else if (fn === O.paintFormXObjectBegin) { stack.push(m); if (a && a[0] && a[0].length === 6) m = mul(m, Array.from(a[0])); }
        else if (fn === O.paintFormXObjectEnd) { if (stack.length) m = stack.pop(); }
        else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) paint(m);
        else if (fn === O.paintImageXObjectRepeat && a && a[3]) for (let k = 0; k + 1 < a[3].length; k += 2) paint(mul(m, [a[1], 0, 0, a[2], a[3][k], a[3][k + 1]]));
      }
      area = Math.min(area, pageArea);
      return area >= pageArea / 2 && text.replace(/[^\p{L}\p{N}]/gu, '').length < area / 5184;
    } catch (e) { return false; }
  }

  return function (cfg) {
    const status = cfg.status || (() => {}), progress = cfg.progress || (() => {}), sizes = cfg.sizes || (() => {});
    let engine = null;            // { worker, langs }
    const loaded = new Set();     // 'core' and the language codes loaded into the current engine
    let loadingLangs = [], readingNow = false;
    function sizeHint(langs) {
      const need = [];
      if (!loaded.has('core')) need.push(['the OCR engine', ENGINE_BYTES]);
      langs.forEach(l => { if (!loaded.has(l)) need.push([LANGS[l][0] + ' data', LANGS[l][1]]); });
      if (!need.length) return 'The OCR engine is loaded, with ' + listText(langs.map(l => LANGS[l][0])) + ' data. Nothing is uploaded.';
      const total = need.reduce((a, x) => a + x[1], 0);
      return 'Before reading, the page downloads about ' + mb(total) + ' from this site: ' +
        listText(need.map(x => x[0] + ' (' + mb(x[1]) + ')')) + '. Nothing is uploaded.';
    }
    function onLog(m) {
      if (!m || typeof m.status !== 'string') return;
      const p = typeof m.progress === 'number' ? m.progress : 0;
      if (m.status === 'recognizing text') { if (readingNow) progress(15 + 85 * p); return; }
      if (p >= 1) return;
      if (m.status === 'loading tesseract core') { progress(5); status('Downloading the OCR engine (' + mb(ENGINE_BYTES) + ')\u2026'); }
      else if (m.status === 'loading language traineddata' && loadingLangs.length) {
        progress(30);
        status('Downloading ' + listText(loadingLangs.map(l => LANGS[l][0])) + ' data (' + mb(loadingLangs.reduce((a, l) => a + LANGS[l][1], 0)) + ')\u2026');
      } else if (m.status === 'initializing api') { progress(80); status('Starting the OCR engine\u2026'); }
    }
    // tesseract.js hands over its worker only once it is ready, and never answers at all when a
    // language file fails to download. The Worker it creates (synchronously, at the start of
    // createWorker) is caught here, so a start that fails or is stopped is ended at once.
    let starting = null;
    function createEngine(langs) {
      const job = { dropped: false, raw: null };
      starting = job;
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = () => {
          if (settled) return;
          settled = true;
          if (job.raw) job.raw.terminate();
          reject(engineFailure());
        };
        let made;
        const Native = window.Worker;
        try {
          window.Worker = function (src, opts) { job.raw = new Native(src, opts); return job.raw; };
          window.Worker.prototype = Native.prototype;
          made = window.Tesseract.createWorker(langs, 1, {
            workerPath: VENDOR + 'worker.min.js', corePath: VENDOR + 'core', langPath: VENDOR + 'lang',
            cacheMethod: 'none', workerBlobURL: false, gzip: true, logger: onLog, errorHandler: fail
          });
        } catch (e) { window.Worker = Native; fail(); return; }
        window.Worker = Native;
        made.then(w => {
          if (settled || job.dropped) {
            try { w.terminate(); } catch (e) { /* already gone */ }
            if (!settled) { settled = true; reject(stopError()); }
            return;
          }
          settled = true;
          resolve(w);
        }, fail);
      }).finally(() => { if (starting === job) starting = null; });
    }
    function dropEngine() {
      if (starting) {
        starting.dropped = true;
        if (starting.raw) starting.raw.terminate();
      }
      if (engine) { try { engine.worker.terminate(); } catch (e) { /* already gone */ } }
      engine = null;
      loaded.clear();
      sizes();
    }
    async function getEngine(langs, guard) {
      const want = langs.join('+');
      if (engine && engine.langs === want) return engine.worker;
      loadingLangs = langs.filter(l => !loaded.has(l));
      try {
        if (!window.Tesseract) {
          progress(2);
          status('Downloading the OCR engine (' + mb(ENGINE_BYTES) + ')\u2026');
          await guard(loadScript(VENDOR + 'tesseract.min.js').catch(() => { throw engineFailure(); }));
        }
        if (!engine) {
          const w = await guard(createEngine(langs));
          engine = { worker: w, langs: want };
        } else {
          await guard(engine.worker.reinitialize(langs, 1).catch(() => { throw engineFailure(); }));
          engine.langs = want;
        }
        // Tesseract writes notes such as "Estimating resolution as 300" to the console; send them nowhere.
        await guard(engine.worker.setParameters({ debug_file: '/dev/null' }));
      } catch (e) {
        if (!(e && e.stopped)) dropEngine();
        throw e && (e.stopped || e.engine) ? e : engineFailure();
      } finally { loadingLangs = []; }
      loaded.add('core');
      langs.forEach(l => loaded.add(l));
      sizes();
      return engine.worker;
    }
    // Reads a picture: made smaller first if it has more than 16 megapixels, read once at its
    // own size to measure its lines when Enlarge small text is automatic, enlarged 2 to 4 times
    // when they are under 22 pixels tall, then read with Tesseract's automatic rotation.
    async function read(src, s, guard, hooks) {
      hooks = hooks || {};
      const notes = [];
      const worker = await getEngine(s.langs, guard);
      if (hooks.engineReady) hooks.engineReady();
      const W = src.width, H = src.height;
      const base = Math.min(1, Math.sqrt(MAX_PX / (W * H)), MAX_SIDE / Math.max(W, H));
      if (base < 1) notes.push('Reduced from ' + W + ' \u00d7 ' + H + ' to ' + Math.round(W * base) + ' \u00d7 ' + Math.round(H * base) + ' pixels to keep reading quick.');
      let prep = await guard(prepare(src, base, s));
      let factor = 1, why = '';
      if (s.enlarge === 'auto') {
        readingNow = false;
        const r = await guard(worker.recognize(prep.blob, { tessedit_pageseg_mode: s.psm }, { text: false, layoutBlocks: true }));
        const heights = [];
        (r.data.layoutBlocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => { if (l.bbox) heights.push(l.bbox.y1 - l.bbox.y0); })));
        const lh = median(heights);
        if (lh && lh < 22) { factor = Math.min(4, Math.max(2, Math.round(36 / lh))); why = 'small'; }
        else if (!heights.length && W * H * base * base < 2e6) { factor = 2; why = 'none'; }
      } else factor = Number(s.enlarge) || 1;
      const room = Math.min(Math.sqrt(MAX_PX / (W * H * base * base)), MAX_SIDE / (Math.max(W, H) * base));
      if (factor > room) factor = room >= 1.5 ? Math.floor(room * 10) / 10 : 1;
      let enlarged = '';
      if (factor > 1) {
        prep = await guard(prepare(src, base * factor, s));
        enlarged = 'Enlarged ' + NUM.format(factor) + '\u00d7' + (why === 'small' ? ' because the text is small.' : why === 'none' ? ' because no text was found at its own size.' : '.');
      }
      release(src);
      progress(15);
      readingNow = true;
      let r;
      try {
        r = await guard(worker.recognize(prep.blob, { rotateAuto: true, tessedit_pageseg_mode: s.psm }, { text: false, blocks: true }));
      } catch (e) {
        if (e && e.stopped) throw e;
        dropEngine();
        throw friendly('the OCR engine stopped while reading it (the picture may be too large for this device).');
      } finally { readingNow = false; }
      const result = ocrResult(r.data, prep);
      if (enlarged && (why !== 'none' || result.lines.length)) notes.push(enlarged);
      if (prep.inverted) notes.push('Light text on a dark background: the picture was inverted before reading.');
      if (Math.abs(result.rot) >= 0.005) notes.push('Straightened by ' + NUM.format(Math.round(Math.abs(result.rot) * 1800 / Math.PI) / 10) + '\u00b0.');
      return { result, prep, notes };
    }
    return {
      LANGS, ENGINE_BYTES, MAX_PX, MAX_SIDE, PDF_DPI, loaded, sizeHint, getEngine, dropEngine, read,
      ocrResult, layout, tidy, joinPara, prepare, renderPdf, mostlyPicture, release, median,
      friendly, stopError, engineFailure, CJK_ONE
    };
  };
  {% endraw %}
})();
