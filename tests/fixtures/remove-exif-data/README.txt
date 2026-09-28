Test photos for remove-exif-data. All were made for these tests; none is a real photo.

gps-rotated.jpg, le-progressive-o8.jpg, meta.png, meta.webp, plain.jpg
  JPEG/PNG/WebP with EXIF (GPS, camera, orientation), XMP, IPTC, comments and ICC.
gps.heic, gps.avif, rot6.heic, multi.heic
  Written with pillow-heif 1.8 / Pillow 12.3 (libheif, libavif) from flat colour
  blocks, with piexif EXIF (GPS, camera, exposure) and an XMP packet. rot6.heic has
  EXIF orientation 6 and an irot property; multi.heic is a 600x400 grid of 256 px
  tiles plus a second top-level image with its own Exif item.
meta.tif
  Hand-written little-endian TIFF (Python struct): two pages, uncompressed RGB strips
  stored out of order, Make/Model/Artist/HostComputer/XMP/IPTC tags, EXIF and GPS IFDs.
tiled-o8.tif
  tifffile 2026.3.3: big-endian, 16x16 tiles, RGBA, Orientation 8, XMP.
meta.gif
  Pillow two-frame GIF with a comment, plus an XMP ("XMP DataXMP") application block,
  an ImageMagick IPTC block and bytes after the trailer, added by hand.
pages.tif
  Pillow two-page uncompressed RGB TIFF (30x20, red left / blue right; page 2 flipped),
  Artist tag on both pages, Orientation 6 on page 1 and 3 on page 2 (patched by hand).
