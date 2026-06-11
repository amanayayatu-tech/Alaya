import { rawDb, storage } from "../storage";
import { runModeFromEnv } from "../config/env";
import { categorizeAccumulatedError } from "alaya-core/src/core/sensor_filter.js";
import { sensorStructuralThresholdFromEnv } from "../config/env";

const startedAt = Date.now();

const schedulerRuntime = {
  cyclesTotal: 0,
  failuresTotal: 0,
  totalDurationMs: 0,
  lastSuccessfulCycleTimestamp: 0,
};

export function observeSchedulerCycle(input: { ok: boolean; durationMs: number }): void {
  schedulerRuntime.cyclesTotal += 1;
  schedulerRuntime.totalDurationMs += Math.max(0, input.durationMs);
  if (input.ok) schedulerRuntime.lastSuccessfulCycleTimestamp = Date.now();
  else schedulerRuntime.failuresTotal += 1;
}

function count(sql: string): number {
  const row = rawDb.prepare(sql).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function countWithParams(sql: string, ...params: unknown[]): number {
  const row = rawDb.prepare(sql).get(...params) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function groupedCounts(sql: string): Record<string, number> {
  const rows = rawDb.prepare(sql).all() as Array<{ label?: string | null; count?: number }>;
  return Object.fromEntries(rows.map((row) => [String(row.label ?? "unknown"), Number(row.count ?? 0)]));
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numberArray(value: string | null | undefined): number[] {
  return parseJsonArray(value).filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function latestClosedCycleTimestamp(): number {
  const row = rawDb.prepare(`
    SELECT ts FROM event_log
    WHERE table_name='cycles' AND op='close'
    ORDER BY ts DESC
    LIMIT 1
  `).get() as { ts?: string } | undefined;
  const parsed = Date.parse(row?.ts ?? "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function stallEventCount(): number {
  const rows = rawDb.prepare(`
    SELECT payload FROM human_gate_items
    WHERE type='risk'
  `).all() as Array<{ payload: string }>;
  return rows.filter((row) => /evolution_stalled|goal_repetition|maturation_stall|knowledge_explosion|stalled|stall/i.test(row.payload)).length;
}

function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

function perAgentLatency(llmCalls = storage.listLlmCalls()) {
  const agents = ["orchestrator", "sensor", "builder", "distiller", "librarian"];
  return Object.fromEntries(agents.map((agent) => {
    const calls = llmCalls.filter((call) => call.agent === agent);
    const latencies = calls.map((call) => call.latencyMs);
    const errors = calls.filter((call) => call.schemaValid !== 1 || !!call.llmFailureType);
    return [agent, {
      count: calls.length,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      avgMs: calls.length ? +(latencies.reduce((sum, value) => sum + value, 0) / calls.length).toFixed(3) : 0,
      errorCount: errors.length,
      errorRate: calls.length ? +(errors.length / calls.length).toFixed(6) : 0,
    }];
  }));
}

function reviewWindowAdherence(): number {
  const total = count("SELECT COUNT(*) AS count FROM review_sessions");
  if (total === 0) return 1;
  const closed = count("SELECT COUNT(*) AS count FROM review_sessions WHERE closed_at IS NOT NULL");
  return +(closed / total).toFixed(6);
}

function decisionDwellMs() {
  const rows = rawDb.prepare(`
    SELECT review_dwell_ms FROM human_gate_items
    WHERE review_dwell_ms IS NOT NULL
  `).all() as Array<{ review_dwell_ms: number | null }>;
  const values = rows.map((row) => Number(row.review_dwell_ms)).filter(Number.isFinite);
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

function speculativeTokensTotal(): number {
  const row = rawDb.prepare(`
    SELECT COALESCE(SUM(l.token_count), 0) AS count
    FROM llm_calls l
    JOIN cycles c ON c.id = l.cycle_id
    WHERE c.speculative = 1
  `).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function activeGrayCount(): number {
  return count(`
    SELECT COUNT(*) AS count FROM knowledge_items
    WHERE status='active'
      AND confidence_score > 0.3
      AND confidence_score < 0.7
      AND (superseded_by IS NULL OR superseded_by='')
  `);
}

function grayDemotedTotalByChannel(): Record<"cycle" | "wallclock", number> {
  return {
    cycle: count(`
      SELECT COUNT(*) AS count FROM event_log
      WHERE table_name='knowledge_items'
        AND op='update'
        AND actor='time_decay_scheduler'
        AND before LIKE '%"status":"active"%'
        AND after LIKE '%"status":"stale"%'
    `),
    wallclock: count(`
      SELECT COUNT(*) AS count FROM event_log
      WHERE table_name='knowledge_items'
        AND op='update'
        AND actor='librarian/gray_decay'
        AND before LIKE '%"status":"active"%'
        AND after LIKE '%"status":"stale"%'
    `),
  };
}

function utilitySkippedConfoundedTotal(): number {
  const rows = rawDb.prepare(`
    SELECT c.id AS cycleId, c.co_applied_set, p.knowledge_refs, p.worst_claim_error, p.prediction_error
    FROM cycles c
    JOIN predictions p ON p.cycle_id = c.id
    WHERE c.co_applied_set IS NOT NULL AND c.co_applied_set != ''
  `).all() as Array<{
    cycleId: string;
    co_applied_set: string | null;
    knowledge_refs: string;
    worst_claim_error: number | null;
    prediction_error: number | null;
  }>;
  const skippedCycleIds = new Set<string>();
  for (const row of rows) {
    const coApplied = parseJsonArray(row.co_applied_set).filter((item) => typeof item === "string");
    const refs = parseJsonArray(row.knowledge_refs).filter((item) => typeof item === "string");
    const worstError = row.worst_claim_error ?? row.prediction_error;
    if (coApplied.length > 0 && refs.length > 0 && typeof worstError === "number" && worstError > 0.5) {
      skippedCycleIds.add(row.cycleId);
    }
  }
  return skippedCycleIds.size;
}

function sensorErrorsTotalByCategory(): Record<"transient" | "recurring" | "structural", number> {
  const totals = { transient: 0, recurring: 0, structural: 0 };
  const rows = rawDb.prepare(`
    SELECT occurrence_count, event_timestamps_ms, last_seen_at FROM sensor_error_accumulators
  `).all() as Array<{ occurrence_count: number; event_timestamps_ms: string; last_seen_at: string }>;
  for (const row of rows) {
    const timestamps = numberArray(row.event_timestamps_ms);
    const lastSeen = Date.parse(row.last_seen_at);
    const currentTimeMs = Number.isFinite(lastSeen) ? lastSeen : (timestamps.at(-1) ?? Date.now());
    const categorized = categorizeAccumulatedError({
      occurrenceCount: row.occurrence_count,
      eventTimestampsMs: timestamps,
      structuralCountThreshold: sensorStructuralThresholdFromEnv(),
    }, currentTimeMs);
    totals[categorized.classification] += categorized.occurrenceCount;
  }
  return totals;
}

export function buildMetricsSnapshot() {
  const actions = storage.listActionLedger();
  const llmCalls = storage.listLlmCalls();
  const estimatedCost = llmCalls.reduce((sum, call) => sum + call.estimatedCost, 0);
  const inputTokenCount = llmCalls.reduce((sum, call) => sum + call.inputTokenCount, 0);
  const outputTokenCount = llmCalls.reduce((sum, call) => sum + call.outputTokenCount, 0);
  const dwell = decisionDwellMs();
  const durationAvg = schedulerRuntime.cyclesTotal
    ? schedulerRuntime.totalDurationMs / schedulerRuntime.cyclesTotal
    : 0;
  const grayDemoted = grayDemotedTotalByChannel();
  const sensorErrors = sensorErrorsTotalByCategory();
  const distillerProposals = groupedCounts(`
    SELECT status AS label, COUNT(*) AS count FROM distiller_proposals GROUP BY status
  `);

  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    mode: runModeFromEnv(),
    schedulerCyclesTotal: schedulerRuntime.cyclesTotal,
    schedulerCycleDurationMs: +durationAvg.toFixed(3),
    actionsTotal: actions.length,
    actionsDeniedTotal: actions.filter((action) => ["blocked", "denied"].includes(action.status)).length,
    capabilityDenialsTotal: actions.filter((action) => action.actionType.startsWith("capability.") && action.status === "blocked").length,
    llmRequestsTotal: llmCalls.length,
    llmTokensInputTotal: inputTokenCount,
    llmTokensOutputTotal: outputTokenCount,
    llmEstimatedCostUsdTotal: +estimatedCost.toFixed(6),
    externalFeedbackItemsTotal: count("SELECT COUNT(*) AS count FROM feedback_items WHERE source_type != 'scenario'"),
    knowledgeInjectionsTotal: count("SELECT COUNT(*) AS count FROM event_log WHERE actor='knowledge_injection' AND op='inject'"),
    stallEventsTotal: stallEventCount(),
    errorsTotal: count("SELECT COUNT(*) AS count FROM event_log WHERE op='error' OR op='sync_error'"),
    schedulerFailuresTotal: schedulerRuntime.failuresTotal,
    perAgentLatency: perAgentLatency(llmCalls),
    reviewWindowAdherence: reviewWindowAdherence(),
    decisionDwellMsP50: dwell.p50,
    decisionDwellMsP95: dwell.p95,
    gatesDeferredTotal: count("SELECT COUNT(*) AS count FROM human_gate_items WHERE status='deferred' OR decision='defer'"),
    speculativeCyclesTotal: count("SELECT COUNT(*) AS count FROM cycles WHERE speculative=1"),
    speculativeInvalidatedTotal: count("SELECT COUNT(*) AS count FROM cycles WHERE speculative=1 AND draft_status='invalidated'"),
    speculativeTokensTotal: speculativeTokensTotal(),
    applyQueueDepth: count("SELECT COUNT(*) AS count FROM cycles WHERE speculative=1 AND draft_status='apply_queued'"),
    applyRevokedTotal: count("SELECT COUNT(*) AS count FROM decision_log WHERE decision='revoked'"),
    grayActiveCount: activeGrayCount(),
    grayDemotedTotal: grayDemoted,
    utilityConfirmTotal: count(`
      SELECT COUNT(*) AS count FROM trace_events
      WHERE name='knowledge_cycle_utility_feedback'
        AND attributes LIKE '%"eventKind":"cycle_utility_confirm"%'
    `),
    utilityRefuteTotal: count(`
      SELECT COUNT(*) AS count FROM trace_events
      WHERE name='knowledge_cycle_utility_feedback'
        AND attributes LIKE '%"eventKind":"cycle_utility_refute"%'
    `),
    utilitySkippedConfoundedTotal: utilitySkippedConfoundedTotal(),
    sensorErrorsTotal: sensorErrors,
    distillerProposalsTotal: distillerProposals,
    goldRegressionRunsTotal: count("SELECT COUNT(*) AS count FROM event_log WHERE table_name='gold_cases' AND op='regression_triggered'"),
    goldRegressionFailuresTotal: count("SELECT COUNT(*) AS count FROM event_log WHERE table_name='gold_cases' AND op='regression_triggered' AND after LIKE '%\"failed\":true%'"),
    attributionLowConfidenceTotal: countWithParams("SELECT COUNT(*) AS count FROM pending_attributions WHERE confidence < ?", 0.7),
    lastSuccessfulCycleTimestamp: Math.max(
      Math.floor(schedulerRuntime.lastSuccessfulCycleTimestamp / 1000),
      latestClosedCycleTimestamp(),
    ),
  };
}

function line(name: string, value: number, labels?: Record<string, string>): string {
  const renderedLabels = labels && Object.keys(labels).length
    ? `{${Object.entries(labels).map(([key, item]) => `${key}="${item.replace(/"/g, '\\"')}"`).join(",")}}`
    : "";
  return `${name}${renderedLabels} ${Number.isFinite(value) ? value : 0}`;
}

export function renderPrometheusMetrics(): string {
  const m = buildMetricsSnapshot();
  const lines = [
    "# HELP alaya_uptime_seconds Process uptime in seconds.",
    "# TYPE alaya_uptime_seconds gauge",
    line("alaya_uptime_seconds", m.uptimeSeconds),
    "# HELP alaya_mode_info Current Alaya run mode.",
    "# TYPE alaya_mode_info gauge",
    line("alaya_mode_info", 1, { mode: m.mode }),
    line("alaya_scheduler_cycles_total", m.schedulerCyclesTotal),
    line("alaya_scheduler_cycle_duration_ms", m.schedulerCycleDurationMs),
    line("alaya_actions_total", m.actionsTotal),
    line("alaya_actions_denied_total", m.actionsDeniedTotal),
    line("alaya_capability_denials_total", m.capabilityDenialsTotal),
    line("alaya_llm_requests_total", m.llmRequestsTotal),
    line("alaya_llm_tokens_input_total", m.llmTokensInputTotal),
    line("alaya_llm_tokens_output_total", m.llmTokensOutputTotal),
    line("alaya_llm_estimated_cost_usd_total", m.llmEstimatedCostUsdTotal),
    line("alaya_external_feedback_items_total", m.externalFeedbackItemsTotal),
    line("alaya_knowledge_injections_total", m.knowledgeInjectionsTotal),
    line("alaya_stall_events_total", m.stallEventsTotal),
    line("alaya_errors_total", m.errorsTotal + m.schedulerFailuresTotal),
    line("alaya_last_successful_cycle_timestamp", m.lastSuccessfulCycleTimestamp),
    line("alaya_review_window_adherence", m.reviewWindowAdherence),
    line("alaya_decision_dwell_ms_p50", m.decisionDwellMsP50),
    line("alaya_decision_dwell_ms_p95", m.decisionDwellMsP95),
    line("alaya_gates_deferred_total", m.gatesDeferredTotal),
    line("alaya_speculative_cycles_total", m.speculativeCyclesTotal),
    line("alaya_speculative_invalidated_total", m.speculativeInvalidatedTotal),
    line("alaya_speculative_tokens_total", m.speculativeTokensTotal),
    line("alaya_apply_queue_depth", m.applyQueueDepth),
    line("alaya_apply_revoked_total", m.applyRevokedTotal),
    line("alaya_gray_active_count", m.grayActiveCount),
    line("alaya_gray_demoted_total", m.grayDemotedTotal.cycle, { channel: "cycle" }),
    line("alaya_gray_demoted_total", m.grayDemotedTotal.wallclock, { channel: "wallclock" }),
    line("alaya_utility_confirm_total", m.utilityConfirmTotal),
    line("alaya_utility_refute_total", m.utilityRefuteTotal),
    line("alaya_utility_skipped_confounded_total", m.utilitySkippedConfoundedTotal),
    line("alaya_sensor_errors_total", m.sensorErrorsTotal.transient, { category: "transient" }),
    line("alaya_sensor_errors_total", m.sensorErrorsTotal.recurring, { category: "recurring" }),
    line("alaya_sensor_errors_total", m.sensorErrorsTotal.structural, { category: "structural" }),
    line("alaya_distiller_proposals_total", m.distillerProposalsTotal.proposed ?? 0, { status: "proposed" }),
    line("alaya_distiller_proposals_total", m.distillerProposalsTotal.gated ?? 0, { status: "gated" }),
    line("alaya_distiller_proposals_total", m.distillerProposalsTotal.approved ?? 0, { status: "approved" }),
    line("alaya_distiller_proposals_total", m.distillerProposalsTotal.applied ?? 0, { status: "applied" }),
    line("alaya_distiller_proposals_total", m.distillerProposalsTotal.rejected ?? 0, { status: "rejected" }),
    line("alaya_gold_regression_runs_total", m.goldRegressionRunsTotal),
    line("alaya_gold_regression_failures_total", m.goldRegressionFailuresTotal),
    line("alaya_attribution_low_confidence_total", m.attributionLowConfidenceTotal),
  ];
  for (const [agent, stats] of Object.entries(m.perAgentLatency)) {
    lines.push(line("alaya_llm_agent_latency_p50_ms", stats.p50Ms, { agent }));
    lines.push(line("alaya_llm_agent_latency_p95_ms", stats.p95Ms, { agent }));
    lines.push(line("alaya_llm_agent_error_rate", stats.errorRate, { agent }));
  }
  return `${lines.join("\n")}\n`;
}
