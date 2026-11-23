omggif, GIF decoder (used by assets/js/gif-frames.js, for /gif-to-mp4/)
=======================================================================

Files
  omggif.js     omggif.js from the package, unmodified. A classic script: it
                defines the global GifReader (and GifWriter). It is loaded
                only inside the Web Worker that assets/js/gif-frames.js
                starts where the browser's ImageDecoder is missing (Safari
                before 27.3, and older Chrome and Firefox) or is not used:
                for GIFs over 256 MiB, which ImageDecoder would hold in
                memory whole (on /gif-to-mp4/, over 96 MB on phones), and
                from a frame that ImageDecoder refuses onwards. It is never
                loaded on the page itself.
  LICENSE.txt   the MIT licence from the header of omggif.js.

  Package:  omggif 1.0.10 (MIT), by Dean McNamee, published 16 July 2019,
            no dependencies
  Source:   https://registry.npmjs.org/omggif/-/omggif-1.0.10.tgz
            https://github.com/deanm/omggif
  sha1 of the tarball (matches the registry's shasum):
            ddaaf90d4a42f532e9e7cb3a95ecdd47f17c7b19
  sha256 of the tarball:
            576d726ddedd2c546750707e01cd247752027aa9250a6066e32047aa3d25287e
  sha256 of omggif.js:
            bd898d5b7e43038c7b4c26bf1e1057fe23a44f90312469d802a4e7caf3ae3b12

How it is used
  gif-frames.js reads the file's blocks itself and hands GifReader one small
  GIF per frame (that frame alone, at 0,0, its palette padded to 256
  colours), then calls decodeAndBlitFrameRGBA. So GifReader never meets what
  it cannot handle (Plain Text Extensions and cut-off files, on which it
  throws, or frames that run past the edge of the canvas, which it wraps to
  the next row), and interlaced rows, disposal and compositing are done in
  gif-frames.js. omggif writes notes on data of an unexpected length with
  console.log; gif-frames.js silences them while it decodes.

Licence: MIT License, Copyright (c) 2013 Dean McNamee; see LICENSE.txt.
