// One contender in the cross-process race tests: opens its own Hub on the
// shared SQLite file, spins until the agreed start time, then claims.
// Arguments: <db> <agent> <startAt> [file] [lander]. With `lander`, it claims
// with lander credentials and queues, as hub-lander claims the lease.
import { Hub, SqliteStore } from '../../dist/index.js';

const [db, agent, startAt, file = 'contended.ts', mode = ''] = process.argv.slice(2);
const lander = mode === 'lander';
const hub = new Hub({ store: new SqliteStore(db) });
while (Date.now() < Number(startAt)) {
  // busy-wait so every process fires at the same moment
}
const result = hub.claim('race', agent, { files: [file], queue: lander }, { lander, approver: null });
process.stdout.write(JSON.stringify({ agent, status: result.status, claim_id: result.claim?.id ?? null }));
