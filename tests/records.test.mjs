import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createClaudeParser,
  createCodexParser,
  parseClaudeTranscript,
  parseCodexTranscript,
} from '../src/core/records.mjs';

const claudeText = readFileSync(new URL('./fixtures/claude.jsonl', import.meta.url), 'utf8');
const codexText = readFileSync(new URL('./fixtures/codex.jsonl', import.meta.url), 'utf8');
// Each element keeps its trailing newline, so slices stay on line boundaries.
const claudeLines = claudeText.split(/(?<=\n)/);
const codexLines = codexText.split(/(?<=\n)/);
const claudeCtx = { sessionId: 'ctx-session', project: 'ctx-project' };
const codexCtx = { sessionId: 'rollout-1', project: 'fallback' };

const claudeExpected = [
  // msg_2 streams two lines with the same key; the final one wins.
  { key: 'msg_1:req_1', provider: 'claude', ts: '2026-10-01T10:00:05.000Z', model: 'claude-sonnet-4-5', project: 'alpha', sessionId: 'sess-a', input: 10, output: 50, cacheRead: 1000, cacheWrite: 100, cacheWrite1h: 0, cwd: '/home/me/work/alpha', host: 'local' },
  { key: 'msg_2:req_2', provider: 'claude', ts: '2026-10-01T10:01:02.000Z', model: 'claude-sonnet-4-5', project: 'alpha', sessionId: 'sess-a', input: 12, output: 40, cacheRead: 1100, cacheWrite: 0, cacheWrite1h: 0, cwd: '/home/me/work/alpha', host: 'local' },
  // Missing cwd, sessionId and cache fields fall back to context or zero; no requestId keys with an empty request id.
  { key: 'msg_m:', provider: 'claude', ts: '2026-10-01T11:00:00.000Z', model: 'claude-haiku-4-5', project: 'ctx-project', sessionId: 'ctx-session', input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cwd: '', host: 'local' },
  // Missing model becomes 'unknown'; Windows cwd gives the last segment for project and is kept whole in cwd.
  { key: 'msg_w:req_w', provider: 'claude', ts: '2026-10-01T11:05:00.000Z', model: 'unknown', project: 'proj-win', sessionId: 'sess-b', input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cwd: 'C:\\Users\\me\\proj-win', host: 'local' },
  // Trailing slash on cwd is ignored for project and kept in cwd; multibyte text does not shift the parse.
  { key: 'msg_3:req_3', provider: 'claude', ts: '2026-10-02T08:30:00.000Z', model: 'claude-opus-4-1', project: 'beta', sessionId: 'sess-c', input: 20, output: 300, cacheRead: 4000, cacheWrite: 200, cacheWrite1h: 0, cwd: '/home/me/work/beta/', host: 'local' },
  // Same message id with a different request id is a separate record.
  { key: 'msg_2:req_9', provider: 'claude', ts: '2026-10-01T10:03:00.000Z', model: 'claude-sonnet-4-5', project: 'alpha', sessionId: 'sess-a', input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cwd: '/home/me/work/alpha', host: 'local' },
  // No message id, so no dedupe key and the record is kept.
  { provider: 'claude', ts: '2026-10-02T09:00:00.000Z', model: 'claude-sonnet-5', project: 'delta', sessionId: 'sess-d', input: 4, output: 6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cwd: '/home/me/work/delta', host: 'local' },
  // A split cache write: 200 of the 300 cache write tokens used the 1-hour TTL.
  { key: 'msg_c:req_c', provider: 'claude', ts: '2026-10-02T08:40:00.000Z', model: 'claude-opus-4-1', project: 'beta', sessionId: 'sess-c', input: 5, output: 6, cacheRead: 0, cacheWrite: 300, cacheWrite1h: 200, cwd: '/home/me/work/beta', host: 'local' },
];

const codexExpected = [
  { key: 'codex:rollout-1:2026-10-01T09:01:00.000Z:1280', provider: 'codex', ts: '2026-10-01T09:01:00.000Z', model: 'gpt-5-codex', project: 'gamma', sessionId: 'rollout-1', input: 200, output: 80, cacheRead: 1000, cacheWrite: 0, cacheWrite1h: 0, cwd: '/home/me/work/gamma', host: 'local' },
  { provider: 'codex', ts: '2026-10-01T09:06:00.000Z', model: 'gpt-5.1-codex-mini', project: 'gamma', sessionId: 'rollout-1', input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cwd: '/home/me/work/gamma', host: 'local' },
  // Cached tokens above input clamp the uncached input to zero.
  { provider: 'codex', ts: '2026-10-01T09:07:00.000Z', model: 'gpt-5.1-codex-mini', project: 'gamma', sessionId: 'rollout-1', input: 0, output: 1, cacheRead: 9, cacheWrite: 0, cacheWrite1h: 0, cwd: '/home/me/work/gamma', host: 'local' },
];

test('claude fixture yields deduped records and skips synthetic, malformed and untimed lines', () => {
  assert.deepEqual(parseClaudeTranscript(claudeText, claudeCtx), claudeExpected);
});

test('claude streamed duplicates keep the last line', () => {
  const records = parseClaudeTranscript(claudeText, claudeCtx);
  const msg2 = records.filter((r) => r.ts === '2026-10-01T10:01:02.000Z');
  assert.equal(msg2.length, 1);
  assert.equal(msg2[0].output, 40);
  assert.equal(records.some((r) => r.ts === '2026-10-01T10:01:00.000Z'), false);
});

test('claude records never carry the synthetic model', () => {
  const records = parseClaudeTranscript(claudeText, claudeCtx);
  assert.equal(records.some((r) => r.model === '<synthetic>'), false);
});

test('CRLF transcripts parse the same as LF', () => {
  assert.deepEqual(parseClaudeTranscript(claudeText.replace(/\n/g, '\r\n'), claudeCtx), claudeExpected);
  assert.deepEqual(parseCodexTranscript(codexText.replace(/\n/g, '\r\n'), codexCtx), codexExpected);
});

test('claude dedupe holds across two push calls', () => {
  const parser = createClaudeParser(claudeCtx);
  parser.push(claudeLines.slice(0, 3).join(''));
  parser.push(claudeLines.slice(3).join(''));
  assert.deepEqual(parser.records(), claudeExpected);
});

test('claude parser state restores mid-file and keeps dedupe', () => {
  const first = createClaudeParser(claudeCtx);
  first.push(claudeLines.slice(0, 3).join(''));
  const saved = JSON.parse(JSON.stringify(first.state()));
  const resumed = createClaudeParser(claudeCtx, saved);
  resumed.push(claudeLines.slice(3).join(''));
  assert.deepEqual(resumed.records(), claudeExpected);
});

test('codex fixture uses session and turn context for each token event', () => {
  assert.deepEqual(parseCodexTranscript(codexText, codexCtx), codexExpected);
});

test('codex falls back to default model and context project without context lines', () => {
  const tokenLine = codexLines.find((line) => line.includes('"input_tokens":1200'));
  const [record] = parseCodexTranscript(tokenLine, codexCtx);
  assert.equal(record.model, 'codex');
  assert.equal(record.project, 'fallback');
  assert.equal(record.cwd, '');
});

test('records carry the context host', () => {
  const claude = parseClaudeTranscript(claudeText, { ...claudeCtx, host: 'ssh:box' });
  assert.deepEqual([...new Set(claude.map((r) => r.host))], ['ssh:box']);
  const codex = parseCodexTranscript(codexText, { ...codexCtx, host: 'ssh:box' });
  assert.deepEqual([...new Set(codex.map((r) => r.host))], ['ssh:box']);
});

test('codex parser state carries model and project across pushes', () => {
  const first = createCodexParser(codexCtx);
  first.push(codexLines.slice(0, 4).join(''));
  const saved = JSON.parse(JSON.stringify(first.state()));
  const resumed = createCodexParser(codexCtx, saved);
  resumed.push(codexLines.slice(4).join(''));
  assert.deepEqual(resumed.records(), codexExpected);
});

test('an unterminated trailing line is ignored until it is sent with its newline', () => {
  const claudeLine = claudeLines[1];
  const claude = createClaudeParser(claudeCtx);
  claude.push(claudeLine.slice(0, -1));
  assert.equal(claude.records().length, 0);
  claude.push(claudeLine);
  assert.equal(claude.records().length, 1);

  const codexLine = codexLines[7];
  const codex = createCodexParser(codexCtx, { model: 'gpt-5.1-codex-mini', project: 'gamma' });
  codex.push(codexLine.slice(0, -1));
  assert.equal(codex.records().length, 0);
  codex.push(codexLine);
  assert.equal(codex.records().length, 1);
});

test('claude records carry a key only when the line has a message id', () => {
  const records = parseClaudeTranscript(claudeText, claudeCtx);
  const keyless = records.filter((r) => !('key' in r));
  assert.deepEqual(keyless.map((r) => r.ts), ['2026-10-02T09:00:00.000Z']);
});

// A token_count line with a running total and the last turn's usage.
const tokenUsage = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const tokenLine = (ts, total, last) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });

test('codex skips a token_count whose running total repeats the previous event', () => {
  const text = [
    tokenLine('2026-10-01T09:00:00.000Z', tokenUsage(100, 10), tokenUsage(100, 10)),
    tokenLine('2026-10-01T09:00:01.000Z', tokenUsage(100, 10), tokenUsage(100, 10)),
    tokenLine('2026-10-01T09:00:02.000Z', tokenUsage(150, 30), tokenUsage(50, 20)),
  ].map((line) => `${line}\n`).join('');
  const records = parseCodexTranscript(text, codexCtx);
  assert.deepEqual(records.map((r) => [r.input, r.output]), [[100, 10], [50, 20]]);
});

test('codex repeat detection survives a parser state round trip', () => {
  const first = createCodexParser(codexCtx);
  first.push(`${tokenLine('2026-10-01T09:00:00.000Z', tokenUsage(100, 10), tokenUsage(100, 10))}\n`);
  const saved = JSON.parse(JSON.stringify(first.state()));
  const resumed = createCodexParser(codexCtx, saved);
  resumed.push(`${tokenLine('2026-10-01T09:00:05.000Z', tokenUsage(100, 10), tokenUsage(100, 10))}\n`);
  assert.equal(resumed.records().length, 1);
  resumed.push(`${tokenLine('2026-10-01T09:00:09.000Z', tokenUsage(120, 15), tokenUsage(20, 5))}\n`);
  assert.equal(resumed.records().length, 2);
});

test('records outside the plausible year range are dropped', () => {
  const year = new Date().getUTCFullYear();
  const claude = (ts, id) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r', message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 1 } } });
  const text = [
    claude('2019-12-31T23:59:59.000Z', 'too-old'),
    claude('2020-01-01T00:00:00.000Z', 'floor'),
    claude(`${year + 1}-06-01T00:00:00.000Z`, 'next-year'),
    claude(`${year + 2}-01-01T00:00:00.000Z`, 'too-new'),
    claude('1970-01-01T00:00:00.000Z', 'epoch'),
  ].map((line) => `${line}\n`).join('');
  assert.deepEqual(parseClaudeTranscript(text, claudeCtx).map((r) => r.key), ['floor:r', 'next-year:r']);

  const codex = tokenLine(`${year + 2}-01-01T00:00:00.000Z`, tokenUsage(1, 1), tokenUsage(1, 1));
  assert.deepEqual(parseCodexTranscript(codex, codexCtx), []);
});

test('codex records carry a key only when the token event has a running total', () => {
  const records = parseCodexTranscript(codexText, codexCtx);
  assert.deepEqual(records.filter((r) => 'key' in r).map((r) => r.key), ['codex:rollout-1:2026-10-01T09:01:00.000Z:1280']);
});

test('codex cache writes come from cache_write_input_tokens', () => {
  const last = { ...tokenUsage(100, 10), cache_write_input_tokens: 40 };
  const [record] = parseCodexTranscript(`${tokenLine('2026-10-01T09:00:00.000Z', tokenUsage(100, 10), last)}\n`, codexCtx);
  assert.equal(record.cacheWrite, 40);
  assert.equal(record.cacheWrite1h, 0);
});

test('claude 1-hour cache writes are capped at the cache write total', () => {
  const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T09:00:00.000Z', requestId: 'r', message: { id: 'capped', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 80 } } } });
  const [record] = parseClaudeTranscript(`${line}\n`, claudeCtx);
  assert.equal(record.cacheWrite, 50);
  assert.equal(record.cacheWrite1h, 50);
});

test('packed parser state restores the same records, keyless and anonymous ones included', async () => {
  const { unpackRecords } = await import('../src/core/records.mjs');
  const { packRecords } = await import('./legacy-records.mjs');
  const list = [
    { key: 'k1', provider: 'claude', ts: '2026-11-03T10:00:00.000Z', model: 'm', project: 'p', sessionId: 's', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 0, cwd: '/w', host: 'local' },
    { provider: 'codex', ts: '2026-11-03T10:00:01.000Z', model: 'm', project: 'p', sessionId: 's', input: 5, output: 6, cacheRead: 7, cacheWrite: 0, cacheWrite1h: 0, cwd: '', host: 'local' },
  ];
  const packed = JSON.parse(JSON.stringify(packRecords(list)));
  const back = unpackRecords(packed);
  assert.deepEqual(back, list);
  assert.equal('key' in back[1], false, 'a record without a key stays without one');
  assert.equal(back[0].model, back[1].model);
  assert.ok(packed.s.filter((s) => s === 'm').length === 1, 'each distinct string is stored once');

  const first = createClaudeParser({ sessionId: 's', project: 'p' });
  first.push(claudeText);
  const anonymous = JSON.stringify({ type: 'assistant', timestamp: '2026-11-03T10:00:00.000Z', sessionId: 's', message: { model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } } });
  first.push(`${anonymous}\n${anonymous}\n`);
  const saved = JSON.parse(JSON.stringify(first.state()));
  const restored = createClaudeParser({ sessionId: 's', project: 'p' }, saved);
  assert.deepEqual(restored.records(), first.records());
  restored.push(`${anonymous}\n`);
  first.push(`${anonymous}\n`);
  assert.deepEqual(restored.records(), first.records(), 'anonymous numbering continues after a restore');
});

test('a parser restored from a previous version state keeps its records and still dedupes', async () => {
  const { packRecords } = await import('./legacy-records.mjs');
  const line = (id, output, ts = '2026-10-01T10:00:00.000Z') =>
    JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r', message: { id, model: 'claude-x', usage: { input_tokens: 1, output_tokens: output } } });
  const fresh = createClaudeParser({ sessionId: 's', project: 'p' });
  fresh.push(`${line('a', 1)}\n${line('b', 2)}\n`);
  const legacy = { packed: packRecords(fresh.records()), keys: [], anonymous: 0 };
  const restored = createClaudeParser({ sessionId: 's', project: 'p' }, JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(restored.records(), fresh.records());
  restored.push(`${line('a', 5)}\n${line('c', 3)}\n`);
  assert.deepEqual(restored.records().map((r) => [r.key, r.output]), [['a:r', 5], ['b:r', 2], ['c:r', 3]]);
  const again = createClaudeParser({}, JSON.parse(JSON.stringify(restored.state())));
  assert.deepEqual(again.records(), restored.records());
});
