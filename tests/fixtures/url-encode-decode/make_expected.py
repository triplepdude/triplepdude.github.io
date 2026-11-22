#!/usr/bin/env python3
"""Expected results for tests/tools/url-encode-decode.test.js, worked out with Python's
urllib.parse and codecs, never with the page.

  python3 make_expected.py     writes expected.json next to this file

"encode"  each text in the four modes of the page: what JavaScript's encodeURIComponent and
          encodeURI keep, the form-urlencoded set of the URL Standard (space as +), and the
          unreserved set of RFC 3986; also with CR LF line breaks and line by line.
"decode"  percent-encoded texts read as UTF-8 and as older character sets, with + kept or read
          as a space.
"urls"    whole URLs, decoded part by part with urlsplit: + is a space in the query only.
"table"   every ASCII punctuation character in the four modes, for the page's reference table.
"""
import json
import os
import urllib.parse as u

HERE = os.path.dirname(os.path.abspath(__file__))


def component(s): return u.quote(s, safe="!'()*")
def whole(s): return u.quote(s, safe="!#$&'()*+,/:;=?@")
def form(s): return u.quote_plus(s, safe='*').replace('~', '%7E')
def strict(s): return u.quote(s, safe='')


ASCII = ''.join(chr(c) for c in range(32, 127))
TEXTS = [
    'Fish & chips: £5.50 (2 for £10?)',
    ASCII,
    'https://example.com/a path/café?q=1 + 1 = 2&lang=de#frag ment',
    'naïve café – 日本語 한국어 العربية עברית',
    '\U0001F600 \U0001F468‍\U0001F469‍\U0001F467 é \U00010000 �  \u007f \u0080 ߿ ࠀ ￿',
    '\U00020000 \U0002F800 \U000E0001 \U000FFFFF \U0010FFFF',
    'tab\there\x00\x01\x1f',
    '100% ✓ 50%25 %zz %',
    'a+b c~d*e!f\'g(h)i',
    '',
    ' ',
    'line one\nline two\n\nlast & final',
]
MULTILINE = ['line one\nline two\n\nlast & final', 'a b\n', '\n\nx=1&y=2\n']

DECODE = [
    # (text, Python codec, name of the character set on the page)
    ('Fish%20%26%20chips%3A%20%C2%A35.50%20(2%20for%20%C2%A310%3F)', 'utf-8', 'utf-8'),
    ('%e6%97%a5%E6%9c%ac%e8%aa%9E+%F0%9F%98%80', 'utf-8', 'utf-8'),
    ('a+b%2Bc+%2b+d', 'utf-8', 'utf-8'),
    ('100%25%20sure%2C%2050%2525', 'utf-8', 'utf-8'),
    ('%zz %4 % %%41 %G1 100% %', 'utf-8', 'utf-8'),
    ('caf%E9 %FF%FE ok%C3', 'utf-8', 'utf-8'),
    ('café %C3%A9 日%E6%9C%AC', 'utf-8', 'utf-8'),
    ('%00%09%0A%0D%7F', 'utf-8', 'utf-8'),
    ('', 'utf-8', 'utf-8'),
    ('nothing to do here', 'utf-8', 'utf-8'),
]
LEGACY = [
    ('Naïve café £5 €9 “quoted”', 'cp1252', 'windows-1252'),
    ('Zażółć gęślą jaźń – řeč', 'cp1250', 'windows-1250'),
    ('Příliš žluťoučký kůň', 'iso8859_2', 'iso-8859-2'),
    ('Привет, мир! Ёж', 'cp1251', 'windows-1251'),
    ('Привет, мир!', 'koi8_r', 'koi8-r'),
    ('日本語のテキスト ｶﾅ ABC', 'cp932', 'shift_jis'),
    ('日本語のテキスト', 'euc_jp', 'euc-jp'),
    ('简体中文 测试', 'gbk', 'gbk'),
    ('繁體中文 測試', 'big5', 'big5'),
    ('한국어 테스트', 'cp949', 'euc-kr'),
    # In GB 18030 the second byte of a four-byte character is a digit: U+0080 is 81 30 81 30.
    ('\u00e9 \u0080 \u20ac', 'gb18030', 'gbk'),
]
URLS = [
    'https://example.com/search?q=fish+%26+chips&price=%C2%A35.50#top',
    'https://example.com/a+b/c%2B%2B/caf%C3%A9?x=1+2&y=a%2Bb+c#sec+tion%20two',
    'http://user@host.example:8080/p+q?only+query',
    'https://example.com/no+query/here%20now#frag+1',
    '/relative/pa+th?k=v+w&k2=+',
    'https://example.com/?a=1+1%3D2&b=%2B%2B+%25',
]


def url_decoded(url):
    """Each part of the URL on its own: a + means a space in the query string and nowhere else."""
    s = u.urlsplit(url)
    out = (s.scheme + '://' + s.netloc if s.scheme else '') + u.unquote(s.path)
    if s.query or '?' in url:
        out += '?' + u.unquote_plus(s.query)
    if s.fragment or '#' in url:
        out += '#' + u.unquote(s.fragment)
    return out


def main():
    out = {
        'encode': [{'input': t, 'component': component(t), 'url': whole(t), 'form': form(t), 'rfc3986': strict(t)} for t in TEXTS],
        'lines': [{'input': t, 'crlf': {m.__name__: m(t.replace('\n', '\r\n')) for m in (component, whole, form, strict)},
                   'each': {m.__name__: '\n'.join(m(line) for line in t.split('\n')) for m in (component, whole, form, strict)}} for t in MULTILINE],
        'decode': [{'input': t, 'charset': page, 'keep': u.unquote(t, encoding=codec, errors='replace'),
                    'space': u.unquote_plus(t, encoding=codec, errors='replace')} for t, codec, page in DECODE],
        'legacy': [{'text': t, 'charset': page, 'encoded': u.quote(t, safe='', encoding=codec), 'plus': u.quote_plus(t, safe='', encoding=codec)} for t, codec, page in LEGACY],
        'urls': [{'input': url, 'auto': url_decoded(url), 'space': u.unquote_plus(url), 'keep': u.unquote(url)} for url in URLS],
        'table': [{'char': c, 'component': component(c), 'url': whole(c), 'form': form(c), 'rfc3986': strict(c)} for c in ASCII if not c.isalnum()],
    }
    for row in out['legacy']:
        # The percent-encoded form must read back to the text with Python's own decoder.
        codec = [c for t, c, p in LEGACY if t == row['text']][0]
        assert u.unquote(row['encoded'], encoding=codec) == row['text'], row
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=True, indent=1)
        f.write('\n')
    print({k: len(v) for k, v in out.items()})


if __name__ == '__main__':
    main()
