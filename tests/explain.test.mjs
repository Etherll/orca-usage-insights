import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildExplainPrompt } from '../src/core/breakdown/explain.mjs';
import { createClaudeEvents } from '../src/core/breakdown/claude-events.mjs';

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
  // PowerShell also ends a single-quoted string at ‘ ’ ‚ ‛, so those are doubled too.
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
    // Without zstd in this Node only the plain command can be checked.
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
