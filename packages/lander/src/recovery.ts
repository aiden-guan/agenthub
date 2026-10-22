// Crash recovery and the in-doubt rule (design §2.2.7). A landing in
// `pushing` whose fate is unknown (its lease ended, the push outcome was
// unknown, the remote refused it) is moved on only after the remote has been
// inspected: on trunk (by ancestry or by its trailers) → landed; trunk still
// at its base and its staged candidate intact → push that same candidate;
// otherwise it can never land as it is → requeue. Every incarnation of the
// lander pushes the same sha onto the same base, so it lands at most once (I3).

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { landRef } from '@agenthub/contract';
import type { Landing, LanderControl } from '@agenthub/hub/protocol';
import { bestEffort, HubUnavailable, hubWrite, LeaseLost, AttemptStale, type LanderContext } from './context.js';
import { tellIfFailed } from './messages.js';
import { prefixOfCandidateRef, pushCandidate, type AttemptOutcome } from './pipeline.js';
import { descends, fetchTrunk, findOnTrunk, localCandidateRef, localLandRef, trunkLocalRef } from './trunk.js';

/**
 * resolveInDoubt (design §2.2.7), for a landing next returned with
 * `resolve: true`, whichever lease left it there. While landing is paused
 * nothing is pushed (a refused push waits for `hub lander resume`), but a
 * landing already on trunk, or one that can no longer land, is still
 * resolved.
 */
export async function resolveInDoubt(ctx: LanderContext, L: Landing, control: LanderControl): Promise<AttemptOutcome> {
  try {
    return await resolve(ctx, L, control);
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: 'lost' };
    if (err instanceof AttemptStale) return { kind: 'stale' };
    if (err instanceof HubUnavailable) return { kind: 'hub_unavailable' };
    ctx.log(`${L.id}: resolving it failed: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: 'in_doubt' };
  }
}

async function resolve(ctx: LanderContext, L: Landing, control: LanderControl): Promise<AttemptOutcome> {
  const C = L.candidate;
  const T0 = L.trunk_base;
  const ref = L.candidate_ref;
  const H = L.commit ?? '';
  const prefix = ref ? prefixOfCandidateRef(ref) : null;

  for (let round = 0; round < 3; round++) {
    // 1. Trunk and the staged candidate, as the remote has them now.
    const t = await fetchTrunk(ctx, trunkLocalRef);
    if (t.kind !== 'ok') {
      ctx.log(`${L.id}: can't fetch trunk to resolve it (${t.kind === 'unavailable' ? t.detail : t.detail})`);
      return { kind: 'remote_unavailable' };
    }
    const tip = t.tip;

    // 2. Already on trunk?
    const on = C && (await descends(ctx, C, tip)) ? C : await findOnTrunk(ctx, L, tip);
    if (on) {
      ctx.log(`${L.id} is on trunk as ${on.slice(0, 12)}: resolved as landed`);
      const r = await hubWrite(ctx, `resolve ${L.id}`, () => ctx.hub.resolve(L.id, { lease: ctx.lease.auth(), outcome: 'landed', trunk_sha: on, symbol_changes: [] }));
      await cleanupLanded(ctx, r.landing);
      return { kind: 'landed', trunkSha: on, noop: false };
    }

    // 4. Trunk moved past its base without it: its CAS can never succeed now.
    if (!C || !T0 || tip !== T0) {
      ctx.log(`${L.id}: trunk is at ${tip.slice(0, 12)}, past its base ${T0?.slice(0, 12) ?? '(none)'}, without it: back to the queue`);
      return requeue(ctx, L, tip);
    }

    // 5. The staged candidate is gone: the same C can't be pushed by anyone.
    let staged: string | null;
    try {
      staged = ref ? await ctx.git.lsRemote(ref) : null;
    } catch (err) {
      ctx.log(`${L.id}: can't read its staged candidate (${(err as Error).message})`);
      return { kind: 'remote_unavailable' };
    }
    if (staged !== C) {
      ctx.log(`${L.id}: its staged candidate ${ref ?? '(none)'} is gone: back to the queue (a new attempt merges and checks again)`);
      return requeue(ctx, L, tip);
    }

    // 3. Trunk still at T0 and C staged: push the same C (a racing lander's identical push reads up_to_date).
    if (control.paused) {
      ctx.log(`${L.id} waits in pushing: landing is paused (${control.paused.reason}); it is pushed once an approver resumes`);
      return { kind: 'paused' };
    }
    if ((await ctx.git.revParse(C)) === null) {
      const local = localCandidateRef(ref!);
      if (!local || (await ctx.git.fetch([`+${ref}:${local}`])).kind !== 'ok') return { kind: 'remote_unavailable' };
    }
    const pushed = await pushCandidate(ctx, { candidate: C, expected: T0, landRef: prefix ? landRef(prefix, H) : null });
    if (pushed.kind === 'pushed') {
      ctx.log(`${L.id}: pushed its staged candidate ${C.slice(0, 12)}`);
      const r = await hubWrite(ctx, `resolve ${L.id}`, () => ctx.hub.resolve(L.id, { lease: ctx.lease.auth(), outcome: 'landed', trunk_sha: C, symbol_changes: [] }));
      await cleanupLanded(ctx, r.landing);
      return { kind: 'landed', trunkSha: C, noop: false };
    }
    if (pushed.kind === 'rejected') {
      ctx.log(`${L.id}: the remote refused the trunk update again (${pushed.detail}); landing stays paused`);
      await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'push_rejected', detail: `the remote refused the trunk update of ${L.id}: ${pushed.detail}` }));
      return { kind: 'paused' };
    }
    if (pushed.kind !== 'stale') return { kind: 'in_doubt' };
    // stale: trunk moved meanwhile; look again.
  }
  return { kind: 'in_doubt' };
}

async function requeue(ctx: LanderContext, L: Landing, tip: string): Promise<AttemptOutcome> {
  const r = await hubWrite(ctx, `resolve ${L.id}`, () => ctx.hub.resolve(L.id, { lease: ctx.lease.auth(), outcome: 'requeue', trunk_sha: tip }));
  await tellIfFailed(ctx, r, null);
  if (r.landing.status === 'failed') return { kind: 'failed', code: r.landing.failure?.code ?? 'trunk_busy' };
  return { kind: 'requeued', reason: 'resolve' };
}

/** After a landed resolution: the staged candidate ref and the local land ref go (best effort). */
async function cleanupLanded(ctx: LanderContext, landing: Landing): Promise<void> {
  if (landing.status !== 'landed') return;
  const ref = landing.candidate_ref;
  const prefix = ref ? prefixOfCandidateRef(ref) : null;
  if (ref && prefix) await bestEffort(ctx, `deleting ${ref}`, () => ctx.git.pushRef({ prefix, sha: null, ref }));
  if (landing.commit) await bestEffort(ctx, 'deleting the local land ref', () => ctx.git.deleteLocalRef(localLandRef(landing.commit!)));
}

/**
 * Startup recovery (design §2.2.7), once the lease is granted and before the
 * loops: forget check worktrees, kill the check process groups a dead lander
 * left running, remove its run directories and the mirror's fetched
 * candidate refs. In-doubt landings are resolved through next.
 */
export async function startupRecovery(ctx: LanderContext, workdir: string | null): Promise<void> {
  const killed = await ctx.checks.killOrphans().catch(() => [] as number[]);
  if (killed.length > 0) ctx.log(`killed ${killed.length} check process group${killed.length === 1 ? '' : 's'} a previous lander left running`);
  if (workdir) {
    const runs = path.join(workdir, 'runs');
    try {
      if (existsSync(runs)) for (const name of readdirSync(runs)) rmSync(path.join(runs, name), { recursive: true, force: true });
    } catch (err) {
      ctx.log(`removing old run directories failed: ${(err as Error).message}`);
    }
  }
  await bestEffort(ctx, 'git worktree prune', () => ctx.git.pruneWorktrees());
  for (const r of await ctx.git.localRefs('refs/agenthub/cand/').catch(() => [])) {
    await bestEffort(ctx, `deleting ${r.ref}`, () => ctx.git.deleteLocalRef(r.ref));
  }
}
