import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_ID_RE, CONFIG_FILE_NAME, TEAM_CONFIG_FILE_NAME, readConfigFile, type ConfigFile } from './config.js';
import { deriveProject, git } from './git.js';

export interface InitOptions {
  cwd: string;
  agent?: string;
  project?: string;
  url?: string;
  /** How hooks invoke the CLI. Default `hub` (must be on PATH). */
  command?: string;
  hooks?: boolean;
  mcp?: boolean;
  guard?: boolean;
}

export const PRE_EDIT_MATCHER = 'Edit|Write|MultiEdit';
const GUARD_MARKER = '# agenthub-guard';
const CHAINED_HOOK = 'pre-commit.pre-agenthub';

/**
 * `hub init` — set up the current worktree:
 *  - `agenthub.json` (commit it) with the project id and hub URL, so every clone and worktree agrees
 *  - `.hub.json` with this worktree's agent identity (kept out of git via info/exclude)
 *  - `.claude/settings.json` PreToolUse (Edit|Write|MultiEdit → `hub hook pre-edit`)
 *    and SessionStart (`hub hook digest`) hook entries, merged into what's there
 *  - `.mcp.json` entry for the `hub mcp` server
 *  - the git pre-commit guard (an existing pre-commit hook is kept and chained)
 * Safe to run again; it only adds what's missing.
 */
export function init(opts: InitOptions): string[] {
  const root = git(opts.cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('hub init must run inside a git repository');
  const command = opts.command?.trim() || 'hub';
  const report: string[] = [];

  if (opts.agent && !AGENT_ID_RE.test(opts.agent)) throw new Error(`agent id "${opts.agent}" is invalid; use human/agent, e.g. maya/claude-2`);

  // 1. team config, committed: project id and hub URL
  const teamPath = path.join(root, TEAM_CONFIG_FILE_NAME);
  const teamExisting = readConfigFile(teamPath);
  if (!teamExisting || opts.project || opts.url) {
    const team: ConfigFile = { ...teamExisting };
    team.project = opts.project ?? team.project ?? deriveProject(root) ?? 'default';
    if (opts.url) team.url = opts.url.replace(/\/+$/, '');
    if (JSON.stringify(team) !== JSON.stringify(teamExisting)) {
      writeJson(teamPath, team);
      report.push(`wrote ${TEAM_CONFIG_FILE_NAME} (project ${team.project}${team.url ? `, hub ${team.url}` : ''}); commit it so every clone and worktree agrees`);
    }
  }

  // 2. this worktree's identity, never committed
  const localPath = path.join(root, CONFIG_FILE_NAME);
  const local: ConfigFile = readConfigFile(localPath) ?? {};
  if (opts.agent && local.agent !== opts.agent) {
    writeJson(localPath, { ...local, agent: opts.agent });
    report.push(`wrote ${CONFIG_FILE_NAME} (agent ${opts.agent})`);
  }
  if (excludeFromGit(root, `/${CONFIG_FILE_NAME}`)) report.push(`added /${CONFIG_FILE_NAME} to .git/info/exclude`);
  const notes = opts.agent || local.agent ? [] : ['note: no agent identity yet; run `hub init --agent <human>/<agent>` in each worktree (or set HUB_AGENT)'];

  // 3. Claude Code hooks
  if (opts.hooks !== false) {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    const hooks = (settings.hooks ??= {});
    let changed = addHook(hooks, 'PreToolUse', PRE_EDIT_MATCHER, `${command} hook pre-edit`);
    changed = addHook(hooks, 'SessionStart', undefined, `${command} hook digest`) || changed;
    if (opts.mcp !== false) {
      const enabled: string[] = (settings.enabledMcpjsonServers ??= []);
      if (!enabled.includes('hub')) {
        enabled.push('hub');
        changed = true;
      }
    }
    if (changed) {
      writeJson(settingsPath, settings);
      report.push('updated .claude/settings.json (PreToolUse pre-edit hook, SessionStart digest hook)');
    }
  }

  // 4. MCP server registration
  if (opts.mcp !== false) {
    const mcpPath = path.join(root, '.mcp.json');
    const mcp = readJson(mcpPath);
    const servers = (mcp.mcpServers ??= {});
    const [bin, ...args] = splitCommand(command);
    const entry = { command: bin, args: [...args, 'mcp'] };
    if (JSON.stringify(servers.hub) !== JSON.stringify(entry)) {
      servers.hub = entry;
      writeJson(mcpPath, mcp);
      report.push('updated .mcp.json (hub MCP server)');
    }
  }

  // 5. git pre-commit guard
  if (opts.guard !== false) {
    const hooksDir = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    if (!hooksDir) throw new Error('could not locate the git hooks directory');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-commit');
    const script = guardScript(command);
    const current = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;
    if (current !== script) {
      if (current !== null && !current.includes(GUARD_MARKER)) {
        const chained = path.join(hooksDir, CHAINED_HOOK);
        if (existsSync(chained)) throw new Error(`${hookPath} exists and ${chained} too; merge them by hand`);
        renameSync(hookPath, chained);
        report.push(`kept your existing pre-commit hook as ${CHAINED_HOOK} (runs after the guard)`);
      }
      writeFileSync(hookPath, script);
      chmodSync(hookPath, 0o755);
      report.push(`installed pre-commit guard at ${hookPath}`);
    }
  }

  return [...(report.length ? report : ['already set up; nothing to change']), ...notes];
}

export function guardScript(command: string): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
# Rejects commits that touch files another agent holds an exclusive claim on.
# Bypass in an emergency: git commit --no-verify   or   HUB_GUARD=off git commit
${command} guard
status=$?
if [ "$status" -eq 127 ]; then
  echo "agenthub: '${command.replace(/["'`$\\]/g, '')}' not found on PATH; claim guard skipped" >&2
  status=0
fi
[ "$status" -ne 0 ] && exit "$status"
chained="$(dirname "$0")/${CHAINED_HOOK}"
if [ -x "$chained" ]; then
  exec "$chained" "$@"
fi
exit 0
`;
}

type HookGroup = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

function addHook(hooks: Record<string, HookGroup[]>, event: string, matcher: string | undefined, command: string): boolean {
  const groups = (hooks[event] ??= []);
  if (groups.some((g) => g.hooks?.some((h) => h.command === command))) return false;
  const group: HookGroup = { hooks: [{ type: 'command', command, timeout: 30 }] };
  if (matcher) group.matcher = matcher;
  groups.push(group);
  return true;
}

function excludeFromGit(root: string, pattern: string): boolean {
  const file = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (!file) return false;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === pattern)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return true;
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it and run hub init again`);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Minimal shell-words split (handles single and double quotes) for the .mcp.json entry. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
