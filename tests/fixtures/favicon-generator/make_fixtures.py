"""Fixtures for tests/tools/favicon-generator.test.js (run: python3 make_fixtures.py).

logo.png      400 x 300, transparent, with an opaque blue (#0000ff) 200 x 200
              square at x 100-299, y 50-249: once its empty edges are trimmed,
              every icon is solid blue.
halves.png    300 x 150, left half red, right half blue: fitted, the icon has
              empty bands above and below; cropped, it is half red, half blue.
rotated.jpg   stored 64 x 32 (left half red, right half blue) with EXIF
              Orientation 6, so it shows 32 x 64: red above blue.
logo.svg      no width or height, viewBox 0 0 200 100: green left half,
              magenta right half, plus a script, an onload handler, a link
              to an image on another host and, in an empty foreignObject, a
              frame with a script (srcdoc) and an image from another host,
              none of which may reach icon.svg.
duo.svg       20 x 10 with its own dark style: red in light mode, green in dark
              mode, the left half through @media (prefers-color-scheme: dark),
              the right half through light-dark() with color-scheme.
deep.png      64 x 64, 16 bits a channel, RGB 0x8000 0x4000 0xC000.
palette.png   64 x 64 palette PNG: an orange 32 x 32 square on a transparent
              palette entry, so the trim leaves only orange.
dot.png       1 x 1 red.
panorama.png  20,000 x 300 in three bands: red, green, blue.
expected.json the ink box of "F" in inter-latin-700-normal.woff (fontTools), the
              ink box of "AV" set with the pair kerning of the font's GPOS table
              (Extension lookups included, as HarfBuzz reads them), and the
              upright colours of rotated.jpg (Pillow's exif_transpose).
"""
import json, os, struct, zlib
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
out = lambda n: os.path.join(HERE, n)


def gpos_kern(font, left, right):
    """The x advance change of a glyph pair (glyph names) from the GPOS kern feature of Latin text, in
    font units: in each lookup the first subtable that has the pair applies, and the lookups add up."""
    g = font['GPOS'].table
    scripts = {r.ScriptTag: r.Script for r in g.ScriptList.ScriptRecord}
    script = scripts.get('latn') or scripts.get('DFLT')
    ids = sorted({i for f in script.DefaultLangSys.FeatureIndex if g.FeatureList.FeatureRecord[f].FeatureTag == 'kern'
                  for i in g.FeatureList.FeatureRecord[f].Feature.LookupListIndex})
    total = 0
    for i in ids:
        lookup = g.LookupList.Lookup[i]
        for st in lookup.SubTable:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if st.LookupType != 2 or left not in st.Coverage.glyphs:
                continue
            if st.Format == 1:
                pairs = st.PairSet[st.Coverage.glyphs.index(left)].PairValueRecord
                rec = next((r for r in pairs if r.SecondGlyph == right), None)
                if rec is None:
                    continue
                total += getattr(rec.Value1, 'XAdvance', 0) or 0
                break
            c1, c2 = st.ClassDef1.classDefs.get(left, 0), st.ClassDef2.classDefs.get(right, 0)
            if c1 >= st.Class1Count or c2 >= st.Class2Count:
                continue
            total += getattr(st.Class1Record[c1].Class2Record[c2].Value1, 'XAdvance', 0) or 0
            break
    return total


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
    '  <foreignObject width="0" height="0"><div xmlns="http://www.w3.org/1999/xhtml">'
    '<iframe srcdoc="&lt;script&gt;parent.alert(1)&lt;/script&gt;"></iframe><img src="https://example.com/p.gif" alt=""/></div></foreignObject>\n'
    '</svg>\n')

open(out('duo.svg'), 'w').write(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10">\n'
    '  <style>#a { fill: #ff0000 } @media (prefers-color-scheme: dark) { #a { fill: #00ff00 } }\n'
    '    #b { color-scheme: light dark; fill: light-dark(#ff0000, #00ff00) }</style>\n'
    '  <rect id="a" width="10" height="10"/>\n'
    '  <rect id="b" x="10" width="10" height="10"/>\n'
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
    from fontTools.pens.transformPen import TransformPen
    a, v = font.getBestCmap()[ord('A')], font.getBestCmap()[ord('V')]
    kern = gpos_kern(font, a, v)
    pen = BoundsPen(gs)
    gs[a].draw(pen)
    gs[v].draw(TransformPen(pen, (1, 0, 0, 1, gs[a].width + kern, 0)))
    expected['inter_AV'] = {'bounds': list(pen.bounds), 'kern': kern}
except ImportError:
    pass
up = ImageOps.exif_transpose(Image.open(out('rotated.jpg'))).convert('RGB')
expected['rotated_upright'] = {'size': list(up.size), 'top': list(up.getpixel((16, 8))), 'bottom': list(up.getpixel((16, 56)))}
json.dump(expected, open(out('expected.json'), 'w'), indent=1)
print('ok', {n: os.path.getsize(out(n)) for n in sorted(os.listdir(HERE)) if not n.endswith('.py')})
