# COLD: cold on panel/index.html, src/panel/panel.js, tests/panel.test.mjs

## Artifact
Walk, hunks in order:
- panel/index.html 1449-1454 (state adds defaultRange, rangePicked): fine, mirrors panel.js:9.
- panel/index.html 1602-1604 clearFilter range reset to state.defaultRange: fine. Value is always 7d, 1d, 30d, 90d or all. RANGE_DAYS and 'all' pass normalizeQuery (query.mjs:23).
- panel/index.html 1740-1741 applyDates sets rangePicked: fine.
- panel/index.html 2037-2066 firstLoad, readDefaultRange: K1, K2, K3 below. Range moved path (2046-2054) with busy load: load() busy branch sets state.again (panel.js:48-51), so the redo uses the new range: checked-fine.
- panel/index.html 2068-2075 loadPrices and 2378-2384 bootstrap call firstLoad instead of load: K2 (no fallback).
- panel/index.html 2282 and src/panel/panel.js:837 rangePicked on preset click: fine. Same-range click counts as pick (test 264-269), by design.
- tests/panel.test.mjs 82 calls.find: fine. 130-146 mountPanel adds settings and on(name, handler): mocks match new code, not real host (K1).
- tests 217-286: cover default, unknown/unreadable, pick-before-read, background load, failed pick, changed default. No test of hang (K2) or out-of-order reads (K3).

## Checked and fine
- Unknown or invalid saved value: readDefaultRange returns null (panel.js:617), opens on 7d: ruled out by tests 230-233.
- 'all' saved default: accepted (panel.js:617), valid in normalizeQuery (query.mjs:23): ruled out.
- Busy load when defaults move: load() busy branch (panel.js:48-51) plus 'again' redo reads current state.range at request time: ruled out.
- Chip clear 'all' with range custom goes to default: panel.js:158 covers it.

## Not checked
- Whether Orca exposes globalThis.orca.settings (get, onDidChange) to panels: not in repo. Drives K1 severity.
- Whether host settings reads can hang (K2) and whether settings events arrive in order (K3).
- Real-browser run of panel/index.html: not run. Not read: charts/breakdown modules for the same state.
