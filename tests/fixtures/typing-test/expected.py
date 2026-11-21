#!/usr/bin/env python3
"""Expected results for tests/tools/typing-test.test.js.

Each scenario is a list of actions that the test replays on a fake clock:
  ["type", text, ms]   type each character, then let ms pass
  ["back", n, ms]      press Backspace n times, ms after each
  ["insert", text, ms] insert the whole text in one go (as a phone keyboard's
                       word suggestion does), then let ms pass
  ["wait", ms]         let ms pass
This script works out, independently of the page, what the page must show:
it follows the rules written in the page's guide (a word is 5 characters,
WPM counts correct words and their spaces, raw WPM every character, accuracy
every key that typed a character, consistency the keys in each whole second).

  python3 expected.py      writes expected.json next to this file
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PASSAGES = os.path.join(HERE, '..', '..', '..', 'assets', 'vendor', 'standard-ebooks-passages', 'passages.json')
TEXTS = {p['id']: p['text'] for p in json.load(open(PASSAGES, encoding='utf-8'))['passages']}
TITLES = {'the-great-gatsby': 'The Great Gatsby', 'alice': 'Alice’s Adventures in Wonderland'}

# Typographic forms accepted for the straight characters in the passages.
ALSO = {"'": set('‘’ʼ′'), '"': set('“”„″'), '-': set('‐‑‒–−')}


def matches(typed_char, wanted):
    return typed_char == wanted or typed_char in ALSO.get(wanted, ())


def tidy(text):
    """What the text box keeps: no leading space, one space between words."""
    out = []
    for ch in text:
        if ch.isspace():
            if out and out[-1] != ' ':
                out.append(' ')
        else:
            out.append(ch)
    return ''.join(out)


def thousands(n):
    return f'{n:,}'


def plural(n, one, many):
    return f'{thousands(n)} {one if n == 1 else many}'


def round_half_up(num, den):
    """round(num / den) for whole numbers, halves up."""
    return (2 * num + den) // (2 * den)


def js_round(x):
    return math.floor(x + 0.5)


def pct(tenths):
    return f'{tenths // 10}.{tenths % 10}%'


def run(book, seconds, actions):
    words = TEXTS[book].split(' ')
    value = ''
    clock = 0          # ms since the first action
    start = None       # clock at the first key that typed a character
    keys = good_keys = 0
    per_second = [0] * seconds
    finished_at = None

    def passage_done(v):
        typed = v.split(' ')
        if len(typed) > len(words):
            return True
        if len(typed) == len(words):
            last, want = typed[-1], words[-1]
            return len(last) == len(want) and all(matches(a, b) for a, b in zip(last, want))
        return False

    def change(new_value):
        nonlocal value, start, keys, good_keys, finished_at
        new_value = tidy(new_value)
        if new_value == value:
            return
        if start is not None:
            assert clock < start + seconds * 1000, 'the scenario types after the end'
        if len(new_value) > len(value):
            assert new_value.startswith(value)
            if start is None:
                start = clock
            for k in range(len(value), len(new_value)):
                ch = new_value[k]
                before = new_value[:k].split(' ')
                wi, li = len(before) - 1, len(before[-1])
                want = words[wi] if wi < len(words) else ''
                if ch == ' ':
                    ok = li >= len(want)
                else:
                    ok = li < len(want) and matches(ch, want[li])
                keys += 1
                good_keys += ok
                per_second[min(seconds - 1, (clock - start) // 1000)] += 1
        value = new_value
        if passage_done(value):
            finished_at = clock

    for action in actions:
        if finished_at is not None:
            raise AssertionError('the scenario goes on after the passage ended')
        kind = action[0]
        if kind == 'type':
            for ch in action[1]:
                change(value + ch)
                if finished_at is not None:
                    break
                clock += action[2]
        elif kind == 'back':
            for _ in range(action[1]):
                change(value[:-1])
                clock += action[2]
        elif kind == 'insert':
            change(value + action[1])
            if finished_at is None:
                clock += action[2]
        elif kind == 'wait':
            clock += action[1]

    ms = seconds * 1000 if finished_at is None else finished_at - start
    typed = value.split(' ')
    good = chars = errors = 0
    wrong = []
    for i, w in enumerate(typed):
        in_progress = i == len(typed) - 1
        want = words[i] if i < len(words) else ''
        chars += len(w) + (0 if in_progress else 1)
        if in_progress and not w:
            continue
        e = sum(1 for a, b in zip(w, want) if not matches(a, b))
        e += max(0, len(w) - len(want))
        if not in_progress:
            e += max(0, len(want) - len(w))
        if e:
            errors += e
            wrong.append([i + 1, want, w])
        else:
            good += len(w) + (0 if in_progress else 1)

    whole = min(seconds, ms // 1000)
    bins = per_second[:whole]
    if len(bins) < 2:
        consistency = None
    else:
        total = 0
        for b in bins:
            total += b
        mean = total / len(bins)
        sq = 0.0
        for b in bins:
            sq += (b - mean) * (b - mean)
        cv = math.sqrt(sq / len(bins)) / mean
        consistency = max(0, js_round(100 * (1 - cv)))

    wpm = round_half_up(good * 12000, ms)
    raw = round_half_up(chars * 12000, ms)
    acc = round_half_up(1000 * good_keys, keys)
    if acc == 1000 and good_keys < keys:
        acc = 999

    groups = [round_half_up(sum(bins[i:i + 5]) * 12, 5) for i in range(0, len(bins) - 4, 5)]
    top, low = max(groups), min(groups)
    heights = [(max(4 if g else 0, js_round(g / top * 100)) if top else 0) for g in groups]
    hi, lo = groups.index(top), groups.index(low)
    bars_note = (f'Speed in each 5 seconds, counting every key: fastest {top} WPM (seconds {hi * 5 + 1} to {hi * 5 + 5}), '
                 f'slowest {low} WPM (seconds {lo * 5 + 1} to {lo * 5 + 5}).')

    early = finished_at is not None
    if early:
        took = f'{ms / 1000:.1f}'.removesuffix('.0') + ' seconds'
    else:
        took = f'{seconds} seconds' if seconds < 60 else ('1 minute' if seconds == 60 else f'{seconds // 60} minutes')
    bad_keys = keys - good_keys
    detail = (f'You typed {plural(chars, "character", "characters")} in {took}, {thousands(good)} of them in correct words. '
              f'{plural(keys, "key", "keys")} typed a character and {thousands(bad_keys)} of them {"was" if bad_keys == 1 else "were"} wrong. '
              + (f'{plural(errors, "error", "errors")} left in {plural(len(wrong), "word", "words")}.' if errors else 'No errors left in the text.'))
    con_text = '' if consistency is None else f', consistency {consistency}%'
    spoken = (('Passage finished. ' if early else 'Time is up. ') + f'{wpm} words per minute, raw {raw}, accuracy {pct(acc)}{con_text}. '
              + (f'{plural(len(wrong), "word", "words")} with errors.' if wrong else 'No errors left.'))
    length = f'{seconds} seconds' if seconds < 60 else ('1 minute' if seconds == 60 else f'{seconds // 60} minutes')
    copy = [f'Typing test ({length}, {TITLES[book]}): {wpm} WPM', f'Raw {raw} WPM, accuracy {pct(acc)}{con_text}']
    copy.append('Words with errors: ' + ', '.join(f'{w[2]} ({w[1]})' for w in wrong[:10]) if wrong else 'No errors left in the text')
    left = start + seconds * 1000 - (finished_at if early else start + seconds * 1000)
    left_s = math.ceil(left / 1000)
    return {
        'value': value, 'wpm': str(wpm), 'raw': str(raw), 'acc': pct(acc),
        'con': '–' if consistency is None else f'{consistency}%', 'errorWords': str(len(wrong)),
        'wrong': [[thousands(w[0]), w[1], w[2]] for w in wrong], 'detail': detail, 'heights': [f'{h}%' for h in heights],
        'barsNote': bars_note, 'spoken': spoken, 'copy': copy, 'timeLeft': f'{left_s // 60}:{left_s % 60:02d}',
        'keys': keys, 'goodKeys': good_keys, 'ms': ms,
    }


SCENARIOS = {
    # 30 seconds of The Great Gatsby: a leading space (ignored), a wrong key
    # put right, a skipped letter, an extra letter, a double space, a word cut
    # short, curly quotation marks, a pause, and a word in progress at the end.
    'gatsby': {
        'hash': '#30s-the-great-gatsby', 'book': 'the-great-gatsby', 'seconds': 30,
        'actions': [
            ['type', ' ', 300],
            ['type', 'In my y', 140],
            ['type', 'p', 140],
            ['back', 1, 140],
            ['type', 'ounger and more vulnerble years my fatherr gave  me som advice that I’ve been turning over in my mind ever since. ', 140],
            ['wait', 2600],
            ['type', '“Whenever you feel li', 140],
        ],
    },
}


def alice_actions():
    words = TEXTS['alice'].split(' ')
    # One wrong key, deleted again: 6,352 right of 6,353 is 99.98%, which
    # must show as 99.9%, not 100.0%.
    acts = [['insert', 'x', 500], ['back', 1, 500]]
    for i in range(0, len(words), 15):
        chunk = ' '.join(words[i:i + 15])
        acts.append(['insert', chunk if i + 15 >= len(words) else chunk + ' ', 1000])
    return acts


# The whole first chapter of Alice, inserted 15 words a second after one
# wrong key, ends the 5-minute test early when its last word is typed.
SCENARIOS['alice'] = {'hash': '#5m-alice', 'book': 'alice', 'seconds': 300, 'actions': alice_actions()}

if __name__ == '__main__':
    out = {}
    for name, sc in SCENARIOS.items():
        res = run(sc['book'], sc['seconds'], sc['actions'])
        out[name] = {'hash': sc['hash'], 'actions': sc['actions'], **res}
        print(name, {k: res[k] for k in ('wpm', 'raw', 'acc', 'con', 'errorWords', 'keys', 'goodKeys', 'ms', 'timeLeft')})
        print('  ', res['detail'])
        print('  ', res['barsNote'])
        print('  ', res['wrong'])
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
