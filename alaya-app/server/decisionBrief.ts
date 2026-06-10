import type { HumanGateItem } from "@shared/schema";

export interface DecisionBrief {
  claim: string;
  cited_knowledge_ids: string[];
  prediction: {
    metric: string;
    operator: ">=" | "<=" | "=" | "!=" | "contains" | "exists";
    target: string | number | boolean;
    timeWindow: string;
  };
  if_approved: string;
  if_rejected: string;
  rollback_ref: string;
}

export function createDecisionBrief(input: {
  claim: string;
  citedKnowledgeIds?: string[];
  metric?: string;
  operator?: DecisionBrief["prediction"]["operator"];
  target?: string | number | boolean;
  timeWindow?: string;
  ifApproved: string;
  ifRejected: string;
  rollbackRef?: string;
}): DecisionBrief {
  return {
    claim: input.claim,
    cited_knowledge_ids: input.citedKnowledgeIds ?? [],
    prediction: {
      metric: input.metric ?? "gate_resolution",
      operator: input.operator ?? "exists",
      target: input.target ?? true,
      timeWindow: input.timeWindow ?? "next scheduler tick",
    },
    if_approved: input.ifApproved,
    if_rejected: input.ifRejected,
    rollback_ref: input.rollbackRef ?? "event_log:human_gate_items",
  };
}

function parsePayload(payload: string): Record<string, any> {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function withDecisionBriefPayload(payload: Record<string, any>, brief: DecisionBrief): string {
  return JSON.stringify({ ...payload, decision_brief: brief });
}

export function decisionBriefForGate(gate: HumanGateItem): DecisionBrief | null {
  const payload = parsePayload(gate.payload);
  return decisionBriefFromPayload(payload);
}

export function decisionBriefFromPayload(payload: unknown): DecisionBrief | null {
  const source = typeof payload === "string" ? parsePayload(payload) : payload;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const record = source as Record<string, any>;
  if (record.legacy === true || record.decision_brief?.legacy === true) return null;
  const brief = record.decision_brief;
  return brief && typeof brief === "object" && !Array.isArray(brief) ? brief as DecisionBrief : null;
}

export function assertDecisionBriefPayload(gate: HumanGateItem): void {
  const payload = parsePayload(gate.payload);
  if (payload.legacy === true || payload.decision_brief?.legacy === true) return;

  const brief = payload.decision_brief;
  const errors: string[] = [];
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    errors.push("decision_brief missing");
  } else {
    if (!nonEmptyString(brief.claim)) errors.push("claim missing");
    if (!stringArray(brief.cited_knowledge_ids)) errors.push("cited_knowledge_ids must be string[]");
    const prediction = brief.prediction;
    if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) {
      errors.push("prediction missing");
    } else {
      if (!nonEmptyString(prediction.metric)) errors.push("prediction.metric missing");
      if (!nonEmptyString(prediction.operator)) errors.push("prediction.operator missing");
      if (prediction.target == null) errors.push("prediction.target missing");
      if (!nonEmptyString(prediction.timeWindow)) errors.push("prediction.timeWindow missing");
    }
    if (!nonEmptyString(brief.if_approved)) errors.push("if_approved missing");
    if (!nonEmptyString(brief.if_rejected)) errors.push("if_rejected missing");
    if (!nonEmptyString(brief.rollback_ref)) errors.push("rollback_ref missing");
  }

  if (errors.length > 0) {
    throw new Error(`human gate ${gate.id} has invalid decision_brief: ${errors.join("; ")}`);
  }
}
