#!/usr/bin/env python3
"""Known answers for tests/tools/password-generator.test.js.

    python3 expected.py > expected.json

The number of passwords the settings allow is counted two ways that share no
code: by dynamic programming over the positions (which kinds of character have
appeared so far) and by inclusion-exclusion, the formula the page uses. Both
are also checked against brute force on small alphabets. Times use the same
rounding as the page: half of all passwords divided by the guessing speed,
two significant figures, the largest unit that keeps the number below the
next one.
"""
import itertools
import json
import math

LOWER = 'abcdefghijklmnopqrstuvwxyz'
UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
DIGITS = '0123456789'
SYMBOLS = ''.join(chr(c) for c in range(33, 127) if not chr(c).isalnum())
COMMON = '!@#$%^&*'
LOOKALIKE = set('0Oo1lI|')
assert len(SYMBOLS) == 32


def kinds_for(kinds='luds', symbols=SYMBOLS, avoid=False, exclude=''):
    sets = {'l': LOWER, 'u': UPPER, 'd': DIGITS, 's': symbols}
    out = {}
    for k in kinds:
        cs = [c for c in sets[k] if c not in exclude and not (avoid and c in LOOKALIKE)]
        out[k] = ''.join(cs)
    return out


def count_dp(kinds, length, first_letter=False):
    """Strings of the given length using every kind at least once."""
    names = list(kinds)
    full = (1 << len(names)) - 1
    dp = {0: 1}
    for pos in range(length):
        nxt = {}
        for mask, ways in dp.items():
            for i, k in enumerate(names):
                if pos == 0 and first_letter and k not in 'lu':
                    continue
                m = mask | (1 << i)
                nxt[m] = nxt.get(m, 0) + ways * len(kinds[k])
        dp = nxt
    return dp.get(full, 0)


def count_ie(kinds, length, first_letter=False):
    names = list(kinds)
    C = sum(len(v) for v in kinds.values())
    F = sum(len(kinds[k]) for k in names if k in 'lu')
    total = 0
    for r in range(len(names) + 1):
        for S in itertools.combinations(names, r):
            removed = sum(len(kinds[k]) for k in S)
            if first_letter:
                f = F - sum(len(kinds[k]) for k in S if k in 'lu')
                total += (-1) ** r * f * (C - removed) ** (length - 1)
            else:
                total += (-1) ** r * (C - removed) ** length
    return total


def count_brute(kinds, length, first_letter=False):
    alpha = [(c, k) for k, cs in kinds.items() for c in cs]
    n = 0
    for combo in itertools.product(alpha, repeat=length):
        if first_letter and combo[0][1] not in 'lu':
            continue
        if {k for _, k in combo} == set(kinds):
            n += 1
    return n


# Brute force on small alphabets, every length from the number of kinds up.
small = {'l': 'abc', 'u': 'AB', 'd': '12', 's': '!'}
for L in range(1, 7):
    for fl in (False, True):
        b = count_brute(small, L, fl)
        assert b == count_dp(small, L, fl) == count_ie(small, L, fl), (L, fl)
two = {'l': 'ab', 'd': '7'}
for L in range(1, 8):
    assert count_brute(two, L) == count_dp(two, L) == count_ie(two, L)

YEAR = 365.25 * 24 * 3600
SUP = str.maketrans('0123456789', '⁰¹²³⁴⁵⁶⁷⁸⁹')


def sig2(x):
    return float('%.2g' % x)


def js(v):
    return str(int(v)) if v == int(v) else repr(v)


def sci(x):
    e = math.floor(math.log10(x))
    m = sig2(x / 10 ** e)
    if m >= 10:
        m = sig2(m / 10)
        e += 1
    return js(m) + ' × 10' + str(e).translate(SUP)


def plural(v, unit):
    return js(v) + ' ' + unit + ('' if v == 1 else 's')


def duration(seconds):
    if seconds < 1:
        return 'less than a second'
    for size, unit, limit in [(1, 'second', 60), (60, 'minute', 60), (3600, 'hour', 24), (86400, 'day', 365.25)]:
        v = sig2(seconds / size)
        if v < limit:
            return 'about ' + plural(v, unit)
    y = seconds / YEAR
    if sig2(y) < 1000:
        return 'about ' + plural(sig2(y), 'year')
    for size, name in [(1e3, 'thousand'), (1e6, 'million'), (1e9, 'billion'), (1e12, 'trillion')]:
        w = sig2(y / size)
        if w < 1000:
            return 'about ' + js(w) + ' ' + name + ' years'
    return 'about ' + sci(y) + ' years'


def strength(bits):
    for limit, label in [(45, 'Weak'), (60, 'Fair'), (75, 'Good'), (100, 'Strong')]:
        if bits < limit:
            return label
    return 'Very strong'


def case(name, kinds, length, first_letter=False, rates=(1e11,)):
    n = count_dp(kinds, length, first_letter)
    assert n == count_ie(kinds, length, first_letter), name
    bits = math.log2(n)
    return name, {
        'length': length,
        'alphabet': ''.join(kinds.values()),
        'count': str(n),
        'bits': '%.1f bits' % bits,
        'strength': strength(bits),
        # Below a billion the page writes the number out, above it in powers of ten.
        'space': format(n, ',') if n < 10 ** 9 else sci(n),
        'times': {('%g' % r): duration(n / 2 / r) for r in rates},
    }


ALL = kinds_for()
RATES = (1e3, 1e4, 1e11, 1e14)
cases = [case('all-%d' % L, ALL, L, rates=RATES) for L in (4, 8, 12, 15, 16, 20, 32, 63, 64, 128)]
cases += [
    case('first-letter-16', ALL, 16, True),
    case('first-letter-4', ALL, 4, True),
    case('no-lookalikes-16', kinds_for(avoid=True), 16),
    case('wifi-20', kinds_for('lud', avoid=True), 20, rates=RATES),
    case('common-16', kinds_for(symbols=COMMON), 16),
    case('own-16', kinds_for(symbols='!-'), 16),
    case('lower-16', kinds_for('l'), 16),
    case('exclude-abc-16', kinds_for(exclude='abc'), 16),
    case('letters-digits-12', kinds_for('lud'), 12),
    case('pin-4', kinds_for('d'), 4, rates=RATES),
    case('pin-6', kinds_for('d'), 6, rates=RATES),
    case('pin-8', kinds_for('d'), 8, rates=RATES),
    case('pin-128', kinds_for('d'), 128),
]
print(json.dumps({'symbols': SYMBOLS, 'cases': dict(cases)}, ensure_ascii=False, indent=1))
