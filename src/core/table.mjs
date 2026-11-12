// Usage records as columns. One RecordTable holds rows of the same fields a usage record has
// (key, provider, ts, model, project, sessionId, input, output, cacheRead, cacheWrite,
// cacheWrite1h, cwd, host), stored as typed arrays plus a dictionary of distinct strings, so 400k
// records cost a few dozen MB instead of an object each. Pure: no Node built-in or Orca imports.
//
// - ms: the timestamp as epoch ms (Float64Array; NaN when it did not parse).
// - input .. cacheWrite1h: token counts. Uint32Array while every count is a whole number that fits,
//   else Float64Array (a column switches the first time a count doesn't fit).
// - provider .. host: Int32Array ids in the table's NameDict; -1 when the record has no such string.
// - keys: the dedupe key per row, or undefined.
//
// A table grows by push; replace rewrites a row in place and keeps its key. `version` counts both,
// and `replaced` lists the rows replaced since `epoch` began, so a reader can tell what changed
// since it last looked (see record-store.mjs). Cache and thread encoding is in table-codec.mjs.

import { timestampParser } from './time.mjs';

export const TOKEN_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']);
export const NAME_FIELDS = Object.freeze(['provider', 'model', 'project', 'sessionId', 'cwd', 'host']);
export const COLUMNS = Object.freeze(['ms', ...TOKEN_FIELDS, ...NAME_FIELDS]);
const U32_MAX = 0xffffffff;
// After this many replaced rows the log starts over under a new epoch; a reader that saw the old
// epoch rereads the table whole.
const REPLACED_LOG_MAX = 4096;

// Distinct strings and their ids. Ids never change and strings are never removed, so tables that
// share a dictionary share ids and can be copied without translating them.
export class NameDict {
  constructor(list = []) {
    this.list = list;
    this.index = null; // string -> id, built on first use
  }

  // The id of a string, adding it the first time; -1 for anything but a string.
  id(value) {
    if (typeof value !== 'string') return -1;
    let index = this.index;
    if (index === null) {
      index = this.index = new Map();
      for (let i = 0; i < this.list.length; i++) index.set(this.list[i], i);
    }
    let id = index.get(value);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(value);
      index.set(value, id);
    }
    return id;
  }
}

export class RecordTable {
  constructor(capacity = 0, dict = new NameDict()) {
    this.length = 0;
    this.dict = dict;
    this.ms = new Float64Array(capacity);
    this.input = new Uint32Array(capacity);
    this.output = new Uint32Array(capacity);
    this.cacheRead = new Uint32Array(capacity);
    this.cacheWrite = new Uint32Array(capacity);
    this.cacheWrite1h = new Uint32Array(capacity);
    this.provider = new Int32Array(capacity);
    this.model = new Int32Array(capacity);
    this.project = new Int32Array(capacity);
    this.sessionId = new Int32Array(capacity);
    this.cwd = new Int32Array(capacity);
    this.host = new Int32Array(capacity);
    this.keys = [];
    this.frozen = false; // true once no row will change (merge output, a conversion)
    this.version = 0;
    this.epoch = 0;
    this.replaced = [];
  }

  // The dictionary's strings: names[id] is the string an id stands for.
  get names() {
    return this.dict.list;
  }

  // Appends a row and returns its position. Strings are interned; anything else is stored as absent.
  push(key, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h) {
    const i = this.length;
    if (i === this.ms.length) this.grow(Math.max(16, i * 2));
    this.length = i + 1;
    this.keys.push(typeof key === 'string' ? key : undefined);
    this.write(i, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h);
    this.version++;
    return i;
  }

  // Replaces row i in place (its key stays).
  replace(i, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h) {
    this.write(i, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h);
    this.version++;
    if (this.replaced.length >= REPLACED_LOG_MAX) {
      this.replaced = [];
      this.epoch++;
    }
    this.replaced.push(i);
  }

  write(i, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h) {
    const dict = this.dict;
    this.ms[i] = ms;
    this.provider[i] = dict.id(provider);
    this.model[i] = dict.id(model);
    this.project[i] = dict.id(project);
    this.sessionId[i] = dict.id(sessionId);
    this.cwd[i] = dict.id(cwd);
    this.host[i] = dict.id(host);
    this.setCount('input', i, input);
    this.setCount('output', i, output);
    this.setCount('cacheRead', i, cacheRead);
    this.setCount('cacheWrite', i, cacheWrite);
    this.setCount('cacheWrite1h', i, cacheWrite1h);
  }

  setCount(field, i, value) {
    const column = this[field];
    if (column instanceof Uint32Array && !(value >= 0 && value <= U32_MAX && Math.floor(value) === value && !Object.is(value, -0))) {
      this[field] = Float64Array.from(column);
      this[field][i] = value;
      return;
    }
    column[i] = value;
  }

  grow(capacity) {
    for (const field of COLUMNS) {
      const old = this[field];
      const next = new old.constructor(capacity);
      next.set(old.subarray(0, this.length));
      this[field] = next;
    }
  }

  // Moves the table onto another dictionary, translating its ids once.
  rebase(dict) {
    if (dict === this.dict) return this;
    const from = this.dict.list;
    const map = new Int32Array(from.length);
    for (let id = 0; id < from.length; id++) map[id] = dict.id(from[id]);
    for (const field of NAME_FIELDS) {
      const column = this[field];
      for (let i = 0; i < this.length; i++) if (column[i] >= 0) column[i] = map[column[i]];
    }
    this.dict = dict;
    return this;
  }

  // The string a name column holds at row i, or undefined.
  nameAt(field, i) {
    const id = this[field][i];
    return id < 0 ? undefined : this.dict.list[id];
  }

  // Row i in the plain record shape. `ts` is the ISO form of `ms`; absent strings are left out.
  recordAt(i) {
    const record = {};
    if (this.keys[i] !== undefined) record.key = this.keys[i];
    const add = (field) => {
      const value = this.nameAt(field, i);
      if (value !== undefined) record[field] = value;
    };
    add('provider');
    const ms = this.ms[i];
    record.ts = Number.isNaN(ms) ? 'Invalid Date' : new Date(ms).toISOString();
    add('model');
    add('project');
    add('sessionId');
    for (const field of TOKEN_FIELDS) record[field] = this[field][i];
    add('cwd');
    add('host');
    return record;
  }

  toRecords() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.recordAt(i);
    return out;
  }
}

// A table from plain records ({ key, provider, ts, model, ... }), in order. `ts` may be a string,
// number or Date; it is stored as epoch ms. For callers that build records by hand.
// `dict` is ignored unless it is a NameDict, so tableFromRecords works as a map callback.
export function tableFromRecords(records, dict) {
  const table = new RecordTable(records.length, dict instanceof NameDict ? dict : new NameDict());
  const parse = timestampParser();
  for (const r of records) {
    table.push(r.key, parse(r.ts), r.provider, r.model, r.project, r.sessionId, r.cwd, r.host, r.input, r.output, r.cacheRead, r.cacheWrite, r.cacheWrite1h);
  }
  table.frozen = true;
  return table;
}

// A table as is; an array of plain records converted (once per array, so the same array gives
// the same table).
const converted = new WeakMap();
export function asTable(records) {
  if (records instanceof RecordTable) return records;
  if (!Array.isArray(records)) return new RecordTable(0);
  let table = converted.get(records);
  if (table === undefined) converted.set(records, (table = tableFromRecords(records)));
  return table;
}

// Distinct values of a name column, in order of first appearance.
export function distinctNames(table, field) {
  const seen = new Uint8Array(table.names.length);
  const out = [];
  const column = table[field];
  let absent = false;
  for (let i = 0; i < table.length; i++) {
    const id = column[i];
    if (id < 0) {
      if (!absent) {
        absent = true;
        out.push(undefined);
      }
    } else if (seen[id] === 0) {
      seen[id] = 1;
      out.push(table.names[id]);
    }
  }
  return out;
}
