import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-confidence-paths-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { runDistiller } = await import("../server/flywheel.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Confidence ${projectId}`,
    direction: "Validate confidence update paths",
    targetUser: "operators",
    redlines: "[]",
    weeklyHumanMinutes: 120,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "confidence path seed",
    worldModel: "gray evidence must not be dropped",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  return storage.createCycle({
    id: `cycle_${idx}_${projectId.slice(-6)}`,
    projectId,
    idx,
    goal: `cycle ${idx}`,
    status: "running",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function scenario(index: number) {
  return {
    index,
    proposedGoal: `gray path cycle ${index}`,
    alternativeGoals: [],
    belief: "belief",
    prediction: "activation_rate >= 0.3",
    action: "action",
    activationObserved: 0.24,
    activationTarget: 0.3,
    feedback: [{ id: `f_gray_${index}`, text: "preview feedback", category: "unclear_signal", sentiment: "positive" }],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  };
}

function createUserFearKnowledge(projectId: string) {
  storage.createKnowledge({
    id: `kb_user_fear_${projectId}`,
    projectId,
    type: "world_model",
    title: "用户对不可预期的自动操作有恐惧",
    content: "用户需要预览才能信任自动操作。",
    sourceType: "feedback",
    sourceRef: "f1",
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["user_fear"]),
    notes: "",
    version: 1,
  });
}

test("Distiller new-knowledge path preserves gray-zone weak alpha increment", async () => {
  const projectId = "proj_gray_distill_new";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);

  const created = await runDistiller(projectId, cycle.id, scenario(1), 0.4, []);
  assert.equal(created.length, 1);
  const item = storage.getKnowledge(created[0]);
  assert.equal(item?.evidenceAlpha, 1.5);
  assert.equal(item?.evidenceBeta, 1);
});

test("external verification path preserves gray-zone weak alpha before external alpha", async () => {
  const projectId = "proj_gray_external";
  createProject(projectId);
  const cycle = createCycle(projectId, 2);
  createUserFearKnowledge(projectId);

  await runDistiller(projectId, cycle.id, scenario(2), 0.4, []);
  const item = storage.getKnowledge(`kb_user_fear_${projectId}`);
  assert.equal(item?.evidenceAlpha, 3.5);
  assert.equal(item?.externalVerifiedCount, 1);
});

test("Human Gate approval path preserves gray-zone weak alpha before approval alpha", () => {
  const projectId = "proj_gray_human_gate";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);
  storage.createGate({
    id: "gate_meaning_gray",
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "Gray meaning gate",
    payload: JSON.stringify({
      source: "form_feedback",
      externalId: "form:gray",
      summary: "Preview feedback is partly supportive",
      userQuote: "Preview helps but confidence is still mixed.",
      category: "unclear_signal",
      topicKey: "preview",
      normalizedError: 0.4,
    }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  new HumanGateService(storage).approve("gate_meaning_gray", { actor: "human", via: "test" });
  const created = storage.listKnowledge(projectId).find((item) => item.sourceRef === "form:gray");
  assert.ok(created);
  assert.equal(created.evidenceAlpha, 4.5);
  assert.equal(created.humanApprovedCount, 1);
  assert.equal(created.status, "active");
});
