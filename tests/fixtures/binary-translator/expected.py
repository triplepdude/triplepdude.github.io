#!/usr/bin/env python3
"""Expected values for tests/tools/binary-translator.test.js.

Everything here is worked out with Python's own codecs and integers, never
read back from the page:

    python3 tests/fixtures/binary-translator/expected.py   (rewrites expected.json)
"""
import curses.ascii
import json
import os
import unicodedata


def bits(data, sep=' '):
    return sep.join(format(b, '08b') for b in data)


def row(ch):
    """Unicode code point, UTF-8 bytes in binary, hex and decimal."""
    b = ch.encode('utf-8')
    return ['U+%04X' % ord(ch), bits(b), ' '.join('%02X' % x for x in b), ' '.join(str(x) for x in b)]


TEXTS = ['Hi 👋', 'hi', 'Hello, World!', 'café', '€5', 'naïve façade', '日本語', 'a\tb\nc', '👍🏽',
         'Ωμέγα', ' ', 'A', 'é', ' ', 'x‍y', 'Zürich ist schön', '0101']
encode = [{
    'text': t,
    'spaced': bits(t.encode('utf-8')),
    'joined': bits(t.encode('utf-8'), ''),
    'chars': len(t),
    'bytes': len(t.encode('utf-8')),
    'rows': [row(ch) for ch in t],
} for t in TEXTS]

# Byte strings that are not all valid UTF-8, decoded the way browsers do
# (WHATWG Encoding Standard; Python's "replace" follows the same rule: one
# U+FFFD for each maximal invalid part). A byte on its own that is not UTF-8 is
# read as a code point instead (11110000 is ð), so the only lone byte here is 80,
# a control code either way.
BAD = ['ff68', 'f09f98', 'f09f9868', 'c080', 'eda080', 'e08080', 'f4908080', '68c3', 'c328', 'e282',
       'e28228', 'f8888080', '80', 'bf68', 'c3a9ff', 'f0288cbc', 'f09f988068ff', 'e0a0', 'c1bf', 'f5808080',
       'f0808080', 'f08f8080', 'f4908080', 'e09f80', 'edbfbf', '68f0']
GOOD = ['efbfbd', 'efbbbf68', 'f0908080', 'f48fbfbf', 'ed9fbf', 'ee8080', 'c2a0', 'dfbf', 'e0a080', 'efbfbf', '7f']
lossy = [{'hex': h, 'binary': bits(bytes.fromhex(h), ''), 'text': bytes.fromhex(h).decode('utf-8', 'replace')} for h in BAD]
strict = [{'hex': h, 'binary': bits(bytes.fromhex(h), ''), 'text': bytes.fromhex(h).decode('utf-8')} for h in GOOD]
for item in lossy:
    assert '�' in item['text'], item

# One number per character, as tools that do not write UTF-8 bytes produce:
# the code point in binary, or UTF-16 code units padded to 16 digits.
CODES = ['пр', 'Привет', 'h€', '日本', 'ñandú', 'x😀y']
codepoints = [{'text': t, 'binary': ' '.join(format(ord(ch), 'b') for ch in t)} for t in CODES]
utf16 = []
for t in CODES + ['hi']:
    raw = t.encode('utf-16-be')
    units = [int.from_bytes(raw[i:i + 2], 'big') for i in range(0, len(raw), 2)]
    utf16.append({'text': t, 'binary': ' '.join(format(u, '016b') for u in units)})

NUMBERS = [0, 1, 2, 7, 8, 10, 104, 255, 256, 1000, 65535, 2**31 - 1, 2**32, 2**53, 2**53 + 1, 2**64 - 1, 2**64,
           10**30, 2**200 + 12345, 3**150, 12345678901234567890123456789012345678901234567890]
numbers = [{'dec': str(n), 'bin': format(n, 'b'), 'hex': format(n, 'X'), 'oct': format(n, 'o')} for n in NUMBERS]

negatives = []
for n in [-1, -104, -128, -129, -32768, -32769, -2**31, -2**31 - 1, -2**63, -2**63 - 1]:
    width = next((w for w in (8, 16, 32, 64) if n >= -2**(w - 1)), None)
    negatives.append({
        'dec': str(n), 'bin': '-' + format(-n, 'b'), 'hex': '-' + format(-n, 'X'), 'oct': '-' + format(-n, 'o'),
        'width': width,
        'twos': format(n & (2**width - 1), 'b') if width else None,
        'twosHex': format(n & (2**width - 1), 'X') if width else None,
    })

# The ASCII table. Abbreviations of the control codes come from Python's
# curses.ascii and are checked against the Unicode name aliases.
ascii_rows = []
for code in range(128):
    if code < 32:
        label = curses.ascii.controlnames[code]
        # ASCII calls code 25 EM; the Unicode alias is EOM.
        assert unicodedata.lookup('EOM' if label == 'EM' else label) == chr(code), label
    elif code == 32:
        label = 'Space'
    elif code == 127:
        label = 'DEL'
        assert unicodedata.lookup(label) == chr(code)
    else:
        label = chr(code)
    ascii_rows.append([str(code), '%02X' % code, format(code, '08b'), label])

out = {'encode': encode, 'lossy': lossy, 'strict': strict, 'codepoints': codepoints, 'utf16': utf16,
       'numbers': numbers, 'negatives': negatives, 'ascii': ascii_rows}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.json')
with open(path, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write('\n')
print('wrote', path)
