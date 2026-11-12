// Parse thread: reads one transcript and returns the consumer's state (the inline parser's, so tail reads
// resume from it) and the offset read up to. `markers` are strings, or null for every line.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createDigestConsumer } from './digest-consumer.mjs';
import { transferList } from '../core/table-codec.mjs';
import { createRecordsConsumer } from './lines.mjs';
import { readWhole } from './transcript-files.mjs';

const scratch = { buf: null };

parentPort.on('message', async ({ id, mode, kind, ctx, compressed, markers, path, size }) => {
  let fh = null;
  try {
    let consumer;
    if (mode === 'digest') consumer = createDigestConsumer({ kind, ctx }, null, { adopt: true });
    else if (mode === 'records') consumer = createRecordsConsumer(kind, ctx);
    else throw new Error(`parse mode ${mode} is not handled by this thread`);
    const marks = markers?.map((marker) => Buffer.from(marker)) ?? null;
    fh = syncHandle(path);
    const offset = await readWhole(fh, size, compressed, marks, consumer, scratch);
    const state = mode === 'records' ? consumer.state({ binary: true }) : consumer.state();
    const transfer = state?.table ? transferList(state.table) : [];
    parentPort.postMessage({ id, ok: true, state, offset }, transfer);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  } finally {
    fh?.close();
  }
});

// Reads synchronously: async reads would share libuv's 4 I/O threads with the scanner and leave parse threads idle.
function syncHandle(path) {
  const fd = fs.openSync(path, 'r');
  return {
    read: (buffer, offset, length, position) => ({ bytesRead: fs.readSync(fd, buffer, offset, length, position) }),
    close: () => fs.closeSync(fd),
  };
}
