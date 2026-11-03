// Transcript parsers for Claude Code and Codex JSONL. Pure: no Node built-in or Orca imports.
// Parsers only consume complete lines. An unterminated trailing segment is ignored and the
// caller sends it again with the next chunk, so the scanner cuts chunks at the last LF byte.

// Line markers. providers.mjs builds LINE_MARKERS from these, so records.mjs cannot import it.
const CLAUDE_MARKER = '"usage"';
export const CLAUDE_MARKERS = [CLAUDE_MARKER];
export const CODEX_MARKERS = ['token_count', 'turn_context', 'session_meta'];
const TOTAL_KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const MIN_YEAR = 2020;

export function parseClaudeTranscript(text, ctx) {
  const parser = createClaudeParser(ctx);
  parser.push(`${text}\n`);
  return parser.records();
}

export function parseCodexTranscript(text, ctx) {
  const parser = createCodexParser(ctx);
  parser.push(`${text}\n`);
  return parser.records();
}

// `state` is a value returned by an earlier parser's state(). A restored parser keeps every
// record it has seen, so records() always returns the full deduped set for the file.
export function createClaudeParser(ctx, state) {
  const { sessionId = '', project = '' } = ctx ?? {};
  const host = ctx?.host ?? 'local';
  const seen = new Map(state?.seen ?? []);
  let anonymous = state?.anonymous ?? 0;
  return {
    push(text) {
      for (const line of completeLines(text)) {
        const record = claudeRecord(line, { sessionId, project, host });
        if (!record) continue;
        seen.set(record.key ?? `anonymous:${anonymous++}`, record);
      }
    },
    records() {
      return [...seen.values()];
    },
    state() {
      return { seen: [...seen], anonymous };
    },
  };
}

export function createCodexParser(ctx, state) {
  const { sessionId = '', project = '' } = ctx ?? {};
  const host = ctx?.host ?? 'local';
  let model = state?.model ?? 'codex';
  let currentProject = state?.project ?? project;
  let currentCwd = state?.cwd ?? '';
  let lastTotal = totalOf(state?.lastTotal);
  const records = [...(state?.records ?? [])];
  return {
    push(text) {
      for (const line of completeLines(text)) {
        if (!CODEX_MARKERS.some((marker) => line.includes(marker))) continue;
        const obj = parseJson(line);
        if (!obj) continue;
        const payload = isObject(obj.payload) ? obj.payload : {};
        if (obj.type === 'turn_context') {
          model = nonEmptyString(payload.model) ?? model;
        } else if (obj.type === 'session_meta') {
          currentProject = lastSegment(payload.cwd) || project;
          currentCwd = rawCwd(payload.cwd);
        } else if (obj.type === 'event_msg' && payload.type === 'token_count') {
          // Codex repeats a token_count whose running total has not moved. A repeat adds no usage.
          const total = totalOf(payload.info?.total_token_usage);
          if (total) {
            if (lastTotal && sameTotal(lastTotal, total)) continue;
            lastTotal = total;
          }
          const usage = payload.info?.last_token_usage;
          if (!isObject(usage) || !isTimestamp(obj.timestamp)) continue;
          const cacheRead = count(usage.cached_input_tokens);
          records.push({
            provider: 'codex',
            ts: obj.timestamp,
            model,
            project: currentProject,
            sessionId,
            input: Math.max(0, count(usage.input_tokens) - cacheRead),
            output: count(usage.output_tokens),
            cacheRead,
            cacheWrite: 0,
            cwd: currentCwd,
            host,
          });
        }
      }
    },
    records() {
      return [...records];
    },
    state() {
      return { model, project: currentProject, cwd: currentCwd, lastTotal, records: [...records] };
    },
  };
}

// `key` (message id + request id) is set only when the line has a message id. The scanner uses
// it to count a message copied into a resumed session once.
function claudeRecord(line, ctx) {
  if (!line.includes(CLAUDE_MARKER)) return null;
  const obj = parseClaudeLine(line);
  if (obj?.type !== 'assistant') return null;
  const message = obj.message;
  const usage = message?.usage;
  if (!isObject(usage) || message.model === '<synthetic>') return null;
  if (!isTimestamp(obj.timestamp)) return null;
  const id = nonEmptyString(message.id);
  const requestId = nonEmptyString(obj.requestId) ?? '';
  return {
    ...(id ? { key: `${id}:${requestId}` } : {}),
    provider: 'claude',
    ts: obj.timestamp,
    model: nonEmptyString(message.model) ?? 'unknown',
    project: lastSegment(obj.cwd) || ctx.project,
    sessionId: nonEmptyString(obj.sessionId) ?? ctx.sessionId,
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cwd: rawCwd(obj.cwd),
    host: ctx.host,
  };
}

// Assistant lines are mostly message.content (text, thinking, tool calls), which no field we
// keep comes from. Claude Code writes message keys in a fixed order: model, id, type, role,
// content, ..., stop_reason, ..., usage. So the line is parsed with content emptied out:
// everything from the first `"content":[` to the `"stop_reason":` just before the last
// `"usage":{`. Any line that doesn't fit that shape, or doesn't parse after the cut, falls back
// to parsing the whole line, so the result is always the same as a full JSON.parse.
const SLIM_MIN = 1024;
function parseClaudeLine(line) {
  if (line.length >= SLIM_MIN) {
    const content = line.indexOf('"content":[');
    const usage = line.lastIndexOf('"usage":{');
    const stop = usage > 0 ? line.lastIndexOf('"stop_reason":', usage) : -1;
    if (content > 0 && stop > content) {
      const slim = parseJson(`${line.slice(0, content)}"content":[],${line.slice(stop)}`);
      if (isObject(slim?.message) && isObject(slim.message.usage)) return slim;
    }
  }
  return parseJson(line);
}

// Normalized running total from payload.info.total_token_usage, or null when there is none.
function totalOf(value) {
  if (!isObject(value) || !TOTAL_KEYS.some((key) => typeof value[key] === 'number')) return null;
  return Object.fromEntries(TOTAL_KEYS.map((key) => [key, count(value[key])]));
}

function sameTotal(a, b) {
  return TOTAL_KEYS.every((key) => a[key] === b[key]);
}

function completeLines(text) {
  const lines = String(text).split(/\r?\n/);
  lines.pop();
  return lines;
}

function parseJson(line) {
  try {
    const value = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A parseable timestamp in a plausible year. Years before MIN_YEAR or past next year are bad data.
function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= new Date().getUTCFullYear() + 1;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// The cwd exactly as the transcript wrote it, or '' when there is none.
function rawCwd(value) {
  return typeof value === 'string' ? value : '';
}

// Last path segment. Splits on both separators so a Windows cwd parses on any OS.
function lastSegment(path) {
  if (typeof path !== 'string') return '';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
