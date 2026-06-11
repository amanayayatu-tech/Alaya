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

function createKnowledge(projectId: string, id: string, lastVerifiedAt: number) {
  storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: "Old but plausible operating principle",
    content: "This principle was useful but has not been verified for a long time.",
    sourceType: "metric",
    sourceRef: "decay-test",
    evidenceAlpha: 5,
    evidenceBeta: 1,
    confidenceScore: 0.8,
    confidenceLevel: "high",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: new Date(lastVerifiedAt).toISOString().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    lastVerifiedAt,
    storageStrength: 1,
    tags: JSON.stringify(["decay"]),
    notes: "",
    version: 1,
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
