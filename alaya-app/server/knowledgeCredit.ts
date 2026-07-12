import { now, storage } from "./storage";
import type { EventLogItem, KnowledgeItem, Prediction, TraceEventItem } from "@shared/schema";

const CREDIT_ACTOR = "knowledge_credit";
const CREDIT_TABLE = "knowledge_items";
const CREDIT_OP = "credit";

export type CreditOutcome = {
  cycleId: string;
  predictionId?: string | null;
  correct: boolean;
};

export type CreditUpdate = {
  cycleId: string;
  predictionId: string | null;
  knowledgeId: string;
  outcome: "correct" | "wrong";
  evidenceAlphaDelta: number;
  evidenceBetaDelta: number;
  idempotencyKey: string;
};

export type CreditSkipReason = "already_credited" | "knowledge_missing" | "update_failed";

export type CreditApplyResult = {
  applied: CreditUpdate[];
  skipped: Array<CreditUpdate & { reason: CreditSkipReason }>;
};

type CreditStore = {
  withTransaction?<T>(fn: () => T): T;
  getKnowledge(id: string): KnowledgeItem | undefined;
  updateKnowledge(id: string, patch: Partial<KnowledgeItem> & { actor?: string }): KnowledgeItem | undefined;
  recordEvent(event: Omit<EventLogItem, "id">): void;
  getKnowledgeCreditEvent(cycleId: string, knowledgeId: string): EventLogItem | undefined;
};

export type CreditApplyContext = {
  store?: CreditStore;
  cycleIdx?: number | null;
  nowIso?: () => string;
};

function creditKey(cycleId: string, knowledgeId: string): string {
  return `${CREDIT_ACTOR}:${cycleId}:${knowledgeId}`;
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawId of ids) {
    const id = String(rawId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function computeCreditUpdates(injectedIds: readonly string[], outcome: CreditOutcome): CreditUpdate[] {
  const normalizedOutcome = outcome.correct ? "correct" : "wrong";
  return uniqueIds(injectedIds).map((knowledgeId) => ({
    cycleId: outcome.cycleId,
    predictionId: outcome.predictionId ?? null,
    knowledgeId,
    outcome: normalizedOutcome,
    evidenceAlphaDelta: outcome.correct ? 1 : 0,
    evidenceBetaDelta: outcome.correct ? 0 : 1,
    idempotencyKey: creditKey(outcome.cycleId, knowledgeId),
  }));
}

function parseJsonObject(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function confidenceLevelFor(alpha: number, beta: number, humanApprovedCount: number): KnowledgeItem["confidenceLevel"] {
  const score = alpha / (alpha + beta);
  const evCount = Math.max(0, (alpha - 1) + (beta - 1));
  if (score >= 0.85 && evCount >= 5 && humanApprovedCount > 0) return "verified";
  if (score >= 0.75 && evCount >= 3) return "high";
  if (score >= 0.6 && evCount >= 1) return "medium";
  return "low";
}

function creditEventPayload(update: CreditUpdate, knowledge: KnowledgeItem) {
  return {
    idempotencyKey: update.idempotencyKey,
    cycleId: update.cycleId,
    predictionId: update.predictionId,
    knowledgeId: update.knowledgeId,
    outcome: update.outcome,
    evidenceAlphaDelta: update.evidenceAlphaDelta,
    evidenceBetaDelta: update.evidenceBetaDelta,
    knowledge,
  };
}

export function applyCreditUpdates(updates: readonly CreditUpdate[], ctx: CreditApplyContext = {}): CreditApplyResult {
  const store = ctx.store ?? storage;
  const result: CreditApplyResult = { applied: [], skipped: [] };

  for (const update of updates) {
    const applyOne = () => {
      if (store.getKnowledgeCreditEvent(update.cycleId, update.knowledgeId)) {
        result.skipped.push({ ...update, reason: "already_credited" });
        return;
      }

      const before = store.getKnowledge(update.knowledgeId);
      if (!before) {
        result.skipped.push({ ...update, reason: "knowledge_missing" });
        return;
      }

      const evidenceAlpha = before.evidenceAlpha + update.evidenceAlphaDelta;
      const evidenceBeta = before.evidenceBeta + update.evidenceBetaDelta;
      const confidenceScore = evidenceAlpha / (evidenceAlpha + evidenceBeta);
      const confidenceLevel = confidenceLevelFor(evidenceAlpha, evidenceBeta, before.humanApprovedCount);
      const after = store.updateKnowledge(update.knowledgeId, {
        evidenceAlpha,
        evidenceBeta,
        confidenceScore,
        confidenceLevel,
        actor: CREDIT_ACTOR,
      });

      if (!after) {
        result.skipped.push({ ...update, reason: "update_failed" });
        return;
      }

      store.recordEvent({
        cycleIdx: ctx.cycleIdx ?? after.lastValidatedCycle ?? after.createdByCycle ?? 0,
        actor: CREDIT_ACTOR,
        tableName: CREDIT_TABLE,
        op: CREDIT_OP,
        before: JSON.stringify(creditEventPayload(update, before)),
        after: JSON.stringify(creditEventPayload(update, after)),
        ts: ctx.nowIso?.() ?? now(),
      });
      result.applied.push(update);
    };
    if (store.withTransaction) store.withTransaction(applyOne);
    else applyOne();
  }

  return result;
}

function parseInjectedIds(attributes: string | null | undefined): string[] {
  const parsed = parseJsonObject(attributes);
  const ids = parsed.injectedKnowledgeIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

export function injectedKnowledgeIdsFromTrace(events: readonly Pick<TraceEventItem, "attributes">[]): string[] {
  return uniqueIds(events.flatMap((event) => parseInjectedIds(event.attributes)));
}

export function predictionCreditOutcome(
  prediction: Pick<Prediction, "status" | "predictionError" | "worstClaimError">,
): "correct" | "wrong" | null {
  if (prediction.status !== "resolved") return null;
  const error = prediction.worstClaimError ?? prediction.predictionError;
  if (typeof error !== "number" || !Number.isFinite(error)) return null;
  return error <= 0 ? "correct" : "wrong";
}

export function creditResolvedPredictionFromTrace(
  prediction: Pick<Prediction, "id" | "cycleId" | "status" | "predictionError" | "worstClaimError">,
  traceEvents: readonly Pick<TraceEventItem, "attributes">[],
  ctx: CreditApplyContext = {},
): CreditApplyResult {
  const outcome = predictionCreditOutcome(prediction);
  if (!outcome) return { applied: [], skipped: [] };
  const injectedIds = injectedKnowledgeIdsFromTrace(traceEvents);
  const updates = computeCreditUpdates(injectedIds, {
    cycleId: prediction.cycleId,
    predictionId: prediction.id,
    correct: outcome === "correct",
  });
  return applyCreditUpdates(updates, ctx);
}
