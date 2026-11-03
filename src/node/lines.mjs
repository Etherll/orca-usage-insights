// Byte-level line filter shared by the scanner and its parse threads.
import { LINE_MARKERS } from '../core/providers.mjs';

const LF = 0x0a;
export const MARKER_BYTES = Object.fromEntries(Object.entries(LINE_MARKERS).map(([kind, list]) => [kind, list.map((m) => Buffer.from(m))]));

// Decodes only the lines in buf[0, end) that contain a marker, in file order, joined with LF.
// Most transcript bytes are message content on lines with no usage, so this skips decoding them.
// `end` is just past an LF, so every candidate line ends with an LF before `end`.
export function markedLines(buf, end, markers) {
  const starts = []
  for (const marker of markers) {
    let i = buf.indexOf(marker, 0)
    while (i !== -1 && i < end) {
      const start = i === 0 ? 0 : buf.lastIndexOf(LF, i - 1) + 1
      const stop = buf.indexOf(LF, i)
      starts.push(start)
      i = stop === -1 || stop >= end ? -1 : buf.indexOf(marker, stop + 1)
    }
  }
  if (!starts.length) return ''
  starts.sort((a, b) => a - b)
  let out = ''
  let prev = -1
  for (const start of starts) {
    if (start === prev) continue
    prev = start
    const stop = buf.indexOf(LF, start)
    out += buf.toString('utf8', start, stop + 1)
  }
  return out
}
