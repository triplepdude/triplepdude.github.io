#!/usr/bin/env python3
"""Expected results for tests/tools/spacebar-counter.test.js.

The test replays these presses on Playwright's fake clock, so each one lands
at the exact millisecond given here. Times are in ms from the first press.
This script works the results out on its own, from the rules in the page's
guide: presses per second is presses / seconds (hundredths, halves up), the
best second is the most presses within any span shorter than 1,000 ms, a key
press less than 30 ms after the previous key press is flagged, and repeats of
a held key are left out.

  python3 expected.py      writes expected.json next to this file
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def round_half_up(num, den):
    return (2 * num + den) // (2 * den)


def hundredths(c):
    return f'{c // 100}.{c % 100:02d}'


def presses(n):
    return f'{n:,} press' if n == 1 else f'{n:,} presses'


def seconds(n):
    return '1 second' if n == 1 else f'{n} seconds'


def js_round(x):
    return math.floor(x + 0.5)


def timed(length, events, best_before=None):
    """events: (time, kind) with kind 'key', 'tap' or 'repeat'; times from
    the first press. Returns what the page shows when the test is over."""
    end = length * 1000
    counted = [(t, k) for t, k in events if k != 'repeat' and t < end]
    counted.sort()
    times = [t for t, _ in counted]
    n = len(times)
    cents = round_half_up(100 * n, length)
    best = 0
    for i, t in enumerate(times):
        best = max(best, sum(1 for u in times[:i + 1] if u > t - 1000))
    gaps = [b - a for a, b in zip(times, times[1:])]
    min_gap = min(gaps) if gaps else None
    keys = [t for t, k in counted if k == 'key']
    doubles = sum(1 for a, b in zip(keys, keys[1:]) if b - a < 30)
    ignored = sum(1 for t, k in events if k == 'repeat' and t < end)
    bins = [0] * length
    for t in times:
        bins[min(length - 1, t // 1000)] += 1
    top = max(bins)
    heights = [f'{(max(4 if b else 0, js_round(b / top * 100)) if top else 0)}%' for b in bins]
    detail = f'{presses(n)} in {seconds(length)}. Best second: {presses(best)}.'
    if min_gap is not None:
        detail += f' Shortest gap: {min_gap:,} ms.'
    if ignored:
        detail += f' Held-key repeats left out: {ignored:,}.'
    if doubles:
        detail += f' {presses(doubles)} came under 30 ms after the one before, which points to key chatter.'
    first = best_before is None
    new_best = not first and cents > best_before
    session_best = cents if first or cents > best_before else best_before
    session = (f'Your first {length}-second test this session.' if first else
               f'Best {length}-second result this session: {hundredths(session_best)} per second' + (', set just now.' if new_best else '.'))
    spoken = (f'Time is up: {presses(n)} in {seconds(length)}, {hundredths(cents)} per second.'
              + (f' {presses(doubles)} less than 30 milliseconds after the one before.' if doubles else '')
              + (' Best for this length so far.' if new_best else ''))
    return {
        'count': f'{n:,}', 'score': hundredths(cents), 'cents': cents, 'best': f'{best:,}', 'doubles': f'{doubles:,}',
        'ignored': f'{ignored:,}', 'detail': detail, 'heights': heights,
        'barsNote': 'Presses in each second, from the first to the last: ' + ', '.join(str(b) for b in bins) + '.',
        'session': session, 'spoken': spoken,
        'copy': f'Spacebar test: {presses(n)} in {seconds(length)}, {hundredths(cents)} per second. Best second: {presses(best)}.',
    }


def free(events, at):
    """No time limit: the numbers at `at` ms after the first press."""
    times = sorted(t for t, k in events if k != 'repeat')
    n = len(times)
    best = 0
    for i, t in enumerate(times):
        best = max(best, sum(1 for u in times[:i + 1] if u > t - 1000))
    rate = round_half_up(n * 100000, max(1000, at))
    tenths = at // 100
    s, d = tenths // 10, tenths % 10
    shown = f'{s}.{d} s' if s < 60 else f'{s // 60}:{s % 60:02d}.{d}'
    return {'count': f'{n:,}', 'rate': hundredths(rate), 'best': f'{best:,}', 'time': shown,
            'copy': f'Spacebar counter: {presses(n)} in {shown}, {hundredths(rate)} per second. Best second: {presses(best)}.'}


def repeat_stats(down, reps):
    delay = round(reps[0] - down)
    rate = js_round((len(reps) - 1) * 10000 / (reps[-1] - reps[0]))
    held = (reps[-1] - down) / 1000
    return {'delay': f'{delay} ms', 'rate': f'{rate / 10:.1f}',
            'note': f'Measured from {len(reps)} repeats while Space was held for {held:.1f} seconds.',
            'spoken': f'Key repeat: delay {delay} milliseconds, {rate / 10:.1f} repeats per second.'}


# ---- 10-second test ----
# 15 presses 140 ms apart; a press read twice (12 ms apart); Space held for
# 810 ms with 10 repeats 33 ms apart from 500 ms on; 10 presses 100 ms apart;
# a press made 5 ms before the end that arrives after it; and a press at the
# very end, which does not count.
ten = []                     # (kind, down, up) for the test to replay
for i in range(15):
    ten.append(['press', i * 140, i * 140 + 60])
ten.append(['press', 2100, 2105])
ten.append(['press', 2112, 2160])
HOLD_DOWN, REPS = 4000, [4500 + 33 * i for i in range(10)]
ten.append(['hold', HOLD_DOWN, REPS, 4810])
for i in range(10):
    ten.append(['press', 6000 + 100 * i, 6000 + 100 * i + 40])
ten.append(['late', 9995, 10003])
ten.append(['press', 10000, 10020])

events = []
for a in ten:
    if a[0] == 'press':
        events.append((a[1], 'key'))
    elif a[0] == 'hold':
        events.append((a[1], 'key'))
        events.extend((t, 'repeat') for t in a[2])
    elif a[0] == 'late':
        events.append((a[1], 'key'))

first = timed(10, events)
# The same length again with 3 presses: the first score stays the best.
again_events = [(0, 'key'), (400, 'key'), (900, 'key')]
again = timed(10, again_events, best_before=first['cents'])

# ---- 5 seconds of taps on a touch screen: two fingers 10 ms apart are not a double ----
taps = [0, 150, 300, 450, 460, 800]
tapped = timed(5, [(t, 'tap') for t in taps])

# ---- 60 seconds: 7 presses, so 0.1166... per second shows as 0.12 ----
SIXTY = [0, 250, 500, 29500, 45000, 45200, 59999]
sixty = timed(60, [(t, 'key') for t in SIXTY])

# ---- No time limit ----
free_presses = [200 * i for i in range(10)] + [5000, 5050]
free_result = free([(t, 'key') for t in free_presses], 6000)

# The 10-second test as steps in time order for the test to replay: key
# down, key up, a repeat while held, and an event made at one time and
# delivered at another.
steps = []
for a in ten:
    if a[0] == 'press':
        steps += [[a[1], 'down'], [a[2], 'up']]
    elif a[0] == 'hold':
        steps += [[a[1], 'down']] + [[t, 'repeat'] for t in a[2]] + [[a[3], 'up']]
    elif a[0] == 'late':
        steps += [[a[1], 'make'], [a[2], 'send']]
steps.sort(key=lambda s: s[0])

out = {
    'ten': {'steps': steps, **first, 'repeat': repeat_stats(HOLD_DOWN, REPS)},
    'again': {'presses': [t for t, _ in again_events], **again},
    'taps': {'taps': taps, **tapped},
    'sixty': {'presses': SIXTY, **sixty},
    'free': {'presses': free_presses, 'at': 6000, **free_result},
}
with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1)
for k, v in out.items():
    print(k, {x: v[x] for x in v if x in ('count', 'score', 'best', 'doubles', 'ignored', 'rate', 'time')})
    for x in ('detail', 'barsNote', 'session', 'spoken', 'copy'):
        if x in v:
            print('   ', v[x])
print(out['ten']['repeat'])
