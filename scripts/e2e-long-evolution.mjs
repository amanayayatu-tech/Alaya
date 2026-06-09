#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-long-evolution-")), "long.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../alaya-app/server/storage.ts");
const { runFullCycle } = await import("../alaya-app/server/flywheel.ts");
const { schedulerTickProject, gateBudgetForProject } = await import("../alaya-app/server/scheduler.ts");
const { detectGoalRepetition } = await import("../alaya-app/server/stallGuard.ts");

const projectId = "proj_long_evolution_e2e";
const TOTAL_CYCLES = 24;

function createProject() {
  storage.createProject({
    id: projectId,
    name: "Long Evolution E2E",
    direction: "Validate long-running autonomous Alaya evolution",
    targetUser: "owner operators running high-risk automation",
    redlines: JSON.stringify(["no irreversible action without preview, rollback and audit"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya must compound knowledge while preserving human gates and auditability.",
    worldModel: "High-risk automation adoption improves when preview, rollback, audit and clean knowledge retrieval are explicit.",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: "cycle_1_long_evolution",
    projectId,
    idx: 1,
    goal: "Validate the first high-risk automation learning loop",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function movingAverage(values, size) {
  if (values.length === 0) return 0;
  const recent = values.slice(-size);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function assertNoGoalRepetition(goals) {
  for (let i = 0; i < goals.length; i += 1) {
    for (let j = i + 1; j < goals.length; j += 1) {
      assert.equal(
        detectGoalRepetition(goals[j], [goals[i]], 0.82),
        false,
        `goal repeated between cycle ${i + 1} and ${j + 1}: ${goals[j]}`,
      );
    }
  }
}

createProject();

const tickActions = [];
for (let idx = 1; idx <= TOTAL_CYCLES; idx += 1) {
  const cycle = storage.listCycles(projectId).find((item) => item.idx === idx);
  assert.ok(cycle, `missing cycle ${idx}`);
  await runFullCycle(projectId, cycle.id);

  if (idx < TOTAL_CYCLES) {
    const tick = await schedulerTickProject(projectId);
    tickActions.push(tick.action);
    assert.notEqual(tick.action, "scenario_exhausted", `cycle ${idx + 1} must not stop on scenario exhaustion`);
    assert.equal(tick.action, "created_next_cycle", `scheduler should create cycle ${idx + 1}, got ${tick.action}: ${tick.note}`);
  }
}

const cycles = storage.listCycles(projectId);
assert.equal(cycles.length, TOTAL_CYCLES, "20 cycles should exist");
assert.equal(cycles.every((cycle) => cycle.status === "closed"), true, "all 20 cycles should be closed");
assert.equal(tickActions.length, TOTAL_CYCLES - 1, "first 19 ticks should create the next cycle");
assert.equal(tickActions.every((action) => action === "created_next_cycle"), true, "all ticks should create next planning cycle");

const knowledge = storage.listKnowledge(projectId);
const decisionKnowledge = knowledge.filter((item) => !item.supersededBy && ["active", "strong"].includes(item.status));
const mergeEvents = storage.listEvents().filter((event) => event.tableName === "knowledge_items" && event.op === "merge");
const errors = cycles.map((cycle) => cycle.eCycle).filter((value) => typeof value === "number" && Number.isFinite(value));
const goals = cycles.map((cycle) => cycle.goal);
const gateBudget = gateBudgetForProject(projectId);
const agentRuns = storage.listAgentRuns();
const pendingGates = storage.listGates(projectId).filter((gate) => gate.status === "pending");
const strong = knowledge.filter((item) => item.status === "strong");

assert.equal(errors.length, TOTAL_CYCLES, "every cycle should have prediction error");
assert.equal(Math.max(...errors) <= 1, true, "prediction errors should remain normalized");
assert.equal(movingAverage(errors, 5) <= errors[0], true, "prediction error moving average should not diverge");
assertNoGoalRepetition(goals);

assert.equal(decisionKnowledge.length <= 6, true, `decision knowledge should stay bounded, got ${decisionKnowledge.length}`);
assert.equal(mergeEvents.length >= 1, true, "long evolution must produce at least one merge event");
assert.equal(mergeEvents.every((event) => event.actor === "librarian"), true, "merge events must be audited by librarian");
assert.equal(knowledge.some((item) => item.supersededBy), true, "merged knowledge should keep supersededBy instead of being deleted");
assert.equal(strong.every((item) => item.humanApprovedCount >= 1), true, "strong knowledge must have human approval evidence");

assert.equal(gateBudget.pendingBlocking <= 1, true, "pending blocking gates should not expand");
assert.equal(gateBudget.pendingEstimatedMinutes <= gateBudget.budget * 2, true, "pending human budget should remain bounded");
assert.equal(pendingGates.filter((gate) => gate.blocking === 1).length <= 1, true, "blocking pending gates should remain bounded");

for (const idx of Array.from({ length: TOTAL_CYCLES }, (_, i) => i + 1)) {
  const runs = agentRuns.filter((run) => run.cycleIdx === idx);
  for (const agent of ["orchestrator", "sensor", "builder", "distiller", "librarian"]) {
    assert.ok(runs.some((run) => run.agent === agent), `missing ${agent} agent run for cycle ${idx}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  projectId,
  totalCycles: TOTAL_CYCLES,
  tickActions,
  assertions: {
    noScenarioExhausted: !tickActions.includes("scenario_exhausted"),
    boundedDecisionKnowledge: decisionKnowledge.length,
    mergeEvents: mergeEvents.length,
    errorFirst: errors[0],
    errorMovingAverageLast5: +movingAverage(errors, 5).toFixed(6),
    uniqueGoals: goals.length,
    pendingBlocking: gateBudget.pendingBlocking,
    pendingEstimatedMinutes: gateBudget.pendingEstimatedMinutes,
    strongWithHumanApproval: strong.map((item) => ({ id: item.id, humanApprovedCount: item.humanApprovedCount })),
  },
}, null, 2));
