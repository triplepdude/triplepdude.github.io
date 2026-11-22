"""Rebuilds the STALE table of _tools/time-zone-converter.html, the check of the
zones whose rules changed in 2026, for a new tz release:

  zic -d NEW africa antarctica asia australasia europe northamerica \
      southamerica etcetera backward            (the new tzdata from IANA)
  node old_offsets.js > old.json                (a runtime with older data)
  python3 -I stale_table.py NEW old.json

Prints, for each zone, the periods [start, end) in minutes since 1970 UTC in
which the older data gives a different offset from the new data, as
[start, end, old offset, new offset], offsets in minutes east of UTC.
"""
import json, sys, zoneinfo
from datetime import datetime, timezone

zoneinfo.reset_tzpath([sys.argv[1]])
old = json.load(open(sys.argv[2]))['tz']
START, END = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()), int(datetime(2041, 1, 1, tzinfo=timezone.utc).timestamp())


def new_changes(name):
    z = zoneinfo.ZoneInfo(name)
    def off(t):
        return int(datetime.fromtimestamp(t, timezone.utc).astimezone(z).utcoffset().total_seconds() // 60)
    out, t, cur = [[START, off(START)]], START, off(START)
    while t < END:
        n = t + 3600
        if off(n) != cur:
            lo, hi = t, n
            while hi - lo > 60:
                mid = (lo + hi) // 120 * 60
                if mid <= lo:
                    break
                lo, hi = (mid, hi) if off(mid) == cur else (lo, mid)
            cur = off(hi)
            out.append([hi, cur])
        t = n
    return out


def at(changes, t):
    v = changes[0][1]
    for s, o in changes:
        if s > t:
            break
        v = o
    return v


for name, oc in old.items():
    nc = new_changes(name)
    points = sorted({s for s, _ in oc} | {s for s, _ in nc} | {END})
    periods = []
    for a, b in zip(points, points[1:]):
        o, n = at(oc, a), at(nc, a)
        if o == n:
            continue
        if periods and periods[-1][1] == a // 60 and periods[-1][2:] == [o, n]:
            periods[-1][1] = b // 60
        else:
            periods.append([a // 60, b // 60, o, n])
    print("    '%s': %s," % (name, json.dumps(periods, separators=(',', ':'))))
