import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))

function sampleReport(range = '7d') {
  const daily = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(28 + i).padStart(2, '0')}`.replace('2026-10-32', '2026-11-01').replace('2026-10-33', '2026-11-02').replace('2026-10-34', '2026-11-03'), input: 1000 * i, output: 500 * i, cacheRead: 9000 * i, cacheWrite: 300 * i, total: 10800 * i, costUsd: i }))
  return {
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
}

function fakeDom() {
  const els = new Map()
  const make = (id) => ({
    id, innerHTML: '', textContent: '', hidden: false, checked: true, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] },
    listeners: {}, addEventListener(t, f) { this.listeners[t] = f },
    querySelectorAll() { return [] }, getBoundingClientRect: () => ({ width: 100, height: 40 }),
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
    plugin: { request: async (name, input) => { calls.push([name, input]); return sampleReport(input.range) }, on() {} },
    on() {},
  }
  const ctx = vm.createContext({ document, orca, window: { innerWidth: 800, innerHeight: 600 }, console, Date, Intl, JSON, Math })
  vm.runInContext(script, ctx)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['usage.report', { range: '1d' }]))
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
  assert.match(html, /data-range="1d" aria-checked="true">Today/)
  assert.match(html, /data-range="7d" aria-checked="false" tabindex="-1">7d/)
  get('ranges').listeners.click({ target: { closest: () => ({ dataset: { range: '7d' } }) } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['usage.report', { range: '7d' }]))
  get('ranges').listeners.click({ target: { closest: () => ({ dataset: { range: '1d' } }) } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['usage.report', { range: '1d' }]))
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
