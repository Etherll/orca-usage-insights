// Transcript parsers for Claude Code and Codex JSONL. Pure: no Node built-in or Orca imports.
// Parsers only consume complete lines. An unterminated trailing segment is ignored and the
// caller sends it again with the next chunk, so the scanner cuts chunks at the last LF byte.

import { decodeTable, encodeTable } from './table-codec.mjs';
import { NameDict, tableFromRecords } from './table.mjs';
import { timestampParser } from './time.mjs';

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
// record it has seen, so table() always holds the full deduped set for the file. States from older
// versions are converted when the parser is restored, so an old cache carries over unread.
// state() gives JSON-safe columns; state({ binary: true }) gives typed arrays for a thread message.
export function createClaudeParser(ctx, state, { names } = {}) {
  const { sessionId = '', project = '' } = ctx ?? {};
  const host = ctx?.host ?? 'local';
  const table = restoreTable(state, names);
  const parse = timestampParser();
  const inRange = yearCheck();
  let rowOf = null; // key -> row, built on the first keyed record
  const add = (obj) => {
    if (obj?.type !== 'assistant') return;
    const message = obj.message;
    const usage = message?.usage;
    if (!isObject(usage) || message.model === '<synthetic>') return;
    const ms = typeof obj.timestamp === 'string' ? parse(obj.timestamp) : NaN;
    if (!inRange(ms)) return;
    const key = claudeKey(obj);
    const model = nonEmptyString(message.model) ?? 'unknown';
    const recordProject = lastSegment(obj.cwd) || project;
    const recordSession = nonEmptyString(obj.sessionId) ?? sessionId;
    const cwd = rawCwd(obj.cwd);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite1h = Math.min(cacheWrite, count(usage.cache_creation?.ephemeral_1h_input_tokens));
    if (key === null) {
      table.push(undefined, ms, 'claude', model, recordProject, recordSession, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h);
      return;
    }
    // A message written again (Claude Code writes one line per content block) replaces its row.
    if (rowOf === null) rowOf = keyRows(table);
    const at = rowOf.get(key);
    if (at === undefined) rowOf.set(key, table.push(key, ms, 'claude', model, recordProject, recordSession, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h));
    else table.replace(at, ms, 'claude', model, recordProject, recordSession, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h);
  };
  return {
    push(text) {
      for (const line of completeLines(text)) {
        if (line.includes(CLAUDE_MARKER)) add(parseClaudeLine(line));
      }
    },
    pushObject: add,
    table: () => table,
    records: () => table.toRecords(),
    state: ({ binary = false } = {}) => ({ table: encodeTable(table, { binary }) }),
  };
}

export function createCodexParser(ctx, state, { names } = {}) {
  const { sessionId = '', project = '' } = ctx ?? {};
  const host = ctx?.host ?? 'local';
  let model = state?.model ?? 'codex';
  let currentProject = state?.project ?? project;
  let currentCwd = state?.cwd ?? '';
  let lastTotal = totalOf(state?.lastTotal);
  const table = restoreTable(state, names);
  const parse = timestampParser();
  const inRange = yearCheck();
  const add = (obj) => {
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
        if (lastTotal && sameTotal(lastTotal, total)) return;
        lastTotal = total;
      }
      const usage = payload.info?.last_token_usage;
      if (!isObject(usage)) return;
      const ms = typeof obj.timestamp === 'string' ? parse(obj.timestamp) : NaN;
      if (!inRange(ms)) return;
      const cacheRead = count(usage.cached_input_tokens);
      table.push(
        total ? `codex:${sessionId}:${obj.timestamp}:${total.total_tokens}` : undefined,
        ms, 'codex', model, currentProject, sessionId, currentCwd, host,
        Math.max(0, count(usage.input_tokens) - cacheRead),
        count(usage.output_tokens),
        cacheRead,
        count(usage.cache_write_input_tokens),
        0,
      );
    }
  };
  return {
    push(text) {
      for (const line of completeLines(text)) {
        if (!CODEX_MARKERS.some((marker) => line.includes(marker))) continue;
        const obj = parseJson(line);
        if (obj) add(obj);
      }
    },
    pushObject: add,
    table: () => table,
    records: () => table.toRecords(),
    state: ({ binary = false } = {}) => ({ model, project: currentProject, cwd: currentCwd, lastTotal, table: encodeTable(table, { binary }) }),
  };
}

function restoreTable(state, names = new NameDict()) {
  if (state?.table) return decodeTable(state.table, names);
  const table = tableFromRecords(state?.packed ? unpackRecords(state.packed) : Array.isArray(state?.records) ? state.records : [], names);
  table.frozen = false;
  return table;
}

function keyRows(table) {
  const rows = new Map();
  for (let i = 0; i < table.length; i++) if (table.keys[i] !== undefined) rows.set(table.keys[i], i);
  return rows;
}

// Years before MIN_YEAR or past next year are bad data. The upper bound follows the clock (rechecked hourly).
function yearCheck() {
  const floor = Date.UTC(MIN_YEAR, 0, 1);
  let ceiling = -Infinity;
  let recheckAt = -Infinity;
  return (ms) => {
    if (Number.isNaN(ms)) return false;
    const now = Date.now();
    if (now >= recheckAt) {
      ceiling = Date.UTC(new Date(now).getUTCFullYear() + 2, 0, 1);
      recheckAt = now + 3_600_000;
    }
    return ms >= floor && ms < ceiling;
  };
}

const RECORD_FIELDS = ['key', 'provider', 'ts', 'model', 'project', 'sessionId', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cwd', 'host'];
const STRING_FIELD = RECORD_FIELDS.map((field) => !['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'].includes(field));
const WIDTH = RECORD_FIELDS.length;

// Older caches' records: { s: [strings], r: [WIDTH numbers per record] }, a string field its index in s or -1.
export function unpackRecords(packed) {
  const strings = Array.isArray(packed?.s) ? packed.s : [];
  const rows = Array.isArray(packed?.r) ? packed.r : [];
  const out = [];
  for (let at = 0; at + WIDTH <= rows.length; at += WIDTH) {
    const record = {};
    for (let f = 0; f < WIDTH; f++) {
      const value = rows[at + f];
      if (!STRING_FIELD[f]) record[RECORD_FIELDS[f]] = value;
      else if (value >= 0 && value < strings.length) record[RECORD_FIELDS[f]] = strings[value];
    }
    out.push(record);
  }
  return out;
}

// Message id + request id, null without a message id, so a message copied into a resumed session counts once.
export function claudeKey(obj) {
  const id = nonEmptyString(obj?.message?.id);
  if (!id) return null;
  return `${id}:${nonEmptyString(obj.requestId) ?? ''}`;
}

// cacheWrite1h is the part of cacheWrite with the 1-hour TTL; 0 when usage has no cache_creation split.
export function claudeUsage(usage) {
  const cacheWrite = count(usage.cache_creation_input_tokens);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, count(usage.cache_creation?.ephemeral_1h_input_tokens)),
  };
}

// Codex counts cached input inside input_tokens, so input is the uncached part. No 1-hour write split.
export function codexUsage(last) {
  const cacheRead = count(last.cached_input_tokens);
  return {
    input: Math.max(0, count(last.input_tokens) - cacheRead),
    output: count(last.output_tokens),
    cacheRead,
    cacheWrite: count(last.cache_write_input_tokens),
    cacheWrite1h: 0,
  };
}

// Assistant lines are mostly message.content (text, thinking, tool calls), which no field we
// keep comes from. Claude Code writes message keys in a fixed order: model, id, type, role,
// content, ..., stop_reason, ..., usage. So the line is parsed with content emptied out:
// everything from the first `"content":[` to the `"stop_reason":` just before the last
// `"usage":{`. Any line that doesn't fit that shape, or doesn't parse after the cut, falls back
// to parsing the whole line, so the result is always the same as a full JSON.parse.
export const SLIM_MIN = 1024;
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

export function parseJson(line) {
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
