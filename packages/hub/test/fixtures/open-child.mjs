// One opener in the cross-process migration test: spins until the agreed start
// time, then opens the shared database file (which runs the Phase 2 migration)
// and reports what it saw.
import { SqliteStore } from '../../dist/index.js';

const [db, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // busy-wait so every process opens at the same moment
}
const store = new SqliteStore(db);
const landing = store.getLanding('demo', 'L-1');
store.close();
process.stdout.write(JSON.stringify({ status: landing?.status ?? null }));
