import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseTeamSections, type TeamSections } from '@agenthub/contract';
import { deriveProject, findRepoRoot, git, gitRaw, isTracked, recordedSettings } from './git.js';

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
  /** Why a hub token that is set is not sent to `url` (also in `warnings`): what to say when the hub rejects the credentials. */
  tokenWithheld?: string;
  /** This checkout has no identity of its own: `agent` is that of the session working in it, whose checkout this is (see lendIdentity). */
  lentBy?: string;
}

/**
 * Resolution order, later wins: global file (~/.config/agenthub/config.json or
 * $HUB_CONFIG), then the committed `<worktree>/agenthub.json` (or, in a
 * checkout whose branch doesn't have that file yet, the project and URL
 * `hub init` recorded in the repository's git config), then the local
 * `<worktree>/.hub.json`, then environment variables HUB_URL, HUB_AGENT,
 * HUB_PROJECT, HUB_TOKEN, HUB_FAIL_CLOSED, HUB_TIMEOUT_MS. An agent or token in
 * the committed file (or in a .hub.json that git tracks) is ignored, and a
 * token from elsewhere goes only to the hub it was set up for (see tokenFor).
 * Throws on a value it can't read exactly (a malformed file, a wrong type, an
 * unrecognised HUB_FAIL_CLOSED, an out-of-range HUB_TIMEOUT_MS): the hooks and
 * guard block on that instead of running with a setting nobody asked for.
 */
export function loadConfig(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): HubConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const root = findRepoRoot(cwd);
  const sources: Array<[string, ConfigFile | null]> = [[globalConfigPath(env), null]];
  if (root) sources.push([path.join(root, TEAM_CONFIG_FILE_NAME), null], [path.join(root, CONFIG_FILE_NAME), null]);
  for (const entry of sources) entry[1] = readConfigFile(entry[0]);
  // The committed file is shared by everyone: identity and secrets never come from it.
  // Nor from a .hub.json a branch committed: checking it out replaced this worktree's own.
  const team = root ? sources[1][1] : null;
  const committedLocal = root && sources[2][1] && isTracked(root, CONFIG_FILE_NAME) ? sources[2][1] : null;
  for (const f of [team, committedLocal]) {
    if (!f) continue;
    delete f.agent;
    delete f.token;
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
  if (committedLocal) {
    warnings.push(
      `${sources[2][0]} is tracked by git, so it is shared like ${TEAM_CONFIG_FILE_NAME}, not this worktree's own: an agent or token in it is ignored. ` +
        `${CONFIG_FILE_NAME} must stay out of git: on a branch of yours, run \`git rm --cached ${CONFIG_FILE_NAME}\`, check what is in it, and run \`hub init --agent <human>/<agent>\`.`,
    );
  }
  const local = root && !committedLocal ? files[2] : null;
  // Is `url` named here (the environment, this worktree's own .hub.json, the global file, the default),
  // or only by the repository: a committed file, or the url `hub init` copied from one?
  const machineChosen = [env.HUB_URL, local?.url, files[0].url, DEFAULT_URL].some((u) => sameHub(u, url));
  const namedBy = committedLocal?.url
    ? `the ${CONFIG_FILE_NAME} that git tracks`
    : team?.url
      ? `the committed ${TEAM_CONFIG_FILE_NAME}`
      : "the repository's git config (agenthub.url)";
  const { token, withheld } = tokenFor(
    url,
    [
      { token: env.HUB_TOKEN, url: env.HUB_URL, from: 'HUB_TOKEN' },
      { token: local?.token, url: local?.url, from: `the hub token in this worktree's ${CONFIG_FILE_NAME}`, local: true },
      { token: files[0].token, url: files[0].url, from: `the hub token in ${sources[0][0]}` },
    ],
    root && !machineChosen ? { root, namedBy } : null,
  );
  if (withheld) warnings.push(withheld);
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
    ...(withheld ? { tokenWithheld: withheld } : {}),
  };
}

/**
 * The token that may go to `url` (`tokens` come highest precedence first), or
 * why none may. A token set with a url (in the same file; HUB_URL for
 * HUB_TOKEN) is for that hub alone. One set without is for a hub this machine
 * names, so not for one only the repository names (`repoNamed`): a checked-out
 * branch can change that, and HUB_TOKEN and the global file apply in every
 * repository. Only a token in this worktree's own .hub.json also goes to the
 * repository's hub (see otherRepositoryHub).
 */
function tokenFor(
  url: string,
  tokens: Array<{ token?: string; url?: string; from: string; local?: boolean }>,
  repoNamed: { root: string; namedBy: string } | null,
): { token: string | null; withheld?: string } {
  const set = tokens.filter((t) => t.token);
  if (set.length === 0) return { token: null };
  let other: ReturnType<typeof otherRepositoryHub> | undefined;
  const otherHub = () => (other === undefined ? (other = otherRepositoryHub(repoNamed!.root, url)) : other);
  const usable = set.find((t) => (t.url ? sameHub(t.url, url) : !repoNamed || (t.local && !otherHub())));
  if (usable) return { token: usable.token! };
  const t = set[0];
  let why: string;
  if (t.url) {
    const fix = !repoNamed
      ? 'set HUB_TOKEN to its token'
      : `${otherHub() ? `run \`hub init --url ${url}\` here and ` : ''}put its token in this worktree's ${CONFIG_FILE_NAME}`;
    why = `${t.from} is not sent to ${url}: it is for ${t.url}. If ${url} is your team's hub, ${fix}.`;
  } else if (t.local) {
    const o = otherHub()!;
    why =
      `${t.from} is not sent to ${url}: only ${repoNamed!.namedBy} names that hub, but ${o.where} names ${o.url}. ` +
      `If ${url} is your team's hub now, run \`hub init --url ${url}\` here.`;
  } else {
    const env = t.from === 'HUB_TOKEN';
    why =
      `${t.from} is not sent to ${url}: ${env ? 'set without HUB_URL' : 'with no "url" beside it'}, it goes only to a hub this machine names, ` +
      `and only ${repoNamed!.namedBy} names this one. If it is that hub's token, ${env ? `also set HUB_URL=${url}` : `add "url": "${url}" beside it`}.`;
  }
  return { token: null, withheld: why };
}

/**
 * Null when `url` is this repository's hub, the one a token in a worktree's own
 * .hub.json is for; else the hub that is, and what names it. That is the hub
 * `hub init` recorded for the repository, or the one agenthub.json on origin's
 * default branch names (a team that moves its hub changes it there). Without
 * either, `url` is the one `hub init` would record: unless another worktree's
 * agenthub.json names a different hub.
 */
export function otherRepositoryHub(root: string, url: string): { where: string; url: string } | null {
  const recorded = recordedSettings(root).url;
  if (sameHub(recorded, url)) return null;
  const upstream = upstreamTeamConfig(root);
  if (upstream) {
    const hub = upstream.url ?? DEFAULT_URL;
    return sameHub(hub, url) ? null : { where: `the ${TEAM_CONFIG_FILE_NAME} on origin's default branch`, url: hub };
  }
  if (recorded) return { where: "the repository's git config (agenthub.url)", url: recorded };
  for (const { file, config } of siblingTeamConfigs(root)) {
    const hub = config.url ?? DEFAULT_URL;
    if (!sameHub(hub, url)) return { where: file, url: hub };
  }
  return null;
}

/**
 * agenthub.json as committed on origin's default branch. A fresh clone has
 * none of the repository's git config, so this is all that tells `hub init`,
 * run first on a branch made before the setup commit, what the team uses.
 */
export function upstreamTeamConfig(root: string): ConfigFile | null {
  for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    const text = gitRaw(root, ['cat-file', 'blob', `${ref}:${TEAM_CONFIG_FILE_NAME}`]);
    if (text === null) continue;
    try {
      const f = parseConfigFile(text, `${TEAM_CONFIG_FILE_NAME} on ${ref}`);
      if (f.project) return f;
    } catch {
      // unreadable there: keep looking, then derive (and say so)
    }
  }
  return null;
}

/** The agenthub.json files (with a project) of the repository's other worktrees. */
export function siblingTeamConfigs(root: string): Array<{ file: string; config: ConfigFile }> {
  const out = git(root, ['worktree', 'list', '--porcelain']) ?? '';
  const found: Array<{ file: string; config: ConfigFile }> = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length);
    if (path.resolve(dir) === path.resolve(root)) continue;
    const file = path.join(dir, TEAM_CONFIG_FILE_NAME);
    try {
      const f = readConfigFile(file);
      if (f?.project) found.push({ file, config: f });
    } catch {
      // unreadable there: that checkout will report it itself
    }
  }
  return found;
}

/** Whether two hub URLs name the same hub, however they are spelled (case, default port, trailing slash). */
export function sameHub(a: string | undefined, b: string): boolean {
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

/** The Phase 2/3 sections of agenthub.json (land, sync, symbols), and where they were read. */
export interface TeamConfig {
  sections: TeamSections;
  /** Lenient mode only: each problem found, with the bad value replaced by its default. */
  problems: string[];
  /** `trunk`: the copy committed on the remote-tracking trunk; `worktree`: this checkout's file; `none`: neither exists. */
  source: 'trunk' | 'worktree' | 'none';
  /** Where it was read, for messages: `agenthub.json on origin/main`, or the file's path. */
  where: string;
  /** The remote and trunk branch the trunk copy was looked up on (the worktree copy's land.remote/trunk, else origin/main). */
  remote: string;
  trunk: string;
}

/** A remote or branch name that is safe to splice into `refs/remotes/<remote>/<trunk>:agenthub.json`. */
const REF_PART = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/**
 * The land, sync and symbols sections, preferring trunk's committed copy
 * (`git show refs/remotes/<remote>/<trunk>:agenthub.json`, as fetched last)
 * and falling back to the worktree's, through the contract's
 * parseTeamSections. The lander reads trunk's copy too, so that is what
 * decides how this project lands; a branch that edits agenthub.json changes
 * nothing until it has landed.
 *
 * Strict (the `land` tool, `hub doctor`): the first problem throws, naming the
 * key, unknown keys and invalid JSON included. Lenient (hooks, digest): never
 * throws; problems come back in `problems` and each bad value is its default,
 * because a config error in a hook would block every edit.
 */
export function teamSections(root: string, opts: { strict: boolean }): TeamConfig {
  const problems: string[] = [];
  const read = (text: string, where: string): unknown => {
    try {
      // As parseConfigFile: an own "__proto__" key must not become a prototype.
      return JSON.parse(text, (key, v) => (key === '__proto__' ? undefined : v));
    } catch {
      const msg = `${where} is not valid JSON`;
      if (opts.strict) throw new Error(msg);
      problems.push(msg);
      return {};
    }
  };
  const file = path.join(root, TEAM_CONFIG_FILE_NAME);
  let local: string | null = null;
  try {
    local = readFileSync(file, 'utf8');
  } catch {
    // no worktree copy
  }
  // Which remote and trunk to look on: what this checkout's copy says, else the defaults. Not a parse:
  // a bad value here only means looking in the default place.
  let remote = 'origin';
  let trunk = 'main';
  if (local !== null) {
    try {
      const land = (JSON.parse(local) as { land?: { remote?: unknown; trunk?: unknown } } | null)?.land;
      if (typeof land?.remote === 'string' && REF_PART.test(land.remote) && !land.remote.includes('..')) remote = land.remote;
      if (typeof land?.trunk === 'string' && REF_PART.test(land.trunk) && !land.trunk.includes('..')) trunk = land.trunk;
    } catch {
      // reported below, if this copy is the one used
    }
  }
  const onTrunk = gitRaw(root, ['cat-file', 'blob', `refs/remotes/${remote}/${trunk}:${TEAM_CONFIG_FILE_NAME}`]);
  let source: TeamConfig['source'] = 'none';
  let where = file;
  let value: unknown = {};
  if (onTrunk !== null) {
    source = 'trunk';
    where = `${TEAM_CONFIG_FILE_NAME} on ${remote}/${trunk}`;
    value = read(onTrunk, where);
  } else if (local !== null) {
    source = 'worktree';
    value = read(local, where);
  }
  if (opts.strict) {
    const { sections } = parseTeamSections(value, { strict: true, where });
    return { sections, problems, source, where, remote: sections.land?.remote ?? remote, trunk: sections.land?.trunk ?? trunk };
  }
  let parsed: ReturnType<typeof parseTeamSections>;
  try {
    parsed = parseTeamSections(value, { strict: false, where });
  } catch (err) {
    // Lenient never throws, whatever the contract does with a value it didn't foresee.
    problems.push(`${where}: ${(err as Error).message}`);
    parsed = parseTeamSections({}, { strict: false, where });
  }
  problems.push(...parsed.problems);
  return { sections: parsed.sections, problems, source, where, remote: parsed.sections.land?.remote ?? remote, trunk: parsed.sections.land?.trunk ?? trunk };
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
