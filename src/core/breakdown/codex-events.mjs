// Codex rollout lines to breakdown events. Pure: no Node built-ins or Orca imports. Events hold
// sizes, offsets and targets, never transcript text. Usage is read by records.mjs, and a repeated
// token_count is skipped the way records.mjs skips it.
import { codexUsage } from '../records.mjs';
import { EXPLAIN_MARKER } from './claude-events.mjs';
import { agentTarget, commandTarget, injectedTarget, messagesTarget, pathTarget, toolTarget } from './targets.mjs';

const CALLS_MAX = 2000;
const MIN_YEAR = 2020;
const TOTAL_KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const PATCH_FILE = /^\*\*\* (?:Update|Add) File: (.+?)\s*$/m;
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const encoder = new TextEncoder();

// ctx: { home } expands `~/` paths, and { sessionId } names the requests as records.mjs does.
// state: a value from an earlier state() call, so a restored adapter continues the same file.
export function createCodexEvents(ctx = {}, state = null) {
  const home = ctx?.home ?? '';
  const sessionId = ctx?.sessionId ?? '';
  let cwd = state?.cwd ?? '';
  let model = state?.model ?? 'codex';
  let lastTotal = totalOf(state?.lastTotal);
  const calls = new Map(state?.calls ?? []);
  // The user's first prompt has been seen. Codex puts AGENTS.md and tagged context (environment,
  // instructions) in user messages before it, so those don't count.
  let prompted = state?.prompted === true;

  // A token_count whose running total has not moved repeats the one before, so it adds no usage.
  // The running total is tracked even when the line has no last_token_usage, as records.mjs does.
  function tokenCount(obj, payload, where, out) {
    const info = isObject(payload.info) ? payload.info : {};
    const total = totalOf(info.total_token_usage);
    if (total) {
      if (lastTotal && sameTotal(lastTotal, total)) return;
      lastTotal = total;
    }
    const usage = info.last_token_usage;
    if (!isObject(usage) || !isTimestamp(obj.timestamp)) return;
    out.push({
      t: 'request',
      key: total ? `codex:${sessionId}:${obj.timestamp}:${total.total_tokens}` : `anonymous:${sessionId}:${where.offset}`,
      ts: obj.timestamp,
      model,
      usage: codexUsage(usage),
    });
  }

  function responseItem(payload, where, out) {
    switch (payload.type) {
      case 'function_call':
      case 'custom_tool_call': {
        const { target, op } = toolCall(payload);
        call(payload.call_id, target, op, out);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = nonBlank(payload.call_id);
        const target = id ? (calls.get(id) ?? null) : null;
        out.push(arrival('tools', target, { chars: valueChars(payload.output), images: 0 }, where, id));
        break;
      }
      case 'message':
        message(payload, where, out);
        break;
      default:
        break; // reasoning and other item kinds carry nothing the split needs
    }
  }

  function message(payload, where, out) {
    const stats = contentStats(payload.content);
    if (payload.role === 'assistant') out.push({ t: 'reply', chars: stats.chars });
    else if (payload.role === 'user') {
      // A session started from an Explain prompt is marked, so analyze keeps it out of findings.
      if (!prompted) {
        const text = firstText(payload.content).trimStart();
        if (text.startsWith(EXPLAIN_MARKER)) {
          prompted = true;
          out.push({ t: 'explain' });
        } else if (text !== '' && !text.startsWith('<') && !text.startsWith('# AGENTS.md')) {
          prompted = true;
        }
      }
      out.push(arrival('messages', messagesTarget(), stats, where));
    }
    else if (payload.role === 'developer' || payload.role === 'system') {
      out.push(arrival('injected', injectedTarget(), stats, where));
    }
  }

  function call(id, target, op, out) {
    const callId = nonBlank(id) ?? '';
    if (callId) {
      calls.set(callId, target);
      if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
    }
    out.push({ t: 'call', id: callId, target, op });
  }

  // The target and op of a call. A function call carries JSON arguments; a custom tool carries its
  // input as text. Arguments that do not parse read as none.
  function toolCall(payload) {
    const name = typeof payload.name === 'string' ? payload.name : '';
    const args = parseArgs(payload.arguments);
    const input = typeof payload.input === 'string' ? payload.input : typeof args.input === 'string' ? args.input : '';
    switch (name) {
      case 'shell_command':
        return shell(shellText(args.command));
      case 'exec_command':
        return shell(shellText(args.cmd));
      case 'exec':
        return shell(input.split('\n')[0]);
      case 'apply_patch': {
        const target = pathTarget(PATCH_FILE.exec(input)?.[1], cwd, home);
        return target ? { target, op: 'edit' } : { target: toolTarget(name), op: 'other' };
      }
      case 'spawn_agent':
        return { target: agentTarget(args.agent_type), op: 'agent' };
      default:
        return { target: toolTarget(name), op: 'other' };
    }
  }

  return {
    // bytes: the line's UTF-8 length when the caller knows it (saves encoding the line again).
    push(line, offset, bytes = null) {
      const text = String(line);
      if (ignoredHead(text)) return [];
      const obj = parseJson(text);
      if (!obj) return [];
      const payload = isObject(obj.payload) ? obj.payload : {};
      const where = {
        ts: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        offset,
        bytes: bytes ?? encoder.encode(text).length,
      };
      const out = [];
      if (obj.type === 'session_meta') {
        if (nonBlank(payload.cwd) && !cwd) {
          cwd = payload.cwd;
          out.push({ t: 'meta', cwd });
        }
      } else if (obj.type === 'turn_context') {
        model = nonBlank(payload.model) ?? model;
      } else if (obj.type === 'compacted') {
        out.push({ t: 'reset' });
      } else if (obj.type === 'event_msg' && payload.type === 'token_count') {
        tokenCount(obj, payload, where, out);
      } else if (obj.type === 'response_item') {
        responseItem(payload, where, out);
      }
      return out;
    },
    state() {
      return { cwd, model, lastTotal, calls: [...calls], prompted };
    },
  };
}

// Codex writes timestamp, type and payload.type first. Lines whose kinds give no events are
// skipped before parsing: other event_msg kinds, and reasoning and other response items.
const HEAD = /^\{"timestamp":"[^"\\]*","type":"(event_msg|response_item)","payload":\{"type":"([a-z_]+)"/;
const RESPONSE_KINDS = new Set(['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'message']);

function ignoredHead(text) {
  const head = HEAD.exec(text.length > 200 ? text.slice(0, 200) : text);
  if (!head) return false;
  return head[1] === 'event_msg' ? head[2] !== 'token_count' : !RESPONSE_KINDS.has(head[2]);
}

function shell(command) {
  return { target: commandTarget(command), op: 'shell' };
}

// A shell command as text. An argv array is joined, except that `bash -lc <script>` gives its
// script, since the wrapper alone would name no tool.
function shellText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const words = value.filter((word) => typeof word === 'string');
  if (words.length >= 3 && SHELLS.has(words[0].split('/').pop()) && /^-\w*c$/.test(words[1])) return words[2];
  return words.join(' ');
}

// Function-call arguments as an object. Text that is not a JSON object reads as no arguments.
function parseArgs(value) {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return isObject(parsed) ? parsed : {};
}

// One arrival of content into the context. A line with several results gives one arrival per
// result, and each carries the line's offset and bytes.
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

// Text length and image count of a content value: a string, or an array of content blocks.
function firstText(content) {
  if (typeof content === 'string') return content;
  const block = Array.isArray(content) ? content.find((b) => typeof b?.text === 'string') : null;
  return block?.text ?? '';
}

function contentStats(content) {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  const stats = { chars: 0, images: 0 };
  if (!Array.isArray(content)) return stats;
  for (const block of content.filter(isObject)) {
    if (block.type === 'input_image' || block.type === 'image') stats.images += 1;
    else stats.chars += lengthOf(block.text);
  }
  return stats;
}

// Size of a value as text: the length of a string, or of its JSON.
function valueChars(value) {
  if (value === undefined || value === null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function lengthOf(value) {
  return typeof value === 'string' ? value.length : 0;
}

// Normalized running total from info.total_token_usage, or null when there is none.
function totalOf(value) {
  if (!isObject(value) || !TOTAL_KEYS.some((key) => typeof value[key] === 'number')) return null;
  return Object.fromEntries(TOTAL_KEYS.map((key) => [key, count(value[key])]));
}

function sameTotal(a, b) {
  return TOTAL_KEYS.every((key) => a[key] === b[key]);
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
