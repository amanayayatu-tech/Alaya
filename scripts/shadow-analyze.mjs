#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeHealthSignalQuality } from "./lib/health-signal-quality.mjs";

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
    /contradiction|conflict|矛盾|冲突|ppg|ecg|hybrid/i.test(JSON.stringify(eventItem))
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

async function main() {
  const logDir = resolve(process.argv[2] || "");
  assert.ok(logDir && existsSync(logDir), `log directory not found: ${logDir}`);
  try {
    globalThis.__betterSqlite3 = (await import("better-sqlite3")).default;
  } catch {
    globalThis.__betterSqlite3 = null;
  }

  const summary = readJson(join(logDir, "summary.json"), {});
  const events = readJsonl(join(logDir, "events.jsonl"));
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
  const llmCallRows = allDb(dbPath, `
    SELECT agent, latency_ms, input_token_count, output_token_count, token_count, estimated_cost
    FROM llm_calls
    ORDER BY id ASC
  `);
  const qualitySummary = summarizeHealthSignalQuality({
    knowledgeItems: knowledgeRows,
    events,
    samples,
    llmCalls: llmCallRows,
  });
  const qualityPath = join(logDir, "quality_summary.json");
  writeFileSync(qualityPath, JSON.stringify({
    ...qualitySummary,
    sources: {
      knowledge: knowledgeRows.length > 0 ? "health-signal.db:knowledge_items" : "unavailable",
      llmCalls: llmCallRows.length > 0 ? "health-signal.db:llm_calls" : "unavailable",
      resolutionEvents: "events.jsonl:knowledge_review_resolved",
      apiRequestLatency: "events.jsonl:api_request_timing",
      rss: "monitor_log.csv:appRssMb",
    },
    notes: [
      "decisionTsr is a single-scenario pass@1 oracle-state check, not an independent reasoning benchmark.",
      "pass^k multi-seed reliability is intentionally deferred to v2.",
      "API latency is runner/harness-observed polling and control request latency under validation load, not an isolated production retrieval SLO.",
      "Resolution accuracy is blocking only when scoreable coverage meets the configured threshold.",
    ],
  }, null, 2));
  const meaningBudgetRows = snapshotJson.map((row) => row.opsMetrics?.meaningGateBudget).filter(Boolean);
  const overBudgetRows = meaningBudgetRows.filter((row) => row.overBudget);

  const aClass = [
    ["deltaReached8", pass(Boolean(finalCriteria.deltaReached8), `last=${observed.lastDelta ?? "n/a"}`)],
    ["activeNeverZero", pass(Boolean(finalCriteria.activeNeverZero), `min=${observed.minActiveKnowledgeCount ?? "n/a"}`)],
    ["tokenSourceProviderAtLeast95pct", pass(providerRatio >= 0.95, `providerRatio=${providerRatio}`)],
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
  const latency = qualitySummary.latencyAndEfficiency;
  const rssSlope = qualitySummary.rssSlopeMbPerHour;
  const qualityRows = [
    ["decisionTsr", decision.status === "insufficient_evidence"
      ? na("no active/strong DB knowledge available; measures preset oracle card state, pass@1 only")
      : pass(decision.passed, `expected=${decision.expectedDecision} hybrid=${decision.hybridLayeredCount} disallowed=${decision.disallowedFinalCount} eligible=${decision.eligibleKnowledgeCount}; pass@1 single scenario`)],
    ["resolutionAccuracy", resolution.status === "insufficient_evidence"
      ? na(`scored=${resolution.scored} unscored=${resolution.unscored} unscoredTop=${topCounts(resolution.unscoredPairTypeCounts)}`)
      : resolution.status === "low_coverage"
        ? lowCoverage(`accuracy=${resolution.accuracy} scored=${resolution.scored} unscored=${resolution.unscored} coverage=${resolution.scoreableCoverage} threshold=${resolution.scoreableCoverageThreshold} unscoredTop=${topCounts(resolution.unscoredPairTypeCounts)}`)
        : pass(resolution.passed, `accuracy=${resolution.accuracy} scored=${resolution.scored} unscored=${resolution.unscored} coverage=${resolution.scoreableCoverage} unscoredTop=${topCounts(resolution.unscoredPairTypeCounts)}`)],
    ["latencyAndEfficiency", info(`api_harness_p95=${latency.apiRequest.p95Ms ?? "n/a"}ms llm_p95=${latency.llmOverall.p95Ms ?? "n/a"}ms costPerCycle=${latency.ratios.costPerClosedCycleUsd ?? "N/A"} tokensPerConflict=${latency.ratios.tokensPerResolvedConflict ?? "N/A"}; harness polling/control, not production SLO`)],
    ["rssSlopeUnder50MbPerHour", rssSlope == null
      ? na("need at least two RSS samples")
      : pass(qualitySummary.rssSlopeUnder50MbPerHour, `slope=${rssSlope} MB/h threshold<${qualitySummary.rssSlopeThresholdMbPerHour}`)],
  ];

  const allRows = [...aClass, ...shadowChecks, ...qualityRows];
  const failing = allRows.filter(([, result]) => result.status === "FAIL");
  const findingsPath = join(logDir, "SHADOW_FINDINGS.md");
  const report = [
    "# SHADOW_FINDINGS",
    "",
    `Log dir: ${logDir}`,
    `Generated at: ${new Date().toISOString()}`,
    `Assessment source: ${assessmentSource}`,
    `Duration source: ${durationSource}`,
    `Summary: ${failing.length === 0 ? "PASS" : "FAIL"} (${failing.length} failing checks)`,
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
    "Notes: `decisionTsr` is a deterministic pass@1 check for the preset Health Signal oracle state, not proof of independent reasoning. `resolutionAccuracy` is blocking only when scoreable coverage is at or above its threshold; low coverage is reported separately to avoid a misleading 100% on a tiny scored subset. API latency is harness polling/control latency under runner load, not production retrieval SLO.",
    "",
    `Resolution pair distribution: scoredTop=${topCounts(resolution.scoredPairTypeCounts, 8)}; unscoredTop=${topCounts(resolution.unscoredPairTypeCounts, 8)}; unscoredReasons=${topCounts(resolution.unscoredReasonCounts, 8)}.`,
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
  process.exit(failing.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
