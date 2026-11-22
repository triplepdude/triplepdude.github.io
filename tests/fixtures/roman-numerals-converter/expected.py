"""Known answers for tests/tools/roman-numerals-converter.test.js, worked out
here with a different method from the page (one table per decimal place) and
checked against the strict pattern for standard numerals:

  python3 -I expected.py > expected.json
"""
import json, re, sys
from datetime import date

ONES = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
TENS = ['', 'X', 'XX', 'XXX', 'XL', 'L', 'LX', 'LXX', 'LXXX', 'XC']
HUNDREDS = ['', 'C', 'CC', 'CCC', 'CD', 'D', 'DC', 'DCC', 'DCCC', 'CM']
THOUSANDS = ['', 'M', 'MM', 'MMM']
BAR = '̅'


def roman(n):
    return THOUSANDS[n // 1000] + HUNDREDS[n // 100 % 10] + TENS[n // 10 % 10] + ONES[n % 10]


def big(n):
    """From 4,000 the thousands are written with a bar over each letter."""
    if n < 4000:
        return roman(n)
    return ''.join(c + BAR for c in roman(n // 1000)) + roman(n % 1000)


STRICT = re.compile(r'^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$')
table = [roman(n) for n in range(1, 4000)]
assert all(STRICT.match(r) for r in table) and len(set(table)) == 3999
assert not any(STRICT.match(r) for r in ['IIII', 'IIX', 'IC', 'VX', 'XM', 'VV', 'IL', 'XD'])

VALUES = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100, 'D': 500, 'M': 1000}


def likely(s):
    """Value of a numeral that may break the rules: each run of one letter is added, or subtracted
    when a larger letter follows it (IIX = 10 - 2)."""
    runs = [[m.group(0)[0], len(m.group(0))] for m in re.finditer(r'(.)\1*', s)]
    total = 0
    for i, (c, n) in enumerate(runs):
        v = VALUES[c] * n
        total += -v if i + 1 < len(runs) and VALUES[runs[i + 1][0]] > VALUES[c] else v
    return total


E = {
    'roman': table,
    'big': {str(n): big(n) for n in [4000, 4500, 5000, 6000, 10000, 50000, 100000, 500000, 1000000, 1234567, 3999999]},
    'likely': {s: likely(s) for s in ['IIII', 'IIX', 'IC', 'VX', 'VIV', 'XCX', 'MMMM', 'XM', 'IIV', 'XIIX', 'IXI']},
    'standard_of_likely': {},
    'weekdays': {d.isoformat(): d.strftime('%A') for d in [date(2027, 4, 14), date(2026, 11, 24), date(2027, 5, 4), date(2000, 1, 1), date(1, 1, 1)]},
    'feb_days': {str(y): (date(y, 3, 1) - date(y, 2, 1)).days for y in [1900, 2000, 2024, 2027]},
}
E['standard_of_likely'] = {s: big(v) for s, v in E['likely'].items()}
# Numerals whose likely value is below 1, which no Roman numeral can stand for.
E['likely_low'] = {s: likely(s) for s in ['IIIIIV', 'IIIIIIV', 'IIIIIIIIIIX']}
json.dump(E, sys.stdout, ensure_ascii=False, indent=0)
print()
