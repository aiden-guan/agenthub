import { HubClient } from './client.js';
import { loadConfig, type HubConfig } from './config.js';
import { inline, minutesLeft } from './format.js';
import { stagedPaths } from './git.js';
import type { HookOutcome } from './hooks.js';

/**
 * `hub guard` — git pre-commit hook. Rejects the commit when a staged file
 * (added, modified, deleted or renamed) is exclusively claimed by another
 * agent. Shared claims don't block. Works for agents without edit hooks.
 */
export async function guard(io: { cwd: string; env: NodeJS.ProcessEnv }): Promise<HookOutcome> {
  if (io.env.HUB_GUARD === 'off') return { stdout: '', stderr: '', exitCode: 0 };
  let cfg: HubConfig;
  try {
    cfg = loadConfig({ cwd: io.cwd, env: io.env });
  } catch (err) {
    return { stdout: '', stderr: `hub guard: ${(err as Error).message}\n`, exitCode: 1 };
  }
  if (!cfg.root) return { stdout: '', stderr: '', exitCode: 0 };
  const files = stagedPaths(cfg.root);
  if (files.length === 0) return { stdout: '', stderr: '', exitCode: 0 };

  let res;
  try {
    res = await new HubClient(cfg).check(files);
  } catch (err) {
    const msg = (err as Error).message;
    if (cfg.failClosed) return { stdout: '', stderr: `hub guard: ${msg}; commit blocked (HUB_FAIL_CLOSED)\n`, exitCode: 1 };
    return { stdout: '', stderr: `hub guard: ${msg}; claims not checked\n`, exitCode: 0 };
  }
  if (res.conflicts.length === 0) return { stdout: '', stderr: '', exitCode: 0 };

  const lines = [`hub guard: commit blocked. These staged files are exclusively claimed by ${cfg.agent ? 'other agents' : 'agents (this checkout has no agent identity)'}:`];
  for (const c of res.conflicts) {
    for (const f of c.files) {
      lines.push(`  ${f} — claimed by ${c.holder} (${c.claim_id}) to "${inline(c.intent)}" (expires in ${minutesLeft(c.expires_at, res.now)} min)`);
    }
  }
  lines.push(
    'Unstage them (git restore --staged <file>), coordinate with the holder (hub_post), or wait for the claim to be released (hub_wait).',
    'Emergency bypass: git commit --no-verify, or HUB_GUARD=off.',
  );
  return { stdout: '', stderr: `${lines.join('\n')}\n`, exitCode: 1 };
}
