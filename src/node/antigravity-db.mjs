// Antigravity (`agy` CLI / Orca Antigravity) keeps each conversation in its own SQLite database under
// `~/.gemini/antigravity-cli/conversations/<id>.db`, with per-turn model and token usage stored as
// protobuf blobs in `gen_metadata` and step timestamps in `steps`. This module finds those databases,
// decodes the protobuf wire fields without external dependencies, and turns each generation into the
// same usage records the transcript parsers produce.
// `node:sqlite` is loaded lazily, so an older Node keeps the rest of the plugin working.
import os from 'node:os';
import { RecordTable } from '../core/table.mjs';
import { homeDir, pathFor } from './paths.mjs';

const MIN_YEAR = 2020;
const DB_FILE = /\.db$/i;

// `{ dir, dbs, missing }`: the Antigravity conversations folder and the database files in it.
// ANTIGRAVITY_APP_DATA_DIR (or ANTIGRAVITY_CLI_DIR) overrides the `~/.gemini/antigravity-cli` base folder.
export async function findAntigravityDbs({ fs, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = pathFor(platform);
  const override = nonEmpty(env.ANTIGRAVITY_APP_DATA_DIR) ?? nonEmpty(env.ANTIGRAVITY_CLI_DIR);
  const base = override ?? p.join(homeDir({ platform, env, home }), '.gemini', 'antigravity-cli');
  const source = override ? 'environment' : 'default';
  const dir = p.join(base, 'conversations');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { dir, source, dbs: [], missing: true };
    throw error;
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && DB_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return { dir, source, dbs: names.map((name) => ({ path: p.join(dir, name), source })), missing: false };
}

// Stat key for a conversation database plus its WAL file. Active sessions often sit in the WAL until
// checkpointed, so its mtime and size are part of the key. Null when the database is missing.
export async function antigravityKey({ fs, path }) {
  const parts = [];
  for (const suffix of ['', '-wal']) {
    try {
      const st = await fs.stat(path + suffix);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        if (suffix === '') return null;
        parts.push('');
      } else {
        throw error;
      }
    }
  }
  return parts.join('|');
}

// Reads `gen_metadata` rows from one conversation database into a RecordTable. `prior` makes the read
// incremental: only rows with `idx > cursor` are queried. `reset` or a shrunk file reads from the start.
export async function readAntigravityDb({ fs, path, key, names, prior = null, reset = false, checkDeleted = false, host = 'local' } = {}) {
  key ??= await antigravityKey({ fs, path });
  if (key === null) return { status: 'missing', key };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { status: 'unsupported', key, error: 'node:sqlite is not available (Node 22.5 or newer is needed)' };
  }
  let db;
  try {
    const st = await fs.stat(path);
    const size = st.size;
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('gen_metadata')) {
      const table = new RecordTable(0, names);
      return { status: 'ok', key, table, rows: new Map(), cursor: -1, size };
    }
    let full = reset || prior === null || (prior.size !== undefined && size < prior.size);
    if (!full && checkDeleted && prior.rows.size > 0) {
      const countRow = db.prepare('SELECT count(*) AS n FROM gen_metadata').get();
      if (!countRow || countRow.n < prior.rows.size) full = true;
    }
    const table = full ? new RecordTable(0, names) : prior.table;
    const rows = full ? new Map() : prior.rows;
    let cursor = full ? -1 : prior.cursor;

    const list = cursor >= 0
      ? db.prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC').all(cursor)
      : db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();

    if (list.length > 0) {
      let cwd = '';
      let fallbackMs = st.mtimeMs;
      let sessionId = sessionIdFromPath(path);
      if (tables.has('trajectory_metadata_blob')) {
        try {
          const metaRow = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
          if (metaRow?.data) {
            const meta = parseTrajectoryMeta(asUint8Array(metaRow.data));
            if (meta.cwd) cwd = meta.cwd;
            if (plausible(meta.createdMs)) fallbackMs = meta.createdMs;
            if (meta.cascadeId) sessionId = meta.cascadeId;
          }
        } catch {}
      }
      const stepStmt = tables.has('steps') ? db.prepare('SELECT metadata FROM steps WHERE idx = ?') : null;
      const stepMsCache = new Map();
      const stepMs = (stepIdx) => {
        if (stepStmt === null || !Number.isInteger(stepIdx) || stepIdx < 0) return NaN;
        if (stepMsCache.has(stepIdx)) return stepMsCache.get(stepIdx);
        let ms = NaN;
        try {
          const row = stepStmt.get(stepIdx);
          if (row?.metadata) ms = parseStepTimestampMs(asUint8Array(row.metadata));
        } catch {}
        stepMsCache.set(stepIdx, ms);
        return ms;
      };

      const project = lastSegment(cwd);
      let lastKnownMs = fallbackMs;
      for (const row of list) {
        if (Number.isInteger(row.idx) && row.idx > cursor) cursor = row.idx;
        if (!row.data) continue;
        const parsed = parseGenMetadata(asUint8Array(row.data));
        if (!parsed) continue;
        const { input, output, cacheRead } = parsed;
        if (input === 0 && output === 0 && cacheRead === 0) continue;

        let ms = stepMs(parsed.stepIndex);
        if (!plausible(ms)) ms = lastKnownMs;
        if (!plausible(ms)) continue;
        lastKnownMs = ms;

        const sid = parsed.cascadeId || sessionId;
        const recKey = `antigravity:${parsed.requestId || `${sid}:${row.idx}`}`;
        const known = rows.get(recKey);
        const args = [
          recKey,
          ms,
          'antigravity',
          parsed.model || 'unknown',
          project,
          sid,
          cwd,
          host,
          input,
          output,
          cacheRead,
          0,
          0,
        ];
        if (known === undefined) rows.set(recKey, table.push(...args));
        else table.replace(known, ...args.slice(1));
      }
    }

    return { status: 'ok', key, table, rows, cursor, size };
  } catch (error) {
    return { status: 'error', key, error: String(error?.message ?? error) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// Decodes one `gen_metadata.data` protobuf blob. Returns null when the blob has no usage payload.
// Wire layout verified against Antigravity CLI conversation databases:
//   top.1 (inner) ->
//     .4  (usage):  .2 = uncached input, .3 = total output (thinking + text), .5 = cache read,
//                   .9 = thinking output, .10 = text output
//     .19 (string): model id (e.g. "gemini-4-neon")
//     .20 (repeated {1: key, 2: value}): request_id, last_step_index, cascade_id
export function parseGenMetadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  let inner = null;
  for (const field of iterFields(bytes)) {
    if (field.num === 1 && field.wire === 2) {
      inner = field.value;
      break;
    }
  }
  if (!inner) return null;

  let model = '';
  let usageBytes = null;
  let requestId = '';
  let cascadeId = '';
  let stepIndex = -1;

  for (const field of iterFields(inner)) {
    if (field.wire !== 2) continue;
    if (field.num === 4) {
      usageBytes = field.value;
    } else if (field.num === 19) {
      model = decodeUtf8(field.value).trim();
    } else if (field.num === 20) {
      const kv = parseKv(field.value);
      if (kv.key === 'request_id' && kv.value) requestId = kv.value;
      else if (kv.key === 'cascade_id' && kv.value) cascadeId = kv.value;
      else if (kv.key === 'last_step_index' && /^\d+$/.test(kv.value)) stepIndex = Number(kv.value);
    }
  }
  if (!usageBytes) return null;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let thinking = 0;
  let textOut = 0;
  for (const field of iterFields(usageBytes)) {
    if (field.wire !== 0) continue;
    if (field.num === 2) input = field.value;
    else if (field.num === 3) output = field.value;
    else if (field.num === 5) cacheRead = field.value;
    else if (field.num === 9) thinking = field.value;
    else if (field.num === 10) textOut = field.value;
  }
  if (output === 0 && (thinking > 0 || textOut > 0)) output = thinking + textOut;

  return {
    model: model || 'unknown',
    input: count(input),
    output: count(output),
    cacheRead: count(cacheRead),
    requestId,
    cascadeId,
    stepIndex,
  };
}

// Decodes a `steps.metadata` protobuf blob and returns the first plausible protobuf Timestamp in ms.
// Step metadata stores google.protobuf.Timestamp messages (`1=seconds, 2=nanos`) at fields 1, 6, 7, 8.
export function parseStepTimestampMs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return NaN;
  const preferred = [1, 6, 7, 8];
  const found = new Map();
  for (const field of iterFields(bytes)) {
    if (field.wire !== 2) continue;
    const ms = parseTimestampMsg(field.value);
    if (plausible(ms)) {
      if (field.num === 1) return ms;
      if (!found.has(field.num)) found.set(field.num, ms);
    }
  }
  for (const num of preferred) {
    if (found.has(num)) return found.get(num);
  }
  for (const ms of found.values()) return ms;
  return NaN;
}

// Decodes `trajectory_metadata_blob.data` for workspace directory, creation timestamp, and cascade id.
//   .1 -> .1: workspace URI (e.g. "file:///Users/name/repo")
//   .2 -> google.protobuf.Timestamp (createdAt)
//   .6 -> cascade_id string
export function parseTrajectoryMeta(bytes) {
  let cwd = '';
  let createdMs = NaN;
  let cascadeId = '';
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { cwd, createdMs, cascadeId };
  for (const field of iterFields(bytes)) {
    if (field.wire !== 2) continue;
    if (field.num === 1 && !cwd) {
      for (const sub of iterFields(field.value)) {
        if (sub.num === 1 && sub.wire === 2) {
          cwd = uriToPath(decodeUtf8(sub.value));
          break;
        }
      }
    } else if (field.num === 2 && !plausible(createdMs)) {
      createdMs = parseTimestampMsg(field.value);
    } else if (field.num === 6 && !cascadeId) {
      cascadeId = decodeUtf8(field.value).trim();
    }
  }
  return { cwd, createdMs, cascadeId };
}

function parseTimestampMsg(bytes) {
  let seconds = 0;
  let nanos = 0;
  let hasSeconds = false;
  for (const field of iterFields(bytes)) {
    if (field.wire !== 0) return NaN;
    if (field.num === 1) {
      seconds = field.value;
      hasSeconds = true;
    } else if (field.num === 2) {
      nanos = field.value;
    } else {
      return NaN;
    }
  }
  if (!hasSeconds || seconds < 1_577_836_800 || seconds > 2_524_608_000) return NaN;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

function parseKv(bytes) {
  let key = '';
  let value = '';
  for (const field of iterFields(bytes)) {
    if (field.wire !== 2) continue;
    if (field.num === 1) key = decodeUtf8(field.value);
    else if (field.num === 2) value = decodeUtf8(field.value);
  }
  return { key, value };
}

// Minimal protobuf wire-format iterator (varint, 64-bit, length-delimited, 32-bit).
// Truncated or unknown wire types stop cleanly instead of throwing.
function* iterFields(buf) {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const tagRes = readVarint(buf, i);
    if (!tagRes) return;
    i = tagRes.next;
    const num = Math.floor(tagRes.value / 8);
    const wire = tagRes.value % 8;
    if (num <= 0) return;
    if (wire === 0) {
      const valRes = readVarint(buf, i);
      if (!valRes) return;
      i = valRes.next;
      yield { num, wire, value: valRes.value };
    } else if (wire === 1) {
      if (i + 8 > n) return;
      yield { num, wire, value: buf.subarray(i, i + 8) };
      i += 8;
    } else if (wire === 2) {
      const lenRes = readVarint(buf, i);
      if (!lenRes || lenRes.value < 0 || i > n) return;
      i = lenRes.next;
      if (i + lenRes.value > n) return;
      yield { num, wire, value: buf.subarray(i, i + lenRes.value) };
      i += lenRes.value;
    } else if (wire === 5) {
      if (i + 4 > n) return;
      yield { num, wire, value: buf.subarray(i, i + 4) };
      i += 4;
    } else {
      return;
    }
  }
}

function readVarint(buf, start) {
  let value = 0;
  let mul = 1;
  let i = start;
  const limit = Math.min(buf.length, start + 10);
  while (i < limit) {
    const b = buf[i++];
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return { value, next: i };
    mul *= 128;
  }
  return null;
}

const utf8 = new TextDecoder('utf-8');
function decodeUtf8(bytes) {
  return utf8.decode(bytes);
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

function uriToPath(uri) {
  const trimmed = String(uri ?? '').trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('file://')) return trimmed;
  let path = trimmed.slice('file://'.length);
  try {
    path = decodeURIComponent(path);
  } catch {}
  // Windows file URIs look like file:///C:/Users/...
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path;
}

function sessionIdFromPath(filePath) {
  const base = lastSegment(filePath);
  return base.replace(DB_FILE, '');
}

function plausible(ms) {
  const floor = Date.UTC(MIN_YEAR, 0, 1);
  const ceiling = Date.UTC(new Date().getUTCFullYear() + 2, 0, 1);
  return Number.isFinite(ms) && ms >= floor && ms < ceiling;
}

function lastSegment(value) {
  if (typeof value !== 'string') return '';
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

function nonEmpty(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
