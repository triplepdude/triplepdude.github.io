"""Builds the image-color-picker fixtures and expected.json, the answers the test checks.

Run from this folder: python3 make_fixtures.py
Colour values are worked out with exact fractions and rounded half up; the converted
values of the Display P3 test image come from littleCMS (Pillow's ImageCms), a
different colour engine from the browser's. p3.icc is a copy of
tests/fixtures/image-to-pdf/p3.icc ("Display P3 (test)").
"""
import io
import json
from fractions import Fraction as F
from math import floor

import numpy as np
from PIL import Image, ImageCms


def half_up(x):
    return floor(x + F(1, 2))


def values(r, g, b, a=255):
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d == 0:
        h = 0
    elif mx == r:
        h = F(60 * (g - b), d) % 360
    elif mx == g:
        h = F(60 * (b - r), d) + 120
    else:
        h = F(60 * (r - g), d) + 240
    h = half_up(h) % 360
    l = half_up(F(100 * (mx + mn), 510))
    s_l = 0 if d == 0 else half_up(F(100 * d, 255 - abs(mx + mn - 255)))
    v = half_up(F(100 * mx, 255))
    s_v = 0 if mx == 0 else half_up(F(100 * d, mx))
    if mx == 0:
        cmyk = (0, 0, 0, 100)
    else:
        cmyk = (half_up(F(100 * (mx - r), mx)), half_up(F(100 * (mx - g), mx)), half_up(F(100 * (mx - b), mx)), half_up(F(100 * (255 - mx), 255)))
    hx = '#%02X%02X%02X' % (r, g, b)
    out = {'rgb': [r, g, b, a], 'hex': hx, 'rgbText': 'rgb(%d, %d, %d)' % (r, g, b),
           'hsl': 'hsl(%d, %d%%, %d%%)' % (h, s_l, l), 'hsb': '%d°, %d%%, %d%%' % (h, s_v, v),
           'cmyk': 'cmyk(%d%%, %d%%, %d%%, %d%%)' % cmyk}
    if a < 255:
        al = F(half_up(F(100 * a, 255)), 100)
        at = ('%g' % float(al))
        out['hex'] = hx + '%02X' % a
        out['rgbText'] = 'rgba(%d, %d, %d, %s)' % (r, g, b, at)
        out['hsl'] = 'hsla(%d, %d%%, %d%%, %s)' % (h, s_l, l, at)
    return out


expected = {}

# ---------- swatches.png: 12 blocks of 10 x 10 in a row ----------
SW = [(0, 0, 0), (255, 255, 255), (255, 0, 0), (127, 127, 127), (31, 111, 74), (1, 2, 3), (254, 253, 252),
      (128, 0, 255), (0, 128, 128), (200, 100, 50), (51, 102, 153), (255, 0, 1)]
img = np.zeros((10, 10 * len(SW), 3), np.uint8)
for i, c in enumerate(SW):
    img[:, i * 10:(i + 1) * 10] = c
Image.fromarray(img, 'RGB').save('swatches.png')
expected['swatches'] = [values(*c) for c in SW]

# ---------- checker.png: 20 x 20, black where x + y is even, white elsewhere ----------
yy, xx = np.mgrid[0:20, 0:20]
chk = np.where(((xx + yy) % 2 == 0)[..., None], 0, 255).astype(np.uint8).repeat(3, axis=2)
Image.fromarray(chk, 'RGB').save('checker.png')


def average(x, y, n):
    r = n // 2
    cells = [chk[j, i, 0] for j in range(y - r, y + r + 1) for i in range(x - r, x + r + 1) if 0 <= i < 20 and 0 <= j < 20]
    m = half_up(F(int(sum(int(c) for c in cells)), len(cells)))
    return values(m, m, m)


expected['checker'] = {'%d,%d,%d' % (x, y, n): average(x, y, n) for (x, y) in [(5, 5), (6, 5), (0, 0), (19, 10)] for n in (1, 3, 5)}

# ---------- blocks.png: 200 x 100, four flat colours over 40, 30, 20 and 10% of the width ----------
blocks = np.zeros((100, 200, 3), np.uint8)
blocks[:, 0:80] = (31, 111, 74)
blocks[:, 80:140] = (240, 200, 0)
blocks[:, 140:180] = (220, 40, 40)
blocks[:, 180:200] = (40, 60, 200)
Image.fromarray(blocks, 'RGB').save('blocks.png')
expected['blocks'] = [['#1F6F4A', '40%'], ['#F0C800', '30%'], ['#DC2828', '20%'], ['#283CC8', '10%']]

# ---------- merge.png: 50 x 20, four groups, two of them made of two close shades ----------
# Runs of pixels in reading order: 400 reds, 200 blues, 200 greens, 100 blacks and 100 whites,
# 7 distinct colours. The expected palette of 5 is each group's mean, worked out here rather
# than by clustering.
groups = [((250, 0, 0), 300), ((255, 0, 0), 100), ((0, 0, 255), 200), ((0, 200, 0), 150), ((0, 205, 0), 50),
          ((0, 0, 0), 100), ((255, 255, 255), 100)]
flat = []
for c, n in groups:
    flat += [c] * n
merge = np.array(flat, np.uint8).reshape(20, 50, 3)
Image.fromarray(merge, 'RGB').save('merge.png')


def mean(parts):
    tot = sum(n for _, n in parts)
    return tuple(half_up(F(sum(c[k] * n for c, n in parts), tot)) for k in range(3)), tot


pal = [mean(groups[0:2]), mean(groups[2:3]), mean(groups[3:5]), mean(groups[5:6]), mean(groups[6:7])]
pal = sorted(pal, key=lambda p: (-p[1], '#%02X%02X%02X' % p[0]))
expected['merge'] = [['#%02X%02X%02X' % c, '%d%%' % half_up(F(100 * n, 1000))] for c, n in pal]

# ---------- alpha.png: half red at alpha 128, half fully transparent; clear.png: all transparent ----------
al = np.zeros((10, 20, 4), np.uint8)
al[:, :10] = (255, 0, 0, 128)
Image.fromarray(al, 'RGBA').save('alpha.png')
expected['alpha'] = values(255, 0, 0, 128)


def alpha_average(x, y, n):
    # Colours weighted by opacity; the opacity itself is the plain mean.
    r = n // 2
    cells = [al[j, i] for j in range(y - r, y + r + 1) for i in range(x - r, x + r + 1) if 0 <= i < 20 and 0 <= j < 10]
    sa = sum(int(c[3]) for c in cells)
    if sa == 0:
        return values(0, 0, 0, 0)
    ch = [half_up(F(sum(int(c[k]) * int(c[3]) for c in cells), sa)) for k in range(3)]
    return values(*ch, half_up(F(sa, len(cells))))


expected['alpha_avg'] = {'10,5,3': alpha_average(10, 5, 3), '9,5,5': alpha_average(9, 5, 5)}
expected['transparent'] = values(0, 0, 0, 0)
Image.fromarray(np.zeros((10, 10, 4), np.uint8), 'RGBA').save('clear.png')

# ---------- p3.png: three blocks stored in Display P3 ----------
icc = open('p3.icc', 'rb').read()
P3 = [(200, 100, 50), (40, 160, 220), (128, 128, 128)]
p3 = np.zeros((20, 30, 3), np.uint8)
for i, c in enumerate(P3):
    p3[:, i * 10:(i + 1) * 10] = c
im = Image.fromarray(p3, 'RGB')
im.save('p3.png', icc_profile=icc)
conv = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile('sRGB'),
                                 renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
expected['p3'] = {'stored': [values(*c) for c in P3], 'converted': [list(map(int, conv.getpixel((i * 10 + 5, 5)))) for i in range(3)]}

with open('expected.json', 'w') as f:
    json.dump(expected, f, ensure_ascii=False, indent=1)
print(expected['merge'], expected['p3']['converted'], expected['swatches'][4])
