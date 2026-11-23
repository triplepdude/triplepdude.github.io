# Fixtures for tests/tools/png-to-webp.test.js. Run from this folder:
#   python3 make_fixtures.py
# Needs Pillow, numpy and scikit-image (for its public-domain sample photo).
#   logo.png        120 x 80 RGBA: a red disc with smooth edges on transparency,
#                   a band through every alpha value from 0 to 255 under a
#                   colour ramp, and thin coloured strokes (Pillow's PNG)
#   screenshot.png  480 x 300 RGB: dark text in DejaVu Sans on flat panels, as
#                   a screenshot of a page
#   photo.png       scikit-image's "astronaut" (NASA, public domain), 512 x 512
#   flat.png        64 x 64 palette PNG of two flat colours, 1 bit a pixel
#   interlaced.png  37 x 29 RGBA, Adam7 interlaced
#   grey2.png       33 x 7 greyscale, 2 bits a pixel, level 1 transparent (tRNS)
#   pal4.png        21 x 9 palette, 4 bits a pixel, three entries partly transparent
#   rgb16.png       40 x 6 RGB, 16 bits a sample, low bytes that rounding would
#                   change (Chrome and Pillow keep the high byte)
#   ga16.png        24 x 5 grey and alpha, 16 bits a sample
#   rgbkey.png      16 x 8 RGB with a tRNS colour key: (0, 255, 0) is transparent
#   p3.png          32 x 16 RGB with the Display P3 test profile (p3.icc) in iCCP
#   gamma1.png      32 x 16 RGB with gAMA 1.0, which browsers apply: these files
#                   go through the canvas, so the WebP holds what the browser shows
#   anim.png        24 x 16 animated PNG, two frames: red, then blue
#   cut.png         screenshot.png cut off at 60%
#   empty.png       0 bytes;  notes.png  a text file named .png
#   photo-as.png    a JPEG named .png;  dot.png  1 x 1, one opaque teal pixel
import io, os, struct, zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage import data

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

def png_raw(w, h, depth, ctype, rows, extra=b'', interlace=0, after=b''):
    ihdr = struct.pack('>IIBBBBB', w, h, depth, ctype, 0, 0, interlace)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + extra +
            chunk(b'IDAT', zlib.compress(rows, 9)) + after + chunk(b'IEND', b''))

def rows_of(arr, filters=(0, 1, 2, 3, 4)):
    # Raw scanlines with every filter type in turn, so a reader must undo all five.
    h = arr.shape[0]
    flat = arr.reshape(h, -1).astype(np.int32)
    bpp = arr.shape[2] * arr.itemsize if arr.ndim == 3 else arr.itemsize
    out = b''
    raw = arr.astype('>u2').reshape(h, -1).view(np.uint8) if arr.dtype == np.uint16 else flat.astype(np.uint8)
    raw = raw.astype(np.int32)
    for y in range(h):
        f = filters[y % len(filters)]
        line = raw[y]
        prev = raw[y - 1] if y else np.zeros_like(line)
        left = np.concatenate([np.zeros(bpp, np.int32), line[:-bpp]])
        upleft = np.concatenate([np.zeros(bpp, np.int32), prev[:-bpp]])
        if f == 0: enc = line
        elif f == 1: enc = line - left
        elif f == 2: enc = line - prev
        elif f == 3: enc = line - (left + prev) // 2
        else:
            p = left + prev - upleft
            pa, pb, pc = np.abs(p - left), np.abs(p - prev), np.abs(p - upleft)
            pred = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, prev, upleft))
            enc = line - pred
        out += bytes([f]) + (enc & 255).astype(np.uint8).tobytes()
    return out

def save(name, b):
    open(name, 'wb').write(b)

# ---------- logo.png ----------
w, h = 120, 80
im = Image.new('RGBA', (w * 4, h * 4), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.ellipse((16, 16, 176, 176), fill=(214, 40, 57, 255))
d.line((200, 30, 460, 150), fill=(20, 110, 200, 255), width=6)
d.line((200, 150, 460, 30), fill=(250, 190, 20, 200), width=4)
im = im.resize((w, h), Image.LANCZOS)          # smooth, semi-transparent edges
a = np.array(im)
for x in range(w):                             # rows 60 to 75: every alpha value
    for y in range(60, 76):
        a[y, x] = [(x * 2) % 256, (255 - x * 2) % 256, (y * 9) % 256, min(255, ((y - 60) * w + x) * 255 // (16 * w - 1))]
Image.fromarray(a, 'RGBA').save('logo.png', optimize=True)

# ---------- screenshot.png ----------
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
bold = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
im = Image.new('RGB', (480, 300), (246, 247, 249))
d = ImageDraw.Draw(im)
d.rectangle((0, 0, 480, 44), fill=(32, 46, 70))
d.text((16, 11), 'Settings  ·  Account  ·  Billing', font=bold, fill=(255, 255, 255))
d.rectangle((16, 60, 464, 284), fill=(255, 255, 255), outline=(214, 218, 224))
lines = ['Your plan renews on 3 December 2026.', 'Storage used: 41.2 GB of 100 GB',
         'Two-step sign-in is turned on for this account.', 'Invoices are sent to the billing address',
         'listed below. Change it at any time.', 'Questions? Write to the help desk.']
for i, t in enumerate(lines):
    d.text((32, 76 + 30 * i), t, font=font, fill=(30, 34, 40))
d.rounded_rectangle((32, 248, 168, 274), 6, fill=(37, 99, 235))
d.text((52, 252), 'Save changes', font=font, fill=(255, 255, 255))
im.save('screenshot.png', optimize=True)

# ---------- photo.png, flat.png ----------
Image.fromarray(data.astronaut()).save('photo.png', optimize=True)
flat = Image.new('P', (64, 64), 0)
flat.putpalette([255, 255, 255, 20, 60, 160] + [0, 0, 0] * 254)
ImageDraw.Draw(flat).rectangle((16, 16, 47, 47), fill=1)
flat.save('flat.png', optimize=True, bits=1)

# ---------- interlaced.png (Adam7) ----------
w, h = 37, 29
a = np.zeros((h, w, 4), np.uint8)
for y in range(h):
    for x in range(w):
        a[y, x] = [(x * 7) % 256, (y * 9) % 256, (x * y) % 256, (x * 13 + y * 3) % 256]
passes = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
raw = b''
for x0, y0, dx, dy in passes:
    sub = a[y0::dy, x0::dx]
    if sub.size: raw += rows_of(sub)
ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 1)
save('interlaced.png', b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

# ---------- grey2.png: 2-bit grey, level 1 transparent ----------
w, h = 33, 7
lv = np.array([[(x + y) % 4 for x in range(w)] for y in range(h)], np.uint8)
packed = b''
for y in range(h):
    bits = ''.join(format(v, '02b') for v in lv[y])
    bits += '0' * (-len(bits) % 8)
    packed += b'\0' + bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
save('grey2.png', b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 2, 0, 0, 0, 0)) +
     chunk(b'tRNS', struct.pack('>H', 1)) + chunk(b'IDAT', zlib.compress(packed, 9)) + chunk(b'IEND', b''))

# ---------- pal4.png: 4-bit palette, three partly transparent entries ----------
w, h = 21, 9
idx = np.array([[(x * 3 + y) % 11 for x in range(w)] for y in range(h)], np.uint8)
pal = [(i * 23 % 256, i * 57 % 256, 255 - i * 21) for i in range(11)]
packed = b''
for y in range(h):
    bits = ''.join(format(v, '04b') for v in idx[y]) + '0' * ((-w * 4) % 8)
    packed += b'\0' + bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
save('pal4.png', b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 4, 3, 0, 0, 0)) +
     chunk(b'PLTE', bytes(c for p in pal for c in p)) + chunk(b'tRNS', bytes([0, 128, 7])) +
     chunk(b'IDAT', zlib.compress(packed, 9)) + chunk(b'IEND', b''))

# ---------- rgb16.png, ga16.png ----------
w, h = 40, 6
v = np.zeros((h, w, 3), np.uint16)
for y in range(h):
    for x in range(w):
        v[y, x] = [x * 6 * 256 + (127 + y * 20) % 256, (255 - x * 6) * 256 + 255 - y, (y * 40) * 256 + 129]
save('rgb16.png', png_raw(w, h, 16, 2, rows_of(v)))
w, h = 24, 5
v = np.zeros((h, w, 2), np.uint16)
for y in range(h):
    for x in range(w):
        v[y, x] = [x * 10 * 256 + 200, (y * 50 + x) * 256 + 77]
save('ga16.png', png_raw(w, h, 16, 4, rows_of(v)))

# ---------- rgbkey.png: an RGB colour key ----------
w, h = 16, 8
a = np.zeros((h, w, 3), np.uint8)
for y in range(h):
    for x in range(w):
        a[y, x] = (0, 255, 0) if (x + y) % 3 == 0 else (x * 15, y * 30, 90)
save('rgbkey.png', png_raw(w, h, 8, 2, rows_of(a), chunk(b'tRNS', struct.pack('>HHH', 0, 255, 0))))

# ---------- p3.png, gamma1.png ----------
icc = open('p3.icc', 'rb').read()
w, h = 32, 16
a = np.zeros((h, w, 3), np.uint8)
for y in range(h):
    for x in range(w):
        a[y, x] = (250, 30, 40) if x < 16 else (20, 240, 60)
        if y >= 8: a[y, x] = (x * 8, 255 - x * 8, 128)
save('p3.png', png_raw(w, h, 8, 2, rows_of(a), chunk(b'iCCP', b'Display P3 (test)\0\0' + zlib.compress(icc, 9))))
save('gamma1.png', png_raw(w, h, 8, 2, rows_of(a), chunk(b'gAMA', struct.pack('>I', 100000))))

# ---------- anim.png: APNG, the default image is frame 1 ----------
w, h = 24, 16
red = np.full((h, w, 4), (220, 30, 30, 255), np.uint8)
blue = np.full((h, w, 4), (30, 60, 220, 255), np.uint8)
actl = chunk(b'acTL', struct.pack('>II', 2, 0))
fctl0 = chunk(b'fcTL', struct.pack('>IIIIIHHBB', 0, w, h, 0, 0, 1, 2, 0, 0))
fctl1 = chunk(b'fcTL', struct.pack('>IIIIIHHBB', 1, w, h, 0, 0, 1, 2, 0, 0))
fdat = struct.pack('>I', 2) + zlib.compress(rows_of(blue), 9)
save('anim.png', png_raw(w, h, 8, 6, rows_of(red), actl + fctl0, after=fctl1 + chunk(b'fdAT', fdat)))

# ---------- broken and odd files ----------
b = open('screenshot.png', 'rb').read()
save('cut.png', b[:int(len(b) * 0.6)])
save('empty.png', b'')
save('notes.png', b'These are my notes, not a picture.\n')
jb = io.BytesIO()
Image.fromarray(data.astronaut()).resize((64, 64)).save(jb, 'JPEG', quality=90)
save('photo-as.png', jb.getvalue())
save('dot.png', png_raw(1, 1, 8, 2, b'\0' + bytes([0, 128, 128])))
print('done')
