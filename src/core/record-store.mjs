// Use case: one deduped table from many sources (a transcript file each, local or on an SSH host).
// A Claude message copied into a resumed session is in two files, so rows with the same key count
// once: the earliest by ms, at the position of the key's first row in source order (a tie keeps
// the first). Rows without a key always count. Pure: no Node built-in or Orca imports.
//
// update(sources) takes the sources in order, [{ id, table }], and returns the merged table, frozen.
// It is incremental: it remembers each source's table, version and length, so a source that only
// gained rows costs those rows, a replaced row costs a look at its key, and unchanged sources cost
// a bulk copy. Nothing changed: the same table object comes back. A table whose object changed,
// that got shorter, or whose replaced-row log started over (see table.mjs) is read again whole.
// The merged table uses `names`: pass the dictionary the sources' tables share and their columns
// are copied in bulk; a source on another dictionary has its ids translated.
//
// Memory: a set of every key, plus row references for keys held by 2+ rows (~16 MB at 418k rows).

import { COLUMNS, NAME_FIELDS, NameDict, RecordTable, TOKEN_FIELDS } from './table.mjs';

const ROW = 2 ** 26; // a row reference is sid * ROW + row

export function createRecordStore({ names = new NameDict() } = {}) {
  const byId = new Map(); // source id -> Source
  const bySid = []; // sid -> Source, undefined once removed
  const keys = new Set(); // every key some row holds
  const dups = new Map(); // key -> refs of its rows, for keys held by 2+ rows
  const outcome = new Map(); // dup key -> { first, winner, dropped } as applied to the sources
  const remaps = new WeakMap(); // other NameDict -> Int32Array of ids in `names`
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
    const affected = new Set(); // dup keys whose outcome may differ
    const pending = new Set(); // keys that just gained a second row: their rows are looked up below

    // Pass 1: rows that left. Sources no longer listed, and sources read again from the start.
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

    // Pass 2: rows that arrived or changed.
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

    // Keys that just gained a second row: one pass over every source finds all their rows.
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

  // Forgets every row of a source it has seen (the source left, or is read again from the start).
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
          // The row left over is found again by the lookup pass.
          pending.add(key);
        }
        affected.add(key);
      } else if (pending.has(key)) {
        // Its rows are counted by the lookup pass, which sees only rows still listed.
      } else {
        keys.delete(key);
      }
    }
  }

  // Takes back what apply did for a key: its dropped rows and its substitute.
  function unapply(key) {
    const prev = outcome.get(key);
    if (!prev) return;
    outcome.delete(key);
    for (const ref of prev.dropped) touch(ref)?.dropped.delete(ref % ROW);
    if (prev.winner !== prev.first) touch(prev.first)?.subst.delete(prev.first % ROW);
  }

  // The first row in source order holds the key's place. Its value is the rule merging in order
  // gives: the first row, replaced by each later row that is strictly earlier.
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

  // The source a row reference points into, marked as having rows that may differ in the output.
  function touch(ref) {
    const src = bySid[Math.floor(ref / ROW)];
    if (src) src.dirty = true;
    return src;
  }

  function msOf(ref) {
    return bySid[Math.floor(ref / ROW)].table.ms[ref % ROW];
  }

  // The merged table. Sources whose rows are as they were sit in the previous output in the same
  // relative order, so each run of them is copied from it in one piece per column; the others are
  // copied from their own tables.
  function assemble(sources) {
    const prev = output;
    let total = 0;
    const wide = new Set(); // token columns some source holds as Float64Array
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
        // The longest run of clean sources that were next to each other last time.
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

  // One source's output rows, from its own table. Returns how many.
  function copySource(src, out, at) {
    const t = src.table;
    const len = t.length;
    if (src.dropped.size === 0 && src.subst.size === 0) {
      // A table whose columns are exactly its rows (read back, or from a thread) is copied
      // without a view per column.
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

  // Ids of another dictionary in `names`, extended as that dictionary grows.
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

// The tables merged once, in order: for callers that merge a fixed set of tables.
export function mergeTables(tables) {
  return createRecordStore().update(tables.map((table, id) => ({ id, table })));
}
