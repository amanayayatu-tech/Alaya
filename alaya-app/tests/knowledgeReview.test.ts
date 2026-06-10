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
const {
  assertResolvedConflictActiveSurvivors,
  detectKnowledgeConflicts,
  createKnowledgeReviewReminders,
  resolveKnowledgeReview,
} = await import("../server/knowledgeReview.ts");
const { buildFlywheelHealth } = await import("../server/flywheelHealth.ts");
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
    createdBy: patch.createdBy ?? "test",
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

function conflictReview(projectId: string, primaryKnowledgeId: string, relatedKnowledgeId: string, suffix = primaryKnowledgeId) {
  return storage.createKnowledgeReview({
    id: `kr_${projectId}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120),
    projectId,
    cycleId: `cycle_${projectId}`,
    reviewType: "conflict",
    status: "review_required",
    primaryKnowledgeId,
    relatedKnowledgeId,
    reason: "test conflict",
    evidence: "{}",
    recommendedAction: "merge weaker knowledge into the survivor",
    createdAt: "2026-06-07T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
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

test("generic contradiction wording in onboarding seed knowledge does not create a conflict review", () => {
  const projectId = "proj_seed_marker_not_conflict";
  project(projectId);
  knowledge(projectId, "kb_seed_identity_marker", {
    sourceRef: "onboarding",
    tags: ["identity", "seed"],
    content: "身份说明：遇到 PPG vs ECG 矛盾证据时，必须进入 conflict 知识状态并等待人工审核。",
  });
  knowledge(projectId, "kb_seed_world_marker", {
    sourceRef: "onboarding",
    tags: ["world_model", "seed"],
    content: "初始世界模型：系统需要识别明确冲突和互相矛盾的证据，但这只是任务说明。",
  });

  const conflicts = detectKnowledgeConflicts(projectId);

  assert.equal(conflicts.length, 0);
  assert.equal(storage.listKnowledgeReviews(projectId).filter((item) => item.reviewType === "conflict").length, 0);
  assert.equal(storage.getKnowledge("kb_seed_identity_marker")?.status, "active");
  assert.equal(storage.getKnowledge("kb_seed_world_marker")?.status, "active");
});

test("non-speculative external draft evidence creates a topic conflict without runner markers", () => {
  const projectId = "proj_external_draft_topic_conflict";
  project(projectId);
  knowledge(projectId, "kb_ppg_current_priority", {
    status: "strong",
    title: "PPG priority decision",
    semanticKey: "health_signal_priority",
    tags: ["health_signal", "ppg", "conclusion:ppg_priority"],
    content: "当前方案应优先 PPG；ppg_priority_score >= 0.7，PPG 对低功耗连续监测更适合。",
    confidenceScore: 0.91,
  });
  knowledge(projectId, "kb_ecg_external_counter", {
    status: "draft",
    title: "External ECG counter evidence",
    semanticKey: "health_signal_priority",
    sourceType: "feedback",
    sourceRef: "health_signal_contradiction_runner:sample_0001_ppg_risk",
    tags: ["meaning_gate", "human_approved", "form_feedback", "health_signal", "ppg"],
    content: "外部实证反馈：ppg_priority_score <= 0.35。该人群应优先 ECG，置信度 0.66。",
    confidenceScore: 0.56,
    createdBy: "human_gate",
  });

  const conflicts = detectKnowledgeConflicts(projectId);

  assert.ok(conflicts.length >= 1);
  assert.ok(conflicts.some((item) => item.primaryKnowledgeId === "kb_ecg_external_counter"));
  assert.equal(storage.getKnowledge("kb_ecg_external_counter")?.status, "conflict");
  const review = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_ecg_external_counter");
  assert.ok(review);
  assert.equal(review.relatedKnowledgeId, "kb_ppg_current_priority");
});

test("topic conclusion polarity detects PPG versus ECG priority conflicts", () => {
  const projectId = "proj_topic_polarity_conflict";
  project(projectId);
  knowledge(projectId, "kb_topic_ppg", {
    status: "active",
    title: "Health signal priority",
    semanticKey: "health_signal_priority",
    tags: ["health_signal"],
    content: "当前健康信号决策应优先 PPG，因为 PPG 连续监测成本更低。",
    confidenceScore: 0.82,
  });
  knowledge(projectId, "kb_topic_ecg", {
    status: "active",
    title: "Health signal priority",
    semanticKey: "health_signal_priority",
    tags: ["health_signal"],
    content: "当前健康信号决策应优先 ECG，PPG 不应作为优先方案。",
    confidenceScore: 0.61,
  });

  const conflicts = detectKnowledgeConflicts(projectId);

  assert.equal(conflicts.length, 1);
  assert.equal(storage.getKnowledge("kb_topic_ecg")?.status, "conflict");
  assert.match(conflicts[0].reason, /topic-level/i);
});

test("speculative draft knowledge remains isolated from conflict detection and injection", () => {
  const projectId = "proj_speculative_draft_isolated";
  project(projectId);
  knowledge(projectId, "kb_ppg_active_isolation", {
    status: "active",
    title: "Health signal priority",
    semanticKey: "health_signal_priority",
    tags: ["health_signal", "ppg"],
    content: "当前健康信号决策应优先 PPG；ppg_priority_score >= 0.7。",
    confidenceScore: 0.82,
  });
  knowledge(projectId, "kb_speculative_ecg_draft", {
    status: "draft",
    title: "Speculative ECG draft",
    semanticKey: "health_signal_priority",
    sourceType: "feedback",
    sourceRef: "cycle_spec_2_proj_cycle_1",
    tags: ["health_signal", "ecg", "speculative"],
    content: "推测草稿：ppg_priority_score <= 0.35，因此优先 ECG。",
    confidenceScore: 0.55,
    createdBy: "distiller",
  });

  const conflicts = detectKnowledgeConflicts(projectId);
  const context = buildKnowledgeContext("health_signal ppg ecg priority", projectId);

  assert.equal(conflicts.length, 0);
  assert.equal(storage.getKnowledge("kb_speculative_ecg_draft")?.status, "draft");
  assert.doesNotMatch(context, /kb_speculative_ecg_draft/);
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

test("resolved reviews cannot be resolved again or rewrite prior resolution", () => {
  const projectId = "proj_review_resolution_once";
  project(projectId);
  knowledge(projectId, "kb_once_strong", { status: "strong", content: "activation_rate >= 0.4", confidenceScore: 0.9 });
  knowledge(projectId, "kb_once_candidate", { status: "active", content: "activation_rate <= 0.2", confidenceScore: 0.7 });
  detectKnowledgeConflicts(projectId);
  const review = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_once_candidate");
  assert.ok(review);

  resolveKnowledgeReview(review.id, {
    action: "merge_supersede",
    actor: "human",
    survivorKnowledgeId: "kb_once_strong",
    rationale: "keep stronger prior evidence",
  });
  const firstResolution = storage.getKnowledgeReview(review.id)?.resolution;
  const firstLedgerCount = storage.listActionLedger(projectId).filter((row) => row.actionType.startsWith("knowledge_review.")).length;

  assert.throws(
    () => resolveKnowledgeReview(review.id, { action: "quarantine", actor: "human", rationale: "late duplicate click" }),
    /knowledge review already resolved/,
  );

  const resolved = storage.getKnowledgeReview(review.id);
  assert.equal(resolved?.resolution, firstResolution);
  assert.equal(storage.getKnowledge("kb_once_candidate")?.status, "deprecated");
  assert.equal(storage.getKnowledge("kb_once_candidate")?.supersededBy, "kb_once_strong");
  assert.equal(storage.listActionLedger(projectId).filter((row) => row.actionType.startsWith("knowledge_review.")).length, firstLedgerCount);
});

test("merge_supersede keeps active and strong survivors in the reusable pool", () => {
  for (const [projectId, survivorStatus] of [["proj_merge_survivor_active", "active"], ["proj_merge_survivor_strong", "strong"]] as const) {
    project(projectId);
    knowledge(projectId, `kb_${projectId}_survivor`, {
      status: survivorStatus,
      content: "activation_rate >= 0.8",
      confidenceScore: survivorStatus === "strong" ? 0.92 : 0.82,
    });
    knowledge(projectId, `kb_${projectId}_primary`, {
      status: "active",
      content: "activation_rate <= 0.2",
      confidenceScore: 0.62,
    });
    const review = conflictReview(projectId, `kb_${projectId}_primary`, `kb_${projectId}_survivor`);

    resolveKnowledgeReview(review.id, {
      action: "merge_supersede",
      actor: "human",
      survivorKnowledgeId: `kb_${projectId}_survivor`,
      rationale: "preserve the stronger survivor",
    });

    assert.equal(storage.getKnowledge(`kb_${projectId}_primary`)?.status, "deprecated");
    assert.equal(storage.getKnowledge(`kb_${projectId}_primary`)?.supersededBy, `kb_${projectId}_survivor`);
    assert.equal(storage.getKnowledge(`kb_${projectId}_survivor`)?.status, survivorStatus);
    assert.equal(storage.getKnowledge(`kb_${projectId}_survivor`)?.supersededBy, null);
    assert.doesNotThrow(() => assertResolvedConflictActiveSurvivors(projectId));
  }
});

test("merge_supersede reactivates stale or deprecated survivors", () => {
  for (const [projectId, staleStatus] of [["proj_merge_stale_survivor", "stale"], ["proj_merge_deprecated_survivor", "deprecated"]] as const) {
    project(projectId);
    knowledge(projectId, `kb_${projectId}_older`, {
      status: "active",
      content: "activation_rate >= 0.7",
      confidenceScore: 0.88,
    });
    knowledge(projectId, `kb_${projectId}_survivor`, {
      status: staleStatus,
      content: "activation_rate >= 0.8",
      confidenceScore: 0.82,
      supersededBy: staleStatus === "deprecated" ? `kb_${projectId}_older` : null,
    });
    knowledge(projectId, `kb_${projectId}_primary`, {
      status: "active",
      content: "activation_rate <= 0.2",
      confidenceScore: 0.62,
    });
    const review = conflictReview(projectId, `kb_${projectId}_primary`, `kb_${projectId}_survivor`);

    resolveKnowledgeReview(review.id, {
      action: "merge_supersede",
      actor: "human",
      survivorKnowledgeId: `kb_${projectId}_survivor`,
      rationale: "reactivate survivor after absorbing contradiction",
    });

    assert.equal(storage.getKnowledge(`kb_${projectId}_primary`)?.status, "deprecated");
    assert.equal(storage.getKnowledge(`kb_${projectId}_survivor`)?.status, "active");
    assert.equal(storage.getKnowledge(`kb_${projectId}_survivor`)?.supersededBy, null);
    assert.doesNotThrow(() => assertResolvedConflictActiveSurvivors(projectId));
  }
});

test("repeated merge_supersede resolutions leave at least one active survivor in health totals", () => {
  const projectId = "proj_merge_repeated_active";
  project(projectId);
  knowledge(projectId, "kb_repeated_survivor", {
    status: "active",
    title: "Activation threshold",
    content: "activation_rate >= 0.8",
    confidenceScore: 0.9,
  });

  for (let i = 1; i <= 5; i += 1) {
    const primaryId = `kb_repeated_primary_${i}`;
    knowledge(projectId, primaryId, {
      status: "active",
      title: "Activation threshold",
      content: `activation_rate <= 0.${i}`,
      confidenceScore: 0.5 + i / 100,
    });
    const conflicts = detectKnowledgeConflicts(projectId);
    assert.ok(conflicts.some((conflict) => conflict.primaryKnowledgeId === primaryId));
    const review = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === primaryId);
    assert.ok(review);

    resolveKnowledgeReview(review.id, {
      action: "merge_supersede",
      actor: "human",
      survivorKnowledgeId: "kb_repeated_survivor",
      rationale: "keep one reusable survivor for the semantic cluster",
    });
  }

  assert.equal(storage.getKnowledge("kb_repeated_survivor")?.status, "active");
  assert.equal(storage.getKnowledge("kb_repeated_survivor")?.supersededBy, null);
  assert.ok(buildFlywheelHealth(projectId).totals.activeKnowledgeCount >= 1);
  assert.doesNotThrow(() => assertResolvedConflictActiveSurvivors(projectId));
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

test("R1 resolved duplicate conflict review id re-detection creates suffixed review", () => {
  const projectId = "proj_review_redetect_resolved";
  project(projectId);
  knowledge(projectId, "kb_redetect_strong", { status: "strong", content: "activation_rate >= 0.8", confidenceScore: 0.9 });
  knowledge(projectId, "kb_redetect_candidate", { status: "active", content: "activation_rate <= 0.2", confidenceScore: 0.7 });
  detectKnowledgeConflicts(projectId);
  const first = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_redetect_candidate");
  assert.ok(first);

  resolveKnowledgeReview(first.id, {
    action: "approve_as_current",
    actor: "human",
    rationale: "candidate remains current enough to re-check if evidence conflicts again",
  });

  assert.doesNotThrow(() => detectKnowledgeConflicts(projectId));
  const reviews = storage.listKnowledgeReviews(projectId)
    .filter((item) => item.primaryKnowledgeId === "kb_redetect_candidate" && item.relatedKnowledgeId === "kb_redetect_strong");
  assert.equal(reviews.length, 2);
  const second = reviews.find((item) => item.status === "review_required");
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(second.id, `${first.id}__r2`);
  assert.equal(storage.getGate(`gate_${second.id}`)?.status, "pending");
});

test("R3 open duplicate conflict review id re-detection reuses existing review", () => {
  const projectId = "proj_review_redetect_open";
  project(projectId);
  knowledge(projectId, "kb_open_strong", { status: "strong", content: "activation_rate >= 0.8", confidenceScore: 0.9 });
  knowledge(projectId, "kb_open_candidate", { status: "active", content: "activation_rate <= 0.2", confidenceScore: 0.7 });
  detectKnowledgeConflicts(projectId);
  const first = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_open_candidate");
  assert.ok(first);

  storage.updateKnowledge("kb_open_candidate", { status: "active", actor: "test" });
  assert.doesNotThrow(() => detectKnowledgeConflicts(projectId));

  const reviews = storage.listKnowledgeReviews(projectId)
    .filter((item) => item.primaryKnowledgeId === "kb_open_candidate" && item.relatedKnowledgeId === "kb_open_strong");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, first.id);
  assert.equal(reviews[0].status, "review_required");
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

test("R2 approving opposing evidence meaning gate succeeds after resolved duplicate review id exists", async () => {
  const projectId = "proj_meaning_gate_duplicate_review";
  project(projectId);
  knowledge(projectId, "kb_gate_dup_strong", {
    status: "strong",
    title: "Activation threshold",
    content: "activation_rate >= 0.8",
    confidenceScore: 0.9,
  });
  knowledge(projectId, "kb_gate_dup_candidate", {
    status: "active",
    title: "Activation threshold",
    content: "activation_rate <= 0.2",
    confidenceScore: 0.7,
  });
  detectKnowledgeConflicts(projectId);
  const prior = storage.listKnowledgeReviews(projectId).find((item) => item.primaryKnowledgeId === "kb_gate_dup_candidate");
  assert.ok(prior);
  resolveKnowledgeReview(prior.id, {
    action: "approve_as_current",
    actor: "human",
    rationale: "leave candidate active so a later approved meaning gate can re-run detection",
  });

  const imported = await ingestFormFeedback(projectId, {
    sourceName: "form",
    externalId: "duplicate-review-meaning-approval",
    title: "new opposing evidence",
    text: "operators report explicit conflict with the existing activation threshold",
  });
  assert.equal(imported.gate?.status, "pending");

  assert.doesNotThrow(() => {
    new HumanGateService(storage).approve(imported.gate?.id ?? "", { actor: "human", via: "test" });
  });

  const created = storage.listKnowledge(projectId).find((item) => item.sourceRef === "duplicate-review-meaning-approval");
  assert.ok(created);
  assert.ok(["active", "conflict"].includes(created.status), `unexpected created knowledge status ${created.status}`);
  const reviews = storage.listKnowledgeReviews(projectId)
    .filter((item) => item.primaryKnowledgeId === "kb_gate_dup_candidate" && item.relatedKnowledgeId === "kb_gate_dup_strong");
  assert.equal(reviews.length, 2);
  assert.ok(reviews.some((item) => item.id === `${prior.id}__r2` && item.status === "review_required"));
});
