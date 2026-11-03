// Deterministic made-up usage for listing images: fake projects, hosts and numbers.
// Nothing here comes from real transcripts.
const PROJECTS = [
  ['atlas-web', 0.27], ['billing-api', 0.19], ['mobile-app', 0.15], ['data-pipeline', 0.12],
  ['design-system', 0.09], ['infra', 0.08], ['docs-site', 0.06], ['cli-tools', 0.04],
]
const WORKTREES = ['atlas-web', 'billing-api', 'design-system']
const CLAUDE_MODELS = [['claude-opus-5-5', 0.58], ['claude-sonnet-5-5', 0.3], ['claude-haiku-5-5', 0.12]]
const CODEX_MODELS = [['gpt-6-sol', 0.7], ['gpt-6.1-sol', 0.3]]

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, list) => {
  let x = r()
  for (const [v, w] of list) if ((x -= w) <= 0) return v
  return list[list.length - 1][0]
}

export const DEMO_WORKTREE_ROOTS = WORKTREES.map((p) => `/Users/sam/code/.orca/worktrees/${p}`)

// `now` is the screenshot's "today". Activity ramps up over ~5 months with a current streak.
export function demoRecords(now = new Date(2026, 10, 3, 17, 40)) {
  const r = rng(20261103)
  const out = []
  let n = 0
  for (let d = 150; d >= 0; d--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d)
    const dow = day.getDay()
    const ramp = 0.35 + 0.65 * (1 - d / 150)
    const weekend = dow === 0 || dow === 6 ? 0.35 : 1
    if (d > 18 && r() < 0.12) continue // a few days off, but the last weeks are a streak
    const sessions = Math.max(1, Math.round((2 + r() * 5) * ramp * weekend))
    for (let s = 0; s < sessions; s++) {
      const host = r() < 0.18 ? 'ssh:build-server' : 'local'
      const provider = r() < 0.26 ? 'codex' : 'claude'
      const project = pick(r, PROJECTS)
      const inWorktree = WORKTREES.includes(project) && r() < 0.7
      const cwd = inWorktree ? `/Users/sam/code/.orca/worktrees/${project}` : `/Users/sam/code/${project}`
      const model = provider === 'claude' ? pick(r, CLAUDE_MODELS) : pick(r, CODEX_MODELS)
      const sessionId = `demo-${d}-${s}`
      const startHour = r() < 0.12 ? 21 + Math.floor(r() * 3) : 9 + Math.floor(r() * 9)
      const turns = Math.round((20 + r() * 90) * ramp)
      let t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, Math.floor(r() * 60)).getTime()
      if (t > now.getTime()) continue
      for (let k = 0; k < turns; k++) {
        t += (20 + r() * 160) * 1000
        if (t > now.getTime()) break
        const ctx = 15_000 + k * (900 + r() * 1400)
        const fresh = r() < 0.08
        out.push({
          key: `msg_demo_${n++}:req`,
          provider,
          ts: new Date(t).toISOString(),
          model,
          project,
          cwd,
          sessionId,
          host,
          input: provider === 'claude' ? Math.round(2 + r() * 40) : Math.round(400 + r() * 2500),
          output: Math.round(150 + r() * 2200),
          cacheRead: fresh ? 0 : Math.round(ctx),
          cacheWrite: provider === 'claude' ? Math.round(fresh ? ctx : 400 + r() * 5000) : 0,
        })
      }
    }
  }
  return out
}

export const DEMO_SOURCES = (now) => [
  { id: 'local', kind: 'local', label: 'This machine', state: 'ok', files: 412, records: 0, lastScanAt: new Date(now - 20_000).toISOString(), ms: 41 },
  { id: 'ssh:build-server', kind: 'ssh', label: 'build-server', state: 'ok', files: 96, records: 0, lastScanAt: new Date(now - 95_000).toISOString(), ms: 1830 },
]
