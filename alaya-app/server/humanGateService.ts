import { makeIdempotencyKey } from "@shared/core/action_risk.js";
import { applyEvidence } from "@shared/core/update_confidence.js";
import type { HumanGateItem } from "@shared/schema";
import { auditCapabilityDecision, evaluateCapability, CapabilityDeniedError } from "./security/capabilities";
import { redactSensitiveData } from "./security/redact";
import { storage, now, type IStorage } from "./storage";
import { recordTrace } from "./trace";
import { runKnowledgeConflictDetector } from "./knowledgeConflictHooks";
import { nextReviewWindowStartIso } from "./reviewWindow";

export type GateDecisionAction = "approve" | "reject" | "modify";
export type RejectReasonCode = "wrong_direction" | "weak_evidence" | "not_now" | "too_risky";

export interface ResolveGateInput {
  rationale?: string;
  via?: string;
  actor?: string;
  reasonCode?: RejectReasonCode;
  reviewOpenedAt?: string | Date | number | null;
}

export interface ResolveGateResult {
  gate: HumanGateItem;
  dryRun: boolean;
}

export interface SystemGateTransitionInput {
  actor?: string;
  reason?: string;
  via?: string;
  status?: string;
  patch?: Partial<HumanGateItem>;
}

export interface SystemGateAnnotationInput {
  actor?: string;
  reason?: string;
  patch: Partial<HumanGateItem>;
}

export interface SystemGateMergeInput {
  actor?: string;
  reason?: string;
}

function decisionStatus(action: GateDecisionAction): HumanGateItem["status"] {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  return "modified";
}

function projectIdForGate(store: IStorage, gate: HumanGateItem): string {
  return store.getCycle(gate.cycleId)?.projectId ?? "system";
}

function actionLedgerId(idempotencyKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < idempotencyKey.length; i += 1) {
    hash ^= idempotencyKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `gate_decision_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function auditGateDecision(
  store: IStorage,
  gate: HumanGateItem,
  action: string,
  status: "approved" | "blocked" | "dry_run",
  input: ResolveGateInput,
) {
  const projectId = projectIdForGate(store, gate);
  const payload = redactSensitiveData({
    gateId: gate.id,
    gateType: gate.type,
    blocking: gate.blocking === 1,
    action,
    via: input.via ?? "web",
    rationale: input.rationale ?? "",
    reasonCode: input.reasonCode ?? null,
  }) as Record<string, unknown>;
  const idempotencyKey = makeIdempotencyKey({
    projectId,
    cycleId: gate.cycleId,
    actionType: `human_gate.${action}`,
    target: gate.id,
    payload,
  });
  const timestamp = now();
  store.upsertActionLedger({
    id: actionLedgerId(idempotencyKey),
    projectId,
    cycleId: gate.cycleId,
    actionType: `human_gate.${action}`,
    target: gate.id,
    riskLevel: gate.blocking === 1 ? "external_write" : "local_write",
    requiresApproval: 1,
    approvalGateId: gate.id,
    idempotencyKey,
    status,
    rollbackPlan: null,
    auditSummary: JSON.stringify({
      gateId: gate.id,
      action,
      status,
      via: input.via ?? "web",
      reasonCode: input.reasonCode ?? null,
    }),
    payload: JSON.stringify(payload),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function decisionId(gate: HumanGateItem, action: string): string {
  const safeAction = action.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 48) || "decision";
  return `dec_${gate.id}_${safeAction}_${Date.now().toString(36)}`;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function compact(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function parseGatePayload(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRejectReasonCode(value: string | null | undefined): RejectReasonCode | null {
  if (value === "risk_too_high") return "too_risky";
  if (value === "wrong_direction" || value === "weak_evidence" || value === "not_now" || value === "too_risky") return value;
  return null;
}

function requireRejectReasonCode(value: string | null | undefined): RejectReasonCode {
  const reason = normalizeRejectReasonCode(value);
  if (!reason) {
    throw new Error("reject requires reason_code: wrong_direction | weak_evidence | not_now | too_risky");
  }
  return reason;
}

function reviewDwellMs(input: ResolveGateInput): number | null {
  if (input.reviewOpenedAt == null) return null;
  const openedMs = input.reviewOpenedAt instanceof Date
    ? input.reviewOpenedAt.getTime()
    : typeof input.reviewOpenedAt === "number"
      ? input.reviewOpenedAt
      : Date.parse(input.reviewOpenedAt);
  if (!Number.isFinite(openedMs)) return null;
  return Math.max(0, Date.now() - openedMs);
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function knowledgeIdForMeaningGate(gateId: string): string {
  return `kb_gate_${gateId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 96)}`;
}

function isSystemDiagnosticMeaningGate(gate: HumanGateItem, payload: Record<string, any>): boolean {
  const source = stringValue(payload.source);
  return (
    source === "system_diagnostic" ||
    gate.id.startsWith("gate_llm_") ||
    (gate.title.startsWith("LLM 输出降级") && Boolean(payload.promptVersion))
  );
}

export class HumanGateService {
  constructor(private store: IStorage = storage) {}

  private inTransaction<T>(fn: () => T): T {
    return this.store.withTransaction ? this.store.withTransaction(fn) : fn();
  }

  private updateSpeculativeDraftFromGate(gate: HumanGateItem, decision: string, status: string): void {
    const payload = parseGatePayload(gate.payload);
    if (payload.riskKey !== "speculative_apply_draft") return;
    const draftCycleId = stringValue(payload.draftCycleId);
    if (!draftCycleId) return;
    const draft = this.store.getCycle(draftCycleId);
    if (!draft) return;
    const cycle = this.store.getCycle(gate.cycleId);
    const projectId = cycle?.projectId ?? projectIdForGate(this.store, gate);
    const queued = status === "approved" && decision.startsWith("approve");
    const invalidated = status === "rejected" || decision.startsWith("reject");
    if (!queued && !invalidated) return;
    const timestamp = now();
    const nextDraftStatus = queued ? "apply_queued" : "invalidated";
    this.store.updateCycle(draftCycleId, {
      draftStatus: nextDraftStatus,
      applyScheduledAt: queued ? timestamp : draft.applyScheduledAt ?? null,
    });
    this.store.recordEvent({
      cycleIdx: draft.idx,
      actor: "human_gate_service",
      tableName: "cycles",
      op: queued ? "speculative_apply_queued" : "speculative_draft_invalidated",
      before: JSON.stringify({ draftStatus: draft.draftStatus, applyScheduledAt: draft.applyScheduledAt }),
      after: JSON.stringify({ draftCycleId, gateId: gate.id, decision, draftStatus: nextDraftStatus, ts: timestamp }),
      ts: timestamp,
    });
    recordTrace({
      projectId,
      cycleId: draftCycleId,
      cycleIdx: draft.idx,
      kind: "approval",
      name: queued ? "speculative_apply_queued" : "speculative_draft_invalidated",
      agent: "human_gate_service",
      attributes: {
        gateId: gate.id,
        decision,
        draftStatus: nextDraftStatus,
      },
    });
  }

  private invalidateSpeculativeDescendants(
    projectId: string,
    ancestorCycleId: string,
    reason: string,
    actor: string,
  ): string[] {
    const descendants = this.store
      .listCycles(projectId)
      .filter((cycle) => cycle.speculative === 1)
      .filter((cycle) => ["drafting", "ready_awaiting_approval", "apply_queued"].includes(cycle.draftStatus ?? ""))
      .filter((cycle) => parseJsonArray(cycle.dependsOn).includes(ancestorCycleId));
    const invalidated: string[] = [];

    for (const cycle of descendants) {
      this.store.updateCycle(cycle.id, { draftStatus: "invalidated" });
      for (const gate of this.store.listGates(projectId)) {
        if (gate.status !== "pending") continue;
        const payload = parseGatePayload(gate.payload);
        if (payload.riskKey !== "speculative_apply_draft" || payload.draftCycleId !== cycle.id) continue;
        this.applySystemResolve(gate, "invalidated_by_system", {
          actor,
          status: "modified",
          via: "speculative_reject_cascade",
          reason,
        });
      }
      this.store.recordEvent({
        cycleIdx: cycle.idx,
        actor,
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
        agent: actor,
        status: "blocked",
        attributes: {
          ancestorCycleId,
          reason,
        },
      });
      invalidated.push(cycle.id);
    }

    return invalidated;
  }

  private cascadeSpeculativeReject(gate: HumanGateItem, reasonCode: RejectReasonCode, actor: string): void {
    if (!["wrong_direction", "weak_evidence"].includes(reasonCode)) return;
    const payload = parseGatePayload(gate.payload);
    if (payload.riskKey !== "speculative_apply_draft") return;
    const draftCycleId = stringValue(payload.draftCycleId);
    if (!draftCycleId) return;
    const projectId = this.store.getCycle(draftCycleId)?.projectId ?? projectIdForGate(this.store, gate);
    this.invalidateSpeculativeDescendants(
      projectId,
      draftCycleId,
      `ancestor speculative draft rejected with reason_code=${reasonCode}`,
      actor,
    );
  }

  approve(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    return this.resolve(gateId, "approve", input);
  }

  reject(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    return this.resolve(gateId, "reject", input);
  }

  modify(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    return this.resolve(gateId, "modify", input);
  }

  defer(gateId: string, until?: string | Date | null, input: ResolveGateInput = {}): ResolveGateResult {
    const gate = this.store.getGate(gateId);
    if (!gate) throw new Error(`human gate not found: ${gateId}`);
    const projectId = projectIdForGate(this.store, gate);
    const capability = evaluateCapability("knowledge_write");
    auditCapabilityDecision({
      actor: input.actor ?? "human_gate_service",
      capability: "knowledge_write",
      target: `human_gate.defer:${gate.id}`,
      projectId,
      cycleId: gate.cycleId,
      approvalId: gate.id,
      payload: { gateId: gate.id, via: input.via ?? "web" },
    }, capability);
    if (capability.dryRun) {
      auditGateDecision(this.store, gate, "defer", "dry_run", input);
      return { gate, dryRun: true };
    }
    if (!capability.allowed) {
      auditGateDecision(this.store, gate, "defer", "blocked", input);
      throw new CapabilityDeniedError(capability);
    }
    if (gate.status !== "pending") return { gate, dryRun: false };

    return this.inTransaction(() => {
      const untilDate = until instanceof Date
        ? until
        : typeof until === "string" && until.trim()
          ? new Date(until)
          : null;
      if (untilDate && !Number.isFinite(untilDate.getTime())) {
        throw new Error(`invalid defer until timestamp: ${String(until)}`);
      }
      const untilIso = untilDate ? untilDate.toISOString() : nextReviewWindowStartIso(new Date());
      const dwell = reviewDwellMs(input);
      const updated = this.store.updateGate(gate.id, {
        status: "deferred",
        decision: "defer",
        deferUntil: untilIso,
        reviewDwellMs: dwell ?? gate.reviewDwellMs ?? null,
        actor: input.actor ?? "human",
      }) ?? gate;
      this.store.createDecision({
        id: decisionId(gate, "defer"),
        cycleId: gate.cycleId,
        gateType: gate.type,
        decision: "defer",
        rationale: input.rationale ?? "",
        ts: now(),
      });
      this.store.recordEvent({
        cycleIdx: this.store.getCycle(gate.cycleId)?.idx ?? 0,
        actor: input.actor ?? "human",
        tableName: "human_gate_items",
        op: "defer",
        before: JSON.stringify({ status: gate.status, gateId: gate.id }),
        after: JSON.stringify({ status: "deferred", gateId: gate.id, deferUntil: untilIso, via: input.via ?? "web" }),
        ts: now(),
      });
      auditGateDecision(this.store, gate, "defer", "approved", input);
      recordTrace({
        projectId,
        cycleId: gate.cycleId,
        cycleIdx: this.store.getCycle(gate.cycleId)?.idx ?? null,
        kind: "approval",
        name: "human_gate_deferred",
        agent: input.actor ?? "human",
        attributes: {
          gateId: gate.id,
          gateType: gate.type,
          deferUntil: untilIso,
          reviewDwellMs: dwell,
        },
      });
      return { gate: updated, dryRun: false };
    });
  }

  revoke(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    const gate = this.store.getGate(gateId);
    if (!gate) throw new Error(`human gate not found: ${gateId}`);
    const payload = parseGatePayload(gate.payload);
    if (payload.riskKey !== "speculative_apply_draft") {
      throw new Error("revoke is only supported for speculative apply gates");
    }
    const draftCycleId = stringValue(payload.draftCycleId);
    const draft = draftCycleId ? this.store.getCycle(draftCycleId) : undefined;
    if (!draft) throw new Error(`speculative draft not found for gate: ${gateId}`);
    if (draft.appliedAt || draft.draftStatus === "applied_observing") {
      throw new Error("cannot revoke after apply; speculative draft has crossed the irreversible apply boundary");
    }
    if (draft.draftStatus !== "apply_queued") {
      throw new Error(`cannot revoke speculative draft in status ${draft.draftStatus ?? "unknown"}; only apply_queued can be revoked`);
    }

    const projectId = draft.projectId ?? projectIdForGate(this.store, gate);
    const capability = evaluateCapability("knowledge_write");
    auditCapabilityDecision({
      actor: input.actor ?? "human_gate_service",
      capability: "knowledge_write",
      target: `human_gate.revoke:${gate.id}`,
      projectId,
      cycleId: gate.cycleId,
      approvalId: gate.id,
      payload: { gateId: gate.id, draftCycleId, via: input.via ?? "web" },
    }, capability);
    if (capability.dryRun) {
      auditGateDecision(this.store, gate, "revoke", "dry_run", input);
      return { gate, dryRun: true };
    }
    if (!capability.allowed) {
      auditGateDecision(this.store, gate, "revoke", "blocked", input);
      throw new CapabilityDeniedError(capability);
    }

    return this.inTransaction(() => {
      const timestamp = now();
      this.store.updateCycle(draft.id, {
        draftStatus: "ready_awaiting_approval",
        applyScheduledAt: null,
      });
      const updated = this.store.updateGate(gate.id, {
        status: "pending",
        decision: "revoked",
        actor: input.actor ?? "human",
        payload: JSON.stringify({
          ...payload,
          revokedAt: timestamp,
        }),
      }) ?? gate;
      this.store.createDecision({
        id: decisionId(gate, "revoked"),
        cycleId: gate.cycleId,
        gateType: gate.type,
        decision: "revoked",
        rationale: input.rationale ?? "",
        ts: timestamp,
      });
      this.store.recordEvent({
        cycleIdx: draft.idx,
        actor: input.actor ?? "human",
        tableName: "human_gate_items",
        op: "revoke",
        before: JSON.stringify({ gateId: gate.id, status: gate.status, decision: gate.decision, draftStatus: draft.draftStatus }),
        after: JSON.stringify({ gateId: gate.id, status: "pending", decision: "revoked", draftCycleId, draftStatus: "ready_awaiting_approval" }),
        ts: timestamp,
      });
      auditGateDecision(this.store, gate, "revoke", "approved", input);
      recordTrace({
        projectId,
        cycleId: draft.id,
        cycleIdx: draft.idx,
        kind: "approval",
        name: "speculative_apply_revoked",
        agent: input.actor ?? "human",
        attributes: {
          gateId: gate.id,
          draftCycleId,
        },
      });
      return { gate: updated, dryRun: false };
    });
  }

  resolve(gateId: string, action: GateDecisionAction, input: ResolveGateInput = {}): ResolveGateResult {
    const gate = this.store.getGate(gateId);
    if (!gate) throw new Error(`human gate not found: ${gateId}`);
    const reasonCode = action === "reject" ? requireRejectReasonCode(input.reasonCode) : null;

    const projectId = projectIdForGate(this.store, gate);
    const decision = evaluateCapability("knowledge_write");
    auditCapabilityDecision({
      actor: input.actor ?? "human_gate_service",
      capability: "knowledge_write",
      target: `human_gate.${action}:${gate.id}`,
      projectId,
      cycleId: gate.cycleId,
      approvalId: gate.id,
      payload: { gateId: gate.id, action, via: input.via ?? "web" },
    }, decision);
    if (decision.dryRun) {
      auditGateDecision(this.store, gate, action, "dry_run", input);
      return { gate, dryRun: true };
    }
    if (!decision.allowed) {
      auditGateDecision(this.store, gate, action, "blocked", input);
      throw new CapabilityDeniedError(decision);
    }
    if (gate.status !== "pending") {
      if (action === "approve" && gate.type === "meaning" && gate.decision === "approve") {
        this.inTransaction(() => this.createKnowledgeFromApprovedMeaningGate(gate, input));
      }
      return { gate, dryRun: false };
    }

    return this.inTransaction(() => {
      const nextStatus = decisionStatus(action);
      const dwell = reviewDwellMs(input);
      const payload = parseGatePayload(gate.payload);
      const patch: Partial<HumanGateItem> & { actor?: string } = {
        status: nextStatus,
        decision: action,
        rejectReasonCode: reasonCode,
        reviewDwellMs: dwell ?? gate.reviewDwellMs ?? null,
        actor: input.actor ?? "human",
      };
      if (action === "reject") {
        patch.payload = JSON.stringify({
          ...payload,
          rejectReasonCode: reasonCode,
        });
      }
      const updated = this.store.updateGate(gate.id, patch);
      this.store.createDecision({
        id: decisionId(gate, action),
        cycleId: gate.cycleId,
        gateType: gate.type,
        decision: action,
        rationale: input.rationale ?? "",
        ts: now(),
      });
      this.store.recordEvent({
        cycleIdx: this.store.getCycle(gate.cycleId)?.idx ?? 0,
        actor: input.actor ?? "human",
        tableName: "human_gate_items",
        op: "resolve",
        before: JSON.stringify({ status: gate.status, gateId: gate.id }),
        after: JSON.stringify({ status: nextStatus, gateId: gate.id, via: input.via ?? "web" }),
        ts: now(),
      });
      auditGateDecision(this.store, gate, action, "approved", input);
      if (action === "approve" && gate.type === "meaning") {
        this.createKnowledgeFromApprovedMeaningGate(updated ?? gate, input);
      }
      this.updateSpeculativeDraftFromGate(updated ?? gate, action, nextStatus);
      if (action === "reject" && reasonCode) {
        this.cascadeSpeculativeReject(updated ?? gate, reasonCode, input.actor ?? "human");
      }
      return { gate: updated ?? gate, dryRun: false };
    });
  }

  systemAnnotate(gateId: string, input: SystemGateAnnotationInput): HumanGateItem {
    const gate = this.store.getGate(gateId);
    if (!gate) throw new Error(`human gate not found: ${gateId}`);
    const actor = input.actor ?? "system";
    return this.inTransaction(() => {
      const updated = this.store.updateGate(gate.id, { ...input.patch, actor }) ?? gate;
      const cycle = this.store.getCycle(gate.cycleId);
      this.store.recordEvent({
        cycleIdx: cycle?.idx ?? 0,
        actor,
        tableName: "human_gate_items",
        op: "annotate",
        before: JSON.stringify({ gateId: gate.id, status: gate.status, decision: gate.decision }),
        after: JSON.stringify({
          gateId: gate.id,
          status: updated.status,
          decision: updated.decision,
          reason: input.reason ?? "",
        }),
        ts: now(),
      });
      recordTrace({
        projectId: cycle?.projectId ?? "system",
        cycleId: gate.cycleId,
        cycleIdx: cycle?.idx ?? null,
        kind: "approval",
        name: "human_gate_annotated",
        agent: actor,
        attributes: {
          gateId: gate.id,
          gateType: gate.type,
          reason: input.reason ?? "",
        },
      });
      return updated;
    });
  }

  private applySystemResolve(gate: HumanGateItem, decision: string, input: SystemGateTransitionInput): HumanGateItem {
    const actor = input.actor ?? "system";
    const nextStatus = input.status ?? "resolved";
    const updated = this.store.updateGate(gate.id, {
      ...(input.patch ?? {}),
      status: nextStatus,
      decision,
      actor,
    }) ?? gate;
    const cycle = this.store.getCycle(gate.cycleId);
    this.store.createDecision({
      id: decisionId(gate, decision),
      cycleId: gate.cycleId,
      gateType: gate.type,
      decision,
      rationale: input.reason ?? "",
      ts: now(),
    });
    this.store.recordEvent({
      cycleIdx: cycle?.idx ?? 0,
      actor,
      tableName: "human_gate_items",
      op: "resolve",
      before: JSON.stringify({ status: gate.status, gateId: gate.id, decision: gate.decision }),
      after: JSON.stringify({
        status: nextStatus,
        gateId: gate.id,
        decision,
        via: input.via ?? "system",
        reason: input.reason ?? "",
      }),
      ts: now(),
    });
    auditGateDecision(this.store, gate, decision, "approved", {
      actor,
      via: input.via ?? "system",
      rationale: input.reason,
    });
    recordTrace({
      projectId: cycle?.projectId ?? "system",
      cycleId: gate.cycleId,
      cycleIdx: cycle?.idx ?? null,
      kind: "approval",
      name: "human_gate_system_resolved",
      agent: actor,
      attributes: {
        gateId: gate.id,
        gateType: gate.type,
        status: nextStatus,
        decision,
        reason: input.reason ?? "",
      },
    });
    this.updateSpeculativeDraftFromGate(updated, decision, nextStatus);
    return updated;
  }

  systemResolve(gateId: string, decision: string, input: SystemGateTransitionInput = {}): HumanGateItem {
    const gate = this.store.getGate(gateId);
    if (!gate) throw new Error(`human gate not found: ${gateId}`);
    return this.inTransaction(() => this.applySystemResolve(gate, decision, input));
  }

  systemMerge(keeperId: string, mergedIds: string[], input: SystemGateMergeInput = {}): HumanGateItem {
    const keeper = this.store.getGate(keeperId);
    if (!keeper) throw new Error(`human gate not found: ${keeperId}`);
    const actor = input.actor ?? "system";
    const rest = mergedIds.map((id) => {
      const gate = this.store.getGate(id);
      if (!gate) throw new Error(`human gate not found: ${id}`);
      return gate;
    });
    const gates = [keeper, ...rest];
    const quotes = gates.map((g) => parseGatePayload(g.payload).userQuote).filter(Boolean);
    const mergedAt = now();

    return this.inTransaction(() => {
      const updatedKeeper = this.store.updateGate(keeper.id, {
        payload: JSON.stringify({
          ...parseGatePayload(keeper.payload),
          mergedCount: gates.length,
          mergedQuotes: quotes,
          mergedAt,
        }),
        actor,
      }) ?? keeper;

      for (const gate of rest) {
        this.applySystemResolve(gate, `merged_into:${keeper.id}`, {
          actor,
          status: "modified",
          reason: input.reason ?? `Merged into ${keeper.id}`,
          via: "system_merge",
          patch: {
            estimatedMinutes: 0,
            payload: JSON.stringify({
              ...parseGatePayload(gate.payload),
              mergedInto: keeper.id,
              mergedAt,
            }),
          },
        });
      }
      recordTrace({
        projectId: projectIdForGate(this.store, keeper),
        cycleId: keeper.cycleId,
        cycleIdx: this.store.getCycle(keeper.cycleId)?.idx ?? null,
        kind: "approval",
        name: "human_gate_system_merged",
        agent: actor,
        attributes: {
          keeperId: keeper.id,
          mergedIds,
          reason: input.reason ?? "",
        },
      });
      return updatedKeeper;
    });
  }

  private createKnowledgeFromApprovedMeaningGate(gate: HumanGateItem, input: ResolveGateInput) {
    const projectId = projectIdForGate(this.store, gate);
    if (projectId === "system") return;
    const existingId = knowledgeIdForMeaningGate(gate.id);
    if (this.store.getKnowledge(existingId)) return;

    const cycle = this.store.getCycle(gate.cycleId);
    const payload = parseGatePayload(gate.payload);
    if (isSystemDiagnosticMeaningGate(gate, payload)) return;
    const source = stringValue(payload.source, "meaning_gate");
    const topicKey = stringValue(payload.topicKey, "external_feedback");
    const summary = stringValue(payload.summary, gate.title);
    const quote = stringValue(payload.userQuote, summary);
    const externalId = stringValue(payload.externalId, gate.id);
    const category = stringValue(payload.category, "unclear_signal");
    const title = compact(`外部反馈: ${summary || topicKey}`, 120);
    const content = [
      `Human approved meaning gate ${gate.id}.`,
      `Source: ${source}${externalId ? ` ${externalId}` : ""}.`,
      `Summary: ${summary || topicKey}.`,
      `User quote: ${quote}.`,
    ].join("\n");
    const tags = Array.from(new Set([
      "meaning_gate",
      "human_approved",
      source,
      category,
      topicKey,
    ].filter(Boolean)));
    const base = {
      id: existingId,
      projectId,
      type: "case",
      title,
      content,
      sourceType: "feedback",
      sourceRef: externalId || gate.id,
      evidenceAlpha: 1,
      evidenceBeta: 1,
      confidenceScore: 0.5,
      confidenceLevel: "low",
      status: "draft",
      humanApprovedCount: 0,
      externalVerifiedCount: 0,
      validFrom: now().slice(0, 10),
      validUntil: null,
      lastValidatedCycle: cycle?.idx ?? 0,
      createdByCycle: cycle?.idx ?? 0,
      createdBy: "human_gate",
      approvedBy: null,
      usageCount: 0,
      tags,
      notes: `approved via ${input.via ?? "web"}`,
    };
    const normalizedError = Number(payload.normalizedError);
    const withGrayEvidence = Number.isFinite(normalizedError)
      ? applyEvidence(base as any, { kind: "prediction", normalizedError }).next as any
      : base;
    const evidence = applyEvidence(withGrayEvidence as any, { kind: "human_approve" }).next as any;
    this.store.createKnowledge({
      ...base,
      evidenceAlpha: evidence.evidenceAlpha,
      evidenceBeta: evidence.evidenceBeta,
      confidenceScore: evidence.confidenceScore,
      confidenceLevel: evidence.confidenceLevel,
      status: "active",
      humanApprovedCount: evidence.humanApprovedCount,
      approvedBy: input.actor ?? "human",
      tags: JSON.stringify(tags),
      version: 1,
    });
    runKnowledgeConflictDetector(projectId);
  }
}
