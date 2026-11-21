# COLD: cold on panel/index.html, src/panel/panel.js, tests/panel.test.mjs

## Artifact
Target 05443d3. Hunks walked:
- panel/index.html:1444-1454 state gains defaultRange, rangePicked. Mirrors panel.js:9. OK.
- index.html:1603, panel.js:158 clearFilter range resets to state.defaultRange. Fine: 'all' accepted (src/core/query.mjs:23), RANGE_DAYS is a Map (query.mjs:3).
- index.html:1741, panel.js:296 applyDates sets rangePicked. Fine.
- index.html:2037-2076, panel.js:592-631 firstLoad/readDefaultRange. Read numbering and waiters checked: stale reads drop out (panel.js:626), rejected read is caught (panel.js:624), waiters resolve on newest read. Host API unverified: K1. Slow-read race: K2.
- index.html:2282, panel.js:837 ranges click sets rangePicked before custom branch. Fine: intended per tests 325-347.
- index.html:2392, panel.js:947 load() replaced by firstLoad(). Fine.
- tests/panel.test.mjs:82, 130-147, 217-347. Mock settings shape copies K1 assumption; no test of production host shape.

## Checked and fine
- Double load on mid-flight change: ruled out by load() busy queue (src/panel/panel.js:50-53, 72-74); second load runs after the first, with current filters.
- Stale range read overwriting newer: ruled out by read numbering (src/panel/panel.js:620, 626) and tests 288-299.
- Reset to default never moves a picked range: ruled out by rangePicked guard (src/panel/panel.js:603-605).
- Read failure crashes firstLoad: ruled out by rejection handler (src/panel/panel.js:624) and waiter step (src/panel/panel.js:625-630).

## Not checked
- Orca panel host API: no definition of host.settings in repo; K1 medium confidence.
- panel/index.html vs src/panel/panel.js sync: diff shows identical hunks; no build check run.
- Tests not run (read-only lane).
- Breakdown view responses after range move (K2 sweep).
