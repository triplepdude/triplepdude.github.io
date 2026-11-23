#!/usr/bin/env python3
"""Makes the edge-*.gif test files for tests/tools/gif-to-mp4.test.js.

    python3 tests/fixtures/gif-to-mp4/make_edge_fixtures.py

Needs Python 3 only. These GIFs bend the rules in ways real files do (LZW data that stops early,
a full code table without a clear code, a stray byte between blocks, two Graphic Control
Extensions before one image, no trailer, no palette ...). The test decodes each one with
Chromium's own ImageDecoder, as the reference for what a browser shows, and checks that
assets/js/gif-frames.js gives the same frames, stopping at the same damaged frame, both with
ImageDecoder and with omggif (the path of browsers without ImageDecoder, such as Safari before
27.3). The LZW encoder here is written from Appendix F of the GIF89a specification, apart from
make_fixtures.py's.
"""
import os
import random
import struct

HERE = os.path.dirname(os.path.abspath(__file__))


class Bits:
    def __init__(self):
        self.out, self.acc, self.n = bytearray(), 0, 0

    def put(self, code, size):
        self.acc |= code << self.n
        self.n += size
        while self.n >= 8:
            self.out.append(self.acc & 255)
            self.acc >>= 8
            self.n -= 8

    def done(self):
        if self.n:
            self.out.append(self.acc & 255)
        return bytes(self.out)


def lzw(pixels, min_code, deferred_clear=False, eoi=True, stop_after=None, first_clear=True):
    """GIF LZW. deferred_clear: once the table is full, go on with 12-bit codes and no clear code.
    stop_after: code only that many pixels. eoi=False: no end code (the data just ends)."""
    clear, end = 1 << min_code, (1 << min_code) + 1
    bits, size, table, nxt = Bits(), min_code + 1, {}, end + 1
    if first_clear:
        bits.put(clear, size)
    px = list(pixels if stop_after is None else pixels[:stop_after])
    if px:
        cur = (px[0],)
        for k in px[1:]:
            cand = cur + (k,)
            if cand in table:
                cur = cand
                continue
            bits.put(table[cur] if len(cur) > 1 else cur[0], size)
            if nxt < 4096:
                table[cand] = nxt
                nxt += 1
                if nxt - 1 == 1 << size and size < 12:  # the decoder widens once its next entry is 1 << size
                    size += 1
            elif not deferred_clear:
                bits.put(clear, size)
                table, nxt, size = {}, end + 1, min_code + 1
            cur = (k,)
        bits.put(table[cur] if len(cur) > 1 else cur[0], size)
        if nxt < 4096:
            nxt += 1
            if nxt - 1 == 1 << size and size < 12:
                size += 1
    if eoi:
        bits.put(end, size)
    return bits.done()


def blocks(data, n=255):
    out = bytearray()
    for i in range(0, len(data), n):
        out.append(len(data[i:i + n]))
        out += data[i:i + n]
    return bytes(out) + b'\x00'


def palette(colours, bits):
    colours = list(colours)[:1 << bits]
    return b''.join(bytes(c) for c in colours + [(0, 0, 0)] * ((1 << bits) - len(colours)))


def header(w, h, gct=None, bits=4, version=b'89a'):
    flags = 0x80 | ((bits - 1) << 4) | (bits - 1) if gct is not None else 0
    return b'GIF' + version + struct.pack('<HHBBB', w, h, flags, 0, 0) + (palette(gct, bits) if gct is not None else b'')


def loop(n):
    return b'\x21\xff\x0bNETSCAPE2.0\x03\x01' + struct.pack('<H', n) + b'\x00'


def gce(delay, disposal=0, trans=None, size=4):
    body = bytes([(disposal << 2) | (trans is not None)]) + struct.pack('<H', delay) + bytes([trans or 0])
    body = (body + b'\x00' * size)[:size]
    return b'\x21\xf9' + bytes([size]) + body + b'\x00'


def image(x, y, w, h, pixels, min_code=None, local=None, lbits=2, interlaced=False, data=None, extra=0, sub=255, **kw):
    flags = (0x80 | (lbits - 1) if local is not None else 0) | (0x40 if interlaced else 0)
    rows = [pixels[r * w:(r + 1) * w] for r in range(h)]
    if interlaced:
        rows = [rows[r] for r in list(range(0, h, 8)) + list(range(4, h, 8)) + list(range(2, h, 4)) + list(range(1, h, 2))]
    flat = [v for row in rows for v in row]
    flat += flat[:extra]
    if min_code is None:
        min_code = max(2, (max(flat) if flat else 1).bit_length())
    coded = data if data is not None else lzw(flat, min_code, **kw)
    return (b'\x2c' + struct.pack('<HHHHB', x, y, w, h, flags) + (palette(local, lbits) if local is not None else b'') +
            bytes([min_code]) + blocks(coded, sub))


PAL = [(255, 255, 255), (230, 20, 20), (20, 180, 40), (20, 40, 230), (250, 210, 0), (0, 0, 0), (140, 0, 160), (0, 210, 210),
       (255, 140, 0), (100, 100, 100), (200, 200, 200), (120, 50, 0), (0, 0, 110), (255, 0, 255), (160, 230, 160), (15, 15, 15)]
END = b'\x3b'


def solid(w, h, c):
    return [c] * (w * h)


def stripes(w, h, a, b, s=3):
    return [a if (i % w) // s % 2 == 0 else b for i in range(w * h)]


def files():
    f = {}
    two = lambda second: header(20, 20, PAL) + loop(0) + gce(10, 1) + image(0, 0, 20, 20, stripes(20, 20, 1, 2)) + gce(10, 1) + second + \
        gce(10, 1) + image(5, 5, 10, 10, solid(10, 10, 6)) + END
    # LZW data that codes 300 of the frame's 400 pixels, then the end code; then without it; then none
    f['short-lzw'] = two(image(0, 0, 20, 20, stripes(20, 20, 3, 4), stop_after=300))
    f['short-noeoi'] = two(image(0, 0, 20, 20, stripes(20, 20, 3, 4), stop_after=300, eoi=False))
    f['empty-data'] = two(image(0, 0, 20, 20, [], data=b''))
    bad = lzw(stripes(20, 20, 3, 4), 2)
    f['bad-code-late'] = two(image(0, 0, 20, 20, [], min_code=2, data=bad[:-3] + b'\xff\xff\xff'))  # an undefined code near the end
    f['mincode9'] = two(image(0, 0, 8, 8, solid(8, 8, 2), min_code=9))                          # code size over 8
    rnd = random.Random(7)
    pal256 = [((i * 37) % 256, (i * 91) % 256, (i * 151) % 256) for i in range(256)]
    f['deferred-clear'] = (header(100, 80, pal256, 8) + gce(10, 1) +
                           image(0, 0, 100, 80, [rnd.randrange(256) for _ in range(8000)], min_code=8, deferred_clear=True) +
                           gce(10, 1) + image(10, 10, 50, 40, [rnd.randrange(256) for _ in range(2000)], min_code=8) + END)
    f['no-first-clear'] = header(16, 16, PAL) + gce(10, 1) + image(0, 0, 16, 16, stripes(16, 16, 1, 2), first_clear=False) + END
    f['tiny-blocks'] = header(20, 20, PAL) + gce(10, 1) + image(0, 0, 20, 20, stripes(20, 20, 1, 2), sub=1) + END
    # block structure
    f['two-gce'] = (header(20, 20, PAL) + loop(0) + gce(10, 1) + image(0, 0, 20, 20, solid(20, 20, 1)) +
                    gce(50, 2) + gce(20, 1, 2) + image(0, 0, 20, 20, stripes(20, 20, 2, 3)) + gce(10, 1) + image(5, 5, 10, 10, solid(10, 10, 4)) + END)
    f['gce5'] = (header(20, 20, PAL) + gce(10, 1) + image(0, 0, 20, 20, solid(20, 20, 1)) + gce(20, 1, size=5) +
                 image(0, 0, 10, 10, solid(10, 10, 2)) + gce(10, 1) + image(10, 10, 10, 10, solid(10, 10, 3)) + END)
    f['stray00'] = header(20, 20, PAL) + gce(10, 1) + image(0, 0, 20, 20, solid(20, 20, 1)) + b'\x00' + gce(10, 1) + image(0, 0, 10, 10, solid(10, 10, 2)) + END
    f['notrailer'] = header(20, 20, PAL) + gce(10, 1) + image(0, 0, 20, 20, solid(20, 20, 1)) + gce(10, 1) + image(0, 0, 10, 10, solid(10, 10, 2))
    f['trailing'] = header(20, 20, PAL) + gce(10, 1) + image(0, 0, 20, 20, solid(20, 20, 1)) + gce(10, 1) + image(0, 0, 10, 10, solid(10, 10, 2)) + END + b'bytes after the trailer' * 4
    f['netscape-odd'] = (header(16, 16, PAL) + b'\x21\xff\x0bNETSCAPE2.0\x05\x02\x00\x10\x00\x00\x03\x01\xff\xff\x00' +
                         gce(10, 1) + image(0, 0, 16, 16, solid(16, 16, 1)) + gce(10, 1) + image(0, 0, 16, 16, solid(16, 16, 2)) + END)
    # palettes and transparency
    f['nopal'] = (header(16, 16) + gce(10, 1) + image(0, 0, 16, 16, stripes(16, 16, 1, 2)) + gce(10, 1) +
                  image(0, 0, 8, 8, solid(8, 8, 3), local=[(250, 0, 0), (0, 250, 0), (0, 0, 250), (250, 250, 0)]) + END)
    f['trans-past'] = (header(16, 16, PAL[:4], 2) + gce(10, 1) + image(0, 0, 16, 16, solid(16, 16, 1)) +
                       gce(10, 1, 9) + image(0, 0, 16, 16, [9 if i % 2 else (12 if i % 3 else 2) for i in range(256)], min_code=4) + END)
    # frames, disposal, interlacing
    f['interlace-extra'] = header(9, 11, PAL) + gce(10, 1) + image(0, 0, 9, 11, [(i // 9) % 16 for i in range(99)], interlaced=True, extra=25) + END
    hole = [5 if (4 <= i % 16 < 12 and 4 <= i // 16 < 12) else 1 for i in range(256)]
    f['disp2-first'] = (header(16, 16, PAL) + gce(10, 2, 5) + image(0, 0, 16, 16, hole) + gce(10, 1) + image(2, 2, 6, 6, solid(6, 6, 3)) +
                        gce(10, 3) + image(8, 8, 8, 8, solid(8, 8, 4)) + gce(10, 1, 0) + image(0, 0, 16, 16, [0 if i % 5 else 6 for i in range(256)]) + END)
    f['disp3-chain'] = (header(20, 20, PAL) + gce(10, 3, 0) + image(0, 0, 20, 20, [0 if i % 3 else 1 for i in range(400)]) +
                        gce(10, 3) + image(5, 5, 10, 10, solid(10, 10, 2)) + gce(10, 3) + image(0, 0, 10, 10, solid(10, 10, 3)) +
                        gce(10, 1) + image(10, 10, 10, 10, solid(10, 10, 4)) + END)
    f['layers'] = header(24, 24, PAL) + loop(0) + b''.join(gce(0, 1) + image((i % 3) * 8, (i // 3) * 8, 8, 8, solid(8, 8, 1 + i)) for i in range(6)) + END
    f['zero-h'] = (header(16, 16, PAL) + gce(10, 1) + image(0, 0, 16, 16, solid(16, 16, 1)) + gce(10, 2) +
                   image(0, 0, 16, 0, [], data=lzw([], 2)) + gce(10, 1) + image(4, 4, 4, 4, solid(4, 4, 2)) + END)
    # the canvas
    f['oversize-x'] = header(20, 20, PAL) + gce(10, 1) + image(6, 2, 20, 10, stripes(20, 10, 1, 2)) + gce(10, 1) + image(0, 0, 30, 30, solid(30, 30, 3)) + END
    f['small-first'] = header(30, 20, PAL) + gce(10, 1) + image(5, 4, 10, 8, solid(10, 8, 2)) + gce(10, 1) + image(12, 6, 8, 8, solid(8, 8, 3)) + END
    f['gif87a-small'] = header(30, 20, PAL, version=b'87a') + image(5, 4, 10, 8, solid(10, 8, 2)) + image(12, 6, 8, 8, solid(8, 8, 3)) + END
    return f


def main():
    for name, data in files().items():
        with open(os.path.join(HERE, 'edge-' + name + '.gif'), 'wb') as out:
            out.write(data)
        print(f'edge-{name}.gif  {len(data)} bytes')


if __name__ == '__main__':
    main()
