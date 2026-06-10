import { applyGraceSecondsFromEnv, applyStaggerSecondsFromEnv } from "./config/env";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";
import type { Cycle } from "@shared/schema";
import { HumanGateService } from "./humanGateService";

export interface ApplyExecutorResult {
  projectId: string;
  considered: number;
  applied: number;
  skippedGrace: number;
  appliedCycleIds: string[];
}

export interface SpeculativeInvalidationResult {
  projectId: string;
  invalidatedCycleIds: string[];
}

function approvalAnchorMs(cycle: Cycle): number {
  const scheduled = Date.parse(cycle.applyScheduledAt ?? "");
  return Number.isFinite(scheduled) ? scheduled : Date.parse(now());
}

function applyEligible(cycle: Cycle, at: Date): boolean {
  const graceMs = applyGraceSecondsFromEnv() * 1000;
  return at.getTime() >= approvalAnchorMs(cycle) + graceMs;
}

export async function runApplyExecutor(projectId: string, at = new Date()): Promise<ApplyExecutorResult> {
  const queued = storage
    .listCycles(projectId)
    .filter((cycle) => cycle.speculative === 1 && cycle.draftStatus === "apply_queued")
    .sort((a, b) => Date.parse(a.applyScheduledAt ?? "") - Date.parse(b.applyScheduledAt ?? ""));
  const eligible = queued.filter((cycle) => applyEligible(cycle, at));
  const coAppliedSet = JSON.stringify(eligible.map((cycle) => cycle.id));
  const staggerMs = applyStaggerSecondsFromEnv() * 1000;
  const appliedCycleIds: string[] = [];

  eligible.forEach((cycle, index) => {
    const appliedAt = new Date(at.getTime() + index * staggerMs).toISOString();
    storage.updateCycle(cycle.id, {
      status: "running",
      draftStatus: "applied_observing",
      appliedAt,
      coAppliedSet,
    });
    storage.recordEvent({
      cycleIdx: cycle.idx,
      actor: "apply_executor",
      tableName: "cycles",
      op: "speculative_apply_marked",
      before: JSON.stringify({ draftStatus: cycle.draftStatus, applyScheduledAt: cycle.applyScheduledAt }),
      after: JSON.stringify({ cycleId: cycle.id, draftStatus: "applied_observing", appliedAt, coAppliedSet }),
      ts: at.toISOString(),
    });
    recordTrace({
      projectId,
      cycleId: cycle.id,
      cycleIdx: cycle.idx,
      kind: "scheduler",
      name: "speculative_apply_marked",
      agent: "apply_executor",
      attributes: {
        applyScheduledAt: cycle.applyScheduledAt,
        appliedAt,
        coAppliedSet: eligible.map((item) => item.id),
      },
    });
    appliedCycleIds.push(cycle.id);
  });

  return {
    projectId,
    considered: queued.length,
    applied: appliedCycleIds.length,
    skippedGrace: queued.length - eligible.length,
    appliedCycleIds,
  };
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseGatePayload(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cycleDependsOn(cycle: Cycle, ancestorCycleId: string): boolean {
  return parseJsonArray(cycle.dependsOn).includes(ancestorCycleId);
}

function assumptionFailed(cycle: Cycle): boolean {
  if (cycle.speculative !== 1 || cycle.draftStatus !== "applied_observing") return false;
  return storage.listPredictions(cycle.id).some((prediction) => (
    prediction.status === "resolved" &&
    Math.max(prediction.predictionError ?? 0, prediction.worstClaimError ?? 0) >= 0.7
  ));
}

export function invalidateSpeculativeDescendants(
  projectId: string,
  ancestorCycleId: string,
  reason: string,
): SpeculativeInvalidationResult {
  const gateService = new HumanGateService(storage);
  const descendants = storage
    .listCycles(projectId)
    .filter((cycle) => cycle.speculative === 1)
    .filter((cycle) => ["drafting", "ready_awaiting_approval", "apply_queued"].includes(cycle.draftStatus ?? ""))
    .filter((cycle) => cycleDependsOn(cycle, ancestorCycleId));
  const invalidatedCycleIds: string[] = [];

  for (const cycle of descendants) {
    storage.updateCycle(cycle.id, { draftStatus: "invalidated" });
    for (const gate of storage.listGates(projectId)) {
      if (gate.status !== "pending") continue;
      const payload = parseGatePayload(gate.payload);
      if (payload.riskKey !== "speculative_apply_draft" || payload.draftCycleId !== cycle.id) continue;
      gateService.systemResolve(gate.id, "invalidated_by_system", {
        actor: "scheduler",
        status: "modified",
        via: "speculative_invalidation",
        reason,
      });
    }
    storage.recordEvent({
      cycleIdx: cycle.idx,
      actor: "scheduler",
      tableName: "cycles",
      op: "speculative_chain_invalidated",
      before: JSON.stringify({ draftStatus: cycle.draftStatus, dependsOn: cycle.dependsOn }),
      after: JSON.stringify({ cycleId: cycle.id, ancestorCycleId, reason, draftStatus: "invalidated" }),
      ts: now(),
    });
    recordTrace({
      projectId,
      cycleId: cycle.id,
      cycleIdx: cycle.idx,
      kind: "scheduler",
      name: "speculative_chain_invalidated",
      agent: "scheduler",
      status: "blocked",
      attributes: {
        ancestorCycleId,
        reason,
      },
    });
    invalidatedCycleIds.push(cycle.id);
  }

  return { projectId, invalidatedCycleIds };
}

export function reconcileSpeculativeAssumptions(projectId: string): SpeculativeInvalidationResult {
  const invalidated = new Set<string>();
  for (const cycle of storage.listCycles(projectId).filter(assumptionFailed)) {
    const result = invalidateSpeculativeDescendants(
      projectId,
      cycle.id,
      "ancestor observed prediction error exceeded speculative assumption threshold",
    );
    for (const id of result.invalidatedCycleIds) invalidated.add(id);
  }
  return { projectId, invalidatedCycleIds: Array.from(invalidated) };
}
