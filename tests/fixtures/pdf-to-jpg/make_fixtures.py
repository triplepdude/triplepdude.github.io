#!/usr/bin/env python3
"""Makes the PDFs that tests/tools/pdf-to-jpg.test.js converts, and expected.json.

    python3 tests/fixtures/pdf-to-jpg/make_fixtures.py

Needs reportlab, pikepdf (qpdf), numpy, Pillow and poppler's pdftoppm. Deterministic.

pages.pdf  3 pages, nothing painted behind them (transparent where nothing is drawn):
           1. A4 portrait (595.28 x 841.89 pt): a red box and a blue box, text "Page 1".
           2. US Letter (612 x 792 pt) with /Rotate 90, so it shows as 792 x 612 landscape.
              A green box sits at the bottom-left corner of the unrotated page, which a
              90-degree clockwise turn puts at the top-left.
           3. 300.4 x 150.3 pt, filled orange, with a black bar: a size that is not a whole
              number of pixels at any common DPI.
huge.pdf   one 200 x 200 inch page (14,400 pt, the largest size in the implementation limits
           of the PDF Reference, appendix C),
           black with a white square in the middle.
fonts.pdf  one page set in fonts PDF.js must fetch: Japanese in HeiseiMin-W3 with the
           predefined CMap UniJIS-UCS2-H (not embedded), and ZapfDingbats (not embedded).
locked.pdf one A4 page, AES-256 (R6), user password "open sesame".
twelve.pdf 12 Letter pages with "Page N", for file names padded to two digits.
damaged.pdf starts like a PDF but holds no PDF objects.

expected.json, all computed here and not by the tool:
  sizes[dpi]  pixel size of every page of pages.pdf at 72, 150 and 300 DPI:
              round(points x dpi / 72), width and height swapped for /Rotate 90.
  points      colours at known points of pages.pdf, as fractions of the page's width and
              height as shown (after /Rotate).
  poppler     each page of pages.pdf drawn by poppler (pdftoppm, an independent renderer)
              at 72 DPI on white, reduced to a 12 x 12 grid of average RGB values.
  jpeg_luma_q the first 8 values (zig-zag order) of the IJG luminance quantisation table
              scaled for qualities 50 and 95 (libjpeg jcparam.c, jpeg_quality_scaling), which
              Chromium's encoder uses.
"""
import io
import json
import os
import subprocess
import tempfile

import numpy as np
import pikepdf
from PIL import Image
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def save(name, data):
    with open(os.path.join(HERE, name), 'wb') as f:
        f.write(data)


def make_pages():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, invariant=1)
    # Page 1: A4. reportlab's y axis runs up from the bottom of the page.
    w, h = A4
    c.setPageSize((w, h))
    c.setFillColorRGB(1, 0, 0)
    c.rect(100, h - 250, 200, 150, stroke=0, fill=1)      # x 100-300, 100-250 pt from the top
    c.setFillColorRGB(0, 0, 1)
    c.rect(350, h - 250, 150, 150, stroke=0, fill=1)      # x 350-500
    c.setFillColorRGB(0, 0, 0)
    c.setFont('Helvetica-Bold', 48)
    c.drawString(100, h - 450, 'Page 1')
    c.showPage()
    # Page 2: Letter, turned by /Rotate 90 below. Green box at the unrotated bottom-left.
    w, h = letter
    c.setPageSize((w, h))
    c.setFillColorRGB(0, 0.6, 0)
    c.rect(0, 0, 150, 100, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    c.setFont('Helvetica-Bold', 40)
    c.drawString(200, 400, 'Page 2')
    c.showPage()
    # Page 3: an odd size, filled orange, with a black bar across the middle.
    w, h = 300.4, 150.3
    c.setPageSize((w, h))
    c.setFillColorRGB(1, 0.5, 0)
    c.rect(0, 0, w, h, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    c.rect(0, h / 2 - 10, w, 20, stroke=0, fill=1)
    c.showPage()
    c.save()
    pdf = pikepdf.open(io.BytesIO(buf.getvalue()))
    pdf.pages[1].obj.Rotate = 90
    out = io.BytesIO()
    pdf.save(out, deterministic_id=True)
    save('pages.pdf', out.getvalue())
    shown = [(A4[0], A4[1]), (letter[1], letter[0]), (300.4, 150.3)]
    return shown


def make_huge():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(14400, 14400), invariant=1)
    c.setFillColorRGB(0, 0, 0)
    c.rect(0, 0, 14400, 14400, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.rect(4800, 4800, 4800, 4800, stroke=0, fill=1)
    c.showPage()
    c.save()
    save('huge.pdf', buf.getvalue())


def make_fonts():
    pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setFont('HeiseiMin-W3', 40)
    c.drawString(60, 700, '日本語のテキスト')
    c.setFont('ZapfDingbats', 40)
    c.drawString(60, 600, '4 8 n')
    c.setFont('Helvetica', 20)
    c.drawString(60, 500, 'Fonts that are not embedded')
    c.showPage()
    c.save()
    save('fonts.pdf', buf.getvalue())


def make_locked():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setFont('Helvetica-Bold', 60)
    c.drawString(100, 500, 'Locked 1')
    c.showPage()
    c.save()
    with pikepdf.open(io.BytesIO(buf.getvalue())) as pdf:
        pdf.save(os.path.join(HERE, 'locked.pdf'), static_id=True,
                 encryption=pikepdf.Encryption(user='open sesame', owner='owner secret', R=6))


def make_twelve():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, invariant=1)
    for i in range(1, 13):
        c.setFont('Helvetica-Bold', 60)
        c.drawString(100, 500, f'Page {i}')
        c.showPage()
    c.save()
    save('twelve.pdf', buf.getvalue())


def poppler_grid(page, n=12):
    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, 'p')
        subprocess.run(['pdftoppm', '-r', '72', '-png', '-f', str(page), '-l', str(page), '-singlefile',
                        os.path.join(HERE, 'pages.pdf'), base], check=True)
        img = np.asarray(Image.open(base + '.png').convert('RGB'), dtype=np.float64)
    h, w, _ = img.shape
    grid = []
    for gy in range(n):
        row = []
        for gx in range(n):
            cell = img[gy * h // n:(gy + 1) * h // n, gx * w // n:(gx + 1) * w // n]
            row.append([round(float(v), 1) for v in cell.reshape(-1, 3).mean(axis=0)])
        grid.append(row)
    return {'size': [w, h], 'grid': grid}


def ijg(q, base=(16, 11, 12, 14, 12, 10, 16, 14)):
    scale = 5000 // q if q < 50 else 200 - 2 * q
    return [min(255, max(1, (b * scale + 50) // 100)) for b in base]


def main():
    shown = make_pages()
    make_huge()
    make_fonts()
    make_locked()
    make_twelve()
    save('damaged.pdf', b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n' + bytes((i * 7919) % 251 for i in range(3000)))
    expected = {
        'sizes': {str(dpi): [[round(w * dpi / 72), round(h * dpi / 72)] for w, h in shown] for dpi in (72, 150, 300)},
        'points': {
            '1': [
                {'x': 200 / A4[0], 'y': 175 / A4[1], 'rgb': [255, 0, 0]},
                {'x': 425 / A4[0], 'y': 175 / A4[1], 'rgb': [0, 0, 255]},
                {'x': 0.9, 'y': 0.95, 'rgb': None},
            ],
            '2': [
                {'x': 50 / 792, 'y': 75 / 612, 'rgb': [0, 153, 0]},
                {'x': 0.9, 'y': 0.9, 'rgb': None},
            ],
            '3': [
                {'x': 0.5, 'y': 0.15, 'rgb': [255, 128, 0]},
                {'x': 0.5, 'y': 0.5, 'rgb': [0, 0, 0]},
            ],
        },
        'poppler': {str(p): poppler_grid(p) for p in (1, 2, 3)},
        'jpeg_luma_q': {'50': ijg(50), '95': ijg(95)},
    }
    with open(os.path.join(HERE, 'expected.json'), 'w') as f:
        json.dump(expected, f)
        f.write('\n')
    print(json.dumps({k: expected[k] for k in ('sizes', 'jpeg_luma_q')}))


if __name__ == '__main__':
    main()
