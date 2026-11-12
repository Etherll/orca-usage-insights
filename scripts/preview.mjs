// Dev only: renders the built panel with real local usage, through the worker's own handlers,
// so it can be opened or screenshotted outside Orca.
// Usage: node scripts/preview.mjs [out.html] [--light] [--cost] [--breakdown] [--sync] [--codex dir] [--ssh host,...] [--folders a,b] [--worktrees a,b]
// --sync fetches the public price lists once (as the Sync button does) so the Sync dialog has an answer.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScanner } from '../src/node/scan.mjs'
import { startWorker } from '../src/worker.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const light = args.includes('--light')
const cost = args.includes('--cost')
const showBreakdown = args.includes('--breakdown')
const out = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['--ssh', '--folders', '--worktrees', '--codex'].includes(args[i - 1]))) || join(tmpdir(), 'usage-insights-preview.html')
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const settings = { extraClaudeFolders: list(flag('--folders')).join('\n'), extraCodexFolders: list(flag('--codex')).join('\n'), sshHosts: list(flag('--ssh')).join('\n') }
const worktrees = list(flag('--worktrees')).map((path) => ({ id: path, kind: 'worktree', name: path, path, branch: null, hostId: null }))

const handlers = new Map()
const orca = {
  panels: { handle: (n, f) => handlers.set(n, f), post() {} },
  host: { call: async (m) => (m === 'settings.get' ? { settings } : m === 'workspace.list' ? { workspaces: worktrees, truncated: false } : {}) },
  log() {},
}
const dir = join(tmpdir(), 'usage-insights-preview')
const scanner = createScanner({ home: homedir(), cacheFile: join(dir, 'scan-cache-v4.json') })
const worker = startWorker(orca, scanner, { pollMs: 3_600_000, sshCacheDir: dir, priceDir: dir, sshWaitMs: 180_000, breakdownWaitMs: 3_600_000 })
await worker.ready

const reports = {}
for (const range of ['7d', '30d', '90d', 'all']) {
  for (const scope of ['all', 'worktrees']) {
    const input = { range, ...(scope === 'all' ? {} : { scope }) }
    reports[JSON.stringify(input)] = await handlers.get('usage.report')(input, {})
  }
}
// Breakdown views (top level and one level down for every project), price status and the Explain
// prompts, so every click in the preview has an answer.
const views = {}
const explains = {}
const t0 = Date.now()
for (const range of ['7d', '30d', '90d', 'all']) {
  const top = await handlers.get('usage.breakdown')({ range }, {})
  views[JSON.stringify([range, []])] = top
  for (const node of top.nodes || []) views[JSON.stringify([range, [node.key]])] = await handlers.get('usage.breakdown')({ range, path: [node.key] }, {})
  for (const f of top.findings || []) explains[f.id] = await handlers.get('usage.explain')({ range, findingId: f.id }, {})
  if (range === '7d') console.log(`breakdown ready in ${Date.now() - t0} ms`)
}
const prices = await handlers.get('prices.status')(undefined, {})
const sync = args.includes('--sync') ? await handlers.get('prices.sync')(undefined, {}) : null
await worker.stop()
const shim = `<script>window.__USAGE_PREVIEW__ = (() => { const R = ${JSON.stringify(reports)}; const V = ${JSON.stringify(views)}; const E = ${JSON.stringify(explains)}; const P = ${JSON.stringify(prices)}; const S = ${JSON.stringify(sync)}; return async (name, input = {}) => {
  if (name === 'prices.status') return P
  if (name === 'prices.sync' && S) return S
  if (name === 'usage.explain') return E[input.findingId] || { prompt: 'Not captured in this preview.', estTokens: 0 }
  if (name === 'usage.breakdown') return V[JSON.stringify([input.range, input.path || []])] || V[JSON.stringify([input.range, []])]
  if (name.startsWith('prices.')) throw new Error('Not available in the preview')
  return R[JSON.stringify({ range: input.range, ...(input.scope ? { scope: input.scope } : {}) })] || R['{"range":"7d"}'] } })()</script>`
const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  .replace('<html lang="en">', `<html lang="en" class="${light ? 'light' : 'dark'}">`)
  .replace('<script>', `${shim}<script>`)
const click = cost ? `<script>setTimeout(() => document.querySelector('[data-metric=cost]')?.click(), 300)</script>` : showBreakdown ? `<script>setTimeout(() => document.querySelector('[data-view=breakdown]')?.click(), 300)</script>` : ''
writeFileSync(out, html.replace('</body>', `${click}</body>`))
console.log(`Wrote ${out}`)
process.exit(0)
