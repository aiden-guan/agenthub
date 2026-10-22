// One contender in the cross-process race tests: opens its own Hub on the
// shared SQLite file, spins until the agreed start time, then claims.
// Arguments: <db> <agent> <startAt> [file] [lander] [symbol mapper]. With
// `lander`, it claims with lander credentials and queues, as hub-lander claims
// the lease (pass '' for an agent). With a symbol and its mapper, it claims
// that symbol of the file (Phase 3) instead of the whole file.
import { Hub, SqliteStore } from '../../dist/index.js';

const [db, agent, startAt, file = 'contended.ts', mode = '', symbol = '', mapper = ''] = process.argv.slice(2);
const lander = mode === 'lander';
const hub = new Hub({ store: new SqliteStore(db) });
const request = symbol ? { scope: [{ file, symbol }], mapper, queue: lander } : { files: [file], queue: lander };
while (Date.now() < Number(startAt)) {
  // busy-wait so every process fires at the same moment
}
const result = hub.claim('race', agent, request, { lander, approver: null });
process.stdout.write(JSON.stringify({ agent, status: result.status, claim_id: result.claim?.id ?? null }));
