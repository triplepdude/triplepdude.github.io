"""Expected words for the number-to-words test, from the num2words library (0.5.14), not
from the page: its English output is British, with commas between groups, so the American
form is that text without "and" and commas. num2words spells 10**54 "septdecillion";
dictionaries (Merriam-Webster) and the page use "septendecillion".
Run with:  python3 expected.py  (writes expected.json next to it)."""
import json
import os
import random

from num2words import num2words


def uk(n, **kw):
    return num2words(n, **kw).replace('septdecillion', 'septendecillion')


def us(text):
    return text.replace(',', '').replace(' and ', ' ')


rnd = random.Random(2026)
numbers = [0, 1, 7, 10, 11, 13, 19, 20, 21, 40, 99, 100, 101, 110, 115, 999, 1000, 1001, 1010, 1100, 2026, 10000, 10001,
           100000, 100100, 1000000, 1000001, 1001000, 1050000, 12345678, 10**9, 10**12 + 5, 10**15, 10**18, 10**21,
           10**33, 10**51, 10**54, 10**57, 10**60, 10**63, 10**66 - 1]
for length in range(1, 67):
    for _ in range(2):
        numbers.append(rnd.randrange(10 ** (length - 1), 10 ** length))
cardinal = [{'n': str(n), 'uk': uk(n), 'us': us(uk(n))} for n in numbers]

ord_numbers = [0, 1, 2, 3, 4, 5, 8, 9, 11, 12, 13, 20, 21, 22, 23, 30, 99, 100, 101, 102, 103, 111, 112, 113, 1000, 1001,
               1012, 2026, 10**6, 10**9 + 3, 10**21] + [rnd.randrange(1, 10 ** rnd.randrange(1, 30)) for _ in range(20)]
ordinal = [{'n': str(n), 'uk': uk(n, to='ordinal'), 'us': us(uk(n, to='ordinal')), 'num': num2words(n, to='ordinal_num')}
           for n in ord_numbers]

indian_numbers = [1000, 10000, 99999, 100000, 100001, 120000, 1234567, 10000000, 10000005, 98765432, 123456789, 9999999999]
indian_numbers += [rnd.randrange(10 ** 5, 10 ** 10) for _ in range(10)]
indian = [{'n': str(n), 'uk': num2words(n, lang='en_IN')} for n in indian_numbers]

data = {'cardinal': cardinal, 'ordinal': ordinal, 'indian': indian}
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.json'), 'w', encoding='utf8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=1)
print(len(cardinal), 'cardinal,', len(ordinal), 'ordinal,', len(indian), 'Indian')
print(cardinal[-3]['us'][:120])
print(indian[-1])
