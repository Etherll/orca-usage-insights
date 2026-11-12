import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bundledSubset,
  inBundleScope,
  normalizeModelId,
  parseLiteLLM,
  parseModelsDev,
  today,
} from '../src/core/price-sources.mjs';

const litellm = JSON.parse(readFileSync(new URL('./fixtures/prices/litellm.json', import.meta.url), 'utf8'));
const modelsDev = JSON.parse(readFileSync(new URL('./fixtures/prices/modelsdev.json', import.meta.url), 'utf8'));
const ASOF = '2026-11-11';

const byId = (entries) => Object.fromEntries(entries.map((e) => [e.id, e]));
const rates = (e) => ({ input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite });

test('normalizeModelId strips provider prefixes, version and date suffixes', () => {
  assert.equal(normalizeModelId('anthropic/Claude-Opus-5-5'), 'claude-opus-5-5');
  assert.equal(normalizeModelId('us.anthropic.claude-haiku-5-5-v1:0'), 'claude-haiku-5-5');
  assert.equal(normalizeModelId('claude-sonnet-5-5@20260101'), 'claude-sonnet-5-5');
  assert.equal(normalizeModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('gpt-6-sol'), 'gpt-6-sol');
});

test('today formats the local calendar date as YYYY-MM-DD', () => {
  assert.equal(today(new Date(2026, 10, 1, 23, 59)), '2026-11-01');
});

test('parseLiteLLM converts per-token rates to per-1M and reads Anthropic 5m and 1h writes', () => {
  const { entries, errors } = parseLiteLLM(litellm, { asOf: ASOF });
  const m = byId(entries);
  // gpt-5.2 has no cache-write rate in the snapshot. It is out of bundle scope and is the fixture's error case.
  assert.deepEqual(errors, [{ id: 'gpt-5.2', provider: 'openai', reason: 'missing write' }]);

  assert.deepEqual(rates(m['claude-fable-5-2']), {
    input: 8,
    output: 40,
    cacheRead: 0.2,
    cacheWrite: { '5m': 10, '1h': 16 },
  });
  assert.deepEqual(rates(m['claude-opus-5-5']), {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: { '5m': 5, '1h': 8 },
  });
  assert.deepEqual(rates(m['claude-sonnet-5-5']), {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: { '5m': 2.5, '1h': 4 },
  });
  assert.deepEqual(m['claude-haiku-5-5'], {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    aliases: [],
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: { '5m': 0.125, '1h': 0.2 },
    tiers: [
      {
        above: 100000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite: { '5m': 0.625, '1h': 1 },
      },
    ],
    contextWindow: null,
    source: 'litellm',
    asOf: ASOF,
  });
});

test('parseLiteLLM reads OpenAI tiers at 272k with one default write rate', () => {
  const { entries } = parseLiteLLM(litellm, { asOf: ASOF });
  const m = byId(entries);
  assert.deepEqual(rates(m['gpt-6-sol']), { input: 2, output: 10, cacheRead: 0.2, cacheWrite: { default: 2.5 } });
  assert.deepEqual(m['gpt-6-sol'].tiers, [
    { above: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: { default: 5 } },
  ]);
  assert.deepEqual(rates(m['gpt-6-luna']), { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: { default: 0.125 } });
  assert.deepEqual(m['gpt-6-luna'].tiers, [
    { above: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: { default: 0.25 } },
  ]);
});

test('parseLiteLLM reads only the requested normalized ids and keys without a slash', () => {
  const { entries, errors } = parseLiteLLM(litellm, {
    ids: ['anthropic/Claude-Opus-5-5', 'gpt-6-sol'],
    asOf: ASOF,
  });
  assert.deepEqual(entries.map((e) => e.id), ['claude-opus-5-5', 'gpt-6-sol']);
  assert.deepEqual(errors, []);

  const slashed = parseLiteLLM({
    'openrouter/anthropic/claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 0.000001 },
  });
  assert.deepEqual(slashed.entries, []);
});

test('parseLiteLLM skips providers other than anthropic and openai', () => {
  const row = {
    litellm_provider: 'bedrock',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000005,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.00000125,
  };
  assert.deepEqual(parseLiteLLM({ 'claude-opus-5-5': row }), { entries: [], unknownFields: {}, errors: [] });
});

test('parseLiteLLM ignores batch, flex, priority, decisions and 12-hour fields and reports other cost fields', () => {
  const row = {
    litellm_provider: 'openai',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.0000012,
    input_cost_per_token_batches: 0.0000005,
    output_cost_per_token_flex: 0.000001,
    cache_read_input_token_cost_priority: 0.0000002,
    cache_creation_input_token_cost_decisions: 1,
    cache_creation_input_token_cost_above_12hr: 0.000003,
    cache_creation_input_token_cost_above_12hr_above_272k_tokens: 0.000006,
    cache_creation_input_token_cost_above_1hr: 0.000003,
    search_context_cost_per_query: 0.01,
    max_input_tokens: 1000,
  };
  const { entries, unknownFields, errors } = parseLiteLLM({ 'gpt-6-test': row }, { asOf: ASOF });
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].cacheWrite, { default: 1.2 });
  assert.deepEqual(entries[0].tiers, undefined);
  // An OpenAI 1-hour write is not a field this catalog has, so it is reported with the search fee.
  assert.deepEqual(unknownFields, {
    'gpt-6-test': ['cache_creation_input_token_cost_above_1hr', 'search_context_cost_per_query'],
  });
});

test('parseLiteLLM rounds rates to 6 decimals and writes Anthropic 5m only when no 1h rate exists', () => {
  const { entries } = parseLiteLLM({
    'claude-round': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 0.0000033333333,
      output_cost_per_token: 0.00000125,
      cache_read_input_token_cost: 1e-7,
      cache_creation_input_token_cost: 0.0000041666667,
    },
  }, { asOf: ASOF });
  assert.equal(entries[0].input, 3.333333);
  assert.equal(entries[0].cacheRead, 0.1);
  assert.deepEqual(entries[0].cacheWrite, { '5m': 4.166667 });
});

test('parseLiteLLM lists each fixture model with its search fee as an unknown field', () => {
  const { unknownFields } = parseLiteLLM(litellm, { asOf: ASOF });
  for (const id of ['claude-haiku-5-5', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-sol', 'gpt-6-luna']) {
    assert.deepEqual(unknownFields[id], ['search_context_cost_per_query'], id);
  }
});

test('parseLiteLLM sends a model with a bad or missing rate to errors and keeps the rest', () => {
  const good = {
    litellm_provider: 'anthropic',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000005,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.00000125,
  };
  const { entries, errors } = parseLiteLLM({
    'claude-neg': { ...good, input_cost_per_token: -0.000001 },
    'claude-str': { ...good, output_cost_per_token: '0.000005' },
    'claude-null': { ...good, cache_read_input_token_cost: null },
    'claude-gap': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000005,
      cache_read_input_token_cost: 0.0000001,
    },
    'claude-tier': {
      ...good,
      input_cost_per_token_above_100k_tokens: 0.000002,
      output_cost_per_token_above_100k_tokens: 0.00001,
      cache_creation_input_token_cost_above_100k_tokens: 0.0000025,
    },
    'claude-ok': good,
  }, { asOf: ASOF });
  assert.deepEqual(errors, [
    { id: 'claude-neg', provider: 'anthropic', reason: 'not a finite number >= 0: input_cost_per_token' },
    { id: 'claude-str', provider: 'anthropic', reason: 'not a finite number >= 0: output_cost_per_token' },
    { id: 'claude-null', provider: 'anthropic', reason: 'not a finite number >= 0: cache_read_input_token_cost' },
    { id: 'claude-gap', provider: 'anthropic', reason: 'missing write' },
    { id: 'claude-tier', provider: 'anthropic', reason: 'tier 100000 missing cacheRead' },
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['claude-ok']);
  assert.deepEqual(entries[0].cacheWrite, { '5m': 1.25 });
});

test('parseModelsDev reads per-1M rates and tiers with no 1-hour write', () => {
  const { entries, errors } = parseModelsDev(modelsDev, { asOf: ASOF });
  assert.deepEqual(errors, []);
  const m = byId(entries);
  assert.deepEqual(Object.keys(m).sort(), [
    'claude-fable-5-2',
    'claude-haiku-5-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-6-luna',
    'gpt-6-sol',
  ]);
  assert.deepEqual(m['claude-haiku-5-5'], {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    aliases: [],
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: { '5m': 0.125 },
    tiers: [
      { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: { '5m': 0.625 } },
    ],
    contextWindow: null,
    source: 'manual',
    asOf: ASOF,
  });
  assert.deepEqual(rates(m['gpt-6-sol']), { input: 2, output: 10, cacheRead: 0.2, cacheWrite: { default: 2.5 } });
  assert.deepEqual(m['gpt-6-sol'].tiers, [
    { above: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: { default: 5 } },
  ]);
});

test('parseModelsDev agrees with LiteLLM on the base rates of the same model', () => {
  const lite = byId(parseLiteLLM(litellm, { asOf: ASOF }).entries);
  const dev = byId(parseModelsDev(modelsDev, { asOf: ASOF }).entries);
  for (const id of ['claude-haiku-5-5', 'gpt-6-sol']) {
    assert.deepEqual(rates(dev[id]).input, rates(lite[id]).input, id);
    assert.deepEqual(rates(dev[id]).output, rates(lite[id]).output, id);
    assert.deepEqual(rates(dev[id]).cacheRead, rates(lite[id]).cacheRead, id);
  }
});

test('parseModelsDev honours ids and sends a bad, missing or incomplete cost to errors', () => {
  const only = parseModelsDev(modelsDev, { ids: ['Claude-Fable-5-2'], asOf: ASOF });
  assert.deepEqual(only.entries.map((e) => e.id), ['claude-fable-5-2']);

  const json = {
    anthropic: {
      models: {
        'claude-neg': { cost: { input: -1, output: 5, cache_read: 0.1, cache_write: 1 } },
        'claude-nocost': {},
        'claude-nowrite': { cost: { input: 1, output: 5, cache_read: 0.1 } },
        'claude-ok': { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
      },
    },
    openai: {
      models: {
        'gpt-6-str': { cost: { input: '2', output: 10, cache_read: 0.2, cache_write: 2.5 } },
      },
    },
  };
  const { entries, errors } = parseModelsDev(json, { asOf: ASOF });
  assert.deepEqual(errors, [
    { id: 'claude-neg', provider: 'anthropic', reason: 'not a finite number >= 0: cost.input' },
    { id: 'claude-nocost', provider: 'anthropic', reason: 'no cost' },
    { id: 'claude-nowrite', provider: 'anthropic', reason: 'missing write' },
    { id: 'gpt-6-str', provider: 'openai', reason: 'not a finite number >= 0: cost.input' },
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['claude-ok']);
  assert.deepEqual(entries[0].cacheWrite, { '5m': 1.25 });
});

test('inBundleScope admits every Anthropic model and only GPT-5.6 and GPT-6 OpenAI models', () => {
  assert.equal(inBundleScope({ id: 'claude-opus-5-5', provider: 'anthropic' }), true);
  assert.equal(inBundleScope({ id: 'gpt-5.6-sol', provider: 'openai' }), true);
  assert.equal(inBundleScope({ id: 'gpt-6.1-terra', provider: 'openai' }), true);
  assert.equal(inBundleScope({ id: 'gpt-5.2', provider: 'openai' }), false);
  assert.equal(inBundleScope({ id: 'gpt-4o', provider: 'openai' }), false);
});

test('bundledSubset of the LiteLLM fixture keeps the six trimmed bundle models', () => {
  const { entries } = parseLiteLLM(litellm, { asOf: ASOF });
  assert.deepEqual(bundledSubset(entries).map((e) => e.id), [
    'claude-fable-5-2',
    'claude-haiku-5-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-6-luna',
    'gpt-6-sol',
  ]);
});

test('bundledSubset drops a dated id whose undated id has equal rates and keeps the rest sorted', () => {
  const entry = (id, provider = 'anthropic', rate = 1) => ({
    id,
    provider,
    aliases: [],
    input: rate,
    output: 5 * rate,
    cacheRead: 0.1,
    cacheWrite: provider === 'anthropic' ? { '5m': 1.25 * rate } : { default: rate },
    contextWindow: null,
    source: 'litellm',
    asOf: ASOF,
  });
  const kept = bundledSubset([
    entry('claude-sonnet-5-5'),
    entry('claude-haiku-4-5-20251001'),
    entry('claude-haiku-4-5'),
    entry('claude-opus-4-6-20260205', 'anthropic', 5),
    entry('claude-opus-4-6', 'anthropic', 4),
    entry('claude-sonnet-4-5-20250929'),
    entry('gpt-6-sol', 'openai', 2),
    entry('gpt-6-sol-20260101', 'openai', 2),
    entry('gpt-5.2', 'openai', 2),
  ]);
  assert.deepEqual(kept.map((e) => e.id), [
    'claude-haiku-4-5',
    'claude-opus-4-6',
    'claude-opus-4-6-20260205',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-5-5',
    'gpt-6-sol',
  ]);
});
