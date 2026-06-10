import { readFileSync } from "node:fs";
import { z } from "zod";
import { recordActionProposal } from "./actionLedger";
import { redactSensitiveData } from "./security/redact";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";
import { createDecisionBrief, withDecisionBriefPayload } from "./decisionBrief";
import type { ExternalBusinessSignal } from "@shared/schema";
import type { RiskLevel } from "@shared/core/types.js";

export const businessSignalTypeSchema = z.enum([
  "marketing_asset",
  "sales_plan",
  "customer_consultation",
  "order",
  "return_request",
  "customer_service",
  "finance_reconciliation",
  "hardware_feedback",
  "health_signal",
  "other",
]);

export const sensitivityLevelSchema = z.enum([
  "public",
  "internal",
  "customer_pii",
  "health_sensitive",
  "financial",
  "compliance_sensitive",
]);

export const riskLevelSchema = z.enum([
  "read_only",
  "draft_only",
  "local_write",
  "external_write",
  "destructive",
  "financial",
  "compliance_sensitive",
]);

export const externalBusinessSignalInputSchema = z.object({
  source: z.string().trim().min(1).max(120),
  sourceId: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(160),
  signalType: businessSignalTypeSchema,
  observedAt: z.string().trim().min(1).max(64),
  payload: z.record(z.unknown()).default({}),
  sensitivityLevel: sensitivityLevelSchema,
  dedupeKey: z.string().trim().min(1).max(240),
  riskLevel: riskLevelSchema,
}).strict();

export type ExternalBusinessSignalInput = z.infer<typeof externalBusinessSignalInputSchema>;

const SENSITIVE_LEVELS = new Set(["customer_pii", "health_sensitive", "financial", "compliance_sensitive"]);

function isSensitive(level: string): boolean {
  return SENSITIVE_LEVELS.has(level);
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "signal";
}

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function signalIdFor(input: ExternalBusinessSignalInput): string {
  return `bs_${input.projectId.slice(-6)}_${slug(input.source)}_${hash(input.dedupeKey)}`;
}

function feedbackIdFor(input: ExternalBusinessSignalInput): string {
  return `fb_business_${input.projectId.slice(-6)}_${hash(input.dedupeKey)}`;
}

function gateIdFor(feedbackId: string): string {
  return `gate_ext_${feedbackId}`;
}

function currentCycle(projectId: string) {
  const cycles = storage.listCycles(projectId);
  return cycles.find((cycle) => cycle.status !== "closed") ?? cycles.at(-1);
}

export function redactBusinessPayload(payload: Record<string, unknown>, sensitivityLevel: string): Record<string, unknown> {
  const redacted = redactSensitiveData(payload) as Record<string, unknown>;
  if (!isSensitive(sensitivityLevel)) return redacted;
  return {
    redacted: true,
    sensitivityLevel,
    fieldNames: Object.keys(redacted).sort(),
    summary: "Sensitive business signal payload redacted before audit persistence.",
  };
}

function riskForSensitivity(level: string, declared: RiskLevel): RiskLevel {
  if (level === "financial") return "financial";
  if (level === "health_sensitive" || level === "compliance_sensitive") return "compliance_sensitive";
  return declared;
}

function compactJson(value: unknown, max = 400): string {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function buildFeedbackText(input: ExternalBusinessSignalInput, redactedPayload: Record<string, unknown>): string {
  return [
    `Business Signal (${input.source}/${input.sourceId})`,
    `Type: ${input.signalType}`,
    `Observed at: ${input.observedAt}`,
    `Sensitivity: ${input.sensitivityLevel}`,
    `Payload: ${compactJson(redactedPayload)}`,
  ].join("\n");
}

function normalizePayload(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.payload;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { value: raw };
    }
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("payload.")) payload[key.slice("payload.".length)] = value;
  }
  return payload;
}

export function normalizeBusinessSignal(row: Record<string, unknown>): ExternalBusinessSignalInput {
  const candidate = {
    source: row.source,
    sourceId: row.sourceId ?? row.source_id,
    projectId: row.projectId ?? row.project_id,
    signalType: row.signalType ?? row.signal_type,
    observedAt: row.observedAt ?? row.observed_at,
    payload: normalizePayload(row),
    sensitivityLevel: row.sensitivityLevel ?? row.sensitivity_level,
    dedupeKey: row.dedupeKey ?? row.dedupe_key,
    riskLevel: row.riskLevel ?? row.risk_level,
  };
  const parsed = externalBusinessSignalInputSchema.parse(candidate);
  if (isSensitive(parsed.sensitivityLevel) && !["financial", "compliance_sensitive"].includes(parsed.riskLevel)) {
    throw new Error(`sensitive signal ${parsed.dedupeKey} requires financial or compliance_sensitive riskLevel`);
  }
  return parsed;
}

export interface BusinessSignalImportResult {
  imported: number;
  skipped: number;
  gatesCreated: number;
  signals: ExternalBusinessSignal[];
  errors: string[];
}

export function importBusinessSignals(rows: Array<Record<string, unknown>>): BusinessSignalImportResult {
  const result: BusinessSignalImportResult = { imported: 0, skipped: 0, gatesCreated: 0, signals: [], errors: [] };
  for (const row of rows) {
    try {
      const input = normalizeBusinessSignal(row);
      const cycle = currentCycle(input.projectId);
      if (!cycle) throw new Error(`project ${input.projectId} has no cycle to attach business signal`);
      const existing = storage.getExternalBusinessSignalByDedupe(input.projectId, input.dedupeKey);
      if (existing) {
        result.skipped += 1;
        result.signals.push(existing);
        continue;
      }

	      const redactedPayload = redactBusinessPayload(input.payload, input.sensitivityLevel);
	      const normalizedRiskLevel = riskForSensitivity(input.sensitivityLevel, input.riskLevel as RiskLevel);
	      const feedbackId = feedbackIdFor(input);
	      const gateId = gateIdFor(feedbackId);
	      const signal: ExternalBusinessSignal = {
        id: signalIdFor(input),
        source: input.source,
        sourceId: input.sourceId,
        projectId: input.projectId,
        signalType: input.signalType,
        observedAt: input.observedAt,
        payload: JSON.stringify(redactedPayload),
        sensitivityLevel: input.sensitivityLevel,
        dedupeKey: input.dedupeKey,
	        riskLevel: normalizedRiskLevel,
        feedbackId,
        gateId,
        createdAt: now(),
        version: 1,
      };

      recordActionProposal({
        projectId: input.projectId,
        cycleId: cycle.id,
        actionType: "business_signal.import",
        target: `${input.source}:${input.sourceId}`,
	        explicitRiskLevel: normalizedRiskLevel,
        payload: {
          source: input.source,
          sourceId: input.sourceId,
          signalType: input.signalType,
          sensitivityLevel: input.sensitivityLevel,
          dedupeKey: input.dedupeKey,
          payload: redactedPayload,
        },
        rollbackPlan: { removeSignalId: signal.id, removeFeedbackId: feedbackId, removeGateId: gateId },
        auditSummary: { adapter: "local_csv_json", redacted: isSensitive(input.sensitivityLevel) },
      });

      storage.createExternalBusinessSignal(signal);
      const feedback = storage.createFeedback({
        id: feedbackId,
        cycleId: cycle.id,
        text: buildFeedbackText(input, redactedPayload),
        category: input.signalType === "hardware_feedback" || input.signalType === "health_signal" ? "unclear_signal" : "metric_signal",
        sentiment: "neutral",
        sourceType: "business_signal",
        sourceRef: `${input.source}:${input.sourceId}`,
        sourceUrl: "",
        topicKey: slug(`${input.source}_${input.signalType}`),
        summary: `${input.signalType} from ${input.source}`,
        externalUpdatedAt: input.observedAt,
      });
      if (!storage.getGate(gateId)) {
        storage.createGate({
          id: gateId,
          cycleId: cycle.id,
          type: "meaning",
          blocking: 0,
          title: `业务信号意义闸: ${input.signalType}`,
          payload: withDecisionBriefPayload({
            source: "business_signal",
            sourceId: signal.id,
            externalId: `${input.source}:${input.sourceId}`,
            userQuote: feedback.text,
            category: feedback.category,
            sentiment: feedback.sentiment,
            topicKey: feedback.topicKey,
            summary: feedback.summary,
            sensitivityLevel: input.sensitivityLevel,
            riskLevel: normalizedRiskLevel,
            payload: redactedPayload,
            createdAt: now(),
          }, createDecisionBrief({
            claim: `Business signal ${input.source}/${input.sourceId} should enter the learning loop`,
            metric: "business_signal_review",
            timeWindow: "before next knowledge injection",
            ifApproved: "The signal can be converted into approved meaning knowledge and included in conflict checks.",
            ifRejected: "The signal remains stored as feedback but does not enter active knowledge.",
            rollbackRef: "external_business_signals.dedupe_key",
          })),
          status: "pending",
          estimatedMinutes: isSensitive(input.sensitivityLevel) ? 12 : 8,
          decision: null,
          version: 1,
        });
        result.gatesCreated += 1;
      }
      storage.recordAgentRun({
        cycleId: cycle.id,
        cycleIdx: cycle.idx,
        agent: "sensor",
        action: "import_business_signal",
        outputSummary: `Business signal ${input.source}/${input.sourceId}: gate=${gateId}`,
        knowledgeRefsUsed: "[]",
        ts: now(),
      });
      recordTrace({
        projectId: input.projectId,
        cycleId: cycle.id,
        cycleIdx: cycle.idx,
        kind: "agent_run",
        name: "business_signal_import",
        agent: "sensor",
        attributes: {
          signalId: signal.id,
          feedbackId,
          gateId,
          signalType: input.signalType,
          sensitivityLevel: input.sensitivityLevel,
          payload: redactedPayload,
        },
      });
      result.imported += 1;
      result.signals.push(signal);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(current);
      current = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(current);
      rows.push(row);
      row = [];
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((item) => item.some((cell) => cell.trim().length > 0));
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((key, index) => [key.trim(), cells[index]?.trim() ?? ""])));
}

export function importBusinessSignalsFromFile(path: string): BusinessSignalImportResult {
  const text = readFileSync(path, "utf8");
  const rows = path.toLowerCase().endsWith(".json")
    ? JSON.parse(text)
    : parseCsv(text);
  if (!Array.isArray(rows)) throw new Error("business signal import file must contain an array of rows");
  return importBusinessSignals(rows as Array<Record<string, unknown>>);
}
