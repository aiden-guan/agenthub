import type { CheckResult } from '@agenthub/hub/protocol';
import { DEFAULT_REF_PREFIX } from '@agenthub/contract';
import { lendIdentity, lendingSessions } from './checkout.js';
import { HubClient, classifyFailure } from './client.js';
import { loadConfig, teamSections, type HubConfig } from './config.js';
import { INTENTS_NOTE, inline, minutesLeft, showName } from './format.js';
import { findRepoRoot, mergeHeads, stagedPaths, unclaimableReason } from './git.js';
import type { HookOutcome } from './hooks.js';

const BYPASS = 'Emergency bypass: git commit --no-verify, or HUB_GUARD=off.';
const SEQUENCER_BYPASS = 'Emergency bypass: run the git command again with HUB_GUARD=off (git commit --no-verify does not skip this check in a revert, cherry-pick or rebase).';
const MERGE_BYPASS = 'Emergency bypass: git merge --no-verify, or HUB_GUARD=off.';
const blocked = (msg: string): HookOutcome => ({ stdout: '', stderr: `hub guard: ${msg}\n`, exitCode: 1 });

/**
 * `hub guard` — git pre-commit hook. Rejects the commit when a staged file
 * (added, modified, deleted or renamed) is exclusively claimed by another
 * agent. Shared claims don't block. Works for agents without edit hooks.
 * Only an unreachable (or broken, 5xx) hub lets the commit through unchecked,
 * with a warning, unless fail-closed is configured. A refusal, an auth error,
 * a config error or a git failure blocks it. `sequencer`: called from
 * prepare-commit-msg for a commit git revert, cherry-pick or rebase makes, or
 * from pre-applypatch for one git am makes, neither of which runs pre-commit.
 * `merge`: called from pre-merge-commit, for a merge git commits itself. A
 * merge commit is checked for what it changes itself (see stagedPaths), not
 * for the other branches' changes it brings in as they are.
 */
export async function guard(io: { cwd: string; env: NodeJS.ProcessEnv; sequencer?: boolean; merge?: boolean }): Promise<HookOutcome> {
  if (io.env.HUB_GUARD === 'off') return { stdout: '', stderr: '', exitCode: 0 };
  const bypass = io.sequencer ? SEQUENCER_BYPASS : io.merge ? MERGE_BYPASS : BYPASS;
  let cfg: HubConfig;
  try {
    cfg = loadConfig({ cwd: io.cwd, env: io.env });
  } catch (err) {
    return blocked((err as Error).message);
  }
  const root = cfg.root;
  if (!root) return { stdout: '', stderr: '', exitCode: 0 };
  // A checkout with no identity of its own (a worktree Claude Code made under .claude/worktrees)
  // is the session's that edits in it, as for the edit hook: its own claims don't block it.
  cfg = lendIdentity(cfg, io.env, [io.env.CLAUDE_PROJECT_DIR, ...lendingSessions(root, io.env.CLAUDE_CODE_SESSION_ID)]);
  const notes = [...cfg.warnings];
  if (cfg.projectSource === 'derived') {
    notes.push(
      `no agenthub.json in this checkout and no project recorded for the repository, so claims were checked in project "${cfg.project}", derived from the repository. ` +
        'If your team uses another project id, run `hub init` in a checkout that has agenthub.json.',
    );
  }
  const withNotes = (out: HookOutcome, shown?: string): HookOutcome => ({
    ...out,
    stderr: out.stderr + notes.filter((n) => n !== shown).map((n) => `hub guard: warning: ${n}\n`).join(''),
  });

  let files: string[];
  let merging: string[];
  try {
    merging = mergeHeads(root, io.env);
    // Without the merged commits, the changes a merge brings in would all count as this commit's.
    if (io.merge && merging.length === 0) return { stdout: '', stderr: 'hub guard: warning: could not tell which commits this merge brings in; claims not checked\n', exitCode: 0 };
    files = stagedPaths(root, merging);
  } catch (err) {
    return blocked(`could not list the staged files (${(err as Error).message}); commit blocked. ${bypass}`);
  }
  // A name the hub refuses can't be claimed by anyone, so it can't conflict: check the rest, and say so.
  const unclaimable = files.filter((f) => unclaimableReason(f) !== null);
  if (unclaimable.length) {
    const shown = unclaimable.slice(0, 5).map((f) => `${showName(f)} (${unclaimableReason(f)})`);
    if (unclaimable.length > 5) shown.push(`${unclaimable.length - 5} more`);
    notes.push(`not checked, as the hub can't hold a claim on ${unclaimable.length === 1 ? 'it' : 'them'} and no agent can claim ${unclaimable.length === 1 ? 'it' : 'them'}: ${shown.join(', ')}`);
    files = files.filter((f) => unclaimableReason(f) === null);
  }
  if (files.length === 0) return withNotes({ stdout: '', stderr: '', exitCode: 0 });

  let res: CheckResult;
  try {
    res = await new HubClient(cfg).check(files);
  } catch (err) {
    const failure = classifyFailure(err, cfg);
    // An auth error's message already says why the token was withheld.
    if (failure.kind !== 'unreachable') return withNotes(blocked(`${failure.message}; commit blocked. ${bypass}`), failure.kind === 'auth' ? cfg.tokenWithheld : undefined);
    if (cfg.failClosed) return withNotes(blocked(`${failure.message}; commit blocked (HUB_FAIL_CLOSED)`));
    return withNotes({ stdout: '', stderr: `hub guard: ${failure.message}; claims not checked\n`, exitCode: 0 });
  }
  if (res.conflicts.length === 0) return withNotes({ stdout: '', stderr: '', exitCode: 0 });

  const holders = cfg.agent ? 'other agents' : 'agents (this checkout has no agent identity)';
  const lines = [`hub guard: commit blocked. ${merging.length ? 'This merge changes files' : 'These staged files are'} exclusively claimed by ${holders}:`];
  for (const c of res.conflicts) {
    for (const f of c.files) {
      lines.push(`  ${showName(f)} — claimed by ${c.holder} (${c.claim_id}) to "${inline(c.intent)}" (expires in ${minutesLeft(c.expires_at, res.now)} min)`);
    }
  }
  lines.push(
    INTENTS_NOTE,
    io.sequencer
      ? 'Undo the operation (git reset --merge, or git rebase --abort / git am --abort if one is in progress), coordinate with the holder (hub_post), or wait for the claim to be released (hub_wait).'
      : merging.length
        ? "It doesn't keep them as the merged branches have them (a conflict resolved against the holder's change, both sides' changes combined, or an edit). " +
          'Undo it (git merge --abort), coordinate with the holder (hub_post), or wait for the claim to be released (hub_wait).'
        : 'Unstage them (git restore --staged <file>), coordinate with the holder (hub_post), or wait for the claim to be released (hub_wait).',
    bypass,
  );
  return withNotes({ stdout: '', stderr: `${lines.join('\n')}\n`, exitCode: 1 });
}

/**
 * `hub guard --pre-push` — git pre-push hook (design §2.3.6). git passes the
 * remote's name and URL as arguments and one line per ref on stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`. With a landing queue
 * (a land section in trunk's agenthub.json), it refuses any update of
 * `refs/heads/<trunk>`, deletion included, and of the lander's candidate refs
 * (`<P>cand/…`); land refs and every other ref go through. A speed bump: the
 * real enforcement is the host rule that only the lander may update trunk.
 * HUB_GUARD=off bypasses it.
 */
export function prePushGuard(io: { cwd: string; env: NodeJS.ProcessEnv; stdin: string }): HookOutcome {
  const pass: HookOutcome = { stdout: '', stderr: '', exitCode: 0 };
  if (io.env.HUB_GUARD === 'off') return pass;
  const root = findRepoRoot(io.cwd);
  if (!root) return pass;
  const land = teamSections(root, { strict: false }).sections.land;
  if (!land) return pass;
  const trunkRef = `refs/heads/${land.trunk}`;
  const candPrefixes = [...new Set([`${land.refPrefix}cand/`, `${DEFAULT_REF_PREFIX}cand/`])];
  const trunk: string[] = [];
  const cand: string[] = [];
  for (const line of io.stdin.split('\n')) {
    const remoteRef = line.trim().split(/\s+/)[2];
    if (!remoteRef) continue;
    if (remoteRef === trunkRef) trunk.push(remoteRef);
    else if (candPrefixes.some((p) => remoteRef.startsWith(p))) cand.push(remoteRef);
  }
  if (!trunk.length && !cand.length) return pass;
  const lines: string[] = [];
  if (trunk.length) {
    lines.push(`hub guard: push blocked: ${land.trunk} is updated only by the landing queue. Call land (MCP) or \`hub land\`. Emergency bypass: HUB_GUARD=off.`);
    lines.push(...[...new Set(trunk)].map((r) => `  ${showName(r)}`));
  }
  if (cand.length) {
    lines.push(`hub guard: push blocked: candidate refs (${land.refPrefix}cand/…) are written only by the lander. Emergency bypass: HUB_GUARD=off.`);
    lines.push(...[...new Set(cand)].map((r) => `  ${showName(r)}`));
  }
  return { stdout: '', stderr: `${lines.join('\n')}\n`, exitCode: 1 };
}
