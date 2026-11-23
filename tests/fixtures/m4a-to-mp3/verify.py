#!/usr/bin/env python3
"""Checks a file that /m4a-to-mp3/ wrote, with tools that share no code with
the page: ffprobe, ffmpeg (which honours an MP3's LAME tag, as gapless
players do), numpy, mutagen and Pillow. Prints the facts as JSON for
tests/tools/m4a-to-mp3.test.js.

    python3 verify.py mp3 OUT.mp3 [SOURCE]   stream, frames, sound, tags
    python3 verify.py wav OUT.wav [SOURCE]   stream, sound, tags; with SOURCE,
                                             the samples against ffmpeg's
                                             decode of it
    python3 verify.py zip OUT.zip            entry names, sizes, SHA-256
    python3 verify.py src FILE               rate, channels and length of a
                                             sample the page reads
"""
import hashlib
import io
import json
import struct
import subprocess
import sys
import zipfile

import numpy as np
from mutagen.id3 import ID3
from PIL import Image


def ffprobe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_format', path],
                         check=True, capture_output=True, text=True).stdout
    d = json.loads(out)
    s = [x for x in d['streams'] if x['codec_type'] == 'audio'][0]
    return {'codec': s['codec_name'], 'rate': int(s['sample_rate']), 'channels': s['channels'],
            'bitRate': int(s.get('bit_rate') or 0), 'bitsPerSample': int(s.get('bits_per_sample') or 0),
            'duration': float(s.get('duration') or 0), 'format': d['format']['format_name']}


def decode(path, fmt='f32le', channels=None):
    args = ['ffmpeg', '-v', 'error', '-i', path] + (['-ac', str(channels)] if channels else []) + ['-f', fmt, '-']
    raw = subprocess.run(args, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype={'f32le': '<f4', 's32le': '<i4'}[fmt])


def sound(path, channels):
    x = decode(path, channels=channels).reshape(-1, channels).astype(np.float64)
    n = len(x)
    out = {'samples': n, 'rms': [], 'freq': [], 'peak': float(np.max(np.abs(x))) if n else 0.0}
    rate = ffprobe(path)['rate']
    for c in range(channels):
        y = x[:, c]
        mid = y[n // 4: n - n // 4] if n > 8192 else y
        out['rms'].append(round(float(np.sqrt(np.mean(mid ** 2))), 4) if len(mid) else 0.0)
        if len(mid) >= 1024:
            w = mid * np.hanning(len(mid))
            spec = np.abs(np.fft.rfft(w))
            k = int(np.argmax(spec[1:])) + 1
            out['freq'].append(round(k * rate / len(mid), 1))
        else:
            out['freq'].append(0.0)
    return out


def text_of(frame):
    t = getattr(frame, 'text', '')
    return t if isinstance(t, str) else '\n'.join(str(x) for x in t)


def id3_facts(data):
    """The ID3v2 tag at the start of data, read with mutagen as stored (no
    upgrade of v2.3 frames to v2.4)."""
    if data[:3] != b'ID3':
        return None
    size = (data[6] & 127) << 21 | (data[7] & 127) << 14 | (data[8] & 127) << 7 | (data[9] & 127)
    # Only the ID3v2 tag: mutagen would also read an ID3v1 tag at the end.
    tag = ID3(io.BytesIO(data[:10 + size]), translate=False)
    frames = {}
    pictures = []
    for f in tag.values():
        if f.FrameID == 'APIC':
            im = Image.open(io.BytesIO(f.data))
            pictures.append({'mime': f.mime, 'type': int(f.type), 'desc': f.desc, 'sha256': hashlib.sha256(f.data).hexdigest(),
                             'bytes': len(f.data), 'format': im.format, 'width': im.width, 'height': im.height})
        elif f.FrameID in ('COMM', 'USLT'):
            frames.setdefault(f.FrameID, []).append({'lang': f.lang, 'desc': f.desc, 'text': text_of(f), 'encoding': int(f.encoding)})
        else:
            frames[f.FrameID] = {'text': text_of(f), 'encoding': int(getattr(f, 'encoding', 0))}
    # size: the whole tag, its 10-byte header included.
    return {'version': [tag.version[1], tag.version[2]], 'size': 10 + size, 'frames': frames, 'pictures': pictures}


def id3v1(data):
    if len(data) < 128 or data[-128:-125] != b'TAG':
        return None
    t = data[-128:]
    s = lambda a, b: t[a:b].split(b'\0')[0].decode('latin1').rstrip(' ')
    return {'title': s(3, 33), 'artist': s(33, 63), 'album': s(63, 93), 'year': s(93, 97), 'comment': s(97, 125),
            'track': t[126] if t[125] == 0 else 0, 'genre': t[127]}


BITRATES = {1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
            2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def mp3_frames(data, start):
    """Layer III frame headers from start: bitrates, rates and modes seen,
    and the frame count (the first, an Info or Xing frame, counted too)."""
    p, kbps, rates, modes, count, info = start, set(), set(), set(), 0, ''
    end = len(data) - (128 if data[-128:-125] == b'TAG' else 0)
    while p + 4 <= end:
        h = struct.unpack('>I', data[p:p + 4])[0]
        if h >> 21 != 0x7FF:
            break
        ver = (h >> 19) & 3
        br = BITRATES[1 if ver == 3 else 2][(h >> 12) & 15]
        sr = RATES[ver][(h >> 10) & 3]
        pad = (h >> 9) & 1
        size = (144 if ver == 3 else 72) * br * 1000 // sr + pad
        if count == 0:
            info = 'Info' if b'Info' in data[p:p + 64] else 'Xing' if b'Xing' in data[p:p + 64] else ''
        kbps.add(br)
        rates.add(sr)
        modes.add('mono' if (h >> 6) & 3 == 3 else 'stereo')
        count += 1
        p += size
    return {'kbps': sorted(kbps), 'rates': sorted(rates), 'modes': sorted(modes), 'frames': count, 'info': info, 'end': p, 'fileEnd': end}


def mp3(path, src=None):
    data = open(path, 'rb').read()
    tag = id3_facts(data)
    start = tag['size'] if tag else 0
    st = ffprobe(path)
    out = {'stream': st, 'id3': tag, 'id3v1': id3v1(data), 'frames': mp3_frames(data, start), 'bytes': len(data)}
    out['sound'] = sound(path, st['channels'])
    return out


def riff_chunks(data):
    out, p = [], 12
    while p + 8 <= len(data):
        cid, size = data[p:p + 4].decode('latin1'), struct.unpack('<I', data[p + 4:p + 8])[0]
        out.append((cid, p + 8, size))
        p += 8 + size + (size & 1)
    return out


def wav(path, src=None):
    data = open(path, 'rb').read()
    st = ffprobe(path)
    out = {'stream': st, 'riff': data[:4].decode('latin1'), 'chunks': [], 'info': {}, 'id3': None, 'bytes': len(data)}
    for cid, at, size in riff_chunks(data):
        out['chunks'].append(cid)
        body = data[at:at + size]
        if cid == 'fmt ':
            out['fmt'] = dict(zip(['tag', 'channels', 'rate', 'byteRate', 'blockAlign', 'bits'], struct.unpack('<HHIIHH', body[:16])))
        elif cid == 'data':
            out['dataBytes'] = size
        elif cid == 'LIST' and body[:4] == b'INFO':
            q = 4
            while q + 8 <= len(body):
                k, n = body[q:q + 4].decode('latin1'), struct.unpack('<I', body[q + 4:q + 8])[0]
                out['info'][k] = body[q + 8:q + 8 + n].split(b'\0')[0].decode('utf-8')
                q += 8 + n + (n & 1)
        elif cid in ('id3 ', 'ID3 '):
            out['id3'] = id3_facts(body)
    block = out['fmt']['blockAlign']
    out['samples'] = out.get('dataBytes', 0) // block
    out['sound'] = sound(path, st['channels'])
    if src:
        a, b = decode(src, 's32le'), decode(path, 's32le')
        n = min(len(a), len(b))
        out['vsSource'] = {'sourceSamples': len(a) // st['channels'], 'outSamples': len(b) // st['channels'],
                           'identical': bool(len(a) == len(b) and np.array_equal(a, b)),
                           'identicalPrefix': bool(n > 0 and np.array_equal(a[:n], b[:n])),
                           'maxDiff': float(np.max(np.abs(a[:n].astype(np.int64) - b[:n].astype(np.int64))) / 2 ** 31) if n else 0.0}
    return out


def src_facts(path, src=None):
    """An MP4's edit list sets its length (ffmpeg 6 trims only the AAC
    priming when it decodes); other files are as long as they decode, an MP3
    as its LAME tag says."""
    st = ffprobe(path)
    mp4 = 'mp4' in st['format'] or 'mov' in st['format']
    samples = round(st['duration'] * st['rate']) if mp4 else len(decode(path, channels=1))
    return {'rate': st['rate'], 'channels': st['channels'], 'codec': st['codec'], 'samples': samples}


def zip_facts(path):
    z = zipfile.ZipFile(path)
    return {'bad': z.testzip(), 'entries': [{'name': i.filename, 'size': i.file_size, 'method': i.compress_type,
                                            'sha256': hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]}


if __name__ == '__main__':
    kind, path = sys.argv[1], sys.argv[2]
    src = sys.argv[3] if len(sys.argv) > 3 else None
    print(json.dumps({'mp3': mp3, 'wav': wav, 'src': src_facts, 'zip': lambda p, s=None: zip_facts(p)}[kind](path, src)))
