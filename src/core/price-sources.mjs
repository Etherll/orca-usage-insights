// Price-source adapters. Each one turns a snapshot into catalog entries (USD per 1M tokens).
// Pure: the caller reads the files and passes the parsed JSON in.

const PROVIDERS = ['anthropic', 'openai'];
const PREFIX = /^(anthropic\/|openai\/|us\.anthropic\.|eu\.anthropic\.|anthropic\.)/;
const SUFFIX = /(\[1m\]|-v\d+:\d+|@\d{8}|-\d{8})$/;
const DATED = /^(.*)-\d{8}$/;
const TIER = /^(.*)_above_(\d+)k_tokens$/;
const IGNORED = /_(batches|flex|priority|ultrafast|decisions)$|_above_12hr/;
const REQUIRED = ['input', 'output', 'cacheRead', 'write'];
const COST = [
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache_read'],
  ['write', 'cache_write'],
];
const LITELLM_SLOTS = {
  input_cost_per_token: 'input',
  output_cost_per_token: 'output',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'write',
  cache_creation_input_token_cost_above_1hr: 'write1h',
};

export function normalizeModelId(id) {
  let s = String(id).toLowerCase().replace(PREFIX, '');
  let stripped;
  while ((stripped = s.replace(SUFFIX, '')) !== s) s = stripped;
  return s;
}

export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function inBundleScope(entry) {
  return entry.provider === 'anthropic' || (entry.provider === 'openai' && /^gpt-(5\.6|6)/.test(entry.id));
}

export function bundledSubset(entries) {
  const kept = entries.filter(inBundleScope);
  const byId = new Map(kept.map((e) => [e.id, e]));
  return kept
    .filter((e) => {
      const base = byId.get(DATED.exec(e.id)?.[1]);
      return !(base && signature(base) === signature(e));
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function parseLiteLLM(json, { ids, asOf = today(), source = 'litellm' } = {}) {
  const wanted = wantedSet(ids);
  const entries = [];
  const errors = [];
  const unknownFields = {};
  for (const [id, row] of Object.entries(json)) {
    if (id.includes('/') || !row || typeof row !== 'object') continue;
    const provider = row.litellm_provider;
    if (!PROVIDERS.includes(provider) || (wanted && !wanted.has(normalizeModelId(id)))) continue;
    const read = readLiteLLM(row, provider);
    if (read.unknown.length) unknownFields[id] = read.unknown;
    collect(build({ id, provider, ...read, source, asOf }), { id, provider }, entries, errors);
  }
  return { entries, unknownFields, errors };
}

// The 1-hour write rate is not in models.dev, so anthropic entries get a `5m` write only.
export function parseModelsDev(json, { ids, asOf = today(), source = 'manual' } = {}) {
  const wanted = wantedSet(ids);
  const entries = [];
  const errors = [];
  for (const provider of PROVIDERS) {
    for (const [id, model] of Object.entries(json?.[provider]?.models ?? {})) {
      if (wanted && !wanted.has(normalizeModelId(id))) continue;
      if (!model?.cost || typeof model.cost !== 'object') {
        errors.push({ id, provider, reason: 'no cost' });
        continue;
      }
      collect(build({ id, provider, ...readModelsDev(model.cost), source, asOf }), { id, provider }, entries, errors);
    }
  }
  return { entries, errors };
}

const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const wantedSet = (ids) => (ids ? new Set(ids.map(normalizeModelId)) : null);

// Values are per token; they come out per 1M, rounded to 6 decimals.
function readLiteLLM(row, provider) {
  const base = {};
  const tiers = new Map();
  const unknown = [];
  const invalid = [];
  for (const [field, value] of Object.entries(row)) {
    if (!field.includes('cost') || IGNORED.test(field)) continue;
    const tier = TIER.exec(field);
    const slot = LITELLM_SLOTS[tier ? tier[1] : field];
    if (!slot || (slot === 'write1h' && provider !== 'anthropic')) {
      unknown.push(field);
      continue;
    }
    if (!isRate(value)) {
      invalid.push(field);
      continue;
    }
    let target = base;
    if (tier) {
      const above = Number(tier[2]) * 1000;
      if (!tiers.has(above)) tiers.set(above, {});
      target = tiers.get(above);
    }
    target[slot] = round6(value * 1e6);
  }
  return { base, tiers: [...tiers], unknown, invalid };
}

function readModelsDev(cost) {
  const invalid = [];
  const pick = (src, prefix) => {
    const slots = {};
    for (const [slot, field] of COST) {
      const v = src[field];
      if (v === undefined) continue;
      if (isRate(v)) slots[slot] = v;
      else invalid.push(`${prefix}${field}`);
    }
    return slots;
  };
  const base = pick(cost, 'cost.');
  const tiers = (cost.tiers ?? []).map((t, i) => {
    const size = t.tier?.size;
    if (!isRate(size)) invalid.push(`cost.tiers[${i}].tier.size`);
    return [size, pick(t, `cost.tiers[${i}].`)];
  });
  return { base, tiers, invalid };
}

function build({ id, provider, base, tiers, invalid, source, asOf }) {
  if (invalid.length) return { error: `not a finite number >= 0: ${invalid.join(', ')}` };
  const gaps = (slots) => REQUIRED.filter((k) => slots[k] === undefined);
  const baseGaps = gaps(base);
  if (baseGaps.length) return { error: `missing ${baseGaps.join(', ')}` };
  const tierList = [];
  for (const [above, slots] of tiers) {
    const tierGaps = gaps(slots);
    if (tierGaps.length) return { error: `tier ${above} missing ${tierGaps.join(', ')}` };
    tierList.push({ above, ...rates(provider, slots) });
  }
  tierList.sort((a, b) => a.above - b.above);
  const entry = { id, provider, aliases: [], ...rates(provider, base) };
  if (tierList.length) entry.tiers = tierList;
  entry.contextWindow = null;
  entry.source = source;
  entry.asOf = asOf;
  return { entry };
}

// Anthropic writes split by TTL when a 1-hour rate is known; openai has one `default` write rate.
function rates(provider, slots) {
  let cacheWrite = { default: slots.write };
  if (provider === 'anthropic') {
    cacheWrite = slots.write1h === undefined ? { '5m': slots.write } : { '5m': slots.write, '1h': slots.write1h };
  }
  return { input: slots.input, output: slots.output, cacheRead: slots.cacheRead, cacheWrite };
}

function collect(result, { id, provider }, entries, errors) {
  if (result.error) errors.push({ id, provider, reason: result.error });
  else entries.push(result.entry);
}

function signature(e) {
  const writes = (c) => Object.keys(c).sort().map((k) => [k, c[k]]);
  const tiers = (e.tiers ?? []).map((t) => [t.above, t.input, t.output, t.cacheRead, writes(t.cacheWrite)]);
  return JSON.stringify([e.input, e.output, e.cacheRead, writes(e.cacheWrite), tiers]);
}
