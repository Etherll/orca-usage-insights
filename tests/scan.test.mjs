import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScanner } from '../src/node/scan.mjs';
import { zstdAvailable } from '../src/node/zstd.mjs';

const T = '2026-10-01T10:00:00.000Z';

function claudeLine({ id, requestId = 'req', ts = T, output = 10, cwd, sessionId, model = 'claude-sonnet-4-5' }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId,
    ...(cwd ? { cwd } : {}),
    ...(sessionId ? { sessionId } : {}),
    message: {
      id,
      model,
      usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    },
  });
}

const codexMeta = (cwd) => JSON.stringify({ type: 'session_meta', timestamp: T, payload: { cwd } });
const codexTurn = (model) => JSON.stringify({ type: 'turn_context', timestamp: T, payload: { model } });
const codexUsage = (output) =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: T,
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: output } } },
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-scan-')));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const claude = path.join(base, 'claude');
  const codex = path.join(base, 'codex');
  await fsp.mkdir(path.join(claude, 'projects', 'proj-a'), { recursive: true });
  await fsp.mkdir(path.join(codex, 'sessions'), { recursive: true });
  return {
    base,
    claude,
    codex,
    env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex },
    cacheFile: path.join(base, 'cache', 'scan-cache-v3.json'),
    file: (...parts) => path.join(claude, 'projects', 'proj-a', ...parts),
  };
}

// Wraps node:fs/promises and records what the scanner touches. hooks.stat / hooks.open /
// hooks.readdir may throw.
function recordingFs(hooks = {}) {
  const log = {
    stats: 0,
    opened: [],
    reads: [],
    readdir: [],
    readFile: [],
    renames: [],
    clear() {
      Object.assign(this, { stats: 0, opened: [], reads: [], readdir: [], readFile: [], renames: [] });
    },
  };
  const fs = {
    ...fsp,
    async stat(file) {
      log.stats++;
      await hooks.stat?.(file);
      return fsp.stat(file);
    },
    async readdir(dir, options) {
      log.readdir.push(options);
      await hooks.readdir?.(dir);
      return fsp.readdir(dir, options);
    },
    async readFile(file, ...rest) {
      log.readFile.push(file);
      return fsp.readFile(file, ...rest);
    },
    async open(file, flags) {
      log.opened.push(file);
      await hooks.open?.(file);
      const handle = await fsp.open(file, flags);
      return {
        read: (buf, offset, length, position) => {
          log.reads.push({ file, pos: position, len: length });
          return handle.read(buf, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
    async rename(from, to) {
      log.renames.push([from, to]);
      return fsp.rename(from, to);
    },
  };
  return { fs, log };
}

const lines = (...items) => items.join('\n') + '\n';

test('unchanged files cost one stat and no transcript reads', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' })));
  await fsp.writeFile(fx.file('b.jsonl'), lines(claudeLine({ id: 'm3' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });

  const first = await scanner.scan();
  assert.equal(first.records.length, 3);
  assert.equal(first.changed, true);

  clock += 6_000;
  rec.log.clear();
  const second = await scanner.scan();
  assert.equal(rec.log.stats, 2, 'every file is stat-ed');
  assert.deepEqual(rec.log.opened, []);
  assert.deepEqual(rec.log.reads, []);
  assert.deepEqual(second.records.toRecords(), first.records.toRecords());
  assert.equal(second.changed, false);
});

test('concurrent scans share one run, and a result under 5 s old is reused', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });

  const a = scanner.scan();
  const b = scanner.scan();
  assert.equal(a, b);
  const first = await a;

  clock += 1_000;
  rec.log.clear();
  const reused = await scanner.scan();
  assert.equal(reused.records, first.records);
  assert.equal(rec.log.stats, 0);

  clock += 5_000;
  const rescanned = await scanner.scan();
  assert.equal(rec.log.stats, 1);
  assert.equal(rescanned.records, first.records);

  await fsp.appendFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm2' })));
  clock += 5_000;
  const grown = await scanner.scan();
  assert.notEqual(grown.records, first.records);
  assert.equal(grown.records.length, 2);
});

test('reset forces a full re-read on the next scan', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  await scanner.scan();
  scanner.reset();
  rec.log.clear();
  const result = await scanner.scan();
  assert.equal(rec.log.opened.length, 1);
  assert.equal(rec.log.reads[0].pos, 0);
  assert.equal(result.records.length, 2);
});

test('appended lines are read from the stored offset and stay deduped', async (t) => {
  const fx = await fixture(t);
  const first = lines(claudeLine({ id: 'm1', output: 10 }), claudeLine({ id: 'm2', output: 20 }));
  await fsp.writeFile(fx.file('s.jsonl'), first);
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  await scanner.scan();

  // m2 streams again with a new output; the last line wins.
  const extra = lines(claudeLine({ id: 'm3', output: 30 }), claudeLine({ id: 'm2', output: 99 }));
  await fsp.appendFile(fx.file('s.jsonl'), extra);
  clock += 6_000;
  rec.log.clear();
  const result = await scanner.scan();

  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.toRecords().map((r) => r.output), [10, 99, 30]);
  // One probe byte before the offset, then the new bytes.
  assert.equal(rec.log.reads.length, 2);
  assert.deepEqual([rec.log.reads[0].pos, rec.log.reads[0].len], [Buffer.byteLength(first) - 1, 1]);
  assert.equal(rec.log.reads[1].pos, Buffer.byteLength(first));
  assert.equal(rec.log.reads[1].len, Buffer.byteLength(extra));
  assert.equal(result.changed, true);
});

test('a half-written last line is picked up by the next scan', async (t) => {
  const fx = await fixture(t);
  const complete = claudeLine({ id: 'm1' }) + '\n';
  const rest = claudeLine({ id: 'm2' });
  await fsp.writeFile(fx.file('s.jsonl'), complete + rest.slice(0, 40));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 1);

  await fsp.appendFile(fx.file('s.jsonl'), rest.slice(40) + '\n');
  clock += 6_000;
  rec.log.clear();
  const result = await scanner.scan();
  assert.equal(result.records.length, 2);
  // reads[0] is the probe byte before the offset; reads[1] is the tail.
  assert.equal(rec.log.reads[1].pos, Buffer.byteLength(complete));
});

test('a shrunk file is fully re-read', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('s.jsonl'), lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' }), claudeLine({ id: 'm3' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 3);

  await fsp.writeFile(fx.file('s.jsonl'), lines(claudeLine({ id: 'only' })));
  clock += 6_000;
  rec.log.clear();
  const result = await scanner.scan();
  assert.equal(result.records.length, 1);
  assert.equal(rec.log.reads[0].pos, 0);
});

test('an mtime that went back forces a full re-read even when size grew', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('s.jsonl'), lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  await scanner.scan();

  await fsp.appendFile(fx.file('s.jsonl'), lines(claudeLine({ id: 'm3' })));
  const past = new Date(Date.now() - 3_600_000);
  await fsp.utimes(fx.file('s.jsonl'), past, past);
  clock += 6_000;
  rec.log.clear();
  const result = await scanner.scan();
  assert.equal(rec.log.reads[0].pos, 0);
  assert.equal(result.records.length, 3);
});

test('a deleted file drops its records', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  await fsp.writeFile(fx.file('b.jsonl'), lines(claudeLine({ id: 'm2' }), claudeLine({ id: 'm3' })));
  let clock = 1_000_000;
  const scanner = createScanner({ env: fx.env, home: fx.base, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 3);

  await fsp.unlink(fx.file('b.jsonl'));
  clock += 6_000;
  const result = await scanner.scan();
  assert.equal(result.records.length, 1);
  assert.equal(result.changed, true);
});

test('per-file ENOENT, EACCES, EPERM, EBUSY and EISDIR are skipped and counted', async (t) => {
  const cases = [
    ['stat', 'ENOENT'],
    ['stat', 'EACCES'],
    ['stat', 'EPERM'],
    ['open', 'EBUSY'],
    ['open', 'EACCES'],
    ['open', 'EISDIR'],
  ];
  for (const [op, code] of cases) {
    const fx = await fixture(t);
    const bad = fx.file('bad.jsonl');
    await fsp.writeFile(bad, lines(claudeLine({ id: 'b1' })));
    await fsp.writeFile(fx.file('good.jsonl'), lines(claudeLine({ id: 'g1' }), claudeLine({ id: 'g2' })));
    const fail = (file) => {
      if (file === bad) throw Object.assign(new Error(code), { code });
    };
    const rec = recordingFs({ [op]: fail });
    const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs });
    const result = await scanner.scan();
    assert.equal(result.records.length, 2, `${op} ${code}: good file still counted`);
    assert.equal(result.errors, 1, `${op} ${code}: error counted`);
  }
});

test('a locked file keeps the records it already had', async (t) => {
  const fx = await fixture(t);
  const bad = fx.file('bad.jsonl');
  await fsp.writeFile(bad, lines(claudeLine({ id: 'b1' }), claudeLine({ id: 'b2' })));
  let clock = 1_000_000;
  let locked = false;
  const rec = recordingFs({
    open: (file) => {
      if (locked && file === bad) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  });
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 2);

  await fsp.appendFile(bad, lines(claudeLine({ id: 'b3' })));
  locked = true;
  clock += 6_000;
  const result = await scanner.scan();
  assert.equal(result.records.length, 2);
  assert.equal(result.errors, 1);
});

test('CRLF transcripts and multibyte UTF-8 keep byte offsets exact', async (t) => {
  const fx = await fixture(t);
  const cwd = '/work/项目-ü';
  const first = [claudeLine({ id: 'm1', cwd }), claudeLine({ id: 'm2', cwd })].join('\r\n') + '\r\n';
  await fsp.writeFile(fx.file('s.jsonl'), first);
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  const before = await scanner.scan();
  assert.equal(before.records.length, 2);
  assert.equal(before.records.toRecords()[0].project, '项目-ü');

  const extra = claudeLine({ id: 'm3', cwd, sessionId: '🙂-1' }) + '\r\n';
  await fsp.appendFile(fx.file('s.jsonl'), extra);
  clock += 6_000;
  rec.log.clear();
  const after = await scanner.scan();
  assert.equal(after.records.length, 3);
  assert.equal(after.records.toRecords()[2].sessionId, '🙂-1');
  assert.equal(rec.log.reads[1].pos, Buffer.byteLength(first));
});

test('lines split across 4 MiB read chunks are parsed whole', async (t) => {
  const fx = await fixture(t);
  const cjk = '界'.repeat(60);
  const count = 24_000;
  const body = [];
  for (let i = 0; i < count; i++) body.push(claudeLine({ id: `m${i}`, sessionId: `sess-${cjk}` }));
  await fsp.writeFile(fx.file('big.jsonl'), lines(...body));
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, threads: 0 });
  const result = await scanner.scan();
  assert.equal(result.records.length, count);
  assert.ok(rec.log.reads.length >= 3, 'the file spans several chunks');
});

test('lines without the marker strings are never JSON-parsed', async (t) => {
  const fx = await fixture(t);
  const junk = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
  const usageLines = [];
  for (let i = 0; i < 300; i++) usageLines.push(junk);
  usageLines.push(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' }));
  await fsp.writeFile(fx.file('s.jsonl'), lines(...usageLines));

  const codexDir = path.join(fx.codex, 'sessions', '2026', '10', '01');
  await fsp.mkdir(codexDir, { recursive: true });
  const response = JSON.stringify({ type: 'response_item', payload: { type: 'message' } });
  await fsp.writeFile(
    path.join(codexDir, 'rollout-1.jsonl'),
    lines(codexMeta('/w/demo'), codexTurn('gpt-5-codex'), ...Array.from({ length: 100 }, () => response), codexUsage(7)),
  );

  const original = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => {
    parses++;
    return original(...args);
  };
  let result;
  try {
    result = await createScanner({ env: fx.env, home: fx.base, threads: 0 }).scan();
  } finally {
    JSON.parse = original;
  }
  assert.equal(result.records.length, 3);
  // Two Claude usage lines, plus session_meta, turn_context and token_count in the Codex file.
  assert.equal(parses, 5);
});

test('persisted cache lets a restarted scanner skip every unchanged file', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1', cwd: '/w/alpha' })));
  const codexDir = path.join(fx.codex, 'sessions');
  await fsp.writeFile(path.join(codexDir, 'rollout-2.jsonl'), lines(codexMeta('/w/beta'), codexTurn('gpt-5-codex'), codexUsage(3)));

  const first = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  const cold = await first.scan();
  await first.flush();
  assert.equal(cold.records.length, 2);

  const rec = recordingFs();
  const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs });
  const warm = await restarted.scan();
  assert.deepEqual(rec.log.opened, []);
  assert.deepEqual(rec.log.readFile, [fx.cacheFile, `${fx.cacheFile}.journal`]);
  assert.deepEqual(warm.records.toRecords(), cold.records.toRecords());
});

test('a restarted codex tail counts each new turn exactly once', async (t) => {
  const fx = await fixture(t);
  const codexFile = path.join(fx.codex, 'sessions', 'rollout-9.jsonl');
  const first = lines(codexMeta('/w/gamma'), codexTurn('gpt-5-codex'), codexUsage(7));
  await fsp.writeFile(codexFile, first);
  const cold = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  assert.equal((await cold.scan()).records.length, 1);
  await cold.flush();

  await fsp.appendFile(codexFile, lines(codexUsage(11)));
  const rec = recordingFs();
  const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs });
  const result = await restarted.scan();
  await restarted.flush();
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.toRecords().map((r) => r.output), [7, 11]);
  assert.equal(result.records.toRecords()[1].project, 'gamma');
  assert.equal(rec.log.reads[1].pos, Buffer.byteLength(first));
});

test('corrupt or wrong-version cache is ignored and the scan reads everything', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' })));
  await fsp.mkdir(path.dirname(fx.cacheFile), { recursive: true });
  for (const body of ['{not json', JSON.stringify({ version: 1, files: {} }), JSON.stringify({ version: 2, files: { [fx.file('a.jsonl')]: { key: 1 } } })]) {
    await fsp.writeFile(fx.cacheFile, body);
    const rec = recordingFs();
    const scanner = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs });
    const result = await scanner.scan();
    await scanner.flush();
    assert.equal(result.records.length, 2);
    assert.equal(rec.log.opened.length, 1);
  }
});

test('cache is written atomically, at most once per 30 s, and its timer is unref()d', async (t) => {
  const fx = await fixture(t);
  const file = fx.file('a.jsonl');
  await fsp.writeFile(file, lines(claudeLine({ id: 'm1' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs, now: () => clock });

  await scanner.scan();
  await scanner.flush();
  assert.equal(rec.log.renames.length, 1);
  const [from, to] = rec.log.renames[0];
  assert.equal(to, fx.cacheFile);
  assert.notEqual(from, to);
  assert.match(from, /\.tmp$/);
  assert.equal(JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8')).version, 6);

  await fsp.appendFile(file, lines(claudeLine({ id: 'm2' })));
  clock += 10_000;
  const realSetTimeout = globalThis.setTimeout;
  let timer;
  globalThis.setTimeout = (...args) => {
    timer = realSetTimeout(...args);
    return timer;
  };
  try {
    await scanner.scan();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(timer.hasRef(), false);
  assert.equal(rec.log.renames.length, 1, 'write waits for the 30 s window');

  await scanner.flush();
  assert.equal(rec.log.renames.length, 1, 'the changed file goes to the journal');
  const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  const reloaded = await restarted.scan();
  await restarted.flush();
  assert.equal(reloaded.records.length, 2);
});

test('saves after the first journal only the changed and dropped files, and a restart replays them', async (t) => {
  const fx = await fixture(t);
  const journal = `${fx.cacheFile}.journal`;
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  await fsp.writeFile(fx.file('b.jsonl'), lines(claudeLine({ id: 'm2' })));
  await fsp.writeFile(fx.file('c.jsonl'), lines(claudeLine({ id: 'm3' })));
  let clock = 1_000_000;
  const scanner = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, now: () => clock });
  await scanner.scan();
  await scanner.flush();
  const base = await fsp.readFile(fx.cacheFile, 'utf8');
  const { gen } = JSON.parse(base);
  assert.ok(Number.isSafeInteger(gen));
  await assert.rejects(fsp.stat(journal), { code: 'ENOENT' });

  await fsp.appendFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm4' })));
  await fsp.rm(fx.file('c.jsonl'));
  clock += 6_000;
  assert.equal((await scanner.scan()).records.length, 3);
  await scanner.flush();
  assert.equal(await fsp.readFile(fx.cacheFile, 'utf8'), base, 'the cache file is left as it was');
  const entries = (await fsp.readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(entries.map(([g, file, entry]) => [g, file, entry === null]).sort(), [
    [gen, fx.file('a.jsonl'), false],
    [gen, fx.file('c.jsonl'), true],
  ]);

  await fsp.appendFile(journal, `${JSON.stringify([gen + 1, fx.file('b.jsonl'), null])}\n[${gen}, "${fx.file('b.jsonl')}"`);
  const rec = recordingFs();
  const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs });
  const warm = await restarted.scan();
  assert.deepEqual(rec.log.opened, [], 'every file is current from the cache and its journal');
  assert.deepEqual(warm.records.toRecords().map((r) => r.key).sort(), ['m1:req', 'm2:req', 'm4:req']);
});

test('a save after a journal line cut short starts a new line', async (t) => {
  const fx = await fixture(t);
  const journal = `${fx.cacheFile}.journal`;
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  await fsp.writeFile(fx.file('b.jsonl'), lines(claudeLine({ id: 'm2' })));
  const first = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  await first.scan();
  await first.flush();
  const { gen } = JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8'));
  await fsp.writeFile(journal, `[${gen}, "${fx.file('b.jsonl')}"`);

  const second = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  await second.scan();
  await fsp.appendFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm3' })));
  assert.equal((await second.scan({ force: true })).records.length, 3);
  await second.flush();

  // The line for a.jsonl must parse on its own, so a restart starts from it and reads nothing.
  const rec = recordingFs();
  const third = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs });
  const warm = await third.scan();
  assert.deepEqual(rec.log.opened, []);
  assert.deepEqual(warm.records.toRecords().map((r) => r.key).sort(), ['m1:req', 'm2:req', 'm3:req']);
});

test('a save during a tail read stores an offset that matches the parser state', async (t) => {
  const fx = await fixture(t);
  const codexFile = path.join(fx.codex, 'sessions', 'rollout-7.jsonl');
  await fsp.writeFile(codexFile, lines(codexMeta('/w/x'), codexUsage(1)));
  // Codex turns without a running total have no dedupe key, so reading one twice counts it twice.
  let hold = null;
  const rec = recordingFs();
  const fs = {
    ...rec.fs,
    async open(file, flags) {
      const handle = await rec.fs.open(file, flags);
      return {
        read: handle.read,
        close: async () => {
          const h = hold;
          hold = null;
          await h?.();
          return handle.close();
        },
      };
    },
  };
  const opts = { env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs, threads: 0 };
  const outputs = (result) => result.records.toRecords().map((r) => r.output);
  const a = createScanner(opts);
  await a.scan();
  await a.flush();
  await fsp.appendFile(codexFile, lines(codexUsage(2)));
  await a.scan({ force: true });
  await fsp.appendFile(codexFile, lines(codexUsage(3)));
  hold = () => a.flush(); // the timed save lands after the tail's push, before the scan stores it
  assert.deepEqual(outputs(await a.scan({ force: true })), [1, 2, 3]);
  const b = createScanner(opts);
  assert.deepEqual(outputs(await b.scan()), [1, 2, 3]);
});

test('a reset, or more changed files than the journal takes, rewrites the cache file', async (t) => {
  const fx = await fixture(t);
  const journal = `${fx.cacheFile}.journal`;
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  let clock = 1_000_000;
  const scanner = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, now: () => clock });
  await scanner.scan();
  await scanner.flush();
  const first = JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8')).gen;

  await fsp.appendFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm2' })));
  clock += 6_000;
  await scanner.scan();
  await scanner.flush();
  await fsp.stat(journal);

  scanner.reset();
  await scanner.scan();
  await scanner.flush();
  const second = JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8'));
  assert.notEqual(second.gen, first);
  assert.equal(Object.keys(second.files).length, 1);
  await assert.rejects(fsp.stat(journal), { code: 'ENOENT' });

  for (let i = 0; i < 513; i++) await fsp.writeFile(fx.file(`n${i}.jsonl`), lines(claudeLine({ id: `n${i}` })));
  clock += 6_000;
  await scanner.scan();
  await scanner.flush();
  const third = JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8'));
  assert.notEqual(third.gen, second.gen);
  assert.equal(Object.keys(third.files).length, 514);
  await assert.rejects(fsp.stat(journal), { code: 'ENOENT' });
});

test('symlinked directories are not followed and .jsonl matches case-insensitively', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('UPPER.JSONL'), lines(claudeLine({ id: 'm1' })));
  const outside = path.join(fx.base, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'x.jsonl'), lines(claudeLine({ id: 'x1' })));
  try {
    await fsp.symlink(outside, fx.file('linked'), 'dir');
    await fsp.symlink(path.join(fx.claude, 'projects'), path.join(fx.claude, 'projects', 'loop'), 'dir');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }
  const result = await createScanner({ env: fx.env, home: fx.base }).scan();
  assert.equal(result.files, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.errors, 0);
});

test('directories are listed with withFileTypes and missing roots are not errors', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const rec = recordingFs();
  const result = await createScanner({ env: fx.env, home: fx.base, fs: rec.fs }).scan();
  assert.ok(rec.log.readdir.length > 0);
  assert.ok(rec.log.readdir.every((options) => options?.withFileTypes === true));
  assert.equal(result.errors, 0);

  const none = await createScanner({
    env: { CLAUDE_CONFIG_DIR: path.join(fx.base, 'no-claude'), CODEX_HOME: path.join(fx.base, 'no-codex') },
    home: fx.base,
  }).scan();
  assert.deepEqual([none.files, none.errors, none.records.length], [0, 0, 0]);
});

test('context falls back to parent directory and file name, and archived codex sessions are scanned', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('sess-42.jsonl'), lines(claudeLine({ id: 'm1' })));
  const archived = path.join(fx.codex, 'archived_sessions');
  await fsp.mkdir(archived, { recursive: true });
  await fsp.writeFile(path.join(archived, 'rollout-old.jsonl'), lines(codexMeta('/w/demo'), codexTurn('gpt-5-codex'), codexUsage(5)));

  const result = await createScanner({ env: fx.env, home: fx.base }).scan();
  assert.equal(result.records.length, 2);
  const claude = result.records.toRecords().find((r) => r.provider === 'claude');
  assert.equal(claude.project, 'proj-a');
  assert.equal(claude.sessionId, 'sess-42');
  assert.equal(claude.cwd, '');
  const codex = result.records.toRecords().find((r) => r.provider === 'codex');
  assert.equal(codex.project, 'demo');
  assert.equal(codex.cwd, '/w/demo');
  assert.deepEqual([claude.host, codex.host], ['local', 'local']);
});

test('bounded concurrency: at most 8 files are open at once', async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 30; i++) {
    await fsp.writeFile(fx.file(`f${i}.jsonl`), lines(claudeLine({ id: `m${i}` })));
  }
  let active = 0;
  let peak = 0;
  const rec = recordingFs({
    open: async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
    },
  });
  const result = await createScanner({ env: fx.env, home: fx.base, fs: rec.fs }).scan();
  assert.equal(result.records.length, 30);
  assert.equal(peak, 8);
});

test('a message copied into a resumed session is counted once, at its earliest timestamp', async (t) => {
  const fx = await fixture(t);
  // The later copy is in the file walked first, so the earliest timestamp has to win on merit.
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1', ts: '2026-10-02T10:00:00.000Z', output: 7 }), claudeLine({ id: undefined, output: 4 })));
  const resumed = path.join(fx.claude, 'projects', 'proj-b');
  await fsp.mkdir(resumed, { recursive: true });
  await fsp.writeFile(path.join(resumed, 'b.jsonl'), lines(claudeLine({ id: 'm1', ts: T, output: 7 }), claudeLine({ id: undefined, output: 4 })));

  const result = await createScanner({ env: fx.env, home: fx.base }).scan();
  const m1 = result.records.toRecords().filter((r) => r.key === 'm1:req');
  assert.equal(m1.length, 1);
  assert.equal(m1[0].ts, T);
  // m1 once, plus one keyless record from each file, which are never deduped.
  assert.equal(result.records.length, 3);
});

test('a projects dir reached through a symlink is listed and scanned once', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const second = path.join(fx.base, 'second');
  await fsp.mkdir(second);
  try {
    await fsp.symlink(path.join(fx.claude, 'projects'), path.join(second, 'projects'), 'dir');
    await fsp.symlink(fx.file('a.jsonl'), fx.file('alias.jsonl'), 'file');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }

  // Two roots where one's projects dir is the other's: the same file is reached by two paths.
  const both = await createScanner({ env: { CLAUDE_CONFIG_DIR: `${fx.claude},${second}`, CODEX_HOME: fx.codex }, home: fx.base }).scan();
  assert.equal(both.files, 1);
  assert.equal(both.records.length, 1);

  // A symlinked top-level projects dir under the only root is still walked.
  const only = await createScanner({ env: { CLAUDE_CONFIG_DIR: second, CODEX_HOME: fx.codex }, home: fx.base }).scan();
  assert.equal(only.files, 1);
  assert.equal(only.records.length, 1);
  assert.equal(only.errors, 0);
});

test('a directory that fails to read keeps the cached records under it and counts one error', async (t) => {
  for (const failing of ['projects', 'proj-a']) {
    const fx = await fixture(t);
    await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' })));
    const dirs = { projects: path.join(fx.claude, 'projects'), 'proj-a': fx.file() };
    let broken = false;
    let clock = 1_000_000;
    const rec = recordingFs({
      readdir: (dir) => {
        if (broken && dir === dirs[failing]) throw Object.assign(new Error('io'), { code: 'EIO' });
      },
    });
    const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
    assert.equal((await scanner.scan()).records.length, 2);

    broken = true;
    clock += 6_000;
    const result = await scanner.scan();
    assert.equal(result.records.length, 2, `${failing}: cached records kept`);
    assert.equal(result.errors, 1, `${failing}: error counted`);
    assert.equal(result.changed, false, `${failing}: nothing marked changed`);
  }
});

test('a directory that is removed drops its cached records without an error', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  let clock = 1_000_000;
  const scanner = createScanner({ env: fx.env, home: fx.base, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 1);

  await fsp.rm(fx.file(), { recursive: true });
  clock += 6_000;
  const result = await scanner.scan();
  assert.deepEqual([result.records.length, result.errors], [0, 0]);
});

test('a restarted codex tail skips a token_count that repeats the stored total', async (t) => {
  const fx = await fixture(t);
  const codexFile = path.join(fx.codex, 'sessions', 'rollout-10.jsonl');
  const total = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 107 };
  const event = JSON.stringify({
    type: 'event_msg',
    timestamp: T,
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } } },
  });
  await fsp.writeFile(codexFile, lines(codexMeta('/w/delta'), codexTurn('gpt-5-codex'), event));
  const cold = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  assert.equal((await cold.scan()).records.length, 1);
  await cold.flush();

  // Codex writes the same running total again, for example after a rate-limit update.
  await fsp.appendFile(codexFile, lines(event));
  const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
  const result = await restarted.scan();
  await restarted.flush();
  assert.equal(result.records.length, 1);
});

test('a file truncated and regrown past its old size is re-read whole', async (t) => {
  const fx = await fixture(t);
  const before = lines(claudeLine({ id: 'm1' }), claudeLine({ id: 'm2' }));
  await fsp.writeFile(fx.file('s.jsonl'), before);
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 2);

  // Rewritten in place and longer than before, so the size check alone would tail from the
  // stored offset. That offset lands inside a long string value, not after an LF.
  const after = lines(claudeLine({ id: 'fresh', sessionId: 'x'.repeat(Buffer.byteLength(before)) }));
  await fsp.writeFile(fx.file('s.jsonl'), after);
  clock += 6_000;
  rec.log.clear();
  const result = await scanner.scan();
  assert.deepEqual(result.records.toRecords().map((r) => r.key), ['fresh:req']);
  assert.equal(rec.log.reads.at(-1).pos, 0);
});

test('scan({ force: true }) skips the 5 s reuse but reads only changed files', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-force-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const proj = path.join(dir, '.claude', 'projects', 'p');
  await fsp.mkdir(proj, { recursive: true });
  const line = (id) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: 's', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } }, requestId: 'r' }) + '\n'
  await fsp.writeFile(path.join(proj, 'a.jsonl'), line('m1'))
  await fsp.writeFile(path.join(proj, 'b.jsonl'), line('m2'))
  let opens = 0
  const fs = { ...fsp, open: (...a) => { opens++; return fsp.open(...a) } }
  const scanner = createScanner({ home: dir, env: {}, fs, cacheFile: path.join(dir, 'cache.json') })
  assert.equal((await scanner.scan()).records.length, 2)
  await fsp.appendFile(path.join(proj, 'a.jsonl'), line('m3'))
  assert.equal((await scanner.scan()).records.length, 2, 'reuse window hides the new line')
  opens = 0
  const forced = await scanner.scan({ force: true })
  assert.equal(forced.records.length, 3)
  assert.equal(opens, 1, 'only the changed file is opened')
  await scanner.flush()
})

test('markedLines decodes only marker lines, in file order, and handles edges', async () => {
  const { markedLines } = await import('../src/node/scan.mjs')
  const buf = Buffer.from('a "usage" 1\nplain\r\nb turn_context\nc token_count "usage"\n"usage" last\n')
  const out = markedLines(buf, buf.length, [Buffer.from('"usage"'), Buffer.from('turn_context'), Buffer.from('token_count')])
  assert.equal(out, 'a "usage" 1\nb turn_context\nc token_count "usage"\n"usage" last\n')
  assert.equal(markedLines(buf, buf.length, [Buffer.from('nope')]), '')
  const crlf = Buffer.from('x "usage"\r\ny\r\n')
  assert.equal(markedLines(crlf, crlf.length, [Buffer.from('"usage"')]), 'x "usage"\r\n')
  const multi = Buffer.from('é "usage" 界\n')
  assert.equal(markedLines(multi, multi.length, [Buffer.from('"usage"')]), 'é "usage" 界\n')
})

test('parse threads give the same records and tail state as parsing inline', async (t) => {
  const fx = await fixture(t);
  const body = [];
  for (let i = 0; i < 3000; i++) body.push(claudeLine({ id: `m${i % 2500}`, sessionId: 's1' }));
  await fsp.writeFile(fx.file('a.jsonl'), lines(...body));
  await fsp.writeFile(fx.file('b.jsonl'), lines(claudeLine({ id: 'x1' }), 'not json', claudeLine({ id: 'x2' })));
  const inline = createScanner({ env: fx.env, home: fx.base, threads: 0 });
  const threaded = createScanner({ env: fx.env, home: fx.base, threads: 2 });
  t.after(() => threaded.close());
  const norm = (r) => JSON.stringify(r.records.toRecords().sort((a, b) => (a.key < b.key ? -1 : 1)));
  const a = await inline.scan();
  const b = await threaded.scan();
  assert.equal(b.records.length, 2502);
  assert.equal(norm(a), norm(b));
  // A tail read after a threaded first read resumes from the thread's state (dedupe included).
  await fsp.appendFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1', sessionId: 's1' }), claudeLine({ id: 'new', sessionId: 's1' })));
  const c = await threaded.scan({ force: true });
  assert.equal(c.records.length, 2503);
});

test('an extra Claude folder that holds projects is read through projects only, like a default root', async (t) => {
  const fx = await fixture(t);
  const backup = path.join(fx.base, 'backup-claude');
  await fsp.mkdir(path.join(backup, 'projects', 'old-proj'), { recursive: true });
  await fsp.writeFile(path.join(backup, 'projects', 'old-proj', 'old.jsonl'), lines(claudeLine({ id: 'b1' })));
  await fsp.writeFile(path.join(backup, 'stray.jsonl'), lines(claudeLine({ id: 'b2' })));
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: [backup], codex: [] });
  const result = await scanner.scan();
  assert.equal(result.records.length, 2, 'the default file and projects/old-proj/old.jsonl; stray.jsonl is not read');
  assert.equal(result.files, 2);
  assert.deepEqual(result.folders, [{ path: backup, kind: 'claude', state: 'ok', files: 1, records: 1 }]);
});

test('an extra folder without the provider subdir is walked whole for transcripts of its kind', async (t) => {
  const fx = await fixture(t);
  const backup = path.join(fx.base, 'backup-codex');
  await fsp.mkdir(path.join(backup, 'deep'), { recursive: true });
  await fsp.writeFile(path.join(backup, 'deep', 'rollout-x.jsonl'), lines(codexMeta('/w/x'), codexTurn('gpt-5-codex'), codexUsage(7)));
  await fsp.writeFile(path.join(backup, 'notes.txt'), 'not a transcript');
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: [], codex: [backup] });
  const result = await scanner.scan();
  const codex = result.records.toRecords().filter((r) => r.provider === 'codex');
  assert.equal(codex.length, 1);
  assert.equal(codex[0].project, 'x', 'codex project comes from session_meta cwd');
  assert.deepEqual(result.folders, [{ path: backup, kind: 'codex', state: 'ok', files: 1, records: 1 }]);
});

test('an extra Codex folder with sessions reads sessions and archived_sessions, not loose files', async (t) => {
  const fx = await fixture(t);
  const backup = path.join(fx.base, 'codex-copy');
  await fsp.mkdir(path.join(backup, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(backup, 'archived_sessions'), { recursive: true });
  await fsp.writeFile(path.join(backup, 'sessions', 'a.jsonl'), lines(codexMeta('/w/a'), codexTurn('gpt-5-codex'), codexUsage(5)));
  await fsp.writeFile(path.join(backup, 'archived_sessions', 'b.jsonl'), lines(codexMeta('/w/b'), codexTurn('gpt-5-codex'), codexUsage(6)));
  await fsp.writeFile(path.join(backup, 'loose.jsonl'), lines(codexUsage(9)));
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: [], codex: [backup] });
  const result = await scanner.scan();
  assert.deepEqual(result.records.toRecords().map((r) => r.output).sort((a, b) => a - b), [5, 6]);
  assert.deepEqual(result.folders, [{ path: backup, kind: 'codex', state: 'ok', files: 2, records: 2 }]);
});

test('a missing extra folder is a warning with no error and no records', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const missing = path.join(fx.base, 'never-there');
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: [missing], codex: [] });
  const result = await scanner.scan();
  assert.equal(result.errors, 0);
  assert.equal(result.records.length, 1, 'only the default root contributes');
  assert.deepEqual(result.folders, [{ path: missing, kind: 'claude', state: 'warning', files: 0, records: 0, message: 'Folder not found' }]);
});

test('an extra folder path that names a file is a warning, not a read error', async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.base, 'plain.txt');
  await fsp.writeFile(file, 'hello');
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: [file], codex: [] });
  const result = await scanner.scan();
  assert.equal(result.errors, 0);
  assert.deepEqual(result.folders, [{ path: file, kind: 'claude', state: 'warning', files: 0, records: 0, message: 'Not a folder' }]);
});

test('an extra folder that is a default root is counted once, through its symlink too', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const link = path.join(fx.base, 'claude-link');
  let linked = true;
  try {
    await fsp.symlink(fx.claude, link, 'dir');
  } catch (error) {
    linked = false;
    t.diagnostic(`symlink unavailable: ${error.code}`);
  }
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: linked ? [fx.claude, link] : [fx.claude], codex: [fx.codex] });
  const result = await scanner.scan();
  assert.equal(result.records.length, 1, 'the one transcript is counted once');
  assert.equal(result.files, 1);
  const expected = [['claude', 'ok', 1, 0], ['codex', 'ok', 0, 0]];
  if (linked) expected.splice(1, 0, ['claude', 'ok', 1, 0]);
  assert.deepEqual(result.folders.map((f) => [f.kind, f.state, f.files, f.records]), expected);
});

test('an unchanged extra folder costs one stat per file and no reads on a warm rescan', async (t) => {
  const fx = await fixture(t);
  const backup = path.join(fx.base, 'backup');
  await fsp.mkdir(path.join(backup, 'projects', 'p'), { recursive: true });
  await fsp.writeFile(path.join(backup, 'projects', 'p', 'x.jsonl'), lines(claudeLine({ id: 'x1' }), claudeLine({ id: 'x2' })));
  let clock = 1_000_000;
  const rec = recordingFs();
  const scanner = createScanner({ env: fx.env, home: fx.base, fs: rec.fs, now: () => clock });
  scanner.setExtraRoots({ claude: [backup], codex: [] });
  assert.equal((await scanner.scan()).records.length, 2);
  clock += 6_000;
  rec.log.clear();
  assert.equal((await scanner.scan()).records.length, 2);
  assert.deepEqual(rec.log.opened, []);
  assert.deepEqual(rec.log.reads, []);
});

test('changing the extra folders drops the 5 s reuse window, and the same folders keep it', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const backup = path.join(fx.base, 'later');
  await fsp.mkdir(path.join(backup, 'projects', 'x'), { recursive: true });
  let clock = 1_000_000;
  const scanner = createScanner({ env: fx.env, home: fx.base, now: () => clock });
  assert.equal((await scanner.scan()).records.length, 1);

  await fsp.writeFile(path.join(backup, 'projects', 'x', 'b.jsonl'), lines(claudeLine({ id: 'm2' })));
  scanner.setExtraRoots({ claude: [backup], codex: [] });
  assert.equal((await scanner.scan()).records.length, 2, 'the new folder is read at once, inside the reuse window');

  await fsp.writeFile(path.join(backup, 'projects', 'x', 'c.jsonl'), lines(claudeLine({ id: 'm3' })));
  scanner.setExtraRoots({ claude: [backup], codex: [] });
  assert.equal((await scanner.scan()).records.length, 2, 'the same folders keep the reuse window');
});

test('removing an extra folder drops its records on the next scan', async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1' })));
  const backup = path.join(fx.base, 'gone-soon');
  await fsp.mkdir(path.join(backup, 'projects', 'x'), { recursive: true });
  await fsp.writeFile(path.join(backup, 'projects', 'x', 'b.jsonl'), lines(claudeLine({ id: 'm2' }), claudeLine({ id: 'm3' })));
  const scanner = createScanner({ env: fx.env, home: fx.base });
  scanner.setExtraRoots({ claude: [backup], codex: [] });
  assert.equal((await scanner.scan()).records.length, 3);
  scanner.setExtraRoots({ claude: [], codex: [] });
  const after = await scanner.scan();
  assert.equal(after.records.length, 1);
  assert.deepEqual(after.folders, []);
});

// fixtures/codex.jsonl.zst is codex.jsonl compressed with zlib.zstdCompressSync.
test('a codex .zst rollout gives the same records as the plain .jsonl, inline and on a parse thread', { skip: zstdAvailable() ? false : 'Node has no zlib.zstdCompressSync, so the .zst scan cannot run here' }, async (t) => {
  const fx = await fixture(t);
  const packed = await fsp.readFile(new URL('./fixtures/codex.jsonl.zst', import.meta.url));
  const zst = path.join(fx.codex, 'sessions', 'rollout-z.jsonl.zst');
  const jsonl = path.join(fx.codex, 'sessions', 'rollout-z.jsonl');
  await fsp.writeFile(zst, packed);
  const inline = createScanner({ env: fx.env, home: fx.base, threads: 0 });
  const threaded = createScanner({ env: fx.env, home: fx.base, threads: 2 });
  t.after(() => Promise.all([inline.close(), threaded.close()]));
  const fromInline = await inline.scan();
  const fromThread = await threaded.scan();

  await fsp.rm(zst);
  await fsp.copyFile(new URL('./fixtures/codex.jsonl', import.meta.url), jsonl);
  const plain = await createScanner({ env: fx.env, home: fx.base, threads: 0 }).scan();

  assert.ok(plain.records.length > 0);
  assert.deepEqual(fromInline.records.toRecords(), plain.records.toRecords());
  assert.deepEqual(fromThread.records.toRecords(), plain.records.toRecords());
  assert.deepEqual(fromInline.skipped, { zstd: 0, tooLarge: 0 });
  assert.deepEqual(fromThread.skipped, { zstd: 0, tooLarge: 0 });
});

async function writeLegacyCache(fromFile, legacyFile) {
  const { packRecords } = await import('./legacy-records.mjs');
  const { decodeTable } = await import('../src/core/table-codec.mjs');
  const current = JSON.parse(await fsp.readFile(fromFile, 'utf8'));
  const files = {};
  for (const [file, entry] of Object.entries(current.files)) {
    const { table, ...rest } = entry.state;
    files[file] = { ...entry, state: { ...rest, packed: packRecords(decodeTable(table).toRecords()), keys: [], anonymous: 0 } };
  }
  await fsp.writeFile(legacyFile, JSON.stringify({ version: 4, files }));
}

for (const version of [4, 5]) {
  test(`a version ${version} cache carries Claude files over unread, rereads Codex files, and is left in place`, async (t) => {
    const fx = await fixture(t);
    const codexFile = path.join(fx.codex, 'sessions', 'rollout-5.jsonl');
    await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1', cwd: '/w/alpha' }), claudeLine({ id: 'm2', output: 20 })));
    await fsp.writeFile(codexFile, lines(codexMeta('/w/beta'), codexTurn('gpt-5-codex'), codexUsage(7)));
    const legacyFile = path.join(path.dirname(fx.cacheFile), `scan-cache-v${version}.json`);
    const first = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile });
    await first.scan();
    await first.flush();
    if (version === 4) await writeLegacyCache(fx.cacheFile, legacyFile);
    else await fsp.writeFile(legacyFile, JSON.stringify({ ...JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8')), version: 5 }));
    const legacyBody = await fsp.readFile(legacyFile, 'utf8');
    await fsp.rm(fx.cacheFile);

    await fsp.appendFile(codexFile, lines(codexUsage(11)));
    const fresh = (await createScanner({ env: fx.env, home: fx.base, cacheFile: null }).scan()).records.toRecords();
    const rec = recordingFs();
    const missing = path.join(path.dirname(fx.cacheFile), 'scan-cache-missing.json');
    const migrated = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, legacyCacheFile: [missing, legacyFile], fs: rec.fs });
    const warm = await migrated.scan();
    assert.deepEqual(rec.log.opened, [codexFile], 'only the Codex file is read');
    assert.deepEqual(warm.records.toRecords(), fresh);
    await migrated.flush();
    assert.equal(JSON.parse(await fsp.readFile(fx.cacheFile, 'utf8')).version, 6);
    assert.equal(await fsp.readFile(legacyFile, 'utf8'), legacyBody);

    const rec2 = recordingFs();
    const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, legacyCacheFile: legacyFile, fs: rec2.fs });
    assert.deepEqual((await restarted.scan()).records.toRecords(), warm.records.toRecords());
    assert.deepEqual(rec2.log.opened, [], 'the current cache covers every file');
    assert.deepEqual(rec2.log.readFile, [fx.cacheFile, `${fx.cacheFile}.journal`], 'the current cache wins; the old one is not read');
  });
}

test('a .zst that decompresses past the cap is not decompressed again after a restart', { skip: !zstdAvailable() && 'Node has no zstd' }, async (t) => {
  const fx = await fixture(t);
  const { zstdCompressSync } = await import('node:zlib');
  const { TOO_LARGE } = await import('../src/node/zstd.mjs');
  const big = path.join(fx.codex, 'sessions', 'rollout-big.jsonl.zst');
  await fsp.writeFile(big, zstdCompressSync(Buffer.from('\n')));
  await fsp.writeFile(fx.file('a.jsonl'), lines(claudeLine({ id: 'm1', cwd: '/w/alpha' })));
  // Reading the file fails the way decompressing past the 768 MiB cap does.
  const capped = {
    ...fsp,
    async open(file, flags) {
      const handle = await fsp.open(file, flags);
      if (file !== big) return handle;
      return { read: async () => { throw new Error(TOO_LARGE); }, close: () => handle.close() };
    },
  };
  const first = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: capped, threads: 0 });
  const cold = await first.scan();
  assert.equal(cold.skipped.tooLarge, 1);
  await first.flush();

  const rec = recordingFs();
  const restarted = createScanner({ env: fx.env, home: fx.base, cacheFile: fx.cacheFile, fs: rec.fs, threads: 0 });
  const warm = await restarted.scan();
  assert.deepEqual(rec.log.opened, [], 'nothing is opened, the oversized file included');
  assert.equal(warm.skipped.tooLarge, 1);
  assert.deepEqual(warm.records.toRecords(), cold.records.toRecords());
});
