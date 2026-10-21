// Lander-local configuration (design §1.2): flags, then the environment, then
// <workdir>/lander.json, then defaults. Never committed. lander.json is
// refused unless only its owner can read and write it, because it can hold the
// lander token. ANTHROPIC_API_KEY comes only from the environment: it is read
// into memory and deleted from the environment at once, so no child process
// (a check, git, a merge driver) can inherit it (§4.4); the hub tokens get the
// same treatment. Secrets are kept on the config as non-enumerable
// properties, so printing or serializing a config never shows them.

import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { StructuralDriver } from '@agenthub/gitops';

/** A configuration problem: `hub-lander` reports it in one line and exits 2. */
export class ConfigError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Copies of protocol.ts's patterns: @agenthub/hub is only a dev dependency of
// the lander, so nothing at runtime may import it (a test checks they agree).
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;

const ID_PREFIX_RE = /^lander\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DRIVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
const LEASE_TTL = { min: 100, max: 86_400_000 };
const POLL_TRUNK = { min: 100, max: 3_600_000 };

export interface LanderConfig {
  /** The workdir: lander.json, mirror.git, runs/, logs/, npm-cache/, state.json. */
  readonly dir: string;
  /** null until trunk's agenthub.json fills it (withTrunkDefaults). */
  readonly hub: string | null;
  readonly project: string | null;
  /** `lander/<host>`: each process appends `-<pid>-<4 hex>` (landerId). */
  readonly idPrefix: string;
  /** init only: the remote the mirror is cloned from. */
  readonly remoteUrl: string | null;
  readonly committer: { name: string; email: string };
  /** null: auto-detect mergiraf on PATH. Weave or any other driver only explicitly. */
  readonly drivers: StructuralDriver[] | null;
  /** null: the built-in `hub-lander resolve-anthropic`. */
  readonly resolverCommand: string | null;
  readonly resolverMaxPerHour: number;
  /** Names of lander env variables the checks get (e.g. NPM_TOKEN); their values are redacted from every log. */
  readonly passEnv: string[];
  /** e.g. `docker run --rm -v {wt}:/w -w /w node:22 sh -c`. */
  readonly checkWrapper: string | null;
  readonly leaseTtlMs: number;
  readonly pollTrunkMs: number;
  // Non-enumerable: held in memory, never printed.
  readonly token: string | null;
  readonly landerToken: string | null;
  readonly anthropicApiKey: string | null;
}

export interface LanderFlags {
  once?: boolean;
  hub?: string;
  project?: string;
  idPrefix?: string;
  dir?: string;
  resolverCommand?: string;
  drivers?: StructuralDriver[];
  checkWrapper?: string;
  leaseTtlMs?: number;
  pollTrunkMs?: number;
  /** init: the remote URL to clone the mirror from. */
  remote?: string;
}

export const COMMANDS = ['init', 'run', 'doctor', 'resolve-anthropic'] as const;
export type LanderCommand = (typeof COMMANDS)[number];

const OPTIONS = {
  once: { type: 'boolean' },
  hub: { type: 'string' },
  project: { type: 'string' },
  'id-prefix': { type: 'string' },
  dir: { type: 'string' },
  'resolver-command': { type: 'string' },
  driver: { type: 'string', multiple: true },
  'check-wrapper': { type: 'string' },
  'lease-ttl-ms': { type: 'string' },
  'poll-trunk-ms': { type: 'string' },
  remote: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const RUN_FLAGS = ['hub', 'project', 'id-prefix', 'dir', 'resolver-command', 'driver', 'check-wrapper', 'lease-ttl-ms', 'poll-trunk-ms'];
const ALLOWED: Record<LanderCommand, readonly string[]> = {
  init: ['remote', 'dir', 'hub', 'project'],
  run: ['once', ...RUN_FLAGS],
  doctor: RUN_FLAGS,
  'resolve-anthropic': [],
};

function parseStrict(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

/** `hub-lander <command> [flags]` (design §6.3.6). Unknown commands and flags, and flags another command takes, are refused. */
export function parseLanderArgs(argv: string[]): { command: LanderCommand | 'help'; flags: LanderFlags } {
  let parsed: ReturnType<typeof parseStrict>;
  try {
    parsed = parseStrict(argv);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) return { command: 'help', flags: {} };
  const command = positionals[0]!;
  if (!(COMMANDS as readonly string[]).includes(command)) throw new ConfigError(`unknown command "${command}" (commands: ${COMMANDS.join(', ')})`);
  if (positionals.length > 1) throw new ConfigError(`hub-lander ${command} takes no arguments, got "${positionals[1]}"`);
  const cmd = command as LanderCommand;
  for (const k of Object.keys(values)) {
    if (k !== 'help' && !ALLOWED[cmd].includes(k)) throw new ConfigError(`--${k} doesn't apply to hub-lander ${cmd}`);
  }
  const flags: LanderFlags = {};
  if (values.once) flags.once = true;
  if (values.hub !== undefined) flags.hub = values.hub;
  if (values.project !== undefined) flags.project = values.project;
  if (values['id-prefix'] !== undefined) flags.idPrefix = values['id-prefix'];
  if (values.dir !== undefined) flags.dir = values.dir;
  if (values['resolver-command'] !== undefined) flags.resolverCommand = values['resolver-command'];
  if (values['check-wrapper'] !== undefined) flags.checkWrapper = values['check-wrapper'];
  if (values.remote !== undefined) flags.remote = values.remote;
  if (values.driver?.length) flags.drivers = values.driver.map(parseDriverFlag);
  if (values['lease-ttl-ms'] !== undefined) flags.leaseTtlMs = wholeNumber('--lease-ttl-ms', values['lease-ttl-ms'], LEASE_TTL);
  if (values['poll-trunk-ms'] !== undefined) flags.pollTrunkMs = wholeNumber('--poll-trunk-ms', values['poll-trunk-ms'], POLL_TRUNK);
  return { command: cmd, flags };
}

/** `--driver name=CMD@pattern[,pattern…]`: the patterns follow the last `@`. */
function parseDriverFlag(s: string): StructuralDriver {
  const eq = s.indexOf('=');
  const at = s.lastIndexOf('@');
  if (eq <= 0 || at <= eq + 1 || at === s.length - 1) throw new ConfigError(`--driver must be name=COMMAND@pattern[,pattern...], got ${JSON.stringify(s)}`);
  return checkDriver({ name: s.slice(0, eq), command: s.slice(eq + 1, at).trim(), patterns: s.slice(at + 1).split(',').map((p) => p.trim()).filter(Boolean) }, '--driver');
}

function checkDriver(d: { name: unknown; command: unknown; patterns: unknown }, where: string): StructuralDriver {
  if (typeof d.name !== 'string' || !DRIVER_NAME_RE.test(d.name)) throw new ConfigError(`${where}: driver name ${JSON.stringify(d.name)} must be letters, digits and dashes`);
  if (typeof d.command !== 'string' || !d.command.trim() || /[\0\n\r]/.test(d.command)) throw new ConfigError(`${where}: driver ${d.name} needs a one-line command`);
  if (!Array.isArray(d.patterns) || d.patterns.length === 0 || d.patterns.some((p) => typeof p !== 'string' || !/^[^\s\0]+$/.test(p))) {
    throw new ConfigError(`${where}: driver ${d.name} needs attribute patterns without spaces (e.g. *.ts)`);
  }
  return { name: d.name, command: d.command.trim(), patterns: [...(d.patterns as string[])] };
}

/** Digits only (spaces around them allowed), within range: '2m', '1e3' and '0x1F' are refused, as hub-server does. */
function wholeNumber(name: string, raw: unknown, range: { min: number; max: number }): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ConfigError(`${name} must be a whole number from ${range.min} to ${range.max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

// ------------------------------------------------------------------ lander.json

const FILE_KEYS = [
  'hub', 'project', 'token', 'landerToken', 'idPrefix', 'remoteUrl', 'committer', 'drivers', 'resolverCommand', 'resolverMaxPerHour', 'passEnv',
  'checkWrapper', 'leaseTtlMs', 'pollTrunkMs',
];

/** <dir>/lander.json, or {} when there is none. Refused unless it is a regular file only its owner can read and write. */
function readLanderJson(dir: string): Record<string, unknown> {
  const file = path.join(dir, 'lander.json');
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`can't read ${file}: ${(err as Error).message}`);
  }
  let text: string;
  try {
    // Checked on the open file itself, so it can't be swapped between the check and the read.
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ConfigError(`${file} is not a regular file`);
    if ((st.mode & 0o077) !== 0) {
      throw new ConfigError(`${file} is open to other users (mode ${(st.mode & 0o777).toString(8)}), and it can hold the lander token: run chmod 600 ${file}`);
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new ConfigError(`${file} belongs to another user (uid ${st.uid}); the lander's own user must own it`);
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${file} must hold a JSON object`);
  for (const k of Object.keys(value)) {
    if (/anthropic/i.test(k)) throw new ConfigError(`${file}: "${k}": ANTHROPIC_API_KEY is read only from the lander's environment, never from a file`);
    if (!FILE_KEYS.includes(k)) throw new ConfigError(`${file}: "${k}" is not a known setting (known: ${FILE_KEYS.join(', ')})`);
  }
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------------ loading

export interface LoadOptions {
  flags?: LanderFlags;
  /** The environment (default process.env). ANTHROPIC_API_KEY, HUB_TOKEN and HUB_LANDER_TOKEN are deleted from it once read. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  hostname?: string;
}

/** Reads a variable and deletes it from the environment, so no child process inherits it. */
function take(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  delete env[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function present(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

/** The default workdir: ~/.agenthub/lander/<project with / → _>. */
export function defaultWorkdir(project: string, home: string = homedir()): string {
  return path.join(home, '.agenthub', 'lander', project.replace(/\//g, '_'));
}

/** `lander/<host>` with the host name made a valid agent-id part. */
function defaultIdPrefix(host: string): string {
  const h = host.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);
  return `lander/${h || 'host'}`;
}

/** This process's lander id (design §1.5): `<prefix>-<pid>-<4 hex>`, kept a valid agent id however long the host name. */
export function landerId(prefix: string, pid: number = process.pid, rand: string = randomBytes(2).toString('hex')): string {
  if (!ID_PREFIX_RE.test(prefix)) throw new ConfigError(`bad lander id prefix ${JSON.stringify(prefix)}`);
  const suffix = `-${pid}-${rand}`;
  const agent = prefix.slice('lander/'.length);
  const id = `lander/${agent.slice(0, 64 - suffix.length)}${suffix}`;
  if (!AGENT_ID_PATTERN.test(id)) throw new ConfigError(`can't make a lander id from ${JSON.stringify(prefix)}`);
  return id;
}

function str(where: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim() || /[\0\n\r]/.test(v)) throw new ConfigError(`${where} must be a non-empty one-line string`);
  return v.trim();
}

function hubUrl(where: string, v: unknown): string | null {
  const s = str(where, v);
  if (s === null) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ConfigError(`${where} must be an http(s) URL, got ${JSON.stringify(s)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${where} must be an http(s) URL, got ${JSON.stringify(s)}`);
  // Error messages name the hub URL: a credential in it would end up in logs.
  if (u.username || u.password) throw new ConfigError(`${where} must not carry credentials: put the hub token in HUB_TOKEN or lander.json "token"`);
  return s.replace(/\/+$/, '');
}

function projectId(where: string, v: unknown): string | null {
  const s = str(where, v);
  if (s !== null && !PROJECT_PATTERN.test(s)) throw new ConfigError(`${where} ${JSON.stringify(s)} is not a project id`);
  return s;
}

function committerOf(where: string, v: unknown): { name: string; email: string } {
  if (v === undefined) return { name: 'agenthub lander', email: 'lander@localhost' };
  const fromString = typeof v === 'string' ? /^\s*([^<>\n\r\0]+?)\s*<([^<>\s]+)>\s*$/.exec(v) : null;
  const c = fromString ? { name: fromString[1], email: fromString[2] } : v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const ok = (s: unknown) => typeof s === 'string' && s.trim().length > 0 && !/[<>\n\r\0]/.test(s);
  if (!c || !ok(c.name) || !ok(c.email) || /\s/.test(c.email as string)) throw new ConfigError(`${where} must be "Name <email>" or {"name", "email"}`);
  return { name: (c.name as string).trim(), email: (c.email as string).trim() };
}

function withSecrets<T extends object>(base: T, secrets: { token: string | null; landerToken: string | null; anthropicApiKey: string | null }): T & typeof secrets {
  for (const [k, value] of Object.entries(secrets)) Object.defineProperty(base, k, { value, enumerable: false, writable: false, configurable: false });
  return base as T & typeof secrets;
}

/**
 * The lander's configuration. Precedence: flags, then the environment
 * (HUB_URL, HUB_PROJECT, HUB_TOKEN, HUB_LANDER_TOKEN, HUB_LANDER_ID), then
 * lander.json, then defaults. Throws ConfigError on anything wrong; the
 * secrets are taken out of the environment first, even then.
 */
export function loadLanderConfig(o: LoadOptions = {}): LanderConfig {
  const env = o.env ?? process.env;
  const anthropicApiKey = take(env, 'ANTHROPIC_API_KEY');
  const envToken = take(env, 'HUB_TOKEN');
  const envLanderToken = take(env, 'HUB_LANDER_TOKEN');
  const flags = o.flags ?? {};
  const home = o.home ?? homedir();

  const earlyProject = flags.project ?? present(env.HUB_PROJECT);
  if (!flags.dir && !earlyProject) throw new ConfigError('give the workdir with --dir, or the project with --project or HUB_PROJECT (the default workdir is ~/.agenthub/lander/<project>)');
  const dir = flags.dir ? path.resolve(flags.dir) : defaultWorkdir(projectId('--project', earlyProject)!, home);
  const file = readLanderJson(dir);
  const at = (k: string) => `lander.json "${k}"`;

  const hub = hubUrl(flags.hub !== undefined ? '--hub' : present(env.HUB_URL) ? 'HUB_URL' : at('hub'), flags.hub ?? present(env.HUB_URL) ?? file.hub);
  const project = projectId(flags.project !== undefined ? '--project' : present(env.HUB_PROJECT) ? 'HUB_PROJECT' : at('project'), flags.project ?? present(env.HUB_PROJECT) ?? file.project);
  const idPrefix = (() => {
    const v = flags.idPrefix ?? present(env.HUB_LANDER_ID) ?? file.idPrefix;
    if (v === undefined) return defaultIdPrefix(o.hostname ?? osHostname());
    if (typeof v !== 'string' || !v.startsWith('lander/')) throw new ConfigError(`the lander id prefix ${JSON.stringify(v)} must start with lander/ (the hub knows landers by it)`);
    if (!ID_PREFIX_RE.test(v)) throw new ConfigError(`the lander id prefix ${JSON.stringify(v)} may only have letters, digits, ".", "_" and "-" after lander/`);
    return v;
  })();
  const remoteUrl = str(flags.remote !== undefined ? '--remote' : at('remoteUrl'), flags.remote ?? file.remoteUrl);
  if (remoteUrl?.startsWith('-')) throw new ConfigError(`the remote ${JSON.stringify(remoteUrl)} can't start with "-"`);
  const drivers = flags.drivers?.length
    ? flags.drivers
    : file.drivers === undefined
      ? null
      : Array.isArray(file.drivers)
        ? file.drivers.map((d, i) => checkDriver((d ?? {}) as { name: unknown; command: unknown; patterns: unknown }, at(`drivers[${i}]`)))
        : (() => {
            throw new ConfigError(`${at('drivers')} must be a list of {name, command, patterns}`);
          })();
  const passEnv = file.passEnv === undefined ? [] : file.passEnv;
  if (!Array.isArray(passEnv) || passEnv.some((n) => typeof n !== 'string' || !ENV_NAME_RE.test(n))) throw new ConfigError(`${at('passEnv')} must be a list of environment variable names`);
  const cfg = {
    dir,
    hub,
    project,
    idPrefix,
    remoteUrl,
    committer: committerOf(at('committer'), file.committer),
    drivers,
    resolverCommand: str(flags.resolverCommand !== undefined ? '--resolver-command' : at('resolverCommand'), flags.resolverCommand ?? file.resolverCommand),
    resolverMaxPerHour: file.resolverMaxPerHour === undefined ? 20 : wholeNumber(at('resolverMaxPerHour'), file.resolverMaxPerHour, { min: 0, max: 10_000 }),
    passEnv: [...new Set(passEnv as string[])],
    checkWrapper: str(flags.checkWrapper !== undefined ? '--check-wrapper' : at('checkWrapper'), flags.checkWrapper ?? file.checkWrapper),
    leaseTtlMs: flags.leaseTtlMs ?? (file.leaseTtlMs === undefined ? 60_000 : wholeNumber(at('leaseTtlMs'), file.leaseTtlMs, LEASE_TTL)),
    pollTrunkMs: flags.pollTrunkMs ?? (file.pollTrunkMs === undefined ? 15_000 : wholeNumber(at('pollTrunkMs'), file.pollTrunkMs, POLL_TRUNK)),
  };
  return withSecrets(cfg, {
    token: envToken ?? str(at('token'), file.token),
    landerToken: envLanderToken ?? str(at('landerToken'), file.landerToken),
    anthropicApiKey,
  });
}

/** Fills `hub` and `project`, when nothing else set them, from trunk's agenthub.json (its `url` and `project`). */
export function withTrunkDefaults(cfg: LanderConfig, agenthubJson: unknown): LanderConfig {
  const j = agenthubJson && typeof agenthubJson === 'object' && !Array.isArray(agenthubJson) ? (agenthubJson as Record<string, unknown>) : {};
  const { token, landerToken, anthropicApiKey } = cfg;
  return withSecrets(
    { ...cfg, hub: cfg.hub ?? hubUrl('agenthub.json "url"', j.url), project: cfg.project ?? projectId('agenthub.json "project"', j.project) },
    { token, landerToken, anthropicApiKey },
  );
}

/** The exact values the lander redacts from everything it writes. */
export function landerSecrets(cfg: LanderConfig): string[] {
  return [cfg.anthropicApiKey, cfg.token, cfg.landerToken].filter((s): s is string => typeof s === 'string' && s.length > 0);
}
