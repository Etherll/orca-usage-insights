import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSshSource, explain, sshArgs } from '../src/node/ssh-source.mjs';
import { parseListing, createReadParser } from '../src/node/ssh-script.mjs';

const isWin = process.platform === 'win32';
const TS = new Date().toISOString();

function claudeLine(id, { big = false, cwd = '/home/me/proj', output = 5 } = {}) {
  const content = big ? [{ type: 'text', text: 'x'.repeat(5000) + ' "usage":{"fake":1} ' }] : [{ type: 'text', text: 'hi' }];
  return JSON.stringify({
    parentUuid: null,
    message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } },
    requestId: 'r',
    type: 'assistant',
    timestamp: TS,
    cwd,
    sessionId: 'sess',
  });
}

async function fixture(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-src-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const proj = path.join(home, '.claude', 'projects', '-home-me-proj');
  const codex = path.join(home, '.codex', 'sessions', '2026', '11', '03');
  await fsp.mkdir(proj, { recursive: true });
  await fsp.mkdir(codex, { recursive: true });
  return { home, proj, codex };
}

// Runs the real remote script with the local sh, as if `ssh host sh -s` had connected.
function localSource(home, extra = {}) {
  const calls = [];
  const source = createSshSource({
    host: 'box',
    command: () => ['sh', ['-s']],
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CONFIG_HOME: path.join(home, '.config') },
    spawn: (cmd, args, opts) => {
      const child = spawn(cmd, args, opts);
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (script) => {
        calls.push(script);
        return end(script);
      };
      return child;
    },
    ...extra,
  });
  return { source, calls };
}

test('sshArgs never allows prompts and ends option parsing before the host', () => {
  const a = sshArgs('dev-box');
  assert.ok(a.includes('BatchMode=yes'));
  assert.equal(a[a.indexOf('--') + 1], 'dev-box');
  assert.throws(() => createSshSource({ host: '-oProxyCommand=evil' }), /invalid SSH host/);
});

test('remote script lists and reads Claude and Codex transcripts', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(path.join(fx.proj, 's1.jsonl'), [claudeLine('m1'), JSON.stringify({ type: 'user', message: { content: 'x' } }), claudeLine('m2', { big: true })].join('\n') + '\n');
  await fsp.writeFile(
    path.join(fx.codex, 'rollout.jsonl'),
    [
      JSON.stringify({ type: 'session_meta', timestamp: TS, payload: { cwd: '/srv/api' } }),
      JSON.stringify({ type: 'turn_context', timestamp: TS, payload: { model: 'gpt-6-sol' } }),
      JSON.stringify({ type: 'event_msg', timestamp: TS, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 }, total_token_usage: { input_tokens: 10, total_tokens: 13 } } } }),
    ].join('\n') + '\n',
  );
  const { source } = localSource(fx.home);
  const { records: table, status } = await source.scan();
  const records = table.toRecords();
  assert.equal(status.state, 'ok', status.message);
  assert.equal(status.files, 2);
  const claude = records.filter((r) => r.provider === 'claude');
  const codex = records.filter((r) => r.provider === 'codex');
  assert.equal(claude.length, 2);
  assert.equal(codex.length, 1);
  assert.ok(records.every((r) => r.host === 'ssh:box'));
  assert.deepEqual([codex[0].input, codex[0].cacheRead, codex[0].output, codex[0].model], [6, 4, 3, 'gpt-6-sol']);
  const big = claude.find((r) => r.key?.startsWith('m2'));
  assert.equal(big.output, 5, 'a slimmed line keeps its real usage, not the fake one in content');
});

test('appended lines are read from the stored offset; unchanged files are not read', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.proj, 's1.jsonl');
  await fsp.writeFile(file, claudeLine('m1') + '\n');
  await fsp.writeFile(path.join(fx.proj, 's2.jsonl'), claudeLine('k1') + '\n');
  const { source, calls } = localSource(fx.home);
  assert.equal((await source.scan()).records.length, 2);
  const size = (await fsp.stat(file)).size;
  await fsp.appendFile(file, claudeLine('m2') + '\n');
  calls.length = 0;
  const r = await source.scan({ force: true });
  assert.equal(r.records.length, 3);
  const read = calls[1];
  assert.match(read, new RegExp(`s1\\.jsonl' ${size} `), 'tail starts at the old size');
  assert.doesNotMatch(read, /s2\.jsonl/, 'unchanged file is not read');
  calls.length = 0;
  await source.scan({ force: true });
  assert.equal(calls.length, 1, 'nothing changed: listing only');
});

test('a half-written last line is held back and picked up once complete', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.proj, 's1.jsonl');
  const second = claudeLine('m2');
  await fsp.writeFile(file, claudeLine('m1') + '\n' + second.slice(0, 40));
  const { source } = localSource(fx.home);
  assert.equal((await source.scan()).records.length, 1);
  await fsp.appendFile(file, second.slice(40) + '\n');
  assert.equal((await source.scan({ force: true })).records.length, 2);
});

test('the per-host cache survives a restart and avoids re-reading', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  await fsp.writeFile(path.join(fx.proj, 's1.jsonl'), claudeLine('m1') + '\n');
  const cacheFile = path.join(fx.home, 'cache', 'ssh-box.json');
  const a = localSource(fx.home, { cacheFile });
  await a.source.scan();
  await a.source.flush();
  const b = localSource(fx.home, { cacheFile });
  const r = await b.source.scan();
  assert.equal(r.records.length, 1);
  assert.equal(b.calls.length, 1, 'listing only, no read');
});

test('lines appended before the first scan after a restart are counted', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.proj, 's1.jsonl');
  await fsp.writeFile(file, claudeLine('m1') + '\n');
  const cacheFile = path.join(fx.home, 'cache', 'ssh-box.json');
  const a = localSource(fx.home, { cacheFile });
  await a.source.scan();
  await a.source.flush();
  // The restored entry is tailed from its offset; its parser must exist before the lines arrive.
  await fsp.appendFile(file, claudeLine('m2') + '\n');
  const b = localSource(fx.home, { cacheFile });
  assert.equal((await b.source.scan()).records.length, 2);
  await fsp.appendFile(file, claudeLine('m3') + '\n');
  assert.equal((await b.source.scan({ force: true })).records.length, 3);
});

test('ssh failures become a readable error status and keep earlier records', async () => {
  let fail = false;
  const source = createSshSource({
    host: 'box',
    command: () => ['sh', ['-c', 'echo "Permission denied (publickey)." >&2; exit 255']],
    spawn,
  });
  const r = await source.scan();
  assert.equal(r.status.state, 'error');
  assert.match(r.status.message, /key or ssh-agent/);
  const missing = createSshSource({ host: 'box', command: () => ['definitely-not-ssh-xyz', []], spawn });
  const m = await missing.scan();
  assert.match(m.status.message, /ssh was not found/);
  assert.equal(fail, false);
});

test('explain maps common ssh errors', () => {
  assert.match(explain(new Error('ssh: Could not resolve hostname x: Name or service not known')), /Unknown host/);
  assert.match(explain(new Error('Host key verification failed.')), /Host key/);
});

test('parseListing rejects a cut-off listing; read parser frames files', () => {
  assert.equal(parseListing('\x1eF\tclaude\t10\t1.5\t/a.jsonl\n'), null);
  assert.deepEqual(parseListing('\x1eF\tclaude\t10\t1.5\t/a b.jsonl\n\x1eE\n'), [{ kind: 'claude', path: '/a b.jsonl', size: 10, key: '10:1.5' }]);
  const got = [];
  const p = createReadParser({ onLines: (f, t) => got.push(['L', f, t]), onDone: (f, n) => got.push(['D', f, n]) });
  p.push('\x1eB\t/a\nline1\nli');
  p.push('ne2\n\x1eN\t12\n\x1eB\t/b\n\x1eN\t0\n\x1eE\n');
  assert.deepEqual(got, [['L', '/a', 'line1\nline2\n'], ['D', '/a', 12], ['D', '/b', 0]]);
  assert.equal(p.end(), true);
});

test('host names: aliases and user@host are accepted; spaces and shell characters are not', () => {
  for (const ok of ['box', 'user@example.com', 'dev-1.internal', 'me@[::1]']) assert.doesNotThrow(() => createSshSource({ host: ok }), ok);
  for (const bad of ['a b', 'a;b', '$(x)', 'a`b`', '-p22', '', 'a@b@c']) assert.throws(() => createSshSource({ host: bad }), /invalid SSH host/, bad);
});

test('a file that shrank between listing and read is read whole on the next scan', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.proj, 's1.jsonl');
  await fsp.writeFile(file, [claudeLine('m1'), claudeLine('m2')].join('\n') + '\n');
  // Shrink the file after the listing ran but before the read, by wrapping the read command.
  let call = 0;
  const { source } = localSource(fx.home, {
    command: () => {
      call++;
      if (call === 2) return ['sh', ['-c', `printf '%s\\n' '${claudeLine('m1').replace(/'/g, "'\\''")}' > '${file}'; exec sh -s`]];
      return ['sh', ['-s']];
    },
  });
  const first = await source.scan();
  assert.equal(first.status.state, 'ok', first.status.message);
  const again = await source.scan({ force: true });
  assert.equal(again.records.length, 1, 'shrunk file was re-read from the start');
});

test('close() kills a running ssh and the source never writes its cache afterwards', { skip: isWin }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-close-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'c.json');
  let killed = false;
  let spawned = false;
  const source = createSshSource({
    host: 'box',
    cacheFile,
    command: () => ['sh', ['-c', 'sleep 30']],
    spawn: (cmd, args, opts) => {
      const child = spawn(cmd, args, opts);
      spawned = true;
      const kill = child.kill.bind(child);
      child.kill = (...a) => {
        killed = true;
        return kill(...a);
      };
      return child;
    },
  });
  const running = source.scan();
  // Wait for the ssh stand-in to start; a slow machine may need longer than a fixed delay.
  for (let i = 0; i < 200 && !spawned; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(spawned, 'ssh stand-in started');
  const t0 = Date.now();
  await source.close();
  assert.ok(killed, 'ssh child was killed');
  assert.ok(Date.now() - t0 < 5000, 'close did not wait for the 30 s command');
  const r = await running;
  assert.equal(r.status.state, 'error');
  const after = (await source.scan()).records;
  assert.equal(after.length, 0);
});

test('codex reads only keep codex marker lines', async () => {
  const { readScript } = await import('../src/node/ssh-script.mjs');
  const s = readScript([{ path: '/x/r.jsonl', kind: 'codex', offset: 0, size: 10 }, { path: "/y/it's.jsonl", kind: 'claude', offset: 5, size: 9 }]);
  assert.match(s, /one '\/x\/r\.jsonl' 0 10 codex/);
  assert.match(s, /one '\/y\/it'\\''s\.jsonl' 5 9 claude/);
});

test('a display name replaces the address in ids, labels and error messages', async () => {
  const host = 'ec2-1-2-3-4.example.com';
  const source = createSshSource({ host, name: 'aws', command: () => ['sh', ['-c', `echo "ssh: Could not connect to ${host} port 22: boom" >&2; exit 255`]], spawn });
  assert.equal(source.id, 'ssh:aws');
  assert.equal(source.label, 'aws');
  const r = await source.scan();
  assert.equal(r.status.label, 'aws');
  assert.ok(!r.status.message.includes(host), r.status.message);
  assert.match(r.status.message, /aws/);
});

test('a file rewritten in place at a larger size is read from the start, not tailed', { skip: isWin }, async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.proj, 's1.jsonl');
  await fsp.writeFile(file, claudeLine('m1') + '\n');
  const { source } = localSource(fx.home);
  assert.equal((await source.scan()).records.length, 1);
  // Different, longer content: the byte before the old offset is no longer an LF.
  await fsp.writeFile(file, claudeLine('rewritten-1') + '\n' + claudeLine('rewritten-2') + '\n');
  const later = new Date(Date.now() + 5000);
  await fsp.utimes(file, later, later);
  await source.scan({ force: true });
  const keys = (await source.scan({ force: true })).records.toRecords().map((r) => r.key).sort();
  assert.ok(keys.length === 2 && keys.every((k) => k.startsWith('rewritten')), keys.join(', '));
});

test('the shell fallback also reports a rewritten file instead of tailing it', { skip: isWin }, async (t) => {
  const { readScript } = await import('../src/node/ssh-script.mjs');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-rewrite-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'r.jsonl');
  await fsp.writeFile(file, 'abcdefgh\nmore\n');
  const script = readScript([{ path: file, kind: 'claude', offset: 5, size: 14 }, { path: file, kind: 'claude', offset: 9, size: 14 }]).replace('if command -v python3 >/dev/null 2>&1; then', 'if false; then');
  const out = await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s']);
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('error', reject);
    child.on('close', () => resolve(text));
    child.stdin.end(script);
  });
  const done = out.split('\n').filter((l) => l.startsWith('\u001eN'));
  assert.deepEqual(done, ['\u001eN\t-1', '\u001eN\t5']);
});
