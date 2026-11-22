"""Known answers for tests/tools/time-zone-converter.test.js, worked out with
Python's zoneinfo from tzdata 2026f, never from the page or the browser:

  zic -d ZONEINFO africa antarctica asia australasia europe northamerica \
      southamerica etcetera backward          (tzdata2026f.tar.gz from IANA)
  python3 -I expected.py ZONEINFO > expected.json
"""
import json, sys, zoneinfo
from datetime import datetime, timedelta, timezone

zoneinfo.reset_tzpath([sys.argv[1]])
UTC = timezone.utc
Z = zoneinfo.ZoneInfo


def local(instant, zone):
    t = instant.astimezone(Z(zone))
    return {'time': t.strftime('%H:%M'), 'date': t.strftime('%Y-%m-%d'),
            'offset': int(t.utcoffset().total_seconds() // 60), 'abbr': t.tzname()}


def wall(zone, y, mo, d, h, mi):
    """Both instants of a wall time (two when it repeats, none when it is skipped)."""
    out = []
    for fold in (0, 1):
        t = datetime(y, mo, d, h, mi, tzinfo=Z(zone), fold=fold)
        u = t.astimezone(UTC)
        if u.astimezone(Z(zone)).replace(tzinfo=None) == t.replace(tzinfo=None) and u not in out:
            out.append(u)
    return sorted(out)


def changes(zone, start, days=366):
    """Clock changes after start: (local date and time before, after, offset after)."""
    z, out, t = Z(zone), [], start
    prev = t.astimezone(z).utcoffset()
    while t < start + timedelta(days=days):
        n = t + timedelta(minutes=15)
        if n.astimezone(z).utcoffset() != prev:
            a, b = n - timedelta(minutes=15), n
            before = (b - timedelta(seconds=1)).astimezone(z)
            after = b.astimezone(z)
            out.append({'utc': b.strftime('%Y-%m-%dT%H:%MZ'), 'before': (before + timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M'),
                        'after': after.strftime('%Y-%m-%d %H:%M'), 'offset': int(after.utcoffset().total_seconds() // 60)})
            prev = after.utcoffset()
        t = n
    return out


NOW = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)  # the test's fixed clock
E = {}
E['now'] = {z: local(NOW, z) for z in ['Europe/Rome', 'America/New_York', 'Europe/London', 'Asia/Kolkata']}

# 3 pm EST (New York) on the test's date, to India and the UK.
t = wall('America/New_York', 2026, 11, 24, 15, 0)[0]
E['est_winter'] = {z: local(t, z) for z in ['America/New_York', 'Asia/Kolkata', 'Europe/London', 'Asia/Jerusalem']}
# A summer EST: New York time (EDT) and fixed UTC-5.
t = wall('America/New_York', 2027, 7, 14, 15, 0)[0]
E['est_summer_ny'] = {z: local(t, z) for z in ['America/New_York', 'Asia/Kolkata']}
t = datetime(2027, 7, 14, 15, 0, tzinfo=timezone(timedelta(hours=-5)))
E['est_summer_fixed'] = {z: local(t, z) for z in ['America/New_York', 'Asia/Kolkata']}

# Skipped and repeated wall times in New York.
E['skipped'] = wall('America/New_York', 2027, 3, 14, 2, 30)  # []
t = datetime(2027, 3, 14, 2, 30) + timedelta(hours=5)  # the moment 02:30 EST would have been
t = t.replace(tzinfo=UTC)
E['skipped_shown'] = {z: local(t, z) for z in ['America/New_York', 'Europe/London']}
both = wall('America/New_York', 2027, 11, 7, 1, 30)
E['repeated'] = [{z: local(u, z) for z in ['America/New_York', 'Europe/London']} for u in both]

# The eight zones of the tz 2026 changes, at the test's clock and at two later moments.
E['stale'] = {z: local(NOW, z) for z in ['America/Vancouver', 'America/Edmonton', 'America/Inuvik', 'America/Winnipeg',
                                         'America/Havana', 'Africa/Casablanca', 'Africa/El_Aaiun', 'Europe/Chisinau']}
E['chisinau_spring'] = local(datetime(2027, 3, 28, 0, 30, tzinfo=UTC), 'Europe/Chisinau')
E['havana_2027_12'] = local(datetime(2027, 12, 1, 12, 0, tzinfo=UTC), 'America/Havana')

# Next clock changes after the test's clock.
E['changes'] = {z: changes(z, NOW)[:1] for z in ['America/New_York', 'Europe/London', 'Australia/Sydney', 'America/Havana',
                                                 'America/Vancouver', 'Asia/Kolkata']}

# How the gap between New York and London moves in the 12 months after the test's clock.
def gaps(a, b, start, days=365):
    out, t, prev = [], start, None
    while t < start + timedelta(days=days):
        g = int((t.astimezone(Z(b)).utcoffset() - t.astimezone(Z(a)).utcoffset()).total_seconds() // 60)
        if g != prev:
            out.append([t.strftime('%Y-%m-%dT%H:%MZ'), g])
            prev = g
        t += timedelta(minutes=15)
    return out
E['gap_ny_london'] = gaps('America/New_York', 'Europe/London', NOW)

# A weekly meeting at 10:00 New York time on Tuesdays from 2 March 2027.
weeks = []
for k in range(52):
    d = datetime(2027, 3, 2) + timedelta(days=7 * k)
    u = wall('America/New_York', d.year, d.month, d.day, 10, 0)[0]
    weeks.append({'utc': u.strftime('%Y%m%dT%H%M%SZ'), 'london': local(u, 'Europe/London')['time'], 'delhi': local(u, 'Asia/Kolkata')['time']})
E['weekly'] = weeks
runs = []
for w in weeks:
    key = (w['london'], w['delhi'])
    if runs and runs[-1]['key'] == key:
        runs[-1]['n'] += 1
    else:
        runs.append({'key': key, 'n': 1, 'first': w['utc']})
E['weekly_runs'] = [{'london': r['key'][0], 'delhi': r['key'][1], 'weeks': r['n']} for r in runs]

# When New York, London and New Delhi can all meet on 24 Nov 2026 (New York's day), in steps of 15
# minutes: everyone between 09:00 and 17:00, or else everyone between 07:00 and 22:00.
def overlap(zones, home, y, mo, d, lo, hi):
    start = wall(home, y, mo, d, 0, 0)[0]
    end = wall(home, y, mo, d + 1, 0, 0)[0]
    runs, t = [], start
    while t < end:
        ok = True
        for z in zones:
            l = t.astimezone(Z(z))
            m = l.hour * 60 + l.minute
            ok = ok and m >= lo and m + 15 <= hi
        if ok:
            if runs and runs[-1][1] == t:
                runs[-1][1] = t + timedelta(minutes=15)
            else:
                runs.append([t, t + timedelta(minutes=15)])
        t += timedelta(minutes=15)
    return [[local(a, home)['time'], local(b, home)['time']] for a, b in runs]
zs = ['America/New_York', 'Europe/London', 'Asia/Kolkata']
E['overlap_work'] = overlap(zs, 'America/New_York', 2026, 11, 24, 9 * 60, 17 * 60)
E['overlap_awake'] = overlap(zs, 'America/New_York', 2026, 11, 24, 7 * 60, 22 * 60)

# AoE: 23:59 on 15 May 2027 at UTC-12.
E['aoe'] = datetime(2027, 5, 15, 23, 59, tzinfo=timezone(timedelta(hours=-12))).astimezone(UTC).strftime('%Y-%m-%d %H:%M')

# Typed questions: zones named in words, dates after the places, "in X to Y", GMT in summer.
def at(zone, y, mo, d, h, mi, zones):
    u = wall(zone, y, mo, d, h, mi)[0]
    return {z: local(u, z) for z in zones}
E['ask'] = {
    'pacific_london': at('America/Los_Angeles', 2026, 11, 24, 10, 0, ['America/Los_Angeles', 'Europe/London']),
    'alaska_hawaii': at('America/Anchorage', 2026, 11, 24, 9, 0, ['America/Anchorage', 'Pacific/Honolulu']),
    'est_tomorrow': at('America/New_York', 2026, 11, 25, 15, 0, ['America/New_York', 'Asia/Kolkata']),
    'sydney_april': at('Australia/Sydney', 2027, 4, 1, 10, 0, ['Australia/Sydney', 'Europe/London']),
    'paris_sydney': at('Europe/Paris', 2026, 11, 24, 18, 0, ['Europe/Paris', 'Australia/Sydney']),
    'gmt_summer': {z: local(datetime(2027, 7, 14, 15, 0, tzinfo=UTC), z) for z in ['America/New_York', 'Europe/London']},
}

# A weekly meeting typed as 02:30 New York time from 14 March 2027, a time skipped that day: the
# first is shown at the moment 02:30 would have been (03:30 EDT), the later ones at 02:30.
weeks = []
first = datetime(2027, 3, 14, 7, 30, tzinfo=UTC)  # 02:30 at EST, the offset before the change
weeks.append(first)
for k in range(1, 4):
    d = datetime(2027, 3, 14) + timedelta(days=7 * k)
    weeks.append(wall('America/New_York', d.year, d.month, d.day, 2, 30)[0])
E['skipped_weekly'] = [{'utc': u.strftime('%Y%m%dT%H%M%SZ'), 'ny': local(u, 'America/New_York')['time'], 'london': local(u, 'Europe/London')['time']} for u in weeks]

# Abbreviations before the 2026 changes, and the changed zones after 2040 (past the dated table).
E['abbr_before'] = {i.strftime('%Y-%m-%dT%H:%M'): {z: local(i, z) for z in ['America/Vancouver', 'America/Edmonton', 'America/Inuvik', 'America/Winnipeg']}
                    for i in [datetime(2026, 1, 15, 12, 0, tzinfo=UTC), datetime(2026, 7, 1, 12, 0, tzinfo=UTC)]}
E['after_2040'] = {i.strftime('%Y-%m-%dT%H:%M'): {z: local(i, z) for z in ['America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'Africa/Casablanca', 'Africa/El_Aaiun', 'Europe/Chisinau']}
                   for i in [datetime(2041, 7, 1, 12, 0, tzinfo=UTC), datetime(2045, 1, 15, 12, 0, tzinfo=UTC),
                             datetime(2041, 3, 31, 0, 30, tzinfo=UTC), datetime(2099, 10, 25, 0, 30, tzinfo=UTC)]}

json.dump(E, sys.stdout, indent=1, sort_keys=True, default=str)
print()
