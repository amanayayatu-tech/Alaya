// Client-side types & helpers for Alaya. Mirrors the API response shapes.

export interface Project {
  id: string; name: string; direction: string; targetUser: string;
  redlines: string[]; weeklyHumanMinutes: number; weeklyLlmBudgetCents: number;
  firstClaimMetric: string; firstClaimOperator: string; firstClaimTarget: number;
  seedIdentity: string; worldModel: string; currentCycleIdx: number; version: number;
}
export interface Cycle {
  id: string; projectId: string; idx: number; goal: string;
  status: "planning" | "running" | "closed";
  eCycle: number | null; worstClaimError: number | null; reasoning: string; version: number;
}
export interface KnowledgeItem {
  id: string; projectId: string; type: string; title: string; content: string;
  sourceType: string; sourceRef: string; evidenceAlpha: number; evidenceBeta: number;
  confidenceScore: number; confidenceLevel: string; status: string;
  humanApprovedCount: number; externalVerifiedCount: number; validFrom: string;
  validUntil: string | null; lastValidatedCycle: number; createdByCycle: number;
  createdBy: string; approvedBy: string | null; usageCount: number;
  tags: string[]; notes: string; version: number;
  referencedByAgents?: { agent: string; cycleIdx: number; action: string }[];
  referencedByAgentsLimit?: number;
  referencedByAgentsTruncated?: boolean;
}
export interface Claim {
  id: string; type: string; metric?: string; operator?: string; target?: number;
  observed?: number | null; weight: number; error?: number | null;
  expectedObservation?: string; timeWindow?: string; successThreshold?: string;
  failureThreshold?: string; uncertainty?: number;
}
export interface Prediction {
  id: string; cycleId: string; belief: string; prediction: string; action: string;
  claims: Claim[]; observation: string | null; predictionError: number | null;
  worstClaimError: number | null; errorType: string | null; updateTarget: string | null;
  status: string; knowledgeRefs: string[];
}
export interface HumanGate {
  id: string; cycleId: string; type: "direction" | "meaning" | "risk";
  blocking: number; title: string;
  payload: {
    recommended?: string;
    alternatives?: string[];
    knowledgeRefs?: string[];
    reasoning?: string;
    userQuote?: string;
    mergedCount?: number;
    source?: string;
    category?: string;
    sentiment?: string;
    topicKey?: string;
    summary?: string;
    rollbackTrigger?: string;
    rollbackPlan?: {
      packageType?: string;
      modifiedObjects?: string[];
      rollbackSteps?: string[];
      riskLevel?: string;
    };
    auditSummary?: {
      stage?: string;
      whyNow?: string;
      deltaFromCycle3?: string;
      verificationConstraints?: string[];
    };
  };
  status: string; estimatedMinutes: number; decision: string | null; version: number;
}
export interface AgentRun {
  id: number; cycleId: string; cycleIdx: number; agent: string; action: string;
  outputSummary: string; knowledgeRefsUsed: string[]; ts: string;
}
export interface Dashboard {
  project: Project; currentCycle: Cycle; cycleCount: number; flywheelStage: string;
  pendingHuman: number;
  gateBudget: {
    budget: number;
    used: number;
    remaining: number;
    pendingBlocking: number;
    pendingNonBlocking: number;
    oldestBlockingAgeDays: number;
    safetyMode: boolean;
  };
  llmBudget: {
    budgetCents: number;
    usedCents: number;
    remainingCents: number;
    usedUsd: number;
    budgetUsd: number;
    weeklyWindowStart: string;
    overBudget: boolean;
    pendingBudgetGate: boolean;
    acknowledgedThisWeek: boolean;
  };
  openPredictions: number; blockingRisks: number; knowledgeCount: number; strongCount: number;
  recentKnowledge: KnowledgeItem[];
}
export interface CycleReview {
  cycle: Cycle;
  feedback: {
    id: string;
    text: string;
    category: string;
    sentiment: string;
    sourceType: string;
    sourceRef: string;
    sourceUrl: string;
    topicKey: string;
    summary: string;
    externalUpdatedAt: string;
  }[];
  predictions: Prediction[];
  tasks: { id: string; agent: string; kind: string; status: string; spec: string }[];
  agentRuns: AgentRun[];
  decisions: { id: string; gateType: string; decision: string; rationale: string }[];
  referencedKnowledge: KnowledgeItem[];
  knowledgeUpdated: KnowledgeItem[];
  bugs: { id: string; text: string; sourceType: string; sourceRef: string }[];
}

export const AGENT_ORDER = ["orchestrator", "sensor", "builder", "distiller", "librarian"];
export const AGENT_LABEL: Record<string, string> = {
  orchestrator: "Orchestrator", sensor: "Sensor", builder: "Builder",
  distiller: "Distiller", librarian: "Librarian", idle: "Idle",
};

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x == null) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}
export function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x == null) return "—";
  return x.toFixed(digits);
}

export const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  provisional: "bg-muted text-muted-foreground border-border",
  active: "bg-chart-2/15 text-chart-2 border-chart-2/30",
  strong: "bg-primary/15 text-primary border-primary/40",
  stale: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  expired: "bg-muted text-muted-foreground border-border line-through",
  conflict: "bg-destructive/15 text-destructive border-destructive/30",
  quarantined: "bg-destructive/15 text-destructive border-destructive/30",
};
export const CONFIDENCE_TONE: Record<string, string> = {
  low: "text-muted-foreground", medium: "text-chart-2",
  high: "text-primary", verified: "text-chart-5",
};
export const ERROR_TYPE_TONE: Record<string, string> = {
  perception: "text-chart-4", execution: "text-chart-4",
  model: "text-chart-3", value: "text-destructive",
};

export function errorToAccuracy(e: number | null): number | null {
  if (e == null) return null;
  return Math.max(0, 1 - e);
}
