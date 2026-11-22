"""Makes assets/vendor/common-words/words.txt, the typing test's common words.

The source is the list of the 10,000 most frequent words (1-grams) of the
English Google Books Ngram Corpus, books published 2010-2019, compiled by
orgtre and licensed under CC BY 3.0:
https://raw.githubusercontent.com/orgtre/google-books-ngram-frequency/e20471c15a758be3362b16d07870b34df4f7ccc3/ngrams/1grams_english.csv

Download that file anywhere, then run from the repository root:
    python3 tests/fixtures/typing-test/build_words.py path/to/1grams_english.csv

Of the 1,000 most frequent words it keeps, in frequency order, those written
in lower case and I. Names and other capitalised words (God, England) are left
out, and so are the words spelt the American way, as the site uses British
spelling.
"""
import csv
import hashlib
import os
import re
import sys

SHA256 = 'f7f63aa08f0bb2f7f654cddff3a7ced4968b27887b2c0e7cd4b4d108221e197d'
TOP = 1000
AMERICAN = {'toward', 'program', 'percent', 'center', 'organization', 'behavior'}
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'assets', 'vendor', 'common-words', 'words.txt')


def main(src):
    with open(src, 'rb') as f:
        data = f.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        sys.exit(f'{src}: sha256 {digest}, expected {SHA256}')
    rows = list(csv.DictReader(data.decode('utf-8').splitlines()))[:TOP]
    words = [r['ngram'] for r in rows
             if (re.fullmatch(r'[a-z]+', r['ngram']) or r['ngram'] == 'I') and r['ngram'] not in AMERICAN]
    missing = AMERICAN - {r['ngram'] for r in rows}
    if missing:
        sys.exit(f'not among the first {TOP}: {sorted(missing)}')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(words) + '\n')
    mean = sum(len(w) for w in words) / len(words)
    print(f'{len(words)} words, mean length {mean:.2f} letters -> {os.path.normpath(OUT)}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
