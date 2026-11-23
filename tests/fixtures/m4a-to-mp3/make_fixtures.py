#!/usr/bin/env python3
"""Builds the sample files for tests/tools/m4a-to-mp3.test.js and writes
expected.json, the facts the test checks against, from ffprobe, ffmpeg and
mutagen.

Needs ffmpeg and ffprobe (6.x), and Python 3 with Pillow and mutagen. Run
from any folder:
    python3 tests/fixtures/m4a-to-mp3/make_fixtures.py [--all]
It makes the files that are missing and writes expected.json again from the
files there are; --all makes every file again (the same bytes each time).

Signals (amplitudes are of the sine, so RMS = amplitude / sqrt 2):
  song.m4a    3 s AAC-LC 44.1 kHz stereo at 256 kbps, like an iTunes song:
              left 440 Hz at 0.5, right 660 Hz at 0.25. Every iTunes tag the
              page keeps (TAGS below: letters outside ISO-8859-1, a
              year-only date, track 3/12, disc 1/2, composer, album artist,
              two-line lyrics, a comment) and a 1400 x 1400 JPEG cover.
  memo.m4a    6 s AAC-LC 48 kHz mono at 64 kbps, like an iPhone voice memo
              (its encoder tag reads com.apple.VoiceMemos): 300 Hz at 0.4.
  alac16.m4a  1.5 s Apple Lossless, 16-bit stereo 44.1 kHz: left 1000 Hz at
              0.5, right 1500 Hz at 0.25, with a 900 x 600 PNG cover.
  alac24.m4a  1 s Apple Lossless, 24-bit mono 48 kHz: 1000 Hz at 0.1 plus
              3000 Hz at 2^-19 (about -114 dB, below what 16 bits hold).
  alac96.m4a  0.4 s Apple Lossless, 24-bit stereo 96 kHz, 1000 Hz at 0.3:
              ffmpeg writes 0 as the MP4 sample rate, which cannot hold
              96,000; the ALAC settings hold it.
  alac51.m4a  0.3 s Apple Lossless 5.1, which the decoder cannot read.
  alac32.m4a  alac16.m4a with the bit depth in its ALAC settings changed to
              32 (ffmpeg writes only 16 and 24-bit ALAC); the decoder gives
              silence for 32-bit ALAC, so the page refuses it.
  alac-cut.m4a  3 s of 16-bit stereo ALAC (index first) cut off after 55%
              of its bytes, like a download that did not finish.
  heaac.m4a   3 s, 440 Hz at 0.25 in stereo: AAC-LC at 24 kHz whose
              AudioSpecificConfig is rewritten to explicit HE-AAC (SBR)
              signalling at 48 kHz (no SBR encoder is at hand, so the
              stream carries no SBR data: decoders output it at 48 kHz).
  book.m4b    12 s AAC-LC 22.05 kHz mono at 32 kbps, an audiobook with three
              chapters, 220 Hz at 0.4.
  adts.aac    2 s raw AAC (ADTS) 44.1 kHz stereo at 128 kbps, 550 Hz at 0.3.
  notags.m4a  0.5 s AAC 44.1 kHz mono without any tag, 330 Hz at 0.3.
  silence.m4a 0.5 s of silence, AAC 48 kHz mono at 64 kbps: the test builds
              a 5-hour audiobook in the page from copies of one of its
              packets.
  alac-fs.m4a 0.5 s of 16-bit stereo ALAC with its index first: the test
              makes it 350 MB in the page, with data after the sound, for
              the size limit on phones.
  tags.flac   0.5 s FLAC 16-bit stereo 44.1 kHz with TAGS as Vorbis
              comments, 770 Hz at 0.3.
  fairplay.m4a, bought.m4p  memo.m4a with its sample entry made Apple
              FairPlay ('drms' with a sinf box: frma mp4a, schm itun).
  audible.aax memo.m4a with its sample entry made Audible ('aavd').
  garbage.m4a song.m4a with 4,000 bytes of noise written over the middle of
              its sound data.
  picture.mp4 1 s of H.264 video with no sound track.
  not-audio.m4a  plain text with an audio name.  empty.m4a  0 bytes.
"""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys

from mutagen.mp4 import MP4
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ALL = '--all' in sys.argv[1:]
P = lambda name: os.path.join(HERE, name)


def want(name):
    return ALL or not os.path.exists(P(name))


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, cwd=HERE)


def probe(name, *extra):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', *extra, name],
                         check=True, cwd=HERE, capture_output=True, text=True).stdout
    return json.loads(out)


BITEXACT = ['-fflags', '+bitexact', '-flags:a', '+bitexact']
TAGS = {'title': 'Café 日本語 🎵', 'artist': 'Zoë Ärtist', 'album_artist': 'Various Artists', 'album': 'Ålbum',
        'composer': 'Jöhann Composer', 'date': '2019', 'track': '3/12', 'disc': '1/2', 'genre': 'Jazz',
        'comment': 'A comment ✓', 'lyrics': 'First line\nSecond line ♪'}
META = [x for k, v in TAGS.items() for x in ('-metadata', f'{k}={v}')]


def tone(expr, rate, dur):
    return ['-f', 'lavfi', '-i', f"aevalsrc='{expr}':s={rate}:d={dur}"]


# ---------- Pictures (Pillow, the same bytes each time) ----------
def make_cover_jpeg():
    im = Image.new('RGB', (1400, 1400))
    px = im.load()
    for y in range(1400):
        for x in range(1400):
            px[x, y] = (x * 255 // 1399, y * 255 // 1399, 128)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=80)
    return buf.getvalue()


def make_cover_png():
    im = Image.new('RGB', (900, 600), (40, 90, 160))
    for y in range(200, 400):
        for x in range(300, 600):
            im.putpixel((x, y), (230, 200, 40))
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


if want('cover.jpg'):
    open(P('cover.jpg'), 'wb').write(make_cover_jpeg())
if want('cover.png'):
    open(P('cover.png'), 'wb').write(make_cover_png())

# ---------- AAC ----------
if want('song.m4a'):
    ff(*tone('0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t)', 44100, 3), '-i', 'cover.jpg', '-map', '0:a', '-map', '1',
       '-c:a', 'aac', '-b:a', '256k', '-c:v', 'copy', '-disposition:v', 'attached_pic', *META, *BITEXACT, 'song.m4a')
if want('memo.m4a'):
    ff(*tone('0.4*sin(2*PI*300*t)', 48000, 6), '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
       '-metadata', 'title=New Recording 3', '-metadata', 'date=2024-05-03T10:20:30Z',
       '-metadata', 'encoder=com.apple.VoiceMemos (iPhone Version 18.1 (Build 22B83))', *BITEXACT, 'memo.m4a')
    # ffmpeg writes its own name as the encoder; the memo's goes in place of it.
    f = MP4(P('memo.m4a'))
    f['\xa9too'] = ['com.apple.VoiceMemos (iPhone Version 18.1 (Build 22B83))']
    f.save()
if want('book.m4b'):
    chapters = ';FFMETADATA1\ntitle=The Test Book\nartist=An Author\nalbum=The Test Book\ngenre=Audiobook\ndate=2021\n'
    for i, (a, b) in enumerate([(0, 4000), (4000, 8000), (8000, 12000)]):
        chapters += f'[CHAPTER]\nTIMEBASE=1/1000\nSTART={a}\nEND={b}\ntitle=Chapter {i + 1}\n'
    open(P('book-chapters.txt'), 'w').write(chapters)
    ff(*tone('0.4*sin(2*PI*220*t)', 22050, 12), '-i', 'book-chapters.txt', '-map', '0:a', '-map_metadata', '1',
       '-map_chapters', '1', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', *BITEXACT, '-f', 'ipod', 'book.m4b')
    os.remove(P('book-chapters.txt'))
if want('adts.aac'):
    ff(*tone('0.3*sin(2*PI*550*t)', 44100, 2), '-ac', '2', '-c:a', 'aac', '-b:a', '128k', *BITEXACT, 'adts.aac')
if want('notags.m4a'):
    ff(*tone('0.3*sin(2*PI*330*t)', 44100, 0.5), '-c:a', 'aac', '-b:a', '64k', '-map_metadata', '-1', *BITEXACT, 'notags.m4a')
if want('silence.m4a'):
    ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.5', '-c:a', 'aac', '-b:a', '64k', '-map_metadata', '-1',
       *BITEXACT, 'silence.m4a')
if want('alac-fs.m4a'):
    ff(*tone('0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*1500*t)', 44100, 0.5), '-c:a', 'alac', '-sample_fmt', 's16p',
       '-movflags', '+faststart', '-map_metadata', '-1', *BITEXACT, 'alac-fs.m4a')
if want('tags.flac'):
    ff(*tone('0.3*sin(2*PI*770*t)', 44100, 0.5), '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's16', *META, *BITEXACT, 'tags.flac')


def kids(buf, start, end):
    q = start
    while q + 8 <= end:
        size, typ = struct.unpack('>I4s', buf[q:q + 8])
        if size < 8:
            return
        yield q, size, typ.decode('latin1')
        q += size


def chain_to(buf, names):
    """The boxes from the top level down to names[-1]: [(offset, size)]."""
    chain, start, end = [], 0, len(buf)
    for name in names:
        for q, size, typ in kids(buf, start, end):
            if typ == name:
                chain.append((q, size))
                skip = 16 if name == 'stsd' else 36 if name in ('mp4a', 'alac') and len(chain) > 6 else 8
                start, end = q + skip, q + size
                break
        else:
            raise SystemExit('no ' + name)
    return chain


def heaac():
    ff(*tone('0.25*sin(2*PI*440*t)', 24000, 3), '-ac', '2', '-c:a', 'aac', '-b:a', '48k', *BITEXACT, 'heaac.m4a')
    buf = bytearray(open(P('heaac.m4a'), 'rb').read())
    chain = chain_to(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a', 'esds'])
    q, size = chain[-1]
    esds = bytearray(buf[q:q + size])
    i = esds.index(b'\x05\x80\x80\x80')
    old = esds[i + 4]
    # AudioObjectType 5 (SBR), core rate index 6 (24 kHz), 2 channels, SBR
    # rate index 3 (48 kHz), then the core: AudioObjectType 2 (AAC-LC) and
    # its GASpecificConfig (three 0 bits).
    bits = '00101' + '0110' + '0010' + '0011' + '00010' + '000'
    bits += '0' * (-len(bits) % 8)
    new = int(bits, 2).to_bytes(len(bits) // 8, 'big')
    d = len(new) - old
    esds[i + 4] = len(new)
    esds[i + 5:i + 5 + old] = new
    for tag in (3, 4):
        j = esds.index(bytes([tag, 0x80, 0x80, 0x80]))
        esds[j + 4] += d
    buf[q:q + size] = esds
    for b, n in chain:
        struct.pack_into('>I', buf, b, n + d)
    open(P('heaac.m4a'), 'wb').write(buf)


if want('heaac.m4a'):
    heaac()

# ---------- Apple Lossless ----------
if want('alac16.m4a'):
    ff(*tone('0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*1500*t)', 44100, 1.5), '-i', 'cover.png', '-map', '0:a', '-map', '1',
       '-c:a', 'alac', '-sample_fmt', 's16p', '-c:v', 'copy', '-disposition:v', 'attached_pic',
       '-metadata', 'title=Lossless sixteen', '-metadata', 'artist=Rip Artist', '-metadata', 'album=Rip Album',
       '-metadata', 'track=1/10', '-metadata', 'date=2005', *BITEXACT, 'alac16.m4a')
if want('alac24.m4a'):
    ff(*tone('0.1*sin(2*PI*1000*t)+pow(2,-19)*sin(2*PI*3000*t)', 48000, 1), '-c:a', 'alac', '-sample_fmt', 's32p',
       '-bits_per_raw_sample', '24', '-metadata', 'title=Lossless twenty-four', *BITEXACT, 'alac24.m4a')
if want('alac96.m4a'):
    ff(*tone('0.3*sin(2*PI*1000*t)', 96000, 0.4), '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's32p',
       '-bits_per_raw_sample', '24', *BITEXACT, 'alac96.m4a')
if want('alac51.m4a'):
    ff(*tone('0.3*sin(2*PI*440*t)', 48000, 0.3), '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0',
       '-c:a', 'alac', '-sample_fmt', 's16p', *BITEXACT, 'alac51.m4a')


def alac_cookie(buf):
    """Offset of the ALACSpecificConfig (after the 'alac' box's version and flags)."""
    q, size = chain_to(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'alac'])[-1]
    for c, csize, typ in kids(buf, q + 36, q + size):
        if typ == 'alac':
            return c + 12
    raise SystemExit('no ALAC settings')


if want('alac32.m4a'):
    buf = bytearray(open(P('alac16.m4a'), 'rb').read())
    buf[alac_cookie(buf) + 5] = 32
    open(P('alac32.m4a'), 'wb').write(buf)
if want('alac-cut.m4a'):
    ff(*tone('0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*1500*t)', 44100, 3), '-c:a', 'alac', '-sample_fmt', 's16p',
       '-movflags', '+faststart', *BITEXACT, 'alac-full.m4a')
    data = open(P('alac-full.m4a'), 'rb').read()
    open(P('alac-cut.m4a'), 'wb').write(data[:int(len(data) * 0.55)])
    os.remove(P('alac-full.m4a'))


# ---------- Protected and damaged ----------
def protect(src, dst, entry, sinf):
    """src (index after the sound, so chunk offsets stay valid) with its 'mp4a'
    sample entry renamed entry; with sinf, a FairPlay-like protection box
    (frma mp4a, schm itun, schi) is added inside it."""
    buf = bytearray(open(P(src), 'rb').read())
    chain = chain_to(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a'])
    q, size = chain[-1]
    buf[q + 4:q + 8] = entry.encode()
    add = b''
    if sinf:
        frma = struct.pack('>I4s4s', 12, b'frma', b'mp4a')
        schm = struct.pack('>I4sI4sI', 20, b'schm', 0, b'itun', 0)
        schi = struct.pack('>I4s', 32, b'schi') + struct.pack('>I4sI', 12, b'user', 0x12345678) + struct.pack('>I4sI', 12, b'key ', 1)
        add = struct.pack('>I4s', 8 + len(frma) + len(schm) + len(schi), b'sinf') + frma + schm + schi
    buf[q + size:q + size] = add
    for b, n in chain:
        struct.pack_into('>I', buf, b, n + len(add))
    open(P(dst), 'wb').write(buf)


if want('fairplay.m4a'):
    protect('memo.m4a', 'fairplay.m4a', 'drms', True)
if want('bought.m4p'):
    protect('memo.m4a', 'bought.m4p', 'drms', True)
if want('audible.aax'):
    protect('memo.m4a', 'audible.aax', 'aavd', False)
if want('garbage.m4a'):
    buf = bytearray(open(P('song.m4a'), 'rb').read())
    q, size = [(q, s) for q, s, t in kids(buf, 0, len(buf)) if t == 'mdat'][0]
    mid = q + size // 2
    noise = hashlib.sha256(b'garbage').digest() * 125
    buf[mid:mid + 4000] = noise
    open(P('garbage.m4a'), 'wb').write(buf)
if want('picture.mp4'):
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', *BITEXACT, 'picture.mp4')
if want('not-audio.m4a'):
    open(P('not-audio.m4a'), 'w').write('This is a text file with an audio name.\n' * 20)
if want('empty.m4a'):
    open(P('empty.m4a'), 'wb').close()


# ---------- expected.json ----------
def kbps(name):
    """Bits per second of the first 10 s of packets, the last one left out,
    as the page measures a bitrate the file does not state."""
    pk = probe(name, '-select_streams', 'a:0', '-show_entries', 'packet=pts_time,size', '-read_intervals', '%+12')['packets']
    pk = [p for p in pk if p.get('pts_time') not in (None, 'N/A')]
    first, use = float(pk[0]['pts_time']), []
    for p in pk:
        use.append(p)
        if float(p['pts_time']) >= first + 10:
            break
    span = float(use[-1]['pts_time']) - first
    total = sum(int(p['size']) for p in use[:-1])
    return round(total * 8 / span / 1000) if span > 0 else 0


def decoded_samples(name, rate=None):
    args = ['ffmpeg', '-v', 'error', '-i', name] + (['-ar', str(rate)] if rate else []) + ['-f', 's16le', '-ac', '1', '-']
    out = subprocess.run(args, check=True, cwd=HERE, capture_output=True).stdout
    return len(out) // 2  # s16, one channel


facts = {}
for name in ['song.m4a', 'memo.m4a', 'alac16.m4a', 'alac24.m4a', 'alac96.m4a', 'alac51.m4a', 'alac-cut.m4a', 'alac-fs.m4a',
             'heaac.m4a', 'book.m4b', 'adts.aac', 'notags.m4a', 'tags.flac']:
    st = [s for s in probe(name, '-show_streams')['streams'] if s['codec_type'] == 'audio'][0]
    f = {'codec': st['codec_name'], 'rate': int(st['sample_rate']), 'channels': st['channels'],
         'bits': int(st.get('bits_per_raw_sample') or 0), 'decoded': decoded_samples(name)}
    # The samples a player gives: an MP4's edit list trims the AAC encoder's
    # priming and padding (ffmpeg 6 trims only the priming when it decodes,
    # so its count is longer); raw AAC and FLAC have no edit list.
    f['samples'] = round(float(st['duration']) * f['rate']) if name.endswith(('.m4a', '.m4b')) else f['decoded']
    f['kbps'] = kbps(name)
    facts[name] = f
for name in ['cover.jpg', 'cover.png']:
    data = open(P(name), 'rb').read()
    im = Image.open(io.BytesIO(data))
    facts[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'width': im.width, 'height': im.height}
facts['tags'] = TAGS
with open(P('expected.json'), 'w') as fh:
    json.dump(facts, fh, indent=1, ensure_ascii=False, sort_keys=True)
    fh.write('\n')
print('\n'.join(f'{n}: {os.path.getsize(P(n))}' for n in sorted(os.listdir(HERE)) if not n.endswith(('.py', '.json'))))
