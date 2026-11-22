#!/usr/bin/env python3
"""Makes the PDFs that tests/tools/unlock-pdf.test.js unlocks, and expected.json.

    python3 tests/fixtures/unlock-pdf/make_fixtures.py

Needs reportlab and pikepdf (libqpdf). Every encrypted file is written by qpdf
from the same two-page document, which has a bookmark per page, a filled-in
text field, an attached file (notes.txt), the title "Unlock test", XMP metadata
on the catalogue and on page 1, and the markers UNLOCK-MARK-01 and -02. The
encryption uses random salts, so the files differ from run to run; the values
in expected.json do not.

  plain.pdf            not encrypted
  r6-open.pdf          AES-256 (R6), open password "open sesame", nothing restricted
  r6-both.pdf          AES-256, open "open sesame", permissions "owner pass": no printing, no copying
  r6-same.pdf          AES-256, "same pass" for both, no printing
  r6-restricted.pdf    AES-256, no open password, permissions "owner pass": no copying, no changes
  r6-blank-owner.pdf   AES-256, open "open sesame", blank permissions password
  r6-cyrillic.pdf      AES-256, open "пароль€" (UTF-8), nothing restricted
  r6-empty.pdf         AES-256 with no open password and nothing restricted: encrypted, but
                       guarding nothing
  r5.pdf               AES-256 (R5, deprecated), open "open sesame", permissions "owner pass": no printing
  r4-aes-nometa.pdf    AES-128 (R4), open "open sesame", permissions "owner pass": no copying;
                       the catalogue's XMP is not encrypted (EncryptMetadata false)
  r4-rc4.pdf           RC4 128-bit (R4), open "open sesame", nothing restricted
  r3.pdf               RC4 128-bit (R3), open "é€" (PDFDocEncoding), permissions "owner pass":
                       low-quality printing only
  r2.pdf               RC4 40-bit (R2), open "open sesame" and no permissions password, so the
                       open password is both (ISO 32000-1 Algorithm 3); no printing
  signed.pdf           AES-256, no open password, permissions "owner pass": no changes; a
                       signature field whose /Contents is never encrypted
  r6-objstm.pdf        AES-256 with object streams and a cross-reference stream, as most PDF
                       writers now save: open "open sesame", permissions "owner pass": no printing
  r4-objstm.pdf        AES-128 with object streams: open "open sesame", permissions "owner pass":
                       no copying
  attachments-only.pdf /StmF and /StrF /Identity with /EFF: only attachments are encrypted
  crypt-filter.pdf     AES-128 file with one stream that has its own /Crypt filter
  certificate.pdf      /Filter /Adobe.PubSec (certificate security)
  drm.pdf              /Filter /FOPN_foweb (a rights-management plug-in)
  damaged.pdf          starts like a PDF but holds no PDF objects
"""
import io
import json
import os

import pikepdf
from pikepdf import Array, Dictionary, Encryption, Name, Permissions, String
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
SIG_HEX = '30820abc' + 'ab' * 60


def base(signed=False):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    c.setTitle('Unlock test')
    for i in (1, 2):
        c.setFont('Helvetica', 24)
        c.drawString(72, 760, 'Page %d' % i)
        c.drawString(72, 720, 'UNLOCK-MARK-0%d' % i)
        c.bookmarkPage('p%d' % i)
        c.addOutlineEntry('Chapter %d' % i, 'p%d' % i, level=0)
        c.showPage()
    c.save()
    pdf = pikepdf.open(io.BytesIO(buf.getvalue()))
    page = pdf.pages[0].obj
    field = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String('name'),
                                         V=String('Ada Lovelace'), Rect=Array([72, 600, 300, 630]), F=4, P=page))
    fields = [field]
    if signed:
        sig = pdf.make_indirect(Dictionary(Type=Name.Sig, Filter=Name('/Adobe.PPKLite'), SubFilter=Name('/adbe.pkcs7.detached'),
                                           ByteRange=Array([0, 10, 20, 30]), Contents=String(bytes.fromhex(SIG_HEX)),
                                           Name=String('Test Signer')))
        fields.append(pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Sig, T=String('sig1'),
                                                   Rect=Array([0, 0, 0, 0]), V=sig, P=page)))
    page.Annots = Array(fields)
    pdf.Root.AcroForm = Dictionary(Fields=Array(fields), NeedAppearances=True, **({'SigFlags': 3} if signed else {}))
    pdf.attachments['notes.txt'] = pikepdf.AttachedFileSpec(pdf, b'ATTACHMENT-MARK', mime_type='text/plain')
    pdf.Root.Metadata = pdf.make_stream(b'<x:xmpmeta xmlns:x="adobe:ns:meta/">ROOT-XMP-MARK</x:xmpmeta>',
                                        Type=Name.Metadata, Subtype=Name.XML)
    page.Metadata = pdf.make_stream(b'<x:xmpmeta xmlns:x="adobe:ns:meta/">PAGE-XMP-MARK</x:xmpmeta>',
                                    Type=Name.Metadata, Subtype=Name.XML)
    return pdf


def allow(**off):
    kw = dict(accessibility=True, extract=True, modify_annotation=True, modify_assembly=True, modify_form=True,
              modify_other=True, print_lowres=True, print_highres=True)
    kw.update({k: False for k in off})
    return Permissions(**kw)


ALL = allow()
CASES = {
    'r6-open': dict(user='open sesame', owner='other owner', R=6, allow=ALL),
    'r6-both': dict(user='open sesame', owner='owner pass', R=6, allow=allow(print_lowres=1, print_highres=1, extract=1)),
    'r6-same': dict(user='same pass', owner='same pass', R=6, allow=allow(print_lowres=1, print_highres=1)),
    'r6-restricted': dict(user='', owner='owner pass', R=6, allow=allow(extract=1, modify_other=1)),
    'r6-blank-owner': dict(user='open sesame', owner='', R=6, allow=allow(print_lowres=1, print_highres=1)),
    'r6-cyrillic': dict(user='пароль€', owner='other owner', R=6, allow=ALL),
    'r6-empty': dict(user='', owner='other owner', R=6, allow=ALL),
    'r5': dict(user='open sesame', owner='owner pass', R=5, allow=allow(print_lowres=1, print_highres=1)),
    'r4-aes-nometa': dict(user='open sesame', owner='owner pass', R=4, aes=True, metadata=False, allow=allow(extract=1)),
    'r4-rc4': dict(user='open sesame', owner='other owner', R=4, aes=False, metadata=False, allow=ALL),
    'r3': dict(user='é€', owner='owner pass', R=3, aes=False, metadata=False, allow=allow(print_highres=1)),
    'r2': dict(user='open sesame', owner='', R=2, aes=False, metadata=False, allow=allow(print_lowres=1, print_highres=1)),
    'signed': dict(user='', owner='owner pass', R=6, allow=allow(modify_other=1)),
    'r6-objstm': dict(user='open sesame', owner='owner pass', R=6, allow=allow(print_lowres=1, print_highres=1), objstm=True),
    'r4-objstm': dict(user='open sesame', owner='owner pass', R=4, aes=True, allow=allow(extract=1), objstm=True),
}


def restrictions(a, R):
    """The page's wording, from qpdf's reading of /P (pikepdf's allow flags)."""
    out = []
    if not a.print_lowres:
        out.append('printing')
    elif not a.print_highres:
        out.append('high-quality printing')
    if not a.modify_other:
        out.append('changes')
    if not a.extract:
        out.append('copying')
    if not a.modify_annotation:
        out.append('comments and form filling' if not a.modify_form else 'comments')
    if not a.modify_assembly and a.modify_other:
        out.append('page assembly')
    return out


def opens(path, pw):
    # qpdf takes R2-R4 passwords as PDFDocEncoding bytes (pikepdf's 'pdfdoc' codec).
    cands = [pw]
    try:
        cands.append(pw.encode('pdfdoc'))
    except UnicodeEncodeError:
        pass
    for cand in cands:
        try:
            with pikepdf.open(path, password=cand) as q:
                return 'owner' if q.owner_password_matched else 'user'
        except pikepdf.PasswordError:
            pass
    return None


def cipher(e):
    if e.V >= 5:
        return 'AES 256-bit'
    if e.stream_method.name == 'aes':
        return 'AES 128-bit'
    return 'RC4 %d-bit' % e.bits


def raw_pdf(path, encrypt, extra_stream_dict=b''):
    """A minimal PDF written by hand, with a correct cross-reference table."""
    content = b'BT /F1 24 Tf 72 720 Td (UNLOCK-MARK-01) Tj ET'
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
        b'<< /Length %d %s>>\nstream\n' % (len(content), extra_stream_dict) + content + b'\nendstream',
        encrypt,
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for off in offsets:
        out += b'%010d 00000 n \n' % off
    out += (b'trailer\n<< /Size %d /Root 1 0 R /Encrypt 5 0 R /ID [<0123456789abcdef0123456789abcdef> '
            b'<0123456789abcdef0123456789abcdef>] >>\nstartxref\n%d\n%%%%EOF\n') % (len(objs) + 1, xref)
    open(path, 'wb').write(bytes(out))


def main():
    expected = {}
    p = os.path.join(HERE, 'plain.pdf')
    base().save(p, fix_metadata_version=False)
    expected['plain'] = {'encrypted': False}
    for name, kw in CASES.items():
        p = os.path.join(HERE, name + '.pdf')
        pdf = base(signed=name == 'signed')
        kw = dict(kw)
        objstm = kw.pop('objstm', False)
        user, owner = kw['user'], kw['owner']
        enc = Encryption(**kw)
        mode = pikepdf.ObjectStreamMode.generate if objstm else pikepdf.ObjectStreamMode.disable
        pdf.save(p, encryption=enc, fix_metadata_version=False, object_stream_mode=mode, compress_streams=name != 'signed')
        with pikepdf.open(p, password=user.encode('pdfdoc') if kw['R'] <= 4 else user) as q:
            e = q.encryption
            a = q.allow
            raw_enc = q.trailer.Encrypt
            info = {
                'encrypted': True, 'R': e.R, 'V': e.V, 'P': int(e.P), 'cipher': cipher(e),
                'restrictions': restrictions(a, e.R),
                'encrypt_metadata': bool(raw_enc.get('/EncryptMetadata', True)),
                'O_hex': bytes(raw_enc.O).hex(),
                'user': user, 'owner': owner,
                'empty_opens_as': opens(p, ''),
                'user_opens_as': opens(p, user) if user else None,
                'owner_opens_as': opens(p, owner) if owner else None,
            }
        expected[name] = info
    # Attachments only: the document opens and reads as it is; only embedded files are encrypted.
    raw_pdf(os.path.join(HERE, 'attachments-only.pdf'),
            b'<< /Filter /Standard /V 4 /R 4 /Length 128 /P -4 /CF << /StdCF << /CFM /AESV2 /AuthEvent /EFOpen /Length 16 >> >>'
            b' /StmF /Identity /StrF /Identity /EFF /StdCF /O <' + b'11' * 32 + b'> /U <' + b'22' * 32 + b'> >>')
    raw_pdf(os.path.join(HERE, 'crypt-filter.pdf'),
            b'<< /Filter /Standard /V 4 /R 4 /Length 128 /P -4 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >>'
            b' /Special << /CFM /V2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <' + b'11' * 32 + b'> /U <' + b'22' * 32 + b'> >>',
            b'/Filter /Crypt /DecodeParms << /Type /CryptFilterDecodeParms /Name /Special >> ')
    raw_pdf(os.path.join(HERE, 'certificate.pdf'),
            b'<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /Length 128 /CF << /DefaultCryptFilter << /CFM /AESV2'
            b' /Recipients [<3082>] >> >> /StmF /DefaultCryptFilter /StrF /DefaultCryptFilter >>')
    raw_pdf(os.path.join(HERE, 'drm.pdf'), b'<< /Filter /FOPN_foweb /V 1 /INFO (licence server) >>')
    open(os.path.join(HERE, 'damaged.pdf'), 'wb').write(b'%PDF-1.7\nThis file was cut short and holds no PDF objects.\n')
    expected['signature_contents_hex'] = SIG_HEX
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf8') as f:
        json.dump(expected, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
