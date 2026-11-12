// Fold: turns one transcript's events into token rows that say what each request paid for.
// Tokens only, no prices: analyze prices the rows later, so a price change never re-reads a file.
// Every request's rows add up exactly to its usage tokens (integer split by largest remainder).
// State and digest are plain JSON and hold no transcript text, only sizes, offsets and targets.
import { bandOf } from '../bands.mjs';

export const BUCKETS = Object.freeze(['startup', 'tools', 'messages', 'injected', 'replies', 'compaction', 'rebuilds', 'output', 'unattributed']);
const B = Object.fromEntries(BUCKETS.map((name, i) => [name, i]));

const IMAGE_CHARS = 6000;
export const SLOT_MS = 15 * 60_000;
const RESIDENT_MAX = 300;
const COMPOSITION_MAX = 30;
const BIG_MAX = 10;
const READS_MAX = 2000;
// Arrivals waiting for the next request. Past this many, arrivals of the same bucket and target
// merge, then the smallest merge into their bucket's (other), so a long run of tool results with
// no request between them keeps the state small. Totals per target are unchanged by the first step.
const PENDING_MAX = 2000;
const TTL_5M = 5 * 60_000;
const TTL_1H = 60 * 60_000;

// Targets the fold makes itself, for tokens that belong to no file, command or message.
const OWN = {
  startup: { key: 'startup', label: '(startup)', kind: 'bucket' },
  replies: { key: 'replies', label: '(replies)', kind: 'bucket' },
  output: { key: 'output', label: '(output)', kind: 'bucket' },
  unattributed: { key: 'unattributed', label: '(unattributed)', kind: 'bucket' },
  other: { key: 'other', label: '(other)', kind: 'bucket' },
  idle: { key: 'rebuild:idle', label: 'cache expired (idle)', kind: 'bucket' },
  model: { key: 'rebuild:model', label: 'model switch', kind: 'bucket' },
  compaction: { key: 'rebuild:compaction', label: 'after compaction', kind: 'bucket' },
  rebuildOther: { key: 'rebuild:other', label: 'other rewrites', kind: 'bucket' },
};

// info: { harness, host }. state: a previous state() to continue from, or null. With `adopt`, the
// fold takes over `state` and state() returns the live state, with no copies either way: for a
// caller that drops its own reference and reads state() only once it has stopped adding.
export function createFold(info = {}, state = null, { adopt = false } = {}) {
  const s = state ? (adopt ? state : structuredClone(state)) : fresh(info);
  return { add, state: () => (adopt ? s : structuredClone(s)), digest };

  function add(event) {
    switch (event?.t) {
      case 'meta':
        if (event.cwd && !s.cwd) s.cwd = event.cwd;
        if (event.sessionId && !s.sessionId) s.sessionId = event.sessionId;
        break;
      case 'call':
        onCall(event);
        break;
      case 'arrival':
        onArrival(event);
        break;
      case 'reset':
        s.reset = true;
        break;
      case 'request':
        onRequest(event);
        break;
      default:
        break; // reply and unknown events carry nothing the split needs
    }
  }

  // Repeated reads: a read of a path already read, with no edit or write since. Claude only.
  function onCall({ id, target, op }) {
    if (s.harness !== 'claude' || !target?.key) return;
    if (op === 'read') {
      if (s.reads.includes(target.key) && id) s.repeats.push(id);
      else s.reads.push(target.key);
      trim(s.reads, READS_MAX);
      trim(s.repeats, READS_MAX);
    } else if (op === 'edit' || op === 'write') {
      s.reads = s.reads.filter((key) => key !== target.key);
    }
  }

  function onArrival(event) {
    // A session started from an Explain prompt is marked so analyze can keep it out of findings.
    if (event.bucket === 'messages' && !s.sawMessage) {
      s.sawMessage = true;
      if (event.explain === true) s.explain = true;
    }
    const chars = Math.max(0, Number(event.chars) || 0) + Math.max(0, Number(event.images) || 0) * IMAGE_CHARS;
    s.pending.push({
      b: B[event.bucket] ?? B.injected,
      t: targetIdx(event.target ?? OWN.unattributed),
      w: chars,
      offset: Number(event.offset) || 0,
      bytes: Number(event.bytes) || 0,
      ts: event.ts ?? null,
      rep: event.callId && s.repeats.includes(event.callId) ? 1 : 0,
    });
    if (s.pending.length > PENDING_MAX) capPending();
  }

  // Merges pending arrivals of the same bucket, target and repeat flag (the largest keeps its
  // offset, bytes and time for evidence); if that is not enough, the smallest half go to (other).
  function capPending() {
    const merge = (list, keyOf) => {
      const out = new Map();
      for (const a of list) {
        const key = keyOf(a);
        const cur = out.get(key);
        if (!cur) out.set(key, { ...a });
        else {
          if (a.w > cur.w) Object.assign(cur, { offset: a.offset, bytes: a.bytes, ts: a.ts });
          cur.w += a.w;
        }
      }
      return [...out.values()];
    };
    let list = merge(s.pending, (a) => `${a.b}|${a.t}|${a.rep}`);
    if (list.length > PENDING_MAX / 2) {
      list.sort((x, y) => y.w - x.w);
      const other = targetIdx(OWN.other);
      const keep = list.slice(0, PENDING_MAX / 4);
      const rest = list.slice(PENDING_MAX / 4).map((a) => ({ ...a, t: other, rep: 0 }));
      list = [...keep, ...merge(rest, (a) => `${a.b}`)];
    }
    s.pending = list;
  }

  function onRequest({ ts, model, usage }) {
    const u = cleanUsage(usage);
    const ctx = u.input + u.cacheRead + u.cacheWrite;
    const at = Date.parse(ts);
    const time = Number.isFinite(at) ? at : null;
    // 15-minute UTC slots: every real time-zone offset is a multiple of 15 minutes, so a slot
    // always falls on one local day.
    const slot = time === null ? 0 : Math.floor(time / SLOT_MS);
    const req = { slot, model: modelIdx(model), band: bandOf(ctx), cells: new Map() };
    const prev = s.prev;

    let fresh = []; // new context entries this turn: { b, t, n, e, rep }
    let reset = false;
    if (!prev) {
      if (ctx > 0) fresh.push({ b: B.startup, t: targetIdx(OWN.startup), n: ctx, e: 0, rep: 0 });
      s.pending = [];
    } else {
      const g = ctx - prev.ctx;
      const implicit = g < -Math.max(2000, 0.05 * prev.ctx);
      if (s.reset) {
        reset = true;
        s.resident = {};
        fresh = splitArrivals(ctx);
      } else if (implicit) {
        reset = true;
        scaleResident(ctx);
        s.pending = [];
      } else {
        const replies = Math.min(prev.output, Math.max(0, g));
        if (replies > 0) fresh.push({ b: B.replies, t: targetIdx(OWN.replies), n: replies, e: 0, rep: 0 });
        fresh.push(...splitArrivals(Math.max(0, g - replies)));
      }
    }
    s.reset = false;
    const added = fresh.reduce((sum, entry) => sum + entry.n, 0);

    // Writes beyond the new context rewrote context the cache had dropped.
    const rebuild = prev ? Math.max(0, u.cacheWrite - added) : 0;
    const rough = u.cacheWrite > 0 ? Math.round((rebuild * u.cacheWrite1h) / u.cacheWrite) : 0;
    const rb1h = Math.min(u.cw1h, rebuild, Math.max(rebuild - u.cw5m, rough));
    const rb = { cw5m: rebuild - rb1h, cw1h: rb1h };
    if (rebuild > 0) {
      const why = !prev ? null : time !== null && prev.time !== null && time - prev.time > (prev.cw1h > 0 ? TTL_1H : TTL_5M) ? 'idle' : req.model !== prev.model ? 'model' : reset ? 'compaction' : 'rebuildOther';
      put(req, B.rebuilds, targetIdx(OWN[why]), 0, 0, { cw5m: rb.cw5m, cw1h: rb.cw1h });
    }

    const newPart = { input: u.input, cw5m: u.cw5m - rb.cw5m, cw1h: u.cw1h - rb.cw1h };
    const residentList = Object.values(s.resident).filter((entry) => entry.n > 0);
    const freshList = fresh.filter((entry) => entry.n > 0);
    let toFresh = newPart;
    let toResident = { cacheRead: u.cacheRead };
    if (freshList.length === 0 && residentList.length > 0) {
      toResident = { ...toResident, ...newPart };
      toFresh = null;
    } else if (residentList.length === 0 && freshList.length > 0) {
      toFresh = { ...newPart, cacheRead: u.cacheRead };
      toResident = null;
    }
    if (freshList.length === 0 && residentList.length === 0) {
      put(req, B.unattributed, targetIdx(OWN.unattributed), 0, 0, { ...newPart, cacheRead: u.cacheRead });
    } else {
      if (toFresh) spread(req, freshList, toFresh);
      if (toResident) spread(req, residentList, toResident);
    }
    if (u.output > 0) put(req, B.output, targetIdx(OWN.output), 0, 0, { output: u.output });

    for (const entry of freshList) {
      const key = `${entry.b}:${entry.t}`;
      const cur = s.resident[key] ?? (s.resident[key] = { b: entry.b, t: entry.t, n: 0, e: 0, rep: 0 });
      cur.n += entry.n;
      cur.e = cur.e || entry.e;
    }
    capResident();
    commit(req);

    s.requests++;
    s.totalTokens += u.input + u.cacheRead + u.cacheWrite + u.output;
    if (ts && (!s.firstTs || ts < s.firstTs)) s.firstTs = ts;
    if (ts && (!s.lastTs || ts > s.lastTs)) s.lastTs = ts;
    s.prev = { ctx, output: u.output, time, model: req.model, cw1h: u.cacheWrite1h };
  }

  // Splits `tokens` over the pending arrivals by characters and clears them. One arrival takes
  // all of it (measured); several share it by weight (estimated).
  function splitArrivals(tokens) {
    const arrivals = s.pending;
    s.pending = [];
    if (tokens <= 0) return [];
    if (arrivals.length === 0) return [{ b: B.unattributed, t: targetIdx(OWN.unattributed), n: tokens, e: 0, rep: 0 }];
    const est = arrivals.length > 1 ? 1 : 0;
    const shares = apportion(tokens, arrivals.map((a) => (est ? a.w : 1)));
    const out = [];
    arrivals.forEach((a, i) => {
      if (shares[i] <= 0) return;
      out.push({ b: a.b, t: a.t, n: shares[i], e: est, rep: a.rep });
      noteBig(a, shares[i]);
    });
    return out;
  }

  function noteBig(arrival, tokens) {
    s.big.push([arrival.offset, arrival.bytes, arrival.t, tokens, arrival.ts]);
    s.big.sort((x, y) => y[3] - x[3]);
    if (s.big.length > BIG_MAX) s.big.length = BIG_MAX;
  }

  // Scales the resident entries down to `ctx` tokens in total (an unexplained shrink).
  function scaleResident(ctx) {
    const list = Object.values(s.resident);
    const shares = apportion(ctx, list.map((entry) => entry.n));
    list.forEach((entry, i) => {
      entry.n = shares[i];
      entry.e = 1;
    });
  }

  // Each token field goes to the entries by their share of tokens.
  function spread(req, entries, fields) {
    const weights = entries.map((entry) => entry.n);
    for (const [field, total] of Object.entries(fields)) {
      if (!total) continue;
      const shares = apportion(total, weights);
      entries.forEach((entry, i) => {
        if (shares[i]) put(req, entry.b, entry.t, entry.e, entry.rep, { [field]: shares[i] });
      });
    }
  }

  function put(req, b, t, e, rep, fields) {
    const key = `${b}|${t}|${e}|${rep}`;
    const cell = req.cells.get(key) ?? { b, t, e, rep, v: [0, 0, 0, 0, 0] };
    cell.v[0] += fields.input ?? 0;
    cell.v[1] += fields.cacheRead ?? 0;
    cell.v[2] += fields.cw5m ?? 0;
    cell.v[3] += fields.cw1h ?? 0;
    cell.v[4] += fields.output ?? 0;
    req.cells.set(key, cell);
  }

  // Adds a request's cells to the rows. Per bucket, the 30 largest targets are kept and the rest
  // merge into (other), so one request never adds an unbounded number of rows.
  function commit(req) {
    const byBucket = new Map();
    for (const cell of req.cells.values()) {
      if (!byBucket.has(cell.b)) byBucket.set(cell.b, []);
      byBucket.get(cell.b).push(cell);
    }
    const other = targetIdx(OWN.other);
    for (const cells of byBucket.values()) {
      const totals = new Map();
      for (const cell of cells) totals.set(cell.t, (totals.get(cell.t) ?? 0) + sum(cell.v));
      const keep = new Set([...totals].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, COMPOSITION_MAX).map(([t]) => t));
      for (const cell of cells) {
        const t = keep.has(cell.t) ? cell.t : other;
        const key = [req.slot, req.model, req.band, cell.b, t, cell.e, cell.rep].join('|');
        const row = s.rows[key] ?? (s.rows[key] = [0, 0, 0, 0, 0]);
        for (let i = 0; i < 5; i++) row[i] += cell.v[i];
        if (cell.e) s.splitTokens += sum(cell.v);
      }
    }
  }

  // Keeps at most RESIDENT_MAX entries; the smallest merge into their bucket's (other) entry.
  function capResident() {
    const other = targetIdx(OWN.other);
    const list = Object.entries(s.resident).filter(([, entry]) => entry.t !== other);
    if (list.length <= RESIDENT_MAX) return;
    list.sort((x, y) => y[1].n - x[1].n);
    for (const [key, entry] of list.slice(RESIDENT_MAX)) {
      delete s.resident[key];
      const okey = `${entry.b}:${other}`;
      const into = s.resident[okey] ?? (s.resident[okey] = { b: entry.b, t: other, n: 0, e: 0, rep: 0 });
      into.n += entry.n;
      into.e = into.e || entry.e;
    }
  }

  function targetIdx(target) {
    const key = String(target.key);
    let i = s.targetIndex[key];
    if (i === undefined) {
      i = s.targets.length;
      s.targets.push([key, String(target.label ?? key), String(target.kind ?? 'tool')]);
      s.targetIndex[key] = i;
    }
    return i;
  }

  function modelIdx(model) {
    const name = String(model ?? '');
    let i = s.models.indexOf(name);
    if (i < 0) {
      i = s.models.length;
      s.models.push(name);
    }
    return i;
  }

  // The digest lists only the targets its rows and big arrivals use, renumbered in their original
  // order: the state keeps every target it has seen (a session that reads thousands of files keeps
  // a few hundred in rows), and the digest is what stays in memory and in the shard.
  function digest() {
    const rows = Object.entries(s.rows)
      .map(([key, v]) => [...key.split('|').map(Number), ...v])
      .sort((x, y) => x[0] - y[0] || x[3] - y[3] || x[4] - y[4] || x[1] - y[1] || x[2] - y[2] || x[5] - y[5] || x[6] - y[6]);
    const used = new Uint8Array(s.targets.length);
    for (const row of rows) used[row[4]] = 1;
    for (const b of s.big) used[b[2]] = 1;
    const renumber = new Int32Array(s.targets.length);
    const targets = [];
    for (let i = 0; i < s.targets.length; i++) {
      if (!used[i]) continue;
      renumber[i] = targets.length;
      targets.push([...s.targets[i]]);
    }
    for (const row of rows) row[4] = renumber[row[4]];
    return {
      v: 1,
      harness: s.harness,
      host: s.host,
      sessionId: s.sessionId,
      cwd: s.cwd,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      requests: s.requests,
      splitTokens: s.splitTokens,
      totalTokens: s.totalTokens,
      explain: s.explain === true,
      models: [...s.models],
      targets,
      rows,
      big: s.big.map(([offset, bytes, t, tokens, ts]) => [offset, bytes, renumber[t], tokens, ts]),
    };
  }
}

function fresh({ harness = 'claude', host = 'local' } = {}) {
  return {
    v: 1,
    harness,
    host,
    sessionId: null,
    cwd: null,
    firstTs: null,
    lastTs: null,
    requests: 0,
    splitTokens: 0,
    totalTokens: 0,
    models: [],
    targets: [],
    targetIndex: {},
    rows: {},
    big: [],
    resident: {},
    pending: [],
    reads: [],
    repeats: [],
    reset: false,
    prev: null,
    sawMessage: false,
    explain: false,
  };
}

function cleanUsage(usage = {}) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  const cacheWrite = n(usage.cacheWrite);
  const cacheWrite1h = Math.min(cacheWrite, n(usage.cacheWrite1h));
  return { input: n(usage.input), output: n(usage.output), cacheRead: n(usage.cacheRead), cacheWrite, cacheWrite1h, cw5m: cacheWrite - cacheWrite1h, cw1h: cacheWrite1h };
}

// Splits an integer total over weights so the parts are integers that add up to the total:
// floors first, then the remainder by largest fraction (earlier index on ties).
export function apportion(total, weights) {
  const out = weights.map(() => 0);
  if (total <= 0 || weights.length === 0) return out;
  const sumW = weights.reduce((a, w) => a + Math.max(0, w), 0);
  const ws = sumW > 0 ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1);
  const W = sumW > 0 ? sumW : ws.length;
  const fracs = [];
  let given = 0;
  ws.forEach((w, i) => {
    const exact = (total * w) / W;
    out[i] = Math.floor(exact);
    given += out[i];
    fracs.push([exact - out[i], i]);
  });
  fracs.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (let k = 0; given < total; k++, given++) out[fracs[k % fracs.length][1]]++;
  return out;
}

function sum(v) {
  return v[0] + v[1] + v[2] + v[3] + v[4];
}

function trim(list, max) {
  if (list.length > max) list.splice(0, list.length - max);
}
