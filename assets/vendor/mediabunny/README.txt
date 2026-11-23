Mediabunny and its MP3 encoder (used by MP4 to MP3 to read video and audio
files, cut, decode and re-encode their audio, and write MP3, WAV and M4A)
==========================================================================

Files
  mediabunny.min.js              mediabunny 1.65.2, dist/bundles/mediabunny.min.cjs
  mediabunny-mp3-encoder.min.js  @mediabunny/mp3-encoder 1.65.2,
                                 dist/bundles/mediabunny-mp3-encoder.min.js
  LICENSE.txt                    Mozilla Public License 2.0 (both packages)
  LAME-COPYING.txt               GNU Library General Public License 2.0
                                 (licenses/lame/COPYING in the encoder package)
  LAME-LICENSE.txt               LAME's note on using LAME (licenses/lame/LICENSE)

Both files are unmodified. mediabunny.min.cjs is renamed to .js only so that
every static host serves it as JavaScript (.cjs is often served as
application/node); its content is byte for byte the published file. Each is a
classic script: mediabunny.min.js defines the global Mediabunny, and the
encoder, loaded after it, defines MediabunnyMp3Encoder. The tool loads them
only when you add a file.

Sources
  https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz
    sha1   ef1db034a70f11702dba2fbe65e8342d268dfd38
    sha256 93bceb27fd807e06e8b6a0e9e02350bf69e1d70da12d685dd0b133b54c3b1ff6
  https://registry.npmjs.org/@mediabunny/mp3-encoder/-/mp3-encoder-1.65.2.tgz
    sha1   443ddf3743912cc774e0cd0d763faf4c470f0a41
    sha256 038175adb96faece6d12be6c8d282dd47f1d3dfbdb65993887ec2384b73ef57c
  Source code: https://github.com/Vanilagy/mediabunny (tag v1.65.2); the
  TypeScript sources are also in the npm tarballs above.

License notice
  Mediabunny and @mediabunny/mp3-encoder are Copyright (c) 2026-present,
  Vanilagy and contributors, and are distributed under the Mozilla Public
  License 2.0 (see LICENSE.txt). They come with NO WARRANTY.

  The MP3 encoder contains a WebAssembly build of the LAME MP3 encoder 3.100
  (https://lame.sourceforge.io/), which is free software under the GNU
  Library General Public License, version 2 or (at your option) any later
  version (see LAME-COPYING.txt and LAME-LICENSE.txt). LAME comes with NO
  WARRANTY. This site uses LAME unmodified, inlined in
  mediabunny-mp3-encoder.min.js, a separate file that the tool loads only to
  write MP3. You may replace that file with your own build of the same
  interface, for example one made from a modified LAME, and the tool will
  load it instead.

  Corresponding source of the LAME build, as given in the encoder's README:
    LAME 3.100: https://sourceforge.net/projects/lame/files/lame/3.100/lame-3.100.tar.gz
      sha256 ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
    src/lame-bridge.c of @mediabunny/mp3-encoder 1.65.2 (in its tarball)
    Built with Emscripten 4.0.21; the build commands are in the encoder's
    README.md (in its tarball). SHA-256 of the inlined WebAssembly binary:
    a680e507e9d91f1a4dcd6f846b9b94ff1fec7e19ff44e803358c218ddbe446a6

GIF to MP4 (/gif-to-mp4/) loads mediabunny.min.js only, when the first GIF
is added: the browser's own encoder (WebCodecs) makes the H.264 video, and
Mediabunny writes the MP4 file around it. The MP3 encoder is not loaded there.
