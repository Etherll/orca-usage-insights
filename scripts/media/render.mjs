#!/usr/bin/env node
// Renders the plugin page images (cover, screenshots, icon) from made-up demo data.
// Needs a Chromium-family browser: set CHROME_BIN, or have Playwright's headless shell installed.
// Usage: node scripts/media/render.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_SOURCES, DEMO_WORKTREE_ROOTS, demoRecords } from './demo-data.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, 'images')
const work = join(tmpdir(), 'usage-insights-media')
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })

function chrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  const base = join(homedir(), '.cache', 'ms-playwright')
  for (const dir of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-headless-shell-mac-arm64/chrome-headless-shell']) {
      const p = join(base, dir, rel)
      if (existsSync(p)) return p
    }
  }
  throw new Error('No Chromium found. Set CHROME_BIN.')
}
const CHROME = chrome()

execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'ignore' })
const panel = readFileSync(join(root, 'panel', 'index.html'), 'utf8')
const flatten = (src) => src.replace(/^import [^\n]*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace(/^export (?=(const|function|let|class) )/gm, '')
// Core modules for the browser stand-in. Each runs in its own scope (so private helpers with the
// same name don't clash); imports become reads from the modules before it. Order matters.
const CORE = ['bands', 'price-sources', 'catalog-data', 'catalog', 'pricing', 'filters', 'report']
const core = CORE.map((name) => {
  const src = readFileSync(join(root, 'src', 'core', `${name}.mjs`), 'utf8')
  const imports = [...src.matchAll(/^import \{([^}]*)\} from '\.\/([\w-]+)\.mjs';?$/gm)].map(([, names, from]) => `const {${names}} = __m[${JSON.stringify(from)}];`)
  const exported = [...src.matchAll(/^export (?:async )?(?:const|function|let|class) (\w+)/gm)].map((m) => m[1])
  for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) exported.push(...m[1].split(',').map((x) => x.trim()).filter(Boolean))
  return `__m[${JSON.stringify(name)}] = (() => {\n${imports.join('\n')}\n${flatten(src)}\nreturn { ${[...new Set(exported)].join(', ')} };\n})();`
}).join('\n') + '\nconst { buildReport } = __m.report;'

const NOW = new Date(2026, 10, 3, 17, 40)
const records = demoRecords(NOW)

// The panel page, with a stand-in for the worker that runs the real buildReport over demo data.
function demoPanel(name, { theme = 'dark', actions = '' } = {}) {
  const shim = `<script>(() => {
const __m = {};
${core}
const RECORDS = ${JSON.stringify(records)};
const NOW = new Date(${NOW.getTime()});
const ROOTS = ${JSON.stringify(DEMO_WORKTREE_ROOTS)};
const SOURCES = ${JSON.stringify(DEMO_SOURCES(NOW.getTime()))};
try { localStorage.setItem('usage-insights.prices-note.1.2.0', '1') } catch {}
window.__USAGE_PREVIEW__ = async (method, input = {}) => {
  if (method === 'prices.status') return { version: 'demo', asOf: '2026-11-11', overlay: null, canUndo: false, overrides: null };
  const opts = { range: input.range || '7d', now: NOW, providers: input.providers, hosts: input.hosts };
  if (input.scope === 'worktrees') opts.scope = { roots: ROOTS };
  const report = buildReport(RECORDS, opts);
  report.generatedAt = NOW.toISOString();
  report.sources = SOURCES.map((s) => ({ ...s, records: RECORDS.filter((r) => r.host === s.id).length }));
  return report;
};
Date.now = () => NOW.getTime();
})()</script>`
  const html = panel
    .replace('<html lang="en">', `<html lang="en" class="${theme}">`)
    .replace('<script>', `${shim}<script>`)
    .replace('</body>', `<script>${actions}</script></body>`)
  const file = join(work, `${name}.html`)
  writeFileSync(file, html)
  return file
}

const click = (sel, ms = 300) => `setTimeout(() => document.querySelector(${JSON.stringify(sel)})?.click(), ${ms});`
// Scrolls so the card holding `sel` starts just below the top edge.
const scrollTo = (sel, ms = 700, offset = 16) => `setTimeout(() => { const el = document.querySelector(${JSON.stringify(sel)}); const card = el && (el.closest('.card, .grid-2') || el); if (card) window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - ${offset}); }, ${ms});`

// The Orca mark, read from an Orca install (it is Orca's logo, so it isn't copied into this repo).
// Set ORCA_LOGO to an SVG path, or the newest AppImage cache under ~/.cache/orca is searched.
function orcaLogo() {
  const candidates = []
  if (process.env.ORCA_LOGO) candidates.push(process.env.ORCA_LOGO)
  const cache = join(homedir(), '.cache', 'orca', 'appimage')
  if (existsSync(cache)) {
    for (const a of readdirSync(cache)) for (const b of existsSync(join(cache, a)) ? safeList(join(cache, a)) : []) {
      candidates.push(join(cache, a, b, 'resources', 'app.asar.unpacked', 'resources', 'logo.svg'))
    }
  }
  candidates.push('/Applications/Orca.app/Contents/Resources/app.asar.unpacked/resources/logo.svg')
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    console.warn('Orca logo not found; set ORCA_LOGO. Rendering without it.')
    return ''
  }
  return `data:image/svg+xml;base64,${readFileSync(found).toString('base64')}`
}
function safeList(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
const LOGO = orcaLogo()

// A framed shot in Orca's look: near-black (or soft grey) neutral background, the panel inside an
// Orca-style window with a slim title bar.
function frame(name, panels, { width = 1600, height = 1000, title = '', subtitle = '', bg = 'dark' } = {}) {
  const dark = bg === 'dark'
  const BAR = 36
  const logo = (h, invert) => (LOGO ? `<img src="${LOGO}" style="height:${h}px;${invert ? 'filter:invert(1);' : ''}" alt="">` : '')
  const items = panels.map((p) => `<div class="win ${(p.theme ? p.theme === 'dark' : dark) ? 'wd' : 'wl'}" style="width:${p.w}px">
    <div class="bar"><span class="brand">${logo(13, !(p.theme ? p.theme === 'dark' : dark))}<b>Orca</b></span><span class="tab">Usage Insights</span><span class="dots"><i></i><i></i><i></i></span></div>
    <iframe src="file://${p.file}" width="${p.w}" height="${p.h - BAR}" scrolling="no"></iframe></div>`).join('')
  const text = title ? `<div class="copy">${logo(30, !dark)}<h1>${title}</h1><p>${subtitle}</p><small>Reads Claude Code and Codex transcripts on this machine and on SSH hosts you add. Nothing is uploaded.</small></div>` : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{display:flex;align-items:center;justify-content:center;gap:56px;background:${dark
    ? 'radial-gradient(1100px 620px at 50% -12%, rgba(255,255,255,.09), rgba(255,255,255,0) 70%), radial-gradient(700px 500px at 100% 110%, rgba(255,255,255,.04), rgba(255,255,255,0) 70%), #060606'
    : 'radial-gradient(1100px 620px at 50% -12%, #ffffff, rgba(255,255,255,0) 70%), #ececec'}}
.win{border-radius:12px;overflow:hidden;flex:none;box-shadow:0 40px 90px rgba(0,0,0,${dark ? '.7' : '.16'}),0 0 0 1px ${dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.09)'}}
.bar{height:${BAR}px;display:flex;align-items:center;gap:14px;padding:0 14px;font-size:12.5px;box-sizing:border-box}
.wd .bar{background:#0c0c0c;color:#d6d6d6;border-bottom:1px solid rgba(255,255,255,.07)}
.wl .bar{background:#fafafa;color:#2a2a2a;border-bottom:1px solid rgba(0,0,0,.07)}
.wd .tab{color:#8d8d8d;background:rgba(255,255,255,.05)}.wl .tab{color:#6d6d6d;background:rgba(0,0,0,.04)}
.wd .dots i{background:rgba(255,255,255,.14)}.wl .dots i{background:rgba(0,0,0,.14)}
.brand{display:inline-flex;align-items:center;gap:7px}.brand b{font-weight:600}
.tab{color:${dark ? '#8d8d8d' : '#6d6d6d'};padding:3px 10px;border-radius:6px;background:${dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)'}}
.dots{margin-left:auto;display:inline-flex;gap:6px}.dots i{width:9px;height:9px;border-radius:50%;background:${dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)'}}
iframe{border:0;display:block}
.copy{width:340px;color:${dark ? '#f2f2f2' : '#111'};flex:none;align-self:flex-end;margin-bottom:70px}
.copy img{display:block;margin-bottom:22px;opacity:.9}
small{display:block;font-size:14px;line-height:1.5;color:${dark ? '#7a7a7a' : '#777'};border-top:1px solid ${dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)'};padding-top:14px}
.badge{display:inline-block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;padding:6px 12px;border-radius:999px;border:1px solid ${dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.14)'};color:${dark ? '#bdbdbd' : '#555'}}
h1{font-size:40px;line-height:1.1;margin:0 0 14px;letter-spacing:-.015em;font-weight:600}
p{font-size:19px;line-height:1.5;margin:0 0 22px;color:${dark ? '#b4b4b4' : '#444'}}
ul{margin:0;padding:0;list-style:none;display:grid;gap:12px;font-size:18px;color:${dark ? '#dcdcdc' : '#222'}}
li{display:flex;gap:12px;align-items:center}li::before{content:"";width:6px;height:6px;border-radius:50%;background:${dark ? '#fff' : '#111'};flex:none}
</style></head><body>${text}${items}</body></html>`
  const file = join(work, `${name}-frame.html`)
  writeFileSync(file, html)
  const png = join(out, `${name}.png`)
  execFileSync(CHROME, ['--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files', '--force-device-scale-factor=1', `--window-size=${width},${height}`, '--virtual-time-budget=6000', `--screenshot=${png}`, `file://${file}`], { stdio: 'ignore' })
  return png
}

const shots = []
// Cover: title + the overview.
shots.push(frame('cover', [{ file: demoPanel('cover', { actions: click('[data-range="30d"]') }), w: 1080, h: 900 }], { title: 'Usage Insights', subtitle: 'Token use and estimated API cost for your Claude Code and Codex sessions, by day, project, model and machine.' }))
// 1. Overview, wide.
shots.push(frame('screenshot-overview', [{ file: demoPanel('overview', { actions: click('[data-range="30d"]') }), w: 1440, h: 880 }]))
// 2. Cost view: daily cost and the breakdown.
shots.push(frame('screenshot-cost', [{ file: demoPanel('cost', { actions: click('[data-range="30d"]') + click('[data-metric=cost]', 600) + scrollTo('#daily', 1100) }), w: 1440, h: 880 }]))
// 3. Filters menu open, worktrees only.
shots.push(frame('screenshot-filters', [{ file: demoPanel('filters', { actions: click('[data-scope=worktrees]') + click('#filters-btn', 700) }), w: 1440, h: 880 }]))
// 4. Activity calendar and rhythm, light theme.
shots.push(frame('screenshot-activity', [{ file: demoPanel('activity', { theme: 'light', actions: click('[data-range="90d"]') + scrollTo('#calendar', 900) }), w: 1440, h: 880 }], { bg: 'light' }))
// 5. Sidebar width, dark and light side by side.
shots.push(frame('screenshot-sidebar', [
  { file: demoPanel('side-dark', {}), w: 420, h: 900, theme: 'dark' },
  { file: demoPanel('side-light', { theme: 'light', actions: scrollTo('#breakdown', 800) }), w: 420, h: 900, theme: 'light' },
]))

// Icon: the pixel skyline on a rounded square.
const art = flatten(readFileSync(join(root, 'src/panel/art.mjs'), 'utf8'))
const iconHtml = join(work, 'icon.html')
writeFileSync(iconHtml, `<!doctype html><html><body style="margin:0;width:256px;height:256px;background:transparent"><div id="i" style="width:256px;height:256px;border-radius:56px;overflow:hidden;image-rendering:pixelated"></div><script>${art}
const daily = [3,5,4,7,6,9,8,11,10,13].map((v) => ({ total: v }));
document.getElementById('i').innerHTML = pixelBanner({ generatedAt: new Date(2026,10,3,22).toISOString(), range: '7d', daily, totals: { total: 100, output: 3, turns: 40 }, streak: { current: 9 }, today: { total: 9 }, peakDay: { total: 13 } }, { w: 40, h: 40 });
document.querySelector('svg').setAttribute('preserveAspectRatio', 'none'); document.querySelector('svg').style.cssText = 'width:256px;height:256px;display:block';
</script></body></html>`)
execFileSync(CHROME, ['--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', '--default-background-color=00000000', '--window-size=256,256', '--virtual-time-budget=2000', `--screenshot=${join(out, 'icon.png')}`, `file://${iconHtml}`], { stdio: 'ignore' })

for (const p of [...shots, join(out, 'icon.png')]) console.log(p.replace(root, ''), `${Math.round(readFileSync(p).length / 1024)} KB`)
