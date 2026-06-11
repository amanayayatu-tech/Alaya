import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-decay-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { applyTimeDecay } = await import("alaya-core/src/core/update_confidence.ts");
const { storage } = await import("../server/storage.ts");
const { decayStaleKnowledge, schedulerTickProject } = await import("../server/scheduler.ts");
const { applyCycleUtilityFeedback } = await import("../server/flywheel.ts");

const DAY = 86_400_000;
const currentTime = Date.parse("2026-06-04T00:00:00.000Z");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Decay ${projectId}`,
    direction: "Validate time decay",
    targetUser: "operator teams",
    redlines: JSON.stringify(["do not trust stale knowledge"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Decay should demote stale memory.",
    worldModel: "Knowledge needs time-aware verification.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, lastVerifiedAt: number, overrides: Record<string, any> = {}) {
  storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: "Old but plausible operating principle",
    content: "This principle was useful but has not been verified for a long time.",
    sourceType: "metric",
    sourceRef: "decay-test",
    evidenceAlpha: overrides.evidenceAlpha ?? 5,
    evidenceBeta: overrides.evidenceBeta ?? 1,
    confidenceScore: overrides.confidenceScore ?? 0.8,
    confidenceLevel: overrides.confidenceLevel ?? "high",
    status: overrides.status ?? "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: new Date(lastVerifiedAt).toISOString().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: overrides.lastInjectedAt ?? null,
    lastVerifiedAt,
    grayStreak: overrides.grayStreak ?? 0,
    storageStrength: 1,
    tags: JSON.stringify(["decay"]),
    notes: "",
    semanticKey: overrides.semanticKey ?? "",
    version: 1,
    ...overrides,
  });
}

function createCycle(projectId: string, id: string, coAppliedSet: string | null = null) {
  return storage.createCycle({
    id,
    projectId,
    idx: 1,
    goal: "observe gray utility",
    status: "running",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    coAppliedSet,
    version: 1,
  });
}

function createPrediction(cycleId: string, knowledgeRefs: string[], error: number) {
  storage.createPrediction({
    id: `pred_${cycleId}`,
    cycleId,
    belief: "belief",
    prediction: "activation_rate >= 0.3",
    action: "action",
    claims: "[]",
    observation: "activation_rate observed",
    predictionError: error,
    worstClaimError: error,
    errorType: "model",
    updateTarget: "utility_feedback",
    status: "resolved",
    knowledgeRefs: JSON.stringify(knowledgeRefs),
  });
}

test("applyTimeDecay lowers score for knowledge last verified 30 days ago", () => {
  const result = applyTimeDecay({ score: 0.8, lastVerifiedAt: currentTime - (30 * DAY), storageStrength: 1 }, currentTime);
  assert.ok(result.newScore < 0.8);
  assert.ok(result.newStorageStrength < 1);
});

test("applyTimeDecay leaves score unchanged when verification is current", () => {
  const result = applyTimeDecay({ score: 0.8, lastVerifiedAt: currentTime, storageStrength: 1 }, currentTime);
  assert.equal(result.newScore, 0.8);
  assert.equal(result.newStorageStrength, 1);
  assert.equal(result.shouldDemoteToStale, false);
});

test("applyTimeDecay flags stale demotion when decayed score falls below 0.5", () => {
  const result = applyTimeDecay({ score: 0.8, lastVerifiedAt: currentTime - (90 * DAY), storageStrength: 1 }, currentTime);
  assert.ok(result.newScore < 0.5);
  assert.equal(result.shouldDemoteToStale, true);
});

test("applyTimeDecay is deterministic for identical inputs", () => {
  const input = { score: 0.72, lastVerifiedAt: currentTime - (45 * DAY), storageStrength: 0.9 };
  assert.deepEqual(applyTimeDecay(input, currentTime), applyTimeDecay(input, currentTime));
});

test("decayStaleKnowledge demotes old active knowledge and writes an audit event", () => {
  const projectId = "proj_decay_integration";
  const lastVerifiedAt = currentTime - (90 * DAY);
  createProject(projectId);
  createKnowledge(projectId, "kb_decay_old_active", lastVerifiedAt);

  const result = decayStaleKnowledge(projectId, currentTime);

  assert.equal(result.demoted, 1);
  const updated = storage.getKnowledge("kb_decay_old_active");
  assert.equal(updated?.status, "stale");
  assert.ok((updated?.confidenceScore ?? 1) < 0.5);
  assert.ok((updated?.storageStrength ?? 1) < 1);
  const audit = storage.listEvents().find((event) => event.actor === "time_decay_scheduler" && event.tableName === "knowledge_items");
  assert.ok(audit, "time decay update should be written through audited storage");
});

test("decayStaleKnowledge records lastDecayedAt and is not applied twice for the same instant", () => {
  const projectId = "proj_decay_idempotent";
  const lastVerifiedAt = currentTime - (90 * DAY);
  createProject(projectId);
  createKnowledge(projectId, "kb_decay_idempotent", lastVerifiedAt);

  decayStaleKnowledge(projectId, currentTime);
  const once = storage.getKnowledge("kb_decay_idempotent");
  assert.equal(once?.lastVerifiedAt, lastVerifiedAt);
  assert.equal(once?.lastDecayedAt, currentTime);

  decayStaleKnowledge(projectId, currentTime);
  const twice = storage.getKnowledge("kb_decay_idempotent");
  assert.equal(twice?.confidenceScore, once?.confidenceScore);
  assert.equal(twice?.storageStrength, once?.storageStrength);
});

test("decayStaleKnowledge demotes active gray knowledge through wallclock gray decay", () => {
  const projectId = "proj_gray_wallclock_decay";
  createProject(projectId);
  createCycle(projectId, "cycle_gray_wallclock_decay");
  createKnowledge(projectId, "kb_gray_wallclock_decay", currentTime, {
    evidenceAlpha: 13,
    evidenceBeta: 7,
    confidenceScore: 0.65,
    confidenceLevel: "medium",
    lastInjectedAt: currentTime - (8 * DAY),
    semanticKey: "gray_wallclock_decay",
  });

  const result = decayStaleKnowledge(projectId, currentTime);

  assert.equal(result.demoted, 1);
  const updated = storage.getKnowledge("kb_gray_wallclock_decay");
  assert.equal(updated?.status, "stale");
  assert.ok((updated?.confidenceScore ?? 1) < 0.5);
  assert.equal(updated?.lastDecayedAt, currentTime);
  assert.ok(storage.listEvents().some((event) => event.actor === "librarian/gray_decay" && event.tableName === "knowledge_items"));
});

test("cycle utility feedback confirms cited gray knowledge and persists grayStreak", () => {
  const projectId = "proj_gray_utility_confirm";
  createProject(projectId);
  const cycle = createCycle(projectId, "cycle_gray_utility_confirm");
  createKnowledge(projectId, "kb_gray_utility_confirm", currentTime, {
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    grayStreak: 1,
  });
  createPrediction(cycle.id, ["kb_gray_utility_confirm"], 0.2);

  const result = applyCycleUtilityFeedback(projectId, cycle.id, currentTime);

  assert.equal(result.applied, 1);
  assert.equal(result.eventKind, "cycle_utility_confirm");
  const updated = storage.getKnowledge("kb_gray_utility_confirm");
  assert.equal(updated?.evidenceAlpha, 1.5);
  assert.equal(updated?.confidenceScore, 0.6);
  assert.equal(updated?.grayStreak, 2);
  assert.equal(updated?.lastVerifiedAt, currentTime);
});

test("cycle utility refute is skipped when co_applied_set makes attribution ambiguous", () => {
  const projectId = "proj_gray_utility_coapplied";
  createProject(projectId);
  const cycle = createCycle(projectId, "cycle_gray_utility_coapplied", JSON.stringify(["cycle_other"]));
  createKnowledge(projectId, "kb_gray_utility_coapplied", currentTime, {
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    grayStreak: 1,
  });
  createPrediction(cycle.id, ["kb_gray_utility_coapplied"], 0.8);

  const result = applyCycleUtilityFeedback(projectId, cycle.id, currentTime);

  assert.equal(result.applied, 0);
  assert.equal(result.skipped, "co_applied_set_nonempty");
  const updated = storage.getKnowledge("kb_gray_utility_coapplied");
  assert.equal(updated?.evidenceBeta, 1);
  assert.equal(updated?.grayStreak, 1);
});

test("scheduler tick applies stale knowledge decay before returning", async () => {
  const projectId = "proj_decay_scheduler_tick";
  createProject(projectId);
  createKnowledge(projectId, "kb_decay_scheduler_tick", Date.now() - (120 * DAY));

  const result = await schedulerTickProject(projectId);

  assert.equal(result.action, "no_cycle");
  const updated = storage.getKnowledge("kb_decay_scheduler_tick");
  assert.equal(updated?.status, "stale");
  assert.equal(typeof updated?.lastDecayedAt, "number");
});
