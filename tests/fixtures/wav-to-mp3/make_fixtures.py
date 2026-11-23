#!/usr/bin/env python3
"""Builds the sample files for tests/tools/wav-to-mp3.test.js and writes
expected.json, the facts the test checks against: what ffprobe reports for
each file (codec, rate, channels, samples) and what the signals are.

Needs ffmpeg and ffprobe (6.x), numpy and mutagen. Run from any folder:
    python3 tests/fixtures/wav-to-mp3/make_fixtures.py [--all]
It makes the files that are missing and writes expected.json again from the
files there are; --all makes every file again. Every file comes out the
same, byte for byte, each time.

Tones are sines; amp is the peak, so RMS = amp / sqrt 2.
  take.wav        0.75 s, 16-bit stereo 44.1 kHz: left 440 Hz at 0.5, right
                  660 Hz at 0.25. LIST INFO before the sound, in UTF-8: TAGS.
  tags-after.wav  0.5 s, 16-bit mono 22.05 kHz, 330 Hz at 0.4. After the
                  sound a LIST INFO chunk (title only) and an 'id3 ' chunk
                  with ID3v2.4 frames (ID3 below) and a 300x300 JPEG cover
                  of noise (about 60 KB), as editors write them.
  hires-96k.wav   0.5 s, 24-bit mono 96 kHz (WAVE_FORMAT_EXTENSIBLE): 1 kHz
                  and 30 kHz, each at 0.5. Resampled to 48 kHz, 30 kHz must
                  not fold back to 18 kHz.
  hires-88k.wav   0.5 s, 16-bit mono 88.2 kHz: 1 kHz and 30 kHz at 0.5
                  (would fold back to 14.1 kHz at 44.1 kHz).
  hires-192k.wav  0.2 s, 32-bit float mono 192 kHz: 1 kHz and 40 kHz at 0.5
                  (would fold back to 8 kHz at 48 kHz).
  float-loud.wav  0.5 s, 32-bit float mono 48 kHz: 440 Hz at 1.5, over full
                  scale, as a 32-bit float recorder can capture it.
  pcm8.wav        0.5 s, 8-bit unsigned mono 8 kHz, 300 Hz at 0.5.
  pcm32.wav       0.5 s, 32-bit integer mono 16 kHz, 500 Hz at 0.5.
  float64.wav     0.25 s, 64-bit float mono 22.05 kHz, 700 Hz at 0.5.
  ulaw.wav, alaw.wav  1 s, G.711 mono 8 kHz, 400 Hz at 0.5 (ffmpeg).
  rf64.wav        0.25 s, 16-bit stereo 44.1 kHz in RF64 (ffmpeg), 440/660.
  bwf.wav         0.25 s, 24-bit stereo 48 kHz with a bext chunk (ffmpeg).
  three.wav, surround51.wav, surround71.wav  0.1 s, 16-bit 48 kHz, 3.0,
                  5.1 and 7.1: each channel its own tone (CHANNEL_HZ).
  ima-adpcm.wav, ms-adpcm.wav, gsm.wav  ADPCM and GSM 6.10, which browsers
                  cannot decode (ffmpeg).
  mp3-in.wav      1 s of MP3 (64 kbps mono 16 kHz, ffmpeg) inside a WAV,
                  format 0x55, with an INFO title. expected.json holds the
                  SHA-256 of its MP3 bytes.
  never-finished.wav, unknown-size.wav, short-header.wav, cut-off.wav,
  list-after.wav  1 s of 16-bit mono 8 kHz (1 kHz at 0.5) whose header is
                  wrong as recorders and editors leave it: sizes 0, sizes
                  0xFFFFFFFF, a data size of 0.4 s, a data size of 2 s in a
                  file cut after 0.6 s, and (list-after.wav) a right header
                  with a LIST chunk after the sound, which must not be read
                  as sound.
  song.mp3        0.5 s MP3 (LAME 128 kbps stereo 44.1 kHz) with ID3v2.3.
  voice.m4a       0.5 s AAC-LC mono 44.1 kHz; alac.m4a the same as ALAC,
                  which Chromium cannot decode.
  song.flac, voice.ogg (Opus)  0.5 s each.
  clip.mp4        0.5 s H.264 + AAC; silent.mp4 H.264 with no sound.
  not-audio.wav   text with a WAV name; empty.wav 0 bytes.
"""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ALL = '--all' in sys.argv[1:]

TAGS = {'INAM': 'Morning take – café ☕', 'IART': 'Zoë Field', 'IPRD': 'Field notes 日本', 'ICRD': '2019',
        'IGNR': 'Speech', 'ICMT': 'Take 4, Zoom H5', 'ITRK': '3/12', 'IMUS': 'Ana Composer'}
ID3 = {'title': 'Tagged after – ünïcode 🎙', 'artist': 'After Artist', 'album': 'After Album', 'albumartist': 'Album Artist',
       'composer': 'After Composer', 'date': '2021-06-15', 'track': '7/9', 'disc': '1/2', 'genre': 'Podcast',
       'comment': 'Second line follows\nhere', 'lyrics': 'La la la\nLa la'}
CHANNEL_HZ = [300, 500, 700, 900, 1100, 1300, 1500, 1700]


def want(name):
    """True when name is to be made: it is missing, or --all was given."""
    return ALL or not os.path.exists(os.path.join(HERE, name))


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, cwd=HERE)


def probe(name):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_format', name],
                         check=True, cwd=HERE, capture_output=True, text=True).stdout
    return json.loads(out)


def tone(hz, amp, sr, n):
    return amp * np.sin(2 * np.pi * hz * np.arange(n) / sr)


def chunk(cid, body):
    return cid.encode('latin-1') + struct.pack('<I', len(body)) + body + (b'\0' if len(body) & 1 else b'')


def info_chunk(tags):
    body = b'INFO'
    for k, v in tags.items():
        body += chunk(k, v.encode('utf-8') + b'\0')
    return chunk('LIST', body)


def fmt_chunk(tag, ch, sr, bits):
    align = ch * bits // 8
    return chunk('fmt ', struct.pack('<HHIIHH', tag, ch, sr, sr * align, align, bits))


def pcm16(x):
    return np.round(np.clip(x, -1, 32767 / 32768) * 32768).astype('<i2')


def wav(name, sr, planes, before=b'', after=b'', bits=16, tag=1):
    """A WAV of 16-bit PCM (or 32/64-bit float with tag 3) with chunks before and after the sound."""
    x = np.stack(planes, axis=1)
    data = pcm16(x).tobytes() if tag == 1 else x.astype('<f4' if bits == 32 else '<f8').tobytes()
    body = b'WAVE' + fmt_chunk(tag, len(planes), sr, bits) + before + chunk('data', data) + after
    with open(os.path.join(HERE, name), 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(body)) + body)


def sha(name):
    with open(os.path.join(HERE, name), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


if want('take.wav'):
    n = round(0.75 * 44100)
    wav('take.wav', 44100, [tone(440, 0.5, 44100, n), tone(660, 0.25, 44100, n)], before=info_chunk(TAGS))

if want('tags-after.wav'):
    from mutagen.id3 import ID3 as Id3, TIT2, TPE1, TALB, TPE2, TCOM, TDRC, TRCK, TPOS, TCON, COMM, USLT, APIC
    from PIL import Image
    rng = np.random.default_rng(7)
    img = Image.fromarray(rng.integers(0, 256, (300, 300, 3), dtype=np.uint8))
    jpg = io.BytesIO()
    img.save(jpg, 'JPEG', quality=70)
    cover = jpg.getvalue()
    with open(os.path.join(HERE, 'cover.jpg'), 'wb') as f:
        f.write(cover)
    t = Id3()
    t.add(TIT2(encoding=3, text=ID3['title'])); t.add(TPE1(encoding=3, text=ID3['artist'])); t.add(TALB(encoding=3, text=ID3['album']))
    t.add(TPE2(encoding=3, text=ID3['albumartist'])); t.add(TCOM(encoding=3, text=ID3['composer'])); t.add(TDRC(encoding=3, text=ID3['date']))
    t.add(TRCK(encoding=3, text=ID3['track'])); t.add(TPOS(encoding=3, text=ID3['disc'])); t.add(TCON(encoding=3, text=ID3['genre']))
    t.add(COMM(encoding=3, lang='eng', desc='', text=ID3['comment'])); t.add(USLT(encoding=3, lang='eng', desc='', text=ID3['lyrics']))
    t.add(APIC(encoding=0, mime='image/jpeg', type=3, desc='', data=cover))
    tag = io.BytesIO()
    t.save(tag, v2_version=4, padding=lambda info: 0)
    n = round(0.5 * 22050)
    wav('tags-after.wav', 22050, [tone(330, 0.4, 22050, n)], after=info_chunk({'INAM': ID3['title']}) + chunk('id3 ', tag.getvalue()))

if want('hires-96k.wav'):
    n = 48000
    x = tone(1000, 0.5, 96000, n) + tone(30000, 0.5, 96000, n)
    raw = os.path.join(HERE, 'hires.f64')
    x.astype('<f8').tofile(raw)
    ff('-f', 'f64le', '-ar', '96000', '-ac', '1', '-i', 'hires.f64', '-c:a', 'pcm_s24le', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'hires-96k.wav')
    os.remove(raw)

if want('hires-88k.wav'):
    n = 44100
    wav('hires-88k.wav', 88200, [tone(1000, 0.5, 88200, n) + tone(30000, 0.5, 88200, n)])

if want('hires-192k.wav'):
    n = round(0.2 * 192000)
    wav('hires-192k.wav', 192000, [tone(1000, 0.5, 192000, n) + tone(40000, 0.5, 192000, n)], bits=32, tag=3)

if want('float-loud.wav'):
    wav('float-loud.wav', 48000, [tone(440, 1.5, 48000, 24000)], bits=32, tag=3)

if want('pcm8.wav'):
    x = tone(300, 0.5, 8000, 4000)
    body = b'WAVE' + fmt_chunk(1, 1, 8000, 8) + chunk('data', np.round(x * 127 + 128).astype('u1').tobytes())
    with open(os.path.join(HERE, 'pcm8.wav'), 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(body)) + body)

if want('pcm32.wav'):
    x = tone(500, 0.5, 16000, 8000)
    body = b'WAVE' + fmt_chunk(1, 1, 16000, 32) + chunk('data', np.round(x * 2147483647).astype('<i4').tobytes())
    with open(os.path.join(HERE, 'pcm32.wav'), 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(body)) + body)

if want('float64.wav'):
    wav('float64.wav', 22050, [tone(700, 0.5, 22050, round(0.25 * 22050))], bits=64, tag=3)

for name, codec in [('ulaw.wav', 'pcm_mulaw'), ('alaw.wav', 'pcm_alaw')]:
    if want(name):
        ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*400*t):s=8000:d=1', '-c:a', codec, '-fflags', '+bitexact', '-flags:a', '+bitexact', name)

if want('rf64.wav'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):s=44100:d=0.25', '-c:a', 'pcm_s16le', '-rf64', 'always',
       '-fflags', '+bitexact', '-flags:a', '+bitexact', 'rf64.wav')

if want('bwf.wav'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):s=48000:d=0.25', '-c:a', 'pcm_s24le', '-write_bext', '1',
       '-metadata', 'description=Scene 12 take 3', '-metadata', 'originator=Field recorder', '-metadata', 'origination_date=2026-11-20',
       '-metadata', 'origination_time=10:15:00', '-metadata', 'time_reference=0', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'bwf.wav')

for name, layout in [('three.wav', '3.0'), ('surround51.wav', '5.1'), ('surround71.wav', '7.1')]:
    if want(name):
        ch = {'3.0': 3, '5.1': 6, '7.1': 8}[layout]
        expr = '|'.join(f'0.25*sin(2*PI*{CHANNEL_HZ[c]}*t)' for c in range(ch))
        ff('-f', 'lavfi', '-i', f'aevalsrc={expr}:s=48000:d=0.1:c={layout}', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', name)

for name, args in [('ima-adpcm.wav', ['-c:a', 'adpcm_ima_wav']), ('ms-adpcm.wav', ['-c:a', 'adpcm_ms']), ('gsm.wav', ['-c:a', 'libgsm_ms'])]:
    if want(name):
        ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*400*t):s=8000:d=0.5', *args, '-fflags', '+bitexact', '-flags:a', '+bitexact', name)

if want('mp3-in.wav'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t):s=16000:d=1', '-c:a', 'libmp3lame', '-b:a', '64k', '-metadata', 'title=MP3 inside',
       '-metadata', 'artist=Wave Artist', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'wav', 'mp3-in.wav')

# 1 s of 16-bit mono 8 kHz with headers as recorders and editors get them wrong.
ONE = pcm16(tone(1000, 0.5, 8000, 8000)).tobytes()


def raw_wav(name, riff, data_size, sound, after=b''):
    body = b'WAVE' + fmt_chunk(1, 1, 8000, 16) + b'data' + struct.pack('<I', data_size) + sound + after
    with open(os.path.join(HERE, name), 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', riff) + body)


if want('never-finished.wav'):
    raw_wav('never-finished.wav', 0, 0, ONE)
if want('unknown-size.wav'):
    raw_wav('unknown-size.wav', 0xFFFFFFFF, 0xFFFFFFFF, ONE)
if want('short-header.wav'):
    raw_wav('short-header.wav', 36 + 6400, 6400, ONE)
if want('cut-off.wav'):
    raw_wav('cut-off.wav', 36 + 32000, 32000, ONE[:9600])
if want('list-after.wav'):
    lst = info_chunk({'INAM': 'Tag after the sound'})
    raw_wav('list-after.wav', 36 + 16000 + len(lst), 16000, ONE, after=lst)

if want('song.mp3'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)|0.5*sin(2*PI*550*t):s=44100:d=0.5', '-c:a', 'libmp3lame', '-b:a', '128k',
       '-id3v2_version', '3', '-metadata', 'title=Neighbour song', '-metadata', 'artist=MP3 Artist', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'song.mp3')
if want('voice.m4a'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*300*t):s=44100:d=0.5', '-c:a', 'aac', '-b:a', '64k', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'voice.m4a')
if want('alac.m4a'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*300*t):s=44100:d=0.5', '-c:a', 'alac', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'alac.m4a')
if want('song.flac'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*600*t):s=44100:d=0.5', '-c:a', 'flac', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'song.flac')
if want('voice.ogg'):
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*800*t):s=48000:d=0.5', '-c:a', 'libopus', '-b:a', '32k', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'voice.ogg')
VIDEO = ['-f', 'lavfi', '-i', 'color=c=0x1f6f4a:s=64x36:r=5:d=0.5']
X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '10']
if want('clip.mp4'):
    ff(*VIDEO, '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*500*t):s=44100:d=0.5', *X264, '-c:a', 'aac', '-b:a', '64k', '-shortest',
       '-fflags', '+bitexact', '-flags:a', '+bitexact', 'clip.mp4')
if want('silent.mp4'):
    ff(*VIDEO, *X264, '-fflags', '+bitexact', 'silent.mp4')
if want('not-audio.wav'):
    with open(os.path.join(HERE, 'not-audio.wav'), 'w') as f:
        f.write('This is a text file with a WAV name.\n')
if want('empty.wav'):
    open(os.path.join(HERE, 'empty.wav'), 'wb').close()

# ---------- expected.json ----------
expected = {'tags': TAGS, 'id3': ID3, 'channelHz': CHANNEL_HZ}
for name in sorted(os.listdir(HERE)):
    if not name.endswith(('.wav', '.mp3', '.m4a', '.flac', '.ogg', '.mp4')) or name in ('not-audio.wav', 'empty.wav'):
        continue
    e = {'bytes': os.path.getsize(os.path.join(HERE, name)), 'sha256': sha(name)}
    p = probe(name)
    a = [s for s in p['streams'] if s['codec_type'] == 'audio']
    if a:
        s = a[0]
        e.update(codec=s['codec_name'], sr=int(s['sample_rate']), ch=s['channels'], layout=s.get('channel_layout', ''),
                 bits=int(s.get('bits_per_sample') or 0), samples=int(s['duration_ts']) if 'duration_ts' in s and s['codec_name'].startswith('pcm_') else None,
                 duration=float(s.get('duration') or p['format'].get('duration') or 0))
    e['formatTags'] = p['format'].get('tags', {})
    expected[name] = e
# The MP3 frames inside mp3-in.wav, byte for byte.
with open(os.path.join(HERE, 'mp3-in.wav'), 'rb') as f:
    b = f.read()
at = b.index(b'data', 12) + 8
size = struct.unpack('<I', b[at - 4:at])[0]
expected['mp3-in.wav']['mp3Sha256'] = hashlib.sha256(b[at:at + size]).hexdigest()
expected['mp3-in.wav']['mp3Bytes'] = size
with open(os.path.join(HERE, 'cover.jpg'), 'rb') as f:
    expected['coverSha256'] = hashlib.sha256(f.read()).hexdigest()
with open(os.path.join(HERE, 'expected.json'), 'w') as f:
    json.dump(expected, f, indent=1, ensure_ascii=False, sort_keys=True)
    f.write('\n')
print('wrote', len(expected), 'entries')
