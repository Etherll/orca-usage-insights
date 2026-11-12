// Byte-level line filter shared by the scanner and its parse threads.
import { LINE_MARKERS, MARKER_HEADS, PROVIDERS } from '../core/providers.mjs'
import { CLAUDE_MARKERS, CODEX_MARKERS, SLIM_MIN, parseJson } from '../core/records.mjs'

const LF = 0x0a;
export const MARKER_BYTES = Object.fromEntries(Object.entries(LINE_MARKERS).map(([kind, list]) => [kind, list.map((m) => Buffer.from(m))]));

// Decodes only the lines in buf[0, end) that contain a marker, in file order, joined with LF.
// Most transcript bytes are message content on lines with no usage, so this skips decoding them.
// `end` is just past an LF, so every candidate line ends with an LF before `end`.
export function markedLines(buf, end, markers) {
  const head = headOf(markers)
  if (head > 0) return markedHeads(buf, end, markers, head)
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

function headOf(markers) {
  let head = 0
  for (const marker of markers) {
    const h = MARKER_HEADS[marker.toString()]
    if (!h) return 0
    head = Math.max(head, h)
  }
  return head
}

function markedHeads(buf, end, markers, head) {
  let out = ''
  let start = 0
  while (start < end) {
    let stop = buf.indexOf(LF, start)
    if (stop === -1 || stop >= end) stop = end - 1
    const view = buf.subarray(start, Math.min(stop, start + head))
    for (const marker of markers) {
      if (view.indexOf(marker) !== -1) {
        out += buf.toString('utf8', start, stop + 1)
        break
      }
    }
    start = stop + 1
  }
  return out
}

// Decoding every marked line costs more than parsing it (Claude lines are mostly message.content), so these
// parse lines from raw bytes into parser.pushObject, with the same results as parser.push(markedLines(...)).

const CR = 0x0d
const USAGE = Buffer.from(CLAUDE_MARKERS[0])
const CONTENT = Buffer.from('"content":[')
const USAGE_OBJ = Buffer.from('"usage":{')
const STOP = Buffer.from('"stop_reason":')
const CODEX_HEAD = MARKER_HEADS[CODEX_MARKERS[0]]

export function createRecordsConsumer(kind, ctx, state, options) {
  const parser = PROVIDERS[kind].createParser(ctx, state, options)
  if (kind === 'claude') parser.pushBytes = (buf) => pushClaudeBytes(buf, parser)
  else if (kind === 'codex') parser.pushBytes = (buf) => pushCodexBytes(buf, parser)
  return parser
}

function pushClaudeBytes(buf, parser) {
  const end = buf.length
  let pos = 0
  for (;;) {
    const hit = buf.indexOf(USAGE, pos)
    if (hit === -1) return
    const start = hit === 0 ? 0 : buf.lastIndexOf(LF, hit - 1) + 1
    let lf = buf.indexOf(LF, hit)
    if (lf === -1) lf = end
    parser.pushObject(parseClaudeBytes(buf, start, buf[lf - 1] === CR ? lf - 1 : lf))
    pos = lf + 1
  }
}

// A long line is parsed with message.content cut out, decoding only the head and tail around the ASCII cut points.
// Lengths are UTF-16 units, so only lines between 1x and 3x the limit in bytes are decoded to check.
function parseClaudeBytes(buf, s, e) {
  const bytes = e - s
  let text = null
  if (bytes >= SLIM_MIN && (bytes >= 3 * SLIM_MIN || (text = buf.toString('utf8', s, e)).length >= SLIM_MIN)) {
    const content = buf.indexOf(CONTENT, s)
    const usage = buf.lastIndexOf(USAGE_OBJ, e - USAGE_OBJ.length)
    if (content > s && content < e && usage > s) {
      const stop = buf.lastIndexOf(STOP, usage)
      if (stop > content) {
        const slim = parseJson(`${buf.toString('utf8', s, content)}"content":[],${buf.toString('utf8', stop, e)}`)
        if (isObject(slim?.message) && isObject(slim.message.usage)) return slim
      }
    }
  }
  return parseJson(text ?? buf.toString('utf8', s, e))
}

// One memchr per line and a short latin1 head: searching the chunk once per marker is slower on long lines.
function pushCodexBytes(buf, parser) {
  const end = buf.length
  for (let p = 0; p < end; ) {
    let lf = buf.indexOf(LF, p)
    if (lf === -1) lf = end
    const head = buf.toString('latin1', p, Math.min(lf, p + CODEX_HEAD))
    if (CODEX_MARKERS.some((marker) => head.includes(marker))) {
      const obj = parseJson(buf.toString('utf8', p, buf[lf - 1] === CR && lf - 1 >= p ? lf - 1 : lf))
      if (obj) parser.pushObject(obj)
    }
    p = lf + 1
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
