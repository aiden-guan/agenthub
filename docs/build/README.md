# Phase 2/3 build kit

How Phases 2 and 3 of `docs/design-phase2-3.md` are being built, so the build can continue on any machine.

## Status

- Phase 1 is finished on `fix/phase1-review` (PR #1 against `main`): 275 tests, typecheck and demo green.
- Phase 2/3 is on branch `phase23`. Step 0 (design section 6.4) is done and tagged `cp0`: frozen contract, `@agenthub/contract`, skeletons for gitops, symbols, lander and e2e, pinned dependencies, 306 tests green.
- Next: stage 1 (checkpoint `cp1a`). Nothing from stage 1 has been committed yet.

## How a stage runs

`stage.js` is a Workflow script. Four lanes (hub, lander, adapter, symbols) each own disjoint paths (design 6.1) and work in their own git worktree on branches `p23/<lane>`. Lanes run in parallel; inside a lane, steps run in order. Each step is implemented with its acceptance tests, checked by an independent verifier, and repaired up to twice. Then an integrator merges the lanes into `phase23` in the order hub, symbols, lander, adapter, applies contract amendments and dependency requests from `packages/*/LANE-NOTES.md`, runs the gate, tags the checkpoint, and fast-forwards every lane to it. A second verifier checks the checkpoint.

| Stage | Args file | Starts from | Lanes and steps | Checkpoint |
|---|---|---|---|---|
| 1 | `stage1.json` | `cp0` | hub H1–H3, lander L1, symbols S1–S4 | `cp1a` |
| 2 | `stage2.json` | `cp1a` | hub H4, lander L2–L3, adapter A1–A2 | `cp1` |
| 3 | `stage3.json` | `cp1` | hub H5, lander L4–L5, adapter A5 (Phase 2 scenarios) | `cp2` (Phase 2 complete, plus CP3a) |
| 4 | `stage4.json` | `cp2` | hub H6, lander L6, adapter A3, A4, A5 (Phase 3), A6 | `cp3` (Phase 3 complete) |
| 5 | `stage5.js` (its own script; args below) | `cp3` | adversarial review of `fix/phase1-review..phase23`: find, reproduce, refute, fix by lane, re-verify, integrate, regression review | `cp3r`; then push `phase23` and open a PR against `fix/phase1-review` |

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
