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

# ---- Every option at once: words, ordinal, money and cheque for random numbers ----
# Worked out here from the rules, not from the page: the short scale is checked against
# num2words below; the long scale (a million times per name) and Indian numbers above
# 99 crore (read as so many crore) follow the same group rules.
ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
SHORT = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion', 'octillion', 'nonillion',
         'decillion', 'undecillion', 'duodecillion', 'tredecillion', 'quattuordecillion', 'quindecillion', 'sexdecillion', 'septendecillion',
         'octodecillion', 'novemdecillion', 'vigintillion']
LONG = ['', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion', 'octillion', 'nonillion', 'decillion']


def two(n):
    return ONES[n] if n < 20 else TENS[n // 10] + ('-' + ONES[n % 10] if n % 10 else '')


def three(n, br):
    h, r = divmod(n, 100)
    return ' '.join(([ONES[h] + ' hundred'] if h else []) + ([('and ' if h and br else '') + two(r)] if r else []))


def join(parts, br, commas):
    """parts: (words, is the last group below a thousand, value). British English puts
    "and" before a last group below 100: one thousand and five."""
    if not parts:
        return 'zero'
    sep = ', ' if commas else ' '
    if br and len(parts) > 1 and parts[-1][1] and parts[-1][2] < 100:
        return sep.join(p[0] for p in parts[:-1]) + ' and ' + parts[-1][0]
    return sep.join(p[0] for p in parts)


def short_words(n, br, commas=False):
    groups = []
    while n:
        n, g = divmod(n, 1000)
        groups.append(g)
    parts = [(three(g, br) + (' ' + SHORT[k] if k else ''), k == 0, g) for k, g in reversed(list(enumerate(groups))) if g]
    return join(parts, br, commas)


def long_words(n, br, commas=False):
    units, thousands, n = n % 1000, n // 1000 % 1000, n // 10 ** 6
    parts, k = [], 1
    while n:
        n, g = divmod(n, 10 ** 6)
        if g:
            hi, lo = divmod(g, 1000)
            w = ([three(hi, br) + ' thousand'] if hi else []) + ([('and ' if hi and br and lo < 100 else '') + three(lo, br)] if lo else [])
            parts.insert(0, (' '.join(w) + ' ' + LONG[k], False, g))
        k += 1
    parts += [(three(thousands, br) + ' thousand', False, thousands)] if thousands else []
    parts += [(three(units, br), True, units)] if units else []
    return join(parts, br, commas)


def indian_words(n, br, commas=False):
    crore, rest = divmod(n, 10 ** 7)
    lakh, rest = divmod(rest, 10 ** 5)
    th, units = divmod(rest, 1000)
    parts = ([(indian_words(crore, br) + ' crore', False, crore)] if crore else []) + ([(two(lakh) + ' lakh', False, lakh)] if lakh else [])
    parts += ([(two(th) + ' thousand', False, th)] if th else []) + ([(three(units, br), True, units)] if units else [])
    return join(parts, br, commas)


WORDS = {'short': short_words, 'long': long_words, 'indian': indian_words}
for n in numbers:
    assert short_words(n, True, True) == uk(n), n


def denominator(places, scale, plural):
    if places <= 2:
        name = ['', 'tenth', 'hundredth'][places]
    elif scale == 'long':
        k, r = divmod(places, 6)
        name = ['', 'ten-', 'hundred-', 'thousand-', 'ten-thousand-', 'hundred-thousand-'][r] + LONG[k] + 'th' if k else \
            ['', '', '', 'thousandth', 'ten-thousandth', 'hundred-thousandth'][r]
    else:
        k, r = divmod(places, 3)
        name = ['', 'ten-', 'hundred-'][r] + SHORT[k] + 'th'
    return name + ('s' if plural else '')


ORD = {'one': 'first', 'two': 'second', 'three': 'third', 'five': 'fifth', 'eight': 'eighth', 'nine': 'ninth', 'twelve': 'twelfth'}


def ordinal_words(text):
    head, last = text[:len(text) - len(text.replace('-', ' ').split()[-1])], text.replace('-', ' ').split()[-1]
    return head + (ORD.get(last) or (last[:-1] + 'ieth' if last.endswith('y') else last + 'th'))


def letter_case(s, mode):
    if mode == 'upper':
        return s.upper()
    if mode == 'sentence':
        return s[:1].upper() + s[1:]
    if mode == 'title':
        return ' '.join('-'.join(w if (w == 'and' and i + j) else w[:1].upper() + w[1:] for j, w in enumerate(word.split('-')))
                        for i, word in enumerate(s.split(' ')))
    return s


CURRENCY = {'usd': ('dollar', 'dollars', 'cent', 'cents'), 'gbp': ('pound', 'pounds', 'penny', 'pence'),
            'eur': ('euro', 'euros', 'cent', 'cents'), 'inr': ('rupee', 'rupees', 'paisa', 'paise')}


def combo(digits, frac, neg, o):
    br, n, mode = o['style'] == 'uk', int(digits), o['case']
    w = WORDS[o['scale']](n, br, o['commas'])
    numerator = frac.lstrip('0')
    text = w
    if frac and o['dec'] == 'point':
        text = w + ' point ' + ' '.join(ONES[int(c)] for c in frac)
    elif frac and o['dec'] == 'over':
        text = ('' if n == 0 else w + ' and ') + frac + '/1' + '0' * len(frac)
    elif numerator:
        text = ('' if n == 0 else w + ' and ') + WORDS[o['scale']](int(numerator), br, o['commas']) + ' ' + denominator(len(frac), o['scale'], numerator != '1')
    r = {'words': letter_case(('minus ' if neg else '') + text, mode)}
    if not neg and not numerator:
        r['ordinal'] = letter_case(ordinal_words(w), mode)
    if not frac[2:].strip('0'):
        minor = int((frac + '00')[:2])
        one, many, sub_one, sub_many = CURRENCY[o['cur']]
        major = w + ' ' + (one if n == 1 else many)
        cents = two(minor) + ' ' + (sub_one if minor == 1 else sub_many)
        r['money'] = letter_case(('minus ' if neg else '') + (major + ' and ' + cents if n and minor else cents if minor else major), mode)
        if not neg and o['cur'] == 'usd':
            r['cheque'] = letter_case(w + ' and %02d/100' % minor, mode)
        elif not neg and o['cur'] != 'eur':
            cheque = ('rupees ' + w if o['cur'] == 'inr' else major) if n or not minor else ''
            r['cheque'] = letter_case(cheque + (' and ' if cheque and minor else '') + (cents if minor else '') + ' only', mode)
    return r


combos = []
for _ in range(80):
    length = rnd.choice([1, 2, 3, 4, 6, 7, 9, 12, 15, 20, 33, 45, 60, 66])
    digits = ''.join(rnd.choice('0000123456789') for _ in range(length)).lstrip('0') or '0'
    frac = ''.join(rnd.choice('0000123456789') for _ in range(rnd.choice([0, 0, 1, 2, 2, 3, 5, 7, 12, 30, 65])))
    neg = rnd.random() < 0.15 and (digits != '0' or bool(frac.strip('0')))
    o = {'style': rnd.choice(['us', 'uk']), 'scale': rnd.choice(['short', 'long', 'indian']), 'dec': rnd.choice(['point', 'fraction', 'over']),
         'cur': rnd.choice(['usd', 'gbp', 'eur', 'inr']), 'case': rnd.choice(['lower', 'sentence', 'title', 'upper']), 'commas': rnd.random() < 0.3}
    combos.append({'n': ('-' if neg else '') + digits + ('.' + frac if frac else ''), 'opts': o, 'expected': combo(digits, frac, neg, o)})

data = {'cardinal': cardinal, 'ordinal': ordinal, 'indian': indian, 'combos': combos}
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.json'), 'w', encoding='utf8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=1)
print(len(cardinal), 'cardinal,', len(ordinal), 'ordinal,', len(indian), 'Indian,', len(combos), 'combinations')
print(cardinal[-3]['us'][:120])
print(indian[-1])
