// Zstandard through Node's zlib. Builds of Node without it report zstdAvailable() false, and
// .zst transcripts are then skipped instead of read.
import zlib from 'node:zlib';

export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function';
}

export const TOO_LARGE = 'decompressed transcript is too large';

const LF = 0x0a;
const TRUNCATED = 'zstd input ends inside a frame';
const ZSTD_MAGIC = 0xfd2fb528;

// Walks frame and block headers as input arrives, without decoding, and says whether the input
// ended on a frame boundary. Some Node 24 builds finish a frame cut short without an error, and a
// file read that way would be cached as complete.
export function createFrameCheck() {
  let head = []; // bytes of the header being collected
  let need = 4; // bytes the next header needs; 0 while skipping block content
  let skip = 0;
  let state = 'magic';
  let checksum = false;
  let frames = 0;
  let pos = 0; // input bytes seen
  const starts = []; // [offset, skippable] per frame, in order: frame k ends where frame k+1 starts
  function header(h) {
    if (state === 'magic') {
      const magic = (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
      if (magic === ZSTD_MAGIC) return (starts.push([pos - 4, false]), (state = 'descriptor'), 1);
      if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) return (starts.push([pos - 4, true]), (state = 'skippable'), 4);
      throw new Error('zstd input has no frame magic');
    }
    if (state === 'skippable') {
      skip = (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
      frames++;
      return ((state = 'magic'), 4);
    }
    if (state === 'descriptor') {
      const d = h[0];
      const single = (d >> 5) & 1;
      checksum = ((d >> 2) & 1) === 1;
      const fcs = [single, 2, 4, 8][d >> 6];
      const rest = (single ? 0 : 1) + [0, 1, 2, 4][d & 3] + fcs;
      state = 'block';
      if (rest > 0) return ((state = 'frame-rest'), rest);
      return 3;
    }
    if (state === 'frame-rest') return ((state = 'block'), 3);
    if (state === 'block') {
      const raw = h[0] | (h[1] << 8) | (h[2] << 16);
      const type = (raw >> 1) & 3;
      if (type === 3) throw new Error('zstd block type is reserved');
      skip = type === 1 ? 1 : raw >>> 3;
      if (raw & 1) {
        frames++;
        if (checksum) return ((state = 'checksum'), 4);
        return ((state = 'magic'), 4);
      }
      return 3;
    }
    // checksum
    return ((state = 'magic'), 4);
  }
  return {
    push(buf, from = 0, to = buf.length) {
      let i = from;
      while (i < to) {
        if (skip > 0) {
          const n = Math.min(skip, to - i);
          skip -= n;
          i += n;
          pos += n;
          continue;
        }
        head.push(buf[i++]);
        pos++;
        if (head.length === need) {
          const h = head;
          head = [];
          need = header(h);
        }
      }
    },
    // True when the input ended right after a complete frame.
    complete: () => frames > 0 && state === 'magic' && head.length === 0 && skip === 0,
    // [start, end) of each zstd frame seen so far, skippable frames left out.
    frames: () => starts.flatMap(([start, skippable], k) => (skippable ? [] : [[start, k + 1 < starts.length ? starts[k + 1][0] : pos]])),
  };
}
const LF_BYTES = Buffer.from('\n');

// decoder makes the per-frame decompress stream (tests pass one that stops early, as some builds do).
export async function forEachLines(buf, onLines, maxBytes = 768 << 20, decoder = () => zlib.createZstdDecompress({ chunkSize: 64 << 10 })) {
  const check = createFrameCheck();
  check.push(buf);
  // Each frame gets its own decoder: some Node 24 builds end a stream after its first frame. Input cut
  // short is decoded whole, so its complete lines still arrive before the error.
  const slices = check.complete() ? check.frames().map(([start, end]) => buf.subarray(start, end)) : [buf];
  let parts = [];
  let total = 0;
  for (const slice of slices) {
    const stream = decoder();
    stream.end(slice);
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        throw new Error(TOO_LARGE);
      }
      const cut = chunk.lastIndexOf(LF);
      if (cut < 0) {
        parts.push(chunk);
        continue;
      }
      const head = chunk.subarray(0, cut + 1);
      onLines(parts.length ? Buffer.concat([...parts, head]) : head);
      parts = cut + 1 < chunk.length ? [chunk.subarray(cut + 1)] : [];
    }
  }
  if (parts.length) onLines(Buffer.concat([...parts, LF_BYTES]));
  if (!check.complete()) throw new Error(TRUNCATED);
}

const ZIN_BYTES = 256 << 10;
const ZOUT_BYTES = 1 << 20;

// Decodes into one reused 1 MiB buffer through zlib's handle: the stream API made far more garbage and ran slower.
// onLines must not keep the Buffer it is given: the next chunk overwrites it.
export async function readLines(fh, size, onLines, scratch = {}, maxBytes = 768 << 20) {
  let z = scratch.z;
  if (!z || z.destroyed) {
    z = zlib.createZstdDecompress();
    // A decode error is also emitted on a later tick; it is handled below through z.destroyed.
    z.on('error', () => {});
  } else z.reset();
  if (typeof z._handle?.writeSync !== 'function' || !(z._writeState instanceof Uint32Array)) {
    z.close();
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    for (let n; got < size && (n = (await fh.read(buf, got, size - got, got)).bytesRead) > 0; ) got += n;
    return forEachLines(buf.subarray(0, got), onLines, maxBytes);
  }
  scratch.z = z;
  const zin = (scratch.zin ??= Buffer.allocUnsafeSlow(ZIN_BYTES));
  let out = (scratch.zout ??= Buffer.allocUnsafeSlow(ZOUT_BYTES));
  const handle = z._handle;
  const state = z._writeState;
  const check = createFrameCheck();
  let pos = 0;
  let inOff = 0;
  let inLen = 0;
  let eof = false;
  let filled = 0;
  let total = 0;
  for (;;) {
    if (filled === out.length) {
      const grown = Buffer.allocUnsafeSlow(out.length * 2);
      out.copy(grown, 0, 0, filled);
      out = scratch.zout = grown;
    }
    if (inLen === 0 && !eof) {
      inOff = 0;
      inLen = pos < size ? (await fh.read(zin, 0, Math.min(zin.length, size - pos), pos)).bytesRead : 0;
      check.push(zin, 0, inLen);
      pos += inLen;
      eof = inLen === 0;
    }
    const room = out.length - filled;
    handle.writeSync(eof ? z._finishFlushFlag : z._defaultFlushFlag, zin, inOff, inLen, out, filled, room);
    if (z.destroyed) throw z.errored ?? new Error('zstd decompression failed');
    const produced = room - state[0];
    const consumed = inLen - state[1];
    inOff += consumed;
    inLen = state[1];
    if (produced === 0 && consumed === 0 && inLen > 0) throw new Error('zstd decompression stalled');
    total += produced;
    if (total > maxBytes) throw new Error(TOO_LARGE);
    if (produced > 0) {
      const from = filled;
      filled += produced;
      const cut = out.lastIndexOf(LF, filled - 1);
      if (cut >= from) {
        onLines(out.subarray(0, cut + 1));
        out.copy(out, 0, cut + 1, filled);
        filled -= cut + 1;
      }
    } else if (eof) break;
  }
  // A cut-off file's last bytes are part of a line that never ended: throw before passing them on.
  if (!check.complete()) throw new Error(TRUNCATED);
  if (filled > 0) {
    if (filled === out.length) {
      const grown = Buffer.allocUnsafeSlow(out.length + 1);
      out.copy(grown, 0, 0, filled);
      out = scratch.zout = grown;
    }
    out[filled] = LF;
    onLines(out.subarray(0, filled + 1));
  }
}
