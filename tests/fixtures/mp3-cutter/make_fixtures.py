#!/usr/bin/env python3
"""Builds the sample files for tests/tools/mp3-cutter.test.js and writes
expected.json, the facts the test checks against (from ffprobe, ffmpeg's
decoder with numpy, and mutagen).

Needs ffmpeg and ffprobe (6.x), numpy, mutagen and Pillow. Run from any folder:
    python3 tests/fixtures/mp3-cutter/make_fixtures.py [--all]
It makes the files that are missing and writes expected.json again from the
files there are; --all makes every file again.

The MP3s carry a "music" signal that LAME has to spend its bit reservoir on:
a chord whose notes change every half second, a little noise (seeded, so the
files come out the same each time) and different levels left and right, so
that any shift of a sample, or a channel swapped, shows.
  song.mp3     8 s, 44.1 kHz stereo, CBR 128 kbps, LAME tag, ID3v2.3 with
               every tag the page keeps (letters outside ISO-8859-1, an
               emoji, a year-only date, track 3/12, disc 1/2, composer, album
               artist, two-line lyrics, a 300x300 JPEG cover) and ID3v1.
  vbr.mp3      6 s, 44.1 kHz stereo, VBR (-q:a 2: Xing and LAME tags).
  mono64.mp3   12 s, 44.1 kHz mono, 64 kbps: the reservoir often reaches four
               frames back, more than the LAME tag's delay can skip.
  low32.mp3    12 s, 44.1 kHz stereo, 32 kbps: up to seven frames back.
  mpeg2.mp3    8 s, 22.05 kHz stereo, 64 kbps (MPEG-2, 576 samples a frame).
  mpeg25.mp3   8 s, 8 kHz mono, 16 kbps (MPEG-2.5).
  notag.mp3    4 s, 44.1 kHz stereo, 128 kbps, no Xing/LAME frame and no tags.
  crc.mp3      2 s, 192 kbps, every frame with a CRC (made here).
  vbri.mp3     vbr.mp3 with a Fraunhofer VBRI header in place of its Xing frame.
  junk.mp3     2 s: an ID3v2 tag, junk, frames with junk between two of them,
               an APEv2 tag and an ID3v1 tag.
  free.mp3     free format (bitrate 0 in every header), which browsers cannot read.
  cut-off.mp3  song.mp3 cut off in the middle of a frame, like a download that
               did not finish.
  tags24.mp3   2 s with an ID3v2.4 tag (UTF-8 text, date 2019-05-03).
  tags22.mp3   2 s with an ID3v2.2 tag.
  pngcover.mp3 1 s with a 240x240 PNG cover of about 150 KB.
  song.m4a     6 s AAC-LC 44.1 kHz stereo 128 kbps, iTunes tags.
  take.wav     2 s PCM 16-bit 16 kHz stereo with RIFF INFO tags.
  song.flac    2 s FLAC 22.05 kHz stereo.
  voice.ogg    3 s Opus mono 48 kHz.
  clip.mp4     4 s, H.264 64x36 and AAC 48 kHz stereo.
  surround.wav 1 s 5.1 PCM 8 kHz; seven.wav 1 s 7.1 PCM 8 kHz.
  hires.wav    0.5 s PCM 24-bit 96 kHz mono.
  ima-adpcm.wav  IMA ADPCM, which browsers cannot decode.
  silent.mp4   1 s of video with no sound track.
  not-audio.mp3  plain text with an MP3 name.  empty.mp3  0 bytes.
  fairplay.m4a copied from tests/fixtures/mp4-to-mp3 (Apple FairPlay DRM).
"""
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys

import numpy as np
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TPE2, TCOM, TYER, TRCK, TPOS, TCON, USLT, COMM, APIC, TDRC
from mutagen.mp4 import MP4
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ALL = '--all' in sys.argv[1:]


def want(name):
    return ALL or not os.path.exists(os.path.join(HERE, name))


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, cwd=HERE)


def ffout(*args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', *args], check=True, cwd=HERE, capture_output=True).stdout


def music(rate, seconds, channels=2):
    """The test signal as float32 [n, channels]."""
    n = int(rate * seconds)
    t = np.arange(n) / rate
    rng = np.random.default_rng(7)
    roots = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25]
    out = np.zeros((n, channels))
    for k in range(int(np.ceil(seconds * 2))):
        a, b = int(k * rate / 2), min(n, int((k + 1) * rate / 2))
        f = roots[(k * 3) % len(roots)]
        tt = t[a:b] - t[a]
        env = np.minimum(1, tt / 0.01) * np.exp(-1.5 * tt)
        for c in range(channels):
            chord = sum(np.sin(2 * np.pi * f * m * tt + c) / (i + 1) for i, m in enumerate([1, 1.25, 1.5, 2]))
            out[a:b, c] += (0.35 if c == 0 else 0.25) * env * chord / 2
    out += 0.03 * rng.standard_normal(out.shape)
    return np.clip(out, -0.99, 0.99).astype(np.float32)


def raw_input(rate, seconds, channels=2):
    """ffmpeg input arguments reading music() from a temporary file."""
    path = os.path.join(HERE, f'.music-{rate}-{seconds}-{channels}.f32')
    music(rate, seconds, channels).tofile(path)
    return ['-f', 'f32le', '-ar', str(rate), '-ac', str(channels), '-i', path], path


LAME = ['-c:a', 'libmp3lame', '-fflags', '+bitexact', '-flags:a', '+bitexact']


def mp3(name, rate, seconds, channels, *enc, tags=False):
    args, path = raw_input(rate, seconds, channels)
    try:
        ff(*args, *LAME, *enc, '-id3v2_version', '0', '-write_id3v1', '0', name)
    finally:
        os.remove(path)


def cover(size, fmt):
    rng = np.random.default_rng(size)
    y, x = np.mgrid[0:size, 0:size]
    rgb = np.stack([(x * 255) // size, (y * 255) // size, ((x ^ y) * 7) & 255], axis=2).astype(np.int16)
    if fmt == 'PNG':
        rgb += rng.integers(-24, 25, rgb.shape)   # noise, so that the PNG stays big (about 150 KB)
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), 'RGB')
    buf = io.BytesIO()
    im.save(buf, fmt, **({'quality': 90} if fmt == 'JPEG' else {}))
    return buf.getvalue()


TAGS = {'title': 'Café 日本語 🎵', 'artist': 'Ärtist', 'album': 'Ålbum', 'albumartist': 'Various Ärtists', 'composer': 'Cömposer',
        'year': '2019', 'track': '3/12', 'disc': '1/2', 'genre': 'Pop', 'lyrics': 'First line\nSecond line', 'comment': 'A comment'}


def id3_all(path, cov):
    t = ID3()
    t.add(TIT2(encoding=1, text=TAGS['title']))
    t.add(TPE1(encoding=1, text=TAGS['artist']))
    t.add(TALB(encoding=1, text=TAGS['album']))
    t.add(TPE2(encoding=1, text=TAGS['albumartist']))
    t.add(TCOM(encoding=1, text=TAGS['composer']))
    t.add(TYER(encoding=0, text=TAGS['year']))
    t.add(TRCK(encoding=0, text=TAGS['track']))
    t.add(TPOS(encoding=0, text=TAGS['disc']))
    t.add(TCON(encoding=0, text=TAGS['genre']))
    t.add(USLT(encoding=1, lang='eng', desc='', text=TAGS['lyrics']))
    t.add(COMM(encoding=0, lang='eng', desc='', text=TAGS['comment']))
    t.add(APIC(encoding=0, mime='image/jpeg', type=3, desc='', data=cov))
    t.save(path, v2_version=3, v1=2)


if want('song.mp3'):
    mp3('song.mp3', 44100, 8, 2, '-b:a', '128k')
    id3_all(os.path.join(HERE, 'song.mp3'), cover(300, 'JPEG'))
if want('vbr.mp3'):
    mp3('vbr.mp3', 44100, 6, 2, '-q:a', '2')
if want('mono64.mp3'):
    mp3('mono64.mp3', 44100, 12, 1, '-b:a', '64k')
if want('low32.mp3'):
    mp3('low32.mp3', 44100, 12, 2, '-b:a', '32k')
if want('mpeg2.mp3'):
    mp3('mpeg2.mp3', 22050, 8, 2, '-b:a', '64k')
if want('mpeg25.mp3'):
    mp3('mpeg25.mp3', 8000, 8, 1, '-b:a', '16k')
if want('notag.mp3'):
    mp3('notag.mp3', 44100, 4, 2, '-b:a', '128k', '-write_xing', '0')
if want('tags24.mp3'):
    mp3('tags24.mp3', 44100, 2, 2, '-b:a', '128k')
    t = ID3()
    t.add(TIT2(encoding=3, text='Ünïcode v2.4 ✓'))
    t.add(TPE1(encoding=3, text='Artist 24'))
    t.add(TDRC(encoding=3, text='2019-05-03'))
    t.add(TRCK(encoding=3, text='7'))
    t.save(os.path.join(HERE, 'tags24.mp3'), v2_version=4, v1=0)


def id3v22(frames):
    body = b''
    for fid, data in frames:
        body += fid.encode() + len(data).to_bytes(3, 'big') + data
    n = len(body)
    return b'ID3\x02\x00\x00' + bytes([n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127]) + body


if want('tags22.mp3'):
    mp3('.plain22.mp3', 44100, 2, 2, '-b:a', '128k')
    with open(os.path.join(HERE, '.plain22.mp3'), 'rb') as f:
        plain = f.read()
    os.remove(os.path.join(HERE, '.plain22.mp3'))
    v22 = [('TT2', 'Ôld Title'), ('TP1', 'Old Artist'), ('TAL', 'Old Album'), ('TYE', '1999'), ('TRK', '5/9')]
    with open(os.path.join(HERE, 'tags22.mp3'), 'wb') as f:
        f.write(id3v22([(k, b'\x00' + v.encode('latin1')) for k, v in v22]) + plain)
if want('pngcover.mp3'):
    mp3('pngcover.mp3', 44100, 1, 2, '-b:a', '128k')
    t = ID3()
    t.add(TIT2(encoding=0, text='PNG cover'))
    t.add(APIC(encoding=0, mime='image/png', type=3, desc='', data=cover(240, 'PNG')))
    t.save(os.path.join(HERE, 'pngcover.mp3'), v2_version=3, v1=0)


def mp3_frames(d, p=None):
    """(offset, version id, size) of each Layer III frame, from p (default after an ID3v2 tag)."""
    kb = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]}
    kb[2] = kb[0] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    sr = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    if p is None:
        p = 10 + ((d[6] & 127) << 21 | (d[7] & 127) << 14 | (d[8] & 127) << 7 | d[9] & 127) if d[:3] == b'ID3' else 0
    out = []
    while p + 4 <= len(d) and d[p] == 0xFF and d[p + 1] & 0xE0 == 0xE0:
        ver = d[p + 1] >> 3 & 3
        size = (144000 if ver == 3 else 72000) * kb[ver][d[p + 2] >> 4] // sr[ver][d[p + 2] >> 2 & 3] + (d[p + 2] >> 1 & 1)
        out.append((p, ver, size))
        p += size
    return out


def mpeg_crc(data):
    crc = 0xFFFF
    for byte in data:
        for i in range(7, -1, -1):
            top = crc >> 15 & 1
            crc = crc << 1 & 0xFFFF
            if top ^ (byte >> i & 1):
                crc ^= 0x8005
    return crc


if want('crc.mp3'):
    args, path = raw_input(44100, 2, 2)
    plain = ffout(*args, *LAME, '-b:a', '192k', '-reservoir', '0', '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', '-')
    os.remove(path)
    out = bytearray()
    for p, ver, size in mp3_frames(plain):
        f = bytearray(plain[p:p + size])
        side = f[4:36]
        bits = int.from_bytes(side, 'big')
        assert bits >> (256 - 9) == 0, 'main_data_begin must be 0'
        main = sum(bits >> (256 - o - 12) & 0xFFF for o in (20, 79, 138, 197))
        assert (main + 7) // 8 <= size - 38, 'room for the CRC'
        f[1] &= 0xFE
        out += bytes(f[:4]) + mpeg_crc(bytes(f[2:4]) + bytes(side)).to_bytes(2, 'big') + bytes(side) + bytes(f[36:size - 2])
    with open(os.path.join(HERE, 'crc.mp3'), 'wb') as f:
        f.write(bytes(out))
if want('vbri.mp3'):
    with open(os.path.join(HERE, 'vbr.mp3'), 'rb') as f:
        d = f.read()
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
    with open(os.path.join(HERE, 'vbri.mp3'), 'wb') as f:
        f.write(d[:p] + bytes(frame) + d[p + size:fr[-1][0] + fr[-1][2]])
JUNK_AFTER = 20   # junk.mp3 has junk after this many frames
if want('junk.mp3'):
    args, path = raw_input(44100, 2, 2)
    plain = ffout(*args, *LAME, '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', '-')
    os.remove(path)
    fr = mp3_frames(plain)
    cut = fr[JUNK_AFTER][0]
    id3 = b'ID3\x03\x00\x00\x00\x00\x00\x15TIT2\x00\x00\x00\x0b\x00\x00\x00Junk test!'
    junk = bytes((i * 37 + 11) % 251 & 0x7F for i in range(700))
    item = struct.pack('<II', 5, 0) + b'Title\x00Hello'
    ape_footer = lambda flags: b'APETAGEX' + struct.pack('<IIII', 2000, len(item) + 32, 1, flags) + b'\x00' * 8
    ape = ape_footer(0xA0000000) + item + ape_footer(0x80000000)
    v1 = b'TAG' + b'Junk test'.ljust(30, b'\x00') + b'\x00' * 94 + b'\xff'
    with open(os.path.join(HERE, 'junk.mp3'), 'wb') as f:
        f.write(id3 + junk + plain[:cut] + junk[:333] + plain[cut:] + ape + v1)
if want('free.mp3'):
    plain = ffout('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)':s=48000:d=0.5", *LAME, '-b:a', '128k', '-write_xing', '0',
                  '-id3v2_version', '0', '-f', 'mp3', '-')
    b = bytearray(plain)
    for p, ver, size in mp3_frames(plain):
        assert size == 384
        b[p + 2] &= 0x0F
    with open(os.path.join(HERE, 'free.mp3'), 'wb') as f:
        f.write(bytes(b))
if want('cut-off.mp3'):
    with open(os.path.join(HERE, 'song.mp3'), 'rb') as f:
        d = f.read()
    fr = mp3_frames(d)
    with open(os.path.join(HERE, 'cut-off.mp3'), 'wb') as f:
        f.write(d[:fr[200][0] + fr[200][2] // 2])
if want('song.m4a'):
    args, path = raw_input(44100, 6, 2)
    try:
        ff(*args, '-c:a', 'aac', '-b:a', '128k', '-metadata', 'title=M4A Song', '-metadata', 'artist=AAC Artist',
           '-metadata', 'album=AAC Album', '-metadata', 'date=2018', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'song.m4a')
    finally:
        os.remove(path)
if want('take.wav'):
    args, path = raw_input(16000, 2, 2)
    try:
        ff(*args, '-c:a', 'pcm_s16le', '-metadata', 'title=Take One', '-metadata', 'artist=Wave Artist', '-fflags', '+bitexact',
           '-flags:a', '+bitexact', 'take.wav')
    finally:
        os.remove(path)
if want('song.flac'):
    args, path = raw_input(22050, 2, 2)
    try:
        ff(*args, '-c:a', 'flac', '-sample_fmt', 's16', '-metadata', 'title=FLAC Song', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'song.flac')
    finally:
        os.remove(path)
if want('voice.ogg'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)':s=48000:d=3", '-c:a', 'libopus', '-b:a', '32k', '-fflags', '+bitexact', 'voice.ogg')
if want('clip.mp4'):
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=4', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t)':s=48000:d=4",
       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-fflags', '+bitexact', 'clip.mp4')
if want('surround.wav'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)|0.3*sin(2*PI*400*t)|0.3*sin(2*PI*500*t)|0|0.2*sin(2*PI*600*t)|0.2*sin(2*PI*700*t)':s=8000:d=1:c=5.1",
       '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'surround.wav')
if want('seven.wav'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)|0.3*sin(2*PI*400*t)|0.2*sin(2*PI*500*t)|0|0.1*sin(2*PI*600*t)|0.1*sin(2*PI*700*t)|0.1*sin(2*PI*800*t)|0.1*sin(2*PI*900*t)':s=8000:d=1:c=7.1",
       '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'seven.wav')
if want('hires.wav'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1000*t)':s=96000:d=0.5", '-c:a', 'pcm_s24le', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'hires.wav')
if want('ima-adpcm.wav'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)':s=16000:d=0.25", '-c:a', 'adpcm_ima_wav', '-fflags', '+bitexact', 'ima-adpcm.wav')
if want('silent.mp4'):
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-fflags', '+bitexact', 'silent.mp4')
if want('not-audio.mp3'):
    with open(os.path.join(HERE, 'not-audio.mp3'), 'w') as f:
        f.write('This is a text file with an MP3 name.\n' * 20)
if want('empty.mp3'):
    open(os.path.join(HERE, 'empty.mp3'), 'wb').close()
if want('fairplay.m4a'):
    shutil.copyfile(os.path.join(HERE, '..', 'mp4-to-mp3', 'fairplay.m4a'), os.path.join(HERE, 'fairplay.m4a'))


# ---------- expected.json: what ffprobe, ffmpeg and mutagen say ----------
def probe(name):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_format', name], check=True, cwd=HERE,
                         capture_output=True, text=True).stdout
    return json.loads(out)


def decoded(name):
    """Samples per channel and the channel count, as ffmpeg decodes the file (honouring a LAME tag)."""
    info = probe(name)
    s = [x for x in info['streams'] if x['codec_type'] == 'audio'][0]
    raw = ffout('-i', name, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-')
    return len(raw) // 4 // s['channels'], s


expected = {'tags': TAGS, 'junk_after': JUNK_AFTER}
# The byte ranges of junk.mp3's frames without the junk, for ffmpeg to decode
# as the frames are (ffmpeg drops a frame where it meets junk).
with open(os.path.join(HERE, 'junk.mp3'), 'rb') as f:
    d = f.read()
first = d.index(b'\xff\xfb')
fr = mp3_frames(d, first)
gap = fr[-1][0] + fr[-1][2]
fr2 = mp3_frames(d, gap + 333)
expected['junk_clean'] = f'{first}:{gap},{gap + 333}:{fr2[-1][0] + fr2[-1][2]}'
expected['junk_frames'] = len(fr) + len(fr2)
# song.mp3's frames of sound, without its tags and its Info frame, and how
# many: the test repeats them into an hour-long MP3.
with open(os.path.join(HERE, 'song.mp3'), 'rb') as f:
    d = f.read()
fr = mp3_frames(d)
expected['song_frames'] = [fr[1][0], fr[-1][0] + fr[-1][2], len(fr) - 1]
for name in ['song.mp3', 'vbr.mp3', 'mono64.mp3', 'low32.mp3', 'mpeg2.mp3', 'mpeg25.mp3', 'notag.mp3', 'crc.mp3', 'vbri.mp3', 'junk.mp3',
             'tags24.mp3', 'tags22.mp3', 'pngcover.mp3', 'cut-off.mp3', 'song.m4a', 'take.wav', 'song.flac', 'voice.ogg', 'clip.mp4',
             'surround.wav', 'seven.wav', 'hires.wav']:
    n, s = decoded(name)
    e = {'samples': n, 'rate': int(s['sample_rate']), 'channels': s['channels'], 'codec': s['codec_name'],
         'size': os.path.getsize(os.path.join(HERE, name))}
    if 'bit_rate' in s:
        e['bit_rate'] = int(s['bit_rate'])
    if name.endswith('.mp3'):
        with open(os.path.join(HERE, name), 'rb') as f:
            d = f.read()
        try:
            id3 = ID3(os.path.join(HERE, name))
            e['id3'] = id3.version[1]
            pics = id3.getall('APIC')
            if pics:
                e['cover_sha256'] = hashlib.sha256(pics[0].data).hexdigest()
                e['cover_mime'] = pics[0].mime
        except Exception:
            e['id3'] = 0
    expected[name] = e
with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
    json.dump(expected, f, indent=1, ensure_ascii=False)
    f.write('\n')
print('ok')
