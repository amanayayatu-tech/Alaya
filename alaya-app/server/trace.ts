import { storage, now } from "./storage";
import type { TraceEventItem } from "@shared/schema";

type TraceStatus = "ok" | "error" | "blocked";

export interface RecordTraceInput {
  projectId: string;
  cycleId?: string | null;
  cycleIdx?: number | null;
  kind: string;
  name: string;
  agent?: string | null;
  status?: TraceStatus;
  attributes?: Record<string, unknown>;
  parentSpanId?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
}

let traceCounter = 0;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ unstringifiable: true });
  }
}

function hashHex(input: string, width: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(Math.ceil(width / 8)).slice(0, width);
}

function traceIdFor(input: RecordTraceInput): string {
  return hashHex(`${input.projectId}:${input.cycleId ?? "project"}`, 32);
}

function spanIdFor(input: RecordTraceInput, createdAt: string): string {
  traceCounter += 1;
  return hashHex(`${traceIdFor(input)}:${input.kind}:${input.name}:${createdAt}:${traceCounter}:${JSON.stringify(input.attributes ?? {})}`, 16);
}

export function recordTrace(input: RecordTraceInput): TraceEventItem {
  const startedAt = input.startedAt ?? now();
  const spanId = spanIdFor(input, startedAt);
  const event: TraceEventItem = {
    id: `tr_${spanId}`,
    traceId: traceIdFor(input),
    spanId,
    parentSpanId: input.parentSpanId ?? null,
    projectId: input.projectId,
    cycleId: input.cycleId ?? null,
    cycleIdx: input.cycleIdx ?? null,
    kind: input.kind,
    name: input.name,
    agent: input.agent ?? null,
    status: input.status ?? "ok",
    attributes: safeJson(input.attributes ?? {}),
    startedAt,
    endedAt: input.endedAt ?? startedAt,
    durationMs: input.durationMs ?? 0,
  };
  storage.recordTraceEvent(event);
  return event;
}

export function parseTraceEvent(event: TraceEventItem) {
  let attributes: unknown = {};
  try {
    attributes = JSON.parse(event.attributes);
  } catch {
    attributes = {};
  }
  return { ...event, attributes };
}
