#!/usr/bin/env python3
"""Checks a PDF that Rotate PDF saved against the file it came from, with libqpdf
(pikepdf) and poppler (pdfinfo), independently of the page's own libraries.

    python3 verify.py original.pdf output.pdf [password]

Prints one JSON object:
  check       problems libqpdf finds in the output (qpdf --check), [] when none
  check_orig  the same for the original, to tell new problems from old ones
  rotations   each page's rotation, inherited and normalised as viewers read it
  own         whether each page has a /Rotate of its own
  poppler     each page's rotation as pdfinfo reports it
  same        for outline, links, fields, tags, attachments, info, encryption
              and the strings in page dictionaries (each one read decrypted):
              true when the output has what the original has
  prefix      the output starts with every byte of the original (an update)
  added       bytes added
  last        'table' or 'stream': the kind of the output's last section
  orig_last   the same for the original
  trailer     the output's last trailer repeats every entry of the original's
              last trailer except /Prev (and the entries only a cross-reference
              stream has), /Size is no smaller and /Prev is the old startxref
  encryption  { R, V, allow } of the output, or null
  sig         for each signature: whether its /ByteRange covers bytes that are
              unchanged in the output (the signed revision is intact)
"""
import json
import re
import subprocess
import sys

import pikepdf

STREAM_ONLY = {'/Type', '/Size', '/Index', '/Prev', '/W', '/Length', '/Filter', '/DecodeParms', '/F',
               '/FFilter', '/FDecodeParms', '/DL', '/XRefStm'}


def walk_pages(pdf):
    """Pages in order with their effective and own rotation, without pikepdf's page
    helper, which moves inherited attributes down to the pages."""
    out, seen = [], set()

    def walk(node, inh, depth):
        if depth > 50 or node.objgen in seen:
            return
        seen.add(node.objgen)
        if '/Rotate' in node:
            inh = int(node.Rotate)
        if node.get('/Type') == '/Pages' or ('/Kids' in node and '/Type' not in node):
            for k in node.Kids:
                walk(k, inh, depth + 1)
        else:
            out.append((node, 0 if inh % 90 else inh % 360, '/Rotate' in node))
    walk(pdf.Root.Pages, 0, 0)
    return out


def strings(obj, depth=0):
    """Every string inside a direct object, decoded, in order."""
    if depth > 20:
        return []
    if isinstance(obj, pikepdf.String):
        return [bytes(obj)]
    if isinstance(obj, pikepdf.Dictionary):
        out = []
        for k in sorted(obj.keys()):
            v = obj.get(k)
            if k in ('/Parent', '/P') or (isinstance(v, pikepdf.Object) and v.is_indirect):
                continue
            out += strings(v, depth + 1)
        return out
    if isinstance(obj, pikepdf.Array):
        out = []
        for v in obj:
            if isinstance(v, pikepdf.Object) and v.is_indirect:
                continue
            out += strings(v, depth + 1)
        return out
    return []


# PDFDocEncoding of the characters that differ from Latin-1 (ISO 32000-2 Table D.2).
PDFDOC = dict(zip('•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž\ufffd€', range(0x80, 0xA1)))


def open_pdf(fn, password):
    """pikepdf takes a password as UTF-8; an RC4 or AES-128 file may keep it in PDFDocEncoding."""
    tries = [password]
    if password:
        tries.append(bytes(PDFDOC.get(c, ord(c)) for c in password if PDFDOC.get(c, ord(c)) < 256))
    for i, pw in enumerate(tries):
        try:
            return pikepdf.open(fn, password=pw)
        except pikepdf.PasswordError:
            if i == len(tries) - 1:
                raise


def summary(fn, password):
    pdf = open_pdf(fn, password)
    root = pdf.Root
    pages = walk_pages(pdf)
    links = 0
    for node, _, _ in pages:
        for a in node.get('/Annots') or []:
            if a.get('/Subtype') == '/Link':
                links += 1
    fields = len(root.AcroForm.Fields) if '/AcroForm' in root and '/Fields' in root.AcroForm else 0
    try:
        with pdf.open_outline() as o:
            outline = [i.title for i in o.root]
    except Exception:
        outline = None
    tags = None
    if '/StructTreeRoot' in root:
        tags = len(root.StructTreeRoot.get('/K').get('/K') or []) if isinstance(root.StructTreeRoot.get('/K'), pikepdf.Dictionary) else 0
    atts = sorted(pdf.attachments.keys())
    att_data = [pdf.attachments[k].get_file().read_bytes() for k in atts]
    info = {str(k): str(v) for k, v in pdf.docinfo.items()} if pdf.trailer.get('/Info') is not None else {}
    enc = None
    if pdf.is_encrypted:
        e = pdf.encryption
        enc = {'R': e.R, 'V': e.V, 'allow': {k: bool(getattr(pdf.allow, k)) for k in
                                             ('accessibility', 'extract', 'modify_annotation', 'modify_assembly',
                                              'modify_form', 'modify_other', 'print_lowres', 'print_highres')}}
    page_strings = [[s.hex() for s in strings(node)] for node, _, _ in pages]
    return {
        'pdf': pdf, 'pages': pages, 'links': links, 'fields': fields, 'outline': outline, 'tags': tags,
        'attachments': [atts, [len(d) for d in att_data], [d[:40].decode('latin-1') for d in att_data]],
        'info': info, 'encryption': enc, 'page_strings': page_strings,
    }


TOKEN = re.compile(rb'\s*(<<|>>|\[|\]|/[^\s/<>\[\]()%]*|<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|[-+.\d]+|R|true|false|null)', re.S)


def parse_value(toks, i):
    t = toks[i]
    if t in (b'[', b'<<'):
        depth, j = 0, i
        while True:
            if toks[j] in (b'[', b'<<'):
                depth += 1
            elif toks[j] in (b']', b'>>'):
                depth -= 1
            j += 1
            if depth == 0:
                break
        return b' '.join(toks[i:j]), j
    if re.fullmatch(rb'\d+', t) and i + 2 < len(toks) and re.fullmatch(rb'\d+', toks[i + 1]) and toks[i + 2] == b'R':
        return b' '.join(toks[i:i + 3]), i + 3
    return t, i + 1


def parse_dict(data):
    """A dictionary's entries as {key: value text}, for comparing two trailers."""
    toks, pos, depth = [], 0, 0
    while True:
        m = TOKEN.match(data, pos)
        if not m:
            break
        t = m.group(1)
        toks.append(t)
        pos = m.end()
        depth += (t == b'<<') - (t == b'>>')
        if depth == 0:
            break
    out, i = {}, 1
    while i < len(toks) - 1:
        key = toks[i].decode('latin-1')
        val, i = parse_value(toks, i + 1)
        out[key] = val.decode('latin-1')
    return out


def last_section(data):
    k = data.rfind(b'startxref')
    off = int(re.match(rb'\s*(\d+)', data[k + 9:]).group(1))
    tail = data[off:]
    if tail.lstrip().startswith(b'xref'):
        t = tail.index(b'trailer')
        return 'table', off, parse_dict(tail[t + 7:])
    m = re.match(rb'\s*\d+\s+\d+\s+obj\s*', tail)
    return 'stream', off, parse_dict(tail[m.end():])


def poppler(fn, password, n):
    tries = [[]]
    if password:
        doc = bytes(PDFDOC.get(c, ord(c)) for c in password if PDFDOC.get(c, ord(c)) < 256)
        tries = [[opt, pw] for pw in (password.encode('utf-8'), doc) for opt in ('-upw', '-opw')]
    for pw in tries:
        res = subprocess.run(['pdfinfo', '-f', '1', '-l', str(n)] + pw + [fn], capture_output=True)
        out = res.stdout.decode('utf-8', 'replace')
        rots = [int(l.split()[-1]) for l in out.splitlines() if l.startswith('Page') and 'rot:' in l]
        if rots:
            return rots
    return []


def signed_ranges(pdf):
    out = []
    for f in (pdf.Root.get('/AcroForm') or {}).get('/Fields') or []:
        v = f.get('/V')
        if f.get('/FT') == '/Sig' and isinstance(v, pikepdf.Dictionary) and '/ByteRange' in v:
            out.append([int(x) for x in v.ByteRange])
    return out


def main():
    orig_fn, out_fn = sys.argv[1], sys.argv[2]
    password = sys.argv[3] if len(sys.argv) > 3 else ''
    orig, out = open(orig_fn, 'rb').read(), open(out_fn, 'rb').read()
    a, b = summary(orig_fn, password), summary(out_fn, password)
    res = {
        'check': b['pdf'].check_pdf_syntax(),
        'check_orig': a['pdf'].check_pdf_syntax(),
        'pages': len(b['pages']),
        'rotations': [r for _, r, _ in b['pages']],
        'own': [o for _, _, o in b['pages']],
        'poppler': poppler(out_fn, password, len(b['pages'])),
        'same': {k: a[k] == b[k] for k in ('outline', 'links', 'fields', 'tags', 'attachments', 'info', 'encryption', 'page_strings')},
        'detail': {k: [a[k], b[k]] for k in ('outline', 'links', 'fields', 'tags', 'attachments', 'encryption') if a[k] != b[k]},
        'prefix': out[:len(orig)] == orig,
        'added': len(out) - len(orig),
        'encryption': b['encryption'],
    }
    try:
        ok, o_off, o_tr = last_section(orig)
        kind, _, tr = last_section(out)
        res['orig_last'], res['last'] = ok, kind
        if res['prefix']:
            skip = STREAM_ONLY if ok == 'stream' else {'/Prev', '/Size'}
            keys = [k for k in o_tr.keys() if k not in skip]
            res['trailer'] = (all(k in tr and tr[k] == o_tr[k] for k in keys)
                              and int(tr['/Size']) >= int(o_tr['/Size']) and int(tr['/Prev']) == o_off)
            res['trailer_keys'] = sorted(str(k) for k in tr.keys())
    except Exception as e:  # a damaged original has no readable last section
        res['last_error'] = str(e)[:200]
    ranges = signed_ranges(a['pdf'])
    res['sig'] = [len(orig) >= r[2] + r[3] and out[:r[2] + r[3]] == orig[:r[2] + r[3]] for r in ranges]
    print(json.dumps(res))


if __name__ == '__main__':
    main()
