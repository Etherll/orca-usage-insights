import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import activate, { compact, deactivate, startWorker } from '../src/worker.mjs';
import { buildReport } from '../src/core/report.mjs';
import { cacheDir } from '../src/node/paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const NOON = () => new Date(2026, 10, 3, 12, 0, 0); // local noon, 2026-11-03
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Records are built from local parts so they land on today in any TZ.
const usageRecord = (over = {}) => ({
  provider: 'claude',
  ts: new Date(2026, 10, 3, 9, 0, 0).toISOString(),
  model: 'claude-sonnet-4-5',
  project: 'pyrosome',
  sessionId: 's1',
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  cwd: '',
  host: 'local',
  ...over,
});

const result = (records, changed = false, extra = {}) => ({ records, files: 1, errors: 0, changed, ...extra });

// Orca host stand-in. settings.get answers from mock.settings; workspace.list from workspaces().
function mockOrca({ settings = {}, workspaces = () => ({ workspaces: [] }) } = {}) {
  const mock = { handlers: new Map(), posts: [], hostCalls: [], logs: [], settings, failSettings: false };
  mock.orca = {
    panels: {
      handle: (name, fn) => mock.handlers.set(name, fn),
      post: (name, payload) => mock.posts.push([name, payload]),
    },
    host: {
      call: async (method, args) => {
        mock.hostCalls.push([method, args]);
        if (method === 'settings.get') {
          if (mock.failSettings) throw new Error('settings offline');
          return { settings: mock.settings };
        }
        if (method === 'workspace.list') return workspaces();
      },
    },
    log: (message) => mock.logs.push(message),
  };
  mock.statusUpdates = () => mock.hostCalls.filter(([method]) => method === 'statusBar.update').map(([, args]) => args);
  mock.callsTo = (name) => mock.hostCalls.filter(([method]) => method === name);
  mock.changedPosts = () => mock.posts.filter(([name]) => name === 'usage.changed').length;
  return mock;
}

// Stands in for createScanner. `scan(n)` gets the 1-based call number and returns a scan result.
function fakeScanner(scan = () => result([])) {
  const calls = { scan: 0, reset: 0, flush: 0, roots: [], order: [] };
  return {
    calls,
    async scan(opts) {
      calls.scan++;
      calls.order.push(opts?.force ? 'scan:force' : 'scan');
      return scan(calls.scan);
    },
    setExtraRoots(roots) {
      calls.roots.push(roots);
    },
    reset() {
      calls.reset++;
      calls.order.push('reset');
    },
    async flush() {
      calls.flush++;
      calls.order.push('flush');
    },
  };
}

// Stands in for createSshSource. Each host keeps its scans (forced flags), closes and cache file.
// hold(host, gate) makes the host's next run wait for gate. setRecords(host, list) sets what its
// runs return. Like the real source, a scan without force returns the last result.
function fakeSsh({ onClose = () => {} } = {}) {
  const info = new Map();
  const gates = new Map();
  const records = new Map();
  const entry = (host) => {
    if (!info.has(host)) info.set(host, { scans: [], closes: 0, state: 'loading', last: null, cacheFile: undefined });
    return info.get(host);
  };
  const make = ({ host, name, cacheFile }) => {
    if (name !== undefined) entry(host).name = name;
    const rec = entry(host);
    rec.cacheFile = cacheFile;
    const status = () => ({
      id: `ssh:${host}`,
      kind: 'ssh',
      label: host,
      state: rec.state,
      files: 1,
      records: rec.last ? rec.last.records.length : 0,
      lastScanAt: null,
      ms: 0,
    });
    return {
      id: `ssh:${host}`,
      kind: 'ssh',
      label: host,
      scan({ force = false } = {}) {
        rec.scans.push(force);
        if (!force && rec.last) return Promise.resolve(rec.last);
        const gate = gates.get(host);
        gates.delete(host);
        const finish = () => {
          rec.state = 'ok';
          rec.last = { records: (records.get(host) ?? []).slice(), status: status(), changed: true };
          return rec.last;
        };
        return gate ? gate.then(finish) : Promise.resolve(finish());
      },
      status,
      flush: async () => {},
      close: async () => {
        rec.closes++;
        onClose(host);
      },
    };
  };
  return {
    make,
    info,
    hold: (host, gate) => gates.set(host, gate),
    setRecords: (host, list) => records.set(host, list),
  };
}

// Wraps the real buildReport and remembers the options of every build.
function recordingBuild() {
  const options = [];
  const build = (records, opts) => {
    options.push(opts);
    return buildReport(records, opts);
  };
  return { build, options };
}

async function waitFor(check, ms = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for condition');
    await sleep(2);
  }
}

test('manifest is the trusted worker with exactly the declared keys', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'orca-plugin.json'), 'utf8'));
  const allowedTop = ['manifestVersion', 'id', 'name', 'version', 'execution', 'description', 'author', 'license', 'repository', 'icon', 'cover', 'screenshots', 'engines', 'pluginApi', 'main', 'contributes', 'capabilities']
  assert.deepEqual(Object.keys(manifest).filter((k) => !allowedTop.includes(k)), [], 'no unknown top-level keys')
  assert.equal(manifest.manifestVersion, 2)
  assert.equal(manifest.id, 'usage-insights')
  assert.equal(manifest.publisher, undefined, 'publisher is derived from the repo owner')
  assert.equal(manifest.execution, 'trusted-worker')
  assert.equal(manifest.main, 'src/worker.mjs')
  assert.equal(manifest.pluginApi, 1)
  assert.deepEqual(manifest.engines, { orca: '>=1.4.248' })
  assert.deepEqual(Object.keys(manifest.contributes).sort(), ['panels', 'settings', 'statusBarItems'])
  assert.deepEqual(manifest.contributes.panels, [{ id: 'insights', title: 'Usage Insights', icon: 'bar-chart-3', entry: 'panel/index.html' }])
  assert.deepEqual(manifest.contributes.statusBarItems, [{ id: 'today', text: '—', icon: 'activity', tooltip: 'Usage Insights' }])
  assert.deepEqual(manifest.capabilities, [{ kind: 'workspace:read' }, { kind: 'settings:own' }])
  assert.ok(existsSync(path.join(root, manifest.main)), 'main exists')
  assert.ok(existsSync(path.join(root, manifest.contributes.panels[0].entry)), 'panel entry exists')
})

test('manifest declares the three source settings as multiline strings', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'orca-plugin.json'), 'utf8'))
  assert.deepEqual(manifest.contributes.settings.map((s) => s.key), ['extraClaudeFolders', 'extraCodexFolders', 'sshHosts'])
  for (const setting of manifest.contributes.settings) {
    assert.deepEqual(Object.keys(setting), ['key', 'title', 'description', 'type', 'multiline', 'default', 'placeholder'])
    assert.equal(setting.type, 'string')
    assert.equal(setting.multiline, true)
    assert.equal(setting.default, '')
    assert.ok(setting.description.length > 0 && setting.placeholder.length > 0)
  }
  assert.equal(manifest.contributes.settings[0].title, 'Extra Claude Code folders')
  assert.equal(manifest.contributes.settings[1].title, 'Extra Codex folders')
  assert.equal(manifest.contributes.settings[2].title, 'SSH hosts')
  assert.match(manifest.contributes.settings[2].description, /Linux or macOS/)
})

test('startWorker registers the usage.report and usage.refresh handlers', async () => {
  const mock = mockOrca();
  const worker = startWorker(mock.orca, fakeScanner(), { now: NOON, pollMs: 60_000 });
  await worker.ready;
  assert.deepEqual([...mock.handlers.keys()].sort(), ['usage.refresh', 'usage.report']);
  await worker.stop();
});

test('usage.report defaults to 7d and filters by provider', async () => {
  const mock = mockOrca();
  const records = [usageRecord(), usageRecord({ provider: 'codex', model: 'gpt-5-codex', sessionId: 'c1', output: 10 })];
  const worker = startWorker(mock.orca, fakeScanner(() => result(records)), { now: NOON, pollMs: 60_000 });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');

  const all = await handler({});
  assert.equal(all.range, '7d');
  assert.equal(all.totals.turns, 2);

  const codex = await handler({ range: '30d', providers: ['codex'] });
  assert.equal(codex.range, '30d');
  assert.equal(codex.totals.turns, 1);
  assert.deepEqual(codex.byProvider.map((p) => p.provider), ['codex']);
  await worker.stop();
});

test('usage.report rejects bad input with code invalid_params', async () => {
  const mock = mockOrca();
  const worker = startWorker(mock.orca, fakeScanner(), { now: NOON, pollMs: 60_000 });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');
  const bad = [
    { range: '1y' }, { range: null }, { range: 7 }, { providers: 'claude' }, { providers: ['claude', 3] }, { providers: null },
    { scope: 'folders' }, { scope: null }, { scope: ['worktrees'] },
    { hosts: 'local' }, { hosts: ['local', 3] }, { hosts: [''] }, { hosts: null },
    null, '7d', ['7d'],
  ];
  for (const input of bad) {
    await assert.rejects(handler(input), (error) => error.code === 'invalid_params', JSON.stringify(input));
    await assert.rejects(mock.handlers.get('usage.refresh')(input), (error) => error.code === 'invalid_params', JSON.stringify(input));
  }
  await worker.stop();
});

test('usage.report reuses its Report while the scan records are unchanged', async () => {
  const mock = mockOrca();
  const { build, options } = recordingBuild();
  let current = result([usageRecord()]);
  const worker = startWorker(mock.orca, fakeScanner(() => current), { now: NOON, pollMs: 60_000, build });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');

  await handler({ range: '30d' });
  const built = options.length;
  await handler({ range: '30d' });
  assert.equal(options.length, built, 'same records and request: no new build');

  current = result([usageRecord(), usageRecord({ sessionId: 's2' })]);
  const c = await handler({ range: '30d' });
  assert.equal(options.length, built + 1);
  assert.equal(c.totals.turns, 2);
  await worker.stop();
});

test('usage.refresh forces a rescan without dropping the file cache, for the requested range', async () => {
  const mock = mockOrca();
  const scanner = fakeScanner(() => result([usageRecord()]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000 });
  await worker.ready;
  const before = scanner.calls.order.length;
  const report = await mock.handlers.get('usage.refresh')({});
  assert.deepEqual(scanner.calls.order.slice(before), ['scan:force']);
  assert.equal(scanner.calls.reset, 0);
  assert.equal(report.range, '7d');
  const r30 = await mock.handlers.get('usage.refresh')({ range: '30d' });
  assert.equal(r30.range, '30d');
  await assert.rejects(() => mock.handlers.get('usage.refresh')({ range: 'nope' }), { code: 'invalid_params' });
  assert.equal(report.totals.turns, 1);
  await worker.stop();
});

test('status bar shows today tokens and estimated cost on start', async () => {
  const mock = mockOrca();
  const records = [usageRecord({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })];
  const worker = startWorker(mock.orca, fakeScanner(() => result(records)), { now: NOON, pollMs: 60_000 });
  await worker.ready;
  assert.deepEqual(mock.statusUpdates(), [{ id: 'today', text: '1M today', tooltip: 'Tokens today · $3.00' }]);
  await worker.stop();
});

test('status bar shows $0.00 when today has only unpriced usage', async () => {
  const mock = mockOrca();
  const records = [usageRecord({ provider: 'codex', model: 'gpt-5-codex', output: 1200, input: 0 })];
  const worker = startWorker(mock.orca, fakeScanner(() => result(records)), { now: NOON, pollMs: 60_000 });
  await worker.ready;
  assert.deepEqual(mock.statusUpdates(), [{ id: 'today', text: '1.2k today', tooltip: 'Tokens today · $0.00' }]);
  await worker.stop();
});

test('background poll posts usage.changed only for a scan that changed data', async () => {
  const mock = mockOrca();
  const scanner = fakeScanner((n) => result([usageRecord()], n === 1));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 2 });
  await waitFor(() => scanner.calls.scan >= 3);
  await worker.stop();
  assert.deepEqual(mock.posts, [['usage.changed', { generatedAt: NOON().toISOString() }]]);
});

test('background poll never overlaps a running scan', async () => {
  const mock = mockOrca();
  let running = 0;
  let peak = 0;
  const scanner = fakeScanner(async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(15);
    running--;
    return result([]);
  });
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 1 });
  await waitFor(() => scanner.calls.scan >= 4);
  await worker.stop();
  assert.equal(peak, 1);
});

test('a failed scan is logged and the poll keeps running', async () => {
  const mock = mockOrca();
  const scanner = fakeScanner((n) => {
    if (n === 1) throw new Error('disk gone');
    return result([usageRecord()]);
  });
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 2 });
  await waitFor(() => mock.statusUpdates().length >= 1);
  await worker.stop();
  assert.match(mock.logs[0], /disk gone/);
});

test('a rejected statusBar.update is logged and the poll keeps running', async () => {
  const mock = mockOrca();
  mock.orca.host.call = async () => {
    throw new Error('host down');
  };
  const scanner = fakeScanner(() => result([usageRecord()]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 2 });
  await waitFor(() => scanner.calls.scan >= 3);
  await worker.stop();
  assert.ok(mock.logs.some((line) => /host down/.test(line)));
});

test('stop clears the timer, flushes the scanner, and ends scanning', async () => {
  const mock = mockOrca();
  const scanner = fakeScanner(() => result([]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 2 });
  await worker.ready;
  await worker.stop();
  const scans = scanner.calls.scan;
  await sleep(20);
  assert.equal(scanner.calls.scan, scans);
  assert.equal(scanner.calls.flush, 1);
  assert.equal(scanner.calls.order.at(-1), 'flush');
});

test('compact formats token counts', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(999), '999');
  assert.equal(compact(1200), '1.2k');
  assert.equal(compact(3_000_000), '3M');
  assert.equal(compact(3_400_000), '3.4M');
  assert.equal(compact(15_900_000_000), '15.9B');
});

test('deactivate without activate is a no-op', async () => {
  await deactivate();
});

test('settings folders are trimmed, ~ expands, comments and blanks drop, relative paths are skipped once', async () => {
  const home = path.join(os.tmpdir(), 'usage-home');
  const abs = path.join(os.tmpdir(), 'abs-claude');
  const mock = mockOrca({
    settings: {
      extraClaudeFolders: `  ~/backup/.claude \n# archived\n\n${abs}\r\nrelative/dir\n~/backup/.claude`,
      extraCodexFolders: '~\n',
      sshHosts: '',
    },
  });
  const scanner = fakeScanner(() => result([]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000, home, platform: process.platform });
  await worker.ready;
  await mock.handlers.get('usage.report')({});
  await mock.handlers.get('usage.report')({});
  const last = scanner.calls.roots.at(-1);
  assert.deepEqual(last, { claude: [path.join(home, 'backup', '.claude'), abs], codex: [home] });
  assert.equal(mock.logs.filter((line) => /relative\/dir/.test(line)).length, 1, 'logged once across scans');
  await worker.stop();
});

test('SSH hosts are trimmed and de-duplicated, and each gets a cache file under the cache dir', async () => {
  const dir = path.join(os.tmpdir(), 'usage-ssh-cache');
  const mock = mockOrca({ settings: { sshHosts: '# old box\n box \n\nuser@example.com\nbox' } });
  const ssh = fakeSsh();
  const worker = startWorker(mock.orca, fakeScanner(), { now: NOON, pollMs: 60_000, sshCacheDir: dir, makeSshSource: ssh.make });
  await worker.ready;
  assert.deepEqual([...ssh.info.keys()].sort(), ['box', 'user@example.com']);
  assert.match(ssh.info.get('box').cacheFile, /ssh-box-[0-9a-f]{10}\.json$/);
  assert.match(ssh.info.get('user@example.com').cacheFile, /ssh-user_example\.com-[0-9a-f]{10}\.json$/);
  assert.equal(path.dirname(ssh.info.get('box').cacheFile), dir);
  assert.notEqual(ssh.info.get('user@example.com').cacheFile.replace('user@', 'user_'), ssh.info.get('box').cacheFile);
  await worker.stop();
});

test('"name = host" lines give an SSH host a display name; duplicate names keep the first', async () => {
  const mock = mockOrca({ settings: { sshHosts: 'aws = ec2-1-2-3-4.example.com\naws = other.example.com\nplain' } });
  const ssh = fakeSsh();
  const worker = startWorker(mock.orca, fakeScanner(), { now: NOON, pollMs: 60_000, makeSshSource: ssh.make });
  await worker.ready;
  assert.deepEqual([...ssh.info.keys()].sort(), ['ec2-1-2-3-4.example.com', 'plain']);
  assert.equal(ssh.info.get('ec2-1-2-3-4.example.com').name, 'aws');
  assert.equal(ssh.info.get('plain').name, 'plain');
  await worker.stop();
});

test('an SSH host the source refuses is skipped with one log line', async () => {
  const mock = mockOrca({ settings: { sshHosts: '-bad' } });
  const scanner = fakeScanner(() => result([usageRecord()]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000 });
  await worker.ready;
  await mock.handlers.get('usage.report')({});
  await mock.handlers.get('usage.report')({});
  assert.equal(mock.logs.filter((line) => /SSH host "-bad" was skipped/.test(line)).length, 1);
  const report = await mock.handlers.get('usage.report')({});
  assert.deepEqual(report.sources.map((s) => s.id), ['local']);
  await worker.stop();
});

test('a failed settings read logs once, scans with no folders or hosts, and never fails the report', async () => {
  const mock = mockOrca({ settings: { sshHosts: 'box' } });
  mock.failSettings = true;
  const ssh = fakeSsh();
  const scanner = fakeScanner(() => result([usageRecord()]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000, makeSshSource: ssh.make });
  await worker.ready;
  const first = await mock.handlers.get('usage.report')({});
  await mock.handlers.get('usage.report')({});
  assert.equal(mock.logs.filter((line) => /could not read settings/.test(line)).length, 1);
  assert.deepEqual(scanner.calls.roots.at(-1), { claude: [], codex: [] });
  assert.equal(ssh.info.size, 0);
  assert.deepEqual(first.sources.map((s) => s.id), ['local']);
  mock.failSettings = false;
  await mock.handlers.get('usage.report')({});
  assert.equal(ssh.info.size, 1, 'hosts come back when settings do');
  await worker.stop();
});

test('an SSH host that finishes inside the wait is merged with status ok and no usage.changed', async () => {
  const mock = mockOrca();
  const ssh = fakeSsh();
  ssh.setRecords('box', [usageRecord({ host: 'ssh:box', sessionId: 'remote' })]);
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), {
    now: NOON,
    pollMs: 60_000,
    makeSshSource: ssh.make,
  });
  await worker.ready;
  mock.settings.sshHosts = 'box';
  const report = await mock.handlers.get('usage.report')({});
  assert.equal(report.sources.find((s) => s.id === 'ssh:box').state, 'ok');
  assert.equal(report.totals.turns, 2);
  assert.equal(mock.changedPosts(), 0);
  await worker.stop();
});

test('an SSH host still running after the wait is reported loading, then usage.changed posts when it finishes', async () => {
  const mock = mockOrca();
  const ssh = fakeSsh();
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), {
    now: NOON,
    pollMs: 60_000,
    makeSshSource: ssh.make,
    sshWaitMs: 20,
  });
  await worker.ready;
  mock.settings.sshHosts = 'slow';
  let release;
  ssh.hold('slow', new Promise((resolve) => (release = resolve)));
  ssh.setRecords('slow', [usageRecord({ host: 'ssh:slow', sessionId: 'remote' })]);

  const started = Date.now();
  const handler = mock.handlers.get('usage.report');
  const waiting = await handler({});
  assert.ok(Date.now() - started < 1000, 'the panel does not wait for the host');
  assert.equal(waiting.sources.find((s) => s.id === 'ssh:slow').state, 'loading');
  assert.equal(waiting.totals.turns, 1, 'only local records while the host loads');
  assert.equal(mock.changedPosts(), 0);

  release();
  await waitFor(() => mock.changedPosts() === 1);
  const later = await handler({});
  assert.equal(later.sources.find((s) => s.id === 'ssh:slow').state, 'ok');
  assert.equal(later.totals.turns, 2);
  await worker.stop();
});

test('the status bar poll does not wait for an SSH host', async () => {
  const mock = mockOrca({ settings: { sshHosts: 'slow' } });
  const ssh = fakeSsh();
  let release;
  ssh.hold('slow', new Promise((resolve) => (release = resolve)));
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), {
    now: NOON,
    pollMs: 60_000,
    makeSshSource: ssh.make,
  });
  await Promise.race([
    worker.ready,
    sleep(500).then(() => {
      throw new Error('the poll waited for SSH');
    }),
  ]);
  assert.equal(mock.statusUpdates().length, 1);
  release();
  await waitFor(() => mock.changedPosts() === 1);
  await worker.stop();
});

test('usage.refresh forces every source, SSH included', async () => {
  const mock = mockOrca({ settings: { sshHosts: 'box' } });
  const ssh = fakeSsh();
  const scanner = fakeScanner(() => result([usageRecord()]));
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000, makeSshSource: ssh.make });
  await worker.ready;
  const before = scanner.calls.order.length;
  await mock.handlers.get('usage.refresh')({});
  assert.deepEqual(scanner.calls.order.slice(before), ['scan:force']);
  assert.equal(ssh.info.get('box').scans.at(-1), true);
  await worker.stop();
});

test('removing an SSH host closes it and its records leave the report', async () => {
  const mock = mockOrca({ settings: { sshHosts: 'a\nb' } });
  const ssh = fakeSsh();
  ssh.setRecords('a', [usageRecord({ host: 'ssh:a', sessionId: 'a1' })]);
  ssh.setRecords('b', [usageRecord({ host: 'ssh:b', sessionId: 'b1' }), usageRecord({ host: 'ssh:b', sessionId: 'b2' })]);
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000, makeSshSource: ssh.make });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');
  assert.equal((await handler({})).totals.turns, 4);

  mock.settings.sshHosts = 'a';
  const report = await handler({});
  assert.equal(ssh.info.get('b').closes, 1);
  assert.equal(ssh.info.get('a').closes, 0);
  assert.deepEqual(report.sources.map((s) => s.id), ['local', 'ssh:a']);
  assert.equal(report.totals.turns, 2);
  await worker.stop();
});

test('stop flushes the local cache before it closes the SSH sources', async () => {
  const mock = mockOrca({ settings: { sshHosts: 'box' } });
  const scanner = fakeScanner(() => result([usageRecord()]));
  const ssh = fakeSsh({ onClose: (host) => scanner.calls.order.push(`close:${host}`) });
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000, makeSshSource: ssh.make });
  await worker.ready;
  await worker.stop();
  assert.deepEqual(scanner.calls.order.slice(-2), ['flush', 'close:box']);
});

test('status and folder entries from the scan show on report.sources, with local warnings for unreadable files', async () => {
  const mock = mockOrca();
  const folder = path.join(os.tmpdir(), 'usage-backup');
  const scanner = fakeScanner(() =>
    result([usageRecord()], false, {
      errors: 2,
      folders: [
        { path: folder, kind: 'claude', state: 'warning', files: 0, records: 0, message: 'Folder not found' },
        { path: `${folder}-codex`, kind: 'codex', state: 'ok', files: 3, records: 4 },
      ],
    }),
  );
  const worker = startWorker(mock.orca, scanner, { now: NOON, pollMs: 60_000 });
  await worker.ready;
  const report = await mock.handlers.get('usage.report')({});
  const [local, missing, present] = report.sources;
  assert.deepEqual([local.id, local.kind, local.label], ['local', 'local', 'This machine']);
  assert.equal(local.state, 'warning');
  assert.equal(local.message, '2 transcript files could not be read');
  assert.equal(local.records, 1);
  assert.deepEqual([missing.id, missing.kind, missing.label, missing.state, missing.message], ['folder:' + folder, 'folder', folder, 'warning', 'Folder not found']);
  assert.deepEqual([present.id, present.state, present.files, present.records], ['folder:' + folder + '-codex', 'ok', 3, 4]);
  await worker.stop();
});

test('scope worktrees keeps only worktree workspaces, with case-insensitive matching on win32', async () => {
  const wt = path.join(os.tmpdir(), 'wt-a');
  const mock = mockOrca({
    workspaces: () => ({
      workspaces: [
        { id: '1', kind: 'worktree', name: 'a', path: wt, branch: 'main', hostId: null },
        { id: '2', kind: 'folder', name: 'notes', path: path.join(os.tmpdir(), 'notes'), branch: null, hostId: null },
      ],
      truncated: false,
    }),
  });
  const { build, options } = recordingBuild();
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000, build });
  await worker.ready;
  const report = await mock.handlers.get('usage.report')({ scope: 'worktrees' });
  assert.deepEqual(options.at(-1).scope, { roots: [wt], caseInsensitive: process.platform === 'win32' });
  assert.equal(report.scopeError, undefined);

  const win = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000, build, platform: 'win32' });
  await win.ready;
  await mock.handlers.get('usage.report')({ scope: 'worktrees' });
  assert.equal(options.at(-1).scope.caseInsensitive, true);
  await worker.stop();
  await win.stop();
});

test('scope and hosts filter the report through the real buildReport', async () => {
  const wt = path.join(os.tmpdir(), 'wt-real');
  const mock = mockOrca({ settings: { sshHosts: 'box' }, workspaces: () => ({ workspaces: [{ kind: 'worktree', path: wt }] }) });
  const ssh = fakeSsh();
  ssh.setRecords('box', [usageRecord({ host: 'ssh:box', cwd: wt, sessionId: 'b1' })]);
  const local = [
    usageRecord({ cwd: path.join(wt, 'pkg') }),
    usageRecord({ cwd: path.join(os.tmpdir(), 'elsewhere'), sessionId: 's2' }),
  ];
  const worker = startWorker(mock.orca, fakeScanner(() => result(local)), { now: NOON, pollMs: 60_000, makeSshSource: ssh.make });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');
  assert.equal((await handler({})).totals.turns, 3);
  assert.equal((await handler({ scope: 'worktrees' })).totals.turns, 2, 'the worktree record on each host');
  assert.deepEqual((await handler({ hosts: ['ssh:box'] })).totals.turns, 1);
  const both = await handler({ scope: 'worktrees', hosts: ['local'] });
  assert.equal(both.totals.turns, 1);
  assert.equal(both.scoped, true);
  await worker.stop();
});

test('scope worktrees with no worktrees passes an empty root list', async () => {
  const mock = mockOrca({ workspaces: () => ({ workspaces: [{ kind: 'folder', path: os.tmpdir() }] }) });
  const { build, options } = recordingBuild();
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000, build });
  await worker.ready;
  await mock.handlers.get('usage.report')({ scope: 'worktrees' });
  assert.deepEqual(options.at(-1).scope.roots, []);
  await worker.stop();
});

test('scope worktrees falls back to an unscoped report with scopeError when workspace.list fails', async () => {
  const mock = mockOrca({
    workspaces: () => {
      throw new Error('workspace service down');
    },
  });
  const { build, options } = recordingBuild();
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000, build });
  await worker.ready;
  const report = await mock.handlers.get('usage.report')({ scope: 'worktrees' });
  assert.match(report.scopeError, /Worktree scope unavailable: workspace service down/);
  assert.equal(options.at(-1).scope, undefined);
  assert.equal(report.totals.turns, 1);
  await worker.stop();
});

test('scope worktrees reports an unexpected workspace.list reply as scopeError', async () => {
  const mock = mockOrca({ workspaces: () => ['not', 'a', 'reply'] });
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000 });
  await worker.ready;
  const report = await mock.handlers.get('usage.report')({ scope: 'worktrees' });
  assert.match(report.scopeError, /unexpected workspace.list reply/);
  await worker.stop();
});

test('the workspace list is cached for 30 s', async () => {
  const mock = mockOrca({ workspaces: () => ({ workspaces: [] }) });
  let at = NOON();
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: () => at, pollMs: 60_000 });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');
  await handler({ scope: 'worktrees' });
  await handler({ scope: 'worktrees', range: '30d' });
  assert.equal(mock.callsTo('workspace.list').length, 1);
  at = new Date(at.getTime() + 31_000);
  await handler({ scope: 'worktrees' });
  assert.equal(mock.callsTo('workspace.list').length, 2);
  await worker.stop();
});

test('hosts and scope are passed through to buildReport, and scope all asks for no scope', async () => {
  const mock = mockOrca();
  const { build, options } = recordingBuild();
  const worker = startWorker(mock.orca, fakeScanner(() => result([usageRecord()])), { now: NOON, pollMs: 60_000, build });
  await worker.ready;
  const handler = mock.handlers.get('usage.report');
  await handler({ hosts: ['local', 'ssh:box'], range: '30d' });
  assert.deepEqual(options.at(-1).hosts, ['local', 'ssh:box']);
  assert.equal(options.at(-1).range, '30d');
  assert.equal('scope' in options.at(-1), false);
  await handler({ scope: 'all' });
  assert.equal('scope' in options.at(-1), false);
  assert.equal('hosts' in options.at(-1), false);
  await worker.stop();
});

test('activate scans the real roots and deactivate flushes the cache under the cache dir', async (t) => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-worker-')));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const env = {
    HOME: base,
    USERPROFILE: base,
    XDG_CACHE_HOME: path.join(base, 'cache'),
    LOCALAPPDATA: path.join(base, 'local'),
    XDG_CONFIG_HOME: path.join(base, 'config'),
    CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
    CODEX_HOME: path.join(base, 'codex'),
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);

  const projectDir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'pyrosome');
  await fsp.mkdir(projectDir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    requestId: 'r1',
    sessionId: 's1',
    cwd: '/work/pyrosome',
    message: {
      id: 'm1',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  await fsp.writeFile(path.join(projectDir, 'session-1.jsonl'), `${line}\n`);

  const mock = mockOrca();
  await activate(mock.orca);
  try {
    const report = await mock.handlers.get('usage.report')({ range: '30d' });
    assert.equal(report.totals.turns, 1);
    assert.equal(report.totals.total, 3);
    assert.equal(report.sources[0].id, 'local');
  } finally {
    await deactivate();
  }

  const cache = JSON.parse(await fsp.readFile(path.join(cacheDir(), 'scan-cache-v1.json'), 'utf8'));
  assert.equal(cache.version, 2);
  assert.equal(Object.keys(cache.files).length, 1);
});
