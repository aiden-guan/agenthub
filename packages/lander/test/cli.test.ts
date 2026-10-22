import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sh, testEnv } from './helpers.js';
import { P, Scenario, waitFor } from './scenario.js';

// The `hub-lander` binary (design §2.2.1, §2.2.10, §6.3.6) as a child
// process: init, run --once against the hub over HTTP, doctor (one line per
// check, exit 1 on any failure, git features probed through a git shimmed on
// PATH), and exit 2 with one line for bad configuration.

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hub-lander.js');
const T = 60_000;

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: testEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A git first on PATH that behaves like a git without `merge-tree` (as before 2.38). */
function gitWithoutMergeTree(dir: string): string {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'old-git');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in merge-tree) echo "git: 'merge-tree' is not a git command. See 'git --help'." >&2; exit 1;; esac; done\nexec "${real}" "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  return `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

let s: Scenario | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

describe('hub-lander CLI', () => {
  it(
    'init makes the workdir: a bare mirror with no fetch refspecs, and lander.json 0600',
    async () => {
      s = await Scenario.create();
      const dir = path.join(s.t.dir, 'fresh-lander');
      const r = await run(['init', '--remote', s.remote, '--dir', dir, '--project', P, '--hub', s.front.url]);
      expect(r.stderr).not.toMatch(/error/i);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('mirror.git tracks main');
      const mirror = path.join(dir, 'mirror.git');
      expect(sh(mirror, ['rev-parse', '--is-bare-repository']).trim()).toBe('true');
      expect(() => sh(mirror, ['config', '--get-all', 'remote.origin.fetch'])).toThrow();
      expect(statSync(path.join(dir, 'lander.json')).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o077).toBe(0);
      // Again, the same remote: fine; another remote: refused (exit 2, one line).
      expect((await run(['init', '--remote', s.remote, '--dir', dir])).code).toBe(0);
      const other = await run(['init', '--remote', path.join(s.t.dir, 'elsewhere.git'), '--dir', dir]);
      expect(other.code).toBe(2);
      expect(other.stderr.trim().split('\n')).toHaveLength(1);
    },
    T,
  );

  it(
    'run --once lands a queued change over HTTP, and exits 0',
    async () => {
      s = await Scenario.create();
      const a = s.clone('maya/claude-1');
      const seedTip = s.trunk();
      a.commit('a: change', { 'src/a.ts': 'export const a = 42;\n' });
      const L = s.land(a, { summary: 'a = 42' });
      const r = await run(['run', '--once', '--dir', s.workdir, '--hub', s.front.url, '--project', P, '--id-prefix', 'lander/cli', '--poll-trunk-ms', '200']);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/lander\/cli-\d+-[0-9a-f]{4} for acme\/web/);
      const done = s.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.lander).toMatch(/^lander\/cli-\d+-[0-9a-f]{4}$/);
      expect(s.firstParents(seedTip)).toEqual([done.trunk_sha]);
      // The lease was released on the way out.
      expect(s.hub.landerStatus(P).lease).toBeNull();
    },
    T,
  );

  it(
    'doctor prints one line per check and exits 0 when all is well (structural self-test with the fake Mergiraf)',
    async () => {
      s = await Scenario.create({ fakeMergiraf: true });
      const r = await run(['doctor', '--dir', s.workdir, '--hub', s.front.url, '--project', P], { PATH: s.PATH });
      const lines = r.stdout.trim().split('\n');
      for (const line of lines) expect(line).toMatch(/^(ok|FAIL|warn|skip|note) {2,3}[a-z ]+: \S/);
      expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
      expect(r.code).toBe(0);
      for (const name of ['git features', 'mirror', 'remote', 'trunk config', 'ref namespace', 'structural', 'hub', 'lander token']) {
        expect(lines.some((l) => l.startsWith('ok') && l.includes(` ${name}: `))).toBe(true);
      }
      expect(lines.some((l) => l.startsWith('warn') && l.includes('isolation'))).toBe(true);
      expect(lines.some((l) => l.includes('host rule'))).toBe(true);
      // The probe ref was deleted again.
      expect(s.agenthubRefs()).toEqual([]);
    },
    T,
  );

  it(
    'doctor exits 1 when git lacks a feature (git shimmed on PATH)',
    async () => {
      s = await Scenario.create();
      const r = await run(['doctor', '--dir', s.workdir, '--hub', s.front.url, '--project', P], { PATH: gitWithoutMergeTree(s.t.dir) });
      expect(r.code).toBe(1);
      const lines = r.stdout.trim().split('\n');
      for (const line of lines) expect(line).toMatch(/^(ok|FAIL|warn|skip|note) {2,3}[a-z ]+: \S/);
      expect(lines.find((l) => l.includes(' git features: '))).toMatch(/^FAIL {2}git features: merge-tree/);
      // The other checks still ran.
      expect(lines.some((l) => l.startsWith('ok') && l.includes(' hub: '))).toBe(true);
    },
    T,
  );

  it(
    'bad configuration exits 2 with one line',
    async () => {
      s = await Scenario.create();
      const empty = path.join(s.t.dir, 'nothing-here');
      mkdirSync(empty);
      const noMirror = await run(['run', '--once', '--dir', empty, '--hub', s.front.url, '--project', P]);
      expect(noMirror.code).toBe(2);
      expect(noMirror.stderr.trim().split('\n')).toEqual([expect.stringContaining('hub-lander init')]);
      const badFlag = await run(['run', '--lease-ttl-ms', '2m', '--dir', s.workdir]);
      expect(badFlag.code).toBe(2);
      expect(badFlag.stderr.trim().split('\n')).toHaveLength(1);
      writeFileSync(path.join(empty, 'lander.json'), '{}');
      chmodSync(path.join(empty, 'lander.json'), 0o644);
      const open = await run(['doctor', '--dir', empty]);
      expect(open.code).toBe(2);
      expect(open.stderr).toContain('chmod 600');
      expect(existsSync(path.join(empty, 'mirror.git'))).toBe(false);
    },
    T,
  );

  it(
    'SIGTERM: the check is killed, the running landing goes back to the queue (lander_stopping), the lease is released, exit 0',
    async () => {
      s = await Scenario.create();
      const sc = s;
      const a = sc.clone('maya/claude-1');
      a.commit('a: change', { 'src/a.ts': 'export const a = 43;\n' });
      writeFileSync(path.join(sc.gate, 'block'), '');
      const L = sc.land(a, { summary: 'a = 43' });
      const child = spawn(process.execPath, [BIN, 'run', '--dir', sc.workdir, '--hub', sc.front.url, '--project', P, '--poll-trunk-ms', '200'], { env: testEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      await waitFor(() => existsSync(path.join(sc.gate, 'started')), 'the check to start');
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      const back = sc.landing(L.id);
      expect(back.status).toBe('queued');
      expect(back.attempt).toBe(1);
      expect(back.retries).toEqual({ trunk_moved: 0, lander_lost: 0, step_timeout: 0 });
      expect(sc.events.some((e) => e.type === 'landing.updated' && e.data.landing_id === L.id && e.data.reason === 'requeued:lander_stopping')).toBe(true);
      expect(sc.hub.landerStatus(P).lease).toBeNull();
      expect(stderr).toContain('stopping');
      expect(existsSync(path.join(sc.workdir, 'runs', `${L.id}.1`))).toBe(false);
    },
    T,
  );
});
