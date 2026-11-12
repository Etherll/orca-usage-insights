// POSIX sh scripts run on an SSH host (Linux or macOS) and parsers for what they print.
// Nothing here talks to the network; ssh-source.mjs runs these through `ssh <host> sh -s`.
//
// Output framing uses 0x1E (record separator). JSON lines never contain a raw 0x1E (control
// characters must be escaped in JSON), so it can't collide with transcript content.

const RS = '\x1e';

// Lists the *.jsonl transcripts only: compressed .jsonl.zst files are not listed or read over SSH.
// Lists every transcript as `RS F <tab> kind <tab> size <tab> mtime <tab> path`, then `RS E`.
// GNU find has -printf; BSD/macOS find doesn't, so fall back to stat -f in batches.
export const LIST_SCRIPT = [
  'LC_ALL=C; export LC_ALL',
  "RS=$(printf '\\036')",
  'roots_claude() {',
  '  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then',
  "    printf '%s\\n' \"$CLAUDE_CONFIG_DIR\" | tr ',' '\\n' | sed 's/^ *//;s/ *$//' | while IFS= read -r d; do [ -n \"$d\" ] && printf '%s/projects\\n' \"$d\"; done",
  '  else',
  "    printf '%s/.claude/projects\\n' \"$HOME\"",
  "    printf '%s/claude/projects\\n' \"${XDG_CONFIG_HOME:-$HOME/.config}\"",
  '  fi',
  '}',
  'roots_codex() {',
  '  c="${CODEX_HOME:-$HOME/.codex}"',
  "  printf '%s/sessions\\n%s/archived_sessions\\n' \"$c\" \"$c\"",
  '}',
  "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then GNU=1; else GNU=0; fi",
  'seen=""',
  'list() {',
  '  kind=$1',
  '  while IFS= read -r d; do',
  '    [ -d "$d" ] || continue',
  '    real=$(cd "$d" 2>/dev/null && pwd -P) || continue',
  '    case " $seen " in *" $real "*) continue ;; esac',
  '    seen="$seen $real"',
  '    if [ "$GNU" = 1 ]; then',
  "      find \"$real\" -type f -name '*.jsonl' -printf \"$RS\"\"F\\t$kind\\t%s\\t%T@\\t%p\\n\" 2>/dev/null",
  '    else',
  "      find \"$real\" -type f -name '*.jsonl' -exec stat -f \"$RS\"\"F\t$kind\t%z\t%m\t%N\" {} + 2>/dev/null",
  '    fi',
  '  done',
  '}',
  'roots_claude | list claude',
  'roots_codex | list codex',
  "printf '%sE\\n' \"$RS\"",
  '',
].join('\n');

// awk only rewrites long Claude lines (cuts message content, the same rule as records.mjs
// parseClaudeLine); grep has already kept just the marker lines, so awk sees ~15% of the bytes.
const AWK = String.raw`
function lastidx(s, t,   i, j, k) { k = 0; i = 0; while ((j = index(substr(s, i + 1), t)) > 0) { i += j; k = i } return k }
function slim(l,   c, u, s) {
  if (length(l) < 1024) return l
  c = index(l, "\"content\":[")
  u = lastidx(l, "\"usage\":{")
  if (c == 0 || u == 0) return l
  s = lastidx(substr(l, 1, u - 1), "\"stop_reason\":")
  if (s <= c) return l
  return substr(l, 1, c - 1) "\"content\":[]," substr(l, s)
}
{ print slim($0) }
`;

// Preferred reader when the host has python3 (almost every Linux server, and macOS with the
// developer tools): it parses each kept line on the host and sends back only the fields the
// local parsers read, about a tenth of the bytes, which matters on slow links.
const PY = String.raw`
import json, os, sys
RS = '\x1e'
w = sys.stdout.buffer.write
KEEP = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation')
def usage(u):
    r = {k: u[k] for k in KEEP if k in u}
    c = r.get('cache_creation')
    if isinstance(c, dict):
        r['cache_creation'] = {k: v for k, v in c.items() if isinstance(v, (int, float))}
    return r
def claude(o):
    m = o.get('message')
    if o.get('type') != 'assistant' or not isinstance(m, dict) or not isinstance(m.get('usage'), dict):
        return None
    u = m['usage']
    return {'type': 'assistant', 'timestamp': o.get('timestamp'), 'requestId': o.get('requestId'), 'cwd': o.get('cwd'),
            'sessionId': o.get('sessionId'), 'message': {'model': m.get('model'), 'id': m.get('id'), 'usage': usage(u)}}
def codex(o):
    t = o.get('type')
    p = o.get('payload') if isinstance(o.get('payload'), dict) else {}
    if t == 'turn_context':
        return {'type': t, 'timestamp': o.get('timestamp'), 'payload': {'model': p.get('model')}}
    if t == 'session_meta':
        return {'type': t, 'timestamp': o.get('timestamp'), 'payload': {'cwd': p.get('cwd')}}
    if t == 'event_msg' and p.get('type') == 'token_count':
        return {'type': t, 'timestamp': o.get('timestamp'), 'payload': {'type': 'token_count', 'info': p.get('info')}}
    return None
for job in sys.stdin.read().split('\n'):
    if not job:
        continue
    kind, off, sz, path = job.split('\t', 3)
    off, sz = int(off), int(sz)
    w((RS + 'B\t' + path + '\n').encode('utf-8', 'surrogateescape'))
    try:
        if os.stat(path).st_size < sz:
            w((RS + 'N\t-1\n').encode())
            continue
        with open(path, 'rb') as f:
            # A stored offset always follows an LF; any other byte means the file was rewritten.
            if off > 0:
                f.seek(off - 1)
                if f.read(1) != b'\n':
                    w((RS + 'N\t-1\n').encode())
                    continue
            f.seek(off)
            data = f.read(max(0, sz - off))
    except OSError:
        w((RS + 'N\t-1\n').encode())
        continue
    cut = data.rfind(b'\n') + 1
    marks = (b'"usage"',) if kind == 'claude' else (b'token_count', b'turn_context', b'session_meta')
    pick = claude if kind == 'claude' else codex
    for raw in data[:cut].split(b'\n'):
        if not any(m in raw for m in marks):
            continue
        try:
            o = json.loads(raw.decode('utf-8', 'replace'))
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        r = pick(o)
        if r is not None:
            w(json.dumps(r, separators=(',', ':'), ensure_ascii=False).encode('utf-8', 'surrogatepass') + b'\n')
    w((RS + 'N\t' + str(cut) + '\n').encode())
`;

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Reads [offset, size) of each file. Per file prints `RS B <tab> path`, the kept lines, then
// `RS N <tab> bytes` (bytes of complete lines consumed), and `RS E` at the very end.
export function readScript(jobs) {
  const lines = [
    'LC_ALL=C; export LC_ALL',
    `AWKP=${shq(AWK)}`,
    'one() {',
    '  p=$1; off=$2; sz=$3; n=$((sz - off))',
    "  printf '\\036B\\t%s\\n' \"$p\"",
    // Unreadable, vanished or shrunk since the listing: -1 tells the caller to read it whole next time.
    "  if [ ! -r \"$p\" ]; then printf '\\036N\\t-1\\n'; return; fi",
    "  cur=$(wc -c < \"$p\" 2>/dev/null | tr -d ' ') || cur=0",
    "  if [ -z \"$cur\" ] || [ \"$cur\" -lt \"$sz\" ]; then printf '\\036N\\t-1\\n'; return; fi",
    "  if [ \"$n\" -le 0 ]; then printf '\\036N\\t0\\n'; return; fi",
    "  if [ \"$off\" -gt 0 ] && [ \"$(tail -c +\"$off\" \"$p\" 2>/dev/null | head -c 1 | od -An -tx1 | tr -d ' \\n')\" != 0a ]; then printf '\\036N\\t-1\\n'; return; fi",
    // Only bytes up to the last LF in [off, sz) are consumed; a half-written last line waits.
    "  last=$(tail -c +\"$sz\" \"$p\" 2>/dev/null | head -c 1 | od -An -tx1 | tr -d ' \\n')",
    '  if [ "$last" != "0a" ]; then',
    '    plen=$(tail -c +"$((off + 1))" "$p" 2>/dev/null | head -c "$n" | tail -n 1 | wc -c)',
    '    n=$((n - plen))',
    '  fi',
    "  if [ \"$n\" -gt 0 ]; then",
    "    if [ \"$4\" = codex ]; then pick() { grep -F -e token_count -e turn_context -e session_meta; }; else pick() { grep -F -e '\"usage\"'; }; fi",
    "    tail -c +\"$((off + 1))\" \"$p\" 2>/dev/null | head -c \"$n\" | pick | awk \"$AWKP\"",
    '  fi',
    "  printf '\\036N\\t%d\\n' \"$n\"",
    '}',
  ];
  const calls = jobs.map((job) => {
    const off = Math.max(0, Math.floor(job.offset) || 0);
    const size = Math.max(0, Math.floor(job.size) || 0);
    return { kind: job.kind === 'codex' ? 'codex' : 'claude', path: String(job.path), off, size };
  });
  // Paths with a newline can't be framed; they never come out of the listing either.
  const safe = calls.filter((c) => !c.path.includes('\n'));
  lines.push(`PYP=${shq(PY)}`);
  lines.push('if command -v python3 >/dev/null 2>&1; then');
  lines.push("python3 -c \"$PYP\" <<'__USAGE_JOBS__'");
  for (const c of safe) lines.push(`${c.kind}\t${c.off}\t${c.size}\t${c.path}`);
  lines.push('__USAGE_JOBS__');
  lines.push('else');
  for (const c of safe) lines.push(`one ${shq(c.path)} ${c.off} ${c.size} ${c.kind}`);
  lines.push('fi');
  lines.push("printf '\\036E\\n'");
  return `${lines.join('\n')}\n`;
}

// Parses LIST_SCRIPT output. Returns null unless the end marker arrived (a cut-off listing must
// not be mistaken for "these are all the files").
export function parseListing(text) {
  const files = [];
  let complete = false;
  for (const raw of String(text).split('\n')) {
    if (!raw.startsWith(RS)) continue;
    if (raw === `${RS}E`) {
      complete = true;
      continue;
    }
    if (!raw.startsWith(`${RS}F\t`)) continue;
    const [, kind, size, mtime, ...rest] = raw.slice(1).split('\t');
    const path = rest.join('\t');
    if ((kind !== 'claude' && kind !== 'codex') || !path || !/^\d+$/.test(size)) continue;
    files.push({ kind, path, size: Number(size), key: `${size}:${mtime}` });
  }
  return complete ? files : null;
}

// Incremental reader for readScript output. Feed it stdout text as it arrives; it calls
// onLines(path, text) for kept lines (in order, possibly several times per file) and
// onDone(path, bytes) when a file block ends. `end()` returns true when the final marker arrived.
export function createReadParser({ onLines, onDone }) {
  let buffer = '';
  let current = null;
  let pending = [];
  let pendingSize = 0;
  let finished = false;
  const flushLines = () => {
    if (current !== null && pending.length) onLines(current, `${pending.join('\n')}\n`);
    pending = [];
    pendingSize = 0;
  };
  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith(RS)) {
          const tag = line[1];
          if (tag === 'B') {
            flushLines();
            current = line.slice(3);
          } else if (tag === 'N') {
            flushLines();
            const bytes = Number(line.slice(3));
            if (current !== null) onDone(current, Number.isFinite(bytes) ? bytes : -1);
            current = null;
          } else if (tag === 'E') {
            finished = true;
          }
          continue;
        }
        if (current === null) continue;
        pending.push(line);
        pendingSize += line.length;
        if (pendingSize > 1 << 20) flushLines();
      }
    },
    end() {
      return finished;
    },
  };
}
