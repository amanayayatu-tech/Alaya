import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlayaCard, CallbackHandler, MessageRef, MessagingPlatform, SentMessage } from "../server/notifications/types.ts";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-telegram-interaction-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { compactGateCallbackTarget, compactReviewCallbackTarget, gateCard } = await import("../server/notifications/card.ts");
const { NotificationBus } = await import("../server/notifications/bus.ts");
const { CallbackRouter } = await import("../server/notifications/router.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { detectKnowledgeConflicts } = await import("../server/knowledgeReview.ts");
const { recordNotificationEmitFailure } = await import("../server/scheduler.ts");

class FakePlatform implements MessagingPlatform {
  sentCards: Array<{ chatId: string; card: AlayaCard }> = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  editedCards: Array<{ ref: MessageRef; card: AlayaCard }> = [];
  answeredCallbacks: Array<{ callbackId: string; text?: string }> = [];
  callbackHandlers: CallbackHandler[] = [];
  typingChatIds: string[] = [];

  name() { return "fake"; }
  async sendText(chatId: string, text: string): Promise<void> { this.sentTexts.push({ chatId, text }); }
  async sendCard(chatId: string, card: AlayaCard): Promise<SentMessage> {
    this.sentCards.push({ chatId, card });
    return { chatId, messageId: this.sentCards.length };
  }
  async editCard(ref: MessageRef, card: AlayaCard): Promise<void> { this.editedCards.push({ ref, card }); }
  async answerCallback(callbackId: string, text?: string): Promise<void> { this.answeredCallbacks.push({ callbackId, text }); }
  onCallbackQuery(handler: CallbackHandler): void { this.callbackHandlers.push(handler); }
  async sendTyping(chatId: string): Promise<void> { this.typingChatIds.push(chatId); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

class FailingPlatform extends FakePlatform {
  name() { return "failing"; }
  async sendText(): Promise<void> { throw new Error("telegram send failed"); }
  async sendCard(): Promise<SentMessage> { throw new Error("telegram card failed"); }
}

class FailingOnceCardPlatform extends FakePlatform {
  private failuresLeft = 1;

  async sendCard(chatId: string, card: AlayaCard): Promise<SentMessage> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("telegram card failed once");
    }
    return super.sendCard(chatId, card);
  }
}

class FailingOnceTextPlatform extends FakePlatform {
  private failuresLeft = 1;

  async sendText(chatId: string, text: string): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("telegram text failed once");
    }
    return super.sendText(chatId, text);
  }
}

class FailingEditPlatform extends FakePlatform {
  async editCard(ref: MessageRef, card: AlayaCard): Promise<void> {
    this.editedCards.push({ ref, card });
    throw new Error("telegram edit failed");
  }
}

class FailingAnswerCallbackPlatform extends FakePlatform {
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.answeredCallbacks.push({ callbackId, text });
    throw new Error("BUTTON_DATA_INVALID");
  }
}

class DelayedSendCardPlatform extends FakePlatform {
  private markReady!: () => void;
  private releaseSend!: () => void;
  readonly sendStarted = new Promise<void>((resolve) => { this.markReady = resolve; });
  readonly release = new Promise<void>((resolve) => { this.releaseSend = resolve; });

  async sendCard(chatId: string, card: AlayaCard): Promise<SentMessage> {
    this.markReady();
    await this.release;
    return super.sendCard(chatId, card);
  }

  unblockSend(): void {
    this.releaseSend();
  }
}

function createProjectWithCycle() {
  storage.createProject({
    id: "proj_tg",
    name: "Telegram Test",
    direction: "Test direction",
    targetUser: "Test user",
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
    id: "cycle_tg_1",
    projectId: "proj_tg",
    idx: 1,
    goal: "test",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createProjectAndCycle(projectId: string, cycleId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "Test direction",
    targetUser: "Test user",
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
    id: cycleId,
    projectId,
    idx: 1,
    goal: "test",
    status: "planning",
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
    title: patch.title ?? "Metric threshold",
    content: patch.content ?? "activation_rate >= 0.4",
    sourceType: patch.sourceType ?? "metric",
    sourceRef: patch.sourceRef ?? "test",
    evidenceAlpha: patch.evidenceAlpha ?? 5,
    evidenceBeta: patch.evidenceBeta ?? 1,
    confidenceScore: patch.confidenceScore ?? 0.8,
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
    lastVerifiedAt: Date.parse("2026-01-01T00:00:00Z"),
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

test("gate cards render Telegram decision buttons for meaning, direction, and ordinary risk gates", () => {
  const meaning = gateCard({
    title: "意义闸",
    body: "needs review",
    gateId: "gate_meaning_1",
    gateType: "meaning",
    isBlocking: false,
    actionUrl: "http://localhost:5000/#/human-gates?gate=gate_meaning_1",
  });
  assert.deepEqual(meaning.buttons?.[0].map((button) => button.callbackData), [
    "perm:allow:gate_meaning_1",
    "perm:deny:gate_meaning_1",
  ]);

  const direction = gateCard({
    title: "方向闸",
    body: "needs decision",
    gateId: "gate_direction_1",
    gateType: "direction",
    isBlocking: true,
    actionUrl: "http://localhost:5000/#/human-gates?gate=gate_direction_1",
  });
  assert.deepEqual(direction.buttons?.[0].map((button) => button.callbackData), [
    "perm:allow:gate_direction_1",
    "perm:deny:gate_direction_1",
  ]);

  const risk = gateCard({
    title: "风险闸",
    body: "needs risk review",
    gateId: "gate_risk_1",
    gateType: "risk",
    isBlocking: true,
    actionUrl: "http://localhost:5000/#/human-gates?gate=gate_risk_1",
  });
  assert.deepEqual(risk.buttons?.[0].map((button) => button.callbackData), [
    "perm:allow:gate_risk_1",
    "perm:deny:gate_risk_1",
  ]);

  const conflict = gateCard({
    title: "知识冲突复核",
    body: "needs conflict decision",
    gateId: "gate_kr_1",
    gateType: "risk",
    isBlocking: true,
    actionUrl: "http://localhost:5000/#/human-gates?gate=gate_kr_1",
    riskKey: "knowledge_conflict_review",
    reviewId: "kr_1",
  });
  assert.deepEqual(conflict.buttons?.[0].map((button) => button.callbackData), ["kr:q:kr_1", "kr:m:kr_1"]);
  assert.deepEqual(conflict.buttons?.[1].map((button) => button.callbackData), ["nav:gate:gate_kr_1"]);
});

test("gate cards compact long gate ids for Telegram callback_data", () => {
  const longGateId = "gate_ext_fb_form_3zxl8k_health_signal_contradiction_runner_sample_0151_ppg_support";
  const meaning = gateCard({
    title: "长 ID 意义闸",
    body: "needs review",
    gateId: longGateId,
    gateType: "meaning",
    isBlocking: false,
    actionUrl: `http://localhost:5000/#/human-gates?gate=${longGateId}`,
  });
  const callbacks = meaning.buttons?.[0].map((button) => button.callbackData) ?? [];
  assert.equal(callbacks.every((item) => Buffer.byteLength(item, "utf8") <= 64), true);
  assert.deepEqual(callbacks, [
    `perm:allow:${compactGateCallbackTarget(longGateId, "perm:allow:")}`,
    `perm:deny:${compactGateCallbackTarget(longGateId, "perm:deny:")}`,
  ]);
  assert.match(callbacks[0], /^perm:allow:t:[a-f0-9]{18}$/);

  const risk = gateCard({
    title: "长 ID 风险闸",
    body: "needs risk review",
    gateId: longGateId,
    gateType: "risk",
    isBlocking: true,
    actionUrl: `http://localhost:5000/#/human-gates?gate=${longGateId}`,
  });
  const riskCallbacks = risk.buttons?.[0].map((button) => button.callbackData) ?? [];
  assert.equal(riskCallbacks.every((item) => Buffer.byteLength(item, "utf8") <= 64), true);
  assert.match(riskCallbacks[0], /^perm:allow:t:[a-f0-9]{18}$/);
  assert.match(riskCallbacks[1], /^perm:deny:t:[a-f0-9]{18}$/);

  const longReviewId = "kr_health_signal_review_extremely_long_sample_0151_ppg_support_vs_hybrid_decision_confidence";
  const conflict = gateCard({
    title: "长 ID 知识冲突复核",
    body: "needs conflict review",
    gateId: `gate_${longReviewId}`,
    gateType: "risk",
    isBlocking: true,
    actionUrl: `http://localhost:5000/#/human-gates?gate=gate_${longReviewId}`,
    riskKey: "knowledge_conflict_review",
    reviewId: longReviewId,
  });
  const conflictCallbacks = conflict.buttons?.[0].map((button) => button.callbackData) ?? [];
  assert.equal(conflictCallbacks.every((item) => Buffer.byteLength(item, "utf8") <= 64), true);
  assert.match(conflictCallbacks[0], /^kr:q:t:[a-f0-9]{18}$/);
  assert.match(conflictCallbacks[1], /^kr:m:t:[a-f0-9]{18}$/);
});

test("callback router approves meaning gates through service and records action ledger", async () => {
  createProjectWithCycle();
  storage.createGate({
    id: "gate_meaning_telegram",
    cycleId: "cycle_tg_1",
    type: "meaning",
    blocking: 0,
    title: "Meaning review",
    payload: JSON.stringify({ createdAt: now(), summary: "meaning needs review" }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  await router.route("cb_1", "perm:allow:gate_meaning_telegram", { chatId: "42", messageId: 10 });

  assert.equal(platform.answeredCallbacks[0].callbackId, "cb_1");
  assert.equal(platform.typingChatIds[0], "42");
  assert.equal(storage.getGate("gate_meaning_telegram")?.status, "approved");
  assert.equal(storage.listActionLedger("proj_tg").some((row) => row.actionType === "human_gate.approve" && row.target === "gate_meaning_telegram"), true);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /已批准/);
});

test("callback router approves direction gates from Telegram", async () => {
  createProjectAndCycle("proj_tg_direction", "cycle_tg_direction_1");
  storage.createGate({
    id: "gate_direction_telegram",
    cycleId: "cycle_tg_direction_1",
    type: "direction",
    blocking: 1,
    title: "Direction review",
    payload: JSON.stringify({ createdAt: now(), summary: "direction needs approval" }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  await router.route("cb_dir", "perm:allow:gate_direction_telegram", { chatId: "42", messageId: 14 });

  assert.equal(storage.getGate("gate_direction_telegram")?.status, "approved");
  assert.equal(storage.listActionLedger("proj_tg_direction").some((row) =>
    row.actionType === "human_gate.approve" && row.target === "gate_direction_telegram"), true);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /已批准/);
});

test("callback router resolves knowledge conflict reviews from Telegram", async () => {
  createProjectAndCycle("proj_tg_conflict_review", "cycle_tg_conflict_review_1");
  createKnowledge("proj_tg_conflict_review", "kb_conflict_survivor", {
    status: "strong",
    content: "hybrid_decision_confidence >= 0.8",
    confidenceScore: 0.9,
  });
  createKnowledge("proj_tg_conflict_review", "kb_conflict_candidate", {
    status: "active",
    content: "hybrid_decision_confidence <= 0.3",
    confidenceScore: 0.7,
  });
  detectKnowledgeConflicts("proj_tg_conflict_review");
  const review = storage
    .listKnowledgeReviews("proj_tg_conflict_review")
    .find((item) => item.primaryKnowledgeId === "kb_conflict_candidate");
  assert.ok(review);
  assert.equal(storage.getGate(`gate_${review.id}`)?.status, "pending");

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  await router.route("cb_kr", `kr:q:${review.id}`, { chatId: "42", messageId: 15 });

  assert.equal(storage.getKnowledgeReview(review.id)?.status, "resolved");
  assert.equal(storage.getKnowledge("kb_conflict_candidate")?.status, "quarantined");
  assert.equal(storage.getGate(`gate_${review.id}`)?.status, "approved");
  assert.equal(storage.listEvents().some((event) =>
    event.tableName === "human_gate_items" &&
    event.op === "resolve" &&
    event.actor === "human_telegram" &&
    event.after.includes(`gate_${review.id}`) &&
    event.after.includes("knowledge_review:quarantine")), true);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /知识冲突复核已处理：quarantine/);
});

test("callback router resolves compact knowledge review tokens", async () => {
  createProjectAndCycle("proj_tg_compact_review", "cycle_tg_compact_review_1");
  createKnowledge("proj_tg_compact_review", "kb_compact_review_survivor", {
    status: "strong",
    content: "hybrid_decision_confidence >= 0.8",
    confidenceScore: 0.9,
  });
  createKnowledge("proj_tg_compact_review", "kb_compact_review_candidate", {
    status: "active",
    content: "hybrid_decision_confidence <= 0.3",
    confidenceScore: 0.7,
  });
  const reviewId = "kr_health_signal_review_extremely_long_sample_0151_ppg_support_vs_hybrid_decision_confidence";
  storage.createKnowledgeReview({
    id: reviewId,
    projectId: "proj_tg_compact_review",
    cycleId: "cycle_tg_compact_review_1",
    reviewType: "conflict",
    status: "review_required",
    primaryKnowledgeId: "kb_compact_review_candidate",
    relatedKnowledgeId: "kb_compact_review_survivor",
    reason: "long review id should be addressable from Telegram",
    evidence: "{}",
    recommendedAction: "quarantine weaker evidence",
    createdAt: now(),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    version: 1,
  });
  storage.createGate({
    id: `gate_${reviewId}`,
    cycleId: "cycle_tg_compact_review_1",
    type: "risk",
    blocking: 1,
    title: "Long knowledge conflict review",
    payload: JSON.stringify({ riskKey: "knowledge_conflict_review", reviewId }),
    status: "pending",
    estimatedMinutes: 12,
    decision: null,
    version: 1,
  });

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  const target = compactReviewCallbackTarget(reviewId, "kr:q:");
  assert.match(target, /^t:[a-f0-9]{18}$/);
  await router.route("cb_compact_review", `kr:q:${target}`, { chatId: "42", messageId: 17 });

  assert.equal(storage.getKnowledgeReview(reviewId)?.status, "resolved");
  assert.equal(storage.getKnowledge("kb_compact_review_candidate")?.status, "quarantined");
  assert.equal(storage.getGate(`gate_${reviewId}`)?.status, "approved");
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /知识冲突复核已处理：quarantine/);
});

test("callback router resolves compact Telegram gate tokens", async () => {
  createProjectAndCycle("proj_tg_compact", "cycle_tg_compact_1");
  const longGateId = "gate_ext_fb_form_3zxl8k_health_signal_contradiction_runner_sample_0151_ppg_support";
  storage.createGate({
    id: longGateId,
    cycleId: "cycle_tg_compact_1",
    type: "meaning",
    blocking: 0,
    title: "Long meaning review",
    payload: JSON.stringify({ createdAt: now(), summary: "long meaning needs review" }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  const target = compactGateCallbackTarget(longGateId, "perm:allow:");
  await router.route("cb_compact", `perm:allow:${target}`, { chatId: "42", messageId: 11 });

  assert.equal(storage.getGate(longGateId)?.status, "approved");
  assert.equal(storage.listActionLedger("proj_tg_compact").some((row) => row.actionType === "human_gate.approve" && row.target === longGateId), true);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /已批准/);
});

test("callback router still resolves meaning gates when Telegram callback acknowledgement fails", async () => {
  createProjectAndCycle("proj_tg_callback_fail", "cycle_tg_callback_fail_1");
  storage.createGate({
    id: "gate_meaning_callback_fail",
    cycleId: "cycle_tg_callback_fail_1",
    type: "meaning",
    blocking: 0,
    title: "Meaning review with flaky callback",
    payload: JSON.stringify({ createdAt: now(), summary: "meaning needs review despite callback failure" }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  const platform = new FailingAnswerCallbackPlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  const originalConsoleWarn = console.warn;

  try {
    console.warn = () => {};
    await router.route("cb_flaky", "perm:allow:gate_meaning_callback_fail", { chatId: "42", messageId: 12 });
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(platform.answeredCallbacks[0].callbackId, "cb_flaky");
  assert.equal(storage.getGate("gate_meaning_callback_fail")?.status, "approved");
  assert.equal(storage.listActionLedger("proj_tg_callback_fail").some((row) =>
    row.actionType === "human_gate.approve" && row.target === "gate_meaning_callback_fail"), true);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /已批准/);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /BUTTON\\_DATA\\_INVALID/);
  const feedbackFailure = storage.listEvents().find((event) => {
    if (event.tableName !== "notifications" || event.op !== "callback_feedback_failed") return false;
    const payload = JSON.parse(event.after ?? "{}");
    return payload.gateId === "gate_meaning_callback_fail" && payload.operation === "answerCallback";
  });
  assert.ok(feedbackFailure);
});

test("callback router edits stale Telegram cards for already resolved meaning gates", async () => {
  createProjectAndCycle("proj_tg_stale_callback", "cycle_tg_stale_callback_1");
  storage.createGate({
    id: "gate_meaning_stale_callback",
    cycleId: "cycle_tg_stale_callback_1",
    type: "meaning",
    blocking: 0,
    title: "Already approved meaning review",
    payload: JSON.stringify({ createdAt: now(), resolvedAt: now(), summary: "already handled" }),
    status: "approved",
    estimatedMinutes: 5,
    decision: "approve",
    version: 2,
  });

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  await router.route("cb_stale", "perm:allow:gate_meaning_stale_callback", { chatId: "42", messageId: 13 });

  assert.equal(storage.getGate("gate_meaning_stale_callback")?.status, "approved");
  assert.equal(storage.listActionLedger("proj_tg_stale_callback").some((row) =>
    row.actionType === "human_gate.approve" && row.target === "gate_meaning_stale_callback"), false);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /已批准/);
  assert.doesNotMatch(platform.editedCards.at(-1)?.card.body ?? "", /处理失败/);
});

test("callback router edits stale knowledge conflict review cards before special-case prompts", async () => {
  createProjectAndCycle("proj_tg_stale_conflict_callback", "cycle_tg_stale_conflict_callback_1");
  storage.createGate({
    id: "gate_kr_stale_conflict_callback",
    cycleId: "cycle_tg_stale_conflict_callback_1",
    type: "risk",
    blocking: 1,
    title: "Already resolved knowledge conflict review",
    payload: JSON.stringify({
      riskKey: "knowledge_conflict_review",
      reviewId: "kr_stale_conflict_callback",
      reason: "already handled",
      resolvedAt: now(),
    }),
    status: "approved",
    estimatedMinutes: 12,
    decision: "knowledge_review:merge_supersede",
    version: 2,
  });

  const platform = new FakePlatform();
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));
  await router.route("cb_stale_conflict", "perm:allow:gate_kr_stale_conflict_callback", { chatId: "42", messageId: 16 });

  assert.equal(storage.getGate("gate_kr_stale_conflict_callback")?.status, "approved");
  assert.equal(platform.sentTexts.length, 0);
  assert.match(platform.editedCards.at(-1)?.card.body ?? "", /已批准/);
  assert.doesNotMatch(platform.editedCards.at(-1)?.card.body ?? "", /请使用/);
});

test("project state lastCycleAt is scoped by project id", () => {
  createProjectAndCycle("proj_state_a", "cycle_state_a_1");
  createProjectAndCycle("proj_state_b", "cycle_state_b_1");

  storage.recordEvent({
    cycleIdx: 1,
    actor: "test",
    tableName: "cycles",
    op: "update",
    before: null,
    after: JSON.stringify({ projectId: "proj_state_a" }),
    ts: "2026-06-07T00:00:00.000Z",
  });
  storage.recordEvent({
    cycleIdx: 1,
    actor: "test",
    tableName: "cycles",
    op: "update",
    before: null,
    after: JSON.stringify({ projectId: "proj_state_b" }),
    ts: "2026-06-07T00:01:00.000Z",
  });

  assert.equal(storage.getProjectState("proj_state_a").lastCycleAt, "2026-06-07T00:00:00.000Z");
  assert.equal(storage.getProjectState("proj_state_b").lastCycleAt, "2026-06-07T00:01:00.000Z");
});

test("notification bus suppresses stale gate-opened cards after gate is resolved", async () => {
  createProjectAndCycle("proj_notify_stale_gate", "cycle_notify_stale_gate_1");
  storage.createGate({
    id: "gate_notify_stale",
    cycleId: "cycle_notify_stale_gate_1",
    type: "direction",
    blocking: 1,
    title: "Direction already handled",
    payload: JSON.stringify({ createdAt: now(), summary: "direction was approved before Telegram send" }),
    status: "approved",
    estimatedMinutes: 5,
    decision: "approve",
    version: 2,
  });

  const platform = new FakePlatform();
  const bus = new NotificationBus(undefined, {
    shouldSend: (event) => event.type !== "gate_opened" || storage.getGate(event.gateId ?? "")?.status === "pending",
  }).addAdapter(platform, ["42"]);

  await bus.emit({
    type: "gate_opened",
    projectId: "proj_notify_stale_gate",
    title: "方向闸待处理 — proj_notify_stale_gate",
    body: "this pending card should not be sent",
    gateId: "gate_notify_stale",
    gateType: "direction",
    isBlocking: true,
  });

  assert.equal(platform.sentCards.length, 0);
});

test("notification bus edits an existing Telegram gate card when Web/API resolves it", async () => {
  const platform = new FakePlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);

  await bus.emit({
    type: "gate_opened",
    projectId: "proj_notify_edit_gate",
    title: "方向闸待处理 — proj_notify_edit_gate",
    body: "pending direction",
    gateId: "gate_notify_edit",
    gateType: "direction",
    isBlocking: true,
    actionUrl: "http://127.0.0.1:5300/#/human-gates?gate=gate_notify_edit",
  });
  await bus.emit({
    type: "gate_resolved",
    projectId: "proj_notify_edit_gate",
    title: "已批准 — 第 1 轮方向闸",
    body: "已批准此方向闸，当前待处理闸门：0 个。",
    gateId: "gate_notify_edit",
    gateType: "direction",
    isBlocking: true,
    actionUrl: "http://127.0.0.1:5300/#/human-gates?gate=gate_notify_edit",
  });

  assert.equal(platform.sentCards.length, 1);
  assert.equal(platform.editedCards.length, 1);
  assert.equal(platform.sentTexts.length, 0);
  assert.match(platform.editedCards[0].card.body, /已批准此方向闸/);
});

test("notification bus persists Telegram gate card refs across app restarts", async () => {
  const originalRefPath = process.env.ALAYA_NOTIFICATION_REF_PATH;
  const refPath = join(mkdtempSync(join(tmpdir(), "alaya-telegram-ref-test-")), "refs.json");

  try {
    process.env.ALAYA_NOTIFICATION_REF_PATH = refPath;
    const firstPlatform = new FakePlatform();
    const firstBus = new NotificationBus().addAdapter(firstPlatform, ["42"]);
    await firstBus.emit({
      type: "gate_opened",
      projectId: "proj_notify_persisted_ref",
      title: "方向闸待处理 — proj_notify_persisted_ref",
      body: "pending direction",
      gateId: "gate_notify_persisted_ref",
      gateType: "direction",
      isBlocking: true,
    });

    const persisted = JSON.parse(readFileSync(refPath, "utf8"));
    assert.equal(persisted.gate_notify_persisted_ref["fake:42"].messageId, 1);
    assert.deepEqual(firstBus.knownGateIds(), ["gate_notify_persisted_ref"]);

    const restartedPlatform = new FakePlatform();
    const restartedBus = new NotificationBus().addAdapter(restartedPlatform, ["42"]);
    assert.deepEqual(restartedBus.knownGateIds(), ["gate_notify_persisted_ref"]);
    await restartedBus.emit({
      type: "gate_resolved",
      projectId: "proj_notify_persisted_ref",
      title: "已批准 — 第 1 轮方向闸",
      body: "app 重启后仍应编辑原 Telegram 卡片。",
      gateId: "gate_notify_persisted_ref",
      gateType: "direction",
      isBlocking: true,
    });

    assert.equal(restartedPlatform.sentTexts.length, 0);
    assert.equal(restartedPlatform.editedCards.length, 1);
    assert.equal(restartedPlatform.editedCards[0].ref.messageId, 1);
    assert.match(restartedPlatform.editedCards[0].card.body, /app 重启后仍应编辑原 Telegram 卡片/);
  } finally {
    if (originalRefPath === undefined) {
      delete process.env.ALAYA_NOTIFICATION_REF_PATH;
    } else {
      process.env.ALAYA_NOTIFICATION_REF_PATH = originalRefPath;
    }
  }
});

test("notification bus sends a terminal receipt text when gate card edit fails", async () => {
  const platform = new FailingEditPlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);
  const originalConsoleWarn = console.warn;

  try {
    console.warn = () => {};
    await bus.emit({
      type: "gate_opened",
      projectId: "proj_notify_edit_fallback",
      title: "方向闸待处理 — proj_notify_edit_fallback",
      body: "pending direction",
      gateId: "gate_notify_edit_fallback",
      gateType: "direction",
      isBlocking: true,
    });
    await bus.emit({
      type: "gate_resolved",
      projectId: "proj_notify_edit_fallback",
      title: "已批准 — 第 1 轮方向闸",
      body: "编辑原卡失败后应该补发这条终态回执。",
      gateId: "gate_notify_edit_fallback",
      gateType: "direction",
      isBlocking: true,
    });
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(platform.sentCards.length, 1);
  assert.equal(platform.editedCards.length, 1);
  assert.equal(platform.sentTexts.length, 1);
  assert.match(platform.sentTexts[0].text, /编辑原卡失败后应该补发这条终态回执/);
});

test("notification bus edits a pending gate card when resolution races before sendCard returns", async () => {
  const platform = new DelayedSendCardPlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);

  const opened = bus.emit({
    type: "gate_opened",
    projectId: "proj_notify_race_gate",
    title: "风险闸待处理 — proj_notify_race_gate",
    body: "pending risk",
    gateId: "gate_notify_race",
    gateType: "risk",
    isBlocking: true,
  });
  await platform.sendStarted;
  const resolved = bus.emit({
    type: "gate_resolved",
    projectId: "proj_notify_race_gate",
    title: "已批准 — 知识冲突复核",
    body: "知识冲突复核已处理。",
    gateId: "gate_notify_race",
    gateType: "risk",
    isBlocking: true,
  });
  platform.unblockSend();
  await resolved;
  await opened;

  assert.equal(platform.sentCards.length, 1);
  assert.equal(platform.editedCards.length, 1);
  assert.equal(platform.sentTexts.length, 0);
  assert.match(platform.editedCards[0].card.body, /知识冲突复核已处理/);
});

test("notification bus retries gate-opened cards after a transient send failure", async () => {
  const platform = new FailingOnceCardPlatform();
  const failures: Array<string> = [];
  const bus = new NotificationBus((failure) => {
    failures.push(failure.error instanceof Error ? failure.error.message : String(failure.error));
  }).addAdapter(platform, ["42"]);
  const event = {
    type: "gate_opened" as const,
    projectId: "proj_notify_retry_gate",
    title: "意义闸待处理 — proj_notify_retry_gate",
    body: "pending meaning",
    gateId: "gate_notify_retry",
    gateType: "meaning" as const,
    isBlocking: false,
  };
  const originalConsoleError = console.error;

  try {
    console.error = () => {};
    await bus.emit(event);
  } finally {
    console.error = originalConsoleError;
  }
  await bus.emit(event);

  assert.deepEqual(failures, ["telegram card failed once"]);
  assert.equal(platform.sentCards.length, 1);
  assert.equal(platform.sentCards[0].card.body, "pending meaning");
});

test("notification bus retries terminal gate receipts after a transient send failure", async () => {
  const platform = new FailingOnceTextPlatform();
  const failures: Array<string> = [];
  const bus = new NotificationBus((failure) => {
    failures.push(failure.error instanceof Error ? failure.error.message : String(failure.error));
  }, {
    maxRetries: 1,
    retryBaseMs: 0,
  }).addAdapter(platform, ["42"]);
  const originalConsoleError = console.error;

  try {
    console.error = () => {};
    await bus.emit({
      type: "gate_resolved",
      projectId: "proj_notify_retry_terminal",
      title: "已批准 — 意义闸",
      body: "终态回执首次发送失败后应该重试。",
      gateId: "gate_notify_terminal_retry",
      gateType: "meaning",
      isBlocking: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(failures, ["telegram text failed once"]);
  assert.equal(platform.sentTexts.length, 1);
  assert.match(platform.sentTexts[0].text, /终态回执首次发送失败后应该重试/);
});

test("notification emit failures are persisted for observability", async () => {
  createProjectAndCycle("proj_notify_failure", "cycle_notify_failure_1");
  const bus = new NotificationBus(recordNotificationEmitFailure, { maxRetries: 0 }).addAdapter(new FailingPlatform(), ["42"]);
  const originalConsoleError = console.error;

  try {
    console.error = () => {};
    await bus.emit({
      type: "safety_mode",
      projectId: "proj_notify_failure",
      title: "Safety Mode 已触发",
      body: "send should fail",
      gateId: "cycle_notify_failure_1",
      meta: { cycleId: "cycle_notify_failure_1" },
    });
  } finally {
    console.error = originalConsoleError;
  }

  const event = storage.listEvents().find((row) => row.tableName === "notifications" && row.op === "emit_failed");
  assert.ok(event);
  assert.equal(event.cycleIdx, 1);
  assert.match(event.after ?? "", /telegram send failed/);

  const trace = storage.listTraceEventsByProject("proj_notify_failure")
    .find((row) => row.kind === "notification" && row.name === "notification_emit_failed");
  assert.ok(trace);
  assert.equal(trace.status, "error");
  assert.match(trace.attributes, /telegram send failed/);
});
