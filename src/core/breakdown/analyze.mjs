// Reconciles priced digest rows with Usage per (session, local day), so the totals match. Pure: no Node built-ins.
// No digest spend is "not analysed"; more scales the rows down (resumed sessions repeat history); less is "unmatched".
import { costOfTokens, resolveModel } from '../catalog.mjs';
import { dayKey, inScope, selectRecords } from '../filters.mjs';
import { localClock } from '../time.mjs';
import { tableCosts } from '../pricing.mjs';
import { newestAsOf } from '../report.mjs';
import { asTable } from '../table.mjs';
import { ROW_WIDTH as W, packDigest } from './digest-rows.mjs';
import { BUCKETS, SLOT_MS } from './fold.mjs';

const DAY_MS = 86_400_000;
const LEVEL_MAX = 25;
const FINDINGS_MAX = 10;
const EVIDENCE_MAX = 5;
const VIEW_MAX_CHARS = 900_000;
const DAILY_KEPT = 90;
const REASONS = ['ssh', 'zstd', 'too-large', 'parse', 'unmatched', 'unpriced'];
const FILE_REASON = { zstd: 'zstd', 'too-large': 'too-large', error: 'parse' };
const GROUPS = {
  command: '(commands)',
  agent: '(subagents)',
  tool: '(other tools)',
  web: '(other tools)',
  mcp: '(other tools)',
  messages: '(conversation)',
  injected: '(conversation)',
  summary: '(conversation)',
};
const B = Object.fromEntries(BUCKETS.map((name, i) => [name, i]));
const UNATTRIBUTED = ['unattributed', '(unattributed)', 'bucket'];
// A group (session, local day) is session * SESSION + day + DAY_OFFSET; every valid Date's day is within ±DAY_OFFSET.
const SESSION = 2 ** 28;
const DAY_OFFSET = 2 ** 27;
const ANALYSES_KEPT = 8;
// One shared default, so calls without a list hit the same cached analyses.
const NONE = Object.freeze([]);

// Analyses are cached by input object identity, so inputs are treated as immutable.
export function analyzeBreakdown({
  records = NONE,
  digests = NONE,
  files = NONE,
  catalog,
  range = '7d',
  now = new Date(),
  providers,
  hosts,
  scope,
  path = [],
  prices,
} = {}) {
  const input = { table: asTable(records), digests, files, catalog, range, now, providers, hosts, scope };
  const analysis = analysisFor(input);
  const view = {
    generatedAt: now.toISOString(),
    range,
    prices: prices ?? { version: catalog?.version ?? null, asOf: catalog ? newestAsOf(catalog) : null, overlay: false },
    totals: analysis.totals,
    buckets: analysis.buckets,
    ...level(analysis.root, path, analysis.share),
    findings: analysis.findings,
    health: analysis.health,
  };
  return capSize(view, analysis.root, path, analysis.share);
}

const analyses = new WeakMap(); // table -> digests -> files -> catalog -> Map(key -> analysis)

function analysisFor(input) {
  const zone = timeZone();
  const objects = [input.table, input.digests, input.files, input.catalog];
  if (objects.some((o) => o === null || typeof o !== 'object')) return analyze(input, zone);
  const date = new Date(input.now);
  const key = JSON.stringify([input.range, date.getFullYear(), date.getMonth(), date.getDate(), zone, input.providers ?? null, input.hosts ?? null, input.scope ?? null]);
  let map = analyses;
  for (let i = 0; i < objects.length - 1; i++) {
    let next = map.get(objects[i]);
    if (next === undefined) map.set(objects[i], (next = new WeakMap()));
    map = next;
  }
  let byKey = map.get(input.catalog);
  if (byKey === undefined) map.set(input.catalog, (byKey = new Map()));
  let analysis = byKey.get(key);
  if (analysis === undefined) {
    analysis = analyze(input, zone);
    byKey.set(key, analysis);
    if (byKey.size > ANALYSES_KEPT) byKey.delete(byKey.keys().next().value);
  }
  return analysis;
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

function analyze({ table: records, digests, files, catalog, range, now, providers, hosts, scope }, zone) {
  const { table, rows, days, count, hostNames, today, startDay } = selectRecords(records, { range, now, providers, hosts, scope });
  const inRange = (day) => day >= startDay && day <= today;
  const sessions = sessionIndex();
  const toLocal = localClock();
  const memo = { labels: new Map(), parts: new Map(), ids: new Map() };
  const { costs } = tableCosts(table, catalog);
  const nameOf = (id) => (id < 0 ? undefined : table.names[id]);

  const usage = new Map();
  const unpriced = new Map();
  let unpricedTurns = 0;
  let usageUsd = 0;
  const { provider, model, sessionId, host, input, output, cacheRead, cacheWrite } = table;
  const seen = new Map();
  for (let k = 0; k < count; k++) {
    const day = days[k];
    if (day === null || !inRange(day)) continue;
    const i = rows[k];
    const cost = costs[i];
    if (Number.isNaN(cost)) {
      unpricedTurns++;
      const name = String(nameOf(model[i]) ?? '');
      const entry = unpriced.get(name) ?? { model: name, turns: 0, tokens: 0 };
      entry.turns++;
      // A missing count is stored as NaN (tableFromRecords) and counts as 0.
      entry.tokens += zero(input[i]) + zero(output[i]) + zero(cacheRead[i]) + zero(cacheWrite[i]);
      unpriced.set(name, entry);
      continue;
    }
    usageUsd += cost;
    let known = seen.get(sessionId[i]);
    if (known === undefined || known[0] !== provider[i] || known[1] !== host[i]) {
      known = [provider[i], host[i], sessions.id(nameOf(provider[i]), hostNames[host[i] + 1], nameOf(sessionId[i]))];
      seen.set(sessionId[i], known);
    }
    const g = known[2] * SESSION + day + DAY_OFFSET;
    const u = usage.get(g);
    if (u === undefined) usage.set(g, { usd: cost, turns: 1 });
    else {
      u.usd += cost;
      u.turns++;
    }
  }

  const allowed = providers ? new Set(providers) : null;
  const allowedHosts = hosts ? new Set(hosts) : null;
  const packed = new Array(digests.length);
  const pDigest = [];
  const pRow = [];
  const pUsd = [];
  const pGroup = [];
  const digestUsd = new Map();
  for (let index = 0; index < digests.length; index++) {
    const raw = digests[index]?.digest;
    if (!raw || !(Array.isArray(raw.rows) || ArrayBuffer.isView(raw.rows))) continue;
    const d = (packed[index] = packDigest(raw));
    const host = d.host || 'local';
    if (allowed && !allowed.has(d.harness)) continue;
    if (allowedHosts && !allowedHosts.has(host)) continue;
    // Scope is per row, by the cwd each request ran in, as Usage scopes each turn.
    const cwds = cwdsOf(d);
    const kept = scope ? cwds.map((cwd) => inScope(cwd, scope)) : null;
    if (kept && !kept.includes(true)) continue;
    const session = sessions.id(d.harness, host, d.sessionId ?? digests[index].sessionId ?? '') * SESSION + DAY_OFFSET;
    const { usd: rowUsd, day: rowDay } = pricedRows(d, catalog, zone, toLocal);
    for (let r = 0; r < d.rowCount; r++) {
      const usd = rowUsd[r];
      if (!(usd > 0)) continue; // unpriced (its records are unpriced too) or free
      if (kept && !kept[d.rowCwd?.[r] ?? 0]) continue;
      const day = rowDay[r];
      if (!inRange(day)) continue;
      const g = session + day;
      pDigest.push(index);
      pRow.push(r);
      pUsd.push(usd);
      pGroup.push(g);
      digestUsd.set(g, (digestUsd.get(g) ?? 0) + usd);
    }
  }

  const fileReasons = new Map();
  for (const file of files) {
    const reason = FILE_REASON[file?.state];
    if (reason) fileReasons.set(sessionKey(file.provider, file.host || 'local', file.sessionId ?? ''), reason);
  }

  const notAnalysed = new Map(REASONS.map((reason) => [reason, { reason, usd: 0, turns: 0 }]));
  const scale = new Map();
  let dedupeUsd = 0;
  for (const g of new Set([...usage.keys(), ...digestUsd.keys()])) {
    const u = usage.get(g) ?? { usd: 0, turns: 0 };
    const dUsd = digestUsd.get(g) ?? 0;
    if (dUsd === 0) {
      const [provider, host, sessionId] = sessions.list[Math.floor(g / SESSION)];
      const reason = fileReasons.get(sessionKey(provider, host, sessionId)) ?? (host !== 'local' ? 'ssh' : 'unmatched');
      const bucket = notAnalysed.get(reason);
      bucket.usd += u.usd;
      bucket.turns += u.turns;
    } else if (dUsd > u.usd) {
      scale.set(g, u.usd / dUsd);
      dedupeUsd += dUsd - u.usd;
    } else {
      scale.set(g, 1);
      if (u.usd > dUsd) {
        const bucket = notAnalysed.get('unmatched');
        bucket.usd += u.usd - dUsd;
      }
    }
  }
  const unpricedEntry = notAnalysed.get('unpriced');
  unpricedEntry.usd = null;
  unpricedEntry.turns = unpricedTurns;

  const buckets = BUCKETS.map((key) => ({ key, usd: 0, estUsd: 0 }));
  const root = makeNode('', '', 'root');
  const findingAcc = new Map();
  const perTarget = new Array(digests.length);
  let analysedUsd = 0;
  let estUsd = 0;
  let explainUsd = 0;
  for (let p = 0; p < pUsd.length; p++) {
    const usd = pUsd[p] * (scale.get(pGroup[p]) ?? 0);
    if (usd === 0) continue;
    const index = pDigest[p];
    const d = packed[index];
    const rows = d.rows;
    const at = pRow[p] * W;
    const est = rows[at + 5] === 1;
    analysedUsd += usd;
    if (est) estUsd += usd;
    const bucket = buckets[rows[at + 3]];
    if (bucket) {
      bucket.usd += usd;
      if (est) bucket.estUsd += usd;
    }
    // The tree and findings group by the session's first cwd: Claude Code's cwd follows the agent's
    // shell, so per-request cwds would split a project into its subfolders.
    const target = d.targets?.[rows[at + 4]] ?? UNATTRIBUTED;
    let slots = perTarget[index];
    if (slots === undefined) perTarget[index] = slots = new Map();
    let slot = slots.get(target);
    if (slot === undefined) {
      slot = { chain: treePath(root, d.cwd || '(unknown)', target, memo), large: null, repeat: null, idle: null };
      slots.set(target, slot);
    }
    for (const node of slot.chain) {
      node.usd += usd;
      if (est) node.estUsd += usd;
    }
    if (d.explain) {
      explainUsd += usd;
      continue;
    }
    const day = (pGroup[p] % SESSION) - DAY_OFFSET;
    const bucketIndex = rows[at + 3];
    if (bucketIndex === B.tools) feed(slot.large ?? (slot.large = finding(findingAcc, 'large-results', d, digests[index], target, rows[at + 4], memo)), rows, at, usd, est, day);
    if (rows[at + 6] === 1 && target[2] === 'file' && d.harness === 'claude') feed(slot.repeat ?? (slot.repeat = finding(findingAcc, 'repeat-reads', d, digests[index], target, rows[at + 4], memo)), rows, at, usd, est, day);
    if (bucketIndex === B.rebuilds && target[0] === 'rebuild:idle') feed(slot.idle ?? (slot.idle = finding(findingAcc, 'cache-expired', d, digests[index], target, rows[at + 4], memo)), rows, at, usd, est, day);
  }

  const share = (usd) => (analysedUsd > 0 ? usd / analysedUsd : 0);
  const threshold = Math.max(1, 0.005 * analysedUsd);
  return {
    totals: {
      usageUsd,
      analysedUsd,
      notAnalysed: [...notAnalysed.values()].filter((r) => r.turns > 0 || (r.usd ?? 0) > 1e-9),
      unpricedModels: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
    },
    buckets: buckets
      .filter((b) => b.usd > 0)
      .map((b) => ({ key: b.key, usd: b.usd, share: share(b.usd), est: b.estUsd > b.usd / 2 })),
    root,
    share,
    findings: buildFindings(findingAcc, threshold),
    health: {
      splitShare: share(estUsd),
      unattributedShare: share(buckets[B.unattributed].usd),
      dedupeUsd,
      explainUsd,
    },
  };
}

const zero = (n) => (Number.isNaN(n) ? 0 : n);

// usd is 0 for a row whose model has no price; day is NaN when the slot is not a number.
const pricing = new WeakMap();

function pricedRows(d, catalog, zone, toLocal) {
  let priced = pricing.get(d);
  if (priced !== undefined && priced.catalog === catalog && priced.zone === zone) return priced;
  const n = d.rowCount;
  const rows = d.rows;
  const usd = new Float64Array(n);
  const day = new Float64Array(n);
  const entries = (d.models ?? []).map((model) => resolveModel(model, catalog));
  for (let r = 0, at = 0; r < n; r++, at += W) {
    const ms = rows[at] * SLOT_MS;
    day[r] = Number.isFinite(ms) ? Math.floor(toLocal(ms) / DAY_MS) : NaN;
    const entry = entries[rows[at + 1]];
    if (entry) {
      usd[r] = costOfTokens(entry, rows[at + 2], { input: rows[at + 7], cacheRead: rows[at + 8], cacheWrite5m: rows[at + 9], cacheWrite1h: rows[at + 10], output: rows[at + 11] });
    }
  }
  priced = { catalog, zone, usd, day };
  pricing.set(d, priced);
  return priced;
}

// Keys normalized as JSON would: undefined provider as null, 'local' for no host, '' for no sessionId.
function sessionIndex() {
  const index = new Map();
  const list = [];
  const level = (map, key) => {
    let next = map.get(key);
    if (next === undefined) map.set(key, (next = new Map()));
    return next;
  };
  return {
    list,
    id(provider, host, sessionId) {
      const p = provider === undefined ? null : provider;
      const h = host || 'local';
      const id = sessionId ?? '';
      const byId = level(level(index, p), h);
      let n = byId.get(id);
      if (n === undefined) {
        n = list.length;
        list.push([p, h, id]);
        byId.set(id, n);
      }
      return n;
    },
  };
}

function sessionKey(provider, host, sessionId) {
  return JSON.stringify([provider, host || 'local', sessionId ?? '']);
}

function makeNode(key, label, kind) {
  return { key, label, kind, usd: 0, estUsd: 0, children: new Map() };
}

function child(node, key, label, kind) {
  let next = node.children.get(key);
  if (!next) {
    next = makeNode(key, label, kind);
    node.children.set(key, next);
  }
  return next;
}

function treePath(root, project, [key, label, kind], memo) {
  const chain = [root, root.children.get(project) ?? child(root, project, labelOf(project, memo), 'project')];
  const projectNode = chain[1];
  if (kind === 'file') {
    let parts = memo.parts.get(key);
    if (parts === undefined) {
      parts = String(key).replace(/^file:/, '').split(/[\\/]+/).filter(Boolean);
      memo.parts.set(key, parts);
    }
    let node = projectNode;
    parts.forEach((part, i) => {
      node = child(node, part, part, i === parts.length - 1 ? 'file' : 'folder');
      chain.push(node);
    });
  } else if (GROUPS[kind]) {
    // Namespaced, so a top-level folder named like the group stays a separate node.
    const group = child(projectNode, `group:${GROUPS[kind]}`, GROUPS[kind], 'group');
    chain.push(group, child(group, key, label, kind));
  } else {
    chain.push(child(projectNode, key, label, kind));
  }
  return chain;
}

function level(root, path, share, max = LEVEL_MAX) {
  let node = root;
  const valid = [];
  for (const key of Array.isArray(path) ? path : []) {
    const next = node.children.get(key);
    if (!next) break;
    node = next;
    valid.push(key);
  }
  const sorted = [...node.children.values()].sort((a, b) => b.usd - a.usd || (a.key < b.key ? -1 : 1));
  const shown = sorted.slice(0, max);
  const rest = sorted.slice(max);
  return {
    path: valid,
    nodes: shown.map((n) => ({ key: n.key, label: n.label, kind: n.kind, usd: n.usd, share: share(n.usd), est: n.estUsd > n.usd / 2, children: n.children.size > 0 })),
    more: rest.length > 0 ? { count: rest.length, usd: rest.reduce((sum, n) => sum + n.usd, 0) } : null,
  };
}

// Findings are copied: the analysis they come from is cached and shared.
function capSize(view, root, path, share) {
  const steps = [
    () => Object.assign(view, level(root, path, share, 12)),
    () => Object.assign(view, level(root, path, share, 6)),
    () => (view.findings = view.findings.map((f) => (f.daily.length > DAILY_KEPT ? { ...f, daily: f.daily.slice(-DAILY_KEPT) } : f))),
    () => Object.assign(view, level(root, path, share, 3)),
  ];
  for (const step of steps) {
    if (JSON.stringify(view).length <= VIEW_MAX_CHARS) return view;
    step();
  }
  return view;
}

// A digest from before per-request cwds has only `cwd`.
function cwdsOf(d) {
  return d.cwds?.length ? d.cwds : [d.cwd ?? ''];
}

function labelOf(project, memo) {
  let label = memo.labels.get(project);
  if (label === undefined) memo.labels.set(project, (label = lastSegment(project)));
  return label;
}

function lastSegment(path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? String(path);
}

function finding(acc, findingKind, d, item, target, t, memo) {
  const [key, label] = target;
  const project = d.cwd || '(unknown)';
  const where = findingKind === 'cache-expired' ? { label: labelOf(project, memo), key: project } : { label, key };
  const id = findingId(findingKind, d.harness, project, where.key, memo);
  let f = acc.get(id);
  if (!f) {
    f = { id, kind: findingKind, harness: d.harness, usd: 0, estUsd: 0, where: { project, ...where }, tokens: 0, sessions: new Set(), daily: new Map(), evidence: new Map() };
    acc.set(id, f);
  }
  const file = item.path;
  f.sessions.add(file ?? d.sessionId);
  if (findingKind !== 'cache-expired' && file) {
    for (const big of d.big ?? []) {
      if (big[2] !== t) continue;
      const ek = `${file}:${big[0]}`;
      if (!f.evidence.has(ek)) f.evidence.set(ek, { file, offset: big[0], bytes: big[1], compressed: Boolean(item.compressed), tokens: big[3] });
    }
  }
  return f;
}

function feed(f, rows, at, usd, est, day) {
  f.usd += usd;
  if (est) f.estUsd += usd;
  f.tokens += rows[at + 7] + rows[at + 8] + rows[at + 9] + rows[at + 10] + rows[at + 11];
  f.daily.set(day, (f.daily.get(day) ?? 0) + usd);
}

function findingId(findingKind, harness, project, key, memo) {
  let byProject = memo.ids.get(harness);
  if (byProject === undefined) memo.ids.set(harness, (byProject = new Map()));
  let byKey = byProject.get(project);
  if (byKey === undefined) byProject.set(project, (byKey = new Map()));
  let hashed = byKey.get(key);
  if (hashed === undefined) byKey.set(key, (hashed = hash(JSON.stringify([harness, project, key]))));
  return `${findingKind}:${hashed}`;
}

function buildFindings(acc, threshold) {
  const byKind = new Map();
  for (const f of acc.values()) {
    if (f.usd < threshold) continue;
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  const out = [];
  for (const kind of ['large-results', 'repeat-reads', 'cache-expired']) {
    const list = (byKind.get(kind) ?? []).sort((a, b) => b.usd - a.usd || (a.id < b.id ? -1 : 1)).slice(0, FINDINGS_MAX);
    for (const f of list) {
      const days = [...f.daily].sort((a, b) => a[0] - b[0]);
      out.push({
        id: f.id,
        kind: f.kind,
        harness: f.harness,
        usd: f.usd,
        est: f.estUsd > f.usd / 2,
        where: f.where,
        facts: { tokens: f.tokens, sessions: f.sessions.size },
        lastSeen: days.length > 0 ? dayKey(days[days.length - 1][0]) : null,
        daily: days.map(([day, usd]) => [dayKey(day), usd]),
        evidence: [...f.evidence.values()]
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, EVIDENCE_MAX)
          .map(({ file, offset, bytes, compressed }) => ({ file, offset, bytes, compressed })),
      });
    }
  }
  return out;
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

