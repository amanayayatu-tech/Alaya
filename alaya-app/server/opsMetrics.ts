import { claimSchema } from "@shared/schema";
import { rawDb, storage } from "./storage";
import type { HumanGateItem } from "@shared/schema";

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

function isActiveGrayStatus(value: Record<string, any>): boolean {
  return value.status === "active" &&
    typeof value.confidenceScore === "number" &&
    value.confidenceScore > 0.3 &&
    value.confidenceScore < 0.7 &&
    !value.supersededBy;
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

function weekStartIso(d = new Date()): string {
  const start = new Date(d);
  const day = start.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + diff);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

function consumesHumanMinutes(gate: HumanGateItem): boolean {
  if (gate.status === "pending") return false;
  const decision = gate.decision ?? "";
  if (decision.startsWith("merged_into:")) return false;
  if (decision.startsWith("auto_approved_repeated_meaning:")) return false;
  if (decision.startsWith("auto_resolved_")) return false;
  return true;
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

export function decisionDwellMetrics(projectId: string) {
  const gates = storage.listGates(projectId).filter((gate) => Number.isFinite(gate.reviewDwellMs ?? Number.NaN));
  const all = gates.map((gate) => Number(gate.reviewDwellMs));
  const blocking = gates.filter((gate) => gate.blocking === 1).map((gate) => Number(gate.reviewDwellMs));
  const blockingP50 = median(blocking);
  return {
    sampleSize: all.length,
    p50Ms: median(all),
    p95Ms: percentile(all, 95),
    blockingSampleSize: blocking.length,
    blockingP50Ms: blockingP50,
    blockingP95Ms: percentile(blocking, 95),
    lowBlockingDwellWarning: blocking.length >= 3 && blockingP50 != null && blockingP50 < 10_000,
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

export function grayActiveStockTrend(projectId: string) {
  const cycles = storage.listCycles(projectId).sort((a, b) => a.idx - b.idx);
  const events = rawDb.prepare(`
    SELECT id, cycle_idx, before, after FROM event_log
    WHERE table_name='knowledge_items'
      AND op IN ('insert','update')
      AND (before LIKE ? OR after LIKE ?)
    ORDER BY id ASC
  `).all(`%"projectId":"${projectId}"%`, `%"projectId":"${projectId}"%`) as Array<{
    id: number;
    cycle_idx: number;
    before: string | null;
    after: string | null;
  }>;
  const activeGrayIds = new Set<string>();
  const eventPoints = new Map<number, number>();

  for (const event of events) {
    const after = parseObject(event.after);
    const before = parseObject(event.before);
    const id = typeof after.id === "string" ? after.id : typeof before.id === "string" ? before.id : "";
    if (!id) continue;
    if (isActiveGrayStatus(after)) activeGrayIds.add(id);
    else activeGrayIds.delete(id);
    eventPoints.set(event.cycle_idx, activeGrayIds.size);
  }

  let lastCount = 0;
  const points = cycles.length
    ? cycles.map((cycle) => {
      if (eventPoints.has(cycle.idx)) lastCount = eventPoints.get(cycle.idx) ?? lastCount;
      return { cycleIdx: cycle.idx, grayActiveCount: lastCount };
    })
    : [{ cycleIdx: 0, grayActiveCount: storage.listKnowledge(projectId).filter((item) => isActiveGrayStatus(item as any)).length }];

  const increases = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (current.grayActiveCount > previous.grayActiveCount) {
      increases.push({
        fromCycleIdx: previous.cycleIdx,
        toCycleIdx: current.cycleIdx,
        delta: current.grayActiveCount - previous.grayActiveCount,
      });
    }
  }

  return {
    current: points.at(-1)?.grayActiveCount ?? 0,
    points,
    monotonicNonIncreasing: increases.length === 0,
    warning: increases.length > 0,
    increases,
  };
}

export function meaningGateBudgetPressure(projectId: string, at = new Date()) {
  const project = storage.getProject(projectId);
  const budget = project?.weeklyHumanMinutes ?? 150;
  const weekStartMs = Date.parse(weekStartIso(at));
  const meaningGates = storage.listGates(projectId).filter((gate) => gate.type === "meaning");
  const usedMinutes = meaningGates
    .filter(consumesHumanMinutes)
    .filter((gate) => {
      const resolvedAt = Date.parse(gateResolvedAt(gate) ?? "");
      return Number.isFinite(resolvedAt) && resolvedAt >= weekStartMs;
    })
    .reduce((sum, gate) => sum + gate.estimatedMinutes, 0);
  const pendingEstimatedMinutes = meaningGates
    .filter((gate) => gate.status === "pending")
    .reduce((sum, gate) => sum + gate.estimatedMinutes, 0);
  const projectedMinutes = usedMinutes + pendingEstimatedMinutes;
  return {
    budget,
    weekStart: new Date(weekStartMs).toISOString(),
    usedMinutes,
    pendingEstimatedMinutes,
    projectedMinutes,
    pendingMeaningGates: meaningGates.filter((gate) => gate.status === "pending").length,
    overBudget: projectedMinutes > budget,
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
  const grayTrend = grayActiveStockTrend(projectId);
  const meaningBudget = meaningGateBudgetPressure(projectId);
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    guardrails: {
      emptyDatasetSafe: true,
      smallSampleWarning: storage.listCycles(projectId).length < 3,
    },
    humanGateResolution: humanGateResolutionMetrics(projectId),
    decisionDwell: decisionDwellMetrics(projectId),
    llmCostPerCycle: llmCostPerCycle(projectId),
    measurableClaimRatio: measurableClaimRatio(projectId),
    knowledgeReuseRate: knowledgeReuseRate(projectId),
    blockingGateBacklog: blockingGateBacklog(projectId),
    grayActiveStockTrend: grayTrend,
    meaningGateBudget: meaningBudget,
    compoundingGainProxyPerCycle: compoundingGainProxyPerCycle(projectId),
    sources: {
      humanGateResolution: ["human_gate_items.payload.createdAt/resolvedAt", "event_log"],
      decisionDwell: ["human_gate_items.review_dwell_ms"],
      llmCostPerCycle: ["cycles", "llm_calls"],
      measurableClaimRatio: ["predictions.claims"],
      knowledgeReuseRate: ["knowledge_items.usage_count", "event_log actor=knowledge_injection"],
      blockingGateBacklog: ["human_gate_items"],
      grayActiveStockTrend: ["event_log table=knowledge_items", "cycles"],
      meaningGateBudget: ["human_gate_items", "projects.weekly_human_minutes", "event_log"],
      compoundingGainProxyPerCycle: ["cycles.e_cycle", "trace_events.kind=knowledge_injection", "knowledge_items.status"],
    },
  };
}

export function opsMetricsDigestLines(projectId: string): string[] {
  const metrics = buildOpsMetrics(projectId);
  const lines: string[] = [];
  if (metrics.grayActiveStockTrend.warning) {
    const increases = metrics.grayActiveStockTrend.increases
      .map((item) => `${item.fromCycleIdx}->${item.toCycleIdx} +${item.delta}`)
      .join(", ");
    lines.push(`灰区存量趋势告警：未单调下降（${increases}）`);
  }
  if (metrics.meaningGateBudget.overBudget) {
    lines.push(`意义闸预算告警：预计 ${metrics.meaningGateBudget.projectedMinutes}/${metrics.meaningGateBudget.budget} 分钟（pending ${metrics.meaningGateBudget.pendingEstimatedMinutes}）。`);
  }
  return lines;
}
