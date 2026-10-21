import type { CheckResult } from '@agenthub/hub/protocol';
import { HubClient, classifyFailure } from './client.js';
import { loadConfig, type HubConfig } from './config.js';
import { INTENTS_NOTE, inline, minutesLeft } from './format.js';
import { mergeHeads, stagedPaths } from './git.js';
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
  if (!cfg.root) return { stdout: '', stderr: '', exitCode: 0 };
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
    merging = mergeHeads(cfg.root, io.env);
    // Without the merged commits, the changes a merge brings in would all count as this commit's.
    if (io.merge && merging.length === 0) return { stdout: '', stderr: 'hub guard: warning: could not tell which commits this merge brings in; claims not checked\n', exitCode: 0 };
    files = stagedPaths(cfg.root, merging);
  } catch (err) {
    return blocked(`could not list the staged files (${(err as Error).message}); commit blocked. ${bypass}`);
  }
  if (files.length === 0) return { stdout: '', stderr: '', exitCode: 0 };

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
      lines.push(`  ${f} — claimed by ${c.holder} (${c.claim_id}) to "${inline(c.intent)}" (expires in ${minutesLeft(c.expires_at, res.now)} min)`);
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
