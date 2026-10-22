// `hub-lander init --remote <url> [--dir <workdir>]` (design §2.2.1): the
// workdir (0700) with mirror.git, a bare clone whose remote.origin.fetch is
// emptied (the lander fetches explicit refspecs only). The lander's git never
// reads global or system config (§2.2.2), so the operator's own credential
// helpers are copied into the mirror's config, the one place its pushes get
// credentials from (besides SSH_AUTH_SOCK). A lander.json (0600) records the
// remote, and the hub and project when given.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '@agenthub/gitops';
import { ConfigError } from './config.js';

export interface InitOptions {
  dir: string;
  remote: string;
  hub?: string | null;
  project?: string | null;
  log?: (line: string) => void;
  /** The operator's environment, for reading their credential helpers (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface InitResult {
  mirror: string;
  /** The trunk branch the mirror starts from (the remote's default branch). */
  branch: string;
  /** Credential helpers copied into the mirror's config. */
  helpers: string[];
}

function redactUrl(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');
}

/** The operator's own credential.helper values (their global and system git config). */
function operatorCredentialHelpers(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_') || k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_CONFIG_NOSYSTEM') clean[k] = v;
  const r = spawnSync('git', ['config', '--get-all', 'credential.helper'], { cwd, env: clean, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/[\n\r\0]/.test(s));
}

export async function initWorkdir(o: InitOptions): Promise<InitResult> {
  const log = o.log ?? (() => {});
  if (!o.remote || o.remote.startsWith('-') || /[\0\n\r]/.test(o.remote)) throw new ConfigError(`--remote ${JSON.stringify(o.remote)} is not a remote URL or path`);
  const dir = path.resolve(o.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mirror = path.join(dir, 'mirror.git');
  if (existsSync(mirror)) {
    const g = open(mirror, { isolated: true, bare: true });
    const url = (await g.run(['config', '--get', 'remote.origin.url'], { ok: [0, 1] })).stdout.trim();
    if (url !== o.remote) throw new ConfigError(`${mirror} already mirrors ${redactUrl(url) || 'nothing'}; remove it, or use another --dir`);
    log(`${mirror} already mirrors ${redactUrl(o.remote)}`);
  } else {
    try {
      await open(dir, { isolated: true, bare: false }).run(['clone', '--bare', '--quiet', '--', o.remote, mirror], { timeoutMs: 600_000 });
    } catch (err) {
      throw new ConfigError(`can't clone ${redactUrl(o.remote)}: ${(err as Error).message}`);
    }
    log(`cloned ${redactUrl(o.remote)} into ${mirror}`);
  }
  const g = open(mirror, { isolated: true, bare: true });
  // Explicit refspecs only: the lander never fetches everything, nor writes refs it doesn't name.
  await g.run(['config', '--unset-all', 'remote.origin.fetch'], { ok: [0, 5] });
  const have = new Set(
    (await g.run(['config', '--get-all', 'credential.helper'], { ok: [0, 1] })).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const helpers: string[] = [];
  for (const h of operatorCredentialHelpers(o.env ?? process.env, dir)) {
    if (have.has(h)) continue;
    await g.run(['config', '--add', 'credential.helper', h]);
    have.add(h);
    helpers.push(h);
  }
  if (helpers.length > 0) log(`copied ${helpers.length} credential helper${helpers.length === 1 ? '' : 's'} into the mirror's config`);
  const head = await g.run(['symbolic-ref', '--short', 'HEAD'], { ok: [0, 1, 128] });
  const branch = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : 'main';

  const file = path.join(dir, 'lander.json');
  if (!existsSync(file)) {
    const value: Record<string, string> = { remoteUrl: o.remote };
    if (o.hub) value.hub = o.hub;
    if (o.project) value.project = o.project;
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    log(`wrote ${file} (0600)`);
  }
  return { mirror, branch, helpers };
}
