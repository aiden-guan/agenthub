// The `land` tool and `hub land` (design §2.3.2): the local preflight, the
// push of the land ref, and the queue request; plus waiting for a landing and
// the context its fix-it brief needs (§2.3.3). Every refusal sends nothing:
// no push, no hub request.

import { landRef, protectedMatches, humanOf } from '@agenthub/contract';
import { gitops, GitError, type Git } from '@agenthub/gitops';
import type { ClaimConflict, HubEvent, Landing, LandResult, ScopeEntry } from '@agenthub/hub/protocol';
import { HubApiError, HubUnavailableError, type HubClient } from './client.js';
import { AGENT_ID_RE, teamSections, type HubConfig, type TeamConfig } from './config.js';
import { Feed } from './feed.js';
import {
  landConflictText,
  landHubRefusedText,
  landingBrief,
  landPhase1HubText,
  landQueuedText,
  landRecordedText,
  landRefusal,
  showName,
  type BriefContext,
  type LandContext,
  type OtherLanding,
} from './format.js';
import { currentBranch, fullHead, gitOperation, headCommit } from './git.js';
import { MAX_LAND_SYMBOL_ENTRIES, diffScope } from './symbol-scope.js';

export interface LandDeps {
  cfg: HubConfig;
  client: HubClient;
  /** The MCP server's live feed: told about the hold claims, and used to wait. Null: waits long-poll. */
  feed: Feed | null;
}

export interface LandOptions {
  task_id?: string;
  /** At most 4000 characters; defaults to the task title, else the commit's subject. */
  summary?: string;
  /** Land although untracked, non-ignored files exist (they don't land). */
  allow_untracked?: boolean;
  /** Wait up to this many seconds for the result, as hub_wait {landing_id} does. */
  wait_s?: number;
  /** How the untracked-files refusal says to go on anyway (the MCP argument, or the CLI flag). */
  untrackedRetry?: string;
}

/** What `land` answers: the text, and whether it is a refusal or a failure (nothing was queued). */
export interface LandOutcome {
  text: string;
  error: boolean;
  landing?: Landing;
}

/** Fetching trunk is bounded; a failure only makes the preview stale. */
const FETCH_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 60_000;
/** The hub refuses a land request naming more paths than this. */
const MAX_ADVISORY_FILES = 20_000;
/** Live and parked: what a wait for a landing ends on. */
const SETTLED = new Set(['landed', 'failed', 'cancelled', 'superseded', 'needs_approval', 'recorded']);

const refused = (text: string): LandOutcome => ({ text, error: true });

/**
 * The land tool. With a `land` section in trunk's agenthub.json: the
 * preflight (git operation, uncommitted and untracked files, fetch, landed
 * base, the preview), the push of `<P>land/<HEAD>`, then `POST /land
 * {queue: true}`. Without one: Phase 1 record mode.
 */
export async function landWork(deps: LandDeps, opts: LandOptions): Promise<LandOutcome> {
  const root = deps.cfg.root;
  if (!root) return refused('This is not a git checkout, so there is nothing to land.');
  let team: TeamConfig;
  try {
    team = teamSections(root, { strict: true });
  } catch (err) {
    return refused(landRefusal.config((err as Error).message));
  }
  try {
    if (team.sections.land) return await queueMode(deps, opts, team, null);
    // This checkout's copy of trunk may predate a land section: decide on trunk as it is now, which
    // is what the lander reads, so record mode never marks a task done that should have been queued.
    const g = gitops.open(root, { isolated: false });
    const fetched: Fetched = { remote: team.remote, trunk: team.trunk, error: await fetchTrunk(g, team.remote, team.trunk) };
    if (fetched.error === null) {
      try {
        team = teamSections(root, { strict: true });
      } catch (err) {
        return refused(landRefusal.config((err as Error).message));
      }
    }
    if (team.sections.land) return await queueMode(deps, opts, team, fetched);
    return await recordMode(deps, opts, fetched);
  } catch (err) {
    // A git command failed (not the push, whose outcome is classified): nothing was queued.
    if (err instanceof GitError) return refused(`git failed (${gitMessage(err)}); nothing was queued.`);
    throw err;
  }
}

/** A fetch of trunk made before the mode was chosen: from where, and its error (null: it worked). */
interface Fetched {
  remote: string;
  trunk: string;
  error: string | null;
}

/**
 * Phase 1: record the landing, mark the task done, release the claims. Only
 * once trunk (fetched just before, when that worked) has no land section; a
 * project with a lander refuses it.
 */
async function recordMode(deps: LandDeps, opts: LandOptions, fetched: Fetched): Promise<LandOutcome> {
  const { cfg, client } = deps;
  const root = cfg.root!;
  try {
    const res = await client.land({
      task_id: opts.task_id,
      summary: opts.summary,
      branch: currentBranch(root) ?? undefined,
      commit: headCommit(root) ?? undefined,
    });
    return { text: landRecordedText(res), error: false, landing: res.landing };
  } catch (err) {
    if (!(err instanceof HubApiError) || err.code !== 'landing_queue_active') throw err;
    // The project lands through the queue, but trunk as fetched has no land section this CLI reads.
    return refused(landRefusal.queueActive(fetched.error));
  }
}

async function queueMode(deps: LandDeps, opts: LandOptions, first: TeamConfig, fetched: Fetched | null): Promise<LandOutcome> {
  const { cfg, client } = deps;
  const root = cfg.root!;
  const agent = cfg.agent!;
  const { remote, trunk } = first.sections.land!;

  // 1. A git operation in progress: its HEAD is not the change.
  const op = gitOperation(root);
  if (op) return refused(landRefusal.operation(op));

  // 2. Uncommitted tracked changes don't land; untracked files would be left behind.
  const g = gitops.open(root, { isolated: false });
  const status = parseStatus((await g.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 60_000 })).stdout);
  if (status.tracked.length) return refused(landRefusal.dirty(status.tracked));
  if (status.untracked.length && !opts.allow_untracked) {
    return refused(landRefusal.untracked(status.untracked, opts.untrackedRetry ?? 'land again with allow_untracked: true'));
  }

  // 3. Fetch trunk (bounded; not again if the mode was chosen on a fetch of it just now); on failure,
  // go on with the last fetched copy and say the preview may be stale.
  const warnings: string[] = [];
  const fetchError = fetched && fetched.remote === remote && fetched.trunk === trunk ? fetched.error : await fetchTrunk(g, remote, trunk);
  const trackRef = `refs/remotes/${remote}/${trunk}`;
  const trunkSha = await gitops.revParse(g, trackRef);
  if (!trunkSha) return refused(landRefusal.noTrunk(remote, trunk, fetchError ?? `${remote} has no branch ${trunk}`));
  let team = first;
  if (fetchError) {
    warnings.push(`fetching ${trunk} from ${remote} failed (${fetchError}), so this preview compared against the copy of ${trunk} fetched earlier and may be stale.`);
  } else {
    // The configuration from the trunk just fetched: that is what the lander will use.
    try {
      team = teamSections(root, { strict: true });
    } catch (err) {
      return refused(landRefusal.config((err as Error).message));
    }
    if (!team.sections.land) return recordMode(deps, opts, { remote, trunk, error: null });
  }
  const land = team.sections.land!;

  // 4. What lands: the landed base (design §1.1) to HEAD.
  const head = fullHead(root);
  if (!head) return refused('This branch has no commits yet, so there is nothing to land. Nothing was pushed or queued.');
  let base: string;
  try {
    base = (await gitops.landedBase(g, trunkSha, head)).base;
  } catch (err) {
    return refused(`HEAD shares no history with ${remote}/${trunk} (${gitMessage(err)}), so it can't land there. Nothing was pushed or queued.`);
  }
  const files = await gitops.diffNames(g, base, head);
  if (files.length === 0) return refused(landRefusal.nothing(trunk));

  // 5. The preview, all of it advisory: conflicts git already sees, with who caused them; protected paths.
  let conflicts: LandContext['conflicts'] = [];
  try {
    conflicts = await previewConflicts(g, trunkSha, head, base, cfg.project);
  } catch (err) {
    warnings.push(`the conflict preview failed (${gitMessage(err)}); the lander checks for conflicts itself.`);
  }
  const matches = protectedMatches(files, land.protected);
  const protectedPaths = [...new Set(matches.flatMap((m) => m.paths))].sort();
  const commits = Number((await g.run(['rev-list', '--count', `${base}..${head}`])).stdout.trim()) || 1;
  const symbols = await landScope(root, base, head, team);

  // 6. Push the land ref: a plain push of a name that is its own content, never forced.
  const ref = landRef(land.refPrefix, head);
  let pushed: Awaited<ReturnType<typeof gitops.pushRef>>;
  try {
    pushed = await gitops.pushRef(g, { remote: land.remote, prefix: land.refPrefix, sha: head, ref, timeoutMs: PUSH_TIMEOUT_MS });
  } catch (err) {
    return refused(landRefusal.pushFailed(gitMessage(err)));
  }
  if (pushed.kind !== 'ok' && pushed.kind !== 'up_to_date') return refused(landRefusal.pushFailed(pushed.detail));

  // 7. Queue it.
  const summary = opts.summary ?? (await defaultSummary(client, root, opts.task_id));
  let res: LandResult;
  try {
    res = await client.land({
      queue: true,
      commit: head,
      branch: currentBranch(root) ?? undefined,
      task_id: opts.task_id,
      summary,
      // Advisory (the lander recomputes them): at most what the hub takes.
      files: files.slice(0, MAX_ADVISORY_FILES),
      ...symbols,
      preview: { trunk_seen: trunkSha, conflicts: conflicts.map((c) => c.file), protected: protectedPaths },
    });
  } catch (err) {
    // Every refusal from here on says what to do, that nothing was queued, and that the pushed ref is harmless.
    if (err instanceof HubUnavailableError) {
      return refused(`${err.message}, so nothing was queued. Your commit is pushed (that is harmless); call land again once the hub is back: it is idempotent per commit.`);
    }
    if (!(err instanceof HubApiError)) throw err;
    if (err.code === 'claim_conflict') {
      const list = Array.isArray(err.details?.conflicts) ? (err.details.conflicts as ClaimConflict[]) : [];
      if (list.length) return refused(landConflictText(list, Date.now()));
    }
    // A token the config withheld from this hub comes back as an auth error: say why, as the other tools do.
    const why = err.status === 401 ? cfg.warnings.map((w) => ` ${w}`).join('') : '';
    return refused(`${landHubRefusedText(err, files)}${why}`);
  }
  if (res.landing.status === 'recorded') return refused(landPhase1HubText(res, cfg.url));
  deps.feed?.noteClaims(res.held);

  let running: LandContext['running'] = null;
  if (res.lander && res.landing.status !== 'running') {
    try {
      const [r] = await client.landings({ statuses: ['running'], limit: 1 });
      if (r && r.id !== res.landing.id) running = { id: r.id, phase: r.phase };
    } catch {
      // what the lander is doing is a nicety
    }
  }
  const approvers = approversFor(matches, agent);
  let text = landQueuedText(res, {
    project: cfg.project,
    trunk: land.trunk,
    check: land.check,
    commits,
    conflicts,
    protectedPaths,
    approvers,
    rules: [...new Set(matches.map((m) => m.rule))],
    running,
    keepPlaceRetries: land.keepPlaceRetries,
    warnings,
    structural: land.structural === 'auto',
    resolver: land.resolver.enabled,
  });
  if (opts.wait_s && opts.wait_s > 0) {
    const waited = await waitForLanding(deps, res.landing.id, opts.wait_s * 1000);
    text = `${text}\n\n${waited.text}`;
  }
  return { text, error: false, landing: res.landing };
}

/**
 * `git fetch <remote> +refs/heads/<trunk>:refs/remotes/<remote>/<trunk>`, bounded and never prompting
 * for credentials (a helper still answers); the first line of the error, or null.
 */
async function fetchTrunk(g: Git, remote: string, trunk: string): Promise<string | null> {
  try {
    await g.run(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${trunk}:refs/remotes/${remote}/${trunk}`], {
      timeoutMs: FETCH_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    return null;
  } catch (err) {
    return gitMessage(err);
  }
}

function gitMessage(err: unknown): string {
  if (err instanceof GitError) {
    if (err.timedOut) return `git ${err.args[0] ?? ''} got no answer in time`.replace('  ', ' ');
    const line = err.stderr.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('hint:'));
    if (line) return line;
  }
  return (err as Error).message ?? String(err);
}

/**
 * `git status --porcelain=v1 -z`: tracked changes as `XY path` (as `git status
 * --short` shows them), and untracked paths. Ignored files are not listed.
 */
export function parseStatus(out: string): { tracked: string[]; untracked: string[] } {
  const parts = out.split('\0');
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3).normalize('NFC');
    if (xy === '??') untracked.push(file);
    else if (xy !== '!!') {
      tracked.push(`${xy.trim()} ${showName(file)}`);
      // A rename or copy is followed by its source path.
      if (xy[0] === 'R' || xy[0] === 'C') i++;
    }
  }
  return { tracked, untracked };
}

/** Who may approve the protected paths the change touches: null when any approver may; the author's human left out where a rule says distinct. */
function approversFor(matches: ReturnType<typeof protectedMatches>, agent: string): string[] | null {
  const names = new Set<string>();
  for (const { rule } of matches) {
    if (rule.approvers === null) return null;
    for (const a of rule.approvers) if (!(rule.distinct && a === humanOf(agent))) names.add(a);
  }
  return [...names];
}

/** `<project>/L-7` from a trunk trailer, as `L-7`, when it names this project. */
function landingIdOf(value: string | null, project: string): string | null {
  if (!value || !value.startsWith(`${project}/`)) return null;
  const id = value.slice(project.length + 1);
  return /^L-\d+$/.test(id) ? id : null;
}

/** Paths git already sees conflicting with trunk, each with the trunk landings that changed it since the base. */
/**
 * Phase 3, advisory (design §2.3.2 steps 5 and 7; the lander maps the change
 * again at admission): the declarations the change touches, with this
 * adapter's mapper. With them the hub holds those declarations rather than
 * whole files, and the agent's own symbol claims carry into the holds as
 * symbols (the hub compares them under the request's mapper): without a
 * mapper every one of them would become its whole file, and collide with
 * other agents' claims on other declarations of those files. Files that
 * aren't mapped go in `files`, which the hub holds whole. Never fails a land.
 */
async function landScope(root: string, base: string, head: string, team: TeamConfig): Promise<{ scope?: ScopeEntry[]; mapper?: string }> {
  try {
    const mapped = await diffScope(root, base, head, { symbols: team.sections.symbols, wantMapper: true });
    if (!mapped.mapper) return {};
    // Whole files' worth of symbol entries, within what one request should carry.
    const byFile = new Map<string, ScopeEntry[]>();
    for (const e of mapped.scope) if (e.symbol !== undefined) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)!).push(e);
    const scope: ScopeEntry[] = [];
    for (const entries of byFile.values()) {
      if (scope.length + entries.length > MAX_LAND_SYMBOL_ENTRIES) break;
      scope.push(...entries);
    }
    return { ...(scope.length ? { scope } : {}), mapper: mapped.mapper };
  } catch {
    return {}; // the whole files, as in Phase 2
  }
}

async function previewConflicts(g: Git, trunkSha: string, head: string, base: string, project: string): Promise<LandContext['conflicts']> {
  const files = await gitops.forecastConflicts(g, trunkSha, head, base);
  if (files.length === 0) return [];
  const trailers = new Map((await gitops.trunkTrailers(g, base, trunkSha, 500)).map((t) => [t.sha, t]));
  const out: LandContext['conflicts'] = [];
  for (const file of files.slice(0, 20)) {
    const log = await g.run(['log', '--first-parent', '--format=%H', '-n5', `${base}..${trunkSha}`, '--', file]);
    const by: LandContext['conflicts'][number]['by'] = [];
    for (const sha of log.stdout.split('\n').filter(Boolean)) {
      const t = trailers.get(sha);
      const id = landingIdOf(t?.landing ?? null, project);
      const who = id && t?.agent && AGENT_ID_RE.test(t.agent) ? t.agent : null;
      if (!by.some((b) => b.landing_id === id && (id !== null || b.agent === null))) by.push({ landing_id: id, agent: who });
    }
    out.push({ file, by });
  }
  return out;
}

/** The task's title, else the commit's subject. */
async function defaultSummary(client: HubClient, root: string, taskId: string | undefined): Promise<string | undefined> {
  if (taskId) {
    try {
      const t = (await client.tasks()).find((x) => x.id === taskId);
      if (t) return t.title;
    } catch {
      // the hub answers the land request itself
    }
  }
  const g = gitops.open(root, { isolated: false });
  try {
    return (await g.run(['log', '-1', '--format=%s', 'HEAD'])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ waiting and the fix-it brief

/**
 * hub_wait {landing_id}: returns at once when the landing is terminal or
 * parked, else wakes on that landing's events until it is (or `timeoutMs`
 * passes), and renders it as landing_status does.
 */
export async function waitForLanding(deps: LandDeps, id: string, timeoutMs: number): Promise<{ text: string; landing: Landing | null }> {
  const { client } = deps;
  const waiter = deps.feed ?? new Feed(client);
  const deadline = Date.now() + timeoutMs;
  const started = await client.latestSeq();
  const mine = (e: HubEvent) => e.type.startsWith('landing.') && (e.data as Record<string, unknown>).landing_id === id;
  for (;;) {
    const restarts = waiter.restarts;
    const seq = await client.latestSeq();
    const l = await client.landing(id);
    if (SETTLED.has(l.status)) {
      deps.feed?.seenLanding(l); // the brief says it all: no notice of it on top
      return { text: await renderLanding(deps, l, { since: started }), landing: l };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { text: `Still waiting after ${Math.round(timeoutMs / 1000)}s. ${await renderLanding(deps, l, {})}`, landing: l };
    }
    const res = await waiter.waitFor(seq, mine, remaining, restarts);
    if (res.restarted) {
      return { text: `The hub came back with a different database while you waited, so ${id} is gone from it. Land again.`, landing: null };
    }
  }
}

/** A landing as landing_status shows it, with what its brief needs (the check command, the policy, other landings). */
export async function renderLanding(deps: LandDeps, l: Landing, o: { log?: 'tail' | 'full'; since?: number }): Promise<string> {
  return landingBrief(l, await briefContext(deps, l, o));
}

export async function briefContext(deps: LandDeps, l: Landing, o: { log?: 'tail' | 'full'; since?: number } = {}): Promise<BriefContext> {
  const { cfg, client } = deps;
  let land: TeamConfig['sections']['land'] = null;
  if (cfg.root) {
    try {
      land = teamSections(cfg.root, { strict: false }).sections.land;
    } catch {
      // lenient never throws; defaults below
    }
  }
  const ctx: BriefContext = {
    now: Date.now(),
    me: cfg.agent,
    trunk: land?.trunk ?? 'main',
    check: land?.check ?? null,
    keepPlaceRetries: land?.keepPlaceRetries ?? 2,
    sendbackGraceMin: land?.sendbackGraceMin ?? 30,
    log: o.log ?? 'tail',
  };
  const g = cfg.root ? gitops.open(cfg.root, { isolated: false }) : null;
  if (l.status === 'landed') {
    if (l.task_id && o.since !== undefined) ctx.unblocked = await unblockedBy(client, o.since, l.task_id);
    if (g && l.agent === cfg.agent) ctx.reread = await rereadFiles(g, l);
  }
  if (l.status === 'failed' && l.report?.check?.passes_on_trunk && g) ctx.others = await othersSince(g, client, cfg.project, l);
  return ctx;
}

/** Tasks a landing's task unblocked, from the events since the wait began (best effort). */
async function unblockedBy(client: HubClient, since: number, taskId: string): Promise<string[]> {
  try {
    const page = await client.events(since, 0);
    return page.events
      .filter((e) => e.type === 'task.unblocked' && (e.data as Record<string, unknown>).after === taskId)
      .map((e) => String((e.data as Record<string, unknown>).task_id));
  } catch {
    return [];
  }
}

/** Files other landings changed on trunk between this landing's base and the tip it landed on (best effort: those commits may not be fetched). */
async function rereadFiles(g: Git, l: Landing): Promise<BriefContext['reread']> {
  if (!l.base_sha || !l.trunk_base || l.base_sha === l.trunk_base) return null;
  try {
    const files = await gitops.diffNames(g, l.base_sha, l.trunk_base);
    const n = Number((await g.run(['rev-list', '--count', '--first-parent', `${l.base_sha}..${l.trunk_base}`])).stdout.trim()) || 0;
    return files.length && n ? { files, landings: n } : null;
  } catch {
    return null;
  }
}

/** Trunk landings after this one's base that changed its files (best effort: from local trailers, then the hub for their summaries). */
async function othersSince(g: Git, client: HubClient, project: string, l: Landing): Promise<OtherLanding[]> {
  if (!l.base_sha || !l.trunk_base) return [];
  const mine = new Set(l.files);
  const out: OtherLanding[] = [];
  try {
    const commits = (await gitops.trunkTrailers(g, l.base_sha, l.trunk_base, 50)).reverse();
    for (const t of commits) {
      if (out.length >= 3) break;
      const changed = (await gitops.diffNames(g, `${t.sha}^`, t.sha)).filter((f) => mine.has(f));
      if (!changed.length) continue;
      const id = landingIdOf(t.landing, project);
      let summary = '';
      let task: string | null = null;
      let agent: string | null = t.agent && AGENT_ID_RE.test(t.agent) ? t.agent : null;
      if (id) {
        try {
          const other = await client.landing(id);
          summary = other.summary;
          task = other.task_id;
          agent = other.agent;
        } catch {
          // its trailers are enough
        }
      }
      out.push({ commit: t.sha, landing_id: id, agent, task_id: task, summary, files: changed });
    }
  } catch {
    return out;
  }
  return out;
}
