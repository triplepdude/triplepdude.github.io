#!/usr/bin/env python3
"""Expected answers for tests/tools/pomodoro-timer.test.js, worked out without the page.

    python3 expected.py > expected.json

numbers: how the length boxes read what is typed (whole numbers only, digits
  of every script through unicodedata), with the message for each problem.
run: a set of 1-minute focus sessions, 1-minute short breaks and a 2-minute
  long break after every second focus session, everything starting by itself,
  from a fixed start: each session's start and end (each starts at the moment
  the one before ended), the session in progress at the end, and the log the
  page should offer as a CSV file (Python's csv module, UTF-8 with a byte
  order mark, CRLF lines, a ' before a label that starts with = + - or @) and
  as copied text (tab separated), with times in Europe/London.
"""
import csv
import io
import json
import sys
import unicodedata
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def read_whole(raw, top):
    if len(raw) > 20:
        return 'too long for a number.'
    s = ''.join(str(unicodedata.digit(c)) if unicodedata.category(c) == 'Nd' else c for c in raw)
    s = s.strip(' \t\n\r\f\v 　')
    if s == '':
        return 'type a number.'
    if not all('0' <= c <= '9' for c in s):
        body = s.replace('.', '', 1) if s.count('.') == 1 else s.replace(',', '', 1) if s.count(',') == 1 else s.replace('٫', '', 1) if s.count('٫') == 1 else None
        if body is not None and all('0' <= c <= '9' for c in body):
            return 'use a whole number, such as 25.'
        return 'use digits only, such as 25.'
    n = int(s)
    if not 1 <= n <= top:
        return f'use a number from 1 to {top}.'
    return n


NUMBERS = ['25', '025', '240', '241', '0', '1', '1,5', '1.5', '1.', '.5', '1,000', '12٫5', '٢٥',
           '２５', '२५', '5²', ' 25', '25\t', '2 5', '2\t5', '-5', '+5', '1e2', '0x10',
           '0' * 18 + '25', '1' * 21, '　２５　']
numbers = [[x, read_whole(x, 240)] for x in NUMBERS]
every = [[x, read_whole(x, 12)] for x in ['12', '13', '2', '0']]

# ---- An unattended run: focus 1, short 1, long 2 minutes, a long break after every 2. ----
LEN = {'focus': 1, 'short': 1, 'long': 2}
EVERY = 2
NAMES = {'focus': 'Focus', 'short': 'Short break', 'long': 'Long break'}
START = int(datetime(2026, 11, 22, 9, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
UPTO = START + 7 * 60000 + 30000
phase, done, t, sessions = 'focus', 0, START, []
while True:
    end = t + LEN[phase] * 60000
    if end > UPTO:
        break
    n = min(done + 1, EVERY) if phase == 'focus' else None
    sessions.append({'phase': phase, 'n': n, 'start': t, 'end': end})
    if phase == 'focus':
        done = min(done + 1, EVERY)
    elif phase == 'long':
        done = 0
    phase = ('long' if done >= EVERY else 'short') if phase == 'focus' else 'focus'
    t = end
now_running = {'phase': phase, 'done': done, 'start': t, 'end': t + LEN[phase] * 60000}

LABEL = '=1+1, "two"'
zone = ZoneInfo('Europe/London')


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(zone).strftime('%Y-%m-%d %H:%M:%S')


def minutes(ms):
    v = round(ms / 60000, 2)
    return str(int(v)) if v == int(v) else repr(v)


rows = [['Session', 'Type', 'Working on', 'Start', 'End', 'Minutes', 'Result']]
for i, s in enumerate(sessions, start=1):
    kind = f"Focus {s['n']}" if s['phase'] == 'focus' else NAMES[s['phase']]
    label = "'" + LABEL if LABEL[:1] in '=+-@' else LABEL
    rows.append([str(i), kind, label, stamp(s['start']), stamp(s['end']), minutes(s['end'] - s['start']), 'Completed'])
buf = io.StringIO()
csv.writer(buf, lineterminator='\r\n', quoting=csv.QUOTE_MINIMAL).writerows(rows)
copied = '\n'.join('\t'.join(r) for r in rows)

json.dump({'numbers': numbers, 'every': every, 'run': {
    'start': START, 'upto': UPTO, 'label': LABEL, 'sessions': sessions, 'running': now_running,
    'csv': '﻿' + buf.getvalue(), 'copied': copied}}, sys.stdout, ensure_ascii=False, indent=1)
print()
