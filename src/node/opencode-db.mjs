// OpenCode keeps its sessions in one SQLite database, not in JSONL transcripts. This module finds the
// database and turns its assistant messages into the same usage records the transcript parsers produce.
// Local only: reading a remote OpenCode database would need a query over SSH, which the SSH source does
// not have. `node:sqlite` is loaded lazily, so an older Node keeps the rest of the plugin working.
import os from 'node:os';
import { RecordTable } from '../core/table.mjs';
import { pathFor } from './paths.mjs';

const MIN_YEAR = 2020;
// Only these providers are priced per OpenCode channel. Their model ids are qualified in the catalog,
// because the same model can cost different amounts on Console and on Go.
export const CHANNEL_PROVIDERS = new Set(['opencode', 'opencode-go']);
const DB_FILE = /^opencode.*\.db$/i;

// `{ dir, dbs, missing }`: the OpenCode data folder and the database files in it. OPENCODE_DB wins and
// is absolute or relative to that folder; a stable channel keeps the plain opencode.db name.
export async function findOpencodeDbs({ fs, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = pathFor(platform);
  const dataRoot = nonEmpty(env.XDG_DATA_HOME) ?? p.join(home, '.local', 'share');
  const dir = p.join(dataRoot, 'opencode');
  const override = nonEmpty(env.OPENCODE_DB);
  if (override) {
    if (override === ':memory:') return { dir, dbs: [], missing: false };
    const path = p.isAbsolute(override) ? override : p.join(dir, override);
    return { dir, dbs: [{ path, source: 'environment' }], missing: false };
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { dir, dbs: [], missing: true };
    throw error;
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && DB_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a === 'opencode.db' ? -1 : b === 'opencode.db' ? 1 : a.localeCompare(b)));
  return { dir, dbs: names.map((name) => ({ path: p.join(dir, name), source: 'default' })), missing: false };
}

// Stat key for the database plus its WAL file. Recent turns can be only in the WAL, so its mtime and
// size are part of the key; the shared-memory file is coordination state, not data. Null when the
// database is missing.
export async function opencodeKey({ fs, path }) {
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

// Reads assistant messages into a table. `prior` (a previous result) makes the read incremental: only
// rows whose time_updated moved are queried, and their records are replaced. Pass `reset` after a
// Refresh to read everything again, which also drops messages deleted from the database.
// Prefers the v2 tables; an install upgraded from v1 has both, and its v1 rows were copied into v2, so
// reading v1 too would count them twice.
export async function readOpencodeDb({ fs, path, key, names, prior = null, reset = false } = {}) {
  key ??= await opencodeKey({ fs, path });
  if (key === null) return { status: 'missing', key };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { status: 'unsupported', key, error: 'node:sqlite is not available (Node 22.5 or newer is needed)' };
  }
  let db;
  try {
    const size = (await fs.stat(path)).size;
    const full = reset || prior === null || (prior.size !== undefined && size < prior.size);
    const table = full ? new RecordTable(0, names) : prior.table;
    const rows = full ? new Map() : prior.rows;
    let cursor = full ? 0 : prior.cursor;
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (tables.has('session_v2') && tables.has('session_message')) {
      cursor = readV2(db, table, rows, cursor);
    } else if (tables.has('session') && tables.has('message')) {
      cursor = readV1(db, table, rows, cursor);
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

// Forked sessions copy their parent's messages. `session.time_created` is the fork point, so older
// messages belong to the parent and are skipped; this mirrors OpenCode's own stats query.
function readV2(db, table, rows, cursor) {
  const sql = `
    SELECT message.id AS id, message.session_id AS sessionId, message.time_created AS ms,
           message.time_updated AS updated,
           json_extract(message.data, '$.model.id') AS modelId,
           json_extract(message.data, '$.model.providerID') AS providerId,
           json_extract(message.data, '$.tokens.input') AS input,
           json_extract(message.data, '$.tokens.output') AS output,
           json_extract(message.data, '$.tokens.reasoning') AS reasoning,
           json_extract(message.data, '$.tokens.cache.read') AS cacheRead,
           json_extract(message.data, '$.tokens.cache.write') AS cacheWrite,
           session.directory AS directory
    FROM session_message AS message
    JOIN session_v2 AS session ON session.id = message.session_id
    WHERE message.type = 'assistant'
      AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
      ${cursor > 0 ? 'AND message.time_updated >= ?' : ''}
  `;
  const list = cursor > 0 ? db.prepare(sql).all(cursor) : db.prepare(sql).all();
  return store(table, rows, cursor, list, (row) => row.directory);
}

// Pre-2 installs. The flat model fields and the same nested token shape are still in the same file.
function readV1(db, table, rows, cursor) {
  const sql = `
    SELECT message.id AS id, message.session_id AS sessionId, message.time_created AS ms,
           message.time_updated AS updated,
           json_extract(message.data, '$.modelID') AS modelId,
           json_extract(message.data, '$.providerID') AS providerId,
           json_extract(message.data, '$.tokens.input') AS input,
           json_extract(message.data, '$.tokens.output') AS output,
           json_extract(message.data, '$.tokens.reasoning') AS reasoning,
           json_extract(message.data, '$.tokens.cache.read') AS cacheRead,
           json_extract(message.data, '$.tokens.cache.write') AS cacheWrite,
           json_extract(message.data, '$.path.cwd') AS cwd,
           session.directory AS directory
    FROM message AS message
    JOIN session AS session ON session.id = message.session_id
    WHERE json_extract(message.data, '$.role') = 'assistant'
      ${cursor > 0 ? 'AND message.time_updated >= ?' : ''}
  `;
  const list = cursor > 0 ? db.prepare(sql).all(cursor) : db.prepare(sql).all();
  return store(table, rows, cursor, list, (row) => row.cwd ?? row.directory);
}

// Adds each assistant row, or replaces the record of a row that was already counted. Rows without a
// tokens object are still moved past, so a streaming message is not queried again before it finishes.
function store(table, rows, cursor, list, directoryOf) {
  let next = cursor;
  for (const row of list) {
    if (Number.isFinite(row.updated) && row.updated > next) next = row.updated;
    if (row.input === null && row.output === null && row.reasoning === null && row.cacheRead === null && row.cacheWrite === null) continue;
    if (!plausible(row.ms)) continue;
    const directory = directoryOf(row);
    const key = `opencode:${row.id}`;
    const output = count(row.output) + count(row.reasoning);
    const at = rows.get(key);
    const args = [
      key,
      row.ms,
      'opencode',
      modelKey(row.providerId, row.modelId),
      lastSegment(directory),
      row.sessionId,
      directory,
      'local',
      count(row.input),
      output,
      count(row.cacheRead),
      count(row.cacheWrite),
      0,
    ];
    if (at === undefined) rows.set(key, table.push(...args));
    else table.replace(at, ...args.slice(1));
  }
  return next;
}

// Console and Go share model ids, so their catalog ids carry the channel. Other providers (vercel,
// local and so on) keep the id they wrote, which may already name its vendor.
export function modelKey(providerId, modelId) {
  const id = nonEmpty(modelId);
  if (!id) return 'unknown';
  return CHANNEL_PROVIDERS.has(providerId) ? `${providerId}/${id}` : id;
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

const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function nonEmpty(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
