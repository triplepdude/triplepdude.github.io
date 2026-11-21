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
        # The opacity with 2 decimals when that gives back the same 8-bit value, else with 3
        # (CSS Color 4 serialises alpha the same way): 128 is 0.5, but 1 is 0.004 and 254 is 0.996.
        al = F(half_up(F(100 * a, 255)), 100)
        if half_up(al * 255) != a:
            al = F(half_up(F(1000 * a, 255)), 1000)
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

# ---------- edges.png: opacity 1, 254 and 127 (no colour channel loses precision when premultiplied) ----------
ed = np.zeros((10, 30, 4), np.uint8)
ed[:, 0:10] = (255, 0, 0, 1)
ed[:, 10:20] = (0, 0, 255, 254)
ed[:, 20:30] = (0, 255, 0, 127)
Image.fromarray(ed, 'RGBA').save('edges.png')
expected['edges'] = [values(255, 0, 0, 1), values(0, 0, 255, 254), values(0, 255, 0, 127)]
# Only the 254 block is at least half opaque, so it is the whole palette.
expected['edges_palette'] = [['#0000FF', '100%']]

# ---------- thirds.png: 2 red pixels and 1 blue: shares 66.7% and 33.3%, rounded half up ----------
Image.fromarray(np.array([[(255, 0, 0), (255, 0, 0), (0, 0, 255)]], np.uint8), 'RGB').save('thirds.png')
expected['thirds'] = [['#FF0000', '67%'], ['#0000FF', '33%']]


# ---------- kmeans.png: 45 pixels in 14 colours where k-means moves colours between the cut's groups ----------
# The palette is worked out by a separate implementation of the method the page describes:
# OKLab (Ottosson 2020), the variance-based split of the group with the largest squared error,
# then k-means from the groups' means. Without the k-means step it would be different.
def lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def oklab(r, g, b):
    lr, lg, lb = lin(r), lin(g), lin(b)
    l = (0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb) ** (1 / 3)
    m = (0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb) ** (1 / 3)
    s = (0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def ref_palette(counts, n, kmeans=True):
    cols = sorted(counts, key=lambda c: (c[0] << 16) | (c[1] << 8) | c[2])
    key = {c: (c[0] << 16) | (c[1] << 8) | c[2] for c in cols}
    lab = {c: oklab(*c) for c in cols}
    wt = counts

    def sse(box):
        tot = sum(wt[c] for c in box)
        mean = [sum(wt[c] * lab[c][a] for c in box) / tot for a in range(3)]
        return sum(wt[c] * (lab[c][a] - mean[a]) ** 2 for c in box for a in range(3))

    boxes = [[cols, sse(cols)]]
    while len(boxes) < n:
        cand = [i for i, b in enumerate(boxes) if b[1] > 1e-12]
        if not cand:
            break
        bi = max(cand, key=lambda i: (boxes[i][1], -i))
        best = None
        for a in range(3):
            idx = sorted(boxes[bi][0], key=lambda c: (lab[c][a], key[c]))
            wt_all = sum(wt[c] for c in idx)
            s_all = sum(wt[c] * lab[c][a] for c in idx)
            w1 = s1 = 0
            for j in range(len(idx) - 1):
                w1 += wt[idx[j]]
                s1 += wt[idx[j]] * lab[idx[j]][a]
                if lab[idx[j]][a] == lab[idx[j + 1]][a]:
                    continue
                w2 = wt_all - w1
                gain = w1 * w2 / wt_all * (s1 / w1 - (s_all - s1) / w2) ** 2
                if best is None or gain > best[0]:
                    best = (gain, idx[:j + 1], idx[j + 1:])
        if best is None:
            boxes[bi][1] = 0
            continue
        boxes[bi:bi + 1] = [[best[1], sse(best[1])], [best[2], sse(best[2])]]
    assign = {c: b for b, (box, _) in enumerate(boxes) for c in box}
    kk = len(boxes)
    for _ in range(12 if kmeans else 0):
        sw = [0.0] * kk
        sm = [[0.0] * 3 for _ in range(kk)]
        for c in cols:
            sw[assign[c]] += wt[c]
            for a in range(3):
                sm[assign[c]][a] += wt[c] * lab[c][a]
        cen = [[sm[b][a] / sw[b] if sw[b] else 1e9 for a in range(3)] for b in range(kk)]
        moved = False
        for c in cols:
            d = [sum((lab[c][a] - cen[b][a]) ** 2 for a in range(3)) for b in range(kk)]
            nb = min(range(kk), key=lambda b: (d[b], b))
            if nb != assign[c]:
                assign[c] = nb
                moved = True
        if not moved:
            break
    groups = {}
    for c in cols:
        groups.setdefault(assign[c], []).append((c, wt[c]))
    pal = [mean(g) for g in groups.values()]
    tot = sum(counts.values())
    pal = sorted(pal, key=lambda p: (-p[1], '#%02X%02X%02X' % p[0]))
    return [['#%02X%02X%02X' % c, '%d%%' % half_up(F(100 * n, tot))] for c, n in pal]


KM = {(46, 255, 60): 3, (0, 202, 53): 1, (143, 136, 246): 4, (167, 76, 255): 5, (246, 128, 201): 1, (216, 198, 211): 7,
      (237, 141, 186): 5, (119, 247, 25): 3, (103, 255, 32): 7, (178, 207, 61): 2, (49, 241, 74): 3, (85, 220, 90): 2,
      (184, 203, 138): 1, (174, 235, 130): 1}
kpix = [c for c, n in sorted(KM.items()) for _ in range(n)]
Image.fromarray(np.array(kpix, np.uint8).reshape(5, 9, 3), 'RGB').save('kmeans.png')
expected['kmeans'] = ref_palette(KM, 5)
assert expected['kmeans'] != ref_palette(KM, 5, kmeans=False)
# The same method gives the hand-worked answers above.
assert ref_palette({c: n for c, n in groups}, 5) == expected['merge']

# ---------- Colour profiles in other containers ----------
# srgb-v4.png carries littleCMS's own sRGB profile, an ICC v4 profile whose name is stored as
# UTF-16 text ('mluc'); p3-o6.jpg and p3-o3.jpg hold a 40 x 20 Display P3 picture stored turned,
# with EXIF Orientation 6 and 3; p3.webp holds it in a lossless WebP. Upright, the left half is
# (200, 100, 50), the right half (40, 160, 220) and the top-left 4 x 4 corner (128, 128, 128).
up = np.zeros((20, 40, 3), np.uint8)
up[:, :20] = (200, 100, 50)
up[:, 20:] = (40, 160, 220)
up[:4, :4] = (128, 128, 128)
upright = Image.fromarray(up, 'RGB')
upright.save('srgb-v4.png', icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
for o, stored in ((6, upright.transpose(Image.Transpose.ROTATE_90)), (3, upright.transpose(Image.Transpose.ROTATE_180))):
    ex = Image.Exif()
    ex[0x0112] = o
    stored.save('p3-o%d.jpg' % o, quality=100, subsampling=0, icc_profile=icc, exif=ex.tobytes())
upright.save('p3.webp', lossless=True, icc_profile=icc)
expected['upright'] = {'stored': [values(200, 100, 50), values(40, 160, 220), values(128, 128, 128)]}

with open('expected.json', 'w') as f:
    json.dump(expected, f, ensure_ascii=False, indent=1)
print(expected['merge'], expected['p3']['converted'], expected['swatches'][4])
