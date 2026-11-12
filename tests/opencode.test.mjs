import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findOpencodeDbs, modelKey, opencodeKey, readOpencodeDb } from '../src/node/opencode-db.mjs';
import { createScanner } from '../src/node/scan.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}
const sqliteTest = DatabaseSync
  ? test
  : (name, fn) => test(name, { skip: 'node:sqlite unavailable' }, fn);

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const TS = new Date(T0).toISOString();

async function temp(t) {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-opencode-')));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  return base;
}

// A quick update and close can land in the filesystem's mtime tick. Move it so the scanner's stat key
// always changes, as it would for a real database written by OpenCode.
async function bumpMtime(file) {
  const at = new Date(Date.now() + 3_600_000);
  await fsp.utimes(file, at, at);
}

function exec(db, sql, ...values) {
  db.prepare(sql).run(...values);
}

function createV2(file, { sessions = [], messages = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, model TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  for (const s of sessions) {
    exec(db, 'INSERT INTO session_v2 (id, directory, parent_id, fork_session_id, time_created, time_updated, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
      s.id, s.directory, s.parentId ?? null, s.forkSessionId ?? null, s.timeCreated ?? T0, s.timeUpdated ?? T0, null);
  }
  let seq = 0;
  for (const m of messages) {
    exec(db, 'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      m.id, m.sessionId, m.type ?? 'assistant', seq++, m.timeCreated ?? T0, T0, JSON.stringify(m.data));
  }
  db.close();
}

function createV1(file, { sessions = [], messages = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  for (const s of sessions) {
    exec(db, 'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)', s.id, s.directory, T0, T0);
  }
  for (const m of messages) {
    exec(db, 'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
      m.id, m.sessionId, m.timeCreated ?? T0, T0, JSON.stringify(m.data));
  }
  db.close();
}

const v2Message = ({ id, sessionId = 's1', timeCreated, model = 'deepseek-v4.1-flash', providerID = 'opencode-go', input = 100, output = 20, reasoning = 5, read = 50, write = 10 } = {}) => ({
  id,
  sessionId,
  ...(timeCreated === undefined ? {} : { timeCreated }),
  data: {
    model: { id: model, providerID, variant: 'high' },
    tokens: { input, output, reasoning, cache: { read, write } },
    cost: 0,
  },
});

const byKey = (table) => new Map(table.toRecords().map((record) => [record.key, record]));

sqliteTest('reads v2 assistant messages, keeps reasoning in output and qualifies the channel', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'opencode.db');
  createV2(file, {
    sessions: [{ id: 's1', directory: 'C:/work/alpha' }],
    messages: [
      v2Message({ id: 'm1' }),
      { id: 'm2', sessionId: 's1', type: 'user', data: {} },
      { id: 'm3', sessionId: 's1', data: { model: { id: 'x', providerID: 'opencode' } } },
      v2Message({ id: 'm4', model: 'anthropic/claude-opus-4.8', providerID: 'vercel', reasoning: 0, write: 0 }),
    ],
  });

  const result = await readOpencodeDb({ fs: fsp, path: file });
  assert.equal(result.status, 'ok');
  const records = byKey(result.table);
  assert.equal(records.size, 2);

  assert.deepEqual(records.get('opencode:m1'), {
    key: 'opencode:m1',
    provider: 'opencode',
    ts: TS,
    model: 'opencode-go/deepseek-v4.1-flash',
    project: 'alpha',
    sessionId: 's1',
    input: 100,
    output: 25,
    cacheRead: 50,
    cacheWrite: 10,
    cacheWrite1h: 0,
    cwd: 'C:/work/alpha',
    host: 'local',
  });
  assert.equal(records.get('opencode:m4').model, 'anthropic/claude-opus-4.8', 'other providers keep their id');
});

sqliteTest('a forked session skips messages copied from before the fork', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'opencode.db');
  const forkAt = T0 + 10_000;
  createV2(file, {
    sessions: [
      { id: 'parent', directory: '/w/p' },
      { id: 'child', directory: '/w/p', forkSessionId: 'parent', timeCreated: forkAt },
    ],
    messages: [
      v2Message({ id: 'old', sessionId: 'child', timeCreated: forkAt - 1 }),
      v2Message({ id: 'new', sessionId: 'child', timeCreated: forkAt + 1 }),
      v2Message({ id: 'parent-turn', sessionId: 'parent' }),
    ],
  });
  const records = byKey((await readOpencodeDb({ fs: fsp, path: file })).table);
  assert.deepEqual([...records.keys()].sort(), ['opencode:new', 'opencode:parent-turn']);
});

sqliteTest('v2 wins when both table sets exist, so upgraded v1 rows are not counted twice', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'opencode.db');
  createV2(file, { sessions: [{ id: 's1', directory: '/w/a' }], messages: [] });
  // Add the v1 tables the same upgrade leaves behind.
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  exec(db, 'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)', 's1', '/w/a', T0, T0);
  exec(db, 'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)', 'old', 's1', T0, T0,
    JSON.stringify({ role: 'assistant', modelID: 'deepseek-v4-flash', providerID: 'opencode-go', tokens: { input: 1, output: 1 } }));
  db.close();

  assert.equal((await readOpencodeDb({ fs: fsp, path: file })).table.length, 0);
});

sqliteTest('falls back to the v1 tables on an install that has not upgraded', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'opencode.db');
  createV1(file, {
    sessions: [{ id: 's1', directory: '/w/beta' }],
    messages: [{
      id: 'm1',
      sessionId: 's1',
      data: {
        role: 'assistant',
        modelID: 'deepseek-v4-flash',
        providerID: 'opencode-go',
        path: { cwd: '/w/beta/sub' },
        tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 4, write: 0 } },
      },
    }],
  });
  const records = byKey((await readOpencodeDb({ fs: fsp, path: file })).table);
  assert.deepEqual(records.get('opencode:m1'), {
    key: 'opencode:m1',
    provider: 'opencode',
    ts: TS,
    model: 'opencode-go/deepseek-v4-flash',
    project: 'sub',
    sessionId: 's1',
    input: 7,
    output: 5,
    cacheRead: 4,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cwd: '/w/beta/sub',
    host: 'local',
  });
});

sqliteTest('finds the stable and channel databases, and honours OPENCODE_DB', async (t) => {
  const base = await temp(t);
  const dir = path.join(base, 'opencode');
  await fsp.mkdir(dir, { recursive: true });
  for (const name of ['opencode-dev.db', 'opencode.db', 'opencode.db-wal', 'other.json']) {
    await fsp.writeFile(path.join(dir, name), '');
  }
  const found = await findOpencodeDbs({ fs: fsp, env: { XDG_DATA_HOME: base }, home: base, platform: process.platform });
  assert.equal(found.missing, false);
  assert.deepEqual(found.dbs.map((db) => path.basename(db.path)), ['opencode.db', 'opencode-dev.db']);

  const relative = await findOpencodeDbs({ fs: fsp, env: { XDG_DATA_HOME: base, OPENCODE_DB: 'custom.db' }, home: base });
  assert.deepEqual(relative.dbs, [{ path: path.join(dir, 'custom.db'), source: 'environment' }]);

  const absolute = path.join(base, 'elsewhere.db');
  const full = await findOpencodeDbs({ fs: fsp, env: { OPENCODE_DB: absolute }, home: base });
  assert.deepEqual(full.dbs, [{ path: absolute, source: 'environment' }]);

  const memory = await findOpencodeDbs({ fs: fsp, env: { OPENCODE_DB: ':memory:' }, home: base });
  assert.deepEqual(memory.dbs, []);
});

test('modelKey only qualifies the OpenCode channels', () => {
  assert.equal(modelKey('opencode', 'glm-5.2'), 'opencode/glm-5.2');
  assert.equal(modelKey('opencode-go', 'glm-5.2'), 'opencode-go/glm-5.2');
  assert.equal(modelKey('vercel', 'anthropic/claude-opus-4.8'), 'anthropic/claude-opus-4.8');
  assert.equal(modelKey(undefined, undefined), 'unknown');
});

sqliteTest('the scanner includes the OpenCode database and reads it again only when it changes', async (t) => {
  const base = await temp(t);
  const dir = path.join(base, '.local', 'share', 'opencode');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'opencode.db');
  createV2(file, {
    sessions: [{ id: 's1', directory: '/w/gamma' }],
    messages: [v2Message({ id: 'm1' })],
  });

  let clock = 1_000_000;
  const scanner = createScanner({ home: base, env: {}, now: () => clock, threads: 0 });
  const first = await scanner.scan();
  assert.equal(first.records.length, 1);
  assert.equal(first.changed, true);
  assert.equal(first.files, 1);
  const folder = first.folders.find((entry) => entry.kind === 'opencode');
  assert.equal(folder.state, 'ok');
  assert.equal(folder.records, 1);
  assert.equal(folder.latestRecordAt, TS);

  clock += 6_000;
  const second = await scanner.scan();
  assert.equal(second.changed, false);
  assert.equal(second.records, first.records, 'an unchanged database is not read again');

  const db = new DatabaseSync(file);
  exec(db, 'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'm2', 's1', 'assistant', 2, T0 + 2_000, T0, JSON.stringify(v2Message({ id: 'm2' }).data));
  db.close();
  await bumpMtime(file);
  clock += 6_000;
  const fourth = await scanner.scan({ force: true });
  assert.equal(fourth.changed, true);
  assert.equal(fourth.records.length, 2);

  // An ordinary scan after a message is completed updates the row in place instead of re-reading everything.
  const update = new DatabaseSync(file);
  exec(update, 'UPDATE session_message SET time_updated = ?, data = ? WHERE id = ?',
    T0 + 3_000, JSON.stringify(v2Message({ id: 'm1', output: 40 }).data), 'm1');
  update.close();
  await bumpMtime(file);
  clock += 6_000;
  const fifth = await scanner.scan();
  assert.equal(fifth.changed, true);
  assert.equal(fifth.records.length, 2);
  assert.equal(fifth.records.toRecords().find((record) => record.key === 'opencode:m1').output, 45);
});

sqliteTest('a turned-off OpenCode folder leaves its usage out and turning it back on reads no database again', async (t) => {
  const base = await temp(t);
  const dir = path.join(base, '.local', 'share', 'opencode');
  await fsp.mkdir(dir, { recursive: true });
  createV2(path.join(dir, 'opencode.db'), {
    sessions: [{ id: 's1', directory: '/w/delta' }],
    messages: [v2Message({ id: 'm1' })],
  });

  let clock = 1_000_000;
  const scanner = createScanner({ home: base, env: {}, now: () => clock, threads: 0 });
  assert.equal((await scanner.scan()).records.length, 1);

  scanner.setExtraRoots({ disabled: [dir] });
  clock += 6_000;
  const off = await scanner.scan({ force: true });
  assert.equal(off.records.length, 0);
  assert.equal(off.folders.find((entry) => entry.kind === 'opencode').state, 'off');

  scanner.setExtraRoots({ disabled: [] });
  clock += 6_000;
  const on = await scanner.scan({ force: true });
  assert.equal(on.records.length, 1);
});

sqliteTest('an incremental read only queries updated rows, and reset drops deleted ones', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'opencode.db');
  createV2(file, {
    sessions: [{ id: 's1', directory: '/w/inc' }],
    messages: [v2Message({ id: 'm1', output: 20 }), v2Message({ id: 'm2', output: 5 })],
  });

  const first = await readOpencodeDb({ fs: fsp, path: file });
  assert.equal(first.table.length, 2);
  const key = await opencodeKey({ fs: fsp, path: file });

  const db = new DatabaseSync(file);
  exec(db, 'UPDATE session_message SET time_updated = ?, data = ? WHERE id = ?',
    T0 + 5_000, JSON.stringify(v2Message({ id: 'm1', output: 99 }).data), 'm1');
  db.close();

  const second = await readOpencodeDb({ fs: fsp, path: file, key: await opencodeKey({ fs: fsp, path: file }), prior: first });
  assert.equal(second.table, first.table, 'the same table is updated in place');
  assert.equal(second.table.length, 2);
  assert.equal(byKey(second.table).get('opencode:m1').output, 104, 'output includes the reasoning tokens');
  assert.equal(second.cursor, T0 + 5_000);

  const after = new DatabaseSync(file);
  exec(after, 'DELETE FROM session_message WHERE id = ?', 'm1');
  after.close();

  const reset = await readOpencodeDb({ fs: fsp, path: file, key: await opencodeKey({ fs: fsp, path: file }), prior: second, reset: true });
  assert.deepEqual([...byKey(reset.table).keys()], ['opencode:m2']);
});

test('opencodeKey includes the WAL file and is null for a missing database', async (t) => {
  const base = await temp(t);
  const file = path.join(base, 'opencode.db');
  await fsp.writeFile(file, 'db');
  const before = await opencodeKey({ fs: fsp, path: file });
  await fsp.writeFile(`${file}-wal`, 'wal');
  const after = await opencodeKey({ fs: fsp, path: file });
  assert.notEqual(before, after);
  assert.equal(await opencodeKey({ fs: fsp, path: path.join(base, 'nope.db') }), null);
});
