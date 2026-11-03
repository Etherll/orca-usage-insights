// Composition root: wires the scanners, the SSH sources and buildReport to Orca's panel, status bar,
// settings and workspace hooks. This is the only file that knows Orca and the core together.
// Every hook is best-effort: failures go to orca.log and never take the worker down.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { compact } from './core/format.mjs';
import { mergeRecords } from './core/merge.mjs';
import { buildReport } from './core/report.mjs';
import { cacheDir, homeDir, pathFor } from './node/paths.mjs';
import { createScanner } from './node/scan.mjs';
import { createSshSource } from './node/ssh-source.mjs';

const RANGES = new Set(['7d', '30d', '90d', 'all']);
const SCOPES = new Set(['all', 'worktrees']);
const CACHE_FILE = 'scan-cache-v1.json';
const POLL_MS = 60_000;
// The panel waits this long at most for SSH hosts. A host still running then is reported as loading.
const SSH_WAIT_MS = 1_500;
const WORKSPACE_TTL_MS = 30_000;
const STATUS_ID = 'today';

// activate, replaceWorker and deactivate run one at a time, so a new worker always starts after
// the previous one has stopped.
let running = null;
let queue = Promise.resolve();

export default function activate(orca) {
  const home = homeDir();
  const dir = cacheDir({ home });
  return replaceWorker(orca, () => createScanner({ home, cacheFile: join(dir, CACHE_FILE) }), { home, sshCacheDir: dir });
}

// Stops the running worker, then starts one over makeScanner(options). Exported for tests.
export function replaceWorker(orca, makeScanner, options = {}) {
  return enqueue(async () => {
    await stopRunning();
    running = startWorker(orca, makeScanner(), options);
  });
}

export function deactivate() {
  return enqueue(stopRunning);
}

function enqueue(job) {
  const next = queue.then(job);
  queue = next.catch(() => {});
  return next;
}

async function stopRunning() {
  const worker = running;
  running = null;
  await worker?.stop();
}

// Registers the panel handlers and starts the status bar poll. `ready` settles after the first
// poll. It never rejects, because poll errors go to orca.log.
export function startWorker(orca, scanner, {
  now = () => new Date(),
  pollMs = POLL_MS,
  home = homeDir(),
  platform = process.platform,
  sshCacheDir,
  makeSshSource = createSshSource,
  sshWaitMs = SSH_WAIT_MS,
  // The status bar item needs Orca 1.4.248, which isn't released yet, so 1.0 ships without it.
  // The status-bar branch turns it back on.
  statusBar = false,
  build = buildReport,
} = {}) {
  const paths = pathFor(platform);
  let cache = { records: null, reports: new Map() };
  let merged = { local: null, lists: [], records: [] };
  let workspaces = null; // { at, roots } from workspace.list
  let settingsFailing = false;
  let lastSettings = {};
  const warned = new Set();
  const sources = new Map(); // host -> { source, records, run }
  const closing = new Set();
  let stopped = false;
  let timer = null;
  let pending = null;
  const inFlight = new Set();

  // Handler scans are tracked so stop() can wait for them before it flushes the cache.
  function track(run) {
    const job = run().finally(() => inFlight.delete(job));
    inFlight.add(job);
    return job;
  }

  orca.panels.handle('usage.report', (input) => track(async () => answer(parseReportInput(input), { force: false })));

  // Refresh rescans every source now. Each keeps its per-file cache, so only changed files are read.
  orca.panels.handle('usage.refresh', (input) => track(async () => answer(parseReportInput(input), { force: true })));

  // One panel request: settings and every source first, then the report for the request's options.
  async function answer(options, { force }) {
    const [gathered, scope] = await Promise.all([gather({ force, detach: false }), scopeFor(options.scope)]);
    const report = reportFor(gathered.records, {
      range: options.range,
      providers: options.providers,
      hosts: options.hosts,
      scope: scope.scope,
    });
    // Sources are attached per request, not cached with the report, because their state changes.
    return { ...report, sources: gathered.statuses, ...(scope.scopeError ? { scopeError: scope.scopeError } : {}) };
  }

  // Reports are kept per request shape for as long as the records they came from are current. The
  // merged records array is reused while its inputs are, so an unchanged request is a cache hit.
  function reportFor(records, { range, providers, hosts, scope }) {
    if (cache.records !== records) cache = { records, reports: new Map() };
    const key = JSON.stringify([range, providers ?? null, hosts ?? null, scope ?? null]);
    let report = cache.reports.get(key);
    if (!report) {
      const options = { range, now: now() };
      if (providers !== undefined) options.providers = providers;
      if (hosts !== undefined) options.hosts = hosts;
      if (scope !== undefined) options.scope = scope;
      report = build(records, options);
      cache.reports.set(key, report);
    }
    return report;
  }

  // 'worktrees' keeps the records whose cwd is under a worktree Orca lists. When that list can't be
  // read, the report is built unscoped and says why.
  async function scopeFor(scope) {
    if (scope !== 'worktrees') return {};
    try {
      return { scope: { roots: await worktreeRoots(), caseInsensitive: platform === 'win32' } };
    } catch (error) {
      return { scopeError: `Worktree scope unavailable: ${shortMessage(error)}` };
    }
  }

  async function worktreeRoots() {
    const at = now().getTime();
    if (workspaces && at - workspaces.at < WORKSPACE_TTL_MS) return workspaces.roots;
    const roots = worktreeRootsOf(await orca.host.call('workspace.list'));
    workspaces = { at, roots };
    return roots;
  }

  // Reads the settings. A failed read logs once and keeps the last settings that were read, so a
  // transient failure doesn't close every SSH host and drop extra folders.
  async function readConfig() {
    let settings = lastSettings;
    try {
      settings = (await orca.host.call('settings.get'))?.settings ?? {};
      lastSettings = settings;
      settingsFailing = false;
    } catch (error) {
      if (!settingsFailing) orca.log(`Usage Insights: could not read settings, keeping the last ones: ${shortMessage(error)}`);
      settingsFailing = true;
    }
    return {
      claude: folderList(settings?.extraClaudeFolders, 'Extra Claude Code folder'),
      codex: folderList(settings?.extraCodexFolders, 'Extra Codex folder'),
      hosts: sshEntries(settingLines(settings?.sshHosts)),
    };
  }

  // '~' expands to home. Only absolute paths are kept, because the scanner reads them as given.
  function folderList(lines, label) {
    const out = [];
    for (const line of settingLines(lines)) {
      const folder = expandHome(line, { platform, home });
      if (!paths.isAbsolute(folder)) {
        warnOnce(`${label} "${line}" is not an absolute path, so it is skipped`);
        continue;
      }
      out.push(folder);
    }
    return [...new Set(out)];
  }

  // An SSH line is `host` or `name = host`. The name is what the panel shows (so a long or private
  // address never appears); it defaults to the host. Names must be unique.
  function sshEntries(lines) {
    const out = [];
    const names = new Set();
    for (const line of lines) {
      const m = /^(.+?)\s*=\s*(\S+)$/.exec(line);
      const host = m ? m[2] : line;
      const name = m ? m[1].trim() : line;
      if (names.has(name)) {
        warnOnce(`SSH name "${name}" is used twice; only the first line is kept`);
        continue;
      }
      names.add(name);
      out.push({ name, host, key: `${name}=${host}` });
    }
    return out;
  }

  // A bad settings line is logged once, not on every scan.
  function warnOnce(message) {
    if (warned.has(message)) return;
    warned.add(message);
    orca.log(`Usage Insights: ${message}`);
  }

  // One SSH source per listed host. A new host gets a source with its own cache file. A removed host
  // is closed and drops out of the report.
  function reconcile(hosts) {
    const wanted = new Set(hosts.map((h) => h.key));
    for (const [key, entry] of [...sources]) {
      if (wanted.has(key)) continue;
      sources.delete(key);
      closeSource(entry.name, entry.source);
    }
    for (const { name, host, key } of hosts) {
      if (sources.has(key)) continue;
      try {
        // Readable prefix plus a hash, so 'a@b' and 'a_b' never share a cache file.
        const hash = createHash('sha256').update(host).digest('hex').slice(0, 10);
        const cacheFile = sshCacheDir ? join(sshCacheDir, `ssh-${host.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-${hash}.json`) : undefined;
        sources.set(key, { name, source: makeSshSource({ host, name, cacheFile }), records: [], run: null });
      } catch (error) {
        warnOnce(`SSH host "${name}" was skipped: ${shortMessage(error)}`);
      }
    }
  }

  function closeSource(host, source) {
    const job = Promise.resolve()
      .then(() => source.close())
      .catch((error) => orca.log(`Usage Insights: closing ${host} failed: ${shortMessage(error)}`))
      .finally(() => closing.delete(job));
    closing.add(job);
    return job;
  }

  // Starts a scan of one SSH source, or joins the one already running. A run its caller stopped
  // waiting for is detached: if it finishes with new data, it posts usage.changed.
  function startSsh(host, entry, { force, detached }) {
    if (entry.run) {
      if (detached) entry.run.detached = true;
      return entry.run;
    }
    const run = { detached, finished: false, done: null };
    run.done = Promise.resolve()
      .then(() => entry.source.scan({ force }))
      .then(
        (result) => {
          // A reused result keeps its records array, so only a new array counts as new data.
          const fresh = result.records !== entry.records;
          entry.records = result.records;
          return fresh && result.changed === true;
        },
        (error) => {
          orca.log(`Usage Insights: ${host}: ${shortMessage(error)}`);
          return false;
        },
      )
      .then((changed) => {
        run.finished = true;
        if (entry.run === run) entry.run = null;
        // A detached run was reported to the panel as still loading, so its result (new data, no
        // change, or an error) is always worth a redraw.
        if (run.detached) notify('usage.changed', { generatedAt: now().toISOString() });
      });
    entry.run = run;
    return run;
  }

  // Reads the settings, syncs the folders and hosts, and scans every source. The local scan is
  // awaited. SSH hosts get at most sshWaitMs; a host still running then is reported as loading. The
  // status bar poll (detach) never waits for SSH.
  async function gather({ force, detach }) {
    const config = await readConfig();
    scanner.setExtraRoots({ claude: config.claude, codex: config.codex });
    reconcile(config.hosts);
    const hosts = [...sources];
    const runs = hosts.map(([host, entry]) => startSsh(host, entry, { force, detached: detach }));
    const sshWait = detach ? Promise.resolve() : waitUpTo(runs.map((run) => run.done), sshWaitMs);
    let local;
    try {
      local = await scanLocal(force);
      await sshWait;
    } finally {
      for (const run of runs) if (!run.finished) run.detached = true;
    }
    return {
      records: mergedRecords(local.records, hosts.map(([, entry]) => entry.records)),
      statuses: [...local.statuses, ...hosts.map(([, entry]) => entry.source.status())],
      localChanged: local.changed,
    };
  }

  // The local scan, with the status entries for This machine and for each extra folder.
  async function scanLocal(force) {
    const started = now();
    const result = await scanner.scan({ force });
    const finished = now();
    const stamp = { lastScanAt: finished.toISOString(), ms: finished - started };
    const local = {
      id: 'local',
      kind: 'local',
      label: 'This machine',
      state: 'ok',
      files: result.files,
      records: result.records.length,
      ...stamp,
    };
    if (result.errors > 0) {
      const count = result.errors === 1 ? '1 transcript file' : `${result.errors} transcript files`;
      Object.assign(local, { state: 'warning', message: `${count} could not be read` });
    }
    const folders = (result.folders ?? []).map((folder) => ({
      id: `folder:${folder.path}`,
      kind: 'folder',
      label: folder.path,
      state: folder.state,
      files: folder.files,
      records: folder.records,
      ...stamp,
      ...(folder.message ? { message: folder.message } : {}),
    }));
    return { records: result.records, changed: result.changed === true, statuses: [local, ...folders] };
  }

  // The merged list is reused while its inputs are the same arrays, so repeat requests keep their Report.
  function mergedRecords(local, lists) {
    const same =
      merged.local === local && merged.lists.length === lists.length && lists.every((list, i) => list === merged.lists[i]);
    if (!same) merged = { local, lists, records: mergeRecords([local, ...lists]) };
    return merged.records;
  }

  // A failing panel post is logged and never blocks the status bar update that follows it.
  function notify(name, payload) {
    try {
      const sent = orca.panels.post(name, payload);
      if (typeof sent?.catch === 'function') {
        sent.catch((error) => orca.log(`Usage Insights: post ${name} failed: ${error?.message ?? error}`));
      }
    } catch (error) {
      orca.log(`Usage Insights: post ${name} failed: ${error?.message ?? error}`);
    }
  }

  async function poll() {
    try {
      const gathered = await gather({ force: false, detach: true });
      if (gathered.localChanged) notify('usage.changed', { generatedAt: now().toISOString() });
      if (!statusBar) return;
      const { today } = reportFor(gathered.records, { range: '7d' });
      await orca.host.call('statusBar.update', {
        id: STATUS_ID,
        text: `${compact(today.total)} today`,
        tooltip: 'Tokens today · $' + (today.costUsd ?? 0).toFixed(2),
      });
    } catch (error) {
      orca.log(`Usage Insights: ${error?.message ?? error}`);
    }
  }

  // The next poll is scheduled only after this one settles, so polls never overlap each other.
  async function tick() {
    pending = poll();
    await pending;
    pending = null;
    if (!stopped) {
      timer = setTimeout(tick, pollMs);
      timer.unref?.();
    }
  }

  return {
    ready: tick(),
    // Never rejects. Waits for the running poll and handler scans, flushes the local cache, then
    // closes the SSH sources (each flushes its own cache). A failed flush is logged.
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      while (pending || inFlight.size > 0) {
        await Promise.allSettled([pending, ...inFlight]);
      }
      try {
        await scanner.flush();
      } catch (error) {
        orca.log(`Usage Insights: cache flush failed: ${error?.message ?? error}`);
      }
      for (const [host, entry] of [...sources]) closeSource(host, entry.source);
      sources.clear();
      await Promise.allSettled([...closing]);
      await Promise.resolve(scanner.close?.()).catch(() => {});
    },
  };
}

// Resolves when every promise has settled, or after ms, whichever comes first.
function waitUpTo(promises, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.all(promises).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Paths of the worktrees in a workspace.list reply, which is { workspaces: [{ kind, path, ... }] }.
function worktreeRootsOf(reply) {
  if (!Array.isArray(reply?.workspaces)) throw new Error('unexpected workspace.list reply');
  return reply.workspaces
    // A root of '/' (or a bare drive) would match every session, so only real folders count.
    .filter((workspace) => workspace?.kind === 'worktree' && typeof workspace.path === 'string' && workspace.path.replace(/[\\/]+$/, '').replace(/^[A-Za-z]:$/, '') !== '')
    .map((workspace) => workspace.path);
}

// Expands a leading '~' (alone, or before a separator) to the home dir. Other values pass through.
function expandHome(value, { platform, home }) {
  const paths = pathFor(platform);
  const tilde = value === '~' || value.startsWith(`~${paths.sep}`) || (platform === 'win32' && value.startsWith('~/'));
  return tilde ? paths.join(home, value.slice(1)) : value;
}

// Non-blank, non-comment lines of a multiline setting, trimmed.
function settingLines(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

// Input from the panel: { range?, providers?, scope?, hosts? }. Anything else is rejected with code invalid_params.
function parseReportInput(input) {
  const body = input === undefined ? {} : input;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidParams('usage.report input must be an object');
  }
  const range = body.range === undefined ? '7d' : body.range;
  if (!RANGES.has(range)) throw invalidParams('range must be one of 7d, 30d, 90d, all');
  const scope = body.scope === undefined ? 'all' : body.scope;
  if (!SCOPES.has(scope)) throw invalidParams('scope must be one of all, worktrees');
  const out = { range, scope };
  if (body.providers !== undefined) {
    if (!Array.isArray(body.providers) || !body.providers.every((p) => typeof p === 'string')) {
      throw invalidParams('providers must be an array of strings');
    }
    out.providers = body.providers;
  }
  if (body.hosts !== undefined) {
    if (!Array.isArray(body.hosts) || !body.hosts.every((host) => typeof host === 'string' && host !== '')) {
      throw invalidParams('hosts must be an array of non-empty strings');
    }
    out.hosts = body.hosts;
  }
  return out;
}

function invalidParams(message) {
  const error = new Error(message);
  error.code = 'invalid_params';
  return error;
}

// First line of an error, cut so it fits a status line or a report note.
function shortMessage(error) {
  const text = String(error?.message ?? error ?? '').split('\n')[0].trim() || 'unknown error';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export { compact };
