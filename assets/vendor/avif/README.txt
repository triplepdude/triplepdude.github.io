AVIF encoder (WebAssembly), used to save AVIF images
====================================================

Files
  avif_enc.js    Emscripten loader, an ES module (single-threaded build)
  avif_enc.wasm  libavif 1.0.1 with the libaom 3.7.0 AV1 encoder and libsharpyuv
  LICENSE        the licenses of everything compiled into these two files

Taken unmodified from the npm package @jsquash/avif 2.1.1
(codec/enc/avif_enc.js and codec/enc/avif_enc.wasm):
  https://registry.npmjs.org/@jsquash/avif/-/avif-2.1.1.tgz
  sha256 of the tarball: b6c6204b63f9cb17aac7d6ee92b8a4aeba2403dccd49ffc9a93b778923049b5b
  Project: https://github.com/jamsinclair/jSquash (packages/avif), a repackaging
  of the Squoosh codec: https://github.com/GoogleChromeLabs/squoosh (codecs/avif)

Licenses
  @jsquash/avif and the Squoosh wrapper: Apache License 2.0
  libavif: BSD 2-Clause; libaom: BSD 2-Clause plus the Alliance for Open Media
  Patent License 1.0; libsharpyuv (from libwebp): BSD 3-Clause plus the WebM
  patent grant. All texts are in LICENSE.

How it is used
  /assets/js/image-decode.js loads avif_enc.js in a module Web Worker, and
  fetches avif_enc.wasm from this folder, only when a page asks to save AVIF in
  a browser whose canvas cannot encode AVIF itself. It makes no other requests.
