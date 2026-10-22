// `hub-lander doctor` (design §2.2.10): probes what the lander needs, one
// line per check, and exits 1 on any failure. Git features are probed, not
// version-parsed. Nothing it does changes trunk: the probe ref is pushed and
// deleted under <P>cand/doctor/, the self-test merges objects nothing refers
// to, and the hub probe is a lander call with a lease that can't exist.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { features, mergeTrees, open, showBlob, type Git, type StructuralDriver } from '@agenthub/gitops';
import type { LanderConfig } from './config.js';
import { detectDrivers } from './drivers.js';
import { openGitPort } from './git-port.js';
import { isHubError, type HubPort } from './ports.js';
import { probeResolver } from './resolver.js';
import { readTrunkConfig, trunkLocalRef } from './trunk.js';

export type CheckLevel = 'ok' | 'FAIL' | 'warn' | 'skip' | 'note';

export interface DoctorOptions {
  cfg: LanderConfig;
  /** The mirror's trunk branch (its HEAD). */
  branch: string;
  /** null when no hub URL or project could be found. */
  hub: HubPort | null;
  out: (line: string) => void;
  /** PATH for driver detection (default process.env.PATH). */
  PATH?: string;
  /** The environment the resolver probe runs from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

const PROBE_ENV = {
  GIT_AUTHOR_NAME: 'agenthub doctor',
  GIT_AUTHOR_EMAIL: 'doctor@localhost',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'agenthub doctor',
  GIT_COMMITTER_EMAIL: 'doctor@localhost',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

export async function doctor(o: DoctorOptions): Promise<number> {
  let failed = 0;
  const line = (level: CheckLevel, name: string, detail: string) => {
    if (level === 'FAIL') failed++;
    o.out(`${level.padEnd(4)}  ${name}: ${detail.replace(/[\r\n]+/g, ' ')}`);
  };

  // git features, probed in a scratch repository (the mirror may not exist yet).
  const scratch = mkdtempSync(path.join(tmpdir(), 'hub-lander-doctor-'));
  try {
    const g = open(scratch, { isolated: true, bare: false });
    await g.run(['init', '--bare', '--quiet', scratch]).catch(() => undefined);
    const f = await features(open(scratch, { isolated: true, bare: true })).catch(() => ({ mergeTreeBase: false, attrSource: false }));
    if (f.mergeTreeBase && f.attrSource) line('ok', 'git features', 'merge-tree --write-tree -z --merge-base and --attr-source work');
    else line('FAIL', 'git features', `${!f.mergeTreeBase ? 'merge-tree --write-tree -z --merge-base (git 2.40+)' : '--attr-source (git 2.40+)'} doesn't work with this git: upgrade git`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const mirrorPath = path.join(o.cfg.dir, 'mirror.git');
  if (!existsSync(mirrorPath)) {
    line('FAIL', 'mirror', `no ${mirrorPath}: run hub-lander init --remote <url> --dir ${o.cfg.dir}`);
  } else {
    line('ok', 'mirror', mirrorPath);
    const mirror = open(mirrorPath, { isolated: true, bare: true });
    const git = openGitPort({ mirror, remote: 'origin', fetchTimeoutMs: 60_000 });

    let tip: string | null = null;
    try {
      tip = await git.lsRemote(`refs/heads/${o.branch}`);
      if (tip) line('ok', 'remote', `reachable; ${o.branch} is at ${tip.slice(0, 12)}`);
      else line('FAIL', 'remote', `reachable, but it has no branch ${o.branch}`);
    } catch (err) {
      line('FAIL', 'remote', `unreachable: ${(err as Error).message}`);
    }

    let config = null;
    if (tip) {
      const fetched = await git.fetch([`+refs/heads/${o.branch}:${trunkLocalRef(o.branch)}`]);
      if (fetched.kind !== 'ok') line('FAIL', 'trunk config', `can't fetch ${o.branch}: ${fetched.detail}`);
      else {
        config = await readTrunkConfig(git, tip);
        if (config.ok) line('ok', 'trunk config', `agenthub.json parses strictly; check: ${config.land.check}`);
        else line('FAIL', 'trunk config', config.error);
      }
    }

    const prefix = config?.ok ? config.land.refPrefix : null;
    if (tip && prefix) {
      const ref = `${prefix}cand/doctor/${randomBytes(4).toString('hex')}`;
      const put = await git.pushRef({ prefix, sha: tip, ref }).catch((err: unknown) => ({ kind: 'unknown' as const, detail: String(err) }));
      if (put.kind === 'ok' || put.kind === 'up_to_date') {
        const del = await git.pushRef({ prefix, sha: null, ref }).catch((err: unknown) => ({ kind: 'unknown' as const, detail: String(err) }));
        if (del.kind === 'ok' || del.kind === 'up_to_date') line('ok', 'ref namespace', `pushed and deleted a probe ref under ${prefix}cand/`);
        else line('FAIL', 'ref namespace', `pushed ${ref} but couldn't delete it (${'detail' in del ? del.detail : 'refused'}); delete it by hand`);
      } else {
        const hint = prefix.startsWith('refs/heads/') ? '' : '; if the host refuses refs outside refs/heads, set land.refPrefix to refs/heads/agenthub/';
        line('FAIL', 'ref namespace', `the remote refused a probe ref under ${prefix}cand/ (${'detail' in put ? put.detail : 'refused'})${hint}`);
      }
    }

    if (config?.ok && config.land.structural === 'off') line('skip', 'structural', "trunk's agenthub.json has land.structural: off");
    else {
      const drivers = o.cfg.drivers ?? (await detectDrivers({ PATH: o.PATH }));
      if (drivers.length === 0) line('skip', 'structural', 'no structural driver (mergiraf is not on PATH, and none is configured)');
      else {
        const r = await structuralSelfTest(mirror, drivers).catch((err: unknown) => ({ ok: false, detail: String(err) }));
        line(r.ok ? 'ok' : 'FAIL', 'structural', r.detail);
      }
    }

    if (config?.ok && config.land.resolver.enabled) {
      if (o.cfg.resolverCommand === null && o.cfg.anthropicApiKey === null) {
        line('warn', 'resolver', "trunk enables the AI resolver, but this lander has no ANTHROPIC_API_KEY and no resolverCommand: conflicts git can't merge go back to their authors");
      } else {
        // The key is never printed; the built-in command's probe makes no API call.
        const what = o.cfg.resolverCommand !== null ? `the command ${o.cfg.resolverCommand}` : 'the built-in resolve-anthropic, ANTHROPIC_API_KEY set';
        const r = await probeResolver({ command: o.cfg.resolverCommand, apiKey: o.cfg.anthropicApiKey, env: o.env }).catch((err: unknown) => ({ ok: false, detail: String(err) }));
        line(r.ok ? 'ok' : 'FAIL', 'resolver', `${what}: ${r.detail}; at most ${o.cfg.resolverMaxPerHour} calls per hour`);
      }
    } else line('skip', 'resolver', "the AI resolver is off in trunk's agenthub.json");
  }

  if (!o.hub) line('FAIL', 'hub', 'no hub URL and project: pass --hub and --project, or set them in trunk\'s agenthub.json ("url", "project")');
  else {
    try {
      const { lease } = await o.hub.lander();
      line('ok', 'hub', lease ? `reachable; the lease is held by ${lease.holder}` : 'reachable; no lander holds the lease');
      try {
        await o.hub.next({ lease: { lease_claim_id: 'C-0', epoch: 'doctor' } });
        line('FAIL', 'lander token', 'the hub accepted a lander call with a lease that does not exist');
      } catch (err) {
        if (isHubError(err, 'not_lander')) line('ok', 'lander token', 'the hub accepts this lander\'s credentials');
        else line('FAIL', 'lander token', `the hub refused this lander: ${(err as Error).message}${isHubError(err, 'lander_token_required', 'forbidden') ? ' (set HUB_LANDER_TOKEN, or landerToken in lander.json, to the hub\'s --lander-token)' : ''}`);
      }
    } catch (err) {
      line('FAIL', 'hub', `unreachable: ${(err as Error).message}`);
    }
  }

  if (!o.cfg.checkWrapper) {
    let who = 'this user';
    try {
      who = userInfo().username;
    } catch {
      // no passwd entry
    }
    line('warn', 'isolation', `checks would run as ${who}, the OS user that holds the lander's push credentials, with no checkWrapper: run the lander as a dedicated user, or set checkWrapper`);
  } else line('ok', 'isolation', `checks run through ${o.cfg.checkWrapper}`);
  line('note', 'host rule', `only the lander's identity may update refs/heads/${o.branch} on the remote (a ruleset or an update hook), with no force pushes or deletion; doctor can't verify that`);
  return failed > 0 ? 1 : 0;
}

/**
 * A fixture that only the structural driver resolves (design §2.2.6): both
 * sides append a different function to the same file. The plain stage must
 * conflict, and the driver's stage must merge it with both functions in.
 */
async function structuralSelfTest(g: Git, drivers: StructuralDriver[]): Promise<{ ok: boolean; detail: string }> {
  if (!drivers.some((d) => d.patterns.includes('*.ts'))) return { ok: true, detail: `${drivers.length} driver(s) configured; no *.ts pattern to self-test with` };
  const blob = async (text: string) => (await g.run(['hash-object', '-w', '--stdin'], { input: text })).stdout.trim();
  const tree = async (text: string) => (await g.run(['mktree'], { input: `100644 blob ${await blob(text)}\tselftest.ts\n` })).stdout.trim();
  const commit = async (text: string, parent?: string) =>
    (await g.run(['commit-tree', await tree(text), ...(parent ? ['-p', parent] : []), '-m', 'agenthub doctor self-test'], { env: PROBE_ENV })).stdout.trim();
  const base = 'export function a(): number {\n  return 1;\n}\n';
  const B = await commit(base);
  const O = await commit(`${base}\nexport function b(): number {\n  return 2;\n}\n`, B);
  const T = await commit(`${base}\nexport function c(): number {\n  return 3;\n}\n`, B);
  const plain = await mergeTrees(g, O, T, { base: B, attrSource: O });
  if (plain.clean) return { ok: false, detail: 'the self-test fixture merged without the driver, so it tests nothing' };
  const r = await mergeTrees(g, O, T, { base: B, attrSource: O, drivers });
  if (!r.clean || !r.structural.includes('selftest.ts')) return { ok: false, detail: `the driver did not resolve the self-test conflict (${drivers.map((d) => d.command.split(' ')[0]).join(', ')})` };
  const merged = (await showBlob(g, r.tree, 'selftest.ts')) ?? '';
  if (!/function b\(/.test(merged) || !/function c\(/.test(merged)) return { ok: false, detail: 'the driver resolved the self-test conflict but dropped a side' };
  return { ok: true, detail: `the driver resolves the self-test conflict (${drivers.map((d) => d.command.split(' ')[0]).join(', ')})` };
}
