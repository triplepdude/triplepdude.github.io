#!/usr/bin/env python3
"""Builds the sample files for tests/tools/mp3-to-wav.test.js and writes
expected.json, the facts the test checks the page's WAV files against: what
ffprobe reports for each file, how many samples ffmpeg decodes from each MP3
(ffmpeg honours the LAME tag's encoder delay and padding, as gapless players
do), the levels of what it decodes (numpy), and the tags mutagen reads.

Needs ffmpeg and ffprobe (6.x), numpy, mutagen and Pillow. Run from any folder:
    python3 tests/fixtures/mp3-to-wav/make_fixtures.py [--all]
It makes the files that are missing and writes expected.json again from the
files there are; --all makes every file again. Every file comes out the
same, byte for byte, each time.

Tones are sines; amp is the peak.
  song.mp3      3 s (132,300 samples) of a different chirp in each channel,
                44.1 kHz stereo, LAME 128 kbps CBR with its Info/LAME tag
                (delay 576 samples), ID3v2.3 with every field the page keeps
                (TAGS: letters outside ISO-8859-1, a year-only date, track
                and disc as "3/12" and "1/2", lyrics on two lines) and a
                600x600 JPEG cover of about 110 KB, then an ID3v1 tag.
  vbr.mp3       The chirps with noise under them, LAME VBR (-q:a 2): Xing
                and LAME tag, a title only.
  no-tag.mp3    The chirps at 128 kbps without the Info frame, so no LAME
                tag says how much to drop: 1,105 samples of lead-in stay.
  mpeg2.mp3     2 s of a chirp, mono 22.05 kHz, 64 kbps (MPEG-2).
  mpeg25.mp3    2 s of 300 Hz at 0.5, mono 8 kHz, 24 kbps (MPEG-2.5).
  vbri.mp3      vbr.mp3 with a Fraunhofer VBRI header in place of its Xing
                frame: no LAME tag, so the lead-in stays.
  loud.mp3      2 s of a loud, limited master (peaks at 0.999) at 192 kbps:
                ffmpeg's decoder gives peaks above full scale.
  hz48.mp3      2 s at 48 kHz stereo, 192 kbps: left 1 kHz at 0.5, right
                12 kHz at 0.25.
  mono.mp3      1 s of 440 Hz at 0.5, mono 44.1 kHz, 96 kbps.
  tags-v22.mp3  0.5 s with an ID3v2.2 tag (V22), tags-v24.mp3 with ID3v2.4
                in UTF-8 (V24) and a 300x300 PNG cover, v1only.mp3 with an
                ID3v1.1 tag only (V1), ape.mp3 with an APEv2 tag only.
  cut-off.mp3   song.mp3 cut off after 1.2 s of its frames, as a download
                that stopped: its LAME tag still promises 3 s.
  junk.mp3      1 s of the chirps (128 kbps, no Info frame) with 700 bytes
                of junk before the frames and 333 bytes after the tenth.
  free.mp3      A free-format MP3 (no bitrate in its frames).
  hour-block.mp3  400 frames (10.45 s) of a 440 Hz tone, 44.1 kHz stereo at
                64 kbps, without the bit reservoir, an Info frame or tags:
                the test repeats it into an hour-long MP3 (Blob parts).
  not-audio.mp3 Text with an MP3 name; empty.mp3 0 bytes; really-wav.mp3 a
                WAV (16-bit mono 16 kHz, 0.5 s of 500 Hz) with an MP3 name.
  take.wav      0.5 s 16-bit stereo 44.1 kHz WAV, left 440 Hz, right 660 Hz.
  voice.m4a     0.5 s AAC-LC mono 44.1 kHz, 300 Hz.
  hires.flac    0.5 s 24-bit stereo 96 kHz FLAC: 1 kHz and 30 kHz.
  surround.flac 0.25 s 16-bit 5.1 at 48 kHz, each channel its own tone.
  voice.ogg     0.5 s Opus mono, 800 Hz.
  alac.m4a      0.5 s 16-bit ALAC stereo 44.1 kHz, as a CD rip.
  clip.mp4      0.5 s H.264 with AAC sound; silent.mp4 H.264 with no sound.
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

TAGS = {'title': 'Live at the Café – 日本語 🎸', 'artist': 'Zoë & the Band', 'album': 'Live in Kraków', 'albumartist': 'Various Artists',
        'composer': 'Åsa Composer', 'date': '2019', 'track': '3/12', 'disc': '1/2', 'genre': 'Live',
        'comment': 'Recorded live\nsecond line', 'lyrics': 'First line\nSecond line'}
V22 = {'TT2': 'Ôld Title', 'TP1': 'Old Artist', 'TAL': 'Old Album', 'TYE': '1999', 'TRK': '5/9', 'TCO': 'Rock'}
V24 = {'title': 'Ünïcode Title ☕', 'artist': 'Four Artist', 'album': 'Four Album', 'albumartist': 'Four Album Artist',
       'composer': 'Four Composer', 'date': '2021-06-15', 'track': '7', 'disc': '2/3', 'genre': 'Jazz'}
V1 = {'title': 'One Title', 'artist': 'One Artist', 'album': 'One Album', 'year': '1998', 'track': 4, 'genre': 8}
CHANNEL_HZ = [300, 500, 700, 900, 1100, 1300]


def want(name):
    """True when name is to be made: it is missing, or --all was given."""
    return ALL or not os.path.exists(os.path.join(HERE, name))


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, cwd=HERE)


def ff_out(*args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', *args], check=True, cwd=HERE, capture_output=True).stdout


def probe(name):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_format', name],
                         check=True, cwd=HERE, capture_output=True, text=True).stdout
    return json.loads(out)


def path(name):
    return os.path.join(HERE, name)


def write(name, data):
    with open(path(name), 'wb') as f:
        f.write(data)


def read(name):
    with open(path(name), 'rb') as f:
        return f.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


# A chirp of exactly 132,300 samples (3 s at 44.1 kHz), different in each
# channel, so that any shift or cut shows: left 0.5 sin(2 pi (200 t + 300 t^2)),
# right 0.3 sin(2 pi (300 t + 200 t^2)). The test makes the same signal.
CHIRP = "0.5*sin(2*PI*(200*t+300*t*t))|0.3*sin(2*PI*(300*t+200*t*t))"
CHIRP3 = ['-f', 'lavfi', '-i', f"aevalsrc='{CHIRP}':s=44100:d=3"]
NOISY3 = ['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*(200*t+300*t*t))+0.15*(random(0)-0.5)|0.25*sin(2*PI*(300*t+200*t*t))+0.15*(random(1)-0.5)':s=44100:d=3"]
SHORT = ['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=44100:d=0.5"]
LAME = ['-c:a', 'libmp3lame', '-fflags', '+bitexact', '-flags:a', '+bitexact']
EXACT = ['-fflags', '+bitexact', '-flags:a', '+bitexact']


def cover(kind):
    """A cover the same each time: a 600x600 JPEG of a gradient under noise
    (about 110 KB), or a 300x300 PNG of a gradient under light noise."""
    from PIL import Image
    n = 600 if kind == 'JPEG' else 300
    y, x = np.mgrid[0:n, 0:n]
    img = np.stack([x * 255 // (n - 1), y * 255 // (n - 1), (x + y) * 255 // (2 * n - 2)], axis=2)
    img = img + np.random.default_rng(3).integers(-30, 31, img.shape) // (1 if kind == 'JPEG' else 10)
    b = io.BytesIO()
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(b, kind, **({'quality': 75} if kind == 'JPEG' else {'optimize': True}))
    return b.getvalue()


def id3_tag(t, version, pic=None, mime='image/jpeg'):
    """An ID3v2 tag written by mutagen (its bytes only)."""
    from mutagen.id3 import ID3 as Id3, TIT2, TPE1, TALB, TPE2, TCOM, TDRC, TRCK, TPOS, TCON, COMM, USLT, APIC
    tag = Id3()
    enc = 1 if version == 3 else 3   # UTF-16 in v2.3, UTF-8 in v2.4
    frames = {'title': TIT2, 'artist': TPE1, 'album': TALB, 'albumartist': TPE2, 'composer': TCOM, 'date': TDRC,
              'track': TRCK, 'disc': TPOS, 'genre': TCON}
    for k, cls in frames.items():
        if t.get(k):
            tag.add(cls(encoding=enc, text=t[k]))
    if t.get('comment'):
        tag.add(COMM(encoding=enc, lang='eng', desc='', text=t['comment']))
    if t.get('lyrics'):
        tag.add(USLT(encoding=enc, lang='eng', desc='', text=t['lyrics']))
    if pic:
        tag.add(APIC(encoding=0, mime=mime, type=3, desc='', data=pic))
    b = io.BytesIO()
    b.write(b'\0' * 64)   # mutagen saves into a file; a blank one gets the tag in front
    b.seek(0)
    tag.save(b, v1=0, v2_version=version, padding=lambda info: 0)
    data = b.getvalue()
    size = 10 + ((data[6] & 127) << 21 | (data[7] & 127) << 14 | (data[8] & 127) << 7 | data[9] & 127)
    return data[:size]


def id3v1(title='', artist='', album='', year='', comment='', track=0, genre=255):
    f = lambda s, n: s.encode('latin-1')[:n].ljust(n, b'\0')
    return b'TAG' + f(title, 30) + f(artist, 30) + f(album, 30) + f(year, 4) + f(comment, 28) + b'\0' + bytes([track, genre])


def id3v22(frames):
    """An ID3v2.2 tag: 3-letter frame ids and 3-byte sizes."""
    body = b''
    for fid, data in frames:
        body += fid.encode() + len(data).to_bytes(3, 'big') + data
    n = len(body)
    return b'ID3\x02\x00\x00' + bytes([n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127]) + body


def mp3_frames(d):
    """(offset, version id, size) of each MPEG-1/2/2.5 Layer III frame after an ID3v2 tag."""
    kb = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]}
    kb[2] = kb[0] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    sr = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    p = 10 + ((d[6] & 127) << 21 | (d[7] & 127) << 14 | (d[8] & 127) << 7 | d[9] & 127) if d[:3] == b'ID3' else 0
    out = []
    while p + 4 <= len(d) and d[p] == 0xFF and d[p + 1] & 0xE0 == 0xE0:
        ver = d[p + 1] >> 3 & 3
        size = (144000 if ver == 3 else 72000) * kb[ver][d[p + 2] >> 4] // sr[ver][d[p + 2] >> 2 & 3] + (d[p + 2] >> 1 & 1)
        if size <= 4:
            break
        out.append((p, ver, size))
        p += size
    return out


def plain_mp3(src, *args):
    """MP3 frames only: no ID3 tag, no Info frame."""
    return ff_out(*src, *LAME, *args, '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', '-')


def lame_mp3(src, *args):
    """MP3 frames after an Info or Xing frame with a LAME tag, which ffmpeg
    writes only into a file it can seek in."""
    tmp = path('tmp-lame.mp3')
    try:
        ff(*src, *LAME, *args, '-id3v2_version', '0', '-write_id3v1', '0', tmp)
        return read('tmp-lame.mp3')
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def with_id3(name, src, tag, *args, v1=b''):
    """An MP3 with its Info/LAME frame, and the tag bytes given in front."""
    write(name, tag + lame_mp3(src, *args) + v1)


ART = cover('JPEG')
PNG = cover('PNG')

if want('song.mp3'):
    t = TAGS
    v1 = id3v1('Live at the Café', 'Zoë & the Band', 'Live in Krak', '2019', '', 3, 255)
    with_id3('song.mp3', CHIRP3, id3_tag(t, 3, ART), '-b:a', '128k', v1=v1)
if want('vbr.mp3'):
    with_id3('vbr.mp3', NOISY3, id3_tag({'title': 'Variable'}, 3), '-q:a', '2')
if want('no-tag.mp3'):
    write('no-tag.mp3', plain_mp3(CHIRP3, '-b:a', '128k'))
if want('mpeg2.mp3'):
    with_id3('mpeg2.mp3', ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(200*t+100*t*t))':s=22050:d=2"], b'', '-b:a', '64k')
if want('mpeg25.mp3'):
    with_id3('mpeg25.mp3', ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*300*t)':s=8000:d=2"], b'', '-b:a', '24k')
if want('vbri.mp3'):
    # vbr.mp3 with a VBRI header in place of its Xing frame.
    d = read('vbr.mp3')
    fr = mp3_frames(d)
    p, ver, size = fr[0]
    audio = fr[1:]
    total = sum(x[2] for x in fr)
    per = 12
    entries = [sum(x[2] for x in audio[i * per:(i + 1) * per]) for i in range((len(audio) + per - 1) // per)]
    vbri = b'VBRI' + struct.pack('>HHHIIHHHH', 1, 576, 75, total, len(audio), len(entries), 1, 2, per) + b''.join(struct.pack('>H', e) for e in entries)
    frame = bytearray(d[p:p + size])
    frame[3] = d[audio[0][0] + 3]
    frame[4:] = b'\x00' * (size - 4)
    frame[36:36 + len(vbri)] = vbri
    write('vbri.mp3', d[:p] + bytes(frame) + d[p + size:fr[-1][0] + fr[-1][2]])
if want('loud.mp3'):
    sr, n = 44100, 88200
    rng = np.random.default_rng(5)
    t = np.arange(n) / sr
    x = np.tanh(3 * (0.6 * np.sin(2 * np.pi * 110 * t) + 0.4 * np.sin(2 * np.pi * 1650 * t) + 0.2 * rng.standard_normal(n)))
    x = x / np.max(np.abs(x)) * 0.999
    raw = path('loud.f32')
    np.stack([x, x], axis=1).astype('<f4').tofile(raw)
    try:
        with_id3('loud.mp3', ['-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', 'loud.f32'], b'', '-b:a', '192k')
    finally:
        os.remove(raw)
if want('hz48.mp3'):
    with_id3('hz48.mp3', ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*12000*t)':s=48000:d=2"], b'', '-b:a', '192k')
if want('mono.mp3'):
    with_id3('mono.mp3', ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)':s=44100:d=1"], b'', '-b:a', '96k')
if want('tags-v22.mp3'):
    frames = [(k, b'\x00' + v.encode('latin-1')) for k, v in V22.items()]
    write('tags-v22.mp3', id3v22(frames) + plain_mp3(SHORT, '-b:a', '64k'))
if want('tags-v24.mp3'):
    with_id3('tags-v24.mp3', SHORT, id3_tag(V24, 4, PNG, 'image/png'), '-b:a', '64k')
if want('v1only.mp3'):
    body = lame_mp3(SHORT, '-b:a', '64k')
    write('v1only.mp3', body + id3v1(V1['title'], V1['artist'], V1['album'], V1['year'], 'A comment', V1['track'], V1['genre']))
if want('ape.mp3'):
    body = lame_mp3(SHORT, '-b:a', '64k')
    item = struct.pack('<II', 9, 0) + b'Title\x00APE title'
    footer = lambda flags: b'APETAGEX' + struct.pack('<IIII', 2000, len(item) + 32, 1, flags) + b'\x00' * 8
    write('ape.mp3', body + footer(0xA0000000) + item + footer(0x80000000))
if want('cut-off.mp3'):
    d = read('song.mp3')
    fr = mp3_frames(d)
    # The Info frame and the frames of the first 1.2 s.
    keep = 1 + round(1.2 * 44100 / 1152)
    write('cut-off.mp3', d[:fr[keep][0]])
JUNK_AT = 10
if want('junk.mp3'):
    plain = plain_mp3(['-f', 'lavfi', '-i', f"aevalsrc='{CHIRP}':s=44100:d=1"], '-b:a', '128k')
    fr = mp3_frames(plain)
    cut = fr[JUNK_AT][0]
    junk = bytes((i * 37 + 11) % 251 & 0x7F for i in range(700))
    write('junk.mp3', junk + plain[:cut] + junk[:333] + plain[cut:])
if want('free.mp3'):
    # 48 kHz at 128 kbps: every frame is 384 bytes, so the bitrate field can
    # say "free format" (0) and the frames stay as they are.
    plain = plain_mp3(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)':s=48000:d=0.5"], '-b:a', '128k')
    b = bytearray(plain)
    for p, ver, size in mp3_frames(plain):
        assert size == 384
        b[p + 2] &= 0x0F
    write('free.mp3', bytes(b))
HOUR_FRAMES = 400
if want('hour-block.mp3'):
    plain = plain_mp3(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)|0.3*sin(2*PI*440*t)':s=44100:d=11"], '-b:a', '64k', '-reservoir', '0')
    fr = mp3_frames(plain)
    write('hour-block.mp3', plain[fr[0][0]:fr[HOUR_FRAMES][0]])
if want('not-audio.mp3'):
    write('not-audio.mp3', b'This is a text file with an MP3 name.\n')
if want('empty.mp3'):
    write('empty.mp3', b'')
if want('really-wav.mp3'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*500*t)':s=16000:d=0.5", '-c:a', 'pcm_s16le', *EXACT, '-f', 'wav', 'really-wav.mp3')
if want('take.wav'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t)':s=44100:d=0.5", '-c:a', 'pcm_s16le', *EXACT, 'take.wav')
if want('voice.m4a'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)':s=44100:d=0.5", '-c:a', 'aac', '-b:a', '64k', *EXACT, 'voice.m4a')
if want('alac.m4a'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)|0.2*sin(2*PI*450*t)':s=44100:d=0.5", '-c:a', 'alac', '-sample_fmt', 's16p', *EXACT, 'alac.m4a')
if want('hires.flac'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1000*t)|0.5*sin(2*PI*30000*t)':s=96000:d=0.5", '-c:a', 'flac', '-sample_fmt', 's32',
       '-bits_per_raw_sample', '24', *EXACT, 'hires.flac')
if want('surround.flac'):
    expr = '|'.join(f'0.25*sin(2*PI*{CHANNEL_HZ[c]}*t)' for c in range(6))
    ff('-f', 'lavfi', '-i', f"aevalsrc='{expr}':s=48000:d=0.25:c=5.1", '-c:a', 'flac', *EXACT, 'surround.flac')
if want('voice.ogg'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*800*t)':s=48000:d=0.5", '-c:a', 'libopus', '-b:a', '32k', *EXACT, 'voice.ogg')
VIDEO = ['-f', 'lavfi', '-i', 'color=c=0x1f6f4a:s=64x36:r=5:d=0.5']
X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '10']
if want('clip.mp4'):
    ff(*VIDEO, '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*500*t)':s=44100:d=0.5", *X264, '-c:a', 'aac', '-b:a', '64k', '-shortest', *EXACT, 'clip.mp4')
if want('silent.mp4'):
    ff(*VIDEO, *X264, '-fflags', '+bitexact', 'silent.mp4')


# ---------- expected.json ----------
def lame_tag(d):
    """Delay and padding from the LAME tag of the first frame, or None."""
    fr = mp3_frames(d)
    if not fr:
        return None
    p, ver, size = fr[0]
    frame = d[p:p + size]
    mono = (frame[3] >> 6) == 3
    side = (17 if mono else 32) if ver == 3 else (9 if mono else 17)
    at = 4 + side
    if frame[at:at + 4] not in (b'Info', b'Xing'):
        return None
    flags = struct.unpack('>I', frame[at + 4:at + 8])[0]
    q = at + 8 + (4 if flags & 1 else 0) + (4 if flags & 2 else 0) + (100 if flags & 4 else 0) + (4 if flags & 8 else 0)
    enc = frame[q:q + 9]
    dp = frame[q + 21:q + 24]
    return {'tag': frame[at:at + 4].decode(), 'encoder': enc.decode('latin-1').rstrip('\0 '),
            'delay': dp[0] << 4 | dp[1] >> 4, 'padding': (dp[1] & 15) << 8 | dp[2], 'frames': len(fr) - 1}


def decoded(name, sr=None):
    """What ffmpeg decodes, as float planes (it honours the LAME tag)."""
    info = probe(name)
    s = [x for x in info['streams'] if x['codec_type'] == 'audio'][0]
    ch = s['channels']
    raw = ff_out('-i', name, '-map', '0:a:0', '-f', 'f32le', '-c:a', 'pcm_f32le', '-')
    x = np.frombuffer(raw, '<f4').reshape(-1, ch)
    return x, int(s['sample_rate'])


expected = {'tags': TAGS, 'v22': V22, 'v24': V24, 'v1': V1, 'channelHz': CHANNEL_HZ, 'coverSha256': sha(ART), 'pngSha256': sha(PNG),
            'coverBytes': len(ART), 'pngBytes': len(PNG), 'junkAt': JUNK_AT, 'hourFrames': HOUR_FRAMES}
for name in sorted(os.listdir(HERE)):
    if not name.endswith(('.wav', '.mp3', '.m4a', '.flac', '.ogg', '.mp4')) or name in ('not-audio.mp3', 'empty.mp3', 'free.mp3'):
        continue
    d = read(name)
    e = {'bytes': len(d), 'sha256': sha(d)}
    p = probe(name)
    a = [s for s in p['streams'] if s['codec_type'] == 'audio']
    if a:
        s = a[0]
        e.update(codec=s['codec_name'], sr=int(s['sample_rate']), ch=s['channels'], layout=s.get('channel_layout', ''),
                 duration=float(s.get('duration') or p['format'].get('duration') or 0), bitRate=int(s.get('bit_rate') or 0))
        x, sr = decoded(name)
        e['samples'] = int(x.shape[0])
        e['peak'] = [round(float(np.max(np.abs(x[:, c]))), 4) for c in range(x.shape[1])]
        e['rms'] = [round(float(np.sqrt(np.mean(x[:, c].astype(np.float64) ** 2))), 4) for c in range(x.shape[1])]
        e['over'] = int(np.sum(np.abs(x) > 1.0))
    if name.endswith('.mp3'):
        e['lame'] = lame_tag(d)
        e['frames'] = len(mp3_frames(d))
    e['formatTags'] = p['format'].get('tags', {})
    expected[name] = e
# The tags as mutagen (an independent reader) finds them in song.mp3.
from mutagen.id3 import ID3 as Id3
t = Id3(path('song.mp3'))
expected['song.mp3']['id3'] = {'version': list(t.version), 'frames': sorted(k[:4] for k in t.keys())}
with open(path('expected.json'), 'w') as f:
    json.dump(expected, f, indent=1, ensure_ascii=False, sort_keys=True)
    f.write('\n')
print('wrote', len(expected), 'entries')
