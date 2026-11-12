// Breakdown view, Sync dialog and price line: HTML builders from the worker's replies. No DOM
// access and no dollar math beyond formatting; panel.js owns events and requests.
import { esc, sparkline } from './charts.mjs'

export const BUCKET_INFO = {
  startup: { label: 'Session start', tip: 'System prompt, tool definitions and memory files loaded before your first message.', color: 'var(--s4)' },
  tools: { label: 'Tool results', tip: 'File reads, command output and other tool results, paid for again on every turn they stay in context.', color: 'var(--s1)' },
  messages: { label: 'Your messages', tip: 'What you typed, kept in context.', color: 'var(--s3)' },
  injected: { label: 'Injected context', tip: 'Reminders, attachments and hook output the harness adds to the conversation.', color: 'var(--s5)' },
  replies: { label: 'Earlier replies', tip: "The model's own earlier answers, re-read on every turn.", color: 'var(--q4)' },
  compaction: { label: 'Compaction summaries', tip: 'Summaries written when a long session was compacted.', color: 'var(--s7)' },
  rebuilds: { label: 'Cache rebuilds', tip: 'Context written to the cache again after it expired, after a model switch, or after compaction.', color: 'var(--s2)' },
  output: { label: 'Output', tip: 'Tokens the model wrote: answers, tool calls and thinking.', color: 'var(--s6)' },
  unattributed: { label: 'Unattributed', tip: "Context growth the transcript doesn't explain.", color: 'var(--muted-fg)' },
}

export const REASON_INFO = {
  ssh: { label: 'On SSH hosts', next: 'Breakdown reads transcripts on this machine only. SSH usage still counts in the total.' },
  zstd: { label: 'Compressed Codex files', next: "This Orca's Node.js can't read .zst files. Updating Orca fixes it." },
  'too-large': { label: 'Files too large', next: 'Compressed transcripts over 64 MB are skipped.' },
  parse: { label: "Files that couldn't be read", next: 'See the This machine status above for which files failed.' },
  unmatched: { label: 'No transcript detail', next: 'Usage whose transcript lines are gone or trimmed, so it can be counted but not split.' },
  unpriced: { label: 'Unpriced models', next: 'Add their prices in price-overrides.json (see the README).' },
}

export const FINDING_INFO = {
  'large-results': { title: 'Large tool result kept in context', what: 'Output from this target stayed in context and was paid for on later turns.' },
  'repeat-reads': { title: 'Same file read again', what: 'This file was read again with no edit in between.' },
  'cache-expired': { title: 'Cache expired after a break', what: 'After a pause longer than the cache lifetime, the whole context was written to the cache again.' },
}

const SYNC_STATUS = {
  agree: 'Both agree',
  disagree: 'Sources disagree',
  single: 'One source only',
  flagged: 'Check this',
  new: 'New model',
  removed: 'No source lists it',
  overridden: 'Set in your overrides file',
}
const FIELD_LABELS = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  'cacheWrite.5m': 'Cache write (5 min)',
  'cacheWrite.1h': 'Cache write (1 h)',
  'cacheWrite.default': 'Cache write',
}
function fieldLabel(field) {
  const whole = /^tier\.(\d+)$/.exec(field)
  if (whole) return `Rates for prompts over ${Number(whole[1]) / 1000}k`
  const tier = /^tier\.(\d+)\.(.+)$/.exec(field)
  if (!tier) return FIELD_LABELS[field] || field
  return `${FIELD_LABELS[tier[2]] || tier[2]}, prompts over ${Number(tier[1]) / 1000}k`
}

// Dollars: ≈ when estimated, + when some usage is unpriced, — when the value can't be measured.
export function usd(n, { est = false, plus = false } = {}) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v > 0 && v < 0.0001) return `${est ? '≈' : ''}<$0.0001`
  const text = v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 0.995 || v === 0 ? v.toFixed(2) : v.toFixed(v < 0.01 ? 4 : 3)
  return `${est ? '≈' : ''}$${text}${plus ? '+' : ''}`
}

function share(x) {
  const v = (Number(x) || 0) * 100
  return v > 0 && v < 0.1 ? '<0.1%' : `${v.toFixed(1)}%`
}

function tipAttr(title, rows) {
  return `data-tip="${esc(JSON.stringify({ title, rows }))}"`
}

export function headline(view) {
  const t = view.totals
  const unpriced = (t.unpricedModels || []).length > 0
  const rest = t.usageUsd - t.analysedUsd
  const buckets = view.buckets || []
  const bar = buckets.length
    ? `<div class="stack" role="img" aria-label="Spend by bucket">${buckets
        .map((b) => {
          const info = BUCKET_INFO[b.key] || { label: b.key, tip: '', color: 'var(--muted-fg)' }
          return `<span style="flex-grow:${Math.max(b.share, 0.004)};background:${info.color}" ${tipAttr(info.label, [['Cost', usd(b.usd, { est: b.est })], ['Share', share(b.share)], ['', info.tip]])}></span>`
        })
        .join('')}</div>`
    : ''
  const list = buckets
    .map((b) => {
      const info = BUCKET_INFO[b.key] || { label: b.key, tip: '', color: 'var(--muted-fg)' }
      return `<li title="${esc(info.tip)}"><span class="sw" style="background:${info.color}"></span><span class="name">${esc(info.label)}</span><span class="amt">${esc(usd(b.usd, { est: b.est }))}</span><span class="pct">${esc(share(b.share))}</span></li>`
    })
    .join('')
  const sub = rest > 0.005
    ? `${usd(t.analysedUsd)} broken down · ${usd(rest)} not analysed (below)`
    : 'All of it broken down'
  return `<div class="bd-head"><div><span class="label">Spent</span><strong class="bd-total">${esc(usd(t.usageUsd, { plus: unpriced }))}</strong><p class="muted">${esc(sub)}</p></div></div>${bar}<ul class="bucket-list">${list}</ul>`
}

const OWN_TARGETS = {
  startup: 'Session start',
  replies: 'Earlier replies',
  output: 'Output',
  unattributed: 'Unattributed',
  other: '(other)',
  'rebuild:idle': 'Cache rebuilt after a break',
  'rebuild:model': 'Cache rebuilt after a model switch',
  'rebuild:compaction': 'Cache rebuilt after compaction',
  'rebuild:other': 'Other cache rewrites',
}

export function tree(view) {
  const path = view.path || []
  const crumbs = [`<button class="crumb" data-depth="0"${path.length === 0 ? ' aria-current="page"' : ''}>All projects</button>`]
  path.forEach((key, i) => {
    const label = i === 0 ? lastSegment(key) : key
    crumbs.push(`<span class="sep" aria-hidden="true">›</span><button class="crumb" data-depth="${i + 1}"${i === path.length - 1 ? ' aria-current="page"' : ''} title="${esc(key)}">${esc(label)}</button>`)
  })
  const nodes = view.nodes || []
  const top = Math.max(0, ...nodes.map((n) => n.usd))
  const rows = nodes
    .map((n) => {
      const width = top > 0 ? Math.max(1.5, (n.usd / top) * 100) : 0
      const label = n.kind === 'bucket' ? OWN_TARGETS[n.key] ?? n.label : n.label || n.key
      const name = `<span class="nm"><span class="txt">${esc(label)}</span>${n.kind === 'folder' || n.kind === 'group' || n.kind === 'project' ? '' : `<small>${esc(kindLabel(n.kind))}</small>`}</span><span class="share-line" style="width:${width.toFixed(1)}%"></span>`
      const cells = `<span class="amt">${esc(usd(n.usd, { est: n.est }))}</span><span class="pct">${esc(share(n.share))}</span>`
      return n.children
        ? `<li><button class="node" data-key="${esc(n.key)}" title="${esc(n.key)}"><span class="cell-name">${name}</span>${cells}<span class="chev" aria-hidden="true">›</span></button></li>`
        : `<li><div class="node leaf" title="${esc(n.key)}"><span class="cell-name">${name}</span>${cells}<span class="chev" aria-hidden="true"></span></div></li>`
    })
    .join('')
  const more = view.more ? `<li class="more muted">+ ${view.more.count} more · ${esc(usd(view.more.usd))}</li>` : ''
  const empty = nodes.length ? '' : '<li class="muted empty">Nothing analysed here in this range.</li>'
  return { crumbs: crumbs.join(''), rows: `<ul class="nodes">${rows}${more}${empty}</ul>` }
}

function kindLabel(kind) {
  return { file: 'file', command: 'command', agent: 'subagent', web: 'web', mcp: 'MCP', tool: 'tool', messages: 'message', injected: 'injected', summary: 'summary', bucket: '' }[kind] ?? ''
}

function lastSegment(path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || String(path)
}

// They overlap, so no total is shown.
export function findings(view) {
  const list = view.findings || []
  if (!list.length) return '<p class="muted empty">No pattern above $1 in this range.</p>'
  return list
    .map((f) => {
      const info = FINDING_INFO[f.kind] || { title: f.kind, what: '' }
      const where = f.kind === 'cache-expired' ? lastSegment(f.where.project) : `${f.where.label} · ${lastSegment(f.where.project)}`
      const spark = (f.daily || []).length > 1 ? `<span class="spark-wrap" aria-hidden="true">${sparkline(f.daily.map((d) => d[1]), { width: 80, height: 22 })}</span>` : ''
      const facts = [`${f.facts?.sessions ?? 0} session${f.facts?.sessions === 1 ? '' : 's'}`, f.lastSeen ? `last seen ${f.lastSeen}` : ''].filter(Boolean).join(' · ')
      return `<article class="finding"><header><span class="tag">${esc(f.harness === 'codex' ? 'Codex' : 'Claude Code')}</span><h3>${esc(info.title)}</h3></header>
<p class="where" title="${esc(f.where.key)}">${esc(where)}</p>
<div class="fig"><div><span class="label">Cost of this pattern</span><strong>${esc(usd(f.usd, { est: f.est }))}</strong></div>${spark}</div>
<p class="muted">${esc(info.what)} ${esc(facts)}.</p>
<footer><button class="btn" data-explain="${esc(f.id)}">Explain…</button></footer></article>`
    })
    .join('')
}

export function notAnalysed(view) {
  const rows = view.totals.notAnalysed || []
  if (!rows.length) return ''
  const models = (view.totals.unpricedModels || []).map((m) => m.model).filter(Boolean)
  const items = rows
    .map((r) => {
      const info = REASON_INFO[r.reason] || { label: r.reason, next: '' }
      const extra = r.reason === 'unpriced' && models.length ? ` Models: ${models.slice(0, 6).join(', ')}${models.length > 6 ? '…' : ''}.` : ''
      return `<li><div class="row"><span class="name">${esc(info.label)}</span><span class="amt">${esc(usd(r.usd))}</span><span class="pct muted">${r.turns.toLocaleString()} turns</span></div><p class="muted">${esc(info.next + extra)}</p></li>`
    })
    .join('')
  return `<header><h2>Not analysed</h2></header><ul class="reasons">${items}</ul>`
}

export function legend(view) {
  const h = view.health || {}
  const parts = [`≈ estimated split (${share(h.splitShare)} of the analysed cost)`, '+ some models unpriced', '— can’t be measured']
  if (h.dedupeUsd > 0.005) parts.push(`${usd(h.dedupeUsd)} of repeated history from resumed sessions left out`)
  if (h.explainUsd > 0.005) parts.push(`${usd(h.explainUsd)} from Explain sessions, not in findings`)
  return parts.join(' · ')
}

export function priceLine(status) {
  if (!status) return ''
  const from = status.overlay
    ? `Prices: synced ${String(status.overlay.appliedAt || '').slice(0, 10)}${status.overlay.sources?.length ? ` from ${status.overlay.sources.join(' + ')}` : ''}`
    : `Prices: bundled ${status.asOf || ''}`
  const o = status.overrides
  const own = o ? ` · <span title="${esc(o.file)}">+ your overrides (${o.models} model${o.models === 1 ? '' : 's'}${o.aliases ? `, ${o.aliases} alias${o.aliases === 1 ? '' : 'es'}` : ''})</span>` : ''
  const problems = o?.problems?.length ? `<p class="warn">Overrides file: ${esc(o.problems.slice(0, 3).join('; '))}${o.problems.length > 3 ? '…' : ''}</p>` : ''
  const actions = [
    '<button class="link-btn" data-price="sync">Sync prices…</button>',
    status.canUndo ? '<button class="link-btn" data-price="undo">Undo</button>' : '',
    status.overlay ? '<button class="link-btn" data-price="reset">Reset to bundled</button>' : '',
  ].join('')
  return `<span class="muted">${esc(from)}${own}</span>${actions}${problems}`
}

// A row whose sources give exactly the price in use changes nothing, so it is counted, not listed.
export function changedSyncRows(rows = []) {
  return rows.filter((r) => {
    const values = [r.litellm, r.modelsdev].filter((v) => v !== null && v !== undefined)
    return r.status === 'removed' || r.current === null || r.current === undefined || values.some((v) => Math.abs(v - r.current) > 1e-9)
  })
}

export function syncBody(result) {
  const sources = (result.sources || [])
    .map((s) => `<li class="${s.ok ? 'ok' : 'bad'}">${esc(s.name === 'litellm' ? 'LiteLLM' : s.name)}: ${s.ok ? `${s.rows} prices for your models` : esc(s.error || 'failed')}</li>`)
    .join('')
  const all = result.rows || []
  const rows = changedSyncRows(all)
  const same = all.length - rows.length
  const impact = result.impact
    ? `<p class="impact">Last 30 days: <strong>${esc(usd(result.impact.beforeUsd))}</strong> now → <strong>${esc(usd(result.impact.afterUsd))}</strong> with the pre-ticked changes.</p>`
    : ''
  const fmt = (v) => (v === null || v === undefined ? '—' : `$${Number(v)}`)
  // The price a ticked row applies (LiteLLM's, else models.dev's); the other source's follows when it differs.
  const proposed = (r) => {
    if (r.status === 'removed') return 'Remove'
    const first = r.litellm ?? r.modelsdev
    const other = r.litellm !== null && r.litellm !== undefined && r.modelsdev !== null && r.modelsdev !== undefined && Math.abs(r.litellm - r.modelsdev) > 1e-9
      ? `<span class="muted small">models.dev ${esc(fmt(r.modelsdev))}</span>`
      : ''
    return `${esc(fmt(first))}${other}`
  }
  const table = rows.length
    ? `<div class="table-wrap"><table class="bd sync"><thead><tr><th></th><th>Price per 1M tokens</th><th>Now</th><th>New</th></tr></thead><tbody>${rows
        .map((r) => {
          const id = `sync-${esc(r.key)}`
          const disabled = r.status === 'overridden' ? ' disabled' : ''
          const field = fieldLabel(r.field)
          return `<tr class="${esc(r.status)}"><td><input type="checkbox" id="${id}" data-key="${esc(r.key)}"${r.ticked ? ' checked' : ''}${disabled} aria-label="Apply ${esc(r.model)} ${esc(field)}"></td><td class="name"><label for="${id}">${esc(r.model)}</label><span class="sub">${esc(field)} <span class="chip-s ${esc(r.status)}">${esc(SYNC_STATUS[r.status] || r.status)}</span></span></td><td>${esc(fmt(r.current))}</td><td class="new">${proposed(r)}</td></tr>`
        })
        .join('')}</tbody></table></div>`
    : '<p class="muted">Your prices match the sources for every model you use.</p>'
  const matching = same > 0 && rows.length ? `<p class="muted small">${same} more ${same === 1 ? 'price matches' : 'prices match'} what you use now and ${same === 1 ? 'is' : 'are'} not listed.</p>` : ''
  const note = rows.some((r) => r.status === 'flagged')
    ? '<p class="muted small">“Check this” means a change of 10× or more, a zero price on a paid model, or a per-token price this plugin doesn’t know yet. These are never pre-ticked.</p>'
    : ''
  return `${impact}<ul class="src-list">${sources}</ul>${table}${matching}${note}`
}
