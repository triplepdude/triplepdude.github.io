#!/usr/bin/env python3
"""Expected values for tests/tools/age-calculator.test.js.

Worked out with Python's datetime, dateutil.relativedelta and zoneinfo, and
with a day-by-day walk through the calendar, never read back from the page.
Dates are written as an en-US browser shows them ("Friday, January 1, 2027"),
which is what the test browser uses.

    python3 expected.py > expected.json
"""
import calendar
import datetime as dt
import json
from zoneinfo import ZoneInfo

from dateutil.relativedelta import relativedelta

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
          'August', 'September', 'October', 'November', 'December']
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
DAY = dt.timedelta(days=1)


def unit(n, word):
    return f'{n:,} {word}' + ('' if n == 1 else 's')


def us(d, weekday=True):
    text = f'{MONTHS[d.month - 1]} {d.day}, {d.year}'
    return f'{DAYS[d.weekday()]}, {text}' if weekday else text


def ymd(years, months, days):
    out = []
    if years:
        out.append(unit(years, 'year'))
    if years or months:
        out.append(unit(months, 'month'))
    out.append(unit(days, 'day'))
    return ', '.join(out)


def is_birthday(d, born, rule):
    """Is d a birthday of someone born on `born`? rule: 'mar1' or 'feb28'."""
    if (born.month, born.day) != (2, 29) or calendar.isleap(d.year):
        return (d.month, d.day) == (born.month, born.day)
    return (d.month, d.day) == ((3, 1) if rule == 'mar1' else (2, 28))


def is_month_day(d, born, rule):
    """Is d the day a further month of age is complete? The birth's day
    number, or the last day of a month that is too short. With the 1 March
    rule a leap-day birth has no such day in a February without a 29th."""
    last = calendar.monthrange(d.year, d.month)[1]
    if (born.month, born.day) == (2, 29) and rule == 'mar1' and d.month == 2:
        return d.day == 29
    return d.day == min(born.day, last)


def walk(born, on, rule):
    """Years, months and days of age, counted one day at a time."""
    years = months = days = 0
    d = born
    while d < on:
        d += DAY
        if is_birthday(d, born, rule):
            years, months, days = years + 1, 0, 0
        elif is_month_day(d, born, rule):
            months, days = months + 1, 0
        else:
            days += 1
    return years, months, days


def age(born, on, rule):
    leapling = (born.month, born.day) == (2, 29)
    if leapling and rule == 'mar1':
        return walk(born, on, rule)
    r = relativedelta(on, born)
    found = (r.years, r.months, r.days)
    if (on - born).days < 60000:  # the walk agrees with dateutil wherever it is quick to run
        assert walk(born, on, rule) == found, (born, on, walk(born, on, rule), found)
    return found


def next_birthday(born, on, rule):
    d = on + DAY
    while not is_birthday(d, born, rule):
        d += DAY
    return d


def test_age(born, on):
    """Test manuals: subtract column by column, borrow 30 days and 12 months."""
    d, m, y = on.day - born.day, on.month - born.month, on.year - born.year
    if d < 0:
        d, m = d + 30, m - 1
    if m < 0:
        m, y = m + 12, y - 1
    return f'{unit(y, "year")}, {unit(m, "month")}, {unit(d, "day")}'


def case(born, on, rule='mar1'):
    born, on = dt.date(*born), dt.date(*on)
    years, months, days = age(born, on, rule)
    total = (on - born).days
    nxt = next_birthday(born, on, rule)
    r = relativedelta(nxt, on)
    gap = ', '.join(unit(n, w) for n, w in ((r.years, 'year'), (r.months, 'month'), (r.days, 'day')) if n)
    mark = (total // 1000 + 1) * 1000
    out = {
        'dob': [born.day, born.month, born.year], 'on': [on.day, on.month, on.year], 'rule': rule,
        'head': 'Age on ' + us(on),
        'age': ymd(years, months, days),
        'born': 'Born on this day.' if born == on else f'Born on {us(born)}.',
        'months': f'{years * 12 + months:,}', 'monthsRest': f' and {unit(days, "day")}' if days else '',
        'weeks': f'{total // 7:,}', 'weeksRest': f' and {unit(total % 7, "day")}' if total % 7 else '',
        'days': f'{total:,}', 'hours': f'{total * 24:,}', 'minutes': f'{total * 1440:,}', 'seconds': f'{total * 86400:,}',
        'next': f'{us(nxt)}, in {gap}' + (f' ({unit((nxt - on).days, "day")})' if r.years or r.months else '') + f'. Turning {nxt.year - born.year}.',
        'isBirthday': on != born and is_birthday(on, born, rule),
        'weekday': DAYS[born.weekday()],
        'test': test_age(born, on),
        'korean': str(on.year - born.year + 1),
    }
    if born.year + mark // 365 < 9990:
        out['mark'] = f'{mark:,} days old on {us(born + dt.timedelta(days=mark))}, in {unit(mark - total, "day")}.'
    return out


def timed(tz, now, born, clock, on=None, rule='mar1'):
    """Real time elapsed in one time zone from the birth to now (when the age
    is counted to today) or to the same clock time on another date."""
    zone = ZoneInfo(tz)
    now_local = dt.datetime.fromisoformat(now.replace('Z', '+00:00')).astimezone(zone).replace(second=0, microsecond=0)
    born = dt.date(*born)
    tb = dt.time(*clock)
    today = now_local.date()
    on_date = dt.date(*on) if on else today
    tt = now_local.time() if on_date == today else tb
    start = dt.datetime.combine(born, tb, tzinfo=zone)
    end = dt.datetime.combine(on_date, tt, tzinfo=zone)
    seconds = round(end.timestamp() - start.timestamp())
    # The last time the clock showed the time of birth: today if that moment has
    # passed, otherwise yesterday. Comparing clock times alone is not enough when
    # the clocks have just gone back and an hour is running for the second time.
    back = 0
    while True:
        rest = round(end.timestamp() - dt.datetime.combine(on_date - back * DAY, tb, tzinfo=zone).timestamp())
        if rest >= 0:
            break
        back += 1
    years, months, days = age(born, on_date - back * DAY, rule)
    cal = age(born, on_date, rule)
    return {
        'tz': tz, 'now': now, 'dob': [born.day, born.month, born.year], 'time': f'{clock[0]:02d}:{clock[1]:02d}',
        'on': [on_date.day, on_date.month, on_date.year] if on else None,
        'age': ymd(*cal), 'days': f'{(on_date - born).days:,}',
        'hours': f'{seconds // 3600:,}', 'minutes': f'{seconds // 60:,}', 'seconds': f'{seconds:,}',
        'exact': f'Counted from the time of birth: {ymd(years, months, days)}, {unit(rest // 3600, "hour")}, {unit(rest % 3600 // 60, "minute")}.',
    }


NOW = '2026-11-14T10:00:00Z'
print(json.dumps({
    'now': NOW,
    'cases': [
        case((2000, 1, 1), (2026, 11, 14)),       # the example the page opens with
        case((1990, 5, 15), (2026, 11, 14)),      # first row of the guide's table
        case((2024, 1, 31), (2025, 3, 1)),        # second row: a month ends on 28 February
        case((2024, 1, 31), (2025, 2, 28)),
        case((2024, 1, 31), (2024, 2, 29)),       # ... or on 29 February in a leap year
        case((1990, 8, 31), (2026, 9, 30)),
        case((1990, 8, 31), (2026, 9, 29)),
        case((2026, 11, 14), (2026, 11, 14)),     # born today
        case((2026, 11, 13), (2026, 11, 14)),
        case((1999, 12, 31), (2026, 11, 14)),
        case((1976, 11, 14), (2026, 11, 14)),     # a birthday
        case((2003, 9, 20), (2013, 9, 18)),       # the test-scoring example in the guide
        case((2015, 12, 25), (2026, 11, 14)),
        case((1899, 12, 31), (1900, 3, 1)),       # 1900 was not a leap year
        case((1752, 9, 14), (1800, 1, 1)),
        case((1, 12, 31), (9999, 12, 30)),        # nearly the whole supported range
        case((987, 6, 5), (1066, 10, 14)),
        # Leap-day births under both rules, around the days that differ.
        case((2000, 2, 29), (2025, 2, 28), 'mar1'),
        case((2000, 2, 29), (2025, 3, 1), 'mar1'),   # third row of the guide's table
        case((2000, 2, 29), (2025, 3, 28), 'mar1'),
        case((2000, 2, 29), (2025, 3, 29), 'mar1'),
        case((2000, 2, 29), (2024, 2, 29), 'mar1'),
        case((2000, 2, 29), (2026, 11, 14), 'mar1'),
        case((2000, 2, 29), (2025, 2, 28), 'feb28'),
        case((2000, 2, 29), (2025, 3, 1), 'feb28'),
        case((2000, 2, 29), (2025, 2, 27), 'feb28'),
        case((2000, 2, 29), (2026, 11, 14), 'feb28'),
        case((1896, 2, 29), (1900, 3, 1), 'mar1'),   # no 29 February for eight years
        case((1896, 2, 29), (1904, 2, 29), 'feb28'),
    ],
    'timed': [
        timed('America/New_York', NOW, (1990, 5, 15), (8, 30)),
        timed('America/New_York', NOW, (1990, 5, 15), (8, 30), on=(2030, 1, 1)),
        timed('America/New_York', NOW, (2020, 3, 8), (2, 30)),     # a clock time skipped by daylight saving
        timed('Europe/London', NOW, (1970, 6, 1), (12, 0)),        # British Standard Time, UTC+1 all year
        timed('Australia/Sydney', NOW, (2000, 7, 1), (23, 30)),
        timed('Asia/Kolkata', NOW, (1985, 1, 1), (0, 15)),
        timed('Asia/Kathmandu', NOW, (2026, 11, 13), (20, 0)),
        timed('Europe/Paris', NOW, (2000, 2, 29), (18, 0), on=(2025, 3, 1)),
        timed('Europe/Paris', '2025-03-01T09:00:00Z', (2000, 2, 29), (18, 0)),
        # 3:10 AM on the day the clocks skip from 2:00 to 3:00: today has no 2:30,
        # so the last full day ended at 2:30 yesterday, 23 hours and 40 minutes ago.
        timed('America/New_York', '2026-03-08T07:10:00Z', (2000, 1, 15), (2, 30)),
        # 1:30 AM for the second time in the night the clocks go back: 1:45 has
        # already been once today, 45 minutes ago.
        timed('America/New_York', '2026-11-01T06:30:00Z', (2000, 1, 15), (1, 45)),
    ],
}, indent=1))
