import test from 'node:test';
import assert from 'node:assert/strict';
import { apportion, BUCKETS, createFold } from '../src/core/breakdown/fold.mjs';
import { bandOf } from '../src/core/bands.mjs';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const usage = (input, cacheRead, cacheWrite, output, cacheWrite1h = 0) => ({ input, cacheRead, cacheWrite, cacheWrite1h, output });
const req = (min, u, model = 'claude-opus-5-5') => ({ t: 'request', key: `k${min}`, ts: at(min), model, usage: u });
const file = (key) => ({ key, label: key.split('/').pop(), kind: 'file' });
const arrival = (target, chars, extra = {}) => ({ t: 'arrival', ts: at(0), bucket: 'tools', target, chars, images: 0, offset: 100, bytes: chars, ...extra });
const total = (u) => u.input + u.cacheRead + u.cacheWrite + u.output;

// Token sums of a digest's rows, by field, optionally filtered.
function sums(digest, pick = () => true) {
  const out = { input: 0, cacheRead: 0, cw5m: 0, cw1h: 0, output: 0 };
  for (const row of digest.rows) {
    if (!pick(row)) continue;
    out.input += row[7];
    out.cacheRead += row[8];
    out.cw5m += row[9];
    out.cw1h += row[10];
    out.output += row[11];
  }
  return out;
}
const rowTotal = (d, pick) => Object.values(sums(d, pick)).reduce((a, b) => a + b, 0);
const bucketOf = (d, name) => (row) => row[3] === BUCKETS.indexOf(name);
const targetOf = (d, key) => (row) => d.targets[row[4]][0] === key;

// Feeds events one at a time and checks after every request that the new rows add up to exactly
// that request's usage, field by field.
function feed(events, info = { harness: 'claude', host: 'local' }) {
  const fold = createFold(info, null);
  let before = sums(fold.digest());
  for (const event of events) {
    fold.add(event);
    if (event.t !== 'request') continue;
    const after = sums(fold.digest());
    const u = event.usage;
    const cw1h = u.cacheWrite1h ?? 0;
    assert.deepEqual(
      { input: after.input - before.input, cacheRead: after.cacheRead - before.cacheRead, cw5m: after.cw5m - before.cw5m, cw1h: after.cw1h - before.cw1h, output: after.output - before.output },
      { input: u.input, cacheRead: u.cacheRead, cw5m: u.cacheWrite - cw1h, cw1h, output: u.output },
      `rows for ${event.key} must equal its usage`,
    );
    before = after;
  }
  return fold;
}

test('apportion gives integers that add up to the total', () => {
  assert.deepEqual(apportion(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(apportion(7, [0, 0]), [4, 3]);
  assert.deepEqual(apportion(0, [1, 2]), [0, 0]);
  for (let n = 1; n < 50; n++) assert.equal(apportion(n, [3, 0.5, 7, 11]).reduce((a, b) => a + b, 0), n);
});

test('bandOf picks the largest band below the size (a tier above N is for prompts over N)', () => {
  assert.equal(bandOf(0), 0);
  assert.equal(bandOf(99_999), 0);
  assert.equal(bandOf(100_000), 0);
  assert.equal(bandOf(100_001), 100_000);
  assert.equal(bandOf(272_000), 256_000);
  assert.equal(bandOf(272_001), 272_000);
  assert.equal(bandOf(5_000_000), 1_000_000);
});

test('the first request goes to startup, its output to output', () => {
  const d = feed([req(0, usage(10, 0, 5000, 200))]).digest();
  assert.equal(rowTotal(d, bucketOf(d, 'startup')), 5010);
  assert.equal(rowTotal(d, bucketOf(d, 'output')), 200);
  assert.equal(d.requests, 1);
  assert.equal(d.totalTokens, 5210);
});

test('a single tool result takes all new tokens, measured; the previous output goes to replies', () => {
  const a = file('src/a.mjs');
  const d = feed([
    req(0, usage(10, 0, 5000, 200)),
    { t: 'call', id: 'c1', target: a, op: 'read' },
    arrival(a, 4000, { callId: 'c1' }),
    // ctx grows 5010 -> 6210: 200 replies + 1000 new
    req(1, usage(10, 5010, 1190, 50)),
  ]).digest();
  assert.equal(rowTotal(d, (r) => targetOf(d, 'src/a.mjs')(r) && r[5] === 0), rowTotal(d, targetOf(d, 'src/a.mjs')));
  const aRows = sums(d, targetOf(d, 'src/a.mjs'));
  const replyRows = sums(d, bucketOf(d, 'replies'));
  // 1190 written + 10 uncached go to the two new entries by share (1000 : 200)
  assert.equal(aRows.cw5m + aRows.input, 1000);
  assert.equal(replyRows.cw5m + replyRows.input, 200);
  assert.equal(sums(d, bucketOf(d, 'startup')).cacheRead, 5010);
  assert.equal(d.splitTokens, 0);
});

test('several results share new tokens by characters and are marked est', () => {
  const a = file('a');
  const b = file('b');
  const d = feed([
    req(0, usage(0, 0, 1000, 0)),
    arrival(a, 3000),
    arrival(b, 1000),
    req(1, usage(0, 1000, 400, 0)),
  ]).digest();
  const ra = sums(d, targetOf(d, 'a'));
  const rb = sums(d, targetOf(d, 'b'));
  assert.equal(ra.cw5m, 300);
  assert.equal(rb.cw5m, 100);
  assert.ok(d.rows.filter(targetOf(d, 'a')).every((r) => r[5] === 1));
  assert.equal(d.splitTokens, 400 + 0); // only the est rows count
});

test('images weigh 6,000 chars', () => {
  const a = file('a');
  const b = file('b');
  const d = feed([req(0, usage(0, 0, 1000, 0)), arrival(a, 0, { images: 1 }), arrival(b, 6000), req(1, usage(0, 1000, 200, 0))]).digest();
  assert.equal(sums(d, targetOf(d, 'a')).cw5m, 100);
});

test('new tokens with no arrival go to unattributed', () => {
  const d = feed([req(0, usage(0, 0, 1000, 0)), req(1, usage(0, 1000, 300, 0))]).digest();
  assert.equal(rowTotal(d, bucketOf(d, 'unattributed')), 300);
});

test('writes beyond the new context are rebuilds: idle after the TTL, model on a switch, other otherwise', () => {
  const idle = feed([req(0, usage(0, 0, 1000, 0)), req(10, usage(0, 0, 1000, 0))]).digest();
  assert.equal(rowTotal(idle, targetOf(idle, 'rebuild:idle')), 1000);

  const hour = feed([req(0, usage(0, 0, 1000, 0, 1000)), req(10, usage(0, 0, 1000, 0, 1000))]).digest();
  assert.equal(rowTotal(hour, targetOf(hour, 'rebuild:other')), 1000, 'a 1-hour write is still cached after 10 minutes');

  const model = feed([req(0, usage(0, 0, 1000, 0)), req(1, usage(0, 0, 1000, 0), 'claude-sonnet-5-5')]).digest();
  assert.equal(rowTotal(model, targetOf(model, 'rebuild:model')), 1000);
});

test('a compaction resets the resident map and splits ctx over the summary', () => {
  const a = file('a');
  const summary = { key: 'summary', label: '(summary)', kind: 'summary' };
  const d = feed([
    req(0, usage(0, 0, 50_000, 100)),
    arrival(a, 1000),
    req(1, usage(0, 50_000, 2000, 100)),
    { t: 'reset' },
    { t: 'arrival', ts: at(2), bucket: 'compaction', target: summary, chars: 800, images: 0, offset: 0, bytes: 800 },
    req(2, usage(0, 0, 3000, 100)),
    req(3, usage(0, 3000, 100, 0)),
  ]).digest();
  const s = sums(d, targetOf(d, 'summary'));
  assert.equal(s.cw5m, 3000);
  // after the reset, reads go to what was rebuilt, not to the old file
  assert.equal(s.cacheRead, 3000);
});

test('an unexplained shrink scales the resident entries down', () => {
  const d = feed([req(0, usage(0, 0, 100_000, 0)), req(1, usage(0, 10_000, 0, 0)), req(2, usage(0, 10_000, 0, 0))]).digest();
  assert.equal(sums(d, bucketOf(d, 'startup')).cacheRead, 20_000);
});

test('a re-read with no edit in between sets rep; an edit clears it', () => {
  const a = file('a');
  const d = feed([
    req(0, usage(0, 0, 1000, 0)),
    { t: 'call', id: 'r1', target: a, op: 'read' },
    arrival(a, 100, { callId: 'r1' }),
    req(1, usage(0, 1000, 100, 0)),
    { t: 'call', id: 'r2', target: a, op: 'read' },
    arrival(a, 100, { callId: 'r2' }),
    req(2, usage(0, 1100, 100, 0)),
    { t: 'call', id: 'e1', target: a, op: 'edit' },
    { t: 'call', id: 'r3', target: a, op: 'read' },
    arrival(a, 100, { callId: 'r3' }),
    req(3, usage(0, 1200, 100, 0)),
  ]).digest();
  const repWrites = sums(d, (r) => targetOf(d, 'a')(r) && r[6] === 1).cw5m;
  assert.equal(repWrites, 100);
});

test('repeat reads are Claude only', () => {
  const a = file('a');
  const events = [
    req(0, usage(0, 0, 1000, 0)),
    { t: 'call', id: 'r1', target: a, op: 'read' },
    arrival(a, 100, { callId: 'r1' }),
    { t: 'call', id: 'r2', target: a, op: 'read' },
    arrival(a, 100, { callId: 'r2' }),
    req(1, usage(0, 1000, 200, 0)),
  ];
  const d = feed(events, { harness: 'codex', host: 'local' }).digest();
  assert.ok(d.rows.every((r) => r[6] === 0));
});

test('state round-trips through JSON and continuing gives the same digest', () => {
  const a = file('a');
  const first = [req(0, usage(10, 0, 1000, 20)), arrival(a, 500)];
  const rest = [req(1, usage(10, 1010, 520, 20)), arrival(a, 100), req(30, usage(0, 0, 1700, 5))];
  const whole = createFold({ harness: 'claude', host: 'local' });
  for (const e of [...first, ...rest]) whole.add(e);
  const part = createFold({ harness: 'claude', host: 'local' });
  for (const e of first) part.add(e);
  const resumed = createFold({}, JSON.parse(JSON.stringify(part.state())));
  for (const e of rest) resumed.add(e);
  assert.deepEqual(resumed.digest(), whole.digest());
});

test('the resident map and a request composition stay capped', () => {
  const events = [req(0, usage(0, 0, 1000, 0))];
  for (let i = 0; i < 400; i++) events.push(arrival(file(`f${i}`), 10 + i));
  events.push(req(1, usage(0, 1000, 40_000, 0)));
  events.push(req(2, usage(0, 41_000, 0, 0)));
  const fold = feed(events);
  const state = fold.state();
  const nonOther = Object.values(state.resident).filter((e) => state.targets[e.t][0] !== 'other');
  assert.ok(nonOther.length <= 300);
  const d = fold.digest();
  for (const bucket of BUCKETS) {
    for (const hourRows of [d.rows.filter((r) => r[0] === d.rows[0][0] && r[3] === BUCKETS.indexOf(bucket))]) {
      const targets = new Set(hourRows.map((r) => r[4]));
      assert.ok(targets.size <= 31 * 2, `${bucket} has ${targets.size} targets`);
    }
  }
  assert.ok(d.targets.some((t) => t[0] === 'other'));
});

test('no transcript text reaches the state or the digest', () => {
  const secret = 'SECRET-TEXT-should-never-appear';
  const fold = createFold({ harness: 'claude', host: 'local' });
  fold.add({ t: 'meta', cwd: '/p', sessionId: 's' });
  fold.add(req(0, usage(0, 0, 100, 0)));
  // an adapter bug that leaks text into an event field the fold doesn't use must not be stored
  fold.add({ t: 'arrival', ts: at(0), bucket: 'tools', target: file('a'), chars: 10, images: 0, offset: 0, bytes: 10, text: secret });
  fold.add({ t: 'reply', chars: 5, text: secret });
  fold.add(req(1, usage(0, 100, 10, 0)));
  assert.ok(!JSON.stringify(fold.state()).includes(secret));
  assert.ok(!JSON.stringify(fold.digest()).includes(secret));
});

test('big keeps the 10 largest arrivals', () => {
  const events = [req(0, usage(0, 0, 100, 0))];
  for (let i = 0; i < 15; i++) {
    events.push(arrival(file(`f${i}`), 100, { offset: i }));
    events.push(req(i + 1, usage(0, 100 + i * 1000 + (i ? 0 : 0), 1000, 0)));
  }
  const d = createFold({ harness: 'claude', host: 'local' });
  for (const e of events) d.add(e);
  const big = d.digest().big;
  assert.equal(big.length, 10);
  assert.ok(big.every((b, i) => i === 0 || big[i - 1][3] >= b[3]));
});

test('a digest lists only the targets its rows and big arrivals use', () => {
  const events = [];
  for (let i = 0; i < 400; i++) {
    events.push(req(i, usage(10, 1000 + i, 50, 5)));
    events.push(arrival(file(`/w/f${i}.md`), 100));
  }
  events.push(req(401, usage(10, 2000, 50, 5)));
  const fold = feed(events);
  const d = fold.digest();
  assert.equal(fold.state().targets.length > d.targets.length, true, 'the state keeps every target');
  const used = new Set(d.rows.map((row) => row[4]));
  for (const b of d.big) used.add(b[2]);
  assert.equal(used.size, d.targets.length, 'every listed target is used');
  for (const b of d.big) assert.ok(d.targets[b[2]][0].startsWith('/w/f'), 'big arrivals point at their file');
});

test('pending arrivals stay bounded between requests, and the next request still adds up', () => {
  const events = [req(0, usage(10, 0, 5000, 5))];
  for (let i = 0; i < 6000; i++) events.push(arrival(file(`/w/${i % 3000}.md`), 100 + (i % 7)));
  const fold = createFold({ harness: 'claude', host: 'local' }, null);
  for (const event of events) fold.add(event);
  assert.ok(fold.state().pending.length <= 2001, `pending ${fold.state().pending.length}`);
  feed([...events, req(1, usage(10, 5000, 90_000, 5))]);
});
