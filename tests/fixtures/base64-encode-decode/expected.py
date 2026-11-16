#!/usr/bin/env python3
"""Sample files and expected values for tests/tools/base64-encode-decode.test.js.

Base64 comes from Python's base64 module, text encodings from Python's codecs
and the hex dump from the few lines below, never from the page:

    python3 tests/fixtures/base64-encode-decode/expected.py

The sample files are only written when they are missing, so the bytes in the
repository stay the same from run to run.
"""
import base64
import hashlib
import io
import json
import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def write_once(name, make):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        with open(path, 'wb') as f:
            f.write(make())
    with open(path, 'rb') as f:
        return f.read()


def png():
    """A 3 x 2 RGBA picture written by hand, so that no library version matters."""
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    rows = [[(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)], [(255, 255, 0, 128), (0, 0, 0, 0), (255, 255, 255, 255)]]
    raw = b''.join(b'\x00' + b''.join(bytes(px) for px in row) for row in rows)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 3, 2, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def jpeg():
    from PIL import Image
    im = Image.new('RGB', (16, 12))
    im.putdata([(x * 16, y * 20, 128) for y in range(12) for x in range(16)])
    out = io.BytesIO()
    im.save(out, 'JPEG', quality=80)
    return out.getvalue()


def gif():
    from PIL import Image
    im = Image.new('P', (4, 4))
    im.putpalette([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] + [0] * 756)
    im.putdata([i % 4 for i in range(16)])
    out = io.BytesIO()
    im.save(out, 'GIF')
    return out.getvalue()


def webp():
    from PIL import Image
    im = Image.new('RGB', (8, 6), (30, 120, 200))
    out = io.BytesIO()
    im.save(out, 'WEBP', lossless=True)
    return out.getvalue()


def svg():
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30">\n'
            '  <rect width="40" height="30" fill="#1f6f4a"/>\n  <circle cx="20" cy="15" r="9" fill="#fff"/>\n</svg>\n').encode('utf-8')


def pdf():
    from pypdf import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=72, height=72)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def zipped():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo('hello.txt', (2026, 1, 1, 0, 0, 0)), 'Hello, World!\n')
    return out.getvalue()


def all_bytes():
    return bytes(range(256)) + bytes(range(255, -1, -1))


def lines(s, width):
    return '\n'.join(s[i:i + width] for i in range(0, len(s), width))


def forms(data):
    std = base64.b64encode(data).decode('ascii')
    url = base64.urlsafe_b64encode(data).decode('ascii')
    return {'std': std, 'url': url, 'nopad': std.rstrip('='), 'urlnopad': url.rstrip('='),
            'lines76': lines(std, 76), 'lines64': lines(std, 64), 'urllines76': lines(url.rstrip('='), 76)}


def hexdump(data, per_line=16):
    """The layout of `hexdump -C` (without its closing offset line)."""
    out = []
    for off in range(0, len(data), per_line):
        part = data[off:off + per_line]
        cells = ['%02x ' % b for b in part] + ['   '] * (per_line - len(part))
        half = per_line // 2
        text = ''.join(chr(b) if 32 <= b < 127 else '.' for b in part)
        out.append('%08x  %s %s |%s|' % (off, ''.join(cells[:half]), ''.join(cells[half:]), text))
    return '\n'.join(out)


assert hexdump(b'Hello, World!') == '00000000  48 65 6c 6c 6f 2c 20 57  6f 72 6c 64 21           |Hello, World!|'

files = {}
for name, make, mime in [('pixel.png', png, 'image/png'), ('photo.jpg', jpeg, 'image/jpeg'), ('dots.gif', gif, 'image/gif'),
                         ('flat.webp', webp, 'image/webp'), ('shape.svg', svg, 'image/svg+xml'), ('blank.pdf', pdf, 'application/pdf'),
                         ('hello.zip', zipped, 'application/zip'), ('all-bytes.bin', all_bytes, '')]:
    data = write_once(name, make)
    files[name] = dict(forms(data), size=len(data), mime=mime, sha256=hashlib.sha256(data).hexdigest())
    if name in ('pixel.png', 'all-bytes.bin'):
        files[name].update(dump16=hexdump(data), dump8=hexdump(data, 8))
# Base64 text in a file: the picture as MIME lines, as a certificate would arrive.
write_once('pixel.b64', lambda: (files['pixel.png']['lines76'] + '\n').encode('ascii'))
write_once('pixel.pem', lambda: ('-----BEGIN PICTURE-----\n' + files['pixel.png']['lines64'] + '\n-----END PICTURE-----\n').encode('ascii'))

TEXTS = ['Hello, World!', 'Man', 'Ma', 'M', '', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'café', 'Grüße aus Köln', '✓ à la mode',
         'Привет, мир', 'こんにちは世界', '👋🏽 emoji', 'subjects?_d>>>???', 'a\tb\nc', 'Zażółć gęślą jaźń', '€ 12,50', 'x' * 100,
         'The quick brown fox jumps over the lazy dog. ' * 4]
CODECS = {'utf-8': 'utf-8', 'utf-16le': 'utf-16-le', 'utf-16be': 'utf-16-be', 'windows-1252': 'cp1252', 'windows-1250': 'cp1250', 'windows-1251': 'cp1251'}
texts = []
for t in TEXTS:
    item = {'text': t, 'as': {}}
    for label, codec in CODECS.items():
        try:
            data = t.encode(codec)
        except UnicodeEncodeError as e:
            item['as'][label] = {'error': e.start + 1, 'char': t[e.start]}
            continue
        if label == 'utf-8':
            item['as'][label] = dict(forms(data), bytes=len(data), dump=hexdump(data))
        else:
            item['as'][label] = {'std': base64.b64encode(data).decode('ascii'), 'bytes': len(data)}
    texts.append(item)

# Text in encodings that the page only decodes.
legacy = [{'charset': label, 'text': t, 'std': base64.b64encode(t.encode(codec)).decode('ascii')} for label, codec, t in [
    ('shift_jis', 'shift_jis', 'こんにちは世界'), ('gb18030', 'gb18030', '你好，世界'), ('big5', 'big5', '繁體中文'), ('euc-kr', 'euc_kr', '안녕하세요'),
    ('windows-1251', 'cp1251', 'Привет'), ('windows-1250', 'cp1250', 'Zażółć gęślą jaźń'), ('windows-1252', 'cp1252', 'café €5 “quoted”'),
    ('utf-16le', 'utf-16-le', 'héllo 👋'), ('utf-16be', 'utf-16-be', 'héllo 👋')]]

# Bytes that are no text at all, and bytes with a UTF-16 byte order mark.
raw = [{'hex': h, 'std': base64.b64encode(bytes.fromhex(h)).decode('ascii'), 'lossy': bytes.fromhex(h).decode('utf-8', 'replace')}
       for h in ['deadbeef', 'e9', 'fffe680069000000', 'feff00680069', 'c3a9ff', '00010203', 'f09f98']]

out = {'files': files, 'texts': texts, 'legacy': legacy, 'raw': raw}
with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write('\n')
print('wrote expected.json;', {k: v['size'] for k, v in files.items()})
