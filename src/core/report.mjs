// Use case: usage records -> the Report the panel renders (contract in PLAN.md). Pure: no Node
// built-in or Orca imports. Days and hours bucket in local time. Records with a bad timestamp or
// a day after `now` belong to no window, so they are skipped. Each record is visited twice, once
// to normalize and once to aggregate.
import { ratesFor } from './catalog.mjs';
import { DEFAULT_CATALOG, tableCosts } from './pricing.mjs';
import { dayKey, selectRecords } from './filters.mjs';

const CALENDAR_DAYS = 182;
const TOP_PROJECTS = 8;

export function buildReport(records, { range, now = new Date(), providers, hosts, scope, catalog = DEFAULT_CATALOG } = {}) {
  const selected = selectRecords(records, { range, now, providers, hosts, scope });
  const { table, rows, days, slots, count, hostNames, today, startDay, allProviders, allHosts, rowProviders } = selected;
  const { costs, entries } = tableCosts(table, catalog);
  const { names } = table;
  const nameOf = (id) => (id < 0 ? undefined : names[id]);

  // Pass 2: perDay covers every day (streak, calendar). The rest only count in-range records.
  const perDay = new Map();
  const perProviderDay = new Map(); // provider id -> day -> bucket, in-range records only
  const totals = { ...blank(), savingsUsd: 0 };
  const sessionsByProvider = new Map();
  const sessionsByModel = new Map();
  const sessionsByHost = new Map();
  const tokensByModel = new Map();
  const punchCard = new Array(168).fill(0);
  const models = new Map();
  const projects = new Map();
  const providerBuckets = new Map();
  const hostBuckets = new Map();
  const unpricedByModel = new Map(); // model id -> { model, turns, tokens }, in-range records only
  const { provider: providerCol, model: modelCol, project: projectCol, sessionId: sessionCol, host: hostCol } = table;
  const { input: inputCol, output: outputCol, cacheRead: readCol, cacheWrite: writeCol } = table;
  for (let k = 0; k < count; k++) {
    const i = rows[k];
    const day = days[k];
    const usd = costs[i];
    const cost = Number.isNaN(usd) ? null : usd;
    const input = inputCol[i];
    const output = outputCol[i];
    const cacheRead = readCol[i];
    const cacheWrite = writeCol[i];
    add(bucket(perDay, day), input, output, cacheRead, cacheWrite, cost);
    if (day < startDay) continue;
    const tokens = input + output + cacheRead + cacheWrite;
    const provider = providerCol[i];
    const model = modelCol[i];
    const sessionId = sessionCol[i];
    const host = hostNames[hostCol[i] + 1];
    add(totals, input, output, cacheRead, cacheWrite, cost);
    if (cost === null) {
      const unpriced = getOrSet(unpricedByModel, model, () => ({ model: nameOf(model), turns: 0, tokens: 0 }));
      unpriced.turns += 1;
      unpriced.tokens += tokens;
    }
    // Saved against full input price at the rates the request paid (its long-prompt tier, if any).
    const entry = entries[model + 1];
    const price = entry && cacheRead > 0 ? ratesFor(entry, input, cacheRead, cacheWrite) : null;
    totals.savingsUsd += price ? (cacheRead * (price.input - price.cacheRead)) / 1e6 : 0;
    getOrSet(sessionsByProvider, provider, newSet).add(sessionId);
    getOrSet(getOrSet(sessionsByModel, model, newMap), provider, newSet).add(sessionId);
    getOrSet(getOrSet(sessionsByHost, host, newMap), provider, newSet).add(sessionId);
    const tokensByProvider = getOrSet(tokensByModel, model, newMap);
    const providerName = nameOf(provider);
    tokensByProvider.set(providerName, (tokensByProvider.get(providerName) ?? 0) + tokens);
    punchCard[slots[k]] += tokens;
    add(bucket(models, model), input, output, cacheRead, cacheWrite, cost);
    add(bucket(projects, projectCol[i]), input, output, cacheRead, cacheWrite, cost);
    add(bucket(providerBuckets, provider), input, output, cacheRead, cacheWrite, cost);
    add(bucket(hostBuckets, host), input, output, cacheRead, cacheWrite, cost);
    add(bucket(getOrSet(perProviderDay, provider, newMap), day), input, output, cacheRead, cacheWrite, cost);
  }
  const providerIds = new Map([...providerBuckets.keys(), ...perProviderDay.keys()].map((id) => [nameOf(id), id]));

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
      const byDay = perProviderDay.get(providerIds.get(provider)) ?? new Map();
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
    scoped: Boolean(scope),
    prices: { version: catalog.version, asOf: newestAsOf(catalog) },
    totals: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.total,
      costUsd: totals.costUsd,
      cacheSavingsUsd: totals.savingsUsd,
      hasUnpriced: totals.unpricedTurns > 0,
      unpricedModels: [...unpricedByModel.values()].sort(
        (a, b) => b.tokens - a.tokens || (String(a.model) < String(b.model) ? -1 : String(a.model) > String(b.model) ? 1 : 0),
      ),
      sessions: countSessions(sessionsByProvider),
      turns: totals.pricedTurns + totals.unpricedTurns,
      cacheReuseRate: reads > 0 ? totals.cacheRead / reads : 0,
      // Stricter: cache writes are input that missed the cache, so they count in the denominator.
      cacheHitRate: reads + totals.cacheWrite > 0 ? totals.cacheRead / (reads + totals.cacheWrite) : 0,
    },
    today: { total: todayBucket.total, costUsd: costOf(todayBucket) },
    daily,
    seriesByProvider,
    calendar,
    punchCard,
    byModel: [...models]
      .map(([model, b]) => ({
        model: nameOf(model),
        total: b.total,
        costUsd: costOf(b),
        share: share(b.total),
        provider: topProvider(tokensByModel.get(model)),
        sessions: countSessions(sessionsByModel.get(model)),
      }))
      .sort(byTotal),
    byProject: [...projects]
      .map(([project, b]) => ({ project: nameOf(project), total: b.total, share: share(b.total) }))
      .sort(byTotal)
      .slice(0, TOP_PROJECTS),
    byProvider: [...providerBuckets]
      .map(([provider, b]) => ({
        provider: nameOf(provider),
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
        sessions: countSessions(sessionsByHost.get(host)),
        turns: b.pricedTurns + b.unpricedTurns,
      }))
      .sort(byTotal),
    streak: { current, longest },
    peakDay,
  };
}

// 'local' first, the other hosts sorted. The stable second sort keeps the sorted order of the rest.
function sortHosts(hosts) {
  return [...hosts].sort().sort((a, b) => (b === 'local') - (a === 'local'));
}

const newSet = () => new Set();
const newMap = () => new Map();

function countSessions(byProvider) {
  let n = 0;
  for (const ids of byProvider.values()) n += ids.size;
  return n;
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

function add(b, input, output, cacheRead, cacheWrite, cost) {
  b.input += input;
  b.output += output;
  b.cacheRead += cacheRead;
  b.cacheWrite += cacheWrite;
  b.total += input + output + cacheRead + cacheWrite;
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

export function newestAsOf(catalog) {
  let newest = null;
  for (const entry of catalog.entries.values()) {
    if (entry.asOf && (newest === null || entry.asOf > newest)) newest = entry.asOf;
  }
  return newest;
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
