// Writes records in the packed form caches before version 5 used (see unpackRecords in
// src/core/records.mjs), so tests can build an older cache and check it is converted.
const RECORD_FIELDS = ['key', 'provider', 'ts', 'model', 'project', 'sessionId', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cwd', 'host'];
const NUMBER_FIELDS = new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']);
const WIDTH = RECORD_FIELDS.length;

export function packRecords(list) {
  const strings = [];
  const index = new Map();
  const rows = new Array(list.length * WIDTH);
  let at = 0;
  for (const record of list) {
    for (let f = 0; f < WIDTH; f++) {
      const value = record[RECORD_FIELDS[f]];
      if (NUMBER_FIELDS.has(RECORD_FIELDS[f])) rows[at++] = typeof value === 'number' ? value : 0;
      else if (typeof value !== 'string') rows[at++] = -1;
      else {
        let i = index.get(value);
        if (i === undefined) {
          i = strings.length;
          strings.push(value);
          index.set(value, i);
        }
        rows[at++] = i;
      }
    }
  }
  return { s: strings, r: rows };
}
