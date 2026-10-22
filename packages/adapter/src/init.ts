import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { deriveProject, git, gitRaw, realish, recordedSettings } from './git.js';
import { CALLED_HOOKS_DIR, GUARD_MARKER, commitGuardOff } from './guard-status.js';

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
const CHAINED_SUFFIX = '.pre-agenthub';
/**
 * In the repository's git dir, beside its hooks directory: hooks hub init found
 * that the guard can't run as their own file (see runsOnlyInPlace). The guard
 * runs them from there, under their own name and at the same depth, so a
 * relative symlink and a `$(dirname "$0")/../..` still lead where they did.
 */
const KEPT_HOOKS_DIR = 'agenthub-kept';
/** The shells whose scripts hub init keeps and chains (see chainSh). */
const SHELLS = ['sh', 'bash', 'dash', 'ksh', 'zsh'];
/** A #! line chainSh runs in its shell: the same as its `case` patterns. */
const SHELL_SHEBANG = new RegExp(`^#!.*[/ ](${SHELLS.join('|')})( .*)?$`);
/** In the worktree's git dir: the pid of the `git commit` whose pre-commit ran the guard, so its prepare-commit-msg doesn't ask again. */
const CHECKED_FILE = 'agenthub-pre-commit';
/** The line that runs the guard from such a hook. It does nothing in a checkout where hub init hasn't run. */
export const HOOKS_PATH_LINE =
  `agenthub_guard="$(git rev-parse --git-common-dir)/${CALLED_HOOKS_DIR}/$(basename "$0")"; ` +
  'if [ -x "$agenthub_guard" ]; then "$agenthub_guard" "$@" || exit $?; fi';

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
 *    revert, cherry-pick and rebase make without pre-commit), as
 *    pre-merge-commit (merges git commits itself) and as pre-applypatch
 *    (git am, git rebase --apply); an existing hook is kept and runs after the
 *    guard (a shell script as its own file, anything else from
 *    .git/agenthub-kept). Hooks core.hooksPath sends git to get the guard the
 *    same way when the directory is the repository's own and git ignores it
 *    (husky's .husky/_), and are left alone otherwise (see below)
 *  - the project id and hub URL in the repository's git config, which every
 *    worktree shares, for checkouts whose branch has no agenthub.json yet
 * Safe to run again; it only adds what's missing, and replaces its own hook
 * entries written with another --command.
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
    // The hook fails open by itself only when the hub is unreachable. If it crashes or
    // times out, Claude Code must block the edit rather than let it through
    // uncoordinated. A CLI that isn't installed is a checkout not set up, as one
    // with no identity is: a visible warning, or a block when fail-closed is set.
    let changed = addHook(hooks, 'PreToolUse', PRE_EDIT_MATCHER, preEditCommand(command), 'block');
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

  // 5. git guard, in front of the hooks git runs. In the repository's own hooks directory, a hook
  // that is a shell script is kept and runs after the guard as its own file (chainSh); one the guard
  // can't run that way (a symlink, another language, a binary) moves to <git dir>/agenthub-kept and
  // runs from there, under its own name. Where core.hooksPath sends git elsewhere, the guard goes in
  // front of the hooks there the same way when that directory is this repository's own and git
  // ignores it (husky's generated .husky/_). A directory the team tracks, or one other repositories
  // may use (a global one, one outside this repository), isn't hub init's to change: the guard goes
  // where their hooks can call it, and a note says how, and that the guard is off until then.
  if (opts.guard !== false) {
    if (git(root, ['config', '--local', '--get', 'agenthub.guard']) === 'off') git(root, ['config', '--local', '--unset', 'agenthub.guard']);
    const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const runs = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    if (!common || !runs) throw new Error('could not locate the git hooks directory');
    const own = path.join(common, 'hooks');
    const called = path.join(common, CALLED_HOOKS_DIR);
    const keptDir = path.join(common, KEPT_HOOKS_DIR);
    const elsewhere = realish(runs) !== realish(own);
    const target = elsewhere ? hooksPathTarget(root, runs, common) : own;
    const installed: string[] = [];
    const calledInstalled: string[] = [];
    const notChained: string[] = [];
    for (const [name, script] of guardHooks(command, target === own)) {
      if (!target) {
        installGitHook(called, name, script, calledInstalled);
        continue;
      }
      const hookPath = path.join(target, name);
      const why = isGuard(hookPath) ? null : runsOnlyInPlace(hookPath);
      if (target === own) {
        // An older hub init kept such a hook as <name>.pre-agenthub, where it runs under another name: it gets its own back.
        if (isGuard(hookPath) && runsOnlyInPlace(hookPath + CHAINED_SUFFIX)) {
          const kept = keepHook(hookPath + CHAINED_SUFFIX, keptDir, name);
          installed.push(`moved your ${name} hook from ${name}${CHAINED_SUFFIX} to ${kept}, where the guard runs it after its check under its own name`);
        }
        if (why) {
          const kept = keepHook(hookPath, keptDir, name);
          installed.push(`moved your ${name} hook, which ${why}, to ${kept}: the guard runs it from there after its check, under its own name`);
        }
      } else if (why) {
        installGitHook(called, name, script, calledInstalled);
        notChained.push(`${hookPath} ${why}`);
        continue;
      }
      installGitHook(target, name, script, installed);
    }
    report.push(...installed);
    if (calledInstalled.length) report.push(`wrote the git guard to ${called}`);
    if (elsewhere) notes.push(...hooksPathNotes(root, runs, own, called, target !== null));
    if (notChained.length) {
      const many = notChained.length > 1;
      notes.push(
        `note: ${notChained.join('; ')}, so hub init left ${many ? 'them where they are' : 'it where it is'}: run after the guard, a hook like that would no longer run as git runs it ` +
          `(under its own name, from its own place). The guard for ${many ? 'each' : 'it'} is in ${called}, under the hook's name, which git does not run by itself. ` +
          `To turn it on, have the hook run that guard first, with the hook's arguments, and stop if it fails. In a shell script (for a symlink, the script it links to) ` +
          `this line near the top does that, and does nothing in a checkout where hub init has not run: ${HOOKS_PATH_LINE}`,
      );
    }
    const off = commitGuardOff(root);
    if (off) notes.push(`warning: ${off}`);
  } else {
    // So the digest and `hub whoami` don't report a guard this repository chose to go without.
    git(root, ['config', '--local', 'agenthub.guard', 'off']);
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

/** The guard hooks hub init installs, by git hook name; `kept`: in the repository's own hooks directory, where they run the hooks hub init moved to KEPT_HOOKS_DIR. */
function guardHooks(command: string, kept: boolean): Array<[name: string, script: string]> {
  return [
    ['pre-commit', guardScript(command, kept)],
    ['prepare-commit-msg', sequencerGuardScript(command, kept)],
    ['pre-merge-commit', mergeGuardScript(command, kept)],
    ['pre-applypatch', applyPatchGuardScript(command, kept)],
  ];
}

/**
 * The core.hooksPath directory `runs` when hub init may put the guard in front
 * of its hooks: set for this repository alone (in its local or worktree git
 * config), and inside its git dir, or inside the worktree where git ignores the
 * hook files and tracks none of the directory (husky's generated .husky/_,
 * whose .gitignore is `*`). Null for any other (a global one, which every
 * repository on the machine runs; one the team tracks; one outside the repository).
 */
function hooksPathTarget(root: string, runs: string, common: string): string | null {
  const scope = /^(\w+)\t/.exec(git(root, ['config', '--show-scope', '--get', 'core.hooksPath']) ?? '')?.[1];
  if (scope !== 'local' && scope !== 'worktree') return null;
  const dir = realish(runs);
  const inside = (base: string) => dir === base || dir.startsWith(base + path.sep);
  if (inside(realish(common))) return runs;
  const top = realish(root);
  if (!inside(top)) return null;
  const rel = path.relative(top, dir).split(path.sep).join('/');
  if (git(root, ['ls-files', '--', rel]) !== '') return null; // tracked (or git failed): the team's
  for (const [name] of guardHooks('hub', false)) {
    for (const f of [name, `${name}${CHAINED_SUFFIX}`]) if (gitRaw(root, ['check-ignore', '--', `${rel}/${f}`]) === null) return null; // would show up as new files
  }
  return runs;
}

/** What to say when core.hooksPath (`runs`) sends git to hooks other than `own`; `chained`: the guard went in front of them, else to `installed`. */
function hooksPathNotes(root: string, runs: string, own: string, installed: string, chained: boolean): string[] {
  const m = /^(\w+)\t(.*)$/.exec(git(root, ['config', '--show-scope', '--get', 'core.hooksPath']) ?? '');
  const where = m ? `core.hooksPath (${m[2]}, set in the ${m[1]} git config)` : `core.hooksPath (${runs})`;
  if (chained) {
    return [
      `note: git runs hooks from ${where}, not from ${own}, so the guard went in front of the hooks there. A hook manager may write that directory again ` +
        '(husky does on every install), which takes the guard out: run `hub init` again then. The session digest and `hub whoami` say when the guard is off.',
    ];
  }
  const notes = [
    `note: git runs hooks from ${where}, not from ${own}. hub init leaves those alone (a hook manager, your team or other repositories may use them) ` +
      `and put the guard in ${installed}, which git does not run by itself. To turn it on, add this line near the top of your pre-commit, prepare-commit-msg, ` +
      `pre-merge-commit and pre-applypatch hooks (with husky: .husky/pre-commit and so on); it does nothing in a checkout where hub init has not run: ${HOOKS_PATH_LINE}`,
  ];
  const stale = guardHooks('hub', false)
    .map(([name]) => path.join(runs, name))
    .filter((f) => existsSync(f) && readFileSync(f, 'utf8').includes(GUARD_MARKER));
  if (stale.length) {
    const undo = stale.map((f) => (existsSync(f + CHAINED_SUFFIX) ? `move ${f}${CHAINED_SUFFIX} back to ${f}` : `delete ${f}`));
    notes.push(
      `note: ${stale.join(', ')} ${stale.length > 1 ? 'are guards' : 'is a guard'} an older hub init installed there, which every checkout that uses ${runs} runs. ` +
        `To undo that, ${undo.join('; ')}.`,
    );
  }
  return notes;
}

/** Write a guard hook; a hook of the user's already there is kept and chained after it (and a link is never written through). */
function installGitHook(hooksDir: string, name: string, script: string, report: string[]): void {
  const hookPath = path.join(hooksDir, name);
  const stat = lstatSync(hookPath, { throwIfNoEntry: false });
  const current = stat?.isFile() ? readFileSync(hookPath, 'utf8') : null;
  if (current === script) return;
  if (stat && !current?.includes(GUARD_MARKER)) {
    const chained = path.join(hooksDir, `${name}${CHAINED_SUFFIX}`);
    const kept = lstatSync(chained, { throwIfNoEntry: false });
    // A hook manager that wrote its hook again (husky on install) left the copy kept before as it was.
    const same = kept?.isFile() && stat.isFile() && readFileSync(chained, 'utf8') === current;
    if (kept && !same) throw new Error(`${hookPath} exists and ${chained} too; merge them by hand`);
    if (same) rmSync(hookPath);
    else renameSync(hookPath, chained);
    report.push(`kept your existing ${name} hook as ${name}${CHAINED_SUFFIX} (runs after the guard)`);
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  report.push(`installed ${name} guard at ${hookPath}`);
}

/** Move the hook at `file` to `keptDir` under `name`, where the guard runs it (see runKeptSh); returns where it went. */
function keepHook(file: string, keptDir: string, name: string): string {
  const kept = path.join(keptDir, name);
  if (lstatSync(kept, { throwIfNoEntry: false })) throw new Error(`${file} exists and ${kept} too; merge them by hand`);
  mkdirSync(keptDir, { recursive: true });
  renameSync(file, kept);
  return kept;
}

function isGuard(file: string): boolean {
  return !!lstatSync(file, { throwIfNoEntry: false })?.isFile() && readFileSync(file, 'utf8').includes(GUARD_MARKER);
}

/**
 * Why the guard couldn't run the hook at `file` after itself the way git runs
 * it, as that file (see chainSh), or null if it can (or git doesn't run it).
 * It can for a shell script; not for a symlink (the hook may find its target,
 * or the repository, through its own path, and the guard takes that path) or
 * for another kind of program, which sees the path it is started from. Such a
 * hook moves to KEPT_HOOKS_DIR instead (see runKeptSh).
 */
function runsOnlyInPlace(file: string): string | null {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) return `is a symlink (to ${readlinkSync(file)})`;
  if (!stat?.isFile()) return null;
  try {
    accessSync(file, constants.X_OK);
  } catch {
    return null; // git doesn't run it
  }
  const text = readFileSync(file);
  const first = text.toString('latin1').split('\n', 1)[0];
  // Without a #! line git has sh run it (and a binary has a #! line or NUL bytes).
  const shell = first.startsWith('#!') ? SHELL_SHEBANG.test(first) : !text.includes(0);
  return shell ? null : 'is not a shell script';
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

/**
 * Run the hook hub init found (kept as <name>.pre-agenthub) the way git would
 * have: as the hook's own file, so it sees its own name and place in $0 (and
 * bash's BASH_SOURCE). Hooks pick what to run (husky 4's, yorkie's,
 * dispatchers) or find their helpers and the checkout through them. hub init
 * keeps only shell scripts (see runsOnlyInPlace), so the guard's own file is
 * run again by the hook's shell (sh, as git does, where it has no #! line),
 * where keptSh, the guard's first lines, runs the hook's code. Anything else
 * (a symlink or another program put there since) runs as it is.
 */
const chainSh = (name: string): string => `chained="$(dirname "$0")/${name}${CHAINED_SUFFIX}"
[ -x "$chained" ] || exit 0
[ -L "$chained" ] && exec "$chained" "$@"
first=
IFS= read -r first < "$chained"
case "$first" in
  ${SHELLS.map((s) => `'#!'*[/\\ ]${s} | '#!'*[/\\ ]${s}\\ *`).join(' | ')}) shell=\${first#??} ;;
  '#!'*) exec "$chained" "$@" ;;
  *) shell=/bin/sh ;;
esac
AGENTHUB_KEPT_HOOK="$$ $0"; export AGENTHUB_KEPT_HOOK
exec $shell "$0" "$@"
`;

/**
 * Run the hook hub init moved to KEPT_HOOKS_DIR (a symlink, or not a shell
 * script), the way git would have: under its own name, with the arguments
 * git gave, one directory over from where git found it.
 */
const runKeptSh = (name: string): string => `kept="$(git rev-parse --git-common-dir 2>/dev/null)/${KEPT_HOOKS_DIR}/${name}"
[ -x "$kept" ] && exec "$kept" "$@"
`;

/** The first lines of each guard: run as the kept hook when chainSh has the hook's shell run this file again (same process, so same $$). */
const keptSh = (name: string): string => `if [ "\${AGENTHUB_KEPT_HOOK-}" = "$$ $0" ]; then
  unset AGENTHUB_KEPT_HOOK
  eval "$(cat "$(dirname "$0")/${name}${CHAINED_SUFFIX}")"
  exit
fi`;

export function guardScript(command: string, kept = true): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
${keptSh('pre-commit')}
# Rejects commits that touch files another agent holds an exclusive claim on.
# Bypass in an emergency: git commit --no-verify   or   HUB_GUARD=off git commit

${FAIL_CLOSED_SH}

${runGuardSh(command, '')}
# Checked: prepare-commit-msg, run next by the same git process ($PPID), skips it.
gitdir="$(git rev-parse --git-dir 2>/dev/null)" && { echo "$PPID" > "$gitdir/${CHECKED_FILE}"; } 2>/dev/null
${kept ? runKeptSh('pre-commit') : ''}${chainSh('pre-commit')}`;
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
export function sequencerGuardScript(command: string, kept = true): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
${keptSh('prepare-commit-msg')}
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
${kept ? runKeptSh('prepare-commit-msg') : ''}${chainSh('prepare-commit-msg')}`;
}

/**
 * pre-merge-commit: git merge commits a merge without conflicts without running
 * pre-commit. It runs this before it writes MERGE_HEAD: `--merge` tells the
 * guard to find the merged commits elsewhere (see mergeHeads).
 */
export function mergeGuardScript(command: string, kept = true): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
${keptSh('pre-merge-commit')}
# git merge commits a merge without conflicts without running pre-commit; this
# checks what the merge itself changes against other agents' exclusive claims.
# Bypass in an emergency: git merge --no-verify   or   HUB_GUARD=off git merge

${FAIL_CLOSED_SH}

${runGuardSh(command, ' --merge')}
${kept ? runKeptSh('pre-merge-commit') : ''}${chainSh('pre-merge-commit')}`;
}

/** pre-applypatch: git am, and git rebase --apply through it, commit each patch without pre-commit or prepare-commit-msg. */
export function applyPatchGuardScript(command: string, kept = true): string {
  return `#!/bin/sh
${GUARD_MARKER} (installed by \`hub init\`)
${keptSh('pre-applypatch')}
# git am (and git rebase --apply) commits patches without running pre-commit;
# this checks each against other agents' exclusive claims.
# Bypass in an emergency: git am --no-verify   or   HUB_GUARD=off git <command>

${FAIL_CLOSED_SH}

${runGuardSh(command, ' --sequencer')}
${kept ? runKeptSh('pre-applypatch') : ''}${chainSh('pre-applypatch')}`;
}

/**
 * The PreToolUse entry's command: the hook, and what to do when the shell can't
 * start the CLI (exit 127: not on PATH, or node missing), which hasn't read the
 * fail-closed setting. Like the guard script: HUB_FAIL_CLOSED, else failClosed
 * in the project's agenthub.json or .hub.json, blocks the edit (exit 2);
 * otherwise it goes ahead with a warning the user sees, as in a checkout with
 * no identity. Anything else the hook can't do (a crash, its timeout) is a
 * failure, which `onFailure: "block"` turns into a denial.
 */
export function preEditCommand(command: string): string {
  const shown = command.replace(/["'`$\\]/g, '');
  const warning = JSON.stringify({
    systemMessage: `agenthub: could not run ${shown} (not on PATH, or node is missing), so this edit is not coordinated with other agents. Install the agenthub CLI or put it on PATH.`,
  });
  const files = '"$CLAUDE_PROJECT_DIR/agenthub.json" "$CLAUDE_PROJECT_DIR/.hub.json"';
  return (
    `${command} hook pre-edit; s=$?; [ "$s" -ne 127 ] && exit "$s"; ` +
    `case "$HUB_FAIL_CLOSED" in ` +
    `'') grep -qs '"failClosed"[[:space:]]*:[[:space:]]*true' ${files} || { printf '%s\\n' '${warning}'; exit 0; } ;; ` +
    `0|false|no|off|FALSE|NO|OFF|False|No|Off) printf '%s\\n' '${warning}'; exit 0 ;; ` +
    `esac; echo "agenthub: could not run ${shown} (not on PATH, or node is missing); edit blocked (fail-closed)" >&2; exit 2`
  );
}

type HookEntry = { type: string; command: string; timeout?: number; onFailure?: 'block' | 'continue' };
type HookGroup = { matcher?: string; hooks: HookEntry[] };

/** Tools a matcher made of plain names (which Claude Code reads as an exact list) leaves out. A pattern, or none, matches them all. */
function missingTools(matcher: string | undefined, tools: string[]): string[] {
  if (!matcher || matcher === '*' || !/^[A-Za-z0-9_|, -]+$/.test(matcher)) return [];
  const names = matcher.split(/[|,]/).map((n) => n.trim());
  return tools.filter((t) => !names.includes(t));
}

/** Whether `prefix`, what a hook entry runs before ` hook <name>`, is the hub CLI: `hub`, a path to it or to its bin/hub.js, npx @agenthub/adapter. */
function runsHub(prefix: string): boolean {
  return splitCommand(prefix).some((w) => /^hub(\.[cm]?js|\.cmd|\.exe)?$/.test(w.split(/[\\/]/).pop() ?? '') || /^@agenthub\/adapter(@|$)/.test(w));
}

/**
 * Add the hook unless it's there. An entry an earlier `hub init` wrote with
 * another --command (one that runs the same `hook <name>` subcommand of the
 * hub CLI; other tools' hooks may have subcommands of that name) is updated to
 * `command`, and any more of them are removed, so the hook runs once. An entry
 * from an older `hub init` gets the `onFailure` it lacks (an explicit choice
 * is kept), and one whose group's matcher misses a file-writing tool
 * (NotebookEdit) moves to `matcher`: the whole group if the entry is alone in
 * it, else into a group of its own.
 */
function addHook(hooks: Record<string, HookGroup[]>, event: string, matcher: string | undefined, command: string, onFailure?: 'block'): boolean {
  const groups = (hooks[event] ??= []);
  // `<cli> hook <name>`, as older versions wrote it, or followed by what preEditCommand adds.
  const subcommand = / hook [a-z-]+/.exec(command.slice(command.lastIndexOf(' hook ')))![0];
  const prefixOf = (c: string): string | null => {
    if (c.endsWith(subcommand)) return c.slice(0, -subcommand.length);
    const at = c.indexOf(`${subcommand}; s=$?;`);
    return at > 0 ? c.slice(0, at) : null;
  };
  const isOurs = (c: unknown) => typeof c === 'string' && (c === command || (prefixOf(c) !== null && runsHub(prefixOf(c)!)));
  const ours = groups.flatMap((g) => (g.hooks ?? []).filter((h) => isOurs(h?.command)).map((h) => ({ group: g, entry: h })));
  const kept = ours.find((o) => o.entry.command === command) ?? ours[0];
  let changed = false;
  for (const o of ours) {
    if (o === kept) continue;
    o.group.hooks = o.group.hooks.filter((h) => h !== o.entry);
    if (o.group.hooks.length === 0) groups.splice(groups.indexOf(o.group), 1);
    changed = true;
  }
  if (kept) {
    const { group: holder, entry: existing } = kept;
    if (existing.command !== command) {
      existing.command = command;
      changed = true;
    }
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
