import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaimResult } from '@agenthub/hub/protocol';
import { claimRoot, lendIdentity, recordLending } from './checkout.js';
import { HubClient, classifyFailure, type HubFailure } from './client.js';
import { hasOwnSettings, loadConfig, sameHub, teamSections, type HubConfig } from './config.js';
import { denyReason, digestText, inline, showName, showNames, syncDigestLine, syncNoticeKey, syncPromptText } from './format.js';
import { currentBranch, headCommit, isIgnored, toRepoPath, unclaimableReason } from './git.js';
import { commitGuardOff } from './guard-status.js';
import { PendingClaims, type StoredClaim } from './pending.js';
import { HOOK_SYNC_BUDGET_MS, clearMarkers, enterEdit, removeMarker, staleFiles, syncPaths, syncWorkspace, type SyncResult } from './sync.js';

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

function hookClient(cfg: HubConfig): HubClient {
  return new HubClient({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, HOOK_REQUEST_TIMEOUT_MS) });
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
 */
export async function preEditHook(io: HookIO): Promise<HookOutcome> {
  const input = parseInput(io.stdin);
  if (!input) return allowWithWarning('could not parse the hook input; edit not coordinated');
  const edited = editTarget(input, io);
  if (!edited) return ALLOW;
  // Edit/sync exclusion (design §2.3.5): this call's in-flight marker first, then the sync lock. The
  // marker stays until post-edit confirms the edit or settle ends the turn; a denied edit takes it away.
  const ids = callIds(input);
  const gate = await enterEdit(edited.root, { session: ids?.session ?? 'unknown', thread: ids?.thread ?? 'main', tool: ids?.tool ?? null });
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
  try {
    const res = await hookClient(cfg).claim({ files: target.files, mode: 'auto', queue: false, base_commit: headCommit(target.root) ?? undefined });
    if (res.status === 'granted') {
      trackClaim(input, target.root, cfg, res);
      // On a new claim: has trunk changed the file since this worktree's base? (Said once per file and trunk tip.)
      const stale = res.renewed ? null : staleBaseNote(target.root, target.files, input, cfg);
      if (unclaimed) {
        const out = allowWithWarning(unclaimed, 600);
        if (!stale) return out;
        const json = JSON.parse(out.stdout);
        json.hookSpecificOutput.additionalContext += `\nagenthub: ${stale}`;
        return { ...out, stdout: JSON.stringify(json) };
      }
      return stale ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `agenthub: ${stale}` } }), stderr: '', exitCode: 0 } : ALLOW;
    }
    const first = res.conflicts[0];
    if (!first) return deny(`Edit blocked: the hub denied the claim on ${showNames(target.files)} without naming a conflict. Tell your human.`);
    // Every claim in the way of that file: with shared holders and an exclusive waiter, the waiter is why.
    const file = first.files[0] ?? target.files[0];
    const inTheWay = res.conflicts.filter((c) => c.files.includes(file) || c.files.length === 0);
    return deny(denyReason(file, inTheWay.length ? inTheWay : [first], res.now, res.deadlock));
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

/** Release pending claims (their edits never ran) and forget them. Ones the hub can't be reached for are kept for the next try. */
async function releasePending(store: PendingClaims, entries: StoredClaim[], input: Record<string, any>, io: HookIO): Promise<void> {
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
      const client = hookClient(cfg);
      if (e.created_at !== undefined) {
        const c = await client.getClaim(e.claim_id);
        if (c.created_at !== e.created_at || c.holder !== cfg.agent) {
          store.remove(e);
          continue;
        }
      }
      await client.release({ claim_id: e.claim_id });
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
  // The edit ran: its in-flight marker goes, so a sync may run again.
  const marks = root ? syncPaths(root) : null;
  if (marks) clearMarkers(marks, { session: ids.session, tool: ids.tool });
  const store = root ? PendingClaims.open(root) : null;
  if (!store) return ALLOW;
  const thread = store.list(ids.session).filter((e) => e.thread === ids.thread);
  for (const e of thread) if (e.tool === ids.tool) store.remove(e);
  await releasePending(store, thread.filter((e) => e.tool !== ids.tool), input, io);
  return ALLOW;
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
  const input = parseInput(io.stdin);
  const ids = input && callIds(input);
  if (!input || !ids) return ALLOW;
  const wholeSession = input.hook_event_name === 'SessionEnd';
  // First the in-flight markers of the thread's (or session's) edit calls: none of them is mid-edit now.
  const roots = [io.env.CLAUDE_PROJECT_DIR, cwdFor(input, io)].map((dir) => (dir ? claimRoot(dir, sessionDir(input, io)) : null));
  const marked = new Set<string>();
  for (const root of roots) {
    const p = root ? syncPaths(root) : null;
    if (!p || marked.has(p.dir)) continue;
    marked.add(p.dir);
    clearMarkers(p, wholeSession ? { session: ids.session } : { session: ids.session, thread: ids.thread });
  }
  const seen = new Set<string>();
  for (const root of roots) {
    const store = root ? PendingClaims.open(root) : null;
    if (!store || seen.has(store.dir)) continue;
    seen.add(store.dir);
    const entries = store.list(ids.session).filter((e) => wholeSession || e.thread === ids.thread);
    await releasePending(store, entries, input, io);
  }
  // The safe point: a new prompt, so no tool call of the session can be mid-edit. Never on Stop or
  // SubagentStop. The one time settle prints: the agent must know when its files changed under it.
  if (input.hook_event_name !== 'UserPromptSubmit') return ALLOW;
  const synced = await safePointSync(input, io, 'prompt');
  const text = synced && syncPromptText(synced.result);
  if (!synced || !text || !freshNotice(synced.root, synced.result)) return ALLOW;
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }), stderr: '', exitCode: 0 };
}

/**
 * The automatic sync at a safe point (SessionStart, UserPromptSubmit) of the
 * session's own checkout: only with a landing queue and sync.auto on, within
 * HOOK_SYNC_BUDGET_MS (it stops before changing anything once that is spent).
 * Null when it didn't run; a sync that fails stays quiet (nothing changed).
 */
async function safePointSync(input: Record<string, any>, io: HookIO, reason: 'prompt' | 'session_start', loaded?: HubConfig): Promise<{ root: string; result: SyncResult } | null> {
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
    return { root, result: await syncWorkspace(root, cfg, hookClient(cfg), { reason, budgetMs: HOOK_SYNC_BUDGET_MS }) };
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
  const client = hookClient(cfg);
  // The safe-point sync comes first, so the digest describes the worktree as it is now.
  const synced = await safePointSync(input, io, 'session_start', cfg);
  const trunkLine = synced ? syncDigestLine(synced.result) : null;
  if (synced && trunkLine) freshNotice(synced.root, synced.result); // the first prompt needn't say it again
  try {
    await client.heartbeat({ client: 'claude-code', branch: cfg.root ? (currentBranch(cfg.root) ?? undefined) : undefined, worktree: cfg.root ?? undefined });
    const status = await client.status();
    // The queue's median land→trunk time, when there is a queue to speak of.
    const stats = status.lander && (status.queue?.length ?? 0) > 0 ? await client.landingStats().catch(() => null) : null;
    const text = digestText(status, cfg.agent, cfg.url, { stats, trunk: team?.sections.land?.trunk, trunkLine });
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
      return problem(`agenthub: ${failureText(failure, cfg)}. Edits in this checkout are blocked until this is fixed; tell your human.${rest ? `\n${rest}` : ''}`);
    }
    const mode = cfg.failClosed ? 'Edits will be blocked until it is back.' : 'Edits are not being coordinated until it is back.';
    return problem(`agenthub: the team hub is unavailable (${inline(failure.message, 200)}). ${mode}${also}`);
  }
}
