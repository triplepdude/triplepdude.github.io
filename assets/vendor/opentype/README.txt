opentype.js 1.3.4 (browser build dist/opentype.min.js, unmodified)
Package: https://www.npmjs.com/package/opentype.js/v/1.3.4
Source:  https://github.com/opentypejs/opentype.js/tree/1.3.4
License: MIT (see LICENSE.txt). The build includes tiny-inflate (MIT, Devon Govett),
         used to read WOFF files.

Used by the Signature Generator (_tools/signature-generator.html) to turn a typed
name into vector outlines for the PNG and SVG downloads. Loaded only when the
"Type" tab is opened.

Also used by the Favicon Generator (_tools/favicon-generator.html) for letter
outlines. Version 1.3.4 does not read GPOS Extension lookups (type 9), where
Inter and Montserrat keep their kerning, so that page reads pair kerning from
the font's GPOS table itself.
