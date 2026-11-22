imagetracerjs, used to trace images into SVG paths (PNG to SVG)
================================================================

Package:  imagetracerjs 1.2.6 by András Jankovics, public domain (The Unlicense)
Source:   https://registry.npmjs.org/imagetracerjs/-/imagetracerjs-1.2.6.tgz
          https://github.com/jankovicsandras/imagetracerjs
License:  The Unlicense, see LICENSE.txt

imagetracer.min.js is imagetracer_v1.2.6.js from that package, unchanged,
minified with terser 5.36.0 (terser -c -m). The package ships no minified
file. It runs in a classic Web Worker started by the PNG to SVG page, where
it sets self.ImageTracer; the page uses its path scanning and curve fitting
(pathscan, internodes, batchtracepaths) on layers it builds itself.
