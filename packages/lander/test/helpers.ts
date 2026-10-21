// Test helpers for @agenthub/lander: real git on temp repositories, isolated
// from the developer's git config, with fixed identities and dates so shas are
// reproducible (design §5 "Git").
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const AUTHOR = { name: 'Maya Agent', email: 'maya@example.com' };
export const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
export const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
export const EPOCH = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
export const PROJECT = 'acme/web';

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

/** Run git synchronously in `cwd`; returns stdout (untrimmed), and throws on a non-zero exit. */
export function sh(cwd: string, args: string[], extra: Record<string, string | undefined> = {}, input?: string): string {
  const r = spawnSync('git', args, { cwd, env: testEnv(extra), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

export interface Tmp {
  dir: string;
  cleanup(): void;
}

export function tmp(prefix = 'lander-test-'): Tmp {
  // Canonical, so paths the tests build compare equal to what `pwd` prints.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A working repository; every commit gets the next minute as its date, so shas are the same on every run. */
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

  dates(): Record<string, string> {
    const t = `${BASE_TIME + 60 * ++this.tick} +0000`;
    return { GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
  }

  write(file: string, content: string): void {
    const p = path.join(this.dir, file);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  read(file: string): string {
    return readFileSync(path.join(this.dir, file), 'utf8');
  }

  /** Write the files (null deletes), stage everything, commit with `message`, return the full sha. */
  commit(message: string, files: Record<string, string | null> = {}): string {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) rmSync(path.join(this.dir, file), { force: true });
      else this.write(file, content);
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '--allow-empty', '-F', '-'], this.dates(), message);
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
}

/** A bare clone of `repo` with every branch, like the lander's mirror.git. */
export function bareMirror(repo: Repo, dir: string): string {
  sh(path.dirname(dir), ['clone', '-q', '--bare', repo.dir, dir]);
  return dir;
}

/** Trailers of a landed commit, as the lander writes them (for attribution tests). */
export function trailers(t: { landing: string; hub: string; source: string; agent?: string; task?: string }): string {
  return [
    `Agenthub-Landing: ${t.landing}`,
    `Agenthub-Hub: ${t.hub}`,
    `Agenthub-Source: ${t.source}`,
    ...(t.task ? [`Agenthub-Task: ${t.task}`] : []),
    ...(t.agent ? [`Agenthub-Agent: ${t.agent}`] : []),
  ].join('\n');
}
