// Scanner adapter: walks Claude and Codex transcript roots and reads only what changed.
// Stat-first: a file whose `mtimeMs:size` key is unchanged costs one stat and no reads.
// Entries keep the parser per file, so records survive tails. The persisted cache stores
// { key, offset, kind, ctx, state } per file; `offset` is the end of the last complete line.
// Listing and reading live in transcript-files.mjs; this file keeps the cache and the records.
import fsp from 'node:fs/promises';
import os from 'node:os';
import { createRecordStore } from '../core/record-store.mjs';
import { NameDict } from '../core/table.mjs';
import { PROVIDERS } from '../core/providers.mjs';
import { MARKER_BYTES, createRecordsConsumer, markedLines } from './lines.mjs';
import { createParsePool } from './parse-pool.mjs';
import { pathFor, resolveRoots } from './paths.mjs';
import { listTranscripts, readTranscript } from './transcript-files.mjs';

export { markedLines };

const CACHE_VERSION = 5;
// The cache before records were stored as columns. Read once when there is no current cache; its
// parser states are converted when the parsers are restored, so no file is read again.
const LEGACY_CACHE_VERSION = 4;
const REUSE_MS = 5_000;
const SAVE_EVERY_MS = 30_000;
// Files read whole for the first time go to parse threads when they are at most this big.
// Compressed files over this size are skipped: they are never read whole on the calling thread.
const THREAD_MAX_BYTES = 64 << 20;
const STAT_LIMIT = 64;
// Saves append the files that changed to a journal next to the cache file. The whole cache is
// rewritten (and the journal emptied) on the first save, after reset, when more files changed than
// this, or once the journal is this big.
const JOURNAL_MAX_FILES = 512;
const JOURNAL_MAX_BYTES = 32 << 20;
const WRITE_CHUNK_CHARS = 1 << 20;

export function createScanner({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fs = fsp,
  cacheFile,
  // The previous version's cache file, read when cacheFile is missing or unusable. It is left as is.
  legacyCacheFile = null,
  concurrency = 8,
  // Threads that parse files read whole for the first time (first open, rewritten files).
  // 0 parses on the calling thread. Tail reads always parse inline: they are small. Each thread
  // costs ~35 MB; on a full local history 4 took ~2.1 s, 6 ~1.6 s, 8 ~1.5 s (measured).
  threads = Math.min(6, Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  now = () => Date.now(),
} = {}) {
  const p = pathFor(platform);
  const limit = Math.max(1, Math.floor(concurrency));
  let files = new Map();
  let loaded = false;
  let generation = 0;
  let inFlight = null; // { job, roots } while a run is going
  let last = null;
  // Every file's table interns into one dictionary, so the store copies their columns in bulk.
  const names = new NameDict();
  let store = createRecordStore({ names });
  let extra = { claude: [], codex: [] }; // absolute folders from settings, see setExtraRoots
  let extraKey = '[[],[]]';
  let rootsGen = 0;
  let dirty = false;
  const touched = new Set(); // paths read or dropped since the last save
  const journalFile = cacheFile ? `${cacheFile}.journal` : null;
  let baseGen = null; // gen of the cache file the journal extends; null: the next save rewrites it
  let journalBytes = 0;
  let lastSave = 0;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  // Parse threads open files with the real fs, so an injected fs (tests) parses inline.
  const pool = threads > 0 && fs === fsp ? createParsePool(threads) : null;

  // pool() lets the digest scanner share these threads instead of starting its own.
  return { scan, reset, flush, close: () => pool?.close(), setExtraRoots, pool: () => pool };

  // Extra folders are read next to the default roots. A change drops the reuse window, and a run
  // that started with the old folders finishes before a new one starts. Same folders: no-op.
  function setExtraRoots(next) {
    const claude = listOfStrings(next?.claude);
    const codex = listOfStrings(next?.codex);
    const key = JSON.stringify([claude, codex]);
    if (key === extraKey) return;
    extraKey = key;
    extra = { claude, codex };
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
    current.job = (prior ? prior.then(() => runScan(gen)) : runScan(gen)).then(
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

  async function runScan(gen) {
    const map = files;
    const folderSpecs = extra;
    if (!loaded) {
      loaded = true;
      await loadCache(map);
    }
    const roots = await resolveRoots({ platform, env, home, realpath: fs.realpath });
    const run = { map, errors: 0, changed: false, failed: [], skipped: { zstd: 0, tooLarge: 0 } };
    const { found, owners, folders } = await listTranscripts({ fs, platform, roots, extra: folderSpecs, run });
    // Stat everything first and read the largest files first (a .zst byte costs ~7 plain ones), so
    // no big file starts last while the other threads sit idle. readTranscript reuses the stat.
    const stats = new Map();
    await mapLimit(found, STAT_LIMIT, async (file) => {
      try {
        stats.set(file.path, await fs.stat(file.path));
      } catch {}
    });
    const weight = (file) => (stats.get(file.path)?.size ?? 0) * (file.compressed ? 7 : 1);
    const order = [...found].sort((a, b) => weight(b) - weight(a));
    await mapLimit(order, limit, (file) =>
      refreshFile(run, file, stats.get(file.path)).catch((error) => countFileError(run, file.path, error)),
    );
    const walked = new Set(found.map((file) => file.path));
    for (const path of [...map.keys()]) {
      // A directory that failed to read says nothing about its files, so their cache entries stay.
      if (!walked.has(path) && !underAny(run.failed, path, p.sep)) drop(run, path);
    }
    // Listing order, so ties between files resolve the same way on every run (map order follows
    // which file finished reading first). Entries kept for unreadable folders go last.
    const ordered = new Map();
    for (const file of found) if (map.has(file.path)) ordered.set(file.path, map.get(file.path));
    for (const [path, entry] of map) if (!ordered.has(path)) ordered.set(path, entry);
    const sources = [];
    for (const [path, entry] of ordered) {
      if (!ensureParser(entry)) {
        drop(run, path);
        continue;
      }
      const table = entry.parser.table();
      sources.push({ id: path, table });
      const folder = owners.get(path);
      if (folder) folder.records += table.length;
    }
    // Only what changed since the last run is merged again; nothing changed, same table back.
    const records = store.update(sources);
    return {
      records,
      // The files' own tables, in order, and the dictionary they share: for merging with other sources.
      sources,
      names,
      files: found.length,
      errors: run.errors,
      changed: run.changed,
      folders: folders.map(publicFolder),
      skipped: run.skipped,
    };
  }

  // Brings one file's entry up to date. The reader decides between unchanged, tail, whole read
  // and skipped; this keeps the cache entry and the error counts.
  async function refreshFile(run, file, stat) {
    const entry = run.map.get(file.path);
    const prior = entry?.kind === file.kind && ensureParser(entry) ? entry : undefined;
    const result = await readTranscript({
      fs,
      file,
      stat,
      prior: prior ? { key: prior.key, offset: prior.offset, consumer: prior.parser } : null,
      pool,
      markers: MARKER_BYTES[file.kind],
      open: (f, state) => createParser(f.kind, f.ctx, state),
      maxWholeBytes: THREAD_MAX_BYTES,
    });
    switch (result.status) {
      case 'unchanged':
        return;
      case 'gone':
        // A file whose stat said ENOENT is an error and leaves the cache. A path that is no
        // longer a file just leaves it.
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
          parser: result.consumer,
          state: result.state,
        });
        return;
    }
  }

  function createParser(kind, ctx, state) {
    return createRecordsConsumer(kind, ctx, state, { names });
  }

  // Builds the parser from persisted state on first use. False when the state cannot be restored.
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

  // The cache file, then the journal lines written on top of it (same gen). A line from another gen
  // was written before the cache file was last rewritten, so it is stale and skipped; so is a line
  // that doesn't parse (a save cut short).
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
    }
    baseGen = raw.gen;
    journalBytes = text.length;
  }

  // The old cache's entries, whose parser states the parsers convert on restore. The next save
  // writes the current cache file in full; the old one stays for a downgrade.
  async function loadLegacy(map) {
    const raw = await readJson(legacyCacheFile);
    if (raw?.version !== LEGACY_CACHE_VERSION || !isObject(raw.files)) return;
    for (const [path, entry] of Object.entries(raw.files)) {
      if (isCacheEntry(entry)) map.set(path, fromCache(entry));
    }
    // Saved after the first run, once every parser has converted its state.
    if (map.size > 0) dirty = true;
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

  // The changed entries as journal lines; a dropped file is a null entry. Entries are serialized
  // before the first await, so the lines are one consistent snapshot.
  async function appendJournal(paths) {
    let text = '';
    for (const path of paths) {
      const entry = files.get(path);
      text += `${JSON.stringify([baseGen, path, entry ? toCache(entry) : null])}\n`;
    }
    try {
      await fs.appendFile(journalFile, text);
    } catch (error) {
      baseGen = null; // a line may be cut short, so the next save rewrites everything
      throw error;
    }
    journalBytes += text.length;
  }

  // Rewrites the cache file under a new gen, atomically, which also retires every journal line.
  // Each entry is serialized on its own and written in ~1 MB pieces, so no single string holds
  // the whole cache.
  async function writeBase() {
    const gen = nextGen(baseGen);
    const parts = [];
    for (const [path, entry] of files) parts.push(`${JSON.stringify(path)}:${JSON.stringify(toCache(entry))}`);
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fs.mkdir(p.dirname(cacheFile), { recursive: true });
    try {
      await fs.writeFile(tmp, pieces(`{"version":${CACHE_VERSION},"gen":${gen},"files":{`, parts, '}}'));
      await fs.rename(tmp, cacheFile);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
    baseGen = gen;
    journalBytes = 0;
    await fs.unlink(journalFile).catch(() => {});
  }
}

// Comma-joined parts between a head and a tail, yielded in strings of about WRITE_CHUNK_CHARS.
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

// A gen for a rewritten cache file, never the one before it.
function nextGen(previous) {
  let gen;
  do gen = Math.floor(Math.random() * 2 ** 48);
  while (gen === previous);
  return gen;
}

function fromCache(entry) {
  return { key: entry.key, offset: entry.offset, kind: entry.kind, ctx: entry.ctx, state: entry.state, parser: null };
}

function toCache(entry) {
  return { key: entry.key, offset: entry.offset, kind: entry.kind, ctx: entry.ctx, state: entry.parser ? entry.parser.state() : entry.state };
}

function listOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
}

function publicFolder({ path, kind, state, files, records, message }) {
  return message ? { path, kind, state, files, records, message } : { path, kind, state, files, records };
}

function noop() {}

function underAny(dirs, file, sep) {
  return dirs.some((dir) => file.startsWith(dir.endsWith(sep) ? dir : dir + sep));
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
