import test from "node:test";
import assert from "node:assert/strict";

const { evaluateAutonomousStopRisk } = await import("../server/stallGuard.ts");

test("autonomous stop risk gate: evolution_stalled", () => {
  const risk = evaluateAutonomousStopRisk({
    errors: [0.6, 0.6, 0.61],
    strongCountHistory: [1, 2, 3, 4, 5],
    decisionKnowledgeSizeHistory: [2, 3, 4, 5, 6, 7],
    proposedGoal: "建立新的审计摘要复盘",
    rejectedGoals: [],
  });

  assert.equal(risk?.riskKey, "evolution_stalled");
  assert.equal(risk.evidence.window, 3);
});

test("autonomous stop risk gate: goal_repetition", () => {
  const risk = evaluateAutonomousStopRisk({
    errors: [0.6, 0.4, 0.2],
    strongCountHistory: [1, 2, 3, 4, 5],
    decisionKnowledgeSizeHistory: [2, 3, 4, 5, 6, 7],
    proposedGoal: "为删除动作增加 dry-run 预览",
    rejectedGoals: ["给删除动作增加预览"],
  });

  assert.equal(risk?.riskKey, "goal_repetition");
  assert.equal(risk.evidence.threshold, 0.82);
});

test("autonomous stop risk gate: maturation_stall", () => {
  const risk = evaluateAutonomousStopRisk({
    errors: [0.6, 0.4, 0.2],
    strongCountHistory: [2, 2, 2, 2, 2],
    decisionKnowledgeSizeHistory: [3, 3, 4, 5, 6],
    proposedGoal: "建立高风险任务的最小审计模板",
    rejectedGoals: ["先扩大流量"],
  });

  assert.equal(risk?.riskKey, "maturation_stall");
  assert.equal(risk.evidence.activeStrongGrowth, 3);
});

test("autonomous stop risk gate: knowledge_explosion", () => {
  const risk = evaluateAutonomousStopRisk({
    errors: [0.6, 0.4, 0.2],
    strongCountHistory: [1, 2, 3, 4, 5],
    decisionKnowledgeSizeHistory: [3, 5, 7, 10, 14, 19],
    proposedGoal: "建立高风险任务的最小审计模板",
    rejectedGoals: ["先扩大流量"],
  });

  assert.equal(risk?.riskKey, "knowledge_explosion");
  assert.equal(risk.evidence.sizeMetric, "active+strong non-superseded knowledge");
});
