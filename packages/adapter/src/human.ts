import { parseArgs } from 'node:util';
import { landRef } from '@agenthub/contract';
import { gitops } from '@agenthub/gitops';
import type { Landing, LandingStats, TaskStatus } from '@agenthub/hub/protocol';
import { approverCredentials, decideCommand, landerCommand, processTerminal } from './approve.js';
import { HubApiError, HubClient, classifyFailure } from './client.js';
import { hasOwnSettings, loadConfig, teamSections, type HubConfig } from './config.js';
import { claimNames, formatConflict, formatDecision, formatMessage, formatTask, landingLine, landingsText, statsText, statusText, syncToolText, UNTRUSTED_NOTE, whoUsesText } from './format.js';
import { whoUses } from './impact.js';
import { claimKey, lendIdentity, lendingSessions } from './checkout.js';
import { fullHead, headCommit } from './git.js';
import { commitGuardOff } from './guard-status.js';
import { landWork, renderLanding } from './land.js';
import { adoptClaims } from './pending.js';
import { syncWorkspace } from './sync.js';
import { claimTargets, splitTarget, symbolsModule, targetEntries } from './symbol-scope.js';
import type { HookOutcome } from './hooks.js';

const ok = (stdout: string): HookOutcome => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): HookOutcome => ({ stdout: '', stderr: `${stderr}\n`, exitCode });

/** Commands people run by hand (`hub status`, `hub task add ...`). Same API as the MCP tools. */
export async function human(cmd: string, argv: string[]): Promise<HookOutcome> {
  const loaded = loadConfig();
  // In a checkout with no identity of its own, the session's that edits in it (as for the edit hook and the guard).
  const cfg = loaded.root ? lendIdentity(loaded, process.env, [process.env.CLAUDE_PROJECT_DIR, ...lendingSessions(loaded.root, process.env.CLAUDE_CODE_SESSION_ID)]) : loaded;
  try {
    return await command(cfg, cmd, argv);
  } catch (err) {
    // A token the config withheld from this hub comes back as an auth error: say why.
    if (err instanceof HubApiError && (err.status === 401 || err.status === 403) && cfg.warnings.length) {
      return fail([`hub: ${err.message}`, ...cfg.warnings.map((w) => `hub: warning: ${w}`)].join('\n'));
    }
    throw err;
  }
}

async function command(cfg: HubConfig, cmd: string, argv: string[]): Promise<HookOutcome> {
  const client = new HubClient(cfg);
  const need = () => {
    if (!cfg.agent) throw new Error('no agent identity: set HUB_AGENT=human/agent or run `hub init --agent human/agent`');
  };
  // Keyed as the edit hook keys them (see claimKey).
  const files = (paths: string[]) => paths.map((f) => (cfg.root ? claimKey(f, process.cwd(), cfg, process.env) : f.normalize('NFC')));

  switch (cmd) {
    case 'whoami': {
      // Whether git runs the commit guard here: a hook manager can take it out without a word.
      const guard = cfg.root && hasOwnSettings(cfg.root) ? (commitGuardOff(cfg.root) ?? 'on') : undefined;
      return ok(JSON.stringify({ ...cfg, token: cfg.token ? '(set)' : null, ...(guard ? { commitGuard: guard } : {}) }, null, 2));
    }

    case 'status':
      return ok(statusText(await client.status(), cfg.agent, viewOptions(cfg)));

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
      // FILE or FILE#Symbol (Phase 3): a declaration is claimed with this adapter's mapper.
      const targets = claimTargets(positionals, process.cwd(), (f) => files([f])[0]!);
      const mapper = targets.some((t) => t.symbol !== null) ? (await symbolsModule())?.MAPPER_VERSION : undefined;
      if (targets.some((t) => t.symbol !== null) && !mapper) return fail('symbol claims (FILE#Symbol) need @agenthub/symbols, which could not be loaded; claim the whole file');
      const res = await client.claim({
        ...(mapper ? { scope: targetEntries(targets), mapper } : { files: targets.map((t) => t.file) }),
        intent: values.intent,
        mode: values.shared ? 'shared' : 'exclusive',
        queue: values.queue ?? false,
        base_commit: cfg.root ? (headCommit(cfg.root) ?? undefined) : undefined,
      });
      adoptClaims(cfg.root, res.claims);
      if (res.status === 'denied') {
        return fail(`denied: ${res.conflicts.map((c) => formatConflict(c, res.now)).join('; ')}`);
      }
      const c = res.claim!;
      return ok(`${res.status}${res.renewed ? ' (renewed)' : ''}: ${c.id} ${claimNames(c)} [${c.mode}] "${c.intent}"`);
    }

    case 'release': {
      const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: 'boolean' }, claim: { type: 'string' } } });
      need();
      const symbolic = positionals.filter((f) => splitTarget(f, process.cwd()).symbol !== null);
      if (symbolic.length) return fail(`release takes files or --claim C-n, not a declaration (${symbolic.join(', ')}): release the claim that holds it with --claim`, 2);
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
      const { values } = parseArgs({
        args: argv,
        options: { task: { type: 'string' }, summary: { type: 'string' }, 'allow-untracked': { type: 'boolean' }, wait: { type: 'boolean' } },
      });
      need();
      const out = await landWork(
        { cfg, client, feed: null },
        {
          task_id: values.task,
          summary: values.summary,
          allow_untracked: values['allow-untracked'],
          wait_s: values.wait ? 600 : undefined,
          untrackedRetry: 'run hub land --allow-untracked',
        },
      );
      return out.error ? fail(out.text) : ok(out.text);
    }

    case 'landings': {
      const { values } = parseArgs({
        args: argv,
        options: { all: { type: 'boolean' }, watch: { type: 'boolean' }, stats: { type: 'boolean' }, days: { type: 'string' } },
      });
      const days = values.days === undefined ? undefined : Number(values.days);
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) return fail('--days must be a whole number from 1 to 365', 2);
      const { trunk, check } = viewOptions(cfg);
      if (values.stats) return ok(statsText(await client.landingStats(days), trunk));
      const render = async (): Promise<string> => {
        const status = await client.status();
        const recent = await client.landings({ statuses: ['landed', 'failed', 'cancelled', 'superseded'], limit: values.all ? 50 : 5 });
        let stats: LandingStats | null = null;
        try {
          stats = await client.landingStats(days);
        } catch {
          // the header goes without it
        }
        return landingsText({ project: status.project, trunk, check, queue: status.queue ?? [], recent, lander: status.lander, control: status.control, stats, now: status.now });
      };
      if (!values.watch) return ok(await render());
      // Until interrupted: the view again whenever a landing, the lander or trunk changes.
      for (;;) {
        process.stdout.write(`${await render()}\n\n`);
        let since = await client.latestSeq();
        for (;;) {
          const page = await client.events(since, 60_000);
          since = page.next_since ?? page.seq;
          if (page.events.some((e) => e.type.startsWith('landing.') || e.type.startsWith('lander.') || e.type === 'trunk.moved')) break;
        }
      }
    }

    case 'landing': {
      const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { log: { type: 'boolean' } } });
      if (positionals.length !== 1) return fail('usage: hub landing L-7 [--log]', 2);
      const l = await client.landing(positionals[0]);
      return ok(await renderLanding({ cfg, client, feed: null }, l, { log: values.log ? 'full' : 'tail' }));
    }

    case 'cancel': {
      const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { reason: { type: 'string' } } });
      if (positionals.length !== 1) return fail('usage: hub cancel L-7 [--reason TEXT]', 2);
      const id = positionals[0];
      const target = await client.landing(id);
      let l: Landing;
      try {
        // Its author cancels as the agent; anyone else needs an approver's credentials.
        if (target.agent === cfg.agent) l = await client.cancel(id, { reason: values.reason });
        else {
          let creds;
          try {
            creds = approverCredentials(process.env);
          } catch (err) {
            return fail(`${id} is ${target.agent}'s landing: cancelling it needs its author or an approver's credentials (${(err as Error).message})`);
          }
          l = await client.cancel(id, { reason: values.reason }, creds);
        }
      } catch (err) {
        if (err instanceof HubApiError && err.code === 'too_late') return fail(`${id} is being pushed to trunk right now, so it can't be cancelled; wait a few seconds.`);
        throw err;
      }
      return ok(`cancelled: ${landingLine(l, Date.now(), viewOptions(cfg).trunk)}`);
    }

    case 'approve':
    case 'reject': {
      const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { note: { type: 'string' }, reason: { type: 'string' } } });
      return decideCommand(cfg, client, positionals[0], { decision: cmd, note: values.note, reason: values.reason, env: process.env, term: processTerminal() });
    }

    case 'lander': {
      const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'accept-trunk': { type: 'string' } } });
      return landerCommand(client, { sub: positionals[0], acceptTrunk: values['accept-trunk'], env: process.env, term: processTerminal() });
    }

    case 'sync': {
      const { values } = parseArgs({ args: argv, options: { merge: { type: 'boolean' }, recover: { type: 'boolean' } } });
      need();
      if (!cfg.root) return fail('hub sync: not in a git checkout', 2);
      const r = await syncWorkspace(cfg.root, cfg, client, { reason: 'explicit', mode: values.merge ? 'merge' : 'update', recover: values.recover });
      const text = syncToolText(r);
      // Exit 0 when the workspace is where it should be (or was left alone on purpose, dirty); 1 when the sync couldn't do its job.
      const fine = r.kind === 'up_to_date' || r.kind === 'synced' || r.kind === 'merged' || r.kind === 'behind_dirty' || (r.kind === 'needs_human' && r.cleared);
      return fine ? ok(text) : fail(text);
    }

    case 'uses': {
      // `hub uses src/auth.ts#login`: who_uses from a terminal (design §2.3.7).
      if (argv.length !== 1) return fail('usage: hub uses FILE#Symbol (one declaration, e.g. src/auth.ts#login)', 2);
      if (!cfg.root) return fail('hub uses: not in a git checkout', 2);
      const [t] = claimTargets(argv, process.cwd(), (f) => files([f])[0]!);
      if (!t || t.symbol === null) return fail(`hub uses takes FILE#Symbol, one declaration (e.g. src/auth.ts#login), not a whole file: ${argv[0]}`, 2);
      return ok(whoUsesText(await whoUses(cfg.root, { file: t.file, symbol: t.symbol }, { me: cfg.agent, claims: () => client.claims() })));
    }

    case 'doctor':
      return doctor(cfg, client);

    default:
      return fail(`unknown command "${cmd}"; run hub --help`, 2);
  }
}

/** The trunk name and check command for queue views, from trunk's agenthub.json (lenient: a view never fails over it). */
function viewOptions(cfg: HubConfig): { trunk: string; check: string | null } {
  const land = cfg.root ? teamSections(cfg.root, { strict: false }).sections.land : null;
  return { trunk: land?.trunk ?? 'main', check: land?.check ?? null };
}

/**
 * `hub doctor`: one line per check, exit 1 on any failure. The config
 * (strict, as land reads it), the hub, push access to the land refs, and the
 * git features sync needs.
 */
async function doctor(cfg: HubConfig, client: HubClient): Promise<HookOutcome> {
  const lines: string[] = [];
  let failed = false;
  const good = (s: string) => lines.push(`ok    ${s}`);
  const warn = (s: string) => lines.push(`warn  ${s}`);
  const bad = (s: string) => {
    failed = true;
    lines.push(`FAIL  ${s}`);
  };
  if (cfg.agent) good(`identity ${cfg.agent} in project ${cfg.project}`);
  else warn('no agent identity in this checkout: run `hub init --agent <human>/<agent>` (land needs one)');
  for (const w of cfg.warnings) warn(w);
  if (!cfg.root) {
    bad('not in a git checkout');
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 1 };
  }
  let land: ReturnType<typeof teamSections>['sections']['land'] = null;
  try {
    const team = teamSections(cfg.root, { strict: true });
    land = team.sections.land;
    if (land) good(`${team.where}: landing queue on (trunk ${land.remote}/${land.trunk}, check \`${land.check}\`)`);
    else good(`${team.where === cfg.root ? 'agenthub.json' : team.where}: no "land" section, so land records the landing (Phase 1)`);
    if (team.source === 'worktree') warn(`read this checkout's agenthub.json: there is no fetched copy on ${team.remote}/${team.trunk} (git fetch ${team.remote})`);
  } catch (err) {
    bad(`config: ${(err as Error).message}`);
  }
  try {
    const s = await client.status();
    good(`hub ${cfg.url} answers${s.lander ? ` (lander ${s.lander.holder} active)` : ' (no lander is running: landings wait)'}`);
  } catch (err) {
    bad(`hub ${cfg.url}: ${classifyFailure(err, cfg).message}`);
  }
  const g = gitops.open(cfg.root, { isolated: false });
  if (land) {
    const head = fullHead(cfg.root);
    if (!head) warn('no commit yet, so push access to the land refs was not probed');
    else {
      const ref = landRef(land.refPrefix, head);
      const r = await g.run(['push', '--dry-run', '--porcelain', land.remote, `${head}:${ref}`], { timeoutMs: 30_000, ok: [0, 1, 128] }).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));
      if (r.code === 0) good(`can push land refs to ${land.remote} (${land.refPrefix}land/…, dry run)`);
      else bad(`can't push ${ref} to ${land.remote}: ${r.stderr.split('\n').find((l) => l.trim() && !l.startsWith('hint:'))?.trim() ?? `git push exited ${r.code}`}. If the host refuses custom ref namespaces, set land.refPrefix to "refs/heads/agenthub/"`);
    }
  }
  const features = await gitops.features(g).catch(() => ({ mergeTreeBase: false, attrSource: false }));
  if (features.mergeTreeBase) good('git merge-tree --write-tree --merge-base works: sync can replay your unlanded commits onto trunk');
  else warn('git is older than 2.40 (no merge-tree --merge-base): sync only fast-forwards; upgrade git for replays');
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: failed ? 1 : 0 };
}
