// @agenthub/contract — shared runtime rules. No imports at all: safe for the
// adapter's hooks (every edit), the lander and the hub alike. Frozen at Step 0;
// only the integrator changes it.

/** A scope entry as the hub stores it: no symbol = the whole file. */
export interface ScopeLike {
  file: string;
  symbol?: string;
}

/** A claim-like value: its entries and the mapper version that produced their symbols (null = file-level only). */
export interface ScopedLike {
  scope: ScopeLike[];
  mapper: string | null;
}

// ------------------------------------------------------------------ constants

/** The lander lease is an ordinary claim on this reserved key (it passes normalizeRepoPath; agents' paths can never be under .git/). */
export const LANDER_LEASE_KEY = '.git/agenthub/lander';
/** Claims on keys under this prefix need lander credentials. */
export const RESERVED_PREFIX = '.git/agenthub/';
/** A landing hold's expires_at: never due while the landing is live. */
export const HOLD_EXPIRES = 8_640_000_000_000_000;
/** The file's import / re-export statements, as one group. Never conflicts with another @imports. */
export const IMPORTS = '@imports';
/** Everything at top level that is not a declaration or an import (statements, detached comments). */
export const TOPLEVEL = '@toplevel';
export const MAX_SYMBOL_KEY = 200;
export const SYMBOL_KEY_RE = /^(?:@imports|@toplevel|[\p{L}\p{N}_$]+(?:\.[\p{L}\p{N}_$]+)*)$/u;
/** Full lowercase git object id (sha1 or sha256). */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Always protected, whatever agenthub.json says: they define the checks, the protected list and merge behaviour. */
export const ALWAYS_PROTECTED: readonly string[] = ['agenthub.json', '.gitattributes'];
/** Default namespace for landing refs (`land/<sha>`) and staged candidates (`cand/...`) on the remote. */
export const DEFAULT_REF_PREFIX = 'refs/agenthub/';
export const TRAILER = {
  landing: 'Agenthub-Landing',
  hub: 'Agenthub-Hub',
  source: 'Agenthub-Source',
  attempt: 'Agenthub-Attempt',
  task: 'Agenthub-Task',
  agent: 'Agenthub-Agent',
  resolved: 'Agenthub-Resolved',
  checked: 'Agenthub-Checked',
  approved: 'Agenthub-Approved',
} as const;
/** Lines agent-written text may not contain in a commit message (they would forge trailers). */
export const TRAILER_LINE_RE = /^\s*Agenthub-[A-Za-z-]*\s*:/im;

// ------------------------------------------------------------------ names

/** `<project>/<L-id>`: the value of the Agenthub-Landing trailer. */
export function landingKey(project: string, landingId: string): string {
  return `${project}/${landingId}`;
}

/** The remote ref `land` pushes the commit to. */
export function landRef(prefix: string, sha: string): string {
  return `${prefix}land/${sha}`;
}

/** Where the lander stages a candidate before it records `pushing`: named by hub epoch, landing and the candidate's own sha, so it never collides. */
export function candidateRef(prefix: string, epoch: string, landingId: string, candidate: string): string {
  return `${prefix}cand/${epoch.replace(/-/g, '').slice(0, 8)}/${landingId}/${candidate.slice(0, 12)}`;
}

/** The human part of an agent id (`maya` in `maya/claude-1`). */
export function humanOf(agent: string): string {
  return agent.split('/')[0] ?? agent;
}

export function isValidSymbolKey(s: string): boolean {
  return s.length > 0 && s.length <= MAX_SYMBOL_KEY && SYMBOL_KEY_RE.test(s);
}

// ------------------------------------------------------------------ scope rules (design §1.10)

/** Two entries of claims made with the same mapper overlap. A missing symbol is the whole file. */
export function entriesOverlap(a: ScopeLike, b: ScopeLike): boolean {
  if (a.file !== b.file) return false;
  if (a.symbol === undefined || b.symbol === undefined) return true;
  if (a.symbol === IMPORTS && b.symbol === IMPORTS) return false;
  return a.symbol === b.symbol || a.symbol.startsWith(`${b.symbol}.`) || b.symbol.startsWith(`${a.symbol}.`);
}

/** A held entry covers a wanted one: a whole-file entry covers the file; a symbol covers itself and its members. */
export function entryCovers(held: ScopeLike, wanted: ScopeLike): boolean {
  if (held.file !== wanted.file) return false;
  if (held.symbol === undefined) return true;
  if (wanted.symbol === undefined) return false;
  return wanted.symbol === held.symbol || wanted.symbol.startsWith(`${held.symbol}.`);
}

/**
 * Mapper gating: symbol entries count only between two claims made with the
 * same non-null mapper. Otherwise each entry is compared as its whole file.
 */
export function comparable(a: ScopedLike, b: ScopedLike): boolean {
  return a.mapper !== null && a.mapper === b.mapper;
}

function fileOnly(e: ScopeLike): ScopeLike {
  return { file: e.file };
}

/** The entries of `b` that some entry of `a` overlaps, with mapper gating. */
export function overlappingEntries<T extends ScopeLike>(a: ScopedLike, b: { scope: T[]; mapper: string | null }): T[] {
  const same = comparable(a, b);
  return b.scope.filter((y) => a.scope.some((x) => (same ? entriesOverlap(x, y) : entriesOverlap(fileOnly(x), fileOnly(y)))));
}

/** Whether a held claim covers a wanted entry of a request (renewal instead of a new claim), with mapper gating. */
export function claimCovers(held: ScopedLike, wanted: ScopeLike, wantedMapper: string | null): boolean {
  const same = held.mapper !== null && held.mapper === wantedMapper;
  return held.scope.some((h) => (same ? entryCovers(h, wanted) : h.file === wanted.file && h.symbol === undefined));
}

// ------------------------------------------------------------------ globs
// Syntax: '*' = any run without a slash; '**' = any run; '**' followed by a
// slash = zero or more directories; '?' = one character except a slash. The
// glob matches the whole repo path. (Line comments on purpose: a block comment
// would be closed by the double-star-slash in this explanation.)

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$+.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'u');
}

export function validGlob(glob: string): boolean {
  return glob.length > 0 && glob.length <= 500 && !glob.startsWith('/') && !glob.includes('\\') && !/[[\]{}!]/.test(glob);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ------------------------------------------------------------------ team config (agenthub.json)

export interface ProtectedRule {
  paths: string[];
  /** Humans who may approve; null = any configured approver. */
  approvers: string[] | null;
  /** The approver must not be the landing agent's own human. */
  distinct: boolean;
}

export interface ResolverConfig {
  enabled: boolean;
  model: string;
  maxFiles: number;
  maxFileBytes: number;
  exclude: string[];
  requireApproval: boolean;
}

export interface LandConfig {
  remote: string;
  trunk: string;
  /** Run with `sh -c` in a fresh worktree of the candidate. Required. */
  check: string;
  checkTimeoutMin: number;
  /** Non-secret values set for checks (secrets come from the lander's passEnv). */
  checkEnv: Record<string, string>;
  allowDirtyTree: boolean;
  /** ALWAYS_PROTECTED first, as a rule anyone may approve with distinct = approval.distinct. */
  protected: ProtectedRule[];
  approval: { distinct: boolean; timeoutHours: number };
  refPrefix: string;
  structural: 'auto' | 'off';
  resolver: ResolverConfig;
  claimGate: 'fail' | 'warn';
  keepPlaceRetries: number;
  sendbackGraceMin: number;
  maxFiles: number;
  externalPushes: 'warn' | 'pause';
  /** Opt-in: the Stop hook keeps an agent in its turn once per landing until the landing comes back. */
  holdTurn: boolean;
}

export interface SyncConfig {
  /** Sync automatically at SessionStart and UserPromptSubmit. */
  auto: boolean;
  /** What the edit hook says when trunk changed the file since the worktree's base. */
  staleEdit: 'warn' | 'off';
}

export interface SymbolsConfig {
  enabled: boolean;
  exclude: string[];
  maxSymbolsPerEdit: number;
}

export interface TeamSections {
  /** null: the project has no landing queue; `land` keeps Phase 1 record behaviour. */
  land: LandConfig | null;
  sync: SyncConfig;
  symbols: SymbolsConfig;
}

export const RESOLVER_EXCLUDE_DEFAULT: readonly string[] = ['**/.env*', '**/*.pem', '**/*.key', '**/secrets/**'];

const LAND_KEYS = [
  'remote', 'trunk', 'check', 'checkTimeoutMin', 'checkEnv', 'allowDirtyTree', 'protected', 'approval', 'refPrefix',
  'structural', 'resolver', 'claimGate', 'keepPlaceRetries', 'sendbackGraceMin', 'maxFiles', 'externalPushes', 'holdTurn',
];
const RESOLVER_KEYS = ['enabled', 'model', 'maxFiles', 'maxFileBytes', 'exclude', 'requireApproval'];
const REF_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * The land, sync and symbols sections of a parsed agenthub.json. Strict (the
 * lander, the `land` tool, `hub doctor`): the first problem throws an Error
 * naming the key; unknown keys inside these sections are problems too, so a
 * typo can't silently drop a protection. Lenient (hooks, digest, guard): a bad
 * value falls back to its default and is reported in `problems`; this never
 * throws, because a config error blocks every edit in Phase 1 (hooks.ts).
 */
export function parseTeamSections(value: unknown, opts: { strict: boolean; where?: string }): { sections: TeamSections; problems: string[] } {
  const where = opts.where ?? 'agenthub.json';
  const problems: string[] = [];
  const problem = (key: string, what: string): void => {
    const text = `${where}: "${key}" ${what}`;
    if (opts.strict) throw new Error(text);
    problems.push(text);
  };
  const root = isObject(value) ? value : {};
  const section = (v: unknown, key: string, allowed: readonly string[] | null): Record<string, unknown> => {
    if (v === undefined) return {};
    if (!isObject(v)) {
      problem(key, 'must be an object');
      return {};
    }
    if (allowed) for (const k of Object.keys(v)) if (!allowed.includes(k)) problem(`${key}.${k}`, 'is not a known setting');
    return v;
  };
  const str = (o: Record<string, unknown>, key: string, at: string, def: string, re?: RegExp): string => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'string' || !v.trim() || (re && !re.test(v))) {
      problem(`${at}.${key}`, 'must be a valid non-empty string');
      return def;
    }
    return v.trim();
  };
  const int = (o: Record<string, unknown>, key: string, at: string, def: number, min: number, max: number): number => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      problem(`${at}.${key}`, `must be a whole number from ${min} to ${max}`);
      return def;
    }
    return v;
  };
  const bool = (o: Record<string, unknown>, key: string, at: string, def: boolean): boolean => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      problem(`${at}.${key}`, 'must be true or false');
      return def;
    }
    return v;
  };
  const oneOf = <T extends string>(o: Record<string, unknown>, key: string, at: string, def: T, options: readonly T[]): T => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'string' || !options.includes(v as T)) {
      problem(`${at}.${key}`, `must be one of ${options.join(', ')}`);
      return def;
    }
    return v as T;
  };
  const globs = (o: Record<string, unknown>, key: string, at: string, def: readonly string[]): string[] => {
    const v = o[key];
    if (v === undefined) return [...def];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !validGlob(s))) {
      problem(`${at}.${key}`, 'must be a list of globs (no leading /, no [ ] { } !)');
      return [...def];
    }
    return [...(v as string[])];
  };

  let land: LandConfig | null = null;
  if (root.land !== undefined) {
    const l = section(root.land, 'land', LAND_KEYS);
    const approval = section(l.approval, 'land.approval', ['distinct', 'timeoutHours']);
    const distinct = bool(approval, 'distinct', 'land.approval', true);
    const rules: ProtectedRule[] = [{ paths: [...ALWAYS_PROTECTED], approvers: null, distinct }];
    const rawProtected = l.protected === undefined ? [] : Array.isArray(l.protected) ? l.protected : (problem('land.protected', 'must be a list'), []);
    for (const [i, r] of rawProtected.entries()) {
      if (typeof r === 'string') {
        if (validGlob(r)) rules.push({ paths: [r], approvers: null, distinct });
        else problem(`land.protected[${i}]`, 'is not a valid glob');
      } else if (isObject(r)) {
        const o = section(r, `land.protected[${i}]`, ['paths', 'approvers', 'distinct']);
        const paths = globs(o, 'paths', `land.protected[${i}]`, []);
        const approvers = o.approvers === undefined ? null : Array.isArray(o.approvers) && o.approvers.every((a) => typeof a === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a)) ? (o.approvers as string[]) : (problem(`land.protected[${i}].approvers`, 'must be a list of human names'), null);
        if (paths.length) rules.push({ paths, approvers, distinct: bool(o, 'distinct', `land.protected[${i}]`, distinct) });
      } else problem(`land.protected[${i}]`, 'must be a glob or {paths, approvers?, distinct?}');
    }
    const envObj = section(l.checkEnv, 'land.checkEnv', null);
    const checkEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(envObj)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string') checkEnv[k] = v;
      else problem(`land.checkEnv.${k}`, 'must be NAME: "string"');
    }
    const r = section(l.resolver, 'land.resolver', RESOLVER_KEYS);
    const refPrefix = str(l, 'refPrefix', 'land', DEFAULT_REF_PREFIX, REF_NAME_RE);
    const prefixOk = refPrefix.startsWith('refs/') && refPrefix.endsWith('/') && !refPrefix.includes('..');
    if (!prefixOk) problem('land.refPrefix', 'must look like refs/<namespace>/');
    const check = str(l, 'check', 'land', '');
    if (!check) problem('land.check', 'is required: the landing queue lands nothing without checks');
    land = {
      remote: str(l, 'remote', 'land', 'origin', /^[A-Za-z0-9._-]{1,100}$/),
      trunk: str(l, 'trunk', 'land', 'main', REF_NAME_RE),
      check,
      checkTimeoutMin: int(l, 'checkTimeoutMin', 'land', 20, 1, 240),
      checkEnv,
      allowDirtyTree: bool(l, 'allowDirtyTree', 'land', false),
      protected: rules,
      approval: { distinct, timeoutHours: int(approval, 'timeoutHours', 'land.approval', 24, 1, 168) },
      refPrefix: prefixOk ? refPrefix : DEFAULT_REF_PREFIX,
      structural: oneOf(l, 'structural', 'land', 'auto', ['auto', 'off'] as const),
      resolver: {
        enabled: bool(r, 'enabled', 'land.resolver', false),
        model: str(r, 'model', 'land.resolver', 'claude-opus-5-5', /^[a-z0-9.-]{1,100}$/),
        maxFiles: int(r, 'maxFiles', 'land.resolver', 4, 1, 20),
        maxFileBytes: int(r, 'maxFileBytes', 'land.resolver', 65_536, 1_024, 1_048_576),
        exclude: globs(r, 'exclude', 'land.resolver', RESOLVER_EXCLUDE_DEFAULT),
        requireApproval: bool(r, 'requireApproval', 'land.resolver', false),
      },
      claimGate: oneOf(l, 'claimGate', 'land', 'fail', ['fail', 'warn'] as const),
      keepPlaceRetries: int(l, 'keepPlaceRetries', 'land', 2, 0, 5),
      sendbackGraceMin: int(l, 'sendbackGraceMin', 'land', 30, 0, 240),
      maxFiles: int(l, 'maxFiles', 'land', 2000, 1, 20_000),
      externalPushes: oneOf(l, 'externalPushes', 'land', 'warn', ['warn', 'pause'] as const),
      holdTurn: bool(l, 'holdTurn', 'land', false),
    };
    if (!check) land = opts.strict ? land : null;
  }
  const s = section(root.sync, 'sync', ['auto', 'staleEdit']);
  const y = section(root.symbols, 'symbols', ['enabled', 'exclude', 'maxSymbolsPerEdit']);
  return {
    sections: {
      land,
      sync: { auto: bool(s, 'auto', 'sync', true), staleEdit: oneOf(s, 'staleEdit', 'sync', 'warn', ['warn', 'off'] as const) },
      symbols: {
        enabled: bool(y, 'enabled', 'symbols', true),
        exclude: globs(y, 'exclude', 'symbols', []),
        maxSymbolsPerEdit: int(y, 'maxSymbolsPerEdit', 'symbols', 12, 1, 100),
      },
    },
    problems,
  };
}

/** The protected rules a set of changed paths triggers, and which paths each covers. */
export function protectedMatches(paths: readonly string[], rules: readonly ProtectedRule[]): Array<{ rule: ProtectedRule; paths: string[] }> {
  const out: Array<{ rule: ProtectedRule; paths: string[] }> = [];
  for (const rule of rules) {
    const hit = paths.filter((p) => matchesAny(p, rule.paths));
    if (hit.length) out.push({ rule, paths: [...new Set(hit)].sort() });
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
