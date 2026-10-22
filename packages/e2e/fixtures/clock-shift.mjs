// Preloaded with `node --import <this file>` into one `hub-lander run --once`:
// moves the process's wall clock (Date.now) forward by
// $AGENTHUB_E2E_CLOCK_SHIFT_MS, so its GC pass sees the grace periods of
// design §1.1 (1 h for a land ref, 7 days for a candidate of a landing that
// didn't land) as over without the suite waiting a week. Only that one GC
// lander runs with it; the hub and the other landers keep the real time.
// Monotonic time (performance.now) is left alone.
const shift = Number(process.env.AGENTHUB_E2E_CLOCK_SHIFT_MS ?? '0');
if (Number.isFinite(shift) && shift !== 0) {
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + shift;
}
