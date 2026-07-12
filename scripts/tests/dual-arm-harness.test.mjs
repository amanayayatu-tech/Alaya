import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ROOT,
  analyzerResultAccepted,
  buildPairedHarnessPlan,
  pairedPrecheckBlocked,
  runPairedPrecheck,
  validatePairedCaseSequence,
} from "../lib/dual-arm-harness.mjs";
import { classifyCompressedAnalyzerChecks } from "../lib/learning-precheck-gates.mjs";
import {
  evaluateLearningLoopMetrics,
  extractLearningDecisionRows,
} from "../lib/health-signal-quality.mjs";
import { buildLearningCaseProjectPatch } from "../lib/learning-runtime-contract.mjs";

function tempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test("dual-arm harness builds paired baseline and treatment configs from one case sequence", () => {
  const runRoot = tempRoot("alaya-dual-arm-plan-");
  const plan = buildPairedHarnessPlan({
    worldSeed: "paired-seed-001",
    count: 24,
    runRoot,
    baselinePort: 5510,
    treatmentPort: 5511,
    epsilon: 0.25,
  });
  const baseline = plan.arms.find((arm) => arm.arm === "baseline");
  const treatment = plan.arms.find((arm) => arm.arm === "treatment");

  assert.equal(plan.pairing.ok, true);
  assert.equal(plan.cases.length, 24);
  assert.ok(baseline);
  assert.ok(treatment);
  assert.notEqual(baseline.dbPath, treatment.dbPath);
  assert.notEqual(baseline.logDir, treatment.logDir);
  assert.notEqual(baseline.port, treatment.port);
  assert.equal(baseline.env.ALAYA_KNOWLEDGE_INJECTION, "off");
  assert.equal(baseline.env.ALAYA_LEARNING_CASES_PATH, baseline.casesPath);
  assert.equal(baseline.env.ALAYA_ORACLE_ANSWERS_PATH, baseline.oracleAnswersPath);
  assert.equal(baseline.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH, baseline.knowledgeRetrievalControlPath);
  assert.equal(treatment.env.ALAYA_KNOWLEDGE_INJECTION, "on");
  assert.equal(treatment.env.ALAYA_KNOWLEDGE_RANKING, "thompson");
  assert.equal(treatment.env.ALAYA_INJECTION_EPSILON, "0.25");
  assert.equal(treatment.env.ALAYA_LEARNING_CASES_PATH, treatment.casesPath);
  assert.equal(treatment.env.ALAYA_ORACLE_ANSWERS_PATH, treatment.oracleAnswersPath);
  assert.equal(treatment.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH, treatment.knowledgeRetrievalControlPath);
  assert.equal(baseline.env.MINIMAX_THINKING, "disabled");
  assert.equal(treatment.env.MINIMAX_THINKING, "disabled");
  assert.ok(baseline.shadowRun.args.includes("--scenario=learning-cases"));
  assert.ok(treatment.shadowRun.args.includes("--scenario=learning-cases"));
  assert.ok(baseline.shadowRun.args.some((arg) => arg === `--learning-cases-path=${baseline.casesPath}`));
  assert.ok(treatment.shadowRun.args.some((arg) => arg === `--learning-cases-path=${treatment.casesPath}`));
  assert.ok(baseline.shadowRun.args.includes(`--run-id=${baseline.replicateId}`));
  assert.ok(treatment.shadowRun.args.includes(`--run-id=${treatment.replicateId}`));
  assert.ok(baseline.analyze.args.some((arg) => arg.startsWith("--oracle-answers=")));
  assert.ok(baseline.analyze.args.includes("--analysis-mode=compressed-precheck"));
  assert.ok(treatment.analyze.args.some((arg) => arg.startsWith("--log-dir=")));
});

test("paired case sequence validation catches mismatched case ids", () => {
  const plan = buildPairedHarnessPlan({
    worldSeed: "paired-seed-002",
    count: 16,
    runRoot: tempRoot("alaya-dual-arm-mismatch-"),
  });
  const changed = plan.cases.map((testCase) => ({ ...testCase }));
  changed[3] = { ...changed[3], id: "different_case_id" };

  const result = validatePairedCaseSequence(plan.cases, changed);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /case 4 id mismatch/);
});

test("ALAYA_KNOWLEDGE_INJECTION=off prevents prior context and emits disabled trace evidence", () => {
  const script = String.raw`
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-off-switch-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_KNOWLEDGE_INJECTION = "off";
process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
process.env.ALAYA_INJECTION_EPSILON = "0.7";
process.env.ALAYA_RUN_SEED = "off-switch-run";

const { storage } = await import("./alaya-app/server/storage.ts");
const { buildKnowledgeContext } = await import("./alaya-app/server/knowledgeInjection.ts");

const projectId = "proj_off_switch";
const cycleId = "cycle_off_switch";
storage.createProject({
  id: projectId,
  name: "Off switch",
  direction: "Validate off switch",
  targetUser: "operator teams",
  redlines: JSON.stringify(["never inject when disabled"]),
  weeklyHumanMinutes: 240,
  weeklyLlmBudgetCents: 10000,
  firstClaimMetric: "activation_rate",
  firstClaimOperator: ">=",
  firstClaimTarget: 0.3,
  seedIdentity: "Knowledge injection must be controllable for paired experiments.",
  worldModel: "The baseline arm disables prior knowledge.",
  currentCycleIdx: 1,
  version: 1,
});
storage.createKnowledge({
  id: "kb_off_switch",
  projectId,
  type: "principle",
  title: "rollback audit preview principle",
  content: "rollback audit preview knowledge that would normally be injected",
  sourceType: "metric",
  sourceRef: "dual-arm-test",
  evidenceAlpha: 8,
  evidenceBeta: 1,
  confidenceScore: 0.91,
  confidenceLevel: "high",
  status: "active",
  humanApprovedCount: 0,
  externalVerifiedCount: 1,
  validFrom: "2026-06-04",
  validUntil: null,
  lastValidatedCycle: 2,
  createdByCycle: 2,
  createdBy: "distiller",
  approvedBy: null,
  usageCount: 0,
  lastInjectedAt: null,
  storageStrength: 1,
  noveltyScore: null,
  sourceRound: 2,
  tags: JSON.stringify(["rollback", "audit", "preview"]),
  notes: "",
  supersededBy: null,
  semanticKey: "",
  version: 1,
});

const context = buildKnowledgeContext("rollback audit preview", projectId, {
  cycleId,
  cycleIdx: 99,
  maxTokens: 500,
});
assert.equal(context, "");
assert.equal(storage.getKnowledge("kb_off_switch")?.usageCount, 0);

const trace = storage.listTraceEventsByCycle(cycleId).find((event) => event.kind === "knowledge_injection");
assert.ok(trace);
const attrs = JSON.parse(trace.attributes);
assert.equal(attrs.injectionDisabled, true);
assert.equal(attrs.knowledgeInjectionMode, "off");
assert.equal(attrs.rankingMode, "thompson");
assert.deepEqual(attrs.candidateIds, []);
assert.deepEqual(attrs.injectedKnowledgeIds, []);
assert.deepEqual(attrs.perItemSample, {});
assert.equal(attrs.droppedKnowledgeId, null);
assert.equal(attrs.epsilon, 0.7);
assert.equal(attrs.itemCount, 0);
assert.equal(attrs.maxTokens, 500);
assert.equal(attrs.taskQueryChars, "rollback audit preview".length);
console.log(JSON.stringify({ context, attrs }));
`;
  const result = run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script]);
  const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(parsed.context, "");
  assert.equal(parsed.attrs.injectionDisabled, true);
  assert.doesNotMatch(result.stdout, /\[PRIOR KNOWLEDGE\]/);
});

test("dual-arm harness does not export synthetic learning correctness helper", async () => {
  const module = await import("../lib/dual-arm-harness.mjs");
  assert.equal("learningDecisionEventForCase" in module, false);
});

test("health-signal learning-cases path uses runtime model provenance instead of harness correctness", () => {
  const source = readFileSync(join(ROOT, "scripts/health-signal-36h-validation.mjs"), "utf8");
  assert.doesNotMatch(source, /learning_cases_runtime_harness/);
  assert.doesNotMatch(source, /learningDecisionEventForCase/);
  assert.doesNotMatch(source, /shouldMissLearningCase/);
  assert.doesNotMatch(source, /latestNewPrediction/);
  assert.match(source, /recordLearningCaseRuntimeDecision/);
  assert.match(source, /bindLearningPrediction/);
  assert.match(source, /learning_case_prediction_binding_error/);
  assert.match(source, /heldout_write_filter/);
  assert.match(source, /writeKnowledgeRetrievalControl/);
  assert.match(source, /knowledgeRetrievalIdentity/);
  assert.match(source, /runId/);
  assert.match(source, /cycleId/);
  assert.match(source, /knowledgeRetrievalMode/);
  assert.match(source, /drainRemainingLearningCases/);
  assert.match(source, /decisionSource:\s*"runtime_model_prediction"/);
  assert.match(source, /api:\/feedback\/form -> api:\/scheduler\/tick -> api:\/projects\/:id\/predictions/);
});

test("health-signal learning-cases path wires an immutable first-failure hard stop through queue and flywheel drains", () => {
  const source = readFileSync(join(ROOT, "scripts/health-signal-36h-validation.mjs"), "utf8");
  assert.match(source, /createLearningCaseHardStop/);
  assert.match(source, /learning_case_hard_stop_latched/);
  assert.match(source, /state\.learningCaseHardStop\.runProvider/);
  assert.match(source, /state\.learningCaseHardStop\.snapshot\(\)/);
  assert.match(source, /learning_case_queue_drain_blocked_by_hard_stop/);
  assert.match(source, /final_drain_blocked_by_learning_case_hard_stop/);
  assert.ok(
    source.indexOf("const latchedLearningCaseFailure") > source.indexOf("const flywheelDrain = await finalDrainFlywheel"),
    "final summary must observe a hard stop first latched inside flywheel final drain",
  );
  assert.match(source, /if \(latchedLearningCaseFailure\) process\.exitCode = 1/);
});

test("health-signal configures each learning case as runtime context without oracle labels", () => {
  const source = readFileSync(join(ROOT, "scripts/health-signal-36h-validation.mjs"), "utf8");
  const patch = buildLearningCaseProjectPatch({
    id: "case_hidden",
    pool: "heldout",
    ruleRef: "seed:R8",
    groundTruthDecision: "avoid_trade",
    expectedDecision: "avoid_trade",
    oracle: { decision: "avoid_trade" },
    title: "Equity thesis review ALYA-0112",
    signals: [{ label: "liquidity risk", text: "Liquidity runway tightened.", polarity: "negative" }],
  });
  const patchText = JSON.stringify(patch);
  assert.match(patchText, /alaya\.learning_loop\.decision\.v1/);
  assert.match(patchText, /exactly one compact JSON string/);
  assert.match(patchText, /visible signal/);
  assert.doesNotMatch(patchText, /heldout|\btrain\b|ruleRef|groundTruthDecision|expectedDecision|oracle|seed:R8|case_hidden/i);
  const runtimeSource = source.slice(source.indexOf("async function configureLearningCaseProject"));
  assert.match(runtimeSource, /method:\s*"PATCH"/);
  assert.match(runtimeSource, /api:\/projects\/:id PATCH/);
  assert.match(runtimeSource, /decisionSource:\s*"runtime_model_prediction_context"/);
});

test("health-signal warms learning-cases past fixed scripted cycles before scoring", () => {
  const source = readFileSync(join(ROOT, "scripts/health-signal-36h-validation.mjs"), "utf8");
  assert.match(source, /warmUpLearningCaseAutonomousCycle/);
  assert.match(source, /targetOpenCycleIdx:\s*5/);
  assert.match(source, /skip fixed scripted scenario cycles/);
  assert.match(source, /learning_case_autonomous_warmup_complete/);
  assert.match(source, /isolateLearningWarmupKnowledge/);
  assert.match(source, /learning_case_warmup_knowledge_isolated/);
  assert.match(source, /status:\s*"deprecated"/);
});

test("runtime model learning events produce PR-L5 analyzable source rows with train and heldout pools", () => {
  const plan = buildPairedHarnessPlan({
    worldSeed: "paired-seed-003",
    count: 40,
    runRoot: tempRoot("alaya-dual-arm-learning-rows-"),
  });
  const events = plan.cases.map((testCase, index) => ({
    eventType: "learning_case_resolved",
    learningCaseEventSchema: "alaya.learning_loop.learning_case_event.v2",
    projectId: "proj_learning_rows",
    arm: "treatment",
    caseId: testCase.id,
    externalId: testCase.externalId,
    cycleId: `cycle_${String(index + 1).padStart(4, "0")}`,
    predictionId: `pred_${String(index + 1).padStart(4, "0")}`,
    sample: Math.floor(index / 4) + 1,
    ordinal: index + 1,
    worldSeed: testCase.worldSeed,
    ruleId: testCase.ruleId,
    ruleRef: testCase.ruleRef,
    pool: testCase.pool,
    predictedDecision: testCase.groundTruthDecision,
    groundTruthDecision: testCase.groundTruthDecision,
    confidence: testCase.confidence,
    decisionSource: "runtime_model_prediction",
    runtimePath: "api:/feedback/form -> api:/scheduler/tick -> api:/projects/:id/predictions",
    modelPrediction: {
      id: `pred_${String(index + 1).padStart(4, "0")}`,
      cycleId: `cycle_${String(index + 1).padStart(4, "0")}`,
      prediction: `model selected ${testCase.groundTruthDecision}`,
      action: testCase.groundTruthDecision,
      knowledgeRefs: [],
    },
  }));

  const rows = extractLearningDecisionRows(events);
  assert.equal(rows.length, 40);
  assert.equal(rows.filter((row) => row.pool === "train").length, 32);
  assert.equal(rows.filter((row) => row.pool === "heldout").length, 8);
  assert.equal(rows.filter((row) => row.groundTruthDecision && row.predictedDecision).length, 40);
  assert.equal(events.some((event) => "correct" in event || "decisionMatchesExpected" in event), false);
  assert.equal(events.every((event) => event.decisionSource === "runtime_model_prediction"), true);

  const metrics = evaluateLearningLoopMetrics({
    events,
    oracleAnswers: { answers: plan.oracleAnswers },
    blockSize: 10,
  });
  assert.equal(metrics.sourceRows.length, 40);
  assert.equal(metrics.heldOutAccuracy.heldoutScored, 8);
  assert.equal(metrics.heldOutAccuracy.trainScored, 32);
  assert.equal(metrics.cumulativeRegret.scored, 40);
});

test("paired precheck runs both analyzers even when the first analyzer exits nonzero", async () => {
  const runRoot = tempRoot("alaya-dual-arm-analyze-all-");
  const keyFile = join(runRoot, "openai-api-key");
  writeFileSync(keyFile, "test-key\n");
  const plan = buildPairedHarnessPlan({
    worldSeed: "paired-seed-004",
    count: 12,
    runRoot,
    baselinePort: 5520,
    treatmentPort: 5521,
  });
  const analyzed = [];
  const result = await runPairedPrecheck(plan, {
    keyFile,
    startStaggerMs: 0,
    shadowRunner: async () => ({ code: 0, signal: null }),
    analyzeRunner: async (_command, args) => {
      analyzed.push(args);
      return { code: analyzed.length === 1 ? 1 : 0, signal: null };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "VALIDATION_BLOCKED");
  assert.equal(analyzed.length, 2);
  assert.equal(result.results.filter((entry) => entry.step === "shadow-analyze").length, 2);
  assert.equal(result.precheckEvaluation.ok, false);
  assert.ok(result.precheckEvaluationPath.endsWith("precheck_evaluation.json"));
  assert.deepEqual(
    result.results.filter((entry) => entry.step === "shadow-analyze").map((entry) => entry.arm),
    ["baseline", "treatment"],
  );
  for (const entry of result.results.filter((item) => item.step === "shadow-analyze")) {
    assert.ok(entry.artifacts.summary.endsWith("summary.json"));
    assert.ok(entry.artifacts.qualitySummary.endsWith("quality_summary.json"));
    assert.ok(entry.artifacts.findings.endsWith("SHADOW_FINDINGS.md"));
  }
});

test("paired precheck preserves both analyzer paths after a hard-stopped arm run", async () => {
  const runRoot = tempRoot("alaya-dual-arm-hard-stop-analyze-");
  const keyFile = join(runRoot, "openai-api-key");
  writeFileSync(keyFile, "test-key\n");
  const plan = buildPairedHarnessPlan({
    worldSeed: "paired-seed-hard-stop",
    count: 12,
    runRoot,
    baselinePort: 5530,
    treatmentPort: 5531,
  });
  let shadowRuns = 0;
  const analyzed = [];
  const result = await runPairedPrecheck(plan, {
    keyFile,
    startStaggerMs: 0,
    shadowRunner: async () => {
      shadowRuns += 1;
      return { code: shadowRuns === 1 ? 1 : 0, signal: null };
    },
    analyzeRunner: async (_command, args) => {
      analyzed.push(args);
      return { code: 1, signal: null };
    },
  });

  assert.equal(result.status, "VALIDATION_BLOCKED");
  assert.equal(shadowRuns, 2);
  assert.equal(analyzed.length, 2);
  assert.deepEqual(
    result.results.filter((entry) => entry.step === "shadow-analyze").map((entry) => entry.arm),
    ["baseline", "treatment"],
  );
});

test("harness rejects every analyzer nonzero exit, including code 1 with duration-only classification", () => {
  const durationOnly = classifyCompressedAnalyzerChecks([
    ["durationAtLeast24h", { status: "FAIL" }],
    ["metricsSnapshotsAtLeast48", { status: "FAIL" }],
    ["runnerCrashedZero", { status: "PASS" }],
  ]);
  const nonDuration = classifyCompressedAnalyzerChecks([
    ["durationAtLeast24h", { status: "FAIL" }],
    ["runnerCrashedZero", { status: "FAIL" }],
  ]);

  assert.equal(analyzerResultAccepted({ code: 1, signal: null }, durationOnly), false);
  assert.equal(analyzerResultAccepted({ code: 1, signal: null }, nonDuration), false);
  assert.equal(analyzerResultAccepted({ code: 1, signal: "SIGTERM" }, durationOnly), false);
  assert.equal(analyzerResultAccepted({ code: 2, signal: null }, durationOnly), false);
  assert.equal(analyzerResultAccepted({ code: 1, signal: null }, null), false);
  const tampered = {
    ...durationOnly,
    checkStatuses: { ...durationOnly.checkStatuses, runnerCrashedZero: "FAIL" },
  };
  assert.equal(analyzerResultAccepted({ code: 1, signal: null }, tampered), false);

  const accepted = [{ arm: "baseline", accepted: true }, { arm: "treatment", accepted: true }];
  const runResults = [{ step: "shadow-run", code: 0, signal: null }, { step: "shadow-run", code: 0, signal: null }];
  assert.equal(pairedPrecheckBlocked({ results: runResults, analyzerAcceptances: accepted, precheckEvaluation: { ok: true } }), false);
  assert.equal(pairedPrecheckBlocked({ results: runResults, analyzerAcceptances: accepted, precheckEvaluation: { ok: false } }), true);
  assert.equal(pairedPrecheckBlocked({ results: runResults, analyzerAcceptances: [{ arm: "baseline", accepted: false }], precheckEvaluation: { ok: true } }), true);
});

test("extract_phase3_metrics emits PR-L5 learning metric columns without changing arm semantics", () => {
  const dir = tempRoot("alaya-phase3-extract-");
  const qualityPath = join(dir, "quality_summary.json");
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    assessment: {
      observed: {
        lastLlmTokenSourceStats: { providerRatio: 0.99 },
      },
    },
  }));
  writeFileSync(qualityPath, JSON.stringify({
    confidenceCalibration: {
      ece: 0.12,
      scored: 80,
      eligible: 80,
      correctnessModeCounts: { calibration_truth_decision: 80 },
      reliabilityTable: [{ bucket: 8, n: 20, accuracy: 0.85, confMean: 0.83 }],
    },
    faithfulness: { faithfulness: 0.91 },
    learningCurve: {
      status: "OK",
      accuracySeries: [{ block: 1, accuracy: 0.6 }, { block: 2, accuracy: 0.9 }],
      brierSeries: [{ block: 1, brierScore: 0.22 }, { block: 2, brierScore: 0.08 }],
      accuracyTrend: { s: 1, pValue: 0.04, direction: "positive" },
      brierTrend: { s: -1, pValue: 0.04, direction: "negative" },
    },
    heldOutAccuracy: {
      status: "OK",
      heldOutAccuracy: 0.75,
      heldoutScored: 24,
      trainScored: 96,
    },
    cumulativeRegret: {
      status: "OK",
      finalCumulativeError: 7,
      tailSlopeBelowHeadSlope: true,
    },
    knowledgeROI: {
      status: "OK",
      deltaDistribution: { mean: 0.2 },
      lowCoverageCount: 3,
    },
    forgettingRate: {
      status: "OK",
      retention: 0.8,
      forgettingRate: 0.2,
    },
  }));

  const result = run("python3", ["analysis/extract_phase3_metrics.py", qualityPath, "baseline", "pair01"]);
  const row = result.stdout.trim().split(",");
  assert.equal(row[0], "pair01");
  assert.equal(row[1], "disabled");
  assert.equal(row[13], "OK");
  assert.equal(row[14], "0.9");
  assert.equal(row[15], "0.08");
  assert.equal(row[22], "OK");
  assert.equal(row[23], "0.75");
  assert.equal(row[26], "OK");
  assert.equal(row[27], "7");
  assert.equal(row[29], "OK");
  assert.equal(row[30], "0.2");
  assert.equal(row[32], "OK");
  assert.equal(row[34], "0.2");
});
