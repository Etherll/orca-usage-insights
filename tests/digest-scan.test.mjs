import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createDigestScanner } from '../src/node/digest-scan.mjs';
import { ROW_WIDTH } from '../src/core/breakdown/digest-rows.mjs';
import { zstdAvailable } from '../src/node/zstd.mjs';

const zstdSkip = zstdAvailable() ? false : 'Node has no zlib.zstdCompressSync, so the .zst transcript cannot be written here';

const fixture = (name) => fsp.readFile(new URL(`./fixtures/${name}`, import.meta.url));

async function home() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'digest-scan-'));
  await fsp.mkdir(path.join(dir, '.claude', 'projects', 'proj'), { recursive: true });
  await fsp.mkdir(path.join(dir, '.codex', 'sessions', '2026', '11', '03'), { recursive: true });
  return dir;
}

// Shard files (one per transcript); a plain file's state sits next to it in <sha1>.state.json.
const shards = async (dir) => (await fsp.readdir(dir)).filter((f) => !f.endsWith('.state.json')).sort();

// The scanner keeps digests packed: ROW_WIDTH numbers per row in one typed array.
const rowsTotal = (d) => {
  assert.ok(ArrayBuffer.isView(d.rows), 'digest rows are packed');
  let total = 0;
  for (let at = 0; at < d.rowCount * ROW_WIDTH; at += ROW_WIDTH) total += d.rows[at + 7] + d.rows[at + 8] + d.rows[at + 9] + d.rows[at + 10] + d.rows[at + 11];
  return total;
};

for (const threads of [0, 2]) {
  test(`digests every transcript, tails a grown file and reuses unchanged ones (threads ${threads})`, { skip: zstdSkip }, async () => {
    const dir = await home();
    const claudeText = await fixture('breakdown-claude.jsonl');
    const codexText = await fixture('breakdown-codex.jsonl');
    const claudeFile = path.join(dir, '.claude', 'projects', 'proj', 'sess-1.jsonl');
    await fsp.writeFile(claudeFile, claudeText);
    await fsp.writeFile(path.join(dir, '.codex', 'sessions', '2026', '11', '03', 'rollout-x.jsonl.zst'), zlib.zstdCompressSync(codexText));
    const cacheDir = path.join(dir, 'cache', 'digests-v1');
    const env = { HOME: dir };
    const scanner = createDigestScanner({ cacheDir, home: dir, env, platform: 'linux', threads });
    try {
      const first = await scanner.scan();
      assert.equal(first.total, 2);
      assert.deepEqual(first.files.map((f) => f.state).sort(), ['ok', 'ok']);
      assert.equal(first.digests.length, 2);
      const codex = first.digests.find((d) => d.compressed);
      assert.equal(codex.digest.harness, 'codex');
      assert.ok(codex.digest.requests > 0);
      const claude = first.digests.find((d) => !d.compressed);
      const before = rowsTotal(claude.digest);
      assert.ok(before > 0);
      assert.equal((await shards(cacheDir)).length, 2, 'one shard per file');
      assert.equal((await fsp.readdir(cacheDir)).length, 3, 'and one state file, for the plain file only');

      // Unchanged: same digest objects come back.
      const again = await scanner.scan();
      assert.equal(again.digests.find((d) => !d.compressed).digest, claude.digest);

      // A fresh scanner reads the shards instead of the files, and tails a grown file.
      const fresh = createDigestScanner({ cacheDir, home: dir, env, platform: 'linux', threads });
      await fsp.appendFile(claudeFile, claudeText);
      const grown = await fresh.scan();
      const d = grown.digests.find((x) => !x.compressed).digest;
      assert.ok(rowsTotal(d) >= before);
      await fresh.close();
      // Tailing from the stored state gives the same digest as reading the grown file whole.
      const whole = createDigestScanner({ cacheDir: null, home: dir, env, platform: 'linux', threads });
      const w = (await whole.scan()).digests.find((x) => !x.compressed).digest;
      await whole.close();
      assert.deepEqual(d, w);

      // A deleted file drops its shard.
      await fsp.rm(claudeFile);
      const gone = await scanner.scan();
      assert.equal(gone.total, 1);
      assert.deepEqual((await fsp.readdir(cacheDir)).length, 1, 'its shard and state are removed');
    } finally {
      await scanner.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
}

test('no transcript text reaches a shard', async () => {
  const dir = await home();
  const text = await fixture('breakdown-claude.jsonl');
  await fsp.writeFile(path.join(dir, '.claude', 'projects', 'proj', 's.jsonl'), text);
  const cacheDir = path.join(dir, 'digests');
  const scanner = createDigestScanner({ cacheDir, home: dir, env: { HOME: dir }, platform: 'linux', threads: 0 });
  try {
    await scanner.scan();
    const names = await fsp.readdir(cacheDir);
    assert.equal(names.length, 2, 'shard and state');
    const body = (await Promise.all(names.map((n) => fsp.readFile(path.join(cacheDir, n), 'utf8')))).join('\n');
    // Every text field in the fixture carries this marker (see tests/events.test.mjs).
    const markers = [...new Set(String(text).match(/MARK_[A-Z]+_\d+/g) ?? [])];
    assert.ok(markers.length > 0, 'fixture has secret markers');
    for (const m of markers) assert.ok(!body.includes(m), `shard leaks ${m}`);
  } finally {
    await scanner.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('paths under home are stored as ~/…, and the scanner passes home to the adapters', async () => {
  const { createDigestConsumer } = await import('../src/node/digest-consumer.mjs');
  const homeDir = '/home/tester';
  const line = (obj) => JSON.stringify({ sessionId: 's', cwd: '/elsewhere/proj', timestamp: '2026-11-03T10:00:00.000Z', ...obj });
  const lines = [
    line({ type: 'assistant', uuid: 'a1', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: `${homeDir}/notes/plan.md` } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } } }),
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(500) }] } }),
    line({ type: 'assistant', uuid: 'a2', requestId: 'r2', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 200 } } }),
  ];
  const consumer = createDigestConsumer({ kind: 'claude', ctx: { sessionId: 's', home: homeDir } });
  consumer.push(lines.join('\n') + '\n');
  const digest = consumer.digest();
  assert.ok(digest.targets.some((t) => t[0] === 'file:~/notes/plan.md'), digest.targets.map((t) => t[0]).join(', '));
  assert.ok(!JSON.stringify(digest).includes(homeDir));

  // The scanner hands its home to the adapters (the shard keeps the ctx it parsed with).
  const dir = await home();
  await fsp.writeFile(path.join(dir, '.claude', 'projects', 'proj', 's.jsonl'), lines.join('\n') + '\n');
  const cacheDir = path.join(dir, 'digests');
  const scanner = createDigestScanner({ cacheDir, home: dir, env: { HOME: dir }, platform: 'linux', threads: 0 });
  try {
    await scanner.scan();
    const [shard] = await shards(cacheDir);
    assert.equal(JSON.parse(await fsp.readFile(path.join(cacheDir, shard), 'utf8')).ctx.home, dir);
  } finally {
    await scanner.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a folder that fails to list keeps its digests', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
  const dir = await home();
  const projDir = path.join(dir, '.claude', 'projects', 'proj');
  await fsp.writeFile(path.join(projDir, 's.jsonl'), await fixture('breakdown-claude.jsonl'));
  const cacheDir = path.join(dir, 'digests');
  const scanner = createDigestScanner({ cacheDir, home: dir, env: { HOME: dir }, platform: 'linux', threads: 0 });
  try {
    assert.equal((await scanner.scan()).digests.length, 1);
    await fsp.chmod(projDir, 0o000);
    const blocked = await scanner.scan();
    assert.equal(blocked.digests.length, 1, 'the cached digest is still reported');
    assert.equal((await shards(cacheDir)).length, 1, 'its shard is kept');
  } finally {
    await fsp.chmod(projDir, 0o755).catch(() => {});
    await scanner.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a version 2 shard (one file, rows as arrays) is read and converted without reading the transcript', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
  const dir = await home();
  const claudeText = await fixture('breakdown-claude.jsonl');
  const file = path.join(dir, '.claude', 'projects', 'proj', 's.jsonl');
  await fsp.writeFile(file, claudeText);
  const cacheDir = path.join(dir, 'digests');
  const opts = { cacheDir, home: dir, env: { HOME: dir }, platform: 'linux', threads: 0 };
  const first = createDigestScanner(opts);
  const original = (await first.scan()).digests[0].digest;
  await first.close();

  // Rewrite the cache as an earlier build left it.
  const [name] = await shards(cacheDir);
  const shard = JSON.parse(await fsp.readFile(path.join(cacheDir, name), 'utf8'));
  const stateName = name.replace(/\.json$/, '.state.json');
  const { state } = JSON.parse(await fsp.readFile(path.join(cacheDir, stateName), 'utf8'));
  const rows = [];
  for (let at = 0; at < original.rowCount * ROW_WIDTH; at += ROW_WIDTH) rows.push([...original.rows.subarray(at, at + ROW_WIDTH)]);
  const { rowCount, ...plain } = original;
  await fsp.writeFile(path.join(cacheDir, name), JSON.stringify({ ...shard, v: 2, state, digest: { ...plain, rows } }));
  await fsp.rm(path.join(cacheDir, stateName));

  // The transcript can't be read: the digest must come from the shard.
  await fsp.chmod(file, 0o000);
  const reading = createDigestScanner(opts);
  try {
    const result = await reading.scan();
    assert.deepEqual(result.digests[0].digest, original);
  } finally {
    await reading.close();
    await fsp.chmod(file, 0o644);
  }
  assert.equal(JSON.parse(await fsp.readFile(path.join(cacheDir, name), 'utf8')).v, 3, 'converted');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(cacheDir, stateName), 'utf8')).state, state, 'state moved to its own file');

  // The converted state still tails the file.
  await fsp.appendFile(file, claudeText);
  const tail = createDigestScanner(opts);
  const whole = createDigestScanner({ ...opts, cacheDir: null });
  try {
    assert.deepEqual((await tail.scan()).digests[0].digest, (await whole.scan()).digests[0].digest);
  } finally {
    await tail.close();
    await whole.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});


test('a scan with other extra folders does not join the running one', async () => {
  const dir = await home();
  const text = await fixture('breakdown-claude.jsonl');
  await fsp.writeFile(path.join(dir, '.claude', 'projects', 'proj', 's.jsonl'), text);
  const extraDir = path.join(dir, 'more');
  await fsp.mkdir(extraDir);
  await fsp.writeFile(path.join(extraDir, 'x.jsonl'), text);
  const scanner = createDigestScanner({ cacheDir: null, home: dir, env: { HOME: dir }, platform: 'linux', threads: 0 });
  try {
    const running = scanner.scan();
    // A folder added while the first scan runs, asked for with a narrower range.
    const wider = scanner.scan({ extra: { claude: [extraDir], codex: [] }, since: 1 });
    assert.equal((await running).total, 1);
    assert.equal((await wider).total, 2);
  } finally {
    await scanner.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
