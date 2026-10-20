// One contender in the cross-process race test: opens its own Hub on the
// shared SQLite file, spins until the agreed start time, then claims.
import { Hub, SqliteStore } from '../../dist/index.js';

const [db, agent, startAt] = process.argv.slice(2);
const hub = new Hub({ store: new SqliteStore(db) });
while (Date.now() < Number(startAt)) {
  // busy-wait so every process fires at the same moment
}
const result = hub.claim('race', agent, { files: ['contended.ts'] });
process.stdout.write(JSON.stringify({ agent, status: result.status }));
