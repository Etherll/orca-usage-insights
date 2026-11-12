// Prices for usage records and model ids, read from a catalog. The default catalog is the one
// bundled with the plugin; pass another catalog (built with buildCatalog) to price against it.
import { BUNDLED } from './catalog-data.mjs';
import { buildCatalog, entryCost, requestCost, resolveModel } from './catalog.mjs';

export const DEFAULT_CATALOG = buildCatalog(BUNDLED);

// The catalog entry a model name resolves to, or null when it is unpriced.
export function priceFor(model, catalog = DEFAULT_CATALOG) {
  return resolveModel(model, catalog);
}

// The estimated USD cost of one record, or null when its model has no price.
export function estimateCostUsd(record, catalog = DEFAULT_CATALOG) {
  return requestCost(record, catalog);
}

// Every row's cost in a RecordTable: `costs[i]` in USD, NaN when unpriced, and `entries[id + 1]`
// the catalog entry (or null) for each model id a row uses. A finished table (one merge or a conversion made)
// keeps the answer for its latest catalog, so other ranges and filters reuse it.
const tableMemo = new WeakMap(); // table -> { catalog, priced }
export function tableCosts(table, catalog = DEFAULT_CATALOG) {
  const memo = table.frozen ? tableMemo.get(table) : undefined;
  if (memo?.catalog === catalog) return memo.priced;
  const { names, length, model, input, output, cacheRead, cacheWrite, cacheWrite1h } = table;
  // Resolved for the model ids rows use (the dictionary also holds paths, sessions and the rest).
  const entries = new Array(names.length + 1);
  const costs = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const m = model[i] + 1;
    let entry = entries[m];
    if (entry === undefined) entry = entries[m] = resolveModel(m === 0 ? undefined : names[m - 1], catalog);
    const usd = entry ? entryCost(entry, input[i], output[i], cacheRead[i], cacheWrite[i], cacheWrite1h[i]) : null;
    costs[i] = usd === null ? NaN : usd;
  }
  const priced = { costs, entries };
  if (table.frozen) tableMemo.set(table, { catalog, priced });
  return priced;
}
