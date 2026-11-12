// One transcript's events adapter and fold, fed line by line, inline or on parse threads. Offsets are byte
// offsets in the (decompressed) file. State is plain JSON: { adapter, fold, offset }.
import { createClaudeEvents } from '../core/breakdown/claude-events.mjs';
import { createCodexEvents } from '../core/breakdown/codex-events.mjs';
import { createFold } from '../core/breakdown/fold.mjs';

const LF = 0x0a;
const ADAPTERS = { claude: createClaudeEvents, codex: createCodexEvents };

// `adopt`: state() returns live objects (see createFold), for a caller that drops the consumer after reading it.
export function createDigestConsumer(file, state = null, { adopt = false } = {}) {
  const make = ADAPTERS[file.kind];
  if (!make) throw new Error(`no events adapter for ${file.kind}`);
  const adapter = make(file.ctx ?? {}, state?.adapter ?? null);
  const fold = createFold({ harness: file.kind, host: 'local' }, state?.fold ?? null, { adopt });
  let offset = Number.isSafeInteger(state?.offset) ? state.offset : 0;

  function line(text, bytes) {
    if (text !== '') for (const event of adapter.push(text, offset, bytes)) fold.add(event);
    offset += bytes + 1;
  }

  return {
    push(text) {
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const l of lines) line(l, Buffer.byteLength(l));
    },
    pushBuffer(buf) {
      let start = 0;
      while (start < buf.length) {
        let end = buf.indexOf(LF, start);
        if (end < 0) end = buf.length;
        line(buf.toString('utf8', start, end), end - start);
        start = end + 1;
      }
    },
    state: () => ({ adapter: adapter.state(), fold: fold.state(), offset }),
    digest: () => fold.digest(),
  };
}
