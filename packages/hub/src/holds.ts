import { HOLD_EXPIRES, overlappingEntries } from '@agenthub/contract';
import { capText, claimFiles, cleanText, toConflict, unique, type HubInternals } from './common.js';
import type { Claim, ClaimConflict, ClaimMode, Landing, ScopeEntry } from './protocol.js';
import type { ClaimPatch } from './store.js';

// Landing holds (design §1.6): the claim rows the hub keeps for a live
// landing, so the change being landed stays covered until it lands or comes
// back. At most two per landing, one exclusive and one shared. Every function
// here runs inside Hub.write.

const MAX_INTENT = 300;
const MODES: readonly ClaimMode[] = ['exclusive', 'shared'];

/** What a hold is made for: the landing's identity and what its intent is written from. */
export type HoldOwner = Pick<Landing, 'id' | 'agent' | 'task_id' | 'summary' | 'files'>;

export interface HoldPlan {
  /** The entries each hold row should have. */
  byMode: Record<ClaimMode, ScopeEntry[]>;
  /** Other agents' active claims in the way of an entry, with their overlapping entries. */
  conflicts: ClaimConflict[];
  /** The entries in conflict: refused with gate fail, left out with gate warn. */
  conflicting: ScopeEntry[];
}

export interface SetHoldsResult {
  /** False only when gate fail met a conflict: then nothing changed. */
  applied: boolean;
  /** The landing's hold rows as they are now, exclusive first. */
  holds: Claim[];
  conflicts: ClaimConflict[];
  /** Gate warn: the entries left out of the holds because of `conflicts`. */
  dropped: ScopeEntry[];
  /** Some entry is no longer held, or is held under another mapper: the caller runs promoteQueued once it has ended whatever else it ends. */
  trimmed: boolean;
}

/**
 * The entries a hold keeps: without a mapper symbols mean nothing, so every
 * entry is its whole file; a whole-file entry subsumes the symbol entries of
 * its file. Sorted by file, the whole file first, then by symbol.
 */
export function normalizeHoldEntries(entries: readonly ScopeEntry[], mapper: string | null): ScopeEntry[] {
  const whole = new Set(entries.filter((e) => e.symbol === undefined || mapper === null).map((e) => e.file));
  const seen = new Set<string>();
  const out: ScopeEntry[] = [];
  for (const e of entries) {
    const entry: ScopeEntry = whole.has(e.file) || e.symbol === undefined ? { file: e.file } : { file: e.file, symbol: e.symbol };
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort(compareEntries);
}

/**
 * Which hold each entry goes in, and what stands in the way (§1.6 steps 1-4),
 * without changing anything. `own`: the agent's claims the hold continues; an
 * entry their shared claim covered stays shared. Otherwise an entry is shared
 * when other agents hold overlapping claims and all of them are shared (the
 * Phase 1 auto rule), and exclusive when not. An exclusive entry conflicts
 * with any other active claim it overlaps, a shared one with an exclusive one.
 * Queued claims never stand in the way: the hold continues claims the agent
 * already had in the same transaction, so nobody is overtaken.
 */
export function planHolds(ix: HubInternals, project: string, agent: string, entries: readonly ScopeEntry[], mapper: string | null, own: readonly Claim[] = []): HoldPlan {
  const wanted = normalizeHoldEntries(entries, mapper);
  const others = ix.store.claimsForFiles(project, unique(wanted.map((e) => e.file)), ['active']).filter((c) => c.holder !== agent);
  const byMode: Record<ClaimMode, ScopeEntry[]> = { exclusive: [], shared: [] };
  const blocked = new Map<string, ScopeEntry[]>(); // other claim id -> the wanted entries it is in the way of
  const conflicting: ScopeEntry[] = [];
  for (const entry of wanted) {
    const one = { scope: [entry], mapper };
    const over = others.filter((c) => overlappingEntries(one, c).length > 0);
    const mine = own.filter((c) => overlappingEntries(one, c).length > 0);
    const ownMode: ClaimMode | null = mine.some((c) => c.mode === 'exclusive') ? 'exclusive' : mine.length > 0 ? 'shared' : null;
    const mode: ClaimMode = ownMode === 'shared' || (over.length > 0 && over.every((c) => c.mode === 'shared')) ? 'shared' : 'exclusive';
    const inTheWay = mode === 'exclusive' ? over : over.filter((c) => c.mode === 'exclusive');
    if (inTheWay.length === 0) {
      byMode[mode].push(entry);
      continue;
    }
    conflicting.push(entry);
    for (const c of inTheWay) (blocked.get(c.id) ?? blocked.set(c.id, []).get(c.id)!).push(entry);
  }
  // In the others' order (oldest claim first), each with its entries that overlap the conflicting ones.
  const conflicts = others.filter((c) => blocked.has(c.id)).map((c) => toConflict(c, [], overlappingEntries({ scope: blocked.get(c.id)!, mapper }, c)));
  return { byMode, conflicts, conflicting };
}

/**
 * Makes `landing`'s holds cover exactly `entries` (§1.6), less what the gate
 * leaves out. With gate fail, a conflict changes nothing (`applied: false`):
 * land answers 409 claim_conflict, admission fails the landing. With gate
 * warn, the conflicting entries are left out (`dropped`). Then each hold row
 * is created, rescoped in place or ended: a new hold emits claim.granted with
 * its landing_id, added entries claim.granted, removed entries a partial
 * claim.released. A row re-made under another mapper compares differently
 * from then on (design §1.10), so it emits claim.granted with all its entries
 * and the new mapper, and counts as trimmed: a waiter it blocked only at file
 * level may be free now.
 */
export function setHolds(
  ix: HubInternals,
  project: string,
  landing: HoldOwner,
  entries: readonly ScopeEntry[],
  mapper: string | null,
  gate: 'fail' | 'warn',
  now: number,
  opts: { own?: readonly Claim[] } = {},
): SetHoldsResult {
  const plan = planHolds(ix, project, landing.agent, entries, mapper, opts.own);
  const existing = ix.store.listClaims(project, { statuses: ['active'], landing_id: landing.id });
  if (gate === 'fail' && plan.conflicts.length > 0) {
    return { applied: false, holds: sortHolds(existing), conflicts: plan.conflicts, dropped: [], trimmed: false };
  }
  const intent = holdIntent(ix, project, landing);
  const holds: Claim[] = [];
  let trimmed = false;
  for (const mode of MODES) {
    const want = plan.byMode[mode];
    const rows = existing.filter((c) => c.mode === mode);
    if (want.length === 0) {
      for (const r of rows) ix.endClaim(project, r, 'released', `outside the change of ${landing.id}`, now);
      trimmed ||= rows.length > 0;
      continue;
    }
    // At most one row per mode: rows that holds moved from another landing brought along go into the first.
    const [row, ...extra] = rows;
    for (const x of extra) {
      ix.endClaim(project, x, 'released', `merged into ${row.id}`, now);
      trimmed = true;
    }
    if (!row) {
      holds.push(createHold(ix, project, landing, want, mode, mapper, intent, now));
      continue;
    }
    const removed = row.scope.filter((e) => !want.some((w) => sameEntry(w, e)));
    const added = want.filter((w) => !row.scope.some((e) => sameEntry(w, e)));
    const patch: ClaimPatch = {};
    if (removed.length > 0 || added.length > 0) patch.scope = want;
    if (row.mapper !== mapper) patch.mapper = mapper;
    if (row.intent !== intent) patch.intent = intent;
    if (row.task_id !== landing.task_id) patch.task_id = landing.task_id;
    if (Object.keys(patch).length > 0) ix.store.updateClaim(project, row.id, patch);
    const updated = { ...row, ...patch };
    if (removed.length > 0) {
      trimmed = true;
      const gone = unique(removed.map((e) => e.file)).filter((f) => !want.some((w) => w.file === f));
      ix.emit(project, 'claim.released', row.holder, { claim_id: row.id, holder: row.holder, files: gone, partial: true, landing_id: landing.id, scope: removed, mapper: row.mapper });
    }
    // Under a new mapper every entry is held anew: it overlaps other claims differently.
    const remapped = patch.mapper !== undefined;
    trimmed ||= remapped;
    const granted = remapped ? want : added;
    if (granted.length > 0) {
      ix.emit(project, 'claim.granted', row.holder, {
        claim_id: row.id,
        holder: row.holder,
        files: unique(granted.map((e) => e.file)),
        mode,
        intent: updated.intent,
        task_id: updated.task_id,
        landing_id: landing.id,
        scope: granted,
        mapper,
      });
    }
    holds.push(updated);
  }
  return { applied: true, holds, conflicts: plan.conflicts, dropped: gate === 'warn' ? plan.conflicting : [], trimmed };
}

/** Hands the holds of `from` (superseded) to `to`, which inherits its place: same rows, so nothing is released in between. */
export function moveHolds(ix: HubInternals, project: string, from: Pick<Landing, 'id'>, to: HoldOwner): Claim[] {
  const intent = holdIntent(ix, project, to);
  return ix.store.listClaims(project, { statuses: ['active'], landing_id: from.id }).map((c) => {
    const moved = { ...c, landing_id: to.id, intent, task_id: to.task_id };
    ix.store.updateClaim(project, c.id, { landing_id: to.id, intent, task_id: to.task_id });
    ix.emit(project, 'claim.granted', c.holder, {
      claim_id: c.id,
      holder: c.holder,
      files: claimFiles(c),
      mode: c.mode,
      intent,
      task_id: to.task_id,
      landing_id: to.id,
      scope: c.scope,
      mapper: c.mapper,
      moved_from: from.id,
    });
    return moved;
  });
}

/** Ends every hold of the landing (it landed). The caller runs promoteQueued. */
export function releaseHolds(ix: HubInternals, project: string, landingId: string, reason: string, now: number): Claim[] {
  return ix.store.listClaims(project, { statuses: ['active'], landing_id: landingId }).map((c) => ix.endClaim(project, c, 'released', reason, now));
}

/**
 * The landing came back (failed or cancelled): each hold becomes an ordinary
 * lease of its holder's again, for at least the send-back grace. A live
 * agent's heartbeats keep it (renewal never shortens a lease); an agent that
 * went away lets it lapse once the grace is over.
 */
export function holdsToLeases(ix: HubInternals, project: string, landingId: string, now: number, graceMin: number): Claim[] {
  return ix.store.listClaims(project, { statuses: ['active'], landing_id: landingId }).map((c) => {
    const expires_at = now + Math.max(c.ttl_ms, graceMin * 60_000);
    const intent = c.intent.replace(/^landing L-\d+: /, '') || c.intent;
    ix.store.updateClaim(project, c.id, { landing_id: null, expires_at, intent });
    ix.emit(project, 'claim.granted', c.holder, {
      claim_id: c.id,
      holder: c.holder,
      files: claimFiles(c),
      mode: c.mode,
      intent,
      task_id: c.task_id,
      landing_id: null,
      scope: c.scope,
      mapper: c.mapper,
      from_landing: landingId,
    });
    return { ...c, landing_id: null, expires_at, intent };
  });
}

/** `landing L-7: <task title, else the summary's first line, else the files>`. */
export function holdIntent(ix: HubInternals, project: string, landing: HoldOwner): string {
  const task = landing.task_id ? ix.store.getTask(project, landing.task_id) : null;
  const files = landing.files.length > 0 ? `edit ${landing.files.slice(0, 3).join(', ')}${landing.files.length > 3 ? ` and ${landing.files.length - 3} more` : ''}` : '';
  const what = task?.title || cleanText(landing.summary.split('\n')[0], MAX_INTENT) || files;
  return capText(what ? `landing ${landing.id}: ${what}` : `landing ${landing.id}`, MAX_INTENT);
}

function createHold(ix: HubInternals, project: string, landing: HoldOwner, scope: ScopeEntry[], mode: ClaimMode, mapper: string | null, intent: string, now: number): Claim {
  const ttl = ix.leaseTtlMs;
  const hold: Claim = {
    id: `C-${ix.store.nextCounter(project, 'claim')}`,
    project,
    holder: landing.agent,
    task_id: landing.task_id,
    scope,
    mode,
    intent,
    base_commit: null,
    status: 'active',
    created_at: now,
    granted_at: now,
    expires_at: HOLD_EXPIRES,
    // What it turns back into when the landing comes back.
    ttl_ms: ttl,
    heartbeat_interval_ms: Math.min(ix.heartbeatIntervalMs, Math.floor(ttl / 3)),
    ended_at: null,
    end_reason: null,
    landing_id: landing.id,
    mapper,
  };
  ix.store.insertClaim(hold);
  ix.emit(project, 'claim.granted', landing.agent, {
    claim_id: hold.id,
    holder: hold.holder,
    files: claimFiles(hold),
    mode,
    intent,
    task_id: hold.task_id,
    landing_id: landing.id,
    scope,
    mapper,
  });
  return hold;
}

function sortHolds(holds: Claim[]): Claim[] {
  return [...holds].sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
}

function entryKey(e: ScopeEntry): string {
  return `${e.file}\u0000${e.symbol ?? ''}`;
}

function sameEntry(a: ScopeEntry, b: ScopeEntry): boolean {
  return a.file === b.file && a.symbol === b.symbol;
}

function compareEntries(a: ScopeEntry, b: ScopeEntry): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.symbol === b.symbol) return 0;
  if (a.symbol === undefined) return -1;
  if (b.symbol === undefined) return 1;
  return a.symbol < b.symbol ? -1 : 1;
}
