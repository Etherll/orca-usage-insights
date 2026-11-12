import test from 'node:test'
import assert from 'node:assert/strict'
import { findings, headline, legend, notAnalysed, priceLine, syncBody, tree, usd } from '../src/panel/breakdown.js'

const view = {
  totals: {
    usageUsd: 12.5,
    analysedUsd: 10,
    notAnalysed: [{ reason: 'ssh', usd: 2.5, turns: 4 }, { reason: 'unpriced', usd: null, turns: 2 }],
    unpricedModels: [{ model: '<b>mystery</b>', turns: 2, tokens: 10 }],
  },
  buckets: [{ key: 'tools', usd: 6, share: 0.6, est: true }, { key: 'output', usd: 4, share: 0.4, est: false }],
  path: ['/w/<proj>', 'src'],
  nodes: [
    { key: 'a<b>.mjs', label: 'a<b>.mjs', kind: 'file', usd: 6, share: 0.6, est: false, children: false },
    { key: 'lib', label: 'lib', kind: 'folder', usd: 4, share: 0.4, est: true, children: true },
  ],
  more: { count: 3, usd: 0.5 },
  findings: [{ id: 'large-results:abc', kind: 'large-results', harness: 'claude', usd: 3, est: false, where: { project: '/w/proj', label: '"x"', key: 'src/x' }, facts: { tokens: 10, sessions: 2 }, lastSeen: '2026-11-03', daily: [['2026-11-02', 1], ['2026-11-03', 2]], evidence: [] }],
  health: { splitShare: 0.25, unattributedShare: 0, dedupeUsd: 1, explainUsd: 0 },
}

test('usd marks estimates, unpriced and unmeasurable values', () => {
  assert.equal(usd(null), '—')
  assert.equal(usd(3, { est: true }), '≈$3.00')
  assert.equal(usd(3, { plus: true }), '$3.00+')
  assert.equal(usd(1234.4), '$1,234')
  assert.equal(usd(0.004), '$0.0040')
})

test('builders escape every label from the worker', () => {
  const html = [headline(view), tree(view).crumbs, tree(view).rows, findings(view), notAnalysed(view)].join('')
  assert.ok(!html.includes('<b>'), 'no raw markup from data')
  assert.ok(html.includes('a&lt;b&gt;.mjs'))
  assert.ok(html.includes('&lt;b&gt;mystery&lt;/b&gt;'))
})

test('the headline shows the Usage total with + when models are unpriced', () => {
  const html = headline(view)
  assert.match(html, /\$12\.50\+/)
  assert.match(html, /not analysed/)
})

test('crumbs mark the current level and rows drill only where there are children', () => {
  const t = tree(view)
  assert.match(t.crumbs, /data-depth="2" aria-current="page"/)
  assert.match(t.rows, /<button class="node" data-key="lib"/)
  assert.ok(!/<button class="node" data-key="a/.test(t.rows))
  assert.match(t.rows, /\+ 3 more/)
})

test('finding cards carry an Explain button with the finding id and no total', () => {
  const html = findings(view)
  assert.match(html, /data-explain="large-results:abc"/)
  assert.match(html, /Cost of this pattern/)
  assert.match(findings({ ...view, findings: [] }), /No pattern above \$1/)
})

test('not analysed lists reasons with next steps and the unpriced models', () => {
  const html = notAnalysed(view)
  assert.match(html, /On SSH hosts/)
  assert.match(html, /price-overrides\.json/)
  assert.equal(notAnalysed({ ...view, totals: { ...view.totals, notAnalysed: [] } }), '')
})

test('legend explains the marks and the dedupe', () => {
  assert.match(legend(view), /25\.0%/)
  assert.match(legend(view), /resumed sessions/)
})

test('price line shows the source, overrides and only the actions that apply', () => {
  const bundled = priceLine({ version: 'v', asOf: '2026-11-11', overlay: null, canUndo: false, overrides: null })
  assert.match(bundled, /bundled 2026-11-11/)
  assert.ok(!bundled.includes('data-price="undo"'))
  assert.ok(!bundled.includes('data-price="reset"'))
  const synced = priceLine({ version: 'v', asOf: '2026-11-11', overlay: { appliedAt: '2026-11-12T10:00:00Z', sources: ['litellm'] }, canUndo: true, overrides: { file: '/c/price-overrides.json', models: 2, aliases: 1, problems: ['overrides: bad rate'] } })
  assert.match(synced, /synced 2026-11-12/)
  assert.match(synced, /your overrides \(2 models, 1 alias\)/)
  assert.match(synced, /data-price="undo"/)
  assert.match(synced, /Overrides file: overrides: bad rate/)
})

test('sync rows keep ticks, and overridden rows cannot be ticked', () => {
  const html = syncBody({
    diffId: 'd1',
    sources: [{ name: 'litellm', ok: true, rows: 2 }, { name: 'models.dev', ok: false, error: 'timeout' }],
    rows: [
      { key: 'claude-opus-5-5.output', model: 'claude-opus-5-5', field: 'output', current: 20, litellm: 18, modelsdev: 18, status: 'agree', ticked: true },
      { key: 'claude-opus-5-5.input', model: 'claude-opus-5-5', field: 'input', current: 4, litellm: 5, modelsdev: null, status: 'overridden', ticked: false },
    ],
    impact: { beforeUsd: 10, afterUsd: 9 },
  })
  assert.match(html, /\$10\.00<\/strong> now → <strong>\$9\.00/)
  assert.match(html, /data-key="claude-opus-5-5\.output" checked/)
  assert.match(html, /data-key="claude-opus-5-5\.input" disabled/)
  assert.match(html, /models\.dev: timeout/)
})

test('Sync leaves out prices that already match and counts them', async () => {
  const { syncBody } = await import('../src/panel/breakdown.js')
  const html = syncBody({
    diffId: 'd2',
    sources: [{ name: 'litellm', ok: true, rows: 3 }, { name: 'models.dev', ok: true, rows: 3 }],
    rows: [
      { key: 'm.input', model: 'm', field: 'input', current: 4, litellm: 4, modelsdev: 4, status: 'agree', ticked: true },
      { key: 'm.output', model: 'm', field: 'output', current: 20, litellm: 18, modelsdev: 19, status: 'disagree', ticked: false },
      { key: 'n.input', model: 'n', field: 'input', current: null, litellm: 1, modelsdev: 1, status: 'new', ticked: false },
    ],
  })
  assert.doesNotMatch(html, /data-key="m\.input"/)
  assert.match(html, /data-key="m\.output"/)
  assert.match(html, /data-key="n\.input"/)
  assert.match(html, /\$18<span class="muted small">models\.dev \$19/)
  assert.match(html, /1 more price matches what you use now/)
})
