// Panel controller: asks the worker for a Report and renders it. Knows nothing about transcripts.
import { stackedBars, calendarHeatmap, punchCard, donut, hBars, sparkline, areaTrend, segmentBar, providerColor, compact, esc, TOKEN_KEYS, TOKEN_LABELS, TOKEN_COLORS, PROVIDER_LABELS } from './charts.mjs'
import { pixelBanner } from './art.mjs'
import { headline, tree, findings, notAnalysed, legend, priceLine, syncBody, changedSyncRows } from './breakdown.js'
import { normalizeQuery, localDay, dayKey, MIN_USAGE_DATE } from '../core/query.mjs'

const $ = (id) => document.getElementById(id)
const host = globalThis.orca
const state = { view: 'usage', range: '1d', startDate: '', endDate: '', models: null, modelSearch: '', provider: 'all', host: 'all', scope: 'all', cache: true, metric: 'tokens', breakdown: 'model', sort: 'default', report: null, busy: false, bd: null, bdPath: [], prices: null, sync: null }
const NOTE_KEY = 'usage-insights.prices-note.1.2.0'

function money(n) {
  const v = Number(n) || 0
  return '$' + (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2))
}
// One decimal, never rounding up to 100.0% unless it is exactly 100%.
function pct1(x) {
  const v = (Number(x) || 0) * 100
  const shown = v >= 100 ? 100 : Math.min(99.9, Math.round(v * 10) / 10)
  return `${shown.toFixed(1)}%`
}
function pct(x) {
  return `${Math.round((Number(x) || 0) * 100)}%`
}
function prettyDay(day) {
  return new Date(day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function request(name, input) {
  if (host?.plugin?.request) return host.plugin.request(name, input, { timeoutMs: 120000 })
  if (globalThis.__USAGE_PREVIEW__) return globalThis.__USAGE_PREVIEW__(name, input)
  throw new Error('Orca host is not available.')
}

// Breakdown splits cost, so it takes the dates but not the model or cache-token options.
function filterInput({ usage = false } = {}) {
  const dates = state.range === 'custom' ? { startDate: state.startDate, endDate: state.endDate } : {}
  const input = usage
    ? normalizeQuery({ range: state.range, ...dates, includeCache: state.cache, ...(state.models === null ? {} : { models: state.models }) })
    : { range: state.range, ...dates }
  if (state.provider !== 'all') input.providers = [state.provider]
  if (state.host !== 'all') input.hosts = [state.host]
  if (state.scope !== 'all') input.scope = state.scope
  return input
}

async function load(kind = 'usage.report') {
  if (state.busy) {
    // A change that lands mid-request triggers one more load when this one finishes.
    state.again = kind === 'usage.refresh' ? state.again || 'usage.report' : 'usage.report'
    return
  }
  state.busy = true
  $('refresh').classList.add('spin')
  $('refresh').disabled = true
  $('app').setAttribute('aria-busy', 'true')
  if (!state.report) {
    $('status').hidden = true
    $('skeleton').hidden = false
  }
  try {
    state.report = await request(kind, filterInput({ usage: true }))
    render()
    if (state.view === 'breakdown') setTimeout(() => loadBreakdown(), 0)
    $('live').textContent = kind === 'usage.refresh' ? `Refreshed. ${compact(state.report.totals.total)} tokens in range.` : ''
  } catch (err) {
    showStatus(`Couldn't load usage: ${err?.message || err}`, true)
  } finally {
    state.busy = false
    $('refresh').classList.remove('spin')
    $('refresh').disabled = false
    if (state.again) {
      const next = state.again
      state.again = null
      setTimeout(() => load(next), 0)
    }
    if ($('skeleton')) $('skeleton').hidden = true
    $('app').setAttribute('aria-busy', 'false')
  }
}

function showStatus(text, isError = false) {
  const el = $('status')
  el.textContent = text
  el.classList.toggle('error', isError)
  el.hidden = false
  if (isError || !state.report) $('content').hidden = true
}

function tile(label, value, sub = '', extra = '') {
  return `<div class="tile"><span class="label">${esc(label)}</span><span class="value" title="${esc(value)}">${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${extra}</div>`
}

// One tile for both cache measures: hit rate as the headline (cache writes count as misses),
// reuse underneath (Orca's built-in measure), and a bar of where input tokens came from.
function cacheTile(t) {
  const hit = t.cacheHitRate ?? t.cacheReuseRate
  const parts = [
    { label: 'Cache read', value: t.cacheRead || 0, color: TOKEN_COLORS.cacheRead },
    { label: 'Cache write', value: t.cacheWrite || 0, color: TOKEN_COLORS.cacheWrite },
    { label: 'Uncached input', value: t.input || 0, color: TOKEN_COLORS.input },
  ]
  const tip = esc(JSON.stringify({
    title: 'Cache',
    rows: [
      ['', 'Cache use as recorded, with or without cache tokens in the totals'],
      ['Hit rate', pct1(hit)],
      ['', 'read ÷ (read + write + uncached)'],
      ['Reuse', pct1(t.cacheReuseRate)],
      ['', 'read ÷ (read + uncached)'],
      ...parts.map((p) => [p.label, p.value]),
    ],
  }))
  return `<div class="tile tile-cache" data-tip="${tip}" tabindex="0" aria-label="Cache hit rate ${pct1(hit)}, reuse ${pct1(t.cacheReuseRate)}">
    <span class="label">Cache hit rate</span>
    <span class="value">${pct1(hit)}</span>
    <div class="meter">${segmentBar(parts, { width: 200, height: 6, id: 'cache-meter' })}</div>
    <span class="sub">${pct1(t.cacheReuseRate)} reuse · ${compact(t.cacheWrite)} written</span>
  </div>`
}

// Non-default filters, shown as removable chips beside the Filters button and counted on it.
function activeFilters() {
  const out = []
  if (state.scope !== 'all') out.push({ key: 'scope', label: 'Worktrees only' })
  if (state.provider !== 'all') out.push({ key: 'provider', label: PROVIDER_LABELS[state.provider] || state.provider })
  if (state.host !== 'all') out.push({ key: 'host', label: hostLabel(state.host) })
  if (state.range === 'custom') out.push({ key: 'range', label: state.startDate === state.endDate ? state.startDate : `${state.startDate} – ${state.endDate}` })
  // Breakdown splits cost by what it went on, so the model and cache-token options don't apply there.
  if (state.view !== 'breakdown') {
    if (state.models !== null) out.push({ key: 'models', label: state.models.length ? `Models: ${state.models.join(', ')}` : 'No models selected' })
    if (!state.cache) out.push({ key: 'cache', label: 'No cache tokens' })
  }
  return out
}

function renderChips() {
  const list = activeFilters()
  const x = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  $('chips').innerHTML = list.map((f) => `<button class="chip" data-clear="${f.key}" aria-label="Remove filter: ${esc(f.label)}">${esc(f.label)}${x}</button>`).join('')
  $('filters-count').hidden = !list.length
  $('filters-count').textContent = String(list.length)
  $('filters-btn').setAttribute('aria-label', list.length ? `Filters, ${list.length} active` : 'Filters')
}

// Clears one filter (or all). Every filter is part of the worker query, the cache-token option included.
function clearFilter(key) {
  if (key === 'scope' || key === 'all') state.scope = 'all'
  if (key === 'provider' || key === 'all') state.provider = 'all'
  if (key === 'host' || key === 'all') state.host = 'all'
  if (key === 'cache' || key === 'all') state.cache = true
  if (key === 'models' || key === 'all') {
    state.models = null
    state.modelSearch = ''
    $('model-search').value = ''
  }
  if (key === 'range' || (key === 'all' && state.range === 'custom')) {
    state.range = '1d'
    $('custom-range').hidden = true
    $('date-error').hidden = true
  }
  load()
}

// The menu sits under its button, moved left to stay on screen, and opens upward when there is more room
// above. It scrolls inside the height it gets. Recomputed on open, render and resize.
function positionMenu() {
  const pop = $('filters-pop')
  if (pop.hidden) return
  const anchor = $('filters-btn').getBoundingClientRect()
  const left = anchor.left || 0
  const viewportWidth = window.innerWidth || 800
  const viewportHeight = window.innerHeight || 600
  const width = pop.getBoundingClientRect().width
  pop.style.left = `${Math.max(8 - left, Math.min(0, viewportWidth - left - width - 8))}px`
  const below = Math.max(0, viewportHeight - (anchor.bottom || 0) - 14)
  const above = Math.max(0, (anchor.top || 0) - 14)
  const openAbove = below < 180 && above > below
  pop.style.top = openAbove ? 'auto' : 'calc(100% + 6px)'
  pop.style.bottom = openAbove ? 'calc(100% + 6px)' : 'auto'
  pop.style.maxHeight = `${Math.min(680, openAbove ? above : below)}px`
}

function setMenu(open) {
  const pop = $('filters-pop')
  const btn = $('filters-btn')
  if (open === !pop.hidden) return
  pop.hidden = !open
  btn.setAttribute('aria-expanded', String(open))
  if (open) positionMenu()
  if (open) (pop.querySelector('.opt-list [aria-checked="true"]') || pop.querySelector('button, input'))?.focus()
  else btn.focus()
}

function hostLabel(h) {
  return h === 'local' ? 'This machine' : String(h).replace(/^ssh:/, '')
}

function ago(iso) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const SOURCE_ICONS = {
  local: '<path d="M4 5h16v10H4z"/><path d="M8 19h8M12 15v4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ssh: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
}
const STATE_WORDS = { empty: 'No transcripts', ok: 'Up to date', warning: 'Warning', error: 'Error', loading: 'Loading…' }

// Labels name the transcript root; they never claim which subscription or account a history belongs to.
function sourceLabel(source) {
  if (source.kind !== 'folder') return source.label
  const provider = source.provider === 'claude' ? 'Claude' : PROVIDER_LABELS[source.provider] || source.provider || 'Transcripts'
  const parts = String(source.path || source.label || '').split(/[\\/]+/).filter(Boolean)
  const name = parts.at(-1) || 'root'
  const type = { orca: 'Orca root', default: 'Default', environment: 'Env root', extra: 'Folder' }[source.source] || 'Folder'
  let id = name
  if (source.source === 'orca') id = (name === 'home' ? parts.at(-2) || name : name).slice(0, 8)
  else if (name === 'home' || name === 'claude' || name === 'codex') id = parts.slice(-2).join('/')
  return `${provider} · ${type} · ${id}`
}

// One pill per source (this machine, each SSH host, each root or folder with a problem): state, size,
// freshness. Healthy roots fold into a details list. Errors and warnings show their message on hover and
// to screen readers.
function renderSources(r) {
  const list = r.sources || []
  const el = $('sources')
  const folders = list.filter((s) => s.kind === 'folder')
  const multi = list.some((s) => s.kind === 'ssh' || (s.kind === 'folder' && s.source === 'extra')) || list.some((s) => s.state !== 'ok' && s.state !== 'empty')
  const wasOpen = el.querySelector('details')?.open || false
  el.hidden = !list.length
  if (!list.length) return
  const pill = (s) => {
    const state = STATE_WORDS[s.state] ? s.state : 'ok'
    const meta = state === 'empty' ? 'no transcripts' : state === 'loading' ? 'connecting…' : state === 'error' ? 'failed' : state === 'warning' ? (s.message || 'check settings').toLowerCase().replace(/\.$/, '') : `${compact(s.records || 0)} turns · ${ago(s.lastScanAt)}`
    const detail = [s.path || '', s.source ? `Source: ${s.source}` : '', STATE_WORDS[state], s.message, s.files !== undefined ? `${s.files} files` : '', s.ms ? `scanned in ${s.ms} ms` : '', s.latestRecordAt ? `Latest recorded usage: ${new Date(s.latestRecordAt).toLocaleString()}` : ''].filter(Boolean).join(' · ')
    const icon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SOURCE_ICONS[s.kind] || SOURCE_ICONS.local}</svg>`
    const label = sourceLabel(s)
    return `<span class="src ${state}" title="${esc(detail)}" aria-label="${esc(`${label}: ${detail}`)}">${icon}<span class="state" aria-hidden="true"></span><span class="name">${esc(label)}</span><span class="meta">${esc(meta)}</span></span>`
  }
  const healthy = folders.filter((s) => s.state === 'ok' || s.state === 'empty')
  const prominent = list.filter((s) => !healthy.includes(s))
  const warnings = folders.length - healthy.length
  const roots = healthy.length ? `<details class="source-details"${wasOpen ? ' open' : ''}><summary>${folders.length} local ${folders.length === 1 ? 'source' : 'sources'}${warnings ? ` · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}</summary><div class="source-roots">${healthy.map(pill).join('')}</div></details>` : ''
  const hint = multi ? '' : '<span class="hint">Add folders or SSH hosts in Settings → Plugins → Usage Insights.</span>'
  el.innerHTML = prominent.map(pill).join('') + roots + hint
  const problems = list.filter((s) => s.state === 'error' || s.state === 'warning')
  const notes = []
  if (r.scopeError) notes.push(`${r.scopeError.replace(/\.?$/, '.')} Showing all usage instead.`)
  for (const s of problems) notes.push(`${sourceLabel(s)}: ${s.message || STATE_WORDS[s.state]}`)
  $('notice').hidden = !notes.length
  $('notice').textContent = notes.join('  ·  ')
}

// The model list keeps a selected model that the current filters no longer have, so it can be unticked.
function renderModels(r) {
  const choices = [...new Set([...(r.models || (r.byModel || []).map((m) => m.model)), ...(state.models || [])])].sort()
  const query = state.modelSearch.trim().toLowerCase()
  const shown = choices.filter((model) => model.toLowerCase().includes(query))
  const focusedModel = document.activeElement?.dataset?.model
  $('models-all').setAttribute('aria-pressed', String(state.models === null))
  $('models').innerHTML = shown.length ? shown.map((model) => `<label class="model-option"><input type="checkbox" data-model="${esc(model)}"${state.models === null || state.models.includes(model) ? ' checked' : ''}><span>${esc(model)}</span></label>`).join('') : '<p class="muted model-empty">No matching models.</p>'
  if (focusedModel) [...$('models').querySelectorAll('input')].find((el) => el.dataset.model === focusedModel)?.focus()
}

function applyDates() {
  const startDate = $('start-date').value
  const endDate = $('end-date').value
  try {
    normalizeQuery({ range: 'custom', startDate, endDate })
  } catch (err) {
    $('date-error').textContent = `Pick a start date from ${MIN_USAGE_DATE} and an end date no later than today, start first. ${err.message}`
    $('date-error').hidden = false
    $('start-date').setAttribute('aria-invalid', 'true')
    $('end-date').setAttribute('aria-invalid', 'true')
    return
  }
  $('date-error').hidden = true
  $('start-date').setAttribute('aria-invalid', 'false')
  $('end-date').setAttribute('aria-invalid', 'false')
  state.range = 'custom'
  state.startDate = startDate
  state.endDate = endDate
  load()
}

function timeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time' } catch { return 'local time' }
}

function legendItem(color, label, value) {
  return `<li><span class="sw" style="background:${color}"></span>${esc(label)}${value !== undefined ? ` <span class="v">${esc(value)}</span>` : ''}</li>`
}

export function render() {
  renderView()
  const r = state.report
  if (!r) return
  renderNote()
  const includeCache = r.includeCache ?? state.cache
  const keys = includeCache ? TOKEN_KEYS : ['input', 'output']
  const t = r.totals
  const shownTotal = keys.reduce((s, k) => s + (t[k] || 0), 0)
  const widthOf = (id, min = 280) => Math.max(min, Math.round($(id).clientWidth || 0))
  const hero = $('banner')
  const bw = hero.clientWidth || 360
  const bh = hero.clientHeight || 112
  // One art pixel ≈ 3.3 screen px, so the scene fills any panel width without cropping.
  $('banner').innerHTML = pixelBanner(r, { h: 34, w: Math.max(80, Math.min(400, Math.round((34 * bw) / bh))) })
  $('updated').textContent = `Updated ${new Date(r.generatedAt).toLocaleString()}`
  $('hero-total').textContent = compact(shownTotal)
  $('hero-total').title = `${shownTotal.toLocaleString('en-US')} tokens`
  const zone = timeZoneName()
  const span = r.startDate && r.endDate ? (r.startDate === r.endDate ? r.startDate : `${r.startDate} – ${r.endDate}`) : 'All history'
  $('selection-summary').textContent = `${span} · ${zone} · ${includeCache ? 'Includes cache tokens' : 'Excludes cache tokens'} · all available account histories in the selected sources`
  $('date-hint').textContent = `Inclusive local dates (${zone}). Use the same date for one day.`
  $('hero-sub').textContent = `tokens · ${money(t.costUsd)}${t.hasUnpriced ? '+' : ''} est.`

  // Controls reflect state.
  for (const b of $('ranges').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.range === state.range))
  for (const b of $('metric').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.metric === state.metric))
  for (const b of $('bd-mode').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === state.breakdown))
  const providers = r.providers || []
  const hosts = r.hosts || []
  // Filters menu: option rows keep focus across the re-render they trigger.
  const focused = document.activeElement
  const focusGroup = focused?.closest?.('.opt-list')?.id
  const opt = (attr, value, label, checked) => `<button role="radio" data-${attr}="${esc(value)}" aria-checked="${checked}"><span class="dot" aria-hidden="true"></span><span><b>${esc(label)}</b></span></button>`
  const showHosts = hosts.length > 1 || state.host !== 'all'
  $('sec-hosts').hidden = !showHosts
  $('hosts').innerHTML = showHosts ? ['all', ...hosts].map((h) => opt('host', h, h === 'all' ? 'All machines' : hostLabel(h), h === state.host)).join('') : ''
  const showProviders = providers.length > 1 || state.provider !== 'all'
  $('sec-providers').hidden = !showProviders
  $('providers').innerHTML = showProviders ? ['all', ...providers].map((p) => opt('provider', p, p === 'all' ? 'All providers' : PROVIDER_LABELS[p] || p, p === state.provider)).join('') : ''
  for (const b of $('scope').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.scope === state.scope))
  $('cache').checked = state.cache
  renderModels(r)
  renderChips()
  if (focusGroup && !$('filters-pop').hidden) $(focusGroup)?.querySelector('[aria-checked="true"]')?.focus()

  const empty = t.turns === 0
  $('status').hidden = !empty || state.view === 'breakdown'
  if (empty) {
    $('status').textContent = 'No recorded usage matches these dates and filters. Try another range, select All models, or reset filters. History appears only when it is available in the selected sources.'
    $('status').classList.remove('error')
  }
  $('content').hidden = state.view === 'breakdown'

  const daySpark = sparkline(r.daily.map((d) => keys.reduce((s, k) => s + (d[k] || 0), 0)))
  $('tiles').innerHTML = [
    tile('Tokens', compact(shownTotal), `${compact(t.input)} in · ${compact(t.output)} out`, `<div class="spark-wrap">${daySpark}</div>`),
    tile('Est. cost', money(t.costUsd) + (t.hasUnpriced ? '+' : ''), t.hasUnpriced ? 'some models unpriced' : 'at API list prices'),
    tile('Today', compact(r.today.total), r.today.costUsd == null ? '—' : money(r.today.costUsd)),
    cacheTile(t),
    tile('Sessions / turns', `${t.sessions.toLocaleString()} / ${t.turns.toLocaleString()}`),
    tile('Streak', `${r.streak.current} day${r.streak.current === 1 ? '' : 's'}`, `longest ${r.streak.longest}`),
  ].join('')

  const isCost = state.metric === 'cost'
  if (isCost) {
    $('daily-sub').textContent = 'Estimated cost by day, at API list prices.'
    $('daily').innerHTML = stackedBars(r.daily, { keys: ['costUsd'], colors: { costUsd: 'var(--s1)' }, labels: { costUsd: 'Cost' }, fmt: money, width: widthOf('daily'), height: 190 })
    $('daily-legend').innerHTML = legendItem('var(--s1)', 'Cost', money(t.costUsd))
  } else {
    $('daily-sub').textContent = includeCache ? 'Input, output, cache read and cache write by day.' : 'Input and output by day (cache tokens left out of every total).'
    $('daily').innerHTML = stackedBars(r.daily, { keys, width: widthOf('daily'), height: 190 })
    $('daily-legend').innerHTML = keys.map((k) => legendItem(TOKEN_COLORS[k], TOKEN_LABELS[k], compact(t[k]))).join('')
  }
  renderOverview(r, keys, widthOf)
  renderBreakdown(r)
  renderSources(r)
  syncRadioTabs()
  positionMenu()

  $('peak').textContent = r.peakDay ? `Best: ${prettyDay(r.peakDay.day)} · ${compact(r.peakDay.total)}` : ''
  $('calendar').innerHTML = calendarHeatmap(r.calendar)
  $('punch').innerHTML = punchCard(r.punchCard)

  const segs = keys.map((k) => ({ label: TOKEN_LABELS[k], value: t[k] || 0, color: TOKEN_COLORS[k] }))
  $('donut').innerHTML = donut(segs)
  $('mix-legend').innerHTML = segs.map((s) => legendItem(s.color, s.label, `${compact(s.value)} · ${shownTotal ? ((s.value / shownTotal) * 100).toFixed(1) : '0.0'}%`)).join('')

  $('projects').innerHTML = hBars(r.byProject.map((p) => ({ label: p.project, value: p.total })), { width: widthOf('projects') })
}

// Provider split, smoothed trend, totals strip and the one-line token-type bar.
function renderOverview(r, keys, widthOf) {
  const t = r.totals
  const isCost = state.metric === 'cost'
  const fmt = isCost ? money : compact
  $('ov-total').textContent = isCost ? money(t.costUsd) + (t.hasUnpriced ? '+' : '') : compact(keys.reduce((a, k) => a + (t[k] || 0), 0))
  $('ov-sessions').textContent = `${t.sessions.toLocaleString()} sessions · ${t.turns.toLocaleString()} turns`
  $('ov-providers').innerHTML = (r.byProvider || []).map((p, i) => {
    const sessions = p.sessions !== undefined ? `<small>${p.sessions.toLocaleString()} sessions</small>` : ''
    const amount = isCost ? (p.costUsd == null ? 'unpriced' : money(p.costUsd)) : compact(p.total)
    const other = isCost ? `${compact(p.total)} tokens` : p.costUsd == null ? 'cost unpriced' : money(p.costUsd)
    return `<li><span class="sw" style="background:${providerColor(p.provider, i)}"></span><span class="name">${esc(PROVIDER_LABELS[p.provider] || p.provider)}${sessions}</span><span class="amt">${esc(amount)}</span><span class="meta">${pct(p.share)} of tokens · ${esc(other)}</span></li>`
  }).join('')
  const byHost = r.byHost || []
  $('ov-hosts').hidden = byHost.length < 2
  $('ov-hosts').innerHTML = byHost.length < 2 ? '' : byHost.map((h) => {
    const amount = isCost ? (h.costUsd == null ? 'unpriced' : money(h.costUsd)) : compact(h.total)
    return `<li><span class="sw" style="background:var(--muted-fg)"></span><span class="name">${esc(hostLabel(h.host))}<small>${(h.sessions ?? 0).toLocaleString()} sessions</small></span><span class="amt">${esc(amount)}</span><span class="meta">${pct(h.share)} of tokens</span></li>`
  }).join('')
  $('trend-title').textContent = isCost ? 'Daily cost by provider' : 'Daily tokens by provider'
  const all = r.seriesByProvider || [{ provider: r.byProvider?.[0]?.provider || 'claude', daily: r.daily }]
  const live = all.filter((s) => s.daily.some((d) => d.total > 0))
  const series = live.length ? live : all
  $('trend').innerHTML = areaTrend(series, { metric: isCost ? 'costUsd' : 'total', fmt, axisFmt: isCost ? (v) => '$' + compact(v) : compact, width: widthOf('trend'), height: 210 })
  const cells = [
    ['Processed tokens', compact(t.total)],
    ...(keys.includes('cacheRead') ? [['Cache read', compact(t.cacheRead)], ['Cache write', compact(t.cacheWrite)]] : []),
    ['Uncached input', compact(t.input)],
    ['Output', compact(t.output)],
    ['Cache savings', t.cacheSavingsUsd === undefined ? '—' : money(t.cacheSavingsUsd)],
  ]
  $('totals').innerHTML = cells.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')
  const segs = keys.map((k) => ({ label: TOKEN_LABELS[k], value: t[k] || 0, color: TOKEN_COLORS[k] }))
  $('typebar').innerHTML = segmentBar(segs, { width: widthOf('typebar'), id: 'typebar' })
  $('type-legend').innerHTML = segs.map((s) => legendItem(s.color, s.label, compact(s.value))).join('')
}

// Ranked table by model or by day, or every date x model pair with exact counts. The thin line under each
// name is its share of the largest row.
function renderBreakdown(r) {
  const isCost = state.metric === 'cost'
  const byModel = state.breakdown === 'model'
  const detailed = state.breakdown === 'day-model'
  const includeCache = r.includeCache ?? state.cache
  const exact = (n) => Number(n || 0).toLocaleString('en-US')
  const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const modelCompare = (a, b) => text(String(a.model ?? a.name ?? ''), String(b.model ?? b.name ?? '')) || text(String(a.provider ?? ''), String(b.provider ?? ''))
  const dateCompare = (a, b) => text(String(a.day ?? ''), String(b.day ?? ''))
  const sortRows = (rows) => {
    if (state.sort === 'date-desc') rows.sort((a, b) => dateCompare(b, a) || modelCompare(a, b))
    else if (state.sort === 'date-asc') rows.sort((a, b) => dateCompare(a, b) || modelCompare(a, b))
    else if (state.sort === 'model-asc') rows.sort((a, b) => modelCompare(a, b) || dateCompare(b, a))
    else if (state.sort === 'tokens-desc') rows.sort((a, b) => b.tokens - a.tokens || modelCompare(a, b))
    else if (state.sort === 'tokens-asc') rows.sort((a, b) => a.tokens - b.tokens || modelCompare(a, b))
    else if (detailed) rows.sort((a, b) => dateCompare(b, a) || modelCompare(a, b))
    else if (isCost) rows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    return rows
  }
  $('rank-sort').value = state.sort
  $('rank-note').textContent = detailed
    ? `Exact recorded token counts. Input, output, cache read and cache write are raw categories; Total ${includeCache ? 'includes' : 'excludes'} cache tokens.`
    : `Totals ${includeCache ? 'include' : 'exclude'} cache tokens. Hover a token count for its exact value.`
  $('breakdown').classList.toggle('detail', detailed)
  if (detailed) {
    const rows = sortRows((r.byDayModel || []).map((row) => ({ ...row, tokens: row.total })))
    const columns = ['Date', 'Provider', 'Model', 'Input', 'Output', 'Cache read', 'Cache write', 'Total', 'Cost']
    const head = `<thead><tr>${columns.map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead>`
    const body = rows.length
      ? rows.map((row) => `<tr><td>${esc(row.day)}</td><td>${esc(PROVIDER_LABELS[row.provider] || row.provider)}</td><td>${esc(row.model)}</td>${['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map((key) => `<td>${esc(exact(row[key]))}</td>`).join('')}<td${row.costUsd == null ? ' class="muted"' : ''}>${row.costUsd == null ? '—' : money(row.costUsd)}</td></tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="muted">No recorded usage matches these dates and filters.</td></tr>`
    $('breakdown').innerHTML = head + `<tbody>${body}</tbody>`
    return
  }
  const providers = r.byProvider || []
  const colorOf = (p) => providerColor(p, Math.max(0, providers.findIndex((x) => x.provider === p)))
  const total = r.totals.total || 0
  let rows
  if (byModel) {
    rows = (r.byModel || []).map((m) => ({ name: m.model, model: m.model, provider: m.provider, cost: m.costUsd, tokens: m.total, share: m.share }))
  } else {
    rows = [...r.daily].reverse().filter((d) => d.total > 0).map((d) => ({ name: prettyDay(d.day), day: d.day, cost: d.costUsd, tokens: d.total, share: total ? d.total / total : 0 }))
  }
  sortRows(rows)
  const key = (x) => (isCost ? x.cost ?? 0 : x.tokens)
  const top = Math.max(0, ...rows.map(key))
  const head = `<thead><tr><th scope="col">#</th><th scope="col">${byModel ? 'Model' : 'Day'}</th><th scope="col">Cost</th><th scope="col">Share</th><th scope="col">Tokens</th></tr></thead>`
  const body = rows.length
    ? rows.map((x, i) => {
        const color = byModel ? colorOf(x.provider) : 'var(--s1)'
        const width = top > 0 ? Math.max(2, (key(x) / top) * 100) : 0
        const dot = byModel && x.provider ? `<span class="sw" style="background:${color}"></span>` : ''
        return `<tr><td class="rank">${i + 1}</td><td class="name"><span class="nm">${dot}${esc(x.name)}</span><span class="share-line" style="width:${width.toFixed(1)}%;background:${color}"></span></td><td${x.cost == null ? ' class="muted"' : ''}>${x.cost == null ? '—' : money(x.cost)}</td><td class="muted">${x.share < 0.001 && x.share > 0 ? '&lt;0.1%' : (x.share * 100).toFixed(1) + '%'}</td><td title="${esc(exact(x.tokens))} tokens">${esc(compact(x.tokens))}</td></tr>`
      }).join('')
    : `<tr><td colspan="5" class="muted" style="text-align:center">No recorded usage matches these dates and filters.</td></tr>`
  $('breakdown').innerHTML = head + `<tbody>${body}</tbody>`
}

function renderView() {
  const bd = state.view === 'breakdown'
  for (const b of $('view').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.view === state.view))
  $('metric').hidden = bd
  $('sec-cache').hidden = bd
  $('sec-models').hidden = bd
  $('selection-summary').hidden = bd
  renderChips()
  $('content').hidden = bd || !state.report
  $('bd').hidden = !bd
  if (bd) $('status').hidden = true
  $('prices').hidden = !state.prices
  $('prices').innerHTML = priceLine(state.prices)
}

// One-time 1.2.0 pricing note. localStorage can be missing or throw in frames; the note then shows again.
function renderNote() {
  let seen = false
  try { seen = globalThis.localStorage?.getItem(NOTE_KEY) === '1' } catch {}
  const el = $('note')
  if (seen || !el.hidden) return
  el.innerHTML = 'Prices now come from a per-model catalog with tiers and 1-hour cache writes, so some costs differ from earlier versions. <button class="link-btn" id="note-ok">Got it</button>'
  el.hidden = false
}

async function loadBreakdown() {
  if (state.bdBusy) { state.bdAgain = true; return }
  state.bdBusy = true
  $('bd-stale').hidden = true
  if (!state.bd) {
    $('bd-status').textContent = 'Splitting your usage by file, command and tool… The first run reads the transcripts in this range and takes a few seconds.'
    $('bd-status').classList.remove('error')
    $('bd-status').hidden = false
  }
  try {
    const view = await request('usage.breakdown', { ...filterInput(), ...(state.bdPath.length ? { path: state.bdPath } : {}) })
    if (view?.loading) {
      const { done = 0, total = 0 } = view.loading
      $('bd-status').textContent = `Reading transcripts… ${done.toLocaleString()} of ${total.toLocaleString()} files. This view updates when it's done.`
      $('bd-status').classList.remove('error')
      $('bd-status').hidden = false
      state.bdLoading = true
      return
    }
    state.bdLoading = false
    state.bd = view
    state.bdPath = view.path || []
    renderBreakdownView()
  } catch (err) {
    $('bd-status').textContent = `Couldn't build the breakdown: ${err?.message || err}`
    $('bd-status').classList.add('error')
    $('bd-status').hidden = false
  } finally {
    state.bdBusy = false
    if (state.bdAgain) {
      state.bdAgain = false
      setTimeout(() => loadBreakdown(), 0)
    }
  }
}

function renderBreakdownView() {
  const v = state.bd
  if (!v) return
  $('bd-status').hidden = true
  $('bd-body').hidden = false
  $('bd-head').innerHTML = headline(v)
  const t = tree(v)
  $('bd-crumbs').innerHTML = t.crumbs
  $('bd-tree').innerHTML = t.rows
  $('bd-findings').innerHTML = findings(v)
  const not = notAnalysed(v)
  $('bd-not').hidden = !not
  $('bd-not').innerHTML = not
  $('bd-foot').textContent = legend(v)
}

async function loadPrices() {
  try {
    state.prices = await request('prices.status')
  } catch {
    state.prices = null
  }
  renderView()
}

async function priceAction(action) {
  if (action === 'sync') return openSync()
  try {
    await request(action === 'undo' ? 'prices.undo' : 'prices.reset')
    $('live').textContent = action === 'undo' ? 'Previous prices restored.' : 'Bundled prices restored.'
  } catch (err) {
    showStatus(`Couldn't change prices: ${err?.message || err}`, true)
  }
  await loadPrices()
}

async function openSync() {
  const dlg = $('sync-dlg')
  $('sync-body').innerHTML = '<p class="muted">Fetching LiteLLM and models.dev…</p>'
  $('sync-apply').disabled = true
  state.sync = null
  if (!dlg.open) dlg.showModal?.()
  try {
    state.sync = await request('prices.sync')
    $('sync-body').innerHTML = syncBody(state.sync)
    $('sync-apply').disabled = !changedSyncRows(state.sync.rows).some((r) => r.status !== 'overridden')
  } catch (err) {
    $('sync-body').innerHTML = `<p class="status error">Couldn't fetch prices: ${esc(err?.message || err)}</p>`
  }
}

async function applySync() {
  if (!state.sync) return
  const keys = [...$('sync-body').querySelectorAll('input[type=checkbox][data-key]')].filter((b) => b.checked && !b.disabled).map((b) => b.dataset.key)
  $('sync-apply').disabled = true
  try {
    await request('prices.apply', { diffId: state.sync.diffId, keys })
    $('sync-dlg').close?.()
    $('live').textContent = `${keys.length} price${keys.length === 1 ? '' : 's'} applied.`
    await loadPrices()
  } catch (err) {
    const stale = err?.code === 'stale_diff' || /stale_diff|out of date/.test(String(err?.message))
    $('sync-body').insertAdjacentHTML('afterbegin', `<p class="status error">${esc(stale ? 'Prices changed since this sync. Sync again.' : `Couldn't apply: ${err?.message || err}`)}</p>`)
    $('sync-apply').disabled = false
  }
}

async function openExplain(findingId) {
  const dlg = $('explain-dlg')
  $('explain-text').value = 'Building the prompt…'
  $('explain-size').textContent = ''
  if (!dlg.open) dlg.showModal?.()
  try {
    const res = await request('usage.explain', { ...filterInput(), findingId })
    $('explain-text').value = res.prompt
    $('explain-size').textContent = `≈ ${compact(res.estTokens)} tokens for your agent to read it`
  } catch (err) {
    $('explain-text').value = `Couldn't build the prompt: ${err?.message || err}`
  }
}

// Clipboard access can be blocked in a frame; selecting the text keeps a manual copy one keystroke away.
async function copyExplain() {
  const box = $('explain-text')
  box.focus()
  box.select()
  let ok = false
  try {
    await navigator.clipboard.writeText(box.value)
    ok = true
  } catch {
    try { ok = document.execCommand('copy') } catch {}
  }
  $('explain-copy').textContent = ok ? 'Copied' : 'Press Ctrl+C to copy'
  setTimeout(() => { $('explain-copy').textContent = 'Copy prompt' }, 2000)
}

function bindBreakdown() {
  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]')
    if (!b || b.dataset.view === state.view) return
    state.view = b.dataset.view
    renderView()
    if (state.view === 'breakdown') loadBreakdown()
    else if (state.report) render()
    else load()
  })
  $('bd-tree').addEventListener('click', (e) => {
    const b = e.target.closest('button.node[data-key]')
    if (!b) return
    state.bdPath = [...state.bdPath, b.dataset.key].slice(0, 8)
    loadBreakdown()
  })
  $('bd-crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button.crumb')
    if (!b) return
    state.bdPath = state.bdPath.slice(0, Number(b.dataset.depth) || 0)
    loadBreakdown()
  })
  $('bd-findings').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-explain]')
    if (b) openExplain(b.dataset.explain)
  })
  $('bd-stale').addEventListener('click', () => load())
  $('prices').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-price]')
    if (b) priceAction(b.dataset.price)
  })
  $('note').addEventListener('click', (e) => {
    if (!e.target.closest('#note-ok')) return
    try { globalThis.localStorage?.setItem(NOTE_KEY, '1') } catch {}
    $('note').hidden = true
  })
  for (const id of ['sync-dlg', 'explain-dlg']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) $(id).close?.()
    })
  }
  $('sync-apply').addEventListener('click', applySync)
  $('explain-copy').addEventListener('click', copyExplain)
}

// A finished Breakdown offers an update instead of reordering under the reader.
function onChanged() {
  loadPrices()
  if (state.view !== 'breakdown') return load()
  if (state.bdLoading || !state.bd) return loadBreakdown()
  $('bd-stale').hidden = false
  state.report = null
}

function bindTooltip() {
  const tip = $('tip')
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('[data-tip]')
    if (!el) { tip.hidden = true; return }
    let data
    try { data = JSON.parse(el.getAttribute('data-tip')) } catch { return }
    const fmt = (v) => (typeof v === 'number' ? `${compact(v)}${v >= 1000 ? ` (${v.toLocaleString()})` : ''}` : v)
    tip.innerHTML = `<b>${esc(data.title)}</b>` + data.rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(fmt(v))}</span></div>`).join('') + (data.total !== undefined ? `<div class="row"><span>Total</span><span>${esc(fmt(data.total))}</span></div>` : '')
    tip.hidden = false
    const pad = 12
    const { innerWidth: W, innerHeight: H } = window
    const rect = tip.getBoundingClientRect()
    tip.style.left = `${Math.min(W - rect.width - 4, e.clientX + pad)}px`
    tip.style.top = `${e.clientY + pad + rect.height > H ? e.clientY - rect.height - pad : e.clientY + pad}px`
  })
  document.addEventListener('pointerleave', () => { tip.hidden = true })
}

// Radio groups: arrow keys move the choice (and focus), as the radiogroup pattern expects.
function bindRadioKeys(group) {
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    const items = [...group.querySelectorAll('button[role="radio"]')]
    const at = items.indexOf(document.activeElement)
    if (at < 0) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
    items[next].focus()
    items[next].click()
  })
}

// Only the selected option is in the tab order (roving tabindex).
function syncRadioTabs() {
  for (const id of ['view', 'ranges', 'metric', 'scope', 'providers', 'hosts', 'bd-mode']) {
    const items = [...$(id).querySelectorAll('button[role="radio"]')]
    const checked = items.find((b) => b.getAttribute('aria-checked') === 'true') || items[0]
    for (const b of items) b.tabIndex = b === checked ? 0 : -1
  }
}

function bindControls() {
  for (const id of ['view', 'ranges', 'metric', 'scope', 'providers', 'hosts', 'bd-mode']) bindRadioKeys($(id))
  $('scope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scope]')
    if (!b || b.dataset.scope === state.scope) return
    state.scope = b.dataset.scope
    load()
  })
  $('hosts').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-host]')
    if (!b || b.dataset.host === state.host) return
    state.host = b.dataset.host
    load()
  })
  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]')
    if (!b) return
    if (b.dataset.range === 'custom') {
      // Custom opens the date fields; the range changes on Apply.
      $('custom-range').hidden = false
      if (!$('start-date').value) $('start-date').value = state.startDate || state.report?.startDate || dayKey(localDay())
      if (!$('end-date').value) $('end-date').value = state.endDate || state.report?.endDate || dayKey(localDay())
      $('start-date').focus()
      return
    }
    $('custom-range').hidden = true
    $('date-error').hidden = true
    if (b.dataset.range === state.range) return
    state.range = b.dataset.range
    load()
  })
  $('date-apply').addEventListener('click', applyDates)
  for (const id of ['start-date', 'end-date']) {
    $(id).min = MIN_USAGE_DATE
    $(id).max = dayKey(localDay())
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      applyDates()
    })
  }
  $('model-search').addEventListener('input', (e) => {
    state.modelSearch = e.target.value
    if (state.report) renderModels(state.report)
  })
  $('models-all').addEventListener('click', () => {
    if (state.models === null) return
    state.models = null
    load()
  })
  $('models').addEventListener('change', (e) => {
    const model = e.target.dataset?.model
    if (!model) return
    const selected = new Set(state.models === null ? state.report?.models || (state.report?.byModel || []).map((m) => m.model) : state.models)
    if (e.target.checked) selected.add(model)
    else selected.delete(model)
    state.models = [...selected].sort()
    load()
  })
  $('rank-sort').addEventListener('change', (e) => {
    state.sort = e.target.value
    if (state.report) renderBreakdown(state.report)
  })
  $('providers').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-provider]')
    if (!b || b.dataset.provider === state.provider) return
    state.provider = b.dataset.provider
    load()
  })
  $('metric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]')
    if (!b || b.dataset.metric === state.metric) return
    state.metric = b.dataset.metric
    render()
  })
  $('bd-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]')
    if (!b || b.dataset.mode === state.breakdown) return
    state.breakdown = b.dataset.mode
    render()
  })
  $('filters-btn').addEventListener('click', () => setMenu($('filters-pop').hidden))
  $('filters-done').addEventListener('click', () => setMenu(false))
  $('filters-reset').addEventListener('click', () => clearFilter('all'))
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-clear]')
    if (b) clearFilter(b.dataset.clear)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('filters-pop').hidden) {
      e.preventDefault()
      setMenu(false)
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if ($('filters-pop').hidden) return
    if (!e.target.closest?.('.filters-wrap')) {
      $('filters-pop').hidden = true
      $('filters-btn').setAttribute('aria-expanded', 'false')
    }
  })
  $('cache').addEventListener('change', (e) => {
    state.cache = e.target.checked
    load()
  })
  $('refresh').addEventListener('click', () => load('usage.refresh'))
  host?.plugin?.on?.('usage.changed', onChanged)
  host?.on?.('theme', () => state.report && render())
  // Charts are drawn at the container's pixel width, so redraw when the panel is resized.
  let lastW = 0
  let timer = 0
  globalThis.addEventListener?.('resize', () => {
    positionMenu()
    clearTimeout(timer)
    timer = setTimeout(() => {
      const w = document.body?.clientWidth || 0
      if (state.report && state.view === 'usage' && Math.abs(w - lastW) > 8) { lastW = w; render() }
    }, 120)
  })
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  bindControls()
  bindBreakdown()
  bindTooltip()
  load()
  loadPrices()
}
