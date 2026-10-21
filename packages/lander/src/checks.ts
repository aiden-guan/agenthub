// The checks runner (design §2.2.8): trunk's check command in a fresh
// worktree of exactly the candidate, in its own process group, with an
// allowlisted environment and a scratch HOME. Pass means exit 0 and a clean
// tracked tree. The output is ANSI-stripped and redacted as it streams, into a
// capped log file and the report's tail; failing test names are picked out of
// it on the way.

import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { open, trunkTrailers, type Git } from '@agenthub/gitops';
import type { CheckReport } from '@agenthub/hub/protocol';
import type { CheckRunRequest, CheckRunResult, CheckStatus, ChecksPort } from './ports.js';
import { Redactor } from './redact.js';
import { commandHash, reproduceLine } from './report.js';

export const LOG_TAIL_LINES = 200;
export const LOG_TAIL_BYTES = 16 * 1024;
export const LOG_CAP_BYTES = 10 * 1024 * 1024;
export const KILL_GRACE_MS = 10_000;
export const MAX_FAILED_TESTS = 50;
/** A line longer than this (no newline in sight) is cut into pieces. */
const MAX_LINE = 64 * 1024;
const MAX_TEST_NAME = 300;
/** How long to wait for the output pipes to close once the process group is gone. */
const PIPE_GRACE_MS = 1000;
/** How long to wait for a SIGKILLed group to die. */
const REAP_MS = 2000;
/** setTimeout fires at once for anything longer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LANDING_ID_RE = /^L-[1-9][0-9]*$/;

// ------------------------------------------------------------------ the environment (design §2.2.8 "Env")

/** Never passed to a check, even when listed in checkEnv or passEnv: the hub's, Anthropic's, git's and ssh's. */
const NEVER_RE = /^(?:HUB_|ANTHROPIC_|GIT_)/i;
const NEVER = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'GH_TOKEN', 'GITHUB_TOKEN']);
/** Secret-looking names: passed only when the lander operator listed them in passEnv. */
const SECRETISH_RE = /(?:_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;

export function deniedName(name: string, passEnv: readonly string[]): boolean {
  if (NEVER_RE.test(name) || NEVER.has(name.toUpperCase())) return true;
  return SECRETISH_RE.test(name) && !passEnv.includes(name);
}

/**
 * The check's whole environment: an allowlist, never the lander's own
 * environment. checkEnv (trunk's, non-secret values) and passEnv (the lander
 * operator's, e.g. NPM_TOKEN) go through the deny rules; HOME, TMPDIR and the
 * AGENTHUB_* values come last and can't be overridden.
 */
export function checkEnvironment(o: {
  base: NodeJS.ProcessEnv;
  passEnv: readonly string[];
  checkEnv: Record<string, string>;
  runDir: string;
  npmCache: string;
  landingId: string;
  trunk: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL']) {
    const v = o.base[k];
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, { TZ: 'UTC', TERM: 'dumb', CI: '1', npm_config_cache: o.npmCache });
  for (const [k, v] of Object.entries(o.checkEnv)) env[k] = v;
  for (const k of o.passEnv) {
    const v = o.base[k];
    if (v !== undefined) env[k] = v;
  }
  for (const k of Object.keys(env)) if (deniedName(k, o.passEnv)) delete env[k];
  Object.assign(env, {
    HOME: path.join(o.runDir, 'home'),
    TMPDIR: path.join(o.runDir, 'tmp'),
    AGENTHUB_LANDING: o.landingId,
    AGENTHUB_TRUNK: o.trunk,
  });
  return env;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** With checkWrapper (e.g. `docker run --rm -v {wt}:/w -w /w node:22 sh -c`), the command becomes `<wrapper> '<check>'`. */
export function wrapCommand(command: string, wrapper: string | null | undefined, wt: string): string {
  if (!wrapper) return command;
  return `${wrapper.split('{wt}').join(shq(wt))} ${shq(command)}`;
}

// ------------------------------------------------------------------ output: cleaning, failed tests, the log

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[P^_X][^\u001b]*(?:\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** One line as a terminal would leave it: escape sequences gone, the text after the last carriage return, no controls. */
export function cleanLine(raw: string): string {
  const s = raw.replace(ANSI_RE, '');
  const parts = s.split('\r');
  const shown = parts.length === 1 ? s : ([...parts].reverse().find((p) => p.length > 0) ?? '');
  return shown.replace(CONTROL_RE, '');
}

const DURATION_RE = /\s+(?:\(\s*\d+(?:\.\d+)?\s*m?s\s*\)|\d+(?:\.\d+)?\s*m?s)$/;

/** Failing test names, best effort, from vitest/jest, node:test, mocha, pytest, go test and cargo test output (design §2.2.8). */
export class FailedTests {
  private readonly names: string[] = [];
  private readonly seen = new Set<string>();
  private readonly mocha = new Set<string>();

  add(line: string): void {
    let m: RegExpExecArray | null;
    let name: string | null = null;
    if ((m = /^\s*FAIL {1,2}(\S.*?)\s*$/.exec(line))) {
      // vitest ` FAIL  file > suite > test` (and `[ project ]` labels); jest `FAIL file (5.1 s)`.
      name = m[1]!.replace(/\s+\[ .* \]$/, '').replace(DURATION_RE, '');
    } else if ((m = /^\s*[×✗✕✖]\s+(.+?)\s*$/.exec(line))) {
      name = m[1]!.replace(DURATION_RE, '');
      if (name.endsWith(':') || /^\d+ tests? failed/.test(name)) name = null;
    } else if ((m = /^\s*not ok \d+(?: - (.*?))?\s*$/.exec(line))) {
      const rest = m[1] ?? '';
      name = /#\s*(?:TODO|SKIP)\b/i.test(rest) ? null : rest.replace(/\s+#.*$/, '') || null;
    } else if ((m = /^\s+(\d+)\) (\S.*?)\s*$/.exec(line))) {
      // mocha numbers its failures twice (inline, then in the summary, by suite): the first title wins.
      if (!this.mocha.has(m[1]!)) {
        this.mocha.add(m[1]!);
        name = m[2]!;
      }
    } else if ((m = /^FAILED (.+?)(?: - .*)?\s*$/.exec(line))) name = m[1]!;
    else if ((m = /^\s*--- FAIL: (\S+)/.exec(line))) name = m[1]!;
    else if ((m = /^test (\S+) \.\.\. FAILED\s*$/.exec(line))) name = m[1]!;
    if (!name) return;
    name = name.trim().slice(0, MAX_TEST_NAME);
    if (!name || this.seen.has(name) || this.names.length >= MAX_FAILED_TESTS * 4) return;
    this.seen.add(name);
    this.names.push(name);
  }

  /** In first-seen order; a short name another one ends with (`login > x` vs `file > login > x`) is left out. */
  list(): string[] {
    const full = this.names.filter((n) => !this.names.some((m) => m !== n && (m.endsWith(` > ${n}`) || m.endsWith(` › ${n}`))));
    return full.slice(0, MAX_FAILED_TESTS);
  }
}

export function parseFailedTests(lines: Iterable<string>): string[] {
  const f = new FailedTests();
  for (const l of lines) f.add(cleanLine(l));
  return f.list();
}

/** Everything the check prints, line by line: cleaned, redacted, then into the log file (capped), the tail and the test names. */
class LogSink {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';
  private fd: number | null;
  private written = 0;
  private truncated = false;
  private readonly tail: string[] = [];
  readonly tests = new FailedTests();

  constructor(
    readonly file: string,
    private readonly redactor: Redactor,
    private readonly cap: number,
  ) {
    this.fd = openSync(file, 'w', 0o600);
  }

  write(chunk: Buffer): void {
    this.feed(this.decoder.write(chunk));
  }

  end(): void {
    this.feed(this.decoder.end());
    if (this.partial) this.line(this.partial);
    this.partial = '';
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  private feed(s: string): void {
    let text = this.partial + s;
    let from = 0;
    for (let nl = text.indexOf('\n', from); nl >= 0; nl = text.indexOf('\n', from)) {
      this.line(text.slice(from, nl));
      from = nl + 1;
    }
    text = text.slice(from);
    while (text.length > MAX_LINE) {
      // No newline in sight: cut, at a space when there is one, so a token isn't split.
      const space = text.lastIndexOf(' ', MAX_LINE);
      const cut = space > MAX_LINE / 2 ? space + 1 : MAX_LINE;
      this.line(text.slice(0, cut));
      text = text.slice(cut);
    }
    this.partial = text;
  }

  private line(raw: string): void {
    const line = this.redactor.line(cleanLine(raw));
    if (line === null) return;
    this.tests.add(line);
    this.tail.push(line);
    if (this.tail.length > LOG_TAIL_LINES) this.tail.shift();
    this.toFile(`${line}\n`);
  }

  private toFile(text: string): void {
    if (this.fd === null || this.truncated) return;
    const bytes = Buffer.byteLength(text);
    if (this.written + bytes > this.cap) {
      this.truncated = true;
      writeSync(this.fd, `[agenthub: log truncated at ${this.cap} bytes]\n`);
      return;
    }
    writeSync(this.fd, text);
    this.written += bytes;
  }

  /** The last 200 lines, at most 16 KiB. */
  tailText(): string {
    const out: string[] = [];
    let bytes = 0;
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const line = this.tail[i]!;
      const b = Buffer.byteLength(line) + 1;
      if (bytes + b > LOG_TAIL_BYTES) {
        if (out.length === 0) out.push(tailBytes(line, LOG_TAIL_BYTES - 1));
        break;
      }
      out.push(line);
      bytes += b;
    }
    return out.length ? `${out.reverse().join('\n')}\n` : '';
  }
}

function tailBytes(s: string, n: number): string {
  const buf = Buffer.from(s, 'utf8');
  let start = Math.max(0, buf.length - n);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

// ------------------------------------------------------------------ state.json: process groups of running checks

interface CheckRecord {
  pgid: number;
  landing: string;
  attempt: number;
  /** The run directory: an orphan's processes run inside it. */
  dir: string;
  at: number;
}

class StateFile {
  constructor(readonly file: string) {}

  read(): CheckRecord[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { checks?: unknown };
      if (!Array.isArray(v.checks)) return [];
      return v.checks.filter(
        (c): c is CheckRecord => !!c && typeof c === 'object' && Number.isInteger((c as CheckRecord).pgid) && (c as CheckRecord).pgid > 1 && typeof (c as CheckRecord).dir === 'string',
      );
    } catch {
      return [];
    }
  }

  write(checks: CheckRecord[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ checks }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  add(rec: CheckRecord): void {
    this.write([...this.read().filter((c) => c.pgid !== rec.pgid), rec]);
  }

  remove(pgid: number): void {
    this.write(this.read().filter((c) => c.pgid !== pgid));
  }
}

/** Whether any process of the group exists (zombies included). */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

/** Linux: the processes of a group, from /proc; null when /proc can't be read. */
function groupMembers(pgid: number): Array<{ pid: string; state: string }> | null {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  const out: Array<{ pid: string; state: string }> = [];
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // `pid (comm) state ppid pgrp ...`: comm may hold spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid) out.push({ pid, state: fields[0]! });
    } catch {
      // it exited meanwhile
    }
  }
  return out;
}

/**
 * Whether the group still has a live process. A zombie (killed, but not yet
 * reaped by an init that reaps slowly, as in some containers) can do nothing,
 * so it doesn't count.
 */
function groupLive(pgid: number): boolean {
  if (!groupExists(pgid)) return false;
  if (process.platform !== 'linux') return true;
  const members = groupMembers(pgid);
  return members === null || members.some((m) => m.state !== 'Z');
}

/** Linux: whether a live member of group `pgid` runs inside `dir`, so a recycled pgid is never killed. */
function groupRunsIn(pgid: number, dir: string): boolean {
  for (const m of groupMembers(pgid) ?? []) {
    if (m.state === 'Z') continue;
    try {
      const cwd = readlinkSync(`/proc/${m.pid}/cwd`).replace(/ \(deleted\)$/, '');
      if (cwd === dir || cwd.startsWith(`${dir}${path.sep}`)) return true;
    } catch {
      // it exited meanwhile, or isn't ours to read
    }
  }
  return false;
}

/** rm -rf, also of what a check left read-only (Go's module cache, for one). */
function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // fall through: make everything writable, then try again
  }
  const walk = (d: string) => {
    try {
      chmodSync(d, 0o700);
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (lstatSync(p).isDirectory()) walk(p);
      }
    } catch {
      // best effort
    }
  };
  walk(dir);
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the runner

export interface ChecksRunnerOptions {
  /** The lander's workdir: runs/, logs/, npm-cache/ and state.json live here. */
  workdir: string;
  /** The bare mirror (an isolated Git, or its path). */
  mirror: Git | string;
  /** The lander's environment, the source of PATH, LANG, LC_ALL and the passEnv values (default process.env). */
  env?: NodeJS.ProcessEnv;
  passEnv?: readonly string[];
  checkWrapper?: string | null;
  /** Exact values to redact besides the passEnv values: the lander's own secrets. */
  secrets?: ReadonlyArray<string | null | undefined>;
  /** SIGTERM to SIGKILL (default 10 s). */
  killGraceMs?: number;
  /** The full log's cap (default 10 MiB). */
  logCapBytes?: number;
}

interface Execution {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: Exclude<CheckStatus, 'passed' | 'failed' | 'modified_tree'> | null;
  durationMs: number;
}

export class ChecksRunner implements ChecksPort {
  private readonly workdir: string;
  private readonly mirror: Git;
  private readonly env: NodeJS.ProcessEnv;
  private readonly passEnv: readonly string[];
  private readonly killGraceMs: number;
  private readonly logCapBytes: number;
  private readonly state: StateFile;

  constructor(private readonly o: ChecksRunnerOptions) {
    // Absolute: git reads a relative worktree path against the mirror.
    this.workdir = path.resolve(o.workdir);
    this.mirror = typeof o.mirror === 'string' ? open(o.mirror, { isolated: true }) : o.mirror;
    this.env = o.env ?? process.env;
    this.passEnv = [...(o.passEnv ?? [])];
    this.killGraceMs = o.killGraceMs ?? KILL_GRACE_MS;
    this.logCapBytes = o.logCapBytes ?? LOG_CAP_BYTES;
    this.state = new StateFile(path.join(this.workdir, 'state.json'));
  }

  async run(req: CheckRunRequest): Promise<CheckRunResult> {
    if (!LANDING_ID_RE.test(req.landingId)) throw new Error(`lander: bad landing id ${JSON.stringify(req.landingId)}`);
    if (!Number.isInteger(req.attempt) || req.attempt < 0) throw new Error(`lander: bad attempt ${req.attempt}`);
    for (const [what, sha] of [['candidate', req.candidate], ['trunk', req.trunk]] as const) {
      if (!FULL_SHA_RE.test(sha)) throw new Error(`lander: the ${what} must be a full sha, got ${JSON.stringify(sha)}`);
    }
    const name = `${req.landingId}.${req.attempt}`;
    const runDir = path.join(this.workdir, 'runs', name);
    const wt = path.join(runDir, 'wt');
    const logs = path.join(this.workdir, 'logs');
    const npmCache = path.join(this.workdir, 'npm-cache');
    await this.removeRun(runDir, wt); // a leftover of a lander that died mid-check
    for (const d of [path.join(runDir, 'home'), path.join(runDir, 'tmp'), logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    mkdirSync(npmCache, { recursive: true });
    try {
      await this.mirror.run(['worktree', 'add', '--detach', wt, req.candidate]);
      const hash = commandHash(req.command);
      const secrets = [...(this.o.secrets ?? []), ...this.passEnv.map((k) => this.env[k])];
      const sink = new LogSink(path.join(logs, `${name}.log`), new Redactor(secrets), this.logCapBytes);
      let ex: Execution;
      try {
        ex = await this.execute(req, wrapCommand(req.command, this.o.checkWrapper, wt), checkEnvironment({ base: this.env, passEnv: this.passEnv, checkEnv: req.checkEnv, runDir, npmCache, landingId: req.landingId, trunk: req.trunk }), wt, runDir, sink);
      } finally {
        sink.end();
      }
      let status: CheckStatus;
      if (ex.stopped) status = ex.stopped;
      else if (ex.code !== 0) status = 'failed';
      else if (!req.allowDirtyTree && (await this.dirty(wt))) status = 'modified_tree';
      else status = 'passed';
      const report: CheckReport = {
        command_hash: hash,
        exit_code: ex.code,
        signal: ex.signal,
        timed_out: ex.stopped === 'timed_out',
        duration_ms: Math.round(ex.durationMs),
        log_tail: sink.tailText(),
        failed_tests: sink.tests.list(),
        passes_on_trunk: await this.passesOnTrunk(req.trunk, req.epoch, hash),
        reproduce: reproduceLine({ remote: req.remote, candidateRef: req.candidateRef, candidate: req.candidate, landingId: req.landingId, command: req.command }),
      };
      return { status, report, logFile: sink.file };
    } finally {
      await this.removeRun(runDir, wt);
    }
  }

  /** Startup recovery (design §2.2.7): kill the check process groups a dead lander process left running. */
  async killOrphans(): Promise<number[]> {
    const bootedAt = Date.now() - uptime() * 1000 - 60_000;
    const killed: number[] = [];
    for (const rec of this.state.read()) {
      // A record from before a reboot names a pgid that may be anyone's by now.
      if (!(rec.at >= bootedAt) || !groupLive(rec.pgid)) continue;
      if (process.platform === 'linux' && !groupRunsIn(rec.pgid, rec.dir)) continue;
      killGroup(rec.pgid, 'SIGKILL');
      killed.push(rec.pgid);
    }
    this.state.write([]);
    return killed;
  }

  private execute(req: CheckRunRequest, command: string, env: Record<string, string>, wt: string, runDir: string, sink: LogSink): Promise<Execution> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const child = spawn('/bin/sh', ['-c', command], { cwd: wt, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stopped: Execution['stopped'] = null;
      let exited = false;
      let termAt: number | null = null;
      let failed = false;
      const pgid = child.pid;
      child.on('error', (err) => {
        failed = true;
        cleanup();
        reject(err);
      });
      if (pgid === undefined) return; // spawn failed: 'error' follows
      this.state.add({ pgid, landing: req.landingId, attempt: req.attempt, dir: runDir, at: Date.now() });
      child.stdout.on('data', (d: Buffer) => sink.write(d));
      child.stderr.on('data', (d: Buffer) => sink.write(d));

      const term = () => {
        if (termAt !== null) return;
        termAt = performance.now();
        killGroup(pgid, 'SIGTERM');
      };
      const stop = (why: NonNullable<Execution['stopped']>) => {
        if (stopped || exited) return;
        stopped = why;
        term();
        killTimer = setTimeout(() => killGroup(pgid, 'SIGKILL'), this.killGraceMs);
      };
      let killTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => stop('timed_out'), Math.min(Math.max(1, req.timeoutMs), MAX_TIMER_MS));
      let watching = false;
      const watch = req.trunkWatch
        ? setInterval(() => {
            if (watching || stopped || exited) return;
            watching = true;
            req
              .trunkWatch!.moved()
              .then((moved) => {
                if (moved) stop('trunk_moved');
              })
              .catch(() => {
                // the remote is unreachable: keep checking, the push's CAS still guards trunk
              })
              .finally(() => {
                watching = false;
              });
          }, Math.min(Math.max(10, req.trunkWatch.intervalMs), MAX_TIMER_MS))
        : undefined;
      const onAbort = () => stop('aborted');
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) onAbort();

      const cleanup = () => {
        clearTimeout(timeout);
        if (watch) clearInterval(watch);
        req.signal?.removeEventListener('abort', onAbort);
      };

      const closed = new Promise<void>((r) => child.on('close', () => r()));
      child.on('exit', (code, signal) => {
        if (failed) return;
        exited = true;
        const durationMs = performance.now() - started;
        cleanup();
        void (async () => {
          // The check is over: whatever it left running in its group goes too.
          if (groupLive(pgid)) term();
          const deadline = (termAt ?? performance.now()) + this.killGraceMs;
          while (groupLive(pgid) && performance.now() < deadline) await sleep(25);
          if (killTimer) clearTimeout(killTimer);
          if (groupLive(pgid)) {
            killGroup(pgid, 'SIGKILL');
            const reap = performance.now() + REAP_MS;
            while (groupLive(pgid) && performance.now() < reap) await sleep(25);
          }
          // Output still in the pipes; something that left the group may hold them open, so don't wait forever.
          await Promise.race([closed, sleep(PIPE_GRACE_MS)]);
          child.stdout.destroy();
          child.stderr.destroy();
          this.state.remove(pgid);
          resolve({ code, signal, stopped, durationMs });
        })().catch(reject);
      });
    });
  }

  /** Tracked files changed. A status git can't give (the check broke the worktree) counts as changed: a pass needs a tree known to be as committed. */
  private async dirty(wt: string): Promise<boolean> {
    try {
      const r = await open(wt, { isolated: true }).run(['status', '--porcelain', '--untracked-files=no']);
      return r.stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  /** design §2.2.8: true when T0 landed through this hub under the same check command (its own trailers say so), else null. */
  private async passesOnTrunk(trunk: string, epoch: string, hash: string): Promise<boolean | null> {
    try {
      const [t0] = await trunkTrailers(this.mirror, null, trunk, 1);
      return t0 && t0.sha === trunk && t0.hub === epoch && t0.checked === hash ? true : null;
    } catch {
      return null;
    }
  }

  /** The run's worktree, HOME and TMPDIR, and its registration in the mirror (also a stale one, so `worktree add` can reuse the path). */
  private async removeRun(runDir: string, wt: string): Promise<void> {
    if (existsSync(runDir)) {
      try {
        await this.mirror.run(['worktree', 'remove', '--force', '--force', wt]);
      } catch {
        // not registered, or already half gone: removed below
      }
      removeTree(runDir);
    }
    try {
      await this.mirror.run(['worktree', 'prune']);
    } catch {
      // best effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
