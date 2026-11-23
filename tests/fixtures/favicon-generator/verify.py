"""Reads a file the Favicon Generator saved with Pillow, for tests/tools/favicon-generator.test.js.

python3 verify.py <file>  prints JSON: for an ICO, its sizes and the pixel at 17, 24 of
its 48 px picture; for a PNG, its size, mode, lowest alpha and number of colours.
"""
import json, sys
from PIL import Image

im = Image.open(sys.argv[1])
out = {'format': im.format}
if im.format == 'ICO':
    out['sizes'] = [list(s) for s in sorted(im.info['sizes'])]
    im.size = (48, 48)
    out['pixel'] = list(im.convert('RGBA').getpixel((17, 24)))
else:
    rgba = im.convert('RGBA')
    out['size'] = list(im.size)
    out['mode'] = im.mode
    out['alpha_min'] = rgba.getextrema()[3][0]
    out['colours'] = len(rgba.getcolors(1 << 20) or [])
print(json.dumps(out))
