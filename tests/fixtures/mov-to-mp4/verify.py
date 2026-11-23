#!/usr/bin/env python3
"""Independent checks of the MP4 files written by the MOV to MP4 page.

Uses ffprobe, ffmpeg and numpy only (no code shared with the page):
  verify.py facts FILE          streams, tags, rotation, colour and, for each
                                stream, the SHA-256 and timing of every packet
  verify.py frames A B [W H]    decodes both videos (scaled to W x H, default
                                the size of A) and compares frame counts,
                                presentation times and PSNR per frame
  verify.py sound A B           decodes the first sound track of both to mono
                                float PCM at 48 kHz and compares them
Prints one JSON object.
"""
import hashlib
import json
import subprocess
import sys

import numpy as np


def ffprobe(args):
    out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json'] + args, check=True, capture_output=True).stdout
    return json.loads(out or b'{}')


def facts(path):
    j = ffprobe(['-show_format', '-show_streams', path])
    streams = []
    for s in j.get('streams', []):
        side = s.get('side_data_list', [])
        streams.append({
            'index': s['index'], 'type': s.get('codec_type'), 'codec': s.get('codec_name'), 'tag': s.get('codec_tag_string'),
            'width': s.get('width'), 'height': s.get('height'), 'pix_fmt': s.get('pix_fmt'),
            'primaries': s.get('color_primaries'), 'transfer': s.get('color_transfer'), 'matrix': s.get('color_space'),
            'rotation': next((d['rotation'] for d in side if 'rotation' in d), 0),
            'sample_rate': int(s['sample_rate']) if s.get('sample_rate') else None, 'channels': s.get('channels'),
            'language': s.get('tags', {}).get('language'), 'duration': float(s['duration']) if s.get('duration') else None,
            'start': float(s['start_time']) if s.get('start_time') not in (None, 'N/A') else None,
            'frames': int(s['nb_frames']) if s.get('nb_frames') not in (None, 'N/A') else None,
            'bit_rate': int(s['bit_rate']) if s.get('bit_rate') else None,
        })
    pk = ffprobe(['-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,size,data_hash,flags', path])
    for s in streams:
        s['packets'] = [{'pts': float(p['pts_time']) if p.get('pts_time') not in (None, 'N/A') else None,
                         'dur': float(p['duration_time']) if p.get('duration_time') not in (None, 'N/A') else None,
                         'size': int(p['size']), 'hash': p.get('data_hash'), 'key': 'K' in p.get('flags', '')}
                        for p in pk.get('packets', []) if p['stream_index'] == s['index']]
    fmt = j.get('format', {})
    return {'format': fmt.get('format_name'), 'brand': fmt.get('tags', {}).get('major_brand'), 'tags': fmt.get('tags', {}),
            'duration': float(fmt['duration']) if fmt.get('duration') else None, 'size': int(fmt.get('size', 0)), 'streams': streams}


def decode(path, w, h, fmt='gray', size=None):
    """Every presented frame at w x h (cropped from the top left when the video is at most
    2 pixels larger, as an H.264 copy of an odd size is, else scaled), as 8-bit grey (Y) or,
    shrunk to `size` by averaging, as RGB; with the frame times."""
    times = [float(f['best_effort_timestamp_time']) for f in ffprobe(['-select_streams', 'v:0', '-show_frames', '-show_entries',
             'frame=best_effort_timestamp_time', path]).get('frames', []) if f.get('best_effort_timestamp_time') not in (None, 'N/A')]
    s = next(x for x in facts_light(path) if x.get('codec_type') == 'video')
    sw, sh = s['width'], s['height']
    if abs(s_rotation(s)) in (90, 270):
        sw, sh = sh, sw
    fit = f'crop={w}:{h}:0:0' if 0 <= sw - w <= 2 and 0 <= sh - h <= 2 else f'scale={w}:{h}:flags=bicubic'
    if size:
        fit += f',scale={size[0]}:{size[1]}:flags=area'
        w, h = size
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-map', '0:v:0', '-vf', fit, '-fps_mode', 'passthrough',
                          '-pix_fmt', fmt, '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout
    depth = 3 if fmt == 'rgb24' else 1
    frames = np.frombuffer(raw, np.uint8).reshape((-1, h, w, depth) if depth > 1 else (-1, h, w))
    return frames, times


def facts_light(path):
    return ffprobe(['-show_streams', path]).get('streams', [])


def s_rotation(s):
    return next((d['rotation'] for d in s.get('side_data_list', []) if 'rotation' in d), 0)


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if mse == 0 else float(10 * np.log10(255 * 255 / mse))


def frames(a, b, w=None, h=None):
    if w is None:
        s = next(x for x in facts(a)['streams'] if x['type'] == 'video')
        w, h = s['width'], s['height']
        if abs(s['rotation']) in (90, 270):
            w, h = h, w
    w, h = int(w) // 2 * 2, int(h) // 2 * 2
    fa, ta = decode(a, w, h)
    fb, tb = decode(b, w, h)
    n = min(len(fa), len(fb))
    p = [psnr(fa[i], fb[i]) for i in range(n)]
    # Colour: the mean RGB of each cell of a 16 x 9 grid, each file decoded with its own colour
    # tags; the mean difference, and the largest average shift of one channel (a wrong matrix or
    # range shifts whole channels; compression only blurs edges).
    ca, _ = decode(a, w, h, 'rgb24', (16, 9))
    cb, _ = decode(b, w, h, 'rgb24', (16, 9))
    m = min(len(ca), len(cb))
    d = cb[:m].astype(np.int16) - ca[:m].astype(np.int16)
    return {'frames': [len(fa), len(fb)], 'times': [ta, tb], 'psnr_min': min(p) if p else None, 'psnr_mean': float(np.mean(p)) if p else None,
            'colour_mean': float(np.mean(np.abs(d))), 'colour_bias': float(np.max(np.abs(d.mean(axis=(0, 1, 2))))), 'size': [w, h]}


def pcm(path):
    # ffmpeg 6.1's own Opus decoder garbles sound after a sharp click; libopus does not.
    codec = next((x.get('codec_name') for x in facts_light(path) if x.get('codec_type') == 'audio'), None)
    dec = ['-c:a', 'libopus'] if codec == 'opus' else []
    raw = subprocess.run(['ffmpeg', '-v', 'error'] + dec + ['-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32)


def sound(a, b):
    x, y = pcm(a), pcm(b)
    n = min(len(x), len(y))
    # The AAC encoder delays the sound by its priming samples, which the MP4's
    # edit list removes again; allow a small shift and report the best match.
    best = None
    for lag in range(-2048, 2049, 1):
        if lag >= 0:
            xa, ya = x[lag:n], y[:n - lag]
        else:
            xa, ya = x[:n + lag], y[-lag:n]
        if len(xa) < 4800:
            continue
        err = float(np.mean((xa - ya) ** 2))
        if best is None or err < best[1]:
            best = (lag, err)
    sig = float(np.mean(x[:n] ** 2))
    snr = 99.0 if best[1] == 0 else 10 * np.log10(sig / best[1])
    return {'samples': [len(x), len(y)], 'lag': best[0], 'snr': float(snr), 'rms': [float(np.sqrt(np.mean(x ** 2))), float(np.sqrt(np.mean(y ** 2)))]}


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'facts':
        print(json.dumps(facts(sys.argv[2])))
    elif cmd == 'frames':
        print(json.dumps(frames(*sys.argv[2:])))
    elif cmd == 'sound':
        print(json.dumps(sound(sys.argv[2], sys.argv[3])))
    else:
        sys.exit('unknown command ' + cmd)
