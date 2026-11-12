import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))

function sampleReport(range = '7d', includeCache = true) {
  const daily = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(28 + i).padStart(2, '0')}`.replace('2026-10-32', '2026-11-01').replace('2026-10-33', '2026-11-02').replace('2026-10-34', '2026-11-03'), input: 1000 * i, output: 500 * i, cacheRead: 9000 * i, cacheWrite: 300 * i, total: 10800 * i, costUsd: i }))
  const report = {
    includeCache, startDate: '2026-10-28', endDate: '2026-11-03', models: ['claude-opus-5-5', 'gpt-5-codex'],
    byDayModel: [
      { day: '2026-11-03', provider: 'codex', model: 'gpt-5-codex', input: 10000, output: 2000, cacheRead: 500, cacheWrite: 80, total: includeCache ? 12580 : 12000 },
      { day: '2026-11-02', provider: 'claude', model: 'claude-opus-5-5', input: 1234567, output: 4000, cacheRead: 20000, cacheWrite: 90, total: includeCache ? 1258657 : 1238567 },
    ],
    generatedAt: '2026-11-03T20:23:29.000Z', range, providers: ['claude', 'codex'],
    totals: { input: 21000, output: 10500, cacheRead: 189000, cacheWrite: 6300, total: 226800, costUsd: 21, hasUnpriced: true, sessions: 3, turns: 42, cacheReuseRate: 0.9 },
    today: { total: 64800, costUsd: 6 },
    daily,
    calendar: Array.from({ length: 182 }, (_, i) => ({ day: new Date(2026, 4, 5 + i).toLocaleDateString('en-CA'), total: i % 4 ? i * 10 : 0 })),
    punchCard: Array.from({ length: 168 }, (_, i) => i % 7),
    byModel: [{ model: 'claude-opus-5-5', total: 200000, costUsd: 20, share: 0.88 }, { model: 'gpt-5-codex', total: 26800, costUsd: null, share: 0.12 }],
    byProject: [{ project: 'pyrosome', total: 226800, share: 1 }],
    byProvider: [{ provider: 'claude', total: 200000, costUsd: 20, share: 0.88 }, { provider: 'codex', total: 26800, costUsd: null, share: 0.12 }],
    streak: { current: 6, longest: 9 },
    hosts: ['local', 'ssh:devbox'],
    byHost: [{ host: 'local', total: 200000, costUsd: 20, share: 0.88, sessions: 2, turns: 30 }, { host: 'ssh:devbox', total: 26800, costUsd: 1, share: 0.12, sessions: 1, turns: 12 }],
    sources: [
      { id: 'local', kind: 'local', label: 'This machine', state: 'ok', files: 10, records: 30, lastScanAt: new Date().toISOString(), ms: 40 },
      { id: 'ssh:devbox', kind: 'ssh', label: 'devbox', state: 'error', files: 3, records: 12, lastScanAt: null, ms: 900, message: 'SSH login was refused.' },
    ],
    peakDay: { day: '2026-11-03', total: 64800 },
  }
  if (!includeCache) {
    report.totals.total = report.totals.input + report.totals.output
    for (const day of report.daily) day.total = day.input + day.output
    report.today.total = 9000
    report.peakDay.total = 9000
  }
  return report
}

function fakeDom() {
  const els = new Map()
  const make = (id) => ({
    id, innerHTML: '', textContent: '', value: '', focus() {}, hidden: false, checked: true, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] },
    listeners: {}, addEventListener(t, f) { this.listeners[t] = f },
    querySelector() { return null }, querySelectorAll() { return [] }, getBoundingClientRect: () => ({ width: 100, height: 40 }),
  })
  return {
    els,
    document: { getElementById: (id) => (els.has(id) ? els.get(id) : (els.set(id, make(id)), els.get(id))), addEventListener() {} },
  }
}

test('built panel is a single classic script with no module syntax', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root })
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(scripts.length, 1)
  assert.ok(!/^\s*(import|export) /m.test(scripts[0]))
  assert.ok(!/<script src|<link /.test(html), 'no external resources')
  assert.match(html, /connect-src 'none'/)
})

test('panel requests a report and renders every section', async () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const { els, document } = fakeDom()
  const calls = []
  const orca = {
    plugin: { request: async (name, input) => { calls.push([name, input]); return sampleReport(input.range, input.includeCache) }, on() {} },
    on() {},
  }
  const ctx = vm.createContext({ document, orca, window: { innerWidth: 800, innerHeight: 600 }, console, Date, Intl, JSON, Math })
  vm.runInContext(script, ctx)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['usage.report', { range: '7d', includeCache: true }]))
  const get = (id) => els.get(id)
  assert.match(get('tiles').innerHTML, /226\.8k/)
  assert.match(get('tiles').innerHTML, /Cache hit rate/)
  assert.match(get('tiles').innerHTML, /reuse/)
  assert.match(get('tiles').innerHTML, /\$21\.00\+/)
  assert.match(get('daily').innerHTML, /<svg/)
  assert.match(get('calendar').innerHTML, /cell q4/)
  assert.match(get('punch').innerHTML, /<circle/)
  assert.match(get('donut').innerHTML, /stroke-dasharray/)
  assert.match(get('breakdown').innerHTML, /claude-opus-5-5/)
  assert.match(get('breakdown').innerHTML, /share-line/)
  assert.match(get('trend').innerHTML, /<path d="M/)
  assert.match(get('typebar').innerHTML, /<svg/)
  assert.match(get('totals').innerHTML, /Cache savings/)
  assert.match(get('ov-providers').innerHTML, /Claude Code/)
  assert.match(get('banner').innerHTML, /crispEdges/)
  assert.match(get('providers').innerHTML, /Codex/)
  assert.equal(get('content').hidden, false)
  assert.match(get('hosts').innerHTML, /devbox/)
  assert.equal(get('sec-hosts').hidden, false)
  assert.equal(get('sec-providers').hidden, false)
  assert.equal(get('chips').innerHTML, '', 'no chips while every filter is at its default')
  assert.equal(get('filters-count').hidden, true)
  assert.match(get('hosts').innerHTML, /This machine/)
  assert.match(get('sources').innerHTML, /src error/)
  assert.match(get('notice').textContent, /SSH login was refused/)
  assert.equal(get('ov-hosts').hidden, false)
  assert.match(html, /data-range="7d" aria-checked="true">7d/)
  assert.match(html, /data-range="1d" aria-checked="false" tabindex="-1">Today/)
  get('ranges').listeners.click({ target: { closest: () => ({ dataset: { range: '1d', includeCache: true } }) } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['usage.report', { range: '1d', includeCache: true }]))
  get('ranges').listeners.click({ target: { closest: () => ({ dataset: { range: '7d', includeCache: true } }) } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['usage.report', { range: '7d', includeCache: true }]))
})

test('panel shows an error state when the worker fails', async () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const { els, document } = fakeDom()
  const orca = { plugin: { request: async () => { throw new Error('unavailable') }, on() {} }, on() {} }
  vm.runInContext(script, vm.createContext({ document, orca, window: {}, console, Date, Intl, JSON, Math }))
  await new Promise((r) => setTimeout(r, 20))
  assert.match(els.get('status').textContent, /unavailable/)
  assert.equal(els.get('status').hidden, false)
})

async function mountPanel(makeReport = (input) => sampleReport(input.range, input.includeCache)) {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const { els, document } = fakeDom()
  const calls = []
  // Price requests (the footer line) are not part of what these tests check.
  const orca = { plugin: { request: async (name, input) => { if (name.startsWith('prices.')) return null; calls.push(JSON.parse(JSON.stringify({ name, input }))); return makeReport(input) }, on() {} }, on() {} }
  const viewport = { innerWidth: 320, innerHeight: 600 }
  const events = {}
  vm.runInContext(script, vm.createContext({ document, orca, window: viewport, addEventListener: (name, handler) => { events[name] = handler }, console, Date, Intl, JSON, Math, setTimeout, clearTimeout }))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  const get = (id) => els.get(id)
  const click = (id, dataset) => get(id).listeners.click({ target: { closest: () => ({ dataset }) } })
  return { calls, get, click, settle, viewport, events }
}

test('custom dates validate before requesting, allow one local day, and presets discard dates', async () => {
  const { calls, get, click, settle } = await mountPanel()
  click('ranges', { range: 'custom' })
  assert.equal(get('start-date').min, '2020-01-01')
  assert.equal(get('end-date').min, '2020-01-01')
  assert.equal(get('custom-range').hidden, false)
  assert.equal(calls.length, 1, 'opening the editor does not query')
  for (const [start, end] of [['0000-01-01', '2026-11-03'], ['2026-02-30', '2026-03-01'], ['2026-11-03', '2026-11-02'], ['', '2026-11-03'], ['2999-01-01', '2999-01-01']]) {
    get('start-date').value = start
    get('end-date').value = end
    get('date-apply').listeners.click()
    await settle()
    assert.equal(calls.length, 1, 'invalid dates do not reach the worker')
    assert.equal(get('date-error').hidden, false)
  }
  get('start-date').value = get('end-date').value = '2026-11-03'
  get('date-apply').listeners.click()
  await settle()
  assert.deepEqual(calls.at(-1), { name: 'usage.report', input: { range: 'custom', includeCache: true, startDate: '2026-11-03', endDate: '2026-11-03' } })
  assert.equal(get('date-error').hidden, true)
  assert.match(get('chips').innerHTML, /2026-11-03/)
  assert.match(get('date-hint').textContent, /Inclusive local dates/)
  click('ranges', { range: '30d' })
  await settle()
  assert.deepEqual(calls.at(-1).input, { range: '30d', includeCache: true })
})

test('model checkboxes query multiple or zero models, search options, and All models resets', async () => {
  const { calls, get, settle } = await mountPanel()
  get('models').listeners.change({ target: { dataset: { model: 'gpt-5-codex' }, checked: false } })
  await settle()
  assert.deepEqual(calls.at(-1).input.models, ['claude-opus-5-5'])
  get('models').listeners.change({ target: { dataset: { model: 'gpt-5-codex' }, checked: true } })
  await settle()
  assert.deepEqual(calls.at(-1).input.models, ['claude-opus-5-5', 'gpt-5-codex'])
  get('models').listeners.change({ target: { dataset: { model: 'gpt-5-codex' }, checked: false } })
  await settle()
  get('models').listeners.change({ target: { dataset: { model: 'claude-opus-5-5' }, checked: false } })
  await settle()
  assert.deepEqual(calls.at(-1).input.models, [])
  assert.match(get('chips').innerHTML, /No models selected/)
  get('model-search').listeners.input({ target: { value: 'gpt' } })
  assert.match(get('models').innerHTML, /gpt-5-codex/)
  assert.doesNotMatch(get('models').innerHTML, /claude-opus/)
  get('models-all').listeners.click()
  await settle()
  assert.equal(Object.hasOwn(calls.at(-1).input, 'models'), false)
  assert.equal(get('models-all').attrs['aria-pressed'], 'true')
})

test('cache switch requests consistent totals and token charts, and reset queries the worker', async () => {
  const { calls, get, settle } = await mountPanel()
  get('cache').listeners.change({ target: { checked: false } })
  await settle()
  assert.equal(calls.at(-1).input.includeCache, false)
  assert.equal(get('hero-total').textContent, '31.5k')
  assert.match(get('totals').innerHTML, /Processed tokens<\/span><strong>31.5k/)
  assert.doesNotMatch(get('totals').innerHTML, /Cache read|Cache write/)
  assert.doesNotMatch(get('type-legend').innerHTML, /Cache read|Cache write/)
  assert.doesNotMatch(get('daily-legend').innerHTML, /Cache read|Cache write/)
  assert.doesNotMatch(get('mix-legend').innerHTML, /Cache read|Cache write/)
  assert.match(get('selection-summary').textContent, /Excludes cache tokens/)
  get('filters-reset').listeners.click()
  await settle()
  assert.deepEqual(calls.at(-1).input, { range: '7d', includeCache: true })
  assert.equal(get('chips').innerHTML, '')
})

test('date and model detail shows exact escaped rows and visible sort choices', async () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const { get, click, settle } = await mountPanel((input) => {
    const report = sampleReport(input.range, input.includeCache)
    report.byDayModel[1].model = hostile
    report.models.push(hostile)
    return report
  })
  assert.doesNotMatch(get('models').innerHTML, /<img/)
  click('bd-mode', { mode: 'day-model' })
  assert.match(get('breakdown').innerHTML, /Cache read/)
  assert.match(get('breakdown').innerHTML, /1,234,567/)
  assert.match(get('breakdown').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(get('breakdown').innerHTML, /<img/)
  const position = (text) => get('breakdown').innerHTML.indexOf(`<td>${text}</td>`)
  assert.ok(position('2026-11-03') < position('2026-11-02'))
  get('rank-sort').listeners.change({ target: { value: 'date-asc' } })
  assert.ok(position('2026-11-02') < position('2026-11-03'))
  get('rank-sort').listeners.change({ target: { value: 'tokens-desc' } })
  assert.ok(position('2026-11-02') < position('2026-11-03'))
  get('rank-sort').listeners.change({ target: { value: 'tokens-asc' } })
  assert.ok(position('2026-11-03') < position('2026-11-02'))
  get('cache').listeners.change({ target: { checked: false } })
  await settle()
  assert.match(get('rank-note').textContent, /Total excludes cache tokens/)
  assert.match(get('breakdown').innerHTML, /1,238,567/)
})

test('history empty state retains controls, source coverage and model options', async () => {
  const { get, click } = await mountPanel((input) => {
    const report = sampleReport(input.range, input.includeCache)
    report.totals.turns = 0
    report.byDayModel = []
    report.sources[0].latestRecordAt = '2026-11-03T10:00:00Z'
    return report
  })
  assert.equal(get('content').hidden, false)
  assert.match(get('status').textContent, /No recorded usage matches/)
  assert.match(get('models').innerHTML, /gpt-5-codex/)
  assert.match(get('sources').innerHTML, /Latest recorded usage/)
  click('bd-mode', { mode: 'day-model' })
  assert.match(get('breakdown').innerHTML, /colspan="9"/)
})


test('source roots have distinct short labels, neutral empty state and visible warnings', async () => {
  const first = '/Users/neo/Library/Application Support/orca/codex-accounts/26d99d19-example/home'
  const second = '/Users/neo/Library/Application Support/orca/codex-accounts/77aa1234-example/home'
  const { get } = await mountPanel((input) => {
    const report = sampleReport(input.range, input.includeCache)
    report.sources = [report.sources[0],
      { kind: 'folder', label: first, path: first, provider: 'codex', source: 'orca', state: 'ok', records: 5, latestRecordAt: '2026-11-03T10:00:00Z' },
      { kind: 'folder', label: second, path: second, provider: 'codex', source: 'orca', state: 'ok', records: 2 },
      { kind: 'folder', label: '/Users/neo/.claude', path: '/Users/neo/.claude', provider: 'claude', source: 'default', state: 'empty', records: 0, message: 'Folder not found' },
      { kind: 'folder', label: '/missing/backup', path: '/missing/backup', provider: 'claude', source: 'extra', state: 'warning', records: 0, message: 'Folder not found' },
    ]
    return report
  })
  const html = get('sources').innerHTML
  assert.match(html, /Codex · Orca root · 26d99d19/)
  assert.match(html, /Codex · Orca root · 77aa1234/)
  assert.match(html, /Claude · Default · \.claude/)
  assert.match(html, /class="src empty"/)
  assert.match(html, /No transcripts/)
  assert.match(html, /<details class="source-details"><summary>4 local sources · 1 warning/)
  assert.ok(html.indexOf('class="src warning"') < html.indexOf('<details'), 'warnings are visible outside the collapsed root list')
  assert.match(html, /Source: orca/)
  assert.match(html, /Latest recorded usage/)
  assert.ok(html.includes(first), 'the full root path remains in the tooltip')
  assert.doesNotMatch(html, /<span class="name">\/Users/)
  assert.match(get('notice').textContent, /^Claude · Folder · backup: Folder not found$/)
})


test('an open filters menu stays within the resized viewport and leaves its footer reachable', async () => {
  const { get, viewport, events } = await mountPanel()
  const pop = get('filters-pop')
  pop.hidden = true
  let anchor = { left: 700, top: 180, bottom: 214, width: 100, height: 34 }
  get('filters-btn').getBoundingClientRect = () => anchor
  pop.getBoundingClientRect = () => ({ width: 300, height: 680 })
  viewport.innerWidth = 1000
  viewport.innerHeight = 900
  get('filters-btn').listeners.click()
  const box = () => ({ left: anchor.left + parseFloat(pop.style.left), right: anchor.left + parseFloat(pop.style.left) + 300 })
  assert.ok(box().left >= 8 && box().right <= 992, 'opening clamps the menu to the viewport')
  viewport.innerWidth = 380
  viewport.innerHeight = 600
  anchor = { ...anchor, left: 145, top: 250, bottom: 284 }
  events.resize()
  assert.ok(box().left >= 8 && box().right <= 372, 'resizing repositions an already open menu immediately')
  assert.ok(parseFloat(pop.style.maxHeight) <= 600 - anchor.bottom - 6, 'the menu scroll area accounts for its distance from the top')
  assert.equal(pop.style.bottom, 'auto')
  // A short window leaves more room above the anchor; the same scroll area keeps Done reachable.
  viewport.innerHeight = 340
  events.resize()
  assert.equal(pop.style.top, 'auto')
  assert.equal(pop.style.bottom, 'calc(100% + 6px)')
  assert.ok(parseFloat(pop.style.maxHeight) <= anchor.top - 6)
  assert.equal(pop.hidden, false)
  get('filters-done').listeners.click()
  assert.equal(pop.hidden, true)
})

test('Breakdown takes the custom dates but not the model and cache-token options, which it hides', async () => {
  const { calls, get, click, settle } = await mountPanel()
  get('start-date').value = '2026-11-01'
  get('end-date').value = '2026-11-02'
  get('date-apply').listeners.click()
  await settle()
  get('cache').listeners.change({ target: { checked: false } })
  await settle()
  click('view', { view: 'breakdown' })
  await settle()
  await settle()
  const request = calls.find((c) => c.name === 'usage.breakdown')
  assert.deepEqual(request.input, { range: 'custom', startDate: '2026-11-01', endDate: '2026-11-02' })
  assert.equal(get('sec-models').hidden, true)
  assert.doesNotMatch(get('chips').innerHTML, /No cache tokens/)
  assert.match(get('chips').innerHTML, /2026-11-01/)
})

test('a folder pill is a toggle: clicking it asks the worker to turn the folder off or on, then reloads', async () => {
  let off = false
  const { calls, get, settle } = await mountPanel((input) => {
    const report = sampleReport(input.range, input.includeCache)
    report.sources = [report.sources[0],
      { kind: 'folder', label: '/Users/neo/.codex', path: '/Users/neo/.codex', provider: 'codex', source: 'default', state: off ? 'off' : 'ok', records: off ? 0 : 3 },
    ]
    return report
  })
  assert.match(get('sources').innerHTML, /<button type="button" class="src ok" data-source-path="\/Users\/neo\/\.codex" aria-pressed="true"/)
  assert.doesNotMatch(get('sources').innerHTML, /<button[^>]*data-source-path[^>]*>[^]*This machine/, 'the machine pill is not a toggle')
  const button = { disabled: false, dataset: { sourcePath: '/Users/neo/.codex' }, getAttribute: () => 'true' }
  off = true
  get('sources').listeners.click({ target: { closest: () => button } })
  await settle()
  const toggle = calls.find((c) => c.name === 'sources.toggle')
  assert.deepEqual(toggle.input, { path: '/Users/neo/.codex', enabled: false })
  assert.equal(calls.at(-1).name, 'usage.report', 'the report reloads after the toggle')
  assert.match(get('sources').innerHTML, /class="src off"[^>]*aria-pressed="false"/)
  assert.match(get('sources').innerHTML, /turned off/)
  assert.match(get('sources').innerHTML, /1 local source · 1 off/)
})
