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

// Made-up Breakdown views over a demo report, keyed by the drill-down path joined with '/'. The split, the
// targets and the patterns are invented; the total matches the report's cost so the two views agree.
export function demoBreakdown(report, now = new Date(2026, 10, 3, 17, 40)) {
  const total = report.totals.costUsd
  const ssh = report.byHost.find((h) => h.host === 'ssh:build-server')
  const sshUsd = ssh?.costUsd ?? 0
  const analysed = total - sshUsd
  const round = (v) => Math.round(v * 100) / 100
  const split = (amount, parts) => parts.map(([key, w, extra = {}]) => ({ key, usd: round(amount * w), share: w, est: false, ...extra }))
  const buckets = split(analysed, [
    ['tools', 0.31, { est: true }], ['output', 0.21], ['startup', 0.14], ['replies', 0.12], ['rebuilds', 0.09],
    ['injected', 0.06], ['messages', 0.03], ['compaction', 0.02], ['unattributed', 0.02],
  ])
  const projectTotal = report.byProject.reduce((s, p) => s + p.total, 0) || 1
  const home = '/Users/sam/code'
  const top = report.byProject.map((p) => {
    const w = p.total / projectTotal
    return { key: `${home}/${p.project}`, label: p.project, kind: 'project', usd: round(analysed * w), share: w, est: false, children: true }
  })
  const atlas = top.find((n) => n.label === 'atlas-web') ?? top[0]
  const node = (amount, key, label, kind, w, extra = {}) => ({ key, label, kind, usd: round(amount * w), share: w, est: false, children: false, ...extra })
  const projectNodes = [
    node(atlas.usd, 'src', 'src', 'folder', 0.33, { children: true, est: true }),
    node(atlas.usd, 'output', 'Output', 'bucket', 0.17),
    node(atlas.usd, 'command:pnpm test', '$ pnpm test', 'command', 0.11, { est: true }),
    node(atlas.usd, 'startup', 'Session start', 'bucket', 0.1),
    node(atlas.usd, 'replies', 'Earlier replies', 'bucket', 0.09),
    node(atlas.usd, 'agent:Explore', 'Explore', 'agent', 0.06),
    node(atlas.usd, 'rebuild:idle', 'Cache rebuilt after a break', 'bucket', 0.05),
    node(atlas.usd, 'command:git diff', '$ git diff', 'command', 0.03),
    node(atlas.usd, 'file:package.json', 'package.json', 'file', 0.02),
  ]
  const srcUsd = projectNodes[0].usd
  const srcNodes = [
    node(srcUsd, 'file:src/server/routes.ts', 'server/routes.ts', 'file', 0.29, { est: true }),
    node(srcUsd, 'src/components', 'components', 'folder', 0.24, { children: true }),
    node(srcUsd, 'file:src/lib/api-client.ts', 'lib/api-client.ts', 'file', 0.16),
    node(srcUsd, 'src/pages', 'pages', 'folder', 0.13, { children: true }),
    node(srcUsd, 'file:src/styles/theme.css', 'styles/theme.css', 'file', 0.08),
    node(srcUsd, 'file:src/index.tsx', 'index.tsx', 'file', 0.05),
  ]
  const day = (back) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const daily = (values) => values.map((v, i) => [day(values.length - 1 - i), v])
  const transcript = (project, id) => `/Users/sam/.claude/projects/-Users-sam-code-${project}/${id}.jsonl`
  const findings = [
    {
      id: 'large-results:demo1', kind: 'large-results', harness: 'claude', usd: 41.37, est: false,
      where: { project: `${home}/billing-api`, label: '$ npm test -- --verbose', key: 'command:npm test -- --verbose' },
      facts: { tokens: 3_480_000, sessions: 11 }, lastSeen: day(0),
      daily: daily([1.2, 2.8, 0, 3.4, 4.1, 2.2, 5.6, 3.9, 0, 4.8, 6.1, 7.27]),
      evidence: [
        { file: transcript('billing-api', '7f3c2a91-5d0e-4b8a-9c61-2e4f8a1b6d03'), offset: 482113, bytes: 2000, compressed: false },
        { file: transcript('billing-api', 'c41e9b07-8a2d-4f15-b3e6-90d7c5a2f184'), offset: 129840, bytes: 2000, compressed: false },
      ],
    },
    {
      id: 'repeat-reads:demo2', kind: 'repeat-reads', harness: 'claude', usd: 17.82, est: true,
      where: { project: `${home}/atlas-web`, label: 'src/server/routes.ts', key: 'file:src/server/routes.ts' },
      facts: { tokens: 1_210_000, sessions: 6 }, lastSeen: day(1),
      daily: daily([0.9, 1.6, 2.3, 0, 1.1, 3.4, 2.8, 1.9, 2.4, 1.42]),
      evidence: [{ file: transcript('atlas-web', '2b8d6f40-1c97-4e3a-a5d2-7f60b9e8c315'), offset: 77310, bytes: 1800, compressed: false }],
    },
    {
      id: 'cache-expired:demo3', kind: 'cache-expired', harness: 'codex', usd: 9.64, est: false,
      where: { project: `${home}/mobile-app`, label: 'mobile-app', key: `${home}/mobile-app` },
      facts: { tokens: 2_050_000, sessions: 8 }, lastSeen: day(0),
      daily: daily([0.4, 0.8, 1.3, 0.6, 0, 1.9, 1.1, 2.3, 1.24]),
      evidence: [],
    },
  ]
  const base = {
    generatedAt: now.toISOString(),
    range: report.range,
    prices: report.prices,
    totals: {
      usageUsd: total,
      analysedUsd: analysed,
      notAnalysed: [
        { reason: 'ssh', usd: sshUsd, turns: ssh?.turns ?? 0 },
        { reason: 'unpriced', usd: null, turns: 0 },
      ].filter((r) => r.usd === null ? r.turns > 0 : r.usd > 0),
      unpricedModels: [],
    },
    buckets,
    findings,
    health: { splitShare: 0.18, unattributedShare: 0.02, dedupeUsd: round(analysed * 0.015), explainUsd: 0 },
  }
  return {
    '': { ...base, path: [], nodes: top },
    [atlas.key]: { ...base, path: [atlas.key], nodes: projectNodes, more: { count: 7, usd: round(atlas.usd * 0.04) } },
    [`${atlas.key}/src`]: { ...base, path: [atlas.key, 'src'], nodes: srcNodes },
  }
}
