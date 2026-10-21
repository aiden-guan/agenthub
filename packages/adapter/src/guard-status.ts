import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

/** Marks the git hook scripts `hub init` writes. */
export const GUARD_MARKER = '# agenthub-guard';
/** In the repository's git dir: the guard hooks, for hooks hub init can't put the guard in to call. */
export const CALLED_HOOKS_DIR = 'agenthub-hooks';

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Null when git runs the commit guard in the checkout at `root` (or `hub init
 * --no-guard` said not to install it); otherwise why it doesn't, for the
 * digest and `hub whoami`. A hook manager can take the guard out without a
 * word (husky rewrites .husky/_ on every install), and agents whose edits
 * bypass the edit hook rely on it, so the off state must not go unnoticed.
 */
export function commitGuardOff(root: string): string | null {
  if (git(root, ['config', '--get', 'agenthub.guard']) === 'off') return null;
  const runs = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (!runs) return null;
  const hook = path.join(runs, 'pre-commit');
  const text = readText(hook);
  const callsGuard = (t: string | null) => !!t && (t.includes(GUARD_MARKER) || t.includes(CALLED_HOOKS_DIR));
  if (callsGuard(text)) return null;
  // A hook manager's stub that runs a file of its own name one directory up (husky's .husky/_/pre-commit
  // runs .husky/pre-commit), which may have the line hub init prints.
  if (callsGuard(readText(path.join(path.dirname(runs), 'pre-commit')))) return null;
  return (
    `the commit guard is off in this checkout: ${text !== null ? `git runs ${hook} before each commit, and it doesn't call the guard` : `git runs no pre-commit hook (there is no ${hook})`}, ` +
    "so a commit that touches files other agents hold exclusively isn't checked. Run `hub init` here; if it can't put the guard where git runs it, add the line it prints to that hook."
  );
}
