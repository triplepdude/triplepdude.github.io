#!/usr/bin/env python3
"""Checks a file that tests/tools/mp3-cutter.test.js downloaded, with tools
that share no code with the page: ffprobe for the stream, ffmpeg's decoder
(which honours the LAME tag's delay and padding, and an MP4 edit list's
start) with numpy for the samples, mutagen for the tags, and a LAME tag and
MP4 box reader written here. Prints one JSON object.

    verify.py facts OUT                      what the file is
    verify.py cut OUT SRC START END [CLEAN]  OUT against samples START to END
                                             (per channel) of SRC as ffmpeg
                                             decodes it; CLEAN: byte ranges
                                             a:b,c:d of SRC put together to
                                             decode instead (an MP3 without
                                             its junk)
    verify.py join OUT SRC A B C D XF         OUT against SRC's samples A..B then
                                             C..D, crossfaded over XF samples
                                             centred on the join (XF 0: none)
    verify.py fade OUT SRC START END FI FO VOL  OUT against SRC's samples START
                                             to END with linear fades of FI and
                                             FO samples and a gain of VOL
    verify.py packets FILE                   the SHA-256 of each audio packet
    verify.py zip ZIP                        the names and sizes of its entries

"facts" holds: codec, profile, rate, channels, bit_rate, duration (ffprobe),
samples (ffmpeg's decode), rms per channel, peak, the LAME tag (MP3), the
ID3v2 version, frames and cover SHA-256, the ID3v1 tag, the MP4 tags and
the movie, track and edit list durations (M4A), the RIFF INFO tags (WAV).
"cut" and "join" add: want (samples expected), diff (largest difference of
a sample, when the lengths match), snr (dB, for lossy outputs) and the lag
at which the output lines up best with what was expected.
"""
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile

import numpy as np


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def probe(path):
    return json.loads(run('ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_format', path))


def decode(path, channels=None):
    """float32 [n, channels] as ffmpeg decodes the first audio stream."""
    if channels is None:
        channels = [s for s in probe(path)['streams'] if s['codec_type'] == 'audio'][0]['channels']
    raw = run('ffmpeg', '-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-')
    return np.frombuffer(raw, dtype='<f4').reshape(-1, channels)


def crc16(data, crc=0):
    """CRC-16/ARC, as the LAME tag uses it."""
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


KB = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]}
KB[2] = KB[0] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def lame(d):
    """The Xing/Info frame and LAME tag at the start of an MP3's frames."""
    p = 0
    while d[p:p + 3] == b'ID3':
        p += 10 + ((d[p + 6] & 127) << 21 | (d[p + 7] & 127) << 14 | (d[p + 8] & 127) << 7 | d[p + 9] & 127) + (10 if d[p + 5] & 16 else 0)
    if d[p] != 0xFF or d[p + 1] & 0xE0 != 0xE0:
        return None
    ver, crc, mode = d[p + 1] >> 3 & 3, not (d[p + 1] & 1), d[p + 3] >> 6
    side = (17 if mode == 3 else 32) if ver == 3 else (9 if mode == 3 else 17)
    size = (144000 if ver == 3 else 72000) * KB[ver][d[p + 2] >> 4] // RATES[ver][d[p + 2] >> 2 & 3] + (d[p + 2] >> 1 & 1)
    q = p + 4 + side + (2 if crc else 0)
    tag = d[q:q + 4].decode('latin1')
    if tag not in ('Xing', 'Info'):
        return {'tag': None, 'first': p}
    flags = struct.unpack('>I', d[q + 4:q + 8])[0]
    o, out = q + 8, {'tag': tag, 'first': p, 'frame_size': size, 'kbps': KB[ver][d[p + 2] >> 4]}
    if flags & 1:
        out['frames'] = struct.unpack('>I', d[o:o + 4])[0]; o += 4
    if flags & 2:
        out['bytes'] = struct.unpack('>I', d[o:o + 4])[0]; o += 4
    if flags & 4:
        out['toc'] = list(d[o:o + 100]); o += 100
    if flags & 8:
        o += 4
    out['encoder'] = d[o:o + 9].decode('latin1')
    v = d[o + 21] << 16 | d[o + 22] << 8 | d[o + 23]
    out['delay'], out['padding'] = v >> 12, v & 4095
    out['music_length'] = struct.unpack('>I', d[o + 28:o + 32])[0]
    out['crc_ok'] = crc16(d[p:o + 34]) == struct.unpack('>H', d[o + 34:o + 36])[0]
    body = d[p + size:p + out['music_length']] if out['music_length'] else b''
    out['music_crc_ok'] = crc16(body) == struct.unpack('>H', d[o + 32:o + 34])[0]
    out['bytes_ok'] = out.get('bytes') == out['music_length']
    return out


def frames_from(d, p):
    """Headers of the Layer III frames from p while they follow on: (version, kbps, rate, mode) of each."""
    out = []
    while p + 4 <= len(d) and d[p] == 0xFF and d[p + 1] & 0xE0 == 0xE0:
        ver = d[p + 1] >> 3 & 3
        k, sr = KB[ver][d[p + 2] >> 4], RATES[ver][d[p + 2] >> 2 & 3]
        out.append((ver, k, sr, d[p + 3] >> 6))
        p += (144000 if ver == 3 else 72000) * k // sr + (d[p + 2] >> 1 & 1)
    return out, p


def id3_facts(path):
    from mutagen.id3 import ID3, ID3NoHeaderError
    try:
        t = ID3(path, translate=False)  # the frames as written (mutagen would turn TYER into TDRC)
    except ID3NoHeaderError:
        return None
    frames = {}
    for k, f in t.items():
        key = k.split(':')[0]
        if key == 'APIC':
            frames['APIC'] = {'sha256': hashlib.sha256(f.data).hexdigest(), 'mime': f.mime, 'type': int(f.type)}
        elif key == 'USLT':
            frames['USLT'] = f.text
        elif key == 'COMM':
            frames['COMM'] = f.text[0] if f.text else ''
        elif hasattr(f, 'text'):
            frames[key] = '/'.join(str(x) for x in f.text)
    return {'version': t.version[1], 'frames': frames, 'encodings': sorted({int(getattr(f, 'encoding', 0)) for f in t.values()})}


def id3v1(d):
    if len(d) < 128 or d[-128:-125] != b'TAG':
        return None
    t = d[-128:]
    s = lambda a, b: t[a:b].split(b'\x00')[0].decode('latin1').rstrip()
    return {'title': s(3, 33), 'artist': s(33, 63), 'album': s(63, 93), 'year': s(93, 97), 'track': t[126] if t[125] == 0 else None, 'genre': t[127]}


def boxes(d, start, end):
    out, p = [], start
    while p + 8 <= end:
        size, typ = struct.unpack('>I', d[p:p + 4])[0], d[p + 4:p + 8].decode('latin1')
        head = 8
        if size == 1:
            size, head = struct.unpack('>Q', d[p + 8:p + 16])[0], 16
        if size < head or p + size > end:
            break
        out.append((typ, p, head, size))
        p += size
    return out


def mp4_facts(path, d):
    from mutagen.mp4 import MP4
    out = {}
    moov = [b for b in boxes(d, 0, len(d)) if b[0] == 'moov']
    if moov:
        _, p, h, s = moov[0]
        kids = boxes(d, p + h, p + s)
        mv = [b for b in kids if b[0] == 'mvhd'][0]
        v = d[mv[1] + 8]
        ts, dur = struct.unpack('>II', d[mv[1] + 20:mv[1] + 28]) if v == 0 else struct.unpack('>IQ', d[mv[1] + 28:mv[1] + 40])
        out['movie'] = {'timescale': ts, 'duration': dur}
        for tk in [b for b in kids if b[0] == 'trak']:
            for b in boxes(d, tk[1] + tk[2], tk[1] + tk[3]):
                if b[0] == 'edts':
                    el = [x for x in boxes(d, b[1] + 8, b[1] + b[3]) if x[0] == 'elst'][0]
                    n = struct.unpack('>I', d[el[1] + 12:el[1] + 16])[0]
                    if d[el[1] + 8] == 0:
                        out['elst'] = [struct.unpack('>Ii', d[el[1] + 16 + 12 * i:el[1] + 24 + 12 * i]) for i in range(n)]
                if b[0] == 'mdia':
                    md = [x for x in boxes(d, b[1] + 8, b[1] + b[3]) if x[0] == 'mdhd'][0]
                    out['media'] = dict(zip(['timescale', 'duration'], struct.unpack('>II', d[md[1] + 20:md[1] + 28])))
    try:
        tags = MP4(path).tags or {}
        out['tags'] = {k: (str(v[0]) if isinstance(v, list) and v and not isinstance(v[0], (bytes, bytearray)) else
                           hashlib.sha256(bytes(v[0])).hexdigest() if isinstance(v, list) and v else str(v)) for k, v in tags.items()}
    except Exception as e:
        out['tags_error'] = str(e)
    return out


def wav_info(d):
    """RIFF INFO text, read as UTF-8."""
    out, p = {}, 12
    while p + 8 <= len(d):
        cid, size = d[p:p + 4].decode('latin1'), struct.unpack('<I', d[p + 4:p + 8])[0]
        if cid == 'LIST' and d[p + 8:p + 12] == b'INFO':
            q = p + 12
            while q + 8 <= p + 8 + size:
                k, n = d[q:q + 4].decode('latin1'), struct.unpack('<I', d[q + 4:q + 8])[0]
                out[k] = d[q + 8:q + 8 + n].rstrip(b'\x00').decode('utf-8', 'replace')
                q += 8 + n + (n & 1)
        p += 8 + size + (size & 1)
    return out


def facts(path):
    d = open(path, 'rb').read()
    info = probe(path)
    a = [s for s in info['streams'] if s['codec_type'] == 'audio'][0]
    x = decode(path, a['channels'])
    out = {'size': len(d), 'codec': a['codec_name'], 'profile': a.get('profile'), 'rate': int(a['sample_rate']), 'channels': a['channels'],
           'bit_rate': int(a['bit_rate']) if 'bit_rate' in a else None, 'duration': float(info['format'].get('duration', 0)),
           'samples': len(x), 'rms': [float(np.sqrt(np.mean(x[:, c].astype(np.float64) ** 2))) if len(x) else 0 for c in range(a['channels'])],
           'peak': float(np.abs(x).max()) if len(x) else 0, 'format': info['format']['format_name']}
    if a['codec_name'] == 'mp3':
        out['lame'] = lame(d)
        first = out['lame']['first'] + (out['lame']['frame_size'] if out['lame'] and out['lame'].get('tag') else 0) if out['lame'] else 0
        fr, end = frames_from(d, first)
        out['frames'] = len(fr)
        out['kbps_seen'] = sorted({f[1] for f in fr})
        out['after_frames'] = len(d) - end
        out['id3'] = id3_facts(path)
        out['id3v1'] = id3v1(d)
    elif d[4:8] == b'ftyp':
        out['mp4'] = mp4_facts(path, d)
    elif d[:4] in (b'RIFF', b'RF64'):
        out['info'] = wav_info(d)
        out['bits'] = a.get('bits_per_sample')
    return out, x


def compare(x, want, lossy):
    out = {'want': len(want)}
    if len(x) == len(want):
        out['diff'] = float(np.abs(x - want).max()) if len(want) else 0.0
    if lossy and len(want) and len(x):
        best = None
        for lag in range(-64, 65):
            a0, b0 = max(0, lag), max(0, -lag)
            n = min(len(x) - a0, len(want) - b0)
            if n < len(want) // 2:
                continue
            e = x[a0:a0 + n] - want[b0:b0 + n]
            err = float(np.sqrt(np.mean(e.astype(np.float64) ** 2)))
            if best is None or err < best[1]:
                best = (lag, err)
        sig = float(np.sqrt(np.mean(want.astype(np.float64) ** 2)))
        out['lag'], out['snr'] = best[0], (20 * np.log10(sig / best[1]) if best[1] > 0 else 200.0)
    return out


def main():
    kind = sys.argv[1]
    if kind == 'packets':
        pk = json.loads(run('ffprobe', '-v', 'error', '-of', 'json', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'SHA256', sys.argv[2]))
        print(json.dumps([p['data_hash'].split(':', 1)[1] for p in pk['packets']]))
        return
    if kind == 'zip':
        with zipfile.ZipFile(sys.argv[2]) as z:
            print(json.dumps({'names': [i.filename for i in z.infolist()], 'sizes': [i.file_size for i in z.infolist()],
                              'stored': all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()), 'utf8': all(i.flag_bits & 0x800 for i in z.infolist()),
                              'sha256': [hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()]}))
        return
    out, x = facts(sys.argv[2])
    if kind in ('cut', 'join', 'fade'):
        src = sys.argv[3]
        ch = x.shape[1]
        if kind == 'cut' and len(sys.argv) > 6:
            # Byte ranges a:b,c:d of SRC put together (its frames without the junk).
            with open(src, 'rb') as f:
                d = f.read()
            fd, clean = tempfile.mkstemp(suffix='.mp3')
            with os.fdopen(fd, 'wb') as g:
                for r in sys.argv[6].split(','):
                    a, b = (int(v) for v in r.split(':'))
                    g.write(d[a:b])
            try:
                whole = decode(clean)
            finally:
                os.remove(clean)
        else:
            whole = decode(src)
        if whole.shape[1] != ch:
            whole = whole.mean(axis=1, keepdims=True) if ch == 1 else np.repeat(whole[:, :1], ch, axis=1)
        if kind == 'fade':
            a, b, fi, fo = (int(v) for v in sys.argv[4:8])
            vol = float(sys.argv[8])
            n = b - a
            t = np.arange(n) + 0.0
            g = np.full(n, vol)
            if fi:
                g *= np.minimum(1, t / fi)
            if fo:
                g *= np.minimum(1, (n - t) / fo)
            want = (whole[a:b].astype(np.float64) * g[:, None]).astype(np.float32)
        elif kind == 'cut':
            want = whole[int(sys.argv[4]):int(sys.argv[5])]
        else:
            A, B, C, D, XF = (int(v) for v in sys.argv[4:9])
            h = XF // 2
            p1, p2 = whole[A:B + h].astype(np.float64), whole[C - h:D].astype(np.float64)
            if XF:
                w = ((np.arange(2 * h) + 0.5) / (2 * h))[:, None]
                mid = p1[-2 * h:] * (1 - w) + p2[:2 * h] * w
                want = np.concatenate([p1[:-2 * h], mid, p2[2 * h:]]).astype(np.float32)
            else:
                want = np.concatenate([whole[A:B], whole[C:D]])
        out['vs'] = compare(x, want, out['codec'] in ('mp3', 'aac'))
    print(json.dumps(out, ensure_ascii=False))


main()
