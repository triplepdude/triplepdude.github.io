#!/usr/bin/env python3
"""Expected percentiles for tests/tools/reaction-time-test.test.js.

The page compares an average with the results chart on Human Benchmark's
reaction time test (humanbenchmark.com, read 21 November 2026): the number of
scores in each 25 ms band, from 0 ms up to 1000 ms. "Faster than" is the
share of scores above the average, counting the band the average falls in
pro rata. Worked out here with exact fractions, independently of the page,
for every whole millisecond from 0 to 1100.

    python3 percentiles.py > percentiles.json
"""
import json
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction

BANDS = [32, 22, 18, 7, 80, 690, 4593, 12677, 15342, 14149, 9769, 5539, 2813, 1597, 925, 640, 424, 273, 231, 164,
         130, 108, 94, 94, 67, 48, 55, 57, 36, 41, 28, 36, 34, 21, 26, 18, 25, 20, 17, 0]
TOTAL = sum(BANDS)
assert TOTAL == 70940


def faster_than(ms):
    below = Fraction(0)
    for i, count in enumerate(BANDS):
        lo, hi = 25 * i, 25 * (i + 1)
        if ms >= hi:
            below += count
        else:
            if ms > lo:
                below += Fraction(count * (ms - lo), 25)
            break
    return 100 * (TOTAL - below) / TOTAL


def text(p):
    if p > 99:
        return 'over 99%'
    if p < 1:
        return 'under 1%'
    whole = (Decimal(p.numerator) / Decimal(p.denominator)).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
    return f'about {whole}%'


out = {'total': TOTAL, 'text': {str(ms): text(faster_than(ms)) for ms in range(0, 1101)}}
# The guide's table, at the band edges.
out['guide'] = {str(ms): text(faster_than(ms)) for ms in (150, 175, 200, 225, 250, 275, 300, 350)}
# Median of the chart, for the guide's "about 228 ms".
lo = 0
while faster_than(lo + 1) > 50:
    lo += 1
out['median_ms'] = lo + 1
print(json.dumps(out, indent=1))
