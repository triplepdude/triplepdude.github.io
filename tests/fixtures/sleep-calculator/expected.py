#!/usr/bin/env python3
"""Expected times for tests/tools/sleep-calculator.test.js.

    python3 tests/fixtures/sleep-calculator/expected.py > tests/fixtures/sleep-calculator/expected.json

Worked out with Python's datetime and zoneinfo (the IANA time zone database), in
real elapsed time, from the rules the page states: the bedtime is the wake-up
time minus whole cycles minus the minutes to fall asleep; computed times are
rounded to the nearest 5 minutes; "next day" marks a time on a later date than
the bedtime of its row. Which night is meant: a wake-up time is the next one
from which the latest bedtime on offer is still ahead; a bedtime is the next
one from 6 hours ago. Hours per age group are the CDC's (15 May 2024).
Nothing here is taken from the page.
"""
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

GROUPS = {  # min hours, max hours (0 = no maximum), naps included
    'n0': (14, 17, True), 'm4': (12, 16, True), 'y1': (11, 14, True), 'y3': (10, 13, True),
    'y6': (9, 12, False), 'y13': (8, 10, False), 'a18': (7, 0, False), 'a61': (7, 9, False), 'a65': (7, 8, False),
}
UTC = timezone.utc
M5 = 300


def round5(t):  # t: aware datetime; nearest 5 minutes of real time (no ties: all inputs are whole minutes)
    s = t.timestamp()
    return datetime.fromtimestamp(round(s / M5) * M5, UTC)


def clock_at(tz, day, minutes):
    """The instant the clock reads hh:mm on that day. In a gap the time is read
    with the offset in force before it (so 01:30 on a spring-forward night is
    02:30 by the new clock); a time that comes twice is the first one."""
    naive = datetime(day.year, day.month, day.day) + timedelta(minutes=minutes)
    return naive.replace(tzinfo=tz, fold=0).astimezone(UTC)


def fmt(t, tz, h12):
    loc = t.astimezone(tz)
    h, m = loc.hour, loc.minute
    s = f'{(h % 12) or 12}:{m:02d} {"AM" if h < 12 else "PM"}' if h12 else f'{h:02d}:{m:02d}'
    if h == 0 and m == 0:
        s += ' (midnight)'
    elif h == 12 and m == 0:
        s += ' (noon)'
    return s


def plain(minutes, h12):
    h, m = divmod(minutes, 60)
    return f'{(h % 12) or 12}:{m:02d} {"AM" if h < 12 else "PM"}' if h12 else f'{h:02d}:{m:02d}'


DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']


def day_text(t, tz, mdy):
    d = t.astimezone(tz)
    return f'{DAYS[d.weekday()]}, {MONTHS[d.month - 1]} {d.day}' if mdy else f'{DAYS[d.weekday()]} {d.day} {MONTHS[d.month - 1]}'


def later_day(t, base, tz):
    return ' next day' if t.astimezone(tz).date() > base.astimezone(tz).date() else ''


def case(name, tz_name, now, mode, time=None, fall=15, cycle=90, age='a18', naps=0, h12=True, mdy=True):
    tz = ZoneInfo(tz_name)
    now_utc = datetime.fromisoformat(now).astimezone(UTC)
    now_min = now_utc.replace(second=0, microsecond=0)
    lo_h, hi_h, nap_group = GROUPS[age]
    cycles = not nap_group
    nap = naps if nap_group else 0
    lo, hi = lo_h * 60 - nap, (hi_h * 60 - nap if hi_h else 0)
    lat, cyc = timedelta(minutes=fall), timedelta(minutes=cycle)
    today = now_utc.astimezone(tz).date()
    if mode == 'wake':
        latest = 3 * cyc + lat if cycles else (timedelta(0) if age == 'n0' else timedelta(minutes=lo) + lat)
        for k in range(4):
            anchor = clock_at(tz, today + timedelta(days=k), time)
            if anchor > now_utc and round5(anchor - latest) >= now_min:
                break
    elif mode == 'bed':
        for k in range(-1, 3):
            anchor = clock_at(tz, today + timedelta(days=k), time)
            if anchor >= now_utc - timedelta(hours=6):
                break
    else:
        anchor = now_min
    out = {'name': name, 'tz': tz_name, 'now': now_utc.isoformat().replace('+00:00', 'Z'), 'mode': mode, 'fall': fall, 'cycle': cycle,
           'age': age, 'naps': naps, 'h12': h12, 'anchor': fmt(anchor, tz, h12), 'anchorDay': day_text(anchor, tz, mdy), 'rows': []}
    if time is not None:
        out['time'] = time
        loc = anchor.astimezone(tz)
        out['gap'] = loc.hour * 60 + loc.minute != time
    rows = []
    if mode == 'wake':
        if cycles:
            for n in range(6, 2, -1):
                asleep = anchor - n * cyc
                rows.append((n, round5(asleep - lat), round5(asleep), anchor))
        win = None
        if age != 'n0':
            win = {'a2': round5(anchor - timedelta(minutes=lo)), 'b2': round5(anchor - timedelta(minutes=lo) - lat)}
            if hi:
                win['a1'] = round5(anchor - timedelta(minutes=hi))
                win['b1'] = round5(anchor - timedelta(minutes=hi) - lat)
    else:
        start = anchor + lat
        out['asleep'] = fmt(round5(start), tz, h12) + later_day(round5(start), anchor, tz)
        if cycles:
            for n in range(6, 2, -1):
                rows.append((n, anchor, round5(start), round5(start + n * cyc)))
        win = None
        if age != 'n0':
            win = {'w1': round5(start + timedelta(minutes=lo))}
            if hi:
                win['w2'] = round5(start + timedelta(minutes=hi))
    for n, bed, asleep, wake in rows:
        key = bed if mode == 'wake' else wake
        tags = []
        if later_day(key, bed, tz):
            tags.append('next day')
        passed = mode == 'wake' and bed < now_min
        if passed:
            tags.append('passed')
        out['rows'].append({'n': n, 'sleep': n * cycle, 'key': fmt(key, tz, h12), 'tag': ', '.join(tags),
                            'bed': fmt(bed, tz, h12), 'asleep': fmt(asleep, tz, h12) + later_day(asleep, bed, tz),
                            'wake': fmt(wake, tz, h12) + later_day(wake, bed, tz), 'short': n * cycle < lo, 'passed': passed})
    if win:
        out['window'] = {k: fmt(v, tz, h12) + (later_day(v, anchor, tz) if mode != 'wake' else '') for k, v in win.items()}
    # A change of UTC offset between the first and last time shown.
    times = [r[1] for r in rows] + [anchor] + ([win.get('b1') or win['b2']] if win and mode == 'wake' else [])
    ends = [r[3] for r in rows] + [anchor] + ([win.get('w2') or win['w1']] if win and mode != 'wake' else [])
    first, last = min(times), max(ends)
    o1, o2 = first.astimezone(tz).utcoffset(), last.astimezone(tz).utcoffset()
    if o1 != o2:
        t = first
        while t.astimezone(tz).utcoffset() == o1:
            t += timedelta(minutes=1)
        before = (t - timedelta(minutes=1)).astimezone(tz)
        bmin = (before.hour * 60 + before.minute + 1) % 1440
        out['dst'] = {'shift': int((o2 - o1).total_seconds() // 60), 'before': plain(bmin, h12), 'day': day_text(t, tz, mdy)}
    return out


cases = [
    case('evening, New York', 'America/New_York', '2026-11-22T20:00:00-05:00', 'wake', 390),
    case('late night: two bedtimes have passed', 'America/New_York', '2026-11-22T23:20:00-05:00', 'wake', 390),
    case('early morning: tonight, not in an hour', 'America/New_York', '2026-11-23T06:00:00-05:00', 'wake', 390),
    case('clocks go back, London', 'Europe/London', '2026-10-24T19:00:00+01:00', 'wake', 390),
    case('clocks go forward, London', 'Europe/London', '2026-03-28T19:00:00+00:00', 'wake', 420),
    case('wake-up time in the spring gap', 'Europe/London', '2026-03-28T19:00:00+00:00', 'wake', 90),
    case('clocks go back, New York, bedtime', 'America/New_York', '2026-10-31T21:00:00-04:00', 'bed', 1380),
    case('teenager, odd settings', 'America/Chicago', '2026-11-23T15:00:00-06:00', 'bed', 1340, fall=20, cycle=95, age='y13'),
    case('now, Kathmandu (UTC+5:45)', 'Asia/Kathmandu', '2026-11-22T22:47:30+05:45', 'now', fall=17, age='a65'),
    case('half-hour clock change, Lord Howe Island', 'Australia/Lord_Howe', '2026-10-03T20:00:00+10:30', 'wake', 390),
    case('3 to 5 years with naps', 'America/Los_Angeles', '2026-11-22T12:00:00-08:00', 'wake', 420, age='y3', naps=60),
    case('6 to 12 years', 'America/Los_Angeles', '2026-11-22T12:00:00-08:00', 'wake', 405, age='y6'),
    case('newborn', 'America/Los_Angeles', '2026-11-22T12:00:00-08:00', 'bed', 1320, age='n0'),
    case('61 to 64, bedtime after midnight', 'America/Los_Angeles', '2026-11-22T12:00:00-08:00', 'bed', 75, age='a61', fall=0, cycle=70),
    case('bedtime 40 minutes ago is tonight', 'America/New_York', '2026-11-22T23:40:00-05:00', 'bed', 1380),
    case('24-hour clock chosen, London', 'Europe/London', '2026-11-22T12:00:00+00:00', 'bed', 1380, h12=False),
]
print(json.dumps({'cases': cases}, indent=1, ensure_ascii=False))
