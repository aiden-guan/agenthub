# Phase 2/3 build kit

How Phases 2 and 3 of `docs/design-phase2-3.md` are being built, so the build can continue on any machine.

## Status

- Phase 1 is finished on `fix/phase1-review` (PR #1 against `main`): 275 tests, typecheck and demo green.
- Phase 2/3 is on branch `phase23`. Stages 1 to 4 are done: Phases 2 and 3 are complete at checkpoint `cp3` (commit 0488876). npm test 1285 passed and 3 skipped, `AGENTHUB_E2E_PHASE=3 npm run test:e2e` 11 of 11, the 20,000-seed simulation green, and the demo runs all three parts. Checkpoint commits start with their name (`cp1a:`, `cp1:`, `cp2:`, `cp3:`); the tags themselves are local only (see below).
- Stage 5 (the review) was stopped on purpose partway through, with no code changed:
  - Find and dedup are done: 50 distinct findings (5 blocking, 20 major, 25 minor after the reproducers' corrections), in `review/findings.json`.
  - 48 of the 50 are reproduced (47 reproduced, 1 plausible); R-46 and R-50 are not. Results are in `review/repro-results.json`, and each finding's top-level scripts are in `review/repros/<id>/`. A few scripts hard-code the old scratch path; they all take `AGENTHUB_ROOT`.
  - No finding has been through the refutation step yet, and nothing is fixed.
  - `review/known.json` lists 19 minor issues that step verifiers recorded and left open; they go straight to the fixers.
- Since the pause (as of 2026-10-29): PR #1 was merged into `main` (8909c9e), and `main` gained two commits of the owner's own: fc788b8 (README rewrite, CHANGELOG.md, LICENSE, .env.example, .gitignore) and ae03f72 (README hero banner, assets/readme/hero.png). They are docs and assets only. `phase23` does not have them yet.
- Next:
  1. Resume stage 5 from `stage5-resume.json` (below).
  2. Merge `origin/main` into `phase23`. README.md will conflict: keep the owner's rewritten structure and wording, and fold in the Phase 2/3 sections (landing queue, host guide, Phase 3, release notes). Add a Phase 2/3 entry to CHANGELOG.md. Check that the new `.gitignore` rules (`.env*`, `.claude/`) don't hide anything the build or tests need.
  3. Run the gate (build, typecheck, npm test, `AGENTHUB_E2E_PHASE=3 npm run test:e2e`, demo), push, and open the PR from `phase23` into `main` (`fix/phase1-review` is merged, so it is no longer the target).

### Resuming stage 5

1. Create the four lane worktrees from `phase23`'s head (`git worktree add <SCRATCH>/lanes23/<lane> -b p23/<lane> phase23`, or reuse existing `p23/*` branches after `git merge --ff-only phase23`), then `npm ci && npm run build` in each and in the repo.
2. `git fetch origin fix/phase1-review` (the review's base is `origin/fix/phase1-review`).
3. Replace `${REPO}` and `${SCRATCH}` in `stage5-resume.json` and run the Workflow tool with `scriptPath: docs/build/stage5.js` and that file's contents as `args`. With `resume` set, `stage5.js` skips Find and Dedup, reuses the saved reproductions, reproduces the rest, then refutes, fixes, integrates (tag `cp3r`) and runs the regression review.
4. Check the result, run the gate yourself (`npm test`, `npm run typecheck`, `AGENTHUB_E2E_PHASE=3 npm run test:e2e`), then do steps 2 and 3 of "Next" above: merge `origin/main`, rerun the gate, push, and open the PR into `main`.

## How a stage runs

`stage.js` is a Workflow script. Four lanes (hub, lander, adapter, symbols) each own disjoint paths (design 6.1) and work in their own git worktree on branches `p23/<lane>`. Lanes run in parallel; inside a lane, steps run in order. Each step is implemented with its acceptance tests, checked by an independent verifier, and repaired up to twice. Then an integrator merges the lanes into `phase23` in the order hub, symbols, lander, adapter, applies contract amendments and dependency requests from `packages/*/LANE-NOTES.md`, runs the gate, tags the checkpoint, and fast-forwards every lane to it. A second verifier checks the checkpoint.

| Stage | Args file | Starts from | Lanes and steps | Checkpoint |
|---|---|---|---|---|
| 1 | `stage1.json` | `cp0` | hub H1–H3, lander L1, symbols S1–S4 | `cp1a` |
| 2 | `stage2.json` | `cp1a` | hub H4, lander L2–L3, adapter A1–A2 | `cp1` |
| 3 | `stage3.json` | `cp1` | hub H5, lander L4–L5, adapter A5 (Phase 2 scenarios) | `cp2` (Phase 2 complete, plus CP3a) |
| 4 | `stage4.json` | `cp2` | hub H6, lander L6, adapter A3, A4, A5 (Phase 3), A6 | `cp3` (Phase 3 complete) |
| 5 | `stage5.js` (its own script; args below) | `cp3` | adversarial review of `fix/phase1-review..phase23`: find, reproduce, refute, fix by lane, re-verify, integrate, regression review | `cp3r`; then merge `origin/main`, push `phase23` and open a PR against `main` |

## Running a stage

1. On `phase23` at the starting tag, create the lane worktrees once, outside the repo:
   `git worktree add <SCRATCH>/lanes23/<lane> -b p23/<lane> cp0` for hub, lander, adapter and symbols, then `npm install && npm run build` in each. Later stages reuse them, since the integrator fast-forwards every lane at each checkpoint.
2. Replace `${REPO}` (the repo checkout) and `${SCRATCH}` (a scratch directory outside the repo) in the stage's args file.
3. Run the Workflow tool with `scriptPath: docs/build/stage.js` and the args file's contents as `args`.
4. When it finishes, check the result, run `npm test` yourself, and check plan usage before the next stage.

Stage 5 runs `stage5.js` directly with args `{repo, scratch, base: "origin/fix/phase1-review", head: "phase23", from: "cp3", tag: "cp3r", lanes: {<lane>: {wt, branch}}, known: [<finding>]}`, reusing the four lane worktrees. `known` lists issues earlier verifiers recorded and left open; they go straight to the fixers, who confirm each first.

## Things learned the hard way

- An agent that dies on an API error returns null; `stage.js` retries each agent up to 3 times.
- Don't resume a stopped parallel workflow with `resumeFromRunId`: its cache matches by call order, so with parallel lanes it re-runs finished agents on top of later commits. Run `stage.js` again with `done` (finished steps: `{key: {summary, lane_notes, problems}}`, from the old run's journal) `resume` (`{key: note}` for a step cut off with uncommitted work in its worktree) and `implemented` (`{key: the implementer's last result}` for a step committed but not yet verified; it starts at verification) added to the args, and `checkpoint.resume` (a note for an integrator cut off mid-checkpoint) when every step is done.
- A brief "usage limit" API error can show up even with plenty of quota left; check the usage card before assuming the limit is real.
- On Linux, `npm install` rewrites `package-lock.json` (it drops the `libc` fields). Lanes install with `npm ci`; only the integrator commits lockfile changes, and only for a dependency request.
- The cloud session's git proxy accepts branch pushes but refuses tag pushes (HTTP 403). Checkpoint tags stay local; their commits are on `phase23` with the checkpoint name at the start of the message.
