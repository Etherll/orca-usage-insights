// Price catalog from three layers: the bundled LiteLLM snapshot, the overlay from Sync, and the user's
// overrides, which always win. Pure: no Node built-ins and no Orca imports.
import { PROMPT_BANDS, bandOf } from './bands.mjs';
import { normalizeModelId } from './price-sources.mjs';

export { PROMPT_BANDS, bandOf } from './bands.mjs';
export { normalizeModelId } from './price-sources.mjs';

const PROVIDERS = ['anthropic', 'openai', 'opencode', 'opencode-go'];
const SOURCES = ['litellm', 'manual', 'user'];
const ENTRY_FIELDS = ['provider', 'aliases', 'input', 'output', 'cacheRead', 'cacheWrite', 'tiers', 'contextWindow', 'source', 'asOf'];
const RATE_KEYS = ['input', 'output', 'cacheRead'];
const WRITE_KEYS = ['5m', '1h', 'default'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Exact id, then normalized id, then an alias. Families never match, so an unknown version stays unpriced.
const resolved = new WeakMap();
export function resolveModel(id, catalog) {
  let memo = resolved.get(catalog);
  if (memo === undefined) resolved.set(catalog, (memo = new Map()));
  let entry = memo.get(id);
  if (entry === undefined) {
    entry = lookupModel(id, catalog);
    if (memo.size < 10_000) memo.set(id, entry);
  }
  return entry;
}

function lookupModel(id, catalog) {
  const name = String(id ?? '').toLowerCase();
  if (!name) return null;
  const keys = [name, normalizeModelId(name)];
  for (const key of keys) {
    const entry = catalog.entries.get(key);
    if (entry) return entry;
  }
  for (const key of keys) {
    for (const entry of catalog.entries.values()) {
      if (entry.aliases.includes(key)) return entry;
    }
  }
  return null;
}

// `cacheWrite` counts every cache write and `cacheWrite1h` its 1-hour TTL part.
export function costOfTokens(entry, band, tokens = {}) {
  const rates = tierFor(entry, band);
  const write1h = num(tokens.cacheWrite1h);
  const write5m = tokens.cacheWrite5m === undefined
    ? Math.max(0, num(tokens.cacheWrite) - write1h)
    : num(tokens.cacheWrite5m);
  return linesCost(entry, rates, num(tokens.input), num(tokens.output), num(tokens.cacheRead), write5m, write1h);
}

export function requestCost(record, catalog) {
  const entry = resolveModel(record.model, catalog);
  if (!entry) return null;
  return entryCost(entry, record.input, record.output, record.cacheRead, record.cacheWrite, record.cacheWrite1h);
}

export function ratesFor(entry, input, cacheRead, cacheWrite) {
  return tierFor(entry, bandOf(num(input) + num(cacheRead) + num(cacheWrite)));
}

export function entryCost(entry, rawInput, rawOutput, rawCacheRead, rawCacheWrite, rawWrite1h) {
  const input = num(rawInput);
  const output = num(rawOutput);
  const cacheRead = num(rawCacheRead);
  const cacheWrite = num(rawCacheWrite);
  const write1h = num(rawWrite1h);
  const rates = tierFor(entry, bandOf(input + cacheRead + cacheWrite));
  return linesCost(entry, rates, input, output, cacheRead, Math.max(0, cacheWrite - write1h), write1h);
}

function linesCost(entry, rates, input, output, cacheRead, write5m, write1h) {
  let usd = 0;
  if (input !== 0) {
    if (!Number.isFinite(rates.input)) return null;
    usd += (input * rates.input) / 1e6;
  }
  if (output !== 0) {
    if (!Number.isFinite(rates.output)) return null;
    usd += (output * rates.output) / 1e6;
  }
  if (cacheRead !== 0) {
    if (!Number.isFinite(rates.cacheRead)) return null;
    usd += (cacheRead * rates.cacheRead) / 1e6;
  }
  const write = rates.cacheWrite;
  if (entry.provider !== 'anthropic') {
    const count = write5m + write1h;
    if (count !== 0) {
      const rate = write?.default;
      if (!Number.isFinite(rate)) return null;
      usd += (count * rate) / 1e6;
    }
    return usd;
  }
  if (write5m !== 0) {
    const rate = write?.['5m'] ?? write?.default;
    if (!Number.isFinite(rate)) return null;
    usd += (write5m * rate) / 1e6;
  }
  if (write1h !== 0) {
    const rate = write?.['1h'] ?? write?.default;
    if (!Number.isFinite(rate)) return null;
    usd += (write1h * rate) / 1e6;
  }
  return usd;
}

// Layers apply in order: bundled, overlay (per entry, skipped when its asOf is older), overrides. A bad
// entry, alias or layer is left out and named in `problems` as "<layer> <id>: ...". Never throws.
export function buildCatalog(bundled, overlay = null, overrides = null) {
  const entries = new Map();
  const problems = [];

  if (!Array.isArray(bundled)) {
    problems.push('bundled: not a list');
  } else {
    for (const raw of bundled) {
      if (!isObject(raw) || typeof raw.id !== 'string') {
        problems.push('bundled: entry without an id');
        continue;
      }
      const id = raw.id.toLowerCase();
      take('bundled', id, merge(baseEntry(id), raw, id), entries, problems);
    }
  }
  if (overlay !== null) applyOverlay(entries, overlay, problems);
  if (overrides !== null) applyOverrides(entries, overrides, problems);

  const sorted = new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { entries: sorted, version: versionOf(sorted), problems };
}

function applyOverlay(entries, overlay, problems) {
  if (!isObject(overlay) || !isObject(overlay.entries)) {
    problems.push('overlay: ignored');
    return;
  }
  for (const [rawId, patch] of Object.entries(overlay.entries)) {
    const id = rawId.toLowerCase();
    if (!isObject(patch)) {
      problems.push(`overlay ${id}: ignored`);
      continue;
    }
    if (!isDate(patch.asOf)) {
      problems.push(`overlay ${id}: invalid asOf`);
      continue;
    }
    const current = entries.get(id);
    if (current?.asOf && patch.asOf < current.asOf) continue;
    take('overlay', id, merge(current ?? baseEntry(id), patch, id), entries, problems);
  }
}

function applyOverrides(entries, overrides, problems) {
  if (!isObject(overrides)) {
    problems.push('overrides: ignored');
    return;
  }
  let fileAsOf = null;
  if (overrides.asOf !== undefined && overrides.asOf !== null) {
    if (isDate(overrides.asOf)) fileAsOf = overrides.asOf;
    else problems.push('overrides: invalid asOf');
  }

  const models = overrides.models ?? {};
  if (!isObject(models)) {
    problems.push('overrides models: ignored');
  } else {
    for (const [rawId, patch] of Object.entries(models)) {
      const id = rawId.toLowerCase();
      if (!isObject(patch)) {
        problems.push(`overrides ${id}: ignored`);
        continue;
      }
      const current = entries.get(id);
      const candidate = merge(current ?? baseEntry(id), patch, id);
      candidate.source = 'user';
      candidate.asOf = fileAsOf ?? current?.asOf ?? null;
      take('overrides', id, candidate, entries, problems);
    }
  }

  const aliases = overrides.aliases ?? {};
  if (!isObject(aliases)) {
    problems.push('overrides aliases: ignored');
    return;
  }
  for (const [rawFrom, rawTo] of Object.entries(aliases)) {
    const from = rawFrom.trim().toLowerCase();
    if (!from) {
      problems.push('overrides alias: empty name');
      continue;
    }
    const to = typeof rawTo === 'string' ? rawTo.trim().toLowerCase() : '';
    const target = entries.get(to);
    if (!target) {
      problems.push(`overrides alias ${from}: no such model`);
      continue;
    }
    if (!target.aliases.includes(from)) entries.set(to, { ...target, aliases: [...target.aliases, from] });
  }
}

function take(layer, id, candidate, entries, problems) {
  const bad = invalidFields(candidate);
  if (bad.length > 0) problems.push(`${layer} ${id}: invalid ${bad.join(', ')}`);
  else entries.set(id, finish(candidate));
}

function baseEntry(id) {
  const channel = /^(opencode-go|opencode)\//.exec(id)?.[1];
  return {
    id,
    provider: id.startsWith('claude-') ? 'anthropic' : channel ?? 'openai',
    aliases: [],
    cacheWrite: null,
    tiers: null,
    contextWindow: null,
    source: null,
    asOf: null,
  };
}

// Patch fields replace the entry's, except cacheWrite (merged one level) and undefined fields (skipped).
function merge(entry, patch, id) {
  const next = { ...entry, id };
  for (const key of ENTRY_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === 'cacheWrite' && isObject(value) && isObject(next.cacheWrite)) {
      next.cacheWrite = { ...next.cacheWrite, ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

function finish(entry) {
  return {
    ...entry,
    aliases: entry.aliases.map((alias) => alias.toLowerCase()),
    cacheWrite: entry.cacheWrite ? { ...entry.cacheWrite } : null,
    tiers: entry.tiers
      ? entry.tiers
        .map((tier) => ({ ...tier, cacheWrite: tier.cacheWrite ? { ...tier.cacheWrite } : null }))
        .sort((a, b) => a.above - b.above)
      : null,
  };
}

function invalidFields(entry) {
  const bad = [];
  if (!PROVIDERS.includes(entry.provider)) bad.push('provider');
  if (!Array.isArray(entry.aliases) || !entry.aliases.every(isName)) bad.push('aliases');
  for (const key of RATE_KEYS) if (!isRate(entry[key])) bad.push(key);
  if (!validWrite(entry.cacheWrite, entry.provider)) bad.push('cacheWrite');
  if (!validTiers(entry.tiers, entry.provider)) bad.push('tiers');
  if (entry.contextWindow !== null && !(Number.isInteger(entry.contextWindow) && entry.contextWindow >= 0)) {
    bad.push('contextWindow');
  }
  if (!SOURCES.includes(entry.source)) bad.push('source');
  if (entry.asOf !== null && !isDate(entry.asOf)) bad.push('asOf');
  return bad;
}

function validTiers(tiers, provider) {
  if (tiers === null) return true;
  if (!Array.isArray(tiers)) return false;
  const seen = new Set();
  return tiers.every((tier) => {
    if (!isObject(tier) || !PROMPT_BANDS.includes(tier.above) || seen.has(tier.above)) return false;
    seen.add(tier.above);
    return RATE_KEYS.every((key) => isRate(tier[key])) && validWrite(tier.cacheWrite, provider);
  });
}

// null (no cache-write rates) is valid; every provider except Anthropic must give a default rate.
function validWrite(write, provider) {
  if (write === null || write === undefined) return true;
  if (!isObject(write)) return false;
  const keys = Object.keys(write);
  if (keys.length === 0 || keys.some((key) => !WRITE_KEYS.includes(key))) return false;
  if (!keys.every((key) => isRate(write[key]))) return false;
  return provider === 'anthropic' || write.default !== undefined;
}

function tierFor(entry, band) {
  let best = null;
  for (const tier of entry.tiers ?? []) {
    if (tier.above <= band && (best === null || tier.above > best.above)) best = tier;
  }
  return best ?? entry;
}

function versionOf(entries) {
  const text = stableJson([...entries.values()]);
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const num = (value) => Number(value) || 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isName = (value) => typeof value === 'string' && value.length > 0;
const isDate = (value) => typeof value === 'string' && DATE.test(value);
