WebP encoder (WebAssembly), used to save WebP images
===================================================

Files
  webp_enc_simd.js     Emscripten loader, an ES module (single-threaded build)
  webp_enc_simd.wasm   libwebp 1.1.0 with the encode binding, built with
                       WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4)
  webp_enc.js          the same loader for the build without SIMD
  webp_enc.wasm        libwebp 1.1.0 without SIMD, for browsers that lack it
                       (Safari 15 to 16.3)
  LICENSE-jsquash.txt  Apache License 2.0 of @jsquash/webp and Squoosh
  LICENSE-libwebp.txt  libwebp's BSD 3-Clause licence and patent grant

Taken unmodified from the npm package @jsquash/webp 1.5.0, published
12 May 2025 (codec/enc/webp_enc_simd.js, codec/enc/webp_enc_simd.wasm,
codec/enc/webp_enc.js and codec/enc/webp_enc.wasm):
  https://registry.npmjs.org/@jsquash/webp/-/webp-1.5.0.tgz
  sha1 of the tarball (matches the registry's shasum):
    1e8ce357cde2decf4f880a8c436f8f1529cd3f48
  sha256 of the tarball:
    b543cb1fc17e99c31e992a71d70da570d1bc1871ce3a88440df067e5b2e6ee9e
  sha256 of the files:
    3038e60ebba6252baba08c691e31d1efe5036a185435daa7b4afaef3cc9273f9  webp_enc_simd.js
    39c279269ec1163b987b6d69749458e3d5b03b9585f58b6ca5455b76b504a305  webp_enc_simd.wasm
    5fd62301662e37785aec38e38807926f72933d4c8b919018a43faf1b1ca760f6  webp_enc.js
    b6085bb6702f144e9dc6016d58d230b34a84976bf0d080b7390b4b4b137d6ab7  webp_enc.wasm
  Project: https://github.com/jamsinclair/jSquash (packages/webp), a repackaging
  of the Squoosh codec: https://github.com/GoogleChromeLabs/squoosh (codecs/webp)
  The package's codec/README.md says libwebp v1.0.2, but the binaries report
  version 0x010100 (1.1.0) from their version() function.

The package's own encode.js, and its one dependency (wasm-feature-detect), are
not used: /assets/js/image-decode.js chooses the build itself with
WebAssembly.validate and passes the whole option set (WebPConfig) on each call.

Licences
  @jsquash/webp and the Squoosh wrapper: Apache License 2.0
  (LICENSE-jsquash.txt). libwebp: BSD 3-Clause plus the WebM patent grant
  (LICENSE-libwebp.txt, from libwebp's COPYING and PATENTS at v1.1.0).

How it is used
  /assets/js/image-decode.js loads one of the two loaders in a module Web
  Worker, and fetches the matching .wasm file from this folder, the first time
  a page saves a WebP through it. It makes no other requests.
