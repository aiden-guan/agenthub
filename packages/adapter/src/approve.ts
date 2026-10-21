// `hub approve`, `hub reject` and `hub lander resume`: what only a human may do
// (design §1.4 "Approvals", §2.3.7, §3.7). They need an interactive terminal
// on stdin and stdout and the human's own approver token, which never lives in
// a repository or an agent's configuration. Approve and reject fetch what the
// human approves, show exactly that, recompute the digest the hub holds, and
// ask the human to type the landing id before anything is sent.

import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_REF_PREFIX, landRef } from '@agenthub/contract';
import { gitops, type Git } from '@agenthub/gitops';
import type { ApprovalRequirement, Landing } from '@agenthub/hub/protocol';
import { HubApiError, type ApproverCredentials, type HubClient } from './client.js';
import { teamSections, type HubConfig } from './config.js';
import { landingLine, landerText, showNames } from './format.js';

/** The terminal a human types into. Tests can't fake it in-process: the CLI checks the real one. */
export interface Terminal {
  isTTY: boolean;
  write(text: string): void;
  /** One line typed by the human (without the newline). */
  ask(prompt: string): Promise<string>;
}

export function processTerminal(): Terminal {
  return {
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    write: (text) => void process.stdout.write(text),
    ask: (prompt) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let answered = false;
        rl.question(prompt, (answer) => {
          answered = true;
          rl.close();
          resolve(answer);
        });
        rl.on('close', () => {
          if (!answered) resolve('');
        });
      }),
  };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const done = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const refuse = (stderr: string, exitCode = 1): CommandResult => ({ stdout: '', stderr: `hub: ${stderr}\n`, exitCode });

const NO_TTY =
  'needs an interactive terminal (a TTY on stdin and stdout): approvals come from a human, never from an agent or a script. Run it yourself in a terminal.';

/** Where a human's approver credentials live: `$XDG_CONFIG_HOME/agenthub/approver.json`, else `~/.config/agenthub/approver.json`. */
export function approverFile(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config'), 'agenthub', 'approver.json');
}

/**
 * `{name, token}` from HUB_APPROVER and HUB_APPROVER_TOKEN, else from the
 * approver file, which is refused unless only its owner can read it (0600).
 * Throws an Error that says what to do.
 */
export function approverCredentials(env: NodeJS.ProcessEnv): ApproverCredentials {
  if (env.HUB_APPROVER || env.HUB_APPROVER_TOKEN) {
    if (!env.HUB_APPROVER || !env.HUB_APPROVER_TOKEN) throw new Error('set both HUB_APPROVER and HUB_APPROVER_TOKEN, or neither (and use the approver file)');
    return checkName({ name: env.HUB_APPROVER, token: env.HUB_APPROVER_TOKEN }, 'HUB_APPROVER');
  }
  const file = approverFile(env);
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new Error(`no approver credentials: put {"name": "<you>", "token": "<your approver token>"} in ${file} (chmod 600), or set HUB_APPROVER and HUB_APPROVER_TOKEN`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by others (mode ${(mode & 0o777).toString(8).padStart(4, '0')}); it holds your approver token. Run: chmod 600 ${JSON.stringify(file)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; it must hold {"name": "<you>", "token": "<your approver token>"}`);
  }
  const v = value as { name?: unknown; token?: unknown } | null;
  if (!v || typeof v.name !== 'string' || typeof v.token !== 'string' || !v.token) throw new Error(`${file} must hold {"name": "<you>", "token": "<your approver token>"}`);
  return checkName({ name: v.name, token: v.token }, file);
}

function checkName(c: ApproverCredentials, from: string): ApproverCredentials {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.name)) throw new Error(`${from}: the approver name must be a human's name such as maya (the part before the / of an agent id)`);
  return c;
}

/** What each pending requirement covers, fetched and shown, with the digest recomputed from it. */
interface Shown {
  req: ApprovalRequirement;
  digest: string;
  diff: string;
}

/**
 * `hub approve L-7 [--note N]` / `hub reject L-7 --reason R`. Order matters:
 * the terminal check and the credentials come before anything is fetched, and
 * nothing is sent until the digests match and the human typed the id.
 */
export async function decideCommand(
  cfg: HubConfig,
  client: HubClient,
  id: string | undefined,
  o: { decision: 'approve' | 'reject'; note?: string; reason?: string; env: NodeJS.ProcessEnv; term: Terminal },
): Promise<CommandResult> {
  const verb = o.decision;
  if (!id) return refuse(verb === 'approve' ? 'usage: hub approve L-7 [--note TEXT]' : 'usage: hub reject L-7 --reason TEXT', 2);
  if (!o.term.isTTY) return refuse(`hub ${verb} ${NO_TTY}`);
  if (verb === 'reject' && !o.reason?.trim()) return refuse('hub reject needs --reason TEXT: the agent is told why', 2);
  let creds: ApproverCredentials;
  try {
    creds = approverCredentials(o.env);
  } catch (err) {
    return refuse((err as Error).message);
  }
  if (!cfg.root) return refuse(`hub ${verb} runs in a checkout of the repository, so it can fetch and show what you ${verb}`);

  const landing = await client.landing(id);
  if (['landed', 'failed', 'cancelled', 'superseded', 'recorded'].includes(landing.status)) return refuse(`${landingLine(landing, Date.now())}: there is nothing to ${verb}.`);
  if (landing.approval.length === 0) return refuse(`${id} has no approval pending (${landingLine(landing, Date.now())}).`);

  const g = gitops.open(cfg.root, { isolated: false });
  let shown: Shown[];
  try {
    shown = await fetchAndShow(g, cfg, landing);
  } catch (err) {
    return refuse(`could not fetch what ${id} would land: ${(err as Error).message}`);
  }
  for (const s of shown) {
    o.term.write(`\n=== ${s.req.kind} approval of ${showNames(s.req.paths)} (${describeKind(s.req.kind)})\n${s.diff || '(no textual difference)'}\n`);
  }
  const stale = shown.filter((s) => s.digest !== s.req.digest);
  if (stale.length) {
    return refuse(
      `the content doesn't match what the hub asks you to ${verb} (${stale.map((s) => s.req.kind).join(', ')}: digest ${stale[0].digest.slice(0, 12)} here, ${stale[0].req.digest.slice(0, 12)} at the hub). ` +
        `The landing changed or the fetch is stale; nothing was sent. Run hub ${verb} ${id} again.`,
    );
  }
  o.term.write(`\n${landingLine(landing, Date.now())}, by ${landing.agent}.\n`);
  const typed = (await o.term.ask(`Type ${id} to ${verb} it as ${creds.name} (anything else cancels): `)).trim();
  if (typed !== id) return refuse(`not ${verb === 'approve' ? 'approved' : 'rejected'}: you typed ${JSON.stringify(typed)}, not ${id}. Nothing was sent.`);

  if (verb === 'reject') {
    try {
      const after = await client.reject(id, { reason: o.reason!.trim() }, creds);
      return done(`Rejected ${id} as ${creds.name}. Now: ${landingLine(after, Date.now())}. ${landing.agent} is told why.`);
    } catch (err) {
      if (err instanceof HubApiError) return refuse(`the hub refused: ${err.message} (${err.code})`);
      throw err;
    }
  }
  // Each requirement is its own approval: one a rule doesn't let this human give leaves the others standing.
  let after: Landing = landing;
  const approved: string[] = [];
  const refused: string[] = [];
  for (const s of shown) {
    const what = `${s.req.kind}: ${showNames(s.req.paths)}`;
    try {
      after = await client.approve(id, { kind: s.req.kind, digest: s.req.digest, note: o.note }, creds);
      approved.push(what);
    } catch (err) {
      if (!(err instanceof HubApiError)) throw err;
      refused.push(`${what}: the hub refused: ${err.message} (${err.code})`);
    }
  }
  const lines = approved.length ? [`Approved ${id} (${approved.join('; ')}) as ${creds.name}. Now: ${landingLine(after, Date.now())}.`] : [];
  if (refused.length) lines.push(`Not approved: ${refused.join('; ')}`);
  return refused.length ? { stdout: approved.length ? `${lines[0]}\n` : '', stderr: `hub: ${lines[lines.length - 1]}\n`, exitCode: 1 } : done(lines.join('\n'));
}

function describeKind(kind: ApprovalRequirement['kind']): string {
  if (kind === 'protected') return "the agent's own change to protected paths";
  if (kind === 'merged') return 'the merged content: trunk changed these paths too';
  return "the AI resolver's merge of a conflict";
}

/**
 * Fetch the land ref (and the staged candidate and trunk where a requirement
 * needs them) into the object database, without creating refs, then show
 * each requirement's diff and recompute its digest over exactly those blobs.
 */
async function fetchAndShow(g: Git, cfg: HubConfig, l: Landing): Promise<Shown[]> {
  const land = teamSections(cfg.root!, { strict: false }).sections.land;
  const remote = land?.remote ?? 'origin';
  const prefix = land?.refPrefix ?? DEFAULT_REF_PREFIX;
  if (!l.commit) throw new Error(`${l.id} names no commit`);
  const refs = [landRef(prefix, l.commit)];
  // The staged candidate only where a requirement covers it (merged content, an AI resolution).
  for (const r of l.approval) {
    const ref = r.kind === 'protected' ? null : (r.candidate_ref ?? l.candidate_ref);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  if (land) refs.push(`+refs/heads/${land.trunk}:refs/remotes/${remote}/${land.trunk}`);
  await g.run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, ...refs], { timeoutMs: 60_000 });

  const blob = (rev: string | null, p: string) => (rev ? gitops.blobId(g, rev, p) : Promise.resolve(null));
  const diff = async (a: string, b: string, paths: string[]) => (await g.run(['diff', '--no-color', '--no-ext-diff', a, b, '--', ...paths])).stdout;
  const out: Shown[] = [];
  for (const req of l.approval) {
    const paths = req.paths;
    if (req.kind === 'protected') {
      if (!l.base_sha) throw new Error(`${l.id} has no base yet (it hasn't been admitted)`);
      const entries = await Promise.all(paths.map(async (p) => ({ path: p, blobs: [await blob(l.base_sha, p), await blob(l.commit, p)] })));
      out.push({ req, digest: gitops.approvalDigest('protected', entries), diff: await diff(l.base_sha, l.commit, paths) });
    } else {
      const candidate = req.candidate ?? l.candidate;
      const trunkBase = req.trunk_base ?? l.trunk_base;
      if (!candidate || !trunkBase) throw new Error(`the ${req.kind} requirement of ${l.id} names no candidate`);
      if (req.kind === 'merged') {
        const entries = await Promise.all(paths.map(async (p) => ({ path: p, blobs: [await blob(trunkBase, p), await blob(candidate, p)] })));
        out.push({ req, digest: gitops.approvalDigest('merged', entries), diff: await diff(trunkBase, candidate, paths) });
      } else {
        const entries = await Promise.all(
          paths.map(async (p) => ({ path: p, blobs: [await blob(l.base_sha, p), await blob(trunkBase, p), await blob(l.commit, p), await blob(candidate, p)] })),
        );
        const shownDiff = `--- the resolution against trunk:\n${await diff(trunkBase, candidate, paths)}\n--- the resolution against the change:\n${await diff(l.commit, candidate, paths)}`;
        out.push({ req, digest: gitops.approvalDigest('ai_resolution', entries), diff: shownDiff });
      }
    }
  }
  return out;
}

/** `hub lander`: the lease, standbys, the pause flag. `hub lander resume [--accept-trunk SHA]`: an approver, from a terminal. */
export async function landerCommand(
  client: HubClient,
  args: { sub?: string; acceptTrunk?: string; env: NodeJS.ProcessEnv; term: Terminal },
): Promise<CommandResult> {
  if (args.sub === undefined) {
    const { lease, control } = await client.lander();
    return done(landerText(lease, control, Date.now()));
  }
  if (args.sub !== 'resume') return refuse('usage: hub lander [resume [--accept-trunk SHA]]', 2);
  if (!args.term.isTTY) return refuse(`hub lander resume ${NO_TTY}`);
  let creds: ApproverCredentials;
  try {
    creds = approverCredentials(args.env);
  } catch (err) {
    return refuse((err as Error).message);
  }
  const { lease, control } = await client.lander();
  args.term.write(`${landerText(lease, control, Date.now())}\n`);
  if (!control.paused) return done('Landing is not paused; nothing to resume.');
  const typed = (await args.term.ask(`Type resume to let the landing queue run again${args.acceptTrunk ? ` from trunk ${args.acceptTrunk}` : ''} (anything else cancels): `)).trim();
  if (typed !== 'resume') return refuse('not resumed; nothing was sent.');
  try {
    const res = await client.landerResume(args.acceptTrunk ? { accept_trunk: args.acceptTrunk } : {}, creds);
    return done(`Resumed by ${creds.name}.\n${landerText(lease, res.control, Date.now())}`);
  } catch (err) {
    if (err instanceof HubApiError) return refuse(`the hub refused: ${err.message} (${err.code})`);
    throw err;
  }
}
