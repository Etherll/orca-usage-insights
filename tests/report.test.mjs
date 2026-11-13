import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/core/report.mjs';
import { BUNDLED } from '../src/core/catalog-data.mjs';
import { buildCatalog } from '../src/core/catalog.mjs';

// Fixed "now" is local 2026-11-03 15:30. Every timestamp is built from local parts, so these
// assertions hold in any TZ.
const NOW = new Date(2026, 10, 3, 15, 30);
const ago = (days, hour = 12) => new Date(2026, 10, 3 - days, hour);
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function rec(date, over = {}) {
  return {
    provider: 'claude', ts: date.toISOString(), model: 'claude-sonnet-4-5', project: 'alpha', sessionId: 's1',
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over,
  };
}
const build = (records, range = '7d', extra = {}) => buildReport(records, { range, now: NOW, ...extra });
const model = (r, name) => r.byModel.find((m) => m.model === name);

test('totals sum the four token kinds and derive cache reuse', () => {
  const r = build([rec(ago(0), { input: 100, output: 50, cacheRead: 300, cacheWrite: 10 })]);
  assert.deepEqual(
    { input: r.totals.input, output: r.totals.output, cacheRead: r.totals.cacheRead, cacheWrite: r.totals.cacheWrite, total: r.totals.total, sessions: r.totals.sessions, turns: r.totals.turns },
    { input: 100, output: 50, cacheRead: 300, cacheWrite: 10, total: 460, sessions: 1, turns: 1 },
  );
  assert.equal(r.totals.cacheReuseRate, 0.75);
  assert.equal(r.totals.cacheHitRate, 300 / 410);
});

test('cache reuse is 0 when there is no input or cache read', () => {
  assert.equal(build([rec(ago(0), { output: 9 })]).totals.cacheReuseRate, 0);
  assert.equal(build([]).totals.cacheReuseRate, 0);
  assert.equal(build([]).totals.cacheHitRate, 0);
  assert.equal(build([rec(ago(0), { cacheWrite: 5 })]).totals.cacheHitRate, 0);
});

test('cost is priced per model; unpriced models are flagged and never priced', () => {
  const priced = build([rec(ago(0), { model: 'claude-opus-5-5', input: 1_000_000 })]);
  assert.equal(priced.totals.costUsd, 4);
  assert.equal(priced.totals.hasUnpriced, false);

  const mixed = build([
    rec(ago(0), { model: 'claude-opus-5-5', input: 1_000_000 }),
    rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 1_000_000 }),
  ]);
  assert.equal(mixed.totals.costUsd, 4);
  assert.equal(mixed.totals.hasUnpriced, true);
  assert.equal(mixed.today.costUsd, 4);
  assert.equal(model(mixed, 'claude-opus-5-5').costUsd, 4);
  assert.equal(model(mixed, 'gpt-5-codex').costUsd, null);
  assert.equal(mixed.byProvider.find((p) => p.provider === 'codex').costUsd, null);
  assert.equal(mixed.byProvider.find((p) => p.provider === 'claude').costUsd, 4);

  const onlyUnpriced = build([rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 5 })]);
  assert.equal(onlyUnpriced.totals.costUsd, 0);
  assert.equal(onlyUnpriced.totals.hasUnpriced, true);
  assert.equal(onlyUnpriced.daily.at(-1).costUsd, 0);
});

test('7d daily is zero-filled, ascending and bounded by the window', () => {
  const r = build([rec(ago(7), { input: 1 }), rec(ago(6), { input: 5 })]);
  assert.equal(r.daily.length, 7);
  assert.equal(r.daily[0].day, keyOf(ago(6)));
  assert.equal(r.daily[6].day, '2026-11-03');
  assert.equal(r.daily[0].total, 5);
  assert.equal(r.daily.reduce((s, d) => s + d.total, 0), 5);
  assert.equal(r.totals.turns, 1);
});

test('1d covers the local calendar day and preserves calendar and streak history', () => {
  const records = [
    rec(new Date(2026, 10, 2, 23, 59, 59, 999), { input: 100, sessionId: 'yesterday' }),
    rec(new Date(2026, 10, 3, 0, 0, 0), { input: 10, project: 'today' }),
    rec(NOW, { output: 5, project: 'today' }),
    rec(new Date(2026, 10, 4, 0, 0, 0), { input: 1000, sessionId: 'tomorrow' }),
  ];
  const r = build(records, '1d');
  assert.equal(r.range, '1d');
  assert.deepEqual(r.daily.map((d) => d.day), [keyOf(NOW)]);
  assert.equal(r.daily[0].total, 15);
  assert.equal(r.totals.total, r.today.total);
  assert.equal(r.totals.total, 15);
  assert.equal(r.totals.turns, 2);
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.byModel[0].total, 15);
  assert.deepEqual(r.byProject, [{ project: 'today', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, share: 1 }]);
  assert.equal(r.seriesByProvider[0].daily.length, 1);
  assert.equal(r.seriesByProvider[0].daily[0].total, 15);
  assert.deepEqual(r.calendar, build(records).calendar);
  assert.deepEqual(r.streak, { current: 2, longest: 2 });
});

test('1d with no usage today has one zero-filled day and no in-range breakdowns', () => {
  const r = build([rec(ago(1), { input: 50 })], '1d');
  assert.equal(r.daily.length, 1);
  assert.equal(r.daily[0].day, keyOf(NOW));
  assert.equal(r.daily[0].total, 0);
  assert.equal(r.totals.turns, 0);
  assert.equal(r.totals.total, 0);
  assert.deepEqual(r.byModel, []);
  assert.deepEqual(r.byProject, []);
});

test('30d and 90d windows span that many days', () => {
  assert.equal(build([], '30d').daily.length, 30);
  assert.equal(build([], '90d').daily.length, 90);
  assert.equal(build([], '30d').daily[0].day, keyOf(ago(29)));
});

test('all with no records is just today', () => {
  const r = build([], 'all');
  assert.deepEqual(r.daily.map((d) => d.day), ['2026-11-03']);
  assert.equal(r.totals.total, 0);
  assert.equal(r.totals.turns, 0);
  assert.equal(r.today.total, 0);
  assert.equal(r.peakDay, null);
  assert.deepEqual(r.streak, { current: 0, longest: 0 });
  assert.deepEqual(r.providers, []);
});

test('all starts at the earliest record day', () => {
  const r = build([rec(ago(40)), rec(ago(2))], 'all');
  assert.equal(r.daily.length, 41);
  assert.equal(r.daily[0].day, keyOf(ago(40)));
  assert.equal(r.totals.turns, 2);
});

test('providers narrows every figure but still lists providers present in the data', () => {
  const r = build(
    [rec(ago(0), { input: 10 }), rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 90, sessionId: 'c1' })],
    '7d',
    { providers: ['codex'] },
  );
  assert.equal(r.totals.total, 90);
  assert.equal(r.totals.turns, 1);
  assert.deepEqual(r.byProvider.map((p) => p.provider), ['codex']);
  assert.equal(r.today.total, 90);
  assert.deepEqual(r.providers, ['claude', 'codex']);
});

test('sessions are distinct per provider and session id; turns count records', () => {
  const r = build([
    rec(ago(0), { sessionId: 'abc' }),
    rec(ago(0), { sessionId: 'abc' }),
    rec(ago(1), { sessionId: 'abc', provider: 'codex', model: 'gpt-5-codex' }),
  ]);
  assert.equal(r.totals.sessions, 2);
  assert.equal(r.totals.turns, 3);
});

test('shares are fractions of the range total; byProject keeps the top eight', () => {
  const r = build([
    rec(ago(0), { model: 'claude-opus-5-5', input: 300 }),
    rec(ago(0), { model: 'claude-haiku-5', input: 100 }),
  ]);
  assert.deepEqual(r.byModel.map((m) => [m.model, m.total, m.share]), [['claude-opus-5-5', 300, 0.75], ['claude-haiku-5', 100, 0.25]]);
  assert.deepEqual(build([]).byModel, []);

  const many = build(Array.from({ length: 10 }, (_, i) => rec(ago(0), { project: `p${i}`, input: i + 1 })));
  assert.equal(many.byProject.length, 8);
  assert.equal(many.byProject[0].project, 'p9');
  assert.equal(many.byProject[0].share, 10 / 55);
  assert.ok(many.byProject.every((p, i, all) => i === 0 || all[i - 1].total >= p.total));
});

test('punchCard buckets tokens by local weekday and hour inside the range', () => {
  const at = new Date(2026, 10, 3, 14);
  const r = build([rec(at, { input: 7 }), rec(ago(10, 14), { input: 100 })]);
  assert.equal(r.punchCard.length, 168);
  assert.equal(r.punchCard[at.getDay() * 24 + 14], 7);
  assert.equal(r.punchCard.reduce((s, v) => s + v, 0), 7);
});

test('calendar covers 182 days ending today and ignores the range', () => {
  const r = build([rec(ago(100), { input: 5 }), rec(ago(200), { input: 9 })]);
  assert.equal(r.calendar.length, 182);
  assert.equal(r.calendar[181].day, '2026-11-03');
  assert.equal(r.calendar[0].day, keyOf(ago(181)));
  assert.equal(r.calendar.find((c) => c.day === keyOf(ago(100))).total, 5);
  assert.equal(r.calendar.reduce((s, c) => s + c.total, 0), 5);
  assert.equal(r.totals.total, 0);
});

test('streak counts consecutive days over all records, not just the range', () => {
  const r = build([0, 1, 2, 4, 5, 6, 7, 8].map((n) => rec(ago(n), { input: 1 })), '7d');
  assert.deepEqual(r.streak, { current: 3, longest: 5 });
});

test('current streak still counts when today has no usage yet', () => {
  assert.deepEqual(build([rec(ago(1), { input: 1 }), rec(ago(2), { input: 1 })]).streak, { current: 2, longest: 2 });
  assert.deepEqual(build([rec(ago(3), { input: 1 })]).streak, { current: 0, longest: 1 });
});

test('peakDay is the busiest day in range, earliest on a tie, and null when quiet', () => {
  const r = build([rec(ago(1), { input: 500 }), rec(ago(3), { input: 900 }), rec(ago(20), { input: 5000 })]);
  assert.deepEqual(r.peakDay, { day: keyOf(ago(3)), total: 900 });
  const tie = build([rec(ago(1), { input: 500 }), rec(ago(2), { input: 500 })]);
  assert.deepEqual(tie.peakDay, { day: keyOf(ago(2)), total: 500 });
  assert.equal(build([rec(ago(20), { input: 5 })]).peakDay, null);
});

test('today is counted; records after today or with a bad timestamp are skipped', () => {
  const r = build([
    rec(new Date(2026, 10, 3, 9), { input: 40 }),
    rec(new Date(2026, 10, 4, 12), { input: 1000 }),
    { ...rec(ago(0)), ts: 'not a date', input: 1000 },
  ]);
  assert.equal(r.today.total, 40);
  assert.equal(r.totals.total, 40);
  assert.equal(r.totals.turns, 1);
  assert.equal(r.calendar.at(-1).total, 40);
  assert.equal(r.daily.at(-1).total, 40);
});

test('echoes generatedAt and range, and rejects unknown ranges', () => {
  const r = build([], '90d');
  assert.equal(r.generatedAt, NOW.toISOString());
  assert.equal(r.range, '90d');
  assert.throws(() => build([], '1y'), RangeError);
});

test('report survives a JSON round trip unchanged', () => {
  const r = build([
    rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 3 }),
    rec(ago(1), { input: 4, cacheRead: 2 }),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('cacheSavingsUsd is the input-vs-cache-read discount on priced cache reads in range', () => {
  const r = build([
    rec(ago(0), { model: 'claude-sonnet-4-5', cacheRead: 2_000_000 }),
    rec(ago(20), { model: 'claude-sonnet-4-5', cacheRead: 9_000_000 }),
  ]);
  // Sonnet 4.5 bills input at $3 and cache reads at $0.30 per 1M, so 2M reads save 2 x $2.70.
  assert.ok(Math.abs(r.totals.cacheSavingsUsd - 5.4) < 1e-9, String(r.totals.cacheSavingsUsd));
});

test('unpriced models save nothing in cacheSavingsUsd', () => {
  assert.equal(build([]).totals.cacheSavingsUsd, 0);
  assert.equal(build([rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', cacheRead: 5_000_000 })]).totals.cacheSavingsUsd, 0);

  const mixed = build([
    rec(ago(0), { model: 'claude-haiku-5-5', cacheRead: 1_000_000 }),
    rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', cacheRead: 9_000_000 }),
  ]);
  // A 1M-token prompt is over Haiku 5.5's 100k tier, which bills input at $0.50 and cache reads at
  // $0.05 per 1M, so 1M reads save $0.45 (the same tier its cost uses).
  assert.ok(Math.abs(mixed.totals.cacheSavingsUsd - 0.45) < 1e-9, String(mixed.totals.cacheSavingsUsd));
});

test('byProvider counts sessions and turns per provider, inside the range only', () => {
  const r = build([
    rec(ago(0), { sessionId: 'abc', input: 1 }),
    rec(ago(0), { sessionId: 'abc', input: 1 }),
    rec(ago(1), { sessionId: 'def', input: 1 }),
    rec(ago(1), { provider: 'codex', model: 'gpt-5-codex', sessionId: 'abc', input: 1 }),
    rec(ago(30), { sessionId: 'old', input: 1 }),
  ]);
  const provider = (name) => r.byProvider.find((p) => p.provider === name);
  assert.deepEqual([provider('claude').sessions, provider('claude').turns], [2, 3]);
  assert.deepEqual([provider('codex').sessions, provider('codex').turns], [1, 1]);
  assert.equal(r.totals.sessions, 3);
});

test('byModel names the provider with the most tokens and counts distinct sessions', () => {
  const r = build([
    rec(ago(0), { model: 'm-a', input: 100, sessionId: 's1' }),
    rec(ago(0), { model: 'm-a', provider: 'codex', input: 300, sessionId: 'c1' }),
    rec(ago(1), { model: 'm-a', input: 100, sessionId: 's1' }),
    rec(ago(0), { model: 'm-b', input: 500, sessionId: 's2' }),
    rec(ago(0), { model: 'm-b', provider: 'codex', input: 200, sessionId: 'c1' }),
    rec(ago(0), { model: 'm-c', provider: 'codex', input: 50, sessionId: 'c2' }),
    rec(ago(0), { model: 'm-c', input: 50, sessionId: 's3' }),
  ]);
  assert.deepEqual([model(r, 'm-a').provider, model(r, 'm-a').sessions], ['codex', 2]);
  assert.deepEqual([model(r, 'm-b').provider, model(r, 'm-b').sessions], ['claude', 2]);
  // A tie goes to the provider sorted first, whatever the record order.
  assert.deepEqual([model(r, 'm-c').provider, model(r, 'm-c').sessions], ['claude', 2]);
});

test('seriesByProvider holds one zero-filled series per provider, aligned with daily, largest first', () => {
  const r = build([
    rec(ago(0), { model: 'claude-opus-5-5', input: 250_000 }),
    rec(ago(3), { model: 'claude-opus-5-5', input: 250_000 }),
    rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 1_000_000 }),
    rec(ago(5), { provider: 'codex', model: 'gpt-5-codex', input: 500_000 }),
  ]);
  assert.deepEqual(r.seriesByProvider.map((s) => s.provider), ['codex', 'claude']);
  for (const s of r.seriesByProvider) {
    assert.deepEqual(s.daily.map((d) => d.day), r.daily.map((d) => d.day));
  }
  const [codex, claude] = r.seriesByProvider;
  assert.deepEqual(codex.daily.map((d) => d.total), [0, 500_000, 0, 0, 0, 0, 1_000_000]);
  assert.deepEqual(claude.daily.map((d) => d.total), [0, 0, 0, 250_000, 0, 0, 250_000]);
  assert.deepEqual(claude.daily.map((d) => d.costUsd), [0, 0, 0, 1, 0, 0, 1]);
});

test('seriesByProvider counts unpriced records as zero cost', () => {
  const r = build([rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 5 })]);
  assert.deepEqual(r.seriesByProvider, [{ provider: 'codex', daily: r.daily.map((d, i) => ({ day: d.day, total: i === 6 ? 5 : 0, costUsd: 0 })) }]);
});

test('seriesByProvider follows the providers filter', () => {
  const r = build(
    [
      rec(ago(0), { model: 'claude-opus-5-5', input: 250_000 }),
      rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 1_000_000 }),
    ],
    '7d',
    { providers: ['claude'] },
  );
  assert.deepEqual(r.seriesByProvider.map((s) => s.provider), ['claude']);
  assert.equal(r.seriesByProvider[0].daily.at(-1).total, 250_000);
  assert.deepEqual(r.providers, ['claude', 'codex']);
});

test('a provider whose records all predate the window keeps an all-zero series, sorted last', () => {
  const r = build([
    rec(ago(0), { model: 'claude-opus-5-5', input: 1 }),
    rec(ago(20), { provider: 'codex', model: 'gpt-5-codex', input: 9_000_000 }),
  ]);
  assert.deepEqual(r.seriesByProvider.map((s) => s.provider), ['claude', 'codex']);
  assert.deepEqual(r.seriesByProvider[1].daily.map((d) => d.total), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(r.byProvider.map((p) => p.provider), ['claude']);
});

test('seriesByProvider days follow the all range start', () => {
  const r = build([rec(ago(40), { input: 5 }), rec(ago(2), { provider: 'codex', model: 'gpt-5-codex', input: 7 })], 'all');
  assert.equal(r.daily.length, 41);
  for (const s of r.seriesByProvider) assert.equal(s.daily.length, 41);
  const codex = r.seriesByProvider.find((s) => s.provider === 'codex');
  assert.equal(codex.daily[38].day, keyOf(ago(2)));
  assert.equal(codex.daily[38].total, 7);
});

test('scope keeps a cwd equal to a root or under it at a segment boundary', () => {
  const r = build(
    [
      rec(ago(0), { cwd: '/a/b', input: 1 }),
      rec(ago(0), { cwd: '/a/b/c', input: 10 }),
      rec(ago(0), { cwd: '/a/bc', input: 100 }),
      rec(ago(0), { cwd: '/a/bc/d', input: 1000 }),
      rec(ago(0), { cwd: '/x', input: 10000 }),
    ],
    '7d',
    { scope: { roots: ['/a/b'] } },
  );
  assert.equal(r.totals.total, 11);
  assert.equal(r.totals.turns, 2);
  assert.equal(r.scoped, true);

  const sibling = build([rec(ago(0), { cwd: '/a/b', input: 1 })], '7d', { scope: { roots: ['/a/bc'] } });
  assert.equal(sibling.totals.turns, 0);
});

test('scope normalises Windows separators and trailing slashes; caseInsensitive folds case', () => {
  const records = [
    rec(ago(0), { cwd: 'C:\\Users\\Me\\Repo\\app', input: 1 }),
    rec(ago(0), { cwd: 'c:/users/me/repo', input: 10 }),
    rec(ago(0), { cwd: 'C:\\Users\\Me\\Repository', input: 100 }),
    rec(ago(0), { cwd: 'D:\\Users\\Me\\Repo', input: 1000 }),
  ];
  const roots = ['C:\\Users\\Me\\Repo\\'];

  const folded = build(records, '7d', { scope: { roots, caseInsensitive: true } });
  assert.equal(folded.totals.total, 11);
  assert.equal(folded.totals.turns, 2);

  const exact = build(records, '7d', { scope: { roots } });
  assert.equal(exact.totals.total, 1);
  assert.equal(exact.totals.turns, 1);
});

test('records with an empty cwd are excluded only when a scope is given', () => {
  const records = [rec(ago(0), { cwd: '', input: 5 }), rec(ago(0), { cwd: '/a', input: 7 })];
  const unscoped = build(records);
  assert.equal(unscoped.totals.total, 12);
  assert.equal(unscoped.scoped, false);

  assert.equal(build(records, '7d', { scope: { roots: ['/a'] } }).totals.total, 7);
  // A '/' root covers every absolute cwd, but an empty cwd is still not a path.
  assert.equal(build(records, '7d', { scope: { roots: ['/'] } }).totals.total, 7);
});

test('an empty roots array matches nothing and still marks the report scoped', () => {
  const r = build([rec(ago(0), { cwd: '/a', input: 5 })], '7d', { scope: { roots: [] } });
  assert.equal(r.totals.turns, 0);
  assert.equal(r.today.total, 0);
  assert.equal(r.scoped, true);
});

test('hosts lists every input host, local first; a hosts filter narrows like providers', () => {
  const records = [
    rec(ago(0), { host: 'ssh:box', input: 40, sessionId: 'b1' }),
    rec(ago(0), { input: 10, sessionId: 'l1' }), // no host field: counts as local
    rec(ago(0), { host: 'local', input: 20, sessionId: 'l2' }),
    rec(ago(0), { host: 'ssh:alpha', input: 5, sessionId: 'a1' }),
  ];
  const all = build(records);
  assert.deepEqual(all.hosts, ['local', 'ssh:alpha', 'ssh:box']);
  assert.equal(all.totals.total, 75);
  assert.equal(all.scoped, false);

  const box = build(records, '7d', { hosts: ['ssh:box'] });
  assert.equal(box.totals.total, 40);
  assert.equal(box.totals.turns, 1);
  assert.deepEqual(box.hosts, ['local', 'ssh:alpha', 'ssh:box']);
  assert.deepEqual(box.byHost.map((h) => h.host), ['ssh:box']);

  assert.equal(build(records, '7d', { hosts: ['local'] }).totals.total, 30);
  assert.equal(build(records, '7d', { hosts: [] }).totals.turns, 0);

  assert.deepEqual(build([rec(ago(0), { host: 'ssh:b' }), rec(ago(0), { host: 'ssh:a' })]).hosts, ['ssh:a', 'ssh:b']);
});

test('byHost sums each host with its share, sessions and turns, largest first', () => {
  const r = build([
    rec(ago(0), { host: 'ssh:box', model: 'claude-opus-5-5', input: 750_000, sessionId: 'b1' }),
    rec(ago(1), { host: 'ssh:box', model: 'claude-opus-5-5', input: 250_000, sessionId: 'b1' }),
    rec(ago(0), { input: 300_000, sessionId: 'l1' }),
    rec(ago(0), { host: 'local', provider: 'codex', model: 'gpt-5-codex', input: 200_000, sessionId: 'c1' }),
  ]);
  assert.deepEqual(r.byHost, [
    { host: 'ssh:box', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000, costUsd: 4, share: 2 / 3, sessions: 1, turns: 2 },
    { host: 'local', input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 500_000, costUsd: 0.9, share: 1 / 3, sessions: 2, turns: 2 },
  ]);

  const unpriced = build([rec(ago(0), { host: 'ssh:x', provider: 'codex', model: 'gpt-5-codex', input: 5 })]);
  assert.deepEqual(unpriced.byHost, [{ host: 'ssh:x', input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5, costUsd: null, share: 1, sessions: 1, turns: 1 }]);
  assert.deepEqual(build([]).byHost, []);
});

test('scope and hosts narrow every output, not only the totals', () => {
  const r = build(
    [
      rec(ago(0), { cwd: '/w/app', host: 'ssh:box', input: 100 }),
      rec(ago(1), { cwd: '/elsewhere', host: 'ssh:box', input: 1000 }),
      rec(ago(2), { cwd: '/w/app', host: 'local', input: 10 }),
      rec(ago(3), { cwd: '/w/app', host: 'ssh:box', input: 1 }),
    ],
    '7d',
    { scope: { roots: ['/w'] }, hosts: ['ssh:box'] },
  );
  assert.equal(r.totals.total, 101);
  assert.equal(r.today.total, 100);
  assert.equal(r.daily.reduce((s, d) => s + d.total, 0), 101);
  assert.equal(r.calendar.reduce((s, c) => s + c.total, 0), 101);
  assert.equal(r.punchCard.reduce((s, v) => s + v, 0), 101);
  assert.equal(model(r, 'claude-sonnet-4-5').total, 101);
  assert.equal(r.seriesByProvider[0].daily.reduce((s, d) => s + d.total, 0), 101);
  // Days 0 and 3 are active, days 1 and 2 are filtered out, so the streak breaks.
  assert.deepEqual(r.streak, { current: 1, longest: 1 });
  assert.deepEqual(r.byHost.map((h) => [h.host, h.total]), [['ssh:box', 101]]);
  assert.deepEqual(r.hosts, ['local', 'ssh:box']);
});

test('unpricedModels lists unpriced models by tokens, ties by name, in range only', () => {
  const r = build([
    rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 100 }),
    rec(ago(1), { provider: 'codex', model: 'gpt-5-codex', output: 10 }),
    rec(ago(0), { provider: 'codex', model: 'gpt-5.1-codex-mini', input: 10 }),
    rec(ago(0), { provider: 'codex', model: 'codex', input: 10 }),
    rec(ago(30), { provider: 'codex', model: 'old-model', input: 999 }),
    rec(ago(0), { model: 'claude-opus-5-5', input: 1_000_000 }),
  ], '7d');
  assert.deepEqual(r.totals.unpricedModels, [
    { model: 'gpt-5-codex', turns: 2, tokens: 110 },
    { model: 'codex', turns: 1, tokens: 10 },
    { model: 'gpt-5.1-codex-mini', turns: 1, tokens: 10 },
  ]);
  assert.deepEqual(build([]).totals.unpricedModels, []);
});

test('prices names the default catalog version and its newest price date', () => {
  const r = build([]);
  assert.match(r.prices.version, /^[0-9a-f]{8}$/);
  assert.equal(r.prices.asOf, '2026-11-12');
});

test('a catalog option prices every record and the report names that catalog', () => {
  const catalog = buildCatalog(BUNDLED, null, { asOf: '2026-12-01', models: { 'claude-opus-5-5': { input: 1 } } });
  const r = build([rec(ago(0), { model: 'claude-opus-5-5', input: 1_000_000 })], '7d', { catalog });
  assert.equal(r.totals.costUsd, 1);
  assert.equal(r.today.costUsd, 1);
  assert.equal(r.prices.version, catalog.version);
  assert.notEqual(r.prices.version, build([]).prices.version);
  assert.equal(r.prices.asOf, '2026-12-01');
});

test('cacheSavingsUsd uses the catalog it is given', () => {
  const catalog = buildCatalog(BUNDLED, null, { models: { 'claude-sonnet-4-5': { input: 10, cacheRead: 1 } } });
  const r = build([rec(ago(0), { model: 'claude-sonnet-4-5', cacheRead: 2_000_000 })], '7d', { catalog });
  // Sonnet 4.5 has no tiers here, so 2M reads save 2 x ($10 - $1).
  assert.ok(Math.abs(r.totals.cacheSavingsUsd - 18) < 1e-9, String(r.totals.cacheSavingsUsd));
});

test('today.costUsd is null when today has no priced turn', () => {
  assert.equal(build([]).today.costUsd, null);
  assert.equal(build([rec(ago(1), { model: 'claude-opus-5-5', input: 1 })]).today.costUsd, null);
  assert.equal(build([rec(ago(0), { provider: 'codex', model: 'gpt-5-codex', input: 1 })]).today.costUsd, null);
});

test('cache savings use the rates the request paid, its long-prompt tier included', async () => {
  const { DEFAULT_CATALOG } = await import('../src/core/pricing.mjs');
  const record = { provider: 'codex', ts: '2026-11-12T10:00:00Z', model: 'gpt-5.6', project: 'p', sessionId: 's', input: 1000, output: 0, cacheRead: 300_000, cacheWrite: 0, cacheWrite1h: 0 };
  const entry = DEFAULT_CATALOG.entries.get('gpt-5.6');
  const tier = entry.tiers.find((t) => t.above === 272_000);
  const report = buildReport([record], { range: '7d', now: new Date('2026-11-12T12:00:00Z'), catalog: DEFAULT_CATALOG });
  assert.ok(Math.abs(report.totals.cacheSavingsUsd - (300_000 * (tier.input - tier.cacheRead)) / 1e6) < 1e-9);
  const small = buildReport([{ ...record, cacheRead: 100_000 }], { range: '7d', now: new Date('2026-11-12T12:00:00Z'), catalog: DEFAULT_CATALOG });
  assert.ok(Math.abs(small.totals.cacheSavingsUsd - (100_000 * (entry.input - entry.cacheRead)) / 1e6) < 1e-9);
});

test('custom dates include local boundary days, zero fill, and exclude later history', () => {
  const r = build([
    rec(new Date(2026, 9, 31, 23, 59, 59), { input: 100 }),
    rec(new Date(2026, 10, 1, 0), { input: 2 }),
    rec(new Date(2026, 10, 3, 23, 59, 59), { input: 3 }),
  ], 'custom', { startDate: '2026-11-01', endDate: '2026-11-02' });
  assert.equal(r.startDate, '2026-11-01');
  assert.equal(r.endDate, '2026-11-02');
  assert.deepEqual(r.daily.map((d) => d.total), [2, 0]);
  assert.equal(r.totals.total, 2);
  assert.equal(r.today.total, 3, 'today keeps its independent time range');
  assert.equal(r.calendar.at(-1).total, 3);
  assert.equal(r.seriesByProvider[0].daily.length, 2);
  assert.deepEqual(r.byDayModel.map((d) => [d.day, d.total]), [['2026-11-01', 2]]);
});

test('model options follow source scope but survive selected models and dates', () => {
  const records = [rec(ago(0), { model: 'a', input: 1, cwd: '/w/a' }), rec(ago(20), { model: 'b', input: 9, cwd: '/w/b' }), rec(ago(0), { model: 'other', input: 99, host: 'ssh:x', cwd: '/w' }), rec(ago(0), { model: 'outside', input: 99, cwd: '/else' })];
  const r = build(records, '1d', { models: ['b'], hosts: ['local'], scope: { roots: ['/w'] } });
  assert.deepEqual(r.models, ['a', 'b']);
  assert.equal(r.totals.total, 0);
  assert.equal(r.today.total, 0);
  assert.deepEqual(r.byDayModel, []);
  assert.equal(build(records, 'all', { models: [] }).totals.total, 0);
});

test('includeCache changes every token aggregate while retaining raw components and costs', () => {
  const records = [rec(ago(0), { model: 'claude-sonnet-4-5', input: 2, output: 3, cacheRead: 100, cacheWrite: 20 }), rec(ago(1), { model: 'other', input: 5, cacheRead: 500 })];
  const full = build(records);
  const r = build(records, '7d', { includeCache: false });
  assert.equal(r.includeCache, false);
  assert.equal(r.totals.total, 10);
  assert.equal(r.totals.cacheRead, 600);
  assert.equal(r.totals.costUsd, full.totals.costUsd);
  assert.equal(r.today.total, 5);
  assert.equal(r.peakDay.total, 5);
  assert.equal(r.punchCard.reduce((a, b) => a + b, 0), 10);
  assert.equal(r.calendar.at(-1).total, 5);
  for (const group of [r.daily, r.byModel, r.byProject, r.byProvider, r.byHost, r.byDayModel]) {
    assert.equal(group.reduce((s, b) => s + b.total, 0), 10);
    for (const b of group) assert.equal(b.total, b.input + b.output);
  }
  assert.equal(r.seriesByProvider[0].daily.reduce((s, d) => s + d.total, 0), 10);
  assert.deepEqual(r.byModel.map((m) => m.share), [0.5, 0.5]);
  assert.deepEqual(r.streak, full.streak);
});

test('day model rows separate providers and count distinct sessions and turns', () => {
  const r = build([rec(ago(0), { model: 'shared', input: 2 }), rec(ago(0), { model: 'shared', input: 3 }), rec(ago(0), { model: 'shared', provider: 'codex', input: 9 })], 'custom', { startDate: '2026-11-03', endDate: '2026-11-03' });
  assert.deepEqual(r.byDayModel.map((d) => [d.provider, d.model, d.total, d.sessions, d.turns]), [['claude', 'shared', 5, 1, 2], ['codex', 'shared', 9, 1, 1]]);
});

test('pure report validates malformed date and model queries', () => {
  for (const extra of [{ range: 'custom', startDate: '2026-02-30', endDate: '2026-03-01' }, { range: 'custom', startDate: '2026-11-03', endDate: '2026-11-02' }, { range: 'custom', startDate: '2026-11-03', endDate: '2026-11-04' }, { models: [''] }, { models: null }, { includeCache: null }, { startDate: '2026-11-01' }]) assert.throws(() => buildReport([], { range: '7d', now: NOW, ...extra }));
});
