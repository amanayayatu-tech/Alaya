import {
  SENSOR_ACCUMULATOR_WINDOW_MS,
  SensorErrorKind,
  categorizeAccumulatedError,
  windowSensorErrorTimestamps,
  type SensorErrorClassification,
} from "alaya-core/src/core/sensor_filter.js";
import { routeError } from "alaya-core/src/core/classify_error.js";
import type { ErrorType } from "alaya-core/src/core/types.js";
import { createDecisionBrief, withDecisionBriefPayload } from "./decisionBrief";
import { sensorStructuralThresholdFromEnv } from "./config/env";
import { redactSensitiveData } from "./security/redact";
import { storage, now } from "./storage";
import type { HumanGateItem, PendingAttribution, SensorErrorAccumulator } from "@shared/schema";

export const LOW_ATTRIBUTION_CONFIDENCE_THRESHOLD = 0.7;

interface SensorFirewallInput {
  projectId: string;
  cycleId: string;
  source: string;
  errorKind: SensorErrorKind | string;
  summary: string;
  externalId?: string;
  observedAt?: string;
  sample?: Record<string, unknown>;
  currentTimeMs?: number;
}

export interface SensorFirewallDecision {
  fingerprint: string;
  classification: SensorErrorClassification;
  perceptionFailure: boolean;
  route: string;
  accumulator: SensorErrorAccumulator;
  gate: HumanGateItem | null;
}

interface PendingAttributionInput {
  projectId: string;
  cycleId: string;
  metric: string;
  errorType: ErrorType;
  claimError: number | null;
  context: Record<string, unknown>;
  confidence: number;
  lowConfidenceReasons: string[];
  currentTimeMs?: number;
}

export interface PendingAttributionDecision {
  fingerprint: string;
  shouldReleaseDistiller: boolean;
  pendingAttribution: PendingAttribution | null;
  gate: HumanGateItem | null;
  status: "proceed" | "pending" | "released" | "gated";
}

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function parseTimestamp(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTimestampList(value: string | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stableGateId(prefix: string, fingerprint: string): string {
  return `${prefix}_${hash(fingerprint)}`;
}

export function sensorErrorFingerprint(projectId: string, source: string, errorKind: SensorErrorKind | string): string {
  return `${projectId}:${source}:${errorKind}`;
}

export function pendingAttributionFingerprint(projectId: string, metric: string, errorType: ErrorType): string {
  return `${projectId}:${metric}:${errorType ?? "none"}`;
}

function normalizeSensorErrorKind(value: SensorErrorKind | string): SensorErrorKind {
  const normalized = String(value).trim().toLowerCase();
  const known = Object.values(SensorErrorKind).find((item) => item === normalized);
  return known ?? SensorErrorKind.Unknown;
}

export function sensorErrorKindFromPayload(payload: Record<string, unknown>, text = ""): SensorErrorKind | null {
  const direct = [
    payload.sensorErrorKind,
    payload.sensor_error_kind,
    payload.errorKind,
    payload.error_kind,
  ].find((item) => typeof item === "string" && item.trim());
  if (direct) return normalizeSensorErrorKind(String(direct));
  if (payload.perceptionFailure === true || payload.sensorError === true || payload.sensor_error === true) {
    return SensorErrorKind.Unknown;
  }
  const haystack = `${JSON.stringify(payload)}\n${text}`.toLowerCase();
  if (!/(sensor|传感器|ppg|wearable|device|data source|数据源|source sync|采集)/i.test(haystack)) return null;
  if (/(schema|shape|字段|口径|format)/i.test(haystack)) return SensorErrorKind.SchemaMismatch;
  if (/(missing|empty|null|缺失|丢失)/i.test(haystack)) return SensorErrorKind.DataMissing;
  if (/(unavailable|timeout|sync|fetch|503|断连|同步失败)/i.test(haystack)) return SensorErrorKind.SourceUnavailable;
  if (/(parse|json|csv|解析)/i.test(haystack)) return SensorErrorKind.PayloadParseError;
  if (/(error|fail|failure|异常|失败)/i.test(haystack)) return SensorErrorKind.Unknown;
  return null;
}

function gateSummary(input: SensorFirewallInput, classification: SensorErrorClassification): string {
  return `${classification} sensor error ${input.errorKind} from ${input.source}: ${input.summary}`.slice(0, 500);
}

function ensureSensorGate(input: SensorFirewallInput, decision: {
  fingerprint: string;
  classification: SensorErrorClassification;
  occurrenceCount: number;
  hourlyCount: number;
}): HumanGateItem {
  const isStructural = decision.classification === "structural";
  const gateId = stableGateId(isStructural ? "gate_sensor_structural" : "gate_sensor_recurring", decision.fingerprint);
  const existing = storage.getGate(gateId);
  if (existing) return existing;

  const metric = isStructural
    ? `sensor_error_rate:${decision.fingerprint}`
    : `sensor_error_count:${decision.fingerprint}`;
  const target = isStructural ? 0.05 : 4;
  return storage.createGate({
    id: gateId,
    cycleId: input.cycleId,
    type: "meaning",
    blocking: 0,
    title: isStructural ? "Sensor 结构异常意义闸" : "低优先级 Sensor 异常提示",
    payload: withDecisionBriefPayload({
      source: "sensor_firewall",
      externalId: input.externalId ?? "",
      fingerprint: decision.fingerprint,
      errorKind: normalizeSensorErrorKind(input.errorKind),
      classification: decision.classification,
      perceptionFailure: !isStructural,
      route: isStructural ? routeError("value") : routeError("perception"),
      occurrenceCount: decision.occurrenceCount,
      hourlyCount: decision.hourlyCount,
      summary: gateSummary(input, decision.classification),
      sample: redactSensitiveData(input.sample ?? {}),
      createdAt: now(),
    }, createDecisionBrief({
      claim: isStructural
        ? `Sensor fingerprint ${decision.fingerprint} is likely a structural source drift`
        : `Sensor fingerprint ${decision.fingerprint} is recurring but still routed as perception failure`,
      metric,
      operator: "<=",
      target,
      timeWindow: isStructural ? "修复后48h" : "next 7d",
      ifApproved: isStructural
        ? "Treat this as a source-level structural issue and verify the sensor error rate after repair."
        : "Keep this as a low-priority review-window reminder while perception routing absorbs the bad samples.",
      ifRejected: "Keep the events in sensor_error_accumulators without promoting them into model knowledge.",
      rollbackRef: `sensor_error_accumulators:${decision.fingerprint}`,
    })),
    status: "pending",
    estimatedMinutes: isStructural ? 8 : 3,
    decision: null,
    notifyPolicy: "next_window",
    version: 1,
  });
}

export function recordSensorFirewallError(input: SensorFirewallInput): SensorFirewallDecision {
  const currentTimeMs = input.currentTimeMs ?? Date.now();
  const observedMs = parseTimestamp(input.observedAt, currentTimeMs);
  const errorKind = normalizeSensorErrorKind(input.errorKind);
  const fingerprint = sensorErrorFingerprint(input.projectId, input.source, errorKind);
  const existing = storage.getSensorErrorAccumulator(fingerprint);
  const windowedTimestamps = windowSensorErrorTimestamps([
    ...parseTimestampList(existing?.eventTimestampsMs),
    observedMs,
  ], currentTimeMs);
  const categorized = categorizeAccumulatedError({
    eventTimestampsMs: windowedTimestamps,
    structuralCountThreshold: sensorStructuralThresholdFromEnv(),
  }, currentTimeMs);
  const accumulator = storage.upsertSensorErrorAccumulator({
    fingerprint,
    projectId: input.projectId,
    source: input.source,
    errorKind,
    occurrenceCount: categorized.occurrenceCount,
    eventTimestampsMs: JSON.stringify(categorized.windowedEventTimestampsMs),
    firstSeenAt: existing?.firstSeenAt && categorized.windowedEventTimestampsMs.some((value) => iso(value) === existing.firstSeenAt)
      ? existing.firstSeenAt
      : iso(categorized.windowedEventTimestampsMs[0] ?? observedMs),
    lastSeenAt: iso(categorized.windowedEventTimestampsMs.at(-1) ?? observedMs),
    version: existing?.version ?? 1,
  });

  const gate = categorized.classification === "transient"
    ? null
    : ensureSensorGate(input, {
      fingerprint,
      classification: categorized.classification,
      occurrenceCount: categorized.occurrenceCount,
      hourlyCount: categorized.hourlyCount,
    });

  return {
    fingerprint,
    classification: categorized.classification,
    perceptionFailure: categorized.classification !== "structural",
    route: categorized.classification === "structural" ? routeError("value") : routeError("perception"),
    accumulator,
    gate,
  };
}

function pendingSince(currentTimeMs: number): string {
  return iso(currentTimeMs - SENSOR_ACCUMULATOR_WINDOW_MS);
}

function pendingIdFor(input: PendingAttributionInput, fingerprint: string, existingCount: number, createdAt: string): string {
  return `pa_${hash(fingerprint)}_${existingCount + 1}_${hash(`${createdAt}:${JSON.stringify(input.context)}`)}`;
}

function contextMetric(row: PendingAttribution): string {
  const parsed = parseJsonObject(row.context);
  return typeof parsed.metric === "string" ? parsed.metric : "";
}

function ensureAttributionDisagreementGate(input: PendingAttributionInput, rows: PendingAttribution[]): HumanGateItem {
  const gateFingerprint = `${input.projectId}:${input.metric}:attribution_disagreement`;
  const gateId = stableGateId("gate_pending_attr", gateFingerprint);
  const existing = storage.getGate(gateId);
  if (existing) return existing;
  const samples = rows.map((row) => ({
    id: row.id,
    errorType: row.errorType,
    claimError: row.claimError,
    confidence: row.confidence,
    context: redactSensitiveData(parseJsonObject(row.context)),
    createdAt: row.createdAt,
  }));
  return storage.createGate({
    id: gateId,
    cycleId: input.cycleId,
    type: "meaning",
    blocking: 0,
    title: `低置信归因分歧: ${input.metric}`,
    payload: withDecisionBriefPayload({
      source: "pending_attributions",
      metric: input.metric,
      fingerprint: gateFingerprint,
      samples,
      summary: "低置信归因在 7 天窗口内出现不一致，需要人工裁定。",
      createdAt: now(),
    }, createDecisionBrief({
      claim: `Metric ${input.metric} has inconsistent low-confidence attribution samples`,
      metric: `attribution_disagreement:${input.projectId}:${input.metric}`,
      operator: "<=",
      target: 0,
      timeWindow: "next review window",
      ifApproved: "Use the human decision as the attribution direction and prevent automatic model proposal creation for the conflicting samples.",
      ifRejected: "Keep the samples pending until more evidence accumulates.",
      rollbackRef: `pending_attributions:${gateFingerprint}`,
    })),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    notifyPolicy: "next_window",
    version: 1,
  });
}

export function resolvePendingAttribution(input: PendingAttributionInput): PendingAttributionDecision {
  const errorType = input.errorType ?? null;
  const fingerprint = pendingAttributionFingerprint(input.projectId, input.metric, errorType);
  if (input.confidence >= LOW_ATTRIBUTION_CONFIDENCE_THRESHOLD) {
    return { fingerprint, shouldReleaseDistiller: true, pendingAttribution: null, gate: null, status: "proceed" };
  }

  const currentTimeMs = input.currentTimeMs ?? Date.now();
  const since = pendingSince(currentTimeMs);
  const existingForFingerprint = storage.listPendingAttributions(input.projectId, { fingerprint, since });
  const createdAt = iso(currentTimeMs);
  const pending = storage.createPendingAttribution({
    id: pendingIdFor(input, fingerprint, existingForFingerprint.length, createdAt),
    projectId: input.projectId,
    fingerprint,
    errorType,
    claimError: input.claimError,
    context: JSON.stringify(redactSensitiveData({
      ...input.context,
      metric: input.metric,
      cycleId: input.cycleId,
      lowConfidenceReasons: input.lowConfidenceReasons,
    })),
    confidence: input.confidence,
    status: "pending",
    gateId: null,
    resolvedAt: null,
    createdAt,
    version: 1,
  });

  const windowRowsForMetric = storage
    .listPendingAttributions(input.projectId, { since, status: "pending" })
    .filter((row) => contextMetric(row) === input.metric);
  const distinctErrorTypes = new Set(windowRowsForMetric.map((row) => row.errorType ?? "none"));
  if (distinctErrorTypes.size > 1) {
    const gate = ensureAttributionDisagreementGate(input, windowRowsForMetric);
    for (const row of windowRowsForMetric) {
      storage.updatePendingAttribution(row.id, { status: "gated", gateId: gate.id, resolvedAt: createdAt });
    }
    return { fingerprint, shouldReleaseDistiller: false, pendingAttribution: pending, gate, status: "gated" };
  }

  const consistentRows = windowRowsForMetric.filter((row) => row.fingerprint === fingerprint);
  if (consistentRows.length >= 3) {
    for (const row of consistentRows) {
      storage.updatePendingAttribution(row.id, { status: "released", resolvedAt: createdAt });
    }
    return { fingerprint, shouldReleaseDistiller: true, pendingAttribution: pending, gate: null, status: "released" };
  }

  return { fingerprint, shouldReleaseDistiller: false, pendingAttribution: pending, gate: null, status: "pending" };
}
