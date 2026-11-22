#!/usr/bin/env python3
"""Makes the two PDFs with non-ASCII open passwords that tests/tools/merge-pdf.test.js opens.

    python3 tests/fixtures/merge-pdf/make_passwords.py

Needs reportlab and pikepdf (qpdf). The AES IVs and salts are random, so the
AES-256 file differs from run to run; its pages and password do not.

pdfdoc-password.pdf  2 A4 pages, "PDFDoc 1" and "PDFDoc 2" with the markers
                     PDFDOC-MARK-01 and 02. RC4 128-bit (R3), open password "café€".
                     R2 to R4 keep a password in PDFDocEncoding, and pikepdf
                     writes it so: 63 61 66 E9 A0 (€ is 0xA0 there). PDF.js, and
                     the unlocker before it was shared, took the low byte of each
                     character instead (0xAC for €), so neither opened this file.
utf8-password.pdf    2 A4 pages, "Unicode 1" and "Unicode 2" with the markers
                     UNICODE-MARK-01 and 02. AES-256 (R6), open password
                     "パスワード１２３": "password123" typed with a Japanese input
                     method, which gives full-width digits. pikepdf (qpdf) keeps
                     it in UTF-8 as typed. The unlocker before it was shared tried
                     only the NFKC form ("パスワード123", the normalisation of
                     SASLprep), while PDF.js also tries the password as typed: the
                     file opened on screen, and merging it then failed.

Both files have the permissions password "owner secret". After writing each one
the script checks the password bytes it holds. tests/fixtures/split-pdf/ has
the same two files with AES-128 (R4) for the first.
"""
import hashlib
import io
import os
import struct
import unicodedata

import pikepdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OWNER = 'owner secret'
PDFDOC = 'café€'
PDFDOC_BYTES = b'caf\xe9\xa0'
UTF8 = 'パスワード１２３'
PAD = bytes.fromhex('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a')


def pages(label, count=2):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    for i in range(1, count + 1):
        c.setFont('Helvetica-Bold', 56)
        c.drawCentredString(A4[0] / 2, A4[1] / 2, f'{label} {i}')
        c.setFont('Helvetica', 12)
        c.drawString(40, 40, f'{label.upper()}-MARK-{i:02d}')
        c.showPage()
    c.save()
    return buf.getvalue()


def save(name, label, encryption):
    path = os.path.join(HERE, name)
    with pikepdf.open(io.BytesIO(pages(label))) as pdf:
        pdf.save(path, static_id=True, encryption=encryption)
    return path


def opens(path, password):
    try:
        pikepdf.open(path, password=password).close()
        return True
    except pikepdf.PasswordError:
        return False


def rc4(key, data):
    s, j = list(range(256)), 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 255
        s[i], s[j] = s[j], s[i]
    out, i, j = bytearray(), 0, 0
    for b in data:
        i = (i + 1) & 255
        j = (j + s[i]) & 255
        s[i], s[j] = s[j], s[i]
        out.append(b ^ s[(s[i] + s[j]) & 255])
    return bytes(out)


def is_user_password(path, pw):
    """ISO 32000-1 Algorithms 2 and 5 (R3 and R4), worked out here rather than by qpdf."""
    with pikepdf.open(path, password=OWNER) as pdf:
        enc, id0 = pdf.trailer.Encrypt, bytes(pdf.trailer.ID[0])
        o, u, p, r = bytes(enc.O), bytes(enc.U), int(enc.P), int(enc.R)
        n = int(enc.get('/Length', 40)) // 8
        data = (pw + PAD)[:32] + o[:32] + struct.pack('<i', p) + id0
        if r >= 4 and not bool(enc.get('/EncryptMetadata', True)):
            data += b'\xff\xff\xff\xff'
        key = hashlib.md5(data).digest()[:n]
        for _ in range(50):
            key = hashlib.md5(key).digest()[:n]
        x = rc4(key, hashlib.md5(PAD + id0).digest())
        for i in range(1, 20):
            x = rc4(bytes(k ^ i for k in key), x)
        return x == u[:16]


def main():
    path = save('pdfdoc-password.pdf', 'PDFDoc',
                pikepdf.Encryption(user=PDFDOC, owner=OWNER, R=3, aes=False, metadata=False))
    low = bytes(ord(c) & 0xFF for c in PDFDOC)
    assert is_user_password(path, PDFDOC_BYTES), 'the password is kept in PDFDocEncoding'
    assert not is_user_password(path, PDFDOC.encode('utf-8')) and not is_user_password(path, low)
    with pikepdf.open(path, password=OWNER) as pdf:
        assert pdf.encryption.R == 3 and pdf.encryption.bits == 128 and pdf.encryption.user_password == PDFDOC_BYTES
    assert opens(path, PDFDOC_BYTES) and not opens(path, PDFDOC.encode('utf-8')) and not opens(path, low)

    path = save('utf8-password.pdf', 'Unicode', pikepdf.Encryption(user=UTF8, owner=OWNER, R=6))
    nfkc = unicodedata.normalize('NFKC', UTF8)
    assert nfkc != UTF8
    assert opens(path, UTF8.encode('utf-8')), 'the password is kept in UTF-8 as typed'
    assert not opens(path, nfkc.encode('utf-8')), 'not in its NFKC form'
    with pikepdf.open(path, password=OWNER) as pdf:
        assert pdf.encryption.R == 6

    for name in ('pdfdoc-password.pdf', 'utf8-password.pdf'):
        print(name, os.path.getsize(os.path.join(HERE, name)), 'bytes')


if __name__ == '__main__':
    main()
