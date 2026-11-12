// Composition root: wires the scanners, the SSH sources and buildReport to Orca's panel, status bar,
// settings and workspace hooks. This is the only file that knows Orca and the core together.
// Every hook is best-effort: failures go to orca.log and never take the worker down.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { compact } from './core/format.mjs';
import { buildReport } from './core/report.mjs';
import { createRecordStore } from './core/record-store.mjs';
import { asTable, distinctNames } from './core/table.mjs';
import { analyzeBreakdown } from './core/breakdown/analyze.mjs';
import { buildExplainPrompt } from './core/breakdown/explain.mjs';
import { createDigestScanner } from './node/digest-scan.mjs';
import { zstdAvailable } from './node/zstd.mjs';
import { cacheDir, homeDir, pathFor } from './node/paths.mjs';
import { createPriceBook } from './node/price-book.mjs';
import { createScanner } from './node/scan.mjs';
import { createSshSource } from './node/ssh-source.mjs';

const RANGES = new Set(['7d', '30d', '90d', 'all']);
const SCOPES = new Set(['all', 'worktrees']);
const CACHE_FILE = 'scan-cache-v5.json';
const LEGACY_CACHE_FILE = 'scan-cache-v4.json';
const POLL_MS = 60_000;
// The panel waits this long at most for SSH hosts. A host still running then is reported as loading.
const SSH_WAIT_MS = 1_500;
const WORKSPACE_TTL_MS = 30_000;
const STATUS_ID = 'today';
// Breakdown waits this long for the digest scan, then answers { loading } and posts usage.changed
// when the scan finishes.
const BREAKDOWN_WAIT_MS = 10_000;
// A scan or digest pass this long counts as heavy: a full GC follows SETTLE_MS later.
const HEAVY_MS = 1_000;
const SETTLE_MS = 3_000;
const VIEWS_KEPT = 8;

// activate, replaceWorker and deactivate run one at a time, so a new worker always starts after
// the previous one has stopped.
let running = null;
let queue = Promise.resolve();

export default function activate(orca) {
  const home = homeDir();
  const dir = cacheDir({ home });
  orca.log(`Usage Insights: Node ${process.version}, zstd ${zstdAvailable() ? 'available' : 'unavailable'}, cache ${dir}`);
  return replaceWorker(orca, () => createScanner({ home, cacheFile: join(dir, CACHE_FILE), legacyCacheFile: join(dir, LEGACY_CACHE_FILE) }), {
    home,
    sshCacheDir: dir,
    priceDir: dir,
  });
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
  statusBar = true,
  // After an agent finishes, wait this long (transcripts are written just after) and rescan.
  agentSettleMs = 2_500,
  build = buildReport,
  // The price book holds the catalog that prices the usage. Its files live in priceDir (the cache dir).
  priceDir,
  priceBook = createPriceBook({
    dir: priceDir,
    fetch: globalThis.fetch,
    log: (message) => orca.log(`Usage Insights: ${message}`),
  }),
  // Breakdown digests. Built on first use; shards go under the cache dir.
  makeDigestScanner = () => createDigestScanner({ cacheDir: sshCacheDir ? join(sshCacheDir, 'digests-v1') : null, home, platform, sharedPool: scanner.pool?.() ?? null }),
  breakdownWaitMs = BREAKDOWN_WAIT_MS,
} = {}) {
  const paths = pathFor(platform);
  let cache = { records: null, reports: new Map() };
  let store = null; // local files and SSH files together, once an SSH host has records
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

  let lastExtra = { claude: [], codex: [] };
  let digestScanner = null;
  let digestJob = null;
  let lastDigests = null;
  let digestWaiting = false;
  const views = new Map(); // filter key -> latest BreakdownView, for Explain
  let gcTimer = null;

  // Handler scans are tracked so stop() can wait for them before it flushes the cache.
  function track(run) {
    const job = run().finally(() => inFlight.delete(job));
    inFlight.add(job);
    return job;
  }

  orca.panels.handle('usage.report', (input) => track(async () => answer(parseReportInput(input), { force: false })));

  // Refresh rescans every source now. Each keeps its per-file cache, so only changed files are read.
  orca.panels.handle('usage.refresh', (input) => track(async () => answer(parseReportInput(input), { force: true })));

  // Price book. Sync is not tracked as a whole: it may wait on the network, and stop() must not wait
  // for that. Its own scan is tracked, so stop() still waits for the records it reads.
  orca.panels.handle('usage.breakdown', (input) => track(async () => breakdown(parseBreakdownInput(input))));
  orca.panels.handle('usage.explain', (input) => track(async () => explain(parseExplainInput(input))));

  // Breakdown: the same records and filters as usage.report, split by the per-file digests. The
  // digest scan runs only from here, never from the poll or the agent rescan.
  async function breakdown(options, { waitMs = breakdownWaitMs } = {}) {
    const [gathered, scope, catalog, prices] = await Promise.all([
      gather({ force: false, detach: false }),
      scopeFor(options.scope),
      priceBook.catalog(),
      priceBook.status(),
    ]);
    const scan = await digestsWithin(waitMs, sinceFor(options.range));
    if (!scan) return { loading: digestScanner.progress() };
    const view = analyzeBreakdown({
      records: gathered.records,
      digests: scan.digests,
      files: scan.files,
      catalog,
      range: options.range,
      now: now(),
      providers: options.providers,
      hosts: options.hosts,
      scope: scope.scope,
      path: options.path,
      prices: { version: prices.version, asOf: prices.asOf, overlay: Boolean(prices.overlay) },
    });
    const key = viewKey(options);
    views.delete(key);
    views.set(key, view);
    if (views.size > VIEWS_KEPT) views.delete(views.keys().next().value);
    return scope.scopeError ? { ...view, scopeError: scope.scopeError } : view;
  }

  // The finding is looked up in the view for the same filters; it is rebuilt when there is none.
  async function explain(options) {
    const catalog = await priceBook.catalog();
    let view = views.get(viewKey(options));
    if (!view || view.prices?.version !== catalog.version) view = await breakdown(options, { waitMs: 600_000 });
    const finding = view?.findings?.find((f) => f.id === options.findingId);
    if (!finding) throw invalidParams('unknown findingId');
    return { ...buildExplainPrompt(finding, { harnessLabel: finding.harness === 'codex' ? 'Codex' : 'Claude Code', platform }), estUsd: null };
  }

  // The earliest file change a range needs: its first local day, with a day of margin for
  // time zones and clock skew. 0 for 'all'.
  function sinceFor(range) {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
    return days ? now().getTime() - (days + 1) * 86_400_000 : 0;
  }

  function viewKey(options) {
    return JSON.stringify([options.range, options.providers ?? null, options.hosts ?? null, options.scope ?? null]);
  }

  // Starts a digest scan (or joins the running one) and waits up to waitMs. null means still
  // running: the caller answers { loading }, and usage.changed is posted when it finishes.
  function digestsWithin(waitMs, since = 0) {
    digestScanner ??= makeDigestScanner();
    // A running scan answers this call only when it covers the range and the same extra folders.
    const folders = JSON.stringify([lastExtra.claude ?? [], lastExtra.codex ?? []]);
    if (!digestJob || digestJob.since > since || digestJob.folders !== folders) {
      const job = digestScanner
        .scan({ extra: lastExtra, since })
        .then(
          (result) => (lastDigests = result),
          (error) => {
            orca.log(`Usage Insights: breakdown scan failed: ${shortMessage(error)}`);
            return lastDigests ?? { digests: [], files: [] };
          },
        )
        .finally(() => {
          if (digestJob === job) digestJob = null;
          if (digestWaiting) {
            digestWaiting = false;
            notify('usage.changed', { generatedAt: now().toISOString() });
          }
        });
      const started = Date.now();
      job.then(() => {
        if (Date.now() - started >= HEAVY_MS) settleSoon();
      });
      job.since = since;
      job.folders = folders;
      digestJob = job;
    }
    const job = digestJob;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        digestWaiting = true;
        resolve(null);
      }, waitMs);
      timer.unref?.();
      job.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  orca.panels.handle('prices.status', () => track(async () => priceBook.status()));
  orca.panels.handle('prices.sync', () => syncPrices());
  orca.panels.handle('prices.apply', (input) => track(async () => {
    const { diffId, keys } = parsePricesInput(input);
    return changePrices(() => priceBook.apply(diffId, keys));
  }));
  orca.panels.handle('prices.undo', () => track(async () => changePrices(() => priceBook.undo())));
  orca.panels.handle('prices.reset', () => track(async () => changePrices(() => priceBook.reset())));

  // Fetches both price files and diffs them against the catalog in use. `impact` is the 30-day cost
  // now and with the rows that start pre-ticked applied, so the panel can say what a sync would change.
  async function syncPrices() {
    const gathered = await track(() => gather({ force: false, detach: false }));
    const inUse = distinctNames(gathered.records, 'model');
    const result = await priceBook.sync(inUse);
    const preTicked = result.rows.filter((row) => row.ticked).map((row) => row.key);
    const before = await priceBook.catalog();
    const after = await priceBook.preview(result.diffId, preTicked);
    const beforeUsd = build(gathered.records, { range: '30d', now: now(), catalog: before }).totals.costUsd;
    const afterUsd = build(gathered.records, { range: '30d', now: now(), catalog: after }).totals.costUsd;
    return { ...result, impact: { beforeUsd, afterUsd } };
  }

  // A change to the overlay: the panel is told usage may differ, and the status bar is redrawn with the new prices.
  async function changePrices(change) {
    const result = await change();
    notify('usage.changed', { generatedAt: now().toISOString() });
    await poll();
    return result;
  }

  // One panel request: settings and every source first, then the report for the request's options.
  async function answer(options, { force }) {
    const [gathered, scope, catalog] = await Promise.all([
      gather({ force, detach: false }),
      scopeFor(options.scope),
      priceBook.catalog(),
    ]);
    const report = reportFor(gathered.records, {
      range: options.range,
      providers: options.providers,
      hosts: options.hosts,
      scope: scope.scope,
      catalog,
    });
    // Sources are attached per request, not cached with the report, because their state changes.
    return { ...report, sources: gathered.statuses, ...(scope.scopeError ? { scopeError: scope.scopeError } : {}) };
  }

  // Reports are kept per request shape for as long as the records they came from are current. The
  // merged records array is reused while its inputs are, so an unchanged request is a cache hit.
  function reportFor(records, { range, providers, hosts, scope, catalog }) {
    if (cache.records !== records) cache = { records, reports: new Map() };
    const key = JSON.stringify([range, providers ?? null, hosts ?? null, scope ?? null, catalog.version]);
    let report = cache.reports.get(key);
    if (!report) {
      const options = { range, now: now(), catalog };
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
        const cacheFile = sshCacheDir ? join(sshCacheDir, `ssh-v3-${host.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-${hash}.json`) : undefined;
        sources.set(key, { name, source: makeSshSource({ host, name, cacheFile }), records: [], files: [], run: null });
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
          entry.files = filesOf(result);
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
  async function gather({ force, detach, forceLocal = force }) {
    const config = await readConfig();
    lastExtra = { claude: config.claude, codex: config.codex };
    scanner.setExtraRoots(lastExtra);
    reconcile(config.hosts);
    const hosts = [...sources];
    const runs = hosts.map(([host, entry]) => startSsh(host, entry, { force, detached: detach }));
    const sshWait = detach ? Promise.resolve() : waitUpTo(runs.map((run) => run.done), sshWaitMs);
    let local;
    try {
      local = await scanLocal(forceLocal);
      await sshWait;
    } finally {
      for (const run of runs) if (!run.finished) run.detached = true;
    }
    return {
      records: mergedRecords(local, hosts),
      statuses: [...local.statuses, ...hosts.map(([, entry]) => entry.source.status())],
      localChanged: local.changed,
    };
  }

  // The local scan, with the status entries for This machine and for each extra folder.
  async function scanLocal(force) {
    const started = now();
    const result = await scanner.scan({ force });
    const finished = now();
    if (finished - started >= HEAVY_MS) settleSoon();
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
    const notes = [];
    if (result.errors > 0) {
      notes.push(`${result.errors === 1 ? '1 transcript file' : `${result.errors} transcript files`} could not be read`);
    }
    const zstd = result.skipped?.zstd ?? 0;
    const tooLarge = result.skipped?.tooLarge ?? 0;
    if (zstd > 0) notes.push(`${zstd} compressed Codex ${zstd === 1 ? 'file' : 'files'} skipped: zstd unavailable`);
    if (tooLarge > 0) notes.push(`${tooLarge} compressed Codex ${tooLarge === 1 ? 'file' : 'files'} skipped: too large`);
    if (notes.length > 0) Object.assign(local, { state: 'warning', message: notes.join('; ') });
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
    return { records: result.records, files: filesOf(result), names: result.names, changed: result.changed === true, statuses: [local, ...folders] };
  }

  // The scanner's table is merged already, so with no SSH records it is the answer as is. Otherwise
  // every local and SSH file goes to one store, which merges only what changed (and returns the same
  // table when nothing did, so repeat requests keep their Report).
  function mergedRecords(local, hosts) {
    if (!hosts.some(([, entry]) => entry.records.length > 0)) return asTable(local.records);
    // On the scanner's dictionary, so local files are copied in bulk.
    if (!store || (local.names && store.names !== local.names)) store = createRecordStore(local.names ? { names: local.names } : {});
    const list = [...local.files];
    for (const [host, entry] of hosts) for (const { id, table } of entry.files) list.push({ id: `${host}\u0000${id}`, table });
    return store.update(list);
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

  async function poll({ forceLocal = false } = {}) {
    try {
      const gathered = await gather({ force: false, detach: true, forceLocal });
      if (gathered.localChanged) notify('usage.changed', { generatedAt: now().toISOString() });
      if (!statusBar) return;
      const report = reportFor(gathered.records, { range: '7d', catalog: await priceBook.catalog() });
      await orca.host.call('statusBar.update', { id: STATUS_ID, ...statusText(report) });
    } catch (error) {
      orca.log(`Usage Insights: ${error?.message ?? error}`);
    }
  }

  // An agent finishing a turn has just written to its transcript, so rescan this machine a moment
  // later. Bursts (several agents, or done followed by working) collapse into one rescan.
  let agentTimer = null;
  let agentRun = null;
  let agentAgain = false;
  function onAgentStatus(event) {
    const done = event?.state === 'done' || event?.mainAgent?.state === 'done';
    if (!done || stopped) return;
    clearTimeout(agentTimer);
    agentTimer = setTimeout(runAgentRescan, agentSettleMs);
    agentTimer.unref?.();
  }
  async function runAgentRescan() {
    agentTimer = null;
    if (stopped) return;
    if (agentRun) {
      agentAgain = true;
      return;
    }
    agentRun = poll({ forceLocal: true });
    await agentRun;
    agentRun = null;
    if (agentAgain && !stopped) {
      agentAgain = false;
      runAgentRescan();
    }
  }
  let agentSubscription = null;
  try {
    agentSubscription = orca.events?.on?.('agent.status.changed', onAgentStatus) ?? null;
  } catch (error) {
    orca.log(`Usage Insights: agent events unavailable: ${error?.message ?? error}`);
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

  // A scan that read many files leaves hundreds of MB of garbage, and an idle worker never
  // collects it. One full collection a few seconds later hands it back to the OS.
  function settleSoon() {
    if (stopped || gcTimer) return;
    gcTimer = setTimeout(() => {
      gcTimer = null;
      fullGc()?.();
    }, SETTLE_MS);
    gcTimer.unref?.();
  }

  return {
    ready: tick(),
    // Never rejects. Waits for the running poll and handler scans, flushes the local cache, then
    // closes the SSH sources (each flushes its own cache). A failed flush is logged.
    async stop() {
      stopped = true;
      clearTimeout(agentTimer);
      clearTimeout(gcTimer);
      agentSubscription?.dispose?.();
      await agentRun;
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
      // The digest scanner may share the records scanner's threads, so it finishes first.
      await digestJob;
      await Promise.resolve(digestScanner?.close?.()).catch(() => {});
      await Promise.resolve(scanner.close?.()).catch(() => {});
    },
  };
}

// The runtime's full collection, or null. Node exposes it only behind --expose-gc; setting the flag
// at runtime makes a new context carry it.
let gcFn;
function fullGc() {
  if (gcFn !== undefined) return gcFn;
  gcFn = null;
  try {
    if (typeof globalThis.gc === 'function') gcFn = globalThis.gc;
    else {
      v8.setFlagsFromString('--expose-gc');
      const gc = vm.runInNewContext('gc');
      v8.setFlagsFromString('--no-expose-gc');
      if (typeof gc === 'function') gcFn = gc;
    }
  } catch {
    gcFn = null;
  }
  return gcFn;
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

// Input from the panel for prices.apply: { diffId, keys }, where keys are row keys of that diff.
function parsePricesInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidParams('prices.apply input must be an object');
  }
  if (typeof input.diffId !== 'string' || input.diffId === '') throw invalidParams('diffId must be a non-empty string');
  if (!Array.isArray(input.keys) || !input.keys.every((key) => typeof key === 'string')) {
    throw invalidParams('keys must be an array of strings');
  }
  return { diffId: input.diffId, keys: input.keys };
}

// Breakdown input: the report filters plus `path` (at most 8 keys of at most 500 chars).
function parseBreakdownInput(input) {
  const { path, ...rest } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = parseReportInput(input === undefined ? undefined : rest);
  if (path === undefined) return { ...out, path: [] };
  if (!Array.isArray(path) || path.length > 8 || !path.every((key) => typeof key === 'string' && key.length <= 500)) {
    throw invalidParams('path must be an array of at most 8 strings of at most 500 characters');
  }
  return { ...out, path };
}

// Explain input: the report filters plus `findingId`.
function parseExplainInput(input) {
  const { findingId, ...rest } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (typeof findingId !== 'string' || findingId === '' || findingId.length > 200) throw invalidParams('findingId must be a non-empty string');
  return { ...parseReportInput(rest), findingId };
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

// Status bar text and tooltip from a 7-day report: today's tokens, cost and cache hit rate.
export function statusText(report) {
  const today = report?.today ?? { total: 0, costUsd: 0 };
  const last = report?.daily?.[report.daily.length - 1];
  const read = last?.cacheRead ?? 0;
  const denom = read + (last?.input ?? 0) + (last?.cacheWrite ?? 0);
  const hit = denom > 0 ? `${Math.min(99.9, Math.round((read / denom) * 1000) / 10).toFixed(1)}% cache hits` : 'no cache use yet';
  return {
    text: `${compact(today.total)} today`,
    tooltip: `Today: ${compact(today.total)} tokens · $${(today.costUsd ?? 0).toFixed(2)} est. · ${hit}. Click to show or hide the sidebar.`,
  };
}

// A scan result's per-file tables. Scanners return them; a stand-in that returns only records
// counts as one file.
function filesOf(result) {
  return result.sources ?? [{ id: '', table: asTable(result.records) }];
}
