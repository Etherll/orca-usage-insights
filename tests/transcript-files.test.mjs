import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { fileText, readTranscript } from '../src/node/transcript-files.mjs';
import { zstdAvailable } from '../src/node/zstd.mjs';

const CTX = { sessionId: 's', project: 'p' };
const transcript = (path, extra = {}) => ({ path, kind: 'claude', ctx: CTX, compressed: false, ...extra });
const coded = (code) => Object.assign(new Error(code), { code });
const lines = (...rows) => Buffer.from(rows.map((row) => `${row}\n`).join(''));
const zstdSkip = zstdAvailable() ? false : 'Node has no zlib.zstdCompressSync, so the .zst reads cannot run here';

// Consumer that keeps its text. Same shape the scanner gives a parser: push() and state().
function textConsumer(state = null) {
  let text = state?.text ?? '';
  return {
    push(chunk) {
      text += chunk;
    },
    state: () => ({ text }),
  };
}
const open = (file, state) => textConsumer(state);
const resume = (result) => ({ key: result.key, offset: result.offset, consumer: result.consumer });

// In-memory fs. entries[path] is { data: Buffer, mtimeMs } or 'dir'. hooks.stat, hooks.open and
// hooks.read may throw to simulate a failure at that step.
function memoryFs(entries, hooks = {}) {
  const log = { stats: 0, opens: 0 };
  return {
    log,
    async stat(path) {
      log.stats++;
      const entry = entries[path];
      if (entry === undefined) throw coded('ENOENT');
      hooks.stat?.(path);
      if (entry === 'dir') return { isFile: () => false, size: 0, mtimeMs: 0 };
      return { isFile: () => true, size: entry.data.length, mtimeMs: entry.mtimeMs };
    },
    async open(path) {
      log.opens++;
      const entry = entries[path];
      if (entry === undefined) throw coded('ENOENT');
      hooks.open?.(path);
      return {
        async read(buf, offset, length, position) {
          hooks.read?.(path);
          const n = Math.max(0, Math.min(length, entry.data.length - position));
          entry.data.copy(buf, offset, position, position + n);
          return { bytesRead: n };
        },
        async close() {},
      };
    },
  };
}

const P = '/t/a.jsonl';

test('an unchanged key costs one stat and no open', async () => {
  const entries = { [P]: { data: lines('one', 'two'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const first = await readTranscript({ fs, file: transcript(P), open });
  assert.equal(first.status, 'read');
  assert.equal(first.key, '1000:8');
  assert.equal(first.offset, 8);
  assert.equal(first.whole, true);
  assert.equal(first.consumer.state().text, 'one\ntwo\n');

  const opens = fs.log.opens;
  const again = await readTranscript({ fs, file: transcript(P), prior: resume(first), open });
  assert.deepEqual(again, { status: 'unchanged' });
  assert.equal(fs.log.opens, opens);
});

test('a file that only grew is tailed from the stored offset into the same consumer', async () => {
  const entries = { [P]: { data: lines('one'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const first = await readTranscript({ fs, file: transcript(P), open });
  entries[P] = { data: Buffer.concat([entries[P].data, lines('two', 'three')]), mtimeMs: 2000 };

  const tail = await readTranscript({ fs, file: transcript(P), prior: resume(first), open });
  assert.equal(tail.status, 'read');
  assert.equal(tail.whole, false);
  assert.equal(tail.consumer, first.consumer);
  assert.equal(tail.key, '2000:14');
  assert.equal(tail.offset, 14);
  assert.equal(first.consumer.state().text, 'one\ntwo\nthree\n');
});

test('a half-written last line stays out of the offset until its LF arrives', async () => {
  const entries = { [P]: { data: lines('one'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const first = await readTranscript({ fs, file: transcript(P), open });

  entries[P] = { data: Buffer.concat([entries[P].data, Buffer.from('tw')]), mtimeMs: 2000 };
  const partial = await readTranscript({ fs, file: transcript(P), prior: resume(first), open });
  assert.equal(partial.offset, 4);
  assert.equal(partial.consumer.state().text, 'one\n');

  entries[P] = { data: Buffer.concat([entries[P].data, Buffer.from('o\n')]), mtimeMs: 3000 };
  const done = await readTranscript({ fs, file: transcript(P), prior: resume(partial), open });
  assert.equal(done.offset, 8);
  assert.equal(done.consumer.state().text, 'one\ntwo\n');
});

test('a rewrite whose mtime went back is read whole into a new consumer', async () => {
  const entries = { [P]: { data: lines('one'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const first = await readTranscript({ fs, file: transcript(P), open });
  entries[P] = { data: lines('aaaa', 'bbbb', 'cccc'), mtimeMs: 500 };

  const rewritten = await readTranscript({ fs, file: transcript(P), prior: resume(first), open });
  assert.equal(rewritten.whole, true);
  assert.notEqual(rewritten.consumer, first.consumer);
  assert.equal(rewritten.consumer.state().text, 'aaaa\nbbbb\ncccc\n');
});

test('a grown file whose byte before the stored offset is not LF is read whole', async () => {
  const entries = { [P]: { data: lines('one'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const first = await readTranscript({ fs, file: transcript(P), open });
  entries[P] = { data: Buffer.from('onex-more\n'), mtimeMs: 2000 };

  const replaced = await readTranscript({ fs, file: transcript(P), prior: resume(first), open });
  assert.equal(replaced.whole, true);
  assert.notEqual(replaced.consumer, first.consumer);
  assert.equal(replaced.consumer.state().text, 'onex-more\n');
});

test('a missing file is gone with missing set, and a path that is not a file is gone without it', async () => {
  const fs = memoryFs({ d: 'dir' });
  assert.deepEqual(await readTranscript({ fs, file: transcript('/t/none.jsonl'), open }), { status: 'gone', missing: true });
  assert.deepEqual(await readTranscript({ fs, file: transcript('d'), open }), { status: 'gone', missing: false });
});

test('a stat or open failure other than a missing file throws, and a read failure returns key null with error', async () => {
  const entries = { [P]: { data: lines('one'), mtimeMs: 1000 } };
  const denied = memoryFs(entries, { stat: () => { throw coded('EACCES'); } });
  await assert.rejects(readTranscript({ fs: denied, file: transcript(P), open }), { code: 'EACCES' });

  const busy = memoryFs(entries, { open: () => { throw coded('EBUSY'); } });
  await assert.rejects(readTranscript({ fs: busy, file: transcript(P), open }), { code: 'EBUSY' });

  const torn = memoryFs(entries, { read: () => { throw coded('EIO'); } });
  const failed = await readTranscript({ fs: torn, file: transcript(P), open });
  assert.equal(failed.status, 'read');
  assert.equal(failed.key, null);
  assert.equal(failed.error, true);
  assert.equal(failed.whole, true);
});

test('markers keep only the marked lines, and a last line without LF still counts', () => {
  assert.equal(fileText(Buffer.from('a\nb'), null), 'a\nb\n');
  assert.equal(fileText(Buffer.from('x\nusage 1\ny\nusage 2'), [Buffer.from('usage')]), 'usage 1\nusage 2\n');
});

test('with a pool, the thread gets the path and size and its state and offset come back', async () => {
  const entries = { [P]: { data: Buffer.from('one\ntwo\npartial'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const sent = [];
  const pool = {
    async parse(spec) {
      sent.push({ spec });
      return { state: { text: 'from-thread' }, offset: 8 };
    },
  };
  const result = await readTranscript({ fs, file: transcript(P), pool, markers: [Buffer.from('"usage"')], open });
  assert.equal(result.status, 'read');
  assert.equal(result.whole, true);
  assert.equal(result.offset, 8);
  assert.equal(result.consumer, null);
  assert.deepEqual(result.state, { text: 'from-thread' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].spec, { mode: 'records', kind: 'claude', ctx: CTX, compressed: false, markers: ['"usage"'], path: P, size: 15 });
});

test('a pool that rejects makes the read fall back to parsing inline', async () => {
  const entries = { [P]: { data: lines('one', 'two'), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const pool = { async parse() { throw new Error('thread died'); } };
  const result = await readTranscript({ fs, file: transcript(P), pool, open });
  assert.equal(result.state, null);
  assert.equal(result.consumer.state().text, 'one\ntwo\n');
  assert.equal(result.offset, 8);
});

test('a .zst transcript is read whole and decompressed inline', { skip: zstdSkip }, async () => {
  const Z = '/t/c.jsonl.zst';
  const packed = zlib.zstdCompressSync(Buffer.from('one\ntwo'));
  const fs = memoryFs({ [Z]: { data: packed, mtimeMs: 1000 } });
  const result = await readTranscript({ fs, file: transcript(Z, { compressed: true }), open });
  assert.equal(result.status, 'read');
  assert.equal(result.offset, packed.length);
  assert.equal(result.consumer.state().text, 'one\ntwo\n');
});

test('a .zst transcript is never tailed: a grown key re-reads it whole', { skip: zstdSkip }, async () => {
  const Z = '/t/c.jsonl.zst';
  const entries = { [Z]: { data: zlib.zstdCompressSync(Buffer.from('one\ntwo\n')), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const file = transcript(Z, { compressed: true });
  const first = await readTranscript({ fs, file, open });
  entries[Z] = { data: zlib.zstdCompressSync(Buffer.from('one\ntwo\nthree\n')), mtimeMs: 2000 };

  const again = await readTranscript({ fs, file, prior: resume(first), open });
  assert.equal(again.whole, true);
  assert.notEqual(again.consumer, first.consumer);
  assert.equal(again.consumer.state().text, 'one\ntwo\nthree\n');
});

test('a .zst transcript over maxWholeBytes is skipped as too-large', { skip: zstdSkip }, async () => {
  const Z = '/t/c.jsonl.zst';
  const fs = memoryFs({ [Z]: { data: zlib.zstdCompressSync(Buffer.from('one\ntwo\n')), mtimeMs: 1000 } });
  const result = await readTranscript({ fs, file: transcript(Z, { compressed: true }), open, maxWholeBytes: 4 });
  assert.deepEqual({ ...result, key: typeof result.key }, { status: 'skipped', reason: 'too-large', key: 'string' });
});

test('a .zst transcript that decompresses past the cap is skipped, and not decompressed again until it changes', { skip: zstdSkip }, async () => {
  const Z = '/t/c.jsonl.zst';
  const entries = { [Z]: { data: zlib.zstdCompressSync(Buffer.from('one\n')), mtimeMs: 1000 } };
  const fs = memoryFs(entries);
  const file = transcript(Z, { compressed: true });
  let parses = 0;
  const pool = {
    async parse() {
      parses++;
      throw new Error('decompressed transcript is too large');
    },
  };
  const first = await readTranscript({ fs, file, pool, open });
  assert.equal(first.status, 'skipped');
  assert.equal(first.reason, 'too-large');
  const again = await readTranscript({ fs, file, pool, open, oversizedKey: first.key });
  assert.deepEqual(again, first);
  assert.equal(parses, 1, 'the same file is not decompressed twice');
  entries[Z] = { data: zlib.zstdCompressSync(Buffer.from('one\ntwo\n')), mtimeMs: 2000 };
  await readTranscript({ fs, file, pool, open, oversizedKey: first.key });
  assert.equal(parses, 2, 'a changed file is tried again');
});

test('a .zst transcript with a pool goes to the thread marked compressed', { skip: zstdSkip }, async () => {
  const Z = '/t/c.jsonl.zst';
  const packed = zlib.zstdCompressSync(Buffer.from('one\ntwo\n'));
  const fs = memoryFs({ [Z]: { data: packed, mtimeMs: 1000 } });
  const sent = [];
  const pool = {
    async parse(spec) {
      sent.push({ spec });
      return { state: { text: 'from-thread' }, offset: packed.length };
    },
  };
  const result = await readTranscript({ fs, file: transcript(Z, { compressed: true }), pool, open });
  assert.equal(result.consumer, null);
  assert.equal(result.offset, packed.length);
  assert.equal(sent[0].spec.compressed, true);
  assert.equal(sent[0].spec.size, packed.length);
});

test('a .zst transcript is skipped with reason zstd when Node has no zstd', { skip: zstdAvailable() ? 'zstd is available here, so the no-zstd path cannot run' : false }, async () => {
  const Z = '/t/c.jsonl.zst';
  const fs = memoryFs({ [Z]: { data: Buffer.from('not read'), mtimeMs: 1000 } });
  const result = await readTranscript({ fs, file: transcript(Z, { compressed: true }), open });
  assert.deepEqual(result, { status: 'skipped', reason: 'zstd' });
  assert.equal(fs.log.opens, 0);
});

test('a line longer than the read buffer is joined whole, and a reused buffer grows', async () => {
  const long = `{"usage":"${'x'.repeat(5 << 20)}"}`;
  const fs = memoryFs({ [P]: { data: lines('short "usage"', long, 'tail "usage"'), mtimeMs: 1000 } });
  const scratch = { buf: Buffer.alloc(16) };
  const { readWhole } = await import('../src/node/transcript-files.mjs');
  const consumer = textConsumer();
  const fh = await fs.open(P, 'r');
  const offset = await readWhole(fh, (await fs.stat(P)).size, false, [Buffer.from('"usage"')], consumer, scratch);
  assert.equal(consumer.state().text, `short "usage"\n${long}\ntail "usage"\n`);
  assert.equal(offset, (await fs.stat(P)).size);
  assert.ok(scratch.buf.length > long.length, 'the scratch buffer kept its larger size');
});

test('Codex markers count only in the head of a line', async () => {
  const { markedLines } = await import('../src/node/lines.mjs');
  const markers = ['token_count', 'turn_context', 'session_meta'].map((m) => Buffer.from(m));
  const head = '{"timestamp":"t","type":"event_msg","payload":{"type":"token_count"}}';
  const deep = `{"timestamp":"t","type":"response_item","payload":{"type":"function_call_output","output":"${'y'.repeat(400)} token_count"}}`;
  const buf = Buffer.from(`${head}\n${deep}\n{"type":"turn_context"}`);
  assert.equal(markedLines(buf, buf.length, markers), `${head}\n{"type":"turn_context"}`);
});
