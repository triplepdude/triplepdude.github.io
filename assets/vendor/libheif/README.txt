libheif (WebAssembly build), used to decode HEIC and HEIF images
================================================================

Files
  libheif.js    Emscripten loader (JavaScript glue)
  libheif.wasm  libheif 1.23.2 with the libde265 1.0.15 HEVC decoder
  LICENSE       the license texts shipped with the build (GNU LGPL 3.0,
                the GNU GPL 3.0 it incorporates, and MIT for libheif's
                sample code)

Taken unmodified from the npm package libheif-js 1.23.2
(libheif-wasm/libheif.js and libheif-wasm/libheif.wasm):
  https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.2.tgz
  sha256 of the tarball: 728cf3795a94b18039ac07c6d38c089b72f1eeae12c37bc9f18b0925fc709daa

License notice
  libheif is Copyright (c) struktur AG and its contributors, and libde265 is
  Copyright (c) struktur AG, Dirk Farin and contributors. Both are free
  software distributed under the GNU Lesser General Public License, version
  3.0 (LGPL-3.0); see LICENSE. They come with NO WARRANTY.

  This site uses the library unmodified, as separate files that the HEIC
  converters load only when you add a HEIC or HEIF file (see
  /assets/js/image-decode.js). You may replace libheif.js and libheif.wasm
  with your own build of the same interface, or a modified version, and the
  tools will load it instead.

Corresponding source
  libheif 1.23.2:    https://github.com/strukturag/libheif (tag v1.23.2)
  libde265 1.0.15:   https://github.com/strukturag/libde265 (tag v1.0.15)
  Emscripten build:  https://github.com/catdad-experiments/libheif-emscripten (tag v1.23.2)
  npm packaging:     https://github.com/catdad-experiments/libheif-js (tag v1.23.2)
  The exact files are also in the npm tarball listed above.
