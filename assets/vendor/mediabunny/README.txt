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

Mediabunny's AAC encoder and ProRes decoder (used by MOV to MP4, through
assets/js/video-convert.js, to turn uncompressed sound into AAC and ProRes
video into H.264)
==========================================================================

Files
  mediabunny-aac-encoder.min.js  @mediabunny/aac-encoder 1.65.2,
                                 dist/bundles/mediabunny-aac-encoder.min.js
  mediabunny-prores.min.js       @mediabunny/prores 1.65.2,
                                 dist/bundles/mediabunny-prores.min.js
  FFMPEG-COPYING.LGPLv2.1.txt    GNU Lesser General Public License 2.1
                                 (licenses/ffmpeg/COPYING.LGPLv2.1 in the
                                 AAC encoder package)
  FFMPEG-LICENSE.txt             FFmpeg's licence overview
                                 (licenses/ffmpeg/LICENSE.md, renamed)
  LICENSE.txt (above) is the Mozilla Public License 2.0 of both packages and
  of TurboRes.

Both files are unmodified classic scripts. Loaded after mediabunny.min.js,
the encoder defines MediabunnyAacEncoder and the decoder MediabunnyProres.
The page loads the encoder only when the browser has no AAC encoder of its
own (Firefox, Chrome on desktop Linux, Safari before 26), and the decoder
only for ProRes video. Each starts its work in a Web Worker made from code
inside the file itself (a blob: URL), and neither fetches anything.

Sources
  https://registry.npmjs.org/@mediabunny/aac-encoder/-/aac-encoder-1.65.2.tgz
    sha1   4833e84a6a5b23b798be0c4a14d0051d10d4aa1c
    sha256 fc08136f72f5551295ca97218b622ee23aa65c81d39e95c81c7f4c5d96277d41
  https://registry.npmjs.org/@mediabunny/prores/-/prores-1.65.2.tgz
    sha1   4ee327bd36c89ec907c5e8c3ff99180299790c45
    sha256 6d39a64cfaca739b1e10ba95b8042ddd90b843e4623b081052708b8e3ee192b5
  https://registry.npmjs.org/turbores/-/turbores-1.2.4.tgz (bundled in the
  ProRes decoder)
    sha1   5ab61f588b6f7d80db08da6083203918f7186b1e
    sha256 52219d5c3b686a5edc95e26e00eb060d59b596477ac7c16124544bdede87792b
  Source code: https://github.com/Vanilagy/mediabunny (tag v1.65.2, folders
  packages/aac-encoder and packages/prores) and
  https://github.com/Vanilagy/turbores (version 1.2.4); the TypeScript
  sources are also in the npm tarballs above.

License notice
  @mediabunny/aac-encoder and @mediabunny/prores are Copyright (c)
  2026-present, Vanilagy and contributors, and TurboRes is by Vanilagy; all
  three are distributed under the Mozilla Public License 2.0 (see
  LICENSE.txt). They come with NO WARRANTY.

  The AAC encoder contains a WebAssembly build of FFmpeg's AAC encoder
  (https://ffmpeg.org/), which is free software under the GNU Lesser General
  Public License, version 2.1 or (at your option) any later version (see
  FFMPEG-COPYING.LGPLv2.1.txt and FFMPEG-LICENSE.txt). The build enables no
  GPL, version 3 or nonfree parts. FFmpeg comes with NO WARRANTY. This site
  uses it unmodified, inlined in mediabunny-aac-encoder.min.js, a separate
  file that the tool loads only to write AAC. You may replace that file
  with your own build of the same interface, for example one made from a
  modified FFmpeg, and the tool will load it instead.

  Corresponding source of the FFmpeg build, as given in the encoder's README:
    FFmpeg commit 60a2818f76dcd1fee3155b1791304af104a0fc1b
      (n9.1-dev-2902-g60a2818f76d), unmodified:
      https://github.com/FFmpeg/FFmpeg/commit/60a2818f76dcd1fee3155b1791304af104a0fc1b
    src/bridge.c of @mediabunny/aac-encoder 1.65.2 (in its tarball)
    Built with Emscripten 4.0.21 (d6f42310010ddec0753a69bab01a4b33aae255b7);
    the build commands are in the encoder's README.md (in its tarball).
    SHA-256 of the inlined WebAssembly binary (582,633 bytes):
    4123d56ed650255a14535d8438680a78df67ae9324e4874a88becfb37bf18c66

  The ProRes decoder inlines the WebAssembly of TurboRes 1.2.4 (133,516
  bytes, SHA-256
  892091f846d1ec08d984c12d9a408b9f934fb6ccfabdb7e650a482d992212ef1), the
  same bytes as in turbores-1.2.4.tgz above.
