// Garbage collection (design §2.2.7 "GC", §1.1 ref lifetimes), at start and
// hourly: forget dead check worktrees, drop old logs, and delete remote refs
// nobody needs any more. Refs of live landings are never deleted.
//
// - land refs: when every landing of that commit is terminal and ended more
//   than 1 h ago (a landed one's normally went with the trunk push);
// - candidate refs: a landed landing's at once, another terminal landing's
//   after 7 days;
// - orphans (no landing of this hub names them, another epoch's included):
//   once their commit's committer date is more than 24 h old.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Landing } from '@agenthub/hub/protocol';
import { bestEffort, type LanderContext } from './context.js';
import { isLive } from './admission.js';
import { localCandidateRef, readTrunkConfig, trunkLocalRef } from './trunk.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const LAND_REF_GRACE_MS = HOUR_MS;
export const CANDIDATE_GRACE_MS = 7 * DAY_MS;
export const ORPHAN_GRACE_MS = DAY_MS;
export const LOG_KEEP_MS = 7 * DAY_MS;

const LANDING_ID_RE = /^L-[1-9][0-9]*$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;

export interface GcResult {
  /** Remote refs deleted. */
  deleted: string[];
  /** Remote refs kept. */
  kept: string[];
  /** Log files removed. */
  logs: number;
}

export interface GcOptions {
  /** The lander's workdir (logs/); null skips the file part (the simulation). */
  workdir: string | null;
}

/** One GC pass; every part is best effort. */
export async function collectGarbage(ctx: LanderContext, o: GcOptions): Promise<GcResult> {
  const result: GcResult = { deleted: [], kept: [], logs: 0 };
  const now = ctx.clock.now();
  await bestEffort(ctx, 'git worktree prune', () => ctx.git.pruneWorktrees());
  if (o.workdir) result.logs = removeOldLogs(path.join(o.workdir, 'logs'), now);

  const tip = await ctx.git.revParse(trunkLocalRef(ctx.trunk.branch));
  const config = tip ? await readTrunkConfig(ctx.git, tip) : null;
  if (!config?.ok) return result;
  const P = config.land.refPrefix;

  let refs: Array<{ ref: string; sha: string }>;
  let landings: Landing[];
  try {
    [refs, landings] = await Promise.all([ctx.git.listRemoteRefs([`${P}land/*`, `${P}cand/*`]), ctx.hub.landings({ limit: 500 })]);
  } catch (err) {
    ctx.log(`gc: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  const byId = new Map<string, Landing | null>(landings.map((l) => [l.id, l]));
  const byCommit = new Map<string, Landing[]>();
  for (const l of landings) if (l.commit) byCommit.set(l.commit, [...(byCommit.get(l.commit) ?? []), l]);
  const epoch8 = ctx.lease.epoch.replace(/-/g, '').slice(0, 8);
  const landingOf = async (id: string): Promise<Landing | null> => {
    if (byId.has(id)) return byId.get(id) ?? null;
    const l = await ctx.hub.landing(id).catch(() => null);
    byId.set(id, l);
    return l;
  };

  for (const { ref, sha } of refs) {
    let drop = false;
    if (ref.startsWith(`${P}land/`)) {
      const owners = byCommit.get(ref.slice(`${P}land/`.length)) ?? [];
      if (owners.some(isLive)) drop = false;
      else if (owners.length > 0) drop = owners.every((l) => l.ended_at !== null && now - l.ended_at > LAND_REF_GRACE_MS);
      else drop = await orphanOld(ctx, ref, sha, now);
    } else {
      const [epoch, id] = ref.slice(`${P}cand/`.length).split('/');
      const landing = epoch === epoch8 && id && LANDING_ID_RE.test(id) ? await landingOf(id) : null;
      if (!landing) drop = await orphanOld(ctx, ref, sha, now);
      else if (isLive(landing)) drop = false;
      else if (landing.status === 'landed') drop = true;
      else drop = landing.ended_at !== null && now - landing.ended_at > CANDIDATE_GRACE_MS;
    }
    if (!drop) {
      result.kept.push(ref);
      continue;
    }
    const out = await ctx.git.pushRef({ prefix: P, sha: null, ref }).catch((err: unknown) => ({ kind: 'unknown' as const, detail: String(err) }));
    if (out.kind === 'ok' || out.kind === 'up_to_date') result.deleted.push(ref);
    else {
      ctx.log(`gc: deleting ${ref} failed (${'detail' in out ? out.detail : 'refused'})`);
      result.kept.push(ref);
    }
  }

  // The mirror's own copies: land refs of landings that aren't live, and fetched candidates.
  const live = new Set(landings.filter(isLive).map((l) => l.commit));
  for (const r of await ctx.git.localRefs('refs/agenthub/land/').catch(() => [])) {
    if (!live.has(r.ref.slice('refs/agenthub/land/'.length))) await bestEffort(ctx, `deleting ${r.ref}`, () => ctx.git.deleteLocalRef(r.ref));
  }
  for (const r of await ctx.git.localRefs('refs/agenthub/cand/').catch(() => [])) await bestEffort(ctx, `deleting ${r.ref}`, () => ctx.git.deleteLocalRef(r.ref));
  if (result.deleted.length > 0) ctx.log(`gc: deleted ${result.deleted.length} ref${result.deleted.length === 1 ? '' : 's'}`);
  return result;
}

/** An orphan ref is deleted once its commit's committer date is older than a day (the object is fetched if the mirror lacks it). */
async function orphanOld(ctx: LanderContext, ref: string, sha: string, now: number): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false;
  let at = await ctx.git.committedAt(sha);
  if (at === null) {
    const local = ref.includes('/cand/') ? localCandidateRef(ref) : `refs/agenthub/land/${sha}`;
    if (!local) return false;
    if ((await ctx.git.fetch([`+${ref}:${local}`]).catch(() => ({ kind: 'error' as const }))).kind !== 'ok') return false;
    at = await ctx.git.committedAt(sha);
  }
  return at !== null && now - at > ORPHAN_GRACE_MS;
}

function removeOldLogs(dir: string, now: number): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > LOG_KEEP_MS) {
        rmSync(p, { force: true });
        n++;
      }
    } catch {
      // gone meanwhile
    }
  }
  return n;
}
