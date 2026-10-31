// An actual hub backed by a disposable, in-memory SQLite database. No production
// workspace or files are touched. All dashboard interactions use the real API.
import { Hub, SqliteStore, startServer } from "../packages/hub/dist/index.js";

const started = Date.now();
let clock = started - 24 * 60_000;
const store = new SqliteStore(":memory:");
const hub = new Hub({
  store,
  now: () => clock,
  leaseTtlMs: 120000,
  heartbeatIntervalMs: 30000,
});
const project = "agenthub";
const agents = [
  ["maya/claude-1", "Claude Code", "feat/auth-flow"],
  ["sam/codex-1", "Codex", "feat/api-routes"],
  ["alex/cursor-1", "Cursor", "feat/dashboard"],
];
const task = (title, description, deps = []) => {
  clock += 60_000;
  return hub.createTask(project, agents[0][0], { title, description, deps });
};
const foundation = task(
  "Set up the shared project structure",
  "Define package boundaries and shared configuration.",
);
hub.takeTask(project, agents[0][0], foundation.id);
hub.land(project, agents[0][0], {
  task_id: foundation.id,
  summary: "Shared workspace foundation ready",
});
const protocol = task(
  "Define the coordination protocol",
  "Document the contract between the hub and adapters.",
);
hub.takeTask(project, agents[1][0], protocol.id);
hub.land(project, agents[1][0], {
  task_id: protocol.id,
  summary: "Protocol types in place",
});
const tests = task(
  "Cover the lease lifecycle",
  "Verify claims, renewal, and expiry.",
);
hub.takeTask(project, agents[2][0], tests.id);
hub.land(project, agents[2][0], { task_id: tests.id });
const auth = task(
  "Build the authentication flow",
  "Wire the session lifecycle and token validation.",
  [foundation.id],
);
const api = task(
  "Implement project API routes",
  "Add request validation and typed error responses.",
  [protocol.id],
);
const dashboard = task(
  "Polish the workspace dashboard",
  "Refine navigation, typography, and interaction states.",
);
task(
  "Connect the end-to-end workflow",
  "Verify the complete flow once the API and dashboard land.",
  [api.id, dashboard.id],
);
task(
  "Write the getting started guide",
  "Make the first-run path clear and reproducible.",
);
clock += 60_000;
for (const [index, item] of [auth, api, dashboard].entries()) {
  hub.takeTask(project, agents[index][0], item.id);
}
hub.decide(project, agents[0][0], {
  summary: "Use short-lived leases for file ownership",
  rationale:
    "Renew leases with agent heartbeats so interrupted sessions cannot hold files indefinitely. Claims remain scoped to complete files in this implementation.",
  files: ["packages/hub/src/hub.ts"],
  task_id: auth.id,
});
hub.decide(project, agents[1][0], {
  summary: "Keep coordination state in SQLite",
  rationale:
    "Serialize claim decisions and event writes in a single transaction. This keeps the local deployment small; throughput and distributed operation remain bounded by the storage design.",
  files: ["packages/hub/src/sqlite-store.ts"],
  task_id: api.id,
});
clock = started - 50_000;
for (const [index, [agent, client, branch]] of agents.entries()) {
  hub.heartbeat(project, agent, {
    client,
    branch,
    worktree: `/workspaces/agenthub/${branch}`,
  });
  hub.claim(project, agent, {
    files: [
      ["src/auth/session.ts", "src/auth/middleware.ts"],
      ["src/api/projects.ts", "src/api/validation.ts"],
      ["src/components/overview.tsx", "src/styles/workspace.css"],
    ][index],
    intent: [auth, api, dashboard][index].title,
    task_id: [auth, api, dashboard][index].id,
  });
  clock += 15_000;
}
clock = Date.now();
const server = await startServer({
  hub,
  port: Number(process.env.HUB_PORT || 7077),
});
const interval = setInterval(() => {
  clock = Date.now();
  for (const [agent, client, branch] of agents)
    hub.heartbeat(project, agent, { client, branch });
}, 1000);
console.log(
  `AgentHub sample workspace: ${server.url}/?project=agenthub&sample=1`,
);
console.log("Disposable in-memory data. Stop with Ctrl+C.");
async function stop() {
  clearInterval(interval);
  await server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
