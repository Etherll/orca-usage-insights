import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  antigravityKey,
  findAntigravityDbs,
  parseGenMetadata,
  parseStepTimestampMs,
  parseTrajectoryMeta,
  readAntigravityDb,
} from '../src/node/antigravity-db.mjs';
import { createAntigravitySource } from '../src/node/antigravity-source.mjs';
import { createScanner } from '../src/node/scan.mjs';
import { createAntigravityParser } from '../src/core/records.mjs';
import { createReadParser, parseListing, readScript } from '../src/node/ssh-script.mjs';

const execFileAsync = promisify(execFile);

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}
const sqliteTest = DatabaseSync
  ? test
  : (name, fn) => test(name, { skip: 'node:sqlite unavailable' }, fn);

const T0_SEC = Math.floor(Date.UTC(2026, 10, 26, 18, 0, 0) / 1000);
const T0_MS = T0_SEC * 1000;

async function temp(t) {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-antigravity-')));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  return base;
}

let bumps = 0;
async function bumpMtime(file) {
  const at = new Date(Date.now() + 3_600_000 + ++bumps * 1_000);
  await fsp.utimes(file, at, at);
}

// Minimal protobuf encoder for building realistic test blobs.
function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

function pbVarint(field, n) {
  return Buffer.concat([varint(field * 8), varint(n)]);
}

function pbBytes(field, buf) {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
}

function pbKv(key, value) {
  return Buffer.concat([pbBytes(1, key), pbBytes(2, value)]);
}

function pbTimestamp(seconds, nanos = 0) {
  return Buffer.concat([pbVarint(1, seconds), ...(nanos ? [pbVarint(2, nanos)] : [])]);
}

function makeGenBlob({
  model = 'gemini-4-neon',
  input = 3245,
  output = 1702,
  cacheRead = 248979,
  thinking = 1309,
  textOut = 393,
  requestId = 'req-1',
  cascadeId = 'conv-1',
  stepIndex = 2,
} = {}) {
  const usageParts = [pbVarint(1, 1532)];
  if (input) usageParts.push(pbVarint(2, input));
  if (output) usageParts.push(pbVarint(3, output));
  if (cacheRead) usageParts.push(pbVarint(5, cacheRead));
  if (thinking) usageParts.push(pbVarint(9, thinking));
  if (textOut) usageParts.push(pbVarint(10, textOut));
  const innerParts = [pbBytes(4, Buffer.concat(usageParts))];
  if (model) innerParts.push(pbBytes(19, model));
  if (requestId) innerParts.push(pbBytes(20, pbKv('request_id', requestId)));
  if (cascadeId) innerParts.push(pbBytes(20, pbKv('cascade_id', cascadeId)));
  if (stepIndex >= 0) innerParts.push(pbBytes(20, pbKv('last_step_index', String(stepIndex))));
  return pbBytes(1, Buffer.concat(innerParts));
}

function makeStepMeta(seconds, nanos = 250_000_000) {
  return pbBytes(1, pbTimestamp(seconds, nanos));
}

function makeTrajMeta({ uri = 'file:///Users/alice/my%20project', createdSec = T0_SEC, cascadeId = 'conv-1' } = {}) {
  return Buffer.concat([
    pbBytes(1, pbBytes(1, uri)),
    pbBytes(2, pbTimestamp(createdSec, 0)),
    pbBytes(6, cascadeId),
  ]);
}

function createConvDb(file, { trajMeta = makeTrajMeta(), steps = [], gens = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE trajectory_metadata_blob (id INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
  `);
  if (trajMeta) db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (1, ?)').run(trajMeta);
  for (const s of steps) db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(s.idx, s.metadata);
  for (const g of gens) db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(g.idx, g.data, g.data.length);
  db.close();
}

test('protobuf decoders extract usage, timestamps, and workspace URI and ignore truncated blobs', () => {
  const gen = parseGenMetadata(makeGenBlob({
    model: 'gemini-4-carbon',
    input: 2513,
    output: 0,
    thinking: 300,
    textOut: 99,
    cacheRead: 465076,
    requestId: 'r-42',
    cascadeId: 'c-9',
    stepIndex: 14,
  }));
  assert.deepEqual(gen, {
    model: 'gemini-4-carbon',
    input: 2513,
    output: 399,
    cacheRead: 465076,
    requestId: 'r-42',
    cascadeId: 'c-9',
    stepIndex: 14,
  });

  assert.equal(parseStepTimestampMs(makeStepMeta(T0_SEC, 500_000_000)), T0_MS + 500);

  const traj = parseTrajectoryMeta(makeTrajMeta({ uri: 'file:///Users/alice/my%20repo', createdSec: T0_SEC, cascadeId: 'cid-1' }));
  assert.deepEqual(traj, { cwd: '/Users/alice/my repo', createdMs: T0_MS, cascadeId: 'cid-1' });

  // Truncated/garbage bytes never throw
  assert.equal(parseGenMetadata(new Uint8Array([0x0a, 0xff, 0xff])), null);
  assert.ok(Number.isNaN(parseStepTimestampMs(new Uint8Array([0x0a, 0x05, 0x01]))));
});

sqliteTest('readAntigravityDb reads generations incrementally, skips 0-token aborts, and tracks WAL keys', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'conv-1.db');
  createConvDb(file, {
    steps: [
      { idx: 2, metadata: makeStepMeta(T0_SEC + 10, 0) },
      { idx: 4, metadata: makeStepMeta(T0_SEC + 25, 0) },
    ],
    gens: [
      { idx: 0, data: makeGenBlob({ input: 1000, output: 200, cacheRead: 50_000, requestId: 'req-0', stepIndex: 2 }) },
      // Aborted/cancelled generation with zero tokens -> skipped
      { idx: 1, data: makeGenBlob({ model: '', input: 0, output: 0, cacheRead: 0, thinking: 0, textOut: 0, requestId: 'req-abort', stepIndex: 3 }) },
    ],
  });

  const first = await readAntigravityDb({ fs: fsp, path: file });
  assert.equal(first.status, 'ok');
  assert.equal(first.cursor, 1);
  assert.equal(first.table.length, 1);
  assert.deepEqual(first.table.toRecords()[0], {
    key: 'antigravity:req-0',
    provider: 'antigravity',
    ts: new Date((T0_SEC + 10) * 1000).toISOString(),
    model: 'gemini-4-neon',
    project: 'my project',
    sessionId: 'conv-1',
    input: 1000,
    output: 200,
    cacheRead: 50_000,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cwd: '/Users/alice/my project',
    host: 'local',
  });

  // Append a second generation and read incrementally with prior
  const db = new DatabaseSync(file);
  const blob2 = makeGenBlob({ model: 'gemini-4-carbon', input: 500, output: 120, cacheRead: 80_000, requestId: 'req-2', stepIndex: 4 });
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(2, blob2, blob2.length);
  db.close();
  await bumpMtime(file);

  const key2 = await antigravityKey({ fs: fsp, path: file });
  assert.notEqual(key2, first.key);
  const second = await readAntigravityDb({ fs: fsp, path: file, key: key2, prior: first });
  assert.equal(second.status, 'ok');
  assert.equal(second.cursor, 2);
  assert.equal(second.table.length, 2);
  assert.equal(second.table.toRecords()[1].model, 'gemini-4-carbon');
  assert.equal(second.table.toRecords()[1].ts, new Date((T0_SEC + 25) * 1000).toISOString());
});

sqliteTest('createAntigravitySource and createScanner cache across restarts and honor disabledFolders', async (t) => {
  const base = await temp(t);
  const convDir = path.join(base, '.gemini', 'antigravity-cli', 'conversations');
  await fsp.mkdir(convDir, { recursive: true });
  const dbFile = path.join(convDir, 'conv-1.db');
  createConvDb(dbFile, {
    steps: [{ idx: 2, metadata: makeStepMeta(T0_SEC + 5, 0) }],
    gens: [{ idx: 0, data: makeGenBlob({ input: 400, output: 80, cacheRead: 10_000, requestId: 'r1', stepIndex: 2 }) }],
  });

  const found = await findAntigravityDbs({ fs: fsp, home: base, env: {} });
  assert.equal(found.missing, false);
  assert.equal(found.dbs.length, 1);

  const cacheFile = path.join(base, 'cache', 'scan-cache.json');
  const scanner1 = createScanner({ home: base, env: {}, cacheFile, threads: 0 });
  const run1 = await scanner1.scan();
  const recs1 = run1.records.toRecords();
  assert.equal(recs1.length, 1);
  assert.equal(recs1[0].provider, 'antigravity');
  assert.equal(recs1[0].input, 400);
  const agFolder = run1.folders.find((f) => f.kind === 'antigravity');
  assert.equal(agFolder?.state, 'ok');
  assert.equal(agFolder?.records, 1);
  await scanner1.flush();

  // Turning off the folder leaves its records out without losing the cache
  scanner1.setExtraRoots({ disabled: [convDir] });
  const runOff = await scanner1.scan({ force: true });
  assert.equal(runOff.records.length, 0);
  assert.equal(runOff.folders.find((f) => f.kind === 'antigravity')?.state, 'off');

  // Fresh scanner loads cached table without re-reading unchanged DB
  const scanner2 = createScanner({ home: base, env: {}, cacheFile, threads: 0 });
  const run2 = await scanner2.scan();
  const recs2 = run2.records.toRecords();
  assert.equal(recs2.length, 1);
  assert.equal(recs2[0].key, 'antigravity:r1');

  const agOnly = createAntigravitySource({ home: base, env: {} });
  const res = await agOnly.scan();
  assert.equal(res.files, 1);
  assert.equal(res.sources.length, 1);
});

sqliteTest('SSH readScript decodes Antigravity SQLite DB via python3 and parses into records', async (t) => {
  const base = await temp(t);
  const dbFile = path.join(base, 'remote-conv.db');
  createConvDb(dbFile, {
    trajMeta: makeTrajMeta({ uri: 'file:///srv/work/alpha', createdSec: T0_SEC, cascadeId: 'remote-1' }),
    steps: [{ idx: 2, metadata: makeStepMeta(T0_SEC + 30, 0) }],
    gens: [{ idx: 0, data: makeGenBlob({ model: 'gemini-4-carbon', input: 222, output: 111, cacheRead: 9999, requestId: 'rem-r1', cascadeId: 'remote-1', stepIndex: 2 }) }],
  });

  const listing = parseListing(`\x1eF\tantigravity\t4096\t1795700000\t${dbFile}\n\x1eE\n`);
  assert.equal(listing?.length, 1);
  assert.equal(listing[0].kind, 'antigravity');

  const st = await fsp.stat(dbFile);
  const script = readScript([{ kind: 'antigravity', path: dbFile, offset: 0, size: st.size }]);
  const { stdout } = await execFileAsync('sh', ['-c', script]);

  const parser = createAntigravityParser({ sessionId: 'remote-conv', project: 'conversations', host: 'ssh:iriscore' });
  let doneBytes = null;
  const reader = createReadParser({
    onLines: (_p, text) => parser.push(text),
    onDone: (_p, bytes) => { doneBytes = bytes; },
  });
  reader.push(stdout);
  assert.equal(reader.end(), true);
  assert.ok(doneBytes > 0);

  const recs = parser.records();
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], {
    key: 'antigravity:rem-r1',
    provider: 'antigravity',
    ts: new Date((T0_SEC + 30) * 1000).toISOString(),
    model: 'gemini-4-carbon',
    project: 'alpha',
    sessionId: 'remote-1',
    input: 222,
    output: 111,
    cacheRead: 9999,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cwd: '/srv/work/alpha',
    host: 'ssh:iriscore',
  });
});
