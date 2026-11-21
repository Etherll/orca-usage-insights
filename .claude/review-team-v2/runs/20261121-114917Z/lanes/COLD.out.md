# COLD: cold on panel/index.html, src/panel/panel.js, tests/panel.test.mjs

## Artifact
Walk, target 8fd32f9, baseline eae3fa0.
- index.html:1444-1464: pct1/state line; inline copy of panel.js. Same Default range edits as panel.js: state (1454), clearFilter range (1603), applyDates rangePicked (1741), firstLoad/readDefaultRange (2040-2073), range click rangePicked (2289), firstLoad at boot (2389). Inline RANGE_DAYS defined (622), so :2068 does not throw ReferenceError. Checked-fine.
- panel.js:9 state adds defaultRange, rangePicked. Checked-fine.
- panel.js:157-159 clearFilter range/all uses defaultRange. Checked-fine: custom-only path (activeFilters panel.js:128 shows chip only for custom).
- panel.js:295-296 applyDates sets rangePicked. Checked-fine.
- panel.js:595-612 firstLoad. Candidate K1 (601), K2 (605).
- panel.js:616-628 readDefaultRange: numbered reads; stale answers dropped (623); pending cleared only by newest (625). Checked-fine.
- panel.js:831-847 range click: rangePicked before same-range return. Checked-fine.
- panel.js:940-946 boot calls firstLoad, loadPrices. Checked-fine.
- orca-plugin.json:88-101 declares defaultRange, default 7d, enum 1d/7d/30d/90d/all. Matches readDefaultRange guard. Checked-fine.
- host API: orca-services.d.ts (Orca appimage types, read by path) declares SettingsApi get(key), onDidChange; panel.js:596 uses optional chaining for old hosts. Checked-fine.
- tests/panel.test.mjs:82 find-based assertion: calls are [name, input] arrays in that harness, so the destructure is valid. Checked-fine; weaker than calls[0] but not a defect.
- tests 217-322: cover pick-before-read, stale read, newer-first-read, slow read. Not checked: a test for K1 (stalled read then newer read) and K2 (Custom click during read).

## Checked and fine
- Stale settings answer overwrites newer: ruled out by panel.js:623 read===defaultRangeReads.
- Unknown or 1y default: ruled out by panel.js:623 RANGE_DAYS guard; test :230.
- Slow first read holds report: ruled out by panel.js:599 timer load; test :313.
- busy load with a changed range: ruled out by panel.js:55-58 state.again; the reload reads state at call time.
- Infinite await loop in firstLoad: ruled out by panel.js:625 newest read clears pending; stale reads never block forever.
- Background usage.changed before read: ruled out by panel.js:718-720 load redone via firstLoad moved path; test :245.

## Not checked
- Orca settings.get deadline (plugin-panel-shell) length, needed to size K1.
- Keyboard radio path for rangePicked (bindRadioKeys) for K2.
- Real Orca runtime; only the types file and the tests run in the mock.
- Tests were not run (read only).
