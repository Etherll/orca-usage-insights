// Pure SVG-string chart builders. Each takes a slice of the Report and returns markup.
// Colors are CSS variables defined in panel.css, so light/dark switch without re-rendering.
import { compact } from '../core/format.mjs'

// panel.js reads compact from here. build.mjs drops this line, since format.mjs is bundled once.
export { compact }

export const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
export const TOKEN_LABELS = { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write' }
export const TOKEN_COLORS = { input: 'var(--s1)', output: 'var(--s2)', cacheRead: 'var(--s3)', cacheWrite: 'var(--s4)' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// Which day indices get an axis label: all of them when each has `minPx` of room, otherwise
// every k-th, counted back from the latest day so today is always labelled.
export function dayTicks(n, slotPx, minPx = 46) {
  const step = Math.max(1, Math.ceil(minPx / Math.max(1, slotPx)))
  const out = []
  for (let i = n - 1; i >= 0; i -= step) out.push(i)
  return out.reverse()
}

// Axis label: "Oct 28", plus the weekday on a second line for short ranges.
function dayLabel(day, x, y, anchor, withWeekday) {
  const date = new Date(day + 'T00:00:00')
  let out = `<text x="${x}" y="${y}" class="t-muted" text-anchor="${anchor}">${esc(shortDay(day))}</text>`
  if (withWeekday) out += `<text x="${x}" y="${y + 12}" class="t-faint" text-anchor="${anchor}">${WEEKDAYS[date.getDay()]}</text>`
  return out
}

function shortDay(day) {
  const [, m, d] = day.split('-')
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`
}

function svg(w, h, body, label) {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`
}

function empty(w, h, label) {
  return svg(w, h, `<text x="${w / 2}" y="${h / 2}" class="t-muted" text-anchor="middle" dominant-baseline="middle">No usage yet</text>`, label)
}

// Daily stacked bars. Segments stack bottom-up in `keys` order with a 2px surface gap,
// the bar's top is rounded via a clip path, and every bar carries a tooltip payload.
export function stackedBars(daily, { keys = TOKEN_KEYS, width = 360, height = 170, id = 'sb', colors = TOKEN_COLORS, labels = TOKEN_LABELS, fmt = null } = {}) {
  const label = 'Daily usage'
  if (!daily?.length) return empty(width, height, label)
  const withWeekday = daily.length <= 14
  const top = 18
  const bottom = withWeekday ? 30 : 18
  const plotH = height - top - bottom
  const totals = daily.map((d) => keys.reduce((s, k) => s + (d[k] || 0), 0))
  const max = Math.max(...totals)
  if (max <= 0) return empty(width, height, label)
  const slot = width / daily.length
  // Bars take most of their slot so few-day ranges don't look sparse; capped so 1–2 days stay sane.
  const barW = Math.max(2, Math.min(96, slot * (slot > 40 ? 0.62 : 0.72)))
  const radius = Math.min(6, barW / 2)
  let defs = ''
  let body = `<line x1="0" x2="${width}" y1="${top + plotH + 0.5}" y2="${top + plotH + 0.5}" class="axis"/>`
  body += `<text x="0" y="11" class="t-muted">${esc(fmt ? fmt(max) : compact(max))}</text>`
  daily.forEach((d, i) => {
    const x = i * slot + (slot - barW) / 2
    const total = totals[i]
    const h = (total / max) * plotH
    const show = (v) => (fmt ? fmt(v) : v)
    const tip = esc(JSON.stringify({ title: shortDay(d.day), rows: keys.map((k) => [labels[k] ?? k, show(d[k] || 0)]), total: keys.length > 1 ? show(total) : undefined }))
    body += `<g class="mark" data-tip="${tip}">`
    body += `<rect x="${x - (slot - barW) / 2}" y="${top}" width="${slot}" height="${plotH}" class="hit"/>`
    if (h > 0) {
      const cid = `${id}-c${i}`
      defs += `<clipPath id="${cid}"><rect x="${x}" y="${top + plotH - h}" width="${barW}" height="${h + radius}" rx="${radius}"/></clipPath>`
      body += `<g clip-path="url(#${cid})">`
      let y = top + plotH
      let drawn = 0
      for (const k of keys) {
        const v = d[k] || 0
        if (v <= 0) continue
        const sh = (v / max) * plotH
        y -= sh
        const gap = drawn++ > 0 ? Math.min(2, sh / 2) : 0 // 2px surface gap between stacked segments
        body += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(0, sh - gap)}" fill="${colors[k] ?? 'var(--s1)'}"/>`
      }
      body += `</g>`
    }
    body += `</g>`
  })
  // Every label sits centred under its own bar.
  for (const i of dayTicks(daily.length, slot)) {
    body += dayLabel(daily[i].day, (i * slot + slot / 2).toFixed(1), top + plotH + 14, 'middle', withWeekday)
  }
  return svg(width, height, `<defs>${defs}</defs>${body}`, label)
}

// Rank-quantile buckets 1..4 over non-zero values; 0 stays level 0.
export function levels(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!nz.length) return values.map(() => 0)
  const below = (v) => {
    let lo = 0
    let hi = nz.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (nz[mid] < v) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return values.map((v) => (v <= 0 ? 0 : 1 + Math.min(3, Math.floor((below(v) / nz.length) * 4))))
}

// GitHub-style calendar: columns are weeks (Sun..Sat rows), oldest left.
export function calendarHeatmap(calendar, { cell = 11, gap = 2 } = {}) {
  const label = 'Daily activity calendar'
  if (!calendar?.length) return empty(300, 100, label)
  const first = new Date(calendar[0].day + 'T00:00:00')
  const offset = first.getDay()
  const weeks = Math.ceil((calendar.length + offset) / 7)
  const left = 26
  const top = 14
  const step = cell + gap
  const w = left + weeks * step
  const h = top + 7 * step
  const lv = levels(calendar.map((d) => d.total))
  let body = ''
  let lastMonth = -1
  calendar.forEach((d, i) => {
    const pos = i + offset
    const col = Math.floor(pos / 7)
    const row = pos % 7
    const x = left + col * step
    const y = top + row * step
    const month = Number(d.day.slice(5, 7)) - 1
    if (row === 0 || i === 0) {
      if (month !== lastMonth && col < weeks - 1) {
        body += `<text x="${x}" y="10" class="t-muted">${MONTHS[month]}</text>`
        lastMonth = month
      }
    }
    const tip = esc(JSON.stringify({ title: shortDay(d.day), rows: [['Tokens', d.total]] }))
    body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" class="mark cell q${lv[i]}" data-tip="${tip}"/>`
  })
  for (const r of [1, 3, 5]) body += `<text x="0" y="${top + r * step + cell - 2}" class="t-muted">${WEEKDAYS[r]}</text>`
  return svg(w, h, body, label)
}

// Weekday x hour punch card; dot area follows the value.
export function punchCard(grid, { cell = 13 } = {}) {
  const label = 'Activity by weekday and hour'
  const values = Array.from({ length: 168 }, (_, i) => Number(grid?.[i]) || 0)
  const max = Math.max(...values)
  const left = 28
  const w = left + 24 * cell
  const h = 7 * cell + 16
  if (max <= 0) return empty(w, h, label)
  let body = ''
  for (let d = 0; d < 7; d++) {
    body += `<text x="0" y="${d * cell + cell / 2 + 4}" class="t-muted">${WEEKDAYS[d]}</text>`
    for (let hr = 0; hr < 24; hr++) {
      const v = values[d * 24 + hr]
      const cx = left + hr * cell + cell / 2
      const cy = d * cell + cell / 2
      const r = v > 0 ? Math.max(1.5, Math.sqrt(v / max) * (cell / 2 - 1)) : 1
      const tip = esc(JSON.stringify({ title: `${WEEKDAYS[d]} ${String(hr).padStart(2, '0')}:00`, rows: [['Tokens', v]] }))
      body += `<g class="mark" data-tip="${tip}"><rect x="${cx - cell / 2}" y="${cy - cell / 2}" width="${cell}" height="${cell}" class="hit"/>`
      body += `<circle cx="${cx}" cy="${cy}" r="${r}" class="${v > 0 ? 'dot' : 'dot-empty'}"/></g>`
    }
  }
  for (const hr of [0, 6, 12, 18]) body += `<text x="${left + hr * cell + 2}" y="${h - 2}" class="t-muted">${hr}h</text>`
  return svg(w, h, body, label)
}

// Ring chart with 2px gaps between segments. segments: [{ label, value, color }]
export function donut(segments, { size = 132, thickness = 16, centerLabel = 'tokens' } = {}) {
  const label = 'Token mix'
  const total = (segments || []).reduce((s, x) => s + (x.value > 0 ? x.value : 0), 0)
  const r = (size - thickness) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  let body = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" class="track" stroke-width="${thickness}"/>`
  if (total > 0) {
    const live = segments.filter((s) => s.value > 0)
    const gap = live.length > 1 ? 2 : 0
    let acc = 0
    for (const s of live) {
      const len = (s.value / total) * circ
      const tip = esc(JSON.stringify({ title: s.label, rows: [['Tokens', s.value], ['Share', `${((s.value / total) * 100).toFixed(1)}%`]] }))
      body += `<circle class="mark" data-tip="${tip}" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${Math.max(0.5, len - gap)} ${circ}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${c} ${c})"/>`
      acc += len
    }
  }
  body += `<text x="${c}" y="${c - 2}" text-anchor="middle" class="t-strong">${esc(compact(total))}</text>`
  body += `<text x="${c}" y="${c + 14}" text-anchor="middle" class="t-muted">${esc(centerLabel)}</text>`
  return svg(size, size, body, label)
}

// Horizontal bar list. items: [{ label, value, note? }]
export function hBars(items, { width = 360, row = 24, labelW = Math.min(180, Math.max(110, width * 0.3)), valueW = 64 } = {}) {
  const label = 'Ranking'
  if (!items?.length) return empty(width, row * 2, label)
  const max = Math.max(...items.map((i) => i.value), 0)
  const barMax = width - labelW - valueW
  let body = ''
  items.forEach((it, i) => {
    const y = i * row
    const w = max > 0 ? Math.max(it.value > 0 ? 3 : 0, (it.value / max) * barMax) : 0
    const maxChars = Math.floor(labelW / 6.6)
    const name = it.label.length > maxChars ? it.label.slice(0, maxChars - 1) + '…' : it.label
    const tip = esc(JSON.stringify({ title: it.label, rows: [['Tokens', it.value], ...(it.note ? [['', it.note]] : [])] }))
    body += `<g class="mark" data-tip="${tip}"><rect x="0" y="${y}" width="${width}" height="${row}" class="hit"/>`
    body += `<text x="0" y="${y + row / 2 + 4}" class="t-label">${esc(name)}</text>`
    body += `<rect x="${labelW}" y="${y + 6}" width="${w}" height="${row - 12}" rx="3" class="bar"/>`
    body += `<text x="${width}" y="${y + row / 2 + 4}" text-anchor="end" class="t-muted">${esc(it.note ?? compact(it.value))}</text></g>`
  })
  return svg(width, items.length * row, body, label)
}

export function sparkline(values, { width = 96, height = 26 } = {}) {
  const v = (values || []).map((x) => Number(x) || 0)
  if (v.length < 2) return svg(width, height, '', 'Trend')
  const max = Math.max(...v) || 1
  const pts = v.map((x, i) => [(i / (v.length - 1)) * (width - 4) + 2, height - 3 - (x / max) * (height - 6)])
  const d = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const [lx, ly] = pts[pts.length - 1]
  return svg(width, height, `<polyline points="${d}" fill="none" class="spark" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx}" cy="${ly}" r="2.5" class="spark-dot"/>`, 'Trend')
}

export const PROVIDER_COLORS = { claude: 'var(--s2)', codex: 'var(--s1)' }
export const PROVIDER_LABELS = { claude: 'Claude Code', codex: 'Codex' }
export const providerColor = (p, i = 0) => PROVIDER_COLORS[p] ?? ['var(--s3)', 'var(--s4)'][i % 2]

// Monotone cubic (Fritsch–Carlson) path through points, so smoothing never overshoots below 0.
export function smoothPath(pts) {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`
  const dx = []
  const m = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1))
  }
  const t = [m[0]]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2)
  t.push(m[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const h = a * a + b * b
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i] }
  }
  const f = (v) => v.toFixed(1)
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += `C${f(pts[i][0] + h)},${f(pts[i][1] + t[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - t[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`
  }
  return d
}

// Top of the axis: 4 gridline steps, each a round 1/2/2.5/5 × 10^n.
function niceMax(v) {
  if (v <= 0) return 1
  const raw = v / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return 4 * k * p
  return 40 * p
}

// Smoothed area per provider over days. series: [{ provider, daily: [{ day, total, costUsd }] }]
export function areaTrend(series, { metric = 'total', width = 420, height = 200, fmt = compact, axisFmt = fmt, id = 'tr' } = {}) {
  const label = 'Daily trend by provider'
  const live = (series || []).filter((s) => s.daily?.length)
  if (!live.length) return empty(width, height, label)
  const days = live[0].daily.map((d) => d.day)
  const withWeekday = days.length <= 14
  const left = 40
  const top = 8
  const bottom = withWeekday ? 32 : 20
  const plotW = width - left
  const plotH = height - top - bottom
  const rawMax = Math.max(0, ...live.flatMap((s) => s.daily.map((d) => Number(d[metric]) || 0)))
  if (rawMax <= 0) return empty(width, height, label)
  const max = niceMax(rawMax)
  const x = (i) => left + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW)
  const y = (v) => top + plotH - (v / max) * plotH
  let defs = ''
  let body = ''
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g
    const gy = y(v)
    body += `<line x1="${left}" x2="${width}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" class="grid"/>`
    body += `<text x="${left - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="t-muted">${esc(axisFmt(v))}</text>`
  }
  // Draw the biggest series first so smaller ones stay visible on top.
  live.forEach((s, i) => {
    const color = providerColor(s.provider, i)
    const pts = s.daily.map((d, j) => [x(j), y(Number(d[metric]) || 0)])
    const line = smoothPath(pts)
    const gid = `${id}-g${i}`
    defs += `<linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`
    body += `<path d="${line}L${x(pts.length - 1).toFixed(1)},${top + plotH}L${x(0).toFixed(1)},${top + plotH}Z" fill="url(#${gid})"/>`
    body += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    // A one-day series has no line segment; keep its point visible without hovering.
    if (pts.length === 1) body += `<circle cx="${pts[0][0]}" cy="${pts[0][1].toFixed(1)}" r="3.5" fill="${color}"/>`
  })
  // Hover columns: one per day, crosshair + every provider's value.
  const col = days.length > 1 ? plotW / (days.length - 1) : plotW
  days.forEach((day, j) => {
    const rows = live.map((s) => [PROVIDER_LABELS[s.provider] ?? s.provider, fmt(Number(s.daily[j]?.[metric]) || 0)])
    const tip = esc(JSON.stringify({ title: shortDay(day), rows }))
    const cx = x(j)
    body += `<g class="mark xhair" data-tip="${tip}"><rect x="${Math.max(left, cx - col / 2)}" y="${top}" width="${col}" height="${plotH}" class="hit"/><line x1="${cx}" x2="${cx}" y1="${top}" y2="${top + plotH}" class="xline"/>`
    live.forEach((s, i) => { body += `<circle cx="${cx}" cy="${y(Number(s.daily[j]?.[metric]) || 0).toFixed(1)}" r="3.5" class="xdot" fill="${providerColor(s.provider, i)}"/>` })
    body += `</g>`
  })
  // Points run edge to edge, so the first and last labels hug the edges; the rest are centred.
  for (const j of dayTicks(days.length, days.length > 1 ? plotW / (days.length - 1) : plotW)) {
    const anchor = days.length > 1 && j === 0 ? 'start' : days.length > 1 && j === days.length - 1 ? 'end' : 'middle'
    body += dayLabel(days[j], x(j).toFixed(1), top + plotH + 14, anchor, withWeekday)
  }
  return svg(width, height, `<defs>${defs}</defs>${body}`, label)
}

// One thin rounded bar split into segments with 2px gaps. segments: [{ label, value, color }]
export function segmentBar(segments, { width = 360, height = 10, id = 'sbar' } = {}) {
  const label = 'Tokens by type'
  const live = (segments || []).filter((s) => s.value > 0)
  const total = live.reduce((a, s) => a + s.value, 0)
  let body = `<rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" class="track-fill"/>`
  if (total > 0) {
    const gap = 2
    const minW = 4
    const avail = width - gap * (live.length - 1)
    // Small segments get a visible minimum; the rest share what is left proportionally.
    const small = live.filter((s) => (s.value / total) * avail < minW)
    const bigTotal = total - small.reduce((a, s) => a + s.value, 0)
    const bigAvail = avail - small.length * minW
    let xpos = 0
    body = `<clipPath id="${id}-clip"><rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}"/></clipPath><g clip-path="url(#${id}-clip)">`
    for (const s of live) {
      const w = small.includes(s) ? minW : (s.value / bigTotal) * bigAvail
      const tip = esc(JSON.stringify({ title: s.label, rows: [['Tokens', s.value], ['Share', `${((s.value / total) * 100).toFixed(1)}%`]] }))
      body += `<rect class="mark" data-tip="${tip}" x="${xpos.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="${s.color}"/>`
      xpos += w + gap
    }
    body += `</g>`
  }
  return svg(width, height, body, label)
}
