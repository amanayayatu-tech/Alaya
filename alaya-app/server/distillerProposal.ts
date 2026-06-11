import { runRegressionOnGoldCases, type GoldRegressionCase } from "alaya-core/src/core/regression_validator.js";
import { MODEL_ERROR_THRESHOLD, routeError } from "alaya-core/src/core/classify_error.js";
import type { AttributionContext, ErrorType } from "alaya-core/src/core/types.js";
import type { DistillerProposal, GoldCase, HumanGateItem, KnowledgeItem } from "@shared/schema";
import { createDecisionBrief, withDecisionBriefPayload } from "./decisionBrief";
import { runKnowledgeConflictDetector } from "./knowledgeConflictHooks";
import { redactSensitiveData } from "./security/redact";
import { now, storage, type IStorage } from "./storage";

export type DistillerProposalType = "create" | "update" | "demote";

export interface AttributionBasis {
  errorType: ErrorType;
  claimError: number | null;
  contextSnapshot: Partial<AttributionContext> & Record<string, unknown>;
  attributionConfidence: number;
  route?: string;
  lowConfidenceReasons?: string[];
  sampleFingerprints?: string[];
  pendingAttributionIds?: string[];
}

export interface ProposeDistillerKnowledgeInput {
  projectId: string;
  cycleId: string;
  proposalType?: DistillerProposalType;
  targetKnowledgeId?: string | null;
  proposedContent: Partial<KnowledgeItem> & Record<string, unknown>;
  attributionBasis: AttributionBasis;
  ctxOverrides?: Partial<AttributionContext>;
  store?: IStorage;
}

export interface DistillerProposalResult {
  proposal: DistillerProposal;
  gate: HumanGateItem | null;
  regression: {
    passed: boolean;
    testedCases: number;
    failedCaseIds: string[];
    skipped: boolean;
  };
}

export interface ParameterRetirementResult {
  retiredCaseIds: string[];
  reviewTaskCreated: boolean;
  reviewedCaseIds: string[];
}

export interface GoldCaseHealthIssue {
  id: string;
  kind: "stale_confirmation" | "never_triggered" | "unexpected_inactive";
}

export interface GoldCaseHealthAudit {
  issueCount: number;
  issues: GoldCaseHealthIssue[];
}

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function parseJsonObject(value: string | null | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function compact(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function normalizeContext(value: unknown): AttributionContext {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    perceptionFailure: record.perceptionFailure === true,
    executionFailure: record.executionFailure === true,
    humanFlaggedValueMismatch: record.humanFlaggedValueMismatch === true,
    isQualitative: record.isQualitative === true,
  };
}

function parseGoldInput(value: string): { claimError: number | null; context: AttributionContext } {
  const input = parseJsonObject(value);
  const claimError = typeof input.claimError === "number" && Number.isFinite(input.claimError) ? input.claimError : null;
  const context = normalizeContext(input.context ?? input);
  return { claimError, context };
}

function toRegressionCase(row: GoldCase): GoldRegressionCase {
  const parsed = parseGoldInput(row.input);
  return {
    id: row.id,
    active: row.active === 1,
    input: parsed,
    expectedErrorType: (row.expectedErrorType ?? null) as ErrorType,
    expectedRoute: row.expectedRoute,
  };
}

function proposalIdFor(input: ProposeDistillerKnowledgeInput): string {
  const title = typeof input.proposedContent.title === "string" ? input.proposedContent.title : "";
  const target = input.targetKnowledgeId ?? "";
  return `dp_${hash(`${input.projectId}:${input.cycleId}:${input.proposalType ?? "create"}:${target}:${title}`)}`;
}

function proposalGateId(proposalId: string): string {
  return `gate_distiller_proposal_${hash(proposalId)}`;
}

function knowledgeIdForProposal(proposal: DistillerProposal): string {
  const content = parseJsonObject(proposal.proposedContent);
  return typeof content.id === "string" && content.id.trim()
    ? content.id.trim()
    : `kb_prop_${hash(proposal.id)}`;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function approvedKnowledgeStatus(value: unknown): string {
  const status = stringValue(value, "active");
  return status === "draft" ? "active" : status;
}

function eventCycleIdx(store: IStorage, cycleId: string): number {
  return store.getCycle(cycleId)?.idx ?? 0;
}

function recordProposalEvent(
  store: IStorage,
  proposal: DistillerProposal,
  op: string,
  after: Record<string, unknown>,
): void {
  store.recordEvent({
    cycleIdx: eventCycleIdx(store, proposal.cycleId),
    actor: "distiller_proposal",
    tableName: "distiller_proposals",
    op,
    before: null,
    after: JSON.stringify({ proposalId: proposal.id, ...after }),
    ts: now(),
  });
}

function createProposalGate(
  store: IStorage,
  proposal: DistillerProposal,
  regression: DistillerProposalResult["regression"],
): HumanGateItem {
  const gateId = proposalGateId(proposal.id);
  const existing = store.getGate(gateId);
  if (existing) return existing;

  const proposedContent = parseJsonObject(proposal.proposedContent);
  const attributionBasis = parseJsonObject(proposal.attributionBasis);
  const title = stringValue(proposedContent.title, proposal.id);
  const semanticKey = stringValue(proposedContent.semanticKey, title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
  const regressionLabel = regression.skipped ? "skipped" : regression.passed ? "passed" : "failed";

  return store.createGate({
    id: gateId,
    cycleId: proposal.cycleId,
    type: "meaning",
    blocking: 0,
    title: `Distiller 提案待审批: ${compact(title, 100)}`,
    payload: withDecisionBriefPayload({
      source: "distiller_proposal",
      proposalId: proposal.id,
      proposalType: proposal.proposalType,
      targetKnowledgeId: proposal.targetKnowledgeId,
      semanticKey,
      topicKey: semanticKey,
      summary: compact(stringValue(proposedContent.content, title), 500),
      proposedContent: redactSensitiveData(proposedContent),
      attributionBasis: redactSensitiveData(attributionBasis),
      regression: {
        status: regressionLabel,
        testedCases: regression.testedCases,
        failedCaseIds: regression.failedCaseIds,
      },
      normalizedError: attributionBasis.claimError ?? null,
      createdAt: now(),
    }, createDecisionBrief({
      claim: `Apply distiller proposal ${proposal.id}: ${title}`,
      citedKnowledgeIds: proposal.targetKnowledgeId ? [proposal.targetKnowledgeId] : [],
      metric: `distiller_proposal_regression:${proposal.id}`,
      operator: "=",
      target: regressionLabel,
      timeWindow: "next review window",
      ifApproved: "Apply the proposed knowledge change through the knowledge_write approval path.",
      ifRejected: "Reject the proposal and keep the knowledge layer unchanged.",
      rollbackRef: `distiller_proposals:${proposal.id}`,
    })),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    notifyPolicy: "next_window",
    version: 1,
  });
}

export function proposeDistillerKnowledge(input: ProposeDistillerKnowledgeInput): DistillerProposalResult {
  const store = input.store ?? storage;
  const createdAt = now();
  const id = proposalIdFor(input);
  const existing = store.getDistillerProposal(id);
  if (existing) {
    const gate = existing.gateId ? store.getGate(existing.gateId) ?? null : null;
    return {
      proposal: existing,
      gate,
      regression: {
        passed: existing.regressionStatus !== "failed",
        testedCases: 0,
        failedCaseIds: stringArray(parseJsonArray(existing.regressionFailedCases)),
        skipped: existing.regressionStatus === "skipped",
      },
    };
  }

  let proposal = store.createDistillerProposal({
    id,
    projectId: input.projectId,
    cycleId: input.cycleId,
    proposalType: input.proposalType ?? "create",
    targetKnowledgeId: input.targetKnowledgeId ?? null,
    proposedContent: JSON.stringify(redactSensitiveData(input.proposedContent)),
    attributionBasis: JSON.stringify(redactSensitiveData(input.attributionBasis)),
    regressionStatus: "pending",
    regressionFailedCases: null,
    gateId: null,
    status: "proposed",
    createdAt,
  });

  const activeGoldCases = store.listGoldCases(input.projectId, { active: true });
  const regressionCases = activeGoldCases.map(toRegressionCase);
  const regressionResult = runRegressionOnGoldCases(regressionCases, input.ctxOverrides);
  const skipped = regressionCases.length === 0;
  const regressionStatus = skipped ? "skipped" : regressionResult.passed ? "passed" : "failed";
  const failedCaseIds = regressionResult.failedCaseIds;

  for (const goldCase of activeGoldCases) {
    store.recordEvent({
      cycleIdx: eventCycleIdx(store, input.cycleId),
      actor: "distiller_proposal",
      tableName: "gold_cases",
      op: "regression_triggered",
      before: null,
      after: JSON.stringify({ proposalId: proposal.id, goldCaseId: goldCase.id, failed: failedCaseIds.includes(goldCase.id) }),
      ts: now(),
    });
    if (!failedCaseIds.includes(goldCase.id)) {
      store.updateGoldCase(goldCase.id, { lastConfirmedAt: now() });
    }
  }

  if (!regressionResult.passed) {
    proposal = store.updateDistillerProposal(proposal.id, {
      regressionStatus,
      regressionFailedCases: JSON.stringify(failedCaseIds),
      status: "rejected",
    }) ?? proposal;
    recordProposalEvent(store, proposal, "regression_failed", { failedCaseIds });
    return {
      proposal,
      gate: null,
      regression: { ...regressionResult, skipped },
    };
  }

  const regression = { ...regressionResult, skipped };
  const gate = createProposalGate(store, proposal, regression);
  proposal = store.updateDistillerProposal(proposal.id, {
    regressionStatus,
    regressionFailedCases: JSON.stringify(failedCaseIds),
    gateId: gate.id,
    status: "gated",
  }) ?? proposal;
  recordProposalEvent(store, proposal, "regression_passed_gated", {
    gateId: gate.id,
    regressionStatus,
    testedCases: regressionResult.testedCases,
  });

  return { proposal, gate, regression };
}

function normalizeKnowledgeFromProposal(
  proposal: DistillerProposal,
  actor: string,
  store: IStorage,
): KnowledgeItem {
  const content = parseJsonObject(proposal.proposedContent);
  const cycle = store.getCycle(proposal.cycleId);
  const tags = typeof content.tags === "string" ? content.tags : JSON.stringify(stringArray(content.tags));
  const approvedCount = Math.max(1, Math.trunc(numberValue(content.humanApprovedCount, 0)));
  return {
    id: knowledgeIdForProposal(proposal),
    projectId: proposal.projectId,
    type: stringValue(content.type, "world_model"),
    title: stringValue(content.title, `Distiller proposal ${proposal.id}`),
    content: stringValue(content.content, ""),
    sourceType: stringValue(content.sourceType, "agent_observation"),
    sourceRef: stringValue(content.sourceRef, proposal.id),
    evidenceAlpha: numberValue(content.evidenceAlpha, 1),
    evidenceBeta: numberValue(content.evidenceBeta, 1),
    confidenceScore: numberValue(content.confidenceScore, 0.5),
    confidenceLevel: stringValue(content.confidenceLevel, "low"),
    status: approvedKnowledgeStatus(content.status),
    humanApprovedCount: approvedCount,
    externalVerifiedCount: Math.trunc(numberValue(content.externalVerifiedCount, 0)),
    validFrom: stringValue(content.validFrom, now().slice(0, 10)),
    validUntil: typeof content.validUntil === "string" ? content.validUntil : null,
    lastValidatedCycle: Math.trunc(numberValue(content.lastValidatedCycle, cycle?.idx ?? 0)),
    createdByCycle: Math.trunc(numberValue(content.createdByCycle, cycle?.idx ?? 0)),
    createdBy: "distiller_proposal",
    approvedBy: actor,
    usageCount: Math.trunc(numberValue(content.usageCount, 0)),
    lastInjectedAt: null,
    lastVerifiedAt: null,
    lastDecayedAt: null,
    grayStreak: Math.trunc(numberValue(content.grayStreak, 0)),
    storageStrength: numberValue(content.storageStrength, 1),
    noveltyScore: typeof content.noveltyScore === "number" ? content.noveltyScore : null,
    sourceRound: typeof content.sourceRound === "number" ? content.sourceRound : cycle?.idx ?? null,
    tags,
    notes: stringValue(content.notes, `approved distiller proposal ${proposal.id}`),
    supersededBy: typeof content.supersededBy === "string" ? content.supersededBy : null,
    semanticKey: stringValue(content.semanticKey, ""),
    version: 1,
  };
}

function maybeNominateGoldCase(store: IStorage, proposal: DistillerProposal): void {
  if (proposal.regressionStatus !== "passed") return;
  const basis = parseJsonObject(proposal.attributionBasis);
  const confidence = numberValue(basis.attributionConfidence, 0);
  if (confidence < 0.95) return;
  const id = `gold_nom_${hash(proposal.id)}`;
  if (store.getGoldCase(id)) return;
  const errorType = (basis.errorType ?? null) as ErrorType;
  const claimError = typeof basis.claimError === "number" && Number.isFinite(basis.claimError) ? basis.claimError : null;
  const context = normalizeContext(basis.contextSnapshot);
  const fingerprints = stringArray(basis.sampleFingerprints);
  store.createGoldCase({
    id,
    projectId: proposal.projectId,
    fingerprint: fingerprints[0] ?? proposal.id,
    input: JSON.stringify({ claimError, context }),
    expectedErrorType: errorType,
    expectedRoute: stringValue(basis.route, routeError(errorType)),
    active: 0,
    retiredReason: null,
    lastConfirmedAt: null,
    sourceProposalId: proposal.id,
    createdAt: now(),
  });
}

export function applyApprovedDistillerProposalFromGate(
  gate: HumanGateItem,
  input: { actor?: string; via?: string } = {},
  store: IStorage = storage,
): boolean {
  const payload = parseJsonObject(gate.payload);
  if (payload.source !== "distiller_proposal") return false;
  const proposalId = stringValue(payload.proposalId);
  const proposal = proposalId ? store.getDistillerProposal(proposalId) : store.getDistillerProposalByGate(gate.id);
  if (!proposal) return true;
  if (proposal.status === "applied") return true;
  if (proposal.status === "rejected") return true;
  const actor = input.actor ?? "human";
  const approved = store.updateDistillerProposal(proposal.id, {
    status: "approved",
    gateId: gate.id,
  }) ?? proposal;

  if (approved.proposalType === "create") {
    const knowledge = normalizeKnowledgeFromProposal(approved, actor, store);
    if (!store.getKnowledge(knowledge.id)) {
      const created = store.createKnowledge(knowledge);
      runKnowledgeConflictDetector(approved.projectId, created.id);
    }
  } else if (approved.proposalType === "update" && approved.targetKnowledgeId) {
    const patch = parseJsonObject(approved.proposedContent);
    store.updateKnowledge(approved.targetKnowledgeId, {
      ...patch,
      actor: "distiller_proposal",
      approvedBy: actor,
    });
  } else if (approved.proposalType === "demote" && approved.targetKnowledgeId) {
    const patch = parseJsonObject(approved.proposedContent);
    store.updateKnowledge(approved.targetKnowledgeId, {
      status: stringValue(patch.status, "deprecated"),
      notes: stringValue(patch.notes, `demoted by distiller proposal ${approved.id}`),
      actor: "distiller_proposal",
    });
  }

  store.updateDistillerProposal(approved.id, { status: "applied", gateId: gate.id });
  maybeNominateGoldCase(store, approved);
  recordProposalEvent(store, approved, "applied", {
    gateId: gate.id,
    via: input.via ?? "web",
    knowledgeId: approved.proposalType === "create" ? knowledgeIdForProposal(approved) : approved.targetKnowledgeId,
  });
  return true;
}

export function rejectDistillerProposalFromGate(gate: HumanGateItem, store: IStorage = storage): boolean {
  const payload = parseJsonObject(gate.payload);
  if (payload.source !== "distiller_proposal") return false;
  const proposalId = stringValue(payload.proposalId);
  const proposal = proposalId ? store.getDistillerProposal(proposalId) : store.getDistillerProposalByGate(gate.id);
  if (!proposal || proposal.status === "applied") return true;
  store.updateDistillerProposal(proposal.id, {
    status: "rejected",
    gateId: gate.id,
  });
  recordProposalEvent(store, proposal, "human_rejected", { gateId: gate.id });
  return true;
}

function claimErrorForGoldCase(goldCase: GoldCase): number | null {
  return parseGoldInput(goldCase.input).claimError;
}

function recordParameterReviewTask(
  store: IStorage,
  paramName: string,
  oldValue: number,
  newValue: number,
  cases: GoldCase[],
): void {
  const projectIds = Array.from(new Set(cases.map((item) => item.projectId).filter(Boolean)));
  const targets = projectIds.length ? projectIds : ["system"];
  for (const projectId of targets) {
    store.recordEvent({
      cycleIdx: 0,
      actor: "librarian",
      tableName: "gold_cases",
      op: "parameter_review_required",
      before: null,
      after: JSON.stringify({
        projectId,
        paramName,
        oldValue,
        newValue,
        caseCount: cases.filter((item) => item.projectId === projectId || projectId === "system").length,
      }),
      ts: now(),
    });
  }
}

function affectedByKnownParam(paramName: string, oldValue: number, newValue: number, goldCase: GoldCase): boolean {
  const claimError = claimErrorForGoldCase(goldCase);
  if (claimError == null) return false;
  switch (paramName) {
    case "MODEL_ERROR_THRESHOLD": {
      const min = Math.min(oldValue, newValue);
      const max = Math.max(oldValue, newValue);
      return claimError > min && claimError <= max;
    }
    case "MODEL_ERROR_THRESHOLD_BOUNDARY_MARGIN":
      return Math.abs(claimError - MODEL_ERROR_THRESHOLD) <= Math.max(oldValue, newValue);
    case "ATTRIBUTION_MULTI_SIGNAL_PENALTY":
    case "ATTRIBUTION_THRESHOLD_BOUNDARY_PENALTY":
      return false;
    default:
      return false;
  }
}

export function onCoreParameterChanged(
  paramName: string,
  oldValue: number,
  newValue: number,
  cases?: GoldCase[],
  store: IStorage = storage,
): ParameterRetirementResult {
  const reviewedCases = cases ?? store.listGoldCases(undefined, { active: true });
  const knownParams = new Set([
    "MODEL_ERROR_THRESHOLD",
    "MODEL_ERROR_THRESHOLD_BOUNDARY_MARGIN",
    "ATTRIBUTION_MULTI_SIGNAL_PENALTY",
    "ATTRIBUTION_THRESHOLD_BOUNDARY_PENALTY",
  ]);
  if (!knownParams.has(paramName)) {
    recordParameterReviewTask(store, paramName, oldValue, newValue, reviewedCases);
    return { retiredCaseIds: [], reviewTaskCreated: true, reviewedCaseIds: reviewedCases.map((item) => item.id) };
  }

  const retiredCaseIds: string[] = [];
  for (const goldCase of reviewedCases) {
    if (goldCase.active !== 1) continue;
    if (!affectedByKnownParam(paramName, oldValue, newValue, goldCase)) continue;
    const retiredReason = `${paramName} changed ${oldValue} -> ${newValue}; claimError within affected boundary`;
    store.updateGoldCase(goldCase.id, {
      active: 0,
      retiredReason,
    });
    retiredCaseIds.push(goldCase.id);
  }
  return { retiredCaseIds, reviewTaskCreated: false, reviewedCaseIds: reviewedCases.map((item) => item.id) };
}

export function auditGoldCaseHealth(projectId: string, store: IStorage = storage, at = new Date()): GoldCaseHealthAudit {
  const thresholdMs = at.getTime() - 90 * 24 * 60 * 60 * 1000;
  const issues: GoldCaseHealthIssue[] = [];
  for (const goldCase of store.listGoldCases(projectId)) {
    if (goldCase.active === 1) {
      const confirmedMs = goldCase.lastConfirmedAt ? Date.parse(goldCase.lastConfirmedAt) : NaN;
      if (!goldCase.lastConfirmedAt) {
        issues.push({ id: goldCase.id, kind: "never_triggered" });
      } else if (Number.isFinite(confirmedMs) && confirmedMs < thresholdMs) {
        issues.push({ id: goldCase.id, kind: "stale_confirmation" });
      }
    } else if (!goldCase.retiredReason && !goldCase.sourceProposalId) {
      issues.push({ id: goldCase.id, kind: "unexpected_inactive" });
    }
  }

  const audit = { issueCount: issues.length, issues };
  store.recordEvent({
    cycleIdx: 0,
    actor: "librarian",
    tableName: "gold_cases",
    op: "health_check",
    before: null,
    after: JSON.stringify({ projectId, ...audit }),
    ts: now(),
  });
  return audit;
}

export function distillerProposalDigestLines(projectId: string, store: IStorage = storage): string[] {
  const lines: string[] = [];
  const gatedCount = store.listDistillerProposals(projectId, { status: "gated" }).length;
  if (gatedCount > 0) lines.push(`分馏提案候选池：${gatedCount} 项待审批`);

  const events = store.listEvents();
  const health = events.find((event) => {
    if (event.tableName !== "gold_cases" || event.op !== "health_check") return false;
    const payload = parseJsonObject(event.after);
    return payload.projectId === projectId && numberValue(payload.issueCount, 0) > 0;
  });
  if (health) {
    const payload = parseJsonObject(health.after);
    lines.push(`金集健康：${numberValue(payload.issueCount, 0)} 项待复核`);
  }

  const reviewTasks = events.filter((event) => {
    if (event.tableName !== "gold_cases" || event.op !== "parameter_review_required") return false;
    const payload = parseJsonObject(event.after);
    return payload.projectId === projectId || payload.projectId === "system";
  });
  if (reviewTasks.length > 0) lines.push(`金集参数复核：${reviewTasks.length} 项待复核`);
  return lines;
}
