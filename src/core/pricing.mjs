// Anthropic first-party list prices as of 2026-10, USD per 1M tokens.
// Cache writes use the 5-minute TTL rate (1.25x input). Non-Claude models are unpriced.
// Order matters: the first matching entry wins.
export const PRICES = [
  { match: /fable-5-1|mythos-5-1/, input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: /fable-5|mythos-5/, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { match: /opus-5|opus-4-[5-9]/, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /opus-4|opus-3|3-opus/, input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /sonnet-5/, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: /sonnet-4|sonnet-3-7|3-7-sonnet|3-5-sonnet/, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku-5/, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { match: /haiku-4/, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: /haiku-3-5|3-5-haiku/, input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
];

// Returns the first PRICES entry matching a model name (lower-cased), or null when unpriced.
export function priceFor(model) {
  const name = String(model ?? '').toLowerCase();
  return PRICES.find((entry) => entry.match.test(name)) ?? null;
}

// Returns the estimated USD cost of one record, or null when its model has no price.
export function estimateCostUsd(record) {
  const price = priceFor(record.model);
  if (!price) return null;
  return (
    (record.input * price.input +
      record.output * price.output +
      record.cacheRead * price.cacheRead +
      record.cacheWrite * price.cacheWrite) /
    1e6
  );
}
