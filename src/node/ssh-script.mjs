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
  'roots_antigravity() {',
  '  a="${ANTIGRAVITY_APP_DATA_DIR:-${ANTIGRAVITY_CLI_DIR:-$HOME/.gemini/antigravity-cli}}"',
  "  printf '%s/conversations\\n' \"$a\"",
  '}',
  "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then GNU=1; else GNU=0; fi",
  'seen=""',
  'list() {',
  '  kind=$1; pat=${2:-*.jsonl}',
  '  while IFS= read -r d; do',
  '    [ -d "$d" ] || continue',
  '    real=$(cd "$d" 2>/dev/null && pwd -P) || continue',
  '    case " $seen " in *" $real "*) continue ;; esac',
  '    seen="$seen $real"',
  '    if [ "$GNU" = 1 ]; then',
  "      find \"$real\" -type f -name \"$pat\" -printf \"$RS\"\"F\\t$kind\\t%s\\t%T@\\t%p\\n\" 2>/dev/null",
  '    else',
  "      find \"$real\" -type f -name \"$pat\" -exec stat -f \"$RS\"\"F\t$kind\t%z\t%m\t%N\" {} + 2>/dev/null",
  '    fi',
  '  done',
  '}',
  'roots_claude | list claude',
  'roots_codex | list codex',
  'if command -v python3 >/dev/null 2>&1; then',
  '  roots_antigravity | while IFS= read -r d; do',
  '    [ -d "$d" ] || continue',
  '    real=$(cd "$d" 2>/dev/null && pwd -P) || continue',
  '    case " $seen " in *" $real "*) continue ;; esac',
  '    seen="$seen $real"',
  `    python3 -c 'import os,sys; d=sys.argv[1]; rs="\\x1e"\nfor e in sorted(os.scandir(d), key=lambda x: x.name):\n  if not e.name.endswith(".db") or not (e.is_file() or e.is_symlink()): continue\n  try: st=os.stat(e.path)\n  except OSError: continue\n  sz=st.st_size; mt=st.st_mtime\n  try:\n    wst=os.stat(e.path+"-wal"); sz+=wst.st_size\n    if wst.st_mtime>mt: mt=wst.st_mtime\n  except OSError: pass\n  sys.stdout.write(f"{rs}F\\tantigravity\\t{sz}\\t{mt:.6f}\\t{e.path}\\n")' "$real" 2>/dev/null`,
  '  done',
  'fi',
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
        return {'type': t, 'timestamp': o.get('timestamp'), 'payload': {'model': p.get('model'), 'turn_id': p.get('turn_id')}}
    if t == 'session_meta':
        return {'type': t, 'timestamp': o.get('timestamp'), 'payload': {'id': p.get('id'), 'cwd': p.get('cwd')}}
    if t == 'event_msg' and p.get('type') == 'token_count':
        return {'type': t, 'id': o.get('id'), 'timestamp': o.get('timestamp'), 'payload': {'id': p.get('id'), 'type': 'token_count', 'info': p.get('info')}}
    return None
def _rv(buf, i):
    v = s = 0
    n = len(buf)
    lim = min(n, i + 10)
    while i < lim:
        b = buf[i]; i += 1
        v |= (b & 0x7f) << s
        if not (b & 0x80): return v, i
        s += 7
    return None, i
def _pb(buf):
    i, n = 0, len(buf)
    while i < n:
        tag, i = _rv(buf, i)
        if tag is None: return
        fn, wt = tag >> 3, tag & 7
        if fn <= 0: return
        if wt == 0:
            v, i = _rv(buf, i)
            if v is None: return
            yield fn, 0, v
        elif wt == 1:
            if i + 8 > n: return
            yield fn, 1, buf[i:i+8]; i += 8
        elif wt == 2:
            ln, i = _rv(buf, i)
            if ln is None or i + ln > n: return
            yield fn, 2, buf[i:i+ln]; i += ln
        elif wt == 5:
            if i + 4 > n: return
            yield fn, 5, buf[i:i+4]; i += 4
        else:
            return
def _ts_ms(buf):
    sec = nano = 0; has = False
    for fn, wt, val in _pb(buf):
        if wt != 0: return None
        if fn == 1: sec = val; has = True
        elif fn == 2: nano = val
        else: return None
    if not has or sec < 1577836800 or sec > 2524608000: return None
    return sec * 1000 + nano // 1000000
def _step_ms(buf):
    found = {}
    for fn, wt, val in _pb(buf):
        if wt != 2: continue
        ms = _ts_ms(val)
        if ms is not None:
            if fn == 1: return ms
            found.setdefault(fn, ms)
    for fn in (1, 6, 7, 8):
        if fn in found: return found[fn]
    return next(iter(found.values()), None)
def read_antigravity(path):
    import sqlite3, urllib.parse
    try:
        st = os.stat(path)
        conn = sqlite3.connect('file:' + urllib.parse.quote(path, safe='/') + '?mode=ro', uri=True, timeout=2.0)
    except Exception:
        return -1
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if 'gen_metadata' not in tables:
            return st.st_size
        cwd = ''; fallback_ms = int(st.st_mtime * 1000); sid = os.path.splitext(os.path.basename(path))[0]
        if 'trajectory_metadata_blob' in tables:
            row = conn.execute('SELECT data FROM trajectory_metadata_blob LIMIT 1').fetchone()
            if row and row[0]:
                for fn, wt, val in _pb(row[0]):
                    if wt != 2: continue
                    if fn == 1 and not cwd:
                        for sf, sw, sv in _pb(val):
                            if sf == 1 and sw == 2:
                                u = sv.decode('utf-8', 'replace').strip()
                                cwd = urllib.parse.unquote(u[7:]) if u.startswith('file://') else u
                                break
                    elif fn == 2:
                        ms = _ts_ms(val)
                        if ms is not None: fallback_ms = ms
                    elif fn == 6 and val:
                        sid = val.decode('utf-8', 'replace').strip() or sid
        has_steps = 'steps' in tables
        step_cache = {}
        last_ms = fallback_ms
        for idx, blob in conn.execute('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').fetchall():
            if not blob: continue
            inner = next((val for fn, wt, val in _pb(blob) if fn == 1 and wt == 2), None)
            if not inner: continue
            model = ''; usage_b = None; req = ''; cid = ''; step_idx = -1
            for fn, wt, val in _pb(inner):
                if wt != 2: continue
                if fn == 4: usage_b = val
                elif fn == 19: model = val.decode('utf-8', 'replace').strip()
                elif fn == 20:
                    k = v = ''
                    for sf, sw, sv in _pb(val):
                        if sw == 2:
                            if sf == 1: k = sv.decode('utf-8', 'replace')
                            elif sf == 2: v = sv.decode('utf-8', 'replace')
                    if k == 'request_id' and v: req = v
                    elif k == 'cascade_id' and v: cid = v
                    elif k == 'last_step_index' and v.isdigit(): step_idx = int(v)
            if not usage_b: continue
            inp = out = cr = th = tx = 0
            for fn, wt, val in _pb(usage_b):
                if wt != 0: continue
                if fn == 2: inp = val
                elif fn == 3: out = val
                elif fn == 5: cr = val
                elif fn == 9: th = val
                elif fn == 10: tx = val
            if out == 0 and (th > 0 or tx > 0): out = th + tx
            if inp == 0 and out == 0 and cr == 0: continue
            ms = None
            if has_steps and step_idx >= 0:
                if step_idx not in step_cache:
                    sr = conn.execute('SELECT metadata FROM steps WHERE idx = ?', (step_idx,)).fetchone()
                    step_cache[step_idx] = _step_ms(sr[0]) if sr and sr[0] else None
                ms = step_cache[step_idx]
            if ms is None: ms = last_ms
            last_ms = ms
            rec_sid = cid or sid
            rec = {'type': 'antigravity_usage', 'key': 'antigravity:' + (req or f'{rec_sid}:{idx}'), 'ms': ms, 'model': model or 'unknown', 'cwd': cwd, 'sessionId': rec_sid, 'input': inp, 'output': out, 'cacheRead': cr}
            w(json.dumps(rec, separators=(',', ':'), ensure_ascii=False).encode('utf-8', 'surrogatepass') + b'\n')
        return st.st_size
    except Exception:
        return -1
    finally:
        try: conn.close()
        except Exception: pass
for job in sys.stdin.read().split('\n'):
    if not job:
        continue
    kind, off, sz, path = job.split('\t', 3)
    off, sz = int(off), int(sz)
    w((RS + 'B\t' + path + '\n').encode('utf-8', 'surrogateescape'))
    if kind == 'antigravity':
        res = read_antigravity(path)
        w((RS + 'N\t' + str(res) + '\n').encode())
        continue
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
    '  if [ "$4" = antigravity ]; then printf \'\\036N\\t0\\n\'; return; fi',
    '  if [ ! -r "$p" ]; then printf \'\\036N\\t-1\\n\'; return; fi',
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
    return { kind: job.kind === 'codex' ? 'codex' : job.kind === 'antigravity' ? 'antigravity' : 'claude', path: String(job.path), off, size };
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
    if ((kind !== 'claude' && kind !== 'codex' && kind !== 'antigravity') || !path || !/^\d+$/.test(size)) continue;
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
