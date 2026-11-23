/*
 * TTPng: PNG helpers shared by Compress Image, PDF to JPG and PDF to PNG (window.TTPng).
 * No dependencies. Load it where it is needed:
 *   <script src="{{ '/assets/js/png-kit.js' | relative_url }}"></script>
 *
 * API
 *   TTPng.withDpi(blob, type, dpi) -> Promise<Blob>
 *     Writes a resolution into a JPEG ('image/jpeg': the JFIF density, in dots per inch,
 *     ITU T.871) or a PNG ('image/png': a pHYs chunk in pixels per metre, before the
 *     image data), so the image keeps its size when it is placed or printed. dpi is
 *     rounded to a whole number from 1 to 65535. A file that does not start as
 *     expected is returned unchanged.
 *   TTPng.quantKit() -> { png(img, colours, dither) }
 *     Colour quantisation (median cut, k-means refinement, optional Floyd-Steinberg
 *     dithering) and indexed PNG writing. img is { w, h, px } with px straight RGBA; it
 *     may carry mask, one byte a pixel, to dither only the pixels the mask marks. The
 *     function is self-contained, so its source can run in a worker.
 *   TTPng.quantize(key, blob, colours, dither) -> Promise<{ bytes, colours, exact }>
 *     quantKit in a Web Worker (on the page where there is none) for a lossless PNG
 *     blob; the worker keeps the pixels of the last key, so asking again for another
 *     palette size does not decode the image again. TTPng.quantFree() drops them.
 *   TTPng.pixels(canvas, job) -> Promise<{ blob | bytes, w, h, box, blank, colours }>
 *     The steps of PDF to PNG on a drawn page, in the same worker: job is
 *     { white, trim, alpha, colours: 'exact' | '256' | 'grey' | 'bw', rects, width, boundsOnly }.
 *     white turns white into transparency, keeping soft edges; trim cuts blank margins
 *     (a pixel is blank when it is almost white, or with alpha almost clear); colours
 *     'exact' gives the browser's own PNG, the others an indexed PNG from quantKit:
 *     256 colours, greys (ITU-R 601 luma, as Pillow's convert('L')) or black and white
 *     (luma below 128 is black). rects are [x0, y0, x1, y1] areas, in pixels, holding
 *     pictures: only they are dithered. width makes the trimmed box that many pixels wide,
 *     centred on the content. With boundsOnly only box is worked out. The canvas is read at
 *     once and not changed.
 */
(function () {
  'use strict';

  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Stores the resolution in the file, so the image keeps the page's size when it is placed or printed:
  // JFIF density in dots per inch for JPG (ITU T.871), a pHYs chunk in pixels per metre for PNG.
  function withDpi(blob, type, dpi) {
    var d = Math.max(1, Math.min(65535, Math.round(dpi)));
    if (type === 'image/jpeg') {
      return blob.slice(0, 20).arrayBuffer().then(function (buf) {
        var h = new Uint8Array(buf);
        if (h[0] !== 0xFF || h[1] !== 0xD8) return blob;
        var jfif = h[2] === 0xFF && h[3] === 0xE0 && h[6] === 0x4A && h[7] === 0x46 && h[8] === 0x49 && h[9] === 0x46 && h[10] === 0;
        if (jfif) {
          h = h.slice();
          h[13] = 1;
          h[14] = d >> 8; h[15] = d & 255; h[16] = d >> 8; h[17] = d & 255;
          return new Blob([h, blob.slice(20)], { type: type });
        }
        var app0 = new Uint8Array([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
        return new Blob([blob.slice(0, 2), app0, blob.slice(2)], { type: type });
      });
    }
    return blob.slice(0, 33).arrayBuffer().then(function (buf) {
      var h = new Uint8Array(buf);
      // The signature, then IHDR (13 bytes of data); pHYs must come before the first IDAT.
      if (h.length < 33 || h[12] !== 0x49 || h[13] !== 0x48 || h[14] !== 0x44 || h[15] !== 0x52) return blob;
      var ppm = Math.round(d / 0.0254), chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
      dv.setUint32(0, 9);
      chunk.set([0x70, 0x48, 0x59, 0x73], 4);
      dv.setUint32(8, ppm);
      dv.setUint32(12, ppm);
      chunk[16] = 1;
      dv.setUint32(17, crc32(chunk.subarray(4, 17)) >>> 0);
      return new Blob([blob.slice(0, 33), chunk, blob.slice(33)], { type: type });
    });
  }

  // Colour quantisation and indexed PNG writing ("lossy PNG"). Self-contained: it also runs in
  // the worker, so it may not use anything from the enclosing scope.
  // Colours are compared premultiplied (a transparent pixel's colour does not matter) with the
  // channels weighted roughly by how visible an error in them is.
  function quantKit() {
    const WR = 0.667, WG = 1.333, WB = 1.0, WA = 1.0;
    const NB = 1 << 19;
    // Histogram bucket of a pixel: 5 bits per premultiplied colour channel, 4 bits of alpha
    // (at least 1 unless fully transparent, so bucket 0 holds exactly the transparent pixels).
    const bucket = (r, g, b, a) => ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a ? Math.max(1, a >> 4) : 0);

    // The image's own colours if there are at most k of them (straight RGBA, transparent as one).
    function exactColours(px, k) {
      const map = new Map(), n = px.length >> 2, v = new Uint32Array(px.buffer, px.byteOffset, n);
      let last = -1;
      for (let i = 0; i < n; i++) {
        const c = px[i * 4 + 3] ? v[i] : 0;
        if (c === last) continue;
        last = c;
        if (!map.has(c)) { if (map.size >= k) return null; map.set(c, map.size); }
      }
      return map;
    }

    function histogram(px) {
      const cnt = new Uint32Array(NB), sum = new Float64Array(NB * 4), n = px.length >> 2;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const a = px[p + 3];
        let r = 0, g = 0, b = 0;
        if (a === 255) { r = px[p]; g = px[p + 1]; b = px[p + 2]; } else if (a) { const f = a / 255; r = px[p] * f; g = px[p + 1] * f; b = px[p + 2] * f; }
        const k = bucket(r, g, b, a), s = k * 4;
        cnt[k]++; sum[s] += r; sum[s + 1] += g; sum[s + 2] += b; sum[s + 3] += a;
      }
      let m = 0;
      for (let k = 1; k < NB; k++) if (cnt[k]) m++;
      const col = new Float64Array(m * 4), wt = new Float64Array(m), index = new Int32Array(NB).fill(-1);
      for (let k = 1, j = 0; k < NB; k++) {
        if (!cnt[k]) continue;
        const c = cnt[k];
        wt[j] = c;
        for (let ch = 0; ch < 4; ch++) col[j * 4 + ch] = sum[k * 4 + ch] / c;
        index[k] = j++;
      }
      return { m, col, wt, index, transparent: cnt[0] };
    }

    // Median cut on the histogram: split the box with the largest weighted error, along its
    // widest channel, at the point that leaves the least error on both sides.
    function medianCut(H, k) {
      const { m, col, wt } = H, W4 = [WR, WG, WB, WA];
      const ord = new Int32Array(m);
      for (let i = 0; i < m; i++) ord[i] = i;
      function box(s, e) {
        const b = { s, e, w: 0, sx: [0, 0, 0, 0], sxx: [0, 0, 0, 0], err: 0, axis: 0 };
        for (let i = s; i < e; i++) {
          const j = ord[i], w = wt[j];
          b.w += w;
          for (let c = 0; c < 4; c++) { const x = col[j * 4 + c]; b.sx[c] += w * x; b.sxx[c] += w * x * x; }
        }
        let best = -1;
        for (let c = 0; c < 4; c++) {
          const v = W4[c] * Math.max(0, b.sxx[c] - b.sx[c] * b.sx[c] / b.w);
          b.err += v;
          if (v > best) { best = v; b.axis = c; }
        }
        return b;
      }
      const boxes = [box(0, m)];
      while (boxes.length < k) {
        let bi = -1;
        for (let i = 0; i < boxes.length; i++) if (boxes[i].e - boxes[i].s > 1 && boxes[i].err > 0 && (bi < 0 || boxes[i].err > boxes[bi].err)) bi = i;
        if (bi < 0) break;
        const B = boxes[bi], ax = B.axis;
        const part = ord.subarray(B.s, B.e);
        part.sort((x, y) => col[x * 4 + ax] - col[y * 4 + ax]);
        let lw = 0, bestAt = -1, bestErr = Infinity;
        const lx = [0, 0, 0, 0], lxx = [0, 0, 0, 0];
        for (let i = B.s; i < B.e - 1; i++) {
          const j = ord[i], w = wt[j];
          lw += w;
          for (let c = 0; c < 4; c++) { const x = col[j * 4 + c]; lx[c] += w * x; lxx[c] += w * x * x; }
          if (col[j * 4 + ax] === col[ord[i + 1] * 4 + ax]) continue;
          const rw = B.w - lw;
          let e = 0;
          for (let c = 0; c < 4; c++) {
            const rx = B.sx[c] - lx[c], rxx = B.sxx[c] - lxx[c];
            e += W4[c] * (lxx[c] - lx[c] * lx[c] / lw + rxx - rx * rx / rw);
          }
          if (e < bestErr) { bestErr = e; bestAt = i + 1; }
        }
        if (bestAt < 0) { B.err = 0; continue; }
        boxes.splice(bi, 1, box(B.s, bestAt), box(bestAt, B.e));
      }
      const pal = new Float64Array(boxes.length * 4);
      boxes.forEach((b, i) => { for (let c = 0; c < 4; c++) pal[i * 4 + c] = b.sx[c] / b.w; });
      return pal;
    }

    // Nearest palette entry. The entries are sorted by green, the most heavily weighted channel;
    // the search walks outwards from the pixel's green value and stops on each side once the
    // green difference alone is worse than the best match found.
    function searcher(pal, n) {
      const ord = Array.from({ length: n }, (_, i) => i).sort((x, y) => pal[x * 4 + 1] - pal[y * 4 + 1]);
      const G = Float64Array.from(ord, i => pal[i * 4 + 1]);
      const P = new Float64Array(n * 4);
      ord.forEach((o, i) => { for (let c = 0; c < 4; c++) P[i * 4 + c] = pal[o * 4 + c]; });
      return (r, g, b, a) => {
        let lo = 0, hi = n;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (G[mid] < g) lo = mid + 1; else hi = mid; }
        let best = 0, bd = Infinity, i = lo, j = lo - 1;
        while (i < n || j >= 0) {
          if (i < n) {
            const dg = G[i] - g;
            if (WG * dg * dg >= bd) i = n;
            else {
              const q = i * 4, dr = r - P[q], db = b - P[q + 2], da = a - P[q + 3];
              const d = WR * dr * dr + WG * dg * dg + WB * db * db + WA * da * da;
              if (d < bd) { bd = d; best = i; }
              i++;
            }
          }
          if (j >= 0) {
            const dg = g - G[j];
            if (WG * dg * dg >= bd) j = -1;
            else {
              const q = j * 4, dr = r - P[q], db = b - P[q + 2], da = a - P[q + 3];
              const d = WR * dr * dr + WG * dg * dg + WB * db * db + WA * da * da;
              if (d < bd) { bd = d; best = j; }
              j--;
            }
          }
        }
        return ord[best];
      };
    }

    // A few rounds of k-means on the histogram to settle the colours median cut chose.
    function refine(H, pal, rounds) {
      const n = pal.length >> 2, { m, col, wt } = H, assign = new Int32Array(m);
      for (let r = 0; r <= rounds; r++) {
        const acc = new Float64Array(n * 5), nearest = searcher(pal, n);
        for (let j = 0; j < m; j++) {
          const q = j * 4, i = nearest(col[q], col[q + 1], col[q + 2], col[q + 3]);
          assign[j] = i;
          if (r === rounds) continue;
          const w = wt[j], o = i * 5;
          acc[o] += w * col[q]; acc[o + 1] += w * col[q + 1]; acc[o + 2] += w * col[q + 2]; acc[o + 3] += w * col[q + 3]; acc[o + 4] += w;
        }
        if (r === rounds) break;
        for (let i = 0; i < n; i++) {
          const o = i * 5, w = acc[o + 4];
          if (w) for (let c = 0; c < 4; c++) pal[i * 4 + c] = acc[o + c] / w;
        }
      }
      return assign;
    }

    // Floyd-Steinberg error diffusion, serpentine, on the premultiplied colour (not on alpha,
    // which would sprinkle see-through dots into solid areas). Errors are damped a little.
    // With a mask (one byte a pixel), only the pixels it marks are dithered: the others take
    // their nearest colour and pass no error on, so text beside a photo stays clean.
    function dither(px, w, h, pal, n, transparent, mask) {
      const out = new Uint8Array(w * h), cache = new Int16Array(NB).fill(-1), D = 0.85, nearest = searcher(pal, n);
      let cur = new Float32Array((w + 2) * 3), nxt = new Float32Array((w + 2) * 3);
      for (let y = 0; y < h; y++) {
        const ltr = !(y & 1), dx = ltr ? 1 : -1;
        for (let k = 0, x = ltr ? 0 : w - 1; k < w; k++, x += dx) {
          const i = y * w + x, p = i * 4, a = px[p + 3], e = (x + 1) * 3;
          if (!a) { out[i] = transparent; continue; }
          if (mask && !mask[i]) {
            const f0 = a / 255, r0 = px[p] * f0, g0 = px[p + 1] * f0, b0 = px[p + 2] * f0, k0 = bucket(r0, g0, b0, a);
            let i0 = cache[k0];
            if (i0 < 0) i0 = cache[k0] = nearest(r0, g0, b0, a);
            out[i] = i0;
            continue;
          }
          const f = a / 255;
          const r = Math.min(a, Math.max(0, px[p] * f + cur[e])), g = Math.min(a, Math.max(0, px[p + 1] * f + cur[e + 1])), b = Math.min(a, Math.max(0, px[p + 2] * f + cur[e + 2]));
          const key = bucket(r, g, b, a);
          let idx = cache[key];
          if (idx < 0) idx = cache[key] = nearest(r, g, b, a);
          out[i] = idx;
          const q = idx * 4, er = (r - pal[q]) * D, eg = (g - pal[q + 1]) * D, eb = (b - pal[q + 2]) * D;
          const R = e + dx * 3, L = e - dx * 3;
          cur[R] += er * 7 / 16; cur[R + 1] += eg * 7 / 16; cur[R + 2] += eb * 7 / 16;
          nxt[L] += er * 3 / 16; nxt[L + 1] += eg * 3 / 16; nxt[L + 2] += eb * 3 / 16;
          nxt[e] += er * 5 / 16; nxt[e + 1] += eg * 5 / 16; nxt[e + 2] += eb * 5 / 16;
          nxt[R] += er / 16; nxt[R + 1] += eg / 16; nxt[R + 2] += eb / 16;
        }
        const t = cur; cur = nxt; nxt = t; nxt.fill(0);
      }
      return out;
    }

    const CRC = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    function chunk(type, data) {
      const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      let c = 0xFFFFFFFF;
      for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xFF] ^ (c >>> 8);
      dv.setUint32(8 + data.length, (c ^ 0xFFFFFFFF) >>> 0);
      return out;
    }
    async function zlib(u) {
      const parts = [], reader = new Blob([u]).stream().pipeThrough(new CompressionStream('deflate')).getReader();
      let n = 0;
      for (;;) { const r = await reader.read(); if (r.done) break; parts.push(r.value); n += r.value.length; }
      const out = new Uint8Array(n);
      let o = 0;
      parts.forEach(p => { out.set(p, o); o += p.length; });
      return out;
    }
    // Indexed-colour PNG (ISO/IEC 15948): PLTE, tRNS for the see-through entries (sorted first),
    // the smallest bit depth that fits, no row filters (best for palette images).
    async function writePng(w, h, rgba, n, idx) {
      const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => (rgba[x * 4 + 3] === 255) - (rgba[y * 4 + 3] === 255) || x - y);
      const remap = new Uint8Array(n);
      order.forEach((o, i) => { remap[o] = i; });
      const plte = new Uint8Array(3 * n);
      let trns = 0;
      order.forEach((o, i) => { plte.set([rgba[o * 4], rgba[o * 4 + 1], rgba[o * 4 + 2]], i * 3); if (rgba[o * 4 + 3] < 255) trns = i + 1; });
      const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8, per = 8 / depth, row = Math.ceil(w / per);
      const raw = new Uint8Array(h * (row + 1));
      for (let y = 0; y < h; y++) {
        const o = y * (row + 1) + 1, s = y * w;
        if (depth === 8) for (let x = 0; x < w; x++) raw[o + x] = remap[idx[s + x]];
        else for (let x = 0; x < w; x++) raw[o + ((x / per) | 0)] |= remap[idx[s + x]] << (8 - depth * (x % per + 1));
      }
      const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
      dv.setUint32(0, w); dv.setUint32(4, h);
      ihdr[8] = depth; ihdr[9] = 3;
      const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte)];
      if (trns) parts.push(chunk('tRNS', Uint8Array.from(order.slice(0, trns), o => rgba[o * 4 + 3])));
      parts.push(chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0)));
      let len = 0;
      parts.forEach(p => { len += p.length; });
      const out = new Uint8Array(len);
      let o = 0;
      parts.forEach(p => { out.set(p, o); o += p.length; });
      return out;
    }

    // img = { w, h, px, mask? } (straight RGBA); remembers its histogram and palettes between calls.
    async function png(img, colours, useDither) {
      const { w, h, px } = img;
      if (img.exact === undefined) img.exact = exactColours(px, 256);
      if (img.exact && img.exact.size <= colours) {
        const map = img.exact, n = map.size, rgba = new Uint8Array(n * 4), idx = new Uint8Array(w * h);
        const v = new Uint32Array(px.buffer, px.byteOffset, w * h);
        map.forEach((i, c) => { rgba[i * 4] = c & 255; rgba[i * 4 + 1] = (c >>> 8) & 255; rgba[i * 4 + 2] = (c >>> 16) & 255; rgba[i * 4 + 3] = c >>> 24; });
        for (let i = 0; i < w * h; i++) idx[i] = map.get(px[i * 4 + 3] ? v[i] : 0);
        return { bytes: await writePng(w, h, rgba, n, idx), colours: n, exact: true };
      }
      if (!img.hist) img.hist = histogram(px);
      const H = img.hist, reserve = H.transparent ? 1 : 0;
      img.pals = img.pals || {};
      let P = img.pals[colours];
      if (!P) {
        const pal = medianCut(H, Math.max(1, Math.min(colours - reserve, H.m)));
        const assign = refine(H, pal, H.m > 150000 ? 1 : 3);
        P = img.pals[colours] = { pal, assign };
      }
      const k = P.pal.length >> 2, n = k + reserve, pal = new Float64Array(n * 4);
      pal.set(P.pal);
      const transparent = reserve ? k : 0;
      let idx;
      if (useDither) idx = dither(px, w, h, pal, reserve ? n - 1 : n, transparent, img.mask);
      else {
        idx = new Uint8Array(w * h);
        for (let i = 0, p = 0; i < w * h; i++, p += 4) {
          const a = px[p + 3];
          if (!a) { idx[i] = transparent; continue; }
          let r = px[p], g = px[p + 1], b = px[p + 2];
          if (a < 255) { const f = a / 255; r *= f; g *= f; b *= f; }
          idx[i] = P.assign[H.index[bucket(r, g, b, a)]];
        }
      }
      // Premultiplied palette back to straight colour for the file.
      const rgba = new Uint8Array(n * 4);
      for (let i = 0; i < k; i++) {
        const a = Math.round(Math.min(255, Math.max(0, pal[i * 4 + 3])));
        rgba[i * 4 + 3] = a;
        if (a) for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(Math.min(255, Math.max(0, pal[i * 4 + c] * 255 / pal[i * 4 + 3])));
      }
      return { bytes: await writePng(w, h, rgba, n, idx), colours: n, exact: false };
    }
    return { png };
  }

  // The steps of PDF to PNG between drawing a page and saving it. Self-contained like quantKit, as it
  // also runs in the worker: K is a quantKit() and newCanvas(w, h) makes a canvas (an OffscreenCanvas
  // in the worker).
  function pixKit(K, newCanvas) {
    // ITU-R 601 luma with Pillow's rounding (its convert('L')), so a test can check it exactly.
    const luma = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;

    // White to alpha: each pixel becomes the most see-through colour that looks the same over white.
    // White goes clear, grey becomes black that is partly see-through, and the soft edge of a letter
    // keeps its shading, where a plain white colour key would leave a pale fringe round it.
    function whiteToAlpha(px) {
      for (let p = 0; p < px.length; p += 4) {
        const a = px[p + 3];
        if (!a) continue;
        const m = Math.min(px[p], px[p + 1], px[p + 2]), k = 255 - m;
        if (!k) { px[p] = px[p + 1] = px[p + 2] = px[p + 3] = 0; continue; }
        if (!m) continue;
        px[p] = Math.round((px[p] - m) * 255 / k);
        px[p + 1] = Math.round((px[p + 1] - m) * 255 / k);
        px[p + 2] = Math.round((px[p + 2] - m) * 255 / k);
        px[p + 3] = Math.round(a * k / 255);
      }
    }

    // The smallest box that holds every pixel that is not blank: almost white (each channel 251 or
    // more) on an opaque page, almost clear (alpha 4 or less) on a see-through one. null when the
    // whole page is blank.
    function contentBox(px, w, h, alpha) {
      const blank = alpha ? p => px[p + 3] <= 4 : p => px[p] >= 251 && px[p + 1] >= 251 && px[p + 2] >= 251;
      let top = -1, bottom = -1, left = w, right = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        let x = 0;
        while (x < w && blank(row + x * 4)) x++;
        if (x === w) continue;
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        let r = w - 1;
        while (r > right && r > x && blank(row + r * 4)) r--;
        if (r > right) right = r;
      }
      return top < 0 ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    }

    function crop(px, w, b) {
      const out = new Uint8ClampedArray(b.w * b.h * 4);
      for (let y = 0; y < b.h; y++) {
        const from = ((b.y + y) * w + b.x) * 4;
        out.set(px.subarray(from, from + b.w * 4), y * b.w * 4);
      }
      return out;
    }

    // One byte a pixel, 1 inside any of the rectangles [x0, y0, x1, y1]; null when none is on the image.
    function maskOf(rects, w, h) {
      let mask = null;
      rects.forEach(r => {
        const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1]));
        const x1 = Math.min(w, Math.ceil(r[2])), y1 = Math.min(h, Math.ceil(r[3]));
        if (x1 <= x0 || y1 <= y0) return;
        if (!mask) mask = new Uint8Array(w * h);
        for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
      });
      return mask;
    }

    function grey(px) {
      for (let p = 0; p < px.length; p += 4) px[p] = px[p + 1] = px[p + 2] = luma(px[p], px[p + 1], px[p + 2]);
    }

    // Black and white: a grey value of 128 or more is white. Inside the mask (the pictures) the error
    // is spread to the next pixels (Floyd-Steinberg), so a photo keeps its shading as dots, while the
    // plain threshold keeps text sharp. Alpha becomes all or nothing.
    function bw(px, w, h, mask) {
      let cur = new Float32Array(w + 2), nxt = new Float32Array(w + 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x, p = i * 4;
          if (px[p + 3] < 128) { px[p] = px[p + 1] = px[p + 2] = px[p + 3] = 0; continue; }
          let v = luma(px[p], px[p + 1], px[p + 2]);
          if (mask && mask[i]) {
            const t = v + cur[x + 1], o = t >= 128 ? 255 : 0, e = t - o;
            cur[x + 2] += e * 7 / 16; nxt[x] += e * 3 / 16; nxt[x + 1] += e * 5 / 16; nxt[x + 2] += e / 16;
            v = o;
          } else v = v >= 128 ? 255 : 0;
          px[p] = px[p + 1] = px[p + 2] = v;
          px[p + 3] = 255;
        }
        if (mask) { const t = cur; cur = nxt; nxt = t; nxt.fill(0); }
      }
    }

    // m = { px, w, h, white, trim, alpha, colours, rects, width, boundsOnly }; px is changed.
    async function run(m) {
      let w = m.w, h = m.h, px = m.px;
      const alpha = !!(m.alpha || m.white);
      if (m.white) whiteToAlpha(px);
      let box = null;
      if (m.trim || m.boundsOnly) {
        box = contentBox(px, w, h, alpha);
        // A width asked for: the box becomes that wide, centred on the content, as far as the
        // drawing reaches (it is drawn with some room on each side).
        if (box && m.width && box.w !== m.width) {
          const bw = Math.min(m.width, w);
          box = { x: Math.max(0, Math.min(w - bw, Math.round(box.x + box.w / 2 - bw / 2))), y: box.y, w: bw, h: box.h };
        }
        if (m.boundsOnly) return { box, w, h };
      }
      let ox = 0, oy = 0;
      if (box && (box.w < w || box.h < h)) { px = crop(px, w, box); ox = box.x; oy = box.y; w = box.w; h = box.h; }
      const out = { w, h, box, blank: !!m.trim && !box };
      if (m.colours === 'exact') {
        const c = newCanvas(w, h);
        c.getContext('2d', { alpha }).putImageData(new ImageData(px, w, h), 0, 0);
        out.blob = await (c.convertToBlob ? c.convertToBlob({ type: 'image/png' }) : new Promise(done => c.toBlob(done, 'image/png')));
        c.width = c.height = 0;
        if (!out.blob) throw new Error('ENCODE');
        return out;
      }
      const mask = m.colours === 'grey' ? null : maskOf((m.rects || []).map(r => [r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy]), w, h);
      if (m.colours === 'grey') grey(px);
      else if (m.colours === 'bw') bw(px, w, h, mask);
      const img = { w, h, px };
      if (m.colours === '256' && mask) img.mask = mask;
      const r = await K.png(img, 256, !!img.mask);
      out.bytes = r.bytes;
      out.colours = r.colours;
      return out;
    }
    return { run, whiteToAlpha, contentBox };
  }

  // Runs quantKit in a Web Worker. Compress Image sends { key, blob, colours, dither }: the worker
  // decodes the lossless PNG it is given, keeps the pixels of the last image (the target-size search
  // asks for several palette sizes in a row) and returns the bytes of the indexed PNG. PDF to PNG
  // sends { op: 'pixels', px, ... } with a drawn page, for pixKit.
  function quantWorkerMain(makeKit, makePix) {
    const K = makeKit(), P = makePix(K, (w, h) => new OffscreenCanvas(w, h));
    let img = null;
    self.onmessage = async e => {
      const m = e.data;
      if (m.free) { img = null; return; }
      try {
        if (m.op === 'pixels') {
          const r = await P.run(m);
          self.postMessage(Object.assign({ id: m.id }, r), r.bytes ? [r.bytes.buffer] : []);
          return;
        }
        if (!img || img.key !== m.key) {
          img = null;
          const bmp = await createImageBitmap(m.blob);
          const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(bmp, 0, 0);
          img = { key: m.key, w: c.width, h: c.height, px: g.getImageData(0, 0, c.width, c.height).data };
          bmp.close();
          c.width = 0;
        }
        const r = await K.png(img, m.colours, m.dither);
        self.postMessage({ id: m.id, bytes: r.bytes, colours: r.colours, exact: r.exact }, [r.bytes.buffer]);
      } catch (err) {
        self.postMessage({ id: m.id, error: String((err && err.message) || err) });
      }
    };
  }
  let qWorker = null, qId = 0, localKit = null, localImg = null, localPix = null; // qWorker === false: unavailable
  const qWaiting = new Map();
  function quantInWorker(msg, transfer) {
    if (qWorker === null) {
      try {
        if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') throw new Error('unsupported');
        const w = new Worker(URL.createObjectURL(new Blob(['(' + quantWorkerMain + ')(' + quantKit + ', ' + pixKit + ');'], { type: 'text/javascript' })));
        w.onmessage = e => { const cb = qWaiting.get(e.data.id); if (cb) { qWaiting.delete(e.data.id); cb(e.data); } };
        w.onerror = e => {
          if (e && e.preventDefault) e.preventDefault();
          w.terminate();
          qWorker = false;
          qWaiting.forEach(cb => cb({ error: 'WORKER' }));
          qWaiting.clear();
        };
        qWorker = w;
      } catch (e) { qWorker = false; }
    }
    if (!qWorker) return Promise.reject(new Error('WORKER'));
    return new Promise((resolve, reject) => {
      const id = ++qId;
      qWaiting.set(id, d => (d.error ? reject(new Error(d.error)) : resolve(d)));
      qWorker.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }
  // Drop the pixels the quantiser keeps between tries.
  function quantFree() {
    localImg = null;
    if (qWorker) qWorker.postMessage({ free: true });
  }
  async function quantize(key, blob, colours, dither) {
    try {
      return await quantInWorker({ key, blob, colours, dither });
    } catch (e) {
      if (e.message !== 'WORKER') throw e;
    }
    // No worker (or it crashed): the same code on the page.
    if (!localImg || localImg.key !== key) {
      localImg = null;
      const bmp = await createImageBitmap(blob), c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      localImg = { key, w: c.width, h: c.height, px: g.getImageData(0, 0, c.width, c.height).data };
      if (bmp.close) bmp.close();
    }
    localKit = localKit || quantKit();
    return localKit.png(localImg, colours, dither);
  }

  // PDF to PNG: the canvas is read at once (it may be freed as soon as this returns) and its pixels
  // go to the worker. Without a worker the same code runs on the page. If the worker dies after the
  // pixels were handed over, the call fails with WORKER and the next one runs on the page.
  async function pixels(canvas, job) {
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const msg = Object.assign({ op: 'pixels', w, h, px }, job);
    try {
      return await quantInWorker(msg, [px.buffer]);
    } catch (e) {
      if (e.message !== 'WORKER' || !px.byteLength) throw e;
    }
    localKit = localKit || quantKit();
    localPix = localPix || pixKit(localKit, (cw, ch) => Object.assign(document.createElement('canvas'), { width: cw, height: ch }));
    return localPix.run(msg);
  }

  window.TTPng = { withDpi, quantKit, pixKit, quantize, quantFree, pixels, crc32 };
})();
