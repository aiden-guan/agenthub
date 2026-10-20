#!/usr/bin/env bash
# Scripted two-agent demo. Starts a hub, makes a sample repo with one worktree
# per agent, and drives the real hooks with Claude Code-shaped JSON, so you can
# watch the whole flow without launching two Claude sessions.
#
#   npm run demo              (HUB_PORT=7177 by default; KEEP=1 keeps the sample repo)
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
pretty_json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.trim()?JSON.stringify(JSON.parse(s),null,2):"(no output: edit allowed)"))'; }

[ -f "$ROOT/packages/adapter/dist/cli.js" ] || (cd "$ROOT" && npm run build >/dev/null)

step "1. Start the hub"
say "hub-server --port $PORT --db $WORK/hub.db"
hub-server --port "$PORT" --db "$WORK/hub.db" >"$WORK/hub.log" 2>&1 &
HUB_PID=$!
cleanup() {
  kill "$HUB_PID" 2>/dev/null || true
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
for _ in $(seq 50); do curl -sf "$HUB_URL/healthz" >/dev/null && break; sleep 0.1; done
head -1 "$WORK/hub.log"

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
sed -n '4,$p' "$WORK/hub.log"
