import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
 * the repository or inside `.git`. Keys are NFC: realpath returns a name the
 * way it is stored on disk (decomposed, on macOS, for files Finder or a Cocoa
 * app created), while git and other worktrees use the composed form.
 */
export function toRepoPath(file: string, root: string, cwd: string): string | null {
  const abs = realish(path.resolve(cwd, file));
  const rel = path.relative(realish(root), abs);
  // Only a whole '..' segment leaves the root: '..env' and '..data/x' are files in it.
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/').normalize('NFC');
  if (posix === '.git' || posix.startsWith('.git/')) return null;
  return posix;
}

/** Whether git ignores this untracked repo path (`.env`, `node_modules/…`). A tracked file never counts as ignored. */
export function isIgnored(root: string, repoPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', repoPath], { cwd: root, stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false; // exit 1 (not ignored) or a git failure: coordinate the file
  }
}

/**
 * The git directory every worktree of this repository shares, read the way git
 * finds it (`.git` itself, or the `gitdir:` a worktree's `.git` file points to
 * and its `commondir`) without starting git: the edit hook runs before every edit.
 */
export function gitCommonDir(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(root, m[1].trim());
    try {
      return path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      return gitDir; // a submodule: its git dir is its own
    }
  } catch {
    return null;
  }
}

/**
 * Paths in the index that differ from HEAD, including deleted files and both
 * sides of renames (without rename detection a rename is a deletion plus an
 * addition, and skipping it keeps big move-and-edit commits fast). Throws when
 * git fails, so a failure never reads as "nothing staged".
 */
export function stagedPaths(root: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--no-renames'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const reason = e.code === 'ETIMEDOUT' ? 'no answer within 120 s' : String(e.stderr ?? '').trim().split('\n')[0] || e.message;
    throw new Error(`git diff --cached failed: ${reason}`);
  }
  return [...new Set(out.split('\0').filter((s) => s.length > 0).map((s) => s.normalize('NFC')))];
}

/** Settings `hub init` records in the repository's shared git config (`agenthub.project`, `agenthub.url`). */
export function recordedSettings(root: string): { project?: string; url?: string } {
  const out = git(root, ['config', '--local', '--get-regexp', '^agenthub\\.(project|url)$']);
  const found: { project?: string; url?: string } = {};
  for (const line of out?.split('\n') ?? []) {
    const m = /^agenthub\.(project|url) (.+)$/.exec(line.trim());
    if (m) found[m[1] as 'project' | 'url'] = m[2];
  }
  return found;
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
