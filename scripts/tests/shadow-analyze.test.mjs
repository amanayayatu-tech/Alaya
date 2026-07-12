import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
    scenario: { runId: "shadow-fixture" },
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

function analyze(dir, extraArgs = []) {
  const args = [...extraArgs];
  if (args.includes("--analysis-mode=compressed-precheck")) {
    if (!args.some((arg) => arg.startsWith("--invocation-nonce="))) args.push("--invocation-nonce=shadow-test-nonce");
    if (!args.some((arg) => arg.startsWith("--expected-replicate-id="))) args.push("--expected-replicate-id=shadow-fixture");
  }
  return spawnSync(process.execPath, ["scripts/shadow-analyze.mjs", dir, ...args], {
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
      cycle_id TEXT,
      agent TEXT,
      provider TEXT,
      model TEXT,
      route_reason TEXT,
      prompt_version TEXT,
      input_summary TEXT,
      output_summary TEXT,
      schema_valid INTEGER,
      llm_failure_type TEXT,
      retry_count INTEGER,
      latency_ms INTEGER,
      input_token_count INTEGER,
      output_token_count INTEGER,
      token_count INTEGER,
      token_source TEXT,
      estimated_cost REAL,
      ts TEXT
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

test("compressed analyzer excludes exactly the two duration checks while formal mode remains blocking", () => {
  const dir = makeLogDir("shadow-compressed-duration-only");
  const summaryPath = join(dir, "summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  summary.validationDurationMs = 3 * 3_600_000;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  const firstSnapshot = readFileSync(join(dir, "metrics", "snapshot_0001.txt"), "utf8");
  const firstSnapshotJson = readFileSync(join(dir, "metrics", "snapshot_0001.json"), "utf8");
  rmSync(join(dir, "metrics"), { recursive: true });
  mkdirSync(join(dir, "metrics"));
  writeFileSync(join(dir, "metrics", "snapshot_0001.txt"), firstSnapshot);
  writeFileSync(join(dir, "metrics", "snapshot_0001.json"), firstSnapshotJson);

  const formal = analyze(dir);
  assert.equal(formal.status, 1);
  assert.equal(existsSync(join(dir, "compressed_precheck_analysis.json")), false);
  assert.match(readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8"), /Summary: FAIL \(2 failing checks\)/);

  const compressed = analyze(dir, ["--analysis-mode=compressed-precheck"]);
  assert.equal(compressed.status, 0, compressed.stderr);
  const classification = JSON.parse(readFileSync(join(dir, "compressed_precheck_analysis.json"), "utf8"));
  assert.equal(classification.status, "PASS");
  assert.equal(classification.durationOnlyFormalFailure, true);
  assert.deepEqual(classification.excludedFailureNames, ["durationAtLeast24h", "metricsSnapshotsAtLeast48"]);
  assert.deepEqual(classification.blockingFailureNames, []);
  assert.equal(classification.invocationNonce, "shadow-test-nonce");
  assert.equal(classification.expectedReplicateId, "shadow-fixture");
  assert.equal(classification.actualReplicateId, "shadow-fixture");
  assert.ok(Date.parse(classification.generatedAt) > 0);
  assert.match(classification.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(classification.checkContract?.status, "PASS");
});

test("compressed analyzer fails closed when the invocation is bound to another replicate", () => {
  const dir = makeLogDir("shadow-compressed-wrong-replicate");
  const result = analyze(dir, [
    "--analysis-mode=compressed-precheck",
    "--invocation-nonce=wrong-replicate-nonce",
    "--expected-replicate-id=another-replicate",
  ]);
  assert.equal(result.status, 1);
  const classification = JSON.parse(readFileSync(join(dir, "compressed_precheck_analysis.json"), "utf8"));
  assert.equal(classification.status, "FAIL");
  assert.equal(classification.bindingStatus, "FAIL");
  assert.equal(classification.expectedReplicateId, "another-replicate");
  assert.equal(classification.actualReplicateId, "shadow-fixture");
});

test("compressed analyzer keeps non-duration failures blocking", () => {
  const dir = makeLogDir("shadow-compressed-nonduration");
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ eventType: "runner_crashed", error: "boom" })}\n`);
  const result = analyze(dir, ["--analysis-mode=compressed-precheck"]);
  assert.equal(result.status, 1);
  const classification = JSON.parse(readFileSync(join(dir, "compressed_precheck_analysis.json"), "utf8"));
  assert.equal(classification.status, "FAIL");
  assert.ok(classification.blockingFailureNames.includes("runnerCrashedZero"));
});

test("compressed analyzer inventories every model-calling agent and exposes non-learning agent route drift", () => {
  const dir = makeLogDir("shadow-model-call-inventory");
  const summaryPath = join(dir, "summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  summary.scenario = {
    name: "learning-cases",
    runId: "shadow-fixture",
    requiredModelCallingAgents: ["orchestrator", "sensor", "builder", "distiller", "librarian"],
  };
  summary.llmProvider = "openai";
  summary.model = "MiniMax-M3";
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({
    eventType: "learning_case_resolved",
    arm: "treatment",
    ordinal: 1,
    caseId: "case_001",
    cycleId: "cycle_001",
    pool: "train",
    parseStatus: "ok",
    predictedDecision: "reduce_exposure",
    groundTruthDecision: "reduce_exposure",
    knowledgeInjection: { injectedKnowledgeIds: [], rankingMode: "thompson", epsilon: 0.1 },
  })}\n`);
  createQualityDb(dir);
  const db = new Database(join(dir, "health-signal.db"));
  const insert = db.prepare(`
    INSERT INTO llm_calls (
      cycle_id,agent,provider,model,route_reason,prompt_version,input_summary,output_summary,
      schema_valid,llm_failure_type,retry_count,latency_ms,input_token_count,output_token_count,
      token_count,token_source,estimated_cost,ts
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const [index, agent] of ["orchestrator", "sensor", "builder", "distiller", "librarian"].entries()) {
    insert.run(
      `cycle_${index + 1}`,
      agent,
      "openai",
      agent === "sensor" ? "unexpected-model" : "MiniMax-M3",
      "test",
      "v1",
      "input",
      "output",
      1,
      null,
      0,
      10,
      100,
      20,
      120,
      "provider",
      0.01,
      "2026-06-12T00:00:00.000Z",
    );
  }
  db.close();

  const result = analyze(dir, ["--analysis-mode=compressed-precheck"]);
  assert.equal(result.status, 1);
  const quality = JSON.parse(readFileSync(join(dir, "quality_summary.json"), "utf8"));
  assert.equal(quality.modelCallInventory.callCount, 5);
  assert.deepEqual(quality.modelCallInventory.observedAgents, ["orchestrator", "sensor", "builder", "distiller", "librarian"]);
  assert.deepEqual(quality.modelCallInventory.missingAgents, []);
  assert.equal(quality.modelCallInventory.providerRouteRatio, 0.8);
  assert.deepEqual(quality.modelCallInventory.unexpectedRouteCallIds, [2]);
  assert.equal(quality.modelCallInventory.status, "FAIL");
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

test("shadow analyzer fails when decisionTsr finds active unsuperseded long_only knowledge", () => {
  const dir = makeLogDir("shadow-quality-decision-red");
  createQualityDb(dir, [
    {
      id: "kb_gate_sample_0001_long_support",
      title: "看多优先证据：基本面上修与估值修复",
      content: "当前最优仓位决策：优先做多，置信度 0.64。",
      status: "active",
    },
    {
      id: "kb_gate_sample_0005_tiered_support",
      title: "分层仓位证据：核心多头 + 空头对冲",
      content: "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
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
      reviewId: "kr_bad_long",
      primaryKnowledgeId: "kb_sample_0003_long_risk",
      relatedKnowledgeId: "kb_sample_0001_long_support",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0001_long_support",
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
      primaryKnowledgeId: "kb_sample_0001_long_support",
      relatedKnowledgeId: "kb_sample_0003_long_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0003_long_risk",
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

test("shadow analyzer marks calibration and faithfulness low coverage without failing the run", () => {
  const dir = makeLogDir("shadow-quality-conflict-quality-low-coverage");
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({
      eventType: "contradiction_feedback_injected",
      evidenceText: [
        "分层仓位证据：核心多头 + 空头对冲。",
        "tiered_thesis_confidence >= 0.81。",
        "明确冲突：该结论与分层仓位反证互相矛盾。",
        "当前最优仓位决策：多空分层仓位方案，置信度 0.8。",
      ].join("\n"),
    }),
  ].join("\n") + "\n");
  createQualityDb(dir, [
    {
      id: "kb_proj_runtime_tiered_support_001",
      title: "运行知识: 分层仓位方案",
      source_ref: "sample_0005_tiered_support",
      content: [
        "分层仓位证据：核心多头 + 空头对冲。",
        "tiered_thesis_confidence >= 0.81。",
        "明确冲突：该结论与分层仓位反证互相矛盾。",
        "当前最优仓位决策：多空分层仓位方案，置信度 0.8。",
      ].join("\n"),
      status: "active",
      confidence_score: 0.8,
    },
    {
      id: "kb_generic_gray_001",
      title: "通用灰区知识",
      content: "普通运行备注，不属于 Equity Thesis 冲突评估对象。",
      status: "active",
      confidence_score: 0.5,
    },
    {
      id: "kb_generic_gray_002",
      title: "通用灰区知识",
      content: "普通运行备注，不属于 Equity Thesis 冲突评估对象。",
      status: "active",
      confidence_score: 0.5,
    },
    {
      id: "kb_generic_gray_003",
      title: "通用灰区知识",
      content: "普通运行备注，不属于 Equity Thesis 冲突评估对象。",
      status: "active",
      confidence_score: 0.5,
    },
  ]);

  const result = analyze(dir);
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(join(dir, "SHADOW_FINDINGS.md"), "utf8");
  const quality = JSON.parse(readFileSync(join(dir, "quality_summary.json"), "utf8"));
  assert.match(report, /Summary: PASS/);
  assert.match(report, /confidenceCalibration \| LOW_COVERAGE/);
  assert.match(report, /faithfulness \| LOW_COVERAGE/);
  assert.match(report, /eligible=1 denominator=1/);
  assert.equal(quality.confidenceCalibration.status, "low_coverage");
  assert.equal(quality.confidenceCalibration.blockingEligible, false);
  assert.equal(quality.confidenceCalibration.eligible, 1);
  assert.equal(quality.confidenceCalibration.denominator, 1);
  assert.equal(quality.faithfulness.status, "low_coverage");
  assert.equal(quality.faithfulness.blockingEligible, false);
  assert.equal(quality.faithfulness.eligible, 1);
  assert.equal(quality.faithfulness.denominator, 1);
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
