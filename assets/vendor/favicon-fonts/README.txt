Bold fonts for the Favicon Generator (_tools/favicon-generator.html).

Each font is the Latin subset, weight 700, as published by Fontsource in the
npm package @fontsource/<name> 5.3.0 (published 19 July 2026). The .woff files
are copied from the package's files/ folder unchanged. WOFF (not WOFF2) is used
because opentype.js 1.3.4 reads WOFF but not WOFF2.

All five are licensed under the SIL Open Font License 1.1. Each font's licence,
copied from the package's LICENSE file with its copyright line, is in
<name>-OFL.txt. None of the five declares a Reserved Font Name.

  inter-latin-700-normal.woff            Inter
    @fontsource/inter@5.3.0           tarball sha1 866278dc2357659f8be1755c8b67f29d3697b440
    sha256 7c5ed5655730de337704d3fc94628515cd7e3d8d32368871709bf56ac0397e7a
  montserrat-latin-700-normal.woff       Montserrat
    @fontsource/montserrat@5.3.0      tarball sha1 218a998a485d41f358d6bacf9edb70e282fadf7a
    sha256 ff51c769e51acaa5ffbb8091441ff4e365e41ff21f7e4c05d1cd5650514d6fd3
  nunito-latin-700-normal.woff           Nunito
    @fontsource/nunito@5.3.0          tarball sha1 6369caf65492f89cf1c937fc5c153b44128fa527
    sha256 ce9107dc33f5d3bb8237776799400f28b96aed4b114773d4fd7fbacb3b218509
  fraunces-latin-700-normal.woff         Fraunces
    @fontsource/fraunces@5.3.0        tarball sha1 8ef93c70ddbf0fed0e801d7927d324229c646e80
    sha256 1f9b0930f7a5e2b6aaba0df15f21bcdebebfcaff4b704daf3619589da69fd2a4
  jetbrains-mono-latin-700-normal.woff   JetBrains Mono
    @fontsource/jetbrains-mono@5.3.0  tarball sha1 87bfd849f24b536ed72e89b56ae0d42223697f74
    sha256 5e7319f25a5ef89d2c01c323029ef0bedefad204108e601455ff6f8ae12ca3ff

The Latin subset covers U+0000-00FF and a few more characters (curly quotes,
the euro sign, trade mark). The page turns letters into outlines with
opentype.js (assets/vendor/opentype/), so the icons it saves need no font.
Letters the subset lacks are drawn with the visitor's own font instead.

A font file is loaded only when it is picked in the Font menu (Inter, the
first choice, when the page opens on the Text source).
