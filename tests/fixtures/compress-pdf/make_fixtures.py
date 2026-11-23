#!/usr/bin/env python3
"""Makes the PDFs that tests/tools/compress-pdf.test.js compresses, and expected.json.

    python3 tests/fixtures/compress-pdf/make_fixtures.py

Needs reportlab (and the Vera font it ships, embedded as the text font), pikepdf (libqpdf),
Pillow and numpy. Every picture is drawn from a fixed seed. The encrypted files use random
salts, so they differ from run to run; nothing in expected.json does.

Every image XObject has a /TTMark name. The page under test keeps unknown keys of an image
dictionary, so verify.py can find the same picture in the original and in the copy. For
each marked picture expected.json says what it must become at each level: a pixel size
and a filter, or "same" for a picture that must be left exactly as it is. Those sizes come
from the pixel size and the size the picture is drawn at, both chosen here, by the rule the
page's guide states: a picture is shrunk only when it is more than 1/0.9 times sharper than
the level needs, keeping its proportions.

  scan-colour.pdf   a 300 ppi colour JPEG scan with an invisible OCR text layer
  scan-grey.pdf     a 300 ppi greyscale JPEG scan (DeviceGray must stay DeviceGray)
  photo.pdf         a photo document: vector heading, a 500 ppi camera JPEG
  cmyk.pdf          a 300 ppi CMYK JPEG stored the Adobe way (inverted, /Decode [1 0 ...])
  exif.pdf          a 400 ppi JPEG whose EXIF says "rotate 90" (orientation 6), which PDF
                    readers ignore, so it is drawn unrotated
  tagged.pdf        two tagged pages (structure tree, MCIDs), embedded Vera font, a web
                    link and a link to page 2, two levels of bookmarks, a text field and a
                    ticked checkbox, the same photo stored twice, a page thumbnail,
                    PieceInfo, an unused object and unfiltered content streams
  placement.pdf     pictures drawn twice at different sizes, rotated, inside a tiling
                    pattern (and also on the page), a soft-mask group, a Type 3 glyph and an annotation appearance,
                    after an inline image whose data holds "EI", on a page with /UserUnit 2,
                    on pages turned by /Rotate 90 and an inherited /Rotate 270, with a
                    CropBox, and pages of five sizes; saved with object streams
  kinds.pdf         a colour-key masked picture, an indexed one, a 16-bit one, a 1-bit
                    CCITT G4 scan, a JPEG 2000 one (all left alone), a flat-colour chart
                    (shrunk but kept lossless) and a photo with a soft mask
  pdfa1.pdf         PDF/A-1b markings (XMP pdfaid part 1, sRGB output intent), classic
                    cross-reference table, PDF 1.4
  pdfx.pdf          PDF/X-1a markings and a CMYK JPEG, which must keep its colour space
  pdfa-cmyk.pdf     PDF/A-2b with a CMYK output intent and a CMYK JPEG, which stays CMYK too
  attach.pdf        an attached file and a signature field (fake signature)
  linear.pdf        tagged.pdf linearised
  update.pdf        a file with an incremental update that replaces page 1's text
  pdf20.pdf         PDF 2.0
  enc-*.pdf         encrypted copies of one small document (see ENCRYPTED below)
  damaged-*.pdf     a cut-off file, one with garbage between objects and in a picture,
                    one whose cross-reference offsets are all wrong
  not-a-pdf.pdf     a PNG file named .pdf
"""
import io
import json
import math
import os
import re
import struct

import numpy as np
import pikepdf
import reportlab
from PIL import Image, ImageCms, ImageDraw, ImageFont
from pikepdf import Array, Dictionary, Encryption, Name, Permissions, String
from reportlab.lib.colors import Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
VERA = os.path.join(os.path.dirname(reportlab.__file__), 'fonts', 'Vera.ttf')
pdfmetrics.registerFont(TTFont('Vera', VERA))

LEVELS = {'light': (220, 85), 'recommended': (150, 75), 'strong': (100, 60)}
EXPECT = {}


def out(name):
    return os.path.join(HERE, name)


def fate(w, h, drawn_w_in, drawn_h_in, level, lossless=False):
    """What the page must make of a w x h picture drawn at most drawn_w_in x drawn_h_in."""
    ppi = LEVELS[level][0]
    k = min(1.0, ppi * drawn_w_in / w, ppi * drawn_h_in / h)
    if k >= 0.9:
        return 'same'
    tw, th = max(1, math.floor(w * k + 0.5)), max(1, math.floor(h * k + 0.5))
    return [tw, th, 'FlateDecode' if lossless else 'DCTDecode']


def expect(fname, mark, fates):
    EXPECT.setdefault(fname, {}).setdefault('images', {})[mark] = fates


def fates(w, h, dw, dh, lossless=False):
    return {lv: fate(w, h, dw, dh, lv, lossless) for lv in LEVELS}


SAME = {lv: 'same' for lv in LEVELS}


# ---------- pictures ----------
def photo(w, h, seed, noise=2.5):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32) / max(w, h)
    r = 125 + 95 * np.sin(3.1 * x + seed) * np.cos(2.3 * y)
    g = 115 + 80 * np.sin(2.2 * y + 1.7 * x + seed)
    b = 140 + 90 * np.cos(3.7 * x - 2.9 * y)
    a = np.stack([r, g, b], -1)
    low = rng.normal(0, 1, (h // 24 + 2, w // 24 + 2, 3)).astype(np.float32)
    low = np.asarray(Image.fromarray(((low * 30 + 128).clip(0, 255)).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) - 128
    a = a + low + rng.normal(0, noise, (h, w, 1))
    im = Image.fromarray(a.clip(0, 255).astype(np.uint8), 'RGB')
    d = ImageDraw.Draw(im)
    for i in range(5):
        cx, cy, rr = rng.uniform(0, w), rng.uniform(0, h), rng.uniform(w / 14, w / 6)
        col = tuple(int(v) for v in rng.integers(30, 230, 3))
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=col)
    return im


def scan(w, h, seed, grey):
    rng = np.random.default_rng(seed)
    im = Image.new('RGB', (w, h), (247, 245, 239))
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(VERA, max(8, h // 34))
    words = 'invoice number total amount due date paid received thank you account reference'.split()
    y = int(h * 0.1)
    d.text((int(w * 0.08), y), 'INVOICE 2026-117', fill=(20, 20, 30), font=ImageFont.truetype(VERA, max(10, h // 20)))
    y += h // 10
    while y < h * 0.58:
        d.text((int(w * 0.08), y), ' '.join(rng.choice(words, 4)), fill=(35, 35, 45), font=f)
        y += h // 17
    d.ellipse((w * 0.5, h * 0.66, w * 0.9, h * 0.9), outline=(196, 32, 44), width=max(2, w // 120))
    d.text((w * 0.56, h * 0.74), 'PAID', fill=(196, 32, 44), font=ImageFont.truetype(VERA, max(10, h // 14)))
    a = np.asarray(im).astype(np.float32) + rng.normal(0, 1.2, (h, w, 1))
    im = Image.fromarray(a.clip(0, 255).astype(np.uint8), 'RGB')
    return im.convert('L') if grey else im


def chart(w, h):
    """A bar chart with a grid, a line and labels: few colours, sharp edges."""
    im = Image.new('RGB', (w, h), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for gy in range(int(h * 0.05), int(h * 0.86), max(4, h // 40)):
        d.line((int(w * 0.07), gy, int(w * 0.95), gy), fill=(220, 220, 220), width=1)
    cols = [(31, 111, 74), (180, 35, 24), (40, 90, 200), (230, 160, 20), (120, 60, 160)]
    for i, c in enumerate(cols):
        x0 = int(w * (0.1 + i * 0.16))
        top = int(h * (0.85 - 0.12 * (i + 2)))
        d.rectangle((x0, top, x0 + int(w * 0.11), int(h * 0.85)), fill=c)
        for hy in range(top, int(h * 0.85), 6):
            d.line((x0, hy, x0 + int(w * 0.11), hy + 3), fill=(255, 255, 255), width=1)
    pts = [(int(w * (0.08 + 0.85 * t / 40)), int(h * (0.5 + 0.3 * math.sin(t / 3.0)))) for t in range(41)]
    d.line(pts, fill=(0, 0, 0), width=2)
    f = ImageFont.truetype(VERA, max(8, h // 28))
    for i in range(5):
        d.text((int(w * (0.1 + i * 0.16)), int(h * 0.88)), 'Q%d' % (i + 1), fill=(0, 0, 0), font=f)
    d.text((int(w * 0.3), int(h * 0.01)), 'Sales 2026', fill=(0, 0, 0), font=f)
    d.line((int(w * 0.07), int(h * 0.86), int(w * 0.95), int(h * 0.86)), fill=(0, 0, 0), width=3)
    d.line((int(w * 0.07), int(h * 0.05), int(w * 0.07), int(h * 0.86)), fill=(0, 0, 0), width=3)
    return im


def jpeg(im, q, **kw):
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=q, **kw)
    return b.getvalue()


def flate(data):
    import zlib
    return zlib.compress(data, 9)


def image(pdf, data, w, h, cs, mark, filt='DCTDecode', bpc=8, **extra):
    s = pikepdf.Stream(pdf, data)
    s.Type = Name.XObject
    s.Subtype = Name.Image
    s.Width = w
    s.Height = h
    s.BitsPerComponent = bpc
    if cs is not None:
        s.ColorSpace = cs
    if filt:
        s.Filter = Name('/' + filt)
    s.TTMark = Name('/' + mark)
    for k, v in extra.items():
        s[Name('/' + k)] = v
    return pdf.make_indirect(s)


def jpeg_image(pdf, im, q, mark, **extra):
    cs = Name.DeviceGray if im.mode == 'L' else Name.DeviceRGB
    return image(pdf, jpeg(im, q), im.width, im.height, cs, mark, **extra)


def page_with(pdf, size, content, xobjects=None, **extra):
    pdf.add_blank_page(page_size=size)
    p = pdf.pages[-1]
    p.Resources = Dictionary(XObject=Dictionary(xobjects or {}))
    p.Contents = pdf.make_stream(content.encode('latin-1') if isinstance(content, str) else content)
    for k, v in extra.items():
        p[Name('/' + k)] = v
    return p


def text_pdf(size, lines, pages=1, compress=1, extra=None):
    """A reportlab PDF with embedded Vera text, returned as bytes."""
    b = io.BytesIO()
    c = canvas.Canvas(b, pagesize=size, pageCompression=compress)
    c.setTitle('Compress test')
    for n in range(pages):
        c.setFont('Vera', 14)
        y = size[1] - 54
        for line in lines(n):
            c.drawString(54, y, line)
            y -= 20
        if extra:
            extra(c, n)
        c.showPage()
    c.save()
    return b.getvalue()


def add_image_to_page(pdf, page, name, img, cm):
    res = page.obj.get('/Resources')
    if res is None:
        res = page.obj.Resources = Dictionary()
    if '/XObject' not in res:
        res.XObject = Dictionary()
    res.XObject[Name('/' + name)] = img
    page.contents_add(pdf.make_stream(('q %s cm /%s Do Q' % (cm, name)).encode()), prepend=False)


def save(pdf, name, **kw):
    kw.setdefault('object_stream_mode', pikepdf.ObjectStreamMode.preserve)
    kw.setdefault('compress_streams', False)
    pdf.save(out(name), **kw)


# ---------- scans, photo, CMYK, EXIF ----------
def make_scans():
    for name, grey, seed in (('scan-colour.pdf', False, 11), ('scan-grey.pdf', True, 12)):
        w, h = 600, 750                               # 2 x 2.5 in at 300 ppi
        b = io.BytesIO()
        c = canvas.Canvas(b, pagesize=(144, 180))
        t = c.beginText(14, 150)
        t.setTextRenderMode(3)                        # invisible, as OCR software writes it
        t.setFont('Vera', 9)
        t.textLine('INVOICE 2026-117')
        t.textLine('total amount due 48.20 EUR')
        c.drawText(t)
        c.showPage()
        c.save()
        pdf = pikepdf.open(io.BytesIO(b.getvalue()))
        img = jpeg_image(pdf, scan(w, h, seed, grey), 80, 'S')
        pg = pdf.pages[0]
        res = pg.obj.Resources
        res.XObject = Dictionary(ImS=img)
        pg.contents_add(pdf.make_stream(b'q 144 0 0 180 0 0 cm /ImS Do Q'), prepend=True)
        save(pdf, name)
        expect(name, 'S', fates(w, h, 2, 2.5))


def make_photo():
    pdf = pikepdf.open(io.BytesIO(text_pdf((360, 288), lambda n: ['Harbour at dusk', 'A photo page'])))
    im = photo(1200, 800, 3)                          # drawn at 3 x 2 in: 400 ppi
    add_image_to_page(pdf, pdf.pages[0], 'ImP', jpeg_image(pdf, im, 60, 'P'), '216 0 0 144 72 36')
    save(pdf, 'photo.pdf')
    expect('photo.pdf', 'P', fates(1200, 800, 3, 2))


def make_cmyk():
    w, h = 600, 400
    rgb = np.asarray(photo(w, h, 5), np.float32) / 255
    k = 1 - rgb.max(-1)
    cmy = (1 - rgb - k[..., None]) / np.maximum(1e-6, 1 - k[..., None])
    cmyk = np.concatenate([cmy, k[..., None]], -1)
    cmyk[:, :60] = [1, 0, 0, 0]                        # pure cyan, magenta, yellow strips
    cmyk[:, 60:120] = [0, 1, 0, 0]
    cmyk[:, 120:180] = [0, 0, 1, 0]
    im = Image.fromarray((cmyk * 255).clip(0, 255).astype(np.uint8), 'CMYK')
    data = jpeg(im, 85)                               # Pillow writes Adobe (inverted) CMYK
    pdf = pikepdf.new()
    img = image(pdf, data, w, h, Name.DeviceCMYK, 'C', Decode=Array([1, 0, 1, 0, 1, 0, 1, 0]))
    page_with(pdf, (216, 144), 'q 144 0 0 96 36 24 cm /ImC Do Q', {'/ImC': img})
    save(pdf, 'cmyk.pdf')
    expect('cmyk.pdf', 'C', fates(w, h, 2, 96 / 72))


def make_exif():
    w, h = 1600, 1000
    im = photo(w, h, 7)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 400, 250), fill=(250, 250, 250))
    d.text((30, 60), 'TOP LEFT', fill=(0, 0, 0), font=ImageFont.truetype(VERA, 80))
    d.polygon([(900, 450), (1400, 500), (900, 550)], fill=(200, 20, 20))
    ex = Image.Exif()
    ex[0x0112] = 6                                    # "rotate 90 clockwise to display"
    data = jpeg(im, 60, exif=ex.tobytes())
    pdf = pikepdf.new()
    img = image(pdf, data, w, h, Name.DeviceRGB, 'E')
    page_with(pdf, (360, 252), 'q 288 0 0 180 36 36 cm /ImE Do Q', {'/ImE': img})
    save(pdf, 'exif.pdf')
    expect('exif.pdf', 'E', fates(w, h, 4, 2.5))


# ---------- tagged document ----------
def make_tagged():
    def lines(n):
        return ['Chapter %d' % (n + 1), 'TAGGED-MARK-%02d' % (n + 1), 'The quick brown fox jumps over the lazy dog.',
                'Pack my box with five dozen liquor jugs.']

    def extra(c, n):
        if n == 0:
            c.bookmarkPage('ch1')
            c.addOutlineEntry('Chapter 1', 'ch1', level=0)
            c.bookmarkHorizontal('s11', 0, 600)
            c.addOutlineEntry('Section 1.1', 's11', level=1)
            c.linkURL('https://example.com/report', (54, 500, 254, 520), relative=0)
            c.drawString(54, 505, 'example.com/report')
            c.linkAbsolute('Go to chapter 2', 'ch2', (300, 500, 500, 520))
            c.drawString(300, 505, 'Go to chapter 2')
            form = c.acroForm
            c.drawString(54, 455, 'Name:')
            form.textfield(name='name', value='Ada Lovelace', x=110, y=440, width=200, height=22, borderWidth=1)
            form.checkbox(name='agree', checked=True, x=330, y=440, size=18)
        else:
            c.bookmarkPage('ch2')
            c.addOutlineEntry('Chapter 2', 'ch2', level=0)

    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lines, pages=2, compress=0, extra=extra)))
    im = photo(600, 400, 9)
    data = jpeg(im, 65)
    # The same photo stored twice, once per page: merging them saves one copy.
    for i, pg in enumerate(pdf.pages):
        img = image(pdf, data, 600, 400, Name.DeviceRGB, 'T', StructParent=10 + i)
        add_image_to_page(pdf, pg, 'ImT', img, '216 0 0 144 54 180')
    # Tags: each page's content is one marked-content sequence; the photo is a figure.
    root = pdf.Root
    root.MarkInfo = Dictionary(Marked=True)
    root.Lang = String('en-GB')
    st_root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    doc_el = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Document, P=st_root))
    kids, parent_nums = [], []
    for i, pg in enumerate(pdf.pages):
        sect = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Sect, P=doc_el, Pg=pg.obj, K=0))
        fig = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Figure, P=doc_el, Pg=pg.obj, Alt=String('Harbour photo %d' % (i + 1)),
                                           K=Dictionary(Type=Name.OBJR, Obj=pg.obj.Resources.XObject.ImT, Pg=pg.obj)))
        kids += [sect, fig]
        pg.obj.StructParents = i
        parent_nums += [i, Array([sect]), 10 + i, fig]
        raw = b''.join(s.read_bytes() for s in (pg.obj.Contents if isinstance(pg.obj.Contents, Array) else [pg.obj.Contents]))
        pg.obj.Contents = pdf.make_stream(b'/Sect <</MCID 0>> BDC\n' + raw + b'\nEMC\n')
    annots_els = []
    for i, pg in enumerate(pdf.pages):
        for a in pg.obj.get('/Annots', []):
            if a.get('/Subtype') == Name.Link:
                el = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Link, P=doc_el, Pg=pg.obj, K=Dictionary(Type=Name.OBJR, Obj=a, Pg=pg.obj)))
                a.StructParent = 20 + len(annots_els)
                parent_nums += [20 + len(annots_els), el]
                annots_els.append(el)
    doc_el.K = Array(kids + annots_els)
    st_root.K = doc_el
    # number trees must be sorted by key
    pairs = sorted(zip(parent_nums[0::2], parent_nums[1::2]), key=lambda p: p[0])
    st_root.ParentTree = pdf.make_indirect(Dictionary(Nums=Array([v for p in pairs for v in p])))
    st_root.ParentTreeNextKey = 30
    root.StructTreeRoot = st_root
    # Things a compressor may drop: a thumbnail, PieceInfo, an unused object.
    thumb = photo(38, 49, 4)
    pdf.pages[0].obj.Thumb = pdf.make_stream(thumb.tobytes(), Width=38, Height=49, ColorSpace=Name.DeviceRGB, BitsPerComponent=8)
    junk = bytes(np.random.default_rng(1).integers(0, 255, 6000, dtype=np.uint8))
    private = pdf.make_stream(junk)
    root.PieceInfo = Dictionary(Illustrator=Dictionary(LastModified=String('D:20260101000000Z'), Private=private))
    pdf.pages[0].obj.PieceInfo = Dictionary(Illustrator=Dictionary(LastModified=String('D:20260101000000Z'), Private=private))
    pdf.make_indirect(pdf.make_stream(junk[:3000]))   # unused: reachable from nothing
    # Page 2 gets its own copy of the embedded font file, identical except that its /Length1 is
    # an indirect object, as some writers store it: merging duplicates must see through that.
    res1 = pdf.pages[1].obj.Resources
    fname = [k for k, v in res1.Font.items() if '/FontDescriptor' in v][0]
    font = res1.Font[fname]
    desc = font.FontDescriptor
    ff = desc.FontFile2
    ff2 = pikepdf.Stream(pdf, ff.read_raw_bytes())
    for k, v in ff.stream_dict.items():
        if k != '/Length':
            ff2[k] = v
    ff2.Length1 = pdf.make_indirect(int(ff.Length1))
    desc2 = pdf.make_indirect(Dictionary({k: v for k, v in desc.items()}))
    desc2.FontFile2 = pdf.make_indirect(ff2)
    font2 = pdf.make_indirect(Dictionary({k: v for k, v in font.items()}))
    font2.FontDescriptor = desc2
    res2 = Dictionary({k: v for k, v in res1.items()})
    res2.Font = Dictionary({k: (font2 if k == fname else v) for k, v in res1.Font.items()})
    pdf.pages[1].obj.Resources = res2
    save(pdf, 'tagged.pdf')
    expect('tagged.pdf', 'T', fates(600, 400, 3, 2))
    return 'tagged.pdf'


# ---------- where pictures are drawn ----------
def jp(pdf, seed, mark, w=400, h=400, q=60):
    return image(pdf, jpeg(photo(w, h, seed), q), w, h, Name.DeviceRGB, mark)


def make_placement():
    pdf = pikepdf.new()
    A, B, C, D, E, F, G, O = (jp(pdf, 20 + i, m, *((400, 200) if m == 'B' else (400, 400))) for i, m in enumerate('ABCDEFGO'))
    # p1: Letter with a CropBox; A drawn at 1 x 1 in (A is drawn again on p5 at 3 x 3 in)
    p1 = page_with(pdf, (612, 792), 'q 72 0 0 72 100 600 cm /A Do Q', {'/A': A}, CropBox=Array([36, 36, 576, 756]))
    # p2: A4, /Rotate 90; B (400 x 200) drawn rotated: its width along y (96 pt), its height along -x (48 pt)
    page_with(pdf, (595, 842), 'q 0 96 -48 0 300 300 cm /B Do Q', {'/B': B}, Rotate=90)
    # p3: small page with an inherited /Rotate 270; C only inside a tiling pattern
    pat = pdf.make_stream(b'q 72 0 0 72 0 0 cm /C Do Q', Type=Name.Pattern, PatternType=1, PaintType=1, TilingType=1,
                          BBox=Array([0, 0, 72, 72]), XStep=72, YStep=72, Resources=Dictionary(XObject=Dictionary(C=C)))
    # C is drawn directly on p3 too (200 ppi), but its size inside the pattern is unknown: left alone
    p3 = page_with(pdf, (288, 288), '/Pattern cs /P1 scn 36 36 216 216 re f\nq 144 0 0 144 72 72 cm /C Do Q', {'/C': C})
    p3.obj.Resources.Pattern = Dictionary(P1=pat)
    # p4: /UserUnit 2, D drawn at 144 x 144 units = 4 x 4 in: 100 ppi, already sharp enough
    page_with(pdf, (306, 396), 'q 144 0 0 144 36 36 cm /D Do Q', {'/D': D}, UserUnit=2)
    # p5: A4 landscape: A at 3 x 3 in; E only in a soft-mask group; an inline image with "EI"
    # in its data, then F at 96 x 96 pt
    grp = pdf.make_stream(b'q 144 0 0 144 0 0 cm /E Do Q', Type=Name.XObject, Subtype=Name.Form, BBox=Array([0, 0, 144, 144]),
                          Group=Dictionary(S=Name.Transparency, CS=Name.DeviceGray), Resources=Dictionary(XObject=Dictionary(E=E)))
    gs = Dictionary(Type=Name.ExtGState, SMask=Dictionary(Type=Name.Mask, S=Name.Luminosity, G=grp))
    inline = bytes(range(16)) + b' EI\n\x00\x81\xfe Q' + bytes(range(200, 236))
    inline = inline[:64]
    c5 = (b'q 216 0 0 216 60 300 cm /A Do Q\n'
          b'q /GS1 gs 0 0 1 rg 400 60 144 144 re f Q\n'
          b'q 72 0 0 72 600 400 cm BI /W 8 /H 8 /BPC 8 /CS /G ID ' + inline + b' EI Q\n'
          b'q 96 0 0 96 600 200 cm /F Do Q\n')
    p5 = page_with(pdf, (842, 595), c5, {'/A': A, '/F': F})
    p5.obj.Resources.ExtGState = Dictionary(GS1=gs)
    # p6: Letter: G only inside a Type 3 glyph; O only in an annotation appearance mapped to 96 x 96 pt
    glyph = pdf.make_stream(b'1000 0 d0 q 1000 0 0 1000 0 0 cm /G Do Q')
    t3 = Dictionary(Type=Name.Font, Subtype=Name.Type3, FontBBox=Array([0, 0, 1000, 1000]), FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]),
                    CharProcs=Dictionary(g=glyph), Encoding=Dictionary(Type=Name.Encoding, Differences=Array([65, Name.g])),
                    FirstChar=65, LastChar=65, Widths=Array([1000]), Resources=Dictionary(XObject=Dictionary(G=G)))
    p6 = page_with(pdf, (612, 792), 'BT /F3 72 Tf 72 600 Td (A) Tj ET', {})
    p6.obj.Resources.Font = Dictionary(F3=t3)
    ap = pdf.make_stream(b'q 1 0 0 1 0 0 cm /O Do Q', Type=Name.XObject, Subtype=Name.Form, BBox=Array([0, 0, 1, 1]),
                         Resources=Dictionary(XObject=Dictionary(O=O)))
    p6.obj.Annots = Array([pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Stamp, Rect=Array([300, 300, 396, 396]), F=4,
                                                        AP=Dictionary(N=ap)))])
    # p3 gets its /Rotate from an intermediate page tree node.
    pages = pdf.Root.Pages
    kids = list(pages.Kids)
    mid = pdf.make_indirect(Dictionary(Type=Name.Pages, Parent=pages, Kids=Array([kids[2]]), Count=1, Rotate=270))
    kids[2].Parent = mid
    pages.Kids = Array(kids[:2] + [mid] + kids[3:])
    save(pdf, 'placement.pdf', object_stream_mode=pikepdf.ObjectStreamMode.generate)
    e = lambda m, *a: expect('placement.pdf', m, fates(*a) if a else SAME)
    e('A', 400, 400, 3, 3)              # the larger of its two uses
    e('B', 400, 200, 96 / 72, 48 / 72)  # rotated: width and height follow the picture's own axes
    e('C')                              # drawn on a page, but also inside a pattern: left alone
    e('D', 400, 400, 4, 4)              # /UserUnit 2
    e('E')                              # inside a soft-mask group
    e('F', 400, 400, 96 / 72, 96 / 72)  # after the inline image
    e('G')                              # inside a Type 3 glyph
    e('O', 400, 400, 96 / 72, 96 / 72)  # annotation appearance
    EXPECT['placement.pdf']['pages'] = {'rotate': [0, 90, 270, 0, 0, 0], 'userunit': [1, 1, 1, 2, 1, 1]}


# ---------- kinds of pictures ----------
def g4(im):
    """CCITT Group 4 data of a 1-bit picture, taken from a one-strip TIFF."""
    b = io.BytesIO()
    im.save(b, 'TIFF', compression='group4', tiffinfo={278: im.height})
    t = Image.open(io.BytesIO(b.getvalue()))
    off, cnt = t.tag_v2[273], t.tag_v2[279]
    off = off[0] if isinstance(off, tuple) else off
    cnt = cnt[0] if isinstance(cnt, tuple) else cnt
    return b.getvalue()[off:off + cnt], t.tag_v2.get(262, 0)


def make_kinds():
    pdf = pikepdf.new()
    xo, content = {}, []

    def place(name, img, x, y, s=96):
        xo['/' + name] = img
        content.append('q %s 0 0 %s %d %d cm /%s Do Q' % (s, s, x, y, name))

    # colour-key mask: exact colours matter, so it stays
    place('H', image(pdf, flate(chart(400, 400).tobytes()), 400, 400, Name.DeviceRGB, 'H', 'FlateDecode', Mask=Array([250, 255, 250, 255, 250, 255])), 36, 660)
    # indexed (a palette)
    pal = bytes([0, 0, 0, 255, 255, 255, 31, 111, 74, 180, 35, 24, 40, 90, 200, 230, 160, 20, 120, 60, 160, 200, 200, 200])
    idx = (np.add.outer(np.arange(400) // 50, np.arange(400) // 50) % 8).astype(np.uint8)
    place('I', image(pdf, flate(idx.tobytes()), 400, 400, Array([Name.Indexed, Name.DeviceRGB, 7, String(pal)]), 'I', 'FlateDecode'), 150, 660)
    # 16 bits per component
    a16 = (np.asarray(photo(64, 64, 32, 0.3), np.uint16) * 257).astype('>u2')
    place('J', image(pdf, flate(a16.tobytes()), 64, 64, Name.DeviceRGB, 'J', 'FlateDecode', bpc=16), 264, 660, 16)
    # a black-and-white CCITT G4 scan at 300 ppi
    bw = scan(600, 750, 33, True).point(lambda v: 255 if v > 150 else 0).convert('1')
    data, photometric = g4(bw)
    parms = Dictionary(K=-1, Columns=600, Rows=750, BlackIs1=photometric == 1)
    place('K', image(pdf, data, 600, 750, Name.DeviceGray, 'K', 'CCITTFaxDecode', bpc=1, DecodeParms=parms), 36, 400, 0)
    content[-1] = 'q 144 0 0 180 36 420 cm /K Do Q'
    # JPEG 2000
    b = io.BytesIO()
    photo(300, 300, 34).save(b, 'JPEG2000', quality_mode='rates', quality_layers=[40])
    place('N', image(pdf, b.getvalue(), 300, 300, Name.DeviceRGB, 'N', 'JPXDecode'), 200, 420, 72)
    # a flat-colour chart at 600 ppi: shrunk, but kept lossless
    place('L', image(pdf, flate(chart(600, 600).tobytes()), 600, 600, Name.DeviceRGB, 'L', 'FlateDecode'), 300, 420, 72)
    # the same chart stored a second time: merged into one
    place('L2', image(pdf, flate(chart(600, 600).tobytes()), 600, 600, Name.DeviceRGB, 'L', 'FlateDecode'), 300, 300, 72)
    # a photo with a soft mask, both 300 ppi
    alpha = np.clip(255 - np.hypot(*np.mgrid[-60:60, -60:60]) * 3.6, 0, 255).astype(np.uint8)
    sm = pdf.make_indirect(pikepdf.Stream(pdf, flate(alpha.tobytes()), Type=Name.XObject, Subtype=Name.Image, Width=120, Height=120,
                                          ColorSpace=Name.DeviceGray, BitsPerComponent=8, Filter=Name.FlateDecode))
    place('M', image(pdf, flate(photo(120, 120, 35, 0.3).tobytes()), 120, 120, Name.DeviceRGB, 'M', 'FlateDecode', SMask=sm), 420, 420, 28.8)
    page_with(pdf, (612, 792), '\n'.join(content), xo)
    save(pdf, 'kinds.pdf', compress_streams=True)
    for m in 'HIJKN':
        expect('kinds.pdf', m, SAME)
    expect('kinds.pdf', 'L', fates(600, 600, 1, 1, lossless=True))
    expect('kinds.pdf', 'M', fates(120, 120, 0.4, 0.4))


# ---------- PDF/A-1b and PDF/X ----------
XMP_A1 = '''<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>1</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Archive copy</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>'''


def make_pdfa():
    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lambda n: ['Archive copy', 'PDFA-MARK'])))
    pdf.Root.Metadata = pdf.make_stream(XMP_A1.encode('utf-8'), Type=Name.Metadata, Subtype=Name.XML)
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    prof = pdf.make_stream(icc, N=3)
    pdf.Root.OutputIntents = Array([Dictionary(Type=Name.OutputIntent, S=Name.GTS_PDFA1, OutputConditionIdentifier=String('sRGB'),
                                               DestOutputProfile=prof)])
    pdf.docinfo.Title = String('Archive copy')
    add_image_to_page(pdf, pdf.pages[0], 'ImA', jpeg_image(pdf, photo(600, 450, 41), 75, 'A'), '144 0 0 108 54 400')
    save(pdf, 'pdfa1.pdf', object_stream_mode=pikepdf.ObjectStreamMode.disable, force_version='1.4',
         fix_metadata_version=False, compress_streams=True)
    expect('pdfa1.pdf', 'A', fates(600, 450, 2, 1.5))
    # PDF/X-1a: CMYK only, so a CMYK JPEG may not become RGB
    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lambda n: ['Print copy', 'PDFX-MARK'])))
    pdf.docinfo[Name.GTS_PDFXVersion] = String('PDF/X-1:2001')
    pdf.docinfo[Name.GTS_PDFXConformance] = String('PDF/X-1a:2001')
    cm = np.zeros((450, 600, 4), np.uint8)
    cm[..., 0] = np.linspace(0, 255, 600)[None, :]
    cm[..., 1] = np.linspace(0, 255, 450)[:, None]
    img = image(pdf, jpeg(Image.fromarray(cm, 'CMYK'), 80), 600, 450, Name.DeviceCMYK, 'X', Decode=Array([1, 0, 1, 0, 1, 0, 1, 0]))
    add_image_to_page(pdf, pdf.pages[0], 'ImX', img, '144 0 0 108 54 400')
    save(pdf, 'pdfx.pdf', object_stream_mode=pikepdf.ObjectStreamMode.disable, force_version='1.3', compress_streams=True)
    expect('pdfx.pdf', 'X', SAME)


def make_pdfa_cmyk():
    """PDF/A-2b with a CMYK output intent (pdf.js's CGATS001 profile, vendored in the site):
    its CMYK JPEG may not become RGB either."""
    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lambda n: ['Press copy', 'PDFA-CMYK-MARK'])))
    pdf.Root.Metadata = pdf.make_stream(XMP_A1.replace('<pdfaid:part>1</pdfaid:part>', '<pdfaid:part>2</pdfaid:part>').encode('utf-8'),
                                        Type=Name.Metadata, Subtype=Name.XML)
    icc = open(os.path.join(HERE, '..', '..', '..', 'assets', 'vendor', 'pdfjs-resources', 'iccs', 'CGATS001Compat-v2-micro.icc'), 'rb').read()
    prof = pdf.make_stream(icc, N=4)
    pdf.Root.OutputIntents = Array([Dictionary(Type=Name.OutputIntent, S=Name.GTS_PDFA1, OutputConditionIdentifier=String('CGATS TR 001'),
                                               DestOutputProfile=prof)])
    cm = np.zeros((450, 600, 4), np.uint8)
    cm[..., 0] = np.linspace(0, 255, 600)[None, :]
    cm[..., 2] = np.linspace(255, 0, 450)[:, None]
    cm[..., 3] = (np.asarray(photo(600, 450, 42).convert('L')) // 3)
    img = image(pdf, jpeg(Image.fromarray(cm, 'CMYK'), 85), 600, 450, Name.DeviceCMYK, 'Y', Decode=Array([1, 0, 1, 0, 1, 0, 1, 0]))
    add_image_to_page(pdf, pdf.pages[0], 'ImY', img, '144 0 0 108 54 400')
    save(pdf, 'pdfa-cmyk.pdf', object_stream_mode=pikepdf.ObjectStreamMode.disable, force_version='1.7', compress_streams=True,
         fix_metadata_version=False)
    expect('pdfa-cmyk.pdf', 'Y', SAME)


# ---------- attachments and a signature ----------
def make_attach():
    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lambda n: ['With attachment', 'ATTACH-MARK'])))
    att = pikepdf.AttachedFileSpec(pdf, b'ATTACHMENT-MARK notes for the archive\n' * 20, mime_type='text/plain')
    pdf.attachments['notes.txt'] = att
    add_image_to_page(pdf, pdf.pages[0], 'ImQ', jpeg_image(pdf, photo(600, 600, 51), 70, 'Q'), '144 0 0 144 54 400')
    sig = pdf.make_indirect(Dictionary(Type=Name.Sig, Filter=Name('/Adobe.PPKLite'), SubFilter=Name('/adbe.pkcs7.detached'),
                                       ByteRange=Array([0, 100, 200, 300]), Contents=String(bytes.fromhex('3082' + 'ab' * 200)),
                                       M=String('D:20261101120000Z')))
    widget = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Sig, T=String('Signature1'), V=sig,
                                          Rect=Array([0, 0, 0, 0]), F=132, P=pdf.pages[0].obj))
    pdf.pages[0].obj.Annots = Array([widget])
    pdf.Root.AcroForm = Dictionary(Fields=Array([widget]), SigFlags=3)
    save(pdf, 'attach.pdf', compress_streams=True)
    expect('attach.pdf', 'Q', fates(600, 600, 2, 2))


# ---------- linearised, incremental update, PDF 2.0 ----------
def make_structures():
    src = pikepdf.open(out('tagged.pdf'))
    src.save(out('linear.pdf'), linearize=True)
    EXPECT['linear.pdf'] = {'images': EXPECT['tagged.pdf']['images']}
    # PDF 2.0
    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lambda n: ['Version two', 'PDF20-MARK'])))
    add_image_to_page(pdf, pdf.pages[0], 'ImV', jpeg_image(pdf, photo(600, 600, 61), 70, 'V'), '144 0 0 144 54 400')
    save(pdf, 'pdf20.pdf', force_version='2.0', compress_streams=True)
    expect('pdf20.pdf', 'V', fates(600, 600, 2, 2))
    # an incremental update: page 1 gets a new content stream (objects appended, /Prev)
    pdf = pikepdf.open(io.BytesIO(text_pdf((612, 792), lambda n: ['First revision', 'REVISION-1'])))
    add_image_to_page(pdf, pdf.pages[0], 'ImU', jpeg_image(pdf, photo(600, 600, 62), 70, 'U'), '144 0 0 144 54 400')
    b = io.BytesIO()
    pdf.save(b, object_stream_mode=pikepdf.ObjectStreamMode.disable, compress_streams=True, qdf=False)
    base = b.getvalue()
    q = pikepdf.open(io.BytesIO(base))
    page = q.pages[0].obj
    pnum = page.objgen[0]
    size = int(q.trailer.Size)
    root = q.trailer.Root.objgen[0]
    font_name = str(list(page.Resources.Font.keys())[0])
    newc = ('BT %s 14 Tf 54 738 Td (Second revision) Tj 0 -20 Td (REVISION-2) Tj ET\nq 144 0 0 144 54 400 cm /ImU Do Q' % font_name).encode()
    # the page dictionary again, pointing at the new content stream
    raw = re.sub(rb'/Contents\s*(\[[^\]]*\]|\d+ \d+ R)', ('/Contents %d 0 R' % size).encode(), page.unparse(resolved=True))
    upd = b''
    offs = {}
    pos = len(base)
    obj1 = ('%d 0 obj\n<< /Length %d >>\nstream\n' % (size, len(newc))).encode() + newc + b'\nendstream\nendobj\n'
    offs[size] = pos
    upd += obj1
    pos += len(obj1)
    obj2 = ('%d 0 obj\n' % pnum).encode() + raw + b'\nendobj\n'
    offs[pnum] = pos
    upd += obj2
    pos += len(obj2)
    startx = base.rfind(b'startxref')
    prev = int(base[startx + 9:].split()[0])
    xref = b'xref\n'
    for n in sorted(offs):
        xref += ('%d 1\n%010d 00000 n \n' % (n, offs[n])).encode()
    ids = q.trailer.ID
    info = q.trailer.Info.objgen[0]
    trailer = ('trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R /Prev %d /ID [<%s> <%s>] >>\nstartxref\n%d\n%%%%EOF\n' % (
        size + 1, root, info, prev, bytes(ids[0]).hex(), bytes(ids[1]).hex(), pos)).encode()
    with open(out('update.pdf'), 'wb') as f:
        f.write(base + upd + xref + trailer)
    expect('update.pdf', 'U', fates(600, 600, 2, 2))


# ---------- encrypted copies ----------
ENCRYPTED = {
    # name: (R, aes, user password, owner password, permissions, object streams)
    'enc-rc4-40.pdf': (2, False, 'rc4 forty', 'owner pass', {}, False),
    'enc-rc4-128.pdf': (3, False, 'rc4 one two eight', 'owner pass', {}, False),
    'enc-aes-128.pdf': (4, True, 'aes one two eight', 'owner pass', {}, False),
    'enc-aes-256.pdf': (6, True, 'aes two five six', 'owner pass', {}, False),
    'enc-unicode.pdf': (6, True, 'Пароль-ключ ü', 'owner pass', {}, False),
    'enc-latin.pdf': (4, True, 'pässwörd', 'owner pass', {}, False),
    'enc-objstm.pdf': (4, True, 'object streams', 'owner pass', {}, True),
    'enc-restricted.pdf': (6, True, '', 'owner pass', {'print_lowres': False, 'print_highres': False, 'extract': False}, False),
    'enc-nochanges.pdf': (6, True, '', 'owner pass', {'modify_other': False, 'modify_assembly': False}, False),
}


def make_encrypted():
    def lines(n):
        return ['Secret report', 'ENCRYPT-MARK', 'Not for the public.']
    base = text_pdf((288, 360), lines)
    for name, (R, aes, user, owner, perms, objstm) in ENCRYPTED.items():
        pdf = pikepdf.open(io.BytesIO(base))
        add_image_to_page(pdf, pdf.pages[0], 'ImK', jpeg_image(pdf, scan(450, 450, 71, True), 75, 'K'), '108 0 0 108 54 100')
        # pikepdf's own default forbids page assembly, and for R2 that also clears the one bit that
        # allows changes: start from everything allowed.
        full = dict(accessibility=True, extract=True, modify_annotation=True, modify_assembly=True, modify_form=True,
                    modify_other=True, print_lowres=True, print_highres=True)
        full.update(perms)
        allow = Permissions(**full)
        pdf.save(out(name), encryption=Encryption(owner=owner, user=user, R=R, aes=aes, allow=allow, metadata=R >= 4),
                 object_stream_mode=pikepdf.ObjectStreamMode.generate if objstm else pikepdf.ObjectStreamMode.disable)
        expect(name, 'K', fates(450, 450, 1.5, 1.5))
        EXPECT[name]['password'] = user
        EXPECT[name]['owner'] = owner


# ---------- damaged files, and one that is not a PDF ----------
def make_damaged():
    good = open(out('photo.pdf'), 'rb').read()
    open(out('damaged-cut.pdf'), 'wb').write(good[:len(good) * 2 // 3])
    # garbage between two objects, and inside the JPEG data (its stream keeps its length)
    pdf = pikepdf.open(out('photo.pdf'))
    data = bytearray(pdf.pages[0].obj.Resources.XObject.ImP.read_raw_bytes())
    rng = np.random.default_rng(81)
    data[len(data) // 3: len(data) // 3 + 4000] = bytes(rng.integers(0, 255, 4000, dtype=np.uint8))
    pdf.pages[0].obj.Resources.XObject.ImP.write(bytes(data), filter=Name.DCTDecode)
    b = io.BytesIO()
    pdf.save(b, object_stream_mode=pikepdf.ObjectStreamMode.disable)
    raw = b.getvalue()
    at = raw.find(b'endobj', len(raw) // 2) + 7
    raw = raw[:at] + b'%% garbage \x00\x01\x02 ' + bytes(rng.integers(0, 255, 300, dtype=np.uint8)).replace(b'obj', b'xbj') + b'\n' + raw[at:]
    open(out('damaged-garbage.pdf'), 'wb').write(raw)
    # every cross-reference offset is wrong (readers rebuild the table)
    pdf = pikepdf.open(out('scan-grey.pdf'))
    b = io.BytesIO()
    pdf.save(b, object_stream_mode=pikepdf.ObjectStreamMode.disable)
    raw = bytearray(b.getvalue())
    x = raw.rfind(b'\nxref\n') + 1
    end = raw.find(b'trailer', x)
    table = raw[x:end].decode('latin-1').split('\n')
    fixed = [t if not t.endswith(' n ') else '%010d %s' % (int(t[:10]) + 37, t[11:]) for t in table]
    raw[x:end] = '\n'.join(fixed).encode('latin-1')
    open(out('damaged-xref.pdf'), 'wb').write(bytes(raw))
    EXPECT['damaged-xref.pdf'] = {'images': EXPECT['scan-grey.pdf']['images']}
    # a PNG file named .pdf
    b = io.BytesIO()
    chart(40, 40).save(b, 'PNG')
    open(out('not-a-pdf.pdf'), 'wb').write(b.getvalue())


if __name__ == '__main__':
    make_scans()
    make_photo()
    make_cmyk()
    make_exif()
    make_tagged()
    make_placement()
    make_kinds()
    make_pdfa()
    make_pdfa_cmyk()
    make_attach()
    make_structures()
    make_encrypted()
    make_damaged()
    EXPECT['_levels'] = {k: {'ppi': v[0], 'quality': v[1]} for k, v in LEVELS.items()}
    with open(out('expected.json'), 'w') as f:
        json.dump(EXPECT, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write('\n')
    for n in sorted(os.listdir(HERE)):
        if n.endswith('.pdf'):
            print('%-22s %7d' % (n, os.path.getsize(out(n))))
