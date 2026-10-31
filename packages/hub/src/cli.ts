#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Hub, leaseSettings } from './hub.js';
import { startServer } from './server.js';
import { SqliteStore } from './sqlite-store.js';

const HELP = `hub-server — agenthub coordination hub

Usage: hub-server [--port 7077] [--host 127.0.0.1] [--db ./hub.db]
                  [--lease-ttl-ms 120000] [--heartbeat-ms 30000] [--token SECRET]
                  [--allow-origin https://dash.example.com]... [--allow-host hub.example.com]...

Open the server URL in a browser for the built-in dashboard. Requests from
other browser origins are refused unless given with --allow-origin, which may
be repeated. The dashboard accepts your bearer token in connection settings.
On a loopback address (the default), requests must address the hub by IP
address, localhost or the --host name. Give any other name clients use in their
hub URL with --allow-host, which may be repeated (agents in Docker Desktop
containers, for example, need --allow-host host.docker.internal). This stops
web pages that reach the hub through DNS rebinding. On a network address (--host 0.0.0.0) the
hub serves any name unless --allow-host is given; set --token there too.

--lease-ttl-ms is how long a claim lives without a heartbeat: 100 to 86400000 ms.
--heartbeat-ms is how often adapters heartbeat: from 25 ms to a third of the lease
TTL (by default a quarter of it, at most 30000). Settings out of range are refused.

Environment: HUB_PORT, HUB_HOST, HUB_DB, HUB_LEASE_TTL_MS, HUB_HEARTBEAT_MS, HUB_TOKEN
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
const dbPath = resolve(values.db ?? env.HUB_DB ?? 'hub.db');
mkdirSync(dirname(dbPath), { recursive: true });

const store = new SqliteStore(dbPath);
const hub = new Hub({ store, ...lease });
const server = await startServer({
  hub,
  port: port.value ?? 7077,
  host: values.host ?? env.HUB_HOST ?? '127.0.0.1',
  token: values.token ?? env.HUB_TOKEN ?? undefined,
  allowOrigins: values['allow-origin'],
  allowHosts: values['allow-host'],
}).catch((err: Error) => fail(err.message));

console.log(`agenthub hub listening on ${server.url}`);
console.log(`  db: ${dbPath}`);
console.log(`  lease ttl ${hub.leaseTtlMs} ms, heartbeat every ${hub.heartbeatIntervalMs} ms`);

const stopLogging = hub.subscribe((e) => {
  const who = e.actor ?? 'hub';
  const what = typeof e.data.claim_id === 'string' ? `${e.data.claim_id} ${(e.data.files as string[] | undefined)?.join(', ') ?? ''}` : (e.data.task_id ?? e.data.decision_id ?? e.data.message_id ?? '');
  console.log(`[${new Date(e.at).toISOString()}] ${e.project} #${e.seq} ${e.type} ${who} ${what}`.trimEnd());
});

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
