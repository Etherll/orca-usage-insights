// Parse thread: bytes of whole lines in, parser state out (the same state the inline parser
// keeps, so the scanner can resume tail reads from it).
import { parentPort } from 'node:worker_threads';
import { PROVIDERS } from '../core/providers.mjs';
import { MARKER_BYTES, markedLines } from './lines.mjs';

parentPort.on('message', ({ id, kind, ctx, bytes }) => {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parser = PROVIDERS[kind].createParser(ctx);
    const text = markedLines(buf, buf.length, MARKER_BYTES[kind]);
    if (text) parser.push(text);
    parentPort.postMessage({ id, ok: true, state: parser.state() });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
