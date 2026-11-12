import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import activate, { deactivate, startWorker } from '../src/worker.mjs';
import { createPriceBook } from '../src/node/price-book.mjs';

// Only the price book may reach the network. Everything else in src/ must stay offline, so the
// panel's own paths (status, reports, polls, agent events) never send a request.
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const priceBookFile = path.join(srcDir, 'node', 'price-book.mjs');
const FORBIDDEN = [/\bfetch\(/, /['"](node:)?https?['"]/, /['"](node:)?net['"]/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/];
const NOON = () => new Date(2026, 10, 3, 12, 0, 0); // local noon, 2026-11-03

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

// Orca host stand-in with the handlers, events and log the worker uses.
function mockOrca() {
  const mock = { handlers: new Map(), posts: [], hostCalls: [], listeners: {} };
  mock.orca = {
    panels: {
      handle: (name, fn) => mock.handlers.set(name, fn),
      post: (name, payload) => mock.posts.push([name, payload]),
    },
    host: {
      call: async (method) => {
        mock.hostCalls.push(method);
        if (method === 'settings.get') return { settings: {} };
        if (method === 'workspace.list') return { workspaces: [] };
      },
    },
    log: () => {},
    events: {
      on: (name, fn) => {
        (mock.listeners[name] ||= []).push(fn);
        return { dispose: () => {} };
      },
    },
  };
  mock.emit = (name, payload) => (mock.listeners[name] || []).forEach((fn) => fn(payload));
  mock.statusUpdates = () => mock.hostCalls.filter((method) => method === 'statusBar.update').length;
  return mock;
}

// A fetch that records every call and fails it, so a stray request is both visible and harmless.
function fetchSpy() {
  const spy = async (...args) => {
    spy.calls.push(args);
    throw new Error('network is off in this test');
  };
  spy.calls = [];
  return spy;
}

// Stands in for createScanner: every scan returns the same single record.
function oneRecordScanner() {
  const scanner = {
    scans: 0,
    async scan() {
      scanner.scans++;
      return { records: [usageRecord()], files: 1, errors: 0, changed: scanner.scans === 1 };
    },
    setExtraRoots() {},
    async flush() {},
  };
  return scanner;
}

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(file)));
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(file);
  }
  return out;
}

async function waitUntil(condition, ms = 2_000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting for the worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('only src/node/price-book.mjs calls fetch or opens a network module', async () => {
  const allowed = await fsp.readFile(priceBookFile, 'utf8');
  assert.match(allowed, /\bfetch\(/);
  for (const file of await sourceFiles(srcDir)) {
    if (file === priceBookFile) continue;
    const text = await fsp.readFile(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${path.relative(srcDir, file)} must not match ${pattern}`);
    }
  }
});

test('activate, poll and usage.report never call the network', async (t) => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-offline-')));
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

  const spy = fetchSpy();
  const realFetch = globalThis.fetch;
  globalThis.fetch = spy;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const mock = mockOrca();
  await activate(mock.orca);
  try {
    // The first poll runs at activation; wait for its status bar update before asking for a report.
    await waitUntil(() => mock.statusUpdates() > 0);
    const report = await mock.handlers.get('usage.report')({ range: '30d' });
    assert.equal(report.totals.turns, 1);
  } finally {
    await deactivate();
  }
  assert.deepEqual(spy.calls, []);
});

test('an agent finishing and the panel reports never call the injected fetch', async (t) => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-offline-prices-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const spy = fetchSpy();
  const mock = mockOrca();
  const scanner = oneRecordScanner();
  const worker = startWorker(mock.orca, scanner, {
    now: NOON,
    pollMs: 60_000,
    agentSettleMs: 0,
    statusBar: true,
    priceBook: createPriceBook({ fetch: spy, dir }),
  });
  await worker.ready;
  try {
    assert.equal(scanner.scans, 1);
    mock.emit('agent.status.changed', { state: 'done' });
    await waitUntil(() => scanner.scans >= 2);
    const report = await mock.handlers.get('usage.report')({ range: '30d' });
    assert.equal(report.totals.turns, 1);
  } finally {
    await worker.stop();
  }
  assert.deepEqual(spy.calls, []);
});
