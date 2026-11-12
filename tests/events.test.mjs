import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClaudeEvents } from '../src/core/breakdown/claude-events.mjs';
import { createCodexEvents } from '../src/core/breakdown/codex-events.mjs';
import { parseClaudeTranscript, parseCodexTranscript } from '../src/core/records.mjs';

const ENCODER = new TextEncoder();
const KINDS = ['file', 'folder', 'command', 'agent', 'web', 'mcp', 'tool', 'messages', 'injected', 'summary'];
const OPS = ['read', 'edit', 'write', 'shell', 'search', 'agent', 'web', 'mcp', 'other'];
const BUCKETS = ['tools', 'messages', 'injected', 'compaction'];
const CLAUDE_CTX = { home: '/home/dev', sessionId: 'claude-sess-1' };
const CODEX_CTX = { home: '/home/dev', sessionId: 'codex-sess-1' };
const CLAUDE = 'breakdown-claude.jsonl';
const CODEX = 'breakdown-codex.jsonl';

const T = {
  readme: { key: 'file:README.md', label: 'README.md', kind: 'file' },
  guide: { key: 'file:docs/guide.md', label: 'docs/guide.md', kind: 'file' },
  app: { key: 'file:src/app.mjs', label: 'src/app.mjs', kind: 'file' },
  src: { key: 'file:src', label: 'src', kind: 'file' },
  settings: { key: 'file:~/.config/tool/settings.json', label: '~/.config/tool/settings.json', kind: 'file' },
  temp: { key: 'folder:(temp files)', label: '(temp files)', kind: 'folder' },
  gitCommit: { key: 'command:$ git commit', label: '$ git commit', kind: 'command' },
  gitStatus: { key: 'command:$ git status', label: '$ git status', kind: 'command' },
  npmTest: { key: 'command:$ npm test', label: '$ npm test', kind: 'command' },
  ls: { key: 'command:$ ls', label: '$ ls', kind: 'command' },
  node: { key: 'command:$ node', label: '$ node', kind: 'command' },
  docs: { key: 'web:docs.example.org', label: 'docs.example.org', kind: 'web' },
  webSearch: { key: 'web:(web search)', label: '(web search)', kind: 'web' },
  github: { key: 'mcp:github', label: 'github', kind: 'mcp' },
  general: { key: 'agent:general-purpose', label: 'agent: general-purpose', kind: 'agent' },
  explorer: { key: 'agent:explorer', label: 'agent: explorer', kind: 'agent' },
  waitAgent: { key: 'tool:wait_agent', label: 'wait_agent', kind: 'tool' },
  webSearchTool: { key: 'tool:web_search', label: 'web_search', kind: 'tool' },
  hook: { key: 'injected:attachment:hook_additional_context', label: 'attachment: hook_additional_context', kind: 'injected' },
  summary: { key: 'summary', label: 'compaction summary', kind: 'summary' },
  messages: { key: 'messages', label: 'messages', kind: 'messages' },
  injected: { key: 'injected', label: 'injected', kind: 'injected' },
};

const at = (hms) => `2026-11-01T${hms}.000Z`;
const tokens = (input, output, cacheRead, cacheWrite, cacheWrite1h = 0) => ({
  input, output, cacheRead, cacheWrite, cacheWrite1h,
});
const meta = (fields) => ({ t: 'meta', ...fields });
const request = (key, ts, model, counts) => ({ t: 'request', key, ts, model, usage: counts });
const call = (id, target, op) => ({ t: 'call', id, target, op });
const reply = (chars) => ({ t: 'reply', chars });
const arrival = (bucket, target, chars, extra = {}) => ({
  t: 'arrival', bucket, target, chars, images: extra.images ?? 0, ...(extra.callId ? { callId: extra.callId } : {}),
});
const RESET = { t: 'reset' };

function claudeExpected(rows) {
  const anon = `anonymous:claude-sess-1:${rows[21].offset}`;
  return [
    [meta({ cwd: '/home/dev/app', sessionId: 'claude-sess-1' }), arrival('messages', T.messages, 61)],
    [request('msg_A:req_A', at('10:00:05'), 'claude-opus-5-5', tokens(12, 80, 4000, 300, 100)),
      reply(31), call('toolu_A1', T.readme, 'read')],
    [call('toolu_A2', T.guide, 'read')],
    [arrival('tools', T.readme, 29, { callId: 'toolu_A1' })],
    [arrival('tools', T.guide, 23, { images: 1, callId: 'toolu_A2' })],
    [request('msg_B:req_B', at('10:00:12'), 'claude-opus-5-5', tokens(20, 40, 4300, 150, 0)),
      call('toolu_B1', T.app, 'edit')],
    [call('toolu_B2', T.gitCommit, 'shell')],
    [arrival('tools', T.app, 24, { callId: 'toolu_B1' }), arrival('tools', T.gitCommit, 33, { callId: 'toolu_B2' })],
    [request('msg_C:req_C', at('10:00:20'), 'claude-sonnet-5-5', tokens(9, 60, 4500, 500, 0)),
      reply(35), call('toolu_C1', T.src, 'search'), call('toolu_C2', T.docs, 'web')],
    [arrival('tools', T.src, 26, { callId: 'toolu_C1' }), arrival('tools', T.docs, 22, { callId: 'toolu_C2' })],
    [request('msg_D:req_D', at('10:00:30'), 'claude-opus-5-5', tokens(15, 25, 5000, 0, 0)),
      call('toolu_D1', T.github, 'mcp'), call('toolu_D2', T.general, 'agent')],
    [arrival('tools', T.github, 29, { callId: 'toolu_D1' }), arrival('tools', T.general, 27, { callId: 'toolu_D2' })],
    [arrival('injected', T.injected, 33)],
    [meta({ agentId: 'agent-x1' }), arrival('injected', T.hook, 73)],
    [],
    [RESET],
    [arrival('compaction', T.summary, 48)],
    [request('msg_E:req_E', at('10:00:40'), 'claude-opus-5-5', tokens(8, 30, 5100, 0, 0)),
      reply(33), call('toolu_E1', T.webSearch, 'web')],
    [arrival('tools', T.webSearch, 20, { callId: 'toolu_E1' })],
    [reply(22)],
    [reply(29)],
    [request(anon, at('10:01:10'), 'claude-opus-5-5', tokens(30, 12, 5200, 0, 0)), reply(34)],
    [arrival('messages', T.messages, 33, { images: 1 })],
    [request('msg_I:req_I', at('10:01:30'), 'claude-opus-5-5', tokens(40, 90, 5300, 700, 700)),
      call('toolu_I1', T.readme, 'read'), call('toolu_I2', T.settings, 'read'), call('toolu_I3', T.temp, 'write')],
    [arrival('tools', T.readme, 25, { callId: 'toolu_I1' }),
      arrival('tools', T.settings, 26, { callId: 'toolu_I2' }),
      arrival('tools', T.temp, 25, { callId: 'toolu_I3' })],
    [],
  ];
}

function codexExpected(rows) {
  const anon = `anonymous:codex-sess-1:${rows[30].offset}`;
  return [
    [meta({ cwd: '/home/dev/app' })],
    [],
    [],
    [arrival('injected', T.injected, 29)],
    [arrival('messages', T.messages, 33)],
    [arrival('injected', T.injected, 24)],
    [request('codex:codex-sess-1:2026-11-01T10:00:01.000Z:1050', at('10:00:01'), 'gpt-codex-5', tokens(700, 50, 300, 120, 0))],
    [],
    [call('call_1', T.gitStatus, 'shell')],
    [arrival('tools', T.gitStatus, 26, { callId: 'call_1' })],
    [call('call_2', T.npmTest, 'shell')],
    [arrival('tools', T.npmTest, 22, { callId: 'call_2' })],
    [call('call_3', T.ls, 'shell')],
    [arrival('tools', T.ls, 20, { callId: 'call_3' })],
    [call('call_4', T.app, 'edit')],
    [arrival('tools', T.app, 41, { callId: 'call_4' })],
    [call('call_5', T.explorer, 'agent')],
    [arrival('tools', T.explorer, 48, { callId: 'call_5' })],
    [call('call_6', T.waitAgent, 'other')],
    [arrival('tools', T.waitAgent, 27, { callId: 'call_6' })],
    [call('call_7', T.webSearchTool, 'other')],
    [arrival('tools', T.webSearchTool, 26, { callId: 'call_7' })],
    [call('call_8', T.node, 'shell')],
    [arrival('tools', T.node, 20, { callId: 'call_8' })],
    // An output whose call id was never seen: no call to resolve, so no target.
    [arrival('tools', null, 26, { callId: 'call_unknown' })],
    [reply(31)],
    [],
    [],
    [],
    [request('codex:codex-sess-1:2026-11-01T10:00:20.000Z:2220', at('10:00:20'), 'gpt-codex-5', tokens(700, 120, 500, 0, 0))],
    [request(anon, at('10:00:25'), 'gpt-codex-5', tokens(40, 5, 10, 0, 0))],
    [RESET],
    [],
  ];
}

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function timestampOf(line) {
  try {
    const ts = JSON.parse(line).timestamp;
    return typeof ts === 'string' ? ts : null;
  } catch {
    return null;
  }
}

// Each line with the byte offset it starts at, as a scanner passes them: offsets advance by the
// line's UTF-8 length plus one newline byte.
function rowsOf(text) {
  let offset = 0;
  return text.replace(/\n$/, '').split('\n').map((line) => {
    const bytes = ENCODER.encode(line).length;
    const row = { line, offset, bytes, ts: timestampOf(line) };
    offset += bytes + 1;
    return row;
  });
}

function runRows(adapter, rows) {
  return rows.map((row) => adapter.push(row.line, row.offset));
}

// Arrival offset, bytes and ts are checked against the line in assertShape, so the expectations omit them.
function view(events) {
  return events.map((event) => {
    if (event.t !== 'arrival') return event;
    const { ts, offset, bytes, ...rest } = event;
    return rest;
  });
}

function keysOf(value) {
  return Object.keys(value).sort();
}

function assertTarget(target) {
  assert.deepEqual(keysOf(target), ['key', 'kind', 'label']);
  assert.equal(typeof target.key, 'string');
  assert.equal(typeof target.label, 'string');
  assert.ok(KINDS.includes(target.kind), target.kind);
}

function assertCount(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, String(value));
}

function assertShape(event, row) {
  switch (event.t) {
    case 'meta': {
      const fields = keysOf(event).filter((key) => key !== 't');
      assert.ok(fields.length > 0);
      for (const key of fields) assert.ok(['agentId', 'cwd', 'sessionId'].includes(key), key);
      for (const key of fields) assert.equal(typeof event[key], 'string', key);
      break;
    }
    case 'request':
      assert.deepEqual(keysOf(event), ['key', 'model', 't', 'ts', 'usage']);
      assert.equal(typeof event.key, 'string');
      assert.equal(typeof event.model, 'string');
      assert.equal(event.ts, row.ts);
      assert.deepEqual(keysOf(event.usage), ['cacheRead', 'cacheWrite', 'cacheWrite1h', 'input', 'output']);
      for (const value of Object.values(event.usage)) assertCount(value);
      break;
    case 'call':
      assert.deepEqual(keysOf(event), ['id', 'op', 't', 'target']);
      assert.equal(typeof event.id, 'string');
      assert.ok(OPS.includes(event.op), event.op);
      assertTarget(event.target);
      break;
    case 'arrival': {
      const { callId, ...rest } = event;
      assert.deepEqual(keysOf(rest), ['bucket', 'bytes', 'chars', 'images', 'offset', 't', 'target', 'ts']);
      assert.ok(BUCKETS.includes(event.bucket), event.bucket);
      if (callId !== undefined) assert.ok(callId.length > 0);
      // A tool result whose call is unknown has no target. fold.mjs files it under unattributed.
      if (event.target === null) assert.equal(event.bucket, 'tools');
      else assertTarget(event.target);
      for (const key of ['chars', 'images']) assertCount(event[key]);
      assert.equal(event.offset, row.offset);
      assert.equal(event.bytes, row.bytes);
      assert.equal(event.ts, row.ts);
      break;
    }
    case 'reply':
      assert.deepEqual(keysOf(event), ['chars', 't']);
      assertCount(event.chars);
      break;
    case 'reset':
      assert.deepEqual(keysOf(event), ['t']);
      break;
    default:
      assert.fail(`unknown event type ${event.t}`);
  }
}

function requestsOf(lineEvents) {
  return lineEvents.flat().filter((event) => event.t === 'request');
}

// The adapter's request events and the records parser's records describe the same usage.
function assertSameRequests(requests, records) {
  assert.equal(records.length, requests.length);
  const fromEvent = (event) => ({ ts: event.ts, model: event.model, ...event.usage });
  const fromRecord = (record) => ({
    ts: record.ts,
    model: record.model,
    input: record.input,
    output: record.output,
    cacheRead: record.cacheRead,
    cacheWrite: record.cacheWrite,
    cacheWrite1h: record.cacheWrite1h,
  });
  const keyed = requests.filter((event) => !event.key.startsWith('anonymous:'));
  assert.equal(new Set(keyed.map((event) => event.key)).size, keyed.length);
  const keyedRecords = records.filter((record) => record.key !== undefined);
  assert.deepEqual(
    Object.fromEntries(keyedRecords.map((record) => [record.key, fromRecord(record)])),
    Object.fromEntries(keyed.map((event) => [event.key, fromEvent(event)])),
  );
  const anonymous = requests.filter((event) => event.key.startsWith('anonymous:')).map(fromEvent);
  const anonymousRecords = records.filter((record) => record.key === undefined).map(fromRecord);
  assert.deepEqual(anonymous, anonymousRecords);
}

function assertSplitRun(make, ctx, text, cut) {
  const rows = rowsOf(text);
  const whole = make(ctx);
  const wholeEvents = runRows(whole, rows);
  const head = make(ctx);
  const headEvents = runRows(head, rows.slice(0, cut));
  const state = JSON.parse(JSON.stringify(head.state()));
  assert.deepEqual(state, head.state());
  const tail = make(ctx, state);
  const tailEvents = runRows(tail, rows.slice(cut));
  assert.deepEqual([...headEvents, ...tailEvents], wholeEvents);
  assert.deepEqual(tail.state(), whole.state());
}

test('Claude fixture lines give the expected events', () => {
  const rows = rowsOf(fixture(CLAUDE));
  assert.equal(rows.length, 26);
  const expected = claudeExpected(rows);
  const events = runRows(createClaudeEvents(CLAUDE_CTX), rows);
  assert.equal(events.length, expected.length);
  events.forEach((lineEvents, i) => assert.deepEqual(view(lineEvents), expected[i], `line ${i + 1}`));
});

test('Codex fixture lines give the expected events', () => {
  const rows = rowsOf(fixture(CODEX));
  assert.equal(rows.length, 33);
  const expected = codexExpected(rows);
  const events = runRows(createCodexEvents(CODEX_CTX), rows);
  assert.equal(events.length, expected.length);
  events.forEach((lineEvents, i) => assert.deepEqual(view(lineEvents), expected[i], `line ${i + 1}`));
});

test('every event matches the contract shape, with arrivals tied to their line', () => {
  const cases = [
    [CLAUDE, CLAUDE_CTX, createClaudeEvents],
    [CODEX, CODEX_CTX, createCodexEvents],
  ];
  for (const [name, ctx, make] of cases) {
    const adapter = make(ctx);
    for (const row of rowsOf(fixture(name))) {
      for (const event of adapter.push(row.line, row.offset)) assertShape(event, row);
    }
  }
});

test('Claude requests match the records parser on the same fixture', () => {
  const text = fixture(CLAUDE);
  const requests = requestsOf(runRows(createClaudeEvents(CLAUDE_CTX), rowsOf(text)));
  const records = parseClaudeTranscript(text, { sessionId: CLAUDE_CTX.sessionId });
  assertSameRequests(requests, records);
});

test('Codex requests match the records parser on the same fixture', () => {
  const text = fixture(CODEX);
  const requests = requestsOf(runRows(createCodexEvents(CODEX_CTX), rowsOf(text)));
  const records = parseCodexTranscript(text, { sessionId: CODEX_CTX.sessionId });
  assertSameRequests(requests, records);
});

test('a Claude adapter restored from state() continues the same events', () => {
  assertSplitRun(createClaudeEvents, CLAUDE_CTX, fixture(CLAUDE), 6);
});

test('a Codex adapter restored from state() continues the same events', () => {
  assertSplitRun(createCodexEvents, CODEX_CTX, fixture(CODEX), 20);
});

test('Claude seen keys stop at 5,000 and the oldest key is dropped', () => {
  const adapter = createClaudeEvents(CLAUDE_CTX);
  const assistant = (i) => JSON.stringify({
    type: 'assistant',
    timestamp: at('10:00:00'),
    requestId: `req_${i}`,
    message: { id: `msg_${i}`, model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  for (let i = 0; i <= 5000; i += 1) adapter.push(assistant(i), i * 10);
  const { seen } = adapter.state();
  assert.equal(seen.length, 5000);
  assert.ok(!seen.includes('msg_0:req_0'));
  assert.ok(seen.includes('msg_5000:req_5000'));
  assert.deepEqual(requestsOf([adapter.push(assistant(5000), 1)]), []);
  assert.equal(requestsOf([adapter.push(assistant(0), 2)]).length, 1);
  assert.equal(adapter.state().seen.length, 5000);
});

test('Claude calls stop at 2,000 and an evicted call reads as an unknown target', () => {
  const adapter = createClaudeEvents(CLAUDE_CTX);
  for (let i = 0; i <= 2000; i += 1) {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: at('10:00:00'),
      message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'git status' } }] },
    });
    adapter.push(line, i * 10);
  }
  assert.equal(adapter.state().calls.length, 2000);
  const result = (id) => JSON.stringify({
    type: 'user',
    timestamp: at('10:00:01'),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
  });
  const [evicted] = adapter.push(result('toolu_0'), 100000);
  assert.equal(evicted.target, null);
  assert.equal(evicted.callId, 'toolu_0');
  const [kept] = adapter.push(result('toolu_1'), 100010);
  assert.deepEqual(kept.target, T.gitStatus);
});

test('Codex calls stop at 2,000 and an evicted call reads as an unknown target', () => {
  const adapter = createCodexEvents(CODEX_CTX);
  for (let i = 0; i <= 2000; i += 1) {
    const line = JSON.stringify({
      timestamp: at('10:00:00'),
      type: 'response_item',
      payload: { type: 'function_call', name: 'wait_agent', arguments: '{}', call_id: `call_${i}` },
    });
    adapter.push(line, i * 10);
  }
  assert.equal(adapter.state().calls.length, 2000);
  const output = (id) => JSON.stringify({
    timestamp: at('10:00:01'),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: 'x' },
  });
  const [evicted] = adapter.push(output('call_0'), 100000);
  assert.equal(evicted.target, null);
  const [kept] = adapter.push(output('call_1'), 100010);
  assert.deepEqual(kept.target, T.waitAgent);
});

test('no fixture text appears in any emitted event or in state()', () => {
  const cases = [
    [CLAUDE, CLAUDE_CTX, createClaudeEvents],
    [CODEX, CODEX_CTX, createCodexEvents],
  ];
  for (const [name, ctx, make] of cases) {
    const text = fixture(name);
    const markers = new Set(text.match(/ZQMARK_[A-Z]{2}_\d{2}/g));
    assert.ok(markers.size >= 25, `${name} has ${markers.size} markers`);
    const adapter = make(ctx);
    const events = runRows(adapter, rowsOf(text)).flat();
    assert.ok(events.length > 0);
    const dump = JSON.stringify({ events, state: adapter.state() });
    for (const marker of markers) assert.ok(!dump.includes(marker), `${name} leaks ${marker}`);
  }
});

test('both fixtures fold into rows that equal each request usage', async () => {
  const { createFold } = await import('../src/core/breakdown/fold.mjs');
  for (const [harness, make, name] of [['claude', createClaudeEvents, 'breakdown-claude.jsonl'], ['codex', createCodexEvents, 'breakdown-codex.jsonl']]) {
    const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const adapter = make({ sessionId: 's', project: 'p' }, null);
    const fold = createFold({ harness, host: 'local' });
    let offset = 0;
    let want = 0;
    let requests = 0;
    for (const line of text.split('\n')) {
      for (const event of adapter.push(line, offset)) {
        if (event.t === 'request') {
          const u = event.usage;
          want += u.input + u.cacheRead + u.cacheWrite + u.output;
          requests++;
        }
        fold.add(event);
      }
      offset += Buffer.byteLength(line) + 1;
    }
    const d = fold.digest();
    const got = d.rows.reduce((sum, r) => sum + r[7] + r[8] + r[9] + r[10] + r[11], 0);
    assert.ok(requests > 0, `${harness} fixture has requests`);
    assert.equal(d.requests, requests);
    assert.equal(got, want, `${harness} rows equal usage`);
  }
});

test('lines of ignored kinds give no events, parsed or skipped by their head', () => {
  const claude = createClaudeEvents({ sessionId: 's', home: '/h' });
  const apiFirst = JSON.stringify({ type: 'api-request', sessionId: 's', cwd: '/w/proj' });
  assert.deepEqual(claude.push(apiFirst, 0, Buffer.byteLength(apiFirst)), [{ t: 'meta', cwd: '/w/proj', sessionId: 's' }], 'meta is still learned before cwd and session are known');
  const later = JSON.stringify({ type: 'api-request-blob', sessionId: 's', cwd: '/w/proj', body: 'x'.repeat(1000) });
  assert.deepEqual(claude.push(later, 10), []);
  const withAgent = JSON.stringify({ type: 'queue-operation', sessionId: 's', agentId: 'a1' });
  assert.deepEqual(claude.push(withAgent, 20), [{ t: 'meta', agentId: 'a1' }], 'a line naming an agent is parsed');

  const codex = createCodexEvents({ sessionId: 's' });
  for (const payload of [{ type: 'item_completed', item: 'x'.repeat(500) }, { type: 'agent_message', message: 'hi' }]) {
    assert.deepEqual(codex.push(JSON.stringify({ timestamp: '2026-11-03T10:00:00.000Z', type: 'event_msg', payload }), 0), []);
  }
  assert.deepEqual(codex.push(JSON.stringify({ timestamp: '2026-11-03T10:00:00.000Z', type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'z'.repeat(500) } }), 0), []);
  const output = codex.push(JSON.stringify({ timestamp: '2026-11-03T10:00:00.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'abc' } }), 0);
  assert.equal(output[0].chars, 3, 'handled kinds are still parsed');
});

test('an attachment counts the JSON length of its value', () => {
  const adapter = createClaudeEvents({ sessionId: 's' });
  const attachment = { type: 'file', content: 'é "quoted"\nline 界'.repeat(20) };
  const line = JSON.stringify({ parentUuid: null, cwd: '/w', sessionId: 's', timestamp: '2026-11-03T10:00:00.000Z', attachment, type: 'attachment' });
  const arrival = adapter.push(line, 0).find((e) => e.t === 'arrival');
  assert.equal(arrival.chars, JSON.stringify(attachment).length);
  assert.equal(arrival.bytes, Buffer.byteLength(line));
});
