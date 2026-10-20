import { HubClient, classifyFailure } from './client.js';
import { loadConfig, type HubConfig } from './config.js';
import { denyReason, digestText, inline } from './format.js';
import { currentBranch, findRepoRoot, headCommit, toRepoPath } from './git.js';

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
function allowWithWarning(msg: string): HookOutcome {
  const text = `agenthub: ${inline(msg, 300)}`;
  return {
    stdout: JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }),
    stderr: `hub: ${msg}\n`,
    exitCode: 0,
  };
}

const deny = (reason: string): HookOutcome => ({ stdout: denyJson(reason), stderr: '', exitCode: 0 });

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

/**
 * `hub hook pre-edit` — PreToolUse hook for Edit|Write|MultiEdit.
 *
 * Reads `tool_input.file_path` (or `notebook_path`), maps it to a repo-relative
 * path and asks the hub for a file-level claim for this agent. Granted (new,
 * renewed, or shared alongside other shared holders): print nothing, exit 0.
 * Denied: print a PreToolUse `deny` decision naming the holder and intent.
 * Only an unreachable (or broken, 5xx) hub lets the edit through without a
 * claim, with a warning the user and Claude see, and not when HUB_FAIL_CLOSED
 * is set. A refusal (4xx), an auth error (401/403) or a broken config denies it.
 */
export async function preEditHook(io: HookIO): Promise<HookOutcome> {
  const input = parseInput(io.stdin);
  if (!input) return allowWithWarning('could not parse the hook input; edit not coordinated');
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const rawPaths = [toolInput.file_path, toolInput.notebook_path].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (rawPaths.length === 0) return ALLOW;
  const cwd = cwdFor(input, io);
  const root = findRepoRoot(cwd);
  if (!root) return ALLOW;
  const files = [...new Set(rawPaths.map((p) => toRepoPath(p, root, cwd)).filter((p): p is string => p !== null))];
  if (files.length === 0) return ALLOW; // outside the repository

  let cfg: HubConfig;
  try {
    cfg = loadConfig({ cwd, env: io.env });
  } catch (err) {
    // A broken config is not a hub outage: nothing can say whether this edit is safe.
    return deny(`Edit blocked: agenthub configuration error (${inline((err as Error).message, 300)}). Ask your human to fix it.`);
  }
  if (!cfg.agent) return allowWithWarning('no agent identity (set HUB_AGENT or run `hub init --agent human/agent`); edit not coordinated');

  try {
    const res = await hookClient(cfg).claim({ files, mode: 'auto', queue: false, base_commit: headCommit(root) ?? undefined });
    if (res.status === 'granted') return ALLOW;
    const conflict = res.conflicts[0];
    return deny(denyReason(conflict.files[0] ?? files[0], conflict, res.now));
  } catch (err) {
    const failure = classifyFailure(err, cfg.url);
    if (failure.kind !== 'unreachable') return deny(`Edit blocked: ${inline(failure.message, 300)}. Tell your human; edits stay blocked until the hub accepts the claim.`);
    if (cfg.failClosed) {
      return deny(`Edit blocked: ${inline(failure.message, 200)}. This project requires a hub claim before editing (HUB_FAIL_CLOSED). Try again shortly or tell your human.`);
    }
    return allowWithWarning(`${failure.message}; edit allowed without a claim`);
  }
}

/**
 * `hub hook digest` — SessionStart hook. Marks the agent present and returns
 * a short team summary as `additionalContext`: active claims by others,
 * recent decisions, open tasks and the unread count (never message bodies).
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
  if (!cfg.agent) {
    return problem(
      'agenthub: this checkout has no agent identity, so your edits are not coordinated with the team. Ask your human to run `hub init --agent <human>/<agent>` here.',
    );
  }
  const client = hookClient(cfg);
  try {
    await client.heartbeat({ client: 'claude-code', branch: cfg.root ? (currentBranch(cfg.root) ?? undefined) : undefined, worktree: cfg.root ?? undefined });
    const status = await client.status();
    return context(digestText(status, cfg.agent, cfg.url));
  } catch (err) {
    const failure = classifyFailure(err, cfg.url);
    if (failure.kind !== 'unreachable') {
      return problem(`agenthub: ${inline(failure.message, 300)}. Edits in this checkout are blocked until this is fixed; tell your human.`);
    }
    const mode = cfg.failClosed ? 'Edits will be blocked until it is back.' : 'Edits are not being coordinated until it is back.';
    return problem(`agenthub: the team hub is unavailable (${inline(failure.message, 200)}). ${mode}`);
  }
}
