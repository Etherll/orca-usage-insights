// Digest rows in one typed array instead of an array per row. Pure: no Node built-ins.
// A row is ROW_WIDTH numbers [slot, model, band, bucket, target, est, repeat, input, cacheRead, cacheWrite5m,
// cacheWrite1h, output] (fold.mjs digest()). Uint32Array while every value fits, else Float64Array; a missing
// value is NaN. Digests are immutable: packed and priced once per object.
// On disk (digest-scan.mjs shards) rows are '<u32|f64>:<base64>' with `rowCount`.

import { fromBase64, toBase64 } from '../base64.mjs';

export const ROW_WIDTH = 12;
const U32_MAX = 0xffffffff;
const packed = new WeakMap();

export function isPacked(digest) {
  return ArrayBuffer.isView(digest?.rows);
}

export function packDigest(digest) {
  if (!digest || isPacked(digest) || !Array.isArray(digest.rows)) return digest;
  let out = packed.get(digest);
  if (out !== undefined) return out;
  const list = digest.rows;
  const n = list.length;
  let rows = new Uint32Array(n * ROW_WIDTH);
  for (let r = 0, at = 0; r < n; r++) {
    const row = list[r];
    for (let k = 0; k < ROW_WIDTH; k++, at++) {
      const v = row?.[k];
      if (rows instanceof Uint32Array && !(typeof v === 'number' && v >= 0 && v <= U32_MAX && Math.floor(v) === v && !Object.is(v, -0))) {
        rows = Float64Array.from(rows);
      }
      rows[at] = typeof v === 'number' ? v : NaN;
    }
  }
  out = { ...digest, rows, rowCount: n };
  packed.set(digest, out);
  return out;
}

export function encodeDigest(digest) {
  const d = packDigest(digest);
  return { ...d, rows: `${d.rows instanceof Uint32Array ? 'u32' : 'f64'}:${toBase64(d.rows)}` };
}

export function decodeDigest(encoded) {
  const text = encoded?.rows;
  const n = encoded?.rowCount;
  if (typeof text !== 'string' || !Number.isSafeInteger(n) || n < 0) throw new Error('bad digest rows');
  const tag = text.slice(0, 4);
  if (tag !== 'u32:' && tag !== 'f64:') throw new Error('bad digest rows');
  const rows = fromBase64(text.slice(4), tag === 'u32:' ? Uint32Array : Float64Array);
  if (rows.length !== n * ROW_WIDTH) throw new Error('bad digest rows');
  return { ...encoded, rows };
}
