#!/usr/bin/env python3
"""Makes the test GIFs for tests/tools/gif-to-mp4.test.js and their expected frames.

    python3 tests/fixtures/gif-to-mp4/make_fixtures.py

Needs Python 3 with numpy, ImageMagick 6 or 7 (convert or magick) and ffmpeg.

Most GIFs are written here byte by byte, with a real LZW encoder, from frames described as
palette indexes. A small model of how browsers show a GIF (below, written from the GIF89a
specification and from what Chromium's ImageDecoder returned for these files) composites the
frames, and expected.json keeps a hash of every frame. Where ImageMagick shows GIFs as browsers
do, the model's frames are checked against `convert -coalesce` before anything is written
(unusual.gif, gif87a.gif, timing.gif, pixel-art.gif, loop3.gif, still.gif and real.gif, which
ffmpeg makes and whose expected frames come from ImageMagick alone). Where ImageMagick does
not, the file is listed as browser-only, and why:

  - oversized.gif: browsers grow the canvas to a first frame larger than the logical screen
    (to 72 x 54 here); ImageMagick keeps the 40 x 30 screen and cuts the frame off.
  - browser-rules.gif: a GCE belongs to the next image only (ImageMagick carries it over to a
    following image without one); disposal 3 on the first frame restores the empty, transparent
    canvas (ImageMagick fills it with the background colour); disposal 4 counts as 3 and 5 as 1
    (ImageMagick treats both as 1); indexes past the end of the palette are opaque black
    (ImageMagick shows colour 0); a transparent index past the palette still makes its pixels
    transparent (ImageMagick paints them); a frame 0 pixels wide is a frame that draws nothing
    (ImageMagick refuses the file).
  - cut-off.gif: cut inside its 4th frame; browsers show the 3 whole frames (ImageMagick reads
    one), which the model checks against ImageMagick's frames of the whole file.
  - damaged.gif: its 2nd frame's pixel data has a code that is not defined yet, which Chrome
    refuses; the page keeps the frame before it.

The hash of a frame is the first 16 hex digits of the SHA-256 of its RGBA bytes (width x height
x 4, straight alpha that is 0 or 255), with transparent pixels set to 0, 0, 0, 0.
"""
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------- Writing GIFs ----------
def lzw(indices, min_code):
    clear, eoi = 1 << min_code, (1 << min_code) + 1
    out, acc, nbits = bytearray(), 0, 0
    size = min_code + 1

    def put(code):
        nonlocal acc, nbits
        acc |= code << nbits
        nbits += size
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8

    table, nxt, sent = {}, eoi + 1, 0
    put(clear)
    w = None
    for k in indices:
        if w is None:
            w = k
            continue
        key = (w, k)
        if key in table:
            w = table[key]
            continue
        put(w)
        sent += 1
        if nxt < 4096:
            table[key] = nxt
            nxt += 1
            # The decoder makes each entry one code after the encoder does and widens its codes
            # once its next free entry reaches 1 << size: widen when it will have.
            if nxt - 1 >= (1 << size) and sent >= 2 and size < 12:
                size += 1
        else:
            put(clear)
            table, nxt, sent, size = {}, eoi + 1, 0, min_code + 1
        w = k
    if w is not None:
        put(w)
    put(eoi)
    if nbits:
        out.append(acc & 0xFF)
    return bytes(out)


def sub_blocks(data):
    b = bytearray()
    for i in range(0, len(data), 255):
        part = data[i:i + 255]
        b.append(len(part))
        b += part
    b.append(0)
    return bytes(b)


def bits_for(n):
    b = 1
    while (1 << b) < n:
        b += 1
    return b


def pal_bytes(pal, bits):
    pal = list(pal)[:1 << bits] + [(0, 0, 0)] * ((1 << bits) - len(pal))
    return b''.join(bytes(c) for c in pal)


def interlace_order(h):
    return list(range(0, h, 8)) + list(range(4, h, 8)) + list(range(2, h, 4)) + list(range(1, h, 2))


class Gif:
    """A GIF as a list of blocks, so that the file and the model come from one description."""

    def __init__(self, w, h, pal, bg=0, version=b'89a', loop=0, bits=None):
        self.w, self.h, self.pal, self.bg, self.version, self.bits = w, h, pal, bg, version, bits
        self.blocks = []
        if loop is not None:
            self.blocks.append(('raw', b'\x21\xff\x0bNETSCAPE2.0\x03\x01' + struct.pack('<H', loop) + b'\x00'))
        self.loop = loop

    def raw(self, data):
        self.blocks.append(('raw', data))
        return self

    def gce(self, delay, disposal=0, transparent=None):
        self.blocks.append(('gce', (delay, disposal, transparent)))
        return self

    def plain_text(self, text):
        return self.raw(b'\x21\x01\x0c' + struct.pack('<HHHHBBBB', 0, 0, 40, 10, 8, 8, 1, 0) + sub_blocks(text))

    def comment(self, text):
        return self.raw(b'\x21\xfe' + sub_blocks(text))

    def frame(self, x, y, w, h, pix, local=None, interlaced=False, min_code=None, extra=0, corrupt=None):
        self.blocks.append(('frame', dict(x=x, y=y, w=w, h=h, pix=list(pix), local=local, interlaced=interlaced,
                                          min_code=min_code, extra=extra, corrupt=corrupt)))
        return self

    def frame_bytes(self, f):
        flags, lct = 0, b''
        if f['local'] is not None:
            lb = bits_for(len(f['local']))
            flags |= 0x80 | (lb - 1)
            lct = pal_bytes(f['local'], lb)
        if f['interlaced']:
            flags |= 0x40
        w, h, pix = f['w'], f['h'], f['pix']
        rows = [pix[r * w:(r + 1) * w] for r in range(h)]
        if f['interlaced']:
            rows = [rows[r] for r in interlace_order(h)]
        flat = [v for row in rows for v in row]
        if f['extra']:
            flat = flat + flat[:f['extra']]
        mc = f['min_code'] if f['min_code'] is not None else max(2, bits_for(max(pix) + 1 if pix else 1))
        coded = bytearray(lzw(flat, mc))
        if f['corrupt']:
            at, junk = f['corrupt']
            coded[at:at + len(junk)] = junk
        return b'\x2c' + struct.pack('<HHHH', f['x'], f['y'], w, h) + bytes([flags]) + lct + bytes([mc]) + sub_blocks(bytes(coded))

    def bytes(self):
        flags, gct = 0, b''
        if self.pal is not None:
            bits = self.bits or bits_for(len(self.pal))
            flags = 0x80 | ((bits - 1) << 4) | (bits - 1)
            gct = pal_bytes(self.pal, bits)
        out = bytearray(b'GIF' + self.version + struct.pack('<HH', self.w, self.h) + bytes([flags, self.bg, 0]) + gct)
        self.offsets = []
        for kind, v in self.blocks:
            if kind == 'raw':
                out += v
            elif kind == 'gce':
                d, disp, t = v
                out += b'\x21\xf9\x04' + bytes([(disp << 2) | (1 if t is not None else 0)]) + struct.pack('<H', d) + bytes([t or 0]) + b'\x00'
            else:
                self.offsets.append(len(out))
                out += self.frame_bytes(v)
        out += b'\x3b'
        return bytes(out)

    def model(self):
        """The frames as browsers show them: (width, height, [RGBA arrays], [delays], damaged index or None)."""
        frames = [v for k, v in self.blocks if k == 'frame']
        f0 = frames[0]
        W, H = max(self.w, f0['x'] + f0['w']), max(self.h, f0['y'] + f0['h'])
        canvas = np.zeros((H, W, 4), np.uint8)
        gpal = self.pal
        out, delays, pending, prev, saved = [], [], None, None, None
        damaged = None
        for kind, v in self.blocks:
            if kind == 'gce':
                pending = v
                continue
            if kind != 'frame':
                continue
            f = v
            delay, disp, trans = pending or (0, 0, None)
            pending = None
            if damaged is not None:  # past a damaged frame only the delays are listed
                delays.append(delay)
                continue
            if prev is not None:
                pf, pdisp = prev
                if pdisp == 2:
                    canvas[pf['y']:pf['y'] + pf['h'], pf['x']:pf['x'] + pf['w']] = 0
                elif pdisp in (3, 4):
                    canvas = saved
            saved = canvas.copy() if disp in (3, 4) else None
            if f['corrupt']:
                damaged = len(out)
                delays.append(delay)
                continue
            pal = f['local'] if f['local'] is not None else (gpal or [])
            w, h = f['w'], f['h']
            for i, idx in enumerate(f['pix'][:w * h]):
                x, y = f['x'] + i % w, f['y'] + i // w
                if x >= W or y >= H or (trans is not None and idx == trans):
                    continue
                c = pal[idx] if idx < len(pal) else (0, 0, 0)  # past the palette: opaque black, as in Chrome
                canvas[y, x] = (c[0], c[1], c[2], 255)
            out.append(canvas.copy())
            delays.append(delay)
            prev = (f, disp)
        return W, H, out, delays, damaged


def frame_hash(rgba):
    a = np.array(rgba, np.uint8).copy()
    a[a[..., 3] == 0] = 0
    return hashlib.sha256(a.tobytes()).hexdigest()[:16]


def played(cs):
    return 100 if cs <= 1 else cs * 10


# ---------- ImageMagick ----------
def magick():
    for name in ('magick', 'convert'):
        if shutil.which(name):
            return [name]
    sys.exit('ImageMagick (magick or convert) is needed')


def im_frames(path):
    im = magick()
    ident = (im + ['identify']) if im[0] == 'magick' else ['identify']
    W, H = map(int, subprocess.run(ident + ['-format', '%W %H|', path], capture_output=True, text=True, check=True).stdout.split('|')[0].split())
    raw = subprocess.run(im + [path, '-coalesce', '-depth', '8', 'rgba:-'], capture_output=True, check=True).stdout
    n = len(raw) // (W * H * 4)
    return W, H, [np.frombuffer(raw[i * W * H * 4:(i + 1) * W * H * 4], np.uint8).reshape(H, W, 4) for i in range(n)]


# ---------- The files ----------
PAL16 = [(255, 255, 255), (220, 30, 30), (30, 160, 60), (30, 60, 200), (240, 200, 20), (0, 0, 0), (128, 0, 128), (0, 200, 200),
         (255, 128, 0), (90, 90, 90), (200, 200, 200), (100, 40, 0), (0, 0, 100), (255, 0, 255), (150, 220, 150), (10, 10, 10)]


def solid(w, h, c): return [c] * (w * h)
def checker(w, h, a, b, s=4): return [a if ((i % w) // s + (i // w) // s) % 2 == 0 else b for i in range(w * h)]
def hole(w, h, c, t): return [t if (w // 4 <= i % w < 3 * w // 4 and h // 4 <= i // w < 3 * h // 4) else c for i in range(w * h)]
def bands(w, h, n=16): return [(i // w) % n for i in range(w * h)]


def unusual():
    W, H = 101, 75
    xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>' + bytes([1] + list(range(255, -1, -1)))
    g = Gif(W, H, PAL16, bg=3)
    g.comment(b'disposal, interlacing, local palettes and other rarely used parts of GIF89a')
    g.raw(b'\x21\xff\x0bXMP DataXMP' + xmp + b'\x00')                      # XMP with its "magic trailer"
    g.raw(b'\x21\xff\x0bICCRGBG1012' + sub_blocks(b'\x00' * 300))          # an ICC profile block
    g.raw(b'\x21\x99' + sub_blocks(b'an unknown extension'))
    g.plain_text(b'not drawn by browsers')                                  # before any frame
    g.gce(10, 1, 15).frame(0, 0, W, H, hole(W, H, 10, 15))                  # a hole: the canvas starts transparent there
    g.gce(5, 2, 15).frame(10, 10, 40, 30, hole(40, 30, 1, 15))              # restore to background (transparent)
    g.gce(2, 3).frame(30, 20, 40, 30, solid(40, 30, 2))                     # restore to previous
    g.gce(1, 0, 15).frame(50, 40, 30, 20, hole(30, 20, 3, 15))              # 1 hundredth: played as 100 ms
    g.gce(0, 2).frame(5, 5, 60, 41, checker(60, 41, 4, 6, 3), interlaced=True)
    g.gce(3, 1).frame(60, 30, 41, 45, solid(41, 45, 7), local=[(0, 0, 0)] * 7 + [(255, 0, 128)])
    g.gce(0, 1).frame(100, 74, 1, 1, [8])                                   # one pixel in the corner
    for i, hh in enumerate([2, 3, 4, 5, 9]):                                # small interlaced frames
        g.gce(4, 1).frame(2 + i * 7, 50, 6, hh, bands(6, hh), interlaced=True)
    g.gce(6, 1).frame(80, 60, 40, 30, checker(40, 30, 3, 4, 3))             # runs past the right and bottom edges
    g.gce(6, 1).frame(200, 200, 10, 10, solid(10, 10, 2))                   # entirely outside the canvas
    g.gce(50, 2, 3).plain_text(b'its GCE goes to the next image')           # a GCE, a Plain Text Extension, then
    g.frame(20, 20, 30, 12, hole(30, 12, 9, 3))                             # the image it applies to
    g.gce(7, 1).frame(0, 0, 30, 10, bands(30, 10), extra=37)                # 37 pixels too many: ignored
    g.gce(10, 0).frame(0, 0, W, H, checker(W, H, 13, 14, 7))
    return g


def browser_rules():
    g = Gif(40, 30, PAL16[:8], bits=3)
    g.gce(10, 3).frame(0, 0, 40, 30, solid(40, 30, 1))                      # disposal 3 on the first frame
    g.gce(10, 3).frame(5, 5, 20, 10, solid(20, 10, 2))                      # and again
    g.gce(10, 4).frame(10, 10, 20, 10, solid(20, 10, 3))                    # 4 counts as 3
    g.gce(10, 5).frame(15, 15, 10, 10, solid(10, 10, 4))                    # 5 counts as 1
    g.gce(20, 2, 6).frame(0, 0, 40, 30, hole(40, 30, 5, 6))                 # disposal 2 and a transparent hole...
    g.frame(5, 5, 20, 10, hole(20, 10, 2, 6))                               # ...then an image without a GCE
    g.gce(10, 1).frame(0, 0, 0, 10, [])                                     # 0 pixels wide
    g.gce(10, 1, 12).frame(0, 20, 40, 10, [12 if i % 3 else 2 for i in range(400)], min_code=4)  # transparent index 12, past the 8 colours
    g.gce(10, 1).frame(30, 0, 10, 10, [i % 16 for i in range(100)], min_code=4)  # indexes 8 to 15: black
    return g


def oversized():
    g = Gif(40, 30, PAL16)
    g.gce(10, 1).frame(8, 6, 64, 48, checker(64, 48, 1, 2, 5))              # canvas: 72 x 54
    g.gce(10, 1).frame(2, 2, 10, 6, solid(10, 6, 3))
    g.gce(10, 1).frame(0, 0, 90, 70, checker(90, 70, 4, 7, 9))              # a later frame does not grow it
    return g


def gif87a():
    g = Gif(40, 30, None, version=b'87a', loop=None)                       # no global palette, no GCE
    g.frame(0, 0, 40, 30, checker(40, 30, 0, 1), local=[(10, 200, 30), (250, 250, 0)])
    g.frame(5, 5, 20, 10, solid(20, 10, 1), local=[(0, 0, 0), (200, 0, 200)])
    return g


def cut_off():
    rng = np.random.default_rng(3)
    g = Gif(40, 30, PAL16)
    for i in range(4):
        g.gce(10, 1).frame(0, 0, 40, 30, list(rng.integers(0, 16, 1200)))
    return g


def damaged():
    rng = np.random.default_rng(4)
    g = Gif(40, 30, PAL16)
    g.gce(10, 1).frame(0, 0, 40, 30, list(rng.integers(0, 16, 1200)))
    g.gce(10, 1).frame(0, 0, 40, 30, list(rng.integers(0, 16, 1200)), corrupt=(20, b'\xff' * 48))
    g.gce(10, 1).frame(10, 10, 10, 10, solid(10, 10, 2))
    return g


def timing():
    """481 x 271 (odd both ways): stripes, then a box that moves with delays of 100, 50, 20, 10
    (played as 100), 0 (played as 100), 70, 30 and 40 ms, and comes back."""
    W, H = 481, 271
    pal = [(255, 255, 255)] + [(20 + i * 14, 60 + (i * 37) % 180, 200 - i * 9) for i in range(14)] + [(10, 10, 10)]
    g = Gif(W, H, pal)
    g.gce(10, 1).frame(0, 0, W, H, [1 + (x // 37) % 14 for y in range(H) for x in range(W)])
    delays = [10, 5, 2, 1, 0, 7, 3, 4, 10, 5, 2, 1]
    for i, d in enumerate(delays):
        x, y = 20 + i * 34, 30 + (i % 4) * 50
        box = [15 if (bx < 6 or by < 6 or bx >= 54 or by >= 54) else 0 for by in range(60) for bx in range(60)]
        g.gce(d, 1).frame(x, y, 60, 60, box)
    return g


def pixel_art():
    """24 x 16 with a transparent background, 4 frames: a character that walks."""
    W, H = 24, 16
    pal = [(0, 0, 0), (255, 214, 170), (40, 90, 220), (200, 40, 40), (255, 255, 255), (30, 160, 60)]
    g = Gif(W, H, pal)
    for k in range(4):
        pix = []
        for y in range(H):
            for x in range(W):
                cx = 6 + k * 3
                if cx <= x < cx + 6 and 2 <= y < 7:
                    v = 1
                elif cx <= x < cx + 6 and 7 <= y < 12:
                    v = 2 if (x + y) % 2 else 3
                elif y >= 12 and (x == cx + (k % 2) or x == cx + 5 - (k % 2)):
                    v = 0
                elif y == 15:
                    v = 5
                else:
                    v = 4
                pix.append(v)
        g.gce(15, 2, 4).frame(0, 0, W, H, pix)
    return g


def loop3():
    g = Gif(20, 10, PAL16[:4], loop=3)
    g.gce(25, 1).frame(0, 0, 20, 10, solid(20, 10, 1)).gce(25, 1).frame(0, 0, 20, 10, solid(20, 10, 2))
    return g


def still():
    g = Gif(30, 20, PAL16[:4], loop=None)
    g.frame(0, 0, 30, 20, checker(30, 20, 0, 3, 5))
    return g


def main():
    exp = {'files': {}}
    model_only = {'oversized.gif', 'browser-rules.gif', 'cut-off.gif', 'damaged.gif'}
    made = [('unusual.gif', unusual()), ('browser-rules.gif', browser_rules()), ('oversized.gif', oversized()),
            ('gif87a.gif', gif87a()), ('cut-off.gif', cut_off()), ('damaged.gif', damaged()), ('timing.gif', timing()),
            ('pixel-art.gif', pixel_art()), ('loop3.gif', loop3()), ('still.gif', still())]
    for name, g in made:
        data = g.bytes()
        W, H, frames, delays, bad = g.model()
        path = os.path.join(HERE, name)
        entry = {'width': W, 'height': H, 'screen': [g.w, g.h], 'loopCount': g.loop}
        if name == 'cut-off.gif':
            whole = os.path.join(HERE, 'cut-off-whole.tmp.gif')
            open(whole, 'wb').write(data)
            iw, ih, im, = im_frames(whole)[:3]
            os.remove(whole)
            assert [frame_hash(f) for f in im[:3]] == [frame_hash(f) for f in frames[:3]], 'cut-off: model and ImageMagick differ'
            data = data[:g.offsets[3] + 60]  # inside the 4th frame's pixel data
            frames, delays = frames[:3], delays[:3]
            entry.update(truncated=True, partialFrame=True)
        else:
            entry.update(truncated=False, partialFrame=False)
        open(path, 'wb').write(data)
        if name not in model_only:
            iw, ih, im = im_frames(path)
            assert (iw, ih) == (W, H) and len(im) == len(frames), f'{name}: ImageMagick has {len(im)} frames of {iw} x {ih}'
            for i, (a, b) in enumerate(zip(frames, im)):
                assert frame_hash(a) == frame_hash(b), f'{name}: frame {i} differs from ImageMagick'
        # frameCount: the whole frames in the file; hashes: the frames that can be shown (all of
        # them, or those before damagedAt).
        entry.update(bytes=len(data), frameCount=len(delays), delays=delays, durations=[played(d) for d in delays],
                     hashes=[frame_hash(f) for f in frames], damagedAt=bad, checkedWithImageMagick=name not in model_only)
        exp['files'][name] = entry
        print(f'{name:18s} {len(data):7d} bytes  {W} x {H}  {len(delays)} frames' + (f', damaged at {bad}' if bad is not None else '') +
              ('' if name in model_only else '  (= ImageMagick)'))

    # A GIF as ffmpeg makes them: palettegen and paletteuse with Bayer dithering, and frames cut to
    # the rectangle that changed. Its expected frames come from ImageMagick.
    real = os.path.join(HERE, 'real.gif')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=240x136:rate=10:duration=3',
                    '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
                    '-loop', '0', '-y', real], check=True)
    iw, ih, im = im_frames(real)
    data = open(real, 'rb').read()
    ident = (magick() + ['identify']) if magick()[0] == 'magick' else ['identify']
    delays = [int(t) for t in subprocess.run(ident + ['-format', '%T ', real], capture_output=True, text=True, check=True).stdout.split()]
    exp['files']['real.gif'] = {'width': iw, 'height': ih, 'screen': [iw, ih], 'loopCount': 0, 'truncated': False, 'partialFrame': False,
                                'bytes': len(data), 'frameCount': len(im), 'delays': delays, 'durations': [played(d) for d in delays],
                                'hashes': [frame_hash(f) for f in im], 'damagedAt': None, 'checkedWithImageMagick': True}
    print(f'real.gif           {len(data):7d} bytes  {iw} x {ih}  {len(im)} frames (ffmpeg; frames from ImageMagick)')
    json.dump(exp, open(os.path.join(HERE, 'expected.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
