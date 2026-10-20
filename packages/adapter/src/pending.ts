import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitCommonDir } from './git.js';

/** A claim the edit hook took for a tool call that has not been confirmed to run. */
export interface PendingClaim {
  session: string;
  /** `main`, or the subagent's agent_id: tool calls within one thread run one after another. */
  thread: string;
  /** The tool call's tool_use_id. */
  tool: string;
  claim_id: string;
  /** Root of the worktree the edited file is in; its config says which hub and identity to release with. */
  root: string;
  at: number;
}

export type StoredClaim = PendingClaim & { file: string };

/** Session directories nobody has touched for this long belong to sessions that are over. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);

/**
 * Claims the PreToolUse hook took for edits that may never run. Claude Code
 * runs PreToolUse before the permission prompt, deny rules and other hooks, so
 * an edit can be refused after its file was claimed. The PostToolUse hook
 * confirms the edits that ran; the rest are released (see hooks.ts).
 *
 * Kept in `<git common dir>/agenthub/pending/<session>/`, shared by every
 * worktree of the repository, one file per claim: hooks running at the same
 * time never rewrite each other's entries.
 */
export class PendingClaims {
  private constructor(readonly dir: string) {}

  static open(root: string): PendingClaims | null {
    const common = gitCommonDir(root);
    return common ? new PendingClaims(path.join(common, 'agenthub', 'pending')) : null;
  }

  add(entry: Omit<PendingClaim, 'at'>): void {
    this.pruneStaleSessions();
    this.write({ ...entry, at: Date.now() });
  }

  /** This session's entries, oldest first. */
  list(session: string): StoredClaim[] {
    const dir = path.join(this.dir, safe(session));
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: StoredClaim[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const e = JSON.parse(readFileSync(file, 'utf8')) as PendingClaim;
        if ([e.session, e.thread, e.tool, e.claim_id, e.root].every((v) => typeof v === 'string')) out.push({ ...e, file });
      } catch {
        // half-written, or removed meanwhile
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Entries of any session for these claims. */
  find(claimIds: Iterable<string>): StoredClaim[] {
    const ids = new Set(claimIds);
    if (ids.size === 0) return [];
    return this.sessions().flatMap((s) => this.list(s).filter((e) => ids.has(e.claim_id)));
  }

  remove(entry: { file: string }): void {
    rmSync(entry.file, { force: true });
  }

  /** Hand an entry to another tool call, whose confirmation then keeps the claim (a failed edit, retried). */
  move(entry: StoredClaim, to: Pick<PendingClaim, 'session' | 'thread' | 'tool'>): void {
    const { file, ...rest } = entry;
    this.write({ ...rest, ...to });
    this.remove(entry);
  }

  private write(entry: PendingClaim): void {
    const dir = path.join(this.dir, safe(entry.session));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe(entry.thread)}~${safe(entry.tool)}~${safe(entry.claim_id)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  }

  /** Directory names; `list` accepts them as session ids. */
  private sessions(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  private pruneStaleSessions(): void {
    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const session of this.sessions()) {
      const dir = path.join(this.dir, session);
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch {
        // gone already
      }
    }
  }
}

/** Claims the agent just made or renewed on purpose (MCP `claim`, `hub claim`) stop being the edit hook's to release. Best effort. */
export function adoptClaims(root: string | null, claims: Array<{ id: string }> | undefined): void {
  if (!root || !claims?.length) return;
  try {
    const store = PendingClaims.open(root);
    for (const e of store?.find(claims.map((c) => c.id)) ?? []) store!.remove(e);
  } catch {
    // bookkeeping only
  }
}
