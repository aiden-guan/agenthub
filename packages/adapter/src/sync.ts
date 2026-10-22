// Workspace sync (design §2.3.5): bring an agent's worktree up to the latest
// trunk, safe by construction. The new history is computed in the object
// database first (gitops.replay); the worktree changes in exactly one step, a
// `git reset --keep`, behind a HEAD compare-and-swap, a write-ahead record
// (sync.json) and a backup ref of the old tip. It never runs on dirty tracked
// files, never while an edit hook has an edit in flight, and never while one
// of the agent's own landings whose commits it would replay is in the queue.
// There is no reset --hard, checkout -f, clean, push or stash here (only `git stash
// create`, which writes no refs and changes nothing, to forecast conflicts).
//
// Its files live under the worktree's own git dir, G = gitDir(root):
//   G/agenthub/sync.lock            {pid, at}, linked into place (O_EXCL); stale after 120 s or when its pid is dead
//   G/agenthub/sync.json            the write-ahead record {pid, orig_head, target, branch, backup_ref, at}
//   G/agenthub/inflight/<s>~<tool>  one marker per edit tool call the pre-edit hook let through
//   G/agenthub/edits/<s>~<tool>     beside each marker of a symbol-level edit: the file before it and the
//                                   simulated result (Phase 3), for post-edit's check; it goes with its marker
//   G/agenthub/mergebase            the merge base of (HEAD, trunk), cached for the stale-base heads-up
//   G/agenthub/stale-shown          (session, file, trunk) heads-ups already given
//   G/agenthub/sync-said            the last notice settle printed, so an unchanged state isn't repeated
//   G/agenthub/elsewhere/<s>~<hash> where this session's edits in other checkouts have markers, for settle

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import path from 'node:path';
import { gitops, GitError, type Git } from '@agenthub/gitops';
import type { LandConfig } from '@agenthub/contract';
import type { Landing } from '@agenthub/hub/protocol';
import { HubClient, classifyFailure } from './client.js';
import { AGENT_ID_RE, teamSections, type HubConfig } from './config.js';
import { fullHead, git as gitSync, gitDir, gitOperation } from './git.js';

/** A lock (or a write-ahead record) this old is abandoned even if a process with its pid runs: no sync takes this long. */
export const LOCK_STALE_MS = 120_000;
/** An edit marker this old is stale: its tool call is long over. */
export const MARKER_STALE_MS = 30 * 60_000;
/** The safe-point syncs in the hooks (digest, settle) stop before changing anything once this is spent. */
export const HOOK_SYNC_BUDGET_MS = 12_000;
/** hub_sync and `hub sync`: well under LOCK_STALE_MS, so a running sync's lock is never taken for stale. */
const EXPLICIT_BUDGET_MS = 90_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Time kept back for the write-ahead, the reset and the verify, which always run to the end once begun. */
const APPLY_RESERVE_MS = 2_000;
/** The hub's answer (step 5) leaves this much more for the plan, so a hub that never answers still lets a fast-forward through. */
const PLAN_RESERVE_MS = 1_000;
const BACKUP_PREFIX = 'refs/agenthub/backup/';
const BACKUP_KEEP_MS = 14 * 24 * 60 * 60_000;

// ------------------------------------------------------------------ files under G/agenthub

export interface SyncPaths {
  dir: string;
  lock: string;
  record: string;
  inflight: string;
  mergebase: string;
  staleShown: string;
  said: string;
  elsewhere: string;
  /** The saved edit states (symbol-scope edits, Phase 3), one beside each marker, under the same name. */
  edits: string;
}

/** Where this worktree's sync files live, or null outside a git checkout. */
export function syncPaths(root: string): SyncPaths | null {
  const g = gitDir(root);
  if (!g) return null;
  const dir = path.join(g, 'agenthub');
  return {
    dir,
    lock: path.join(dir, 'sync.lock'),
    record: path.join(dir, 'sync.json'),
    inflight: path.join(dir, 'inflight'),
    mergebase: path.join(dir, 'mergebase'),
    staleShown: path.join(dir, 'stale-shown'),
    said: path.join(dir, 'sync-said'),
    elsewhere: path.join(dir, 'elsewhere'),
    edits: path.join(dir, 'edits'),
  };
}

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || '_';

/** The file name of an edit call's marker, and of the edit state saved beside it. */
export function markerName(call: { session: string; tool: string }): string {
  return `${safe(call.session)}~${safe(call.tool)}`;
}

/** The edit state saved beside a marker (same name, in the sibling `edits` directory). */
function editStateOf(marker: string): string {
  return path.join(path.dirname(path.dirname(marker)), 'edits', path.basename(marker));
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Whether a process with this pid runs (EPERM: it does, as another user). Never pid 0 or below, which name process groups. */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Owner {
  pid: number;
  at: number;
}

/** A lock or record whose process still runs and that isn't older than LOCK_STALE_MS. */
function ownerLive(o: Partial<Owner> | null, now = Date.now()): boolean {
  return !!o && pidAlive(o.pid) && typeof o.at === 'number' && now - o.at < LOCK_STALE_MS;
}

/**
 * The lock as written. One whose contents can't be read as an owner (another
 * adapter's lock created but not yet written, or a damaged one) names no pid,
 * so it counts by its file time alone: held until LOCK_STALE_MS after it was
 * written, never taken for abandoned at once.
 */
function readOwner(file: string): { owner: Partial<Owner>; raw: string; unreadable: boolean } | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const owner = JSON.parse(raw) as Partial<Owner>;
    if (owner && typeof owner === 'object' && typeof owner.pid === 'number' && typeof owner.at === 'number') return { owner, raw, unreadable: false };
  } catch {
    // below
  }
  let at = Date.now();
  try {
    at = statSync(file).mtimeMs;
  } catch {
    // gone meanwhile: then it counts as just written
  }
  return { owner: { at }, raw, unreadable: true };
}

function lockLive(o: { owner: Partial<Owner>; unreadable: boolean }, now = Date.now()): boolean {
  return o.unreadable ? now - (o.owner.at ?? now) < LOCK_STALE_MS : ownerLive(o.owner, now);
}

/** Whether a sync holds this worktree's lock right now. */
export function lockHeld(p: SyncPaths): boolean {
  const o = readOwner(p.lock);
  return !!o && lockLive(o);
}

/**
 * Take the lock; a stale one is moved aside first. False when a live sync
 * holds it. The lock is written in full under a temporary name and then
 * hard-linked into place: link fails when the lock exists, as O_EXCL does,
 * and no other process ever sees it half-written.
 */
function takeLock(p: SyncPaths): boolean {
  mkdirSync(p.dir, { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  const tmp = `${p.lock}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, body);
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(tmp, p.lock);
        pruneLitter(p);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          // A file system without hard links: create it with O_EXCL instead (it may then be seen empty for an instant).
          if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err;
          try {
            writeFileSync(p.lock, body, { flag: 'wx' });
            return true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
        }
      }
      const seen = readOwner(p.lock);
      if (!seen) continue; // released meanwhile
      if (lockLive(seen)) return false;
      breakStale(p.lock, seen.raw);
    }
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Temporary files of syncs that died while writing one (older than LOCK_STALE_MS): the lock holder sweeps them. */
function pruneLitter(p: SyncPaths): void {
  try {
    const cutoff = Date.now() - LOCK_STALE_MS;
    for (const name of readdirSync(p.dir)) {
      if (!/^sync\.(?:lock|json)\..+\.tmp$|^sync\.lock\.stale-/.test(name)) continue;
      const file = path.join(p.dir, name);
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    }
  } catch {
    // housekeeping only
  }
}

/**
 * Move a stale lock aside. Renaming is atomic, so of two processes breaking
 * the same stale lock one moves it; if what was moved isn't the stale lock
 * read (another process had replaced it), it is put back.
 */
function breakStale(lock: string, raw: string): void {
  const grave = `${lock}.stale-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    renameSync(lock, grave);
  } catch {
    return; // gone already
  }
  let moved = '';
  try {
    moved = readFileSync(grave, 'utf8');
  } catch {
    // unreadable: it was the stale one
  }
  if (moved !== raw) {
    try {
      linkSync(grave, lock); // back where it was, unless a new lock is there already
    } catch {
      // someone holds a newer lock: theirs stands
    }
  }
  rmSync(grave, { force: true });
}

function releaseLock(p: SyncPaths): void {
  const o = readOwner(p.lock);
  if (o && o.owner.pid === process.pid) rmSync(p.lock, { force: true });
}

// ------------------------------------------------------------------ the write-ahead record

export interface SyncRecord {
  /** The syncing process; 0 once it gave up on the record itself (needs_human), so the record is abandoned at once. */
  pid: number;
  orig_head: string;
  target: string;
  branch: string;
  backup_ref: string;
  at: number;
}

export function readRecord(p: SyncPaths): SyncRecord | null {
  const r = readJson<SyncRecord>(p.record);
  return r && typeof r.orig_head === 'string' && typeof r.target === 'string' ? r : null;
}

/** A record whose sync is over without having cleared it: it crashed (or gave up) between the write-ahead and the verify. */
export function interruptedSync(p: SyncPaths): SyncRecord | null {
  const r = readRecord(p);
  return r && !ownerLive(r) ? r : null;
}

/** Written and flushed before anything else of the sync happens to the worktree or its refs. */
function writeRecord(p: SyncPaths, r: SyncRecord): void {
  mkdirSync(p.dir, { recursive: true });
  const tmp = `${p.record}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(r));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p.record);
}

function clearRecord(p: SyncPaths): void {
  rmSync(p.record, { force: true });
}

// ------------------------------------------------------------------ edit markers and the edit gate

/** One edit tool call: which session, agent thread (main or a subagent) and tool_use_id. */
export interface EditCall {
  session: string;
  thread: string;
  tool: string | null;
}

interface Marker extends EditCall {
  pid: number;
  at: number;
}

/** Write the in-flight marker of an edit tool call; its path, or null where it can't be written (no git dir). */
export function writeMarker(p: SyncPaths, call: EditCall): string | null {
  try {
    mkdirSync(p.inflight, { recursive: true });
    const file = path.join(p.inflight, markerName({ session: call.session, tool: call.tool ?? `call-${process.pid}-${randomBytes(4).toString('hex')}` }));
    const m: Marker = { ...call, pid: process.pid, at: Date.now() };
    writeFileSync(file, JSON.stringify(m));
    return file;
  } catch {
    return null;
  }
}

export function removeMarker(file: string | null): void {
  if (!file) return;
  rmSync(file, { force: true });
  rmSync(editStateOf(file), { force: true });
}

/**
 * Remove the markers of the tool calls a hook confirms or settles: one call
 * (`tool`), a thread's (`thread`), or the whole session's. Returns how many.
 */
export function clearMarkers(p: Pick<SyncPaths, 'inflight'>, match: { session: string; thread?: string; tool?: string }): number {
  let names: string[];
  try {
    names = readdirSync(p.inflight);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const file = path.join(p.inflight, name);
    const m = readJson<Partial<Marker>>(file);
    if (!m || m.session !== match.session) continue;
    if (match.tool !== undefined && m.tool !== match.tool) continue;
    if (match.thread !== undefined && m.thread !== match.thread) continue;
    removeMarker(file);
    n++;
  }
  return n;
}

/** A marker directory: `<git dir>/agenthub/inflight`, and nothing else. */
const isInflightDir = (dir: unknown): dir is string => typeof dir === 'string' && path.isAbsolute(dir) && dir.endsWith(`${path.sep}agenthub${path.sep}inflight`);

/**
 * Note, in the session's own checkout (`p`), that an edit of the session has
 * a marker in another checkout's `inflight` directory (a file in another
 * worktree or repository): settle looks in the session's checkouts only, and
 * clears the markers there too (clearMarkersElsewhere). Best effort.
 */
export function noteMarkerElsewhere(p: SyncPaths, session: string, inflight: string): void {
  if (!isInflightDir(inflight) || path.resolve(inflight) === path.resolve(p.inflight)) return;
  try {
    mkdirSync(p.elsewhere, { recursive: true });
    const file = path.join(p.elsewhere, `${safe(session)}~${createHash('sha256').update(inflight).digest('hex').slice(0, 16)}`);
    writeFileSync(file, JSON.stringify({ session, inflight })); // rewritten each time: its age is the last edit's
  } catch {
    // then that marker goes stale in MARKER_STALE_MS, or post-edit removes it
  }
}

/**
 * Clear the markers that match in the other checkouts noted for this session
 * (see noteMarkerElsewhere), skipping `done` (inflight directories already
 * cleared); for the whole session the notes go too. Returns how many markers.
 */
export function clearMarkersElsewhere(p: SyncPaths, match: { session: string; thread?: string }, done: Set<string> = new Set()): number {
  let names: string[];
  try {
    names = readdirSync(p.elsewhere);
  } catch {
    return 0;
  }
  let n = 0;
  const now = Date.now();
  for (const name of names) {
    const file = path.join(p.elsewhere, name);
    const note = readJson<{ session?: unknown; inflight?: unknown }>(file);
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue; // removed meanwhile
    }
    if (!note || !isInflightDir(note.inflight)) {
      rmSync(file, { force: true });
      continue;
    }
    if (note.session === match.session) {
      if (!done.has(note.inflight)) {
        done.add(note.inflight);
        n += clearMarkers({ inflight: note.inflight }, match);
      }
      if (match.thread === undefined || now - mtime >= MARKER_STALE_MS) rmSync(file, { force: true });
    } else if (now - mtime >= MARKER_STALE_MS) rmSync(file, { force: true }); // its markers are stale by now
  }
  return n;
}

/** Markers of edits that may be in flight (younger than MARKER_STALE_MS); stale ones are removed. */
export function liveMarkers(p: SyncPaths, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(p.inflight);
  } catch {
    return [];
  }
  const live: string[] = [];
  for (const name of names) {
    const file = path.join(p.inflight, name);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue; // removed meanwhile
    }
    if (now - mtime < MARKER_STALE_MS) live.push(name);
    else removeMarker(file);
  }
  return live;
}

export type EditGate =
  | { ok: true; marker: string | null }
  /** `syncing`: a sync holds the lock (after waiting and one retry); `recovering`: a sync was interrupted (sync.json is left). */
  | { ok: false; reason: 'syncing' | 'recovering'; record?: SyncRecord };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The pre-edit side of the edit/sync exclusion (design §2.3.5, Dekker
 * ordering): write this call's marker first, then look at the lock. A sync
 * takes the lock first, then looks for markers, so at least one of them
 * backs off. With the lock held, the marker goes, the hook waits up to
 * `waitMs` for the sync to finish, and tries once more.
 */
export async function enterEdit(root: string, call: EditCall, o: { waitMs?: number; pollMs?: number } = {}): Promise<EditGate> {
  const p = syncPaths(root);
  if (!p) return { ok: true, marker: null };
  const waitMs = o.waitMs ?? 3000;
  const pollMs = o.pollMs ?? 100;
  const active = () => lockHeld(p) || ownerLive(readRecord(p));
  liveMarkers(p); // markers of calls long over (a session that crashed) go
  for (let attempt = 0; attempt < 2; attempt++) {
    const marker = writeMarker(p, call);
    if (!active()) {
      const record = interruptedSync(p);
      if (record) {
        removeMarker(marker);
        return { ok: false, reason: 'recovering', record };
      }
      return { ok: true, marker };
    }
    removeMarker(marker);
    if (attempt === 1) break;
    const until = Date.now() + waitMs;
    while (active() && Date.now() < until) await sleep(pollMs);
    if (active()) break;
  }
  return { ok: false, reason: 'syncing' };
}

// ------------------------------------------------------------------ the engine

export type SyncSkipReason =
  /** No land section on trunk: there is no queue, and no trunk to sync to. */
  | 'no_queue'
  /** Another sync holds the lock. */
  | 'sync_running'
  | 'edit_in_flight'
  | 'fetch_failed'
  | 'git_operation'
  | 'detached_head'
  | 'landing_in_flight'
  | 'hub_unavailable'
  | 'lander_paused'
  | 'merges_in_branch'
  /** HEAD or the tracked files changed while the sync was being prepared, untracked or ignored files are where the target has files (`paths`), or git reset --keep refused. */
  | 'changed_meanwhile'
  | 'timeout'
  /** git older than 2.40 (no merge-tree --merge-base): only fast-forwards and fully landed branches move (design §4.5). `detail`: git's version. */
  | 'old_git'
  /** Merge mode: uncommitted tracked changes. */
  | 'dirty'
  /** Merge mode: git merge refused to start (an untracked file it would overwrite), or untracked or ignored files are where the merge has files (`paths`); nothing changed. */
  | 'merge_refused';

/** Where trunk is: its branch name and the sha the sync compared against. */
interface At {
  trunk: string;
  remote: string;
  tip: string;
}

export type SyncOutcome =
  | ({ kind: 'up_to_date' } & At)
  | ({
      kind: 'synced';
      from: string;
      to: string;
      /** Unlanded commits of the branch replayed onto trunk (0: a fast-forward, or everything had landed). */
      replayed: number;
      /** Landings (L-n) now in HEAD that weren't. */
      landings: string[];
      /** First-parent trunk commits that came in (landings and commits pushed outside the queue). */
      commits: number;
      files: string[];
      backup_ref: string;
      undo: string;
    } & At)
  /** `conflicts`: the forecast, or null when this git can't make one (older than 2.40). */
  | ({ kind: 'behind_dirty'; behind: number; landings: string[]; conflicts: string[] | null; uncommitted: string[] } & At)
  | ({ kind: 'conflict'; commit: string; files: string[]; behind: number; landings: string[] } & At)
  | ({ kind: 'merged'; from: string; to: string; files: string[]; behind: number; landings: string[] } & At)
  | ({ kind: 'merge_conflict'; files: string[]; behind: number; landings: string[] } & At)
  /** A sync was interrupted and HEAD is neither its old tip nor its target: nothing is touched. `cleared`: `hub sync --recover` cleared the record. */
  | { kind: 'needs_human'; head: string | null; orig_head: string; target: string; backup_ref: string; cleared: boolean }
  /** `paths` (changed_meanwhile, merge_refused): the untracked or ignored files and directories (`dir/`) where the target has files. */
  | { kind: 'skipped'; reason: SyncSkipReason; detail: string | null; trunk: string | null; paths?: string[] };

/** The outcome, and what recovery found of an interrupted sync before it: nothing had happened, or it had finished. */
export type SyncResult = SyncOutcome & { recovered?: 'unapplied' | 'finished' };

export interface SyncOptions {
  /** Which safe point runs it: SessionStart (digest), UserPromptSubmit (settle), or hub_sync / `hub sync`. */
  reason: 'session_start' | 'prompt' | 'explicit';
  /** `update` (default): the sync engine. `merge`: git merge --no-edit <remote>/<trunk>, conflicts left for the agent. */
  mode?: 'update' | 'merge';
  /** Steps that change nothing stop (skipped: timeout) once this is spent; begun changes always finish. */
  budgetMs?: number;
  /** `hub sync --recover`: a human clears an interrupted sync's record that needs one (needs_human). */
  recover?: boolean;
}

/** Test faults (NODE_ENV=test only): AGENTHUB_SYNC_FAULT=after-write-ahead|after-reset kills the process there. */
function fault(point: 'after-write-ahead' | 'after-reset'): void {
  if (process.env.NODE_ENV === 'test' && process.env.AGENTHUB_SYNC_FAULT === point) process.kill(process.pid, 'SIGKILL');
}

const skipped = (reason: SyncSkipReason, detail: string | null = null, trunk: string | null = null): SyncOutcome => ({ kind: 'skipped', reason, detail, trunk });

/**
 * `syncWorkspace` (design §2.3.5), steps 0 to 10:
 * recover, lock, markers, fetch, git operation, own landings in flight, the
 * dirty forecast, the plan, the write-ahead, the CAS apply, verify.
 * The recovery (step 0) runs once the lock is taken: only the lock holder
 * writes a record, so no sync can clear the record of one that is running.
 */
export async function syncWorkspace(root: string, cfg: HubConfig, client: HubClient, opts: SyncOptions): Promise<SyncResult> {
  const deadline = Date.now() + (opts.budgetMs ?? EXPLICIT_BUDGET_MS);
  const left = () => deadline - Date.now();
  const p = syncPaths(root);
  if (!p) throw new Error(`${root} is not a git checkout`);
  const g = gitops.open(root, { isolated: false });
  const land = teamSections(root, { strict: false }).sections.land;

  // 1. Lock: the sync side of the exclusion.
  if (!takeLock(p)) return skipped('sync_running', null, land?.trunk ?? null);
  try {
    // 0. Recover an interrupted sync: nothing is ever undone here, a record is only cleared.
    let recovered: SyncResult['recovered'];
    const record = readRecord(p);
    if (record) {
      if (ownerLive(record)) return skipped('sync_running', null, land?.trunk ?? null); // a sync whose lock was taken for stale still runs
      const head = fullHead(root);
      if (head === record.orig_head) recovered = 'unapplied';
      else if (head === record.target) recovered = 'finished';
      else {
        if (opts.recover) clearRecord(p);
        return { kind: 'needs_human', head, orig_head: record.orig_head, target: record.target, backup_ref: record.backup_ref, cleared: !!opts.recover };
      }
      clearRecord(p);
    }
    const done = (o: SyncOutcome): SyncResult => (recovered ? { ...o, recovered } : o);
    if (!land) return done(skipped('no_queue'));

    // 2. Markers.
    const markers = liveMarkers(p);
    if (markers.length) return done(skipped('edit_in_flight', `${markers.length}`, land.trunk));
    return done(await (opts.mode === 'merge' ? mergeTrunk : updateToTrunk)({ root, cfg, client, g, p, land, left }));
  } finally {
    releaseLock(p);
  }
}

interface Ctx {
  root: string;
  cfg: HubConfig;
  client: HubClient;
  g: Git;
  p: SyncPaths;
  land: LandConfig;
  left: () => number;
}

/** What both modes check before deciding anything: trunk fetched, no git operation, a branch, and the agent's own landings. */
async function prepare(c: Ctx): Promise<
  | { ok: false; outcome: SyncOutcome }
  | { ok: true; at: At; head: string; branch: string; hub: { ok: true; paused: string | null } | { ok: false; error: string } }
> {
  const { root, g, land } = c;
  const no = (reason: SyncSkipReason, detail: string | null = null) => ({ ok: false as const, outcome: skipped(reason, detail, land.trunk) });
  // 3. Fetch trunk into its remote-tracking ref, which is always safe to update.
  if (c.left() < APPLY_RESERVE_MS) return no('timeout');
  const fetchError = await fetchTrunk(g, land.remote, land.trunk, Math.min(FETCH_TIMEOUT_MS, c.left() - APPLY_RESERVE_MS));
  if (fetchError) return no('fetch_failed', fetchError);
  const tip = await gitops.revParse(g, `refs/remotes/${land.remote}/${land.trunk}`);
  if (!tip) return no('fetch_failed', `${land.remote} has no branch ${land.trunk}`);
  const at: At = { trunk: land.trunk, remote: land.remote, tip };

  // 4. A git operation in progress, or no branch to move.
  const op = gitOperation(root);
  if (op) return no('git_operation', op);
  const branch = gitSync(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return no('detached_head');
  const head = fullHead(root);
  if (!head) throw new Error(`branch ${branch} has no commits yet, so there is nothing to sync`);

  // 5. Own live landings whose commit HEAD contains: replaying those commits would duplicate them under new shas.
  if (c.left() < APPLY_RESERVE_MS) return no('timeout');
  const hub = await hubState(c);
  if (hub.ok) {
    for (const l of hub.mine) {
      if (l.commit && (await containsCommit(g, l.commit, head))) return no('landing_in_flight', l.id);
    }
  }
  return { ok: true, at, head, branch, hub: hub.ok ? { ok: true, paused: hub.paused } : hub };
}

async function updateToTrunk(c: Ctx): Promise<SyncOutcome> {
  const { root, g, p, land } = c;
  const prep = await prepare(c);
  if (!prep.ok) return prep.outcome;
  const { at, head, branch, hub } = prep;
  const no = (reason: SyncSkipReason, detail: string | null = null) => skipped(reason, detail, land.trunk);

  // 6. Up to date (whatever the worktree holds), else dirty: forecast, touch nothing.
  if (await gitops.isAncestor(g, at.tip, head)) return { kind: 'up_to_date', ...at };
  const incoming = await incomingOf(c, head, at.tip);
  const uncommitted = await trackedChanges(g);
  if (uncommitted.length) {
    let conflicts: string[] | null = null;
    if (await mergeTreeBase(g)) {
      const work = await gitops.stashCreate(g);
      const base = (await gitops.landedBase(g, at.tip, head)).base;
      conflicts = await gitops.forecastConflicts(g, at.tip, work ?? head, base);
    }
    return { kind: 'behind_dirty', ...at, behind: incoming.commits, landings: incoming.landings, conflicts, uncommitted };
  }

  // 7. The plan, in the object database only.
  let target: string;
  let replayed = 0;
  if (await gitops.isAncestor(g, head, at.tip)) target = at.tip;
  else {
    if (!hub.ok) return no('hub_unavailable', hub.error);
    const base = (await gitops.landedBase(g, at.tip, head)).base;
    const commits = (await g.run(['rev-list', '--reverse', '--first-parent', `${base}..${head}`])).stdout.split('\n').filter(Boolean);
    if (commits.length === 0) target = at.tip; // everything on the branch has landed
    else {
      if (hub.paused) return no('lander_paused', hub.paused);
      // Old git: fast-forward only, and say so (design §4.5).
      if (!(await mergeTreeBase(g))) return no('old_git', await gitVersion(g));
      // Unsigned: a signing prompt (commit.gpgSign) would hang a hook; the originals stay in the backup ref, and the lander squashes them anyway.
      const r = await gitops.replay(g.with({ 'commit.gpgSign': 'false' }), commits, at.tip);
      if (r.kind === 'merges') return no('merges_in_branch', r.commit);
      if (r.kind === 'conflict') return { kind: 'conflict', ...at, commit: r.commit, files: r.files, behind: incoming.commits, landings: incoming.landings };
      target = r.tip;
      replayed = commits.length;
    }
  }
  if (c.left() < APPLY_RESERVE_MS) return no('timeout');

  // 8. Write-ahead: the record, then the backup ref of the old tip.
  const ms = Date.now();
  const backup = `${BACKUP_PREFIX}${branch}/${ms}`;
  writeRecord(p, { pid: process.pid, orig_head: head, target, branch, backup_ref: backup, at: ms });
  let applied: { ok: true } | { ok: false; detail: string; paths?: string[] };
  try {
    await g.run(['update-ref', '-m', 'agenthub sync: backup before moving the branch', backup, head]);
    fault('after-write-ahead');
    // 9. Apply behind a compare-and-swap: HEAD still the old tip and the tracked files still clean.
    if (fullHead(root) !== head) applied = { ok: false, detail: 'HEAD moved while the sync was being prepared' };
    else if ((await trackedChanges(g)).length) applied = { ok: false, detail: 'tracked files changed while the sync was being prepared' };
    else {
      // --keep refuses, changing nothing, rather than overwrite a modified tracked file or an untracked one the target
      // adds, but it overwrites an ignored file and removes an ignored directory in the way: those are checked first.
      const blocking = await inTheWay(g, root, head, target);
      if (blocking.length) applied = { ok: false, detail: `untracked or ignored files in the way: ${capped(blocking)}`, paths: blocking };
      else {
        const r = await g.run(['reset', '--quiet', '--keep', target], { ok: [0, 1, 128] });
        applied = r.code === 0 ? { ok: true } : { ok: false, detail: firstLine(`${r.stderr}\n${r.stdout}`) || `git reset --keep exited ${r.code}` };
      }
    }
    fault('after-reset');
  } catch (err) {
    applied = { ok: false, detail: err instanceof GitError ? firstLine(err.stderr) || err.message : (err as Error).message };
  }

  // 10. Verify.
  const now = fullHead(root);
  if (applied.ok && now === target) {
    clearRecord(p);
    await pruneBackups(g, ms);
    const files = await gitops.diffNames(g, head, target).catch(() => [] as string[]);
    return { kind: 'synced', ...at, from: head, to: target, replayed, landings: incoming.landings, commits: incoming.commits, files, backup_ref: backup, undo: `git reset --keep ${backup}` };
  }
  if (now === head) {
    clearRecord(p);
    await g.run(['update-ref', '-d', backup, head], { ok: [0, 1, 128] });
    const out = { kind: 'skipped' as const, reason: 'changed_meanwhile' as const, detail: applied.ok ? 'HEAD did not move' : applied.detail, trunk: land.trunk };
    return !applied.ok && applied.paths ? { ...out, paths: applied.paths } : out;
  }
  // Neither: leave the record (abandoned, so pre-edit stops edits until hub_sync or a human looks).
  writeRecord(p, { pid: 0, orig_head: head, target, branch, backup_ref: backup, at: ms });
  return { kind: 'needs_human', head: now, orig_head: head, target, backup_ref: backup, cleared: false };
}

/** hub_sync {mode: 'merge'}: merge trunk into the branch, leaving conflict markers for the agent to resolve. */
async function mergeTrunk(c: Ctx): Promise<SyncOutcome> {
  const { root, g, land } = c;
  const prep = await prepare(c);
  if (!prep.ok) return prep.outcome;
  const { at, head, hub } = prep;
  const no = (reason: SyncSkipReason, detail: string | null = null) => skipped(reason, detail, land.trunk);
  if (!hub.ok) return no('hub_unavailable', hub.error);
  const uncommitted = await trackedChanges(g);
  if (uncommitted.length) return no('dirty', uncommitted.join(', '));
  if (await gitops.isAncestor(g, at.tip, head)) return { kind: 'up_to_date', ...at };
  const incoming = await incomingOf(c, head, at.tip);
  // git merge overwrites ignored files (an ort merge does even with --no-overwrite-ignore, in git 2.43): refuse
  // first when any is where the merge result (or trunk) has a file. Residual: one written between here and the merge.
  const blocking = await mergeInTheWay(g, root, head, at.tip);
  if (blocking.length) {
    return { kind: 'skipped', reason: 'merge_refused', detail: `untracked or ignored files in the way: ${capped(blocking)}`, trunk: land.trunk, paths: blocking };
  }
  // --no-overwrite-ignore: git merge refuses, as for an untracked file, rather than overwrite an ignored one.
  const r = await g.run(['merge', '--no-edit', '--no-overwrite-ignore', `refs/remotes/${land.remote}/${land.trunk}`], { ok: [0, 1, 2, 128], timeoutMs: 120_000 });
  const now = fullHead(root);
  if (r.code === 0 && now && now !== head) {
    return { kind: 'merged', ...at, from: head, to: now, files: await gitops.diffNames(g, head, now), behind: incoming.commits, landings: incoming.landings };
  }
  if (gitOperation(root) === 'merge') {
    const files = (await g.run(['diff', '--name-only', '-z', '--diff-filter=U'])).stdout.split('\0').filter(Boolean).map((f) => f.normalize('NFC'));
    return { kind: 'merge_conflict', ...at, files, behind: incoming.commits, landings: incoming.landings };
  }
  return no('merge_refused', firstLine(`${r.stderr}\n${r.stdout}`) || `git merge exited ${r.code}`);
}

/** The agent's own live landings and the pause flag, from the hub within the budget; an error when it can't say. */
async function hubState(c: Ctx): Promise<{ ok: true; mine: Landing[]; paused: string | null } | { ok: false; error: string }> {
  const timeoutMs = Math.max(100, Math.min(c.client.cfg.timeoutMs, c.left() - APPLY_RESERVE_MS - PLAN_RESERVE_MS));
  const client = new HubClient({ ...c.client.cfg, timeoutMs });
  try {
    const s = await client.status();
    return { ok: true, mine: (s.queue ?? []).filter((l) => l.agent === c.cfg.agent), paused: s.control?.paused?.reason ?? null };
  } catch (err) {
    // Unreachable, or it refused: either way it can't say which landings are in flight.
    return { ok: false, error: classifyFailure(err, c.cfg).message };
  }
}

/** Whether `head` contains `commit`; false when this repository doesn't have it. */
async function containsCommit(g: Git, commit: string, head: string): Promise<boolean> {
  return (await g.run(['merge-base', '--is-ancestor', commit, head], { ok: [0, 1, 128] })).code === 0;
}

/** The first-parent trunk commits HEAD lacks, and the landings of this project among them. */
async function incomingOf(c: Ctx, head: string, tip: string): Promise<{ commits: number; landings: string[] }> {
  const { g, cfg } = c;
  try {
    const commits = Number((await c.g.run(['rev-list', '--count', '--first-parent', tip, `^${head}`])).stdout.trim()) || 0;
    const base = await gitops.mergeBase(g, head, tip);
    const trailers = await gitops.trunkTrailers(g, base, tip, 200);
    const landings = trailers.map((t) => landingIdOf(t.landing, cfg.project)).filter((id): id is string => id !== null);
    return { commits, landings: [...new Set(landings)] };
  } catch {
    return { commits: 0, landings: [] };
  }
}

/** `<project>/L-7` from a trunk trailer, as `L-7`, when it names this project. */
export function landingIdOf(value: string | null, project: string): string | null {
  if (!value || !value.startsWith(`${project}/`)) return null;
  const id = value.slice(project.length + 1);
  return /^L-\d+$/.test(id) ? id : null;
}

/** Tracked changes (staged or not) as `XY path`; untracked files don't count: reset --keep never touches them. */
async function trackedChanges(g: Git): Promise<string[]> {
  // --no-optional-locks: status must not write the refreshed index back (the index stays byte-identical).
  const out = (await g.run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no'], { timeoutMs: 60_000 })).stdout;
  const parts = out.split('\0');
  const changes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    if (xy === '??' || xy === '!!') continue;
    changes.push(`${xy.trim()} ${rec.slice(3).normalize('NFC')}`);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // a rename or copy is followed by its source
  }
  return changes;
}

/**
 * The untracked or ignored files and directories (`dir/`) of the worktree in
 * the way of moving HEAD to `target`, sorted: at a path `target` adds (a file,
 * a symlink, or a directory with anything untracked in it), or at a leading
 * directory of one (a file or symlink there, which isn't a tracked file the
 * target removes). git reset --keep refuses for an untracked file, but would
 * overwrite an ignored one and remove an ignored directory: sync never does.
 * Tracked files are clean here (the CAS just checked), so a path HEAD doesn't
 * have is untracked or ignored.
 */
async function inTheWay(g: Git, root: string, head: string, target: string): Promise<string[]> {
  const out = (await g.run(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--name-status', head, target])).stdout.split('\0');
  const added: string[] = [];
  const removed = new Set<string>();
  for (let i = 0; i + 1 < out.length; i += 2) {
    if (out[i] === 'A') added.push(out[i + 1]!);
    else if (out[i] === 'D') removed.add(out[i + 1]!);
  }
  const lstat = (rel: string): Stats | null => {
    try {
      return lstatSync(path.join(root, rel));
    } catch {
      return null;
    }
  };
  const found = new Set<string>();
  const dirs: string[] = [];
  const seen = new Map<string, 'free' | 'dir' | 'stop'>(); // leading directories looked at: absent, a directory, or nothing below to check
  for (const file of added) {
    const parts = file.split('/');
    let below = true;
    for (let i = 1; i < parts.length && below; i++) {
      const lead = parts.slice(0, i).join('/');
      let state = seen.get(lead);
      if (state === undefined) {
        const st = lstat(lead);
        if (!st) state = 'free';
        else if (st.isDirectory()) state = 'dir';
        else {
          if (!removed.has(lead)) found.add(lead); // an untracked or ignored file (or symlink) where the target has a directory
          state = 'stop';
        }
        seen.set(lead, state);
      }
      if (state !== 'dir') below = false; // absent: nothing below it exists; a file: nothing below it to look at (lstat would follow a symlink)
    }
    if (!below) continue;
    const st = lstat(file);
    if (!st) continue;
    if (st.isDirectory()) dirs.push(file); // tracked files in it the target removes are fine; anything else isn't
    else found.add(file);
  }
  for (let i = 0; i < dirs.length; i += 200) {
    const r = await g.run(['ls-files', '-z', '--others', '--directory', '--no-empty-directory', '--', ...dirs.slice(i, i + 200).map((d) => `:(literal)${d}`)]);
    for (const entry of r.stdout.split('\0').filter(Boolean)) {
      const dir = dirs.find((d) => entry === `${d}/` || entry.startsWith(`${d}/`));
      if (dir) found.add(`${dir}/`);
    }
  }
  return [...found].map((f) => f.normalize('NFC')).sort();
}

/**
 * inTheWay for a merge of `tip` into `head`: against the merge's own result
 * (`merge-tree --write-tree`, git 2.38; it places renames and conflict files
 * where the merge would) and against `tip` (all a merge without it can add).
 */
async function mergeInTheWay(g: Git, root: string, head: string, tip: string): Promise<string[]> {
  const found = new Set(await inTheWay(g, root, head, tip));
  const r = await g.run(['merge-tree', '--write-tree', '--no-messages', head, tip], { ok: [0, 1, 128, 129] });
  const tree = r.stdout.split('\n')[0]!.trim();
  if ((r.code === 0 || r.code === 1) && /^[0-9a-f]{40,64}$/.test(tree)) for (const f of await inTheWay(g, root, head, tree)) found.add(f);
  return [...found].sort();
}

function capped(paths: readonly string[], max = 20): string {
  return `${paths.slice(0, max).join(', ')}${paths.length > max ? ` +${paths.length - max} more` : ''}`;
}

/** Whether this git has merge-tree --merge-base (2.40): replays and forecasts need it. */
async function mergeTreeBase(g: Git): Promise<boolean> {
  try {
    return (await gitops.features(g)).mergeTreeBase;
  } catch {
    return false;
  }
}

/** git's version, as `2.39.2`. */
async function gitVersion(g: Git): Promise<string | null> {
  try {
    return /^git version (\S+)/.exec((await g.run(['version'])).stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Backup refs older than 14 days go (any branch's); the one just written stays. */
async function pruneBackups(g: Git, now: number): Promise<void> {
  try {
    const out = (await g.run(['for-each-ref', '--format=%(refname)', BACKUP_PREFIX])).stdout;
    for (const ref of out.split('\n').filter(Boolean)) {
      const ms = Number(/\/(\d{10,})$/.exec(ref)?.[1]);
      if (Number.isFinite(ms) && now - ms > BACKUP_KEEP_MS) await g.run(['update-ref', '-d', ref], { ok: [0, 1, 128] });
    }
  } catch {
    // housekeeping only
  }
}

/**
 * `git fetch <remote> +refs/heads/<trunk>:refs/remotes/<remote>/<trunk>`:
 * it only updates a remote-tracking ref, which is always safe. Bounded, never
 * prompting for credentials (a helper still answers), with no automatic gc
 * and no FETCH_HEAD.
 * The first line of the error, or null.
 */
export async function fetchTrunk(g: Git, remote: string, trunk: string, timeoutMs: number): Promise<string | null> {
  try {
    await g
      .with({ 'gc.auto': '0', 'maintenance.auto': 'false' })
      // --no-write-fetch-head: a fetch in the background must not change what a `git pull` of the user's merges.
      .run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, `+refs/heads/${trunk}:refs/remotes/${remote}/${trunk}`], {
        timeoutMs: Math.max(500, timeoutMs),
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
    return null;
  } catch (err) {
    if (err instanceof GitError) return err.timedOut ? `no answer within ${Math.round(Math.max(500, timeoutMs) / 1000)} s` : firstLine(err.stderr) || err.message;
    return (err as Error).message;
  }
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('hint:')) ?? ''
  );
}

// ------------------------------------------------------------------ the stale-base heads-up (pre-edit)

/**
 * For files whose claim was just granted: those trunk changed since the
 * worktree's base (`git diff --quiet <merge-base HEAD trunk> <remote>/<trunk> -- <file>`),
 * against the remote-tracking trunk as last fetched (no network), each with
 * the landing that last changed it. Once per (session, file, trunk sha). The
 * merge base is cached per (HEAD, trunk) in G/agenthub/mergebase.
 */
export function staleFiles(root: string, files: string[], land: Pick<LandConfig, 'remote' | 'trunk'>, session: string, project: string): Array<{ file: string; landing: string | null; agent: string | null }> {
  const p = syncPaths(root);
  if (!p || files.length === 0) return [];
  const head = gitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const tip = gitSync(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${land.remote}/${land.trunk}`]);
  if (!head || !tip || head === tip) return [];
  let base: string | null = null;
  const cached = readJson<{ head: string; trunk: string; base: string }>(p.mergebase);
  if (cached && cached.head === head && cached.trunk === tip && typeof cached.base === 'string') base = cached.base;
  else {
    base = gitSync(root, ['merge-base', head, tip]);
    if (!base) return [];
    try {
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.mergebase, JSON.stringify({ head, trunk: tip, base }));
    } catch {
      // a cache only
    }
  }
  if (base === tip) return [];
  const shown = readShown(p);
  const out: Array<{ file: string; landing: string | null; agent: string | null }> = [];
  for (const file of files) {
    const key = `${session}\0${file}\0${tip}`;
    if (shown.includes(key)) continue;
    // Exit 1: it differs. Anything else (0, or git failing) says nothing.
    if (gitExit(root, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', base, tip, '--', `:(literal)${file}`]) !== 1) continue;
    const log = gitSync(root, ['log', '--first-parent', '-n1', '--format=%(trailers:key=Agenthub-Landing,valueonly,separator=%x2C)%x00%(trailers:key=Agenthub-Agent,valueonly,separator=%x2C)', `${base}..${tip}`, '--', `:(literal)${file}`]) ?? '';
    const [landingValue, agentValue] = log.split('\0').map((s) => s.trim());
    const agent = agentValue && AGENT_ID_RE.test(agentValue) ? agentValue : null;
    out.push({ file, landing: landingIdOf(landingValue ?? null, project), agent });
    shown.push(key);
  }
  if (out.length) {
    try {
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.staleShown, `${shown.slice(-500).join('\n')}\n`);
    } catch {
      // then it may be said again
    }
  }
  return out;
}

function readShown(p: SyncPaths): string[] {
  try {
    return readFileSync(p.staleShown, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** git's exit code (null when it couldn't run or timed out). */
function gitExit(cwd: string, args: string[]): number | null {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 3000 });
    return 0;
  } catch (err) {
    const e = err as { status?: number | null; code?: string };
    return e.code === 'ETIMEDOUT' || typeof e.status !== 'number' ? null : e.status;
  }
}
