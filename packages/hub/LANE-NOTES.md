# Lane H (hub) notes

No contract amendments and no dependency requests so far.

## H1: storage and migration

Decisions later steps build on:

- **`seq` on stored landings.** Every landing the store returns (`getLanding`, `listLandings`) carries its row's undeclared `seq` (insertion order), keyed in Phase 1's order before `commit`. Phase 1's status listing sent it, and `test/phase1-landings.test.ts` keeps that. The contract fixtures show no `seq`, so H4's shape checks should require the fixture's keys and types and allow extra keys (or strip `seq`). `land()` answers with the landing it built, which has no `seq`, as in Phase 1.
- **Not stored.** `position` and `eta_ms` read back as null (the Hub fills them). `approvals` are the `approve` rows of `landing_approvals`, oldest first; `insertLanding` and `updateLanding` ignore them.
- **Small additions to the design's signatures.** `listLandings`: `limit` is optional (all rows when omitted), with extra filters `branch` and `task_id: null` (no task). `ClaimFilter.landing_id` (a landing's holds, or `null` for non-holds). `putLanderControl(project, patch, now)` takes `now` for the NOT NULL `updated_at`. `insertApproval` assigns `n`. `upsertSymbolChange` assigns `S-<n>` ids (counter `symbol-change`) when it inserts.
- **Durable transactions.** `transaction(fn, {durable: true})` inside a non-durable transaction throws, because SQLite can't change `synchronous` inside a transaction. Inside a durable one, any nested transaction commits durably.
- **Left for H2/H3.** `Hub.write(..., {durable})`; `read()` falling back to a write when a landing deadline is due; `expireLandings`; `status()` taking `control` from `getLanderControl` and `queue`/`lander` from the store. `sweep()` already uses `projectsWithDueWork`, so until `expireLandings` exists a project with an overdue landing gets an empty write per sweep. `status().landings` still lists 5 (Phase 1); the protocol comment says at most 10.
