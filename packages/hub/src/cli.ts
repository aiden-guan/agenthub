#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isLoopbackHost, readApproversFile } from './auth.js';
import { Hub, leaseSettings } from './hub.js';
import type { HubEvent } from './protocol.js';
import { startServer } from './server.js';
import { SqliteStore } from './sqlite-store.js';

const HELP = `hub-server — agenthub coordination hub

Usage: hub-server [--port 7077] [--host 127.0.0.1] [--db ./hub.db]
                  [--lease-ttl-ms 120000] [--heartbeat-ms 30000] [--token SECRET]
                  [--allow-origin https://dash.example.com]... [--allow-host hub.example.com]...
                  [--lander-token SECRET] [--approvers FILE] [--allow-unauthenticated-approvals]

Requests from browsers (anything sending an Origin header) are refused unless
their origin is given with --allow-origin, which may be repeated.
On a loopback address (the default), requests must address the hub by IP
address, localhost or the --host name. Give any other name clients use in their
hub URL with --allow-host, which may be repeated (agents in Docker Desktop
containers, for example, need --allow-host host.docker.internal). This stops
web pages that reach the hub through DNS rebinding. On a network address (--host 0.0.0.0) the
hub serves any name unless --allow-host is given; set --token there too.

--lease-ttl-ms is how long a claim lives without a heartbeat: 100 to 86400000 ms.
--heartbeat-ms is how often adapters heartbeat: from 25 ms to a third of the lease
TTL (by default a quarter of it, at most 30000). Settings out of range are refused.

Landing queue:
--lander-token SECRET  the lander (hub-lander, with the same HUB_LANDER_TOKEN)
    sends it in x-hub-lander-token. Without it the lander routes are open on a
    loopback hub only; on a network address they answer 403 lander_token_required.
--approvers FILE  JSON {"maya": "sha256:<hex of maya's token>", ...}: who may
    approve protected landings, by the sha256 of their approver token (the file
    holds no secrets). Without it approvals answer 403 approvals_disabled.
--allow-unauthenticated-approvals  approvals need only the approver's name. For
    demos and tests; refused unless --host is a loopback address.

Environment: HUB_PORT, HUB_HOST, HUB_DB, HUB_LEASE_TTL_MS, HUB_HEARTBEAT_MS, HUB_TOKEN,
             HUB_LANDER_TOKEN, HUB_APPROVERS_FILE
`;

/**
 * The ports the Fetch standard blocks ("bad ports"): Node's fetch, which the
 * adapter uses, refuses them before connecting, as browsers do.
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  db: { type: 'string' },
  'lease-ttl-ms': { type: 'string' },
  'heartbeat-ms': { type: 'string' },
  token: { type: 'string' },
  'allow-origin': { type: 'string', multiple: true },
  'allow-host': { type: 'string', multiple: true },
  'lander-token': { type: 'string' },
  approvers: { type: 'string' },
  'allow-unauthenticated-approvals': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const { values } = orFail(() => parseArgs({ options: OPTIONS }));

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const env = process.env;
// Number settings are checked before anything is opened: a typo must not
// start a hub whose leases never hold, or one on a port nobody uses.
const port = wholeNumber('port', 'HUB_PORT', 'a port number from 0 to 65535', 65_535);
const leaseTtl = wholeNumber('lease-ttl-ms', 'HUB_LEASE_TTL_MS', 'a whole number of milliseconds');
const heartbeat = wholeNumber('heartbeat-ms', 'HUB_HEARTBEAT_MS', 'a whole number of milliseconds');
if (port.value !== undefined && FETCH_BLOCKED_PORTS.has(port.value)) {
  fail(`${port.name} ${port.value} is a port Node's fetch (like browsers) refuses to connect to, so no adapter could reach the hub; pick another port, such as the default 7077`);
}
const lease = orFail(() => leaseSettings({ leaseTtlMs: leaseTtl.value, heartbeatIntervalMs: heartbeat.value }, { leaseTtlMs: leaseTtl.name, heartbeatIntervalMs: heartbeat.name }));
// The landing queue's credentials, checked the same way before anything is opened.
const host = values.host ?? env.HUB_HOST ?? '127.0.0.1';
const landerToken = secret('lander-token', 'HUB_LANDER_TOKEN');
const approvers = approversFile();
const unauthenticatedApprovals = values['allow-unauthenticated-approvals'] === true;
if (unauthenticatedApprovals && !isLoopbackHost(host)) {
  fail(
    `--allow-unauthenticated-approvals lets anyone who reaches the hub approve under any name, so it is refused with --host ${host}; use it only on a loopback address such as 127.0.0.1 (demos and tests), or give the approvers' token digests with --approvers FILE`,
  );
}
const dbPath = resolve(values.db ?? env.HUB_DB ?? 'hub.db');
mkdirSync(dirname(dbPath), { recursive: true });

const store = new SqliteStore(dbPath);
const hub = new Hub({ store, ...lease });
const server = await startServer({
  hub,
  port: port.value ?? 7077,
  host,
  token: values.token ?? env.HUB_TOKEN ?? undefined,
  allowOrigins: values['allow-origin'],
  allowHosts: values['allow-host'],
  landerToken,
  approvers,
  allowUnauthenticatedApprovals: unauthenticatedApprovals,
}).catch((err: Error) => fail(err.message));

console.log(`agenthub hub listening on ${server.url}`);
console.log(`  db: ${dbPath}`);
console.log(`  lease ttl ${hub.leaseTtlMs} ms, heartbeat every ${hub.heartbeatIntervalMs} ms`);
if (landerToken !== undefined) {
  console.log('  lander routes: need the lander token (x-hub-lander-token)');
} else if (server.loopback) {
  console.log(
    '  warning: no --lander-token: any process on this machine that calls itself lander/... can run the landing queue; give the hub and hub-lander the same HUB_LANDER_TOKEN where others share the machine',
  );
} else {
  console.log(
    '  warning: no --lander-token: on a network address the lander routes answer 403 lander_token_required, so no lander can work with this hub until it has one (--lander-token or HUB_LANDER_TOKEN)',
  );
}
if (unauthenticatedApprovals) {
  console.log('  warning: --allow-unauthenticated-approvals: anyone who reaches this hub can approve under any name, with no token; for demos and tests only');
} else if (approvers !== undefined) {
  console.log(`  approvals: ${Object.keys(approvers).join(', ')}`);
} else {
  console.log('  approvals: disabled (no --approvers FILE); landings that need an approval wait until the hub has approvers');
}

const stopLogging = hub.subscribe((e) => console.log(logLine(e)));

async function shutdown() {
  stopLogging();
  await server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Reports a startup error (a bad flag value, a port in use) in one line, without a stack trace. */
function fail(message: string): never {
  console.error(`hub-server: ${message.replace(/\s*\n\s*/g, ' ')}`);
  process.exit(2);
}

/** Runs a startup step, reporting what it throws with fail(). */
function orFail<T>(step: () => T): T {
  try {
    return step();
  } catch (err) {
    return fail((err as Error).message);
  }
}

/**
 * One log line per event, naming what it is about: a claim and its files, a
 * landing (with its status, phase or code), a task, a decision or a message.
 * Events carry no agent-written text, so neither does the log.
 */
function logLine(e: HubEvent): string {
  const d = e.data;
  let what: unknown;
  if (typeof d.claim_id === 'string') {
    what = `${d.claim_id} ${(d.files as string[] | undefined)?.join(', ') ?? ''}`;
  } else if (typeof d.landing_id === 'string' || e.type === 'trunk.moved') {
    const detail = [d.status, d.phase, d.reason, d.code, d.trunk_sha ?? (e.type === 'trunk.moved' ? d.to : undefined), d.foreign === true ? 'foreign' : undefined];
    what = [d.landing_id, ...detail].filter((x) => typeof x === 'string' && x.length > 0).join(' ');
  } else if (e.type === 'lander.paused' || e.type === 'lander.resumed') {
    what = d.reason;
  } else {
    what = d.task_id ?? d.decision_id ?? d.message_id ?? '';
  }
  return `[${new Date(e.at).toISOString()}] ${e.project} #${e.seq} ${e.type} ${e.actor ?? 'hub'} ${what ?? ''}`.trimEnd();
}

/**
 * A secret from its flag, else its environment variable. An empty variable
 * means unset; an explicit flag must be a value that can travel in an HTTP
 * header (visible ASCII, no spaces). The value never appears in a message.
 */
function secret(flag: 'lander-token', envName: string): string | undefined {
  const fromFlag = values[flag] !== undefined;
  const raw = values[flag] ?? env[envName];
  if (raw === undefined || (!fromFlag && raw === '')) return undefined;
  if (!/^[\x21-\x7e]+$/.test(raw)) fail(`${fromFlag ? `--${flag}` : envName} must be a non-empty secret of visible ASCII characters without spaces: it travels in the x-hub-lander-token header`);
  return raw;
}

/** The validated approvers file from --approvers, else HUB_APPROVERS_FILE (empty means unset). */
function approversFile(): Record<string, string> | undefined {
  const fromFlag = values.approvers !== undefined;
  const file = values.approvers ?? env.HUB_APPROVERS_FILE;
  if (file === undefined || (!fromFlag && file === '')) return undefined;
  const name = fromFlag ? '--approvers' : 'HUB_APPROVERS_FILE';
  try {
    return readApproversFile(resolve(file));
  } catch (err) {
    return fail(`${name} ${file}: ${(err as Error).message}`);
  }
}

/**
 * A number setting from its flag, else its environment variable, with the
 * name of the one it came from. Unset or empty means the default; anything
 * but digits (with spaces around them) is refused, so ' ', '2m', '1e3' and
 * '0x1F' don't quietly become another number.
 */
function wholeNumber(flag: 'port' | 'lease-ttl-ms' | 'heartbeat-ms', envName: string, what: string, max = Infinity): { value: number | undefined; name: string } {
  const name = values[flag] !== undefined ? `--${flag}` : envName;
  const raw = values[flag] ?? env[envName];
  if (raw === undefined || raw === '') return { value: undefined, name };
  const value = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!(value <= max)) fail(`${name} must be ${what}, got ${JSON.stringify(raw)}`);
  return { value, name };
}
