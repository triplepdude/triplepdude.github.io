#!/usr/bin/env python3
"""Makes the test PDFs for PDF to Text (tests/tools/pdf-to-text.test.js).

    python3 make_fixtures.py

Needs pikepdf, reportlab and Pillow, poppler's pdftotext, pypdf, and these fonts: DejaVu
Sans, Liberation Sans and IPA Gothic (fonts-dejavu-core, fonts-liberation, fonts-ipafont-gothic).

Every text is written here, so the test compares what the page extracts with the text that was
drawn (expected.json), not with an earlier extraction. The script also records what two other
programs make of the same files, poppler's pdftotext (default mode and -layout) and pypdf's
extract_text, under "others" in expected.json, and checks the claims the page's guide makes
about them. The 1,000-page and the 100 MB files are made by the test itself.
"""
import io
import json
import os
import subprocess
import zlib

import pikepdf
from pikepdf import Array, Dictionary, Name, Pdf
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
LSANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
IPA = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
expected = {}
others = {}


def out(name):
    return os.path.join(HERE, name)


def esc(s):
    return s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')


# ---------- A small writer for pages drawn with the standard fonts ----------
FONTS = {'F1': 'Times-Roman', 'F2': 'Helvetica', 'F3': 'Helvetica-Bold', 'F4': 'Times-Italic'}


class Page:
    def __init__(self, size=(612, 792)):
        self.size = size
        self.ops = []

    def text(self, x, y, s, font='F1', size=10, tc=0, tw=0, rise=0):
        self.ops.append('BT /%s %g Tf %g Tc %g Tw %g Ts %.2f %.2f Td (%s) Tj ET' % (font, size, tc, tw, rise, x, y, esc(s)))

    def tj(self, x, y, parts, font='F1', size=10, tc=0):
        arr = ' '.join('(%s)' % esc(p) if isinstance(p, str) else '%g' % p for p in parts)
        self.ops.append('BT /%s %g Tf %g Tc %.2f %.2f Td [%s] TJ ET' % (font, size, tc, x, y, arr))

    def width(self, s, font='F1', size=10):
        return stringWidth(s, FONTS[font], size)

    # A justified line: the word spacing fills the width (not for a paragraph's last line).
    def line(self, x, y, s, width, font='F1', size=10, last=False):
        w = self.width(s, font, size)
        assert w <= width + 0.01, (s, w, width)
        spaces = s.count(' ')
        tw = 0 if last or not spaces else (width - w) / spaces
        self.text(x, y, s, font, size, tw=tw)

    def raw(self, op):
        self.ops.append(op)


def write_std(pages, name, extra=None, plain=False):
    pdf = Pdf.new()
    fonts = Dictionary({'/' + k: pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name('/' + v),
                                                                  Encoding=Name.WinAnsiEncoding)) for k, v in FONTS.items()})
    for i, p in enumerate(pages):
        content = pdf.make_stream(('\n'.join(p.ops)).encode('cp1252'))
        d = Dictionary(Type=Name.Page, MediaBox=Array([0, 0, p.size[0], p.size[1]]), Resources=Dictionary(Font=fonts), Contents=content)
        for k, v in (extra or {}).get(i, {}).items():
            d[k] = v
        pdf.pages.append(pikepdf.Page(d))
    if plain:
        pdf.save(out(name), compress_streams=False, object_stream_mode=pikepdf.ObjectStreamMode.disable, qdf=True, deterministic_id=True)
    else:
        pdf.save(out(name), deterministic_id=True)
    return out(name)


def para_lines(page, x, y, lines, width, font='F1', size=10, lead=12, indent=0):
    for i, l in enumerate(lines):
        page.line(x + (indent if i == 0 else 0), y - i * lead, l, width - (indent if i == 0 else 0), font, size, last=i == len(lines) - 1)
    return y - len(lines) * lead


# ---------- columns.pdf: two columns, three pages ----------
# Paragraphs that run on across a column break and a page break, a footnote mark, hyphens at
# line ends (a split word, a compound split at its own hyphen, a name), a bulleted list with a
# hanging indent, first-line indents without space between paragraphs, a footnote, a table, and
# a running head and a page number on each page (drawn first on pages 1 and 3, last on page 2).
L, R, CW = 54, 318, 240
TITLE = 'The Ouse river survey'
SUB = 'Interim findings, November 2026'
H1 = '1. Introduction'
A = ['This report sets out what the first season of the',
     'survey found along the lower Ouse. Volunteers',
     'walked the banks every fortnight and took measure-',
     'ments of depth, colour and temperature at twelve',
     'fixed sites between York and Goole.']
B = ['The work was planned with the Yorkshire water',
     'trust and with local schools. A well-',
     'known problem with surveys of this kind is that the',
     'sites change between visits, so each one was marked',
     'with a numbered post. Jean-',
     'Paul Martin, who led the first walks, chose places',
     'where the bank was firm and the water was']
B2 = ['clearer than in the town centre, so that readings',
      'could be compared over the season.']
C = ['\u2022 Water samples from twelve sites',
     '\u2022 Counts of fish, birds and insects seen along both',
     'riverbanks at each site',
     '\u2022 Notes on bank erosion after floods']
D = ['The samples were tested within a day of being',
     'taken. Where a test could not be run in time, the',
     'sample was left out rather than estimated, and the',
     'lower reaches were']
D2 = ['affected most, because the boats that carry the',
      'samples upstream run only twice a week.']
H2 = '2. Results'
E = ['Depth changed little over the summer, except',
     'after the storms of late August, when the river rose',
     'by more than a metre in two days.']
F = ['Temperature followed the air, rising from 9 to',
     '19 degrees between May and July and falling again',
     'in September.']
G = ['Colour readings were the least reliable part of',
     'the work. Most volunteers2 found it hard to',
     'match the water against the printed chart in',
     'bright sunlight.']
FOOT2 = '2 Two of the twelve volunteers used tablets instead.'
H3 = '3. Measurements by site'
# A long line straight above the table, as close as the lines of a paragraph: the table's rows
# must not run into it.
INTRO = 'The table below gives the mean depth and temperature of all the readings taken at each site:'
TABLE = [('Site', 'Depth (m)', 'Temperature (C)'),
         ('Naburn', '2.4', '14.5'),
         ('Selby', '3.1', '15.0'),
         ('Goole', '5.8', '15.5')]
CLOSE = ['The full tables, with every reading, will follow in the final report next spring.']
HEAD_L, HEAD_R = 'Ouse River Survey', 'Interim report'


def head_foot(p, n):
    p.text(L, 760, HEAD_L, 'F2', 9)
    p.text(558 - p.width(HEAD_R, 'F2', 9), 760, HEAD_R, 'F2', 9)
    foot = 'Page %d of 3' % n
    p.text(306 - p.width(foot, 'F2', 9) / 2, 30, foot, 'F2', 9)


def make_columns():
    p1 = Page()
    head_foot(p1, 1)
    p1.text(306 - p1.width(TITLE, 'F3', 16) / 2, 716, TITLE, 'F3', 16)
    p1.text(306 - p1.width(SUB, 'F2', 11) / 2, 698, SUB, 'F2', 11)
    y = 668
    p1.text(L, y, H1, 'F3', 11)
    y -= 18
    y = para_lines(p1, L, y, A, CW)
    y -= 6
    y = para_lines(p1, L, y, B, CW)
    # Right column: the end of B, the list, D up to the page break.
    y = 668
    y = para_lines(p1, R, y, B2, CW)
    y -= 6
    for i, l in enumerate(C):
        x = R + (10 if not l.startswith('\u2022') else 0)
        p1.text(x, y, l)
        y -= 12
    # The list item's second line starts with a word that did not fit on its first.
    assert p1.width(C[1] + ' ' + C[2].split(' ')[0]) > CW, 'the list item would fit'
    y -= 6
    para_lines(p1, R, y, D, CW)
    p2 = Page()
    y = 740
    y = para_lines(p2, L, y, D2, CW)
    y -= 6
    p2.text(L, y, H2, 'F3', 11)
    y -= 18
    y = para_lines(p2, L, y, E, CW, indent=12)
    y = para_lines(p2, L, y, F, CW, indent=12)
    y = 740
    # G, with a footnote mark 2 raised after "volunteers", in a justified line.
    p2.line(R, y, G[0], CW)
    y -= 12
    a, b = G[1].split('2 ')
    nat = p2.width(a) + p2.width('2', 'F1', 6) + p2.width(' ' + b)
    tw = (CW - nat) / (a.count(' ') + 1 + b.count(' '))
    p2.raw('BT /F1 10 Tf %g Tw %.2f %.2f Td (%s) Tj /F1 6 Tf 3.5 Ts (2) Tj /F1 10 Tf 0 Ts ( %s) Tj ET' % (tw, R, y, esc(a), esc(b)))
    y -= 12
    y = para_lines(p2, R, y, G[2:], CW)
    p2.text(R, 60, FOOT2, 'F1', 8)
    head_foot(p2, 2)
    p3 = Page()
    head_foot(p3, 3)
    y = 740
    p3.text(L, y, H3, 'F3', 11)
    y -= 20
    p3.text(L, y, INTRO)
    assert p3.width(INTRO) > 360, 'the line is wider than the table'
    y -= 12
    cols = [L, L + 160, L + 300]
    for row in TABLE:
        for c, cell in enumerate(row):
            x = cols[c] if c == 0 else cols[c] + 60 - p3.width(cell)
            p3.text(x, y, cell)
        y -= 14
    y -= 10
    p3.text(L, y, CLOSE[0])
    write_std([p1, p2, p3], 'columns.pdf')
    paras_on = [TITLE, SUB, H1, ' '.join(A).replace('measure- ments', 'measurements'),
                ' '.join(B + B2).replace('well- known', 'wellknown').replace('Jean- Paul', 'Jean-Paul'),
                C[0], C[1] + ' ' + C[2], C[3],
                ' '.join(D + D2), H2, ' '.join(E), ' '.join(F),
                ' '.join(G), FOOT2, H3]
    expected['columns'] = {
        'paragraphs': paras_on,
        'intro': INTRO,
        'table': [list(r) for r in TABLE],
        'close': CLOSE[0],
        'heads': [HEAD_L, HEAD_R],
        'lines_page1': [HEAD_L + ' ' + HEAD_R, 'Page 1 of 3', TITLE, SUB, H1] + A + B + B2 + C + D,
    }


# ---------- spacing.pdf: letter spacing, kerning, dot leaders ----------
def make_spacing():
    p = Page()
    # As on the cover of the US Budget: letter spacing (Tc 0.15 em) with real spaces between words.
    p.text(72, 720, 'FISCAL YEAR 2024', 'F2', 16, tc=2.4)
    # A pair kerned 0.005 em apart under letter spacing of 0.1 em: PDF.js reads "B UDGET".
    p.tj(72, 690, ['OFFICE OF MANAGEMENT AND B', -5, 'UDGET'], 'F2', 9, tc=0.9)
    # Each word placed on its own, letters spaced with TJ offsets and no space characters.
    x = 72
    for w in ['SUMMARY', 'OF', 'FINDINGS']:
        parts = []
        for k, ch in enumerate(w):
            parts.append(ch)
            if k < len(w) - 1:
                parts.append(-150)
        p.tj(x, 660, parts, 'F3', 12)
        x += sum(p.width(ch, 'F3', 12) for ch in w) + (len(w) - 1) * 1.8 + 12
    # Dot leaders in a table of contents keep their spaces.
    p.text(72, 630, 'Introduction . . . . . . . . . . . . 3')
    # A plain sentence, for comparison.
    p.text(72, 600, 'Plain text with ordinary spacing stays as it is.')
    write_std([p], 'spacing.pdf')
    expected['spacing'] = ['FISCAL YEAR 2024', 'OFFICE OF MANAGEMENT AND BUDGET', 'SUMMARY OF FINDINGS',
                           'Introduction . . . . . . . . . . . . 3', 'Plain text with ordinary spacing stays as it is.']


# ---------- scripts.pdf: ligatures, Chinese, Japanese, Hebrew, Arabic, symbols ----------
def ttf_pdf(name, draw, size=(612, 792)):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size, invariant=1)
    draw(c)
    c.showPage()
    c.save()
    open(out(name), 'wb').write(buf.getvalue())


def make_scripts():
    pdfmetrics.registerFont(TTFont('DejaVu', DEJAVU))
    pdfmetrics.registerFont(TTFont('IPAGothic', IPA))
    zh1, zh2 = '這是一個中文段落的測試，文字', '在兩行之間不應該有空格。'
    ja1, ja2 = '日本語の文章を抽出するテスト', 'です。改行の後も続きます。'
    he = 'שלום עולם'
    ar = 'مرحبا بالعالم'
    lig = ['The \ufb01rst \ufb02oor of\ufb01ce', 'Ef\ufb01cient \ufb02ow']
    face = TTFont('IPAX', IPA).face
    for s in (zh1, zh2, ja1, ja2):
        missing = [ch for ch in s if ord(ch) not in face.charToGlyph]
        assert not missing, missing

    def draw(c):
        c.setFont('DejaVu', 14)
        c.drawString(72, 720, lig[0])
        c.drawString(72, 700, lig[1])
        c.setFont('IPAGothic', 14)
        c.drawString(72, 660, zh1)
        c.drawString(72, 642, zh2)
        # Japanese set with letter spacing, as justified lines are.
        t = c.beginText(72, 610)
        t.setFont('IPAGothic', 14)
        t.setCharSpace(2)
        t.textLine(ja1)
        t.textLine(ja2)
        c.drawText(t)
        c.setFont('DejaVu', 14)
        # Right-to-left text, drawn in visual order (letters reversed), as PDF writers do.
        c.drawString(72, 540, he[::-1])
        c.drawString(72, 520, ar[::-1])
        c.drawString(72, 500, 'Total ' + '42' + ' ' + he.split(' ')[0][::-1])
    ttf_pdf('scripts.pdf', draw)
    expected['scripts'] = {'ligatures': ['The first floor office', 'Efficient flow'], 'zh': zh1 + zh2, 'zh_lines': [zh1, zh2],
                           'ja': ja1 + ja2, 'ja_lines': [ja1, ja2], 'he': he, 'ar': ar, 'mixed_he': he.split(' ')[0]}


# ---------- symbols.pdf: characters without a Unicode meaning ----------
# A Type 3 font of three square glyphs whose ToUnicode maps them to a private-use code point,
# to U+FFFD, and to a letter: what a PDF.js-readable but unreadable font looks like.
def make_symbols():
    pdf = Pdf.new()
    procs = Dictionary()
    for name in ('a', 'b', 'c'):
        procs['/' + name] = pdf.make_stream(b'600 0 0 0 500 700 d1 50 0 400 700 re f')
    cmap = b'''/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
3 beginbfchar
<61> <E001>
<62> <FFFD>
<63> <0058>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end'''
    t3 = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type3, FontBBox=Array([0, 0, 600, 700]),
                                      FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]), CharProcs=procs,
                                      Encoding=Dictionary(Type=Name.Encoding, Differences=Array([97, Name.a, Name.b, Name.c])),
                                      FirstChar=97, LastChar=99, Widths=Array([600, 600, 600]), ToUnicode=pdf.make_stream(cmap),
                                      Resources=Dictionary()))
    helv = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))
    # Page 1: mostly readable text with a few symbols; page 2: nearly all symbols.
    c1 = b'BT /F1 12 Tf 72 720 Td (Readable text with three odd signs: ) Tj /T3 12 Tf (aab) Tj ET'
    c2 = b'BT /T3 12 Tf 72 720 Td (aaaaaaaabbbbbbbbaaaaaaac) Tj ET'
    for c in (c1, c2):
        pdf.pages.append(pikepdf.Page(Dictionary(Type=Name.Page, MediaBox=Array([0, 0, 612, 792]),
                                                 Resources=Dictionary(Font=Dictionary(F1=helv, T3=t3)), Contents=pdf.make_stream(c))))
    pdf.save(out('symbols.pdf'), deterministic_id=True)
    expected['symbols'] = {'page1': 'Readable text with three odd signs: \ue001\ue001\ufffd', 'page1_bad': 3,
                           'page2': '\ue001' * 8 + '\ufffd' * 8 + '\ue001' * 7 + 'X', 'page2_bad': 23}


# ---------- unreadable.pdf: a page of nothing but symbols ----------
# Its text is there but unreadable: it is not a page without text (a scan).
def make_unreadable():
    with Pdf.open(out('symbols.pdf')) as pdf:
        del pdf.pages[0]
        pdf.pages[0].Contents = pdf.make_stream(b'BT /T3 12 Tf 72 720 Td (aaaabbbb) Tj ET')
        pdf.save(out('unreadable.pdf'), deterministic_id=True)
    expected['unreadable'] = '\ue001' * 4 + '\ufffd' * 4


# ---------- Scans: a picture of text, with and without a stamp of real text ----------
SCAN_LINES = ['Minutes of the parish meeting', 'held on 4 March 2026.', 'The new footpath was approved.']


def scan_image():
    font = ImageFont.truetype(LSANS, 44)
    im = Image.new('L', (1700, 700), 255)
    d = ImageDraw.Draw(im)
    for i, l in enumerate(SCAN_LINES):
        d.text((120, 120 + i * 90), l, font=font, fill=0)
    return im


def image_pdf(name, im, extra=b''):
    pdf = Pdf.new()
    raw = im.tobytes()
    img = pdf.make_stream(zlib.compress(raw, 9), Type=Name.XObject, Subtype=Name.Image, Width=im.width, Height=im.height,
                          ColorSpace=Name.DeviceGray, BitsPerComponent=8, Filter=Name.FlateDecode)
    helv = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))
    w, h = 612, 612 * im.height / im.width
    content = ('q %g 0 0 %g 0 0 cm /Im0 Do Q ' % (w, h)).encode() + extra
    pdf.pages.append(pikepdf.Page(Dictionary(Type=Name.Page, MediaBox=Array([0, 0, w, h]), Contents=pdf.make_stream(content),
                                             Resources=Dictionary(XObject=Dictionary(Im0=img), Font=Dictionary(F1=helv)))))
    pdf.save(out(name), deterministic_id=True)


def make_scans():
    im = scan_image()
    image_pdf('tmp-scan.pdf', im)
    image_pdf('stamped.pdf', im, b'BT /F1 8 Tf 520 10 Td (Ref 1234) Tj ET')
    # A text page then the scan: the page with no text is offered for OCR.
    pdf = Pdf.open(out('tmp-scan.pdf'))
    text = Pdf.open(write_std([one_line_page('A typed cover page.')], 'tmp-cover.pdf'))
    text.pages.extend(pdf.pages)
    text.save(out('mixed-scan.pdf'), deterministic_id=True)
    os.remove(out('tmp-cover.pdf'))
    os.remove(out('tmp-scan.pdf'))
    expected['scan'] = {'lines': SCAN_LINES, 'stamp': 'Ref 1234', 'cover': 'A typed cover page.'}


def one_line_page(s, size=(612, 792)):
    p = Page(size)
    p.text(72, size[1] - 72, s)
    return p


# ---------- form.pdf: filled fields, annotations, a link, bookmarks, tags, an attachment ----------
def make_form():
    p = Page()
    p.text(72, 720, 'Application form', 'F3', 14)
    p.text(72, 690, 'Full name:')
    p.text(72, 660, 'Subscribe:')
    p.text(72, 630, 'Colour:')
    write_std([p], 'tmp-form.pdf')
    pdf = Pdf.open(out('tmp-form.pdf'))
    page = pdf.pages[0]
    helv = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))
    def ap(txt):
        return pdf.make_stream(('/Tx BMC BT /Helv 10 Tf 2 5 Td (%s) Tj ET EMC' % esc(txt)).encode('cp1252'), Type=Name.XObject,
                               Subtype=Name.Form, BBox=Array([0, 0, 200, 20]), Resources=Dictionary(Font=Dictionary(Helv=helv)))
    name = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=pikepdf.String('fullname'),
                                        TU=pikepdf.String('Full name'), V=pikepdf.String('Ada Lovelace'), Rect=Array([150, 685, 350, 705]),
                                        F=4, P=page.obj, AP=Dictionary(N=ap('Ada Lovelace')), DA=pikepdf.String('/Helv 10 Tf 0 g')))
    on = pdf.make_stream(b'0 g 2 2 12 12 re f', Type=Name.XObject, Subtype=Name.Form, BBox=Array([0, 0, 16, 16]))
    off = pdf.make_stream(b'', Type=Name.XObject, Subtype=Name.Form, BBox=Array([0, 0, 16, 16]))
    box = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Btn, T=pikepdf.String('subscribe'),
                                       TU=pikepdf.String('Subscribe to the newsletter'), V=Name.Yes, AS=Name.Yes,
                                       Rect=Array([150, 655, 166, 671]), F=4, P=page.obj, AP=Dictionary(N=Dictionary(Yes=on, Off=off))))
    choice = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Ch, Ff=131072, T=pikepdf.String('colour'),
                                          V=pikepdf.String('Green'), Opt=Array([pikepdf.String('Red'), pikepdf.String('Green')]),
                                          Rect=Array([150, 625, 250, 645]), F=4, P=page.obj, AP=Dictionary(N=ap('Green')),
                                          DA=pikepdf.String('/Helv 10 Tf 0 g')))
    empty = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=pikepdf.String('notes'),
                                         V=pikepdf.String(''), Rect=Array([150, 595, 350, 615]), F=4, P=page.obj))
    link = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array([72, 560, 200, 575]), Border=Array([0, 0, 0]),
                                        A=Dictionary(S=Name.URI, URI=pikepdf.String('https://example.org/'))))
    note = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=Array([400, 700, 420, 720]),
                                        Contents=pikepdf.String('A reviewer note that is not page text.')))
    # A signature field with a signature dictionary (its contents are not a real signature).
    sigv = pdf.make_indirect(Dictionary(Type=Name.Sig, Filter=Name('/Adobe.PPKLite'), SubFilter=Name('/adbe.pkcs7.detached'),
                                        ByteRange=Array([0, 0, 0, 0]), Contents=pikepdf.String(bytes(64)), Name=pikepdf.String('A Signer')))
    sig = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Sig, T=pikepdf.String('signature'),
                                       V=sigv, Rect=Array([72, 520, 272, 550]), F=4, P=page.obj))
    page.obj.Annots = Array([name, box, choice, empty, link, note, sig])
    pdf.Root.AcroForm = Dictionary(Fields=Array([name, box, choice, empty, sig]), DA=pikepdf.String('/Helv 10 Tf 0 g'),
                                   DR=Dictionary(Font=Dictionary(Helv=helv)), SigFlags=3)
    with pdf.open_outline() as outline:
        outline.root.append(pikepdf.OutlineItem('Application form', 0))
    pdf.Root.MarkInfo = Dictionary(Marked=True)
    pdf.Root.StructTreeRoot = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    pdf.attachments['readme.txt'] = pikepdf.AttachedFileSpec(pdf, b'An attached file.', mime_type='text/plain')
    pdf.save(out('form.pdf'), deterministic_id=True)
    os.remove(out('tmp-form.pdf'))
    expected['form'] = {'text': ['Application form', 'Full name:', 'Subscribe:', 'Colour:'],
                        'fields': ['Full name: Ada Lovelace', 'Subscribe to the newsletter: Yes', 'colour: Green']}


# ---------- Passwords and permissions ----------
BASE_TEXT = 'This PDF is locked with a password.'


def make_locked():
    write_std([one_line_page(BASE_TEXT)], 'tmp-base.pdf')
    base = Pdf.open(out('tmp-base.pdf'))
    allow_all = pikepdf.Permissions()
    variants = {
        'rc4-40.pdf': pikepdf.Encryption(owner='owner pw', user='open sesame', R=2, allow=allow_all, aes=False, metadata=False),
        'rc4-128.pdf': pikepdf.Encryption(owner='owner pw', user='open sesame', R=3, allow=allow_all, aes=False, metadata=False),
        'aes-128.pdf': pikepdf.Encryption(owner='owner pw', user='open sesame', R=4, aes=True, allow=allow_all),
        'aes-256.pdf': pikepdf.Encryption(owner='owner pw', user='open sesame', R=6, allow=allow_all),
        # A password with letters outside ASCII: qpdf writes it as UTF-8 for RC4 and AES-128.
        'unicode-aes-128.pdf': pikepdf.Encryption(owner='owner pw', user='caf\u00e9\u20ac', R=4, aes=True, allow=allow_all),
        'unicode-aes-256.pdf': pikepdf.Encryption(owner='owner pw', user='caf\u00e9\u20ac', R=6, allow=allow_all),
        # No open password; printing forbidden, copying allowed.
        'noprint.pdf': pikepdf.Encryption(owner='permit', user='', R=4, aes=True,
                                          allow=pikepdf.Permissions(print_lowres=False, print_highres=False)),
        # No open password; copying forbidden (permissions password "permit").
        'nocopy.pdf': pikepdf.Encryption(owner='permit', user='', R=6,
                                         allow=pikepdf.Permissions(extract=False, accessibility=False)),
        # An open password that is also needed for copying: the permissions password is different.
        'nocopy-locked.pdf': pikepdf.Encryption(owner='permit', user='open sesame', R=4, aes=True,
                                                allow=pikepdf.Permissions(extract=False, accessibility=False)),
    }
    for name, enc in variants.items():
        base.save(out(name), encryption=enc)
    # A password stored as Latin-1 bytes (as pypdf and older writers do), for RC4 128-bit.
    from pypdf import PdfWriter
    w = PdfWriter(clone_from=out('tmp-base.pdf'))
    w.encrypt(user_password='caf\u00e9', owner_password='owner pw', algorithm='RC4-128')
    with open(out('latin1-rc4.pdf'), 'wb') as f:
        w.write(f)
    os.remove(out('tmp-base.pdf'))
    for name in list(variants) + ['latin1-rc4.pdf']:
        # The bytes each writer stored: qpdf turns the password into PDFDocEncoding for AES-128
        # (\u20ac is 0xA0 there) and into UTF-8 for AES-256; pypdf writes Latin-1. poppler takes
        # the bytes as they are given.
        pw = {'unicode-aes-128.pdf': b'caf\xe9\xa0', 'unicode-aes-256.pdf': 'caf\u00e9\u20ac'.encode('utf8'),
              'latin1-rc4.pdf': b'caf\xe9', 'noprint.pdf': b'', 'nocopy.pdf': b''}.get(name, b'open sesame')
        info = subprocess.run([b'pdfinfo'] + ([b'-upw', pw] if pw else []) + [out(name).encode()], capture_output=True).stdout.decode('utf8', 'replace')
        assert 'Encrypted:       yes' in info, (name, info)
    expected['locked'] = {'text': BASE_TEXT, 'password': 'open sesame', 'permissions': 'permit', 'unicode': 'caf\u00e9\u20ac', 'latin1': 'caf\u00e9'}


# ---------- locked-pages.pdf: three pages behind an open password ----------
# For a double click on Open PDF: the file is opened once and every page read.
LOCKED_PAGES = ['First locked page.', 'Second locked page.', 'Third locked page.']


def make_locked_pages():
    write_std([one_line_page(t) for t in LOCKED_PAGES], 'tmp-pages.pdf')
    with Pdf.open(out('tmp-pages.pdf')) as base:
        base.save(out('locked-pages.pdf'), encryption=pikepdf.Encryption(owner='owner pw', user='open sesame', R=6))
    os.remove(out('tmp-pages.pdf'))
    expected['locked_pages'] = LOCKED_PAGES


# ---------- Damaged files and odd structures ----------
def make_structures():
    base = write_std([one_line_page('Page one of the structure test.'), one_line_page('Page two of the structure test.')], 'tmp-struct.pdf')
    src = Pdf.open(base)
    src.save(out('objstm.pdf'), object_stream_mode=pikepdf.ObjectStreamMode.generate, deterministic_id=True)
    src.save(out('linearized.pdf'), linearize=True, deterministic_id=True)
    src.save(out('pdf20.pdf'), force_version='2.0', deterministic_id=True)
    # An incremental update that replaces page one's text: the newer text is the one shown.
    data = open(base, 'rb').read()
    # (qpdf cannot append to a file, so the update is written by hand: a new content stream, the
    # page that uses it, a cross-reference section for the two and a trailer with /Prev.)
    new_obj_num = int(src.trailer.Size)
    content = b'BT /F1 10 Tf 72 720 Td (Page one, as updated later.) Tj ET'
    page_num = src.pages[0].obj.objgen[0]
    page_dict = src.pages[0].obj
    fonts = page_dict.Resources.Font
    font_refs = ' '.join('/%s %d 0 R' % (k[1:], v.objgen[0]) for k, v in fonts.items())
    parent = page_dict.Parent.objgen[0]
    off = len(data)
    upd = b''
    o1 = off
    upd += b'%d 0 obj\n<< /Length %d >>\nstream\n' % (new_obj_num, len(content)) + content + b'\nendstream\nendobj\n'
    o2 = off + len(upd)
    upd += (b'%d 0 obj\n<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << %s >> >> /Contents %d 0 R >>\nendobj\n'
            % (page_num, parent, font_refs.encode(), new_obj_num))
    xref = off + len(upd)
    prev = int(data[data.rindex(b'startxref') + 9:].split()[0])
    upd += b'xref\n%d 1\n%010d 00000 n \n%d 1\n%010d 00000 n \n' % (page_num, o2, new_obj_num, o1)
    upd += b'trailer\n<< /Size %d /Root %d 0 R /Prev %d /ID [<%s><%s>] >>\nstartxref\n%d\n%%%%EOF\n' % (
        new_obj_num + 1, src.Root.objgen[0], prev, bytes(src.trailer.ID[0]).hex().encode(), bytes(src.trailer.ID[1]).hex().encode(), xref)
    open(out('incremental.pdf'), 'wb').write(data + upd)
    # Damaged: cut off (before its catalogue, and only after its last page), garbage in the
    # middle, one page's text stream garbled, a broken cross-reference table, not a PDF at all.
    good = open(out('columns.pdf'), 'rb').read()
    open(out('cut.pdf'), 'wb').write(good[:int(len(good) * 0.6)])
    mid = len(good) // 2
    open(out('garbage.pdf'), 'wb').write(good[:mid] + bytes((i * 37) % 251 for i in range(3000)) + good[mid + 3000:])
    write_std([one_line_page('First page of three.'), one_line_page('Second page of three.'),
               one_line_page('Third page of three.')], 'tmp-three-plain.pdf', plain=True)
    plain = open(out('tmp-three-plain.pdf'), 'rb').read()
    # The catalogue comes first in this file, so losing the end only loses the cross-reference table.
    open(out('cut-tail.pdf'), 'wb').write(plain[:plain.rindex(b'xref') - 1])
    # Page two's content stream claims to be Flate-compressed but is not.
    i = plain.index(b'(Second page of three.)')
    j = plain.rindex(b'stream', 0, i)
    d = plain.rindex(b'<<', 0, j)
    bad = plain[:d] + plain[d:j].replace(b'<<', b'<< /Filter /FlateDecode', 1) + plain[j:]
    open(out('badpage.pdf'), 'wb').write(bad)
    os.remove(out('tmp-three-plain.pdf'))
    sx = data.rindex(b'startxref')
    open(out('badxref.pdf'), 'wb').write(data[:sx] + b'startxref\n999999\n%%EOF\n')
    open(out('notpdf.pdf'), 'w').write('This is a plain text file with a .pdf name.\n')
    open(out('word.pdf'), 'wb').write(b'PK\x03\x04' + bytes(200))
    os.remove(base)
    # Pages of mixed sizes, turned 90 and 270 degrees (inherited from the page tree), with a
    # UserUnit and with a crop box smaller than the media box (text outside it is not shown).
    pages = [one_line_page('A portrait page.'), one_line_page('A landscape page, turned.', (792, 612)),
             one_line_page('A page turned the other way.'), one_line_page('A page with a large unit.', (300, 300))]
    cropped = Page()
    cropped.text(72, 720, 'Inside the crop box.')
    cropped.text(72, 40, 'Outside the crop box.')
    pages.append(cropped)
    write_std(pages, 'tmp-rot.pdf', {3: {'/UserUnit': 2}, 4: {'/CropBox': Array([0, 300, 612, 792])}})
    pdf = Pdf.open(out('tmp-rot.pdf'))
    # Pages 2 and 3 sit in a page tree node of their own with /Rotate 90 and 270.
    root = pdf.Root.Pages
    node90 = pdf.make_indirect(Dictionary(Type=Name.Pages, Kids=Array([]), Count=1, Parent=root, Rotate=90))
    node270 = pdf.make_indirect(Dictionary(Type=Name.Pages, Kids=Array([]), Count=1, Parent=root, Rotate=270))
    kids = list(root.Kids)
    p2, p3 = kids[1], kids[2]
    p2.Parent = node90
    node90.Kids.append(p2)
    p3.Parent = node270
    node270.Kids.append(p3)
    root.Kids = Array([kids[0], node90, node270, kids[3], kids[4]])
    pdf.save(out('rotated.pdf'), deterministic_id=True)
    os.remove(out('tmp-rot.pdf'))
    expected['structures'] = {'two': ['Page one of the structure test.', 'Page two of the structure test.'],
                              'updated': 'Page one, as updated later.',
                              'three': ['First page of three.', 'Second page of three.', 'Third page of three.'],
                              'rotated': ['A portrait page.', 'A landscape page, turned.', 'A page turned the other way.',
                                          'A page with a large unit.', 'Inside the crop box.', 'Outside the crop box.']}


# ---------- sample.pdf: the page's own sample ----------
def make_sample():
    p = Page()
    p.text(72, 740, 'A SAMPLE REPORT', 'F2', 11, tc=1.8)
    p.text(72, 712, 'Reading the text of a PDF', 'F3', 16)
    ls = ['A PDF stores each line of text where it is drawn,',
          'so copying from a viewer often breaks sentences',
          'and joins columns together. This page puts the',
          'lines back into paragraphs, joins words split by a',
          'hyphen at the end of a line, such as docu-',
          'ments, and keeps the columns in reading order.']
    rs = ['Choose Layout to keep a table lined up:',
          '']
    y = para_lines(p, 72, 680, ls, 220)
    p.text(320, 680, rs[0])
    rows = [('Month', 'Visits'), ('January', '1,204'), ('February', '1,876')]
    for i, (a, b) in enumerate(rows):
        p.text(320, 656 - i * 14, a)
        p.text(500 - p.width(b), 656 - i * 14, b)
    foot = 'Sample page 1'
    p.text(306 - p.width(foot, 'F2', 9) / 2, 40, foot, 'F2', 9)
    write_std([p], 'sample.pdf')
    expected['sample'] = {'heading': 'A SAMPLE REPORT', 'title': 'Reading the text of a PDF',
                          'para': ' '.join(ls).replace('docu- ments', 'documents'), 'note': rs[0],
                          'rows': [list(r) for r in rows], 'foot': foot}


# ---------- rtl.pdf: right-to-left text as LibreOffice and Chrome write it ----------
# LibreOffice draws a right-to-left line as runs in reading order, each placed to the left of
# the one before: the words, a number and a full stop are runs of their own. Two Hebrew
# paragraphs follow each other without space between them (the first ends in a short line),
# then an Arabic one. Chrome (and Google Docs) map Arabic glyphs to their presentation forms
# (U+FE80 to U+FEFC), which look the same but are other characters; NFKC gives the letters.
RTL_HE = ['שלום עולם. בשנת 2024 נערך סקר של 12 אתרים לאורך הנהר, והתוצאות פורסמו בדוח מפורט שהוגש לוועדה בסוף השנה.',
          'פסקה שנייה מתחילה כאן ונמשכת עד 3 שורות כדי לבדוק את הסוף של הפסקה.']
RTL_AR = 'مرحبا بالعالم. في عام 2024 أجري مسح لـ 12 موقعا على طول النهر.'
# "مرحبا بالعالم" in presentation forms, in reading order.
RTL_PF = '\ufee3\ufeae\ufea3\ufe92\ufe8e \ufe91\ufe8e\ufedf\ufecc\ufe8e\ufedf\ufee2'


def make_rtl():
    import unicodedata
    pdfmetrics.registerFont(TTFont('DejaVu', DEJAVU))
    assert unicodedata.normalize('NFKC', RTL_PF) == 'مرحبا بالعالم'
    size, right, width, lead = 12, 540, 300, 16
    sw = lambda s: stringWidth(s, 'DejaVu', size)

    # The words of a paragraph in lines no wider than width (the next word did not fit).
    def fill(text):
        lines, cur = [], []
        for w in text.split(' '):
            if cur and sw(' '.join(cur + [w])) > width:
                lines.append(cur)
                cur = []
            cur.append(w)
        return lines + [cur]

    # A line as LibreOffice draws it: runs of words, numbers and full stops, right to left.
    def draw_line(c, y, words):
        runs = []
        for w in words:
            body, stop = (w[:-1], '.') if w.endswith('.') and not w[:-1].isdigit() else (w, '')
            if runs and not body.isdigit() and not runs[-1][0].isdigit() and runs[-1][0] != '.':
                runs[-1][0] += ' ' + body
            else:
                runs.append([body, ' '])
            if stop:
                runs.append(['.', ''])
        x = right
        for k, (run, before) in enumerate(runs):
            if k and before:
                x -= sw(' ')
            x -= sw(run)
            # The letters of a right-to-left run are drawn left to right, so in reverse; digits not.
            c.drawString(x, y, run if run.isdigit() else run[::-1])

    lines = {'he': [fill(t) for t in RTL_HE], 'ar': fill(RTL_AR)}
    assert all(len(p) >= 2 for p in lines['he']) and len(lines['ar']) >= 2
    assert sw(' '.join(lines['he'][0][-1]) + ' ' + RTL_HE[1].split(' ')[0]) < width - 20, 'the next word would fit'

    def draw(c):
        c.setFont('DejaVu', size)
        y = 720
        for para in lines['he']:
            for words in para:
                draw_line(c, y, words)
                y -= lead
        y -= 14
        for words in lines['ar']:
            draw_line(c, y, words)
            y -= lead
        y -= 14
        c.drawString(right - sw(RTL_PF), y, RTL_PF[::-1])
    ttf_pdf('rtl.pdf', draw)
    expected['rtl'] = {'he': RTL_HE, 'ar': RTL_AR, 'pf': unicodedata.normalize('NFKC', RTL_PF),
                       'he_lines': [' '.join(w) for p in lines['he'] for w in p]}


# ---------- caseless.pdf: Chinese and Hebrew paragraphs over column and page breaks ----------
# Scripts without capital letters give no sign that a line continues a paragraph, but a line
# that fills its column and does not end a sentence does. On page 1, a Chinese paragraph runs
# from the first column into the second, and another from the second column into page 2. There,
# a short heading at the foot of the first column is not joined to the text at the top of the
# second, and a Hebrew paragraph runs from the right column into the left one. Page 2 ends with
# a short heading, which is not joined to the text at the top of page 3.
ZH_A = '本報告介紹了河流研究第一季的結果。志願者每兩週沿河岸行走一次，在約克和古爾之間的十二個固定地點測量水的深度、顏色和溫度，並將讀數與前幾個季節的記錄進行比較。'
ZH_B = '這項工作是與當地學校和水務信託機構共同規劃的。這類研究中大家都知道的一個問題是，地點在兩次訪問之間會發生一些變化，因此每個地點都用編號的柱子標記，以便在整個季節中比較讀數。'
ZH_HEAD = '第二部分結果'
ZH_C = '結果表明，下游河段的水溫在夏季明顯高於上游，而水的顏色在洪水之後變化最大。'
ZH_HEAD2 = '第三部分'
ZH_D = '下一季我們將繼續測量，並增加對魚類和鳥類的觀察。'
HE_A = 'הדוח השנתי של עמותת הנהר מתאר את הפעילות של המתנדבים לאורך אתרים קבועים. המדידות כללו עומק, צבע וטמפרטורה, והן הושוו לנתונים של שנים קודמות ולרשומות של רשות המים לאורך כל העונה.'


def make_caseless():
    pdfmetrics.registerFont(TTFont('IPAGothic', IPA))
    pdfmetrics.registerFont(TTFont('DejaVu', DEJAVU))
    size, lead, per, top = 12, 18, 18, 740   # 18 characters of 12 pt fill a 216 pt column
    left, right, width = 54, 330, 216
    chunks = lambda t: [t[i:i + per] for i in range(0, len(t), per)]
    face = TTFont('IPAX', IPA).face
    missing = [ch for ch in ZH_A + ZH_B + ZH_HEAD + ZH_C + ZH_HEAD2 + ZH_D if ord(ch) not in face.charToGlyph]
    assert not missing, missing
    a, b = chunks(ZH_A), chunks(ZH_B)
    # Neither column nor page break falls at the end of a sentence or before punctuation.
    assert len(a) >= 4 and len(b) >= 4 and not a[-3].endswith('。') and not b[-3].endswith('。')
    assert a[-2][0] not in '，。、' and b[-2][0] not in '，。、'
    he, cur = [], ''
    for w in HE_A.split(' '):
        if cur and stringWidth(cur + ' ' + w, 'DejaVu', 11) > width:
            he.append(cur)
            cur = w
        else:
            cur = (cur + ' ' + w).strip()
    he.append(cur)
    half = (len(he) + 1) // 2
    assert half >= 2 and not he[half - 1].endswith('.')

    def draw(c):
        c.setFont('IPAGothic', size)
        for k, line in enumerate(a[:-2]):
            c.drawString(left, top - k * lead, line)
        for k, line in enumerate(a[-2:] + [''] + b[:-2]):
            if line:
                c.drawString(right, top - k * lead, line)
        c.showPage()
        c.setFont('IPAGothic', size)
        for k, line in enumerate(b[-2:] + ['', ZH_HEAD]):
            if line:
                c.drawString(left, top - k * lead, line)
        for k, line in enumerate(chunks(ZH_C)):
            c.drawString(right, top - k * lead, line)
        c.setFont('DejaVu', 11)
        for k, line in enumerate(he):
            # Right to left: the right column comes first, its letters drawn in reverse.
            x, row = (right, k) if k < half else (left, k - half)
            c.drawString(x + width - stringWidth(line, 'DejaVu', 11), 560 - row * 16, line[::-1])
        c.setFont('IPAGothic', size)
        c.drawString(left, 420, ZH_HEAD2)
        c.showPage()
        c.setFont('IPAGothic', size)
        for k, line in enumerate(chunks(ZH_D)):
            c.drawString(left, top - k * lead, line)

    ttf_pdf('caseless.pdf', draw)
    expected['caseless'] = [ZH_A, ZH_B, ZH_HEAD, ZH_C, HE_A, ZH_HEAD2, ZH_D]


# ---------- statement.pdf: a table over three pages ----------
# A statement's first and last rows lie in the top and bottom eighths of each page, where
# running heads are looked for, and with their numbers replaced they look alike from page to
# page; they are not running heads. The running head and the page number are.
STATEMENT_HEAD = ['Date', 'Description', 'Amount']


def statement_rows(n):
    rows = []
    for k in range(30):
        day = 1 + (k * 31 + n) % 28
        rows.append(['2026-%02d-%02d' % (n, day), 'Card payment', '%d.%02d' % (10 + (k * 37 + n * 11) % 90, (k * 13) % 100)])
    return rows


def make_statement():
    pages = []
    for n in range(1, 4):
        p = Page()
        p.text(54, 772, 'Riverside Credit Union', 'F2', 8)
        p.text(558 - p.width('Statement of account', 'F2', 8), 772, 'Statement of account', 'F2', 8)
        y = 750
        for row in [STATEMENT_HEAD] + statement_rows(n):
            font = 'F3' if row is STATEMENT_HEAD else 'F2'
            p.text(54, y, row[0], font, 9)
            p.text(160, y, row[1], font, 9)
            p.text(420 - p.width(row[2], font, 9), y, row[2], font, 9)
            y -= 22
        foot = 'Page %d of 3' % n
        p.text(306 - p.width(foot, 'F2', 8) / 2, 24, foot, 'F2', 8)
        pages.append(p)
    write_std(pages, 'statement.pdf')
    expected['statement'] = {'head': STATEMENT_HEAD, 'pages': [statement_rows(n) for n in range(1, 4)],
                             'running': ['Riverside Credit Union Statement of account', 'Page 1 of 3']}


# ---------- log.pdf: a log over three pages ----------
# Each line of the log is one piece of text, with a page number at the foot of each page. The
# first lines of each page lie where running heads are looked for and look alike with their
# numbers replaced, but their times and readings change from page to page: they are kept.
def log_lines(n):
    return ['2026-03-%02d %02d:%02d Pump %d started at %d.%d bar' % (n, 6 + k, (n * 7 + k * 13) % 60, k % 3 + 1, 20 + (n + k) % 9, (n * k) % 10)
            for k in range(6)]


def make_log():
    pages = []
    for n in range(1, 4):
        p = Page()
        y = 750
        for line in log_lines(n):
            p.text(54, y, line, 'F2', 10)
            y -= 14
        p.text(306 - p.width(str(n), 'F2', 9) / 2, 30, str(n), 'F2', 9)
        pages.append(p)
    write_std(pages, 'log.pdf')
    expected['log'] = [log_lines(n) for n in range(1, 4)]


# ---------- chapters.pdf: footers that name their chapter, a table continued over pages ----------
# Eighteen pages in three chapters. Each page ends with a footer that names its chapter and
# gives the page number, on the left of odd pages and the right of even ones, so each form of it
# is on a sixth of the pages, every other page. A table runs over pages 8 to 11, its heading
# repeated at the top of the pages it continues on; pages 2, 4 and 6 have the number of a figure
# at the top, and chapter 3 a running head. Page 1 has a table of contents, and the heading of
# chapter 2 is drawn twice, as some programs make text bold.
CHAPTERS = [(1, 'Rivers', range(1, 7)), (2, 'Lakes', range(7, 13)), (3, 'Coasts', range(13, 19))]
LEVELS = [['Naburn', '2.41'], ['Selby', '3.07'], ['Goole', '5.82'], ['Hull', '6.15']]
BODIES = ['Volunteers counted herons near the weir at dawn.', 'The bank had slipped after the February storm.',
          'Water samples were taken from both sides of the bridge.', 'A new footpath now follows the old towing path.',
          'Otters were seen twice, both times in the evening.', 'Litter was collected by the school on a Saturday.',
          'The lake froze over for nine days in January.', 'Reeds have spread along the northern shore.',
          'Anglers reported fewer perch than last year.', 'The boathouse roof was repaired in the spring.',
          'Algae bloomed in the shallow bay during July.', 'Swans nested on the island for the first time.',
          'The coast path was closed after a landslip.', 'Seals hauled out on the sandbank most mornings.',
          'Storm surge reached the car park in October.', 'Rock pools were surveyed at the lowest tides.',
          'Sea kale flowered on the shingle ridge.', 'The groynes were inspected by the council.']
TABLE2 = 'Table 2. Water levels'
CONTENTS = [('Rivers and their banks', 1), ('Lakes', 7), ('Coasts and estuaries', 13)]


def toc_entry(p, title, at):
    s = title + ' '
    while p.width(s + '. ' + str(at)) < 250:
        s += '. '
    return s + str(at)


def make_chapters():
    pages, paras = [], []
    for ch, name, nums in CHAPTERS:
        for n in nums:
            p = Page()
            y = 700
            if n == nums[0]:
                p.text(54, y, 'Chapter %d. %s' % (ch, name), 'F3', 14)
                if ch == 2:
                    # Drawn again a little to the right, to look bolder: the text is kept once.
                    p.text(54.4, y, 'Chapter %d. %s' % (ch, name), 'F3', 14)
                paras.append('Chapter %d. %s' % (ch, name))
                y -= 28
            if n in (9, 10, 11):
                p.text(54, 750, TABLE2 + ' (continued)', 'F3', 10)
                if n == 9:
                    paras.append(TABLE2 + ' (continued)')
            if n in (2, 4, 6):
                # A figure every other page, its number at the top: Figure 1, 2 and 3 are not page
                # numbers, which would go up by two.
                cap = 'Figure %d.' % (n // 2)
                p.text(54, 750, cap, 'F3', 10)
                paras.append(cap)
            if ch == 3:
                # A running head through chapter 3, kept where it first comes, and under it on
                # every other page a line that is not the top of its page: kept on each.
                p.text(54, 770, 'Coastal survey', 'F2', 8)
                if n == nums[0]:
                    paras.append('Coastal survey')
                if n % 2 == 0:
                    p.text(54, 750, 'Notes from the shore', 'F3', 10)
                    paras.append('Notes from the shore')
            p.text(54, y, BODIES[n - 1])
            paras.append(BODIES[n - 1])
            y -= 24
            if n == 1:
                # A table of contents: dot leaders up to page numbers set flush right.
                for title, at in CONTENTS:
                    entry = toc_entry(p, title, at)
                    p.text(54, y, entry)
                    paras.append(entry)
                    y -= 14
                y -= 10
            if n in (8, 9, 10, 11):
                if n == 8:
                    p.text(54, y, TABLE2, 'F3', 10)
                    paras.append(TABLE2)
                    y -= 18
                for site, level in LEVELS:
                    p.text(54, y, site)
                    p.text(260 - p.width(level), y, level)
                    y -= 14
                paras.append('\n'.join('\t'.join(r) for r in LEVELS))
            foot = 'Chapter %d: %s' % (ch, name)
            left, right = (foot, str(n)) if n % 2 else (str(n), foot)
            p.text(54, 30, left, 'F2', 8)
            p.text(558 - p.width(right, 'F2', 8), 30, right, 'F2', 8)
            pages.append(p)
    write_std(pages, 'chapters.pdf')
    expected['chapters'] = {'paragraphs': paras, 'foot': 'Chapter 1: Rivers 1'}


# ---------- What other programs make of these files ----------
def others_for(name, password=None, pages=None):
    args = ['pdftotext', '-enc', 'UTF-8']
    if password:
        args += ['-upw', password]
    if pages:
        args += ['-f', str(pages[0]), '-l', str(pages[1])]
    raw = subprocess.run(args + [out(name), '-'], capture_output=True).stdout.decode('utf8')
    lay = subprocess.run(args + ['-layout', out(name), '-'], capture_output=True).stdout.decode('utf8')
    try:
        r = PdfReader(out(name), password=password)
        py = '\f'.join(p.extract_text() or '' for p in r.pages)
    except Exception as e:  # noqa: BLE001
        py = 'ERROR ' + type(e).__name__
    return {'pdftotext': raw, 'pdftotext_layout': lay, 'pypdf': py}


def main():
    make_columns()
    make_spacing()
    make_scripts()
    make_symbols()
    make_unreadable()
    make_scans()
    make_form()
    make_locked()
    make_locked_pages()
    make_structures()
    make_sample()
    make_rtl()
    make_caseless()
    make_statement()
    make_chapters()
    make_log()
    for name in ['columns.pdf', 'spacing.pdf', 'scripts.pdf', 'symbols.pdf', 'form.pdf', 'sample.pdf', 'rotated.pdf', 'incremental.pdf', 'rtl.pdf', 'caseless.pdf', 'statement.pdf', 'chapters.pdf']:
        others[name] = others_for(name)
    expected['others'] = others
    with open(out('expected.json'), 'w', encoding='utf8') as f:
        json.dump(expected, f, ensure_ascii=False, indent=1)
    sizes = {n: os.path.getsize(out(n)) for n in sorted(os.listdir(HERE)) if n.endswith('.pdf')}
    for n, s in sizes.items():
        assert s < 100_000, (n, s)
    print('\n'.join('%-22s %7d' % kv for kv in sizes.items()))


if __name__ == '__main__':
    main()
