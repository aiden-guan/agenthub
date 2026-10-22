export const meta = {
  name: 'agenthub-phase23-stage',
  description: 'Build one Phase 2/3 stage: lanes run their steps in parallel (implement, verify, repair), then the integrator merges and gates a checkpoint',
  phases: [
    { title: 'Lanes', detail: 'each lane implements its steps; every step is verified and repaired' },
    { title: 'Checkpoint', detail: 'merge lanes into phase23, gate, tag, and sync the lanes' },
    { title: 'Checkpoint verify', detail: 'independent check of the checkpoint gate, then repair' },
  ],
}

const REPO = args.repo
const DOC = `${REPO}/docs/design-phase2-3.md`
const PLAN = args.planPath
const WORK = `${args.scratch}/work-p23`
const LANES = args.lanes
const CP = args.checkpoint
// A continuation after an interrupted run: steps already implemented and verified ({key: {summary, lane_notes, problems, rounds}}),
// and notes for steps that were cut off mid-way ({key: text}).
const DONE = args.done || {}
const RESUME = args.resume || {}
// Steps implemented (and committed) but not yet verified: {key: the implementer's last STEP_RESULT}. They start at verification.
const IMPLEMENTED = args.implemented || {}

async function ask(prompt, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await agent(prompt, opts)
    if (r) return r
    log(`${opts.label}: no result on attempt ${attempt}${attempt < 3 ? ', retrying' : ', giving up'}`)
  }
  return null
}

const CONTEXT = `Project: agenthub, a TypeScript npm-workspace monorepo. Phase 1 (hub server in packages/hub, the \`hub\` CLI/MCP/hooks in packages/adapter) is finished. Phases 2 and 3 (landing queue, lander, function-level claims, impact warnings, AI resolver) are being built in parallel lanes from the design document docs/design-phase2-3.md (in every worktree; the main repo copy is ${DOC}).

The design is the spec. Section 6 is the build plan: 6.1 packages and file ownership, 6.2 dependencies, 6.3 the frozen wire contract, 6.5 the steps per lane (each with acceptance tests), 6.6 checkpoints, 6.7 the integrator's duties. Section 5 is the testing strategy. Sections 1 to 4 define the data model, components, flows and safety rules your step implements. A structured copy of the build plan, with per-step briefs, is at ${PLAN}. Where the two differ, the design document wins.

Rules for everyone:
- Frozen files (6.1: protocol.ts, packages/contract/**, gitops/src/types.ts, symbols/src/types.ts, lander/src/resolver-protocol.ts, the contract fixtures, every package.json/tsconfig.json, the lockfile, README.md, REVIEW.md, scripts/**, root config) are changed only by the integrator. A lane that needs a change writes a contract-amendment or dependency request in its own LANE-NOTES.md, works around it if it can, and says so in its result.
- Every safety rule in sections 2 and 4 is a requirement, not a suggestion: nothing reaches trunk unchecked, trunk moves only through the specified compare-and-swap push, worktrees with local changes are never rewritten, text from other agents stays untrusted data.
- Tests must not need the network or an API key. The AI resolver is tested with the stub resolver. Never call the real Anthropic API.
- Don't push. Don't touch main or fix/phase1-review.
- npm install on this machine rewrites package-lock.json (it drops the libc fields). Never commit that churn: install with npm ci, and run git checkout package-lock.json before committing. Only the integrator commits lockfile changes, and only for an applied dependency request.`

const STEP_RESULT = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    commit: { type: 'string', description: 'sha of your last commit' },
    tests_passed: { type: 'boolean' },
    tests_total: { type: 'integer' },
    acceptance: { type: 'array', items: { type: 'object', properties: { test: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'not_written'] } }, required: ['test', 'status'] }, description: 'each acceptance test named in the step brief' },
    summary: { type: 'string' },
    lane_notes: { type: 'string', description: 'amendment or dependency requests written to LANE-NOTES.md, and anything the integrator must know' },
  },
  required: ['done', 'commit', 'tests_passed', 'acceptance', 'summary'],
}

const VERIFY_RESULT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, evidence: { type: 'string' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] } }, required: ['what', 'evidence', 'severity'] } },
    tests_passed: { type: 'boolean' },
  },
  required: ['ok', 'problems', 'tests_passed'],
}

const CP_RESULT = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    commit: { type: 'string' },
    tag: { type: 'string' },
    tests_passed: { type: 'boolean' },
    tests_total: { type: 'integer' },
    typecheck_passed: { type: 'boolean' },
    e2e_passed: { type: 'boolean', description: 'true if e2e ran and passed, or e2e is not required at this checkpoint' },
    gate: { type: 'string', description: 'the checkpoint gate from 6.6 and the evidence that it holds' },
    amendments: { type: 'string', description: 'contract amendments and dependency requests applied' },
    lanes_synced: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['merged', 'commit', 'tests_passed', 'typecheck_passed', 'e2e_passed', 'gate', 'lanes_synced', 'notes'],
}

function laneRules(lane) {
  const L = LANES[lane]
  return `Your lane: ${lane}. Worktree: ${L.wt} (branch ${L.branch}). Work only there; it is your lane's own checkout of phase23 at the last checkpoint plus your lane's commits. Your lane owns exactly the paths listed for it in design section 6.1; edit nothing else. Other lanes work in other worktrees at the same time; tests use random ports and temp dirs, so that's fine. Put scratch files under ${WORK}/${lane}/.
- Read your step's brief in section 6.5 (and in ${PLAN}), plus every section it references, before writing code.
- Write the step's acceptance tests first, see them fail, implement, see them pass. Match the style of the surrounding code.
- Before committing: npm run build, the lane's tests (npx vitest run packages/<your package>), the full npm test, and npm run typecheck must all pass in your worktree.
- Commit on your lane branch: git -C "${L.wt}" add -A && git -C "${L.wt}" commit -m "<step key>: <what changed>".`
}

async function runStep(lane, key) {
  const L = LANES[lane]
  const ph = 'Lanes'
  const head = `Step ${key} in lane ${lane}.`
  let res = IMPLEMENTED[key] || await ask(`${CONTEXT}

${laneRules(lane)}

${head} Implement it completely, including every acceptance test its brief lists. Earlier steps of your lane are already committed on your branch; build on them.${RESUME[key] ? `\n\n${RESUME[key]}` : ''}`, { label: `impl:${key}`, phase: ph, schema: STEP_RESULT })
  if (!res) { log(`${key}: implementer failed`); return { key, lane, res: null, ver: null, rounds: 0 } }
  let ver = null
  let rounds = 0
  for (;;) {
    ver = await ask(`${CONTEXT}

${head} Worktree under test: ${L.wt} (branch ${L.branch}). Verification round ${rounds}.

An implementer reported:
${JSON.stringify(res, null, 2)}

Verify the step independently and skeptically against design section 6.5 (the step's brief and acceptance tests) and every design section it references. You may run npm run build, npm test, npm run typecheck and npx vitest in the worktree (nobody else is working in it now), but don't edit tracked files there. Put your scripts under ${WORK}/verify-${key}-r${rounds}/.
- Every acceptance test the brief lists exists, tests what it claims (it would fail on a broken implementation), and passes.
- The behavior matches the design, including the safety rules of sections 2 and 4 that apply to this step. Try to break it with inputs and races the tests don't cover.
- No edits outside the lane's ownership (git -C "${L.wt}" diff --stat ${args.base}..HEAD), no weakened or deleted earlier tests, no frozen-file edits.
- The full npm test and typecheck pass.
Report ok=true only if there is no blocking or major problem. Minor problems go in the list but don't fail the step.`, { label: `verify:${key}:r${rounds}`, phase: ph, schema: VERIFY_RESULT })
    const bad = !ver || !ver.ok || !ver.tests_passed
    if (!bad || rounds >= 2) break
    rounds++
    res = (await ask(`${CONTEXT}

${laneRules(lane)}

${head} Repair round ${rounds}. An independent verifier found problems:
${JSON.stringify(ver, null, 2)}

Fix every blocking and major problem, and the minor ones where cheap. If the verifier is wrong about an item, show why with a test or a precise trace in your summary. Commit when everything passes.`, { label: `repair:${key}:r${rounds}`, phase: ph, schema: STEP_RESULT })) || res
  }
  const ok = ver && ver.ok && ver.tests_passed
  log(`${key}: ${ok ? 'verified' : 'problems remain'} after ${rounds} repair round(s)`)
  return { key, lane, res, ver, rounds, ok }
}

async function runLane(lane) {
  const out = []
  for (const key of LANES[lane].steps) {
    const d = DONE[key]
    if (d) {
      log(`${key}: already verified in an earlier run, skipped`)
      out.push({ key, lane, res: { summary: d.summary, lane_notes: d.lane_notes || '' }, ver: { ok: true, tests_passed: true, problems: d.problems || [] }, rounds: d.rounds || 0, ok: true })
      continue
    }
    out.push(await runStep(lane, key))
  }
  return out
}

phase('Lanes')
const laneNames = Object.keys(LANES).filter(l => LANES[l].steps.length > 0)
const results = (await parallel(laneNames.map(l => () => runLane(l)))).filter(Boolean).flat().filter(Boolean)
const summary = results.map(r => ({
  step: r.key, lane: r.lane, verified: !!r.ok, rounds: r.rounds,
  open: r.ver ? r.ver.problems.filter(p => p.severity !== 'minor').map(p => p.what) : ['no verification'],
  summary: r.res ? r.res.summary : '', lane_notes: r.res ? r.res.lane_notes || '' : '',
}))

phase('Checkpoint')
const allLanes = Object.keys(LANES)
const cpPrompt = `${CONTEXT}

You are the integrator for checkpoint ${CP.name}, in the main repository ${REPO} on branch phase23. Design sections 6.6 and 6.7 describe your duties. Lane worktrees and branches:
${allLanes.map(l => `- ${l}: ${LANES[l].wt} (branch ${LANES[l].branch})`).join('\n')}

Steps finished in this stage:
${JSON.stringify(summary, null, 2)}

Do this, in order:
1. Confirm ${REPO} is on phase23 with a clean tree.
2. Merge the lane branches in the order ${CP.mergeOrder.join(', ')} (git -C "${REPO}" merge --no-ff <branch> -m "${CP.name}: merge <lane>"). Ownership is disjoint, so conflicts mean a lane broke ownership: resolve carefully and note it.
3. Apply the contract amendments and dependency requests in every packages/*/LANE-NOTES.md that are justified, additively, as the design's integrator rules say. Mark each applied request in the LANE-NOTES.md file.
4. npm ci --no-audit --no-fund (npm install only if you applied a dependency request), npm run build, npm test, npm run typecheck${CP.e2e ? ', and npm run test:e2e' : ''}. Fix what breaks. As the integrator you may make small fixes in any package; keep them minimal and note each one.
5. Checkpoint gate (design 6.6): ${CP.gate}
${CP.extra ? `6. Also: ${CP.extra}\n` : ''}7. Commit, and tag the commit ${CP.name} (git tag -f ${CP.name}).
8. Sync every lane: for each lane worktree, git -C <wt> merge --ff-only phase23 (or a plain merge if a lane has commits the checkpoint didn't take, which shouldn't happen), then npm ci --no-audit --no-fund in that worktree, and confirm npm run build passes there.
Don't push.${CP.resume ? `\n\nResuming an interrupted integration: ${CP.resume}` : ''}`
let cp = await ask(cpPrompt, { label: `integrate:${CP.name}`, phase: 'Checkpoint', schema: CP_RESULT })

phase('Checkpoint verify')
let cpv = null
for (let round = 0; round < 3; round++) {
  cpv = await ask(`${CONTEXT}

Checkpoint ${CP.name} was just integrated on branch phase23 in ${REPO}. The integrator reported:
${JSON.stringify(cp, null, 2)}

Verify independently. You may run npm run build, npm test, npm run typecheck${CP.e2e ? ' and npm run test:e2e' : ''} in ${REPO} (nobody else is working there now), but don't edit tracked files. Scratch: ${WORK}/verify-${CP.name}-r${round}/.
- The gate holds: ${CP.gate}
- Every step merged in this stage behaves as design 6.5 says when combined with the other lanes (try the cross-lane paths: real hub with real lander/adapter where this checkpoint makes that possible).
- Frozen files changed only through recorded amendments. Tag ${CP.name} points at HEAD. Each lane worktree's HEAD equals phase23 and builds.
Report ok=true only if there is no blocking or major problem.`, { label: `verify:${CP.name}:r${round}`, phase: 'Checkpoint verify', schema: VERIFY_RESULT })
  if (cpv && cpv.ok && cpv.tests_passed) break
  if (round === 2) break
  cp = (await ask(`${cpPrompt}

This is repair round ${round + 1} for the checkpoint. The merges are already done. An independent verifier found these problems:
${JSON.stringify(cpv, null, 2)}

Fix them in ${REPO} on phase23 (small fixes in any package are fine for the integrator; note each), rerun the gates, commit, retag ${CP.name}, and resync every lane worktree.`, { label: `repair:${CP.name}:r${round + 1}`, phase: 'Checkpoint verify', schema: CP_RESULT })) || cp
}

return { steps: summary, checkpoint: cp, checkpoint_verify: cpv }
