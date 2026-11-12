// Claude Code transcript lines to breakdown events. Pure: no Node built-ins or Orca imports.
// Events hold sizes, offsets and targets, never transcript text. Usage is read by records.mjs, so
// the breakdown and the usage totals count each message the same way.
import { claudeKey, claudeUsage } from '../records.mjs';
import {
  agentTarget, attachmentTarget, commandTarget, injectedTarget, mcpTarget, messagesTarget, pathTarget,
  searchTarget, summaryTarget, toolTarget, webSearchTarget, webTarget,
} from './targets.mjs';

const SEEN_MAX = 5000;
const CALLS_MAX = 2000;
const MIN_YEAR = 2020;
const FILE_OPS = new Map([
  ['Read', 'read'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Write', 'write'],
]);
const encoder = new TextEncoder();

// ctx: { home } expands `~/` paths, and { sessionId } names a request whose message has no id.
// state: a value from an earlier state() call, so a restored adapter continues the same file.
export function createClaudeEvents(ctx = {}, state = null) {
  const home = ctx?.home ?? '';
  const fallbackSession = ctx?.sessionId ?? '';
  let cwd = state?.cwd ?? '';
  let sessionId = state?.sessionId ?? '';
  let agentId = state?.agentId ?? '';
  const seen = new Set(state?.seen ?? []);
  const calls = new Map(state?.calls ?? []);

  // Meta carries each of cwd, sessionId and agentId once, the first time the file shows it.
  function learn(obj, out) {
    const meta = {};
    if (nonBlank(obj.cwd) && !cwd) {
      cwd = obj.cwd;
      meta.cwd = cwd;
    }
    if (nonBlank(obj.sessionId) && !sessionId) {
      sessionId = obj.sessionId;
      meta.sessionId = sessionId;
    }
    if (nonBlank(obj.agentId) && !agentId) {
      agentId = obj.agentId;
      meta.agentId = agentId;
    }
    if (Object.keys(meta).length > 0) out.push({ t: 'meta', ...meta });
  }

  // A message's usage counts once per key. Each of its content lines still gives its own events.
  function assistant(obj, where, out) {
    const message = isObject(obj.message) ? obj.message : {};
    if (isObject(message.usage) && message.model !== '<synthetic>' && isTimestamp(obj.timestamp)) {
      const key = claudeKey(obj);
      if (!key || !seen.has(key)) {
        if (key) remember(key);
        out.push({
          t: 'request',
          key: key ?? `anonymous:${sessionId || fallbackSession}:${where.offset}`,
          ts: obj.timestamp,
          model: nonBlank(message.model) ?? 'unknown',
          usage: claudeUsage(message.usage),
        });
      }
    }
    for (const block of blocksOf(message.content)) {
      if (block.type === 'tool_use') call(block, out);
      else if (block.type === 'text') out.push({ t: 'reply', chars: lengthOf(block.text) });
    }
  }

  // Tool results arrive as tool arrivals, each tied to its call. The rest of the line is one
  // arrival: a compaction summary, injected meta text, or a plain message.
  function user(obj, where, out) {
    const message = isObject(obj.message) ? obj.message : {};
    const rest = [];
    for (const block of blocksOf(message.content)) {
      if (block.type !== 'tool_result') {
        rest.push(block);
        continue;
      }
      const id = nonBlank(block.tool_use_id);
      const target = id ? (calls.get(id) ?? null) : null;
      out.push(arrival('tools', target, contentStats(block.content), where, id));
    }
    if (rest.length === 0) return;
    const stats = contentStats(rest);
    if (obj.isCompactSummary === true) out.push(arrival('compaction', summaryTarget(), stats, where));
    else if (obj.isMeta === true) out.push(arrival('injected', injectedTarget(), stats, where));
    else {
      const event = arrival('messages', messagesTarget(), stats, where);
      // A session started from an Explain prompt is marked (the text itself is never kept).
      if (startsWithMarker(rest)) event.explain = true;
      out.push(event);
    }
  }

  function call(block, out) {
    const id = nonBlank(block.id) ?? '';
    const { target, op } = toolUse(block);
    if (id) {
      calls.set(id, target);
      if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
    }
    out.push({ t: 'call', id, target, op });
  }

  // The target and op of a tool call. A file tool with no usable path, and any tool this file does
  // not name, is an `other` call on the tool itself.
  function toolUse(block) {
    const name = typeof block.name === 'string' ? block.name : '';
    const input = isObject(block.input) ? block.input : {};
    if (FILE_OPS.has(name)) {
      const target = pathTarget(input.file_path ?? input.notebook_path, cwd, home);
      return target ? { target, op: FILE_OPS.get(name) } : { target: toolTarget(name), op: 'other' };
    }
    switch (name) {
      case 'Grep':
      case 'Glob':
        return { target: searchTarget(input.path, cwd, home), op: 'search' };
      case 'Bash':
        return { target: commandTarget(input.command), op: 'shell' };
      case 'WebFetch':
        return { target: webTarget(input.url), op: 'web' };
      case 'WebSearch':
        return { target: webSearchTarget(), op: 'web' };
      case 'Agent':
      case 'Task':
        return { target: agentTarget(input.subagent_type), op: 'agent' };
      default: {
        const server = /^mcp__(.+?)__/.exec(name);
        return server ? { target: mcpTarget(server[1]), op: 'mcp' } : { target: toolTarget(name), op: 'other' };
      }
    }
  }

  function remember(key) {
    seen.add(key);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  }

  return {
    // bytes: the line's UTF-8 length when the caller knows it (saves encoding the line again).
    push(line, offset, bytes = null) {
      const text = String(line);
      // Lines that open with a type this adapter ignores (api-request, queue-operation, ...) are
      // skipped unparsed once the file's cwd and session are known and the line names no agent.
      if (cwd && sessionId && (agentId || !text.includes('"agentId"'))) {
        const head = HEAD.exec(text.length > 64 ? text.slice(0, 64) : text);
        if (head && !HANDLED.has(head[1])) return [];
      }
      const obj = parseJson(text);
      if (!obj) return [];
      const where = {
        ts: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        offset,
        bytes: bytes ?? encoder.encode(text).length,
      };
      const out = [];
      learn(obj, out);
      if (obj.type === 'assistant') {
        assistant(obj, where, out);
      } else if (obj.type === 'user') {
        user(obj, where, out);
      } else if (obj.type === 'attachment') {
        const target = attachmentTarget(obj.attachment?.type);
        out.push(arrival('injected', target, { chars: attachmentChars(obj, text), images: 0 }, where));
      } else if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
        out.push({ t: 'reset' });
      }
      return out;
    },
    state() {
      return { cwd, sessionId, agentId, seen: [...seen], calls: [...calls] };
    },
  };
}

// One arrival of content into the context. A line with several tool results gives one arrival
// per result, and each carries the line's offset and bytes.
export const EXPLAIN_MARKER = '<!-- usage-insights explain v1 -->';

function startsWithMarker(blocks) {
  const first = blocks.find((block) => typeof block?.text === 'string');
  return typeof first?.text === 'string' && first.text.trimStart().startsWith(EXPLAIN_MARKER);
}

function arrival(bucket, target, stats, where, callId) {
  return {
    t: 'arrival',
    ts: where.ts,
    bucket,
    target,
    chars: stats.chars,
    images: stats.images,
    offset: where.offset,
    bytes: where.bytes,
    ...(callId ? { callId } : {}),
  };
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

// Text length and image count of a content value: a string, or an array of content blocks.
function contentStats(content) {
  const stats = { chars: 0, images: 0 };
  for (const block of blocksOf(content)) {
    if (block.type === 'image') stats.images += 1;
    else stats.chars += lengthOf(block.text);
  }
  return stats;
}

const HEAD = /^\{"type":"([^"\\]*)"/;
const HANDLED = new Set(['assistant', 'user', 'attachment', 'system']);

// JSON length of obj.attachment. Claude Code writes each line with JSON.stringify, so it is the
// line's length less the rest of the line: no need to serialise a large attachment again.
function attachmentChars(obj, text) {
  if (obj.attachment === undefined || obj.attachment === null) return 0;
  const chars = text.length - JSON.stringify({ ...obj, attachment: 0 }).length + 1;
  return chars > 0 ? chars : valueChars(obj.attachment);
}

// Size of a value as text: the length of a string, or of its JSON.
function valueChars(value) {
  if (value === undefined || value === null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function lengthOf(value) {
  return typeof value === 'string' ? value.length : 0;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// A parseable timestamp in a plausible year, as records.mjs accepts them.
function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= new Date().getUTCFullYear() + 1;
}
