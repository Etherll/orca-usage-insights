// Price book: keeps the catalog in use current. Sync reads the two public price files, diffs them
// against the catalog, and holds the diff in memory until the user applies rows from it. Applied rows
// go to the overlay file. The overrides file belongs to the user and is only read. This is the only
// src/ module that calls fetch.
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BUNDLED } from '../core/catalog-data.mjs';
import { buildCatalog, resolveModel } from '../core/catalog.mjs';
import { diffCatalog, overriddenKeysOf, proposalOf } from '../core/price-diff.mjs';
import { parseLiteLLM, parseModelsDev, today } from '../core/price-sources.mjs';
import { newestAsOf } from '../core/report.mjs';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELSDEV_URL = 'https://models.dev/api.json';
const USER_AGENT = 'usage-insights';
const OVERLAY_FILE = 'price-overlay-v1.json';
const OVERRIDES_FILE = 'price-overrides.json';
const WRITE = 'cacheWrite.';
// The sources in the order sync reports them. `key` is the diff row field each one fills.
const SOURCES = [
  { name: 'litellm', key: 'litellm', url: LITELLM_URL, parse: parseLiteLLM },
  { name: 'models.dev', key: 'modelsdev', url: MODELSDEV_URL, parse: parseModelsDev },
];
const NO_OVERRIDES = { stamp: 'none', file: null, data: null, models: 0, aliases: 0, problems: [] };

// Options: fs (readFile, writeFile, rename, unlink, mkdir, stat), fetch, dir (the cache directory;
// without it there is no overlay or overrides and writes fail), bundled, now, log, timeoutMs per
// source and maxBytes per reply. Returns { catalog, status, sync, preview, apply, undo, reset }.
export function createPriceBook({
  fs = nodeFs,
  fetch,
  dir,
  bundled = BUNDLED,
  now = () => new Date(),
  log = () => {},
  timeoutMs = 20_000,
  maxBytes = 16 << 20,
} = {}) {
  let overlayState = null; // { data } once the overlay is read or written
  let generation = 0; // bumps on every overlay change, so the catalog is rebuilt
  let overridesCache = null; // { stamp, state }
  let built = null; // { key, catalog }
  let latest = null; // { id, rows }: the last sync's diff

  // The catalog in effect. It is rebuilt only when the overlay or the overrides file changed; the
  // overrides file is stat'ed on every call, the overlay is kept in memory after its first read.
  async function current() {
    const gen = generation;
    const overlay = await loadOverlay();
    const overrides = await loadOverrides();
    const key = `${gen}|${overrides.stamp}`;
    if (built?.key !== key) {
      const catalog = buildCatalog(bundled, overlay, overrides.data);
      for (const problem of catalog.problems) log(`prices: ${problem}`);
      built = { key, catalog };
    }
    return { catalog: built.catalog, overlay, overrides };
  }

  async function loadOverlay() {
    if (overlayState === null) overlayState = { data: await readOverlay() };
    return overlayState.data;
  }

  function setOverlay(data) {
    overlayState = { data };
    generation += 1;
  }

  async function readOverlay() {
    if (dir === undefined) return null;
    const file = join(dir, OVERLAY_FILE);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`prices: overlay unreadable, ignored: ${describe(error)}`);
      return null;
    }
    const { data, problem } = parseFile(text, 'overlay');
    if (problem !== null) {
      log(`prices: ${problem}, ignored`);
      return null;
    }
    if (!isObject(data.entries)) {
      log('prices: overlay has no entries, ignored');
      return null;
    }
    return data;
  }

  async function loadOverrides() {
    if (dir === undefined) return NO_OVERRIDES;
    const file = join(dir, OVERRIDES_FILE);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') return NO_OVERRIDES;
      const reason = `overrides: unreadable (${describe(error)}), ignored`;
      return overridesOf(file, `unstatable:${reason}`, null, [reason]);
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (overridesCache?.stamp === stamp) return overridesCache.state;
    const state = await readOverrides(file, stamp);
    for (const problem of state.problems) log(`prices: ${problem}`);
    overridesCache = { stamp, state };
    return state;
  }

  async function readOverrides(file, stamp) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return NO_OVERRIDES;
      return overridesOf(file, stamp, null, [`overrides: unreadable (${describe(error)}), ignored`]);
    }
    const { data, problem } = parseFile(text, 'overrides');
    return overridesOf(file, stamp, data, problem === null ? [] : [`${problem}, ignored`]);
  }

  async function getJson(url) {
    if (typeof fetch !== 'function') throw new Error('fetch is not available');
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = response.headers?.get?.('content-length');
    if (declared && Number(declared) > maxBytes) throw oversize(maxBytes);
    const text = await readCapped(response, maxBytes);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('not JSON');
    }
    if (!isObject(json)) throw new Error('not a JSON object');
    return json;
  }

  // One source: its parsed adapter output, or the reason it failed. A source that parses to no
  // models counts as failed.
  async function pull(source) {
    let data = null;
    let error;
    try {
      data = source.parse(await getJson(source.url), { asOf: today(now()) });
      if (data.entries.length === 0) throw new Error('no models in the file');
    } catch (failure) {
      data = null;
      error = describe(failure);
      log(`prices: ${source.name} failed: ${error}`);
    }
    return { data, error, fetchedAt: now().toISOString() };
  }

  async function sync(inUseIds = []) {
    const state = await current();
    const pulled = await Promise.all(SOURCES.map((source) => pull(source)));
    const data = Object.fromEntries(SOURCES.map((source, i) => [source.key, pulled[i].data]));
    const inUse = inUseSet(inUseIds, state.catalog);
    const diff = diffCatalog(state.catalog, data, inUse, overriddenKeysOf(state.overrides.data));
    latest = { id: randomUUID(), rows: diff.rows };
    return {
      diffId: latest.id,
      sources: SOURCES.map((source, i) => {
        const { error, fetchedAt } = pulled[i];
        return {
          name: source.name,
          ok: error === undefined,
          ...(error === undefined ? {} : { error }),
          fetchedAt,
          rows: diff.rows.filter((row) => row[source.key] !== null).length,
        };
      }),
      rows: diff.rows,
      notInUse: diff.notInUse,
    };
  }

  // The catalog the rows would give, without writing anything. Rows already applied stay applied.
  async function preview(diffId, keys) {
    const diff = diffFor(diffId);
    const rows = chosenRows(diff, keys);
    const state = await current();
    return buildCatalog(bundled, overlayWith(state.overlay, rows, state.catalog, now()), state.overrides.data);
  }

  // Writes the chosen rows into the overlay. The overlay in effect is kept as `previous`, so one undo
  // restores it.
  async function apply(diffId, keys) {
    const diff = diffFor(diffId);
    const rows = chosenRows(diff, keys);
    const state = await current();
    const base = state.overlay;
    const next = overlayWith(base, rows, state.catalog, now());
    // Re-applying rows the overlay already holds changes nothing, so `previous` keeps the state before the first apply.
    if (JSON.stringify(next.entries) !== JSON.stringify(base?.entries ?? {})) {
      next.previous = base
        ? { appliedAt: base.appliedAt ?? null, sources: base.sources ?? [], entries: base.entries }
        : { appliedAt: null, sources: [], entries: {} };
      await writeOverlay(next);
      setOverlay(next);
    }
    return { ok: true, version: (await current()).catalog.version };
  }

  async function undo() {
    const state = await current();
    const previous = state.overlay?.previous;
    if (previous && typeof previous === 'object' && !Array.isArray(previous) && (previous.appliedAt === null || (previous.entries && typeof previous.entries === 'object'))) {
      if (previous.appliedAt === null) {
        await removeOverlay();
        setOverlay(null);
      } else {
        const restored = { v: 1, appliedAt: previous.appliedAt, sources: previous.sources, entries: previous.entries };
        await writeOverlay(restored);
        setOverlay(restored);
      }
    }
    return { ok: true, version: (await current()).catalog.version };
  }

  async function reset() {
    await removeOverlay();
    setOverlay(null);
    return { ok: true, version: (await current()).catalog.version };
  }

  async function status() {
    const { catalog, overlay, overrides } = await current();
    return {
      version: catalog.version,
      asOf: newestAsOf(catalog),
      overlay: overlay ? { appliedAt: overlay.appliedAt ?? null, sources: overlay.sources ?? [] } : null,
      canUndo: Boolean(overlay?.previous),
      overrides: overrides.file
        ? {
          file: overrides.file,
          models: overrides.models,
          aliases: overrides.aliases,
          problems: [...overrides.problems, ...catalog.problems.filter((problem) => problem.startsWith('overrides'))],
        }
        : null,
    };
  }

  function diffFor(diffId) {
    if (latest === null || latest.id !== diffId) throw coded('stale_diff', 'the price diff is out of date; sync again');
    return latest;
  }

  async function writeOverlay(data) {
    requireDir();
    await writeAtomic(join(dir, OVERLAY_FILE), `${JSON.stringify(data, null, 2)}\n`);
  }

  async function removeOverlay() {
    if (dir === undefined) return;
    try {
      await fs.unlink(join(dir, OVERLAY_FILE));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function requireDir() {
    if (dir === undefined) throw coded('no_cache_dir', 'no cache directory');
  }

  // Temp file, then rename, so a reader never sees half an overlay.
  async function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(tmp, text);
    try {
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  return {
    catalog: async () => (await current()).catalog,
    status,
    sync,
    preview,
    apply,
    undo,
    reset,
  };
}

function overridesOf(file, stamp, data, problems) {
  return { stamp, file, data, models: count(data?.models), aliases: count(data?.aliases), problems };
}

// Parses a versioned file. Anything but a JSON object with v 1 is ignored, with the reason returned.
function parseFile(text, label) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { data: null, problem: `${label}: not JSON` };
  }
  if (!isObject(json)) return { data: null, problem: `${label}: not a JSON object` };
  if (json.v !== 1) return { data: null, problem: `${label}: unsupported version ${JSON.stringify(json.v) ?? 'missing'}, expected 1` };
  return { data: json, problem: null };
}

// Overlay rows as a new overlay on top of `base`. Entries already in the overlay keep the fields these
// rows do not set. models.dev values are recorded with the 'manual' source, LiteLLM values with 'litellm'.
function overlayWith(base, rows, catalog, at) {
  const entries = structuredClone(base?.entries ?? {});
  const sources = new Set(base?.sources ?? []);
  for (const row of rows) {
    const { model, field, value, source } = proposalOf(row);
    const id = resolveModel(model, catalog)?.id ?? model;
    const patch = entries[id] ?? {};
    setRate(patch, field, value);
    patch.source = source === 'litellm' || patch.source === 'litellm' ? 'litellm' : 'manual';
    patch.asOf = today(at);
    entries[id] = patch;
    sources.add(source === 'litellm' ? 'litellm' : 'models.dev');
  }
  return { v: 1, appliedAt: at.toISOString(), sources: [...sources].sort(), entries };
}

function setRate(patch, field, value) {
  if (field.startsWith(WRITE)) patch.cacheWrite = { ...patch.cacheWrite, [field.slice(WRITE.length)]: value };
  else patch[field] = value;
}

// The rows for the keys. An overridden row is skipped, because the user's file already wins for it.
function chosenRows(diff, keys) {
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) {
    throw coded('invalid_params', 'keys must be an array of row keys');
  }
  const byKey = new Map(diff.rows.map((row) => [row.key, row]));
  const rows = [];
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) throw coded('invalid_params', `no price row ${key} in this diff`);
    if (row.status !== 'overridden') rows.push(row);
  }
  return rows;
}

// Model ids in use, with the catalog entry each one resolves to (an alias names its target).
function inUseSet(ids, catalog) {
  const out = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || id === '') continue;
    out.add(id);
    const entry = resolveModel(id, catalog);
    if (entry) out.add(entry.id);
  }
  return [...out];
}

// Reads a reply body, stopping as soon as it passes maxBytes.
async function readCapped(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw oversize(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function oversize(maxBytes) {
  return new Error(`reply over ${maxBytes} bytes`);
}

// The reason an error happened, in one line. A timeout says so; a failed fetch keeps its cause.
function describe(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out';
  const cause = error?.cause?.message;
  return cause ? `${error.message}: ${cause}` : String(error?.message ?? error);
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const count = (value) => (isObject(value) ? Object.keys(value).length : 0);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
