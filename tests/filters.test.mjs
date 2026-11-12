import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRecords } from '../src/core/filters.mjs';
import { localClock, timestampParser } from '../src/core/time.mjs';

const DAY_MS = 86_400_000;
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

// Small seeded generator, so a failure repeats.
function random(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    return x / 2 ** 32;
  };
}

test('timestampParser gives what Date does, for transcript and odd timestamps', () => {
  const cases = [
    '2026-11-12T10:00:00.000Z',
    '2026-11-12T10:59:59.999Z',
    '2026-11-12T11:00:00.001Z', // the next hour, after the one above was cached
    '2026-02-30T00:00:00.000Z', // V8 rolls the day over; so must the parser
    '2026-02-29T23:59:59.123Z',
    '2026-01-01T24:00:00.000Z',
    '2026-01-01T23:60:00.000Z',
    '2026-01-01T23:00:60.000Z',
    '2026-01-01T23:00:00.12aZ',
    '2026-01-01t23:00:00.123Z',
    '2026-01-01 23:00:00.123Z',
    '2026-13-01T00:00:00.000Z',
    '2026-00-01T00:00:00.000Z',
    '2026-01-32T00:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    '2026-01-01T10:00:00Z',
    '2026-01-01T10:00:00.1234567Z',
    '2026-01-01T10:00:00.000+02:00',
    '2026-01-01T10:00:00.000',
    'garbage',
    '',
  ];
  const parse = timestampParser();
  for (const s of cases) assert.ok(same(parse(s), Date.parse(s)), s);
  for (const value of [null, undefined, 0, 1_700_000_000_000, true, {}, new Date('2026-01-01T00:00:00Z')]) {
    assert.ok(same(timestampParser()(value), new Date(value).getTime()), String(value));
  }

  const next = random(7);
  const chars = '0123456789-:.TZtz +x';
  let parser = timestampParser();
  for (let i = 0; i < 200_000; i++) {
    if (i % 5_000 === 0) parser = timestampParser();
    const base = new Date(Date.UTC(2020, 0, 1) + Math.floor(next() * 7 * 365) * DAY_MS + Math.floor(next() * DAY_MS)).toISOString();
    const s = base.split('');
    const edits = Math.floor(next() * 3);
    for (let k = 0; k < edits; k++) s[Math.floor(next() * 24)] = chars[Math.floor(next() * chars.length)];
    const text = s.join('');
    assert.ok(same(parser(text), Date.parse(text)), text);
  }
});

test('localClock gives the local day and hour Date does, across DST and odd offsets', () => {
  const saved = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Chatham', 'America/St_Johns']) {
      process.env.TZ = zone;
      const toLocal = localClock();
      for (const start of [Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 28), Date.UTC(2026, 3, 4), Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 24), Date.UTC(2026, 10, 0)]) {
        for (let m = 0; m < 3 * 24 * 60; m += 7) {
          const ms = start + m * 60_000 + 1_234;
          const date = new Date(ms);
          const local = toLocal(ms);
          const day = Math.floor(local / DAY_MS);
          assert.equal(day, Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS, `${zone} ${date.toISOString()}`);
          assert.equal(Math.floor((local - day * DAY_MS) / 3_600_000), date.getHours(), `${zone} ${date.toISOString()}`);
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('selectRecords slots are the local hour of the week', () => {
  const records = [];
  for (let h = 0; h < 24 * 9; h += 5) {
    records.push({ provider: 'claude', ts: new Date(Date.UTC(2026, 9, 20) + h * 3_600_000 + 17_000).toISOString(), sessionId: 's' });
  }
  const { rows, slots, count } = selectRecords(records, { range: 'all', now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(count, records.length);
  for (let k = 0; k < count; k++) {
    const { ts } = records[rows[k]];
    const date = new Date(ts);
    assert.equal(slots[k], date.getDay() * 24 + date.getHours(), ts);
  }
});
