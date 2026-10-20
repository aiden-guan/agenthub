# Phase 1 review

Adversarial review of the hub and adapter, run on 2026-10-20 with 151 agents: six reviewers by area, a second pass on four areas the first pass missed, and two independent verifiers per finding (one reproducing it, one trying to refute it). 70 findings survived verification, most of them reproduced against the built code. They group into the 11 root causes below. Severity per finding is the lower of the two verifier ratings.

Nothing in the code was changed by the review. Reproduction scripts are in the session scratchpad.

## 1. One bad WebSocket frame crashes the hub
**Overall: Critical**

Feed sockets have no `error` listener and the process has no fallback handler. A single oversized (>64 KiB) or malformed frame from any client, with no token in the default setup, makes `ws` emit an unhandled `error` and the whole hub exits. Coordination is gone for everyone until someone restarts it.

| Severity | Where | Finding |
|---|---|---|
| high | `packages/hub/src/server.ts:128` | WebSocket feed has no 'error' listener: one oversized/invalid frame crashes the whole hub process (unauthenticated DoS) |
| medium | `packages/hub/src/server.ts:127` | A single malformed or oversized WebSocket frame on /feed crashes the hub-server process |
| medium | `packages/hub/src/server.ts:127` | One malformed or oversized WebSocket frame crashes the whole hub (no 'error' listener on feed sockets, no uncaughtException handler) |

<details><summary>Suggested fixes from the reviewers</summary>

- **WebSocket feed has no 'error' listener: one oversized/invalid frame crashes the whole hub process (unauthenticated DoS)**: Add ws.on('error', ...) in onFeed (log and let ws close the socket) and also handle 'error' on the WebSocketServer. A missing error handler on any ws socket is a crash vector.
- **A single malformed or oversized WebSocket frame on /feed crashes the hub-server process**: In onFeed, register ws.on('error', (err) => { log it; ws.terminate(); }) before anything else. Also add an 'error' handler on wss.
- **One malformed or oversized WebSocket frame crashes the whole hub (no 'error' listener on feed sockets, no uncaughtException handler)**: Add ws.on('error', ...) in onFeed that logs the error and terminates that socket. As a backstop, add process-level uncaughtException and unhandledRejection handlers in cli.ts that log the error and keep the hub running, or exit loudly.

</details>

## 2. Enforcement silently turns off on errors that aren't "hub down"
**Overall: High**

The accepted limit is: fail open when the hub is unreachable. In practice many other failures take the same path, and some ignore `HUB_FAIL_CLOSED`: git output over 1 MiB or slower than 3 s looks like an empty commit; any hub API error, including a 401 for a wrong token or a 400 for one unusual filename, unchecks the whole commit or edit; config parse errors allow edits; the installed git hook passes when the `hub` CLI is missing; and the Claude Code hook entries don't block when the hook command itself fails or times out. Warnings go only to stderr, which nobody sees.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/adapter/src/git.ts:77` | If git's staged-file output is over 1 MiB or takes over 3 s, the guard treats the commit as empty and lets it through silently, even with HUB_FAIL_CLOSED=1 |
| medium | `packages/adapter/src/git.ts:24` | Pre-commit guard silently fails open on large commits (git output exceeds execFileSync default 1 MiB maxBuffer) |
| medium | `packages/adapter/src/guard.ts:27` | Every hub API error is handled as 'hub unreachable', so one unusual staged filename (or a large commit) switches the guard off for the whole commit |
| medium | `packages/adapter/src/hooks.ts:80` | A missing or wrong token (hub answers 401) is treated as 'hub unreachable', so edits and commits go through without any claim check |
| medium | `packages/hub/src/cli.ts:35` | A non-numeric --lease-ttl-ms or --heartbeat-ms (e.g. '2m', '30s') makes every claim a 500, so hooks and guard fail open on every edit |
| low | `packages/adapter/src/guard.ts:26` | A single un-normalizable staged path makes the guard skip the whole commit check (fails open) |
| low | `packages/hub/src/hub.ts:711` | Hub rejects legal POSIX names that look like drive letters ('a:b.md'), so one such staged file makes the whole pre-commit check fail open |
| low | `packages/adapter/src/hooks.ts:66` | Config load errors (malformed agenthub.json, non-string url, bad agent id) make the pre-edit hook allow edits even with HUB_FAIL_CLOSED=1, while the guard blocks every commit |
| low | `packages/adapter/src/init.ts:128` | The installed hook script lets the commit through when the `hub` CLI is missing, ignoring HUB_FAIL_CLOSED and `failClosed` in .hub.json |
| low | `packages/adapter/src/init.ts:146` | Hook entries are written without onFailure:"block", so HUB_FAIL_CLOSED can't stop an edit when the `hub` command is missing, crashes or times out; the default `hub` command resolves only from a shell with node_modules/.bin on PATH |
| low | `packages/adapter/src/config.ts:69` | A negative or very large HUB_TIMEOUT_MS on the adapter makes every hub request throw, so hooks and guard fail open as if the hub were unreachable |
| low | `packages/adapter/src/config.ts:69` | HUB_TIMEOUT_MS is not range-checked: -1, fractional or very large values make every request throw before contacting the hub, so all checks fail open |
| low | `packages/adapter/src/config.ts:96` | HUB_FAIL_CLOSED parsing turns unrecognized values into false, which overrides a file's failClosed:true, and a string "false" in a file counts as true |
| low | `packages/adapter/src/hooks.ts:19` | Every fail-open path warns only on stderr with exit 0, which Claude Code never shows to Claude or the user |

<details><summary>Suggested fixes from the reviewers</summary>

- **If git's staged-file output is over 1 MiB or takes over 3 s, the guard treats the commit as empty and lets it through silently, even with HUB_FAIL_CLOSED=1**: Have stagedPaths throw (or return a distinct failure) when git fails, and in guard() handle that like an unreachable hub: block if failClosed, otherwise warn. Set maxBuffer high (or stream output), use a much longer timeout or none for this call, and consider `--no-renames` plus a second cheap rename pass, or diff.renameLimit, to keep it fast.
- **Pre-commit guard silently fails open on large commits (git output exceeds execFileSync default 1 MiB maxBuffer)**: Pass a large maxBuffer (e.g. 64 MiB) to execFileSync in gitRaw, and/or distinguish 'git failed' (ENOBUFS/timeout) from 'no staged files' so the guard fails closed or at least warns instead of silently allowing.
- **Every hub API error is handled as 'hub unreachable', so one unusual staged filename (or a large commit) switches the guard off for the whole commit**: In guard(), treat HubApiError as a hard failure (block, or at least never 'claims not checked'), and keep fail-open only for HubUnavailableError. On the hub side, make check() skip or report unnormalizable paths per file instead of failing the batch. In the adapter, send files in chunks under the body limit.
- **A single un-normalizable staged path makes the guard skip the whole commit check (fails open)**: In check()/stagedPaths, skip (and ignore) individual paths that fail normalization rather than throwing for the whole request, or have the guard normalize per-file and drop only the offending entries so claimed files are still checked.
- **Hub rejects legal POSIX names that look like drive letters ('a:b.md'), so one such staged file makes the whole pre-commit check fail open**: Apply the drive-letter rule only to `X:/` or `X:\` prefixes, and make check() skip or report individual bad paths instead of failing the whole batch.
- **A missing or wrong token (hub answers 401) is treated as 'hub unreachable', so edits and commits go through without any claim check**: Fail open only for HubUnavailableError. For HubApiError (especially 401/403/400), deny the edit with a clear 'misconfigured: fix your token/project' reason and block the commit, or at least do so for auth errors.
- **Config load errors (malformed agenthub.json, non-string url, bad agent id) make the pre-edit hook allow edits even with HUB_FAIL_CLOSED=1, while the guard blocks every commit**: In preEditHook's config catch, deny when parseBool(io.env.HUB_FAIL_CLOSED) is true. Better, deny on any config error, since a broken config isn't a hub outage. Validate field types in loadConfig (url/project/agent/token must be strings, failClosed a boolean, files must be plain objects) and give a clear error.
- **The installed hook script lets the commit through when the `hub` CLI is missing, ignoring HUB_FAIL_CLOSED and `failClosed` in .hub.json**: In the generated script, keep status 127 as a failure when HUB_FAIL_CLOSED is truthy. Better, have `hub init` write an absolute path to the CLI, or a resolvable node and script path, so a missing PATH entry doesn't silently disable the guard.
- **Hook entries are written without onFailure:"block", so HUB_FAIL_CLOSED can't stop an edit when the `hub` command is missing, crashes or times out; the default `hub` command resolves only from a shell with node_modules/.bin on PATH**: Write "onFailure": "block" on the pre-edit hook, at least when fail-closed is configured; put a machine-specific setting in .claude/settings.local.json if needed. Default the command to a stable absolute path for this machine in settings.local.json rather than the committed file, or document that `hub` must resolve. Cap timeoutMs below the hook timeout.
- **A negative or very large HUB_TIMEOUT_MS on the adapter makes every hub request throw, so hooks and guard fail open as if the hub were unreachable**: Validate HUB_TIMEOUT_MS as an integer within [1, 2^31-1], falling back to 4000 or raising a config error. Report a bad timeout as a configuration error instead of as the hub being unreachable.
- **HUB_TIMEOUT_MS is not range-checked: -1, fractional or very large values make every request throw before contacting the hub, so all checks fail open**: Parse with Number.parseInt and clamp to a sane range (e.g. 100..600000), falling back to 4000 for anything else.
- **HUB_FAIL_CLOSED parsing turns unrecognized values into false, which overrides a file's failClosed:true, and a string "false" in a file counts as true**: Trim the value. Return undefined (or throw) for unrecognized values and accept explicit false values (0/false/no/off). Coerce or reject non-boolean failClosed in files.
- **A non-numeric --lease-ttl-ms or --heartbeat-ms (e.g. '2m', '30s') makes every claim a 500, so hooks and guard fail open on every edit**: In cli.ts, parse each numeric option strictly (/^\d+$/ after trim) and exit with a clear error naming the option on bad input. Also guard with Number.isFinite in the Hub constructor.
- **Every fail-open path warns only on stderr with exit 0, which Claude Code never shows to Claude or the user**: On fail-open, print a JSON object instead: hookSpecificOutput.additionalContext for Claude and/or a top-level systemMessage for the user. Leave permissionDecision unset so the normal flow applies.

</details>

## 3. Ways an edit or commit skips the claim check
**Overall: High**

The edit hook finds the repo and identity from Claude's current folder, not from the edited file, so after a `cd` out of the worktree nothing is enforced. A worktree on a branch without `agenthub.json` resolves a different project id, so the shared guard checks an empty project. NotebookEdit isn't matched. Paths like `..env` are treated as outside the repo. On macOS, NFD and NFC spellings of one filename give two claim keys, so two agents can both hold it exclusively. `HUB_AGENT` silently merges parallel worktree identities into one. `git revert` and `cherry-pick` never run the guard.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/adapter/src/hooks.ts:42` | pre-edit hook resolves identity and repo root from Claude's current cwd, not from the edited file, so a `cd` out of the worktree turns enforcement off |
| medium | `packages/adapter/src/config.ts:66` | A worktree whose branch has no agenthub.json resolves a different project, so the shared pre-commit guard checks an empty project and lets commits of claimed files through |
| medium | `packages/adapter/src/init.ts:18` | PreToolUse matcher 'Edit\|Write\|MultiEdit' misses NotebookEdit, so notebooks claimed by another agent can be edited |
| low | `packages/adapter/src/git.ts:69` | toRepoPath treats any repo path starting with '..' (e.g. '..env') as outside the repository, so the edit hook allows the edit without a claim |
| low | `packages/adapter/src/git.ts:69` | toRepoPath treats any repo path that starts with '..' (for example '..env' or '..data/x') as outside the repository, so those files are never claimed |
| low | `packages/adapter/src/git.ts:54` | Claim keys aren't Unicode-normalized: on macOS an NFD filename on disk gives a different key than git's NFC path, so two agents can both hold an exclusive claim and the guard never matches |
| low | `packages/adapter/src/config.ts:59` | HUB_AGENT (or a global-file `agent`) silently overrides each worktree's .hub.json, so parallel worktree sessions become one identity and claims renew instead of conflicting |
| low | `packages/adapter/src/init.ts:102` | Only pre-commit is hooked, so `git revert` and `git cherry-pick` create commits touching exclusively claimed files with no guard check |

<details><summary>Suggested fixes from the reviewers</summary>

- **pre-edit hook resolves identity and repo root from Claude's current cwd, not from the edited file, so a `cd` out of the worktree turns enforcement off**: Find the repo root from the edited file itself: findRepoRoot(path.dirname(realish(file_path))). Load the config with that root as cwd and map the path relative to it. Fall back to CLAUDE_PROJECT_DIR for identity when the file's worktree has no .hub.json. When HUB_FAIL_CLOSED is set, deny instead of allowing when no identity resolves for a file inside a repo.
- **A worktree whose branch has no agenthub.json resolves a different project, so the shared pre-commit guard checks an empty project and lets commits of claimed files through**: Don't derive the project silently when the repo is meant to be coordinated. Record the project id somewhere shared by all worktrees (e.g. `git config agenthub.project` in the common config, set by `hub init`) and read it before deriving. Make the guard and hooks warn or fail closed when no agenthub.json/project is found but the guard is installed. `hub init` should refuse to invent a project that differs from one recorded elsewhere.
- **PreToolUse matcher 'Edit|Write|MultiEdit' misses NotebookEdit, so notebooks claimed by another agent can be edited**: Use the matcher 'Edit|Write|NotebookEdit' (MultiEdit can stay but is unused). In init, replace the matcher of an existing group that already holds the pre-edit command instead of skipping it.
- **toRepoPath treats any repo path starting with '..' (e.g. '..env') as outside the repository, so the edit hook allows the edit without a claim**: Use `rel === '..' || rel.startsWith('..' + path.sep)` (plus the path.isAbsolute check) instead of rel.startsWith('..').
- **toRepoPath treats any repo path that starts with '..' (for example '..env' or '..data/x') as outside the repository, so those files are never claimed**: Use `rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)`.
- **Claim keys aren't Unicode-normalized: on macOS an NFD filename on disk gives a different key than git's NFC path, so two agents can both hold an exclusive claim and the guard never matches**: Normalize repo paths to NFC in toRepoPath (and in normalizeRepoPath on the hub) so the edit hook, MCP/CLI claims and the guard all produce the same key.
- **HUB_AGENT (or a global-file `agent`) silently overrides each worktree's .hub.json, so parallel worktree sessions become one identity and claims renew instead of conflicting**: When HUB_AGENT (or the global agent) differs from a .hub.json agent, prefer .hub.json, or refuse with an explicit error, or at minimum warn in the digest, whoami and init. Stop recommending HUB_AGENT for multi-worktree use.
- **Only pre-commit is hooked, so `git revert` and `git cherry-pick` create commits touching exclusively claimed files with no guard check**: Also install the guard as pre-merge-commit, and document or check in a post-commit or reference-transaction hook (or at land time) for sequencer operations. At minimum, document that revert, cherry-pick and rebase are not guarded.

</details>

## 4. Other people's agents can inject text into your agent's context
**Overall: High**

Claimed file paths aren't checked for newlines, control or bidi characters, and they're shown unquoted in the SessionStart digest, `hub_status`, `hub_wait` and deny messages. A teammate's agent can claim a 'file' whose name is a multi-line instruction. Claim intents in deny messages also skip the untrusted-data wrapper that messages get.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/hub/src/hub.ts:706` | Claim/decision file paths are not stripped of control, newline and bidi characters, enabling forged lines and ANSI/bidi injection into the SessionStart digest and deny messages |
| medium | `packages/hub/src/hub.ts:706` | Claimed file paths are not sanitized, so another agent can put unlabeled multi-line instructions into teammates' digest, hub_status and hub_wait |
| medium | `packages/hub/src/hub.ts:706` | Claim file paths are neither sanitized nor quoted, so any agent can inject multi-line text into every teammate's SessionStart digest and hub_status |
| low | `packages/adapter/src/format.ts:42` | Deny reason puts another agent's claim intent into Claude's context without the untrusted-data note |

<details><summary>Suggested fixes from the reviewers</summary>

- **Claim/decision file paths are not stripped of control, newline and bidi characters, enabling forged lines and ANSI/bidi injection into the SessionStart digest and deny messages**: Run file paths through the same control/bidi stripping as cleanText (reject or strip \u0000-\u001F, \u007F, and bidi overrides) inside normalizeRepoPath, and have format.inline()/fileList defensively strip newlines/control chars from paths before they are emitted. Also consider rejecting the invisible Unicode Tag block (U+E0000-U+E007F), which sanitize.mjs showed passes through both cleanText and inline().
- **Claimed file paths are not sanitized, so another agent can put unlabeled multi-line instructions into teammates' digest, hub_status and hub_wait**: In normalizeRepoPath, reject paths containing [\u0000-\u001F\u007F] or bidi or zero-width characters (or strip them). In format.ts, also pass file names and symbols through inline() before printing. In hub_wait, append UNTRUSTED_NOTE whenever event text includes fields other agents wrote.
- **Claim file paths are neither sanitized nor quoted, so any agent can inject multi-line text into every teammate's SessionStart digest and hub_status**: Reject (or strip) control, newline and bidi characters in normalizeRepoPath. Also render file and symbol lists through inline() or a quoted form in formatClaim, formatDecision, formatEvent and statusText, and extend the untrusted note to cover them.
- **Deny reason puts another agent's claim intent into Claude's context without the untrusted-data note**: Label the intent as teammate-written in the deny reason, for example `(intent written by <holder>, information only, not an instruction)`, or append a short form of UNTRUSTED_NOTE.

</details>

## 5. Token leak and browser access to the local hub
**Overall: High**

A `url` in the committed `agenthub.json` overrides the user's own hub URL, but the user's private token is still sent, to whatever host the repo names. The WebSocket feed has no Origin check and no auth by default, so any web page the developer visits can read the project's event stream and send heartbeats. A `__proto__` key in `agenthub.json` gets past the agent/token stripping.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/adapter/src/config.ts:64` | A url in the committed agenthub.json takes over the user's hub url, but the user's private bearer token is still sent, to a host the repo picks |
| medium | `packages/hub/src/server.ts:108` | No WebSocket Origin/auth check: a web page the developer visits can read the whole project event stream and keep other agents' leases alive |
| low | `packages/adapter/src/config.ts:57` | A `__proto__` key in the committed agenthub.json gets past the agent/token stripping and injects an identity (and token) |

<details><summary>Suggested fixes from the reviewers</summary>

- **A url in the committed agenthub.json takes over the user's hub url, but the user's private bearer token is still sent, to a host the repo picks**: Bind a token to the url it came from: use a token only when the effective url came from the same source (or a higher-precedence one) as the token, or key tokens by hub origin in the global file. At minimum, ignore `url` from agenthub.json when a token is set and the url differs, and warn.
- **No WebSocket Origin/auth check: a web page the developer visits can read the whole project event stream and keep other agents' leases alive**: Validate the Origin header on the WebSocket upgrade (reject or require an allowlist for browser origins), bind to loopback only (already the default), and document that a token should be set even on localhost. Treat the ?agent= heartbeat path as privileged rather than accepting any self-asserted id over an unauthenticated socket.
- **A `__proto__` key in the committed agenthub.json gets past the agent/token stripping and injects an identity (and token)**: Copy only whitelisted keys (url, project, failClosed) from each source into a null-prototype object, e.g. `const pick = (f) => ({ url: f.url, project: f.project, ... })`, or use JSON.parse with a reviver that drops '__proto__', and never Object.assign raw parsed JSON.

</details>

## 6. Claim queue isn't first-come-first-served
**Overall: Medium**

Mutual exclusion holds, but new claims only look at active claims, not at queued waiters. Later requests overtake earlier ones, and an exclusive waiter can starve forever while shared holders (including every edit-hook claim) keep joining. Two shared holders both upgrading to exclusive deadlock with no detection. A waiter promoted from the queue gets a full TTL without any heartbeat.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/hub/src/hub.ts:135` | New claim requests ignore queued waiters, so later requests overtake earlier ones and exclusive waiters can starve forever |
| medium | `packages/hub/src/hub.ts:123` | Shared and auto (edit-hook) requests overtake an earlier queued exclusive waiter, so hub_wait on that claim can starve |
| medium | `packages/hub/src/hub.ts:123` | Direct claims ignore queued waiters, so a later request overtakes an earlier one, starving or deadlocking the queue |
| low | `packages/hub/src/hub.ts:138` | Two shared holders upgrading to exclusive (and other cross-waits) deadlock forever with no detection |
| low | `packages/hub/src/hub.ts:610` | Promotion from the queue grants a full fresh TTL without any heartbeat, so a dead waiter holds the file for up to ~2x TTL |

<details><summary>Suggested fixes from the reviewers</summary>

- **New claim requests ignore queued waiters, so later requests overtake earlier ones and exclusive waiters can starve forever**: In claim(), also load queued claims on the uncovered files (claimsForFiles(..., ['queued'])) and treat any other agent's queued claim that conflictsWith the requested mode as a blocker. Deny the request, or queue it behind those waiters, using the same rule promoteQueued uses for its waiting list.
- **Shared and auto (edit-hook) requests overtake an earlier queued exclusive waiter, so hub_wait on that claim can starve**: In claim(), include other agents' queued claims that conflict with the request in the conflict set: deny the request, or queue it behind them, the same way promoteQueued's 'waiting' list already does.
- **Direct claims ignore queued waiters, so a later request overtakes an earlier one, starving or deadlocking the queue**: In claim(), treat earlier queued claims on the requested files as conflicts. A non-queued request is then denied, and a queued one is placed behind them. promoteQueued already uses the same rule through its `waiting` list. Add tests with a direct or auto claim arriving while a waiter is queued, including the shared case and the multi-file case.
- **Two shared holders upgrading to exclusive (and other cross-waits) deadlock forever with no detection**: Refuse (deny instead of queue) an upgrade when another holder of the same file already has a pending upgrade, or check for a wait-for cycle when queueing and return a deadlock error.
- **Promotion from the queue grants a full fresh TTL without any heartbeat, so a dead waiter holds the file for up to ~2x TTL**: On promotion keep the waiter's current expires_at (its last renewal plus TTL), or use max(q.expires_at, now + a short grace), so only a real heartbeat or request extends the lease.

</details>

## 7. Claims that never get released
**Overall: Medium**

`land` releases only claims tagged with that task. Claims the edit hook made before `task_take`, or while two tasks were open, stay held, and MCP heartbeats keep them alive while the output says they were released. The hook claims before Claude's permission check, so a rejected edit still leaves a claim. Git-ignored per-worktree files like `.env` are claimed by repo path, so agents block each other on their own private copies. Some `release` argument combinations release nothing or the wrong thing.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/hub/src/hub.ts:452` | land {task_id} leaves untagged claims held; the MCP heartbeats keep them alive indefinitely while the output says they were released |
| low | `packages/hub/src/hub.ts:452` | land(task_id) releases only claims tagged with that task; claims made before task_take, renewed claims, or claims made while two tasks are in progress stay held indefinitely |
| low | `packages/hub/src/hub.ts:452` | land(task_id) leaves claims the edit hook made before task_take, so the landed files stay blocked for the rest of the session |
| low | `packages/adapter/src/hooks.ts:76` | Hook claims the file before permission checks run, so a rejected or rule-denied edit still leaves an exclusive claim that MCP heartbeats keep alive for the whole session |
| low | `packages/adapter/src/hooks.ts:72` | The edit hook claims git-ignored, per-worktree files by repo path, so an agent is denied when editing its own copy of e.g. .env |
| low | `packages/hub/src/hub.ts:221` | release({all:true, files:[]}) or release({task_id, files:[]}) silently releases nothing |
| low | `packages/hub/src/hub.ts:227` | release with claim_id plus files drops the whole claim, against the tool's documented by-files behavior |

<details><summary>Suggested fixes from the reviewers</summary>

- **land(task_id) releases only claims tagged with that task; claims made before task_take, renewed claims, or claims made while two tasks are in progress stay held indefinitely**: Attach or refresh task_id on the covering claims when a claim is renewed while the agent has a single in-progress task, and assign the agent's untagged claims to a task when it is taken. Alternatively, when landing a task, also release the agent's claims whose task_id is null (or all of its claims), and report any claims that remain held.
- **land {task_id} leaves untagged claims held; the MCP heartbeats keep them alive indefinitely while the output says they were released**: When a task is taken, attach the agent's untagged active claims to it. Alternatively, have land with the agent's only in-progress task also release its untagged claims. Print the 'claims are released' sentence only when released.length > 0, and list the claims that are still held.
- **land(task_id) leaves claims the edit hook made before task_take, so the landed files stay blocked for the rest of the session**: On takeTask, attach the agent's task-less active claims to the task. Alternatively, when a claim is renewed through the covering path and the agent has exactly one in-progress task, set its task_id.
- **Hook claims the file before permission checks run, so a rejected or rule-denied edit still leaves an exclusive claim that MCP heartbeats keep alive for the whole session**: Add a PostToolUseFailure / PermissionDenied hook (or have the next pre-edit run reconcile) that releases claims the hook itself created for a tool call that didn't run, tracked by tool_use_id. Or don't renew hook-created claims from heartbeats until the edit is confirmed.
- **The edit hook claims git-ignored, per-worktree files by repo path, so an agent is denied when editing its own copy of e.g. .env**: In preEditHook, skip claiming paths that `git check-ignore -q` reports as ignored, as is already done for files outside the repo and inside .git.
- **release({all:true, files:[]}) or release({task_id, files:[]}) silently releases nothing**: Treat an empty files array as undefined (`const files = req.files?.length ? ... : undefined`) both in the release() guard and in the target filter.
- **release with claim_id plus files drops the whole claim, against the tool's documented by-files behavior**: When claim_id and files are both given, trim that one claim to the remaining files. Otherwise make the schema and hub reject the combination with a clear error.

</details>

## 8. Task dependencies can be bypassed
**Overall: Medium**

`land` or a task update to done completes a blocked, never-taken or cancelled task, which unblocks its dependents early.

| Severity | Where | Finding |
|---|---|---|
| low | `packages/hub/src/hub.ts:424` | land (and task update to done) completes a blocked, never-taken or cancelled task, which breaks dependency ordering |
| low | `packages/hub/src/hub.ts:429` | A task blocked by unfinished dependencies can be completed (and owned) through land or task update, unblocking its dependents early |

<details><summary>Suggested fixes from the reviewers</summary>

- **land (and task update to done) completes a blocked, never-taken or cancelled task, which breaks dependency ordering**: In land() and updateTask('done'), throw task_blocked when blockedBy(task) is non-empty. Refuse cancelled-to-done without a reopen first. Require the task to be in_progress and owned by the caller (or take it implicitly, which runs the blocked check).
- **A task blocked by unfinished dependencies can be completed (and owned) through land or task update, unblocking its dependents early**: In land() and updateTask(status='done'), reject with task_blocked when blockedBy(task) is non-empty, or at least when the caller doesn't own an in-progress task. announceUnblocked should also count only dependents whose whole dependency chain is done.

</details>

## 9. Live agents can lose leases or miss events
**Overall: Medium**

A half-open WebSocket is never detected, so heartbeats go into a dead socket and a live agent's claims expire, and lease loss is silent. The heartbeat loop ignores the server's interval, and the hub accepts a heartbeat interval at or above the TTL. Reconnect replay and HTTP long-polling stop at 500 events, so events get lost and `hub_wait` sleeps until it times out. After a hub restart on a fresh database, feeds stay connected but deaf. With several hub processes on one DB, events only reach the process that made the change.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/adapter/src/feed.ts:157` | Feed never notices a half-open WebSocket: heartbeats go into a dead socket indefinitely, never switch to HTTP, and a live agent's active and queued claims expire |
| medium | `packages/hub/src/hub.ts:88` | heartbeat interval >= lease TTL is accepted and announced to adapters, so live sessions lose their leases between heartbeats |
| low | `packages/adapter/src/feed.ts:128` | Lease loss is completely silent: heartbeat.ack renewed counts and the agent's own claim.expired events are ignored, and a socket that dies after open produces no log line |
| low | `packages/adapter/src/feed.ts:122` | The heartbeat loop ignores next_heartbeat_ms and per-claim intervals, so leases with a shorter TTL expire while the MCP server runs |
| low | `packages/hub/src/hub.ts:88` | hub-server accepts a heartbeat interval at or above the lease TTL, the Feed adopts it from hello, and every claim expires between heartbeats while the agent is alive |
| low | `packages/hub/src/server.ts:143` | Feed reconnect replay loses events: only one 500-event page is replayed, and a restarted event log is never detected |
| low | `packages/hub/src/server.ts:144` | After 500 or more invisible events, a WS reconnect replays nothing, so even one event committed during a short socket drop is lost and hub_wait over WS times out |
| low | `packages/hub/src/server.ts:144` | Reconnect replay stops at 500 events, and the events after that are never delivered |
| low | `packages/hub/src/hub.ts:495` | HTTP long-poll cursor can't get past 500 invisible events, so hub_wait over the HTTP fallback misses releases and grants until it times out |
| low | `packages/hub/src/server.ts:273` | GET /events?types= filters after the 500-row page, so matching events behind 500 non-matching visible events are never returned |
| low | `packages/adapter/src/feed.ts:121` | After the hub restarts on a fresh DB, a long-running Feed keeps its old lastSeq and buffer: new events are dropped and stale ones cause false wake-ups |
| low | `packages/adapter/src/feed.ts:121` | After the hub restarts on a fresh database, the feed stays 'connected' but deaf, and hub_wait returns stale events from the old hub |
| low | `packages/hub/src/hub.ts:527` | With several hub processes on one DB, events (queue grants, releases, expiries, messages) reach only the process that made the change, so hub_wait on another process sleeps until its timeout |
| low | `packages/hub/src/server.ts:136` | With several hub processes on one DB, WebSocket feeds silently and permanently skip events committed by the other process |
| low | `packages/hub/src/server.ts:286` | Long-poll wake and WS push only fire for events committed in the same hub process, so with two hub processes on one DB, hub_wait misses the other process's releases |
| low | `packages/hub/src/server.ts:141` | With several hub processes on one DB file, events committed by another process are never pushed, so hub_wait sleeps through releases and expiries |

<details><summary>Suggested fixes from the reviewers</summary>

- **Feed never notices a half-open WebSocket: heartbeats go into a dead socket indefinitely, never switch to HTTP, and a live agent's active and queued claims expire**: Treat a WS heartbeat as delivered only once its heartbeat.ack arrives. If no ack, or no frame at all, arrives within a deadline well under the TTL (e.g. min(heartbeatMs, ttl/3)), terminate() the socket, send that heartbeat over HTTP right away, and reconnect. Also add a client-side ws.ping() with a pong deadline. In waitFor, race the buffer against a periodic HTTP re-check (or the long-poll) so hub_wait does not depend only on the socket.
- **Lease loss is completely silent: heartbeat.ack renewed counts and the agent's own claim.expired events are ignored, and a socket that dies after open produces no log line**: Handle heartbeat.ack: when `renewed` drops, or a claim.expired event names this agent as holder, log to stderr and attach a notice to the next MCP tool result (or send an MCP logging notification), e.g. 'your claim C-1 on src/auth.ts expired; re-claim it'. Optionally re-claim automatically. Log on every unexpected 'close', not only after an 'error'.
- **The heartbeat loop ignores next_heartbeat_ms and per-claim intervals, so leases with a shorter TTL expire while the MCP server runs**: Handle 'heartbeat.ack' and the HTTP HeartbeatResult: set heartbeatMs = min(announced, next_heartbeat_ms) unless it is fixed. In Hub/cli, clamp heartbeatIntervalMs to at most leaseTtlMs/3.
- **heartbeat interval >= lease TTL is accepted and announced to adapters, so live sessions lose their leases between heartbeats**: Reject the configuration (or clamp the heartbeat to at most ttl/3) when heartbeatIntervalMs is not finite, is < 1, or is >= leaseTtlMs. Also have the Feed honour heartbeat.ack.next_heartbeat_ms, or the smallest per-claim interval.
- **hub-server accepts a heartbeat interval at or above the lease TTL, the Feed adopts it from hello, and every claim expires between heartbeats while the agent is alive**: In the Hub constructor, clamp heartbeatIntervalMs to at most floor(leaseTtlMs/3), or reject the setting in cli.ts. In the Feed, honor next_heartbeat_ms from heartbeat.ack (and HTTP HeartbeatResult).
- **Feed reconnect replay loses events: only one 500-event page is replayed, and a restarted event log is never detected**: Server: in onFeed, page through hub.events until a page is shorter than the limit. Client: on hello, if frame.seq < lastSeq, set lastSeq = frame.seq and clear the buffer.
- **After 500 or more invisible events, a WS reconnect replays nothing, so even one event committed during a short socket drop is lost and hub_wait over WS times out**: Loop the replay until caught up: page from the last scanned seq, not the last delivered one, until latestSeq. Also tell the client the scanned-to position, either a hello `replayed_to` or a cursor frame, so Feed.lastSeq can move past invisible events. Alternatively, have the server send a `cursor` frame after replay.
- **Reconnect replay stops at 500 events, and the events after that are never delivered**: Page through hub.events() until the replay catches up with latestSeq before switching to live delivery. Alternatively, send a 'gap' frame so the client can resync over HTTP (client.events loops correctly with a cursor).
- **HTTP long-poll cursor can't get past 500 invisible events, so hub_wait over the HTTP fallback misses releases and grants until it times out**: Make the scan cursor explicit. Have Hub.events keep fetching pages until it collects at least one visible event or reaches latestSeq, or push the visibility test into SQL (for example a targets side table, or json_each over targets). Have it return the last scanned seq as well. longPollEvents should return `seq` = last scanned seq, not latestSeq. On wake it should re-scan from that position, not from the original `since`. Feed.longPoll should then set cursor = max(cursor, resp.seq).
- **GET /events?types= filters after the 500-row page, so matching events behind 500 non-matching visible events are never returned**: Apply the type filter during the paged scan (or in SQL with `type IN (...)`), and return the scanned-to seq as the cursor.
- **After the hub restarts on a fresh DB, a long-running Feed keeps its old lastSeq and buffer: new events are dropped and stale ones cause false wake-ups**: In the hello handler: if frame.seq < this.lastSeq, treat it as a reset, setting lastSeq = frame.seq and clearing the buffer. On the server, clamp `since` to latestSeq in onFeed. A per-database epoch id in hello would make this explicit.
- **After the hub restarts on a fresh database, the feed stays 'connected' but deaf, and hub_wait returns stale events from the old hub**: In the hello handler, if frame.seq < lastSeq, the hub's history was reset: set lastSeq = frame.seq, clear the buffer and wake the waiters. On the server, use lastSent = Math.min(since, latestSeq). Optionally have hello carry a hub/DB instance id so clients can detect a reset.
- **With several hub processes on one DB, events (queue grants, releases, expiries, messages) reach only the process that made the change, so hub_wait on another process sleeps until its timeout**: Have each process tail the events table (for example, poll MAX(seq) per project on the sweeper tick and publish rows above the last delivered seq), or document that one DB file supports only one serving process.
- **With several hub processes on one DB, WebSocket feeds silently and permanently skip events committed by the other process**: Have each server poll the shared event log (store.eventsSince from its last delivered seq) on the sweeper tick, and push or wake long-polls from that log instead of only from in-process listeners. Alternatively, document that the feed requires a single hub process.
- **Long-poll wake and WS push only fire for events committed in the same hub process, so with two hub processes on one DB, hub_wait misses the other process's releases**: Either document event delivery as single-process only, or have each process poll the events table for seq > its last published seq (for example in the 1 s sweeper tick) and publish rows that other processes committed to its local listeners.
- **With several hub processes on one DB file, events committed by another process are never pushed, so hub_wait sleeps through releases and expiries**: Have each process deliver events it did not publish itself, e.g. on every sweeper tick read events with seq > the last delivered one from the store and publish them to the local subscribers. Otherwise, document that push and hub_wait need a single hub process.

</details>

## 10. Hub server settings aren't validated
**Overall: Medium**

A lease TTL of 0, a negative value or whitespace is accepted and turns off mutual exclusion. A tiny TTL makes adapters flood the hub. An infinite TTL means leases never expire. Port parsing accepts whitespace and crashes on text.

| Severity | Where | Finding |
|---|---|---|
| low | `packages/hub/src/hub.ts:87` | --lease-ttl-ms 0, a negative value, or whitespace is accepted and silently turns off mutual exclusion |
| low | `packages/hub/src/hub.ts:89` | A tiny or zero TTL derives a 1 ms heartbeat and a 0 ms presence window, so every adapter floods the hub with heartbeats and agent.online events |
| low | `packages/hub/src/hub.ts:752` | An infinite or huge server TTL skips the [1, DAY_MS] bound, so leases never expire and a crashed agent holds files forever |
| low | `packages/hub/src/cli.ts:47` | --port or HUB_PORT set to whitespace silently binds a random port; '--port abc' crashes with a raw stack trace |

<details><summary>Suggested fixes from the reviewers</summary>

- **--lease-ttl-ms 0, a negative value, or whitespace is accepted and silently turns off mutual exclusion**: Validate in the Hub constructor, or in cli.ts, that leaseTtlMs is a finite integer within [some sane minimum such as 1000, DAY_MS], and refuse to start otherwise. In num(), trim the value and reject strings that are not purely numeric.
- **A tiny or zero TTL derives a 1 ms heartbeat and a 0 ms presence window, so every adapter floods the hub with heartbeats and agent.online events**: Bound heartbeatIntervalMs (for example >= 1000 ms) and leaseTtlMs at startup, and keep presenceTtlMs at least a few heartbeat intervals. In the Feed, ignore announced intervals below a sane floor.
- **An infinite or huge server TTL skips the [1, DAY_MS] bound, so leases never expire and a crashed agent holds files forever**: Apply the same [min, DAY_MS] bounds, and Number.isFinite, to leaseTtlMs in the constructor (or clamp the fallback inside clampInt), and refuse to start on values out of range.
- **--port or HUB_PORT set to whitespace silently binds a random port; '--port abc' crashes with a raw stack trace**: Parse the port strictly as an integer in [0, 65535] (allowing 0 only if explicitly intended), trim input, and exit with a clear message naming the bad option.

</details>

## 11. `hub init` and the guard break normal git setups
**Overall: Medium**

With husky, `hub init` renames husky's dispatcher, so the project's real pre-commit hook stops running, and the next husky install deletes the guard. It writes into whatever `core.hooksPath` points at, including a global one, which turns the guard on for every repo on the machine. Re-running with a different `--command` adds duplicate hooks. During a merge the guard blocks the holder's own merged-in changes, and following its advice reverts their work.

| Severity | Where | Finding |
|---|---|---|
| medium | `packages/adapter/src/init.ts:109` | With husky (core.hooksPath=.husky/_), `hub init` renames husky's dispatcher stub, so the project's real pre-commit hook silently stops running, and the next husky install deletes the guard |
| medium | `packages/adapter/src/init.ts:99` | `hub init` writes into whatever core.hooksPath points at: a global hooksPath turns the guard on for every repo on the machine, and a tracked .githooks dir has its team hook rewritten |
| medium | `packages/adapter/src/git.ts:77` | During a merge the guard blocks the holder's own merged-in changes, and following its advice ('git restore --staged') produces a merge that silently reverts the holder's work |
| low | `packages/adapter/src/init.ts:145` | Re-running `hub init` with a different --command keeps the old hook entries, so pre-edit and digest hooks run twice |

<details><summary>Suggested fixes from the reviewers</summary>

- **With husky (core.hooksPath=.husky/_), `hub init` renames husky's dispatcher stub, so the project's real pre-commit hook silently stops running, and the next husky install deletes the guard**: Detect core.hooksPath and hook managers (husky, lefthook, pre-commit). For husky, add `hub guard` to .husky/pre-commit, or print instructions, instead of editing .husky/_. When chaining, call the original hook with the original name visible (for example, keep it in place and wrap it, or set $0 via `exec -a` or copy it to a subdirectory named pre-commit) rather than renaming it.
- **`hub init` writes into whatever core.hooksPath points at: a global hooksPath turns the guard on for every repo on the machine, and a tracked .githooks dir has its team hook rewritten**: If core.hooksPath is set, especially from global or system scope, or points inside the work tree, refuse to modify it automatically. Print instructions for adding `hub guard` to the existing hook, or require an explicit flag.
- **Re-running `hub init` with a different --command keeps the old hook entries, so pre-edit and digest hooks run twice**: Spot agenthub's own entries by a stable suffix (`hook pre-edit` / `hook digest`) or a marker, and replace them instead of appending.
- **During a merge the guard blocks the holder's own merged-in changes, and following its advice ('git restore --staged') produces a merge that silently reverts the holder's work**: When MERGE_HEAD (or CHERRY_PICK_HEAD or REVERT_HEAD) exists, check only paths whose staged content differs from every parent (for example, `git diff --cached` against each parent, intersected), or skip files whose staged blob equals the other parent's. Never suggest `git restore --staged` during a merge.

</details>
