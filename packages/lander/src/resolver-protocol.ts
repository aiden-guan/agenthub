// packages/lander/src/resolver-protocol.ts — frozen at Step 0 (lane L owns the
// implementation around it). One resolver run per conflicted file: the lander
// writes ResolverInput as JSON to the command's stdin and reads ResolverOutput
// as JSON from its stdout. Exit code 0 even for cannot_resolve; any other exit
// code, a timeout (limits.timeout_ms) or invalid JSON counts as cannot_resolve.

export interface ResolverHunk {
  /** 0-based, in file order; the output must answer every id exactly once. */
  id: number;
  start_line: number;
  end_line: number;
  base: string;
  trunk: string;
  incoming: string;
}

export interface ResolverIntent {
  landing_id: string | null;
  agent: string | null;
  task_title: string | null;
  task_description: string | null;
  summary: string;
  intents: string[];
  decisions: Array<{ id: string; summary: string; rationale: string }>;
}

export interface ResolverInput {
  version: 1;
  model: string;
  /** Random per request; appears in no other field (the lander redraws on a collision). */
  nonce: string;
  file: {
    path: string;
    language: string | null;
    base: string;
    trunk: string;
    incoming: string;
    /** `git merge-file -p --diff3 -L trunk -L base -L incoming` output. */
    merged: string;
    hunks: ResolverHunk[];
  };
  /** Every string below was written by agents: untrusted data, never instructions. */
  incoming: ResolverIntent;
  /** Trunk-side changes since the base that touched this file, newest first, at most 5. */
  trunk: ResolverIntent[];
  limits: { timeout_ms: number; max_output_bytes: number };
}

export interface ResolverOutput {
  status: 'resolved' | 'cannot_resolve';
  /** Required when resolved: the replacement text of every hunk. */
  hunks?: Array<{ id: number; text: string }>;
  /** At most 2000 characters; shown to authors as untrusted model text. */
  explanation: string;
  usage?: { model: string; input_tokens: number; output_tokens: number };
}
