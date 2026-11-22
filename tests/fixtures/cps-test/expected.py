#!/usr/bin/env python3
"""Expected CPS scores for tests/tools/cps-test.test.js.

CPS is clicks divided by the test length, shown to two decimals and rounded
half up; computed here with exact fractions, independently of the page. The
rank is the page's documented scale: under 4 warming up, 4 to 6 steady, 6 to
8 quick, 8 to 11 fast, 11 to 14 very fast, 14 or more extreme.

    python3 expected.py > expected.json
"""
import json
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction

CASES = [(12, 1), (8, 1), (14, 1), (6, 1), (5, 1), (37, 5), (7, 15), (2, 1), (7, 100), (2, 60)]
RANKS = [(14, 'Extreme'), (11, 'Very fast'), (8, 'Fast'), (6, 'Quick'), (4, 'Steady'), (0, 'Warming up')]

out = {}
for clicks, secs in CASES:
    exact = Fraction(clicks, secs)
    shown = Decimal(exact.numerator) / Decimal(exact.denominator)
    shown = shown.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    rank = next(name for limit, name in RANKS if shown >= limit)
    out[f'{clicks}/{secs}'] = {'cps': f'{shown:.2f}', 'rank': rank}
print(json.dumps(out, indent=2))
