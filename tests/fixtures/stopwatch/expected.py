#!/usr/bin/env python3
"""Expected stopwatch results for tests/tools/stopwatch.test.js.

Press times (ms from the start) go in; lap times, totals, the average lap
(rounded half up), the fastest and slowest laps, the CSV and copied text and
the page address come out, worked out here with integer arithmetic rather
than read back from the page. Run: python3 expected.py > expected.json
"""
import json


def clock(ms, hours_always=False):
    h, rest = divmod(ms, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, f = divmod(rest, 1000)
    if hours_always:
        return f'{h}:{m:02d}:{s:02d}.{f:03d}'
    return (f'{h}:{m:02d}' if h else f'{m:02d}') + f':{s:02d}.{f:03d}'


def seconds(ms):
    return f'{ms // 1000}.{ms % 1000:03d}'


def scenario(laps_at, stopped_at):
    totals = list(laps_at)
    laps = [t - (totals[i - 1] if i else 0) for i, t in enumerate(totals)]
    n = len(laps)
    avg = (2 * totals[-1] + n) // (2 * n)          # half up
    lo, hi = min(laps), max(laps)
    rows = [(i + 1, laps[i], totals[i]) for i in range(n)]
    if stopped_at > totals[-1]:
        rows.append((n + 1, stopped_at - totals[-1], stopped_at))
    head = ['Lap', 'Lap time', 'Total time', 'Lap (s)', 'Total (s)']
    body = [[str(r[0]), clock(r[1], True), clock(r[2], True), seconds(r[1]), seconds(r[2])] for r in rows]
    return {
        'table': [[str(i + 1), clock(laps[i]), clock(totals[i])] for i in reversed(range(n))],
        'average': clock(avg),
        'fastest': clock(lo), 'fastestLaps': [i + 1 for i in range(n) if laps[i] == lo],
        'slowest': clock(hi), 'slowestLaps': [i + 1 for i in range(n) if laps[i] == hi],
        'csv': '\r\n'.join(','.join(r) for r in [head] + body) + '\r\n',
        'tsv': '\n'.join('\t'.join(r) for r in [head] + body),
        # The same text as copied in a language that writes 1,5.
        'tsvComma': '\n'.join('\t'.join(c.replace('.', ',') for c in r) for r in [head] + body),
        'hash': f'#p{stopped_at}' + (';' + ','.join(str(x) for x in laps) if laps else ''),
        'stopped': clock(stopped_at),
    }


out = {
    # The guide's example: laps at 1:05.123, 2:06.123 and 3:08.623, stopped 1.5 s later.
    'guide': scenario([65_123, 126_123, 188_623], 190_123),
    # Resumed (the press held 80 ms before release), lap 4 920 ms later,
    # stopped 50 ms after that:
    # 191,123 / 4 = 47,780.75 ms, so the average rounds up to 47,781.
    'more': scenario([65_123, 126_123, 188_623, 191_123], 191_173),
    'hours': clock(3_725_123),
    'longest': clock(999 * 3_600_000 + 59 * 60_000 + 59_999),
}
print(json.dumps(out, indent=1, ensure_ascii=False))
