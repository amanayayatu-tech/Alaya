import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    out[key] = value ?? "true";
  }
  return out;
}

function latestRunDir() {
  const root = resolve("validation-logs");
  if (!existsSync(root)) return null;
  return readdirSync(root)
    .filter((name) => name.startsWith("health-signal-"))
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function parseCsv(file) {
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];
  const headers = rows[0].split(",");
  return rows.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((header, idx) => {
      const raw = cells[idx] ?? "";
      const numeric = Number(raw);
      row[header] = raw !== "" && Number.isFinite(numeric) ? numeric : raw;
    });
    return row;
  });
}

function parseJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { eventType: "unparseable_jsonl", raw: line };
      }
    });
}

function average(rows, field) {
  if (rows.length === 0) return null;
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function minMax(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  if (values.length === 0) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== "")));
}

function transition(rows, field) {
  if (rows.length === 0) return { first: null, latest: null, change: null };
  const first = Number(rows[0][field]);
  const latest = Number(rows.at(-1)[field]);
  return {
    first: Number.isFinite(first) ? first : null,
    latest: Number.isFinite(latest) ? latest : null,
    change: Number.isFinite(first) && Number.isFinite(latest) ? latest - first : null,
  };
}

const args = parseArgs(process.argv.slice(2));
const logDir = resolve(args["log-dir"] ?? latestRunDir() ?? "");
if (!logDir || !existsSync(logDir)) {
  throw new Error("Pass --log-dir=/path/to/health-signal run directory.");
}

const monitorPath = join(logDir, "monitor_log.csv");
const rows = existsSync(monitorPath) ? parseCsv(monitorPath) : [];
const events = parseJsonl(join(logDir, "events.jsonl"));
const earlyWindow = rows.slice(0, Math.min(3, rows.length));
const lateWindow = rows.slice(Math.max(0, rows.length - Math.min(3, rows.length)));
const latest = rows.at(-1) ?? null;
const deltaRange = minMax(rows, "round1vs4KnowledgeDelta");
const totalCycles = Number(latest?.cyclesTotal ?? 0);
const stallGuardCount = Number(latest?.stallGuardCount ?? 0);
const stallGuardRate = totalCycles > 0 ? stallGuardCount / totalCycles : null;
const explicitTrueStallGuardEvents = events.filter((event) => event.eventType === "stall_guard_true_trigger");
const approvedStallGuardEvents = events.filter(
  (event) => event.eventType === "gate_approved" && event.payloadRiskKey === "evolution_stalled",
);
const trueStallGuardEvents = [...explicitTrueStallGuardEvents, ...approvedStallGuardEvents];
const trueStallGuardGateIds = unique(trueStallGuardEvents.map((event) => event.gateId));
const trueStallGuardCount = trueStallGuardGateIds.length;
const trueStallGuardRate = totalCycles > 0 ? trueStallGuardCount / totalCycles : null;
const earlyPendingAvg = average(earlyWindow, "pendingGates");
const latePendingAvg = average(lateWindow, "pendingGates");
const pendingGateDropRatio =
  earlyPendingAvg != null && earlyPendingAvg > 0 && latePendingAvg != null
    ? (earlyPendingAvg - latePendingAvg) / earlyPendingAvg
    : null;
const schedulerEvents = events.filter((event) => event.eventType === "scheduler_tick");
const schedulerActionCounts = schedulerEvents.reduce((counts, event) => {
  const action = String(event.action ?? "unknown");
  counts[action] = (counts[action] ?? 0) + 1;
  return counts;
}, {});

const summary = {
  generatedAt: new Date().toISOString(),
  runDir: logDir,
  runName: basename(logDir),
  samplesObserved: rows.length,
  latestSample: latest?.sample ?? null,
  firstSampleIso: rows[0]?.iso ?? null,
  latestSampleIso: latest?.iso ?? null,
  transitions: {
    delta: transition(rows, "round1vs4KnowledgeDelta"),
    knowledgeCount: transition(rows, "knowledgeCount"),
    activeCount: transition(rows, "activeCount"),
    conflictCount: transition(rows, "conflictCount"),
    resolvedConflictReviews: transition(rows, "resolvedConflictReviews"),
    totalGates: transition(rows, "totalGates"),
    llmEstimatedCostUsd: transition(rows, "llmEstimatedCostUsd"),
  },
  ranges: {
    delta: deltaRange,
    pendingGates: minMax(rows, "pendingGates"),
    stallGuardCount: minMax(rows, "stallGuardCount"),
    appRssMb: minMax(rows, "appRssMb"),
  },
  humanGateBacklog: {
    earlyWindowSamples: earlyWindow.map((row) => row.sample),
    lateWindowSamples: lateWindow.map((row) => row.sample),
    earlyPendingAvg,
    latePendingAvg,
    pendingGateDropRatio,
  },
  stallGuard: {
    rawLatestCount: Number.isFinite(stallGuardCount) ? stallGuardCount : null,
    rawRate: stallGuardRate,
    rawUnder5Percent: stallGuardRate != null ? stallGuardRate < 0.05 : null,
    trueTriggerUniqueCount: trueStallGuardCount,
    trueTriggerRate: trueStallGuardRate,
    trueUnder5Percent: trueStallGuardRate != null ? trueStallGuardRate < 0.05 : null,
    trueTriggerGateIds: trueStallGuardGateIds,
    totalCycles: Number.isFinite(totalCycles) ? totalCycles : null,
  },
  eventCounts: {
    schedulerActionCounts,
    safetyModeEvents: (schedulerActionCounts.safety_mode ?? 0) + (schedulerActionCounts.safety_throttled ?? 0),
    safetyHardBlockEvents: schedulerActionCounts.safety_mode ?? 0,
    safetyThrottledEvents: schedulerActionCounts.safety_throttled ?? 0,
    waitingBlockingGateEvents: schedulerActionCounts.waiting_blocking_gate ?? 0,
    sampleFailedEvents: events.filter((event) => event.eventType === "sample_failed").length,
    deltaStaticWhileKnowledgeGrowsEvents: events.filter((event) => event.eventType === "delta_static_while_knowledge_grows").length,
    stallGuardTrueTriggerEvents: explicitTrueStallGuardEvents.length,
    stallGuardApprovedRiskGateEvents: approvedStallGuardEvents.length,
    stallGuardMonitorFalsePositiveEvents: events.filter((event) => event.eventType === "stall_guard_monitor_false_positive").length,
    telegramLiveGateResolvedEvents: events.filter((event) => event.eventType === "telegram_live_gate_resolved").length,
  },
  currentStatus: {
    pendingGates: latest?.pendingGates ?? null,
    openConflictReviews: latest?.openConflictReviews ?? null,
    lastSchedulerAction: latest?.lastSchedulerAction ?? null,
    lastDecisionVia: latest?.lastDecisionVia ?? null,
  },
  notes: [
    "This is an interim summary over the samples observed so far, not a final 36h verdict.",
    "Human Gate drop ratio is meaningful only after a late-run window exists; early all-zero backlogs produce null.",
    "currentStatus reflects the latest CSV sample point; post-sample Telegram approvals can make the live API queue lower than this value.",
    "stallGuard.rawLatestCount is the CSV monitor count; trueTriggerUniqueCount is based on explicit stall_guard_true_trigger events plus approved evolution_stalled risk gates keyed by risk gate id.",
  ],
};

const output = args.output ? resolve(args.output) : join(logDir, "timeseries_summary.json");
writeFileSync(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
