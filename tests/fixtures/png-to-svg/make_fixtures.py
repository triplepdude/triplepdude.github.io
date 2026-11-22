"""Fixtures for tests/tools/png-to-svg.test.js (run: python3 make_fixtures.py).

logo.png      240 x 160, transparent background, drawn at 4x and reduced (soft
              edges): a navy ring (centre 90,80, radii 60 and 24, the middle
              transparent), a small red accent square (196..204, 16..24, 0.2%
              of the picture), a green block at 78% opacity (150..230, 60..100)
              and a black shadow at 31% opacity (150..230, 120..150), which is
              under the 50% cut and must vanish.
lettering.png 1000 x 600 dark ink on light paper with noise: a ring (an O,
              centre 250,300, radii 150 and 80), a bar (480..560, 150..450), a
              2 x 2 speck at 800,100 and a 6 x 6 dot at 800,200; the noise
              repeats every 16 px so the file stays small.
lettering-mask.png  the ink as Otsu's threshold splits it (255 = ink), with the
              luminance L = (299 R + 587 G + 114 B + 500) // 1000, ink L <= t.
photo.jpg     640 x 480 synthetic photo (sky gradient, hills, sun, noise).
dots.png      400 x 400 white with 6,400 black 3 x 3 squares, 5 px apart.
expected.json the Otsu threshold of lettering.png, its ink pixels at that threshold
              and at 60, and the pixels of logo.png at least half opaque.
"""
import json, os, random
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
out = lambda n: os.path.join(HERE, n)
S = 4

# logo.png
big = Image.new('RGBA', (240 * S, 160 * S), (0, 0, 0, 0))
d = ImageDraw.Draw(big)
d.ellipse([(90 - 60) * S, (80 - 60) * S, (90 + 60) * S, (80 + 60) * S], fill=(20, 40, 110, 255))
d.ellipse([(90 - 24) * S, (80 - 24) * S, (90 + 24) * S, (80 + 24) * S], fill=(0, 0, 0, 0))
d.rectangle([196 * S, 16 * S, 204 * S - 1, 24 * S - 1], fill=(220, 30, 40, 255))
d.rectangle([150 * S, 60 * S, 230 * S - 1, 100 * S - 1], fill=(30, 160, 60, 200))
d.rectangle([150 * S, 120 * S, 230 * S - 1, 150 * S - 1], fill=(0, 0, 0, 80))
logo = big.resize((240, 160), Image.LANCZOS)
logo.save(out('logo.png'))
la = np.asarray(logo)
opaque = int((la[:, :, 3] >= 128).sum())

# lettering.png
rnd = random.Random(7)
ink = Image.new('L', (1000 * S, 600 * S), 0)
d = ImageDraw.Draw(ink)
d.ellipse([(250 - 150) * S, (300 - 150) * S, (250 + 150) * S, (300 + 150) * S], fill=255)
d.ellipse([(250 - 80) * S, (300 - 80) * S, (250 + 80) * S, (300 + 80) * S], fill=0)
d.rectangle([480 * S, 150 * S, 560 * S - 1, 450 * S - 1], fill=255)
d.rectangle([800 * S, 100 * S, 802 * S - 1, 102 * S - 1], fill=255)
d.rectangle([800 * S, 200 * S, 806 * S - 1, 206 * S - 1], fill=255)
cover = np.asarray(ink.resize((1000, 600), Image.BOX), dtype=np.float64) / 255.0
paper, dark = np.array([240, 236, 228.0]), np.array([30, 30, 35.0])
rgb = paper[None, None, :] * (1 - cover[:, :, None]) + dark[None, None, :] * cover[:, :, None]
# Noise from a repeating 16 x 16 tile, so the PNG stays small.
tile = np.array([[rnd.randint(-6, 6) for _ in range(16)] for _ in range(16)], dtype=np.float64)
noise = np.tile(tile, (600 // 16 + 1, 1000 // 16 + 1))[:600, :1000]
rgb = np.clip(np.rint(rgb + noise[:, :, None]), 0, 255).astype(np.uint8)
Image.fromarray(rgb, 'RGB').save(out('lettering.png'))
R, G, B = (rgb[:, :, i].astype(np.int64) for i in range(3))
L = (299 * R + 587 * G + 114 * B + 500) // 1000
hist = np.bincount(L.ravel(), minlength=256).astype(np.float64)

def otsu(h):
    total, best, best_t = h.sum(), -1.0, 127
    levels = np.arange(256, dtype=np.float64)
    for t in range(255):
        w0 = h[:t + 1].sum()
        w1 = total - w0
        if w0 == 0 or w1 == 0:
            continue
        m0 = (levels[:t + 1] * h[:t + 1]).sum() / w0
        m1 = (levels[t + 1:] * h[t + 1:]).sum() / w1
        v = w0 * w1 * (m0 - m1) ** 2
        if v > best:
            best, best_t = v, t
    return best_t

t = otsu(hist)
mask = (L <= t).astype(np.uint8) * 255
Image.fromarray(mask, 'L').save(out('lettering-mask.png'))

# photo.jpg
yy, xx = np.mgrid[0:480, 0:640].astype(np.float64)
sky = np.stack([60 + 120 * yy / 480, 110 + 100 * yy / 480, 200 - 40 * yy / 480], axis=2)
hill = (yy > 300 + 40 * np.sin(xx / 70.0))[:, :, None]
img = np.where(hill, np.stack([50 + 30 * np.sin(xx / 15.0), 120 + 25 * np.cos(yy / 11.0), 60 + 0 * xx], axis=2), sky)
sun = ((xx - 480) ** 2 + (yy - 110) ** 2 < 45 ** 2)[:, :, None]
img = np.where(sun, np.array([250, 220, 120.0])[None, None, :], img)
rnd2 = np.random.default_rng(11)
img = np.clip(img + rnd2.normal(0, 7, img.shape), 0, 255).astype(np.uint8)
Image.fromarray(img, 'RGB').save(out('photo.jpg'), quality=88)

# dots.png
dots = Image.new('RGB', (400, 400), (255, 255, 255))
d = ImageDraw.Draw(dots)
for j in range(80):
    for i in range(80):
        d.rectangle([i * 5 + 1, j * 5 + 1, i * 5 + 3, j * 5 + 3], fill=(0, 0, 0))
dots.save(out('dots.png'))

json.dump({'otsu': int(t), 'logo_opaque': opaque, 'ink_pixels': int((mask > 0).sum()), 'ink_at_60': int((L <= 60).sum())},
          open(out('expected.json'), 'w'), indent=1)
print('otsu', t, 'logo opaque', opaque, 'ink', int((mask > 0).sum()))
