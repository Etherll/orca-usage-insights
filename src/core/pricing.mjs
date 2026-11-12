import { BUNDLED } from './catalog-data.mjs';
import { buildCatalog, entryCost, requestCost, resolveModel } from './catalog.mjs';

export const DEFAULT_CATALOG = buildCatalog(BUNDLED);

export function priceFor(model, catalog = DEFAULT_CATALOG) {
  return resolveModel(model, catalog);
}

export function estimateCostUsd(record, catalog = DEFAULT_CATALOG) {
  return requestCost(record, catalog);
}

// `costs[i]` in USD, NaN when unpriced; `entries[id + 1]` the entry (or null) per model id. A finished
// table keeps the answer for its latest catalog.
const tableMemo = new WeakMap();
export function tableCosts(table, catalog = DEFAULT_CATALOG) {
  const memo = table.frozen ? tableMemo.get(table) : undefined;
  if (memo?.catalog === catalog) return memo.priced;
  const { names, length, model, input, output, cacheRead, cacheWrite, cacheWrite1h } = table;
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
