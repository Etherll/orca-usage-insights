import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordStore } from '../src/core/record-store.mjs';
import { NameDict, RecordTable } from '../src/core/table.mjs';

const T0 = Date.UTC(2026, 9, 1, 10);

// The merge rule, written the plain way over records: the reference the store must match.
function reference(tables) {
  const out = [];
  const slot = new Map();
  for (const table of tables) {
    for (const record of table.toRecords()) {
      if (typeof record.key !== 'string') {
        out.push(record);
        continue;
      }
      const at = slot.get(record.key);
      if (at === undefined) {
        slot.set(record.key, out.length);
        out.push(record);
      } else if (Date.parse(record.ts) < Date.parse(out[at].ts)) {
        out[at] = record;
      }
    }
  }
  return out;
}

// Small seeded generator, so a failure repeats.
function random(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    return x / 2 ** 32;
  };
}

function row(next, keySpace) {
  const ms = next() < 0.03 ? NaN : T0 + Math.floor(next() * 6) * 60_000;
  const key = next() < 0.15 ? undefined : `k${Math.floor(next() * keySpace)}`;
  const n = Math.floor(next() * 1000);
  return [key, ms, next() < 0.5 ? 'claude' : 'codex', `m${n % 3}`, `p${n % 4}`, `s${n % 5}`, `/w/${n % 4}`, next() < 0.1 ? 'ssh:box' : 'local', n, n + 1, n % 7, n % 11, n % 2];
}

function fill(table, next, count, keySpace) {
  for (let i = 0; i < count; i++) table.push(...row(next, keySpace));
  return table;
}

test('incremental merges equal a fresh merge after every kind of change', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const next = random(seed);
    const shared = next() < 0.7;
    const names = new NameDict();
    const dictFor = () => (shared && next() < 0.9 ? names : new NameDict());
    const keySpace = 5 + Math.floor(next() * 60);
    const store = createRecordStore({ names });
    let nextId = 0;
    let sources = Array.from({ length: 1 + Math.floor(next() * 5) }, () => ({ id: `f${nextId++}`, table: fill(new RecordTable(0, dictFor()), next, Math.floor(next() * 12), keySpace) }));
    let previous = null;
    for (let step = 0; step < 60; step++) {
      const op = next();
      const pick = () => sources[Math.floor(next() * sources.length)];
      let touched = true;
      if (op < 0.3 && sources.length) fill(pick().table, next, 1 + Math.floor(next() * 5), keySpace);
      else if (op < 0.5 && sources.length) {
        const { table } = pick();
        if (table.length) {
          const r = Math.floor(next() * table.length);
          const [, ...rest] = row(next, keySpace);
          table.replace(r, ...rest);
        } else touched = false;
      } else if (op < 0.58 && sources.length) {
        const src = pick();
        src.table = fill(new RecordTable(0, dictFor()), next, Math.floor(next() * 10), keySpace);
      } else if (op < 0.66 && sources.length > 1) {
        sources.splice(Math.floor(next() * sources.length), 1);
      } else if (op < 0.76) {
        sources.splice(Math.floor(next() * (sources.length + 1)), 0, { id: `f${nextId++}`, table: fill(new RecordTable(0, dictFor()), next, Math.floor(next() * 10), keySpace) });
      } else if (op < 0.82 && sources.length > 1) {
        const i = Math.floor(next() * sources.length);
        const j = Math.floor(next() * sources.length);
        [sources[i], sources[j]] = [sources[j], sources[i]];
        touched = i !== j;
      } else if (op < 0.84 && sources.length) {
        // Enough replaces to start the table's replaced-row log over.
        const { table } = pick();
        if (table.length) for (let k = 0; k < 4100; k++) table.replace(k % table.length, ...row(next, keySpace).slice(1));
        else touched = false;
      } else {
        touched = false;
      }
      sources = sources.map((s) => ({ ...s }));
      const out = store.update(sources);
      assert.deepEqual(out.toRecords(), reference(sources.map((s) => s.table)), `seed ${seed} step ${step}`);
      assert.ok(out.frozen);
      if (!touched && previous) assert.equal(out, previous, `seed ${seed} step ${step}: nothing changed, same table`);
      previous = out;
    }
  }
});

test('a source listed twice is refused', () => {
  const store = createRecordStore();
  const table = new RecordTable();
  assert.throws(() => store.update([{ id: 'a', table }, { id: 'a', table }]), /listed twice/);
});

test('sources on the shared dictionary are copied in bulk; others are translated', () => {
  const names = new NameDict();
  const store = createRecordStore({ names });
  const own = new RecordTable(0, names);
  own.push('a', T0, 'claude', 'm', 'p', 's', '/w', 'local', 1, 2, 3, 4, 0);
  const other = new RecordTable(0, new NameDict(['zz', 'yy']));
  other.push('b', T0, 'codex', 'm2', 'p2', 's2', '/x', 'local', 5, 6, 7, 8, 0);
  const out = store.update([{ id: 1, table: own }, { id: 2, table: other }]);
  assert.equal(out.dict, names);
  assert.deepEqual(out.toRecords().map((r) => [r.key, r.provider, r.model]), [['a', 'claude', 'm'], ['b', 'codex', 'm2']]);
});
