/*
 * The Apple Lossless (ALAC) decoder of TTAudio (assets/js/audio-engine.js),
 * run as a module worker: new Worker(url, { type: 'module' }). It holds one
 * file, opened with @mgz-dev/alac (assets/vendor/alac/alac.js), whose
 * WebAssembly is compiled with a synchronous call that Chrome before 115
 * refuses on a page's main thread. The engine starts one worker per file it
 * decodes and ends it with terminate(), which frees the file's memory.
 *
 * Messages, each answered with the same id:
 *   { id, op: 'open', file }  the File or Blob of an MP4/M4A file: read
 *       whole and copied into the decoder's memory. Answer: { id, info:
 *       { sampleRate, channels, bits, samples (per channel), bytesPerSample
 *       (bytes of one sample of every channel) } }, info null when the file
 *       holds no ALAC track.
 *   { id, op: 'read', from, count }  samples from..from + count - 1 (per
 *       channel). Answer: { id, bytes }: little-endian PCM of `bits` bits,
 *       the channels interleaved, fewer samples where the track ends first;
 *       bytes is transferred.
 *   An error is answered { id, error: message }.
 */
import { openTrack, decodeTrack } from '../vendor/alac/alac.js';

var track = null;

self.onmessage = function (ev) {
  var d = ev.data || {};
  if (d.op === 'open') {
    Promise.resolve(d.file).then(function (file) { return file.arrayBuffer(); }).then(function (buf) {
      // openTrack copies the bytes into the decoder; this copy is dropped.
      track = openTrack(new Uint8Array(buf));
      buf = null;
      self.postMessage({
        id: d.id,
        info: track && { sampleRate: track.sampleRate, channels: track.channels, bits: track.bits, samples: track.samples, bytesPerSample: track.bytesPerSample }
      });
    }).catch(function (err) {
      self.postMessage({ id: d.id, error: String(err && err.message || err) });
    });
    return;
  }
  if (d.op === 'read') {
    try {
      if (!track) throw new Error('no ALAC track is open');
      var bytes = decodeTrack(track, d.from, d.count);
      self.postMessage({ id: d.id, bytes: bytes }, [bytes.buffer]);
    } catch (err) {
      self.postMessage({ id: d.id, error: String(err && err.message || err) });
    }
  }
};
