import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { deriveProject, findRepoRoot } from './git.js';

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
}

/**
 * Resolution order, later wins: global file (~/.config/agenthub/config.json or
 * $HUB_CONFIG), then the committed `<worktree>/agenthub.json`, then the local
 * `<worktree>/.hub.json`, then environment variables HUB_URL, HUB_AGENT,
 * HUB_PROJECT, HUB_TOKEN, HUB_FAIL_CLOSED, HUB_TIMEOUT_MS. A token in the
 * committed file is ignored. Throws on a value it can't read exactly (a
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
  const file: ConfigFile = Object.assign({}, ...sources.map(([, f]) => f ?? {}));

  const agent = env.HUB_AGENT || file.agent || null;
  if (agent && !AGENT_ID_RE.test(agent)) {
    throw new Error(`agent id "${agent}" is invalid; use human/agent, e.g. maya/claude-2`);
  }
  const url = (env.HUB_URL || file.url || DEFAULT_URL).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/.test(url) || !URL.canParse(url)) throw new Error(`hub URL ${JSON.stringify(url)} is invalid; use http://host:port`);
  return {
    url,
    agent,
    project: env.HUB_PROJECT || file.project || (root ? deriveProject(root) : null) || 'default',
    token: env.HUB_TOKEN || file.token || null,
    failClosed: parseBool('HUB_FAIL_CLOSED', env.HUB_FAIL_CLOSED) ?? file.failClosed ?? false,
    timeoutMs: parseTimeout(env.HUB_TIMEOUT_MS),
    root,
    configFiles: sources.filter(([, f]) => f !== null).map(([p]) => p),
  };
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
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
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
