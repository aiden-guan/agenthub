// GitPort over @agenthub/gitops (design §2.2.1): the lander's bare mirror and
// its remote, every call isolated (§2.2.2). The pipeline only ever sees the
// port, so the simulation (§5.2) can put an in-memory remote behind it.

import {
  blobId,
  commitTree,
  diffNames,
  findLandingCommit,
  GitError,
  isAncestor,
  landedBase,
  lsRemote,
  mergeFile,
  mergeTrees,
  open,
  pathHistory,
  pushRef,
  pushTrunk,
  revParse,
  showBlob,
  spliceTree,
  trunkTrailers,
  type Git,
} from '@agenthub/gitops';
import type { CommitInfo, FetchOutcome, GitPort } from './ports.js';

export interface GitPortOptions {
  /** The mirror (bare for the lander): its path, or an isolated Git already open on it. */
  mirror: string | Git;
  /** The remote (name or URL) fetched from and pushed to. */
  remote: string;
  /** Extra environment for every git call (tests pin identities and dates with it). */
  env?: Record<string, string>;
  fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
/** A refspec the lander fetches: `[+]src[:dst]`, never anything git could take for an option. */
const REFSPEC_RE = /^\+?[A-Za-z0-9_][A-Za-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9._/-]*)?$/;
const LOCAL_REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;
const INFO_FORMAT = '%H%x00%s%x00%an%x00%ae%x00%ad%x00';

export function openGitPort(o: GitPortOptions): GitPort & { readonly git: Git } {
  // Bareness is detected: the lander's mirror is bare, a test may hand it a working repository.
  const g = typeof o.mirror === 'string' ? open(o.mirror, { isolated: true, env: o.env }) : o.mirror;
  const remote = o.remote;
  if (!remote || remote.startsWith('-') || /[\0\n\r]/.test(remote)) throw new Error(`lander: bad remote ${JSON.stringify(remote)}`);
  const fetchTimeoutMs = o.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const rev = (r: string): string => {
    if (!r || r.startsWith('-') || /[\0\n\r]/.test(r)) throw new Error(`lander: bad revision ${JSON.stringify(r)}`);
    return r;
  };
  const infos = (stdout: string): CommitInfo[] => {
    const parts = stdout.split('\0');
    const out: CommitInfo[] = [];
    for (let i = 0; i + 5 <= parts.length; i += 5) {
      const sha = parts[i]!.trim();
      if (!sha) break;
      out.push({ sha, subject: parts[i + 1]!, author: { name: parts[i + 2]!, email: parts[i + 3]!, date: parts[i + 4]! } });
    }
    return out;
  };

  return {
    git: g,

    async fetch(refspecs: string[]): Promise<FetchOutcome> {
      for (const r of refspecs) if (!REFSPEC_RE.test(r) || r.includes('..')) throw new Error(`lander: bad refspec ${JSON.stringify(r)}`);
      try {
        await g.run(['fetch', '--no-tags', '--no-recurse-submodules', remote, ...refspecs], { timeoutMs: fetchTimeoutMs });
        return { kind: 'ok' };
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        if (/couldn't find remote ref|no such ref was fetched/i.test(err.stderr)) return { kind: 'missing', detail: err.message };
        return { kind: 'error', detail: err.message };
      }
    },

    revParse: (r) => revParse(g, r),
    isAncestor: (a, b) => isAncestor(g, a, b),
    diffNames: (a, b) => diffNames(g, a, b),
    showBlob: (r, p) => showBlob(g, r, p),
    blobId: (r, p) => blobId(g, r, p),

    async treeOf(commit: string): Promise<string> {
      return (await g.run(['rev-parse', '--verify', '--end-of-options', `${rev(commit)}^{tree}`])).stdout.trim();
    },

    async commitInfo(commit: string): Promise<CommitInfo> {
      const r = await g.run(['log', '-1', '--date=raw', `--format=${INFO_FORMAT}`, '--end-of-options', rev(commit), '--']);
      const [info] = infos(r.stdout);
      if (!info) throw new Error(`lander: no commit ${commit}`);
      return info;
    },

    async commits(from: string, to: string, limit: number): Promise<{ total: number; commits: CommitInfo[] }> {
      if (!Number.isInteger(limit) || limit < 0) throw new Error(`lander: bad limit ${limit}`);
      const range = [rev(to), `^${rev(from)}`];
      const total = Number((await g.run(['rev-list', '--count', ...range, '--'])).stdout.trim());
      if (limit === 0 || total === 0) return { total, commits: [] };
      const r = await g.run(['log', `-n${limit}`, '--date=raw', `--format=${INFO_FORMAT}`, ...range, '--']);
      return { total, commits: infos(r.stdout).reverse() };
    },

    mergeTrees: (ours, theirs, mo) => mergeTrees(g, ours, theirs, mo),
    spliceTree: (tree, blobs) => spliceTree(g, tree, blobs),
    commitTree: (tree, parent, message, author, committer) => commitTree(g, tree, parent, message, author, committer),
    landedBase: (trunk, tip) => landedBase(g, trunk, tip),
    trunkTrailers: (from, to, limit) => trunkTrailers(g, from, to, limit),
    findLandingCommit: (from, to, key) => findLandingCommit(g, from, to, key),
    pathHistory: (from, to, p, limit) => pathHistory(g, from, to, p, limit),
    mergeFile: (blobs) => mergeFile(g, blobs),
    pushTrunk: (p) => pushTrunk(g, { remote, ...p }),
    pushRef: (p) => pushRef(g, { remote, ...p }),
    lsRemote: (ref) => lsRemote(g, remote, ref),

    async deleteLocalRef(ref: string): Promise<void> {
      if (!LOCAL_REF_RE.test(ref) || ref.includes('..')) throw new Error(`lander: bad ref ${JSON.stringify(ref)}`);
      await g.run(['update-ref', '-d', ref]);
    },
  };
}
