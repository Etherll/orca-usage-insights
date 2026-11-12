// Zstandard through Node's zlib. Builds of Node without it report zstdAvailable() false, and
// .zst transcripts are then skipped instead of read.
import zlib from 'node:zlib';

export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function';
}

const LF = 0x0a;
const LF_BYTES = Buffer.from('\n');

// Decompresses in 1 MiB chunks and calls onLines with Buffers that each hold whole lines (a last
// line without LF gets one). A line that spans chunks is joined once, when its LF arrives, so
// memory stays near the input plus one line and no byte is copied twice.
export async function forEachLines(buf, onLines, maxBytes = 768 << 20) {
  const stream = zlib.createZstdDecompress({ chunkSize: 64 << 10 });
  stream.end(buf);
  let parts = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error('decompressed transcript is too large');
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
  if (parts.length) onLines(Buffer.concat([...parts, LF_BYTES]));
}

const ZIN_BYTES = 256 << 10;
const ZOUT_BYTES = 1 << 20;

// Reads a .zst file of `size` bytes from `fh` in pieces and calls onLines like forEachLines: Buffers
// of whole lines, a last line without LF given one, lines decoded before an error still delivered.
// zlib's handle decodes straight into one reused 1 MiB buffer (the call zlib's own sync API makes),
// so lines are searched while still in cache and no output Buffer is allocated per chunk; the
// stream API made ~10 GB of garbage on a full Codex history and ran 2x slower. A Node whose zlib
// lacks that handle method gets forEachLines. scratch: { zin, zout, z } reused across files.
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
    if (total > maxBytes) throw new Error('decompressed transcript is too large');
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
