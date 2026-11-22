#!/usr/bin/env python3
"""Expected results for tests/tools/gpa-calculator.test.js, worked out with
exact fractions (fractions.Fraction), independently of the page's code.

  python3 expected.py > expected.json

GPA = sum(points x credits) / sum(credits); weighted points add the honors or
AP/IB bonus to every grade except F. Earlier semesters add GPA x credits.
GPAs are rounded half up to 2 decimals. The planner's needed average is
(target x (credits so far + credits left) - grade points so far) / credits
left, rounded UP to 2 decimals; "more" is the whole number of credits of the
top grade needed when the target is out of reach.
"""
import json, math
from fractions import Fraction as F

TENTHS = ['4', '4', '3.7', '3.3', '3', '2.7', '2.3', '2', '1.7', '1.3', '1', '0.7', '0']
THIRDS = ['4', '4', '3.67', '3.33', '3', '2.67', '2.33', '2', '1.67', '1.33', '1', '0.67', '0']
GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']
SCALES = {'std': TENTHS, 'thirds': THIRDS, 's43': ['4.3'] + TENTHS[1:], 's433': ['4.33'] + THIRDS[1:]}

def half_up(x, k=2):
    q = F(10) ** k
    v = math.floor(x * q + F(1, 2))
    return f'{v // 10**k}.{v % 10**k:0{k}d}'

def ceil2(x):
    v = math.ceil(x * 100)
    return f'{v // 100}.{v % 100:02d}'

def run(sc):
    pts = {g: F(p) for g, p in zip(GRADES, SCALES[sc.get('scale', 'std')])}
    hon, ap = F(sc.get('hon', '0.5')), F(sc.get('ap', '1'))
    bonus = {'r': F(0), 'h': hon, 'a': ap}
    out = {'sems': []}
    C = P = W = F(0)
    weighted = False
    for sem in sc['sems']:
        c = p = w = F(0)
        for name, grade, credits, level in sem:
            if not grade or not credits:
                continue
            cr = F(credits)
            gp = pts[grade]
            wp = F(0) if grade == 'F' else gp + bonus[level]
            c += cr; p += gp * cr; w += wp * cr
            if level != 'r':
                weighted = True
        out['sems'].append(None if c == 0 else {'gpa': half_up(p / c), 'wgpa': half_up(w / c), 'credits': str(c)})
        C += c; P += p; W += w
    if sc.get('prev'):
        g, cr = F(sc['prev'][0]), F(sc['prev'][1])
        C += cr; P += g * cr; W += g * cr
    out['weighted'] = weighted
    out['credits'] = str(C) if C.denominator == 1 else str(float(C))
    out['gpa'] = half_up(P / C) if C else None
    out['wgpa'] = half_up(W / C) if C else None
    if 'target' in sc:
        t, R = F(sc['target']), F(sc['left'])
        use_w = weighted and sc.get('basis') == 'w'
        base = W if use_w else P
        top = pts['A+'] + (max(hon, ap) if use_w else 0)
        need = (t * (C + R) - base) / R
        if need <= 0:
            out['plan'] = {'state': 'safe', 'floor': half_up(base / (C + R))}
        elif need > top:
            plan = {'state': 'out', 'need': ceil2(need), 'best': half_up((base + top * R) / (C + R))}
            if t < top:
                plan['more'] = math.ceil((t * C - base) / (top - t))
            out['plan'] = plan
        else:
            out['plan'] = {'state': 'need', 'need': ceil2(need)}
    return out

EX = [['Biology', 'A', '4', 'r'], ['English', 'B+', '3', 'h'], ['Calculus', 'A-', '4', 'a'], ['History', 'B', '3', 'r']]
SEM2 = [['Chemistry', 'B-', '4', 'r'], ['Art', 'A', '2', 'r'], ['PE', '', '1', 'r']]
SCENARIOS = {
    'default': {'sems': [EX], 'target': '3.7', 'left': '15'},
    'scale433_aplus': {'scale': 's433', 'sems': [[['Biology', 'A+', '4', 'r']] + EX[1:]]},
    'scale43_aplus': {'scale': 's43', 'sems': [[['Biology', 'A+', '4', 'r']] + EX[1:]]},
    'thirds': {'scale': 'thirds', 'sems': [EX]},
    'honors_bonus_1': {'hon': '1', 'sems': [EX]},
    'f_in_ap': {'sems': [EX[:2] + [['Calculus', 'F', '4', 'a']] + EX[3:]]},
    'two_sems': {'sems': [EX, SEM2], 'target': '3.5', 'left': '30'},
    'two_sems_prev': {'sems': [EX, SEM2], 'prev': ['3.2', '60'], 'target': '3.5', 'left': '30'},
    'two_sems_prev_w': {'sems': [EX, SEM2], 'prev': ['3.2', '60'], 'target': '3.5', 'left': '30', 'basis': 'w'},
    'two_sems_prev_t33': {'sems': [EX, SEM2], 'prev': ['3.2', '60'], 'target': '3.3', 'left': '30'},
    'two_sems_prev_safe': {'sems': [EX, SEM2], 'prev': ['3.2', '60'], 'target': '2', 'left': '30'},
    'exact_letter': {'sems': [EX], 'target': '3.625', 'left': '14'},
    'cumulative_guide': {'sems': [], 'prev': ['3.2', '60'], 'extra': [['New', 'A', '15', 'r']]},
}
# The guide's cumulative example: 3.20 over 60 credits and 3.80 over 15.
guide = F('3.2') * 60 + F('3.8') * 15
res = {k: run(v) for k, v in SCENARIOS.items() if k != 'cumulative_guide'}
res['guide'] = {
    'cumulative': half_up(guide / 75),
    'raise_need': ceil2((F('3.5') * 105 - guide) / 30),
    'one_b': {n: half_up(F(4 * (n - 1) + 3, n)) for n in (4, 5, 6, 7)},
}
print(json.dumps(res, indent=1, sort_keys=True))
