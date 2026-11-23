#!/usr/bin/env python3
"""Checks an MP4 made by /gif-to-mp4/ against its GIF, with tools that share no code with the page.

    python3 verify.py GIF MP4 '{"bg": "#ffffff", "factor": 1, "odd": "pad", "plays": 1}'

Prints JSON: what ffprobe reads (stream, format, every packet's time and length) and, for each
decoded frame, its PSNR against the GIF's frame as ImageMagick composites it (-coalesce),
flattened on the background colour, enlarged by factor with nearest-neighbour sampling and
padded (with the background) or cropped to the MP4's size. The MP4 is decoded by ffmpeg as its
own tags say (BT.709 matrix, full range), one picture per frame (no frame rate conversion).
Needs ffmpeg, ffprobe, ImageMagick (convert or magick) and numpy.
"""
import json
import shutil
import subprocess
import sys

import numpy as np


def run(cmd):
    return subprocess.run(cmd, capture_output=True, check=True).stdout


def main():
    gif, mp4, opt = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    bg, factor, odd, plays = opt.get('bg', '#ffffff'), int(opt.get('factor', 1)), opt.get('odd', 'pad'), int(opt.get('plays', 1))
    probe = json.loads(run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_packets', mp4]))
    vs = [s for s in probe['streams'] if s['codec_type'] == 'video']
    out = {
        'streams': [{k: s.get(k) for k in ('codec_type', 'codec_name', 'profile', 'pix_fmt', 'width', 'height', 'color_range', 'color_space',
                                          'color_transfer', 'color_primaries', 'nb_frames', 'duration')} for s in probe['streams']],
        'format': {k: probe['format'].get(k) for k in ('format_name', 'duration', 'size', 'nb_streams')},
        'packets': [[float(p['pts_time']), float(p['duration_time']), 'K' in p.get('flags', '')] for p in probe.get('packets', [])],
    }
    if len(vs) != 1:
        print(json.dumps(out))
        return
    W, H = vs[0]['width'], vs[0]['height']
    im = ['magick'] if shutil.which('magick') else ['convert']
    ident = ['magick', 'identify'] if im[0] == 'magick' else ['identify']
    gw, gh = map(int, run(ident + ['-format', '%W %H|', gif]).decode().split('|')[0].split())
    raw = run(im + [gif, '-coalesce', '-background', bg, '-alpha', 'remove', '-alpha', 'off', '-depth', '8', 'rgb:-'])
    n = len(raw) // (gw * gh * 3)
    rgb_bg = [int(bg[i:i + 2], 16) for i in (1, 3, 5)]
    refs = []
    for i in range(n):
        f = np.frombuffer(raw[i * gw * gh * 3:(i + 1) * gw * gh * 3], np.uint8).reshape(gh, gw, 3)
        f = np.repeat(np.repeat(f, factor, 0), factor, 1)
        canvas = np.empty((H, W, 3), np.uint8)
        canvas[:] = rgb_bg
        h, w = min(H, f.shape[0]), min(W, f.shape[1])
        canvas[:h, :w] = f[:h, :w]
        refs.append(canvas)
    dec = run(['ffmpeg', '-v', 'error', '-i', mp4, '-fps_mode', 'passthrough', '-vf', 'scale=in_color_matrix=bt709:in_range=pc,format=rgb24',
               '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    m = len(dec) // (W * H * 3)
    psnr, worst = [], 0
    for i in range(m):
        d = np.frombuffer(dec[i * W * H * 3:(i + 1) * W * H * 3], np.uint8).reshape(H, W, 3).astype(np.float64)
        r = refs[i % n].astype(np.float64)
        mse = ((d - r) ** 2).mean()
        psnr.append(round(10 * np.log10(255 ** 2 / mse), 2) if mse else 99.0)
        worst = max(worst, float(np.abs(d - r).max()))
    out.update(gifFrames=n, decodedFrames=m, psnr=psnr, psnrMin=min(psnr) if psnr else None,
               psnrMean=round(float(np.mean(psnr)), 2) if psnr else None, maxDiff=worst, plays=plays)
    print(json.dumps(out))


if __name__ == '__main__':
    main()
