# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/).

---

## [v0.1.0] — 2026-10-22

### Summary
Phase 1 coordination hub, hardened review repairs, and presentation showcase transformation.

### Detailed Changes

#### Tooling & Hygiene

- **General**: Merge pull request #1 from aiden-guan/fix/phase1-review (`8909c9e`)
- **General**: Document the round 1 repairs: README behavior (kept hooks, husky, nested worktrees, bounded event reads and replays, blocked ports, the untrusted-data note) and REVIEW.md fix status (`acb0a73`)
- Nested worktrees, pending claims across databases, guard placement, untrusted names, unclaimable names, blocked ports, restored databases (`9bdc0f8`)
- Bounded event reads and a feed replay that yields, a wait graph that stays quick with long queues, capped default intents, and hub-server refuses ports fetch blocks (`e8d0a8f`)
- **General**: Integrate the hub and adapter fixes: reconcile the shared contract, fix the regressions left open, document the changes (`eac93a8`)
- **General**: Merge adapter fixes (`892894d`)
- **General**: Merge hub fixes (`2f1a6fe`)
- **General**: H6: replay every missed event on a feed reconnect and page /events past events the caller can't see or didn't ask for, with next_since as the cursor and an epoch per database in hello and /events; a since from a recreated database starts at the latest seq; each hub process publishes events other processes on its database committed, before its own and on every sweep (fixes F34, F59, F60, F61, F67, F4, F40, F62, F68) (`13f9221`)
- **General**: H5: hub-server refuses a lease TTL outside 100 ms to a day, a heartbeat over a third of it or under 25 ms, and a port or number setting that isn't plain digits, naming the flag or variable before the database is opened; the Hub constructor checks the same; each claim heartbeats more often than its TTL (fixes F44, F45, F69, F46, F47, F48, F50) (`98c417f`)
- **General**: H4: the landing note advises landing a task only for the claims landing it releases, and names the rest apart; a renewal while one task is in progress ties the renewed claims that have no task to it; release refuses a files value that is not a list with 400 bad_request (fixes F1, F32, F41, F7 regressions) (`f701751`)

### Verification Proof
306 Vitest tests passing across both hub and adapter packages; validate_readme.py passed in strict mode.
