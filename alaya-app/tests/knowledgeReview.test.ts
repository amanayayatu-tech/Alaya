import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-knowledge-review-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { buildKnowledgeContext } = await import("../server/knowledgeInjection.ts");
const { detectKnowledgeConflicts, createKnowledgeReviewReminders, resolveKnowledgeReview } = await import("../server/knowledgeReview.ts");
const { ingestFormFeedback } = await import("../server/externalFeedback.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { parseTraceEvent } = await import("../server/trace.ts");

function project(projectId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "knowledge governance",
    targetUser: "operators",
    redlines: "[]",
    weeklyHumanMinutes: 150,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "",
    worldModel: "",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: `cycle_${projectId}`,
    projectId,
    idx: 1,
    goal: "govern knowledge",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function knowledge(projectId: string, id: string, patch: Record<string, any>) {
  storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: patch.title ?? "Activation threshold",
    content: patch.content ?? "activation_rate >= 0.4",
    sourceType: patch.sourceType ?? "metric",
    sourceRef: patch.sourceRef ?? "test",
    evidenceAlpha: patch.evidenceAlpha ?? 5,
    evidenceBeta: patch.evidenceBeta ?? 1,
    confidenceScore: patch.confidenceScore ?? 0.83,
    confidenceLevel: patch.confidenceLevel ?? "high",
    status: patch.status ?? "active",
    humanApprovedCount: patch.humanApprovedCount ?? 0,
    externalVerifiedCount: patch.externalVerifiedCount ?? 1,
    validFrom: patch.validFrom ?? "2026-01-01",
    validUntil: patch.validUntil ?? null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: null,
    lastVerifiedAt: patch.lastVerifiedAt ?? Date.parse("2026-01-01T00:00:00Z"),
    lastDecayedAt: null,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: 1,
    tags: JSON.stringify(patch.tags ?? ["activation"]),
    notes: patch.notes ?? "",
    supersededBy: patch.supersededBy ?? null,
    semanticKey: patch.semanticKey ?? "",
    version: 1,
  });
}

test("detects metric operator conflicts and creates review/gate/audit evidence", () => {
  const projectId = "proj_metric_conflict";
  project(projectId);
  knowledge(projectId, "kb_metric_strong", { status: "strong", content: "activation_rate >= 0.4", confidenceScore: 0.9 });
  knowledge(projectId, "kb_metric_candidate", { status: "active", content: "activation_rate <= 0.2", confidenceScore: 0.7 });

  const conflicts = detectKnowledgeConflicts(projectId);

  assert.equal(conflicts.length, 1);
  assert.equal(storage.getKnowledge("kb_metric_candidate")?.status, "conflict");
  const review = storage.listKnowledgeReviews(projectId).find((item) => item.reviewType === "conflict");
  assert.ok(review);
  assert.equal(review.primaryKnowledgeId, "kb_metric_candidate");
  assert.equal(storage.getGate(`gate_${review.id}`)?.type, "risk");
  assert.ok(storage.listEvents().some((event) => event.tableName === "knowledge_items" && event.op === "update"));
  assert.ok(storage.listTraceEventsByProject(projectId).map(parseTraceEvent).some((trace) => trace.name === "knowledge_review_required"));
});

test("detects incompatible conclusion tags on the same normalized key", () => {
  const projectId = "proj_tag_conflict";
  project(projectId);
  knowledge(projectId, "kb_tag_positive", { semanticKey: "checkout_flow", tags: ["conclusion:positive"], content: "checkout works well" });
  knowledge(projectId, "kb_tag_negative", { semanticKey: "checkout_flow", tags: ["conclusion:negative"], content: "checkout fails often", confidenceScore: 0.6 });

  const conflicts = detectKnowledgeConflicts(projectId);

  assert.equal(conflicts.length, 1);
  assert.equal(storage.getKnowledge("kb_tag_negative")?.status, "conflict");
});

test("creates stale and expiry review reminders without changing active facts", () => {
  const projectId = "proj_review_reminders";
  project(projectId);
  knowledge(projectId, "kb_old", { status: "active", lastVerifiedAt: Date.parse("2025-01-01T00:00:00Z") });
  knowledge(projectId, "kb_expiring", { status: "strong", validUntil: "2026-06-10", lastVerifiedAt: Date.parse("2026-06-01T00:00:00Z") });

  const reminders = createKnowledgeReviewReminders(projectId, {
    nowMs: Date.parse("2026-06-07T00:00:00Z"),
    staleAfterDays: 30,
    expiryWithinDays: 7,
  });

  assert.equal(reminders.length, 2);
  assert.equal(storage.getKnowledge("kb_old")?.status, "active");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "meaning").length, 2);
});

test("review resolution quarantines candidate and writes action ledger/trace", () => {
  const projectId = "proj_review_resolution";
  project(projectId);
  knowledge(projectId, "kb_resolve_strong", { status: "strong", content: "activation_rate >= 0.4", confidenceScore: 0.9 });
  knowledge(projectId, "kb_resolve_candidate", { status: "active", content: "activation_rate <= 0.2", confidenceScore: 0.7 });
  detectKnowledgeConflicts(projectId);
  const review = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_resolve_candidate");
  assert.ok(review);

  const resolved = resolveKnowledgeReview(review.id, { action: "quarantine", actor: "human", rationale: "weaker evidence" });

  assert.equal(resolved.status, "resolved");
  assert.equal(storage.getKnowledge("kb_resolve_candidate")?.status, "quarantined");
  assert.ok(storage.listActionLedger(projectId).some((row) => row.actionType === "knowledge_review.quarantine"));
  assert.ok(storage.listTraceEventsByProject(projectId).map(parseTraceEvent).some((trace) => trace.name === "knowledge_review_resolved"));
});

test("approve_as_current preserves strong status on review reminders", () => {
  const projectId = "proj_review_strong_current";
  project(projectId);
  knowledge(projectId, "kb_strong_review", {
    status: "strong",
    validUntil: "2026-06-10",
    lastVerifiedAt: Date.parse("2026-06-01T00:00:00Z"),
    confidenceScore: 0.92,
  });
  createKnowledgeReviewReminders(projectId, {
    nowMs: Date.parse("2026-06-07T00:00:00Z"),
    expiryWithinDays: 7,
  });
  const review = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_strong_review");
  assert.ok(review);

  resolveKnowledgeReview(review.id, { action: "approve_as_current", actor: "human", rationale: "still current" });

  assert.equal(storage.getKnowledge("kb_strong_review")?.status, "strong");
  assert.equal(storage.getGate(`gate_${review.id}`)?.status, "approved");
});

test("stale, quarantined, conflict and superseded knowledge are not injected into prior knowledge", () => {
  const projectId = "proj_injection_regression";
  project(projectId);
  for (const status of ["active", "strong", "stale", "quarantined", "conflict"]) {
    knowledge(projectId, `kb_reg_${status}`, { status, content: "rollback audit preview evidence" });
  }
  knowledge(projectId, "kb_reg_superseded", { status: "active", supersededBy: "kb_reg_active", content: "rollback audit preview evidence" });

  const context = buildKnowledgeContext("rollback audit preview", projectId);

  assert.match(context, /kb_reg_active/);
  assert.match(context, /kb_reg_strong/);
  for (const id of ["stale", "quarantined", "conflict", "superseded"]) {
    assert.doesNotMatch(context, new RegExp(`kb_reg_${id}`));
  }
});

test("conflicting form feedback enters meaning gate and cannot affect next cycle before review", async () => {
  const projectId = "proj_form_conflict";
  project(projectId);
  knowledge(projectId, "kb_strong_current", {
    status: "strong",
    title: "Current checkout principle",
    content: "checkout_success_rate >= 0.8",
    confidenceScore: 0.9,
  });

  const imported = await ingestFormFeedback(projectId, {
    sourceName: "form",
    externalId: "conflict-1",
    title: "checkout contradiction",
    text: "contradicts_strong: kb_strong_current and checkout_success_rate <= 0.2",
  });
  assert.equal(imported.gate?.status, "pending");
  new HumanGateService(storage).approve(imported.gate?.id ?? "", { actor: "human", via: "test" });

  const created = storage.listKnowledge(projectId).find((item) => item.sourceRef === "conflict-1");
  assert.equal(created?.status, "conflict");
  assert.ok(storage.listKnowledgeReviews(projectId).some((review) => review.status === "review_required"));
  const context = buildKnowledgeContext("checkout_success_rate", projectId);
  assert.doesNotMatch(context, new RegExp(created?.id ?? "missing"));
});
