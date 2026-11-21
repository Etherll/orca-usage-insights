# Pack for lane COLD: cold

# Method

## Every lens

- Read the code, then the claim. Open each changed file at the target and read the function around every hunk (the function, not the file), plus the callers and callees the hunk depends on. A diff alone hides the guard three lines above it and the consumer two files away.
- Follow real values. When the code calls something, read the callee with the arguments this call site actually passes, including every argument it omits and the default that fills it.
- A candidate needs a trigger you can write down as numbered steps: who does what, in what order, with what input, in which environment. If you cannot write the steps, keep reading until you can or drop it.
- Report what the change makes wrong (introduced) or newly reachable (exposed). A defect that behaves the same on the baseline is `pre-existing`: report it, labelled.
- Name the **class** of each candidate and **sweep** for it: list the other places the same pattern occurs (sibling functions, other platforms, other variants, other reset or entry paths) and say which you checked. One instance usually has siblings, and a fix that closes one instance leaves the rest.
- Things you suspected and ruled out are results too. Record them with the `path:line` of the guard that rules them out.

## cold

Method: you are an outside reviewer seeing this change for the first time, after the team that wrote and reviewed it called it done. You have the diff and the repository, and no notes from them.

Artifact: a walk of every changed file in order, with a line for each hunk.

- Trust nothing you were not shown. Read each hunk against its surrounding function and its callers.
- Hunt for what a team close to the code stops seeing: the unhandled case, the sibling left unfixed, the state that survives a reset, the stale completion, the failure reported as success, the fix that moved the bug one step along.
- Report at most the ten candidates you would stake your name on, each with its trigger.

# Diff

Each line carries its line number in the target file; removed lines have none. Each source hunk is shown inside the whole function, class member, or switch that holds it, under the header line of each enclosing scope; a unit over 80 lines shows its header and the lines around the change. Unchanged functions shown with no +/- lines are ones the new code calls, or ones that use a name the change touched.

```diff
diff --git a/panel/index.html b/panel/index.html
index ef1ce0c..e59272c 100644
--- a/panel/index.html
+++ b/panel/index.html
@@ -1444,21 +1444,21 @@ function syncBody(result) {
  1444      ? '<p class="muted small">“Check this” means a change of 10× or more, a zero price on a paid model, or a per-token price this plugin doesn’t know yet. These are never pre-ticked.</p>'
  1445      : ''
  1446    return `${impact}<ul class="src-list">${sources}</ul>${table}${matching}${note}`
  1447  }
  1448  
  1449  // src/panel/panel.js
  1450  // Panel controller: asks the worker for a Report and renders it. Knows nothing about transcripts.
  1451  
  1452  const $ = (id) => document.getElementById(id)
  1453  const host = globalThis.orca
       -const state = { view: 'usage', range: '7d', startDate: '', endDate: '', models: null, modelSearch: '', provider: 'all', host: 'all', scope: 'all', cache: true, metric: 'tokens', breakdown: 'model', sort: 'default', report: null, busy: false, bd: null, bdPath: [], prices: null, sync: null }
  1454 +const state = { view: 'usage', range: '7d', defaultRange: '7d', rangePicked: false, startDate: '', endDate: '', models: null, modelSearch: '', provider: 'all', host: 'all', scope: 'all', cache: true, metric: 'tokens', breakdown: 'model', sort: 'default', report: null, busy: false, bd: null, bdPath: [], prices: null, sync: null }
  1455  const NOTE_KEY = 'usage-insights.prices-note.1.2.0'
  1456  
  1457  function money(n) {
  1458    const v = Number(n) || 0
  1459    return '$' + (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2))
  1460  }
  1461  // One decimal, never rounding up to 100.0% unless it is exactly 100%.
  1462  function pct1(x) {
  1463    const v = (Number(x) || 0) * 100
  1464    const shown = v >= 100 ? 100 : Math.min(99.9, Math.round(v * 10) / 10)
@@ -1593,21 +1593,21 @@ function clearFilter(key) {
  1593    if (key === 'scope' || key === 'all') state.scope = 'all'
  1594    if (key === 'provider' || key === 'all') state.provider = 'all'
  1595    if (key === 'host' || key === 'all') state.host = 'all'
  1596    if (key === 'cache' || key === 'all') state.cache = true
  1597    if (key === 'models' || key === 'all') {
  1598      state.models = null
  1599      state.modelSearch = ''
  1600      $('model-search').value = ''
  1601    }
  1602    if (key === 'range' || (key === 'all' && state.range === 'custom')) {
       -    state.range = '7d'
  1603 +    state.range = state.defaultRange
  1604      $('custom-range').hidden = true
  1605      $('date-error').hidden = true
  1606    }
  1607    load()
  1608  }
  1609  
  1610  // The menu sits under its button, moved left to stay on screen, and opens upward when there is more room
  1611  // above. It scrolls inside the height it gets. Recomputed on open, render and resize.
  1612  function positionMenu() {
  1613    const pop = $('filters-pop')
@@ -1731,20 +1731,21 @@ function applyDates() {
  1731      $('date-error').textContent = `Pick a start date on or after ${MIN_USAGE_DATE} and an end date no later than today, with the start on or before the end (${err.message}).`
  1732      $('date-error').hidden = false
  1733      $('start-date').setAttribute('aria-invalid', 'true')
  1734      $('end-date').setAttribute('aria-invalid', 'true')
  1735      return
  1736    }
  1737    $('date-error').hidden = true
  1738    $('start-date').setAttribute('aria-invalid', 'false')
  1739    $('end-date').setAttribute('aria-invalid', 'false')
  1740    state.range = 'custom'
  1741 +  state.rangePicked = true
  1742    state.startDate = startDate
  1743    state.endDate = endDate
  1744    load()
  1745  }
  1746  
  1747  function timeZoneName() {
  1748    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time' } catch { return 'local time' }
  1749  }
  1750  
  1751  // The worker keeps the turned-off list in its settings; the report is then reloaded without the folder.
@@ -2026,20 +2027,67 @@ function renderBreakdownView() {
  2027    const t = tree(v)
  2028    $('bd-crumbs').innerHTML = t.crumbs
  2029    $('bd-tree').innerHTML = t.rows
  2030    $('bd-findings').innerHTML = findings(v)
  2031    const not = notAnalysed(v)
  2032    $('bd-not').hidden = !not
  2033    $('bd-not').innerHTML = not
  2034    $('bd-foot').textContent = legend(v)
  2035  }
  2036  
  2037 +// The Default range setting picks the range the panel opens on and returns to. A range the person
  2038 +// picks before the setting is read is kept; a load that started without one (a background
  2039 +// usage.changed) is redone on the default.
  2040 +async function firstLoad() {
  2041 +  host?.settings?.onDidChange?.((change) => { if (change?.key === 'defaultRange') readDefaultRange() })
  2042 +  readDefaultRange()
  2043 +  // A slow host doesn't hold the first report back: it loads now and moves once the setting arrives.
  2044 +  const slow = globalThis.setTimeout?.(() => { if (!state.report && !state.busy) load() }, 1500)
  2045 +  // A change that lands meanwhile starts a newer read; wait for the newest one to answer.
  2046 +  if (defaultRangeWaiters) await new Promise((resolve) => defaultRangeWaiters.push(resolve))
  2047 +  globalThis.clearTimeout?.(slow)
  2048 +  const range = state.defaultRange
  2049 +  let moved = false
  2050 +  if (!state.rangePicked && state.range !== range) {
  2051 +    state.range = range
  2052 +    for (const b of $('ranges').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.range === range))
  2053 +    syncRadioTabs()
  2054 +    moved = true
  2055 +  }
  2056 +  if (moved || (!state.report && !state.busy)) load()
  2057 +}
  2058 +
  2059 +// Reads the saved Default range into state.defaultRange; a missing, unknown or unreadable value
  2060 +// leaves it as it was. Reads are numbered and the newest valid answer wins, so neither a slower
  2061 +// older answer nor a failed newer read undoes it. defaultRangeWaiters is null when no read is out,
  2062 +// else what to call once the newest read has answered.
  2063 +let defaultRangeReads = 0
  2064 +let defaultRangeApplied = 0
  2065 +let defaultRangeWaiters = null
  2066 +function readDefaultRange() {
  2067 +  const read = ++defaultRangeReads
  2068 +  defaultRangeWaiters ??= []
  2069 +  Promise.resolve()
  2070 +    .then(() => host?.settings?.get?.('defaultRange'))
  2071 +    .then((range) => {
  2072 +      if (read < defaultRangeApplied || (range !== 'all' && !RANGE_DAYS.has(range))) return
  2073 +      defaultRangeApplied = read
  2074 +      state.defaultRange = range
  2075 +    }, () => {})
  2076 +    .then(() => {
  2077 +      if (read !== defaultRangeReads) return
  2078 +      const waiters = defaultRangeWaiters
  2079 +      defaultRangeWaiters = null
  2080 +      for (const resolve of waiters) resolve()
  2081 +    })
  2082 +}
  2083 +
  2084  async function loadPrices() {
  2085    try {
  2086      state.prices = await request('prices.status')
  2087    } catch {
  2088      state.prices = null
  2089    }
  2090    renderView()
  2091  }
  2092  
  2093  async function priceAction(action) {
@@ -2230,20 +2278,21 @@ function bindControls() {
  2278    })
  2279    $('hosts').addEventListener('click', (e) => {
  2280      const b = e.target.closest('button[data-host]')
  2281      if (!b || b.dataset.host === state.host) return
  2282      state.host = b.dataset.host
  2283      load()
  2284    })
  2285    $('ranges').addEventListener('click', (e) => {
  2286      const b = e.target.closest('button[data-range]')
  2287      if (!b) return
  2288 +    state.rangePicked = true
  2289      if (b.dataset.range === 'custom') {
  2290        // Custom opens the date fields; the range changes on Apply.
  2291        $('custom-range').hidden = false
  2292        if (!$('start-date').value) $('start-date').value = state.startDate || state.report?.startDate || dayKey(localDay())
  2293        if (!$('end-date').value) $('end-date').value = state.endDate || state.report?.endDate || dayKey(localDay())
  2294        $('start-date').focus()
  2295        return
  2296      }
  2297      $('custom-range').hidden = true
  2298      $('date-error').hidden = true
@@ -2339,17 +2388,17 @@ function bindControls() {
  2388        const w = document.body?.clientWidth || 0
  2389        if (state.report && state.view === 'usage' && Math.abs(w - lastW) > 8) { lastW = w; render() }
  2390      }, 120)
  2391    })
  2392  }
  2393  
  2394  if (typeof document !== 'undefined' && document.getElementById('app')) {
  2395    bindControls()
  2396    bindBreakdown()
  2397    bindTooltip()
       -  load()
  2398 +  firstLoad()
  2399    loadPrices()
  2400  }
  2401  
  2402  })()</script>
  2403  </body>
  2404  </html>
diff --git a/src/panel/panel.js b/src/panel/panel.js
index 7834d7a..899916d 100644
--- a/src/panel/panel.js
+++ b/src/panel/panel.js
     1  // Panel controller: asks the worker for a Report and renders it. Knows nothing about transcripts.
     2  import { stackedBars, calendarHeatmap, punchCard, donut, hBars, sparkline, areaTrend, segmentBar, providerColor, compact, esc, TOKEN_KEYS, TOKEN_LABELS, TOKEN_COLORS, PROVIDER_LABELS } from './charts.mjs'
     3  import { pixelBanner } from './art.mjs'
     4  import { headline, tree, findings, notAnalysed, legend, priceLine, syncBody, changedSyncRows } from './breakdown.js'
       -import { normalizeQuery, localDay, dayKey, MIN_USAGE_DATE } from '../core/query.mjs'
     5 +import { normalizeQuery, localDay, dayKey, MIN_USAGE_DATE, RANGE_DAYS } from '../core/query.mjs'
     6  
     7  const $ = (id) => document.getElementById(id)
     8  const host = globalThis.orca
       -const state = { view: 'usage', range: '7d', startDate: '', endDate: '', models: null, modelSearch: '', provider: 'all', host: 'all', scope: 'all', cache: true, metric: 'tokens', breakdown: 'model', sort: 'default', report: null, busy: false, bd: null, bdPath: [], prices: null, sync: null }
     9 +const state = { view: 'usage', range: '7d', defaultRange: '7d', rangePicked: false, startDate: '', endDate: '', models: null, modelSearch: '', provider: 'all', host: 'all', scope: 'all', cache: true, metric: 'tokens', breakdown: 'model', sort: 'default', report: null, busy: false, bd: null, bdPath: [], prices: null, sync: null }
    10  const NOTE_KEY = 'usage-insights.prices-note.1.2.0'
    11  
    12  function money(n) {
    13    const v = Number(n) || 0
    14    return '$' + (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2))
    15  }
    16  // One decimal, never rounding up to 100.0% unless it is exactly 100%.
    17  function pct1(x) {
    18    const v = (Number(x) || 0) * 100
    19    const shown = v >= 100 ? 100 : Math.min(99.9, Math.round(v * 10) / 10)
       ... lines 20-146 not shown ...
   147  function clearFilter(key) {
   148    if (key === 'scope' || key === 'all') state.scope = 'all'
   149    if (key === 'provider' || key === 'all') state.provider = 'all'
   150    if (key === 'host' || key === 'all') state.host = 'all'
   151    if (key === 'cache' || key === 'all') state.cache = true
   152    if (key === 'models' || key === 'all') {
   153      state.models = null
   154      state.modelSearch = ''
   155      $('model-search').value = ''
   156    }
   157    if (key === 'range' || (key === 'all' && state.range === 'custom')) {
       -    state.range = '7d'
   158 +    state.range = state.defaultRange
   159      $('custom-range').hidden = true
   160      $('date-error').hidden = true
   161    }
   162    load()
   163  }
       ... lines 164-279 not shown ...
   280  function applyDates() {
   281    const startDate = $('start-date').value
   282    const endDate = $('end-date').value
   283    try {
   284      normalizeQuery({ range: 'custom', startDate, endDate })
   285    } catch (err) {
   286      $('date-error').textContent = `Pick a start date on or after ${MIN_USAGE_DATE} and an end date no later than today, with the start on or before the end (${err.message}).`
   287      $('date-error').hidden = false
   288      $('start-date').setAttribute('aria-invalid', 'true')
   289      $('end-date').setAttribute('aria-invalid', 'true')
   290      return
   291    }
   292    $('date-error').hidden = true
   293    $('start-date').setAttribute('aria-invalid', 'false')
   294    $('end-date').setAttribute('aria-invalid', 'false')
   295    state.range = 'custom'
   296 +  state.rangePicked = true
   297    state.startDate = startDate
   298    state.endDate = endDate
   299    load()
   300  }
       ... lines 301-581 not shown ...
   582    const t = tree(v)
   583    $('bd-crumbs').innerHTML = t.crumbs
   584    $('bd-tree').innerHTML = t.rows
   585    $('bd-findings').innerHTML = findings(v)
   586    const not = notAnalysed(v)
   587    $('bd-not').hidden = !not
   588    $('bd-not').innerHTML = not
   589    $('bd-foot').textContent = legend(v)
   590  }
   591  
   592 +// The Default range setting picks the range the panel opens on and returns to. A range the person
   593 +// picks before the setting is read is kept; a load that started without one (a background
   594 +// usage.changed) is redone on the default.
   595 +async function firstLoad() {
   596 +  host?.settings?.onDidChange?.((change) => { if (change?.key === 'defaultRange') readDefaultRange() })
   597 +  readDefaultRange()
   598 +  // A slow host doesn't hold the first report back: it loads now and moves once the setting arrives.
   599 +  const slow = globalThis.setTimeout?.(() => { if (!state.report && !state.busy) load() }, 1500)
   600 +  // A change that lands meanwhile starts a newer read; wait for the newest one to answer.
   601 +  if (defaultRangeWaiters) await new Promise((resolve) => defaultRangeWaiters.push(resolve))
   602 +  globalThis.clearTimeout?.(slow)
   603 +  const range = state.defaultRange
   604 +  let moved = false
   605 +  if (!state.rangePicked && state.range !== range) {
   606 +    state.range = range
   607 +    for (const b of $('ranges').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.range === range))
   608 +    syncRadioTabs()
   609 +    moved = true
   610 +  }
   611 +  if (moved || (!state.report && !state.busy)) load()
   612 +}
   613 +
   614 +// Reads the saved Default range into state.defaultRange; a missing, unknown or unreadable value
   615 +// leaves it as it was. Reads are numbered and the newest valid answer wins, so neither a slower
   616 +// older answer nor a failed newer read undoes it. defaultRangeWaiters is null when no read is out,
   617 +// else what to call once the newest read has answered.
   618 +let defaultRangeReads = 0
   619 +let defaultRangeApplied = 0
   620 +let defaultRangeWaiters = null
   621 +function readDefaultRange() {
   622 +  const read = ++defaultRangeReads
   623 +  defaultRangeWaiters ??= []
   624 +  Promise.resolve()
   625 +    .then(() => host?.settings?.get?.('defaultRange'))
   626 +    .then((range) => {
   627 +      if (read < defaultRangeApplied || (range !== 'all' && !RANGE_DAYS.has(range))) return
   628 +      defaultRangeApplied = read
   629 +      state.defaultRange = range
   630 +    }, () => {})
   631 +    .then(() => {
   632 +      if (read !== defaultRangeReads) return
   633 +      const waiters = defaultRangeWaiters
   634 +      defaultRangeWaiters = null
   635 +      for (const resolve of waiters) resolve()
   636 +    })
   637 +}
   638 +
   639  async function loadPrices() {
   640    try {
   641      state.prices = await request('prices.status')
   642    } catch {
   643      state.prices = null
   644    }
   645    renderView()
   646  }
   647  
   648  async function priceAction(action) {
       ... lines 649-825 not shown ...
   826  function bindControls() {
       ... lines 827-839 not shown ...
   840    $('ranges').addEventListener('click', (e) => {
   841      const b = e.target.closest('button[data-range]')
   842      if (!b) return
   843 +    state.rangePicked = true
   844      if (b.dataset.range === 'custom') {
   845        // Custom opens the date fields; the range changes on Apply.
   846        $('custom-range').hidden = false
   847        if (!$('start-date').value) $('start-date').value = state.startDate || state.report?.startDate || dayKey(localDay())
   848        if (!$('end-date').value) $('end-date').value = state.endDate || state.report?.endDate || dayKey(localDay())
   849        $('start-date').focus()
   850        return
   851      }
   852      $('custom-range').hidden = true
   853      $('date-error').hidden = true
   854      if (b.dataset.range === state.range) return
   855      state.range = b.dataset.range
   856      load()
   857    })
       ... lines 858-942 not shown ...
   943        const w = document.body?.clientWidth || 0
   944        if (state.report && state.view === 'usage' && Math.abs(w - lastW) > 8) { lastW = w; render() }
   945      }, 120)
   946    })
   947  }
   948  
   949  if (typeof document !== 'undefined' && document.getElementById('app')) {
   950    bindControls()
   951    bindBreakdown()
   952    bindTooltip()
       -  load()
   953 +  firstLoad()
   954    loadPrices()
   955  }
diff --git a/tests/panel.test.mjs b/tests/panel.test.mjs
index 76ae5cc..6185e9c 100644
--- a/tests/panel.test.mjs
+++ b/tests/panel.test.mjs
@@ -79,7 +79,7 @@ test('panel requests a report and renders every section', async () => {
    79    const ctx = vm.createContext({ document, orca, window: { innerWidth: 800, innerHeight: 600 }, console, Date, Intl, JSON, Math })
    80    vm.runInContext(script, ctx)
    81    await new Promise((r) => setTimeout(r, 20))
       -  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['usage.report', { range: '7d', includeCache: true }]))
    82 +  assert.equal(JSON.stringify(calls.find(([name]) => name === 'usage.report')), JSON.stringify(['usage.report', { range: '7d', includeCache: true }]))
    83    const get = (id) => els.get(id)
    84    assert.match(get('tiles').innerHTML, /226\.8k/)
    85    assert.match(get('tiles').innerHTML, /Cache hit rate/)
@@ -128,13 +128,14 @@ test('panel shows an error state when the worker fails', async () => {
   128    assert.equal(els.get('status').hidden, false)
   129  })
   130  
       -async function mountPanel(makeReport = (input) => sampleReport(input.range, input.includeCache)) {
   131 +async function mountPanel(makeReport = (input) => sampleReport(input.range, input.includeCache), settings) {
   132    const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
   133    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
   134    const { els, document } = fakeDom()
   135    const calls = []
   136 +  const pluginEvents = {}
   137    // Price requests (the footer line) are not part of what these tests check.
       -  const orca = { plugin: { request: async (name, input) => { if (name.startsWith('prices.')) return null; calls.push(JSON.parse(JSON.stringify({ name, input }))); return makeReport(input) }, on() {} }, on() {} }
   138 +  const orca = { plugin: { request: async (name, input) => { if (name.startsWith('prices.')) return null; calls.push(JSON.parse(JSON.stringify({ name, input }))); return makeReport(input) }, on(name, handler) { pluginEvents[name] = handler } }, on() {}, settings }
   139    const viewport = { innerWidth: 320, innerHeight: 600 }
   140    const events = {}
   141    vm.runInContext(script, vm.createContext({ document, orca, window: viewport, addEventListener: (name, handler) => { events[name] = handler }, console, Date, Intl, JSON, Math, setTimeout, clearTimeout }))
@@ -142,7 +143,7 @@ async function mountPanel(makeReport = (input) => sampleReport(input.range, inpu
   143    await settle()
   144    const get = (id) => els.get(id)
   145    const click = (id, dataset) => get(id).listeners.click({ target: { closest: () => ({ dataset }) } })
       -  return { calls, get, click, settle, viewport, events }
   146 +  return { calls, get, click, settle, viewport, events, pluginEvents }
   147  }
   148  
   149  test('custom dates validate before requesting, allow one local day, and presets discard dates', async () => {
@@ -213,6 +214,151 @@ test('cache switch requests consistent totals and token charts, and reset querie
   214    assert.equal(get('chips').innerHTML, '')
   215  })
   216  
   217 +test('the Default range setting picks the opening range and the one a cleared custom range returns to', async () => {
   218 +  const { calls, get, click, settle } = await mountPanel(undefined, { get: async (key) => (key === 'defaultRange' ? '1d' : undefined) })
   219 +  assert.deepEqual(calls, [{ name: 'usage.report', input: { range: '1d', includeCache: true } }])
   220 +  click('ranges', { range: 'custom' })
   221 +  get('start-date').value = get('end-date').value = '2026-11-03'
   222 +  get('date-apply').listeners.click()
   223 +  await settle()
   224 +  assert.equal(calls.at(-1).input.range, 'custom')
   225 +  get('chips').listeners.click({ target: { closest: () => ({ dataset: { clear: 'range' } }) } })
   226 +  await settle()
   227 +  assert.deepEqual(calls.at(-1).input, { range: '1d', includeCache: true })
   228 +})
   229 +
   230 +test('an unknown or unreadable Default range opens on 7d, and a range picked before it is read is kept', async () => {
   231 +  for (const settings of [{ get: async () => '1y' }, { get: async () => { throw new Error('settings offline') } }]) {
   232 +    const { calls } = await mountPanel(undefined, settings)
   233 +    assert.deepEqual(calls, [{ name: 'usage.report', input: { range: '7d', includeCache: true } }])
   234 +  }
   235 +  let answer
   236 +  const { calls, click, settle } = await mountPanel(undefined, { get: () => new Promise((resolve) => { answer = resolve }) })
   237 +  assert.equal(calls.length, 0, 'the first report waits for the setting')
   238 +  click('ranges', { range: '30d' })
   239 +  await settle()
   240 +  answer('1d')
   241 +  await settle()
   242 +  assert.deepEqual(calls.map((c) => c.input.range), ['30d'])
   243 +})
   244 +
   245 +test('a background load, a failed pick or a no-op pick before the Default range is read', async () => {
   246 +  // A usage.changed load that starts without the setting is redone on the default.
   247 +  let answer
   248 +  let mounted = await mountPanel(undefined, { get: () => new Promise((resolve) => { answer = resolve }) })
   249 +  mounted.pluginEvents['usage.changed']()
   250 +  await mounted.settle()
   251 +  answer('30d')
   252 +  await mounted.settle()
   253 +  await mounted.settle()
   254 +  assert.deepEqual(mounted.calls.map((c) => c.input.range), ['7d', '30d'])
   255 +  // A picked range whose load fails is kept.
   256 +  let fail = true
   257 +  mounted = await mountPanel((input) => { if (fail) { fail = false; throw new Error('worker down') } return sampleReport(input.range, input.includeCache) }, { get: () => new Promise((resolve) => { answer = resolve }) })
   258 +  mounted.click('ranges', { range: '90d' })
   259 +  await mounted.settle()
   260 +  answer('1d')
   261 +  await mounted.settle()
   262 +  // The failed 90d is retried on 90d, not replaced by the default.
   263 +  assert.deepEqual(mounted.calls.map((c) => c.input.range), ['90d', '90d'])
   264 +  // Clicking the range already shown counts as a pick.
   265 +  mounted = await mountPanel(undefined, { get: () => new Promise((resolve) => { answer = resolve }) })
   266 +  mounted.click('ranges', { range: '7d' })
   267 +  answer('1d')
   268 +  await mounted.settle()
   269 +  assert.deepEqual(mounted.calls.map((c) => c.input.range), ['7d'])
   270 +})
   271 +
   272 +test('a Default range changed while the panel is open is where a cleared custom range goes', async () => {
   273 +  let saved = '7d'
   274 +  let listener
   275 +  const { calls, get, click, settle } = await mountPanel(undefined, { get: async () => saved, onDidChange: (fn) => { listener = fn } })
   276 +  saved = '90d'
   277 +  listener({ key: 'defaultRange' })
   278 +  await settle()
   279 +  click('ranges', { range: 'custom' })
   280 +  get('start-date').value = get('end-date').value = '2026-11-03'
   281 +  get('date-apply').listeners.click()
   282 +  await settle()
   283 +  get('chips').listeners.click({ target: { closest: () => ({ dataset: { clear: 'range' } }) } })
   284 +  await settle()
   285 +  assert.deepEqual(calls.at(-1).input, { range: '90d', includeCache: true })
   286 +})
   287 +
   288 +test('an older Default range read that answers last does not win over a newer one', async () => {
   289 +  const answers = []
   290 +  let listener
   291 +  const { calls, settle } = await mountPanel(undefined, { get: () => new Promise((resolve) => answers.push(resolve)), onDidChange: (fn) => { listener = fn } })
   292 +  listener({ key: 'defaultRange' })
   293 +  await settle()
   294 +  answers[1]('90d')
   295 +  await settle()
   296 +  answers[0]('30d')
   297 +  await settle()
   298 +  assert.deepEqual(calls.map((c) => c.input.range), ['90d'])
   299 +})
   300 +
   301 +test('a Default range changed while the first read is out opens on the newer value', async () => {
   302 +  const answers = []
   303 +  let listener
   304 +  const { calls, settle } = await mountPanel(undefined, { get: () => new Promise((resolve) => answers.push(resolve)), onDidChange: (fn) => { listener = fn } })
   305 +  listener({ key: 'defaultRange' })
   306 +  answers[0]('7d')
   307 +  await settle()
   308 +  assert.equal(calls.length, 0, 'the panel waits for the newest read')
   309 +  answers[1]('90d')
   310 +  await settle()
   311 +  assert.deepEqual(calls.map((c) => c.input.range), ['90d'])
   312 +})
   313 +
   314 +test('a slow Default range read does not hold the first report back', async () => {
   315 +  let answer
   316 +  const { calls, settle } = await mountPanel(undefined, { get: () => new Promise((resolve) => { answer = resolve }) })
   317 +  await new Promise((resolve) => setTimeout(resolve, 1600))
   318 +  assert.deepEqual(calls.map((c) => c.input.range), ['7d'])
   319 +  answer('30d')
   320 +  await settle()
   321 +  await settle()
   322 +  assert.deepEqual(calls.map((c) => c.input.range), ['7d', '30d'])
   323 +})
   324 +
   325 +test('a settings read that throws at once, a stuck first read, or an open Custom picker', async () => {
   326 +  // A get that throws synchronously opens on 7d.
   327 +  let mounted = await mountPanel(undefined, { get: () => { throw new Error('no settings') } })
   328 +  await mounted.settle()
   329 +  assert.deepEqual(mounted.calls.map((c) => c.input.range), ['7d'])
   330 +  // A stuck first read doesn't block a newer answer.
   331 +  let listener
   332 +  const answers = []
   333 +  mounted = await mountPanel(undefined, { get: () => new Promise((resolve) => answers.push(resolve)), onDidChange: (fn) => { listener = fn } })
   334 +  listener({ key: 'defaultRange' })
   335 +  await mounted.settle()
   336 +  answers[1]('90d')
   337 +  await mounted.settle()
   338 +  assert.deepEqual(mounted.calls.map((c) => c.input.range), ['90d'])
   339 +  // Opening the Custom picker counts as a pick, so the default doesn't move the range under it.
   340 +  let answer
   341 +  mounted = await mountPanel(undefined, { get: () => new Promise((resolve) => { answer = resolve }) })
   342 +  mounted.click('ranges', { range: 'custom' })
   343 +  answer('30d')
   344 +  await mounted.settle()
   345 +  assert.deepEqual(mounted.calls.map((c) => c.input.range), ['7d'])
   346 +  assert.equal(mounted.get('custom-range').hidden, false)
   347 +})
   348 +
   349 +test('a valid Default range answer is kept when a newer read fails', async () => {
   350 +  const answers = []
   351 +  let listener
   352 +  const { calls, settle } = await mountPanel(undefined, { get: () => new Promise((resolve, reject) => answers.push({ resolve, reject })), onDidChange: (fn) => { listener = fn } })
   353 +  listener({ key: 'defaultRange' })
   354 +  await settle()
   355 +  answers[0].resolve('30d')
   356 +  await settle()
   357 +  answers[1].reject(new Error('host did not answer'))
   358 +  await settle()
   359 +  assert.deepEqual(calls.map((c) => c.input.range), ['30d'])
   360 +})
   361 +
   362  test('date and model detail shows exact escaped rows and visible sort choices', async () => {
   363    const hostile = '<img src=x onerror=alert(1)>'
   364    const { get, click, settle } = await mountPanel((input) => {
```
