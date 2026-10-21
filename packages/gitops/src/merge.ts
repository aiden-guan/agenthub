// The git half of the merge ladder (design §2.2.6): merge-tree pinned to
// trunk's attributes, its -z output parsed, and the structural stage, whose
// result is taken only for paths the plain stage left conflicted. Plus the
// object-database helpers built on a temporary index: spliceTree, commitTree.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRev, FULL_SHA_RE, validRepoPath } from './run.js';
import type { ConflictEntry, ConflictKind, Git, MergeOptions, MergeResult, StructuralDriver } from './types.js';

/** mergeTrees' result: the frozen MergeResult, plus which paths the structural stage resolved. */
export interface MergeTreesResult extends MergeResult {
  /** Paths stage 1 left conflicted whose stage-2 (structural) blob was spliced in, sorted. */
  structural: string[];
}

/** One informational or conflict message of `merge-tree --messages`. */
export interface MergeMessage {
  paths: string[];
  /** git's short type, e.g. `Auto-merging`, `CONFLICT (contents)`, `CONFLICT (modify/delete)`. */
  type: string;
  text: string;
}

export interface ParsedMergeTree {
  tree: string;
  entries: Array<{ mode: string; oid: string; stage: 1 | 2 | 3; path: string }>;
  messages: MergeMessage[];
}

/**
 * Parse `git merge-tree --write-tree -z --messages` (format verified by GN):
 *   tree NUL (mode SP oid SP stage TAB path NUL)* NUL (count NUL path{count} NUL type NUL message NUL)*
 */
export function parseMergeTree(stdout: string): ParsedMergeTree {
  const parts = stdout.split('\0');
  const tree = (parts[0] ?? '').trim();
  if (!FULL_SHA_RE.test(tree)) throw new Error(`gitops: merge-tree printed no tree: ${JSON.stringify(stdout.slice(0, 120))}`);
  let i = 1;
  const entries: ParsedMergeTree['entries'] = [];
  for (; i < parts.length && parts[i] !== ''; i++) {
    const m = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(parts[i]!);
    if (!m) throw new Error(`gitops: unexpected merge-tree entry ${JSON.stringify(parts[i])}`);
    entries.push({ mode: m[1]!, oid: m[2]!, stage: Number(m[3]) as 1 | 2 | 3, path: m[4]! });
  }
  i++;
  const messages: MergeMessage[] = [];
  while (i < parts.length && parts[i] !== '') {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || i + n + 2 >= parts.length) throw new Error(`gitops: unexpected merge-tree message block at ${JSON.stringify(parts[i])}`);
    messages.push({ paths: parts.slice(i + 1, i + 1 + n), type: parts[i + 1 + n]!, text: parts[i + 2 + n]!.replace(/\n+$/, '') });
    i += n + 3;
  }
  return { tree, entries, messages };
}

/** Most specific first: a binary file also gets a `CONFLICT (contents)` message. */
const KIND_ORDER: ConflictKind[] = ['binary', 'modify_delete', 'rename', 'mode', 'other', 'content'];

function kindOf(type: string): ConflictKind | null {
  if (!type.startsWith('CONFLICT')) return null;
  if (type === 'CONFLICT (contents)') return 'content';
  if (type === 'CONFLICT (binary)') return 'binary';
  if (type === 'CONFLICT (modify/delete)') return 'modify_delete';
  if (type.startsWith('CONFLICT (rename')) return 'rename';
  if (type === 'CONFLICT (distinct modes)') return 'mode';
  return 'other';
}

/** Group a parsed merge-tree output into one ConflictEntry per conflicted path, sorted by path. */
export function conflictsOf(parsed: ParsedMergeTree): ConflictEntry[] {
  const byPath = new Map<string, ConflictEntry>();
  const entry = (p: string): ConflictEntry => {
    let e = byPath.get(p);
    if (!e) byPath.set(p, (e = { path: p, kind: 'other', stages: {}, mode: null, messages: [] }));
    return e;
  };
  const modes = new Map<string, { 1?: string; 2?: string; 3?: string }>();
  for (const s of parsed.entries) {
    entry(s.path).stages[s.stage] = s.oid;
    const m = modes.get(s.path) ?? {};
    m[s.stage] = s.mode;
    modes.set(s.path, m);
  }
  // With no index stages at all, the paths of the CONFLICT messages stand in, so a conflicted merge never reads as clean.
  if (byPath.size === 0) for (const m of parsed.messages) if (kindOf(m.type) !== null) for (const p of m.paths) entry(p);
  for (const e of byPath.values()) {
    const m = modes.get(e.path) ?? {};
    e.mode = m[2] ?? m[3] ?? m[1] ?? null;
    const kinds = new Set<ConflictKind>();
    for (const msg of parsed.messages) {
      if (!msg.paths.includes(e.path)) continue;
      e.messages.push(msg.text);
      const k = kindOf(msg.type);
      if (k) kinds.add(k);
    }
    e.kind = KIND_ORDER.find((k) => kinds.has(k)) ?? (e.stages[1] && e.stages[2] && e.stages[3] ? 'content' : 'other');
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function mergeTreeOnce(g: Git, ours: string, theirs: string, base: string, attrSource: string): Promise<{ parsed: ParsedMergeTree; conflicts: ConflictEntry[]; clean: boolean }> {
  const r = await g.run([`--attr-source=${attrSource}`, 'merge-tree', '--write-tree', '-z', '--messages', `--merge-base=${base}`, ours, theirs], { ok: [0, 1] });
  const parsed = parseMergeTree(r.stdout);
  const conflicts = conflictsOf(parsed);
  if (r.code === 1 && conflicts.length === 0) throw new Error('gitops: merge-tree reported a conflict without naming it');
  return { parsed, conflicts, clean: r.code === 0 };
}

const DRIVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** One attributes pattern: no whitespace (it would end the pattern), no comment or negation. */
const PATTERN_RE = /^[^\s#!"][^\s"]*$/;

/** `info/attributes` of a bare mirror: gitops owns it, writing it only for stage 2. */
async function attributesFile(g: Git): Promise<string> {
  const r = await g.run(['rev-parse', '--git-path', 'info/attributes']);
  return path.resolve(g.dir, r.stdout.trim());
}

/**
 * The plain and structural stages of the merge ladder (design §2.2.6).
 * Stage 1 runs with an empty `info/attributes` and no drivers. Stage 2 (only
 * with drivers, only if stage 1 conflicted) writes the drivers' patterns to
 * `info/attributes`, defines them with `-c`, merges again, and splices into
 * stage 1's tree only the blobs of paths stage 1 left conflicted that stage 2
 * merged cleanly. `info/attributes` is truncated afterwards, whatever happens.
 */
export async function mergeTrees(g: Git, ours: string, theirs: string, o: MergeOptions): Promise<MergeTreesResult> {
  for (const [what, rev] of [['ours', ours], ['theirs', theirs], ['base', o.base], ['attrSource', o.attrSource]] as const) assertRev(rev, what);
  const drivers = o.drivers ?? [];
  for (const d of drivers) {
    if (!DRIVER_NAME_RE.test(d.name)) throw new Error(`gitops: bad driver name ${JSON.stringify(d.name)}`);
    if (!d.command || /[\n\r\0]/.test(d.command)) throw new Error(`gitops: bad driver command for ${d.name}`);
    for (const p of d.patterns) if (!PATTERN_RE.test(p)) throw new Error(`gitops: bad attributes pattern ${JSON.stringify(p)}`);
  }
  if (drivers.length > 0 && !g.bare) throw new Error("gitops: structural drivers run only in the lander's bare mirror (they write its info/attributes)");
  if (!g.bare) return ladder(g, ours, theirs, o, [], null);
  const attrs = await attributesFile(g);
  // One merge at a time per mirror in this process, so a plain stage never truncates another call's stage 2.
  return serialized(attrs, async () => {
    // A leftover from a crash mid-stage-2 must not reach the plain stage.
    if (readOr(attrs, '') !== '') writeFileSync(attrs, '');
    return ladder(g, ours, theirs, o, drivers, attrs);
  });
}

async function ladder(g: Git, ours: string, theirs: string, o: MergeOptions, drivers: StructuralDriver[], attrs: string | null): Promise<MergeTreesResult> {
  const stage1 = await mergeTreeOnce(g, ours, theirs, o.base, o.attrSource);
  if (stage1.clean || drivers.length === 0) return { tree: stage1.parsed.tree, clean: stage1.clean, conflicts: stage1.conflicts, structural: [] };

  let stage2: Awaited<ReturnType<typeof mergeTreeOnce>>;
  try {
    mkdirSync(path.dirname(attrs!), { recursive: true });
    writeFileSync(attrs!, drivers.flatMap((d) => d.patterns.map((p) => `${p} merge=${d.name}\n`)).join(''));
    stage2 = await mergeTreeOnce(g.with(driverConfig(drivers)), ours, theirs, o.base, o.attrSource);
  } finally {
    writeFileSync(attrs!, '');
  }

  const stillConflicted = new Set(stage2.conflicts.map((c) => c.path));
  const take: Array<{ path: string; mode: string; oid: string }> = [];
  for (const c of stage1.conflicts) {
    if (stillConflicted.has(c.path)) continue;
    const entry = await treeEntry(g, stage2.parsed.tree, c.path);
    if (entry && entry.type === 'blob') take.push({ path: c.path, mode: entry.mode, oid: entry.oid });
  }
  if (take.length === 0) return { tree: stage1.parsed.tree, clean: false, conflicts: stage1.conflicts, structural: [] };
  const taken = new Set(take.map((t) => t.path));
  const tree = await spliceOids(g, stage1.parsed.tree, take);
  const conflicts = stage1.conflicts.filter((c) => !taken.has(c.path));
  return { tree, clean: conflicts.length === 0, conflicts, structural: [...taken].sort() };
}

const queues = new Map<string, Promise<void>>();

/** Run `fn` after every earlier call queued under `key` has settled. */
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  try {
    return await result;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

function driverConfig(drivers: StructuralDriver[]): Record<string, string> {
  const config: Record<string, string> = {};
  for (const d of drivers) {
    config[`merge.${d.name}.name`] = d.name;
    config[`merge.${d.name}.driver`] = d.command;
  }
  return config;
}

async function treeEntry(g: Git, tree: string, p: string): Promise<{ mode: string; type: string; oid: string } | null> {
  const r = await g.run(['ls-tree', '-z', '--full-tree', tree, '--', p], { env: { GIT_LITERAL_PATHSPECS: '1' } });
  for (const rec of r.stdout.split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
    if (m && m[4] === p) return { mode: m[1]!, type: m[2]!, oid: m[3]! };
  }
  return null;
}

function readOr(file: string, fallback: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

const MODES = new Set(['100644', '100755', '120000']);

/** Replace blobs in a tree through a temporary index; no worktree, no ref, no real index. */
export async function spliceTree(g: Git, tree: string, blobs: Array<{ path: string; mode: string; content: string }>): Promise<string> {
  assertRev(tree, 'tree');
  for (const b of blobs) {
    if (!validRepoPath(b.path)) throw new Error(`gitops: bad path ${JSON.stringify(b.path)}`);
    if (!MODES.has(b.mode)) throw new Error(`gitops: bad mode ${JSON.stringify(b.mode)} for ${b.path}`);
  }
  const entries: Array<{ path: string; mode: string; oid: string }> = [];
  for (const b of blobs) {
    const oid = (await g.run(['hash-object', '-w', '--stdin', '--no-filters'], { input: b.content })).stdout.trim();
    entries.push({ path: b.path, mode: b.mode, oid });
  }
  return spliceOids(g, tree, entries);
}

/** spliceTree for blobs already in the object database. */
export async function spliceOids(g: Git, tree: string, entries: Array<{ path: string; mode: string; oid: string }>): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitops-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    await g.run(['read-tree', tree], { env });
    if (entries.length > 0) {
      await g.run(['update-index', '-z', '--index-info'], { env, input: entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join('') });
    }
    return (await g.run(['write-tree'], { env })).stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function commitTree(
  g: Git,
  tree: string,
  parent: string,
  message: string,
  author: { name: string; email: string; date: string },
  committer: { name: string; email: string },
): Promise<string> {
  assertRev(tree, 'tree');
  assertRev(parent, 'parent');
  const r = await g.run(['commit-tree', tree, '-p', parent], {
    input: message,
    env: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    },
  });
  return r.stdout.trim();
}

/** Paths that would conflict merging `work` onto `trunk` (`merge-tree --name-only`). Writes only objects. */
export async function forecastConflicts(g: Git, trunk: string, work: string, base?: string): Promise<string[]> {
  assertRev(trunk);
  assertRev(work);
  if (base !== undefined) assertRev(base, 'base');
  const r = await g.run(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', ...(base ? [`--merge-base=${base}`] : []), trunk, work], { ok: [0, 1] });
  return r.code === 0 ? [] : conflictedNames(r.stdout);
}

/** The conflicted paths of `merge-tree --write-tree -z --name-only --no-messages` output. */
export function conflictedNames(stdout: string): string[] {
  const parts = stdout.split('\0');
  const names: string[] = [];
  for (let i = 1; i < parts.length && parts[i] !== ''; i++) names.push(parts[i]!);
  return [...new Set(names)].sort();
}
