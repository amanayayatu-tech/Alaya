import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-round4-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { runFullCycle, resolveCycleStimulus, scenarioForCycle } = await import("../server/flywheel.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Round4 ${projectId}`,
    direction: "Validate compounding governance",
    targetUser: "owner operators",
    redlines: JSON.stringify(["no irreversible action without rollback"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya compounds preview, rollback and audit knowledge.",
    worldModel: "High-risk automation needs preview, rollback and audit evidence.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  const scenario = scenarioForCycle(idx);
  return storage.createCycle({
    id: `cycle_${idx}_${projectId.slice(-6)}`,
    projectId,
    idx,
    goal: scenario?.proposedGoal ?? `cycle ${idx}`,
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

test("cycle 4 scenario is independent from cycle 3", () => {
  const cycle3 = scenarioForCycle(3);
  const cycle4 = scenarioForCycle(4);
  assert.ok(cycle3, "cycle 3 scenario should exist");
  assert.ok(cycle4, "cycle 4 scenario should exist");
  assert.notEqual(cycle4.proposedGoal, cycle3.proposedGoal);
  assert.notEqual(cycle4.action, cycle3.action);
  assert.notDeepEqual(cycle4.feedback, cycle3.feedback);
  assert.match(`${cycle4.alternativeGoals.join(" ")} ${cycle4.feedback.map((item) => item.text).join(" ")}`, /回滚|审计|audit|rollback/);
});

test("cycle 4 execution creates at least one new principle for that round", async () => {
  const projectId = "proj_round4_creates";
  createProject(projectId);

  for (let idx = 1; idx <= 3; idx += 1) {
    const cycle = createCycle(projectId, idx);
    await runFullCycle(projectId, cycle.id);
  }

  const beforeRound4 = new Set(storage.listKnowledge(projectId).map((item) => item.id));
  const cycle4 = createCycle(projectId, 4);
  await runFullCycle(projectId, cycle4.id);

  const newRound4Principles = storage.listKnowledge(projectId).filter((item) => (
    !beforeRound4.has(item.id) &&
    item.type === "principle" &&
    item.createdByCycle === 4 &&
    item.sourceRound === 4
  ));
  assert.ok(newRound4Principles.length >= 1, "cycle 4 should create at least one new principle");
  assert.match(`${newRound4Principles[0].title} ${newRound4Principles[0].content}`, /回滚|审计|audit|rollback/);
});

test("cycle numbers above 3 do not reuse cycle 3 or emit a scenario reuse warning", async () => {
  const projectId = "proj_round4_no_reuse";
  createProject(projectId);

  for (let idx = 1; idx <= 4; idx += 1) {
    const cycle = createCycle(projectId, idx);
    await runFullCycle(projectId, cycle.id);
  }

  const cycle3 = scenarioForCycle(3);
  const cycle5 = await resolveCycleStimulus(projectId, 5, `cycle_5_${projectId.slice(-6)}`);
  assert.equal(cycle5.index, 5);
  assert.notEqual(cycle5.proposedGoal, cycle3?.proposedGoal);
  assert.doesNotMatch(cycle5.proposedGoal, /由系统基于前轮知识生成/);
});
