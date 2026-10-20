import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Nearest ancestor of `start` (inclusive) containing `.git` (a directory, or a file in a worktree). */
export function findRepoRoot(start: string): string | null {
  let dir = realish(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Run git and return trimmed stdout, or null on any failure. */
export function git(cwd: string, args: string[], timeoutMs = 3000): string | null {
  const out = gitRaw(cwd, args, timeoutMs);
  return out === null ? null : out.trim();
}

export function gitRaw(cwd: string, args: string[], timeoutMs = 3000): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
  } catch {
    return null;
  }
}

export function headCommit(root: string): string | null {
  return git(root, ['rev-parse', '--short=12', 'HEAD']) || null;
}

export function currentBranch(root: string): string | null {
  const b = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : null;
}

/**
 * Like realpath, but works for paths that don't exist yet (a Write that
 * creates a file): resolves symlinks on the longest existing prefix.
 */
export function realish(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // keep the unresolved path
  }
  return path.join(real, ...rest);
}

/**
 * Map a file path to the repo-relative POSIX path the hub uses as a claim key,
 * so the same file matches across worktrees. Returns null for files outside
 * the repository or inside `.git`.
 */
export function toRepoPath(file: string, root: string, cwd: string): string | null {
  const abs = realish(path.resolve(cwd, file));
  const rel = path.relative(realish(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) return null;
  return posix;
}

/** Paths in the index that differ from HEAD, including both sides of renames and deleted files. */
export function stagedPaths(root: string): string[] {
  const out = gitRaw(root, ['diff', '--cached', '--name-status', '-z', '-M']);
  if (!out) return [];
  const parts = out.split('\0').filter((s) => s.length > 0);
  const files = new Set<string>();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    // Renames and copies list the old path and then the new one.
    const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    for (const p of parts.slice(i, i + count)) files.add(p);
    i += count;
  }
  return [...files];
}

/** A stable project id shared by every worktree: `owner/repo` from origin, else the main checkout's folder name. */
export function deriveProject(root: string): string | null {
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  if (remote) {
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
    if (m) return sanitizeProject(m[1]);
  }
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) {
    const main = path.basename(common) === '.git' ? path.dirname(common) : common.replace(/\.git$/, '');
    return sanitizeProject(path.basename(main));
  }
  return sanitizeProject(path.basename(root));
}

function sanitizeProject(s: string): string | null {
  const cleaned = s.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128);
  return cleaned || null;
}
