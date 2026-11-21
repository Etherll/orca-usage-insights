# Ownership model — PR #7 fix delta 5 (e4b2f23)

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


## Delta 2 (a883bf7)
- readDefaultRange now numbers reads (defaultRangeReads) and writes state.defaultRange only for the newest read; firstLoad applies state.defaultRange after awaiting its read. Closes prior F-001 (out-of-order reads). Test: "an older Default range read that answers last does not win over a newer one".
- Settled facts (do not re-raise without new evidence):
  - Panels have orca.settings.get(key) and onDidChange: /home/etherl/.cache/orca/appimage/2602f079d4bba7502153504e/fb91f2c5982935052c2fe4bc/resources/plugins/types/orca-frame.d.ts:93-94, orca-services.d.ts:98-104.
  - Frame host calls cannot hang forever: /home/etherl/.cache/orca/appimage/2602f079d4bba7502153504e/fb91f2c5982935052c2fe4bc/resources/app.asar.unpacked/out/shared/plugins/frames/plugin-panel-shell.js:115 rejects with code timeout; readDefaultRange catches it.
- Suspicion: an onDidChange read that is newer but invalid/unreadable leaves the older valid read discarded → state.defaultRange keeps its previous value. Acceptable (same as an unreadable setting).


## Delta 3
- readDefaultRange is sync-returning; pendingDefaultRead holds the newest read's promise and is cleared only by the newest read. firstLoad: starts a read, sets a 1.5 s fallback timer that calls load() if nothing loaded yet, waits `while (pendingDefaultRead) await pendingDefaultRead`, clears the timer, then applies state.defaultRange unless rangePicked (moved → load(), which queues via state.again when busy).
- Tests: "a Default range changed while the first read is out opens on the newer value", "a slow Default range read does not hold the first report back" — both fail on a883bf7.
- Suspicions: the while loop when onDidChange fires repeatedly keeps firstLoad waiting (each read bounded by the 120 s deadline; the fallback has already loaded). globalThis.setTimeout?. used because the first panel test's vm context has no setTimeout.


## Delta 4
- readDefaultRange: get runs inside Promise.resolve().then (always async, sync throws become rejections and are swallowed); defaultRangeWaiters is [] while any read is out; only the newest read (read === defaultRangeReads) writes state.defaultRange and resolves/clears the waiters. firstLoad: if waiters is non-null, pushes a resolver and awaits it.
- Ranges click handler sets rangePicked for every button, Custom included.
- Tests: "a settings read that throws at once, a stuck first read, or an open Custom picker" (hangs on 8fd32f9, E-001 of the prior run).
- Fix checklist: waiters always resolved? Each read's chain ends in a .then that runs even when get rejects (the rejection handler returns undefined). If a newer read starts, older reads return early; the newest resolves all. Readers of rangePicked: firstLoad only.


## Delta 5
- readDefaultRange: defaultRangeApplied tracks the newest read that answered with a valid value; a valid answer applies when read >= defaultRangeApplied, so an older answer can't overwrite a newer valid one and a failed newer read doesn't discard an older valid one. Waiters are still resolved by the newest issued read.
- Settled (do not re-raise): a 7d report rendering briefly under a new radio before the queued reload replaces it is the existing load()/state.again design (panel.js:49-50).
- Test: "a valid Default range answer is kept when a newer read fails".
