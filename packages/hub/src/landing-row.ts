import type { LandPolicy, Landing, LanderControl } from './protocol.js';

/** The policy the hub applies until a lander reports trunk's agenthub.json (design §1.2). */
export const DEFAULT_LAND_POLICY: Readonly<LandPolicy> = Object.freeze({
  keep_place_retries: 2,
  sendback_grace_min: 30,
  approval_timeout_hours: 24,
  claim_gate: 'fail',
});

/** A project's lander control before anything was written: not paused, no trunk known, the default policy. */
export function defaultLanderControl(): LanderControl {
  return { paused: null, trunk: null, policy: { ...DEFAULT_LAND_POLICY } };
}

/** The columns a Phase 1 (record-mode) landing row has. */
export type Phase1LandingRow = Pick<Landing, 'id' | 'project' | 'agent' | 'task_id' | 'branch' | 'commit' | 'summary' | 'status' | 'created_at'>;

/** A Phase 1 landing as a full `Landing`: every Phase 2 and 3 field holds its neutral value. */
export function phase1Landing(row: Phase1LandingRow): Landing {
  return {
    id: row.id,
    project: row.project,
    agent: row.agent,
    task_id: row.task_id,
    branch: row.branch,
    commit: row.commit,
    summary: row.summary,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.created_at,
    queue_seq: null,
    position: null,
    eta_ms: null,
    phase: null,
    phase_at: null,
    attempt: 0,
    lander: null,
    lease_claim_id: null,
    in_doubt: false,
    deadline_at: null,
    base_sha: null,
    first_base: null,
    trunk_base: null,
    candidate: null,
    candidate_ref: null,
    candidate_checked: false,
    trunk_sha: null,
    files: [],
    scope: null,
    mapper: null,
    protected: [],
    approval: [],
    approvals: [],
    hold_ids: [],
    report: null,
    failure: null,
    retries: { trunk_moved: 0, lander_lost: 0, step_timeout: 0 },
    retry_of: null,
    retry: 0,
    supersedes: null,
    superseded_by: null,
    waits_for: null,
    landed_with: null,
    reconciled: false,
    started_at: null,
    ended_at: null,
  };
}
