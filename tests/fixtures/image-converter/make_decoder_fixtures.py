# Fixtures for the shared decoder (assets/js/image-decode.js):
#   damaged.png       64 x 48 RGB gradient whose IDAT data is damaged from the
#                     middle on (every 7th byte flipped): its checksum fails and
#                     the zlib stream breaks about half way, so a browser draws
#                     the top half and leaves the rest blank and transparent.
#   png512-in.ico     an ICO whose one entry says 256 x 256 (0 in the directory)
#                     but holds a 512 x 512 PNG: left half blue, right half orange.
#   png48-dir256.ico  the same with a 48 x 48 green PNG.
#   p3.png            16 x 16, Display P3 profile in an iCCP chunk; stored colours
#                     (200, 100, 50) on the left, (0, 255, 1) on the right.
# Usage: python3 make_decoder_fixtures.py <out dir> <Display P3 .icc file>
import os, struct, sys, zlib

out, icc = sys.argv[1], open(sys.argv[2], 'rb').read()

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

def png(w, h, colour, extra=b''):
    rows = b''.join(b'\0' + b''.join(bytes(colour(x, y)) for x in range(w)) for y in range(h))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + extra + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')

def ico(p):
    return struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(p), 22) + p

def write(name, data):
    open(os.path.join(out, name), 'wb').write(data)

b = bytearray(png(64, 48, lambda x, y: (x * 4, y * 5, 128)))
i = bytes(b).index(b'IDAT') + 4
n = struct.unpack('>I', b[i - 8:i - 4])[0]
for k in range(n // 2, n - 8, 7):
    b[i + k] ^= 0x5A
write('damaged.png', bytes(b))
write('png512-in.ico', ico(png(512, 512, lambda x, y: (20, 60, 200) if x < 256 else (240, 140, 20))))
write('png48-dir256.ico', ico(png(48, 48, lambda x, y: (20, 160, 60))))
write('p3.png', png(16, 16, lambda x, y: (200, 100, 50) if x < 8 else (0, 255, 1), chunk(b'iCCP', b'Display P3\0\0' + zlib.compress(icc, 9))))
