// The `hub-lander` CLI (design §2.2.1, §6.3.6): init, run [--once], doctor,
// resolve-anthropic. Exit codes: 0 normal, 1 a failed doctor check, 2 bad
// configuration (reported in one line).

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { open } from '@agenthub/gitops';
import { ConfigError, landerId, landerSecrets, loadLanderConfig, parseLanderArgs, withTrunkDefaults, type LanderConfig, type LanderFlags } from './config.js';
import { ChecksRunner } from './checks.js';
import { doctor } from './doctor.js';
import { detectDrivers } from './drivers.js';
import { faultsFromEnv } from './faults.js';
import { openGitPort } from './git-port.js';
import { HubClient } from './hub-client.js';
import { initWorkdir } from './init.js';
import { Lander } from './lander.js';
import { LeaseRefused } from './lease.js';
import { AiResolver } from './resolver.js';
import { trunkLocalRef } from './trunk.js';

const HELP = `hub-lander: lands queued changes onto trunk (agenthub Phase 2)

  hub-lander init --remote <url> [--dir D] [--hub URL] [--project ID]
      Create the workdir with a bare mirror of the remote.
  hub-lander run [--once] [--hub URL] [--project ID] [--id-prefix lander/x] [--dir D]
                 [--resolver-command CMD] [--driver name=CMD@pattern[,pattern...]]...
                 [--check-wrapper CMD] [--lease-ttl-ms N] [--poll-trunk-ms N]
      Claim the lander lease (or stand by) and land queued changes. --once
      processes at most one landing and exits.
  hub-lander doctor [run flags]
      Check git, the remote, trunk's agenthub.json, the resolver, the hub and the lander token.
  hub-lander resolve-anthropic
      The built-in AI resolver command: ResolverInput JSON on stdin, ResolverOutput
      JSON on stdout (the lander runs it; ANTHROPIC_API_KEY comes from the lander).

Environment: HUB_URL, HUB_PROJECT, HUB_TOKEN, HUB_LANDER_TOKEN, HUB_LANDER_ID,
ANTHROPIC_API_KEY. The workdir defaults to ~/.agenthub/lander/<project>.
Exit codes: 0 normal, 1 a doctor check failed, 2 bad configuration.
`;

function say(line: string): void {
  process.stderr.write(`hub-lander: ${line}\n`);
}

/** The mirror of a configured workdir, and its trunk branch (the remote's default, the mirror's HEAD). */
async function openMirror(cfg: LanderConfig): Promise<{ mirror: string; branch: string }> {
  const mirror = path.join(cfg.dir, 'mirror.git');
  if (!existsSync(mirror)) throw new ConfigError(`no mirror in ${cfg.dir}: run hub-lander init --remote <url> --dir ${cfg.dir}`);
  const head = await open(mirror, { isolated: true, bare: true }).run(['symbolic-ref', '--short', 'HEAD'], { ok: [0, 1, 128] });
  return { mirror, branch: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : 'main' };
}

/** hub and project from trunk's agenthub.json (`url`, `project`) when nothing else set them. */
async function withTrunk(cfg: LanderConfig, mirror: string, branch: string): Promise<LanderConfig> {
  if (cfg.hub && cfg.project) return cfg;
  const git = openGitPort({ mirror, remote: 'origin' });
  const f = await git.fetch([`+refs/heads/${branch}:${trunkLocalRef(branch)}`]);
  if (f.kind !== 'ok') throw new ConfigError(`no --hub/--project, and trunk's agenthub.json can't be read to find them: ${f.detail}`);
  const text = await git.showBlob(trunkLocalRef(branch), 'agenthub.json');
  let raw: unknown = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  return withTrunkDefaults(cfg, raw);
}

async function runCommand(flags: LanderFlags): Promise<number> {
  const cfg0 = loadLanderConfig({ flags });
  const { mirror, branch } = await openMirror(cfg0);
  const cfg = await withTrunk(cfg0, mirror, branch);
  if (!cfg.hub || !cfg.project) throw new ConfigError('no hub URL or project: pass --hub and --project, or set "url" and "project" in trunk\'s agenthub.json');
  const agent = landerId(cfg.idPrefix);
  const git = open(mirror, { isolated: true, bare: true });
  const hub = new HubClient({ url: cfg.hub, project: cfg.project, agent, token: cfg.token, landerToken: cfg.landerToken });
  const gitPort = openGitPort({ mirror: git, remote: 'origin' });
  // design §2.6 "Activation": trunk's land.resolver.enabled, and a working command here (the built-in one needs the key).
  const resolver =
    cfg.resolverCommand !== null || cfg.anthropicApiKey !== null
      ? new AiResolver({
          git: gitPort,
          hub,
          project: cfg.project,
          command: cfg.resolverCommand,
          apiKey: cfg.anthropicApiKey,
          maxPerHour: cfg.resolverMaxPerHour,
          scratchDir: path.join(cfg.dir, 'runs'),
          log: say,
        })
      : null;
  const lander = new Lander({
    hub,
    git: gitPort,
    checks: new ChecksRunner({ workdir: cfg.dir, mirror: git, passEnv: cfg.passEnv, checkWrapper: cfg.checkWrapper, secrets: landerSecrets(cfg) }),
    resolver,
    faults: faultsFromEnv(),
    agent,
    project: cfg.project,
    committer: cfg.committer,
    drivers: cfg.drivers ?? (await detectDrivers({ log: say })),
    trunk: branch,
    leaseTtlMs: cfg.leaseTtlMs,
    timings: { pollTrunkMs: cfg.pollTrunkMs },
    workdir: cfg.dir,
    host: hostname(),
  });
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    if (++signals > 1) {
      say(`${sig} again: exiting now (the next lander resolves whatever is in doubt)`);
      process.exit(1);
    }
    lander.stop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  say(`${agent} for ${cfg.project} at ${cfg.hub}, landing onto ${branch}`);
  say(`AI resolver: ${cfg.resolverCommand !== null ? `the command ${cfg.resolverCommand}` : cfg.anthropicApiKey !== null ? 'the built-in resolve-anthropic' : "none (no ANTHROPIC_API_KEY and no --resolver-command): conflicts git can't merge go back to their authors"}`);
  try {
    await lander.run({ once: flags.once === true });
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  return 0;
}

async function doctorCommand(flags: LanderFlags): Promise<number> {
  const cfg0 = loadLanderConfig({ flags });
  let branch = 'main';
  let cfg = cfg0;
  try {
    const m = await openMirror(cfg0);
    branch = m.branch;
    cfg = await withTrunk(cfg0, m.mirror, branch).catch(() => cfg0);
  } catch {
    // doctor reports the missing mirror itself
  }
  const hub = cfg.hub && cfg.project ? new HubClient({ url: cfg.hub, project: cfg.project, agent: landerId(cfg.idPrefix), token: cfg.token, landerToken: cfg.landerToken }) : null;
  return doctor({ cfg, branch, hub, out: (line) => process.stdout.write(`${line}\n`) });
}

async function initCommand(flags: LanderFlags): Promise<number> {
  if (!flags.remote) throw new ConfigError('init needs --remote <url>');
  const cfg = loadLanderConfig({ flags: { dir: flags.dir, project: flags.project, hub: flags.hub } });
  const r = await initWorkdir({ dir: cfg.dir, remote: flags.remote, hub: flags.hub ?? null, project: flags.project ?? null, log: say });
  process.stdout.write(`initialized ${cfg.dir}: mirror.git tracks ${r.branch}\nnext: hub-lander doctor --dir ${cfg.dir}, then hub-lander run --dir ${cfg.dir}\n`);
  return 0;
}

/** The built-in resolver command (design §2.6); the SDK is loaded only for it. */
async function resolveAnthropicCommand(): Promise<number> {
  const { resolveAnthropicMain } = await import('./resolve-anthropic.js');
  return resolveAnthropicMain();
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { command, flags } = parseLanderArgs(argv);
    switch (command) {
      case 'help':
        process.stdout.write(HELP);
        return 0;
      case 'init':
        return await initCommand(flags);
      case 'run':
        return await runCommand(flags);
      case 'doctor':
        return await doctorCommand(flags);
      case 'resolve-anthropic':
        return await resolveAnthropicCommand();
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof LeaseRefused) {
      say(err.message);
      return 2;
    }
    say(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Idle keep-alive sockets or a child's pipes must not hold a finished lander up.
    setTimeout(() => process.exit(code), 2_000).unref();
  },
  (err: unknown) => {
    say(`error: ${String(err)}`);
    process.exitCode = 1;
  },
);
