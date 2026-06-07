import { makeIdempotencyKey } from "@shared/core/action_risk.js";
import type { HumanGateItem } from "@shared/schema";
import { auditCapabilityDecision, evaluateCapability, CapabilityDeniedError } from "./security/capabilities";
import { redactSensitiveData } from "./security/redact";
import { storage, now, type IStorage } from "./storage";

export type GateDecisionAction = "approve" | "reject" | "modify";

export interface ResolveGateInput {
  rationale?: string;
  via?: string;
  actor?: string;
}

export interface ResolveGateResult {
  gate: HumanGateItem;
  dryRun: boolean;
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
  action: GateDecisionAction,
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
    }),
    payload: JSON.stringify(payload),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export class HumanGateService {
  constructor(private store: IStorage = storage) {}

  approve(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    return this.resolve(gateId, "approve", input);
  }

  reject(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    return this.resolve(gateId, "reject", input);
  }

  modify(gateId: string, input: ResolveGateInput = {}): ResolveGateResult {
    return this.resolve(gateId, "modify", input);
  }

  resolve(gateId: string, action: GateDecisionAction, input: ResolveGateInput = {}): ResolveGateResult {
    const gate = this.store.getGate(gateId);
    if (!gate) throw new Error(`human gate not found: ${gateId}`);
    if (gate.status !== "pending") return { gate, dryRun: false };

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

    const nextStatus = decisionStatus(action);
    const updated = this.store.updateGate(gate.id, { status: nextStatus, decision: action });
    this.store.createDecision({
      id: `dec_${gate.id}_${Date.now().toString(36)}`,
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
    return { gate: updated ?? gate, dryRun: false };
  }
}
