#!/usr/bin/env node
// Times the scanner against this machine's real home.
//   cold:    fresh scanner, no cache file.
//   warm:    the same scanner rescanning after the 5 s reuse window (a running worker).
//   restart: a new scanner that loads the cache cold wrote (a restarted worker).
//   tail:    one line appended to a synthetic transcript, rescanned after a restart.
// Everything it writes goes to a temp dir, which is removed at the end.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScanner } from '../src/node/scan.mjs';
import { resolveRoots } from '../src/node/paths.mjs';

const COLD_TARGET_MS = 5_000;
const WARM_TARGET_MS = 200;
const REUSE_WINDOW_MS = 6_000;

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-bench-'));
try {
  const roots = await resolveRoots({ realpath: fsp.realpath });
  console.log(`roots: claude=${roots.claude.length} codex=${roots.codex.length}`);

  // Clock offset moves past the scanner's 5 s reuse window without sleeping.
  let offset = 0;
  const now = () => Date.now() + offset;
  const cacheFile = path.join(dir, 'scan-cache-v4.json');

  const counts = { opens: 0 };
  const fs = counting(counts);
  const scanner = createScanner({ fs, cacheFile, now });
  const cold = await timedScan(scanner, counts);
  await scanner.flush();
  report('cold', cold, 'real home, no cache file');

  offset += REUSE_WINDOW_MS;
  const warm = await timedScan(scanner, counts);
  report('warm', warm, 'real home, same scanner, cached');

  offset += REUSE_WINDOW_MS;
  const restarted = createScanner({ fs, cacheFile, now });
  const restart = await timedScan(restarted, counts);
  await restarted.flush();
  report('restart', restart, 'real home, new scanner, cache from disk');

  const tailRoot = path.join(dir, 'tail-claude');
  const tailFile = path.join(tailRoot, 'projects', 'bench', 'session.jsonl');
  await fsp.mkdir(path.dirname(tailFile), { recursive: true });
  const line = (i) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-01T10:00:00.000Z',
      sessionId: 'bench',
      requestId: 'req',
      cwd: '/bench/project',
      message: {
        id: `m${i}`,
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 },
      },
    }) + '\n';
  let body = '';
  for (let i = 0; i < 20_000; i++) body += line(i);
  await fsp.writeFile(tailFile, body);
  const tailEnv = { CLAUDE_CONFIG_DIR: tailRoot, CODEX_HOME: path.join(dir, 'no-codex') };
  const tailCache = path.join(dir, 'tail-cache.json');
  const primed = createScanner({ env: tailEnv, fs, cacheFile: tailCache, now });
  await primed.scan();
  await primed.flush();
  await fsp.appendFile(tailFile, line(20_000));
  offset += REUSE_WINDOW_MS;
  const tailScanner = createScanner({ env: tailEnv, fs, cacheFile: tailCache, now });
  const tail = await timedScan(tailScanner, counts);
  await tailScanner.flush();
  report('tail', tail, '1 line appended to a 5 MB synthetic transcript, after restart');

  console.log(
    `targets: cold < ${COLD_TARGET_MS} ms ${cold.ms < COLD_TARGET_MS ? 'met' : 'missed'}, ` +
      `warm < ${WARM_TARGET_MS} ms ${warm.ms < WARM_TARGET_MS ? 'met' : 'missed'}`,
  );
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}

// Counts opens through node:fs/promises, so reads show up per run.
function counting(counts) {
  return {
    ...fsp,
    async open(file, flags) {
      counts.opens++;
      return fsp.open(file, flags);
    },
  };
}

async function timedScan(scanner, counts) {
  counts.opens = 0;
  const start = performance.now();
  const result = await scanner.scan();
  return { ms: performance.now() - start, result, opens: counts.opens };
}

function report(label, run, note) {
  const { result } = run;
  console.log(
    `${label.padEnd(7)} ${run.ms.toFixed(0).padStart(6)} ms  files=${result.files} records=${result.records.length} ` +
      `errors=${result.errors} opens=${run.opens}  (${note})`,
  );
}
