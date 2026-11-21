PDF.js, a PDF renderer (used by the Merge PDF tool for page thumbnails)
========================================================================

Package:  pdfjs-dist 6.3.289, the "legacy" build (wider browser support), unmodified
          except for the file extension:
            pdf.min.js           = legacy/build/pdf.min.mjs         (an ES module)
            pdf.worker.min.js    = legacy/build/pdf.worker.min.mjs  (an ES module worker)
          The files are renamed from .mjs to .js only so that every static host
          serves them with a JavaScript MIME type, which browsers require for
          modules. The content is byte-for-byte the published file.
            wasm/openjpeg.wasm   JPEG 2000 decoder     (LICENSE_OPENJPEG, LICENSE_PDFJS_OPENJPEG)
            wasm/jbig2.wasm      JBIG2 decoder (PDFium) (LICENSE_JBIG2, LICENSE_PDFJS_JBIG2)
            wasm/qcms_bg.wasm    colour management      (LICENSE_QCMS, LICENSE_PDFJS_QCMS)
          The package's cmaps/, standard_fonts/ and iccs/ folders are kept
          separately, unmodified, in assets/vendor/pdfjs-resources/. They draw
          fonts a PDF does not embed (mostly CJK, Symbol and ZapfDingbats) and
          CMYK colours; PDF to JPG and Split PDF pass their URLs to pdf.js.
Source:   https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz
          sha256 06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241
          https://github.com/mozilla/pdf.js
License:  Apache License 2.0, see LICENSE. The WebAssembly decoders keep their own
          permissive licenses (BSD-style and MIT), in the wasm/ folder. The legacy
          build bundles core-js polyfills (MIT, see LICENSE_CORE_JS).
