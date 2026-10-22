#!/usr/bin/env node
// `hub` — the agenthub adapter CLI. Subcommands load their modules lazily so
// the hook commands (run on every edit) start fast.
import { parseArgs } from 'node:util';

const HELP = `hub — agenthub adapter

Agent integration
  hub mcp                    Run the MCP stdio server (tools: hub_status, task_list, task_take, task_create,
                             claim, release, hub_wait, hub_post, inbox, decide, land, landing_status, land_cancel, hub_sync)
  hub hook pre-edit          Claude Code PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit): claim what the edit changes (the
                             declarations an Edit or MultiEdit changes, else the file) or deny the edit
  hub hook post-edit         Claude Code PostToolUse hook: confirm the claim of an edit that ran, and claim what it changed
                             beyond the simulated edit
  hub hook settle            Claude Code Stop/SubagentStop/UserPromptSubmit/SessionEnd hook: release claims of edits that never ran;
                             on UserPromptSubmit, sync the workspace with trunk (a safe point)
  hub hook digest            Claude Code SessionStart hook: sync the workspace with trunk, then team state as additionalContext
  hub guard                  git pre-commit hook (also prepare-commit-msg for revert/cherry-pick/rebase, pre-merge-commit for merges, pre-applypatch for am):
                             reject commits touching files (or, for modified files, declarations) others hold exclusively
  hub guard --pre-push       git pre-push hook: refuse pushes to trunk and to the lander's candidate refs (HUB_GUARD=off bypasses it)
  hub init [--agent human/agent] [--project ID] [--url URL] [--command CMD] [--no-hooks] [--no-mcp] [--no-guard]
                             Write .hub.json, .claude/settings.json hooks, .mcp.json and the pre-commit guard

For humans
  hub status                 Team state
  hub whoami                 Resolved configuration
  hub task list | add TITLE [--dep T-1]... [--desc TEXT] | take ID | done ID | reopen ID | cancel ID
  hub claim FILE[#Symbol]... --intent TEXT [--shared]
                             FILE#Symbol claims one declaration (src/auth.ts#login, src/auth.ts#Session.refresh)
  hub release [FILE...] [--all] [--claim C-3]
  hub post TO BODY           TO is human/agent or #channel
  hub inbox [--peek]
  hub decide SUMMARY [--why TEXT] [--file F]...

Landing queue (with a "land" section in trunk's agenthub.json; without one, land records it as in Phase 1)
  hub land [--task T-1] [--summary TEXT] [--allow-untracked] [--wait]
                             Check the worktree, push HEAD to its land ref and queue it for the lander
  hub landings [--all] [--watch] [--stats [--days 7]]
                             The queue, the lander and recent landings; --stats: median land→trunk, first-try rate
  hub landing L-7 [--log]    One landing in detail, with what to fix if it came back
  hub cancel L-7 [--reason TEXT]
  hub approve L-7 [--note TEXT] | hub reject L-7 --reason TEXT
                             Humans only, in a terminal: shows what you approve, then asks you to type L-7.
                             Credentials: ~/.config/agenthub/approver.json (chmod 600) or HUB_APPROVER + HUB_APPROVER_TOKEN
  hub lander | hub lander resume [--accept-trunk SHA]
                             The lander lease, standbys and pause flag; resume needs approver credentials and a terminal
  hub doctor                 Check the config (strictly), the hub, push access to land refs and git features
  hub sync [--merge] [--recover]
                             Bring the workspace up to trunk: fast-forward, or replay unlanded commits (one git reset --keep,
                             with a backup ref; never with uncommitted changes); --merge merges trunk into the branch instead;
                             --recover clears an interrupted sync's record once a human has looked

Configuration (env wins over files): HUB_URL (default http://127.0.0.1:7077), HUB_AGENT, HUB_PROJECT,
HUB_TOKEN, HUB_FAIL_CLOSED, HUB_TIMEOUT_MS; files: <worktree>/.hub.json, ~/.config/agenthub/config.json
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

/** Flush output, then exit without waiting for idle HTTP keep-alive sockets. */
async function finish(out: { stdout?: string; stderr?: string; exitCode: number }): Promise<void> {
  if (out.stderr) await write(process.stderr, out.stderr);
  if (out.stdout) await write(process.stdout, out.stdout.endsWith('\n') ? out.stdout : `${out.stdout}\n`);
  process.exit(out.exitCode);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      return runMcp();
    }
    case 'hook': {
      const io = { stdin: await readStdin(), cwd: process.cwd(), env: process.env };
      const hooks = await import('./hooks.js');
      if (rest[0] === 'pre-edit') return finish(await hooks.preEditHook(io));
      if (rest[0] === 'post-edit') return finish(await hooks.postEditHook(io));
      if (rest[0] === 'settle') return finish(await hooks.settleHook(io));
      if (rest[0] === 'digest') return finish(await hooks.digestHook(io));
      return finish({ stderr: 'usage: hub hook pre-edit | post-edit | settle | digest\n', exitCode: 2 });
    }
    case 'guard': {
      const { guard, prePushGuard } = await import('./guard.js');
      if (rest.includes('--pre-push')) return finish(prePushGuard({ cwd: process.cwd(), env: process.env, stdin: await readStdin() }));
      return finish(await guard({ cwd: process.cwd(), env: process.env, sequencer: rest.includes('--sequencer'), merge: rest.includes('--merge') }));
    }
    case 'init': {
      const { values } = parseArgs({
        args: rest,
        options: {
          agent: { type: 'string' },
          project: { type: 'string' },
          url: { type: 'string' },
          command: { type: 'string' },
          'no-hooks': { type: 'boolean' },
          'no-mcp': { type: 'boolean' },
          'no-guard': { type: 'boolean' },
        },
      });
      const { init } = await import('./init.js');
      const report = init({
        cwd: process.cwd(),
        agent: values.agent,
        project: values.project,
        url: values.url,
        command: values.command,
        hooks: !values['no-hooks'],
        mcp: !values['no-mcp'],
        guard: !values['no-guard'],
        env: process.env,
      });
      return finish({ stdout: report.map((l) => `hub init: ${l}`).join('\n'), exitCode: 0 });
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return finish({ stdout: HELP, exitCode: 0 });
    default: {
      const { human } = await import('./human.js');
      return finish(await human(cmd, rest));
    }
  }
}

main(process.argv.slice(2)).catch((err: Error) => finish({ stderr: `hub: ${err.message}\n`, exitCode: 1 }));
