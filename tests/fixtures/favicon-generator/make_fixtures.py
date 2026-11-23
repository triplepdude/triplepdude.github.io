"""Fixtures for tests/tools/favicon-generator.test.js (run: python3 make_fixtures.py).

logo.png      400 x 300, transparent, with an opaque blue (#0000ff) 200 x 200
              square at x 100-299, y 50-249: once its empty edges are trimmed,
              every icon is solid blue.
halves.png    300 x 150, left half red, right half blue: fitted, the icon has
              empty bands above and below; cropped, it is half red, half blue.
rotated.jpg   stored 64 x 32 (left half red, right half blue) with EXIF
              Orientation 6, so it shows 32 x 64: red above blue.
logo.svg      no width or height, viewBox 0 0 200 100: green left half,
              magenta right half, plus a script, an onload handler and a link
              to an image on another host, none of which may reach icon.svg.
deep.png      64 x 64, 16 bits a channel, RGB 0x8000 0x4000 0xC000.
palette.png   64 x 64 palette PNG: an orange 32 x 32 square on a transparent
              palette entry, so the trim leaves only orange.
dot.png       1 x 1 red.
panorama.png  20,000 x 300 in three bands: red, green, blue.
expected.json the ink box of "F" in inter-latin-700-normal.woff (fontTools),
              and the upright colours of rotated.jpg (Pillow's exif_transpose).
"""
import json, os, struct, zlib
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
out = lambda n: os.path.join(HERE, n)


def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


def write_png16(path, w, h, rgb):
    raw = b''.join(b'\0' + struct.pack('>HHH', *rgb) * w for _ in range(h))
    data = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 16, 2, 0, 0, 0))
    data += png_chunk(b'IDAT', zlib.compress(raw, 9)) + png_chunk(b'IEND', b'')
    open(path, 'wb').write(data)


im = Image.new('RGBA', (400, 300), (0, 0, 0, 0))
im.paste((0, 0, 255, 255), (100, 50, 300, 250))
im.save(out('logo.png'), optimize=True)

im = Image.new('RGB', (300, 150), (255, 0, 0))
im.paste((0, 0, 255), (150, 0, 300, 150))
im.save(out('halves.png'), optimize=True)

im = Image.new('RGB', (64, 32), (255, 0, 0))
im.paste((0, 0, 255), (32, 0, 64, 32))
exif = Image.Exif()
exif[0x0112] = 6
im.save(out('rotated.jpg'), quality=95, exif=exif.tobytes())

open(out('logo.svg'), 'w').write(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" onload="alert(1)">\n'
    '  <script>document.title = "hacked"</script>\n'
    '  <rect width="100" height="100" fill="#00ff00"/>\n'
    '  <rect x="100" width="100" height="100" fill="#ff00ff"/>\n'
    '  <image xlink:href="https://example.com/x.png" width="10" height="10"/>\n'
    '</svg>\n')

write_png16(out('deep.png'), 64, 64, (0x8000, 0x4000, 0xC000))

im = Image.new('P', (64, 64), 0)
im.putpalette([0, 0, 0, 255, 128, 0] + [0, 0, 0] * 254)
im.paste(1, (16, 16, 48, 48))
im.save(out('palette.png'), transparency=0)

Image.new('RGB', (1, 1), (255, 0, 0)).save(out('dot.png'))

im = Image.new('RGB', (20000, 300), (255, 0, 0))
im.paste((0, 255, 0), (6667, 0, 13334, 300))
im.paste((0, 0, 255), (13334, 0, 20000, 300))
im.save(out('panorama.png'), optimize=True)

expected = {}
try:
    from fontTools.ttLib import TTFont
    from fontTools.pens.boundsPen import BoundsPen
    font = TTFont(os.path.join(ROOT, 'assets', 'vendor', 'favicon-fonts', 'inter-latin-700-normal.woff'))
    gs = font.getGlyphSet()
    name = font.getBestCmap()[ord('F')]
    pen = BoundsPen(gs)
    gs[name].draw(pen)
    expected['inter_F'] = {'bounds': list(pen.bounds), 'unitsPerEm': font['head'].unitsPerEm}
except ImportError:
    pass
up = ImageOps.exif_transpose(Image.open(out('rotated.jpg'))).convert('RGB')
expected['rotated_upright'] = {'size': list(up.size), 'top': list(up.getpixel((16, 8))), 'bottom': list(up.getpixel((16, 56)))}
json.dump(expected, open(out('expected.json'), 'w'), indent=1)
print('ok', {n: os.path.getsize(out(n)) for n in sorted(os.listdir(HERE)) if not n.endswith('.py')})
