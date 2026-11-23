# Fixtures for tests/tools/jpg-to-webp.test.js. Run from this folder:
#   python3 make_fixtures.py
# Needs Pillow, numpy and scikit-image (for its public-domain sample photos).
#   camera.jpg   scikit-image's "coffee" (CC0) at 1200 x 800, quality 92, stored
#                sideways with EXIF Orientation 6 (as phones save portrait
#                photos), camera make and model, date taken and a GPS position
#   p3.jpg       256 x 128, the Display P3 test profile (p3.icc): a saturated
#                red-green-blue ramp over a grey ramp, quality 95, no chroma
#                subsampling
#   adobe.jpg    the same pixels with adobe.icc, a profile with the Adobe RGB
#                (1998) primaries and gamma made here ("Adobe RGB primaries (test)")
#   cmyk.jpg     64 x 48 CMYK JPEG: cyan left half, magenta right half
#   web.jpg      scikit-image's "astronaut" (NASA, public domain) at 512 x 512,
#                saved at quality 60 as on many web pages
#   pano.jpg     20,000 x 200 colour ramp, wider than WebP allows
#   tiny.jpg     1 x 1;  cut.jpg  camera.jpg cut off at 40%;  empty.jpg  0 bytes
#   notes.jpg    a text file named .jpg;  png-named.jpg  a PNG named .jpg
#   small.heic   a copy of tests/fixtures/image-converter/small.heic (64 x 48)
#   p3.heic      a copy of tests/fixtures/heic-to-jpg/display-p3.heic (128 x 64,
#                Display P3, as iPhones save HEIC)
#   iphone.jpg   as an iPhone saves a portrait JPG: 600 x 450 stored sideways
#                (Orientation 6) with an ICC v4 Display P3 profile like Apple's
#                (p3v4.icc: parametric curves, a multi-language name), camera
#                EXIF with the stored pixel size, and a GPS position; a patch of
#                the most saturated P3 red, which sRGB cannot show
# The WebP files the page makes are checked with ../png-to-webp/verify.py.
import io, struct
import numpy as np
from PIL import Image, ImageCms
from skimage import data

def s15(v): return struct.pack('>i', round(v * 65536))
def xyz(x, y, z): return b'XYZ ' + b'\0' * 4 + s15(x) + s15(y) + s15(z)
def text_desc(t):
    a = t.encode('ascii') + b'\0'
    return b'desc' + b'\0' * 4 + struct.pack('>I', len(a)) + a + b'\0' * 8 + b'\0' * 3 + b'\0' * 67

def matrix_profile(name, r, g, b, gamma):
    curv = b'curv' + b'\0' * 4 + struct.pack('>IH', 1, round(gamma * 256)) + b'\0\0'
    tags = [(b'desc', text_desc(name)), (b'cprt', b'text' + b'\0' * 4 + b'No copyright, test profile\0'),
            (b'wtpt', xyz(0.9642, 1.0, 0.8249)), (b'rXYZ', xyz(*r)), (b'gXYZ', xyz(*g)), (b'bXYZ', xyz(*b)),
            (b'rTRC', curv), (b'gTRC', curv), (b'bTRC', curv)]
    table, blob, off, seen = struct.pack('>I', len(tags)), b'', 128 + 4 + 12 * len(tags), {}
    for sig, d in tags:
        if d not in seen:
            while (off + len(blob)) % 4: blob += b'\0'
            seen[d] = off + len(blob)
            blob += d
        table += sig + struct.pack('>II', seen[d], len(d))
    body = table + blob
    while (128 + len(body)) % 4: body += b'\0'
    hdr = (struct.pack('>I', 128 + len(body)) + b'\0' * 4 + bytes([2, 0x10, 0, 0]) + b'mntrRGB XYZ ' + b'\0' * 12 +
           b'acsp' + b'\0' * 28 + s15(0.9642) + s15(1.0) + s15(0.8249) + b'\0' * 48)
    assert len(hdr) == 128
    return hdr + body

# An ICC v4 matrix profile as Apple writes it: 'para' curves (the sRGB curve) and
# 'mluc' text. Colorants are adapted to D50 with the Bradford matrix.
def mluc(t):
    u = t.encode('utf-16-be')
    return b'mluc' + b'\0' * 4 + struct.pack('>II', 1, 12) + b'enUS' + struct.pack('>II', len(u), 28) + u

def v4_profile(name, xy):
    B = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])
    cols = np.array([[x / y, 1, (1 - x - y) / y] for x, y in xy]).T
    w65 = np.array([0.3127 / 0.3290, 1, (1 - 0.3127 - 0.3290) / 0.3290]); w50 = np.array([0.9642, 1.0, 0.8249])
    M = cols * np.linalg.solve(cols, w65)
    M = np.linalg.inv(B) @ np.diag((B @ w50) / (B @ w65)) @ B @ M
    para = b'para' + b'\0' * 4 + struct.pack('>HH', 3, 0) + s15(2.4) + s15(1 / 1.055) + s15(0.055 / 1.055) + s15(1 / 12.92) + s15(0.04045)
    tags = [(b'desc', mluc(name)), (b'cprt', mluc('No copyright, test profile')), (b'wtpt', xyz(0.9642, 1.0, 0.8249)),
            (b'rXYZ', xyz(*M[:, 0])), (b'gXYZ', xyz(*M[:, 1])), (b'bXYZ', xyz(*M[:, 2])), (b'rTRC', para), (b'gTRC', para), (b'bTRC', para)]
    table, blob, off, seen = struct.pack('>I', len(tags)), b'', 128 + 4 + 12 * len(tags), {}
    for sig, d in tags:
        if d not in seen:
            while (off + len(blob)) % 4: blob += b'\0'
            seen[d] = off + len(blob)
            blob += d
        table += sig + struct.pack('>II', seen[d], len(d))
    body = table + blob
    while (128 + len(body)) % 4: body += b'\0'
    hdr = (struct.pack('>I', 128 + len(body)) + b'\0' * 4 + bytes([4, 0x30, 0, 0]) + b'mntrRGB XYZ ' + b'\0' * 12 +
           b'acsp' + b'\0' * 28 + s15(0.9642) + s15(1.0) + s15(0.8249) + b'\0' * 48)
    return hdr + body

# ---------- camera.jpg: stored sideways, Orientation 6 ----------
photo = Image.fromarray(data.coffee()).resize((1200, 800), Image.LANCZOS)
stored = photo.transpose(Image.ROTATE_90)       # what the camera wrote: shown after turning 90° clockwise
ex = Image.Exif()
ex[0x010F] = 'TestCam'          # Make
ex[0x0110] = 'TC-1'             # Model
ex[0x0112] = 6                  # Orientation: rotate 90° clockwise to view
ex[0x0132] = '2026:10:05 14:30:00'
ex.get_ifd(0x8769)[0x9003] = '2026:10:05 14:30:00'   # DateTimeOriginal
gps = ex.get_ifd(0x8825)
gps[1] = 'N'; gps[2] = (51.0, 30.0, 12.5); gps[3] = 'W'; gps[4] = (0.0, 7.0, 39.0)
stored.save('camera.jpg', quality=92, exif=ex.tobytes())

# ---------- p3.jpg and adobe.jpg ----------
p3 = open('p3.icc', 'rb').read()
adobe = matrix_profile('Adobe RGB primaries (test)', (0.60974, 0.31111, 0.01947), (0.20528, 0.62567, 0.06087),
                       (0.14919, 0.06322, 0.74457), 563 / 256)
ImageCms.ImageCmsProfile(io.BytesIO(adobe))      # littleCMS reads it
open('adobe.icc', 'wb').write(adobe)
# Smooth ramps, so lossy WebP stays close: saturated red to green to blue over the
# top half (the colours a wide gamut keeps), a grey ramp below.
x = np.arange(256) / 255.0
top = np.stack([np.clip(1 - 2 * x, 0, 1), 1 - np.abs(2 * x - 1), np.clip(2 * x - 1, 0, 1)], 1) * 235 + 10
a = np.zeros((128, 256, 3), np.uint8)
a[:64] = np.round(top)[None, :, :]
a[64:] = np.round(x * 255)[None, :, None]
Image.fromarray(a).save('p3.jpg', quality=95, subsampling=0, icc_profile=p3)
Image.fromarray(a).save('adobe.jpg', quality=95, subsampling=0, icc_profile=adobe)

# ---------- cmyk.jpg ----------
c = Image.new('CMYK', (64, 48), (255, 0, 0, 0))
c.paste((0, 255, 0, 0), (32, 0, 64, 48))
c.save('cmyk.jpg', quality=95)

# ---------- web.jpg, pano.jpg, tiny.jpg ----------
Image.fromarray(data.astronaut()).save('web.jpg', quality=60)
ramp = np.zeros((200, 20000, 3), np.uint8)
ramp[:, :, 0] = (np.arange(20000) * 255 // 19999)[None, :]
ramp[:, :, 1] = 120
ramp[:, :, 2] = 255 - ramp[:, :, 0]
Image.fromarray(ramp).save('pano.jpg', quality=85)
Image.new('RGB', (1, 1), (10, 120, 200)).save('tiny.jpg', quality=95)

# ---------- iphone.jpg: a portrait photo as an iPhone saves it ----------
p3v4 = v4_profile('Display P3 (test, v4)', [(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)])
ImageCms.ImageCmsProfile(io.BytesIO(p3v4))      # littleCMS reads it
open('p3v4.icc', 'wb').write(p3v4)
srgb = ImageCms.createProfile('sRGB')
up = Image.fromarray(data.astronaut()).resize((450, 600), Image.LANCZOS)   # upright, portrait
up = ImageCms.profileToProfile(up, srgb, ImageCms.ImageCmsProfile(io.BytesIO(p3v4)))   # the same look, stored as P3
a = np.asarray(up).copy()
a[20:80, 20:80] = (255, 0, 0)                    # P3's own red, beyond sRGB
ex = Image.Exif()
ex[0x010F] = 'Apple'; ex[0x0110] = 'iPhone (test)'; ex[0x0112] = 6
ex.get_ifd(0x8769)[0x9003] = '2026:11:02 09:08:07'
ex.get_ifd(0x8769)[0xA002] = 600; ex.get_ifd(0x8769)[0xA003] = 450    # the stored size
gps = ex.get_ifd(0x8825)
gps[1] = 'N'; gps[2] = (40.0, 41.0, 21.25); gps[3] = 'W'; gps[4] = (74.0, 2.0, 40.75); gps[6] = 12.5
Image.fromarray(a).transpose(Image.ROTATE_90).save('iphone.jpg', quality=90, icc_profile=p3v4, exif=ex.tobytes())

# ---------- broken and odd files ----------
b = open('camera.jpg', 'rb').read()
open('cut.jpg', 'wb').write(b[:int(len(b) * 0.4)])
open('empty.jpg', 'wb').write(b'')
open('notes.jpg', 'wb').write(b'Shopping list: milk, bread, coffee.\n')
pb = io.BytesIO()
Image.new('RGBA', (40, 30), (40, 160, 90, 255)).save(pb, 'PNG')
open('png-named.jpg', 'wb').write(pb.getvalue())
print('done')
