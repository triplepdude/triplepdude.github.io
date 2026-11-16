#!/usr/bin/env python3
"""Expected results for tests/tools/json-formatter.test.js, worked out without the page.

  python3 make_expected.py     writes expected.json and big.json next to this file

1. "objects": Python values written by the json module in odd layouts (the inputs) and in the
   layouts the page offers (the expected results): 2 spaces, 4 spaces, tab, minified, and the
   same with sort_keys, which orders keys by code point.
2. "raw": JSON texts whose numbers and strings a parser would rewrite (1.0, 1E5, \\u00e9, a
   20-digit integer, a repeated key). The page must copy every token as written, so the
   expected text comes from a small tokenizer below, not from json.dumps.
3. "invalid": texts that are not JSON, with the verdict of Python's parser and the line and
   column at which it stops.
4. "python": Python literals (single quotes, True, None, trailing commas) and the value they
   stand for according to ast.literal_eval; the page's Fix must arrive at the same value.
5. big.json: a 150 KB document for the background-thread path, with the SHA-256 of its
   formatted and minified forms.
"""
import ast
import hashlib
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def dumps(value, indent=None, sort=False):
    if indent is None:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=sort)
    return json.dumps(value, ensure_ascii=False, indent=indent, sort_keys=sort)


TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]')


def reformat(text, indent):
    """Lays out a valid JSON text again, token by token, changing only the white space."""
    tokens = TOKEN.findall(text)
    assert ''.join(tokens) == re.sub(r'[ \t\r\n]+(?=(?:[^"\\]|\\.|"(?:[^"\\]|\\.)*")*$)', '', text), text
    out, depth = [], 0
    for i, tok in enumerate(tokens):
        nxt = tokens[i + 1] if i + 1 < len(tokens) else ''
        if tok in '{[':
            out.append(tok)
            if nxt in '}]':
                continue
            depth += 1
            if indent is not None:
                out.append('\n' + indent * depth)
        elif tok in '}]':
            if tokens[i - 1] not in '{[':
                depth -= 1
                if indent is not None:
                    out.append('\n' + indent * depth)
            out.append(tok)
        elif tok == ',':
            out.append(',' if indent is None else ',\n' + indent * depth)
        elif tok == ':':
            out.append(':' if indent is None else ': ')
        else:
            out.append(tok)
    return ''.join(out)


deep = 7
for _ in range(60):
    deep = [deep]

OBJECTS = {
    'simple': {"id": 1042, "name": "Ada", "tags": ["a", "b"], "ok": True, "off": False, "none": None},
    'nested': {"a": {"b": {"c": {"d": [1, [2, [3, [4]]], {"e": {}}], "f": []}}}},
    'empties': {"o": {}, "a": [], "s": "", "": 0, "mix": [[], {}, [[]], [{}], ""]},
    'numbers': [0, -1, 1.5, -0.25, 1e+30, 1e-07, 123456789012345678901234567890, 3.141592653589793, 2.5e-10, -9007199254740993],
    'strings': {"quote": 'say "hi"', "backslash": 'C:\\temp\\new', "breaks": "line1\nline2\ttab\r", "control": "\x01\x1f\b\f",
                "slash": "a/b", "unicode": "h\u00e9llo w\u00f6rld \u2713 \u65e5\u672c\u8a9e \U0001F600 \u2028", "del": "\x7f"},
    'sort': {"b": 1, "a": 2, "B": 3, "A": 4, "10": 5, "9": 6, "\u00e9": 7, "z": {"y": 1, "x": [{"d": 1, "c": 2}]},
             "\U0001F600": 8, "\uE000": 9, "": 10, "aa": 11, "a b": 12, "a\"": 13},
    'array of objects': [{"k": 1, "v": [1, 2]}, {"k": 2, "v": []}, {"k": 3, "v": {"z": None}}],
    'string': "just a string",
    'number': -12.5,
    'true': True,
    'null': None,
    'deep': deep,
    'wide': {"k%03d" % i: i for i in range(300)},
}


def layouts(value):
    """Three ways of writing the same value: spread out, tight with odd spacing, Windows line ends."""
    return [
        '\n \t' + json.dumps(value, ensure_ascii=False, separators=(' , ', ' :\t')) + ' \r\n',
        dumps(value),
        json.dumps(value, ensure_ascii=False, indent=3).replace('\n', '\r\n'),
    ]


RAW = [
    '{"a":1.0,"b":1E5,"c":"\\u00e9\\/\\ud83d\\ude00","d":12345678901234567890,"e":-0,"f":0.10,"g":1e-2,"h":[1.50,2.0e+3],"dup":1,"dup":2}',
    '[1.000,  -0.0 ,6.02214076e23,1E+2, 0e0, 1e400]',
    ' "\\u0041\\u00DF\\uD834\\uDD1E \\b\\f\\n\\r\\t\\"\\\\" ',
    '{"2":"b","10":"c","1":"a","x":{"02":0,"2":0}}',
]

INVALID = [
    '{"a": tru}', '{"a" 1}', '[1, 2', '{"a": 1} x', '{\n  "a": 1,\n  "b": [1, 2,\n  "c"\n  x]\n}', '[\n  1,\n  2\n  @\n]',
    '{"a": 1,}', '[1,]', "{'a': 1}", '{a: 1}', '[01]', '["a\nb"]', '["a\tb"]', '[1,,2]', '{"a":1}{"b":2}', '"\\x41"', '[1.]', '[.5]',
    '[+1]', '[NaN]', '[Infinity]', '[-Infinity]', 'nul', '[1 2]', '{"a":1 "b":2}', '["\\u12G4"]', '{"a":1}]', '[1e]', '[-]',
    '{"a":}', '{"a"}', '"abc', '[1}', '// c\n1', '[1] // c', '[True]', '[None]', '{"a":1;}', '\ufeff{}', '[\u00a01]', '[1\u200b]',
    '{"a":1},', '1 2', '[0x10]', '[1_000]', '["\\"]', '[tru e]', '{"a":"b"\n"c":"d"}', '[', '{', ']', '}', ',', ':', '-', '"', "'",
    '{"msg": "say "hi" now"}', '[2024-01-01]', '{"a" = 1}', '[\u201ca\u201d]', '[undefined]', '\x00', '[1\x0b]', '{"a":1,"a"}',
]


def reject(_):
    raise ValueError('not JSON')


def verdict(text):
    try:
        json.loads(text, parse_constant=reject)
        return {'valid': True}
    except json.JSONDecodeError as e:
        return {'valid': False, 'line': e.lineno, 'col': e.colno, 'why': e.msg}
    except ValueError as e:
        return {'valid': False, 'why': str(e)}


PYTHON = [
    "{'name': 'Ada', 'tags': ['a', 'b',], 'ok': True, 'off': False, 'none': None,}",
    "[{'its': \"mixed\"}, 'xy', -1.5e3, 0x1F, {'k': [None, True]},]",
    "{'quote': 'say \"hi\"', 'apos': 'it\\'s', 'back': 'a\\\\b', 'n': 'a\\nb'}",
]

random.seed(20261115)
WORDS = ['alpha', 'beta', 'gamma', 'delta', 'caf\u00e9', '\u65e5\u672c', 'line\nbreak', 'q"uote', 'back\\slash', '', 'x' * 40]


def rand(depth):
    r = random.random()
    if depth > 4 or r < 0.3:
        return random.choice([random.randint(-10**6, 10**18), round(random.uniform(-1000, 1000), 3), True, False, None,
                              random.choice(WORDS), random.choice(WORDS) + str(random.randint(0, 99))])
    if r < 0.6:
        return [rand(depth + 1) for _ in range(random.randint(0, 6))]
    return {random.choice(WORDS) + str(random.randint(0, 999)): rand(depth + 1) for _ in range(random.randint(0, 6))}


def main():
    big = [rand(0) for _ in range(60)]
    while len(dumps(big)) < 150000:
        big.append(rand(0))
    big_text = dumps(big)
    with open(os.path.join(HERE, 'big.json'), 'w', encoding='utf-8', newline='') as f:
        f.write(big_text)
    sha = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()
    raw = []
    for text in RAW:
        value = json.loads(text)
        for indent in ('  ', None):
            assert json.loads(reformat(text, indent)) == value
        raw.append({'input': text, 'indent2': reformat(text, '  '), 'tab': reformat(text, '\t'), 'min': reformat(text, None)})
    out = {
        'objects': [{'name': name, 'inputs': layouts(v), 'indent2': dumps(v, 2), 'indent4': dumps(v, 4), 'tab': dumps(v, '\t'), 'min': dumps(v),
                     'sorted2': dumps(v, 2, True), 'sortedMin': dumps(v, None, True)} for name, v in OBJECTS.items()],
        'raw': raw,
        'invalid': [dict(input=t, **verdict(t)) for t in INVALID],
        'python': [{'input': t, 'value': ast.literal_eval(t)} for t in PYTHON],
        'big': {'chars': len(big_text), 'bytes': len(big_text.encode('utf-8')), 'indent2': {'sha256': sha(dumps(big, 2)), 'bytes': len(dumps(big, 2).encode('utf-8'))},
                'min': {'sha256': sha(big_text)}, 'sorted4': {'sha256': sha(dumps(big, 4, True))}},
    }
    assert all(not c['valid'] for c in out['invalid']), [c['input'] for c in out['invalid'] if c['valid']]
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=True, indent=1)
        f.write('\n')
    print('objects', len(out['objects']), 'raw', len(raw), 'invalid', len(out['invalid']), 'big', out['big']['chars'])


if __name__ == '__main__':
    main()
