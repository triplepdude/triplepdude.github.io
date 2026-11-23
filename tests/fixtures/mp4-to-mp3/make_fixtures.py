#!/usr/bin/env python3
"""Builds the sample files for tests/tools/mp4-to-mp3.test.js and writes
expected.json, the facts the test checks against, as ffprobe reports them.

Needs ffmpeg and ffprobe (6.x). Run from any folder:
    python3 tests/fixtures/mp4-to-mp3/make_fixtures.py

Signals (amplitudes are of the sine, so RMS = amplitude / sqrt 2):
  clip.mp4   6 s, H.264 64x36 + AAC-LC 48 kHz stereo 128 kbps. Left 0.5 and
             right 0.25 of the same tone: 440 Hz for 0-2 s, 660 Hz for 2-4 s,
             880 Hz for 4-6 s. Title "Fixture clip", artist "Test Artist".
  phone.mov  2 s QuickTime, H.264 + AAC-LC 44.1 kHz mono, 523.25 Hz at 0.4.
  voice.webm 3 s Opus mono 48 kHz, 300 Hz at 0.4, no video.
  chirp.wav  1 s PCM s16le 44.1 kHz stereo; left a chirp 200 Hz + 2000 Hz/s,
             right the same at half amplitude, so no two windows match.
  dolby.mkv  2 s AC-3 stereo 48 kHz (Chromium cannot decode AC-3).
  two-langs.mkv  2 s, two Opus tracks: English 440 Hz, French 880 Hz.
  protected.mp4  2 s AAC with CENC (cenc-aes-ctr) encryption, like DRM.
  silent-video.mp4  1 s of H.264 with no audio track.
  not-media.mp4  plain text with a video name.
  cut-short.mp4  clip.mp4 with its index moved to the front, cut off after
             50,000 bytes, like a copy or download that did not finish: the
             index lists 6 s of sound, the data holds less than 3 s.
  cover.m4a  1 s of AAC 44.1 kHz mono, 440 Hz, with a 32x32 JPEG cover and
             the title "Cover test".
  long-claim.m4a  0.1 s of AAC whose sample table claims 61.5 minutes, for
             the length limit of browsers that decode a whole track at once.
"""
import hashlib
import json
import os
import struct
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))


def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, cwd=HERE)


def probe(name, *extra):
    out = subprocess.run(['ffprobe', '-v', 'error', '-of', 'json', *extra, name],
                         check=True, cwd=HERE, capture_output=True, text=True).stdout
    return json.loads(out)


TONE = "if(lt(t,2),440,if(lt(t,4),660,880))"
# Phase as the integral of the stepped frequency, so the tone is continuous.
PHASE = "if(lt(t,2),440*t,if(lt(t,4),880+660*(t-2),2200+880*(t-4)))"
VIDEO = ['-f', 'lavfi', '-i', 'color=c=0x1f6f4a:s=64x36:r=5']
X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '10']

ff(*VIDEO, '-f', 'lavfi', '-i',
   f"aevalsrc='0.5*sin(2*PI*({PHASE}))|0.25*sin(2*PI*({PHASE}))':s=48000:d=6",
   '-t', '6', *X264, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
   '-metadata', 'title=Fixture clip', '-metadata', 'artist=Test Artist',
   '-shortest', 'clip.mp4')
ff(*VIDEO, '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*523.25*t)':s=44100:d=2",
   '-t', '2', *X264, '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-shortest', '-f', 'mov', 'phone.mov')
ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)':s=48000:d=3",
   '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', 'voice.webm')
ff('-f', 'lavfi', '-i',
   "aevalsrc='0.6*sin(2*PI*(200*t+1000*t*t))|0.3*sin(2*PI*(200*t+1000*t*t))':s=44100:d=1",
   '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', 'chirp.wav')
ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)|0.4*sin(2*PI*440*t)':s=48000:d=2",
   '-c:a', 'ac3', '-b:a', '192k', 'dolby.mkv')
ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=48000:d=2",
   '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*880*t)':s=48000:d=2",
   '-map', '0:a', '-map', '1:a', '-c:a', 'libopus', '-b:a', '48k',
   '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra',
   '-metadata:s:a:1', 'title=Commentaire', 'two-langs.mkv')
ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=48000:d=2",
   '-c:a', 'aac', '-b:a', '96k', '-encryption_scheme', 'cenc-aes-ctr',
   '-encryption_key', '00112233445566778899aabbccddeeff',
   '-encryption_kid', '0123456789abcdef0123456789abcdef', 'protected.mp4')
ff(*VIDEO, '-t', '1', *X264, 'silent-video.mp4')
with open(os.path.join(HERE, 'not-media.mp4'), 'w') as f:
    f.write('This is a text file with a video name, not a video.\n')
ff('-i', 'clip.mp4', '-c', 'copy', '-movflags', '+faststart', 'cut-short.mp4')
with open(os.path.join(HERE, 'cut-short.mp4'), 'r+b') as f:
    f.truncate(50000)
ff('-f', 'lavfi', '-i', 'color=c=0xc81e3c:s=32x32', '-frames:v', '1', 'cover.jpg')
ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)':s=44100:d=1", '-i', 'cover.jpg',
   '-map', '0:a', '-map', '1', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-c:v', 'copy',
   '-disposition:v', 'attached_pic', '-metadata', 'title=Cover test', 'cover.m4a')


def boxes(buf, off, end):
    while off + 8 <= end:
        size, typ = struct.unpack('>I4s', buf[off:off + 8])
        yield off, size, typ.decode('latin1')
        if typ in (b'moov', b'trak', b'mdia', b'minf', b'stbl', b'edts'):
            yield from boxes(buf, off + 8, off + size)
        off += size


ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)':s=48000:d=0.1", '-c:a', 'aac', '-b:a', '32k',
   '-ac', '1', '-fflags', '+bitexact', '-map_metadata', '-1', 'long-claim.m4a')
LONG_MS = 3690000  # 61.5 minutes
with open(os.path.join(HERE, 'long-claim.m4a'), 'rb') as f:
    buf = bytearray(f.read())
for off, size, typ in boxes(buf, 0, len(buf)):
    if typ == 'stts':
        n = struct.unpack('>I', buf[off + 12:off + 16])[0]
        last = off + 16 + (n - 1) * 8
        count, delta = struct.unpack('>II', buf[last:last + 8])
        assert count == 1
        frames = sum(struct.unpack('>I', buf[off + 16 + i * 8:off + 20 + i * 8])[0] *
                     struct.unpack('>I', buf[off + 20 + i * 8:off + 24 + i * 8])[0] for i in range(n - 1))
        struct.pack_into('>I', buf, last + 4, LONG_MS * 48 - frames)
    elif typ == 'mdhd':
        struct.pack_into('>I', buf, off + 24, LONG_MS * 48)
    elif typ in ('mvhd', 'tkhd'):
        struct.pack_into('>I', buf, off + (24 if typ == 'mvhd' else 28), LONG_MS)
    elif typ == 'elst':
        struct.pack_into('>I', buf, off + 16, LONG_MS)
with open(os.path.join(HERE, 'long-claim.m4a'), 'wb') as f:
    f.write(buf)

expected = {}
for name in ['clip.mp4', 'phone.mov', 'voice.webm', 'chirp.wav', 'dolby.mkv', 'two-langs.mkv', 'protected.mp4', 'long-claim.m4a']:
    info = probe(name, '-show_streams', '-show_format')
    streams = [s for s in info['streams'] if s['codec_type'] == 'audio']
    expected[name] = {
        'size': os.path.getsize(os.path.join(HERE, name)),
        'duration': float(info['format']['duration']),
        'audio': [{'codec': s['codec_name'], 'sample_rate': int(s['sample_rate']), 'channels': s['channels'],
                   'language': s.get('tags', {}).get('language')} for s in streams],
    }
# The AAC packets of clip.mp4, to show that "Original audio" copies them
# byte for byte.
pk = probe('clip.mp4', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'SHA256')
expected['clip.mp4']['packets'] = [{'pts': float(p['pts_time']), 'dur': float(p['duration_time']),
                                     'size': int(p['size']), 'sha256': p['data_hash'].split(':', 1)[1]}
                                    for p in pk['packets']]


def incomplete_and_cover():
    """cut-short.mp4: the samples ffmpeg can decode from what is left (its
    index still claims 6 s). cover.m4a: the SHA-256 of the JPEG inside it."""
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'cut-short.mp4', '-map', '0:a', '-f', 's16le', '-'],
                         cwd=HERE, capture_output=True, check=True).stdout
    out = {'cut-short.mp4': {'size': os.path.getsize(os.path.join(HERE, 'cut-short.mp4')),
                             'listed_duration': float(probe('cut-short.mp4', '-show_format')['format']['duration']),
                             'decoded_samples': len(pcm) // 4}}
    with open(os.path.join(HERE, 'cover.jpg'), 'rb') as f:
        out['cover.m4a'] = {'size': os.path.getsize(os.path.join(HERE, 'cover.m4a')),
                            'jpeg_sha256': hashlib.sha256(f.read()).hexdigest()}
    os.remove(os.path.join(HERE, 'cover.jpg'))
    return out


def peak_db(name, start=None, end=None):
    """Overall peak of the decoded audio in dBFS, as ffmpeg's astats reports it."""
    af = (f'atrim={start}:{end},' if start is not None else '') + 'astats=metadata=0'
    err = subprocess.run(['ffmpeg', '-hide_banner', '-i', name, '-af', af, '-f', 'null', '-'],
                         cwd=HERE, capture_output=True, text=True).stderr
    overall = err.split('Overall')[-1]
    return float(overall.split('Peak level dB:')[1].split()[0])


expected['clip.mp4']['peak_db'] = peak_db('clip.mp4')
expected['clip.mp4']['peak_db_4.5_5.5'] = peak_db('clip.mp4', 4.5, 5.5)
expected['clip.mp4']['bit_rate'] = int(probe('clip.mp4', '-show_streams', '-select_streams', 'a:0')['streams'][0]['bit_rate'])
# chirp.wav: where its samples start, so the test can compare them exactly.
with open(os.path.join(HERE, 'chirp.wav'), 'rb') as f:
    data = f.read()
expected['chirp.wav']['data_offset'] = data.index(b'data') + 8
expected['chirp.wav']['sha256'] = hashlib.sha256(data).hexdigest()
expected.update(incomplete_and_cover())
with open(os.path.join(HERE, 'expected.json'), 'w') as f:
    json.dump(expected, f, indent=1)
    f.write('\n')
print('ok', {k: v['size'] for k, v in expected.items()})
