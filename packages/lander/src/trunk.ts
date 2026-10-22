// Trunk as the lander sees it (design §1.2, §2.2.5 P1, §2.2.1): trunk's own
// agenthub.json, parsed strictly (I4: the config always comes from trunk,
// never from the change), and the trunk scan that tells the hub where trunk
// is: reconcile (T16) and foreign commits, or a rewrite, which pauses landing
// everywhere until an approver accepts the new tip.

import { parseTeamSections, type LandConfig, type TeamSections } from '@agenthub/contract';
import type { LandPolicy, LanderControl, TrunkReportRequest } from '@agenthub/hub/protocol';
import { hubWrite, type LanderContext } from './context.js';
import type { GitPort } from './ports.js';

/** Where the attempt loop keeps trunk in the mirror (the admission loop uses ADMIT_TRUNK_REF, so they never contend on one ref lock). */
export function trunkLocalRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}
export const ADMIT_TRUNK_REF = 'refs/agenthub/admit-trunk';

/** The mirror's copy of a land ref. */
export function localLandRef(sha: string): string {
  return `refs/agenthub/land/${sha}`;
}

export type TrunkConfig = { ok: true; land: LandConfig; sections: TeamSections; raw: Record<string, unknown> } | { ok: false; error: string };

/** trunk's agenthub.json at `rev`, strictly (design §1.2): any problem, a missing land section or check included, is an error. */
export async function readTrunkConfig(git: Pick<GitPort, 'showBlob'>, rev: string): Promise<TrunkConfig> {
  const text = await git.showBlob(rev, 'agenthub.json');
  if (text === null) return { ok: false, error: `trunk (${rev.slice(0, 12)}) has no agenthub.json` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `trunk's agenthub.json is not valid JSON: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: "trunk's agenthub.json must hold a JSON object" };
  try {
    const { sections } = parseTeamSections(raw, { strict: true, where: "trunk's agenthub.json" });
    if (!sections.land) return { ok: false, error: "trunk's agenthub.json has no land section: this project has no landing queue" };
    return { ok: true, land: sections.land, sections, raw: raw as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type FetchedTrunk = { kind: 'ok'; tip: string; config: TrunkConfig } | { kind: 'unavailable'; detail: string } | { kind: 'missing'; detail: string };

/**
 * Fetches trunk into `localRef` and reads its config. Trunk's own
 * `land.trunk` names the trunk branch: when it names another branch than the
 * one fetched, that branch is fetched and read instead (once).
 */
export async function fetchTrunk(ctx: LanderContext, localRef: (branch: string) => string): Promise<FetchedTrunk> {
  for (let hop = 0; ; hop++) {
    const branch = ctx.trunk.branch;
    const ref = localRef(branch);
    const f = await ctx.git.fetch([`+refs/heads/${branch}:${ref}`]);
    if (f.kind === 'error') return { kind: 'unavailable', detail: f.detail };
    if (f.kind === 'missing') return { kind: 'missing', detail: `the remote has no branch ${branch}` };
    const tip = await ctx.git.revParse(ref);
    if (!tip) return { kind: 'missing', detail: `the remote has no branch ${branch}` };
    const config = await readTrunkConfig(ctx.git, tip);
    if (!config.ok || config.land.trunk === branch) return { kind: 'ok', tip, config };
    if (hop > 0) {
      return { kind: 'ok', tip, config: { ok: false, error: `agenthub.json on ${branch} says land.trunk is ${config.land.trunk}, which says it is ${branch}: fix land.trunk` } };
    }
    ctx.log(`trunk's agenthub.json names ${config.land.trunk} as trunk (not ${branch}): landing onto ${config.land.trunk}`);
    ctx.trunk.branch = config.land.trunk;
  }
}

/** The policy the hub applies itself (design §1.2 "Policy the hub applies itself"). */
export function policyOf(land: LandConfig): LandPolicy {
  return {
    keep_place_retries: land.keepPlaceRetries,
    sendback_grace_min: land.sendbackGraceMin,
    approval_timeout_hours: land.approval.timeoutHours,
    claim_gate: land.claimGate,
  };
}

/** The policy to report when trunk's config can't be read: the last one the hub has. */
export function knownPolicy(control: LanderControl): LandPolicy {
  return control.policy;
}

export type ScanResult =
  | { kind: 'ok'; control: LanderControl; foreign: string[] }
  /** trunk doesn't descend from the hub's trunk: the hub paused landing (trunk_rewritten). */
  | { kind: 'rewritten'; control: LanderControl }
  /** foreign commits with externalPushes: pause: the lander paused landing (external_push). */
  | { kind: 'paused'; control: LanderControl; foreign: string[] };

/** At most this many commits go into one trunk report (the hub's limit). */
const REPORT_COMMITS = 500;

/**
 * The trunk scan (design §2.2.5 P1): tells the hub that trunk is at `tip`.
 * A tip that doesn't descend from the hub's trunk is a rewrite (the hub
 * pauses). Otherwise the first-parent commits since the hub's trunk go with
 * their trailers, so the hub reconciles landings found there (T16) and
 * reports the rest as foreign; with externalPushes: pause, foreign commits
 * pause landing too. The first report (the hub knows no trunk) names no
 * commits: trunk's history before the queue isn't news.
 */
export async function scanTrunk(ctx: LanderContext, tip: string, control: LanderControl, policy: LandPolicy, land: LandConfig | null): Promise<ScanResult> {
  const from = control.trunk?.sha ?? null;
  const base = { lease: ctx.lease.auth(), from, to: tip, policy };
  if (from !== null && from !== tip && !(await descends(ctx, from, tip))) {
    const r = await hubWrite(ctx, 'trunk report', () => ctx.hub.reportTrunk({ ...base, lease: ctx.lease.auth(), commits: [], rewritten: true }));
    ctx.log(`trunk was rewritten: ${tip.slice(0, 12)} does not descend from ${from.slice(0, 12)}; landing is paused until an approver accepts a tip`);
    return { kind: 'rewritten', control: r.control };
  }
  const commits: TrunkReportRequest['commits'] = [];
  if (from !== null && from !== tip) {
    for (const t of await ctx.git.trunkTrailers(from, tip, REPORT_COMMITS)) {
      const files = await ctx.git.diffNames(`${t.sha}^`, t.sha).catch(() => [] as string[]);
      commits.push({ sha: t.sha, landing: t.landing, hub: t.hub, source: t.source, files: files.slice(0, 200) });
    }
  }
  const r = await hubWrite(ctx, 'trunk report', () => ctx.hub.reportTrunk({ ...base, lease: ctx.lease.auth(), commits, rewritten: false }));
  const prefix = `${ctx.project}/`;
  // The lander can't see the hub's landings here; a commit without this hub's identity trailers is foreign for sure.
  const foreign = commits.filter((c) => !(c.hub === ctx.lease.epoch && c.landing?.startsWith(prefix) && c.source)).map((c) => c.sha);
  if (foreign.length > 0 && land?.externalPushes === 'pause') {
    const detail = `${foreign.length} commit${foreign.length === 1 ? ' was' : 's were'} pushed to trunk outside the landing queue (${foreign
      .slice(0, 3)
      .map((s) => s.slice(0, 12))
      .join(', ')}${foreign.length > 3 ? ', …' : ''}), and land.externalPushes is pause: look at them, then hub lander resume`;
    const p = await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'external_push', detail }));
    return { kind: 'paused', control: p.control, foreign };
  }
  return { kind: 'ok', control: r.control, foreign };
}

/** Whether `a` is an ancestor of `b` (a commit the mirror doesn't have isn't). */
export async function descends(ctx: LanderContext, a: string, b: string): Promise<boolean> {
  if ((await ctx.git.revParse(a)) === null) return false;
  return ctx.git.isAncestor(a, b);
}

/**
 * At startup, before the loops: tell the hub where trunk is and trunk's
 * policy (claimGate, keepPlaceRetries, …), so admissions run under trunk's
 * policy rather than the hub's defaults, and landings found on trunk are
 * reconciled (T16). Reports always go out from the attempt loop's side only,
 * so two reports never race each other.
 */
export async function syncTrunk(ctx: LanderContext): Promise<void> {
  const { control } = await ctx.hub.lander();
  if (control.paused?.reason === 'trunk_rewritten') return;
  const fetched = await fetchTrunk(ctx, trunkLocalRef);
  if (fetched.kind !== 'ok') {
    ctx.log(`startup: can't fetch trunk (${fetched.detail})`);
    return;
  }
  const { config } = fetched;
  if (!config.ok) {
    ctx.log(`startup: ${config.error}; landing is paused (config_invalid)`);
    await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'config_invalid', detail: config.error }));
    await scanTrunk(ctx, fetched.tip, control, knownPolicy(control), null);
    return;
  }
  await scanTrunk(ctx, fetched.tip, control, policyOf(config.land), config.land);
}

/**
 * The idle trunk watch (design §2.2.1): ls-remote trunk; when it moved from
 * what the hub knows, fetch and report it (a push outside the queue, or a
 * rewrite). Returns the remote tip, or null when the remote can't be reached.
 */
export async function watchTrunk(ctx: LanderContext, control: LanderControl): Promise<string | null> {
  let tip: string | null;
  try {
    tip = await ctx.git.lsRemote(`refs/heads/${ctx.trunk.branch}`);
  } catch {
    return null;
  }
  if (tip === null || tip === control.trunk?.sha) return tip;
  const fetched = await fetchTrunk(ctx, trunkLocalRef);
  if (fetched.kind !== 'ok') return null;
  const { config } = fetched;
  if (!config.ok) {
    await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'config_invalid', detail: config.error }));
    await scanTrunk(ctx, fetched.tip, control, knownPolicy(control), null);
    return fetched.tip;
  }
  await scanTrunk(ctx, fetched.tip, control, policyOf(config.land), config.land);
  return fetched.tip;
}
