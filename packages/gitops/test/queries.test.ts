// The read-only queries: revParse, isAncestor, mergeBase, diffNames, showBlob, blobId.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobId, diffNames, isAncestor, mergeBase, revParse, showBlob } from '../src/index.js';
import type { Git } from '../src/types.js';
import { Repo, sh, tmp, type Tmp } from './helpers.js';

let t: Tmp;
let r: Repo;
let g: Git;
let c1: string;
let c2: string;
let side: string;
beforeEach(() => {
  t = tmp();
  r = Repo.init(path.join(t.dir, 'w'));
  c1 = r.commit('one', { 'a.txt': 'a\n', 'dir/b.txt': 'b\n', 'old.txt': 'moved\n' });
  // An NFD name, as macOS writes it; diffNames reports it NFC.
  c2 = r.commit('two', { 'a.txt': 'A\n', 'old.txt': null, 'new.txt': 'moved\n', 'cafe\u{301}.txt': 'x\n' });
  r.checkout('-b', 'side', c1);
  side = r.commit('side', { 's.txt': 's\n' });
  g = r.open();
});
afterEach(() => t.cleanup());

describe('queries', () => {
  it('revParse resolves revisions to full ids, and null for what does not exist', async () => {
    expect(await revParse(g, 'main')).toBe(c2);
    expect(await revParse(g, `${c2}^`)).toBe(c1);
    expect(await revParse(g, `${c2}^{tree}`)).toBe(sh(r.dir, ['rev-parse', `${c2}^{tree}`]).trim());
    expect(await revParse(g, 'no-such-branch')).toBeNull();
    expect(await revParse(g, 'f'.repeat(40))).toBeNull();
    expect(await revParse(g, `${c1}^2`)).toBeNull();
    expect(await revParse(g, '--all')).toBeNull();
    expect(await revParse(g, '')).toBeNull();
  });

  it('isAncestor and mergeBase', async () => {
    expect(await isAncestor(g, c1, c2)).toBe(true);
    expect(await isAncestor(g, c2, c1)).toBe(false);
    expect(await isAncestor(g, c2, c2)).toBe(true);
    expect(await mergeBase(g, c2, side)).toBe(c1);
    r.checkout('--orphan', 'lonely');
    const lonely = r.commit('lonely', { 'z.txt': 'z\n' });
    expect(await mergeBase(g, c2, lonely)).toBeNull();
    await expect(isAncestor(g, 'f'.repeat(40), c2)).rejects.toThrow();
  });

  it('diffNames lists changed paths without rename detection, NFC, sorted', async () => {
    expect(await diffNames(g, c1, c2)).toEqual(['a.txt', 'caf\u{E9}.txt', 'new.txt', 'old.txt']);
    expect(await diffNames(g, c2, c2)).toEqual([]);
  });

  it('showBlob and blobId read a path at a revision, null when it is missing or not a file', async () => {
    expect(await showBlob(g, c2, 'a.txt')).toBe('A\n');
    expect(await showBlob(g, c1, 'dir/b.txt')).toBe('b\n');
    expect(await showBlob(g, c2, 'old.txt')).toBeNull();
    expect(await showBlob(g, c2, 'dir')).toBeNull();
    expect(await blobId(g, c2, 'a.txt')).toBe(sh(r.dir, ['rev-parse', `${c2}:a.txt`]).trim());
    expect(await blobId(g, c2, 'old.txt')).toBeNull();
    expect(await blobId(g, c2, 'dir')).toBeNull();
    expect(await blobId(g, 'no-such-branch', 'a.txt')).toBeNull();
  });
});
