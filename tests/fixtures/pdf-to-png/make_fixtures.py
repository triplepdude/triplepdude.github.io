#!/usr/bin/env python3
"""Makes the PDFs that tests/tools/pdf-to-png.test.js converts, and expected.json.

    python3 tests/fixtures/pdf-to-png/make_fixtures.py

Needs pikepdf (qpdf), reportlab, numpy, Pillow and poppler (pdftoppm, pdftotext). Deterministic,
except that AES encryption picks random initialisation vectors, so the AES files differ from run to
run; no expected value depends on them.

pages.pdf     4 pages of mixed sizes, nothing painted behind them:
              1. A4 portrait: a red and a blue box and "Page 1".
              2. US Letter turned by a /Rotate 270 that it inherits from its parent page-tree
                 node, with a green box at the unrotated bottom-left corner.
              3. MediaBox 400 x 400 with a CropBox of 300 x 200: only the crop shows.
              4. 100 x 50 units with /UserUnit 2, so 200 x 200 / 2: shown 200 x 100 pt.
logo.pdf      one 300 x 200 pt page that paints itself white, with a grey square (0.5 grey),
              a pink square (RGB 1, 0.8, 0.8), a dark blue disc and black text: for
              "Make white transparent" and "Trim margins".
pictures.pdf  3 Letter pages of images. Page 1: an RGB image of 64 x 48 (Flate, known pixels),
              a JPEG of 60 x 40, a 40 x 40 image with a soft mask (alpha), an inline grey image
              of 16 x 16, a 1-bit image of 32 x 32, a stencil mask (not a picture) and a 4 x 4
              image (too small to count). Page 2 shows the 64 x 48 image again. Page 3 has text
              only. Page 1's JPEG is a smooth gradient, for dithering.
locked-*.pdf  one page each, opened with a password: rc4-40 (R2, "sesame40"), rc4-128 (R3,
              "pässwort"), aes-128 (R4, "open sesame"), aes-256 (R6, "пароль"), and rc4-128-euro
              (R3, "café€": PDFDocEncoding stores the euro sign as 0xA0, where the low byte of its
              code point, which PDF.js sends, is 0xAC).
restricted.pdf AES-256 with an owner password only, printing and copying forbidden.
damaged-*.pdf cut off at 60%, 400 bytes of garbage in the middle, every cross-reference offset
              wrong, a header followed by junk; notpdf.pdf is a PNG named .pdf.
objstm.pdf    object streams and a cross-reference stream; linear.pdf linearised;
              v20.pdf PDF 2.0; incremental.pdf an update appended that changes "Old" to "Updated".
features.pdf  a filled-in text field (with its appearance), a link, a bookmark, a structure tree,
              an attached file and an unsigned signature field.

expected.json, all computed here, never by the tool:
  sizes       pixel size of each page of pages.pdf at 72, 150 and 300 DPI (round(points x
              DPI / 72) of the crop box times /UserUnit, swapped for /Rotate 90 and 270), and at
              1920 pixels wide.
  poppler     each page of pages.pdf, and logo.pdf, incremental.pdf, features.pdf and page 1 of
              pictures.pdf, drawn by poppler (pdftoppm, an independent renderer) at 72 DPI on white,
              as a 12 x 12 grid of average RGB values.
  logo_box    the box of logo.pdf's non-white pixels (each channel 250 or less) in poppler's
              drawing at 150 DPI: x, y, w, h in pixels.
  pictures    per picture of pictures.pdf page 1, in drawing order: width, height and the RGBA
              pixels (base64): the RGB image exactly, the JPEG as Pillow (libjpeg) decodes it,
              the masked image with its mask as alpha, the inline and 1-bit images as grey.
  picture_box where each image is drawn on page 1 (the five pictures and the 4 x 4 image), as
              fractions of the page (x0, y0, x1, y1 from the top left).
  texts       pdftotext of incremental.pdf (the update must show).
  field       the text field's rectangle in features.pdf, as fractions of the page.
"""
import base64
import io
import json
import os
import subprocess
import tempfile
import zlib

import numpy as np
import pikepdf
from pikepdf import Array, Dictionary, Name, Stream
from PIL import Image
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def path(name):
    return os.path.join(HERE, name)


def save_pdf(pdf, name, **kw):
    pdf.save(path(name), deterministic_id=True, **kw)


def font(pdf, base='Helvetica'):
    return pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name('/' + base), Encoding=Name.WinAnsiEncoding))


def add_page(pdf, box, content, resources=None, parent=None, **extra):
    page = Dictionary(Type=Name.Page, MediaBox=Array(box), Contents=pdf.make_stream(content.encode('latin-1')),
                      Resources=resources if resources is not None else Dictionary(), **extra)
    return pdf.make_indirect(page)


def page_tree(pdf, kids, **extra):
    node = pdf.make_indirect(Dictionary(Type=Name.Pages, Kids=Array(kids), Count=len(kids), **extra))
    for k in kids:
        k.Parent = node
    return node


def finish(pdf, root_kids):
    """Builds the root of the page tree; Count counts the leaves."""
    def leaves(n):
        return sum(leaves(k) for k in n.Kids) if n.Type == Name.Pages else 1
    root = page_tree(pdf, root_kids)
    root.Count = sum(leaves(k) for k in root_kids)
    pdf.Root.Pages = root


def make_pages():
    pdf = pikepdf.new()
    f1 = font(pdf, 'Helvetica-Bold')
    res = Dictionary(Font=Dictionary(F1=f1))
    w, h = A4
    p1 = add_page(pdf, [0, 0, w, h], '1 0 0 rg 100 %.2f 200 150 re f 0 0 1 rg 350 %.2f 150 150 re f 0 g BT /F1 48 Tf 100 %.2f Td (Page 1) Tj ET'
                  % (h - 250, h - 250, h - 450), res)
    p2 = add_page(pdf, [0, 0, 612, 792], '0 0.6 0 rg 0 0 150 100 re f 0 g BT /F1 40 Tf 200 400 Td (Page 2) Tj ET', res)
    p3 = add_page(pdf, [0, 0, 400, 400], '1 1 0 rg 0 0 400 400 re f 0.5 0 0.5 rg 100 150 200 100 re f', res, CropBox=Array([50, 100, 350, 300]))
    p4 = add_page(pdf, [0, 0, 100, 50], '1 0.5 0 rg 0 0 100 50 re f 0 g 0 20 100 10 re f', res, UserUnit=2)
    mid = page_tree(pdf, [p2], Rotate=270)
    finish(pdf, [p1, mid, p3, p4])
    save_pdf(pdf, 'pages.pdf')
    # Shown sizes in points: crop box x UserUnit, swapped for a quarter turn.
    return [(w, h), (792, 612), (300, 200), (200, 100)]


def make_logo():
    pdf = pikepdf.new()
    f1 = font(pdf, 'Helvetica-Bold')
    res = Dictionary(Font=Dictionary(F1=f1))
    # Top-down boxes: grey 20-60 x 20-60, pink 80-120 x 20-60, disc centre (200, 110) radius 50,
    # text "LOGO" from x 30 at a baseline 150 pt from the top. The page is 200 pt tall.
    k = 0.5523
    cx, cy, r = 200, 200 - 110, 50
    disc = ('%g %g m %g %g %g %g %g %g c %g %g %g %g %g %g c %g %g %g %g %g %g c %g %g %g %g %g %g c f'
            % (cx + r, cy, cx + r, cy + k * r, cx + k * r, cy + r, cx, cy + r, cx - k * r, cy + r, cx - r, cy + k * r, cx - r, cy,
               cx - r, cy - k * r, cx - k * r, cy - r, cx, cy - r, cx + k * r, cy - r, cx + r, cy - k * r, cx + r, cy))
    content = ('1 g 0 0 300 200 re f 0.5 g 20 140 40 40 re f 1 0.8 0.8 rg 80 140 40 40 re f 0.1 0.2 0.5 rg ' + disc +
               ' 0 g BT /F1 24 Tf 30 50 Td (LOGO) Tj ET')
    p = add_page(pdf, [0, 0, 300, 200], content, res)
    finish(pdf, [p])
    save_pdf(pdf, 'logo.pdf')


def image(pdf, w, h, data, cs='/DeviceRGB', bpc=8, **extra):
    return pdf.make_indirect(Stream(pdf, zlib.compress(bytes(data), 9), Type=Name.XObject, Subtype=Name.Image, Width=w, Height=h,
                                    ColorSpace=Name(cs), BitsPerComponent=bpc, Filter=Name.FlateDecode, **extra))


def make_pictures():
    pdf = pikepdf.new()
    f1 = font(pdf)
    pics = []
    # 1. RGB 64 x 48, every pixel known.
    rgb = np.zeros((48, 64, 3), np.uint8)
    for y in range(48):
        for x in range(64):
            rgb[y, x] = (x * 4, y * 5, (x + y) * 2)
    im1 = image(pdf, 64, 48, rgb.tobytes())
    pics.append(('rgb', np.dstack([rgb, np.full((48, 64), 255, np.uint8)])))
    # 2. A JPEG of 60 x 40: a smooth gradient, so 256 colours would show bands without dithering.
    gy, gx = np.mgrid[0:40, 0:60]
    grad = np.dstack([(gx * 255 / 59), (gy * 255 / 39), (255 - gx * 200 / 59)]).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(grad, 'RGB').save(buf, 'JPEG', quality=92, subsampling=0)
    jpeg = buf.getvalue()
    im2 = pdf.make_indirect(Stream(pdf, jpeg, Type=Name.XObject, Subtype=Name.Image, Width=60, Height=40,
                                   ColorSpace=Name.DeviceRGB, BitsPerComponent=8, Filter=Name.DCTDecode))
    dec = np.asarray(Image.open(io.BytesIO(jpeg)).convert('RGB'))
    pics.append(('jpeg', np.dstack([dec, np.full((40, 60), 255, np.uint8)])))
    # 3. A 40 x 40 blue image with a soft mask: a disc that fades out.
    yy, xx = np.mgrid[0:40, 0:40]
    alpha = np.clip(255 - np.hypot(xx - 19.5, yy - 19.5) * 12, 0, 255).astype(np.uint8)
    smask = image(pdf, 40, 40, alpha.tobytes(), '/DeviceGray')
    col = np.zeros((40, 40, 3), np.uint8)
    col[:] = (20, 120, 220)
    im3 = image(pdf, 40, 40, col.tobytes(), SMask=smask)
    pics.append(('masked', np.dstack([col, alpha])))
    # 4. An inline grey image of 16 x 16 (BI ... ID ... EI).
    inl = np.array([[(x * 16 + y * 3) % 256 for x in range(16)] for y in range(16)], np.uint8)
    pics.append(('inline', np.dstack([inl, inl, inl, np.full((16, 16), 255, np.uint8)])))
    # 5. A 1-bit image of 32 x 32: a checkerboard of 4-pixel squares (0 is black).
    bits = np.array([[((x // 4) + (y // 4)) % 2 for x in range(32)] for y in range(32)], np.uint8)
    packed = np.packbits(bits, axis=1)
    im6 = image(pdf, 32, 32, packed.tobytes(), '/DeviceGray', 1)
    g1 = (bits * 255).astype(np.uint8)
    pics.append(('onebit', np.dstack([g1, g1, g1, np.full((32, 32), 255, np.uint8)])))
    # Not pictures: a stencil mask (painted in red) and a 4 x 4 image.
    mask = pdf.make_indirect(Stream(pdf, zlib.compress(np.packbits(np.eye(64, dtype=np.uint8), axis=1).tobytes()), Type=Name.XObject,
                                    Subtype=Name.Image, Width=64, Height=64, ImageMask=True, Filter=Name.FlateDecode))
    tiny = image(pdf, 4, 4, bytes(range(48)))
    res1 = Dictionary(Font=Dictionary(F1=f1), XObject=Dictionary(Im1=im1, Im2=im2, Im3=im3, Im6=im6, Mk=mask, Tn=tiny))
    inline_op = 'BI /W 16 /H 16 /CS /G /BPC 8 ID '
    # Placements, in points from the bottom left: x, y, w, h.
    # The 4 x 4 image is drawn too (PDF.js reports it), though it is too small to save.
    place = {'rgb': (50, 520, 256, 192), 'jpeg': (330, 520, 240, 160), 'masked': (50, 300, 160, 160), 'inline': (250, 300, 64, 64), 'onebit': (50, 100, 128, 128),
             'tiny': (500, 300, 32, 32)}
    c1 = ('BT /F1 20 Tf 50 740 Td (Pictures) Tj ET '
          'q 256 0 0 192 50 520 cm /Im1 Do Q q 240 0 0 160 330 520 cm /Im2 Do Q q 160 0 0 160 50 300 cm /Im3 Do Q '
          'q 64 0 0 64 250 300 cm ').encode('latin-1') + inline_op.encode('latin-1') + inl.tobytes() + (
          ' EI Q q 1 0 0 rg 128 0 0 128 350 300 cm /Mk Do Q q 32 0 0 32 500 300 cm /Tn Do Q q 128 0 0 128 50 100 cm /Im6 Do Q '
          'BT /F1 14 Tf 250 150 Td (Text beside the pictures) Tj ET').encode('latin-1')
    p1 = pdf.make_indirect(Dictionary(Type=Name.Page, MediaBox=Array([0, 0, 612, 792]), Contents=pdf.make_stream(c1), Resources=res1))
    res2 = Dictionary(Font=Dictionary(F1=f1), XObject=Dictionary(Im1=im1))
    p2 = add_page(pdf, [0, 0, 612, 792], 'BT /F1 20 Tf 50 740 Td (The same picture again) Tj ET q 128 0 0 96 50 500 cm /Im1 Do Q', res2)
    p3 = add_page(pdf, [0, 0, 612, 792], 'BT /F1 20 Tf 50 740 Td (Only text here) Tj ET', Dictionary(Font=Dictionary(F1=f1)))
    finish(pdf, [p1, p2, p3])
    save_pdf(pdf, 'pictures.pdf')
    boxes = {k: [x / 612, 1 - (y + h) / 792, (x + w) / 612, 1 - y / 792] for k, (x, y, w, h) in place.items()}
    return pics, boxes


def one_page(text):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setFont('Helvetica-Bold', 60)
    c.drawString(100, 500, text)
    c.showPage()
    c.save()
    return buf.getvalue()


def make_locked():
    for name, pw, R, aes in [('locked-rc4-40', 'sesame40', 2, False), ('locked-rc4-128', 'pässwort', 3, False),
                             ('locked-aes-128', 'open sesame', 4, True), ('locked-aes-256', 'пароль', 6, True),
                             ('locked-rc4-128-euro', 'café€', 3, False)]:
        with pikepdf.open(io.BytesIO(one_page('Locked ' + str(R)))) as pdf:
            pdf.save(path(name + '.pdf'), static_id=True, encryption=pikepdf.Encryption(user=pw, owner='owner secret', R=R, aes=aes, metadata=R >= 4))
    with pikepdf.open(io.BytesIO(one_page('Restricted'))) as pdf:
        pdf.save(path('restricted.pdf'), static_id=True,
                 encryption=pikepdf.Encryption(user='', owner='owner secret', R=6,
                                               allow=pikepdf.Permissions(extract=False, print_lowres=False, print_highres=False)))


def make_damaged():
    good = open(path('pages.pdf'), 'rb').read()
    with open(path('damaged-cut.pdf'), 'wb') as f:
        f.write(good[:int(len(good) * 0.6)])
    mid = len(good) // 2
    with open(path('damaged-garbage.pdf'), 'wb') as f:
        f.write(good[:mid] + bytes((i * 7919 + 13) % 256 for i in range(400)) + good[mid:])
    # Every offset in the cross-reference table points to byte 0.
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 100))
    out = io.BytesIO()
    pdf.save(out, deterministic_id=True, object_stream_mode=pikepdf.ObjectStreamMode.disable)
    raw = out.getvalue()
    xref = raw.rindex(b'xref')
    head, table = raw[:xref], raw[xref:]
    lines = table.split(b'\n')
    lines = [b'0000000000 00000 n ' if len(l) >= 18 and l[17:18] == b'n' else l for l in lines]
    with open(path('damaged-xref.pdf'), 'wb') as f:
        f.write(head + b'\n'.join(lines))
    with open(path('damaged-junk.pdf'), 'wb') as f:
        f.write(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n' + bytes((i * 7919) % 251 for i in range(3000)))
    png = io.BytesIO()
    Image.new('RGB', (8, 8), (200, 30, 30)).save(png, 'PNG')
    with open(path('notpdf.pdf'), 'wb') as f:
        f.write(png.getvalue())


def make_structure():
    base = open(path('pages.pdf'), 'rb').read()
    with pikepdf.open(io.BytesIO(base)) as pdf:
        save_pdf(pdf, 'objstm.pdf', object_stream_mode=pikepdf.ObjectStreamMode.generate)
    with pikepdf.open(io.BytesIO(base)) as pdf:
        save_pdf(pdf, 'linear.pdf', linearize=True)
    with pikepdf.open(io.BytesIO(base)) as pdf:
        save_pdf(pdf, 'v20.pdf', force_version='2.0')
    # An incremental update: a new content stream for page 1 and a new page object, appended with
    # a second cross-reference section whose trailer points back with /Prev.
    pdf = pikepdf.new()
    f1 = font(pdf, 'Helvetica-Bold')
    p = add_page(pdf, [0, 0, 300, 200], 'BT /F1 40 Tf 40 80 Td (Old) Tj ET', Dictionary(Font=Dictionary(F1=f1)))
    finish(pdf, [p])
    out = io.BytesIO()
    pdf.save(out, deterministic_id=True, object_stream_mode=pikepdf.ObjectStreamMode.disable)
    raw = out.getvalue()
    with pikepdf.open(io.BytesIO(raw)) as chk:
        page_num = chk.pages[0].obj.objgen[0]
        size = int(chk.trailer.Size)
        root_num = chk.Root.objgen[0]
        font_num = chk.pages[0].obj.Resources.Font.F1.objgen[0]
        parent_num = chk.pages[0].obj.Parent.objgen[0]
    startxref = int(raw[raw.rindex(b'startxref') + 9:].split()[0])
    new_content = b'BT /F1 40 Tf 40 80 Td (Updated) Tj ET'
    cnum = size
    body = b'\n%d 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n' % (cnum, len(new_content), new_content)
    page_obj = (b'%d 0 obj\n<< /Type /Page /Parent %d 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>\nendobj\n'
                % (page_num, parent_num, font_num, cnum))
    off_c = len(raw) + 1
    off_p = len(raw) + len(body)
    xref_at = len(raw) + len(body) + len(page_obj)
    xref = (b'xref\n%d 1\n%010d 00000 n \n%d 1\n%010d 00000 n \n' % (page_num, off_p, cnum, off_c) +
            b'trailer\n<< /Size %d /Root %d 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n' % (cnum + 1, root_num, startxref, xref_at))
    with open(path('incremental.pdf'), 'wb') as f:
        f.write(raw + body + page_obj + xref)
    text = subprocess.run(['pdftotext', path('incremental.pdf'), '-'], capture_output=True, check=True).stdout.decode().strip()
    return {'incremental': text}


def make_features():
    from reportlab.lib.colors import black, white
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, invariant=1)
    c.setFont('Helvetica', 18)
    c.drawString(72, 700, 'A form with a filled-in field')
    c.bookmarkPage('p1')
    c.addOutlineEntry('First page', 'p1', level=0)
    c.linkURL('https://example.com/', (72, 640, 300, 660), relative=0)
    c.drawString(72, 645, 'A link')
    c.acroForm.textfield(name='name', value='Ada Lovelace', x=72, y=560, width=300, height=36, fontName='Helvetica', fontSize=20,
                         borderColor=black, fillColor=white, textColor=black, forceBorder=True)
    c.showPage()
    c.save()
    pdf = pikepdf.open(io.BytesIO(buf.getvalue()))
    # A structure tree (one paragraph), an attached file and an unsigned signature field.
    pdf.Root.MarkInfo = Dictionary(Marked=True)
    st = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    st.K = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.P, P=st))
    pdf.Root.StructTreeRoot = st
    pdf.attachments['notes.txt'] = pikepdf.AttachedFileSpec(pdf, b'An attached file.\n', mime_type='text/plain')
    page = pdf.pages[0]
    sig = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Sig, T=pikepdf.String('Signature'),
                                       Rect=Array([72, 400, 300, 450]), F=4, P=page.obj))
    page.obj.Annots.append(sig)
    pdf.Root.AcroForm.Fields.append(sig)
    pdf.Root.AcroForm.SigFlags = 1
    pdf.save(path('features.pdf'), deterministic_id=True)
    return [72 / 612, 1 - (560 + 36) / 792, 372 / 612, 1 - 560 / 792]


def poppler(name, page, dpi=72):
    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, 'p')
        # -cropbox: draw what a viewer shows (pdftoppm draws the whole MediaBox by default).
        subprocess.run(['pdftoppm', '-cropbox', '-r', str(dpi), '-png', '-f', str(page), '-l', str(page), '-singlefile', path(name), base], check=True)
        return np.asarray(Image.open(base + '.png').convert('RGB'), dtype=np.float64)


def grid(img, n=12):
    h, w, _ = img.shape
    out = []
    for gy in range(n):
        row = []
        for gx in range(n):
            cell = img[gy * h // n:(gy + 1) * h // n, gx * w // n:(gx + 1) * w // n]
            row.append([round(float(v), 1) for v in cell.reshape(-1, 3).mean(axis=0)])
        out.append(row)
    return {'size': [w, h], 'grid': out}


def main():
    shown = make_pages()
    make_logo()
    pics, boxes = make_pictures()
    make_locked()
    make_damaged()
    texts = make_structure()
    field = make_features()
    logo = poppler('logo.pdf', 1, 150)
    ys, xs = np.where((logo <= 250).any(axis=2))
    expected = {
        'sizes': {str(dpi): [[round(w * dpi / 72), round(h * dpi / 72)] for w, h in shown] for dpi in (72, 150, 300)},
        'width1920': [[1920, round(h * 1920 / w)] for w, h in shown],
        'poppler': {'pages': {str(i + 1): grid(poppler('pages.pdf', i + 1)) for i in range(4)}, 'logo': grid(poppler('logo.pdf', 1)),
                    'incremental': grid(poppler('incremental.pdf', 1)), 'features': grid(poppler('features.pdf', 1)),
                    'pictures': grid(poppler('pictures.pdf', 1))},
        'logo_box': [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)],
        'pictures': [{'kind': k, 'w': int(a.shape[1]), 'h': int(a.shape[0]), 'rgba': base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()} for k, a in pics],
        'picture_box': boxes,
        'texts': texts,
        'field': field,
    }
    with open(path('expected.json'), 'w') as f:
        json.dump(expected, f, separators=(',', ':'))
    # Every PDF that is not meant to be damaged passes qpdf's check.
    for name in sorted(os.listdir(HERE)):
        if name.endswith('.pdf') and not name.startswith(('damaged', 'notpdf')):
            with pikepdf.open(path(name), password=PASSWORDS.get(name, '')) as pdf:
                problems = pdf.check_pdf_syntax()
                assert not problems, (name, problems)


# For qpdf. Below revision 5 a password is stored in PDFDocEncoding (qpdf converts it when writing,
# not when reading), so the R3 file opens with byte 0xE4 for the a with dots; R6 takes UTF-8.
PASSWORDS = {'locked-rc4-40.pdf': 'sesame40', 'locked-rc4-128.pdf': 'pässwort'.encode('latin-1'), 'locked-aes-128.pdf': 'open sesame', 'locked-aes-256.pdf': 'пароль',
             'locked-rc4-128-euro.pdf': b'caf\xe9\xa0'}  # the euro sign is 0xA0 in PDFDocEncoding


if __name__ == '__main__':
    main()
