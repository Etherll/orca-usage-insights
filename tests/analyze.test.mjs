import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBreakdown } from '../src/core/breakdown/analyze.mjs';
import { decodeDigest, encodeDigest, packDigest } from '../src/core/breakdown/digest-rows.mjs';
import { createFold } from '../src/core/breakdown/fold.mjs';
import { buildReport } from '../src/core/report.mjs';
import { DEFAULT_CATALOG } from '../src/core/pricing.mjs';

// Local 2026-11-03 15:30; timestamps come from local parts, so this holds in any TZ.
const NOW = new Date(2026, 10, 3, 15, 30);
const at = (daysAgo, minute = 0) => new Date(2026, 10, 3 - daysAgo, 12, minute);
const MODEL = 'claude-opus-5-5';
const catalog = DEFAULT_CATALOG;

const usage = (input, cacheRead, cacheWrite, output) => ({ input, cacheRead, cacheWrite, cacheWrite1h: 0, output });
const file = (key) => ({ key, label: key.split('/').pop(), kind: 'file' });

function session({ harness = 'claude', host = 'local', sessionId = 's1', cwd = '/w/proj', daysAgo = 0, turns, model = MODEL, explain = false }) {
  const fold = createFold({ harness, host });
  fold.add({ t: 'meta', cwd, sessionId });
  if (explain) fold.add({ t: 'arrival', ts: at(daysAgo).toISOString(), bucket: 'messages', target: { key: 'prompt', label: 'prompt', kind: 'messages' }, chars: 10, images: 0, offset: 0, bytes: 10, explain: true });
  const records = [];
  turns.forEach((turn, i) => {
    for (const a of turn.arrivals ?? []) {
      if (a.callId) fold.add({ t: 'call', id: a.callId, target: a.target, op: a.op ?? 'read' });
      fold.add({ t: 'arrival', ts: at(daysAgo, i).toISOString(), bucket: a.bucket ?? 'tools', target: a.target, chars: a.chars, images: 0, offset: 1000 + i, bytes: a.chars, callId: a.callId });
    }
    const ts = at(daysAgo, i).toISOString();
    fold.add({ t: 'request', key: `${sessionId}:${i}`, ts, model, usage: turn.usage });
    records.push({ provider: harness, host: host === 'local' ? undefined : host, ts, model, project: 'proj', sessionId, cwd, ...turn.usage, key: `${sessionId}:${i}` });
  });
  return { digest: { path: `/t/${sessionId}.jsonl`, compressed: false, sessionId, digest: fold.digest() }, records };
}

const sumNot = (v) => v.totals.notAnalysed.reduce((s, r) => s + (r.usd ?? 0), 0);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

function world() {
  const a = file('src/big.mjs');
  const s1 = session({
    turns: [
      { usage: usage(10, 0, 20_000, 300) },
      { arrivals: [{ target: a, chars: 400_000 }], usage: usage(10, 20_000, 400_300, 300) },
      { usage: usage(10, 420_300, 400, 200) },
    ],
  });
  const s2 = session({ harness: 'codex', sessionId: 'c1', cwd: '/w/other', daysAgo: 2, turns: [{ usage: usage(5000, 0, 0, 100) }, { usage: usage(1000, 4000, 0, 100) }] });
  const remote = session({ host: 'box', sessionId: 'r1', turns: [{ usage: usage(100, 0, 5000, 50) }] });
  const old = session({ sessionId: 'o1', daysAgo: 20, turns: [{ usage: usage(100, 0, 5000, 50) }] });
  return {
    records: [...s1.records, ...s2.records, ...remote.records, ...old.records],
    digests: [s1.digest, s2.digest, old.digest],
  };
}

test('Breakdown total equals the Usage total for every filter combination', () => {
  const { records, digests } = world();
  for (const range of ['7d', '30d', 'all']) {
    for (const providers of [undefined, ['claude'], ['codex']]) {
      for (const hosts of [undefined, ['local'], ['box']]) {
        for (const scope of [undefined, { roots: ['/w/proj'] }]) {
          const opts = { range, now: NOW, providers, hosts, scope, catalog };
          const v = analyzeBreakdown({ records, digests, ...opts });
          const usage = buildReport(records, opts).totals.costUsd;
          near(v.totals.usageUsd, usage, `usage ${JSON.stringify(opts)}`);
          near(v.totals.analysedUsd + sumNot(v), v.totals.usageUsd, `reconcile ${JSON.stringify(opts)}`);
        }
      }
    }
  }
});

test('a remote host with no digest is not analysed, reason ssh', () => {
  const { records, digests } = world();
  const v = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog, hosts: ['box'] });
  assert.equal(v.totals.analysedUsd, 0);
  const ssh = v.totals.notAnalysed.find((r) => r.reason === 'ssh');
  assert.ok(ssh.usd > 0);
  assert.equal(ssh.turns, 1);
});

test('a skipped file gives its session its reason; a missing one is unmatched', () => {
  const s = session({ sessionId: 'z1', turns: [{ usage: usage(100, 0, 5000, 50) }] });
  const t = session({ sessionId: 'z2', turns: [{ usage: usage(100, 0, 5000, 50) }] });
  const v = analyzeBreakdown({
    records: [...s.records, ...t.records],
    digests: [],
    files: [{ path: '/t/z1.jsonl.zst', provider: 'claude', host: 'local', sessionId: 'z1', state: 'zstd' }],
    range: '7d',
    now: NOW,
    catalog,
  });
  const reasons = Object.fromEntries(v.totals.notAnalysed.map((r) => [r.reason, r]));
  assert.ok(reasons.zstd.usd > 0);
  near(reasons.zstd.usd, reasons.unmatched.usd, 'same session cost');
});

test('copies of history (D > U) are scaled down and reported as dedupe', () => {
  const s = session({ turns: [{ usage: usage(10, 0, 20_000, 300) }, { usage: usage(10, 20_000, 500, 300) }] });
  const copy = { ...s.digest, path: '/t/s1-resumed.jsonl' };
  const v = analyzeBreakdown({ records: s.records, digests: [s.digest, copy], range: '7d', now: NOW, catalog });
  near(v.totals.analysedUsd, v.totals.usageUsd, 'scaled to Usage');
  near(v.health.dedupeUsd, v.totals.usageUsd, 'the copy is the dedupe');
});

test('records with no digest rows on their day are unmatched (D < U)', () => {
  const s = session({ turns: [{ usage: usage(10, 0, 20_000, 300) }] });
  const extra = { ...s.records[0], ...usage(0, 0, 0, 10_000), key: 'x', ts: at(0, 30).toISOString() };
  const v = analyzeBreakdown({ records: [...s.records, extra], digests: [s.digest], range: '7d', now: NOW, catalog });
  const unmatched = v.totals.notAnalysed.find((r) => r.reason === 'unmatched');
  near(unmatched.usd, (10_000 * 20) / 1e6, 'the extra output');
});

test('unpriced models are listed with usd null', () => {
  const s = session({ model: 'mystery-model', turns: [{ usage: usage(10, 0, 100, 5) }] });
  const v = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog });
  const r = v.totals.notAnalysed.find((x) => x.reason === 'unpriced');
  assert.equal(r.usd, null);
  assert.equal(r.turns, 1);
  assert.deepEqual(v.totals.unpricedModels, [{ model: 'mystery-model', turns: 1, tokens: 115 }]);
});

test('the tree goes project › folder › file, with groups and fold targets at project level', () => {
  const { records, digests } = world();
  const top = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog });
  assert.deepEqual(top.path, []);
  assert.ok(top.nodes.some((n) => n.key === '/w/proj' && n.label === 'proj' && n.kind === 'project' && n.children));
  const proj = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog, path: ['/w/proj'] });
  const keys = proj.nodes.map((n) => n.key);
  assert.ok(keys.includes('src'));
  assert.ok(keys.includes('startup'));
  const src = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog, path: ['/w/proj', 'src'] });
  assert.deepEqual(src.nodes.map((n) => [n.key, n.kind]), [['big.mjs', 'file']]);
  const bad = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog, path: ['/w/proj', 'nope', 'x'] });
  assert.deepEqual(bad.path, ['/w/proj']);
  const shares = top.nodes.reduce((s, n) => s + n.share, 0);
  near(shares, 1, 'project shares');
});

test('each level shows the top 25 plus more', () => {
  const arrivals = Array.from({ length: 40 }, (_, i) => ({ target: file(`f${String(i).padStart(2, '0')}.txt`), chars: 100 + i }));
  const s = session({ turns: [{ usage: usage(10, 0, 1000, 10) }, { arrivals, usage: usage(10, 1000, 40_000, 10) }] });
  const v = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog, path: ['/w/proj'] });
  assert.equal(v.nodes.length, 25);
  assert.ok(v.more.count > 0); // the fold keeps 30 targets per bucket per request
  assert.ok(JSON.stringify(v).length < 900_000);
});

test('a large tool result above the threshold is a finding, with evidence', () => {
  const { records, digests } = world();
  const v = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog });
  const f = v.findings.find((x) => x.kind === 'large-results');
  assert.ok(f, 'large-results finding');
  assert.equal(f.where.key, 'src/big.mjs');
  assert.equal(f.where.project, '/w/proj');
  assert.ok(f.usd >= Math.max(1, 0.005 * v.totals.analysedUsd));
  assert.deepEqual(f.evidence[0], { file: '/t/s1.jsonl', offset: 1001, bytes: 400_000, compressed: false });
  assert.equal(f.lastSeen, `2026-11-03`);
  assert.equal(typeof f.id, 'string');
});

test('findings under $1 are dropped', () => {
  const s = session({ turns: [{ usage: usage(10, 0, 1000, 10) }, { arrivals: [{ target: file('a'), chars: 10 }], usage: usage(10, 1000, 100, 10) }] });
  const v = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog });
  assert.deepEqual(v.findings, []);
});

test('repeated reads and idle cache expiry become findings', () => {
  const a = file('src/a.mjs');
  const s = session({
    turns: [
      { usage: usage(10, 0, 300_000, 10) },
      { arrivals: [{ target: a, chars: 100, callId: 'r1' }], usage: usage(10, 300_000, 300_000, 10) },
      { arrivals: [{ target: a, chars: 100, callId: 'r2' }], usage: usage(10, 600_000, 300_000, 10) },
    ],
  });
  const fold = createFold({ harness: 'claude', host: 'local' });
  fold.add({ t: 'meta', cwd: '/w/proj', sessionId: 'i1' });
  const t0 = new Date(2026, 10, 3, 9, 0);
  const t1 = new Date(2026, 10, 3, 11, 0);
  fold.add({ t: 'request', key: 'i:0', ts: t0.toISOString(), model: MODEL, usage: usage(0, 0, 400_000, 0) });
  fold.add({ t: 'request', key: 'i:1', ts: t1.toISOString(), model: MODEL, usage: usage(0, 0, 400_000, 0) });
  const idleRecords = [t0, t1].map((d, i) => ({ provider: 'claude', ts: d.toISOString(), model: MODEL, sessionId: 'i1', cwd: '/w/proj', ...usage(0, 0, 400_000, 0), key: `i:${i}` }));
  const v = analyzeBreakdown({
    records: [...s.records, ...idleRecords],
    digests: [s.digest, { path: '/t/i1.jsonl', compressed: false, sessionId: 'i1', digest: fold.digest() }],
    range: '7d',
    now: NOW,
    catalog,
  });
  const rep = v.findings.find((f) => f.kind === 'repeat-reads');
  assert.ok(rep, 'repeat-reads');
  assert.equal(rep.where.key, 'src/a.mjs');
  const idle = v.findings.find((f) => f.kind === 'cache-expired');
  assert.ok(idle, 'cache-expired');
  near(idle.usd, (400_000 * 5) / 1e6, 'the rebuilt writes');
  assert.equal(idle.where.project, '/w/proj');
});

test('sessions started by an Explain prompt are kept out of findings', () => {
  const s = session({
    explain: true,
    turns: [{ usage: usage(10, 0, 20_000, 300) }, { arrivals: [{ target: file('src/big.mjs'), chars: 400_000 }], usage: usage(10, 20_000, 100_300, 300) }],
  });
  const v = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog });
  assert.deepEqual(v.findings, []);
  near(v.health.explainUsd, v.totals.analysedUsd, 'all of it');
});

test('buckets add up to the analysed total', () => {
  const { records, digests } = world();
  const v = analyzeBreakdown({ records, digests, range: '7d', now: NOW, catalog });
  near(v.buckets.reduce((s, b) => s + b.usd, 0), v.totals.analysedUsd, 'buckets');
  assert.ok(v.buckets.every((b) => typeof b.est === 'boolean'));
});

test('namespaced file keys split on the path, not the prefix', () => {
  const s = session({ turns: [{ usage: usage(10, 0, 1000, 10) }, { arrivals: [{ target: { key: 'file:src/deep/x.mjs', label: 'src/deep/x.mjs', kind: 'file' }, chars: 10 }], usage: usage(10, 1000, 500, 10) }] });
  const v = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog, path: ['/w/proj', 'src', 'deep'] });
  assert.deepEqual(v.path, ['/w/proj', 'src', 'deep']);
  assert.deepEqual(v.nodes.map((n) => n.key), ['x.mjs']);
});

test('a half-hour time zone puts digest rows on the same local day as the records', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    const { analyzeBreakdown } = await import(${JSON.stringify(new URL('../src/core/breakdown/analyze.mjs', import.meta.url).href)});
    const { createFold } = await import(${JSON.stringify(new URL('../src/core/breakdown/fold.mjs', import.meta.url).href)});
    const { DEFAULT_CATALOG } = await import(${JSON.stringify(new URL('../src/core/pricing.mjs', import.meta.url).href)});
    const ts = '2026-11-05T18:45:00.000Z'; // 00:15 on Nov 6 in India
    const u = { input: 10, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 0, output: 10 };
    const fold = createFold({ harness: 'claude', host: 'local' });
    fold.add({ t: 'meta', cwd: '/w', sessionId: 's' });
    fold.add({ t: 'request', key: 'k', ts, model: 'claude-opus-5-5', usage: u });
    const v = analyzeBreakdown({ records: [{ provider: 'claude', ts, model: 'claude-opus-5-5', sessionId: 's', cwd: '/w', key: 'k', ...u }], digests: [{ path: '/t', compressed: false, sessionId: 's', digest: fold.digest() }], range: '7d', now: new Date('2026-11-06T12:00:00Z'), catalog: DEFAULT_CATALOG });
    console.log(JSON.stringify({ a: v.totals.analysedUsd, u: v.totals.usageUsd, d: v.health.dedupeUsd }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Asia/Kolkata' }, encoding: 'utf8' }));
  assert.ok(out.u > 0);
  near(out.a, out.u, 'all analysed');
  assert.equal(out.d, 0);
});

const withoutTime = (view) => JSON.stringify({ ...view, generatedAt: null });

test('packed digests, and digests read back from a shard, give the same view as plain ones', () => {
  const { records, digests } = world();
  const packed = digests.map((item) => ({ ...item, digest: packDigest(item.digest) }));
  const decoded = digests.map((item) => ({ ...item, digest: decodeDigest(JSON.parse(JSON.stringify(encodeDigest(item.digest)))) }));
  assert.ok(ArrayBuffer.isView(packed[0].digest.rows) && ArrayBuffer.isView(decoded[0].digest.rows));
  for (const range of ['7d', 'all']) {
    for (const path of [[], ['/w/proj']]) {
      const plain = analyzeBreakdown({ records, digests, range, now: NOW, catalog, path });
      assert.equal(withoutTime(analyzeBreakdown({ records, digests: packed, range, now: NOW, catalog, path })), withoutTime(plain));
      assert.equal(withoutTime(analyzeBreakdown({ records, digests: decoded, range, now: NOW, catalog, path })), withoutTime(plain));
    }
  }
});

test('a digest with a value that is not a whole 32-bit number keeps it exactly', () => {
  const rows = [[1, 0, 0, 1, 0, 0, 0, 2 ** 33, 1.5, 0, 0, 7], [2, 0, 0, 1, 0, 0, 0, 3, 4, 5, 6]];
  const d = packDigest({ rows });
  assert.ok(d.rows instanceof Float64Array);
  assert.deepEqual([...d.rows.subarray(0, 12)], rows[0]);
  assert.ok(Number.isNaN(d.rows[23]), 'a missing value is NaN');
  assert.deepEqual([...decodeDigest(JSON.parse(JSON.stringify(encodeDigest({ rows })))).rows].map(String), [...d.rows].map(String));
});

test('the analysis is reused for the same inputs and rebuilt when one changes', () => {
  const { records, digests } = world();
  const opts = { records, digests, range: '7d', now: NOW, catalog };
  const first = analyzeBreakdown(opts);
  const again = analyzeBreakdown({ ...opts, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.findings, first.findings, 'same inputs, same day: reused');
  assert.notEqual(again.generatedAt, first.generatedAt, 'the view itself is new');
  const drilled = analyzeBreakdown({ ...opts, path: ['/w/proj'] });
  assert.equal(drilled.findings, first.findings, 'another path: reused');
  assert.deepEqual(drilled.path, ['/w/proj']);

  const fewer = analyzeBreakdown({ ...opts, digests: digests.slice(1) });
  assert.notEqual(fewer.findings, first.findings, 'other digests: rebuilt');
  assert.ok(fewer.totals.analysedUsd < first.totals.analysedUsd);
  const tomorrow = analyzeBreakdown({ ...opts, now: new Date(2026, 10, 4, 9, 0) });
  assert.notEqual(tomorrow.findings, first.findings, 'another day: rebuilt');
  const codex = analyzeBreakdown({ ...opts, providers: ['codex'] });
  assert.notEqual(codex.totals, first.totals, 'other filters: rebuilt');
  assert.equal(withoutTime(analyzeBreakdown({ ...opts })), withoutTime(first), 'and the first is still kept');
});


test('a view whose findings span many days is cut to fit, without changing the cached analysis', () => {
  const fold = createFold({ harness: 'claude', host: 'local' });
  fold.add({ t: 'meta', cwd: '/w/proj', sessionId: 's1' });
  const target = { key: 'file:big.mjs', label: 'big.mjs', kind: 'file' };
  const records = [];
  const DAYS = 45_000;
  const day = (ago) => new Date(Date.UTC(2026, 10, 3 - ago, 12)).toISOString();
  for (let i = DAYS; i >= 0; i--) {
    const ts = day(i);
    fold.add({ t: 'arrival', ts, bucket: 'tools', target, chars: 400_000, images: 0, offset: i, bytes: 400_000 });
    const u = { input: 10, cacheRead: 100_000 + i, cacheWrite: 400, cacheWrite1h: 0, output: 200 };
    fold.add({ t: 'request', key: `s1:${i}`, ts, model: MODEL, usage: u });
    records.push({ provider: 'claude', ts, model: MODEL, project: 'proj', sessionId: 's1', cwd: '/w/proj', ...u, key: `s1:${i}` });
  }
  const digests = [{ path: '/t/s1.jsonl', compressed: false, sessionId: 's1', digest: fold.digest() }];
  const input = { records, digests, catalog, range: 'all', now: new Date(Date.UTC(2026, 10, 3, 15)) };
  const view = analyzeBreakdown(input);
  assert.ok(JSON.stringify(view).length <= 900_000);
  assert.ok(view.findings.length > 0 && view.findings.every((f) => f.daily.length <= 90));
  assert.equal(analyzeBreakdown(input).findings[0].daily.length, 90);
});

test('a top-level folder named like a group stays separate from the group', () => {
  const s = session({
    turns: [
      { usage: usage(10, 0, 20_000, 10) },
      { arrivals: [{ target: file('(commands)/a.mjs'), chars: 40_000 }], usage: usage(10, 20_000, 10_000, 10) },
      { arrivals: [{ target: { key: 'command:git', label: 'git', kind: 'command' }, chars: 40_000 }], usage: usage(10, 30_000, 10_000, 10) },
    ],
  });
  const proj = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog, path: ['/w/proj'] });
  const named = proj.nodes.filter((n) => n.label === '(commands)');
  assert.deepEqual(named.map((n) => n.kind).sort(), ['folder', 'group']);
  const folder = named.find((n) => n.kind === 'folder');
  const inside = analyzeBreakdown({ records: s.records, digests: [s.digest], range: '7d', now: NOW, catalog, path: ['/w/proj', folder.key] });
  assert.deepEqual(inside.nodes.map((n) => [n.key, n.kind]), [['a.mjs', 'file']]);
});
