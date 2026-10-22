// A fake GitPort for the deterministic simulation (design §5.2): an in-memory
// object database shared by everyone, a remote with fast-forward-only
// compare-and-swap trunk updates, candidate and land refs, and one mirror per
// lander machine (its own refs, and only the objects it fetched or made).
// Commits carry their trailers (parsed from the message, as git's trailer
// reader would); trees are path → content maps. Every method mirrors what
// @agenthub/gitops does with real git, including its refusals (pushTrunk's
// C^1 == expected assertion, pushRef's allowlist) and outcome classes.
//
// It is synchronous inside (each method does its whole effect when called);
// the simulation turns each call into a scheduled step.

import { createHash } from 'node:crypto';
import type { ConflictEntry, LandedBase, LandingTrailers, MergeOptions, MergeResult, PushOutcome } from '@agenthub/gitops';
import type { CommitInfo, FetchOutcome, GitPort, MergeFileResult, PathChange } from '../../src/ports.js';

export type Tree = Readonly<Record<string, string>>;

export interface Person {
  name: string;
  email: string;
}

export interface FakeCommit {
  sha: string;
  parent: string | null;
  tree: string;
  message: string;
  author: Person & { date: string };
  committer: Person;
  /** Committer time, ms since the Unix epoch. */
  time: number;
  trailers: LandingTrailers;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const TRAILER_FIELDS: Record<string, keyof Omit<LandingTrailers, 'sha'>> = {
  'Agenthub-Landing': 'landing',
  'Agenthub-Hub': 'hub',
  'Agenthub-Source': 'source',
  'Agenthub-Attempt': 'attempt',
  'Agenthub-Task': 'task',
  'Agenthub-Agent': 'agent',
  'Agenthub-Resolved': 'resolved',
  'Agenthub-Checked': 'checked',
};

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** The Agenthub trailers of a message: the `Key: value` lines of its last paragraph (a key given twice with different values counts as absent, as in gitops). */
export function parseTrailers(sha: string, message: string): LandingTrailers {
  const out: LandingTrailers = { sha, landing: null, hub: null, source: null, attempt: null, task: null, agent: null, resolved: null, checked: null };
  const paragraphs = message.replace(/\n+$/, '').split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  const seen = new Map<string, Set<string>>();
  for (const line of last.split('\n')) {
    const m = /^(Agenthub-[A-Za-z-]+): (.*)$/.exec(line);
    if (!m || !(m[1]! in TRAILER_FIELDS)) continue;
    const values = seen.get(m[1]!) ?? new Set<string>();
    values.add(m[2]!.trim());
    seen.set(m[1]!, values);
  }
  for (const [key, values] of seen) if (values.size === 1) out[TRAILER_FIELDS[key]!] = [...values][0]!;
  return out;
}

/** Every object, content-addressed: commits, trees and blobs. */
export class ObjectDb {
  readonly commits = new Map<string, FakeCommit>();
  readonly trees = new Map<string, Tree>();
  readonly blobs = new Map<string, string>();
  private chains = new Map<string, string[]>();

  blob(content: string): string {
    const id = sha1(`blob\0${content}`);
    this.blobs.set(id, content);
    return id;
  }

  tree(entries: Tree): string {
    const sorted = Object.keys(entries).sort();
    const norm: Record<string, string> = {};
    for (const k of sorted) norm[k] = entries[k]!;
    const id = sha1(`tree\0${sorted.map((k) => `${k}\0${this.blob(norm[k]!)}`).join('\0')}`);
    if (!this.trees.has(id)) this.trees.set(id, Object.freeze(norm));
    return id;
  }

  commit(o: { tree: string; parent: string | null; message: string; author: Person & { date: string }; committer: Person; time: number }): string {
    if (!this.trees.has(o.tree)) throw new Error(`fake git: no tree ${o.tree}`);
    if (o.parent !== null && !this.commits.has(o.parent)) throw new Error(`fake git: no parent ${o.parent}`);
    const sha = sha1(JSON.stringify(['commit', o.tree, o.parent, o.message, o.author, o.committer, o.time]));
    if (!this.commits.has(sha)) this.commits.set(sha, { sha, ...o, trailers: parseTrailers(sha, o.message) });
    return sha;
  }

  get(sha: string): FakeCommit {
    const c = this.commits.get(sha);
    if (!c) throw new Error(`fake git: no commit ${sha}`);
    return c;
  }

  entries(tree: string): Tree {
    const t = this.trees.get(tree);
    if (!t) throw new Error(`fake git: no tree ${tree}`);
    return t;
  }

  /** `sha` and its ancestors, newest first (every commit here has at most one parent). */
  chain(sha: string): string[] {
    let c = this.chains.get(sha);
    if (!c) {
      const parent = this.get(sha).parent;
      c = parent === null ? [sha] : [sha, ...this.chain(parent)];
      this.chains.set(sha, c);
    }
    return c;
  }

  isAncestor(a: string, b: string): boolean {
    return this.chain(b).includes(a);
  }

  mergeBase(a: string, b: string): string | null {
    const ofA = new Set(this.chain(a));
    return this.chain(b).find((c) => ofA.has(c)) ?? null;
  }
}

/** A repository's refs and the commits it has (the remote, or one lander machine's mirror). */
export class Place {
  readonly refs = new Map<string, string>();
  readonly has = new Set<string>();
  constructor(readonly db: ObjectDb) {}

  /** Takes `sha` and every ancestor of it (what a fetch or a push transfers). */
  receive(sha: string): void {
    if (this.has.has(sha)) return;
    for (const c of this.db.chain(sha)) {
      if (this.has.has(c)) break;
      this.has.add(c);
    }
  }
}

/** What the remote does with one operation (decided by the simulation's fault plan). */
export type RemoteFate = 'ok' | 'unknown_before' | 'unknown_after' | 'rejected';

export interface RemoteHooks {
  /** Fetch and ls-remote: false means the remote can't be reached. */
  reachable?(who: string): boolean;
  trunkPush?(who: string, o: { candidate: string; expected: string }): RemoteFate;
  refPush?(who: string, o: { ref: string; sha: string | null }): RemoteFate;
  /** Called as trunk moves by a lander's push (for the invariants). */
  onTrunkUpdate?(e: { who: string; prev: string | null; next: string; expected: string }): void;
}

/** The shared remote: trunk at refs/heads/<trunk>, land and candidate refs. */
export class FakeRemote extends Place {
  /** Mutation guard 1: a plain fast-forward push instead of the compare-and-swap on T0. */
  plainPush = false;
  hooks: RemoteHooks = {};
  constructor(
    db: ObjectDb,
    readonly trunk = 'main',
  ) {
    super(db);
  }

  get trunkRef(): string {
    return `refs/heads/${this.trunk}`;
  }

  tip(): string | null {
    return this.refs.get(this.trunkRef) ?? null;
  }

  /** A push from outside agenthub (a human with a bypass), or a rewind: sets trunk as given. */
  setTrunk(sha: string): void {
    this.receive(sha);
    this.refs.set(this.trunkRef, sha);
  }
}

export interface FakeGitPortOptions {
  remote: FakeRemote;
  mirror: Place;
  /** Names the caller in the remote's hooks (a lander process). */
  who: string;
  /** Committer time for commits it makes. */
  now(): number;
  /** Mutation guard 5: findLandingCommit matches the Agenthub-Landing trailer only. */
  idOnlyTrailers?: () => boolean;
}

const LOCAL_REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;

/** The GitPort of one lander process: its machine's mirror, and the shared remote. */
export function fakeGitPort(o: FakeGitPortOptions): GitPort {
  const { remote, mirror } = o;
  const db = remote.db;

  const reachable = () => remote.hooks.reachable?.(o.who) ?? true;
  /** A commit the mirror has, from a sha, a ref, or `X^` / `X^1`. */
  const commitOf = (rev: string): string | null => {
    const m = /^(.*?)(\^1?)?$/.exec(rev)!;
    const base = m[1]!;
    let sha: string | null = null;
    if (FULL_SHA_RE.test(base)) sha = mirror.has.has(base) ? base : null;
    else if (base.startsWith('refs/')) sha = mirror.refs.get(base) ?? null;
    if (sha === null || !m[2]) return sha;
    return db.get(sha).parent;
  };
  const mustCommit = (rev: string): string => {
    const c = commitOf(rev);
    if (c === null) throw new Error(`fake git: fatal: bad revision '${rev}'`);
    return c;
  };
  /** A tree from a commit-ish or a tree id. */
  const treeOfRev = (rev: string): Tree | null => {
    if (FULL_SHA_RE.test(rev) && db.trees.has(rev) && !db.commits.has(rev)) return db.entries(rev);
    const c = commitOf(rev);
    return c === null ? null : db.entries(db.get(c).tree);
  };
  const mustTree = (rev: string): Tree => {
    const t = treeOfRev(rev);
    if (t === null) throw new Error(`fake git: fatal: bad revision '${rev}'`);
    return t;
  };
  /** First-parent commits from `to` back to (not including) the first one reachable from `from` (git log --first-parent to ^from). */
  const walk = (from: string | null, to: string): string[] => {
    const tip = mustCommit(to);
    const stop = from === null ? new Set<string>() : new Set(db.chain(mustCommit(from)));
    const out: string[] = [];
    for (const c of db.chain(tip)) {
      if (stop.has(c)) break;
      out.push(c);
    }
    return out;
  };
  const info = (sha: string): CommitInfo => {
    const c = db.get(sha);
    return { sha, subject: c.message.split('\n')[0]!, author: { ...c.author } };
  };
  const changed = (a: Tree, b: Tree): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();

  return {
    async fetch(refspecs: string[]): Promise<FetchOutcome> {
      if (!reachable()) return { kind: 'error', detail: 'fatal: unable to access the remote: connection refused' };
      const pairs = refspecs.map((r) => {
        const m = /^\+?([^:]+):(.+)$/.exec(r);
        if (!m) throw new Error(`fake git: bad refspec ${r}`);
        return { src: m[1]!, dst: m[2]! };
      });
      for (const { src } of pairs) if (!remote.refs.has(src)) return { kind: 'missing', detail: `fatal: couldn't find remote ref ${src}` };
      for (const { src, dst } of pairs) {
        const sha = remote.refs.get(src)!;
        mirror.receive(sha);
        mirror.refs.set(dst, sha);
      }
      return { kind: 'ok' };
    },

    async revParse(rev: string): Promise<string | null> {
      return commitOf(rev);
    },

    async isAncestor(a: string, b: string): Promise<boolean> {
      return db.isAncestor(mustCommit(a), mustCommit(b));
    },

    async diffNames(a: string, b: string): Promise<string[]> {
      return changed(mustTree(a), mustTree(b));
    },

    async showBlob(rev: string, path: string): Promise<string | null> {
      return treeOfRev(rev)?.[path] ?? null;
    },

    async blobId(rev: string, path: string): Promise<string | null> {
      const content = treeOfRev(rev)?.[path];
      return content === undefined ? null : db.blob(content);
    },

    async treeOf(commit: string): Promise<string> {
      return db.get(mustCommit(commit)).tree;
    },

    async commitInfo(commit: string): Promise<CommitInfo> {
      return info(mustCommit(commit));
    },

    async commits(from: string, to: string, limit: number): Promise<{ total: number; commits: CommitInfo[] }> {
      const exclude = new Set(db.chain(mustCommit(from)));
      const all = db.chain(mustCommit(to)).filter((c) => !exclude.has(c));
      return { total: all.length, commits: all.slice(0, limit).reverse().map(info) };
    },

    async mergeTrees(ours: string, theirs: string, mo: MergeOptions): Promise<MergeResult> {
      const base = mustTree(mo.base);
      const a = mustTree(ours);
      const b = mustTree(theirs);
      const out: Record<string, string> = {};
      const conflicts: ConflictEntry[] = [];
      for (const p of [...new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)])].sort()) {
        const o = base[p];
        const x = a[p];
        const y = b[p];
        let v: string | undefined;
        if (x === y) v = x;
        else if (o === x) v = y;
        else if (o === y) v = x;
        else {
          const kind = x === undefined || y === undefined ? 'modify_delete' : 'content';
          const stages: ConflictEntry['stages'] = {};
          if (o !== undefined) stages[1] = db.blob(o);
          if (x !== undefined) stages[2] = db.blob(x);
          if (y !== undefined) stages[3] = db.blob(y);
          conflicts.push({ path: p, kind, stages, mode: '100644', messages: [`CONFLICT (${kind === 'content' ? 'contents' : 'modify/delete'}): Merge conflict in ${p}`] });
          v = `<<<<<<< ${x ?? ''} ======= ${y ?? ''} >>>>>>>`;
        }
        if (v !== undefined) out[p] = v;
      }
      return { tree: db.tree(out), clean: conflicts.length === 0, conflicts, structural: [] };
    },

    async spliceTree(tree: string, blobs: Array<{ path: string; mode: string; content: string }>): Promise<string> {
      const t = { ...db.entries(tree) };
      for (const b of blobs) t[b.path] = b.content;
      return db.tree(t);
    },

    async commitTree(tree: string, parent: string, message: string, author: Person & { date: string }, committer: Person): Promise<string> {
      const p = mustCommit(parent);
      const sha = db.commit({ tree, parent: p, message, author, committer, time: o.now() });
      mirror.has.add(sha);
      return sha;
    },

    async landedBase(trunk: string, tip: string): Promise<LandedBase> {
      // gitops' landedBase (design §1.1), on this object model.
      const T = mustCommit(trunk);
      const X = mustCommit(tip);
      const B = db.mergeBase(T, X);
      if (!B) throw new Error(`fake git: ${tip} has no history in common with ${trunk}`);
      const atB: LandedBase = { base: B, landedSource: null, reason: 'merge-base' };
      const sources = [...new Set(db.chain(T).slice(0, 500).map((c) => db.get(c).trailers.source).filter((s): s is string => s !== null && FULL_SHA_RE.test(s)))];
      if (sources.length === 0) return atB;
      const ofB = new Set(db.chain(B));
      const ahead = new Set(db.chain(X).filter((c) => !ofB.has(c)));
      const first = sources.findIndex((s) => ahead.has(s));
      const newer = first < 0 ? sources : sources.slice(0, first);
      if (newer.some((s) => mirror.has.has(s) && db.isAncestor(s, B))) return atB;
      if (first < 0) return atB;
      return { base: sources[first]!, landedSource: sources[first]!, reason: 'landed-source' };
    },

    async trunkTrailers(from: string | null, to: string, limit?: number): Promise<LandingTrailers[]> {
      const commits = walk(from, to);
      return (limit !== undefined ? commits.slice(0, limit) : commits).reverse().map((c) => ({ ...db.get(c).trailers }));
    },

    async findLandingCommit(from: string | null, to: string, key: { landing: string; hub: string; source: string }): Promise<string | null> {
      if (!key.landing || !key.hub || !FULL_SHA_RE.test(key.source)) return null;
      const idOnly = o.idOnlyTrailers?.() === true;
      for (const c of walk(from, to)) {
        const t = db.get(c).trailers;
        if (t.landing === key.landing && (idOnly || (t.hub === key.hub && t.source === key.source))) return c;
      }
      return null;
    },

    async pathHistory(from: string, to: string, path: string, limit: number): Promise<PathChange[]> {
      const out: PathChange[] = [];
      for (const c of walk(from, to)) {
        const commit = db.get(c);
        const before = commit.parent === null ? undefined : db.entries(db.get(commit.parent).tree)[path];
        if (db.entries(commit.tree)[path] !== before) out.push({ ...commit.trailers, subject: commit.message.split('\n')[0]! });
        if (out.length >= limit) break;
      }
      return out;
    },

    async mergeFile(blobs: { trunk: string | null; base: string | null; yours: string | null }): Promise<MergeFileResult> {
      const text = (id: string | null) => (id === null ? '' : (db.blobs.get(id) ?? ''));
      return { text: `<<<<<<< trunk\n${text(blobs.trunk)}\n||||||| base\n${text(blobs.base)}\n=======\n${text(blobs.yours)}\n>>>>>>> yours\n`, conflicts: 1, markerSize: 7 };
    },

    async pushTrunk(p: { trunk: string; candidate: string; expected: string; deleteRef?: string }): Promise<PushOutcome> {
      // gitops.pushTrunk's assertions: a matching lease alone would force a non-fast-forward.
      const C = mustCommit(p.candidate);
      const parent = db.get(C).parent;
      if (parent !== p.expected) throw new Error(`gitops: refusing to push ${C}: its first parent is ${parent ?? 'missing'}, not the expected tip ${p.expected}`);
      if (!db.isAncestor(p.expected, C)) throw new Error(`gitops: refusing to push ${C}: ${p.expected} is not its ancestor`);
      if (p.trunk !== remote.trunk) throw new Error(`fake git: this remote's trunk is ${remote.trunk}, not ${p.trunk}`);
      const fate = remote.hooks.trunkPush?.(o.who, { candidate: C, expected: p.expected }) ?? 'ok';
      if (fate === 'unknown_before') return { kind: 'unknown', detail: 'fatal: the remote end hung up unexpectedly' };
      if (fate === 'rejected') return { kind: 'rejected', detail: `${remote.trunkRef}: [remote rejected] (protected branch hook declined)` };
      const prev = remote.tip();
      let out: PushOutcome;
      if (prev === C) {
        out = { kind: 'up_to_date' };
      } else if (remote.plainPush ? prev !== null && !db.isAncestor(prev, C) : prev !== p.expected) {
        return { kind: 'stale', detail: `${remote.trunkRef}: [rejected] (${remote.plainPush ? 'non-fast-forward' : 'stale info'})` };
      } else {
        remote.receive(C);
        remote.refs.set(remote.trunkRef, C);
        remote.hooks.onTrunkUpdate?.({ who: o.who, prev, next: C, expected: p.expected });
        out = { kind: 'ok' };
      }
      // Atomic with the trunk update: the land ref goes too (deleting a missing ref is a warning, not a failure).
      if (p.deleteRef !== undefined) remote.refs.delete(p.deleteRef);
      if (fate === 'unknown_after') return { kind: 'unknown', detail: 'error: RPC failed; the remote end hung up after the update' };
      return out;
    },

    async pushRef(p: { prefix: string; sha: string | null; ref: string }): Promise<PushOutcome> {
      const allowed = [`${p.prefix}land/`, `${p.prefix}cand/`];
      if (!allowed.some((a) => p.ref.startsWith(a) && p.ref.length > a.length)) throw new Error(`gitops: refusing to push ref ${JSON.stringify(p.ref)}`);
      if (p.sha !== null) mustCommit(p.sha);
      const fate = remote.hooks.refPush?.(o.who, { ref: p.ref, sha: p.sha }) ?? 'ok';
      if (fate === 'unknown_before') return { kind: 'unknown', detail: 'fatal: the remote end hung up unexpectedly' };
      if (fate === 'rejected') return { kind: 'rejected', detail: `${p.ref}: [remote rejected] (hook declined)` };
      let out: PushOutcome;
      const existing = remote.refs.get(p.ref);
      if (p.sha === null) {
        remote.refs.delete(p.ref);
        out = { kind: 'ok' };
      } else if (existing === p.sha) {
        out = { kind: 'up_to_date' };
      } else if (existing !== undefined) {
        return { kind: 'stale', detail: `${p.ref}: [rejected] (already exists)` };
      } else {
        remote.receive(p.sha);
        remote.refs.set(p.ref, p.sha);
        out = { kind: 'ok' };
      }
      if (fate === 'unknown_after') return { kind: 'unknown', detail: 'error: RPC failed after the update' };
      return out;
    },

    async lsRemote(ref: string): Promise<string | null> {
      if (!reachable()) throw new Error('fake git: git ls-remote exited 128: unable to access the remote');
      return remote.refs.get(ref) ?? null;
    },

    async deleteLocalRef(ref: string): Promise<void> {
      if (!LOCAL_REF_RE.test(ref)) throw new Error(`lander: bad ref ${JSON.stringify(ref)}`);
      mirror.refs.delete(ref);
    },

    async listRemoteRefs(patterns: string[]): Promise<Array<{ ref: string; sha: string }>> {
      if (!reachable()) throw new Error('fake git: git ls-remote exited 128: unable to access the remote');
      const match = (ref: string) => patterns.some((p) => (p.endsWith('*') ? ref.startsWith(p.slice(0, -1)) : ref === p));
      return [...remote.refs]
        .filter(([ref]) => match(ref))
        .map(([ref, sha]) => ({ ref, sha }))
        .sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
    },

    async localRefs(prefix: string): Promise<Array<{ ref: string; sha: string }>> {
      return [...mirror.refs]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([ref, sha]) => ({ ref, sha }))
        .sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
    },

    async committedAt(commit: string): Promise<number | null> {
      return mirror.has.has(commit) ? db.get(commit).time : null;
    },

    async numstat(a: string, b: string): Promise<Array<{ path: string; added: number; removed: number }>> {
      const x = mustTree(a);
      const y = mustTree(b);
      const lines = (s: string | undefined) => (s === undefined || s === '' ? 0 : s.split('\n').length);
      return changed(x, y).map((path) => ({ path, added: lines(y[path]), removed: lines(x[path]) }));
    },

    async pruneWorktrees(): Promise<void> {},
  };
}
