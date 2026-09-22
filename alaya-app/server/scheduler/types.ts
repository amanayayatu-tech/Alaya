import type { SyncGithubIssuesOptions } from "../externalFeedback";
import type { KnowledgeRetrievalIdentity } from "../knowledgeInjection";

export interface GateBudgetState {
  budget: number;
  used: number;
  remaining: number;
  pendingEstimatedMinutes: number;
  pendingOverBudget2x: boolean;
  weeklyOverFiveHours: boolean;
  pendingBlocking: number;
  pendingNonBlocking: number;
  oldestBlockingAgeDays: number;
  safetyMode: boolean;
}

export interface LlmBudgetState {
  budgetCents: number;
  usedCents: number;
  remainingCents: number;
  usedUsd: number;
  budgetUsd: number;
  weeklyWindowStart: string;
  overBudget: boolean;
  pendingBudgetGate: boolean;
  acknowledgedThisWeek: boolean;
}

export type SchedulerTickAction =
  | "no_cycle"
  | "opened_direction_gate"
  | "waiting_blocking_gate"
  | "waiting_feedback_window"
  | "ran_operational_stages"
  | "created_next_cycle"
  | "created_speculative_draft"
  | "speculative_budget_exhausted"
  | "apply_executor_ran"
  | "safety_mode"
  | "safety_throttled"
  | "skipped";

export interface SchedulerTickResult {
  projectId: string;
  action: SchedulerTickAction;
  throttledAction?: Exclude<SchedulerTickAction, "safety_throttled">;
  cycleId?: string;
  nextCycleId?: string;
  budget: GateBudgetState;
  llmBudget?: LlmBudgetState;
  note: string;
}

export interface SchedulerTickOptions {
  feedbackSync?: SyncGithubIssuesOptions;
  knowledgeRetrievalIdentity?: KnowledgeRetrievalIdentity;
}
