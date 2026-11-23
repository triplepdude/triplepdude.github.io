#!/usr/bin/env python3
"""Builds the sample videos for tests/tools/mov-to-mp4.test.js (ffmpeg 6.1).

Run from anywhere: python3 tests/fixtures/mov-to-mp4/make_fixtures.py
Every file is small (under 300 KB). Larger inputs (an hour-long, multi-gigabyte
MOV) are built by the test itself from intra.mov. The test reads the facts it
checks about each source and each output with ffprobe and ffmpeg when it
runs (verify.py), never with the page's own library.
"""
import json
import os
import random
import struct
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FF = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
SRC = 'testsrc2=size={w}x{h}:rate={r}'


def run(args):
    subprocess.run(FF + args, check=True)


def out(name):
    return os.path.join(HERE, name)


def video_in(w, h, r=30, d=2):
    return ['-f', 'lavfi', '-i', SRC.format(w=w, h=h, r=r) + f':duration={d}']


def tone(freq, d=2, sr=48000):
    return ['-f', 'lavfi', '-i', f'sine=frequency={freq}:sample_rate={sr}:duration={d}']


def chirp(d, sr):
    # A rising sweep (it never repeats, so the sound can be lined up exactly)
    # and a click at exactly half a second, to measure sync after re-encoding.
    click = sr // 2
    return ['-f', 'lavfi', '-i', f"aevalsrc='0.3*sin(2*PI*(150+900*t)*t)+if(between(n\\,{click}\\,{click + 40})\\,0.6\\,0)':s={sr}:d={d}"]


def insert_box(src, dst, path, box):
    """Appends `box` inside the box at `path` and grows every box around it."""
    data = bytearray(open(src, 'rb').read())
    parents, start, end = [], 0, len(data)
    for name in path:
        p = start
        while p < end:
            size, kind = struct.unpack('>I4s', data[p:p + 8])
            if kind.decode('latin1') == name:
                break
            p += size
        else:
            raise SystemExit(f'{name} not found')
        parents.append(p)
        # stsd has 8 bytes (version, flags, count) and a visual sample entry 78 before its children.
        skip = 16 if name == 'stsd' else 86 if name == 'hvc1' else 8
        start, end = p + skip, p + size
    insert_at = end
    data[insert_at:insert_at] = box
    for p in parents:
        size = struct.unpack('>I', data[p:p + 4])[0]
        struct.pack_into('>I', data, p, size + len(box))
    open(dst, 'wb').write(data)


def make():
    tmp = tempfile.mkdtemp()
    T = lambda n: os.path.join(tmp, n)

    # 1. Like an iPhone video: HEVC with B-frames, coded 640x360 and shown as
    # portrait by a 90-degree rotation, AAC stereo, a creation time in mvhd and
    # Apple's keys (location, make, model, software, local-time date).
    run(video_in(640, 360, 30, 2) + tone(440) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:bframes=3', '-crf', '30',
        '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', T('hevc.mov')])
    run(['-display_rotation', '90', '-i', T('hevc.mov'), '-map', '0', '-c', 'copy',
         '-metadata', 'creation_time=2025-06-01T10:20:30Z',
         '-metadata', 'com.apple.quicktime.location.ISO6709=+51.5074-000.1278+010.000/',
         '-metadata', 'com.apple.quicktime.make=Apple',
         '-metadata', 'com.apple.quicktime.model=iPhone 16',
         '-metadata', 'com.apple.quicktime.software=18.1',
         '-metadata', 'com.apple.quicktime.creationdate=2025-06-01T11:20:30+0100',
         '-movflags', 'use_metadata_tags', out('iphone-hevc.mov')])

    # 2. iPhone 16 style: the same plus a second sound track whose sample entry
    # says 'apac' (Apple Positional Audio Codec, spatial audio). ffmpeg cannot
    # write APAC, so an AAC track is relabelled; the page cannot read either.
    run(video_in(320, 180, 30, 1) + tone(440, 1) + tone(880, 1) + ['-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-crf', '32', '-tag:v', 'hvc1',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-metadata', 'creation_time=2025-07-04T18:00:00Z', T('spatial.mov')])
    data = bytearray(open(T('spatial.mov'), 'rb').read())
    # Each AAC track names 'mp4a' three times in a MOV: its sample entry, and
    # the 'frma' and 'mp4a' boxes of its 'wave' extension. Relabel all three
    # in the second track, and hide its AAC configuration ('esds' becomes
    # 'free'), so that nothing in it says AAC any more.
    entries = [i for i in range(len(data) - 8) if data[i:i + 4] == b'mp4a']
    assert len(entries) == 6, entries
    for i in entries[3:]:
        data[i:i + 4] = b'apac'
    esds = [i for i in range(len(data) - 8) if data[i:i + 4] == b'esds']
    assert len(esds) == 2, esds
    data[esds[1]:esds[1] + 4] = b'free'
    open(out('iphone-spatial.mov'), 'wb').write(data)

    # 3. HDR: 10-bit HEVC, BT.2020 primaries, HLG transfer.
    run(video_in(320, 180, 30, 1) + tone(500, 1) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
        '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
        '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '1', out('hdr-hlg.mov')])

    # 3b. iPhone HDR is Dolby Vision profile 8.4: HLG HEVC whose sample entry
    # also holds a 'dvvC' box. ffmpeg cannot write one from scratch, so the
    # box (profile 8, level 4, with RPU and base layer, HLG-compatible) is
    # added to the HLG file's hvc1 entry; the index is at the end, so no
    # chunk offset moves.
    insert_box(out('hdr-hlg.mov'), out('iphone-dolby-vision.mov'), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1'],
               struct.pack('>I4sBBHB', 32, b'dvvC', 1, 0, (8 << 9) | (4 << 3) | (1 << 2) | 1, 4 << 4) + bytes(19))

    # 4. H.264 High with B-frames, a timecode track and an edit list: cut by
    # stream copy from 1.3 s, so the copy starts at the key frame before it.
    run(video_in(480, 270, 30, 4) + tone(600, 4) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '30', '-crf', '30', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '64k', '-timecode', '10:00:00:00', T('tc.mov')])
    run(['-ss', '1.3', '-i', T('tc.mov'), '-map', '0:v', '-map', '0:a', '-c', 'copy', '-t', '2', out('h264-timecode-trimmed.mov')])

    # 5. H.264 with 16-bit PCM sound ('sowt'), as some cameras and screen recorders write.
    run(video_in(320, 180, 30, 1) + chirp(1, 44100) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', out('h264-pcm16.mov')])

    # 6. ProRes 422 with 24-bit PCM sound.
    # ProRes 422 tagged BT.709, as cameras and editors write it, with 24-bit PCM.
    run(video_in(160, 90, 25, 0.6) + chirp(0.6, 48000) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'prores_ks', '-profile:v', '2', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-c:a', 'pcm_s24le', '-ac', '2', out('prores422-pcm24.mov')])

    # 7. ProRes 4444 with an alpha channel, no sound.
    run(['-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=25:duration=0.4,format=yuva444p10le,geq=lum=lum(X\\,Y):cb=cb(X\\,Y):cr=cr(X\\,Y):a=if(lt(X\\,64)\\,1023\\,512)',
         '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', out('prores4444-alpha.mov')])

    # 8. Motion JPEG with PCM, as old cameras write: not readable by the page.
    run(video_in(320, 240, 30, 0.5) + tone(700, 0.5, 32000) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'mjpeg', '-q:v', '12', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le', '-ac', '1', out('mjpeg-pcm.mov')])

    # 9. AAC plus Apple Lossless (ALAC): the ALAC track cannot be read.
    run(video_in(320, 180, 30, 1) + tone(500, 1) + tone(800, 1) + ['-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p',
        '-c:a:0', 'aac', '-b:a:0', '64k', '-c:a:1', 'alac', out('aac-alac.mov')])

    # 10. Two AAC sound tracks in two languages and a subtitle track.
    with open(T('subs.srt'), 'w') as f:
        f.write('1\n00:00:00,000 --> 00:00:01,000\nHello\n')
    run(video_in(320, 180, 30, 1) + tone(500, 1) + tone(900, 1) + ['-i', T('subs.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
        '-c:s', 'mov_text', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', out('two-languages.mov')])

    # 11. Variable frame rate, no sound: 1 s at 30 fps, then 1 s at 10 fps.
    run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1',
         '-filter_complex', '[0:v]settb=1/90000[a];[1:v]settb=1/90000[b];[a][b]concat=n=2:v=1[v]', '-map', '[v]', '-fps_mode', 'vfr',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000', out('vfr-silent.mov')])

    # 12. Rotations of 180 and 270 degrees.
    run(video_in(320, 180, 30, 1) + ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', T('plain.mov')])
    for deg in (180, 270):
        run(['-display_rotation', str(deg), '-i', T('plain.mov'), '-c', 'copy', out(f'rotated-{deg}.mov')])

    # 13. VP9 at an odd size (1365x767) with Opus, and AV1 with Opus, in MP4, tagged BT.709
    # so that every decoder reads their colours the same way.
    # testsrc2 rounds a 4:2:0 size down to even numbers, so the odd size is cut from RGB.
    run(['-f', 'lavfi', '-i', 'testsrc2=size=1366x768:rate=30:duration=1,format=rgb24,crop=1365:767:0:0'] + chirp(1, 48000) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '48k', out('vp9-odd-size.mp4')])
    run(video_in(320, 180, 30, 1) + chirp(1, 48000) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '45', '-b:v', '0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'libopus', '-b:a', '48k', out('av1-opus.mp4')])

    # The same, shown turned by 90 degrees: the size H.264 needs is the coded one.
    run(['-display_rotation', '90', '-i', out('vp9-odd-size.mp4'), '-c', 'copy', out('vp9-odd-rotated.mp4')])

    # 13b. A WebM screen recording: VP9 and Opus.
    run(video_in(320, 180, 30, 1) + tone(500, 1) + ['-map', '0:v', '-map', '1:a',
        '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '48k', out('screen.webm')])

    # 14. Sound only (no video track).
    run(tone(440, 2) + ['-c:a', 'aac', '-b:a', '64k', '-f', 'mov', out('sound-only.mov')])

    # 15. A QuickTime MOV saved with an .mp4 name.
    run(video_in(320, 180, 30, 1) + tone(500, 1) + ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-f', 'mov', out('quicktime-named.mp4')])

    # 15b. An Android phone's MP4: H.264 and AAC, with the place it was filmed in a
    # '\xa9xyz' box in moov/udta (ISO 6709 text, as Android's MediaMuxer writes it;
    # ffmpeg itself would write a 3GPP 'loci' box).
    run(video_in(320, 180, 30, 1) + tone(500, 1) + ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-metadata', 'creation_time=2026-03-04T05:06:07Z', T('android.mp4')])
    xyz = b'+48.8584+002.2945/'
    body = struct.pack('>HH', len(xyz), 0x15c7) + xyz
    insert_box(T('android.mp4'), out('android-location.mp4'), ['moov', 'udta'], struct.pack('>I', 8 + len(body)) + b'\xa9xyz' + body)

    # 16. Damaged files. Cut off: moov first (fast start) and then only 60% of the
    # data; and moov last with the file ending before it. Garbage: 3 KB of
    # random bytes over the middle of the media data.
    run(video_in(320, 180, 30, 2) + tone(500) + ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-crf', '30',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', T('fast.mov')])
    whole = open(T('fast.mov'), 'rb').read()
    open(out('cut-off.mov'), 'wb').write(whole[:int(len(whole) * 0.6)])
    run(video_in(320, 180, 30, 2) + tone(500) + ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-crf', '30',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', T('slow.mov')])
    whole = open(T('slow.mov'), 'rb').read()
    moov = whole.rfind(b'moov') - 4
    open(out('cut-before-index.mov'), 'wb').write(whole[:moov - 1000])
    rnd = random.Random(52)
    data = bytearray(open(T('slow.mov'), 'rb').read())
    mdat = data.find(b'mdat')
    mid = mdat + (moov - mdat) // 2
    data[mid:mid + 3000] = bytes(rnd.randrange(256) for _ in range(3000))
    open(out('garbage-inside.mov'), 'wb').write(data)
    # Wrong settings: the index is whole, but the H.264 settings (avcC) say
    # that each unit's length takes 3 bytes instead of 4. The library still
    # calls such a copy valid, yet it comes out without its video.
    data = bytearray(open(T('slow.mov'), 'rb').read())
    avcc = data.find(b'avcC') + 4
    data[avcc + 4] = (data[avcc + 4] & 0xfc) | 2
    open(out('bad-nal-length.mov'), 'wb').write(data)
    # An index that lists far more frames than it has sizes for: it points outside the file.
    data = bytearray(open(T('slow.mov'), 'rb').read())
    stsz = data.find(b'stsz') + 4
    struct.pack_into('>I', data, stsz + 8, 0x7fffffff)
    open(out('bad-sample-count.mov'), 'wb').write(data)

    # 17. Not a video: an empty file, and text with a video's name.
    open(out('empty.mov'), 'wb').close()
    with open(out('notes.mov'), 'w') as f:
        f.write('These are meeting notes, not a video.\n' * 20)

    # 18. All-intra H.264 frames for the test's own hour-long, multi-gigabyte MOV.
    run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=0.3', '-c:v', 'libx264', '-preset', 'veryfast',
         '-g', '1', '-bf', '0', '-crf', '30', '-pix_fmt', 'yuv420p', out('intra.mov')])


def main():
    make()
    for n in sorted(os.listdir(HERE)):
        if n.endswith(('.mov', '.mp4', '.webm')):
            print(f'{os.path.getsize(out(n)):>8}  {n}')


if __name__ == '__main__':
    main()
