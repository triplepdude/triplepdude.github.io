zxcvbn-ts, password strength estimation (used by /password-strength-checker/)
============================================================================

The page loads these three files in a Web Worker, only when someone starts
typing a password.

zxcvbn-ts-core.min.js
  Package:  @zxcvbn-ts/core 4.2.0 (MIT), which inlines its one dependency
            fastest-levenshtein 1.0.16 (MIT) in its browser build
  Source:   https://registry.npmjs.org/@zxcvbn-ts/core/-/core-4.2.0.tgz
            https://github.com/zxcvbn-ts/zxcvbn
  File:     dist/zxcvbn-ts.js (the package's browser build), minified with
            esbuild 0.25.10 --minify --target=es2019. Defines the global
            zxcvbnts.core (ZxcvbnFactory, ...).

language-common.min.js
  Package:  @zxcvbn-ts/language-common 4.1.3 (MIT)
  Source:   https://registry.npmjs.org/@zxcvbn-ts/language-common/-/language-common-4.1.3.tgz
  File:     dist/zxcvbn-ts.js (the package's browser build), minified with
            esbuild --minify --target=es2019. It contains the inlined decoder
            from @zxcvbn-ts/dictionary-compression 3.0.1 (MIT). Defines
            zxcvbnts["language-common"]: the common-password and diceware
            dictionaries and the keyboard adjacency graphs.

language-en.min.js
  Package:  @zxcvbn-ts/language-en 4.1.1 (MIT)
  Source:   https://registry.npmjs.org/@zxcvbn-ts/language-en/-/language-en-4.1.1.tgz
  File:     dist/zxcvbn-ts.js, minified the same way. Defines
            zxcvbnts["language-en"]: English words, names and Wikipedia terms,
            and the English feedback messages. Its word-frequency data comes
            from OpenSubtitles 2024 via OPUS under the ODC-BY licence; the
            package's notice is kept in NOTICE-language-en.md.

Licences: LICENSE (zxcvbn-ts, all three packages), LICENSE-fastest-levenshtein.md,
LICENSE-dictionary-compression, NOTICE-language-en.md.
