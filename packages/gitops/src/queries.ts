// Read-only queries and the feature probe.

import { assertRev, FULL_SHA_RE, runAny, validRepoPath, validRev } from './run.js';
import type { Git } from './types.js';

/** A fixed identity and date for objects gitops writes itself (the feature probe), so they are the same every time. */
const PROBE_ENV = {
  GIT_AUTHOR_NAME: 'agenthub',
  GIT_AUTHOR_EMAIL: 'agenthub@localhost',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'agenthub',
  GIT_COMMITTER_EMAIL: 'agenthub@localhost',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/**
 * Feature probes, not version parsing (design §2.2.10, R4): merge an
 * empty-tree commit with itself through `merge-tree --write-tree -z
 * --merge-base`, then again under `--attr-source`. The probe writes two
 * unreachable objects and no refs.
 */
export async function features(g: Git): Promise<{ mergeTreeBase: boolean; attrSource: boolean }> {
  const tree = await runAny(g, ['mktree'], { input: '' });
  const emptyTree = tree.stdout.trim();
  if (tree.code !== 0 || !FULL_SHA_RE.test(emptyTree)) return { mergeTreeBase: false, attrSource: false };
  const commit = await runAny(g, ['commit-tree', '--no-gpg-sign', emptyTree, '-m', 'agenthub feature probe'], { env: PROBE_ENV });
  const c = commit.stdout.trim();
  if (commit.code !== 0 || !FULL_SHA_RE.test(c)) return { mergeTreeBase: false, attrSource: false };
  const probe = ['merge-tree', '--write-tree', '-z', '--messages', `--merge-base=${c}`, c, c];
  const merged = (r: { code: number; stdout: string }) => r.code === 0 && r.stdout.startsWith(`${emptyTree}\0`);
  const mergeTreeBase = merged(await runAny(g, probe));
  const attrSource = mergeTreeBase && merged(await runAny(g, [`--attr-source=${c}`, ...probe]));
  return { mergeTreeBase, attrSource };
}

/** The full object id `rev` names, or null when it names nothing (a full sha must also exist). */
export async function revParse(g: Git, rev: string): Promise<string | null> {
  if (!validRev(rev)) return null;
  const r = await g.run(['rev-parse', '--verify', '--quiet', '--end-of-options', rev], { ok: [0, 1, 128] });
  const id = r.stdout.trim();
  if (r.code !== 0 || !FULL_SHA_RE.test(id)) return null;
  // rev-parse echoes a well-formed full sha without looking it up.
  if (FULL_SHA_RE.test(rev) && (await g.run(['cat-file', '-e', id], { ok: [0, 1, 128] })).code !== 0) return null;
  return id;
}

export async function isAncestor(g: Git, a: string, b: string): Promise<boolean> {
  assertRev(a);
  assertRev(b);
  return (await g.run(['merge-base', '--is-ancestor', a, b], { ok: [0, 1] })).code === 0;
}

/** Like isAncestor, but false (not an error) when `a` is not in this repository. */
export async function isAncestorIfPresent(g: Git, a: string, b: string): Promise<boolean> {
  assertRev(a);
  assertRev(b);
  return (await g.run(['merge-base', '--is-ancestor', a, b], { ok: [0, 1, 128] })).code === 0;
}

export async function mergeBase(g: Git, a: string, b: string): Promise<string | null> {
  assertRev(a);
  assertRev(b);
  const r = await g.run(['merge-base', a, b], { ok: [0, 1] });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** NFC paths changed a..b (no rename detection), sorted. */
export async function diffNames(g: Git, a: string, b: string): Promise<string[]> {
  assertRev(a);
  assertRev(b);
  const r = await g.run(['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', a, b]);
  return [...new Set(r.stdout.split('\0').filter((p) => p.length > 0).map((p) => p.normalize('NFC')))].sort();
}

/** The blob at `rev:path`, or null when there is none there (missing, or a directory or submodule). */
export async function blobId(g: Git, rev: string, path: string): Promise<string | null> {
  if (!validRev(rev) || !validRepoPath(path)) return null;
  const r = await g.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}:${path}`], { ok: [0, 1, 128] });
  const id = r.stdout.trim();
  if (r.code !== 0 || !FULL_SHA_RE.test(id)) return null;
  const type = await g.run(['cat-file', '-t', id], { ok: [0, 128] });
  return type.code === 0 && type.stdout.trim() === 'blob' ? id : null;
}

export async function showBlob(g: Git, rev: string, path: string): Promise<string | null> {
  const id = await blobId(g, rev, path);
  if (!id) return null;
  return (await g.run(['cat-file', 'blob', id])).stdout;
}

/** Which of `shas` are commits in this repository, in one call. */
export async function presentCommits(g: Git, shas: string[]): Promise<Set<string>> {
  const ids = shas.filter((s) => FULL_SHA_RE.test(s));
  if (ids.length === 0) return new Set();
  const r = await g.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: ids.map((s) => `${s}\n`).join('') });
  const present = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const [id, type] = line.split(' ');
    if (id && type === 'commit') present.add(id);
  }
  return present;
}
