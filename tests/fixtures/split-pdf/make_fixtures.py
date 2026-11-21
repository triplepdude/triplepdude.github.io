#!/usr/bin/env python3
"""Makes the PDFs that tests/tools/split-pdf.test.js splits, and expected.json.

    python3 tests/fixtures/split-pdf/make_fixtures.py

Needs reportlab, pikepdf (qpdf) and Pillow. The output is deterministic.

ten.pdf      10 pages. Pages 1-9 are A4 (595 x 842 pt), page 10 is Letter
             landscape (792 x 612). Page 4 has /Rotate 90. Every page shows
             "Page N" and the marker SPLIT-MARK-NN, and carries its own
             110 x 110 picture of random pixels, which cannot be compressed,
             so the size of a split file shows which pages' pictures it holds.
             Annotations: page 1 links to page 10 (explicit /Dest), page 2
             links to a web address, page 3 has a sticky note whose /P points
             back to page 3, page 5 links to page 6 through the named
             destination "sec6" (/Names /Dests), and page 7 links to page 8
             through a /GoTo action. A plain page copy follows a link to the page it
             points at and copies that page, picture and all, into the new file.
locked.pdf   3 pages, AES-256 (R6), user password "open sesame".
restricted.pdf  2 pages, AES-128 (R4) with an owner password only: it opens
             without a password but forbids copying and changes.
sixty.pdf    60 Letter pages with "Sixty N" on each.
shared.pdf   3 pages that share one resource dictionary holding all three
             pictures, and form fields that are kids of one parent field
             (see make_shared).
damaged.pdf  starts like a PDF but holds no PDF objects.

expected.json gives, per page of ten.pdf, its marker, its size in points, its
/Rotate value and the number of bytes of its picture stream as qpdf stores it,
and the size of each picture stream of shared.pdf.
"""
import io
import json
import os
import random

import pikepdf
from PIL import Image
from reportlab.lib.pagesizes import A4, landscape, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
Name = pikepdf.Name


def noise(seed, size=110):
    r = random.Random(seed)
    img = Image.frombytes('RGB', (size, size), bytes(r.getrandbits(8) for _ in range(size * size * 3)))
    b = io.BytesIO()
    img.save(b, 'PNG')
    b.seek(0)
    return ImageReader(b)


def pages_pdf(count, label, size_of, picture=False, title=None):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    if title:
        c.setTitle(title)
        c.setAuthor('Fixture')
    for i in range(1, count + 1):
        w, h = size_of(i)
        c.setPageSize((w, h))
        c.setFont('Helvetica-Bold', 56)
        c.drawCentredString(w / 2, h / 2, f'{label} {i}')
        c.setFont('Helvetica', 12)
        c.drawString(40, 40, f'SPLIT-MARK-{i:02d}' if picture else f'{label.upper()}-MARK-{i:02d}')
        if picture:
            c.drawImage(noise(1000 + i), 40, 80, 110, 110)
        c.showPage()
    c.save()
    return buf.getvalue()


def annot(pdf, **kw):
    d = pikepdf.Dictionary(Type=Name.Annot, Border=pikepdf.Array([0, 0, 1]), **kw)
    return pdf.make_indirect(d)


def make_ten():
    raw = pages_pdf(10, 'Page', lambda i: landscape(letter) if i == 10 else A4, picture=True, title='Ten pages')
    pdf = pikepdf.open(io.BytesIO(raw))
    p = [pg.obj for pg in pdf.pages]
    p[3].Rotate = 90
    p[0].Annots = pikepdf.Array([annot(pdf, Subtype=Name.Link, Rect=[40, 700, 300, 760],
                                       Dest=pikepdf.Array([p[9], Name.Fit]))])
    p[1].Annots = pikepdf.Array([annot(pdf, Subtype=Name.Link, Rect=[40, 700, 300, 760],
                                       A=pikepdf.Dictionary(S=Name.URI, URI=pikepdf.String('https://example.com/split')))])
    note = annot(pdf, Subtype=Name.Text, Rect=[40, 700, 64, 724], Contents=pikepdf.String('Note on page 3'), Name=Name.Comment)
    note.P = p[2]
    p[2].Annots = pikepdf.Array([note])
    p[4].Annots = pikepdf.Array([annot(pdf, Subtype=Name.Link, Rect=[40, 700, 300, 760], Dest=pikepdf.String('sec6'))])
    pdf.Root.Names = pikepdf.Dictionary(Dests=pikepdf.Dictionary(
        Names=pikepdf.Array([pikepdf.String('sec6'), pikepdf.Array([p[5], Name.XYZ, 0, 842, 0])])))
    p[6].Annots = pikepdf.Array([annot(pdf, Subtype=Name.Link, Rect=[40, 700, 300, 760],
                                       A=pikepdf.Dictionary(S=Name.GoTo, D=pikepdf.Array([p[7], Name.Fit])))])
    pdf.save(os.path.join(HERE, 'ten.pdf'), deterministic_id=True)

    pdf = pikepdf.open(os.path.join(HERE, 'ten.pdf'))
    pages = []
    for i, pg in enumerate(pdf.pages):
        box = [float(v) for v in pg.mediabox]
        images = [len(x.read_raw_bytes()) for x in pg.get_images().values()]
        pages.append({
            'mark': f'SPLIT-MARK-{i + 1:02d}',
            'size': f'{round(box[2] - box[0])}x{round(box[3] - box[1])}',
            'rotate': int(pg.obj.get('/Rotate', 0)),
            'image_bytes': sum(images),
        })
    return {'pages': pages, 'file_bytes': os.path.getsize(os.path.join(HERE, 'ten.pdf'))}


def make_shared():
    """shared.pdf: 3 A4 pages whose resources are one dictionary holding all three pictures, as
    some PDF writers make them. Pages 1 and 2 point at it, page 3 inherits it from the page tree.
    Page 1 draws /Im1, page 2 /Im2, page 3 draws the form /Fm1, which has no resources of its own
    and draws /Im3 from the page's. Page 1 has the form field applicant.name and page 2 the field
    applicant.ssn (value SHARED-SECRET-2), both kids of the field "applicant"; page 1 also has a
    signature field whose value refers to the document catalog (as a DocMDP signature does).
    Written by hand: qpdf would copy the inherited resources into page 3."""
    objs = {}

    def stream(head, data):
        return b'<< ' + head + b' /Length %d >>\nstream\n' % len(data) + data + b'\nendstream'

    objs[1] = b'<< /Type /Catalog /Pages 2 0 R /AcroForm 20 0 R >>'
    objs[2] = b'<< /Type /Pages /Kids [10 0 R 11 0 R 12 0 R] /Count 3 /Resources 3 0 R >>'
    objs[3] = b'<< /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R /Im2 6 0 R /Im3 7 0 R /Fm1 8 0 R >> >>'
    objs[4] = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    for i in range(1, 4):
        r = random.Random(2000 + i)
        data = bytes(r.getrandbits(8) for _ in range(120 * 120 * 3))
        objs[4 + i] = stream(b'/Type /XObject /Subtype /Image /Width 120 /Height 120 /ColorSpace /DeviceRGB /BitsPerComponent 8', data)
    objs[8] = stream(b'/Type /XObject /Subtype /Form /BBox [0 0 200 200]', b'q 200 0 0 200 0 0 cm /Im3 Do Q')
    for i in range(1, 4):
        draw = b'q 200 0 0 200 100 500 cm /Im%d Do Q' % i if i < 3 else b'q 1 0 0 1 100 500 cm /Fm1 Do Q'
        objs[12 + i] = stream(b'', draw + b' BT /F1 14 Tf 100 300 Td (SHARED-MARK-%d) Tj ET' % i)
        res = b' /Resources 3 0 R' if i < 3 else b''
        annots = b' /Annots [17 0 R 19 0 R]' if i == 1 else b' /Annots [18 0 R]' if i == 2 else b''
        objs[9 + i] = b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents %d 0 R%s%s >>' % (12 + i, res, annots)
    objs[16] = b'<< /T (applicant) /FT /Tx /Kids [17 0 R 18 0 R] >>'
    for k, (name, value) in enumerate([(b'name', b'Alice Example'), (b'ssn', b'SHARED-SECRET-2')]):
        objs[21 + k] = stream(b'/Type /XObject /Subtype /Form /BBox [0 0 200 20] /Resources << /Font << /F1 4 0 R >> >>',
                              b'/Tx BMC BT /F1 12 Tf 2 5 Td (' + value + b') Tj ET EMC')
        objs[17 + k] = (b'<< /Type /Annot /Subtype /Widget /T (' + name + b') /V (' + value + b') /Rect [100 200 300 220] /F 4'
                        b' /P %d 0 R /Parent 16 0 R /AP << /N %d 0 R >> >>' % (10 + k, 21 + k))
    objs[19] = (b'<< /Type /Annot /Subtype /Widget /FT /Sig /T (signature) /Rect [0 0 0 0] /F 132 /P 10 0 R'
                b' /V << /Type /Sig /Filter /Adobe.PPKLite /Reference [<< /Type /SigRef /TransformMethod /DocMDP /Data 1 0 R >>] >> >>')
    objs[20] = b'<< /Fields [16 0 R 19 0 R] /DR << /Font << /Helv 4 0 R >> >> >>'
    out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    size = max(objs) + 1
    at = {}
    for n in range(1, size):
        if n in objs:
            at[n] = len(out)
            out += b'%d 0 obj\n' % n + objs[n] + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % size
    for n in range(1, size):
        out += b'%010d 00000 n \n' % at[n] if n in at else b'0000000000 65535 f \n'
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (size, xref)
    with open(os.path.join(HERE, 'shared.pdf'), 'wb') as f:
        f.write(out)
    return {'image_bytes': [120 * 120 * 3] * 3}


def main():
    expected = {'ten': make_ten(), 'shared': make_shared()}

    raw = pages_pdf(3, 'Locked', lambda i: A4)
    with pikepdf.open(io.BytesIO(raw)) as pdf:
        pdf.save(os.path.join(HERE, 'locked.pdf'), static_id=True,
                 encryption=pikepdf.Encryption(user='open sesame', owner='owner secret', R=6))

    raw = pages_pdf(2, 'Restricted', lambda i: A4)
    with pikepdf.open(io.BytesIO(raw)) as pdf:
        pdf.save(os.path.join(HERE, 'restricted.pdf'), static_id=True,
                 encryption=pikepdf.Encryption(user='', owner='owner secret', R=4,
                                               allow=pikepdf.Permissions(extract=False, modify_other=False)))

    with open(os.path.join(HERE, 'sixty.pdf'), 'wb') as f:
        f.write(pages_pdf(60, 'Sixty', lambda i: letter))

    with open(os.path.join(HERE, 'damaged.pdf'), 'wb') as f:
        f.write(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n' + bytes(random.Random(7).getrandbits(8) for _ in range(3000)))

    with open(os.path.join(HERE, 'expected.json'), 'w') as f:
        json.dump(expected, f, indent=1)
        f.write('\n')
    print(json.dumps(expected)[:400])


if __name__ == '__main__':
    main()
