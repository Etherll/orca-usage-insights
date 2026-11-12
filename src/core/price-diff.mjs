// Compares the catalog in use with the two price sources, field by field. Pure: the caller reads
// and parses the sources (price-sources.mjs) and passes the entries in.
import { normalizeModelId, resolveModel } from './catalog.mjs';

// The priced fields, in the order rows list them. Cache writes are split by TTL as in the catalog.
// A long-prompt tier's rates follow as `tier.<above>.<field>`, one set per tier a source lists.
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite.5m', 'cacheWrite.1h', 'cacheWrite.default'];
const WRITE = 'cacheWrite.';
const TIER = /^tier\.(\d+)\.(.+)$/;
const RATE_KEYS = ['input', 'output', 'cacheRead'];
const AGREE_EPSILON = 1e-9;
const CHANGE_RATIO = 10;

// Rows for the models in use. `litellm` and `modelsdev` are { entries, unknownFields? } as the
// adapters return them, or null when that source was not read. Models the sources list but that are
// not in use are counted in notInUse and not listed.
export function diffCatalog(catalog, { litellm = null, modelsdev = null } = {}, inUseIds = [], overriddenKeys = []) {
  const inUse = new Set([...inUseIds].map((id) => normalizeModelId(String(id))).filter(Boolean));
  const overridden = new Set(overriddenKeys);
  // Only an unknown per-token price can change what a request costs; per-query or per-image fees
  // (e.g. search_context_cost_per_query) don't apply to transcript tokens, so they don't flag.
  const unknown = new Set(
    Object.entries(litellm?.unknownFields ?? {})
      .filter(([, fields]) => (fields ?? []).some((field) => /token/i.test(field)))
      .map(([id]) => normalizeModelId(id)),
  );
  const fromLitellm = byModel(litellm?.entries ?? []);
  const fromModelsDev = byModel(modelsdev?.entries ?? []);
  const inCatalog = byModel([...catalog.entries.values()]);
  const models = [...new Set([...fromLitellm.keys(), ...fromModelsDev.keys()])].sort();

  const rows = [];
  let notInUse = 0;
  for (const model of models) {
    if (!inUse.has(model)) {
      notInUse++;
      continue;
    }
    const entry = inCatalog.get(model) ?? resolveModel(model, catalog);
    for (const field of fieldsOf(fromLitellm.get(model), fromModelsDev.get(model))) {
      const litellmValue = valueOf(fromLitellm.get(model), field);
      const modelsdevValue = valueOf(fromModelsDev.get(model), field);
      if (litellmValue === undefined && modelsdevValue === undefined) continue;
      const currentValue = valueOf(entry, field);
      const values = [litellmValue, modelsdevValue].filter((value) => value !== undefined);
      const key = `${model}.${field}`;
      const status = statusOf({ key, model, values, currentValue, inCatalog: Boolean(entry), unknown, overridden });
      rows.push({
        key,
        model,
        field,
        current: currentValue ?? null,
        litellm: litellmValue ?? null,
        modelsdev: modelsdevValue ?? null,
        status,
        ticked: status === 'agree',
      });
    }
  }
  return { rows, notInUse };
}

// The keys (`<model>.<field>`) the user's overrides file sets, so the diff can mark them overridden.
export function overriddenKeysOf(overrides) {
  const keys = new Set();
  if (!isObject(overrides?.models)) return keys;
  for (const [id, patch] of Object.entries(overrides.models)) {
    if (!isObject(patch)) continue;
    const model = normalizeModelId(id);
    for (const field of RATE_KEYS) {
      if (patch[field] !== undefined) keys.add(`${model}.${field}`);
    }
    if (isObject(patch.cacheWrite)) {
      for (const kind of Object.keys(patch.cacheWrite)) keys.add(`${model}.${WRITE}${kind}`);
    }
    // An overrides file that sets tiers replaces them all.
    if (Array.isArray(patch.tiers)) {
      for (const tier of patch.tiers) {
        if (!isObject(tier)) continue;
        for (const field of FIELDS) keys.add(`${model}.tier.${tier.above}.${field}`);
      }
    }
  }
  return keys;
}

// The value a row proposes: LiteLLM's when it has one, else models.dev's. The source is the overlay
// source name for it: 'litellm', or 'manual' for models.dev.
export function proposalOf(row) {
  const fromLitellm = typeof row.litellm === 'number';
  return {
    model: row.model,
    field: row.field,
    value: fromLitellm ? row.litellm : row.modelsdev,
    source: fromLitellm ? 'litellm' : 'manual',
  };
}

// Overridden wins; then flagged; then a model the catalog lacks is new; then the sources decide.
function statusOf({ key, model, values, currentValue, inCatalog, unknown, overridden }) {
  if (overridden.has(key)) return 'overridden';
  if (unknown.has(model) || suspicious(values, currentValue)) return 'flagged';
  if (!inCatalog) return 'new';
  if (values.length === 2) return Math.abs(values[0] - values[1]) <= AGREE_EPSILON ? 'agree' : 'disagree';
  return 'single';
}

// A zero price where anything is paid, or a proposed price 10x away from the current one (or any
// price where the current one is zero).
function suspicious(values, currentValue) {
  if (values.includes(0) && [...values, currentValue].some((value) => value > 0)) return true;
  if (typeof currentValue !== 'number') return false;
  return values.some((value) => (currentValue === 0
    ? value > 0
    : value >= currentValue * CHANGE_RATIO || value <= currentValue / CHANGE_RATIO));
}

// The base fields, then each tier's fields, for the tiers either source lists (by size).
function fieldsOf(...entries) {
  const sizes = new Set();
  for (const entry of entries) for (const tier of entry?.tiers ?? []) if (Number.isFinite(tier?.above)) sizes.add(tier.above);
  return [...FIELDS, ...[...sizes].sort((a, b) => a - b).flatMap((above) => FIELDS.map((field) => `tier.${above}.${field}`))];
}

function valueOf(entry, field) {
  if (!entry) return undefined;
  const tier = TIER.exec(field);
  if (tier) return valueOf(entry.tiers?.find((t) => t?.above === Number(tier[1])), tier[2]);
  const value = field.startsWith(WRITE) ? entry.cacheWrite?.[field.slice(WRITE.length)] : entry[field];
  return typeof value === 'number' ? value : undefined;
}

// One entry per normalized model id. An entry whose id is already the normalized id wins over a
// dated or prefixed one.
function byModel(entries) {
  const map = new Map();
  for (const entry of entries) {
    const id = String(entry.id);
    const model = normalizeModelId(id);
    if (!map.has(model) || id.toLowerCase() === model) map.set(model, entry);
  }
  return map;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
