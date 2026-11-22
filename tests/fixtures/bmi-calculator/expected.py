#!/usr/bin/env python3
"""Expected results for tests/tools/bmi-calculator.test.js.

    python3 tests/fixtures/bmi-calculator/expected.py [full CDC csv] > tests/fixtures/bmi-calculator/expected.json

Adults: BMI from the typed numbers with Python's fractions (1 lb = 0.45359237 kg,
1 in = 0.0254 m), rounded half up to one decimal, then the CDC categories (or
NICE NG246 1.9.11 thresholds); healthy weight ranges by trying every weight in
steps of 0.1 kg or 1 lb. Children: the CDC method (extended-bmi-data-files.htm)
with Python's statistics.NormalDist and math.erfc, on the row at completed
months + 0.5, rounded as the CDC's calculator rounds (a whole percentile below
the 95th, cut to 0.1, or 0.01 from the 99.9th, above it). Cases within 1e-6 of a
rounding edge are left out. Given the full CDC file (bmi-age-2022.csv from
https://www.cdc.gov/growthcharts/data/extended-bmi/bmi-age-2022.csv), the
method is first checked against its P3 to P99.99 and z-score columns.
"""
import csv, json, math, os, sys
from fractions import Fraction as F
from statistics import NormalDist

N = NormalDist()
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', '..', '..', 'assets', 'vendor', 'cdc-bmi-for-age', 'bmi-age-2022.csv')
rows = {(r['sex'], float(r['agemos'])): {k: float(r[k]) for k in ('L', 'M', 'S', 'sigma')} for r in csv.DictReader(open(DATA))}
LB, INCH = F('0.45359237'), F('0.0254')
Z95 = N.inv_cdf(0.95)


def half_up(x):  # JavaScript's Math.round for positive numbers
    return math.floor(x + 0.5)


def tenths(q):  # a Fraction rounded half up to one decimal, as an int of tenths
    return math.floor(q * 10 + F(1, 2))


def p95(r):
    return r['M'] * (1 + r['L'] * r['S'] * Z95) ** (1 / r['L'])


def child(sex, months, bmi_q):
    r = rows[(sex, months + 0.5)]
    bmi, b10 = float(bmi_q), tenths(bmi_q)
    P = p95(r)
    out = {}
    if bmi <= P:
        z = ((bmi / r['M']) ** r['L'] - 1) / (r['L'] * r['S'])
        raw = 100 * N.cdf(z)
        if abs(raw - math.floor(raw) - 0.5) < 1e-6:
            return None
        pct = half_up(raw)
        text = 'below the 1st' if pct < 1 else None
        out.update(pct=pct, z=z)
    else:
        x = (bmi - P) / r['sigma']
        tail = 10 * 0.5 * math.erfc(x / math.sqrt(2))
        z = min(8.21, -N.inv_cdf(tail / 100)) if tail > 0 else 8.21
        if tail < 0.01:
            pct, text = 99.991, 'above the 99.99th'
        else:
            raw = 100 - tail
            k = 100 if raw >= 99.9 else 10
            if abs(raw * k - round(raw * k)) < 1e-6:
                return None
            pct = math.floor(raw * k) / k
            text = None
        raw95 = 100 * bmi / P
        if abs(raw95 - math.floor(raw95) - 0.5) < 1e-6:
            return None
        of95 = half_up(raw95)
        severe = of95 >= 120 or b10 >= 350
        out.update(pct=pct, z=z, of95=of95, severe=severe, cls=(3 if of95 >= 140 or b10 >= 400 else 2 if severe else 0), p95=round(P, 1))
    if text is None:
        s = repr(out['pct']) if isinstance(out['pct'], float) else str(out['pct'])
        if s.endswith('.0'):
            s = s[:-2]
        last = int(s[-1])
        t = out['pct'] % 100 if '.' not in s else 0
        text = s + ('th' if 11 <= t <= 13 else ['th', 'st', 'nd', 'rd'][last] if last < 4 else 'th')
    p = out['pct']
    cat = 'Underweight' if p < 5 else 'Healthy weight' if p < 85 else 'Overweight' if p < 95 else ('Severe obesity' if out.get('severe') else 'Obesity')
    if abs(round(out['z'], 2) - out['z']) > 0.004999 and abs(abs(out['z'] * 100 - math.floor(out['z'] * 100)) - 0.5) < 1e-6:
        return None
    out.update(pctText=text, cat=cat, zText=f"{out['z']:.2f}")
    return out


def adult_cat(b10, nice):
    ow, ob, c2, c3 = (230, 275, 325, 375) if nice else (250, 300, 350, 400)
    if b10 < 185: return 'Underweight'
    if b10 < ow: return 'Healthy weight'
    if b10 < ob: return 'Overweight'
    if b10 < c2: return 'Obesity, class 1'
    if b10 < c3: return 'Obesity, class 2'
    return 'Obesity, class 3 (severe obesity)'


def healthy(h_m, unit, nice):
    """Lightest and heaviest weight, in steps of the unit, whose rounded BMI is healthy."""
    top = 229 if nice else 249
    step = F(1, 10) if unit == 'kg' else LB
    ok = [n for n in range(1, 4000) if 185 <= tenths(n * step / (h_m * h_m)) <= top]
    first = [n for n in range(1, 6000) if tenths(n * step / (h_m * h_m)) >= (230 if nice else 250)][0]
    obese = [n for n in range(1, 6000) if tenths(n * step / (h_m * h_m)) >= (275 if nice else 300)][0]
    def text(n):
        if unit == 'kg': return f'{n // 10}.{n % 10} kg'
        if unit == 'lb': return f'{n:,} lb'
        return f'{n // 14} st {n % 14} lb'
    lo, hi = text(ok[0]), text(ok[-1])
    if unit != 'stlb': lo = lo.rsplit(' ', 1)[0]
    return {'healthy': f'{lo} to {hi}', 'over': text(first), 'obese': text(obese)}


def height(c):
    if c['hu'] == 'cm':
        return F(c['cmValue']) / 100
    return F(c['inches']) * INCH


def weight(c):
    if c['wu'] == 'kg': return F(c['kgValue'])
    return F(c['lbValue']) * LB


adults = []
for c in [
    {'name': 'metric example', 'hu': 'cm', 'cm': '170', 'cmValue': '170', 'wu': 'kg', 'kg': '65', 'kgValue': '65'},
    {'name': 'guide, metric', 'hu': 'cm', 'cm': '175', 'cmValue': '175', 'wu': 'kg', 'kg': '70', 'kgValue': '70'},
    {'name': 'metres in the cm box', 'hu': 'cm', 'cm': '1.75', 'cmValue': '175', 'wu': 'kg', 'kg': '70', 'kgValue': '70', 'read': 'Read as 1.75 m, 175 cm.'},
    {'name': 'decimal commas', 'hu': 'cm', 'cm': '1,82', 'cmValue': '182', 'wu': 'kg', 'kg': '80,5', 'kgValue': '80.5', 'read': 'Read as 1.82 m, 182 cm.'},
    {'name': 'guide, imperial', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '154', 'lbValue': '154'},
    {'name': 'feet and inches in one box', 'hu': 'ftin', 'ft': "5'9\"", 'in': '', 'inches': '69', 'wu': 'stlb', 'st': '11', 'stlb': '0', 'lbValue': '154', 'read': 'Read as 5 ft 9 in.'},
    {'name': 'inches in the feet box', 'hu': 'ftin', 'ft': '69', 'in': '', 'inches': '69', 'wu': 'stlb', 'st': '11 st 4', 'stlb': '', 'lbValue': '158', 'read': 'Read as 69 in, 5 ft 9 in.'},
    {'name': 'CDC 5 ft 9 in, underweight edge', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '124', 'lbValue': '124'},
    {'name': 'CDC 5 ft 9 in, healthy edge', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '125', 'lbValue': '125'},
    {'name': 'CDC 5 ft 9 in, overweight edge', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '169', 'lbValue': '169'},
    {'name': 'CDC 5 ft 9 in, obesity edge', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '203', 'lbValue': '203'},
    {'name': 'CDC 5 ft 9 in, class 2 edge', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '237', 'lbValue': '237'},
    {'name': 'CDC 5 ft 9 in, class 3 edge', 'hu': 'ftin', 'ft': '5', 'in': '9', 'inches': '69', 'wu': 'lb', 'lb': '271', 'lbValue': '271'},
    {'name': 'exactly 24.95 rounds up', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '99.8', 'kgValue': '99.8'},
    {'name': 'just under 24.95', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '99.79', 'kgValue': '99.79'},
    {'name': 'exactly 18.45 rounds up', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '73.8', 'kgValue': '73.8'},
    {'name': 'just under 18.45', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '73.79', 'kgValue': '73.79'},
    {'name': 'NICE overweight at 23', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '91.8', 'kgValue': '91.8', 'nice': True},
    {'name': 'NICE obesity at 27.5', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '110', 'kgValue': '110', 'nice': True},
    {'name': 'NICE class 2 at 32.5', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '130', 'kgValue': '130', 'nice': True},
    {'name': 'NICE class 3 at 37.5', 'hu': 'cm', 'cm': '200', 'cmValue': '200', 'wu': 'kg', 'kg': '150', 'kgValue': '150', 'nice': True},
    {'name': 'class 3', 'hu': 'cm', 'cm': '160', 'cmValue': '160', 'wu': 'lb', 'lb': '1,000', 'lbValue': '1000', 'wread': 'Read as 1,000 lb.'},
    {'name': 'waist, increased risk', 'hu': 'cm', 'cm': '180', 'cmValue': '180', 'wu': 'kg', 'kg': '85', 'kgValue': '85', 'waist': '96', 'age': '45'},
    {'name': 'waist, BMI 35 or more', 'hu': 'ftin', 'ft': '5', 'in': '4', 'inches': '64', 'wu': 'lb', 'lb': '210', 'lbValue': '210', 'waist': '44'},
    {'name': '20 years old is an adult', 'hu': 'cm', 'cm': '165', 'cmValue': '165', 'wu': 'kg', 'kg': '58', 'kgValue': '58', 'age': '20'},
]:
    h, w = height(c), weight(c)
    q = w / (h * h)
    b10 = tenths(q)
    nice = c.get('nice', False)
    c['bmi'] = f'{b10 // 10}.{b10 % 10}'
    c['cat'] = adult_cat(b10, nice)
    c['range'] = healthy(h, c['wu'] if c['wu'] != 'stlb' else 'stlb', nice)
    if 'waist' in c:
        ratio = F(c['waist']) * (F(1, 100) if c['hu'] == 'cm' else INCH) / h
        r100 = math.floor(ratio * 100 + F(1, 2))
        c['ratio'] = f'{r100 // 100}.{r100 % 100:02d}'
        c['ratioBand'] = 'only' if b10 >= 350 else 'below' if r100 < 40 else 'healthy' if r100 < 50 else 'increased' if r100 < 60 else 'further'
    adults.append(c)

children = []
for sex, y, m, h_cm, w_kg in [
    ('1', 4, 2, '100', '22.6'),      # CDC worked example: 99.7683, z 2.83
    ('2', 9, 6, '140', '41.552'),    # CDC worked example: 92.2, z 1.4215
    ('2', 15, 4, '160', '69.632'),   # BMI 27.2: CDC's inverse example (z 1.5)
    ('1', 7, 8, '120', '34.704'),    # BMI 24.1: CDC's inverse example (98.7th)
    ('1', 2, 0, '86', '12.1'), ('2', 2, 0, '84', '9.5'), ('1', 3, 5, '97', '24'), ('2', 5, 11, '112', '17.4'),
    ('1', 6, 0, '116', '28'), ('2', 8, 3, '128', '25.9'), ('1', 10, 7, '142', '33.3'), ('2', 11, 0, '146', '60'),
    ('1', 12, 9, '155', '90'), ('2', 13, 2, '157', '38'), ('1', 14, 6, '168', '120'), ('2', 16, 1, '163', '52.5'),
    ('1', 17, 11, '178', '70'), ('2', 18, 6, '165', '70'), ('1', 19, 11, '180', '160'), ('2', 19, 0, '170', '40'),
    ('1', 9, 0, '135', '95'), ('2', 4, 9, '105', '13.9'), ('1', 15, 0, '170', '102'), ('2', 12, 0, '150', '80'),
]:
    months = y * 12 + m
    q = F(w_kg) / (F(h_cm) / 100) ** 2
    r = child(sex, months, q)
    if r is None:
        continue
    b10 = tenths(q)
    r.update(sex=sex, years=y, months=m, cm=h_cm, kg=w_kg, bmi=f'{b10 // 10}.{b10 % 10}')
    if months >= 216:
        r['adult'] = adult_cat(b10, False)
    children.append(r)

checks = {}
if len(sys.argv) > 1:
    # The method against the CDC's own percentile and z-score columns.
    full = list(csv.DictReader(open(sys.argv[1])))
    worst_p, worst_z = 0, 0
    for r in full:
        L, M, S, sig = (float(r[k]) for k in ('L', 'M', 'S', 'sigma'))
        P = M * (1 + L * S * Z95) ** (1 / L)
        def pct(b):
            if b <= P: return 100 * N.cdf(((b / M) ** L - 1) / (L * S))
            return 90 + 10 * N.cdf((b - P) / sig)
        for col, want in (('P3', 3), ('P5', 5), ('P10', 10), ('P25', 25), ('P50', 50), ('P75', 75), ('P85', 85), ('P90', 90), ('P95', 95), ('P98', 98), ('P99', 99), ('P99_9', 99.9), ('P99_99', 99.99)):
            worst_p = max(worst_p, abs(pct(float(r[col])) - want))
        for col, want in (('Z1neg', -1), ('Z0', 0), ('Z1', 1), ('Z2', 2), ('Z3', 3), ('Z4', 4), ('Z5', 5)):
            b = float(r[col])
            p = pct(b)
            z = N.inv_cdf(p / 100) if b <= P else -N.inv_cdf(10 * 0.5 * math.erfc((b - P) / sig / math.sqrt(2)) / 100)
            worst_z = max(worst_z, abs(z - want))
    assert worst_p < 0.002 and worst_z < 0.0002, (worst_p, worst_z)
    checks = {'worstPercentileError': round(worst_p, 5), 'worstZError': round(worst_z, 6), 'rows': len(full)}

print(json.dumps({'checks': checks, 'adults': adults, 'children': children}, indent=1, ensure_ascii=False))
