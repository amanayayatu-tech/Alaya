import { rawDb, storage } from "../storage";
import { runModeFromEnv } from "../config/env";

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

export function buildMetricsSnapshot() {
  const actions = storage.listActionLedger();
  const llmCalls = storage.listLlmCalls();
  const estimatedCost = llmCalls.reduce((sum, call) => sum + call.estimatedCost, 0);
  const inputTokenCount = llmCalls.reduce((sum, call) => sum + call.inputTokenCount, 0);
  const outputTokenCount = llmCalls.reduce((sum, call) => sum + call.outputTokenCount, 0);
  const durationAvg = schedulerRuntime.cyclesTotal
    ? schedulerRuntime.totalDurationMs / schedulerRuntime.cyclesTotal
    : 0;

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
  ];
  return `${lines.join("\n")}\n`;
}
