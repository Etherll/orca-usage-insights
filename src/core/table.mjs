// Usage records as columns: typed arrays plus a dictionary of distinct strings instead of an object per
// record. Pure: no Node built-in or Orca imports. ms is epoch ms, NaN when it did not parse. Counts are
// Uint32Array until a count is not a whole u32, then Float64Array. Name ids are -1 for no string.
// replace keeps the row's key. `version` counts pushes and replaces; `replaced` lists rows replaced since `epoch`.

import { timestampParser } from './time.mjs';

export const TOKEN_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']);
export const NAME_FIELDS = Object.freeze(['provider', 'model', 'project', 'sessionId', 'cwd', 'host']);
export const COLUMNS = Object.freeze(['ms', ...TOKEN_FIELDS, ...NAME_FIELDS]);
const U32_MAX = 0xffffffff;
// Past this many replaced rows the log restarts under a new epoch; a reader on the old one rereads the table.
const REPLACED_LOG_MAX = 4096;

// Ids never change and strings are never removed, so tables sharing a dictionary copy ids untranslated.
export class NameDict {
  constructor(list = []) {
    this.list = list;
    this.index = null;
  }

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

  get names() {
    return this.dict.list;
  }

  push(key, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h) {
    const i = this.length;
    if (i === this.ms.length) this.grow(Math.max(16, i * 2));
    this.length = i + 1;
    this.keys.push(typeof key === 'string' ? key : undefined);
    this.write(i, ms, provider, model, project, sessionId, cwd, host, input, output, cacheRead, cacheWrite, cacheWrite1h);
    this.version++;
    return i;
  }

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

  nameAt(field, i) {
    const id = this[field][i];
    return id < 0 ? undefined : this.dict.list[id];
  }

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

// `ts` may be a string, number or Date. `dict` is ignored unless a NameDict, so this works as a map callback.
export function tableFromRecords(records, dict) {
  const table = new RecordTable(records.length, dict instanceof NameDict ? dict : new NameDict());
  const parse = timestampParser();
  for (const r of records) {
    table.push(r.key, parse(r.ts), r.provider, r.model, r.project, r.sessionId, r.cwd, r.host, r.input, r.output, r.cacheRead, r.cacheWrite, r.cacheWrite1h);
  }
  table.frozen = true;
  return table;
}

const converted = new WeakMap();
export function asTable(records) {
  if (records instanceof RecordTable) return records;
  if (!Array.isArray(records)) return new RecordTable(0);
  let table = converted.get(records);
  if (table === undefined) converted.set(records, (table = tableFromRecords(records)));
  return table;
}

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
