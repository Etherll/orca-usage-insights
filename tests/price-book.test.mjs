import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPriceBook } from '../src/node/price-book.mjs';
import { today } from '../src/core/price-sources.mjs';

const DIR = '/cache/usage-insights';
const OVERLAY = join(DIR, 'price-overlay-v1.json');
const OVERRIDES = join(DIR, 'price-overrides.json');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELSDEV_URL = 'https://models.dev/api.json';
const NOW = new Date('2026-11-11T12:00:00Z');
const OPUS = 'claude-opus-5-5';
const RATES = { input: 4, output: 20, cacheRead: 0.2, write: 5, write1h: 8 };
const BUNDLED = [
  { id: OPUS, provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: { '5m': 5, '1h': 8 }, source: 'litellm', asOf: '2026-10-01' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: { '5m': 3.75 }, source: 'litellm', asOf: '2026-10-01' },
];

// Raw bodies as the files have them: LiteLLM rows are per token, models.dev rows per 1M.
function litellmBody(models) {
  return Object.fromEntries(Object.entries(models).map(([id, r]) => [id, {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: r.input / 1e6,
    output_cost_per_token: r.output / 1e6,
    cache_read_input_token_cost: r.cacheRead / 1e6,
    cache_creation_input_token_cost: r.write / 1e6,
    ...(r.write1h === undefined ? {} : { cache_creation_input_token_cost_above_1hr: r.write1h / 1e6 }),
  }]));
}

function modelsDevBody(models) {
  const list = Object.entries(models).map(([id, r]) => [id, {
    cost: { input: r.input, output: r.output, cache_read: r.cacheRead, cache_write: r.write },
  }]);
  return { anthropic: { models: Object.fromEntries(list) } };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const ok = (body) => () => json(body);
const reply = (status, body, headers = {}) => () => new Response(body, { status, headers });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
const refused = () => {
  throw new TypeError('fetch failed', { cause: new Error('redirect mode is set to error') });
};
const streamed = (text) => () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  },
}), { status: 200 });

function sources({
  litellm = ok(litellmBody({ [OPUS]: RATES })),
  modelsdev = ok(modelsDevBody({ [OPUS]: RATES })),
} = {}) {
  return { [LITELLM_URL]: litellm, [MODELSDEV_URL]: modelsdev };
}

function live(rates) {
  return sources({
    litellm: () => json(litellmBody(rates)),
    modelsdev: () => json(modelsDevBody(rates)),
  });
}

function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = replies[url];
    if (answer === undefined) throw new Error(`no reply set for ${url}`);
    return answer(init);
  };
  return Object.assign(fetch, { calls });
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, { text, mtimeMs: 1 }]));
  const ops = [];
  let clock = 1;
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    ops,
    async readFile(path) {
      ops.push(['readFile', path]);
      const file = files.get(path);
      if (!file) throw missing(path);
      return file.text;
    },
    async writeFile(path, text) {
      ops.push(['writeFile', path]);
      clock += 1;
      files.set(path, { text, mtimeMs: clock });
    },
    async rename(from, to) {
      ops.push(['rename', from, to]);
      const file = files.get(from);
      if (!file) throw missing(from);
      files.delete(from);
      files.set(to, file);
    },
    async unlink(path) {
      ops.push(['unlink', path]);
      if (!files.delete(path)) throw missing(path);
    },
    async mkdir(path) {
      ops.push(['mkdir', path]);
    },
    async stat(path) {
      ops.push(['stat', path]);
      const file = files.get(path);
      if (!file) throw missing(path);
      return { mtimeMs: file.mtimeMs, size: Buffer.byteLength(file.text) };
    },
  };
}

function book({ files = {}, replies = sources(), ...options } = {}) {
  const fs = memoryFs(files);
  const fetch = fakeFetch(replies);
  const logs = [];
  const priceBook = createPriceBook({
    fs,
    fetch,
    dir: DIR,
    bundled: BUNDLED,
    now: () => NOW,
    log: (line) => logs.push(line),
    timeoutMs: 25,
    maxBytes: 4096,
    ...options,
  });
  return { priceBook, fs, fetch, logs };
}

const rowOf = (rows, key) => rows.find((row) => row.key === key);
const keysTicked = (rows) => rows.filter((row) => row.ticked).map((row) => row.key).sort();
const written = (fs) => fs.ops.filter(([kind]) => ['writeFile', 'rename', 'unlink'].includes(kind));

test('sync reads both sources with the usage-insights agent and no query string, and ticks what they agree on', async () => {
  const { priceBook, fetch } = book();
  const result = await priceBook.sync([OPUS]);
  assert.match(result.diffId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fetch.calls.map((call) => call.url).sort(), [LITELLM_URL, MODELSDEV_URL].sort());
  for (const { init } of fetch.calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['User-Agent'], 'usage-insights');
  }
  assert.deepEqual(keysTicked(result.rows), [`${OPUS}.cacheRead`, `${OPUS}.cacheWrite.5m`, `${OPUS}.input`, `${OPUS}.output`]);
  assert.equal(rowOf(result.rows, `${OPUS}.cacheWrite.1h`).status, 'single');
  assert.deepEqual(result.sources, [
    { name: 'litellm', ok: true, fetchedAt: NOW.toISOString(), rows: 5 },
    { name: 'models.dev', ok: true, fetchedAt: NOW.toISOString(), rows: 4 },
  ]);
  assert.equal(result.notInUse, 0);
});

test('models the sources list that the user does not use are counted, not listed', async () => {
  const { priceBook } = book();
  const result = await priceBook.sync(['claude-sonnet-5-5']);
  assert.deepEqual(result.rows, []);
  assert.equal(result.notInUse, 1);
});

test('when one source fails its error is reported and nothing is pre-ticked', async () => {
  const { priceBook, logs } = book({ replies: sources({ litellm: reply(404, 'missing') }) });
  const result = await priceBook.sync([OPUS]);
  assert.deepEqual(result.sources[0], { name: 'litellm', ok: false, error: 'HTTP 404', fetchedAt: NOW.toISOString(), rows: 0 });
  assert.equal(result.sources[1].ok, true);
  assert.ok(result.rows.length > 0);
  assert.deepEqual(keysTicked(result.rows), []);
  assert.deepEqual(logs, ['prices: litellm failed: HTTP 404']);
});

test('a source that does not answer in time is reported as timed out', async () => {
  const { priceBook } = book({ replies: sources({ modelsdev: hang }) });
  const result = await priceBook.sync([OPUS]);
  assert.equal(result.sources[1].ok, false);
  assert.equal(result.sources[1].error, 'timed out');
  assert.equal(result.sources[0].ok, true);
});

test('an HTML page where the file should be is a failed source', async () => {
  const { priceBook } = book({ replies: sources({ litellm: reply(200, '<!doctype html><html></html>') }) });
  const result = await priceBook.sync([OPUS]);
  assert.equal(result.sources[0].error, 'not JSON');
});

test('a file with no models in it is a failed source', async () => {
  const { priceBook } = book({ replies: sources({ litellm: ok({}) }) });
  const result = await priceBook.sync([OPUS]);
  assert.equal(result.sources[0].error, 'no models in the file');
});

test('a redirect is refused and reported as a failed source', async () => {
  const { priceBook } = book({ replies: sources({ litellm: refused }) });
  const result = await priceBook.sync([OPUS]);
  assert.equal(result.sources[0].ok, false);
  assert.match(result.sources[0].error, /redirect/);
});

test('a reply over the size cap is refused, whether it declares its size or streams past it', async () => {
  const declared = book({ maxBytes: 300, replies: sources({ litellm: reply(200, '{}', { 'content-length': '100000' }) }) });
  assert.equal((await declared.priceBook.sync([OPUS])).sources[0].error, 'reply over 300 bytes');
  const streams = book({ maxBytes: 300, replies: sources({ litellm: streamed(JSON.stringify({ a: 'x'.repeat(400) })) }) });
  assert.equal((await streams.priceBook.sync([OPUS])).sources[0].error, 'reply over 300 bytes');
});

test('sources that disagree are not ticked', async () => {
  const { priceBook } = book({ replies: sources({ modelsdev: ok(modelsDevBody({ [OPUS]: { ...RATES, input: 5 } })) }) });
  const result = await priceBook.sync([OPUS]);
  const input = rowOf(result.rows, `${OPUS}.input`);
  assert.equal(input.status, 'disagree');
  assert.equal(input.ticked, false);
  assert.equal(input.litellm, 4);
  assert.equal(input.modelsdev, 5);
});

test('a rate a thousand times the other source is flagged and not ticked (unit mismatch)', async () => {
  const { priceBook } = book({ replies: sources({ litellm: ok(litellmBody({ [OPUS]: { ...RATES, input: 4000 } })) }) });
  const result = await priceBook.sync([OPUS]);
  const input = rowOf(result.rows, `${OPUS}.input`);
  assert.equal(input.status, 'flagged');
  assert.equal(input.ticked, false);
});

test('with no overlay and no overrides file the status is the bundled catalog', async () => {
  const { priceBook } = book();
  const status = await priceBook.status();
  assert.equal(status.version, (await priceBook.catalog()).version);
  assert.equal(status.asOf, '2026-10-01');
  assert.deepEqual({ overlay: status.overlay, canUndo: status.canUndo, overrides: status.overrides }, { overlay: null, canUndo: false, overrides: null });
});

test('an overrides file wins over the sources and marks its rows overridden', async () => {
  const files = { [OVERRIDES]: JSON.stringify({ v: 1, models: { [OPUS]: { output: 18 } } }) };
  const { priceBook } = book({ files });
  assert.deepEqual((await priceBook.status()).overrides, { file: OVERRIDES, models: 1, aliases: 0, problems: [] });
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 18);
  const result = await priceBook.sync([OPUS]);
  const output = rowOf(result.rows, `${OPUS}.output`);
  assert.equal(output.status, 'overridden');
  assert.equal(output.ticked, false);
  assert.equal(output.current, 18);
});

test('an edited overrides file is read again once its stamp changes', async () => {
  const { priceBook, fs } = book({ files: { [OVERRIDES]: JSON.stringify({ v: 1, models: { [OPUS]: { output: 18 } } }) } });
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 18);
  await fs.writeFile(OVERRIDES, JSON.stringify({ v: 1, models: { [OPUS]: { output: 22 } } }));
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 22);
});

test('a broken overrides file is ignored, logged and listed in the status', async () => {
  const cases = [
    ['{ nope', 'overrides: not JSON, ignored'],
    [JSON.stringify({ v: 2, models: { [OPUS]: { output: 18 } } }), 'overrides: unsupported version 2, expected 1, ignored'],
    [JSON.stringify({ models: { [OPUS]: { output: 18 } } }), 'overrides: unsupported version missing, expected 1, ignored'],
  ];
  for (const [text, problem] of cases) {
    const { priceBook, logs } = book({ files: { [OVERRIDES]: text } });
    assert.deepEqual((await priceBook.status()).overrides.problems, [problem]);
    assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
    assert.ok(logs.includes(`prices: ${problem}`), `logged: ${problem}`);
  }
});

test('an overlay file that is not usable is ignored with a log line', async () => {
  const cases = [
    ['{ nope', 'prices: overlay: not JSON, ignored'],
    [JSON.stringify({ v: 1 }), 'prices: overlay has no entries, ignored'],
  ];
  for (const [text, line] of cases) {
    const { priceBook, logs } = book({ files: { [OVERLAY]: text } });
    assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
    assert.equal((await priceBook.status()).overlay, null);
    assert.ok(logs.includes(line), `logged: ${line}`);
  }
});

test('apply writes the overlay through a temp file and a rename, and reports the catalog version', async () => {
  const { priceBook, fs } = book({ replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  const keys = keysTicked(sync.rows);
  const result = await priceBook.apply(sync.diffId, keys);
  const tmp = `${OVERLAY}.${process.pid}.tmp`;
  assert.deepEqual(written(fs), [['writeFile', tmp], ['rename', tmp, OVERLAY]]);
  assert.equal(fs.files.has(tmp), false);
  const overlay = JSON.parse(fs.files.get(OVERLAY).text);
  assert.equal(overlay.v, 1);
  assert.equal(overlay.appliedAt, NOW.toISOString());
  assert.deepEqual(overlay.sources, ['litellm']);
  assert.deepEqual(overlay.entries[OPUS], {
    input: 4,
    output: 22,
    cacheRead: 0.2,
    cacheWrite: { '5m': 5 },
    source: 'litellm',
    asOf: today(NOW),
  });
  const status = await priceBook.status();
  assert.deepEqual(result, { ok: true, version: status.version });
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 22);
  assert.deepEqual(status.overlay, { appliedAt: NOW.toISOString(), sources: ['litellm'] });
  assert.equal(status.canUndo, true);
});

test('preview returns the catalog the rows would give and writes nothing', async () => {
  const { priceBook, fs } = book({ replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  const preview = await priceBook.preview(sync.diffId, keysTicked(sync.rows));
  assert.equal(preview.entries.get(OPUS).output, 22);
  assert.equal(written(fs).length, 0);
  assert.equal(fs.files.has(OVERLAY), false);
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
});

test('undo after the first apply removes the overlay, and a second undo does nothing', async () => {
  const { priceBook, fs } = book({ replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  await priceBook.apply(sync.diffId, keysTicked(sync.rows));
  const result = await priceBook.undo();
  assert.equal(fs.files.has(OVERLAY), false);
  assert.deepEqual(result, { ok: true, version: (await priceBook.status()).version });
  const status = await priceBook.status();
  assert.equal(status.overlay, null);
  assert.equal(status.canUndo, false);
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
  await priceBook.undo();
  assert.equal(fs.files.has(OVERLAY), false);
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
});

test('a second apply keeps one undo step back to the overlay before it', async () => {
  const rates = { [OPUS]: { ...RATES, output: 22 } };
  const { priceBook } = book({ replies: live(rates) });
  const first = await priceBook.sync([OPUS]);
  await priceBook.apply(first.diffId, keysTicked(first.rows));

  rates[OPUS] = { ...RATES, input: 3.5, output: 22 };
  const second = await priceBook.sync([OPUS]);
  await priceBook.apply(second.diffId, keysTicked(second.rows));
  assert.equal((await priceBook.catalog()).entries.get(OPUS).input, 3.5);

  await priceBook.undo();
  const catalog = await priceBook.catalog();
  assert.equal(catalog.entries.get(OPUS).input, 4);
  assert.equal(catalog.entries.get(OPUS).output, 22);
  assert.equal((await priceBook.status()).canUndo, false);
});

test('overlapping applies both land: each starts from the overlay the one before wrote', async () => {
  const SONNET = 'claude-sonnet-5-5';
  const { priceBook, fs } = book({
    replies: live({ [OPUS]: { ...RATES, output: 22 }, [SONNET]: { input: 3, output: 16, cacheRead: 0.3, write: 3.75 } }),
  });
  const sync = await priceBook.sync([OPUS, SONNET]);
  const keys = keysTicked(sync.rows);
  const forModel = (id) => keys.filter((key) => key.includes(id));
  assert.ok(forModel(OPUS).length > 0 && forModel(SONNET).length > 0);
  await Promise.all([priceBook.apply(sync.diffId, forModel(OPUS)), priceBook.apply(sync.diffId, forModel(SONNET))]);
  const overlay = JSON.parse(fs.files.get(OVERLAY).text);
  assert.deepEqual(Object.keys(overlay.entries).sort(), [OPUS, SONNET]);
  const catalog = await priceBook.catalog();
  assert.equal(catalog.entries.get(OPUS).output, 22);
  assert.equal(catalog.entries.get(SONNET).output, 16);
  await priceBook.undo();
  assert.equal(Object.keys(JSON.parse(fs.files.get(OVERLAY).text).entries).length, 1);
});

test('a sync applies a changed long-prompt tier rate, and a tier the catalog lacks starts complete', async () => {
  const tierBody = (above, input) => ({
    [OPUS]: {
      ...litellmBody({ [OPUS]: RATES })[OPUS],
      [`input_cost_per_token_above_${above / 1000}k_tokens`]: input / 1e6,
      [`output_cost_per_token_above_${above / 1000}k_tokens`]: (RATES.output * 1.5) / 1e6,
      [`cache_read_input_token_cost_above_${above / 1000}k_tokens`]: (RATES.cacheRead * 2) / 1e6,
      [`cache_creation_input_token_cost_above_${above / 1000}k_tokens`]: (RATES.write * 2) / 1e6,
    },
  });
  const { priceBook } = book({ replies: sources({ litellm: ok(tierBody(200000, 9)), modelsdev: ok(modelsDevBody({ [OPUS]: RATES })) }) });
  const sync = await priceBook.sync([OPUS]);
  const row = rowOf(sync.rows, `${OPUS}.tier.200000.input`);
  assert.ok(row, sync.rows.map((r) => r.key).join(', '));
  assert.equal(row.litellm, 9);
  await priceBook.apply(sync.diffId, [row.key]);
  const entry = (await priceBook.catalog()).entries.get(OPUS);
  const tier = entry.tiers.find((t) => t.above === 200000);
  assert.deepEqual([tier.input, tier.output, tier.cacheRead], [9, RATES.output, RATES.cacheRead]);
  assert.deepEqual(await priceBook.catalog().then((c) => c.problems), []);
});

test('applying rows the overlay already holds writes nothing and keeps the earlier undo step', async () => {
  const { priceBook, fs } = book({ replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  const keys = keysTicked(sync.rows);
  await priceBook.apply(sync.diffId, keys);
  const writesBefore = written(fs).length;
  await priceBook.apply(sync.diffId, keys);
  assert.equal(written(fs).length, writesBefore);
  await priceBook.undo();
  assert.equal(fs.files.has(OVERLAY), false);
});

test('reset deletes the overlay and returns the bundled catalog, and is harmless with no overlay', async () => {
  const { priceBook, fs } = book({ replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  await priceBook.apply(sync.diffId, keysTicked(sync.rows));
  const result = await priceBook.reset();
  assert.equal(fs.files.has(OVERLAY), false);
  assert.deepEqual(result, { ok: true, version: (await priceBook.status()).version });
  const status = await priceBook.status();
  assert.equal(status.overlay, null);
  assert.equal(status.canUndo, false);
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
  assert.equal((await priceBook.reset()).ok, true);
});

test('apply, undo and reset write only the overlay and never touch the overrides file', async () => {
  const text = JSON.stringify({ v: 1, models: { 'claude-sonnet-5-5': { output: 16 } } });
  const { priceBook, fs } = book({ files: { [OVERRIDES]: text }, replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  const keys = keysTicked(sync.rows);
  await priceBook.apply(sync.diffId, keys);
  await priceBook.undo();
  await priceBook.apply(sync.diffId, keys);
  await priceBook.reset();
  assert.equal(fs.files.get(OVERRIDES).text, text);
  for (const op of written(fs)) {
    assert.ok(op.slice(1).every((path) => path.startsWith(OVERLAY)), `wrote ${op.join(' ')}`);
  }
});

test('an overridden row is skipped by apply and preview without an error', async () => {
  const files = { [OVERRIDES]: JSON.stringify({ v: 1, models: { [OPUS]: { output: 18 } } }) };
  const { priceBook, fs } = book({ files, replies: live({ [OPUS]: { ...RATES, output: 22 } }) });
  const sync = await priceBook.sync([OPUS]);
  assert.equal(rowOf(sync.rows, `${OPUS}.output`).status, 'overridden');
  const preview = await priceBook.preview(sync.diffId, [`${OPUS}.output`]);
  assert.equal(preview.entries.get(OPUS).output, 18);
  const result = await priceBook.apply(sync.diffId, [`${OPUS}.output`]);
  assert.equal(result.ok, true);
  assert.equal(fs.files.has(OVERLAY), false);
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 18);
});

test('a diff id that is not the latest is stale, and bad keys are invalid params', async () => {
  const { priceBook } = book();
  await assert.rejects(priceBook.apply('no-such-diff', []), { code: 'stale_diff' });
  await assert.rejects(priceBook.preview('no-such-diff', []), { code: 'stale_diff' });
  const first = await priceBook.sync([OPUS]);
  const second = await priceBook.sync([OPUS]);
  await assert.rejects(priceBook.apply(first.diffId, []), { code: 'stale_diff' });
  await assert.rejects(priceBook.apply(second.diffId, `${OPUS}.input`), { code: 'invalid_params' });
  await assert.rejects(priceBook.apply(second.diffId, [`${OPUS}.nothing`]), { code: 'invalid_params' });
  await assert.rejects(priceBook.preview(second.diffId, [1]), { code: 'invalid_params' });
});

test('without a cache directory the catalog is the bundled one, and writes fail with no_cache_dir', async () => {
  const { priceBook, fs } = book({ dir: undefined });
  const sync = await priceBook.sync([OPUS]);
  assert.equal((await priceBook.catalog()).entries.get(OPUS).output, 20);
  assert.equal((await priceBook.status()).overrides, null);
  await assert.rejects(priceBook.apply(sync.diffId, keysTicked(sync.rows)), { code: 'no_cache_dir' });
  assert.equal(written(fs).length, 0);
});

test('without a fetch function each source fails with a reason', async () => {
  const priceBook = createPriceBook({ fs: memoryFs(), dir: DIR, bundled: BUNDLED, now: () => NOW });
  const result = await priceBook.sync([OPUS]);
  assert.deepEqual(result.sources.map((source) => source.error), ['fetch is not available', 'fetch is not available']);
});
