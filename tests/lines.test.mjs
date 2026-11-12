import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MARKER_BYTES, createRecordsConsumer, markedLines } from '../src/node/lines.mjs';
import { forEachLines, readLines, zstdAvailable } from '../src/node/zstd.mjs';

const CTX = { sessionId: 's', project: 'p' };
const zstdSkip = zstdAvailable() ? false : 'Node has no zstd here';
const T = '2025-03-01T10:00:00.000Z';

function claude(id, { text = 'hi', usage = { input_tokens: 3, output_tokens: 5 }, extra = {} } = {}) {
  const message = { id, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
  return JSON.stringify({ type: 'assistant', requestId: `r${id}`, timestamp: T, message, ...extra });
}
const codex = (type, payload) => JSON.stringify({ timestamp: T, type, payload });
const tokens = (n) => codex('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: n }, last_token_usage: { input_tokens: n, output_tokens: 1 } } });

// The byte reader must give what the text parser gives on the marked lines of the same bytes.
function both(kind, buf) {
  const text = createRecordsConsumer(kind, CTX);
  text.push(markedLines(buf, buf.length, MARKER_BYTES[kind]));
  const bytes = createRecordsConsumer(kind, CTX);
  bytes.pushBytes(buf);
  return [bytes.records(), text.records()];
}

test('Claude lines from bytes match the text parser: long lines cut, short ones, CRLF, bad JSON', () => {
  const rows = [
    claude('a'),
    claude('b', { text: 'é'.repeat(400) }), // 800 bytes, under the limit in UTF-16 units
    claude('c', { text: '界'.repeat(600) }), // between 1x and 3x the limit in bytes
    claude('d', { text: '"usage":{ "stop_reason": '.repeat(200) }), // markers inside content
    claude('e', { text: 'x'.repeat(5000) }) + '\r',
    claude('f', { usage: 'none' }),
    '{"type":"user","note":"usage"}',
    claude('g').slice(0, -2),
    claude('h', { text: '😀'.repeat(900), extra: { type: 'assistant' } }),
  ];
  const [bytes, text] = both('claude', Buffer.from(rows.join('\n') + '\n'));
  assert.equal(text.length, 6);
  assert.deepEqual(bytes, text);
});

test('Codex lines from bytes match the text parser: markers count in the head only', () => {
  const rows = [
    codex('session_meta', { cwd: '/home/me/proj' }),
    codex('turn_context', { model: 'gpt-5' }),
    tokens(10),
    tokens(10),
    ' '.repeat(250) + tokens(20), // marker past the head
    codex('response_item', { content: 'token_count' }),
    tokens(30) + '\r',
    tokens(40).slice(0, -3),
  ];
  const [bytes, text] = both('codex', Buffer.from(rows.join('\n') + '\n'));
  assert.equal(text.length, 2);
  assert.deepEqual(bytes, text);
});

async function zstdLines(bytes, maxBytes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zstd-'));
  const file = path.join(dir, 'a.zst');
  await fsp.writeFile(file, bytes);
  const fh = await fsp.open(file);
  const got = [];
  let error = null;
  try {
    await readLines(fh, bytes.length, (buf) => got.push(buf.toString()), {}, maxBytes);
  } catch (e) {
    error = e;
  } finally {
    await fh.close();
    await fsp.rm(dir, { recursive: true });
  }
  return { text: got.join(''), error };
}
async function streamLines(bytes, maxBytes) {
  const got = [];
  let error = null;
  await forEachLines(bytes, (buf) => got.push(buf.toString()), maxBytes).catch((e) => (error = e));
  return { text: got.join(''), error };
}

test('readLines gives the same lines as forEachLines: frames, long lines, no last LF', { skip: zstdSkip }, async () => {
  const text = ['a', 'x'.repeat(3 << 20), 'b'.repeat(70000), 'last without LF'].join('\n');
  const buf = Buffer.from(text);
  const two = Buffer.concat([zlib.zstdCompressSync(buf.subarray(0, 1000)), zlib.zstdCompressSync(buf.subarray(1000))]);
  for (const z of [zlib.zstdCompressSync(buf), two]) {
    const got = await zstdLines(z);
    assert.equal(got.error, null);
    assert.equal(got.text, `${text}\n`);
    assert.deepEqual(got, await streamLines(z));
  }
});

test('readLines keeps lines before a decode error and throws, like forEachLines', { skip: zstdSkip }, async () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} ${'y'.repeat(i % 97)}`).join('\n') + '\n';
  const z = zlib.zstdCompressSync(Buffer.from(lines));
  const truncated = await zstdLines(z.subarray(0, z.length - 7));
  assert.ok(truncated.error);
  assert.ok(lines.startsWith(truncated.text));
  const garbage = await zstdLines(Buffer.from('not zstd at all'));
  assert.ok(garbage.error);
  assert.equal(garbage.text, '');
  const big = await zstdLines(z, 1000);
  assert.match(big.error.message, /too large/);
});
