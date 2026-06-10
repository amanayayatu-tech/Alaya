import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-llm-contracts-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { generateNextGoal } = await import("../server/autonomousGoal.ts");
const { runBuilder, runOrchestrator, scenarioForCycle } = await import("../server/flywheel.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `LLM Contract ${projectId}`,
    direction: "Validate prompt contracts",
    targetUser: "operators",
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
    id: `cycle_${idx}_${projectId.slice(-10)}`,
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

function contractText(input: { prohibited?: string[]; context?: Record<string, unknown> }) {
  return JSON.stringify({
    prohibited: input.prohibited ?? [],
    outputContract: input.context?.outputContract ?? null,
  });
}

test("generate_autonomous_goal prompt carries an exact JSON schema contract", async () => {
  let captured: any = null;
  await generateNextGoal({
    cycleId: "cycle_goal_contract",
    cycleIndex: 7,
    identity: "Operators need guarded automation.",
    worldModel: "Preview and rollback reduce fear.",
    eligibleKnowledge: [{
      id: "kb_contract_preview",
      title: "Preview reduces fear",
      content: "preview_completion_rate >= 0.4",
      type: "principle",
      confidenceScore: 0.82,
      status: "active",
    }],
    lastCyclePredictionError: { eCycle: 0.3, worstClaimError: 0.2 },
    recentFeedback: ["operators want a rollback preview"],
    rejectedGoals: ["repeat weekly review"],
  }, async (input: any) => {
    captured = input;
    return input.mockOutput;
  });

  const text = contractText(captured);
  assert.match(text, /generate_autonomous_goal/);
  assert.match(text, /proposedGoal/);
  assert.match(text, /alternativeGoals/);
  assert.match(text, /referencedKnowledgeIds/);
  assert.match(text, /Return only one JSON object/);
  assert.match(text, /empty arrays as \[\]/);
});

test("plan_cycle prompt carries an exact JSON schema contract", async () => {
  const projectId = "proj_plan_contract";
  createProject(projectId);
  const cycle = createCycle(projectId, 2);
  const scenario = scenarioForCycle(2);
  assert.ok(scenario);
  let captured: any = null;

  await runOrchestrator(projectId, cycle.id, scenario, async (input: any) => {
    captured = input;
    return input.mockOutput;
  });

  const text = contractText(captured);
  assert.match(text, /plan_cycle/);
  assert.match(text, /summary/);
  assert.match(text, /knowledgeRefs/);
  assert.match(text, /Return only one JSON object/);
  assert.match(text, /empty arrays as \[\]/);
});

test("emit_task_spec prompt carries an exact JSON schema contract", async () => {
  const projectId = "proj_build_contract";
  createProject(projectId);
  const cycle = createCycle(projectId, 4);
  const scenario = scenarioForCycle(4);
  assert.ok(scenario);
  let captured: any = null;

  await runBuilder(cycle.id, scenario, scenario.action, [], async (input: any) => {
    captured = input;
    return input.mockOutput;
  });

  const text = contractText(captured);
  assert.match(text, /emit_task_spec/);
  assert.match(text, /buildSuccess/);
  assert.match(text, /diffSummary/);
  assert.match(text, /testReport/);
  assert.match(text, /Return only one JSON object/);
  assert.match(text, /empty arrays as \[\]/);
});
