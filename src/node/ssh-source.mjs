// Usage source for one SSH host. Runs the user's own `ssh` (key or agent auth only; BatchMode
// never prompts), lists the host's transcripts, and pulls only new marker lines from files that
// changed. Per-file parser state is cached on disk, so later scans move a few KB.
import { spawn as nodeSpawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createClaudeParser, createCodexParser } from '../core/records.mjs';
import { LIST_SCRIPT, createReadParser, parseListing, readScript } from './ssh-script.mjs';

const CACHE_VERSION = 1;
const SAVE_EVERY_MS = 30_000;

export function sshArgs(host) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'Compression=yes',
    '-T',
    '--',
    host,
    'sh -s',
  ];
}

export function createSshSource({
  host,
  // What the panel shows instead of the address; defaults to the host.
  name,
  cacheFile,
  spawn = nodeSpawn,
  command = (h) => ['ssh', sshArgs(h)],
  env = process.env,
  fs = fsp,
  now = () => Date.now(),
  idleTimeoutMs = 60_000,
  // Reading can go quiet while the remote greps a large file; give it longer before giving up.
  readIdleTimeoutMs = 300_000,
  minIntervalMs = 120_000,
} = {}) {
  // A host is an ssh_config alias or [user@]host[:port-less]; no spaces or shell characters, and
  // never an option ('-...'). It is passed as its own argv entry after '--' either way.
  if (typeof host !== 'string' || !/^[A-Za-z0-9_.%+\[\]:-]+(@[A-Za-z0-9_.%+\[\]:-]+)?$/.test(host) || host.startsWith('-')) {
    throw new Error(`invalid SSH host: ${host}`);
  }
  const label = typeof name === 'string' && name.trim() ? name.trim() : host;
  const id = `ssh:${label}`;
  // ssh's own messages can include the address; show the name instead.
  const hide = (msg) => (label === host ? msg : String(msg).split(host).join(label));
  let files = new Map(); // path -> { key, offset, kind, ctx, state, parser }
  let loaded = false;
  let inFlight = null;
  let last = null; // { at, result }
  let status = { id, kind: 'ssh', label, state: 'loading', files: 0, records: 0, lastScanAt: null, ms: 0 };
  let dirty = false;
  let lastSave = 0;
  let saveTimer = null;
  let closed = false;
  let child = null;
  // Ends the running exec at once (used by close, so it never waits for the process to exit).
  let abortExec = null;

  function scan({ force = false } = {}) {
    if (closed) return Promise.resolve({ records: [], status, changed: false });
    if (inFlight) return inFlight;
    if (!force && last && now() - last.at < minIntervalMs) return Promise.resolve(last.result);
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function run() {
    const started = now();
    if (!loaded) {
      loaded = true;
      await loadCache();
    }
    status = { ...status, state: last ? status.state : 'loading' };
    try {
      const listing = parseListing((await exec(LIST_SCRIPT)).stdout);
      if (!listing) throw new Error('the host stopped before listing every transcript');
      const seen = new Set();
      const jobs = [];
      for (const file of listing) {
        seen.add(file.path);
        const entry = files.get(file.path);
        if (entry && entry.key === file.key) continue;
        // Same rule as the local scanner: a grown file is read from its stored offset; anything
        // else (new, shrunk, rewritten) is read from the start with a fresh parser.
        const tail = entry && entry.kind === file.kind && file.size >= entry.offset && entry.key !== null;
        const target = tail ? entry : freshEntry(file);
        if (!tail) files.set(file.path, target);
        target.pendingKey = file.key;
        jobs.push({ path: file.path, kind: file.kind, offset: target.offset, size: file.size });
      }
      let changed = false;
      for (const p of [...files.keys()]) {
        if (!seen.has(p)) {
          files.delete(p);
          changed = true;
        }
      }
      if (jobs.length) {
        changed = true;
        await readFiles(jobs);
      }
      if (changed && !closed) markDirty();
      const records = collect();
      status = { id, kind: 'ssh', label, state: 'ok', files: listing.length, records: records.length, lastScanAt: new Date(now()).toISOString(), ms: now() - started };
      const result = { records, status, changed };
      last = { at: now(), result };
      return result;
    } catch (error) {
      // A file whose read didn't finish may have pushed some lines without advancing its offset.
      // Start it over so nothing is counted twice.
      for (const [p, e] of files) {
        if ('pendingKey' in e) files.set(p, freshEntry({ path: p, kind: e.kind }));
      }
      const records = collect();
      status = {
        id, kind: 'ssh', label, state: 'error', files: files.size, records: records.length,
        lastScanAt: status.lastScanAt, ms: now() - started, message: hide(explain(error)),
      };
      // Keep showing what was pulled before; retry on the next scan instead of waiting out the interval.
      const result = { records, status, changed: false };
      last = null;
      return result;
    }
  }

  async function readFiles(jobs) {
    const parser = createReadParser({
      onLines: (p, text) => files.get(p)?.parser?.push(text),
      onDone: (p, bytes) => {
        const entry = files.get(p);
        if (!entry) return;
        if (bytes < 0) {
          // Shrank, vanished or unreadable since the listing: read it whole on the next scan.
          files.set(p, { ...freshEntry({ path: p, kind: entry.kind }) });
          return;
        }
        entry.offset += bytes;
        entry.key = entry.pendingKey ?? null;
        delete entry.pendingKey;
      },
    });
    const { stdout } = await exec(readScript(jobs), (chunk) => parser.push(chunk), readIdleTimeoutMs);
    if (stdout !== undefined) parser.push(stdout);
    if (!parser.end()) throw new Error('the connection closed before every file was read');
  }

  // Runs one script over ssh. With onChunk, stdout is streamed to it and not kept.
  function exec(script, onChunk, idleMs = idleTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('source closed'));
        return;
      }
      const [cmd, args] = command(host);
      let proc;
      try {
        proc = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        reject(error);
        return;
      }
      child = proc;
      let out = '';
      let err = '';
      let timer = null;
      // Once settled (timeout, parse error, close), later output is ignored: the caller has
      // already reset the files it was reading.
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child === proc) {
          child = null;
          abortExec = null;
        }
        fn(value);
      };
      abortExec = (error) => {
        proc.stdout.destroy();
        proc.stderr.destroy();
        settle(reject, error);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          proc.kill();
          settle(reject, Object.assign(new Error(`no response from ${host} for ${Math.round(idleMs / 1000)} s`), { code: 'ETIMEDOUT' }));
        }, idleMs);
        timer.unref?.();
      };
      arm();
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        if (settled) return;
        arm();
        if (onChunk) {
          try {
            onChunk(chunk);
          } catch (error) {
            proc.kill();
            settle(reject, error);
          }
        } else out += chunk;
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        if (err.length < 8192) err += chunk;
      });
      proc.on('error', (error) => settle(reject, error));
      proc.on('close', (code) => {
        if (closed) settle(reject, new Error('source closed'));
        else if (code === 0) settle(resolve, { stdout: onChunk ? undefined : out });
        else settle(reject, Object.assign(new Error(err.trim().split('\n').pop() || `ssh exited with code ${code}`), { exitCode: code }));
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(script);
    });
  }

  function freshEntry(file) {
    const ctx = { sessionId: path.posix.basename(file.path).replace(/\.jsonl$/i, ''), project: path.posix.basename(path.posix.dirname(file.path)), host: id };
    return { key: null, offset: 0, kind: file.kind, ctx, state: null, parser: makeParser(file.kind, ctx) };
  }

  function makeParser(kind, ctx, state) {
    return kind === 'claude' ? createClaudeParser(ctx, state) : createCodexParser(ctx, state);
  }

  function collect() {
    const out = [];
    for (const entry of files.values()) {
      if (!entry.parser) {
        try {
          entry.parser = makeParser(entry.kind, entry.ctx, entry.state);
          entry.state = null;
        } catch {
          continue;
        }
      }
      for (const r of entry.parser.records()) out.push(r.host === id ? r : { ...r, host: id });
    }
    return out;
  }

  async function loadCache() {
    if (!cacheFile) return;
    try {
      const raw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (raw?.version !== CACHE_VERSION || raw.host !== host || typeof raw.files !== 'object' || raw.files === null) return;
      for (const [p, e] of Object.entries(raw.files)) {
        if (!e || (e.kind !== 'claude' && e.kind !== 'codex') || !Number.isSafeInteger(e.offset) || e.offset < 0 || !e.state || typeof e.state !== 'object') continue;
        files.set(p, { key: typeof e.key === 'string' ? e.key : null, offset: e.offset, kind: e.kind, ctx: { ...e.ctx, host: id }, state: e.state, parser: null });
      }
      if (files.size) status = { ...status, records: 0 };
    } catch {
      // No cache or unreadable: start fresh.
    }
  }

  function markDirty() {
    dirty = true;
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush().catch(() => {});
    }, Math.max(0, lastSave + SAVE_EVERY_MS - now()));
    saveTimer.unref?.();
  }

  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || !cacheFile) return;
    dirty = false;
    lastSave = now();
    const out = {};
    for (const [p, e] of files) {
      // Skip files with a read in progress: their parser may hold lines past the stored offset.
      if (e.key === null || 'pendingKey' in e) continue;
      out[p] = { key: e.key, offset: e.offset, kind: e.kind, ctx: e.ctx, state: e.parser ? e.parser.state() : e.state };
    }
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, host, files: out }));
    await fs.rename(tmp, cacheFile);
  }

  return {
    id,
    kind: 'ssh',
    label,
    scan,
    status: () => status,
    flush,
    // Stops any running ssh, waits for its scan to unwind, then saves once. A closed source never
    // writes its cache again.
    async close() {
      if (closed) return;
      closed = true;
      child?.kill();
      abortExec?.(new Error('source closed'));
      await inFlight?.catch(() => {});
      dirty = true;
      await flush().catch(() => {});
      clearTimeout(saveTimer);
      saveTimer = null;
    },
  };
}

// Turns ssh failures into one line a person can act on.
export function explain(error) {
  const msg = String(error?.message ?? error);
  if (error?.code === 'ENOENT') return 'ssh was not found on this machine. Install OpenSSH or add it to PATH.';
  if (/Permission denied/i.test(msg)) return 'SSH login was refused. Use a key or ssh-agent; passwords are not supported.';
  if (/Could not resolve hostname|Name or service not known/i.test(msg)) return 'Unknown host. Check the name, or add it to ~/.ssh/config.';
  if (/Host key verification failed/i.test(msg)) return 'Host key not trusted yet. Connect once with ssh in a terminal to accept it.';
  if (/Connection (timed out|refused)|ETIMEDOUT|No route to host/i.test(msg)) return `Could not connect: ${msg}`;
  return msg;
}
