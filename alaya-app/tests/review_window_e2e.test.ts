import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlayaCard, CallbackHandler, MessageRef, MessagingPlatform, SentMessage } from "../server/notifications/types.ts";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-review-window-e2e-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_REVIEW_TIMEZONE = "Asia/Shanghai";
process.env.ALAYA_REVIEW_WINDOWS = "15:30-16:00";
process.env.ALAYA_GATE_ESCALATION_MISSED_WINDOWS = "1";
process.env.ALAYA_APPLY_GRACE_SECONDS = "60";
process.env.ALAYA_APPLY_STAGGER_SECONDS = "2";
process.env.ALAYA_SPECULATIVE_DRAFTING = "true";

const { storage, now } = await import("../server/storage.ts");
const { NotificationBus } = await import("../server/notifications/bus.ts");
const { CallbackRouter } = await import("../server/notifications/router.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { processReviewWindowTick } = await import("../server/scheduler/core.ts");
const { runApplyExecutor, reconcileSpeculativeAssumptions } = await import("../server/applyExecutor.ts");

class FakePlatform implements MessagingPlatform {
  sentCards: Array<{ chatId: string; card: AlayaCard }> = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  editedCards: Array<{ ref: MessageRef; card: AlayaCard }> = [];
  answeredCallbacks: Array<{ callbackId: string; text?: string }> = [];
  callbackHandlers: CallbackHandler[] = [];

  name() { return "fake"; }
  async sendText(chatId: string, text: string): Promise<void> { this.sentTexts.push({ chatId, text }); }
  async sendCard(chatId: string, card: AlayaCard): Promise<SentMessage> {
    this.sentCards.push({ chatId, card });
    return { chatId, messageId: this.sentCards.length };
  }
  async editCard(ref: MessageRef, card: AlayaCard): Promise<void> { this.editedCards.push({ ref, card }); }
  async answerCallback(callbackId: string, text?: string): Promise<void> { this.answeredCallbacks.push({ callbackId, text }); }
  onCallbackQuery(handler: CallbackHandler): void { this.callbackHandlers.push(handler); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: "Review Window E2E",
    direction: "Batch review speculative work",
    targetUser: "operator",
    redlines: "[]",
    weeklyHumanMinutes: 120,
    weeklyLlmBudgetCents: 1000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "review window e2e",
    worldModel: "speculative drafts require gated apply",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: `cycle_1_${projectId}`,
    projectId,
    idx: 1,
    goal: "parent waits for review",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createSpeculativeDraft(projectId: string, id: string, idx: number, parentCycleId: string, dependsOn: string[]) {
  return storage.createCycle({
    id,
    projectId,
    idx,
    goal: `speculative ${idx}`,
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "review-window e2e speculative draft",
    speculative: 1,
    parentCycleId,
    dependsOn: JSON.stringify(dependsOn),
    assumedOutcomes: JSON.stringify(dependsOn.map((cycle) => ({ cycle, claim: "blocking_gate_approval", assumed: "met" }))),
    draftStatus: "ready_awaiting_approval",
    applyScheduledAt: null,
    appliedAt: null,
    coAppliedSet: null,
    version: 1,
  });
}

function createSpecGate(cycleId: string, gateId: string) {
  return storage.createGate({
    id: gateId,
    cycleId,
    type: "risk",
    blocking: 1,
    title: `Apply ${cycleId}`,
    payload: JSON.stringify({ riskKey: "speculative_apply_draft", draftCycleId: cycleId, createdAt: now() }),
    status: "pending",
    estimatedMinutes: 6,
    decision: null,
    version: 1,
  });
}

test("e2e review window covers digest, reason reject, grace revoke, apply, cascade, and summary", async () => {
  const projectId = "proj_review_window_e2e";
  createProject(projectId);
  const ancestor = createSpeculativeDraft(projectId, `cycle_spec_a_${projectId}`, 2, `cycle_1_${projectId}`, [`cycle_1_${projectId}`]);
  const rejectedChild = createSpeculativeDraft(projectId, `cycle_spec_b_${projectId}`, 3, ancestor.id, [ancestor.id]);
  const cascadeChild = createSpeculativeDraft(projectId, `cycle_spec_c_${projectId}`, 4, ancestor.id, [ancestor.id]);
  createSpecGate(ancestor.id, "gate_e2e_apply_a");
  createSpecGate(rejectedChild.id, "gate_e2e_apply_b");
  createSpecGate(cascadeChild.id, "gate_e2e_apply_c");
  storage.createGate({
    id: "gate_e2e_meaning",
    cycleId: `cycle_1_${projectId}`,
    type: "meaning",
    blocking: 0,
    title: "Meaning approval",
    payload: JSON.stringify({ createdAt: now(), summary: "approved meaning signal", source: "e2e", externalId: "e2e-meaning" }),
    status: "pending",
    estimatedMinutes: 4,
    decision: null,
    version: 1,
  });

  const platform = new FakePlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);
  const router = new CallbackRouter(platform, storage, new HumanGateService(storage));

  const opened = await processReviewWindowTick(projectId, bus, new Date("2026-06-10T07:30:00.000Z"));
  assert.equal(opened.digestSent, true);
  assert.equal(platform.sentCards[0].card.buttons?.flat().some((button) => button.callbackData === `cmd:/review:${projectId}`), true);
  assert.equal(storage.getNotificationDigest(projectId, "2026-06-10", "15:30-16:00")?.sentAt, "2026-06-10T07:30:00.000Z");

  await router.route("", "cmd:/review", { chatId: "42", messageId: 0 });
  assert.equal(storage.getOpenReviewSession(projectId)?.source, "scheduled");

  await router.route("cb_reject_child", "perm:reason:weak_evidence:gate_e2e_apply_b", { chatId: "42", messageId: 10 });
  assert.equal(storage.getGate("gate_e2e_apply_b")?.rejectReasonCode, "weak_evidence");
  assert.equal(storage.getCycle(rejectedChild.id)?.draftStatus, "invalidated");

  await router.route("cb_approve_ancestor", "perm:allow:gate_e2e_apply_a", { chatId: "42", messageId: 10 });
  assert.equal(storage.getCycle(ancestor.id)?.draftStatus, "apply_queued");
  assert.equal(platform.editedCards.at(-1)?.card.buttons?.flat().some((button) => button.callbackData.startsWith("perm:revoke:")), true);

  await router.route("cb_revoke_ancestor", "perm:revoke:gate_e2e_apply_a", { chatId: "42", messageId: 10 });
  assert.equal(storage.getCycle(ancestor.id)?.draftStatus, "ready_awaiting_approval");
  assert.equal(storage.getGate("gate_e2e_apply_a")?.decision, "revoked");

  await router.route("cb_reapprove_ancestor", "perm:allow:gate_e2e_apply_a", { chatId: "42", messageId: 10 });
  const queued = storage.getCycle(ancestor.id);
  assert.equal(queued?.draftStatus, "apply_queued");
  const applied = await runApplyExecutor(projectId, new Date(Date.parse(queued?.applyScheduledAt ?? now()) + 61_000));
  assert.deepEqual(applied.appliedCycleIds, [ancestor.id]);
  assert.equal(storage.getCycle(ancestor.id)?.draftStatus, "applied_observing");

  await router.route("cb_approve_meaning", "perm:allow:gate_e2e_meaning", { chatId: "42", messageId: 10 });
  assert.equal(storage.getGate("gate_e2e_meaning")?.status, "approved");

  storage.createPrediction({
    id: "pred_e2e_failed_assumption",
    cycleId: ancestor.id,
    belief: "ancestor assumption should hold",
    prediction: "activation reaches target",
    action: "observe applied ancestor",
    claims: JSON.stringify([{ id: "claim_e2e", type: "metric_threshold", metric: "activation_rate", operator: ">=", target: 0.8, observed: 0.1 }]),
    observation: "activation_rate=0.1",
    predictionError: 0.82,
    worstClaimError: 0.82,
    errorType: "model",
    updateTarget: "distiller_world_model_update",
    status: "resolved",
    knowledgeRefs: JSON.stringify([]),
  });
  const invalidated = reconcileSpeculativeAssumptions(projectId);
  assert.deepEqual(invalidated.invalidatedCycleIds, [cascadeChild.id]);
  assert.equal(storage.getGate("gate_e2e_apply_c")?.decision, "invalidated_by_system");

  const closed = await processReviewWindowTick(projectId, bus, new Date("2026-06-10T08:01:00.000Z"));
  assert.equal(closed.summarySent, true);
  assert.equal(closed.missedWindowsIncremented, 0);
  assert.match(platform.sentTexts.at(-1)?.text ?? "", /审批窗口已收口/);
});

test("review window summary counts only deferred gates in the open session", async () => {
  const projectId = "proj_review_window_session_scope";
  createProject(projectId);
  storage.createGate({
    id: "gate_e2e_outside_deferred",
    cycleId: `cycle_1_${projectId}`,
    type: "meaning",
    blocking: 0,
    title: "Already deferred outside session",
    payload: JSON.stringify({ createdAt: now(), summary: "older deferred gate" }),
    status: "deferred",
    estimatedMinutes: 4,
    decision: "defer",
    deferUntil: "2026-06-12T00:00:00.000Z",
    version: 1,
  });
  storage.createGate({
    id: "gate_e2e_session_deferred",
    cycleId: `cycle_1_${projectId}`,
    type: "meaning",
    blocking: 0,
    title: "Deferred during session",
    payload: JSON.stringify({ createdAt: now(), summary: "session gate" }),
    status: "pending",
    estimatedMinutes: 4,
    decision: null,
    version: 1,
  });

  const opened = await processReviewWindowTick(projectId, null, new Date("2026-06-11T07:30:00.000Z"));
  assert.equal(opened.openedSessionId?.startsWith("review_proj_review_window_session_scope"), true);
  assert.equal(storage.getOpenReviewSession(projectId)?.gatesTotal, 1);

  new HumanGateService(storage).defer("gate_e2e_session_deferred", "2026-06-12T00:00:00.000Z", {
    actor: "human_test",
    via: "test",
  });

  const closed = await processReviewWindowTick(projectId, null, new Date("2026-06-11T08:01:00.000Z"));
  const session = storage.listReviewSessions(projectId).at(-1);
  assert.equal(closed.summarySent, false);
  assert.equal(session?.closedAt, "2026-06-11T08:01:00.000Z");
  assert.equal(session?.gatesDeferred, 1);
  assert.equal(session?.gatesResolved, 0);
  assert.equal(storage.getGate("gate_e2e_outside_deferred")?.status, "deferred");
});
