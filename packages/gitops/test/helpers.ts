// Test helpers for @agenthub/gitops: real git on temp repositories, isolated
// from the developer's git config, with fixed identities and dates so shas
// are reproducible (design §5 "Git").
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { open } from '../src/index.js';
import type { Git } from '../src/types.js';

export const AUTHOR = { name: 'Maya Agent', email: 'maya@example.com' };
export const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
export const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;

/** Identity for gitops' isolated Gits (which drop every inherited GIT_* variable). */
export const IDENT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${BASE_TIME} +0000`,
  GIT_COMMITTER_NAME: LANDER.name,
  GIT_COMMITTER_EMAIL: LANDER.email,
  GIT_COMMITTER_DATE: `${BASE_TIME} +0000`,
};

/** Environment for the git the tests run themselves: no global or system config, no HUB_* or ANTHROPIC_*. */
export function testEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  }
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, IDENT_ENV);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run git synchronously in `cwd`; returns stdout (untrimmed), and throws on an exit code not in `ok`. */
export function sh(cwd: string, args: string[], extra: Record<string, string | undefined> = {}, input?: string, ok: number[] = [0]): string {
  const r = spawnSync('git', args, { cwd, env: testEnv(extra), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (!ok.includes(r.status ?? -1)) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

export function shTrim(cwd: string, ...args: string[]): string {
  return sh(cwd, args).trim();
}

export interface Tmp {
  dir: string;
  cleanup(): void;
}

export function tmp(prefix = 'gitops-test-'): Tmp {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A working repository the test edits and commits in. Every commit gets the
 * next minute as its author and committer date, so a test's shas are the same
 * on every run.
 */
export class Repo {
  private tick = 0;
  constructor(readonly dir: string) {}

  static init(dir: string, branch = 'main'): Repo {
    mkdirSync(dir, { recursive: true });
    sh(dir, ['init', '-q', '-b', branch, dir]);
    return new Repo(dir);
  }

  git(...args: string[]): string {
    return sh(this.dir, args, this.dates()).trim();
  }

  /** The date env the next commit uses (and advances the clock). */
  dates(): Record<string, string> {
    const t = `${BASE_TIME + 60 * ++this.tick} +0000`;
    return { GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
  }

  write(file: string, content: string | Buffer): void {
    const p = path.join(this.dir, file);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  read(file: string): string {
    return readFileSync(path.join(this.dir, file), 'utf8');
  }

  /** Write the files (null deletes, {link} makes a symlink), stage everything, commit, return the full sha. */
  commit(message: string, files: Record<string, string | Buffer | null | { link: string }> = {}): string {
    for (const [file, content] of Object.entries(files)) {
      const p = path.join(this.dir, file);
      if (content === null) rmSync(p, { force: true });
      else if (typeof content === 'object' && !Buffer.isBuffer(content)) {
        rmSync(p, { force: true });
        mkdirSync(path.dirname(p), { recursive: true });
        symlinkSync(content.link, p);
      } else this.write(file, content);
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '--allow-empty', '-m', message], this.dates());
    return this.head();
  }

  head(): string {
    return this.rev('HEAD');
  }

  rev(rev: string): string {
    return sh(this.dir, ['rev-parse', '--verify', rev]).trim();
  }

  checkout(...args: string[]): void {
    sh(this.dir, ['checkout', '-q', ...args]);
  }

  /** A gitops Git on this repository. */
  open(isolated = true): Git {
    return open(this.dir, { isolated, env: IDENT_ENV });
  }
}

/** A bare remote with `receive.denyNonFastForwards`, like the design's test remotes (§5). */
export function bareRemote(dir: string, branch = 'main'): string {
  sh(path.dirname(dir), ['init', '-q', '--bare', '-b', branch, dir]);
  sh(dir, ['config', 'receive.denyNonFastForwards', 'true']);
  return dir;
}

/** An `update` hook on a bare remote that refuses every update of refs/heads/<branch>. */
export function refuseTrunkHook(remote: string, branch = 'main'): void {
  const hook = path.join(remote, 'hooks', 'update');
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nif [ "$1" = "refs/heads/${branch}" ]; then echo "only the lander identity may update ${branch}" >&2; exit 1; fi\nexit 0\n`);
  chmodSync(hook, 0o755);
}

/** sha256 of every file under `dir` (the .git directory included), keyed by relative path. */
export function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const rel = path.relative(dir, p);
      if (skip(rel)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** HEAD (symbolic and resolved) and every ref, as git prints them. */
export function refs(dir: string): string {
  let symbolic = '(detached)';
  try {
    symbolic = sh(dir, ['symbolic-ref', '-q', 'HEAD'], {}).trim();
  } catch {
    // detached HEAD
  }
  const head = sh(dir, ['rev-parse', 'HEAD'], {}).trim();
  return `${symbolic} ${head}\n${sh(dir, ['for-each-ref', '--format=%(objectname) %(refname)'])}`;
}

/**
 * A `git` shim placed first on PATH: it appends its argument list (one record
 * per line, arguments separated by \x01) to `log`, then runs the real git, or,
 * when an argument starts with `block`, sleeps `sleep` seconds and exits with
 * `code` instead (to fake an old git, or a push that hangs).
 */
export function gitShim(dir: string, opts: { block?: string; code?: number; sleep?: number } = {}): { path: string; log: string; calls(): string[][] } {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'shim-bin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'git-calls.log');
  writeFileSync(log, '');
  const block = opts.block
    ? `for a in "$@"; do case "$a" in ${opts.block}*) ${opts.sleep ? `sleep ${opts.sleep}; ` : ''}echo "shim: refusing ${opts.block}" >&2; exit ${opts.code ?? 129};; esac; done\n`
    : '';
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\001' "$a"; done >> "${log}"\nprintf '\\n' >> "${log}"\n${block}exec "${realGit}" "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  return {
    path: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    log,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => l.split('\u0001').slice(0, -1)),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
