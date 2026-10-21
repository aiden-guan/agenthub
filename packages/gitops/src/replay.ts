// What workspace sync builds on (design §2.3.5): replaying commits in the
// object database, and recording a dirty worktree. Neither touches the
// worktree, the index or any ref.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictedNames } from './merge.js';
import { assertRev } from './run.js';
import type { Git, ReplayOutcome } from './types.js';

/**
 * Replay linear `commits` (oldest first) onto `onto` in the object database:
 * per commit, `merge-tree --merge-base=c^ <tip> c`, then `commit-tree` with
 * the commit's own author, author date and message (the committer is whoever
 * runs it). No hooks run and nothing outside the object database changes.
 * A merge commit among them is refused before anything is written.
 */
export async function replay(g: Git, commits: string[], onto: string): Promise<ReplayOutcome> {
  assertRev(onto, 'onto');
  for (const c of commits) assertRev(c, 'commit');
  if (commits.length === 0) return { kind: 'ok', tip: onto };

  const info = await g.run(['log', '--no-walk=unsorted', '--date=raw', '--format=%H%x00%P%x00%an%x00%ae%x00%ad%x00', ...commits]);
  const fields = info.stdout.split('\0');
  const meta = new Map<string, { parents: string[]; name: string; email: string; date: string }>();
  for (let i = 0; i + 5 <= fields.length; i += 5) {
    const sha = fields[i]!.trim();
    if (!sha) break;
    meta.set(sha, { parents: fields[i + 1]!.split(' ').filter(Boolean), name: fields[i + 2]!, email: fields[i + 3]!, date: fields[i + 4]! });
  }
  const resolved: Array<{ sha: string; parent: string; name: string; email: string; date: string }> = [];
  for (const c of commits) {
    const sha = (await g.run(['rev-parse', '--verify', '--end-of-options', `${c}^{commit}`])).stdout.trim();
    const m = meta.get(sha);
    if (!m) throw new Error(`gitops: no commit ${c}`);
    if (m.parents.length > 1) return { kind: 'merges', commit: c };
    if (m.parents.length === 0) throw new Error(`gitops: ${c} is a root commit; there is nothing to replay it from`);
    resolved.push({ sha, parent: m.parents[0]!, name: m.name, email: m.email, date: m.date });
  }

  let tip = onto;
  for (const [i, c] of resolved.entries()) {
    const merged = await g.run(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${c.parent}`, tip, c.sha], { ok: [0, 1] });
    if (merged.code === 1) return { kind: 'conflict', commit: commits[i]!, files: conflictedNames(merged.stdout) };
    const tree = merged.stdout.split('\0')[0]!.trim();
    const raw = (await g.run(['cat-file', 'commit', c.sha])).stdout;
    const split = raw.indexOf('\n\n');
    const message = split < 0 ? '' : raw.slice(split + 2);
    tip = (
      await g.run(['commit-tree', tree, '-p', tip], {
        input: message,
        env: { GIT_AUTHOR_NAME: c.name, GIT_AUTHOR_EMAIL: c.email, GIT_AUTHOR_DATE: c.date },
      })
    ).stdout.trim();
  }
  return { kind: 'ok', tip };
}

/**
 * `git stash create`: a commit of the dirty worktree, or null when clean.
 * It writes no refs. git refreshes and rewrites the index it works on, so it
 * runs on a temporary copy: the real index stays byte-identical.
 */
export async function stashCreate(g: Git): Promise<string | null> {
  const indexPath = path.resolve(g.dir, (await g.run(['rev-parse', '--git-path', 'index'])).stdout.trim());
  const dir = mkdtempSync(path.join(tmpdir(), 'gitops-stash-'));
  try {
    const copy = path.join(dir, 'index');
    if (existsSync(indexPath)) copyFileSync(indexPath, copy);
    const r = await g.run(['stash', 'create'], { env: { GIT_INDEX_FILE: copy } });
    return r.stdout.trim() || null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
