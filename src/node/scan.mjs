// Scanner adapter: walks Claude and Codex transcript roots and reads only what changed.
// Stat-first: a file whose `mtimeMs:size` key is unchanged costs one stat and no reads.
// Entries keep the parser per file, so records survive tails. The persisted cache stores
// { key, offset, kind, ctx, state } per file; `offset` is the end of the last complete line.
import fsp from 'node:fs/promises';
import os from 'node:os';
import { createRecordStore } from '../core/record-store.mjs';
import { NameDict } from '../core/table.mjs';
import { PROVIDERS } from '../core/providers.mjs';
import { MARKER_BYTES, createRecordsConsumer, markedLines } from './lines.mjs';
import { findOpencodeDbs, opencodeKey, readOpencodeDb } from './opencode-db.mjs';
import { createParsePool } from './parse-pool.mjs';
import { pathFor, rootSpecs } from './paths.mjs';
import { listTranscripts, readTranscript } from './transcript-files.mjs';

export { markedLines };

const CACHE_VERSION = 6;
// Earlier caches, read when there is no current one. Their Claude entries carry over unread (parsers convert
// pre-columns states); Codex files are read again, as their keys predate turn-based identity.
const LEGACY_CACHE_VERSIONS = new Set([4, 5]);
const REUSE_MS = 5_000;
const SAVE_EVERY_MS = 30_000;
// Files read whole for the first time go to parse threads when they are at most this big.
// Compressed files over this size are skipped: they are never read whole on the calling thread.
const THREAD_MAX_BYTES = 64 << 20;
// Saves append changed files to a journal. The whole cache is rewritten (journal emptied) on the first
// save, after reset, when more files changed than this, or once the journal is this big.
const JOURNAL_MAX_FILES = 512;
const JOURNAL_MAX_BYTES = 32 << 20;
const WRITE_CHUNK_CHARS = 1 << 20;

export function createScanner({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fs = fsp,
  cacheFile,
  legacyCacheFile = null, // a path or a list of paths, newest first
  concurrency = 8,
  // Threads that parse files read whole for the first time (first open, rewritten files).
  // 0 parses on the calling thread. Tail reads always parse inline: they are small.
  threads = Math.min(6, Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  now = () => Date.now(),
} = {}) {
  const p = pathFor(platform);
  const limit = Math.max(1, Math.floor(concurrency));
  let files = new Map();
  const opencode = new Map(); // database path -> { key, table }, read again only when the database changes
  let loaded = false;
  let generation = 0;
  let inFlight = null; // { job, roots } while a run is going
  let last = null;
  // Every file's table interns into one dictionary, so the store copies their columns in bulk.
  const names = new NameDict();
  let store = createRecordStore({ names });
  let extra = { claude: [], codex: [], disabled: [] }; // folders from settings, see setExtraRoots
  let extraKey = '[[],[],[]]';
  let rootsGen = 0;
  let dirty = false;
  const touched = new Set(); // paths read or dropped since the last save
  const oversized = new Map(); // path -> key of a compressed file that decompressed past the cap
  const folderMemo = new Map(); // root id -> its last counts, see folderCounts
  const journalFile = cacheFile ? `${cacheFile}.journal` : null;
  let baseGen = null; // gen of the cache file the journal extends; null: the next save rewrites it
  let journalBytes = 0;
  let journalTorn = false; // the journal ends in a line cut short: the next append starts a new line
  let lastSave = 0;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  // Parse threads open files with the real fs, so an injected fs (tests) parses inline.
  const pool = threads > 0 && fs === fsp ? createParsePool(threads) : null;

  return { scan, reset, flush, close: () => pool?.close(), setExtraRoots, pool: () => pool };

  // Extra folders are read next to the default roots; `disabled` lists roots and folders turned off. A
  // change drops the reuse window, and a run that started with the old folders finishes before a new one
  // starts. Same folders: no-op.
  function setExtraRoots(next) {
    const claude = listOfStrings(next?.claude);
    const codex = listOfStrings(next?.codex);
    const disabled = listOfStrings(next?.disabled);
    const key = JSON.stringify([claude, codex, disabled]);
    if (key === extraKey) return;
    extraKey = key;
    extra = { claude, codex, disabled };
    rootsGen++;
    last = null;
  }

  // Concurrent calls share one run; a result under REUSE_MS old is returned as is.
  // `force` skips that reuse (the refresh button) but still stats first and reads only what changed.
  function scan({ force = false } = {}) {
    if (inFlight && inFlight.roots === rootsGen) return inFlight.job;
    if (!force && last && now() - last.at < REUSE_MS) return Promise.resolve({ ...last.result, changed: false });
    const gen = generation;
    const roots = rootsGen;
    const prior = inFlight?.job.then(noop, noop);
    const current = { roots, job: null };
    current.job = (prior ? prior.then(() => runScan(gen, force)) : runScan(gen, force)).then(
      (result) => {
        if (inFlight === current) inFlight = null;
        if (gen === generation && roots === rootsGen) last = { at: now(), result };
        if (gen === generation && result.changed) dirty = true;
        if (dirty) scheduleSave();
        return result;
      },
      (error) => {
        if (inFlight === current) inFlight = null;
        throw error;
      },
    );
    inFlight = current;
    return current.job;
  }

  // Forget everything in memory so the next scan re-reads every file. The persisted cache is
  // not reloaded, and the next save replaces it.
  function reset() {
    generation++;
    files = new Map();
    opencode.clear();
    store = createRecordStore({ names });
    baseGen = null;
    loaded = true;
    inFlight = null;
    last = null;
  }

  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await persist();
  }

  async function runScan(gen, force) {
    const map = files;
    const folderSpecs = extra;
    if (!loaded) {
      loaded = true;
      await loadCache(map);
    }
    const roots = await rootSpecs({ platform, env, home, readdir: fs.readdir });
    const run = { map, errors: 0, changed: false, failed: [], disabled: [], skipped: { zstd: 0, tooLarge: 0 } };
    const { found, folders, stats } = await listTranscripts({ fs, platform, roots, extra: folderSpecs, run });
    // Largest files first (a .zst byte costs several plain ones), so no big file starts last while threads idle.
    const weight = (file) => (stats.get(file.path)?.size ?? 0) * (file.compressed ? 7 : 1);
    const order = [...found].sort((a, b) => weight(b) - weight(a));
    await mapLimit(order, limit, (file) =>
      refreshFile(run, file, stats.get(file.path)).catch((error) => countFileError(run, file.path, error)),
    );
    const opencodeRun = await scanOpencode(run, folderSpecs, force);
    const walked = new Set(found.map((file) => file.path));
    // Cached files under a turned-off folder stay cached, so turning it on again reads only what changed.
    const off = (path) => !walked.has(path) && underAny(run.disabled, path, p.sep);
    for (const path of [...map.keys()]) {
      // A directory that failed to read says nothing about its files, so their cache entries stay.
      if (!walked.has(path) && !underAny(run.failed, path, p.sep) && !off(path)) drop(run, path);
    }
    const ordered = new Map();
    for (const file of found) if (map.has(file.path)) ordered.set(file.path, map.get(file.path));
    for (const [path, entry] of map) if (!ordered.has(path)) ordered.set(path, entry);
    const sources = [];
    for (const [path, entry] of ordered) {
      if (off(path)) continue;
      if (!ensureParser(entry)) {
        drop(run, path);
        continue;
      }
      sources.push({ id: path, table: entry.parser.table() });
    }
    sources.push(...opencodeRun.sources);
    const records = store.update(sources);
    // Each root counts every file it reaches, shared ones included, and the cached files under a dir of it
    // that failed to list.
    const tables = new Map(sources.map(({ id, table }) => [id, table]));
    const statuses = folders.map((folder) => {
      const paths = new Set(folder.paths);
      const failed = run.failed.filter((dir) => folder.dirs.includes(dir) || underAny(folder.dirs, dir, p.sep));
      if (failed.length > 0) for (const path of tables.keys()) if (underAny(failed, path, p.sep)) paths.add(path);
      const { rows, latest } = folderCounts(folder, [...paths].map((path) => tables.get(path)).filter(Boolean));
      return publicFolder({ ...folder, files: folder.paths.size, records: rows, latestRecordAt: latest > -Infinity ? new Date(latest).toISOString() : null });
    });
    statuses.push(...opencodeRun.folders);
    return {
      records,
      sources,
      names,
      files: found.length + opencodeRun.files,
      errors: run.errors,
      changed: run.changed,
      folders: statuses,
      skipped: run.skipped,
    };
  }

  // OpenCode keeps usage in one SQLite database (and a WAL). It is read whole when either file
  // changes and the table is reused otherwise, so a quiet poll costs two stats and no query.
  async function scanOpencode(run, extra, force) {
    const out = { sources: [], folders: [], files: 0 };
    let found;
    try {
      found = await findOpencodeDbs({ fs, platform, env, home });
    } catch (error) {
      run.errors++;
      out.folders.push(publicFolder({
        path: 'opencode', kind: 'opencode', source: 'default', state: 'warning',
        files: 0, records: 0, latestRecordAt: null, message: `Cannot list OpenCode data (${error?.code ?? 'error'})`,
      }));
      return out;
    }
    if (found.missing) {
      out.folders.push(publicFolder({ path: found.dir, kind: 'opencode', source: 'default', state: 'empty', files: 0, records: 0, latestRecordAt: null }));
      return out;
    }
    if (isTurnedOff(extra?.disabled, run.disabled, found.dir, platform, p.sep)) {
      out.folders.push(publicFolder({ path: found.dir, kind: 'opencode', source: 'default', state: 'off', files: 0, records: 0, latestRecordAt: null }));
      return out;
    }
    const seen = new Set();
    let records = 0;
    let latest = -Infinity;
    let state = found.dbs.length === 0 ? 'empty' : 'ok';
    let message = null;
    for (const db of found.dbs) {
      seen.add(db.path);
      let key;
      try {
        key = await opencodeKey({ fs, path: db.path });
      } catch {
        run.errors++;
        state = 'warning';
        message ??= 'Some OpenCode data could not be read';
        continue;
      }
      if (key === null) {
        if (opencode.delete(db.path)) run.changed = true;
        state = 'warning';
        message ??= 'OpenCode database not found';
        continue;
      }
      let entry = opencode.get(db.path);
      if (!entry || entry.key !== key || force) {
        const before = entry?.table;
        const version = before?.version;
        const result = await readOpencodeDb({ fs, path: db.path, key, names, prior: entry, reset: force });
        if (result.status === 'ok') {
          if (result.table !== before || result.table.version !== version) run.changed = true;
          entry = { key, table: result.table, rows: result.rows, cursor: result.cursor, size: result.size };
          opencode.set(db.path, entry);
        } else if (result.status === 'missing') {
          if (opencode.delete(db.path)) run.changed = true;
          continue;
        } else if (result.status === 'unsupported') {
          state = 'warning';
          message ??= result.error;
        } else {
          run.errors++;
          state = 'warning';
          message ??= 'Some OpenCode data could not be read';
        }
      }
      // On a transient read failure the last good table stays, so usage never flickers out of the totals.
      if (!entry) continue;
      out.sources.push({ id: db.path, table: entry.table });
      out.files++;
      records += entry.table.length;
      latest = Math.max(latest, maxMs(entry.table));
    }
    for (const path of [...opencode.keys()]) {
      if (seen.has(path)) continue;
      opencode.delete(path);
      run.changed = true;
    }
    out.folders.push(publicFolder({
      path: found.dir,
      kind: 'opencode',
      source: 'default',
      state,
      files: out.files,
      records,
      latestRecordAt: latest > -Infinity ? new Date(latest).toISOString() : null,
      ...(message ? { message } : {}),
    }));
    return out;
  }

  // Turns (rows with the same key count once) and the newest timestamp across a root's files. Kept per root
  // while its tables are unchanged, so a quiet poll costs one comparison per file.
  function folderCounts(folder, list) {
    const id = `${folder.kind}\u0000${folder.source}\u0000${folder.path}`;
    const memo = folderMemo.get(id);
    if (memo && memo.list.length === list.length && memo.list.every((table, i) => table === list[i] && memo.versions[i] === table.version && memo.lengths[i] === table.length)) {
      return memo.counts;
    }
    const keys = new Set();
    let rows = 0;
    let latest = -Infinity;
    for (const table of list) {
      for (let i = 0; i < table.length; i++) {
        const key = table.keys[i];
        if (key !== undefined) {
          if (keys.has(key)) continue;
          keys.add(key);
        }
        rows++;
        if (table.ms[i] > latest) latest = table.ms[i];
      }
    }
    const counts = { rows, latest };
    folderMemo.set(id, { list, versions: list.map((t) => t.version), lengths: list.map((t) => t.length), counts });
    return counts;
  }

  async function refreshFile(run, file, stat) {
    const entry = run.map.get(file.path);
    // A file replaced under the same name (a new inode) is read whole, even with the same mtime and size.
    const sameFile = !entry?.fileId || !file.fileId || entry.fileId === file.fileId;
    const prior = entry?.kind === file.kind && sameFile && ensureParser(entry) ? entry : undefined;
    if (entry && file.fileId && entry.fileId !== file.fileId && sameFile) {
      entry.fileId = file.fileId;
      touched.add(file.path);
      dirty = true;
    }
    const result = await readTranscript({
      fs,
      file,
      stat,
      // A tail pushes into the entry's own parser, so a mid-read save stores an offset matching its state.
      prior: prior ? { key: prior.key, offset: prior.offset, consumer: prior.parser, onAdvance: (offset) => (prior.offset = offset) } : null,
      pool,
      markers: MARKER_BYTES[file.kind],
      open: (f, state) => createParser(f.kind, f.ctx, state),
      maxWholeBytes: THREAD_MAX_BYTES,
      oversizedKey: oversized.get(file.path) ?? null,
    });
    if (result.status === 'skipped' && result.reason === 'too-large' && result.key) {
      // Saved too, so a restart doesn't decompress it up to the cap again.
      if (oversized.get(file.path) !== result.key) {
        oversized.set(file.path, result.key);
        touched.add(file.path);
        dirty = true;
      }
    } else oversized.delete(file.path);
    switch (result.status) {
      case 'unchanged':
        return;
      case 'gone':
        if (result.missing) run.errors++;
        drop(run, file.path);
        return;
      case 'skipped':
        run.skipped[result.reason === 'zstd' ? 'zstd' : 'tooLarge']++;
        drop(run, file.path);
        return;
      case 'read':
        run.changed = true;
        touched.add(file.path);
        // Lines already pushed stay counted; a full re-read on the next scan keeps them exact.
        if (result.error) run.errors++;
        run.map.set(file.path, {
          key: result.key,
          offset: result.offset,
          kind: file.kind,
          ctx: file.ctx,
          fileId: file.fileId ?? null,
          parser: result.consumer,
          state: result.state,
        });
        return;
    }
  }

  function createParser(kind, ctx, state) {
    return createRecordsConsumer(kind, ctx, state, { names });
  }

  function ensureParser(entry) {
    if (!entry) return false;
    if (entry.parser) return true;
    try {
      entry.parser = createParser(entry.kind, entry.ctx, entry.state);
      entry.state = null;
      return true;
    } catch {
      return false;
    }
  }

  function countFileError(run, path, error) {
    run.errors++;
    if (error?.code === 'ENOENT') drop(run, path);
  }

  function drop(run, path) {
    if (!run.map.delete(path)) return;
    run.changed = true;
    touched.add(path);
  }

  // A journal line from another gen predates the last rewrite and is skipped, as is one that doesn't
  // parse (a save cut short).
  async function loadCache(map) {
    if (!cacheFile) return;
    const raw = await readJson(cacheFile);
    if (raw?.version !== CACHE_VERSION || !isObject(raw.files)) {
      if (legacyCacheFile) await loadLegacy(map);
      return;
    }
    for (const [path, entry] of Object.entries(raw.files)) {
      if (isCacheEntry(entry)) map.set(path, fromCache(entry));
    }
    if (isObject(raw.oversized)) {
      for (const [path, key] of Object.entries(raw.oversized)) if (typeof key === 'string') oversized.set(path, key);
    }
    if (!Number.isSafeInteger(raw.gen)) return;
    let text = '';
    try {
      text = await fs.readFile(journalFile, 'utf8');
    } catch {}
    for (const line of text.split('\n')) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(item) || item[0] !== raw.gen || typeof item[1] !== 'string') continue;
      if (item[2] === null) map.delete(item[1]);
      else if (isCacheEntry(item[2])) map.set(item[1], fromCache(item[2]));
      if (typeof item[3] === 'string') oversized.set(item[1], item[3]);
      else oversized.delete(item[1]);
    }
    baseGen = raw.gen;
    journalBytes = text.length;
    journalTorn = text !== '' && !text.endsWith('\n');
  }

  // The first legacy file that loads is used. The next save writes the current cache file in full; the
  // old one stays for a downgrade.
  async function loadLegacy(map) {
    for (const file of [legacyCacheFile].flat()) {
      const raw = await readJson(file);
      if (!LEGACY_CACHE_VERSIONS.has(raw?.version) || !isObject(raw.files)) continue;
      for (const [path, entry] of Object.entries(raw.files)) {
        if (isCacheEntry(entry) && entry.kind !== 'codex') map.set(path, fromCache(entry));
      }
      if (map.size > 0) dirty = true;
      return;
    }
  }

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function scheduleSave() {
    if (!cacheFile || saveTimer) return;
    const wait = Math.max(0, lastSave + SAVE_EVERY_MS - now());
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist().catch(() => {});
    }, wait);
    saveTimer.unref();
  }

  function persist() {
    const job = saveChain.then(writeCache);
    saveChain = job.catch(() => {});
    return job;
  }

  async function writeCache() {
    if (!cacheFile || !dirty) return;
    dirty = false;
    const paths = [...touched];
    touched.clear();
    try {
      if (baseGen === null || paths.length > JOURNAL_MAX_FILES || journalBytes >= JOURNAL_MAX_BYTES) await writeBase();
      else await appendJournal(paths);
    } catch (error) {
      dirty = true;
      for (const path of paths) touched.add(path);
      throw error;
    }
    lastSave = now();
  }

  // A dropped file is a null entry. Entries are serialized before the first await: one consistent snapshot.
  async function appendJournal(paths) {
    // After a save cut short, a leading LF keeps the first new line from joining the torn one.
    let text = journalTorn ? '\n' : '';
    for (const path of paths) {
      const entry = files.get(path);
      const line = [baseGen, path, entry ? toCache(entry) : null];
      if (oversized.has(path)) line.push(oversized.get(path));
      text += `${JSON.stringify(line)}\n`;
    }
    try {
      await fs.appendFile(journalFile, text);
    } catch (error) {
      baseGen = null; // a line may be cut short, so the next save rewrites everything
      throw error;
    }
    journalBytes += text.length;
    journalTorn = false;
  }

  // A new gen retires every journal line. Written in ~1 MB pieces so no single string holds the whole cache.
  async function writeBase() {
    const gen = nextGen(baseGen);
    const parts = [];
    for (const [path, entry] of files) parts.push(`${JSON.stringify(path)}:${JSON.stringify(toCache(entry))}`);
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fs.mkdir(p.dirname(cacheFile), { recursive: true });
    try {
      const skips = JSON.stringify(Object.fromEntries(oversized));
      await fs.writeFile(tmp, pieces(`{"version":${CACHE_VERSION},"gen":${gen},"oversized":${skips},"files":{`, parts, '}}'));
      await fs.rename(tmp, cacheFile);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
    baseGen = gen;
    journalBytes = 0;
    journalTorn = false;
    await fs.unlink(journalFile).catch(() => {});
  }
}

function* pieces(head, parts, tail) {
  let chunk = head;
  for (let i = 0; i < parts.length; i++) {
    chunk += i === 0 ? parts[i] : `,${parts[i]}`;
    if (chunk.length >= WRITE_CHUNK_CHARS) {
      yield chunk;
      chunk = '';
    }
  }
  yield chunk + tail;
}

function nextGen(previous) {
  let gen;
  do gen = Math.floor(Math.random() * 2 ** 48);
  while (gen === previous);
  return gen;
}

function fromCache(entry) {
  return { key: entry.key, offset: entry.offset, kind: entry.kind, ctx: entry.ctx, fileId: typeof entry.fileId === 'string' ? entry.fileId : null, state: entry.state, parser: null };
}

function toCache(entry) {
  return { key: entry.key, offset: entry.offset, kind: entry.kind, ctx: entry.ctx, fileId: entry.fileId ?? null, state: entry.parser ? entry.parser.state() : entry.state };
}

function listOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
}

function publicFolder({ path, kind, source, state, files, records, latestRecordAt, message }) {
  return { path, kind, source, state, files, records, latestRecordAt, ...(message ? { message } : {}) };
}


function noop() {}

function underAny(dirs, file, sep) {
  return dirs.some((dir) => file.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

// Settings paths are expanded by the worker but not resolved, so compare case-insensitively on Windows
// and also treat a folder under a turned-off root as off.
function isTurnedOff(settings, canonical, dir, platform, sep) {
  const key = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const target = key(dir);
  return [...(settings ?? []), ...(canonical ?? [])].some((value) => {
    if (typeof value !== 'string') return false;
    const off = key(value);
    return off === target || target.startsWith(off.endsWith(sep) ? off : off + sep);
  });
}

function maxMs(table) {
  let max = -Infinity;
  for (let i = 0; i < table.length; i++) if (table.ms[i] > max) max = table.ms[i];
  return max;
}

function isCacheEntry(entry) {
  return (
    isObject(entry) &&
    (typeof entry.key === 'string' || entry.key === null) &&
    Number.isSafeInteger(entry.offset) &&
    entry.offset >= 0 &&
    Object.hasOwn(PROVIDERS, entry.kind) &&
    isObject(entry.ctx) &&
    isObject(entry.state)
  );
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(lanes);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
