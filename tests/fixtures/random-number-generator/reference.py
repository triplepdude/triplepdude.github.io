#!/usr/bin/env python3
"""Reference draws for tests/tools/random-number-generator.test.js.

The page turns 32-bit random words into numbers by the method below. This
script applies that method to fixed lists of words, independently of the
page's JavaScript, and writes the numbers that must come out (expected.json).
The test feeds the same words to the page in place of crypto.getRandomValues,
so a slip in the page's arithmetic shows up as a different list.

Method
  below(n): the fewest bits that can hold n - 1 are taken from the front of
  ceil(bits / 32) words, first word most significant. A value of n or more is
  thrown away and fresh words are taken, so every value from 0 to n - 1 is
  equally likely.
  With repeats: each number is the lowest value + below(size of the range).
  No repeats: a Fisher-Yates shuffle of the range that stops after k numbers.
  Number i is the item at position i + below(size - i), and the item that was
  at position i moves into that place.
  Decimals: the same, counted in units of the last decimal place, from the
  first such value at or above the minimum to the last one at or below the
  maximum.

The words come from SHA-256 in counter mode, so they are fixed but arbitrary.

Run:  python3 reference.py > expected.json
"""
import hashlib
import json
import math
import sys
from fractions import Fraction


def word_stream(seed):
    counter = 0
    while True:
        block = hashlib.sha256(f'{seed}:{counter}'.encode()).digest()
        for i in range(0, 32, 4):
            yield int.from_bytes(block[i:i + 4], 'big')
        counter += 1


class Words:
    def __init__(self, source):
        self.source = iter(source)
        self.used = []

    def take(self):
        w = next(self.source)
        self.used.append(w)
        return w


def below(n, words):
    if n <= 1:
        return 0
    bits = (n - 1).bit_length()
    count = -(-bits // 32)
    while True:
        value = 0
        for _ in range(count):
            value = (value << 32) | words.take()
        value >>= count * 32 - bits
        if value < n:
            return value


def draw(lowest, size, k, unique, words):
    if not unique:
        return [lowest + below(size, words) for _ in range(k)]
    items = {}
    out = []
    for i in range(k):
        j = i + below(size - i, words)
        out.append(lowest + items.get(j, j))
        items[j] = items.get(i, i)
    return out


def text(units, places):
    sign = '-' if units < 0 else ''
    units = abs(units)
    if not places:
        return sign + str(units)
    return f'{sign}{units // 10 ** places}.{str(units % 10 ** places).rjust(places, "0")}'


def case(name, low, high, k, unique=False, places=0, source=None):
    scale = 10 ** places
    lowest = math.ceil(Fraction(low) * scale)
    highest = math.floor(Fraction(high) * scale)
    words = Words(source if source is not None else word_stream(name))
    values = draw(lowest, highest - lowest + 1, k, unique, words)
    assert all(lowest <= v <= highest for v in values)
    if unique:
        assert len(set(values)) == k
    return dict(name=name, min=low, max=high, count=k, unique=unique, places=places, words=words.used,
                numbers=[text(v, places) for v in values], sum=text(sum(values), places),
                ascending=[text(v, places) for v in sorted(values)])


CASES = [
    case('one to a hundred', '1', '100', 20),
    case('dice', '1', '6', 50),
    case('lottery', '1', '49', 6, unique=True),
    case('shuffle of ten', '1', '10', 10, unique=True),
    case('negative to positive', '-5', '5', 30),
    case('two decimal places', '0', '1', 20, places=2),
    case('negative decimals, no repeats', '-1.5', '1.5', 10, unique=True, places=3),
    case('decimal bounds, whole numbers', '1.5', '10.2', 12),
    case('forty digits', '0', '1' + '0' * 40, 5),
    case('two words, no repeats', '1', str(2 ** 64), 5, unique=True),
    case('a byte', '0', '255', 10),
    case('exactly 32 bits', '0', str(2 ** 32 - 1), 5),
    case('33 bits', '0', str(2 ** 32), 5),
    case('one value', '7', '7', 3),
    case('three hundred digits', '-' + '9' * 300, '9' * 300, 2),
    # Words chosen by hand. For 1 to 100 seven bits are used: 127 and 100 are
    # thrown away, 99 gives 100 and 0 gives 1.
    case('rejections', '1', '100', 2, source=[0xFE000000, 0xC8000000, 0xC6000000, 0x00000000]),
    # Each end of a decimal range can come up: 0 gives 0.00 and 100 gives 1.00.
    case('both ends', '0', '1', 2, places=2, source=[0x00000000, 0xC8000000]),
    # A coin: the top bit of each word. 0 is Heads (1), 1 is Tails (2).
    case('coin', '1', '2', 6, source=[0x00000000, 0x80000000, 0x7FFFFFFF, 0xFFFFFFFF, 0x80000001, 0x00000001]),
    # Negative bounds with decimals: the whole numbers inside -10.2 to -1.5 are -10 to -2.
    case('negative decimal bounds, whole numbers', '-10.2', '-1.5', 12),
    # Words chosen by hand for a range of 2^32 + 1 values (33 bits from two words). The first
    # pair gives exactly 2^32 + 1, one more than the largest value, and is thrown away; the
    # second gives 2^32, the maximum itself; the third gives 0.
    case('rejection above 32 bits', '0', str(2 ** 32), 2,
         source=[0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000]),
]

if __name__ == '__main__':
    json.dump(CASES, sys.stdout, indent=1)
    sys.stdout.write('\n')
