/*
 * TTWave: the shared parts of the audio pages' waveform editors
 * (window.TTWave): reading and writing times, drawing a waveform, the
 * pointer rules of dragging on it, and the keys of its handles. Used by the
 * converter include (_includes/audio-converter-tool.html) and by MP3 Cutter
 * (_tools/mp3-cutter.html). No dependencies, no state: a page keeps its own
 * selection and calls these with it. The levels it draws come from
 * TTAudio.levels() and TTAudio.scan() (assets/js/audio-engine.js).
 *
 * Load it where it is needed, before the page's script:
 *   <script src="{{ '/assets/js/audio-wave.js' | relative_url }}"></script>
 *
 * TIMES (milliseconds, whole numbers)
 *   TTWave.parseTime(text) -> { ms } or { error: 'empty' | 'format' | 'sixty' }:
 *     [[h:]m:]s with a dot or a comma before the decimals, so '1:23.5',
 *     '83.5' and '83,5' are all 83,500 ms. There are no thousands separators
 *     in a time. Digits typed in Arabic-Indic, Persian or full-width form (a
 *     phone set to those digits types them) count as 0-9, with the
 *     full-width colon, full stop and comma and the Arabic decimal
 *     separator; other look-alikes, such as a raised ², do not. Spaces and
 *     tabs inside are refused; only the first 40 characters are read.
 *     Milliseconds are rounded from the fourth decimal. 'sixty': minutes or
 *     seconds of 60 or more after a colon.
 *   TTWave.parseSeconds(text) -> { ms } or { error: 'format' }: seconds such
 *     as '2', '0.5' or '0,5' (a fade); empty is 0. The first 20 characters.
 *   TTWave.fmtTime(ms) -> 'm:ss.mmm', or 'h:mm:ss.mmm' from an hour.
 *   TTWave.fmtShort(ms) -> 'm:ss' or 'h:mm:ss', to the nearest second.
 *   TTWave.normDigits(text) -> the text with the digits above as 0-9.
 *
 * DRAWING
 *   TTWave.colors(el) -> { bg, sel, mid, wave, dim, clip }: the colours
 *     drawn with, read from the CSS variables in effect on el (--surface-2,
 *     --accent-soft, --border, --accent, --muted, --danger), so the light
 *     and dark schemes both work. Read them again when the scheme changes.
 *   TTWave.draw(canvas, o): fills the canvas, sized to its CSS box times
 *     devicePixelRatio, with a waveform. o = {
 *       dur      length of the track (ms)
 *       view     [from, to] (ms) shown across the canvas (default [0, dur])
 *       levels   { min, max } Float32Arrays of buckets (TTAudio.levels:
 *                .min/.max, or .monoMin/.monoMax as min and max), or null to
 *                draw the background alone; min > max where nothing was read
 *       span     [from, to] (ms) the levels cover (default [0, dur])
 *       regions  [{ start, end, gain }]: the parts kept (ms), drawn on the
 *                selection colour with the wave in the accent colour; gain:
 *                function (ms on the track) -> the factor the result applies
 *                there (fades, volume), or null for 1. Where the factor takes
 *                the wave past full scale it is drawn in the danger colour.
 *                Everything outside the regions is drawn muted.
 *       cuts     [{ start, end }]: parts cut out, drawn hatched (default none)
 *       colors   TTWave.colors() of the page }
 *     With view and span both [0, dur], one bucket range a pixel is
 *     floor(x * buckets / width) to floor((x + 1) * buckets / width), as the
 *     converter has always drawn it.
 *
 * POINTER
 *   TTWave.pointer(el, o) listens to pointer events on el. The rules: a
 *     mouse acts on the press; a finger or pen put down on el may be
 *     starting to scroll the page (el keeps touch-action: pan-y), so
 *     nothing happens until it lifts without moving (a tap) or moves at
 *     least 10 px sideways and more sideways than up or down (a slide).
 *     Something o.grab() names (a handle under the finger) is taken at once
 *     also by touch, as it has touch-action: none. o = {
 *       can(ev)     false to ignore a press or a tap (editor closed,
 *                   disabled ...); a slide under way is not asked again
 *       grab(ev)    what a press takes at once whatever the pointer, or a
 *                   falsy value (default none)
 *       start(ev, x, grabbed, how)  a drag begins: x is the clientX where
 *                   the pointer went down, how 'press', 'tap' or 'slide'
 *                   (ev is then the move that made it one, at ev.clientX)
 *       move(ev)    the pointer moved during a drag
 *       end(ev)     the drag ended (also right after a tap's start) }
 *     The pointer is captured by el while it drags.
 *   TTWave.msAt(el, clientX, from, to, step) -> the time (ms) at clientX on
 *     el showing from..to, kept inside it and rounded to `step` ms.
 *
 * KEYS
 *   TTWave.keyValue(ev, value, lo, hi, steps) -> the value (ms) a key moves
 *     a handle to, or null for other keys: ← and ↓ take away steps.small
 *     (default 100 ms), → and ↑ add it, Shift makes it steps.big (1,000 ms),
 *     Alt steps.fine when one is given, Page Down and Page Up 10 s, Home and
 *     End go to lo and hi. The caller keeps the value within its limits.
 */
(function () {
  'use strict';

  // ---------- Times ----------
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function fmtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000;
    var tail = pad(s, 2) + '.' + pad(f, 3);
    return h ? h + ':' + pad(m, 2) + ':' + tail : m + ':' + tail;
  }
  function fmtShort(ms) {
    var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? h + ':' + pad(m, 2) + ':' + pad(s % 60, 2) : m + ':' + pad(s % 60, 2);
  }
  function normDigits(s) {
    return s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48); })
      .replace(/[٠-٩]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48); })
      .replace(/[۰-۹]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 48); })
      .replace(/：/g, ':').replace(/[．٫]/g, '.').replace(/，/g, ',');
  }
  function fracMs(f) {
    if (!f) return 0;
    var ms = +(f + '00').slice(0, 3);
    return f.length > 3 && +f.charAt(3) >= 5 ? ms + 1 : ms;
  }
  function parseTime(text) {
    var s = normDigits(String(text).slice(0, 40)).trim();
    if (!s) return { error: 'empty' };
    if (/\s/.test(s)) return { error: 'format' };
    var parts = s.split(':');
    if (parts.length > 3) return { error: 'format' };
    var m = /^(\d{0,7})(?:[.,](\d{0,9}))?$/.exec(parts.pop());
    if (!m || (m[1] === '' && !m[2])) return { error: 'format' };
    for (var i = 0; i < parts.length; i++) if (!/^\d{1,4}$/.test(parts[i])) return { error: 'format' };
    var sec = +(m[1] || '0');
    var ms = sec * 1000 + fracMs(m[2] || '');
    if (parts.length) {
      var mins = +parts[parts.length - 1];
      if (sec >= 60 || (parts.length === 2 && mins >= 60)) return { error: 'sixty' };
      ms += mins * 60000 + (parts.length === 2 ? +parts[0] * 3600000 : 0);
    }
    return { ms: ms };
  }
  function parseSeconds(text) {
    var s = normDigits(String(text).slice(0, 20)).trim();
    if (!s) return { ms: 0 };
    var m = /^(\d{0,5})(?:[.,](\d{0,9}))?$/.exec(s);
    if (!m || (m[1] === '' && !m[2])) return { error: 'format' };
    return { ms: +(m[1] || '0') * 1000 + fracMs(m[2] || '') };
  }

  // ---------- Drawing ----------
  function colors(el) {
    var cs = getComputedStyle(el), v = function (n) { return cs.getPropertyValue(n).trim(); };
    return { bg: v('--surface-2'), sel: v('--accent-soft'), mid: v('--border'), wave: v('--accent'), dim: v('--muted'), clip: v('--danger') };
  }
  function draw(cv, o) {
    var dpr = window.devicePixelRatio || 1, c = o.colors;
    var W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    var g = cv.getContext('2d'), dur = o.dur;
    var vf = o.view ? o.view[0] : 0, vt = o.view ? o.view[1] : dur, span = vt - vf;
    var px = function (ms) { return Math.round((ms - vf) / (span || 1) * W); };
    var regions = (o.regions || []).map(function (r) { return { x0: px(r.start), x1: px(r.end), gain: r.gain || null }; });
    g.fillStyle = c.bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = c.sel;
    regions.forEach(function (r) { g.fillRect(r.x0, 0, Math.max(1, r.x1 - r.x0), H); });
    (o.cuts || []).forEach(function (r) {
      var x0 = Math.max(0, px(r.start)), x1 = Math.min(W, px(r.end)), step = Math.max(6, Math.round(8 * dpr));
      if (x1 <= x0) return;
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, H);
      g.clip();
      g.strokeStyle = c.mid;
      g.lineWidth = Math.max(1, Math.round(dpr));
      g.beginPath();
      for (var x = x0 - H; x < x1; x += step) { g.moveTo(x, H); g.lineTo(x + H, 0); }
      g.stroke();
      g.restore();
    });
    var mid = H / 2, amp = H / 2 * 0.92;
    g.fillStyle = c.mid;
    g.fillRect(0, Math.floor(mid), W, Math.max(1, Math.round(dpr)));
    var p = o.levels;
    if (!p) return;
    var B = p.min.length, lf = o.span ? o.span[0] : 0, lt = o.span ? o.span[1] : dur, same = lf === vf && lt === vt;
    var bucket = function (x) { return Math.floor((vf + x / W * span - lf) / ((lt - lf) || 1) * B); };
    for (var x = 0; x < W; x++) {
      var b0 = same ? Math.floor(x * B / W) : bucket(x), b1 = Math.max(b0 + 1, same ? Math.floor((x + 1) * B / W) : bucket(x + 1));
      var lo = Infinity, hi = -Infinity;
      for (var b = Math.max(0, b0); b < b1 && b < B; b++) { if (p.min[b] < lo) lo = p.min[b]; if (p.max[b] > hi) hi = p.max[b]; }
      if (lo > hi) continue;
      var r = null, clip = false;
      for (var i = 0; i < regions.length; i++) if (x >= regions[i].x0 && x < regions[i].x1) { r = regions[i]; break; }
      if (r) {
        var k = r.gain ? r.gain(vf + (x + 0.5) / W * span) : 1;
        lo *= k; hi *= k;
        if (hi > 1 || lo < -1) clip = true;
        lo = Math.max(-1, lo); hi = Math.min(1, hi);
      }
      var y0 = mid - hi * amp, y1 = mid - lo * amp;
      g.fillStyle = clip ? c.clip : r ? c.wave : c.dim;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  // ---------- Pointer ----------
  function msAt(el, clientX, from, to, step) {
    var r = el.getBoundingClientRect();
    var f = r.width ? (clientX - r.left) / r.width : 0;
    return Math.round((from + Math.max(0, Math.min(1, f)) * (to - from)) / step) * step;
  }
  function pointer(el, o) {
    var drag = null;
    function capture(ev) { try { el.setPointerCapture(ev.pointerId); } catch (x) { /* not capturable */ } }
    function finish(ev) {
      var d = drag;
      if (!d || ev.pointerId !== d.id) return;
      drag = null;
      if (!d.pending && o.end) o.end(ev);
    }
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button > 0 || (o.can && !o.can(ev))) return;
      var grabbed = o.grab ? o.grab(ev) : null;
      if (!grabbed && ev.pointerType !== 'mouse') { drag = { pending: true, id: ev.pointerId, x: ev.clientX, y: ev.clientY }; return; }
      drag = { id: ev.pointerId };
      capture(ev);
      o.start(ev, ev.clientX, grabbed, 'press');
      ev.preventDefault();
    });
    el.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      if (drag.pending) {
        var dx = Math.abs(ev.clientX - drag.x);
        if (dx >= 10 && dx > Math.abs(ev.clientY - drag.y)) {
          drag.pending = false;
          capture(ev);
          o.start(ev, drag.x, null, 'slide');
        }
        return;
      }
      if (o.move) o.move(ev);
    });
    el.addEventListener('pointerup', function (ev) {
      if (drag && drag.pending && ev.pointerId === drag.id && (!o.can || o.can(ev)) &&
          Math.abs(ev.clientX - drag.x) < 10 && Math.abs(ev.clientY - drag.y) < 10) {
        drag.pending = false;
        o.start(ev, drag.x, null, 'tap');
      }
      finish(ev);
    });
    el.addEventListener('pointercancel', finish);
  }

  // ---------- Keys ----------
  function keyValue(ev, v, lo, hi, steps) {
    steps = steps || {};
    var step = ev.shiftKey ? (steps.big || 1000) : ev.altKey && steps.fine ? steps.fine : (steps.small || 100);
    switch (ev.key) {
      case 'ArrowLeft': case 'ArrowDown': return v - step;
      case 'ArrowRight': case 'ArrowUp': return v + step;
      case 'PageDown': return v - 10000;
      case 'PageUp': return v + 10000;
      case 'Home': return lo;
      case 'End': return hi;
      default: return null;
    }
  }

  window.TTWave = {
    parseTime: parseTime, parseSeconds: parseSeconds, fmtTime: fmtTime, fmtShort: fmtShort, normDigits: normDigits,
    colors: colors, draw: draw, pointer: pointer, msAt: msAt, keyValue: keyValue
  };
})();
