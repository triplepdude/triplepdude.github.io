Tesseract.js, OCR in the browser (used by the Image to Text tool)
=================================================================

The Image to Text page loads these files only when a visitor starts reading a
picture. Every path is set on the page (workerPath, corePath, langPath), so
nothing is fetched from a CDN, and cacheMethod is 'none', so the language data
is never stored in IndexedDB. All files are byte-for-byte the published ones.

tesseract.min.js, worker.min.js (and their .LICENSE.txt notices)
  Package:  tesseract.js 7.0.0 (dist/), Apache License 2.0 (LICENSE.txt)
  Source:   https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz
            sha256 9a93bf51c3387f945d10a24bf8b3a4bf2e45c7c7161b8242aafbaf9d3c4b606a

core/tesseract-core-lstm.wasm.js
core/tesseract-core-simd-lstm.wasm.js
core/tesseract-core-relaxedsimd-lstm.wasm.js
  Package:  tesseract.js-core 7.0.0, Apache License 2.0 (core/LICENSE.txt).
            The Tesseract OCR engine and Leptonica compiled to WebAssembly,
            built for the LSTM engine only; the worker picks one of the three
            by the browser's WebAssembly SIMD support. The builds with the
            legacy engine are not included (the page never uses it).
  Source:   https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz
            sha256 ba584355515eaff877552022853c0e71f2cb70466e759d1d6940484929718ee0

lang/<code>.traineddata.gz
  Package:  @tesseract.js-data/<code> 1.0.0, the 4.0.0_best_int folder: the
            tessdata_best models of the Tesseract project converted to integer
            (LSTM only). The data is under the Apache License 2.0
            (lang/LICENSE.txt, from https://github.com/tesseract-ocr/tessdata_best).
  Source:   https://registry.npmjs.org/@tesseract.js-data/<code>/-/<code>-1.0.0.tgz
            for example eng-1.0.0.tgz
            sha256 c9bddf2e2f0a214ac7918f3f4a3caf45e09ce8674fe26662ae7787ac8927f7bb
  Codes:    ara chi_sim chi_tra deu eng fra hin ind ita jpn kor nld pol por
            rus spa tur ukr vie
