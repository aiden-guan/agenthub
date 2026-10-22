// Admission (design §2.2.4): submitted → queued | failed, seconds after
// `land`, so claim conflicts are reported and approvals requested at once.
// It runs while the attempt loop checks, and touches only the mirror's land
// refs and refs/agenthub/admit-trunk. The lander's own diff is authoritative:
// the agent's advisory files and scope are replaced by what base..commit
// really changes, and the hub re-makes the holds from it through the gate.

import { FULL_SHA_RE, landRef, type LandConfig } from '@agenthub/contract';
import type { Landing, LandingAdmitRequest, LandingFailureCode, LandingStatus } from '@agenthub/hub/protocol';
import { AttemptStale, hubWrite, type LanderContext } from './context.js';
import { failureReport, sendbackContext, tellIfFailed, tellSendback } from './messages.js';
import { protectedPaths, protectedRequirements } from './requirements.js';
import { ADMIT_TRUNK_REF, descends, fetchTrunk, localLandRef } from './trunk.js';
import { isHubError } from './ports.js';
import type { SendbackContext } from './report.js';

const LIVE: LandingStatus[] = ['submitted', 'queued', 'needs_approval', 'running'];
const TERMINAL_UNLANDED: LandingStatus[] = ['failed', 'cancelled', 'superseded'];
/** Landings looked at for containment: the live ones and this many recent terminal ones. */
const RECENT = 200;
const TEST_FILE_RE = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|test_[^/]*\.py)$/;

export function isLive(l: Pick<Landing, 'status'>): boolean {
  return LIVE.includes(l.status);
}

export type AdmitOutcome = 'admitted' | 'failed' | 'skipped';

export class Admission {
  constructor(private readonly ctx: LanderContext) {}

  /**
   * Admits every submitted landing, in queue order. Trunk is fetched once
   * per round; an invalid config on trunk pauses landing (config_invalid) and
   * admits nothing. Returns how many landings were admitted or failed.
   */
  async admitAll(signal?: AbortSignal): Promise<number> {
    const { ctx } = this;
    const submitted = (await ctx.hub.landings({ status: ['submitted'], limit: 100 })).filter((l) => l.status === 'submitted');
    if (submitted.length === 0) return 0;
    const trunk = await fetchTrunk(ctx, () => ADMIT_TRUNK_REF);
    if (trunk.kind !== 'ok') {
      ctx.log(`admission: can't fetch trunk (${trunk.detail}); trying again later`);
      return 0;
    }
    if (!trunk.config.ok) {
      const detail = trunk.config.error;
      ctx.log(`admission: ${detail}; landing is paused (config_invalid)`);
      await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'config_invalid', detail }));
      return 0;
    }
    const known = await this.knownLandings();
    let done = 0;
    for (const landing of submitted.sort((a, b) => (a.queue_seq ?? 0) - (b.queue_seq ?? 0))) {
      if (signal?.aborted || ctx.lease.signal.aborted) break;
      try {
        if ((await this.admitOne(landing, trunk.tip, trunk.config.land, known)) !== 'skipped') done++;
      } catch (err) {
        // It moved on meanwhile (cancelled, superseded, failed).
        if (err instanceof AttemptStale || isHubError(err, 'landing_closed', 'not_found')) continue;
        throw err;
      }
    }
    return done;
  }

  /** Live landings and recent terminal ones, for the containment rule. */
  private async knownLandings(): Promise<Landing[]> {
    const [live, ended] = await Promise.all([this.ctx.hub.landings({ status: LIVE, limit: 500 }), this.ctx.hub.landings({ status: TERMINAL_UNLANDED, limit: RECENT })]);
    return [...live, ...ended];
  }

  /** design §2.2.4 steps 1 to 7 for one landing; `trunk` is the fetched admit-trunk tip. */
  async admitOne(landing: Landing, trunk: string, land: LandConfig, known: Landing[]): Promise<AdmitOutcome> {
    const { ctx } = this;
    const H = landing.commit;
    if (!H || !FULL_SHA_RE.test(H)) return this.fail(landing, land, 'not_pushed', null, {});

    // 1. The land ref, and its tip.
    const f = await ctx.git.fetch([`+${landRef(land.refPrefix, H)}:${localLandRef(H)}`]);
    if (f.kind === 'error') {
      ctx.log(`admission of ${landing.id}: can't fetch its land ref (${f.detail}); trying again later`);
      return 'skipped';
    }
    if (f.kind === 'missing') return this.fail(landing, land, 'not_pushed', null, {}, 'the land ref is missing on the remote: push it again (call land)');
    const tip = await ctx.git.revParse(localLandRef(H));
    if (tip !== H) return this.fail(landing, land, 'not_pushed', null, {}, `the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at your commit ${H.slice(0, 12)}`);

    // 3. The change, against its landed base.
    let base: string;
    try {
      base = (await ctx.git.landedBase(trunk, H)).base;
    } catch (err) {
      return this.fail(landing, land, 'lander_error', null, {}, `the commit shares no history with ${ctx.trunk.branch}: ${(err as Error).message}`);
    }
    const changed = await ctx.git.diffNames(base, H);
    if (changed.length === 0 && !(await ctx.git.isAncestor(H, trunk))) return this.fail(landing, land, 'nothing_to_land', base, {});
    if (changed.length > land.maxFiles) return this.fail(landing, land, 'too_large', base, { files: changed.length, maxFiles: land.maxFiles });

    // 6. Containment: another landing's commit inside this one.
    const waits: Landing[] = [];
    for (const other of known) {
      if (other.id === landing.id || !other.commit || !FULL_SHA_RE.test(other.commit) || other.commit === H) continue;
      if (!(await descends(ctx, other.commit, H))) continue;
      if (await descends(ctx, other.commit, trunk)) continue; // already on trunk
      if (isLive(other)) waits.push(other);
      else if (other.status !== 'landed' && other.landed_with === null && other.agent !== landing.agent) {
        return this.fail(landing, land, 'contains_unlanded', base, { unlanded: { landingId: other.id, agent: other.agent } });
      }
      // The same agent's failed or superseded landing lands inside this one (also_landed, at the attempt).
    }
    const waitsFor = await this.nearest(waits);
    // 3. The holds (and `protected`) cover the whole change from its landed base: the agent's own files, the
    // stacked work below it included, never trunk's content a branch merged in by hand.
    const files = changed;

    // 5. Approvals for the protected paths the change touches. A stacked landing lands on top of the one it waits
    // for (its landed base becomes that commit, §1.1), whose own approval covers that part; asking again would
    // bind a requirement the hub enforces at pushing to content already approved (or already on trunk). So it
    // asks only for its own paths that also changed after that commit, digested from that commit, which is the
    // base P3 digests them from once that one has landed. Should it not land, P3 finds the rest and asks for
    // it then (§2.2.5 P3).
    const approvalBase = waitsFor?.commit ?? base;
    const approvalFiles = approvalBase === base ? files : intersect(files, await ctx.git.diffNames(approvalBase, H));
    const required = await protectedRequirements(ctx.git, land.protected, approvalFiles, approvalBase, H);

    // 7. Admit: the hub re-makes the holds through the claim gate.
    const req: LandingAdmitRequest = {
      lease: ctx.lease.auth(),
      base_sha: base,
      files,
      scope: null,
      mapper: null,
      protected: protectedPaths(files, land.protected),
      required,
      waits_for: waitsFor?.id ?? null,
      warnings: await this.warnings(base, H, files),
    };
    const r = await hubWrite(ctx, `admit ${landing.id}`, () => ctx.hub.admit(landing.id, { ...req, lease: ctx.lease.auth() }));
    await ctx.faults.at('after-admit', landing.id);
    if (r.landing.status === 'failed') {
      ctx.log(`${landing.id} failed admission: ${r.landing.failure?.code ?? 'failed'}`);
      await tellIfFailed(ctx, r, land);
      return 'failed';
    }
    ctx.log(`admitted ${landing.id} (${files.length} file${files.length === 1 ? '' : 's'}${req.waits_for ? `, waits for ${req.waits_for}` : ''}${required.length ? `, ${required.length} approval${required.length === 1 ? '' : 's'} pending` : ''})`);
    return 'admitted';
  }

  /** Of the live landings this one contains, the newest in the stack (the one whose commit contains the others'). */
  private async nearest(waits: Landing[]): Promise<Landing | null> {
    let best: Landing | null = null;
    for (const w of waits) if (best === null || (await descends(this.ctx, best.commit!, w.commit!))) best = w;
    return best;
  }

  /** design §4.1 #8: a landing that deletes test files, or removes more lines than it adds in them, is flagged. */
  private async warnings(base: string, head: string, files: string[]): Promise<string[]> {
    const tests = files.filter((f) => TEST_FILE_RE.test(f));
    if (tests.length === 0) return [];
    const out: string[] = [];
    const deleted: string[] = [];
    for (const f of tests) if ((await this.ctx.git.blobId(head, f)) === null) deleted.push(f);
    if (deleted.length > 0) out.push(`This change deletes test files: ${list(deleted)}. The checks no longer run them.`);
    const shrunk = (await this.ctx.git.numstat(base, head)).filter((s) => TEST_FILE_RE.test(s.path) && !deleted.includes(s.path) && s.removed > s.added);
    if (shrunk.length > 0) out.push(`This change removes more lines than it adds in test files: ${list(shrunk.map((s) => `${s.path} (-${s.removed} +${s.added})`))}.`);
    return out;
  }

  /** T3 through admit (amended at CP1a): the landing fails instead of being admitted, and the author is told. */
  private async fail(landing: Landing, land: LandConfig, code: LandingFailureCode, base: string | null, extra: Partial<SendbackContext>, why?: string): Promise<AdmitOutcome> {
    const { ctx } = this;
    const s = sendbackContext(ctx, landing, land, extra);
    const report = failureReport(code, s, why ? { warnings: [why] } : {});
    const r = await hubWrite(ctx, `admit ${landing.id}`, () =>
      ctx.hub.admit(landing.id, { lease: ctx.lease.auth(), base_sha: base as string, files: [], scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [], code, report }),
    );
    await ctx.faults.at('after-admit', landing.id);
    ctx.log(`${landing.id} failed admission: ${code}${why ? ` (${why})` : ''}`);
    if (!r.landing.failure || r.landing.status !== 'failed') return 'skipped';
    await tellSendback(ctx, r.landing, r.landing.failure.code, s);
    return 'failed';
  }
}

/** The items of `a` (in its order) that are also in `b`. */
function intersect(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  return a.filter((x) => inB.has(x));
}

function list(items: string[], n = 5): string {
  const shown = items.slice(0, n).map((s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'));
  return items.length > n ? `${shown.join(', ')} and ${items.length - n} more` : shown.join(', ');
}
