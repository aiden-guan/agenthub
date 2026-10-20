import { HubApiError, HubClient } from './client.js';
import { loadConfig, type HubConfig } from './config.js';
import { denyReason, digestText, inline } from './format.js';
import { currentBranch, headCommit, toRepoPath } from './git.js';

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
const allowWithWarning = (msg: string): HookOutcome => ({ stdout: '', stderr: `hub: ${msg}\n`, exitCode: 0 });

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

function configFor(input: Record<string, any>, io: HookIO): HubConfig {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : io.cwd;
  return loadConfig({ cwd, env: io.env });
}

/**
 * `hub hook pre-edit` — PreToolUse hook for Edit|Write|MultiEdit.
 *
 * Reads `tool_input.file_path` (or `notebook_path`), maps it to a repo-relative
 * path and asks the hub for a file-level claim for this agent. Granted (new,
 * renewed, or shared alongside other shared holders): print nothing, exit 0.
 * Denied: print a PreToolUse `deny` decision naming the holder and intent.
 * If the hub is unreachable the edit is allowed with a warning on stderr,
 * unless HUB_FAIL_CLOSED is set.
 */
export async function preEditHook(io: HookIO): Promise<HookOutcome> {
  const input = parseInput(io.stdin);
  if (!input) return allowWithWarning('could not parse the hook input; edit not coordinated');
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const rawPaths = [toolInput.file_path, toolInput.notebook_path].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (rawPaths.length === 0) return ALLOW;

  let cfg: HubConfig;
  try {
    cfg = configFor(input, io);
  } catch (err) {
    return allowWithWarning((err as Error).message);
  }
  if (!cfg.agent) return allowWithWarning('no agent identity (set HUB_AGENT or run `hub init --agent human/agent`); edit not coordinated');
  if (!cfg.root) return ALLOW;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : io.cwd;
  const files = [...new Set(rawPaths.map((p) => toRepoPath(p, cfg.root!, cwd)).filter((p): p is string => p !== null))];
  if (files.length === 0) return ALLOW; // outside the repository

  try {
    const res = await new HubClient(cfg).claim({ files, mode: 'auto', queue: false, base_commit: headCommit(cfg.root) ?? undefined });
    if (res.status === 'granted') return ALLOW;
    const conflict = res.conflicts[0];
    return { stdout: denyJson(denyReason(conflict.files[0] ?? files[0], conflict, res.now)), stderr: '', exitCode: 0 };
  } catch (err) {
    const msg = err instanceof HubApiError ? `hub refused the claim: ${err.message}` : (err as Error).message;
    if (cfg.failClosed) {
      return {
        stdout: denyJson(`Edit blocked: ${inline(msg, 200)}. This project requires a hub claim before editing (HUB_FAIL_CLOSED). Try again shortly or tell your human.`),
        stderr: '',
        exitCode: 0,
      };
    }
    return allowWithWarning(`${msg}; edit allowed without a claim`);
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

  let cfg: HubConfig;
  try {
    cfg = configFor(input, io);
  } catch (err) {
    return context(`agenthub: configuration error (${inline((err as Error).message, 200)}); edits in this checkout are not coordinated with the team.`);
  }
  if (!cfg.agent) {
    return context(
      'agenthub: this checkout has no agent identity, so your edits are not coordinated with the team. Ask your human to run `hub init --agent <human>/<agent>` here.',
    );
  }
  const client = new HubClient(cfg);
  try {
    await client.heartbeat({ client: 'claude-code', branch: cfg.root ? (currentBranch(cfg.root) ?? undefined) : undefined, worktree: cfg.root ?? undefined });
    const status = await client.status();
    return context(digestText(status, cfg.agent, cfg.url));
  } catch (err) {
    const mode = cfg.failClosed ? 'Edits will be blocked until it is back.' : 'Edits are not being coordinated until it is back.';
    return context(`agenthub: the team hub is unavailable (${inline((err as Error).message, 200)}). ${mode}`);
  }
}
