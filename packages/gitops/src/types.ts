// packages/gitops/src/types.ts — frozen at Step 0. Lane L implements these in
// packages/gitops/src/index.ts as `export const gitops: GitOps` plus the named
// functions; lane A (sync, land preflight, hub approve) and lane L (lander) use
// them. Zero npm dependencies: node:child_process, node:crypto, node:fs only.

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  /** Extra environment on top of the Git's own isolation env. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Exit codes that are not errors (default [0]); any other rejects with GitError. */
  ok?: number[];
}

export interface Git {
  /** --git-dir for a bare mirror, else the worktree root. */
  readonly dir: string;
  readonly bare: boolean;
  run(args: string[], o?: RunOptions): Promise<GitResult>;
  /** The same Git with extra `-c key=value` for every call. */
  with(config: Record<string, string>): Git;
}

export interface OpenOptions {
  /**
   * Isolation for the lander (design §2.2.2): GIT_CONFIG_GLOBAL=/dev/null,
   * GIT_CONFIG_NOSYSTEM=1, GIT_TERMINAL_PROMPT=0, HUB_GUARD=off,
   * -c core.hooksPath=/dev/null -c gc.auto=0. The adapter opens worktrees
   * without it (the user's own git setup applies there).
   */
  isolated: boolean;
  bare?: boolean;
  env?: Record<string, string>;
}

export type ConflictKind = 'content' | 'modify_delete' | 'rename' | 'binary' | 'mode' | 'other';

export interface ConflictEntry {
  path: string;
  kind: ConflictKind;
  /** Blob ids of the index stages merge-tree reported (1 base, 2 ours = trunk, 3 theirs = incoming). */
  stages: { 1?: string; 2?: string; 3?: string };
  mode: string | null;
  /** git's own message lines for this path. */
  messages: string[];
}

export interface MergeResult {
  tree: string;
  clean: boolean;
  conflicts: ConflictEntry[];
}

export interface StructuralDriver {
  /** Used as `merge=<name>` in the generated attributes and `-c merge.<name>.driver=`. */
  name: string;
  /** Driver template with %O %A %B %L %P (%S %X %Y for mergiraf). */
  command: string;
  /** Attribute patterns the driver handles (e.g. from `mergiraf languages --gitattributes`). */
  patterns: string[];
}

export interface MergeOptions {
  base: string;
  /** Attributes come from this tree only (`--attr-source`), never from the incoming side. */
  attrSource: string;
  /** Stage 2 only; stage 1 runs with an empty info/attributes and no drivers. */
  drivers?: StructuralDriver[];
}

export interface LandedBase {
  /** The merge base to use for base..tip diffs and merges. */
  base: string;
  /** The newest landed source (Agenthub-Source on trunk's first-parent history) that is an ancestor of tip, if it was chosen. */
  landedSource: string | null;
  reason: 'merge-base' | 'landed-source';
}

/** Trailer values of one first-parent trunk commit (absent keys are null). */
export interface LandingTrailers {
  sha: string;
  landing: string | null;
  hub: string | null;
  source: string | null;
  attempt: string | null;
  task: string | null;
  agent: string | null;
  resolved: string | null;
  checked: string | null;
}

export type PushOutcome =
  | { kind: 'ok' }
  | { kind: 'up_to_date' }
  /** Lease mismatch (trunk moved) or non-fast-forward. */
  | { kind: 'stale'; detail: string }
  /** The remote refused for policy (protected branch, hook): pause. */
  | { kind: 'rejected'; detail: string }
  /** Network error or timeout: the outcome is unknown. */
  | { kind: 'unknown'; detail: string };

export type ReplayOutcome = { kind: 'ok'; tip: string } | { kind: 'conflict'; commit: string; files: string[] } | { kind: 'merges'; commit: string };

export interface GitOps {
  open(dir: string, o: OpenOptions): Git;
  /** Feature probes, not version parsing: merge-tree --write-tree -z --merge-base, --attr-source. */
  features(g: Git): Promise<{ mergeTreeBase: boolean; attrSource: boolean }>;
  revParse(g: Git, rev: string): Promise<string | null>;
  isAncestor(g: Git, a: string, b: string): Promise<boolean>;
  mergeBase(g: Git, a: string, b: string): Promise<string | null>;
  /** NFC paths changed a..b (no rename detection), sorted. */
  diffNames(g: Git, a: string, b: string): Promise<string[]>;
  showBlob(g: Git, rev: string, path: string): Promise<string | null>;
  blobId(g: Git, rev: string, path: string): Promise<string | null>;
  /** `git merge-tree --write-tree -z --messages` parsed (design §2.2.5 format). */
  mergeTrees(g: Git, ours: string, theirs: string, o: MergeOptions): Promise<MergeResult>;
  /** Replace blobs in a tree through a temporary index; no worktree. */
  spliceTree(g: Git, tree: string, blobs: Array<{ path: string; mode: string; content: string }>): Promise<string>;
  commitTree(g: Git, tree: string, parent: string, message: string, author: { name: string; email: string; date: string }, committer: { name: string; email: string }): Promise<string>;
  /** design §1.1 "Landed base". */
  landedBase(g: Git, trunk: string, tip: string, depth?: number): Promise<LandedBase>;
  /** First-parent commits after `from` (exclusive) up to `to`, oldest first, with their Agenthub trailers. */
  trunkTrailers(g: Git, from: string | null, to: string, limit?: number): Promise<LandingTrailers[]>;
  /** The first-parent commit in from..to whose Landing, Hub and Source trailers all match, or null. */
  findLandingCommit(g: Git, from: string | null, to: string, key: { landing: string; hub: string; source: string }): Promise<string | null>;
  /** Strips TRAILER_LINE_RE lines and control/bidi characters; caps length. */
  sanitizeMessageText(s: string, max: number): string;
  /** Replay linear `commits` (oldest first) onto `onto` in the object database only. */
  replay(g: Git, commits: string[], onto: string): Promise<ReplayOutcome>;
  /** Paths that would conflict merging `work` (a commit, e.g. from `git stash create`) onto `trunk`. Touches nothing. */
  forecastConflicts(g: Git, trunk: string, work: string, base?: string): Promise<string[]>;
  /** `git stash create`: a commit of the dirty worktree, or null when clean. Writes no refs. */
  stashCreate(g: Git): Promise<string | null>;
  /**
   * The only function that updates trunk: asserts C^1 == expected and
   * isAncestor(expected, C), then runs exactly
   * `git push --atomic --porcelain --force-with-lease=refs/heads/<trunk>:<expected> <remote> <C>:refs/heads/<trunk> [:<deleteRef>]`.
   */
  pushTrunk(g: Git, o: { remote: string; trunk: string; candidate: string; expected: string; deleteRef?: string; timeoutMs?: number }): Promise<PushOutcome>;
  /** Plain (never forced) push or deletion of a ref under the land prefix; refuses any other ref. */
  pushRef(g: Git, o: { remote: string; prefix: string; sha: string | null; ref: string; timeoutMs?: number }): Promise<PushOutcome>;
  /** `git ls-remote` of one ref: its sha or null. */
  lsRemote(g: Git, remote: string, ref: string): Promise<string | null>;
  /**
   * sha256 hex over the sorted lines `kind \0 path \0 a \0 b [\0 c \0 d]`
   * (protected: base and head blobs; merged: trunk_base and candidate blobs;
   * ai_resolution: base, ours, theirs and result blobs). The lander, the hub's
   * approvers' CLI and the tests all use this one function.
   */
  approvalDigest(kind: 'protected' | 'merged' | 'ai_resolution', entries: Array<{ path: string; blobs: Array<string | null> }>): string;
}
