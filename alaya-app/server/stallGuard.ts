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
