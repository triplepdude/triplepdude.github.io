"""Builds the flip-image fixtures and expected.json, the answers the test checks.

Run from this folder: python3 make_fixtures.py
Expected pixels come from numpy (fliplr, flipud, rot90), expected sizes from the
rotation formulas worked out with Python's math module, and expected JPEG tables
from the IJG quality scaling in libjpeg's jcparam.c, never from the page.
quadrants.heic is a copy of tests/fixtures/resize-image/quadrants.heic: 240 x 160,
quadrants (220,40,40) (40,180,60) / (40,60,200) (240,240,240).
"""
import json
import math

import numpy as np
from PIL import Image

# ---------- grid.png: 7 x 5, every pixel a different colour, one fully transparent ----------
W, H = 7, 5
grid = np.zeros((H, W, 4), np.uint8)
for y in range(H):
    for x in range(W):
        grid[y, x] = (x * 36 + 10, y * 50 + 5, (x * 7 + y * 11) * 3 % 256, 255)
grid[4, 6] = (0, 0, 0, 0)
Image.fromarray(grid, 'RGBA').save('grid.png')


def rot_cw(a):
    return np.rot90(a, k=-1)


# Each sequence of button presses, applied one after the other to what is shown.
OPS = {'h': np.fliplr, 'v': np.flipud, 'r': rot_cw, 'l': lambda a: np.rot90(a, k=1), '180': lambda a: np.rot90(a, k=2)}
SEQS = ['h', 'v', 'hv', 'r', 'l', '180', 'rh', 'hr', 'rv', 'lh', 'rrr', 'hh']
expected = {'grid': {}}
for seq in SEQS:
    a = grid
    for op in (['180'] if seq == '180' else list(seq)):
        a = OPS[op](a)
    expected['grid'][seq] = {'w': int(a.shape[1]), 'h': int(a.shape[0]), 'rgba': a.reshape(-1).tolist()}

# ---------- scene.png: 400 x 300, opaque quadrants with a white centre dot ----------
SW, SH = 400, 300
scene = np.zeros((SH, SW, 3), np.uint8)
scene[:150, :200] = (220, 40, 40)
scene[:150, 200:] = (40, 180, 60)
scene[150:, :200] = (40, 60, 200)
scene[150:, 200:] = (240, 200, 0)
scene[140:160, 190:210] = (255, 255, 255)
Image.fromarray(scene, 'RGB').save('scene.png')


def expand(w, h, deg):
    t = math.radians(deg)
    c, s = abs(math.cos(t)), abs(math.sin(t))
    return round(w * c + h * s), round(w * s + h * c)


def crop(w, h, deg):
    # Quarter turns first, then a fine angle from -45 to 45 with the sign of the whole turn, so a
    # picture turned 45 degrees either way keeps its own shape (and 135 either way the turned shape).
    t = (deg + 180) % 360 - 180 if deg != 180 else 180
    q = int(math.copysign(math.ceil(abs(t) / 90 - 0.5), t))
    fine = t - 90 * q
    bw, bh = (h, w) if q % 2 else (w, h)
    if fine == 0:
        return bw, bh
    t = math.radians(fine)
    c, s = abs(math.cos(t)), abs(math.sin(t))
    # The largest centred rectangle of the same shape that stays 1 px inside the turned image.
    k = min((bw - 2) / (bw * c + bh * s), (bh - 2) / (bw * s + bh * c))
    return max(1, math.floor(k * bw)), max(1, math.floor(k * bh))


expected['sizes'] = {str(d): {'expand': expand(SW, SH, d), 'crop': crop(SW, SH, d)} for d in (10, -2.5, 30, 45, -45, 315, 100, 135, -135)}
# The page's 900 x 600 sample picture turned 12.5 degrees.
expected['sample_12_5'] = expand(900, 600, 12.5)

# ---------- photo.jpg: 64 x 48 at libjpeg quality 75; rot6.jpg with EXIF Orientation 6 ----------
yy, xx = np.mgrid[0:48, 0:64]
photo = np.stack([xx * 4, yy * 5, (xx + yy) * 2], axis=-1).astype(np.uint8)
Image.fromarray(photo, 'RGB').save('photo.jpg', quality=75)

# Stored 300 x 200 with a red 60 x 40 block at the stored top-left; Orientation 6 means
# "turn 90 degrees clockwise to view", so it shows as 200 x 300 with the block at x 160-199, y 0-59.
r6 = np.full((200, 300, 3), (40, 90, 200), np.uint8)
r6[0:40, 0:60] = (255, 0, 0)
ex = Image.Exif()
ex[0x0112] = 6
Image.fromarray(r6, 'RGB').save('rot6.jpg', quality=95, exif=ex.tobytes())

# ---------- anim.gif: 2 frames, red then blue; logo.svg ----------
f1 = Image.new('RGB', (20, 10), (255, 0, 0))
f2 = Image.new('RGB', (20, 10), (0, 0, 255))
f1.save('anim.gif', save_all=True, append_images=[f2], duration=100, loop=0)
with open('logo.svg', 'w') as f:
    f.write('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">'
            '<rect width="60" height="60" fill="#ff0000"/><rect x="60" width="60" height="60" fill="#0000ff"/></svg>')

# ---------- pages.tif: a TIFF with 2 pages, red then blue; only the first is used ----------
Image.new('RGB', (30, 20), (255, 0, 0)).save('pages.tif', save_all=True, append_images=[Image.new('RGB', (30, 20), (0, 0, 255))])

# ---------- IJG quantisation tables (libjpeg jcparam.c), in zigzag order as stored in DQT ----------
STD_LUM = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
           14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
           49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]
ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14,
          21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60,
          61, 54, 47, 55, 62, 63]


def ijg(q):
    scale = 5000 // q if q < 50 else 200 - 2 * q
    nat = [min(255, max(1, (v * scale + 50) // 100)) for v in STD_LUM]
    return [nat[i] for i in ZIGZAG]


expected['ijg'] = {str(q): ijg(q) for q in (50, 75, 92)}
# Pillow reports the tables in natural order; this is what photo.jpg holds.
nat = Image.open('photo.jpg').quantization[0]
expected['photo_dqt'] = [nat[i] for i in ZIGZAG]
assert expected['photo_dqt'] == ijg(75)

with open('expected.json', 'w') as f:
    json.dump(expected, f, separators=(',', ':'))
print('sizes', expected['sizes'])
