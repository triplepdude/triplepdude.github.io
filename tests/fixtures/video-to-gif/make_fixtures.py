#!/usr/bin/env python3
"""Test videos and expected answers for tests/tools/video-to-gif.test.js.

  python3 make_fixtures.py            (needs Pillow, ffmpeg and ffprobe)

Every frame of frames.webm, screen.webm, rotated.mp4 and damaged.mp4 carries its own number
as 7 black or white blocks (bit 0 on the left), so a test can read which video
frame each GIF frame shows. The expected frame for a GIF frame is worked out
here from the frame timestamps that ffprobe reports, not from the page's code:
a GIF frame taken at time t shows the last video frame whose timestamp is at or
before t. expected.json holds the scenarios the test runs.
"""
import json, math, os, random, subprocess, tempfile
from fractions import Fraction
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))


def run(args):
    subprocess.run(args, check=True)


def encode(frames_dir, fps, out, codec, gop):
    args = ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', os.path.join(frames_dir, '%04d.png')]
    if codec == 'vp9':
        args += ['-c:v', 'libvpx-vp9', '-crf', '12', '-b:v', '0', '-g', str(gop), '-pix_fmt', 'yuv420p', '-row-mt', '1']
    else:
        args += ['-c:v', 'libx264', '-crf', '14', '-g', str(gop), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
    run(args + [out])


def coded_clip(path, n, fps, codec='vp9', gop=30):
    """320 x 180: grey, a moving yellow ball, a red-to-blue band, and the code blocks."""
    W, H = 320, 180
    with tempfile.TemporaryDirectory() as d:
        for f in range(n):
            im = Image.new('RGB', (W, H), (128, 128, 128))
            dr = ImageDraw.Draw(im)
            for x in range(W):
                dr.line([(x, 130), (x, H - 1)], fill=(round(255 * (1 - x / (W - 1))), 60, round(255 * x / (W - 1))))
            for i in range(7):
                x0 = 10 + i * 44
                dr.rectangle([x0, 10, x0 + 39, 49], fill=(255, 255, 255) if (f >> i) & 1 else (0, 0, 0))
            cx = 20 + (f * 3) % (W - 40)
            dr.ellipse([cx - 12, 75, cx + 12, 99], fill=(250, 220, 40))
            im.save(os.path.join(d, '%04d.png' % f))
        encode(d, fps, path, codec, gop)


def screen_clip(path, n, fps):
    """A screen recording: white page, grey text lines, a moving cursor, small code blocks."""
    W, H = 320, 180
    with tempfile.TemporaryDirectory() as d:
        for f in range(n):
            im = Image.new('RGB', (W, H), (255, 255, 255))
            dr = ImageDraw.Draw(im)
            dr.rectangle([0, 0, W - 1, 31], fill=(32, 60, 110))
            for row in range(7):
                y = 44 + row * 18
                dr.rectangle([16, y, 16 + 60 + (row * 37) % 220, y + 7], fill=(150, 150, 150))
            for i in range(7):
                x0 = 8 + i * 20
                dr.rectangle([x0, 8, x0 + 15, 23], fill=(255, 255, 255) if (f >> i) & 1 else (0, 0, 0))
            cx, cy = 40 + f * 6, 60 + f * 3
            dr.polygon([(cx, cy), (cx, cy + 16), (cx + 4, cy + 12), (cx + 11, cy + 12)], fill=(0, 0, 0))
            im.save(os.path.join(d, '%04d.png' % f))
        encode(d, fps, path, 'vp9', 60)


def long_clip(path, seconds, fps):
    W, H = 64, 36
    with tempfile.TemporaryDirectory() as d:
        for f in range(seconds * fps):
            im = Image.new('RGB', (W, H), (90, 120, 150))
            ImageDraw.Draw(im).rectangle([f % W, 10, f % W + 6, 25], fill=(240, 240, 240))
            im.save(os.path.join(d, '%04d.png' % f))
        encode(d, fps, path, 'vp9', 50)


def fade_clip(path, n, fps):
    """Every pixel changes in every frame: a gradient that brightens."""
    W, H = 160, 90
    with tempfile.TemporaryDirectory() as d:
        for f in range(n):
            im = Image.new('RGB', (W, H))
            dr = ImageDraw.Draw(im)
            for x in range(W):
                v = 40 + 8 * f + x // 2
                dr.line([(x, 0), (x, H - 1)], fill=(min(255, v), min(255, v // 2 + 30), 90))
            im.save(os.path.join(d, '%04d.png' % f))
        encode(d, fps, path, 'vp9', 30)


def damaged_clip(path):
    """The coded clip as H.264 (one key frame, B-frames), cut off halfway through its 46th packet,
    as an interrupted download or copy leaves a file: the header still gives 3 seconds, but the
    picture data ends after about 1.4 s. Chromium reports a decoding error past that point."""
    with tempfile.TemporaryDirectory() as d:
        full = os.path.join(d, 'full.mp4')
        coded_clip(full, 90, 30, codec='h264', gop=250)
        rows = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size,pos',
                               '-of', 'csv=p=0', full], check=True, capture_output=True, text=True).stdout.split()
        size, pos = (int(x) for x in rows[45].split(','))
        with open(full, 'rb') as f:
            data = f.read()
    with open(path, 'wb') as f:
        f.write(data[:pos + size // 2])


def hour_clip(path):
    """A still picture for 62 minutes, one frame every 10 seconds: times past an hour."""
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x406080:s=32x18:r=1/10', '-t', '3725',
         '-c:v', 'libvpx-vp9', '-g', '1000', '-crf', '50', '-b:v', '0', path])


def pts(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time',
                          '-of', 'csv=p=0', path], check=True, capture_output=True, text=True).stdout
    return [float(x.split(',')[0]) for x in out.split()]


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                         check=True, capture_output=True, text=True).stdout.strip()
    return float(out)


def half_up(x):
    return math.floor(x + Fraction(1, 2))


def scenario(name, clip, start, end, fps, speed, direction='forward', plays=0, timing=None):
    """start and end as decimal strings, exactly as typed in the test. timing: a clip with the
    same frames whose header gives the duration (recorded.webm has none)."""
    stamps = pts(os.path.join(HERE, timing or clip))
    dur = duration(os.path.join(HERE, timing or clip))
    step = Fraction(speed) / fps
    span = Fraction(end) - Fraction(start)
    n = max(1, math.ceil(span / step))
    total = 2 * n - 2 if direction == 'boomerang' and n > 1 else n
    order = []
    for i in range(total):
        if direction == 'reverse':
            order.append(n - 1 - i)
        elif direction == 'boomerang' and i >= n:
            order.append(2 * n - 2 - i)
        else:
            order.append(i)
    codes, near = [], []
    for k in order:
        # The same double arithmetic as a browser: start + k * (speed / fps) + 1 ms, at most the duration.
        t = min(float(start) + k * (float(speed) / fps) + 0.001, dur)
        frame = max(j for j, p in enumerate(stamps) if p <= t)
        codes.append(frame)
        near += [k for p in stamps if abs(p - t) < 1e-4]
    assert not near, f'{name}: sample times too close to a frame boundary: {near}'
    cs = [half_up(Fraction(100 * i, fps)) for i in range(total + 1)]
    delays = [cs[i + 1] - cs[i] for i in range(total)]
    loop = 0 if plays == 0 else (None if plays == 1 else plays - 1)
    return dict(name=name, clip=clip, start=start, end=end, fps=fps, speed=speed, direction=direction, plays=plays,
                frames=total, codes=codes, delays=delays, loop=loop, length_cs=cs[total])


def main():
    coded_clip(os.path.join(HERE, 'frames.webm'), 90, 30)
    screen_clip(os.path.join(HERE, 'screen.webm'), 60, 30)
    long_clip(os.path.join(HERE, 'long.webm'), 150, 10)
    fade_clip(os.path.join(HERE, 'fade.webm'), 15, 10)
    with tempfile.TemporaryDirectory() as d:
        coded_clip(os.path.join(d, 'upright.mp4'), 30, 30, codec='h264')
        # As an iPhone stores a portrait video: landscape pixels and a 90 degree clockwise display rotation.
        run(['ffmpeg', '-y', '-loglevel', 'error', '-display_rotation', '-90', '-i', os.path.join(d, 'upright.mp4'),
             '-c', 'copy', os.path.join(HERE, 'rotated.mp4')])
    # A browser recording (MediaRecorder) has no length in its header; ffmpeg's live WebM is the same.
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(HERE, 'frames.webm'), '-c', 'copy', '-live', '1',
         '-f', 'webm', os.path.join(HERE, 'recorded.webm')])
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus',
         os.path.join(HERE, 'sound.webm')])
    damaged_clip(os.path.join(HERE, 'damaged.mp4'))
    hour_clip(os.path.join(HERE, 'hour.webm'))
    rnd = random.Random(41)
    with open(os.path.join(HERE, 'broken.mp4'), 'wb') as f:
        f.write(bytes(rnd.randrange(256) for _ in range(4096)))

    # Where the code blocks of rotated.mp4 land once the video is shown upright, checked against
    # ffmpeg's own rotation of frame 5 (code 0000101): block centres of the 180 x 320 picture.
    upright = os.path.join(HERE, 'rot5.png')
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(HERE, 'rotated.mp4'), '-vf', 'select=eq(n\\,5)',
         '-frames:v', '1', upright])
    im = Image.open(upright).convert('RGB')
    os.remove(upright)
    assert im.size == (180, 320), im.size
    rot_centres = [[149, 29 + 44 * i] for i in range(7)]
    bits = [1 if im.getpixel(tuple(c))[0] > 128 else 0 for c in rot_centres]
    assert bits == [1, 0, 1, 0, 0, 0, 0], bits

    scenarios = [
        scenario('default', 'frames.webm', '0', '3', 10, 1),
        scenario('reverse', 'frames.webm', '0.52', '2.5', 15, 2, 'reverse', 3),
        scenario('boomerang', 'frames.webm', '1', '2', 12, 1, 'boomerang', 1),
        scenario('slow', 'frames.webm', '0.2', '0.7', 30, 0.5, 'forward', 2),
        scenario('exact', 'frames.webm', '0', '3', 5, 1),
        scenario('crop', 'frames.webm', '0.5', '1.5', 10, 1),
        scenario('keyboard', 'frames.webm', '1.1', '2', 10, 1),
        scenario('screen', 'screen.webm', '0', '2', 10, 1),
        scenario('rotated', 'rotated.mp4', '0', '1', 10, 1),
        scenario('recorded', 'recorded.webm', '0', '3', 10, 1, timing='frames.webm'),
        scenario('damaged', 'damaged.mp4', '0', '1', 10, 1),
    ]
    blocks = {
        'coded': [[10 + 44 * i + 20, 30] for i in range(7)],
        'screen': [[8 + 20 * i + 8, 16] for i in range(7)],
        'rotated': rot_centres,
    }
    with open(os.path.join(HERE, 'expected.json'), 'w') as f:
        json.dump({'blocks': blocks, 'scenarios': scenarios}, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
