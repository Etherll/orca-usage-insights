# COLD: cold on panel/index.html, src/panel/panel.js, tests/panel.test.mjs

## Artifact
Walk of target diff (a883bf7 vs eae3fa0), by hunk:
- panel/index.html 1449-1454: state gains defaultRange, rangePicked. Same as panel.js:9. Fine.
- panel/index.html 1602-1603: clearFilter range reset -> state.defaultRange. Fine: defaultRange is set to '7d' initially, validated on read.
- panel/index.html 1740-1741: applyDates sets rangePicked. Fine.
- panel/index.html 2037-2063: firstLoad, readDefaultRange. K1 (host.settings API unverified), K2 (no timeout on await).
- panel/index.html 2279: range button click sets rangePicked before no-op check. Intended per test "Clicking the range already shown counts as a pick". Fine.
- panel/index.html 2379: load() -> firstLoad(). Fine.
- src/panel/panel.js 5, 9: RANGE_DAYS import, state. Fine: RANGE_DAYS is a Map (src/core/query.mjs:3), .has works.
- panel.js 158: clearFilter -> defaultRange. Fine.
- panel.js 296: applyDates rangePicked. Fine.
- panel.js 592-618: firstLoad/readDefaultRange. Numbered reads guard stale answers (615-616). K1, K2.
- panel.js 834: rangePicked. Fine.
- panel.js 934: firstLoad. Fine.
- tests/panel.test.mjs 82, 130-147, 217-298: mock adds orca.settings and onDidChange; test asserts pass only because mock supplies those. Supports K1 (mock shape invented, nothing in repo calls host.settings).
- Stale-load race: busy path in load() (panel.js:48-50) re-runs with fresh filterInput; checked-fine.
- Manifest orca-plugin.json:88 declares defaultRange with enum 1d/7d/30d/90d/all; worker never reads it; panel validation at readDefaultRange matches enum. Checked-fine.

## Checked and fine
- Stale Default range read overwriting newer: ruled out by panel.js:613-616 (read counter).
- Range value outside enum: ruled out by panel.js:616 RANGE_DAYS.has / 'all' check.
- 'all' range accepted by normalizeQuery: ruled out by src/core/query.mjs:23 (range !== 'all' check).
- usage.changed during firstLoad: ruled out by load() busy/again logic (panel.js:48-50, 70-72); test at panel.test.mjs 245-270.

## Not checked
- Real Orca panel host API: whether orca.settings exists. Not in repo; K1 rests on that.
- tests/panel.test.mjs was read via diff only, not run. Tests not run.
- Full pack file list read at target via git show; no test execution.
