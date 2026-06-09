import { storage, now } from "../storage";
import { recordTrace } from "../trace";
import { HumanGateService } from "../humanGateService";
import type { HumanGateItem } from "@shared/schema";
import { NotificationBus, type NotificationEmitFailure } from "../notifications/bus";
import { formatGateDecisionReceiptText, knowledgeIdForMeaningGate } from "../notifications/gateNarrative";
import { CallbackRouter } from "../notifications/router";
import { TelegramAdapter } from "../notifications/telegram";
import type { SchedulerTickResult } from "./types";

function parsePayload(payload: string): Record<string, any> {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

let notificationBus: NotificationBus | null = null;
let notificationBusStarted = false;
let notificationResolvedReceiptsReconciled = false;

interface TelegramNotificationConfig {
  token: string;
  chatId: string;
  baseUrl: string;
}

function externalNotificationRequested(): boolean {
  const raw = process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "dry_run" || raw === "dry-run" || raw === "audit";
}

function telegramNotificationConfig(): TelegramNotificationConfig | null {
  if (!externalNotificationRequested()) return null;
  const provider = process.env.ALAYA_NOTIFICATION_PROVIDER?.trim().toLowerCase() || "telegram";
  if (provider !== "telegram") return null;
  const token = process.env.ALAYA_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.ALAYA_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return {
    token,
    chatId,
    baseUrl: process.env.ALAYA_BASE_URL?.trim() || "http://localhost:5000",
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function gateWebUrl(baseUrl: string, projectId?: string, gateId?: string): string {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (gateId) params.set("gate", gateId);
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return `${trimTrailingSlash(baseUrl)}/#/human-gates${suffix}`;
}

export function notificationBaseUrl(): string {
  return telegramNotificationConfig()?.baseUrl ?? process.env.ALAYA_BASE_URL?.trim() ?? "http://localhost:5000";
}

export function pendingGateIds(projectId: string): Set<string> {
  return new Set(
    storage
      .listGates(projectId)
      .filter((gate) => gate.status === "pending")
      .map((gate) => gate.id),
  );
}

function gateNotificationTitle(gate: HumanGateItem): string {
  if (gate.type === "direction") return "方向闸待处理";
  if (gate.type === "meaning") return "意义闸待处理";
  if (gate.type === "risk") return "风险闸待处理";
  return "人工闸门待处理";
}

function gateNotificationBody(gate: HumanGateItem): string {
  const payload = parsePayload(gate.payload);
  const candidates = [
    payload.summary,
    payload.reason,
    payload.requiredAction,
    payload.auditSummary?.whyNow,
    gate.title,
  ];
  const body = candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() ?? "";
  return body.length > 100 ? `${body.slice(0, 100)}...` : body;
}

function gateNotificationMeta(gate: HumanGateItem): Record<string, string> {
  const payload = parsePayload(gate.payload);
  const meta: Record<string, string> = { cycleId: gate.cycleId };
  if (typeof payload.riskKey === "string" && payload.riskKey.trim()) meta.riskKey = payload.riskKey.trim();
  if (typeof payload.reviewId === "string" && payload.reviewId.trim()) meta.reviewId = payload.reviewId.trim();
  return meta;
}

function buildSafetyModeBody(result: SchedulerTickResult): string {
  const cycle = result.cycleId ? storage.getCycle(result.cycleId) : undefined;
  const cycleLine = cycle
    ? `Cycle #${cycle.idx} 已暂停，请前往 Web UI 检查。`
    : "自动推进已暂停，请前往 Web UI 检查。";
  return `项目：${result.projectId}\n原因：${result.note}\n${cycleLine}`;
}

function cycleForNotificationFailure(failure: NotificationEmitFailure) {
  const event = failure.event;
  if (event.type === "gate_opened" && event.gateId) {
    const gate = storage.getGate(event.gateId);
    if (gate) return storage.getCycle(gate.cycleId);
  }
  const cycleId = event.meta?.cycleId || (event.type === "safety_mode" ? event.gateId : undefined);
  if (cycleId) return storage.getCycle(cycleId);
  return storage.listCycles(event.projectId).at(-1);
}

export function recordNotificationEmitFailure(failure: NotificationEmitFailure): void {
  const cycle = cycleForNotificationFailure(failure);
  const error = failure.error instanceof Error ? failure.error.message : String(failure.error);
  const payload = {
    projectId: failure.event.projectId,
    cycleId: cycle?.id ?? failure.event.meta?.cycleId ?? null,
    eventType: failure.event.type,
    gateId: failure.event.gateId ?? null,
    adapter: failure.adapter,
    chatId: failure.chatId,
    title: failure.event.title,
    error,
    ts: now(),
  };
  storage.recordEvent({
    cycleIdx: cycle?.idx ?? 0,
    actor: "notification_bus",
    tableName: "notifications",
    op: "emit_failed",
    before: null,
    after: JSON.stringify(payload),
    ts: now(),
  });
  recordTrace({
    projectId: failure.event.projectId,
    cycleId: cycle?.id ?? failure.event.meta?.cycleId ?? null,
    cycleIdx: cycle?.idx ?? null,
    kind: "notification",
    name: "notification_emit_failed",
    agent: "notification_bus",
    status: "error",
    attributes: payload,
  });
}

export async function getNotificationBus(): Promise<NotificationBus | null> {
  const config = telegramNotificationConfig();
  if (!config) return null;
  try {
    if (!notificationBus) {
      const adapter = new TelegramAdapter(config.token, config.chatId);
      const gateService = new HumanGateService(storage);
      const router = new CallbackRouter(adapter, storage, gateService, config.baseUrl);
      adapter.onCallbackQuery((callbackId, data, ref) => router.route(callbackId, data, ref));
      notificationBus = new NotificationBus(recordNotificationEmitFailure, {
        shouldSend: (event) => {
          if (event.type !== "gate_opened" || !event.gateId) return true;
          return storage.getGate(event.gateId)?.status === "pending";
        },
      }).addAdapter(adapter, [config.chatId]);
    }
    if (!notificationBusStarted) {
      notificationBusStarted = true;
      await notificationBus.start();
    }
    if (!notificationResolvedReceiptsReconciled) {
      notificationResolvedReceiptsReconciled = true;
      await reconcilePersistedResolvedGateReceipts(notificationBus, config.baseUrl);
    }
    return notificationBus;
  } catch (error) {
    console.error("[scheduler] notification bus unavailable:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function reconcilePersistedResolvedGateReceipts(bus: NotificationBus, baseUrl: string): Promise<void> {
  for (const gateId of bus.knownGateIds()) {
    const gate = storage.getGate(gateId);
    if (!gate || gate.status === "pending") continue;
    const cycle = storage.getCycle(gate.cycleId);
    const projectId = cycle?.projectId ?? "system";
    const action = gate.status === "rejected" ? "reject" : "approve";
    const label = action === "approve" ? "已批准" : "已否决";
    const pendingGatesAfter = storage.listGates(projectId).filter((item) => item.status === "pending").length;
    const openConflictReviewsAfter = storage
      .listKnowledgeReviews(projectId)
      .filter((review) => review.reviewType === "conflict" && review.status === "review_required")
      .length;
    await bus.emit({
      type: "gate_resolved",
      projectId,
      title: `${label} — ${gate.title}`,
      body: formatGateDecisionReceiptText(gate, {
        action,
        via: "startup notification reconciliation",
        decidedAt: new Date(),
        pendingGatesAfter,
        openConflictReviewsAfter,
        knowledgeId: action === "approve" && gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null,
        projectId,
        rationale: "App startup reconciled a persisted Telegram gate card whose backend gate was already resolved.",
      }),
      gateId: gate.id,
      gateType: gate.type as "direction" | "meaning" | "risk",
      isBlocking: gate.blocking === 1,
      actionUrl: gateWebUrl(baseUrl, projectId, gate.id),
      meta: { source: "startup_resolved_gate_reconciliation" },
    });
  }
}

export function emitSchedulerNotifications(
  bus: NotificationBus,
  _beforePendingGateIds: Set<string>,
  result: SchedulerTickResult,
): void {
  for (const gate of storage.listGates(result.projectId)) {
    if (gate.status !== "pending") continue;
    void bus.emit({
      type: "gate_opened",
      projectId: result.projectId,
      title: `${gateNotificationTitle(gate)} — ${result.projectId}`,
      body: gateNotificationBody(gate),
      gateId: gate.id,
      gateType: gate.type as "direction" | "meaning" | "risk",
      isBlocking: gate.blocking === 1,
      actionUrl: gateWebUrl(notificationBaseUrl(), result.projectId, gate.id),
      meta: gateNotificationMeta(gate),
    });
  }

  if (result.action !== "safety_mode") return;
  void bus.emit({
    type: "safety_mode",
    projectId: result.projectId,
    title: "Safety Mode 已触发",
    body: buildSafetyModeBody(result),
    gateId: result.cycleId,
    actionUrl: gateWebUrl(notificationBaseUrl(), result.projectId),
    meta: result.cycleId ? { cycleId: result.cycleId } : undefined,
  });
}
