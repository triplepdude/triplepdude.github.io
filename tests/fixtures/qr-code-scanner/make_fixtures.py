#!/usr/bin/env python3
"""Builds the QR code images for tests/tools/qr-code-scanner.test.js.

    python3 tests/fixtures/qr-code-scanner/make_fixtures.py

Codes are encoded with segno (an encoder unrelated to the page) and every
image is decoded again with zxing-cpp, a second independent reader, before it
is kept. expected.json records the exact text (or, for binary codes, the
bytes as hex) of each code, which is what the page must report. Checksums in
expected.json (IBAN mod 97, EMV CRC-16/CCITT-FALSE) are worked out here.
Needs: segno, zxing-cpp, Pillow, pillow-heif, numpy, opencv-python.
"""
import io, json, os, random
import numpy as np
import cv2
import pillow_heif
import segno
import zxingcpp
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
rng = random.Random(20261116)
expected = {}


def qr_image(content, scale=8, border=4, dark=(0, 0, 0, 255), light=(255, 255, 255, 255), **kw):
    q = segno.make(content, micro=False, **kw)
    buf = io.BytesIO()
    q.save(buf, kind='png', scale=scale, border=border, dark='#000', light='#fff')
    grey = np.array(Image.open(io.BytesIO(buf.getvalue())).convert('L'))
    out = np.where((grey < 128)[..., None], np.array(dark, np.uint8), np.array(light, np.uint8))
    return Image.fromarray(out.astype(np.uint8), 'RGBA'), q


def decode_all(img):
    arr = np.array(img.convert('RGB'))
    return zxingcpp.read_barcodes(arr, formats=zxingcpp.BarcodeFormat.QRCode)


def check(name, img, texts, charset=None):
    got = sorted(r.bytes.decode(charset) if charset else r.text for r in decode_all(img))
    assert got == sorted(texts), f'{name}: zxing-cpp read {got!r}, expected {texts!r}'


def save(name, img, texts, **extra):
    path = os.path.join(HERE, name)
    if name.endswith('.jpg'):
        img.convert('RGB').save(path, quality=extra.pop('quality', 85), exif=extra.pop('exif', b''))
        img = Image.open(path)
    else:
        img.save(path, optimize=True)
    check(name, Image.open(path), texts, extra.pop('charset', None))
    expected[name] = dict(texts=texts, **extra)


def simple(name, content, charset=None, **kw):
    img, q = qr_image(content, **kw)
    save(name, img, [content], charset=charset)
    return q


# ---- Plain codes, one per payload type ----
simple('url.png', 'https://example.com/menu?table=12', error='M')
simple('wifi.png', 'WIFI:T:WPA;S:Caf\u00e9 \\"Corner\\";P:pa\\;ss\\:wo\\\\rd;H:true;;', error='M')  # Latin-1 bytes, no ECI
VCARD = ('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Ångström;Zoë;;Dr;\r\nFN:Dr Zoë Ångström\r\n'
         'ORG:Ångström & Co\\, Ltd\r\nTITLE:Head of research\r\nTEL;TYPE=CELL:+44 7700 900123\r\n'
         'TEL;TYPE=WORK,VOICE:+44 1632 960000\r\nEMAIL:zoe@example.com\r\n'
         'ADR;TYPE=WORK:;;1 High Street;Oxford;;OX1 1AA;United Kingdom\r\nURL:https://example.com/zoe\r\n'
         'NOTE:Line one\\nLine two\r\nEND:VCARD\r\n')
simple('vcard.png', VCARD, encoding='utf-8', error='L')
simple('text.png', 'Grüße \U0001F44B\r\n日本語のテキスト\nend', encoding='utf-8', eci=True)
# windows-1252 bytes and no ECI. zxing-cpp reads them as strict ISO-8859-1, where 0x96 and 0x80
# are control codes; the page reads them as windows-1252, as browsers do, so the check does too.
simple('latin1.png', 'Cr\u00e8me br\u00fbl\u00e9e \u2013 5 \u20ac', encoding='cp1252', charset='cp1252')
simple('kanji.png', '日本語', mode='kanji')
# Windows-1251 bytes with ECI 22: read correctly only if the declared character set is honoured.
simple('eci-cp1251.png', '\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440', encoding='cp1251', eci=True)
simple('mecard.png', 'MECARD:N:Doe,Jane;TEL:+15551230000;EMAIL:jane@example.com;URL:https\\://example.com;;')
simple('mailto.png', 'mailto:ana@example.com?subject=Hello%20there&body=Line%201%0D%0ALine%202')
simple('tel.png', 'tel:+441632960123')
simple('sms.png', 'SMSTO:+15551234567:Hello there')
simple('geo.png', 'geo:51.50070,-0.12460')
EVENT = ('BEGIN:VEVENT\r\nSUMMARY:Carol concert\r\nDTSTART:20261224T180000Z\r\nDTEND:20261224T200000Z\r\n'
         'LOCATION:Town hall\\, Main Street\r\nEND:VEVENT')
simple('event.png', EVENT)
simple('otp.png', 'otpauth://totp/Example%20Co:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example%20Co&algorithm=SHA1&digits=6&period=30')
simple('upi.png', 'upi://pay?pa=merchant@examplebank&pn=Example%20Store&am=249.00&cu=INR&tn=Order%2042')
simple('bitcoin.png', 'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.0015&label=Example')
simple('phishy.png', 'http://paypal.com@203.0.113.9:8080/login')
simple('short.png', 'https://bit.ly/3xYz9Ab')
simple('idn.png', 'https://аpple.com/account', encoding='utf-8')   # Cyrillic a
simple('js.png', 'javascript:alert(document.cookie)')
simple('fido.png', 'FIDO:/0123456789012345678901234567890123456789')
simple('apk.png', 'https://example.com/files/update.apk')
simple('www.png', 'www.example.com/menu')
simple('plain-note.png', 'Note: bring the blue folder')
simple('fake-wifi.png', 'WIFI: mostly harmless')   # starts like a Wi-Fi code but has no network name
# 80 emoji after five letters, so a cut after 90 UTF-16 units would split one in half.
simple('emoji-long.png', 'Mood ' + '\U0001F600' * 60 + ' \U0001F44D\U0001F3FD' * 20, encoding='utf-8')
# A UTF-8 byte order mark before a Wi-Fi code, as some generators write it.
img, _ = qr_image(b'\xef\xbb\xbfWIFI:S:Home;T:WPA;P:secret123;;')
img.save(os.path.join(HERE, 'bom-wifi.png'), optimize=True)
got = decode_all(Image.open(os.path.join(HERE, 'bom-wifi.png')))
assert got and got[0].bytes == b'\xef\xbb\xbfWIFI:S:Home;T:WPA;P:secret123;;', got
expected['bom-wifi.png'] = dict(texts=['WIFI:S:Home;T:WPA;P:secret123;;'])   # what the page should show: no BOM


def iban_ok(iban):
    s = iban[4:] + iban[:4]
    n = ''.join(str(int(c, 36)) for c in s)
    return int(n) % 97 == 1


GOOD_IBAN, BAD_IBAN = 'DE89370400440532013000', 'DE88370400440532013000'
assert iban_ok(GOOD_IBAN) and not iban_ok(BAD_IBAN)
EPC = 'BCD\n002\n1\nSCT\nCOBADEFFXXX\nExample Supplies GmbH\n{}\nEUR123.45\n\n\nInvoice 2026-114\n'
simple('epc.png', EPC.format(GOOD_IBAN))
simple('epc-bad.png', EPC.format(BAD_IBAN))


def crc16(data):  # CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


assert crc16(b'123456789') == 0x29B1   # the published check value


def tlv(tag, value):
    return f'{tag}{len(value):02d}{value}'


body = (tlv('00', '01') + tlv('01', '12') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', '123e4567-e89b-12d3-a456-426614174000'))
        + tlv('52', '0000') + tlv('53', '986') + tlv('54', '10.50') + tlv('58', 'BR') + tlv('59', 'Loja Exemplo')
        + tlv('60', 'Sao Paulo') + tlv('62', tlv('05', 'REF123')) + '6304')
EMV = body + f'{crc16(body.encode()):04X}'
simple('emv.png', EMV)
simple('emv-bad.png', EMV.replace('10.50', '90.50'))   # amount changed after the checksum was made

# Binary payload (not text): bytes 0x00-0x1F and 0x80-0x9F that are not valid UTF-8.
BIN = bytes([0, 1, 2, 3, 0x1b, 0x7f, 0x80, 0x81, 0xfe, 0xff, 0x10, 0x11, 0x12, 0x9f]) * 2
img, _ = qr_image(BIN)
img.save(os.path.join(HERE, 'binary.png'), optimize=True)
got = decode_all(Image.open(os.path.join(HERE, 'binary.png')))
assert got and got[0].bytes == BIN, got
expected['binary.png'] = dict(hex=BIN.hex())

# ---- Hard images ----
img, _ = qr_image('INVERTED 42', dark=(255, 255, 255, 255), light=(20, 30, 40, 255))
img.save(os.path.join(HERE, 'inverted.png'))
expected['inverted.png'] = dict(texts=['INVERTED 42'])   # zxing-cpp is not asked: it skips inverted codes by default
inv = zxingcpp.read_barcodes(np.array(Image.open(os.path.join(HERE, 'inverted.png')).convert('RGB')), try_invert=True)
assert [r.text for r in inv] == ['INVERTED 42'], inv

img, _ = qr_image('TINY', scale=1, border=2)
save('tiny.png', img, ['TINY'])
img, _ = qr_image('https://example.org/no-border', border=0, scale=6)
img.save(os.path.join(HERE, 'nomargin.png'))
expected['nomargin.png'] = dict(texts=['https://example.org/no-border'])
img, _ = qr_image('TRANSPARENT', dark=(0, 0, 0, 255), light=(255, 255, 255, 0))
img.save(os.path.join(HERE, 'transparent.png'))
expected['transparent.png'] = dict(texts=['TRANSPARENT'])
flat = Image.new('RGB', img.size, 'white'); flat.paste(img, mask=img)
check('transparent.png (on white)', flat, ['TRANSPARENT'])

# Three codes in one picture.
multi = Image.new('RGB', (1200, 520), (236, 240, 244))
texts = ['https://example.com/one', 'SMSTO:+15551234567:Hello there', 'tel:+441632960123']
for i, t in enumerate(texts):
    q, _ = qr_image(t, scale=8)
    multi.paste(q.convert('RGB'), (40 + i * 390, 60 + (i % 2) * 60))
save('multi.png', multi, texts)


# Six codes in a grid, and ten (more than the page reads from one picture). Side by side, the
# corner squares of different codes confuse a reader that looks across the whole picture.
def grid(name, n, cols):
    texts = ['https://example.com/grid-%d' % i for i in range(n)]
    cells = [qr_image(t, scale=6)[0].convert('RGB') for t in texts]
    w, h = max(c.width for c in cells), max(c.height for c in cells)
    img = Image.new('RGB', (cols * (w + 40) + 40, -(-n // cols) * (h + 40) + 40), 'white')
    for i, c in enumerate(cells):
        img.paste(c, (40 + (i % cols) * (w + 40), 40 + (i // cols) * (h + 40)))
    save(name, img, texts)


grid('grid6.png', 6, 3)
grid('grid10.png', 10, 5)

# Three codes in a row where a pass over the whole picture reads only one of them; windows of the
# picture, read after that code is painted out, find the other two.
row = Image.new('RGB', (1100, 700), 'white')
row_texts = ['https://example.com/r29-%d' % i for i in range(3)]
for t, (x, y, s) in zip(row_texts, [(12, 157, 10), (459, 114, 10), (790, 134, 8)]):
    row.paste(qr_image(t, scale=s)[0].convert('RGB'), (x, y))
save('row3.png', row, row_texts)

# No code at all.
none = Image.new('RGB', (640, 420), (250, 250, 247))
d = ImageDraw.Draw(none)
for _ in range(40):
    x, y = rng.randrange(600), rng.randrange(380)
    d.rectangle([x, y, x + rng.randrange(10, 60), y + rng.randrange(10, 60)], fill=tuple(rng.randrange(256) for _ in range(3)))
none.save(os.path.join(HERE, 'none.png'))
assert not decode_all(none)
expected['none.png'] = dict(texts=[])

# A phone screenshot (1170 x 2532) with a small code in the middle of an app screen.
shot = Image.new('RGB', (1170, 2532), (245, 246, 248))
d = ImageDraw.Draw(shot)
d.rectangle([0, 0, 1170, 260], fill=(31, 111, 74))
for i in range(9):
    d.rounded_rectangle([60, 330 + i * 120, 1110, 420 + i * 120], radius=24, fill=(255, 255, 255), outline=(220, 222, 226))
q, _ = qr_image('https://example.net/s/abc123', scale=5, border=4)
shot.paste(q.convert('RGB'), (430, 1600))
save('screenshot.png', shot, ['https://example.net/s/abc123'])

# A photo: the code printed on paper, seen at an angle, rotated, slightly blurred and noisy,
# saved as a JPEG whose pixels are stored sideways with EXIF Orientation 6.
q, _ = qr_image('https://example.com/photo-test', scale=10, border=4)
paper = Image.new('RGB', (1000, 1000), (232, 228, 220))
paper.paste(q.convert('RGB'), ((1000 - q.width) // 2, (1000 - q.height) // 2))
src = np.float32([[0, 0], [1000, 0], [1000, 1000], [0, 1000]])
dst = np.float32([[520, 260], [1480, 380], [1400, 1300], [430, 1150]])
M = cv2.getPerspectiveTransform(src, dst)
bg = np.zeros((1500, 2000, 3), np.uint8)
yy, xx = np.mgrid[0:1500, 0:2000]
bg[..., 0] = (90 + 40 * np.sin(xx / 37.0) + 20 * np.cos(yy / 23.0)).clip(0, 255)
bg[..., 1] = (70 + 30 * np.sin(yy / 41.0)).clip(0, 255)
bg[..., 2] = (50 + 25 * np.cos((xx + yy) / 53.0)).clip(0, 255)
warped = cv2.warpPerspective(np.array(paper), M, (2000, 1500), borderMode=cv2.BORDER_TRANSPARENT, dst=bg.copy())
warped = cv2.GaussianBlur(warped, (5, 5), 1.2)
noise = np.random.default_rng(7).normal(0, 4, warped.shape)
photo = Image.fromarray(np.clip(warped + noise, 0, 255).astype(np.uint8))
check('photo (upright)', photo, ['https://example.com/photo-test'])
stored = photo.transpose(Image.Transpose.ROTATE_90)   # stored sideways; Orientation 6 turns it back
exif = Image.Exif(); exif[0x0112] = 6
save('photo.jpg', stored, ['https://example.com/photo-test'], exif=exif.tobytes(), quality=72, width=2000, height=1500)

# A big picture (6000 x 4000, 24 megapixels) with the code small in one corner. PNG, as flat
# colours compress to a few kilobytes; decoding it is as much work as a camera JPEG.
big = Image.new('RGB', (6000, 4000), (128, 140, 150))
d = ImageDraw.Draw(big)
d.rectangle([3000, 0, 6000, 4000], fill=(110, 120, 128))
q, _ = qr_image('https://example.com/big-photo', scale=12, border=4)
big.paste(q.convert('RGB'), (5200, 3300))
save('big.png', big, ['https://example.com/big-photo'])

# The same URL code as WebP and GIF, to check other image formats.
img, _ = qr_image('https://example.com/webp', scale=6)
img.convert('RGB').save(os.path.join(HERE, 'code.webp'), lossless=True)
expected['code.webp'] = dict(texts=['https://example.com/webp'])
img, _ = qr_image('https://example.com/gif', scale=6)
img.convert('P').save(os.path.join(HERE, 'code.gif'))
expected['code.gif'] = dict(texts=['https://example.com/gif'])
# HEIC, as iPhones save photos (decoded on the page by the vendored libheif).
pillow_heif.register_heif_opener()
img, _ = qr_image('https://example.com/heic', scale=10)
img.convert('RGB').save(os.path.join(HERE, 'code.heic'), quality=90)
check('code.heic', Image.open(os.path.join(HERE, 'code.heic')), ['https://example.com/heic'])
expected['code.heic'] = dict(texts=['https://example.com/heic'])

# Not an image at all.
with open(os.path.join(HERE, 'notes.txt'), 'w') as f:
    f.write('This is a text file, not an image.\n')

expected['_checks'] = dict(good_iban=GOOD_IBAN, bad_iban=BAD_IBAN, emv=EMV, emv_crc=EMV[-4:])
with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
    json.dump(expected, f, ensure_ascii=False, indent=1, sort_keys=True)
print(len(expected) - 1, 'fixtures written and checked with zxing-cpp')
