import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED } from '../src/core/catalog-data.mjs';
import * as catalog from '../src/core/catalog.mjs';
import * as bands from '../src/core/bands.mjs';
import * as sources from '../src/core/price-sources.mjs';
import { DEFAULT_CATALOG } from '../src/core/pricing.mjs';

const { buildCatalog, resolveModel, requestCost } = catalog;

test('the bundled catalog builds with no problems, one entry per bundled id, sorted', () => {
  const built = buildCatalog(BUNDLED);
  assert.deepEqual(built.problems, []);
  assert.equal(built.entries.size, BUNDLED.length);
  const ids = [...built.entries.keys()];
  assert.deepEqual(ids, [...ids].sort());
});

test('the version is 8 hex digits, stable for the same inputs and changed by a price change', () => {
  const first = buildCatalog(BUNDLED);
  assert.match(first.version, /^[0-9a-f]{8}$/);
  assert.equal(buildCatalog(BUNDLED).version, first.version);
  assert.equal(DEFAULT_CATALOG.version, first.version);
  const changed = buildCatalog(BUNDLED, null, { models: { 'claude-opus-5-5': { input: 3 } } });
  assert.notEqual(changed.version, first.version);
});

test('a broken bundled list or junk layers never throw and are named in problems', () => {
  assert.deepEqual(buildCatalog({}).problems, ['bundled: not a list']);
  assert.equal(buildCatalog({}).entries.size, 0);

  const junk = buildCatalog(BUNDLED, 42, 'x');
  assert.equal(junk.entries.size, BUNDLED.length);
  assert.ok(junk.problems.includes('overlay: ignored'));
  assert.ok(junk.problems.includes('overrides: ignored'));

  assert.ok(buildCatalog(BUNDLED, { entries: 5 }).problems.includes('overlay: ignored'));
  assert.deepEqual(buildCatalog([null, { id: 5 }]).problems, [
    'bundled: entry without an id',
    'bundled: entry without an id',
  ]);
});

test('an overlay patch replaces the fields it sets and keeps the rest of the bundled entry', () => {
  const overlay = { entries: { 'claude-opus-5-5': { asOf: '2026-12-01', input: 4.5, source: 'litellm' } } };
  const built = buildCatalog(BUNDLED, overlay);
  assert.deepEqual(built.problems, []);
  const entry = built.entries.get('claude-opus-5-5');
  assert.equal(entry.input, 4.5);
  assert.equal(entry.output, 20);
  assert.equal(entry.cacheRead, 0.2);
  assert.deepEqual(entry.cacheWrite, { '5m': 5, '1h': 8 });
  assert.equal(entry.asOf, '2026-12-01');
});

test('a partial override beats the bundled price and a newer overlay, keeping untouched fields', () => {
  const overlay = { entries: { 'claude-opus-5-5': { asOf: '2026-12-01', input: 4.5, source: 'litellm' } } };
  const overrides = { models: { 'claude-opus-5-5': { input: 3, output: 30 } } };
  const built = buildCatalog(BUNDLED, overlay, overrides);
  assert.deepEqual(built.problems, []);
  const entry = built.entries.get('claude-opus-5-5');
  assert.equal(entry.input, 3);
  assert.equal(entry.output, 30);
  assert.equal(entry.cacheRead, 0.2);
  assert.deepEqual(entry.cacheWrite, { '5m': 5, '1h': 8 });
  assert.equal(entry.source, 'user');
  assert.equal(entry.asOf, '2026-12-01');
});

test('an override partial cacheWrite merges one level into the existing rates', () => {
  const built = buildCatalog(BUNDLED, null, { models: { 'claude-opus-5-5': { cacheWrite: { '1h': 9 } } } });
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.entries.get('claude-opus-5-5').cacheWrite, { '5m': 5, '1h': 9 });
});

test('an overlay older than the current entry is skipped', () => {
  const overlay = { entries: { 'claude-opus-5-5': { asOf: '2026-01-01', input: 9, source: 'litellm' } } };
  const built = buildCatalog(BUNDLED, overlay);
  assert.deepEqual(built.problems, []);
  assert.equal(built.entries.get('claude-opus-5-5').input, 4);
});

test('an overlay entry with an invalid asOf is named in problems and not applied', () => {
  const overlay = { entries: { 'claude-opus-5-5': { asOf: '2026/12/01', input: 9 } } };
  const built = buildCatalog(BUNDLED, overlay);
  assert.deepEqual(built.problems, ['overlay claude-opus-5-5: invalid asOf']);
  assert.equal(built.entries.get('claude-opus-5-5').input, 4);
});

test('a new model in the overlay is added and priced', () => {
  const overlay = {
    entries: {
      'Claude-Test-9': {
        asOf: '2026-12-01',
        provider: 'anthropic',
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: { '5m': 1.25, '1h': 2 },
        source: 'litellm',
      },
    },
  };
  const built = buildCatalog(BUNDLED, overlay);
  assert.deepEqual(built.problems, []);
  assert.equal(built.entries.size, BUNDLED.length + 1);
  assert.equal(resolveModel('claude-test-9', built).id, 'claude-test-9');
  assert.equal(requestCost({ model: 'claude-test-9', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, built), 1);
});

test('a new OpenAI model added by an override takes its provider from its id and a default write rate', () => {
  const built = buildCatalog(BUNDLED, null, {
    asOf: '2026-12-03',
    models: { 'gpt-test-1': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: { default: 5 } } },
  });
  assert.deepEqual(built.problems, []);
  const entry = built.entries.get('gpt-test-1');
  assert.equal(entry.provider, 'openai');
  assert.deepEqual(entry.cacheWrite, { default: 5 });
  assert.equal(entry.source, 'user');
  assert.equal(entry.asOf, '2026-12-03');
});

test('an alias in the overrides resolves to its model', () => {
  const built = buildCatalog(BUNDLED, null, { aliases: { 'Claude-Opus-Latest': 'claude-opus-5-5' } });
  assert.deepEqual(built.problems, []);
  assert.ok(built.entries.get('claude-opus-5-5').aliases.includes('claude-opus-latest'));
  assert.equal(resolveModel('claude-opus-latest', built).id, 'claude-opus-5-5');
});

test('an alias to a missing model is named in problems while the other overrides apply', () => {
  const built = buildCatalog(BUNDLED, null, {
    aliases: { 'claude-x-latest': 'claude-nope' },
    models: { 'claude-opus-5-5': { output: 30 } },
  });
  assert.deepEqual(built.problems, ['overrides alias claude-x-latest: no such model']);
  assert.equal(built.entries.get('claude-opus-5-5').output, 30);
  assert.equal(resolveModel('claude-x-latest', built), null);
});

test('a negative rate is named in problems and the bundled price stays', () => {
  const built = buildCatalog(BUNDLED, null, { models: { 'claude-opus-5-5': { input: -1, output: 30 } } });
  assert.deepEqual(built.problems, ['overrides claude-opus-5-5: invalid input']);
  assert.equal(built.entries.get('claude-opus-5-5').input, 4);
  assert.equal(built.entries.get('claude-opus-5-5').output, 20);
});

test('a tier above a size that is not a price band is rejected', () => {
  const tiers = [{ above: 150000, input: 1, output: 1, cacheRead: 0.1, cacheWrite: null }];
  const built = buildCatalog(BUNDLED, null, { models: { 'claude-opus-5-5': { tiers } } });
  assert.deepEqual(built.problems, ['overrides claude-opus-5-5: invalid tiers']);
  assert.equal(built.entries.get('claude-opus-5-5').tiers, null);
});

test('an invalid overrides asOf is named in problems and the overrides still apply', () => {
  const built = buildCatalog(BUNDLED, null, { asOf: '2026/12/01', models: { 'claude-opus-5-5': { output: 30 } } });
  assert.deepEqual(built.problems, ['overrides: invalid asOf']);
  assert.equal(built.entries.get('claude-opus-5-5').output, 30);
});

test('a model id that is only a family of a bundled id is unpriced', () => {
  assert.equal(resolveModel('claude-opus-5-9', buildCatalog(BUNDLED)), null);
});

test('the catalog re-exports the band and id helpers unchanged', () => {
  assert.equal(catalog.PROMPT_BANDS, bands.PROMPT_BANDS);
  assert.equal(catalog.bandOf, bands.bandOf);
  assert.equal(catalog.normalizeModelId, sources.normalizeModelId);
});

test('a record without cacheWrite1h prices every cache write at the 5-minute rate', () => {
  const built = buildCatalog(BUNDLED);
  assert.ok(Math.abs(requestCost({ model: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, built) - 5) < 1e-9);
});

test('the overrides example in the README builds without problems', async () => {
  const { readFile } = await import('node:fs/promises');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const block = readme.match(/```json\n(\{\n  "v": 1,[\s\S]*?)\n```/);
  assert.ok(block, 'README has the overrides example');
  const catalog = buildCatalog(BUNDLED, null, JSON.parse(block[1]));
  assert.deepEqual(catalog.problems, []);
  assert.ok(catalog.entries.get('my-proxy-model'));
});
