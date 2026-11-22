#!/usr/bin/env python3
"""Expected results for tests/tools/online-timer.test.js, worked out here and
not read back from the page: the length typed into the three boxes (exact
fractions, digits of any script through unicodedata), the timers an address
such as #1h30m describes, and end times as ISO 8601.
Run: python3 expected.py > expected.json
"""
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from fractions import Fraction

MAX = 99 * 3600 + 59 * 60 + 59          # 99:59:59 in seconds
UNITS = (3600, 60, 1)


def box(raw):
    """Seconds as a Fraction, or None when the box cannot be read."""
    if len(raw) > 20:
        return None
    s = ''.join(str(unicodedata.decimal(c)) if unicodedata.category(c) == 'Nd' else c for c in raw.strip())
    # Full-width marks from East Asian keyboards are a point and a comma.
    s = s.replace('\uff0e', '.').replace('\uff0c', ',')
    if s == '':
        return Fraction(0)
    m = re.fullmatch(r'(\d*)(?:([.,\u066b])(\d*))?', s, re.ASCII)
    if not m or not re.search(r'\d', s) or len(m.group(3) or '') > 3 or len(m.group(1)) > 5:
        return None
    # 1,500 or 1.500 is 1.5 to some readers and 1500 to others: refused.
    # Not 0,500 (no thousands group starts with 0) or the Arabic decimal mark.
    if m.group(2) in ('.', ',') and re.fullmatch(r'[1-9]\d{0,2}', m.group(1)) and len(m.group(3)) == 3:
        return None
    return Fraction(int(m.group(1) or 0)) + (Fraction(int(m.group(3)), 10 ** len(m.group(3))) if m.group(3) else 0)


def boxes(h, m, s):
    """('ok', seconds) after rounding half up, or ('error', index of the first bad box)."""
    total = Fraction(0)
    for i, raw in enumerate((h, m, s)):
        v = box(raw)
        if v is None:
            return ['error', i]
        total += v * UNITS[i]
    secs = int(total + Fraction(1, 2)) if total > 0 else 0
    if secs > MAX:
        return ['error', 'max']
    return ['ok', secs]


def fields(secs):
    return [f'{secs // 3600:02d}', f'{secs // 60 % 60:02d}', f'{secs % 60:02d}']


def address(secs):
    h, m, s = secs // 3600, secs // 60 % 60, secs % 60
    return (f'{h}h' if h else '') + (f'{m}m' if m else '') + (f'{s}s' if s else '')


def length(item):
    """Seconds an address item asks for, or None."""
    t = item.lower()
    if len(t) > 30:
        return None
    num = r'(\d{1,5}(?:[.,]\d{1,3})?)'
    amount = lambda x: Fraction(x.replace(',', '.'))
    if re.fullmatch(r'\d{1,5}(?:[.,]\d{1,3})?', t):
        v = amount(t) * 60
    elif re.fullmatch(r'\d{1,3}:\d{1,2}(?::\d{1,2})?', t):
        p = [int(x) for x in t.split(':')]
        v = Fraction(p[0] * 60 + p[1]) if len(p) == 2 else Fraction(p[0] * 3600 + p[1] * 60 + p[2])
    else:
        m = re.fullmatch(num + r'(?:h|hr|hrs|hours?)' + '|' r'(?:' + num + r'(?:h|hr|hrs|hours?))?(?:' + num + r'(?:m|min|mins|minutes?))?(?:' + num + r'(?:s|sec|secs|seconds?))?', t)
        if not m or not any(m.groups()):
            return None
        g = m.groups()
        hours = g[0] or g[1]
        v = (amount(hours) * 3600 if hours else 0) + (amount(g[2]) * 60 if g[2] else 0) + (amount(g[3]) if g[3] else 0)
    secs = int(v + Fraction(1, 2))
    return secs if 0 < secs <= MAX else None


BOXES = [
    ['0', '10', '0'], ['1,5', '', ''], ['1.5', '', ''], ['', '90', ''], ['', '0,500', ''],
    ['', '١٠', ''], ['', '۱۰', ''], ['', '１０', ''], ['', '१०', ''],
    ['', ' 7 ', ''], ['', '', '0.5'], ['99', '59', '59'], ['', '', '0,0015'],
    ['', '5²', ''], ['', '1\t2', ''], ['', '1.000,5', ''], ['', '1٬000', ''],
    ['', '-5', ''], ['', '1.2345', ''], ['100', '', ''], ['', '', '12 345'], ['', '1e3', ''],
    # A thousands separator or a decimal mark? Refused when it could be either.
    ['', '', '1,500'], ['', '1,000', ''], ['', '', '1.500'], ['', '12,500', ''], ['', '123.250', ''],
    ['', '1234,500', ''], ['', '1,50', ''], ['', '١٫٥٠٠', ''], ['', '١,٥٠٠', ''],
    # Full-width digits and marks (Japanese and Chinese keyboards).
    ['', '１．５', ''], ['', '１，５', ''],
]
HASHES = ['#10m', '#1h30m', '#90s', '#5:00', '#1:30:00', '#10', '#1.5', '#10MIN', '#2h', '#45sec',
          '#1hour30minutes', '#0:45', '#1h0m30s']
# End times the page cannot have written: before 2020 (1970 here), or the
# year 33658 for a timer that has ended.
BAD = ['#abc', '#0', '#100h', '#10m!x5', '#1h30', '#:5', '#10m!d0', '#10m!r1', '#10m!d999999999999999']

T0 = datetime(2026, 3, 14, 12, 0, 0, tzinfo=timezone.utc)
iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
out = {
    'boxes': [[b, boxes(*b)] for b in BOXES],
    'hashes': [[h, fields(length(h[1:])), '#' + address(length(h[1:]))] for h in HASHES],
    'bad': BAD,  # each must be refused with a message
    'fieldsAfter90': fields(5400),
    # A 3-second timer started at T0 + 5 s ends at T0 + 8 s.
    'end3': iso(T0 + timedelta(seconds=8)),
    'end3ms': int((T0 + timedelta(seconds=8)).timestamp() * 1000),
}
for b, r in out['boxes']:
    if r[0] == 'ok':
        r.append(fields(r[1]))
        r.append('#' + address(r[1]) if r[1] else '')
print(json.dumps(out, indent=1, ensure_ascii=False))
