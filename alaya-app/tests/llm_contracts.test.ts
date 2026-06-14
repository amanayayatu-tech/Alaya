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

function createKnowledge(projectId: string, id: string, overrides: Record<string, unknown> = {}) {
  const title = String(overrides.title ?? `Knowledge ${id}`);
  const content = String(overrides.content ?? "Preview, rollback, and audit evidence reduce high-risk automation fear.");
  return storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title,
    content,
    sourceType: "metric",
    sourceRef: String(overrides.sourceRef ?? "llm-contract"),
    evidenceAlpha: 4,
    evidenceBeta: 1,
    confidenceScore: Number(overrides.confidenceScore ?? 0.8),
    confidenceLevel: String(overrides.confidenceLevel ?? "high"),
    status: String(overrides.status ?? "active"),
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: Number(overrides.lastValidatedCycle ?? 1),
    createdByCycle: Number(overrides.createdByCycle ?? 1),
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["preview", "rollback", "auditability"]),
    notes: "",
    semanticKey: String(overrides.semanticKey ?? id),
    supersededBy: null,
    version: 1,
    ...overrides,
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

test("generate_autonomous_goal prompt bounds knowledge and rejected-goal context", async () => {
  let captured: any = null;
  await generateNextGoal({
    cycleId: "cycle_goal_bounds",
    cycleIndex: 70,
    identity: "Operators need guarded automation.",
    worldModel: "Preview and rollback reduce fear.",
    eligibleKnowledge: Array.from({ length: 20 }, (_, index) => ({
      id: `kb_bounds_${String(index).padStart(2, "0")}`,
      title: `Bounded context knowledge ${index}`,
      content: `${"long evidence ".repeat(120)}${index}`,
      type: "principle",
      confidenceScore: 0.9 - (index * 0.01),
      status: index === 0 ? "strong" : "active",
    })),
    lastCyclePredictionError: { eCycle: 0.3, worstClaimError: 0.2 },
    recentFeedback: ["operators want a rollback preview"],
    rejectedGoals: Array.from({ length: 100 }, (_, index) => `rejected goal ${index}`),
  }, async (input: any) => {
    captured = input;
    return input.mockOutput;
  });

  assert.equal(captured.context.eligibleKnowledge.length, 12);
  assert.equal(captured.context.eligibleKnowledge[0].id, "kb_bounds_00");
  assert.equal(captured.context.eligibleKnowledge.every((item: any) => item.content.length <= 803), true);
  assert.equal(captured.context.rejectedGoals.length, 80);
  assert.equal(captured.context.rejectedGoals[0], "rejected goal 20");
  assert.equal(captured.knowledgeSummary.split("\n").length, 12);
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

test("plan_cycle prompt bounds active knowledge metadata and persisted refs", async () => {
  const projectId = "proj_plan_bounds";
  createProject(projectId);
  const cycle = createCycle(projectId, 2);
  const scenario = scenarioForCycle(2);
  assert.ok(scenario);
  const knowledgeIds = Array.from({ length: 60 }, (_, index) => `kb_plan_bounds_${String(index).padStart(2, "0")}`);
  for (const [index, id] of knowledgeIds.entries()) {
    createKnowledge(projectId, id, {
      title: `Plan context knowledge ${index}`,
      confidenceScore: 0.9 - (index * 0.001),
      createdByCycle: index,
    });
  }
  let captured: any = null;

  const plan = await runOrchestrator(projectId, cycle.id, scenario, async (input: any) => {
    captured = input;
    return {
      ...input.mockOutput,
      knowledgeRefs: knowledgeIds,
      reasoning: `引用 ${knowledgeIds[0]}: bounded refs should preserve the highest-ranked safe references only.`,
    };
  });

  assert.equal(captured.context.activeKnowledge.length, 50);
  assert.equal(captured.context.activeKnowledge[0].id, "kb_plan_bounds_00");
  assert.equal(plan.refs.length, 12);
  assert.deepEqual(plan.refs, knowledgeIds.slice(0, 12));
  const gate = storage.listGates(projectId).find((item) => item.cycleId === cycle.id && item.type === "direction");
  assert.ok(gate);
  const payload = JSON.parse(gate.payload);
  assert.equal(payload.knowledgeRefs.length, 12);
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
