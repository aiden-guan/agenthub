// The integration tests' world (design §5.3): a local bare remote with
// receive.denyNonFastForwards and an update hook that refuses trunk updates
// whose committer isn't the lander identity (a local remote has no
// authenticated pusher, so the committer stands in for it), seeded with
// agenthub.json (check `node check.mjs`, migrations/** protected, the
// resolver on); agent clones; a real hub (in-process, served over HTTP by
// hub-http.ts); and a real lander over its real HubClient, GitPort and
// ChecksRunner, run in-process (`run --once` or in the background).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub, SqliteStore, type HubAuth, type HubEvent } from '@agenthub/hub';
import type { Landing, LandRequest } from '@agenthub/hub/protocol';
import { ChecksRunner } from '../src/checks.js';
import { landerId } from '../src/config.js';
import { detectDrivers } from '../src/drivers.js';
import { openGitPort } from '../src/git-port.js';
import { HubClient } from '../src/hub-client.js';
import { initWorkdir } from '../src/init.js';
import { Lander } from '../src/lander.js';
import type { Faults } from '../src/ports.js';
import { startHubFront, type HubFront } from './hub-http.js';
import { BASE_TIME, LANDER, PROJECT, sh, testEnv, tmp, type Tmp } from './helpers.js';

export const P = PROJECT;
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const CHECK = 'node check.mjs';
export const approver = (name: string): HubAuth => ({ lander: false, approver: name });

/** An update hook: trunk updates need the lander's committer identity; `refuse-trunk` in the remote refuses them all (push_rejected). */
const HOOK = `#!/bin/sh
ref="$1"; new="$3"
case "$ref" in
  refs/heads/main)
    if [ -e "$GIT_DIR/refuse-trunk" ]; then echo "trunk updates are refused right now" >&2; exit 1; fi
    case "$new" in 0000000000000000000000000000000000000000) echo "trunk can't be deleted" >&2; exit 1;; esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

/** A working clone of the remote, committing as one agent's human. */
export class Clone {
  private tick = 0;
  constructor(
    readonly dir: string,
    readonly agent: string,
    private readonly author: { name: string; email: string },
  ) {}

  env(): Record<string, string> {
    const t = `${BASE_TIME + 3600 + 60 * ++this.tick} +0000`;
    return { GIT_AUTHOR_NAME: this.author.name, GIT_AUTHOR_EMAIL: this.author.email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
  }

  git(...args: string[]): string {
    return sh(this.dir, args, this.env()).trim();
  }

  read(file: string): string {
    return readFileSync(path.join(this.dir, file), 'utf8');
  }

  /** Writes the files (null deletes), commits everything, returns the full sha. */
  commit(message: string, files: Record<string, string | null>): string {
    for (const [file, content] of Object.entries(files)) {
      const p = path.join(this.dir, file);
      if (content === null) rmSync(p, { force: true });
      else {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '-m', message], this.env());
    return this.head();
  }

  head(): string {
    return sh(this.dir, ['rev-parse', 'HEAD']).trim();
  }
}

export interface ScenarioOptions {
  /** Extra `land` settings in the seeded agenthub.json. */
  land?: Record<string, unknown>;
  /** Put the fake Mergiraf first on the lander's PATH (auto-detected as the structural driver). */
  fakeMergiraf?: boolean;
  faults?: Faults;
  leaseTtlMs?: number;
}

const SEED_FILES: Record<string, string> = {
  'README.md': '# demo\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 1;\n',
  'src/x.ts': 'export const x = 1;\n',
  'src/session.ts': 'export function open(): number {\n  return 1;\n}\n',
  'migrations/001.sql': ['-- schema', 'create table users (id int);', '', '', '', '', '', '', '', 'create table posts (id int);', ''].join('\n'),
};

export class Scenario {
  readonly t: Tmp;
  readonly remote: string;
  readonly seed: Clone;
  readonly hub: Hub;
  readonly gate: string;
  readonly workdir: string;
  readonly events: HubEvent[] = [];
  readonly logs: string[] = [];
  front!: HubFront;
  lander!: Lander;
  binDir: string;
  private clones = 0;
  private bg: Promise<unknown> | null = null;

  private constructor(readonly o: ScenarioOptions) {
    this.t = tmp('lander-it-');
    this.remote = path.join(this.t.dir, 'remote.git');
    this.gate = path.join(this.t.dir, 'gate');
    this.workdir = path.join(this.t.dir, 'lander');
    this.binDir = path.join(this.t.dir, 'bin');
    mkdirSync(this.gate);
    mkdirSync(this.binDir);
    this.hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    this.hub.subscribe((e) => this.events.push(e));
    this.seed = new Clone(path.join(this.t.dir, 'seed'), 'human/seed', { name: 'Seed Human', email: 'seed@example.com' });
  }

  static async create(o: ScenarioOptions = {}): Promise<Scenario> {
    const s = new Scenario(o);
    await s.setup();
    return s;
  }

  private async setup(): Promise<void> {
    sh(this.t.dir, ['init', '-q', '--bare', '-b', 'main', this.remote]);
    sh(this.remote, ['config', 'receive.denyNonFastForwards', 'true']);
    mkdirSync(this.seed.dir);
    sh(this.seed.dir, ['init', '-q', '-b', 'main']);
    this.seed.commit('seed', { ...SEED_FILES, 'check.mjs': readFileSync(path.join(FIXTURES, 'check.mjs'), 'utf8'), 'agenthub.json': this.agenthubJson() });
    sh(this.seed.dir, ['remote', 'add', 'origin', this.remote]);
    sh(this.seed.dir, ['push', '-q', 'origin', 'main']);
    writeFileSync(path.join(this.remote, 'hooks', 'update'), HOOK);
    chmodSync(path.join(this.remote, 'hooks', 'update'), 0o755);

    if (this.o.fakeMergiraf) {
      const wrapper = path.join(this.binDir, 'mergiraf');
      writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, 'fake-mergiraf.mjs')}" "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
    this.front = await startHubFront(this.hub);
    await initWorkdir({ dir: this.workdir, remote: this.remote });
    this.lander = await this.makeLander();
  }

  agenthubJson(land: Record<string, unknown> = {}): string {
    return `${JSON.stringify(
      { project: P, land: { check: CHECK, protected: ['migrations/**'], checkEnv: { AGENTHUB_TEST_GATE: this.gate }, resolver: { enabled: true }, ...this.o.land, ...land } },
      null,
      2,
    )}\n`;
  }

  /** PATH for the lander's git and checks: the fake Mergiraf first, when there is one. */
  get PATH(): string {
    return `${this.binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  }

  async makeLander(o: { faults?: Faults; agent?: string } = {}): Promise<Lander> {
    const mirror = path.join(this.workdir, 'mirror.git');
    const agent = o.agent ?? landerId('lander/test');
    const env = { ...process.env, PATH: this.PATH };
    return new Lander({
      hub: new HubClient({ url: this.front.url, project: P, agent }),
      git: openGitPort({ mirror, remote: 'origin', env: { PATH: this.PATH } }),
      checks: new ChecksRunner({ workdir: this.workdir, mirror, env, killGraceMs: 2_000 }),
      resolver: null,
      faults: o.faults ?? this.o.faults,
      log: (line) => this.logs.push(line),
      agent,
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH: this.PATH }),
      trunk: 'main',
      leaseTtlMs: this.o.leaseTtlMs ?? 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir: this.workdir,
      host: 'test',
    });
  }

  clone(agent: string, author?: { name: string; email: string }): Clone {
    const human = agent.split('/')[0]!;
    const c = new Clone(path.join(this.t.dir, `clone-${++this.clones}-${human}`), agent, author ?? { name: `${human} agent`, email: `${human}@example.com` });
    sh(this.t.dir, ['clone', '-q', this.remote, c.dir]);
    return c;
  }

  /** As `land` does: push the land ref (never forced), then POST /land {queue: true}. */
  land(c: Clone, o: Omit<LandRequest, 'queue' | 'commit'> & { commit?: string } = {}): Landing {
    const H = o.commit ?? c.head();
    sh(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    sh(c.dir, ['fetch', '-q', 'origin', 'main']);
    const files = o.files ?? sh(c.dir, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
    return this.hub.land(P, c.agent, { ...o, queue: true, commit: H, files }).landing;
  }

  task(c: Clone, title: string): string {
    const t = this.hub.createTask(P, c.agent, { title });
    this.hub.takeTask(P, c.agent, t.id);
    return t.id;
  }

  /** A push outside the queue (a human with a bypass of the host rule, so the committer is the lander identity). */
  foreignPush(files: Record<string, string | null>, message = 'pushed outside the queue'): string {
    sh(this.seed.dir, ['fetch', '-q', 'origin', 'main']);
    sh(this.seed.dir, ['reset', '-q', '--hard', 'origin/main']);
    const sha = this.seed.commit(message, files);
    sh(this.seed.dir, ['push', '-q', 'origin', 'main']);
    return sha;
  }

  /** The remote's ref, or null. */
  remoteRef(ref: string): string | null {
    const out = sh(this.remote, ['for-each-ref', '--format=%(objectname)', ref]).trim();
    return out || null;
  }

  /** git in the remote, whatever its exit code. */
  remoteGit(...args: string[]): { code: number; stdout: string } {
    const r = spawnSync('git', args, { cwd: this.remote, env: testEnv(), encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout };
  }

  /** A revision in the remote. */
  rev(rev: string): string {
    return sh(this.remote, ['rev-parse', '--verify', rev]).trim();
  }

  /** The blob id at rev:file in the remote, or null. */
  blob(rev: string, file: string): string | null {
    try {
      return sh(this.remote, ['rev-parse', '--verify', '--quiet', `${rev}:${file}`]).trim() || null;
    } catch {
      return null;
    }
  }

  trunk(): string {
    return this.remoteRef('refs/heads/main')!;
  }

  /** Remote refs under refs/agenthub/. */
  agenthubRefs(): string[] {
    return sh(this.remote, ['for-each-ref', '--format=%(refname)', 'refs/agenthub/']).split('\n').filter(Boolean);
  }

  /** First-parent shas from trunk back to (excluding) `from`, oldest first. */
  firstParents(from: string): string[] {
    return sh(this.remote, ['rev-list', '--first-parent', '--reverse', `${from}..main`]).split('\n').filter(Boolean);
  }

  show(rev: string, file: string): string | null {
    try {
      return sh(this.remote, ['show', `${rev}:${file}`]);
    } catch {
      return null;
    }
  }

  message(rev: string): string {
    return sh(this.remote, ['log', '-1', '--format=%B', rev]);
  }

  landing(id: string): Landing {
    return this.hub.getLanding(P, id);
  }

  /** The check-run log: one line per run, "<landing> <cwd>". */
  checkRuns(landingId?: string): string[] {
    const f = path.join(this.gate, 'runs.log');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((l) => !landingId || l.startsWith(`${landingId} `));
  }

  /** run --once: admits what is submitted, processes at most one landing. */
  async once(): Promise<void> {
    await this.lander.run({ once: true });
  }

  /** Admission only (the lease is taken and given back). */
  async admit(): Promise<number> {
    await this.lander.ensureLease();
    try {
      return await this.lander.admitRound();
    } finally {
      await this.lander.lease.release();
    }
  }

  background(): void {
    this.bg = this.lander.run();
  }

  async stop(): Promise<void> {
    this.lander.stop();
    await this.bg;
    this.bg = null;
  }

  async close(): Promise<void> {
    if (this.bg) await this.stop().catch(() => undefined);
    await this.front.close();
    (this.hub.store as { close?: () => void }).close?.();
    this.t.cleanup();
  }

  /** Trailers of a commit on the remote, by key. */
  trailers(rev: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of sh(this.remote, ['log', '-1', '--format=%(trailers:only,unfold)', rev]).split('\n')) {
      const m = /^([A-Za-z-]+): (.*)$/.exec(line);
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  }
}

/** Polls `cond` every 20 ms until it holds (deadline: fails the test with `what`). */
export async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}
