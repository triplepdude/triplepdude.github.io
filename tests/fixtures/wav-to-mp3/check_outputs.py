#!/usr/bin/env python3
"""Checks the MP3s that tests/tools/wav-to-mp3.test.js saves, with tools that
share no code with the page: ffprobe (codec, rate, channels, bitrate,
duration), ffmpeg's decoder with numpy (exact length, as ffmpeg honours the
LAME tag; tones and their levels; what is left of a tone above the new
Nyquist frequency), mutagen (every ID3v2.3 frame, the ID3v1 tag, the cover's
SHA-256) and ffmpeg's own LAME encoder (the same frames for 16-bit WAVs at
an MP3 rate). Needs ffmpeg, ffprobe, numpy and mutagen.

    W2M_DUMP=/some/folder node tests/run.js wav-to-mp3
    python3 tests/fixtures/wav-to-mp3/check_outputs.py /some/folder

Prints one line per file and exits 1 when any check fails.
"""
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
from mutagen.id3 import ID3
from mutagen.mp3 import MP3

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = json.load(open(os.path.join(HERE, 'expected.json'), encoding='utf-8'))
DUMP = sys.argv[1] if len(sys.argv) > 1 else '.'

# MP3 written by the test: source, rate, channels, kbps, samples, tones per
# channel [(Hz, amplitude)], and the frequency a tone would fold back to.
OUT = {
    'take.mp3': ('take.wav', 44100, 2, 192, 33075, [[(440, 0.5)], [(660, 0.25)]], None),
    'tags-after.mp3': ('tags-after.wav', 22050, 1, 160, 11025, [[(330, 0.4)]], None),
    'pcm8.mp3': ('pcm8.wav', 8000, 1, 64, 4000, [[(300, 0.5)]], None),
    'pcm32.mp3': ('pcm32.wav', 16000, 1, 160, 8000, [[(500, 0.5)]], None),
    'float64.mp3': ('float64.wav', 22050, 1, 160, 5512, [[(700, 0.5)]], None),
    'ulaw.mp3': ('ulaw.wav', 8000, 1, 64, 8000, [[(400, 0.5)]], None),
    'alaw.mp3': ('alaw.wav', 8000, 1, 64, 8000, [[(400, 0.5)]], None),
    'rf64.mp3': ('rf64.wav', 44100, 2, 192, 11025, [[(440, 0.5)], [(660, 0.25)]], None),
    'bwf.mp3': ('bwf.wav', 48000, 2, 192, 12000, [[(440, 0.5)], [(660, 0.25)]], None),
    'three.mp3': ('three.wav', 48000, 2, 192, 4800, [[(300, 0.25)], [(500, 0.25)]], None),
    'surround71.mp3': ('surround71.wav', 48000, 2, 192, 4800, [[(300, 0.25)], [(500, 0.25)]], None),
    'surround51.mp3': ('surround51.wav', 48000, 2, 192, 4800,
                       [[(300, 0.25 * (2 ** 0.5 - 1)), (700, 0.25 * (2 ** 0.5 - 1) / 2 ** 0.5), (1100, 0.25 * (2 ** 0.5 - 1) / 2 ** 0.5)],
                        [(500, 0.25 * (2 ** 0.5 - 1)), (700, 0.25 * (2 ** 0.5 - 1) / 2 ** 0.5), (1300, 0.25 * (2 ** 0.5 - 1) / 2 ** 0.5)]], None),
    'hires-96k.mp3': ('hires-96k.wav', 48000, 1, 192, 24000, [[(1000, 0.5)]], 18000),
    'hires-88k.mp3': ('hires-88k.wav', 44100, 1, 192, 22050, [[(1000, 0.5)]], 14100),
    'hires-192k.mp3': ('hires-192k.wav', 48000, 1, 192, 9600, [[(1000, 0.5)]], 8000),
}
# Same frames as ffmpeg's libmp3lame: 16-bit sources at an MP3 rate, as they are.
SAME_AS_LAME = {'take.mp3', 'rf64.mp3', 'tags-after.mp3'}

failed = 0


def check(ok, what):
    global failed
    if not ok:
        failed += 1
        print('   FAIL', what)
    return ok


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype='<f4')


def tone_db(x, sr, f):
    n = int(len(x) * 0.8)
    o = (len(x) - n) // 2
    w = np.kaiser(n, 20)
    s = np.sum(x[o:o + n] * w * np.exp(-2j * np.pi * f * np.arange(o, o + n) / sr))
    return 20 * np.log10(abs(s) / (w.sum() / 2) + 1e-30)


def frames(b):
    p = 0
    if b[:3] == b'ID3':
        p = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127))
    br = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
    br[0] = br[2]
    rates = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    out = []
    while p + 4 <= len(b):
        h = struct.unpack('>I', b[p:p + 4])[0]
        if h >> 21 != 0x7ff:
            break
        v = (h >> 19) & 3
        n = (144000 if v == 3 else 72000) * br[v][(h >> 12) & 15] // rates[v][(h >> 10) & 3] + ((h >> 9) & 1)
        out.append(b[p:p + n])
        p += n
    return out


for name, (src, sr, ch, kbps, samples, tones, alias) in OUT.items():
    path = os.path.join(DUMP, name)
    if not os.path.exists(path):
        print('missing', name)
        failed += 1
        continue
    print(name)
    p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_format', path], check=True, capture_output=True, text=True).stdout)
    s = p['streams'][0]
    check((s['codec_name'], int(s['sample_rate']), s['channels'], round(int(s['bit_rate']) / 1000)) == ('mp3', sr, ch, kbps),
          f"ffprobe: {s['codec_name']} {s['sample_rate']} Hz, {s['channels']} ch, {s['bit_rate']} bit/s")
    x = decode(path).reshape(-1, ch)
    check(len(x) == samples, f'ffmpeg decodes {len(x)} samples, expected {samples}')
    for c in range(ch):
        for f, a in tones[c]:
            lv = tone_db(x[:, c], sr, f)
            check(abs(lv - 20 * np.log10(a)) < 1.0, f'channel {c}: {f} Hz at {lv:.2f} dBFS, expected {20 * np.log10(a):.2f}')
    if alias:
        lv = tone_db(x[:, 0], sr, alias)
        check(lv < -75, f'{alias} Hz alias at {lv:.1f} dBFS')
    with open(path, 'rb') as fh:
        b = fh.read()
    tags = ID3(path)
    check(tags.version == (2, 3, 0), f'ID3 version {tags.version}')
    check(b[-128:-125] == b'TAG', 'an ID3v1 tag at the end')
    if name in SAME_AS_LAME:
        with tempfile.TemporaryDirectory() as d:
            ref = os.path.join(d, 'ref.mp3')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(HERE, src), '-c:a', 'libmp3lame', '-b:a', f'{kbps}k', ref], check=True)
            with open(ref, 'rb') as fh:
                r = fh.read()
        a, z = frames(b)[1:], frames(r)[1:]
        check(a == z, f'the {len(a)} frames of sound are those of ffmpeg\'s libmp3lame at {kbps} kbps ({sum(1 for u, v in zip(a, z) if u == v)} the same)')

# Every tag, as mutagen reads them (as written: ID3v2.3, not turned into v2.4).
t = ID3(os.path.join(DUMP, 'take.mp3'), translate=False)
want = {'TIT2': EXP['tags']['INAM'], 'TPE1': EXP['tags']['IART'], 'TALB': EXP['tags']['IPRD'], 'TYER': '2019', 'TCON': 'Speech', 'TRCK': '3/12', 'TCOM': 'Ana Composer'}
for k, v in want.items():
    check(k in t and str(t[k]) == v, f'take.mp3 {k}: {t.get(k)!r}, expected {v!r}')
check(t.getall('COMM')[0].text[0] == 'Take 4, Zoom H5', 'take.mp3 COMM')
t = ID3(os.path.join(DUMP, 'tags-after.mp3'), translate=False)
e = EXP['id3']
want = {'TIT2': e['title'], 'TPE1': e['artist'], 'TALB': e['album'], 'TPE2': e['albumartist'], 'TCOM': e['composer'], 'TYER': '2021', 'TDAT': '1506',
        'TRCK': '7/9', 'TPOS': '1/2', 'TCON': 'Podcast'}
for k, v in want.items():
    check(k in t and str(t[k]) == v, f'tags-after.mp3 {k}: {t.get(k)!r}, expected {v!r}')
check(t.getall('COMM')[0].text[0] == e['comment'], 'tags-after.mp3 COMM')
check(t.getall('USLT')[0].text == e['lyrics'], 'tags-after.mp3 USLT')
pic = t.getall('APIC')[0]
check((pic.mime, pic.type, hashlib.sha256(pic.data).hexdigest()) == ('image/jpeg', 3, EXP['coverSha256']), 'tags-after.mp3 cover, byte for byte')
# MP3 inside a WAV: its frames, byte for byte.
with open(os.path.join(DUMP, 'mp3-in.mp3'), 'rb') as fh:
    b = fh.read()
head = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127))
check(hashlib.sha256(b[head:-128]).hexdigest() == EXP['mp3-in.wav']['mp3Sha256'], 'mp3-in.mp3: the MP3 frames of mp3-in.wav, byte for byte')
check(str(ID3(os.path.join(DUMP, 'mp3-in.mp3'))['TIT2']) == 'MP3 inside', 'mp3-in.mp3 title')
info = MP3(os.path.join(DUMP, 'mp3-in.mp3')).info
check((info.sample_rate, info.channels) == (16000, 1), 'mp3-in.mp3 as mutagen reads it')
print('all checks passed' if not failed else f'{failed} checks failed')
sys.exit(1 if failed else 0)
