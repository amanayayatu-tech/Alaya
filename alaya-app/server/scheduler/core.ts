import { storage, now } from "../storage";
import { buildNextGoalInput, resolveCycleStimulus, runOrchestrator, runOperationalStagesAfterApprovedDirection, scenarioForCycle } from "../flywheel";
import { generateNextGoal, type NextGoalDraft } from "../autonomousGoal";
import { evaluateAutonomousStopRisk } from "../stallGuard";
import { syncConfiguredFeedbackForProject } from "../externalFeedback";
import type { ExternalFeedbackSyncResult, SyncGithubIssuesOptions } from "../externalFeedback";
import { applyTimeDecay, grayZoneStaleness } from "alaya-core/src/core/update_confidence.js";
import { transitionState } from "alaya-core/src/core/transition_state.js";
import { recordTrace } from "../trace";
import { observeSchedulerCycle } from "../observability/metrics";
import { createKnowledgeReviewReminders, detectConflictsAgainst } from "../knowledgeReview";
import { isContradiction, semanticSimilarity } from "../knowledgeSimilarity";
import { claimSchema, type Cycle, type HumanGateItem, type KnowledgeItem, type Task } from "@shared/schema";
import { emitReviewWindowDigest, emitReviewWindowSummary, emitSchedulerNotifications, getNotificationBus, pendingGateIds } from "./notifications";
import type { GateBudgetState, LlmBudgetState, SchedulerTickOptions, SchedulerTickResult } from "./types";
import { HumanGateService } from "../humanGateService";
import { createDecisionBrief, withDecisionBriefPayload } from "../decisionBrief";
import { gateEscalationMissedWindowsFromEnv, speculativeBudgetRatioFromEnv, speculativeDraftingFromEnv } from "../config/env";
import { reviewWindowState, sameReviewWindow, type ReviewWindowState } from "../reviewWindow";
import type { NotificationBus } from "../notifications/bus";
import { CodexCliBuilderAdapter } from "../builderAdapter";
import { reconcileSpeculativeAssumptions, runApplyExecutor } from "../applyExecutor";
import { withKnowledgeRetrievalIdentity } from "../knowledgeInjection";

const runningProjectTicks = new Set<string>();
const safetyThrottleTicksByProject = new Map<string, number>();
const humanGateService = new HumanGateService(storage);

function reviewPaused(): boolean {
  const persisted = storage.getReviewPauseState();
  if (persisted != null) return persisted;
  return /^(1|true|yes|on)$/i.test(process.env.ALAYA_REVIEW_PAUSED?.trim() ?? "");
}

function schedulerDecisionBrief(input: {
  claim: string;
  metric?: string;
  timeWindow?: string;
  ifApproved: string;
  ifRejected: string;
  rollbackRef?: string;
}) {
  return createDecisionBrief({
    claim: input.claim,
    metric: input.metric ?? "scheduler_risk_review",
    timeWindow: input.timeWindow ?? "before next scheduler advancement",
    ifApproved: input.ifApproved,
    ifRejected: input.ifRejected,
    rollbackRef: input.rollbackRef ?? "event_log:human_gate_items",
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

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function coreKnowledgeView(item: KnowledgeItem, confidenceScore = item.confidenceScore): any {
  return {
    ...item,
    confidenceScore,
    tags: parseJsonStringArray(item.tags),
    validUntil: item.validUntil ?? null,
    approvedBy: item.approvedBy ?? null,
  };
}

export function decayStaleKnowledge(projectId: string, currentTime = Date.now(), lambda = 0.03) {
  const eligible = storage.listKnowledge(projectId).filter((item) => (
    !item.supersededBy &&
    !validityExpired(item, currentTime) &&
    !["quarantined", "expired", "conflict"].includes(item.status)
  ));
  let decayed = 0;
  let demoted = 0;
  const cycle = storage.listCycles(projectId).at(-1);
  const currentCycle = cycle?.idx ?? 0;

  for (const item of eligible) {
    const gray = grayZoneStaleness({ k: coreKnowledgeView(item), currentTimeMs: currentTime });
    const result = applyTimeDecay({
      score: item.confidenceScore,
      lastVerifiedAt: decayAnchorAtMs(item, currentTime),
      storageStrength: item.storageStrength ?? 1,
    }, currentTime, lambda);
    if (result.daysSinceLastVerified === 0 && (!gray.isGrayActive || gray.daysSinceLastUse === 0)) continue;

    const useTransition = gray.isGrayActive || item.status === "stale";
    const transition = useTransition
      ? transitionState(coreKnowledgeView(item, gray.isGrayActive ? item.confidenceScore : result.newScore), {
        currentCycle,
        conflictsWithStrong: false,
        cyclesInStale: item.status === "stale" ? Math.max(0, currentCycle - item.lastValidatedCycle) : undefined,
        daysSinceLastUse: gray.daysSinceLastUse,
        wallclockDecayedScore: gray.isGrayActive ? gray.wallclockDecayedScore : undefined,
        humanApprovedStrongPromotion: item.humanApprovedCount >= 1,
      })
      : null;
    const nextStatus = transition?.changed
      ? transition.nextStatus
      : (result.shouldDemoteToStale && item.status !== "stale" ? "stale" : item.status);
    const nextScore = gray.isGrayActive && !transition?.changed
      ? item.confidenceScore
      : (gray.isGrayActive ? Math.min(item.confidenceScore, gray.wallclockDecayedScore) : result.newScore);
    const scoreChanged = Math.abs(nextScore - item.confidenceScore) > 1e-9;
    const storageChanged = Math.abs(result.newStorageStrength - (item.storageStrength ?? 1)) > 1e-9;
    const statusChanged = nextStatus !== item.status;
    if (!scoreChanged && !storageChanged && !statusChanged) continue;

    storage.updateKnowledge(item.id, {
      confidenceScore: nextScore,
      confidenceLevel: confidenceLevelFor(item, nextScore),
      storageStrength: result.newStorageStrength,
      lastDecayedAt: currentTime,
      status: nextStatus,
      actor: gray.isGrayActive ? "librarian/gray_decay" : "time_decay_scheduler",
    });
    recordTrace({
      projectId,
      cycleId: cycle?.id ?? null,
      cycleIdx: cycle?.idx ?? null,
      kind: "principle_transition",
      name: "knowledge_time_decay",
      agent: gray.isGrayActive ? "librarian/gray_decay" : "time_decay_scheduler",
      attributes: {
        knowledgeId: item.id,
        from: item.status,
        to: nextStatus,
        oldScore: item.confidenceScore,
        newScore: nextScore,
        oldStorageStrength: item.storageStrength ?? 1,
        newStorageStrength: result.newStorageStrength,
        daysSinceLastVerified: result.daysSinceLastVerified,
        daysSinceLastUse: gray.daysSinceLastUse,
        wallclockDecayedScore: gray.wallclockDecayedScore,
        transitionReason: transition?.reason ?? "",
      },
    });
    decayed += 1;
    if (statusChanged) demoted += 1;
  }

  return { evaluated: eligible.length, decayed, demoted };
}

function conflictDetectionFingerprint(item: KnowledgeItem): string {
  return JSON.stringify({
    status: item.status,
    supersededBy: item.supersededBy,
    confidenceScore: item.confidenceScore,
    title: item.title,
    content: item.content,
    sourceType: item.sourceType,
    sourceRef: item.sourceRef,
    createdBy: item.createdBy,
    tags: item.tags,
    notes: item.notes,
    semanticKey: item.semanticKey,
  });
}

function knowledgeConflictSnapshot(projectId: string): Map<string, string> {
  return new Map(storage.listKnowledge(projectId).map((item) => [item.id, conflictDetectionFingerprint(item)]));
}

function changedKnowledgeIdsSince(projectId: string, before: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const item of storage.listKnowledge(projectId)) {
    if (before.get(item.id) !== conflictDetectionFingerprint(item)) changed.push(item.id);
  }
  return changed;
}

function detectConflictsForChangedKnowledge(projectId: string, before: Map<string, string>): string[] {
  const changedIds = changedKnowledgeIdsSince(projectId, before);
  if (changedIds.length > 0) detectConflictsAgainst(projectId, changedIds);
  return changedIds;
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
  const semanticKey = typeof payload.semanticKey === "string" ? payload.semanticKey.trim() : "";
  const topicKey = typeof payload.topicKey === "string" ? payload.topicKey.trim() : "";
  return semanticKey || topicKey || gate.title;
}

function consumesHumanMinutes(gate: HumanGateItem): boolean {
  if (gate.status === "pending") return false;
  const decision = gate.decision ?? "";
  if (decision.startsWith("merged_into:")) return false;
  if (decision.startsWith("auto_approved_repeated_meaning:")) return false;
  if (decision.startsWith("auto_resolved_")) return false;
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
  const missedWindowThreshold = gateEscalationMissedWindowsFromEnv();
  const escalatedBlockingGate = pendingBlocking.some((gate) => (gate.missedWindows ?? 0) >= missedWindowThreshold);
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
    safetyMode: escalatedBlockingGate,
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
  const overloaded = state.pendingOverBudget2x || (state.weeklyOverFiveHours && state.pendingEstimatedMinutes > 0);
  const existing = findHumanAttentionGate(projectId, weeklyWindowStart);
  if (!overloaded) {
    if (existing?.status === "pending") {
      humanGateService.systemResolve(existing.id, "auto_resolved_attention_recovered", {
        actor: "scheduler",
        status: "resolved",
        reason: "human_attention_backlog_cleared",
        patch: {
          estimatedMinutes: 0,
          payload: JSON.stringify({
            ...parsePayload(existing.payload),
            resolvedAt: now(),
            resolvedReason: "human_attention_backlog_cleared",
          }),
        },
      });
    }
    return { safetyMode: false, state: gateBudgetForProject(projectId) };
  }

  const currentCycle = storage.listCycles(projectId).find((cycle) => cycle.status !== "closed")
    ?? storage.listCycles(projectId).at(-1);
  if (existing) return { safetyMode: existing.status === "pending", state: gateBudgetForProject(projectId) };

  storage.createGate({
    id: `gate_human_attention_${weeklyWindowStart.slice(0, 10).replace(/-/g, "")}_${projectId.slice(-4)}`,
    cycleId: currentCycle?.id ?? `cycle_attention_${projectId.slice(-4)}`,
    type: "risk",
    blocking: 1,
    title: "人类注意力过载",
    payload: withDecisionBriefPayload({
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
    }, schedulerDecisionBrief({
      claim: "Human attention backlog exceeds the sustainable review budget",
      metric: "pending_human_minutes",
      timeWindow: "current weekly review window",
      ifApproved: "The overload risk is acknowledged and the operator can choose a recovery path.",
      ifRejected: "The scheduler should remain throttled until backlog or budget pressure is reduced.",
      rollbackRef: "gate_budget_for_project",
    })),
    status: "pending",
    estimatedMinutes: 15,
    decision: null,
    version: 1,
  });
  return { safetyMode: true, state: gateBudgetForProject(projectId) };
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
    payload: withDecisionBriefPayload({
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
    }, schedulerDecisionBrief({
      claim: "LLM spend exceeded the weekly project budget",
      metric: "weekly_llm_cost_usd",
      timeWindow: "current weekly budget window",
      ifApproved: "The budget overrun is acknowledged and the scheduler may continue according to operator policy.",
      ifRejected: "High-cost LLM work should stay paused until budget or provider usage is corrected.",
      rollbackRef: "llm_calls",
    })),
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

function flywheelCompoundingWarmupCycles(): number {
  const raw = Number(process.env.ALAYA_FLYWHEEL_COMPOUNDING_WARMUP_CYCLES ?? 3);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
}

function compoundingEvidenceForDirection(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  const warmupCycles = flywheelCompoundingWarmupCycles();
  if (!cycle || cycle.idx <= warmupCycles) {
    return { required: false, ok: true, refs: [] as string[], text: "", previousCycleIdxs: [] as number[], warmupCycles };
  }

  const previousClosed = storage.listCycles(projectId)
    .filter((item) => item.idx < cycle.idx && item.status === "closed")
    .sort((a, b) => b.idx - a.idx)
    .slice(0, warmupCycles)
    .sort((a, b) => a.idx - b.idx);
  if (previousClosed.length < warmupCycles) {
    return { required: false, ok: true, refs: [] as string[], text: "", previousCycleIdxs: previousClosed.map((item) => item.idx), warmupCycles };
  }

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
    warmupCycles,
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
      payload: withDecisionBriefPayload({
        riskKey: "flywheel_empty_learning",
        createdAt: now(),
        evaluatedCycleIdx: cycle?.idx ?? 0,
        previousCycleIdxs: evidence.previousCycleIdxs,
        warmupCycles: evidence.warmupCycles,
        knowledgeRefsCount: evidence.refs.length,
        influenceTextSnippet: evidence.text.slice(0, 500),
        reason: "连续 3 轮后，新一轮建议没有证明前轮知识如何改变本轮决策，自动推进已暂停。",
        requiredAction: "人工复核 Orchestrator reasoning、补充有效知识引用，或回滚到世界模型/知识沉淀算法修正。",
      }, schedulerDecisionBrief({
        claim: "The current direction does not prove prior knowledge changed the decision",
        metric: "knowledge_refs_influence",
        ifApproved: "The operator accepts the compounding evidence and can let the cycle proceed.",
        ifRejected: "The cycle remains blocked until reasoning cites and uses prior knowledge concretely.",
        rollbackRef: "agent_runs.orchestrator",
      })),
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
    payload: withDecisionBriefPayload({
      riskKey: "prediction_measurability_failure",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      predictionCount: state.predictionCount,
      failures: state.failures,
      reason: "本轮 prediction 无法形成可计算的 prediction_error，不能作为下一轮学习信号。",
      requiredAction: "把自然语言预测拆成 measurable claim，并补齐 expected_observation、time_window、success_threshold、failure_threshold、uncertainty、observation 和 prediction_error；qualitative 判断应进入 meaning gate 或人工裁定。",
    }, schedulerDecisionBrief({
      claim: "The cycle prediction cannot produce a computable prediction error",
      metric: "measurable_claim_count",
      ifApproved: "The operator accepts the current prediction contract and may continue the cycle.",
      ifRejected: "The cycle remains blocked until claims and observation thresholds are measurable.",
      rollbackRef: "predictions.claims",
    })),
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
    payload: withDecisionBriefPayload({
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
    }, schedulerDecisionBrief({
      claim: "Active knowledge is growing without strong knowledge maturation",
      metric: "strong_knowledge_share",
      ifApproved: "The operator accepts the maturation risk and may continue with explicit follow-up.",
      ifRejected: "The scheduler should remain paused until knowledge review and promotion rules are fixed.",
      rollbackRef: "knowledge_items.status",
    })),
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
    payload: withDecisionBriefPayload({
      riskKey: "librarian_stale_conflict_audit_failure",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      unmarkedStaleIds: state.unmarkedStaleIds,
      unmarkedConflictIds: state.unmarkedConflictIds,
      reason: "知识库存在已过期但仍可用于决策的知识，或明确冲突但未进入 conflict 的知识，说明 Librarian stale/conflict 审计没有生效。",
      requiredAction: "先把过期知识降级为 stale/expired，把冲突知识标记为 conflict/quarantined，并复核 Librarian 审计规则；修复前不得让这些知识进入下一轮决策。",
    }, schedulerDecisionBrief({
      claim: "Librarian audit left stale or conflicting knowledge decision-eligible",
      metric: "unmarked_polluted_knowledge_count",
      ifApproved: "The operator accepts the audit exception and can continue with tracked risk.",
      ifRejected: "The cycle remains blocked until polluted knowledge is demoted or quarantined.",
      rollbackRef: "knowledge_items.status",
    })),
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
    payload: withDecisionBriefPayload({
      riskKey: "builder_misdirected_specs",
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      misdirectedTaskCount: state.count,
      taskIds: state.taskIds,
      reason: "Builder Adapter 多次生成导致外部代码工具误改方向或改错对象的 task spec，自动推进已暂停。",
      requiredAction: "人工复核 Builder task spec 模板、风险约束、repo context 和外部工具回传报告；修正前不要继续发放新的代码变更包。",
    }, schedulerDecisionBrief({
      claim: "Builder task specs repeatedly misdirected external tooling",
      metric: "misdirected_builder_task_count",
      ifApproved: "The operator accepts the builder risk and can continue after reviewing the task context.",
      ifRejected: "The scheduler should not issue new builder change packages until the template or context is fixed.",
      rollbackRef: "tasks.spec",
    })),
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
    payload: withDecisionBriefPayload({
      riskKey,
      createdAt: now(),
      evaluatedCycleIdx: cycle?.idx ?? 0,
      evidence,
      reason: "自主进化反空转检查触发，系统诚实停机并等待人工复核。",
      requiredAction: "复核误差趋势、目标重复、知识成熟与知识库增长；必要时调整目标生成器、合并策略或人工审批节奏。",
    }, schedulerDecisionBrief({
      claim: `Autonomous evolution stop risk triggered: ${riskKey}`,
      metric: "autonomous_stop_risk",
      ifApproved: "The operator accepts the stop-risk evidence and may allow the autonomous goal path to continue.",
      ifRejected: "The project remains paused until the stop-risk cause is corrected.",
      rollbackRef: "stall_guard.evidence",
    })),
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
    humanGateService.systemMerge(keeper.id, rest.map((gate) => gate.id), {
      actor: "scheduler",
      reason: "same topic meaning gates merged",
    });
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
      const reviewRequirement = meaningGateHumanReviewRequirement(projectId, gate);
      if (reviewRequirement) {
        humanGateService.systemAnnotate(gate.id, {
          actor: "scheduler",
          reason: "meaning gate kept pending for required sample review",
          patch: {
            payload: JSON.stringify({
              ...parsePayload(gate.payload),
              sampleReview: true,
              sampleReviewReason: reviewRequirement,
              sampleReviewAt: now(),
            }),
          },
        });
        return;
      }
      const autoCandidateNo = priorAutoApproved + idx + 1;
      if (autoCandidateNo % 10 === 0) {
        humanGateService.systemAnnotate(gate.id, {
          actor: "scheduler",
          reason: "meaning gate kept pending for periodic sample review",
          patch: {
            payload: JSON.stringify({
              ...parsePayload(gate.payload),
              sampleReview: true,
              sampleReviewReason: "Every 10th repeated meaning gate remains pending for human sampling review.",
              sampleReviewAt: now(),
            }),
          },
        });
        return;
      }
      humanGateService.systemResolve(gate.id, `auto_approved_repeated_meaning:${topicKey}`, {
        actor: "scheduler",
        status: "approved",
        via: "auto_approved_repeated_meaning",
        reason: "10+ resolved meaning gates in this topic have approval rate >95%",
        patch: {
          estimatedMinutes: 0,
          payload: JSON.stringify({
            ...parsePayload(gate.payload),
            autoApprovedAt: now(),
            autoApproveReason: "10+ resolved meaning gates in this topic have approval rate >95%; kept every 10th pending for sampling review.",
            sampleReview: false,
          }),
        },
      });
    });
  }
}

function meaningGateText(gate: HumanGateItem): string {
  const payload = parsePayload(gate.payload);
  const userQuote = reviewableFeedbackBody(payload.userQuote);
  return [
    gate.title,
    payload.summary,
    payload.reason,
    payload.requiredAction,
    userQuote,
    payload.redactedBody,
    payload.auditSummary?.whyNow,
  ].map((item) => String(item ?? "")).join("\n");
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function knowledgeMatchesGateTopic(item: KnowledgeItem, topicKey: string, gateLike: Pick<KnowledgeItem, "title" | "content" | "semanticKey">): boolean {
  const normalizedTopic = topicKey.trim().toLowerCase();
  if (normalizedTopic) {
    const tags = parseTags(item.tags).map((tag) => tag.toLowerCase());
    if (tags.includes(normalizedTopic)) return true;
    if ((item.semanticKey ?? "").trim().toLowerCase() === normalizedTopic) return true;
  }
  return semanticSimilarity(gateLike, item) >= 0.45;
}

function semanticContradictionWithActiveKnowledge(projectId: string, gate: HumanGateItem): boolean {
  const payload = parsePayload(gate.payload);
  const text = meaningGateText(gate);
  const topicKey = String(payload.topicKey ?? "").trim();
  const gateLike = {
    title: gate.title,
    content: text,
    semanticKey: topicKey,
  };
  return storage.listKnowledge(projectId)
    .filter((item) => !item.supersededBy && (item.status === "active" || item.status === "strong"))
    .filter((item) => knowledgeMatchesGateTopic(item, topicKey, gateLike))
    .some((item) => isContradiction(gateLike, item));
}

function meaningGateHumanReviewRequirement(projectId: string, gate: HumanGateItem): string | null {
  const text = meaningGateText(gate);
  if (/明确冲突|互相矛盾|不能同时|不能直接复用|必须进入\s*conflict|冲突审查|等待人工审核|\bcontradict(?:s|ed|ory)?\b|\bcontradiction\b(?!-runner)|conflicts?\s+with|conflict review|cannot be reused|cannot.*active/i.test(text)) {
    return "explicit contradiction marker";
  }
  if (semanticContradictionWithActiveKnowledge(projectId, gate)) {
    return "semantic contradiction with existing active knowledge";
  }
  return null;
}

function reviewableFeedbackBody(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";
  if (/^Form Feedback \(/i.test(text)) {
    const parts = text.split(/\n\s*\n/);
    if (parts.length > 1) return parts.slice(1).join("\n\n");
    return text.replace(/^Form Feedback[^\n]*\n?/i, "");
  }
  return text;
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
        payload: withDecisionBriefPayload({
          riskKey: "builder_timeout_degraded",
          taskId: task.id,
          createdAt: degradedAt,
          taskCreatedAt: createdAt,
          timeoutMs,
          previousStatus: task.status,
          auditSummary: nextSpec.auditSummary,
        }, schedulerDecisionBrief({
          claim: `Builder task ${task.id} timed out and was degraded`,
          metric: "builder_task_timeout",
          timeWindow: "current scheduler tick",
          ifApproved: "The timeout degradation is accepted as an audit note and the flywheel can continue.",
          ifRejected: "The degraded task should be manually inspected before further builder work proceeds.",
          rollbackRef: `tasks:${task.id}`,
        })),
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

function safetyThrottleEveryTicks(): number {
  const raw = Number(process.env.ALAYA_SAFETY_THROTTLE_EVERY_TICKS ?? 2);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

interface SoftSafetyContext {
  active: boolean;
  reason: string;
  everyTicks: number;
  tickCount: number;
  shouldAdvance: boolean;
}

function softSafetyContext(projectId: string, reasons: string[]): SoftSafetyContext {
  if (reasons.length === 0) {
    safetyThrottleTicksByProject.delete(projectId);
    return { active: false, reason: "", everyTicks: safetyThrottleEveryTicks(), tickCount: 0, shouldAdvance: true };
  }

  const everyTicks = safetyThrottleEveryTicks();
  const tickCount = (safetyThrottleTicksByProject.get(projectId) ?? 0) + 1;
  safetyThrottleTicksByProject.set(projectId, tickCount);
  return {
    active: true,
    reason: reasons.join("; "),
    everyTicks,
    tickCount,
    shouldAdvance: tickCount % everyTicks === 0,
  };
}

function safetyThrottleDeferredResult(projectId: string, cycleId: string | undefined, context: SoftSafetyContext): SchedulerTickResult {
  return {
    projectId,
    action: "safety_throttled",
    cycleId,
    budget: gateBudgetForProject(projectId),
    llmBudget: cycleId ? llmBudgetForProject(projectId) : undefined,
    note: `safety_mode throttled; deferred cycle work this tick (${context.tickCount}/${context.everyTicks}): ${context.reason}`,
  };
}

function withSafetyThrottle(result: SchedulerTickResult, context: SoftSafetyContext): SchedulerTickResult {
  if (!context.active) return result;
  if (result.action === "safety_mode" || result.action === "safety_throttled" || result.action === "skipped" || result.action === "no_cycle") {
    return result;
  }
  return {
    ...result,
    action: "safety_throttled",
    throttledAction: result.action,
    budget: gateBudgetForProject(result.projectId),
    llmBudget: result.cycleId ? llmBudgetForProject(result.projectId) : result.llmBudget,
    note: `safety_mode throttled advance (${result.action}; every ${context.everyTicks} ticks): ${context.reason}; ${result.note}`,
  };
}

export interface ReviewWindowTickResult {
  state: ReviewWindowState;
  openedSessionId?: string;
  closedSessionId?: string;
  digestSent: boolean;
  summarySent: boolean;
  missedWindowsIncremented: number;
  deferredReset: number;
}

function reviewSessionId(projectId: string, state: ReviewWindowState): string {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 80);
  const safeWindow = `${state.windowDate}_${state.windowLabel}`.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 80);
  return `review_${safeProjectId}_${safeWindow}`;
}

function pendingReviewGates(projectId: string): HumanGateItem[] {
  return storage
    .listGates(projectId)
    .filter((gate) => gate.status === "pending");
}

function reviewSessionGates(projectId: string, sessionId: string): HumanGateItem[] {
  return storage
    .listGates(projectId)
    .filter((gate) => parsePayload(gate.payload).reviewSessionId === sessionId);
}

function resetDueDeferredGates(projectId: string, at: Date): number {
  const atMs = at.getTime();
  let reset = 0;
  for (const gate of storage.listGates(projectId)) {
    if (gate.status !== "deferred") continue;
    const dueMs = Date.parse(gate.deferUntil ?? "");
    if (Number.isFinite(dueMs) && dueMs > atMs) continue;
    humanGateService.systemAnnotate(gate.id, {
      actor: "scheduler",
      reason: "deferred gate returned to pending at review window boundary",
      patch: {
        status: "pending",
        decision: null,
        deferUntil: null,
      },
    });
    reset += 1;
  }
  return reset;
}

function revalidatePendingGatesForWindow(projectId: string, atIso: string, reviewSessionId: string): number {
  let revalidated = 0;
  for (const gate of pendingReviewGates(projectId)) {
    const payload = parsePayload(gate.payload);
    humanGateService.systemAnnotate(gate.id, {
      actor: "scheduler",
      reason: "review window evidence revalidation",
      patch: {
        payload: JSON.stringify({
          ...payload,
          reviewSessionId,
        }),
        evidenceRevalidatedAt: atIso,
        evidenceChanged: 0,
      },
    });
    revalidated += 1;
  }
  return revalidated;
}

async function closeReviewSession(
  projectId: string,
  sessionId: string,
  bus: NotificationBus | null | undefined,
  at: Date,
): Promise<{ closedSessionId?: string; summarySent: boolean; missedWindowsIncremented: number }> {
  const session = storage.listReviewSessions(projectId).find((item) => item.id === sessionId && item.closedAt == null);
  if (!session) return { summarySent: false, missedWindowsIncremented: 0 };

  const sessionGates = reviewSessionGates(projectId, session.id);
  const scopedGates = sessionGates.length > 0 ? sessionGates : storage.listGates(projectId);
  const pending = scopedGates.filter((gate) => gate.status === "pending");
  const deferred = scopedGates.filter((gate) => gate.status === "deferred");
  for (const gate of pending) {
    humanGateService.systemAnnotate(gate.id, {
      actor: "scheduler",
      reason: "review window closed with gate still pending",
      patch: {
        missedWindows: (gate.missedWindows ?? 0) + 1,
      },
    });
  }
  const resolved = Math.max(0, session.gatesTotal - pending.length - deferred.length);
  storage.updateReviewSession(session.id, {
    closedAt: at.toISOString(),
    gatesResolved: resolved,
    gatesDeferred: deferred.length,
  });

  if (bus) {
    await emitReviewWindowSummary(bus, projectId, {
      resolved,
      deferred: deferred.length,
      missed: pending.length,
    });
  }

  return {
    closedSessionId: session.id,
    summarySent: Boolean(bus),
    missedWindowsIncremented: pending.length,
  };
}

export async function processReviewWindowTick(
  projectId: string,
  bus: NotificationBus | null = null,
  at = new Date(),
): Promise<ReviewWindowTickResult> {
  const state = reviewWindowState(at);
  if (reviewPaused()) {
    return {
      state,
      digestSent: false,
      summarySent: false,
      missedWindowsIncremented: 0,
      deferredReset: 0,
    };
  }
  const atIso = at.toISOString();
  const deferredReset = resetDueDeferredGates(projectId, at);
  let openSession = storage.getOpenReviewSession(projectId);
  let closedSessionId: string | undefined;
  let summarySent = false;
  let missedWindowsIncremented = 0;

  if (openSession && (!state.inWindow || !sameReviewWindow(openSession.openedAt, state))) {
    const closed = await closeReviewSession(projectId, openSession.id, bus, at);
    closedSessionId = closed.closedSessionId;
    summarySent = closed.summarySent;
    missedWindowsIncremented = closed.missedWindowsIncremented;
    openSession = undefined;
  }

  if (!state.inWindow) {
    return {
      state,
      closedSessionId,
      digestSent: false,
      summarySent,
      missedWindowsIncremented,
      deferredReset,
    };
  }

  if (openSession) {
    return {
      state,
      digestSent: false,
      summarySent,
      missedWindowsIncremented,
      deferredReset,
    };
  }

  const pending = pendingReviewGates(projectId);
  const sessionId = reviewSessionId(projectId, state);
  const session = storage.createReviewSession({
    id: sessionId,
    projectId,
    source: "scheduled",
    openedAt: atIso,
    closedAt: null,
    gatesTotal: pending.length,
    gatesResolved: 0,
    gatesDeferred: 0,
    digestMessageId: null,
    summaryMessageId: null,
  });
  revalidatePendingGatesForWindow(projectId, atIso, session.id);

  let digestSent = false;
  if (bus && !storage.getNotificationDigest(projectId, state.windowDate, state.windowLabel)) {
    storage.createNotificationDigest({
      projectId,
      windowDate: state.windowDate,
      windowLabel: state.windowLabel,
      sentAt: atIso,
      messageId: null,
    });
    await emitReviewWindowDigest(bus, projectId, state, pending.filter((gate) => (gate.notifyPolicy ?? "next_window") !== "immediate"));
    digestSent = true;
  }

  return {
    state,
    openedSessionId: session.id,
    closedSessionId,
    digestSent,
    summarySent,
    missedWindowsIncremented,
    deferredReset,
  };
}

function activeSpeculativeChild(projectId: string, parentCycleId: string): Cycle | undefined {
  return storage.listCycles(projectId).find((cycle) => (
    cycle.speculative === 1 &&
    cycle.parentCycleId === parentCycleId &&
    cycle.status !== "closed" &&
    !["invalidated", "applied_observing"].includes(cycle.draftStatus ?? "")
  ));
}

function speculativeDependencyIds(projectId: string, current: Cycle): string[] {
  const deps = new Set<string>();
  let cursor: Cycle | undefined = current;
  while (cursor) {
    if ((cursor.draftStatus ?? "") !== "applied_observing" && !cursor.appliedAt) deps.add(cursor.id);
    cursor = cursor.parentCycleId ? storage.getCycle(cursor.parentCycleId) : undefined;
  }
  for (const cycle of storage.listCycles(projectId)) {
    if (cycle.speculative !== 1) continue;
    if (!["ready_awaiting_approval", "apply_queued"].includes(cycle.draftStatus ?? "")) continue;
    deps.add(cycle.id);
  }
  return Array.from(deps);
}

function speculativeBudgetExhausted(projectId: string): { exhausted: boolean; state: LlmBudgetState; limitUsd: number } {
  const state = llmBudgetForProject(projectId);
  const limitUsd = +(state.budgetUsd * speculativeBudgetRatioFromEnv()).toFixed(6);
  return {
    exhausted: state.usedUsd > limitUsd,
    state,
    limitUsd,
  };
}

function speculativeClaimForDraft(cycleIdx: number, draft: NextGoalDraft) {
  return {
    id: `claim_spec_${cycleIdx}_${draft.prediction.metric.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
    type: "metric_threshold",
    metric: draft.prediction.metric,
    operator: draft.prediction.operator,
    target: draft.prediction.target,
    weight: 3,
    expectedObservation: draft.prediction.statement,
    timeWindow: "after_apply_observation_window",
    successThreshold: `${draft.prediction.metric} ${draft.prediction.operator} ${draft.prediction.target}`,
    failureThreshold: `${draft.prediction.metric} ${draft.prediction.operator === ">=" ? "<" : ">"} ${draft.prediction.target}`,
    uncertainty: 0.4,
  };
}

function safeIdPart(value: string, maxLength = 96): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, maxLength);
}

function speculativeBuilderTaskId(childId: string): string {
  return `task_speculative_builder_${safeIdPart(childId)}`;
}

function speculativeApplyGateId(childId: string): string {
  return `gate_spec_apply_${childId.slice(-32)}`;
}

function speculativeDraftArtifactsComplete(childId: string): boolean {
  return storage.listPredictions(childId).length > 0 &&
    storage.listTasks(childId).some((task) => task.agent === "builder" && task.kind === "speculative_change_package") &&
    Boolean(storage.getGate(speculativeApplyGateId(childId)));
}

async function generateSpeculativeGoalDraft(projectId: string, cycleIdx: number, cycleId: string, current: Cycle): Promise<NextGoalDraft> {
  try {
    return await generateNextGoal(buildNextGoalInput(projectId, cycleIdx, cycleId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no eligible knowledge/i.test(message)) throw error;
    const project = storage.getProject(projectId);
    storage.recordEvent({
      cycleIdx,
      actor: "scheduler",
      tableName: "cycles",
      op: "speculative_seed_fallback",
      before: null,
      after: JSON.stringify({ projectId, cycleId, parentCycleId: current.id, reason: message }),
      ts: now(),
    });
    return {
      proposedGoal: `准备 ${current.goal || project?.direction || "下一轮方向"} 的 dry-run 审计草稿`,
      belief: "当前阻断闸仍待审批；系统只能准备可回滚、可审计的草稿，不执行真实观察或知识晋级。",
      prediction: {
        statement: `${project?.firstClaimMetric ?? "activation_rate"} ${project?.firstClaimOperator ?? ">="} ${project?.firstClaimTarget ?? 0.3}`,
        metric: project?.firstClaimMetric ?? "activation_rate",
        operator: project?.firstClaimOperator === "<=" ? "<=" : ">=",
        target: project?.firstClaimTarget ?? 0.3,
      },
      action: `生成 ${current.goal || project?.direction || "下一轮方向"} 的 dry-run change package、rollback plan 和 audit summary`,
      alternativeGoals: [],
      referencedKnowledgeIds: [],
      reasoningHowKnowledgeChangedDecision: `无可复用 active/strong 知识时使用 project seed 生成推测草稿；父 cycle ${current.id} 获批前不会 apply。`,
    };
  }
}

async function createSpeculativeDraft(projectId: string, current: Cycle): Promise<SchedulerTickResult> {
  const llmBudget = llmBudgetForProject(projectId);
  if (!speculativeDraftingFromEnv()) {
    return {
      projectId,
      action: "waiting_blocking_gate",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget,
      note: "waiting for blocking human gate; speculative drafting is disabled",
    };
  }

  const budget = speculativeBudgetExhausted(projectId);
  if (budget.exhausted) {
    storage.recordEvent({
      cycleIdx: current.idx,
      actor: "scheduler",
      tableName: "cycles",
      op: "speculative_budget_exhausted",
      before: null,
      after: JSON.stringify({
        projectId,
        cycleId: current.id,
        usedUsd: budget.state.usedUsd,
        limitUsd: budget.limitUsd,
        ratio: speculativeBudgetRatioFromEnv(),
        ts: now(),
      }),
      ts: now(),
    });
    recordTrace({
      projectId,
      cycleId: current.id,
      cycleIdx: current.idx,
      kind: "scheduler",
      name: "speculative_budget_exhausted",
      agent: "scheduler",
      status: "blocked",
      attributes: {
        usedUsd: budget.state.usedUsd,
        limitUsd: budget.limitUsd,
        ratio: speculativeBudgetRatioFromEnv(),
      },
    });
    return {
      projectId,
      action: "speculative_budget_exhausted",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: budget.state,
      note: `speculative drafting paused; LLM spend ${budget.state.usedUsd} exceeds speculative limit ${budget.limitUsd}`,
    };
  }

  const existing = activeSpeculativeChild(projectId, current.id);
  if (existing && existing.draftStatus !== "drafting" && speculativeDraftArtifactsComplete(existing.id)) {
    return {
      projectId,
      action: "created_speculative_draft",
      cycleId: current.id,
      nextCycleId: existing.id,
      budget: gateBudgetForProject(projectId),
      llmBudget,
      note: `speculative draft already exists with status ${existing.draftStatus ?? "unknown"}`,
    };
  }

  const nextIdx = existing?.idx ?? Math.max(...storage.listCycles(projectId).map((cycle) => cycle.idx), current.idx) + 1;
  const safeProject = projectId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(-32);
  const childId = existing?.id ?? `cycle_spec_${nextIdx}_${safeProject}_${current.id.replace(/[^a-zA-Z0-9_]+/g, "_").slice(-16)}`;
  const draft = await generateSpeculativeGoalDraft(projectId, nextIdx, childId, current);
  const dependsOn = speculativeDependencyIds(projectId, current);
  const assumedOutcomes = dependsOn.map((cycleId) => ({
    cycle: cycleId,
    claim: "blocking_gate_approval",
    assumed: "approved",
  }));
  const claim = speculativeClaimForDraft(nextIdx, draft);
  const predictionId = `pred_spec_${nextIdx}_${childId.slice(-12)}`;
  const adapter = new CodexCliBuilderAdapter();
  const pkg = await adapter.generateChangePackage({
    projectId,
    cycleId: childId,
    goal: draft.action,
    constraints: [
      "speculative draft only",
      "do not apply before approval",
      "prepare rollback plan and audit summary",
    ],
  });
  const taskId = speculativeBuilderTaskId(childId);
  const gateId = speculativeApplyGateId(childId);
  const createdAt = now();
  const writeArtifacts = () => {
    const cycle = existing
      ? storage.updateCycle(existing.id, {
          goal: draft.proposedGoal,
          status: existing.status === "closed" ? "planning" : existing.status,
          reasoning: draft.reasoningHowKnowledgeChangedDecision,
          parentCycleId: current.id,
          dependsOn: JSON.stringify(dependsOn),
          assumedOutcomes: JSON.stringify(assumedOutcomes),
          draftStatus: "drafting",
        }) ?? existing
      : storage.createCycle({
          id: childId,
          projectId,
          idx: nextIdx,
          goal: draft.proposedGoal,
          status: "planning",
          eCycle: null,
          worstClaimError: null,
          reasoning: draft.reasoningHowKnowledgeChangedDecision,
          speculative: 1,
          parentCycleId: current.id,
          dependsOn: JSON.stringify(dependsOn),
          assumedOutcomes: JSON.stringify(assumedOutcomes),
          draftStatus: "drafting",
          applyScheduledAt: null,
          appliedAt: null,
          coAppliedSet: null,
          version: 1,
        });

    if (!storage.getPrediction(predictionId)) {
      storage.createPrediction({
        id: predictionId,
        cycleId: childId,
        belief: draft.belief,
        prediction: draft.prediction.statement,
        action: draft.action,
        claims: JSON.stringify([claim]),
        observation: null,
        predictionError: null,
        worstClaimError: null,
        errorType: null,
        updateTarget: null,
        status: "open",
        knowledgeRefs: JSON.stringify(draft.referencedKnowledgeIds),
      });
    }

    if (!storage.listTasks(childId).some((task) => task.id === taskId)) {
      storage.createTask({
        id: taskId,
        cycleId: childId,
        agent: "builder",
        kind: "speculative_change_package",
        status: "done",
        spec: JSON.stringify({
          createdAt,
          draftStatus: "ready_awaiting_approval",
          action: draft.action,
          changePackage: pkg,
          rollbackPlan: pkg.rollbackPlan,
          auditSummary: pkg.auditSummary,
          predictionId,
        }),
      });
    }

    if (!storage.getGate(gateId)) {
      storage.createGate({
        id: gateId,
        cycleId: childId,
        type: "risk",
        blocking: 1,
        title: "推测草稿 apply 审批",
        payload: withDecisionBriefPayload({
          riskKey: "speculative_apply_draft",
          draftCycleId: childId,
          parentCycleId: current.id,
          idempotencyKey: pkg.idempotencyKey,
          riskLevel: pkg.riskLevel,
          goal: draft.proposedGoal,
          action: draft.action,
          affectedFiles: pkg.affectedFiles,
          rollbackPlan: pkg.rollbackPlan,
          auditSummary: pkg.auditSummary,
          assumedOutcomes,
          createdAt,
        }, createDecisionBrief({
          claim: `Apply speculative draft: ${draft.proposedGoal}`,
          citedKnowledgeIds: draft.referencedKnowledgeIds,
          metric: draft.prediction.metric,
          operator: draft.prediction.operator,
          target: draft.prediction.target,
          timeWindow: "after apply observation window",
          ifApproved: "Queue the speculative draft for grace-period apply and observation.",
          ifRejected: "Invalidate or keep the speculative draft from applying; no observation or knowledge promotion occurs.",
          rollbackRef: "payload.rollbackPlan",
        })),
        status: "pending",
        estimatedMinutes: 12,
        decision: null,
        version: 1,
      });
    }

    const ready = storage.updateCycle(cycle.id, { draftStatus: "ready_awaiting_approval" }) ?? cycle;
    storage.recordAgentRun({
      cycleId: childId,
      cycleIdx: nextIdx,
      agent: "builder",
      action: "speculative_draft_change_package",
      outputSummary: `draft ready awaiting approval: ${pkg.diffSummary}`,
      knowledgeRefsUsed: JSON.stringify(draft.referencedKnowledgeIds),
      ts: createdAt,
    });
    return ready;
  };
  const ready = storage.withTransaction ? storage.withTransaction(writeArtifacts) : writeArtifacts();
  recordTrace({
    projectId,
    cycleId: childId,
    cycleIdx: nextIdx,
    kind: "scheduler",
    name: "speculative_draft_ready",
    agent: "scheduler",
    attributes: {
      parentCycleId: current.id,
      dependsOn,
      draftStatus: ready.draftStatus,
      predictionId,
      idempotencyKey: pkg.idempotencyKey,
    },
  });

  return {
    projectId,
    action: "created_speculative_draft",
    cycleId: current.id,
    nextCycleId: childId,
    budget: gateBudgetForProject(projectId),
    llmBudget: llmBudgetForProject(projectId),
    note: "created speculative draft and stopped at approval boundary",
  };
}

async function schedulerTickProjectUnlocked(projectId: string, options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  reconcileSpeculativeAssumptions(projectId);
  const applyResult = await runApplyExecutor(projectId);
  if (applyResult.applied > 0) {
    return {
      projectId,
      action: "apply_executor_ran",
      cycleId: applyResult.appliedCycleIds[0],
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: `apply executor marked ${applyResult.applied} speculative draft(s) as applied_observing`,
    };
  }

  const beforeDecayKnowledge = knowledgeConflictSnapshot(projectId);
  decayStaleKnowledge(projectId);
  detectConflictsForChangedKnowledge(projectId, beforeDecayKnowledge);
  createKnowledgeReviewReminders(projectId);
  const initialBudget = executeGateBudget(projectId);
  const humanAttention = enforceHumanAttentionBudget(projectId, initialBudget);
  const budget = gateBudgetForProject(projectId);
  const softSafetyReasons = [
    ...(humanAttention.safetyMode ? ["human attention backlog over budget"] : []),
    ...(budget.safetyMode ? ["blocking gate missed review window threshold"] : []),
  ];
  const softSafety = softSafetyContext(projectId, softSafetyReasons);

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

  if (softSafety.active && !softSafety.shouldAdvance) {
    return safetyThrottleDeferredResult(projectId, current.id, softSafety);
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
          const gate = openEvolutionRiskGate(projectId, current.id, stall.riskKey, stall.evidence);
          if (gate.status === "pending") {
            return {
              projectId,
              action: "safety_mode",
              cycleId: current.id,
              budget: gateBudgetForProject(projectId),
              llmBudget,
              note: `${stall.riskKey} guard triggered; waiting for human review`,
            };
          }
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
    return withSafetyThrottle({
      projectId,
      action: "created_next_cycle",
      cycleId: current.id,
      nextCycleId: next.id,
      budget,
      llmBudget,
      note: "created next planning cycle",
    }, softSafety);
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
    return withSafetyThrottle({
      projectId,
      action: "opened_direction_gate",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: "opened direction gate and paused for human decision",
    }, softSafety);
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
    return withSafetyThrottle(await createSpeculativeDraft(projectId, current), softSafety);
  }

  if (!builderCompleteOrAbsent(current.id)) {
    const degradedCount = degradeTimedOutBuilderTasks(current.id);
    if (degradedCount > 0 && builderCompleteOrAbsent(current.id)) {
      const afterDegradeBudget = gateBudgetForProject(projectId);
      return withSafetyThrottle({
        projectId,
        action: "waiting_blocking_gate",
        cycleId: current.id,
        budget: afterDegradeBudget,
        llmBudget,
        note: `builder timeout degraded ${degradedCount} task(s); scheduler will continue on the next tick`,
      }, softSafety);
    }
    return withSafetyThrottle({
      projectId,
      action: "waiting_blocking_gate",
      cycleId: current.id,
      budget,
      llmBudget,
      note: "waiting for builder task completion or timeout degradation",
    }, softSafety);
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
    return withSafetyThrottle({
      projectId,
      action: "waiting_feedback_window",
      cycleId: current.id,
      budget: gateBudgetForProject(projectId),
      llmBudget: llmBudgetForProject(projectId),
      note: `sensor feedback window still open (${Math.ceil(feedbackWindow.remainingMs / 1000)}s remaining); synced feedback only`,
    }, softSafety);
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
  const beforeOperationalKnowledge = knowledgeConflictSnapshot(projectId);
  const result = await runOperationalStagesAfterApprovedDirection(projectId, current.id);
  detectConflictsForChangedKnowledge(projectId, beforeOperationalKnowledge);
  return withSafetyThrottle({
    projectId,
    action: "ran_operational_stages",
    cycleId: current.id,
    budget: gateBudgetForProject(projectId),
    llmBudget: llmBudgetForProject(projectId),
    note: `closed cycle ${result.cycleIdx}; scheduler can create next cycle on next tick`,
  }, softSafety);
}

export async function schedulerTickProject(projectId: string, options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  const executeTick = async (): Promise<SchedulerTickResult> => {
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
    try {
      const bus = await getNotificationBus();
      await processReviewWindowTick(projectId, bus);
      const beforePendingGateIds = bus ? pendingGateIds(projectId) : new Set<string>();
      const result = await schedulerTickProjectUnlocked(projectId, options);
      if (bus) emitSchedulerNotifications(bus, beforePendingGateIds, result);
      return result;
    } finally {
      runningProjectTicks.delete(projectId);
    }
  };

  const cycles = storage.listCycles(projectId);
  const current = cycles.find((cycle) => cycle.status !== "closed") ?? cycles.at(-1);
  return withKnowledgeRetrievalIdentity(
    options.knowledgeRetrievalIdentity,
    { projectId, cycleId: current?.id ?? "" },
    executeTick,
  );
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
