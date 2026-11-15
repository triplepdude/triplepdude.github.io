#!/usr/bin/env python3
"""Expected values for tests/tools/date-calculator.test.js.

Worked out with Python's datetime, dateutil (relativedelta, easter) and
numpy's business-day functions, never read back from the page. Dates are
written as an en-US browser shows them ("Friday, January 1, 2027"), which is
what the test browser uses. "Today" in the test is 2026-11-14.

    python3 expected.py > expected.json
"""
import datetime as dt
import json

import numpy as np
from dateutil.easter import easter
from dateutil.relativedelta import relativedelta

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
          'August', 'September', 'October', 'November', 'December']
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
TODAY = dt.date(2026, 11, 14)
DAY = dt.timedelta(days=1)


def unit(n, word):
    return f'{n:,} {word}' + ('' if n == 1 else 's')


def us(d):
    return f'{DAYS[d.weekday()]}, {MONTHS[d.month - 1]} {d.day}, {d.year}'


def ymd(r):
    out = []
    if r.years:
        out.append(unit(r.years, 'year'))
    if r.years or r.months:
        out.append(unit(r.months, 'month'))
    out.append(unit(r.days, 'day'))
    return ', '.join(out)


def weeks_days(n):
    if n < 7:
        return unit(n, 'day')
    return unit(n // 7, 'week') + (', ' + unit(n % 7, 'day') if n % 7 else '')


def mask(off):
    """numpy week mask, Monday first; off lists the ISO numbers of the days off."""
    return ''.join('0' if i + 1 in off else '1' for i in range(7))


def between(frm, to, incl=False, off=(6, 7), holidays=()):
    a, b = dt.date.fromisoformat(frm), dt.date.fromisoformat(to)
    lo, hi = min(a, b), max(a, b)
    end = hi + DAY if incl else hi  # the first day that is not counted
    days = (end - lo).days
    work = int(np.busday_count(lo.isoformat(), end.isoformat(), weekmask=mask(off), holidays=list(holidays)))
    weekly = sum(1 for i in range(days % 7) if (lo + (days // 7 * 7 + i) * DAY).isoweekday() in off) + days // 7 * len(off)
    return {
        'from': frm, 'to': to, 'incl': incl, 'off': list(off), 'holidays': list(holidays),
        'big': unit(days, 'day'),
        'ymd': ymd(relativedelta(end, lo)), 'weeks': weeks_days(days),
        'work': f'{work:,}', 'offDays': f'{days - work:,}',
        'offLabel': f'Days off: {weekly:,} weekly, {unit(days - work - weekly, "holiday")}',
        'hours': f'{days * 24:,}', 'minutes': f'{days * 1440:,}', 'seconds': f'{days * 86400:,}',
        'lo': us(lo), 'hi': us(hi),
    }


def step(d, n, off, holidays):
    """n working days after d (before it when n is negative); d itself never counts."""
    holidays = {dt.date.fromisoformat(h) for h in holidays}
    direction = 1 if n > 0 else -1
    left = abs(n)
    while left:
        d += direction * DAY
        if d.isoweekday() not in off and d not in holidays:
            left -= 1
    return d


def add(start, op='add', y=0, m=0, w=0, d=0, biz=False, off=(6, 7), holidays=()):
    s = dt.date.fromisoformat(start)
    sign = -1 if op == 'sub' else 1
    r = s + relativedelta(years=sign * y, months=sign * m)
    r += dt.timedelta(weeks=sign * w)
    if biz:
        stepped = step(r, sign * d, off, holidays)
        if d and r.isoweekday() not in off and r.isoformat() not in holidays:
            # numpy agrees when the count starts on a working day
            assert np.busday_offset(r.isoformat(), sign * d, weekmask=mask(off), holidays=list(holidays)).astype(dt.date) == stepped
        r = stepped
    else:
        r += dt.timedelta(days=sign * d)
    diff, away = (r - s).days, (r - TODAY).days
    iso_year, iso_week, _ = r.isocalendar()
    return {
        'start': start, 'op': op, 'y': y, 'm': m, 'w': w, 'd': d, 'biz': biz, 'off': list(off), 'holidays': list(holidays),
        'big': us(r), 'iso': r.isoformat(),
        'days': 'The same day' if not diff else unit(abs(diff), 'day') + (' later' if diff > 0 else ' earlier'),
        'daysLabel': 'From the start date' + (': ' + weeks_days(abs(diff)) if abs(diff) >= 7 else ''),
        'today': 'Today' if not away else ('In ' + unit(away, 'day') if away > 0 else unit(-away, 'day') + ' ago'),
        'week': f'Week {iso_week} of {iso_year}',
    }


print(json.dumps({
    'today': TODAY.isoformat(),
    'between': [
        between('2026-11-14', '2027-01-01'),                 # the example the page opens with
        between('2026-11-14', '2026-12-25'),
        between('2026-11-14', '2026-12-25', incl=True),
        between('2026-11-16', '2026-11-20'),                 # Monday to Friday: 4 days, or 5 with the end date
        between('2026-11-16', '2026-11-20', incl=True),
        between('2024-01-31', '2024-02-29'),                 # month ends: one month exactly
        between('2024-01-31', '2024-03-01'),
        between('2023-01-31', '2023-02-28'),
        between('2024-02-29', '2025-02-28'),
        between('2026-01-01', '2026-12-31', incl=True),      # a whole year: 365 days, 261 weekdays
        between('2028-01-01', '2028-12-31', incl=True),      # a leap year that starts on a Saturday: 260 weekdays
        between('2001-09-11', '2026-11-14'),
        between('2026-12-25', '2026-11-14'),                 # end before start
        between('1900-02-28', '1900-03-01'),                 # 1900 was not a leap year
        between('2000-02-28', '2000-03-01'),                 # 2000 was
        between('0001-01-01', '9999-12-31'),                 # the whole supported range
        between('2026-11-14', '2026-11-14'),
        between('2026-11-14', '2026-11-14', incl=True),
        # Microsoft's NETWORKDAYS example: 110 working days, 109 and 107 with holidays.
        between('2012-10-01', '2013-03-01', incl=True),
        between('2012-10-01', '2013-03-01', incl=True, holidays=['2012-11-22']),
        between('2012-10-01', '2013-03-01', incl=True, holidays=['2012-11-22', '2012-12-04', '2013-01-21']),
        between('2026-11-01', '2026-12-01', off=(5, 6)),     # a Friday and Saturday weekend
        between('2026-11-01', '2026-12-01', off=(7,), holidays=['2026-11-26', '2026-11-29']),  # the second is a Sunday anyway
    ],
    'add': [
        add('2026-11-14', d=90),                             # the example the page opens with
        add('2026-11-14', d=45),                             # the guide's example
        add('2026-11-14', m=3),
        add('2024-01-31', m=1),                              # 29 February 2024
        add('2023-01-31', m=1),
        add('2024-02-29', y=1),
        add('1900-01-31', m=1),                              # 1900 and 2100 are not leap years, 2000 is
        add('2100-01-31', m=1),
        add('2000-01-31', m=1),
        add('2096-02-29', y=4),
        add('2024-03-31', op='sub', m=1),
        add('2026-11-14', op='sub', y=1, m=2, w=3, d=4),
        add('2026-11-14', y=1, m=2, w=3, d=4),
        add('2026-12-31', d=1),
        add('2026-11-14', w=12, d=6),
        add('2026-11-14', d=0),
        add('2026-11-14', d=3),
        add('2000-01-01', d=10000),
        add('9999-12-01', d=30),
        add('0001-01-31', op='sub', d=30),
        add('2026-11-13', d=10, biz=True),                   # from a Friday
        add('2026-11-14', d=1, biz=True),                    # from a Saturday: the Monday
        add('2026-11-14', op='sub', d=1, biz=True),          # ... or the Friday before
        add('2026-11-14', d=5, biz=True, holidays=['2026-11-26', '2026-11-16']),
        add('2026-11-14', m=1, d=5, biz=True, off=(5, 6)),
        # Microsoft's WORKDAY example: 151 working days from 2008-10-01.
        add('2008-10-01', d=151, biz=True),
        add('2008-10-01', d=151, biz=True, holidays=['2008-11-26', '2008-12-04', '2009-01-21']),
    ],
    'easter': {str(y): easter(y).isoformat() for y in (2027, 2028, 2038, 2285, 2011, 2012, 1961)},
}, indent=1))
