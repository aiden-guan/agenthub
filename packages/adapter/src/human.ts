import { parseArgs } from 'node:util';
import type { TaskStatus } from '@agenthub/hub/protocol';
import { HubClient } from './client.js';
import { loadConfig } from './config.js';
import { claimFiles, formatDecision, formatMessage, formatTask, statusText, UNTRUSTED_NOTE } from './format.js';
import { currentBranch, headCommit, toRepoPath } from './git.js';
import type { HookOutcome } from './hooks.js';

const ok = (stdout: string): HookOutcome => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): HookOutcome => ({ stdout: '', stderr: `${stderr}\n`, exitCode });

/** Commands people run by hand (`hub status`, `hub task add ...`). Same API as the MCP tools. */
export async function human(cmd: string, argv: string[]): Promise<HookOutcome> {
  const cfg = loadConfig();
  const client = new HubClient(cfg);
  const need = () => {
    if (!cfg.agent) throw new Error('no agent identity: set HUB_AGENT=human/agent or run `hub init --agent human/agent`');
  };
  const files = (paths: string[]) =>
    paths.map((f) => {
      const p = cfg.root ? toRepoPath(f, cfg.root, process.cwd()) : f;
      if (!p) throw new Error(`${f} is outside the repository`);
      return p;
    });

  switch (cmd) {
    case 'whoami':
      return ok(JSON.stringify({ ...cfg, token: cfg.token ? '(set)' : null }, null, 2));

    case 'status':
      return ok(statusText(await client.status(), cfg.agent));

    case 'task': {
      const [sub, ...rest] = argv;
      if (sub === 'list' || sub === undefined) {
        const tasks = await client.tasks();
        return ok(tasks.length ? tasks.map((t) => formatTask(t, cfg.agent)).join('\n') : 'no tasks');
      }
      if (sub === 'add') {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { dep: { type: 'string', multiple: true }, desc: { type: 'string' } },
        });
        need();
        const t = await client.createTask({ title: positionals.join(' '), description: values.desc, deps: values.dep });
        return ok(`created ${formatTask(t, cfg.agent)}`);
      }
      if (sub === 'take') {
        need();
        return ok(`took ${formatTask(await client.takeTask(rest[0]), cfg.agent)}`);
      }
      const statusFor: Record<string, TaskStatus> = { done: 'done', reopen: 'open', cancel: 'cancelled' };
      if (sub in statusFor) {
        need();
        const r = await client.updateTask(rest[0], statusFor[sub]);
        return ok(`${formatTask(r.task, cfg.agent)}${r.unblocked.length ? `\nunblocked: ${r.unblocked.join(', ')}` : ''}`);
      }
      return fail('usage: hub task list | add TITLE [--dep ID]... | take ID | done ID | reopen ID | cancel ID', 2);
    }

    case 'claim': {
      const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { intent: { type: 'string' }, shared: { type: 'boolean' }, queue: { type: 'boolean' } },
      });
      need();
      const res = await client.claim({
        files: files(positionals),
        intent: values.intent,
        mode: values.shared ? 'shared' : 'exclusive',
        queue: values.queue ?? false,
        base_commit: cfg.root ? (headCommit(cfg.root) ?? undefined) : undefined,
      });
      if (res.status === 'denied') {
        return fail(`denied: ${res.conflicts.map((c) => `${c.files.join(', ')} held by ${c.holder} (${c.claim_id})`).join('; ')}`);
      }
      const c = res.claim!;
      return ok(`${res.status}${res.renewed ? ' (renewed)' : ''}: ${c.id} ${claimFiles(c).join(', ')} [${c.mode}] "${c.intent}"`);
    }

    case 'release': {
      const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: 'boolean' }, claim: { type: 'string' } } });
      need();
      const res = await client.release({ all: values.all, claim_id: values.claim, files: positionals.length ? files(positionals) : undefined });
      return ok(`released ${res.released.length}, trimmed ${res.trimmed.length}, granted from queue ${res.promoted.length}`);
    }

    case 'post': {
      const [to, ...body] = argv;
      need();
      const m = await client.post(to, body.join(' '));
      return ok(`sent #${m.id} to ${m.channel ?? m.to}`);
    }

    case 'inbox': {
      need();
      const res = await client.inbox({ peek: argv.includes('--peek') });
      if (!res.messages.length) return ok('no unread messages');
      return ok([UNTRUSTED_NOTE, '', ...res.messages.map((m) => formatMessage(m, res.now))].join('\n'));
    }

    case 'decide': {
      const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { why: { type: 'string' }, file: { type: 'string', multiple: true }, symbol: { type: 'string', multiple: true } },
      });
      need();
      const d = await client.decide({ summary: positionals.join(' '), rationale: values.why, files: values.file ? files(values.file) : undefined, symbols: values.symbol });
      return ok(`recorded ${formatDecision(d, d.created_at)}`);
    }

    case 'land': {
      const { values } = parseArgs({ args: argv, options: { task: { type: 'string' }, summary: { type: 'string' } } });
      need();
      const res = await client.land({
        task_id: values.task,
        summary: values.summary,
        branch: cfg.root ? (currentBranch(cfg.root) ?? undefined) : undefined,
        commit: cfg.root ? (headCommit(cfg.root) ?? undefined) : undefined,
      });
      const lines = [`recorded ${res.landing.id}${res.task ? ` for ${res.task.id} (done)` : ''}; released ${res.released.map((c) => c.id).join(', ') || 'no claims'}`];
      if (res.unblocked.length) lines.push(`unblocked: ${res.unblocked.join(', ')}`);
      lines.push(res.note);
      return ok(lines.join('\n'));
    }

    default:
      return fail(`unknown command "${cmd}"; run hub --help`, 2);
  }
}
