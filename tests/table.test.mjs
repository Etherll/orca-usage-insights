import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTable, encodeTable, transferList } from '../src/core/table-codec.mjs';
import { RecordTable, asTable, distinctNames, tableFromRecords } from '../src/core/table.mjs';

const T0 = Date.UTC(2026, 9, 1, 10);

function record(i, over = {}) {
  return {
    key: `k${i}`,
    provider: i % 3 === 0 ? 'codex' : 'claude',
    ts: new Date(T0 + i * 60_000).toISOString(),
    model: `m${i % 4}`,
    project: `p${i % 5}`,
    sessionId: `s${i % 7}`,
    input: i,
    output: 2 * i,
    cacheRead: 3 * i,
    cacheWrite: 4 * i,
    cacheWrite1h: i % 2,
    cwd: `/w/p${i % 5}`,
    host: 'local',
    ...over,
  };
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

test('a table keeps every field of the records it was made from', () => {
  const records = Array.from({ length: 50 }, (_, i) => record(i));
  records[3] = { ...records[3] };
  delete records[3].key;
  delete records[3].cwd;
  const table = tableFromRecords(records);
  assert.equal(table.length, 50);
  assert.deepEqual(table.toRecords(), records);
  assert.equal(table.nameAt('cwd', 3), undefined);
  assert.equal(table.names.filter((n) => n === 'claude').length, 1, 'strings are stored once');
});

test('counts that are not whole 32-bit numbers switch their column to Float64', () => {
  const table = new RecordTable(2);
  table.push('a', T0, 'claude', 'm', 'p', 's', '', 'local', 1, 2, 3, 4, 0);
  assert.ok(table.input instanceof Uint32Array);
  for (const value of [1.5, -1, 2 ** 32, -0, NaN, 1e300]) {
    table.push(undefined, T0, 'claude', 'm', 'p', 's', '', 'local', value, 2, 3, 4, 0);
  }
  assert.ok(table.input instanceof Float64Array);
  assert.ok(table.output instanceof Uint32Array, 'other columns stay narrow');
  const inputs = table.toRecords().map((r) => r.input);
  assert.deepEqual(inputs.slice(0, 4), [1, 1.5, -1, 2 ** 32]);
  assert.ok(Object.is(inputs[4], -0));
  assert.ok(Number.isNaN(inputs[5]));
  assert.equal(inputs[6], 1e300);
});

test('replace rewrites a row in place and keeps its key', () => {
  const table = new RecordTable(0);
  for (let i = 0; i < 40; i++) table.push(`k${i}`, T0 + i, 'claude', 'm', 'p', 's', '', 'local', i, 0, 0, 0, 0);
  table.replace(7, T0 + 99, 'codex', 'm2', 'p2', 's2', '/x', 'h', 70, 1, 2, 3, 1);
  const row = table.recordAt(7);
  assert.equal(row.key, 'k7');
  assert.deepEqual([row.provider, row.model, row.input, row.cwd, row.host], ['codex', 'm2', 70, '/x', 'h']);
  assert.equal(table.recordAt(8).input, 8);
});

test('encode gives the same table back, as cache strings and as typed arrays', () => {
  const next = random(3);
  const table = new RecordTable(0);
  for (let i = 0; i < 700; i++) {
    const big = next() < 0.1 ? 70_000 + i : i;
    table.push(next() < 0.2 ? undefined : `k${i}`, T0 + i * 1000, 'claude', `m${i % 300}`, 'p', `s${i % 3}`, i % 9 ? '/w' : undefined, 'local', big, i, 0, i * 300, 0);
  }
  const fromJson = decodeTable(JSON.parse(JSON.stringify(encodeTable(table))));
  assert.deepEqual(fromJson.toRecords(), table.toRecords());
  const binary = encodeTable(table, { binary: true });
  const copied = structuredClone(binary, { transfer: transferList(binary) });
  assert.deepEqual(decodeTable(copied).toRecords(), table.toRecords());
  const encoded = encodeTable(table);
  assert.match(encoded.provider, /^n8:/);
  assert.match(encoded.model, /^n16:/);
  assert.match(encoded.output, /^u16:/);
  assert.match(encoded.cacheWrite, /^u32:/);
  assert.ok(fromJson.model instanceof Int32Array && fromJson.output instanceof Uint32Array);
});

test('a malformed encoded table throws', () => {
  const good = encodeTable(tableFromRecords([record(1), record(2)]));
  for (const bad of [
    { ...good, f: 2 },
    { ...good, n: 3 },
    { ...good, keys: ['a'] },
    { ...good, ms: 'u8:AAAA' },
    { ...good, model: 'n8:' + Buffer.from([1, 200]).toString('base64') },
    { ...good, input: 'f32:AAAAAAAAAAA=' },
    { ...good, names: [1] },
  ]) {
    assert.throws(() => decodeTable(bad));
  }
});

test('asTable converts an array once, and distinctNames lists values in order', () => {
  const records = [record(1), record(5, { model: 'm1' }), record(2), record(3, { model: undefined })];
  const table = asTable(records);
  assert.equal(asTable(records), table);
  assert.equal(asTable(table), table);
  assert.deepEqual(distinctNames(table, 'model'), ['m1', 'm2', undefined]);
});
