import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTables } from '../src/core/record-store.mjs';
import { tableFromRecords } from '../src/core/table.mjs';

const rec = (key, ts, output) => ({ ...(key === undefined ? {} : { key }), provider: 'claude', ts, output });
const merge = (lists) => mergeTables(lists.map(tableFromRecords)).toRecords();

test('a key seen in two lists keeps the earliest record at its first position', () => {
  const merged = merge([
    [rec('a', '2026-10-02T10:00:00.000Z', 1), rec('b', '2026-10-01T10:00:00.000Z', 2)],
    [rec('a', '2026-10-01T10:00:00.000Z', 3), rec('c', '2026-10-03T10:00:00.000Z', 4)],
  ]);
  assert.deepEqual(merged.map((r) => r.output), [3, 2, 4]);
});

test('a later record with the same key and timestamp does not replace the first', () => {
  const merged = merge([[rec('a', '2026-10-01T10:00:00.000Z', 1)], [rec('a', '2026-10-01T10:00:00.000Z', 2)]]);
  assert.deepEqual(merged.map((r) => r.output), [1]);
});

test('records without a key are always kept, in order', () => {
  const merged = merge([[rec(undefined, '2026-10-01T10:00:00.000Z', 1), rec('a', '2026-10-01T10:00:00.000Z', 2)], [rec(undefined, '2026-10-01T10:00:00.000Z', 3)]]);
  assert.deepEqual(merged.map((r) => r.output), [1, 2, 3]);
});

test('empty input gives an empty table and inputs are left as they were', () => {
  assert.equal(mergeTables([]).length, 0);
  assert.equal(merge([[]]).length, 0);
  const first = tableFromRecords([rec('a', '2026-10-02T10:00:00.000Z', 1)]);
  const second = tableFromRecords([rec('a', '2026-10-01T10:00:00.000Z', 2)]);
  mergeTables([first, second]);
  assert.deepEqual(first.toRecords().map((r) => r.output), [1]);
  assert.deepEqual(second.toRecords().map((r) => r.output), [2]);
});

test('a large merge keeps one record per key in linear time', () => {
  const list = tableFromRecords(Array.from({ length: 200_000 }, (_, i) => rec(`m${i % 100_000}`, '2026-10-01T10:00:00.000Z', i)));
  assert.equal(mergeTables([list, list]).length, 100_000);
});
