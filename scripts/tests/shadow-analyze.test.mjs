import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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

function createQualityDb(dir, knowledgeRows = []) {
  const db = new Database(join(dir, "health-signal.db"));
  db.exec(`
    CREATE TABLE knowledge_items (
      id TEXT,
      title TEXT,
      content TEXT,
      notes TEXT,
      source_ref TEXT,
      semantic_key TEXT,
      tags TEXT,
      status TEXT,
      superseded_by TEXT,
      confidence_score REAL
    );
    CREATE TABLE event_log (
      op TEXT,
      table_name TEXT,
      before TEXT,
      after TEXT,
      actor TEXT
    );
    CREATE TABLE llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT,
      latency_ms INTEGER,
      input_token_count INTEGER,
      output_token_count INTEGER,
      token_count INTEGER,
      estimated_cost REAL
    );
  `);
  const insertKnowledge = db.prepare(`
    INSERT INTO knowledge_items (id,title,content,notes,source_ref,semantic_key,tags,status,superseded_by,confidence_score)
    VALUES (@id,@title,@content,@notes,@source_ref,@semantic_key,@tags,@status,@superseded_by,@confidence_score)
  `);
  for (const row of knowledgeRows) {
    insertKnowledge.run({
      notes: "",
      source_ref: "",
      semantic_key: "",
      tags: "[]",
      superseded_by: "",
      confidence_score: 0.8,
      ...row,
    });
  }
  db.close();
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

test("shadow analyzer fails when decisionTsr finds active unsuperseded ppg_only knowledge", () => {
  const dir = makeLogDir("shadow-quality-decision-red");
  createQualityDb(dir, [
    {
      id: "kb_gate_sample_0001_ppg_support",
      title: "PPG 优先证据：成本与续航匹配",
      content: "当前最优选型决策：优先 PPG，置信度 0.64。",
      status: "active",
    },
    {
      id: "kb_gate_sample_0005_hybrid_support",
      title: "混合方案证据：PPG 连续 + ECG 复核",
      content: "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
      status: "active",
    },
  ]);

  const result = analyze(dir);
  assert.equal(result.status, 1);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  const quality = JSON.parse(readFileSync(join(dir, "quality_summary.json"), "utf8"));
  assert.match(report, /decisionTsr \| FAIL/);
  assert.equal(quality.decisionTsr.status, "fail");
  assert.equal(quality.decisionTsr.disallowedFinalCount, 1);
});

test("shadow analyzer fails when resolutionAccuracy preserves the weaker side", () => {
  const dir = makeLogDir("shadow-quality-resolution-red");
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({
      eventType: "knowledge_review_resolved",
      reviewId: "kr_bad_ppg",
      primaryKnowledgeId: "kb_sample_0003_ppg_risk",
      relatedKnowledgeId: "kb_sample_0001_ppg_support",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0001_ppg_support",
    }),
  ].join("\n") + "\n");

  const result = analyze(dir);
  assert.equal(result.status, 1);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  const quality = JSON.parse(readFileSync(join(dir, "quality_summary.json"), "utf8"));
  assert.match(report, /resolutionAccuracy \| FAIL/);
  assert.equal(quality.resolutionAccuracy.status, "fail");
  assert.equal(quality.resolutionAccuracy.scored, 1);
  assert.equal(quality.resolutionAccuracy.correct, 0);
});

test("shadow analyzer marks resolutionAccuracy low coverage without failing the run", () => {
  const dir = makeLogDir("shadow-quality-resolution-low-coverage");
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({
      eventType: "knowledge_review_resolved",
      reviewId: "kr_good",
      primaryKnowledgeId: "kb_sample_0001_ppg_support",
      relatedKnowledgeId: "kb_sample_0003_ppg_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0003_ppg_risk",
    }),
    JSON.stringify({
      eventType: "knowledge_review_resolved",
      reviewId: "kr_unknown_1",
      primaryKnowledgeId: "kb_generic_a",
      relatedKnowledgeId: "kb_generic_b",
      action: "quarantine",
    }),
  ].join("\n") + "\n");

  const result = analyze(dir);
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  const quality = JSON.parse(readFileSync(join(dir, "quality_summary.json"), "utf8"));
  assert.match(report, /resolutionAccuracy \| LOW_COVERAGE/);
  assert.equal(quality.resolutionAccuracy.status, "low_coverage");
  assert.equal(quality.resolutionAccuracy.blockingEligible, false);
});

test("shadow analyzer reconstructs duration and A-class assessment from raw logs when summary.json is missing", () => {
  const dir = makeLogDir("shadow-reconstruct-pass");
  rmSync(join(dir, "summary.json"));
  // 25h of samples spanning real timestamps; criteria-satisfying raw values.
  writeFileSync(join(dir, "monitor_log.csv"), [
    "sample,epoch,iso,round1vs4KnowledgeDelta,pendingGates,activeCount,conflictCount,openConflictReviews,resolvedConflictReviews,stallGuardCount,cyclesClosed,llmTokenSource",
    "1,1,2026-06-12T00:00:00.000Z,2,0,1,0,0,0,0,1,provider",
    "2,2,2026-06-12T12:30:00.000Z,5,0,2,3,2,1,0,5,provider",
    "3,3,2026-06-13T01:00:00.000Z,9,0,3,5,2,3,0,10,mixed_provider_100pct",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({ ts: "2026-06-12T00:00:00.000Z", eventType: "metrics_sample", sample: 1, llmTokenSourceStats: { providerRatio: 1 } }),
    JSON.stringify({ ts: "2026-06-13T01:00:00.000Z", eventType: "metrics_sample", sample: 3, llmTokenSourceStats: { providerRatio: 0.999 } }),
    JSON.stringify({ ts: "2026-06-13T01:00:00.000Z", eventType: "knowledge_review_resolved", reviewId: "r1" }),
    JSON.stringify({ ts: "2026-06-13T01:00:00.000Z", eventType: "knowledge_review_resolved", reviewId: "r2" }),
    JSON.stringify({ ts: "2026-06-13T01:00:00.000Z", eventType: "knowledge_review_resolved", reviewId: "r3" }),
  ].join("\n") + "\n");
  const result = analyze(dir);
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  assert.match(report, /Assessment source: reconstructed from monitor_log\.csv \+ events\.jsonl/);
  assert.match(report, /Duration source: reconstructed from raw log timestamps/);
  assert.match(report, /durationAtLeast24h \| PASS \| 25\.00h/);
  assert.match(report, /deltaReached8 \| PASS \| last=9/);
  assert.match(report, /tokenSourceProviderAtLeast95pct \| PASS \| providerRatio=0\.999/);
  assert.match(report, /conflictAtLeast5 \| PASS/);
  assert.match(report, /conflictResolvedAtLeast3 \| PASS/);
  assert.match(report, /humanGateDropAtLeast30pct \| N\/A/);
});

test("shadow analyzer reconstruction still fails honestly on a short interrupted run", () => {
  const dir = makeLogDir("shadow-reconstruct-fail");
  rmSync(join(dir, "summary.json"));
  writeFileSync(join(dir, "monitor_log.csv"), [
    "sample,epoch,iso,round1vs4KnowledgeDelta,pendingGates,activeCount,conflictCount,openConflictReviews,resolvedConflictReviews,stallGuardCount,cyclesClosed,llmTokenSource",
    "1,1,2026-06-12T00:00:00.000Z,1,0,1,0,0,0,0,1,estimated",
    "2,2,2026-06-12T00:30:00.000Z,2,0,1,0,0,0,0,2,estimated",
  ].join("\n") + "\n");
  const result = analyze(dir);
  assert.equal(result.status, 1);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  assert.match(report, /Summary: FAIL/);
  assert.match(report, /Assessment source: reconstructed from monitor_log\.csv \+ events\.jsonl/);
  assert.match(report, /durationAtLeast24h \| FAIL \| 0\.50h \(reconstructed from raw log timestamps\)/);
  assert.match(report, /deltaReached8 \| FAIL \| last=2/);
  assert.match(report, /tokenSourceProviderAtLeast95pct \| FAIL \| providerRatio=0/);
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
