#!/usr/bin/env python3
"""Writes expected.json for tests/tools/lorem-ipsum-generator.test.js.

    python3 tests/fixtures/lorem-ipsum-generator/make_expected.py

The standard lorem ipsum passage and Cicero's De finibus 1.10.32-33 (the Latin as
printed in H. Rackham's 1914 Loeb edition and reproduced on lipsum.com) are typed
out here separately from the page. The test checks that every word the page
makes is one of these words, and the guide's figures (69 words, 445 characters,
210 different words, no j, k, w, y or z) are counted here.
"""
import json, os, re, string

CLASSIC = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore "
           "magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo "
           "consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. "
           "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.")
S32 = ("Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, "
       "eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam "
       "voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione "
       "voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci "
       "velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem. Ut enim "
       "ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi "
       "consequatur? Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, "
       "vel illum qui dolorem eum fugiat quo voluptas nulla pariatur?")
S33 = ("At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque "
       "corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident, similique sunt in culpa "
       "qui officia deserunt mollitia animi, id est laborum et dolorum fuga. Et harum quidem rerum facilis est et expedita "
       "distinctio. Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime "
       "placeat facere possimus, omnis voluptas assumenda est, omnis dolor repellendus. Temporibus autem quibusdam et aut "
       "officiis debitis aut rerum necessitatibus saepe eveniet ut et voluptates repudiandae sint et molestiae non "
       "recusandae. Itaque earum rerum hic tenetur a sapiente delectus, ut aut reiciendis voluptatibus maiores alias "
       "consequatur aut perferendis doloribus asperiores repellat.")

words = re.findall(r'[a-z]+', ' '.join([CLASSIC, S32, S33]).lower())
vocab = sorted(set(words))
used = set(''.join(vocab))
out = {
    'classic': CLASSIC,
    'classic_words': len(CLASSIC.split()),
    'classic_chars': len(CLASSIC),
    'first_sentence': 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'vocab': vocab,
    'vocab_size': len(vocab),
    'letters_never_used': [c for c in string.ascii_lowercase if c not in used],
    'word_lengths': sorted({len(w) for w in vocab}),
}
assert out['classic_words'] == 69 and out['classic_chars'] == 445 and out['vocab_size'] == 210
assert out['letters_never_used'] == ['j', 'k', 'w', 'y', 'z']
assert out['word_lengths'] == list(range(1, 15)), out['word_lengths']   # every length 1..14 exists
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.json'), 'w') as f:
    json.dump(out, f, indent=1)
print('expected.json written:', out['classic_words'], 'words,', out['classic_chars'], 'characters,', out['vocab_size'], 'different words')
