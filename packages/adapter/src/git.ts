import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
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

/**
 * Why the hub refuses `key` (an NFC repo path) as a claim key, or null if it
 * takes it: the same rules the hub applies (shared wire contract item 1), so a
 * file named that way can never be claimed, by anyone, and never conflicts.
 */
export function unclaimableReason(key: string): string | null {
  const bad = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\p{Cs}]/u.exec(key);
  if (bad) return `it contains U+${bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}, a control, line-separator or bidi character`;
  if (key.length > 4096) return 'it is longer than 4096 characters';
  if (key.startsWith('/') || /^[A-Za-z]:[\\/]/.test(key)) return 'it starts like an absolute path (a drive root such as C:/)';
  if (key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'it has a ".", ".." or empty segment';
  return null;
}

/**
 * Whether git ignores this untracked file (`.env`, `node_modules/…`), asked of
 * the repository that holds it and of each one around it up to `root`: a
 * submodule's .gitignore is its own (git in the worktree refuses to look
 * inside a submodule), and a directory the worktree ignores is local to each
 * worktree, a clone in it included. A tracked file never counts as ignored.
 */
export function isIgnored(file: string, root: string): boolean {
  const top = realish(root);
  let repo = findRepoRoot(path.dirname(file));
  while (repo && (repo === top || repo.startsWith(top + path.sep))) {
    const rel = toRepoPath(file, repo, repo);
    if (rel !== null && checkIgnore(repo, rel)) return true;
    repo = repo === top ? null : findRepoRoot(path.dirname(repo));
  }
  return false;
}

/**
 * Whether the file `name` directly in `root` is in the index (committed, or
 * staged to be), under that name or another one that opens the same file: where
 * the file system ignores case (macOS, Windows), checking out a branch that
 * commits `.Hub.json` replaces `.hub.json`, and git's own lookup goes by the exact name.
 */
export function isTracked(root: string, name: string): boolean {
  const tracked = gitRaw(root, ['ls-files', '-z', '--', ':(glob)*'])?.split('\0') ?? [];
  if (tracked.includes(name)) return true;
  const stat = (p: string, follow: boolean) => {
    try {
      return (follow ? statSync : lstatSync)(path.join(root, p), { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
  };
  const file = stat(name, true);
  // A tracked entry as git sees it: a committed symlink to `name` is a link, not another name for it.
  return !!file && tracked.some((t) => {
    const s = t && stat(t, false);
    return !!s && s.ino === file.ino && s.dev === file.dev;
  });
}

function checkIgnore(root: string, repoPath: string): boolean {
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
  const gitDir = ownGitDir(root);
  if (!gitDir) return null;
  try {
    return path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return gitDir; // the main checkout, or a submodule: its git dir is its own
  }
}

/** The git directory of this checkout alone (a linked worktree's `.git/worktrees/<name>`), read as gitCommonDir reads it. */
export function ownGitDir(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? path.resolve(root, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Paths in the index that differ from HEAD, including deleted files and both
 * sides of renames (without rename detection a rename is a deletion plus an
 * addition, and skipping it keeps big move-and-edit commits fast). Throws when
 * git fails, so a failure never reads as "nothing staged".
 *
 * In a merge (`merging`: the commits it brings in, see mergeHeads), only the
 * paths the merge commit itself changes: where the index differs from the
 * version the merge brings in, which is a merged commit's where that commit
 * changed the path since the merge base, else HEAD's. A change merged in as it
 * was committed on the other branch is that branch's, not this commit's; a
 * conflict resolved against it, both sides' changes combined, or an edit is.
 */
export function stagedPaths(root: string, merging: string[] = []): string[] {
  const staged = diffNames(root, ['diff', '--cached', '--name-only', '-z', '--no-renames'], 'git diff --cached');
  const fromHere = new Set(staged);
  let touched: string[] | null = null;
  for (const head of merging) {
    const base = git(root, ['merge-base', 'HEAD', head]);
    const changedThere = new Set(
      base
        ? diffNames(root, ['diff', '--name-only', '-z', '--no-renames', base, head], 'git diff')
        : diffNames(root, ['ls-tree', '-r', '-z', '--name-only', head], 'git ls-tree'), // unrelated histories: all of it is new there
    );
    const fromThere = new Set(diffNames(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], 'git diff --cached'));
    const changed = new Set([...staged, ...fromThere].filter((p) => (changedThere.has(p) ? fromThere.has(p) : fromHere.has(p))));
    // An octopus merge changes what it changes against every one of them.
    touched = touched ? touched.filter((p) => changed.has(p)) : [...changed];
  }
  return touched ?? staged;
}

function diffNames(root: string, args: string[], what: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const reason = e.code === 'ETIMEDOUT' ? 'no answer within 120 s' : String(e.stderr ?? '').trim().split('\n')[0] || e.message;
    throw new Error(`${what} failed: ${reason}`);
  }
  return [...new Set(out.split('\0').filter((s) => s.length > 0).map((s) => s.normalize('NFC')))];
}

/**
 * The commits a merge in progress brings in: MERGE_HEAD, or, in pre-merge-commit,
 * which git merge runs before it writes that, the GITHEAD_<id> variables it sets
 * for each one. Empty outside a merge.
 */
export function mergeHeads(root: string, env: NodeJS.ProcessEnv): string[] {
  const file = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD']);
  let heads: string[] = [];
  try {
    if (file) heads = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // no merge in progress
  }
  if (heads.length === 0) heads = Object.keys(env).flatMap((k) => /^GITHEAD_([0-9a-f]{40}|[0-9a-f]{64})$/.exec(k)?.[1] ?? []);
  return heads;
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
