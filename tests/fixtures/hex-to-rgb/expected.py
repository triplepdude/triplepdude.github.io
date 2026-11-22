#!/usr/bin/env python3
"""Expected results for tests/tools/hex-to-rgb.test.js, worked out without the
page's code:

- colour parsing and conversion with the Python library coloraide (8.16), which
  implements CSS Color 4, including its gamut mapping for oklch() colours
  outside sRGB ("minde-chroma": binary search with a JND of 0.02);
- WCAG 2.2 contrast written out from the definition of relative luminance
  (0.2126 R + 0.7152 G + 0.0722 B, linearised with the 0.04045 threshold);
- CMYK from the simple formula K = 1 - max(R, G, B), C = (1 - R - K) / (1 - K).

  python3 -m pip install coloraide==8.16
  python3 expected.py > expected.json
"""
import json
from coloraide import Color

def to8(c):
    s = c.convert('srgb')
    if not s.in_gamut():
        s = s.fit(method='minde-chroma')
    r, g, b = (round(min(1, max(0, v)) * 255) for v in s.coords())
    a = round(s.alpha() * 255)
    return [r, g, b], a

def lum(rgb):
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

INPUTS = [
    '#FF5733', '#f53', '#FF573380', 'hsl(10.6, 100%, 60%)', 'hsl(11 100% 60% / 25%)',
    'hwb(200 10% 20%)', 'rgb(50% 25% 75% / 40%)', 'hsl(0.5turn 50% 50%)', 'hsl(200grad 60% 40%)',
    'hsl(3.14159rad 100% 25%)', 'oklch(0.5 0.15 260)', 'oklch(70% 0.1 145)', 'oklch(0.7 0.4 30)',
    'oklch(0.9 0.3 140)', 'oklch(0.4 0.35 300 / 0.5)', 'oklab(0.6 0.1 -0.1)', 'oklab(0.8 -0.3 0.2)',
    'rebeccapurple', 'transparent', '#767676', '#777777', '#000000', '#FFFFFF',
]
out = {}
for text in INPUTS:
    c = Color(text)
    rgb, a = to8(c)
    srgb = Color('srgb', [v / 255 for v in rgb])
    L = lum(rgb)
    k = 1 - max(rgb) / 255
    cmyk = [0, 0, 0, 100] if k >= 1 else [round((1 - v / 255 - k) / (1 - k) * 100, 6) for v in rgb] + [round(k * 100, 6)]
    hsl = srgb.convert('hsl').coords(nans=False)
    oklch = srgb.convert('oklch').coords(nans=False)
    out[text] = {
        'hex8': '#' + ''.join(f'{v:02X}' for v in rgb + [a]),
        'white': (1.05) / (L + 0.05),
        'black': (L + 0.05) / 0.05,
        'cmyk': cmyk,
        'hsl': [hsl[0], hsl[1] * 100, hsl[2] * 100],
        'oklch': oklch,
        'coloraide_wcag21_white': Color('white').contrast(srgb, method='wcag21'),
    }
print(json.dumps(out, indent=1))
