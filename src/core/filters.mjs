// Pure: no Node built-in or Orca imports. Records with a bad timestamp or a day after `now` belong to no window.

import { asTable } from './table.mjs';
import { localClock } from './time.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const RANGE_DAYS = new Map([['7d', 7], ['30d', 30], ['90d', 90]]);

// `slots` is the local hour of the week (0 is Sunday 00:00). `hostNames[id + 1]` is 'local' for no host.
// `allProviders` and `allHosts` are before filtering. For 'all', `startDay` is the earliest kept day, or today.
export function selectRecords(records, { range, now = new Date(), providers, hosts, scope } = {}) {
  if (range !== 'all' && !RANGE_DAYS.has(range)) throw new RangeError(`Unknown range: ${range}`);
  const table = asTable(records);
  const { names, length } = table;
  const today = localDay(now);
  const toLocal = localClock();

  // Decisions per name id, made once: index id + 1, so -1 (no value) is slot 0.
  const nameOf = (id) => (id < 0 ? undefined : names[id]);
  const hostNames = new Array(names.length + 1);
  for (let id = -1; id < names.length; id++) hostNames[id + 1] = hostOf({ host: nameOf(id) });
  const allowed = providers ? new Set(providers) : null;
  const allowedHosts = hosts ? new Set(hosts) : null;
  const providerOk = new Uint8Array(names.length + 1);
  const hostOk = new Uint8Array(names.length + 1);
  for (let id = -1; id < names.length; id++) {
    providerOk[id + 1] = !allowed || allowed.has(nameOf(id)) ? 1 : 0;
    hostOk[id + 1] = !allowedHosts || allowedHosts.has(hostNames[id + 1]) ? 1 : 0;
  }
  const matchesScope = scopeMatcher(scope);
  const cwdOk = new Int8Array(names.length + 1).fill(-1); // -1: not decided yet

  const providerSeen = new Uint8Array(names.length + 1);
  const hostSeen = new Uint8Array(names.length + 1);
  const keptProvider = new Uint8Array(names.length + 1);
  const allProviders = new Set();
  const allHosts = new Set();
  const rowProviders = new Set();
  const rows = new Int32Array(length);
  const days = new Int32Array(length);
  const slots = new Uint8Array(length);
  const { provider, host, cwd, ms } = table;
  let count = 0;
  let earliest = today;
  for (let i = 0; i < length; i++) {
    const p = provider[i] + 1;
    const h = host[i] + 1;
    if (providerSeen[p] === 0) {
      providerSeen[p] = 1;
      allProviders.add(nameOf(p - 1));
    }
    if (hostSeen[h] === 0) {
      hostSeen[h] = 1;
      allHosts.add(hostNames[h]);
    }
    if (providerOk[p] === 0 || hostOk[h] === 0) continue;
    const c = cwd[i] + 1;
    let inScope = cwdOk[c];
    if (inScope === -1) inScope = cwdOk[c] = matchesScope(nameOf(c - 1)) ? 1 : 0;
    if (inScope === 0) continue;
    const at = ms[i];
    if (Number.isNaN(at)) continue;
    const local = toLocal(at);
    const day = Math.floor(local / DAY_MS);
    if (day > today) continue;
    if (day < earliest) earliest = day;
    if (keptProvider[p] === 0) {
      keptProvider[p] = 1;
      rowProviders.add(nameOf(p - 1));
    }
    // Day 0 (1970-01-01) was a Thursday.
    rows[count] = i;
    days[count] = day;
    slots[count] = (((day + 4) % 7) + 7) % 7 * 24 + Math.floor((local - day * DAY_MS) / HOUR_MS);
    count++;
  }
  const startDay = range === 'all' ? earliest : today - (RANGE_DAYS.get(range) - 1);
  return { table, rows, days, slots, count, hostNames, today, startDay, allProviders, allHosts, rowProviders };
}

// Null when it does not parse. Day arithmetic stays in whole days, so DST never shifts it.
function localDay(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return dayNumber(date.getFullYear(), date.getMonth(), date.getDate());
}

// At a segment boundary ('/a/b' is not under '/a/bc'). Empty cwds never match; with no scope every cwd is in.
export function inScope(cwd, scope) {
  return scopeMatcher(scope)(cwd);
}

export function dayKey(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function hostOf(record) {
  return record.host || 'local';
}

function scopeMatcher(scope) {
  if (!scope) return () => true;
  const fold = Boolean(scope.caseInsensitive);
  const roots = (scope.roots ?? []).map((root) => normalizePath(root, fold));
  return (cwd) => {
    if (!cwd) return false;
    const path = normalizePath(cwd, fold);
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
  };
}

function normalizePath(path, fold) {
  const slashed = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return fold ? slashed.toLowerCase() : slashed;
}

function dayNumber(year, monthIndex, date) {
  return Date.UTC(year, monthIndex, date) / DAY_MS;
}
