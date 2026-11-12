import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildExplainPrompt } from '../src/core/breakdown/explain.mjs';
import { createClaudeEvents } from '../src/core/breakdown/claude-events.mjs';
import { createCodexEvents } from '../src/core/breakdown/codex-events.mjs';
import { createFold } from '../src/core/breakdown/fold.mjs';

const finding = (over = {}) => ({
  id: 'large-results:1', kind: 'large-results', harness: 'claude', usd: 12.345, est: false,
  where: { project: '/w/proj', label: 'big.mjs', key: 'src/big.mjs' },
  facts: { tokens: 1000, sessions: 3 }, lastSeen: '2026-11-03', daily: [],
  evidence: [{ file: '/t/a.jsonl', offset: 10, bytes: 50_000, compressed: false }],
  ...over,
});

test('the prompt starts with the marker and holds numbers, paths and the safety instruction', () => {
  const { prompt, estTokens } = buildExplainPrompt(finding());
  assert.ok(prompt.startsWith('<!-- usage-insights explain v1 -->\n'));
  assert.match(prompt, /\$12\.35/);
  assert.match(prompt, /Target: "big\.mjs"/);
  assert.match(prompt, /untrusted transcript data/);
  assert.match(prompt, /do not edit files/);
  assert.equal(estTokens, Math.ceil(prompt.length / 4) + 500, 'a capped 2,000-byte excerpt counts 500 tokens');
});

test('excerpts are capped at 2,000 bytes and paths with quotes stay one shell word', () => {
  const tricky = "/t/it's \"odd\" $(x).jsonl";
  const { prompt } = buildExplainPrompt(finding({ evidence: [{ file: tricky, offset: 5, bytes: 9_999, compressed: false }] }));
  assert.match(prompt, / 5 2000 fs$/m);
  assert.ok(prompt.includes(`'/t/it'\\''s "odd" $(x).jsonl'`));
  const win = buildExplainPrompt(finding({ evidence: [{ file: tricky, offset: 5, bytes: 10, compressed: false }] }), { platform: 'win32' }).prompt;
  assert.ok(win.includes(`'/t/it''s "odd" $(x).jsonl'`));
  const curly = 'C:\\t\\a\u2019; calc; \u2018\u201a\u201b.jsonl';
  const ps = buildExplainPrompt(finding({ evidence: [{ file: curly, offset: 0, bytes: 10, compressed: false }] }), { platform: 'win32' }).prompt;
  assert.ok(ps.includes(`'C:\\t\\a\u2019\u2019; calc; \u2018\u2018\u201a\u201a\u201b\u201b.jsonl'`));
});

test('the commands print the right bytes of plain and compressed files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "explain it's-"));
  try {
    const text = 'first line\n{"second":"line"}\n';
    const plain = path.join(dir, "a b's.jsonl");
    const packed = path.join(dir, 'c.jsonl.zst');
    await fsp.writeFile(plain, text);
    const files = [[plain, false]];
    if (typeof zlib.zstdCompressSync === 'function') {
      await fsp.writeFile(packed, zlib.zstdCompressSync(Buffer.from(text)));
      files.push([packed, true]);
    }
    for (const [file, compressed] of files) {
      const { prompt } = buildExplainPrompt(finding({ evidence: [{ file, offset: 11, bytes: 17, compressed }] }));
      const cmd = prompt.split('\n').find((l) => l.startsWith('1. ')).slice(3);
      const out = execFileSync('sh', ['-c', cmd], { encoding: 'utf8' });
      assert.equal(out.trim(), '{"second":"line"}');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('cache-expired has no target line and no excerpts', () => {
  const { prompt } = buildExplainPrompt(finding({ kind: 'cache-expired', evidence: [] }));
  assert.ok(!prompt.includes('Target:'));
  assert.match(prompt, /no transcript excerpts/);
});

test('no transcript text goes into the prompt', () => {
  const { prompt } = buildExplainPrompt(finding({ where: { project: '/w/proj', label: 'x', key: 'x' } }));
  assert.ok(!/MARK_/.test(prompt));
});

test('the Claude adapter marks a session whose first message is an Explain prompt', () => {
  const adapter = createClaudeEvents({ sessionId: 's' });
  const line = JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-11-03T10:00:00Z', message: { role: 'user', content: buildExplainPrompt(finding()).prompt } });
  const [arrival] = adapter.push(line, 0).filter((e) => e.t === 'arrival');
  assert.equal(arrival.bucket, 'messages');
  assert.equal(arrival.explain, true);
  const other = createClaudeEvents({ sessionId: 's' }).push(JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-11-03T10:00:00Z', message: { role: 'user', content: 'hello' } }), 0).find((e) => e.t === 'arrival');
  assert.equal(other.explain, undefined);
});

test('the Codex adapter marks a session whose first prompt, after AGENTS.md and context, is an Explain prompt', () => {
  const user = (text) => JSON.stringify({ timestamp: '2026-11-03T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const run = (...texts) => {
    const adapter = createCodexEvents({ sessionId: 's' });
    const fold = createFold({ harness: 'codex', host: 'local' });
    texts.forEach((text, i) => adapter.push(user(text), i).forEach((event) => fold.add(event)));
    return fold.digest().explain;
  };
  const prompt = buildExplainPrompt(finding()).prompt;
  assert.equal(run('# AGENTS.md instructions for /w', '<environment_context>x</environment_context>', prompt), true);
  assert.equal(run(prompt), true);
  assert.equal(run('# AGENTS.md instructions for /w', 'fix the build', prompt), false, 'only the first prompt counts');
  const first = createCodexEvents({ sessionId: 's' });
  first.push(user('# AGENTS.md instructions for /w'), 0);
  const events = createCodexEvents({ sessionId: 's' }, first.state()).push(user(prompt), 1);
  assert.ok(events.some((e) => e.t === 'explain'));
});

test('a compressed excerpt deep in a large transcript prints the right bytes', { skip: typeof zlib.zstdCompressSync !== 'function' && 'Node has no zstd' }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'explain-big-'));
  try {
    const head = 'x'.repeat(300_000) + '\n';
    const text = `${head}{"wanted":"here"}\n${'y'.repeat(100_000)}\n`;
    const packed = path.join(dir, 'big.jsonl.zst');
    await fsp.writeFile(packed, zlib.zstdCompressSync(Buffer.from(text)));
    const { prompt } = buildExplainPrompt(finding({ evidence: [{ file: packed, offset: head.length, bytes: 17, compressed: true }] }));
    const cmd = prompt.split('\n').find((l) => l.startsWith('1. ')).slice(3);
    assert.equal(execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim(), '{"wanted":"here"}');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a compressed excerpt in a later frame, after a skippable frame, prints the right bytes', { skip: typeof zlib.zstdCompressSync !== 'function' && 'Node has no zstd' }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'explain-frames-'));
  try {
    const first = 'a'.repeat(5000) + '\n';
    const second = `${'b'.repeat(3000)}\n{"wanted":"here"}\n`;
    const skippable = Buffer.from([0x51, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 9, 9]);
    const packed = path.join(dir, 'frames.jsonl.zst');
    const frame = zlib.zstdCompressSync(Buffer.from(first), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    await fsp.writeFile(packed, Buffer.concat([frame, skippable, zlib.zstdCompressSync(Buffer.from(second))]));
    const offset = first.length + 3001;
    const { prompt } = buildExplainPrompt(finding({ evidence: [{ file: packed, offset, bytes: 17, compressed: true }] }));
    const cmd = prompt.split('\n').find((l) => l.startsWith('1. ')).slice(3);
    assert.equal(execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim(), '{"wanted":"here"}');
    // An excerpt that spans the frame boundary.
    const span = buildExplainPrompt(finding({ evidence: [{ file: packed, offset: first.length - 3, bytes: 6, compressed: true }] })).prompt;
    assert.equal(execFileSync('sh', ['-c', span.split('\n').find((l) => l.startsWith('1. ')).slice(3)], { encoding: 'utf8' }), 'aa\nbbb\n');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
