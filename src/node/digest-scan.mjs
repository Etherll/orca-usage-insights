// One token digest per transcript for Breakdown, a shard per file under digests-v1/. Runs only when Breakdown asks.
// A shard is <sha1 of path>.json: { v: 3, path, key, offset, compressed, kind, sessionId, ctx, digest }, rows
// packed (digest-rows.mjs). A plain file's adapter and fold state is in <sha1>.state.json { v: 3, path, key,
// state }, used only when its key matches the shard's. v2 shards (one file, rows as arrays) convert on first use.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { decodeDigest, encodeDigest, packDigest } from '../core/breakdown/digest-rows.mjs';
import { createDigestConsumer } from './digest-consumer.mjs';
import { createParsePool } from './parse-pool.mjs';
import { rootSpecs } from './paths.mjs';
import { listTranscripts, readTranscript } from './transcript-files.mjs';

const SHARD_VERSION = 3;
const LEGACY_SHARD_VERSION = 2;
const CONCURRENCY = 8;

// cacheDir: the digests folder, or null to keep everything in memory (tests, previews).
// Consumers adopt their state: each is dropped once read, and no other code reads a state it starts from.
const ADOPT = { adopt: true };

export function createDigestScanner({
  fs = fsp,
  cacheDir = null,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  threads = Math.min(4, Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  sharedPool = null,
} = {}) {
  const files = new Map();
  // Returned again by a scan that finds the same digests and states, so the Breakdown analysis is reused.
  let last = null;
  const targets = new Map(); // key -> [target, ...] (one per label and kind)
  const loaded = new Set();
  const oversized = new Map(); // path -> key of a compressed file that decompressed past the cap
  let pool = sharedPool;
  let run = null;
  let progress = { done: 0, total: 0 };

  return { scan, progress: () => ({ ...progress }), close };

  // since: epoch ms. Files last changed before it are not read (state 'old'). A call joins the running
  // scan when it covers the range and the same extra folders, else runs after it.
  // sessions: ids whose files are read even when last changed before `since` (they have turns after it).
  function scan({ extra = { claude: [], codex: [] }, since = 0, sessions = null } = {}) {
    const folders = JSON.stringify([extra?.claude ?? [], extra?.codex ?? []]);
    if (run && run.since <= since && run.folders === folders) return run.done;
    const before = run?.done.catch(() => {}) ?? null;
    const current = { since, folders, done: null };
    current.done = (before ? before.then(() => runScan(extra, since, sessions)) : runScan(extra, since, sessions)).finally(() => {
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

  async function runScan(extra, since, sessions) {
    if (threads > 0 && !pool && fs === fsp) pool = createParsePool(threads);
    const roots = await rootSpecs({ platform, env, home, readdir: fs.readdir });
    const listing = { errors: 0, failed: [] };
    const { found } = await listTranscripts({ fs, platform, roots, extra, run: listing });
    progress = { done: 0, total: found.length };
    const statuses = new Map();
    let next = 0;
    const lanes = Array.from({ length: Math.min(CONCURRENCY, found.length) }, async () => {
      while (next < found.length) {
        const file = found[next++];
        statuses.set(file.path, await refresh(file, sessions?.has(file.ctx?.sessionId) ? 0 : since).catch(() => 'error'));
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

  async function refresh(listed, since) {
    const file = { ...listed, ctx: { ...listed.ctx, home } };
    const st = await fs.stat(file.path).catch(() => null);
    if (since > 0 && st?.isFile() && st.mtimeMs < since) return 'old';
    let entry = files.get(file.path);
    if (!entry && !loaded.has(file.path)) {
      loaded.add(file.path);
      entry = await loadShard(file);
      if (entry) files.set(file.path, entry);
    }
    // A digest made by the other provider's adapter (a folder reassigned) is never reused.
    const prior = entry && entry.key !== null && entry.kind === file.kind ? { key: entry.key, offset: entry.offset, consumer: null } : null;
    if (prior && st?.isFile() && `${st.mtimeMs}:${st.size}` === prior.key) return 'ok';
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
    if (result.status === 'skipped' && result.reason === 'too-large' && result.key) {
      // Its shard records the skip, so a restart doesn't decompress it up to the cap again.
      if (oversized.get(file.path) !== result.key) await saveSkip(file, result.key);
      oversized.set(file.path, result.key);
    } else oversized.delete(file.path);
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
    await saveShard(file.path, { key: next.key, offset: next.offset, compressed: next.compressed, kind: next.kind, sessionId: next.sessionId, ctx: file.ctx }, digest, file.compressed ? null : state);
    return 'ok';
  }

  // Safe to share: only this scanner holds the digest, and the targets are frozen.
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

  async function loadShard(file) {
    if (!cacheDir) return null;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(shardPath(file.path), 'utf8'));
    } catch {
      return null;
    }
    if (raw?.path !== file.path || raw.kind !== file.kind) return null;
    if (raw.v === SHARD_VERSION && typeof raw.tooLarge === 'string') {
      oversized.set(file.path, raw.tooLarge);
      return null;
    }
    if (!raw.digest) return null;
    const meta = { key: raw.key, offset: raw.offset, compressed: raw.compressed, kind: raw.kind, sessionId: raw.sessionId };
    if (raw.v === LEGACY_SHARD_VERSION) {
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

  async function saveSkip(file, key) {
    if (!cacheDir) return;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.unlink(statePath(file.path)).catch(() => {});
      await writeJson(shardPath(file.path), { v: SHARD_VERSION, path: file.path, kind: file.kind, tooLarge: key });
    } catch {}
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

