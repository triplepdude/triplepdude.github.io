#!/usr/bin/env python3
"""Expected results for tests/tools/gpa-calculator.test.js, worked out with
exact fractions (fractions.Fraction), independently of the page's code.

  python3 expected.py > expected.json

GPA = sum(points x credits) / sum(credits); weighted points add the honors or
AP/IB bonus to every grade except F. Earlier semesters add GPA x credits.
An earlier weighted GPA, when given, replaces the earlier GPA in the
weighted figure only. GPAs are rounded half up to 2 decimals; the working
line cuts them to 4 decimals and adds an ellipsis when digits were cut, so a
value just under a half never shows as one. The planner's needed average is
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

def cut4(x):
    v = math.floor(x * 10**4)
    s = f'{v // 10**4}.{v % 10**4:04d}'
    return s.rstrip('0').rstrip('.') if F(v, 10**4) == x else s + '\u2026'

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
        gw = F(sc['prev'][2]) if len(sc['prev']) > 2 else g
        C += cr; P += g * cr; W += gw * cr
    out['weighted'] = weighted
    out['credits'] = str(C) if C.denominator == 1 else str(float(C))
    out['gpa'] = half_up(P / C) if C else None
    out['wgpa'] = half_up(W / C) if C else None
    out['work'] = cut4(P / C) if C else None
    out['wwork'] = cut4(W / C) if C else None
    if 'target' in sc:
        t, R = F(sc['target']), F(sc['left'])
        use_w = weighted and sc.get('basis') == 'w'
        base = W if use_w else P
        top = pts['A+'] + (max(hon, ap) if use_w else 0)
        # What the best grade is called: A+ where it is worth more than an A,
        # in the class type with the bigger bonus when planning the weighted GPA.
        word = 'straight A+ grades' if pts['A+'] > pts['A'] else 'straight A\u2019s'
        if use_w:
            word += ' in Honors classes' if hon > ap else ' in AP / IB classes'
        need = (t * (C + R) - base) / R
        if need <= 0:
            out['plan'] = {'state': 'safe', 'floor': half_up(base / (C + R))}
        elif need > top:
            best = (base + top * R) / (C + R)
            # Rounded, the best result could look like the target it misses.
            plan = {'state': 'out', 'need': ceil2(need), 'best': half_up(best) if F(half_up(best)) < t else cut4(best), 'word': word}
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
    # (3.7 x 23 - 49.7) / 9 = 3.9333..., rounded UP to 3.94 so it is always enough.
    'round_up': {'sems': [EX], 'target': '3.7', 'left': '9'},
    'cumulative_guide': {'sems': [], 'prev': ['3.2', '60'], 'extra': [['New', 'A', '15', 'r']]},
    # A weighted GPA so far of 3.6 counts in the weighted figure only.
    'two_sems_prev_pw': {'sems': [EX, SEM2], 'prev': ['3.2', '60', '3.6'], 'target': '3.5', 'left': '30', 'basis': 'w'},
    # 3.42499 is shown as 3.42, so the working must not say 3.4250.
    'near_half': {'sems': [], 'prev': ['3.42499', '100']},
    # The best result, 3.49990..., misses 3.5 but rounds to 3.50.
    'best_near_target': {'sems': [], 'prev': ['3.494899', '100'], 'target': '3.5', 'left': '1'},
    # On the 4.3 scale the best weighted grade is an A+ in an AP / IB class (5.3).
    's43_w_out': {'scale': 's43', 'sems': [EX], 'target': '5.2', 'left': '15', 'basis': 'w'},
    # With a bigger Honors bonus, the best weighted grade is an A in an Honors class.
    'hon_big_w_out': {'hon': '1.5', 'sems': [EX], 'target': '5.4', 'left': '15', 'basis': 'w'},
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
