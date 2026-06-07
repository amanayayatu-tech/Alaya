import { isSemanticDuplicate } from "./knowledgeSimilarity";

export function detectPredictionStagnation(errorHistory: number[], window = 3): boolean {
  const clean = errorHistory.filter((value) => Number.isFinite(value));
  if (clean.length < window) return false;
  const recent = clean.slice(-window);
  if (recent.every((value) => value <= 0.05)) return false;
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i] < recent[i - 1] - 0.01) return false;
  }
  return true;
}

export function detectGoalRepetition(newGoal: string, rejectedGoals: string[], threshold = 0.82): boolean {
  const goal = newGoal.trim();
  if (!goal) return true;
  return rejectedGoals.some((existing) => {
    const other = existing.trim();
    if (!other) return false;
    if (goal === other) return true;
    return isSemanticDuplicate(
      { title: goal, content: goal },
      { title: other, content: other },
      threshold,
    );
  });
}

export function detectKnowledgeMaturationStall(strongCountHistory: number[], window = 5): boolean {
  const clean = strongCountHistory.filter((value) => Number.isFinite(value));
  if (clean.length < window) return false;
  const recent = clean.slice(-window);
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i] > recent[i - 1]) return false;
  }
  return recent[recent.length - 1] <= recent[0];
}

export function detectKnowledgeExplosion(knowledgeSizeHistory: number[]): boolean {
  const clean = knowledgeSizeHistory.filter((value) => Number.isFinite(value));
  if (clean.length < 6) return false;
  const recent = clean.slice(-6);
  const deltas = recent.slice(1).map((value, index) => value - recent[index]);
  if (deltas.some((delta) => delta < 0)) return false;
  const totalGrowth = recent[recent.length - 1] - recent[0];
  const firstHalf = deltas.slice(0, 2).reduce((sum, delta) => sum + delta, 0) / 2;
  const secondHalf = deltas.slice(-2).reduce((sum, delta) => sum + delta, 0) / 2;
  return totalGrowth >= 6 && secondHalf >= firstHalf && recent[recent.length - 1] >= recent[0] * 1.8;
}

export type AutonomousStopRiskKey =
  | "evolution_stalled"
  | "goal_repetition"
  | "maturation_stall"
  | "knowledge_explosion";

export interface AutonomousStopRiskInput {
  errors: number[];
  strongCountHistory: number[];
  decisionKnowledgeSizeHistory: number[];
  proposedGoal: string;
  rejectedGoals: string[];
}

export interface AutonomousStopRisk {
  riskKey: AutonomousStopRiskKey;
  evidence: Record<string, unknown>;
}

export function evaluateAutonomousStopRisk(input: AutonomousStopRiskInput): AutonomousStopRisk | null {
  const histories = {
    errors: input.errors,
    strongCountHistory: input.strongCountHistory,
    decisionKnowledgeSizeHistory: input.decisionKnowledgeSizeHistory,
  };
  if (detectPredictionStagnation(input.errors, 3)) {
    return {
      riskKey: "evolution_stalled",
      evidence: { ...histories, window: 3, threshold: "last 3 non-zero errors did not improve by at least 0.01" },
    };
  }
  if (detectGoalRepetition(input.proposedGoal, input.rejectedGoals, 0.82)) {
    return {
      riskKey: "goal_repetition",
      evidence: { proposedGoal: input.proposedGoal, rejectedGoals: input.rejectedGoals, threshold: 0.82 },
    };
  }
  const activeStrongGrowthWindow = input.decisionKnowledgeSizeHistory.slice(-5);
  const activeStrongGrowth = activeStrongGrowthWindow.length >= 2
    ? activeStrongGrowthWindow[activeStrongGrowthWindow.length - 1] - activeStrongGrowthWindow[0]
    : 0;
  if (activeStrongGrowth >= 3 && detectKnowledgeMaturationStall(input.strongCountHistory, 5)) {
    return {
      riskKey: "maturation_stall",
      evidence: { ...histories, activeStrongGrowth, window: 5 },
    };
  }
  if (detectKnowledgeExplosion(input.decisionKnowledgeSizeHistory)) {
    return {
      riskKey: "knowledge_explosion",
      evidence: { ...histories, sizeMetric: "active+strong non-superseded knowledge" },
    };
  }
  return null;
}
