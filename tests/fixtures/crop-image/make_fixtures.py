"""Fixtures for tests/tools/crop-image.test.js (run: python3 make_fixtures.py).

grid.png    300 x 200: every pixel its own colour, R = x % 256, G = y,
            B = 60 + 100 * (x // 256), so any crop, turn or mirror can be
            checked pixel by pixel. The 20 x 20 corner at 0,0 is transparent.
small.png   150 x 100, the same pattern, for the batch (a second size).
photo.jpg   stored 120 x 80 at JPEG quality 77 with EXIF Orientation 6 (shown
            turned 90 degrees clockwise, 80 x 120), camera details and a GPS
            block. Stored quadrants: red, green / blue, yellow.
anim.gif    two frames, 40 x 30: red, then blue.
logo.svg    200 x 100 px, viewBox 0 0 100 50: red left half, blue right half,
            a green disc of radius 10 at (25, 25).
expected.json  the luminance quantisation table libjpeg writes at quality 77
            (in DQT order), and the upright quadrant colours of photo.jpg as
            Pillow's exif_transpose turns it.
"""
import json, os
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
out = lambda n: os.path.join(HERE, n)


def grid(w, h):
    im = Image.new('RGBA', (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x % 256, y % 256, 60 + 100 * (x // 256), 255)
    return im


g = grid(300, 200)
for y in range(20):
    for x in range(20):
        g.putpixel((x, y), (0, 0, 0, 0))
g.save(out('grid.png'))
grid(150, 100).save(out('small.png'))

# photo.jpg
ph = Image.new('RGB', (120, 80))
cols = {(0, 0): (230, 30, 30), (1, 0): (30, 200, 40), (0, 1): (30, 60, 220), (1, 1): (240, 220, 20)}
for (qx, qy), c in cols.items():
    ph.paste(c, (qx * 60, qy * 40, qx * 60 + 60, qy * 40 + 40))
exif = Image.Exif()
exif[0x0112] = 6            # Orientation: turn 90 degrees clockwise to show
exif[0x010F] = 'TestCam'    # Make
exif[0x0110] = 'Model 1'    # Model
exif[0x0132] = '2026:11:01 10:20:30'
gps = {1: 'N', 2: (51.0, 30.0, 0.0), 3: 'W', 4: (0.0, 7.0, 0.0)}
exif[0x8825] = gps
ph.save(out('photo.jpg'), quality=77, exif=exif.tobytes())

# The table libjpeg wrote, straight from the DQT segment.
b = open(out('photo.jpg'), 'rb').read()
i, luma = 2, None
while i < len(b) and luma is None:
    m, ln = b[i + 1], int.from_bytes(b[i + 2:i + 4], 'big')
    if m == 0xDB:
        p = i + 4
        while p < i + 2 + ln:
            pq, tq = b[p] >> 4, b[p] & 15
            size = 128 if pq else 64
            if tq == 0:
                luma = list(b[p + 1:p + 1 + size])
                break
            p += 1 + size
    i += 2 + ln

up = ImageOps.exif_transpose(Image.open(out('photo.jpg'))).convert('RGB')
quads = {
    'size': list(up.size),
    'top_left': list(up.getpixel((20, 30))), 'top_right': list(up.getpixel((60, 30))),
    'bottom_left': list(up.getpixel((20, 90))), 'bottom_right': list(up.getpixel((60, 90))),
}

f1, f2 = Image.new('RGB', (40, 30), (255, 0, 0)), Image.new('RGB', (40, 30), (0, 0, 255))
f1.save(out('anim.gif'), save_all=True, append_images=[f2], duration=200, loop=0)

open(out('logo.svg'), 'w').write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50">'
    '<rect width="50" height="50" fill="#ff0000"/><rect x="50" width="50" height="50" fill="#0000ff"/>'
    '<circle cx="25" cy="25" r="10" fill="#00ff00"/></svg>\n')

json.dump({'q77_luma_dqt': luma, 'photo_upright': quads}, open(out('expected.json'), 'w'), indent=1)
print('luma', luma[:8], 'upright', quads)
