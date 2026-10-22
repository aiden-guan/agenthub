#!/bin/sh
# A `git` put first on PATH for one `hub sync`: it runs the real git
# ($AGENTHUB_E2E_REAL_GIT), but a fetch only after creating
# $AGENTHUB_E2E_FETCH_STARTED and sleeping $AGENTHUB_E2E_FETCH_DELAY_S
# seconds. The sync takes its lock and looks for edit markers before it
# fetches (design §2.3.5 steps 1 to 3), so once that file exists the suite has
# a real sync holding the real lock, past its marker check, for that long.
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    if [ -n "$AGENTHUB_E2E_FETCH_STARTED" ]; then : > "$AGENTHUB_E2E_FETCH_STARTED"; fi
    sleep "${AGENTHUB_E2E_FETCH_DELAY_S:-8}"
    break
  fi
done
exec "$AGENTHUB_E2E_REAL_GIT" "$@"
