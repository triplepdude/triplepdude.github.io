"""Makes square-o6.webp for tests/tools/crop-image-circle.test.js (Pillow).

square-o6.webp: lossless WebP, stored 96 x 96 with a (220, 30, 30) band along the
top 24 rows and (235, 235, 235) elsewhere, and EXIF Orientation 6. Browsers ignore
the EXIF orientation of a WebP; turned upright, the band runs down the right side.
Being square, it cannot be told apart from the unturned picture by its size.

The other files of the damaged-file checks are copies:
  cut.avif, damaged.avif   from tests/fixtures/avif-to-jpg/
  cut.webp, rotated.webp, anim.webp   from tests/fixtures/webp-to-png/
  cut.jpg, early.jpg, motion.jpg   from tests/fixtures/jpg-to-png/
  cut.png   tests/fixtures/image-converter/cut-big.png
"""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

img = Image.new('RGB', (96, 96), (235, 235, 235))
img.paste((220, 30, 30), (0, 0, 96, 24))
exif = Image.Exif()
exif[0x0112] = 6
img.save(os.path.join(HERE, 'square-o6.webp'), 'WEBP', lossless=True, exif=exif.tobytes())
