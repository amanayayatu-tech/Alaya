#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeEquityThesisQuality } from "./lib/health-signal-quality.mjs";
import {
  classifyCompressedAnalyzerChecks,
  computeAnalyzerSourceDigest,
  summarizeLearningGovernanceAudit,
  summarizeModelCallInventory,
} from "./lib/learning-precheck-gates.mjs";

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
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

function analyzerSourceDigest(logDir) {
  const parts = [
    ["summary.json", existsSync(join(logDir, "summary.json")) ? readFileSync(join(logDir, "summary.json"), "utf8") : "<missing>"],
    ["events.jsonl", existsSync(join(logDir, "events.jsonl")) ? readFileSync(join(logDir, "events.jsonl"), "utf8") : "<missing>"],
    ["watchdog.jsonl", existsSync(join(logDir, "watchdog.jsonl")) ? readFileSync(join(logDir, "watchdog.jsonl"), "utf8") : "<missing>"],
    ["monitor_log.csv", existsSync(join(logDir, "monitor_log.csv")) ? readFileSync(join(logDir, "monitor_log.csv"), "utf8") : "<missing>"],
    ["health-signal.db", existsSync(join(logDir, "health-signal.db")) ? readFileSync(join(logDir, "health-signal.db")) : "<missing>"],
  ];
  const metricsDir = join(logDir, "metrics");
  if (existsSync(metricsDir)) {
    for (const name of readdirSync(metricsDir).filter((entry) => /^snapshot_\d+\.(?:txt|json)$/.test(entry)).sort()) {
      parts.push([`metrics/${name}`, readFileSync(join(metricsDir, name))]);
    }
  }
  return computeAnalyzerSourceDigest(parts);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) out[arg.slice(2)] = "true";
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function boolArg(args, name, fallback = false) {
  const raw = args[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function readCsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const header = lines.shift()?.split(",") ?? [];
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
  });
}

function metricValue(text, name, labels = null) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith(name)) continue;
    if (labels) {
      const rendered = Object.entries(labels).map(([key, value]) => `${key}="${value}"`).join(",");
      if (!line.startsWith(`${name}{${rendered}}`)) continue;
    }
    const raw = line.trim().split(/\s+/).at(-1);
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function pass(ok, observed = "") {
  return { status: ok ? "PASS" : "FAIL", observed };
}

function na(observed = "") {
  return { status: "N/A", observed };
}

function info(observed = "") {
  return { status: "INFO", observed };
}

function lowCoverage(observed = "") {
  return { status: "LOW_COVERAGE", observed };
}

function countDb(dbPath, sql) {
  if (!dbPath || !existsSync(dbPath)) return null;
  const Database = globalThis.__betterSqlite3;
  if (!Database) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(sql).get();
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

function allDb(dbPath, sql) {
  if (!dbPath || !existsSync(dbPath)) return [];
  const Database = globalThis.__betterSqlite3;
  if (!Database) return [];
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    return db.prepare(sql).all();
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function avg(values) {
  if (!values.length) return 0;
  return +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3);
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== "")));
}

function normalizeLlmCallRow(row) {
  return {
    id: row?.id ?? null,
    cycleId: row?.cycleId ?? row?.cycle_id ?? null,
    agent: row?.agent ?? null,
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    routeReason: row?.routeReason ?? row?.route_reason ?? null,
    promptVersion: row?.promptVersion ?? row?.prompt_version ?? null,
    schemaValid: row?.schemaValid ?? row?.schema_valid ?? null,
    llmFailureType: row?.llmFailureType ?? row?.llm_failure_type ?? null,
    retryCount: row?.retryCount ?? row?.retry_count ?? null,
    latencyMs: row?.latencyMs ?? row?.latency_ms ?? null,
    inputTokenCount: row?.inputTokenCount ?? row?.input_token_count ?? null,
    outputTokenCount: row?.outputTokenCount ?? row?.output_token_count ?? null,
    tokenCount: row?.tokenCount ?? row?.token_count ?? null,
    tokenSource: row?.tokenSource ?? row?.token_source ?? null,
    estimatedCost: row?.estimatedCost ?? row?.estimated_cost ?? null,
    ts: row?.ts ?? null,
  };
}

// Mirrors cumulativeConflictEvidence() in scripts/health-signal-36h-validation.mjs.
function cumulativeConflictEvidence(samples, events) {
  const resolvedReviewIds = unique(events
    .filter((eventItem) => eventItem.eventType === "knowledge_review_resolved")
    .map((eventItem) => eventItem.reviewId));
  const maxOpenReviews = Math.max(0, ...samples.map((s) => Number(s.openConflictReviews) || 0));
  const maxResolvedReviews = Math.max(0, ...samples.map((s) => Number(s.resolvedConflictReviews) || 0), resolvedReviewIds.length);
  const maxScanReviewRequired = Math.max(0, ...events
    .filter((eventItem) => eventItem.eventType === "conflicts_scanned")
    .map((eventItem) => Number(eventItem.reviewRequiredCount) || 0));
  const maxScanConflictCandidates = Math.max(0, ...events
    .filter((eventItem) => eventItem.eventType === "conflicts_scanned")
    .map((eventItem) => Number(eventItem.conflictCandidateCount) || 0));
  return {
    maxOpenReviews,
    maxResolvedReviews,
    resolvedUniqueReviewCount: resolvedReviewIds.length,
    maxScanReviewRequired,
    maxScanConflictCandidates,
    cumulativeConflictCount: Math.max(
      maxResolvedReviews + maxOpenReviews,
      resolvedReviewIds.length + maxOpenReviews,
      maxScanReviewRequired,
      maxScanConflictCandidates,
    ),
  };
}

// Mirrors finalAssessment() in scripts/health-signal-36h-validation.mjs so that an
// interrupted run (no summary.json) can still be judged from raw logs instead of
// degrading every criterion to n/a.
function reconstructAssessment(samples, events) {
  const first = samples[0] ?? {};
  const last = samples[samples.length - 1] ?? {};
  const maxSnapshotConflict = Math.max(0, ...samples.map((s) => Number(s.conflictCount) || 0));
  const conflictEvidence = cumulativeConflictEvidence(samples, events);
  const maxConflict = Math.max(maxSnapshotConflict, conflictEvidence.cumulativeConflictCount);
  const maxResolved = conflictEvidence.maxResolvedReviews;
  const maxStall = Math.max(0, ...samples.map((s) => Number(s.stallGuardCount) || 0));
  const totalClosed = Number(last.cyclesClosed) || 0;
  const earlyGateAvg = avg(samples.slice(0, Math.max(1, Math.floor(samples.length / 4))).map((s) => Number(s.pendingGates) || 0));
  const lateGateAvg = avg(samples.slice(Math.floor(samples.length / 2)).map((s) => Number(s.pendingGates) || 0));
  const humanGateDropEligible = earlyGateAvg >= 1;
  const humanGateDrop = humanGateDropEligible ? +((earlyGateAvg - lateGateAvg) / earlyGateAvg).toFixed(3) : null;
  const minActive = Math.min(...samples.map((s) => Number(s.activeCount)).filter(Number.isFinite));
  const tokenEvents = events
    .filter((eventItem) => eventItem.eventType === "metrics_sample" && eventItem.llmTokenSourceStats)
    .map((eventItem) => eventItem.llmTokenSourceStats);
  const lastTokenSource = tokenEvents[tokenEvents.length - 1] ?? null;
  const semanticBypassCount = events.filter((eventItem) => (
    eventItem.eventType === "gate_approved" &&
    eventItem.via === "auto_approved_repeated_meaning" &&
    /contradiction|conflict|矛盾|冲突|long|short|tiered|多头|空头|看多|看空|分层/i.test(JSON.stringify(eventItem))
  )).length;
  return {
    criteria: {
      deltaReached8: Number(last.round1vs4KnowledgeDelta) >= 8,
      activeNeverZero: Number.isFinite(minActive) ? minActive >= 1 : false,
      tokenSourceProviderAtLeast95pct: (lastTokenSource?.providerRatio ?? 0) >= 0.95,
      semanticContradictionBypassZero: semanticBypassCount === 0,
      conflictAtLeast5: maxConflict >= 5,
      conflictResolvedAtLeast3: maxResolved >= 3,
      humanGateDropAtLeast30pct: humanGateDropEligible ? humanGateDrop >= 0.3 : null,
      stallGuardUnder5pct: totalClosed > 0 ? maxStall / totalClosed < 0.05 : false,
    },
    observed: {
      lastDelta: last.round1vs4KnowledgeDelta ?? null,
      minActiveKnowledgeCount: Number.isFinite(minActive) ? minActive : null,
      lastLlmTokenSourceStats: lastTokenSource,
      semanticContradictionBypassCount: semanticBypassCount,
      maxConflictCount: maxConflict,
      maxResolvedConflictReviews: maxResolved,
      earlyPendingGateAverage: earlyGateAvg,
      latePendingGateAverage: lateGateAvg,
      humanGateDropEligible,
      humanGateDropEligibilityThreshold: "earlyPendingGateAverage >= 1",
      humanGatePendingDropRatio: humanGateDrop,
      maxStallGuardCount: maxStall,
      cyclesClosed: totalClosed,
      firstSample: first.sample ?? null,
      lastSample: last.sample ?? null,
    },
  };
}

function providerRatioFromLabel(label) {
  if (!label) return null;
  if (label === "provider") return 1;
  const match = /^mixed_provider_(\d+)pct$/.exec(String(label));
  if (match) return Number(match[1]) / 100;
  return null;
}

function collectTimestamps(samples, events, watchdog) {
  const stamps = [];
  for (const row of samples) {
    const value = Date.parse(row.iso ?? "");
    if (Number.isFinite(value)) stamps.push(value);
  }
  for (const row of events) {
    const value = Date.parse(row.ts ?? "");
    if (Number.isFinite(value)) stamps.push(value);
  }
  for (const row of watchdog) {
    const value = Date.parse(row.checkedAt ?? "");
    if (Number.isFinite(value)) stamps.push(value);
  }
  return stamps;
}

function renderTable(rows) {
  return [
    "| 判据 | 结果 | 观测 |",
    "| --- | --- | --- |",
    ...rows.map(([name, result]) => `| ${name} | ${result.status} | ${String(result.observed ?? "").replace(/\|/g, "\\|")} |`),
  ].join("\n");
}

function topCounts(counts, limit = 5) {
  const entries = Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
  return entries.length ? entries.map(([key, value]) => `${key}:${value}`).join(", ") : "none";
}

function formatExcludedAsNonConflict(summary) {
  const count = summary?.count ?? 0;
  if (count === 0) return "count=0";
  const examples = Array.isArray(summary?.exampleIds) && summary.exampleIds.length > 0
    ? summary.exampleIds.slice(0, 8).join(",")
    : "none";
  return `count=${count} reasons=${topCounts(summary?.reasonCounts, 8)} examples=${examples}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const analysisMode = args["analysis-mode"] ?? "formal";
  assert.ok(["formal", "compressed-precheck"].includes(analysisMode), `unsupported analysis mode: ${analysisMode}`);
  const compressedPrecheckMode = analysisMode === "compressed-precheck";
  const logDir = resolve(args._[0] || args["log-dir"] || "");
  assert.ok(logDir && existsSync(logDir), `log directory not found: ${logDir}`);
  const invocationNonce = String(args["invocation-nonce"] ?? "").trim();
  const expectedReplicateId = String(args["expected-replicate-id"] ?? "").trim();
  if (compressedPrecheckMode) {
    assert.ok(invocationNonce, "compressed-precheck requires --invocation-nonce");
    assert.ok(expectedReplicateId, "compressed-precheck requires --expected-replicate-id");
  }
  try {
    globalThis.__betterSqlite3 = (await import("better-sqlite3")).default;
  } catch {
    globalThis.__betterSqlite3 = null;
  }

  const summary = readJson(join(logDir, "summary.json"), {});
  const events = readJsonl(join(logDir, "events.jsonl"));
  const oracleAnswersPath = args["oracle-answers"] ? resolve(args["oracle-answers"]) : join(logDir, "oracle_answers.json");
  const oracleAnswers = existsSync(oracleAnswersPath) ? readJson(oracleAnswersPath, null) : null;
  const watchdog = readJsonl(join(logDir, "watchdog.jsonl"));
  const samples = readCsv(join(logDir, "monitor_log.csv"));
  const metricsDir = join(logDir, "metrics");
  const snapshotFiles = existsSync(metricsDir)
    ? readdirSync(metricsDir).filter((name) => /^snapshot_\d+\.txt$/.test(name)).sort()
    : [];
  const snapshotTexts = snapshotFiles.map((name) => readFileSync(join(metricsDir, name), "utf8"));
  const snapshotJsonFiles = existsSync(metricsDir)
    ? readdirSync(metricsDir).filter((name) => /^snapshot_\d+\.json$/.test(name)).sort()
    : [];
  const snapshotJson = snapshotJsonFiles.map((name) => readJson(join(metricsDir, name), {}));
  const opsWarningRows = readJsonl(join(logDir, "ops_trend_warnings.log"));

  // Duration: prefer summary.json; for interrupted runs reconstruct from raw log timestamps.
  const summaryDurationMs = Number(summary.validationDurationMs ?? summary.processDurationMs ?? 0);
  const stamps = collectTimestamps(samples, events, watchdog);
  const reconstructedDurationMs = stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : 0;
  const durationMs = summaryDurationMs > 0 ? summaryDurationMs : reconstructedDurationMs;
  const durationSource = summaryDurationMs > 0
    ? "summary.json"
    : (reconstructedDurationMs > 0 ? "reconstructed from raw log timestamps" : "unavailable");

  // DB path: prefer summary.json; fall back to the db file inside the log directory.
  const localDbPath = join(logDir, "health-signal.db");
  const dbPath = summary.dbPath && existsSync(summary.dbPath)
    ? summary.dbPath
    : (existsSync(localDbPath) ? localDbPath : null);

  // Assessment: prefer summary.json; for interrupted runs reconstruct from raw logs
  // with the exact finalAssessment() semantics from the runner.
  const summaryAssessment = summary.assessment ?? null;
  const reconstructedAssessment = !summaryAssessment && samples.length > 0
    ? reconstructAssessment(samples, events)
    : null;
  const assessment = summaryAssessment ?? reconstructedAssessment ?? { criteria: {}, observed: {} };
  const assessmentSource = summaryAssessment
    ? "summary.json"
    : (reconstructedAssessment ? "reconstructed from monitor_log.csv + events.jsonl (summary.json missing)" : "unavailable");

  const finalCriteria = assessment.criteria ?? {};
  const observed = assessment.observed ?? {};
  const earlyBacklog = Number(observed.earlyPendingGateAverage ?? 0);
  let providerRatio = Number(observed.lastLlmTokenSourceStats?.providerRatio ?? NaN);
  if (!Number.isFinite(providerRatio)) {
    providerRatio = providerRatioFromLabel(samples.at(-1)?.llmTokenSource) ?? 0;
  }
  const runnerCrashed = events.filter((event) => event.eventType === "runner_crashed");
  const sampleFailed = events.filter((event) => event.eventType === "sample_failed");
  const badWatchdog = watchdog.filter((row) => row.ok === false);
  const errorEvents = events.filter((event) => /error|failed|crashed/i.test(String(event.eventType ?? "")));
  const uniqueErrors = events.filter((event) => /UNIQUE constraint failed/i.test(JSON.stringify(event)));
  const draftingRows = samples.filter((row) => /drafting/i.test(JSON.stringify(row)));
  const grayValues = snapshotTexts.map((text) => metricValue(text, "alaya_gray_active_count")).filter((value) => value != null);
  const counterNames = [
    "alaya_scheduler_cycles_total",
    "alaya_actions_total",
    "alaya_llm_requests_total",
    "alaya_knowledge_injections_total",
    "alaya_errors_total",
    "alaya_gold_regression_runs_total",
  ];
  const counterRegressions = [];
  for (const name of counterNames) {
    const values = snapshotTexts.map((text) => metricValue(text, name)).filter((value) => value != null);
    for (let i = 1; i < values.length; i += 1) {
      if (values[i] < values[i - 1]) counterRegressions.push(`${name}:${i - 1}->${i}`);
    }
  }
  const grayIncreases = [];
  for (let i = 1; i < grayValues.length; i += 1) {
    if (grayValues[i] > grayValues[i - 1]) grayIncreases.push(`${i}->${i + 1} ${grayValues[i - 1]} to ${grayValues[i]}`);
  }
  const warningText = opsWarningRows.map((row) => (row.warnings ?? []).join("\n")).join("\n");
  const finalSnapshot = snapshotTexts.at(-1) ?? "";
  const finalDbGray = countDb(dbPath, `
    SELECT COUNT(*) AS count FROM knowledge_items
    WHERE status='active'
      AND confidence_score > 0.3
      AND confidence_score < 0.7
      AND (superseded_by IS NULL OR superseded_by='')
  `);
  const finalSnapshotGray = metricValue(finalSnapshot, "alaya_gray_active_count");
  const finalDbErrors = countDb(dbPath, "SELECT COUNT(*) AS count FROM event_log WHERE op='error' OR op='sync_error'");
  const finalSnapshotErrors = metricValue(finalSnapshot, "alaya_errors_total");
  const knowledgeRows = allDb(dbPath, `
    SELECT id, title, content, notes, source_ref, semantic_key, tags, status, superseded_by, confidence_score
    FROM knowledge_items
    ORDER BY rowid ASC
  `);
  const llmCallRows = allDb(dbPath, "SELECT * FROM llm_calls ORDER BY id ASC").map(normalizeLlmCallRow);
  const auditRows = allDb(dbPath, `
    SELECT id, actor, table_name AS tableName, op, before, after, cycle_idx AS cycleIdx, ts
    FROM event_log
    ORDER BY id ASC
  `);
  const qualitySummary = summarizeEquityThesisQuality({
    knowledgeItems: knowledgeRows,
    events,
    samples,
    llmCalls: llmCallRows,
    faithfulnessJudge: args["faithfulness-judge"] || "lexical",
    dedupeMode: args["dedupe-mode"] || "exact",
    enforceLatencySlo: boolArg(args, "enforce-latency-slo", false),
    learningOracleAnswers: oracleAnswers,
    learningBlockSize: Number(args["learning-block-size"] ?? 10),
  });
  const qualityPath = join(logDir, "quality_summary.json");
  const experimentArm = process.env.ALAYA_EXPERIMENT_ARM ?? events.find((event) => event?.eventType === "learning_case_resolved")?.arm ?? "unknown";
  const learningScenario = summary?.scenario?.name === "learning-cases" || events.some((event) => event?.eventType === "learning_case_resolved");
  const governanceAudit = learningScenario
    ? summarizeLearningGovernanceAudit({ auditRows, knowledgeRows, events, arm: experimentArm })
    : { status: "NOT_APPLICABLE", reason: "not_learning_cases_scenario" };
  const modelCallInventory = compressedPrecheckMode && learningScenario
    ? summarizeModelCallInventory({
      modelCalls: llmCallRows,
      expectedProvider: summary?.llmProvider,
      expectedModel: summary?.model,
      declaredRequiredAgents: summary?.scenario?.requiredModelCallingAgents,
    })
    : null;
  writeFileSync(qualityPath, JSON.stringify({
    ...qualitySummary,
    governanceAudit,
    ...(modelCallInventory ? { modelCallInventory } : {}),
    sources: {
      knowledge: knowledgeRows.length > 0 ? "health-signal.db:knowledge_items" : "unavailable",
      llmCalls: llmCallRows.length > 0 ? "health-signal.db:llm_calls" : "unavailable",
      resolutionEvents: "events.jsonl:knowledge_review_resolved",
      learningEvents: "events.jsonl:learning decision rows",
      oracleAnswers: oracleAnswers ? oracleAnswersPath : "unavailable",
      knowledgeInjectionTraces: "events.jsonl:knowledge_injection trace events",
      apiRequestLatency: "events.jsonl:api_request_timing",
      rss: "monitor_log.csv:appRssMb",
    },
    notes: [
      ...(Array.isArray(qualitySummary.notes) ? qualitySummary.notes : []),
      "decisionTsr is a single-scenario pass@1 oracle-state check, not an independent reasoning benchmark.",
      "pass^k multi-seed reliability is intentionally deferred to v2.",
      "API latency is runner/harness-observed polling and control request latency under validation load, not an isolated production retrieval SLO.",
      "Resolution accuracy is blocking only when scoreable coverage meets the configured threshold.",
      "Learning-loop metrics are local analyzer metrics; LOW_COVERAGE suppresses attractive point estimates when sample support is too small.",
    ],
  }, null, 2));
  const meaningBudgetRows = snapshotJson.map((row) => row.opsMetrics?.meaningGateBudget).filter(Boolean);
  const overBudgetRows = meaningBudgetRows.filter((row) => row.overBudget);

  const aClass = [
    ["deltaReached8", pass(Boolean(finalCriteria.deltaReached8), `last=${observed.lastDelta ?? "n/a"}`)],
    ["activeNeverZero", pass(Boolean(finalCriteria.activeNeverZero), `min=${observed.minActiveKnowledgeCount ?? "n/a"}`)],
    ["tokenSourceProviderAtLeast95pct", pass(
      compressedPrecheckMode && learningScenario
        ? modelCallInventory?.status === "PASS" && modelCallInventory.providerRouteRatio === 1 && modelCallInventory.tokenSourceProviderRatio >= 0.95
        : providerRatio >= 0.95,
      compressedPrecheckMode && learningScenario
        ? `providerRouteRatio=${modelCallInventory?.providerRouteRatio ?? "n/a"} tokenSourceProviderRatio=${modelCallInventory?.tokenSourceProviderRatio ?? "n/a"} inventory=${modelCallInventory?.status ?? "MISSING"}`
        : `providerRatio=${providerRatio}`,
    )],
    ["semanticContradictionBypassZero", pass(Boolean(finalCriteria.semanticContradictionBypassZero), `count=${observed.semanticContradictionBypassCount ?? "n/a"}`)],
    ["conflictAtLeast5", pass(Boolean(finalCriteria.conflictAtLeast5), `max=${observed.maxConflictCount ?? "n/a"}`)],
    ["conflictResolvedAtLeast3", pass(Boolean(finalCriteria.conflictResolvedAtLeast3), `resolved=${observed.maxResolvedConflictReviews ?? "n/a"}`)],
    ["humanGateDropAtLeast30pct", earlyBacklog < 1 ? na("early pending average <1; backlog too small for drop-rate judgment") : pass(Boolean(finalCriteria.humanGateDropAtLeast30pct), `drop=${observed.humanGatePendingDropRatio ?? "n/a"}`)],
    ["stallGuardUnder5pct", pass(Boolean(finalCriteria.stallGuardUnder5pct), `max=${observed.maxStallGuardCount ?? "n/a"} cycles=${observed.cyclesClosed ?? "n/a"}`)],
    ["sampleFailedZero", pass(sampleFailed.length === 0, `sample_failed=${sampleFailed.length}`)],
  ];

  const shadowChecks = [
    ["durationAtLeast24h", pass(durationMs >= 24 * 3_600_000, `${(durationMs / 3_600_000).toFixed(2)}h (${durationSource})`)],
    ["metricsSnapshotsAtLeast48", pass(snapshotFiles.length >= 48, `${snapshotFiles.length}`)],
    ["uniqueConstraintErrorsZero", pass(uniqueErrors.length === 0, `${uniqueErrors.length}`)],
    ["closedDraftingRowsZero", pass(draftingRows.length === 0, `${draftingRows.length}`)],
    ["runnerCrashedZero", pass(runnerCrashed.length === 0, `${runnerCrashed.length}`)],
    ["errorLevelEventsZero", pass(errorEvents.length === 0, `${errorEvents.length}`)],
    ["watchdogAllGreen", pass(badWatchdog.length === 0 && watchdog.length > 0, `bad=${badWatchdog.length} total=${watchdog.length}`)],
    ["grayTrendExplained", pass(grayIncreases.length === 0 || /灰区存量趋势告警/.test(warningText), grayIncreases.length ? grayIncreases.join("; ") : "monotonic/non-increasing")],
    ["countersMonotonic", pass(counterRegressions.length === 0, counterRegressions.join("; ") || "ok")],
    ["snapshotDbGrayMatches", finalDbGray == null || finalSnapshotGray == null ? na("DB or final snapshot unavailable") : pass(finalDbGray === finalSnapshotGray, `db=${finalDbGray} snapshot=${finalSnapshotGray}`)],
    ["snapshotDbErrorsMatchesOrExceeds", finalDbErrors == null || finalSnapshotErrors == null ? na("DB or final snapshot unavailable") : pass(finalSnapshotErrors >= finalDbErrors, `db=${finalDbErrors} snapshot=${finalSnapshotErrors}`)],
    ["meaningGateBudgetWithinWeeklyLimit", pass(overBudgetRows.length === 0, `overBudgetSnapshots=${overBudgetRows.length}`)],
    ["phase1GrayEventsPresent", pass(grayValues.length > 0, `graySnapshots=${grayValues.length}`)],
    ["phase2SensorCountersPresent", pass(snapshotTexts.some((text) => text.includes("alaya_sensor_errors_total")), "sensor counter exported")],
    ["phase3ProposalCountersPresent", pass(snapshotTexts.some((text) => text.includes("alaya_distiller_proposals_total")), "proposal counter exported")],
  ];

  const decision = qualitySummary.decisionTsr;
  const resolution = qualitySummary.resolutionAccuracy;
  const calibration = qualitySummary.confidenceCalibration;
  const faithfulness = qualitySummary.faithfulness;
  const learningCurve = qualitySummary.learningCurve;
  const cumulativeRegret = qualitySummary.cumulativeRegret;
  const knowledgeROI = qualitySummary.knowledgeROI;
  const learningGovernanceAudit = governanceAudit;
  const heldOutAccuracy = qualitySummary.heldOutAccuracy;
  const forgettingRate = qualitySummary.forgettingRate;
  const latency = qualitySummary.latencyAndEfficiency;
  const rssSlope = qualitySummary.rssSlopeMbPerHour;
  const qualityRows = [
    ["decisionTsr", decision.status === "insufficient_evidence"
      ? na("no active/strong DB knowledge available; measures preset oracle card state, pass@1 only")
      : pass(decision.passed, `expected=${decision.expectedDecision} tiered=${decision.tieredThesisCount} disallowed=${decision.disallowedFinalCount} eligible=${decision.eligibleKnowledgeCount}; pass@1 single scenario`)],
    ["resolutionAccuracy", resolution.status === "insufficient_evidence"
      ? na(`scored=${resolution.scored} unscored=${resolution.unscored} unscoredTop=${topCounts(resolution.unscoredPairTypeCounts)}`)
      : resolution.status === "low_coverage"
        ? lowCoverage(`accuracy=${resolution.accuracy} scored=${resolution.scored} unscored=${resolution.unscored} coverage=${resolution.scoreableCoverage} threshold=${resolution.scoreableCoverageThreshold} unscoredTop=${topCounts(resolution.unscoredPairTypeCounts)}`)
        : pass(resolution.passed, `accuracy=${resolution.accuracy} scored=${resolution.scored} unscored=${resolution.unscored} coverage=${resolution.scoreableCoverage} unscoredTop=${topCounts(resolution.unscoredPairTypeCounts)}`)],
    ["confidenceCalibration", calibration.status === "insufficient_evidence"
      ? na(`ece=${calibration.ece ?? "n/a"} scored=${calibration.scored} unscored=${calibration.unscored} eligible=${calibration.eligible ?? "n/a"} denominator=${calibration.denominator ?? calibration.scoreableDenominator ?? "n/a"} excluded=${calibration.excludedAsNonConflict?.count ?? 0}`)
      : calibration.status === "low_coverage"
        ? lowCoverage(`ece=${calibration.ece ?? "n/a"} scored=${calibration.scored} unscored=${calibration.unscored} eligible=${calibration.eligible ?? "n/a"} denominator=${calibration.denominator ?? calibration.scoreableDenominator ?? "n/a"} minEligible=${calibration.minEligible ?? "n/a"} coverage=${calibration.scoreableCoverage} unscoredReasons=${topCounts(calibration.unscoredReasonCounts)} excluded=${calibration.excludedAsNonConflict?.count ?? 0}`)
        : pass(calibration.status === "pass" || calibration.status === "warn", `status=${calibration.status} ece=${calibration.ece ?? "n/a"} scored=${calibration.scored} eligible=${calibration.eligible ?? "n/a"} denominator=${calibration.denominator ?? calibration.scoreableDenominator ?? "n/a"} coverage=${calibration.scoreableCoverage} buckets=${calibration.reliabilityTable.length} unscoredReasons=${topCounts(calibration.unscoredReasonCounts)} excluded=${calibration.excludedAsNonConflict?.count ?? 0}`)],
    ["faithfulness", faithfulness.status === "unavailable" || faithfulness.status === "insufficient_evidence"
      ? na(`faithfulness=${faithfulness.faithfulness ?? "n/a"} judge=${faithfulness.judgeMode} scored=${faithfulness.scored} scoreableKnowledge=${faithfulness.scoreableKnowledgeItems ?? "n/a"} eligible=${faithfulness.eligible ?? "n/a"} denominator=${faithfulness.denominator ?? faithfulness.scoreableDenominator ?? "n/a"} excluded=${faithfulness.excludedAsNonConflict?.count ?? 0}`)
      : faithfulness.status === "low_coverage"
        ? lowCoverage(`faithfulness=${faithfulness.faithfulness ?? "n/a"} scored=${faithfulness.scored} scoreableKnowledge=${faithfulness.scoreableKnowledgeItems ?? "n/a"} eligible=${faithfulness.eligible ?? "n/a"} denominator=${faithfulness.denominator ?? faithfulness.scoreableDenominator ?? "n/a"} minEligible=${faithfulness.minEligible ?? "n/a"} coverage=${faithfulness.scoreableCoverage} unsupported=${faithfulness.unsupported} indeterminateReasons=${topCounts(faithfulness.indeterminateReasonCounts ?? faithfulness.indeterminateReasons)} excluded=${faithfulness.excludedAsNonConflict?.count ?? 0}`)
        : pass(faithfulness.status === "pass" || faithfulness.status === "warn", `status=${faithfulness.status} faithfulness=${faithfulness.faithfulness ?? "n/a"} hallucination=${faithfulness.hallucinationRate ?? "n/a"} scored=${faithfulness.scored} scoreableKnowledge=${faithfulness.scoreableKnowledgeItems ?? "n/a"} eligible=${faithfulness.eligible ?? "n/a"} denominator=${faithfulness.denominator ?? faithfulness.scoreableDenominator ?? "n/a"} coverage=${faithfulness.scoreableCoverage} unsupported=${faithfulness.unsupported} indeterminateReasons=${topCounts(faithfulness.indeterminateReasonCounts ?? faithfulness.indeterminateReasons)} excluded=${faithfulness.excludedAsNonConflict?.count ?? 0}`)],
    ["learningCurve", learningCurve.status === "LOW_COVERAGE"
      ? lowCoverage(`scored=${learningCurve.scored} blocks=${learningCurve.blockCount} blockSize=${learningCurve.blockSize} minSamples=${learningCurve.minSamples} minBlocks=${learningCurve.minBlocks}`)
      : info(`blocks=${learningCurve.blockCount} blockSize=${learningCurve.blockSize} accuracyS=${learningCurve.accuracyTrend?.s ?? "n/a"} accuracyP=${learningCurve.accuracyTrend?.pValue ?? "n/a"} accuracyDirection=${learningCurve.accuracyTrend?.direction ?? "n/a"} brierS=${learningCurve.brierTrend?.s ?? "n/a"} brierP=${learningCurve.brierTrend?.pValue ?? "n/a"} brierDirection=${learningCurve.brierTrend?.direction ?? "n/a"}`)],
    ["cumulativeRegret", cumulativeRegret.status === "LOW_COVERAGE"
      ? lowCoverage(`scored=${cumulativeRegret.scored} oracleAnswers=${cumulativeRegret.oracleAnswerCount} minSamples=${cumulativeRegret.minSamples}; oracleAnswersPath=${oracleAnswers ? oracleAnswersPath : "unavailable"}`)
      : info(`scored=${cumulativeRegret.scored} finalCumulativeError=${cumulativeRegret.finalCumulativeError} headSlope=${cumulativeRegret.headSlope} tailSlope=${cumulativeRegret.tailSlope} tailBelowHead=${cumulativeRegret.tailSlopeBelowHeadSlope}`)],
    ["knowledgeROI", knowledgeROI.status === "LOW_COVERAGE"
      ? lowCoverage(`knowledgeCount=${knowledgeROI.knowledgeCount} okCount=${knowledgeROI.okCount} lowCoverage=${knowledgeROI.lowCoverageCount}`)
      : info(`knowledgeCount=${knowledgeROI.knowledgeCount} okCount=${knowledgeROI.okCount} lowCoverage=${knowledgeROI.lowCoverageCount} deltaMean=${knowledgeROI.deltaDistribution?.mean ?? "n/a"} deltaMedian=${knowledgeROI.deltaDistribution?.median ?? "n/a"}`)],
    ["learningGovernanceAudit", learningScenario
      ? pass(learningGovernanceAudit.status === "PASS", `creditEvents=${learningGovernanceAudit.creditAuditEventCount} malformedCredit=${learningGovernanceAudit.malformedCreditAuditCount} missingCredit=${learningGovernanceAudit.missingCreditKeys.length} heldoutCredit=${learningGovernanceAudit.heldoutCreditKeys.length} ranking=${learningGovernanceAudit.rankingAuditComplete} epsilon=${learningGovernanceAudit.epsilonAuditComplete} strongBypass=${learningGovernanceAudit.humanStrongBypassCount} pollutedInjection=${learningGovernanceAudit.pollutedHighRiskInjectionCount}`)
      : na("not learning-cases scenario")],
    ["heldOutAccuracy", heldOutAccuracy.status === "LOW_COVERAGE"
      ? lowCoverage(`heldoutScored=${heldOutAccuracy.heldoutScored} trainScored=${heldOutAccuracy.trainScored} minSamples=${heldOutAccuracy.minSamples}`)
      : info(`heldoutAccuracy=${heldOutAccuracy.heldOutAccuracy} heldoutScored=${heldOutAccuracy.heldoutScored} trainScored=${heldOutAccuracy.trainScored} trainAccuracy=${heldOutAccuracy.trainAccuracy ?? "n/a"}`)],
    ["forgettingRate", forgettingRate.status === "LOW_COVERAGE"
      ? lowCoverage(`firstHalfCorrectRuleCount=${forgettingRate.firstHalfCorrectRuleCount} secondHalfScored=${forgettingRate.secondHalfScored} minSamples=${forgettingRate.minSamples}`)
      : info(`retention=${forgettingRate.retention} forgettingRate=${forgettingRate.forgettingRate} ruleCategories=${forgettingRate.ruleCategories.join(",")}`)],
    ["latencyAndEfficiency", latency.slo?.sloBlocking
      ? pass(false, `api_harness_p95=${latency.apiRequest.p95Ms ?? "n/a"}ms sloStatus=${latency.slo.sloStatus}; ${latency.slo.measurementNote}`)
      : info(`api_harness_p95=${latency.apiRequest.p95Ms ?? "n/a"}ms llm_p95=${latency.llmOverall.p95Ms ?? "n/a"}ms costPerCycle=${latency.ratios.costPerClosedCycleUsd ?? "N/A"} tokensPerConflict=${latency.ratios.tokensPerResolvedConflict ?? "N/A"}; sloStatus=${latency.slo?.sloStatus ?? "n/a"} sloBlocking=${latency.slo?.sloBlocking ?? false}; harness polling/control, not production SLO`)],
    ["rssSlopeUnder50MbPerHour", rssSlope == null
      ? na("need at least two RSS samples")
      : pass(qualitySummary.rssSlopeUnder50MbPerHour, `slope=${rssSlope} MB/h threshold<${qualitySummary.rssSlopeThresholdMbPerHour}`)],
  ];

  const allRows = [...aClass, ...shadowChecks, ...qualityRows];
  const failing = allRows.filter(([, result]) => result.status === "FAIL");
  const compressedClassification = compressedPrecheckMode ? classifyCompressedAnalyzerChecks(allRows, {
    invocationNonce,
    expectedReplicateId,
    actualReplicateId: summary?.scenario?.runId,
    generatedAt: new Date().toISOString(),
    sourceDigest: analyzerSourceDigest(logDir),
  }) : null;
  const blockingFailing = compressedPrecheckMode
    ? allRows.filter(([name]) => compressedClassification.blockingFailureNames.includes(name))
    : failing;
  const compressedClassificationPath = join(logDir, "compressed_precheck_analysis.json");
  if (compressedClassification) {
    writeFileSync(compressedClassificationPath, `${JSON.stringify(compressedClassification, null, 2)}\n`);
  }
  const compressedContractFailure = compressedPrecheckMode && compressedClassification.status !== "PASS" && blockingFailing.length === 0;
  const reportedBlockingCount = blockingFailing.length + (compressedContractFailure ? 1 : 0);
  const findingsPath = join(logDir, "SHADOW_FINDINGS.md");
  const report = [
    "# SHADOW_FINDINGS",
    "",
    `Log dir: ${logDir}`,
    `Generated at: ${new Date().toISOString()}`,
    ...(compressedPrecheckMode ? [
      "Analysis mode: compressed-precheck",
      `Formal failures: ${failing.length}; excluded duration failures: ${compressedClassification.excludedFailureNames.length}; blocking failures: ${reportedBlockingCount}`,
    ] : []),
    `Assessment source: ${assessmentSource}`,
    `Duration source: ${durationSource}`,
    `Summary: ${reportedBlockingCount === 0 ? "PASS" : "FAIL"} (${reportedBlockingCount} failing checks)`,
    "",
    "## A 类 9 判据",
    "",
    renderTable(aClass),
    "",
    "## Shadow Checks",
    "",
    renderTable(shadowChecks),
    "",
    "## Quality Metrics",
    "",
    renderTable(qualityRows),
    "",
    "Notes: `decisionTsr` is a deterministic pass@1 check for the preset equity-thesis oracle state, not proof of independent reasoning. `resolutionAccuracy` is blocking only when scoreable coverage is at or above its threshold; low coverage is reported separately to avoid a misleading 100% on a tiny scored subset. API latency is harness polling/control latency under runner load, not production retrieval SLO.",
    "",
    `Resolution pair distribution: scoredTop=${topCounts(resolution.scoredPairTypeCounts, 8)}; unscoredTop=${topCounts(resolution.unscoredPairTypeCounts, 8)}; unscoredReasons=${topCounts(resolution.unscoredReasonCounts, 8)}.`,
    `Calibration unscored reasons: ${topCounts(calibration.unscoredReasonCounts, 8)}.`,
    `Calibration excluded non-conflict: ${formatExcludedAsNonConflict(calibration.excludedAsNonConflict)}.`,
    `Faithfulness indeterminate reasons: ${topCounts(faithfulness.indeterminateReasonCounts ?? faithfulness.indeterminateReasons, 8)}.`,
    `Faithfulness excluded non-conflict: ${formatExcludedAsNonConflict(faithfulness.excludedAsNonConflict)}.`,
    `Learning metric source rows: ${qualitySummary.learningMetricSourceRows?.length ?? 0}; oracle answers: ${oracleAnswers ? oracleAnswersPath : "unavailable"}.`,
    "",
    `Quality summary: ${qualityPath}`,
    "",
    "## Snapshot / DB Cross-check",
    "",
    "```sql",
    "SELECT COUNT(*) AS count FROM knowledge_items WHERE status='active' AND confidence_score > 0.3 AND confidence_score < 0.7 AND (superseded_by IS NULL OR superseded_by='');",
    "SELECT COUNT(*) AS count FROM event_log WHERE op='error' OR op='sync_error';",
    "```",
    "",
    `grayActiveCount: db=${finalDbGray ?? "n/a"} snapshot=${finalSnapshotGray ?? "n/a"}`,
    `errorsTotal: db=${finalDbErrors ?? "n/a"} snapshot=${finalSnapshotErrors ?? "n/a"}`,
    "",
    "## Trend Warning Excerpts",
    "",
    warningText.trim() || "No opsMetrics trend warnings captured.",
    "",
  ].join("\n");
  writeFileSync(findingsPath, report);
  console.log(findingsPath);
  process.exit(reportedBlockingCount === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
