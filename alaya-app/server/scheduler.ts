import { storage, now } from "./storage";
import { buildNextGoalInput, resolveCycleStimulus, runOrchestrator, runOperationalStagesAfterApprovedDirection, scenarioForCycle } from "./flywheel";
import { generateNextGoal, type NextGoalDraft } from "./autonomousGoal";
import { evaluateAutonomousStopRisk } from "./stallGuard";
import { syncConfiguredFeedbackForProject } from "./externalFeedback";
import type { ExternalFeedbackSyncResult, SyncGithubIssuesOptions } from "./externalFeedback";
import { applyTimeDecay } from "@shared/core/update_confidence.js";
import { recordTrace } from "./trace";
import { observeSchedulerCycle } from "./observability/metrics";
import { HumanGateService } from "./humanGateService";
import { createKnowledgeReviewReminders, detectKnowledgeConflicts } from "./knowledgeReview";
import { NotificationBus, type NotificationEmitFailure } from "./notifications/bus";
import { CallbackRouter } from "./notifications/router";
import { TelegramAdapter } from "./notifications/telegram";
import { claimSchema, type HumanGateItem, type KnowledgeItem, type Task } from "@shared/schema";

export interface GateBudgetState {
  budget: number;
  used: number;
  remaining: number;
  pendingEstimatedMinutes: number;
  pendingOverBudget2x: boolean;
  weeklyOverFiveHours: boolean;
  pendingBlocking: number;
  pendingNonBlocking: number;
  oldestBlockingAgeDays: number;
  safetyMode: boolean;
}

export interface LlmBudgetState {
  budgetCents: number;
  usedCents: number;
  remainingCents: number;
  usedUsd: number;
  budgetUsd: number;
  weeklyWindowStart: string;
  overBudget: boolean;
  pendingBudgetGate: boolean;
  acknowledgedThisWeek: boolean;
}

export interface SchedulerTickResult {
  projectId: string;
  action:
    | "no_cycle"
    | "opened_direction_gate"
    | "waiting_blocking_gate"
    | "waiting_feedback_window"
    | "ran_operational_stages"
    | "created_next_cycle"
    | "safety_mode"
    | "skipped";
  cycleId?: string;
  nextCycleId?: string;
  budget: GateBudgetState;
  llmBudget?: LlmBudgetState;
  note: string;
}

export interface SchedulerTickOptions {
  feedbackSync?: SyncGithubIssuesOptions;
}

const runningProjectTicks = new Set<string>();
let notificationBus: NotificationBus | null = null;
let notificationBusStarted = false;

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

function gateWebUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/#/human-gates`;
}

function notificationBaseUrl(): string {
  return telegramNotificationConfig()?.baseUrl ?? process.env.ALAYA_BASE_URL?.trim() ?? "http://localhost:5000";
}

function pendingGateIds(projectId: string): Set<string> {
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

async function getNotificationBus(): Promise<NotificationBus | null> {
  const config = telegramNotificationConfig();
  if (!config) return null;
  try {
    if (!notificationBus) {
      const adapter = new TelegramAdapter(config.token, config.chatId);
      const gateService = new HumanGateService(storage);
      const router = new CallbackRouter(adapter, storage, gateService, config.baseUrl);
      adapter.onCallbackQuery((callbackId, data, ref) => router.route(callbackId, data, ref));
      notificationBus = new NotificationBus(recordNotificationEmitFailure).addAdapter(adapter, [config.chatId]);
    }
    if (!notificationBusStarted) {
      notificationBusStarted = true;
      await notificationBus.start();
    }
    return notificationBus;
  } catch (error) {
    console.error("[scheduler] notification bus unavailable:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

function emitSchedulerNotifications(
  bus: NotificationBus,
  beforePendingGateIds: Set<string>,
  result: SchedulerTickResult,
): void {
  for (const gate of storage.listGates(result.projectId)) {
    if (gate.status !== "pending") continue;
    if (beforePendingGateIds.has(gate.id)) continue;
    void bus.emit({
      type: "gate_opened",
      projectId: result.projectId,
      title: `${gateNotificationTitle(gate)} — ${result.projectId}`,
      body: gateNotificationBody(gate),
      gateId: gate.id,
      gateType: gate.type as "direction" | "meaning" | "risk",
      isBlocking: gate.blocking === 1,
      actionUrl: `${gateWebUrl(notificationBaseUrl())}?gate=${encodeURIComponent(gate.id)}`,
    });
  }

  if (result.action !== "safety_mode") return;
  void bus.emit({
    type: "safety_mode",
    projectId: result.projectId,
    title: "Safety Mode 已触发",
    body: buildSafetyModeBody(result),
    gateId: result.cycleId,
    actionUrl: gateWebUrl(notificationBaseUrl()),
    meta: result.cycleId ? { cycleId: result.cycleId } : undefined,
  });
}

function parsePayload(payload: string): Record<string, any> {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function ageDays(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

function weekStartIso(d = new Date()): string {
  const start = new Date(d);
  const day = start.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + diff);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

function parseEventAfter(after: string | null): Record<string, any> {
  if (!after) return {};
  try {
    const parsed = JSON.parse(after);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function knowledgeEvidence(item: KnowledgeItem): number {
  return Math.max(0, (item.evidenceAlpha - 1) + (item.evidenceBeta - 1));
}

function confidenceLevelFor(item: KnowledgeItem, score: number): KnowledgeItem["confidenceLevel"] {
  const ev = knowledgeEvidence(item);
  if (score >= 0.85 && ev >= 5 && item.humanApprovedCount > 0) return "verified";
  if (score >= 0.75 && ev >= 3) return "high";
  if (score >= 0.6 && ev >= 1) return "medium";
  return "low";
}

function lastVerifiedAtMs(item: KnowledgeItem, currentTime: number): number {
  if (typeof item.lastVerifiedAt === "number" && Number.isFinite(item.lastVerifiedAt)) return item.lastVerifiedAt;
  const validFromMs = Date.parse(item.validFrom);
  return Number.isFinite(validFromMs) ? validFromMs : currentTime;
}

function decayAnchorAtMs(item: KnowledgeItem, currentTime: number): number {
  const anchors = [
    item.lastDecayedAt,
    lastVerifiedAtMs(item, currentTime),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (anchors.length === 0) return currentTime;
  return Math.max(...anchors);
}

function validityExpired(item: KnowledgeItem, currentTime: number): boolean {
  if (!item.validUntil) return false;
  const validUntilMs = Date.parse(item.validUntil);
  return Number.isFinite(validUntilMs) && validUntilMs < currentTime;
}

export function decayStaleKnowledge(projectId: string, currentTime = Date.now(), lambda = 0.03) {
  const eligible = storage.listKnowledge(projectId).filter((item) => (
    !item.supersededBy &&
    !validityExpired(item, currentTime) &&
    !["quarantined", "expired", "conflict"].includes(item.status)
  ));
  let decayed = 0;
  let demoted = 0;

  for (const item of eligible) {
    const result = applyTimeDecay({
      score: item.confidenceScore,
      lastVerifiedAt: decayAnchorAtMs(item, currentTime),
      storageStrength: item.storageStrength ?? 1,
    }, currentTime, lambda);
    if (result.daysSinceLastVerified === 0) continue;

    const nextStatus = result.shouldDemoteToStale && item.status !== "stale" ? "stale" : item.status;
    const scoreChanged = Math.abs(result.newScore - item.confidenceScore) > 1e-9;
    const storageChanged = Math.abs(result.newStorageStrength - (item.storageStrength ?? 1)) > 1e-9;
    const statusChanged = nextStatus !== item.status;
    if (!scoreChanged && !storageChanged && !statusChanged) continue;

    storage.updateKnowledge(item.id, {
      confidenceScore: result.newScore,
      confidenceLevel: confidenceLevelFor(item, result.newScore),
      storageStrength: result.newStorageStrength,
      lastDecayedAt: currentTime,
      status: nextStatus,
      actor: "time_decay_scheduler",
    });
    const cycle = storage.listCycles(projectId).at(-1);
    recordTrace({
      projectId,
      cycleId: cycle?.id ?? null,
      cycleIdx: cycle?.idx ?? null,
      kind: "principle_transition",
      name: "knowledge_time_decay",
      agent: "time_decay_scheduler",
      attributes: {
        knowledgeId: item.id,
        from: item.status,
        to: nextStatus,
        oldScore: item.confidenceScore,
        newScore: result.newScore,
        oldStorageStrength: item.storageStrength ?? 1,
        newStorageStrength: result.newStorageStrength,
        daysSinceLastVerified: result.daysSinceLastVerified,
      },
    });
    decayed += 1;
    if (statusChanged) demoted += 1;
  }

  return { evaluated: eligible.length, decayed, demoted };
}

function gateResolvedAt(gate: HumanGateItem): string | null {
  const payload = parsePayload(gate.payload);
  if (typeof payload.resolvedAt === "string") return payload.resolvedAt;

  const event = storage.listEvents().find((e) => {
    if (e.tableName !== "human_gate_items" || e.op !== "update") return false;
    const after = parseEventAfter(e.after);
    return after.id === gate.id && after.status && after.status !== "pending";
  });
  if (event) return event.ts;

  const decision = storage.listDecisions().filter((d) => d.cycleId === gate.cycleId && d.gateType === gate.type).at(-1);
  return decision?.ts ?? null;
}

function gateTopicKey(gate: HumanGateItem): string {
  const payload = parsePayload(gate.payload);
  return String(payload.topicKey ?? gate.title);
}

function consumesHumanMinutes(gate: HumanGateItem): boolean {
  if (gate.status === "pending") return false;
  const decision = gate.decision ?? "";
  if (decision.startsWith("merged_into:")) return false;
  if (decision.startsWith("auto_approved_repeated_meaning:")) return false;
  return true;
}

export function gateBudgetForProject(projectId: string): GateBudgetState {
  const project = storage.getProject(projectId);
  const budget = project?.weeklyHumanMinutes ?? 150;
  const gates = storage.listGates(projectId);
  const weekStartMs = Date.parse(weekStartIso());
  const used = gates
    .filter(consumesHumanMinutes)
    .filter((g) => {
      const resolvedAt = Date.parse(gateResolvedAt(g) ?? "");
      return Number.isFinite(resolvedAt) && resolvedAt >= weekStartMs;
    })
    .reduce((s, g) => s + g.estimatedMinutes, 0);
  const pendingBlocking = gates.filter((g) => g.status === "pending" && g.blocking === 1);
  const pendingNonBlocking = gates.filter((g) => g.status === "pending" && g.blocking === 0);
  const pendingEstimatedMinutes = [...pendingBlocking, ...pendingNonBlocking].reduce((sum, gate) => sum + gate.estimatedMinutes, 0);
  const oldestBlockingAgeDays = pendingBlocking.reduce((max, g) => {
    const createdAt = parsePayload(g.payload).createdAt as string | undefined;
    return Math.max(max, ageDays(createdAt));
  }, 0);
  return {
    budget,
    used,
    remaining: Math.max(0, budget - used),
    pendingEstimatedMinutes,
    pendingOverBudget2x: pendingEstimatedMinutes > budget * 2,
    weeklyOverFiveHours: used > 300,
    pendingBlocking: pendingBlocking.length,
    pendingNonBlocking: pendingNonBlocking.length,
    oldestBlockingAgeDays,
    safetyMode: pendingBlocking.length > 3 || oldestBlockingAgeDays > 5,
  };
}

function findHumanAttentionGate(projectId: string, weeklyWindowStart: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "human_attention_overload" && payload.weeklyWindowStart === weeklyWindowStart;
  });
}

function enforceHumanAttentionBudget(projectId: string, state: GateBudgetState) {
  const weeklyWindowStart = weekStartIso();
  const overloaded = state.pendingOverBudget2x || state.weeklyOverFiveHours;
  if (!overloaded) return { safetyMode: false, state };

  const currentCycle = storage.listCycles(projectId).find((cycle) => cycle.status !== "closed")
    ?? storage.listCycles(projectId).at(-1);
  const existing = findHumanAttentionGate(projectId, weeklyWindowStart);
  if (existing) return { safetyMode: existing.status === "pending", state };

  storage.createGate({
    id: `gate_human_attention_${weeklyWindowStart.slice(0, 10).replace(/-/g, "")}_${projectId.slice(-4)}`,
    cycleId: currentCycle?.id ?? `cycle_attention_${projectId.slice(-4)}`,
    type: "risk",
    blocking: 1,
    title: "人类注意力过载",
    payload: JSON.stringify({
      riskKey: "human_attention_overload",
      weeklyWindowStart,
      budgetMinutes: state.budget,
      usedMinutes: state.used,
      pendingEstimatedMinutes: state.pendingEstimatedMinutes,
      pendingOverBudget2x: state.pendingOverBudget2x,
      weeklyOverFiveHours: state.weeklyOverFiveHours,
      createdAt: now(),
      reason: "pending_human 或本周人工投入已超过可持续阈值，自动推进已暂停。",
      requiredAction: "合并/关闭低价值闸门、降低非阻塞意义闸频率、提高预算，或进入低速模式只做反馈收集和知识整理。",
    }),
    status: "pending",
    estimatedMinutes: 15,
    decision: null,
    version: 1,
  });
  return { safetyMode: true, state };
}

function findLlmBudgetGate(projectId: string, weeklyWindowStart: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "llm_weekly_budget" && payload.weeklyWindowStart === weeklyWindowStart;
  });
}

export function llmBudgetForProject(projectId: string): LlmBudgetState {
  const project = storage.getProject(projectId);
  const budgetCents = Math.max(0, project?.weeklyLlmBudgetCents ?? 100);
  const budgetUsd = budgetCents / 100;
  const weeklyWindowStart = weekStartIso();
  const startMs = Date.parse(weeklyWindowStart);
  const cycleIds = new Set(storage.listCycles(projectId).map((cycle) => cycle.id));
  const usedUsd = storage.listLlmCalls()
    .filter((call) => cycleIds.has(call.cycleId))
    .filter((call) => {
      const ts = Date.parse(call.ts);
      return Number.isFinite(ts) && ts >= startMs;
    })
    .reduce((sum, call) => sum + call.estimatedCost, 0);
  const existingGate = findLlmBudgetGate(projectId, weeklyWindowStart);
  const pendingBudgetGate = existingGate?.status === "pending";
  return {
    budgetCents,
    usedCents: Math.round(usedUsd * 100),
    remainingCents: Math.max(0, Math.round((budgetUsd - usedUsd) * 100)),
    usedUsd: +usedUsd.toFixed(6),
    budgetUsd: +budgetUsd.toFixed(2),
    weeklyWindowStart,
    overBudget: usedUsd > budgetUsd,
    pendingBudgetGate,
    acknowledgedThisWeek: !!existingGate && existingGate.status !== "pending",
  };
}

function enforceLlmBudget(projectId: string, cycleId: string): LlmBudgetState {
  let state = llmBudgetForProject(projectId);
  if (!state.overBudget || state.pendingBudgetGate || state.acknowledgedThisWeek) return state;

  const cycle = storage.getCycle(cycleId);
  const idSuffix = state.weeklyWindowStart.slice(0, 10).replace(/-/g, "");
  storage.createGate({
    id: `gate_llm_budget_${idSuffix}_${projectId.slice(-4)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "LLM 成本预算闸",
    payload: JSON.stringify({
      riskKey: "llm_weekly_budget",
      weeklyWindowStart: state.weeklyWindowStart,
      budgetCents: state.budgetCents,
      budgetUsd: state.budgetUsd,
      usedCents: state.usedCents,
      usedUsd: state.usedUsd,
      createdAt: now(),
      currentCycleIdx: cycle?.idx ?? 0,
      reason: "LLM 成本超过项目每周预算，自动推进已暂停。",
      requiredAction: "人工确认继续本周预算、提高预算，或暂停高成本 Agent 调用。",
    }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  state = llmBudgetForProject(projectId);
  return state;
}

function knowledgeRefsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return knowledgeRefsFrom(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function influenceTextExplainsCompounding(text: string): boolean {
  return /改变|影响|基于|引用|迁移|复用|回滚|审计|可追责|changed|informed|based|because|reuse|rollback|audit|traceable|compound/i.test(text);
}

function findFlywheelEmptyLearningGate(projectId: string, cycleId: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "flywheel_empty_learning";
  });
}

function compoundingEvidenceForDirection(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  if (!cycle || cycle.idx < 4) return { required: false, ok: true, refs: [] as string[], text: "", previousCycleIdxs: [] as number[] };

  const previousClosed = storage.listCycles(projectId)
    .filter((item) => item.idx < cycle.idx && item.status === "closed")
    .sort((a, b) => b.idx - a.idx)
    .slice(0, 3)
    .sort((a, b) => a.idx - b.idx);
  if (previousClosed.length < 3) return { required: false, ok: true, refs: [] as string[], text: "", previousCycleIdxs: previousClosed.map((item) => item.idx) };

  const directionGate = storage.listGates(projectId).find((gate) => gate.cycleId === cycleId && gate.type === "direction");
  const payload = directionGate ? parsePayload(directionGate.payload) : {};
  const agentRun = storage.listAgentRuns(cycleId).find((run) => run.agent === "orchestrator");
  const refs = [
    ...knowledgeRefsFrom(payload.knowledgeRefs),
    ...knowledgeRefsFrom(agentRun?.knowledgeRefsUsed),
  ];
  const uniqueRefs = Array.from(new Set(refs));
  const text = [
    payload.reasoning,
    payload.auditSummary?.whyNow,
    payload.auditSummary?.deltaFromCycle3,
    cycle.reasoning,
    agentRun?.outputSummary,
  ].filter((item) => typeof item === "string" && item.trim().length > 0).join("\n");

  return {
    required: true,
    ok: uniqueRefs.length > 0 && influenceTextExplainsCompounding(text),
    refs: uniqueRefs,
    text,
    previousCycleIdxs: previousClosed.map((item) => item.idx),
  };
}

function enforceFlywheelCompoundingGuard(projectId: string, cycleId: string) {
  const evidence = compoundingEvidenceForDirection(projectId, cycleId);
  if (!evidence.required || evidence.ok) return { safetyMode: false, evidence };

  const existing = findFlywheelEmptyLearningGate(projectId, cycleId);
  if (existing) return { safetyMode: existing.status === "pending", evidence };
  {
    const cycle = storage.getCycle(cycleId);
    storage.createGate({
      id: `gate_flywheel_empty_${cycle?.idx ?? 0}_${projectId.slice(-4)}`,
      cycleId,
      type: "risk",
      blocking: 1,
      title: "飞轮空转风险闸",
      payload: JSON.stringify({
        riskKey: "flywheel_empty_learning",
        createdAt: now(),
        evaluatedCycleIdx: cycle?.idx ?? 0,
        previousCycleIdxs: evidence.previousCycleIdxs,
        knowledgeRefsCount: evidence.refs.length,
        influenceTextSnippet: evidence.text.slice(0, 500),
        reason: "连续 3 轮后，新一轮建议没有证明前轮知识如何改变本轮决策，自动推进已暂停。",
        requiredAction: "人工复核 Orchestrator reasoning、补充有效知识引用，或回滚到世界模型/知识沉淀算法修正。",
      }),
      status: "pending",
      estimatedMinutes: 12,
      decision: null,
      version: 1,
    });
  }
  return { safetyMode: true, evidence };
}

function parseClaims(value: string): Array<Record<string, any>> {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyContractValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return false;
}

function isMeasurableClaim(claim: Record<string, any>): boolean {
  const parsed = claimSchema.safeParse(claim);
  if (!parsed.success) return false;
  if (parsed.data.type === "metric_threshold") {
    return (
      parsed.data.metric.trim().length > 0 &&
      finiteNumber(parsed.data.target) &&
      finiteNumber(parsed.data.observed)
    );
  }
  if (parsed.data.type === "binary" || parsed.data.type === "categorical") {
    return parsed.data.expected.length > 0 && parsed.data.actual != null;
  }
  if (parsed.data.type === "directional") {
    return parsed.data.actualDirection != null;
  }
  return false;
}

function hasMeasurableClaim(claims: Array<Record<string, any>>): boolean {
  return claims.some(isMeasurableClaim);
}

function missingPredictionContractFields(claim: Record<string, any>): string[] {
  const missing: string[] = [];
  if (!nonEmptyContractValue(claim.expectedObservation)) missing.push("expected_observation");
  if (!nonEmptyContractValue(claim.timeWindow)) missing.push("time_window");
  if (!nonEmptyContractValue(claim.successThreshold)) missing.push("success_threshold");
  if (!nonEmptyContractValue(claim.failureThreshold)) missing.push("failure_threshold");
  if (!finiteNumber(claim.uncertainty) || claim.uncertainty < 0 || claim.uncertainty > 1) {
    missing.push("uncertainty");
  }
  return missing;
}

function hasCompletePredictionContract(claims: Array<Record<string, any>>): boolean {
  return claims.some((claim) => isMeasurableClaim(claim) && missingPredictionContractFields(claim).length === 0);
}

function findPredictionMeasurabilityGate(projectId: string, cycleId: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "prediction_measurability_failure";
  });
}

function predictionMeasurabilityForCycle(cycleId: string) {
  const predictions = storage.listPredictions(cycleId);
  const failures = predictions.flatMap((prediction) => {
    const claims = parseClaims(prediction.claims);
    const measurableClaims = claims.filter(isMeasurableClaim);
    const reasons: string[] = [];
    if (claims.length === 0) reasons.push("missing_claims");
    if (claims.some((claim) => claim.type === "qualitative") && !hasMeasurableClaim(claims)) reasons.push("qualitative_only");
    if (!hasMeasurableClaim(claims)) reasons.push("no_measurable_claim");
    if (measurableClaims.length > 0 && !hasCompletePredictionContract(claims)) reasons.push("missing_prediction_contract");
    if (!prediction.observation) reasons.push("missing_observation");
    if (!finiteNumber(prediction.predictionError)) reasons.push("missing_prediction_error");
    const contractMissing = measurableClaims.map((claim) => ({
      claimId: typeof claim.id === "string" ? claim.id : "(claim)",
      missing: missingPredictionContractFields(claim),
    })).filter((item) => item.missing.length > 0);
    return reasons.length ? [{
      predictionId: prediction.id,
      reasons: Array.from(new Set(reasons)),
      claimTypes: claims.map((claim) => claim.type).filter(Boolean),
      contractMissing,
    }] : [];
  });

  if (predictions.length === 0) {
    failures.push({ predictionId: "(cycle)", reasons: ["missing_prediction"], claimTypes: [], contractMissing: [] });
  }
  return {
    ok: failures.length === 0,
    predictionCount: predictions.length,
    failures,
  };
}

function enforcePredictionMeasurabilityGuard(projectId: string, cycleId: string) {
  const state = predictionMeasurabilityForCycle(cycleId);
  if (state.ok) return { safetyMode: false, state };

  const existing = findPredictionMeasurabilityGate(projectId, cycleId);
  if (existing) return { safetyMode: existing.status === "pending", state };

  const cycle = storage.getCycle(cycleId);
  storage.createGate({
    id: `gate_prediction_measurable_${cycle?.idx ?? 0}_${projectId.slice(-4)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "预测可测量性失败",
    payload: JSON.stringify({
      riskKey: "prediction_measurability_failure",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      predictionCount: state.predictionCount,
      failures: state.failures,
      reason: "本轮 prediction 无法形成可计算的 prediction_error，不能作为下一轮学习信号。",
      requiredAction: "把自然语言预测拆成 measurable claim，并补齐 expected_observation、time_window、success_threshold、failure_threshold、uncertainty、observation 和 prediction_error；qualitative 判断应进入 meaning gate 或人工裁定。",
    }),
    status: "pending",
    estimatedMinutes: 12,
    decision: null,
    version: 1,
  });
  return { safetyMode: true, state };
}

function findKnowledgeMaturityGate(projectId: string, cycleId: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "knowledge_maturity_stagnation";
  });
}

function knowledgeMaturityForProject(projectId: string) {
  const closedCycles = storage.listCycles(projectId)
    .filter((cycle) => cycle.status === "closed")
    .sort((a, b) => a.idx - b.idx);
  if (closedCycles.length < 4) {
    return {
      required: false,
      ok: true,
      closedCycleCount: closedCycles.length,
      activeCount: 0,
      strongCount: 0,
      recentActiveCount: 0,
      recentStrongCount: 0,
      strongShare: 0,
      evaluatedCycleIdxs: closedCycles.map((cycle) => cycle.idx),
    };
  }

  const recentCycleIdxs = closedCycles.slice(-3).map((cycle) => cycle.idx);
  const recentMinIdx = Math.min(...recentCycleIdxs);
  const knowledge = storage.listKnowledge(projectId);
  const active = knowledge.filter((item) => item.status === "active");
  const strong = knowledge.filter((item) => item.status === "strong");
  const recentActive = active.filter((item) => item.createdByCycle >= recentMinIdx || item.lastValidatedCycle >= recentMinIdx);
  const recentStrong = strong.filter((item) => item.createdByCycle >= recentMinIdx || item.lastValidatedCycle >= recentMinIdx);
  const strongShare = strong.length / Math.max(1, active.length + strong.length);
  const activeStillGrowing = recentActive.length >= 3;
  const noStrongMaturation = active.length >= 6 && strong.length === 0;
  const nearNoStrongMaturation = active.length >= 10 && strong.length <= 1 && recentStrong.length === 0 && strongShare < 0.15;

  return {
    required: true,
    ok: !(activeStillGrowing && (noStrongMaturation || nearNoStrongMaturation)),
    closedCycleCount: closedCycles.length,
    activeCount: active.length,
    strongCount: strong.length,
    recentActiveCount: recentActive.length,
    recentStrongCount: recentStrong.length,
    strongShare: +strongShare.toFixed(3),
    evaluatedCycleIdxs: recentCycleIdxs,
  };
}

function enforceKnowledgeMaturityGuard(projectId: string, cycleId: string) {
  const state = knowledgeMaturityForProject(projectId);
  if (!state.required || state.ok) return { safetyMode: false, state };

  const existing = findKnowledgeMaturityGate(projectId, cycleId);
  if (existing) return { safetyMode: existing.status === "pending", state };

  const cycle = storage.getCycle(cycleId);
  storage.createGate({
    id: `gate_knowledge_maturity_${cycle?.idx ?? 0}_${projectId.slice(-4)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "知识成熟停滞",
    payload: JSON.stringify({
      riskKey: "knowledge_maturity_stagnation",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      evaluatedCycleIdxs: state.evaluatedCycleIdxs,
      closedCycleCount: state.closedCycleCount,
      activeCount: state.activeCount,
      strongCount: state.strongCount,
      recentActiveCount: state.recentActiveCount,
      recentStrongCount: state.recentStrongCount,
      strongShare: state.strongShare,
      reason: "知识库 active 项持续增长，但 strong 项没有同步成熟，飞轮可能只是在沉淀内容而不是形成可复用强知识。",
      requiredAction: "人工复核 Distiller 抽象质量、Librarian 晋级/淘汰规则和知识审批流程；必要时暂停新功能扩张，只做合并、stale/conflict 审计和 strong 晋级校准。",
    }),
    status: "pending",
    estimatedMinutes: 15,
    decision: null,
    version: 1,
  });
  return { safetyMode: true, state };
}

function stringArrayFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function findLibrarianAuditGate(projectId: string, cycleId: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "librarian_stale_conflict_audit_failure";
  });
}

function librarianAuditForProject(projectId: string) {
  const decisionStatuses = new Set(["active", "strong", "provisional"]);
  const contaminatedStatuses = new Set(["stale", "expired", "conflict", "quarantined"]);
  const nowMs = Date.now();
  const knowledge = storage.listKnowledge(projectId);
  const unmarkedStale = knowledge.filter((item) => {
    if (!decisionStatuses.has(item.status) || !item.validUntil) return false;
    const validUntilMs = Date.parse(item.validUntil);
    return Number.isFinite(validUntilMs) && validUntilMs < nowMs;
  });
  const unmarkedConflict = knowledge.filter((item) => {
    if (contaminatedStatuses.has(item.status)) return false;
    const tags = stringArrayFromJson(item.tags);
    const text = `${item.title}\n${item.content}\n${item.notes}`;
    return tags.some((tag) => /conflict_with_strong|contradicts_strong|needs_conflict_review/i.test(tag)) ||
      /与\s*strong\s*知识冲突|contradicts strong|conflict_with_strong/i.test(text);
  });

  return {
    ok: unmarkedStale.length === 0 && unmarkedConflict.length === 0,
    unmarkedStaleIds: unmarkedStale.map((item) => item.id),
    unmarkedConflictIds: unmarkedConflict.map((item) => item.id),
  };
}

function enforceLibrarianAuditGuard(projectId: string, cycleId: string) {
  const state = librarianAuditForProject(projectId);
  if (state.ok) return { safetyMode: false, state };

  const existing = findLibrarianAuditGate(projectId, cycleId);
  if (existing) return { safetyMode: existing.status === "pending", state };

  const cycle = storage.getCycle(cycleId);
  storage.createGate({
    id: `gate_librarian_audit_${cycle?.idx ?? 0}_${projectId.slice(-4)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "Librarian 知识审计失败",
    payload: JSON.stringify({
      riskKey: "librarian_stale_conflict_audit_failure",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      unmarkedStaleIds: state.unmarkedStaleIds,
      unmarkedConflictIds: state.unmarkedConflictIds,
      reason: "知识库存在已过期但仍可用于决策的知识，或明确冲突但未进入 conflict 的知识，说明 Librarian stale/conflict 审计没有生效。",
      requiredAction: "先把过期知识降级为 stale/expired，把冲突知识标记为 conflict/quarantined，并复核 Librarian 审计规则；修复前不得让这些知识进入下一轮决策。",
    }),
    status: "pending",
    estimatedMinutes: 12,
    decision: null,
    version: 1,
  });
  return { safetyMode: true, state };
}

function builderTaskLooksMisdirected(task: Task): boolean {
  if (task.agent !== "builder" || task.status !== "failed") return false;
  const spec = parsePayload(task.spec);
  const marker = [
    spec.directionMismatch,
    spec.failureType,
    spec.externalToolResult,
    spec.auditSummary?.reason,
    spec.diffSummary,
    spec.testReport,
    spec.error,
  ].map((item) => String(item ?? "")).join("\n");
  return spec.directionMismatch === true ||
    /direction_mismatch|misdirected|wrong_direction|wrong_file|误改|改错|偏航|方向不符|错误文件/i.test(marker);
}

function findBuilderMisdirectionGate(projectId: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "builder_misdirected_specs";
  });
}

function builderMisdirectionForProject(projectId: string) {
  const misdirectedTasks = storage.listCycles(projectId)
    .flatMap((cycle) => storage.listTasks(cycle.id))
    .filter(builderTaskLooksMisdirected);
  return {
    ok: misdirectedTasks.length < 2,
    count: misdirectedTasks.length,
    taskIds: misdirectedTasks.map((task) => task.id),
  };
}

function enforceBuilderMisdirectionGuard(projectId: string, cycleId: string) {
  const state = builderMisdirectionForProject(projectId);
  if (state.ok) return { safetyMode: false, state };

  const existing = findBuilderMisdirectionGate(projectId);
  if (existing) return { safetyMode: existing.status === "pending", state };

  const cycle = storage.getCycle(cycleId);
  storage.createGate({
    id: `gate_builder_misdirected_${projectId.slice(-4)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "Builder 任务偏航",
    payload: JSON.stringify({
      riskKey: "builder_misdirected_specs",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      misdirectedTaskCount: state.count,
      taskIds: state.taskIds,
      reason: "Builder Adapter 多次生成导致外部代码工具误改方向或改错对象的 task spec，自动推进已暂停。",
      requiredAction: "人工复核 Builder task spec 模板、风险约束、repo context 和外部工具回传报告；修正前不要继续发放新的代码变更包。",
    }),
    status: "pending",
    estimatedMinutes: 15,
    decision: null,
    version: 1,
  });
  return { safetyMode: true, state };
}

function findEvolutionRiskGate(projectId: string, cycleId: string, riskKey: string): HumanGateItem | undefined {
  return storage.listGates(projectId).find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk" || gate.blocking !== 1) return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === riskKey;
  });
}

function openEvolutionRiskGate(projectId: string, cycleId: string, riskKey: string, evidence: Record<string, unknown>): HumanGateItem {
  const cycle = storage.getCycle(cycleId);
  const existing = findEvolutionRiskGate(projectId, cycleId, riskKey);
  if (existing) return existing;
  return storage.createGate({
    id: `gate_${riskKey}_${cycle?.idx ?? 0}_${projectId.slice(-4)}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: "自主进化停机风险闸",
    payload: JSON.stringify({
      riskKey,
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      evidence,
      reason: "自主进化反空转检查触发，系统诚实停机并等待人工复核。",
      requiredAction: "复核误差趋势、目标重复、知识成熟与知识库增长；必要时调整目标生成器、合并策略或人工审批节奏。",
    }),
    status: "pending",
    estimatedMinutes: 15,
    decision: null,
    version: 1,
  });
}

function evolutionHistories(projectId: string) {
  const closed = storage.listCycles(projectId)
    .filter((cycle) => cycle.status === "closed")
    .sort((a, b) => a.idx - b.idx);
  const errors = closed
    .map((cycle) => cycle.eCycle)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const snapshots = closed.map((cycle) => {
    const lines = cycle.reasoning.split("\n");
    const marker = lines.find((line) => line.startsWith("__flywheel_snapshot__="));
    if (marker) {
      try {
        const snapshot = JSON.parse(marker.slice("__flywheel_snapshot__=".length));
        const strongCount = Number(snapshot.strongCount);
        const decisionKnowledgeCount = Number(snapshot.decisionKnowledgeCount);
        if (Number.isFinite(strongCount) && Number.isFinite(decisionKnowledgeCount)) {
          return { strongCount, decisionKnowledgeCount };
        }
      } catch {
        // keep fallback below
      }
    }
    const knowledgeAsOfCycle = storage.listKnowledge(projectId).filter((item) => item.createdByCycle <= cycle.idx && !item.supersededBy);
    return {
      strongCount: knowledgeAsOfCycle.filter((item) => item.status === "strong").length,
      decisionKnowledgeCount: knowledgeAsOfCycle.filter((item) => ["active", "strong"].includes(item.status)).length,
    };
  });
  const strongCountHistory = snapshots.map((snapshot) => snapshot.strongCount);
  const decisionKnowledgeSizeHistory = snapshots.map((snapshot) => snapshot.decisionKnowledgeCount);
  return { closedCycleIdxs: closed.map((cycle) => cycle.idx), errors, strongCountHistory, decisionKnowledgeSizeHistory };
}

function evaluateEvolutionStall(projectId: string, draft: NextGoalDraft, rejectedGoals: string[]) {
  const histories = evolutionHistories(projectId);
  return evaluateAutonomousStopRisk({
    ...histories,
    proposedGoal: draft.proposedGoal,
    rejectedGoals,
  });
}

function mergeMeaningGates(projectId: string) {
  const pending = storage.listGates(projectId).filter((g) => g.status === "pending" && g.type === "meaning" && g.blocking === 0);
  const groups = new Map<string, HumanGateItem[]>();
  for (const gate of pending) {
    const key = gateTopicKey(gate);
    groups.set(key, [...(groups.get(key) ?? []), gate]);
  }

  for (const gates of Array.from(groups.values())) {
    if (gates.length < 2) continue;
    const [keeper, ...rest] = gates;
    const quotes = gates.map((g) => parsePayload(g.payload).userQuote).filter(Boolean);
    const mergedAt = now();
    storage.updateGate(keeper.id, {
      payload: JSON.stringify({
        ...parsePayload(keeper.payload),
        mergedCount: gates.length,
        mergedQuotes: quotes,
        mergedAt,
      }),
    });
    for (const gate of rest) {
      storage.updateGate(gate.id, {
        status: "modified",
        decision: `merged_into:${keeper.id}`,
        estimatedMinutes: 0,
        payload: JSON.stringify({
          ...parsePayload(gate.payload),
          mergedInto: keeper.id,
          mergedAt,
        }),
      });
    }
  }
}

function autoApproveRepeatedLowValueMeaningGates(projectId: string) {
  const gates = storage.listGates(projectId).filter((g) => g.type === "meaning");
  const byTopic = new Map<string, HumanGateItem[]>();
  for (const gate of gates) {
    const topicKey = gateTopicKey(gate);
    byTopic.set(topicKey, [...(byTopic.get(topicKey) ?? []), gate]);
  }

  for (const [topicKey, group] of Array.from(byTopic.entries())) {
    const resolved = group.filter((g) => consumesHumanMinutes(g));
    if (resolved.length < 10) continue;
    const approved = resolved.filter((g) => g.status === "approved").length;
    if (approved / resolved.length <= 0.95) continue;
    const pending = group.filter((g) => g.status === "pending" && g.blocking === 0);
    const priorAutoApproved = group.filter((g) => (g.decision ?? "").startsWith("auto_approved_repeated_meaning:")).length;
    pending.forEach((gate, idx) => {
      const autoCandidateNo = priorAutoApproved + idx + 1;
      if (autoCandidateNo % 10 === 0) {
        storage.updateGate(gate.id, {
          payload: JSON.stringify({
            ...parsePayload(gate.payload),
            sampleReview: true,
            sampleReviewReason: "Every 10th repeated meaning gate remains pending for human sampling review.",
            sampleReviewAt: now(),
          }),
        });
        return;
      }
      storage.updateGate(gate.id, {
        status: "approved",
        decision: `auto_approved_repeated_meaning:${topicKey}`,
        estimatedMinutes: 0,
        payload: JSON.stringify({
          ...parsePayload(gate.payload),
          autoApprovedAt: now(),
          autoApproveReason: "10+ resolved meaning gates in this topic have approval rate >95%; kept every 10th pending for sampling review.",
          sampleReview: false,
        }),
      });
    });
  }
}

function builderTimeoutMs(): number {
  const raw = Number(process.env.ALAYA_BUILDER_TIMEOUT_MS ?? 86_400_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 86_400_000;
}

function taskCreatedAt(task: Task): string | null {
  const spec = parsePayload(task.spec);
  if (typeof spec.createdAt === "string") return spec.createdAt;

  const event = storage.listEvents().find((e) => {
    if (e.tableName !== "tasks" || e.op !== "insert") return false;
    const after = parseEventAfter(e.after);
    return after.id === task.id;
  });
  return event?.ts ?? null;
}

function builderTimeoutGateExists(cycleId: string, taskId: string): boolean {
  return storage.listGates().some((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk") return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "builder_timeout_degraded" && payload.taskId === taskId;
  });
}

function degradeTimedOutBuilderTasks(cycleId: string): number {
  const timeoutMs = builderTimeoutMs();
  const nowMs = Date.now();
  let degraded = 0;
  const openBuilderTasks = storage.listTasks(cycleId).filter((task) => (
    task.agent === "builder" && !["done", "failed", "timeout_degraded"].includes(task.status)
  ));

  for (const task of openBuilderTasks) {
    const createdAt = taskCreatedAt(task);
    const createdAtMs = Date.parse(createdAt ?? "");
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs < timeoutMs) continue;

    const spec = parsePayload(task.spec);
    const degradedAt = now();
    const nextSpec = {
      ...spec,
      timeoutDegradedAt: degradedAt,
      timeoutMs,
      auditSummary: {
        stage: "builder_timeout_degraded",
        reason: "Builder task exceeded timeout; scheduler degraded it to keep the flywheel from blocking forever.",
        previousStatus: task.status,
        createdAt,
      },
    };
    storage.updateTask(task.id, { status: "timeout_degraded", spec: JSON.stringify(nextSpec) });
    if (!builderTimeoutGateExists(cycleId, task.id)) {
      storage.createGate({
        id: `gate_builder_timeout_${task.id.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
        cycleId,
        type: "risk",
        blocking: 0,
        title: "Builder 超时降级审计",
        payload: JSON.stringify({
          riskKey: "builder_timeout_degraded",
          taskId: task.id,
          createdAt: degradedAt,
          taskCreatedAt: createdAt,
          timeoutMs,
          previousStatus: task.status,
          auditSummary: nextSpec.auditSummary,
        }),
        status: "pending",
        estimatedMinutes: 6,
        decision: null,
        version: 1,
      });
    }
    degraded += 1;
  }

  return degraded;
}

export function executeGateBudget(projectId: string): GateBudgetState {
  mergeMeaningGates(projectId);
  autoApproveRepeatedLowValueMeaningGates(projectId);
  return gateBudgetForProject(projectId);
}

function hasDirectionGate(cycleId: string) {
  return storage.listGates().some((g) => g.cycleId === cycleId && g.type === "direction");
}

function blockingGatesResolved(cycleId: string) {
  return storage.listGates().filter((g) => g.cycleId === cycleId && g.blocking === 1).every((g) => g.status !== "pending");
}

function builderCompleteOrAbsent(cycleId: string) {
  const builderTasks = storage.listTasks(cycleId).filter((t) => t.agent === "builder");
  if (builderTasks.length === 0) return true;
  return builderTasks.every((t) => ["done", "failed", "timeout_degraded"].includes(t.status));
}

function sensorFeedbackWindowMs(): number {
  const raw = Number(process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function newestTimestamp(values: Array<string | null | undefined>): number | null {
  const times = values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  if (times.length === 0) return null;
  return Math.max(...times);
}

function feedbackWindowState(cycleId: string) {
  const windowMs = sensorFeedbackWindowMs();
  if (windowMs === 0) return { ready: true, remainingMs: 0 };

  const decisions = storage.listDecisions().filter((d) => d.cycleId === cycleId && d.gateType === "direction");
  const resolvedAt = newestTimestamp(decisions.map((d) => d.ts));
  const directionGate = storage.listGates().find((g) => g.cycleId === cycleId && g.type === "direction");
  const openedAt = directionGate ? Date.parse(String(parsePayload(directionGate.payload).createdAt ?? "")) : null;
  const anchor = resolvedAt ?? (Number.isFinite(openedAt) ? openedAt : null);
  if (anchor == null) return { ready: false, remainingMs: windowMs };

  const elapsedMs = Math.max(0, Date.now() - anchor);
  return {
    ready: elapsedMs >= windowMs,
    remainingMs: Math.max(0, windowMs - elapsedMs),
  };
}

function hasFeedbackSyncErrors(results: ExternalFeedbackSyncResult[]): boolean {
  return results.some((result) => result.errors.length > 0);
}

async function schedulerTickProjectUnlocked(projectId: string, options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  decayStaleKnowledge(projectId);
  detectKnowledgeConflicts(projectId);
  createKnowledgeReviewReminders(projectId);
  const budget = executeGateBudget(projectId);
  const humanAttention = enforceHumanAttentionBudget(projectId, budget);
  if (humanAttention.safetyMode) {
    return {
      projectId,
      action: "safety_mode",
      budget: gateBudgetForProject(projectId),
      note: "human attention budget exceeded; waiting for backlog review",
    };
  }
  if (budget.safetyMode) {
    return {
      projectId,
      action: "safety_mode",
      budget,
      note: "blocking gates exceeded safety threshold; low-speed mode only",
    };
  }

  const cycles = storage.listCycles(projectId);
  if (cycles.length === 0) {
    return { projectId, action: "no_cycle", budget, note: "no cycle exists" };
  }

  const current = cycles.find((c) => c.status !== "closed") ?? cycles[cycles.length - 1];
  if (!current) {
    return { projectId, action: "no_cycle", budget, note: "no current cycle" };
  }

  const llmBudget = enforceLlmBudget(projectId, current.id);
  if (llmBudget.overBudget && llmBudget.pendingBudgetGate) {
    return {
      projectId,
      action: "safety_mode",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget,
      note: "LLM cost budget exceeded; waiting for blocking budget gate",
    };
  }

  const builderMisdirection = enforceBuilderMisdirectionGuard(projectId, current.id);
  if (builderMisdirection.safetyMode) {
    return {
      projectId,
      action: "safety_mode",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget,
      note: "builder misdirection guard triggered; waiting for human review",
    };
  }

  if (current.status === "closed") {
    const predictionMeasurability = enforcePredictionMeasurabilityGuard(projectId, current.id);
    if (predictionMeasurability.safetyMode) {
      return {
        projectId,
        action: "safety_mode",
        cycleId: current.id,
        budget: gateBudgetForProject(projectId),
        llmBudget,
        note: "prediction measurability guard triggered; waiting for human review",
      };
    }

    const knowledgeMaturity = enforceKnowledgeMaturityGuard(projectId, current.id);
    if (knowledgeMaturity.safetyMode) {
      return {
        projectId,
        action: "safety_mode",
        cycleId: current.id,
        budget: gateBudgetForProject(projectId),
        llmBudget,
        note: "knowledge maturity guard triggered; waiting for human review",
      };
    }

    const librarianAudit = enforceLibrarianAuditGuard(projectId, current.id);
    if (librarianAudit.safetyMode) {
      return {
        projectId,
        action: "safety_mode",
        cycleId: current.id,
        budget: gateBudgetForProject(projectId),
        llmBudget,
        note: "librarian stale/conflict audit guard triggered; waiting for human review",
      };
    }

    const nextIdx = current.idx + 1;
    const sc = scenarioForCycle(nextIdx);
    let nextGoal = sc?.proposedGoal ?? "";
    let nextReasoning = "";
    if (!sc) {
      try {
        const input = buildNextGoalInput(projectId, nextIdx, current.id);
        const draft = await generateNextGoal(input);
        const stall = evaluateEvolutionStall(projectId, draft, input.rejectedGoals);
        if (stall) {
          openEvolutionRiskGate(projectId, current.id, stall.riskKey, stall.evidence);
          return {
            projectId,
            action: "safety_mode",
            cycleId: current.id,
            budget: gateBudgetForProject(projectId),
            llmBudget,
            note: `${stall.riskKey} guard triggered; waiting for human review`,
          };
        }
        nextGoal = draft.proposedGoal;
        nextReasoning = draft.reasoningHowKnowledgeChangedDecision;
      } catch (error) {
        openEvolutionRiskGate(projectId, current.id, "evolution_stalled", {
          generationError: error instanceof Error ? error.message : String(error),
          nextIdx,
        });
        return {
          projectId,
          action: "safety_mode",
          cycleId: current.id,
          budget: gateBudgetForProject(projectId),
          llmBudget,
          note: "autonomous goal generation failed; waiting for human review",
        };
      }
    }
    const next = storage.createCycle({
      id: `cycle_${nextIdx}_${projectId.slice(-4)}`,
      projectId,
      idx: nextIdx,
      goal: nextGoal,
      status: "planning",
      eCycle: null,
      worstClaimError: null,
      reasoning: nextReasoning,
      version: 1,
    });
    storage.updateProject(projectId, { currentCycleIdx: nextIdx });
    return {
      projectId,
      action: "created_next_cycle",
      cycleId: current.id,
      nextCycleId: next.id,
      budget,
      llmBudget,
      note: "created next planning cycle",
    };
  }

  let sc;
  try {
    sc = await resolveCycleStimulus(projectId, current.idx, current.id);
  } catch (error) {
    openEvolutionRiskGate(projectId, current.id, "evolution_stalled", {
      generationError: error instanceof Error ? error.message : String(error),
      currentIdx: current.idx,
    });
    return {
      projectId,
      action: "safety_mode",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget,
      note: "autonomous cycle stimulus generation failed; waiting for human review",
    };
  }
  if (!hasDirectionGate(current.id)) {
    await runOrchestrator(projectId, current.id, sc);
    const compounding = enforceFlywheelCompoundingGuard(projectId, current.id);
    if (compounding.safetyMode) {
      return {
        projectId,
        action: "safety_mode",
        cycleId: current.id,
        budget: gateBudgetForProject(projectId),
        llmBudget: llmBudgetForProject(projectId),
        note: "flywheel compounding guard triggered; waiting for human review",
      };
    }
    return {
      projectId,
      action: "opened_direction_gate",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: "opened direction gate and paused for human decision",
    };
  }

  const compounding = enforceFlywheelCompoundingGuard(projectId, current.id);
  if (compounding.safetyMode) {
    return {
      projectId,
      action: "safety_mode",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget,
      note: "flywheel compounding guard triggered; waiting for human review",
    };
  }

  if (!blockingGatesResolved(current.id)) {
    return {
      projectId,
      action: "waiting_blocking_gate",
      cycleId: current.id,
      budget,
      llmBudget,
      note: "waiting for blocking human gate",
    };
  }

  if (!builderCompleteOrAbsent(current.id)) {
    const degradedCount = degradeTimedOutBuilderTasks(current.id);
    if (degradedCount > 0 && builderCompleteOrAbsent(current.id)) {
      const afterDegradeBudget = gateBudgetForProject(projectId);
      return {
        projectId,
        action: "waiting_blocking_gate",
        cycleId: current.id,
        budget: afterDegradeBudget,
        llmBudget,
        note: `builder timeout degraded ${degradedCount} task(s); scheduler will continue on the next tick`,
      };
    }
    return {
      projectId,
      action: "waiting_blocking_gate",
      cycleId: current.id,
      budget,
      llmBudget,
      note: "waiting for builder task completion or timeout degradation",
    };
  }

  const feedbackWindow = feedbackWindowState(current.id);
  if (!feedbackWindow.ready) {
    const syncResults = await syncConfiguredFeedbackForProject(projectId, current.id, options.feedbackSync);
    if (hasFeedbackSyncErrors(syncResults)) {
      return {
        projectId,
        action: "safety_mode",
        cycleId: current.id,
        budget: gateBudgetForProject(projectId),
        llmBudget: llmBudgetForProject(projectId),
        note: "external feedback source sync failed; waiting for human/toolchain review",
      };
    }
    return {
      projectId,
      action: "waiting_feedback_window",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: `sensor feedback window still open (${Math.ceil(feedbackWindow.remainingMs / 1000)}s remaining); synced feedback only`,
    };
  }

  const syncResults = await syncConfiguredFeedbackForProject(projectId, current.id, options.feedbackSync);
  if (hasFeedbackSyncErrors(syncResults)) {
    return {
      projectId,
      action: "safety_mode",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: "external feedback source sync failed; waiting for human/toolchain review",
    };
  }
  const result = await runOperationalStagesAfterApprovedDirection(projectId, current.id);
  return {
    projectId,
    action: "ran_operational_stages",
    cycleId: current.id,
    budget: gateBudgetForProject(projectId),
    llmBudget: llmBudgetForProject(projectId),
    note: `closed cycle ${result.cycleIdx}; scheduler can create next cycle on next tick`,
  };
}

export async function schedulerTickProject(projectId: string, options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  if (runningProjectTicks.has(projectId)) {
    const cycle = storage.listCycles(projectId).find((c) => c.status !== "closed") ?? storage.listCycles(projectId).at(-1);
    const payload = { projectId, reason: "tick_in_progress", ts: now() };
    storage.recordEvent({
      cycleIdx: cycle?.idx ?? 0,
      actor: "scheduler",
      tableName: "scheduler",
      op: "scheduler_tick_skipped",
      before: null,
      after: JSON.stringify(payload),
      ts: now(),
    });
    recordTrace({
      projectId,
      cycleId: cycle?.id ?? null,
      cycleIdx: cycle?.idx ?? null,
      kind: "scheduler",
      name: "scheduler_tick_skipped",
      agent: "scheduler",
      status: "blocked",
      attributes: payload,
    });
    observeSchedulerCycle({ ok: false, durationMs: 0 });
    return {
      projectId,
      action: "skipped",
      cycleId: cycle?.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: "tick_in_progress",
    };
  }

  runningProjectTicks.add(projectId);
  const bus = await getNotificationBus();
  const beforePendingGateIds = bus ? pendingGateIds(projectId) : new Set<string>();
  try {
    const result = await schedulerTickProjectUnlocked(projectId, options);
    if (bus) emitSchedulerNotifications(bus, beforePendingGateIds, result);
    return result;
  } finally {
    runningProjectTicks.delete(projectId);
  }
}

export async function schedulerTickAllProjects(options: SchedulerTickOptions = {}): Promise<SchedulerTickResult[]> {
  const results: SchedulerTickResult[] = [];
  for (const project of storage.listProjects()) {
    results.push(await schedulerTickProject(project.id, options));
  }
  return results;
}

export function startCycleScheduler(intervalMs = Number(process.env.ALAYA_SCHEDULER_INTERVAL_MS ?? 60_000)) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      await schedulerTickAllProjects();
      observeSchedulerCycle({ ok: true, durationMs: Date.now() - started });
    } catch (err) {
      observeSchedulerCycle({ ok: false, durationMs: Date.now() - started });
      storage.recordEvent({
        cycleIdx: 0,
        actor: "scheduler",
        tableName: "scheduler",
        op: "error",
        before: null,
        after: JSON.stringify({ error: err instanceof Error ? err.message : String(err), ts: now() }),
        ts: now(),
      });
    } finally {
      running = false;
    }
  }, intervalMs);
}
