#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateLearningCases,
  oracleAnswersForCases,
  GENERATOR_SCHEMA,
  ORACLE_SCHEMA,
} from "./learning-scenario-generator.mjs";
import {
  buildArmPrecheckEvidence,
  computeAnalyzerSourceDigest,
  evaluateCompressedLearningPrecheck,
  validCompressedAnalyzerClassification,
} from "./learning-precheck-gates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "../..");
export const DEFAULT_WORLD_SEED = "2026070901";
export const DEFAULT_CASE_COUNT = 120;
export const DEFAULT_TRAIN_RATIO = 0.8;
export const DEFAULT_DURATION_HOURS = 3;
export const DEFAULT_BASELINE_PORT = 5410;
export const DEFAULT_TREATMENT_PORT = 5411;
export const DEFAULT_EPSILON = 0.1;
export const DEFAULT_OPENAI_KEY_FILE = resolve(process.env.HOME ?? "", ".config/alaya/openai-api-key");

function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

export function defaultRunRoot() {
  return join(tmpdir(), "alaya-learning-loop-precheck", `paired-${timestampForPath()}`);
}

function normalizePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }
  return parsed;
}

function normalizePort(value, name) {
  const parsed = normalizePositiveInteger(value, name);
  if (parsed > 65_535) throw new Error(`${name} must be <= 65535; received ${value}`);
  return parsed;
}

function normalizeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric; received ${value}`);
  return parsed;
}

function armEnv({ arm, worldSeed, port, dbPath, logDir, epsilon }) {
  const common = {
    PORT: String(port),
    ALAYA_DB_PATH: dbPath,
    ALAYA_LOG_DIR: logDir,
    ALAYA_RUN_SEED: String(worldSeed),
    ALAYA_WORLD_SEED: String(worldSeed),
    ALAYA_EXPERIMENT_ARM: arm,
    ALAYA_SCHEDULER: "false",
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_LLM_PROVIDER: process.env.ALAYA_LLM_PROVIDER ?? "openai",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "https://api.minimax.io/openai",
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? "MiniMax-M3",
    MINIMAX_THINKING: "disabled",
    OPENAI_THINKING: "disabled",
  };

  if (arm === "baseline") {
    return {
      ...common,
      ALAYA_KNOWLEDGE_INJECTION: "off",
      ALAYA_KNOWLEDGE_RANKING: "static",
      ALAYA_INJECTION_EPSILON: "0",
    };
  }

  return {
    ...common,
    ALAYA_KNOWLEDGE_INJECTION: "on",
    ALAYA_KNOWLEDGE_RANKING: "thompson",
    ALAYA_INJECTION_EPSILON: String(epsilon),
  };
}

function commandForArm({ durationHours, logDir, dbPath, port, worldSeed, casesPath, runId }) {
  return {
    cwd: ROOT,
    command: process.execPath,
    args: [
      "scripts/shadow-run.mjs",
      `--duration-hours=${durationHours}`,
      "--scenario=learning-cases",
      `--learning-cases-path=${casesPath}`,
      `--log-dir=${logDir}`,
      `--db-path=${dbPath}`,
      `--port=${port}`,
      `--seed=${worldSeed}`,
      `--run-id=${runId}`,
    ],
  };
}

export function validatePairedCaseSequence(leftCases, rightCases) {
  const errors = [];
  if (!Array.isArray(leftCases) || !Array.isArray(rightCases)) {
    return { ok: false, errors: ["both case sequences must be arrays"], caseIds: [] };
  }
  if (leftCases.length !== rightCases.length) {
    errors.push(`case count mismatch: ${leftCases.length} vs ${rightCases.length}`);
  }
  const count = Math.min(leftCases.length, rightCases.length);
  for (let index = 0; index < count; index += 1) {
    const left = leftCases[index] ?? {};
    const right = rightCases[index] ?? {};
    for (const field of ["id", "externalId", "worldSeed", "ruleId", "ruleRef", "pool", "groundTruthDecision"]) {
      if (left[field] !== right[field]) {
        errors.push(`case ${index + 1} ${field} mismatch: ${left[field] ?? "<missing>"} vs ${right[field] ?? "<missing>"}`);
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    caseIds: leftCases.map((testCase) => testCase.id),
  };
}

export function buildPairedHarnessPlan({
  worldSeed = DEFAULT_WORLD_SEED,
  count = DEFAULT_CASE_COUNT,
  trainRatio = DEFAULT_TRAIN_RATIO,
  runRoot = defaultRunRoot(),
  durationHours = DEFAULT_DURATION_HOURS,
  baselinePort = DEFAULT_BASELINE_PORT,
  treatmentPort = DEFAULT_TREATMENT_PORT,
  epsilon = DEFAULT_EPSILON,
} = {}) {
  const normalizedCount = normalizePositiveInteger(count, "count");
  const normalizedTrainRatio = normalizeNumber(trainRatio, "trainRatio");
  const normalizedDurationHours = normalizeNumber(durationHours, "durationHours");
  const normalizedBaselinePort = normalizePort(baselinePort, "baselinePort");
  const normalizedTreatmentPort = normalizePort(treatmentPort, "treatmentPort");
  const normalizedEpsilon = Math.max(0, Math.min(1, normalizeNumber(epsilon, "epsilon")));
  if (normalizedBaselinePort === normalizedTreatmentPort) {
    throw new Error("baselinePort and treatmentPort must be different");
  }

  const cases = generateLearningCases({
    worldSeed,
    count: normalizedCount,
    split: "all",
    trainRatio: normalizedTrainRatio,
  });
  const oracleAnswers = oracleAnswersForCases(cases);
  const resolvedRoot = resolve(runRoot);

  const armPlans = ["baseline", "treatment"].map((arm) => {
    const port = arm === "baseline" ? normalizedBaselinePort : normalizedTreatmentPort;
    const logDir = join(resolvedRoot, arm);
    const dbPath = join(logDir, "health-signal.db");
    const casesPath = join(logDir, "generated_cases.json");
    const oracleAnswersPath = join(logDir, "oracle_answers.json");
    const knowledgeRetrievalControlPath = join(logDir, "knowledge-retrieval-control.json");
    const replicateId = `learning-loop-${worldSeed}-${arm}`;
    const env = {
      ...armEnv({ arm, worldSeed, port, dbPath, logDir, epsilon: normalizedEpsilon }),
      ALAYA_LEARNING_CASES_PATH: casesPath,
      ALAYA_ORACLE_ANSWERS_PATH: oracleAnswersPath,
      ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH: knowledgeRetrievalControlPath,
    };
    return {
      arm,
      phase3Arm: arm === "baseline" ? "disabled" : "adaptive",
      logDir,
      dbPath,
      port,
      casesPath,
      oracleAnswersPath,
      knowledgeRetrievalControlPath,
      replicateId,
      env,
      shadowRun: commandForArm({
        durationHours: normalizedDurationHours,
        logDir,
        dbPath,
        port,
        worldSeed,
        casesPath,
        runId: replicateId,
      }),
      analyze: {
        cwd: ROOT,
        command: process.execPath,
        args: [
          "scripts/shadow-analyze.mjs",
          `--log-dir=${logDir}`,
          `--oracle-answers=${oracleAnswersPath}`,
          "--analysis-mode=compressed-precheck",
        ],
      },
    };
  });

  return {
    schema: "alaya.learning_loop.dual_arm_harness.v1",
    repoRoot: ROOT,
    runRoot: resolvedRoot,
    worldSeed: String(worldSeed),
    count: normalizedCount,
    trainRatio: normalizedTrainRatio,
    durationHours: normalizedDurationHours,
    caseSchema: GENERATOR_SCHEMA,
    oracleSchema: ORACLE_SCHEMA,
    cases,
    oracleAnswers,
    pairing: validatePairedCaseSequence(cases, cases),
    arms: armPlans,
    evidenceBoundary: "compressed_precheck_only_not_run_l7_formal_acceptance",
  };
}

export function writeHarnessInputs(plan) {
  for (const arm of plan.arms) {
    mkdirSync(arm.logDir, { recursive: true });
    writeFileSync(arm.casesPath, `${JSON.stringify({
      schema: GENERATOR_SCHEMA,
      worldSeed: plan.worldSeed,
      arm: arm.arm,
      cases: plan.cases,
    }, null, 2)}\n`);
    writeFileSync(arm.oracleAnswersPath, `${JSON.stringify({
      schema: ORACLE_SCHEMA,
      worldSeed: plan.worldSeed,
      arm: arm.arm,
      caseCount: plan.oracleAnswers.length,
      answers: plan.oracleAnswers,
    }, null, 2)}\n`);
  }
  return plan.arms.map((arm) => ({
    arm: arm.arm,
    casesPath: arm.casesPath,
    oracleAnswersPath: arm.oracleAnswersPath,
  }));
}

export function credentialStatus({ keyFile = DEFAULT_OPENAI_KEY_FILE, env = process.env } = {}) {
  if (env.OPENAI_API_KEY && String(env.OPENAI_API_KEY).trim().length > 0) {
    return { ok: true, source: "OPENAI_API_KEY", keyFile: null };
  }
  const resolvedKeyFile = keyFile ? resolve(keyFile) : null;
  if (resolvedKeyFile && existsSync(resolvedKeyFile)) {
    try {
      const stat = statSync(resolvedKeyFile);
      return stat.size > 0
        ? { ok: true, source: "key_file", keyFile: resolvedKeyFile }
        : { ok: false, reason: "key_file_empty", keyFile: resolvedKeyFile };
    } catch (error) {
      return { ok: false, reason: `key_file_unreadable:${error.code ?? error.message}`, keyFile: resolvedKeyFile };
    }
  }
  return { ok: false, reason: "missing_openai_api_key_or_key_file", keyFile: resolvedKeyFile };
}

export function usageMetadataExpectations() {
  return {
    ok: true,
    requiredSurfaces: [
      "summary.json:assessment.observed.lastLlmTokenSourceStats",
      "monitor_log.csv:llmTokenSource",
      "events.jsonl:request/provider events",
      "health-signal.db:llm_calls token/cost columns",
      "quality_summary.json:sources and learning metrics",
    ],
  };
}

function runCommand(command, args, { cwd, env }) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      resolveRun({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

function startCommand(command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  return new Promise((resolveRun) => {
    child.on("exit", (code, signal) => {
      resolveRun({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function analyzerArtifacts(arm) {
  return {
    summary: join(arm.logDir, "summary.json"),
    qualitySummary: join(arm.logDir, "quality_summary.json"),
    findings: join(arm.logDir, "SHADOW_FINDINGS.md"),
    compressedAnalysis: join(arm.logDir, "compressed_precheck_analysis.json"),
  };
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

function analyzerExpectation(result) {
  if (!result) return null;
  return {
    expectedInvocationNonce: result.invocationNonce,
    expectedReplicateId: result.expectedReplicateId,
    expectedSourceDigest: result.sourceDigest,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
    classificationMtimeMs: result.classificationMtimeMs,
  };
}

export function analyzerResultAccepted(result, classification, expectation = analyzerExpectation(result)) {
  if (!result || result.signal || Number(result.code) !== 0 || !expectation) return false;
  if (!validCompressedAnalyzerClassification(classification, expectation)) return false;
  const code = Number(result.code);
  return Number.isInteger(code) && code === 0;
}

export function pairedPrecheckBlocked({ results = [], analyzerAcceptances = [], precheckEvaluation = null } = {}) {
  const shadowRunBlocked = results.some((result) => result.step === "shadow-run" && (result.code !== 0 || result.signal));
  return shadowRunBlocked || analyzerAcceptances.some((entry) => !entry.accepted) || precheckEvaluation?.ok !== true;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
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

function armPrecheckEvidence(arm, { credentialsValid, manualReview, analyzerResult = null }) {
  const artifacts = analyzerArtifacts(arm);
  const summary = readJson(artifacts.summary, {});
  const qualitySummary = readJson(artifacts.qualitySummary, {});
  const events = readJsonl(join(arm.logDir, "events.jsonl"));
  const watchdogRows = readJsonl(join(arm.logDir, "watchdog.jsonl"));
  const analyzerClassification = readJson(artifacts.compressedAnalysis, null);
  const expectation = analyzerExpectation(analyzerResult);
  const review = manualReview?.arms?.[arm.arm] ?? manualReview?.[arm.arm] ?? {};
  return buildArmPrecheckEvidence({
    arm: arm.arm,
    summary,
    qualitySummary,
    events,
    watchdogRows,
    analyzerSchemaErrorCount: Number(review.analyzerSchemaErrorCount ?? 0) + (analyzerResult?.signal || Number(analyzerResult?.code) > 1 ? 1 : 0),
    analyzerArtifactsComplete: Boolean(
      existsSync(artifacts.summary) &&
      existsSync(artifacts.qualitySummary) &&
      existsSync(artifacts.findings) &&
      existsSync(artifacts.compressedAnalysis) &&
      Object.keys(summary).length > 0 &&
      Object.keys(qualitySummary).length > 0 &&
      Boolean(expectation) && validCompressedAnalyzerClassification(analyzerClassification, expectation)
    ),
    drillDownReviews: review.drillDownReviews ?? [],
    governanceAudit: qualitySummary.governanceAudit ?? review.governanceAudit ?? null,
    analyzerClassification,
    analyzerExpectation: expectation,
    credentialsValid,
  });
}

export function evaluatePairedArtifacts(plan, { credentialsValid, manualReview = null, analyzerResults = [] } = {}) {
  const analyzerByArm = new Map(analyzerResults.map((result) => [result.arm, result]));
  const precheckEvaluation = evaluateCompressedLearningPrecheck({
    expectedCases: plan.cases,
    arms: plan.arms.map((arm) => armPrecheckEvidence(arm, {
      credentialsValid,
      manualReview,
      analyzerResult: analyzerByArm.get(arm.arm) ?? null,
    })),
  });
  const precheckEvaluationPath = join(plan.runRoot, "precheck_evaluation.json");
  mkdirSync(plan.runRoot, { recursive: true });
  writeFileSync(precheckEvaluationPath, `${JSON.stringify(precheckEvaluation, null, 2)}\n`);
  return { precheckEvaluation, precheckEvaluationPath };
}

export async function runPairedPrecheck(plan, {
  keyFile = DEFAULT_OPENAI_KEY_FILE,
  startStaggerMs = 30_000,
  shadowRunner = startCommand,
  analyzeRunner = runCommand,
  manualReview = null,
} = {}) {
  const credentials = credentialStatus({ keyFile });
  if (!credentials.ok) {
    return { ok: false, status: "BLOCKED_CREDENTIALS", credentials };
  }
  const usageMetadata = usageMetadataExpectations();
  if (!usageMetadata.ok) {
    return { ok: false, status: "BLOCKED_USAGE_METADATA", usageMetadata };
  }

  writeHarnessInputs(plan);
  const runPromises = [];
  for (const [index, arm] of plan.arms.entries()) {
    if (index > 0 && startStaggerMs > 0) await sleep(startStaggerMs);
    const promise = shadowRunner(arm.shadowRun.command, arm.shadowRun.args, {
      cwd: arm.shadowRun.cwd,
      env: {
        ...arm.env,
        ...(credentials.keyFile ? { OPENAI_API_KEY_FILE: credentials.keyFile } : {}),
      },
    }).then((run) => ({ arm: arm.arm, step: "shadow-run", ...run }));
    runPromises.push(promise);
  }
  const runResults = await Promise.all(runPromises);
  const results = [...runResults];

  for (const arm of plan.arms) {
    const invocationNonce = randomUUID();
    const startedAtMs = Date.now();
    const analyze = await analyzeRunner(arm.analyze.command, [
      ...arm.analyze.args,
      `--invocation-nonce=${invocationNonce}`,
      `--expected-replicate-id=${arm.replicateId}`,
    ], {
      cwd: arm.analyze.cwd,
      env: arm.env,
    });
    const artifacts = analyzerArtifacts(arm);
    results.push({
      arm: arm.arm,
      step: "shadow-analyze",
      artifacts,
      ...analyze,
      invocationNonce,
      expectedReplicateId: arm.replicateId,
      startedAtMs,
      completedAtMs: Date.now(),
      sourceDigest: analyzerSourceDigest(arm.logDir),
      classificationMtimeMs: existsSync(artifacts.compressedAnalysis) ? statSync(artifacts.compressedAnalysis).mtimeMs : null,
    });
  }
  const { precheckEvaluation, precheckEvaluationPath } = evaluatePairedArtifacts(plan, {
    credentialsValid: credentials.ok,
    manualReview,
    analyzerResults: results.filter((result) => result.step === "shadow-analyze"),
  });
  const analyzerAcceptances = plan.arms.map((arm) => {
    const result = results.find((entry) => entry.step === "shadow-analyze" && entry.arm === arm.arm) ?? null;
    const classification = readJson(analyzerArtifacts(arm).compressedAnalysis, null);
    return {
      arm: arm.arm,
      accepted: analyzerResultAccepted(result, classification, analyzerExpectation(result)),
      code: result?.code ?? null,
      signal: result?.signal ?? null,
      classification,
    };
  });
  const blocked = pairedPrecheckBlocked({ results, analyzerAcceptances, precheckEvaluation });
  return {
    ok: !blocked,
    status: blocked ? "VALIDATION_BLOCKED" : "READY_FOR_REVIEW",
    results,
    runRoot: plan.runRoot,
    precheckEvaluation,
    precheckEvaluationPath,
    analyzerAcceptances,
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const key = flag.slice(2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function planFromArgs(args) {
  return buildPairedHarnessPlan({
    worldSeed: args["world-seed"] ?? DEFAULT_WORLD_SEED,
    count: args.count ?? DEFAULT_CASE_COUNT,
    trainRatio: args["train-ratio"] ?? DEFAULT_TRAIN_RATIO,
    runRoot: args["run-root"] ?? defaultRunRoot(),
    durationHours: args["duration-hours"] ?? DEFAULT_DURATION_HOURS,
    baselinePort: args["baseline-port"] ?? DEFAULT_BASELINE_PORT,
    treatmentPort: args["treatment-port"] ?? DEFAULT_TREATMENT_PORT,
    epsilon: args.epsilon ?? DEFAULT_EPSILON,
  });
}

export async function cli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const plan = planFromArgs(args);
  if (args["write-inputs"] === "true") {
    const written = writeHarnessInputs(plan);
    console.log(JSON.stringify({ ok: true, runRoot: plan.runRoot, written }, null, 2));
    return;
  }
  if (args["evaluate-existing"] === "true") {
    const credentials = credentialStatus({ keyFile: args["openai-key-file"] ?? DEFAULT_OPENAI_KEY_FILE });
    const manualReviewPath = args["manual-review"] ? resolve(args["manual-review"]) : null;
    const manualReview = manualReviewPath ? readJson(manualReviewPath, null) : null;
    const result = evaluatePairedArtifacts(plan, {
      credentialsValid: credentials.ok,
      manualReview,
    });
    console.log(JSON.stringify({
      ok: result.precheckEvaluation.ok,
      runRoot: plan.runRoot,
      precheckEvaluationPath: result.precheckEvaluationPath,
      precheckEvaluation: result.precheckEvaluation,
    }, null, 2));
    process.exitCode = result.precheckEvaluation.ok ? 0 : 3;
    return;
  }
  if (args.run === "true") {
    const manualReviewPath = args["manual-review"] ? resolve(args["manual-review"]) : null;
    const manualReview = manualReviewPath ? readJson(manualReviewPath, null) : null;
    const result = await runPairedPrecheck(plan, {
      keyFile: args["openai-key-file"] ?? DEFAULT_OPENAI_KEY_FILE,
      startStaggerMs: Number(args["start-stagger-ms"] ?? 30_000),
      manualReview,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 3;
    return;
  }
  const credentials = credentialStatus({ keyFile: args["openai-key-file"] ?? DEFAULT_OPENAI_KEY_FILE });
  console.log(JSON.stringify({
    ok: true,
    plan,
    credentials: {
      ok: credentials.ok,
      source: credentials.source ?? null,
      reason: credentials.reason ?? null,
      keyFile: credentials.keyFile,
    },
    usageMetadata: usageMetadataExpectations(),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
