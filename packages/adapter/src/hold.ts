// The opt-in Stop-hook hold (design §2.3.6, the settle row; trunk's
// land.holdTurn): when an agent ends its turn while its landing is still in
// the queue, keep it in the turn once, so a send-back finds it with the
// context it has now. The state is two kinds of files under the worktree's
// git dir G:
//
// - G/agenthub/held/<landing>: that landing has held the agent (at most once
//   per landing). It names the landing's creation time and project, because a
//   hub on a new database numbers its landings from L-1 again.
// - G/agenthub/held-row/<session>: the session's last Stop was held, so its
//   next Stop passes whatever the host says (never twice in a row). Any Stop
//   that isn't held, a new prompt and the session's end remove it.
//
// Everything here fails towards not holding: a file that can't be read or
// written means the agent stops as it would without the hold.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Landing, LandingStatus } from '@agenthub/hub/protocol';
import { gitDir } from './git.js';

/** Live and not parked: the landings that can hold an agent (needs_approval waits for a human, not for the agent). */
export const HOLD_STATUSES: readonly LandingStatus[] = ['submitted', 'queued', 'running'];
/** A landing marker this old is pruned: no landing stays in the queue that long. */
const HELD_STALE_MS = 7 * 24 * 3_600_000;
/** A row marker this old is pruned (a session that ended without SessionEnd). */
const ROW_STALE_MS = 24 * 3_600_000;

export interface HoldPaths {
  held: string;
  row: string;
}

/** The hold's directories in the worktree at `root`, or null outside a git checkout. */
export function holdPaths(root: string): HoldPaths | null {
  const g = gitDir(root);
  if (!g) return null;
  const dir = path.join(g, 'agenthub');
  return { held: path.join(dir, 'held'), row: path.join(dir, 'held-row') };
}

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || '_';

interface HeldMarker {
  v: 1;
  landing: string;
  project: string;
  created_at: number;
  session: string;
  at: number;
}

/** The marker for `l`: whether it names this very landing (same project and creation time), another one of that id, or can't be read. */
function markerOf(p: HoldPaths, id: string, project: string, createdAt: number): 'this' | 'other' | 'unreadable' | 'none' {
  let raw: string;
  try {
    raw = readFileSync(path.join(p.held, safe(id)), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unreadable';
  }
  try {
    const m = JSON.parse(raw) as Partial<HeldMarker>;
    if (m && typeof m === 'object' && typeof m.created_at === 'number' && typeof m.project === 'string') {
      return m.project === project && m.created_at === createdAt ? 'this' : 'other';
    }
  } catch {
    // below
  }
  return 'unreadable';
}

/** Whether `l` has held the agent before. A marker that can't be read counts as one (never hold twice). */
export function heldBefore(p: HoldPaths, l: Pick<Landing, 'id' | 'created_at'>, project: string): boolean {
  const m = markerOf(p, l.id, project, l.created_at);
  return m === 'this' || m === 'unreadable';
}

/**
 * Record that `l` holds the agent now. Exclusive: false when the marker can't
 * be written, or another process wrote it first, so a landing never holds
 * twice. A marker of another landing with the same id (an earlier hub
 * database) is replaced.
 */
export function markHeld(p: HoldPaths, l: Pick<Landing, 'id' | 'created_at'>, project: string, session: string, now = Date.now()): boolean {
  const file = path.join(p.held, safe(l.id));
  const marker: HeldMarker = { v: 1, landing: l.id, project, created_at: l.created_at, session, at: now };
  try {
    mkdirSync(p.held, { recursive: true });
    prune(p.held, HELD_STALE_MS, now);
    if (markerOf(p, l.id, project, l.created_at) === 'other') rmSync(file, { force: true });
    writeFileSync(file, `${JSON.stringify(marker)}\n`, { flag: 'wx' });
    return true;
  } catch {
    return false; // EEXIST included: it has held already (or is holding right now)
  }
}

/** Start the session's row: its next Stop passes. False when that can't be recorded. */
export function startRow(p: HoldPaths, session: string, now = Date.now()): boolean {
  try {
    mkdirSync(p.row, { recursive: true });
    prune(p.row, ROW_STALE_MS, now);
    writeFileSync(path.join(p.row, safe(session)), `${now}\n`);
    return true;
  } catch {
    return false;
  }
}

/** End the session's row; true when its last Stop was held (this Stop must pass). */
export function endRow(p: HoldPaths, session: string): boolean {
  const file = path.join(p.row, safe(session));
  try {
    statSync(file);
  } catch {
    return false;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // then the next Stop passes too: never a hold too many
  }
  return true;
}

/** The landing to hold the agent for: its own, live and not parked, not held before; the running one first, then in queue order. */
export function pickHold(landings: readonly Landing[], me: string, held: (l: Landing) => boolean): Landing | null {
  const rank = (l: Landing) => (l.status === 'running' ? 0 : 1);
  const seq = (l: Landing) => l.queue_seq ?? Number.MAX_SAFE_INTEGER;
  const candidates = landings
    .filter((l) => l.agent === me && HOLD_STATUSES.includes(l.status) && !held(l))
    .sort((a, b) => rank(a) - rank(b) || seq(a) - seq(b) || a.created_at - b.created_at);
  return candidates[0] ?? null;
}

/** Remove files in `dir` older than `maxAgeMs` (best effort). */
function prune(dir: string, maxAgeMs: number, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
    } catch {
      // gone meanwhile
    }
  }
}
