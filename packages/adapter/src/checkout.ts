import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hasOwnSettings, loadConfig, sameHub, type HubConfig } from './config.js';
import { findRepoRoot, gitCommonDir, ownGitDir, realish, toRepoPath } from './git.js';

/** The git directory shared by every worktree of the repository `root` is a checkout of. */
export const commonDirOf = (root: string): string => realish(gitCommonDir(root) ?? root);

/** The git directory shared by every worktree of the repository `dir` is in, or null outside git. */
export function repositoryOf(dir: string): string | null {
  const root = findRepoRoot(dir);
  return root ? commonDirOf(root) : null;
}

/**
 * The checkout whose claims cover the files in `dir`: the nearest repository
 * around it that has agenthub settings. A submodule, or another repository
 * nested in a worktree, has none of its own, so its files are claimed as files
 * of the worktree around it (`vendor/lib/x.ts`), on the team's hub. A worktree
 * inside another worktree of the same repository (as Claude Code makes under
 * .claude/worktrees) is a checkout of its own. With no settings anywhere
 * around (HUB_* variables only), the same for the session's own repository
 * (`session` is a directory in it); null for any other (an added dependency,
 * dotfiles): nobody coordinates it.
 */
export function claimRoot(dir: string, session: string): string | null {
  const nearest = findRepoRoot(dir);
  const sessionRepo = repositoryOf(session);
  let checkout = nearest; // innermost root of the repository `root` belongs to
  let own: string | null = null;
  for (let root = nearest; root; root = findRepoRoot(path.dirname(root))) {
    if (root !== checkout && commonDirOf(root) !== commonDirOf(checkout!)) checkout = root;
    if (hasOwnSettings(root)) return checkout;
    if (!own && commonDirOf(root) === sessionRepo) own = checkout;
  }
  return own;
}

/**
 * The claim key of `file` (resolved against `cwd`) for the session whose
 * config is `cfg`, as the edit hook keys it: relative to the checkout the file
 * is in (claimRoot), so a file in a worktree nested under the session's
 * (.claude/worktrees) is `src/auth.ts`, not `.claude/worktrees/x/src/auth.ts`.
 * Throws, with a message for the agent, for a file outside the session's
 * repository or in a checkout coordinated on another project or hub.
 */
export function claimKey(file: string, cwd: string, cfg: Pick<HubConfig, 'root' | 'project' | 'url'>, env: NodeJS.ProcessEnv): string {
  if (!cfg.root) throw new Error('not inside a git repository, so file paths cannot be mapped to the shared repo');
  const abs = path.resolve(cwd, file);
  const root = claimRoot(path.dirname(abs), cfg.root);
  if (!root || repositoryOf(root) !== repositoryOf(cfg.root)) throw new Error(`${file} is outside the repository`);
  if (root !== realish(cfg.root)) {
    // Another checkout of this repository: its files are claimed as its config says.
    let other: HubConfig;
    try {
      other = loadConfig({ cwd: root, env });
    } catch (err) {
      throw new Error(`${file} is in ${root}, whose agenthub configuration can't be read (${(err as Error).message})`);
    }
    if (other.project !== cfg.project || !sameHub(other.url, cfg.url)) {
      throw new Error(`${file} is in ${root}, which is coordinated as project ${other.project} on ${other.url}, not as this session's ${cfg.project} on ${cfg.url}`);
    }
  }
  const key = toRepoPath(abs, root, root);
  if (key === null) throw new Error(`${file} is outside the repository`);
  return key;
}

/**
 * `cfg` (loaded for a checkout) with the identity of the session working in it
 * when the checkout has none of its own, as a worktree Claude Code created
 * under .claude/worktrees has no .hub.json: that of the first of `sessionDirs`
 * that is a checkout of the same repository and has one. An identity is never
 * lent to another project's checkout, or a token sent to another hub.
 */
export function lendIdentity(cfg: HubConfig, env: NodeJS.ProcessEnv, sessionDirs: Array<string | null | undefined>): HubConfig {
  if (cfg.agent || !cfg.root) return cfg;
  const repo = repositoryOf(cfg.root);
  for (const dir of sessionDirs) {
    if (!dir || repositoryOf(dir) !== repo) continue;
    let session: HubConfig;
    try {
      session = loadConfig({ cwd: dir, env });
    } catch {
      continue;
    }
    if (!session.agent || session.root === cfg.root) continue;
    return {
      ...cfg,
      agent: session.agent,
      token: cfg.token ?? (sameHub(session.url, cfg.url) ? session.token : null),
      failClosed: cfg.failClosed || session.failClosed,
      lentBy: session.root ?? dir,
    };
  }
  return cfg;
}

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || '_';

/** Where the sessions that lent the checkout at `root` their identity are recorded: its own git dir, never committed. */
function lendingDir(root: string): string | null {
  const gitDir = ownGitDir(root);
  return gitDir ? path.join(gitDir, 'agenthub', 'lent') : null;
}

/**
 * Remember that the session `session`, whose checkout is `sessionRoot`, lent
 * its identity to the checkout at `root` (see lendIdentity), so the git guard
 * there acts as the same agent: `git commit` runs in Claude's Bash tool, where
 * CLAUDE_PROJECT_DIR isn't set. Best effort.
 */
export function recordLending(root: string, sessionRoot: string, session: string | null): void {
  const dir = lendingDir(root);
  if (!dir) return;
  const file = path.join(dir, `${safe(session ?? 'session')}.json`);
  try {
    const known = JSON.parse(readFileSync(file, 'utf8')) as { dir?: unknown; at?: unknown };
    // Kept fresh enough to tell the latest session apart, without a write on every edit.
    if (known.dir === sessionRoot && typeof known.at === 'number' && Date.now() - known.at < 60_000) return;
  } catch {
    // not recorded yet
  }
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ dir: sessionRoot, at: Date.now() }));
    renameSync(tmp, file);
  } catch {
    // bookkeeping only
  }
}

/** The checkouts of the sessions that lent the checkout at `root` their identity: `session`'s first (Claude Code's CLAUDE_CODE_SESSION_ID), then the latest. */
export function lendingSessions(root: string, session?: string): string[] {
  const dir = lendingDir(root);
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const found: Array<{ name: string; dir: string; at: number }> = [];
  for (const name of names) {
    try {
      const e = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { dir?: unknown; at?: unknown };
      if (typeof e.dir === 'string') found.push({ name, dir: e.dir, at: typeof e.at === 'number' ? e.at : 0 });
    } catch {
      // half-written
    }
  }
  const mine = session ? `${safe(session)}.json` : null;
  found.sort((a, b) => Number(b.name === mine) - Number(a.name === mine) || b.at - a.at);
  return [...new Set(found.map((f) => f.dir))];
}
