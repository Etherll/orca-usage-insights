// One deduped table from many sources. Rows with the same key count once: the earliest by ms, at the position of
// the key's first row in source order (a tie keeps the first). Keyless rows always count.
// update() is incremental and returns the same frozen table when nothing changed. A table whose object changed,
// that shrank, or whose replaced-row log started over is read again whole. Pure: no Node built-in or Orca imports.

import { COLUMNS, NAME_FIELDS, NameDict, RecordTable, TOKEN_FIELDS } from './table.mjs';

const ROW = 2 ** 26; // a row reference is sid * ROW + row

export function createRecordStore({ names = new NameDict() } = {}) {
  const byId = new Map();
  const bySid = []; // sid -> Source, undefined once removed
  const keys = new Set();
  const dups = new Map(); // key -> refs of its rows, for keys held by 2+ rows
  const outcome = new Map(); // dup key -> { first, winner, dropped } as applied to the sources
  const remaps = new WeakMap();
  let order = [];
  let output = null;

  return { names, update };

  function update(list) {
    const ids = new Set();
    for (const { id } of list) {
      if (ids.has(id)) throw new Error(`source listed twice: ${id}`);
      ids.add(id);
    }
    let changed = output === null || list.length !== order.length || list.some(({ id }, i) => order[i].id !== id);
    const affected = new Set();
    const pending = new Set(); // keys that just gained a second row: their rows are looked up below

    for (const [id, src] of byId) {
      if (ids.has(id)) continue;
      removeRows(src, affected, pending);
      byId.delete(id);
      bySid[src.sid] = undefined;
      changed = true;
    }
    let lastRank = -1;
    let reordered = false;
    for (const { id, table } of list) {
      const src = byId.get(id);
      if (!src) continue;
      if (src.rank < lastRank) reordered = true;
      lastRank = src.rank;
      if (src.table !== table || table.length < src.seen || table.epoch !== src.epoch) {
        removeRows(src, affected, pending);
        src.seen = 0;
        src.version = -1;
        src.table = table;
        src.epoch = table.epoch;
        src.cursor = 0;
        src.dirty = true;
      }
    }

    const next = list.map(({ id, table }, rank) => {
      let src = byId.get(id);
      if (!src) {
        src = { sid: bySid.length, id, table, seen: 0, version: -1, epoch: table.epoch, cursor: 0, rank, dropped: new Set(), subst: new Map(), at: -1, rows: 0, dirty: true };
        bySid.push(src);
        byId.set(id, src);
      }
      src.rank = rank;
      if (table.version !== src.version) {
        changed = true;
        src.dirty = true;
        // A replaced row keeps its key but may move in time, which can change its key's winner.
        for (let c = src.cursor; c < table.replaced.length; c++) {
          const r = table.replaced[c];
          if (r < src.seen && dups.has(table.keys[r])) affected.add(table.keys[r]);
        }
        addRows(src, src.seen, table.length, affected, pending);
        src.seen = table.length;
        src.version = table.version;
        src.cursor = table.replaced.length;
      }
      return src;
    });
    order = next;
    if (reordered) for (const key of dups.keys()) affected.add(key);

    if (pending.size > 0) {
      const found = new Map();
      for (const src of next) {
        const { keys: rowKeys, length } = src.table;
        for (let r = 0; r < length; r++) {
          const key = rowKeys[r];
          if (key === undefined || !pending.has(key)) continue;
          const refs = found.get(key);
          if (refs) refs.push(src.sid * ROW + r);
          else found.set(key, [src.sid * ROW + r]);
        }
      }
      for (const key of pending) {
        const refs = found.get(key) ?? [];
        if (refs.length >= 2) dups.set(key, refs);
        else dups.delete(key);
        if (refs.length === 0) keys.delete(key);
        affected.add(key);
      }
    }

    // Outcomes: undo every affected key's old one first, so no new one is undone by an old one.
    for (const key of affected) unapply(key);
    for (const key of affected) apply(key);

    if (changed || affected.size > 0) output = assemble(next);
    return output;
  }

  // Counts a source's new rows' keys: a key's second row makes it pending, a later one affected.
  function addRows(src, from, to, affected, pending) {
    const rowKeys = src.table.keys;
    for (let r = from; r < to; r++) {
      const key = rowKeys[r];
      if (key === undefined) continue;
      const refs = dups.get(key);
      if (refs) {
        refs.push(src.sid * ROW + r);
        affected.add(key);
      } else if (keys.has(key)) {
        pending.add(key);
      } else {
        keys.add(key);
      }
    }
  }

  function removeRows(src, affected, pending) {
    const rowKeys = src.table.keys;
    for (let r = 0; r < src.seen; r++) {
      const key = rowKeys[r];
      if (key === undefined) continue;
      const refs = dups.get(key);
      if (refs) {
        const at = refs.indexOf(src.sid * ROW + r);
        if (at >= 0) refs.splice(at, 1);
        if (refs.length < 2) {
          dups.delete(key);
          pending.add(key);
        }
        affected.add(key);
      } else if (pending.has(key)) {
      } else {
        keys.delete(key);
      }
    }
  }

  function unapply(key) {
    const prev = outcome.get(key);
    if (!prev) return;
    outcome.delete(key);
    for (const ref of prev.dropped) touch(ref)?.dropped.delete(ref % ROW);
    if (prev.winner !== prev.first) touch(prev.first)?.subst.delete(prev.first % ROW);
  }

  function apply(key) {
    const refs = dups.get(key);
    if (!refs) return;
    const position = (ref) => bySid[Math.floor(ref / ROW)].rank * ROW + (ref % ROW);
    refs.sort((a, b) => position(a) - position(b));
    const first = refs[0];
    let winner = first;
    let winnerMs = msOf(first);
    for (let i = 1; i < refs.length; i++) {
      const ms = msOf(refs[i]);
      if (ms < winnerMs) {
        winner = refs[i];
        winnerMs = ms;
      }
    }
    const dropped = refs.slice(1);
    for (const ref of dropped) touch(ref).dropped.add(ref % ROW);
    if (winner !== first) touch(first).subst.set(first % ROW, winner);
    outcome.set(key, { first, winner, dropped });
  }

  function touch(ref) {
    const src = bySid[Math.floor(ref / ROW)];
    if (src) src.dirty = true;
    return src;
  }

  function msOf(ref) {
    return bySid[Math.floor(ref / ROW)].table.ms[ref % ROW];
  }

  // Clean sources sit in the previous output in the same relative order, so each run of them is copied in one piece.
  function assemble(sources) {
    const prev = output;
    let total = 0;
    const wide = new Set();
    for (const src of sources) {
      total += src.table.length - src.dropped.size;
      for (const field of TOKEN_FIELDS) if (src.table[field] instanceof Float64Array) wide.add(field);
    }
    const out = new RecordTable(0, names);
    out.length = total;
    out.ms = new Float64Array(total);
    for (const field of TOKEN_FIELDS) out[field] = wide.has(field) ? new Float64Array(total) : new Uint32Array(total);
    for (const field of NAME_FIELDS) out[field] = new Int32Array(total);
    out.keys = new Array(total).fill(undefined);
    let at = 0;
    for (let i = 0; i < sources.length; ) {
      const src = sources[i];
      if (prev !== null && !src.dirty && src.at >= 0) {
        let j = i + 1;
        let end = src.at + src.rows;
        while (j < sources.length && !sources[j].dirty && sources[j].at === end) end += sources[j++].rows;
        const from = src.at;
        for (const field of COLUMNS) out[field].set(prev[field].subarray(from, end), at);
        const keysOut = out.keys;
        const keysIn = prev.keys;
        for (let k = from; k < end; k++) keysOut[at + k - from] = keysIn[k];
        for (let k = i; k < j; k++) {
          sources[k].at = at + sources[k].at - from;
        }
        at += end - from;
        i = j;
        continue;
      }
      src.at = at;
      src.rows = copySource(src, out, at);
      src.dirty = false;
      at += src.rows;
      i++;
    }
    out.frozen = true;
    return out;
  }

  function copySource(src, out, at) {
    const t = src.table;
    const len = t.length;
    if (src.dropped.size === 0 && src.subst.size === 0) {
      const whole = t.ms.length === len;
      const copy = (field) => out[field].set(whole ? t[field] : t[field].subarray(0, len), at);
      if (t.dict === names) {
        for (const field of COLUMNS) copy(field);
      } else {
        copy('ms');
        for (const field of TOKEN_FIELDS) copy(field);
        const map = remapFor(t.dict);
        for (const field of NAME_FIELDS) {
          const from = t[field];
          const to = out[field];
          for (let r = 0; r < len; r++) to[at + r] = from[r] < 0 ? -1 : map[from[r]];
        }
      }
      const keysOut = out.keys;
      const keysIn = t.keys;
      for (let r = 0; r < len; r++) keysOut[at + r] = keysIn[r];
      return len;
    }
    let i = at;
    for (let r = 0; r < len; r++) {
      if (src.dropped.has(r)) continue;
      const ref = src.subst.get(r);
      if (ref === undefined) copyRow(t, r, out, i);
      else copyRow(bySid[Math.floor(ref / ROW)].table, ref % ROW, out, i);
      out.keys[i] = t.keys[r];
      i++;
    }
    return i - at;
  }

  function copyRow(t, r, out, i) {
    out.ms[i] = t.ms[r];
    out.input[i] = t.input[r];
    out.output[i] = t.output[r];
    out.cacheRead[i] = t.cacheRead[r];
    out.cacheWrite[i] = t.cacheWrite[r];
    out.cacheWrite1h[i] = t.cacheWrite1h[r];
    const map = t.dict === names ? null : remapFor(t.dict);
    const id = (value) => (value < 0 ? -1 : map ? map[value] : value);
    out.provider[i] = id(t.provider[r]);
    out.model[i] = id(t.model[r]);
    out.project[i] = id(t.project[r]);
    out.sessionId[i] = id(t.sessionId[r]);
    out.cwd[i] = id(t.cwd[r]);
    out.host[i] = id(t.host[r]);
  }

  function remapFor(dict) {
    let map = remaps.get(dict);
    if (!map || map.length < dict.list.length) {
      const next = new Int32Array(dict.list.length);
      const known = map?.length ?? 0;
      if (map) next.set(map);
      for (let id = known; id < dict.list.length; id++) next[id] = names.id(dict.list[id]);
      remaps.set(dict, (map = next));
    }
    return map;
  }
}

export function mergeTables(tables) {
  return createRecordStore().update(tables.map((table, id) => ({ id, table })));
}
