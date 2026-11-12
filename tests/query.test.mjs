import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateDay, dayKey, localDay, normalizeQuery, MIN_USAGE_DATE } from '../src/core/query.mjs';
test('calendar parsing rejects normalization, accepts leap days and early years', () => {
  for (const value of ['2025-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '', null]) assert.throws(() => parseDateDay(value));
  for (const value of ['2024-02-29', '0099-01-01', '0000-01-01']) assert.equal(dayKey(parseDateDay(value)), value);
});
test('local calendar day arithmetic remains aligned across DST and year boundaries', () => {
  for (const [a, b] of [['2026-03-08', '2026-03-09'], ['2026-11-01', '2026-11-02'], ['2025-12-31', '2026-01-01']]) assert.equal(parseDateDay(b) - parseDateDay(a), 1);
  assert.equal(dayKey(localDay(new Date(2026, 10, 3, 0))), '2026-11-03');
});
test('query normalization provides defaults and canonical model sets', () => {
  assert.deepEqual(normalizeQuery(), { range: '7d', includeCache: true });
  assert.deepEqual(normalizeQuery({ models: ['z', 'a', 'z'], includeCache: false }), { range: '7d', includeCache: false, models: ['a', 'z'] });
});

test('custom usage ranges bound supported history while calendar parsing stays general', () => {
  const now = new Date(2026, 10, 12);
  for (const startDate of ['0000-01-01', '0099-01-01', '2019-12-31']) {
    assert.throws(() => normalizeQuery({ range: 'custom', startDate, endDate: '2026-11-12' }, now), /startDate must be on or after 2020-01-01/);
  }
  assert.equal(normalizeQuery({ range: 'custom', startDate: MIN_USAGE_DATE, endDate: MIN_USAGE_DATE }, now).startDate, '2020-01-01');
  assert.equal(dayKey(parseDateDay('0000-01-01')), '0000-01-01');
});
