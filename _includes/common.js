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

  window.TT = {
    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
    copy: copy,
    download: download,
    debounce: debounce,
    flash: flash,
    announce: announce
  };
})();
{% endraw %}
