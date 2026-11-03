// Use case: usage records -> the Report the panel renders (contract in PLAN.md). Pure: no Node
// built-in or Orca imports. Days and hours bucket in local time. Records with a bad timestamp or
// a day after `now` belong to no window, so they are skipped. Each record is visited twice, once
// to normalize and once to aggregate.
import { estimateCostUsd, priceFor } from './pricing.mjs';

const DAY_MS = 86_400_000;
const RANGE_DAYS = new Map([['7d', 7], ['30d', 30], ['90d', 90]]);
const CALENDAR_DAYS = 182;
const TOP_PROJECTS = 8;

export function buildReport(records, { range, now = new Date(), providers, hosts, scope } = {}) {
  if (range !== 'all' && !RANGE_DAYS.has(range)) throw new RangeError(`Unknown range: ${range}`);
  const today = dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
  const allowed = providers ? new Set(providers) : null;
  const allowedHosts = hosts ? new Set(hosts) : null;
  const inScope = scopeMatcher(scope);

  // Pass 1: local day and weekday-hour slot per record. `providers` and `hosts` list every value in the data.
  const allProviders = new Set();
  const allHosts = new Set();
  const rowProviders = new Set();
  const rows = [];
  let earliest = today;
  for (const record of records) {
    allProviders.add(record.provider);
    const host = hostOf(record);
    allHosts.add(host);
    if (allowed && !allowed.has(record.provider)) continue;
    if (allowedHosts && !allowedHosts.has(host)) continue;
    if (inScope && !inScope(record.cwd)) continue;
    const date = new Date(record.ts);
    if (Number.isNaN(date.getTime())) continue;
    const day = dayNumber(date.getFullYear(), date.getMonth(), date.getDate());
    if (day > today) continue;
    earliest = Math.min(earliest, day);
    rowProviders.add(record.provider);
    rows.push({ record, day, host, slot: date.getDay() * 24 + date.getHours(), cost: estimateCostUsd(record) });
  }
  const startDay = range === 'all' ? earliest : today - (RANGE_DAYS.get(range) - 1);

  // Pass 2: perDay covers every day (streak, calendar). The rest only count in-range records.
  const perDay = new Map();
  const perProviderDay = new Map(); // provider -> day -> bucket, in-range records only
  const totals = { ...blank(), savingsUsd: 0 };
  const sessions = new Set();
  const sessionsByProvider = new Map(); // provider -> Set<sessionId>
  const sessionsByModel = new Map(); // model -> Set<provider:sessionId>
  const tokensByModel = new Map(); // model -> Map<provider, tokens>
  const punchCard = new Array(168).fill(0);
  const models = new Map();
  const projects = new Map();
  const providerBuckets = new Map();
  const hostBuckets = new Map();
  const sessionsByHost = new Map(); // host -> Set<provider:sessionId>
  for (const { record, day, host, slot, cost } of rows) {
    add(bucket(perDay, day), record, cost);
    if (day < startDay) continue;
    add(totals, record, cost);
    totals.savingsUsd += savingsOf(record);
    const session = `${record.provider}:${record.sessionId}`;
    sessions.add(session);
    getOrSet(sessionsByProvider, record.provider, () => new Set()).add(record.sessionId);
    getOrSet(sessionsByModel, record.model, () => new Set()).add(session);
    const tokensByProvider = getOrSet(tokensByModel, record.model, () => new Map());
    tokensByProvider.set(record.provider, (tokensByProvider.get(record.provider) ?? 0) + tokensOf(record));
    punchCard[slot] += tokensOf(record);
    add(bucket(models, record.model), record, cost);
    add(bucket(projects, record.project), record, cost);
    add(bucket(providerBuckets, record.provider), record, cost);
    add(bucket(hostBuckets, host), record, cost);
    getOrSet(sessionsByHost, host, () => new Set()).add(session);
    add(bucket(getOrSet(perProviderDay, record.provider, () => new Map()), day), record, cost);
  }

  const dayOf = (day) => perDay.get(day) ?? blank();
  const share = (value) => (totals.total > 0 ? value / totals.total : 0);

  const daily = [];
  for (let day = startDay; day <= today; day++) {
    const b = dayOf(day);
    daily.push({ day: dayKey(day), input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite, total: b.total, costUsd: b.costUsd });
  }

  let peakDay = null;
  for (const d of daily) {
    if (d.total > 0 && (!peakDay || d.total > peakDay.total)) peakDay = { day: d.day, total: d.total };
  }

  const calendar = [];
  for (let day = today - CALENDAR_DAYS + 1; day <= today; day++) {
    calendar.push({ day: dayKey(day), total: dayOf(day).total });
  }

  // Streak runs over every day with usage. The current run must reach today, or yesterday
  // while today has no usage yet.
  const active = [...perDay].filter(([, b]) => b.total > 0).map(([day]) => day).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev = NaN;
  for (const day of active) {
    run = day === prev + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  const current = prev >= today - 1 ? run : 0;

  const todayBucket = dayOf(today);
  const reads = totals.input + totals.cacheRead;
  const byTotal = (a, b) => b.total - a.total;

  // One series per provider present after the filter, zero-filled over the same days as `daily`.
  // Providers are sorted first, so the stable sort keeps alphabetical order among equal totals.
  const seriesByProvider = [...rowProviders]
    .sort()
    .map((provider) => {
      const byDay = perProviderDay.get(provider) ?? new Map();
      const series = [];
      let total = 0;
      for (let day = startDay; day <= today; day++) {
        const b = byDay.get(day) ?? blank();
        series.push({ day: dayKey(day), total: b.total, costUsd: b.costUsd });
        total += b.total;
      }
      return { entry: { provider, daily: series }, total };
    })
    .sort((a, b) => b.total - a.total)
    .map(({ entry }) => entry);

  return {
    generatedAt: now.toISOString(),
    range,
    providers: [...allProviders].sort(),
    hosts: sortHosts(allHosts),
    scoped: inScope !== null,
    totals: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.total,
      costUsd: totals.costUsd,
      cacheSavingsUsd: totals.savingsUsd,
      hasUnpriced: totals.unpricedTurns > 0,
      sessions: sessions.size,
      turns: totals.pricedTurns + totals.unpricedTurns,
      cacheReuseRate: reads > 0 ? totals.cacheRead / reads : 0,
      // Stricter: cache writes are input that missed the cache, so they count in the denominator.
      cacheHitRate: reads + totals.cacheWrite > 0 ? totals.cacheRead / (reads + totals.cacheWrite) : 0,
    },
    today: { total: todayBucket.total, costUsd: todayBucket.costUsd },
    daily,
    seriesByProvider,
    calendar,
    punchCard,
    byModel: [...models]
      .map(([model, b]) => ({
        model,
        total: b.total,
        costUsd: costOf(b),
        share: share(b.total),
        provider: topProvider(tokensByModel.get(model)),
        sessions: sessionsByModel.get(model).size,
      }))
      .sort(byTotal),
    byProject: [...projects]
      .map(([project, b]) => ({ project, total: b.total, share: share(b.total) }))
      .sort(byTotal)
      .slice(0, TOP_PROJECTS),
    byProvider: [...providerBuckets]
      .map(([provider, b]) => ({
        provider,
        total: b.total,
        costUsd: costOf(b),
        share: share(b.total),
        sessions: sessionsByProvider.get(provider).size,
        turns: b.pricedTurns + b.unpricedTurns,
      }))
      .sort(byTotal),
    byHost: [...hostBuckets]
      .map(([host, b]) => ({
        host,
        total: b.total,
        costUsd: costOf(b),
        share: share(b.total),
        sessions: sessionsByHost.get(host).size,
        turns: b.pricedTurns + b.unpricedTurns,
      }))
      .sort(byTotal),
    streak: { current, longest },
    peakDay,
  };
}

// Predicate for the `scope` option: true when the cwd is one of the roots or sits under one at a
// segment boundary ('/a/b' is not under '/a/bc'). Null when no scope was given. Empty cwds never match.
function scopeMatcher(scope) {
  if (!scope) return null;
  const fold = Boolean(scope.caseInsensitive);
  const roots = (scope.roots ?? []).map((root) => normalizePath(root, fold));
  return (cwd) => {
    if (!cwd) return false;
    const path = normalizePath(cwd, fold);
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
  };
}

// Forward slashes, no trailing slashes, optionally lower-cased. Roots and cwds both go through it.
function normalizePath(path, fold) {
  const slashed = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return fold ? slashed.toLowerCase() : slashed;
}

// Records without a host (and empty ones) belong to this machine.
function hostOf(record) {
  return record.host || 'local';
}

// 'local' first, the other hosts sorted. The stable second sort keeps the sorted order of the rest.
function sortHosts(hosts) {
  return [...hosts].sort().sort((a, b) => (b === 'local') - (a === 'local'));
}

function blank() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0, pricedTurns: 0, unpricedTurns: 0 };
}

function bucket(map, key) {
  return getOrSet(map, key, blank);
}

function getOrSet(map, key, make) {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = make()));
  return value;
}

function add(b, record, cost) {
  b.input += record.input;
  b.output += record.output;
  b.cacheRead += record.cacheRead;
  b.cacheWrite += record.cacheWrite;
  b.total += tokensOf(record);
  if (cost === null) {
    b.unpricedTurns += 1;
  } else {
    b.pricedTurns += 1;
    b.costUsd += cost;
  }
}

// null when every record in the bucket is unpriced; otherwise the sum of the priced records.
function costOf(b) {
  return b.pricedTurns > 0 ? b.costUsd : null;
}

// USD the cache reads saved against paying full input price. Unpriced records save nothing.
function savingsOf(record) {
  const price = priceFor(record.model);
  return price ? (record.cacheRead * (price.input - price.cacheRead)) / 1e6 : 0;
}

// The provider with the most tokens for a model; ties go to the name sorted first.
function topProvider(tokensByProvider) {
  let best = null;
  for (const [provider, tokens] of tokensByProvider) {
    const top = best === null ? -Infinity : tokensByProvider.get(best);
    if (tokens > top || (tokens === top && provider < best)) best = provider;
  }
  return best;
}

function tokensOf(record) {
  return record.input + record.output + record.cacheRead + record.cacheWrite;
}

// Whole days since the epoch for a local calendar date. Day arithmetic stays in whole days, so DST never shifts it.
function dayNumber(year, monthIndex, date) {
  return Date.UTC(year, monthIndex, date) / DAY_MS;
}

function dayKey(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
