#!/usr/bin/env python3
"""Expected values and sample files for tests/tools/wheel-spinner.test.js.

    python3 tests/fixtures/wheel-spinner/make_fixtures.py

Everything here is worked out from first principles, independently of the
page's JavaScript: chi-square thresholds from the closed-form survival
function, chances as exact fractions, the coupon-collector figure quoted in
the guide, how many names fit in a link of 16,000 characters (with Python's
own form encoder), the colour the page must paint under the pointer, and the
text files with byte order marks that the page must open.
"""
import json
import math
import os
from fractions import Fraction
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.abspath(__file__))


def chi2_sf(x, df):
    """Survival function of the chi-square distribution for an even df."""
    k = df // 2
    term, total = 1.0, 1.0
    for i in range(1, k):
        term *= (x / 2) / i
        total += term
    return math.exp(-x / 2) * total


def chi2_threshold(df, p):
    lo, hi = 0.0, 200.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if chi2_sf(mid, df) > p:
            lo = mid
        else:
            hi = mid
    return hi


def pct(fr):
    """Percentage rounded half up to two places, trailing zeros dropped."""
    hundredths = math.floor(fr * 10000 + Fraction(1, 2))
    s = f'{hundredths // 100}.{hundredths % 100:02d}'.rstrip('0').rstrip('.')
    return s + '%'


def chance(weight, total):
    fr = Fraction(weight, total)
    n, d = fr.numerator, fr.denominator
    return f'{n} in {d} ({pct(fr)})'


out = {}
# A threshold the statistic exceeds by chance only once in a million runs.
out['chi2'] = {'df2': round(chi2_threshold(2, 1e-6), 3), 'df4': round(chi2_threshold(4, 1e-6), 3)}

# Guide table: Pizza *3, Sushi *2, Tacos (1).
out['guide_table'] = {name: chance(w, 6) for name, w in [('Pizza', 3), ('Sushi', 2), ('Tacos', 1)]}
# Weights 1.5, 1 and 0.25 are 150, 100 and 25 hundredths: 6, 4 and 1 out of 11.
out['decimal_weights'] = {name: chance(w, 11) for name, w in [('Pizza', 6), ('Sushi', 4), ('Tacos', 1)]}
out['eight_equal'] = chance(1, 8)
out['three_equal'] = chance(1, 3)

# Coupon collector: expected spins before all 30 names have come up.
out['coupon_30'] = round(30 * sum(Fraction(1, k) for k in range(1, 31)).__float__(), 2)

# Seven-letter ASCII names that fit in a 16,000-character hash 'e=...'.
n = 0
while len(urlencode({'e': '\n'.join(['Abcdefg'] * (n + 1))})) <= 16000:
    n += 1
out['names_in_link'] = n
out['example_hash'] = urlencode({'e': 'Amara\nBen\nChloé'})

# Colours of the first slices in the default "Bright" theme (the page's spec).
out['bright'] = ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#277da1', '#7b2cbf', '#43aa8b', '#f15bb5']

with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf8') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')

# Notepad's "UTF-8 with BOM" and PowerShell's UTF-16 LE, both with CR LF.
lines = ['Zoë', 'Łukasz', '王芳', 'Ana *2']
with open(os.path.join(HERE, 'utf8-bom.txt'), 'wb') as f:
    f.write(b'\xef\xbb\xbf' + '\r\n'.join(lines).encode('utf8') + b'\r\n')
with open(os.path.join(HERE, 'utf16le.txt'), 'wb') as f:
    f.write(b'\xff\xfe' + '\r\n'.join(lines).encode('utf-16-le'))
# Windows-1252 (not valid UTF-8) and a binary file.
with open(os.path.join(HERE, 'cp1252.txt'), 'wb') as f:
    f.write('Renée\nJosé\n'.encode('cp1252'))
with open(os.path.join(HERE, 'photo.png'), 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + bytes(40))
print(json.dumps(out, ensure_ascii=False))
