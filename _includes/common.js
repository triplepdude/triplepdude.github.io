{%- comment -%}
  Shared helpers (window.TT). Inlined into the <head> of every page by
  _layouts/default.html, so tool scripts can use TT immediately without a
  blocking request. assets/js/common.js serves the same file for any old
  cached page. Everything between raw and endraw is copied as-is, never read
  as Liquid.
{%- endcomment -%}
{% raw %}
/* Shared helpers for every tool page. Loaded in <head>, so tool scripts can use
   window.TT immediately. */
(function () {
  'use strict';

  // One shared polite live region, so confirmations like "Copied!" are
  // announced even on buttons whose accessible name comes from aria-label.
  var live;
  function announce(text) {
    if (!document.body) return;
    if (!live) {
      live = document.createElement('div');
      live.className = 'visually-hidden';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 50);
  }

  function flash(btn, text) {
    if (!btn) return;
    announce(text);
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = text;
    clearTimeout(btn._ttTimer);
    btn._ttTimer = setTimeout(function () { btn.textContent = original; }, 1400);
  }

  function copy(text, btn) {
    text = text == null ? '' : String(text);
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      flash(btn, ok ? 'Copied!' : 'Press Ctrl+C');
      return Promise.resolve(ok);
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        flash(btn, 'Copied!');
        return true;
      }, fallback);
    }
    return fallback();
  }

  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms == null ? 150 : ms);
    };
  }

  function valueOf(el) {
    if (!el) return '';
    if ('value' in el && el.tagName !== 'BUTTON') return el.value;
    return el.textContent;
  }

  // Any <button data-copy-target="#id"> copies that element's value or text.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-copy-target]');
    if (!btn) return;
    e.preventDefault();
    copy(valueOf(document.querySelector(btn.getAttribute('data-copy-target'))), btn);
  });

  function all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  // A table too big for its box scrolls inside it: guide tables on a phone, a
  // .table-wrap at any width. Safari and older browsers scroll such a box from
  // the keyboard only while it, or a control inside it, has focus. So a box
  // that scrolls and holds no control is made a tab stop, and a wrapper also
  // gets a role and a name for screen readers to announce (a <table> keeps its
  // own role). Whatever was added is taken away again once the table fits. A
  // box that comes with its own tabindex is left alone.
  var SCROLLERS = '.prose table, .table-wrap';
  var CONTROLS = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]';

  function scrolls(el) {
    var cs = getComputedStyle(el);
    return (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) ||
      (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1);
  }

  function hasControl(el) {
    return all(CONTROLS, el).some(function (c) {
      return c.tabIndex >= 0 && !c.disabled && c.getClientRects().length > 0;
    });
  }

  function checkScrollers() {
    all(SCROLLERS).forEach(function (el) {
      watch(el);
      for (var child = el.firstElementChild; child; child = child.nextElementSibling) watch(child);
      var added = el._ttScroll;
      var needed = (added || !el.hasAttribute('tabindex')) && scrolls(el) && !hasControl(el);
      if (needed && !added) {
        added = ['tabindex'];
        el.setAttribute('tabindex', '0');
        if (el.tagName !== 'TABLE') {
          if (!el.hasAttribute('role')) {
            el.setAttribute('role', 'group');
            added.push('role');
          }
          if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
            // Named like the table inside, when that has a caption or a label.
            var table = el.querySelector('table');
            var ids = table && table.getAttribute('aria-labelledby');
            var name = table && (table.caption ? table.caption.textContent : table.getAttribute('aria-label'));
            if (ids) el.setAttribute('aria-labelledby', ids);
            else el.setAttribute('aria-label', (name || '').trim() || 'Scrollable table');
            added.push(ids ? 'aria-labelledby' : 'aria-label');
          }
        }
        el._ttScroll = added;
      } else if (!needed && added) {
        added.forEach(function (attr) { el.removeAttribute(attr); });
        el._ttScroll = null;
      }
    });
  }

  // Checked again whenever a table or its box changes size (rows added, a
  // phone turned, a section shown). The check waits for the next frame because
  // it starts watching boxes, which must not happen while the observer reports.
  var queued = false;
  function checkSoon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      checkScrollers();
    });
  }

  var sizes = window.ResizeObserver ? new ResizeObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.target.isConnected) return;
      sizes.unobserve(entry.target);
      entry.target._ttWatched = false;
    });
    checkSoon();
  }) : null;

  function watch(el) {
    if (!sizes || el._ttWatched) return;
    el._ttWatched = true;
    sizes.observe(el);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkScrollers);
  else checkScrollers();
  if (!sizes) {
    window.addEventListener('load', checkScrollers);
    window.addEventListener('resize', debounce(checkScrollers, 200));
  }
  // Tab is about to move focus, so catch what the observer cannot see, such as
  // a table that a tool has only just built.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') checkScrollers();
  }, true);

  window.TT = {
    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: all,
    copy: copy,
    download: download,
    debounce: debounce,
    flash: flash,
    announce: announce
  };
})();
{% endraw %}
