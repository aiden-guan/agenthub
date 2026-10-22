import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub, SqliteStore, startServer, type RunningServer } from '@agenthub/hub';
import { HubClient } from '../src/client.js';

export const A = 'maya/claude-1';
export const B = 'sam/claude-1';
export const PROJECT = 'demo';
export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/hub.js');
/** How tests invoke the CLI from hooks: absolute node + absolute script, quoted (the repo path has spaces). */
export const CLI_COMMAND = `"${process.execPath}" "${CLI}"`;

/** Environment for child processes: isolated from the developer's git and hub config. */
export function testEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HUB_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR') env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    HUB_CONFIG: '/nonexistent/agenthub/config.json',
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

/** Run the built `hub` CLI (async, so the in-process hub can answer it). */
export function hubCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<RunResult> {
  return run(process.execPath, [CLI, ...args], opts);
}

/** A hub on a fresh in-memory database, on a random port, or on `port` (to bring one back where another was). */
export async function startHub(opts: { leaseTtlMs?: number; sweepIntervalMs?: number; token?: string; port?: number } = {}): Promise<RunningServer> {
  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: opts.leaseTtlMs });
  return startServer({ hub, port: opts.port ?? 0, sweepIntervalMs: opts.sweepIntervalMs, token: opts.token });
}

/**
 * The URL of a hub that is down: a port nothing listens on, so a connection is
 * refused. (Not a port fetch blocks, such as 9: the adapter takes those for a
 * setup mistake, not an outage.)
 */
export async function downUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export function client(url: string, agent: string | null, token: string | null = null): HubClient {
  return new HubClient({ url, project: PROJECT, agent, token, timeoutMs: 3000 });
}

export interface FakeHub {
  url: string;
  close(): Promise<void>;
}

/** A stand-in for a hub that misbehaves: answers with whatever `handler` does (or never answers). */
export async function fakeHub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FakeHub> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A fake hub that answers every request with this status and the standard error envelope. */
export function failingHub(status: number, code: string, message: string): Promise<FakeHub> {
  return fakeHub((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code, message } }));
  });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: testEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface SampleRepo {
  dir: string;
  main: string;
  wtA: string;
  wtB: string;
  cleanup(): void;
}

/** A small repo with two worktrees, one per agent, like the README demo. */
export function makeRepo(): SampleRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-test-'));
  const main = path.join(dir, 'sample');
  mkdirSync(path.join(main, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', main);
  writeFileSync(path.join(main, 'src', 'auth.ts'), 'export function login(user: string) {\n  return `session-${user}`;\n}\n');
  writeFileSync(path.join(main, 'src', 'users.ts'), 'export const users = ["maya", "sam"];\n');
  writeFileSync(path.join(main, 'README.md'), '# sample\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'initial');
  const wtA = path.join(dir, 'wt-a');
  const wtB = path.join(dir, 'wt-b');
  git(main, 'worktree', 'add', '-q', wtA, '-b', 'agent-a');
  git(main, 'worktree', 'add', '-q', wtB, '-b', 'agent-b');
  return { dir, main, wtA, wtB, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Which Claude Code session, subagent and tool call a hook payload belongs to. */
export interface CallIds {
  session?: string;
  toolUseId?: string;
  /** Present only for tool calls made inside a subagent. */
  agentId?: string;
}

function toolInputFor(toolName: string, filePath: string): Record<string, unknown> {
  if (toolName === 'Write') return { file_path: filePath, content: 'new content\n' };
  if (toolName === 'NotebookEdit') return { notebook_path: filePath, cell_id: 'cell-1', new_source: 'print(1)\n' };
  return { file_path: filePath, old_string: 'session-', new_string: 'sess-', replace_all: false };
}

/** A PreToolUse payload shaped like Claude Code's. */
export function preToolUseInput(cwd: string, filePath: string, toolName = 'Edit', ids: CallIds = {}): string {
  return JSON.stringify({
    session_id: ids.session ?? 'test-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    permission_mode: 'default',
    ...(ids.agentId ? { agent_id: ids.agentId, agent_type: 'general-purpose' } : {}),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInputFor(toolName, filePath),
    tool_use_id: ids.toolUseId ?? 'toolu_01TEST',
  });
}

/** A PostToolUse payload shaped like Claude Code's: sent only after the tool call ran and succeeded. */
export function postToolUseInput(cwd: string, filePath: string, toolName = 'Edit', ids: CallIds = {}): string {
  return JSON.stringify({
    session_id: ids.session ?? 'test-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    permission_mode: 'default',
    ...(ids.agentId ? { agent_id: ids.agentId, agent_type: 'general-purpose' } : {}),
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInputFor(toolName, filePath),
    tool_response: { filePath, success: true },
    tool_use_id: ids.toolUseId ?? 'toolu_01TEST',
    duration_ms: 12,
  });
}

export type SessionEvent = 'Stop' | 'SubagentStop' | 'UserPromptSubmit' | 'SessionEnd';

/** A Stop / SubagentStop / UserPromptSubmit / SessionEnd payload shaped like Claude Code's. */
export function sessionEventInput(cwd: string, event: SessionEvent, session = 'test-session', agentId?: string): string {
  const extra = {
    Stop: { stop_hook_active: false },
    SubagentStop: { stop_hook_active: false, agent_id: agentId ?? 'sub-1', agent_type: 'general-purpose', agent_transcript_path: '/tmp/agent.jsonl' },
    UserPromptSubmit: { prompt: 'carry on' },
    SessionEnd: { reason: 'prompt_input_exit' },
  }[event];
  return JSON.stringify({ session_id: session, transcript_path: '/tmp/transcript.jsonl', cwd, permission_mode: 'default', hook_event_name: event, ...extra });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
