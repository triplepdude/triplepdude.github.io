Common English words for the Typing Test (/typing-test/)

Data:    Google Books Ngram Corpus, list compiled by orgtre
         ("Google Books n-gram frequency lists",
         https://github.com/orgtre/google-books-ngram-frequency)
Licence: Creative Commons Attribution 3.0 Unported (CC BY 3.0),
         https://creativecommons.org/licenses/by/3.0/ (legal code in LICENSE.txt).
         The list's source, Google's Google Books Ngram Corpus Version 3
         (20200217, https://storage.googleapis.com/books/ngrams/books/datasetsv3.html),
         is licensed under CC BY 3.0 too.
File used (downloaded 22 November 2026):
  https://raw.githubusercontent.com/orgtre/google-books-ngram-frequency/e20471c15a758be3362b16d07870b34df4f7ccc3/ngrams/1grams_english.csv
  sha256 f7f63aa08f0bb2f7f654cddff3a7ced4968b27887b2c0e7cd4b4d108221e197d
  It lists the 10,000 most frequent words of the English corpus in books
  published from 2010 to 2019, most frequent first, with their counts.

Changes made: words.txt keeps, in the same order, the words among the first
1,000 that are written in lower case, and I. Names and other words written
with a capital (God, American, England and 12 more) are left out, and so are
six words spelt the American way, as the site uses British spelling: toward,
program, percent, center, organization, behavior. That leaves 979 words, one
per line, with a mean length of 5.61 letters. The script that makes the file
is tests/fixtures/typing-test/build_words.py.

The typing test loads this file when its "Common words" text is chosen and
shows the words in a random order, each as likely as any other.
