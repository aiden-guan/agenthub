// The merge ladder's git half (design §2.2.6): merge-tree pinned to trunk's
// attributes, the -z output parsed, the structural stage confined to the paths
// stage 1 left conflicted; spliceTree and commitTree.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitTree, mergeTrees, open, showBlob, spliceTree } from '../src/index.js';
import type { Git, StructuralDriver } from '../src/types.js';
import { IDENT_ENV, Repo, sh, tmp, type Tmp } from './helpers.js';

const FAKE_DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-driver.mjs');

let t: Tmp;
let work: Repo;
beforeEach(() => {
  t = tmp();
  work = Repo.init(path.join(t.dir, 'work'));
});
afterEach(() => t.cleanup());

type Files = Parameters<Repo['commit']>[1];

/** Commit `base`, then `trunk` on main and `agent` on a branch; return the shas and an isolated bare mirror. */
function setup(base: Files, trunk: Files, agent: Files) {
  const B = work.commit('base', base);
  work.checkout('-b', 'agent');
  const H = work.commit('agent change', agent);
  work.checkout('main');
  const T0 = work.commit('trunk change', trunk);
  const mirror = path.join(t.dir, 'mirror.git');
  sh(t.dir, ['clone', '-q', '--bare', work.dir, mirror]);
  const g = open(mirror, { isolated: true, env: IDENT_ENV });
  return { B, H, T0, g, mirror };
}

function lsTree(g: Git, tree: string): Map<string, string> {
  const out = sh(g.dir, ['ls-tree', '-r', '-z', tree]);
  return new Map(out.split('\0').filter(Boolean).map((l) => [l.slice(l.indexOf('\t') + 1), l.slice(0, l.indexOf('\t'))]));
}

function blob(g: Git, tree: string, p: string): string {
  return sh(g.dir, ['cat-file', 'blob', `${tree}:${p}`]);
}

describe('mergeTrees, stage 1 (plain)', () => {
  it('merges a clean change into a tree', async () => {
    const { B, H, T0, g } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, { 'a.txt': 'A\n' }, { 'b.txt': 'B\n' });
    const r = await mergeTrees(g, T0, H, { base: B, attrSource: T0 });
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(blob(g, r.tree, 'a.txt')).toBe('A\n');
    expect(blob(g, r.tree, 'b.txt')).toBe('B\n');
  });

  it('the union attack: an incoming .gitattributes with merge=union resolves nothing under attrSource = T0', async () => {
    const { B, H, T0, g } = setup(
      { 'src/a.ts': 'line1\nshared\nline3\n' },
      { 'src/a.ts': 'line1\ntrunk\nline3\n' },
      { 'src/a.ts': 'line1\nagent\nline3\n', '.gitattributes': '*.ts merge=union\n' },
    );
    const pinned = await mergeTrees(g, T0, H, { base: B, attrSource: T0 });
    expect(pinned.clean).toBe(false);
    expect(pinned.conflicts.map((c) => [c.path, c.kind])).toEqual([['src/a.ts', 'content']]);
    // merge.conflictStyle=diff3 comes from the isolation flags: the base side is in the markers.
    expect(blob(g, pinned.tree, 'src/a.ts')).toMatch(/<<<<<<< [^\n]*\ntrunk\n\|\|\|\|\|\|\| [^\n]*\nshared\n=======\nagent\n>>>>>>> /);
    // Read from the branch, the same attributes would have merged it silently: that is the attack.
    const fromBranch = await mergeTrees(g, T0, H, { base: B, attrSource: H });
    expect(fromBranch.clean).toBe(true);
  });

  it("applies trunk's own attributes", async () => {
    const { B, H, T0, g } = setup(
      { 'src/a.ts': 'line1\nshared\nline3\n', '.gitattributes': '*.ts merge=union\n' },
      { 'src/a.ts': 'line1\ntrunk\nline3\n' },
      { 'src/a.ts': 'line1\nagent\nline3\n' },
    );
    const r = await mergeTrees(g, T0, H, { base: B, attrSource: T0 });
    expect(r.clean).toBe(true);
    expect(blob(g, r.tree, 'src/a.ts')).toBe('line1\ntrunk\nagent\nline3\n');
  });

  it('parses content, modify/delete, rename/delete, binary and mode conflicts', async () => {
    const { B, H, T0, g } = setup(
      {
        'content.txt': 'a\nb\nc\n',
        'md.txt': 'x\ny\n',
        'rd.txt': 'r1\nr2\nr3\nr4\nr5\n',
        'b.bin': Buffer.from([0, 1, 98, 105, 110]),
      },
      { 'content.txt': 'a\nTRUNK\nc\n', 'md.txt': null, 'rd.txt': null, 'rd-trunk.txt': 'r1\nr2\nr3\nr4\nr5\n', 'b.bin': Buffer.from([0, 3, 116]), kind: 'a regular file\n' },
      { 'content.txt': 'a\nAGENT\nc\n', 'md.txt': 'x\nY\n', 'rd.txt': null, 'b.bin': Buffer.from([0, 2, 97]), kind: { link: 'target' } },
    );
    const r = await mergeTrees(g, T0, H, { base: B, attrSource: T0 });
    expect(r.clean).toBe(false);
    const by = new Map(r.conflicts.map((c) => [c.path, c]));
    expect(by.get('content.txt')).toMatchObject({ kind: 'content', mode: '100644' });
    expect(Object.keys(by.get('content.txt')!.stages).sort()).toEqual(['1', '2', '3']);
    expect(by.get('content.txt')!.messages.join('\n')).toContain('Merge conflict in content.txt');
    expect(by.get('md.txt')).toMatchObject({ kind: 'modify_delete' });
    expect(Object.keys(by.get('md.txt')!.stages).sort()).toEqual(['1', '3']);
    expect(by.get('rd-trunk.txt')).toMatchObject({ kind: 'rename' });
    expect(by.get('rd-trunk.txt')!.messages.join('\n')).toContain('rename/delete');
    expect(by.get('b.bin')).toMatchObject({ kind: 'binary' });
    // A regular file on trunk and a symlink from the agent: git keeps both, renaming trunk's one aside.
    const modes = r.conflicts.filter((c) => c.kind === 'mode');
    expect(modes.map((c) => c.path).sort()).toEqual(['kind', expect.stringMatching(/^kind~/)]);
    expect(by.get('kind')).toMatchObject({ mode: '120000', stages: { 3: expect.any(String) } });
    expect(r.conflicts.every((c) => c.kind !== 'other')).toBe(true);
    // Every stage id is a blob that exists in the mirror.
    for (const c of r.conflicts) for (const id of Object.values(c.stages)) expect(sh(g.dir, ['cat-file', '-t', id!]).trim()).toBe('blob');
  });

  it('truncates a leftover info/attributes before the plain stage', async () => {
    const { B, H, T0, g, mirror } = setup({ 'x.ts': 'a\n' }, { 'x.ts': 'b\n' }, { 'x.ts': 'c\n' });
    const attrs = path.join(mirror, 'info', 'attributes');
    writeFileSync(attrs, '*.ts merge=union\n');
    const r = await mergeTrees(g, T0, H, { base: B, attrSource: T0 });
    expect(r.clean).toBe(false);
    expect(readFileSync(attrs, 'utf8')).toBe('');
  });
});

describe('mergeTrees, stage 2 (structural)', () => {
  function driverSetup() {
    const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
    const s = setup(
      { 'x.ts': 'function a() {}\n', 'y.ts': `${ten.join('\n')}\n`, 'z.txt': 'z\n' },
      { 'x.ts': 'function a() {}\nfunction b() {}\n', 'y.ts': `${ten.map((l) => (l === 'l2' ? 'L2-trunk' : l)).join('\n')}\n`, 'z.txt': 'Z\n' },
      { 'x.ts': 'function a() {}\nfunction c() {}\n', 'y.ts': `${ten.map((l) => (l === 'l9' ? 'L9-agent' : l)).join('\n')}\n` },
    );
    const log = path.join(t.dir, 'driver.log');
    writeFileSync(log, '');
    const driver: StructuralDriver = { name: 'agenthub-structural', command: `"${process.execPath}" "${FAKE_DRIVER}" "${log}" %O %A %B %P`, patterns: ['*.ts'] };
    return { ...s, log, driver };
  }

  it('runs the driver only in stage 2 and takes its blob only for paths stage 1 left conflicted', async () => {
    const { B, H, T0, g, mirror, log, driver } = driverSetup();
    const plain = await mergeTrees(g, T0, H, { base: B, attrSource: T0 });
    expect(plain.conflicts.map((c) => c.path)).toEqual(['x.ts']);
    expect(readFileSync(log, 'utf8')).toBe('');

    const r = await mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [driver] });
    // The driver ran in stage 2, on the conflicted x.ts and on y.ts, which git had merged cleanly.
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['x.ts', 'y.ts']);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.structural).toEqual(['x.ts']);
    expect(blob(g, r.tree, 'x.ts')).toBe('function a() {}\nfunction b() {}\nfunction c() {}\n// merged by fake-driver\n');
    // Everything else is byte-identical to the plain merge: y.ts keeps git's clean merge, not the driver's rewrite.
    const before = lsTree(g, plain.tree);
    const after = lsTree(g, r.tree);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [p, entry] of before) if (p !== 'x.ts') expect(after.get(p)).toBe(entry);
    expect(blob(g, r.tree, 'y.ts')).not.toContain('fake-driver');
    expect(readFileSync(path.join(mirror, 'info', 'attributes'), 'utf8')).toBe('');
  });

  it('serializes merges on one mirror, so a plain merge never truncates a running stage 2', async () => {
    const { B, H, T0, g, driver } = driverSetup();
    const results = await Promise.all([
      mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [driver] }),
      mergeTrees(g, T0, H, { base: B, attrSource: T0 }),
      mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [driver] }),
    ]);
    expect(results.map((r) => r.clean)).toEqual([true, false, true]);
    expect(results[0]!.tree).toBe(results[2]!.tree);
  });

  it('keeps the stage-1 conflict when the driver can not resolve it', async () => {
    const { B, H, T0, g, log } = driverSetup();
    const failing: StructuralDriver = { name: 'agenthub-structural', command: `echo %P >> "${log}"; exit 1`, patterns: ['*.ts'] };
    const r = await mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [failing] });
    expect(r.clean).toBe(false);
    expect(r.conflicts.map((c) => [c.path, c.kind])).toEqual([['x.ts', 'content']]);
    expect(r.structural).toEqual([]);
    expect(readFileSync(log, 'utf8')).toContain('x.ts');
  });

  it('refuses structural drivers outside a bare mirror, and odd driver names or patterns', async () => {
    const { B, H, T0, driver } = driverSetup();
    const wt = open(work.dir, { isolated: true, env: IDENT_ENV });
    await expect(mergeTrees(wt, T0, H, { base: B, attrSource: T0, drivers: [driver] })).rejects.toThrow(/bare/);
    const g = open(path.join(t.dir, 'mirror.git'), { isolated: true, env: IDENT_ENV });
    await expect(mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [{ ...driver, name: 'x y' }] })).rejects.toThrow(/driver name/);
    await expect(mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [{ ...driver, patterns: ['*.ts\n* merge=union'] }] })).rejects.toThrow(/pattern/);
    expect(existsSync(path.join(work.dir, '.git', 'info', 'attributes')) ? readFileSync(path.join(work.dir, '.git', 'info', 'attributes'), 'utf8') : '').not.toContain('agenthub');
  });
});

describe('spliceTree and commitTree', () => {
  it('replaces and adds blobs through a temporary index, touching no index or ref', async () => {
    const { T0, g, mirror } = setup({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' }, { 'a.txt': 'A\n' }, { 'c.txt': 'c\n' });
    const refsBefore = sh(mirror, ['for-each-ref']);
    const base = sh(mirror, ['rev-parse', `${T0}^{tree}`]).trim();
    const tree = await spliceTree(g, base, [
      { path: 'a.txt', mode: '100644', content: 'spliced\n' },
      { path: 'dir/new.sh', mode: '100755', content: '#!/bin/sh\n' },
    ]);
    expect(blob(g, tree, 'a.txt')).toBe('spliced\n');
    expect(await showBlob(g, tree, 'dir/new.sh')).toBe('#!/bin/sh\n');
    const entries = lsTree(g, tree);
    expect(entries.get('dir/new.sh')).toMatch(/^100755 blob /);
    expect(entries.get('dir/b.txt')).toBe(lsTree(g, base).get('dir/b.txt'));
    expect(lsTree(g, base).get('a.txt')).not.toBe(entries.get('a.txt'));
    expect(existsSync(path.join(mirror, 'index'))).toBe(false);
    expect(sh(mirror, ['for-each-ref'])).toBe(refsBefore);
    await expect(spliceTree(g, base, [{ path: '../escape', mode: '100644', content: 'x' }])).rejects.toThrow(/path/);
    await expect(spliceTree(g, base, [{ path: 'a.txt', mode: '040000', content: 'x' }])).rejects.toThrow(/mode/);
  });

  it('commits a tree with the given author and committer, and the message exactly', async () => {
    const { T0, g } = setup({ 'a.txt': 'a\n' }, { 'a.txt': 'A\n' }, { 'b.txt': 'b\n' });
    const tree = sh(g.dir, ['rev-parse', `${T0}^{tree}`]).trim();
    const message = 'Subject line (L-7)\n\nBody.\n\nAgenthub-Landing: acme/web/L-7\n';
    const c = await commitTree(g, tree, T0, message, { name: 'Sam Agent', email: 'sam@example.com', date: '1767225600 +0100' }, { name: 'agenthub lander', email: 'lander@localhost' });
    const raw = sh(g.dir, ['cat-file', 'commit', c]);
    expect(raw).toContain(`tree ${tree}\nparent ${T0}\n`);
    expect(raw).toContain('author Sam Agent <sam@example.com> 1767225600 +0100\n');
    expect(raw).toMatch(/committer agenthub lander <lander@localhost> \d+ [+-]\d{4}\n/);
    expect(raw.slice(raw.indexOf('\n\n') + 2)).toBe(message);
  });
});
