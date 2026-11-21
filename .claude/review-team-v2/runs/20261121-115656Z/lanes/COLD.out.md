# COLD: cold on panel/index.html, src/panel/panel.js, tests/panel.test.mjs

## Artifact
Walk, target e4b2f23 vs eae3fa0.

- panel/index.html:1444-1790 (hunk 1): inline copy of panel.js. Mirrors all panel.js hunks. Defines RANGE_DAYS at :622, so readDefaultRange guard resolves.
- panel/index.html:1603, 1741, 2037-2082, 2288, 2398: same as panel.js hunks below.
- panel.js:2-9: import RANGE_DAYS from core/query.mjs:3 (exists). state gains defaultRange, rangePicked.
- panel.js:158: clearFilter('range') returns to state.defaultRange. Was '7d'. Fine.
- panel.js:296: applyDates sets rangePicked. Fine.
- panel.js:595-612 firstLoad: waiters, slow timer 1500 ms, move-if-unpicked. Logic traced; load() (panel.js:47-52) queues via state.again, so deferred moved load is safe. K1, K2.
- panel.js:621-637 readDefaultRange: numbered reads. Newest-read-fails-older-late case: K2. Invalid values rejected by RANGE_DAYS guard (core/query.mjs:23 agrees; 'all' accepted, 'custom' rejected).
- panel.js:843: rangePicked set before the no-op return. Intended per test.
- panel.js:596, 625: host?.settings usage. Repo has no panel-side definition (rg). K1.
- tests/panel.test.mjs:82: find instead of calls[0]. K3.
- tests 217-361: new cases read through; race cases match the code.

## Checked and fine
- load() concurrency with moved reload: panel.js:48-51 sets state.again, so the moved load runs after the in-flight one.
- Out-of-order reads: panel.js:627 skips reads numbered below defaultRangeApplied; panel.js:632 resolves waiters only on newest.
- Invalid default ('1y', unknown): panel.js:627 guard returns, keeps 7d.
- Stuck first read: slow timer panel.js:599 loads 7d, firstLoad resumes when read answers.

## Not checked
- Orca panel host API: no repo source defines orca.settings for panels. Could not confirm K1.
- Whether index.html is generated from panel.js (build step) or hand-synced. Not read.
- Other panels with the same read pattern: out of shard.
- Did not run tests (node --test).
