// Scanner adapter: walks Claude and Codex transcript roots and reads only what changed.
// Stat-first: a file whose `mtimeMs:size` key is unchanged costs one stat and no reads.
// Entries keep the parser per file, so records survive tails. The persisted cache stores
// { key, offset, kind, ctx, state } per file; `offset` is the end of the last complete line.
import fsp from 'node:fs/promises';
import os from 'node:os';
import { mergeRecords } from '../core/merge.mjs';
import { PROVIDERS } from '../core/providers.mjs';
import { MARKER_BYTES, markedLines } from './lines.mjs';
import { createParsePool } from './parse-pool.mjs';

export { markedLines };
import { pathFor, resolveRoots } from './paths.mjs';

const CACHE_VERSION = 2;
const REUSE_MS = 5_000;
const SAVE_EVERY_MS = 30_000;
const CHUNK_BYTES = 4 << 20;
// Files read whole for the first time go to parse threads when they are at most this big.
const THREAD_MAX_BYTES = 64 << 20;
const LF = 0x0a;
const JSONL = /\.jsonl$/i;
const EMPTY = Buffer.alloc(0);

export function createScanner({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fs = fsp,
  cacheFile,
  concurrency = 8,
  // Threads that parse files read whole for the first time (first open, rewritten files).
  // 0 parses on the calling thread. Tail reads always parse inline: they are small.
  threads = Math.min(4, Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  now = () => Date.now(),
} = {}) {
  const p = pathFor(platform);
  const limit = Math.max(1, Math.floor(concurrency));
  let files = new Map();
  let loaded = false;
  let generation = 0;
  let inFlight = null; // { job, roots } while a run is going
  let last = null;
  let extra = { claude: [], codex: [] }; // absolute folders from settings, see setExtraRoots
  let extraKey = '[[],[]]';
  let rootsGen = 0;
  let dirty = false;
  let lastSave = 0;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  const pool = threads > 0 ? createParsePool(threads) : null;

  return { scan, reset, flush, close: () => pool?.close(), setExtraRoots };

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
        if (gen === generation && result.changed) {
          dirty = true;
          scheduleSave();
        }
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
    const run = { map, errors: 0, changed: false, failed: [] };
    const { found, owners, folders } = await listTranscripts(roots, folderSpecs, run);
    await mapLimit(found, limit, (file) =>
      refreshFile(run, file).catch(() => {
        run.errors++;
      }),
    );
    const walked = new Set(found.map((file) => file.path));
    for (const path of [...map.keys()]) {
      // A directory that failed to read says nothing about its files, so their cache entries stay.
      if (!walked.has(path) && !underAny(run.failed, path, p.sep)) drop(run, path);
    }
    const records = [];
    for (const [path, entry] of [...map]) {
      if (!ensureParser(entry)) {
        drop(run, path);
        continue;
      }
      const list = entry.parser.records();
      for (const record of list) records.push(record);
      const folder = owners.get(path);
      if (folder) folder.records += list.length;
    }
    return {
      records: mergeRecords([records]),
      files: found.length,
      errors: run.errors,
      changed: run.changed,
      folders: folders.map(publicFolder),
    };
  }

  // Every file path is canonical: top-level dirs are resolved once, and so are symlinked files.
  // A physical file is therefore listed once even when two roots reach it through a symlink.
  // Default roots come first, so they own a file that an extra folder also reaches. `owners` maps
  // each file that an extra folder owns to that folder's status entry.
  async function listTranscripts(roots, folderSpecs, run) {
    const out = [];
    const owners = new Map();
    const seen = new Set();
    const walks = new Map(); // identity of a top-level dir -> files under it, walked once per run
    const walkTop = async (dir) => {
      const top = await canonicalDir(dir);
      if (top === null) return null;
      const id = identityOf(top);
      if (!walks.has(id)) {
        const found = [];
        await walk(top, found, run);
        walks.set(id, found);
      }
      return walks.get(id);
    };
    const claim = (kind, paths, folder) => {
      for (const path of paths) {
        if (seen.has(identityOf(path))) continue;
        seen.add(identityOf(path));
        if (folder) owners.set(path, folder);
        out.push({
          path,
          kind,
          ctx: { sessionId: p.basename(path, p.extname(path)), project: p.basename(p.dirname(path)) },
        });
      }
    };
    for (const [kind, provider] of Object.entries(PROVIDERS)) {
      for (const root of roots[kind]) {
        for (const sub of provider.subdirs) claim(kind, (await walkTop(p.join(root, sub))) ?? [], null);
      }
    }
    const folders = [];
    for (const [kind, provider] of Object.entries(PROVIDERS)) {
      for (const folder of folderSpecs[kind]) {
        const entry = { path: folder, kind, state: 'ok', files: 0, records: 0, message: null };
        folders.push(entry);
        const errorsBefore = run.errors;
        const top = await canonicalDir(folder);
        if (top === null) {
          Object.assign(entry, { state: 'warning', message: 'Folder not found' });
          continue;
        }
        let st;
        try {
          st = await fs.stat(top);
        } catch (error) {
          // The folder's own status carries this warning; it is not counted as a file error.
          Object.assign(entry, { state: 'warning', message: `Cannot open folder (${error?.code ?? 'error'})` });
          continue;
        }
        if (!st.isDirectory()) {
          Object.assign(entry, { state: 'warning', message: 'Not a folder' });
          continue;
        }
        // A folder that holds the provider's main subdir (projects, sessions) is read like a default
        // root. Any other folder is read whole.
        const asRoot = await isDirectory(fs, p.join(top, provider.subdirs[0]));
        for (const dir of asRoot ? provider.subdirs.map((sub) => p.join(top, sub)) : [top]) {
          const found = await walkTop(dir);
          if (!found) continue;
          entry.files += found.length;
          claim(kind, found, entry);
        }
        if (run.errors > errorsBefore) Object.assign(entry, { state: 'warning', message: 'Some files could not be read' });
      }
    }
    return { found: out, owners, folders };
  }

  // Realpath of a top-level dir. null when it is gone; other failures keep the dir as given, so
  // the read in walk() reports them.
  async function canonicalDir(dir) {
    try {
      return await fs.realpath(dir);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      return dir;
    }
  }

  // Symlinked directories are not Dirent directories, so they are never followed. Only the
  // top-level dirs (resolved by canonicalDir) can be symlinks.
  async function walk(dir, out, run) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        run.errors++;
        run.failed.push(dir);
      }
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = p.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, out, run);
      else if (JSONL.test(entry.name)) out.push(entry.isSymbolicLink() ? await realFile(full) : full);
    }
  }

  async function realFile(file) {
    try {
      return await fs.realpath(file);
    } catch {
      return file;
    }
  }

  // Key used to decide that two paths name the same file or directory.
  function identityOf(file) {
    return platform === 'win32' ? file.toLowerCase() : file;
  }

  async function refreshFile(run, file) {
    let st;
    try {
      st = await fs.stat(file.path);
    } catch (error) {
      countFileError(run, file.path, error);
      return;
    }
    if (!st.isFile()) {
      drop(run, file.path);
      return;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    let entry = run.map.get(file.path);
    if (entry?.kind !== file.kind || !ensureParser(entry)) entry = undefined;
    if (entry?.key === key) return;

    let fh;
    try {
      fh = await fs.open(file.path, 'r');
    } catch (error) {
      countFileError(run, file.path, error);
      return;
    }
    run.changed = true;
    let target = null;
    try {
      // Size grew with no older mtime, and the byte before the stored offset ends a line: only the
      // bytes past the offset are new. Otherwise the file was rewritten, so it is read whole.
      const tail = entry !== undefined && entry.key !== null && canTail(entry.key, st) && (await endsLine(fh, entry.offset));
      target = tail ? entry : freshEntry(file);
      if (!tail) run.map.set(file.path, target);
      if (!tail && pool && st.size > 0 && st.size <= THREAD_MAX_BYTES && (await readWholeThreaded(fh, target, st.size))) {
        // parsed on a thread; target holds its state and offset
      } else {
        await readAppended(fh, target, st.size);
      }
      target.key = key;
    } catch {
      run.errors++;
      // Lines already pushed stay counted; a full re-read on the next scan keeps them exact.
      if (target) target.key = null;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  // True when offset is 0 or the byte before it is LF. The scanner only stores offsets that follow
  // an LF, so any other byte means the file was replaced under the stored offset.
  async function endsLine(fh, offset) {
    if (offset === 0) return true;
    const probe = Buffer.alloc(1);
    const { bytesRead } = await fh.read(probe, 0, 1, offset - 1);
    return bytesRead === 1 && probe[0] === LF;
  }

  // Reads a whole file and hands the bytes to a parse thread. Returns false (nothing changed on
  // target) when the pool can't take it, so the caller falls back to the inline reader.
  async function readWholeThreaded(fh, target, size) {
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) {
      const { bytesRead } = await fh.read(buf, got, size - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const cut = buf.subarray(0, got).lastIndexOf(LF) + 1;
    if (cut === 0) return got === 0;
    let result;
    try {
      result = await pool.parse(buf.subarray(0, cut), target.kind, target.ctx);
    } catch {
      return false;
    }
    target.parser = null;
    target.state = result.state;
    target.offset = cut;
    return true;
  }

  // Reads [offset, end) in chunks. Each chunk is cut at its last LF, so the parser only sees
  // whole lines and `offset` advances in the same step as the push.
  async function readAppended(fh, target, end) {
    let pos = target.offset;
    let carry = EMPTY;
    while (pos < end) {
      const want = Math.min(CHUNK_BYTES, end - pos);
      const buf = Buffer.allocUnsafe(carry.length + want);
      carry.copy(buf, 0);
      const { bytesRead } = await fh.read(buf, carry.length, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = buf.subarray(0, carry.length + bytesRead);
      const cut = data.lastIndexOf(LF);
      if (cut < 0) {
        carry = data;
        continue;
      }
      const text = markedLines(data, cut + 1, MARKER_BYTES[target.kind]);
      if (text) target.parser.push(text);
      target.offset += cut + 1;
      carry = data.subarray(cut + 1);
    }
  }

  function countFileError(run, path, error) {
    run.errors++;
    if (error?.code === 'ENOENT') drop(run, path);
  }

  function drop(run, path) {
    if (run.map.delete(path)) run.changed = true;
  }

  async function loadCache(map) {
    if (!cacheFile) return;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    } catch {
      return;
    }
    if (raw?.version !== CACHE_VERSION || !isObject(raw.files)) return;
    for (const [path, entry] of Object.entries(raw.files)) {
      if (!isCacheEntry(entry)) continue;
      map.set(path, { key: entry.key, offset: entry.offset, kind: entry.kind, ctx: entry.ctx, state: entry.state, parser: null });
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
    const body = JSON.stringify({ version: CACHE_VERSION, files: serialize(files) });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    try {
      await fs.mkdir(p.dirname(cacheFile), { recursive: true });
      await fs.writeFile(tmp, body);
      try {
        await fs.rename(tmp, cacheFile);
      } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
      }
    } catch (error) {
      dirty = true;
      throw error;
    }
    lastSave = now();
  }
}

function listOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
}

async function isDirectory(fs, file) {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch {
    return false;
  }
}

function publicFolder({ path, kind, state, files, records, message }) {
  return message ? { path, kind, state, files, records, message } : { path, kind, state, files, records };
}

function noop() {}

function freshEntry(file) {
  return { key: null, offset: 0, kind: file.kind, ctx: file.ctx, parser: createParser(file.kind, file.ctx), state: null };
}

function underAny(dirs, file, sep) {
  return dirs.some((dir) => file.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

function createParser(kind, ctx, state) {
  return PROVIDERS[kind].createParser(ctx, state);
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

function canTail(prevKey, st) {
  const i = prevKey.lastIndexOf(':');
  const prevMtime = Number(prevKey.slice(0, i));
  const prevSize = Number(prevKey.slice(i + 1));
  return i > 0 && Number.isFinite(prevMtime) && Number.isFinite(prevSize) && st.size > prevSize && st.mtimeMs >= prevMtime;
}

function serialize(map) {
  const out = {};
  for (const [path, entry] of map) {
    out[path] = {
      key: entry.key,
      offset: entry.offset,
      kind: entry.kind,
      ctx: entry.ctx,
      state: entry.parser ? entry.parser.state() : entry.state,
    };
  }
  return out;
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

