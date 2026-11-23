Apple Lossless (ALAC) decoder (WebAssembly), used to read Apple Lossless M4A
==========================================================================

Files
  alac.js       @mgz-dev/alac 0.1.1, dist/index.mjs: an ES module with its
                WebAssembly decoder (32,899 bytes) inlined as base64
  LICENSE.txt   its MIT licence (LICENSE in the package)
  NOTICE.txt    the MIT notices of the work it is derived from: alicebob/alac
                (Go) and David Hammerton's 2005 ALAC decoder in C (NOTICE in
                the package)

Taken unmodified from the npm package @mgz-dev/alac 0.1.1, published
19 September 2026:
  https://registry.npmjs.org/@mgz-dev/alac/-/alac-0.1.1.tgz
  sha1 of the tarball (matches the registry's shasum):
    44328c56edb3f21387c7562e9e7263a09dc2e5fd
  sha256 of the tarball:
    2ac71622ee53ad0d107ed568e5c9a0372fe0666ead5156bce4acdba4622221bf
  sha256 of alac.js:
    4cc29c7a961db9efe27ea2bd22593f54c80056d0c14da72d22dc3abfb05b62f5
  sha256 of the WebAssembly module inside it:
    c8a80a225c18c583cbd3d8491dc449531f49168e3e99e1dbc06e1782478cb7ce
  Project: https://github.com/marcogomez/alac (Rust, built to WebAssembly)

index.mjs is renamed to alac.js only so that every static host serves it as
JavaScript, which a module worker requires; its content is byte for byte the
published file. It has no dependencies and makes no requests.

How the site uses it
  /assets/js/alac-worker.js imports it in a module worker, started by the
  audio engine (/assets/js/audio-engine.js) the first time an Apple Lossless
  file is decoded, as on /m4a-to-mp3/. The library compiles its WebAssembly
  with a synchronous call, which Chrome before version 115 refuses on a
  page's main thread but allows in a worker. The module needs WebAssembly
  SIMD and reference types (Chrome 96, Firefox 89, Safari 16.4) and module
  workers (Chrome 80, Firefox 114, Safari 15).
  It decodes 16 and 24-bit Apple Lossless in mono or stereo. For 20 and
  32-bit sound it gives silence, and of more than two channels only the
  first channel comes out (the others are silent), so the engine refuses
  those files from their own ALAC header before decoding. openTrack() copies the whole file into the
  module's memory, so the engine limits the size of the file it decodes
  (TTAudio.limits.alac).

Licence
  MIT (LICENSE.txt), Copyright (c) 2026 Marco Gomez. The notices of the Go
  and C decoders it is derived from, both MIT, are in NOTICE.txt.
