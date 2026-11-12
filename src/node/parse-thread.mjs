// Parse thread: reads one transcript and returns the consumer's state (the same state the inline
// parser keeps, so the scanner can resume tail reads from it) and the offset it read up to. The
// thread opens the file itself and reads it in chunks, synchronously; compressed files are
// decompressed in chunks.
// `markers` are strings, or null for every line. mode 'records' runs the usage parser, mode
// 'digest' the Breakdown adapter and fold.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createDigestConsumer } from './digest-consumer.mjs';
import { transferList } from '../core/table-codec.mjs';
import { createRecordsConsumer } from './lines.mjs';
import { readWhole } from './transcript-files.mjs';

// Read and zstd buffers for every file this thread reads (see readWhole).
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
    // Record columns go back as typed arrays whose buffers are transferred, not copied.
    const state = mode === 'records' ? consumer.state({ binary: true }) : consumer.state();
    const transfer = state?.table ? transferList(state.table) : [];
    parentPort.postMessage({ id, ok: true, state, offset }, transfer);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  } finally {
    fh?.close();
  }
});

// The reader takes a FileHandle; this one reads synchronously. Async reads from every thread share
// libuv's 4 I/O threads with the scanner's stats and opens, and queueing there left parse threads
// idle ~40% of a first scan (measured). A blocking read on this thread blocks nothing else.
function syncHandle(path) {
  const fd = fs.openSync(path, 'r');
  return {
    read: (buffer, offset, length, position) => ({ bytesRead: fs.readSync(fd, buffer, offset, length, position) }),
    close: () => fs.closeSync(fd),
  };
}
