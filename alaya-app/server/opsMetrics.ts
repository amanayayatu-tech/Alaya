import { claimSchema } from "@shared/schema";
import { rawDb, storage } from "./storage";

export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

function parseObject(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseClaims(value: string): Record<string, any>[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

function isMeasurableClaim(raw: Record<string, any>): boolean {
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) return false;
  const claim = parsed.data;
  if (claim.type === "metric_threshold") return claim.observed != null && Number.isFinite(claim.observed);
  if (claim.type === "binary" || claim.type === "categorical") return claim.actual != null;
  if (claim.type === "directional") return claim.actualDirection != null;
  return false;
}

function eventTsFor(tableName: string, op: string, id: string): string | null {
  const rows = rawDb.prepare(`
    SELECT before, after, ts FROM event_log
    WHERE table_name=? AND op=?
    ORDER BY id ASC
  `).all(tableName, op) as Array<{ before: string | null; after: string | null; ts: string }>;
  for (const row of rows) {
    const after = parseObject(row.after);
    const before = parseObject(row.before);
    if (after.id === id || before.id === id || after.gateId === id) return row.ts;
  }
  return null;
}

function gateCreatedAt(gate: ReturnType<typeof storage.listGates>[number]): string | null {
  return parseObject(gate.payload).createdAt ?? eventTsFor("human_gate_items", "insert", gate.id);
}

function gateResolvedAt(gate: ReturnType<typeof storage.listGates>[number]): string | null {
  const payload = parseObject(gate.payload);
  if (typeof payload.resolvedAt === "string") return payload.resolvedAt;
  return eventTsFor("human_gate_items", "update", gate.id);
}

export function humanGateResolutionMetrics(projectId: string) {
  const durations = storage.listGates(projectId)
    .filter((gate) => gate.status !== "pending")
    .map((gate) => {
      const created = Date.parse(gateCreatedAt(gate) ?? "");
      const resolved = Date.parse(gateResolvedAt(gate) ?? "");
      return Number.isFinite(created) && Number.isFinite(resolved) && resolved >= created ? resolved - created : Number.NaN;
    })
    .filter(Number.isFinite);
  return {
    sampleSize: durations.length,
    medianMs: median(durations),
    p95Ms: percentile(durations, 95),
    medianMinutes: median(durations) == null ? null : +((median(durations) ?? 0) / 60_000).toFixed(3),
    p95Minutes: percentile(durations, 95) == null ? null : +((percentile(durations, 95) ?? 0) / 60_000).toFixed(3),
  };
}

export function llmCostPerCycle(projectId: string) {
  const cycles = storage.listCycles(projectId);
  const byCycle = cycles.map((cycle) => {
    const calls = storage.listLlmCalls().filter((call) => call.cycleId === cycle.id);
    return {
      cycleId: cycle.id,
      cycleIdx: cycle.idx,
      callCount: calls.length,
      estimatedCostUsd: +calls.reduce((sum, call) => sum + call.estimatedCost, 0).toFixed(6),
      inputTokens: calls.reduce((sum, call) => sum + call.inputTokenCount, 0),
      outputTokens: calls.reduce((sum, call) => sum + call.outputTokenCount, 0),
    };
  });
  return {
    totalCostUsd: +byCycle.reduce((sum, row) => sum + row.estimatedCostUsd, 0).toFixed(6),
    byCycle,
  };
}

export function measurableClaimRatio(projectId: string) {
  const predictions = storage.listPredictionsByProject(projectId);
  const claims = predictions.flatMap((prediction) => parseClaims(prediction.claims));
  const measurable = claims.filter(isMeasurableClaim);
  return {
    predictionCount: predictions.length,
    claimCount: claims.length,
    measurableClaimCount: measurable.length,
    ratio: claims.length === 0 ? null : +(measurable.length / claims.length).toFixed(6),
  };
}

export function knowledgeReuseRate(projectId: string) {
  const eligible = storage.listKnowledge(projectId).filter((item) => (
    !item.supersededBy && ["active", "strong"].includes(item.status)
  ));
  const reused = eligible.filter((item) => item.usageCount > 0);
  const injectionEvents = rawDb.prepare(`
    SELECT COUNT(*) AS count FROM event_log
    WHERE actor='knowledge_injection' AND op='inject' AND after LIKE ?
  `).get(`%"projectId":"${projectId}"%`) as { count?: number } | undefined;
  return {
    eligibleKnowledgeCount: eligible.length,
    reusedKnowledgeCount: reused.length,
    injectionEventCount: Number(injectionEvents?.count ?? 0),
    rate: eligible.length === 0 ? null : +(reused.length / eligible.length).toFixed(6),
  };
}

export function blockingGateBacklog(projectId: string) {
  const nowMs = Date.now();
  const pending = storage.listGates(projectId).filter((gate) => gate.status === "pending" && gate.blocking === 1);
  const ages = pending.map((gate) => {
    const created = Date.parse(gateCreatedAt(gate) ?? "");
    return Number.isFinite(created) ? Math.max(0, nowMs - created) : 0;
  });
  return {
    count: pending.length,
    estimatedMinutes: pending.reduce((sum, gate) => sum + gate.estimatedMinutes, 0),
    oldestAgeDays: ages.length === 0 ? 0 : +(Math.max(...ages) / 86_400_000).toFixed(3),
  };
}

function injectionCountByCycle(cycleId: string): number {
  const rows = rawDb.prepare(`
    SELECT COUNT(*) AS count FROM trace_events
    WHERE cycle_id=? AND kind='knowledge_injection'
  `).get(cycleId) as { count?: number } | undefined;
  return Number(rows?.count ?? 0);
}

export function compoundingGainProxyPerCycle(projectId: string) {
  const cycles = storage.listCycles(projectId).sort((a, b) => a.idx - b.idx);
  let previousError: number | null = null;
  let previousStrong = 0;
  return cycles.map((cycle) => {
    const currentStrong = storage.listKnowledge(projectId).filter((item) => item.status === "strong" && item.createdByCycle <= cycle.idx).length;
    const errorImprovement = previousError != null && cycle.eCycle != null ? +(previousError - cycle.eCycle).toFixed(6) : null;
    const reuseBoost = Math.min(0.1, injectionCountByCycle(cycle.id) * 0.01);
    const strongDelta = Math.max(0, currentStrong - previousStrong);
    const proxy = (errorImprovement ?? 0) + reuseBoost + strongDelta * 0.02;
    previousError = cycle.eCycle ?? previousError;
    previousStrong = currentStrong;
    return {
      cycleId: cycle.id,
      cycleIdx: cycle.idx,
      eCycle: cycle.eCycle,
      errorImprovement,
      knowledgeInjectionCount: injectionCountByCycle(cycle.id),
      strongKnowledgeDelta: strongDelta,
      compoundingGainProxy: +proxy.toFixed(6),
    };
  });
}

export function buildOpsMetrics(projectId: string) {
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    guardrails: {
      emptyDatasetSafe: true,
      smallSampleWarning: storage.listCycles(projectId).length < 3,
    },
    humanGateResolution: humanGateResolutionMetrics(projectId),
    llmCostPerCycle: llmCostPerCycle(projectId),
    measurableClaimRatio: measurableClaimRatio(projectId),
    knowledgeReuseRate: knowledgeReuseRate(projectId),
    blockingGateBacklog: blockingGateBacklog(projectId),
    compoundingGainProxyPerCycle: compoundingGainProxyPerCycle(projectId),
    sources: {
      humanGateResolution: ["human_gate_items.payload.createdAt/resolvedAt", "event_log"],
      llmCostPerCycle: ["cycles", "llm_calls"],
      measurableClaimRatio: ["predictions.claims"],
      knowledgeReuseRate: ["knowledge_items.usage_count", "event_log actor=knowledge_injection"],
      blockingGateBacklog: ["human_gate_items"],
      compoundingGainProxyPerCycle: ["cycles.e_cycle", "trace_events.kind=knowledge_injection", "knowledge_items.status"],
    },
  };
}
