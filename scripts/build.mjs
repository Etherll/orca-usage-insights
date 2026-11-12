// Orca frames accept inline scripts and styles only, so the panel ships as one self-contained
// HTML file. The ES modules in src/panel are flattened into a single classic script.
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
// Re-export lines (`export { name }`) go too: the names are already global in the bundle.
const flatten = (src) =>
  src.replace(/^import [^\n]*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace(/^export (?=(const|function|let|class) )/gm, '')

// query.mjs and format.mjs go first: panel.js validates dates with query.mjs, and charts.mjs and panel.js use compact().
const modules = ['src/core/query.mjs', 'src/core/format.mjs', 'src/panel/charts.mjs', 'src/panel/art.mjs', 'src/panel/breakdown.js', 'src/panel/panel.js']
const script = modules.map((p) => `// ${p}\n${flatten(read(p))}`).join('\n')
const html = read('src/panel/panel.html')
  .replace('/* PANEL_STYLES */', () => read('src/panel/panel.css'))
  .replace('/* PANEL_SCRIPT */', () => `;(() => {\n'use strict'\n${script}\n})()`)

const out = process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`) : new URL('panel/index.html', root)
writeFileSync(out, html)
console.log(`Built ${out.pathname}`)
