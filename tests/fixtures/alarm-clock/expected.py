#!/usr/bin/env python3
"""Expected answers for tests/tools/alarm-clock.test.js, worked out without the page.

    python3 expected.py > expected.json

times: how a typed time is read, by a separate implementation of the rules the
  guide states (digits of every script through unicodedata, full-width forms,
  am/pm, noon and midnight), with the message the page shows for each problem
  when the alarm is set. A third item, true, marks a problem that is only the
  start of a time still being typed (7: on the way to 7:30): the page shows
  nothing for it while typing. That is found by listing every way of writing
  every time and looking for one that begins with what was typed.
rings: when an alarm rings, from the IANA time zone database (zoneinfo): the
  first instant after `now` at which the local clock shows h:m. A time that is
  skipped when the clocks go forward is placed as ECMAScript places it, with
  the offset from before the jump (02:30 becomes 03:30), and rings unless the
  jump has passed; a time that comes twice when they go back rings at the next
  of the two. `left` is the time to go as the page words it (minutes rounded up).
"""
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

MESSAGES = {
    'long': 'That is too long for a time.',
    'empty': 'Type the time for the alarm, such as 7:30.',
    'one': 'Write the minutes with two digits, such as 7:05.',
    'bad': 'Type a time such as 7:30, 7:30 pm or 1930.',
    'minutes': 'Minutes go from 00 to 59.',
    'ampm': 'With am or pm the hour is 1 to 12, such as 7:30 pm.',
    'hours': 'Hours go from 0 to 23, or 1 to 12 with am or pm.',
}
AMPM = ('a', 'am', 'a.m', 'a.m.', 'p', 'pm', 'p.m', 'p.m.')


def plain(raw):
    out = []
    for ch in raw:
        if unicodedata.category(ch) == 'Nd':
            out.append(str(unicodedata.digit(ch)))
        elif 0xFF01 <= ord(ch) <= 0xFF5E:          # full-width ASCII
            out.append(chr(ord(ch) - 0xFEE0))
        else:
            out.append(ch)
    return ' '.join(''.join(out).split()).lower()


def digits(x):
    return re.fullmatch(r'[0-9]+', x) is not None


def split_ampm(s):
    """('7:30', 'pm') for '7:30 pm' or '7:30pm'; (s, None) without one."""
    for suffix in sorted(AMPM, key=len, reverse=True):
        if s.endswith(suffix):
            head = s[:-len(suffix)]
            if head.endswith(' '):
                head = head[:-1]
            if head and head[-1] in '0123456789h':
                return head, suffix
    return s, None


def read(raw):
    if len(raw) > 20:
        return 'long'
    s = plain(raw)
    if not s:
        return 'empty'
    if s in ('noon', 'midday'):
        return [12, 0]
    if s == 'midnight':
        return [0, 0]
    head, ap = split_ampm(s)
    if digits(head) and len(head) <= 4:
        if len(head) <= 2:
            h, m = int(head), 0
        else:
            h, m = int(head[:-2]), int(head[-2:])
    elif head.endswith('h') and digits(head[:-1]) and len(head) <= 3:
        h, m = int(head[:-1]), 0
    else:
        parts = None
        for sep in ':.h':
            if head.count(sep) == 1:
                a, b = head.split(sep)
                if digits(a) and digits(b) and len(a) <= 2:
                    parts = (a, b)
        if not parts:
            return 'bad'
        if len(parts[1]) == 1:
            return 'one'
        if len(parts[1]) != 2:
            return 'bad'
        h, m = int(parts[0]), int(parts[1])
    if m > 59:
        return 'minutes'
    if ap:
        if not 1 <= h <= 12:
            return 'ampm'
        return [h % 12 + (12 if ap.startswith('p') else 0), m]
    if h == 24 and m == 0:
        return [0, 0]
    if h > 23:
        return 'hours'
    return [h, m]


TIMES = [
    '7', '07', '7:30', '07:30', '7.30', '7h30', '7h', '730', '0730', '1930', '2359', '0000', '000',
    '24:00', '2400', '12am', '12 am', '12:30am', '12:30 AM', '12pm', '12:05 p.m.', '7pm', '7 p.m.', '7P',
    '11:59 PM', '1 a', 'noon', 'Midnight', ' 7:30 ', '7:30 PM', '７：３０', '٧:٣٠', '۰۷:۴۵', '७:३०',
    '７：３０　ｐｍ', '19:30 pm', '13 pm', '0 am', '0:30 am', '25:00', '24:30', '7:60',
    '1260', '7:5', '7:5 pm', '7,30', '7:30:00', '5²', '7\t30', '7 30', '-7:00', '+7:00', '7::30', 'abc',
    '1 000', '12345', '7:30 pmx', '７ｈ', '', '1' * 21, '1' * 20,
    '7:', '6:4', '73', '25', '99', '7:6', '7:30 p.', '7 a.', 'noo', 'midn', '7h3', '19:', '١٢:٣', '12:3 ', '12:3 p',
]

# Every way of writing every time, as the guide describes them.
WRITTEN = {'noon', 'midday', 'midnight'}
for h in range(25):
    for m in range(60):
        if h == 24 and m:
            break
        for hh in {str(h), '%02d' % h}:
            WRITTEN.update({hh + sep + '%02d' % m for sep in ':.h'})
            WRITTEN.add(hh + '%02d' % m)
            if m == 0:
                WRITTEN.update({hh, hh + 'h'})
        if 1 <= h <= 12:
            plain_forms = [str(h) + sep + '%02d' % m for sep in ':.h'] + [str(h) + '%02d' % m] + ([str(h), str(h) + 'h'] if m == 0 else [])
            for f in plain_forms:
                for ap in AMPM:
                    WRITTEN.update({f + ap, f + ' ' + ap})
STARTS = {w[:i] for w in WRITTEN for i in range(1, len(w))}

times = []
for t in TIMES:
    r = read(t)
    if isinstance(r, list):
        times.append([t, r])
    else:
        times.append([t, MESSAGES[r]] + ([True] if r != 'empty' and len(t) <= 20 and plain(t) in STARTS else []))


def iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (dt.microsecond // 1000)


def left_text(ms):
    if ms <= 59000:
        return '%d s' % max(1, -(-ms // 1000))
    mins = -(-ms // 60000)
    h, m = divmod(mins, 60)
    return ' '.join(([f'{h} h'] if h else []) + ([f'{m} min'] if m else []))


def next_ring(tz, now, h, m):
    z = ZoneInfo(tz)
    here = now.astimezone(z)
    wall = here.hour * 60 + here.minute
    for k in range(3):
        d = here.date() + timedelta(days=k)
        naive = datetime(d.year, d.month, d.day, h, m)
        first = naive.replace(tzinfo=z, fold=0).astimezone(timezone.utc)
        second = naive.replace(tzinfo=z, fold=1).astimezone(timezone.utc)
        back = first.astimezone(z)
        if (back.hour, back.minute) != (h, m):        # skipped as the clocks go forward
            if (k > 0 or wall < h * 60 + m) and first > now:
                return first, {'gap': True}
            continue
        both = sorted({first, second})
        for i, t in enumerate(both):
            if t > now:
                flags = {'twice': len(both) > 1}
                if len(both) > 1:
                    flags['second'] = i > 0
                return t, flags
    raise ValueError('no ring')


CASES = [
    ('America/New_York', '2026-11-22T22:47:30-05:00', 7, 0),
    ('America/New_York', '2027-03-13T23:00:00-05:00', 2, 30),
    ('America/New_York', '2027-03-14T01:50:00-05:00', 2, 30),
    ('America/New_York', '2027-03-14T03:10:00-04:00', 2, 30),
    ('America/New_York', '2026-10-31T23:00:00-04:00', 1, 30),
    ('America/New_York', '2026-11-01T01:45:00-04:00', 1, 30),
    ('America/New_York', '2026-11-01T01:45:00-05:00', 1, 30),
    ('America/New_York', '2026-11-22T06:59:59.500-05:00', 7, 0),
    ('America/New_York', '2026-11-22T07:00:00-05:00', 7, 0),
    ('Europe/London', '2027-03-28T00:30:00+00:00', 1, 30),
    ('Europe/London', '2026-10-25T00:30:00+01:00', 1, 30),
    ('Europe/London', '2026-10-24T22:00:00+01:00', 7, 0),
    ('Australia/Lord_Howe', '2026-10-03T23:00:00+10:30', 2, 15),
    ('Asia/Kolkata', '2026-11-22T23:59:30+05:30', 0, 0),
]
rings = []
for tz, now_text, h, m in CASES:
    now = datetime.fromisoformat(now_text).astimezone(timezone.utc)
    at, flags = next_ring(tz, now, h, m)
    local = at.astimezone(ZoneInfo(tz))
    ms = round(at.timestamp() * 1000)
    rings.append({
        'tz': tz, 'now': round(now.timestamp() * 1000), 'nowIso': iso(now), 'h': h, 'm': m,
        'at': ms, 'atIso': iso(at), 'local': local.strftime('%H:%M'), 'left': left_text(ms - round(now.timestamp() * 1000)),
        **flags,
    })

json.dump({'times': times, 'rings': rings}, __import__('sys').stdout, ensure_ascii=False, indent=1)
print()
