{%- comment -%}
  pdfjsLoader(url, workerSrc, ready): imports the PDF.js module on first use, for every page that
  reads PDFs with it (Split PDF, Merge PDF, Compress PDF, Rotate PDF, PDF to Text, Image to Text,
  and PDF to JPG and PDF to PNG through _includes/pdf-pages.js), and imports it again after a
  failure.

  A page includes it in its script, where the function is to be defined, with an include tag for
  pdfjs-loader.js at the start of a line of its own. As with _includes/pdf-unlocker.js, the tag
  must sit outside the page's raw block: end the raw block just before it and open it again just
  after. The function is indented to sit inside the page's (function () { ... })() wrapper, and
  the file ends without a newline.

  pdfjsLoader(url, workerSrc, ready) -> load
    url         the address of pdf.min.js; workerSrc that of pdf.worker.min.js, which the module
                gets as GlobalWorkerOptions.workerSrc.
    ready(lib)  optional: told once the module has loaded, before load's promise resolves, to make
                the page's PDFWorker, for example.
    load()      a Promise of the module. Calls while it loads share one import, and later calls get
                the same module. When the import fails (a dropped connection, a file cut short), the
                promise rejects with the browser's error, and the next call imports the module again
                under another address: url?try=2, then url?try=3 and so on. A browser keeps a module
                that failed in the page's module map, failed, so asking for the same address again
                would fail at once, however good the connection, until the page is reloaded.
{%- endcomment -%}
{% raw %}  function pdfjsLoader(url, workerSrc, ready) {
    var loading = null, failures = 0;
    return function load() {
      if (loading) return loading;
      var at = failures ? url + (url.indexOf('?') < 0 ? '?' : '&') + 'try=' + (failures + 1) : url;
      loading = import(at).then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = workerSrc;
        if (ready) ready(lib);
        return lib;
      }, function (err) {
        loading = null;
        failures++;
        throw err;
      });
      return loading;
    };
  }{% endraw %}