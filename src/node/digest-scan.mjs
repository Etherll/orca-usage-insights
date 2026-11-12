// Digest scanner: one token digest per transcript for the Breakdown view. It lists and reads files
// through transcript-files.mjs (the same rules as the records scanner) and keeps one shard per file
// under digests-v1/, so only changed files are read again. Runs only when Breakdown asks for it.
//
// A shard is <sha1 of path>.json: { v: 3, path, key, offset, compressed, kind, sessionId, ctx,
// digest } with the digest's rows packed and base64 (digest-rows.mjs). A plain file's adapter and
// fold state, needed only to read on from its offset, is in <sha1>.state.json: { v: 3, path, key,
// state }, used only when its key matches the shard's. Version 2 shards held both in one file with
// rows as arrays; they are read and converted on first use, so no transcript is read again.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { decodeDigest, encodeDigest, packDigest } from '../core/breakdown/digest-rows.mjs';
import { createDigestConsumer } from './digest-consumer.mjs';
import { createParsePool } from './parse-pool.mjs';
import { resolveRoots } from './paths.mjs';
import { listTranscripts, readTranscript } from './transcript-files.mjs';

const SHARD_VERSION = 3;
const LEGACY_SHARD_VERSION = 2;
const CONCURRENCY = 8;

// cacheDir: the digests folder, or null to keep everything in memory (tests, previews).
// Each consumer here is dropped once its state and digest are read, and every state it starts from
// is a fresh parse or one no other code reads, so no copy is made either way.
const ADOPT = { adopt: true };

export function createDigestScanner({
  fs = fsp,
  cacheDir = null,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  threads = Math.min(4, Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  // A pool to share (the records scanner's). Without one, the scanner starts and closes its own.
  sharedPool = null,
} = {}) {
  // path -> { key, offset, compressed, sessionId, kind, digest, state? }. Digests are kept packed
  // (digest-rows.mjs). Plain files keep their adapter and fold state on disk only; it is read back
  // when the file grows.
  const files = new Map();
  // The last result. A scan that finds the same digests and states returns it again, so the
  // Breakdown analysis built from it is reused.
  let last = null;
  // Targets ([key, label, kind]) shared by every digest that has them: the same file or command
  // shows up in many sessions (106k targets, 18k distinct, on a large history).
  const targets = new Map(); // key -> [target, ...] (one per label and kind)
  const loaded = new Set();
  const oversized = new Map(); // path -> key of a compressed file that decompressed past the cap
  let pool = sharedPool;
  let run = null;
  let progress = { done: 0, total: 0 };

  return { scan, progress: () => ({ ...progress }), close };

  // since: epoch ms. Files last changed before it hold no spend after it, so they are not read
  // (state 'old'); a wider range reads them later. A call joins the running scan when that scan
  // covers its range and lists the same extra folders, else it runs after it.
  function scan({ extra = { claude: [], codex: [] }, since = 0 } = {}) {
    const folders = JSON.stringify([extra?.claude ?? [], extra?.codex ?? []]);
    if (run && run.since <= since && run.folders === folders) return run.done;
    const before = run?.done.catch(() => {}) ?? null;
    const current = { since, folders, done: null };
    current.done = (before ? before.then(() => runScan(extra, since)) : runScan(extra, since)).finally(() => {
      if (run === current) run = null;
    });
    run = current;
    return current.done;
  }

  async function close() {
    await run?.done.catch(() => {});
    if (pool !== sharedPool) await pool?.close();
    pool = sharedPool;
  }

  async function runScan(extra, since) {
    if (threads > 0 && !pool && fs === fsp) pool = createParsePool(threads);
    const roots = await resolveRoots({ platform, env, home, realpath: fs.realpath });
    const listing = { errors: 0, failed: [] };
    const { found } = await listTranscripts({ fs, platform, roots, extra, run: listing });
    progress = { done: 0, total: found.length };
    const statuses = new Map();
    let next = 0;
    const lanes = Array.from({ length: Math.min(CONCURRENCY, found.length) }, async () => {
      while (next < found.length) {
        const file = found[next++];
        statuses.set(file.path, await refresh(file, since).catch(() => 'error'));
        progress.done++;
      }
    });
    await Promise.all(lanes);
    const walked = new Set(found.map((file) => file.path));
    const sep = platform === 'win32' ? '\\' : '/';
    const underFailed = (path) => listing.failed.some((dir) => path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
    const kept = [];
    for (const path of [...files.keys()]) {
      if (walked.has(path)) continue;
      // A directory that failed to list says nothing about its files: keep their digests.
      if (underFailed(path)) {
        kept.push(path);
        continue;
      }
      files.delete(path);
      await removeShard(path);
    }
    const digests = [];
    const status = [];
    for (const file of found) {
      const entry = files.get(file.path);
      const state = statuses.get(file.path) ?? 'error';
      status.push({ path: file.path, provider: file.kind, host: 'local', sessionId: file.ctx.sessionId, state });
      if (state === 'ok' && entry?.digest) digests.push({ path: file.path, compressed: file.compressed, sessionId: file.ctx.sessionId, digest: entry.digest });
    }
    for (const path of kept) {
      const entry = files.get(path);
      if (entry?.digest) digests.push({ path, compressed: entry.compressed, sessionId: entry.sessionId, digest: entry.digest });
    }
    if (last !== null && sameResult(last, digests, status)) return last;
    last = { digests, files: status, done: progress.done, total: progress.total };
    return last;
  }

  // Brings one file's digest up to date. Returns its status: ok, old, zstd, too-large or error.
  async function refresh(listed, since) {
    // The adapters need home to write paths under it as ~/...; ctx goes to parse threads too.
    const file = { ...listed, ctx: { ...listed.ctx, home } };
    // One stat serves the age check, the unchanged check and the read.
    const st = await fs.stat(file.path).catch(() => null);
    if (since > 0 && st?.isFile() && st.mtimeMs < since) return 'old';
    let entry = files.get(file.path);
    if (!entry && !loaded.has(file.path)) {
      loaded.add(file.path);
      entry = await loadShard(file);
      if (entry) files.set(file.path, entry);
    }
    const prior = entry && entry.key !== null ? { key: entry.key, offset: entry.offset, consumer: null } : null;
    if (prior && st?.isFile() && `${st.mtimeMs}:${st.size}` === prior.key) return 'ok';
    // The consumer for a tail read is rebuilt from the stored state only when the file changed.
    if (prior && !file.compressed) {
      const state = entry.state ?? (await loadState(file.path, entry.key));
      try {
        if (state) prior.consumer = createDigestConsumer(file, state, ADOPT);
      } catch {
        prior.consumer = null; // unusable state: read the file whole
      }
      if (!prior.consumer) prior.key = null;
    }
    const result = await readTranscript({
      fs,
      file,
      stat: st,
      prior,
      pool,
      mode: 'digest',
      markers: null,
      open: (f, state) => createDigestConsumer(f, state, ADOPT),
      oversizedKey: oversized.get(file.path) ?? null,
    });
    if (result.status === 'skipped' && result.reason === 'too-large' && result.key) oversized.set(file.path, result.key);
    else oversized.delete(file.path);
    if (result.status === 'unchanged') return 'ok';
    if (result.status === 'gone') {
      files.delete(file.path);
      await removeShard(file.path);
      return 'error';
    }
    if (result.status === 'skipped') {
      files.delete(file.path);
      return result.reason;
    }
    if (result.error || result.key === null) {
      files.set(file.path, { key: null, offset: 0, compressed: file.compressed, kind: file.kind, sessionId: file.ctx.sessionId, digest: null });
      return 'error';
    }
    const consumer = result.consumer ?? createDigestConsumer(file, result.state, ADOPT);
    const state = consumer.state();
    const digest = consumer.digest();
    const next = {
      key: result.key,
      offset: result.offset,
      compressed: file.compressed,
      kind: file.kind,
      sessionId: file.ctx.sessionId,
      digest: compact(packDigest(digest)), // packed in memory; plain in the shard
    };
    files.set(file.path, next);
    // A compressed file is always read whole, so its state is never needed again.
    await saveShard(file.path, { key: next.key, offset: next.offset, compressed: next.compressed, kind: next.kind, sessionId: next.sessionId, ctx: file.ctx }, digest, file.compressed ? null : state);
    return 'ok';
  }

  // Points a packed digest's targets at the shared ones. Only this scanner holds the digest, and
  // the targets are frozen, so nothing can change one through another.
  function compact(digest) {
    if (!Array.isArray(digest?.targets)) return digest;
    digest.targets = digest.targets.map((target) => {
      if (!Array.isArray(target)) return target;
      const [key, label, kind] = target;
      let list = targets.get(key);
      if (list === undefined) targets.set(key, (list = []));
      let shared = list.find((t) => t.length === target.length && t[1] === label && t[2] === kind);
      if (shared === undefined) list.push((shared = Object.freeze([...target])));
      return shared;
    });
    return digest;
  }

  function shardPath(path) {
    return join(cacheDir, `${createHash('sha1').update(path).digest('hex')}.json`);
  }

  function statePath(path) {
    return join(cacheDir, `${createHash('sha1').update(path).digest('hex')}.state.json`);
  }

  // The file's entry from its shard, or null when there is none (or it is unusable).
  async function loadShard(file) {
    if (!cacheDir) return null;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(shardPath(file.path), 'utf8'));
    } catch {
      return null;
    }
    if (raw?.path !== file.path || raw.kind !== file.kind || !raw.digest) return null;
    const meta = { key: raw.key, offset: raw.offset, compressed: raw.compressed, kind: raw.kind, sessionId: raw.sessionId };
    if (raw.v === LEGACY_SHARD_VERSION) {
      // Converted once to the current form; if that write fails, it is converted next time.
      await writeShard(file.path, { ...meta, ctx: raw.ctx }, raw.digest, raw.state ?? null).catch(() => {});
      return { ...meta, digest: compact(packDigest(raw.digest)) };
    }
    if (raw.v !== SHARD_VERSION) return null;
    try {
      return { ...meta, digest: compact(decodeDigest(raw.digest)) };
    } catch {
      return null;
    }
  }

  // A plain file's state for a tail read, when it was saved with the same key; else null.
  async function loadState(path, key) {
    if (!cacheDir) return null;
    try {
      const raw = JSON.parse(await fs.readFile(statePath(path), 'utf8'));
      return raw?.v === SHARD_VERSION && raw.path === path && raw.key === key ? raw.state : null;
    } catch {
      return null;
    }
  }

  async function saveShard(path, meta, digest, state) {
    const entry = files.get(path);
    if (!cacheDir) {
      // In memory only: keep the state for the next tail read.
      if (entry) entry.state = state;
      return;
    }
    try {
      await writeShard(path, meta, digest, state);
      if (entry) delete entry.state;
    } catch {
      // The shard on disk is now older than memory, so the next tail read uses this state.
      if (entry) entry.state = state;
    }
  }

  // State first: a crash between the two writes leaves a state whose key the shard doesn't have.
  async function writeShard(path, meta, digest, state) {
    await fs.mkdir(cacheDir, { recursive: true });
    if (state) await writeJson(statePath(path), { v: SHARD_VERSION, path, key: meta.key, state });
    else await fs.unlink(statePath(path)).catch(() => {});
    await writeJson(shardPath(path), { v: SHARD_VERSION, path, ...meta, digest: encodeDigest(digest) });
  }

  async function writeJson(target, data) {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function removeShard(path) {
    if (!cacheDir) return;
    await fs.unlink(shardPath(path)).catch(() => {});
    await fs.unlink(statePath(path)).catch(() => {});
  }

}

// True when a scan found exactly what the last result holds: the same digest objects for the same
// files, in order, and the same file states.
function sameResult(last, digests, status) {
  if (last.digests.length !== digests.length || last.files.length !== status.length) return false;
  for (let i = 0; i < digests.length; i++) {
    const a = last.digests[i];
    const b = digests[i];
    if (a.digest !== b.digest || a.path !== b.path || a.compressed !== b.compressed || a.sessionId !== b.sessionId) return false;
  }
  for (let i = 0; i < status.length; i++) {
    const a = last.files[i];
    const b = status[i];
    if (a.path !== b.path || a.state !== b.state || a.provider !== b.provider || a.host !== b.host || a.sessionId !== b.sessionId) return false;
  }
  return true;
}

