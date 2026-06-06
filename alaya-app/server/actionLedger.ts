import { actionRiskSummary, makeIdempotencyKey } from "@shared/core/action_risk.js";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";
import { redactSensitiveData } from "./security/redact";
import type { ActionLedgerRow, HumanGateItem } from "@shared/schema";
import type { RiskLevel } from "@shared/core/types.js";

interface RecordActionProposalInput {
  projectId: string;
  cycleId?: string | null;
  actionType: string;
  target?: string;
  payload?: Record<string, unknown>;
  explicitRiskLevel?: RiskLevel;
  rollbackPlan?: unknown;
  auditSummary?: unknown;
}

function safeGateIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "action";
}

function parsePayload(payload: string): Record<string, any> {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function approvedDirectionGate(cycleId: string | null | undefined): HumanGateItem | undefined {
  if (!cycleId) return undefined;
  return storage.listGates().find((gate) => gate.cycleId === cycleId && gate.type === "direction" && gate.status === "approved");
}

function actionRiskGate(cycleId: string | null | undefined, idempotencyKey: string): HumanGateItem | undefined {
  if (!cycleId) return undefined;
  return storage.listGates().find((gate) => {
    if (gate.cycleId !== cycleId || gate.type !== "risk") return false;
    const payload = parsePayload(gate.payload);
    return payload.riskKey === "action_requires_approval" && payload.idempotencyKey === idempotencyKey;
  });
}

function approvedRiskGate(cycleId: string | null | undefined, idempotencyKey: string): HumanGateItem | undefined {
  const gate = actionRiskGate(cycleId, idempotencyKey);
  return gate?.status === "approved" ? gate : undefined;
}

function ensureRiskGate(input: RecordActionProposalInput, riskLevel: RiskLevel, idempotencyKey: string): HumanGateItem | undefined {
  if (!input.cycleId) return undefined;
  const existing = actionRiskGate(input.cycleId, idempotencyKey);
  if (existing) return existing;
  return storage.createGate({
    id: `gate_action_${safeGateIdPart(input.actionType)}_${idempotencyKey.slice(-8)}`,
    cycleId: input.cycleId,
    type: "risk",
    blocking: 1,
    title: `高风险动作审批: ${input.actionType}`,
    payload: JSON.stringify({
      riskKey: "action_requires_approval",
      idempotencyKey,
      actionType: input.actionType,
      target: input.target ?? "",
      riskLevel,
      rollbackPlan: input.rollbackPlan ?? null,
      auditSummary: input.auditSummary ?? null,
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 10,
    decision: null,
    version: 1,
  });
}

export function recordActionProposal(input: RecordActionProposalInput): ActionLedgerRow {
  const payload = redactSensitiveData(input.payload ?? {}) as Record<string, unknown>;
  const rollbackPlan = input.rollbackPlan == null ? null : redactSensitiveData(input.rollbackPlan);
  const auditSummary = input.auditSummary == null ? null : redactSensitiveData(input.auditSummary);
  const idempotencyKey = makeIdempotencyKey({
    projectId: input.projectId,
    cycleId: input.cycleId,
    actionType: input.actionType,
    target: input.target,
    payload,
  });
  const risk = actionRiskSummary({
    actionType: input.actionType,
    target: input.target,
    payload,
    explicitRiskLevel: input.explicitRiskLevel,
  }, { allowLocalWriteWithoutApproval: true });
  const approvedGate = approvedDirectionGate(input.cycleId) ?? approvedRiskGate(input.cycleId, idempotencyKey);
  const riskGate = risk.requiresApproval && !approvedGate ? ensureRiskGate(input, risk.riskLevel, idempotencyKey) : undefined;
  const approvalGate = approvedGate ?? riskGate;
  const status: ActionLedgerRow["status"] = risk.requiresApproval
    ? (approvedGate ? "approved" : "blocked")
    : "approved";
  const createdAt = now();
  const row = storage.upsertActionLedger({
    id: `act_${idempotencyKey.slice(-8)}`,
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    actionType: input.actionType,
    target: input.target ?? "",
    riskLevel: risk.riskLevel,
    requiresApproval: risk.requiresApproval ? 1 : 0,
    approvalGateId: approvalGate?.id ?? null,
    idempotencyKey,
    status,
    rollbackPlan: rollbackPlan == null ? null : JSON.stringify(rollbackPlan),
    auditSummary: auditSummary == null ? null : JSON.stringify(auditSummary),
    payload: JSON.stringify(payload),
    createdAt,
    updatedAt: createdAt,
  });
  const cycle = input.cycleId ? storage.getCycle(input.cycleId) : undefined;
  recordTrace({
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    cycleIdx: cycle?.idx ?? null,
    kind: "action_risk",
    name: input.actionType,
    agent: "builder",
    status: row.status === "blocked" ? "blocked" : "ok",
    attributes: {
      actionLedgerId: row.id,
      riskLevel: row.riskLevel,
      requiresApproval: row.requiresApproval === 1,
      approvalGateId: row.approvalGateId,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
    },
  });
  return row;
}
