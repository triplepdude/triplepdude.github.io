"""Known answers for tests/tools/metronome.test.js, worked out from the
definitions rather than from the page's code.

    python3 expected.py > expected.json

* Click patterns: a bar of n/4 has n quarter-note beats, beat 1 accented; 6/8,
  9/8 and 12/8 "in 2, 3, 4" have dotted-quarter beats of three eighth notes;
  6/8 "in 6" has six eighth-note beats with the main stress on 1 and a lighter
  one on 4. A subdivision splits each beat into equal parts. Times are exact
  fractions of a second from the first click (60 / BPM / parts per beat).
  Levels: A = accented beat 1, B = other beat, s = quiet click, f = quieter
  click. In 6/8, 9/8 and 12/8 a sixteenth note that falls between two eighth
  notes is an f, so the eighth notes stay audible: 6/8 in 2 with sixteenths
  is A f s f s f B f s f s f, and 6/8 in 6 with sixteenths A f s f s f B f s f s f.
* Tempo markings: the ranges printed on Wittner's metronome scale (Largo 40-60,
  Larghetto 60-66, Adagio 66-76, Andante 76-108, Moderato 108-120, Allegro
  120-168, Presto 168-200, Prestissimo 200-208) and, below 40, Wikipedia's
  Larghissimo (24 and under) and Grave (24-40). Where two ranges share an end
  point the faster marking is used.
* Tap tempo: the least-squares slope of tap time against tap number (numpy
  polyfit), 60000 / slope, rounded to a whole BPM.
"""
import json
from fractions import Fraction

import numpy as np

# (quiet clicks between beats come from the subdivision; in 6/8 counted in 6
# the weak eighths are quiet clicks too)
METRES = {
    '1-4': ['A'], '2-4': ['A', 'B'], '3-4': ['A', 'B', 'B'], '4-4': ['A', 'B', 'B', 'B'],
    '5-4': ['A'] + ['B'] * 4, '6-4': ['A'] + ['B'] * 5, '7-4': ['A'] + ['B'] * 6,
    '6-8': ['A', 'B'], '6-8-6': ['A', 's', 's', 'B', 's', 's'], '9-8': ['A', 'B', 'B'], '12-8': ['A', 'B', 'B', 'B'],
}


# The note value of one beat: quarter, dotted quarter (6/8 in 2, 9/8, 12/8) or eighth (6/8 in 6).
UNIT = {'6-8': 'dq', '9-8': 'dq', '12-8': 'dq', '6-8-6': 'e'}


def pattern(bpm, time, sub, count, accent=True):
    beat = Fraction(60) / Fraction(bpm)
    # Sixteenth notes in compound time: 6 per dotted quarter, 2 per eighth.
    sixteenths = (UNIT.get(time) == 'dq' and sub == 6) or (UNIT.get(time) == 'e' and sub == 2)
    out = []
    for i in range(count):
        b, k = divmod(i, sub)
        if k:
            # The odd sixteenths fall between two eighth notes.
            lv = 'f' if sixteenths and k % 2 == 1 else 's'
        else:
            lv = METRES[time][b % len(METRES[time])]
            if lv == 'A' and not accent:
                lv = 'B'
        out.append([float(b * beat + k * beat / sub), lv])
    return out


SCENARIOS = {
    'default': dict(bpm=120, time='4-4', sub=1, count=9),
    'sixeight2': dict(bpm=100, time='6-8', sub=3, count=13),
    'sixeight6': dict(bpm=300, time='6-8-6', sub=1, count=13),
    'sixeight6sub': dict(bpm=300, time='6-8-6', sub=2, count=13),
    'sixeight2six': dict(bpm=120, time='6-8', sub=6, count=13),
    'triplets': dict(bpm=150, time='4-4', sub=3, count=13),
    'twelve16': dict(bpm=50, time='12-8', sub=6, count=25),
    'seven': dict(bpm=300, time='7-4', sub=1, count=15),
    'one': dict(bpm=240, time='1-4', sub=1, count=5),
    'noaccent': dict(bpm=240, time='3-4', sub=2, count=13, accent=False),
    'decimal': dict(bpm=92.5, time='4-4', sub=1, count=5),
}

RANGES = [(0, 'Larghissimo'), (24, 'Grave'), (40, 'Largo'), (60, 'Larghetto'), (66, 'Adagio'), (76, 'Andante'),
          (108, 'Moderato'), (120, 'Allegro'), (168, 'Presto'), (200, 'Prestissimo')]


def marking(bpm):
    name = None
    for lo, n in RANGES:
        if bpm >= lo:
            name = n
    return name


MARK_BPMS = [20, 23.9, 24, 39.9, 40, 59.9, 60, 65.9, 66, 75.9, 76, 107.9, 108, 119.9, 120, 167.9, 168, 199.9, 200, 300]

TAPS = {
    'even500': [0, 500, 1000, 1500],
    'even400': [0, 400, 800, 1200, 1600, 2000],
    # Uneven taps: the fitted line gives 123, the first and last tap alone 125,
    # the last interval alone 158.
    'uneven': [0, 480, 1010, 1490, 2020, 2400],
    'two': [0, 640],
    'fast': [0, 150, 300],
}
# Taps that suddenly come twice as fast start a new series from the tap
# before the change (a gap under half the average so far).
RESTART = [0, 500, 1000, 1500, 1740, 1990, 2240, 2490]
RESTART_SERIES = [1500, 1740, 1990, 2240, 2490]


def tap_bpm(times):
    slope = np.polyfit(np.arange(len(times)), np.array(times, dtype=float), 1)[0]
    return int(round(60000 / slope))


print(json.dumps({
    'scenarios': {k: dict(v, clicks=pattern(**v)) for k, v in SCENARIOS.items()},
    'markings': [[b, marking(b)] for b in MARK_BPMS],
    'taps': dict({k: [v, tap_bpm(v)] for k, v in TAPS.items()}, restart=[RESTART, tap_bpm(RESTART_SERIES)]),
    # Volume slider v (percent) gives a gain of (v / 100) squared; the accented click peaks at 0.9.
    'volume': {str(v): round(0.9 * (v / 100) ** 2, 4) for v in (0, 50, 70, 100)},
}, indent=1))
