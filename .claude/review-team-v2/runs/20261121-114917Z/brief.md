# Review brief

- Target: `8fd32f90be1b3aa3a83c8b8d94c2d73b4bdd777c` (https://github.com/Etherll/orca-usage-insights/pull/7)
- Baseline: `eae3fa08f21323c5679a7dbbeced2a1777a272a1` (merge-base with `origin/main`)
- Depth: `standard` (48 changed source lines in 1 file(s))
- Mode: `delta`, prior run `/tmp/claude-1000/-home-etherl-orca-workspaces-orca-usage-insights-Etherll-geoduck/b69d9523-5f26-4652-ae90-f8a53c710969/scratchpad/pr7fix/.claude/review-team-v2/runs/20261121-114605Z`, 3 delta file(s)
- Changed: 6 files, 248 lines; 3 to walk
- Domain packs: persistence

## Lanes owed (round 1)

- L1: lenses `trace, cases, journey` over shard `S1`, effort medium
- L2: lenses `state, time, ripple` over shard `S1`, effort medium
- lead: lens `intent` over the whole diff
- COLD: lens `cold` over the whole diff, dispatched with round 1

## Shards

- S1 (210 lines): `panel/index.html`, `src/panel/panel.js`, `tests/panel.test.mjs`

## Files

| File | Kind | +/- | Hunks | Changed symbols |
| --- | --- | --- | --- | --- |
| `README.md` (carried forward) | docs | +1/-1 | 1 |  |
| `orca-plugin.json` (carried forward) | config | +21/-0 | 1 |  |
| `panel/index.html` | config | +43/-3 | 6 |  |
| `src/panel/panel.js` | source | +44/-4 | 6 | clearFilter, applyDates, renderBreakdownView, firstLoad, defaultRangeReads, pendingDefaultRead, readDefaultRange, bindControls |
| `tests/panel.test.mjs` | test | +112/-4 | 4 | fakeDom, mountPanel |
| `tests/worker.test.mjs` (carried forward) | test | +13/-2 | 2 |  |

## Unchanged code that still uses changed names

Lexical seeds, not a complete caller list. Full lists: `scope.json`.

- `clearFilter` (3 uses): src/panel/panel.js:147, src/panel/panel.js:901, src/panel/panel.js:904
- `applyDates` (3 uses): src/panel/panel.js:280, src/panel/panel.js:849, src/panel/panel.js:856
- `renderBreakdownView` (2 uses): src/panel/panel.js:562, src/panel/panel.js:576
- `bindControls` (2 uses): src/panel/panel.js:817, src/panel/panel.js:941
