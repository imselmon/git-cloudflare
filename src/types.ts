/** Shared types for Braid. Nouns follow the Braid design system: change, strand, weave. */

export type ChangeStatus = "open" | "claimed" | "submitted" | "queued" | "landed" | "rejected" | "failed";
export type Mode = "claims" | "optimistic";
export type AgentKind = "llm" | "synthetic" | "external";

export interface Change {
  id: string;
  title: string;
  body: string;
  scope: string[];
  accept: string;
  status: ChangeStatus;
  attempt: number;
  hint: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  landed_sha: string | null;
  priority: number;
}

export interface Claim {
  change_id: string;
  agent_id: string;
  strand: string;
  remote: string;
  base_sha: string;
  token_id: string;
  lease_expires: number;
  claimed_at: number;
}

export type AttemptOutcome = "landed" | "auto-merged" | "replay" | "rejected" | "expired" | "released" | "failed";

export interface Attempt {
  id: string;
  change_id: string;
  n: number;
  agent_id: string;
  strand: string;
  base_sha: string;
  head_sha: string | null;
  model: string | null;
  summary: string | null;
  rationale: string | null;
  review: string | null;
  outcome: AttemptOutcome | null;
  reason: string | null;
  files: string | null;
  trunk_sha: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface AgentRow {
  id: string;
  kind: AgentKind;
  model: string | null;
  status: string;
  done: number;
  last_seen: number;
}

export interface Stats {
  agents: number;
  strands: number;
  landed: number;
  automerged: number;
  replayed: number;
  prevented: number;
  rejected: number;
  expired: number;
  weaves: number;
  trunk_sha: string | null;
}

/** What the Integrator reports back for one attempt. */
export interface LandingResult {
  attempt_id: string;
  change_id: string;
  outcome: AttemptOutcome;
  reason?: string;
  files?: string[];
  trunk_sha?: string;
  review?: unknown;
  kind?: "clean" | "merged" | "union";
}

export interface ClaimResponse {
  change: Change;
  strand: string;
  remote: string;
  token: string;
  base_sha: string;
  lease_expires: number;
  attempt_id: string;
  mode: Mode;
}

export const TRUNK = "trunk";
export const BRANCH = "main";
export const NOTES_REF = "refs/notes/braid";
