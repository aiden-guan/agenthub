const $ = (selector) => document.querySelector(selector);
const esc = (value = "") =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const paths = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  agents:
    '<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M2 12h3m14 0h3M9 19v2m6-2v2M8 15h8"/><path d="M9 11h.01M15 11h.01" stroke-width="3"/>',
  tasks:
    '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 2v4m6-4v4M8 11l2 2 5-5M8 17h8"/>',
  claims:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  decisions:
    '<path d="M8 3h8v5a4 4 0 0 1-8 0zM12 12v9M6 21h12M8 6H4v2a4 4 0 0 0 5 4M16 6h4v2a4 4 0 0 1-5 4"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  external:
    '<path d="M14 3h7v7M21 3 10 14M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5"/>',
  terminal: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  branch:
    '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 6v12M18 8a8 8 0 0 1-8 8H6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  book: '<path d="M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2zm0 0v16"/>',
  settings:
    '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  github:
    '<path d="M9 19c-4 1-4-2-6-2m12 4v-3a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.6 4.6 0 0 0-1.2-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.2a12 12 0 0 0-6.2 0C6.4 3 5.4 3.3 5.4 3.3a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.1 10c0 4.7 2.8 5.7 5.5 6A3 3 0 0 0 9 18v3"/>',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.activity}</svg>`;
document.querySelectorAll("[data-icon]").forEach((element) => {
  element.outerHTML = icon(element.dataset.icon);
});

const params = new URLSearchParams(location.search);
let project = params.get("project") || "";
let token = "";
let identity = sessionStorage.getItem("agenthub.identity") || "";
let state = null;
let events = [];
let cursor = 0;
let epoch = null;
let projects = [];
let busy = false;
let taskFilter = "active";
let lastSuccess = 0;
let connected = false;
const views = {
  overview: [
    "Workspace overview",
    "Parallel work. Shared context. One clear picture.",
  ],
  agents: ["Your agents", "Every session, its context, and the work it owns."],
  tasks: ["Tasks", "From first idea to landed work. Keep the handoffs clear."],
  claims: [
    "File claims",
    "A clear boundary for every agent. See who owns what.",
  ],
  decisions: ["Decisions", "Shared context that stays with the work."],
  activity: [
    "Workspace activity",
    "The story of your project, one event at a time.",
  ],
};
const view = () =>
  Object.hasOwn(views, location.hash.slice(1))
    ? location.hash.slice(1)
    : "overview";
const nameOf = (agent) => (agent || "Unassigned").split("/")[0];
const clientOf = (agent) => (agent || "").split("/")[1] || "Agent";
const shortClient = (agent) =>
  /claude/i.test(agent)
    ? "Claude Code"
    : /codex/i.test(agent)
      ? "Codex"
      : /cursor/i.test(agent)
        ? "Cursor"
        : clientOf(agent);
const initials = (agent) => nameOf(agent).slice(0, 2).toUpperCase();
const timeAgo = (at) => {
  const seconds = Math.max(
    0,
    Math.floor(((state?.now || Date.now()) - at) / 1000),
  );
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const avatar = (agent, index = 0, online = null) =>
  `<span class="avatar tone-${index % 3}" aria-hidden="true">${esc(initials(agent))}${online === null ? "" : `<span class="status-dot${online ? "" : " offline"}"></span>`}</span>`;
const link = (target, label) =>
  `<a class="text-link" href="#${target}">${label}${icon("arrow")}</a>`;
const empty = (title, description, glyph = "agents", action = "") =>
  `<div class="empty-state">${icon(glyph)}<h2>${esc(title)}</h2><p>${description}</p>${action}</div>`;

async function request(path, body, signal) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    signal: signal || AbortSignal.timeout(10000),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(identity ? { "x-hub-agent": identity } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "This hub requires a bearer token. Open connection settings to connect."
        : result.error?.message || `Hub returned ${response.status}`,
    );
  return result;
}
const endpoint = (path) => `/v1/p/${encodeURIComponent(project)}${path}`;

function connection(ok) {
  connected = ok;
  $("#connection-dot").classList.toggle("offline", !ok);
  $("#connection-label").textContent = ok
    ? "Hub connected"
    : "Connection interrupted";
  $("#connection-address").textContent = location.host;
  $("#live-label").innerHTML =
    `<span class="status-dot${ok ? "" : " offline"}"></span>${ok ? "Live updates" : "Reconnecting"}`;
  if (ok) {
    lastSuccess = Date.now();
    $("#error-banner").hidden = true;
    $("#last-updated").textContent = "Synced just now · Refreshes every 5s";
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  $("#refresh").disabled = true;
  try {
    const listing = await request("/v1/projects");
    projects = listing.projects;
    if (!project) project = projects[0] || "agenthub";
    const next = await request(endpoint("/status"));
    // Start near the current tail, then follow the API's bounded cursor pages.
    // Project sequences can have gaps because the event log spans all projects.
    if (epoch === null) cursor = Math.max(0, next.seq - 5000);
    let activity = await request(endpoint(`/events?since=${cursor}`));
    if (epoch && epoch !== activity.epoch) {
      events = [];
      cursor = 0;
    }
    for (let page = 0; page < 10; page++) {
      const known = new Set(events.map((event) => event.seq));
      events = [
        ...events,
        ...activity.events.filter((event) => !known.has(event.seq)),
      ].slice(-150);
      cursor = activity.next_since;
      if (cursor >= activity.seq) break;
      activity = await request(endpoint(`/events?since=${cursor}`));
    }
    epoch = activity.epoch;
    state = next;
    connection(true);
    render();
  } catch (error) {
    connection(false);
    $("#error-banner").textContent =
      `${error.message}${state ? " Showing the last received workspace. Retrying automatically." : ""}`;
    const button = document.createElement("button");
    button.textContent = "Connection settings";
    button.addEventListener("click", settings);
    $("#error-banner").append(button);
    $("#error-banner").hidden = false;
    if (!state)
      $("#content").innerHTML = empty(
        "Let’s connect your workspace",
        "Check the hub connection above. If your server uses authentication, enter its token in connection settings.",
        "terminal",
      );
  } finally {
    busy = false;
    $("#refresh").disabled = false;
    $("#content").setAttribute("aria-busy", "false");
  }
}

function stats() {
  const online = state.agents.filter((agent) => agent.online).length;
  const active = state.claims.filter((claim) => claim.status === "active");
  const files = new Set(
    active.flatMap((claim) => claim.scope.map((scope) => scope.file)),
  ).size;
  const queued = state.claims.filter(
    (claim) => claim.status === "queued",
  ).length;
  const done = state.tasks.filter((task) => task.status === "done").length;
  const working = state.tasks.filter(
    (task) => task.status === "in_progress",
  ).length;
  const metrics = [
    [
      "agents",
      "Agents online",
      online,
      online ? "Connected" : "Ready to connect",
      `${state.agents.length} registered in this workspace`,
    ],
    [
      "claims",
      "Files claimed",
      files,
      queued ? `${queued} queued` : "Protected",
      `${active.length} active ${active.length === 1 ? "lease" : "leases"}`,
    ],
    [
      "tasks",
      "In progress",
      working,
      working ? "Moving forward" : "Ready for work",
      `${state.tasks.filter((task) => task.status === "open").length} tasks in the backlog`,
    ],
    [
      "check",
      "Tasks completed",
      done,
      "Landed work",
      `of ${state.tasks.length} total tasks`,
    ],
  ];
  return `<section class="stats-strip" aria-label="Workspace summary">${metrics.map(([glyph, label, value, note, caption]) => `<div class="stat"><div class="stat-label">${icon(glyph)}${label}</div><div class="stat-main"><strong>${value}</strong><span>${note}</span></div><div class="stat-caption">${caption}</div></div>`).join("")}</section>`;
}

function map() {
  const agents = [...state.agents]
    .sort((a, b) => Number(b.online) - Number(a.online))
    .slice(0, 3);
  const queued = state.claims.filter(
    (claim) => claim.status === "queued",
  ).length;
  const locations = ["node-left", "node-right", "node-bottom"];
  const lines = [
    "M200 75H340Q400 75 400 125V140",
    "M600 75H460Q400 75 400 125V140",
    "M400 235V180",
  ];
  return `<section class="panel"><div class="panel-heading"><div><h2>Coordination map</h2><p class="panel-subtitle">Independent agents. One shared source of truth.</p></div><span class="pill${queued ? " amber" : ""}"><span class="status-dot"></span>${queued ? `${queued} waiting` : "In sync"}</span></div><div class="coordination-map" role="img" aria-label="${esc(agents.map((agent) => agent.agent).join(", ") || "No agents")} connected to the coordination hub"><svg class="map-lines" viewBox="0 0 800 280" preserveAspectRatio="none" aria-hidden="true">${agents.map((_, i) => `<path d="${lines[i]}"/><path class="signal" d="${lines[i]}"/>`).join("")}</svg><div class="map-center"><div class="hub-mark"><img src="/favicon.svg" alt="" width="38" height="38"></div><strong>agenthub</strong><small>COORDINATION HUB</small></div>${agents.map((agent, i) => `<div class="map-node ${locations[i]}">${avatar(agent.agent, i)}<span><strong>${esc(nameOf(agent.agent))}<span class="mono"> / ${esc(clientOf(agent.agent).replace(/-\d+$/, ""))}</span></strong><small>${agent.online ? "● Connected" : "○ Offline"} · ${state.claims.filter((claim) => claim.holder === agent.agent && claim.status === "active").length} leases</small></span></div>`).join("")}</div><div class="map-footer"><span class="map-legend"><i></i>Heartbeat every ${state.lease.heartbeat_interval_ms / 1000}s</span><span>${agents.length < state.agents.length ? `Showing ${agents.length} of ${state.agents.length} agents` : "File-level lease coordination"}</span></div></section>`;
}

function eventDescription(event) {
  const data = event.data;
  const actor = `<strong>${esc(nameOf(event.actor || "hub"))}</strong>`;
  const task = state.tasks.find((item) => item.id === data.task_id);
  const descriptions = {
    "agent.online": [
      actor + " joined the workspace",
      "agents",
      data.agent || event.actor,
    ],
    "claim.granted": [
      actor + " claimed a file lease",
      "lock",
      (data.files || []).join(", "),
    ],
    "claim.queued": [
      actor + " is waiting for a file",
      "clock",
      (data.files || []).join(", "),
    ],
    "claim.released": [
      actor + " released a file lease",
      "check",
      (data.files || []).join(", "),
    ],
    "claim.expired": [
      "A file lease expired",
      "clock",
      (data.files || []).join(", "),
    ],
    "task.created": [
      actor + " created a task",
      "plus",
      data.title || task?.title || data.task_id,
    ],
    "task.taken": [
      actor + " started a task",
      "tasks",
      task?.title || data.task_id,
    ],
    "task.updated": [
      actor +
        ` updated a task${data.status ? ` to ${esc(data.status.replace("_", " "))}` : ""}`,
      "tasks",
      task?.title || data.task_id,
    ],
    "task.unblocked": [
      "A task is ready to start",
      "check",
      task?.title || data.task_id,
    ],
    "decision.recorded": [
      actor + " recorded a decision",
      "decisions",
      data.summary || data.decision_id,
    ],
    "land.requested": [
      actor + " recorded a landing",
      "branch",
      data.summary || task?.title || data.landing_id,
    ],
    "message.posted": [
      actor + " posted a message",
      "activity",
      data.channel || "Workspace message",
    ],
  };
  return descriptions[event.type] || [esc(event.type), "activity", ""];
}
function activityRows(limit) {
  const latest = [...events].reverse().slice(0, limit);
  return latest.length
    ? `<ol class="activity-list">${latest
        .map((event) => {
          const [text, glyph, detail] = eventDescription(event);
          return `<li class="activity-row"><span class="event-icon${glyph === "tasks" || glyph === "activity" ? " muted" : ""}">${icon(glyph)}</span><div class="event-body"><p>${text}</p>${detail ? `<code>${esc(detail)}</code>` : ""}</div><time class="event-time" datetime="${new Date(event.at).toISOString()}">${timeAgo(event.at)}</time></li>`;
        })
        .join("")}</ol>`
    : empty(
        "The story starts here",
        "New tasks, file claims, and decisions will appear as your team works.",
        "activity",
      );
}
function activityPanel() {
  return `<section class="panel activity-panel"><div class="panel-heading"><h2>Recent activity</h2>${link("activity", "View all")}</div>${activityRows(5)}</section>`;
}

function agentCards() {
  return state.agents.length
    ? `<div class="agent-grid">${state.agents
        .map((agent, i) => {
          const task = state.tasks.find(
            (item) => item.id === agent.current_task,
          );
          const claims = state.claims.filter(
            (item) => item.holder === agent.agent && item.status === "active",
          );
          const files = new Set(
            claims.flatMap((item) => item.scope.map((scope) => scope.file)),
          ).size;
          return `<button class="agent-card" data-agent="${esc(agent.agent)}" aria-label="View ${esc(agent.agent)}"><div class="agent-card-top">${avatar(agent.agent, i)}<span><span class="agent-name">${esc(nameOf(agent.agent))}<span class="agent-client"> / ${esc(clientOf(agent.agent))}</span></span><span class="agent-client">${esc(agent.client || shortClient(agent.agent))}</span></span><span class="agent-state"><span class="status-dot${agent.online ? "" : " offline"}"></span>${agent.online ? "Online" : "Offline"}</span></div><div class="branch-label">${icon("branch")}<span>${esc(agent.branch || "No branch reported")}</span></div><div class="agent-task"><span class="task-indicator ${task ? "in_progress" : ""}"></span>${esc(task?.title || "Ready for the next task")}</div><div class="agent-card-bottom"><span class="claim-count">${icon("claims")}${files} ${files === 1 ? "file" : "files"} claimed</span><span>${icon("clock")}${timeAgo(agent.last_seen)}</span></div></button>`;
        })
        .join("")}</div>`
    : `<section class="panel">${empty("Make room for your first agent", "Connect a coding agent to see its presence, current task, branch, and file ownership here.", "agents", '<button class="button secondary" data-action="connect">Connect an agent</button>')}</section>`;
}

const statusLabel = (task) =>
  task.blocked_by.length
    ? "Blocked"
    : {
        open: "Open",
        in_progress: "In progress",
        done: "Completed",
        cancelled: "Cancelled",
      }[task.status];
function tasksPanel(full = false) {
  const filtered = state.tasks.filter(
    (task) =>
      taskFilter === "all" ||
      (taskFilter === "done"
        ? task.status === "done"
        : task.status !== "done" && task.status !== "cancelled"),
  );
  const shown = full ? filtered : filtered.slice(0, 5);
  return `<section class="panel task-panel"><div class="panel-heading"><h2>${full ? "All tasks" : "On the board"} <span class="count">${filtered.length}</span></h2><div class="task-tabs" aria-label="Filter tasks">${[
    ["active", "Active"],
    ["done", "Completed"],
    ["all", "All tasks"],
  ]
    .map(
      ([value, label]) =>
        `<button class="${taskFilter === value ? "selected" : ""}" aria-pressed="${taskFilter === value}" data-filter="${value}">${label}</button>`,
    )
    .join(
      "",
    )}</div></div>${shown.length ? `<div class="task-table-wrap"><table class="task-table"><thead><tr><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Assigned to</th><th scope="col">Dependencies</th></tr></thead><tbody>${shown.map((task) => `<tr class="task-row" data-task="${esc(task.id)}" tabindex="0" aria-label="View task ${esc(task.id)}: ${esc(task.title)}"><td><span class="task-title"><span class="task-indicator ${task.blocked_by.length ? "blocked" : task.status}"></span><span class="mono">${esc(task.id)}</span><span class="title-text">${esc(task.title)}</span></span></td><td><span class="pill ${task.blocked_by.length ? "amber" : task.status === "in_progress" ? "" : "neutral"}">${statusLabel(task)}</span></td><td>${task.owner ? `<span class="owner-chip">${avatar(task.owner)}${esc(nameOf(task.owner))}</span>` : '<span class="dependency">Unassigned</span>'}</td><td><span class="dependency${task.blocked_by.length ? " is-blocked" : ""}">${task.blocked_by.length ? `Waiting on ${esc(task.blocked_by.join(", "))}` : task.deps.length ? "Dependencies met" : "—"}</span></td></tr>`).join("")}</tbody></table></div>` : empty(taskFilter === "done" ? "Good work has a home here" : "A clear board. A fresh start.", taskFilter === "done" ? "Tasks completed by your team will appear here." : "Create a task, give it context, and let an agent take it from here.", "tasks", taskFilter === "done" ? "" : '<button class="button secondary" data-action="new-task">Create your first task</button>')}<div class="table-footer"><span>${shown.length ? `Showing ${shown.length} of ${filtered.length} tasks` : "No matching tasks"}</span>${full ? "<span>Dependencies are checked by the hub</span>" : link("tasks", "View task board")}</div></section>`;
}

function claimsPanel() {
  const claims = state.claims;
  return `<section class="panel"><div class="panel-heading"><div><h2>Active & queued leases</h2><p class="panel-subtitle">Leases renew while agents heartbeat and expire automatically.</p></div><span class="pill neutral">${claims.length} leases</span></div>${claims.length ? `<div class="task-table-wrap"><table class="task-table"><thead><tr><th scope="col">File / scope</th><th scope="col">Lease</th><th scope="col">Held by</th><th scope="col">Mode</th></tr></thead><tbody>${claims.map((claim) => `<tr class="task-row" data-claim="${esc(claim.id)}" tabindex="0" aria-label="View lease ${esc(claim.id)}"><td><span class="task-title">${icon("claims")}<span class="title-text mono">${esc(claim.scope.map((scope) => scope.file).join(", "))}</span></span></td><td><span class="pill ${claim.status === "queued" ? "amber" : ""}">${claim.status === "queued" ? "Queued" : "Active"}</span></td><td><span class="owner-chip">${avatar(claim.holder)}${esc(nameOf(claim.holder))}</span></td><td>${esc(claim.mode)}</td></tr>`).join("")}</tbody></table></div>` : empty("Space to work, without collisions", "File claims appear when an agent starts editing. The hub coordinates ownership and waiting agents automatically.", "claims")}</section>`;
}
function decisionsPanel() {
  return `<div class="section-heading"><h2>Decision log <span class="count">Latest ${state.decisions.length}</span></h2><button class="button secondary" data-action="decision">${icon("plus")}Record decision</button></div>${state.decisions.length ? `<div class="decision-list">${state.decisions.map((decision) => `<article class="panel decision-card"><div class="decision-card-head"><code>${esc(decision.id)}</code><span class="pill neutral">Recorded</span></div><h3>${esc(decision.summary)}</h3>${decision.rationale ? `<p>${esc(decision.rationale)}</p>` : ""}<div class="decision-files">${decision.files.map((file) => `<span class="file-chip">${esc(file)}</span>`).join("")}</div><div class="decision-meta"><span class="owner-chip">${avatar(decision.agent)}${esc(decision.agent)}</span><span>${timeAgo(decision.created_at)}</span>${decision.task_id ? `<span>${esc(decision.task_id)}</span>` : ""}</div></article>`).join("")}</div>` : `<section class="panel">${empty("Keep the why with the work", "Record an architectural decision so every agent has the same context. Entries are append-only.", "decisions")}</section>`}`;
}

function render() {
  if (!state) return;
  const current = view();
  document.title = `${views[current][0]} · AgentHub`;
  $("#page-title").textContent = views[current][0];
  $("#page-description").textContent = views[current][1];
  $("#breadcrumb-project").textContent = project;
  $("#workspace-name").textContent = project;
  $("#breadcrumb-view").textContent =
    current[0].toUpperCase() + current.slice(1);
  $("#agent-count").textContent = state.agents.filter(
    (agent) => agent.online,
  ).length;
  $("#task-count").textContent = state.tasks.filter(
    (task) => task.status === "in_progress" || task.status === "open",
  ).length;
  $("#identity-label").textContent = identity || "Set your identity";
  document.querySelectorAll("[data-view]").forEach((element) => {
    element.classList.toggle("active", element.dataset.view === current);
    if (element.dataset.view === current)
      element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  const screens = {
    overview: () =>
      `${stats()}<div class="overview-grid">${map()}${activityPanel()}</div><div class="section-heading"><h2>Agent workspaces <span class="count">${state.agents.length}</span></h2>${link("agents", "All agents")}</div>${agentCards()}${tasksPanel()}`,
    agents: () =>
      `${stats()}<div class="section-heading"><h2>Connected workspaces <span class="count">${state.agents.length}</span></h2><span class="all-clear">${icon("check")}Presence from agent heartbeats</span></div>${agentCards()}`,
    tasks: () => tasksPanel(true),
    claims: claimsPanel,
    decisions: decisionsPanel,
    activity: () =>
      `<section class="panel full-activity"><div class="panel-heading"><h2>Event timeline</h2><span class="pill neutral">Latest ${events.length} loaded events</span></div>${activityRows(150)}</section>`,
  };
  $("#content").innerHTML = screens[current]();
}

function modal(title, content, eyebrow = "WORKSPACE") {
  $("#modal-title").textContent = title;
  $("#modal-eyebrow").textContent = eyebrow;
  $("#modal-content").innerHTML = content;
  if (!$("#modal").open) $("#modal").showModal();
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  setTimeout(() => {
    $("#toast").hidden = true;
  }, 3500);
}
function settings() {
  modal(
    "Connection settings",
    `<p class="modal-copy">Connected directly to <strong>${esc(location.origin)}</strong>. Your token stays in memory and clears when you reload this page.</p><form id="settings-form"><label class="form-field">Hub bearer token<input name="token" type="password" autocomplete="off" placeholder="Only needed if the hub uses --token" value="${esc(token)}"></label><label class="form-field">Your identity<input name="identity" placeholder="alex/dashboard" value="${esc(identity)}" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}/[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" maxlength="129"><span class="form-help">Use human/agent format. Required when creating tasks or recording decisions.</span></label><p class="form-error" id="form-error" role="status"></p><div class="modal-actions"><button class="button primary" type="submit">Save & reconnect</button></div></form>`,
  );
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = String(data.get("identity")).trim();
    if (
      value &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
        value,
      )
    ) {
      $("#form-error").textContent = "Use an identity such as alex/dashboard.";
      return;
    }
    identity = value;
    token = String(data.get("token")).trim();
    sessionStorage.setItem("agenthub.identity", identity);
    events = [];
    cursor = 0;
    epoch = null;
    $("#modal").close();
    await refresh();
  });
}
function connectAgent() {
  const safeProject = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(project)
    ? project
    : "your-project";
  modal(
    "One more mind on the team.",
    `<p class="modal-copy">Run these commands in the Git worktree your coding agent will use. The adapter connects the session to this hub.</p><div class="instruction-step"><span>1</span><div><strong>Initialize your worktree</strong><pre class="code-block">hub init --project ${esc(safeProject)}
  --url ${esc(location.origin)}
  --agent your-name/claude-1</pre><p>Run the command on one line. Choose a unique identity for each agent.</p></div></div><div class="instruction-step"><span>2</span><div><strong>Open a coding session</strong><p>Start Claude Code in that worktree. The installed hooks and MCP server coordinate file claims, heartbeats, and team context.</p></div></div><div class="instruction-step"><span>3</span><div><strong>Watch the workspace come alive</strong><p>Agents appear here once they send a heartbeat. Their file claims, tasks, and decisions follow automatically.</p></div></div><p class="form-help">Requires the built hub CLI on your PATH. For a token-protected hub, set HUB_TOKEN in the agent’s shell.</p><div class="modal-actions"><a class="button secondary" href="https://github.com/aiden-guan/agenthub#quickstart" target="_blank" rel="noreferrer">Setup guide ${icon("external")}</a><button class="button primary" data-action="close">Got it</button></div>`,
    "CONNECT AN AGENT",
  );
}

function mutationForm(kind) {
  if (!state || !connected) {
    settings();
    return;
  }
  const task = kind === "task";
  modal(
    task ? "Make the next move." : "Leave useful context.",
    `<p class="modal-copy">${task ? "Give your team a clear piece of work. Agents can pick it up through the hub." : "Record the decision and the reasoning behind it. This entry is append-only."}</p><form id="mutation-form"><label class="form-field">Your identity<input name="agent" required placeholder="alex/dashboard" value="${esc(identity)}" maxlength="129"></label><label class="form-field">${task ? "Task title" : "Decision summary"}<input name="title" required maxlength="500" placeholder="${task ? "What needs to happen?" : "What did the team decide?"}"></label><label class="form-field">${task ? "Description" : "Rationale"} <span class="form-help">Optional context for the next person or agent.</span><textarea name="description" placeholder="A little context goes a long way…" maxlength="10000"></textarea></label>${
      task && state.tasks.length
        ? `<label class="form-field">Depends on<select name="dependency"><option value="">No dependency</option>${state.tasks
            .filter((item) => item.status !== "cancelled")
            .map(
              (item) =>
                `<option value="${esc(item.id)}">${esc(item.id)} — ${esc(item.title)}</option>`,
            )
            .join("")}</select></label>`
        : ""
    }<p class="form-error" id="form-error" role="status"></p><div class="modal-actions"><button class="button secondary" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">${task ? "Create task" : "Record decision"}${icon("arrow")}</button></div></form>`,
    task ? "NEW TASK" : "RECORD DECISION",
  );
  $("#mutation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const agent = String(data.get("agent")).trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
        agent,
      )
    ) {
      $("#form-error").textContent =
        "Use human/agent format, for example alex/dashboard.";
      return;
    }
    const title = String(data.get("title")).trim();
    if (!title) {
      $("#form-error").textContent = "Please enter a title.";
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    const previousIdentity = identity;
    try {
      identity = agent;
      await request(
        endpoint(task ? "/tasks" : "/decisions"),
        task
          ? {
              title,
              description: data.get("description"),
              deps: data.get("dependency") ? [data.get("dependency")] : [],
            }
          : { summary: title, rationale: data.get("description") },
      );
      sessionStorage.setItem("agenthub.identity", identity);
      $("#modal").close();
      if (task) taskFilter = "active";
      await refresh();
      toast(
        task
          ? "Task created. Your team is up next."
          : "Decision recorded. Context shared.",
      );
    } catch (error) {
      identity = previousIdentity;
      $("#form-error").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}
function taskDetail(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  modal(
    task.title,
    `<span class="pill ${task.blocked_by.length ? "amber" : "neutral"}">${statusLabel(task)}</span><dl class="detail-grid"><div><dt>Assigned to</dt><dd>${esc(task.owner || "Unassigned")}</dd></div><div><dt>Created by</dt><dd>${esc(task.created_by || "Unknown")}</dd></div><div><dt>Dependencies</dt><dd>${esc(task.deps.join(", ") || "None")}</dd></div><div><dt>Updated</dt><dd>${timeAgo(task.updated_at)}</dd></div></dl>${task.description ? `<p class="modal-copy">${esc(task.description).replace(/\n/g, "<br>")}</p>` : ""}${task.blocked_by.length ? `<p class="modal-copy">Waiting for ${esc(task.blocked_by.join(", "))} to complete.</p>` : ""}<p class="form-help">Agents take tasks through the CLI or MCP tools.</p><pre class="code-block">hub task take ${esc(task.id)}</pre>`,
    task.id,
  );
}
function agentDetail(id) {
  const agent = state.agents.find((item) => item.agent === id);
  if (!agent) return;
  const claims = state.claims.filter((item) => item.holder === id);
  modal(
    agent.agent,
    `<span class="pill ${agent.online ? "" : "amber"}">${agent.online ? "Online" : "Offline"}</span><dl class="detail-grid"><div><dt>Client</dt><dd>${esc(agent.client || shortClient(id))}</dd></div><div><dt>Last heartbeat</dt><dd>${timeAgo(agent.last_seen)}</dd></div><div><dt>Branch</dt><dd>${esc(agent.branch || "Not reported")}</dd></div><div><dt>Current task</dt><dd>${esc(agent.current_task || "No task in progress")}</dd></div></dl><p class="form-help">Worktree</p><pre class="code-block">${esc(agent.worktree || "Not reported")}</pre><p class="form-help">${claims.length} active or queued leases</p><div class="decision-files">${claims.flatMap((claim) => claim.scope.map((scope) => `<span class="file-chip">${esc(scope.file)}</span>`)).join("")}</div>`,
    "AGENT WORKSPACE",
  );
}
function claimDetail(id) {
  const claim = state.claims.find((item) => item.id === id);
  if (!claim) return;
  modal(
    "A little space to build.",
    `<span class="pill ${claim.status === "queued" ? "amber" : ""}">${esc(claim.status)} · ${esc(claim.mode)}</span><dl class="detail-grid"><div><dt>Held by</dt><dd>${esc(claim.holder)}</dd></div><div><dt>Task</dt><dd>${esc(claim.task_id || "No linked task")}</dd></div><div><dt>Lease duration</dt><dd>${claim.ttl_ms / 1000}s</dd></div><div><dt>Expires at</dt><dd>${esc(new Date(claim.expires_at).toLocaleTimeString())}</dd></div></dl><p class="modal-copy">${esc(claim.intent)}</p><div class="decision-files">${claim.scope.map((scope) => `<span class="file-chip">${esc(scope.file)}</span>`).join("")}</div><p class="form-help">Lease renewal and release are managed by the owning agent. The dashboard does not send agent heartbeats.</p>`,
    claim.id,
  );
}
function search() {
  modal(
    "Find your next step.",
    '<label class="form-field">Search workspace<input class="search-input" id="search-input" placeholder="Agents, tasks, files, decisions…" autocomplete="off"></label><div class="search-results" id="search-results"></div>',
    "QUICK FIND",
  );
  const update = () => {
    const query = $("#search-input").value.trim().toLowerCase();
    const items = [
      ...state.tasks.map((item) => ({
        label: `${item.id} ${item.title}`,
        type: "Task",
        action: "task",
        id: item.id,
        glyph: "tasks",
      })),
      ...state.agents.map((item) => ({
        label: item.agent,
        type: "Agent",
        action: "agent",
        id: item.agent,
        glyph: "agents",
      })),
      ...state.claims.map((item) => ({
        label: item.scope.map((scope) => scope.file).join(", "),
        type: "Lease",
        action: "claim",
        id: item.id,
        glyph: "claims",
      })),
      ...state.decisions.map((item) => ({
        label: `${item.id} ${item.summary}`,
        type: "Decision",
        action: "view",
        id: "decisions",
        glyph: "decisions",
      })),
    ]
      .filter((item) => !query || item.label.toLowerCase().includes(query))
      .slice(0, 15);
    $("#search-results").innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<button class="search-result" data-${item.action}="${esc(item.id)}">${icon(item.glyph)}<span>${esc(item.label)}</span><small>${item.type}</small></button>`,
          )
          .join("")
      : '<p class="modal-copy">No matches. Try a name, file path, or task title.</p>';
  };
  $("#search-input").addEventListener("input", update);
  update();
}
function switchWorkspace() {
  modal(
    "Choose your workspace.",
    `<p class="modal-copy">Projects known to this hub. Each has its own agents, leases, and activity.</p>${projects.map((item) => `<button class="project-item" data-project="${esc(item)}">${icon("folder")}<span>${esc(item)}</span>${icon(item === project ? "check" : "arrow")}</button>`).join("")}<form id="project-form"><label class="form-field">Open a project by name<input name="project" required placeholder="your-project" maxlength="128"></label><p class="form-error" id="form-error" role="status"></p><div class="modal-actions"><button class="button primary" type="submit">Open workspace</button></div></form>`,
  );
  $("#project-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = String(
      new FormData(event.currentTarget).get("project"),
    ).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) {
      $("#form-error").textContent =
        "Use letters, numbers, dots, dashes, slashes, or underscores. Start with a letter or number.";
      return;
    }
    changeProject(value);
  });
}
function changeProject(value) {
  project = value;
  cursor = 0;
  epoch = null;
  events = [];
  state = null;
  const url = new URL(location.href);
  url.searchParams.set("project", project);
  history.replaceState(null, "", url);
  $("#modal").close();
  refresh();
}

document.addEventListener("click", (event) => {
  const element = event.target.closest(
    "[data-action],[data-filter],[data-task],[data-agent],[data-claim],[data-project],[data-view]",
  );
  if (!element) return;
  const data = element.dataset;
  if (data.filter) {
    taskFilter = data.filter;
    render();
  }
  if (data.task) taskDetail(data.task);
  if (data.agent) agentDetail(data.agent);
  if (data.claim) claimDetail(data.claim);
  if (data.project) changeProject(data.project);
  if (data.view && element.tagName === "BUTTON") {
    $("#modal").close();
    location.hash = data.view;
  }
  if (data.action === "close") $("#modal").close();
  if (data.action === "connect") connectAgent();
  if (data.action === "new-task") mutationForm("task");
  if (data.action === "decision") mutationForm("decision");
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state) search();
  }
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches("tr[data-task],tr[data-claim]")
  ) {
    event.preventDefault();
    event.target.click();
  }
});
$("#new-task").addEventListener("click", () => mutationForm("task"));
$("#connect-agent").addEventListener("click", connectAgent);
$("#connection-settings").addEventListener("click", settings);
$("#identity-settings").addEventListener("click", settings);
$("#close-modal").addEventListener("click", () => $("#modal").close());
$("#refresh").addEventListener("click", refresh);
$("#workspace-switch").addEventListener("click", switchWorkspace);
$("#breadcrumb-project").addEventListener("click", switchWorkspace);
$("#mobile-settings")?.addEventListener("click", settings);
$("#header-search")?.addEventListener("click", () => { if (state) search(); });
$("#search-trigger").addEventListener("click", () => {
  if (state) search();
});
window.addEventListener("hashchange", render);
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
$("#sample-label").hidden = params.get("sample") !== "1";
setInterval(() => {
  if (!document.hidden) refresh();
  if (lastSuccess && Date.now() - lastSuccess > 15000)
    $("#last-updated").textContent =
      `Last synced ${Math.floor((Date.now() - lastSuccess) / 1000)}s ago`;
}, 5000);
await refresh();
