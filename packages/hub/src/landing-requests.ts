import { FULL_SHA_RE, RESERVED_PREFIX, isValidSymbolKey } from '@agenthub/contract';
import { HubError, cleanText, normalizeRepoPath, unique } from './common.js';
import { PATH_FORBIDDEN_RE } from './protocol.js';
import type {
  ApprovalKind,
  ApprovalRequirement,
  ApprovalRule,
  LandPolicy,
  LanderAuth,
  LandingFailureCode,
  LandingReport,
  RequeueReason,
  ScopeEntry,
  SymbolChangeInput,
} from './protocol.js';

// Validation of the lander's and the approvers' request bodies (design §1.7),
// before any write: every problem is 400 bad_request (invalid_path for a bad
// path, invalid_symbol for a bad symbol key, 403 forbidden for a reserved
// path). The values come back normalized, in the protocol's shapes.

const MAX_FILES = 20_000;
const MAX_REQUIREMENTS = 50;
const MAX_RULES = 20;
const MAX_COMMITS = 500;
const MAX_ALSO_LANDED = 100;
const MAX_WARNINGS = 50;
const MAX_SYMBOL_CHANGES = 1000;
const MAX_REPORT_CHARS = 512 * 1024;
const MAX_MAPPER = 200;
/** A content digest: sha256 hex in practice (gitops.approvalDigest). */
const DIGEST_RE = /^[0-9a-f]{16,128}$/;
/** A human's name, as approver files and protected rules write it. */
export const HUMAN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANDING_ID_RE = /^L-[1-9][0-9]{0,15}$/;
const REF_RE = /^refs\/[A-Za-z0-9._/-]{1,250}$/;

export const FAILURE_CODES: readonly LandingFailureCode[] = [
  'not_pushed',
  'nothing_to_land',
  'too_large',
  'claim_conflict',
  'contains_unlanded',
  'conflict',
  'resolver_failed',
  'checks_failed',
  'check_timeout',
  'checks_modified_tree',
  'trunk_busy',
  'push_rejected',
  'approval_rejected',
  'approval_timeout',
  'lander_lost',
  'lander_stuck',
  'lander_error',
];
/** Why a lander may requeue its running landing; lander_lost and step_timeout are the hub's, approved an approver's. */
const LANDER_REQUEUE_REASONS: readonly RequeueReason[] = ['trunk_moved', 'lander_stopping', 'remote_unavailable', 'config_invalid', 'trunk_rewritten'];
const KINDS: readonly ApprovalKind[] = ['protected', 'merged', 'ai_resolution'];
const PAUSE_REASONS = ['push_rejected', 'config_invalid', 'external_push', 'trunk_rewritten'] as const;
type PauseReason = (typeof PAUSE_REASONS)[number];

export interface AdmitInput {
  lease: LanderAuth;
  base_sha: string | null;
  files: string[];
  scope: ScopeEntry[] | null;
  mapper: string | null;
  protected: string[];
  required: ApprovalRequirement[];
  waits_for: string | null;
  warnings: string[];
  /** T3 through admit: the landing fails with this code instead of being admitted. */
  failure: { code: LandingFailureCode; report: LandingReport } | null;
}

export type AdvanceInput =
  | { to: 'running'; phase: 'merging' | 'resolving' | 'checking'; lease: LanderAuth; attempt: number; deadline_ms: number; trunk_base: string | null }
  | { to: 'running'; phase: 'pushing'; lease: LanderAuth; attempt: number; candidate: string; candidate_ref: string; trunk_base: string; tree: string; required: ApprovalRequirement[] }
  | { to: 'queued'; lease: LanderAuth; attempt: number; reason: RequeueReason }
  | { to: 'needs_approval'; lease: LanderAuth; attempt: number; required: ApprovalRequirement[]; report: LandingReport; candidate: string | null; candidate_ref: string | null }
  | {
      to: 'landed';
      lease: LanderAuth;
      attempt: number;
      trunk_sha: string;
      base_sha: string | null;
      files: string[] | null;
      report: LandingReport | null;
      also_landed: string[];
      symbol_changes: SymbolChangeInput[];
    }
  | { to: 'failed'; lease: LanderAuth; attempt: number; code: LandingFailureCode; report: LandingReport };

export type ResolveInput =
  | { outcome: 'landed'; lease: LanderAuth; trunk_sha: string; symbol_changes: SymbolChangeInput[] }
  | { outcome: 'requeue'; lease: LanderAuth; trunk_sha: string };

export interface TrunkCommit {
  sha: string;
  landing: string | null;
  hub: string | null;
  source: string | null;
  files: string[];
}

export interface TrunkReportInput {
  lease: LanderAuth;
  from: string | null;
  to: string;
  commits: TrunkCommit[];
  rewritten: boolean;
  policy: LandPolicy;
}

// ------------------------------------------------------------------ requests

export function parseLease(value: unknown): LanderAuth {
  const o = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const id = o?.lease_claim_id;
  const epoch = o?.epoch;
  if (typeof id !== 'string' || !id || id.length > 64 || typeof epoch !== 'string' || !epoch || epoch.length > 100) {
    throw bad('lander writes carry `lease`: {lease_claim_id, epoch}, the lease claim and the hub epoch it was granted under');
  }
  return { lease_claim_id: id, epoch };
}

export function parseAdmit(body: unknown): AdmitInput {
  const req = object(body, 'the request');
  const lease = parseLease(req.lease);
  const failure = req.code === undefined || req.code === null ? null : { code: failureCode(req.code), report: parseReport(req.report) };
  const mapper = optionalText(req.mapper, 'mapper', MAX_MAPPER);
  const scopeRaw = req.scope === undefined || req.scope === null ? null : list(req.scope, 'scope', MAX_FILES);
  const scope = scopeRaw === null ? null : normalizeLandingScope(scopeRaw, mapper);
  const files = unique([...paths(req.files ?? [], 'files'), ...(scope ?? []).map((e) => e.file)]);
  if (files.length > MAX_FILES) throw bad(`a landing names at most ${MAX_FILES} files`);
  return {
    lease,
    // A landing that fails admission may not have a base (its ref was never fetched).
    base_sha: failure && (req.base_sha === undefined || req.base_sha === null) ? null : sha(req.base_sha, 'base_sha'),
    files,
    scope: scope && scope.length > 0 ? scope : null,
    mapper,
    protected: paths(req.protected ?? [], 'protected').sort(),
    required: parseRequirements(req.required ?? [], 'required'),
    waits_for: req.waits_for === undefined || req.waits_for === null ? null : landingId(req.waits_for, 'waits_for'),
    warnings: list(req.warnings ?? [], 'warnings', MAX_WARNINGS).map((w, i) => {
      if (typeof w !== 'string') throw bad(`warnings[${i}] must be a string`);
      return cleanText(w, 500);
    }),
    failure,
  };
}

export function parseAdvance(body: unknown): AdvanceInput {
  const req = object(body, 'the request');
  const lease = parseLease(req.lease);
  const attempt = req.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) throw bad('attempt must be the attempt number next gave (0 before the first)');
  switch (req.to) {
    case 'running': {
      if (req.phase === 'pushing') {
        if (typeof req.candidate_ref !== 'string' || !REF_RE.test(req.candidate_ref) || req.candidate_ref.includes('..')) throw bad('candidate_ref must be the ref the candidate is staged at');
        return {
          to: 'running',
          phase: 'pushing',
          lease,
          attempt,
          candidate: sha(req.candidate, 'candidate'),
          candidate_ref: req.candidate_ref,
          trunk_base: sha(req.trunk_base, 'trunk_base'),
          tree: sha(req.tree, 'tree'),
          required: parseRequirements(req.required ?? [], 'required'),
        };
      }
      if (req.phase !== 'merging' && req.phase !== 'resolving' && req.phase !== 'checking') throw bad('phase must be merging, resolving, checking or pushing');
      const deadline = req.deadline_ms ?? 10 * 60_000;
      if (typeof deadline !== 'number' || !Number.isFinite(deadline)) throw bad('deadline_ms must be a number of milliseconds');
      return { to: 'running', phase: req.phase, lease, attempt, deadline_ms: deadline, trunk_base: req.trunk_base === undefined || req.trunk_base === null ? null : sha(req.trunk_base, 'trunk_base') };
    }
    case 'queued': {
      if (typeof req.reason !== 'string' || !LANDER_REQUEUE_REASONS.includes(req.reason as RequeueReason)) {
        throw bad(`a lander requeues for one of: ${LANDER_REQUEUE_REASONS.join(', ')}`);
      }
      return { to: 'queued', lease, attempt, reason: req.reason as RequeueReason };
    }
    case 'needs_approval':
      return {
        to: 'needs_approval',
        lease,
        attempt,
        required: parseRequirements(req.required, 'required'),
        report: parseReport(req.report),
        candidate: req.candidate === undefined || req.candidate === null ? null : sha(req.candidate, 'candidate'),
        candidate_ref: req.candidate_ref === undefined || req.candidate_ref === null ? null : ref(req.candidate_ref, 'candidate_ref'),
      };
    case 'landed':
      return {
        to: 'landed',
        lease,
        attempt,
        trunk_sha: sha(req.trunk_sha, 'trunk_sha'),
        base_sha: req.base_sha === undefined || req.base_sha === null ? null : sha(req.base_sha, 'base_sha'),
        files: req.files === undefined || req.files === null ? null : paths(req.files, 'files'),
        report: req.report === undefined || req.report === null ? null : parseReport(req.report),
        also_landed: unique(list(req.also_landed ?? [], 'also_landed', MAX_ALSO_LANDED).map((id, i) => landingId(id, `also_landed[${i}]`))),
        symbol_changes: symbolChanges(req.symbol_changes),
      };
    case 'failed':
      return { to: 'failed', lease, attempt, code: failureCode(req.code), report: parseReport(req.report) };
    default:
      throw bad('to must be running, queued, needs_approval, landed or failed');
  }
}

export function parseResolve(body: unknown): ResolveInput {
  const req = object(body, 'the request');
  const lease = parseLease(req.lease);
  const trunk_sha = sha(req.trunk_sha, 'trunk_sha');
  if (req.outcome === 'landed') return { outcome: 'landed', lease, trunk_sha, symbol_changes: symbolChanges(req.symbol_changes) };
  if (req.outcome === 'requeue') return { outcome: 'requeue', lease, trunk_sha };
  throw bad('outcome must be landed or requeue');
}

export function parseTrunkReport(body: unknown): TrunkReportInput {
  const req = object(body, 'the request');
  const lease = parseLease(req.lease);
  const commits = list(req.commits ?? [], 'commits', MAX_COMMITS).map((raw, i): TrunkCommit => {
    const c = object(raw, `commits[${i}]`);
    return {
      sha: sha(c.sha, `commits[${i}].sha`),
      landing: optionalText(c.landing, `commits[${i}].landing`, 300),
      hub: optionalText(c.hub, `commits[${i}].hub`, 100),
      source: optionalText(c.source, `commits[${i}].source`, 64),
      // Whatever trunk holds: a path no claim could name is left out rather than refusing the report.
      files: list(c.files ?? [], `commits[${i}].files`, MAX_FILES)
        .filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 4096 && !PATH_FORBIDDEN_RE.test(f))
        .slice(0, 200),
    };
  });
  if (req.rewritten !== undefined && typeof req.rewritten !== 'boolean') throw bad('rewritten must be true or false');
  return {
    lease,
    from: req.from === undefined || req.from === null ? null : sha(req.from, 'from'),
    to: sha(req.to, 'to'),
    commits,
    rewritten: req.rewritten === true,
    policy: parsePolicy(req.policy),
  };
}

export function parsePause(body: unknown): { lease: LanderAuth; reason: PauseReason; detail: string } {
  const req = object(body, 'the request');
  const lease = parseLease(req.lease);
  if (typeof req.reason !== 'string' || !PAUSE_REASONS.includes(req.reason as PauseReason)) throw bad(`a lander pauses for one of: ${PAUSE_REASONS.join(', ')}`);
  return { lease, reason: req.reason as PauseReason, detail: cleanText(req.detail ?? '', 500) };
}

export function parseResume(body: unknown): { accept_trunk: string | null } {
  const req = object(body ?? {}, 'the request');
  return { accept_trunk: req.accept_trunk === undefined || req.accept_trunk === null ? null : sha(req.accept_trunk, 'accept_trunk') };
}

export function parseApprove(body: unknown): { kind: ApprovalKind; digest: string; note: string } {
  const req = object(body, 'the request');
  if (typeof req.kind !== 'string' || !KINDS.includes(req.kind as ApprovalKind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  return { kind: req.kind as ApprovalKind, digest: digest(req.digest, 'digest'), note: cleanText(req.note ?? '', 1000, true) };
}

export function parseReject(body: unknown): { reason: string } {
  const req = object(body, 'the request');
  const reason = cleanText(req.reason ?? '', 1000, true);
  if (!reason) throw bad('a rejection needs a reason: what should change before it lands');
  return { reason };
}

export function parseCancel(body: unknown): { reason: string } {
  const req = object(body ?? {}, 'the request');
  return { reason: cleanText(req.reason ?? '', 1000, true) };
}

/** The landing statistics window: 1 to 365 days, 7 by default. */
export function parseDays(value: unknown): number {
  if (value === undefined || value === null || value === '') return 7;
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad('days must be a number');
  return Math.min(365, Math.max(1, Math.round(n)));
}

export function parsePolicy(value: unknown): LandPolicy {
  const p = object(value, 'policy');
  const int = (key: keyof LandPolicy, min: number, max: number): number => {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`policy.${key} must be a whole number from ${min} to ${max}`);
    return v;
  };
  if (p.claim_gate !== 'fail' && p.claim_gate !== 'warn') throw bad('policy.claim_gate must be fail or warn');
  return {
    keep_place_retries: int('keep_place_retries', 0, 5),
    sendback_grace_min: int('sendback_grace_min', 0, 240),
    approval_timeout_hours: int('approval_timeout_hours', 1, 168),
    claim_gate: p.claim_gate,
  };
}

// ------------------------------------------------------------------ parts

export function parseRequirements(value: unknown, name: string): ApprovalRequirement[] {
  const out: ApprovalRequirement[] = [];
  for (const [i, raw] of list(value, name, MAX_REQUIREMENTS).entries()) {
    const at = `${name}[${i}]`;
    const r = object(raw, at);
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind as ApprovalKind)) throw bad(`${at}.kind must be one of ${KINDS.join(', ')}`);
    const rules = list(r.rules, `${at}.rules`, MAX_RULES).map((x, j) => rule(x, `${at}.rules[${j}]`));
    if (rules.length === 0) throw bad(`${at}.rules needs at least one rule`);
    const covered = paths(r.paths, `${at}.paths`).sort();
    if (covered.length === 0) throw bad(`${at}.paths needs at least one path`);
    out.push({
      kind: r.kind as ApprovalKind,
      digest: digest(r.digest, `${at}.digest`),
      paths: covered,
      rules,
      candidate: r.candidate === undefined || r.candidate === null ? null : sha(r.candidate, `${at}.candidate`),
      candidate_ref: r.candidate_ref === undefined || r.candidate_ref === null ? null : ref(r.candidate_ref, `${at}.candidate_ref`),
      trunk_base: r.trunk_base === undefined || r.trunk_base === null ? null : sha(r.trunk_base, `${at}.trunk_base`),
    });
  }
  return out;
}

function rule(value: unknown, at: string): ApprovalRule {
  const r = object(value, at);
  const globs = list(r.paths, `${at}.paths`, 100).map((g, i) => {
    if (typeof g !== 'string' || !g || g.length > 500 || PATH_FORBIDDEN_RE.test(g)) throw bad(`${at}.paths[${i}] must be a glob`);
    return g;
  });
  if (globs.length === 0) throw bad(`${at}.paths needs at least one glob`);
  let approvers: string[] | null = null;
  if (r.approvers !== null && r.approvers !== undefined) {
    approvers = unique(
      list(r.approvers, `${at}.approvers`, 100).map((a, i) => {
        if (typeof a !== 'string' || !HUMAN_RE.test(a)) throw bad(`${at}.approvers[${i}] must be a human's name`);
        return a;
      }),
    );
    if (approvers.length === 0) throw bad(`${at}.approvers is null (any approver) or names at least one`);
  }
  if (typeof r.distinct !== 'boolean') throw bad(`${at}.distinct must be true or false`);
  return { paths: globs, approvers, distinct: r.distinct };
}

/** A lander-written report: an object with a message, stored as sent (at most 512 KiB of JSON). */
export function parseReport(value: unknown): LandingReport {
  const report = object(value, 'report');
  if (typeof report.message !== 'string') throw bad('report.message must be a string');
  if (JSON.stringify(report).length > MAX_REPORT_CHARS) throw bad('report is larger than 512 KiB');
  return report as unknown as LandingReport;
}

/**
 * Scope entries of a landing: `{file}` is the whole file; a symbol must be a
 * declaration key (SYMBOL_KEY_RE, at most 200 characters) and needs the
 * mapper that produced it (400 invalid_symbol). Reserved paths are refused.
 */
export function normalizeLandingScope(raw: unknown[], mapper: string | null): ScopeEntry[] {
  const seen = new Set<string>();
  const out: ScopeEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw bad('scope entries look like {file, symbol?}');
    const { file: rawFile, symbol: rawSymbol } = entry as { file?: unknown; symbol?: unknown };
    const file = assertNotReserved(normalizeRepoPath(rawFile));
    let symbol: string | undefined;
    if (rawSymbol !== undefined && rawSymbol !== null) {
      if (typeof rawSymbol !== 'string' || !isValidSymbolKey(rawSymbol.normalize('NFC'))) {
        throw new HubError('invalid_symbol', 'scope symbols are declaration keys such as login, Session.refresh, @imports or @toplevel, at most 200 characters');
      }
      if (mapper === null) throw new HubError('invalid_symbol', 'symbol entries need the mapper (MAPPER_VERSION) that produced them');
      symbol = rawSymbol.normalize('NFC');
    }
    const key = `${file}\u0000${symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol === undefined ? { file } : { file, symbol });
  }
  return out;
}

/** Paths under RESERVED_PREFIX belong to the lander lease: no landing may name them (403 forbidden). */
export function assertNotReserved(path: string): string {
  if (path.startsWith(RESERVED_PREFIX)) {
    throw new HubError('forbidden', `${path} is under ${RESERVED_PREFIX}, which is reserved for the lander lease`, 403);
  }
  return path;
}

function symbolChanges(value: unknown): SymbolChangeInput[] {
  // Recorded from H6 on; until then only their shape is checked.
  return list(value ?? [], 'symbol_changes', MAX_SYMBOL_CHANGES).map((c, i) => object(c, `symbol_changes[${i}]`) as unknown as SymbolChangeInput);
}

function failureCode(value: unknown): LandingFailureCode {
  if (typeof value !== 'string' || !FAILURE_CODES.includes(value as LandingFailureCode)) throw bad(`code must be one of ${FAILURE_CODES.join(', ')}`);
  return value as LandingFailureCode;
}

function landingId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !LANDING_ID_RE.test(value)) throw bad(`${name} must be a landing id such as L-7`);
  return value;
}

function paths(value: unknown, name: string): string[] {
  return unique(list(value, name, MAX_FILES).map((p) => assertNotReserved(normalizeRepoPath(p))));
}

function sha(value: unknown, name: string): string {
  if (typeof value !== 'string' || !FULL_SHA_RE.test(value)) throw bad(`${name} must be a full lowercase sha`);
  return value;
}

function ref(value: unknown, name: string): string {
  if (typeof value !== 'string' || !REF_RE.test(value) || value.includes('..')) throw bad(`${name} must be a ref name under refs/`);
  return value;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw bad(`${name} must be the hex content digest`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max || PATH_FORBIDDEN_RE.test(value)) throw bad(`${name} must be a string of at most ${max} characters`);
  return value || null;
}

function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw bad(`${name} must be a list`);
  if (value.length > max) throw bad(`${name} has more than ${max} items`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function bad(message: string): HubError {
  return new HubError('bad_request', message);
}
