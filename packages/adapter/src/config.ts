import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { deriveProject, findRepoRoot, recordedSettings } from './git.js';

export const DEFAULT_URL = 'http://127.0.0.1:7077';
/** Per-worktree, never committed: agent identity, token, local overrides. */
export const CONFIG_FILE_NAME = '.hub.json';
/** Committed with the repo so every clone and worktree agrees: project id and hub URL. */
export const TEAM_CONFIG_FILE_NAME = 'agenthub.json';
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_TIMEOUT_MS = 4000;
const TIMEOUT_RANGE_MS = [100, 600_000] as const;

/** Contents of `.hub.json`, `agenthub.json` or the global config file. */
export interface ConfigFile {
  url?: string;
  agent?: string;
  project?: string;
  token?: string;
  failClosed?: boolean;
}
const STRING_KEYS = ['url', 'agent', 'project', 'token'] as const;

export interface HubConfig {
  url: string;
  /** `human/agent`; null means this checkout isn't coordinated. */
  agent: string | null;
  project: string;
  token: string | null;
  /** Deny edits and commits when the hub is unreachable (default: allow). */
  failClosed: boolean;
  timeoutMs: number;
  /** Root of the current worktree, or null outside git. */
  root: string | null;
  /** Config files that were read, lowest precedence first. */
  configFiles: string[];
  /**
   * Where `project` came from. `recorded`: the repository's git config, which
   * `hub init` writes for checkouts whose branch has no agenthub.json yet.
   * `derived`: guessed from the repository, so it may not be the team's.
   */
  projectSource: 'env' | 'file' | 'recorded' | 'derived' | 'default';
  /** Settings that work but are probably not what the user meant, for the digest, the guard and `hub whoami`. */
  warnings: string[];
}

/**
 * Resolution order, later wins: global file (~/.config/agenthub/config.json or
 * $HUB_CONFIG), then the committed `<worktree>/agenthub.json` (or, in a
 * checkout whose branch doesn't have that file yet, the project and URL
 * `hub init` recorded in the repository's git config), then the local
 * `<worktree>/.hub.json`, then environment variables HUB_URL, HUB_AGENT,
 * HUB_PROJECT, HUB_TOKEN, HUB_FAIL_CLOSED, HUB_TIMEOUT_MS. A token in the
 * committed file is ignored, and a token from elsewhere goes only to the hub it
 * was set up for (see tokenFor). Throws on a value it can't read exactly (a
 * malformed file, a wrong type, an unrecognised HUB_FAIL_CLOSED, an
 * out-of-range HUB_TIMEOUT_MS): the hooks and guard block on that instead of
 * running with a setting nobody asked for.
 */
export function loadConfig(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): HubConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const root = findRepoRoot(cwd);
  const sources: Array<[string, ConfigFile | null]> = [[globalConfigPath(env), null]];
  if (root) sources.push([path.join(root, TEAM_CONFIG_FILE_NAME), null], [path.join(root, CONFIG_FILE_NAME), null]);
  for (const entry of sources) entry[1] = readConfigFile(entry[0]);
  // The committed file is shared by everyone: identity and secrets never come from it.
  const team = root ? sources[1][1] : null;
  if (team) {
    delete team.agent;
    delete team.token;
  }
  // A branch made before agenthub.json was committed has no copy of it, but the
  // pre-commit guard runs there too: use what `hub init` recorded for every worktree.
  const recorded: ConfigFile = root && !team && !(env.HUB_PROJECT && env.HUB_URL) ? recordedSettings(root) : {};
  const files = sources.map(([, f]) => f ?? {});
  const file: ConfigFile = Object.assign({}, files[0], recorded, ...files.slice(1));

  const agent = env.HUB_AGENT || file.agent || null;
  if (agent && !AGENT_ID_RE.test(agent)) {
    throw new Error(`agent id "${agent}" is invalid; use human/agent, e.g. maya/claude-2`);
  }
  const url = (env.HUB_URL || file.url || DEFAULT_URL).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/.test(url) || !URL.canParse(url)) throw new Error(`hub URL ${JSON.stringify(url)} is invalid; use http://host:port`);
  const warnings: string[] = [];
  const local = root ? files[2] : null;
  const token = tokenFor(
    url,
    [
      { token: env.HUB_TOKEN, url: env.HUB_URL, from: 'HUB_TOKEN' },
      { token: local?.token, url: local?.url, from: root ? sources[2][0] : '' },
      { token: files[0].token, url: files[0].url, from: sources[0][0] },
    ],
    root && team?.url && !env.HUB_URL && !local?.url ? { file: sources[1][0], root, globalUrl: files[0].url } : null,
    warnings,
  );
  const localFile = root ? sources[2] : null;
  const localAgent = localFile?.[1]?.agent;
  if (env.HUB_AGENT && localAgent && env.HUB_AGENT !== localAgent) {
    warnings.push(
      `HUB_AGENT=${env.HUB_AGENT} overrides ${localAgent} from ${localFile![0]}, so this session acts as ${env.HUB_AGENT}: ` +
        `its claims merge with every other session using that name. Unset HUB_AGENT to act as ${localAgent}.`,
    );
  }
  const chosen = env.HUB_PROJECT || file.project;
  const derived = !chosen && root ? deriveProject(root) : null;
  const projectSource: HubConfig['projectSource'] = env.HUB_PROJECT
    ? 'env'
    : chosen
      ? chosen === recorded.project && !files.slice(1).some((f) => f.project) ? 'recorded' : 'file'
      : derived ? 'derived' : 'default';
  return {
    url,
    agent,
    project: chosen || derived || 'default',
    token,
    failClosed: parseBool('HUB_FAIL_CLOSED', env.HUB_FAIL_CLOSED) ?? file.failClosed ?? false,
    timeoutMs: parseTimeout(env.HUB_TIMEOUT_MS),
    root,
    configFiles: sources.filter(([, f]) => f !== null).map(([p]) => p),
    projectSource,
    warnings,
  };
}

/**
 * The token that may go to `url`, or null with a warning saying why. `tokens`
 * come highest precedence first, each with the url set beside it (in the same
 * file; HUB_URL for HUB_TOKEN), and a token set with a url is for that hub
 * alone. One set on its own is for a hub this machine chose: any url but one
 * that only the committed agenthub.json names (`teamOnly`), unless it is also
 * the global file's url, the default, or the one `hub init` recorded for the
 * repository. A checked-out branch can change agenthub.json; it must not be
 * able to send this machine's token to a host of its choosing.
 */
function tokenFor(
  url: string,
  tokens: Array<{ token?: string; url?: string; from: string }>,
  teamOnly: { file: string; root: string; globalUrl?: string } | null,
  warnings: string[],
): string | null {
  const set = tokens.filter((t) => t.token);
  if (set.length === 0) return null;
  const chosenHere = !teamOnly || [teamOnly.globalUrl, DEFAULT_URL].some((u) => sameHub(u, url)) || sameHub(recordedSettings(teamOnly.root).url, url);
  const usable = set.find((t) => (t.url ? sameHub(t.url, url) : chosenHere));
  if (usable) return usable.token!;
  const first = set[0];
  warnings.push(
    first.url
      ? `the hub token in ${first.from} is for ${first.url}, so it is not sent to ${url}. ` +
          `If ${url} is your team's hub, set its token in .hub.json or HUB_TOKEN${teamOnly ? ` and run \`hub init --url ${url}\` here` : ''}.`
      : `the hub token from ${first.from} is not sent to ${url}: only the committed ${teamOnly!.file} names that hub, and nothing on this machine chose it. ` +
          `If it is your team's hub, run \`hub init --url ${url}\` here.`,
  );
  return null;
}

/** Whether two hub URLs name the same hub, however they are spelled (case, default port, trailing slash). */
function sameHub(a: string | undefined, b: string): boolean {
  const norm = (u: string) => (URL.canParse(u) ? new URL(u).href : u).replace(/\/+$/, '');
  return !!a && norm(a) === norm(b);
}

/** Whether `hub init` set this checkout up: agenthub.json or .hub.json in it, or settings recorded in its repository's git config. */
export function hasOwnSettings(root: string): boolean {
  if (existsSync(path.join(root, TEAM_CONFIG_FILE_NAME)) || existsSync(path.join(root, CONFIG_FILE_NAME))) return true;
  return Object.keys(recordedSettings(root)).length > 0;
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HUB_CONFIG) return env.HUB_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'agenthub', 'config.json');
}

export function readConfigFile(file: string): ConfigFile | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseConfigFile(text, file);
}

/** Check a config file's contents (`file` names it in errors). */
export function parseConfigFile(text: string, file: string): ConfigFile {
  let value: Record<string, unknown>;
  try {
    // An own "__proto__" key would become the prototype of the merged config in
    // loadConfig and supply settings (an agent, a token) from behind its checks.
    value = JSON.parse(text, (key, v) => (key === '__proto__' ? undefined : v));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must contain a JSON object`);
  for (const key of STRING_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${file}: "${key}" must be a string`);
  }
  if (value.failClosed !== undefined && typeof value.failClosed !== 'boolean') throw new Error(`${file}: "failClosed" must be true or false`);
  return value as ConfigFile;
}

/** Unset or empty: undefined (fall through to the files). Anything unrecognised is an error, never a silent "off". */
function parseBool(name: string, v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`${name}=${JSON.stringify(v)} is not understood; use 1 or 0`);
}

/** A whole number of milliseconds in range; anything else would make every request fail before it reaches the hub. */
function parseTimeout(v: string | undefined): number {
  const s = v?.trim();
  if (!s) return DEFAULT_TIMEOUT_MS;
  const [min, max] = TIMEOUT_RANGE_MS;
  const n = Number(s);
  if (!/^\d+$/.test(s) || n < min || n > max) {
    throw new Error(`HUB_TIMEOUT_MS=${JSON.stringify(v)} must be a whole number of milliseconds from ${min} to ${max}`);
  }
  return n;
}
