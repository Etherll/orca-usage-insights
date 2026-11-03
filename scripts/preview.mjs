// Dev only: renders the built panel with real local usage, through the worker's own handlers,
// so it can be opened or screenshotted outside Orca.
// Usage: node scripts/preview.mjs [out.html] [--light] [--cost] [--ssh host,...] [--folders a,b] [--worktrees a,b]
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
const out = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['--ssh', '--folders', '--worktrees'].includes(args[i - 1]))) || join(tmpdir(), 'usage-insights-preview.html')
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const settings = { extraClaudeFolders: list(flag('--folders')).join('\n'), extraCodexFolders: '', sshHosts: list(flag('--ssh')).join('\n') }
const worktrees = list(flag('--worktrees')).map((path) => ({ id: path, kind: 'worktree', name: path, path, branch: null, hostId: null }))

const handlers = new Map()
const orca = {
  panels: { handle: (n, f) => handlers.set(n, f), post() {} },
  host: { call: async (m) => (m === 'settings.get' ? { settings } : m === 'workspace.list' ? { workspaces: worktrees, truncated: false } : {}) },
  log() {},
}
const dir = join(tmpdir(), 'usage-insights-preview')
const scanner = createScanner({ home: homedir(), cacheFile: join(dir, 'scan-cache.json') })
const worker = startWorker(orca, scanner, { pollMs: 3_600_000, sshCacheDir: dir, sshWaitMs: 180_000 })
await worker.ready

const reports = {}
for (const range of ['7d', '30d', '90d', 'all']) {
  for (const scope of ['all', 'worktrees']) {
    const input = { range, ...(scope === 'all' ? {} : { scope }) }
    reports[JSON.stringify(input)] = await handlers.get('usage.report')(input, {})
  }
}
await worker.stop()
const shim = `<script>window.__USAGE_PREVIEW__ = (() => { const R = ${JSON.stringify(reports)}; return async (name, input) => R[JSON.stringify({ range: input.range, ...(input.scope ? { scope: input.scope } : {}) })] || R['{"range":"7d"}'] })()</script>`
const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  .replace('<html lang="en">', `<html lang="en" class="${light ? 'light' : 'dark'}">`)
  .replace('<script>', `${shim}<script>`)
const click = cost ? `<script>setTimeout(() => document.querySelector('[data-metric=cost]')?.click(), 300)</script>` : ''
writeFileSync(out, html.replace('</body>', `${click}</body>`))
console.log(`Wrote ${out}`)
process.exit(0)
