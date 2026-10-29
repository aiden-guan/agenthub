export const meta = {
  name: 'agenthub-phase23-review',
  description: 'Stage 5: adversarially review fix/phase1-review..phase23, reproduce and try to refute every finding, fix the confirmed ones by lane with re-verification, integrate and gate, then review the fixes for new breakage',
  phases: [
    { title: 'Find', detail: 'one reviewer per dimension over the whole Phase 2/3 diff, then a completeness critic' },
    { title: 'Dedup', detail: 'merge duplicate findings across reviewers' },
    { title: 'Verify', detail: 'reproduce each finding with a script, then try to refute it' },
    { title: 'Fix', detail: 'lanes fix their confirmed findings test-first; each batch is re-verified and repaired' },
    { title: 'Integrate', detail: 'merge the fix lanes, apply frozen-file fixes, full gate, REVIEW.md, tag' },
    { title: 'Regression review', detail: 'check the fixes hold on phase23 and broke nothing; repair' },
  ],
}

const REPO = args.repo
const DOC = `${REPO}/docs/design-phase2-3.md`
const WORK = `${args.scratch}/work-p23/review`
const LANES = args.lanes
const BASE = args.base
const HEAD_REF = args.head
const TAG = args.tag
const BATCH = 5

async function ask(prompt, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await agent(prompt, opts)
    if (r) return r
    log(`${opts.label}: no result on attempt ${attempt}${attempt < 3 ? ', retrying' : ', giving up'}`)
  }
  return null
}

const CONTEXT = `Project: agenthub, a TypeScript npm-workspace monorepo in ${REPO}. Phase 1 (hub server, \`hub\` CLI/MCP/hooks) is finished on branch fix/phase1-review. Phases 2 and 3 (landing queue, lander, function-level claims, impact warnings, AI resolver) were built on branch ${HEAD_REF} from the design document ${DOC}, and are now complete (checkpoint ${args.from}). This is the final adversarial review of everything Phases 2 and 3 changed: git diff ${BASE}..${HEAD_REF}.

The design is the spec. Sections 0.2 (invariants), 1 (data model, wire protocol), 2 (components), 3 (flows), 4 (failure handling and safety) and 5 (testing) define correct behavior; 6.1 is file ownership. REVIEW.md records the Phase 1 review, whose defect classes (crashes on hostile input, enforcement that fails open, path tricks, injection through agent text, token leaks, unfair queues, resources never released) must not reappear.

Rules for everyone:
- Every safety rule in sections 2 and 4 is a requirement: nothing reaches trunk unchecked, trunk moves only through the specified compare-and-swap push, worktrees with local changes are never rewritten, text from other agents stays untrusted data, protected paths need a human approval.
- Tests and reproductions must not need the network or an API key. The AI resolver is exercised only with the stub resolver. Never call the real Anthropic API.
- npm install on this machine rewrites package-lock.json (it drops the libc fields). Never commit that churn: install with npm ci, and run git checkout package-lock.json before committing.
- Don't push. Don't touch main or fix/phase1-review.`

const LANE_OF = 'hub = packages/hub (except protocol.ts and test/fixtures/contract); lander = packages/lander and packages/gitops (except resolver-protocol.ts and gitops/src/types.ts); adapter = packages/adapter and packages/e2e; symbols = packages/symbols (except src/types.ts); frozen = protocol.ts, packages/contract, gitops/src/types.ts, symbols/src/types.ts, lander/src/resolver-protocol.ts, contract fixtures, package.json/tsconfig files, README.md, scripts/**, root config'

const FINDING = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    lane: { type: 'string', enum: ['hub', 'lander', 'adapter', 'symbols', 'frozen'], description: 'who owns the code that must change' },
    files: { type: 'array', items: { type: 'string' }, description: 'repo-relative paths, with line numbers where useful' },
    severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
    claim: { type: 'string', description: 'the defect, in one or two sentences' },
    scenario: { type: 'string', description: 'concrete inputs or interleaving, and the wrong outcome they produce' },
    design_ref: { type: 'string', description: 'the design section or invariant it violates' },
  },
  required: ['title', 'lane', 'files', 'severity', 'claim', 'scenario', 'design_ref'],
}
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: FINDING } }, required: ['findings'] }
const DEDUPED = {
  type: 'object',
  properties: { findings: { type: 'array', items: { ...FINDING, properties: { ...FINDING.properties, id: { type: 'string', description: 'R-1, R-2, ...' }, sources: { type: 'integer', description: 'how many reviewers reported it' } }, required: [...FINDING.required, 'id'] } } },
  required: ['findings'],
}
const REPRO = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['reproduced', 'not_reproduced', 'plausible'], description: 'plausible: a race or environment-dependent defect you could show by trace but not trigger reliably' },
    evidence: { type: 'string', description: 'what you ran and what it showed, or the trace' },
    repro_path: { type: 'string', description: 'absolute path of the reproduction script or test, if any' },
    command: { type: 'string', description: 'how to run it; it must honour AGENTHUB_ROOT' },
    corrected_severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
  },
  required: ['status', 'evidence'],
}
const REFUTE = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}
const FIX_RESULT = {
  type: 'object',
  properties: {
    commit: { type: 'string' },
    fixed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not_a_defect', 'needs_frozen_change', 'not_fixed'] }, test: { type: 'string', description: 'the regression test that now guards it' }, note: { type: 'string' } }, required: ['id', 'status'] } },
    tests_passed: { type: 'boolean' },
    lane_notes: { type: 'string', description: 'frozen-file changes the integrator must make, written to LANE-NOTES.md too' },
    summary: { type: 'string' },
  },
  required: ['commit', 'fixed', 'tests_passed', 'summary'],
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
    commit: { type: 'string' },
    tag: { type: 'string' },
    tests_passed: { type: 'boolean' },
    tests_total: { type: 'integer' },
    typecheck_passed: { type: 'boolean' },
    e2e_passed: { type: 'boolean' },
    demo_passed: { type: 'boolean' },
    frozen_fixes: { type: 'string' },
    lanes_synced: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['commit', 'tests_passed', 'typecheck_passed', 'e2e_passed', 'demo_passed', 'lanes_synced', 'notes'],
}

const DIMENSIONS = [
  { key: 'trunk', focus: 'Trunk safety (design 0.2, 4.1, 4.3, 1.5, 2.2.5 to 2.2.7): any path by which code reaches trunk without passing land.check on the exact tree pushed; the compare-and-swap trunk push; lander lease, epoch and fencing; in-doubt and crash recovery; replayed or forged landed reports; history rewrites and force-pushes; a stale lander acting after losing its lease.' },
  { key: 'hub', focus: 'Hub state and concurrency (1.3, 1.4, 1.6, 2.1): every landing state transition and its guards; durable transactions; the migration of Phase 1 databases; holds, the claim gate and deadlock detection; queue order, fairness, keep-place retries and supersede; sweeps and expiry; multi-process races on one SQLite file; resources (claims, holds, leases) that are never released.' },
  { key: 'security', focus: 'Security and untrusted input (4.4, 1.7, 1.9, 2.6): auth on every new HTTP route (lander token, approver identity, protected-glob approvals that must come from a human), oversized or malformed bodies, path traversal and symlink tricks in files, refs and globs, injection of agent-written text (intents, messages, commit messages, trailers, branch names, fix-it briefs, AI resolver prompts and outputs) into other agents\' context or into git commands, secrets and tokens reaching logs, events, briefs or the AI prompt, redaction.' },
  { key: 'workspace', focus: 'Git isolation and workspace sync (2.2.2, 2.3.5, 3.10, 4.5): the isolated git environment (hooks, config, env vars, alternate object dirs); workspace sync that must never rewrite a worktree with local changes, untracked files or an in-progress operation; preflight; the gitops plumbing (mergeTrees, commitTree, pushRef, stash) against odd repositories (detached HEAD, shallow, submodules, LFS pointers, CRLF, renames, binary files, huge files).' },
  { key: 'lander', focus: 'Lander pipeline (2.2.3 to 2.2.10, 3.1 to 3.9): admission, the merge ladder (rebase, structural merge, AI resolver with the stub), the checks runner (timeouts, process-group kill, environment, output limits, what counts as passing), send-back and fix-it briefs, protected-path approval and the parked candidate, trunk moving mid-landing, hub-lander doctor, and the resolver validation in resolver-protocol.ts.' },
  { key: 'symbols', focus: 'Symbols and symbol-scope claims (1.10, 2.4, 2.5, 4.2, 3.12): every way a symbol-mapping error lets an edit bypass someone else\'s claim (renames, moves, overloads, nested and anonymous functions, decorators, macros, generated code, parse errors, unsupported languages, top-level code, files that change language); changedSymbols and applyEdit correctness; impact warnings and the reference cache (staleness, invalidation); who_uses; performance cliffs on large or adversarial files.' },
  { key: 'adapter', focus: 'Adapter and wire contract (2.3, 6.3, 1.8): every MCP tool and CLI command added or changed; hub_wait and landing_status texts; feed notices and the digest; hooks, the guard and init; behavior when the hub or lander is down or restarted; conformance of every request, response and event to protocol.ts and the contract fixtures; regressions of Phase 1 behavior that REVIEW.md fixed.' },
  { key: 'tests', focus: 'Test quality (5.1 to 5.5): acceptance tests from 6.5 that would still pass on a broken implementation, tests that assert too little, weakened or deleted Phase 1 tests, skipped tests, tests that depend on timing or ports and will flake, tests that reach the network or a real API, simulation and crash tests whose oracles miss the invariants of 0.2, gaps where a safety rule of section 4 has no test at all.' },
]

// Issues earlier verifiers already recorded and left open: they skip Find and Verify and go straight to the fixers, who confirm each first.
const KNOWN = (args.known || []).map((f, i) => ({ ...f, id: `K-${i + 1}` }))
const knownNote = KNOWN.length ? `\n\nAlready known and queued for fixing (don't report these again): ${JSON.stringify(KNOWN.map(f => `${f.id} ${f.title}`))}` : ''

// Resuming after an interruption: args.resume = {dir, findings: [{id, lane, severity, title}], reproduced: {id: status}}.
// The full findings, the saved reproduction results and their scripts are committed under dir in the repo.
const RES = args.resume || null
const savedNote = (f) => !RES ? '' : `\nThe full text of finding ${f.id} is in ${REPO}/${RES.dir}/findings.json. ${RES.reproduced[f.id] ? `Its saved reproduction result is in ${REPO}/${RES.dir}/repro-results.json and its scripts in ${REPO}/${RES.dir}/repros/${f.id}/ (rerun them with AGENTHUB_ROOT set; replace any absolute scratch paths they contain).` : 'It has not been reproduced yet.'} Read them first.`

let raw = []
let findings = []
if (RES) {
  findings = RES.findings
  raw = findings
  log(`resuming with ${findings.length} saved findings, ${Object.keys(RES.reproduced).length} already reproduced`)
} else {
  phase('Find')
  const findPrompt = (d) => `${CONTEXT}${knownNote}

  You are one of ${DIMENSIONS.length} independent reviewers. Your dimension: ${d.focus}

  Read the design sections named above, then the code: git -C "${REPO}" diff ${BASE}..${HEAD_REF} -- <paths> and the files themselves (the tree is checked out at ${HEAD_REF}; read it, don't edit it). You may run npm test, npx vitest and small scripts (put them under ${WORK}/find-${d.key}/) to confirm a suspicion; the packages are built in ${REPO}/packages/*/dist.

  Report real defects only: behavior that is wrong against the design, unsafe, or will fail in use. For each give the concrete scenario that triggers it (inputs or an interleaving) and the wrong outcome, the files, the design section it violates, and the lane that owns the fix (${LANE_OF}). Severity: blocking = a safety invariant breaks or the hub/lander crashes or corrupts state; major = wrong behavior a user will hit; minor = an edge case with a cheap fix. Leave out style, naming and speculation you cannot tie to a scenario. Be thorough: a missed defect ships.`
  const found = (await parallel(DIMENSIONS.map(d => () => ask(findPrompt(d), { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS })))).filter(Boolean)
  raw = found.flatMap(r => r.findings)
  log(`${raw.length} raw findings from ${found.length}/${DIMENSIONS.length} reviewers`)

  const critic = await ask(`${CONTEXT}${knownNote}

  ${DIMENSIONS.length} reviewers each reviewed one dimension of git diff ${BASE}..${HEAD_REF}. Their findings so far:
  ${JSON.stringify(raw.map(f => ({ title: f.title, files: f.files, claim: f.claim })), null, 1)}

  You are the completeness critic. Find what they missed: code in the diff no finding touches, safety rules of design section 4 and invariants of 0.2 that no finding examined, flows of section 3 nobody traced end to end, interactions between packages (hub with lander, lander with gitops, adapter with hub and symbols). Trace those yourself in the code and report only new, concrete defects in the same format (scenario, wrong outcome, files, design section, owning lane: ${LANE_OF}). Scripts go under ${WORK}/find-critic/.`, { label: 'find:critic', phase: 'Find', schema: FINDINGS })
  if (critic) raw = raw.concat(critic.findings)
  log(`${raw.length} raw findings including the critic's`)

  phase('Dedup')
  if (raw.length) {
    const dd = await ask(`Merge duplicate code-review findings. Two findings are duplicates when fixing one fixes the other. Keep every distinct finding; never drop one because it seems unlikely. For a merged group keep the clearest title and scenario, the union of files, the highest severity, and set sources to the group size. Number the results R-1, R-2, ... in order of severity (blocking first).

  Findings:
  ${JSON.stringify(raw, null, 1)}`, { label: 'dedup', phase: 'Dedup', schema: DEDUPED })
    findings = dd ? dd.findings : raw.map((f, i) => ({ ...f, id: `R-${i + 1}`, sources: 1 }))
  }
}
log(`${findings.length} distinct findings: ${['blocking', 'major', 'minor'].map(s => `${findings.filter(f => f.severity === s).length} ${s}`).join(', ')}`)

phase('Verify')
const verified = await pipeline(
  findings,
  (f) => RES && RES.reproduced[f.id] ? Promise.resolve({ status: RES.reproduced[f.id], evidence: `saved in ${RES.dir}/repro-results.json`, repro_path: `${REPO}/${RES.dir}/repros/${f.id}/` }) : ask(`${CONTEXT}

Reproduce this review finding against ${HEAD_REF} in ${REPO} (read-only: don't edit tracked files there).
${JSON.stringify(f, null, 2)}${savedNote(f)}

Write a reproduction under ${WORK}/repro-${f.id}/: a node script (.mjs) or vitest file that imports the built packages from \${AGENTHUB_ROOT}/packages/*/dist (default AGENTHUB_ROOT=${REPO}), builds whatever state it needs (temp dirs, a local bare remote, an in-process hub on port 0, the stub resolver), triggers the scenario, and exits non-zero (or fails) exactly when the defect is present. Run it. It must not need the network or an API key.
- reproduced: the script shows the defect. Give the command (it must honour AGENTHUB_ROOT so it can be rerun against a fixed checkout).
- plausible: a race or environment-dependent defect you can show by a precise trace through the code but cannot trigger reliably.
- not_reproduced: the code does not behave as claimed; say what it actually does.
Correct the severity if the finding over- or under-states it.`, { label: `repro:${f.id}`, phase: 'Verify', schema: REPRO }),
  async (rep, f) => {
    if (!rep || rep.status === 'not_reproduced') return { f, rep, ref: null, confirmed: false }
    const sev = rep.corrected_severity || f.severity
    if (sev === 'minor' && rep.status === 'reproduced') return { f: { ...f, severity: sev }, rep, ref: null, confirmed: true }
    const ref = await ask(`${CONTEXT}

Try to refute this review finding. A reproducer reported:
Finding: ${JSON.stringify(f, null, 2)}
Reproduction: ${JSON.stringify(rep, null, 2)}${savedNote(f)}

Read the code, the reproduction (${rep.repro_path || 'none'}) and the design. Refute it only with a concrete reason: a design section that allows or requires this behavior, a trace showing no real caller or input reaches it, or a flaw in the reproduction that makes it show something other than the claimed defect (rerun it to check). If the reproduction is sound and the behavior violates the design, refuted=false.${rep.status === 'plausible' ? ' This one was not triggered, only traced: check the trace step by step, and refute it if any step is wrong.' : ''}`, { label: `refute:${f.id}`, phase: 'Verify', schema: REFUTE })
    return { f: { ...f, severity: sev }, rep, ref, confirmed: !!ref && !ref.refuted }
  },
)
const judged = verified.filter(Boolean).concat(KNOWN.map(f => ({ f, rep: { status: 'reported', evidence: f.scenario }, ref: null, confirmed: true, known: true })))
const confirmed = judged.filter(v => v.confirmed)
const dropped = judged.filter(v => !v.confirmed)
log(`${confirmed.length} confirmed, ${dropped.length} dropped (not reproduced or refuted)`)

phase('Fix')
const byLane = {}
for (const v of confirmed) (byLane[v.f.lane] = byLane[v.f.lane] || []).push(v)
const frozen = byLane.frozen || []
delete byLane.frozen

function laneRules(lane) {
  const L = LANES[lane]
  return `Your lane: ${lane}. Worktree: ${L.wt} (branch ${L.branch}), at ${HEAD_REF}'s head plus your lane's fix commits. Work only there, and only in the paths your lane owns (design 6.1: ${LANE_OF}). A fix that needs a frozen file: write the exact change as a request in your package's LANE-NOTES.md, mark that finding needs_frozen_change, and fix the rest. Scratch goes under ${WORK}/fix-${lane}/.
- For each finding: turn its reproduction into a regression test in your package's test directory, see it fail, fix the code, see it pass. Fix the root cause, not the symptom; keep the change minimal and in the style of the surrounding code.
- If a finding turns out not to be a defect, mark it not_a_defect and show why with a test or a precise trace.
- Before committing: npm run build, npx vitest run on your packages, the full npm test, and npm run typecheck pass in your worktree.
- Commit: git -C "${L.wt}" add -A && git -C "${L.wt}" commit -m "Review fix <ids>: <what changed>".`
}

async function fixBatch(lane, batch, n) {
  const L = LANES[lane]
  const ids = batch.map(v => v.f.id).join(', ')
  const items = batch.map(v => ({ ...v.f, reproduction: v.rep, refuter: v.ref ? v.ref.reason : null }))
  let res = await ask(`${CONTEXT}

${laneRules(lane)}

Fix batch ${n} of lane ${lane}: findings ${ids}. Findings with an R- id were reproduced and survived an attempt to refute it. Findings with a K- id were recorded by an earlier step verifier and not reproduced here: confirm each one first (write the failing regression test), and mark it not_a_defect with your evidence if it doesn't hold. To rerun a reproduction against your worktree, set AGENTHUB_ROOT=${L.wt} after npm run build there.${RES ? ` Full finding texts are in ${REPO}/${RES.dir}/findings.json, saved reproduction results in repro-results.json there, and scripts under repros/<id>/.` : ''}
${JSON.stringify(items, null, 2)}`, { label: `fix:${lane}:${n}`, phase: 'Fix', schema: FIX_RESULT })
  if (!res) return { lane, ids, res: null, ver: null }
  let ver = null
  for (let round = 0; ; round++) {
    ver = await ask(`${CONTEXT}

Verify fix batch ${n} of lane ${lane} (findings ${ids}) in ${L.wt} (branch ${L.branch}). You may build and run tests there but don't edit tracked files. Scratch: ${WORK}/verify-${lane}-${n}-r${round}/.
Findings: ${JSON.stringify(items, null, 2)}
The fixer reported: ${JSON.stringify(res, null, 2)}

- After npm run build in the worktree, rerun each reproduction with AGENTHUB_ROOT=${L.wt}: it must no longer show the defect. For each finding marked not_a_defect or needs_frozen_change, check the fixer's argument.
- Each fixed finding has a regression test that fails without the fix (revert the fix in a scratch copy, or reason precisely) and passes with it.
- Try to break each fix: the same defect through a neighbouring input or path, and new defects the fix introduced.
- No edits outside the lane's paths (git -C "${L.wt}" diff --stat ${HEAD_REF}..HEAD), no weakened or deleted tests, the full npm test and npm run typecheck pass.
ok=true only if no blocking or major problem remains.`, { label: `verify:${lane}:${n}:r${round}`, phase: 'Fix', schema: VERIFY_RESULT })
    if ((ver && ver.ok && ver.tests_passed) || round >= 2) break
    res = (await ask(`${CONTEXT}

${laneRules(lane)}

Repair round ${round + 1} for fix batch ${n} of lane ${lane} (findings ${ids}).
Findings: ${JSON.stringify(items, null, 2)}
Your previous report: ${JSON.stringify(res, null, 2)}
An independent verifier found: ${JSON.stringify(ver, null, 2)}

Fix every blocking and major problem. If the verifier is wrong about an item, show why with a test or a precise trace. Commit when everything passes.`, { label: `repair:${lane}:${n}:r${round + 1}`, phase: 'Fix', schema: FIX_RESULT })) || res
  }
  const ok = !!(ver && ver.ok && ver.tests_passed)
  log(`fix ${lane}:${n} (${ids}): ${ok ? 'verified' : 'problems remain'}`)
  return { lane, ids, res, ver, ok }
}

async function runLane(lane) {
  const out = []
  const vs = byLane[lane]
  for (let i = 0; i < vs.length; i += BATCH) out.push(await fixBatch(lane, vs.slice(i, i + BATCH), i / BATCH + 1))
  return out
}
const fixes = (await parallel(Object.keys(byLane).filter(l => LANES[l]).map(l => () => runLane(l)))).filter(Boolean).flat().filter(Boolean)

phase('Integrate')
const fixSummary = fixes.map(x => ({ lane: x.lane, ids: x.ids, verified: !!x.ok, fixed: x.res ? x.res.fixed : [], lane_notes: x.res ? x.res.lane_notes || '' : '', open: x.ver ? x.ver.problems.filter(p => p.severity !== 'minor').map(p => p.what) : ['no verification'] }))
const ledger = judged.map(v => ({ id: v.f.id, title: v.f.title, severity: v.f.severity, lane: v.f.lane, files: v.f.files, verdict: v.known ? 'known (recorded by a step verifier)' : v.confirmed ? 'confirmed' : (v.rep && v.rep.status === 'not_reproduced' ? 'not reproduced' : 'refuted'), why: v.confirmed ? '' : (v.ref ? v.ref.reason : v.rep ? v.rep.evidence : 'no result') }))
const intPrompt = `${CONTEXT}

You are the integrator for the stage 5 review fixes, in ${REPO} on branch ${HEAD_REF}. Design 6.7 describes the integrator's duties. Lane worktrees and branches:
${Object.keys(LANES).map(l => `- ${l}: ${LANES[l].wt} (branch ${LANES[l].branch})`).join('\n')}

Fix batches:
${JSON.stringify(fixSummary, null, 2)}

Confirmed findings that need frozen files (yours to fix):
${JSON.stringify(frozen.map(v => ({ ...v.f, reproduction: v.rep })), null, 2)}

${RES ? `Full finding texts are in ${REPO}/${RES.dir}/findings.json (the ledger below has only ids and titles for them); saved reproductions are in ${RES.dir}/repro-results.json and ${RES.dir}/repros/<id>/.\n\n` : ''}The full review ledger (every finding and its verdict):
${JSON.stringify(ledger, null, 1)}

Do this, in order:
1. Confirm ${REPO} is on ${HEAD_REF} with a clean tree.
2. Merge the lane branches in the order p23/hub, p23/symbols, p23/lander, p23/adapter (git -C "${REPO}" merge --no-ff <branch> -m "review: merge <lane> fixes"; a branch with no new commits is a no-op).
3. Fix the frozen-file findings above and apply the needs_frozen_change requests in packages/*/LANE-NOTES.md, additively where the contract is concerned, each with a regression test; mark each applied request in its LANE-NOTES.md. Rerun each frozen finding's reproduction with AGENTHUB_ROOT=${REPO} after building.
4. npm ci --no-audit --no-fund, npm run build, npm test, npm run typecheck, npm run test:e2e, and scripts/demo.sh (as the README describes running it). Fix what breaks with minimal changes in any package, noting each.
5. Add a "Phases 2 and 3 review" section to REVIEW.md, in the style of the Phase 1 sections: how the review ran, then every finding in the ledger with its id, severity, verdict, and for confirmed ones the fix and its regression test (or why it stays open).
6. Commit, and tag the commit ${TAG} (git tag -f ${TAG}).
7. Sync every lane worktree: git -C <wt> merge --ff-only ${HEAD_REF}, then npm ci --no-audit --no-fund there, and confirm npm run build passes.
Don't push.`
let cp = await ask(intPrompt, { label: 'integrate', phase: 'Integrate', schema: CP_RESULT })

phase('Regression review')
let rv = null
for (let round = 0; round < 3; round++) {
  const checks = await parallel([
    () => ask(`${CONTEXT}

The review fixes were integrated on ${HEAD_REF} in ${REPO} and tagged ${TAG}. The integrator reported: ${JSON.stringify(cp, null, 2)}

Check that every confirmed finding is really fixed on ${HEAD_REF}: after npm run build in ${REPO}, rerun each reproduction listed below with AGENTHUB_ROOT=${REPO} (don't edit tracked files; scratch under ${WORK}/regress-repro-r${round}/). Each must no longer show the defect, or REVIEW.md must say why it stays open.${RES ? ` Saved reproductions for the R- findings are under ${REPO}/${RES.dir}/repros/<id>/ (results in ${RES.dir}/repro-results.json).` : ''} Also run npm test, npm run typecheck and npm run test:e2e, and check that REVIEW.md's ledger matches the verdicts below.
Confirmed findings: ${JSON.stringify(confirmed.map(v => ({ id: v.f.id, title: v.f.title, repro: v.rep.repro_path, command: v.rep.command })), null, 1)}
ok=true only if no blocking or major problem remains.`, { label: `regress:repro:r${round}`, phase: 'Regression review', schema: VERIFY_RESULT }),
    () => ask(`${CONTEXT}

Review the fix commits themselves for new breakage: git -C "${REPO}" diff ${args.from}..${HEAD_REF}. They were written to close review findings; look for what they broke: behavior the design requires that a fix removed, a fix that closes one path but leaves a sibling path open, new races, new crashes on hostile input, error codes or texts that no longer match protocol.ts and the contract fixtures, weakened tests, frozen-file changes that are not additive. You may run tests and scripts (scratch under ${WORK}/regress-diff-r${round}/) but don't edit tracked files. ok=true only if no blocking or major problem remains.`, { label: `regress:diff:r${round}`, phase: 'Regression review', schema: VERIFY_RESULT }),
  ])
  const got = checks.filter(Boolean)
  rv = { ok: got.length === 2 && got.every(c => c.ok && c.tests_passed), problems: got.flatMap(c => c.problems), tests_passed: got.length === 2 && got.every(c => c.tests_passed) }
  if (rv.ok || round === 2) break
  cp = (await ask(`${intPrompt}

This is repair round ${round + 1}. The merges, frozen fixes and REVIEW.md section are already done. Independent reviewers found these problems:
${JSON.stringify(rv, null, 2)}

Fix them in ${REPO} on ${HEAD_REF} (small fixes in any package, each with a regression test), rerun the full gate (build, test, typecheck, test:e2e, demo), update REVIEW.md, commit, retag ${TAG}, and resync every lane worktree.`, { label: `repair:integrate:r${round + 1}`, phase: 'Regression review', schema: CP_RESULT })) || cp
}

return { counts: { raw: raw.length, distinct: findings.length, confirmed: confirmed.length, dropped: dropped.length }, ledger, fixes: fixSummary, frozen: frozen.map(v => v.f.id), integrate: cp, regression: rv }
