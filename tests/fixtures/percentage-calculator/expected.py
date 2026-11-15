#!/usr/bin/env python3
"""Expected answers for tests/tools/percentage-calculator.test.js.

Each case is worked out here with fractions.Fraction, independently of the
page's JavaScript, and written the way the page documents it:

  * a value whose decimals end within 12 places is written in full;
  * any other value is rounded to 6 decimal places (6 significant ones when it
    is below 1) and the equals sign becomes "≈", or the word "about" is added;
  * with a fixed number of places the answer is rounded to exactly that many,
    halves away from zero, and keeps its trailing zeros;
  * a value carried into the next step gets two more places than the answer.

Run:  python3 expected.py > expected.json
"""
import json
import sys
from fractions import Fraction as F


def places_needed(q):
    """Decimal places needed to write q exactly, or None if it never ends."""
    d = q.denominator
    twos = fives = 0
    while d % 2 == 0:
        d //= 2
        twos += 1
    while d % 5 == 0:
        d //= 5
        fives += 1
    return max(twos, fives) if d == 1 else None


def write(units, k):
    """units is a whole number of 10^-k; returns text with grouped thousands."""
    sign = '-' if units < 0 else ''
    units = abs(units)
    text = f'{units // 10 ** k:,}'
    if k:
        text += '.' + str(units % 10 ** k).rjust(k, '0')
    return sign + text


def exact(q):
    k = places_needed(q)
    assert k is not None, q
    return write(int(q * 10 ** k), k)


def rounded(q, k):
    """q to k places, halves away from zero. Returns (units, changed)."""
    scaled = abs(q) * 10 ** k
    units = (2 * scaled.numerator + scaled.denominator) // (2 * scaled.denominator)
    changed = F(units, 10 ** k) != abs(q)
    return (-units if q < 0 else units), changed


def zeros_after_point(q):
    q = abs(q)
    z = 0
    while q != 0 and q * 10 < 1:
        q *= 10
        z += 1
    return z


def show(q, dp, extra=0):
    """Returns (text, approximate)."""
    if dp == 'auto' or extra:
        k = places_needed(q)
        if k is not None and k <= 12 + extra:
            return exact(q), False
        k = (6 if dp == 'auto' else dp) + extra + (zeros_after_point(q) if abs(q) < 1 else 0)
        units, changed = rounded(q, k)
        text = write(units, k)
        if k:
            text = text.rstrip('0').rstrip('.')
        return text, changed
    units, changed = rounded(q, dp)
    return write(units, dp), changed


def par(q):
    return f'({exact(q)})' if q < 0 else exact(q)


def eq(left, right, approx=False):
    return f'{left} {"≈" if approx else "="} {right}'


def answer(before, value, after, approx):
    if approx:
        before = before[:-3] + ' ≈ ' if before.endswith(' = ') else before + 'about '
    return before + value + after


def calc_of(p, y, op, dp):
    r = p / 100
    a, ax = show(r * y, dp)
    return dict(answer=answer(f'{exact(p)}% of {exact(y)} = ', a, '', ax), value=a, formula='X ÷ 100 × Y',
                steps=[eq(f'{exact(p)} ÷ 100', exact(r)), eq(f'{par(r)} × {par(y)}', a, ax)])


def calc_what(x, y, op, dp):
    r = x / y
    rs, rx = show(r, dp, 2)
    a, ax = show(r * 100, dp)
    return dict(answer=answer(f'{exact(x)} is ', a + '%', f' of {exact(y)}', ax), value=a + '%', formula='X ÷ Y × 100',
                steps=[eq(f'{exact(x)} ÷ {par(y)}', rs, rx), eq(f'{rs} × 100', a + '%', rx or ax)])


def calc_change(x, y, op, dp):
    d = y - x
    r = d / abs(x)
    rs, rx = show(r, dp, 2)
    a, ax = show(abs(r * 100), dp)
    s, sx = show(r * 100, dp)
    word = ' increase' if d > 0 else ' decrease' if d < 0 else ' (no change)'
    return dict(answer=answer(f'From {exact(x)} to {exact(y)}: ', a + '%' + word, '', ax), value=a + '%' + word,
                formula='(Y − X) ÷ |X| × 100' if x < 0 else '(Y − X) ÷ X × 100',
                steps=[eq(f'{exact(y)} − {par(x)}', exact(d)), eq(f'{par(d)} ÷ {exact(abs(x))}', rs, rx), eq(f'{rs} × 100', s + '%', rx or sx)])


def calc_add(x, p, op, dp):
    c = x * p / 100
    sym = ' − ' if op == 'sub' else ' + '
    a, ax = show(x - c if op == 'sub' else x + c, dp)
    return dict(answer=answer(f'{exact(x)}{sym}{exact(p)}% = ', a, '', ax), value=a, formula=f'X{sym}X × Y ÷ 100',
                steps=[eq(f'{par(x)} × {par(p)} ÷ 100', exact(c)), eq(f'{exact(x)}{sym}{par(c)}', a, ax)])


def calc_diff(x, y, op, dp):
    d = abs(x - y)
    avg = (abs(x) + abs(y)) / 2
    a, ax = show(d / avg * 100, dp)
    bars = x < 0 or y < 0
    return dict(answer=answer(f'{exact(x)} and {exact(y)} differ by ', a + '%', '', ax), value=a + '%',
                formula='|X − Y| ÷ ((|X| + |Y|) ÷ 2) × 100' if bars else '|X − Y| ÷ ((X + Y) ÷ 2) × 100',
                steps=[eq(f'|{exact(x)} − {par(y)}|', exact(d)), eq(f'({exact(abs(x))} + {exact(abs(y))}) ÷ 2', exact(avg)),
                       eq(f'{exact(d)} ÷ {exact(avg)} × 100', a + '%', ax)])


def calc_whole(x, p, op, dp):
    r = p / 100
    a, ax = show(x / r, dp)
    return dict(answer=answer(f'{exact(x)} is {exact(p)}% of ', a, '', ax), value=a, formula='X ÷ (Y ÷ 100)',
                steps=[eq(f'{exact(p)} ÷ 100', exact(r)), eq(f'{exact(x)} ÷ {par(r)}', a, ax)])


def calc_orig(x, p, op, dp):
    down = op == 'dec'
    f = 1 - p / 100 if down else 1 + p / 100
    sym = ' − ' if down else ' + '
    orig = x / f
    a, ax = show(orig, dp)
    c, cx = show(x - orig, dp)
    shown = f'({a})' if orig < 0 else a
    return dict(answer=answer(f'{exact(x)} is {exact(p)}% {"less" if down else "more"} than ', a, '', ax), value=a,
                formula=f'X ÷ (1{sym}Y ÷ 100)',
                steps=[eq(f'1{sym}{par(p)} ÷ 100', exact(f)), eq(f'{exact(x)} ÷ {par(f)}', a, ax),
                       eq(f'The change itself: {exact(x)} − {shown}', c, ax or cx)])


CALCS = dict(of=calc_of, what=calc_what, change=calc_change, add=calc_add, diff=calc_diff, whole=calc_whole, orig=calc_orig)

# calculator, first box, second box, select value, rounding
CASES = [
    ('of', '15', '80', '', 'auto'), ('of', '7.5', '1250.40', '', 'auto'), ('of', '18', '64.5', '', 'auto'),
    ('of', '0.1', '0.2', '', 'auto'), ('of', '33.333', '3', '', 'auto'), ('of', '-12.5', '80', '', 'auto'),
    ('of', '250', '1234567.89', '', 'auto'), ('of', '12.5', '999999999999999999999999999999', '', 'auto'),
    ('of', '0.00000001', '0.00000003', '', 'auto'), ('of', '17.5', '19.99', '', '2'), ('of', '15', '80', '', '2'),
    ('of', '50', '5', '', '0'), ('of', '50', '-5', '', '0'), ('of', '12.5', '0.1', '', '2'), ('of', '0', '80', '', 'auto'),
    ('what', '12', '80', '', 'auto'), ('what', '1', '3', '', 'auto'), ('what', '2', '3', '', '2'), ('what', '1', '7', '', '10'),
    ('what', '150', '100', '', 'auto'), ('what', '1', '30000', '', 'auto'), ('what', '-5', '20', '', 'auto'),
    ('what', '0', '55', '', 'auto'), ('what', '1', '8', '', '1'), ('what', '37', '-296', '', 'auto'),
    ('what', '1', '3', '', '0'), ('what', '0.000001', '999999999999', '', 'auto'),
    ('change', '80', '100', '', 'auto'), ('change', '100', '80', '', 'auto'), ('change', '3', '4', '', 'auto'),
    ('change', '80', '80', '', 'auto'), ('change', '-50', '100', '', 'auto'), ('change', '50', '-100', '', 'auto'),
    ('change', '50', '150', '', 'auto'), ('change', '4', '5', '', 'auto'), ('change', '7', '9', '', '2'),
    ('change', '9', '7', '', '1'), ('change', '0.3', '0.1', '', 'auto'), ('change', '80', '80', '', '2'),
    ('add', '80', '15', 'add', 'auto'), ('add', '80', '15', 'sub', 'auto'), ('add', '45', '20', 'sub', 'auto'),
    ('add', '150', '20', 'add', 'auto'), ('add', '19.99', '8.875', 'add', '2'), ('add', '19.99', '8.875', 'add', 'auto'),
    ('add', '-200', '10', 'add', 'auto'), ('add', '100', '-10', 'sub', 'auto'), ('add', '0.1', '200', 'sub', 'auto'),
    ('add', '1.005', '0', 'add', '2'), ('add', '2.675', '0', 'add', '2'),
    ('diff', '80', '100', '', 'auto'), ('diff', '100', '80', '', 'auto'), ('diff', '10', '6', '', 'auto'),
    ('diff', '5', '5', '', 'auto'), ('diff', '-10', '-6', '', 'auto'), ('diff', '10', '-10', '', 'auto'),
    ('diff', '0', '7', '', 'auto'), ('diff', '1.5', '2.25', '', '3'), ('diff', '80', '100', '', '2'),
    ('whole', '12', '15', '', 'auto'), ('whole', '1', '3', '', 'auto'), ('whole', '45', '150', '', 'auto'),
    ('whole', '-7', '3.5', '', 'auto'), ('whole', '0', '12', '', 'auto'), ('whole', '10', '7', '', '2'),
    ('whole', '5', '-20', '', 'auto'),
    ('orig', '92', '15', 'inc', 'auto'), ('orig', '68', '15', 'dec', 'auto'), ('orig', '180', '20', 'inc', 'auto'),
    ('orig', '36', '20', 'dec', 'auto'), ('orig', '100', '7', 'inc', 'auto'), ('orig', '100', '7', 'inc', '2'),
    ('orig', '-20', '150', 'dec', 'auto'), ('orig', '59.99', '17.5', 'inc', '2'), ('orig', '0', '10', 'inc', 'auto'),
    # The edge of "written in full": 1/4096 has 12 decimal places and 1/8192 has 13. A value
    # carried into the next step gets two more: 1/16384 has 14 places and 1/32768 has 15.
    ('whole', '1', '409600', '', 'auto'), ('whole', '1', '819200', '', 'auto'),
    ('what', '1', '16384', '', 'auto'), ('what', '1', '32768', '', 'auto'),
    # 1.25 / 5 = 0.25 is shown as 0.3, so the last step is marked as rounded although 1.25 - 0.25 = 1 exactly.
    ('orig', '1.25', '400', 'inc', '1'),
]


def main():
    out = []
    for calc, a, b, op, dp in CASES:
        row = dict(calc=calc, a=a, b=b, op=op, dp=dp)
        row.update(CALCS[calc](F(a), F(b), op, dp if dp == 'auto' else int(dp)))
        out.append(row)
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
