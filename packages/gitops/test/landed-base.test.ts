// landedBase vectors (design §1.1 "Landed base"): the fork point, a landed
// source, a reverted landing, stacked commits, and the edge cases of the rule.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { landedBase, mergeTrees } from '../src/index.js';
import { Repo, tmp, type Tmp } from './helpers.js';

const EPOCH = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

let t: Tmp;
let r: Repo;
beforeEach(() => {
  t = tmp();
  r = Repo.init(path.join(t.dir, 'w'));
});
afterEach(() => t.cleanup());

/** A lander-style squash commit on main: the given files, with the identity trailers of `source`. */
function land(id: string, source: string, files: Parameters<Repo['commit']>[1]): string {
  r.checkout('main');
  return r.commit(`landing ${id} (${id})\n\nSquashed.\n\nAgenthub-Landing: acme/web/${id}\nAgenthub-Hub: ${EPOCH}\nAgenthub-Source: ${source}\nAgenthub-Attempt: 1`, files);
}

describe('landedBase', () => {
  it('is the fork point when nothing of the branch has landed', async () => {
    const M1 = r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.checkout('-b', 'agent');
    const X1 = r.commit('agent work', { 'a.txt': 'A\n' });
    r.checkout('main');
    const M2 = r.commit('trunk work', { 'b.txt': 'B\n' });
    expect(await landedBase(r.open(), M2, X1)).toEqual({ base: M1, landedSource: null, reason: 'merge-base' });
  });

  it("is the newest landed source in the tip's history, skipping other agents' landings", async () => {
    r.commit('base', { 'a.txt': 'one\ntwo\nthree\n', 'o.txt': 'o\n' });
    r.checkout('-b', 'agent');
    const X1 = r.commit('agent 1', { 'a.txt': 'one\nTWO\nthree\n' });
    land('L-1', X1, { 'a.txt': 'one\nTWO\nthree\n' });
    // Another agent's landing after it: its source is not in this branch.
    r.checkout('-b', 'other', 'main~1');
    const Y1 = r.commit('other agent', { 'o.txt': 'O\n' });
    const T = land('L-2', Y1, { 'o.txt': 'O\n' });
    r.checkout('agent');
    const X2 = r.commit('agent 2', { 'a.txt': 'one\nTWO!\nthree\n' });

    const g = r.open();
    expect(await landedBase(g, T, X2)).toEqual({ base: X1, landedSource: X1, reason: 'landed-source' });

    // Why it matters: from the fork point the agent's own landed line conflicts; from the landed source it merges.
    const fork = r.rev(`${X1}^`);
    expect((await mergeTrees(g, T, X2, { base: fork, attrSource: T })).clean).toBe(false);
    const merged = await mergeTrees(g, T, X2, { base: X1, attrSource: T });
    expect(merged.clean).toBe(true);
  });

  it('keeps the landed source as the base after its landing was reverted on trunk', async () => {
    r.commit('base', { 'a.txt': 'one\n' });
    r.checkout('-b', 'agent');
    const X1 = r.commit('agent 1', { 'a.txt': 'one\nagent-1\n' });
    land('L-1', X1, { 'a.txt': 'one\nagent-1\n' });
    const R = r.commit('Revert "landing L-1"', { 'a.txt': 'one\n' });
    r.checkout('agent');
    const X2 = r.commit('agent 2', { 'b.txt': 'b\n' });
    expect(await landedBase(r.open(), R, X2)).toEqual({ base: X1, landedSource: X1, reason: 'landed-source' });
  });

  it('follows stacked landings to the newest one', async () => {
    r.commit('base', { 'a.txt': 'a\n' });
    r.checkout('-b', 'agent');
    const X1 = r.commit('agent 1', { 'a.txt': 'a\n1\n' });
    const X2 = r.commit('agent 2', { 'a.txt': 'a\n1\n2\n' });
    const X3 = r.commit('agent 3', { 'a.txt': 'a\n1\n2\n3\n' });
    const T1 = land('L-1', X1, { 'a.txt': 'a\n1\n' });
    const g = r.open();
    expect(await landedBase(g, T1, X3)).toEqual({ base: X1, landedSource: X1, reason: 'landed-source' });
    const T2 = land('L-2', X2, { 'a.txt': 'a\n1\n2\n' });
    expect(await landedBase(g, T2, X3)).toEqual({ base: X2, landedSource: X2, reason: 'landed-source' });
    // Beyond the scan depth the source is not seen.
    expect(await landedBase(g, T2, X3, 1)).toEqual({ base: X2, landedSource: X2, reason: 'landed-source' });
    r.commit('trunk 1', { 't.txt': '1\n' });
    const T3 = r.commit('trunk 2', { 't.txt': '2\n' });
    expect(await landedBase(g, T3, X3, 2)).toEqual({ base: r.rev(`${X1}^`), landedSource: null, reason: 'merge-base' });
  });

  it('uses the merge base when the newest landed source is already an ancestor of it', async () => {
    const M1 = r.commit('base', { 'a.txt': 'a\n' });
    r.checkout('-b', 'side');
    const Y = r.commit('side', { 's.txt': 's\n' });
    r.checkout('main');
    r.git('merge', '-q', '--no-ff', '-m', 'merge side outside the queue', 'side');
    const M2 = r.head();
    r.checkout('-b', 'agent');
    const X = r.commit('agent', { 'a.txt': 'A\n' });
    const T = land('L-9', Y, { 'm.txt': 'm\n' });
    expect(M1).not.toBe(M2);
    expect(await landedBase(r.open(), T, X)).toEqual({ base: M2, landedSource: null, reason: 'merge-base' });
  });

  it('is the tip itself when trunk already contains it', async () => {
    r.commit('base', { 'a.txt': 'a\n' });
    const X = r.commit('more', { 'a.txt': 'b\n' });
    const T = r.commit('later', { 'c.txt': 'c\n' });
    expect(await landedBase(r.open(), T, X)).toEqual({ base: X, landedSource: null, reason: 'merge-base' });
  });

  it('ignores sources that are not commits of this repository and non-sha values', async () => {
    const M1 = r.commit('base', { 'a.txt': 'a\n' });
    r.checkout('-b', 'agent');
    const X = r.commit('agent', { 'a.txt': 'A\n' });
    land('L-1', 'f'.repeat(40), { 'b.txt': 'b\n' });
    const T = land('L-2', 'not-a-sha', { 'c.txt': 'c\n' });
    expect(await landedBase(r.open(), T, X)).toEqual({ base: M1, landedSource: null, reason: 'merge-base' });
  });

  it('refuses a tip with no history in common with trunk', async () => {
    const T = r.commit('base', { 'a.txt': 'a\n' });
    r.checkout('--orphan', 'lonely');
    const X = r.commit('unrelated', { 'z.txt': 'z\n' });
    await expect(landedBase(r.open(), T, X)).rejects.toThrow(/no history in common/);
  });
});
