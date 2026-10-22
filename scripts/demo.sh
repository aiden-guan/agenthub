#!/usr/bin/env bash
# Scripted two-agent demo. Starts a hub, makes a sample repo with one worktree
# per agent, and drives the real hooks with Claude Code-shaped JSON, so you can
# watch the whole flow without launching two Claude sessions.
#
# Part 1 (steps 1-11): Phase 1 claims, enforced in the edit path and at commit.
# Part 2 (steps 12-20): the Phase 2 landing queue. A bare remote with a host
# rule, two clones, `hub-lander run` with a stub AI resolver (no API key, no
# network), and the design's section 3 flows: a landing, a workspace sync, a
# send-back, a protected path approved in a terminal, a lander handover and a
# conflict the resolver combines.
#
#   npm run demo              (HUB_PORT=7177 by default; KEEP=1 keeps the sample repos;
#                              DEMO_PART=1 or DEMO_PART=2 runs one part)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/node_modules/.bin:$PATH"
PORT="${HUB_PORT:-7177}"
TMP="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMP%/}/agenthub-demo.XXXXXX")"
export HUB_URL="http://127.0.0.1:$PORT"
# Keep the demo away from your own git and hub configuration.
export HUB_CONFIG="$WORK/no-global-config.json" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=Demo GIT_COMMITTER_EMAIL=demo@example.com
unset HUB_AGENT HUB_PROJECT HUB_TOKEN

bold='' dim='' off=''
if [ -t 1 ]; then bold=$'\033[1m' dim=$'\033[2m' off=$'\033[0m'; fi
step() { printf '\n%s== %s%s\n' "$bold" "$*" "$off"; }
say() { printf '%s$ %s%s\n' "$dim" "$*" "$off"; }
# PreToolUse payload as Claude Code sends it for an Edit
edit_payload() { printf '{"session_id":"demo","cwd":"%s","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"session-","new_string":"sess-"},"tool_use_id":"toolu_demo"}' "$1" "$2"; }
pretty_context() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hookSpecificOutput.additionalContext))'; }
# PostToolUse payload for the same Edit, once it ran
post_payload() { printf '{"session_id":"demo","cwd":"%s","permission_mode":"default","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"session-","new_string":"sess-"},"tool_response":{"filePath":"%s"},"tool_use_id":"toolu_demo"}' "$1" "$2" "$2"; }
pretty_json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.trim()?JSON.stringify(JSON.parse(s),null,2):"(no output: edit allowed)"))'; }

[ -f "$ROOT/packages/adapter/dist/cli.js" ] && [ -f "$ROOT/packages/lander/dist/cli.js" ] || (cd "$ROOT" && npm run build >/dev/null)
PART="${DEMO_PART:-all}"
# The lander's token: lander routes and the lease need it (hub-lander reads HUB_LANDER_TOKEN).
LANDER_TOKEN="demo-lander-token-$$"

step "1. Start the hub"
say "hub-server --port $PORT --db $WORK/hub.db --lander-token <secret> --allow-unauthenticated-approvals"
# --allow-unauthenticated-approvals: demos only, and only on loopback (a real hub takes --approvers FILE).
hub-server --port "$PORT" --db "$WORK/hub.db" --lander-token "$LANDER_TOKEN" --allow-unauthenticated-approvals >"$WORK/hub.log" 2>&1 &
HUB_PID=$!
LANDER_PIDS=()
cleanup() {
  for pid in "${LANDER_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${LANDER_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  kill "$HUB_PID" 2>/dev/null || true
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
for _ in $(seq 50); do curl -sf "$HUB_URL/healthz" >/dev/null && break; sleep 0.1; done
sed -n '1,4p' "$WORK/hub.log"

if [ "$PART" != 2 ]; then
step "2. A sample repo, set up once with hub init, and one worktree per agent"
git init -q -b main "$WORK/sample"
cd "$WORK/sample"
mkdir -p src
printf 'export function login(user: string) {\n  return `session-${user}`;\n}\n' >src/auth.ts
printf 'export const users = ["maya", "sam"];\n' >src/users.ts
git add -A && git commit -qm "initial"
say "hub init --project demo"
hub init --project demo
say "git add agenthub.json .claude .mcp.json && git commit -m \"agenthub setup\""
git add agenthub.json .claude .mcp.json && git commit -qm "agenthub setup"
say "git worktree add ../wt-a -b agent-a && git worktree add ../wt-b -b agent-b"
git worktree add -q ../wt-a -b agent-a
git worktree add -q ../wt-b -b agent-b
say "(cd ../wt-a && hub init --agent maya/claude-1)"
(cd ../wt-a && hub init --agent maya/claude-1)
say "(cd ../wt-b && hub init --agent sam/claude-1)"
(cd ../wt-b && hub init --agent sam/claude-1)
A="$WORK/wt-a"
B="$WORK/wt-b"

step "3. Plan two tasks; maya/claude-1 takes the first"
cd "$A"
say 'hub task add "Migrate login to OAuth2"'
hub task add "Migrate login to OAuth2"
say 'hub task add "Rate-limit login attempts" --dep T-1'
hub task add "Rate-limit login attempts" --dep T-1
say "hub task take T-1"
hub task take T-1

step "4. maya/claude-1 edits src/auth.ts: the PreToolUse hook claims it"
say "<Edit payload for $A/src/auth.ts> | hub hook pre-edit"
edit_payload "$A" "$A/src/auth.ts" | hub hook pre-edit | pretty_json
say 'hub decide "login() returns {token, expiresAt}" --file src/auth.ts'
hub decide "login() returns {token, expiresAt}" --file src/auth.ts --why "callers need the expiry for refresh"
say 'hub post sam/claude-1 "Moving login to OAuth2; please stay off src/auth.ts until T-1 lands"'
hub post sam/claude-1 "Moving login to OAuth2; please stay off src/auth.ts until T-1 lands"

step "5. sam/claude-1 starts a session: the SessionStart digest it receives"
cd "$B"
say "<SessionStart payload> | hub hook digest"
echo '{"hook_event_name":"SessionStart","source":"startup"}' | hub hook digest | pretty_context

step "6. sam/claude-1 tries to edit src/auth.ts: denied"
say "<Edit payload for $B/src/auth.ts> | hub hook pre-edit"
edit_payload "$B" "$B/src/auth.ts" | hub hook pre-edit | pretty_json

step "7. sam/claude-1 edits a free file: allowed"
say "<Edit payload for $B/src/users.ts> | hub hook pre-edit"
edit_payload "$B" "$B/src/users.ts" | hub hook pre-edit | pretty_json

step "8. An agent without hooks commits src/auth.ts anyway: the pre-commit guard rejects it"
echo "// quick fix" >>src/auth.ts
git add src/auth.ts
say 'git commit -m "quick fix in auth"'
git commit -qm "quick fix in auth" || echo "(commit rejected, exit $?)"
git restore --staged src/auth.ts && git checkout -- src/auth.ts

step "9. maya/claude-1 commits and lands T-1: claims released, T-2 unblocked"
cd "$A"
sed -i.bak 's/session-/oauth-/' src/auth.ts && rm src/auth.ts.bak
say 'git commit -am "OAuth2 login"   (maya holds the claim, so the guard lets it through)'
git commit -qam "OAuth2 login" && echo "committed"
say "hub land --task T-1"
hub land --task T-1

step "10. sam/claude-1 retries the edit: allowed now"
cd "$B"
edit_payload "$B" "$B/src/auth.ts" | hub hook pre-edit | pretty_json

step "11. Team status (hub status) and the hub's event log"
hub status
echo
grep '^\[[^]]*\] demo #' "$WORK/hub.log" || true
fi

[ "$PART" = 1 ] && exit 0

# ------------------------------------------------------------------ Part 2

Q="$WORK/queue"
REMOTE="$Q/remote.git"
QPROJ=shop
mkdir -p "$Q"
# One word for /bin/sh, whatever the path holds: the lander runs --resolver-command through sh -c.
shq() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
# What hub land printed: its first line names the landing.
landing_of() { sed -n 's/^Queued \(L-[0-9]*\).*/\1/p' "$1" | sed -n 1p; }
# Replaces the first occurrence of a string in a file (sed's newline handling differs between GNU and BSD).
edit_file() { node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");if(!s.includes(a)){console.error(`no ${JSON.stringify(a)} in ${f}`);process.exit(1)}fs.writeFileSync(f,s.replace(a,()=>b))' "$@"; }
landing_field() { curl -sf "$HUB_URL/v1/p/$QPROJ/landings/$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).landing[process.argv[1]]))' "$2"; }
wait_landing() {
  for _ in $(seq 600); do
    case "$(landing_field "$1" status)" in landed | failed | cancelled) return 0 ;; esac
    sleep 0.1
  done
  echo "timed out waiting for $1" >&2
  exit 1
}
lander_holder() { curl -sf "$HUB_URL/v1/p/$QPROJ/lander" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s).lease;console.log(l?`${l.holder} ${l.standby.length}`:"none 0")})'; }
start_lander() { # <name> <workdir>
  HUB_LANDER_TOKEN="$LANDER_TOKEN" hub-lander run --dir "$2" --id-prefix "lander/$1" --poll-trunk-ms 300 --resolver-command "$RESOLVER" >"$Q/lander-$1.log" 2>&1 &
  LANDER_PIDS+=($!)
}
# The approval prompt needs a terminal: python3's pty gives `hub approve` one, and types the landing id.
PTY='import os, pty, sys
st = pty.spawn(sys.argv[1:])
sys.exit(os.waitstatus_to_exitcode(st))'

step "12. Part 2, the landing queue: a bare remote with a host rule, two clones, a lander"
git init -q --bare -b main "$REMOTE"
git -C "$REMOTE" config receive.denyNonFastForwards true
git init -q -b main "$Q/seed"
cd "$Q/seed"
mkdir -p src migrations
printf 'export function login(user: string) {\n  return `session-${user}`;\n}\n' >src/auth.ts
printf 'export const users = ["maya", "sam"];\n' >src/users.ts
printf 'export const allowlist = [\n  "maya",\n];\n' >src/allowlist.ts
printf 'create table users (id int);\n' >migrations/001_init.sql
cp "$ROOT/packages/e2e/fixtures/repo/check.mjs" check.mjs
hub init --project "$QPROJ" --no-guard >/dev/null
# The land section turns the queue on: the check, the protected paths, the AI resolver.
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("agenthub.json","utf8"));c.land={check:"node check.mjs",protected:["migrations/**"],resolver:{enabled:true}};fs.writeFileSync("agenthub.json",JSON.stringify(c,null,2)+"\n")'
cat agenthub.json
git add -A && git commit -qm "shop: initial import" && git push -q "$REMOTE" main
# The host rule (a GitHub ruleset in real life): only the lander's identity moves main, and never deletes it.
cat >"$REMOTE/hooks/update" <<'HOOK'
#!/bin/sh
[ "$1" = refs/heads/main ] || exit 0
case "$3" in 0000000000000000000000000000000000000000) echo "main can't be deleted" >&2; exit 1 ;; esac
who=$(git log -1 --format='%cn <%ce>' "$3")
[ "$who" = "agenthub lander <lander@localhost>" ] || { echo "only the lander may update main (committer: $who)" >&2; exit 1; }
HOOK
chmod +x "$REMOTE/hooks/update"
A="$Q/maya"
B="$Q/sam"
git clone -q "$REMOTE" "$A" && git -C "$A" checkout -q -b agent-a
git clone -q "$REMOTE" "$B" && git -C "$B" checkout -q -b agent-b
(cd "$A" && hub init --agent maya/claude-1 >/dev/null)
(cd "$B" && hub init --agent sam/claude-1 >/dev/null)
say "hub-lander init --remote $REMOTE --dir $Q/lander"
hub-lander init --remote "$REMOTE" --dir "$Q/lander"
cp "$ROOT/packages/e2e/fixtures/stub-resolver.mjs" "$Q/stub-resolver.mjs"
echo '{ "mode": "union" }' >"$Q/union.json"
RESOLVER="$(shq "$(command -v node)") $(shq "$Q/stub-resolver.mjs") $(shq "$Q/union.json")"
say "HUB_LANDER_TOKEN=<secret> hub-lander run --dir $Q/lander --resolver-command \"node stub-resolver.mjs union.json\""
start_lander buildbox "$Q/lander"
for _ in $(seq 100); do [ "$(lander_holder)" = "none 0" ] || break; sleep 0.1; done
cd "$A"
say "hub lander"
hub lander

step "13. maya/claude-1 finishes a task and lands it (design 3.1)"
hub task add "Lower-case user names at login" >/dev/null
hub task take T-1 >/dev/null
say "<Edit payload for $A/src/auth.ts> | hub hook pre-edit   (claims src/auth.ts)"
edit_payload "$A" "$A/src/auth.ts" | hub hook pre-edit | pretty_json
edit_file src/auth.ts '`session-${user}`' '`session-${user.toLowerCase()}`'
# The edit ran: Claude Code's PostToolUse hook confirms its claim (and ends the edit, so a sync may run again).
post_payload "$A" "$A/src/auth.ts" | hub hook post-edit
git commit -qam "login: lower-case user names"
say "git push origin HEAD:main            (nothing reaches main outside the queue)"
git push -q origin HEAD:main 2>&1 | sed -n '1,2p' || true
say "HUB_GUARD=off git push origin HEAD:main   (past the local guard, the host rule refuses)"
HUB_GUARD=off git push -q origin HEAD:main 2>&1 | grep -m1 'only the lander' || true
say 'hub land --task T-1 --summary "login lower-cases user names" --wait'
hub land --task T-1 --summary "login lower-cases user names" --wait | tee "$Q/land.out"
L1="$(landing_of "$Q/land.out")"
say "git log -1 main   (on the remote: the squash commit and its trailers)"
git -C "$REMOTE" log -1 --format='%h %s  (committer: %cn)%n%n%(trailers)' main

step "14. sam/claude-1's workspace follows trunk; uncommitted work is never touched (design 3.10)"
cd "$B"
printf 'export const users = ["maya", "sam", "lee"];\n' >src/users.ts
say "hub sync   (uncommitted changes: nothing moves)"
hub sync || true
git commit -qam "users: add lee"
say "hub sync   (committed: the branch is replayed onto trunk, with a backup ref)"
hub sync || true
git log --oneline -2

step "15. sam's landing fails its checks and comes back with what to fix (design 3.6, 3.9)"
hub task add "Add lee to the users" >/dev/null
hub task take T-2 >/dev/null
printf '// FAIL! (a test this change breaks)\n' >>src/users.ts
git commit -qam "users: a failing test"
say "hub land --task T-2 --wait"
hub land --task T-2 --wait >"$Q/land.out" || true
L2="$(landing_of "$Q/land.out")"
sed -n '1,40p' "$Q/land.out"
edit_file src/users.ts '// FAIL! (a test this change breaks)
' ''
git commit -qam "users: fix the test"
say "hub land --task T-2 --wait   (the retry keeps its place in the queue)"
hub land --task T-2 --wait | sed -n '1p;/keeps that landing/p;/ landed on main/p'

step "16. maya lands a migration: a protected path waits for a human (design 3.7)"
cd "$A"
hub sync >/dev/null || true
hub task add "Add a name column" >/dev/null
hub task take T-3 >/dev/null
printf 'alter table users add name text;\n' >migrations/002_add_name.sql
git add -A && git commit -qm "migrations: users.name"
say "hub land --task T-3 --wait   (returns once the checks passed and it waits for the approval)"
hub land --task T-3 --wait | tee "$Q/land.out"
L3="$(landing_of "$Q/land.out")"
say "echo $L3 | hub approve $L3   (no terminal: refused)"
echo "$L3" | HUB_APPROVER=sam HUB_APPROVER_TOKEN=demo hub approve "$L3" 2>&1 | tail -1 || true
if command -v python3 >/dev/null && python3 -c 'import pty' 2>/dev/null; then
  say "hub approve $L3   (sam, in a terminal: shows the diff, then asks for the landing id)"
  printf '%s\n' "$L3" | HUB_APPROVER=sam HUB_APPROVER_TOKEN=demo python3 -c "$PTY" node "$ROOT/packages/adapter/bin/hub.js" approve "$L3" |
    tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -v '^$' | tail -3
else
  # No pseudo-terminal here: approve over the API, as sam (this demo hub takes the name alone).
  say "POST /landings/$L3/approve as sam   (python3 isn't here to give hub approve a terminal)"
  node --input-type=module -e '
    const [url, id] = process.argv.slice(1);
    const l = (await (await fetch(`${url}/landings/${id}`)).json()).landing;
    for (const r of l.approval) {
      const res = await fetch(`${url}/landings/${id}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-hub-approver": "sam" }, body: JSON.stringify({ kind: r.kind, digest: r.digest }) });
      console.log(res.status, r.kind, r.paths.join(", "));
    }' "$HUB_URL/v1/p/$QPROJ" "$L3"
fi
wait_landing "$L3"
say "hub landing $L3"
hub landing "$L3" | sed -n '1,3p'

step "17. A standby lander takes over when the active one stops (design 3.11)"
hub-lander init --remote "$REMOTE" --dir "$Q/standby" >/dev/null 2>&1
say "hub-lander run --dir $Q/standby --id-prefix lander/laptop   (another machine, in real life)"
start_lander laptop "$Q/standby"
for _ in $(seq 100); do [ "$(lander_holder | cut -d' ' -f2)" = 1 ] && break; sleep 0.1; done
hub lander | sed -n 1p
say "kill -TERM <the buildbox lander>   (it hands the lease back on the way out)"
kill -TERM "${LANDER_PIDS[0]}"
wait "${LANDER_PIDS[0]}" 2>/dev/null || true
for _ in $(seq 100); do case "$(lander_holder)" in lander/laptop*) break ;; esac; sleep 0.1; done
hub lander | sed -n 1p

step "18. Both agents change the same lines; the AI resolver (a stub here) combines them (design 3.3, 3.4)"
hub sync >/dev/null || true
hub task add "Allow lee" >/dev/null
hub task take T-4 >/dev/null
edit_file src/allowlist.ts '  "maya",
' '  "maya",
  "lee",
'
git commit -qam "allowlist: lee"
say "hub land --task T-4 --wait   (maya first)"
hub land --task T-4 --wait | sed -n '1p;/ landed on main/p'
cd "$B"
hub task add "Allow kim" >/dev/null
hub task take T-5 >/dev/null
edit_file src/allowlist.ts '  "maya",
' '  "maya",
  "kim",
'
git commit -qam "allowlist: kim"
say "hub land --task T-5 --wait   (sam's branch never saw lee: git sees a conflict)"
hub land --task T-5 --wait | grep -v '^$' | sed -n '1,12p'
say "git show main:src/allowlist.ts"
git -C "$REMOTE" show main:src/allowlist.ts
git -C "$REMOTE" log -1 --format='%(trailers:key=Agenthub-Resolved)' main
say "hub inbox --peek   (maya is told her change was merged with sam's by the resolver)"
(cd "$A" && hub inbox --peek | sed -n '3,$p')

step "19. The queue, the stats and trunk"
say "hub landings"
hub landings
say "hub landings --stats"
hub landings --stats
say "git log --first-parent --oneline main   (one checked squash commit per landing, all by the lander)"
git -C "$REMOTE" log --first-parent --format='%h %s  (%cn)' main

step "20. The lander's log"
sed -n '1,200p' "$Q/lander-buildbox.log" | grep -v '^$' | sed -n '1,12p'
echo "…"
grep -v '^$' "$Q/lander-laptop.log" | tail -4
