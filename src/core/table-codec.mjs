// RecordTable to and from JSON-safe strings (cache files) and typed arrays (thread messages, buffers
// transferred). Pure: no Node built-in or Orca imports. Encoded `names` holds only the strings the rows use.
// On disk each column is '<type>:<base64>' in the narrowest type: counts u8, u16, u32 or f64; name ids n8 or
// n16 (id + 1, so -1 is 0) or i32. Little-endian, as on every platform Orca runs on.

import { fromBase64, toBase64 } from './base64.mjs';
import { COLUMNS, NAME_FIELDS, NameDict, RecordTable } from './table.mjs';

const FORMAT = 1;

export function encodeTable(table, { binary = false } = {}) {
  const n = table.length;
  const local = new Int32Array(table.names.length).fill(-1);
  const names = [];
  const ids = {};
  for (const field of NAME_FIELDS) {
    const column = table[field];
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const id = column[i];
      if (id < 0) {
        out[i] = -1;
        continue;
      }
      if (local[id] === -1) {
        local[id] = names.length;
        names.push(table.names[id]);
      }
      out[i] = local[id];
    }
    ids[field] = out;
  }
  const encoded = { f: FORMAT, n, names, keys: table.keys.slice(0, n).map((k) => k ?? null) };
  for (const field of COLUMNS) {
    const column = NAME_FIELDS.includes(field) ? ids[field] : table[field].slice(0, n);
    encoded[field] = binary ? column : encodeColumn(column, NAME_FIELDS.includes(field));
  }
  return encoded;
}

export function transferList(encoded) {
  return COLUMNS.map((field) => encoded[field]?.buffer).filter((b) => b instanceof ArrayBuffer);
}

// Throws on anything malformed, so a bad cache entry is read again instead.
export function decodeTable(encoded, dict = new NameDict()) {
  if (encoded?.f !== FORMAT || !Number.isSafeInteger(encoded.n) || encoded.n < 0) throw new Error('bad record table');
  const n = encoded.n;
  if (!Array.isArray(encoded.names) || !encoded.names.every((s) => typeof s === 'string')) throw new Error('bad record table names');
  if (!Array.isArray(encoded.keys) || encoded.keys.length !== n) throw new Error('bad record table keys');
  const table = new RecordTable(0, dict);
  table.keys = encoded.keys.map((k) => (typeof k === 'string' ? k : undefined));
  for (const field of COLUMNS) {
    const column = decodeColumn(encoded[field], field);
    if (column.length !== n) throw new Error(`bad record table column ${field}`);
    table[field] = column;
  }
  const map = new Int32Array(encoded.names.length);
  for (let id = 0; id < map.length; id++) map[id] = dict.id(encoded.names[id]);
  for (const field of NAME_FIELDS) {
    const column = table[field];
    for (let i = 0; i < n; i++) {
      const id = column[i];
      if (id < -1 || id >= map.length) throw new Error(`bad record table ${field}`);
      if (id >= 0) column[i] = map[id];
    }
  }
  table.length = n;
  return table;
}

function encodeColumn(column, isName) {
  if (column instanceof Float64Array && !isName) return `f64:${toBase64(column)}`;
  let max = 0;
  for (let i = 0; i < column.length; i++) if (column[i] > max) max = column[i];
  if (isName) {
    if (max + 1 <= 0xff) return `n8:${toBase64(Uint8Array.from(column, (id) => id + 1))}`;
    if (max + 1 <= 0xffff) return `n16:${toBase64(Uint16Array.from(column, (id) => id + 1))}`;
    return `i32:${toBase64(column)}`;
  }
  if (max <= 0xff) return `u8:${toBase64(Uint8Array.from(column))}`;
  if (max <= 0xffff) return `u16:${toBase64(Uint16Array.from(column))}`;
  return `u32:${toBase64(column)}`;
}

const COLUMN_TYPES = { f64: Float64Array, u32: Uint32Array, i32: Int32Array, u8: Uint8Array, u16: Uint16Array, n8: Uint8Array, n16: Uint16Array };

function decodeColumn(value, field) {
  const isName = NAME_FIELDS.includes(field);
  if (ArrayBuffer.isView(value)) {
    const ok = field === 'ms' ? value instanceof Float64Array : isName ? value instanceof Int32Array : value instanceof Float64Array || value instanceof Uint32Array;
    if (!ok) throw new Error(`bad record table column ${field}`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`bad record table column ${field}`);
  const colon = value.indexOf(':');
  const tag = value.slice(0, colon);
  const Type = COLUMN_TYPES[tag];
  const allowed = field === 'ms' ? tag === 'f64' : isName ? ['i32', 'n8', 'n16'].includes(tag) : ['f64', 'u32', 'u16', 'u8'].includes(tag);
  if (!Type || !allowed) throw new Error(`bad record table column ${field}`);
  const raw = fromBase64(value.slice(colon + 1), Type);
  if (tag === 'n8' || tag === 'n16') {
    const ids = new Int32Array(raw.length);
    for (let i = 0; i < raw.length; i++) ids[i] = raw[i] - 1;
    return ids;
  }
  if (tag === 'u8' || tag === 'u16') return Uint32Array.from(raw);
  return raw;
}
