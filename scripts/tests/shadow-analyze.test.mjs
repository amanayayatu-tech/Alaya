import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function makeLogDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `alaya-${name}-`));
  mkdirSync(join(dir, "metrics"));
  writeFileSync(join(dir, "monitor_log.csv"), [
    "sample,epoch,iso,round1vs4KnowledgeDelta,pendingGates,activeCount,openConflictReviews,resolvedConflictReviews,stallGuardCount,cyclesClosed,llmTokenSource",
    "1,1,2026-06-12T00:00:00.000Z,8,0,1,0,3,0,10,provider",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "events.jsonl"), "");
  writeFileSync(join(dir, "watchdog.jsonl"), `${JSON.stringify({ ok: true, checkedAt: "2026-06-12T00:00:00.000Z" })}\n`);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    validationDurationMs: 24 * 3_600_000,
    assessment: {
      criteria: {
        deltaReached8: true,
        activeNeverZero: true,
        tokenSourceProviderAtLeast95pct: true,
        semanticContradictionBypassZero: true,
        conflictAtLeast5: true,
        conflictResolvedAtLeast3: true,
        humanGateDropAtLeast30pct: false,
        stallGuardUnder5pct: true,
        sampleFailedZero: true,
      },
      observed: {
        lastDelta: 8,
        minActiveKnowledgeCount: 1,
        lastLlmTokenSourceStats: { providerRatio: 1 },
        semanticContradictionBypassCount: 0,
        maxConflictCount: 5,
        maxResolvedConflictReviews: 3,
        earlyPendingGateAverage: 0,
        humanGatePendingDropRatio: null,
        maxStallGuardCount: 0,
        cyclesClosed: 10,
      },
    },
  }, null, 2));
  for (let i = 1; i <= 48; i += 1) {
    writeFileSync(join(dir, "metrics", `snapshot_${String(i).padStart(4, "0")}.txt`), [
      `# snapshot ${i}`,
      "alaya_gray_active_count 3",
      `alaya_scheduler_cycles_total ${i}`,
      `alaya_actions_total ${i}`,
      `alaya_llm_requests_total ${i}`,
      `alaya_knowledge_injections_total ${i}`,
      "alaya_errors_total 0",
      "alaya_gold_regression_runs_total 0",
      "alaya_sensor_errors_total{category=\"transient\"} 0",
      "alaya_distiller_proposals_total{status=\"applied\"} 1",
    ].join("\n") + "\n");
    writeFileSync(join(dir, "metrics", `snapshot_${String(i).padStart(4, "0")}.json`), JSON.stringify({
      opsMetrics: { meaningGateBudget: { overBudget: false } },
    }));
  }
  writeFileSync(join(dir, "ops_trend_warnings.log"), `${JSON.stringify({ warnings: [] })}\n`);
  return dir;
}

function analyze(dir) {
  return spawnSync(process.execPath, ["scripts/shadow-analyze.mjs", dir], {
    cwd: root,
    encoding: "utf8",
  });
}

test("shadow analyzer passes complete fixture and marks zero early backlog as N/A", () => {
  const dir = makeLogDir("shadow-pass");
  const result = analyze(dir);
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  assert.match(report, /Summary: PASS/);
  assert.match(report, /humanGateDropAtLeast30pct \| N\/A/);
});

test("shadow analyzer fails incomplete/crashed fixture", () => {
  const dir = makeLogDir("shadow-fail");
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ eventType: "runner_crashed", error: "boom" })}\n`);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    validationDurationMs: 60_000,
    assessment: {
      criteria: {
        deltaReached8: false,
        activeNeverZero: true,
        semanticContradictionBypassZero: true,
        conflictAtLeast5: false,
        conflictResolvedAtLeast3: false,
        stallGuardUnder5pct: true,
      },
      observed: { lastLlmTokenSourceStats: { providerRatio: 0.5 }, earlyPendingGateAverage: 1 },
    },
  }, null, 2));
  const result = analyze(dir);
  assert.equal(result.status, 1);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  assert.match(report, /Summary: FAIL/);
  assert.match(report, /runnerCrashedZero \| FAIL/);
  assert.match(report, /durationAtLeast24h \| FAIL/);
});

test("shadow runner exposes 24h shadow defaults without starting the run", () => {
  const result = spawnSync(process.execPath, [
    "scripts/shadow-run.mjs",
    "--print-command",
    "--log-dir=/tmp/alaya-shadow-contract",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const command = JSON.parse(result.stdout);
  assert.ok(command.args.includes("--duration-hours=24"));
  assert.ok(command.args.includes("--sample-minutes=5"));
  assert.ok(command.args.includes("--metrics-snapshot-minutes=30"));
  assert.ok(command.args.includes("--watchdog-minutes=30"));
  assert.ok(command.args.includes("--decision-via=local_api_human_proxy"));
  assert.ok(command.args.includes("--hold-review-required-meaning-gates=false"));
});
