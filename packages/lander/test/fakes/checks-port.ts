// A fake ChecksPort for the deterministic simulation (design §5.2): a
// deterministic pass or fail per tree (a tree with a FAIL! marker anywhere
// fails), a run that takes time on the lander's clock while its trunk watch
// polls, and a shared record of every (parent, tree) that passed, which the
// simulation's I1 check reads at each trunk push.

import type { CheckReport } from '@agenthub/hub/protocol';
import type { CheckRunRequest, CheckRunResult, ChecksPort, Clock } from '../../src/ports.js';
import { commandHash } from '../../src/report.js';
import type { ObjectDb } from './git-port.js';

export const FAIL_MARKER = 'FAIL' + '!';

export interface FakeChecksOptions {
  db: ObjectDb;
  clock: Clock;
  /** How long one run takes, in ms of the lander's clock. */
  duration(req: CheckRunRequest): number;
  /** `${parent}:${tree}` of every candidate whose checks passed (shared by every lander). */
  passed: Set<string>;
  /** Hears every run as it starts. */
  onRun?(req: CheckRunRequest): void;
}

/** The checks' verdict on a tree: it fails when any file holds the failure marker. */
export function treePasses(db: ObjectDb, tree: string): boolean {
  return !Object.values(db.entries(tree)).some((content) => content.includes(FAIL_MARKER));
}

export class FakeChecks implements ChecksPort {
  constructor(private readonly o: FakeChecksOptions) {}

  async run(req: CheckRunRequest): Promise<CheckRunResult> {
    const { db, clock } = this.o;
    const commit = db.get(req.candidate);
    this.o.onRun?.(req);
    req.onStarted?.();
    const started = clock.now();
    const end = started + Math.max(1, this.o.duration(req));
    const report = (exit: number | null, extra: Partial<CheckReport> = {}): CheckReport => ({
      command_hash: commandHash(req.command),
      exit_code: exit,
      signal: null,
      timed_out: false,
      duration_ms: Math.max(0, clock.now() - started),
      log_tail: exit === 0 ? 'ok' : exit === null ? '' : ` FAIL  checks > the tree has no failure marker`,
      failed_tests: exit !== null && exit !== 0 ? ['checks > the tree has no failure marker'] : [],
      passes_on_trunk: null,
      reproduce: `git fetch ${req.remote} ${req.candidateRef} && git worktree add /tmp/agenthub-${req.landingId} ${req.candidate} && (cd /tmp/agenthub-${req.landingId} && ${req.command})`,
      ...extra,
    });
    for (;;) {
      const left = end - clock.now();
      if (left <= 0) break;
      await clock.sleep(Math.min(left, req.trunkWatch?.intervalMs ?? left), req.signal);
      if (req.signal?.aborted) return { status: 'aborted', report: report(null, { signal: 'SIGTERM' }), logFile: null };
      if (clock.now() >= end) break;
      if (req.trunkWatch) {
        let moved = false;
        try {
          moved = await req.trunkWatch.moved();
        } catch {
          moved = false; // the remote can't be reached: keep checking
        }
        if (moved) return { status: 'trunk_moved', report: report(null, { signal: 'SIGTERM' }), logFile: null };
      }
    }
    if (req.signal?.aborted) return { status: 'aborted', report: report(null, { signal: 'SIGTERM' }), logFile: null };
    if (!treePasses(db, commit.tree)) return { status: 'failed', report: report(1), logFile: null };
    this.o.passed.add(`${commit.parent}:${commit.tree}`);
    return { status: 'passed', report: report(0), logFile: null };
  }

  async killOrphans(): Promise<number[]> {
    return [];
  }
}
