// One attempt (design §2.2.5, P1 to P11), written only against the ports
// (§2.2.1), so the simulation (§5.2) runs this same code against a fake git
// and checks. What it guarantees:
//
// - I1: trunk moves only by pushTrunk (a CAS from T0 to C, C^1 == T0 asserted
//   here and in gitops), only to the exact candidate whose tree passed trunk's
//   checks (or, on the approved fast path, the exact parked candidate that
//   passed them on the same T0), and only after the hub accepted `pushing`
//   for that candidate under this lease and attempt (the write-ahead).
// - I3: no push without that acknowledgement; a refused, stale or unknown
//   outcome is resolved from the remote (trailers, ancestry), never guessed.
// - I4: the check command, protected rules and merge attributes come from
//   trunk's agenthub.json at T0 and `--attr-source=T0`.
// - I8: agent text reaches the commit message only through the sanitizing
//   builders in report.ts.

import { candidateRef, FULL_SHA_RE, landRef, type LandConfig } from '@agenthub/contract';
import type { ConflictEntry } from '@agenthub/gitops';
import type {
  ApprovalRequirement,
  CheckReport,
  Landing,
  LandingAdvanceRequest,
  LandingAdvanceResult,
  LandingFailureCode,
  LandingReport,
  LanderControl,
  RequeueReason,
  ResolvedBy,
  ResolverReport,
} from '@agenthub/hub/protocol';
import { isLive } from './admission.js';
import { AttemptStale, bestEffort, HubUnavailable, hubWrite, LeaseLost, Stopping, type LanderContext } from './context.js';
import { failureReport, sendbackContext, tellIfFailed, tellParked, tellSendback } from './messages.js';
import { isHubError, type ResolveResult } from './ports.js';
import { commitMessage, ConflictReporter, emptyReport, LISTED_COMMITS, type SendbackContext } from './report.js';
import { approversOf, missingApprovals, mergedRequirements, protectedPaths, protectedRequirements, uniqueRequirements } from './requirements.js';
import { descends, fetchTrunk, findOnTrunk, localLandRef, policyOf, scanTrunk, trunkLocalRef } from './trunk.js';

/** How an attempt (or an in-doubt resolution) ended, for the loops. */
export type AttemptOutcome =
  | { kind: 'landed'; trunkSha: string; noop: boolean }
  | { kind: 'failed'; code: LandingFailureCode }
  | { kind: 'parked' }
  | { kind: 'requeued'; reason: RequeueReason | 'resolve' }
  /** Landing is paused (trunk rewritten, invalid config, a refused push, external pushes): wait for a resume. */
  | { kind: 'paused' }
  /** Left in pushing with its outcome unknown: next returns it with resolve: true. */
  | { kind: 'in_doubt' }
  /** The remote couldn't be reached: back off before taking work again. */
  | { kind: 'remote_unavailable' }
  /** The hub didn't answer: the landing is as the hub has it; the lease decides what happens next. */
  | { kind: 'hub_unavailable' }
  /** Cancelled, superseded or requeued meanwhile (landing_stale). */
  | { kind: 'stale' }
  /** The lease was lost (not_lander): nothing was pushed after that. */
  | { kind: 'lost' }
  /** The lander is stopping; the landing went back to the queue (lander_stopping). */
  | { kind: 'stopped' };

const MERGE_DEADLINE_MS = 10 * 60_000;
const RESOLVE_DEADLINE_PER_FILE_MS = 180_000;
const RESOLVE_DEADLINE_SLACK_MS = 2 * 60_000;
const TERMINAL_UNLANDED = ['failed', 'superseded', 'cancelled'] as const;

/** The remote ref prefix a staged candidate ref was made with (`<P>cand/…` → `<P>`). */
export function prefixOfCandidateRef(ref: string): string | null {
  const i = ref.indexOf('cand/');
  return i > 0 ? ref.slice(0, i) : null;
}

/** The mirror's copy of a staged candidate ref (`<P>cand/<rest>` → `refs/agenthub/cand/<rest>`). */
export function localCandidateRef(ref: string): string | null {
  const i = ref.indexOf('cand/');
  return i > 0 ? `refs/agenthub/${ref.slice(i)}` : null;
}

export type PushResult = { kind: 'pushed' } | { kind: 'stale' } | { kind: 'rejected'; detail: string } | { kind: 'unknown'; detail: string } | { kind: 'unfresh' };

/**
 * P10: the CAS push of `candidate` onto `expected`, which also deletes the
 * land ref (when it is still there), atomically. Self-fenced: never pushes
 * unless the lease's last acknowledgement is fresh. An unknown outcome is
 * retried with backoff while the lease stays fresh.
 */
export async function pushCandidate(ctx: LanderContext, o: { candidate: string; expected: string; landRef: string | null }): Promise<PushResult> {
  const waits = ctx.timings.pushRetryMs;
  let last = '';
  for (let i = 0; ; i++) {
    if (!ctx.lease.fresh() && !(await ctx.lease.renew())) return { kind: 'unfresh' };
    let deleteRef: string | undefined;
    if (o.landRef) {
      try {
        // An atomic push that deletes a ref the remote doesn't have would fail whole.
        if ((await ctx.git.lsRemote(o.landRef)) !== null) deleteRef = o.landRef;
      } catch {
        deleteRef = undefined;
      }
    }
    const out = await ctx.git.pushTrunk({ trunk: ctx.trunk.branch, candidate: o.candidate, expected: o.expected, deleteRef });
    if (out.kind === 'ok' || out.kind === 'up_to_date') return { kind: 'pushed' };
    if (out.kind === 'stale') return { kind: 'stale' };
    if (out.kind === 'rejected') return { kind: 'rejected', detail: out.detail };
    last = out.detail;
    if (i >= waits.length) return { kind: 'unknown', detail: last };
    ctx.log(`trunk push of ${o.candidate.slice(0, 12)}: outcome unknown (${last}); retrying in ${waits[i]} ms`);
    await ctx.clock.sleep(waits[i]!);
  }
}

/** One attempt at landing `pre`, which next just handed this lease (running, merging). */
export class Attempt {
  private readonly id: string;
  private readonly n: number;
  private readonly H: string;
  private readonly signal: AbortSignal;
  private cur: Landing;
  private land!: LandConfig;
  private T0 = '';
  private base = '';
  private files: string[] = [];
  private foreign: string[] = [];
  private alsoLanded: string[] = [];
  /** The hub has accepted `pushing` for this attempt: from here on only landed or resolve move it on. */
  private pushing = false;
  private staged: string | null = null;
  private readonly started: number;
  private timings = { merge_ms: 0, check_ms: 0, push_ms: 0 };

  constructor(
    private readonly ctx: LanderContext,
    private readonly pre: Landing,
    private readonly control: LanderControl,
  ) {
    this.id = pre.id;
    this.n = pre.attempt;
    this.H = pre.commit ?? '';
    this.cur = pre;
    this.signal = AbortSignal.any([ctx.lease.signal, ctx.stopping]);
    this.started = ctx.clock.now();
  }

  async run(): Promise<AttemptOutcome> {
    const { ctx } = this;
    try {
      return await this.steps();
    } catch (err) {
      if (err instanceof LeaseLost) {
        // In pushing, the push may have gone out (refused or up to date if another lander got there first): the next lease holder resolves it.
        ctx.log(this.pushing ? `${this.id}: lease lost in pushing; the next lease holder resolves it in doubt` : `${this.id}: lease lost; dropping attempt ${this.n} without pushing`);
        return { kind: 'lost' };
      }
      if (err instanceof AttemptStale) {
        ctx.log(`${this.id}: attempt ${this.n} is over at the hub (${err.message})`);
        if (this.staged && !this.pushing) await this.unstage();
        return { kind: 'stale' };
      }
      if (err instanceof HubUnavailable) {
        ctx.log(`${this.id}: the hub doesn't answer (${err.message}); attempt ${this.n} stops here`);
        return { kind: 'hub_unavailable' };
      }
      if (err instanceof Stopping) {
        if (this.pushing) return { kind: 'in_doubt' };
        return this.settle(async () => ((await this.requeue('lander_stopping')).kind === 'requeued' ? { kind: 'stopped' } : { kind: 'failed', code: 'lander_error' }), { kind: 'stopped' });
      }
      if (err instanceof StageFailed && !this.pushing) {
        ctx.log(`${this.id}: ${err.message}`);
        const reason: RequeueReason = err.reason === 'push_rejected' ? 'lander_stopping' : 'remote_unavailable';
        return this.settle(async () => {
          await this.requeue(reason);
          return err.reason === 'push_rejected' ? { kind: 'paused' } : { kind: 'remote_unavailable' };
        }, { kind: 'remote_unavailable' });
      }
      ctx.log(`${this.id}: lander error in attempt ${this.n}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (this.pushing) return { kind: 'in_doubt' };
      return this.settle(() => this.fail('lander_error', { warnings: [`lander error: ${firstLineOf(err)}`] }), { kind: 'failed', code: 'lander_error' });
    }
  }

  /** Runs a closing write; if even that fails, the hub's own deadlines and lease rules take the landing on. */
  private async settle(fn: () => Promise<AttemptOutcome>, fallback: AttemptOutcome): Promise<AttemptOutcome> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: 'lost' };
      if (err instanceof AttemptStale) return { kind: 'stale' };
      this.ctx.log(`${this.id}: couldn't record the end of attempt ${this.n}: ${firstLineOf(err)}`);
      return fallback;
    }
  }

  /** Throws when the lease is gone or the lander is stopping: nothing more happens in this attempt. */
  private checkpoint(): void {
    if (this.ctx.lease.signal.aborted) throw new LeaseLost(String(this.ctx.lease.signal.reason ?? 'lease lost'));
    if (this.ctx.stopping.aborted) throw new Stopping();
  }

  private async steps(): Promise<AttemptOutcome> {
    const { ctx, id, H } = this;
    await ctx.faults.at('after-next', id);
    // Our own running landing without the attempt in memory (a dropped answer to next, a restart under the same lease).
    if (this.pre.phase !== 'merging') {
      ctx.log(`${id} is in ${this.pre.phase} under this lease, but this process has no attempt for it: back to the queue`);
      return this.requeue('lander_stopping');
    }
    if (!FULL_SHA_RE.test(H)) return this.fail('not_pushed');

    // ---------------- P1: fetch, config from T0, the land ref, the trunk scan
    const trunk = await fetchTrunk(ctx, trunkLocalRef);
    if (trunk.kind === 'unavailable') {
      ctx.log(`${id}: can't fetch trunk (${trunk.detail})`);
      await this.requeue('remote_unavailable');
      return { kind: 'remote_unavailable' };
    }
    if (trunk.kind === 'missing' || !trunk.config.ok) {
      const detail = trunk.kind === 'missing' ? trunk.detail : !trunk.config.ok ? trunk.config.error : '';
      ctx.log(`${id}: ${detail}; landing is paused (config_invalid)`);
      await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'config_invalid', detail }));
      await this.requeue('config_invalid');
      return { kind: 'paused' };
    }
    this.T0 = trunk.tip;
    this.land = trunk.config.land;
    const T0 = this.T0;
    const land = this.land;

    const f = await ctx.git.fetch([`+${landRef(land.refPrefix, H)}:${localLandRef(H)}`]);
    if (f.kind === 'error') {
      ctx.log(`${id}: can't fetch its land ref (${f.detail})`);
      await this.requeue('remote_unavailable');
      return { kind: 'remote_unavailable' };
    }
    if (f.kind === 'missing') return this.fail('not_pushed', { warnings: ['the land ref is missing on the remote: push it again (call land)'] });
    const tip = await ctx.git.revParse(localLandRef(H));
    if (tip !== H) return this.fail('not_pushed', { warnings: [`the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at the landed commit ${H.slice(0, 12)}`] });

    const scan = await scanTrunk(ctx, T0, this.control, policyOf(land), land);
    if (scan.kind === 'rewritten') {
      await this.requeue('trunk_rewritten');
      return { kind: 'paused' };
    }
    if (scan.kind === 'paused') {
      await this.requeue('lander_stopping');
      return { kind: 'paused' };
    }
    this.foreign = scan.foreign;

    this.cur = (await this.advance({ to: 'running', phase: 'merging', deadline_ms: MERGE_DEADLINE_MS, trunk_base: T0 })).landing;
    this.checkpoint();

    // ---------------- P2: already landed? the stacked landing it waited for?
    const found = await findOnTrunk(ctx, this.cur, T0);
    if (found) {
      ctx.log(`${id} is already on trunk as ${found.slice(0, 12)}`);
      return this.landed(found, { resolved: 'none', message: `${id} is already on ${ctx.trunk.branch} as ${found.slice(0, 12)}.`, check: null, resolver: null, filesVia: [] });
    }
    this.alsoLanded = await this.sameAgentContained();
    if (this.cur.waits_for) {
      const w = await this.ctx.hub.landing(this.cur.waits_for).catch(() => null);
      if (w && !isLive(w) && w.status !== 'landed' && w.agent !== this.cur.agent && w.landed_with === null && !(w.commit && (await descends(ctx, w.commit, T0)))) {
        return this.fail('contains_unlanded', {}, { unlanded: { landingId: w.id, agent: w.agent } });
      }
    }

    // ---------------- P3: the base and the authoritative re-check
    this.base = (await ctx.git.landedBase(T0, H)).base;
    this.files = await ctx.git.diffNames(this.base, H);
    const protectedReqs = await protectedRequirements(ctx.git, land.protected, this.files, this.base, H);
    const paths = protectedPaths(this.files, land.protected);

    // ---------------- P4: the merge ladder
    const mergeStart = ctx.clock.monotonic();
    const drivers = land.structural === 'auto' ? ctx.drivers : [];
    const merge = await ctx.git.mergeTrees(T0, H, { base: this.base, attrSource: T0, drivers });
    await ctx.faults.at('during-merge', id);
    this.checkpoint();
    const tried: ResolvedBy[] = drivers.length > 0 ? ['clean', 'structural'] : ['clean'];
    let tree = merge.tree;
    let conflicts: ConflictEntry[] = merge.conflicts;
    let resolver: ResolverReport | null = null;
    let ai: ResolveResult | null = null;
    if (conflicts.length > 0 && land.resolver.enabled) {
      if (ctx.resolver) {
        await this.advance({ to: 'running', phase: 'resolving', deadline_ms: RESOLVE_DEADLINE_PER_FILE_MS * Math.min(conflicts.length, land.resolver.maxFiles) + RESOLVE_DEADLINE_SLACK_MS });
        ai = await ctx.resolver.resolve({ landing: this.cur, conflicts, tree, base: this.base, trunk: T0, head: H, config: land.resolver, protectedRules: land.protected, approved: [] });
        this.checkpoint();
        tried.push('ai');
        tree = ai.tree;
        const resolved = new Set(ai.resolved);
        conflicts = conflicts.filter((c) => !resolved.has(c.path));
        resolver = ai.report;
      } else {
        resolver = { model: land.resolver.model, outcome: 'skipped', files: [], novel_lines: 0, input_tokens: 0, output_tokens: 0, explanations: {} };
      }
    }
    this.timings.merge_ms = Math.round(ctx.clock.monotonic() - mergeStart);
    const structural = merge.structural;
    const aiPaths = ai?.resolved ?? [];
    const filesVia = [...structural.map((file) => ({ file, via: 'structural' as const })), ...aiPaths.map((file) => ({ file, via: 'ai' as const }))];
    const resolvedBy: ResolvedBy = aiPaths.length > 0 ? 'ai' : structural.length > 0 ? 'structural' : 'clean';
    if (conflicts.length > 0) {
      const reporter = new ConflictReporter({ git: ctx.git, hub: ctx.hub, project: ctx.project, epoch: ctx.lease.epoch, base: this.base, trunk: T0, onError: (what, err) => ctx.log(`${id}: report: ${what}: ${firstLineOf(err)}`) });
      const unresolved = new Map((ai?.unresolved ?? []).map((u) => [u.path, u]));
      const reports = await Promise.all(
        conflicts.map((c) => reporter.report(c, { tried, aiEligible: unresolved.get(c.path)?.eligible ?? false, explanation: unresolved.get(c.path)?.explanation ?? resolver?.explanations[c.path] ?? null })),
      );
      const code: LandingFailureCode = resolver && (resolver.outcome === 'rejected_output' || resolver.outcome === 'error') ? 'resolver_failed' : 'conflict';
      const warnings = land.resolver.enabled && !ctx.resolver ? ["the AI resolver is on in trunk's agenthub.json, but this lander has none: the AI stage was skipped"] : [];
      return this.fail(code, { conflicts: reports, resolver, files_via: filesVia, warnings }, { conflictFiles: conflicts.map((c) => c.path) });
    }

    // ---------------- P5: nothing left to land
    if (tree === (await ctx.git.treeOf(T0))) {
      ctx.log(`${id}: its change is already on trunk (no-op)`);
      return this.landed(T0, { resolved: 'none', message: `${id}'s change was already on ${ctx.trunk.branch}: nothing new was committed.`, check: null, resolver, filesVia: [], noop: true });
    }

    // ---------------- P6: the candidate (or the parked one, approved, on an unchanged trunk)
    let C: string | null = null;
    let check: CheckReport | null = null;
    let required: ApprovalRequirement[] = [];
    const fast = await this.fastPath(tree, protectedReqs, paths, ai);
    if (fast) {
      ({ candidate: C, required, check } = fast);
      ctx.log(`${id}: approved, on an unchanged trunk: pushing the candidate ${C.slice(0, 12)} that passed its checks before`);
    } else {
      C = await this.buildCandidate(tree, structural, aiPaths);
      required = uniqueRequirements([
        ...protectedReqs,
        ...(await mergedRequirements(ctx.git, land.protected, paths, { head: H, trunk: T0, merged: tree, candidate: C, candidateRef: this.candRef(C) })),
        ...(ai?.requirement ? [ai.requirement] : []),
      ]);

      // ---------------- P7: the checks
      await this.advance({ to: 'running', phase: 'checking', deadline_ms: (land.checkTimeoutMin + 5) * 60_000 });
      this.checkpoint();
      const checkStart = ctx.clock.monotonic();
      const branch = ctx.trunk.branch;
      const result = await ctx.checks.run({
        landingId: id,
        attempt: this.n,
        candidate: C,
        trunk: T0,
        epoch: ctx.lease.epoch,
        command: land.check,
        timeoutMs: land.checkTimeoutMin * 60_000,
        checkEnv: land.checkEnv,
        allowDirtyTree: land.allowDirtyTree,
        remote: land.remote,
        candidateRef: this.candRef(C),
        trunkWatch: { intervalMs: ctx.timings.pollTrunkMs, moved: async () => (await ctx.git.lsRemote(`refs/heads/${branch}`)) !== T0 },
        signal: this.signal,
        onStarted: () => void ctx.faults.at('during-checks', id),
      });
      this.timings.check_ms = Math.round(ctx.clock.monotonic() - checkStart);
      check = result.report;
      if (result.status === 'aborted') {
        this.checkpoint();
        throw new Stopping();
      }
      if (result.status === 'trunk_moved') {
        ctx.log(`${id}: trunk moved while its checks ran: back to the queue`);
        return this.requeue('trunk_moved');
      }
      if (result.status !== 'passed') {
        const code: LandingFailureCode = aiPaths.length > 0 ? 'resolver_failed' : result.status === 'timed_out' ? 'check_timeout' : result.status === 'modified_tree' ? 'checks_modified_tree' : 'checks_failed';
        // Staged so the author can reproduce the exact tree; the send-back doesn't wait on it.
        await this.stage(C).catch((err: unknown) => ctx.log(`${id}: staging the failed candidate for reproduce failed: ${firstLineOf(err)}`));
        return this.fail(
          code,
          { check, resolver, resolved_by: resolvedBy, files_via: filesVia },
          { exitCode: check.exit_code, durationMs: check.duration_ms, failedTests: check.failed_tests, reproduce: check.reproduce, conflictFiles: aiPaths },
        );
      }
      await ctx.faults.at('after-checks', id);
      this.checkpoint();
    }
    const resolvedReport = { resolved_by: resolvedBy, files_via: filesVia, check, resolver };

    // ---------------- P8: approvals still missing → park the checked candidate
    const latest = await ctx.hub.landing(id).catch(() => this.cur);
    const missing = missingApprovals(required, latest.approvals, latest.agent);
    if (missing.length > 0) return this.park(C, required, missing, resolvedReport);

    // ---------------- P9: the write-ahead
    await this.stage(C);
    await ctx.faults.at('after-candidate-staged', id);
    this.checkpoint();
    if (!(await ctx.lease.renew())) {
      ctx.log(`${id}: the lease's last acknowledgement is stale: not entering pushing`);
      throw new LeaseLost('self-fencing: no fresh lease acknowledgement');
    }
    const pushStart = ctx.clock.monotonic();
    try {
      await this.advance({ to: 'running', phase: 'pushing', candidate: C, candidate_ref: this.candRef(C), trunk_base: T0, tree, required });
    } catch (err) {
      if (isHubError(err, 'approval_missing')) {
        const more = Array.isArray(err.details?.missing) ? (err.details.missing as ApprovalRequirement[]) : [];
        return this.park(C, uniqueRequirements([...required, ...more]), more.length > 0 ? more : required, resolvedReport);
      }
      throw err;
    }
    this.pushing = true;
    await ctx.faults.at('after-pushing-ack', id);

    // ---------------- P10: the CAS push
    const pushed = await pushCandidate(ctx, { candidate: C, expected: T0, landRef: landRef(land.refPrefix, H) });
    this.timings.push_ms = Math.round(ctx.clock.monotonic() - pushStart);
    if (pushed.kind === 'stale') return this.afterStale(C);
    if (pushed.kind === 'rejected') {
      ctx.log(`${id}: the remote refused the trunk update (${pushed.detail}); landing is paused (push_rejected), and ${id} stays in pushing`);
      await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'push_rejected', detail: `the remote refused the trunk update of ${id}: ${pushed.detail}` }));
      return { kind: 'paused' };
    }
    if (pushed.kind === 'unknown' || pushed.kind === 'unfresh') {
      ctx.log(`${id}: the trunk push's outcome is unknown (${pushed.kind === 'unknown' ? pushed.detail : 'no fresh lease'}); it stays in pushing until resolved`);
      return { kind: 'in_doubt' };
    }
    await ctx.faults.at('after-trunk-push', id);
    await ctx.faults.at('before-landed-ack', id);
    const out = await this.landed(C, { ...resolvedReport, resolved: resolvedBy, message: `${id} landed on ${ctx.trunk.branch} as ${C.slice(0, 12)}.`, filesVia });
    return out;
  }

  // ------------------------------------------------------------ steps

  private candRef(C: string): string {
    return candidateRef(this.land.refPrefix, this.ctx.lease.epoch, this.id, C);
  }

  /** The same agent's failed, superseded or cancelled landings whose commits land inside this one (also_landed). */
  private async sameAgentContained(): Promise<string[]> {
    const { ctx } = this;
    const mine = await ctx.hub.landings({ agent: this.cur.agent, status: [...TERMINAL_UNLANDED], limit: 100 }).catch(() => [] as Landing[]);
    const out: string[] = [];
    for (const o of mine) {
      if (o.id === this.id || o.agent !== this.cur.agent || !o.commit || !FULL_SHA_RE.test(o.commit)) continue;
      if ((await descends(ctx, o.commit, this.H)) && !(await descends(ctx, o.commit, this.T0))) out.push(o.id);
    }
    return out;
  }

  /**
   * P6, the approved resume fast path (design §2.2.5, §3.7 step 4): the
   * landing was parked with a checked candidate on this same T0, the staged
   * candidate still resolves on the remote and has the tree the merge gives
   * now, and every requirement is met. Then that exact candidate is pushed
   * without running the checks again.
   */
  private async fastPath(tree: string, protectedReqs: ApprovalRequirement[], paths: string[], ai: ResolveResult | null): Promise<{ candidate: string; required: ApprovalRequirement[]; check: CheckReport | null } | null> {
    const { ctx, pre } = this;
    const C = pre.candidate;
    const ref = pre.candidate_ref;
    if (!pre.candidate_checked || !C || !ref || pre.trunk_base !== this.T0) return null;
    try {
      if ((await ctx.git.lsRemote(ref)) !== C) return null;
      if ((await ctx.git.revParse(C)) === null) {
        const local = localCandidateRef(ref);
        if (!local || (await ctx.git.fetch([`+${ref}:${local}`])).kind !== 'ok') return null;
      }
      if ((await ctx.git.treeOf(C)) !== tree || (await ctx.git.revParse(`${C}^1`)) !== this.T0) return null;
    } catch {
      return null;
    }
    const required = uniqueRequirements([
      ...protectedReqs,
      ...(await mergedRequirements(ctx.git, this.land.protected, paths, { head: this.H, trunk: this.T0, merged: tree, candidate: C, candidateRef: ref })),
      ...(ai?.requirement ? [ai.requirement] : []),
    ]);
    const latest = await ctx.hub.landing(this.id).catch(() => this.cur);
    if (missingApprovals(required, latest.approvals, latest.agent).length > 0) return null;
    return { candidate: C, required, check: pre.report?.check ?? null };
  }

  /** P6: the squash commit C = commit-tree R -p T0, with the lander's message and the author of H; C^1 == T0 is asserted. */
  private async buildCandidate(tree: string, structural: string[], aiPaths: string[]): Promise<string> {
    const { ctx, land, H, T0 } = this;
    const [info, squashed, taskTitle] = await Promise.all([ctx.git.commitInfo(H), ctx.git.commits(this.base, H, LISTED_COMMITS), this.taskTitle()]);
    const latest = await ctx.hub.landing(this.id).catch(() => this.cur);
    const message = commitMessage({
      project: ctx.project,
      landingId: this.id,
      epoch: ctx.lease.epoch,
      source: H,
      attempt: this.n,
      agent: this.cur.agent,
      taskId: this.cur.task_id,
      taskTitle,
      summary: this.cur.summary,
      commits: squashed,
      resolved: { structural, ai: aiPaths.length > 0 ? { model: land.resolver.model, paths: aiPaths } : null },
      checkCommand: land.check,
      approvals: latest.approvals.map((a) => ({ kind: a.kind, by: a.by })),
    });
    const C = await ctx.git.commitTree(tree, T0, message, info.author, ctx.committer);
    const parent = await ctx.git.revParse(`${C}^1`);
    if (parent !== T0) throw new Error(`the candidate ${C} has first parent ${parent}, not ${T0}`);
    return C;
  }

  private async taskTitle(): Promise<string | null> {
    if (!this.cur.task_id) return null;
    try {
      return (await this.ctx.hub.tasks()).find((t) => t.id === this.cur.task_id)?.title ?? null;
    } catch {
      return null;
    }
  }

  /** Stages C at its candidate ref (a plain push of a new name; up_to_date counts). */
  private async stage(C: string): Promise<void> {
    const ref = this.candRef(C);
    const out = await this.ctx.git.pushRef({ prefix: this.land.refPrefix, sha: C, ref });
    if (out.kind === 'ok' || out.kind === 'up_to_date') {
      this.staged = ref;
      return;
    }
    if (out.kind === 'rejected') {
      await hubWrite(this.ctx, 'pause', () =>
        this.ctx.hub.pause({
          lease: this.ctx.lease.auth(),
          reason: 'push_rejected',
          detail: `the remote refused the candidate ref ${ref}: ${out.detail}. If the host doesn't accept refs outside refs/heads, set land.refPrefix to refs/heads/agenthub/`,
        }),
      );
      throw new StageFailed('push_rejected', out.detail);
    }
    throw new StageFailed('remote_unavailable', out.detail);
  }

  private async unstage(): Promise<void> {
    const ref = this.staged;
    if (!ref) return;
    this.staged = null;
    await bestEffort(this.ctx, `deleting ${ref}`, () => this.ctx.git.pushRef({ prefix: this.land.refPrefix, sha: null, ref }));
  }

  /** P8 / T6: the checks passed but an approval is missing: the candidate is staged and the landing parks (the slot is freed). */
  private async park(C: string, required: ApprovalRequirement[], missing: ApprovalRequirement[], parts: Partial<LandingReport>): Promise<AttemptOutcome> {
    const { ctx, id } = this;
    await this.stage(C);
    const paths = [...new Set(missing.flatMap((r) => r.paths))].sort();
    const approvers = approversOf(missing);
    const report: LandingReport = {
      ...emptyReport(),
      ...parts,
      message: `${id} passed its checks and waits for an approval of ${paths.join(', ')}${approvers ? ` (${approvers.join(' or ')})` : ''}.`,
      next_steps: [`Tell your human: \`hub approve ${id}\` in a terminal. It lands once approved (the checked candidate is pushed as it is, if ${this.ctx.trunk.branch} hasn't moved).`],
      warnings: this.cur.report?.warnings ?? [],
      foreign_commits: this.foreign,
      timings: this.timingsReport(),
    };
    const r = await this.advance({ to: 'needs_approval', required, report, candidate: C, candidate_ref: this.candRef(C) });
    if (r.landing.status === 'needs_approval') {
      ctx.log(`${id}: parked for approval (${paths.join(', ')})`);
      await tellParked(ctx, r.landing, paths, approvers);
      return { kind: 'parked' };
    }
    ctx.log(`${id}: its approvals came in while it ran: back to the queue`);
    return { kind: 'requeued', reason: 'approved' };
  }

  /** P10 `stale`: trunk moved. Landed after all (C or its trailers are on trunk), or back to the queue (T12). */
  private async afterStale(C: string): Promise<AttemptOutcome> {
    const { ctx, id } = this;
    const t = await fetchTrunk(ctx, trunkLocalRef);
    if (t.kind !== 'ok') return { kind: 'in_doubt' };
    const on = (await descends(ctx, C, t.tip)) ? C : await findOnTrunk(ctx, this.cur, t.tip);
    if (on) {
      const r = await hubWrite(ctx, `resolve ${id}`, () => ctx.hub.resolve(id, { lease: ctx.lease.auth(), outcome: 'landed', trunk_sha: on, symbol_changes: [] }));
      await this.cleanup(r.landing);
      return { kind: 'landed', trunkSha: on, noop: false };
    }
    ctx.log(`${id}: trunk moved to ${t.tip.slice(0, 12)} before the push: back to the queue`);
    const r = await hubWrite(ctx, `resolve ${id}`, () => ctx.hub.resolve(id, { lease: ctx.lease.auth(), outcome: 'requeue', trunk_sha: t.tip }));
    await tellIfFailed(ctx, r, this.land);
    return r.landing.status === 'failed' ? { kind: 'failed', code: r.landing.failure?.code ?? 'trunk_busy' } : { kind: 'requeued', reason: 'trunk_moved' };
  }

  // ------------------------------------------------------------ transitions

  private advance(req: DistributiveOmit<LandingAdvanceRequest, 'lease' | 'attempt'>): Promise<LandingAdvanceResult> {
    const { ctx, id, n } = this;
    return hubWrite(ctx, `advance ${id}`, () => ctx.hub.advance(id, { ...req, lease: ctx.lease.auth(), attempt: n } as LandingAdvanceRequest));
  }

  private async requeue(reason: RequeueReason): Promise<AttemptOutcome> {
    const r = await this.advance({ to: 'queued', reason });
    await tellIfFailed(this.ctx, r, this.land ?? null);
    if (r.landing.status === 'failed') return { kind: 'failed', code: r.landing.failure?.code ?? 'lander_error' };
    return { kind: 'requeued', reason };
  }

  /** T13: failed, with the lander's report and its direct message to the author. */
  private async fail(code: LandingFailureCode, parts: Partial<LandingReport> = {}, extra: Partial<SendbackContext> = {}): Promise<AttemptOutcome> {
    const { ctx, id } = this;
    const s = sendbackContext(ctx, this.cur, this.land ?? null, extra);
    const report = failureReport(code, s, { foreign_commits: this.foreign, timings: this.timingsReport(), ...parts, warnings: [...(this.cur.report?.warnings ?? []), ...(parts.warnings ?? [])] });
    const r = await this.advance({ to: 'failed', code, report });
    ctx.log(`${id}: came back (${code})`);
    if (!r.replayed) await tellSendback(ctx, r.landing, code, s);
    return { kind: 'failed', code };
  }

  /** T11: landed (or already on trunk, or a no-op), then the best-effort cleanup (P11). */
  private async landed(
    trunkSha: string,
    o: { resolved: ResolvedBy; message: string; check: CheckReport | null; resolver: ResolverReport | null; filesVia: Array<{ file: string; via: ResolvedBy }>; noop?: boolean },
  ): Promise<AttemptOutcome> {
    const { ctx, id } = this;
    const report: LandingReport = {
      ...emptyReport(),
      message: o.message,
      resolved_by: o.resolved,
      files_via: o.filesVia,
      check: o.check,
      resolver: o.resolver,
      warnings: this.cur.report?.warnings ?? [],
      foreign_commits: this.foreign,
      timings: this.timingsReport(),
    };
    const r = await this.advance({ to: 'landed', trunk_sha: trunkSha, base_sha: this.base || this.T0, files: this.files, report, also_landed: this.alsoLanded, symbol_changes: [] });
    await ctx.faults.at('after-landed-ack', id);
    ctx.log(`${id} landed as ${trunkSha.slice(0, 12)}${o.noop ? ' (no-op)' : ''}`);
    await this.cleanup(r.landing, o.noop === true);
    return { kind: 'landed', trunkSha, noop: o.noop === true };
  }

  /** P11: the staged candidate and the land ref go (the land ref went with the trunk push unless this was a no-op). */
  private async cleanup(landing: Landing, deleteLandRef = false): Promise<void> {
    const { ctx, H } = this;
    if (landing.status !== 'landed') return;
    if (this.staged) await this.unstage();
    if (landing.candidate_ref && landing.candidate_ref !== this.staged) {
      await bestEffort(ctx, `deleting ${landing.candidate_ref}`, () => ctx.git.pushRef({ prefix: this.land.refPrefix, sha: null, ref: landing.candidate_ref! }));
    }
    if (deleteLandRef) {
      await bestEffort(ctx, `deleting the land ref of ${landing.id}`, async () => {
        const ref = landRef(this.land.refPrefix, H);
        if ((await ctx.git.lsRemote(ref)) !== null) await ctx.git.pushRef({ prefix: this.land.refPrefix, sha: null, ref });
      });
    }
    await bestEffort(ctx, 'deleting the local land ref', () => ctx.git.deleteLocalRef(localLandRef(H)));
  }

  private timingsReport(): LandingReport['timings'] {
    const queued = (this.pre.started_at ?? this.started) - this.pre.created_at;
    return { queued_ms: Math.max(0, queued), ...this.timings };
  }
}

/** Staging a candidate failed: the remote refused the ref (paused) or couldn't be reached. */
export class StageFailed extends Error {
  constructor(
    readonly reason: 'push_rejected' | 'remote_unavailable',
    detail: string,
  ) {
    super(`staging the candidate failed: ${detail}`);
    this.name = 'StageFailed';
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function firstLineOf(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.split('\n')[0]!.slice(0, 300);
}

/** Runs one attempt for `landing`, which next just handed this lease. */
export function runAttempt(ctx: LanderContext, landing: Landing, control: LanderControl): Promise<AttemptOutcome> {
  return new Attempt(ctx, landing, control).run();
}
