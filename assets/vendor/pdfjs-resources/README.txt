PDF.js resource files (CMaps, standard fonts, CMYK colour profile)
===================================================================

Used by:  the Split PDF and PDF to JPG tools, together with assets/vendor/pdfjs/.
          PDF.js fetches a file from here only when a PDF needs it, from this
          site and never from another host:
            cmaps/            169 packed CMaps (.bcmap) for Chinese, Japanese and
                              Korean text set in fonts with a predefined CMap
                              (getDocument option cMapUrl)
            standard_fonts/   the Foxit and Liberation fonts PDF.js draws the
                              Symbol and ZapfDingbats fonts with when a PDF does not
                              embed them, and the other standard fonts when system
                              fonts are turned off (standardFontDataUrl)
            iccs/             CGATS001Compat-v2-micro.icc, the CMYK profile for
                              converting CMYK colours to screen colours (iccUrl)

Package:  pdfjs-dist 6.3.289, the same release as assets/vendor/pdfjs/. The folders
          cmaps/, standard_fonts/ and iccs/ of the package, unmodified.
Source:   https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz
          sha256 06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241
          https://github.com/mozilla/pdf.js
License:  PDF.js is Apache License 2.0 (assets/vendor/pdfjs/LICENSE). The data files
          keep their own licences, in their folders:
            cmaps/LICENSE                     Adobe CMap resources, BSD-3-Clause
            standard_fonts/LICENSE_FOXIT      Foxit fonts (from PDFium), BSD-3-Clause
            standard_fonts/LICENSE_LIBERATION Liberation fonts, GPL v2 with the font
                                              exception (a document that uses the fonts
                                              is not covered by the GPL)
            iccs/LICENSE                      CC0 1.0 (public domain)
