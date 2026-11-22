"""Builds assets/vendor/geonames-cities/cities.txt from GeoNames dumps.

  python3 -I build_cities.py cities15000.txt admin1CodesASCII.txt countryInfo.txt OUT

Sources (https://download.geonames.org/export/dump/, CC BY 4.0): cities15000
(every place with 15,000 people or more), admin1CodesASCII (state and
province names) and countryInfo (country names). Kept: places of 250,000
people or more, capitals (PPLC), the largest place of each time zone, and
state or province capitals (PPLA) in countries that span more than one zone.
Capitals are marked, so a country name picks its capital's zone. Rows are
sorted by population, largest first, so the file order is the search order
for equally good matches.
"""
import sys
from collections import defaultdict

cities, admin1, countries, out = sys.argv[1:5]
rows = []
for line in open(cities, encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    rows.append(dict(name=p[1], fcode=p[7], cc=p[8], a1=p[10], pop=int(p[14] or 0), tz=p[17], id=int(p[0])))
a1 = {}
for line in open(admin1, encoding='utf-8'):
    k, name, _ascii, _gid = line.rstrip('\n').split('\t')
    a1[k] = name
cn = {}
for line in open(countries, encoding='utf-8'):
    if line.startswith('#'):
        continue
    p = line.rstrip('\n').split('\t')
    cn[p[0]] = p[4]
biggest = {}
for r in rows:
    if r['tz'] and (r['tz'] not in biggest or r['pop'] > biggest[r['tz']]['pop']):
        biggest[r['tz']] = r
zones_of = defaultdict(set)
for r in rows:
    zones_of[r['cc']].add(r['tz'])
multi = {c for c, z in zones_of.items() if len(z) > 1}
keep = {}
for r in rows:
    if not r['tz']:
        continue
    if r['pop'] >= 250000 or r['fcode'] == 'PPLC' or (r['fcode'] == 'PPLA' and r['cc'] in multi):
        keep[r['id']] = r
for r in biggest.values():
    keep[r['id']] = r
sel = sorted(keep.values(), key=lambda r: (-r['pop'], r['name']))
zones = sorted({r['tz'] for r in sel})
zi = {z: i for i, z in enumerate(zones)}
used_a1 = sorted({r['cc'] + '.' + r['a1'] for r in sel if (r['cc'] + '.' + r['a1']) in a1})
used_cc = sorted({r['cc'] for r in sel})
for r in sel:
    assert '|' not in r['name'] and '\n' not in r['name']
lines = ['# Places from GeoNames (https://www.geonames.org/), CC BY 4.0. See README.txt.',
         '@z ' + ' '.join(zones),
         '@c ' + '|'.join('%s %s' % (c, cn.get(c, c)) for c in used_cc),
         '@a ' + '|'.join('%s %s' % (k, a1[k]) for k in used_a1)]
# name|country code|state or province code|zone index, then |c for a capital
lines += ['%s|%s|%s|%s%s' % (r['name'], r['cc'], r['a1'] if (r['cc'] + '.' + r['a1']) in a1 else '', zi[r['tz']],
                             '|c' if r['fcode'] == 'PPLC' else '') for r in sel]
open(out, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
print(len(sel), 'places', len(zones), 'zones', len(used_cc), 'countries')
