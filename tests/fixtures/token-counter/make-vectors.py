# Known-answer vectors for tests/tools/token-counter.test.js, computed with
# OpenAI's tiktoken 0.14.0 (encode_ordinary), independent of the page.
# Run: pip install tiktoken==0.14.0 && python3 make-vectors.py
import tiktoken, json, random
o=tiktoken.get_encoding('o200k_base'); c=tiktoken.get_encoding('cl100k_base')
EXAMPLE = ('Tokenizers split text into pieces. Common words like "the" are a single token, while rare ones such as "antidisestablishmentarianism" are split up.\n\n'
    'Numbers: 2026, 1234567 and 3.14159\n'
    'Code: const total = items.reduce((a, b) => a + b, 0);\n'
    'Other languages: Größe, 東京は日本の首都です。\n'
    'Emoji: 👋🏽 🚀')
random.seed(42)
dna = ''.join(random.choice('ACGT') for _ in range(30000))
cases = [
  ('hello', 'Hello world'),
  ('example', EXAMPLE),
  ('contractions', "It's a well-known fact: we'll see, they'VE gone. DON'T PANIC! it'ſ odd"),
  ('code', 'def f(x):\n    return {"a": [1, 2, 3]}  # note\n\n\tif x  >=  10:\r\n        pass   \n  '),
  ('languages', 'Größe 東京 مرحبا Привет नमस्ते ελληνικά 한국어 ﬁx ǅungla'),
  ('emoji', '🫠👋🏽🚀 👨‍👩‍👧 🇯🇵 ❤️'),
  ('numbers', '1234567890 3.14159 0.001 ½ ٣٤٥ Ⅻ 2²'),
  ('whitespace', 'a b　c\u0085d﻿e f  \n\n  g\t\t\n'),
  ('special', '<|endoftext|> and <|fim_prefix|> stay text'),
  ('trailing', 'end with spaces and newlines \n \n   '),
]
out = []
for name, t in cases:
    out.append({'name': name, 't': t, 'o': o.encode_ordinary(t), 'c': c.encode_ordinary(t)})
big = [('a20000', 'a' * 20000), ('dna', dna), ('digits', '9' * 5000 + ' ' + '12' * 2000)]
for name, t in big:
    out.append({'name': name, 't': t, 'oCount': len(o.encode_ordinary(t)), 'cCount': len(c.encode_ordinary(t))})
import os
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vectors.json'), 'w'), ensure_ascii=False)
for x in out: print(x['name'], len(x.get('o', [])) or x.get('oCount'), len(x.get('c', [])) or x.get('cCount'))
