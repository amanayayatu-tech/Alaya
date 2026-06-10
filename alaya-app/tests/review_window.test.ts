import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlayaCard, CallbackHandler, MessageRef, MessagingPlatform, SentMessage } from "../server/notifications/types.ts";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-review-window-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_REVIEW_TIMEZONE = "Asia/Shanghai";
process.env.ALAYA_REVIEW_WINDOWS = "15:30-16:00";
process.env.ALAYA_GATE_ESCALATION_MISSED_WINDOWS = "1";
process.env.ALAYA_IMMEDIATE_RISK_LEVELS = "financial,destructive";

const { storage, now } = await import("../server/storage.ts");
const { NotificationBus } = await import("../server/notifications/bus.ts");
const {
  emitSchedulerNotifications,
  gateBudgetForProject,
  processReviewWindowTick,
} = await import("../server/scheduler.ts");
const { reviewWindowState } = await import("../server/reviewWindow.ts");

class FakePlatform implements MessagingPlatform {
  sentCards: Array<{ chatId: string; card: AlayaCard }> = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  editedCards: Array<{ ref: MessageRef; card: AlayaCard }> = [];
  callbackHandlers: CallbackHandler[] = [];

  name() { return "fake"; }
  async sendText(chatId: string, text: string): Promise<void> { this.sentTexts.push({ chatId, text }); }
  async sendCard(chatId: string, card: AlayaCard): Promise<SentMessage> {
    this.sentCards.push({ chatId, card });
    return { chatId, messageId: this.sentCards.length };
  }
  async editCard(ref: MessageRef, card: AlayaCard): Promise<void> { this.editedCards.push({ ref, card }); }
  async answerCallback(): Promise<void> {}
  onCallbackQuery(handler: CallbackHandler): void { this.callbackHandlers.push(handler); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Review Window ${projectId}`,
    direction: "Batch human review into windows",
    targetUser: "operator",
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
  storage.createCycle({
    id: `cycle_1_${projectId}`,
    projectId,
    idx: 1,
    goal: "review window test",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createGate(projectId: string, id: string, overrides: Record<string, unknown> = {}) {
  return storage.createGate({
    id,
    cycleId: `cycle_1_${projectId}`,
    type: "direction",
    blocking: 1,
    title: `Gate ${id}`,
    payload: JSON.stringify({ createdAt: now(), summary: "batch review gate", ...overrides }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });
}

test("review window state uses configured timezone and window label", () => {
  const state = reviewWindowState(new Date("2026-06-10T07:31:00.000Z"));
  assert.equal(state.inWindow, true);
  assert.equal(state.windowDate, "2026-06-10");
  assert.equal(state.windowLabel, "15:30-16:00");
});

test("review window digest is idempotent and closing increments missed windows", async () => {
  const projectId = "proj_review_window_digest";
  createProject(projectId);
  createGate(projectId, "gate_review_window_pending");

  const platform = new FakePlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);
  const opened = await processReviewWindowTick(projectId, bus, new Date("2026-06-10T07:31:00.000Z"));
  assert.equal(opened.digestSent, true);
  assert.equal(opened.openedSessionId?.startsWith("review_proj_review_window_digest_2026_06_10_15_30_16_00"), true);
  assert.equal(platform.sentCards.length, 1);
  assert.match(platform.sentCards[0].card.title?.text ?? "", /审批窗口已开启/);
  assert.equal(storage.getNotificationDigest(projectId, "2026-06-10", "15:30-16:00")?.sentAt, "2026-06-10T07:31:00.000Z");
  assert.equal(storage.getGate("gate_review_window_pending")?.evidenceRevalidatedAt, "2026-06-10T07:31:00.000Z");

  const duplicate = await processReviewWindowTick(projectId, bus, new Date("2026-06-10T07:40:00.000Z"));
  assert.equal(duplicate.digestSent, false);
  assert.equal(platform.sentCards.length, 1);

  const closed = await processReviewWindowTick(projectId, bus, new Date("2026-06-10T08:01:00.000Z"));
  assert.equal(closed.missedWindowsIncremented, 1);
  assert.equal(closed.summarySent, true);
  assert.equal(storage.getGate("gate_review_window_pending")?.missedWindows, 1);
  assert.equal(gateBudgetForProject(projectId).safetyMode, true);
  assert.equal(platform.sentTexts.length, 1);
  assert.match(platform.sentTexts[0].text, /审批窗口已收口/);
});

test("scheduler notifications send immediate gates but queue next-window gates", async () => {
  const projectId = "proj_review_window_immediate";
  createProject(projectId);
  createGate(projectId, "gate_review_window_next");
  storage.createGate({
    id: "gate_review_window_immediate",
    cycleId: `cycle_1_${projectId}`,
    type: "risk",
    blocking: 1,
    title: "Financial risk gate",
    payload: JSON.stringify({ createdAt: now(), summary: "financial risk", riskLevel: "financial" }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  assert.equal(storage.getGate("gate_review_window_next")?.notifyPolicy, "next_window");
  assert.equal(storage.getGate("gate_review_window_immediate")?.notifyPolicy, "immediate");

  const platform = new FakePlatform();
  const bus = new NotificationBus().addAdapter(platform, ["42"]);
  emitSchedulerNotifications(bus, new Set(), {
    projectId,
    action: "waiting_blocking_gate",
    cycleId: `cycle_1_${projectId}`,
    budget: gateBudgetForProject(projectId),
    note: "test",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(platform.sentCards.length, 1);
  assert.match(platform.sentCards[0].card.body, /financial risk/);
});
