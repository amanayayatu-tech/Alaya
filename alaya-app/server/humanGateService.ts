import { makeIdempotencyKey } from "@shared/core/action_risk.js";
import { applyEvidence } from "@shared/core/update_confidence.js";
import type { HumanGateItem } from "@shared/schema";
import { auditCapabilityDecision, evaluateCapability, CapabilityDeniedError } from "./security/capabilities";
import { redactSensitiveData } from "./security/redact";
import { storage, now, type IStorage } from "./storage";
import { detectKnowledgeConflicts } from "./knowledgeReview";

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
    if (gate.status !== "pending") {
      if (action === "approve" && gate.type === "meaning" && gate.decision === "approve") {
        this.inTransaction(() => this.createKnowledgeFromApprovedMeaningGate(gate, input));
      }
      return { gate, dryRun: false };
    }

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

    return this.inTransaction(() => {
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
      if (action === "approve" && gate.type === "meaning") {
        this.createKnowledgeFromApprovedMeaningGate(updated ?? gate, input);
      }
      return { gate: updated ?? gate, dryRun: false };
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
    detectKnowledgeConflicts(projectId);
  }
}
