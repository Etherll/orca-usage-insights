#!/usr/bin/env node
// Times what the panel waits for, through the worker's own handlers, against this machine's
// real transcripts. Uses a temp cache file, so the real plugin cache is never touched.
//   open (cold):      first usage.report with no cache file (first install)
//   open (restart):   first usage.report after a worker restart (cache loaded from disk)
//   switch range:     usage.report for 30d / 90d / all on a warm worker
//   reopen:           the same request again inside the 5 s reuse window
//   refresh button:   usage.refresh
//   report size:      JSON bytes sent to the panel per range
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createScanner } from '../src/node/scan.mjs';
import { startWorker } from '../src/worker.mjs';

const RUNS = Number(process.argv[2]) || 5;
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-bench-worker-'));
const cacheFile = path.join(dir, 'scan-cache-v1.json');

let offset = 0; // moves the clock past the 5 s reuse window without sleeping
const clock = () => Date.now() + offset;

function boot() {
  const handlers = new Map();
  const orca = {
    panels: { handle: (name, fn) => handlers.set(name, fn), post() {} },
    host: { call: async () => {} },
    log() {},
  };
  const scanner = createScanner({ home: os.homedir(), cacheFile, now: clock });
  const worker = startWorker(orca, scanner, { pollMs: 3_600_000 });
  return { worker, scanner, call: (name, input) => handlers.get(name)(input, {}) };
}

async function time(fn) {
  const t = performance.now();
  const out = await fn();
  return [performance.now() - t, out];
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (ms) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`.padStart(9);
const rows = [];
const row = (name, ms, note = '') => rows.push(`${name.padEnd(28)}${fmt(ms)}  ${note}`);

try {
  // Cold: no cache file. The status bar poll starts the first scan; the panel request joins it.
  let w = boot();
  const [cold, r7] = await time(() => w.call('usage.report', { range: '7d' }));
  row('open (cold, no cache)', cold, `${r7.totals.turns.toLocaleString()} turns in 7d`);
  await w.worker.stop();

  const restarts = [];
  for (let i = 0; i < RUNS; i++) {
    w = boot();
    const [ms] = await time(() => w.call('usage.report', { range: '7d' }));
    restarts.push(ms);
    await w.worker.stop();
  }
  row('open (worker restart)', median(restarts), `median of ${RUNS}`);

  w = boot();
  await w.call('usage.report', { range: '7d' });
  for (const range of ['30d', '90d', 'all']) {
    const xs = [];
    for (let i = 0; i < RUNS; i++) {
      offset += 6_000;
      const [ms] = await time(() => w.call('usage.report', { range }));
      xs.push(ms);
    }
    row(`switch range → ${range}`, median(xs), 'rescan (stat only) + build');
  }
  const again = [];
  for (let i = 0; i < RUNS; i++) again.push((await time(() => w.call('usage.report', { range: 'all' })))[0]);
  row('reopen (within 5 s)', median(again), 'served from memory');

  const refresh = [];
  for (let i = 0; i < Math.min(RUNS, 3); i++) {
    offset += 6_000;
    refresh.push((await time(() => w.call('usage.refresh', {})))[0]);
  }
  row('refresh button', median(refresh), `median of ${refresh.length}`);

  const sizes = [];
  for (const range of ['7d', '30d', '90d', 'all']) {
    const r = await w.call('usage.report', { range });
    sizes.push(`${range} ${(JSON.stringify(r).length / 1024).toFixed(1)} KB`);
  }
  await w.worker.stop();

  console.log(`machine: ${os.cpus()[0]?.model ?? 'cpu'} ×${os.cpus().length}, load ${os.loadavg()[0].toFixed(1)}, node ${process.version}`);
  console.log(rows.join('\n'));
  console.log(`report size: ${sizes.join(' · ')} (limit 1 MiB)`);
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}
