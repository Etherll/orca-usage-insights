// OpenCode as a source of usage records next to the transcript roots. OpenCode keeps usage in SQLite
// databases (plus a WAL), so a database is the unit a transcript file is elsewhere: stat first, query
// only rows that changed, and keep its table across restarts in its own cache file.
// The scanner calls scan() once per run and merges the tables with the transcript tables.
import fsp from 'node:fs/promises';
import os from 'node:os';
import { decodeTable, encodeTable } from '../core/table-codec.mjs';
import { NameDict } from '../core/table.mjs';
import { findOpencodeDbs, opencodeKey, readOpencodeDb } from './opencode-db.mjs';
import { isTurnedOff, pathFor } from './paths.mjs';

const CACHE_VERSION = 1;

export function createOpencodeSource({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fs = fsp,
  names = new NameDict(),
  cacheFile = null,
} = {}) {
  const p = pathFor(platform);
  let dbs = new Map(); // database path -> { key, table, rows, cursor, size, latest }
  let loaded = false;
  let dirty = false;

  return { scan, flush, reset };

  // `{ sources, folder, files, errors, changed }`. `force` (Refresh) also drops deleted messages.
  // `disabled` is the turned-off list from settings; a turned-off folder keeps its tables in memory, so
  // turning it on again queries nothing that did not change.
  async function scan({ force = false, disabled = [] } = {}) {
    const out = { sources: [], folder: null, files: 0, errors: 0, changed: false };
    let found;
    try {
      found = await findOpencodeDbs({ fs, platform, env, home });
    } catch (error) {
      out.errors++;
      out.folder = folder({ path: 'opencode', state: 'warning', message: `Cannot list OpenCode data (${error?.code ?? 'error'})` });
      return out;
    }
    if (found.missing) {
      out.folder = folder({ path: found.dir, state: 'empty' });
      return out;
    }
    // Loaded once a data folder exists, so a machine without OpenCode never opens the cache file.
    if (!loaded) {
      loaded = true;
      await loadCache();
    }
    if (isTurnedOff(found.dir, disabled, platform)) {
      out.folder = folder({ path: found.dir, state: 'off' });
      return out;
    }
    const seen = new Set();
    let records = 0;
    let latest = -Infinity;
    let state = found.dbs.length === 0 ? 'empty' : 'ok';
    let message = null;
    const warn = (text) => {
      state = 'warning';
      message ??= text;
    };
    for (const db of found.dbs) {
      seen.add(db.path);
      let key;
      try {
        key = await opencodeKey({ fs, path: db.path });
      } catch {
        out.errors++;
        warn('Some OpenCode data could not be read');
        continue;
      }
      if (key === null) {
        if (dbs.delete(db.path)) out.changed = dirty = true;
        warn('OpenCode database not found');
        continue;
      }
      let entry = dbs.get(db.path);
      if (!entry || entry.key !== key || force) {
        const before = entry?.table;
        const version = before?.version;
        const result = await readOpencodeDb({ fs, path: db.path, key, names, prior: entry ?? null, checkDeleted: force });
        if (result.status === 'ok') {
          if (result.table !== before || result.table.version !== version) {
            out.changed = true;
            entry = { key, table: result.table, rows: result.rows, cursor: result.cursor, size: result.size, latest: maxMs(result.table) };
          } else {
            entry = { ...entry, key, cursor: result.cursor, size: result.size };
          }
          dbs.set(db.path, entry);
          dirty = true;
        } else if (result.status === 'missing') {
          if (dbs.delete(db.path)) out.changed = dirty = true;
          continue;
        } else if (result.status === 'unsupported') {
          warn(result.error);
        } else {
          out.errors++;
          warn('Some OpenCode data could not be read');
        }
      }
      // On a transient read failure the last good table stays, so usage never flickers out of the totals.
      if (!entry) continue;
      out.sources.push({ id: db.path, table: entry.table });
      out.files++;
      records += entry.table.length;
      if (entry.latest > latest) latest = entry.latest;
    }
    for (const path of [...dbs.keys()]) {
      if (seen.has(path)) continue;
      dbs.delete(path);
      out.changed = dirty = true;
    }
    out.folder = folder({
      path: found.dir,
      state,
      files: out.files,
      records,
      latestRecordAt: latest > -Infinity ? new Date(latest).toISOString() : null,
      message,
    });
    return out;
  }

  function reset() {
    if (dbs.size > 0) dirty = true;
    dbs = new Map();
    loaded = true;
  }

  // Writes the tables when something changed since the last write. The scanner calls it with its own save.
  async function flush() {
    if (!cacheFile || !dirty) return;
    dirty = false;
    const out = {};
    for (const [path, e] of dbs) out[path] = { key: e.key, cursor: e.cursor, size: e.size, table: encodeTable(e.table) };
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    try {
      await fs.mkdir(p.dirname(cacheFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, dbs: out }));
      await fs.rename(tmp, cacheFile);
    } catch (error) {
      dirty = true;
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  // A database whose stat key still matches its cached one is not queried at all after a restart.
  async function loadCache() {
    if (!cacheFile) return;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    } catch {
      return;
    }
    if (raw?.version !== CACHE_VERSION || !isObject(raw.dbs)) return;
    for (const [path, e] of Object.entries(raw.dbs)) {
      if (!isObject(e) || typeof e.key !== 'string' || !Number.isFinite(e.cursor) || !Number.isFinite(e.size)) continue;
      let table;
      try {
        table = decodeTable(e.table, names);
      } catch {
        continue;
      }
      const rows = new Map();
      // time_updated is not cached: the first read after a restart replaces the rows at the cursor once.
      for (let i = 0; i < table.length; i++) if (table.keys[i] !== undefined) rows.set(table.keys[i], [i, undefined]);
      dbs.set(path, { key: e.key, table, rows, cursor: e.cursor, size: e.size, latest: maxMs(table) });
    }
  }
}

function folder({ path, state, files = 0, records = 0, latestRecordAt = null, message = null }) {
  return { path, kind: 'opencode', source: 'default', state, files, records, latestRecordAt, ...(message ? { message } : {}) };
}

function maxMs(table) {
  let max = -Infinity;
  for (let i = 0; i < table.length; i++) if (table.ms[i] > max) max = table.ms[i];
  return max;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
