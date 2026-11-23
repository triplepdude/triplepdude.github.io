#!/usr/bin/env python3
"""Makes the PDFs that tests/tools/rotate-pdf.test.js opens, and expected.json.

    python3 tests/fixtures/rotate-pdf/make_fixtures.py

Needs pikepdf (qpdf), pyHanko and cryptography. AES IVs, salts and the signing
key are random, so the bytes differ from run to run; pages, passwords and
structure do not. Every value in expected.json is read back with pikepdf.

mixed.pdf          6 pages of mixed sizes, classic cross-reference table whose
                   trailer has /DocChecksum and a /Size two above the last object:
                   1 A4, tagged (a /P structure element), links to page 5 and to
                     a web address, a short vertical label among many lines of
                     upright text;
                   2 Letter landscape, its text upside down, a filled text field;
                   3 A4 with /Rotate 90 and a sticky note kept in its /Annots;
                   4 A4 inheriting /Rotate 270 from a /Pages node;
                   5 A4 in the same node with its own /Rotate 450 (read as 90);
                   6 MediaBox 400x600, CropBox 300x500, /UserUnit 2, its text
                     running from bottom to top (sideways).
                   Bookmarks to pages 1 and 4, an attached file, document info.
                   Each page carries the marker ROT-MARK-0n.
mixed-objstm.pdf   the same, PDF 2.0 with object streams and a cross-reference
                   stream, two numbers past the object stream's.
linearized.pdf     the same, linearised (fast web view).
updated.pdf        mixed.pdf plus an incremental update by hand that gives page
                   1 /Rotate 180, so its rotation comes from the second revision.
hybrid.pdf         2 pages, a hybrid-reference file (classic table whose trailer
                   has /XRefStm), with the page objects in an object stream.
enc-*.pdf          3 A4 pages; page 2 holds a sticky note (/Contents and /T
                   strings) directly in its /Annots, so a rewritten page has
                   strings to encrypt. Open password "open sesame", permissions
                   password "owner secret":
                   enc-rc4-40.pdf (R2), enc-rc4-128.pdf (R3), enc-aes-128.pdf
                   (R4), enc-aes-256.pdf (R6, mixed.pdf's content, classic table),
                   enc-aes-256-objstm.pdf (R6, object streams).
no-assembly.pdf    AES-256, opens without a password; changes and page assembly
                   are forbidden (bits 4 and 11 clear), so rotating needs "owner
                   secret".
assembly-only.pdf  AES-128, opens without a password; changes are forbidden but
                   page assembly is allowed (bit 4 clear, bit 11 set).
no-modify-r2.pdf   RC4 40-bit (R2, which has no bit 11), opens without a password,
                   changes forbidden (bit 4 clear), so rotating needs "owner secret".
restricted.pdf     AES-128, opens without a password; printing and copying are
                   forbidden, assembly is allowed.
pdfdoc-password.pdf  AES-128, open password "café€" (PDFDocEncoding 63 61 66 E9 A0).
utf8-password.pdf  AES-256, open password "パスワード１２３" in UTF-8.
enc-badxref.pdf    enc-aes-128.pdf with every offset in its table off by 3.
signed.pdf         2 pages with an approval signature (pyHanko, self-signed key)
                   added as an incremental update.
certified.pdf      2 pages certified with DocMDP /P 2 (form filling only).
cut.pdf            mixed.pdf cut off after its trailer, before startxref and %%EOF.
truncated.pdf      the first 60% of mixed.pdf, as an interrupted download leaves it.
garbage.pdf        mixed.pdf with 300 bytes of garbage inserted between two
                   objects, so every later offset is wrong.
badxref.pdf        mixed.pdf with every offset in its table off by 7.
"""
import datetime
import hashlib
import io
import json
import os
import random
import re
import zlib

import pikepdf

HERE = os.path.dirname(os.path.abspath(__file__))
OPEN, OWNER = 'open sesame', 'owner secret'
random.seed(47)


def path(name):
    return os.path.join(HERE, name)


class Raw:
    """A PDF written object by object, with a classic cross-reference table."""

    def __init__(self):
        self.objs = []

    def new(self):
        self.objs.append(None)
        return len(self.objs)

    def put(self, n, body):
        self.objs[n - 1] = body if isinstance(body, bytes) else body.encode('latin-1')

    def add(self, body):
        n = self.new()
        self.put(n, body)
        return n

    def stream(self, data, extra=''):
        if isinstance(data, str):
            data = data.encode('latin-1')
        z = zlib.compress(data, 9)
        return self.add(b'<< /Length %d /Filter /FlateDecode %s >>\nstream\n' % (len(z), extra.encode()) + z + b'\nendstream')

    def ident(self):
        h = hashlib.md5(b''.join(o for o in self.objs)).hexdigest().upper()
        return '/ID [<%s> <%s>]' % (h, h)

    def bytes(self, root, info=None, version='1.7', free=0, extra=''):
        """free: unused object numbers after the last object (deleted objects leave them), so the
        trailer's /Size is larger than pdf-lib's count; extra: more trailer entries."""
        out = bytearray(b'%PDF-' + version.encode() + b'\n%\xe2\xe3\xcf\xd3\n')
        offs = []
        for i, body in enumerate(self.objs):
            offs.append(len(out))
            out += b'%d 0 obj\n' % (i + 1) + body + b'\nendobj\n'
        x = len(out)
        size = len(self.objs) + 1 + free
        out += b'xref\n0 %d\n0000000000 65535 f \n' % size
        for o in offs:
            out += b'%010d 00000 n \n' % o
        out += b'0000000000 00001 f \n' * free
        tr = '<< /Size %d /Root %d 0 R' % (size, root) + (' /Info %d 0 R' % info if info else '') + ' ' + self.ident() + extra + ' >>'
        out += b'trailer\n' + tr.encode() + b'\nstartxref\n%d\n%%%%EOF\n' % x
        return bytes(out)

    def bytes_objstm(self, root, info=None, version='2.0'):
        """Streams at the top level, every other object in one object stream, and a
        cross-reference stream compressed with the PNG Up predictor, as most writers do."""
        out = bytearray(b'%PDF-' + version.encode() + b'\n%\xe2\xe3\xcf\xd3\n')
        n_all = len(self.objs)
        packed = [i + 1 for i, b in enumerate(self.objs) if b'stream\n' not in b]
        stm = n_all + 1
        head, body = [], bytearray()
        for k in packed:
            head.append('%d %d' % (k, len(body)))
            body += self.objs[k - 1] + b'\n'
        head = (' '.join(head) + '\n').encode()
        z = zlib.compress(head + bytes(body), 9)
        entries = {0: (0, 0, 255)}
        for i, b in enumerate(self.objs):
            if i + 1 not in packed:
                entries[i + 1] = (1, len(out), 0)
                out += b'%d 0 obj\n' % (i + 1) + b + b'\nendobj\n'
        entries[stm] = (1, len(out), 0)
        out += b'%d 0 obj\n<< /Type /ObjStm /N %d /First %d /Filter /FlateDecode /Length %d >>\nstream\n' % (stm, len(packed), len(head), len(z)) + z + b'\nendstream\nendobj\n'
        for idx, k in enumerate(packed):
            entries[k] = (2, stm, idx)
        # Two unused numbers between the object stream and the cross-reference stream: pdf-lib counts
        # neither stream, so its count falls short of /Size by four.
        entries[stm + 1] = entries[stm + 2] = (0, 0, 1)
        xnum = stm + 3
        entries[xnum] = (1, len(out), 0)
        size = xnum + 1
        rows = bytearray()
        prev = bytes(5)
        for k in range(size):
            t, f2, f3 = entries[k]
            row = bytes([t]) + f2.to_bytes(3, 'big') + bytes([f3])
            rows += b'\x02' + bytes((row[j] - prev[j]) & 255 for j in range(5))
            prev = row
        zx = zlib.compress(bytes(rows), 9)
        x = entries[xnum][1]
        d = ('<< /Type /XRef /Size %d /W [1 3 1] /Root %d 0 R' % (size, root) + (' /Info %d 0 R' % info if info else '') +
             ' %s /Filter /FlateDecode /DecodeParms << /Columns 5 /Predictor 12 >> /Length %d >>' % (self.ident(), len(zx)))
        out += b'%d 0 obj\n' % xnum + d.encode() + b'\nstream\n' + zx + b'\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n' % x
        return bytes(out)


def text_block(lines, x, y, size=14, lead=20, font='F1'):
    s = 'BT /%s %d Tf %d TL %d %d Td\n' % (font, size, lead, x, y)
    for ln in lines:
        s += '(%s) Tj T*\n' % ln
    return s + 'ET\n'


FILLER = ['The quick brown fox jumps over the lazy dog, line %d.' % i for i in range(1, 13)]


def mixed():
    r = Raw()
    cat, pages, node = r.new(), r.new(), r.new()
    f1 = r.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    f2 = r.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
    res = '<< /Font << /F1 %d 0 R /F2 %d 0 R >> >>' % (f1, f2)
    p = [r.new() for _ in range(6)]

    # Page 1: A4, tagged paragraph, two links, a vertical label among upright lines.
    c1 = ('/P << /MCID 0 >> BDC\n' + text_block(['ROT-MARK-01 Portrait A4'] + FILLER, 60, 760) + 'EMC\n'
          'q 0 1 -1 0 40 300 cm BT /F1 9 Tf 0 0 Td (axis) Tj ET Q\n'
          'BT /F2 120 Tf 250 200 Td (1) Tj ET\n')
    s1 = r.stream(c1)
    link_p5 = r.new()
    link_web = r.add('<< /Type /Annot /Subtype /Link /Rect [60 740 300 762] /Border [0 0 0] '
                     '/A << /S /URI /URI (https://example.com/rotate) >> >>')
    st_root, st_doc, st_p, ptree = r.new(), r.new(), r.new(), r.new()
    r.put(p[0], '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources %s /Contents %d 0 R '
          '/Annots [%d 0 R %d 0 R] /StructParents 0 >>' % (pages, res, s1, link_p5, link_web))
    r.put(link_p5, '<< /Type /Annot /Subtype /Link /Rect [60 700 300 722] /Border [0 0 0] /Dest [%d 0 R /Fit] >>' % p[4])
    r.put(st_root, '<< /Type /StructTreeRoot /K %d 0 R /ParentTree %d 0 R /ParentTreeNextKey 1 >>' % (st_doc, ptree))
    r.put(st_doc, '<< /Type /StructElem /S /Document /P %d 0 R /K [%d 0 R] >>' % (st_root, st_p))
    r.put(st_p, '<< /Type /StructElem /S /P /P %d 0 R /Pg %d 0 R /K 0 >>' % (st_doc, p[0]))
    r.put(ptree, '<< /Nums [0 [%d 0 R]] >>' % st_p)

    # Page 2: Letter landscape, upside-down text, a filled text field.
    c2 = 'q -1 0 0 -1 792 612 cm\n' + text_block(['ROT-MARK-02 Upside down'] + FILLER[:8], 60, 540) + 'Q\n'
    s2 = r.stream(c2)
    ap = r.stream('/Tx BMC q BT /F1 12 Tf 2 8 Td (Ada) Tj ET Q EMC', '/Type /XObject /Subtype /Form /BBox [0 0 228 30] /Resources %s' % res)
    widget = r.new()
    r.put(widget, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ada) /Rect [72 300 300 330] /F 4 '
          '/P %d 0 R /DA (/F1 12 Tf 0 g) /AP << /N %d 0 R >> >>' % (p[1], ap))
    r.put(p[1], '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 792 612] /Resources %s /Contents %d 0 R /Annots [%d 0 R] >>'
          % (pages, res, s2, widget))

    # Page 3: /Rotate 90, a sticky note directly in /Annots.
    s3 = r.stream(text_block(['ROT-MARK-03 Rotate 90'] + FILLER[:6], 60, 760))
    r.put(p[2], '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Rotate 90 /Resources %s /Contents %d 0 R '
          '/Annots [<< /Type /Annot /Subtype /Text /Rect [500 780 520 800] /Contents (Note on page 3) /T (Tester) /F 4 >>] >>'
          % (pages, res, s3))

    # Pages 4 and 5 sit in a /Pages node with /Rotate 270; page 5 has its own /Rotate 450.
    s4 = r.stream(text_block(['ROT-MARK-04 Inherited 270'] + FILLER[:6], 60, 760))
    r.put(p[3], '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources %s /Contents %d 0 R >>' % (node, res, s4))
    s5 = r.stream(text_block(['ROT-MARK-05 Rotate 450'] + FILLER[:6], 60, 760))
    r.put(p[4], '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Rotate 450 /Resources %s /Contents %d 0 R >>' % (node, res, s5))
    r.put(node, '<< /Type /Pages /Parent %d 0 R /Kids [%d 0 R %d 0 R] /Count 2 /Rotate 270 >>' % (pages, p[3], p[4]))

    # Page 6: CropBox inside the MediaBox, UserUnit 2, text from bottom to top.
    c6 = 'q 0 1 -1 0 300 60 cm\n' + text_block(['ROT-MARK-06 Sideways'] + FILLER[:8], 0, 0, size=11, lead=15) + 'Q\n'
    s6 = r.stream(c6)
    r.put(p[5], '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 400 600] /CropBox [36 36 336 536] /UserUnit 2 '
          '/Resources %s /Contents %d 0 R >>' % (pages, res, s6))

    r.put(pages, '<< /Type /Pages /Kids [%d 0 R %d 0 R %d 0 R %d 0 R %d 0 R] /Count 6 >>' % (p[0], p[1], p[2], node, p[5]))

    o_root, o1, o2 = r.new(), r.new(), r.new()
    r.put(o_root, '<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count 2 >>' % (o1, o2))
    r.put(o1, '<< /Title (Start) /Parent %d 0 R /Next %d 0 R /Dest [%d 0 R /Fit] >>' % (o_root, o2, p[0]))
    r.put(o2, '<< /Title (Inherited page) /Parent %d 0 R /Prev %d 0 R /Dest [%d 0 R /Fit] >>' % (o_root, o1, p[3]))

    att = r.stream('ROT attachment, kept as it is.\n', '/Type /EmbeddedFile /Subtype /text#2Fplain')
    fs = r.add('<< /Type /Filespec /F (note.txt) /UF (note.txt) /EF << /F %d 0 R >> >>' % att)
    form = '<< /Fields [%d 0 R] /DA (/F1 0 Tf 0 g) /DR << /Font << /F1 %d 0 R >> >> >>' % (widget, f1)
    r.put(cat, '<< /Type /Catalog /Pages %d 0 R /Outlines %d 0 R /PageMode /UseOutlines /AcroForm %s '
          '/StructTreeRoot %d 0 R /MarkInfo << /Marked true >> /Lang (en-GB) '
          '/Names << /EmbeddedFiles << /Names [(note.txt) %d 0 R] >> >> >>' % (pages, o_root, form, st_root, fs))
    info = r.add('<< /Title (Rotate test) /Author (TripleP Tools tests) /Producer (make_fixtures.py) >>')
    return r, cat, info


def small(label, note=True):
    r = Raw()
    cat, pages = r.new(), r.new()
    f1 = r.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    res = '<< /Font << /F1 %d 0 R >> >>' % f1
    kids = []
    for i in range(1, 4):
        s = r.stream(text_block(['%s-MARK-%02d' % (label.upper(), i), '%s page %d' % (label, i)] + FILLER[:4], 60, 760))
        annots = (' /Annots [<< /Type /Annot /Subtype /Text /Rect [500 780 520 800] /Contents (Secret note %d) /T (Tester) /F 4 >>]' % i
                  if note and i == 2 else '')
        kids.append(r.add('<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources %s /Contents %d 0 R%s >>' % (pages, res, s, annots)))
    r.put(pages, '<< /Type /Pages /Kids [%s] /Count 3 >>' % ' '.join('%d 0 R' % k for k in kids))
    r.put(cat, '<< /Type /Catalog /Pages %d 0 R >>' % pages)
    info = r.add('<< /Title (%s) >>' % label)
    return r.bytes(cat, info)


def save(data, name, **kw):
    kw.setdefault('static_id', True)
    with pikepdf.open(io.BytesIO(data)) as pdf:
        pdf.save(path(name), **kw)


def classic(**kw):
    return dict(object_stream_mode=pikepdf.ObjectStreamMode.disable, **kw)


def enc(R, user=OPEN, owner=OWNER, allow=None, aes=True):
    # R2 and R3 always encrypt the metadata; pikepdf wants that said.
    # pikepdf forbids page assembly unless told otherwise.
    return pikepdf.Encryption(user=user, owner=owner, R=R, aes=aes, allow=allow or pikepdf.Permissions(modify_assembly=True),
                              metadata=R >= 4)


def last_startxref(data):
    return int(re.findall(rb'startxref\s+(\d+)', data)[-1])


def append_update(data, objects, trailer_extra=b''):
    """Appends an update section with a classic table (objects: {num: body})."""
    out = bytearray(data)
    if not out.endswith(b'\n'):
        out += b'\n'
    offs = {}
    for n, body in sorted(objects.items()):
        offs[n] = len(out)
        out += b'%d 0 obj\n' % n + body + b'\nendobj\n'
    x = len(out)
    out += b'xref\n'
    for n in sorted(offs):
        out += b'%d 1\n%010d 00000 n \n' % (n, offs[n])
    size = int(re.findall(rb'/Size\s+(\d+)', data)[-1])
    root = re.findall(rb'/Root\s+(\d+ \d+ R)', data)[-1]
    out += b'trailer\n<< /Size %d /Root %s%s /Prev %d >>\nstartxref\n%d\n%%%%EOF\n' % (size, root, trailer_extra, last_startxref(data), x)
    return bytes(out)


def updated():
    data = open(path('mixed.pdf'), 'rb').read()
    with pikepdf.open(path('mixed.pdf')) as pdf:
        pg = pdf.pages[0].obj
        num = pg.objgen[0]
        body = pg.unparse(resolved=True)  # the page dictionary itself, not its reference
    body = body.replace(b'/Type /Page', b'/Type /Page /Rotate 180', 1) if b'/Type /Page' in body else body[:-2] + b' /Rotate 180 >>'
    info = re.findall(rb'/Info\s+(\d+ \d+ R)', data)[-1]
    ids = re.findall(rb'/ID\s*(\[[^\]]*\])', data)[-1]
    return append_update(data, {num: body}, b' /Info ' + info + b' /ID ' + ids)


def hybrid():
    """Pages 3 and 4 (the page objects) in an object stream that only the /XRefStm stream lists."""
    font = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
    contents = [b'BT /F1 24 Tf 72 700 Td (HYBRID-MARK-0%d) Tj ET' % i for i in (1, 2)]
    out = bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')
    offs = {}

    def obj(n, body):
        offs[n] = len(out)
        out.extend(b'%d 0 obj\n' % n + body + b'\nendobj\n')
    obj(1, b'<< /Type /Catalog /Pages 2 0 R >>')
    obj(2, b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>')
    obj(5, font)
    obj(6, b'<< /Length %d >>\nstream\n' % len(contents[0]) + contents[0] + b'\nendstream')
    obj(7, b'<< /Length %d >>\nstream\n' % len(contents[1]) + contents[1] + b'\nendstream')
    p3 = b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'
    p4 = b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>'
    head = b'3 0 4 %d ' % (len(p3) + 1)
    first = len(head)
    body = head + p3 + b' ' + p4
    z = zlib.compress(body)
    obj(8, b'<< /Type /ObjStm /N 2 /First %d /Length %d /Filter /FlateDecode >>\nstream\n' % (first, len(z)) + z + b'\nendstream')
    # The /XRefStm stream: objects 3 and 4 in object stream 8, and itself.
    xs_num = 9
    xs_off = len(out)
    rows = bytes([2, 0, 8, 0, 2, 0, 8, 1])  # W [1 2 1]: type, stream number, index
    rows += bytes([1]) + xs_off.to_bytes(2, 'big') + b'\x00'
    xs = b'<< /Type /XRef /Size 10 /W [1 2 1] /Index [3 2 9 1] /Length %d >>\nstream\n' % len(rows) + rows + b'\nendstream'
    assert xs_off < 65536
    obj(xs_num, xs)
    x = len(out)
    # Objects 3 and 4 are left out of the table: readers that know /XRefStm find them there.
    out += b'xref\n0 3\n0000000000 65535 f \n'
    for n in (1, 2):
        out += b'%010d 00000 n \n' % offs[n]
    out += b'5 5\n'
    for n in range(5, 10):
        out += b'%010d 00000 n \n' % offs[n]
    ident = hashlib.md5(b'hybrid').hexdigest().upper().encode()
    out += b'trailer\n<< /Size 10 /Root 1 0 R /XRefStm %d /ID [<%s><%s>] >>\nstartxref\n%d\n%%%%EOF\n' % (xs_off, ident, ident, x)
    return bytes(out)


def sign(base_name, out_name, certify):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.sign.fields import MDPPerm
    from asn1crypto import keys as asn1keys, x509 as asn1x509

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Rotate PDF test signer')])
    now = datetime.datetime(2026, 11, 1, tzinfo=datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(4747).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.KeyUsage(True, True, False, False, False, True, True, False, False), critical=True)
            .sign(key, hashes.SHA256()))
    der_key = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    signer = signers.SimpleSigner(signing_cert=asn1x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER)),
                                  signing_key=asn1keys.PrivateKeyInfo.load(der_key), cert_registry=None)
    with open(path(base_name), 'rb') as f:
        w = IncrementalPdfFileWriter(f)
        fields.append_signature_field(w, fields.SigFieldSpec(sig_field_name='Signature1', on_page=0, box=(60, 60, 260, 120)))
        meta = signers.PdfSignatureMetadata(field_name='Signature1', certify=certify, docmdp_permissions=MDPPerm.FILL_FORMS,
                                            reason='Testing', md_algorithm='sha256')
        out = io.BytesIO()
        signers.sign_pdf(w, meta, signer=signer, output=out)
    with open(path(out_name), 'wb') as f:
        f.write(out.getvalue())


def shift_xref(data, by):
    x = last_startxref(data)
    head, table = data[:x], data[x:]
    def bump(m):
        return b'%010d %s n' % (int(m.group(1)) + by, m.group(2))
    return head + re.sub(rb'(\d{10}) (\d{5}) n', bump, table)


def facts(name, password=''):
    """Per page: effective rotation (inherited and normalised as PDF.js does), size, marker."""
    with pikepdf.open(path(name), password=password) as pdf:
        out = []
        for pg in pdf.pages:
            node, rot = pg.obj, 0
            while node is not None:
                if '/Rotate' in node:
                    rot = int(node.Rotate)
                    break
                node = node.get('/Parent')
            rot = 0 if rot % 90 else rot % 360
            box = [float(v) for v in (pg.obj.get('/CropBox') or pg.obj.get('/MediaBox') or pg.MediaBox)]
            out.append({'rotate': rot, 'width': round(box[2] - box[0], 2), 'height': round(box[3] - box[1], 2),
                        'ref': list(pg.obj.objgen)})
        return out


def main():
    # qpdf moves an inherited /Rotate down to the pages when it writes a file, so the files
    # that keep it in the /Pages node are written here directly.
    r, cat, info = mixed()
    data = r.bytes(cat, info, free=2, extra=' /DocChecksum /2C17C14E2CF79E1BD5C0E5A5AFE65FA9')
    with open(path('mixed.pdf'), 'wb') as f:
        f.write(data)
    with open(path('mixed-objstm.pdf'), 'wb') as f:
        f.write(r.bytes_objstm(cat, info))
    save(data, 'linearized.pdf', linearize=True)
    with open(path('updated.pdf'), 'wb') as f:
        f.write(updated())
    with open(path('hybrid.pdf'), 'wb') as f:
        f.write(hybrid())

    base = small('Enc')
    save(base, 'enc-rc4-40.pdf', **classic(encryption=enc(2, aes=False)))
    save(base, 'enc-rc4-128.pdf', **classic(encryption=enc(3, aes=False)))
    save(base, 'enc-aes-128.pdf', **classic(encryption=enc(4)))
    save(data, 'enc-aes-256.pdf', **classic(encryption=enc(6)))
    save(data, 'enc-aes-256-objstm.pdf', object_stream_mode=pikepdf.ObjectStreamMode.generate, encryption=enc(6))
    save(small('Locked'), 'no-assembly.pdf', **classic(encryption=enc(6, user='', allow=pikepdf.Permissions(
        modify_assembly=False, modify_other=False))))
    save(small('Restricted'), 'restricted.pdf', **classic(encryption=enc(4, user='', allow=pikepdf.Permissions(
        print_lowres=False, print_highres=False, extract=False, modify_assembly=True))))
    save(small('Assembly'), 'assembly-only.pdf', **classic(encryption=enc(4, user='', allow=pikepdf.Permissions(
        modify_other=False, modify_assembly=True))))
    save(small('Nomodify'), 'no-modify-r2.pdf', **classic(encryption=enc(2, user='', aes=False, allow=pikepdf.Permissions(
        modify_other=False, modify_assembly=False))))
    save(small('PDFDoc', note=False), 'pdfdoc-password.pdf', **classic(encryption=enc(4, user='café€')))
    save(small('Unicode', note=False), 'utf8-password.pdf', **classic(encryption=enc(6, user='パスワード１２３')))
    with open(path('enc-badxref.pdf'), 'wb') as f:
        f.write(shift_xref(open(path('enc-aes-128.pdf'), 'rb').read(), 3))

    save(small('Signed', note=False), 'sign-base.pdf', **classic())
    sign('sign-base.pdf', 'signed.pdf', certify=False)
    sign('sign-base.pdf', 'certified.pdf', certify=True)
    os.remove(path('sign-base.pdf'))

    m = open(path('mixed.pdf'), 'rb').read()
    with open(path('cut.pdf'), 'wb') as f:
        f.write(m[:m.rindex(b'startxref')])
    with open(path('truncated.pdf'), 'wb') as f:
        f.write(m[:len(m) * 6 // 10])
    cut_at = m.index(b'\nendobj\n', len(m) // 3) + 8
    with open(path('garbage.pdf'), 'wb') as f:
        f.write(m[:cut_at] + bytes(random.randrange(256) for _ in range(300)) + b'\n' + m[cut_at:])
    with open(path('badxref.pdf'), 'wb') as f:
        f.write(shift_xref(m, 7))

    expected = {
        'mixed': facts('mixed.pdf'),
        'mixed-objstm': facts('mixed-objstm.pdf'),
        'linearized': facts('linearized.pdf'),
        'updated': facts('updated.pdf'),
        'hybrid': facts('hybrid.pdf'),
        'enc-aes-128': facts('enc-aes-128.pdf', OPEN),
        'signed': facts('signed.pdf'),
    }
    with open(path('expected.json'), 'w') as f:
        json.dump(expected, f, indent=1)
    for fn in sorted(os.listdir(HERE)):
        if fn.endswith('.pdf'):
            print(f'{fn:28s} {os.path.getsize(path(fn)):8d} bytes')


if __name__ == '__main__':
    main()
