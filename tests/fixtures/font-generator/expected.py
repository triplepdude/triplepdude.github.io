"""Expected output of every style of the font generator, worked out independently of the
page: each styled character is found by its Unicode character name (Python's unicodedata),
not by code point arithmetic, and characters a reader sees as one are split with the
regex module's \\X. Run with:  python3 expected.py  (writes expected.json next to it)."""
import json
import os
import unicodedata as ud

import regex

INPUTS = {
    'default': 'Fancy Text 123',
    'alphabet': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789',
    'greek': 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ ϴ αβγδεζηθικλμνξοπρςστυφχψω ϵϑϰϕϱϖ Ϝϝ ıȷ',
    'accents': 'Crème brûlée, ÉCOLE, mañana, ά, Straße, Œuvre, café',
    'mixed': 'Hi 👋🏽 there!\nLine (2) 🇬🇧 + x = y?',
    'symbols': 'H2O & CO2: 1+1=2; [a] {b} <c> _d_ "e" \'f\' ¿g? ¡h!',
    'back': 'Back test',
    'hello': 'Hello',
}

MATH = ['BOLD', 'ITALIC', 'BOLD ITALIC', 'SCRIPT', 'BOLD SCRIPT', 'FRAKTUR', 'BOLD FRAKTUR', 'DOUBLE-STRUCK',
        'SANS-SERIF', 'SANS-SERIF BOLD', 'SANS-SERIF ITALIC', 'SANS-SERIF BOLD ITALIC', 'MONOSPACE']
IDS = ['bold', 'italic', 'bold-italic', 'script', 'bold-script', 'fraktur', 'bold-fraktur', 'double',
       'sans', 'sans-bold', 'sans-italic', 'sans-bold-italic', 'mono']


def look(*names):
    for n in names:
        try:
            return ud.lookup(n)
        except KeyError:
            pass
    return None


def parts(c):
    """(case, letter) from a character name: ('CAPITAL', 'A'), ('SMALL', 'FINAL SIGMA'), ('DIGIT', 'ONE')."""
    n = ud.name(c, '')
    m = regex.match(r'(?:LATIN|GREEK) (CAPITAL|SMALL) LETTER (.+)$', n)
    if m:
        return m.group(1), m.group(2)
    m = regex.match(r'GREEK (CAPITAL )?(?:LUNATE )?(\w+ SYMBOL)$', n)
    if m:
        return (m.group(1) or '').strip(), m.group(2)
    if n == 'GREEK LETTER DIGAMMA':
        return 'CAPITAL', 'DIGAMMA'
    m = regex.match(r'DIGIT (\w+)$', n)
    if m:
        return 'DIGIT', m.group(1)
    return None


def math_style(style):
    def f(c):
        p = parts(c)
        if not p:
            return None
        case, letter = p
        names = [f'MATHEMATICAL {style} DIGIT {letter}' if case == 'DIGIT' else f'MATHEMATICAL {style} {case} {letter}'.replace('  ', ' ')]
        # The block leaves holes for Latin letters that Letterlike Symbols already had.
        if ud.name(c).startswith('LATIN') and len(letter) == 1:
            if style == 'SCRIPT':
                names.append(f'SCRIPT {case} {letter}')
            elif style == 'FRAKTUR':
                names.append(f'BLACK-LETTER {case} {letter}')
            elif style == 'DOUBLE-STRUCK':
                names.append(f'DOUBLE-STRUCK {case} {letter}')
            elif style == 'ITALIC' and (case, letter) == ('SMALL', 'H'):
                names.append('PLANCK CONSTANT')
        return look(*names)
    return f


DIGIT_NAMES = 'ZERO ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE'.split()
SIGNS = {'+': 'PLUS SIGN', '-': 'MINUS', '=': 'EQUALS SIGN', '(': 'LEFT PARENTHESIS', ')': 'RIGHT PARENTHESIS'}


def ascii_letter(c):
    return c.isascii() and c.isalpha()


def small_caps(c):
    if c in 'xX':
        return 'x'  # there is no small capital x
    return look('LATIN LETTER SMALL CAPITAL ' + c.upper()) if ascii_letter(c) else None


def superscript(c):
    if c.isascii() and c.isdigit():
        return look('SUPERSCRIPT ' + DIGIT_NAMES[int(c)])
    if c in SIGNS:
        return look('SUPERSCRIPT ' + SIGNS[c])
    if not ascii_letter(c):
        return None
    small = look('SUPERSCRIPT LATIN SMALL LETTER ' + c.upper(), 'MODIFIER LETTER SMALL ' + c.upper())
    if c.islower():
        return small
    cap = look('MODIFIER LETTER CAPITAL ' + c)
    # The capitals C, F and Q came only in Unicode 14.0 (U+A7F2 to U+A7F4); the page keeps
    # to the small letters, which older devices show.
    return cap if cap and not 0xA7F2 <= ord(cap) <= 0xA7F4 else small


def subscript(c):
    if c.isascii() and c.isdigit():
        return look('SUBSCRIPT ' + DIGIT_NAMES[int(c)])
    if c in SIGNS:
        return look('SUBSCRIPT ' + SIGNS[c])
    return look('LATIN SUBSCRIPT SMALL LETTER ' + c.upper()) if ascii_letter(c) and c.islower() else None


def enclosed(prefix_cap, prefix_small, digits):
    def f(c):
        if c.isascii() and c.isdigit():
            return digits(int(c))
        if not ascii_letter(c):
            return None
        return look(f'{prefix_cap} {c.upper()}') if c.isupper() or not prefix_small else look(f'{prefix_small} {c.upper()}')
    return f


circled = enclosed('CIRCLED LATIN CAPITAL LETTER', 'CIRCLED LATIN SMALL LETTER', lambda d: look('CIRCLED DIGIT ' + DIGIT_NAMES[d]))
black_circled = enclosed('NEGATIVE CIRCLED LATIN CAPITAL LETTER', None,
                         lambda d: look('NEGATIVE CIRCLED DIGIT ZERO') if d == 0 else look('DINGBAT NEGATIVE CIRCLED DIGIT ' + DIGIT_NAMES[d]))
squared = enclosed('SQUARED LATIN CAPITAL LETTER', None, lambda d: None)
black_squared = enclosed('NEGATIVE SQUARED LATIN CAPITAL LETTER', None, lambda d: None)
parenthesized = enclosed('PARENTHESIZED LATIN CAPITAL LETTER', 'PARENTHESIZED LATIN SMALL LETTER',
                         lambda d: look('PARENTHESIZED DIGIT ' + DIGIT_NAMES[d]) if d else None)


def fullwidth(c):
    if c == ' ':
        return look('IDEOGRAPHIC SPACE')
    return look('FULLWIDTH ' + ud.name(c)) if '!' <= c <= '~' else None


# Upside down: turned letters by name where Unicode has them, look-alikes for the rest.
TURNED = {
    'a': 'LATIN SMALL LETTER TURNED A', 'b': 'q', 'c': 'LATIN SMALL LETTER OPEN O', 'd': 'p', 'e': 'LATIN SMALL LETTER TURNED E',
    'f': 'LATIN SMALL LETTER DOTLESS J WITH STROKE', 'g': 'LATIN SMALL LETTER B WITH TOPBAR', 'h': 'LATIN SMALL LETTER TURNED H',
    'i': 'LATIN SMALL LETTER TURNED I', 'j': 'LATIN SMALL LETTER R WITH FISHHOOK', 'k': 'LATIN SMALL LETTER TURNED K', 'l': 'l',
    'm': 'LATIN SMALL LETTER TURNED M', 'n': 'u', 'o': 'o', 'p': 'd', 'q': 'b', 'r': 'LATIN SMALL LETTER TURNED R', 's': 's',
    't': 'LATIN SMALL LETTER TURNED T', 'u': 'n', 'v': 'LATIN SMALL LETTER TURNED V', 'w': 'LATIN SMALL LETTER TURNED W', 'x': 'x',
    'y': 'LATIN SMALL LETTER TURNED Y', 'z': 'z',
    'A': 'FOR ALL', 'B': 'CANADIAN SYLLABICS CARRIER KHA', 'C': 'LATIN CAPITAL LETTER OPEN O', 'D': 'CANADIAN SYLLABICS CARRIER THA',
    'E': 'LATIN CAPITAL LETTER REVERSED E', 'F': 'TURNED CAPITAL F', 'G': 'TURNED SANS-SERIF CAPITAL G', 'H': 'H', 'I': 'I',
    'J': 'LATIN SMALL LETTER LONG S', 'K': 'LATIN SMALL LETTER TURNED K', 'L': 'TURNED SANS-SERIF CAPITAL L', 'M': 'W', 'N': 'N',
    'O': 'O', 'P': 'CYRILLIC CAPITAL LETTER KOMI DE', 'Q': 'GREEK CAPITAL LETTER OMICRON WITH TONOS',
    'R': 'LATIN LETTER SMALL CAPITAL TURNED R', 'S': 'S', 'T': 'UP TACK', 'U': 'INTERSECTION', 'V': 'GREEK CAPITAL LETTER LAMDA',
    'W': 'M', 'X': 'X', 'Y': 'TURNED SANS-SERIF CAPITAL Y', 'Z': 'Z',
    '0': '0', '1': 'LATIN CAPITAL LETTER IOTA', '2': 'HANGUL CHOSEONG RIEUL', '3': 'LATIN CAPITAL LETTER OPEN E',
    '4': 'BOPOMOFO LETTER EN', '5': 'GREEK SMALL LETTER STIGMA', '6': '9', '7': 'BOPOMOFO LETTER ENG', '8': '8', '9': '6',
    '.': 'DOT ABOVE', ',': "'", "'": ',', '"': 'DOUBLE LOW-9 QUOTATION MARK', '?': 'INVERTED QUESTION MARK',
    '!': 'INVERTED EXCLAMATION MARK', '¿': '?', '¡': '!', '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
    '<': '>', '>': '<', '&': 'TURNED AMPERSAND', '_': 'OVERLINE', ';': 'ARABIC SEMICOLON', '„': '"',
}


def turned(c):
    v = TURNED.get(c)
    return None if v is None else (v if len(v) == 1 else ud.lookup(v))


def map_text(text, f):
    out, left = [], []
    for c in text:
        m = f(c)
        if m is None and ord(c) > 0x7F:
            d = ud.normalize('NFD', c)
            if d != c and f(d[0]) is not None and all(ud.category(x).startswith('M') for x in d[1:]):
                m = f(d[0]) + d[1:]
        if m is None:
            out.append(c)
            if ud.category(c)[0] in 'LN' and c not in left:
                left.append(c)
        else:
            out.append(m)
    return ''.join(out), left


def clusters(text):
    return regex.findall(r'\X', text)


BREAKS = {'\r\n', '\n', '\r', ' ', ' '}


def marked(text, mark):
    return ''.join(g if g in BREAKS or g in '\t\f\v' or regex.search(r'\p{Extended_Pictographic}|[\U0001F1E6-\U0001F1FF]', g) else g + mark
                   for g in clusters(text))


def spaced(text):
    out, after = '', True
    for g in clusters(text):
        br = g in BREAKS
        if not br and not after:
            out += ' '
        out += g
        after = br
    return out


STYLES = {i: math_style(s) for i, s in zip(IDS, MATH)}
STYLES.update({'small-caps': small_caps, 'superscript': superscript, 'subscript': subscript, 'circled': circled,
               'black-circled': black_circled, 'squared': squared, 'black-squared': black_squared,
               'parenthesized': parenthesized, 'fullwidth': fullwidth})
MARKS = {'strike': '̶', 'slash': '̸', 'underline': '̲', 'double-underline': '̳', 'wavy': '̰', 'overline': '̅'}


def style_all(text):
    res = {}
    for sid, f in STYLES.items():
        out, left = map_text(text, f)
        res[sid] = {'text': out, 'left': left}
    out, left = map_text(text, turned)
    res['upside-down'] = {'text': ''.join(reversed(clusters(out))), 'left': left}
    res['backwards'] = {'text': ''.join(reversed(clusters(text))), 'left': []}
    res['spaced'] = {'text': spaced(text), 'left': []}
    for sid, mark in MARKS.items():
        res[sid] = {'text': marked(text, mark), 'left': []}
    return res


if __name__ == '__main__':
    data = {'inputs': INPUTS, 'expected': {k: style_all(v) for k, v in INPUTS.items()}}
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.json'), 'w', encoding='utf8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    for sid, r in data['expected']['default'].items():
        print(f"{sid:18} {r['text']}  left={''.join(r['left'])}")
