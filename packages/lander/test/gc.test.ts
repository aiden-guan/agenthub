import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectGarbage } from '../src/gc.js';
import { systemClock } from '../src/ports.js';
import { sh } from './helpers.js';
import { Scenario } from './scenario.js';

// GC (design §2.2.7): land refs of terminal landings after 1 h, candidate refs
// of landed landings at once and of other terminal landings after 7 days,
// orphans after 24 h by their commit's committer date; live landings' refs
// never. Logs go after 7 days.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let s: Scenario | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

describe('collectGarbage', () => {
  it('deletes what nobody needs any more, at the right ages, and never a live landing\'s refs', async () => {
    const sc = (s = await Scenario.create());
    const a = sc.clone('maya/claude-1');
    const b = sc.clone('sam/claude-1');
    const c = sc.clone('lee/codex-1');
    // L-1 fails its checks: its land ref and its staged candidate stay for now.
    const Ha = a.commit('a: broken', { 'src/bad.ts': `// ${'FAIL'}!\n` });
    const L1 = sc.land(a, { summary: 'broken' });
    await sc.once();
    expect(sc.landing(L1.id).failure?.code).toBe('checks_failed');
    const cand1 = sc.agenthubRefs().find((r) => r.includes('/cand/'))!;
    expect(cand1).toContain('/L-1/');
    // L-2 is live (submitted): its land ref must survive every pass.
    const Hb = b.commit('b: later', { 'src/b.ts': 'export const b = 77;\n' });
    sc.land(b, { summary: 'later' });
    // An orphan land ref (pushed, but land was never called), and another database's candidate ref.
    const Hc = c.commit('c: orphan', { 'src/x.ts': 'export const x = 77;\n' });
    sh(c.dir, ['push', '-q', 'origin', `${Hc}:refs/agenthub/land/${Hc}`]);
    sh(c.dir, ['push', '-q', 'origin', `${Hc}:refs/agenthub/cand/deadbeef/L-1/${Hc.slice(0, 12)}`]);
    // An old log, and a fresh one.
    const logs = path.join(sc.workdir, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, 'L-0.1.log'), 'old\n');
    utimesSync(path.join(logs, 'L-0.1.log'), new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));

    // Startup (the lease granted) runs recovery and a GC pass: the orphans are old (their commits are from 2026-01-01).
    await sc.lander.ensureLease();
    try {
      const gcAt = async (offset: number) => collectGarbage({ ...sc.lander.ctx, clock: { ...systemClock, now: () => Date.now() + offset } }, { workdir: sc.workdir });
      expect(sc.agenthubRefs().sort()).toEqual([cand1, `refs/agenthub/land/${Ha}`, `refs/agenthub/land/${Hb}`].sort());
      expect(existsSync(path.join(logs, 'L-0.1.log'))).toBe(false);
      expect(existsSync(path.join(logs, 'L-1.1.log'))).toBe(true);
      // Now: L-1 ended just now, so nothing more goes.
      expect((await gcAt(0)).deleted).toEqual([]);
      // Two hours on: L-1's land ref goes; its candidate stays for 7 days.
      const later = await gcAt(2 * HOUR);
      expect(later.deleted).toEqual([`refs/agenthub/land/${Ha}`]);
      // Eight days on: L-1's candidate goes too. L-2 is live: its land ref stays.
      const week = await gcAt(8 * DAY);
      expect(week.deleted).toEqual([cand1]);
      expect(sc.agenthubRefs()).toEqual([`refs/agenthub/land/${Hb}`]);
    } finally {
      await sc.lander.lease.release();
    }
  }, 60_000);
});
