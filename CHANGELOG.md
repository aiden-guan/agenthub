# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — 2026-10-30

### Summary
`hub-server` now serves a built-in web dashboard at its root URL, so a team can see agents, file leases, tasks, decisions, and activity without a separate frontend.

### Architectural & Functional Highlights
| Component / Layer | Change | Impact |
| :--- | :--- | :--- |
| **Hub server** | Serves `packages/hub/ui/` from a fixed five-entry asset table with CSP, `nosniff`, and `no-referrer` | Browser UI with no filesystem path mapping and no new dependency |
| **Origin policy** | Accepts a request whose `Origin` is `http://<Host>` when Host is an IP address, a localhost name, or an `--allow-host` name | The dashboard can call the API. Other origins and pages on rebound names are refused on every bind address |
| **REST API** | Adds authenticated `GET /v1/projects` | The dashboard can list and switch between every project on a hub |
| **Tooling** | `npm run dashboard` and `npm run demo:dashboard` | One command to view a real hub or a disposable sample workspace |

### Detailed Changes

#### Added
- **Dashboard**: Overview, Agents, Tasks, File claims, Decisions, and Activity views, plus ⌘K search, a project switcher, and *Connect an agent* instructions for the current hub. Data refreshes every 5 s while the tab is visible.
- **Dashboard writes**: *New task* (with an optional dependency) and *Record decision*, through the same validated API the CLI uses.
- **Credentials**: Bearer token entered in connection settings and held in page memory only. Identity kept in `sessionStorage`.
- **Sample workspace**: `scripts/dashboard-demo.mjs` seeds an in-memory SQLite hub (3 agents, 8 tasks, 3 leases, 2 decisions) through the real `Hub` API.
- **Packaging**: `@agenthub/hub` publishes `ui/` alongside `bin` and `dist`. The Geist font ships with its SIL OFL 1.1 license.

#### Fixed
- **Dashboard**: `dashboard.js` attached listeners to `#mobile-settings` and `#header-search`, which `index.html` does not contain. The resulting `TypeError` stopped the module before its first refresh and left the page on "Opening your workspace". Those lookups are now optional.

- **Origin policy**: The first same-origin rule trusted any `Host`. On `--host 0.0.0.0` without `--token` or `--allow-host`, the hub does not check Host, so a page on a DNS-rebound name could read hub data (`/v1/projects` returned 200). Same-origin now requires a Host that can't be rebound. Tests cover both bind modes and both HTTP and the feed.

#### Documentation & Presentation
- **README**: New *Built-in Dashboard* section with 2x captures, a fourth engineering deep dive (serving a browser UI from a hub that refuses browsers), the dashboard in the architecture diagram, and a configuration table.
- **Accuracy**: Removed unmeasured throughput and latency figures, and corrected the test count to the actual 278.

### Verification Proof
- `npm test`: 7 files, 278 tests passed, including three new dashboard tests (public shell headers, authenticated `/v1/projects`, origin and rebind refusal) and rebound same-origin assertions for `0.0.0.0` binds, which fail without the fix.
- Dashboard loaded in a browser against `npm run demo:dashboard` with no console errors after the fix. Every view was captured over the DevTools protocol.
- `validate_readme.py README.md --strict` passed.

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
