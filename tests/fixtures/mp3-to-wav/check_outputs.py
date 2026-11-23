#!/usr/bin/env python3
"""Checks the WAV files the page wrote with tools that share no code with it:
ffprobe for the format, ffmpeg with numpy for the sound, mutagen for the tags.

    mkdir /tmp/m2w && M2W_DUMP=/tmp/m2w node tests/run.js mp3-to-wav
    python3 tests/fixtures/mp3-to-wav/check_outputs.py /tmp/m2w

Prints one line per check and exits 1 if any fails.
"""
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
EXP = json.load(open(os.path.join(HERE, 'expected.json'), encoding='utf8'))
failed = 0


def check(ok, what):
    global failed
    print(('ok   ' if ok else 'FAIL ') + what)
    failed += not ok


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', path], check=True, capture_output=True, text=True).stdout
    return json.loads(out)['streams'][0]


def decode(path, ch=None):
    """Float samples as ffmpeg decodes them (an MP3's LAME tag honoured)."""
    s = probe(path)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, '<f4').reshape(-1, s['channels']).astype(np.float64)


def ulaw_codes(path):
    raw = open(path, 'rb').read()
    i = raw.index(b'data')
    n = int.from_bytes(raw[i + 4:i + 8], 'little')
    return np.frombuffer(raw[i + 8:i + 8 + n], np.uint8)


# The format of every WAV, as ffprobe reads it.
KINDS = {'song.wav': ('pcm_s16le', 44100, 2, 132300), 'song-s24.wav': ('pcm_s24le', 44100, 2, 132300), 'song-f32.wav': ('pcm_f32le', 44100, 2, 132300),
         'song-ulaw.wav': ('pcm_mulaw', 44100, 2, 132300), 'song-alaw.wav': ('pcm_alaw', 44100, 2, 132300), 'song-notags.wav': ('pcm_s16le', 44100, 2, 132300),
         'song-phone-ulaw.wav': ('pcm_mulaw', 8000, 1, 24000), 'vbr.wav': ('pcm_s16le', 44100, 2, 132300), 'mpeg2.wav': ('pcm_s16le', 22050, 1, 44100),
         'mpeg25.wav': ('pcm_s16le', 8000, 1, 16000), 'no-tag.wav': ('pcm_s16le', 44100, 2, 133632), 'vbri.wav': ('pcm_s16le', 44100, 2, 133632),
         'cut-off.wav': ('pcm_s16le', 44100, 2, 51887)}
for name, (codec, sr, ch, n) in KINDS.items():
    s = probe(os.path.join(OUT, name))
    got = (s['codec_name'], int(s['sample_rate']), s['channels'], int(s.get('duration_ts') or 0))
    check(got == (codec, sr, ch, n), f'{name}: ffprobe reads {got}, expected {(codec, sr, ch, n)}')

# The sound: what ffmpeg decodes from each MP3, to the sample.
for wav, mp3, tol in [('song.wav', 'song.mp3', 1.5), ('vbr.wav', 'vbr.mp3', 1.5), ('mpeg2.wav', 'mpeg2.mp3', 1.5), ('mpeg25.wav', 'mpeg25.mp3', 1.5),
                      ('no-tag.wav', 'no-tag.mp3', 1.5), ('cut-off.wav', 'cut-off.mp3', 1.5), ('song-s24.wav', 'song.mp3', 1.5), ('song-f32.wav', 'song.mp3', 1.5)]:
    a, b = decode(os.path.join(OUT, wav)), decode(os.path.join(HERE, mp3))
    same = a.shape == b.shape
    diff = float(np.max(np.abs(a - b))) * 32768 if same else float('inf')
    check(same and diff <= tol, f'{wav}: {a.shape[0]} samples, as ffmpeg decodes {mp3} ({b.shape[0]}); largest difference {diff:.3f} of a 16-bit step')
f32 = decode(os.path.join(OUT, 'song-f32.wav'))
check(float(np.max(np.abs(f32))) <= 1.0, 'song-f32.wav: no sample over full scale')

# G.711: the codes the ITU-T reference encoder gives (Python's audioop, the
# Sun g711.c algorithm) for the float WAV's sound rounded to 16 bits.
# ffmpeg's own encoder is not the reference: it picks the nearest level, so
# at the edges of each segment it differs for 1 to 2% of samples.
import warnings
warnings.simplefilter('ignore', DeprecationWarning)
import audioop
f = decode(os.path.join(OUT, 'song-f32.wav')).reshape(-1)
s16 = np.clip(np.floor(f * 32768 + 0.5), -32768, 32767).astype('<i2').tobytes()
for law, enc in [('ulaw', audioop.lin2ulaw), ('alaw', audioop.lin2alaw)]:
    mine = ulaw_codes(os.path.join(OUT, f'song-{law}.wav'))
    ref = np.frombuffer(enc(s16, 2), np.uint8)
    check(mine.shape == ref.shape and bool(np.all(mine == ref)), f'song-{law}.wav: the reference G.711 codes ({int(np.sum(mine != ref)) if mine.shape == ref.shape else "?"} differ)')

# The tags, as mutagen reads them.
from mutagen.wave import WAVE
w = WAVE(os.path.join(OUT, 'song.wav'))
t = w.tags
check(t is not None and t.version == (2, 3, 0), f'song.wav: an ID3v2.3 chunk ({t.version if t else None})')
T = EXP['tags']
want = {'TIT2': T['title'], 'TPE1': T['artist'], 'TALB': T['album'], 'TPE2': T['albumartist'], 'TCOM': T['composer'], 'TCON': T['genre'],
        'TRCK': T['track'], 'TPOS': T['disc']}
for k, v in want.items():
    got = str(t.get(k)) if t and t.get(k) else None
    check(got == v, f'song.wav: {k} {got!r}')
check(str(t.get('TDRC')) == '2019', f'song.wav: year {t.get("TDRC")}')
check(t.getall('USLT') and t.getall('USLT')[0].text == T['lyrics'], 'song.wav: lyrics')
check(t.getall('COMM') and t.getall('COMM')[0].text == [T['comment']], 'song.wav: comment')
pics = t.getall('APIC')
check(len(pics) == 1 and hashlib.sha256(pics[0].data).hexdigest() == EXP['coverSha256'] and pics[0].type == 3, 'song.wav: the front cover, byte for byte')
bare = WAVE(os.path.join(OUT, 'song-notags.wav'))
check(bare.tags is None and os.path.getsize(os.path.join(OUT, 'song-notags.wav')) == 44 + 132300 * 4, 'song-notags.wav: no tags, a 44-byte header')

print('FAILED' if failed else 'all passed', f'({failed} failed)')
sys.exit(1 if failed else 0)
