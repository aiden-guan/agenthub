#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Hub } from './hub.js';
import { startServer } from './server.js';
import { SqliteStore } from './sqlite-store.js';

const HELP = `hub-server — agenthub coordination hub

Usage: hub-server [--port 7077] [--host 127.0.0.1] [--db ./hub.db]
                  [--lease-ttl-ms 120000] [--heartbeat-ms 30000] [--token SECRET]
                  [--allow-origin https://dash.example.com]... [--allow-host hub.example.com]...

Requests from browsers (anything sending an Origin header) are refused unless
their origin is given with --allow-origin, which may be repeated.
On a loopback address (the default), requests must address the hub by IP
address, localhost or the --host name. Give any other name clients use in their
hub URL with --allow-host, which may be repeated. This stops web pages that
reach the hub through DNS rebinding. On a network address (--host 0.0.0.0) the
hub serves any name unless --allow-host is given; set --token there too.

Environment: HUB_PORT, HUB_HOST, HUB_DB, HUB_LEASE_TTL_MS, HUB_HEARTBEAT_MS, HUB_TOKEN
`;

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    'lease-ttl-ms': { type: 'string' },
    'heartbeat-ms': { type: 'string' },
    token: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
    'allow-host': { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const env = process.env;
const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
const dbPath = resolve(values.db ?? env.HUB_DB ?? 'hub.db');
mkdirSync(dirname(dbPath), { recursive: true });

const store = new SqliteStore(dbPath);
const hub = new Hub({
  store,
  leaseTtlMs: num(values['lease-ttl-ms'] ?? env.HUB_LEASE_TTL_MS),
  heartbeatIntervalMs: num(values['heartbeat-ms'] ?? env.HUB_HEARTBEAT_MS),
});
const server = await startServer({
  hub,
  port: num(values.port ?? env.HUB_PORT) ?? 7077,
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
  console.error(`hub-server: ${message}`);
  process.exit(2);
}
