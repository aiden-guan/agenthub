import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_ID_RE,
  CONFIG_FILE_NAME,
  TEAM_CONFIG_FILE_NAME,
  loadConfig,
  otherRepositoryHub,
  readConfigFile,
  siblingTeamConfigs,
  upstreamTeamConfig,
  type ConfigFile,
} from './config.js';
import { deriveProject, git, recordedSettings } from './git.js';

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
  /** For the HUB_AGENT check; default process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Claude Code reads a matcher of plain names as an exact list of tool names, so
 * every tool that writes files must be on it. MultiEdit is gone from current
 * Claude Code; it stays for older versions.
 */
export const PRE_EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Events after which no tool call of the turn (or session) is still waiting: `hub hook settle` runs there. */
const SETTLE_EVENTS = ['Stop', 'SubagentStop', 'UserPromptSubmit', 'SessionEnd'];
const GUARD_MARKER = '# agenthub-guard';
const CHAINED_SUFFIX = '.pre-agenthub';
/** In the worktree's git dir: the pid of the `git commit` whose pre-commit ran the guard, so its prepare-commit-msg doesn't ask again. */
const CHECKED_FILE = 'agenthub-pre-commit';

/**
 * `hub init` — set up the current worktree:
 *  - `agenthub.json` (commit it) with the project id and hub URL, so every clone and worktree agrees
 *  - `.hub.json` with this worktree's agent identity (kept out of git via info/exclude)
 *  - `.claude/settings.json` hook entries, merged into what's there: PreToolUse
 *    (Edit|Write|MultiEdit|NotebookEdit → `hub hook pre-edit`), PostToolUse
 *    (`hub hook post-edit`), SessionStart (`hub hook digest`), and Stop,
 *    SubagentStop, UserPromptSubmit and SessionEnd (`hub hook settle`)
 *  - `.mcp.json` entry for the `hub mcp` server
 *  - the git guard, as pre-commit, as prepare-commit-msg (for the commits git
 *    revert, cherry-pick and rebase make without pre-commit) and as
 *    pre-applypatch (git am, git rebase --apply); existing hooks are kept and chained
 *  - the project id and hub URL in the repository's git config, which every
 *    worktree shares, for checkouts whose branch has no agenthub.json yet
 * Safe to run again; it only adds what's missing.
 */
export function init(opts: InitOptions): string[] {
  const root = git(opts.cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('hub init must run inside a git repository');
  const command = opts.command?.trim() || 'hub';
  const report: string[] = [];

  if (opts.agent && !AGENT_ID_RE.test(opts.agent)) throw new Error(`agent id "${opts.agent}" is invalid; use human/agent, e.g. maya/claude-2`);

  // 1. team config, committed: project id and hub URL. A checkout whose branch
  // predates that commit gets what the repository recorded, not a new project.
  const teamPath = path.join(root, TEAM_CONFIG_FILE_NAME);
  const teamExisting = readConfigFile(teamPath);
  const recorded = recordedSettings(root);
  const team: ConfigFile = { ...teamExisting };
  const notes: string[] = [];
  if (!teamExisting || opts.project || opts.url) {
    // Nothing recorded: another worktree's file says what the team uses (a repository set up by an
    // older `hub init`), or else the one committed upstream (a fresh clone, on a branch that predates it).
    const found = !teamExisting && !opts.project && !recorded.project ? (siblingTeamConfig(root) ?? upstreamTeamConfig(root)) : null;
    const known = opts.project ?? team.project ?? recorded.project ?? found?.project;
    team.project = known ?? deriveProject(root) ?? 'default';
    if (!known) {
      notes.push(
        `note: project ${team.project} was derived from the repository: there is no ${TEAM_CONFIG_FILE_NAME} in this checkout, in the other worktrees or on origin's default branch, and none recorded in the repository's git config. ` +
          'If your team already coordinates this repository under another project id, run `hub init --project ID` with that id.',
      );
    }
    if (opts.url) team.url = opts.url.replace(/\/+$/, '');
    else if (!teamExisting && (recorded.url ?? found?.url)) team.url = recorded.url ?? found?.url;
    if (JSON.stringify(team) !== JSON.stringify(teamExisting)) {
      writeJson(teamPath, team);
      report.push(`wrote ${TEAM_CONFIG_FILE_NAME} (project ${team.project}${team.url ? `, hub ${team.url}` : ''}); commit it so every clone and worktree agrees`);
    }
  }

  // 1b. the same, recorded in the git config every worktree shares. What another
  // checkout recorded is only replaced on purpose (--project, --url).
  const record: Array<[key: 'project' | 'url', value: string]> = [];
  if (team.project && (!recorded.project || (opts.project && recorded.project !== team.project))) record.push(['project', team.project]);
  // A recorded url gets the token in a worktree's .hub.json (see loadConfig). A branch can change agenthub.json,
  // so without --url one is recorded only if the team's own copy names the same hub.
  const disputed = team.url && !recorded.url && !opts.url ? otherRepositoryHub(root, team.url) : null;
  if (team.url && !disputed && (!recorded.url || (opts.url && recorded.url !== team.url))) record.push(['url', team.url]);
  if (disputed) {
    notes.push(
      `note: this checkout's ${TEAM_CONFIG_FILE_NAME} names hub ${team.url}, but ${disputed.where} names ${disputed.url}, so ${team.url} was not recorded as the repository's hub ` +
        `and a hub token in ${CONFIG_FILE_NAME} is not sent to it. If it is your team's hub, run \`hub init --url ${team.url}\`.`,
    );
  }
  const written = record.filter(([key, value]) => git(root, ['config', '--local', `agenthub.${key}`, value]) !== null);
  if (written.length) report.push(`recorded ${written.map(([k, v]) => `${k} ${v}`).join(', ')} in the repository's git config, for worktrees whose branch has no ${TEAM_CONFIG_FILE_NAME} yet`);
  if (recorded.project && team.project && recorded.project !== team.project && !opts.project) {
    notes.push(
      `note: this checkout's ${TEAM_CONFIG_FILE_NAME} says project ${team.project}, but the repository was set up for project ${recorded.project}, so edits and commits here are checked against other claims than the rest of the team's. ` +
        `Run \`hub init --project ${recorded.project}\` here to match, or \`hub init --project ${team.project}\` to switch the repository.`,
    );
  }

  // 2. this worktree's identity, never committed
  const localPath = path.join(root, CONFIG_FILE_NAME);
  const local: ConfigFile = readConfigFile(localPath) ?? {};
  if (opts.agent && local.agent !== opts.agent) {
    writeJson(localPath, { ...local, agent: opts.agent });
    report.push(`wrote ${CONFIG_FILE_NAME} (agent ${opts.agent})`);
  }
  if (excludeFromGit(root, `/${CONFIG_FILE_NAME}`)) report.push(`added /${CONFIG_FILE_NAME} to .git/info/exclude`);
  const agent = opts.agent ?? local.agent;
  const envAgent = (opts.env ?? process.env).HUB_AGENT;
  if (!agent) notes.push('note: no agent identity yet; run `hub init --agent <human>/<agent>` in each worktree');
  else if (envAgent && envAgent !== agent) {
    notes.push(
      `note: HUB_AGENT=${envAgent} is set in this shell and overrides ${agent} from ${CONFIG_FILE_NAME} for every hub command and Claude session started from it; ` +
        `unset it so this worktree acts as ${agent}`,
    );
  }

  // 3. Claude Code hooks
  if (opts.hooks !== false) {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    const hooks = (settings.hooks ??= {});
    // The hook fails open by itself only when the hub is unreachable. If it can't
    // run at all (`hub` or node missing, a crash, its timeout), Claude Code must
    // block the edit rather than let it through uncoordinated.
    let changed = addHook(hooks, 'PreToolUse', PRE_EDIT_MATCHER, `${command} hook pre-edit`, 'block');
    // Confirms the claims of edits that ran; settle releases the ones of edits that never did.
    changed = addHook(hooks, 'PostToolUse', PRE_EDIT_MATCHER, `${command} hook post-edit`) || changed;
    changed = addHook(hooks, 'SessionStart', undefined, `${command} hook digest`) || changed;
    for (const event of SETTLE_EVENTS) changed = addHook(hooks, event, undefined, `${command} hook settle`) || changed;
    if (opts.mcp !== false) {
      const enabled: string[] = (settings.enabledMcpjsonServers ??= []);
      if (!enabled.includes('hub')) {
        enabled.push('hub');
        changed = true;
      }
    }
    if (changed) {
      writeJson(settingsPath, settings);
      report.push('updated .claude/settings.json (pre-edit, post-edit, settle and digest hooks)');
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

  // 5. git guard
  if (opts.guard !== false) {
    const hooksDir = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    if (!hooksDir) throw new Error('could not locate the git hooks directory');
    mkdirSync(hooksDir, { recursive: true });
    installGitHook(hooksDir, 'pre-commit', guardScript(command), report);
    installGitHook(hooksDir, 'prepare-commit-msg', sequencerGuardScript(command), report);
    installGitHook(hooksDir, 'pre-applypatch', applyPatchGuardScript(command), report);
  }

  // A token in the environment looks as if it went everywhere: say now if it doesn't go to this hub.
  if ((opts.env ?? process.env).HUB_TOKEN) {
    try {
      const withheld = loadConfig({ cwd: root, env: opts.env ?? process.env }).tokenWithheld;
      if (withheld) notes.push(`note: ${withheld}`);
    } catch {
      // a config the hooks can't read: they say so themselves
    }
  }

  return [...(report.length ? report : ['already set up; nothing to change']), ...notes];
}

/** The project (and hub URL) the other worktrees' agenthub.json files agree on; throws if they don't. */
function siblingTeamConfig(root: string): ConfigFile | null {
  const found = siblingTeamConfigs(root).map((s) => s.config);
  const projects = [...new Set(found.map((f) => f.project))];
  if (projects.length > 1) throw new Error(`the worktrees' ${TEAM_CONFIG_FILE_NAME} files name different projects (${projects.join(', ')}); run hub init --project ID`);
  return found.find((f) => f.url) ?? found[0] ?? null;
}

/** Write a guard hook; a hook of the user's already there is kept and chained after it. */
function installGitHook(hooksDir: string, name: string, script: string, report: string[]): void {
  const hookPath = path.join(hooksDir, name);
  const current = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;
  if (current === script) return;
  if (current !== null && !current.includes(GUARD_MARKER)) {
    const chained = path.join(hooksDir, `${name}${CHAINED_SUFFIX}`);
    if (existsSync(chained)) throw new Error(`${hookPath} exists and ${chained} too; merge them by hand`);
    renameSync(hookPath, chained);
    report.push(`kept your existing ${name} hook as ${name}${CHAINED_SUFFIX} (runs after the guard)`);
  }
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  report.push(`installed ${name} guard at ${hookPath}`);
}

/** POSIX sh that runs the guard and handles a CLI that can't start (exit 127) as fail-closed says. */
function runGuardSh(command: string, args: string): string {
  const shown = command.replace(/["'`$\\]/g, '');
  return `${command} guard${args}
status=$?
if [ "$status" -eq 127 ] && [ "$HUB_GUARD" != off ]; then
  if fail_closed; then
    echo "agenthub: could not run '${shown}' (not on PATH, or node is missing); commit blocked (fail-closed)" >&2
    exit 1
  fi
  echo "agenthub: could not run '${shown}' (not on PATH, or node is missing); claim guard skipped" >&2
fi
[ "$status" -eq 127 ] && status=0
[ "$status" -ne 0 ] && exit "$status"`;
}

const FAIL_CLOSED_SH = `# Exit 127: the CLI (or the node it runs on) could not start, so nothing has read
# the fail-closed setting. Same precedence as the CLI: HUB_FAIL_CLOSED, then
# failClosed in the global, team and local config files (later files win).
fail_closed() {
  case "$(printf '%s' "$HUB_FAIL_CLOSED" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
    '') ;;
    0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
  fc=1
  for f in "\${HUB_CONFIG:-\${XDG_CONFIG_HOME:-$HOME/.config}/agenthub/config.json}" ${TEAM_CONFIG_FILE_NAME} ${CONFIG_FILE_NAME}; do
    [ -f "$f" ] || continue
    grep -Eq '"failClosed"[[:space:]]*:[[:space:]]*true' "$f" && fc=0
    grep -Eq '"failClosed"[[:space:]]*:[[:space:]]*false' "$f" && fc=1
  done
  return "$fc"
}`;

const chainSh = (name: string): string => `chained="$(dirname "$0")/${name}${CHAINED_SUFFIX}"
if [ -x "$chained" ]; then
  exec "$chained" "$@"
fi
exit 0
`;

export function guardScript(command: string): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
# Rejects commits that touch files another agent holds an exclusive claim on.
# Bypass in an emergency: git commit --no-verify   or   HUB_GUARD=off git commit

${FAIL_CLOSED_SH}

${runGuardSh(command, '')}
# Checked: prepare-commit-msg, run next by the same git process ($PPID), skips it.
gitdir="$(git rev-parse --git-dir 2>/dev/null)" && { echo "$PPID" > "$gitdir/${CHECKED_FILE}"; } 2>/dev/null
${chainSh('pre-commit')}`;
}

/**
 * prepare-commit-msg: git revert, cherry-pick and rebase commit without running
 * pre-commit (in process, or through `git commit -n -e` when the message is
 * edited, as it is by default on a terminal), with MERGE_MSG in the git dir and
 * no MERGE_HEAD. At a rebase stop (`edit`, say) only rebase-merge/ is there (or
 * rebase-apply/, for git am), and `git rebase --continue` commits what was
 * staged at it through `git commit -n` too. A commit whose pre-commit ran was
 * checked there: pre-commit leaves the pid of its git process. Any other commit
 * in the middle of one of those operations is checked here, including a
 * `git commit --no-verify` that finishes a conflicted pick, which looks the
 * same to the hooks as git's own `git commit -n -e`. Plain commits are left to
 * pre-commit (and --no-verify), and merge commits, which carry other branches'
 * work, are left alone.
 */
export function sequencerGuardScript(command: string): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
# git revert, cherry-pick and rebase make commits without running pre-commit;
# this checks those against other agents' exclusive claims.
# Bypass in an emergency: HUB_GUARD=off git <command>

${FAIL_CLOSED_SH}

gitdir="$(git rev-parse --git-dir 2>/dev/null)"
checked=""
if [ -n "$gitdir" ] && [ -f "$gitdir/${CHECKED_FILE}" ]; then
  checked="$(cat "$gitdir/${CHECKED_FILE}" 2>/dev/null)"
  rm -f "$gitdir/${CHECKED_FILE}"
fi
if [ -n "$gitdir" ] && [ "$checked" != "$PPID" ] && [ ! -f "$gitdir/MERGE_HEAD" ] &&
  { [ -f "$gitdir/MERGE_MSG" ] || [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; }; then
${runGuardSh(command, ' --sequencer').replace(/^/gm, '  ')}
fi
${chainSh('prepare-commit-msg')}`;
}

/** pre-applypatch: git am, and git rebase --apply through it, commit each patch without pre-commit or prepare-commit-msg. */
export function applyPatchGuardScript(command: string): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
# git am (and git rebase --apply) commits patches without running pre-commit;
# this checks each against other agents' exclusive claims.
# Bypass in an emergency: git am --no-verify   or   HUB_GUARD=off git <command>

${FAIL_CLOSED_SH}

${runGuardSh(command, ' --sequencer')}
${chainSh('pre-applypatch')}`;
}

type HookEntry = { type: string; command: string; timeout?: number; onFailure?: 'block' | 'continue' };
type HookGroup = { matcher?: string; hooks: HookEntry[] };

/** Tools a matcher made of plain names (which Claude Code reads as an exact list) leaves out. A pattern, or none, matches them all. */
function missingTools(matcher: string | undefined, tools: string[]): string[] {
  if (!matcher || matcher === '*' || !/^[A-Za-z0-9_|, -]+$/.test(matcher)) return [];
  const names = matcher.split(/[|,]/).map((n) => n.trim());
  return tools.filter((t) => !names.includes(t));
}

/**
 * Add the hook unless it's there. An entry from an older `hub init` gets the
 * `onFailure` it lacks (an explicit choice is kept), and one whose group's
 * matcher misses a file-writing tool (NotebookEdit) moves to `matcher`: the
 * whole group if the entry is alone in it, else into a group of its own.
 */
function addHook(hooks: Record<string, HookGroup[]>, event: string, matcher: string | undefined, command: string, onFailure?: 'block'): boolean {
  const groups = (hooks[event] ??= []);
  const holder = groups.find((g) => (g.hooks ?? []).some((h) => h.command === command));
  if (holder) {
    const existing = holder.hooks.find((h) => h.command === command)!;
    let changed = false;
    if (onFailure && existing.onFailure === undefined) {
      existing.onFailure = onFailure;
      changed = true;
    }
    if (matcher && missingTools(holder.matcher, EDIT_TOOLS).length > 0) {
      if (holder.hooks.length === 1) holder.matcher = matcher;
      else {
        holder.hooks = holder.hooks.filter((h) => h !== existing);
        groups.push({ matcher, hooks: [existing] });
      }
      changed = true;
    }
    return changed;
  }
  const entry: HookEntry = { type: 'command', command, timeout: 30 };
  if (onFailure) entry.onFailure = onFailure;
  const group: HookGroup = { hooks: [entry] };
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
