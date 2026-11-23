# Independent checks of WebP files made by /png-to-webp/ or /jpg-to-webp/, with
# Pillow (libwebp's own decoder, libpng and libjpeg for the sources) and
# littleCMS:
#   python3 verify.py SOURCE WEBP [SOURCE WEBP ...]
# prints a JSON list, one object per pair: the WebP's size and mode, its ICC
# profile and EXIF, and how its pixels compare with the source's: the source as
# Pillow decodes it (EXIF orientation applied; a cut-off file as far as it
# goes), resized with Pillow when the WebP is smaller.
#   maxDiff     largest colour difference where the source is not fully
#               transparent (what lossless must keep exactly)
#   alphaDiff   largest alpha difference
#   exactRows   how many rows from the top match exactly (for a cut-off file)
#   psnr        over RGB, pixels composited on white
#   srgbPsnr    the same after converting both through their own ICC profiles
#               to sRGB with littleCMS (both untagged: sRGB), i.e. how alike
#               they look
#   pixels      [[x, y, r, g, b, a], ...] of the WebP at a few points
# Pillow leaves the tRNS level of a 1, 2 or 4-bit greyscale PNG unscaled, so
# that colour key is applied here as libpng does.
import hashlib, io, json, math, sys
import numpy as np
from PIL import Image, ImageCms, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True


def on_white(a):
    al = a[..., 3:4] / 255.0
    return a[..., :3] * al + 255 * (1 - al)


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse == 0 else round(10 * math.log10(255 * 255 / mse), 2)


def to_srgb(rgba, profile):
    im = Image.fromarray(np.round(on_white(rgba.astype(float))).astype(np.uint8), 'RGB')
    if profile:
        im = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.createProfile('sRGB'))
    return np.asarray(im).astype(float)


def check(src_path, webp_path):
    out = {}
    wb = open(webp_path, 'rb').read()
    w = Image.open(io.BytesIO(wb))
    w.load()
    out['format'] = w.format
    out['size'] = list(w.size)
    out['mode'] = w.mode
    out['frames'] = getattr(w, 'n_frames', 1)
    icc = w.info.get('icc_profile')
    out['icc'] = hashlib.sha256(icc).hexdigest() if icc else None
    out['iccName'] = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip() if icc else None
    ex = w.getexif()
    out['exif'] = {
        'make': ex.get(0x010F), 'model': ex.get(0x0110), 'orientation': ex.get(0x0112),
        'dateTimeOriginal': ex.get_ifd(0x8769).get(0x9003), 'gps': bool(ex.get_ifd(0x8825)) or 0x8825 in ex,
        'width': ex.get_ifd(0x8769).get(0xA002), 'height': ex.get_ifd(0x8769).get(0xA003),
    } if len(ex) else None
    got = np.asarray(w.convert('RGBA'))
    h, wd = got.shape[:2]
    out['pixels'] = [[x, y] + got[y, x].tolist() for x, y in ((0, 0), (wd // 2, h // 2), (wd - 1, h - 1), (wd // 4, h // 4), (3 * wd // 4, h // 4))]

    try:
        s = Image.open(src_path)
        s.load()
    except Exception as e:
        out['srcError'] = type(e).__name__
        return out
    s_icc = s.info.get('icc_profile')
    out['srcIcc'] = hashlib.sha256(s_icc).hexdigest() if s_icc else None
    key = None
    if s.format == 'PNG' and s.mode == 'L' and 'transparency' in s.info:
        depth = open(src_path, 'rb').read()[24]
        if depth < 8:
            key = s.info['transparency'] * 255 // ((1 << depth) - 1)
    s = ImageOps.exif_transpose(s)
    if s.mode == 'CMYK':
        s = s.convert('RGB')
    if key is not None:
        g = np.asarray(s.convert('L'))
        ref = np.dstack([g, g, g, np.where(g == key, 0, 255)]).astype(np.uint8)
    else:
        ref = np.asarray(s.convert('RGBA'))
    if ref.shape[:2] != got.shape[:2]:
        ref = np.asarray(Image.fromarray(ref, 'RGBA').resize(w.size, Image.LANCZOS))
        out['resized'] = True
    r, g2 = ref.astype(np.int32), got.astype(np.int32)
    vis = r[..., 3] > 0
    out['maxDiff'] = int(np.abs(r[..., :3] - g2[..., :3])[vis].max()) if vis.any() else 0
    out['alphaDiff'] = int(np.abs(r[..., 3] - g2[..., 3]).max())
    same = (np.all(r == g2, axis=2) | ((r[..., 3] == 0) & (g2[..., 3] == 0))).all(axis=1)
    out['exactRows'] = int(np.argmin(same)) if not same.all() else int(h)
    out['psnr'] = psnr(on_white(r.astype(float)), on_white(g2.astype(float)))
    out['srgbPsnr'] = psnr(to_srgb(r, s_icc), to_srgb(g2, icc))
    return out


args = sys.argv[1:]
print(json.dumps([check(args[i], args[i + 1]) for i in range(0, len(args) - 1, 2)]))
