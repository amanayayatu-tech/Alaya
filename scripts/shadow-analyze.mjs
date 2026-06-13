#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

function renderTable(rows) {
  return [
    "| 判据 | 结果 | 观测 |",
    "| --- | --- | --- |",
    ...rows.map(([name, result]) => `| ${name} | ${result.status} | ${String(result.observed ?? "").replace(/\|/g, "\\|")} |`),
  ].join("\n");
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
  const durationMs = Number(summary.validationDurationMs ?? summary.processDurationMs ?? 0);
  const dbPath = summary.dbPath;

  const finalCriteria = summary.assessment?.criteria ?? {};
  const observed = summary.assessment?.observed ?? {};
  const earlyBacklog = Number(observed.earlyPendingGateAverage ?? 0);
  const providerRatio = Number(observed.lastLlmTokenSourceStats?.providerRatio ?? 0);
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
  const meaningBudgetRows = snapshotJson.map((row) => row.opsMetrics?.meaningGateBudget).filter(Boolean);
  const overBudgetRows = meaningBudgetRows.filter((row) => row.overBudget);

  const aClass = [
    ["deltaReached8", pass(Boolean(finalCriteria.deltaReached8), `last=${observed.lastDelta ?? "n/a"}`)],
    ["activeNeverZero", pass(Boolean(finalCriteria.activeNeverZero), `min=${observed.minActiveKnowledgeCount ?? "n/a"}`)],
    ["tokenSourceProviderAtLeast95pct", pass(providerRatio >= 0.95, `providerRatio=${providerRatio}`)],
    ["semanticContradictionBypassZero", pass(Boolean(finalCriteria.semanticContradictionBypassZero), `count=${observed.semanticContradictionBypassCount ?? "n/a"}`)],
    ["conflictAtLeast5", pass(Boolean(finalCriteria.conflictAtLeast5), `max=${observed.maxConflictCount ?? "n/a"}`)],
    ["conflictResolvedAtLeast3", pass(Boolean(finalCriteria.conflictResolvedAtLeast3), `resolved=${observed.maxResolvedConflictReviews ?? "n/a"}`)],
    ["humanGateDropAtLeast30pct", earlyBacklog === 0 ? na("early backlog=0 per Phase 2/3/4 precedent") : pass(Boolean(finalCriteria.humanGateDropAtLeast30pct), `drop=${observed.humanGatePendingDropRatio ?? "n/a"}`)],
    ["stallGuardUnder5pct", pass(Boolean(finalCriteria.stallGuardUnder5pct), `max=${observed.maxStallGuardCount ?? "n/a"} cycles=${observed.cyclesClosed ?? "n/a"}`)],
    ["sampleFailedZero", pass(sampleFailed.length === 0, `sample_failed=${sampleFailed.length}`)],
  ];

  const shadowChecks = [
    ["durationAtLeast24h", pass(durationMs >= 24 * 3_600_000, `${(durationMs / 3_600_000).toFixed(2)}h`)],
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

  const allRows = [...aClass, ...shadowChecks];
  const failing = allRows.filter(([, result]) => result.status === "FAIL");
  const findingsPath = join(logDir, "SHADOW_FINDINGS.md");
  const report = [
    "# SHADOW_FINDINGS",
    "",
    `Log dir: ${logDir}`,
    `Generated at: ${new Date().toISOString()}`,
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
