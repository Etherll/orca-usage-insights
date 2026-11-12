import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalog } from '../src/core/catalog.mjs';
import { diffCatalog, overriddenKeysOf, proposalOf } from '../src/core/price-diff.mjs';
import { parseLiteLLM, parseModelsDev } from '../src/core/price-sources.mjs';

const BUNDLED = [
  { id: 'claude-opus-5-5', provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: { '5m': 5, '1h': 8 }, source: 'litellm', asOf: '2026-10-01' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: { '5m': 3.75 }, source: 'litellm', asOf: '2026-10-01' },
  { id: 'claude-zero-5-5', provider: 'anthropic', input: 0, output: 0, cacheRead: 0, cacheWrite: { '5m': 0 }, source: 'litellm', asOf: '2026-10-01' },
];
const catalog = () => buildCatalog(BUNDLED);

// Adapter-shaped output for a source: entries with the fields the diff reads.
function source(entries, extra = {}) {
  return {
    entries: entries.map((entry) => ({
      provider: 'anthropic',
      aliases: [],
      contextWindow: null,
      source: 'litellm',
      asOf: '2026-11-11',
      ...entry,
    })),
    ...extra,
  };
}

const rowOf = (rows, key) => rows.find((row) => row.key === key);

test('sources that agree with each other and with the catalog are agree and pre-ticked', () => {
  const both = source([{ id: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: { '5m': 5 } }]);
  const { rows } = diffCatalog(catalog(), { litellm: both, modelsdev: both }, ['claude-opus-5-5']);
  const input = rowOf(rows, 'claude-opus-5-5.input');
  assert.equal(input.status, 'agree');
  assert.equal(input.ticked, true);
  assert.equal(input.current, 4);
  assert.equal(input.litellm, 4);
  assert.equal(input.modelsdev, 4);
});

test('sources that differ disagree and stay unticked', () => {
  const litellm = source([{ id: 'claude-opus-5-5', input: 4.1 }]);
  const modelsdev = source([{ id: 'claude-opus-5-5', input: 4.3 }]);
  const { rows } = diffCatalog(catalog(), { litellm, modelsdev }, ['claude-opus-5-5']);
  const input = rowOf(rows, 'claude-opus-5-5.input');
  assert.equal(input.status, 'disagree');
  assert.equal(input.ticked, false);
});

test('agreement is within 1e-9 absolute', () => {
  const close = source([{ id: 'claude-sonnet-5-5', output: 15 }]);
  const closer = source([{ id: 'claude-sonnet-5-5', output: 15 + 5e-10 }]);
  const apart = source([{ id: 'claude-sonnet-5-5', output: 15 + 2e-9 }]);
  const inside = diffCatalog(catalog(), { litellm: close, modelsdev: closer }, ['claude-sonnet-5-5']).rows;
  const outside = diffCatalog(catalog(), { litellm: close, modelsdev: apart }, ['claude-sonnet-5-5']).rows;
  assert.equal(rowOf(inside, 'claude-sonnet-5-5.output').status, 'agree');
  assert.equal(rowOf(outside, 'claude-sonnet-5-5.output').status, 'disagree');
});

test('a field only one source gives is single and unticked', () => {
  const modelsdev = source([{ id: 'claude-sonnet-5-5', input: 3 }]);
  const { rows } = diffCatalog(catalog(), { modelsdev }, ['claude-sonnet-5-5']);
  const input = rowOf(rows, 'claude-sonnet-5-5.input');
  assert.equal(input.status, 'single');
  assert.equal(input.ticked, false);
  assert.equal(input.litellm, null);
  assert.equal(input.modelsdev, 3);
});

test('a model in use that the catalog lacks is new and unticked', () => {
  const both = source([{ id: 'claude-haiku-5-5', input: 0.1 }]);
  const { rows } = diffCatalog(catalog(), { litellm: both, modelsdev: both }, ['claude-haiku-5-5']);
  const input = rowOf(rows, 'claude-haiku-5-5.input');
  assert.equal(input.status, 'new');
  assert.equal(input.ticked, false);
  assert.equal(input.current, null);
});

test('models the sources list but that are not in use are counted, not listed', () => {
  const both = source([
    { id: 'claude-sonnet-5-5', input: 3 },
    { id: 'claude-haiku-5-5', input: 0.1 },
    { id: 'claude-fable-5-2', input: 9 },
  ]);
  const { rows, notInUse } = diffCatalog(catalog(), { litellm: both, modelsdev: both }, ['claude-sonnet-5-5']);
  assert.equal(notInUse, 2);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.model === 'claude-sonnet-5-5'));
});

test('a row the overrides file sets is overridden and unticked, whatever the sources say', () => {
  const both = source([{ id: 'claude-opus-5-5', output: 20 }]);
  const { rows } = diffCatalog(catalog(), { litellm: both, modelsdev: both }, ['claude-opus-5-5'], ['claude-opus-5-5.output']);
  const output = rowOf(rows, 'claude-opus-5-5.output');
  assert.equal(output.status, 'overridden');
  assert.equal(output.ticked, false);
});

test('overridden wins over flagged', () => {
  const litellm = source([{ id: 'claude-opus-5-5', output: 2000 }]);
  const modelsdev = source([{ id: 'claude-opus-5-5', output: 2000 }]);
  const { rows } = diffCatalog(catalog(), { litellm, modelsdev }, ['claude-opus-5-5'], ['claude-opus-5-5.output']);
  assert.equal(rowOf(rows, 'claude-opus-5-5.output').status, 'overridden');
});

test('a change of 10x or more in either direction is flagged, and a smaller one is not', () => {
  const up = source([{ id: 'claude-opus-5-5', input: 40 }]);
  const down = source([{ id: 'claude-opus-5-5', output: 2 }]);
  const near = source([{ id: 'claude-opus-5-5', cacheRead: 0.2 * 9.9 }]);
  const flagUp = diffCatalog(catalog(), { litellm: up, modelsdev: up }, ['claude-opus-5-5']).rows;
  const flagDown = diffCatalog(catalog(), { litellm: down, modelsdev: down }, ['claude-opus-5-5']).rows;
  const calm = diffCatalog(catalog(), { litellm: near, modelsdev: near }, ['claude-opus-5-5']).rows;
  assert.equal(rowOf(flagUp, 'claude-opus-5-5.input').status, 'flagged');
  assert.equal(rowOf(flagDown, 'claude-opus-5-5.output').status, 'flagged');
  assert.equal(rowOf(calm, 'claude-opus-5-5.cacheRead').status, 'agree');
});

test('a zero price where the model is paid is flagged', () => {
  const zero = source([{ id: 'claude-opus-5-5', output: 0 }]);
  const { rows } = diffCatalog(catalog(), { litellm: zero, modelsdev: zero }, ['claude-opus-5-5']);
  assert.equal(rowOf(rows, 'claude-opus-5-5.output').status, 'flagged');
});

test('a positive price where the current rate is zero is flagged', () => {
  const paid = source([{ id: 'claude-zero-5-5', input: 1 }]);
  const { rows } = diffCatalog(catalog(), { litellm: paid, modelsdev: paid }, ['claude-zero-5-5']);
  const input = rowOf(rows, 'claude-zero-5-5.input');
  assert.equal(input.status, 'flagged');
  assert.equal(input.ticked, false);
});

test('a unit mismatch between sources is flagged', () => {
  const perToken = source([{ id: 'claude-opus-5-5', input: 4e-6 }]);
  const perMillion = source([{ id: 'claude-opus-5-5', input: 4 }]);
  const { rows } = diffCatalog(catalog(), { litellm: perToken, modelsdev: perMillion }, ['claude-opus-5-5']);
  const input = rowOf(rows, 'claude-opus-5-5.input');
  assert.equal(input.status, 'flagged');
  assert.equal(input.ticked, false);
});

test('an unknown per-token field flags that model, not the others', () => {
  const litellm = source([{ id: 'claude-opus-5-5', input: 4 }, { id: 'claude-sonnet-5-5', input: 3 }], {
    unknownFields: { 'claude-opus-5-5': ['input_cost_per_audio_token'] },
  });
  const modelsdev = source([{ id: 'claude-opus-5-5', input: 4 }, { id: 'claude-sonnet-5-5', input: 3 }]);
  const { rows } = diffCatalog(catalog(), { litellm, modelsdev }, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(rowOf(rows, 'claude-opus-5-5.input').status, 'flagged');
  assert.equal(rowOf(rows, 'claude-sonnet-5-5.input').status, 'agree');
});

test('a per-query fee the adapter does not map does not flag the model', () => {
  const litellm = source([{ id: 'claude-opus-5-5', input: 4 }], { unknownFields: { 'claude-opus-5-5': ['search_context_cost_per_query'] } });
  const modelsdev = source([{ id: 'claude-opus-5-5', input: 4 }]);
  const { rows } = diffCatalog(catalog(), { litellm, modelsdev }, ['claude-opus-5-5']);
  assert.equal(rowOf(rows, 'claude-opus-5-5.input').status, 'agree');
});

test('the real fixtures give rows that are not all flagged', () => {
  const litellm = parseLiteLLM(readJson('litellm.json'), { asOf: '2026-11-11' });
  const modelsdev = parseModelsDev(readJson('modelsdev.json'), { asOf: '2026-11-11' });
  const { rows } = diffCatalog(catalog(), { litellm, modelsdev }, ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((row) => row.status !== 'flagged'));
});

test('ticked is true exactly for agree rows', () => {
  const litellm = source([
    { id: 'claude-opus-5-5', input: 4, output: 21 },
    { id: 'claude-sonnet-5-5', output: 15, input: 3 },
    { id: 'claude-haiku-5-5', input: 0.1 },
  ]);
  const modelsdev = source([
    { id: 'claude-opus-5-5', input: 4, output: 22 },
    { id: 'claude-sonnet-5-5', output: 15 },
    { id: 'claude-haiku-5-5', input: 0.1 },
  ]);
  const { rows } = diffCatalog(catalog(), { litellm, modelsdev }, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.ok(rows.some((row) => row.status === 'agree'));
  assert.ok(rows.some((row) => row.status !== 'agree'));
  for (const row of rows) assert.equal(row.ticked, row.status === 'agree', row.key);
});

test('no sources gives no rows and no notInUse', () => {
  assert.deepEqual(diffCatalog(catalog(), {}, ['claude-opus-5-5']), { rows: [], notInUse: 0 });
});

test('row keys carry the model and field, and the row has the documented fields', () => {
  const both = source([{ id: 'claude-opus-5-5', cacheWrite: { '5m': 5, '1h': 8 } }]);
  const { rows } = diffCatalog(catalog(), { litellm: both, modelsdev: both }, ['claude-opus-5-5']);
  const hour = rowOf(rows, 'claude-opus-5-5.cacheWrite.1h');
  assert.deepEqual(Object.keys(hour).sort(), ['current', 'field', 'key', 'litellm', 'model', 'modelsdev', 'status', 'ticked']);
  assert.equal(hour.model, 'claude-opus-5-5');
  assert.equal(hour.field, 'cacheWrite.1h');
  assert.equal(hour.current, 8);
});

test('proposalOf takes the LiteLLM value and source when there is one, else models.dev under manual', () => {
  const both = proposalOf({ model: 'm', field: 'input', litellm: 4, modelsdev: 4.2 });
  const only = proposalOf({ model: 'm', field: 'input', litellm: null, modelsdev: 4.2 });
  assert.deepEqual(both, { model: 'm', field: 'input', value: 4, source: 'litellm' });
  assert.deepEqual(only, { model: 'm', field: 'input', value: 4.2, source: 'manual' });
});

test('overriddenKeysOf lists the rate keys the overrides file sets, normalized', () => {
  const keys = overriddenKeysOf({
    v: 1,
    asOf: '2026-11-11',
    models: {
      'Claude-Opus-5-5': { output: 18 },
      'my-proxy-model': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: { '5m': 1.25, '1h': 2 } },
      'not-a-patch': 3,
    },
    aliases: { 'my-proxy-opus': 'claude-opus-5-5' },
  });
  assert.deepEqual([...keys].sort(), [
    'claude-opus-5-5.output',
    'my-proxy-model.cacheRead',
    'my-proxy-model.cacheWrite.1h',
    'my-proxy-model.cacheWrite.5m',
    'my-proxy-model.input',
    'my-proxy-model.output',
  ]);
});

test('overriddenKeysOf is empty without an overrides file', () => {
  assert.equal(overriddenKeysOf(null).size, 0);
  assert.equal(overriddenKeysOf({ v: 1 }).size, 0);
});

function readJson(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/prices/${name}`, import.meta.url), 'utf8'));
}

test('long-prompt tier rates get rows of their own', () => {
  const tiered = (input) => [{ id: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: { '5m': 5 }, tiers: [{ above: 200000, input, output: 30, cacheRead: 0.4, cacheWrite: { '5m': 10 } }] }];
  const withTier = buildCatalog([{ ...BUNDLED[0], tiers: [{ above: 200000, input: 8, output: 30, cacheRead: 0.4, cacheWrite: { '5m': 10 } }] }]);
  const { rows } = diffCatalog(withTier, { litellm: source(tiered(9)), modelsdev: source(tiered(9)) }, ['claude-opus-5-5']);
  const input = rowOf(rows, 'claude-opus-5-5.tier.200000.input');
  assert.deepEqual([input.current, input.litellm, input.modelsdev, input.status], [8, 9, 9, 'agree']);
  assert.equal(rowOf(rows, 'claude-opus-5-5.tier.200000.output').current, 30);
  assert.ok(rows.findIndex((r) => r.field.startsWith('tier.')) > rows.findIndex((r) => r.field === 'cacheWrite.5m'), 'tiers follow the base fields');
  // An overrides file that sets tiers owns them.
  const keys = overriddenKeysOf({ models: { 'claude-opus-5-5': { tiers: [{ above: 200000, input: 1, output: 1, cacheRead: 1 }] } } });
  assert.ok(keys.has('claude-opus-5-5.tier.200000.input'));
});
