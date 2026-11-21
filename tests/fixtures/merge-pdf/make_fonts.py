#!/usr/bin/env python3
"""Makes fonts.pdf, which tests/tools/merge-pdf.test.js shows as a thumbnail.

    python3 tests/fixtures/merge-pdf/make_fonts.py

Needs reportlab. The output is deterministic.

fonts.pdf  one A4 page with what PDF.js can only draw with files it fetches from
           assets/vendor/pdfjs-resources/: Japanese in HeiseiMin-W3 with the
           predefined CMap UniJIS-UCS2-H (not embedded) at the top, a tick, a
           cross and a square in ZapfDingbats (not embedded) below it, and a
           rectangle filled with the DeviceCMYK colour 1 0 0 0 (cyan), which
           PDF.js converts with the CMYK profile.

ten.pdf and shared.pdf are copies of the fixtures in tests/fixtures/split-pdf/,
made by its make_fixtures.py.
"""
import io
import os

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setFont('HeiseiMin-W3', 40)
    c.drawString(60, 700, '日本語のテキスト')
    c.setFont('ZapfDingbats', 40)
    c.drawString(60, 600, '✔ ✘ ■')
    c.setFillColorCMYK(1, 0, 0, 0)
    c.rect(60, 300, 200, 150, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    c.setFont('Helvetica', 20)
    c.drawString(60, 200, 'Fonts 1')
    c.showPage()
    c.save()
    with open(os.path.join(HERE, 'fonts.pdf'), 'wb') as f:
        f.write(buf.getvalue())


if __name__ == '__main__':
    main()
