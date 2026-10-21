// The git runner (design §2.2.2). Every gitops call goes through a Git made
// by open(): the lander's are isolated (no global or system config, no hooks,
// no prompts), the adapter's use the user's own git setup.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Git, GitResult, OpenOptions, RunOptions } from './types.js';

/** A git command that exited with a code its caller did not accept, or timed out. */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
    readonly timedOut = false,
  ) {
    const what = redactUrls(`git ${args.join(' ')}`).slice(0, 200);
    super(timedOut ? `${what} timed out` : `${what} exited ${code}: ${redactUrls(firstLine(stderr)) || '(no message)'}`);
    this.name = 'GitError';
  }
}

/** Isolation env (design §2.2.2). Every inherited GIT_* variable is dropped first. */
const ISOLATION_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  HUB_GUARD: 'off',
};

/** Isolation config, passed as `-c` before every command. */
const ISOLATION_CONFIG: Record<string, string> = {
  'core.hooksPath': '/dev/null',
  'gc.auto': '0',
  'merge.conflictStyle': 'diff3',
};

/** git's own lock failure (`Unable to create '….lock': File exists`), from this side only (not a `remote:` line). */
const LOCK_ERROR_RE = /^(?:error|fatal): .*Unable to create '[^'\n]*\.lock'/m;
const LOCK_RETRIES = 3;

export function open(dir: string, o: OpenOptions): Git {
  const bare = o.bare ?? (!existsSync(path.join(dir, '.git')) && existsSync(path.join(dir, 'HEAD')) && existsSync(path.join(dir, 'objects')));
  return new GitRepo(path.resolve(dir), bare, o.isolated, { ...(o.env ?? {}) }, {});
}

class GitRepo implements Git {
  constructor(
    readonly dir: string,
    readonly bare: boolean,
    private readonly isolated: boolean,
    private readonly env: Record<string, string>,
    private readonly config: Record<string, string>,
  ) {}

  with(config: Record<string, string>): Git {
    for (const [k, v] of Object.entries(config)) {
      // `-c key=value`: the key can't hold '=' or whitespace, and neither can span lines.
      if (!/^[A-Za-z0-9][^=\s\0]*\.[A-Za-z0-9-]+$/.test(k) || /[\n\r\0]/.test(v)) throw new Error(`gitops: bad config ${JSON.stringify(k)}`);
    }
    return new GitRepo(this.dir, this.bare, this.isolated, this.env, { ...this.config, ...config });
  }

  async run(args: string[], o: RunOptions = {}): Promise<GitResult> {
    const full = [...this.globalArgs(), ...this.subcommandArgs(args)];
    const env = this.childEnv(o.env);
    const ok = o.ok ?? [0];
    for (let attempt = 0; ; attempt++) {
      const r = await spawnGit(full, { cwd: this.dir, env, input: o.input, timeoutMs: o.timeoutMs });
      if (r.timedOut) throw new GitError(args, r.code, r.stdout, r.stderr, true);
      if (ok.includes(r.code)) return { code: r.code, stdout: r.stdout, stderr: r.stderr };
      if (attempt < LOCK_RETRIES && LOCK_ERROR_RE.test(r.stderr)) {
        // Concurrent loops (admission, attempt) can collide on a ref lock: back off with jitter.
        await sleep((attempt + 1) * (40 + Math.floor(Math.random() * 120)));
        continue;
      }
      throw new GitError(args, r.code, r.stdout, r.stderr);
    }
  }

  /** `--git-dir` for a bare mirror, the caller's `-c`, then isolation's, which come last so nothing overrides them. */
  private globalArgs(): string[] {
    const out: string[] = this.bare ? [`--git-dir=${this.dir}`] : [];
    for (const [k, v] of Object.entries(this.config)) out.push('-c', `${k}=${v}`);
    if (this.isolated) for (const [k, v] of Object.entries(ISOLATION_CONFIG)) out.push('-c', `${k}=${v}`);
    return out;
  }

  /** An isolated fetch never writes FETCH_HEAD (design §2.2.2): the loops share the mirror. */
  private subcommandArgs(args: string[]): string[] {
    if (!this.isolated || args.includes('--no-write-fetch-head')) return args;
    let i = 0;
    // Skip global options (and the values of -c / -C) to find the subcommand.
    while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-c' || args[i] === '-C' ? 2 : 1;
    if (args[i] !== 'fetch') return args;
    return [...args.slice(0, i + 1), '--no-write-fetch-head', ...args.slice(i + 1)];
  }

  private childEnv(extra: Record<string, string> | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (this.isolated && k.startsWith('GIT_')) continue;
      env[k] = v;
    }
    // gitops parses git's messages (merge-tree types, push statuses): keep them git's own English ones.
    env.LC_ALL = 'C';
    Object.assign(env, this.env, extra ?? {});
    // Isolation is applied last: no caller env can undo it.
    return this.isolated ? Object.assign(env, ISOLATION_ENV) : env;
  }
}

interface Spawned {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn git. With a timeout, git runs in its own process group, so the whole
 * group (an ssh transport, a merge driver, an alias's shell) is killed when
 * the time is up, and the call settles at once rather than when the last
 * holder of its pipes exits.
 */
function spawnGit(args: string[], o: { cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const group = o.timeoutMs !== undefined;
    const child = spawn('git', args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: group });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: Spawned | Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const result = (code: number, timedOut: boolean): Spawned => ({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      timedOut,
    });
    if (group) {
      timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        done(result(-1, true));
      }, o.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => done(e));
    child.on('close', (code, signal) => done(result(code ?? (signal ? 128 : -1), false)));
    child.stdin.on('error', () => {
      // git may exit before reading all of its input (EPIPE): the exit code says what happened.
    });
    child.stdin.end(o.input ?? '');
  });
}

/** Run and return the result whatever the exit code; only a timeout or a spawn failure rejects. */
export async function runAny(g: Git, args: string[], o: Omit<RunOptions, 'ok'> = {}): Promise<GitResult> {
  try {
    return await g.run(args, { ...o, ok: ANY_CODE });
  } catch (e) {
    if (e instanceof GitError && !e.timedOut) return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    throw e;
  }
}

const ANY_CODE = Array.from({ length: 257 }, (_, i) => i - 1);

/** Credentials in URLs (`https://user:token@host/…`) never reach an error message or a report. */
export function redactUrls(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');
}

export function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('hint:')) ?? ''
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ argument checks

/** Full lowercase object id (sha1 or sha256), as FULL_SHA_RE in @agenthub/contract. */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A revision argument that git can't take for an option, and that fits on one line. */
export function validRev(rev: string): boolean {
  return rev.length > 0 && !rev.startsWith('-') && !/[\0\n\r]/.test(rev);
}

export function assertRev(rev: string, what = 'revision'): void {
  if (!validRev(rev)) throw new Error(`gitops: bad ${what} ${JSON.stringify(rev)}`);
}

export function assertSha(sha: string, what: string): void {
  if (!FULL_SHA_RE.test(sha)) throw new Error(`gitops: ${what} must be a full sha, got ${JSON.stringify(sha)}`);
}

/** A remote name, URL or path that git can't take for an option. */
export function assertRemote(remote: string): void {
  if (!remote || remote.startsWith('-') || /[\0\n\r]/.test(remote)) throw new Error(`gitops: bad remote ${JSON.stringify(remote)}`);
}

/**
 * A full ref name gitops will pass to push: `refs/…`, segments of
 * [A-Za-z0-9._-] that don't start with a dot, end with `.lock` or contain
 * `..`. Stricter than git-check-ref-format, and never a pattern.
 */
export function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 400) return false;
  return ref
    .split('/')
    .every((seg) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(seg) && !seg.includes('..') && !seg.endsWith('.lock') && !seg.endsWith('.'));
}

/** A repository path for an index entry or a `rev:path` lookup. */
export function validRepoPath(p: string): boolean {
  return p.length > 0 && !p.startsWith('/') && !/[\0]/.test(p) && p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git');
}
