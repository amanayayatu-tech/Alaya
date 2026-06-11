import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-knowledge-lifecycle-e2e-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_REVIEW_TIMEZONE = "Asia/Shanghai";
process.env.ALAYA_REVIEW_WINDOWS = "15:30-16:00";
process.env.ALAYA_SENSOR_STRUCTURAL_THRESHOLD = "20";

const { storage } = await import("../server/storage.ts");
const { assertDecisionBriefPayload } = await import("../server/decisionBrief.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { createKnowledgeReviewReminders } = await import("../server/knowledgeReview.ts");
const { applyCycleUtilityFeedback } = await import("../server/flywheel.ts");
const { decayStaleKnowledge, emitSchedulerNotifications, gateBudgetForProject, processReviewWindowTick } = await import("../server/scheduler.ts");
const { NotificationBus } = await import("../server/notifications/bus.ts");
const { recordSensorFirewallError, resolvePendingAttribution } = await import("../server/sensorFirewall.ts");
const { onCoreParameterChanged, proposeDistillerKnowledge } = await import("../server/distillerProposal.ts");

class FakePlatform {
  sentCards: Array<{ chatId: string; card: any }> = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  name() { return "fake"; }
  async sendText(chatId: string, text: string) { this.sentTexts.push({ chatId, text }); }
  async sendCard(chatId: string, card: any) {
    this.sentCards.push({ chatId, card });
    return { chatId, messageId: this.sentCards.length };
  }
  async editCard() {}
  async answerCallback() {}
  onCallbackQuery() {}
  async start() {}
  async stop() {}
}

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "knowledge lifecycle e2e",
    targetUser: "operators",
    redlines: "[]",
    weeklyHumanMinutes: 120,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "",
    worldModel: "",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  return storage.createCycle({
    id: `cycle_lifecycle_${idx}`,
    projectId,
    idx,
    goal: `lifecycle ${idx}`,
    status: "closed",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, patch: Record<string, any>) {
  storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: patch.title ?? id,
    content: patch.content ?? "knowledge lifecycle evidence",
    sourceType: "metric",
    sourceRef: "e2e",
    evidenceAlpha: patch.evidenceAlpha,
    evidenceBeta: patch.evidenceBeta,
    confidenceScore: patch.confidenceScore,
    confidenceLevel: "medium",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-01",
    validUntil: null,
    lastValidatedCycle: patch.lastValidatedCycle ?? 1,
    createdByCycle: patch.createdByCycle ?? 1,
    createdBy: "e2e",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: patch.lastInjectedAt ?? null,
    lastVerifiedAt: patch.lastVerifiedAt ?? null,
    lastDecayedAt: null,
    grayStreak: patch.grayStreak ?? 1,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: patch.createdByCycle ?? 1,
    tags: JSON.stringify(patch.tags ?? ["lifecycle"]),
    notes: "",
    supersededBy: null,
    semanticKey: patch.semanticKey ?? "",
    version: 1,
  });
}

function createGoldCase(projectId: string, id: string, claimError: number) {
  return storage.createGoldCase({
    id,
    projectId,
    fingerprint: `${projectId}:${id}`,
    input: JSON.stringify({
      claimError,
      context: {
        perceptionFailure: false,
        executionFailure: false,
        humanFlaggedValueMismatch: false,
        isQualitative: false,
      },
    }),
    expectedErrorType: "model",
    expectedRoute: "distiller_world_model_update",
    active: 1,
    retiredReason: null,
    lastConfirmedAt: "2026-06-11T00:00:00.000Z",
    sourceProposalId: null,
    createdAt: "2026-06-11T00:00:00.000Z",
  });
}

test("e2e knowledge lifecycle covers gray utility, sensor structural gate, proposal apply and gold retirement", async () => {
  const projectId = "proj_knowledge_lifecycle_e2e";
  const baseMs = Date.parse("2026-06-01T00:00:00.000Z");
  createProject(projectId);
  const cycle1 = createCycle(projectId, 1);
  createCycle(projectId, 2);

  createKnowledge(projectId, "kb_lifecycle_cited_gray", {
    evidenceAlpha: 6.9,
    evidenceBeta: 3.1,
    confidenceScore: 0.69,
    lastInjectedAt: baseMs,
    lastVerifiedAt: baseMs,
  });
  storage.createPrediction({
    id: "pred_lifecycle_confirm",
    cycleId: cycle1.id,
    belief: "gray knowledge should help",
    prediction: "activation_rate improves",
    action: "reuse gray knowledge",
    claims: "[]",
    observation: "activation_rate improved",
    predictionError: 0.2,
    worstClaimError: 0.2,
    errorType: "model",
    updateTarget: "utility_feedback",
    status: "resolved",
    knowledgeRefs: JSON.stringify(["kb_lifecycle_cited_gray"]),
  });
  const utility = applyCycleUtilityFeedback(projectId, cycle1.id, baseMs + 60 * 60 * 1000);
  assert.equal(utility.eventKind, "cycle_utility_confirm");
  assert.equal(utility.applied, 1);
  assert.ok((storage.getKnowledge("kb_lifecycle_cited_gray")?.confidenceScore ?? 0) >= 0.7);

  createKnowledge(projectId, "kb_lifecycle_unattended_gray", {
    evidenceAlpha: 3,
    evidenceBeta: 2,
    confidenceScore: 0.6,
    lastInjectedAt: baseMs - 15 * 86_400_000,
    lastVerifiedAt: baseMs,
    semanticKey: "lifecycle_archive",
  });
  const reminders = createKnowledgeReviewReminders(projectId, {
    nowMs: baseMs,
    staleAfterDays: 999,
    expiryWithinDays: 0,
    grayArchiveQueueDays: 14,
  });
  assert.equal(reminders.some((review) => review.reviewType === "gray_archive_review"), true);
  const decay = decayStaleKnowledge(projectId, baseMs);
  assert.equal(decay.demoted, 1);
  assert.equal(storage.getKnowledge("kb_lifecycle_unattended_gray")?.status, "stale");
  assert.ok(storage.listEvents().some((event) => (
    event.actor === "librarian/gray_decay" &&
    event.tableName === "knowledge_items" &&
    (event.after ?? "").includes('"status":"stale"')
  )));

  let structuralGateId = "";
  for (let i = 0; i < 25; i += 1) {
    const decision = recordSensorFirewallError({
      projectId,
      cycleId: cycle1.id,
      source: "wearable",
      errorKind: "data_missing",
      summary: `missing sample ${i}`,
      externalId: `sample-${i}`,
      observedAt: new Date(baseMs + i * 60_000).toISOString(),
      currentTimeMs: baseMs + i * 60_000,
      sample: { ppg: null },
    });
    if (decision.classification === "structural") structuralGateId = decision.gate?.id ?? structuralGateId;
  }
  const structuralGate = storage.getGate(structuralGateId);
  assert.equal(structuralGate?.type, "meaning");
  assert.equal(structuralGate?.blocking, 0);
  assert.equal(structuralGate?.notifyPolicy, "next_window");

  const pendingInputs = {
    projectId,
    cycleId: cycle1.id,
    metric: "activation_rate",
    errorType: "model" as const,
    claimError: 0.55,
    context: { claimId: "claim_activation" },
    confidence: 0.65,
    lowConfidenceReasons: ["near_model_error_threshold"],
  };
  assert.equal(resolvePendingAttribution({ ...pendingInputs, currentTimeMs: baseMs }).status, "pending");
  assert.equal(resolvePendingAttribution({ ...pendingInputs, currentTimeMs: baseMs + 60_000 }).status, "pending");
  const released = resolvePendingAttribution({ ...pendingInputs, currentTimeMs: baseMs + 120_000 });
  assert.equal(released.status, "released");
  assert.equal(released.shouldReleaseDistiller, true);
  assert.equal(storage.listPendingAttributions(projectId, { status: "released" }).length, 3);

  createGoldCase(projectId, "gold_lifecycle_regression", 0.8);
  const proposalResult = proposeDistillerKnowledge({
    projectId,
    cycleId: cycle1.id,
    proposedContent: {
      id: "kb_lifecycle_proposal",
      projectId,
      type: "world_model",
      title: "Lifecycle proposal knowledge",
      content: "Consistent low-confidence attribution samples can produce a gated distiller proposal.",
      sourceType: "agent_observation",
      sourceRef: "knowledge-lifecycle-e2e",
      evidenceAlpha: 2,
      evidenceBeta: 1,
      confidenceScore: 2 / 3,
      confidenceLevel: "medium",
      status: "draft",
      validFrom: "2026-06-01",
      tags: ["lifecycle", "proposal"],
      semanticKey: "lifecycle_proposal",
    },
    attributionBasis: {
      errorType: "model",
      claimError: 0.55,
      contextSnapshot: { metric: "activation_rate" },
      attributionConfidence: 0.65,
      route: "distiller_world_model_update",
      lowConfidenceReasons: ["near_model_error_threshold"],
      sampleFingerprints: [released.fingerprint],
      pendingAttributionIds: storage.listPendingAttributions(projectId, { status: "released" }).map((item) => item.id),
    },
  });
  assert.equal(proposalResult.proposal.status, "gated");
  assert.equal(proposalResult.proposal.regressionStatus, "passed");
  assert.ok(proposalResult.gate);
  assert.equal(proposalResult.gate?.blocking, 0);
  assert.equal(proposalResult.gate?.notifyPolicy, "next_window");
  assert.equal(storage.getKnowledge("kb_lifecycle_proposal"), undefined, "proposal must not write knowledge before approval");

  for (const gate of storage.listGates(projectId)) assertDecisionBriefPayload(gate);

  const platform = new FakePlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);
  emitSchedulerNotifications(bus, new Set(), {
    projectId,
    action: "waiting_blocking_gate",
    cycleId: cycle1.id,
    budget: gateBudgetForProject(projectId),
    note: "outside-window next_window gates should not notify",
  });
  await processReviewWindowTick(projectId, bus, new Date("2026-06-11T06:00:00.000Z"));
  assert.equal(platform.sentCards.length, 0, "next_window gates must not disturb outside a review window");

  const opened = await processReviewWindowTick(projectId, bus, new Date("2026-06-12T07:30:00.000Z"));
  assert.equal(opened.digestSent, true);
  assert.match(platform.sentCards[0].card.body, /meaning:/);
  assert.equal(JSON.parse(storage.getGate(structuralGateId)?.payload ?? "{}").reviewSessionId, opened.openedSessionId);
  assert.equal(JSON.parse(storage.getGate(proposalResult.gate!.id)?.payload ?? "{}").reviewSessionId, opened.openedSessionId);

  new HumanGateService().approve(proposalResult.gate!.id, { actor: "e2e", via: "knowledge-lifecycle-e2e" });
  const created = storage.getKnowledge("kb_lifecycle_proposal");
  assert.equal(created?.status, "active");
  assert.equal(created?.createdBy, "distiller_proposal");
  assert.ok(storage.listActionLedger(projectId).some((row) => row.actionType === "capability.knowledge_write"));

  const low = createGoldCase(projectId, "gold_lifecycle_low", 0.45);
  const inside = createGoldCase(projectId, "gold_lifecycle_inside", 0.55);
  const high = createGoldCase(projectId, "gold_lifecycle_high", 0.65);
  const retired = onCoreParameterChanged("MODEL_ERROR_THRESHOLD", 0.5, 0.6, [low, inside, high]);
  assert.deepEqual(retired.retiredCaseIds, ["gold_lifecycle_inside"]);
  assert.equal(storage.getGoldCase("gold_lifecycle_low")?.active, 1);
  assert.equal(storage.getGoldCase("gold_lifecycle_inside")?.active, 0);
  assert.match(storage.getGoldCase("gold_lifecycle_inside")?.retiredReason ?? "", /MODEL_ERROR_THRESHOLD/);
  assert.equal(storage.getGoldCase("gold_lifecycle_high")?.active, 1);
});
