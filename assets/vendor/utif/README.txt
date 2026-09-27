UTIF.js, used to decode TIFF images
===================================

Package:  utif2 4.1.0 (maintained fork of Photopea's UTIF.js), MIT License
Source:   https://registry.npmjs.org/utif2/-/utif2-4.1.0.tgz
          https://github.com/photopea/UTIF.js
License:  MIT, see LICENSE (Copyright (c) 2017 Photopea)

UTIF.min.js is UTIF.js from that package, minified with terser 5. One line
was changed so it runs inside a Web Worker, where there is no `window`:
  if(window.UDOC) {   became   if(typeof UDOC!="undefined") {
It needs pako (../pako/pako_inflate.min.js) loaded first for Deflate TIFFs.
