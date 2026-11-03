import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, estimateCostUsd, priceFor } from '../src/core/pricing.mjs';

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const entry = (source) => PRICES.find((e) => e.match.source === source);

// [model, [input, output, cacheRead, cacheWrite] USD per 1M]
const CASES = [
  ['claude-fable-5-1', [10, 50, 0.25, 12.5]],
  ['claude-mythos-5-1-20261001', [10, 50, 0.25, 12.5]],
  ['claude-fable-5', [10, 50, 1, 12.5]],
  ['claude-mythos-5', [10, 50, 1, 12.5]],
  ['claude-opus-5-5', [4, 20, 0.2, 5]],
  ['claude-opus-5', [5, 25, 0.5, 6.25]],
  ['claude-opus-4-5-20251101', [5, 25, 0.5, 6.25]],
  ['claude-opus-4-1', [15, 75, 1.5, 18.75]],
  ['claude-3-opus-20240229', [15, 75, 1.5, 18.75]],
  ['claude-sonnet-5', [2, 10, 0.2, 2.5]],
  ['claude-sonnet-4-5-20250929', [3, 15, 0.3, 3.75]],
  ['claude-3-7-sonnet-20250219', [3, 15, 0.3, 3.75]],
  ['claude-3-5-sonnet-20241022', [3, 15, 0.3, 3.75]],
  ['claude-haiku-5', [0.1, 0.5, 0.01, 0.125]],
  ['claude-haiku-4-5-20251001', [1, 5, 0.1, 1.25]],
  ['claude-3-5-haiku-20241022', [0.8, 4, 0.08, 1]],
];

function oneMillion(model, kind) {
  return { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [kind]: 1_000_000 };
}

for (const [model, rates] of CASES) {
  test(`${model} is priced by its family rates`, () => {
    KINDS.forEach((kind, i) => {
      assert.ok(
        Math.abs(estimateCostUsd(oneMillion(model, kind)) - rates[i]) < 1e-9,
        `${model} ${kind}`,
      );
    });
  });
}

test('PRICES order picks the most specific family first', () => {
  const idx = (model) => PRICES.findIndex((entry) => entry.match.test(model));
  assert.equal(idx('claude-fable-5-1'), 0);
  assert.equal(idx('claude-fable-5'), 1);
  assert.equal(idx('claude-opus-5-5'), 2);
  assert.equal(idx('claude-opus-5'), 3);
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
  assert.ok(Math.abs(estimateCostUsd(oneMillion('Claude-Haiku-5', 'input')) - 0.1) < 1e-9);
});

test('zero tokens on a priced model cost zero', () => {
  assert.equal(
    estimateCostUsd({ model: 'claude-haiku-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    0,
  );
});

test('unpriced models return null', () => {
  for (const model of ['gpt-5-codex', 'gpt-5.1-codex-mini', 'codex', 'unknown', '<synthetic>']) {
    assert.equal(
      estimateCostUsd({ model, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
      null,
      model,
    );
  }
});

test('priceFor returns the first matching entry, lower-cased, or null when unpriced', () => {
  assert.equal(priceFor('Claude-Haiku-5'), entry('haiku-5'));
  assert.equal(priceFor('claude-opus-5-5'), entry('opus-5-5'));
  assert.equal(priceFor('claude-opus-5'), entry('opus-5|opus-4-[5-9]'));
  assert.equal(priceFor('gpt-5-codex'), null);
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor(undefined), null);
});

test('estimateCostUsd prices through priceFor', () => {
  const model = 'claude-sonnet-5';
  const price = priceFor(model);
  assert.equal(
    estimateCostUsd({ model, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }),
    (2 * price.input + 3 * price.output + 4 * price.cacheRead + 5 * price.cacheWrite) / 1e6,
  );
});
