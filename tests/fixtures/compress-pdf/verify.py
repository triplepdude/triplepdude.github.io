#!/usr/bin/env python3
"""Compares a PDF that the Compress PDF page wrote with its original, using libqpdf (through
pikepdf) and poppler (pdftotext, pdftoppm), not the libraries the page uses.

    python3 verify.py ORIGINAL COPY [PASSWORD]

PASSWORD may be the open or the permissions password of both files.

Prints one JSON object: what libqpdf's check finds in the copy, whether the text (pdftotext),
outline, links, form fields, structure tree, attachments, page boxes, XMP metadata, output
intents and /ID are the same, each marked picture in both files (filter, size, colour space,
soft mask), how the copy is stored (cross-reference table or stream, object streams, header
version), its encryption, and how close each of the first 30 pages looks (PSNR of poppler
renderings at 50 dpi).
"""
import hashlib
import json
import math
import subprocess
import sys
import tempfile
import os

import numpy as np
import pikepdf
from PIL import Image


def text(path, pw):
    args = ['pdftotext', '-q', '-enc', 'UTF-8']
    if pw:
        args += [b'-opw', pw, b'-upw', pw] if isinstance(pw, bytes) else ['-opw', pw, '-upw', pw]
    return subprocess.run(args + [path, '-'], capture_output=True, check=True).stdout.decode('utf-8', 'replace')


def inherited(page, key):
    node, depth = page, 0
    while node is not None and depth < 64:
        if key in node:
            return node[key]
        node = node.get('/Parent')
        depth += 1
    return None


def num(v):
    try:
        return round(float(v), 3)
    except Exception:
        return None


def boxes(pdf):
    out = []
    for p in pdf.pages:
        o = p.obj
        mb = inherited(o, '/MediaBox')
        cb = inherited(o, '/CropBox')
        out.append({'media': [num(x) for x in mb] if mb is not None else None,
                    'crop': [num(x) for x in cb] if cb is not None else None,
                    'rotate': int(inherited(o, '/Rotate') or 0),
                    'unit': num(o.get('/UserUnit', 1))})
    return out


def page_index(pdf):
    return {p.obj.objgen: i for i, p in enumerate(pdf.pages)}


def dest_page(pdf, d, idx):
    try:
        if isinstance(d, (pikepdf.String, str, pikepdf.Name)):
            names = pdf.Root.get('/Names')
            dests = pdf.Root.get('/Dests')
            key = str(d)
            if dests is not None and ('/' + key.lstrip('/')) in dests:
                d = dests['/' + key.lstrip('/')]
            elif names is not None and '/Dests' in names:
                tree = pikepdf.NameTree(names.Dests)
                if key in tree:
                    d = tree[key]
        if isinstance(d, pikepdf.Dictionary) and '/D' in d:
            d = d.D
        if isinstance(d, pikepdf.Array) and len(d):
            return idx.get(d[0].objgen, 'missing')
    except Exception as e:
        return 'error %s' % e
    return None


def outline(pdf, idx):
    out = []
    with pdf.open_outline() as ol:
        def walk(items, level):
            for it in items:
                dest = it.destination
                if dest is None and it.action is not None and '/D' in it.action:
                    dest = it.action.D
                out.append([level, it.title, dest_page(pdf, dest, idx) if dest is not None else None])
                walk(it.children, level + 1)
        walk(ol.root, 0)
    return out


def links(pdf, idx):
    out = []
    for i, p in enumerate(pdf.pages):
        for a in p.obj.get('/Annots', []):
            sub = str(a.get('/Subtype'))
            item = [i, sub, [num(x) for x in a.get('/Rect', [])]]
            if sub == '/Link':
                act = a.get('/A')
                if act is not None and '/URI' in act:
                    item.append(str(act.URI))
                elif act is not None and '/D' in act:
                    item.append(dest_page(pdf, act.D, idx))
                elif '/Dest' in a:
                    item.append(dest_page(pdf, a.Dest, idx))
            if '/StructParent' in a:
                item.append(int(a.StructParent))
            out.append(item)
    return out


def fields(pdf):
    out = []
    form = pdf.Root.get('/AcroForm')
    if form is None:
        return out

    def walk(f, prefix, depth):
        if depth > 32:
            return
        name = prefix + ('.' if prefix and '/T' in f else '') + (str(f.T) if '/T' in f else '')
        ft = inherited(f, '/FT')
        v = f.get('/V')
        if isinstance(v, pikepdf.Dictionary):
            v = 'dict'
        out.append([name, str(ft) if ft is not None else None, str(v) if v is not None else None])
        for k in f.get('/Kids', []):
            walk(k, name, depth + 1)
    for f in form.get('/Fields', []):
        walk(f, '', 0)
    return out


def struct(pdf, idx):
    root = pdf.Root.get('/StructTreeRoot')
    if root is None:
        return None
    out = []

    def walk(k, depth):
        if depth > 64:
            return
        if isinstance(k, pikepdf.Array):
            for x in k:
                walk(x, depth)
            return
        if isinstance(k, int) or (hasattr(k, 'is_integer') and False):
            out.append(['mcid', int(k)])
            return
        try:
            int(k)
            out.append(['mcid', int(k)])
            return
        except Exception:
            pass
        if not isinstance(k, pikepdf.Dictionary):
            return
        t = k.get('/Type')
        if t == '/OBJR':
            o = k.Obj
            out.append(['objr', str(o.get('/Subtype')), str(o.get('/TTMark')) if '/TTMark' in o else None])
            return
        if t == '/MCR':
            out.append(['mcr', int(k.MCID)])
            return
        pg = k.get('/Pg')
        out.append(['elem', str(k.get('/S')), str(k.get('/Alt')) if '/Alt' in k else None, idx.get(pg.objgen) if pg is not None else None])
        if '/K' in k:
            walk(k.K, depth + 1)
    walk(root.get('/K'), 0)
    pt = root.get('/ParentTree')
    nums = []
    if pt is not None:
        def nwalk(n, depth):
            if depth > 32:
                return
            if '/Nums' in n:
                a = n.Nums
                for i in range(0, len(a), 2):
                    v = a[i + 1]
                    nums.append([int(a[i]), len(v) if isinstance(v, pikepdf.Array) else 1])
            for kid in n.get('/Kids', []):
                nwalk(kid, depth + 1)
        nwalk(pt, 0)
    return {'tree': out, 'parents': nums, 'marked': bool(pdf.Root.get('/MarkInfo', {}).get('/Marked', False))}


def attachments(pdf):
    return {k: hashlib.sha256(v.get_file().read_bytes()).hexdigest() for k, v in pdf.attachments.items()}


def fontfiles(pdf):
    seen = set()
    for o in pdf.objects:
        if isinstance(o, pikepdf.Dictionary) and o.get('/Type') == '/FontDescriptor':
            for k in ('/FontFile', '/FontFile2', '/FontFile3'):
                if k in o:
                    seen.add(o[k].objgen)
    return len(seen)


def cs_name(cs):
    if cs is None:
        return None
    if isinstance(cs, pikepdf.Array):
        first = str(cs[0])
        if first == '/ICCBased':
            return 'ICC%d' % int(cs[1].N)
        return first
    return str(cs)


def images(pdf):
    out = {}
    for o in pdf.objects:
        if isinstance(o, pikepdf.Stream) and o.get('/Subtype') == '/Image' and '/TTMark' in o:
            f = o.get('/Filter')
            f = [str(x) for x in f] if isinstance(f, pikepdf.Array) else ([str(f)] if f is not None else [])
            sm = o.get('/SMask')
            item = {'filter': '+'.join(x.lstrip('/') for x in f), 'w': int(o.Width), 'h': int(o.Height),
                    'bpc': int(o.get('/BitsPerComponent', 0)), 'cs': cs_name(o.get('/ColorSpace')),
                    'bytes': len(o.read_raw_bytes()),
                    'smask': [int(sm.Width), int(sm.Height), len(sm.read_raw_bytes())] if sm is not None else None,
                    'sha': hashlib.sha256(o.read_raw_bytes()).hexdigest()[:16],
                    'decode': [num(x) for x in o.Decode] if '/Decode' in o else None,
                    'orient': None}
            if item['filter'] == 'DCTDecode':
                try:
                    from io import BytesIO
                    im = Image.open(BytesIO(o.read_raw_bytes()))
                    item['jpeg'] = [im.mode, im.width, im.height]
                    item['orient'] = im.getexif().get(0x0112)
                except Exception as e:
                    item['jpeg'] = 'error %s' % e
            out.setdefault(str(o.TTMark).lstrip('/'), []).append(item)
    return out


def storage(path):
    raw = open(path, 'rb').read()
    sx = raw.rfind(b'startxref')
    off = int(raw[sx + 9:].split()[0]) if sx >= 0 else -1
    at = raw[off:off + 40] if off >= 0 else b''
    return {'header': raw[:8].decode('latin-1'), 'xref': 'table' if at.startswith(b'xref') else 'stream' if b' obj' in at else 'none',
            'objstm': b'/ObjStm' in raw, 'xrefstm': b'/XRef' in raw, 'eof_tail': raw[raw.rfind(b'%%EOF'):].decode('latin-1')}


def render(path, pw, dpi=50, last=30):
    """Poppler's rendering of the first pages (at most `last`), as PNG files."""
    d = tempfile.mkdtemp()
    args = ['pdftoppm', '-q', '-r', str(dpi), '-l', str(last), '-png']
    if pw:
        args += [b'-opw', pw, b'-upw', pw] if isinstance(pw, bytes) else ['-opw', pw, '-upw', pw]
    subprocess.run(args + [path, os.path.join(d, 'p')], check=True)
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.png')]


def load(f):
    return np.asarray(Image.open(f).convert('RGB'), np.float64)


def psnr(a, b):
    if a.shape != b.shape:
        return -1
    mse = ((a - b) ** 2).mean()
    return 99.0 if mse == 0 else round(10 * math.log10(255 * 255 / mse), 2)


def open_pdf(path, pw):
    """Opens with the password as typed (UTF-8), else in Latin-1 (PDFDocEncoding for those
    letters), as RC4 and AES-128 files store it. Returns the Pdf and the form that worked."""
    tries = [pw or '']
    try:
        tries.append((pw or '').encode('latin-1'))
    except UnicodeEncodeError:
        pass
    for i, t in enumerate(tries):
        try:
            return pikepdf.open(path, password=t), t
        except pikepdf.PasswordError:
            if i == len(tries) - 1:
                raise


def summary(path, pw):
    pdf, pw = open_pdf(path, pw)
    idx = page_index(pdf)
    meta = pdf.Root.get('/Metadata')
    oi = pdf.Root.get('/OutputIntents')
    enc = None
    if pdf.is_encrypted:
        e = pdf.encryption
        enc = {'R': e.R, 'V': e.V, 'P': e.P, 'bits': e.bits, 'stream': str(e.stream_method), 'string': str(e.string_method)}
    s = {
        'pages': len(pdf.pages), 'boxes': boxes(pdf), 'outline': outline(pdf, idx), 'links': links(pdf, idx), 'fields': fields(pdf),
        'struct': struct(pdf, idx), 'attachments': attachments(pdf), 'images': images(pdf), 'encrypt': enc,
        'id0': bytes(pdf.trailer.ID[0]).hex() if '/ID' in pdf.trailer else None,
        'metadata': hashlib.sha256(meta.read_raw_bytes()).hexdigest() if meta is not None else None,
        'metadata_filter': str(meta.get('/Filter')) if meta is not None and '/Filter' in meta else None,
        'intents': [[str(x.get('/S')), str(x.get('/OutputConditionIdentifier')),
                     hashlib.sha256(x.DestOutputProfile.read_bytes()).hexdigest() if '/DestOutputProfile' in x else None] for x in oi] if oi is not None else None,
        'thumbs': sum(1 for p in pdf.pages if '/Thumb' in p.obj), 'pieceinfo': '/PieceInfo' in pdf.Root,
        'fontfiles': fontfiles(pdf),
        'linearized': pdf.is_linearized,
        'docinfo': {str(k): str(v) for k, v in pdf.docinfo.items()} if '/Info' in pdf.trailer else None,
    }
    problems = pdf.check_pdf_syntax()
    pdf.close()
    return s, problems


def main():
    orig, copy = sys.argv[1], sys.argv[2]
    pw = sys.argv[3] if len(sys.argv) > 3 else ''
    a, _ = summary(orig, pw)
    b, problems = summary(copy, pw)
    pw = open_pdf(orig, pw)[1]
    same = {k: a[k] == b[k] for k in ('pages', 'boxes', 'outline', 'links', 'fields', 'struct', 'attachments', 'id0', 'metadata',
                                      'metadata_filter', 'intents', 'docinfo')}
    ta, tb = text(orig, pw), text(copy, pw)
    ra, rb = render(orig, pw), render(copy, pw)
    out = {
        'check': problems, 'same': same, 'text_same': ta == tb, 'text_len': [len(ta), len(tb)],
        'images': {'orig': a['images'], 'copy': b['images']}, 'storage': {'orig': storage(orig), 'copy': storage(copy)},
        'encrypt': {'orig': a['encrypt'], 'copy': b['encrypt']}, 'psnr': [psnr(load(x), load(y)) for x, y in zip(ra, rb)],
        'thumbs': [a['thumbs'], b['thumbs']], 'pieceinfo': [a['pieceinfo'], b['pieceinfo']],
        'fontfiles': [a['fontfiles'], b['fontfiles']], 'linearized': [a['linearized'], b['linearized']],
        'sizes': [os.path.getsize(orig), os.path.getsize(copy)],
    }
    if not out['text_same']:
        out['text'] = [ta[:400], tb[:400]]
    for k, v in same.items():
        if not v:
            out.setdefault('diff', {})[k] = [a[k], b[k]]
    print(json.dumps(out))


if __name__ == '__main__':
    main()
