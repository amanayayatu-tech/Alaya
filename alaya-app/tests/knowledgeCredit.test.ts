import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-knowledge-credit-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { rawDb, storage } = await import("../server/storage.ts");
const { recordTrace } = await import("../server/trace.ts");
const { evaluatePrediction } = await import("../server/flywheel.ts");
const { computeCreditUpdates } = await import("../server/knowledgeCredit.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Credit ${projectId}`,
    direction: "Validate learning-loop credit assignment",
    targetUser: "operator teams",
    redlines: JSON.stringify(["do not bypass knowledge lifecycle gates"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Credit should follow resolved prediction outcomes.",
    worldModel: "Injected knowledge should receive outcome evidence without lifecycle promotion.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  return storage.createCycle({
    id: `cycle_credit_${idx}_${projectId}`,
    projectId,
    idx,
    goal: `credit cycle ${idx}`,
    status: "running",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, patch: Record<string, any> = {}) {
  return storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: patch.title ?? `${id} preview rollback principle`,
    content: patch.content ?? "preview rollback audit knowledge can change a decision",
    sourceType: "metric",
    sourceRef: "credit-test",
    evidenceAlpha: patch.evidenceAlpha ?? 2,
    evidenceBeta: patch.evidenceBeta ?? 1,
    confidenceScore: patch.confidenceScore ?? 2 / 3,
    confidenceLevel: patch.confidenceLevel ?? "medium",
    status: patch.status ?? "active",
    humanApprovedCount: patch.humanApprovedCount ?? 0,
    externalVerifiedCount: patch.externalVerifiedCount ?? 0,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: patch.lastValidatedCycle ?? 1,
    createdByCycle: patch.createdByCycle ?? 1,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: null,
    lastVerifiedAt: null,
    lastDecayedAt: null,
    grayStreak: 0,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: patch.sourceRound ?? 1,
    tags: JSON.stringify(["credit", "preview"]),
    notes: "",
    supersededBy: null,
    semanticKey: "",
    version: 1,
    ...patch,
  });
}

function recordInjection(projectId: string, cycleId: string, cycleIdx: number, injectedKnowledgeIds: string[]) {
  recordTrace({
    projectId,
    cycleId,
    cycleIdx,
    kind: "knowledge_injection",
    name: "build_prior_knowledge_context",
    agent: "orchestrator",
    attributes: { injectedKnowledgeIds },
  });
}

function scenario(index: number, observed: number) {
  return {
    index,
    proposedGoal: `credit goal ${index}`,
    alternativeGoals: [],
    belief: "credit belief",
    prediction: "activation_rate >= 0.3",
    action: "credit action",
    activationObserved: observed,
    activationTarget: 0.3,
    feedback: [],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
    predictionMetric: "activation_rate",
    predictionOperator: ">=",
    predictionTarget: 0.3,
    knowledgeRefs: [],
    reasoningHowKnowledgeChangedDecision: "credit test",
  } as any;
}

function plan() {
  return {
    belief: "credit belief",
    prediction: "activation_rate >= 0.3",
    action: "credit action",
    refs: [],
  };
}

function countCreditEvents(cycleId: string, knowledgeId: string): number {
  const rows = rawDb.prepare(`
    SELECT after FROM event_log
    WHERE actor = 'knowledge_credit'
      AND table_name = 'knowledge_items'
      AND op = 'credit'
  `).all() as Array<{ after: string | null }>;
  return rows.filter((row) => {
    const after = JSON.parse(row.after ?? "{}");
    return after.cycleId === cycleId && after.knowledgeId === knowledgeId;
  }).length;
}

test("correct outcome increments alpha by 1 and leaves beta unchanged", () => {
  const projectId = "proj_credit_correct";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);
  createKnowledge(projectId, "kb_credit_correct", { evidenceAlpha: 2, evidenceBeta: 1 });
  recordInjection(projectId, cycle.id, cycle.idx, ["kb_credit_correct"]);

  evaluatePrediction(projectId, cycle.id, scenario(1, 0.35), plan());

  const updated = storage.getKnowledge("kb_credit_correct");
  assert.equal(updated?.evidenceAlpha, 3);
  assert.equal(updated?.evidenceBeta, 1);
});

test("wrong outcome increments beta by 1 and leaves alpha unchanged", () => {
  const projectId = "proj_credit_wrong";
  createProject(projectId);
  const cycle = createCycle(projectId, 2);
  createKnowledge(projectId, "kb_credit_wrong", { evidenceAlpha: 2, evidenceBeta: 1 });
  recordInjection(projectId, cycle.id, cycle.idx, ["kb_credit_wrong"]);

  evaluatePrediction(projectId, cycle.id, scenario(2, 0.1), plan());

  const updated = storage.getKnowledge("kb_credit_wrong");
  assert.equal(updated?.evidenceAlpha, 2);
  assert.equal(updated?.evidenceBeta, 2);
});

test("uninjected knowledge is unchanged", () => {
  const projectId = "proj_credit_uninjected";
  createProject(projectId);
  const cycle = createCycle(projectId, 3);
  createKnowledge(projectId, "kb_credit_injected", { evidenceAlpha: 2, evidenceBeta: 1 });
  createKnowledge(projectId, "kb_credit_uninjected", { evidenceAlpha: 5, evidenceBeta: 2 });
  recordInjection(projectId, cycle.id, cycle.idx, ["kb_credit_injected"]);

  evaluatePrediction(projectId, cycle.id, scenario(3, 0.35), plan());

  const unchanged = storage.getKnowledge("kb_credit_uninjected");
  assert.equal(unchanged?.evidenceAlpha, 5);
  assert.equal(unchanged?.evidenceBeta, 2);
});

test("same cycle repeated resolve does not double-count", () => {
  const projectId = "proj_credit_idempotent";
  createProject(projectId);
  const cycle = createCycle(projectId, 4);
  createKnowledge(projectId, "kb_credit_once", { evidenceAlpha: 2, evidenceBeta: 1 });
  recordInjection(projectId, cycle.id, cycle.idx, ["kb_credit_once"]);

  evaluatePrediction(projectId, cycle.id, scenario(4, 0.35), plan());
  evaluatePrediction(projectId, cycle.id, scenario(4, 0.35), plan());

  const updated = storage.getKnowledge("kb_credit_once");
  assert.equal(updated?.evidenceAlpha, 3);
  assert.equal(updated?.evidenceBeta, 1);
  assert.equal(countCreditEvents(cycle.id, "kb_credit_once"), 1);
});

test("same cycle repeated resolve remains idempotent after more than 500 unrelated events", () => {
  const projectId = "proj_credit_idempotent_durable";
  createProject(projectId);
  const cycle = createCycle(projectId, 40);
  createKnowledge(projectId, "kb_credit_durable_once", { evidenceAlpha: 2, evidenceBeta: 1 });
  recordInjection(projectId, cycle.id, cycle.idx, ["kb_credit_durable_once"]);

  evaluatePrediction(projectId, cycle.id, scenario(40, 0.35), plan());
  for (let i = 0; i < 501; i += 1) {
    storage.recordEvent({
      cycleIdx: cycle.idx,
      actor: "noise",
      tableName: "durable_idempotency_noise",
      op: "insert",
      before: null,
      after: JSON.stringify({ i }),
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
  evaluatePrediction(projectId, cycle.id, scenario(40, 0.35), plan());

  const updated = storage.getKnowledge("kb_credit_durable_once");
  assert.equal(updated?.evidenceAlpha, 3);
  assert.equal(updated?.evidenceBeta, 1);
  assert.equal(countCreditEvents(cycle.id, "kb_credit_durable_once"), 1);
});

test("each credit assignment emits op=credit audit event with comparable before and after", () => {
  const projectId = "proj_credit_audit";
  createProject(projectId);
  const cycle = createCycle(projectId, 5);
  createKnowledge(projectId, "kb_credit_audit", { evidenceAlpha: 2, evidenceBeta: 1 });
  recordInjection(projectId, cycle.id, cycle.idx, ["kb_credit_audit"]);

  evaluatePrediction(projectId, cycle.id, scenario(5, 0.35), plan());

  const event = storage.listEvents().find((item) => (
    item.actor === "knowledge_credit" &&
    item.tableName === "knowledge_items" &&
    item.op === "credit" &&
    JSON.parse(item.after ?? "{}").knowledgeId === "kb_credit_audit"
  ));
  assert.ok(event, "credit event should be recorded");
  const before = JSON.parse(event.before ?? "{}");
  const after = JSON.parse(event.after ?? "{}");
  assert.equal(before.idempotencyKey, after.idempotencyKey);
  assert.equal(before.cycleId, cycle.id);
  assert.equal(after.outcome, "correct");
  assert.equal(before.knowledge.evidenceAlpha, 2);
  assert.equal(after.knowledge.evidenceAlpha, 3);
  assert.equal(before.knowledge.evidenceBeta, after.knowledge.evidenceBeta);
});

test("computeCreditUpdates is pure: same input, same output, no IO", () => {
  const injectedIds = ["kb_pure_a", "kb_pure_b", "kb_pure_a"];
  const outcome = { cycleId: "cycle_pure", predictionId: "pred_pure", correct: true };

  const first = computeCreditUpdates(injectedIds, outcome);
  const second = computeCreditUpdates(injectedIds, outcome);

  assert.deepEqual(first, second);
  assert.deepEqual(injectedIds, ["kb_pure_a", "kb_pure_b", "kb_pure_a"]);
  assert.deepEqual(first.map((update) => update.knowledgeId), ["kb_pure_a", "kb_pure_b"]);
  assert.deepEqual(first.map((update) => [update.evidenceAlphaDelta, update.evidenceBetaDelta]), [[1, 0], [1, 0]]);
});
