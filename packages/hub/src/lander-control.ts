import { LANDER_LEASE_KEY } from '@agenthub/contract';
import { HubError, type HubAuth, type HubInternals } from './common.js';
import { HUMAN_RE, type TrunkCommit, type TrunkReportInput } from './landing-requests.js';
import { completeLanding, emitUpdated, failLanding, mustGetLanding, requeueLanding, updateLanding } from './landings.js';
import type { Claim, LanderAuth, LanderControl, Landing } from './protocol.js';
import type { Store } from './store.js';

// The lander's side of the hub that isn't one landing (design §1.4 T9, T10,
// T16; §1.5): the lease and its fencing, what happens when a lease ends, step
// and approval deadlines, trunk reports, pause and resume. Every function that
// changes anything runs inside Hub.write.

const HOUR_MS = 60 * 60_000;

/** Lander routes need lander credentials (the server checks the token): 403 forbidden otherwise. */
export function requireLander(auth: HubAuth | undefined): void {
  if (!auth?.lander) {
    throw new HubError('forbidden', 'this is a lander route: it needs lander credentials (an x-hub-agent of lander/..., plus x-hub-lander-token when the hub has one)', 403);
  }
}

/** Approver routes need an approver's name (the server checks the token): 403 not_approver otherwise. */
export function requireApprover(auth: HubAuth | undefined): string {
  const name = auth?.approver;
  if (typeof name !== 'string' || !HUMAN_RE.test(name)) {
    throw new HubError('not_approver', 'this needs an approver: x-hub-approver with that human’s x-hub-approver-token (hub approve and hub lander resume send them from a terminal)', 403);
  }
  return name;
}

/** Whether a claim is a lander lease: a claim (not a hold) on exactly LANDER_LEASE_KEY. */
export function isLeaseClaim(c: Pick<Claim, 'scope' | 'landing_id'>): boolean {
  return c.landing_id === null && c.scope.length === 1 && c.scope[0].file === LANDER_LEASE_KEY && c.scope[0].symbol === undefined;
}

/**
 * Fencing (design §1.5), inside the write after expireDue: `agent` holds the
 * active lease claim `lease.lease_claim_id` of this hub's database (its epoch).
 * A lease whose time is up is never honoured, even before the sweeper ends it,
 * and claim ids are never reused, so 409 not_lander stops every stale lander.
 */
export function assertLander(store: Store, project: string, agent: string, lease: LanderAuth, now: number): Claim {
  const claim = store.getClaim(project, lease.lease_claim_id);
  const live = claim !== null && claim.status === 'active' && claim.holder === agent && isLeaseClaim(claim) && claim.expires_at > now;
  if (!live || lease.epoch !== store.epoch()) {
    throw new HubError(
      'not_lander',
      `${agent} doesn't hold this hub's active lander lease ${lease.lease_claim_id}: it expired, was released or is another lander's, or it is from another hub database. Stop the attempt (push nothing) and claim the lease again.`,
      409,
    );
  }
  return claim;
}

/**
 * endClaim calls this for every claim it ends. When a lander lease ends, the
 * landing it was running is requeued in its place (T9 lander_lost; past 3 it
 * fails), unless it is in pushing: then it is left in doubt (T10), holding the
 * running slot, until a lease holder that inspected the remote resolves it.
 */
export function onLeaseEnded(ix: HubInternals, project: string, lease: Claim, now: number): void {
  if (!isLeaseClaim(lease)) return;
  for (const row of ix.store.listLandings(project, { statuses: ['running'], order: 'queue' })) {
    if (row.lease_claim_id !== lease.id) continue;
    const landing = mustGetLanding(ix.store, project, row.id);
    if (landing.phase !== 'pushing') {
      requeueLanding(ix, project, landing, 'lander_lost', now, null);
    } else if (!landing.in_doubt) {
      emitUpdated(ix, project, updateLanding(ix, project, landing, { in_doubt: true }, now), 'in_doubt', null, now);
    }
  }
}

/** A landing the hub must move on by time: a running step past its deadline (never pushing), or a parked landing past its approval timeout. */
export function landingDue(l: Pick<Landing, 'status' | 'phase' | 'in_doubt' | 'deadline_at'>, now: number): boolean {
  if (l.deadline_at === null || l.deadline_at > now) return false;
  return l.status === 'needs_approval' || (l.status === 'running' && l.phase !== 'pushing' && !l.in_doubt);
}

/** The write pre-step after expireDue (design §1.4 T8, T9): step_timeout requeues (lander_stuck past 2), approval_timeout failures. */
export function expireLandings(ix: HubInternals, project: string, now: number): void {
  const due = ix.store.listLandings(project, { statuses: ['running', 'needs_approval'], order: 'queue' }).filter((l) => landingDue(l, now));
  for (const row of due) {
    const landing = mustGetLanding(ix.store, project, row.id);
    if (landing.status === 'running') {
      requeueLanding(ix, project, landing, 'step_timeout', now, null);
    } else {
      const hours = ix.store.getLanderControl(project).policy.approval_timeout_hours;
      const summary = `${landing.id} came back: nobody approved it within ${hours} h of it passing its checks. Ask your human to get it approved (hub approve ${landing.id}), then land again.`;
      failLanding(ix, project, landing, 'approval_timeout', summary, null, now, null);
    }
  }
}

/**
 * POST /lander/trunk. Keeps the reported policy. A rewritten trunk pauses
 * landing (trunk_rewritten) until an approver accepts a tip; the hub's trunk
 * stays where it was. Otherwise each reported first-parent commit whose
 * trailers name a landing of this project, this hub's epoch and that
 * landing's own commit is that landing: one not landed yet is reconciled to
 * landed (T16) and its author told; a commit that matches nothing was pushed
 * outside the queue (trunk.moved, foreign). control.trunk becomes `to`.
 */
export function reportTrunk(ix: HubInternals, project: string, agent: string, req: TrunkReportInput, now: number): LanderControl {
  const { store } = ix;
  let control = store.putLanderControl(project, { policy: req.policy }, now);
  if (req.rewritten) {
    if (control.paused?.reason !== 'trunk_rewritten') {
      const detail = `${short(req.to)} does not descend from ${req.from ? short(req.from) : 'the trunk the hub knew'}: trunk was rewritten outside agenthub. Nothing lands until an approver checks trunk and runs hub lander resume --accept-trunk <sha>.`;
      control = store.putLanderControl(project, { paused: { reason: 'trunk_rewritten', detail, at: now, by: agent } }, now);
      ix.emit(project, 'lander.paused', agent, { reason: 'trunk_rewritten', by: agent });
    }
    return control;
  }
  let from = req.from;
  let tip: Landing | null = null;
  for (const commit of req.commits) {
    const matched = matchLanding(store, project, commit);
    if (matched && matched.status !== 'landed') {
      const was = matched.status;
      completeLanding(ix, project, matched, { trunk_sha: commit.sha, reconciled: true }, now, agent);
      ix.emit(project, 'trunk.moved', agent, { from, to: commit.sha, landing_id: matched.id, files: commit.files, foreign: false });
      tell(
        ix,
        project,
        agent,
        matched.agent,
        `${matched.id} is on trunk after all: the lander found its commit ${short(matched.commit ?? '')} on trunk as ${short(commit.sha)}, though the hub had it as ${was}. It now counts as landed; if you landed the same work again, that landing has nothing left to land.`,
        now,
      );
    } else if (!matched) {
      ix.emit(project, 'trunk.moved', agent, { from, to: commit.sha, landing_id: null, files: commit.files, foreign: true });
    }
    from = commit.sha;
    tip = commit.sha === req.to ? matched : null;
  }
  if (control.trunk?.sha !== req.to) {
    control = store.putLanderControl(project, { trunk: { sha: req.to, landing_id: tip?.id ?? null, at: now } }, now);
  }
  return control;
}

/** The landing a trunk commit is, by its trailers (design §1.1 identity): Landing, Hub and Source all match. */
function matchLanding(store: Store, project: string, commit: TrunkCommit): Landing | null {
  if (!commit.landing || !commit.hub || !commit.source || commit.hub !== store.epoch()) return null;
  const prefix = `${project}/`;
  if (!commit.landing.startsWith(prefix)) return null;
  const landing = store.getLanding(project, commit.landing.slice(prefix.length));
  return landing && landing.commit === commit.source ? mustGetLanding(store, project, landing.id) : null;
}

/**
 * POST /lander/pause: nothing new starts until an approver resumes (in-doubt
 * landings are still handed out). A trunk_rewritten pause stays as it is, and
 * so does a pause for the same reason.
 */
export function pauseLander(ix: HubInternals, project: string, agent: string, req: { reason: NonNullable<LanderControl['paused']>['reason']; detail: string }, now: number): LanderControl {
  const control = ix.store.getLanderControl(project);
  if (control.paused && (control.paused.reason === req.reason || control.paused.reason === 'trunk_rewritten')) return control;
  const paused = ix.store.putLanderControl(project, { paused: { reason: req.reason, detail: req.detail, at: now, by: agent } }, now);
  ix.emit(project, 'lander.paused', agent, { reason: req.reason, by: agent });
  return paused;
}

/** POST /lander/resume (approver): clears the pause; after a rewrite only with accept_trunk, which becomes the hub's trunk. */
export function resumeLander(ix: HubInternals, project: string, approver: string, req: { accept_trunk: string | null }, now: number): LanderControl {
  const control = ix.store.getLanderControl(project);
  if (control.paused?.reason === 'trunk_rewritten' && req.accept_trunk === null) {
    throw new HubError(
      'bad_request',
      `landing paused because trunk was rewritten (${control.paused.detail}) Look at trunk, then resume with accept_trunk: the sha landing continues from (hub lander resume --accept-trunk <sha>).`,
    );
  }
  const patch: Partial<LanderControl> = { paused: null };
  if (req.accept_trunk !== null) patch.trunk = { sha: req.accept_trunk, landing_id: null, at: now };
  const resumed = ix.store.putLanderControl(project, patch, now);
  if (control.paused) ix.emit(project, 'lander.resumed', approver, { reason: 'human', by: approver });
  return resumed;
}

/** A direct message written by the hub, sent as `from` (the lander that reported it). */
function tell(ix: HubInternals, project: string, from: string, to: string, body: string, now: number): void {
  const id = ix.store.insertMessage({ project, from, to, channel: null, body, created_at: now });
  ix.emit(project, 'message.posted', from, { message_id: id, from, to, channel: null }, [to, from]);
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
