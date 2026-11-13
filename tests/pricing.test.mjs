import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED } from '../src/core/catalog-data.mjs';
import { buildCatalog } from '../src/core/catalog.mjs';
import { DEFAULT_CATALOG, estimateCostUsd, priceFor } from '../src/core/pricing.mjs';

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// [model, [input, output, cacheRead, cacheWrite] USD per 1M] at base rates; cacheWrite is the 5-minute rate.
const CASES = [
  ['claude-fable-5-1', [10, 50, 0.25, 12.5]],
  ['claude-mythos-5-1-20261001', [10, 50, 0.25, 12.5]],
  ['claude-fable-5', [10, 50, 1, 12.5]],
  ['claude-mythos-5', [10, 50, 1, 12.5]],
  ['claude-opus-5-5', [4, 20, 0.2, 5]],
  ['claude-opus-5', [5, 25, 0.5, 6.25]],
  ['claude-opus-4-5-20251101', [5, 25, 0.5, 6.25]],
  ['claude-sonnet-5', [2, 10, 0.2, 2.5]],
  ['claude-sonnet-5-5', [2, 10, 0.1, 2.5]],
  ['claude-sonnet-4-5-20250929', [3, 15, 0.3, 3.75]],
  ['claude-haiku-4-5-20251001', [1, 5, 0.1, 1.25]],
  ['claude-fable-5-2', [8, 40, 0.2, 10]],
  ['opencode-go/deepseek-v4.1-flash', [0.15, 0.6, 0.003, 0]],
  ['opencode/claude-opus-4-8', [5, 25, 0.5, 6.25]],
];

const OLD_IDS = [
  ['claude-fable-5-1', 'claude-fable-5-1'],
  ['claude-mythos-5-1-20261001', 'claude-mythos-5-1'],
  ['claude-fable-5', 'claude-fable-5'],
  ['claude-mythos-5', 'claude-mythos-5'],
  ['claude-opus-5-5', 'claude-opus-5-5'],
  ['claude-opus-5', 'claude-opus-5'],
  ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
  ['claude-opus-4-1', null],
  ['claude-3-opus-20240229', null],
  ['claude-sonnet-5', 'claude-sonnet-5'],
  ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
  ['claude-3-7-sonnet-20250219', null],
  ['claude-3-5-sonnet-20241022', null],
  ['claude-haiku-5', null],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
  ['claude-3-5-haiku-20241022', null],
  ['gpt-5-codex', null],
  ['gpt-5.1-codex-mini', null],
  ['codex', null],
  ['unknown', null],
  ['<synthetic>', null],
];

function oneMillion(model, kind) {
  return { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [kind]: 1_000_000 };
}

for (const [model, rates] of CASES) {
  test(`${model} is priced by its base rates`, () => {
    KINDS.forEach((kind, i) => {
      assert.ok(
        Math.abs(estimateCostUsd(oneMillion(model, kind)) - rates[i]) < 1e-9,
        `${model} ${kind}`,
      );
    });
  });
}

test('claude-haiku-5-5 base rates up to 100k, tier rates over 100k', () => {
  const base = [0.1, 0.5, 0.01, 0.125];
  const tier = [0.5, 2.5, 0.05, 0.625];
  KINDS.forEach((kind, i) => {
    const small = { model: 'claude-haiku-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [kind]: 99_999 };
    assert.ok(Math.abs(estimateCostUsd(small) - (99_999 * base[i]) / 1e6) < 1e-12, `base ${kind}`);
    // The band counts input, cache reads and writes, not output: the 100k+ input moves the request to the tier.
    const large = { model: 'claude-haiku-5-5', input: 100_001, output: 0, cacheRead: 0, cacheWrite: 0, [kind]: 1_000_000 };
    const extra = kind === 'input' ? 0 : (100_001 * tier[0]) / 1e6;
    assert.ok(Math.abs(estimateCostUsd(large) - (tier[i] + extra)) < 1e-9, `tier ${kind}`);
  });
  const boundary = { model: 'claude-haiku-5-5', input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.ok(Math.abs(estimateCostUsd(boundary) - 0.01) < 1e-12);
  const over = { model: 'claude-haiku-5-5', input: 100_001, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.ok(Math.abs(estimateCostUsd(over) - (100_001 * 0.5) / 1e6) < 1e-12);
});

test('claude-opus-5-5 1-hour cache writes are priced at the 1h rate', () => {
  const cost = estimateCostUsd({ model: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 });
  assert.ok(Math.abs(cost - 8) < 1e-9, String(cost));
});

test('a record without cacheWrite1h prices every cache write at the 5-minute rate', () => {
  const cost = estimateCostUsd({ model: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 });
  assert.ok(Math.abs(cost - 5) < 1e-9, String(cost));
});

test('OpenAI cache writes use the default rate, and a tier applies from 272k', () => {
  assert.ok(Math.abs(estimateCostUsd({ model: 'gpt-5.6', input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 }) - 0.5) < 1e-9);
  const tier = { model: 'gpt-5.6', input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.ok(Math.abs(estimateCostUsd(tier) - 2.4) < 1e-9, String(estimateCostUsd(tier)));
});

test('a model with no cache-write rates is unpriced when it has cache writes', () => {
  const catalog = buildCatalog([
    { id: 'no-write-model', provider: 'openai', input: 1, output: 1, cacheRead: 1, cacheWrite: null, source: 'manual', asOf: '2026-01-01' },
  ]);
  assert.equal(catalog.problems.length, 0);
  assert.equal(estimateCostUsd({ model: 'no-write-model', input: 0, output: 0, cacheRead: 0, cacheWrite: 1 }, catalog), null);
  assert.equal(estimateCostUsd({ model: 'no-write-model', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, catalog), 1);
});

test('mixed record costs every token kind at its own rate', () => {
  const cost = estimateCostUsd({
    model: 'claude-sonnet-4-5',
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 100,
  });
  assert.ok(Math.abs(cost - 0.011475) < 1e-12, String(cost));
});

test('model matching is case-insensitive', () => {
  assert.ok(Math.abs(estimateCostUsd(oneMillion('Claude-Haiku-5-5', 'input')) - 0.5) < 1e-9);
});

test('zero tokens on a priced model cost zero', () => {
  assert.equal(
    estimateCostUsd({ model: 'claude-haiku-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    0,
  );
});

test('unpriced models return null', () => {
  for (const model of ['gpt-5-codex', 'gpt-5.1-codex-mini', 'codex', 'unknown', '<synthetic>', undefined]) {
    assert.equal(
      estimateCostUsd({ model, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
      null,
      String(model),
    );
  }
});

test('every old model id resolves to its catalog entry or to null', () => {
  for (const [id, expected] of OLD_IDS) {
    const entry = priceFor(id);
    assert.equal(entry ? entry.id : null, expected, id);
  }
});

test('priceFor finds ids case-insensitively and returns null when unpriced', () => {
  assert.equal(priceFor('Claude-Haiku-5-5').id, 'claude-haiku-5-5');
  assert.equal(priceFor('claude-opus-5-5'), DEFAULT_CATALOG.entries.get('claude-opus-5-5'));
  assert.equal(priceFor('gpt-5-codex'), null);
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor(undefined), null);
});

test('DEFAULT_CATALOG is the bundled catalog', () => {
  assert.equal(DEFAULT_CATALOG.entries.size, BUNDLED.length);
  assert.equal(DEFAULT_CATALOG.problems.length, 0);
});

test('estimateCostUsd prices through priceFor', () => {
  const model = 'claude-sonnet-5';
  const price = priceFor(model);
  const expected = (2 * price.input + 3 * price.output + 4 * price.cacheRead + 5 * price.cacheWrite['5m']) / 1e6;
  assert.ok(Math.abs(estimateCostUsd({ model, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }) - expected) < 1e-15);
});

test('estimateCostUsd uses the catalog it is given', () => {
  const catalog = buildCatalog(BUNDLED, null, { models: { 'claude-opus-5-5': { input: 1 } } });
  assert.equal(estimateCostUsd(oneMillion('claude-opus-5-5', 'input'), catalog), 1);
  assert.equal(estimateCostUsd(oneMillion('claude-opus-5-5', 'input')), 4);
});
