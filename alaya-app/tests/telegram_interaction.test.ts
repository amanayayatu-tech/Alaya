import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlayaCard, CallbackHandler, MessageRef, MessagingPlatform, SentMessage } from "../server/notifications/types.ts";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-telegram-interaction-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { gateCard } = await import("../server/notifications/card.ts");
const { NotificationBus } = await import("../server/notifications/bus.ts");
const { CallbackRouter } = await import("../server/notifications/router.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
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

test("gate cards render perm buttons only for non-blocking meaning gates", () => {
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

  const risk = gateCard({
    title: "风险闸",
    body: "needs web review",
    gateId: "gate_risk_1",
    gateType: "risk",
    isBlocking: true,
    actionUrl: "http://localhost:5000/#/human-gates?gate=gate_risk_1",
  });
  assert.deepEqual(risk.buttons?.[0].map((button) => button.callbackData), ["nav:gate:gate_risk_1"]);
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

test("notification emit failures are persisted for observability", async () => {
  createProjectAndCycle("proj_notify_failure", "cycle_notify_failure_1");
  const bus = new NotificationBus(recordNotificationEmitFailure).addAdapter(new FailingPlatform(), ["42"]);
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
