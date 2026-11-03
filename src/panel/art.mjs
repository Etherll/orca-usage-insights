// Generative pixel-art banner. The scene is deterministic for a given report:
// the skyline follows the daily series, lit windows follow output share, stars count the
// current streak, and the sky follows the local hour the report was generated.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

const SKIES = {
  night: { top: '#0b1026', bottom: '#2a2f5c', far: '#1c2142', near: '#12152c', window: '#ffd27a', glow: '#f4f1de' },
  dawn: { top: '#3b3a6e', bottom: '#f29e7d', far: '#5a4a78', near: '#2b2440', window: '#ffe3a3', glow: '#fff1c1' },
  day: { top: '#4f9ee8', bottom: '#bfe3f7', far: '#7fa8c9', near: '#3c5a78', window: '#e8f4ff', glow: '#fff6c9' },
  dusk: { top: '#2d2357', bottom: '#e0704f', far: '#4b2f5e', near: '#22183a', window: '#ffc46b', glow: '#ffd9a0' },
}

export function skyFor(hour) {
  if (hour >= 5 && hour < 8) return 'dawn'
  if (hour >= 8 && hour < 17) return 'day'
  if (hour >= 17 && hour < 20) return 'dusk'
  return 'night'
}

// Small seeded PRNG (mulberry32).
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a, b, t) {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

// Resample a series to n buckets by summing.
export function resample(values, n) {
  if (!values.length) return Array(n).fill(0)
  const out = Array(n).fill(0)
  values.forEach((v, i) => {
    out[Math.min(n - 1, Math.floor((i / values.length) * n))] += v
  })
  return out
}

// Builds the pixel grid (array of rows of hex colors). Exported for tests.
export function paintScene(report, { w = 120, h = 34 } = {}) {
  const generated = report?.generatedAt ? new Date(report.generatedAt) : new Date()
  const sky = SKIES[skyFor(generated.getHours())]
  const daily = (report?.daily || []).map((d) => d.total || 0)
  const seed = hashString(`${report?.range || ''}:${daily.length}:${report?.totals?.turns || 0}`)
  const rand = rng(seed)
  const grid = Array.from({ length: h }, () => Array(w).fill(null))

  // Sky: 4-step ordered-dither gradient between top and bottom colors.
  const bands = [sky.top, mix(sky.top, sky.bottom, 0.33), mix(sky.top, sky.bottom, 0.66), sky.bottom]
  for (let y = 0; y < h; y++) {
    const t = (y / (h - 1)) * (bands.length - 1)
    const base = Math.floor(t)
    const frac = t - base
    for (let x = 0; x < w; x++) {
      const threshold = BAYER[(y % 4) * 4 + (x % 4)] / 16
      grid[y][x] = bands[Math.min(bands.length - 1, base + (frac > threshold ? 1 : 0))]
    }
  }

  // Stars (night/dusk/dawn only): one per streak day, at least a few.
  const streak = report?.streak?.current || 0
  if (skyFor(generated.getHours()) !== 'day') {
    const count = Math.min(40, 4 + streak * 2)
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rand() * w)
      const y = Math.floor(rand() * (h * 0.45))
      grid[y][x] = i < streak ? sky.glow : mix(sky.glow, sky.top, 0.45)
    }
  }

  // Sun or moon, its height following today's share of the peak day.
  const peak = report?.peakDay?.total || 0
  const todayShare = peak > 0 ? Math.min(1, (report?.today?.total || 0) / peak) : 0
  const cx = Math.floor(w * 0.82)
  const cy = Math.floor(3 + (1 - todayShare) * (h * 0.3))
  for (let y = -3; y <= 3; y++) {
    for (let x = -3; x <= 3; x++) {
      if (x * x + y * y <= 9 && grid[cy + y]?.[cx + x] !== undefined) grid[cy + y][cx + x] = sky.glow
    }
  }

  // Far ridge: smoothed random walk.
  let ridge = h * 0.55
  for (let x = 0; x < w; x++) {
    ridge += (rand() - 0.5) * 2.2
    ridge = Math.max(h * 0.42, Math.min(h * 0.7, ridge))
    for (let y = Math.floor(ridge); y < h; y++) grid[y][x] = sky.far
  }

  // Skyline: one building per bucket, height from usage.
  const count = Math.max(8, Math.min(24, daily.length || 12))
  const buckets = resample(daily, count)
  const max = Math.max(...buckets, 0)
  const outShare = report?.totals?.total ? Math.min(1, (report.totals.output * 20) / report.totals.total + 0.2) : 0.3
  const bw = Math.floor(w / count)
  buckets.forEach((v, i) => {
    const bh = Math.max(3, Math.round((max > 0 ? v / max : 0.1) * (h * 0.62)) + 2)
    const x0 = i * bw + (i % 2)
    const width = Math.max(2, bw - 1 - (i % 2))
    for (let y = h - bh; y < h; y++) {
      for (let x = x0; x < x0 + width && x < w; x++) grid[y][x] = sky.near
    }
    // antenna on the tallest
    if (v === max && max > 0) for (let y = h - bh - 3; y < h - bh; y++) if (y >= 0) grid[y][x0 + (width >> 1)] = sky.near
    // windows
    for (let y = h - bh + 2; y < h - 1; y += 2) {
      for (let x = x0 + 1; x < x0 + width - 1; x += 2) {
        if (rand() < outShare) grid[y][x] = sky.window
      }
    }
  })
  return grid
}

// Grid -> SVG, merging horizontal runs so a 120x34 scene stays a few hundred rects.
export function pixelBanner(report, opts = {}) {
  const grid = paintScene(report, opts)
  const h = grid.length
  const w = grid[0].length
  let body = ''
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      const c = grid[y][x]
      let run = 1
      while (x + run < w && grid[y][x + run] === c) run++
      body += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${c}"/>`
      x += run
    }
  }
  return `<svg class="banner" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges" role="img" aria-label="Pixel skyline drawn from your usage" xmlns="http://www.w3.org/2000/svg">${body}</svg>`
}
