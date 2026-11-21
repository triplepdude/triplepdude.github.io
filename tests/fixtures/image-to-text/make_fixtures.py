"""Makes the test pictures for the image to text page, and expected.json with
the text that was drawn into each one. The test compares what the page reads
with that text, which is known independently of the OCR engine.

    python3 tests/fixtures/image-to-text/make_fixtures.py

Needs Pillow (with AVIF), pillow-heif and pypdf, and the DejaVu, Liberation and
WenQuanYi Zen Hei fonts (fonts-dejavu-core, fonts-liberation, fonts-wqy-zenhei).
"""
import io
import json
import os
import struct
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SERIF = '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'
SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
LSANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
LSANS_BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'

PARA = [
    'Invoice 4471 was paid on 21 November 2026.',
    'The total of £1,234.56 includes VAT at 20%.',
    'Please keep this receipt for your records.',
]
PAGE1 = ['Page one of the scanned letter.', 'Dear Sam, thank you for your note.']
PAGE2 = ['Page two closes the letter.', 'With best wishes, Alex']
SPANISH = ['El niño leyó una canción.', 'Mañana iré a la estación.']
SMALL = ['Settings saved at 10:42', 'Battery health is 87 per cent']
DARK = ['Dark mode screenshot text', 'White letters on black']
SHADOW = ['A photo taken in poor light', 'still has words to read']
TEXT_PDF = ['This PDF already has a text layer.', 'Copy it exactly from the file.']
# The sample picture built into the page (its PNG is embedded as a data: URL).
SAMPLE = ['Library opening hours', 'Monday to Friday: 9:00 to 18:30', 'Saturday: 10:00 to 16:00',
          'Closed on Sundays and bank holidays']
CHINESE = ['今天天气很好。', '我们去公园散步吧。']
CJK = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
UI_BAR = 'Inbox (3 unread)'
UI_BODY = ['Meeting moved to Thursday at 3 pm', 'Reply by Friday, 12 December']


def text_image(lines, font_path=SERIF, size=34, pad=40, gap=14, fg=0, bg=255, mode='L'):
    font = ImageFont.truetype(font_path, size)
    widths = [font.getbbox(l)[2] for l in lines]
    asc, desc = font.getmetrics()
    lh = asc + desc
    w = max(widths) + 2 * pad
    h = len(lines) * lh + (len(lines) - 1) * gap + 2 * pad
    img = Image.new(mode, (w, h), bg)
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lines):
        d.text((pad, pad + i * (lh + gap)), l, font=font, fill=fg)
    return img


def save(img, name, **kw):
    img.save(os.path.join(HERE, name), **kw)


def exif_orientation(value):
    # A minimal little-endian TIFF block with one IFD entry: Orientation (0x0112).
    ifd = struct.pack('<H', 1) + struct.pack('<HHIHH', 0x0112, 3, 1, value, 0) + struct.pack('<I', 0)
    return b'Exif\x00\x00' + b'II*\x00' + struct.pack('<I', 8) + ifd


def text_pdf(lines):
    # One A5-ish page with real text in Helvetica, written by hand so the file
    # holds a text layer (Pillow only writes pictures into a PDF).
    content = 'BT /F1 18 Tf 50 300 Td 24 TL ' + ' '.join('(%s) Tj T*' % l.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') for l in lines) + ' ET'
    objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 360] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        '<< /Length %d >>\nstream\n%s\nendstream' % (len(content), content),
    ]
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n')
    offsets = []
    for i, o in enumerate(objs):
        offsets.append(out.tell())
        out.write(('%d 0 obj\n%s\nendobj\n' % (i + 1, o)).encode('latin-1'))
    xref = out.tell()
    out.write(('xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)).encode())
    for off in offsets:
        out.write(('%010d 00000 n \n' % off).encode())
    out.write(('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)).encode())
    return out.getvalue()


def main():
    expected = {}

    para = text_image(PARA)
    save(para, 'para.png', optimize=True)
    expected['para'] = '\n'.join(PARA)

    # The pixels are stored turned a quarter to the left; EXIF orientation 6
    # says "turn 90 degrees clockwise to show". Read without the tag, the text
    # runs bottom to top.
    turned = para.rotate(90, expand=True).convert('RGB')
    save(turned, 'turned.jpg', quality=92, exif=exif_orientation(6))

    # The same paragraph in other formats the shared decoder reads.
    save(para, 'para.tif', compression='tiff_lzw')
    import pillow_heif
    pillow_heif.register_heif_opener()
    save(para.convert('RGB'), 'para.heic', quality=90)
    save(para.convert('RGB'), 'para.avif', quality=90)

    # A PNG cut off after its first part: the decoder reports 'truncated'.
    buf = io.BytesIO()
    para.save(buf, 'PNG', optimize=True)
    data = buf.getvalue()
    with open(os.path.join(HERE, 'cut.png'), 'wb') as f:
        f.write(data[: int(len(data) * 0.5)])
    expected['cut_first_line'] = PARA[0]

    # Small screenshot text (x-height about 6 px).
    small = text_image(SMALL, font_path=SANS, size=11, pad=8, gap=3)
    save(small, 'small.png', optimize=True)
    expected['small'] = '\n'.join(SMALL)

    # Light text on a dark background.
    dark = text_image(DARK, font_path=SANS, size=30, fg=235, bg=28)
    save(dark, 'dark.png', optimize=True)
    expected['dark'] = '\n'.join(DARK)

    # Dark text under a strong shadow: the left third is nearly as dark as the letters.
    sh = text_image(SHADOW, size=36, pad=40)
    w, h = sh.size
    px = sh.load()
    for x in range(w):
        shade = 0.25 + 0.75 * min(1.0, x / (w * 0.6))
        for y in range(h):
            px[x, y] = int(px[x, y] * shade)
    save(sh, 'shadow.png', optimize=True)
    expected['shadow'] = '\n'.join(SHADOW)

    spa = text_image(SPANISH, size=36)
    save(spa, 'spanish.png', optimize=True)
    expected['spanish'] = '\n'.join(SPANISH)

    # A two-page scan: pictures only, no text layer.
    p1 = text_image(PAGE1, size=34).convert('RGB')
    p2 = text_image(PAGE2, size=34).convert('RGB')
    p1.save(os.path.join(HERE, 'scan.pdf'), 'PDF', resolution=150, save_all=True, append_images=[p2])
    expected['page1'] = '\n'.join(PAGE1)
    expected['page2'] = '\n'.join(PAGE2)

    # The same scan, locked with the password "open sesame".
    from pypdf import PdfReader, PdfWriter
    wr = PdfWriter()
    for pg in PdfReader(os.path.join(HERE, 'scan.pdf')).pages:
        wr.add_page(pg)
    wr.encrypt(user_password='open sesame', owner_password='owner', algorithm='RC4-128')
    with open(os.path.join(HERE, 'locked.pdf'), 'wb') as f:
        wr.write(f)

    with open(os.path.join(HERE, 'text.pdf'), 'wb') as f:
        f.write(text_pdf(TEXT_PDF))
    expected['text_pdf'] = '\n'.join(TEXT_PDF)

    # The page's sample: a bold heading and three lines, in 16 shades of grey.
    font_b = ImageFont.truetype(LSANS_BOLD, 26)
    font_r = ImageFont.truetype(LSANS, 24)
    smp = Image.new('L', (498, 223), 255)
    d = ImageDraw.Draw(smp)
    d.text((28, 30), SAMPLE[0], font=font_b, fill=0)
    for i, l in enumerate(SAMPLE[1:]):
        d.text((28, 84 + i * 40), l, font=font_r, fill=0)
    smp.quantize(colors=16, method=Image.Quantize.MEDIANCUT).save(os.path.join(HERE, 'sample.png'), optimize=True)
    expected['sample'] = '\n'.join(SAMPLE)

    # The paragraph turned 4 degrees anticlockwise, as a photo held slightly askew.
    para.rotate(4, expand=True, fillcolor=255, resample=Image.BICUBIC).save(os.path.join(HERE, 'skew.png'), optimize=True)

    # A screenshot: white text in a dark title bar over small grey body text
    # (x-height about 7 px). Evening out the lighting must not wipe out the bar.
    ui = Image.new('RGB', (620, 170), (255, 255, 255))
    d = ImageDraw.Draw(ui)
    d.rectangle((0, 0, 619, 64), fill=(30, 41, 59))
    d.text((20, 18), UI_BAR, font=ImageFont.truetype(LSANS_BOLD, 24), fill=(255, 255, 255))
    small_font = ImageFont.truetype(LSANS, 14)
    for i, l in enumerate(UI_BODY):
        d.text((20, 90 + i * 26), l, font=small_font, fill=(70, 70, 70))
    save(ui, 'ui.png', optimize=True)
    expected['ui'] = '\n'.join([UI_BAR] + UI_BODY)

    # Simplified Chinese, which the page reads with the chi_sim data.
    zh = text_image(CHINESE, font_path=CJK, size=40)
    save(zh, 'chinese.png', optimize=True)
    expected['chinese'] = '\n'.join(CHINESE)

    # Not a picture: plain text, and the same text under a picture's name.
    with open(os.path.join(HERE, 'notes.txt'), 'w', encoding='utf-8') as f:
        f.write('Just some text, not a picture.\n')
    with open(os.path.join(HERE, 'fake.png'), 'w', encoding='utf-8') as f:
        f.write('Just some text, not a picture.\n')

    # A white picture with nothing on it.
    save(Image.new('L', (400, 300), 255), 'blank.png', optimize=True)

    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(expected, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
