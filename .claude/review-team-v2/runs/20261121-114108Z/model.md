# Ownership model — PR #7 fix delta (cf7b7cf)

Prior run: F-001 (default not followed while open, panel.js clearFilter) and F-002 (gate on report/busy as proxy for user pick, firstLoad). This delta is the fix.

## 1. Promise
- P1 A range the person picks (range button incl. the one already shown, or Custom Apply) before the setting is read is kept. holds: state.rangePicked set in ranges click handler before the same-range early return, and in applyDates; firstLoad checks !state.rangePicked.
- P2 A load that started without the setting (background usage.changed) is redone on the default. holds: moved=true → load(); load() while busy sets state.again → reload after the first finishes (panel.js load finally).
- P3 A failed picked load is retried on the picked range, not the default. holds: rangePicked keeps range; !report && !busy → load().
- P4 Changing the setting while open updates state.defaultRange (used when a custom range is cleared); it does not switch the shown range. holds: host.settings.onDidChange → readDefaultRange.
- P5 Unknown/unreadable → keep 7d. holds: readDefaultRange returns null.

## 2. State
| State | Lives | Writer | Reader | Cleared |
|---|---|---|---|---|
| state.rangePicked | panel memory | ranges click, applyDates | firstLoad | never (only matters before first read) |
| state.defaultRange | panel memory | firstLoad, onDidChange callback | clearFilter | — |
| state.again | panel memory | load() when busy | load() finally | load finally |

## 3. Scenarios
- usage.changed during pending get: onChanged → load (7d, busy) → get resolves 30d → state.range=30d, moved → load() → busy → state.again → after 7d finishes, load(again) with 30d. Test covers (calls 7d,30d).
- Settings change while open: onDidChange({key}) → readDefaultRange → state.defaultRange; later clearFilter('range') → that value. Test covers.

## 4. Decisions
- firstLoad: (range valid) × (rangePicked) × (range==current) × (busy/report) — moved only when valid, not picked, different.

## 5. Boundaries
- orca.settings.onDidChange (orca-services.d.ts:103) may be absent on old hosts → optional chaining.
- settings.get deadlined by the shell (plugin-panel-shell.js:115).

## 6. Blast radius
- tests/panel.test.mjs mountPanel now records plugin.on handlers (pluginEvents) — other tests unaffected (they ignored on()).
- panel/index.html rebuilt.

## Suspicions
- src/panel/panel.js firstLoad: when moved while a background load is in flight, the 7d report renders briefly before the 30d reload (flash). Probably acceptable.
- src/panel/panel.js onDidChange: two quick changes could resolve out of order; last write wins by resolution order.
