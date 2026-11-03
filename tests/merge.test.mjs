import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords } from '../src/core/merge.mjs';

const rec = (key, ts, output) => ({ ...(key === undefined ? {} : { key }), provider: 'claude', ts, output });

test('a key seen in two lists keeps the earliest record at its first position', () => {
  const merged = mergeRecords([
    [rec('a', '2026-10-02T10:00:00.000Z', 1), rec('b', '2026-10-01T10:00:00.000Z', 2)],
    [rec('a', '2026-10-01T10:00:00.000Z', 3), rec('c', '2026-10-03T10:00:00.000Z', 4)],
  ]);
  assert.deepEqual(merged.map((r) => r.output), [3, 2, 4]);
});

test('a later record with the same key and timestamp does not replace the first', () => {
  const merged = mergeRecords([[rec('a', '2026-10-01T10:00:00.000Z', 1)], [rec('a', '2026-10-01T10:00:00.000Z', 2)]]);
  assert.deepEqual(merged.map((r) => r.output), [1]);
});

test('records without a key are always kept, in order', () => {
  const merged = mergeRecords([[rec(undefined, '2026-10-01T10:00:00.000Z', 1), rec('a', '2026-10-01T10:00:00.000Z', 2)], [rec(undefined, '2026-10-01T10:00:00.000Z', 3)]]);
  assert.deepEqual(merged.map((r) => r.output), [1, 2, 3]);
});

test('empty input gives an empty list and inputs are left as they were', () => {
  assert.deepEqual(mergeRecords([]), []);
  assert.deepEqual(mergeRecords([[]]), []);
  const first = [rec('a', '2026-10-02T10:00:00.000Z', 1)];
  const second = [rec('a', '2026-10-01T10:00:00.000Z', 2)];
  mergeRecords([first, second]);
  assert.deepEqual(first.map((r) => r.output), [1]);
  assert.deepEqual(second.map((r) => r.output), [2]);
});

test('a large merge keeps one record per key in linear time', () => {
  const list = Array.from({ length: 200_000 }, (_, i) => rec(`m${i % 100_000}`, '2026-10-01T10:00:00.000Z', i));
  const merged = mergeRecords([list, list]);
  assert.equal(merged.length, 100_000);
});
