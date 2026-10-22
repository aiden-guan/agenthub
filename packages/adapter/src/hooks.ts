import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isValidSymbolKey, type SymbolsConfig } from '@agenthub/contract';
import type { Claim, ClaimConflict, ClaimResult, Landing, StatusResult } from '@agenthub/hub/protocol';
import { claimRoot, lendIdentity, recordLending } from './checkout.js';
import { HubApiError, HubClient, classifyFailure, type HubFailure } from './client.js';
import { hasOwnSettings, loadConfig, sameHub, teamSections, type HubConfig } from './config.js';
import {
  denyReason,
  digestText,
  editImpactNote,
  inline,
  isLanderLease,
  postEditConflictText,
  postEditImpactText,
  scopeNames,
  showName,
  showNames,
  syncDigestLine,
  syncNoticeKey,
  syncPromptText,
  type DenyContext,
  type DigestExtras,
} from './format.js';
import { currentBranch, headCommit, isIgnored, toRepoPath, unclaimableReason } from './git.js';
import { commitGuardOff } from './guard-status.js';
import { PendingClaims, type StoredClaim } from './pending.js';
import { HOOK_SYNC_BUDGET_MS, clearMarkers, clearMarkersElsewhere, enterEdit, noteMarkerElsewhere, removeMarker, staleFiles, syncPaths, syncWorkspace, type SyncPaths, type SyncResult } from './sync.js';
import { cachedChanges, editImpacts, firstTimeInSession, isNews, readAcks, relevantAll, sortImpacts, whoUses, type WhoUses } from './impact.js';
import {
  MAX_MAPPED_BYTES,
  editScope,
  missingAfterEdit,
  saveEditState,
  saveWholeEditState,
  sha256,
  symbolsModule,
  takeEditState,
  wholeFileWhy,
  type EditScope,
  type EditState,
} from './symbol-scope.js';

export interface HookIO {
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface HookOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ALLOW: HookOutcome = { stdout: '', stderr: '', exitCode: 0 };
/**
 * Upper bound for one hub request from a hook, whatever HUB_TIMEOUT_MS says, so
 * the hook always answers inside the 30 s timeout `hub init` gives it. (A hook
 * that times out is a failure, which `onFailure: "block"` turns into a denial.)
 */
const HOOK_REQUEST_TIMEOUT_MS = 10_000;
/**
 * The hooks that sync (settle, digest) are bounded at 15 s (design §2.3.5):
 * everything they do after they start, hub requests and the sync together,
 * fits in this, which leaves the rest for starting node and answering.
 */
export const HOOK_DEADLINE_MS = 12_500;
/** settle on UserPromptSubmit: releasing pending claims gets this much of it, so the sync after it keeps time to run. */
const SETTLE_RELEASE_MS = 4_000;
/** The digest: the hub requests after its sync (heartbeat, status, stats) keep this much of it. */
const DIGEST_RESERVE_MS = 4_000;
/** A hub request with less time than this left isn't started (its claim waits for the next try). */
const MIN_REQUEST_MS = 200;
/** Phase 3 impacts from the edit hooks are best effort within this (design §2.3.6: posting, and who_uses, 2 s each). */
const IMPACT_BUDGET_MS = 2_000;

/**
 * Let the edit through, and make sure someone sees that it isn't coordinated.
 * Claude Code drops stderr from a hook that exits 0, so the warning goes to the
 * user (systemMessage) and to Claude (additionalContext), with no
 * permissionDecision so the normal permission flow still applies.
 */
function allowWithWarning(msg: string, max = 300): HookOutcome {
  const text = `agenthub: ${inline(msg, max)}`;
  return {
    stdout: JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }),
    stderr: `hub: ${msg}\n`,
    exitCode: 0,
  };
}

const deny = (reason: string): HookOutcome => ({ stdout: denyJson(reason), stderr: '', exitCode: 0 });

/**
 * A hub failure for Claude: why the config withheld the token in full, the
 * hub's own words capped, long enough for a refusal that ends with the
 * hub-server flag that fixes it (forbidden_host).
 */
function failureText(failure: HubFailure, cfg: HubConfig): string {
  return inline(failure.message, 700 + (failure.kind === 'auth' ? (cfg.tokenWithheld?.length ?? 0) : 0));
}

/** A client for one hook request: within HOOK_REQUEST_TIMEOUT_MS, and done by `until` when the hook has a deadline. */
function hookClient(cfg: HubConfig, until?: number): HubClient {
  const cap = Math.min(cfg.timeoutMs, HOOK_REQUEST_TIMEOUT_MS, until === undefined ? Infinity : until - Date.now());
  return new HubClient({ ...cfg, timeoutMs: Math.max(1, Math.floor(cap)) });
}

/** Claude Code PreToolUse output that blocks the tool call and tells the model why. */
export function denyJson(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function parseInput(stdin: string): Record<string, any> | null {
  try {
    const v = stdin.trim() ? JSON.parse(stdin) : {};
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function cwdFor(input: Record<string, any>, io: HookIO): string {
  return typeof input.cwd === 'string' && input.cwd ? input.cwd : io.cwd;
}

/** Where the session runs: Claude Code's project dir, which (unlike cwd) never follows `cd`. */
function sessionDir(input: Record<string, any>, io: HookIO): string {
  return io.env.CLAUDE_PROJECT_DIR || cwdFor(input, io);
}

/**
 * The repository and claim keys for the files a tool call edits, taken from the
 * files themselves: Claude's cwd follows `cd` (into a nested repository,
 * another worktree, an added directory), so it can't say which checkout a file
 * is in. Null when nothing needs a claim: no path, a file outside any
 * coordinated repository or inside `.git`, or one git ignores (each worktree
 * has its own copy, so it can never conflict).
 */
function editTarget(input: Record<string, any>, io: HookIO): { root: string; files: string[] } | null {
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const rawPaths = [toolInput.file_path, toolInput.notebook_path].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (rawPaths.length === 0) return null;
  const cwd = cwdFor(input, io);
  const abs = rawPaths.map((p) => path.resolve(cwd, p));
  const root = claimRoot(path.dirname(abs[0]), sessionDir(input, io));
  if (!root) return null;
  const keys = abs.flatMap((p) => {
    const key = toRepoPath(p, root, root);
    return key !== null && !isIgnored(p, root) ? [key] : [];
  });
  const files = [...new Set(keys)];
  return files.length ? { root, files } : null;
}

/**
 * Config for edits in the checkout at `root`. A checkout with no identity of
 * its own (a worktree Claude Code created under .claude/worktrees has no
 * .hub.json) takes the session's, from its project dir, else its cwd, when
 * that is in the same repository (see lendIdentity).
 */
function configFor(root: string, input: Record<string, any>, io: HookIO): HubConfig {
  return lendIdentity(loadConfig({ cwd: root, env: io.env }), io.env, [io.env.CLAUDE_PROJECT_DIR, cwdFor(input, io)]);
}

/** Which session, agent thread (main or a subagent) and tool call a hook event belongs to. */
function callIds(input: Record<string, any>): { session: string; thread: string; tool: string | null } | null {
  if (typeof input.session_id !== 'string' || !input.session_id) return null;
  return {
    session: input.session_id,
    thread: typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : 'main',
    tool: typeof input.tool_use_id === 'string' && input.tool_use_id ? input.tool_use_id : null,
  };
}

/**
 * `hub hook pre-edit` — PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit.
 *
 * Reads `tool_input.file_path` (or `notebook_path`), maps it to a path relative
 * to the repository the file is in, and asks the hub for a file-level claim
 * for this agent. Granted (new, renewed, or shared alongside other shared
 * holders): print nothing, exit 0. Denied: print a PreToolUse `deny` decision
 * naming the holder and intent. Only an unreachable (or broken, 5xx) hub lets
 * the edit through without a claim, with a warning the user and Claude see,
 * and not when HUB_FAIL_CLOSED is set. A refusal (4xx), an auth error
 * (401/403) or a broken config denies it. A claim this call creates is
 * pending until `hub hook post-edit` confirms the edit ran.
 *
 * Phase 2: first the edit/sync exclusion (an in-flight marker, then the sync
 * lock: an edit while a sync runs waits up to 3 s, then is denied with "retry
 * this edit"; an interrupted sync blocks edits until hub_sync recovers), and
 * on a newly granted claim the stale-base heads-up as additionalContext.
 *
 * Phase 3 (design §1.10, §2.3.6): an Edit or MultiEdit of an existing file in
 * a mapped language claims only the declarations it changes, found by
 * simulating the edit and diffing the two outlines, with the mapper version;
 * anything else claims the whole file. The file as it was is saved beside the
 * marker for post-edit. A denial names the symbols, what of the file is free,
 * and where a landing that holds them is.
 */
export async function preEditHook(io: HookIO): Promise<HookOutcome> {
  const input = parseInput(io.stdin);
  if (!input) return allowWithWarning('could not parse the hook input; edit not coordinated');
  const edited = editTarget(input, io);
  if (!edited) return ALLOW;
  // Edit/sync exclusion (design §2.3.5): this call's in-flight marker first, then the sync lock. The
  // marker stays until post-edit confirms the edit or settle ends the turn; a denied edit takes it away.
  const ids = callIds(input);
  const session = ids?.session ?? 'unknown';
  // An edit in another checkout (another worktree, a nested repository): settle, which looks in the session's own
  // checkouts, is told where its marker is, so it can clear it when the edit never ran (rejected at the prompt).
  const marks = syncPaths(edited.root);
  if (marks) for (const p of sessionSyncPaths(input, io)) if (p.dir !== marks.dir) noteMarkerElsewhere(p, session, marks.inflight);
  const gate = await enterEdit(edited.root, { session, thread: ids?.thread ?? 'main', tool: ids?.tool ?? null });
  if (!gate.ok) {
    return deny(
      gate.reason === 'syncing'
        ? 'The workspace is updating to the latest trunk; retry this edit.'
        : 'A workspace sync in this checkout was interrupted; call hub_sync to finish recovering, then retry this edit.',
    );
  }
  const out = await claimForEdit(input, io, edited);
  if (isDenial(out)) removeMarker(gate.marker);
  return out;
}

function isDenial(out: HookOutcome): boolean {
  try {
    return JSON.parse(out.stdout)?.hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

/** The pre-edit hook's claim, once the edit/sync gate let the call through. */
async function claimForEdit(input: Record<string, any>, io: HookIO, edited: { root: string; files: string[] }): Promise<HookOutcome> {
  // A name the hub refuses can't be claimed by anyone, so it can't conflict: leave it out, and say so.
  const refused = edited.files.flatMap((f) => {
    const why = unclaimableReason(f);
    return why ? [`${showNames([f])} (${why})`] : [];
  });
  const unclaimed = refused.length
    ? `the hub can't hold a claim on ${refused.join('; ')}, so no agent can claim ${refused.length === 1 ? 'that file' : 'those files'}; edit not coordinated for ${refused.length === 1 ? 'it' : 'them'}`
    : null;
  const target = { ...edited, files: edited.files.filter((f) => unclaimableReason(f) === null) };
  if (target.files.length === 0) return allowWithWarning(unclaimed!, 600);

  let cfg: HubConfig;
  try {
    cfg = configFor(target.root, input, io);
  } catch (err) {
    // A broken config is not a hub outage: nothing can say whether this edit is safe.
    return deny(`Edit blocked: agenthub configuration error (${inline((err as Error).message, 300)}). Ask your human to fix it.`);
  }
  if (!cfg.agent) {
    const why = 'no agent identity for this checkout (run `hub init --agent human/agent` in it, or set HUB_AGENT)';
    // Such as a .hub.json that git tracks, whose agent doesn't count.
    const also = cfg.warnings.map((w) => ` ${inline(w, 400)}`).join('');
    if (cfg.failClosed) return deny(`Edit blocked: ${why}. This project requires a hub claim before editing (HUB_FAIL_CLOSED).${also}`);
    return allowWithWarning(`${why}; edit not coordinated.${also}`, 300 + also.length);
  }

  // The guard in that checkout then acts as the same agent (see recordLending).
  if (cfg.lentBy) recordLending(target.root, cfg.lentBy, callIds(input)?.session ?? null);
  // Phase 3: the declarations the edit changes, or the whole file (design §1.10). Never fails an edit:
  // anything it can't map is the whole file.
  const symbols = teamSections(target.root, { strict: false }).sections.symbols;
  const abs = editedPath(input, io);
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const scope: EditScope | null =
    target.files.length === 1 && abs
      ? await editScope({ tool, input: (input.tool_input ?? {}) as Record<string, unknown>, abs, file: target.files[0], config: symbols }).catch(() => null)
      : null;
  const base_commit = headCommit(target.root) ?? undefined;
  try {
    let symbolic = scope?.symbols != null;
    let res: ClaimResult;
    try {
      res = await hookClient(cfg).claim(
        symbolic
          ? { scope: scope!.symbols!.map((symbol) => ({ file: target.files[0], symbol })), mapper: scope!.mapper!, mode: 'auto', queue: false, base_commit }
          : { files: target.files, mode: 'auto', queue: false, base_commit },
      );
    } catch (err) {
      // A hub that refuses a key this mapper produced (another version): the whole file is the safe side.
      if (!symbolic || !(err instanceof HubApiError) || err.code !== 'invalid_symbol') throw err;
      symbolic = false;
      res = await hookClient(cfg).claim({ files: target.files, mode: 'auto', queue: false, base_commit });
    }
    if (res.status === 'granted') {
      trackClaim(input, target.root, cfg, res);
      // For post-edit: the file as it was, and what the edit should leave, beside this call's marker (a whole-file
      // edit of a mapped file keeps only the file as it was, for the signature changes it makes).
      const ids = callIds(input);
      if (symbolic && scope && abs && ids?.tool) saveEditState(target.root, { session: ids.session, tool: ids.tool }, scope, abs);
      else if (!symbolic && abs && ids?.tool && target.files.length === 1 && ['Edit', 'MultiEdit', 'Write'].includes(tool)) {
        saveWholeEditState(target.root, { session: ids.session, tool: ids.tool }, { file: target.files[0], abs, config: symbols });
      }
      const notes: string[] = [];
      // On a new claim: has trunk changed the file since this worktree's base? (Said once per file and trunk tip.)
      const stale = res.renewed ? null : staleBaseNote(target.root, target.files, input, cfg);
      if (stale) notes.push(`agenthub: ${stale}`);
      // Phase 3: recent changes by others to names the edited declarations use (design §2.3.6 (5)).
      const impact = target.files.length === 1 && abs ? await editImpactContext(target.root, cfg, input, target.files[0], abs, symbolic ? scope : null, symbols).catch(() => null) : null;
      if (impact) notes.push(impact);
      if (unclaimed) {
        const out = allowWithWarning(unclaimed, 600);
        if (!notes.length) return out;
        const json = JSON.parse(out.stdout);
        json.hookSpecificOutput.additionalContext += `\n${notes.join('\n')}`;
        return { ...out, stdout: JSON.stringify(json) };
      }
      return notes.length ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join('\n') } }), stderr: '', exitCode: 0 } : ALLOW;
    }
    const first = res.conflicts[0];
    if (!first) return deny(`Edit blocked: the hub denied the claim on ${showNames(target.files)} without naming a conflict. Tell your human.`);
    // Every claim in the way of that file: with shared holders and an exclusive waiter, the waiter is why.
    const file = first.files[0] ?? target.files[0];
    const inTheWay = res.conflicts.filter((c) => c.files.includes(file) || c.files.length === 0);
    const shown = inTheWay.length ? inTheWay : [first];
    // Symbols on either side, or a landing's hold: say so in Phase 3's words. Otherwise Phase 1's.
    const ctx =
      symbolic || shown.some((c) => c.landing_id || c.scope?.some((e) => e.symbol !== undefined))
        ? await denyContext(cfg, file, shown, scope, symbolic, symbols)
        : undefined;
    return deny(denyReason(file, shown, res.now, res.deadlock, ctx));
  } catch (err) {
    const failure = classifyFailure(err, cfg);
    if (failure.kind !== 'unreachable') return deny(`Edit blocked: ${failureText(failure, cfg)}. Tell your human; edits stay blocked until the hub accepts the claim.`);
    if (cfg.failClosed) {
      return deny(`Edit blocked: ${inline(failure.message, 200)}. This project requires a hub claim before editing (HUB_FAIL_CLOSED).`);
    }
    return allowWithWarning(`${failure.message}; edit allowed without a claim`);
  }
}

/**
 * The pre-edit impact note (design §2.3.6 (5), §2.5): recent signature changes
 * by other agents, from a listing at most 60 s old, to names that the
 * declarations this edit changes use, in the file as the edit leaves it (the
 * whole file for an edit that isn't mapped). Each is said once per session,
 * and acknowledged ones not at all. Null when there is nothing to say.
 */
async function editImpactContext(root: string, cfg: HubConfig, input: Record<string, any>, file: string, abs: string, scope: EditScope | null, symbols: SymbolsConfig): Promise<string | null> {
  if (!cfg.agent || !symbols.enabled) return null;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  let text = scope?.after ?? null;
  if (text === null && input.tool_name === 'Write' && typeof toolInput.content === 'string') text = toolInput.content;
  if (text === null) {
    try {
      text = statSync(abs).size <= MAX_MAPPED_BYTES ? readFileSync(abs, 'utf8') : null;
    } catch {
      text = null;
    }
  }
  if (text === null) return null;
  const changes = await cachedChanges(root, new HubClient({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, IMPACT_BUDGET_MS) }));
  if (!changes?.some((c) => c.agent !== cfg.agent && isNews(c))) return null;
  const hits = await editImpacts({ file, text, keys: scope?.symbols ?? null, me: cfg.agent, changes, acks: readAcks(root, cfg.project) });
  if (!hits.length) return null;
  const fresh = firstTimeInSession(root, callIds(input)?.session ?? 'unknown', hits.map((h) => h.change));
  const told = hits.filter((h) => fresh.has(h.change.id));
  return told.length ? editImpactNote(file, told) : null;
}

/** The absolute path of the file an edit tool call writes (Edit, MultiEdit, Write, NotebookEdit). */
function editedPath(input: Record<string, any>, io: HookIO): string | null {
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const raw = [toolInput.file_path, toolInput.notebook_path].find((p): p is string => typeof p === 'string' && p.length > 0);
  return raw ? path.resolve(cwdFor(input, io), raw) : null;
}

/**
 * What a Phase 3 deny reason says beyond the hub's answer (design §2.3.6
 * (6)), all best effort: where each landing holding the file is, and which
 * top-level declarations of the file no other agent holds or waits for (only
 * for an edit mapped to declarations; others' symbols count only under this
 * mapper, design §1.10).
 */
async function denyContext(cfg: HubConfig, file: string, conflicts: ClaimConflict[], scope: EditScope | null, symbolic: boolean, symbols: SymbolsConfig): Promise<DenyContext> {
  const mapped = symbolic ? scope : null;
  const ctx: DenyContext = {
    wanted: mapped?.symbols ?? null,
    wholeReason: mapped ? null : (scope?.reason ?? null),
    wholeWhy: mapped ? null : wholeFileWhy(scope?.reason ?? null, symbols.maxSymbolsPerEdit),
  };
  const client = hookClient(cfg);
  const landings = new Map<string, Landing>();
  for (const id of [...new Set(conflicts.flatMap((c) => (c.landing_id ? [c.landing_id] : [])))].slice(0, 3)) {
    try {
      landings.set(id, await client.landing(id));
    } catch {
      // the place in the queue is a nicety
    }
  }
  ctx.landings = landings;
  if (mapped?.before != null && mapped.mapper) {
    try {
      const sym = await symbolsModule();
      const theirs = (await client.claims({ file })).filter((c) => c.holder !== cfg.agent && (c.status === 'active' || c.status === 'queued'));
      // A claim under another mapper (or none) counts as its whole file.
      const held = theirs.flatMap((c) => c.scope.filter((e) => e.file === file).map((e) => (c.mapper === mapped.mapper && e.symbol !== undefined ? { symbol: e.symbol } : {})));
      ctx.free = sym ? await sym.freeKeys(file, mapped.before, held) : null;
    } catch {
      ctx.free = null;
    }
  }
  return ctx;
}

/**
 * Remember a claim this tool call created, so it can be released if the edit
 * never runs (Claude Code asks for permission, applies deny rules and runs other
 * hooks only after PreToolUse). An earlier unconfirmed claim that this call
 * renewed (a failed edit, retried; a subagent's rejected edit the main thread
 * then makes) now stands or falls with this call.
 */
function trackClaim(input: Record<string, any>, root: string, cfg: HubConfig, res: ClaimResult): void {
  const ids = callIds(input);
  if (!ids?.tool) return;
  const call = { session: ids.session, thread: ids.thread, tool: ids.tool };
  try {
    const store = PendingClaims.open(root);
    if (!store) return;
    const created = res.renewed ? null : (res.claim ?? null);
    const renewed = (res.claims ?? []).map((c) => c.id).filter((id) => id !== created?.id);
    for (const e of store.find(renewed)) if (e.session !== call.session || e.tool !== call.tool) store.move(e, call);
    // Which claim this is, beyond its id: a hub back on a new database hands out the same ids again.
    if (created) store.add({ ...call, claim_id: created.id, root, url: cfg.url, project: cfg.project, created_at: created.created_at });
  } catch {
    // Bookkeeping only: never fail an edit over it.
  }
}

/**
 * The stale-base heads-up (design §2.3.6): files of a newly granted claim that
 * trunk changed since the worktree's merge base with it, as last fetched (no
 * network). Only with a landing queue, and unless sync.staleEdit is off.
 */
function staleBaseNote(root: string, files: string[], input: Record<string, any>, cfg: HubConfig): string | null {
  try {
    const team = teamSections(root, { strict: false });
    const land = team.sections.land;
    if (!land || team.sections.sync.staleEdit === 'off') return null;
    const stale = staleFiles(root, files, land, callIds(input)?.session ?? 'unknown', cfg.project);
    if (!stale.length) return null;
    return stale
      .map(
        (s) =>
          `${showName(s.file)} changed on ${land.trunk} since your checkout${s.landing ? ` (${s.landing}${s.agent ? ` by ${s.agent}` : ''})` : ''}; ` +
          `you're editing the older version, and your edit will be merged with it at landing. If your worktree is clean, hub_sync first.`,
      )
      .join(' ');
  } catch {
    return null; // a heads-up only
  }
}

/**
 * The sync files of the session's own checkouts, as settle finds them: those of
 * Claude Code's project dir and of the hook's cwd.
 */
function sessionSyncPaths(input: Record<string, any>, io: HookIO): SyncPaths[] {
  const out = new Map<string, SyncPaths>();
  for (const dir of [io.env.CLAUDE_PROJECT_DIR, cwdFor(input, io)]) {
    const root = dir ? claimRoot(dir, sessionDir(input, io)) : null;
    const p = root ? syncPaths(root) : null;
    if (p && !out.has(p.dir)) out.set(p.dir, p);
  }
  return [...out.values()];
}

/**
 * Release pending claims (their edits never ran) and forget them. Ones the hub
 * can't be reached for are kept for the next try, and so are those left when
 * `until` (the hook's deadline) comes.
 */
async function releasePending(store: PendingClaims, entries: StoredClaim[], input: Record<string, any>, io: HookIO, until?: number): Promise<void> {
  // null: a broken config or an unreachable hub, so the entries for that checkout wait.
  const configs = new Map<string, HubConfig | null>();
  for (const e of entries) {
    if (!configs.has(e.root)) {
      let cfg: HubConfig | null = null;
      try {
        cfg = configFor(e.root, input, io);
      } catch {
        // keep the entry until the config can be read
      }
      configs.set(e.root, cfg);
    }
    const cfg = configs.get(e.root);
    if (!cfg) continue;
    if (until !== undefined && until - Date.now() < MIN_REQUEST_MS) return;
    if (!cfg.agent) {
      store.remove(e);
      continue;
    }
    // An entry for another hub or project, or for a claim of that id the hub made since
    // (on a new database, ids start over), names nothing this agent should release.
    if ((e.url !== undefined && !sameHub(e.url, cfg.url)) || (e.project !== undefined && e.project !== cfg.project)) {
      store.remove(e);
      continue;
    }
    try {
      if (e.created_at !== undefined) {
        const c = await hookClient(cfg, until).getClaim(e.claim_id);
        if (c.created_at !== e.created_at || c.holder !== cfg.agent) {
          store.remove(e);
          continue;
        }
      }
      await hookClient(cfg, until).release({ claim_id: e.claim_id });
      store.remove(e);
    } catch (err) {
      // The hub answered (no such claim, held by someone else): nothing is left to release.
      if (classifyFailure(err, cfg).kind !== 'unreachable') store.remove(e);
      else configs.set(e.root, null);
    }
  }
}

/**
 * `hub hook post-edit` — PostToolUse hook for the same tools. Claude Code sends
 * it only after an edit ran, which confirms the claim pre-edit took for it.
 * Calls in one agent thread run one after another, so claims the thread took
 * earlier and never confirmed are for edits that didn't run (rejected at the
 * permission prompt, denied by a rule or another hook, or failed): release
 * them. Prints nothing.
 */
export async function postEditHook(io: HookIO): Promise<HookOutcome> {
  const input = parseInput(io.stdin);
  const ids = input && callIds(input);
  if (!input || !ids?.tool) return ALLOW;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const file = [toolInput.file_path, toolInput.notebook_path].find((p): p is string => typeof p === 'string' && p.length > 0);
  const root = file ? claimRoot(path.dirname(path.resolve(cwdFor(input, io), file)), sessionDir(input, io)) : null;
  // What pre-edit saved for a symbol-level edit; taken before the marker goes, which takes it along.
  const state = root ? takeEditState(root, { session: ids.session, tool: ids.tool }) : null;
  // The edit ran: its in-flight marker goes, so a sync may run again.
  const marks = root ? syncPaths(root) : null;
  if (marks) clearMarkers(marks, { session: ids.session, tool: ids.tool });
  const store = root ? PendingClaims.open(root) : null;
  if (store) {
    const thread = store.list(ids.session).filter((e) => e.thread === ids.thread);
    for (const e of thread) if (e.tool === ids.tool) store.remove(e);
    await releasePending(store, thread.filter((e) => e.tool !== ids.tool), input, io);
  }
  const verified = state && root && !state.whole ? await verifyEdit(state, root, input, io) : null;
  // Phase 3: the signature changes the edit made go to the hub, and the agent hears who uses them (design §2.3.6).
  const impact = state && root ? await announceSignatureChanges(state, root, input, io).catch(() => null) : null;
  const context = [verified, impact].filter(Boolean).join('\n');
  if (!context) return ALLOW;
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }), stderr: '', exitCode: 0 };
}

/**
 * Post-edit's Phase 3 step (design §2.3.6, §2.5): the in-progress signature
 * changes of the edit that ran (the simulated edit's when the tool wrote just
 * that, else recomputed from what it wrote), posted with POST /symbol-changes
 * (best effort, 2 s), then who uses each changed declaration in this checkout
 * and who holds those places (who_uses, 2 s). Posting here, after the edit
 * ran, means an edit rejected at the permission prompt leaves no phantom
 * change. Null when the edit changed no signature, or nothing uses what it
 * changed.
 */
async function announceSignatureChanges(state: EditState, root: string, input: Record<string, any>, io: HookIO): Promise<string | null> {
  let cfg: HubConfig;
  try {
    cfg = configFor(root, input, io);
  } catch {
    return null;
  }
  if (!cfg.agent) return null;
  const symbols = teamSections(root, { strict: false }).sections.symbols;
  if (!symbols.enabled) return null;
  let actual: string | null;
  try {
    actual = statSync(state.abs).size <= MAX_MAPPED_BYTES ? readFileSync(state.abs, 'utf8') : null;
  } catch {
    actual = null; // deleted: its signatures are the whole file's business
  }
  if (actual === null) return null;
  let sigs = !state.whole && state.sigs && sha256(actual) === state.after_sha256 ? state.sigs : null;
  if (sigs === null) {
    const sym = await symbolsModule();
    if (!sym) return null;
    const diff = await sym.changedSymbols(state.file, state.before, actual, { maxSymbols: 1_000_000, exclude: symbols.exclude }).catch(() => null);
    if (!diff || diff.fileLevel) return null;
    sigs = diff.signatureChanges;
  }
  const changes = sigs.filter((c) => isValidSymbolKey(c.symbol) && !c.symbol.startsWith('@') && (c.renamed_to === undefined || isValidSymbolKey(c.renamed_to)));
  if (!changes.length) return null;
  const client = new HubClient({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, IMPACT_BUDGET_MS) });
  let postError: string | null = null;
  try {
    await client.postSymbolChanges({
      changes: changes.map((c) => ({ file: state.file, symbol: c.symbol, kind: c.kind, before: c.before, after: c.after, ...(c.renamed_to ? { renamed_to: c.renamed_to } : {}) })),
    });
  } catch (err) {
    postError = classifyFailure(err, cfg).message;
  }
  // Who uses each changed declaration here, within the second 2 s; the hub's claims are read once.
  const uses = new Map<string, WhoUses | null>();
  const deadline = Date.now() + IMPACT_BUDGET_MS;
  let claims: Promise<Claim[]> | null = null;
  const claimsOnce = () => (claims ??= new HubClient({ ...cfg, timeoutMs: Math.max(1, deadline - Date.now()) }).claims());
  for (const c of changes.slice(0, 3)) {
    if (Date.now() >= deadline) {
      uses.set(c.symbol, null);
      continue;
    }
    uses.set(c.symbol, await whoUses(root, { file: state.file, symbol: c.symbol }, { me: cfg.agent, claims: claimsOnce, budgetMs: deadline - Date.now() }).catch(() => null));
  }
  return postEditImpactText(state.file, changes, uses, postError);
}

/**
 * Post-edit's check of a symbol-level edit (design §2.3.6, §4.2 #2): when the
 * file is not what pre-edit simulated (the tool normalized something), claim
 * what the edit really changed beyond pre-edit's claim. Null when nothing is
 * missing or it was granted; otherwise the PostToolUse context: whose code
 * the edit also changed, or that it couldn't be claimed.
 */
async function verifyEdit(state: EditState, root: string, input: Record<string, any>, io: HookIO): Promise<string | null> {
  let cfg: HubConfig;
  try {
    cfg = configFor(root, input, io);
  } catch {
    return null; // pre-edit said why
  }
  if (!cfg.agent) return null;
  const symbols = teamSections(root, { strict: false }).sections.symbols;
  const missing = await missingAfterEdit(state, symbols).catch(() => null);
  if (!missing) return null;
  const names = scopeNames(missing.entries);
  // What the tool wrote maps only to the whole file: say so, rather than that the edit changed others' declarations.
  const whole = missing.mapper === null ? wholeFileWhy(missing.reason, symbols.maxSymbolsPerEdit) : null;
  try {
    const res = await hookClient(cfg).claim({
      ...(missing.mapper ? { scope: missing.entries, mapper: missing.mapper } : { files: [state.file] }),
      mode: 'auto',
      queue: false,
      base_commit: headCommit(root) ?? undefined,
    });
    if (res.status === 'granted') return null;
    const inTheWay = res.conflicts.filter((c) => c.files.includes(state.file) || c.files.length === 0);
    if (!inTheWay.length) return `agenthub: your edit also changed ${names}, which the hub didn't grant you without naming a conflict; tell your human.`;
    return postEditConflictText(state.file, inTheWay, res.now, whole);
  } catch (err) {
    return `agenthub: your edit also changed ${names}, which isn't claimed: ${inline(classifyFailure(err, cfg).message, 300)}.`;
  }
}

/**
 * `hub hook settle` — Stop, SubagentStop, UserPromptSubmit and SessionEnd hook.
 * When a turn (or a subagent's) is over, no tool call of it is still waiting
 * for permission, so the thread's edit markers go, and its claims that no
 * PostToolUse confirmed are for edits that never ran: release them.
 * SessionEnd does it for the whole session. On UserPromptSubmit (a safe
 * point) it then syncs the workspace with trunk, and prints additionalContext
 * (which is added to the prompt) only when that changed the worktree, found a
 * conflict, found it behind with uncommitted changes, or found an interrupted
 * sync; otherwise it prints nothing.
 */
export async function settleHook(io: HookIO): Promise<HookOutcome> {
  const started = Date.now();
  const until = started + HOOK_DEADLINE_MS;
  const input = parseInput(io.stdin);
  const ids = input && callIds(input);
  if (!input || !ids) return ALLOW;
  const wholeSession = input.hook_event_name === 'SessionEnd';
  const prompt = input.hook_event_name === 'UserPromptSubmit';
  // First the in-flight markers of the thread's (or session's) edit calls: none of them is mid-edit now. Those in
  // other checkouts too (an edit of a file in another worktree), which the session's checkouts keep a note of.
  const match = wholeSession ? { session: ids.session } : { session: ids.session, thread: ids.thread };
  const own = sessionSyncPaths(input, io);
  const cleared = new Set(own.map((p) => p.inflight));
  for (const p of own) clearMarkers(p, match);
  for (const p of own) clearMarkersElsewhere(p, match, cleared);
  const roots = [io.env.CLAUDE_PROJECT_DIR, cwdFor(input, io)].map((dir) => (dir ? claimRoot(dir, sessionDir(input, io)) : null));
  const seen = new Set<string>();
  // On a prompt the sync comes after this, within the same 15 s: releasing gets a share of it.
  const releaseUntil = prompt ? Math.min(until, started + SETTLE_RELEASE_MS) : until;
  for (const root of roots) {
    const store = root ? PendingClaims.open(root) : null;
    if (!store || seen.has(store.dir)) continue;
    seen.add(store.dir);
    const entries = store.list(ids.session).filter((e) => wholeSession || e.thread === ids.thread);
    await releasePending(store, entries, input, io, releaseUntil);
  }
  // The safe point: a new prompt, so no tool call of the session can be mid-edit. Never on Stop or
  // SubagentStop. The one time settle prints: the agent must know when its files changed under it.
  if (!prompt) return ALLOW;
  const synced = await safePointSync(input, io, 'prompt', Math.min(HOOK_SYNC_BUDGET_MS, until - Date.now()));
  const text = synced && syncPromptText(synced.result);
  if (!synced || !text || !freshNotice(synced.root, synced.result)) return ALLOW;
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }), stderr: '', exitCode: 0 };
}

/**
 * The automatic sync at a safe point (SessionStart, UserPromptSubmit) of the
 * session's own checkout: only with a landing queue and sync.auto on, within
 * `budgetMs` (at most HOOK_SYNC_BUDGET_MS; it stops before changing anything
 * once that is spent). Null when it didn't run; a sync that fails stays quiet
 * (nothing changed).
 */
async function safePointSync(
  input: Record<string, any>,
  io: HookIO,
  reason: 'prompt' | 'session_start',
  budgetMs: number,
  loaded?: HubConfig,
): Promise<{ root: string; result: SyncResult } | null> {
  const dir = sessionDir(input, io);
  const root = loaded?.root ?? claimRoot(dir, dir);
  if (!root) return null;
  let cfg: HubConfig;
  try {
    cfg = loaded ?? configFor(root, input, io);
  } catch {
    return null;
  }
  if (!cfg.agent) return null;
  const team = teamSections(root, { strict: false });
  if (!team.sections.land || !team.sections.sync.auto) return null;
  try {
    return { root, result: await syncWorkspace(root, cfg, hookClient(cfg), { reason, budgetMs: Math.max(0, Math.min(HOOK_SYNC_BUDGET_MS, budgetMs)) }) };
  } catch {
    return null;
  }
}

/** Whether this sync outcome says something settle hasn't said for this worktree yet (an unchanged state isn't repeated at every prompt). */
function freshNotice(root: string, r: SyncResult): boolean {
  const p = syncPaths(root);
  if (!p) return true;
  const key = syncNoticeKey(r);
  try {
    if (readFileSync(p.said, 'utf8') === key) return false;
  } catch {
    // nothing said yet
  }
  try {
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.said, key);
  } catch {
    // then it may be said again
  }
  return true;
}

/**
 * `hub hook digest` — SessionStart hook. Syncs the workspace with trunk (a
 * safe point), marks the agent present and returns
 * a short team summary as `additionalContext`: active claims by others,
 * recent decisions, open tasks and the unread count (never message bodies).
 * Configuration warnings (HUB_AGENT overriding this checkout's identity, a
 * token withheld from the hub, a .hub.json in git) go to the user as well,
 * also when the hub fails or there is no identity.
 */
export async function digestHook(io: HookIO): Promise<HookOutcome> {
  const until = Date.now() + HOOK_DEADLINE_MS;
  const input = parseInput(io.stdin) ?? {};
  const context = (text: string): HookOutcome => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
    stderr: '',
    exitCode: 0,
  });
  // A problem goes to the user as well (systemMessage), not only into Claude's context.
  const problem = (text: string): HookOutcome => ({
    stdout: JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
    stderr: '',
    exitCode: 0,
  });

  let cfg: HubConfig;
  try {
    cfg = loadConfig({ cwd: cwdFor(input, io), env: io.env });
  } catch (err) {
    return problem(`agenthub: configuration error (${inline((err as Error).message, 200)}). Edits in this checkout are blocked until it is fixed.`);
  }
  const warningOf = (ws: string[]) => ws.map((w) => `agenthub: ${inline(w, 400)}`).join('\n');
  // A commit guard a hook manager took out (husky rewrites .husky/_ on install) goes unnoticed otherwise.
  const guardOff = cfg.root && hasOwnSettings(cfg.root) ? commitGuardOff(cfg.root) : null;
  if (guardOff) cfg.warnings.push(guardOff);
  // The land, sync and symbols sections, read leniently: a bad value is a warning here (its default
  // applies), never a blocked edit. The lander and `land` read them strictly and refuse instead.
  const team = cfg.root ? teamSections(cfg.root, { strict: false }) : null;
  if (team?.problems.length) cfg.warnings.push(...team.problems.map((p) => `${p} (the default applies here; the lander and land refuse it until it is fixed)`));
  const warning = warningOf(cfg.warnings);
  const also = warning ? `\n${warning}` : '';
  if (!cfg.agent) {
    return problem(
      `agenthub: this checkout has no agent identity, so your edits are not coordinated with the team. Ask your human to run \`hub init --agent <human>/<agent>\` here.${also}`,
    );
  }
  // The safe-point sync comes first, so the digest describes the worktree as it is now. The hub requests after it
  // keep DIGEST_RESERVE_MS of the hook's 15 s, and each is done by the deadline.
  const synced = await safePointSync(input, io, 'session_start', until - Date.now() - DIGEST_RESERVE_MS, cfg);
  const trunkLine = synced ? syncDigestLine(synced.result) : null;
  if (synced && trunkLine) freshNotice(synced.root, synced.result); // the first prompt needn't say it again
  // Said also when the hub can't give the digest: the worktree changed (or needs the agent) all the same.
  const trunkAlso = trunkLine ? `\n${trunkLine}` : '';
  try {
    await hookClient(cfg, until).heartbeat({ client: 'claude-code', branch: cfg.root ? (currentBranch(cfg.root) ?? undefined) : undefined, worktree: cfg.root ?? undefined });
    const status = await hookClient(cfg, until).status();
    // The queue's median land→trunk time, when there is a queue to speak of.
    const stats = status.lander && (status.queue?.length ?? 0) > 0 && until - Date.now() >= MIN_REQUEST_MS ? await hookClient(cfg, until).landingStats().catch(() => null) : null;
    // Phase 3: recent changes by others to what this agent's claims use (design §2.5), within what is left.
    const impacts = cfg.root && team?.sections.symbols.enabled ? await digestImpacts(cfg, cfg.root, status, until).catch(() => null) : null;
    const text = digestText(status, cfg.agent, cfg.url, { stats, trunk: team?.sections.land?.trunk, trunkLine, impacts });
    if (!warning) return context(text);
    return {
      stdout: JSON.stringify({ systemMessage: warning, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${warning}\n\n${text}` } }),
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const failure = classifyFailure(err, cfg);
    if (failure.kind !== 'unreachable') {
      // An auth error's message already says why the token was withheld.
      const rest = warningOf(cfg.warnings.filter((w) => failure.kind !== 'auth' || w !== cfg.tokenWithheld));
      return problem(`agenthub: ${failureText(failure, cfg)}. Edits in this checkout are blocked until this is fixed; tell your human.${rest ? `\n${rest}` : ''}${trunkAlso}`);
    }
    const mode = cfg.failClosed ? 'Edits will be blocked until it is back.' : 'Edits are not being coordinated until it is back.';
    return problem(`agenthub: the team hub is unavailable (${inline(failure.message, 200)}). ${mode}${also}${trunkAlso}`);
  }
}

/** `p`, or null once `ms` has passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * The digest's impacts (design §2.3.4, §2.5): the recent changes by others
 * that this agent's live claims use, unacknowledged first, by the hook's
 * deadline. Null when there are none, or no time.
 */
async function digestImpacts(cfg: HubConfig, root: string, status: StatusResult, until: number): Promise<DigestExtras['impacts']> {
  const me = cfg.agent!;
  const mine = status.claims.filter((c) => c.holder === me && !isLanderLease(c));
  if (!mine.length || until - Date.now() < MIN_REQUEST_MS) return null;
  const listing = await hookClient(cfg, until).symbolChanges();
  if (!listing.changes.some((c) => c.agent !== me && isNews(c))) return null;
  const items = await within(relevantAll(listing.changes, me, { root, claims: mine }), until - Date.now());
  if (!items?.length) return null;
  const acks = readAcks(root, cfg.project);
  return { items: sortImpacts(items, acks), acks, now: listing.now };
}
