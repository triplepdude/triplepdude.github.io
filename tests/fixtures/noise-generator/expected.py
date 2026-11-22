#!/usr/bin/env python3
"""Expected values for tests/tools/noise-generator.test.js.

Run: python3 tests/fixtures/noise-generator/expected.py > tests/fixtures/noise-generator/expected.json

Worked out with numpy and scipy from the definitions, never from the page:
- ITU-R BS.1770 K-weighting at each sample rate, from the analogue parameters
  of its two filters (checked against the standard's 48 kHz coefficients).
- The noise colours as the page documents them: white (uniform, variance 1/3),
  pink (Paul Kellet's filter), brown (leaky integrator at 20 Hz plus a 15 Hz
  high-pass), green (pink through a 500 Hz band-pass, Q 0.7071), blue and
  violet (first differences of pink and white), and grey as the inverse of the
  ISO 226:2003 40-phon contour with its bass boost capped at +20 dB (the
  target its octave bands are checked against; its level comes from the four
  filters the page documents, asserted here to stay within 2 dB of it).
- The level rule: every colour and tone setting at the same K-weighted
  loudness, the colour with the least loudness for its power at an RMS of
  -18 dBFS, and nothing above that RMS.
- Sleep-timer clock times across the 2026 UK clock changes (zoneinfo).
"""
import json, math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import numpy as np
from scipy import signal

RMAX_DB = -18.0
SIG2 = 1 / 3

# ---- ISO 226:2003 equal-loudness contours (table and formula of the standard) ----
F_ISO = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500]
AF = [0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330, 0.315, 0.301, 0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242, 0.242, 0.245, 0.254, 0.271, 0.301]
LU = [-31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5, -3.1, -2.0, -1.1, -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1]
TF = [78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6, 6.2, 4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3]

def iso_spl(phon, i):
    af = 4.47e-3 * (10 ** (0.025 * phon) - 1.15) + (0.4 * 10 ** ((TF[i] + LU[i]) / 10 - 9)) ** AF[i]
    return 10 / AF[i] * math.log10(af) - LU[i] + 94

CONTOUR = np.array([iso_spl(40, i) for i in range(len(F_ISO))])
CONTOUR -= CONTOUR[F_ISO.index(1000)]

def grey_target_db(f):
    """Inverse 40-phon contour re 1 kHz, capped at +20 dB, held flat outside 20 Hz to 12.5 kHz."""
    lf = np.log(np.clip(f, 20, 12500))
    return np.minimum(np.interp(lf, np.log(F_ISO), CONTOUR), 20.0)

# ---- Filters ----
def cookbook(kind, f0, fs, db=0.0, q=1 / math.sqrt(2)):
    A = 10 ** (db / 40); w = 2 * math.pi * f0 / fs; c = math.cos(w); al = math.sin(w) / (2 * q); sa = 2 * math.sqrt(A) * al
    if kind == 'lowshelf':
        b = [A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa)]
        a = [(A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa]
    elif kind == 'highshelf':
        b = [A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa)]
        a = [(A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa]
    elif kind == 'peaking':
        b = [1 + al * A, -2 * c, 1 - al * A]; a = [1 + al / A, -2 * c, 1 - al / A]
    elif kind == 'bandpass':
        b = [al, 0, -al]; a = [1 + al, -2 * c, 1 - al]
    return np.array(b) / a[0], np.array(a) / a[0]

def kweight(fs):
    """BS.1770 K-weighting: [(b, a) stage 1 high shelf, (b, a) stage 2 high-pass]."""
    K = math.tan(math.pi * 1681.974450955533 / fs); Q = 0.7071752369554196
    Vh = 10 ** (3.999843853973347 / 20); Vb = Vh ** 0.4996667741545416; a0 = 1 + K / Q + K * K
    s1 = (np.array([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]), np.array([1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]))
    K = math.tan(math.pi * 38.13547087602444 / fs); Q = 0.5003270373238773; a0 = 1 + K / Q + K * K
    s2 = (np.array([1.0, -2.0, 1.0]), np.array([1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]))
    return [s1, s2]

# The standard's own coefficients at 48 kHz (ITU-R BS.1770-4, tables 1 and 2).
k48 = kweight(48000)
assert np.allclose(k48[0][0], [1.53512485958697, -2.69169618940638, 1.19839281085285], atol=1e-8)
assert np.allclose(k48[0][1], [1, -1.69065929318241, 0.73248077421585], atol=1e-8)
assert np.allclose(k48[1][1], [1, -1.99004745483398, 0.99007225036621], atol=1e-8)

KELLET = [(0.99886, 0.0555179), (0.99332, 0.0750759), (0.969, 0.153852), (0.8665, 0.3104856), (0.55, 0.5329522), (-0.7616, -0.016898)]

def pink_filter(x):
    y = 0.5362 * x
    for p, g in KELLET:
        y = y + signal.lfilter([g], [1, -p], x)
    y[1:] += 0.115926 * x[:-1]
    return y

GREY_SECTIONS = [('lowshelf', 273, 20.8, 0.71), ('peaking', 1450, 6.1, 4), ('peaking', 2810, -3.4, 4), ('highshelf', 6120, 11.5, 1.45)]

def colour_filter(name, x, fs):
    if name == 'white': return x
    if name == 'pink': return pink_filter(x)
    if name == 'brown':
        a = 1 - 2 * math.pi * 20 / fs; h = 1 - 2 * math.pi * 15 / fs
        y = signal.lfilter([1 - a], [1, -a], x)
        return signal.lfilter([h, -h], [1, -h], y)
    if name == 'green':
        b, a = cookbook('bandpass', 500, fs, 0, 1 / math.sqrt(2))
        return signal.lfilter(b, a, pink_filter(x))
    if name == 'grey':
        for kind, f0, db, q in GREY_SECTIONS:
            b, a = cookbook(kind, f0, fs, db, q); x = signal.lfilter(b, a, x)
        return x
    if name == 'blue': return signal.lfilter([1, -1], [1], pink_filter(x))
    if name == 'violet': return signal.lfilter([1, -1], [1], x)
    raise ValueError(name)

def tone_filter(t, x, fs):
    if t < 0: b, a = cookbook('highshelf', 800, fs, t)
    elif t > 0: b, a = cookbook('lowshelf', 800, fs, -t)
    else: return x
    return signal.lfilter(b, a, x)

COLOURS = ['white', 'pink', 'brown', 'green', 'grey', 'blue', 'violet']
N = 1 << 17

def impulse(name, t, fs):
    x = np.zeros(N); x[0] = 1
    return tone_filter(t, colour_filter(name, x, fs), fs)

def powers(name, t, fs):
    h = impulse(name, t, fs)
    hk = h
    for b, a in kweight(fs): hk = signal.lfilter(b, a, hk)
    return float(np.sum(h * h)), float(np.sum(hk * hk)), h

def band_psd(h, fs, centres):
    """Average |H|^2 per hertz over each octave band, in dB."""
    nf = 1 << 18
    w, H = signal.freqz(h, 1, worN=nf, fs=fs)
    p = np.abs(H) ** 2
    out = []
    for fc in centres:
        m = (w >= fc / math.sqrt(2)) & (w < fc * math.sqrt(2))
        out.append(10 * math.log10(np.mean(p[m])))
    return out

CENTRES = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
SLOPE_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000]

def slope(levels, centres):
    x = np.log2(np.array(centres, float)); y = np.array(levels)
    return float(np.polyfit(x, y, 1)[0])

def rates(fs):
    rmax = 10 ** (RMAX_DB / 20)
    pw = {c: powers(c, 0, fs) for c in COLOURS}
    lam = rmax ** 2 / SIG2 * min(pw[c][1] / pw[c][0] for c in COLOURS)
    def level(c, t):
        E, K, h = pw[c] if t == 0 else powers(c, t, fs)
        g = min(math.sqrt(lam / K), rmax / math.sqrt(SIG2 * E))
        rms = g * math.sqrt(SIG2 * E)
        lufs = -0.691 + 10 * math.log10(2 * g * g * SIG2 * K)  # two channels, each of this power
        return {'rms_db': round(20 * math.log10(rms), 2), 'lufs': round(lufs, 2), 'capped': bool(rmax / math.sqrt(SIG2 * E) < math.sqrt(lam / K)), 'h': h, 'gain': g}
    # gain: the factor applied to a colour's filter output (fed with uniform
    # white noise in [-1, 1)); the page sends it to its sound engine.
    out = {'colours': {}, 'tones': {}}
    for c in COLOURS:
        lv = level(c, 0)
        bands = band_psd(lv['h'], fs, CENTRES)
        ref = bands[CENTRES.index(1000)]
        rel = [round(b - ref, 2) for b in bands]
        out['colours'][c] = {'rms_db': lv['rms_db'], 'lufs': lv['lufs'], 'bands_rel_1k': rel, 'gain': lv['gain'],
                             'slope_125_8k': round(slope([rel[CENTRES.index(f)] for f in SLOPE_BANDS], SLOPE_BANDS), 2)}
    for c, t in [('white', -12), ('brown', -12), ('pink', 12)]:
        lv = level(c, t)
        bands = band_psd(lv['h'], fs, CENTRES)
        ref = bands[CENTRES.index(1000)]
        out['tones'][f'{c}{t:+d}'] = {'colour': c, 'tone': t, 'rms_db': lv['rms_db'], 'lufs': lv['lufs'], 'capped': lv['capped'], 'gain': lv['gain'],
                                      'bands_rel_1k': [round(b - ref, 2) for b in bands]}
    return out

# Grey: the target from ISO 226 itself, as octave-band averages re the 1 kHz band.
def grey_target_bands():
    f = np.linspace(1, 24000, 480000)
    p = 10 ** (grey_target_db(f) / 10)
    bands = []
    for fc in CENTRES:
        m = (f >= fc / math.sqrt(2)) & (f < fc * math.sqrt(2))
        bands.append(10 * math.log10(np.mean(p[m])))
    ref = bands[CENTRES.index(1000)]
    return [round(b - ref, 2) for b in bands]

# Expected-curve values the page states in its graph's text (re 1 kHz, per hertz).
def point_rel(name, fs, freqs):
    h = impulse(name, 0, fs)
    w, H = signal.freqz(h, 1, worN=np.array([1000.0] + list(freqs)), fs=fs)
    p = 20 * np.log10(np.abs(H))
    return [round(float(v - p[0]), 1) for v in p[1:]]

# ---- Sleep timer: the next time the clock shows hh:mm (UK, 2026 clock changes) ----
LONDON = ZoneInfo('Europe/London')
def next_at(now_utc, hh, mm):
    """First instant after now at which London wall-clock time is hh:mm; where
    the time does not exist (clocks forward), the Date constructor's choice: the
    offset before the change."""
    best = None
    local = now_utc.astimezone(LONDON)
    for day in range(3):
        d = (local.replace(hour=12, minute=0, second=0, microsecond=0) + timedelta(days=day)).date()
        for fold in (0, 1):
            cand = datetime(d.year, d.month, d.day, hh, mm, tzinfo=LONDON, fold=fold)
            u = cand.astimezone(timezone.utc)
            back = u.astimezone(LONDON)
            exists = (back.hour, back.minute) == (hh, mm)
            if not exists and fold == 0:
                # Nonexistent: JavaScript reads it with the offset in force before the change.
                before = (datetime(d.year, d.month, d.day, 0, 0, tzinfo=LONDON)).utcoffset()
                u = datetime(d.year, d.month, d.day, hh, mm, tzinfo=timezone(before)).astimezone(timezone.utc)
            if u > now_utc and (exists or fold == 0):
                if best is None or u < best: best = u
        if best is not None: return best
    return best

CLOCK_CASES = []
for label, now, at in [
    ('spring forward overnight', '2026-03-28T22:10:00+00:00', '06:30'),
    ('autumn back overnight', '2026-10-24T21:10:00+00:00', '06:30'),
    ('repeated hour, first 01:30', '2026-10-24T23:30:00+00:00', '01:30'),
    ('repeated hour, second 01:30', '2026-10-25T00:45:00+00:00', '01:30'),
    ('skipped hour', '2026-03-29T00:30:00+00:00', '01:30'),
    ('later the same day', '2026-06-01T20:05:00+00:00', '23:45'),
]:
    n = datetime.fromisoformat(now)
    hh, mm = map(int, at.split(':'))
    end = next_at(n, hh, mm)
    mins = (end - n).total_seconds() / 60
    el = end.astimezone(LONDON); nl = n.astimezone(LONDON)
    CLOCK_CASES.append({'label': label, 'now_utc': now, 'at': at, 'minutes': mins,
                        'end_local': el.strftime('%H:%M'), 'tomorrow': el.date() != nl.date()})

out = {
    'note': 'Generated by expected.py; see its docstring.',
    'kweight_48k_from_formula': [[list(map(float, s[0])), list(map(float, s[1]))] for s in k48],
    'rates': {},
    'grey_target_bands_rel_1k': grey_target_bands(),
    'centres': CENTRES,
    'slope_bands': SLOPE_BANDS,
    'clock_cases': CLOCK_CASES,
    'keepalive': {'rate': 8000, 'channels': 1, 'bits': 16, 'frames': 64000, 'bytes': 44 + 64000 * 2, 'seconds': 8},
}
for fs in (44100, 48000):
    r = rates(fs)
    r['kweight'] = [[list(map(float, s[0])), list(map(float, s[1]))] for s in kweight(fs)]
    r['points_100_10k'] = {c: point_rel(c, fs, [100, 10000]) for c in COLOURS}
    out['rates'][str(fs)] = r
    # The grey filter must follow the ISO 226 target within 2 dB in every octave band.
    g = r['colours']['grey']['bands_rel_1k']
    assert max(abs(a - b) for a, b in zip(g, out['grey_target_bands_rel_1k'])) < 2.0, (fs, g, out['grey_target_bands_rel_1k'])
print(json.dumps(out, indent=1))
