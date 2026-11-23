#!/usr/bin/env python3
"""Builds the sample files for tests/tools/mp4-to-mp3.test.js and writes
expected.json, the facts the test checks against, as ffprobe reports them.

Needs ffmpeg and ffprobe (6.x). Run from any folder:
    python3 tests/fixtures/mp4-to-mp3/make_fixtures.py [--all]
It makes the files that are missing and writes expected.json again from the
files there are; --all makes every file again. (The Matroska and WebM files
and protected.mp4 come out with other bytes each time, from random IDs and
keys, though the facts in expected.json stay the same.)

Signals (amplitudes are of the sine, so RMS = amplitude / sqrt 2):
  clip.mp4   6 s, H.264 64x36 + AAC-LC 48 kHz stereo 128 kbps. Left 0.5 and
             right 0.25 of the same tone: 440 Hz for 0-2 s, 660 Hz for 2-4 s,
             880 Hz for 4-6 s. Title "Fixture clip", artist "Test Artist".
  phone.mov  2 s QuickTime, H.264 + AAC-LC 44.1 kHz mono, 523.25 Hz at 0.4.
  voice.webm 3 s Opus mono 48 kHz, 300 Hz at 0.4, no video.
  chirp.wav  1 s PCM s16le 44.1 kHz stereo; left a chirp 200 Hz + 2000 Hz/s,
             right the same at half amplitude, so no two windows match.
  dolby.mkv  2 s AC-3 stereo 48 kHz (Chromium cannot decode AC-3).
  two-langs.mkv  2 s, two Opus tracks: English 440 Hz, French 880 Hz.
  protected.mp4  2 s AAC with CENC (cenc-aes-ctr) encryption, like DRM.
  silent-video.mp4  1 s of H.264 with no audio track.
  not-media.mp4  plain text with a video name.
  cut-short.mp4  clip.mp4 with its index moved to the front, cut off after
             50,000 bytes, like a copy or download that did not finish: the
             index lists 6 s of sound, the data holds less than 3 s.
  cover.m4a  1 s of AAC 44.1 kHz mono, 440 Hz, with a 32x32 JPEG cover and
             the title "Cover test".
  long-claim.m4a  0.1 s of AAC whose sample table claims 61.5 minutes, for
             the length limit of browsers that decode a whole track at once.
  tags.m4a   0.5 s of AAC 44.1 kHz mono, 330 Hz, with every iTunes tag the
             MP3 writer keeps (TAGS below: letters outside ISO-8859-1, a
             year-only date, track 3/12, disc 1/2, composer, two-line
             lyrics) and a 48x32 JPEG cover.
  fairplay.m4a, audible.m4b  tags.m4a with its sample entry made Apple
             FairPlay ('drms' with a sinf box: frma mp4a, schm itun) and
             Audible ('aavd'); mediabunny calls both decodable AAC.
  info-utf8.wav  0.1 s of 8 kHz PCM whose RIFF INFO text ffmpeg wrote in
             UTF-8; info-1252.wav the same with INFO text in Windows-1252.
  tags-v22.mp3, tags-v23.mp3, tags-v24.mp3  0.5 s MP3s with ID3v2.2 (made
             here), v2.3 (with the full date 2019-05-03) and v2.4 tags
             (ffmpeg); tags.flac the same tags as Vorbis comments.

expected.json also holds, as 'kbps', the bitrate of each audio stream of
the files whose card shows one, from ffprobe's packets of the first 10 s.
"""
import hashlib
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ALL = '--all' in sys.argv[1:]


def want(name):
    """True when name is to be made: it is missing, or --all was given."""
    return ALL or not os.path.exists(os.path.join(HERE, name))


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, cwd=HERE)


def probe(name, *extra):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', *extra, name],
                         check=True, cwd=HERE, capture_output=True, text=True).stdout
    return json.loads(out)


TONE = "if(lt(t,2),440,if(lt(t,4),660,880))"
# Phase as the integral of the stepped frequency, so the tone is continuous.
PHASE = "if(lt(t,2),440*t,if(lt(t,4),880+660*(t-2),2200+880*(t-4)))"
VIDEO = ['-f', 'lavfi', '-i', 'color=c=0x1f6f4a:s=64x36:r=5']
X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '10']

if want('clip.mp4'):
    ff(*VIDEO, '-f', 'lavfi', '-i',
       f"aevalsrc='0.5*sin(2*PI*({PHASE}))|0.25*sin(2*PI*({PHASE}))':s=48000:d=6",
       '-t', '6', *X264, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
       '-metadata', 'title=Fixture clip', '-metadata', 'artist=Test Artist',
       '-shortest', 'clip.mp4')
if want('phone.mov'):
    ff(*VIDEO, '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*523.25*t)':s=44100:d=2",
       '-t', '2', *X264, '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-shortest', '-f', 'mov', 'phone.mov')
if want('voice.webm'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)':s=48000:d=3",
       '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', 'voice.webm')
if want('chirp.wav'):
    ff('-f', 'lavfi', '-i',
       "aevalsrc='0.6*sin(2*PI*(200*t+1000*t*t))|0.3*sin(2*PI*(200*t+1000*t*t))':s=44100:d=1",
       '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'chirp.wav')
if want('dolby.mkv'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)|0.4*sin(2*PI*440*t)':s=48000:d=2",
       '-c:a', 'ac3', '-b:a', '192k', 'dolby.mkv')
if want('two-langs.mkv'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=48000:d=2",
       '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*880*t)':s=48000:d=2",
       '-map', '0:a', '-map', '1:a', '-c:a', 'libopus', '-b:a', '48k',
       '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra',
       '-metadata:s:a:1', 'title=Commentaire', 'two-langs.mkv')
if want('protected.mp4'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=48000:d=2",
       '-c:a', 'aac', '-b:a', '96k', '-encryption_scheme', 'cenc-aes-ctr',
       '-encryption_key', '00112233445566778899aabbccddeeff',
       '-encryption_kid', '0123456789abcdef0123456789abcdef', 'protected.mp4')
if want('silent-video.mp4'):
    ff(*VIDEO, '-t', '1', *X264, 'silent-video.mp4')
if want('not-media.mp4'):
    with open(os.path.join(HERE, 'not-media.mp4'), 'w') as f:
        f.write('This is a text file with a video name, not a video.\n')
if want('cut-short.mp4'):
    ff('-i', 'clip.mp4', '-c', 'copy', '-movflags', '+faststart', 'cut-short.mp4')
    with open(os.path.join(HERE, 'cut-short.mp4'), 'r+b') as f:
        f.truncate(50000)
# Made every time (the same bytes each time): expected.json holds its SHA-256.
ff('-f', 'lavfi', '-i', 'color=c=0xc81e3c:s=32x32', '-frames:v', '1', 'cover.jpg')
if want('cover.m4a'):
    ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=44100:d=1", '-i', 'cover.jpg',
       '-map', '0:a', '-map', '1', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-c:v', 'copy',
       '-disposition:v', 'attached_pic', '-metadata', 'title=Cover test', 'cover.m4a')


def boxes(buf, off, end):
    while off + 8 <= end:
        size, typ = struct.unpack('>I4s', buf[off:off + 8])
        yield off, size, typ.decode('latin1')
        if typ in (b'moov', b'trak', b'mdia', b'minf', b'stbl', b'edts'):
            yield from boxes(buf, off + 8, off + size)
        off += size


LONG_MS = 3690000  # 61.5 minutes


def long_claim():
    ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)':s=48000:d=0.1", '-c:a', 'aac', '-b:a', '32k',
       '-ac', '1', '-fflags', '+bitexact', '-map_metadata', '-1', 'long-claim.m4a')
    with open(os.path.join(HERE, 'long-claim.m4a'), 'rb') as f:
        buf = bytearray(f.read())
    for off, size, typ in boxes(buf, 0, len(buf)):
        if typ == 'stts':
            n = struct.unpack('>I', buf[off + 12:off + 16])[0]
            last = off + 16 + (n - 1) * 8
            count, delta = struct.unpack('>II', buf[last:last + 8])
            assert count == 1
            frames = sum(struct.unpack('>I', buf[off + 16 + i * 8:off + 20 + i * 8])[0] *
                         struct.unpack('>I', buf[off + 20 + i * 8:off + 24 + i * 8])[0] for i in range(n - 1))
            struct.pack_into('>I', buf, last + 4, LONG_MS * 48 - frames)
        elif typ == 'mdhd':
            struct.pack_into('>I', buf, off + 24, LONG_MS * 48)
        elif typ in ('mvhd', 'tkhd'):
            struct.pack_into('>I', buf, off + (24 if typ == 'mvhd' else 28), LONG_MS)
        elif typ == 'elst':
            struct.pack_into('>I', buf, off + 16, LONG_MS)
    with open(os.path.join(HERE, 'long-claim.m4a'), 'wb') as f:
        f.write(buf)


if want('long-claim.m4a'):
    long_claim()


# ---------- Tags, protected entries and character sets ----------
# The tags of tags.m4a, tags-v2x.mp3 and tags.flac: letters outside
# ISO-8859-1 (CJK, an emoji, a check mark), a year-only date, two-line lyrics.
TAGS = {'title': 'Café 日本語 🎵', 'artist': 'Zoë Ärtist', 'album_artist': 'Various Artists', 'album': 'Ålbum',
        'composer': 'Jöhann Composer', 'date': '2019', 'track': '3/12', 'disc': '1/2', 'genre': 'Jazz',
        'comment': 'A comment ✓', 'lyrics': 'First line\nSecond line ♪'}
META = [x for k, v in TAGS.items() for x in ('-metadata', f'{k}={v}')]
SHORT = ['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*330*t)':s=44100:d=0.5"]
# Made every time (the same bytes each time): expected.json holds its SHA-256.
ff('-f', 'lavfi', '-i', 'testsrc=size=48x32:rate=1', '-frames:v', '1', 'cover2.jpg')
if want('tags.m4a'):
    ff(*SHORT, '-i', 'cover2.jpg', '-map', '0:a', '-map', '1', '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
       '-c:v', 'copy', '-disposition:v', 'attached_pic', *META, '-fflags', '+bitexact', 'tags.m4a')


def protect(src, dst, entry, sinf):
    """A copy of src (moov after mdat, so chunk offsets stay valid) whose
    'mp4a' sample entry is renamed entry; with sinf, a FairPlay-like
    protection box (frma mp4a, schm itun, schi) is added inside it."""
    with open(os.path.join(HERE, src), 'rb') as f:
        buf = bytearray(f.read())

    def kids(start, end):
        q = start
        while q + 8 <= end:
            size, typ = struct.unpack('>I4s', buf[q:q + 8])
            yield q, size, typ.decode('latin1')
            q += size
    chain, start, end = [], 0, len(buf)
    for name in ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a']:
        for q, size, typ in kids(start, end):
            if typ == name:
                chain.append((q, size))
                start, end = q + 8 + (8 if name == 'stsd' else 0), q + size
                break
        else:
            raise SystemExit('no ' + name + ' in ' + src)
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
    with open(os.path.join(HERE, dst), 'wb') as f:
        f.write(buf)


if want('fairplay.m4a'):
    protect('tags.m4a', 'fairplay.m4a', 'drms', True)
if want('audible.m4b'):
    protect('tags.m4a', 'audible.m4b', 'aavd', False)

PCM8K = ['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)':s=8000:d=0.1", '-c:a', 'pcm_s16le']
INFO_UTF8 = {'title': 'Café Ünïcödé', 'artist': 'Zoë', 'comment': 'Crème brûlée'}
if want('info-utf8.wav'):
    ff(*PCM8K, *[x for k, v in INFO_UTF8.items() for x in ('-metadata', f'{k}={v}')], '-fflags', '+bitexact',
       '-flags:a', '+bitexact', 'info-utf8.wav')
INFO_1252 = {'INAM': 'Café – Crème brûlée', 'IART': 'Zoë Ärtist', 'ICMT': '€5 “quoted”'}
if want('info-1252.wav'):
    pcm = subprocess.run(['ffmpeg', '-v', 'error', *PCM8K[:4], '-f', 's16le', '-'], cwd=HERE, capture_output=True, check=True).stdout
    fmt = struct.pack('<HHIIHH', 1, 1, 8000, 16000, 2, 16)
    info = b'INFO'
    for k, v in INFO_1252.items():
        b = v.encode('cp1252') + b'\0'
        info += k.encode() + struct.pack('<I', len(b)) + b + (b'\0' if len(b) % 2 else b'')
    body = b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'LIST' + struct.pack('<I', len(info)) + info
    body += b'data' + struct.pack('<I', len(pcm)) + pcm
    with open(os.path.join(HERE, 'info-1252.wav'), 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(body)) + body)

MP3 = [*SHORT, '-c:a', 'libmp3lame', '-b:a', '32k', '-ac', '1', '-fflags', '+bitexact', '-flags:a', '+bitexact']
if want('tags-v24.mp3'):
    ff(*MP3, *META, 'tags-v24.mp3')
if want('tags-v23.mp3'):
    ff(*MP3, *[x if not x.startswith('date=') else 'date=2019-05-03' for x in META], '-id3v2_version', '3', 'tags-v23.mp3')


def id3v22(frames):
    """An ID3v2.2 tag: 3-letter frame ids and 3-byte sizes."""
    body = b''
    for fid, data in frames:
        body += fid.encode() + len(data).to_bytes(3, 'big') + data
    n = len(body)
    return b'ID3\x02\x00\x00' + bytes([n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127]) + body


V22 = {'TT2': 'Ôld Title', 'TP1': 'Old Artist', 'TAL': 'Old Album', 'TCM': 'Old Composer', 'TYE': '1999', 'TRK': '5/9', 'TCO': 'Rock'}
if want('tags-v22.mp3'):
    plain = subprocess.run(['ffmpeg', '-v', 'error', *MP3, '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3', '-'],
                           cwd=HERE, capture_output=True, check=True).stdout
    frames = [(k, b'\x00' + v.encode('latin1')) for k, v in V22.items()]
    with open(os.path.join(HERE, 'tags-v22.mp3'), 'wb') as f:
        f.write(id3v22(frames) + plain)
if want('tags.flac'):
    ff(*SHORT, '-ar', '8000', '-c:a', 'flac', *META, '-fflags', '+bitexact', '-flags:a', '+bitexact', 'tags.flac')

expected = {}
for name in ['clip.mp4', 'phone.mov', 'voice.webm', 'chirp.wav', 'dolby.mkv', 'two-langs.mkv', 'protected.mp4', 'long-claim.m4a']:
    info = probe(name, '-show_streams', '-show_format')
    streams = [s for s in info['streams'] if s['codec_type'] == 'audio']
    expected[name] = {
        'size': os.path.getsize(os.path.join(HERE, name)),
        'duration': float(info['format']['duration']),
        'audio': [{'codec': s['codec_name'], 'sample_rate': int(s['sample_rate']), 'channels': s['channels'],
                   'language': s.get('tags', {}).get('language')} for s in streams],
    }
# The AAC packets of clip.mp4, to show that "Original audio" copies them
# byte for byte.
pk = probe('clip.mp4', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'SHA256')
expected['clip.mp4']['packets'] = [{'pts': float(p['pts_time']), 'dur': float(p['duration_time']),
                                     'size': int(p['size']), 'sha256': p['data_hash'].split(':', 1)[1]}
                                    for p in pk['packets']]


def incomplete_and_cover():
    """cut-short.mp4: the samples ffmpeg can decode from what is left (its
    index still claims 6 s). cover.m4a: the SHA-256 of the JPEG inside it."""
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'cut-short.mp4', '-map', '0:a', '-f', 's16le', '-'],
                         cwd=HERE, capture_output=True, check=True).stdout
    out = {'cut-short.mp4': {'size': os.path.getsize(os.path.join(HERE, 'cut-short.mp4')),
                             'listed_duration': float(probe('cut-short.mp4', '-show_format')['format']['duration']),
                             'decoded_samples': len(pcm) // 4}}
    with open(os.path.join(HERE, 'cover.jpg'), 'rb') as f:
        out['cover.m4a'] = {'size': os.path.getsize(os.path.join(HERE, 'cover.m4a')),
                            'jpeg_sha256': hashlib.sha256(f.read()).hexdigest()}
    os.remove(os.path.join(HERE, 'cover.jpg'))
    return out


def peak_db(name, start=None, end=None):
    """Overall peak of the decoded audio in dBFS, as ffmpeg's astats reports it."""
    af = (f'atrim={start}:{end},' if start is not None else '') + 'astats=metadata=0'
    err = subprocess.run(['ffmpeg', '-hide_banner', '-i', name, '-af', af, '-f', 'null', '-'],
                         cwd=HERE, capture_output=True, text=True).stderr
    overall = err.split('Overall')[-1]
    return float(overall.split('Peak level dB:')[1].split()[0])


expected['clip.mp4']['peak_db'] = peak_db('clip.mp4')
expected['clip.mp4']['peak_db_4.5_5.5'] = peak_db('clip.mp4', 4.5, 5.5)
expected['clip.mp4']['bit_rate'] = int(probe('clip.mp4', '-show_streams', '-select_streams', 'a:0')['streams'][0]['bit_rate'])
# chirp.wav: where its samples start, so the test can compare them exactly.
with open(os.path.join(HERE, 'chirp.wav'), 'rb') as f:
    data = f.read()
expected['chirp.wav']['data_offset'] = data.index(b'data') + 8
expected['chirp.wav']['sha256'] = hashlib.sha256(data).hexdigest()
expected.update(incomplete_and_cover())


def kbps(name):
    """Kilobits a second of each audio stream from its packets in the first
    10 s, leaving out the last packet read, as the page measures it."""
    info = probe(name, '-show_packets', '-show_streams')
    out = []
    for st in info['streams']:
        if st['codec_type'] != 'audio':
            continue
        pk = sorted((p for p in info['packets'] if p['stream_index'] == st['index']), key=lambda p: float(p['pts_time']))
        t0, end = float(pk[0]['pts_time']), len(pk) - 1
        for i, p in enumerate(pk):
            if i and float(p['pts_time']) >= t0 + 10:
                end = i
                break
        out.append(round(sum(int(p['size']) for p in pk[:end]) * 8 / (float(pk[end]['pts_time']) - t0) / 1000, 3))
    return out


for name in ['tags.m4a', 'fairplay.m4a', 'audible.m4b', 'info-utf8.wav', 'info-1252.wav', 'tags-v22.mp3', 'tags-v23.mp3',
             'tags-v24.mp3', 'tags.flac']:
    expected[name] = {'size': os.path.getsize(os.path.join(HERE, name))}
for name in ['clip.mp4', 'phone.mov', 'voice.webm', 'dolby.mkv', 'two-langs.mkv', 'long-claim.m4a', 'tags.m4a']:
    expected[name]['kbps'] = kbps(name)
with open(os.path.join(HERE, 'cover2.jpg'), 'rb') as f:
    expected['tags.m4a']['jpeg_sha256'] = hashlib.sha256(f.read()).hexdigest()
os.remove(os.path.join(HERE, 'cover2.jpg'))
expected['tags.m4a']['tags'] = TAGS
expected['tags-v22.mp3']['tags'] = V22
expected['info-utf8.wav']['info'] = INFO_UTF8
expected['info-1252.wav']['info'] = INFO_1252
with open(os.path.join(HERE, 'expected.json'), 'w') as f:
    json.dump(expected, f, indent=1, ensure_ascii=False)
    f.write('\n')
print('ok', {k: v['size'] for k, v in expected.items()})
